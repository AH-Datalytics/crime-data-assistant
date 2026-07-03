/**
 * Session-based query throttling + Cloudflare Turnstile CAPTCHA verification.
 *
 * Flow:
 *  - First 10 queries per session: free
 *  - Query 11: API returns { captchaRequired: true }
 *  - After solving Turnstile: 25 more queries unlocked
 *  - Pattern repeats every 25 queries
 *  - Hard daily cap: 75 queries per session
 */

const INITIAL_FREE = 10;
const BATCH_SIZE = 25;
const DAILY_LIMIT = 75;

interface SessionState {
  /** Queries used since last CAPTCHA (or session start) */
  batchUsed: number;
  /** Current batch size (first = INITIAL_FREE, subsequent = BATCH_SIZE) */
  batchLimit: number;
  /** Total queries today */
  dailyTotal: number;
  /** Date string (YYYY-MM-DD) for daily reset */
  dailyDate: string;
}

// Per-worker in-memory store: under PM2 cluster mode (2 workers) each worker
// tracks its own counts, so effective thresholds are approximate — captcha
// fires around 10-20 queries and the daily cap lands between 75 and 150
// depending on load balancing. Known and accepted since 2026-04; if exact
// enforcement ever matters, move this state to a shared store keyed by
// sessionId + date (CODEX_REVIEW_9577edc finding 6, deferred).
const sessions = new Map<string, SessionState>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function getSession(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  const d = today();
  if (!s || s.dailyDate !== d) {
    s = { batchUsed: 0, batchLimit: INITIAL_FREE, dailyTotal: 0, dailyDate: d };
    sessions.set(sessionId, s);
  }
  return s;
}

export interface CaptchaCheck {
  allowed: boolean;
  captchaRequired?: boolean;
  dailyLimitReached?: boolean;
  remaining?: number;
}

/** Call before processing a query. Returns whether to proceed. */
export function checkSessionLimit(sessionId: string | null): CaptchaCheck {
  if (!sessionId) return { allowed: true }; // no session tracking possible

  const s = getSession(sessionId);

  if (s.dailyTotal >= DAILY_LIMIT) {
    return { allowed: false, dailyLimitReached: true };
  }

  if (s.batchUsed >= s.batchLimit) {
    return { allowed: false, captchaRequired: true };
  }

  // Consume a query
  s.batchUsed++;
  s.dailyTotal++;
  return { allowed: true, remaining: s.batchLimit - s.batchUsed };
}

/** Call after successful Turnstile verification to unlock more queries. */
export function grantCaptchaCredit(sessionId: string): void {
  const s = getSession(sessionId);
  s.batchUsed = 0;
  s.batchLimit = BATCH_SIZE;
}

/** Verify a Turnstile token with Cloudflare. */
export async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return true; // skip in dev

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const data = await res.json() as { success: boolean };
    return data.success;
  } catch {
    return false;
  }
}

// Periodic cleanup of stale sessions (run probabilistically)
export function maybeCleanup(): void {
  if (Math.random() > 0.02) return;
  const d = today();
  for (const [k, s] of sessions.entries()) {
    if (s.dailyDate !== d) sessions.delete(k);
  }
}
