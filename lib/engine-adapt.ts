/**
 * The engine's answer in the shape the live page already renders (lib/types QueryResponse), so the NIBRS tab shows an engine answer with the same title, text, chart, table and
 * exports it shows for the old engine's, plus the engine's buttons (continuations, entries, other-source offers, whole questions). A question the engine asks back and a decline are
 * successful replies with words and buttons and no table, as the old routes send them.
 */
import type { EngineMeta, QueryResponse } from "./types";
import type { EngineRequest } from "./engine-service/protocol";
import { titleOf } from "./answer-contract/contract";

type PreviewLike = {
  kind?: string; columns?: unknown; rows?: unknown; chart?: unknown; text?: unknown; about?: unknown; note?: unknown; reason?: unknown; buttons?: unknown;
  presentation?: { titleParts?: unknown };
};
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((t): t is string => typeof t === "string" && !!t.trim()) : []);

export function adaptEngineResponse(req: EngineRequest, response: unknown, release: string, ms: number): QueryResponse & { engine: EngineMeta } {
  const r = (response ?? {}) as PreviewLike;
  const kind = r.kind === "answer" || r.kind === "clarify" || r.kind === "decline" ? r.kind : "decline";
  const buttons = (Array.isArray(r.buttons) ? r.buttons : []).filter((b): b is EngineMeta["buttons"][number] => !!b && typeof (b as { label?: unknown }).label === "string" && Array.isArray((b as { path?: unknown }).path));
  const engine: EngineMeta = { kind, release, question: req.question, ...(req.previous ? { previous: req.previous } : {}), path: req.path, buttons };
  const base = { success: true as const, requestId: undefined, question: req.question, sql: "", truncated: false, chartMeta: null, executionTimeMs: Math.round(ms), engine };
  if (kind === "answer") {
    const text = strings(r.text);
    const columns = strings(r.columns);
    const rows = Array.isArray(r.rows) ? (r.rows as Record<string, unknown>[]) : [];
    let title = text[0] ?? req.question;
    const tp = r.presentation?.titleParts;
    if (tp && typeof tp === "object") { try { title = titleOf(tp as Parameters<typeof titleOf>[0]).title || title; } catch { /* the first text line stands */ } }
    return { ...base, explanation: text.join("\n\n"), title, columns, rows, rowCount: rows.length, chartConfig: (r.chart ?? null) as QueryResponse["chartConfig"] };
  }
  const words = kind === "clarify"
    ? [typeof r.about === "string" ? `Which ${r.about.replace(/^which /i, "")}?` : "", ...strings([r.note])].filter(Boolean)
    : strings([typeof r.text === "string" ? r.text : undefined, ...(Array.isArray(r.text) ? r.text : [])]);
  return { ...base, explanation: words.join("\n\n") || "The engine has no answer to give for this question.", title: "", columns: [], rows: [], rowCount: 0, chartConfig: null };
}
