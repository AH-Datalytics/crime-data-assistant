/**
 * DELIVERED-ANSWER proof for the Ward and ratio repairs.
 *
 * WHY THIS FILE EXISTS. Review `2026-09-08-correction-batch-review-ratio-and-delivery-gaps.md` R2
 * found the batch's two tests proved "not refused" and "the database computed a number", and called
 * neither a delivered answer. It is right: the earlier tests stopped at the decision helpers and at
 * a raw SQLite row, and never reached the code that renders what the reader sees.
 *
 * WHAT THIS DOES INSTEAD. For each scoped positive it walks the real chain:
 *
 *   1. DECISION      - the production sub-city predicate and capability rules must not refuse.
 *   2. VALIDATION    - `validateQueryContractSql`, the entry point the routes call.
 *   3. EXECUTION     - the SQL runs against a small fixture whose rows are written here, so the
 *                      expected figure is computed independently in this file.
 *   4. DELIVERY      - `genericResultState` then `applyResultDisclosures`, the production
 *                      result-state classifier and disclosure chokepoint the routes call, and the
 *                      returned TEXT is what gets asserted.
 *
 * WHAT IS STUBBED, AND WHAT IS NOT. Model generation is replaced: the SQL and the draft explanation
 * are supplied here, and that is labelled injected. Nothing in the behaviour being proved is
 * stubbed - the predicate, the validator, the result-state classifier and the disclosure
 * chokepoint are the production functions.
 *
 * STATED LIMITATION, not worked around. This drives the route's terminal delivery builders, which
 * is the seam `test-correctness-route-integration.ts` already established for exactly this reason.
 * It does not boot the Next.js HTTP handler, so it does not prove the handler wires these builders
 * in the order used here. Route PLACEMENT is covered separately by that suite's placement scan.
 *
 * No network, no model call, no production database.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { detectSubCityGeographyOverride } from "../lib/capability-overrides";
import { detectNibrsCapabilityOverride } from "../lib/nibrs-capability-overrides";
import { validateQueryContractSql, queryContractFailureMessage } from "../lib/query-contract-validator";
import { genericResultState, currentTrendsResultState } from "../lib/result-state-adapters";
import { alignTitleYearRange, applyResultDisclosures } from "../lib/result-disclosure";
import { spawn } from "child_process";
import { deterministicPlanRefusal } from "../lib/deterministic-plan-guard";
import { validateGrain } from "../lib/requested-grain";
import {
  executeWithTimeoutSync,
  executeManyWithTimeoutSync,
  BOUNDED_EXECUTION_UNAVAILABLE,
} from "../lib/query-timeout";
import {
  buildCurrentYoyComparisonPlan,
  buildCurrentYoyComparisonAnswer,
  buildCurrentYoyGroup,
  answerCoversRequiredCells,
  type CurrentYoyAnswerRow,
  type CurrentYoyPeriodRow,
  type CurrentYoyMembershipRow,
  type CurrentYoySampleRow,
} from "../lib/current-yoy-comparison-deterministic";
import { gateIdentities, REQUIRED_IDENTITIES } from "../audit/current-yoy-group-verification-2-2026-09-10/identity-gate";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${message}`); }
}

const UNCERTAIN = "I can't determine safely whether this is a genuine zero";
const SUBCITY_REFUSAL = "does not report crime data below the city/county/agency level";

const dbPath = path.join(os.tmpdir(), `delivered-answer-${process.pid}.db`);
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
const db = new Database(dbPath);

/* ================================================================== */
/*  A - WARD: a real colliding place name must be answered            */
/* ================================================================== */
console.log("A - Ward delivered answer");

// Fixture. Ward AR 2022 is the requested cell; the other rows are entity/period controls, so a
// query that ignored the filters would produce a different total and fail the assertion below.
db.exec(`CREATE TABLE agency_monthly (
  agency TEXT, state TEXT, type TEXT, offense TEXT, year INTEGER, month INTEGER, count INTEGER
);`);
const WARD_ROWS: Array<[string, string, string, string, number, number, number]> = [
  ["Ward", "AR", "City", "Murder", 2022, 1, 2],
  ["Ward", "AR", "City", "Murder", 2022, 7, 1],
  ["Ward", "AR", "City", "Murder", 2021, 3, 9],   // period control
  ["Warden", "AR", "City", "Murder", 2022, 4, 9], // entity control
  ["Ward", "AR", "City", "Robbery", 2022, 5, 9],  // offense control
];
const insWard = db.prepare("INSERT INTO agency_monthly VALUES (?, ?, ?, ?, ?, ?, ?)");
for (const r of WARD_ROWS) insWard.run(...r);

const WARD_Q = "How many murders were reported in Ward, AR in 2022?";
const expectedWardTotal = WARD_ROWS
  .filter(([a, s, , o, y]) => a === "Ward" && s === "AR" && o === "Murder" && y === 2022)
  .reduce((acc, r) => acc + r[6], 0);
console.log(`  expected total computed here: ${expectedWardTotal}`);

// 1. DECISION - the production predicate must not refuse a real city.
check(detectSubCityGeographyOverride(WARD_Q) === null,
  "Ward: front-door predicate must not refuse");
check(detectNibrsCapabilityOverride(WARD_Q) === null ||
      detectNibrsCapabilityOverride(WARD_Q)!.guardrail !== "sub-city-geography-unsupported",
  "Ward: NIBRS wrapper must not refuse as sub-city");

// 2. VALIDATION - the same entry point the route calls. Previously skipped here, which the review
//    correctly flagged as a gap between the described chain and the tested one.
const wardSql =
  "SELECT SUM(count) AS total_murders FROM agency_monthly " +
  "WHERE agency = 'Ward' AND state = 'AR' AND offense = 'Murder' AND year = 2022";
const wardVerdict = validateQueryContractSql({
  question: WARD_Q, source: "current", sql: wardSql,
});
// Tightened per review §4: a positive must have neither block reasons NOR retry issues. Checking
// only block reasons would let a retry-level refusal count as acceptance.
check(wardVerdict.blockReasons.length === 0 && wardVerdict.retryIssues.length === 0,
  `Ward: full validator must neither block nor retry (got: ${
    [...wardVerdict.enforced, ...wardVerdict.retryIssues, ...wardVerdict.blockReasons].join("; ") || "clean"})`);

// 3. EXECUTION - injected SQL, shaped like the baseline's, against the fixture.
const wardRows = db.prepare(wardSql).all() as Record<string, unknown>[];
check(Number(wardRows[0]?.total_murders) === expectedWardTotal,
  `Ward: executed figure must be ${expectedWardTotal} (got ${wardRows[0]?.total_murders})`);

// 4. DELIVERY - the ROUTE-APPROPRIATE classifier. `app/api/query/route.ts` uses
//    `currentTrendsResultState(getDb(), ...)` for the Current Trends branch, not the generic
//    adapter; the fixture database stands in for `getDb()`. For these nonempty rows both adapters
//    classify the same base evidence, so this closes a proof-alignment gap rather than fixing a
//    demonstrated wrong answer.
const wardDecision = currentTrendsResultState(db, { sql: wardSql, rows: wardRows, queryCompleted: true });

// The draft carries the ACTUALLY EXECUTED value, not the independently expected one, so the
// tested sequence is connected end to end. The expected value stays an assertion below.
const wardActual = Number(wardRows[0]?.total_murders);
const wardDraft = `Ward, AR police reported ${wardActual} murders in 2022.`;
const wardDelivered = applyResultDisclosures({
  explanation: wardDraft, question: WARD_Q, sql: wardSql, rows: wardRows,
  tab: "current", resultState: wardDecision,
});

console.log(`  delivered: ${JSON.stringify(wardDelivered.slice(0, 160))}`);
check(wardDelivered.includes(String(expectedWardTotal)),
  `Ward: delivered text must carry the figure ${expectedWardTotal}`);
check(/Ward/.test(wardDelivered), "Ward: delivered text must name the entity");
check(/2022/.test(wardDelivered), "Ward: delivered text must name the period");
check(!wardDelivered.includes(SUBCITY_REFUSAL),
  "Ward: delivered text must not be the sub-city refusal");
check(!wardDelivered.includes(UNCERTAIN),
  "Ward: delivered text must not be replaced by the zero/gap uncertainty message");

/* ================================================================== */
/*  B - RATIO: a completed share must be delivered as a share         */
/* ================================================================== */
console.log("");
console.log("B - ratio delivered answer");

db.exec(`CREATE TABLE summary_offender_demographics (
  state TEXT, year INTEGER, ucr_offense_code TEXT, age_group TEXT, offender_count INTEGER
);`);
const RATIO_ROWS: Array<[string, number, string, string, number]> = [
  ["CA", 2021, "120", "Under 18", 30],
  ["CA", 2021, "120", "18 and over", 70],
  ["CA", 2022, "120", "Under 18", 10],
  ["CA", 2022, "120", "18 and over", 90],
  ["TX", 2021, "120", "Under 18", 99],  // entity control
  ["CA", 2019, "120", "Under 18", 99],  // period control
];
const insRatio = db.prepare("INSERT INTO summary_offender_demographics VALUES (?, ?, ?, ?, ?)");
for (const r of RATIO_ROWS) insRatio.run(...r);

const RATIO_Q = "what share of serious violent crimes in California are committed by youth under 18?";
const inScope = RATIO_ROWS.filter(([s, y]) => s === "CA" && y >= 2021 && y <= 2025);
const under18 = inScope.filter(([, , , a]) => a === "Under 18").reduce((n, r) => n + r[4], 0);
const totalOff = inScope.reduce((n, r) => n + r[4], 0);
const expectedPct = Math.round((1000 * under18) / totalOff) / 10;
console.log(`  expected share computed here: ${expectedPct}% (${under18}/${totalOff})`);

const ratioSql =
  "SELECT ROUND(100.0 * SUM(CASE WHEN d.age_group = 'Under 18' THEN d.offender_count ELSE 0 END) " +
  "/ SUM(d.offender_count), 1) AS pct_under_18 " +
  "FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.year BETWEEN 2021 AND 2025 " +
  "AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A')";

// 1. VALIDATION - the entry point the routes call must not refuse the completed share.
const ratioVerdict = validateQueryContractSql({
  question: RATIO_Q, source: "nibrs", sql: ratioSql,
});
check(ratioVerdict.retryIssues.length === 0 && ratioVerdict.blockReasons.length === 0,
  `ratio: full validator must accept the completed share (got: ${
    [...ratioVerdict.enforced, ...ratioVerdict.retryIssues, ...ratioVerdict.blockReasons].join("; ") || "clean"})`);

// 2. EXECUTION
const ratioRows = db.prepare(ratioSql).all() as Record<string, unknown>[];
check(Number(ratioRows[0]?.pct_under_18) === expectedPct,
  `ratio: executed share must be ${expectedPct} (got ${ratioRows[0]?.pct_under_18})`);

