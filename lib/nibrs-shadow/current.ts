/**
 * Current Trends (design note docs/superpowers/specs/2026-11-03-current-trends-design.md; P90, P91; Jeff's decisions
 * A-C, 2026-11-03): Part I offenses by month for an agency, a state, a Census region or the nation, read from the Crime
 * Index build's current_crime (2025-01 on) and current_final (the Final panel: an agency's months before 2025, decision
 * A), never from the app's live tables and never from NIBRS.
 *
 *   agency      its own monthly cells; a month with no row or a blank cell is unknown, never zero
 *   group       a state, region or the nation: the sum over its Consistent Reporting Agencies (the month's `sample`
 *               agencies, P91), blank cells left out and counted, null only when every cell is blank; agencies and
 *               population are the month's; before 2025 a group is not answered (decision A: no cohort rule yet)
 *   cumulative  the year to date and the rolling 12 months are sums of known months, and blank when any month in them
 *               is unknown (design note section 3: the published *_ytd and *_roll can span unknown months)
 *   change      from two complete values; blank when either is unknown or the earlier is zero (P55)
 *   rate        count / current population x 100,000 (decision B, P58, P59): every month known, never one month,
 *               never with a missing or zero population
 */
import { carriesTo } from "./population-carry";
import fs from "node:fs";
import path from "node:path";
import type { ResultTable } from "../nibrs-plan/result";
import { truncatedTieSentence } from "../nibrs-plan/transforms";
import type { Meaning } from "../answer-eval/case";
import { CITY_AS, cityNameSql, citySql, HISTORICAL_MEASURE } from "./historical";
import { stateName } from "./places";
import { fmt, runs } from "./deliver";
import { aboutPeople } from "./presentation";
import { periodTitle, titleCase } from "./titles";
import { agencySubject, changeSentence, countSentence, nationSubject, rateSentence, seriesTitle, titleTimeframe, type Subject } from "./headline";

/** The cohort sentence; the people clause only when the population is known (the final panel before 2025 has none, so never "roughly 0 people"). */
const cohortSentence = (agencies: number, population: number | null | undefined, from: string, to: string): string =>
  `This counts only the ${fmt(agencies)} Consistent Reporting ${agencies === 1 ? "Agency" : "Agencies"}${population && population > 0 ? `, covering roughly ${aboutPeople(population)} people,` : ""} that reported every month from ${monthWords(from)} through ${monthWords(to)}.`;

