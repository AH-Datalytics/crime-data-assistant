/**
 * The engine service's wire protocol (stage 1 of the engine switch): what the web route sends to the service and what comes back. Plain JSON, one request per question; the
 * service never trusts the caller beyond this shape (the route has already checked the page token, the rate limit and the session).
 *
 * A tab is a NAMED SOURCE: stage 1 configures `nibrs` only; a tab with no root configured answers "unavailable" (the later tabs plug in by adding a root to the service config, not
 * by changing this protocol).
 */
export const MAX_QUESTION = 500;
export const MAX_PATH = 12;
export const MAX_BODY_BYTES = 16 * 1024;

export type EngineRequest = {
  /** The source: "nibrs" in stage 1. */
  tab: string;
  question: string;
  /** Button labels pressed after the question (the preview's path-based follow-up); [] for a plain question. */
  path: string[];
  /** The question before this one, for a typed follow-up (shadowFollowUp); absent for a first question. */
  previous?: string;
};

export type EngineFailKind = "busy" | "timeout" | "unavailable" | "bad_request" | "error";
export type EngineOk = { ok: true; response: unknown; ms: number; release: string };
export type EngineFail = { ok: false; kind: EngineFailKind; message: string };
export type EngineResult = EngineOk | EngineFail;

const TAB = /^[a-z_]{1,24}$/;

export function parseEngineRequest(body: unknown): EngineRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "The request must be a JSON object." };
  const b = body as Record<string, unknown>;
  if (typeof b.tab !== "string" || !TAB.test(b.tab)) return { error: "tab must be a short lower-case name." };
  if (typeof b.question !== "string" || !b.question.trim()) return { error: "question must be a non-empty string." };
  if (b.question.length > MAX_QUESTION) return { error: `question is longer than ${MAX_QUESTION} characters.` };
  const path = b.path === undefined ? [] : b.path;
  if (!Array.isArray(path) || path.length > MAX_PATH || !path.every((x) => typeof x === "string" && x.length > 0 && x.length <= 200)) return { error: "path must be a short list of button labels." };
  if (b.previous !== undefined && (typeof b.previous !== "string" || !b.previous.trim() || b.previous.length > MAX_QUESTION)) return { error: "previous must be a non-empty string of at most 500 characters." };
  return { tab: b.tab, question: b.question.trim(), path: path as string[], ...(typeof b.previous === "string" ? { previous: b.previous.trim() } : {}) };
}

/** The HTTP status for a result: the route maps these to what the page shows (busy and timeout are plain "try again" answers, never a fallback to the old engine). */
export function statusOf(r: EngineResult): number {
  if (r.ok) return 200;
  return r.kind === "busy" ? 503 : r.kind === "timeout" ? 504 : r.kind === "unavailable" ? 404 : r.kind === "bad_request" ? 400 : 500;
}
