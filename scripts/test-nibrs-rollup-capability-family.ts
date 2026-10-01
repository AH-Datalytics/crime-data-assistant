/*
 * P4.1 R1 (Codex ruling): the final capability checks recognize the planner's rollup tables.
 *
 * The table extractor reports a `rollup.<table>` reference only as its schema name, "rollup", so a
 * legitimate state/national rollup the optimizer chose failed every rule requiring its measure family
 * (the clearance rollups lost supported answers once the final check ran on planned SQL).
 *
 * Held here:
 *   1. recognition comes from the router's own declarations: exactly rollup.state_<source> and
 *      rollup.national_<source> for its nine sources; any other rollup.* name gets no family;
 *   2. PROPERTY: a planner rollup table is judged exactly as its source table -- for every NIBRS rule
 *      touching those sources (nine, required AND forbidden lists), across a question set that fires
 *      each of them, for every source at both levels, the findings are identical;
 *   3. the unsafe counterpart stays refused: an ordinary offense table used for a clearance count, and a
 *      rollup of a table that is not a planner rollup source;
 *   4. the real rollup name is kept in the finding's actualTables (grain preserved in reporting).
 * Delivered answers through the real route and worker: audit/p4-final-statement-binding-2026-09-28/binding-witness.cjs.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import { validateSourceCapabilities, SOURCE_CAPABILITY_RULES } from "../lib/source-capabilities";
import { nibrsRollupTablesIn } from "../lib/nibrs-rollup-router";
import { buildQueryContract } from "../lib/query-contract";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const SOURCES = ["summary_arrestee_demographics", "summary_victim_demographics", "summary_offender_demographics", "summary_victim_relationship",
  "summary_victim_weapon", "summary_victim_circumstance", "summary_victim_weapon_circumstance_demo", "summary_clearance_type", "summary_clearance_detail"];
const findingsFor = (question: string, sql: string) => {
  const contract = buildQueryContract(question, "nibrs");
  if (!contract) throw new Error(`no contract for ${question}`);
  return validateSourceCapabilities({ question, source: "nibrs", contract, sql });
};
const ids = (f: ReturnType<typeof findingsFor>) => f.map((x) => `${x.ruleId}:${x.severity}`).sort().join("|");

console.log("\n1 - recognition comes from the router's own declarations");
{
  const found = nibrsRollupTablesIn("SELECT * FROM rollup.state_summary_clearance_detail c JOIN rollup.national_summary_victim_weapon w ON 1=1");
  check(JSON.stringify(found) === JSON.stringify([
    { table: "rollup.state_summary_clearance_detail", level: "state", sourceTable: "summary_clearance_detail" },
    { table: "rollup.national_summary_victim_weapon", level: "national", sourceTable: "summary_victim_weapon" }]),
    "state and national planner rollups are recognized with their source family and level");
  check(nibrsRollupTablesIn("SELECT * FROM rollup.state_summary_state_monthly").length === 0, "a rollup name outside the router's nine sources gets no family");
  check(nibrsRollupTablesIn("SELECT * FROM rollup.county_summary_clearance_detail").length === 0, "a level the router never produces gets no family");
  check(nibrsRollupTablesIn("SELECT 'FROM rollup.state_summary_clearance_detail' AS note FROM agencies").length === 0, "a name inside a string literal is not a table");
}

console.log("\n2 - PROPERTY: a planner rollup table is judged exactly as its source table");
const QUESTIONS = [
  "How many rapes were cleared by arrest in Illinois in 2025?",
  "How many rapes were cleared by exceptional means nationwide in 2025?",
  "Monthly juvenile arrests for robbery in Texas in 2024",
  "What was the race of murder victims in Ohio in 2024?",
  "How many murder victims were killed with a firearm in Florida in 2024?",
  "Firearm murder victims by sex in Florida in 2024",
  "Firearm murder victims by circumstance in Florida in 2024",
  "Firearm murder victims by circumstance and age in Florida in 2024",
  "What share of aggravated assaults in Ohio in 2024 were domestic violence?",
  "Break down robbery offenders by age in Texas in 2024",
  "Which agencies report NIBRS data in Illinois?",
  "What was the victim-offender relationship for murders nationally in 2023?",
];
const fired = new Set<string>();
let compared = 0; let mismatches: string[] = [];
for (const q of QUESTIONS) {
  for (const src of SOURCES) {
    const base = findingsFor(q, `SELECT COUNT(*) AS n FROM ${src} WHERE state = 'IL' AND year = 2025`);
    for (const f of base) fired.add(f.ruleId);
    for (const level of ["state", "national"]) {
      const rolled = findingsFor(q, `SELECT COUNT(*) AS n FROM rollup.${level}_${src} WHERE state = 'IL' AND year = 2025`);
      compared += 1;
      if (ids(base) !== ids(rolled)) mismatches.push(`${q} | ${src} | ${level}: ${ids(base)} vs ${ids(rolled)}`);
    }
  }
}
check(mismatches.length === 0, `identical findings for every question x source x level (${compared} comparisons)${mismatches.length ? `: ${mismatches.slice(0, 3).join("; ")}` : ""}`);
const TOUCHING = (SOURCE_CAPABILITY_RULES as Array<{ id: string; source: string; requiresAnyTables?: string[]; forbidsTables?: string[] }>)
  .filter((r) => r.source === "nibrs" && [...(r.requiresAnyTables ?? []), ...(r.forbidsTables ?? [])].some((t) => SOURCES.includes(t))).map((r) => r.id);
// nibrs-agency-lookup-not-crime-data fires only when the SQL reads nothing but `agencies`, so no rollup
// reference can take part; it is exercised directly below rather than by the table-form sweep.
const AGENCY_ONLY = "nibrs-agency-lookup-not-crime-data";
const unfired = TOUCHING.filter((id) => id !== AGENCY_ONLY && !fired.has(id));
check(TOUCHING.length === 9 && TOUCHING.includes(AGENCY_ONLY) && unfired.length === 0,
  `the property is exercised: the ${TOUCHING.length - 1} rules a rollup reference can reach all fire somewhere in the set${unfired.length ? ` (never fired: ${unfired.join(", ")})` : ""}`);
{
  const q = "How many murders were there in Illinois in 2025?";
  check(findingsFor(q, "SELECT ori, city FROM agencies WHERE state = 'IL'").some((f) => f.ruleId === AGENCY_ONLY), `${AGENCY_ONLY} fires on agencies-only SQL (unchanged)`);
  const base = findingsFor(q, "SELECT a.city, COUNT(*) FROM agencies a JOIN summary_victim_demographics d ON d.ori = a.ori GROUP BY a.city");
  const rolled = findingsFor(q, "SELECT COUNT(*) FROM agencies a JOIN rollup.state_summary_victim_demographics d ON 1 = 1");
  check(!base.some((f) => f.ruleId === AGENCY_ONLY) && !rolled.some((f) => f.ruleId === AGENCY_ONLY), `${AGENCY_ONLY} does not fire when a source table or its rollup is read`);
}

console.log("\n3 - the unsafe counterparts stay refused");
{
  const q = "How many rapes were cleared by arrest in Illinois in 2025?";
  const wrong = findingsFor(q, "SELECT SUM(offense_count) FROM summary_state_monthly WHERE state = 'IL' AND year = 2025");
  check(wrong.some((f) => f.ruleId === "nibrs-clearance-type-table"), "an ordinary offense-count table used for a clearance count is still a clearance-table finding");
  const fake = findingsFor(q, "SELECT SUM(offense_count) FROM rollup.state_summary_state_monthly WHERE state = 'IL' AND year = 2025");
  check(fake.some((f) => f.ruleId === "nibrs-clearance-type-table"), "a rollup of a non-rollup-source table does not satisfy the clearance family");
  const legit = findingsFor(q, "SELECT SUM(cleared_by_arrest) FROM rollup.state_summary_clearance_detail WHERE state = 'IL' AND year = 2025 AND ucr_offense_code = '11A'");
  check(!legit.some((f) => f.ruleId === "nibrs-clearance-type-table"), "the planner's state clearance rollup satisfies the clearance family");
  const weaponQ = "How many murder victims were killed with a firearm in Florida in 2024?";
  const forbidden = findingsFor(weaponQ, "SELECT COUNT(*) FROM rollup.state_summary_victim_demographics WHERE state = 'FL'");
  const forbiddenBase = findingsFor(weaponQ, "SELECT COUNT(*) FROM summary_victim_demographics WHERE state = 'FL'");
  check(ids(forbidden) === ids(forbiddenBase) && forbidden.length > 0, "a forbidden family is forbidden in its rollup form too");
  // Forbidding only decides the outcome once the REQUIRED family is present, so it is tested with the
  // required table beside the forbidden one; alone, the missing requirement would fire either way.
  const requiredPlusForbidden = findingsFor(weaponQ, "SELECT COUNT(*) FROM summary_victim_weapon w JOIN summary_victim_demographics d ON 1 = 1 WHERE w.state = 'FL'");
  const requiredPlusRollupForbidden = findingsFor(weaponQ, "SELECT COUNT(*) FROM summary_victim_weapon w JOIN rollup.state_summary_victim_demographics d ON 1 = 1 WHERE w.state = 'FL'");
  const requiredOnly = findingsFor(weaponQ, "SELECT COUNT(*) FROM summary_victim_weapon w WHERE w.state = 'FL'");
  check(requiredPlusForbidden.some((f) => f.ruleId === "nibrs-weapon-person-crime-table")
    && requiredPlusRollupForbidden.some((f) => f.ruleId === "nibrs-weapon-person-crime-table")
    && !requiredOnly.some((f) => f.ruleId === "nibrs-weapon-person-crime-table"),
    "with the required weapon table present, the forbidden demographic family fires in its rollup form exactly as in its base form");
}

console.log("\n4 - reporting keeps the real rollup name");
{
  const f = findingsFor("How many murder victims were killed with a firearm in Florida in 2024?", "SELECT COUNT(*) FROM rollup.state_summary_victim_demographics WHERE state = 'FL'");
  check(f.some((x) => x.actualTables.includes("rollup.state_summary_victim_demographics")), "the finding's actualTables names rollup.state_summary_victim_demographics, not its source");
}

console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
