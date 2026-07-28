import { normalizeHistoryForTab } from "./chat-history";
import { hasPriorSql, type FollowupTransform } from "./followup-transform";
import { detectQueryBearingFollowup } from "./query-bearing-followup";
import { extractQueryContext, type Tab } from "./query-context";
import { isFollowUp } from "./tab-suggest";
import type { SourceId } from "./source-contracts";

/**
 * Reconstruction of follow-up context across data-source boundaries (MS01).
 *
 * History normalization deliberately drops turns tagged with a different
 * source so foreign table names never reach a source's prompt. Correct for the
 * PROMPT, fatal for RECONSTRUCTION: when the client reroutes a follow-up like
 * "now show firearm murders instead" from Historical to SHR, the SHR model
 * received a bare fragment with no geography, metric, or time range.
 *
 * The fix derives the accumulated conversation state from the LAST EXECUTED
 * SQL in the raw history — SQL encodes what fragment chains ("compare to
 * Dallas" → "show rates instead") built up, deterministically — and carries it
 * across as a reconstructed QUESTION plus a [SYSTEM:] instruction. The
 * load-bearing rule: only reconstructed natural language crosses the source
 * boundary, never SQL text or table names.
 */
export interface PriorQueryState {
  sourceOfSql: SourceId;
  baseQuestion: string | null;
  geos: string[];
  states: string[];
  offenses: string[];
  isPerCapita: boolean;
  timeRange: { start: number | null; end: number | null };
}

const SOURCE_IDS: SourceId[] = ["current", "historical", "nibrs", "shr", "hate_crime"];

type RawEntry = { role?: unknown; content?: unknown; source?: unknown };

function entryAt(rawHistory: unknown[], i: number): RawEntry | null {
  const e = rawHistory[i];
  return e && typeof e === "object" ? (e as RawEntry) : null;
}

function extractSql(content: string): string | null {
  const tagged = content.match(/\[SQL:\s*([\s\S]*?)\]\s*$/);
  if (tagged?.[1] && /\bSELECT\b[\s\S]+\bFROM\b/i.test(tagged[1])) return tagged[1].trim();
  const bare = content.match(/\bSELECT\b[\s\S]+\bFROM\b[\s\S]*/i);
  return bare ? bare[0].trim() : null;
}

export function extractPriorQueryState(rawHistory: unknown, currentSource: SourceId): PriorQueryState | null {
  if (!Array.isArray(rawHistory)) return null;

  let sql: string | null = null;
  let sourceOfSql: SourceId = currentSource;
  for (let i = rawHistory.length - 1; i >= 0 && !sql; i--) {
    const e = entryAt(rawHistory, i);
    if (!e || e.role !== "assistant" || typeof e.content !== "string") continue;
    const found = extractSql(e.content);
    if (found) {
      sql = found;
      if (typeof e.source === "string" && (SOURCE_IDS as string[]).includes(e.source)) {
        sourceOfSql = e.source as SourceId;
      }
    }
  }
  if (!sql) return null;

  let baseQuestion: string | null = null;
  for (let i = rawHistory.length - 1; i >= 0; i--) {
    const e = entryAt(rawHistory, i);
    if (!e || e.role !== "user" || typeof e.content !== "string") continue;
    const content = e.content.trim();
    if (!content || content.startsWith("[SYSTEM:")) continue;
    if (isFollowUp(content)) continue; // fragments ("compare to Dallas") can't anchor reconstruction
    baseQuestion = content;
    break;
  }

  const ctx = extractQueryContext(sql, baseQuestion ?? "", sourceOfSql as Tab);
  return {
    sourceOfSql,
    baseQuestion,
    geos: ctx.geos,
    states: ctx.states,
    offenses: ctx.offenses,
    isPerCapita: ctx.isPerCapita,
    timeRange: ctx.timeRange,
  };
}

function timePhrase(range: { start: number | null; end: number | null }): string | null {
  if (range.start !== null && range.end !== null) return `years ${range.start}-${range.end}`;
  if (range.start !== null) return `years ${range.start} onward`;
  if (range.end !== null) return `years through ${range.end}`;
  return null;
}

/**
 * Fires ONLY when today's pipeline loses context: the source-filtered history
 * carries no prior SQL, the raw history does, and the new message is a
 * query-bearing change request. Same-source conversations return null so the
 * existing transforms keep ownership.
 */
export function buildCrossSourceFollowupTransform(
  question: string,
  rawHistory: unknown,
  currentSource: SourceId,
): FollowupTransform | null {
  if (!Array.isArray(rawHistory) || rawHistory.length === 0) return null;
  const normalized = normalizeHistoryForTab(rawHistory, currentSource);
  if (hasPriorSql(normalized)) return null; // context survived; not our case
  if (!detectQueryBearingFollowup(question, rawHistory)) return null;
  // Only fragments need reconstruction — a self-contained question ("hate
  // crimes in Texas since 2015") must not inherit unrelated prior context.
  if (!isFollowUp(question)) return null;

  const state = extractPriorQueryState(rawHistory, currentSource);
  if (!state || state.sourceOfSql === currentSource) return null;

  const parts: string[] = [];
  if (state.baseQuestion) parts.push(`original question "${state.baseQuestion}"`);
  const places = state.geos.length > 0 ? state.geos : state.states;
  if (places.length > 0) parts.push(`geographies: ${places.join(", ")}`);
  if (state.offenses.length > 0) parts.push(`offense/topic: ${state.offenses.join(", ")}`);
  parts.push(`metric: ${state.isPerCapita ? "rate per 100,000" : "counts"}`);
  const time = timePhrase(state.timeRange);
  if (time) parts.push(time);
  const contextSummary = parts.join("; ");

  const contextQuestion = `${question.trim().replace(/\s+/g, " ")} (continuing: ${contextSummary})`;

  return {
    name: "carry_cross_source_context",
    contextQuestion,
    instruction:
      `[SYSTEM: This follow-up continues a conversation that started in a different data source, so earlier turns are not shown. Reconstructed context from the last executed query: ${contextSummary}. Apply the user's new request "${question.trim()}" to that context and preserve everything not explicitly changed. If the prior metric was a rate and this source cannot compute a valid rate for that scope, return raw counts and briefly note why. Do not ask for clarification and do not answer with coverage metadata.]`,
  };
}
