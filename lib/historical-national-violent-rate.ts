import type { HistoricalCityChangePlan } from "./historical-deterministic-queries";

/**
 * GC-010 batch (Codex next-batch selection, handoff :37439; Jeff's grant audit/phase3-gc010-2026-10-07/grant.txt).
 *
 * WHY THIS EXISTS. "Please show me a graph of the violent crime rate back to 1930 and also the U.S. prison population going
 * back that far (or as far as possible)" was refused WHOLE: the court-process referent policy (lib/clearance-referent.ts)
 * read "prison population" as the subject of the request and the Historical no-SQL exit delivered its court refusal. The
 * violent-crime half is answerable from the national table; only the prison half is not.
 *
 * OWNED FAMILY (recognized positively from the WHOLE turn, never by keyword): the Historical U.S. national annual
 * violent-crime RATE series --
 *   - alone, when the turn itself says the series is national ("U.S.", "national", "nationwide", "in the United States"); or
 *   - paired with the U.S. prison population, in either order. Jeff's interpretation (grant): in that compound both clauses
 *     are U.S. national when the turn names no other place -- the saved request puts "U.S." only on the prison clause.
 * Each clause carries its own period; the crime clause's period is the statement's period. Any other wording -- a state,
 * city or agency, another offense, a count, a filter (weapon, demographic), a comparison, a before/relative/single-year
 * form, or anything the grammar below does not read -- is not this family and keeps its existing route unchanged.
 *
 * SOURCE AND MEANING: the national table with a positive `state = 'United States'` restriction and the four FBI UCR
 * component RATES per 100,000, summed. A plain sum, so a year missing any component returns no value (never a zero); the
 * existing composite description (lib/historical-composite-measure.ts, kind "rate") names the measure from the SQL binding,
 * and the existing disclosures report the years actually returned against the years requested. No count is used, no
 * agency is summed, and no prison figure is produced: the prison half gets its own limitation in the same answer.
 */
export const NATIONAL_VIOLENT_RATE_GUARDRAIL = "deterministic-historical-national-violent-rate";

export const PRISON_POPULATION_LIMITATION =
  "The U.S. prison population is not in these datasets: they record crimes reported to law enforcement, not incarceration " +
  "or other court and corrections outcomes. So no prison series is shown for any period, and nothing in this answer stands in for it.";

export const NATIONAL_VIOLENT_RATE_UNAVAILABLE =
  "I can't show the U.S. national violent crime rate series right now: the national figures could not be read. " +
  "I won't substitute a rate built from individual agencies, which is not a national rate.";

type Period = { startYear: number | null; endYear: number | null };
export type NationalViolentRateRequest = { period: Period; prison: boolean; crimeClause: string };

const Y = String.raw`((?:18|19|20)\d{2})`;
const PRESENT = String.raw`(?:the\s+)?(?:present|now|today|current\s+year)`;
const AS_FAR = String.raw`(?:as\s+far(?:\s+back)?\s+as\s+(?:possible|you\s+can|available|the\s+data\s+goes))`;
const NATIONAL_WORD = String.raw`(?:u\.?\s*s\.?|us|united\s+states|national|nationwide|american|the\s+nation'?s|the\s+country'?s)`;
const NATIONAL_PLACE = String.raw`(?:in|for|across)\s+(?:the\s+)?(?:u\.?\s*s\.?|us|united\s+states|nation|country)`;

/** The crime clause's period forms. Each returns its period; anything else is not read. */
const PERIODS: { re: string; read: (m: string[]) => Period }[] = [
  { re: String.raw`(?:going\s+)?back\s+to\s+${Y}`, read: (m) => ({ startYear: +m[0], endYear: null }) },
  { re: String.raw`(?:since|starting(?:\s+in)?|beginning(?:\s+in)?)\s+${Y}`, read: (m) => ({ startYear: +m[0], endYear: null }) },
  { re: String.raw`from\s+${Y}\s+(?:to|through|thru|until|till|-|–)\s+${PRESENT}`, read: (m) => ({ startYear: +m[0], endYear: null }) },
  { re: String.raw`${Y}\s*(?:-|–|to|through|thru|until|till)\s*${PRESENT}`, read: (m) => ({ startYear: +m[0], endYear: null }) },
  { re: String.raw`(?:from\s+)?${Y}\s*(?:-|–|to|through|thru|until|till)\s*${Y}`, read: (m) => ({ startYear: +m[0], endYear: +m[1] }) },
  { re: String.raw`between\s+${Y}\s+and\s+${Y}`, read: (m) => ({ startYear: +m[0], endYear: +m[1] }) },
  { re: AS_FAR, read: () => ({ startYear: null, endYear: null }) },
];

