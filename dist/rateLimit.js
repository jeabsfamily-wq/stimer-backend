// very small per-room token bucket for central:* (10 cmds/10s)
const buckets = new Map();
const WINDOW_MS = 10000;
const MAX_TOKENS = 10;
export function rateLimit(roomCode) {
    const now = Date.now();
    const b = buckets.get(roomCode) ?? { tokens: MAX_TOKENS, last: now };
    const elapsed = now - b.last;
    const refill = Math.floor(elapsed / WINDOW_MS) * MAX_TOKENS;
    b.tokens = Math.min(MAX_TOKENS, b.tokens + (refill > 0 ? refill : 0));
    b.last = refill > 0 ? now : b.last;
    if (b.tokens <= 0)
        return false;
    b.tokens -= 1;
    buckets.set(roomCode, b);
    return true;
}
