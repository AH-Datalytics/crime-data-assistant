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
  if (/^\s*(?:what|how)\s+about\s+(?:this|the\s+current)\s+year\s*\??\s*$/i.test(q)) return false;
  return /\bhow\s+far\s+back\b/i.test(q) ||
    /\b(?:what|which)\s+years?\b/i.test(q) ||
    /\b(?:earliest|latest)\s+(?:year|data)\b/i.test(q) ||
    /\bdata\s+(?:go(?:es)?\s+back|start|begin|available)\b/i.test(q) ||
    /\b(?:which|what|list|how\s+many)\b[\s\S]{0,40}\b(?:years?|states?|agenc(?:y|ies)|cit(?:y|ies)|departments?)\b/i.test(q) ||
    /\b(?:years?|states?|agenc(?:y|ies)|cit(?:y|ies))\b[\s\S]{0,40}\b(?:available|covered|represented|included|in\s+the\s+data(?:base|set)?)\b/i.test(q) ||
    /\b(?:download|export|csv)\b/i.test(q);
}

function refersToTimeRangeChange(q: string): boolean {
  // Conversational relative-time shifts: "what about this year?" / "YTD instead".
  // Require a follow-up cue so a complete standalone question containing
  // "this year" is not treated as a mutation merely because history exists.
  if (/\b(?:what|how)\s+about\s+(?:this|the\s+current)\s+year\b/i.test(q) ||
      /\b(?:this\s+year|current\s+year|ytd|year[-\s]?to[-\s]?date)\s+instead\b/i.test(q)) return true;
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
  // A bare comparison that names no offense still needs the prior question for
  // its topic ("compare Chicago to Dallas" after "murders in Chicago"). One that
  // names its own offense does not -- see isSelfContainedQuestion.
  if (/^\s*(?:compare|vs\.?|versus)\b/i.test(q) && !OFFENSE_NOUN_RE.test(q)) return true;
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
  return granularityChangeVerb(q) || leadingGrainWord(q);
}
const granularityChangeVerb = (q: string) => /\bmake\s+(?:it|this|that)\b|\binstead\b|\bswitch\b|\bchange\b|\bshow\s+(?:it|this|that)\b|\buse\b/i.test(q);
const leadingGrainWord = (q: string) => /^\s*(?:monthly|annual(?:ly)?|yearly|quarterly|weekly)\b/i.test(q.trim());

/**
 * Round 1 Q4 (owner report 2026-10-23): a leading grain word opens a COMPLETE question as often as it modifies the last
 * one. "Monthly murders in Chicago, IL in 2026" names its own offense and place, so it means the same fresh and after a
 * prior answer; a bare "monthly", "monthly instead" or "make that monthly" still changes the prior answer. An anaphor
 * ("monthly for it") points back and keeps the follow-up reading.
 */
function namesOwnOffenseAndPlace(q: string): boolean {
  if (/\b(?:it|this|that|them|these|those|same)\b/i.test(q)) return false;
  return OFFENSE_NOUN_RE.test(q) && resolveGeoPlaces(q).mentions.length >= 1;
}

function refersToBreakdownChange(q: string): boolean {
  return /\b(?:break(?:\s+(?:it|this|that))?\s+down|split(?:\s+(?:it|this|that))?(?:\s+out)?|group(?:\s+(?:it|this|that))?)\s+by\b/i.test(q);
}

function refersToChartChange(q: string): boolean {
  if (/\by[\s-]?axis\b/i.test(q)) return true;
  return /\b(?:line|bar|pie|stacked|scatter)\s*(?:chart|graph|plot)\b/i.test(q) &&
    /\bmake\s+(?:it|this|that)\b|\bchange\b|\bswitch\b|\bas\s+a\b|\buse\b/i.test(q);
}

/** A question that supplies its own two-or-more places AND its own offense is a
 *  new question, not a modification of the prior one -- however many
 *  change-request verbs it happens to contain. An anaphor disqualifies it,
 *  because that points back at the prior result ("compare IT to Dallas").
 *
 *  Production 8378: "compare tulsa and oklahoma city homicides over time" was
 *  read as a geography change against SQL from a different tab, which skipped
 *  the deterministic multi-city plan. */
function isSelfContainedQuestion(q: string): boolean {
  if (/\b(?:it|this|that|them|these|those|same)\b/i.test(q)) return false;
  if (!OFFENSE_NOUN_RE.test(q)) return false;
  return resolveGeoPlaces(q).mentions.length >= 2;
}

/**
 * Owner report 2026-10-23: "Denver vehicle burglaries per month since 2018", asked after an earlier answer, was refused
 * as a follow-up because its bare "since 2018" reads as a date change. A one-place question is complete, and so NOT a
 * follow-up, only when ALL of these hold (Codex r1: keep every explicit change and every possible dropped restriction):
 * - the ONLY change signal is a bare range ("since/through/until/up to YYYY", "from YYYY to YYYY"): no change verb, no
 *   other change kind;
 * - it names its own offense and exactly one place, with no back-reference or continuation word;
 * - the previous user question, when it is about the same place, has no word this question drops (so "robberies in
 *   Dallas since 2010" after "armed robberies by month in Dallas" stays a follow-up: "armed", "month" are dropped).
 */
