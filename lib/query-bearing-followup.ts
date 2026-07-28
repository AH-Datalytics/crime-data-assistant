import { resolveGeoPlaces } from "./geo-place-resolver";

/**
 * Detects "query-bearing follow-ups": the conversation already produced a
 * successful SQL result and the new message asks to CHANGE something about it
 * (year range, geography, offense, metric, granularity, breakdown, chart).
 *
 * Routes must bypass standalone-question shortcuts (metadata coverage, county
 * clarifier, historical place lookup) when this returns non-null, so the
 * follow-up reaches the model path with its conversation history. Without this,
 * "Can you change the start year to 1988?" matched the metadata year_range
 * intent (lib/metadata-coverage.ts) and returned coverage metadata instead of
 * modifying the prior query.
 *
 * Deliberately narrower than isFollowUp (lib/tab-suggest.ts): coverage
 * questions like "how far back does the data go?" are follow-ups but are NOT
 * change requests — those must keep the fast deterministic metadata path.
 */
export type FollowupChangeKind =
  | "time_range"
  | "geography"
  | "offense"
  | "metric"
  | "granularity"
  | "breakdown"
  | "chart";

export interface QueryBearingFollowup {
  kinds: FollowupChangeKind[];
}

const YEAR_RE = /\b(?:17|18|19|20)\d{2}\b/;

/** Same signal detectFollowupTransform uses: an assistant turn carrying SQL.
 *  Takes RAW body.history (unknown) — the shortcuts run before history
 *  normalization in /api/query, so entries are validated defensively. */
function hasPriorSqlResult(rawHistory: unknown): boolean {
  if (!Array.isArray(rawHistory)) return false;
  return rawHistory.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const role = (entry as { role?: unknown }).role;
    const content = (entry as { content?: unknown }).content;
    return role === "assistant" && typeof content === "string" &&
      /\bSELECT\b[\s\S]+\bFROM\b/i.test(content);
  });
}

/** Coverage/metadata phrasings that must keep the deterministic metadata path. */
function asksCoverageNotChange(q: string): boolean {
  return /\bhow\s+far\s+back\b/i.test(q) ||
    /\b(?:what|which)\s+years?\b/i.test(q) ||
    /\b(?:earliest|latest)\s+(?:year|data)\b/i.test(q) ||
    /\bdata\s+(?:go(?:es)?\s+back|start|begin|available)\b/i.test(q) ||
    /\b(?:which|what|list|how\s+many)\b[\s\S]{0,40}\b(?:years?|states?|agenc(?:y|ies)|cit(?:y|ies)|departments?)\b/i.test(q) ||
    /\b(?:years?|states?|agenc(?:y|ies)|cit(?:y|ies))\b[\s\S]{0,40}\b(?:available|covered|represented|included|in\s+the\s+data(?:base|set)?)\b/i.test(q) ||
    /\b(?:download|export|csv)\b/i.test(q);
}

function refersToTimeRangeChange(q: string): boolean {
  // "change/set/extend/... the start year / year range / period ..."
  if (/\b(?:change|set|update|move|shift|adjust|extend|expand|shorten|limit|restrict)\b/i.test(q) &&
      /\b(?:years?|dates?|range|period|time\s*frame|timeframe)\b/i.test(q)) return true;
  // "start year 1988" / "end year to 2010" (a change request when a year is named)
  if (/\b(?:start|starting|begin|beginning|end|ending)\s+(?:year|date|month)\b/i.test(q) && YEAR_RE.test(q)) return true;
  // "start the chart in 2000" / "start it at 1988" / "begin in 1990"
  if (/\b(?:start|begin)\s+(?:(?:the|this|that)\s+)?(?:chart|graph|plot|data|series|trend|it)?\s*(?:in|at|from)\s+(?:17|18|19|20)\d{2}\b/i.test(q)) return true;
  // "go back further to 1940" / "go back to 1950" / "go back earlier"
  if (/\bgo(?:ing)?\s+(?:back\s+)?(?:further|farther|earlier)\b/i.test(q)) return true;
  if (/\bgo(?:ing)?\s+back\s+to\s+(?:17|18|19|20)\d{2}\b/i.test(q)) return true;
  // bare range shifts: "since 1995", "through 2020", "from 1990 to 2010"
  if (/\b(?:since|through|until|up\s+to)\s+(?:17|18|19|20)\d{2}\b/i.test(q)) return true;
  if (/\bfrom\s+(?:17|18|19|20)\d{2}\s+(?:to|through|-|–)\s*(?:17|18|19|20)\d{2}\b/i.test(q)) return true;
  return false;
}

