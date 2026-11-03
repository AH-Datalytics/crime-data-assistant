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
import fs from "node:fs";
import path from "node:path";
import type { ResultTable } from "../nibrs-plan/result";
import type { Meaning } from "../answer-eval/case";
import { HISTORICAL_MEASURE } from "./historical";
import { stateName } from "./places";
import { fmt } from "./deliver";
import { aboutPeople } from "./presentation";

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
  murder: "murder", homicide: "murder", rape: "rape", robbery: "robbery", aggravated_assault: "assault", burglary: "burglary",
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

export type GroupMonth = { value: number | null; agencies: number; population: number; blank: number };
/**
 * A group's monthly consistent sums (P91): `states` null for the nation. Months before current_crime's first are not
 * given (decision A: no cohort rule yet); the caller declines them.
 */
export function groupMonths(b: CurrentBuild, states: string[] | null, measure: string, from: Month, to: Month, execute: (sql: string) => unknown[][]): Map<Month, GroupMonth> {
  const col = CURRENT_MEASURE[measure];
  const key = "printf('%04d-%02d', year, month)";
  const sql = `SELECT ${key} AS ym, sum(${col}_total), count(*), sum(population), count(*) FILTER (WHERE ${col}_total IS NULL)
    FROM read_parquet('${b.root}/current_crime.parquet') WHERE sample${states ? ` AND state IN (${states.map(q).join(", ")})` : ""}
    AND ${key} BETWEEN ${q(from)} AND ${q(to)} GROUP BY 1`;
  const out = new Map<Month, GroupMonth>();
  for (const [ym, v, n, pop, blank] of execute(sql)) out.set(String(ym), { value: num(v), agencies: Number(n), population: Number(pop ?? 0), blank: Number(blank) });
  return out;
}

/** A sum over months, null when any month in it is unknown; `missing` names those months (design note section 3). */
export function cumulative(values: (number | null)[], ms: Month[]): { value: number | null; missing: Month[] } {
  const missing = ms.filter((_, i) => values[i] === null);
  return { value: missing.length ? null : values.reduce<number>((a, v) => a + (v as number), 0), missing };
}
/** The year to date through `to`: January of its year through `to`. */
export const ytdMonths = (to: Month) => months(`${to.slice(0, 4)}-01`, to);
/** The rolling 12 months through `to`. */
export function rollingMonths(to: Month): Month[] {
  const y = Number(to.slice(0, 4)), m = Number(to.slice(5));
  const start = m === 12 ? `${y}-01` : `${y - 1}-${String(m + 1).padStart(2, "0")}`;
  return months(start, to);
}
/** The same month a year earlier. */
export const yearEarlier = (m: Month) => `${Number(m.slice(0, 4)) - 1}-${m.slice(5)}`;
/** Percent change from two complete values, one decimal; null when either is unknown or the earlier is zero (P55). */
export function change(earlier: number | null, later: number | null): number | null {
  if (earlier === null || later === null || earlier === 0) return null;
  return Math.round(((later - earlier) * 1000) / earlier) / 10;
}
/** Decision B (P58, P59): count per 100,000, one decimal; null for one month, an unknown count or no population. */
export function currentRate(count: number | null, population: number | null, monthsCovered: number): number | null {
  if (count === null || population === null || population <= 0 || monthsCovered < 2) return null;
  return Math.round((count * 1e6) / population) / 10;
}

/* ------------------------------------------------ the answer (counts; rates and routing come next) -------------- */

export type CurrentPlace =
  | { kind: "agency"; ori: string; label: string; name: string; state: string }
  | { kind: "group"; states: string[] | null; label: string };
