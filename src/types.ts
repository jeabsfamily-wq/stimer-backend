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
  lastTickAt?: number;
}

export interface HelloPayload {
  clientId: string;
  clientSig: string;
}
