/**
 * Stage 2b (NIBRS): compile a supported question type (lib/nibrs-question-types.ts) into application-built statements
 * over the summary tables, and assemble the delivered rows in code (plan §4, r1.1 R2-R5; output contract in
 * audit/request-accounting-stage2/2b-r1/make-expectations.cjs).
 *
 *   - TABLE SELECTION (r1.1 R2): per measure, the first registry table that holds the measure's codes in the REQUESTED
 *     unit (the family or generic default only when none is stated) together with every filter, the breakdown, the
 *     place grain and the time grain. Nothing is relaxed to find a table; a combination no table holds is declined by
 *     name. A category total sums its measures' cells, each in its own unit, labeled "mixed".
 *   - DENOMINATORS (r1.1 R3): a share's denominator is never a sum of overlapping category rows; it comes from a table
 *     whose rows are unique for the population, or the share is withheld while the counts are still given.
 *   - COMPLETENESS (r1.1 R5): agency cells follow decideNibrsCompleteness unchanged; state and national figures from the
 *     types state their cohort (contributing agencies and the months-weighted population covered).
 *   - MONTHS (r1.1 R4): evidence that an agency reported in a month is any summary_city_monthly row for it; a month with
 *     evidence and no requested events is 0, a month without evidence is named, never 0.
 *
 * The model writes nothing here. Every statement is checked against the NIBRS table allowlist by the caller before it
 * runs (2a D1).
 */
import type Database from "better-sqlite3";
import type { ChartConfig } from "./types";
import { resolveNibrsPlaces } from "./nibrs-place-resolver";
import { decideNibrsCompleteness, NIBRS_COMPLETENESS_PROXY_DISCLOSURE, NIBRS_RECENT_MATURATION_DISCLOSURE } from "./nibrs-completeness";
import { LOCATION_TYPES, WEAPON_TYPES, RACE_CODES, COMMERCIAL_LOCATION_CODES, COMMERCIAL_LOCATION_NAMES } from "./nibrs-codes";
import {
  MEASURE_CODES, MEASURE_LABEL, PERSON_CODES, GROUP_B, STATE_NAME_BY_CODE, filterLabel,
  type NibrsSpec, type NPlace, type NPeriod, type Unit, type Statistic, type SeriesSpec, type BreakdownSpec, type ShareSpec, type RankSpec, type ChangeSpec,
} from "./nibrs-question-types";
import { placeIs, type PlaceSet, type NibrsApplied } from "./nibrs-legacy-binding";
import { recordWhyFacts } from "./why-scope";

export type Row = Record<string, string | number | null>;
export type CompiledAnswer =
  | { kind: "answer"; columns: string[]; rows: Row[]; title: string; explanation: string; statements: string[]; applied: NibrsApplied }
  | { kind: "decline"; explanation: string; statements: string[] }
  | { kind: "clarify"; explanation: string; statements: string[] };
export type Runner = (sql: string) => Promise<Record<string, unknown>[]>;
export type CompileContext = { db: Database.Database; run: Runner; now: Date; cutoff: { year: number; month: number } };

export const SERIES = ["period", "place", "measure", "unit", "filter", "statistic", "value", "note"];
export const BREAKDOWN = ["period", "place", "measure", "unit", "filter", "dimension", "category", "count", "share", "note"];
export const SHARE = ["period", "place", "measure", "unit", "population", "subset", "numerator", "denominator", "share", "note"];
export const RANK = ["rank", "place", "year", "measure", "unit", "statistic", "value", "population"];
export const CHANGE = ["place", "measure", "unit", "statistic", "earlier_year", "earlier_value", "later_year", "later_value", "change", "percent_change", "note"];

/**
 * NIBRS typed-chart hotfix (owner report 2026-10-22: a monthly NIBRS answer came back as a table with no graph; Codex
 * build ruling REVISE): the chart for a typed answer, ONLY for shapes the chart draws faithfully. Anything else keeps
 * its table (chartConfig null), as before the hotfix:
 * - one unit, one statistic and one filter only (victims never share an axis with offenses);
 * - no partial-period rows (a partial year would look comparable to full years until partial markers ship);
 * - a series over periods: one dimension of series only (places OR measures, never both), a complete period grid, and
 *   no value without a valued neighbor (a lone value draws nothing visible: the panels draw no dots);
 * - one period across places or measures: bars;
 * - a breakdown: bars by category for one period and place; lines by category over periods only on a complete grid;
 * - a ranking: bars. A share or a two-endpoint change has no chart.
 */
export function typedChartConfig(columns: string[], rows: Record<string, unknown>[], title: string): ChartConfig | null {
  if (rows.length < 2) return null;
  const distinct = (k: string) => new Set(rows.map((r) => String(r[k] ?? ""))).size;
  const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const valued = (k: string) => rows.filter((r) => isNum(r[k])).length;
  if (rows.some((r) => /partial/i.test(String(r.note ?? "")))) return null;
  for (const k of ["unit", "statistic", "filter"]) if (columns.includes(k) && distinct(k) > 1) return null;
  /** Every series (rows sharing seriesKey) covers every period and has no valued point without a valued neighbor. */
  const drawable = (valueKey: string, seriesKey: string) => {
    const periods = [...new Set(rows.map((r) => String(r.period)))].sort();
    const bySeries = new Map<string, Map<string, unknown>>();
    for (const r of rows) {
      const s = String(r[seriesKey] ?? "");
      if (!bySeries.has(s)) bySeries.set(s, new Map());
      if (bySeries.get(s)!.has(String(r.period))) return false;
      bySeries.get(s)!.set(String(r.period), r[valueKey]);
    }
    for (const cells of bySeries.values()) {
      if (cells.size !== periods.length) return false;
      const v = periods.map((p) => isNum(cells.get(p)));
      if (v.some((ok, i) => ok && !v[i - 1] && !v[i + 1])) return false;
    }
    return true;
  };
  if (columns.join() === SERIES.join() && valued("value") > 0) {
    const places = distinct("place");
    const measures = distinct("measure");
    if (places > 1 && measures > 1) return null;
    const seriesKey = measures > 1 ? "measure" : "place";
    if (distinct("period") > 1) return drawable("value", seriesKey) ? { type: "line", xAxis: "period", yAxis: ["value"], title } : null;
    if (places > 1) return { type: "bar", xAxis: "place", yAxis: ["value"], title };
    if (measures > 1) return { type: "bar", xAxis: "measure", yAxis: ["value"], title };
    return null;
  }
  if (columns.join() === BREAKDOWN.join() && valued("count") > 0) {
    if (distinct("place") > 1 || distinct("measure") > 1 || distinct("dimension") > 1) return null;
    if (distinct("period") > 1) return distinct("category") <= 16 && drawable("count", "category") ? { type: "line", xAxis: "period", yAxis: ["count"], title } : null;
    return { type: "bar", xAxis: "category", yAxis: ["count"], title };
  }
  if (columns.join() === RANK.join() && valued("value") > 0) return { type: "bar", xAxis: "place", yAxis: ["value"], title };
  return null;
}
/**
 * The title of a typed series answer (owner, 2026-10-22): "<places> <what was counted>[ Per Month| Per Year], <period>",
 * e.g. "Memphis, TN Carjackings Per Month, 2025" or "Memphis, TN Carjackings Per Year, 2018 to 2025". Built ONLY when
 * every part is certain (Codex follow-up ruling); otherwise the previous title is kept (`fallback`):
 * - each measure is named from its OWN rows; its unit must be offenses or victims and its statistic count or
 *   rate_per_100k, constant within the measure, and every measure must share one statistic;
 * - "Per Month"/"Per Year" come from the requested grain (month or year), so an annual request with one result still
 *   says "Per Year"; a total has none and must cover one period; any other grain (rolling) keeps the previous title;
 * - periods must all be months (YYYY-MM) or all years (YYYY), or one pooled total "2018-2025" (read "2018 to 2025");
 *   any other period keeps the previous title;
 * - a filtered series (e.g. female victims) keeps the previous title, so a subset is never titled as the whole;
 * - a compiler partial-year note adds its coverage, e.g. "(2026 Through June)"; an unreadable partial note keeps the
 *   previous title;
 * - years read "2025" or "2018 to 2025"; a single month reads "January 2025".
 */
const TITLE_PLURAL: Record<string, string> = {
  carjacking: "Carjackings", murder: "Murders", homicide: "Homicides", robbery: "Robberies", burglary: "Burglaries", rape: "Rapes",
  aggravated_assault: "Aggravated Assaults", simple_assault: "Simple Assaults", motor_vehicle_theft: "Motor Vehicle Thefts", theft: "Thefts",
  arson: "Arsons", sex_offense: "Sex Offenses", shoplifting: "Shoplifting Offenses", violent_crime: "Violent Crimes", property_crime: "Property Crimes",
};
const TITLE_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const titleWords = (s: string) => s.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
export function seriesTitle(rows: Record<string, unknown>[], measures: string[], grain: string, fallback: string): string {
  if (!rows.length || !measures.length) return fallback;
  if (rows.some((r) => r.filter !== null && r.filter !== undefined && String(r.filter) !== "")) return fallback;
  const partials: string[] = [];
  for (const r of rows) {
    const note = String(r.note ?? "");
    if (!/partial/i.test(note)) continue;
    const found = [...note.matchAll(/partial year(?: (\d{4}))? \(January-([A-Z][a-z]+)\)/g)];
    if (!found.length || !TITLE_MONTHS.includes(found[0][2])) return fallback;
    for (const m of found) {
      const y = m[1] ?? String(r.period ?? "");
      if (!/^\d{4}$/.test(y) || !TITLE_MONTHS.includes(m[2])) return fallback;
      partials.push(y);
    }
  }
  const statistics = new Set(rows.map((r) => String(r.statistic ?? "")));
  if (statistics.size !== 1) return fallback;
  const statistic = [...statistics][0];
  if (statistic !== "count" && statistic !== "rate_per_100k") return fallback;
  const names: string[] = [];
  for (const m of measures) {
    const own = rows.filter((r) => r.measure === m);
    const units = new Set(own.map((r) => String(r.unit ?? "")));
    if (own.length === 0 || units.size !== 1) return fallback;
    const unit = [...units][0];
    if (unit !== "offenses" && unit !== "victims") return fallback;
    const label = titleWords(MEASURE_LABEL[m] ?? m);
    names.push(statistic === "rate_per_100k"
      ? `${label}${unit === "victims" ? " Victim" : ""} Rate Per 100k`
      : unit === "victims" ? `${label} Victims` : TITLE_PLURAL[m] ?? `${label} Offenses`);
  }
  const periods = [...new Set(rows.map((r) => String(r.period ?? "")))].sort();
  const monthly = periods.every((p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p));
  const annual = periods.every((p) => /^\d{4}$/.test(p));
  const pooled = periods.length === 1 && /^(\d{4})-(\d{4})$/.exec(periods[0]);
  let per: string;
  let span: string;
  const years = [...new Set(periods.map((p) => p.slice(0, 4)))];
  const yearSpan = years.length === 1 ? years[0] : `${years[0]} to ${years[years.length - 1]}`;
  if (grain === "month" && monthly) per = " Per Month";
  else if (grain === "year" && annual) per = " Per Year";
  else if (grain === "total" && (monthly || annual) && periods.length === 1) per = "";
  else if (grain === "total" && pooled && pooled[1] < pooled[2]) per = "";
  else return fallback;
  if (pooled) span = `${pooled[1]} to ${pooled[2]}`;
  else if (monthly && periods.length === 1) span = `${TITLE_MONTHS[Number(periods[0].slice(5, 7)) - 1]} ${periods[0].slice(0, 4)}`;
  else span = yearSpan;
  const places = [...new Set(rows.map((r) => String(r.place ?? "")).filter(Boolean))];
  if (!places.length) return fallback;
  // Owner 2026-10-25: a partial year reads "(2026 Partial)" ("(Partial)" after a single year), never its months; the
  // explanation and row notes still state the months covered.
  const partialYears = [...new Set(partials)].sort();
  const partial = !partialYears.length ? "" : span === partialYears[0] && partialYears.length === 1 ? " (Partial)" : ` (${partialYears.join(" and ")} Partial)`;
  return `${places.join(" and ")} ${names.join(" and ")}${per}, ${span}${partial}`;
}
const OVERLAP_NOTE = "categories can overlap; shares can sum past 100%";
const r1 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/* ================================================================== registry ===================================== */

type Dim = { col: string; overlap: boolean; label?: (v: string) => string; values?: (filterValue: string) => string[] | null };
type Table = {
  key: string; table: string; agency: boolean; state: boolean; nationalOnly?: boolean; monthly: boolean;
  yearCol: string; oriCol?: string; stateCol?: string; codeCol: string | null; codes: Set<string> | null;
  family?: string; unit: Unit; unitLabel?: (codes: string[]) => string; count: string; dims: Record<string, Dim>;
  usStateRows?: boolean;
  /** The state-grain twin read for plain state and national counts (no ori column). */
  stateTable?: string;
};
const SEX: Dim = { col: "sex", overlap: false, label: (v) => ({ M: "Male", F: "Female", U: "Unknown" }[v] ?? v), values: (v) => [v] };
const RACE: Dim = { col: "race", overlap: false, label: (v) => RACE_CODES[v] ?? v, values: (v) => [v] };
const AGE: Dim = { col: "age_group", overlap: false, label: (v) => v, values: (v) => [v] };
const ETH: Dim = { col: "ethnicity", overlap: false, label: (v) => ({ H: "Hispanic or Latino", N: "Not Hispanic or Latino", U: "Unknown" }[v] ?? v), values: (v) => [v] };
const WEAPON_CATEGORY: Dim = { col: "weapon_category", overlap: true, values: (v) => (v === "firearm" ? ["Firearm"] : null) };
const FIREARMS = ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"];
const WEAPON_TYPE: Dim = { col: "weapon_type", overlap: true, label: (v) => WEAPON_TYPES[v] ?? v, values: (v) => (v === "firearm" ? FIREARMS : [v, `${v}A`]) };
/**
 * Owner decision A (2026-10-21; codex build ruling item 1): summary_victim_weapon holds one row per victim per DISTINCT weapon
 * type, so summing the firearm types counts a victim with two firearm types twice. A firearm VICTIM count is therefore not
 * taken from it: the "firearm" category falls through to summary_victim_demographics (one row per victim, from the first-listed
 * weapon), and the answer says so (FIRST_WEAPON_NOTE). One specific weapon type ("handgun") still uses this table: no overlap.
 */
