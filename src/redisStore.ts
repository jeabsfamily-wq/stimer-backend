// src/redisStore.ts
import type { Redis } from 'ioredis';
import type { Room } from './types.js';

const TTL_SEC = 2 * 60 * 60; // 2 ชม.

export class RedisStore {
  constructor(private redis: Redis) {}

  async saveRoom(room: Room) {
    const key = `rooms:${room.code}`;
    const data = JSON.stringify({
      code: room.code,
      state: room.state,
      stationsCount: room.stationsCount,
      roundDurationSec: room.roundDurationSec,
      stations: Array.from(room.stations.values()).map((s) => ({
        id: s.id,
        ownerClientId: s.ownerClientId,
        ready: s.ready,
        connected: s.connected,
      })),
      bindings: Array.from(room.bindings.entries()),
    });
    await this.redis.setex(key, TTL_SEC, data);
  }

  async loadRoom(code: string) {
    const raw = await this.redis.get(`rooms:${code}`);
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      const room: Room = {
        code: obj.code,
        centralClientId: '', // unknown after restore; will be re-bound on connect
        state: obj.state,
        stationsCount: obj.stationsCount,
        roundDurationSec: obj.roundDurationSec,
        stations: new Map(obj.stations.map((s: any) => [s.id, s])),
        bindings: new Map(obj.bindings),
      };
      return room;
    } catch {
      return null;
    }
  }

  async deleteRoom(code: string) {
    await this.redis.del(`rooms:${code}`);
  }
}
