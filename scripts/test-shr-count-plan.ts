/*
 * GC-080 owned count (Codex reassessment ruling, 2026-09-27): county-bound and all-homicide victim
 * counts are compiled by the application from one typed plan; the model writes no SQL for them.
 *
 * Held here:
 *   1. the family and the planner's decisions: geography (cities, one county, one state, national),
 *      explicit calendar periods, series, measure, and the incident unit -- plus an owned limitation
 *      for every meaning a plain total would otherwise discard;
 *   2. the compiler: one statement per plan, the Murder restriction exactly when measure = murder,
 *      ORI ranges as OR predicates (so overlapping ranges cannot multiply victims), incident geography
 *      for a state, no geography predicate for the nation;
 *   3. executed counts on disposable rows: sums, a missing middle year UNKNOWN (never zero), leaked or
 *      omitted geography changing the total;
 *   4. execution authority: only an issued, unaltered compilation runs or validates; an altered copy,
 *      an altered plan or loose SQL is refused at the validator and at execution;
 *   5. the validator withdraws the legacy murder-only rule only on the plan's own all-homicide measure.
 * Delivered answers through the real route: audit/phase3-gc080-2026-09-26/owned-count-witness.cjs.
 * Disposable in-memory fixtures only; every agency here is SYNTHETIC except the reference ORI AL00500.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import Database from "better-sqlite3";
import {
  shrOwnedCountFamily, planShrOwnedCount, compileShrCountPlan, compiledShrCountIssue, executeCompiledShrCount,
  shrCountNarrative, type ShrCountPlan, type CompiledShrCount,
} from "../lib/shr-count-plan";
import { validateCompiledShrCount, SHR_OWNED_COUNT_GUARDRAIL } from "../lib/shr-authority";
import { validateQueryContractSql } from "../lib/query-contract-validator";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE incidents (id INTEGER PRIMARY KEY, year INTEGER, month INTEGER, state TEXT, ori TEXT, agency TEXT, homicide_type TEXT, weapon_group TEXT, agency_type TEXT);
  CREATE TABLE victims (id INTEGER PRIMARY KEY, incident_id INTEGER);
  CREATE TABLE agency_county_crosswalk (ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_fips TEXT, county_key TEXT);
  CREATE TABLE shr_agency_identity (ori TEXT, state TEXT, canonical_agency TEXT, agency_type TEXT, source_agency_names TEXT, first_year INTEGER, last_year INTEGER);
  INSERT INTO agency_county_crosswalk VALUES
    ('AL00500','AL0050000','BALDWIN COUNTY SHERIFFS OFFICE','AL','01003','BALDWIN'),
    ('AL00201','AL0020100','BAY MINETTE PD','AL','01003','BALDWIN');
  INSERT INTO shr_agency_identity VALUES
    ('AL00500','AL','Baldwin County Sheriff''s Office','County','["BALDWIN COUNTY SHERIFFS OFFICE"]',1990,2025),
    ('AL0020100','AL','Bay Minette Police Department','City','["Bay Minette PD"]',1990,2025);
`);
let incident = 0; let victim = 0;
function add(ori: string, state: string, year: number, month: number, type: string, victims: number) {
  incident += 1;
  db.prepare("INSERT INTO incidents VALUES (?,?,?,?,?,?,?,?,?)").run(incident, year, month, state, ori, ori, type, "Other", "County");
  for (let n = 0; n < victims; n++) { victim += 1; db.prepare("INSERT INTO victims VALUES (?,?)").run(victim, incident); }
}
add("AL00500", "AL", 2025, 3, "Murder", 2);                       // two-victim incident
add("AL00500", "AL", 2025, 5, "Murder", 1);
add("AL00500", "AL", 2025, 7, "Manslaughter by Negligence", 1);   // all homicides only
add("AL00500", "AL", 2022, 1, "Murder", 1);                       // 2023 deliberately empty
add("AL00500", "AL", 2024, 2, "Manslaughter by Negligence", 2);
add("AL0020100", "AL", 2025, 4, "Murder", 3);                     // countywide member
add("TX00001", "TX", 2025, 6, "Murder", 5);                       // another state
add("TX00001", "TX", 2023, 6, "Manslaughter by Negligence", 1);

const value = (rows: Record<string, unknown>[], col: string) => rows.map((r) => r[col]);
const plan = (p: Partial<ShrCountPlan> & Pick<ShrCountPlan, "geography" | "period">): ShrCountPlan =>
  ({ series: "total", measure: "homicide", unit: "victims", ...p });
const decide = (q: string) => planShrOwnedCount(q, db);

console.log("\n1 - the owned family and the planner's decisions");
{
  check(shrOwnedCountFamily("number of homicides in baldwin county al in 2025"), "a county all-homicide request is owned");
  check(shrOwnedCountFamily("number of murders in baldwin county al in 2025"), "a county murder request is owned (county-bound)");
  check(shrOwnedCountFamily("homicides in Texas from 2020 to 2024"), "a state all-homicide request is owned");
  check(!shrOwnedCountFamily("murders in Texas in 2024 by weapon"), "an unbound murder request stays on the accepted murder path");
  check(!shrOwnedCountFamily("number of murders for Metro County Police Department, AL in 2025"), "a named county police department is not a county request");

  const g = decide("number of homicides in baldwin county al in 2025");
  check(g.kind === "plan" && g.plan.geography.kind === "county" && g.plan.geography.binding.kind === "sheriff" && g.plan.measure === "homicide"
    && g.plan.period.kind === "year" && g.plan.period.year === 2025 && g.plan.series === "total", "GC-080: sheriff binding, all homicides, 2025, total");
  const cw = decide("number of homicides across all agencies in baldwin county al in 2025");
  check(cw.kind === "plan" && cw.plan.geography.kind === "county" && cw.plan.geography.binding.kind === "countywide", "explicit countywide keeps the countywide binding");
  const st = decide("homicides in Alabama from 2022 to 2024 by year");
  check(st.kind === "plan" && st.plan.geography.kind === "state" && st.plan.geography.state === "AL" && st.plan.period.kind === "range" && st.plan.series === "annual",
    "a state range by year: incident geography, explicit range, annual series");
  const na = decide("homicides nationally in 2025");
  check(na.kind === "plan" && na.plan.geography.kind === "national", "national wording: the national dataset");
  const mo = decide("monthly homicides in baldwin county al in 2025");
  check(mo.kind === "plan" && mo.plan.series === "monthly", "monthly series for one year");
  const th = decide("homicides in baldwin county al in 2025 through june");
  check(th.kind === "plan" && th.plan.period.kind === "year" && th.plan.period.throughMonth === 6, "one year through a month");
  const inc = decide("number of all homicides including murders and negligent manslaughter in baldwin county al in 2025");
  check(inc.kind === "plan" && inc.plan.measure === "homicide", "an inclusion clause naming murders stays all homicides (credited G80-3)");
  const ni = decide("number of homicides, not incidents, in baldwin county al in 2025");
  check(ni.kind === "plan" && ni.plan.unit === "victims", "\"not incidents\" is a victim count");
  const cm = decide("number of murders in baldwin county al in 2025");
  check(cm.kind === "plan" && cm.plan.measure === "murder" && cm.plan.geography.kind === "county", "county murders: owned, murder measure");

  const limits: [string, string][] = [
    ["number of homicide incidents in baldwin county al in 2025", "owned-count-incident-unit"],
    ["homicide rate in Alabama in 2025", "owned-count-rate"],
    ["how much did homicides increase in Alabama from 2022 to 2024", "owned-count-change"],
    ["homicides in baldwin county al in 2025 excluding Bay Minette", "owned-count-exclusion"],
    ["homicides by weapon in Alabama in 2025", "owned-count-breakdown"],
    ["female homicide victims in baldwin county al in 2025", "owned-count-breakdown"],
    ["homicides by county in Alabama in 2025", "owned-count-breakdown"],
    ["which county had the most homicides in Alabama in 2025", "owned-count-statistic"],
    ["homicides in Alabama in the last 5 years", "owned-count-period-relative"],
    ["homicides in Alabama since 2020", "owned-count-period-relative"],
    ["homicides in Alabama in 2020 and 2024", "owned-count-period-ambiguous"],
    ["homicides in Alabama", "owned-count-period-missing"],
    ["homicides in Alabama in March 2025", "owned-count-period-month"],
    ["monthly homicides in Alabama from 2022 to 2024", "owned-count-series"],
    ["homicides in baldwin county al and mobile county al in 2025", "owned-count-mixed-geography"],
    ["homicides in Alabama and Texas in 2025", "owned-count-mixed-geography"],
    ["homicides in 2025", "owned-count-geography-missing"],
  ];
  for (const [q, reason] of limits) {
    const d = decide(q);
    check(d.kind === "limitation" && d.reason === reason, `owned limitation ${reason}: "${q}" (got ${d.kind === "limitation" ? d.reason : d.kind})`);
  }
  // Complete-period admission (Codex OC1): a year inside unrepresented time wording is not the period.
  const partial = [
    "number of homicides in baldwin county al in the first six months of 2025",   // Codex OC1 probe
    "number of homicides in baldwin county al in the second quarter of 2025",     // Codex OC1 probe
    "homicides in Alabama in the first half of 2025",
    "homicides in Alabama in Q2 2025",
    "homicides in Alabama in summer 2025",
    "homicides in Alabama in the first 100 days of 2025",
    "homicides in Alabama in fiscal year 2025",
    "homicides in Alabama in mid-2025",
    "homicides in Alabama in late 2025",
    "homicides in Alabama before 2025",
    "homicides in Alabama after 2020",
    "homicides in Alabama from 2020",
    "homicides in Alabama in 2025 through the end of June",
    "homicides in Alabama in the first two weeks of 2025",
    "homicides in Alabama from 2020 to 2024 during the summers",
    "homicides in Alabama in the first quarter of each year from 2020 to 2024",
    // Numeric dates (Codex period review): every digit must belong to a supported form.
    "number of homicides in baldwin county al in 2025 on 2025-03-01",   // Codex probe
    "number of homicides in baldwin county al in 2025 on 03/01/2025",   // Codex probe
    "number of homicides in baldwin county al on 2025-03-01",
    "number of homicides in baldwin county al on 3/1/2025",
    "homicides in Alabama in 2025 through June 30",
    "homicides in Alabama in 2025 through 6/30",
    "homicides in Alabama on 2025.03.01",
    "homicides in Alabama from 2025-01-01 to 2025-06-30",
  ];
  for (const q of partial) {
    const d = decide(q);
    // "through the end of June" is already stopped by the existing single-month question, and two dated
    // endpoints by the existing ambiguous-years question; any of these owned exits is honest.
    check(d.kind === "limitation" && ((d.reason === "owned-count-period-unsupported" && d.status === "clarify" && /Which of those do you want\?/.test(d.explanation)) || d.reason === "owned-count-period-month" || d.reason === "owned-count-period-ambiguous"),
      `a partial or unrepresented period is asked about, never answered as the whole year: "${q}" (got ${d.kind === "limitation" ? d.reason : d.kind === "plan" ? `plan ${JSON.stringify(d.plan.period)}` : d.kind})`);
  }
  const supported: [string, string][] = [
    ["number of homicides in baldwin county al in 2025", '{"kind":"year","year":2025,"throughMonth":12}'],
    ["number of homicides in baldwin county al in 2025 through June", '{"kind":"year","year":2025,"throughMonth":6}'],
    ["homicides in Alabama during 2025", '{"kind":"year","year":2025,"throughMonth":12}'],
    ["homicides in Alabama for calendar year 2025", '{"kind":"year","year":2025,"throughMonth":12}'],
    ["homicides in Alabama in the year 2025", '{"kind":"year","year":2025,"throughMonth":12}'],
    ["homicides in Alabama as of June 2025", '{"kind":"year","year":2025,"throughMonth":6}'],
    ["monthly homicides in baldwin county al in 2025", '{"kind":"year","year":2025,"throughMonth":12}'],
    ["homicides in Alabama from 2022 to 2024", '{"kind":"range","startYear":2022,"endYear":2024}'],
    ["homicides in Alabama between 2022 and 2024 by year", '{"kind":"range","startYear":2022,"endYear":2024}'],
    ["homicides in Alabama 2022-2024 each year", '{"kind":"range","startYear":2022,"endYear":2024}'],
    ["homicides in Alabama in the years 2022 through 2024", '{"kind":"range","startYear":2022,"endYear":2024}'],
    ["How many homicides were there in Alabama in 2025?", '{"kind":"year","year":2025,"throughMonth":12}'],
    ["homicides in Alabama, 2022 to 2024.", '{"kind":"range","startYear":2022,"endYear":2024}'],
  ];
  for (const [q, period] of supported) {
    const d = decide(q);
    check(d.kind === "plan" && JSON.stringify(d.plan.period) === period, `a supported period is still answered: "${q}" (got ${d.kind === "plan" ? JSON.stringify(d.plan.period) : d.kind === "limitation" ? d.reason : d.kind})`);
  }
  const unresolved = planShrOwnedCount("number of homicides in nowhere county al in 2025", db);
  check(unresolved.kind === "county-exit", "an unresolvable county keeps the credited owned county exit");
  check(decide("homicides in White Plains, NY in 2025").kind !== "limitation" || (decide("homicides in White Plains, NY in 2025") as { reason: string }).reason !== "owned-count-breakdown",
    "a place name is not read as a qualifier (\"White Plains\" is not a race filter)");
}

console.log("\n2 - the compiler");
const sheriff = decide("number of homicides in baldwin county al in 2025");
const countywide = decide("number of homicides across all agencies in baldwin county al in 2025");
if (sheriff.kind !== "plan" || countywide.kind !== "plan") throw new Error("fixture plans did not resolve");
{
  const h = compileShrCountPlan(sheriff.plan);
  const m = compileShrCountPlan({ ...sheriff.plan, measure: "murder" });
  check(!/homicide_type/.test(h.sql) && /i\.homicide_type = 'Murder'/.test(m.sql), "the Murder restriction appears exactly when measure = murder");
  check(/WHERE \(i\.ori = 'AL00500'\) AND i\.year = 2025/.test(h.sql) && !/agency_county_crosswalk/.test(h.sql), "county scope is the binding's ORIs as predicates, clipped to the year; no crosswalk join");
  const clip = compileShrCountPlan(plan({ geography: { kind: "cities", places: [{ display: "Clip City, AL", ranges: [
    { ori: "AL00001", startYear: 2020, endYear: 2023 }, { ori: "AL00002", startYear: 1990, endYear: 2010 }, { ori: "AL00003", startYear: 2024, endYear: 2025 }] }] },
    period: { kind: "range", startYear: 2022, endYear: 2024 } }));
  check(/\(i\.ori = 'AL00001' AND i\.year BETWEEN 2022 AND 2023\) OR \(i\.ori = 'AL00003' AND i\.year BETWEEN 2024 AND 2024\)/.test(clip.sql) && !/AL00002/.test(clip.sql),
    "partly active ORIs keep only their years inside the period; an ORI inactive in the period is dropped");
  const none = compileShrCountPlan(plan({ geography: { kind: "cities", places: [{ display: "Old City, AL", ranges: [{ ori: "AL00002", startYear: 1990, endYear: 2010 }] }] }, period: { kind: "year", year: 2025, throughMonth: 12 } }));
  check(/WHERE \(1 = 0\)/.test(none.sql), "no ORI active in the period compiles to no records (unknown), never a widened scope");
  check(/COUNT\(v\.id\) AS victims FROM incidents i JOIN victims v ON v\.incident_id = i\.id/.test(h.sql) && (h.sql.match(/FROM incidents/g) ?? []).length === 1,
    "one counted expression: victims joined to their incidents, one incidents instance");
  const s = compileShrCountPlan(plan({ geography: { kind: "state", state: "AL", stateName: "Alabama" }, period: { kind: "year", year: 2025, throughMonth: 12 } }));
  check(/i\.state = 'AL'/.test(s.sql) && !/i\.ori/.test(s.sql), "a state uses incident geography, not an agency list");
  const n = compileShrCountPlan(plan({ geography: { kind: "national" }, period: { kind: "year", year: 2025, throughMonth: 12 } }));
  check(/WHERE \(1 = 1\)/.test(n.sql) && !/i\.state|i\.ori/.test(n.sql), "the nation has no geography predicate");
  check(compileShrCountPlan(sheriff.plan).sql === h.sql, "compilation is deterministic for the same plan");
  check(h.title === "Homicide Victims (All Homicides), Baldwin County Sheriff's Office, AL, 2025" && !/Murder/.test(h.title), "an all-homicide title never says Murder");
  check(/the county sheriff's agency/.test(h.explanation) && /negligent manslaughter/.test(h.explanation) && /victim records rather than incidents/.test(h.explanation),
    "the sheriff, all-homicide and victim-unit sentences are compiled from the plan");
  check(!/Return A|understate actual murders/.test(h.explanation), "no murder-specific Return A wording on the new path");
  check(/not an estimate of every homicide in Alabama/.test(s.explanation), "state totals are recorded subtotals with participation limits");
}

console.log("\n3 - executed counts");
{
  const run = (p: ShrCountPlan) => { const c = compileShrCountPlan(p); return { c, rows: executeCompiledShrCount(db, c) }; };
  const y2025 = { kind: "year" as const, year: 2025, throughMonth: 12 };
  const g = run(sheriff.plan);
  check(value(g.rows, "homicide_victims")[0] === 4, "GC-080 sheriff all-homicide victims 2025 = 4 (two-victim incident counted per victim; manslaughter included)");
  check(value(run({ ...sheriff.plan, measure: "murder" }).rows, "murder_victims")[0] === 3, "sheriff murder victims 2025 = 3");
  check(value(run(countywide.plan).rows, "homicide_victims")[0] === 7, "countywide = sheriff 4 + Bay Minette 3 = 7");
  check(value(run(plan({ geography: { kind: "state", state: "AL", stateName: "Alabama" }, period: y2025 })).rows, "homicide_victims")[0] === 7, "Alabama 2025 = 7 (Texas excluded)");
  check(value(run(plan({ geography: { kind: "national" }, period: y2025 })).rows, "homicide_victims")[0] === 12, "national 2025 = 12 (both states)");
  const range = run(plan({ geography: { kind: "state", state: "AL", stateName: "Alabama" }, period: { kind: "range", startYear: 2022, endYear: 2024 } }));
  check(value(range.rows, "homicide_victims")[0] === 3 && range.rows[0].years_without_records === "2023", "AL 2022-2024 total = 3; 2023 listed as without records");
  const annual = run(plan({ geography: { kind: "state", state: "AL", stateName: "Alabama" }, period: { kind: "range", startYear: 2022, endYear: 2024 }, series: "annual" }));
  check(JSON.stringify(value(annual.rows, "homicide_victims")) === "[1,null,2]" && annual.rows[1].shr_records === "no SHR records (unknown)",
    "annual series keeps the missing middle year UNKNOWN (null), never zero");
  check(/No SHR victim records for Alabama in 2023; that period is unknown, not zero\./.test(shrCountNarrative(annual.c, annual.rows)), "the narrative names the unknown year");
  const monthly = run({ ...sheriff.plan, series: "monthly" });
  check(monthly.rows.length === 12 && monthly.rows.filter((r) => r.homicide_victims != null).length === 3 && monthly.rows[0].homicide_victims === null,
    "monthly: 12 months, 3 recorded, months without records unknown");
  const empty = run(plan({ geography: { kind: "state", state: "AL", stateName: "Alabama" }, period: { kind: "year", year: 2023, throughMonth: 12 } }));
  check(value(empty.rows, "homicide_victims")[0] === null && /unknown, not zero/.test(shrCountNarrative(empty.c, empty.rows)), "a year with no records is unknown, not zero");
  // Overlapping ORI ranges (the same ORI twice) cannot multiply victims: ranges are OR predicates, not a join.
  const overlap = run(plan({ geography: { kind: "cities", places: [{ display: "Test City, AL", ranges: [{ ori: "AL00500", startYear: 1990, endYear: 2025 }, { ori: "AL00500", startYear: 2020, endYear: 2025 }] }] }, period: y2025 }));
  check(value(overlap.rows, "homicide_victims")[0] === 4, "an overlapping ORI range does not multiply victims (still 4)");
  const two = run(plan({ geography: { kind: "cities", places: [
    { display: "Sheriff Place, AL", ranges: [{ ori: "AL00500", startYear: 1990, endYear: 2025 }] },
    { display: "Minette Place, AL", ranges: [{ ori: "AL0020100", startYear: 1990, endYear: 2025 }] }] }, period: y2025 }));
  check(JSON.stringify(value(two.rows, "homicide_victims")) === "[4,3]", "two places side by side: 4 and 3, each victim once");
  const cut = run(plan({ geography: { kind: "county", binding: { ...countywide.plan.geography.kind === "county" ? countywide.plan.geography.binding : sheriff.plan.geography.kind === "county" ? sheriff.plan.geography.binding : (null as never), ranges: [{ ori: "AL00500", startYear: 1990, endYear: 2025 }] } }, period: y2025 }));
  check(value(cut.rows, "homicide_victims")[0] === 4, "an omitted member agency changes the count (7 -> 4), so the fixture detects narrowed scope");
}

console.log("\n4 - execution authority: only the compiler's own, unaltered output");
{
  const c = compileShrCountPlan(sheriff.plan);
  check(compiledShrCountIssue(c) === null, "an issued compilation is accepted");
  const scaled = { ...c, sql: c.sql.replace("COUNT(v.id) AS victims", "COUNT(v.id) * 2 AS victims") } as CompiledShrCount;
  check(/not issued/.test(compiledShrCountIssue(scaled) ?? ""), "an altered copy (COUNT * 2) is not issued");
  let threw = false;
  try { executeCompiledShrCount(db, scaled); } catch { threw = true; }
  check(threw, "execution refuses the altered copy");
  let assigned = false;
  try { (c as { sql: string }).sql = "SELECT 8 AS homicide_victims"; assigned = c.sql === "SELECT 8 AS homicide_victims"; } catch { assigned = false; }
  check(!assigned && compiledShrCountIssue(c) === null, "the compiled object cannot be changed in place (frozen)");
  let planChanged = false;
  try { (c.plan as { measure: string }).measure = "murder"; planChanged = c.plan.measure === "murder"; } catch { planChanged = false; }
  check(!planChanged, "the compiled plan cannot be changed in place (frozen)");
  const loose = { plan: sheriff.plan, sql: c.sql } as unknown as CompiledShrCount;
  check(/not issued/.test(compiledShrCountIssue(loose) ?? ""), "loose SQL with a plan beside it is not compiler output");
  const v = validateCompiledShrCount({ question: "number of homicides in baldwin county al in 2025", compiled: scaled });
  check(v.blockReasons.length > 0 && v.enforced.includes(SHR_OWNED_COUNT_GUARDRAIL), "the validator refuses the altered copy");
  const ok = validateCompiledShrCount({ question: "number of homicides in baldwin county al in 2025", compiled: c });
  check(ok.blockReasons.length === 0 && ok.sql === c.sql && ok.compiled === c, "the validator accepts the issued compilation and carries it unchanged");
  const legacyRule = "structural-row-count-unqualified";
  const murderCompiled = compileShrCountPlan({ ...sheriff.plan, measure: "murder" });
  const mv = validateCompiledShrCount({ question: "number of murders in baldwin county al in 2025", compiled: murderCompiled });
  check(!ok.enforced.includes(legacyRule) && !mv.enforced.includes(legacyRule) && mv.blockReasons.length === 0, "the legacy murder-only rule does not refuse either compiled measure");
}

// ---- Measure preservation (Codex :34106): the victim sex RATIO is a measure of this plan, not a population rate ----
{
  const rdb = new Database(":memory:");
  rdb.exec(`
    CREATE TABLE incidents (id INTEGER PRIMARY KEY, year INTEGER, month INTEGER, state TEXT, ori TEXT, agency TEXT, homicide_type TEXT, weapon_group TEXT, agency_type TEXT);
    CREATE TABLE victims (id INTEGER PRIMARY KEY, incident_id INTEGER, sex TEXT);
  `);
  let rid = 0; let vid = 0;
  // year -> [male, female, unknown, negligent-manslaughter male] for a synthetic county sheriff (AL00500)
  const series: Record<number, [number, number, number, number]> = { 2020: [6, 2, 1, 1], 2021: [4, 0, 0, 0], 2023: [0, 3, 0, 0], 2024: [5, 5, 2, 0] }; // 2022 absent
  for (const [y, [m, f, u, nm]] of Object.entries(series)) {
    const addV = (sex: string | null, type: string) => { rid += 1; rdb.prepare("INSERT INTO incidents VALUES (?,?,?,?,?,?,?,?,?)").run(rid, Number(y), 6, "AL", "AL00500", "Baldwin", type, "Other", "County"); vid += 1; rdb.prepare("INSERT INTO victims VALUES (?,?,?)").run(vid, rid, sex); };
    for (let n = 0; n < m; n++) addV("Male", "Murder");
    for (let n = 0; n < f; n++) addV("Female", "Murder");
    for (let n = 0; n < u; n++) addV(n % 2 ? null : "Unknown", "Murder");
    for (let n = 0; n < nm; n++) addV("Male", "Manslaughter by Negligence");
  }
  const binding = sheriffBindingForRatio();
  const ratioPlan: ShrCountPlan = { geography: { kind: "county", binding }, period: { kind: "range", startYear: 2020, endYear: 2024 }, series: "annual", measure: "homicide", unit: "victims", ratio: "male_to_female" };
  const rc = compileShrCountPlan(ratioPlan);
  const rows = executeCompiledShrCount(rdb, rc);
  // Independent expectation, from the inserted rows above.
  const expect = (y: number) => {
    const s = series[y]; if (!s) return { male: null, female: null, unknown: null, ratio: null, state: "no SHR records (unknown)" };
    const male = s[0] + s[3]; const female = s[1];
    return { male, female, unknown: s[2], ratio: female === 0 ? null : Math.round((male / female) * 100) / 100, state: female === 0 ? "no female victims recorded (ratio undefined)" : "recorded" };
  };
  const got = (y: number) => rows.find((r) => r.year === y)!;
  check(rows.length === 5 && [2020, 2021, 2022, 2023, 2024].every((y) => {
    const e = expect(y); const g = got(y);
    return g.male_victims === e.male && g.female_victims === e.female && g.unknown_sex_victims === e.unknown && g.male_to_female_ratio === e.ratio && g.shr_records === e.state;
  }), "ratio: every year equals the independently computed male/female counts, unknown-sex count and ratio (all homicides)");
  check(got(2023).male_to_female_ratio === 0, "ratio: a zero numerator gives a ratio of 0, not blank");
  check(got(2021).male_to_female_ratio === null && /undefined/.test(String(got(2021).shr_records)), "ratio: a zero denominator gives no ratio, marked undefined (not zero)");
  check(got(2022).male_victims === null && /unknown/.test(String(got(2022).shr_records)), "ratio: a year with no records is unknown, not zero");
  const murderRows = executeCompiledShrCount(rdb, compileShrCountPlan({ ...ratioPlan, measure: "murder" }));
  check(murderRows.find((r) => r.year === 2020)!.male_victims === 6, "ratio: the murder measure excludes negligent manslaughter");
  const narrative = shrCountNarrative(rc, rows);
  check(/needs no population figure/.test(narrative) && !/population denominator/.test(narrative) && /2022; unknown, not zero/.test(narrative) && /undefined there, not zero/.test(narrative), "ratio narrative: no population claim; unknown and undefined years stated separately");
  const inverse = executeCompiledShrCount(rdb, compileShrCountPlan({ ...ratioPlan, ratio: "female_to_male" }));
  check(inverse.find((r) => r.year === 2024)!.female_to_male_ratio === Math.round((5 / 5) * 100) / 100 && inverse.find((r) => r.year === 2023)!.female_to_male_ratio === null, "ratio: female-to-male swaps numerator and denominator");
  const total = executeCompiledShrCount(rdb, compileShrCountPlan({ ...ratioPlan, series: "total" }));
  check(total.length === 1 && total[0].male_to_female_ratio === Math.round(((7 + 4 + 0 + 5) / (2 + 0 + 3 + 5)) * 100) / 100 && total[0].years_without_records === "2022", "ratio total: summed counts over the period, missing year listed");
  const v = validateCompiledShrCount({ question: "ratio of male to female homicide victims in baldwin county al from 2020 to 2024 by year", compiled: rc });
  // The route refuses on a retry issue too (queryContractFailureMessage), so BOTH must be empty.
  check(v.blockReasons.length === 0 && v.retryIssues.length === 0, `the compiled ratio passes the shared validator with no block or retry (${[...v.blockReasons, ...v.retryIssues].join(" | ")})`);
  // The ratio allowance is the compiler's only: the SAME statement as loose SQL keeps the structural retry.
  const asModel = validateQueryContractSql({ question: "ratio of male to female homicide victims in baldwin county al from 2020 to 2024 by year", source: "shr", sql: rc.sql });
  check(asModel.retryIssues.some((i) => i.includes("structural-measure-unit-unmodeled")), "the same statement written by the model keeps the structural ratio retry (allowance is compiler-only)");
  const tampered = Object.freeze({ ...rc, sql: rc.sql.replace("ROUND(1.0 * c.male / c.female, 2)", "ROUND(1.0 * c.male / c.victims, 2)") }) as CompiledShrCount;
  const tv = validateCompiledShrCount({ question: "ratio of male to female homicide victims in baldwin county al from 2020 to 2024 by year", compiled: tampered });
  check(tv.blockReasons.length > 0 && tv.enforced.includes(SHR_OWNED_COUNT_GUARDRAIL), "an altered ratio statement is refused, and gets no allowance");
  const plain = compileShrCountPlan({ ...ratioPlan, ratio: undefined });
  check(!/v\.sex/.test(plain.sql) && plain.columns.includes("homicide_victims"), "a plan without a ratio compiles the plain count exactly as before");
}

// The planner: recognition, period, and the truthful limitation for each non-count measure.
{
  check(shrOwnedCountFamily("ratio of male to female homicide victims in philadelphia by year since 2010"), "family: a homicide sex ratio is owned");
  check(shrOwnedCountFamily("male-to-female murder victim ratio in baldwin county al in 2024"), "family: a murder sex ratio is owned too");
  check(!shrOwnedCountFamily("how many murders in Birmingham, Alabama in 2024"), "family: a plain city murder count is unchanged (not owned)");
  const rate = planShrOwnedCount("homicide rate per 100,000 in baldwin county al in 2024", db);
  check(rate.kind === "limitation" && rate.reason === "owned-count-rate" && /population denominator/.test(rate.explanation), "a genuine population rate keeps its missing-denominator limitation");
  const share = planShrOwnedCount("share of homicide victims in baldwin county al who were female in 2024", db);
  check(share.kind === "limitation" && share.reason === "owned-count-share" && !/population/.test(share.explanation), "a share is limited truthfully, never as a missing population denominator");
  const ratio = planShrOwnedCount("ratio of male to female homicide victims in baldwin county al from 2022 to 2025 by year", db);
  check(ratio.kind === "plan" && ratio.plan.ratio === "male_to_female" && ratio.plan.series === "annual" && ratio.plan.period.kind === "range", "a sex ratio plans as the ratio measure, annual, for the stated range");
  const since = planShrOwnedCount("ratio of male to female homicide victims in baldwin county al by year since 2022", db);
  const maxYear = (db.prepare("SELECT MAX(year) AS y FROM incidents").get() as { y: number }).y;
  check(since.kind === "plan" && since.plan.period.kind === "range" && since.plan.period.startYear === 2022 && since.plan.period.endYear === maxYear, `"since 2022" runs to the source's latest year (${maxYear}), read from the database`);
  const monthly = planShrOwnedCount("ratio of male to female homicide victims in baldwin county al in 2024 by month", db);
  check(monthly.kind === "limitation" && monthly.reason === "owned-count-ratio-series", "a monthly ratio is a stated limitation");
  const sinceCount = planShrOwnedCount("homicide victims in baldwin county al since 2022", db);
  check(sinceCount.kind === "limitation" && sinceCount.reason === "owned-count-period-relative", "a plain count keeps its accepted 'since' clarification (unchanged)");
}

function sheriffBindingForRatio() {
  const p = planShrOwnedCount("number of homicides in baldwin county al in 2025", db);
  if (p.kind !== "plan" || p.plan.geography.kind !== "county") throw new Error("fixture: Baldwin sheriff binding did not resolve");
  return p.plan.geography.binding;
}

console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