/** A place as the subject of a sentence: an agency short ("Detroit"), the nation "The United States", a state or region by its label. */
const subjectOf = (p: CurrentPlace): Subject => (p.kind === "agency" ? agencySubject(p.label, p.ori) : p.states === null ? nationSubject : { text: p.label });
/** The months of a series in a title: "2025" for whole January-to-December, else "January 2025 to September 2026". */
const spanTitle = (a: string, b: string) => (a.endsWith("-01") && b.endsWith("-12") && a.slice(0, 4) === b.slice(0, 4) ? a.slice(0, 4) : a === b ? monthWordsOf(a) : `${monthWordsOf(a)} to ${monthWordsOf(b)}`);
const monthWordsOf = (m: string) => `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;

/** Where the Crime Index build's Current Trends tables are, and the months they hold. */
export type CurrentBuild = { root: string; release: string; firstMonth: string; lastMonth: string; finalFirstMonth: string };
/** The build at `root` when its manifest has current_crime; undefined otherwise. */
export function currentBuildAt(root: string | undefined, execute: (sql: string) => unknown[][]): CurrentBuild | undefined {
  if (!root) return undefined;
  const file = path.join(root, "manifest.json");
  if (!fs.existsSync(file)) return undefined;
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as { release: string; inputs: Record<string, unknown> };
  if (!m.inputs.current_crime) return undefined;
  const r = root.replace(/\\/g, "/");
  const span = (t: string) => execute(`SELECT min(year * 100 + month), max(year * 100 + month) FROM read_parquet('${r}/${t}.parquet')`)[0].map(Number);
  const ym = (n: number) => `${Math.floor(n / 100)}-${String(n % 100).padStart(2, "0")}`;
  const [first, last] = span("current_crime"), [ffirst] = span("current_final");
  return { root: r, release: m.release, firstMonth: ym(first), lastMonth: ym(last), finalFirstMonth: ym(ffirst) };
}

/** The reader's Part I measures -> the build's column stem (the Final panel has no violent or property sums). */
export const CURRENT_MEASURE: Record<string, string> = {
  murder: "murder", homicide: "murder", homicide_all: "murder", rape: "rape", robbery: "robbery", aggravated_assault: "assault", burglary: "burglary",
  theft: "theft", motor_vehicle_theft: "motor", violent_crime: "violent", property_crime: "property",
};
const PARTS: Record<string, string[]> = { violent: ["murder", "rape", "robbery", "assault"], property: ["burglary", "theft", "motor"] };

/** Census regions (as nibrs-model's correctness/current_trends.py and the site's group rows). */
export const REGIONS: Record<string, { name: string; states: string[] }> = {
  noe: { name: "the Northeast", states: "CT ME MA NH RI VT NJ NY PA".split(" ") },
  mdw: { name: "the Midwest", states: "IL IN MI OH WI IA KS MN MO NE ND SD".split(" ") },
  sth: { name: "the South", states: "DE DC FL GA MD NC SC VA WV AL KY MS TN AR LA OK TX".split(" ") },
  wst: { name: "the West", states: "AZ CO ID MT NV NM UT WY AK CA HI OR WA".split(" ") },
};

export type Month = string; // "2026-08"
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
export function months(from: Month, to: Month): Month[] {
  const out: Month[] = [];
  for (let y = Number(from.slice(0, 4)), m = Number(from.slice(5)); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) out.push(`${y}-${String(m).padStart(2, "0")}`);
  return out;
}

/**
 * An agency's monthly counts, `null` for an unknown month. From 2025-01 the snapshot's cells; before, the Final panel's
 * (violent and property as the sum of their parts there, null when any part is blank: the panel publishes no sums).
 */
export function agencyMonths(b: CurrentBuild, ori: string, measure: string, from: Month, to: Month, execute: (sql: string) => unknown[][]): Map<Month, number | null> {
  const col = CURRENT_MEASURE[measure];
  const out = new Map<Month, number | null>(months(from, to).map((m) => [m, null]));
  const key = "printf('%04d-%02d', year, month)";
  const finalExpr = PARTS[col] ? `CASE WHEN ${PARTS[col].map((p) => `${p}_total IS NULL`).join(" OR ")} THEN NULL ELSE ${PARTS[col].map((p) => `${p}_total`).join(" + ")} END` : `${col}_total`;
  const sql = `SELECT ${key} AS ym, ${col}_total FROM read_parquet('${b.root}/current_crime.parquet') WHERE ori = ${q(ori)} AND ${key} BETWEEN ${q(from)} AND ${q(to)}
    UNION ALL SELECT ${key} AS ym, ${finalExpr} FROM read_parquet('${b.root}/current_final.parquet') WHERE ori = ${q(ori)} AND ${key} BETWEEN ${q(from)} AND ${q(to)} AND ${key} < ${q(b.firstMonth)}`;
  for (const [ym, v] of execute(sql)) if (out.has(String(ym))) out.set(String(ym), num(v));
  return out;
}

export type GroupMonth = { value: number | null; agencies: number; population: number; blank: number; noPop?: number };
/**
 * A group's monthly consistent sums (P91): `states` null for the nation. Months before current_crime's first are not
 * given (decision A: no cohort rule yet); the caller declines them. `forRate`: a sample agency with no population in the month
 * leaves BOTH the count and the population (Jeff's rolling-rate ruling, P281), and is counted in `noPop`.
 */
export function groupMonths(b: CurrentBuild, states: string[] | null, measure: string, from: Month, to: Month, execute: (sql: string) => unknown[][], forRate = false): Map<Month, GroupMonth> {
  const col = CURRENT_MEASURE[measure];
  const key = "printf('%04d-%02d', year, month)";
  const has = "population > 0";
  const sel = forRate
    ? `sum(${col}_total) FILTER (WHERE ${has}), count(*) FILTER (WHERE ${has}), sum(population) FILTER (WHERE ${has}), count(*) FILTER (WHERE ${has} AND ${col}_total IS NULL), count(*) FILTER (WHERE population IS NULL OR population <= 0)`
    : `sum(${col}_total), count(*), sum(population), count(*) FILTER (WHERE ${col}_total IS NULL)`;
  const sql = `SELECT ${key} AS ym, ${sel}
    FROM read_parquet('${b.root}/current_crime.parquet') WHERE sample${states ? ` AND state IN (${states.map(q).join(", ")})` : ""}
    AND ${key} BETWEEN ${q(from)} AND ${q(to)} GROUP BY 1`;
  const out = new Map<Month, GroupMonth>();
  for (const [ym, v, n, pop, blank, noPop] of execute(sql)) out.set(String(ym), { value: num(v), agencies: Number(n), population: Number(pop ?? 0), blank: Number(blank), ...(forRate ? { noPop: Number(noPop ?? 0) } : {}) });
  return out;
}

/**
 * A group's months over a span, from the agencies that have a figure in EVERY month of it (Jeff 2026-11-19: "the national sample is the
 * collection of all consistent agencies that reported"): an agency-month's figure is current_final's, else current_crime's (they agree
 * where both hold it); an agency with a month missing drops out of the span's sample. `states` null for the nation. The
 * `sample` flag is not used. Returns each month's total, the agencies counted and the people they cover (current_crime's latest population).
 */
export function groupSpanMonths(b: CurrentBuild, states: string[] | null, measure: string, from: Month, to: Month, execute: (sql: string) => unknown[][]):
  { values: Map<Month, number | null>; agencies: number; population: number } {
  const col = CURRENT_MEASURE[measure];
  const key = "printf('%04d-%02d', year, month)";
  const finalExpr = PARTS[col] ? `CASE WHEN ${PARTS[col].map((p) => `${p}_total IS NULL`).join(" OR ")} THEN NULL ELSE ${PARTS[col].map((p) => `${p}_total`).join(" + ")} END` : `${col}_total`;
  const where = `${states ? `state IN (${states.map(q).join(", ")}) AND ` : ""}${key} BETWEEN ${q(from)} AND ${q(to)}`;
  const n = months(from, to).length;
  const cte = `WITH u AS (SELECT ori, ${key} AS ym, ${finalExpr} AS v FROM read_parquet('${b.root}/current_final.parquet') WHERE ${where}
      UNION ALL SELECT c.ori, ${key.replace(/year/g, "c.year").replace(/month/g, "c.month")} AS ym, c.${col}_total AS v FROM read_parquet('${b.root}/current_crime.parquet') c
        WHERE ${where.replace(/\byear\b/g, "c.year").replace(/\bmonth\b/g, "c.month").replace(/\bstate\b/g, "c.state")}
        AND NOT EXISTS (SELECT 1 FROM read_parquet('${b.root}/current_final.parquet') f WHERE f.ori = c.ori AND f.year = c.year AND f.month = c.month)),
    full_span AS (SELECT ori FROM u WHERE v IS NOT NULL GROUP BY ori HAVING count(*) = ${n})`;
  const out = new Map<Month, number | null>(months(from, to).map((m) => [m, null]));
  for (const [ym, v] of execute(`${cte} SELECT ym, sum(v) FROM u WHERE ori IN (SELECT ori FROM full_span) GROUP BY ym`)) out.set(String(ym), num(v));
  const head = execute(`${cte} SELECT count(*), coalesce(sum(p.population), 0) FROM full_span s LEFT JOIN (SELECT ori, population FROM read_parquet('${b.root}/current_crime.parquet') WHERE ${key} = ${q(to)}) p USING (ori)`)[0] ?? [0, 0];
  return { values: out, agencies: Number(head[0]), population: Number(head[1] ?? 0) };
}

/** An agency's current population: its row's in `month`, else its latest earlier row's; null when none is above zero. */
export function agencyPopulation(b: CurrentBuild, ori: string, month: Month, execute: (sql: string) => unknown[][]): number | null {
  const r = execute(`SELECT population FROM read_parquet('${b.root}/current_crime.parquet') WHERE ori = ${q(ori)} AND population > 0 AND printf('%04d-%02d', year, month) <= ${q(month)} ORDER BY year DESC, month DESC LIMIT 1`)[0];
  if (r) return Number(r[0]);
  // None yet in Current Trends: the current year takes the latest completed year's population (population-carry.ts).
  const last = completedYear(b, execute);
  return last !== null && carriesTo(Number(month.slice(0, 4)), last) ? completedYearPopulation(b, ori, last, execute) : null;
}
/** The build's latest completed year: the last year Crime Index publishes agency figures for, read from the build. */
function completedYear(b: CurrentBuild, execute: (sql: string) => unknown[][]): number | null {
  const r = execute(`SELECT max(year) FROM read_parquet('${b.root}/agency_crime.parquet')`)[0];
  return r && r[0] !== null && r[0] !== undefined ? Number(r[0]) : null;
}
function completedYearPopulation(b: CurrentBuild, ori: string, last: number, execute: (sql: string) => unknown[][]): number | null {
  const r = execute(`SELECT population FROM read_parquet('${b.root}/agency_crime.parquet') WHERE ori = ${q(ori)} AND year = ${last} AND population > 0`)[0];
  return r ? Number(r[0]) : null;
}
/**
 * Each month's population for an agency's monthly rate (Jeff 2026-11-06, P96): from Current Trends' first month, the
 * month's own row in current_crime only; before it, the agency's population for that same year as Crime Index publishes
 * it (agency_crime). Never another month's or year's: a month without its own population has no rate (Codex
 * monthly-rates review 01.1).
 */
export function agencyMonthPopulations(b: CurrentBuild, ori: string, monthsWanted: Month[], execute: (sql: string) => unknown[][]): Map<Month, number | null> {
  const cur = new Map(execute(`SELECT printf('%04d-%02d', year, month), population FROM read_parquet('${b.root}/current_crime.parquet') WHERE ori = ${q(ori)} AND population > 0`)
    .map((r) => [String(r[0]), Number(r[1])] as [string, number]));
  const yearly = new Map(execute(`SELECT year, population FROM read_parquet('${b.root}/agency_crime.parquet') WHERE ori = ${q(ori)} AND population > 0`)
    .map((r) => [Number(r[0]), Number(r[1])] as [number, number]));
  // The current year's months (the year after the latest completed one) with no population of their own take that
  // completed year's (Jeff 2026-11-14, population-carry.ts); a past month without one keeps no rate (P96).
  const lastYear = completedYear(b, execute) ?? Math.max(0, ...yearly.keys());
  return new Map(monthsWanted.map((m) => {
    const y = Number(m.slice(0, 4));
    const own = m >= b.firstMonth ? cur.get(m) ?? null : yearly.get(y) ?? null;
    return [m, own ?? (m >= b.firstMonth && carriesTo(y, lastYear) ? yearly.get(lastYear) ?? null : null)];
  }));
}
/**
 * A group's rate (decision B; Codex review 01.1): over its sample agencies with every month of the span known for the
 * offense, their count over their summed population (each agency's in the span's last month).
 */
export function groupRateBase(b: CurrentBuild, states: string[] | null, measure: string, from: Month, to: Month, execute: (sql: string) => unknown[][]): { count: number; population: number; agencies: number } | null {
  const col = CURRENT_MEASURE[measure], key = "printf('%04d-%02d', year, month)", n = months(from, to).length;
  const r = execute(`WITH a AS (SELECT ori, count(*) AS rows, count(${col}_total) AS known, sum(${col}_total) AS total, arg_max(population, year * 100 + month) AS pop
      FROM read_parquet('${b.root}/current_crime.parquet') WHERE sample${states ? ` AND state IN (${states.map(q).join(", ")})` : ""} AND ${key} BETWEEN ${q(from)} AND ${q(to)} GROUP BY ori)
    SELECT sum(total), sum(pop), count(*) FROM a WHERE rows = ${n} AND known = ${n} AND pop > 0`)[0];
  return r && Number(r[2]) > 0 ? { count: Number(r[0]), population: Number(r[1]), agencies: Number(r[2]) } : null;
}
/** A sum over months, null when any month in it is unknown; `missing` names those months (design note section 3). */
export function cumulative(values: (number | null)[], ms: Month[]): { value: number | null; missing: Month[] } {
  const missing = ms.filter((_, i) => values[i] === null);
  return { value: missing.length ? null : values.reduce<number>((a, v) => a + (v as number), 0), missing };
}
/** The year to date through `to`: January of its year through `to`. */
export const ytdMonths = (to: Month) => months(`${to.slice(0, 4)}-01`, to);
/** The rolling `n` months through `to` (12 unless another length is named: Jeff 2026-11-05). */
export function rollingMonths(to: Month, n = 12): Month[] {
  const y = Number(to.slice(0, 4)), m = Number(to.slice(5));
  const back = y * 12 + (m - 1) - (n - 1);
  const start = `${Math.floor(back / 12)}-${String((back % 12) + 1).padStart(2, "0")}`;
  return months(start, to);
}
/** The same month a year earlier. */
export const yearEarlier = (m: Month) => `${Number(m.slice(0, 4)) - 1}-${m.slice(5)}`;
import { roundHalfAway1 } from "../round-half-away";
/** Percent change from two complete values, one decimal; null when either is unknown or the earlier is zero (P55). */
export function change(earlier: number | null, later: number | null): number | null {
  if (earlier === null || later === null || earlier === 0) return null;
  return roundHalfAway1(((later - earlier) * 100) / earlier);
}
/** Decision B (P58, P59): count per 100,000, one decimal; null for one month, an unknown count or no population. */
export function currentRate(count: number | null, population: number | null, monthsCovered: number): number | null {
  if (count === null || population === null || population <= 0 || monthsCovered < 1) return null;
  return Math.round((count * 1e6) / population) / 10;
}

/* ------------------------------------------------ the answer ---------------------------------------------------- */

export type CurrentPlace =
  | { kind: "agency"; ori: string; label: string; name: string; state: string }
  | { kind: "group"; states: string[] | null; label: string };
export type CurrentQuestion = {
  measure: string; place: CurrentPlace; from: Month; to: Month;
  /** Several agencies by month (answerCurrentSeveral): `place` is the first, these the others. */
  agencies?: { ori: string; label: string; name: string; state: string }[];
  /** "months": each month; "ytd" / "rolling": one total through `to` (its months computed here); "total": `from` through `to`. */
  form: "months" | "ytd" | "rolling" | "total";
  /** "rate" (decision B): only for a total of two or more months, every month known, and a population above zero. */
  statistic?: "count" | "rate";
  agencyLine?: string;
  /** A line after the agency's (a county answered from its sheriff's office): shown as a note, never as restated. */
  agencyNote?: string;
  /** The rolling window: its length in months, and an average (the window's total over its months) when asked. */
  window?: { months: number; average: boolean };
};
export type CurrentAnswer = {
  kind: "current"; question: CurrentQuestion; period: { from: Month; to: Month }; meaning: Meaning;
  delivered: { table: ResultTable; text: string[] };
  /** Group months: the agencies counted and their population, and how many had no figure (P90, P91). */
  coverage: { month: Month; agencies: number; population: number; blank: number }[];
  read: { tables: string[]; table: string; column: string; release: string };
};
export type CurrentDecline = { kind: "current-decline"; explanation: string };

/**
 * Two spans of months compared (design note section 3; Codex review 01.4): each a complete total, the change and the
 * percent change from them (P55: none from a zero base); either total unknown and there is no change. The published
 * year-to-date change is never used: it is computed the same way for every span.
 */
export function answerCurrentChange(cq: CurrentQuestion, earlier: [Month, Month], later: [Month, Month], b: CurrentBuild, execute: (sql: string) => unknown[][]): CurrentAnswer | CurrentDecline {
  const total = (span: [Month, Month]) => {
    const r = answerCurrent({ ...cq, from: span[0], to: span[1], form: "total", statistic: "count" }, b, execute);
    return r.kind === "current" ? { value: r.delivered.table.rows[0][0] as number, r } : { value: null, why: r.explanation };
  };
  const e = total(earlier), l = total(later);
  if (e.value === null || l.value === null) return { kind: "current-decline", explanation: `${("why" in e ? e.why : "why" in l ? l.why : "") as string} There is no change to give.`.trim() };
  const lr = (l as { r: CurrentAnswer }).r;
  const ch = l.value - e.value, pct = change(e.value, l.value);
  const col = CURRENT_MEASURE[cq.measure], words = WORDS[col];
  const ew = spanWords(...earlier), lw = spanWords(...later);
  const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : "0");
  return { ...lr, period: { from: earlier[0], to: later[1] }, meaning: { ...lr.meaning, period: { from: earlier[0], to: later[1] }, statistic: "change" },
    delivered: { table: { columns: ["earlier", "later", "change", "pct_change"].map((k) => ({ binding: { kind: "statistic" as const, as: `x.${k}` },
      header: k === "earlier" ? ew : k === "later" ? lw : k === "change" ? "Change" : "Percent change" })), rows: [[e.value, l.value, ch, pct]] },
      text: [changeSentence(subjectOf(cq.place), words, fmt(e.value), fmt(l.value), ew, lw, signed(ch), pct),
        ...(pct === null ? ["The percent change cannot be computed from a zero base."] : []), ...lr.delivered.text.slice(1)] } };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthWords = (m: Month) => `${MONTH_NAMES[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const spanWords = (a: Month, b: Month) => (a === b ? monthWords(a) : `${monthWords(a)} through ${monthWords(b)}`);
const WORDS: Record<string, string> = { murder: "murders", rape: "rapes", robbery: "robberies", assault: "aggravated assaults", burglary: "burglaries",
  theft: "larceny-thefts", motor: "motor vehicle thefts", violent: "violent crimes", property: "property crimes" };
const SINGULAR: Record<string, string> = { murder: "murder", rape: "rape", robbery: "robbery", assault: "aggravated assault", burglary: "burglary",
  theft: "larceny-theft", motor: "motor vehicle theft", violent: "violent crime", property: "property crime" };
const ucFirst = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;

export function answerCurrent(cq: CurrentQuestion, b: CurrentBuild, execute: (sql: string) => unknown[][]): CurrentAnswer | CurrentDecline {
  const col = CURRENT_MEASURE[cq.measure];
  if (!col) return { kind: "current-decline", explanation: "Current Trends has violent and property crime and the seven Part I offenses only." };
  const group = cq.place.kind === "group";
  const span = cq.form === "months" || cq.form === "total" ? months(cq.from, cq.to) : cq.form === "ytd" ? ytdMonths(cq.to) : rollingMonths(cq.to, cq.window?.months ?? 12);
  const rate = cq.statistic === "rate";
  // P96 (Jeff 2026-11-06, the single-month rule dropped): a rate for one month, or month by month, is that month's count
  // per 100,000 of the population, not annualized; a total of several months stays the total's (decision B, P59).
  // The months the data holds: an agency's from the Final panel's first, a group's from current_crime's (decision A).
  // A group's months from the Final panel's first too (Jeff 2026-11-19): a span inside the published sample's life (2025-01 on) is the published
  // Consistent Reporting Agencies; a span reaching before 2025 is the agencies with a figure in every month of it.
  const first = b.finalFirstMonth;
  const covered = span.filter((m) => m >= first && m <= b.lastMonth);
  if (group && cq.statistic === "rate" && covered.length && covered[0] < b.firstMonth)
    return { kind: "current-decline", explanation: `A rate for a state or the nation is given from ${monthWords(b.firstMonth)}, the first month of the published Consistent Reporting Agencies, not before it.` };
  const holds = `Current Trends ${group ? "totals" : "figures"} in the data cover ${spanWords(first, b.lastMonth)}`;
  // A cumulative total needs every one of its months (design note, section 3): never the part the data holds.
  if (!covered.length || (cq.form !== "months" && covered.length !== span.length))
    return { kind: "current-decline", explanation: `${holds}, so ${spanWords(span[0], span[span.length - 1])} ${span.length > 1 ? "are" : "is"} outside them.` };
  const where = cq.place.label, words = WORDS[col], one = SINGULAR[col], source = "Source: Crime Index.";
  const head = [...(cq.agencyLine ? [cq.agencyLine] : []), ...(cq.agencyNote ? [cq.agencyNote] : [])];
  const left = span.filter((m) => !covered.includes(m));
  const outside = left.length ? [`${holds}; ${spanWords(left[0], left[left.length - 1])} ${left.length > 1 ? "are" : "is"} outside them.`] : [];
  let values: Map<Month, number | null>;
  let coverage: CurrentAnswer["coverage"] = [];
  let sampleFrom: Month = b.firstMonth, sampleTo: Month = b.lastMonth;
  if (cq.place.kind === "agency") values = agencyMonths(b, cq.place.ori, cq.measure, covered[0], covered[covered.length - 1], execute);
  else if (covered[0] >= b.firstMonth) {
    const g = groupMonths(b, cq.place.states, cq.measure, covered[0], covered[covered.length - 1], execute);
    values = new Map(covered.map((m) => [m, g.get(m)?.value ?? null]));
    coverage = covered.flatMap((m) => { const x = g.get(m); return x ? [{ month: m, ...x }] : []; });
  } else {
    // The span reaches before the published sample: the agencies with a figure in every month of it, one set for the whole span.
    const g = groupSpanMonths(b, cq.place.states, cq.measure, covered[0], covered[covered.length - 1], execute);
    if (!g.agencies) return { kind: "current-decline", explanation: `No agency has a figure in every month from ${monthWords(covered[0])} through ${monthWords(covered[covered.length - 1])}, so there is no total to give.` };
    values = g.values;
    coverage = covered.map((m) => ({ month: m, agencies: g.agencies, population: g.population, blank: 0 }));
    sampleFrom = covered[0]; sampleTo = covered[covered.length - 1];
  }
  const vals = covered.map((m) => values.get(m) ?? null);
  // Agencies with no figure in a group's month are left out of its total and named (Codex design check 01.2).
  // The same count every month is said once (redesign test, coordinator 2026-11-04: "January 2025 (5 of 547), February
  // 2025 (5 of 547) ..."); otherwise each month with its own.
  const gaps = coverage.filter((c) => c.blank > 0);
  const same = gaps.length > 1 && gaps.length === coverage.length && gaps.every((c) => c.blank === gaps[0].blank && c.agencies === gaps[0].agencies);
  const leftOut = same ? [`${fmt(gaps[0].blank)} of ${fmt(gaps[0].agencies)} in every month`] : gaps.map((c) => `${monthWords(c.month)} (${fmt(c.blank)} of ${fmt(c.agencies)})`);
  // P90's sentence, in the shared wording: the agencies counted and the people they cover, as of the latest month shown.
  const lastCov = coverage[coverage.length - 1];
  const cohortLine = lastCov ? [cohortSentence(lastCov.agencies, lastCov.population, sampleFrom, sampleTo)] : [];
  const leftOutLine = leftOut.length ? [`Agencies with no ${one} figure are left out of the total: ${leftOut.join(", ")}.`] : [];
  const tables = [...(covered[0] < b.firstMonth ? ["current_final"] : []), ...(covered[covered.length - 1] >= b.firstMonth ? ["current_crime"] : [])];
  const read = { tables, table: tables.join(" + "), column: `${col}_total`, release: b.release };
  const period = { from: covered[0], to: covered[covered.length - 1] };
  const hm = HISTORICAL_MEASURE[cq.measure];
  const places: Meaning["places"] = cq.place.kind === "agency" ? [{ kind: "agency", name: cq.place.name, state: cq.place.state }]
    : cq.place.states === null ? [{ kind: "national", name: "United States" }] : cq.place.states.map((st) => ({ kind: "state" as const, name: stateName(st), state: st }));
  const meaning = (groupings: string[]): Meaning => ({ source: "rtci", places, period, measures: [{ name: hm.name, unit: hm.unit }], filters: [], groupings, statistic: rate ? "rate" : "count",
    ...(rate ? { denominator: group ? "the summed current population of the agencies counted, per 100,000" : "the agency's current population, per 100,000" } : {}),
    ...(group ? { cohort: "same_agencies" as const } : {}), ...(places.length > 1 ? { combine: "combined" as const } : {}) });
  if (cq.form !== "months") {
    const c = cumulative(vals, covered);
    const sw = spanWords(period.from, period.to);
    const wn = cq.window?.months ?? 12;
    const what = cq.form === "ytd" ? `in the year to date, ${sw}` : cq.form === "rolling" ? `in the ${wn} months from ${sw}` : covered.length === 1 ? `in ${sw}` : `from ${sw}`;
    const whatTotal = cq.form === "ytd" ? `the year to date (${sw})` : cq.form === "rolling" ? `the ${wn} months from ${sw}` : sw;
    if (c.value === null) return { kind: "current-decline", explanation: `Crime Index has no ${one} figure for ${where} in ${c.missing.map(monthWords).join(", ")}, so there is no total for ${whatTotal}.` };
    // A rolling average (Jeff 2026-11-05: "Answer the average"): the window's total over its months, said as a monthly
    // average, with the total beside it; never shown as the total. Of counts only.
    if (cq.form === "rolling" && cq.window?.average) {
      if (rate) return { kind: "current-decline", explanation: `A rolling average is of counts; ask for the ${one} rate over the ${wn} months instead.` };
      const avg = Math.round((10 * c.value) / wn) / 10;
      return { kind: "current", question: cq, period, meaning: meaning([]), coverage, read,
        delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header: `${ucFirst(words)}, average per month over ${wn} months` }], rows: [[avg]] },
          text: [`${subjectOf(cq.place).text} averaged ${avg.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${words} a month ${what}.`, `That is ${fmt(c.value)} in all.`, ...head, ...cohortLine, ...leftOutLine, source] } };
    }
    if (rate) {
      // The population: the agency's in the span's last month; a group's, its counted agencies' summed population then.
      // An agency: its count over its current population. A group: only its agencies with every month known (Codex 01.1).
      const base = cq.place.kind === "agency" ? { count: c.value, population: agencyPopulation(b, cq.place.ori, period.to, execute), agencies: 1 }
        : groupRateBase(b, cq.place.states, cq.measure, period.from, period.to, execute);
      const r = base ? currentRate(base.count, base.population, covered.length) : null;
      if (r === null || !base) return { kind: "current-decline", explanation: `Crime Index gives no population for ${where} in ${monthWords(period.to)}, so there is no rate.` };
      const rateLine = cq.place.kind === "group" ? [`The rate counts the ${fmt(base.agencies)} Consistent Reporting ${base.agencies === 1 ? "Agency" : "Agencies"} with a ${one} figure for every month, ${fmt(base.count)} ${words} among roughly ${aboutPeople(base.population!)} people.`] : [];
      return { kind: "current", question: cq, period, meaning: meaning([]), coverage, read,
        delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header: `${ucFirst(words)} per 100,000` }], rows: [[r]] },
          text: [rateSentence(subjectOf(cq.place), one, what.replace(/^(?:in|from) /, ""), r.toFixed(1), /^from /.test(what) ? "from" : "in"), "Not scaled to a full year.", ...head, ...(cq.place.kind === "agency" ? [`That is ${fmt(base.count)} ${words}.`] : rateLine), ...cohortLine, source] } };
    }
    return { kind: "current", question: cq, period, meaning: meaning([]), coverage, read,
      delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header: ucFirst(words) }], rows: [[c.value]] },
        text: [countSentence(subjectOf(cq.place), fmt(c.value), words, what.replace(/^(?:in|from) /, ""), /^from /.test(what) ? "from" : "in"), ...head, ...cohortLine, ...leftOutLine, source] } };
  }
  // P96: month by month, each month's count per 100,000 of that month's population, not annualized. A group's month has a
  // rate only when every agency counted has a figure (its population covers them all).
  if (rate) {
    const pops = cq.place.kind === "agency" ? agencyMonthPopulations(b, cq.place.ori, covered, execute) : null;
    const rates = covered.map((m, i) => {
      if (cq.place.kind === "agency") return currentRate(vals[i], pops!.get(m) ?? null, 1);
      const c = coverage.find((x) => x.month === m);
      return c && c.blank === 0 ? currentRate(vals[i], c.population, 1) : null;
    });
    const noRate = covered.filter((_, i) => rates[i] === null).map(monthWords);
    const rateCols: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "time.month" }, header: "Month", ordered: true },
      { binding: { kind: "statistic", as: "x" }, header: `${ucFirst(words)} per 100,000 for the month` }];
    return { kind: "current", question: cq, period, meaning: meaning(["month"]), coverage, read,
      delivered: { table: { columns: rateCols, rows: covered.map((m, i) => [m, rates[i]]) },
        text: [covered.length === 1 && rates[0] !== null
          ? rateSentence(subjectOf(cq.place), one, monthWords(covered[0]), rates[0]!.toFixed(1))
          : seriesTitle(spanTitle(period.from, period.to), titleCase(`${one} rate`), "Month", where), ...head, ...cohortLine, ...outside,
          ...(noRate.length ? [`No rate for ${noRate.join(", ")}: ${group ? "an agency counted had no figure or there was no population" : "no figure or no population"}, shown blank.`] : []), source] } };
  }
  const blanks = covered.filter((_, i) => vals[i] === null).map(monthWords);
  const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "time.month" }, header: "Month", ordered: true }, { binding: { kind: "statistic", as: "x" }, header: ucFirst(words) }];
  return { kind: "current", question: cq, period, meaning: meaning(["month"]), coverage, read,
    delivered: { table: { columns, rows: covered.map((m, i) => [m, vals[i]]) },
      text: [seriesTitle(spanTitle(period.from, period.to), ucFirst(words), "Month", where), ...head, ...cohortLine, ...outside, ...leftOutLine,
        ...(blanks.length ? [`No figure is available for ${blanks.join(", ")}: shown blank, not zero.`] : []), source] } };
}

