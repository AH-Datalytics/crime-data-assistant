import type { SourceId } from "./sources";

export interface ChatHistoryEntry {
  role?: unknown;
  content?: unknown;
  source?: unknown;
  tab?: unknown;
}

export interface PromptHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

const VALID_SOURCES = new Set<SourceId>(["current", "historical", "nibrs", "shr", "hate_crime"]);

function historySource(entry: ChatHistoryEntry): SourceId | null {
  const raw = typeof entry.source === "string" ? entry.source : typeof entry.tab === "string" ? entry.tab : "";
  return VALID_SOURCES.has(raw as SourceId) ? raw as SourceId : null;
}

/**
 * Keep only prompt-safe history for the active source.
 *
 * Tagged cross-source entries are dropped so table names and assumptions from
 * one database cannot contaminate another database's SQL prompt. Untagged
 * legacy entries are preserved for older clients that do not send source tags.
 */
export function normalizeHistoryForTab(raw: unknown, tab: SourceId, limit = 6): PromptHistoryMessage[] {
  if (!Array.isArray(raw)) return [];

  const normalized: PromptHistoryMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const h = entry as ChatHistoryEntry;
    if (h.role !== "user" && h.role !== "assistant") continue;
    if (typeof h.content !== "string" || !h.content.trim()) continue;

    const source = historySource(h);
    if (source && source !== tab) continue;

    normalized.push({
      role: h.role,
      content: h.content.slice(0, 6000),
    });
  }

  return normalized.slice(-limit);
}

/** Normalize history without dropping entries from other tabs for safety detectors. */
export function normalizeHistoryAllSources(raw: unknown, limit = 6): PromptHistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const normalized: PromptHistoryMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const h = entry as ChatHistoryEntry;
    if (h.role !== "user" && h.role !== "assistant") continue;
    if (typeof h.content !== "string" || !h.content.trim()) continue;
    normalized.push({ role: h.role, content: h.content.slice(0, 6000) });
  }
  return normalized.slice(-limit);
}

/** A history turn with the source tag the client sent, or null when untagged. */
export interface SourceTaggedMessage extends PromptHistoryMessage {
  source: SourceId | null;
}

/**
 * History with its source tags RETAINED, in original order.
 *
 * `normalizeHistoryForTab` deletes other-source turns, which leaves older same-source turns
 * adjacent and erases the evidence that the conversation moved elsewhere in between. That is
 * harmless for prompt hygiene -- the point there is to keep one database's assumptions out of
 * another's SQL -- but a safety decision that asks "is this still the same request?" needs the
 * boundary the filtering removed, or an intervening question about another source looks like it
 * never happened.
 *
 * Untagged legacy entries keep `source: null` and are left for the caller to treat as same-source,
 * preserving the existing behaviour for older clients that send no tags.
 */
export function normalizeHistoryWithSource(raw: unknown, limit = 6): SourceTaggedMessage[] {
  if (!Array.isArray(raw)) return [];
  const normalized: SourceTaggedMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const h = entry as ChatHistoryEntry;
    if (h.role !== "user" && h.role !== "assistant") continue;
    if (typeof h.content !== "string" || !h.content.trim()) continue;
    normalized.push({ role: h.role, content: h.content.slice(0, 6000), source: historySource(h) });
  }
  return normalized.slice(-limit);
}