// 3. DELIVERY
const ratioDecision = genericResultState({ sql: ratioSql, rows: ratioRows, queryCompleted: true });
const ratioDraft =
  `Youth under 18 accounted for ${expectedPct}% of serious violent crime offenders in California, 2021-2025.`;
const ratioDelivered = applyResultDisclosures({
  explanation: ratioDraft, question: RATIO_Q, sql: ratioSql, rows: ratioRows,
  tab: "nibrs", resultState: ratioDecision,
});

console.log(`  delivered: ${JSON.stringify(ratioDelivered.slice(0, 200))}`);
check(ratioDelivered.includes(String(expectedPct)),
  `ratio: delivered text must carry the share ${expectedPct}`);
check(ratioDelivered.includes("%"), "ratio: delivered text must carry the ratio unit");
check(/California/i.test(ratioDelivered), "ratio: delivered text must name the entity");
check(/2021/.test(ratioDelivered), "ratio: delivered text must name the period");
check(!ratioDelivered.includes(UNCERTAIN),
  "ratio: delivered text must not be replaced by the zero/gap uncertainty message");

/* ================================================================== */
/*  B2 - the other three scoped ratio positives, their OWN questions   */
/* ================================================================== */
/*
 * CORRECTION (review 2026-09-08 §4). The first version of this section was a FALSE POSITIVE: it ran
 * GC-033's Texas male-of-all percentage under GC-035's question, which asks for a Philadelphia
 * male-to-FEMALE ratio by year, and accepted 66.7% as the answer. With four males and two females
 * the requested ratio is 2 to 1; 66.7% is male/all. It also dropped GC-034's requested sex/year
 * grouping and used a narrative that never named which measure the number was.
 *
 * Rewritten so each positive runs ITS OWN question against the agreed SQL shape, with fixtures
 * built for that question, expectations written from the question and the fixture facts, and a
 * narrative that names the measure. The SQL shapes are the ones already agreed in
 * `test-ratio-support.ts`.
 */
console.log("");
console.log("B2 - remaining scoped ratio positives, on their own questions");

db.exec(`CREATE TABLE incidents (
  id INTEGER, state TEXT, year INTEGER, homicide_type TEXT, relationship TEXT, ori TEXT
);`);
db.exec(`CREATE TABLE victims (incident_id INTEGER, sex TEXT);`);

/*
 * One fixture serving all three questions, with controls that make a dropped filter or a dropped
 * grouping produce a DIFFERENT answer:
 *   - Philadelphia (PAPEP00) in 2010 and 2011, with different male/female splits per year, so a
 *     pooled answer cannot satisfy a per-year expectation;
 *   - a non-Philadelphia agency and a pre-2010 Philadelphia year as out-of-scope controls;
 *   - Texas 2023 rows for the male-share question, with a distinct split from Philadelphia's;
 *   - relationship values chosen so the unknown share differs by sex AND by year.
 */
type Inc = [number, string, number, string, string | null, string];
const INCIDENTS: Inc[] = [
  // Philadelphia 2010: 4 male, 2 female  -> male/female = 2
  [1, "PA", 2010, "Murder", "Acquaintance", "PAPEP00"],
  [2, "PA", 2010, "Murder", "Unknown", "PAPEP00"],
  [3, "PA", 2010, "Murder", "Stranger", "PAPEP00"],
  [4, "PA", 2010, "Murder", null, "PAPEP00"],
  [5, "PA", 2010, "Murder", "Spouse", "PAPEP00"],
  [6, "PA", 2010, "Murder", "Friend", "PAPEP00"],
  // Philadelphia 2011: 3 male, 3 female -> male/female = 1
  [7, "PA", 2011, "Murder", "Unknown", "PAPEP00"],
  [8, "PA", 2011, "Murder", "Unknown", "PAPEP00"],
  [9, "PA", 2011, "Murder", "Spouse", "PAPEP00"],
  [10, "PA", 2011, "Murder", "Friend", "PAPEP00"],
  [11, "PA", 2011, "Murder", "Stranger", "PAPEP00"],
  [12, "PA", 2011, "Murder", "Unknown", "PAPEP00"],
  // controls: wrong agency, and a Philadelphia year before 2010
  [13, "PA", 2010, "Murder", "Unknown", "PAOTHER0"],
  [14, "PA", 2009, "Murder", "Unknown", "PAPEP00"],
  // Texas 2023 for the male-share question: 3 male, 1 female -> 75%
  [15, "TX", 2023, "Murder", "Unknown", "TX00001"],
  [16, "TX", 2023, "Murder", "Spouse", "TX00001"],
  [17, "TX", 2023, "Murder", "Stranger", "TX00001"],
  [18, "TX", 2023, "Murder", "Friend", "TX00001"],
  // control: Texas 2023 non-murder
  [19, "TX", 2023, "Manslaughter", "Unknown", "TX00001"],
];
const SEXES: Array<[number, string]> = [
  [1, "Male"], [2, "Male"], [3, "Male"], [4, "Male"], [5, "Female"], [6, "Female"],
  [7, "Male"], [8, "Male"], [9, "Male"], [10, "Female"], [11, "Female"], [12, "Female"],
  [13, "Male"], [14, "Male"],
  [15, "Male"], [16, "Male"], [17, "Male"], [18, "Female"],
  [19, "Male"],
];
const insInc = db.prepare("INSERT INTO incidents VALUES (?, ?, ?, ?, ?, ?)");
for (const r of INCIDENTS) insInc.run(...r);
const insVic = db.prepare("INSERT INTO victims VALUES (?, ?)");
for (const r of SEXES) insVic.run(...r);

const sexOf = new Map(SEXES);
const isUnknown = (rel: string | null) => rel === "Unknown" || rel === null;

/* ---------------- GC-035: Philadelphia male-to-female ratio by year ---------------- */
console.log("");
console.log("  GC-035 - male-to-female ratio, Philadelphia, by year");

// Expectation written from the QUESTION and the fixture, not from the SQL.
const philaYears = [...new Set(
  INCIDENTS.filter(([, , , t, , ori]) => ori === "PAPEP00" && t === "Murder")
    .filter(([, , y]) => y >= 2010).map(([, , y]) => y)
)].sort();
const expectedRatioByYear = new Map<number, number>();
for (const y of philaYears) {
  const ids = INCIDENTS
    .filter(([, , yy, t, , ori]) => ori === "PAPEP00" && t === "Murder" && yy === y)
    .map(([id]) => id);
  const male = ids.filter((id) => sexOf.get(id) === "Male").length;
  const female = ids.filter((id) => sexOf.get(id) === "Female").length;
  expectedRatioByYear.set(y, Math.round((100 * male) / female) / 100);
}
console.log(`  expected male/female by year: ${
  [...expectedRatioByYear].map(([y, r]) => `${y}=${r}`).join(", ")} (from the fixture)`);
check(expectedRatioByYear.get(2010) === 2 && expectedRatioByYear.get(2011) === 1,
  "GC-035 fixture must give DIFFERENT ratios per year, so a pooled answer cannot satisfy it");

const GC035_Q = "ratio of male to female homicide victims in philadelphia by year since 2010";
const gc035Sql =
  "SELECT i.year, ROUND(1.0 * SUM(CASE WHEN v.sex = 'Male' THEN 1 ELSE 0 END) / " +
  "NULLIF(SUM(CASE WHEN v.sex = 'Female' THEN 1 ELSE 0 END), 0), 2) AS male_to_female_ratio " +
  "FROM incidents i JOIN victims v ON v.incident_id = i.id " +
  "WHERE i.ori = 'PAPEP00' AND i.year >= 2010 AND i.homicide_type = 'Murder' " +
  "GROUP BY i.year ORDER BY i.year";

const gc035Verdict = validateQueryContractSql({ question: GC035_Q, source: "shr", sql: gc035Sql });
check(gc035Verdict.retryIssues.length === 0 && gc035Verdict.blockReasons.length === 0,
  `GC-035: full validator must accept (got: ${
    [...gc035Verdict.enforced, ...gc035Verdict.retryIssues, ...gc035Verdict.blockReasons].join("; ") || "clean"})`);

const gc035Rows = db.prepare(gc035Sql).all() as Array<{ year: number; male_to_female_ratio: number }>;
check(gc035Rows.length === philaYears.length,
  `GC-035: must return one row per in-scope year (${philaYears.length}), got ${gc035Rows.length}`);
for (const row of gc035Rows) {
  check(row.male_to_female_ratio === expectedRatioByYear.get(row.year),
    `GC-035: ${row.year} ratio must be ${expectedRatioByYear.get(row.year)} (got ${row.male_to_female_ratio})`);
}
check(!gc035Rows.some((r) => r.year < 2010 || r.year === 2009),
  "GC-035: out-of-scope years must be excluded");

const gc035Decision = genericResultState({ sql: gc035Sql, rows: gc035Rows as unknown as Record<string, unknown>[], queryCompleted: true });
// Draft carries the EXECUTED values and names the measure explicitly.
const gc035Draft =
  "Male-to-female ratio of Philadelphia homicide victims by year: " +
  gc035Rows.map((r) => `${r.year}: ${r.male_to_female_ratio} male per female`).join("; ") + ".";
const gc035Delivered = applyResultDisclosures({
  explanation: gc035Draft, question: GC035_Q, sql: gc035Sql,
  rows: gc035Rows as unknown as Record<string, unknown>[], tab: "shr", resultState: gc035Decision,
});
console.log(`  delivered: ${JSON.stringify(gc035Delivered.slice(0, 170))}`);
for (const [y, r] of expectedRatioByYear) {
  check(gc035Delivered.includes(String(y)), `GC-035: delivered text must name the year ${y}`);
  check(gc035Delivered.includes(String(r)), `GC-035: delivered text must carry the ${y} ratio ${r}`);
}
check(/male.{0,20}female/i.test(gc035Delivered),
  "GC-035: delivered text must name the male-to-female comparison, not a share of total");
check(/philadelphia/i.test(gc035Delivered), "GC-035: delivered text must name the entity");
check(!gc035Delivered.includes("%"),
  "GC-035: a ratio must NOT be delivered as a percentage of total victims");
check(!gc035Delivered.includes(UNCERTAIN), "GC-035: delivered text must not be replaced");

/* ---------------- GC-034: unknown-relationship share by sex and year ---------------- */
console.log("");
console.log("  GC-034 - unknown-relationship share, by sex and year");

const GC034_Q = "Share of murder victims with an unknown relationship by sex and year";
type Group = { year: number; sex: string; unknown: number; known: number; total: number; pct: number };
const expectedGroups: Group[] = [];
for (const y of [...new Set(INCIDENTS.filter(([, , , t]) => t === "Murder").map(([, , yy]) => yy))].sort()) {
  for (const sex of ["Female", "Male"]) {
    const rows = INCIDENTS.filter(
      ([id, , yy, t]) => t === "Murder" && yy === y && sexOf.get(id) === sex
    );
    if (rows.length === 0) continue;
    const unknown = rows.filter(([, , , , rel]) => isUnknown(rel)).length;
    const total = rows.length;
    expectedGroups.push({
      year: y, sex, unknown, known: total - unknown, total,
      pct: Math.round((1000 * unknown) / total) / 10,
    });
  }
}
console.log(`  expected groups: ${
  expectedGroups.map((g) => `${g.year}/${g.sex}=${g.pct}%`).join(", ")} (from the fixture)`);