/* ------------------------------------------- rankings and sets (2026) ------------------------------------------ */

/**
 * Rankings and "the N largest cities" past Crime Index's last year (Jeff 2026-11-10, ranking decisions 1 and 4): from
 * Current Trends' sample agencies only, said; each agency's total over the months asked (January through the latest
 * month), only agencies with a figure for every one of them ranked (P60), the others counted; population is Current
 * Trends' for the latest month (decision 1); a rate is per 100,000 for the months, not scaled to a full year (P58).
 * "City" is the agency's geography type in Crime Index (agency_crime.type), whatever the agency.
 */
export type CurrentRankQuestion = {
  measure: string; state: string; from: Month; to: Month; statistic: "count" | "rate";
  /** A ranking (top or bottom, cut at the limit), or the N largest by population. */
  pick: { kind: "rank"; direction: "top" | "bottom"; limit: number } | { kind: "largest"; n: number };
  minPopulation: number | null; entity: "city" | "agency" | "county";
  /** The floor came from the question (so the title says it); a default floor is a note. */
  floorAsked?: boolean;
  /** A Census region: its states (`state` is then "US") and its name. */
  region?: { name: string; states: string[] };
};
type CurrentEntry = { ori: string; name: string; state: string; population: number | null; value: number | null; known: boolean };
export function currentEntries(b: CurrentBuild, historicalRoot: string, rq: CurrentRankQuestion, execute: (sql: string) => unknown[][]): { entries: CurrentEntry[]; months: number } {
  const col = CURRENT_MEASURE[rq.measure];
  const ms = months(rq.from, rq.to);
  const f = Number(rq.from.replace("-", "")), t = Number(rq.to.replace("-", ""));
  const national = rq.state === "US";
  const rows = execute(`WITH a AS (SELECT ori, any_value(state) AS state, sum(${col}_total) AS v, count(${col}_total) AS known, `
    + `max(CASE WHEN year * 100 + month = ${t} THEN population END) AS pop FROM read_parquet(${q(`${b.root}/current_crime.parquet`)}) `
    + `WHERE sample AND year * 100 + month BETWEEN ${f} AND ${t}${national ? (rq.region ? ` AND state IN (${rq.region.states.map(q).join(", ")})` : "") : ` AND state = ${q(rq.state)}`} GROUP BY ori), `
    + `n AS (SELECT ori, ${rq.entity === "city" ? cityNameSql() : "name"} AS name, type, row_number() OVER (PARTITION BY ori ORDER BY year DESC) AS k FROM read_parquet(${q(`${historicalRoot}/agency_crime.parquet`)})) `
    + `SELECT a.ori, n.name, a.state, a.pop, a.v, a.known FROM a JOIN n ON n.ori = a.ori AND n.k = 1 WHERE ${rq.entity === "city" ? citySql("n") : rq.entity === "county" ? `n.type = 'county' AND n.ori NOT IN (${[...CITY_AS.drop, ...Object.keys(CITY_AS.asCity)].map(q).join(", ")})` : `n.ori NOT IN (${CITY_AS.drop.map(q).join(", ")})`} ORDER BY a.ori`);
  const entries = rows.map((r) => {
    const pop = num(r[3]), total = num(r[4]), known = Number(r[5]) === ms.length;
    const value = !known ? null : rq.statistic === "rate" ? currentRate(total, pop, ms.length) : total;
    const name = national ? `${String(r[1])}, ${String(r[2])}` : String(r[1]);
    return { ori: String(r[0]), name, state: String(r[2]), population: pop, value, known: value !== null };
  }).filter((e) => !rq.minPopulation || (e.population !== null && e.population >= rq.minPopulation));
  return { entries, months: ms.length };
}
export function answerCurrentRanking(rq: CurrentRankQuestion, b: CurrentBuild, historicalRoot: string, execute: (sql: string) => unknown[][],
  rank: <T extends { name: string; value: number | null; known: boolean }>(xs: T[], dir: "top" | "bottom", limit: number | null) => { ranked: T[]; leftOut: T[]; tie: { position: number; names: string[]; shown: number; value: number; total: number; truncated: boolean } | null }): CurrentAnswer | CurrentDecline {
  const col = CURRENT_MEASURE[rq.measure];
  if (!col) return { kind: "current-decline", explanation: "Current Trends has violent and property crime and the seven Part I offenses only." };
  if (rq.from < b.firstMonth || rq.to > b.lastMonth) return { kind: "current-decline", explanation: `Current Trends covers ${spanWords(b.firstMonth, b.lastMonth)}.` };
  const { entries } = currentEntries(b, historicalRoot, rq, execute);
  const where = rq.region ? rq.region.name : rq.state === "US" ? "the United States" : stateName(rq.state);
  const kindWord = rq.entity === "city" ? "city agencies" : rq.entity === "county" ? "county agencies" : "agencies";
  const unitTitle = rq.entity === "city" ? "City" : rq.entity === "county" ? "County Agency" : "Agency";
  const unitPlural = rq.entity === "city" ? "cities" : kindWord;
  const floor = rq.minPopulation ? ` with a population of ${rq.minPopulation.toLocaleString("en-US")} or more` : "";
  if (!entries.length) return { kind: "current-decline", explanation: `Current Trends' sample has no ${kindWord}${floor} in ${where} for ${spanWords(rq.from, rq.to)}.` };
  const rate = rq.statistic === "rate";
  const span = spanWords(rq.from, rq.to);
  let shown: CurrentEntry[], leftOut: CurrentEntry[], lead: string;
  const extra: string[] = [];
  if (rq.pick.kind === "rank") {
    const r = rank(entries, rq.pick.direction, rq.pick.limit);
    shown = r.ranked; leftOut = r.leftOut;
    const most = rq.pick.direction === "top" ? (rate ? "highest" : "most") : (rate ? "lowest" : "fewest");
    // A title that reads back the question's datapoints (Jeff 2026-11-17), then plain notes (the sample note, ties, who is left out), then the source.
    lead = `${titleCase(where.replace(/^the /i, ""))} ${titleCase(`${SINGULAR[col]} ${rate ? "rate" : "count"}`)} by ${unitTitle}${rq.floorAsked && rq.minPopulation ? `, Population ${rq.minPopulation.toLocaleString("en-US")} or More` : ""}, ${titleTimeframe(periodTitle({ from: rq.from, to: rq.to }, spanWords))}`;
    extra.push(`The ${shown.length} ${unitPlural} with the ${most} ${rate ? "rates" : WORDS[col]} are shown, ${span}.`);
    if (r.tie?.truncated) extra.push(truncatedTieSentence(r.tie, rate));
    else if (r.tie) extra.push(`${r.tie.names.join(", ")} tie for place ${r.tie.position}, so ${r.tie.shown} agencies are shown.`);
  } else {
    // Every city tied with the Nth by population is in the set too (P17; Codex rankings review 01.4).
    const sorted = entries.filter((e) => e.population !== null).sort((x, y) => (y.population! - x.population!) || x.name.localeCompare(y.name));
    const n = rq.pick.n;
    const cutPop = sorted[Math.min(n, sorted.length) - 1]?.population ?? 0;
    const byPop = sorted.filter((e, i) => i < n || e.population === cutPop);
    shown = byPop.filter((e) => e.known); leftOut = byPop.filter((e) => !e.known);
    shown = byPop;
    lead = `${rq.state === "US" && !rq.region ? "United States" : titleCase(where.replace(/^the /i, ""))} ${titleCase(`${SINGULAR[col]} ${rate ? "rate" : "count"}`)} by ${unitTitle}, ${byPop.length} Largest Cities, ${titleTimeframe(periodTitle({ from: rq.from, to: rq.to }, spanWords))}`;
    extra.push(`The cities are the ${byPop.length} largest in Current Trends' sample by population (${monthWords(rq.to)}), ${span}.`);
  }
  if (!shown.length) return { kind: "current-decline", explanation: `No ${kindWord} in Current Trends' sample have a figure for every month of ${span}.` };
  const text = [lead,
    `Only Current Trends' sample agencies are included (about 550 agencies, not every agency), and only those with a figure for every month of ${span} ${rq.pick.kind === "rank" ? "are ranked" : "have a figure"}.`];
  text.push(...extra);
  if (leftOut.length) {
    const names = leftOut.length <= 5 ? leftOut.map((e) => e.name).sort() : null;
    const who = names ? (names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join(" and ")) : `${leftOut.length} ${unitPlural}`;
    const one = !!names && names.length === 1;
    text.push(rq.pick.kind === "rank" ? `${who} ${one ? "isn't" : "aren't"} ranked because a month is missing.` : `${who} ${one ? "is" : "are"} blank because a month is missing.`);
  }
  if (rate) text.push(`Rates are per 100,000 of each agency's population for ${monthWords(rq.to)}, for the months shown; not scaled to a full year.`);
  text.push("Source: Crime Index.");
  const header = rate ? `${ucFirst(SINGULAR[col])} rate per 100,000` : ucFirst(WORDS[col]);
  const period = { from: rq.from, to: rq.to };
  return {
    kind: "current", question: { measure: rq.measure, place: { kind: "group", states: rq.state === "US" ? null : [rq.state], label: where }, from: rq.from, to: rq.to, form: "total", statistic: rq.statistic,
      agencies: shown.map((e) => ({ ori: e.ori, label: e.name, state: e.state })) } as CurrentQuestion,
    period,
    meaning: { source: "rtci", places: [rq.state === "US" ? { kind: "national", name: "United States" } : { kind: "state", name: where, state: rq.state }],
      filters: [`Current Trends' sample ${kindWord}`, ...(floor ? [`population ${rq.minPopulation!.toLocaleString("en-US")} or more`] : [])],
      measures: [{ name: SINGULAR[col], unit: "offense" }], period: { from: rq.from, to: rq.to }, groupings: ["agency"], statistic: rq.pick.kind === "rank" ? "rank" : rate ? "rate" : "count" } as unknown as Meaning,
    delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: "geo.agency" }, header: "Agency" }, { binding: { kind: "statistic", as: "x" }, header }],
      rows: shown.map((e) => [e.name, e.value]) } as unknown as ResultTable, text },
    coverage: [],
    read: { tables: ["current_crime", "agency_crime"], table: "current_crime", column: `${col}_total`, release: b.release },
  };
}

