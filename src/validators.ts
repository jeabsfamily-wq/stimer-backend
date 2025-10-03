import { z } from 'zod';

export const createRoomSchema = z.object({
  stationsCount: z.number().int().min(1).max(200),
  roundDurationSec: z.number().int().min(10).max(36000),
});

export const updateConfigSchema = z.object({
  code: z.string().min(3).max(12),
  stationsCount: z.number().int().min(1).max(200),
  roundDurationSec: z.number().int().min(10).max(36000),
});

export const joinSchema = z.object({
  roomCode: z.string().min(3).max(12),
  stationId: z.number().int().min(1),
});

export const setReadySchema = z.object({
  roomCode: z.string().min(3).max(12),
  ready: z.boolean(),
});

export const deleteRoomSchema = z.object({
  code: z.string().min(3).max(12),
  force: z.boolean().optional(),
});

// ✅ ใช้กับ pause / resume / reset
export const simpleCodeSchema = z.object({
  code: z.string().min(3).max(12),
});