check(new Set(expectedGroups.map((g) => g.pct)).size > 1,
  "GC-034 fixture must give DIFFERENT shares across groups, so losing the grouping cannot satisfy it");

const gc034Sql =
  "SELECT i.year, v.sex, " +
  "SUM(CASE WHEN i.relationship = 'Unknown' OR i.relationship IS NULL THEN 1 ELSE 0 END) as unknown_relationship_victims, " +
  "SUM(CASE WHEN i.relationship != 'Unknown' AND i.relationship IS NOT NULL THEN 1 ELSE 0 END) as known_relationship_victims, " +
  "COUNT(*) as total_victims, " +
  "ROUND(100.0 * SUM(CASE WHEN i.relationship = 'Unknown' OR i.relationship IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) as pct_unknown " +
  "FROM incidents i JOIN victims v ON v.incident_id = i.id " +
  "WHERE i.homicide_type = 'Murder' AND v.sex IN ('Male', 'Female') " +
  "GROUP BY i.year, v.sex ORDER BY i.year, v.sex";

const gc034Verdict = validateQueryContractSql({ question: GC034_Q, source: "shr", sql: gc034Sql });
check(gc034Verdict.retryIssues.length === 0 && gc034Verdict.blockReasons.length === 0,
  `GC-034: full validator must accept (got: ${
    [...gc034Verdict.enforced, ...gc034Verdict.retryIssues, ...gc034Verdict.blockReasons].join("; ") || "clean"})`);

const gc034Rows = db.prepare(gc034Sql).all() as Array<Record<string, number | string>>;
check(gc034Rows.length === expectedGroups.length,
  `GC-034: must return one row per sex/year group (${expectedGroups.length}), got ${gc034Rows.length}`);
for (const g of expectedGroups) {
  const row = gc034Rows.find((r) => Number(r.year) === g.year && r.sex === g.sex);
  check(Boolean(row), `GC-034: group ${g.year}/${g.sex} must be returned`);
  if (!row) continue;
  check(Number(row.pct_unknown) === g.pct,
    `GC-034: ${g.year}/${g.sex} share must be ${g.pct} (got ${row.pct_unknown})`);
  check(Number(row.unknown_relationship_victims) === g.unknown,
    `GC-034: ${g.year}/${g.sex} unknown count must be ${g.unknown}`);
  check(Number(row.known_relationship_victims) === g.known,
    `GC-034: ${g.year}/${g.sex} known count must be ${g.known}`);
  check(Number(row.total_victims) === g.total,
    `GC-034: ${g.year}/${g.sex} total must be ${g.total}`);
}

const gc034Decision = genericResultState({ sql: gc034Sql, rows: gc034Rows as unknown as Record<string, unknown>[], queryCompleted: true });
const gc034Draft =
  "Share of murder victims whose relationship to the offender was unknown, by sex and year: " +
  gc034Rows.map((r) => `${r.year} ${r.sex}: ${r.pct_unknown}%`).join("; ") + ".";
const gc034Delivered = applyResultDisclosures({
  explanation: gc034Draft, question: GC034_Q, sql: gc034Sql,
  rows: gc034Rows as unknown as Record<string, unknown>[], tab: "shr", resultState: gc034Decision,
});
console.log(`  delivered: ${JSON.stringify(gc034Delivered.slice(0, 170))}`);
check(/unknown/i.test(gc034Delivered),
  "GC-034: delivered text must name the unknown-relationship measure");
for (const g of expectedGroups) {
  check(gc034Delivered.includes(String(g.pct)), `GC-034: delivered text must carry ${g.year}/${g.sex} = ${g.pct}`);
  check(gc034Delivered.includes(g.sex), `GC-034: delivered text must name the ${g.sex} group`);
}
check(!gc034Delivered.includes(UNCERTAIN), "GC-034: delivered text must not be replaced");

/* ---------------- GC-033 constructed: Texas male share ---------------- */
console.log("");
console.log("  GC-033 constructed - male share of Texas murder victims, 2023");

const GC033_Q = "What percentage of murder victims in Texas were male in 2023?";
const txIds = INCIDENTS
  .filter(([, s, y, t]) => s === "TX" && y === 2023 && t === "Murder").map(([id]) => id);
const txMale = txIds.filter((id) => sexOf.get(id) === "Male").length;
const txTotal = txIds.length;
const expectedTxMalePct = Math.round((1000 * txMale) / txTotal) / 10;
console.log(`  expected male share: ${expectedTxMalePct}% (${txMale}/${txTotal}) from the fixture`);

const gc033Sql =
  "SELECT ROUND(100.0 * SUM(CASE WHEN v.sex = 'Male' THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_male, " +
  "SUM(CASE WHEN v.sex = 'Male' THEN 1 ELSE 0 END) AS male_victims, COUNT(*) AS total_victims " +
  "FROM incidents i JOIN victims v ON v.incident_id = i.id " +
  "WHERE i.state = 'TX' AND i.year = 2023 AND i.homicide_type = 'Murder'";

const gc033Verdict = validateQueryContractSql({ question: GC033_Q, source: "shr", sql: gc033Sql });
check(gc033Verdict.retryIssues.length === 0 && gc033Verdict.blockReasons.length === 0,
  `GC-033: full validator must accept (got: ${
    [...gc033Verdict.enforced, ...gc033Verdict.retryIssues, ...gc033Verdict.blockReasons].join("; ") || "clean"})`);

const gc033Rows = db.prepare(gc033Sql).all() as Array<Record<string, number>>;
check(Number(gc033Rows[0]?.pct_male) === expectedTxMalePct,
  `GC-033: executed share must be ${expectedTxMalePct} (got ${gc033Rows[0]?.pct_male})`);
check(Number(gc033Rows[0]?.total_victims) === txTotal,
  `GC-033: the non-murder control row must be excluded (total ${txTotal})`);

const gc033Decision = genericResultState({ sql: gc033Sql, rows: gc033Rows as unknown as Record<string, unknown>[], queryCompleted: true });
const gc033Draft =
  `${gc033Rows[0].pct_male}% of Texas murder victims in 2023 were male ` +
  `(${gc033Rows[0].male_victims} of ${gc033Rows[0].total_victims}).`;
const gc033Delivered = applyResultDisclosures({
  explanation: gc033Draft, question: GC033_Q, sql: gc033Sql,
  rows: gc033Rows as unknown as Record<string, unknown>[], tab: "shr", resultState: gc033Decision,
});
console.log(`  delivered: ${JSON.stringify(gc033Delivered.slice(0, 170))}`);
check(gc033Delivered.includes(String(expectedTxMalePct)),
  `GC-033: delivered text must carry ${expectedTxMalePct}`);
check(/\bmale\b/i.test(gc033Delivered), "GC-033: delivered text must name the male measure");
check(gc033Delivered.includes("%"), "GC-033: delivered text must carry the ratio unit");
check(/texas/i.test(gc033Delivered), "GC-033: delivered text must name the entity");
check(gc033Delivered.includes("2023"), "GC-033: delivered text must name the period");
check(!gc033Delivered.includes(UNCERTAIN), "GC-033: delivered text must not be replaced");

/* ================================================================== */
/*  C - the unsafe cases must still be refused, through the same path  */
/* ================================================================== */
console.log("");
console.log("C - unsafe requests still refused on the same path");

// A genuine sub-city request must be refused at the decision stage, before any delivery.
const SUBCITY_Q = "How many murders were reported in the 5th ward of New Orleans, LA in 2022?";
const subcityOverride = detectSubCityGeographyOverride(SUBCITY_Q);
check(subcityOverride !== null, "sub-city: genuine request must be refused");
check(Boolean(subcityOverride && subcityOverride.explanation.includes(SUBCITY_REFUSAL)),
  "sub-city: refusal must carry the sub-city message");

// A count-only statement for a share question must be refused by the validator, so no delivery
// happens at all. This is the negative half of the ratio pair, on the same entry point.
const countsOnlySql =
  "SELECT d.age_group, SUM(d.offender_count) AS n FROM summary_offender_demographics d " +
  "WHERE d.state = 'CA' AND d.year BETWEEN 2021 AND 2025 GROUP BY d.age_group";
const countsVerdict = validateQueryContractSql({
  question: RATIO_Q, source: "nibrs", sql: countsOnlySql,
});
check(countsVerdict.retryIssues.length > 0 || countsVerdict.blockReasons.length > 0,
  "counts-only: full validator must refuse a count-only answer to a share question");

/* ================================================================== */
/*  D - is the delivery chokepoint actually live?                      */
/* ================================================================== */
/*
 * WHY THIS CHECK. In A and B the delivered text equals the draft, so on its own that would also be
 * what a no-op returned. An assertion that cannot fail proves nothing. So: give the SAME production
 * chokepoint an empty result for a question that asked for a figure, and require it to REPLACE the
 * wording. If it does, the seam is live and A/B's "the answer survived" means something.
 *
 * This is also the GC-073 failure mode in miniature - the uncertainty message displacing an answer -
 * which is exactly the behaviour A and B assert does NOT happen when rows are present.
 */
console.log("");
console.log("D - delivery chokepoint is live, not a pass-through");
{
  const emptyRows: Record<string, unknown>[] = [];
  const emptyDecision = genericResultState({ sql: wardSql, rows: emptyRows, queryCompleted: true });
  console.log(`  empty-result state : ${emptyDecision.state} (established=${emptyDecision.establishedFromEvidence})`);

  const govern = (text: string) => applyResultDisclosures({
    explanation: text, question: WARD_Q, sql: wardSql, rows: emptyRows,
    tab: "current", resultState: emptyDecision,
  });

  // A claim the guard's rules cover. State is `unknown` and unestablished, so it authorises
  // nothing and the wording must be replaced.
  const worded = "Ward, AR police reported zero murders in 2022.";
  const wordedOut = govern(worded);
  console.log(`  worded claim -> ${JSON.stringify(wordedOut.slice(0, 120))}`);
  check(wordedOut !== worded,
    "chokepoint must CHANGE an unsupported true-zero claim - otherwise A and B prove nothing");
  check(wordedOut === emptyDecision.message,
    "chokepoint must substitute the decision's own safe message");

  /*
   * OBSERVATION, deliberately NOT asserted and NOT fixed.
   *
   * `CLAIM_RULES` matches the WORD (/\bzero\b|\bnone were\b/), so the numeral form -
   * "reported 0 murders" - makes the same unsupported true-zero claim and is not caught.
   * Measured below rather than argued.
   *
   * This is outside the approved Ward + ratio scope, so it is reported in the handoff as an
   * observation for the release assessment, not repaired here. Asserting it would make this test
   * fail for a defect this batch is not authorised to touch.
   */
  const numeral = "Ward, AR police reported 0 murders in 2022.";
  const numeralOut = govern(numeral);
  console.log(`  numeral claim -> ${JSON.stringify(numeralOut.slice(0, 120))}`);
  console.log(`  OBSERVED (not asserted, out of scope): numeral zero claim ${
    numeralOut === numeral ? "PASSES THROUGH unguarded" : "is guarded"}`);
}

