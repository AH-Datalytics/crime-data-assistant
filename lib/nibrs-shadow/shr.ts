/**
 * Homicide Reports (the FBI's Supplementary Homicide Reports, SHR) in the shadow: murder details read from the canonical
 * SHR release (nibrs-model, shr-<date>-<n>; table shapes frozen 2026-11-11), never from the live shr.db.
 *
 * Jeff's decisions (2026-11-11):
 *   J1 / A  SHR here starts in 1985; a span starting earlier is answered from 1985 on, and the answer says so.
 *   S1      murder details (weapon, relationship, circumstance, the victims' or offenders' sex, race, ethnicity or age)
 *           come from SHR for every year from 1985, NIBRS's years included; NIBRS only when it is named, or for what SHR
 *           doesn't record (location, clearance).
 *   S2      only details: plain state or national murder counts and rates stay Crime Index's. A state or national detail
 *           total is the filing agencies' homicides, with how many filed and the share of Crime Index's population they
 *           cover; nothing is estimated for the rest.
 *   S3      an agency-year with no SHR filing is blank (a gap in a chart), unless it is a proper 0: Crime Index has the
 *           agency's murders as 0 that year. Inside a year the agency filed, a month or category with none is 0.
 *   S4      "murder" is murder and nonnegligent manslaughter (homicide type A) without justifiable homicide (circumstance
 *           80 or 81); "homicide" adds negligent manslaughter (type B); justifiable homicide only when asked.
 *   S5      a record's weapon, relationship and circumstance are its first offender's, applied to each of its victims
 *           (the FBI's table convention).
 * Counting: `counted` on shr_record is the only count filter (the release's rule); a victim beyond the 11 a record has
 * room for is counted with no demographics (Unknown).
 */
import fs from "node:fs";
import path from "node:path";
import type { ResultTable } from "../nibrs-plan/result";
import type { NibrsPlan } from "../nibrs-plan/plan";
import { fmt, periodWords } from "./deliver";
import { stateName } from "./places";
import type { HistoricalBuild } from "./historical";

export const SHR_FIRST_YEAR = 1985;
export const SHR_SOURCE = "Source: FBI Supplementary Homicide Reports.";

/** Where the SHR release is: its canonical tables, release id, latest month and the crosswalk it mapped agencies with. */
export type ShrBuild = { root: string; release: string; latestMonth: string; crosswalk: string };
/**
 * The release at `root` (the folder holding manifest.json and canonical/), from its manifest's "shr" key, checked
 * strictly (frozen shapes, section 5): a key that is missing or malformed stops loading; no root, no build.
 */
export function shrBuildAt(root: string | undefined): ShrBuild | undefined {
  if (!root) return undefined;
  const file = path.join(root, "manifest.json");
  if (!fs.existsSync(file)) return undefined;
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as { shr?: Record<string, unknown> };
  const s = m.shr;
  if (!s || typeof s.release_id !== "string" || !/^shr-\d{8}-\d+$/.test(s.release_id) || typeof s.latest_month !== "string" || !/^\d{4}-\d{2}$/.test(s.latest_month)
    || typeof s.crosswalk_release !== "string" || typeof s.cde_update_date !== "string" || s.source_count !== 53)
    throw new Error(`${file}: the "shr" key must hold release_id, latest_month, cde_update_date, crosswalk_release and source_count 53`);
  return { root: root.replace(/\\/g, "/"), release: s.release_id, latestMonth: s.latest_month, crosswalk: s.crosswalk_release };
}

/* ------------------------------------------------------------------ codes (nibrs-model reference/code-lists/shr-*.json) */

export const SHR_WEAPON: Record<string, string> = { "11": "Firearm, type not stated", "12": "Handgun", "13": "Rifle", "14": "Shotgun", "15": "Other gun",
  "20": "Knife or cutting instrument", "30": "Blunt object", "40": "Personal weapons", "50": "Poison", "55": "Pushed or thrown out a window", "60": "Explosives",
  "65": "Fire", "70": "Narcotics or drugs", "75": "Drowning", "80": "Strangulation or hanging", "85": "Asphyxiation", "90": "Other or unknown weapon" };
export const SHR_RELATIONSHIP: Record<string, string> = { HU: "Husband", WI: "Wife", CH: "Common-law husband", CW: "Common-law wife", MO: "Mother", FA: "Father",
  SO: "Son", DA: "Daughter", BR: "Brother", SI: "Sister", IL: "In-law", SF: "Stepfather", SM: "Stepmother", SS: "Stepson", SD: "Stepdaughter", OF: "Other family",
  NE: "Neighbor", AQ: "Acquaintance", BF: "Boyfriend", GF: "Girlfriend", XH: "Ex-husband", XW: "Ex-wife", EE: "Employee", ER: "Employer", FR: "Friend",
  HO: "Same-sex partner", OK: "Other known to the victim", ST: "Stranger", UN: "Unknown relationship" };