function refersToGeographyChange(q: string): boolean {
  if (/^\s*(?:compare|vs\.?|versus)\b/i.test(q)) return true;
  if (/\bcompare\s+(?:(?:it|this|that|them)\s+)?(?:to|with|against)\b/i.test(q)) return true;
  if (/\b(?:make|show)\s+(?:it|this|that)\s+statewide\b/i.test(q)) return true;
  const whatAbout = q.match(/^\s*(?:what|how)\s+about\s+(.+?)\s*\??\s*$/i);
  if (whatAbout && !YEAR_RE.test(whatAbout[1]) &&
      resolveGeoPlaces(whatAbout[1]).mentions.length > 0) return true;
  return false;
}

export const OFFENSE_NOUN_RE = /\b(?:murders?|homicides?|rapes?|robber(?:y|ies)|assaults?|burglar(?:y|ies)|thefts?|larcen(?:y|ies)|motor\s+vehicle\s+thefts?|carjackings?|shootings?|arsons?|violent\s+crimes?|property\s+crimes?|hate\s+crimes?)\b/i;

function refersToOffenseChange(q: string): boolean {
  const whatAbout = q.match(/^\s*(?:what|how)\s+about\s+(.+?)\s*\??\s*$/i);
  if (whatAbout && OFFENSE_NOUN_RE.test(whatAbout[1]) &&
      resolveGeoPlaces(whatAbout[1]).mentions.length === 0) return true;
  return OFFENSE_NOUN_RE.test(q) &&
    /\binstead\b|\brather\s+than\b|\bswitch(?:\s+(?:it|this|that))?\s+to\b|\bchange\s+(?:it|this|that|the\s+offense)\s+to\b|\bnow\s+show\b|\bmake\s+it\b/i.test(q);
}
function refersToMetricChange(q: string): boolean {
  const mentionsMetric =
    /\b(?:rates?|counts?|numbers?|totals?|per\s*capita|per\s*100,?000|per\s*100\s*k|percentages?|shares?)\b/i.test(q);
  if (!mentionsMetric) return false;
  return /\binstead\b|\brather\s+than\b|\bswitch\b|\bchange\s+(?:it|this|that)\b|\bmake\s+(?:it|this|that)\b/i.test(q) ||
    /\bshow\s+(?:the\s+)?(?:rates?|counts?|numbers?|totals?)\b/i.test(q);
}

function refersToGranularityChange(q: string): boolean {
  const mentionsGrain =
    /\b(?:monthly|annual(?:ly)?|yearly|quarterly|weekly|by\s+month|by\s+year|per\s+month|per\s+year|rolling\s+(?:12[\s-]*month\s+)?(?:average|window|sum|total)|12[\s-]*month\s+rolling)\b/i.test(q);
  if (!mentionsGrain) return false;
  return /\bmake\s+(?:it|this|that)\b|\binstead\b|\bswitch\b|\bchange\b|\bshow\s+(?:it|this|that)\b|\buse\b/i.test(q) ||
    /^\s*(?:monthly|annual(?:ly)?|yearly|quarterly|weekly)\b/i.test(q.trim());
}

function refersToBreakdownChange(q: string): boolean {
  return /\b(?:break(?:\s+(?:it|this|that))?\s+down|split(?:\s+(?:it|this|that))?(?:\s+out)?|group(?:\s+(?:it|this|that))?)\s+by\b/i.test(q);
}

function refersToChartChange(q: string): boolean {
  if (/\by[\s-]?axis\b/i.test(q)) return true;
  return /\b(?:line|bar|pie|stacked|scatter)\s*(?:chart|graph|plot)\b/i.test(q) &&
    /\bmake\s+(?:it|this|that)\b|\bchange\b|\bswitch\b|\bas\s+a\b|\buse\b/i.test(q);
}

export function detectQueryBearingFollowup(
  question: string,
  rawHistory: unknown
): QueryBearingFollowup | null {
  if (!hasPriorSqlResult(rawHistory)) return null;
  if (asksCoverageNotChange(question)) return null;

  const kinds: FollowupChangeKind[] = [];
  if (refersToTimeRangeChange(question)) kinds.push("time_range");
  if (refersToGeographyChange(question)) kinds.push("geography");
  if (refersToOffenseChange(question)) kinds.push("offense");
  if (refersToMetricChange(question)) kinds.push("metric");
  if (refersToGranularityChange(question)) kinds.push("granularity");
  if (refersToBreakdownChange(question)) kinds.push("breakdown");
  if (refersToChartChange(question)) kinds.push("chart");

  return kinds.length > 0 ? { kinds } : null;
}