/* ================================================================== */
/*  E - FIXED COMPARISON GROUP: selection runs in SQL, against a      */
/*      fixture, and the delivered answer names its population        */
/* ================================================================== */
console.log("");
console.log("E - Current fixed-group comparison, driven through the real SQL");

/*
 * Authorized by `docs/superpowers/2026-09-10-current-comparison-cohort-implementation-ruling.md`.
 *
 * This drives the branch's real chain: the production contract and plan, the answer guard the route
 * applies, ALL THREE statements executed through the bounded worker in one call against a fixture
 * written here, then the shipped group builder and answer builder. Selection happens in the SQL, so
 * these checks exercise the selecting query rather than a TypeScript re-implementation of it.
 *
 * STATED LIMITATION: it drives the branch's builders, not the Next HTTP handler. Placement is
 * proved separately by `test-structural-route-placement.ts`.
 */
{
  const YOY_Q = "Did violent crime decrease every year from 2023 to 2026?";
  const plan = buildCurrentYoyComparisonPlan(YOY_Q);
  check(plan !== null, "yoy: the plan owns the anchor question");

  if (plan) {
    check(deterministicPlanRefusal({ question: YOY_Q, source: "current", sql: plan.sql }) === null,
      "yoy: the answer SQL passes the route's structural gate");

    const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const PARTIAL = [1, 2, 3, 4, 5];
    const MONTHS_OF: Record<number, number[]> = { 2023: ALL, 2024: ALL, 2025: ALL, 2026: PARTIAL };
    const PER_CELL: Record<number, number> = { 2023: 10, 2024: 9, 2025: 8, 2026: 7 };

    /** A fresh fixture database per scenario, so none can contaminate another. */
    const withFixture = <T,>(
      build: (ins: Database.Statement, insSample: Database.Statement) => void,
      run: (db: Database.Database) => T,
    ): T => {
      const dbFile = path.join(os.tmpdir(), "yoy-group-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".db");
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
      const writer = new Database(dbFile);
      writer.exec("CREATE TABLE agency_monthly (ori TEXT, agency TEXT, state TEXT, type TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER);");
      writer.exec("CREATE TABLE sample_agencies (ori TEXT PRIMARY KEY, agency TEXT, state TEXT, type TEXT);");
      build(
        writer.prepare("INSERT INTO agency_monthly VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
        writer.prepare("INSERT INTO sample_agencies VALUES (?, ?, ?, ?)"),
      );
      writer.close();
      const readonly = new Database(dbFile, { readonly: true });
      try { return run(readonly); } finally { readonly.close(); fs.unlinkSync(dbFile); }
    };

    /** All four statements in ONE bounded call, then the shipped group builder. */
    const readGroup = (db: Database.Database) => {
      const [periods, sampleRows, membership, answerRows] = executeManyWithTimeoutSync<Record<string, unknown>>(
        db, [plan.periodSql, plan.sampleSql, plan.membershipSql, plan.sql], 30000,
      );
      const group = buildCurrentYoyGroup(
        plan.years,
        periods as unknown as CurrentYoyPeriodRow[],
        membership as unknown as CurrentYoyMembershipRow[],
        sampleRows as unknown as CurrentYoySampleRow[],
        plan.offenses.length,
      );
      return { group, answerRows: answerRows as unknown as CurrentYoyAnswerRow[] };
    };

    /* ---- E1. a useful fixed-group comparison, full/full/full/partial ---- */
    {
      const COMPLETE = ["G1", "G2", "G3"];
      const result = withFixture((ins, insSample) => {
        for (const ori of [...COMPLETE, "X_MISSING_OFFENSE", "X_NULL_RECORD"]) insSample.run(ori, ori, "XX", "City");
        for (const year of plan.years) {
          for (const month of MONTHS_OF[year]) {
            for (const offense of plan.offenses) {
              for (const ori of COMPLETE) ins.run(ori, ori, "XX", "City", year, month, offense, PER_CELL[year]);
              // Excluded: this agency never reports Robbery at all.
              if (offense !== "Robbery") ins.run("X_MISSING_OFFENSE", "x", "XX", "City", year, month, offense, 99);
              // Excluded: one NULL observation. A null record is not a report.
              const nullCell = year === 2024 && month === 6 && offense === "Murder";
              ins.run("X_NULL_RECORD", "x", "XX", "City", year, month, offense, nullCell ? null : 99);
            }
          }
        }
      }, readGroup);

      check(result.group.includedCount === 3,
        "E1: only the three complete agencies are selected (got " + result.group.includedCount + ")");
      check(result.group.startingSampleSize === 5 && result.group.excludedCount === 2,
        "E1: starting sample 5, excluded 2 (got " + result.group.startingSampleSize + "/" + result.group.excludedCount + ")");
      check(result.group.oris.join(",") === COMPLETE.join(","),
        "E1: the selected identities are exactly the complete ones (got " + result.group.oris.join(",") + ")");
      check(answerCoversRequiredCells(result.answerRows, result.group, plan.offenses),
        "E1: the answer read covers exactly the required group cells");

      // Expected values computed HERE from the fixture, never read back from the answer.
      const expected: Record<number, number> = {};
      for (const year of plan.years) {
        expected[year] = MONTHS_OF[year].length * plan.offenses.length * PER_CELL[year] * COMPLETE.length;
      }
      const pct = (now: number, prev: number) =>
        Math.round((1000 * (expected[now] - expected[prev])) / expected[prev]) / 10;
      console.log("  E1 expected group totals computed here: " + JSON.stringify(expected));

      const answer = buildCurrentYoyComparisonAnswer(plan, result.answerRows, result.group);
      const row = (year: number) => answer.rows.find((r) => Number(r.year) === year)!;
      check(plan.years.every((y) => Number(row(y).total) === expected[y]),
        "E1: every delivered total equals the independently computed group total");
      check(Number(row(2024).change_pct) === pct(2024, 2023) && Number(row(2025).change_pct) === pct(2025, 2024),
        "E1: the matched full-year changes are delivered (" + pct(2024, 2023) + ", " + pct(2025, 2024) + ")");
      check(row(2026).change_pct === null, "E1: the partial-year change is withheld");
      check(Number(row(2026).prior_year_total) === expected[2025],
        "E1: the prior group total is retained for the withheld pair");
      check(/does not establish whether violent crime moved in the same direction in every year/.test(answer.explanation),
        "E1: the whole-chain claim is refused");
      check(/same 3 agencies from a starting sample of 5/.test(answer.explanation),
        "E1: the group size and the starting sample are both stated");
      check(/excluded 2 because their records did not include every requested crime/.test(answer.explanation),
        "E1: the excluded count and the reason are stated");
      check(/not all crime in the United States/.test(answer.explanation) && !/national sample/i.test(answer.explanation),
        "E1: the population is named as a reporting group, never the national sample");
      check(answer.title === "Violent Crime Counts, Comparison Group of 3 Agencies, 2023-2026",
        "E1: the title agrees with the explanation (got " + JSON.stringify(answer.title) + ")");
    }

    /* ---- E2. equal contributor counts, ROTATING identities ---- */
    {
      /*
       * Two agencies, each complete in one half of the span and absent from the other. Every year
       * has the same contributor COUNT, so a per-year group would compare them happily. One fixed
       * group across the whole span cannot: neither agency covers every year.
       */
      const result = withFixture((ins, insSample) => {
        for (const ori of ["R_EARLY", "R_LATE"]) insSample.run(ori, ori, "XX", "City");
        for (const year of plan.years) {
          const ori = year <= 2024 ? "R_EARLY" : "R_LATE";
          for (const month of MONTHS_OF[year]) {
            for (const offense of plan.offenses) ins.run(ori, ori, "XX", "City", year, month, offense, 5);
          }
        }
      }, readGroup);

      check(result.group.includedCount === 0,
        "E2: rotating identities yield NO fixed group (got " + result.group.includedCount + ")");
      /*
       * R1: the starting sample and the exclusions must be TRUE on this path. The sample size used
       * to ride on the membership rows, which are absent here, so the answer reported a starting
       * sample of zero and zero exclusions from a sample of two.
       */
      check(result.group.startingSampleSize === 2,
        "E2: the starting sample survives an empty group (got " + result.group.startingSampleSize + ", expected 2)");
      check(result.group.excludedCount === 2,
        "E2: and both agencies are counted as excluded (got " + result.group.excludedCount + ")");
      check(result.group.sampleIsEmpty === false,
        "E2: a nonempty sample with nobody eligible is not reported as an empty sample");
      const answer = buildCurrentYoyComparisonAnswer(plan, result.answerRows, result.group);
      check(answer.rows.every((r) => r.change_pct === null),
        "E2: so no change is delivered for any year - no per-year group substitution");
      check(/No fixed comparison group could be formed/.test(answer.explanation),
        "E2: the answer says no group could be formed");
      check(/of the 2 agencies in the starting sample/.test(answer.explanation),
        "E2: the delivered text states the real starting sample");
      check(/all 2 were excluded/.test(answer.explanation),
        "E2: and the real excluded count");
      check(!/starting sample of 0|the 0 agencies/.test(answer.explanation),
        "E2: and never reports a starting sample of zero from a nonempty sample");
      check(!/totals for both years are unchanged and are shown above/.test(answer.explanation),
        "E2: and never claims totals were shown when every total is null");
      check(/No Comparison Group Available/.test(answer.title), "E2: and the title agrees");
    }

    /* ---- E3. a known month where the requested offence is wholly absent ---- */
    {
      /*
       * June 2024 exists in the source - every agency reports the other three offences - but NOBODY
       * reports Robbery that month. The month must stay required; deleting it would turn missing
       * data into a shorter, apparently complete year.
       */
      const result = withFixture((ins, insSample) => {
        for (const ori of ["A1", "A2"]) insSample.run(ori, ori, "XX", "City");
        for (const year of plan.years) {
          for (const month of MONTHS_OF[year]) {
            for (const offense of plan.offenses) {
              if (year === 2024 && month === 6 && offense === "Robbery") continue;
              for (const ori of ["A1", "A2"]) ins.run(ori, ori, "XX", "City", year, month, offense, 4);
            }
          }
        }
      }, readGroup);

      /*
       * E3b IS THE DISCRIMINATING CASE. Here NONE of the requested offences appears in June 2024 -
       * the month exists in the source only through Burglary, which this comparison never asks
       * about. An offence-FILTERED period inventory would not see June at all, would shorten 2024
       * to eleven months, and would then deliver a comparison on a silently shortened year against
       * a full one. The offence-independent inventory keeps June required, so no agency qualifies.
       */
      const absentEverywhere = withFixture((ins, insSample) => {
        for (const ori of ["B1", "B2"]) insSample.run(ori, ori, "XX", "City");
        for (const year of plan.years) {
          for (const month of MONTHS_OF[year]) {
            for (const ori of ["B1", "B2"]) {
              if (year === 2024 && month === 6) {
                // The month exists, but only via an offence outside the requested set.
                ins.run(ori, ori, "XX", "City", year, month, "Burglary", 3);
                continue;
              }
              for (const offense of plan.offenses) ins.run(ori, ori, "XX", "City", year, month, offense, 4);
            }
          }
        }
      }, readGroup);
      const absent2024 = absentEverywhere.group.requiredPeriods.find((p) => p.year === 2024);
      check(absent2024 !== undefined && absent2024.months.length === 12,
        "E3b: a month present only through an unrequested offence is STILL required (got " +
        (absent2024 ? absent2024.months.length : -1) + " months)");
      check(absentEverywhere.group.includedCount === 0,
        "E3b: so no agency qualifies and the year is not silently shortened (group " +
        absentEverywhere.group.includedCount + ")");
      const absentAnswer = buildCurrentYoyComparisonAnswer(plan, absentEverywhere.answerRows, absentEverywhere.group);
      check(absentAnswer.rows.every((r) => r.change_pct === null),
        "E3b: and no comparison is delivered on the shortened year");
      // R1 again, on the other required negative path.
      check(absentEverywhere.group.startingSampleSize === 2 && absentEverywhere.group.excludedCount === 2,
        "E3b: the real starting sample and exclusions are reported (got " +
        absentEverywhere.group.startingSampleSize + "/" + absentEverywhere.group.excludedCount + ")");
      check(/of the 2 agencies in the starting sample/.test(absentAnswer.explanation) &&
            /all 2 were excluded/.test(absentAnswer.explanation),
        "E3b: and stated in the delivered text");
      check(!/totals for both years are unchanged and are shown above/.test(absentAnswer.explanation),
        "E3b: with no claim that absent totals were shown");

      const required2024 = result.group.requiredPeriods.find((p) => p.year === 2024);
      check(required2024 !== undefined && required2024.months.includes(6),
        "E3: June 2024 stays a REQUIRED month even though the requested offence is absent from it");
      check(required2024 !== undefined && required2024.months.length === 12,
        "E3: the year is not shortened to fit the data (got " + (required2024 ? required2024.months.length : -1) + " months)");
      check(result.group.includedCount === 0,
        "E3: no agency can satisfy that required cell, so the group is empty (got " + result.group.includedCount + ")");
      const answer = buildCurrentYoyComparisonAnswer(plan, result.answerRows, result.group);
      check(answer.rows.every((r) => r.change_pct === null), "E3: and no change is delivered");
    }

    /* ---- E4. a valid recorded zero counts as reporting ---- */
    {
      const result = withFixture((ins, insSample) => {
        insSample.run("Z1", "Z1", "XX", "City");
        for (const year of plan.years) {
          for (const month of MONTHS_OF[year]) {
            for (const offense of plan.offenses) {
              // Every Murder cell is a recorded ZERO. That is a report, not a gap.
              ins.run("Z1", "Z1", "XX", "City", year, month, offense, offense === "Murder" ? 0 : PER_CELL[year]);
            }
          }
        }
      }, readGroup);
      check(result.group.includedCount === 1,
        "E4: an agency whose records include valid zeros is INCLUDED (got " + result.group.includedCount + ")");
      /*
       * R1: an ALL-INCLUDED result must say so. Silence about exclusions reads as "we excluded
       * some", which is a different fact from "we excluded none".
       */
      check(result.group.excludedCount === 0,
        "E4: nobody is excluded here (got " + result.group.excludedCount + ")");
      const allIncluded = buildCurrentYoyComparisonAnswer(plan, result.answerRows, result.group);
      check(/No agencies were excluded/.test(allIncluded.explanation),
        "E4: and the answer states the zero exclusion explicitly");
      check(!/We excluded 0 /.test(allIncluded.explanation),
        "E4: without the awkward 'excluded 0' phrasing");
      const answer = buildCurrentYoyComparisonAnswer(plan, result.answerRows, result.group);
      const total2023 = Number(answer.rows.find((r) => Number(r.year) === 2023)!.total);
      check(total2023 === 12 * 3 * PER_CELL[2023],
        "E4: its zeros are counted as reported and the other offences still total correctly (got " + total2023 + ")");
    }

    /* ---- E5. a requested year absent from the source stays unknown ---- */
    {
      const result = withFixture((ins, insSample) => {
        insSample.run("Y1", "Y1", "XX", "City");
        for (const year of [2023, 2024, 2025]) {
          for (const month of ALL) {
            for (const offense of plan.offenses) ins.run("Y1", "Y1", "XX", "City", year, month, offense, 6);
          }
        }
      }, readGroup);
      check(result.group.yearsWithNoPeriods.join(",") === "2026",
        "E5: the absent year is recorded as having no periods (got " + result.group.yearsWithNoPeriods.join(",") + ")");
      check(result.group.includedCount === 1,
        "E5: an absent year does not prevent selection over the years that exist");
      const answer = buildCurrentYoyComparisonAnswer(plan, result.answerRows, result.group);
      const cert2026 = answer.certifications.find((c) => c.year === 2026)!;
      check(cert2026.months === null && /holds no 2026 observations/.test(cert2026.reason),
        "E5: 2026 is unknown, not a vacuously complete interval (" + cert2026.reason + ")");
      check(answer.rows.find((r) => Number(r.year) === 2026)!.change_pct === null,
        "E5: and no change is claimed for it");
      check(Number(answer.rows.find((r) => Number(r.year) === 2025)!.change_pct) === 0,
        "E5: while the years that do exist still compare");
    }
  }
}

/* ================================================================== */
/*  F - R1: the paired reads share one snapshot in the REAL path      */
/* ================================================================== */
console.log("");
console.log("F - R1: paired reads share one snapshot");

/*
 * The finding this proves, from `2026-09-10-current-comparison-implementation-codex-review.md` R1:
 * `executeWithTimeoutSync` spawns a worker PROCESS per call, and `lib/query-worker.js` opens and
 * closes its own read-only connection, so two calls read the database at two different moments. A
 * transaction on the caller's own handle governs neither child.
 *
 * Three proofs, in order: the defect is real on the two-call path; the single-call path is immune
 * to the same interleaving; and a failure inside the paired call leaves no lock behind.
 *
 * The interleaving is driven by a detached writer process, because `execFileSync` blocks the parent
 * for the whole read. Local temporary fixtures, child processes and cleanup are authorized for
 * exactly this proof. No production or restored database is touched.
 */
{
  const snapPath = path.join(os.tmpdir(), `yoy-snapshot-${process.pid}.db`);
  const writerPath = path.join(os.tmpdir(), `yoy-writer-${process.pid}.js`);
  const reportPath = path.join(os.tmpdir(), `yoy-writer-report-${process.pid}.json`);
  const sqliteModule = path.join(process.cwd(), "node_modules", "better-sqlite3");
  for (const p of [snapPath, writerPath, reportPath]) if (fs.existsSync(p)) fs.unlinkSync(p);

  const makeFixture = () => {
    const fixture = new Database(snapPath);
    fixture.exec("CREATE TABLE cell (k TEXT PRIMARY KEY, v INTEGER);");
    fixture.prepare("INSERT INTO cell VALUES ('a', 1)").run();
    fixture.close();
  };
  makeFixture();

  // Same cell key both times; only the value moves. Key comparison cannot see this change, which
  // is precisely why `answerAndCoverageAgree` is not the guarantee.
  const READ_SQL = "SELECT k, v FROM cell WHERE k = 'a'";
  const SLOW_READ_SQL =
    "WITH RECURSIVE spin(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM spin WHERE i < 4000000) " +
    "SELECT (SELECT k FROM cell WHERE k = 'a') AS k, (SELECT v FROM cell WHERE k = 'a') AS v, " +
    "MAX(i) AS spun FROM spin";

  type Cell = { k: string; v: number };

  /* ---- F1. the defect: two calls, two moments ---- */
  {
    const handle = new Database(snapPath, { readonly: true });
    const first = executeWithTimeoutSync<Cell>(handle, handle.prepare(READ_SQL), 30000);
    // The parent can write here precisely because the first worker has already exited.
    const writer = new Database(snapPath);
    writer.prepare("UPDATE cell SET v = 999 WHERE k = 'a'").run();
    writer.close();
    const second = executeWithTimeoutSync<Cell>(handle, handle.prepare(READ_SQL), 30000);
    handle.close();

    check(first[0].k === second[0].k, "F1: both reads return the same cell key");
    check(first[0].v === 1 && second[0].v === 999,
      `F1: two separate calls DID see different states (${first[0].v} then ${second[0].v}) - the defect is real`);
  }

  /* ---- F2. the fix: one call, one snapshot, with a write attempted mid-read ---- */
  {
    fs.unlinkSync(snapPath);
    makeFixture();
    /*
     * The writer RETRIES until it succeeds or its deadline passes. That is what gives this proof
     * teeth: a single timed attempt would simply be refused while any read held a lock, and the
     * test would pass on the broken two-process path too. Retrying means the write lands in the
     * first gap that opens — which on the two-call path is the moment between the two worker
     * processes, exactly the window R1 is about.
     */
    fs.writeFileSync(writerPath, [
      "const Database = require(process.argv[2]);",
      "const dbPath = process.argv[3];",
      "const reportPath = process.argv[4];",
      "const startDelayMs = Number(process.argv[5]);",
      "const deadlineMs = Number(process.argv[6]);",
      "const fs = require('fs');",
      "const begun = Date.now();",
      "while (Date.now() - begun < startDelayMs) { /* no deps, so busy-wait */ }",
      "let attempts = 0; let wroteAt = null; let lastError = '';",
      "const firstAt = Date.now();",
      "while (Date.now() - begun < deadlineMs) {",
      "  attempts += 1;",
      "  try {",
      "    const db = new Database(dbPath);",
      "    db.pragma('busy_timeout = 0');",
      "    db.prepare(\"UPDATE cell SET v = 999 WHERE k = 'a'\").run();",
      "    db.close();",
      "    wroteAt = Date.now();",
      "    break;",
      "  } catch (err) {",
      "    lastError = err.message;",
      "    const pause = Date.now();",
      "    while (Date.now() - pause < 5) { /* brief backoff */ }",
      "  }",
      "}",
      "fs.writeFileSync(reportPath, JSON.stringify({ attempts, firstAt, wroteAt, lastError }));",
    ].join("\n"));

    const writerChild = spawn(
      process.execPath,
      [writerPath, sqliteModule, snapPath, reportPath, "250", "8000"],
      { detached: true, stdio: "ignore" },
    );
    writerChild.unref();

    const handle = new Database(snapPath, { readonly: true });
    const startedAt = Date.now();
    const [slowRows, plainRows] = executeManyWithTimeoutSync<Cell & { spun?: number }>(
      handle, [SLOW_READ_SQL, READ_SQL], 30000,
    );
    const finishedAt = Date.now();
    handle.close();

    // Wait for the writer to finish its retry loop and report.
    const deadline = Date.now() + 12000;
    while (!fs.existsSync(reportPath) && Date.now() < deadline) { /* wait for the report */ }

    const elapsed = finishedAt - startedAt;
    check(fs.existsSync(reportPath),
      "F2: the writer process reported - the interleaving was actually arranged");
    if (fs.existsSync(reportPath)) {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        attempts: number; firstAt: number; wroteAt: number | null; lastError: string;
      };
      console.log(`  paired read ${elapsed}ms | writer: first attempt +${report.firstAt - startedAt}ms, ` +
        `${report.attempts} attempts, wrote ${report.wroteAt === null ? "never" : `+${report.wroteAt - startedAt}ms`}`);
      check(report.firstAt > startedAt && report.firstAt < finishedAt,
        `F2: the writer began attempting DURING the paired read (+${report.firstAt - startedAt}ms of ${elapsed}ms)`);
      check(report.attempts > 1,
        `F2: the writer was refused and retried rather than sailing through (${report.attempts} attempts)`);
      /*
       * The writer is held off for the life of the read transaction. `finishedAt` is when the
       * PARENT returned, which is after the worker committed and exited, so a write landing a few
       * milliseconds before that is a write that landed after the commit — not between the
       * statements. What is asserted is the contention itself: the writer could not get in for
       * most of the read.
       */
      check(report.wroteAt === null || report.wroteAt - report.firstAt > 100,
        `F2: the writer was blocked for the read's duration (${report.wroteAt === null ? "never wrote" : `${report.wroteAt - report.firstAt}ms of contention`})`);
      check(slowRows[0].v === plainRows[0].v,
        `F2: both statements saw the SAME value (${slowRows[0].v} and ${plainRows[0].v}) despite the concurrent writer`);
      check(slowRows[0].k === plainRows[0].k, "F2: and the same cell key");
    }
  }

  /* ---- F3. failure cleanup: no lock survives a failed paired call ---- */
  {
    fs.unlinkSync(snapPath);
    makeFixture();
    const handle = new Database(snapPath, { readonly: true });
    let threw = false;
    let message = "";
    try {
      executeManyWithTimeoutSync<Cell>(handle, [READ_SQL, "SELECT * FROM no_such_table"], 30000);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    handle.close();
    check(threw, "F3: a failing statement in the pair throws rather than returning partial rows");
    check(/no_such_table/i.test(message),
      `F3: the failure reports the real reason (got ${JSON.stringify(message.slice(0, 80))})`);

    // If the worker had left its read transaction open, this write would be refused.
    let wroteAfterFailure = false;
    try {
      const after = new Database(snapPath);
      after.pragma("busy_timeout = 0");
      after.prepare("UPDATE cell SET v = 7 WHERE k = 'a'").run();
      after.close();
      wroteAfterFailure = true;
    } catch { wroteAfterFailure = false; }
    check(wroteAfterFailure, "F3: the database is writable afterwards - no read lock was left behind");

    const reread = new Database(snapPath, { readonly: true });
    const rows = executeManyWithTimeoutSync<Cell>(reread, [READ_SQL], 30000)[0];
    reread.close();
    check(rows[0].v === 7, "F3: and the paired helper still works after a failure");
  }

  /* ---- F4. F1: no unbounded fallback for the paired read ---- */
  {
    fs.unlinkSync(snapPath);
    makeFixture();

    /*
     * The worker is made unavailable through the helper's own dependency seam, NOT by renaming or
     * deleting `lib/query-worker.js` — that file is shared by every other caller, and manufacturing
     * its absence would disturb them.
     *
     * Both statements are VALID and would return rows if anything executed them. So a throw here
     * cannot be a SQL error: it can only be the helper refusing. That is the distinction between
     * "fails" and "falls back", and the earlier version fell back — running `.all()` inside a
     * transaction with no time bound, trading the timeout away to keep the snapshot.
     */
    const noWorker = { resolveWorkerPath: () => null };
    const handle = new Database(snapPath, { readonly: true });

    let pairedThrew = false;
    let pairedMessage = "";
    let pairedResult: unknown = "NOT SET";
    try {
      pairedResult = executeManyWithTimeoutSync<Cell>(handle, [READ_SQL, READ_SQL], 30000, noWorker);
    } catch (err) {
      pairedThrew = true;
      pairedMessage = err instanceof Error ? err.message : String(err);
    }
    check(pairedThrew, "F4: the paired read REFUSES when bounded execution is unavailable");
    check(pairedMessage === BOUNDED_EXECUTION_UNAVAILABLE,
      `F4: and refuses for that reason, not a SQL error (got ${JSON.stringify(pairedMessage)})`);
    check(pairedResult === "NOT SET",
      "F4: no rows were returned, so neither statement was executed unbounded");

    // The pre-existing single-statement behaviour is PRESERVED, not changed by this correction:
    // with the same worker absence it still falls back and returns its rows.
    const single = executeWithTimeoutSync<Cell>(handle, handle.prepare(READ_SQL), 30000, noWorker);
    check(single.length === 1 && single[0].v === 1,
      `F4: the single-statement helper still falls back as before (got ${JSON.stringify(single)})`);

    // And with the worker present, the paired read works normally.
    const normal = executeManyWithTimeoutSync<Cell>(handle, [READ_SQL, READ_SQL], 30000);
    check(normal.length === 2 && normal[0][0].v === 1 && normal[1][0].v === 1,
      "F4: the normal paired path is unaffected");
    handle.close();
  }

  for (const p of [snapPath, writerPath, reportPath]) if (fs.existsSync(p)) fs.unlinkSync(p);
}


/* ================================================================== */
/*  G - R2: the verification identity gate FAILS CLOSED               */
/* ================================================================== */
console.log("");
console.log("G - R2: the offline verification's identity gate fails closed");

/*
 * The actual successor gate logic, imported and exercised here rather than described in prose.
 *
 * The previous verification's gate could be skipped: each expected hash defaulted to an empty
 * string and the comparison was `if (expected && expected !== actual)`, so a MISSING expectation
 * passed silently, and its `candidate_identities_gated` flag used `.some(...)` — one supplied
 * expectation reported a five-file gate as complete. Every case below is a refusal that the old
 * shape would have allowed, plus the positive and the cell-consistency stop.
 *
 * Isolated dependencies: the "actual" reader is a function, so nothing here touches the repository,
 * renames source, mutates a database or starts a harness.
 */
{
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const PATHS = ["one.ts", "two.ts"];
  const actualAllA = () => A;

  // (a) NO expectations at all - the old gate continued and reported not-gated.
  const none = gateIdentities(PATHS, {}, actualAllA);
  check(none.ok === false && none.kind === "missing",
    "G: no expectations declared is a REFUSAL, not a skip (got " + JSON.stringify(none) + ")");

  // (b) ONE of two expectations supplied - the old gate continued and reported gated: true.
  const partial = gateIdentities(PATHS, { "one.ts": A }, actualAllA);
  check(partial.ok === false && partial.kind === "missing" && partial.path === "two.ts",
    "G: a missing expectation for any required path is a refusal naming that path");

  // (c) MALFORMED expectations are refused as malformed, not silently unequal.
  for (const [label, value] of [
    ["too short", "abc123"],
    ["uppercase", A.toUpperCase()],
    ["not a string", 12345 as unknown as string],
    ["empty string", ""],
  ] as [string, string][]) {
    const malformed = gateIdentities(["one.ts"], { "one.ts": value }, actualAllA);
    check(malformed.ok === false && (malformed.kind === "malformed" || malformed.kind === "missing"),
      "G: a " + label + " expectation is refused (got " + JSON.stringify(malformed) + ")");
  }

  // (d) A MISMATCH is refused and the reason carries both values.
  const mismatch = gateIdentities(["one.ts"], { "one.ts": B }, actualAllA);
  check(mismatch.ok === false && mismatch.kind === "mismatch" && mismatch.reason.includes(B),
    "G: a mismatching expectation is refused with both identities in the reason");

  // (e) A malformed COMPUTED identity is refused too, not compared as a string.
  const badActual = gateIdentities(["one.ts"], { "one.ts": A }, () => "not-a-hash");
  check(badActual.ok === false && badActual.kind === "malformed",
    "G: a computed identity that is not a sha256 is refused");

  // (f) An empty required list cannot pass vacuously.
  const noRequired = gateIdentities([], { "one.ts": A }, actualAllA);
  check(noRequired.ok === false && noRequired.kind === "empty_expectations",
    "G: declaring no required identities is itself a refusal");

  // (g) THE POSITIVE: every required path present, well-formed and matching.
  const good = gateIdentities(PATHS, { "one.ts": A, "two.ts": A, "extra.ts": B }, actualAllA);
  check(good.ok === true, "G: all required identities matching is accepted");
  check(good.ok === true && good.compared.length === PATHS.length,
    "G: and every required path is recorded as compared, not just some");

  // (h) The shipped verification declares all seven identities it needs.
  check(REQUIRED_IDENTITIES.length === 7 &&
        REQUIRED_IDENTITIES.includes("crime_data.db") &&
        REQUIRED_IDENTITIES.includes("app/api/query/route.ts") &&
        REQUIRED_IDENTITIES.includes("lib/current-yoy-comparison-deterministic.ts"),
    "G: the required-identity list covers the database, the frozen set and the candidate sources");

  /*
   * (i) THE CELL-CONSISTENCY STOP. The route refuses this condition; the previous verification
   *     recorded the boolean and built the answer anyway. Here the same helper the verification
   *     calls must report false for a short answer set, which is what the successor stops on.
   */
  const plan = buildCurrentYoyComparisonPlan("How much did murders increase bv year-over-year from 2019 to 2020");
  check(plan !== null, "G: the murder plan is available for the consistency check");
  if (plan) {
    const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const periodRows: CurrentYoyPeriodRow[] = [];
    const fullAnswer: CurrentYoyAnswerRow[] = [];
    for (const year of plan.years) {
      for (const month of ALL_MONTHS) {
        periodRows.push({ year, month });
        fullAnswer.push({ year, month, offense: "Murder", offense_count: 1 });
      }
    }
    const grp = buildCurrentYoyGroup(plan.years, periodRows, [{ ori: "G" }], [{ sample_size: 1 }], 1);
    check(answerCoversRequiredCells(fullAnswer, grp, plan.offenses),
      "G: a complete answer set passes the consistency check");
    check(!answerCoversRequiredCells(fullAnswer.slice(0, -1), grp, plan.offenses),
      "G: a short answer set FAILS it, which is what the verification refuses on");
  }
}

/*
 * THE MODEL PATH'S OWN VALIDATOR, NOT ONLY THE CHECKER IT CALLS.
 *
 * A model answer is not gated by `evaluateStructuralSemantics` directly; it is gated by
 * `validateQueryContractSql`, which consumes it. So the shape that invents its totals is asserted
 * here through the validator the route actually runs, and the supported shapes beside it.
 *
 * What this establishes is that the validator enforces the finding. It does not establish what the
 * user finally sees: an enforced retry can still end in a contract-failure response, and this drives
 * the validator rather than the HTTP handler.
 */
/*
 * H - ANNUAL FIGURES: the year has to reach the rows, and months have to be combined.
 *
 * Two saved answers published numbers that were not what they said. GC-043 selected bare monthly
 * counts from `summary_city_monthly` while grouping by year, so one arbitrary month was titled as a
 * year's total. GC-054 summed every murder `agency_monthly` holds, divided by the 2026 population,
 * and called it the 2026 rate -- its only year predicate sat on the population CTE.
 *
 * Ordinary variations of both are covered here, not only the two saved strings: the same defects
 * written with a nested aggregate argument, moved inside a used CTE, or hidden behind a second
 * alias of the same table. Each unsafe form is paired with the closest SAFE form, so a check
 * cannot pass by refusing the family.
 *
 * Three things are proved, in the order the routes do them:
 *   H1  the route's contract-failure branch is entered, and nothing is executed or delivered.
 *   H2  supported counterparts draw no failure at all, and the VALIDATOR'S RETURNED SQL is what
 *       gets executed and delivered -- figures, explanation and title against expectations
 *       computed here.
 *   H3  the unsafe SQL executed directly on the same fixture, as a diagnostic, to show the wrong
 *       number it would have produced. Never on the guarded path.
 */
{
  const GC043_Q = "Houston vehicle burglaries by year and clearance status, 2018 to 2026";
  const GC054_Q = "make a list of the 20 most populous cities and sort them by 2026 homicide rate";

  const SELECT_043_BARE =
    "SELECT s.year, s.ucr_offense_code, s.offense_count AS total_offenses, s.cleared_count AS cleared, " +
    "s.offense_count - s.cleared_count AS not_cleared, " +
    "ROUND(100.0 * s.cleared_count / s.offense_count, 1) AS clearance_rate " +
    "FROM summary_city_monthly s WHERE s.ori = 'TXHPD0000' AND s.ucr_offense_code = '23F' " +
    "AND s.year BETWEEN 2018 AND 2026 GROUP BY s.year ORDER BY s.year LIMIT 1000";
  const SELECT_043_SUMMED =
    "SELECT s.year, s.ucr_offense_code, SUM(s.offense_count) AS total_offenses, " +
    "SUM(s.cleared_count) AS cleared, SUM(s.offense_count) - SUM(s.cleared_count) AS not_cleared, " +
    "ROUND(100.0 * SUM(s.cleared_count) / SUM(s.offense_count), 1) AS clearance_rate " +
    "FROM summary_city_monthly s WHERE s.ori = 'TXHPD0000' AND s.ucr_offense_code = '23F' " +
    "AND s.year BETWEEN 2018 AND 2026 GROUP BY s.year ORDER BY s.year LIMIT 1000";
  const WRAP_043 = (inner: string, regroup: boolean) =>
    "WITH annual AS (" + inner + ") SELECT year, ucr_offense_code, total_offenses, cleared, " +
    "not_cleared, clearance_rate FROM annual " + (regroup ? "GROUP BY year " : "") + "ORDER BY year LIMIT 1000";

  const build054 = (from: string, sum: string, where: string, lead = "WITH ") => lead +
    "city_pop_2026 AS (SELECT ori, population FROM agency_population WHERE year = 2026),\n" +
    "top_20_cities AS (\n" +
    "  SELECT cp.ori, am.agency, am.state, " + sum + " as homicides, cp.population,\n" +
    "    ROUND(" + sum + " * 100000.0 / cp.population, 1) as homicide_rate_per_100k\n" +
    "  FROM " + from + "\n" +
    "  JOIN city_pop_2026 cp ON cp.ori = am.ori\n" +
    "  WHERE " + where + "\n" +
    "  GROUP BY cp.ori, am.agency, am.state, cp.population\n" +
    "  ORDER BY cp.population DESC LIMIT 20\n)\n" +
    "SELECT agency || ', ' || state as city, population, homicides, homicide_rate_per_100k\n" +
    "FROM top_20_cities ORDER BY homicide_rate_per_100k DESC LIMIT 20";
  const MURDER_CITY = "am.offense = 'Murder' AND am.type = 'City' AND cp.population > 0";
  const PROJECTING = (bound: boolean) =>
    "WITH metric_rows AS (SELECT ori, agency, state, count, offense, type FROM agency_monthly" +
    (bound ? " WHERE year = 2026" : "") + "), ";

  /** The whole validator, exactly as both routes call it. */
  const validate = (question: string, source: string, sql: string) =>
    validateQueryContractSql({ question, source: source as never, sql });

  // ── H1 ── the routes' contract-failure branch, driven in their own order ──────────────────────
  //
  // Both routes do: validate -> if `queryContractFailureMessage` is non-null, return the failure
  // payload WITHOUT executing -> otherwise execute. That order is replicated here with a counter
  // standing in for execution, so "the bad query is never run" is asserted rather than assumed.
  // Where those calls sit in the real handlers is proved separately by
  // `test-structural-route-placement.ts`; this is the behaviour of the branch itself.
  const INJECTED_DRAFT_TITLE: string =
    "[injected model draft] Houston Vehicle Burglaries by Year (2018-2026)";
  const routeOutcome = (question: string, source: string, sql: string, run: () => unknown) => {
    const result = validate(question, source, sql);
    const failure = queryContractFailureMessage(result);
    if (failure) {
      // The literal payload both routes emit on this branch: no SQL, no title, no rows.
      return { executed: false, payload: { sql: null, explanation: failure, title: "", rows: [] as unknown[], rowCount: 0 } };
    }
    return { executed: true, payload: { sql: result.sql, explanation: "", title: INJECTED_DRAFT_TITLE, rows: run() as unknown[], rowCount: 0 } };
  };

  const unsafe: [string, string, string, string][] = [
    ["GC-043 saved: bare monthly counts grouped by year", GC043_Q, "nibrs", SELECT_043_BARE],
    ["GC-043 variation: the same bad grouping inside a used CTE", GC043_Q, "nibrs", WRAP_043(SELECT_043_BARE, false)],
    ["GC-054 saved: no year on the metric table", GC054_Q, "current", build054("agency_monthly am", "SUM(am.count)", MURDER_CITY)],
    ["GC-054 variation: nested aggregate argument", GC054_Q, "current", build054("agency_monthly am", "SUM(COALESCE(am.count, 0))", MURDER_CITY)],
    ["GC-054 variation: metric rows projected by a CTE, summed outside", GC054_Q, "current",
      build054("metric_rows am", "SUM(am.count)", MURDER_CITY, PROJECTING(false))],
    ["GC-054 variation: a second alias carries the only year predicate", GC054_Q, "current",
      build054("agency_monthly am JOIN agency_monthly pin ON pin.ori = am.ori AND pin.year = 2026",
        "SUM(am.count)", MURDER_CITY)],
  ];

  for (const [name, question, source, sql] of unsafe) {
    let executions = 0;
    const outcome = routeOutcome(question, source, sql, () => { executions += 1; return []; });
    check(!outcome.executed && executions === 0, `H1 ${name}: must never reach execution`);
    check(outcome.payload.sql === null, `H1 ${name}: no SQL is returned to the reader`);
    check(outcome.payload.title === "", `H1 ${name}: no stale title survives`);
    check(outcome.payload.rows.length === 0 && outcome.payload.rowCount === 0,
      `H1 ${name}: no figure survives`);
    check(!/\d{2,}/.test(outcome.payload.explanation),
      `H1 ${name}: the failure message carries no figure (got ${JSON.stringify(outcome.payload.explanation.slice(0, 80))})`);
    check(/couldn't build a reliable query|not reliable|cannot/i.test(outcome.payload.explanation),
      `H1 ${name}: the failure message is the honest one (got ${JSON.stringify(outcome.payload.explanation.slice(0, 80))})`);
  }

  // ── H2 ── supported counterparts: no failure, then the validator's own SQL executed ───────────
  //
  // Fixtures are disposable, carry distinct per-month values, and include wrong-entity,
  // wrong-offense and wrong-year decoys, so a right figure can only come from the right rows.
  type MonthRow = [string, number, number, string, number, number];
  const nibrsRows: MonthRow[] = [];
  for (const year of [2018, 2019]) {
    for (let month = 1; month <= 12; month += 1) {
      nibrsRows.push(["TXHPD0000", year, month, "23F", 100 + month * 10 + (year - 2018) * 7, month]);
      nibrsRows.push(["TXHPD0000", year, month, "23A", 9000, 900]);        // wrong offense
      nibrsRows.push(["TXAPD0000", year, month, "23F", 8000, 800]);        // wrong entity
    }
  }
  const nibrsPath = path.join(os.tmpdir(), "annual-nibrs-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".db");
  const nibrsWriter = new Database(nibrsPath);
  nibrsWriter.exec(
    "CREATE TABLE summary_city_monthly (ori TEXT, year INTEGER, month INTEGER, " +
    "ucr_offense_code TEXT, offense_count INTEGER, cleared_count INTEGER);");
  const insertNibrs = nibrsWriter.prepare("INSERT INTO summary_city_monthly VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of nibrsRows) insertNibrs.run(...row);
  nibrsWriter.close();
  const nibrsDb = new Database(nibrsPath, { readonly: true });

  const wanted = nibrsRows.filter(([ori, , , code]) => ori === "TXHPD0000" && code === "23F");
  const expectedOffenses = new Map<number, number>();
  const expectedCleared = new Map<number, number>();
  for (const [, year, , , offenses, cleared] of wanted) {
    expectedOffenses.set(year, (expectedOffenses.get(year) ?? 0) + offenses);
    expectedCleared.set(year, (expectedCleared.get(year) ?? 0) + cleared);
  }
  console.log(`  GC-043 expected 2018 offenses computed here: ${expectedOffenses.get(2018)}`);

  const safe043: [string, string][] = [
    ["summed in place", SELECT_043_SUMMED],
    ["summed inside a used CTE", WRAP_043(SELECT_043_SUMMED, false)],
    ["summed inside a CTE, then regrouped annually outside", WRAP_043(SELECT_043_SUMMED, true)],
  ];
  for (const [name, sql] of safe043) {
    const result = validate(GC043_Q, "nibrs", sql);
    check(queryContractFailureMessage(result) === null
      && result.retryIssues.length === 0 && result.blockReasons.length === 0,
      `H2 GC-043 ${name}: no full-validator failure (got ${[...result.enforced, ...result.retryIssues].join("; ") || "clean"})`);

    // The route executes the validator's RETURNED sql, which it may have rewritten.
    const rows = nibrsDb.prepare(result.sql).all() as Record<string, unknown>[];
    check(rows.length === 2, `H2 GC-043 ${name}: one row per year (got ${rows.length})`);
    for (const row of rows) {
      const year = Number(row.year);
      const offenses = expectedOffenses.get(year)!;
      const cleared = expectedCleared.get(year)!;
      check(Number(row.total_offenses) === offenses,
        `H2 GC-043 ${name}: ${year} offenses must be ${offenses} (got ${row.total_offenses})`);
      check(Number(row.cleared) === cleared, `H2 GC-043 ${name}: ${year} cleared must be ${cleared}`);
      check(Number(row.not_cleared) === offenses - cleared,
        `H2 GC-043 ${name}: ${year} not-cleared must be the difference`);
      check(Number(row.clearance_rate) === Math.round(1000 * cleared / offenses) / 10,
        `H2 GC-043 ${name}: ${year} rate must come from the summed operands (got ${row.clearance_rate})`);
    }

    const grain = validateGrain(GC043_Q, rows, result.sql);
    check(grain.ok, `H2 GC-043 ${name}: the rows must satisfy the requested grain (${grain.message ?? ""})`);

    // TITLE. Both model paths call `alignTitleYearRange`; the injected draft claims 2018-2026 while
    // the fixture holds 2018-2019, so a correct answer must not ship the stale range.
    const title = alignTitleYearRange(INJECTED_DRAFT_TITLE, rows);
    check(title === "[injected model draft] Houston Vehicle Burglaries by Year (2018-2019)",
      `H2 GC-043 ${name}: the title must state the years actually returned (got ${JSON.stringify(title)})`);

    const delivered = applyResultDisclosures({
      explanation: `[injected model draft] Houston reported ${rows[0].total_offenses} vehicle ` +
        `burglaries in 2018, with a ${rows[0].clearance_rate}% clearance rate.`,
      question: GC043_Q, sql: result.sql, rows, tab: "nibrs",
      resultState: genericResultState({ sql: result.sql, rows, queryCompleted: true }),
    });
    check(delivered.includes(String(expectedOffenses.get(2018))),
      `H2 GC-043 ${name}: delivered text must carry the year's total, not a month's`);
    check(/Houston/.test(delivered), `H2 GC-043 ${name}: delivered text must name the entity`);
    check(/2018/.test(delivered), `H2 GC-043 ${name}: delivered text must name the period`);
  }

  type CurrentRow = [string, string, string, string, number, number, string, number];
  const currentRows: CurrentRow[] = [];
  for (const ori of ["AZ0030000", "AZ0040000"]) {
    const agency = ori === "AZ0030000" ? "Flagville" : "Redrock";
    for (let month = 1; month <= 5; month += 1) {
      currentRows.push([ori, agency, "AZ", "City", 2026, month, "Murder", month]);
      currentRows.push([ori, agency, "AZ", "City", 2025, month, "Murder", 50]);   // wrong year
      currentRows.push([ori, agency, "AZ", "City", 2026, month, "Robbery", 400]); // wrong offense
    }
  }
  const currentPath = path.join(os.tmpdir(), "annual-current-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".db");
  const currentWriter = new Database(currentPath);
  currentWriter.exec(
    "CREATE TABLE agency_monthly (ori TEXT, agency TEXT, state TEXT, type TEXT, year INTEGER, " +
    "month INTEGER, offense TEXT, count INTEGER);" +
    "CREATE TABLE agency_population (ori TEXT, year INTEGER, population INTEGER);");
  const insertCurrent = currentWriter.prepare("INSERT INTO agency_monthly VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of currentRows) insertCurrent.run(...row);
  const insertPop = currentWriter.prepare("INSERT INTO agency_population VALUES (?, ?, ?)");
  insertPop.run("AZ0030000", 2026, 200000);
  insertPop.run("AZ0040000", 2026, 100000);
  insertPop.run("AZ0030000", 2025, 999);            // a decoy population year
  currentWriter.close();
  const currentDb = new Database(currentPath, { readonly: true });

  const populationOf: Record<string, number> = { AZ0030000: 200000, AZ0040000: 100000 };
  const expectedRate = new Map<string, number>();
  for (const ori of Object.keys(populationOf)) {
    const murders2026 = currentRows
      .filter(([o, , , , year, , offense]) => o === ori && year === 2026 && offense === "Murder")
      .reduce((total, row) => total + row[7], 0);
    expectedRate.set(ori, Math.round(10 * murders2026 * 100000 / populationOf[ori]) / 10);
  }
  console.log(`  GC-054 expected 2026 rates computed here: ${JSON.stringify([...expectedRate])}`);

  const safe054: [string, string][] = [
    ["year on the metric table", build054("agency_monthly am", "SUM(am.count)", "am.year = 2026 AND " + MURDER_CITY)],
    ["year on the metric table, nested aggregate argument",
      build054("agency_monthly am", "SUM(COALESCE(am.count, 0))", "am.year = 2026 AND " + MURDER_CITY)],
    ["year inside the projecting CTE",
      build054("metric_rows am", "SUM(am.count)", MURDER_CITY, PROJECTING(true))],
  ];
  const DRAFT_054_TITLE = "[injected model draft] Homicide Rate by City, 2025";
  for (const [name, sql] of safe054) {
    const result = validate(GC054_Q, "current", sql);
    check(queryContractFailureMessage(result) === null
      && result.retryIssues.length === 0 && result.blockReasons.length === 0,
      `H2 GC-054 ${name}: no full-validator failure (got ${[...result.enforced, ...result.retryIssues].join("; ") || "clean"})`);

    const rows = currentDb.prepare(result.sql).all() as Record<string, unknown>[];
    check(rows.length === 2, `H2 GC-054 ${name}: one row per city (got ${rows.length})`);
    for (const [ori, rate] of expectedRate) {
      const city = ori === "AZ0030000" ? "Flagville" : "Redrock";
      const row = rows.find((candidate) => String(candidate.city).startsWith(city));
      check(Number(row?.homicide_rate_per_100k) === rate,
        `H2 GC-054 ${name}: ${city}'s 2026 rate must be ${rate} (got ${row?.homicide_rate_per_100k})`);
    }

    const delivered = applyResultDisclosures({
      explanation: `[injected model draft] Flagville, AZ had a 2026 homicide rate of ` +
        `${rows.find((row) => String(row.city).startsWith("Flagville"))?.homicide_rate_per_100k} per 100,000.`,
      question: GC054_Q, sql: result.sql, rows, tab: "current",
      resultState: currentTrendsResultState(currentDb, { sql: result.sql, rows, queryCompleted: true }),
    });
    check(delivered.includes(String(expectedRate.get("AZ0030000"))),
      `H2 GC-054 ${name}: delivered text must carry the 2026-only rate`);
    check(/2026/.test(delivered), `H2 GC-054 ${name}: delivered text must name the period`);
    check(/Flagville/.test(delivered), `H2 GC-054 ${name}: delivered text must name the entity`);
  }

  // ── H3 ── the wrong numbers, executed directly. A DIAGNOSTIC, never the guarded path ──────────
  const savedBad043 = nibrsDb.prepare(SELECT_043_BARE).all() as Record<string, unknown>[];
  const bad2018 = Number(savedBad043.find((row) => Number(row.year) === 2018)?.total_offenses);
  check(bad2018 !== expectedOffenses.get(2018),
    "H3 GC-043: the refused shape does NOT produce the year's total -- that is the defect");
  check(wanted.some(([, year, , , offenses]) => year === 2018 && offenses === bad2018),
    `H3 GC-043: the refused shape's ${bad2018} is one single month's value`);

  const savedBad054 = currentDb.prepare(build054("agency_monthly am", "SUM(am.count)", MURDER_CITY)).all() as Record<string, unknown>[];
  const badFlag = Number(savedBad054.find((row) => String(row.city).startsWith("Flagville"))?.homicide_rate_per_100k);
  check(badFlag > expectedRate.get("AZ0030000")!,
    `H3 GC-054: the refused shape inflates the rate on these rows (${badFlag} vs ${expectedRate.get("AZ0030000")})`);

  const alignedStale = alignTitleYearRange(DRAFT_054_TITLE, savedBad054);
  check(alignedStale === DRAFT_054_TITLE,
    "H3 GC-054: a title can outlive the rows it describes, which is why the failure branch sends none");

  nibrsDb.close();
  fs.unlinkSync(nibrsPath);
  currentDb.close();
  fs.unlinkSync(currentPath);
}

{
  const q = "how many murders in albuquerque by year from 2020 to 2021";
  const enforcedFor = (sql: string) =>
    validateQueryContractSql({ question: q, source: "nibrs" as never, sql })
      .enforced.filter((id) => id.startsWith("structural-"));

  check(
    enforcedFor(
      "WITH t AS (SELECT 2020 AS year, 500 AS murders UNION ALL SELECT 2021 AS year, 600 AS murders)\n" +
      "SELECT t.year, t.murders FROM t AS t"
    ).includes("structural-returned-series-unresolved"),
    "contract validator: totals supplied by the query itself are enforced against"
  );

  check(
    enforcedFor("SELECT 2020 AS year, 500 AS murders")
      .includes("structural-returned-series-unresolved"),
    "contract validator: the same literals without a CTE keep their existing refusal"
  );

  check(
    enforcedFor(
      "WITH x AS (SELECT v.year, SUM(v.victim_count) AS murders\n" +
      "  FROM summary_victim_city_monthly AS v\n" +
      "  WHERE v.ori='NM0010100' AND v.ucr_offense_code='09A' GROUP BY v.year)\n" +
      "SELECT x.year, x.murders FROM x AS x"
    ).length === 0,
    "contract validator: a real aggregate is still allowed through"
  );

  check(
    enforcedFor(
      "WITH years AS (SELECT 2020 AS year UNION ALL SELECT year + 1 FROM years WHERE year < 2021)\n" +
      "SELECT y.year, SUM(v.victim_count) AS murders\n" +
      "FROM years AS y LEFT JOIN summary_victim_city_monthly AS v ON v.year = y.year AND v.ori='NM0010100'\n" +
      "WHERE v.ucr_offense_code='09A' GROUP BY y.year"
    ).length === 0,
    "contract validator: the gap-fill shape the guardrails prescribe is still allowed through"
  );
}

db.close();
fs.unlinkSync(dbPath);

console.log("");
console.log(`checks: ${checks}   failures: ${failures}`);
if (failures > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS");