export const SHR_CIRCUMSTANCE: Record<string, string> = { "02": "Rape", "03": "Robbery", "05": "Burglary", "06": "Larceny", "07": "Motor vehicle theft", "09": "Arson",
  "10": "Prostitution", "17": "Other sex offense", "18": "Drug law violation", "19": "Gambling", "26": "Other felony", "32": "Abortion", "40": "Lover's triangle",
  "41": "Child killed by babysitter", "42": "Brawl under the influence of alcohol", "43": "Brawl under the influence of narcotics", "44": "Argument over money or property",
  "45": "Other argument", "46": "Gangland killing", "47": "Juvenile gang killing", "48": "Institutional killing", "49": "Sniper attack", "60": "Other",
  "70": "Suspected felony", "80": "Felon killed by a private citizen", "81": "Felon killed by police", "99": "Undetermined" };
const SEX: Record<string, string> = { M: "Male", F: "Female", U: "Unknown" };
const RACE: Record<string, string> = { W: "White", B: "Black", I: "American Indian or Alaska Native", A: "Asian", P: "Native Hawaiian or Pacific Islander", U: "Unknown" };
const ETHNICITY: Record<string, string> = { H: "Hispanic", N: "Not Hispanic", U: "Unknown" };

/** The details SHR records, by person (victim or offender) or by record (offender 1's, S5). */
export type ShrDim = "victim.age" | "victim.sex" | "victim.race" | "victim.ethnicity" | "offender.age" | "offender.sex" | "offender.race" | "offender.ethnicity"
  | "weapon" | "relationship" | "circumstance";
const DIM_COLUMN: Record<ShrDim, string> = { "victim.age": "age", "victim.sex": "sex", "victim.race": "race", "victim.ethnicity": "ethnicity",
  "offender.age": "age", "offender.sex": "sex", "offender.race": "race", "offender.ethnicity": "ethnicity", weapon: "weapon", relationship: "relationship", circumstance: "circumstance" };
const DIM_LABELS: Partial<Record<ShrDim, Record<string, string>>> = { "victim.sex": SEX, "offender.sex": SEX, "victim.race": RACE, "offender.race": RACE,
  "victim.ethnicity": ETHNICITY, "offender.ethnicity": ETHNICITY, weapon: SHR_WEAPON, relationship: SHR_RELATIONSHIP, circumstance: SHR_CIRCUMSTANCE };
const DIM_HEADER: Record<ShrDim, string> = { "victim.age": "Victim's age", "victim.sex": "Victim's sex", "victim.race": "Victim's race", "victim.ethnicity": "Victim's ethnicity",
  "offender.age": "Offender's age", "offender.sex": "Offender's sex", "offender.race": "Offender's race", "offender.ethnicity": "Offender's ethnicity",
  weapon: "Weapon", relationship: "Victim's relationship to the offender", circumstance: "Circumstance" };
const DIM_WORDS: Record<ShrDim, string> = { "victim.age": "the victims' age", "victim.sex": "the victims' sex", "victim.race": "the victims' race",
  "victim.ethnicity": "the victims' ethnicity", "offender.age": "the offenders' age", "offender.sex": "the offenders' sex", "offender.race": "the offenders' race",
  "offender.ethnicity": "the offenders' ethnicity", weapon: "weapon", relationship: "the victim's relationship to the offender", circumstance: "circumstance" };
const RECORD_DIMS = new Set<ShrDim>(["weapon", "relationship", "circumstance"]);

/* ------------------------------------------------------------------ the question */

export type ShrPlace = { kind: "agency"; ori: string; label: string; state: string } | { kind: "state"; code: string } | { kind: "national" };
/** `group`: conditions of one NIBRS "exists" group, which one person must meet together (Codex SHR-A review 01.3). */
export type ShrFilter = { dim: ShrDim; codes?: string[]; ages?: [number, number]; group?: number };
export type ShrQuestion = {
  measure: "murder" | "homicide" | "justifiable"; unit: "victims" | "offenders"; place: ShrPlace;
  /** Months inclusive ("1985-01".."2024-12"), already cut to 1985 and the release's latest month. */
  from: string; to: string; grain: "total" | "year" | "month";
  filters: ShrFilter[]; breakdown: { dim: ShrDim; bins?: [number, number][] } | null; share: boolean;
  /** The first year asked when it was before 1985 (J1, option A): the answer says it starts in 1985. */
  askedFrom?: string;
};
export type ShrAnswer = {
  kind: "shr"; question: ShrQuestion; period: { from: string; to: string };
  meaning: { source: "shr"; places: unknown[]; filters: string[]; measures: { name: string; unit: string }[]; period: { from: string; to: string }; groupings: string[]; statistic: "count" };
  delivered: { table: ResultTable; text: string[] };
  read: { table: string; release: string };
};
export type ShrDecline = { kind: "shr-decline"; explanation: string };

