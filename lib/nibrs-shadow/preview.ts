/**
 * The local private preview of the shadow engine (owner-only, never on the live site). Two parts:
 *
 *   previewEnabled  the one gate for the /preview page and its API route: on only when NODE_ENV is not "production" AND
 *                   NIBRS_SHADOW_ROOT names a canonical build. A production build therefore serves 404 for both, even if
 *                   deployed (coordinator, 2026-10-29).
 *   toPreview       a shadow outcome as the UI renders it: the delivered table as columns and keyed rows (the
 *                   answer-columns contract: the table's columns only, no status or notes), its chart, its text lines,
 *                   and its buttons. A button is the original question plus the path of labels clicked; the route
 *                   recomputes and follows the path, so nothing is held on the server and each continuation is exactly
 *                   the shadow's (P22).
 */
import type { ChartConfig } from "../types";
import type { ShadowOption, ShadowOutcome } from "./answer";
import type { ChoicePresentation, Presentation } from "../answer-contract/contract";
import type { PlaceIndex } from "./places";
import { presentationOf } from "./presentation";

export function previewEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && !!env.NIBRS_SHADOW_ROOT;
}

/**
 * A request's question and button path, or why it is refused. A question is never shortened: one over the limit is
 * refused, so an answer is always to the question shown (Codex preview review).
 */
export const MAX_QUESTION = 500;
export function parseRequest(body: unknown): { question: string; path: string[] } | { error: string } {
  const b = (body ?? {}) as { question?: unknown; path?: unknown };
  const question = typeof b.question === "string" ? b.question.trim() : "";
  if (!question) return { error: "Ask a question." };
  if (question.length > MAX_QUESTION) return { error: `The question is longer than ${MAX_QUESTION} characters; shorten it.` };
  const path = b.path === undefined ? [] : b.path;
  if (!Array.isArray(path) || path.length > 10 || !path.every((x) => typeof x === "string" && x.length <= 200)) return { error: "The button path is not valid." };
  return { question, path: path as string[] };
}

/** `question` (kind "question", P74): a complete question shown on the button; the page asks it as a new question when chosen. */
export type PreviewButton = { label: string; path: string[]; kind: "continuation" | "entry" | "other-source" | "not-built" | "question"; note?: string; question?: string };
export type PreviewResponse =
  /**
   * Jeff 2026-11-01: stacked and 100% charts only when honest. Present when the table has a category grouping:
   * `exclusive`, true when the categories sum to the primary count's total (the charted measure); `exclusiveByColumn`,
   * the same for each number column by header (the incidents beside a count, P66, can overlap when the primary count
   * does not). A column is stacked only when its own entry is true. `ordered` (P86): the headers of grouping columns
   * whose rows are in natural order (time; age groups with Unknown last), which a chart keeps and never sorts by value.
   */
  | { kind: "answer"; columns: string[]; rows: Record<string, string | number | null>[]; chart: ChartConfig | null; text: string[]; period: { from: string; to: string }; buttons: PreviewButton[]; exclusive?: boolean; exclusiveByColumn?: Record<string, boolean>; ordered?: string[] }
  | { kind: "clarify"; about: string; buttons: PreviewButton[] }
  | { kind: "decline"; reason: string; text: string; buttons: PreviewButton[]; notBuilt: boolean };
/**
 * The answer contract (lib/answer-contract): every response also carries `presentation`, the structured fields the
 * page builds the title, lead, notes, chart options and exports from with the shared builders (never by reading the
 * text). Present when the caller passes the place index (the API route always does).
 */
export type PreviewWithPresentation = PreviewResponse & { presentation?: Presentation | ChoicePresentation };

// A continuation this build cannot answer (its years are outside the build) is shown, not offered: the build is the
// limit, not the question. The preview has no follow-up turns, so an entry asks for the whole question again.
const button = (o: ShadowOption, path: string[]): PreviewButton => o.continuation && o.continuation.kind === "decline" && o.continuation.notBuilt
  ? { label: o.label, path: [...path, o.label], kind: "not-built", note: `Not in the data this preview uses: ${o.continuation.explanation}` }
  : o.question ? { label: o.label, path: [...path, o.label], kind: "question", question: o.question }
  : o.continuation
  ? { label: o.label, path: [...path, o.label], kind: "continuation" }
  : o.otherSource ? { label: o.label, path: [...path, o.label], kind: "other-source", note: `Answered from ${o.otherSource}, which isn't available here yet.` }
  : { label: o.label, path: [...path, o.label], kind: "entry", note: o.entry ? `Asks for ${o.entry}: ask the whole question again with it.` : undefined };

/** The outcome reached by following a path of button labels from the first outcome; null when a label is not offered. */
export function follow(o: ShadowOutcome, path: string[]): ShadowOutcome | null {
  let at: ShadowOutcome = o;
  for (const label of path) {
    const opts = at.kind === "clarify" ? at.options : at.kind === "decline" && at.alternative ? [at.alternative] : at.kind === "answer" ? at.buttons ?? [] : [];
    const next = opts.find((x) => x.label === label)?.continuation;
    if (!next) return null;
    at = next;
  }
  return at;
}

export function toPreview(o: ShadowOutcome, path: string[] = [], places?: PlaceIndex): PreviewWithPresentation {
  const r = previewOf(o, path);
  return places ? { ...r, presentation: presentationOf(o, places) } : r;
}
function previewOf(o: ShadowOutcome, path: string[]): PreviewResponse {
  if (o.kind === "clarify") return { kind: "clarify", about: o.about, buttons: o.options.map((x) => button(x, path)) };
  if (o.kind === "decline") return { kind: "decline", reason: o.reason, text: o.explanation, buttons: o.alternative ? [button(o.alternative, path)] : [], notBuilt: !!o.notBuilt };
  // Another source's question: the route is named (this preview runs only the NIBRS shadow and the historical file).
  if (o.kind === "route") return { kind: "decline", reason: `route:${o.source}`, text: o.explanation, buttons: [], notBuilt: false };
  const { table, text } = o.delivered;
  const chart = o.kind === "answer" ? o.delivered.chart : null;
  const columns = table.columns.map((c) => c.header);
  const rows = table.rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
  const flags = table.columns.flatMap((c) => (c.binding.kind === "grouping" && c.exclusive !== undefined ? [c.exclusive] : []));
  const exclusive = flags.length ? flags.every(Boolean) : undefined;
  const ordered = table.columns.flatMap((c) => (c.binding.kind === "grouping" && "ordered" in c && c.ordered ? [c.header] : []));
  const byColumn = exclusive === undefined ? undefined
    : Object.fromEntries(table.columns.filter((c) => c.binding.kind === "statistic").map((c) => [c.header, exclusive && (c.exclusive ?? true)]));
  return {
    kind: "answer", columns, rows, text, period: o.period, ...(exclusive === undefined ? {} : { exclusive, exclusiveByColumn: byColumn }),
    ...(ordered.length ? { ordered } : {}),
    chart: chart ? { type: chart.kind, xAxis: chart.x, yAxis: chart.y, title: text[0] ?? "" } : null,
    buttons: o.kind === "answer" ? (o.buttons ?? []).map((x) => button(x, path)) : [],
  };
}