const LEAD = String.raw`(?:(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:show|give|plot|graph|chart|make|draw|create|display)(?:\s+me)?(?:\s+(?:a|the))?(?:\s+(?:graph|chart|plot|line\s+chart|line\s+graph)\s+(?:of|showing))?\s+)?`;
const RATE = String.raw`violent\s+crime\s+rates?(?:\s+per\s+100,?000(?:\s+(?:people|residents|population))?)?`;
const ANNUAL = String.raw`(?:\s+(?:by\s+year|per\s+year|each\s+year|annually|over\s+time))?`;
// The prison clause: the U.S. prison population, optionally with its own period (it is not delivered for any period).
const PRISON_PERIOD = String.raw`(?:going\s+back\s+that\s+far|back\s+that\s+far|for\s+the\s+same\s+(?:years|period)|over\s+the\s+same\s+(?:years|period)|(?:going\s+)?back\s+to\s+${Y}|since\s+${Y}|from\s+${Y}\s+(?:to|through|-|–)\s+(?:${PRESENT}|${Y})|${AS_FAR}|too|as\s+well)`;
const PRISON = String.raw`(?:the\s+)?(?:(${NATIONAL_WORD})\s+)?prison\s+population(?:\s+(?:in|for)\s+the\s+(?:u\.?\s*s\.?|us|united\s+states|nation|country))?(?:\s+(?:or\s+)?${PRISON_PERIOD})*`;
const JOIN = String.raw`\s*,?\s+(?:and|plus|along\s+with|together\s+with)\s+(?:also\s+)?(?:show\s+(?:me\s+)?)?`;

const normalize = (q: string) => q
  .replace(/[()]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/[.!?]+$/, "")
  .trim();

/** The crime clause, read whole: [the] [national word] violent crime rate [per 100,000] [in the U.S.] [annual] [period] [or as far as possible]. */
function readCrimeClause(clause: string): { national: boolean; period: Period } | null {
  for (const p of [...PERIODS.map((x) => ({ ...x, re: String.raw`\s+${x.re}` })), { re: "", read: (): Period => ({ startYear: null, endYear: null }) }]) {
    const re = new RegExp(String.raw`^(?:the\s+)?(?:(${NATIONAL_WORD})\s+)?(?:annual\s+|yearly\s+)?${RATE}(?:\s+(${NATIONAL_PLACE}))?${ANNUAL}${p.re}(?:\s+(?:or\s+)?${AS_FAR})?$`, "i");
    const m = re.exec(clause);
    if (!m) continue;
    const years = m.slice(3).filter((x) => x !== undefined && /^\d{4}$/.test(x));
    const period = p.read(years);
    if (period.startYear !== null && period.endYear !== null && period.endYear < period.startYear) return null;
    return { national: Boolean(m[1] || m[2]), period };
  }
  return null;
}