/* NIBRS plan -> SHR question (the reader reads once; only the source changes). Codes SHR has no equal for stay NIBRS's. */
const NIBRS_DIM: Record<string, ShrDim> = { "victim.age": "victim.age", "victim.sex": "victim.sex", "victim.race": "victim.race", "victim.ethnicity": "victim.ethnicity",
  "offender.age": "offender.age", "offender.sex": "offender.sex", "offender.race": "offender.race", "offender.ethnicity": "offender.ethnicity",
  "victim_offender.offender_age": "offender.age", "victim_offender.offender_sex": "offender.sex", "victim_offender.offender_race": "offender.race",
  "victim_offender.offender_ethnicity": "offender.ethnicity", "offense_weapon.weapon": "weapon", "victim_offender.relationship": "relationship",
  "victim_circumstance.circumstance": "circumstance" };
/** NIBRS relationship codes -> SHR's (SHR names the side: husband or wife, mother or father). */
const RELATIONSHIP_OF: Record<string, string[]> = { SE: ["HU", "WI"], CS: ["CH", "CW"], PA: ["MO", "FA"], SB: ["BR", "SI"], CH: ["SO", "DA"], IL: ["IL"],
  SP: ["SF", "SM"], SC: ["SS", "SD"], AQ: ["AQ"], FR: ["FR"], NE: ["NE"], BG: ["BF", "GF"], HR: ["HO"],
  XS: ["XH", "XW"], EE: ["EE"], ER: ["ER"], OK: ["OK"], ST: ["ST"], RU: ["UN"] };
/** NIBRS homicide circumstances SHR records the same way. */
const CIRCUMSTANCE_OF: Record<string, string[]> = { "04": ["46"], "05": ["47"], "20": ["80"], "21": ["81"] };
// NIBRS "Other" (90) is narrower than SHR's "other or unknown", so it isn't translated (Codex SHR-A review 01.2).
const SHR_WEAPON_CODES = new Set(["11", "12", "13", "14", "15", "20", "30", "40", "50", "60", "65", "70", "85"]);
/** NIBRS's other family members (other, grandparent, grandchild, stepsibling) together are SHR's "other family". */
const OTHER_FAMILY = ["OF", "GP", "GC", "SS"];
function codesOf(dim: ShrDim, values0: readonly (string | number)[]): string[] | null {
  const out = new Set<string>();
  let values = values0.map(String);
  if (dim === "weapon") {
    // A firearm and its automatic code (12 and 12A) together are SHR's code; one without the other is narrower (01.2).
    const set = new Set(values);
    if (values.some((v) => /^1[1-5]A?$/.test(v) && !set.has(v.endsWith("A") ? v.slice(0, -1) : `${v}A`))) return null;
    values = [...new Set(values.map((v) => v.replace(/A$/, "")))];
  }
  if (dim === "relationship" && values.some((v) => OTHER_FAMILY.includes(v))) {
    if (!OTHER_FAMILY.every((v) => values.includes(v))) return null;
    out.add("OF");
    values = values.filter((v) => !OTHER_FAMILY.includes(v));
  }
  for (const v of values) {
    const got = dim === "weapon" ? (SHR_WEAPON_CODES.has(v) ? [v] : null)
      : dim === "relationship" ? RELATIONSHIP_OF[v] ?? null
      : dim === "circumstance" ? CIRCUMSTANCE_OF[v] ?? null
      : /sex$/.test(dim) ? (v in SEX ? [v] : null) : /race$/.test(dim) ? (v in RACE ? [v] : null) : /ethnicity$/.test(dim) ? (v in ETHNICITY ? [v] : null) : null;
    if (!got) return null;
    got.forEach((g) => out.add(g));
  }
  return [...out];
}
/** The postal state of an ORI (its first two letters; NB is Nebraska and GM Guam, as the FBI writes them). */
const ORI_STATE: Record<string, string> = { NB: "NE", GM: "GU" };
export const stateOfOri = (ori: string) => ORI_STATE[ori.slice(0, 2)] ?? ori.slice(0, 2);

/**
 * The SHR question a NIBRS plan asks, or why SHR can't answer it as asked (the caller then keeps NIBRS's path). One
 * place (an agency, a state or the nation), one murder measure counted by victims or offenders, counts (and each
 * category's share), by year or month, at most one breakdown; every filter a detail SHR records the same way.
 */
