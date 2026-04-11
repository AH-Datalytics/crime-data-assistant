// Simple in-memory sliding window rate limiter
// Resets on server restart (fine for Vercel cold starts)
const hits = new Map<string, number[]>();

const QUERY_LIMIT = 20;
const QUERY_WINDOW_MS = 60_000; // 1 minute

const AUTH_LIMIT = 5;
const AUTH_WINDOW_MS = 60_000; // 5 attempts per minute

function check(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; remaining: number; retryAfterMs?: number } {
  const now = Date.now();
  const timestamps = hits.get(key) || [];
  const recent = timestamps.filter((t) => now - t < windowMs);

  if (recent.length >= maxRequests) {
    const retryAfterMs = recent[0] + windowMs - now;
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  recent.push(now);
  hits.set(key, recent);

  // Probabilistic cleanup of stale entries
  if (Math.random() < 0.01) {
    for (const [k, ts] of hits.entries()) {
      const active = ts.filter((t) => now - t < windowMs);
      if (active.length === 0) hits.delete(k);
      else hits.set(k, active);
    }
  }

  return { allowed: true, remaining: maxRequests - recent.length };
}

/** Rate limit for query endpoints (20 req/min per IP) */
export function checkRateLimit(ip: string) {
  return check(`query:${ip}`, QUERY_LIMIT, QUERY_WINDOW_MS);
}

/** Stricter rate limit for auth attempts (5 req/min per IP) */
export function checkAuthRateLimit(ip: string) {
  return check(`auth:${ip}`, AUTH_LIMIT, AUTH_WINDOW_MS);
}