const VICTIM_WEAPON_TYPE: Dim = { ...WEAPON_TYPE, values: (v) => (v === "firearm" ? null : [v, `${v}A`]) };
export const FIRST_WEAPON_NOTE = "Firearm here means the victim's first-listed weapon was a firearm: each victim is counted once, and a victim whose firearm was listed only second or third isn't counted.";
/** The basis note for any answer that applies the firearm category to the count-once victim table (series, breakdown, share). */
const firstWeaponNote = (filters: readonly string[], t: { key: string } | null | undefined): string | null => (filters.includes("weapon:firearm") && t?.key === "victim_demo" ? FIRST_WEAPON_NOTE : null);
const DEMO = { sex: SEX, race: RACE, age: AGE, ethnicity: ETH, weapon: WEAPON_CATEGORY };
const DEMO_CODES = new Set(["09A", "09B", "11A", "11B", "11C", "13A", "13B", "120"]);
// Relationship and bias names: the FBI CDE codebook (NIBRS_RELATIONSHIP, NIBRS_BIAS_LIST; CDE codebook fix 2026-10-13).
const RELATIONSHIP_LABEL: Record<string, string> = { AQ: "Acquaintance", BE: "Babysittee", BG: "Boyfriend/Girlfriend", CF: "Child of Boyfriend or Girlfriend", CH: "Child", CO: "Cohabitant (non-intimate relationship)", CS: "Common-Law Spouse", EE: "Employee", ER: "Employer", FC: "Foster Child", FP: "Foster Parent", FR: "Friend", GC: "Grandchild", GP: "Grandparent", HR: "Homosexual Relationship", IL: "In-law", NE: "Neighbor", OF: "Other Family Member", OK: "Otherwise Known", PA: "Parent", RU: "Relationship Unknown", SB: "Sibling", SC: "Stepchild", SE: "Spouse", SP: "Stepparent", SS: "Stepsibling", ST: "Stranger", VO: "Victim Was Offender", XR: "Ex-Relationship (Ex-Boyfriend/Girlfriend)", XS: "Ex-Spouse" };
const CIRCUMSTANCE_LABEL: Record<string, string> = { "01": "Argument", "02": "Assault on Law Enforcement Officer", "03": "Drug Dealing", "04": "Gangland", "05": "Juvenile Gang", "06": "Domestic Violence", "07": "Mercy Killing", "08": "Other Felony", "09": "Other", "10": "Unknown" };
const DRUG_LABEL: Record<string, string> = { A: "Crack Cocaine", B: "Cocaine", C: "Hashish", D: "Heroin", E: "Marijuana", F: "Morphine", G: "Opium", H: "Other Narcotics", I: "LSD", J: "PCP", K: "Other Hallucinogens", L: "Amphetamines/Methamphetamine", M: "Other Stimulants", N: "Barbiturates", O: "Other Depressants", P: "Other Drugs", U: "Unknown", X: "More Than 3 Drug Types" };
const BIAS_LABEL: Record<string, string> = { 11: "Anti-White", 12: "Anti-Black or African American", 13: "Anti-American Indian or Alaska Native", 14: "Anti-Asian", 15: "Anti-Multiple Races, Group", 16: "Anti-Native Hawaiian or Other Pacific Islander", 21: "Anti-Jewish", 22: "Anti-Catholic", 23: "Anti-Protestant", 24: "Anti-Islamic (Muslim)", 25: "Anti-Other Religion", 26: "Anti-Multiple Religions, Group", 27: "Anti-Atheism/Agnosticism", 28: "Anti-Church of Jesus Christ", 29: "Anti-Jehovah's Witness", 31: "Anti-Arab", 32: "Anti-Hispanic or Latino", 33: "Anti-Other Race/Ethnicity/Ancestry", 41: "Anti-Gay (Male)", 42: "Anti-Lesbian (Female)", 43: "Anti-Lesbian, Gay, Bisexual, or Transgender (Mixed Group)", 44: "Anti-Heterosexual", 45: "Anti-Bisexual", 51: "Anti-Physical Disability", 52: "Anti-Mental Disability", 61: "Anti-Male", 62: "Anti-Female", 71: "Anti-Transgender", 72: "Anti-Gender Non-Conforming", 81: "Anti-Eastern Orthodox (Russian, Greek, Other)", 82: "Anti-Other Christian", 83: "Anti-Buddhist", 84: "Anti-Hindu", 85: "Anti-Sikh", 88: "None (no bias)", 99: "Unknown (offender's motivation not known)" };
const MV_DESCRIPTIONS = ["03", "05", "24", "28", "37"];