export function shrQuestionOf(plan: NibrsPlan, period: { from: string; to: string }, build: ShrBuild): ShrQuestion | { why: string } {
  if (plan.measures.length !== 1) return { why: "several crimes" };
  const m = /^(victims|offenders|offenses)\.(murder|homicide|justifiable_homicide)$/.exec(plan.measures[0].id);
  if (!m) return { why: "not a homicide count" };
  // Murders are counted by victim (CLAUDE.md: person crimes per victim); SHR has no separate offense count.
  const unit = m[1] === "offenders" ? "offenders" : "victims";
  if (plan.transforms.length) return { why: "a change, a ranking or a rolling window" };
  const stats = plan.statistics.map((s) => s.kind);
  if (!(stats.length === 1 && stats[0] === "count") && !(stats.length === 2 && stats[0] === "count" && stats[1] === "share")) return { why: "a rate or another statistic" };
  if (plan.geography.places.length !== 1) return { why: "several places" };
  const p = plan.geography.places[0];
  const place: ShrPlace | null = p.kind === "national" ? { kind: "national" } : p.kind === "state" ? { kind: "state", code: p.code }
    : p.kind === "agency" ? { kind: "agency", ori: p.ori, label: p.label, state: stateOfOri(p.ori) } : null;
  if (!place) return { why: "a county or a set of agencies" };
  const time = plan.groupings.filter((g) => g.dimension.startsWith("time."));
  const cats = plan.groupings.filter((g) => !g.dimension.startsWith("time."));
  if (time.length > 1 || time.some((g) => g.dimension !== "time.year" && g.dimension !== "time.month") || cats.length > 1) return { why: "this breakdown" };
  let breakdown: ShrQuestion["breakdown"] = null;
  if (cats.length) {
    const dim = NIBRS_DIM[cats[0].dimension];
    if (!dim) return { why: "a detail Homicide Reports don't record" };
    // A victim has one record; offenders' details count offenders (P29: "by" a group means the offenders).
    if (dim.startsWith("offender.") !== (unit === "offenders") && !RECORD_DIMS.has(dim)) return { why: "a person's detail for the other unit" };
    breakdown = { dim, ...(cats[0].bins ? { bins: cats[0].bins.map((b) => [b.from ?? 0, b.to ?? 120] as [number, number]) } : {}) };
  }
  const filters: ShrFilter[] = [];
  let measure: ShrQuestion["measure"] = m[2] === "justifiable_homicide" ? "justifiable" : (m[2] as "murder" | "homicide");
  const conditions = plan.filters.flatMap((f, gi) => (f.kind === "attribute" ? [{ f, group: undefined as number | undefined }] : f.negate ? [null] : f.where.map((w) => ({ f: w, group: gi }))));
  // Two separate conditions on a record's one weapon, relationship or circumstance ("handguns versus rifles") would
  // count records with both, which a record never has: SHR-A leaves the comparison alone (job SA1).
  // Counted per condition, whatever its group (Codex SHR-A review 02.2).
  const recordDims = conditions.flatMap((c) => (c && RECORD_DIMS.has(NIBRS_DIM[c.f.dimension]) ? [NIBRS_DIM[c.f.dimension]] : []));
  if (new Set(recordDims).size !== recordDims.length) return { why: "two values of one record detail compared" };
  for (const c of conditions) {
    if (!c) return { why: "a negated condition" };
    const { f, group } = c;
    const dim = NIBRS_DIM[f.dimension];
    if (!dim) return { why: "a detail Homicide Reports don't record" };
    if (/age$/.test(dim)) {
      if (f.op !== "between" || !f.values || f.values.length !== 2) return { why: "this age condition" };
      filters.push({ dim, ages: [Number(f.values[0]), Number(f.values[1])], ...(group !== undefined ? { group } : {}) });
      continue;
    }
    if (f.op !== "in" || !f.values?.length) return { why: "this condition" };
    const codes = codesOf(dim, f.values);
    if (!codes) return { why: "a code Homicide Reports record differently" };
    // A justifiable homicide asked for (a felon killed by police or a citizen) is counted as asked (S4).
    if (dim === "circumstance" && codes.every((c) => c === "80" || c === "81")) measure = "justifiable";
    filters.push({ dim, codes, ...(group !== undefined ? { group } : {}) });
  }
  const first = `${SHR_FIRST_YEAR}-01`;
  const to = period.to > build.latestMonth ? build.latestMonth : period.to;
  if (to < first) return { why: "before 1985" };
  // A period after the release's latest month is declined by the usual path, never answered as no filing.
  if (period.from > build.latestMonth) return { why: "after the latest month" };
  const from = period.from < first ? first : period.from;
  const grain = time[0]?.dimension === "time.month" ? "month" : time[0]?.dimension === "time.year" ? "year" : "total";
  return { measure, unit, place, from, to, grain, filters, breakdown, share: stats.length === 2, ...(period.from < first ? { askedFrom: period.from.slice(0, 4) } : {}) };
}

/* ------------------------------------------------------------------ the answer */

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const table = (b: ShrBuild, t: string) => `read_parquet(${q(`${b.root}/canonical/${t}/**/*.parquet`)}, hive_partitioning = 1)`;
const ym = (s: string) => Number(s.slice(0, 4)) * 100 + Number(s.slice(5, 7));

/** The type and circumstance condition of a measure (S4), on shr_record r. */
function measureWhere(sq: ShrQuestion): string {
  if (sq.measure === "justifiable") return "r.homicide_type = 'A' AND r.circumstance IN ('80', '81')";
  return `r.homicide_type IN (${sq.measure === "homicide" ? "'A', 'B'" : "'A'"}) AND r.circumstance NOT IN ('80', '81')`;
}
function placeWhere(p: ShrPlace): string {
  return p.kind === "agency" ? `r.agency_key = ${q(`ori9:${p.ori}`)}` : p.kind === "state" ? `r.state = ${q(p.code)}` : "TRUE";
}
/** A condition on a person (alias a) or the record (r). */
function condition(f: ShrFilter, a: string): string {
  const col = RECORD_DIMS.has(f.dim) ? `r.${DIM_COLUMN[f.dim]}` : `${a}.${DIM_COLUMN[f.dim]}`;
  return f.ages ? `${col} BETWEEN ${f.ages[0]} AND ${f.ages[1]}` : `${col} IN (${f.codes!.map(q).join(", ")})`;
}
/** The category of a person's or record's detail, in SQL: SHR's code, or the age bin; a victim past 11 is Unknown. */
function categorySql(sq: ShrQuestion, a: string): string {
  const b = sq.breakdown!;
  const col = RECORD_DIMS.has(b.dim) ? `r.${DIM_COLUMN[b.dim]}` : `CASE WHEN ${a}.in_record THEN ${a}.${DIM_COLUMN[b.dim]} END`;
  if (!b.bins) return col;
  const ageCol = `CASE WHEN ${a}.in_record THEN ${a}.age END`;
  return `CASE ${b.bins.map(([lo, hi], i) => `WHEN ${ageCol} BETWEEN ${lo} AND ${hi} THEN '${i}'`).join(" ")} END`;
}