/**
 * Several named agencies by month for a count, from Current Trends (Jeff 2026-11-15: Crime Index by default; one source
 * and one source line for the whole table): a row for each agency and month, each agency's months in order. An agency
 * with no figure for a month is blank there, never 0, and a line says which months.
 */
export function answerCurrentSeveral(cq: { measure: string; places: Extract<CurrentPlace, { kind: "agency" }>[]; from: Month; to: Month; agencyLine?: string; statistic?: "count" | "rate" }, b: CurrentBuild,
  execute: (sql: string) => unknown[][]): CurrentAnswer | CurrentDecline {
  const col = CURRENT_MEASURE[cq.measure];
  if (!col) return { kind: "current-decline", explanation: "Current Trends has violent and property crime and the seven Part I offenses only." };
  if (cq.statistic === "rate") return answerCurrentSeveralRate(cq, col, b, execute);
  const span = months(cq.from, cq.to);
  const covered = span.filter((m) => m >= b.finalFirstMonth && m <= b.lastMonth);
  const holds = `Current Trends figures in the data cover ${spanWords(b.finalFirstMonth, b.lastMonth)}`;
  if (!covered.length) return { kind: "current-decline", explanation: `${holds}, so ${spanWords(span[0], span[span.length - 1])} ${span.length > 1 ? "are" : "is"} outside them.` };
  const words = WORDS[col], one = SINGULAR[col];
  const left = span.filter((m) => !covered.includes(m));
  const outside = left.length ? [`${holds}; ${spanWords(left[0], left[left.length - 1])} ${left.length > 1 ? "are" : "is"} outside them.`] : [];
  const per = cq.places.map((a) => ({ a, values: agencyMonths(b, a.ori, cq.measure, covered[0], covered[covered.length - 1], execute) }));
  const names = cq.places.map((a) => a.label);
  const listed = names.length > 2 ? `${names.slice(0, -1).join("; ")} and ${names[names.length - 1]}` : names.join(" and ");
  const gapLines = per.flatMap(({ a, values }) => {
    const blanks = covered.filter((m) => values.get(m) === null || values.get(m) === undefined);
    return blanks.length ? [`No figure is available for ${blanks.map(monthWords).join(", ")} for ${a.label}: shown blank, not zero.`] : [];
  });
  const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "geo.agency" }, header: "Place" },
    { binding: { kind: "grouping", dimension: "time.month" }, header: "Month", ordered: true }, { binding: { kind: "statistic", as: "x" }, header: ucFirst(words) }];
  const rows = per.flatMap(({ a, values }) => covered.map((m) => [a.name, m, values.get(m) ?? null] as (string | number | null)[]));
  const period = { from: covered[0], to: covered[covered.length - 1] };
  const hm = HISTORICAL_MEASURE[cq.measure];
  const first = cq.places[0];
  return {
    kind: "current", period, coverage: [], read: { tables: ["current_final", "current_crime"], table: "current_final + current_crime", column: `${col}_total`, release: b.release },
    question: { measure: cq.measure, place: first, agencies: cq.places.slice(1), from: cq.from, to: cq.to, form: "months", statistic: "count" },
    meaning: { source: "rtci", places: cq.places.map((a) => ({ kind: "agency" as const, name: a.name, state: a.state })), period, measures: [{ name: hm.name, unit: hm.unit }], filters: [], groupings: ["agency", "month"], statistic: "count" },
    delivered: { table: { columns, rows }, text: [seriesTitle(spanTitle(period.from, period.to), ucFirst(words), "Month", listed), ...(cq.agencyLine ? [cq.agencyLine] : []), ...outside, ...gapLines, "Source: Crime Index."] },
  };
}

