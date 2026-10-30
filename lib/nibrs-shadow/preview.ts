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

export function previewEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && !!env.NIBRS_SHADOW_ROOT;
}

export type PreviewButton = { label: string; path: string[]; kind: "continuation" | "entry" | "other-source"; note?: string };
export type PreviewResponse =
  | { kind: "answer"; columns: string[]; rows: Record<string, string | number | null>[]; chart: ChartConfig | null; text: string[]; period: { from: string; to: string } }
  | { kind: "clarify"; about: string; buttons: PreviewButton[] }
  | { kind: "decline"; reason: string; text: string; buttons: PreviewButton[]; notBuilt: boolean };

const button = (o: ShadowOption, path: string[]): PreviewButton => o.continuation
  ? { label: o.label, path: [...path, o.label], kind: "continuation" }
  : o.otherSource ? { label: o.label, path: [...path, o.label], kind: "other-source", note: `Answered by ${o.otherSource}, which this preview does not run.` }
  : { label: o.label, path: [...path, o.label], kind: "entry", note: o.entry ? `Asks ${o.entry}: type it into the question.` : undefined };

/** The outcome reached by following a path of button labels from the first outcome; null when a label is not offered. */
export function follow(o: ShadowOutcome, path: string[]): ShadowOutcome | null {
  let at: ShadowOutcome = o;
  for (const label of path) {
    const opts = at.kind === "clarify" ? at.options : at.kind === "decline" && at.alternative ? [at.alternative] : [];
    const next = opts.find((x) => x.label === label)?.continuation;
    if (!next) return null;
    at = next;
  }
  return at;
}

export function toPreview(o: ShadowOutcome, path: string[] = []): PreviewResponse {
  if (o.kind === "clarify") return { kind: "clarify", about: o.about, buttons: o.options.map((x) => button(x, path)) };
  if (o.kind === "decline") return { kind: "decline", reason: o.reason, text: o.explanation, buttons: o.alternative ? [button(o.alternative, path)] : [], notBuilt: !!o.notBuilt };
  const { table, chart, text } = o.delivered;
  const columns = table.columns.map((c) => c.header);
  const rows = table.rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));
  return {
    kind: "answer", columns, rows, text, period: o.period,
    chart: chart ? { type: chart.kind, xAxis: chart.x, yAxis: chart.y, title: text[0] ?? "" } : null,
  };
}