export function shrSql(sq: ShrQuestion, build: ShrBuild): string {
  const person = sq.unit === "victims" ? "shr_victim" : "shr_offender";
  const other = sq.unit === "victims" ? "shr_offender" : "shr_victim";
  const own = sq.filters.filter((f) => RECORD_DIMS.has(f.dim) || f.dim.startsWith(sq.unit === "victims" ? "victim." : "offender."));
  const theirs = sq.filters.filter((f) => !own.includes(f));
  const where = [`r.counted`, measureWhere(sq), placeWhere(sq.place), `r.data_year * 100 + r.offense_month BETWEEN ${ym(sq.from)} AND ${ym(sq.to)}`,
    ...own.map((f) => condition(f, "p")),
    // A detail of the other person: any one of the record's (an offender's sex for victims: "killed by women"); the
    // conditions of one group are that same person's (01.3).
    ...[...new Set(theirs.map((f, i) => f.group ?? `solo${i}`))].map((g) => {
      const fs = theirs.filter((f, i) => (f.group ?? `solo${i}`) === g);
      return `EXISTS (SELECT 1 FROM ${table(build, other)} o WHERE o.data_year = r.data_year AND o.source_line_no = r.source_line_no AND ${fs.map((f) => condition(f, "o")).join(" AND ")})`;
    })];
  const keys = [...(sq.grain !== "total" ? ["r.data_year"] : []), ...(sq.grain === "month" ? ["r.offense_month"] : []), ...(sq.breakdown ? [categorySql(sq, "p")] : [])];
  return `SELECT ${[...keys.map((k, i) => `${k} AS k${i}`), "count(*) AS n"].join(", ")} FROM ${table(build, person)} p JOIN ${table(build, "shr_record")} r USING (data_year, source_line_no) `
    + `WHERE ${where.join(" AND ")}${keys.length ? ` GROUP BY ${keys.map((_, i) => `k${i}`).join(", ")}` : ""}`;
}

/** The years a place's agencies filed (any counted record that year), with how many filed, from shr_agency_year. */
function filingSql(sq: ShrQuestion, build: ShrBuild): string {
  const w = sq.place.kind === "agency" ? `agency_key = ${q(`ori9:${sq.place.ori}`)}` : sq.place.kind === "state" ? `state = ${q(sq.place.code)}` : "TRUE";
  return `SELECT data_year, count(DISTINCT agency_key), list(DISTINCT agency_key) FROM ${table(build, "shr_agency_year")} WHERE records > 0 AND ${w} `
    + `AND data_year BETWEEN ${sq.from.slice(0, 4)} AND ${sq.to.slice(0, 4)} GROUP BY data_year`;
}