const BARE_RANGE_RE = /\b(?:since|through|until|up\s+to)\s+(?:17|18|19|20)\d{2}\b|\bfrom\s+(?:17|18|19|20)\d{2}\s+(?:to|through|-|–)\s*(?:17|18|19|20)\d{2}\b/i;
const CHANGE_CUE_RE = /\b(?:it|this|that|them|these|those|same|instead|rather\s+than|also|too|again|now|change|set|update|move|shift|adjust|extend|expand|shorten|limit|restrict|switch|use|make|start|begin|end|go\s+back)\b|\b(?:what|how)\s+about\b/i;
const FILLER = new Set(["the", "and", "for", "per", "in", "of", "on", "at", "to", "by", "a", "an", "show", "me", "what", "how", "many", "is", "are", "was", "were", "since", "from", "through", "until", "up", "can", "you", "please", "give", "number", "numbers", "count", "counts", "total", "totals", "data", "i", "see"]);
const contentWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w) && !/^(?:17|18|19|20)\d{2}$/.test(w));
const stem = (w: string) => w.replace(/(?:ies|es|s)$/, "");
function lastUserQuestion(rawHistory: unknown): string | null {
  if (!Array.isArray(rawHistory)) return null;
  for (let i = rawHistory.length - 1; i >= 0; i -= 1) {
    const e = rawHistory[i] as { role?: unknown; content?: unknown } | null;
    if (e && e.role === "user" && typeof e.content === "string") return e.content;
  }
  return null;
}
function completeOnePlaceRange(q: string, rawHistory: unknown): boolean {
  if (!BARE_RANGE_RE.test(q) || CHANGE_CUE_RE.test(q) || !OFFENSE_NOUN_RE.test(q)) return false;
  const mine = resolveGeoPlaces(q).mentions;
  if (mine.length !== 1) return false;
  const prev = lastUserQuestion(rawHistory);
  if (!prev) return true;
  const ids = new Set(mine[0].candidates.map((c) => c.id));
  const samePlace = resolveGeoPlaces(prev).mentions.some((p) => p.text.toLowerCase() === mine[0].text.toLowerCase() || p.candidates.some((c) => ids.has(c.id)));
  if (!samePlace) return true;
  // The earlier offense and place words are replaced by this question's own, so they are not "dropped"; any other
  // earlier word (a filter such as "armed", a grain such as "month") must still be present.
  const have = new Set(contentWords(q).map(stem));
  const placeWords = new Set(resolveGeoPlaces(prev).mentions.flatMap((p) => contentWords(p.text)));
  const offenseWords = new Set(contentWords(prev).filter((w) => OFFENSE_NOUN_RE.test(w) || /^(?:vehicles?|motor|aggravated|simple|violent|property|crimes?|offenses?)$/.test(w)));
  return contentWords(prev).filter((w) => !placeWords.has(w) && !offenseWords.has(w)).every((w) => have.has(stem(w)));
}

/**
 * Complete-turn fix (2026-10-23; Codex placement ruling in audit/presentation-2026-10-20/codex-readings-table-ruling.md):
 * the ONE place where a turn that carries change words is judged a complete question of its own. It holds the three
 * earlier exemptions unchanged, in their order, and returns the change kinds that still make the turn a follow-up:
 * - two or more places plus an offense, with no back-reference (production 8378): no kinds;
 * - Round 1 Q4: a LEADING grain word with no change verb, in a turn naming its own offense and place, is not a change;
 * - the one-place bare range (owner's Denver report): a time range that is the only change, with every restriction of
 *   the previous question on the same place still present, is not a change.
 * Every other turn keeps every kind it carries, so a dependent or ambiguous turn still goes to reconstruction and K2.
 */
export function followupKindsAfterCompleteTurn(question: string, rawHistory: unknown, kinds: FollowupChangeKind[]): FollowupChangeKind[] {
  if (isSelfContainedQuestion(question)) return [];
  let left = kinds;
  if (left.includes("granularity") && !granularityChangeVerb(question) && leadingGrainWord(question) && namesOwnOffenseAndPlace(question)) {
    left = left.filter((k) => k !== "granularity");
  }
  if (left.length === 1 && left[0] === "time_range" && completeOnePlaceRange(question, rawHistory)) return [];
  return left;
}

export function detectQueryBearingFollowup(
  question: string,
  rawHistory: unknown
): QueryBearingFollowup | null {
  if (!hasPriorSqlResult(rawHistory)) return null;
  if (asksCoverageNotChange(question)) return null;

  const detected: FollowupChangeKind[] = [];
  if (refersToTimeRangeChange(question)) detected.push("time_range");
  if (refersToGeographyChange(question)) detected.push("geography");
  if (refersToOffenseChange(question)) detected.push("offense");
  if (refersToMetricChange(question)) detected.push("metric");
  if (refersToGranularityChange(question)) detected.push("granularity");
  if (refersToBreakdownChange(question)) detected.push("breakdown");
  if (refersToChartChange(question)) detected.push("chart");

  const kinds = followupKindsAfterCompleteTurn(question, rawHistory, detected);
  return kinds.length > 0 ? { kinds } : null;
}
