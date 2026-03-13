// Simple in-memory sliding window rate limiter
// Resets on server restart (fine for Vercel cold starts)
const hits = new Map<string, number[]>();

const MAX_REQUESTS = 20;
const WINDOW_MS = 60_000; // 1 minute

export function checkRateLimit(ip: string): {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
} {
  const now = Date.now();
  const timestamps = hits.get(ip) || [];
  const recent = timestamps.filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_REQUESTS) {
    const retryAfterMs = recent[0] + WINDOW_MS - now;
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  recent.push(now);
  hits.set(ip, recent);

  // Probabilistic cleanup of stale entries
  if (Math.random() < 0.01) {
    for (const [key, ts] of hits.entries()) {
      const active = ts.filter((t) => now - t < WINDOW_MS);
      if (active.length === 0) hits.delete(key);
      else hits.set(key, active);
    }
  }

  return { allowed: true, remaining: MAX_REQUESTS - recent.length };
}