export function answerShr(sq: ShrQuestion, build: ShrBuild, execute: (sql: string) => unknown[][], hist?: HistoricalBuild): ShrAnswer | ShrDecline {
  const fromY = Number(sq.from.slice(0, 4)), toY = Number(sq.to.slice(0, 4));
  const filed = new Map<number, { agencies: number; keys: string[] }>();
  for (const r of execute(filingSql(sq, build))) filed.set(Number(r[0]), { agencies: Number(r[1]), keys: (r[2] as string[] | null) ?? [] });
  // S3: a year with no filing is blank, unless Crime Index has the agency's murders as 0 that year (a proper 0).
  const properZero = new Set<number>();
  if (sq.place.kind === "agency" && hist) {
    const missing = Array.from({ length: toY - fromY + 1 }, (_, i) => fromY + i).filter((y) => !filed.has(y) && y <= hist.lastYear);
    if (missing.length) for (const r of execute(`SELECT year FROM read_parquet(${q(`${hist.root}/agency_crime.parquet`)}) WHERE ori = ${q(sq.place.ori)} AND murder_total = 0 AND year IN (${missing.join(", ")})`))
      properZero.add(Number(r[0]));
  }
  const counted = (y: number) => filed.has(y) || properZero.has(y);
  const where = sq.place.kind === "agency" ? sq.place.label : sq.place.kind === "state" ? stateName(sq.place.code) : "The United States";
  if (!Array.from({ length: toY - fromY + 1 }, (_, i) => fromY + i).some(counted))
    return { kind: "shr-decline", explanation: `${where === "The United States" ? "No agency" : where} filed no Homicide Reports for ${periodWords(sq.from, sq.to)}${sq.place.kind === "agency" ? "" : " in this place"}.` };
  const got = execute(shrSql(sq, build));
  const nk = got[0] ? got[0].length - 1 : 0;
  const cell = new Map<string, number>(got.map((r) => [r.slice(0, nk).map((x) => (x === null ? "" : String(x))).join("|"), Number(r[nk])]));
  // The periods shown: each year or month of the span, or one total.
  const periods: { key: string[]; label: string | null; year: number }[] = sq.grain === "total" ? [{ key: [], label: null, year: fromY }]
    : sq.grain === "year" ? Array.from({ length: toY - fromY + 1 }, (_, i) => ({ key: [String(fromY + i)], label: String(fromY + i), year: fromY + i }))
    : (() => { const out: { key: string[]; label: string; year: number }[] = []; for (let v = ym(sq.from); v <= ym(sq.to); v = v % 100 === 12 ? v + 89 : v + 1)
      out.push({ key: [String(Math.floor(v / 100)), String(v % 100)], label: `${Math.floor(v / 100)}-${String(v % 100).padStart(2, "0")}`, year: Math.floor(v / 100) }); return out; })();
  // A total over several years is blank if any year in it is (no total over a gap).
  const blankPeriod = (p: typeof periods[number]) => (sq.grain === "total" ? Array.from({ length: toY - fromY + 1 }, (_, i) => fromY + i).some((y) => !counted(y)) : !counted(p.year));
  const cats: { code: string; label: string }[] = !sq.breakdown ? [] : (() => {
    const b = sq.breakdown;
    if (b.bins) return [...b.bins.map(([lo, hi], i) => ({ code: String(i), label: hi >= 120 ? `${lo} and older` : `${lo} to ${hi}` })), { code: "", label: "Unknown" }];
    const seen = new Set(got.map((r) => (r[nk - 1] === null ? "" : String(r[nk - 1]))));
    const labels = DIM_LABELS[b.dim] ?? {};
    const known = (c: string) => c in labels && labels[c] !== "Unknown";
    // No rows at all (a filing year with none, or a proper 0): every category of the list, each 0 (S3; Codex 01.10).
    const codes = /age$/.test(b.dim) ? [...seen].filter((c) => c !== "").sort((a, z) => Number(a) - Number(z))
      : Object.keys(labels).filter((c) => known(c) && (seen.has(c) || got.length === 0));
    const other = [...seen].filter((c) => !codes.includes(c));
    return [...codes.map((c) => ({ code: c, label: labels[c] ?? c })), ...(other.length || got.length === 0 ? [{ code: "", label: "Unknown" }] : [])];
  })();
  const valueOf = (p: typeof periods[number], cat: string | null) => {
    if (blankPeriod(p)) return null;
    if (cat === null) return [...cell.entries()].filter(([k]) => k.split("|").slice(0, p.key.length).join("|") === p.key.join("|")).reduce((s, [, v]) => s + v, 0);
    // "Unknown" gathers a blank code and codes outside SHR's lists (NS, X, NN, P...).
    if (cat === "" && sq.breakdown && !sq.breakdown.bins) {
      const known = new Set(cats.filter((c) => c.code !== "").map((c) => c.code));
      return [...cell.entries()].filter(([k]) => { const parts = k.split("|"); return parts.slice(0, p.key.length).join("|") === p.key.join("|") && !known.has(parts[parts.length - 1]); }).reduce((s, [, v]) => s + v, 0);
    }
    return cell.get([...p.key, cat].join("|")) ?? 0;
  };
  const unitWords = shrUnitWords(sq);
  const timeCols = sq.grain === "year" ? [{ binding: { kind: "grouping" as const, dimension: "time.year" }, header: "Year" }]
    : sq.grain === "month" ? [{ binding: { kind: "grouping" as const, dimension: "time.month" }, header: "Month" }] : [];
  const rows: (string | number | null)[][] = [];
  const columns: ResultTable["columns"] = [...timeCols];
  if (sq.breakdown) {
    columns.push({ binding: { kind: "grouping", dimension: `shr.${sq.breakdown.dim}` }, header: DIM_HEADER[sq.breakdown.dim] });
    columns.push({ binding: { kind: "statistic", as: "count" }, header: ucFirst(unitWords) });
    if (sq.share) columns.push({ binding: { kind: "statistic", as: "share" }, header: "Share (%)" });
    for (const p of periods) {
      const total = valueOf(p, null);
      for (const c of cats) {
        const v = valueOf(p, c.code);
        rows.push([...(p.label ? [p.label] : []), c.label, v, ...(sq.share ? [v === null || !total ? null : Math.round((v * 1000) / total) / 10] : [])]);
      }
    }
  } else {
    columns.push({ binding: { kind: "statistic", as: "count" }, header: ucFirst(unitWords) });
    for (const p of periods) rows.push([...(p.label ? [p.label] : []), valueOf(p, null)]);
  }
  const span = periodWords(sq.from, sq.to);
  const what = shrWhat(sq);
  const text = [`${where}: ${what}${sq.breakdown ? ` by ${DIM_WORDS[sq.breakdown.dim]}` : ""}${sq.grain === "year" ? " by year" : sq.grain === "month" ? " by month" : ""}, ${span}.`,
    "From the FBI's Supplementary Homicide Reports: the homicides agencies reported to the FBI, each victim counted."];
  if (sq.askedFrom) text.push(`Homicide Reports here start in 1985, so ${sq.askedFrom} through 1984 aren't included.`);
  text.push(sq.measure === "murder" ? "Murders are murder and nonnegligent manslaughter; justifiable homicides (a felon killed by police or by a private citizen) are left out."
    : sq.measure === "homicide" ? "Homicides are murder, nonnegligent manslaughter and negligent manslaughter; justifiable homicides (a felon killed by police or by a private citizen) are left out."
    : "Justifiable homicides are felons killed by police or by a private citizen, as the agencies reported them.");
  if (sq.filters.some((f) => RECORD_DIMS.has(f.dim)) || (sq.breakdown && RECORD_DIMS.has(sq.breakdown.dim)))
    text.push("The weapon, relationship and circumstance are the first offender's, counted for each of the incident's victims, as in the FBI's tables.");
  if (sq.place.kind === "agency") {
    const gaps = periods.filter((p) => blankPeriod(p)).map((p) => p.year);
    if (gaps.length) text.push(`A blank ${sq.grain === "month" ? "month" : "year"} is one in which ${sq.place.label} filed no Homicide Reports.`);
    if (hist) { const note = partialNote(sq, build, execute, hist, filed); if (note) text.push(note); }
  } else {
    // S2: the filing agencies, how many, and the share of Crime Index's population they cover; nothing estimated.
    text.push(`A ${sq.place.kind === "state" ? "state" : "national"} total here is the sum of what the agencies that filed Homicide Reports reported; nothing is estimated for agencies that didn't.`);
    const years = Array.from({ length: toY - fromY + 1 }, (_, i) => fromY + i);
    const share = hist ? coverageShares(sq, filed, years, hist, execute) : new Map<number, number>();
    for (const y of years) {
      const f = filed.get(y);
      if (!f) { text.push(`${y}: no agency filed Homicide Reports.`); continue; }
      const s = share.get(y);
      text.push(`${y}: ${fmt(f.agencies)} agencies filed${s !== undefined ? `, covering ${s}% of the population Crime Index lists for ${sq.place.kind === "state" ? stateName(sq.place.code) : "the United States"}` : ""}.`);
    }
  }
  text.push(SHR_SOURCE);
  const period = { from: sq.from, to: sq.to };
  return {
    kind: "shr", question: sq, period,
    meaning: { source: "shr", places: [sq.place], filters: sq.filters.map(filterWords), measures: [{ name: sq.measure, unit: sq.unit === "victims" ? "victim" : "offender" }],
      period, groupings: [...(sq.grain !== "total" ? [sq.grain] : []), ...(sq.breakdown ? [sq.breakdown.dim] : [])], statistic: "count" },
    delivered: { table: { columns, rows }, text },
    read: { table: `${sq.unit === "victims" ? "shr_victim" : "shr_offender"} + shr_record`, release: build.release },
  };
}

