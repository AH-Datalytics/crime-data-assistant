import { assertModelAllowed } from "./why-scope";
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
  explanation: string; // pre-query explanation only — post-query is always regenerated
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

/**
 * Cache key, including the proof validity signature when one is supplied.
 *
 * The signature carries the enforcement state and source data version the entry was
 * created under (see lib/proof-cache-validity). Folding it into the key means a change
 * to either produces a miss rather than replaying SQL that was authored under
 * conditions no longer in force — handoff §4 and §13.
 *
 * Optional so that a caller with no proof context behaves exactly as before; the key
 * is then byte-identical to the pre-Stage-1 key, which is what keeps `off` mode from
 * changing cache behavior at all.
 */
function normalizeKey(question: string, tab: string, validity?: string): string {
  // Lowercase, collapse whitespace, strip trailing punctuation
  const q = question.toLowerCase().replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim();
  return validity ? `${tab}:${validity}:${q}` : `${tab}:${q}`;
}

/**
 * Empties the cache. Test-only, and named to say so.
 *
 * Proving that off and shadow produce the same response to the same COLD question needs
 * two genuinely cold runs of one input. Without a reset the second run would be a cache
 * hit, and comparing a cold response against a warm one proves nothing. Mirrors the
 * existing __resetProofBudgetStateForTests in lib/proof-finalize.
 */
export function __resetResponseCacheForTests(): void {
  cache.clear();
}

export function getCached(question: string, tab: string, validity?: string): CachedResponse | null {
  // Stage 3b (r1.4 R4.3): a rebuild never reads a cached model answer; blocked before the read.
  assertModelAllowed("cached model answer");
  const key = normalizeKey(question, tab, validity);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

export function setCache(
  question: string,
  tab: string,
  response: Omit<CachedResponse, "ts">,
  validity?: string,
): void {
  const key = normalizeKey(question, tab, validity);

  // LRU eviction: remove oldest entry if at capacity
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }

  cache.set(key, { ...response, ts: Date.now() });
}