/** The most places one monthly-rate answer holds (Jeff 2026-11-18, through the coordinator: a sixth asks to name fewer). */
export const SEVERAL_RATE_LIMIT = 5;

/**
 * Several named agencies by month as a rate (P144): each place's month count per 100,000 of that month's population, one row for
 * each place and month, never scaled to a full year. No notes beyond the exceptions (Jeff 2026-11-18: "a rate is self
 * explanatory"): a month with no figure or no population is blank and named; a place with no population at all is left out
 * with a sentence, and the answer declines only when no place has one.
 */
function answerCurrentSeveralRate(cq: { measure: string; places: Extract<CurrentPlace, { kind: "agency" }>[]; from: Month; to: Month; agencyLine?: string }, col: string,
  b: CurrentBuild, execute: (sql: string) => unknown[][]): CurrentAnswer | CurrentDecline {
  if (cq.places.length > SEVERAL_RATE_LIMIT) return { kind: "current-decline", explanation: `Name up to ${SEVERAL_RATE_LIMIT} places for a monthly rate.` };
  const span = months(cq.from, cq.to);
  const covered = span.filter((m) => m >= b.finalFirstMonth && m <= b.lastMonth);
  const holds = `Current Trends figures in the data cover ${spanWords(b.finalFirstMonth, b.lastMonth)}`;
  if (!covered.length) return { kind: "current-decline", explanation: `${holds}, so ${spanWords(span[0], span[span.length - 1])} ${span.length > 1 ? "are" : "is"} outside them.` };
  const one = SINGULAR[col];
  const left = span.filter((m) => !covered.includes(m));
  const outside = left.length ? [`${holds}; ${spanWords(left[0], left[left.length - 1])} ${left.length > 1 ? "are" : "is"} outside them.`] : [];
  const all = cq.places.map((a) => ({ a, values: agencyMonths(b, a.ori, cq.measure, covered[0], covered[covered.length - 1], execute),
    pops: agencyMonthPopulations(b, a.ori, covered, execute) }));
  const noPop = all.filter((x) => covered.every((m) => x.pops.get(m) == null));
  const per = all.filter((x) => !noPop.includes(x));
  if (!per.length) return { kind: "current-decline", explanation: `Crime Index has no population for ${noPop.map((x) => x.a.label).join(" or ")}, so no rate is given.` };
  const noPopLines = noPop.map((x) => `Crime Index has no population for ${x.a.label}, so no rate is given for it.`);
  const names = per.map((x) => x.a.label);
  const listed = names.length > 2 ? `${names.slice(0, -1).join("; ")} and ${names[names.length - 1]}` : names.join(" and ");
  const rateOf = (x: typeof per[number], m: Month) => currentRate(x.values.get(m) ?? null, x.pops.get(m) ?? null, 1);
  const gapLines = per.flatMap((x) => {
    const blanks = covered.filter((m) => rateOf(x, m) === null);
    return blanks.length ? [`No rate is given for ${blanks.map(monthWords).join(", ")} for ${x.a.label}: shown blank, not zero.`] : [];
  });
  const header = `${ucFirst(one)} rate per 100,000`;
  const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "geo.agency" }, header: "Place" },
    { binding: { kind: "grouping", dimension: "time.month" }, header: "Month", ordered: true }, { binding: { kind: "statistic", as: "x" }, header }];
  const rows = per.flatMap((x) => covered.map((m) => [x.a.name, m, rateOf(x, m)] as (string | number | null)[]));
  const period = { from: covered[0], to: covered[covered.length - 1] };
  const hm = HISTORICAL_MEASURE[cq.measure];
  return {
    kind: "current", period, coverage: [], read: { tables: ["current_final", "current_crime"], table: "current_final + current_crime", column: `${col}_total`, release: b.release },
    question: { measure: cq.measure, place: per[0].a, agencies: per.slice(1).map((x) => x.a), from: cq.from, to: cq.to, form: "months", statistic: "rate" },
    meaning: { source: "rtci", places: per.map((x) => ({ kind: "agency" as const, name: x.a.name, state: x.a.state })), period, measures: [{ name: hm.name, unit: hm.unit }], filters: [], groupings: ["agency", "month"], statistic: "rate" },
    delivered: { table: { columns, rows }, text: [seriesTitle(spanTitle(period.from, period.to), titleCase(`${one} rate`), "Month", listed), ...(cq.agencyLine ? [cq.agencyLine] : []), ...noPopLines, ...outside, ...gapLines, "Source: Crime Index."] },
  };
}

