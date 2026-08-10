/**
 * Shared city-literal normalization for NIBRS agency lookups.
 *
 * agencies.city is a mailing-city field, not a jurisdiction name, and its
 * spellings are inconsistent: St. Louis, MO appears as a ~9k-population agency
 * literally named 'ST LOUIS' and as the ~275k-population city department named
 * 'SAINT LOUIS'. A lookup that tries one spelling silently picks whichever
 * agency happens to carry it.
 *
 * This lived only in nibrs-deterministic-queries as a one-directional
 * nibrsCityLiteral(), which the resolver never called -- so the resolver and the
 * deterministic builders disagreed about what "St Louis" meant.
 */

/** Names the agencies table stores differently from how users write them. */
const EXPLICIT_ALIASES: Record<string, string[]> = {
  "NEW YORK CITY": ["NEW YORK"],
  NYC: ["NEW YORK"],
};

export function normalizeCityLiteral(name: string): string {
  return name.replace(/\./g, "").replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Every literal worth trying for a user-supplied city name, most-specific first.
 * Callers should match with `city IN (...)` and let population ordering pick the
 * primary agency, rather than assuming the first candidate is the right one.
 */
export function cityLookupCandidates(name: string): string[] {
  const normalized = normalizeCityLiteral(name);
  const candidates = [normalized, ...(EXPLICIT_ALIASES[normalized] ?? [])];
  for (const candidate of [...candidates]) {
    // Word-boundary anchored: "Stockton" is not a St. name.
    if (/^ST\s/.test(candidate)) candidates.push(candidate.replace(/^ST\s/, "SAINT "));
    if (/^SAINT\s/.test(candidate)) candidates.push(candidate.replace(/^SAINT\s/, "ST "));
  }
  return [...new Set(candidates)];
}
