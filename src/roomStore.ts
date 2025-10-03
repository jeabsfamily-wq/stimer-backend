import type { Room, StationSlot } from './types.js';
import { genCode } from './utils/uuid.js';

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
    state: 'WAITING',
    stationsCount,
    roundDurationSec,
    stations: makeStations(stationsCount),
    bindings: new Map(),
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

export function claimStation(room: Room, clientId: string, stationId: number) {
  if (stationId < 1 || stationId > room.stationsCount)
    throw new Error('E_INVALID_PAYLOAD');
  const slot = room.stations.get(stationId)!;
  if (slot.ownerClientId && slot.ownerClientId !== clientId)
    throw new Error('E_STATION_TAKEN');
  // single active binding: kick previous slot of this client, if any
  const prev = room.bindings.get(clientId);
  if (prev && prev !== stationId) {
    const p = room.stations.get(prev);
    if (p) {
      p.ownerClientId = undefined;
      p.ready = false;
      p.connected = false;
    }
  }
  slot.ownerClientId = clientId;
  slot.connected = true;
  room.bindings.set(clientId, stationId);
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
  if (room.state !== 'WAITING') throw new Error('E_BAD_STATE');
  // guard reducing count below claimed
  for (let i = stationsCount + 1; i <= room.stationsCount; i++) {
    const s = room.stations.get(i);
    if (s?.ownerClientId) throw new Error('E_STATIONS_IN_USE');
  }
  room.stationsCount = stationsCount;
  for (let i = stationsCount + 1; i <= 200; i++) room.stations.delete(i);
  for (let i = 1; i <= stationsCount; i++)
    if (!room.stations.get(i))
      room.stations.set(i, { id: i, ready: false, connected: false });
  room.roundDurationSec = roundDurationSec;
}

export function startRound(room: Room) {
  if (room.state !== 'WAITING') throw new Error('E_BAD_STATE');
  if (!allClaimedAndReady(room)) throw new Error('E_BAD_STATE');
  room.state = 'RUNNING';
  room.startedAt = Date.now();
  room.timeLeft = room.roundDurationSec;
  room.warned30 = false;
}

// Pause/Stop the running round (keep timeLeft)
export function stopRound(room: Room) {
  if (room.state !== 'RUNNING') throw new Error('E_BAD_STATE');
  room.state = 'ENDED';
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

// Resume from paused (ENDED) when timeLeft > 0
export function resumeRound(room: Room) {
  if (room.state !== 'ENDED') throw new Error('E_BAD_STATE');
  const tl = room.timeLeft ?? 0;
  if (tl <= 0) throw new Error('E_BAD_STATE');
  room.state = 'RUNNING';
  // Recompute startedAt so that: roundDurationSec - elapsed == timeLeft
  room.startedAt = Date.now() - (room.roundDurationSec - tl) * 1000;
  // If resuming with <=30s left, consider already warned
  room.warned30 = tl <= 30;
}

export function tick(room: Room, onWarn30: () => void, onTimeUp: () => void) {
  if (room.state !== 'RUNNING' || room.startedAt == null) return;
  const elapsed = Math.floor((Date.now() - room.startedAt) / 1000);
  room.timeLeft = Math.max(0, room.roundDurationSec - elapsed);
  if (!room.warned30 && room.timeLeft === 30 && room.roundDurationSec > 30) {
    room.warned30 = true;
    onWarn30();
  }
  if (room.timeLeft === 0) {
    room.state = 'ENDED';
    clearInterval(room.interval);
    room.interval = undefined;
    onTimeUp();
  }
}

export function resetToWaiting(room: Room) {
  for (const s of room.stations.values()) s.ready = false;
  room.state = 'WAITING';
  room.startedAt = undefined;
  room.timeLeft = undefined;
  room.warned30 = false;
}

export function deleteRoom(code: string) {
  const r = rooms.get(code);
  if (!r) throw new Error('E_ROOM_NOT_FOUND');
  if (r.interval) clearInterval(r.interval);
  rooms.delete(code);
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