/** The month `n` months after `m` (negative n: before). */
export function shiftMonth(m: Month, n: number): Month {
  const t = Number(m.slice(0, 4)) * 12 + Number(m.slice(5)) - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
/** The first January whose full `w`-month window Current Trends holds (Jeff 2026-11-19: the beginning of the next first full year). */
export function firstFullJanuary(first: Month, w: number): Month {
  const earliest = shiftMonth(first, w - 1);
  return earliest.endsWith("-01") ? earliest : `${Number(earliest.slice(0, 4)) + 1}-01`;
}

/**
 * Rolling totals by month (P154, Jeff 2026-11-19): each month's value is the total of that month and the window - 1 before it, from
 * Current Trends' months; a window with a month that has no figure is blank, never a shorter sum. One place, a state or the nation,
 * or several agencies side by side. The first row is `from` (its window may start before it); no note says what a rolling total is.
 */
export function answerCurrentRolling(cq: { measure: string; places: CurrentPlace[]; from: Month; to: Month; window: number; statistic?: "count" | "rate"; outside?: string; agencyLine?: string }, b: CurrentBuild,
  execute: (sql: string) => unknown[][]): CurrentAnswer | CurrentDecline {
  const col = CURRENT_MEASURE[cq.measure];
  if (!col) return { kind: "current-decline", explanation: "Current Trends has violent and property crime and the seven Part I offenses only." };
  const w = cq.window;
  // A rolling rate (Jeff 2026-11-23, P281): each window's count over the window's month-weighted population (the mean of its months'
  // populations, so each year's population is weighted by its months in the window), per 100,000, one decimal, not annualized.
  const asRate = cq.statistic === "rate";
  if (asRate && cq.places.some((p) => p.kind === "group") && shiftMonth(cq.from, -(w - 1)) < b.firstMonth)
    return { kind: "current-decline", explanation: `A rolling rate for a state or the nation is given from ${monthWords(b.firstMonth)}, the first month of the published Consistent Reporting Agencies, so the ${w}-month windows ending ${spanWords(cq.from, cq.to)} are not all in it.` };
  const to = cq.to > b.lastMonth ? b.lastMonth : cq.to;
  const need = shiftMonth(cq.from, -(w - 1));
  const holds = `Current Trends figures in the data cover ${spanWords(b.finalFirstMonth, b.lastMonth)}`;
  if (need < b.finalFirstMonth || to < cq.from) return { kind: "current-decline", explanation: `${holds}, so the ${w}-month windows ending ${spanWords(cq.from, cq.to)} are not all in them.` };
  const span = months(need, to);
  const per = cq.places.map((p) => {
    let values: Map<Month, number | null>;
    let cov: { agencies: number; population: number; from: Month } | null = null;
    let pops = new Map<Month, number | null>();
    const groupNoPop = new Map<Month, number>();
    if (p.kind === "agency") {
      values = agencyMonths(b, p.ori, cq.measure, need, to, execute);
      if (asRate) pops = agencyMonthPopulations(b, p.ori, span, execute);
    } else {
      if (need >= b.firstMonth) {
        // The windows' whole lookback is inside the published sample's life (2025-01 on): the published Consistent Reporting Agencies
        // (the `sample` flag), so the figure matches crimeindex.org (Jeff 2026-11-19).
        const g = groupMonths(b, p.states, cq.measure, need, to, execute, asRate);
        // A rate needs the count and the population over the same agencies: a sample agency with no population in a month leaves both
        // the count and the population (groupMonths forRate); a month where a remaining agency has no figure is blank.
        for (const [m, x] of g) if (asRate && (x.noPop ?? 0) > 0) groupNoPop.set(m, x.noPop!);
        values = new Map(span.map((m) => [m, asRate && (g.get(m)?.blank ?? 0) > 0 ? null : g.get(m)?.value ?? null]));
        if (asRate) pops = new Map(span.map((m) => [m, (g.get(m)?.population ?? 0) > 0 ? g.get(m)!.population : null]));
        const last = g.get(to);
        cov = last ? { agencies: last.agencies, population: last.population, from: b.firstMonth } : null;
      } else {
        // A lookback that reaches before 2025: the agencies with a figure in every month of it, summed (Jeff 2026-11-19).
        const g = groupSpanMonths(b, p.states, cq.measure, need, to, execute);
        values = g.values;
        cov = g.agencies ? { agencies: g.agencies, population: g.population, from: need } : null;
      }
    }
    const raw = span.map((m) => values.get(m) ?? null);
    const counts = span.map((m, i) => (i < w - 1 || raw.slice(i - w + 1, i + 1).some((v) => v === null) ? null : raw.slice(i - w + 1, i + 1).reduce<number>((s, v) => s + (v as number), 0)));
    // A rate: the window's count over the mean of its months' populations; a window with a month lacking a population has no rate.
    const rolled = asRate ? counts.map((c, i) => {
      const ps = i < w - 1 ? [] : span.slice(i - w + 1, i + 1).map((m) => pops.get(m) ?? null);
      return c === null || ps.length < w || ps.some((x) => x === null) ? null : currentRate(c, (ps as number[]).reduce((s, x) => s + x, 0) / w, w);
    }) : counts;
    // The blank months inside the rows shown, and (P281) those before the first row: they sit in its window, so they are named too, with
    // how many of the windows shown they blank.
    const blanks = span.filter((m, i) => raw[i] === null && m >= cq.from);
    const preBlanks = span.filter((m, i) => raw[i] === null && m < cq.from);
    const preWindows = preBlanks.length ? span.filter((m, i) => m >= cq.from && raw.slice(Math.max(0, i - w + 1), i + 1).some((v, k) => v === null && span[Math.max(0, i - w + 1) + k] < cq.from)).length : 0;
    // The months whose missing population blanks a shown window whose count is known (the month itself, not the window's last month).
    const noPop = asRate ? span.filter((m, j) => pops.get(m) == null && span.some((e, i) => i >= j && i <= j + w - 1 && i >= w - 1 && e >= cq.from && counts[i] !== null)) : [];
    return { p, rolled, blanks, preBlanks, preWindows, cov, noPop, groupNoPop };
  });
  const shown = span.map((m, i) => ({ m, i })).filter((x) => x.m >= cq.from);
  const several = per.length > 1;
  const words = WORDS[col];
  const hm = HISTORICAL_MEASURE[cq.measure];
  const names = per.map((x) => x.p.label);
  const listed = names.length > 2 ? `${names.slice(0, -1).join("; ")} and ${names[names.length - 1]}` : names.join(" and ");
  const header = asRate ? `Rolling ${w}-month ${SINGULAR[col]} rate per 100,000` : `Rolling ${w}-month ${words}`;
  const columns: ResultTable["columns"] = [...(several ? [{ binding: { kind: "grouping" as const, dimension: "geo.agency" }, header: "Place" }] : []),
    { binding: { kind: "grouping", dimension: "time.month" }, header: "Month", ordered: true }, { binding: { kind: "statistic", as: "x" }, header }];
  const rows = per.flatMap((x) => shown.map(({ m, i }) => [...(several ? [x.p.kind === "agency" ? x.p.name : x.p.label] : []), m, x.rolled[i]] as (string | number | null)[]));
  const gapLines = per.flatMap((x) => (x.blanks.length ? [`No figure is available for ${runs(x.blanks)}${several ? ` for ${x.p.label}` : ""}: every ${w}-month window containing ${x.blanks.length > 1 ? "one of those months" : "that month"} is shown blank, not zero.`] : []));
  const popLines = per.flatMap((x) => (x.noPop.length ? [`No population is available for ${runs(x.noPop)}${several ? ` for ${x.p.label}` : ""}: every ${w}-month window containing ${x.noPop.length > 1 ? "one of those months" : "that month"} is shown blank, not zero.`] : []));
  const preLines = per.flatMap((x) => (x.preBlanks.length ? [`No figure is available for ${runs(x.preBlanks)}${several ? ` for ${x.p.label}` : ""}, before the first month shown: the first ${x.preWindows} ${w}-month window${x.preWindows === 1 ? " is" : "s are"} blank, not zero.`] : []));
  const dropLines = per.flatMap((x) => (x.groupNoPop.size ? [`Agencies with no population in a month are left out of both the count and the population for ${runs([...x.groupNoPop.keys()])}${several ? ` for ${x.p.label}` : ""}: ${[...x.groupNoPop.values()].reduce((s, n) => Math.max(s, n), 0)} at most in a month.`] : []));
  const rateLine = asRate ? [`Each rate is the ${w}-month count per 100,000 of the population averaged over those months, not scaled to a full year.`] : [];
  const cohortLine = per.flatMap((x) => (x.cov ? [cohortSentence(x.cov.agencies, x.cov.population, x.cov.from, to)] : []));
  const period = { from: cq.from, to };
  const first = cq.places[0];
  const places: Meaning["places"] = per.flatMap((x): Meaning["places"][number][] => (x.p.kind === "agency" ? [{ kind: "agency", name: x.p.name, state: x.p.state }]
    : x.p.states === null ? [{ kind: "national", name: "United States" }] : x.p.states.map((st) => ({ kind: "state" as const, name: stateName(st), state: st }))));
  const tables = [...(need < b.firstMonth ? ["current_final"] : []), ...(to >= b.firstMonth ? ["current_crime"] : [])];
  return {
    kind: "current", period, coverage: [], read: { tables, table: tables.join(" + "), column: `${col}_total`, release: b.release },
    question: { measure: cq.measure, place: first, agencies: several && first.kind === "agency" ? cq.places.slice(1).filter((p): p is Extract<CurrentPlace, { kind: "agency" }> => p.kind === "agency") : undefined, from: cq.from, to, form: "months", statistic: asRate ? "rate" : "count" },
    meaning: { source: "rtci", places, period, measures: [{ name: hm.name, unit: hm.unit }], filters: [], groupings: several ? ["agency", "month"] : ["month"], statistic: asRate ? "rate" : "count" },
    delivered: { table: { columns, rows }, text: [seriesTitle(spanTitle(period.from, period.to), asRate ? `Rolling ${w}-Month ${ucFirst(SINGULAR[col])} Rate` : `Rolling ${w}-Month ${ucFirst(words)}`, "Month", listed), ...(cq.agencyLine ? [cq.agencyLine] : []), ...(cq.outside ? [cq.outside] : []), ...rateLine, ...cohortLine, ...preLines, ...gapLines, ...dropLines, ...popLines, "Source: Crime Index."] },
  };
}