/**
 * Jeff 2026-11-11: a filing year whose Homicide Reports hold under 90% of the murders the agency reported to the FBI
 * (Crime Index's murder count) is said, never adjusted, and never named as Crime Index: "Chicago's Homicide Reports for
 * 2021 cover 370 of the 804 murders reported to the FBI"; over several years, one line with only the short years and
 * their shares. The agency's murders (type A without justifiable homicide), whatever the question's filters.
 */
function partialNote(sq: ShrQuestion, build: ShrBuild, execute: (sql: string) => unknown[][], hist: HistoricalBuild, filed: Map<number, unknown>): string | null {
  if (sq.place.kind !== "agency") return null;
  const fromY = Number(sq.from.slice(0, 4)), toY = Number(sq.to.slice(0, 4));
  const years = Array.from({ length: toY - fromY + 1 }, (_, i) => fromY + i).filter((y) => filed.has(y) && y <= hist.lastYear);
  if (!years.length) return null;
  // Each year shown is compared as a whole year, even when the answer shows part of it (Codex SHR-A review 03.1).
  const whole = years;
  const all: ShrQuestion = { ...sq, measure: "murder", unit: "victims", filters: [], breakdown: null, share: false, grain: "year", from: `${whole[0]}-01`, to: `${whole[whole.length - 1]}-12` };
  const shr = new Map(execute(shrSql(all, build)).map((r) => [Number(r[0]), Number(r[1])]));
  const ci = new Map(execute(`SELECT year, murder_total FROM read_parquet(${q(`${hist.root}/agency_crime.parquet`)}) WHERE ori = ${q(sq.place.ori)} AND year IN (${whole.join(", ")}) AND murder_total IS NOT NULL`)
    .map((r) => [Number(r[0]), Number(r[1])]));
  const short = whole.flatMap((y) => { const c = ci.get(y), s = shr.get(y) ?? 0; return c && c > 0 && s < 0.9 * c ? [{ y, s, c }] : []; });
  if (!short.length) return null;
  const city = sq.place.label.split(",")[0];
  if (fromY === toY) return `${city}'s Homicide Reports for ${short[0].y} cover ${fmt(short[0].s)} of the ${fmt(short[0].c)} murders reported to the FBI.`;
  const items = short.map(({ y, s, c }) => `${y} (${Math.round((s * 100) / c)}%)`);
  const list = items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0];
  return `${city}'s Homicide Reports cover less than 90% of the murders reported to the FBI in ${list}.`;
}

