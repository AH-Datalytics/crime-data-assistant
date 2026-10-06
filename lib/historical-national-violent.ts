import { buildQueryContract } from "./query-contract";
import type { HistoricalCityChangePlan } from "./historical-deterministic-queries";

/**
 * National violent-crime batch (Codex :36558; Jeff's local grant, 2026-10-06).
 *
 * The release-f window failed D1 ("NATIONWIDE VIOLENT CRIME FROM 1930-PRESENT") because the MODEL chose the table: it
 * summed `historical_agency_crime.violent` over whichever agencies reported and the answer called that a U.S. count.
 * The owned composite narrative (lib/historical-composite-measure.ts) correctly declined to describe that shape, but
 * nothing stopped it being delivered. The narrative can only describe what the model chose; this plan removes the
 * choice for the one family it owns.
 *
 * OWNED FAMILY (recognized positively from the query contract, never from a remembered sentence): a Historical
 * United States / nationwide annual violent-crime COUNT series -- geography national, the single violent-crime
 * measure, unit count, no breakdown other than year, with an explicit year range, a start year (through present) or
 * no period. Anything else -- a rate, a state/city/agency, another or an additional offense, a ranking, comparison,
 * share, change, filter or exclusion -- is not this family and keeps its existing route.
 *
 * SOURCE: the national table with a positive `state = 'United States'` restriction and the accepted four-component
 * count expression. A plain sum, so a year missing any component returns no value rather than a manufactured
 * total; the coverage statement then reports the years actually returned. Agency sums are never used.
 */
export const NATIONAL_VIOLENT_COUNT_GUARDRAIL = "deterministic-historical-national-violent-count";

/*
 * Correction F1/F2 (Codex :36622): the WHOLE request is recognized positively before ownership. The contract's period
 * falls back to the min/max of any year tokens ("before 2000" -> 2000-2000, "2000 and 2020" -> 2000-2020, "past 5 years"
 * -> none), and an exclusion list cannot account for every qualifier ("involving knives"). So the turn must consist
 * ONLY of: wording from the vocabulary below (a lead such as "how many" or "show me", a national geography, "violent
 * crime", annual words such as "by year") plus EXACTLY ONE supported period form, parsed here:
 *   none | since/from/starting [in] YYYY [to/through/until present|now|today] | YYYY-present |
 *   [from] YYYY to/through/thru/until/-/– YYYY | between YYYY and YYYY | [in] YYYY (that single year)
 * Any other word -- before/after, past/last N, a second year joined by "and", a weapon, a rate, a place, a filter --
 * leaves the request exactly as written for its existing route. This is a recognizer of one bounded family, not a
 * general time parser.
 */
type Period = { startYear: number | null; endYear: number | null };
const Y = String.raw`((?:18|19|20)\d{2})`;
const PRESENT = String.raw`(?:the\s+)?(?:present|now|today|current\s+year)`;
const PERIOD_FORMS: { re: RegExp; read: (m: RegExpExecArray) => Period }[] = [
  { re: new RegExp(String.raw`\bbetween\s+${Y}\s+and\s+${Y}\b`, "i"), read: (m) => ({ startYear: +m[1], endYear: +m[2] }) },
  { re: new RegExp(String.raw`\b(?:since|from|starting(?:\s+in)?|beginning(?:\s+in)?)\s+${Y}\s*(?:(?:-|–|—|to|through|thru|until|till)\s*${PRESENT})?(?![\s\S]*\d)`, "i"), read: (m) => ({ startYear: +m[1], endYear: null }) },
  { re: new RegExp(String.raw`\b${Y}\s*(?:-|–|—|to|through|thru|until|till)\s*${PRESENT}\b`, "i"), read: (m) => ({ startYear: +m[1], endYear: null }) },
  { re: new RegExp(String.raw`(?:\bfrom\s+)?\b${Y}\s*(?:-|–|—|\bto\b|\bthrough\b|\bthru\b|\buntil\b|\btill\b)\s*${Y}\b`, "i"), read: (m) => ({ startYear: +m[1], endYear: +m[2] }) },
  { re: new RegExp(String.raw`(?:\b(?:in|for|during)\s+)?\b${Y}\b`, "i"), read: (m) => ({ startYear: +m[1], endYear: +m[1] }) },
];

