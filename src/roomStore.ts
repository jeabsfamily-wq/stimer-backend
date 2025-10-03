// backend/src/roomStore.ts
import type { Room, StationSlot } from "./types.js";
import { genCode } from "./utils/uuid.js";

const rooms = new Map<string, Room>();

// === room-empty TTL (don't delete room immediately on refresh) ===
const ROOM_TTL_MIN = 30;
const emptyRoomTimers = new Map<string, NodeJS.Timeout>();

function isRoomEmpty(room: Room): boolean {
  for (const s of room.stations.values()) {
    if (s.connected) return false;
  }
  return true;
}

// mark disconnected but KEEP owner/binding
export function onClientDisconnect(room: Room, clientId: string) {
  const sid = room.bindings.get(clientId);
  if (sid) {
    const slot = room.stations.get(sid);
    if (slot) slot.connected = false; // keep owner/binding
  }
  // if truly empty -> schedule room deletion by TTL
  if (isRoomEmpty(room) && !emptyRoomTimers.has(room.code)) {
    const t = setTimeout(() => {
      deleteRoom(room.code);
      emptyRoomTimers.delete(room.code);
    }, ROOM_TTL_MIN * 60 * 1000);
    emptyRoomTimers.set(room.code, t);
  }
}

// cancel TTL when any client (re)joins
export function onAnyClientJoin(room: Room) {
  const t = emptyRoomTimers.get(room.code);
  if (t) {
    clearTimeout(t);
    emptyRoomTimers.delete(room.code);
  }
}

function makeStations(n: number): Map<number, StationSlot> {
  const m = new Map<number, StationSlot>();
  for (let i = 1; i <= n; i++) {
    m.set(i, { id: i, ready: false, connected: false });
  }
  return m;
}

export function createRoom(
  centralClientId: string,
  stationsCount: number,
  roundDurationSec: number
): Room {
  const code = genCode();
  const room: Room = {
    code,
    centralClientId,
    state: "WAITING",
    stationsCount,
    roundDurationSec,
    stations: makeStations(stationsCount),
    bindings: new Map(),
    warned30: false,
    warned60: false,
    pendingCompaction: false,
  };
  rooms.set(code, room);
  return room;
}

export function getRoom(code: string) {
  return rooms.get(code);
}

export function serialize(room: Room) {
  return {
    code: room.code,
    centralClientId: room.centralClientId,
    state: room.state,
    stationsCount: room.stationsCount,
    roundDurationSec: room.roundDurationSec,
    stations: Array.from(room.stations.values()).map((s) => ({
      id: s.id,
      ready: s.ready,
      connected: s.connected,
      ownerClientId: s.ownerClientId,
    })),
    startedAt: room.startedAt,
    timeLeft:
      room.timeLeft ??
      (room.startedAt
        ? Math.max(
            0,
            room.roundDurationSec -
              Math.floor((Date.now() - room.startedAt) / 1000)
          )
        : undefined),
  };
}

export function setReady(room: Room, clientId: string, ready: boolean) {
  const sid = room.bindings.get(clientId);
  if (!sid) return;
  const slot = room.stations.get(sid)!;
  slot.ready = ready;
}

export function allClaimedAndReady(room: Room) {
  for (let i = 1; i <= room.stationsCount; i++) {
    const s = room.stations.get(i);
    if (!s?.ownerClientId) return false;
    if (!s.ready) return false;
  }
  return true;
}

export function updateConfig(
  room: Room,
  stationsCount: number,
  roundDurationSec: number
) {
  if (room.state !== "WAITING") throw new Error("E_BAD_STATE");
  // guard reducing count below claimed
  for (let i = stationsCount + 1; i <= room.stationsCount; i++) {
    const s = room.stations.get(i);
    if (s?.ownerClientId) throw new Error("E_STATIONS_IN_USE");
  }
  room.stationsCount = stationsCount;
  for (let i = stationsCount + 1; i <= 200; i++) room.stations.delete(i);
  for (let i = 1; i <= stationsCount; i++)
    if (!room.stations.get(i))
      room.stations.set(i, { id: i, ready: false, connected: false });
  room.roundDurationSec = roundDurationSec;
}

export function startRound(room: Room) {
  if (room.state !== "WAITING") throw new Error("E_BAD_STATE");
  if (!allClaimedAndReady(room)) throw new Error("E_BAD_STATE");
  room.state = "RUNNING";
  room.startedAt = Date.now();
  room.timeLeft = room.roundDurationSec;
  room.warned30 = false;
  room.warned60 = false;
}

export function stopRound(room: Room) {
  if (room.state !== "RUNNING") throw new Error("E_BAD_STATE");
  room.state = "ENDED";
  if (room.interval) {
    clearInterval(room.interval);
    room.interval = undefined;
  }
  room.timeLeft = Math.max(
    0,
    room.roundDurationSec -
      Math.floor((Date.now() - (room.startedAt ?? Date.now())) / 1000)
  );
}

export function resumeRound(room: Room) {
  if (room.state !== "ENDED") throw new Error("E_BAD_STATE");
  const tl = room.timeLeft ?? 0;
  if (tl <= 0) throw new Error("E_BAD_STATE");
  room.state = "RUNNING";
  // Recompute startedAt so that: roundDurationSec - elapsed == timeLeft
  room.startedAt = Date.now() - (room.roundDurationSec - tl) * 1000;
  room.warned30 = tl <= 30;
  room.warned60 = tl <= 60;
}