/** The whole turn as one of the supported forms, or null (not this family). */
export function recognizeNationalViolentRate(question: string): NationalViolentRateRequest | null {
  const turn = normalize(question);
  const crimeFirst = new RegExp(String.raw`^${LEAD}(.+?)${JOIN}(${PRISON})$`, "i").exec(turn);
  const prisonFirst = new RegExp(String.raw`^${LEAD}(${PRISON})${JOIN}(.+)$`, "i").exec(turn);
  const alone = new RegExp(String.raw`^${LEAD}(.+)$`, "i").exec(turn);
  const tries: { crime: string; prison: string | null; prisonNational: string | undefined }[] = [];
  if (crimeFirst) tries.push({ crime: crimeFirst[1], prison: crimeFirst[2], prisonNational: crimeFirst[3] });
  if (prisonFirst) tries.push({ crime: prisonFirst[prisonFirst.length - 1], prison: prisonFirst[1], prisonNational: prisonFirst[2] });
  if (alone) tries.push({ crime: alone[1], prison: null, prisonNational: undefined });
  for (const t of tries) {
    const crime = readCrimeClause(t.crime.trim());
    if (!crime) continue;
    const prisonNational = t.prison !== null && (Boolean(t.prisonNational) || /\b(?:in|for)\s+the\s+(?:u\.?\s*s\.?|us|united\s+states|nation|country)\b/i.test(t.prison));
    // Standalone: the crime clause must say national. Compound: either clause may (Jeff's interpretation); no other place
    // can appear, because the grammar admits no other place.
    if (t.prison === null ? !crime.national : !(crime.national || prisonNational)) continue;
    return { period: crime.period, prison: t.prison !== null, crimeClause: t.crime.trim() };
  }
  return null;
}

export function buildHistoricalNationalViolentRatePlan(question: string): HistoricalCityChangePlan | null {
  const request = recognizeNationalViolentRate(question);
  if (!request) return null;
  const { startYear, endYear } = request.period;
  const bounds = startYear !== null && endYear !== null
    ? ` AND year BETWEEN ${startYear} AND ${endYear}`
    : startYear !== null ? ` AND year >= ${startYear}` : "";
  const sql = "SELECT year, ROUND(murder_rate + rape_rate + robbery_rate + aggravated_assault_rate, 1) AS violent_crime_rate " +
    `FROM historical_state_national WHERE state = 'United States'${bounds} ORDER BY year`;
  return {
    sql,
    title: "U.S. Violent Crime Rate by Year",
    // Replaced after execution by the owned composite description and the row-derived disclosures (route).
    explanation: "U.S. national violent crime rate by year.",
    columns: ["year", "violent_crime_rate"],
    chartConfig: { type: "line", xAxis: "year", yAxis: ["violent_crime_rate"], title: "U.S. Violent Crime Rate by Year", yAxisLabel: "Violent crimes per 100,000" },
    chartMeta: { source: "FBI SRS", agencyCount: 0, population: null },
    guardrail: "deterministic-historical-national-violent-rate",   // literal: the taxonomy enumerates families by it (= NATIONAL_VIOLENT_RATE_GUARDRAIL)
  };
}

/**
 * GC-010 correction r1 (Codex :37470, P2): the text the row-derived disclosures read for the RATE series -- the recognized
 * crime clause alone. The disclosures parse requested dates from the question they are given; given the whole compound turn
 * they took the PRISON clause's period ("requested 1980") for a statement that ran the crime clause's period. Every rate-period
 * disclosure is therefore bound to the clause that produced the statement; the prison limitation keeps the original request.
 */
export function nationalViolentRateDisclosureQuestion(question: string): string | null {
  return recognizeNationalViolentRate(question)?.crimeClause ?? null;
}

/** The prison-half limitation for a recognized compound request, appended after the disclosure chokepoint. */
export function nationalViolentRateLimitation(question: string): string | null {
  return recognizeNationalViolentRate(question)?.prison ? PRISON_POPULATION_LIMITATION : null;
}

/** When the national table returns NO rows for the requested years: absence stated as such (never a zero), by the period read. */
export function nationalViolentRateEmptyNote(question: string): string | null {
  const request = recognizeNationalViolentRate(question);
  if (!request) return null;
  const { startYear, endYear } = request.period;
  const years = startYear !== null && endYear !== null ? `${startYear}–${endYear}` : startYear !== null ? `${startYear} onward` : "any year";
  return `No U.S. national violent crime rate values were returned for ${years}: the national table holds none for those years, so no rate is shown.`;
}

/** The owned decline when the rate series cannot be read: never model SQL; the prison limitation is kept. */
export function nationalViolentRateDeclinePlan(plan: HistoricalCityChangePlan, question: string): HistoricalCityChangePlan {
  const limitation = nationalViolentRateLimitation(question);
  return { ...plan, sql: null, explanation: [NATIONAL_VIOLENT_RATE_UNAVAILABLE, limitation].filter(Boolean).join(" "), chartConfig: null };
}
