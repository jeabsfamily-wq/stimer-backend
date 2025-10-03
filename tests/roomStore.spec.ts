import { describe, it, expect, beforeEach } from 'vitest';
import { createRoom, claimStation, setReady, allClaimedAndReady, startRound, tick, resetToWaiting, updateConfig } from '../src/roomStore.js';

describe('roomStore core', () => {
  let room: ReturnType<typeof createRoom>;
  const central = 'central-1';
  const a = 'client-a', b = 'client-b';

  beforeEach(() => {
    room = createRoom(central, 2, 65);
  });

  it('create/join/ready/allReady', () => {
    claimStation(room, a, 1);
    setReady(room, a, true);
    claimStation(room, b, 2);
    setReady(room, b, true);
    expect(allClaimedAndReady(room)).toBe(true);
  });

  it('double-start guard', () => {
    claimStation(room, a, 1); setReady(room, a, true);
    claimStation(room, b, 2); setReady(room, b, true);
    startRound(room);
    expect(room.state).toBe('RUNNING');
    expect(() => startRound(room)).toThrow(); // E_BAD_STATE
  });

  it('warn30s one-shot', async () => {
    room.roundDurationSec = 35;
    claimStation(room, a, 1); setReady(room, a, true);
    claimStation(room, b, 2); setReady(room, b, true);
    startRound(room);
    room.startedAt = Date.now() - (5 * 1000); // elapsed 5 -> timeLeft=30
    let warned = 0, finished = 0;
    tick(room, () => warned++, () => finished++);
    expect(warned).toBe(1);
    // next tick not at 30s -> no warn
    room.startedAt = Date.now() - (6 * 1000);
    tick(room, () => warned++, () => finished++);
    expect(warned).toBe(1);
  });

  it('no warn if dur<=30', () => {
    room.roundDurationSec = 20;
    claimStation(room, a, 1); setReady(room, a, true);
    claimStation(room, b, 2); setReady(room, b, true);
    startRound(room);
    room.startedAt = Date.now(); // any tick => no warn
    let warned = 0;
    tick(room, () => warned++, () => {});
    expect(warned).toBe(0);
  });

  it('reset after timeUp -> WAITING', () => {
    claimStation(room, a, 1); setReady(room, a, true);
    claimStation(room, b, 2); setReady(room, b, true);
    startRound(room);
    room.startedAt = Date.now() - (room.roundDurationSec * 1000);
    tick(room, () => {}, () => resetToWaiting(room));
    expect(room.state).toBe('WAITING');
  });

  it('update config guard E_STATIONS_IN_USE', () => {
    claimStation(room, a, 1);
    expect(() => updateConfig(room, 1, 60)).not.toThrow();
    claimStation(room, b, 2);
    expect(() => updateConfig(room, 1, 60)).toThrow(); // cannot shrink below claimed
  });
});