export function tick(
  room: Room,
  onWarn30: () => void,
  onWarn60: () => void,
  onTimeUp: () => void
) {
  if (room.state !== "RUNNING" || room.startedAt == null) return;
  const elapsed = Math.floor((Date.now() - room.startedAt) / 1000);
  room.timeLeft = Math.max(0, room.roundDurationSec - elapsed);
  if (!room.warned60 && room.roundDurationSec >= 60 && room.timeLeft === 60) {
    room.warned60 = true;
    onWarn60();
  }
  if (!room.warned30 && room.timeLeft === 30 && room.roundDurationSec > 30) {
    room.warned30 = true;
    onWarn30();
  }
  if (room.timeLeft === 0) {
    room.state = "ENDED";
    clearInterval(room.interval);
    room.interval = undefined;
    onTimeUp();
  }
}

export function resetToWaiting(room: Room) {
  // after ENDED -> WAITING, clear ready
  for (const s of room.stations.values()) s.ready = false;
  room.state = "WAITING";
  room.startedAt = undefined;
  room.timeLeft = undefined;
  room.warned30 = false;
  room.warned60 = false;
  maybeApplyPendingCompaction(room);
}

export function deleteRoom(code: string) {
  const r = rooms.get(code);
  if (!r) throw new Error("E_ROOM_NOT_FOUND");
  if (r.interval) clearInterval(r.interval);
  rooms.delete(code);
}

// === Compaction helpers ===

// ลดเฉพาะ "หาง" ว่างที่ต่อเนื่อง ในโหมด WAITING (ไม่ renumber คนอื่น)
export function tailCompactIfWaiting(room: Room) {
  if (room.state !== "WAITING") return;
  let newCount = room.stationsCount;
  while (newCount > 0) {
    const s = room.stations.get(newCount);
    if (s && (s.ownerClientId || s.ready || s.connected)) break;
    newCount--;
  }
  if (newCount < room.stationsCount) {
    for (let i = newCount + 1; i <= room.stationsCount; i++)
      room.stations.delete(i);
    room.stationsCount = newCount;
  }
}

// ลบ stationId แล้วเลื่อน id ถัด ๆ ลงมา 1 ขั้นในโหมด WAITING
// ส่งกลับ mapping ของการเลื่อนสำหรับอัปเดต bindings ภายนอก/แจ้ง client
export function renumberCompactIfWaiting(
  room: Room,
  removedId: number
): Array<{ clientId: string; oldId: number; newId: number }> {
  const renumbered: Array<{
    clientId: string;
    oldId: number;
    newId: number;
  }> = [];
  if (room.state !== "WAITING") return renumbered;
  if (removedId < 1 || removedId > room.stationsCount) return renumbered;

  // เคลียร์ช่องที่ลบ
  const removed = room.stations.get(removedId);
  if (removed) {
    removed.ownerClientId = undefined;
    removed.connected = false;
    removed.ready = false;
  }

  // เลื่อนช่วง [removedId+1..stationsCount] ลงมา
  for (let i = removedId; i < room.stationsCount; i++) {
    const src =
      room.stations.get(i + 1) ??
      ({ id: i + 1, ready: false, connected: false } as StationSlot);
    const dst: StationSlot =
      room.stations.get(i) ??
      ({ id: i, ready: false, connected: false } as StationSlot);

    // copy state จาก src -> dst
    dst.id = i;
    dst.ownerClientId = src.ownerClientId;
    dst.connected = src.connected;
    dst.ready = src.ready;

    room.stations.set(i, dst);

    // อัปเดต bindings: clientId -> stationId
    if (src.ownerClientId) {
      const cid = src.ownerClientId;
      const oldId = i + 1;
      const newId = i;

      // room.bindings: Map<clientId, stationId>
      const cur = room.bindings.get(cid);
      if (cur === oldId) room.bindings.set(cid, newId);

      renumbered.push({ clientId: cid, oldId, newId });
    }
  }

  // ลบตัวสุดท้ายเดิม
  room.stations.delete(room.stationsCount);
  room.stationsCount = Math.max(0, room.stationsCount - 1);

  return renumbered;
}

// ใช้เมื่อกลับสู่ WAITING
export function maybeApplyPendingCompaction(room: Room) {
  if (room.state !== "WAITING") return;
  if (!room.pendingCompaction) return;
  tailCompactIfWaiting(room);
  room.pendingCompaction = false;
}

// ทำให้รอบจบทันที (ไว้ใช้กับ skip)
export function immediateEnd(room: Room) {
  if (room.interval) {
    clearInterval(room.interval);
    room.interval = undefined;
  }
  room.timeLeft = 0;
  room.state = "ENDED";
}

// compatibility helpers for socket.ts
export const markDisconnected = onClientDisconnect;
export function scheduleRoomCleanupIfEmpty(room: Room) {
  if (isRoomEmpty(room) && !emptyRoomTimers.has(room.code)) {
    const t = setTimeout(() => {
      deleteRoom(room.code);
      emptyRoomTimers.delete(room.code);
    }, ROOM_TTL_MIN * 60 * 1000);
    emptyRoomTimers.set(room.code, t);
  }
}
export const cancelRoomCleanup = onAnyClientJoin;
