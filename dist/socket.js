import { createRoom, getRoom, serialize, updateConfig, setReady, startRound, stopRound, resumeRound, tick, resetToWaiting, deleteRoom, allClaimedAndReady, onClientDisconnect, onAnyClientJoin, } from "./roomStore.js";
import { createRoomSchema, updateConfigSchema, joinSchema, setReadySchema, deleteRoomSchema, simpleCodeSchema, } from "./validators.js";
import { rateLimit } from "./rateLimit.js";
const ERR = (code, extra) => ({ code, ...(extra ?? {}) });
export function bindSocket(io) {
    io.on("connection", (socket) => {
        const clientId = socket.handshake.auth?.clientId;
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
            }
            catch (e) {
                cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
            }
        });
        socket.on("central:updateConfig", (payload, cb) => {
            try {
                const p = updateConfigSchema.parse(payload);
                const room = getRoom(p.code);
                if (!room)
                    throw new Error("E_ROOM_NOT_FOUND");
                if (room.centralClientId !== clientId)
                    throw new Error("E_NOT_CENTRAL");
                if (!rateLimit(room.code))
                    throw new Error("E_RATE_LIMIT");
                updateConfig(room, p.stationsCount, p.roundDurationSec);
                io.to(room.code).emit("room:updated", serialize(room));
                cb?.({ ok: true });
            }
            catch (e) {
                cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
            }
        });
        socket.on("central:deleteRoom", (payload, cb) => {
            try {
                const p = deleteRoomSchema.parse(payload);
                const room = getRoom(p.code);
                if (!room)
                    throw new Error("E_ROOM_NOT_FOUND");
                if (room.centralClientId !== clientId)
                    throw new Error("E_NOT_CENTRAL");
                if (room.state === "RUNNING" && !p.force)
                    throw new Error("E_BAD_STATE");
                deleteRoom(p.code);
                io.to(p.code).emit("room:deleted", { code: p.code });
                cb?.({ ok: true });
            }
            catch (e) {
                cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
            }
        });
        // ✅ NEW: PAUSE
        socket.on("central:pauseRound", (payload, cb) => {
            try {
                const p = simpleCodeSchema.parse(payload);
                const room = getRoom(p.code);
                if (!room)
                    throw new Error("E_ROOM_NOT_FOUND");
                if (room.centralClientId !== clientId)
                    throw new Error("E_NOT_CENTRAL");
                stopRound(room); // end with timeLeft preserved
                io.to(room.code).emit("room:updated", serialize(room));
                cb?.({ ok: true });
            }
            catch (e) {
                cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
            }
        });
        // ✅ NEW: RESUME
        socket.on("central:resumeRound", (payload, cb) => {
            try {
                const p = simpleCodeSchema.parse(payload);
                const room = getRoom(p.code);
                if (!room)
                    throw new Error("E_ROOM_NOT_FOUND");
                if (room.centralClientId !== clientId)
                    throw new Error("E_NOT_CENTRAL");
                resumeRound(room);
                io.to(room.code).emit("room:resumed", {
                    startedAt: room.startedAt,
                    roundDurationSec: room.roundDurationSec,
                });
                // restart ticking loop
                room.interval = setInterval(() => {
                    tick(room, () => io.to(room.code).emit("room:warn30s"), () => {
                        io.to(room.code).emit("room:timeUp");
                        resetToWaiting(room);
                        io.to(room.code).emit("room:updated", serialize(room));
                    });
                    io.to(room.code).emit("room:tick", { timeLeft: room.timeLeft });
                }, 1000);
                cb?.({ ok: true });
            }
            catch (e) {
                cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
            }
        });
        // ✅ NEW: RESET → back to WAITING
        socket.on("central:resetRoom", (payload, cb) => {
            try {
                const p = simpleCodeSchema.parse(payload);
                const room = getRoom(p.code);
                if (!room)
                    throw new Error("E_ROOM_NOT_FOUND");
                if (room.centralClientId !== clientId)
                    throw new Error("E_NOT_CENTRAL");
                if (room.interval) {
                    clearInterval(room.interval);
                    room.interval = undefined;
                }
                resetToWaiting(room);
                io.to(room.code).emit("room:updated", serialize(room));
                cb?.({ ok: true });
            }
            catch (e) {
                cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
            }
        });
        // --- STATION ---
        socket.on("station:join", (payload, cb) => {
            try {
                const { roomCode, stationId } = joinSchema.partial().parse(payload);
                const room = getRoom(roomCode);
                if (!room)
                    throw new Error("E_ROOM_NOT_FOUND");
                socket.join(room.code);
                // auto-reclaim
                const bound = room.bindings.get(clientId);
                const targetId = stationId ?? bound;
                if (!targetId) {
                    cb?.({ ok: true, room: serialize(room) });
                    return;
                }
                const slot = room.stations.get(targetId);
                if (!slot)
                    throw new Error("E_INVALID_PAYLOAD");
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
                            tick(room, () => io.to(room.code).emit("room:warn30s"), () => {
                                io.to(room.code).emit("room:timeUp");
                                resetToWaiting(room);
                                io.to(room.code).emit("room:updated", serialize(room));
                            });
                            io.to(room.code).emit("room:tick", { timeLeft: room.timeLeft });
                        }, 1000);
                    }
                    catch { }
                }
            }
            catch (e) {
                cb?.({ ok: false, error: ERR(e?.message || "E_INVALID_PAYLOAD") });
            }
        });
        socket.on("station:leave", (roomCode, cb) => {
            const room = getRoom(roomCode);
            if (!room)
                return cb?.({ ok: false, error: ERR("E_ROOM_NOT_FOUND") });
            onClientDisconnect(room, clientId);
            socket.leave(room.code);
            io.to(room.code).emit("room:updated", serialize(room));
            cb?.({ ok: true });
        });
        socket.on("station:setReady", (payload, cb) => {
            try {
                const p = setReadySchema.parse(payload);
                const room = getRoom(p.roomCode);
                if (!room)
                    throw new Error("E_ROOM_NOT_FOUND");
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
                            tick(room, () => io.to(room.code).emit("room:warn30s"), () => {
                                io.to(room.code).emit("room:timeUp");
                                resetToWaiting(room);
                                io.to(room.code).emit("room:updated", serialize(room));
                            });
                            io.to(room.code).emit("room:tick", { timeLeft: room.timeLeft });
                        }, 1000);
                    }
                    catch { }
                }
                cb?.({ ok: true });
            }
            catch (e) {
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
