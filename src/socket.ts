import type { Server, Socket } from "socket.io";
import {
createRoom,
getRoom,
serialize,
updateConfig,
setReady,
startRound,
stopRound,
resumeRound,
tick,
resetToWaiting,
deleteRoom,
allClaimedAndReady, // (ยังใช้ใน flow start)
onClientDisconnect,
onAnyClientJoin,
tailCompactIfWaiting,
renumberCompactIfWaiting,
maybeApplyPendingCompaction,
immediateEnd,
} from "./roomStore.js";
import {
createRoomSchema,
updateConfigSchema,
joinSchema,
setReadySchema,
deleteRoomSchema,
simpleCodeSchema,
} from "./validators.js";
import { rateLimit } from "./rateLimit.js";

const ERR = (code: string, extra?: any) => ({ code, ...(extra ?? {}) });

export function bindSocket(io: Server) {
io.on("connection", (socket: Socket) => {
const clientId = socket.handshake.auth?.clientId as string | undefined;
if (!clientId) {
socket.emit("error", ERR("E_INVALID_PAYLOAD", { msg: "missing clientId" }));
socket.disconnect(true);
return;
}

// --- HELLO / snapshot ---
socket.on("client:hello", () => {
  socket.emit("room:snapshot", { ok: true });
});

// --- CENTRAL ---
socket.on("central:createRoom", (payload, cb) => {
  try {
    const p = createRoomSchema.parse(payload);
    const room = createRoom(clientId, p.stationsCount, p.roundDurationSec);
    socket.join(room.code);
    cb?.({ ok: true, room: serialize(room) });
    io.to(room.code).emit("room:updated", serialize(room));
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

socket.on("central:updateConfig", (payload, cb) => {
  try {
    const p = updateConfigSchema.parse(payload);
    const room = getRoom(p.code);
    if (!room) throw new Error("E_ROOM_NOT_FOUND");
    if (room.centralClientId !== clientId) throw new Error("E_NOT_CENTRAL");
    if (!rateLimit(room.code)) throw new Error("E_RATE_LIMIT");
    updateConfig(room, p.stationsCount, p.roundDurationSec);
    io.to(room.code).emit("room:updated", serialize(room));
    cb?.({ ok: true });
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

socket.on("central:deleteRoom", (payload, cb) => {
  try {
    const p = deleteRoomSchema.parse(payload);
    const room = getRoom(p.code);
    if (!room) throw new Error("E_ROOM_NOT_FOUND");
    if (room.centralClientId !== clientId) throw new Error("E_NOT_CENTRAL");
    if (room.state === "RUNNING" && !p.force) throw new Error("E_BAD_STATE");
    deleteRoom(p.code);
    io.to(p.code).emit("room:deleted", { code: p.code });
    cb?.({ ok: true });
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

// === NEW: central:removeStation ===
socket.on("central:removeStation", (payload, cb) => {
  try {
    const roomCode = payload?.roomCode;
    const stationId = payload?.stationId;
    if (typeof roomCode !== "string" || !Number.isInteger(stationId)) {
      throw new Error("E_INVALID_PAYLOAD");
    }
    const room = getRoom(roomCode);
    if (!room) throw new Error("E_ROOM_NOT_FOUND");
    if (room.centralClientId !== clientId) throw new Error("E_NOT_CENTRAL");
    if (stationId < 1 || stationId > room.stationsCount) throw new Error("E_INVALID_STATION");

    const slot = room.stations.get(stationId);
    if (!slot) throw new Error("E_INVALID_STATION");

    if (room.state === "RUNNING") {
      // kick owner now (ถ้ามี) — ส่งเป็น broadcast พร้อมระบุ owner ให้ client filter เอง
      if (slot.ownerClientId) {
        io.to(room.code).emit("station:kicked", {
          reason: "REMOVED_BY_CENTRAL",
          ownerClientId: slot.ownerClientId,
          stationId,
          roomCode,
        });
      }
      // เคลียร์ช่อง แต่ยังไม่ compact ตอน RUNNING
      slot.ownerClientId = undefined;
      slot.ready = false;
      slot.connected = false;
      room.pendingCompaction = true;
      io.to(room.code).emit("room:updated", serialize(room));
      cb?.({ ok: true, pendingCompaction: true });
    } else {
      // WAITING: ทำ renumber-compaction
      const renumbered = renumberCompactIfWaiting(room, stationId);
      for (const r of renumbered) {
        io.to(room.code).emit("station:renumbered", {
          clientId: r.clientId,
          oldId: r.oldId,
          newId: r.newId,
        });
      }
      io.to(room.code).emit("room:updated", serialize(room));
      cb?.({ ok: true, compacted: true });
    }
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

// === NEW: central:skipRound ===
socket.on("central:skipRound", (payload, cb) => {
  try {
    const p = simpleCodeSchema.parse(payload);
    const room = getRoom(p.code);
    if (!room) throw new Error("E_ROOM_NOT_FOUND");
    if (room.centralClientId !== clientId) throw new Error("E_NOT_CENTRAL");
    if (room.state !== "RUNNING") throw new Error("E_BAD_STATE");

    // จบเดี๋ยวนี้
    immediateEnd(room);
    io.to(room.code).emit("room:timeUp");
    io.to(room.code).emit("room:skipped", { by: "central" });

    // reset -> WAITING + apply pending compaction
    resetToWaiting(room);
    maybeApplyPendingCompaction(room);

    io.to(room.code).emit("room:updated", serialize(room));
    cb?.({ ok: true });
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

// === Pause/Resume/Reset (มีแล้ว) ===
socket.on("central:pauseRound", (payload, cb) => {
  try {
    const p = simpleCodeSchema.parse(payload);
    const room = getRoom(p.code);
    if (!room) throw new Error("E_ROOM_NOT_FOUND");
    if (room.centralClientId !== clientId) throw new Error("E_NOT_CENTRAL");
    stopRound(room); // end with timeLeft preserved
    io.to(room.code).emit("room:updated", serialize(room));
    cb?.({ ok: true });
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

socket.on("central:resumeRound", (payload, cb) => {
  try {
    const p = simpleCodeSchema.parse(payload);
    const room = getRoom(p.code);
    if (!room) throw new Error("E_ROOM_NOT_FOUND");
    if (room.centralClientId !== clientId) throw new Error("E_NOT_CENTRAL");

    resumeRound(room);
    io.to(room.code).emit("room:resumed", {
      startedAt: room.startedAt,
      roundDurationSec: room.roundDurationSec,
    });

    // restart ticking loop (เพิ่ม warn60)
    room.interval = setInterval(() => {
      tick(
        room,
        () => io.to(room.code).emit("room:warn30s"),
        () => io.to(room.code).emit("room:warn60s"),
        () => {
          io.to(room.code).emit("room:timeUp");
          resetToWaiting(room);
          io.to(room.code).emit("room:updated", serialize(room));
        }
      );
      io.to(room.code).emit("room:tick", { timeLeft: room.timeLeft });
    }, 1000);

    cb?.({ ok: true });
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

socket.on("central:resetRoom", (payload, cb) => {
  try {
    const p = simpleCodeSchema.parse(payload);
    const room = getRoom(p.code);
    if (!room) throw new Error("E_ROOM_NOT_FOUND");
    if (room.centralClientId !== clientId) throw new Error("E_NOT_CENTRAL");
    if (room.interval) {
      clearInterval(room.interval);
      room.interval = undefined;
    }
    resetToWaiting(room);
    io.to(room.code).emit("room:updated", serialize(room));
    cb?.({ ok: true });
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

// --- STATION ---
socket.on("station:join", (payload, cb) => {
  try {
    const { roomCode, stationId } = joinSchema.partial().parse(payload);
    const room = getRoom(roomCode!);
    if (!room) throw new Error("E_ROOM_NOT_FOUND");
    socket.join(room.code);

    // auto-reclaim
    const bound = room.bindings.get(clientId);
    const targetId = stationId ?? bound;
    if (!targetId) {
      cb?.({ ok: true, room: serialize(room) });
      return;
    }

    const slot = room.stations.get(targetId);
    if (!slot) throw new Error("E_INVALID_PAYLOAD");
    if (slot.ownerClientId && slot.ownerClientId !== clientId) {
      socket.emit("station:claimRejected", { reason: "E_STATION_TAKEN" });
      cb?.({ ok: false, error: ERR("E_STATION_TAKEN") });
      return;
    }

    // bind
    slot.ownerClientId = clientId;
    slot.connected = true;
    room.bindings.set(clientId, targetId);
    onAnyClientJoin(room);

    io.to(room.code).emit("room:updated", serialize(room));
    cb?.({ ok: true, room: serialize(room) });

    // auto-start if all ready
    if (allClaimedAndReady(room) && room.state === "WAITING") {
      try {
        startRound(room);
        io.to(room.code).emit("room:started", {
          startedAt: room.startedAt,
          roundDurationSec: room.roundDurationSec,
        });
        room.interval = setInterval(() => {
          tick(
            room,
            () => io.to(room.code).emit("room:warn30s"),
            () => io.to(room.code).emit("room:warn60s"),
            () => {
              io.to(room.code).emit("room:timeUp");
              resetToWaiting(room);
              io.to(room.code).emit("room:updated", serialize(room));
            }
          );
          io.to(room.code).emit("room:tick", { timeLeft: room.timeLeft });
        }, 1000);
      } catch {}
    }
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

// Station explicit leave (clear owner/ready/connected; compaction ตามสเปค)
socket.on("station:leave", (payload, cb) => {
  try {
    const roomCode = typeof payload === "string" ? payload : payload?.roomCode;
    const room = getRoom(roomCode);
    if (!room) throw new Error("E_ROOM_NOT_FOUND");

    const sid = room.bindings.get(clientId);
    if (!sid) {
      cb?.({ ok: true });
      return;
    }
    const slot = room.stations.get(sid);
    if (slot) {
      slot.ownerClientId = undefined;
      slot.ready = false;
      slot.connected = false;
    }
    room.bindings.delete(clientId);
    socket.leave(room.code);

    if (room.state === "RUNNING") {
      room.pendingCompaction = true; // ทำทีหลัง
    } else {
      // WAITING: tail compaction
      tailCompactIfWaiting(room);
    }

    io.to(room.code).emit("room:updated", serialize(room));
    cb?.({ ok: true });
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

socket.on("station:setReady", (payload, cb) => {
  try {
    const p = setReadySchema.parse(payload);
    const room = getRoom(p.roomCode);
    if (!room) throw new Error("E_ROOM_NOT_FOUND");
    setReady(room, clientId, p.ready);
    io.to(room.code).emit("room:updated", serialize(room));

    if (allClaimedAndReady(room) && room.state === "WAITING") {
      try {
        startRound(room);
        io.to(room.code).emit("room:started", {
          startedAt: room.startedAt,
          roundDurationSec: room.roundDurationSec,
        });
        room.interval = setInterval(() => {
          tick(
            room,
            () => io.to(room.code).emit("room:warn30s"),
            () => io.to(room.code).emit("room:warn60s"),
            () => {
              io.to(room.code).emit("room:timeUp");
              resetToWaiting(room);
              io.to(room.code).emit("room:updated", serialize(room));
            }
          );
          io.to(room.code).emit("room:tick", { timeLeft: room.timeLeft });
        }, 1000);
      } catch {}
    }
    cb?.({ ok: true });
  } catch (e: any) {
    cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
  }
});

// --- DISCONNECT ---
socket.on("disconnect", () => {
  for (const roomId of socket.rooms) {
    const room = getRoom(roomId);
    if (room) {
      onClientDisconnect(room, clientId);
      socket.to(room.code).emit("room:updated", serialize(room));
    }
  }
});


});
}