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
