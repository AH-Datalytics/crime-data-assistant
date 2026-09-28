/**
 * The county a Homicide Reports (SHR) request names, and the scope it asks for (GC-080).
 *
 * Kept apart from lib/shr-county-scope.ts, with only light imports, so the source-capability rules
 * can ask "does the application bind this county itself?" without an import cycle.
 *   - a bare county name -> scope "sheriff" (owner ruling: a county name means the sheriff agency)
 *   - "countywide", "all agencies in ..." -> scope "countywide"
 *   - an explicitly named county POLICE agency -> null (that agency, handled as before)
 */
import { displayPlace, stateMention } from "./shr-deterministic-shooting";

export type ShrCountyRequest = {
  countyKey: string;
  countyDisplay: string;
  state: string | null;
  scope: "sheriff" | "countywide";
  explicitSheriff: boolean;
};

const STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY",
  "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
  "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]);

const COUNTY_WORD = /\b(?:County|Parish|Borough)\b/i;
// Words that end a county name read backward. "by county" and "each county" name no county at all.
const NAME_STOP = /^(?:in|within|inside|for|from|across|covering|of|at|by|per|each|every|any|which|what|this|that|their|its|same|other|different|the|a|an|and|all|agencies|agency|countywide|county-wide|homicides?|murders?|shootings?|number|total|count|victims?)$/i;
const COUNTYWIDE_SCOPE =
  /\b(?:county[- ]?wide|all\s+(?:law[- ]enforcement\s+|police\s+|reporting\s+)?agencies|every\s+(?:law[- ]enforcement\s+|police\s+)?agency|all\s+(?:police\s+)?departments|entire\s+county|whole\s+county)\b/i;

export function shrCountyKey(value: string): string {
  return value.replace(/\b(county|parish|borough)\b/ig, " ").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/** A county named in the request, and the scope the request asked for; null when none is named. */
export function shrCountyRequest(question: string): ShrCountyRequest | null {
  const suffix = COUNTY_WORD.exec(question);
  if (!suffix) return null;
  const after = question.slice(suffix.index + suffix[0].length);
  // An explicitly named county POLICE agency is that agency, not the county: existing behavior.
  if (/^\s*,?\s*police\b/i.test(after)) return null;
  // The name is read BACKWARD from the county word to the nearest preposition or article, at most
  // four words: "number of homicides in baldwin county" names "baldwin", never "homicides in baldwin".
  const words = question.slice(0, suffix.index).trim().split(/\s+/);
  const nameWords: string[] = [];
  for (let i = words.length - 1; i >= 0 && nameWords.length < 4; i--) {
    if (NAME_STOP.test(words[i])) break;
    nameWords.unshift(words[i]);
  }
  const name = nameWords.join(" ").replace(/[,;:]+$/, "").trim();
  const countyKey = shrCountyKey(name);
  if (!countyKey) return null;
  const explicitSheriff = /^\s*,?\s*(?:[a-z]{2}\s*,?\s*)?sheriff/i.test(after) || /\bsheriff/i.test(question);
  return {
    countyKey,
    countyDisplay: displayPlace(name),
    state: stateAfterCounty(after) ?? stateMention(question),
    scope: COUNTYWIDE_SCOPE.test(question) && !explicitSheriff ? "countywide" : "sheriff",
    explicitSheriff,
  };
}

/** "Baldwin County, AL" / "baldwin county al": a two-letter state code right after the county word. */
function stateAfterCounty(after: string): string | null {
  const code = /^\s*,?\s*([A-Za-z]{2})\b/.exec(after)?.[1]?.toUpperCase();
  return code && STATE_CODES.has(code) ? code : null;
}