// Every word a supported request may use outside its period. "united states" is consumed as a phrase first, so a bare
// "states" ("all states", "which states") is NOT accepted.
const PHRASES = [/\bunited\s+states(?:\s+of\s+america)?\b/gi, /\bu\.\s*s\.(?:\s*a\.)?/gi, /\bthe\s+(?:country|nation|us)\b/gi, /\bper\s+year\b/gi, /\bover\s+time\b/gi, /\bnumber\s+of\b/gi];
const VOCABULARY = new Set([
  "how", "many", "what", "was", "were", "is", "are", "has", "have", "the", "show", "me", "give", "can", "could", "i", "we", "see",
  "list", "get", "total", "totals", "number", "numbers", "of", "annual", "annually", "yearly", "each", "every", "by", "year",
  "years", "trend", "trends", "in", "for", "a", "all", "data", "count", "counts", "statistics", "stats", "figures", "there",
  "reported", "national", "nationally", "nationwide", "us", "usa", "america", "american", "across", "violent", "crime", "crimes",
  "offenses", "offences", "please", "series", "levels", "level", "look", "like", "been",
]);

/** The request's single supported period, or undefined when the turn is not wholly this family. */
function wholeRequestPeriod(question: string): Period | undefined {
  let rest = ` ${question} `;
  let period: Period = { startYear: null, endYear: null };
  for (const form of PERIOD_FORMS) {
    const m = form.re.exec(rest);
    if (!m) continue;
    period = form.read(m);
    rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
    break;
  }
  if (/\d/.test(rest)) return undefined;                       // a second year, a count ("past 5"), a figure
  for (const p of PHRASES) rest = rest.replace(p, " ");
  const words = rest.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.every((w) => VOCABULARY.has(w))) return undefined;
  if (!words.some((w) => w === "violent")) return undefined;
  if (period.startYear !== null && period.endYear !== null && period.endYear < period.startYear) return undefined;
  return period;
}

export function buildHistoricalNationalViolentCountPlan(question: string): HistoricalCityChangePlan | null {
  const contract = buildQueryContract(question, "historical");
  if (!contract) return null;
  if (contract.geography.kind !== "national") return null;
  if (Array.isArray(contract.geographies) && contract.geographies.length > 1) return null;
  if (contract.metric.topic !== "violent_crime" || contract.metric.unit !== "count") return null;
  if (contract.metric.offenses.length !== 1 || contract.metric.offenses[0].topic !== "violent_crime") return null;
  if (contract.breakdowns.some((b) => b !== "year")) return null;
  if (contract.time.partialYear) return null;
  const period = wholeRequestPeriod(question);
  if (!period) return null;

  const { startYear, endYear } = period;
  const bounds = startYear !== null && endYear !== null
    ? ` AND year BETWEEN ${startYear} AND ${endYear}`
    : startYear !== null ? ` AND year >= ${startYear}` : "";
  const sql = `SELECT year, murder + rape + robbery + aggravated_assault AS violent_crime FROM historical_state_national WHERE state = 'United States'${bounds} ORDER BY year`;

  return {
    sql,
    title: "U.S. Violent Crime by Year",
    // Replaced after execution by the owned composite description (historicalViolentComposite) and the row-derived
    // disclosures; this text is only what a no-query decline would say.
    explanation: "U.S. national violent crime by year.",
    columns: ["year", "violent_crime"],
    chartConfig: { type: "line", xAxis: "year", yAxis: ["violent_crime"], title: "U.S. Violent Crime by Year", yAxisLabel: "Violent crimes" },
    chartMeta: { source: "FBI SRS", agencyCount: 0, population: null },
    guardrail: "deterministic-historical-national-violent-count",   // literal: the taxonomy enumerates families by it (= NATIONAL_VIOLENT_COUNT_GUARDRAIL)
  };
}

/** The owned decline when the national plan cannot establish its result. It never hands the request to model SQL. */
export const NATIONAL_VIOLENT_COUNT_UNAVAILABLE =
  "I can't show the U.S. national violent crime series right now: the national figures could not be read. " +
  "I won't substitute a sum of individual agencies, which is not a national count.";

/** The same plan with no query: the route's existing no-query branch delivers it as the owned decline. */
export function nationalViolentDeclinePlan(plan: HistoricalCityChangePlan): HistoricalCityChangePlan {
  return { ...plan, sql: null, explanation: NATIONAL_VIOLENT_COUNT_UNAVAILABLE, chartConfig: null };
}