/** Each year's share of Crime Index's population that the filing agencies cover (S2), one decimal. */
function coverageShares(sq: ShrQuestion, filed: Map<number, { keys: string[] }>, years: number[], hist: HistoricalBuild, execute: (sql: string) => unknown[][]): Map<number, number> {
  const out = new Map<number, number>();
  const ys = years.filter((y) => filed.has(y) && y <= hist.lastYear);
  if (!ys.length) return out;
  const total = sq.place.kind === "state"
    ? execute(`SELECT year, population FROM read_parquet(${q(`${hist.root}/state_crime.parquet`)}) WHERE state = ${q(sq.place.code)} AND year IN (${ys.join(", ")})`)
    : execute(`SELECT year, population FROM read_parquet(${q(`${hist.root}/nation_crime.parquet`)}) WHERE year IN (${ys.join(", ")})`);
  const denom = new Map(total.map((r) => [Number(r[0]), num(r[1])]));
  for (const y of ys) {
    const oris = filed.get(y)!.keys.filter((k) => k.startsWith("ori9:")).map((k) => k.slice(5));
    const d = denom.get(y);
    if (!oris.length || !d) continue;
    const got = execute(`SELECT sum(population) FROM read_parquet(${q(`${hist.root}/agency_crime.parquet`)}) WHERE year = ${y} AND ori IN (${oris.map(q).join(", ")})`);
    const covered = num(got[0]?.[0]);
    if (covered !== null) out.set(y, Math.min(100, Math.round((covered * 1000) / d) / 10));
  }
  return out;
}

const ucFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/**
 * Each category label a breakdown shows, with the SHR codes it counts, for a blind checker (job SA1): "Unknown" is the
 * list's own Unknown code, a blank, a victim beyond the record's 11 and any code outside the list.
 */
export function shrCategoryCodes(sq: ShrQuestion): Record<string, string[] | string> | null {
  const b = sq.breakdown;
  if (!b) return null;
  if (b.bins) return Object.fromEntries([...b.bins.map(([lo, hi]) => [hi >= 120 ? `${lo} and older` : `${lo} to ${hi}`, `age ${lo}-${hi}`]), ["Unknown", "no age, a code that isn't an age, or a victim beyond the record's 11"]]);
  const labels = DIM_LABELS[b.dim] ?? {};
  const out: Record<string, string[] | string> = {};
  for (const [c, l] of Object.entries(labels)) if (l !== "Unknown") out[l] = [c];
  // A record's weapon, relationship or circumstance counts for every victim, the 12th included (Codex SHR-A review 02.3).
  out.Unknown = `${Object.entries(labels).filter(([, l]) => l === "Unknown").map(([c]) => c).join(", ") || "none"}, a blank code or any code not listed here${RECORD_DIMS.has(b.dim) ? "" : ", or a person beyond the record's 11"}`;
  return out;
}
/** "murder victims", "homicide offenders", "justifiable homicide victims". */
export function shrUnitWords(sq: ShrQuestion): string {
  const crime = sq.measure === "homicide" ? "homicide" : sq.measure === "justifiable" ? "justifiable homicide" : "murder";
  return `${crime} ${sq.unit === "offenders" ? "offenders" : "victims"}`;
}
/** What is counted, with its filters: "murder victims with a firearm" (Codex SHR-A review 01.9). */
export const shrWhat = (sq: ShrQuestion) => [shrUnitWords(sq), ...sq.filters.map(filterWords)].join(" ");
/** A filter in words: "with a firearm", "whose victims were female", "killed by a spouse". */
export function filterWords(f: ShrFilter): string {
  if (f.ages) return `${f.dim.startsWith("victim") ? "victims" : "offenders"} aged ${f.ages[0]} to ${f.ages[1]}`;
  const labels = DIM_LABELS[f.dim] ?? {};
  const names = f.codes!.map((c) => (labels[c] ?? c).toLowerCase());
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0];
  if (f.dim === "weapon") return f.codes!.every((c) => ["11", "12", "13", "14", "15"].includes(c)) && f.codes!.length === 5 ? "with a firearm" : `with a weapon recorded as ${list}`;
  if (f.dim === "relationship") return `where the victim's relationship to the offender was ${list}`;
  if (f.dim === "circumstance") return `where the circumstance was ${list}`;
  return `where the ${f.dim.startsWith("victim") ? "victim" : "offender"}'s ${f.dim.split(".")[1]} was ${list}`;
}