export type CurrentQuestion = {
  measure: string; place: CurrentPlace; from: Month; to: Month;
  /** "months": each month; "ytd" / "rolling": one total through `to` (its months computed here). */
  form: "months" | "ytd" | "rolling";
  agencyLine?: string;
};
export type CurrentAnswer = {
  kind: "current"; question: CurrentQuestion; period: { from: Month; to: Month }; meaning: Meaning;
  delivered: { table: ResultTable; text: string[] };
  /** Group months: the agencies counted and their population, and how many had no figure (P90, P91). */
  coverage: { month: Month; agencies: number; population: number; blank: number }[];
  read: { tables: string[]; table: string; column: string; release: string };
};
export type CurrentDecline = { kind: "current-decline"; explanation: string };

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
  const span = cq.form === "months" ? months(cq.from, cq.to) : cq.form === "ytd" ? ytdMonths(cq.to) : rollingMonths(cq.to);
  // The months the data holds: an agency's from the Final panel's first, a group's from current_crime's (decision A).
  const first = group ? b.firstMonth : b.finalFirstMonth;
  const covered = span.filter((m) => m >= first && m <= b.lastMonth);
  const holds = `Current Trends ${group ? "totals" : "figures"} in the data cover ${spanWords(first, b.lastMonth)}`;
  // A cumulative total needs every one of its months (design note, section 3): never the part the data holds.
  if (!covered.length || (cq.form !== "months" && covered.length !== span.length))
    return { kind: "current-decline", explanation: `${holds}, so ${spanWords(span[0], span[span.length - 1])} ${span.length > 1 ? "are" : "is"} outside them.` };
  const where = cq.place.label, words = WORDS[col], one = SINGULAR[col], source = "Source: Crime Index.";
  const head = cq.agencyLine ? [cq.agencyLine] : [];
  const left = span.filter((m) => !covered.includes(m));
  const outside = left.length ? [`${holds}; ${spanWords(left[0], left[left.length - 1])} ${left.length > 1 ? "are" : "is"} outside them.`] : [];
  let values: Map<Month, number | null>;
  let coverage: CurrentAnswer["coverage"] = [];
  if (cq.place.kind === "agency") values = agencyMonths(b, cq.place.ori, cq.measure, covered[0], covered[covered.length - 1], execute);
  else {
    const g = groupMonths(b, cq.place.states, cq.measure, covered[0], covered[covered.length - 1], execute);
    values = new Map(covered.map((m) => [m, g.get(m)?.value ?? null]));
    coverage = covered.flatMap((m) => { const x = g.get(m); return x ? [{ month: m, ...x }] : []; });
  }
  const vals = covered.map((m) => values.get(m) ?? null);
  // Agencies with no figure in a group's month are left out of its total and named (Codex design check 01.2).
  const leftOut = coverage.filter((c) => c.blank > 0).map((c) => `${monthWords(c.month)} (${fmt(c.blank)} of ${fmt(c.agencies)})`);
  // P90's sentence, in the shared wording: the agencies counted and the people they cover, as of the latest month shown.
  const lastCov = coverage[coverage.length - 1];
  const cohortLine = lastCov ? [`This counts only the ${fmt(lastCov.agencies)} Consistent Reporting ${lastCov.agencies === 1 ? "Agency" : "Agencies"}, covering roughly ${aboutPeople(lastCov.population)} people, that reported every month from ${monthWords(b.firstMonth)} through ${monthWords(b.lastMonth)}.`] : [];
  const leftOutLine = leftOut.length ? [`Agencies with no ${one} figure are left out of the total: ${leftOut.join(", ")}.`] : [];
  const tables = [...(covered[0] < b.firstMonth ? ["current_final"] : []), ...(covered[covered.length - 1] >= b.firstMonth ? ["current_crime"] : [])];
  const read = { tables, table: tables.join(" + "), column: `${col}_total`, release: b.release };
  const period = { from: covered[0], to: covered[covered.length - 1] };
  const hm = HISTORICAL_MEASURE[cq.measure];
  const places: Meaning["places"] = cq.place.kind === "agency" ? [{ kind: "agency", name: cq.place.name, state: cq.place.state }]
    : cq.place.states === null ? [{ kind: "national", name: "United States" }] : cq.place.states.map((st) => ({ kind: "state" as const, name: stateName(st), state: st }));
  const meaning = (groupings: string[]): Meaning => ({ source: "rtci", places, period, measures: [{ name: hm.name, unit: hm.unit }], filters: [], groupings, statistic: "count",
    ...(group ? { cohort: "same_agencies" as const } : {}) });
  if (cq.form !== "months") {
    const c = cumulative(vals, covered);
    const what = cq.form === "ytd" ? `year to date (${spanWords(period.from, period.to)})` : `12 months from ${spanWords(period.from, period.to)}`;
    if (c.value === null) return { kind: "current-decline", explanation: `Crime Index has no ${one} figure for ${where} in ${c.missing.map(monthWords).join(", ")}, so there is no total for the ${what}.` };
    return { kind: "current", question: cq, period, meaning: meaning([]), coverage, read,
      delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header: ucFirst(words) }], rows: [[c.value]] },
        text: [`${where}: ${fmt(c.value)} ${words}, ${what}.`, ...head, ...cohortLine, ...leftOutLine, source] } };
  }
  const blanks = covered.filter((_, i) => vals[i] === null).map(monthWords);
  const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "time.month" }, header: "Month", ordered: true }, { binding: { kind: "statistic", as: "x" }, header: ucFirst(words) }];
  return { kind: "current", question: cq, period, meaning: meaning(["month"]), coverage, read,
    delivered: { table: { columns, rows: covered.map((m, i) => [m, vals[i]]) },
      text: [`${where}: ${words} by month, ${spanWords(period.from, period.to)}.`, ...head, ...cohortLine, ...outside, ...leftOutLine,
        ...(blanks.length ? [`No figure is known for ${blanks.join(", ")}: shown blank, not zero.`] : []), source] } };
}