const TABLES: Table[] = [
  // national homicide demographics first: they are the only national-only tables, chosen only for national places
  { key: "homicide_victim", table: "summary_homicide_victim", agency: false, state: false, nationalOnly: true, monthly: false, yearCol: "year", codeCol: null, codes: new Set(["09A"]), unit: "victims", count: "SUM(victim_count)",
    dims: { race: { col: "victim_race", overlap: false, values: (v) => [({ B: "Black", W: "White", A: "Asian" } as Record<string, string>)[v] ?? v] }, sex: { col: "victim_sex", overlap: false, values: (v) => [({ M: "Male", F: "Female" } as Record<string, string>)[v] ?? v] }, age: { col: "victim_age_group", overlap: false, values: (v) => [v] } } },
  { key: "homicide_pairs", table: "summary_homicide_victim_offender", agency: false, state: false, nationalOnly: true, monthly: false, yearCol: "year", codeCol: null, codes: new Set(["09A"]), unit: "pairs", count: "SUM(pair_count)",
    dims: { "victim-offender-race": { col: "victim_race || ' victim, ' || offender_race || ' offender'", overlap: false } } },
  { key: "homicide_offender", table: "summary_homicide_offender", agency: false, state: false, nationalOnly: true, monthly: false, yearCol: "year", codeCol: null, codes: new Set(["09A"]), unit: "offenders", count: "SUM(offender_count)",
    dims: { race: { col: "offender_race", overlap: false }, sex: { col: "offender_sex", overlap: false }, age: { col: "offender_age_group", overlap: false } } },
  // plain counts
  { key: "victim_monthly", table: "summary_victim_city_monthly", stateTable: "summary_victim_state_monthly", agency: true, state: true, monthly: true, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: PERSON_CODES, unit: "victims", count: "SUM(victim_count)", dims: {} },
  { key: "offense_monthly", table: "summary_city_monthly", stateTable: "summary_state_monthly", agency: true, state: true, monthly: true, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: null, unit: "offenses", unitLabel: (c) => (c.every((x) => x === "35A" || x === "35B") ? "incidents" : "offenses"), count: "SUM(offense_count)", dims: {} },
  // specific weapon types (before the demographic tables, whose weapon column is coarse)
  { key: "victim_weapon", table: "summary_victim_weapon", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: new Set(["09A", "09B", "09C", "11A", "11B", "11C", "13A", "13B", "120"]), unit: "victims", count: "SUM(victim_count)", dims: { weapon: VICTIM_WEAPON_TYPE } },
  { key: "offense_weapon", table: "summary_offense_weapon", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: null, unit: "offenses", count: "SUM(offense_count)", dims: { weapon: WEAPON_TYPE } },
  // people
  { key: "victim_demo", table: "summary_victim_demographics", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: DEMO_CODES, unit: "victims", count: "SUM(victim_count)", dims: DEMO },
  { key: "offender_demo", table: "summary_offender_demographics", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: null, unit: "offenders", count: "SUM(offender_count)", dims: DEMO },
  { key: "arrestee_demo", table: "summary_arrestee_demographics", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_arrest_offense", codes: null, unit: "arrests", unitLabel: (c) => (c.every((x) => GROUP_B.has(x)) ? "arrests" : "arrestees"), count: "SUM(arrestee_count)", dims: DEMO },
  // weapons, circumstances, relationships, locations, hours
  { key: "victim_circumstance", table: "summary_victim_circumstance", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: new Set(["09A", "09B", "09C", "13A"]), unit: "victims", count: "SUM(victim_count)", dims: { circumstance: { col: "circumstance_code", overlap: true, label: (v) => CIRCUMSTANCE_LABEL[v] ?? v } } },
  { key: "victim_relationship", table: "summary_victim_relationship", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: PERSON_CODES, unit: "victims", count: "SUM(victim_count)", dims: { relationship: { col: "relationship_code", overlap: true, label: (v) => RELATIONSHIP_LABEL[v] ?? v, values: (v) => [v] }, sex: SEX, race: RACE, age: AGE } },
  { key: "offense_location", table: "summary_offense_location", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: null, unit: "offenses", count: "SUM(offense_count)", dims: { location: { col: "location_type", overlap: false, label: (v) => LOCATION_TYPES[v] ?? v, values: (v) => (v === "commercial" ? [...COMMERCIAL_LOCATION_CODES] : [v]) } } },
  { key: "offense_hour", table: "summary_offense_hour", agency: false, state: true, monthly: false, yearCol: "year", stateCol: "state", codeCol: "ucr_offense_code", codes: null, unit: "offenses", count: "SUM(offense_count)", dims: { hour: { col: "incident_hour", overlap: false } } },
  // families
  { key: "dv_trends", table: "summary_dv_trends", agency: false, state: true, monthly: false, yearCol: "data_year", stateCol: "state", codeCol: null, codes: null, family: "domestic_violence", unit: "incidents", count: "SUM(incident_count)",
    dims: { dv: { col: "dv_category", overlap: true, values: (v) => [v] } } },
  { key: "dv_detail", table: "summary_domestic_violence", agency: true, state: true, monthly: false, yearCol: "data_year", oriCol: "ori", stateCol: "state", codeCol: null, codes: null, family: "domestic_violence", unit: "incidents", count: "COUNT(DISTINCT ori || ':' || data_year || ':' || incident_num)",
    dims: { dv: { col: "dv_category", overlap: true, values: (v) => [v] }, sex: { col: "victim_sex", overlap: false, label: SEX.label, values: (v) => [v] }, race: { col: "victim_race", overlap: false, label: RACE.label, values: (v) => [v] }, relationship: { col: "relationship_code", overlap: true, label: (v) => RELATIONSHIP_LABEL[v] ?? v, values: (v) => [v] } } },
  { key: "dv_victims", table: "summary_domestic_violence", agency: true, state: true, monthly: false, yearCol: "data_year", oriCol: "ori", stateCol: "state", codeCol: null, codes: null, family: "domestic_violence", unit: "victims", count: "COUNT(DISTINCT ori || ':' || data_year || ':' || incident_num || ':' || victim_sequence)",
    dims: { dv: { col: "dv_category", overlap: true, values: (v) => [v] }, sex: { col: "victim_sex", overlap: false, label: SEX.label, values: (v) => [v] }, race: { col: "victim_race", overlap: false, label: RACE.label, values: (v) => [v] }, relationship: { col: "relationship_code", overlap: true, label: (v) => RELATIONSHIP_LABEL[v] ?? v, values: (v) => [v] } } },
  { key: "dv_arrests", table: "summary_dv_arrests", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: null, codes: null, family: "domestic_violence", unit: "arrests", count: "SUM(arrest_count)",
    dims: { dv: { col: "dv_category", overlap: true, values: (v) => [v] }, sex: SEX, race: RACE, age: AGE } },
  { key: "drug_monthly", table: "summary_drug_monthly", agency: true, state: true, monthly: true, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: new Set(["35A", "35B"]), unit: "incidents", count: "SUM(offense_count)",
    dims: { drug: { col: "SUBSTR(suspected_drug_type, 1, 1)", overlap: true, label: (v) => DRUG_LABEL[v] ?? v, values: (v) => [v] } } },
  { key: "drug_arrests", table: "summary_drug_arrests", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_arrest_offense", codes: new Set(["35A", "35B"]), unit: "arrests", count: "SUM(arrest_count)",
    dims: { drug: { col: "drug_category", overlap: true, label: (v) => DRUG_LABEL[v] ?? v, values: (v) => [v] }, sex: SEX, race: RACE, age: AGE } },
  { key: "hate", table: "summary_hate_crime", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: null, family: "hate_crime", unit: "offenses", count: "SUM(offense_count)",
    dims: { bias: { col: "bias_motivation", overlap: true, label: (v) => BIAS_LABEL[v] ?? v, values: (v) => [v] } } },
  { key: "hate_location", table: "summary_hate_crime_location", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: "ucr_offense_code", codes: null, family: "hate_crime", unit: "offenses", count: "SUM(offense_count)",
    dims: { bias: { col: "bias_motivation", overlap: true, label: (v) => BIAS_LABEL[v] ?? v, values: (v) => [v] }, location: { col: "location_type", overlap: false, label: (v) => LOCATION_TYPES[v] ?? v, values: (v) => [v] } } },
  { key: "carjacking_monthly", table: "summary_carjacking_monthly", agency: true, state: true, monthly: true, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: null, codes: null, family: "carjacking", unit: "offenses", count: "SUM(offense_count)", dims: {} },
  { key: "carjacking_victims", table: "summary_carjacking_victim_demographics", agency: true, state: true, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: null, codes: null, family: "carjacking", unit: "victims", count: "SUM(victim_count)", dims: { sex: SEX, race: RACE, age: AGE } },
  { key: "pv_state", table: "summary_property_value_state", agency: false, state: true, monthly: false, yearCol: "year", stateCol: "state", codeCol: null, codes: null, family: "property", unit: "dollars", count: "SUM(total_value)", usStateRows: true,
    dims: { loss: { col: "type_property_loss", overlap: false, values: (v) => [v] } } },
  { key: "pv_agency", table: "summary_property_offense", agency: true, state: false, monthly: false, yearCol: "year", oriCol: "ori", stateCol: "state", codeCol: null, codes: null, family: "property", unit: "dollars", count: "SUM(total_value)",
    dims: { loss: { col: "type_property_loss", overlap: false, values: (v) => [v] } } },
];

/** The unit a measure is counted in when the question names none (r1.1 R2: family units override the generic default). */
function defaultUnit(measure: string): Unit {
  if (measure === "domestic_violence" || measure === "drug_possession") return "incidents";
  if (measure === "hate_crime" || measure === "carjacking") return "offenses";
  if (measure === "dui") return "arrests";
  if (measure === "motor_vehicle_property" || measure === "property_value") return "dollars";
  const codes = MEASURE_CODES[measure] ?? [];
  return codes.length && codes.every((c) => PERSON_CODES.has(c)) ? "victims" : "offenses";
}
const FAMILY_OF: Record<string, string> = { domestic_violence: "domestic_violence", hate_crime: "hate_crime", carjacking: "carjacking", motor_vehicle_property: "property", property_value: "property" };

type Need = { measure: string; codes: string[]; unit: Unit; dims: string[]; grain: "agency" | "state" | "national"; monthly: boolean; filters?: string[] };
/**
 * The first table holding everything the request needs; null when none does (declined by name). A filter counts as held
 * only when the table's dimension can express its VALUE (a coarse weapon category cannot express "handgun").
 */
function selectTable(n: Need): Table | null {
  for (const t of TABLES) {
    if (n.filters && !n.filters.every((f) => { const [d, v] = f.split(":"); const dim = t.dims[d]; return Boolean(dim) && (!dim.values || dim.values(v) !== null); })) continue;
    const family = FAMILY_OF[n.measure];
    if (family ? t.family !== family : t.family !== undefined) continue;
    if (!family && t.codes && !n.codes.every((c) => t.codes!.has(c))) continue;
    if (!family && t.codeCol === null && !t.nationalOnly) continue;
    if (t.nationalOnly && (n.grain !== "national" || !["murder", "homicide"].includes(n.measure) || n.dims.length === 0)) continue;
    if (n.grain === "agency" && !t.agency) continue;
    if (n.grain === "state" && !t.state) continue;
    if (n.grain === "national" && !t.state && !t.nationalOnly) continue;
    if (n.monthly && !t.monthly) continue;
    const unitOk = t.unit === n.unit || (n.unit === "arrests" && t.unit === "arrests");
    if (!unitOk) continue;
    if (!n.dims.every((d) => t.dims[d])) continue;
    if (n.measure === "dui" && t.key !== "arrestee_demo") continue;
    return t;
  }
  return null;
}

/* ================================================================== places, periods, completeness =============== */

type AgencyResolved = { label: string; byYear: Map<number, { oris: string[]; population: number }> };
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()).replace(/'S\b/g, "'s");

function resolveAgency(db: Database.Database, place: Extract<NPlace, { kind: "agency" }>, from: number, to: number): AgencyResolved | { decline: string } {
  const stateName = STATE_NAME_BY_CODE[place.state] ?? place.state;
  const span = from === to ? `${from}` : `${from}-${to}`;
  const byYear = new Map<number, { oris: string[]; population: number }>();
  let rows: { ori: string; year: number; population: number | null; city: string }[] = [];
  if (place.agencyKind === "county") {
    rows = db.prepare(`SELECT ori, year, population, city FROM agencies WHERE state = ? AND agency_type = 'County' AND upper(city) LIKE ? AND year BETWEEN ? AND ? ORDER BY year`)
      .all(place.state, `${place.name.toUpperCase()} COUNTY%`, from, to) as typeof rows;
    if (new Set(rows.map((r) => r.ori)).size > 1) return { decline: `I found more than one county agency for ${place.text.trim()}; name the specific department.` };
  } else {
    const plan = resolveNibrsPlaces(db, `robberies in ${place.name}, ${stateName} from ${from} to ${to}`);
    const resolved = plan?.places.find((p) => p.status === "resolved");
    if (!plan || !resolved) {
      const blocked = plan?.places[0];
      return { decline: blocked?.status === "ambiguous" ? `I found more than one NIBRS agency for ${place.name}; please name the specific department.` : `I couldn't find a NIBRS agency for ${place.name}, ${place.state} in ${span}.` };
    }
    for (const oy of resolved.oriYears) {
      const r = db.prepare(`SELECT ori, year, population, city FROM agencies WHERE ori = ? AND year = ?`).get(oy.ori, oy.year) as { ori: string; year: number; population: number | null; city: string } | undefined;
      if (r) rows.push(r);
    }
  }
  if (rows.length === 0) return { decline: `I couldn't find a NIBRS agency for ${place.text.trim()} in ${span}.` };
  for (const r of rows) {
    const cur = byYear.get(r.year) ?? { oris: [], population: 0 };
    cur.oris.push(r.ori);
    cur.population += Number(r.population ?? 0);
    byYear.set(r.year, cur);
  }
  const city = rows[rows.length - 1].city;
  return { label: `${titleCase(city)}, ${place.state}`, byYear };
}

function placeLabel(p: NPlace, agency?: AgencyResolved): string {
  if (p.kind === "national") return "United States";
  if (p.kind === "state") return p.name;
  return agency?.label ?? p.text;
}

type Bounds = { minYear: number; maxYear: number; maxMonth: number };
const boundsCache = new WeakMap<Database.Database, Map<string, Bounds | null>>();
function measuredBounds(db: Database.Database, t: Table): Bounds | null {
  let c = boundsCache.get(db);
  if (!c) { c = new Map(); boundsCache.set(db, c); }
  if (c.has(t.table)) return c.get(t.table)!;
  let b: Bounds | null = null;
  try {
    const r = db.prepare(`SELECT MIN(${t.yearCol}) AS lo, MAX(${t.yearCol}) AS hi FROM ${t.table}`).get() as { lo: number | null; hi: number | null };
    if (r.lo !== null && r.hi !== null) {
      const mm = t.monthly ? (db.prepare(`SELECT MAX(month) AS m FROM ${t.table} WHERE ${t.yearCol} = ?`).get(r.hi) as { m: number | null }).m ?? 12 : 12;
      b = { minYear: r.lo, maxYear: r.hi, maxMonth: mm };
    }
  } catch { b = null; }
  c.set(t.table, b);
  return b;
}

/** Years a period names. Explicit years are never moved; open and relative forms resolve against the measured bounds. */
function yearsOf(p: NPeriod, b: Bounds, now: Date): { years: number[]; note: string | null } | { decline: string } {
  const latestComplete = b.maxMonth === 12 ? b.maxYear : b.maxYear - 1;
  const span = (a: number, z: number) => Array.from({ length: Math.max(0, z - a + 1) }, (_, i) => a + i);
  switch (p.form) {
    case "year": return { years: [p.year], note: null };
    case "range": return { years: span(p.from, p.to), note: null };
    case "years": return { years: p.list, note: null };
    case "since": return { years: span(p.from, b.maxYear), note: `Through ${b.maxYear}, the latest year in this data.` };
    case "last": return { years: span(latestComplete - p.n + 1, latestComplete), note: `The last ${p.n} complete years in this data (${latestComplete - p.n + 1}-${latestComplete}).` };
    case "lastyear": return { years: [now.getFullYear() - 1], note: null };
    case "latest":
    case "none": return { years: [latestComplete], note: `The latest complete year in this data (${latestComplete}).` };
    case "month": return { years: [p.year], note: null };
    case "monthrange": return { years: span(p.from[0], p.to[0]), note: null };
  }
}

type Completeness = { months: Map<string, number>; summary: Map<string, number> };
function loadCompleteness(db: Database.Database, oris: string[], years: number[]): Completeness {
  const months = new Map<string, number>();
  const summary = new Map<string, number>();
  if (oris.length === 0 || years.length === 0) return { months, summary };
  const list = oris.map(q).join(",");
  for (const r of db.prepare(`SELECT ori, year, months_reported FROM nibrs_agency_completeness WHERE ori IN (${list}) AND year BETWEEN ${Math.min(...years)} AND ${Math.max(...years)}`).all() as { ori: string; year: number; months_reported: number }[]) months.set(`${r.ori}|${r.year}`, Number(r.months_reported));
  for (const r of db.prepare(`SELECT ori, year, COUNT(DISTINCT month) AS m FROM summary_city_monthly WHERE ori IN (${list}) AND year BETWEEN ${Math.min(...years)} AND ${Math.max(...years)} GROUP BY ori, year`).all() as { ori: string; year: number; m: number }[]) summary.set(`${r.ori}|${r.year}`, Number(r.m));
  return { months, summary };
}

/** One agency-year cell's completeness: whether its count (or rate) is shown, and the note. */
function agencyCell(c: Completeness, oris: string[], year: number, unit: "count" | "rate", now: Date): { display: boolean; note: string | null } {
  const months = Math.min(...oris.map((o) => c.months.get(`${o}|${year}`) ?? 0));
  const summary = Math.max(0, ...oris.map((o) => c.summary.get(`${o}|${year}`) ?? 0));
  const d = decideNibrsCompleteness({ year, currentYear: now.getFullYear(), reportingMonths: months, summaryMonths: summary, unit });
  if (d.display && !d.partial) return { display: true, note: null };
  if (d.display && d.partial) return { display: true, note: `partial year (January-${MONTH_NAMES[Math.max(1, summary) - 1]})` };
  if (months === 0 && summary === 0) return { display: false, note: "no report" };
  if (year === now.getFullYear() && unit === "rate") return { display: false, note: "rate needs a complete 12-month year" };
  return { display: false, note: `incomplete year (${months} of 12 months reported)` };
}


/** The months-weighted population of the agencies eligible for a rate (population on file), and their count. */
function cohort(db: Database.Database, stateCode: string | null, year: number): { agencies: number; population: number } {
  const r = db.prepare(`SELECT COUNT(DISTINCT c.ori) AS n, SUM(a.population * c.months_reported / 12.0) AS p FROM nibrs_agency_completeness c JOIN agencies a ON a.ori = c.ori AND a.year = c.year WHERE c.year = ? AND c.months_reported > 0 AND a.population > 0${stateCode ? " AND a.state = ?" : ""}`)
    .get(...(stateCode ? [year, stateCode] : [year])) as { n: number; p: number | null };
  return { agencies: Number(r.n ?? 0), population: Number(r.p ?? 0) };
}
/** r3.1 F3: agencies that reported at all (any month), with NO population condition. */
function presence(db: Database.Database, stateCode: string | null, year: number): number {
  const r = db.prepare(`SELECT COUNT(DISTINCT c.ori) AS n FROM nibrs_agency_completeness c JOIN agencies a ON a.ori = c.ori AND a.year = c.year WHERE c.year = ? AND c.months_reported > 0${stateCode ? " AND a.state = ?" : ""}`)
    .get(...(stateCode ? [year, stateCode] : [year])) as { n: number };
  return Number(r.n ?? 0);
}
const placeName = (p: NPlace) => (p.kind === "state" ? p.name : p.kind === "national" ? "the United States" : p.text);
const noAgencies = (p: NPlace, period: string | number) => `no agencies in ${placeName(p)} reported to NIBRS in ${period}`;
/** r2 §4: the cohort of EACH year the answer covers, with the reporting agencies left out of rates named. */
function cohortSentence(place: NPlace, years: number[], db: Database.Database): string {
  const code = place.kind === "state" ? place.code : null;
  const where = place.kind === "state" ? ` in ${place.name}` : "";
  const each = [...new Set(years)].sort((a, b) => a - b).map((y) => {
    const c = cohort(db, code, y); const all = presence(db, code, y);
    const noPop = all - c.agencies;
    return `${y}: ${all.toLocaleString("en-US")} agencies, serving about ${Math.round(c.population).toLocaleString("en-US")} people${noPop > 0 ? ` (${noPop} with no population on file, left out of rates)` : ""}`;
  });
  return `This covers only the agencies that reported to NIBRS for at least one month of each year${where} (${each.join("; ")}; population weighted by months reported); it is not an estimate for agencies that didn't report.`;
}
const RATE_DISCLAIMER = "This is a difficult calculation because not every law enforcement agency reports to NIBRS, and some that do may not report complete data for all 12 months. The population used is adjusted to reflect only agencies that actively reported data (weighted by the number of months they submitted).";

/* ================================================================== the typed query builder (r3) ================== */

/**
 * r3 (L13): the ONLY writer of what a typed statement applied. Each method emits one SQL fragment and records exactly
 * what that fragment restricts, in the same call. A restriction this builder did not emit cannot be in a record.
 * `fixed()` emits table semantics that are not request parts (the all_dv row, the property descriptions of a measure,
 * the rate-eligibility joins) and records nothing. scripts/test-nibrs-typed-applied-sites.ts pins this.
 */
type OperandRole = "value" | "numerator" | "denominator" | "window";
export type OperandRecord = { role: OperandRole; table: string; unit: Unit | null; family: string | null; codes: string[]; years: number[]; place: PlaceSet | null; entities: string[]; filters: string[]; breakdowns: string[]; clearanceCols: string[] };
class TypedQuery {
  readonly rec: OperandRecord;
  private readonly conds: string[] = [];
  private readonly joins: string[] = [];
  private readonly keys: string[] = [];
  private readonly cols: string[] = [];
  constructor(role: OperandRole, private readonly from: string, t: { unit?: Unit | null; family?: string | null }) {
    this.rec = { role, table: from, unit: t.unit ?? null, family: t.family ?? null, codes: [], years: [], place: null, entities: [], filters: [], breakdowns: [], clearanceCols: [] };
  }
  codes(col: string, codes: string[]): this { if (codes.length) { this.conds.push(`${col} IN (${codes.map(q).join(", ")})`); this.rec.codes = [...codes]; } return this; }
  /** A table that holds only these codes (no code column): reading it IS the code restriction. */
  tableCodes(codes: string[]): this { this.rec.codes = [...codes]; return this; }
  years(col: string, years: number[]): this { const ys = [...new Set(years)].sort((a, b) => a - b); this.conds.push(`${col} IN (${ys.join(", ")})`); this.rec.years = ys; return this; }
  agencyYears(oriCol: string, yearCol: string, place: Extract<NPlace, { kind: "agency" }>, pairs: [string, number][]): this {
    this.conds.push(`(${pairs.map(([o, y]) => `(${oriCol} = ${q(o)} AND ${yearCol} = ${y})`).join(" OR ")})`);
    this.rec.place = placeIs.agency(place.name, place.state); this.rec.entities.push("agency", place.agencyKind); return this;
  }
  agencyOris(oriCol: string, place: Extract<NPlace, { kind: "agency" }>, oris: string[]): this {
    this.conds.push(`${oriCol} IN (${oris.map(q).join(", ")})`);
    this.rec.place = placeIs.agency(place.name, place.state); this.rec.entities.push("agency", place.agencyKind); return this;
  }
  state(col: string, place: Extract<NPlace, { kind: "state" }>): this { this.conds.push(`${col} = ${q(place.code)}`); this.rec.place = placeIs.state(place.name); return this; }
  nation(usCol: string | null): this { if (usCol) this.conds.push(`${usCol} = 'US'`); this.rec.place = placeIs.national; return this; }
  filter(fv: string, col: string, vals: string[]): this { this.conds.push(`${col} IN (${vals.map(q).join(", ")})`); this.rec.filters.push(fv); return this; }
  entity(entity: string, cond: string | null): this { if (cond) this.conds.push(cond); this.rec.entities.push(entity); return this; }
  fixed(cond: string): this { this.conds.push(cond); return this; }
  join(clause: string): this { this.joins.push(clause); return this; }
  groupYear(col: string): this { this.cols.push(`${col} AS y`); this.keys.push("y"); return this; }
  groupMonth(): this { this.cols.push("month AS m"); this.keys.push("m"); return this; }
  groupOri(col: string): this { this.cols.push(`${col} AS o`); this.keys.push("o"); return this; }
  groupBy(dim: string, expr: string): this { this.cols.push(`${expr} AS cat`); this.keys.push("cat"); this.rec.breakdowns.push(dim); return this; }
  value(expr: string, alias = "v"): this { this.cols.push(`${expr} AS ${alias}`); return this; }
  clearance(cols: string[]): this { for (const c of cols) this.cols.push(`SUM(${c}) AS ${c}`); this.rec.clearanceCols.push(...cols); return this; }
  /** The offense total as a share's denominator (offenses, not clearances): recorded as that column. */
  offenseTotal(): this { this.cols.push("SUM(total_offenses) AS total_offenses"); this.rec.clearanceCols.push("total_offenses"); return this; }
  clearanceExpr(expr: string, alias: string): this { this.cols.push(`${expr} AS ${alias}`); this.rec.clearanceCols.push(alias); return this; }
  sql(): string {
    const where = this.conds.length ? ` WHERE ${this.conds.join(" AND ")}` : "";
    const group = this.keys.length ? ` GROUP BY ${this.keys.join(", ")} ORDER BY ${this.keys.join(", ")}` : "";
    return `SELECT ${this.cols.join(", ")} FROM ${this.from}${this.joins.length ? ` ${this.joins.join(" ")}` : ""}${where}${group}`;
  }
} // end TypedQuery

type Fetch = { table: Table; place: NPlace; agency?: AgencyResolved; codes: string[]; filters: string[]; years: number[]; months?: boolean; by?: string | null; role?: OperandRole; agencyGrain?: boolean; qualify?: boolean };
/** One summary-table statement for a request, built through the builder. */
function statement(f: Fetch): TypedQuery | { decline: string } {
  const t = f.table;
  const base = f.place.kind !== "agency" && t.stateTable && !f.agencyGrain ? t.stateTable : t.table;
  const from = f.qualify ? `${base} x` : base;
  const c = (col: string) => (f.qualify && /^\w+$/.test(col) ? `x.${col}` : col);
  const x = new TypedQuery(f.role ?? "value", from, { unit: t.unit, family: t.family ?? null });
  if (t.codeCol) x.codes(c(t.codeCol), f.codes); else if (t.codes) x.tableCodes([...t.codes]);
  x.years(c(t.yearCol), f.years);
  if (f.place.kind === "agency") {
    const pairs = [...(f.agency?.byYear ?? new Map()).entries()].filter(([y]) => f.years.includes(y)).flatMap(([y, v]) => v.oris.map((o: string) => [o, y] as [string, number]));
    if (!pairs.length) return { decline: "no agency rows for the requested years" };
    x.agencyYears(c(t.oriCol!), c(t.yearCol), f.place, pairs);
  } else if (f.place.kind === "state") x.state(c(t.stateCol!), f.place);
  else x.nation(t.usStateRows ? c(t.stateCol!) : null);
  for (const fv of f.filters) {
    const [dim, val] = fv.split(":");
    const d = t.dims[dim];
    const vals = d?.values?.(val);
    if (!d || !vals) return { decline: `the table that fits this request doesn't record ${filterLabel(fv)}` };
    x.filter(fv, c(d.col), vals);
  }
  x.groupYear(c(t.yearCol));
  if (f.months) x.groupMonth();
  if (f.by) x.groupBy(f.by, c(t.dims[f.by].col));
  x.value(t.count);
  return x;
}

/* ================================================================== operands -> applied (r3.1 F1) ================= */

const sameList = (a: unknown[], b: unknown[]) => JSON.stringify([...a].map(String).sort()) === JSON.stringify([...b].map(String).sort());
const intersect = (lists: string[][]) => (lists.length ? lists.reduce((acc, l) => acc.filter((x) => l.includes(x))) : []);

/** Operands that must agree everywhere (a category's groups, a series' places' statements): place, years, filters. */
function agreeing(ops: OperandRecord[]): string | null {
  for (const o of ops.slice(1)) {
    if (JSON.stringify(o.place) !== JSON.stringify(ops[0].place)) return "the place";
    if (!sameList(o.years, ops[0].years)) return "the period";
    if (!sameList(o.filters, ops[0].filters)) return "the conditions";
  }
  return null;
}
/** A share: population restrictions in BOTH operands; subset restrictions in the numerator only; same measure, place, period. */
function shareOperands(num: OperandRecord, den: OperandRecord, population: string[], subset: string[]): string | null {
  for (const f of population) if (!num.filters.includes(f) || !den.filters.includes(f)) return filterLabel(f);
  for (const f of subset) if (!num.filters.includes(f) || den.filters.includes(f)) return filterLabel(f);
  if (!sameList(num.codes, den.codes) && !(num.family && num.family === den.family)) return "the offense";
  if (JSON.stringify(num.place) !== JSON.stringify(den.place)) return "the place";
  if (!sameList(num.years, den.years)) return "the period";
  return null;
}

/**
 * The record of what the answer applied, built from its statements' records only: per measure the codes (or the
 * family) they read, the units of their tables, the filters EVERY value operand applied (intersection), their
 * breakdowns, places, entities and years. Post-query operations are added by `post` at their computing lines.
 */
function appliedFrom(groups: { measure: string; ops: OperandRecord[] }[]): NibrsApplied {
  const a: NibrsApplied = { codeGroups: [], families: [], units: [], filters: [], breakdowns: [], grains: [], periodValues: [], entities: [], lists: [], change: [], thresholds: [] };
  const places: PlaceSet[] = [];
  const valueOps: OperandRecord[] = [];
  for (const g of groups) {
    const ops = g.ops.filter((o) => o.role !== "denominator");
    if (!ops.length) continue;
    const family = FAMILY_OF[g.measure];
    if (family && ops.every((o) => o.family === family)) a.families!.push(g.measure);
    else a.codeGroups!.push([...new Set(ops.flatMap((o) => o.codes))]);
    for (const o of ops) {
      if (o.unit && !a.units!.includes(o.unit)) a.units!.push(o.unit);
      if (o.place) places.push(o.place);
      for (const e of o.entities) if (!a.entities!.includes(e)) a.entities!.push(e);
      for (const b of o.breakdowns) if (!a.breakdowns!.includes(b)) a.breakdowns!.push(b);
      if (o.clearanceCols.length) a.clearance = true;
    }
    valueOps.push(...ops);
  }
  a.filters = intersect(valueOps.map((o) => o.filters));
  const yearOps = valueOps.filter((o) => o.role !== "window");
  const ys = [...new Set(yearOps.flatMap((o) => o.years))].sort((x, y) => x - y);
  if (ys.length && yearOps.every((o) => sameList(o.years, ys))) {
    if (ys[ys.length - 1] - ys[0] + 1 === ys.length) a.years = { start: ys[0], end: ys[ys.length - 1] };
    if (ys.length === 2) a.periodValues!.push(`years:${ys[0]}:${ys[1]}`);
  }
  a.places = placeIs.any(...places);
  return a;
}
/** r4.1: a clearance share's operands agree on offense, place and period, and the denominator is of its declared kind. */
function clearanceOperands(num: OperandRecord, den: OperandRecord, kind: "restricted" | "clearances" | "offenses"): string | null {
  if (!sameList(num.codes, den.codes)) return "the offense";
  if (JSON.stringify(num.place) !== JSON.stringify(den.place)) return "the place";
  if (!sameList(num.years, den.years)) return "the period";
  if (kind === "offenses") return sameList(den.clearanceCols, ["total_offenses"]) ? null : "the offense total";
  return num.clearanceCols.every((c) => den.clearanceCols.includes(c)) ? null : "the clearances asked about";
}
/**
 * r4 §2: the clearance conditions a share applied, read from its operands' recorded columns only. A subset value is
 * applied when all its columns are summed in the numerator; a population value when the denominator sums exactly the
 * population's columns and the numerator lies inside them.
 */
function clearanceConditionsApplied(num: OperandRecord, den: OperandRecord, subset: string[], population: string[], kind: "restricted" | "clearances" | "offenses"): string[] {
  const cols = (f: string) => clearanceCols(f.split(":")[1]);
  const out = subset.filter((f) => cols(f).every((c) => num.clearanceCols.includes(c)));
  if (kind === "restricted") {
    const popCols = [...new Set(population.flatMap(cols))];
    if (sameList(popCols, den.clearanceCols) && num.clearanceCols.every((c) => den.clearanceCols.includes(c))) out.push(...population);
  }
  return out;
}
/** Post-query operations, recorded at the line that performs them (each call is an allowlisted applied-site). */
function post(a: NibrsApplied): { set<K extends keyof NibrsApplied>(k: K, v: NibrsApplied[K]): void; push(k: "grains" | "periodValues" | "lists" | "change" | "filters" | "units", v: string): void } {
  return {
    set: (k, v) => { a[k] = v; },
    push: (k, v) => { const arr = (a[k] ?? (a[k] = [] as never)) as string[]; if (!arr.includes(v)) arr.push(v); },
  };
}
const periodFormValue = (p: NPeriod): string | null => (p.form === "last" ? `last:${p.n}` : p.form === "lastyear" ? "lastyear" : p.form === "latest" ? "latest" : null);
const monthPeriodValue = (p: NPeriod): string | null => (p.form === "month" ? `month:${ym(p.year, p.month)}` : p.form === "monthrange" ? `monthrange:${ym(p.from[0], p.from[1])}:${ym(p.to[0], p.to[1])}` : null);

/** The months a month or month-range period names, in order. */
function monthsOf(p: NPeriod): [number, number][] | null {
  if (p.form === "month") return [[p.year, p.month]];
  if (p.form !== "monthrange") return null;
  const out: [number, number][] = [];
  for (let y = p.from[0], m = p.from[1]; y < p.to[0] || (y === p.to[0] && m <= p.to[1]); m === 12 ? (y += 1, m = 1) : (m += 1)) out.push([y, m]);
  return out;
}
const outOfBounds = (b: Bounds, y: number, m?: number) => y < b.minYear || y > b.maxYear || (m !== undefined && y === b.maxYear && m > b.maxMonth);
const noData = (label: string) => `no data in this source for ${label}`;
/** The years NIBRS holds at all (the offense table), so a sparse table's first year is never read as "no data". */
const sourceBounds = (db: Database.Database) => measuredBounds(db, TABLES.find((t) => t.key === "offense_monthly")!);
const outsideSource = (db: Database.Database, y: number) => { const b = sourceBounds(db); return Boolean(b && (y < b.minYear || y > b.maxYear)); };
const windowOf = (y: number, m: number): [number, number][] => { const w: [number, number][] = []; for (let k = 11; k >= 0; k -= 1) { const d = new Date(Date.UTC(y, m - 1 - k, 1)); w.push([d.getUTCFullYear(), d.getUTCMonth() + 1]); } return w; };

/** Months in which any agency of a state (or the nation) reported: the R4 evidence proxy at state grain, no population rule. */
function placeMonthEvidence(db: Database.Database, place: NPlace, years: number[]): Set<string> {
  const out = new Set<string>();
  const st = place.kind === "state" ? ` AND state = ${q(place.code)}` : "";
  for (const r of db.prepare(`SELECT DISTINCT year, month FROM summary_city_monthly WHERE year IN (${[...new Set(years)].join(", ")})${st}`).all() as { year: number; month: number }[]) out.add(`${r.year}|${r.month}`);
  return out;
}
/** Agency-month evidence per ORI (R4), no population rule. */
function monthEvidence(db: Database.Database, oris: string[], years: number[]): Set<string> {
  const out = new Set<string>();
  if (!oris.length) return out;
  for (const r of db.prepare(`SELECT DISTINCT ori, year, month FROM summary_city_monthly WHERE ori IN (${oris.map(q).join(",")}) AND year IN (${[...new Set(years)].join(", ")})`).all() as { ori: string; year: number; month: number }[]) out.add(`${r.ori}|${r.year}|${r.month}`);
  return out;
}

/* ================================================================== compile ====================================== */

export async function compileNibrsSpec(spec: NibrsSpec, ctx: CompileContext): Promise<CompiledAnswer> {
  const answer = await compileNibrsSpecTypes(spec, ctx);
  // Stage 3b (owner decision 2026-10-11, plan r1.3): an answer that applies "commercial" names every location type it counted.
  const commercial = "filters" in spec && Array.isArray(spec.filters) && spec.filters.includes("location:commercial");
  if (answer.kind === "answer" && commercial) {
    const n = COMMERCIAL_LOCATION_NAMES;
    return { ...answer, explanation: `${answer.explanation} "Commercial" here means the business location types: ${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}.` };
  }
  return answer;
}

async function compileNibrsSpecTypes(spec: NibrsSpec, ctx: CompileContext): Promise<CompiledAnswer> {
  const statements: string[] = [];
  // Round 1 step B (step A crash L9590/L9591): a measure with no offense codes and no family table ("all crime") picked no
  // table and threw. NIBRS counts person crimes by victim and the rest by offense, so it asks which crimes, as Current
  // Trends does, instead of adding them into one total.
  const specMeasures = "measures" in spec && Array.isArray(spec.measures) ? spec.measures : "measure" in spec && typeof spec.measure === "string" ? [spec.measure] : [];
  if (specMeasures.some((m) => !(MEASURE_CODES[m]?.length) && !FAMILY_OF[m])) {
    return { kind: "clarify", explanation: "Which crimes do you want: violent crime, property crime, or a specific offense such as robbery or burglary? NIBRS counts crimes against people by victim and other crimes by offense, so I won't add them into one total.", statements };
  }
  const run = async (sql: string) => { statements.push(sql); return ctx.run(sql); };
  try {
    switch (spec.type) {
      case "series": return await compileSeries(spec, ctx, run, statements);
      case "breakdown": return await compileBreakdown(spec, ctx, run, statements);
      case "share": return await compileShare(spec, ctx, run, statements);
      case "rank": return await compileRank(spec, ctx, run, statements);
      case "change": return await compileChange(spec, ctx, run, statements);
    }
  } catch (e) {
    return { kind: "decline", explanation: `I couldn't build this answer from the NIBRS summary tables (${e instanceof Error ? e.message : String(e)}), so I haven't answered with a number.`, statements };
  }
}

type RunFn = (sql: string) => Promise<Record<string, unknown>[]>;
const grainOfPlace = (p: NPlace): "agency" | "state" | "national" => (p.kind === "agency" ? "agency" : p.kind);
const unitLabelOf = (t: Table, codes: string[], measure: string): string => (measure === "dui" ? "arrests" : t.unitLabel ? t.unitLabel(codes) : t.unit);
const declineNoTable = (measure: string, unit: Unit, dims: string[], place: NPlace): string => {
  const parts = [`${MEASURE_LABEL[measure] ?? measure} ${unit}`, ...dims.map((d) => (d.includes(":") ? filterLabel(d) : `by ${d}`))];
  const where = place.kind === "agency" ? "for an agency" : place.kind === "state" ? "for a state" : "nationally";
  return `NIBRS has no summary table that holds ${parts.join(" with ")} ${where}, so I haven't answered with a number that leaves part of it out.`;
};
const appliedStatistic = (s: Statistic): NibrsApplied["statistic"] => (s === "rate" ? "rate" : s);
const operandFailure = (what: string) => `I couldn't apply ${what} to every part of this answer, so I haven't answered with a number that leaves it out.`;
/** Rate eligibility (r3.2): only agency-years with a population on file AND reporting count toward a rate's numerator. */
const ELIGIBLE_JOIN = (oriCol: string, yearCol: string) => `JOIN nibrs_agency_completeness rc ON rc.ori = ${oriCol} AND rc.year = ${yearCol} AND rc.months_reported > 0 JOIN agencies ra ON ra.ori = ${oriCol} AND ra.year = ${yearCol} AND ra.population > 0`;

async function compileSeries(spec: SeriesSpec, ctx: CompileContext, run: RunFn, statements: string[]): Promise<CompiledAnswer> {
  const rows: Row[] = [];
  const notes: string[] = [];
  const opGroups: { measure: string; ops: OperandRecord[] }[] = [];
  let statKeyApplied: NibrsApplied["statistic"] = null;
  const postOps: ((a: NibrsApplied) => void)[] = [];
  const filterText = spec.filters.length ? spec.filters.map(filterLabel).join("; ") : null;
  const filterDims = spec.filters.map((f) => f.split(":")[0]);
  const isValue = spec.statistic === "total_value" || spec.statistic === "average_value";
  if (isValue && !spec.filters.some((f) => f.startsWith("loss:"))) {
    return { kind: "clarify", explanation: "Which property loss should I total: stolen, recovered, damaged or seized? NIBRS records property value by loss type, so I won't combine them.", statements };
  }
  if ((spec.statistic === "rate" || spec.statistic === "clearance_rate") && spec.grain === "month") return { kind: "decline", explanation: "Rates are given for complete years, not for single months, so I haven't answered with a monthly rate.", statements };
  const monthList = monthsOf(spec.period);
  for (const place of spec.places) {
    for (const measure of spec.measures) {
      const allCodes = MEASURE_CODES[measure] ?? [];
      const family = FAMILY_OF[measure];
      const groups: { codes: string[]; unit: Unit }[] = [];
      if (spec.statistic === "clearance_rate") groups.push({ codes: allCodes, unit: "offenses" });
      else if (family) groups.push({ codes: [], unit: spec.unit ?? defaultUnit(measure) });
      else if (spec.unit) {
        const monthlyNeed = spec.grain === "month" || spec.grain === "rolling";
        const byTable = new Map<string, string[]>();
        for (const c of allCodes) {
          const t = selectTable({ measure, codes: [c], unit: spec.unit, dims: filterDims, grain: grainOfPlace(place), monthly: monthlyNeed, filters: spec.filters });
          if (!t) return { kind: "decline", explanation: `NIBRS doesn't count ${c === "120" ? "robbery" : c} by ${spec.unit} in a table that fits this request, so I can't give ${MEASURE_LABEL[measure]} ${spec.unit} without leaving ${c === "120" ? "robbery" : "part of it"} out.`, statements };
          byTable.set(t.key, [...(byTable.get(t.key) ?? []), c]);
        }
        for (const codes of byTable.values()) groups.push({ codes, unit: spec.unit });
      } else {
        const person = allCodes.filter((c) => PERSON_CODES.has(c));
        const other = allCodes.filter((c) => !PERSON_CODES.has(c));
        if (person.length) groups.push({ codes: person, unit: "victims" });
        if (other.length) groups.push({ codes: other, unit: measure === "drug_possession" ? "incidents" : measure === "dui" ? "arrests" : "offenses" });
      }
      const monthly = spec.grain === "month" || spec.grain === "rolling";
      const picked = groups.map((g) => ({ g, t: selectTable({ measure, codes: g.codes, unit: g.unit === "incidents" && !family && measure === "drug_possession" && !filterDims.length ? "offenses" : g.unit, dims: filterDims, grain: grainOfPlace(place), monthly, filters: spec.filters }) }));
      const missing = picked.find((p) => !p.t);
      if (missing) {
        if (spec.unit && !family && groups[0].codes.length > 1) {
          const bad = groups[0].codes.filter((c) => !selectTable({ measure, codes: [c], unit: spec.unit!, dims: filterDims, grain: grainOfPlace(place), monthly, filters: spec.filters }));
          if (bad.length) return { kind: "decline", explanation: `NIBRS counts ${bad.includes("120") ? "robbery" : bad.join(", ")} by offense, not by ${spec.unit}, so I can't give ${MEASURE_LABEL[measure]} ${spec.unit} without leaving ${bad.includes("120") ? "robbery" : "part of it"} out.`, statements };
        }
        return { kind: "decline", explanation: monthly && !groups.some((g) => selectTable({ measure, codes: g.codes, unit: g.unit, dims: filterDims, grain: grainOfPlace(place), monthly: false, filters: spec.filters }) === null)
          ? `NIBRS's ${MEASURE_LABEL[measure]} figures with those conditions are yearly; monthly or rolling figures aren't available for them.`
          : declineNoTable(measure, missing.g.unit, spec.filters, place), statements };
      }
      const tables = picked.map((p) => p.t!);
      // Owner decision A: a firearm victim count from the demographics table states its first-listed-weapon basis.
      { const fw = tables.map((t) => firstWeaponNote(spec.filters ?? [], t)).find(Boolean); if (fw) notes.push(fw); }
      const bounds = measuredBounds(ctx.db, tables[0]);
      if (!bounds) return { kind: "decline", explanation: "The latest year in this data can't be confirmed, so I haven't answered.", statements };
      const yr = yearsOf(spec.period, bounds, ctx.now);
      if ("decline" in yr) return { kind: "decline", explanation: yr.decline, statements };
      if (yr.note) notes.push(yr.note);
      // r3.1 F2: rolling endpoints are recorded apart from their inputs; the inputs are every endpoint window's years.
      const endpoints: [number, number][] = spec.grain === "rolling"
        ? (monthList ?? yr.years.flatMap((y) => Array.from({ length: 12 }, (_, i) => [y, i + 1] as [number, number])).filter(([y, m]) => !outOfBounds(bounds, y, m)))
        : [];
      const years = spec.grain === "rolling"
        ? [...new Set(endpoints.flatMap(([y, m]) => windowOf(y, m).map(([yy]) => yy)))].sort((a, b) => a - b)
        : monthList ? [...new Set(monthList.map(([y]) => y))] : yr.years;
      let agency: AgencyResolved | undefined;
      if (place.kind === "agency") {
        const a = resolveAgency(ctx.db, place, Math.min(...years), Math.max(...years));
        if ("decline" in a) return { kind: "decline", explanation: a.decline, statements };
        agency = a;
      }
      const label = placeLabel(place, agency);
      const unitLabel = spec.unit && !family ? (spec.unit === "arrests" ? unitLabelOf(tables[0], groups[0].codes, measure) : spec.unit) : groups.length > 1 ? "mixed" : unitLabelOf(tables[0], groups[0].codes, measure);
      const statKey = spec.grain === "rolling" ? (spec.statistic === "rate" ? "rolling_12_month_rate_per_100k" : "rolling_12_month_count")
        : spec.statistic === "rate" ? "rate_per_100k" : spec.statistic === "count" ? "count" : spec.statistic;
      const ops: OperandRecord[] = [];
      opGroups.push({ measure, ops });

      if (spec.grain === "rolling") {
        // Agency: the agency's own monthly cells. State/national: per (ori, month) cells from EVERY group (r2), agency grain.
        const oris = agency ? [...agency.byYear.values()].flatMap((v) => v.oris) : (ctx.db.prepare(`SELECT DISTINCT ori FROM agencies WHERE ${place.kind === "state" ? `state = ${q(place.code)} AND ` : ""}year IN (${years.join(", ")})`).all() as { ori: string }[]).map((r) => r.ori);
        const ev = monthEvidence(ctx.db, oris, years);
        const cells = new Map<string, number>();
        for (const p of picked) {
          const x = statement({ table: p.t!, place, agency, codes: family === "property" ? [] : p.g.codes, filters: spec.filters, years, months: true, role: "window", agencyGrain: true });
          if ("decline" in x) return { kind: "decline", explanation: `I couldn't build this answer: ${x.decline}.`, statements };
          if (!agency) x.groupOri(p.t!.oriCol!);
          for (const r of await run(x.sql())) { const k = agency ? `${r.y}|${r.m}` : `${r.o}|${r.y}|${r.m}`; cells.set(k, (cells.get(k) ?? 0) + Number(r.v ?? 0)); }
          ops.push(x.rec);
        }
        const popOf = (ori: string, y: number) => Number((ctx.db.prepare("SELECT population FROM agencies WHERE ori = ? AND year = ?").get(ori, y) as { population: number } | undefined)?.population ?? 0);
        for (const [y, m] of endpoints) {
          if (outOfBounds(bounds, y, m)) { rows.push(row(ym(y, m), label, measure, unitLabel, filterText, statKey, null, noData(ym(y, m)))); continue; }
          const window = windowOf(y, m);
          if (agency) {
            const missingMonths = window.filter(([yy, mm]) => !(agency!.byYear.get(yy)?.oris ?? []).some((o) => ev.has(`${o}|${yy}|${mm}`)));
            if (missingMonths.length) { rows.push(row(ym(y, m), label, measure, unitLabel, filterText, statKey, null, `no evidence of reporting in ${missingMonths.map(([a, b]) => ym(a, b)).join(", ")}`)); continue; }
            const count = window.reduce((a, [yy, mm]) => a + (cells.get(`${yy}|${mm}`) ?? 0), 0);
            const pop = agency.byYear.get(y)?.population ?? 0;
            if (spec.statistic === "rate" && !(pop > 0)) { rows.push(row(ym(y, m), label, measure, unitLabel, filterText, statKey, null, "no population on file for this agency")); continue; }
            rows.push(row(ym(y, m), label, measure, unitLabel, filterText, statKey, spec.statistic === "rate" ? r1((count * 100000) / pop) : count, null));
          } else {
            // r3.1 F3 / r3.2: presence is any agency-month of evidence; a rate counts only eligible agency-months on BOTH sides.
            let count = 0; let rateCount = 0; let popSum = 0; let any = false;
            for (const [yy, mm] of window) for (const o of oris) if (ev.has(`${o}|${yy}|${mm}`)) {
              any = true;
              const c = cells.get(`${o}|${yy}|${mm}`) ?? 0;
              count += c;
              const pop = popOf(o, yy);
              if (pop > 0) { rateCount += c; popSum += pop; }
            }
            if (!any) { rows.push(row(ym(y, m), label, measure, unitLabel, filterText, statKey, null, "no evidence of reporting in this window")); continue; }
            if (spec.statistic === "rate" && !(popSum > 0)) { rows.push(row(ym(y, m), label, measure, unitLabel, filterText, statKey, null, "no reporting agency with a population on file")); continue; }
            rows.push(row(ym(y, m), label, measure, unitLabel, filterText, statKey, spec.statistic === "rate" ? r1((rateCount * 100000) / (popSum / 12)) : count, null));
          }
        }
        statKeyApplied = spec.statistic === "rate" ? "rate" : "count";
        postOps.push((a) => {
          post(a).set("rolling", 12); // applied-site: rolling-window-sum
          post(a).push("grains", "month"); // applied-site: rolling-monthly-endpoints
          const ey = [...new Set(endpoints.map(([yy]) => yy))].sort((p, q2) => p - q2);
          if (ey.length && ey[ey.length - 1] - ey[0] + 1 === ey.length) post(a).set("years", { start: ey[0], end: ey[ey.length - 1] }); // applied-site: rolling-endpoint-years
          if (ey.length === 2) post(a).push("periodValues", `years:${ey[0]}:${ey[1]}`); // applied-site: rolling-endpoint-years
          const mv = monthPeriodValue(spec.period); if (monthList && mv) post(a).push("periodValues", mv); // applied-site: rolling-endpoint-months
        });
        notes.push(NIBRS_COMPLETENESS_PROXY_DISCLOSURE);
        if (place.kind !== "agency") notes.push(`Each 12-month figure sums only the agencies that reported in each month of the window (an agency counts for a month when it has any reported offense that month), so it is not an estimate for agencies that didn't report.`);
        if (place.kind !== "agency" && spec.statistic === "rate") notes.push(RATE_DISCLAIMER);
        // Stage 3b r3 (R3.2'): agency = count / the end year's population; state or nation = eligible count / (popSum / 12).
        if (spec.statistic === "rate") recordWhyFacts({ kind: "rate", method: agency ? "nibrs-agency-rolling" : "nibrs-cohort-rolling", per: 100000, places: agency ? [label] : [] });
        continue;
      }

      // Annual and monthly cells: v = count (or value), c = the second operand (cleared, or record count).
      const cells = new Map<string, number>();
      // A state or national RATE reads agency rows restricted to rate-eligible agency-years (r3.2), so both operands match.
      const rateAgencyGrain = spec.statistic === "rate" && place.kind !== "agency" && picked.every((p) => Boolean(p.t!.oriCol));
      // A state-grain table (no agency column) can't leave out reporting agencies without a population: its rate is given
      // only when every reporting agency has one, so both operands cover the same agencies (r3.2).
      const rateNeedsMatch = spec.statistic === "rate" && place.kind !== "agency" && !rateAgencyGrain;
      for (const p of picked) {
        const x = statement({ table: p.t!, place, agency, codes: family === "property" ? [] : p.g.codes, filters: spec.filters, years, months: monthly, agencyGrain: rateAgencyGrain, qualify: rateAgencyGrain });
        if ("decline" in x) return { kind: "decline", explanation: `I couldn't build this answer: ${x.decline}.`, statements };
        if (rateAgencyGrain) x.join(ELIGIBLE_JOIN(`x.${p.t!.oriCol!}`, `x.${p.t!.yearCol}`));
        if (family === "property" && measure === "motor_vehicle_property") x.fixed(`property_description IN (${MV_DESCRIPTIONS.map(q).join(", ")})`);
        if (spec.statistic === "average_value") x.value("SUM(record_count)", "c");
        if (spec.statistic === "clearance_rate") x.clearance(["cleared_count"]);
        if (p.t!.key === "dv_trends" && !spec.filters.some((f) => f.startsWith("dv:"))) x.fixed("dv_category = 'all_dv'");
        for (const r of await run(x.sql())) {
          const key = monthly ? `${r.y}|${r.m}` : `${r.y}`;
          cells.set(key, (cells.get(key) ?? 0) + Number(r.v ?? 0));
          const second = spec.statistic === "clearance_rate" ? r.cleared_count : r.c;
          if (spec.statistic === "clearance_rate" || spec.statistic === "average_value") cells.set(`c|${key}`, (cells.get(`c|${key}`) ?? 0) + Number(second ?? 0));
        }
        ops.push(x.rec);
      }
      const mismatch = agreeing(ops);
      if (mismatch) return { kind: "decline", explanation: operandFailure(mismatch), statements };
      const comp = agency ? loadCompleteness(ctx.db, [...agency.byYear.values()].flatMap((v) => v.oris), years) : null;
      const stateCode = place.kind === "state" ? place.code : null;

      if (spec.grain === "month") {
        const placeEv = agency ? monthEvidence(ctx.db, [...agency.byYear.values()].flatMap((v) => v.oris), years) : placeMonthEvidence(ctx.db, place, years);
        const hasEv = (y: number, m: number) => (agency ? (agency.byYear.get(y)?.oris ?? []).some((o) => placeEv.has(`${o}|${y}|${m}`)) : placeEv.has(`${y}|${m}`));
        const targets: [number, number][] = monthList ?? yr.years.flatMap((y) => Array.from({ length: 12 }, (_, i) => [y, i + 1] as [number, number])).filter(([y, m]) => !outOfBounds(bounds, y, m));
        for (const [y, m] of targets) {
          if (outOfBounds(bounds, y, m)) { rows.push(row(ym(y, m), label, measure, unitLabel, filterText, statKey, null, noData(ym(y, m)))); continue; }
          if (!hasEv(y, m)) { rows.push(row(ym(y, m), label, measure, unitLabel, filterText, statKey, null, "no evidence of reporting")); continue; }
          rows.push(row(ym(y, m), label, measure, unitLabel, filterText, statKey, cells.get(`${y}|${m}`) ?? 0, null));
        }
        statKeyApplied = "count";
        postOps.push((a) => {
          post(a).push("grains", "month"); // applied-site: monthly-rows
          const mv = monthPeriodValue(spec.period); if (monthList && mv) post(a).push("periodValues", mv); // applied-site: month-selection
        });
        if (place.kind !== "agency") notes.push(cohortSentence(place, years, ctx.db));
        notes.push(NIBRS_COMPLETENESS_PROXY_DISCLOSURE);
        continue;
      }

      const periodYears = yr.years;
      statKeyApplied = appliedStatistic(spec.statistic);
      /** One year's figure, with its operands kept for pooled totals. */
      const valueFor = (y: number): { value: number | null; note: string | null; num: number; den: number } => {
        const raw = cells.get(`${y}`) ?? 0;
        const second = cells.get(`c|${y}`) ?? 0;
        if (outsideSource(ctx.db, y)) return { value: null, note: noData(String(y)), num: 0, den: 0 };
        const computed = (note: string | null, pop: number) => {
          if (spec.statistic === "rate") return pop > 0 ? { value: r1((raw * 100000) / pop), note, num: raw, den: pop } : { value: null, note: note ?? (agency ? "no population on file for this agency" : "no reporting agency with a population on file"), num: 0, den: 0 };
          if (spec.statistic === "clearance_rate") return { value: raw ? r1((second / raw) * 100) : null, note: raw ? note : note ?? "no offenses reported", num: second, den: raw };
          if (spec.statistic === "average_value") return { value: second ? r1(raw / second) : null, note, num: raw, den: second };
          return { value: raw, note, num: raw, den: 1 };
        };
        if (agency) {
          const oris = agency.byYear.get(y)?.oris ?? [];
          if (!oris.length) return { value: null, note: "no report", num: 0, den: 0 };
          const cell = agencyCell(comp!, oris, y, spec.statistic === "rate" ? "rate" : "count", ctx.now);
          if (!cell.display) return { value: null, note: cell.note, num: 0, den: 0 };
          return computed(cell.note, agency.byYear.get(y)!.population);
        }
        // r3: a state or national year with no reporting agency is unavailable, never 0.
        if (presence(ctx.db, stateCode, y) === 0) return { value: null, note: noAgencies(place, y), num: 0, den: 0 };
        const stateNote = y === bounds.maxYear && bounds.maxMonth < 12 ? `partial year (January-${MONTH_NAMES[bounds.maxMonth - 1]})` : null;
        if (rateNeedsMatch) { const elig = cohort(ctx.db, stateCode, y).agencies; const all = presence(ctx.db, stateCode, y); if (elig !== all) return { value: null, note: `${all - elig} reporting agencies have no population on file and this table can't leave them out of the rate`, num: 0, den: 0 }; }
        return computed(stateNote, spec.statistic === "rate" ? cohort(ctx.db, stateCode, y).population : 0);
      };
      if (spec.grain === "total" && periodYears.length > 1) {
        if (spec.statistic === "rate") return { kind: "decline", explanation: "A rate over several years is given per year, so I haven't combined the years into one rate.", statements };
        const parts = periodYears.map(valueFor);
        const blank = periodYears.filter((_, i) => parts[i].value === null);
        const partial = periodYears.filter((y, i) => parts[i].value !== null && /^partial year/.test(String(parts[i].note ?? "")));
        const partialNote = partial.map((y) => String(parts[periodYears.indexOf(y)].note).replace(/^partial year/, `partial year ${y}`)).join("; ");
        const period = `${periodYears[0]}-${periodYears[periodYears.length - 1]}`;
        const num = parts.reduce((a, p) => a + p.num, 0);
        const den = parts.reduce((a, p) => a + p.den, 0);
        const total = blank.length ? null
          : spec.statistic === "clearance_rate" ? (den ? r1((num / den) * 100) : null)
            : spec.statistic === "average_value" ? (den ? r1(num / den) : null)
              : parts.reduce((a, p) => a + (p.value ?? 0), 0);
        rows.push(row(period, label, measure, unitLabel, filterText, statKey, total, blank.length ? `no complete figure for ${blank.join(", ")}` : partialNote || null));
        postOps.push((a) => post(a).set("combine", true)); // applied-site: period-total
        // Stage 3b r3 (R3.2''): a pooled clearance rate is the summed cleared over the summed reported.
        if (spec.statistic === "clearance_rate") recordWhyFacts({ kind: "rate", method: "nibrs-clearance-pooled", per: 100, places: [label] });
      } else {
        for (const y of periodYears) { const v = valueFor(y); rows.push(row(y, label, measure, unitLabel, filterText, statKey, v.value, v.note)); }
        if (periodYears.length > 1 || spec.grain === "year") postOps.push((a) => post(a).push("grains", "year")); // applied-site: per-year-rows
        // Stage 3b r3 (R3.2'/R3.2''): as valueFor computes each year.
        if (spec.statistic === "rate") recordWhyFacts({ kind: "rate", method: agency ? "nibrs-agency-annual" : "nibrs-cohort-annual", per: 100000, places: agency ? [label] : [] });
        if (spec.statistic === "clearance_rate") recordWhyFacts({ kind: "rate", method: "nibrs-clearance", per: 100, places: [label] });
      }
      const form = periodFormValue(spec.period);
      if (form) postOps.push((a) => post(a).push("periodValues", form)); // applied-site: relative-period-resolved-by-years-of
      if (place.kind !== "agency") notes.push(cohortSentence(place, periodYears, ctx.db));
      if (place.kind !== "agency" && spec.statistic === "rate") notes.push(RATE_DISCLAIMER);
      if (groups.length > 1 && !spec.unit) notes.push(`${MEASURE_LABEL[measure][0].toUpperCase()}${MEASURE_LABEL[measure].slice(1)} is the FBI's UCR-aligned category: crimes against persons are counted by victim and robbery by offense, added together.`);
      if (family === "property") notes.push("Property values exclude individual records valued at $1,000,000 or more (the summary's outlier rule, which removes NIBRS placeholder values).");
      if (tables.some((t) => t.key === "arrestee_demo") && groups.some((g) => g.codes.every((c) => GROUP_B.has(c)))) notes.push("Group B offenses like DUI are arrest-only data: NIBRS does not track incident counts for these offenses, only arrests.");
    }
  }
  const applied = appliedFrom(opGroups);
  post(applied).set("statistic", statKeyApplied); // applied-site: statistic-computed
  for (const f of postOps) f(applied);
  if (spec.places.length > 1) post(applied).set("versus", "places"); // applied-site: places-side-by-side
  const title = seriesTitle(rows, spec.measures, spec.grain, `${spec.measures.map((m) => MEASURE_LABEL[m] ?? m).join(", ")} — ${[...new Set(rows.map((r) => r.place))].join(", ")}`);
  return { kind: "answer", columns: SERIES, rows, title, explanation: [`Figures from the NIBRS summary tables, built from the question as asked.`, ...new Set(notes), NIBRS_RECENT_MATURATION_DISCLOSURE].join(" "), statements, applied };
}

function row(period: string | number, place: string, measure: string, unit: string, filter: string | null, statistic: string, value: number | null, note: string | null): Row {
  return { period, place, measure, unit, filter, statistic, value, note };
}

/** The unique total for a population (r1.1 R3), as a denominator operand: the base table for the unit, never overlapping rows. */
async function uniqueTotal(measure: string, unit: Unit, filters: string[], place: NPlace, agency: AgencyResolved | undefined, years: number[], run: RunFn): Promise<{ value: number; rec: OperandRecord } | null> {
  const codes = MEASURE_CODES[measure] ?? [];
  const dims = filters.map((f) => f.split(":")[0]);
  const family = FAMILY_OF[measure];
  const t = measure === "drug_possession" && unit === "incidents" && !dims.length
    ? TABLES.find((x) => x.key === "offense_monthly")!
    : selectTable({ measure, codes, unit, dims, grain: grainOfPlace(place), monthly: false, filters });
  if (!t) return null;
  if (dims.some((d) => t.dims[d]?.overlap)) return null;
  const x = statement({ table: t, place, agency, codes: family ? [] : codes, filters, years, role: "denominator" });
  if ("decline" in x) return null;
  if (t.key === "dv_trends") x.fixed("dv_category = 'all_dv'");
  const got = await run(x.sql());
  return { value: got.reduce((a, r) => a + Number(r.v ?? 0), 0), rec: x.rec };
}

async function compileBreakdown(spec: BreakdownSpec, ctx: CompileContext, run: RunFn, statements: string[]): Promise<CompiledAnswer> {
  const place = spec.place;
  const filterText = spec.filters.length ? spec.filters.map(filterLabel).join("; ") : null;
  if (spec.dim === "clearance-type" || spec.dim === "clearance-method") return compileClearanceBreakdown(spec, ctx, run, statements);
  const unit: Unit = spec.dim === "victim-offender-race" ? "pairs" : spec.unit ?? defaultUnit(spec.measure);
  const codes = MEASURE_CODES[spec.measure] ?? [];
  const dims = [...spec.filters.map((f) => f.split(":")[0]), spec.dim];
  const t = selectTable({ measure: spec.measure, codes, unit, dims, grain: grainOfPlace(place), monthly: false, filters: spec.filters });
  if (!t) {
    if (spec.dim === "hour" && place.kind === "agency") return { kind: "decline", explanation: "NIBRS's time-of-day summary is by state, not by agency, so I can't break this agency's figures down by hour of day.", statements };
    return { kind: "decline", explanation: declineNoTable(spec.measure, unit, [...spec.filters, spec.dim], place), statements };
  }
  const bounds = measuredBounds(ctx.db, t);
  if (!bounds) return { kind: "decline", explanation: "The latest year in this data can't be confirmed, so I haven't answered.", statements };
  const yr = yearsOf(spec.period, bounds, ctx.now);
  if ("decline" in yr) return { kind: "decline", explanation: yr.decline, statements };
  let agency: AgencyResolved | undefined;
  if (place.kind === "agency") { const a = resolveAgency(ctx.db, place, Math.min(...yr.years), Math.max(...yr.years)); if ("decline" in a) return { kind: "decline", explanation: a.decline, statements }; agency = a; }
  if (agency) {
    const comp = loadCompleteness(ctx.db, [...agency.byYear.values()].flatMap((v) => v.oris), yr.years);
    const bad = yr.years.filter((y) => !agencyCell(comp, agency!.byYear.get(y)?.oris ?? [], y, "count", ctx.now).display);
    if (bad.length) return { kind: "decline", explanation: `${agency.label} doesn't have a complete reporting year for ${bad.join(", ")}, so I haven't broken it down (past-year figures are shown only for complete 12-month years).`, statements };
  }
  const outside = yr.years.filter((y) => outsideSource(ctx.db, y));
  if (outside.length) return { kind: "decline", explanation: `There is no data in this source for ${outside.join(", ")}, so I haven't broken it down.`, statements };
  if (place.kind !== "agency") {
    const none = yr.years.filter((y) => presence(ctx.db, place.kind === "state" ? place.code : null, y) === 0);
    if (none.length) return { kind: "decline", explanation: `There are ${noAgencies(place, none.join(", "))}, so I haven't broken it down.`, statements };
  }
  const x = statement({ table: t, place, agency, codes: FAMILY_OF[spec.measure] ? [] : codes, filters: spec.filters, years: yr.years, by: spec.dim });
  if ("decline" in x) return { kind: "decline", explanation: `I couldn't build this answer: ${x.decline}.`, statements };
  const got = await run(x.sql());
  const d = t.dims[spec.dim];
  const label = placeLabel(place, agency);
  const unitLabel = unitLabelOf(t, codes, spec.measure);
  const dimName = ({ "victim-offender-race": "victim race / offender race", drug: "drug type" } as Record<string, string>)[spec.dim] ?? spec.dim;
  const note = d.overlap ? OVERLAP_NOTE : null;
  const sets: { period: string | number; years: number[] }[] = spec.byYear
    ? yr.years.map((y) => ({ period: y, years: [y] }))
    : [{ period: yr.years.length === 1 ? yr.years[0] : `${yr.years[0]}-${yr.years[yr.years.length - 1]}`, years: yr.years }];
  const rows: Row[] = [];
  const denomRecs: OperandRecord[] = [];
  for (const set of sets) {
    const byCat = new Map<string, number>();
    for (const r of got) if (set.years.includes(Number(r.y))) byCat.set(String(r.cat), (byCat.get(String(r.cat)) ?? 0) + Number(r.v ?? 0));
    let denominator: number | null;
    if (spec.dim === "bias") denominator = null;
    else if (!d.overlap) denominator = [...byCat.values()].reduce((a, b) => a + b, 0);
    else {
      const ut = await uniqueTotal(spec.measure, unit, spec.filters, place, agency, set.years, run);
      denominator = ut ? ut.value : null;
      if (ut) { const why = shareOperands({ ...x.rec, years: set.years }, ut.rec, spec.filters, []); if (why) return { kind: "decline", explanation: operandFailure(why), statements }; denomRecs.push(ut.rec); }
    }
    // Stage 3b r2 (R2.4'): the denominator actually used for this period's shares (null when none), keyed to its rows.
    recordWhyFacts({ kind: "breakdown", key: { place: label, measure: spec.measure, period: String(set.period), dimension: dimName, unit: unitLabel }, denominator, overlap: Boolean(d.overlap) });
    if (!byCat.size) { rows.push({ period: set.period, place: label, measure: spec.measure, unit: unitLabel, filter: filterText, dimension: dimName, category: null, count: 0, share: null, note: "none recorded" }); continue; }
    rows.push(...[...byCat.entries()]
      .map(([cat, count]) => ({ period: set.period, place: label, measure: spec.measure, unit: unitLabel, filter: filterText, dimension: dimName, category: d.label ? d.label(cat) : cat, count, share: denominator ? r1((count / denominator) * 100) : null, note }))
      .sort((a, b) => (b.count as number) - (a.count as number) || (String(a.category) < String(b.category) ? -1 : 1)));
  }
  const applied = appliedFrom([{ measure: spec.measure, ops: [x.rec, ...denomRecs] }]);
  if (spec.byYear) post(applied).push("grains", "year"); // applied-site: per-year-sets
  post(applied).set("share", true); // applied-site: breakdown-shares-computed
  const form = periodFormValue(spec.period); if (form) post(applied).push("periodValues", form); // applied-site: relative-period-resolved-by-years-of
  const notes: string[] = [];
  if (spec.dim === "hour") notes.push("Shares are of offenses with a recorded hour; offenses with no recorded hour aren't in NIBRS's time-of-day summary.");
  { const fw = firstWeaponNote(spec.filters, t); if (fw) notes.push(fw); } // owner decision A
  if (place.kind !== "agency") notes.push(cohortSentence(place, yr.years, ctx.db));
  if (yr.note) notes.push(yr.note);
  return { kind: "answer", columns: BREAKDOWN, rows, title: `${MEASURE_LABEL[spec.measure]} ${unitLabel} by ${dimName} — ${label}`, explanation: ["Counts from the NIBRS summary tables; unknown values stay visible as their own category.", ...notes, NIBRS_RECENT_MATURATION_DISCLOSURE].join(" "), statements, applied };
}

const CLEARANCE_TYPES: [string, string][] = [["Cleared by arrest", "cleared_by_arrest"], ["Death of offender", "cleared_A"], ["Prosecution declined", "cleared_B"], ["In custody elsewhere", "cleared_C"], ["Victim refused to cooperate", "cleared_D"], ["Juvenile, no custody", "cleared_E"]];
const clearanceCols = (v: string) => (v === "arrest" ? ["cleared_by_arrest"] : v === "exceptional" ? ["cleared_A", "cleared_B", "cleared_C", "cleared_D", "cleared_E"] : [`cleared_${v}`]);

/** The place and years of a clearance answer, as a builder, with the agency completeness of each year (r2 §4). */
async function clearanceQuery(spec: { place: NPlace; period: NPeriod; measure: string }, ctx: CompileContext, table: string): Promise<{ years: number[]; agency?: AgencyResolved; x: TypedQuery; mk: (role: OperandRole) => TypedQuery; incomplete: string | null; none: string | null } | { decline: string }> {
  const t = { table, yearCol: "year", monthly: table === "summary_clearance_type" } as Table;
  const b = measuredBounds(ctx.db, t);
  if (!b) return { decline: "The latest year in this data can't be confirmed, so I haven't answered." };
  const yr = yearsOf(spec.period, b, ctx.now);
  if ("decline" in yr) return yr;
  let agency: AgencyResolved | undefined;
  let placeOn: (q2: TypedQuery) => TypedQuery = (q2) => q2;
  let incomplete: string | null = null;
  let none: string | null = null;
  if (spec.place.kind === "agency") {
    const a = resolveAgency(ctx.db, spec.place, Math.min(...yr.years), Math.max(...yr.years));
    if ("decline" in a) return a;
    agency = a;
    const p = spec.place; const oris = [...a.byYear.values()].flatMap((v) => v.oris);
    placeOn = (q2) => q2.agencyOris("ori", p, oris);
    const comp = loadCompleteness(ctx.db, [...a.byYear.values()].flatMap((v) => v.oris), yr.years);
    for (const y of yr.years) { const cell = agencyCell(comp, a.byYear.get(y)?.oris ?? [], y, "count", ctx.now); if (!cell.display) { incomplete = cell.note; break; } }
  } else {
    const p = spec.place;
    placeOn = (q2) => (p.kind === "state" ? q2.state("state", p) : q2.nation(null));
    const code = spec.place.kind === "state" ? spec.place.code : null;
    const missing = yr.years.filter((y) => presence(ctx.db, code, y) === 0);
    if (missing.length) none = noAgencies(spec.place, missing.join(", "));
  }
  const mk = (role: OperandRole) => placeOn(new TypedQuery(role, table, { unit: "offenses" }).codes("ucr_offense_code", MEASURE_CODES[spec.measure] ?? []).years("year", yr.years));
  return { years: yr.years, agency, x: mk("value"), mk, incomplete, none };
}

async function compileClearanceBreakdown(spec: BreakdownSpec, ctx: CompileContext, run: RunFn, statements: string[]): Promise<CompiledAnswer> {
  const method = spec.dim === "clearance-method";
  const table = method ? "summary_clearance_type" : "summary_clearance_detail";
  const cq = await clearanceQuery(spec, ctx, table);
  if ("decline" in cq) return { kind: "decline", explanation: cq.decline, statements };
  const label = placeLabel(spec.place, cq.agency);
  if (cq.incomplete) return { kind: "decline", explanation: `${label} doesn't have a complete reporting year here (${cq.incomplete}), so I haven't broken its clearances down.`, statements };
  if (cq.none) return { kind: "decline", explanation: `There are ${cq.none}, so I haven't broken clearances down.`, statements };
  const cols = method ? ["cleared_by_arrest", "cleared_exceptional"] : CLEARANCE_TYPES.map(([, c]) => c);
  cq.x.value("COUNT(*)", "n").clearance(cols).value("SUM(total_offenses)", "total").groupBy(spec.dim, `'${spec.dim}'`);
  const r = (await run(cq.x.sql()))[0] ?? {};
  if (!Number(r.n ?? 0)) return { kind: "decline", explanation: `No clearance records were reported for ${label} in this period, so I haven't broken clearances down.`, statements };
  const total = Number(r.total ?? 0);
  const cats: [string, number][] = method
    ? [["Cleared by arrest", Number(r.cleared_by_arrest ?? 0)], ["Cleared by exceptional means", Number(r.cleared_exceptional ?? 0)]]
    : CLEARANCE_TYPES.map(([l, c]) => [l, Number(r[c] ?? 0)]);
  cats.push(["Not cleared", total - cats.reduce((a, [, v]) => a + v, 0)]);
  const period: string | number = cq.years.length === 1 ? cq.years[0] : `${cq.years[0]}-${cq.years[cq.years.length - 1]}`;
  const rows: Row[] = cats.map(([category, count]) => ({ period, place: label, measure: spec.measure, unit: "offenses", filter: null, dimension: method ? "clearance method" : "clearance type", category, count, share: total ? r1((count / total) * 100) : null, note: null }))
    .sort((a, b) => (b.count as number) - (a.count as number) || (String(a.category) < String(b.category) ? -1 : 1));
  const applied = appliedFrom([{ measure: spec.measure, ops: [cq.x.rec] }]);
  post(applied).set("share", true); // applied-site: breakdown-shares-computed
  const form = periodFormValue(spec.period); if (form) post(applied).push("periodValues", form); // applied-site: relative-period-resolved-by-years-of
  const cohortNote = spec.place.kind !== "agency" ? ` ${cohortSentence(spec.place, cq.years, ctx.db)}` : "";
  return { kind: "answer", columns: BREAKDOWN, rows, title: `${label} ${MEASURE_LABEL[spec.measure]} clearances by ${method ? "method" : "type"}`, explanation: "Every clearance category, with uncleared offenses as their own category so the parts sum to the reported total. FBI clearance means cleared by arrest or by exceptional means; it is not a conviction. Clearances count offense records, not victims." + cohortNote + " " + NIBRS_RECENT_MATURATION_DISCLOSURE, statements, applied };
}

async function compileShare(spec: ShareSpec, ctx: CompileContext, run: RunFn, statements: string[]): Promise<CompiledAnswer> {
  const place = spec.place;
  const codes = MEASURE_CODES[spec.measure] ?? [];
  const clearanceSubset = spec.subset.filter((f) => f.startsWith("clearance:"));
  if (clearanceSubset.length) {
    const cq = await clearanceQuery({ ...spec }, ctx, "summary_clearance_detail");
    if ("decline" in cq) return { kind: "decline", explanation: cq.decline, statements };
    const byState = spec.byState === true && place.kind === "national";
    const popClearance = spec.population.filter((f) => f.startsWith("clearance:"));
    // r4.1: three denominator kinds. A clearance condition on the population restricts the denominator to exactly its
    // columns; an unrestricted share of clearances divides by all clearance columns; a share of offenses by total offenses.
    const denKind: "restricted" | "clearances" | "offenses" = popClearance.length ? "restricted" : spec.denominator === "clearances" ? "clearances" : "offenses";
    const allCols = CLEARANCE_TYPES.map(([, c]) => c);
    const denCols = denKind === "restricted" ? [...new Set(popClearance.flatMap((f) => clearanceCols(f.split(":")[1])))] : denKind === "clearances" ? allCols : [];
    // r4 §4: every subset value lies inside the population, or the request is declined naming it (no partial intersection).
    if (denKind !== "offenses") {
      const outside = clearanceSubset.filter((f) => clearanceCols(f.split(":")[1]).some((c) => !denCols.includes(c)));
      if (outside.length) return { kind: "decline", explanation: `${outside.map(filterLabel).join("; ")} isn't part of ${popClearance.length ? popClearance.map(filterLabel).join("; ") : "the clearances asked about"}, so I haven't answered with a share that leaves it out.`, statements };
    }
    const subCols = [...new Set(clearanceSubset.flatMap((f) => clearanceCols(f.split(":")[1])))];
    // r4 §1: two operands through the builder, each summing exactly its own columns.
    const num = cq.mk("numerator").value("COUNT(*)", "n").clearance(subCols);
    const den = cq.mk("denominator").value("COUNT(*)", "n");
    if (denKind === "offenses") den.offenseTotal(); else den.clearance(denCols);
    if (byState) { num.groupBy("state", "state"); den.groupBy("state", "state"); }
    const numRows = await run(num.sql());
    const denRows = await run(den.sql());
    const opWhy = clearanceOperands(num.rec, den.rec, denKind);
    if (opWhy) return { kind: "decline", explanation: operandFailure(opWhy), statements };
    const population = `${MEASURE_LABEL[spec.measure]} ${denKind === "offenses" ? "offenses" : "clearances"}${popClearance.length ? ` (${popClearance.map(filterLabel).join("; ")})` : ""}`;
    const period: string | number = cq.years.length === 1 ? cq.years[0] : `${cq.years[0]}-${cq.years[cq.years.length - 1]}`;
    const subsetText = clearanceSubset.map(filterLabel).join("; ");
    const blank = (label: string, note: string): Row => ({ period, place: label, measure: spec.measure, unit: "offenses", population, subset: subsetText, numerator: null, denominator: null, share: null, note });
    const shareRow = (nr: Record<string, unknown> | undefined, dr: Record<string, unknown> | undefined, label: string): Row => {
      if (!nr || !dr || !Number(dr.n ?? 0)) return blank(label, "no clearance records reported");
      const numerator = subCols.reduce((a, c) => a + Number(nr[c] ?? 0), 0);
      const denominator = denKind === "offenses" ? Number(dr.total_offenses ?? 0) : denCols.reduce((a, c) => a + Number(dr[c] ?? 0), 0);
      return { period, place: label, measure: spec.measure, unit: "offenses", population, subset: subsetText, numerator, denominator, share: denominator ? r1((numerator / denominator) * 100) : null, note: denominator ? null : `no ${population} in this period` };
    };
    const label = byState ? "each state" : placeLabel(place, cq.agency);
    const rows = cq.incomplete ? [blank(label, cq.incomplete)] : cq.none && !byState ? [blank(label, cq.none)]
      : byState
        ? denRows.filter((r) => r.cat !== "US").map((dr) => shareRow(numRows.find((nr) => nr.cat === dr.cat), dr, STATE_NAME_BY_CODE[String(dr.cat)] ?? String(dr.cat))).sort((a, b) => (String(a.place) < String(b.place) ? -1 : 1))
        : [shareRow(numRows[0], denRows[0], label)];
    const applied = appliedFrom([{ measure: spec.measure, ops: [num.rec, den.rec] }]);
    post(applied).set("share", true); // applied-site: share-computed
    for (const f of clearanceConditionsApplied(num.rec, den.rec, clearanceSubset, popClearance, denKind)) post(applied).push("filters", f); // applied-site: clearance-conditions-from-operand-columns
    if (byState) { post(applied).push("lists", "list:state"); applied.breakdowns = (applied.breakdowns ?? []).filter((b) => b !== "state"); } // applied-site: share-per-state
    const form = periodFormValue(spec.period); if (form) post(applied).push("periodValues", form); // applied-site: relative-period-resolved-by-years-of
    const stateNote = byState ? " Each state's share is of the clearance records its reporting agencies sent to NIBRS; states with no records for this offense and year aren't listed." : "";
    const cohortNote = place.kind !== "agency" && !byState ? ` ${cohortSentence(place, cq.years, ctx.db)}` : "";
    return { kind: "answer", columns: SHARE, rows,
      title: `${byState ? "By state" : label}: ${subsetText} as a share of ${population}`, explanation: `The share is of all ${population}${denKind === "clearances" ? " (cleared by arrest or by exceptional means)" : ""}. FBI clearance is not a conviction.${stateNote}${cohortNote} ${NIBRS_RECENT_MATURATION_DISCLOSURE}`, statements, applied };
  }
  if (spec.byState) return { kind: "decline", explanation: "I split clearance shares by state, but not this share, so I haven't answered with a figure that leaves \"by state\" out.", statements };
  const unit = spec.unit ?? defaultUnit(spec.measure);
  const dims = [...spec.population, ...spec.subset].map((f) => f.split(":")[0]);
  const t = selectTable({ measure: spec.measure, codes, unit, dims, grain: grainOfPlace(place), monthly: false, filters: [...spec.population, ...spec.subset] });
  if (!t) return { kind: "decline", explanation: declineNoTable(spec.measure, unit, [...spec.population, ...spec.subset], place), statements };
  const bounds = measuredBounds(ctx.db, t);
  if (!bounds) return { kind: "decline", explanation: "The latest year in this data can't be confirmed, so I haven't answered.", statements };
  const yr = yearsOf(spec.period, bounds, ctx.now);
  if ("decline" in yr) return { kind: "decline", explanation: yr.decline, statements };
  let agency: AgencyResolved | undefined;
  if (place.kind === "agency") { const a = resolveAgency(ctx.db, place, Math.min(...yr.years), Math.max(...yr.years)); if ("decline" in a) return { kind: "decline", explanation: a.decline, statements }; agency = a; }
  const unitLabel = unitLabelOf(t, codes, spec.measure);
  const population = `${MEASURE_LABEL[spec.measure]} ${unitLabel}`;
  const label = placeLabel(place, agency);
  const period: string | number = yr.years.length === 1 ? yr.years[0] : `${yr.years[0]}-${yr.years[yr.years.length - 1]}`;
  const subsetText = spec.subset.map(filterLabel).join("; ");
  const num = statement({ table: t, place, agency, codes: FAMILY_OF[spec.measure] ? [] : codes, filters: [...spec.population, ...spec.subset], years: yr.years, role: "numerator" });
  if ("decline" in num) return { kind: "decline", explanation: `I couldn't build this answer: ${num.decline}.`, statements };
  // r2.1 F3 / r3: an incomplete agency year, a year outside the source, or a place-year with no reporting agency gives
  // no counts at all (null, with the reason). The numerator is built first so the record shows what was asked.
  let unavailable: string | null = null;
  const outside = yr.years.filter((y) => outsideSource(ctx.db, y));
  if (outside.length) unavailable = noData(outside.join(", "));
  if (!unavailable && agency) {
    const comp = loadCompleteness(ctx.db, [...agency.byYear.values()].flatMap((v) => v.oris), yr.years);
    for (const y of yr.years) { const cell = agencyCell(comp, agency.byYear.get(y)?.oris ?? [], y, "count", ctx.now); if (!cell.display) { unavailable = cell.note; break; } }
  }
  if (!unavailable && place.kind !== "agency") {
    const none = yr.years.filter((y) => presence(ctx.db, place.kind === "state" ? place.code : null, y) === 0);
    if (none.length) unavailable = noAgencies(place, none.join(", "));
  }
  if (unavailable) {
    const applied = appliedFrom([{ measure: spec.measure, ops: [num.rec] }]);
    post(applied).set("share", true); // applied-site: share-withheld-with-reason
    return { kind: "answer", columns: SHARE, rows: [{ period, place: label, measure: spec.measure, unit: unitLabel, population, subset: subsetText, numerator: null, denominator: null, share: null, note: unavailable }],
      title: `${label}: ${subsetText} as a share of ${population}`, explanation: `No share is given: ${unavailable}. ${NIBRS_RECENT_MATURATION_DISCLOSURE}`, statements, applied };
  }
  if (t.key === "dv_trends" && !spec.subset.some((f) => f.startsWith("dv:"))) num.fixed("dv_category = 'all_dv'");
  const numerator = (await run(num.sql())).reduce((a, r) => a + Number(r.v ?? 0), 0);
  const subsetDims = spec.subset.map((f) => f.split(":")[0]);
  let denominator: number | null = null;
  let denRec: OperandRecord | null = null;
  if (subsetDims.every((d) => !t.dims[d]?.overlap) && t.key !== "dv_trends") {
    const den = statement({ table: t, place, agency, codes: FAMILY_OF[spec.measure] ? [] : codes, filters: spec.population, years: yr.years, role: "denominator" });
    if (!("decline" in den)) { denominator = (await run(den.sql())).reduce((a, r) => a + Number(r.v ?? 0), 0); denRec = den.rec; }
  } else {
    const ut = await uniqueTotal(spec.measure, unit, spec.population, place, agency, yr.years, run);
    if (ut) { denominator = ut.value; denRec = ut.rec; }
  }
  if (denominator === null || !denRec) return { kind: "decline", explanation: `NIBRS has no unique total of ${population} to divide by (its category rows can overlap), so I can't give that share; the counts are available without it.`, statements };
  // r3.1 F1: each operand carries what it must, before the answer is composed.
  const why = shareOperands(num.rec, denRec, spec.population, spec.subset);
  if (why) return { kind: "decline", explanation: operandFailure(why), statements };
  const applied = appliedFrom([{ measure: spec.measure, ops: [num.rec, denRec] }]);
  post(applied).set("share", true); // applied-site: share-computed
  const form = periodFormValue(spec.period); if (form) post(applied).push("periodValues", form); // applied-site: relative-period-resolved-by-years-of
  const notes: string[] = [];
  if (place.kind !== "agency") notes.push(cohortSentence(place, yr.years, ctx.db));
  { const fw = firstWeaponNote([...spec.population, ...spec.subset], t); if (fw) notes.push(fw); } // owner decision A
  return { kind: "answer", columns: SHARE, rows: [{ period, place: label, measure: spec.measure, unit: unitLabel, population, subset: subsetText, numerator, denominator, share: denominator ? r1((numerator / denominator) * 100) : null, note: denominator ? null : `no ${population} in this period` }],
    title: `${label}: ${subsetText} as a share of ${population}`, explanation: [`The share is of all ${population}${spec.population.length ? ` (${spec.population.map(filterLabel).join("; ")})` : ""}; the denominator is NIBRS's unique total for that population.`, ...notes, NIBRS_RECENT_MATURATION_DISCLOSURE].join(" "), statements, applied };
}

async function compileRank(spec: RankSpec, ctx: CompileContext, run: RunFn, statements: string[]): Promise<CompiledAnswer> {
  const codes = MEASURE_CODES[spec.measure] ?? [];
  if (spec.statistic === "clearance_rate" && (spec.entity === "city" || spec.entity === "agency")) {
    const tb = { table: "summary_clearance_city_annual", yearCol: "year", monthly: false } as Table;
    const b = measuredBounds(ctx.db, tb);
    if (!b) return { kind: "decline", explanation: "The latest year in this data can't be confirmed, so I haven't answered.", statements };
    const yr = yearsOf(spec.period, b, ctx.now);
    if ("decline" in yr || yr.years.length !== 1) return { kind: "decline", explanation: "A ranking covers one year; name the year.", statements };
    const year = yr.years[0];
    const ranked = spec.rank !== null;
    if (ranked && !spec.min) return { kind: "clarify", explanation: "What minimum population should a city have to be ranked? Without one, a place with a single offense can lead at 100%. Add, for example, \"with at least 100,000 people\".", statements };
    // r2 §4: the coverage LEFT JOIN. Every candidate agency in scope is listed or named with its reason.
    const x = new TypedQuery("value", "agencies a", { unit: "offenses" })
      .join(`LEFT JOIN summary_clearance_city_annual c ON c.ori = a.ori AND c.year = a.year AND c.ucr_offense_code IN (${codes.map(q).join(", ")})`)
      .tableCodes(codes).years("a.year", [year]).entity(spec.entity, spec.entity === "city" ? "a.agency_type = 'City'" : null);
    if (spec.scope.kind === "state") x.state("a.state", spec.scope); else x.nation(null);
    x.groupOri("a.ori").value("a.city", "city").value("a.state", "st").value("a.population", "population").value("SUM(c.total_offenses)", "offenses").clearanceExpr("SUM(c.total_cleared)", "cleared").value("COUNT(c.ori)", "n");
    const got = (await run(x.sql())).map((r) => ({ place: `${titleCase(String(r.city))}, ${r.st}`, population: r.population === null ? null : Number(r.population), offenses: Number(r.offenses ?? 0), cleared: Number(r.cleared ?? 0), n: Number(r.n ?? 0) }));
    const excluded: { place: string; why: string; population: number }[] = [];
    const eligible = got.filter((g) => {
      if (spec.min) {
        if (g.population === null || !(g.population > 0)) { excluded.push({ place: g.place, why: "population unknown", population: 0 }); return false; }
        const ok = spec.min.op === ">=" ? g.population >= spec.min.amount : g.population > spec.min.amount;
        if (!ok) { excluded.push({ place: g.place, why: `population ${g.population.toLocaleString("en-US")}, ${spec.min.op === ">" && g.population === spec.min.amount ? "not over" : "below"} the minimum`, population: g.population }); return false; }
      }
      if (g.n === 0) { excluded.push({ place: g.place, why: "no clearance records", population: g.population ?? 0 }); return false; }
      if (g.offenses <= 0) { excluded.push({ place: g.place, why: "no offenses reported", population: g.population ?? 0 }); return false; }
      return true;
    }).map((g) => ({ ...g, value: r1((g.cleared / g.offenses) * 100) }));
    let rows: Row[];
    const applied = appliedFrom([{ measure: spec.measure, ops: [x.rec] }]);
    if (spec.min) post(applied).set("thresholds", [spec.min]); // applied-site: rank-population-threshold
    if (ranked) {
      const sorted = eligible.sort((a, b) => (spec.rank!.dir === "top" ? (b.value! - a.value!) : (a.value! - b.value!)) || (a.place < b.place ? -1 : 1));
      rows = sorted.slice(0, spec.rank!.n ?? sorted.length).map((g, i) => ({ rank: i + 1, place: g.place, year, measure: spec.measure, unit: "offenses", statistic: "clearance_rate", value: g.value, population: g.population }));
      post(applied).set("rank", { dir: spec.rank!.dir, n: spec.rank!.n ?? 0 }); // applied-site: rank-sort-and-slice
    } else {
      rows = eligible.sort((a, b) => (a.place < b.place ? -1 : 1)).map((g) => ({ rank: null, place: g.place, year, measure: spec.measure, unit: "offenses", statistic: "clearance_rate", value: g.value, population: g.population }));
      post(applied).push("lists", `list:${spec.entity}`); // applied-site: alphabetical-list
    }
    const named = excluded.sort((a, b) => b.population - a.population || (a.place < b.place ? -1 : 1));
    const shown = spec.min ? named : named.slice(0, 20);
    const leftOut = named.length ? `Left out: ${shown.map((e) => `${e.place} (${e.why})`).join("; ")}${named.length > shown.length ? `; and ${named.length - shown.length} more` : ""}.` : "";
    const notes = [ranked && spec.rank!.n && rows.length < spec.rank!.n ? `Only ${rows.length} cities meet the conditions.` : "", leftOut].filter(Boolean);
    post(applied).set("statistic", "clearance_rate"); // applied-site: statistic-computed
    recordWhyFacts({ kind: "rate", method: "nibrs-clearance", per: 100, places: [] }); // Stage 3b r3 (R3.2''): cleared / reported per city
    return { kind: "answer", columns: RANK, rows, title: `${MEASURE_LABEL[spec.measure]} clearance rate by city, ${year}`, explanation: ["Clearance rate = offenses cleared (by arrest or exceptional means) / offenses reported, for each city's police agency.", ...notes, NIBRS_RECENT_MATURATION_DISCLOSURE].join(" "), statements, applied };
  }
  if (spec.entity === "state" && (spec.statistic === "rate" || spec.statistic === "count")) {
    const t = selectTable({ measure: spec.measure, codes, unit: defaultUnit(spec.measure), dims: [], grain: "agency", monthly: true });
    if (!t || t.key === "drug_monthly") return { kind: "decline", explanation: declineNoTable(spec.measure, defaultUnit(spec.measure), [], { kind: "national", label: "United States" }), statements };
    const b = measuredBounds(ctx.db, t);
    if (!b) return { kind: "decline", explanation: "The latest year in this data can't be confirmed, so I haven't answered.", statements };
    const yr = yearsOf(spec.period, b, ctx.now);
    if ("decline" in yr || yr.years.length !== 1) return { kind: "decline", explanation: "A ranking covers one year; name the year.", statements };
    const year = yr.years[0];
    if (outOfBounds(b, year)) return { kind: "decline", explanation: `There is no data in this source for ${year}, so I haven't ranked the states.`, statements };
    // Agency grain: reporting agencies; a RATE counts only agencies with a population on file, on both sides (r3.2).
    const x = new TypedQuery("value", `${t.table} x`, { unit: t.unit })
      .codes(`x.${t.codeCol}`, codes).years(`x.${t.yearCol}`, [year]).nation(null)
      .join(`JOIN agencies a ON a.ori = x.${t.oriCol} AND a.year = x.${t.yearCol}${spec.statistic === "rate" ? " AND a.population > 0" : ""} JOIN nibrs_agency_completeness c ON c.ori = x.${t.oriCol} AND c.year = x.${t.yearCol} AND c.months_reported > 0`)
      .entity("state", null).value("a.state", "st").value(`SUM(x.${t.count.replace(/^SUM\((.*)\)$/, "$1")})`);
    x.groupBy("state", "a.state");
    const counts = new Map((await run(x.sql())).map((r) => [String(r.st), Number(r.v ?? 0)]));
    const rows0 = [...counts.keys()].map((st) => {
      const pop = cohort(ctx.db, st, year).population;
      return { place: STATE_NAME_BY_CODE[st] ?? st, value: spec.statistic === "rate" ? r1((counts.get(st)! * 100000) / (pop || NaN)) : counts.get(st)! };
    }).filter((v) => v.value !== null && (spec.statistic === "rate" || (v.value as number) > 0));
    const sorted = rows0.sort((a, b) => ((spec.rank?.dir ?? "top") === "top" ? (b.value! - a.value!) : (a.value! - b.value!)) || (a.place < b.place ? -1 : 1));
    const take = spec.rank?.n ?? sorted.length;
    const rows: Row[] = sorted.slice(0, take).map((v, i) => ({ rank: spec.rank ? i + 1 : null, place: v.place, year, measure: spec.measure, unit: defaultUnit(spec.measure), statistic: spec.statistic === "rate" ? "rate_per_100k" : "count", value: v.value, population: null }));
    const all = presence(ctx.db, null, year);
    const applied = appliedFrom([{ measure: spec.measure, ops: [x.rec] }]);
    applied.breakdowns = (applied.breakdowns ?? []).filter((d) => d !== "state"); // applied-site: state-grouping-is-the-ranking-not-a-breakdown
    if (spec.rank) post(applied).set("rank", { dir: spec.rank.dir, n: spec.rank.n ?? 0 }); // applied-site: rank-sort-and-slice
    post(applied).set("statistic", spec.statistic === "rate" ? "rate" : "count"); // applied-site: statistic-computed
    if (spec.statistic === "rate") recordWhyFacts({ kind: "rate", method: "nibrs-cohort-annual", per: 100000, places: [] }); // Stage 3b r3 (R3.2'): each state's count / cohort(st, year).population
    return { kind: "answer", columns: RANK, rows, title: `${MEASURE_LABEL[spec.measure]} ${spec.statistic === "rate" ? "rate" : "count"} by state, ${year}`, explanation: [`States are ranked on the agencies that reported to NIBRS in ${year} (${all.toLocaleString("en-US")} agencies in all); states with fewer reporting agencies are less complete.`, spec.statistic === "rate" ? RATE_DISCLAIMER : "", NIBRS_RECENT_MATURATION_DISCLOSURE].filter(Boolean).join(" "), statements, applied };
  }
  return { kind: "decline", explanation: "I can rank states by a count or a rate, and cities or agencies by clearance rate. This ranking is neither, and no other ranking here could answer it as asked, so I haven't answered with a number.", statements };
}

async function compileChange(spec: ChangeSpec, ctx: CompileContext, run: RunFn, statements: string[]): Promise<CompiledAnswer> {
  const series: SeriesSpec = { type: "series", measures: [spec.measure], unit: spec.unit, statistic: spec.statistic, filters: [], places: [spec.place], period: { form: "years", list: [spec.earlier, spec.later] }, grain: "year" };
  const s = await compileSeries(series, ctx, run, statements);
  if (s.kind !== "answer") return s;
  const at = (y: number) => s.rows.find((r) => r.period === y);
  const e = at(spec.earlier); const l = at(spec.later);
  const ev = (e?.value ?? null) as number | null; const lv = (l?.value ?? null) as number | null;
  const notes = [e?.note ? `${String(e.note).replace(/^incomplete year/, `incomplete year ${spec.earlier}`)}` : null, l?.note ? `${String(l.note).replace(/^incomplete year/, `incomplete year ${spec.later}`)}` : null].filter(Boolean);
  const change = ev !== null && lv !== null ? lv - ev : null;
  const applied = s.applied;
  // The change compares exactly the two endpoint years the series read, whichever way it moved.
  post(applied).set("years", { start: spec.earlier, end: spec.later }); // applied-site: change-endpoints
  for (const d of ["increase", "decrease", "neutral"]) post(applied).push("change", d); // applied-site: change-computed
  post(applied).set("versus", "years"); // applied-site: change-computed
  return { kind: "answer", columns: CHANGE, rows: [{ place: String(s.rows[0].place), measure: spec.measure, unit: String(s.rows[0].unit), statistic: spec.statistic === "rate" ? "rate_per_100k" : "count", earlier_year: spec.earlier, earlier_value: ev, later_year: spec.later, later_value: lv, change: change === null ? null : r1(change), percent_change: change !== null && ev ? r1((change / ev) * 100) : null, note: notes.length ? notes.join("; ") : null }],
    title: `Change in ${MEASURE_LABEL[spec.measure]}, ${spec.earlier} to ${spec.later} — ${s.rows[0].place}`, explanation: `The change is the later year minus the earlier year; the percent change is relative to ${spec.earlier}. ${s.explanation}`, statements, applied };
}
