/**
 * The web route's logic for an engine question (stage 1), apart from Next and the database so it can be tested with fakes. What the old NIBRS route does around an answer, in the
 * same order and with the same messages where they apply: the private flag, the rate limit, the page token, the session and daily limit, then the question, the engine, and a
 * query-log row for EVERY outcome (answer, question back, decline, busy, timeout, unavailable, error) so the daily digest and the reviewer see the engine's answers.
 * Nothing here ever falls back to the old engine: a busy or slow engine is shown as that.
 */
import type { EngineRequest, EngineResult } from "./engine-service/protocol";
import { parseEngineRequest } from "./engine-service/protocol";
import { adaptEngineResponse } from "./engine-adapt";

export type EngineLogRow = { question: string; sql: string | null; rowCount: number; error: string | null; ms: number; response: string | null; guardrails: string[]; model: string; sessionId: string | null };

export type RouteDeps = {
  /** The nibrs_engine cookie value as the browser sent it. */
  isPrivate: boolean;
  ip: string;
  validatePageToken: (token: string | null | undefined) => boolean;
  rateLimit: (ip: string) => { allowed: boolean; retryAfterMs?: number };
  sessionLimit: (sessionId: string | null) => { allowed: boolean; dailyLimitReached?: boolean; captchaRequired?: boolean };
  call: (req: EngineRequest) => Promise<EngineResult>;
  log: (row: EngineLogRow) => void;
  /** Milliseconds, from any monotonic clock (performance.now in the route). */
  clock: () => number;
};
export type RouteReply = { status: number; json: Record<string, unknown> };

const MAX_LOG_SQL = 4000;
const MAX_LOG_TEXT = 1500;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** One line of words for the log from a preview response: its title and lead, else its text lines, else what it asks or why it declines. */
function wordsOf(resp: unknown): string {
  const r = (resp ?? {}) as { presentation?: { title?: unknown; lead?: unknown }; text?: unknown; reason?: unknown; about?: unknown };
  const parts = [r.presentation?.title, r.presentation?.lead, ...(Array.isArray(r.text) ? r.text : []), r.reason, r.about].filter((x): x is string => typeof x === "string" && !!x.trim());
  return clip(parts.join(" "), MAX_LOG_TEXT);
}

/** The query-log row for one outcome. */
export function engineLogRow(req: EngineRequest, result: EngineResult, ms: number, sessionId: string | null): EngineLogRow {
  const base = { question: req.question, ms: Math.round(ms), model: "engine", sessionId };
  if (!result.ok) return { ...base, sql: null, rowCount: 0, error: `engine_${result.kind}`, response: clip(result.message, MAX_LOG_TEXT), guardrails: ["engine", `engine:${result.kind}`] };
  const r = (result.response ?? {}) as { kind?: string; rows?: unknown[] };
  const kind = typeof r.kind === "string" ? r.kind : "unknown";
  return { ...base, sql: result.sql ? clip(result.sql, MAX_LOG_SQL) : null, rowCount: Array.isArray(r.rows) ? r.rows.length : 0, error: null, response: wordsOf(result.response),
    guardrails: ["engine", `engine:${kind}`, `engine-release:${result.release}`, ...(req.path.length ? ["engine:button"] : []), ...(req.previous ? ["engine:follow-up"] : [])] };
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): RouteReply => ({ status, json: { success: false, error, ...extra } });

export async function handleEngineQuery(body: unknown, d: RouteDeps): Promise<RouteReply> {
  // The private flag first: without it this route does not exist.
  if (!d.isPrivate) return fail(404, "Not found");
  const rate = d.rateLimit(d.ip);
  if (!rate.allowed) return fail(429, `Too many requests. Please wait ${Math.ceil((rate.retryAfterMs || 60000) / 1000)} seconds and try again.`);
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!d.validatePageToken(typeof b.pageToken === "string" ? b.pageToken : undefined)) return fail(403, "Please refresh the page and try again.");
  const sessionId = typeof b.sessionId === "string" && b.sessionId ? b.sessionId.slice(0, 64) : null;
  const limit = d.sessionLimit(sessionId);
  if (!limit.allowed) return limit.dailyLimitReached ? fail(429, "You've reached the daily query limit. Please come back tomorrow.") : { status: 202, json: { success: false, captchaRequired: true } };
  const parsed = parseEngineRequest({ tab: typeof b.tab === "string" ? b.tab : "nibrs", question: b.question, path: b.path, previous: b.previous });
  if ("error" in parsed) return fail(400, parsed.error);
  const t0 = d.clock();
  const result = await d.call(parsed);
  const ms = d.clock() - t0;
  try { d.log(engineLogRow(parsed, result, ms, sessionId)); } catch { /* a log failure never changes what the visitor sees */ }
  // The answer in the shape the page already renders (title, explanation, columns, rows, chart), plus `engine`: its kind, release and buttons.
  if (result.ok) return { status: 200, json: { ...adaptEngineResponse(parsed, result.response, result.release, ms, typeof result.asked === "string" && result.asked.trim() ? result.asked.slice(0, 500) : undefined) } };
  const status = result.kind === "busy" ? 503 : result.kind === "timeout" ? 504 : result.kind === "unavailable" ? 503 : result.kind === "bad_request" ? 409 : 500;
  return fail(status, result.message, { engineFailure: true, kind: result.kind });
}
