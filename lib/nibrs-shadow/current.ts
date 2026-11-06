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

/** An agency's current population: its row's in `month`, else its latest earlier row's; null when none is above zero. */
export function agencyPopulation(b: CurrentBuild, ori: string, month: Month, execute: (sql: string) => unknown[][]): number | null {
  const r = execute(`SELECT population FROM read_parquet('${b.root}/current_crime.parquet') WHERE ori = ${q(ori)} AND population > 0 AND printf('%04d-%02d', year, month) <= ${q(month)} ORDER BY year DESC, month DESC LIMIT 1`)[0];
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
  return new Map(monthsWanted.map((m) => [m, m >= b.firstMonth ? cur.get(m) ?? null : yearly.get(Number(m.slice(0, 4))) ?? null]));
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
/** Percent change from two complete values, one decimal; null when either is unknown or the earlier is zero (P55). */
export function change(earlier: number | null, later: number | null): number | null {
  if (earlier === null || later === null || earlier === 0) return null;
  return Math.round(((later - earlier) * 1000) / earlier) / 10;
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
      text: [`${cq.place.label}: ${words}, ${ew} against ${lw}.`, `${fmt(e.value)} and ${fmt(l.value)}: a change of ${signed(ch)}${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""}.`,
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
  const first = group ? b.firstMonth : b.finalFirstMonth;
  const covered = span.filter((m) => m >= first && m <= b.lastMonth);
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
  if (cq.place.kind === "agency") values = agencyMonths(b, cq.place.ori, cq.measure, covered[0], covered[covered.length - 1], execute);
  else {
    const g = groupMonths(b, cq.place.states, cq.measure, covered[0], covered[covered.length - 1], execute);
    values = new Map(covered.map((m) => [m, g.get(m)?.value ?? null]));
    coverage = covered.flatMap((m) => { const x = g.get(m); return x ? [{ month: m, ...x }] : []; });
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
  const cohortLine = lastCov ? [`This counts only the ${fmt(lastCov.agencies)} Consistent Reporting ${lastCov.agencies === 1 ? "Agency" : "Agencies"}, covering roughly ${aboutPeople(lastCov.population)} people, that reported every month from ${monthWords(b.firstMonth)} through ${monthWords(b.lastMonth)}.`] : [];
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
          text: [`${where}: ${avg.toFixed(1)} ${words} a month on average ${what} (${fmt(c.value)} in all).`, ...head, ...cohortLine, ...leftOutLine, source] } };
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
          text: [`${where}: ${r.toFixed(1)} ${words} per 100,000 people ${what} (not annualized).`, ...head, ...(cq.place.kind === "agency" ? [`That is ${fmt(base.count)} ${words}.`] : rateLine), ...cohortLine, source] } };
    }
    return { kind: "current", question: cq, period, meaning: meaning([]), coverage, read,
      delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header: ucFirst(words) }], rows: [[c.value]] },
        text: [`${where}: ${fmt(c.value)} ${words} ${what}.`, ...head, ...cohortLine, ...leftOutLine, source] } };
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
          ? `${where}: ${rates[0]!.toFixed(1)} ${words} per 100,000 people in ${monthWords(covered[0])}: that month's own count, not annualized.`
          : `${where}: ${words} per 100,000 people for each month, ${spanWords(period.from, period.to)}: each month's own count, not annualized.`, ...head, ...cohortLine, ...outside,
          ...(noRate.length ? [`No rate for ${noRate.join(", ")}: ${group ? "an agency counted had no figure or there was no population" : "no figure or no population"}, shown blank.`] : []), source] } };
  }
  const blanks = covered.filter((_, i) => vals[i] === null).map(monthWords);
  const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "time.month" }, header: "Month", ordered: true }, { binding: { kind: "statistic", as: "x" }, header: ucFirst(words) }];
  return { kind: "current", question: cq, period, meaning: meaning(["month"]), coverage, read,
    delivered: { table: { columns, rows: covered.map((m, i) => [m, vals[i]]) },
      text: [`${where}: ${words} by month, ${spanWords(period.from, period.to)}.`, ...head, ...cohortLine, ...outside, ...leftOutLine,
        ...(blanks.length ? [`No figure is known for ${blanks.join(", ")}: shown blank, not zero.`] : []), source] } };
}
