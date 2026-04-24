/**
 * In-memory response cache for Claude API calls.
 * Keyed on normalized question + tab/mode. Cache hit skips the Claude call
 * entirely — the caller re-runs the cached SQL against the DB for fresh data.
 *
 * TTL: 4 hours. Max 500 entries (LRU eviction).
 */

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_ENTRIES = 500;

interface CachedResponse {
  sql: string;
  explanation: string;
  title?: string;
  chartType?: string;
  chartHint?: string;
  xAxis?: string;
  yAxis?: string[];
  yAxisLabel?: string;
  xAxisLabel?: string;
  colors?: string[];
  annotations?: unknown[];
  ts: number;
}

const cache = new Map<string, CachedResponse>();

function normalizeKey(question: string, tab: string): string {
  // Lowercase, collapse whitespace, strip trailing punctuation
  const q = question.toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim();
  return `${tab}:${q}`;
}

export function getCached(question: string, tab: string): CachedResponse | null {
  const key = normalizeKey(question, tab);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

export function setCache(question: string, tab: string, response: Omit<CachedResponse, "ts">): void {
  const key = normalizeKey(question, tab);

  // LRU eviction: remove oldest entry if at capacity
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }

  cache.set(key, { ...response, ts: Date.now() });
}
