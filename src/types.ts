export type RoomState = 'WAITING' | 'RUNNING' | 'ENDED';

export interface StationSlot {
id: number;
ownerClientId?: string;
ready: boolean;
connected: boolean;
}

export interface Room {
code: string;
centralClientId: string;
state: RoomState;
stationsCount: number;
roundDurationSec: number;
stations: Map<number, StationSlot>;
bindings: Map<string, number>;
interval?: NodeJS.Timeout;
timeLeft?: number;
startedAt?: number;
warned30?: boolean;
warned60?: boolean; // ✅ สำหรับแจ้งเตือน 60 วิ ครั้งเดียว
pendingCompaction?: boolean; // ✅ รอ compact หลังรอบจบ
lastTickAt?: number;
}

export interface HelloPayload {
clientId: string;
clientSig: string;
}