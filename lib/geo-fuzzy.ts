/**
 * Typo-tolerant place matching (Task 21). A conservative fallback used only
 * when exact resolution finds nothing: a wrong fuzzy match silently routes a
 * query to the wrong place, so the bar for a confident single match is high,
 * and anything close-but-ambiguous is surfaced for confirmation rather than
 * guessed. Operates over the catalog's aliases; no dependency on the resolver
 * or route code so it can be tested in isolation.
 */

import { GEO_PLACE_CATALOG, type GeoPlaceCatalogEntry } from "./geo-place-catalog";

export type FuzzyPlaceCandidate = {
  entry: GeoPlaceCatalogEntry;
  alias: string;
  distance: number;
  score: number; // normalized 0..1, higher is closer
};

export type FuzzyPlaceResult = {
  candidates: FuzzyPlaceCandidate[];
  best: FuzzyPlaceCandidate | null;
  confident: boolean;        // a single clearly-best match — safe to resolve
  needsConfirmation: boolean; // multiple near-equal matches — ask, don't guess
};

/** Bounded Levenshtein: returns early once distance exceeds `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

/** Soundex phonetic key — a cheap pre-filter and a secondary "sounds like" signal. */
export function soundex(value: string): string {
  const s = value.toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return "";
  const codes: Record<string, string> = {
    B: "1", F: "1", P: "1", V: "1",
    C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2",
    D: "3", T: "3", L: "4", M: "5", N: "5", R: "6",
  };
  let result = s[0];
  let prevCode = codes[s[0]] ?? "";
  for (let i = 1; i < s.length && result.length < 4; i += 1) {
    const code = codes[s[i]] ?? "";
    if (code && code !== prevCode) result += code;
    if (s[i] !== "H" && s[i] !== "W") prevCode = code;
  }
  return (result + "000").slice(0, 4);
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Distance budget scales with length — 1 typo in short names, more in long ones. */
function distanceBudget(len: number): number {
  if (len <= 4) return 1;
  if (len <= 8) return 2;
  return 3;
}

/**
 * Find catalog entries whose alias is a close typo of `text`. Returns ranked
 * candidates plus `confident` (a single clearly-best match) and
 * `needsConfirmation` (several near-equal matches — caller should ask).
 */
export function fuzzyResolvePlace(
  text: string,
  catalog: GeoPlaceCatalogEntry[] = GEO_PLACE_CATALOG,
): FuzzyPlaceResult {
  const query = norm(text);
  const empty: FuzzyPlaceResult = { candidates: [], best: null, confident: false, needsConfirmation: false };
  if (query.length < 3) return empty;
  const budget = distanceBudget(query.length);
  const querySoundex = soundex(query.replace(/\s/g, ""));

  const bestByEntry = new Map<string, FuzzyPlaceCandidate>();
  for (const entry of catalog) {
    for (const rawAlias of entry.aliases) {
      const alias = norm(rawAlias);
      if (!alias || alias === query) continue; // exact handled elsewhere
      if (Math.abs(alias.length - query.length) > budget) continue; // cheap length pre-filter
      const dist = editDistance(query, alias, budget);
      if (dist > budget) continue;
      // Require either a tight edit distance OR a phonetic agreement, so we
      // don't fuzzily collapse genuinely different names of similar length.
      const phonetic = soundex(alias.replace(/\s/g, "")) === querySoundex;
      if (dist > 1 && !phonetic) continue;
      const score = 1 - dist / (Math.max(query.length, alias.length) || 1);
      const prior = bestByEntry.get(entry.id);
      if (!prior || dist < prior.distance) bestByEntry.set(entry.id, { entry, alias: rawAlias, distance: dist, score });
    }
  }

  const candidates = [...bestByEntry.values()].sort((a, b) => a.distance - b.distance || b.score - a.score);
  if (candidates.length === 0) return empty;
  const best = candidates[0];
  // Distinct places within one edit of the best (and not the same canonical
  // place) => ambiguous; confirm rather than guess.
  const rivals = candidates.filter((c) => c.distance <= best.distance + 1 && c.entry.name.toLowerCase() !== best.entry.name.toLowerCase());
  const needsConfirmation = rivals.length > 0;
  const confident = !needsConfirmation && best.distance <= budget;
  return { candidates, best, confident, needsConfirmation };
}
