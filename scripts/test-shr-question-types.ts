/*
 * Request accounting, stage 1, plan r3.1 (tasks 1-2): the closed list of SHR question types, its compiler and its
 * templates. Disposable in-memory rows over the production-derived SHR DDL, built so that dropping any slot changes
 * the number. Expected values come from an INDEPENDENT JavaScript oracle over the same synthetic rows, never from
 * the compiled SQL. Every agency here is SYNTHETIC.
 */
import "./offline-evidence-guard";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { accountShrRequest } from "../lib/shr-request-accounting";
import { SHR_YEAR_CLASS_DDL } from "../lib/shr-agency-year-class";
import {
  planShrQuestion, compileShrQuestion, compiledShrQuestionIssue, executeCompiledShrQuestion, shrQuestionOutcome, observeShrCutoff, specProblem, exactCount,
  type CompiledShrQuestion, type ShrCutoff, type ShrQuestionSpec,
} from "../lib/shr-question-types";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else if (!process.env.QUIET) console.log(`  PASS  ${label}`);
}

/* ---------------- fixture (synthetic) ---------------- */
type V = { sex: string; age: number | null; race?: string; eth?: string };
type I = { id: number; state: string; ori: string; year: number; month: number; type: string; weapon: string; wg: string; rel: string; circ: string; pop: number | null; victims: V[] };
const H = "Handgun - pistol, revolver, etc";
const rows: I[] = [
  { id: 1, state: "TX", ori: "TX0000001", year: 2025, month: 1, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 100000, victims: [{ sex: "Female", age: 4 }, { sex: "Female", age: 30 }, { sex: "Male", age: 30 }] },
  { id: 2, state: "TX", ori: "TX0000001", year: 2025, month: 3, type: "Murder", weapon: "Rifle", wg: "Firearm", rel: "Stranger", circ: "Robbery", pop: 100000, victims: [{ sex: "Female", age: 70, race: "Black" }] },
  { id: 3, state: "TX", ori: "TX0000001", year: 2025, month: 7, type: "Murder", weapon: "Knife or cutting instrument", wg: "Knife/Cutting", rel: "Wife", circ: "Other Arguments", pop: 100000, victims: [{ sex: "Female", age: 40, eth: "Hispanic or Latino" }] },
  { id: 4, state: "TX", ori: "TX0000002", year: 2025, month: 2, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 50000, victims: [{ sex: "Male", age: null }] },
  { id: 5, state: "TX", ori: "TX0000002", year: 2025, month: 9, type: "Manslaughter by Negligence", weapon: "Other", wg: "Other", rel: "Stranger", circ: "Other negligent handling of gun", pop: 60000, victims: [{ sex: "Female", age: 50 }] },
  { id: 6, state: "TX", ori: "TX0000001", year: 2024, month: 2, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 100000, victims: [{ sex: "Female", age: 22 }] },
  { id: 7, state: "AL", ori: "AL0000001", year: 2025, month: 1, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 20000, victims: [{ sex: "Male", age: 25 }] },
  { id: 8, state: "IL", ori: "ILOLD0000", year: 2024, month: 5, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 2700000, victims: [{ sex: "Male", age: 33 }] },
  { id: 9, state: "IL", ori: "ILNEW0000", year: 2025, month: 5, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 2700000, victims: [{ sex: "Male", age: 34 }] },
  { id: 10, state: "IL", ori: "ILOLD0000", year: 2025, month: 6, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 2700000, victims: [{ sex: "Male", age: 35 }] },
  { id: 11, state: "AL", ori: "AL0000002", year: 2025, month: 12, type: "Murder", weapon: "Knife or cutting instrument", wg: "Knife/Cutting", rel: "Acquaintance", circ: "Other Arguments", pop: 180000, victims: [{ sex: "Male", age: 45 }] },
  { id: 12, state: "AL", ori: "AL0000001", year: 2025, month: 6, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Gangland Killings", pop: 20000, victims: [{ sex: "Female", age: 19 }] },
  { id: 13, state: "TX", ori: "TX0000003", year: 2025, month: 4, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 900000, victims: [{ sex: "Male", age: 28 }] },
  { id: 14, state: "TX", ori: "TX0000001", year: 2022, month: 5, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: null, victims: [{ sex: "Male", age: 60 }] },
  { id: 15, state: "MO", ori: "MO0000001", year: 2025, month: 3, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 300000, victims: [{ sex: "Male", age: 31 }] },
  { id: 16, state: "MO", ori: "MO0000002", year: 2025, month: 4, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 90000, victims: [{ sex: "Female", age: 27 }] },
  { id: 17, state: "MO", ori: "MO0000003", year: 2025, month: 5, type: "Murder", weapon: H, wg: "Firearm", rel: "Stranger", circ: "Other Arguments", pop: 40000, victims: [{ sex: "Male", age: 41 }] },
  { id: 18, state: "TX", ori: "TX0000003", year: 2025, month: 8, type: "Manslaughter by Negligence", weapon: "Other", wg: "Other", rel: "Stranger", circ: "Other negligent handling of gun", pop: 950000, victims: [{ sex: "Female", age: 33 }] },
];
const STATE_NAME: Record<string, string> = { TX: "Texas", AL: "Alabama", IL: "Illinois", MO: "Missouri" };
const db = new Database(":memory:");
db.exec(readFileSync("scripts/fixtures/operation-taxonomy/shr.ddl.sql", "utf8"));
db.exec(SHR_YEAR_CLASS_DDL);
let vid = 0;
for (const r of rows) {
  db.prepare(`INSERT INTO incidents (id, year, month, state, state_name, ori, agency, population, homicide_type, situation, weapon, weapon_group, relationship, relationship_group, circumstance, circumstance_group, off_sex)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.id, r.year, r.month, r.state, STATE_NAME[r.state], r.ori, `${r.ori} agency`, r.pop, r.type,
    r.victims.length > 1 ? "Multiple Victims/Single Offender" : "Single Victim/Single Offender", r.weapon, r.wg, r.rel, r.rel === "Stranger" ? "Stranger" : "Known",
    r.circ, /Gang/.test(r.circ) ? "Felony Type" : "Other Than Felony", "Male");
  r.victims.forEach((v, n) => {
    vid += 1;
    db.prepare("INSERT INTO victims (id, incident_id, victim_num, age, age_num, sex, race, ethnicity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(vid, r.id, n + 1, v.age == null ? "Unknown" : String(v.age), v.age, v.sex, v.race ?? "White", v.eth ?? "Not Hispanic or Latino");
  });
}
const ident = db.prepare("INSERT INTO shr_agency_identity VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)");
const alias = db.prepare("INSERT INTO shr_agency_alias VALUES (?, ?, ?, ?, ?, ?, 'synthetic')");
const agency = (ori: string, st: string, canonical: string, type: string, first: number, last: number, aliasName?: string) => {
  ident.run(ori, st, canonical, type, canonical.toUpperCase(), "[]", "[]", first, last);
  if (aliasName) alias.run(aliasName, aliasName.toUpperCase(), ori, st, canonical, type);
};
agency("TX0000001", "TX", "Houston Police Department", "City", 2022, 2025, "Houston");
agency("TX0000002", "TX", "Lake County Sheriff's Office", "County", 2025, 2025);
agency("TX0000003", "TX", "Austin Police Department", "City", 2025, 2025, "Austin");
agency("AL0000001", "AL", "Bayview Police Department", "City", 2025, 2025);
agency("AL0000002", "AL", "Mobile County Sheriff's Office", "County", 2025, 2025);
agency("ILOLD0000", "IL", "Chicago Police Department", "City", 1990, 2024, "Chicago");
agency("ILNEW0000", "IL", "Chicago Police Department", "City", 2025, 2025, "Chicago");
for (const [ori, st, type] of [["MO0000001", "MO", "City"], ["MO0000002", "MO", "County"], ["MO0000003", "MO", "City"]]) agency(ori, st, `${ori} agency`, type, 2025, 2025);
// Year-bound City/County classification (SCA-1). MO0000003 is UNRESOLVED.
const cls = db.prepare("INSERT OR IGNORE INTO shr_agency_year_class VALUES (?, ?, ?, ?, ?, NULL, '{}')");
const CLASS: Record<string, "City" | "County" | null> = { TX0000002: "County", AL0000002: "County", MO0000002: "County", MO0000003: null };
for (const r of rows) {
  const type = r.ori in CLASS ? CLASS[r.ori] : "City";
  cls.run(r.ori, r.state, r.year, type === null ? "unresolved" : type === "City" ? "eligible" : "ineligible", type);
}
db.prepare("INSERT INTO shr_agency_year_class_meta VALUES ('synthetic', '2026-10-08', 'synthetic', ?)").run(rows.length);
// County crosswalk (AL): AL0000001 -> Baldwin, AL0000002 -> Mobile.
const cw = db.prepare("INSERT INTO agency_county_crosswalk VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'synthetic')");
cw.run("AL0000001", "AL0000001", "Bayview Police Department", "AL", 3, "01003", "Baldwin County", "BALDWIN");
cw.run("AL0000002", "AL0000002", "Mobile County Sheriff's Office", "AL", 97, "01097", "Mobile County", "MOBILE");

const CUTOFF = observeShrCutoff(db);
check(CUTOFF.observed && CUTOFF.year === 2025 && CUTOFF.month === 12 && CUTOFF.minYear === 2022, `observed cutoff 2025-12, min 2022 (${JSON.stringify(CUTOFF)})`);

type Run = { compiled: CompiledShrQuestion; rows: Record<string, unknown>[]; coverage: { place: string; period: string | number; has_records: number }[]; disclosures: string[]; withhold: string | null } | { decline: string };
function run(q: string, cutoff: ShrCutoff = CUTOFF): Run {
  const ledger = accountShrRequest(q, {});
  const d = planShrQuestion(ledger, db, q, cutoff);
  if (d.kind === "decline") return { decline: d.explanation };
  if (d.kind === "county-exit") return { decline: `county-exit: ${d.resolution.explanation}` };
  const compiled = compileShrQuestion(d.spec);
  const out = executeCompiledShrQuestion(db, compiled);
  const o = shrQuestionOutcome(db, compiled, out.rows, out.coverage);
  return { compiled, rows: out.rows, coverage: out.coverage, disclosures: o.disclosures, withhold: o.withhold };
}
const specOf = (q: string, cutoff: ShrCutoff = CUTOFF): ShrQuestionSpec | string => {
  const d = planShrQuestion(accountShrRequest(q, {}), db, q, cutoff);
  return d.kind === "spec" ? d.spec : d.kind === "decline" ? `DECLINE: ${d.explanation}` : "county-exit";
};
const answered = (r: Run): r is Exclude<Run, { decline: string }> => !("decline" in r);
function declines(q: string, re: RegExp, label: string, cutoff?: ShrCutoff) {
  const r = run(q, cutoff);
  check("decline" in r && re.test(r.decline), `${label} -> ${"decline" in r ? r.decline.slice(0, 150) : `ANSWERED ${JSON.stringify(r.rows).slice(0, 120)}`}`);
}
const first = (q: string, col: string, cutoff?: ShrCutoff) => { const r = run(q, cutoff); return answered(r) ? r.rows[0]?.[col] : `DECLINE: ${r.decline}`; };

/* ---------------- the oracle (independent of the compiler) ---------------- */
type Pairs = { year: number; month: number }[];
const yr = (a: number, b: number, months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]): Pairs => { const o: Pairs = []; for (let y = a; y <= b; y++) for (const m of months) o.push({ year: y, month: m }); return o; };
type Place = { label: string; test: (r: I) => boolean };
const placeTx: Place = { label: "Texas", test: (r) => r.state === "TX" };
const placeAl: Place = { label: "Alabama", test: (r) => r.state === "AL" };
const placeTxAl: Place = { label: "Texas and Alabama", test: (r) => r.state === "TX" || r.state === "AL" };
const placeHou: Place = { label: "Houston", test: (r) => r.ori === "TX0000001" && r.year >= 2022 && r.year <= 2025 };
const placeUs: Place = { label: "the United States", test: () => true };
type VFilter = { words: string; suffix?: string; test: (r: I, v: V) => boolean };
const measureTest = (m: string) => (r: I) => (m === "murder" ? r.type === "Murder" : m === "negligent manslaughter" ? r.type.startsWith("Manslaughter") : true);
function oracleCount(place: Place, pairs: Pairs, measure: string, unit: "victims" | "incidents", filter: (r: I, v: V) => boolean): number | null {
  const inPeriod = (r: I) => pairs.some((p) => p.year === r.year && p.month === r.month);
  const covered = rows.some((r) => place.test(r) && inPeriod(r));
  if (!covered) return null;
  const qualifying = rows.filter((r) => place.test(r) && inPeriod(r) && measureTest(measure)(r));
  if (unit === "incidents") return qualifying.filter((r) => r.victims.some((v) => filter(r, v))).length;
  return qualifying.reduce((n, r) => n + r.victims.filter((v) => filter(r, v)).length, 0);
}

/* ---------------- T1 combination grid: measure x unit x filter x place x period ---------------- */
const MEASURES = ["murder", "homicide", "negligent manslaughter"];
const UNITS: ("victims" | "incidents")[] = ["victims", "incidents"];
const FILTERS: VFilter[] = [
  { words: "", test: () => true },
  { words: "female", test: (_r, v) => v.sex === "Female" },
  { words: "firearm", test: (r) => r.wg === "Firearm" },
  { words: "female firearm", test: (r, v) => v.sex === "Female" && r.wg === "Firearm" },
  { words: "firearm or knife", test: (r) => r.wg === "Firearm" || r.wg === "Knife/Cutting" },
  { words: "child", test: (_r, v) => v.age != null && v.age <= 17 },
  { words: "", suffix: " killed by a stranger", test: (r) => r.rel === "Stranger" },
];
const PLACES = [placeTx, placeAl, placeTxAl, placeHou, placeUs];
const PERIODS: { words: string; pairs: Pairs }[] = [
  { words: "in 2025", pairs: yr(2025, 2025) },
  { words: "since 2024", pairs: yr(2024, 2025) },
  { words: "before 2025", pairs: yr(2022, 2024) },
  { words: "in Q1 2025", pairs: yr(2025, 2025, [1, 2, 3]) },
  { words: "from 2024 to 2025", pairs: yr(2024, 2025) },
];
let gridRuns = 0;
for (const measure of MEASURES) for (const unit of UNITS) for (const f of FILTERS) for (const place of PLACES) for (const period of PERIODS) {
  const q = `How many ${f.words ? `${f.words} ` : ""}${measure} ${unit}${f.suffix ?? ""} were there in ${place.label} ${period.words}?`;
  const expected = oracleCount(place, period.pairs, measure, unit, f.test);
  const r = run(q);
  gridRuns += 1;
  const got = answered(r) ? r.rows[0]?.[unit] : `DECLINE ${r.decline.slice(0, 100)}`;
  const typeOk = answered(r) && r.compiled.spec.type === "count" && r.rows.length === 1;
  check(typeOk && (got ?? null) === expected, `T1 grid: ${q} -> ${JSON.stringify(got)} (oracle ${expected})`);
}

/* ---------------- Codex r2 findings: each is the correct number or a named decline ---------------- */
// #1 grouping never replaces the statistic: shares/ages by weapon or sex DECLINE (approved scope), never counts.
declines("What share of Texas murder victims were female in 2025 by weapon?", /broken down by year only/, "#1 share by weapon declines");
declines("What was the average age of murder victims in Texas in 2025 by sex?", /broken down by year only/, "#1 average age by sex declines");
// #2 before 2025 = 2022-2024 (source starts 2022).
check(first("How many murder victims were there in Texas before 2025?", "victims") === 2, "#2 Texas murders before 2025 = 2 (2022 + 2024), not 2025's 7");
check(first("How many female murder victims were there in Texas before 2025?", "victims") === 1, "#2 female before 2025 = 1");
// #3 cross-field OR declines whatever the places; a list of places is ONE stated union.
declines("How many female or firearm murder victims were there in Texas and Alabama in 2025?", /"or" works only between values of one condition/, "#3 cross-field OR with two places declines");
declines("How many female or firearm murder victims were there in Texas in 2025?", /"or" works only/, "#3 cross-field OR with one place declines");
{
  const r = run("How many murder victims were there in Texas and Alabama in 2025?");
  check(answered(r) && r.rows.length === 1 && r.rows[0].victims === 10 && /combined/.test(String(r.rows[0].place)) && /combined into one total/.test(r.compiled.explanation), `#3 Texas and Alabama = one stated total 10 (${answered(r) ? JSON.stringify(r.rows) : r.decline})`);
  const each = run("How many murder victims were there in Texas and Alabama separately in 2025?");
  check(answered(each) && each.rows.length === 2 && each.rows[0].victims === 7 && each.rows[1].victims === 3, `#3 "separately" gives each place (${answered(each) ? JSON.stringify(each.rows) : each.decline})`);
  const byState = run("murder victims by state in Texas and Alabama in 2025");
  check(answered(byState) && byState.rows.length === 2 && byState.rows.map((x) => x.victims).join(",") === "7,3", `#3 "by state" gives each place (${answered(byState) ? JSON.stringify(byState.rows) : byState.decline})`);
}
// #4 offenders and cardinality decline.
declines("How many murder offenders were there in Texas in 2025?", /about offenders/, "#4 offenders decline");
declines("What was the average age of murder offenders in Texas in 2025?", /about offenders/, "#4 offender age declines");
declines("How many double murder incidents were there in Texas in 2025?", /not the exact number/, "#4 double murder declines");
declines("How many multiple-victim incidents were there in Texas in 2025?", /single- or multiple-victim/, "#4 multiple-victim situation declines");
// #5 the share denominator follows the subject, both phrasings (3/4 = 75%).
check(first("What share of female murder victims were killed with a firearm in Texas in 2025?", "share_pct") === 75, "#5 share of female murder victims killed with a firearm = 75%");
check(first("What share of murder victims who were female were killed with a firearm in Texas in 2025?", "share_pct") === 75, "#5 relative-clause phrasing = 75% (not 3/7)");
check(first("What share of Texas murder victims were female in 2025?", "share_pct") === 57.1, "#5 share of Texas murder victims who were female = 4/7 = 57.1%");
check(first("what share of murders in Houston involved a firearm since 2024", "share_pct") === 83.3, "#5 Houston firearm share since 2024 = 5/6 = 83.3%");
// #6 coverage: an age over 2023-2025 discloses 2023; a measure-specific absence is a recorded 0.
{
  const r = run("average age of female murder victims in Texas from 2023 to 2025");
  check(answered(r) && r.rows[0].average_victim_age === 33.2 && r.disclosures.some((d) => /no SHR records of any homicide type for 2023/.test(d)), `#6 average age 33.2 with 2023 disclosed (${answered(r) ? JSON.stringify(r.rows) + r.disclosures.join(" | ") : r.decline})`);
  check(first("median age of female murder victims in Texas from 2023 to 2025", "median_victim_age") === 30, "#6 median age 30");
  const m = run("How many female negligent manslaughter victims were there in Texas in 2024?");
  check(answered(m) && m.rows[0].victims === 0 && !m.disclosures.some((d) => /no SHR records/.test(d)), `#6 female negligent manslaughter TX 2024 = recorded 0, not "no records" (${answered(m) ? JSON.stringify(m.rows) + m.disclosures.join(" | ") : m.decline})`);
  const n = run("How many negligent manslaughter victims were there in Texas in 2023?");
  check(answered(n) && n.rows[0].victims === null && n.disclosures.some((d) => /unknown, not zero/.test(d)), "#6 Texas 2023 has no records: unknown, not zero");
  const z = run("What share of female murder victims were killed with a firearm in Illinois in 2025?");
  check(answered(z) && z.rows[0].share_pct === null && z.rows[0].denominator_victims === 0 && z.disclosures.some((d) => /no share to give/.test(d)), `#6 zero denominator: no share (${answered(z) ? JSON.stringify(z.rows) : z.decline})`);
  const a = run("median age of murder victims in Texas by year from 2024 to 2025");
  check(answered(a) && a.rows.length === 2 && a.rows[0].median_victim_age === 22 && a.rows[1].median_victim_age === 30, `T4 by year (${answered(a) ? JSON.stringify(a.rows) : a.decline})`);
}
// #7 dispatch examples reach the types (the route witness checks the route; here the type answers them).
check(first("How many homicides in Texas since 2024?", "victims") === 10, "#7 homicides in Texas since 2024 = 1 + 9 = 10");
{
  const r = run("How many homicides in Texas in 2025 by state?");
  check(answered(r) && r.rows.length === 1 && r.rows[0].place === "Texas" && r.rows[0].victims === 9, `#7 by state = Texas 9 (${answered(r) ? JSON.stringify(r.rows) : r.decline})`);
}
// #8 county results (in r2.1 scope).
{
  const r = run("which county had the most homicides in Alabama in 2025");
  check(answered(r) && r.compiled.spec.type === "top" && r.rows.length === 1 && r.rows[0].county === "Baldwin County, AL" && r.rows[0].victims === 2, `#8 county ranking = Baldwin 2 (${answered(r) ? JSON.stringify(r.rows) : r.decline})`);
  const b = run("homicides by county in Alabama in 2025");
  check(answered(b) && b.rows.map((x) => `${x.county}:${x.victims}`).join(",") === "Baldwin County, AL:2,Mobile County, AL:1", `#8 county breakdown (${answered(b) ? JSON.stringify(b.rows) : b.decline})`);
  declines("which county had the most murders", /need one state/, "#8 county ranking without a state declines by name");
}

/* ---------------- agency type, thresholds, T6 ---------------- */
{
  const r = run("How many murders happened in cities in Missouri in 2025?");
  check(answered(r) && r.rows[0].victims === 1 && r.disclosures.some((d) => /could not be classified/.test(d)) && /city agencies/.test(r.compiled.explanation), `cities in Missouri = 1, unresolved disclosed (${answered(r) ? JSON.stringify(r.rows) + r.disclosures.join(" | ") : r.decline})`);
  const s = run("How many murders were reported by sheriffs in Missouri in 2025?");
  check(answered(s) && s.rows[0].victims === 1 && /sheriffs and county agencies/.test(s.compiled.explanation), `sheriffs in Missouri = 1 (${answered(s) ? JSON.stringify(s.rows) : s.decline})`);
  const tx = run("How many murders happened in cities in Texas in 2025?");
  check(answered(tx) && tx.rows[0].victims === 6, `cities in Texas 2025 = Houston 5 + Austin 1 = 6, sheriff excluded (${answered(tx) ? JSON.stringify(tx.rows) : tx.decline})`);
  declines("murders in big cities in Texas", /no defined size/, "size words decline");
  declines("How many murders happened in cities in Houston in 2025?", /combined with a state or the nation/, "agency type with a named city declines");
}
{
  const r = run("Which cities with a minimum of 2 murders had the most murders in Texas in 2025?");
  check(answered(r) && r.rows.length === 1 && /Houston/.test(String(r.rows[0].city)) && r.rows[0].victims === 5, `T5 threshold: only Houston (${answered(r) ? JSON.stringify(r.rows) : r.decline})`);
  const t = run("murders by city in Texas from 2024 to 2025 by year with at least 3 murders");
  check(answered(t) && t.rows.length === 2 && t.rows.every((x) => /Houston/.test(String(x.city))) && t.rows.map((x) => x.victims).join(",") === "1,5" && /over the whole period/.test(t.compiled.explanation),
    `T2 threshold over the whole period keeps Houston's 2024 row of 1 (${answered(t) ? JSON.stringify(t.rows) : t.decline})`);
  declines("How many murders were there in Texas in 2025 with at least 3 murders?", /only to results listed by place/, "threshold on a single count declines");
  declines("which cities had the most murders over 100k in Texas in 2025", /./, "population threshold declines");
}
{
  check(first("homicide rate in Houston in 2025", "rate_per_100k") === 5, "T6 Houston 2025 = 5 per 100k");
  check(first("firearm murder rate in Houston in 2025", "rate_per_100k") === 4, "T6 firearm-filtered numerator = 4 per 100k");
  const r = run("murder rate in Houston from 2022 to 2025");
  check(answered(r) && r.rows.map((x) => `${x.year}:${x.rate_per_100k}:${x.population_status}`).join(",") === "2022:null:no population recorded,2023:null:no population recorded,2024:1:recorded,2025:5:recorded",
    `T6 by year with no-population and no-records years (${answered(r) ? JSON.stringify(r.rows) : r.decline})`);
  const c = run("homicide rate in Austin in 2025");
  check(answered(c) && c.rows[0].rate_per_100k === null && c.rows[0].population_status === "conflicting population recorded", `T6 conflicting population: no rate (${answered(c) ? JSON.stringify(c.rows) : c.decline})`);
  declines("homicide rate in Texas in 2025", /Historical and Current Trends/, "T6 state rate declines with the pointer");
  declines("homicide rate in Houston through June 2025", /full calendar years/, "T6 partial year declines");
  declines("female homicide rate in Houston in 2025", /population for that group/, "T6 subgroup rate declines");
  const cut = run("homicide rate in Houston since 2024", { ...CUTOFF, month: 9 });
  check(answered(cut) && cut.rows.find((x) => x.year === 2025)?.population_status === "partial year in the source", `T6 year cut short by the source: no rate (${answered(cut) ? JSON.stringify(cut.rows) : cut.decline})`);
}

/* ---------------- T2 / T3 / T5 grids (oracle) ---------------- */
for (const place of [placeTx, placeAl, placeUs]) for (const f of FILTERS.slice(0, 4)) {
  const q = `${f.words ? `${f.words} ` : ""}murder victims by weapon in ${place.label} in 2025`;
  const r = run(q);
  const want = new Map<string, number>();
  for (const x of rows) if (place.test(x) && x.year === 2025 && x.type === "Murder") for (const v of x.victims) if (f.test(x, v)) want.set(x.wg, (want.get(x.wg) ?? 0) + 1);
  const got = answered(r) ? new Map(r.rows.map((x) => [String(x.weapon_group), Number(x.victims)])) : null;
  check(!!got && got.size === want.size && [...want].every(([k, n]) => got.get(k) === n), `T2 grid: ${q} -> ${answered(r) ? JSON.stringify(r.rows) : r.decline}`);
}
for (const place of [placeTx, placeAl, placeTxAl]) for (const [base, baseTest] of [["", () => true], ["female ", (_r: I, v: V) => v.sex === "Female"]] as const) for (const [cond, condWords, condTest] of [
  ["firearm", "were killed with a firearm", (r: I) => r.wg === "Firearm"],
  ["female", "were female", (_r: I, v: V) => v.sex === "Female"],
  ["stranger", "were killed by a stranger", (r: I) => r.rel === "Stranger"],
] as const) {
  if (base && cond === "female") continue;
  const q = `What share of ${base}murder victims in ${place.label} ${condWords} in 2025?`;
  const den = rows.filter((x) => place.test(x) && x.year === 2025 && x.type === "Murder").flatMap((x) => x.victims.filter((v) => baseTest(x, v)).map((v) => [x, v] as const));
  const num = den.filter(([x, v]) => condTest(x, v)).length;
  const want = den.length ? Math.round((1000 * num) / den.length) / 10 : null;
  check(first(q, "share_pct") === want, `T3 grid: ${q} -> ${first(q, "share_pct")} (oracle ${want})`);
}
for (const [dimWords, col, key] of [["state", "state", (x: I) => STATE_NAME[x.state]], ["county", "county", null]] as const) {
  if (!key) continue;
  const r = run(`which ${dimWords} had the most murders in 2025`);
  const counts = new Map<string, number>();
  for (const x of rows) if (x.year === 2025 && x.type === "Murder") counts.set(key(x), (counts.get(key(x)) ?? 0) + x.victims.length);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  check(answered(r) && r.rows[0][col] === top[0] && r.rows[0].victims === top[1], `T5 grid: top ${dimWords} 2025 -> ${answered(r) ? JSON.stringify(r.rows) : r.decline} (oracle ${top})`);
}

/* ---------------- period grammar (plan r3.1 R2 table) ---------------- */
const periodsOf = (q: string, cutoff: ShrCutoff = CUTOFF) => {
  const s = specOf(q, cutoff);
  if (typeof s === "string") return s;
  const byYear = new Map<number, number[]>();
  for (const p of s.periods) byYear.set(p.year, [...(byYear.get(p.year) ?? []), p.month]);
  return [...byYear].map(([y, ms]) => (ms.length === 12 ? `${y}` : `${y}:${ms.join(".")}`)).join(" ");
};
const PERIOD_TABLE: [string, string][] = [
  ["homicides in Texas in 2024", "2024"],
  ["homicides in Texas 2022 to 2024", "2022 2023 2024"],
  ["homicides in Texas between 2022 and 2024", "2022 2023 2024"],
  ["homicides in Texas 2022-2024", "2022 2023 2024"],
  ["homicides in Texas since 2024", "2024 2025"],
  ["homicides in Texas after 2023", "2024 2025"],
  ["homicides in Texas before 2025", "2022 2023 2024"],
  ["homicides in Texas in March 2025", "2025:3"],
  ["homicides in Texas January through June 2025", "2025:1.2.3.4.5.6"],
  ["homicides in Texas in Q2 2025", "2025:4.5.6"],
  ["homicides in Texas in the second quarter of 2025", "2025:4.5.6"],
  ["homicides in Texas in the first half of 2025", "2025:1.2.3.4.5.6"],
  ["homicides in Texas in 2025 through June", "2025:1.2.3.4.5.6"],
  ["homicides in Texas in 2025 through 6/30", "2025:1.2.3.4.5.6"],
  ["homicides in Texas through July of each year from 2023 to 2024", "2023:1.2.3.4.5.6.7 2024:1.2.3.4.5.6.7"],
  ["homicides in Texas in March", "2022:3 2023:3 2024:3 2025:3"],
  ["homicides in Texas in the last 2 years", "2024 2025"],
  ["homicides in Texas in 2020 and 2024", "2020 2024"],
];
for (const [q, want] of PERIOD_TABLE) { const got = periodsOf(q); check(got === want, `R2 period: "${q}" -> ${got} (want ${want})`); }
check(periodsOf("homicides in Texas in the last 2 years", { ...CUTOFF, month: 9 }) === "2023 2024", "R2: last N years end at the last COMPLETE year (cutoff 2025-09 -> 2023-2024)");
check(periodsOf("homicides in Texas through 6/30") === "2022:1.2.3.4.5.6 2023:1.2.3.4.5.6 2024:1.2.3.4.5.6 2025:1.2.3.4.5.6", "R2 clarification 1: \"through 6/30\" alone uses the yearless rule");
for (const q of ["homicides in Alabama in summer 2025", "homicides in Alabama in fiscal year 2025", "homicides in Alabama on 2025.03.01", "homicides in Alabama in the first 100 days of 2025", "homicides in Alabama in mid-2025", "homicides in Alabama in late 2025", "homicides in Alabama in 2025 through 6/15"]) {
  declines(q, /can't read .* as a period/, `R2 declined period: ${q}`);
}
const UNOBSERVED: ShrCutoff = { year: 0, month: 0, observed: false, minYear: 0 };
for (const q of ["homicides in Texas since 2024", "homicides in Texas before 2025", "homicides in Texas in the last 2 years", "homicides in Texas", "homicides in Texas through 6/30"]) {
  declines(q, /latest month in the data can't be confirmed/, `R2 unobserved cutoff declines: ${q}`, UNOBSERVED);
}
check(typeof specOf("homicides in Texas in 2024", UNOBSERVED) !== "string", "R2 unobserved cutoff: explicit years still answered");
{
  const r = run("homicides in Texas in 2020 and 2024");
  check(answered(r) && r.compiled.spec.time === "year" && r.rows.length === 2 && r.rows[0].victims === null && r.rows[1].victims === 1, `a year list is shown year by year; 2020 unknown (${answered(r) ? JSON.stringify(r.rows) : r.decline})`);
}

/* ---------------- approved declines ---------------- */
declines("homicide rate in Alabama in 2025", /Historical and Current Trends/, "state rate declines");
declines("homicide rate per 100,000 in baldwin county al in 2024", /Historical and Current Trends|single agency/, "county rate declines");
declines("how much did homicides increase in Alabama from 2022 to 2024", /counts by year instead/, "change declines");
declines("median age of shooters in fatal shootings", /offenders|fatal-shooting/, "shooter age declines");
declines("Share of murder victims with an unknown relationship by sex and year", /broken down by year only/, "share by sex and year declines");
declines("homicides in baldwin county al in 2025 excluding Bay Minette", /Excluding or negating/, "excluding a place declines");
declines("homicides excluding murders in 2025", /Excluding or negating/, "excluding murders declines");
declines("murder via banana in Texas in 2025", /./, "banana still declines (recognition gate covers it at the route)");

/* ---------------- Codex r2 probe wordings not covered above ---------------- */
declines("How many murder victims under 5 or over 65 were there in Texas in 2025?", /one age range at a time|"or" works only/, "probe-7: age ranges joined by or decline");
declines("What share of murder victims were female and killed with a firearm in Texas in 2025?", /which condition the share is of/, "extra-10: two numerator conditions in one predicate decline");
declines("How many murder victims were there in Texas in January 2024 and February 2025 through July?", /which of the named periods/, "extra-3: month-only wording beside month-year pairs declines");
declines("How many murders in Chicago and Texas in 2025?", /can't combine a state and a city/, "extra-8: a city and a state in one number declines");
{
  const r = run("How many female murder victims were there in January 2024 and February 2025 in Texas?");
  check(answered(r) && r.compiled.spec.periods.map((p) => `${p.year}-${p.month}`).join(",") === "2024-1,2025-2", `probe-13: (year, month) pairs, never four combinations (${answered(r) ? JSON.stringify(r.compiled.spec.periods) : r.decline})`);
  check(answered(r) && r.rows[0].victims === 0 && r.disclosures.some((d) => /2024/.test(d)), "probe-13: Feb 2025 has records (0 female), Jan 2024 has none (disclosed)");
  check(first("How many firearm or knife murder victims were there in Texas in 2025?", "victims") === 7, "probe-3: firearm or knife = 7 (every Texas 2025 murder victim: 6 firearm + 1 knife)");
  check(first("How many handgun or knife murder victims were there in Texas in 2025?", "victims") === 6, "probe-4: handgun (5) or knife (1) = 6; the rifle victim excluded");
  check(first("What share of murder victims in Texas in 2025 were under 5?", "share_pct") === 14.3, "extra-4: share under 5 = 1/7 = 14.3%");
}

/* ---------------- relationship direction and lists (found by the r3 usefulness record) ---------------- */
{
  const r = run("murders of women by their husbands in Texas in 2025");
  check(answered(r) && r.rows[0].victims === 1 && /offender's wife/.test(r.compiled.explanation), `"killed by their husbands": the victim was the WIFE = 1 (${answered(r) ? JSON.stringify(r.rows) + r.compiled.explanation.slice(0, 120) : r.decline})`);
  check(first("murders of husbands in Texas in 2025", "victims") === 0, "\"murders of husbands\": the victim was the husband = recorded 0");
  const s = run("homicides involving same-sex partners in Texas in 2025");
  check(answered(s) && /same-sex relationship/.test(s.compiled.explanation) && !/intimate partner/.test(s.compiled.explanation) && s.rows[0].victims === 0, `same-sex partners is the same-sex relationship value, not every intimate partner (${answered(s) ? s.compiled.explanation.slice(0, 120) : s.decline})`);
  const e = run("murders of employees by their employers in Texas in 2025");
  check(answered(e) && /offender's employee/.test(e.compiled.explanation) && !/employer/.test(e.compiled.explanation), `employees killed by their employers = the Employee value only (${answered(e) ? e.compiled.explanation.slice(0, 120) : e.decline})`);
  check(first("murders of wives or girlfriends in Texas in 2025", "victims") === 1, "wives or girlfriends = a list (1)");
  declines("murder victims killed by a stranger by their husbands in Texas in 2025", /ambiguous/, "two different relationships with no and/or decline");
}

/* ---------------- r4: every part consumed (plan r4.1; Codex r3 findings 1-5) ---------------- */
// #1 one kind of number; the gate.
declines("What was the average age and share of murder victims who were female in Texas in 2025?", /one kind of number/, "r4 #1 average age AND share declines (never reduced to a share)");
declines("What share of murder victims were female in the top 5 states in 2025?", /one kind of number/, "r4 #1 share in the top 5 states declines (never a national share)");
declines("What was the median age and average age of murder victims in Texas in 2025?", /one kind of number/, "r4 #1 two different age statistics decline");
declines("What was the average age of murder victims in the top 5 states in 2025?", /one kind of number/, "r4 #1 age plus a ranking declines");
check(first("What was the average age of murder victims in Texas in 2025?", "average_victim_age") === 33.7, "r4 #1 the age alone still answers ((4+30+30+70+40+28)/6 = 33.7)");
// #2 empty and reversed ranges.
declines("How many female murder victims were there in Texas since 2026?", /nothing since 2026 yet/, "r4 #2 since a year after the latest data declines (never every year)");
declines("How many female murder victims were there in Texas after 2025?", /nothing after 2025 yet/, "r4 #2 after the latest year declines");
declines("How many murder victims were there in Texas from 2025 to 2022?", /ends before it starts/, "r4 #2 a reversed range declines");
check(first("How many female murder victims were there in Texas in the last 5 complete years?", "victims") === 5, "r4 period: last 5 complete years 2021-2025 = 1 + 4");
// #3 thresholds.
{
  const r = run("homicides in Texas and Alabama in 2025 by state with at least 5 homicides");
  check(answered(r) && r.rows.length === 1 && r.rows[0].place === "Texas" && r.rows[0].victims === 9, `r4 #3 place rows keep the threshold: only Texas (9) (${answered(r) ? JSON.stringify(r.rows) : r.decline})`);
  declines("murder victims by city in Texas from 2024 to 2025 by year with at least 2 incidents", /counts incidents, but this answer counts victims/, "r4 #3 a threshold in a different unit declines (never swaps the unit)");
  declines("murders by city in Texas in 2025 with at least 2 homicides", /different homicide type/, "r4 #3 a threshold about a different homicide type declines");
  const g = run("murders by city in Texas from 2023 to 2025 by year with at least 2 murders");
  check(answered(g) && g.rows.map((x) => `${String(x.city)}:${x.year}:${x.victims}`).join(",") === "Houston Police Department, TX:2023:null,Houston Police Department, TX:2024:1,Houston Police Department, TX:2025:5",
    `r4 #3 a passing place lists EVERY year, the missing one NULL (${answered(g) ? JSON.stringify(g.rows) : g.decline})`);
  declines("How many murders were there in Texas in 2025 with at least 3 murders?", /only to results listed by place/, "r4 #3 a threshold on a single count declines through the gate");
}
// #4 coverage per constituent.
{
  const r = run("How many female murder victims were there in Texas and Alabama from 2023 to 2025?");
  const text = answered(r) ? r.disclosures.join(" ") : "";
  check(answered(r) && r.rows[0].victims === 6 && /Texas has no SHR records[^.]*2023/.test(text) && /Alabama has no SHR records[^.]*2023, 2024/.test(text),
    `r4 #4 combined total 6 names Texas 2023 AND Alabama 2023, 2024 (${answered(r) ? JSON.stringify(r.rows) + " | " + text.slice(0, 260) : r.decline})`);
}
// #5 T6 grain, scale, explicit partial year, no-records wording.
declines("homicide rate in Houston in 2025 by month", /given year by year/, "r4 #5 T6 by month declines (never an annual rate)");
declines("homicide rate per 1000 residents in Houston in 2025", /per 100,000 residents, so I can't give a rate "per 1000 residents"/, "r4 #5 T6 per 1,000 declines (never per 100,000)");
check(first("homicide rate per 100,000 residents in Houston in 2025", "rate_per_100k") === 5, "r4 #5 per 100,000 residents is accepted");
declines("homicide rate in Houston through September 2025", /full calendar years/, "r4 #5 explicit partial year declines even when it equals the cutoff", { ...CUTOFF, month: 9 });
{
  const r = run("homicide rate in Houston in 2023");
  check(answered(r) && r.rows[0].population_status === "no population recorded" && r.rows[0].rate_per_100k == null && r.disclosures.some((d) => /no homicide reports in this data for 2023/.test(d)), `r4 #5 no records: "no population recorded", no rate (${answered(r) ? JSON.stringify(r.rows) : r.decline})`);
}
// Codex r3 probes beyond the findings.
check(first("How many female victims were there in Texas in 2025?", "victims") === 4, "r4 default homicide type is MURDER (4; all homicides would be 6)");
{
  const r = run("How many female negligent manslaughter victims were there in Texas in 2024 by weapon?");
  check(answered(r) && r.rows.length === 1 && r.rows[0].victims === 0, `r4 a breakdown with records but no match is a recorded 0 (${answered(r) ? JSON.stringify(r.rows) : r.decline})`);
  const p = run("How many murder victims were killed by their parents in Texas in 2025?");
  check(answered(p) && p.rows[0].victims === 0 && /offender's child/.test(p.compiled.explanation), `r4 "killed by their parents": the victim was the offender's CHILD (${answered(p) ? p.compiled.explanation.slice(0, 120) : p.decline})`);
  declines("How many murder victims were killed by their mother in Texas in 2025?", /by their mother/, "r4 a single parent offender has no one-value inverse: declined");
}

check(first("murders of children under 5 in Texas in 2025", "victims") === 1, "r4 two merged age wordings are both consumed (children + under 5 = the 4-year-old)");

/* ---------------- r5: every part PRESERVED in the compiled request (plan r5; Codex r4 findings) ---------------- */
declines("homicides in Texas and Alabama in 2025 by state with at least 5 homicides and at least 2 homicides", /one minimum or maximum/, "r5 #1 two different minimums decline (never the last one silently)");
declines("homicides in Texas and Alabama in 2025 by state with at least 5 homicides and at most 2000 homicides", /one minimum or maximum/, "r5 #1/#3 'at most 2000' is a threshold, not a year: two bounds decline (and no throw)");
{
  const u = run("homicides in Texas and Alabama in 2025 by state with fewer than 2000 homicides");
  check(answered(u) && u.rows.map((x) => `${x.place}:${x.victims}`).join(",") === "Texas:9,Alabama:3", `r5 an upper bound alone answers (${answered(u) ? JSON.stringify(u.rows) : u.decline})`);
  const same = run("homicides in Texas and Alabama in 2025 by state with at least 5 homicides, at least 5 homicides");
  check(answered(same) && same.rows.length === 1 && same.rows[0].place === "Texas", `r5 an identical repeated threshold is one value (${answered(same) ? JSON.stringify(same.rows) : same.decline})`);
}
declines("How many female murder victims were there in Texas from July to January 2025?", /ends before it starts/, "r5 #2 reversed month span declines (never every year)");
declines("How many female murder victims were there in Texas in July-January 2025?", /ends before it starts/, "r5 #2 reversed month span with a dash declines");
declines("How many murders were there in Texas from November through February?", /ends before it starts/, "r5 #2 a span across the year boundary declines");
declines("What are the top 5 and top 10 states by murders in 2025?", /two different rankings/, "r5 #1 two different ranking sizes decline");
declines("How many murders were there in Texas and Alabama separately and combined in 2025?", /two different ways of combining/, "r5 #1 'separately' and 'combined' decline");
declines("Which state had the most murders in Texas and Alabama in 2025?", /not of a list of places/, "r5 #4 a ranking over a list of places declines (never a thrown error)");
{
  const m = run("How many murders were there in Texas in March?");
  check(answered(m) && m.rows.map((x) => `${x.year}:${x.victims}`).join(",") === "2022:null,2023:null,2024:null,2025:1", `r5 a month with no year keeps the March restriction, every year (${answered(m) ? JSON.stringify(m.rows) : m.decline})`);
  const j = run("How many murders were there in Texas from January to June in 2024 and 2025?");
  check(answered(j) && j.rows.map((x) => `${x.year}:${x.victims}`).join(",") === "2024:1,2025:6", `r5 a month span with listed years composes across parts (${answered(j) ? JSON.stringify(j.rows) : j.decline})`);
  const t5 = run("Which 5 states had the most murders in 2025?");
  check(answered(t5) && t5.compiled.spec.rank?.n === 5 && t5.rows.length >= 1 && t5.rows.length <= 5, `r5 "5" and "most" are one compatible ranking (${answered(t5) ? JSON.stringify(t5.compiled.spec.rank) : t5.decline})`);
  check(first("How many murders were there in Texas in 2025, murders only?", "victims") === 7, "r5 a semantically identical repeat (murders ... murders) is consumed together");
}
{
  const base = specOf("How many murder victims were there in Texas in 2025?");
  if (typeof base !== "string") {
    check(specProblem({ ...base, type: "top", dimension: null, rank: null }) !== null, "r5 #4 spec validation: a ranking without places to rank is refused before compiling");
    check(specProblem({ ...base, type: "share", numerator: null }) !== null, "r5 #4 spec validation: a share without its condition is refused");
    check(specProblem(base) === null, "r5 #4 spec validation: a valid spec passes");
  } else check(false, "r5 spec-validation base answered");
}

/* ---------------- r6: raw requested values; resolved-meaning thresholds; lossless numbers (plan r6.1) ---------------- */
declines("What are the top 60 counties by murders in Alabama in 2025?", /up to 50 places; you asked for 60/, "r6 #1 a ranking above 50 declines by name (never capped)");
declines("What are the top 51 and top 60 counties by murders in Alabama in 2025?", /up to 50|two different rankings/, "r6 #1 51 and 60 never collapse into 50");
declines("Which 60 counties had the most murders in Alabama in 2025?", /you asked for 60/, "r6 #1 the numbered-entity branch records the raw count too");
{
  const t50 = run("What are the top 50 counties by murders in Alabama in 2025?");
  check(answered(t50) && t50.compiled.spec.rank?.n === 50, `r6 a ranking of exactly 50 answers with n = 50 (${answered(t50) ? JSON.stringify(t50.compiled.spec.rank) : t50.decline})`);
  const same = run("homicides in Texas and Alabama in 2025 by state with at least 5 homicides and at least 5");
  check(answered(same) && same.rows.length === 1 && same.rows[0].place === "Texas", `r6 #2 a threshold with its measure implied equals the stated one (${answered(same) ? JSON.stringify(same.rows) : same.decline})`);
  const commas = run("homicides in Texas and Alabama in 2025 by state with at least 1,000 homicides and at least 1000 homicides");
  check(answered(commas) && commas.rows.length === 0, `r6.1 "1,000" and "1000" are one value (no state reaches it here) (${answered(commas) ? JSON.stringify(commas.rows) : commas.decline})`);
}
declines("homicides in Texas and Alabama in 2025 by state with at least 5 incidents and at least 5", /counts incidents, but this answer counts victims/, "r6 #2 a stated unit that differs still declines");
declines("homicides in Texas and Alabama in 2025 by state with at least 9007199254740993 homicides", /"9007199254740993"/, "r6.1 an unsafe amount is declined with its exact token");
declines("homicides in Texas and Alabama in 2025 by state with at least 9007199254740992 homicides and at least 9007199254740993 homicides", /9007199254740992|9007199254740993/, "r6.1 two unsafe amounts never collapse into one");
declines("What are the top 9007199254740993 states by murders in 2025?", /"9007199254740993"/, "r6.1 an unsafe rank count is declined with its exact token");
check(exactCount("9007199254740993").ok === false && exactCount("9007199254740991").ok === true && (exactCount("1,000") as { key: string }).key === "1000" && (exactCount("010") as { key: string }).key === "10", "r6.1 exactCount: unsafe tokens refused, commas and leading zeros normalized exactly");

/* ---------------- issuance ---------------- */
{
  const r = run("How many murder victims were there in Texas in 2025?");
  if (answered(r)) {
    check(compiledShrQuestionIssue(r.compiled) === null, "issued compilation runs");
    const forged = { ...r.compiled, sql: r.compiled.sql.replace("i.homicide_type = 'Murder'", "1 = 1") } as CompiledShrQuestion;
    check(compiledShrQuestionIssue(forged) !== null, "an altered copy is refused");
    check(Object.isFrozen(r.compiled) && Object.isFrozen(r.compiled.spec), "compilation and spec are frozen");
  } else check(false, "issuance base question answered");
}

console.log(`\n${checks - failures}/${checks} passed (T1 grid ${gridRuns} questions)`);
if (failures > 0) process.exit(1);
