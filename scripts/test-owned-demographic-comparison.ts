/*
 * GC-084 — offender age-group counts for 2-5 named agencies, built by the application.
 *
 * The saved run stopped GC-084 before any model call: the NIBRS route refuses every multi-agency
 * request no application builder answers, because nothing can check which number belongs to which
 * agency. Codex's design ruling (2026-09-26) kept that refusal and authorized one bounded builder:
 * offender role, age group, counts, one offense family, 2-5 fully resolved agencies, one declared
 * column per agency. These checks hold it to that and to the three acceptance conditions:
 *   1. resolver bindings only, no name fallback, no pooling, declarations bound to executed SQL;
 *   2. offense/time scope and completeness kept, Unknown visible, a missing contribution stays
 *      missing, a recorded zero stays zero;
 *   3. the exact saved request selected by the planner and attributed end to end.
 * Everything outside the bound must still reach the unchanged refusal, and the single-agency path
 * must be untouched.
 *
 * Disposable in-memory fixture. Agency shapes are the real ones recorded in
 * scripts/test-agency-member-completeness.ts (POCOMOKE CITY is filed with the "City"). Counts are
 * synthetic and distinguishable; they are not the retained source observations.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import Database from "better-sqlite3";
import { buildQueryContract } from "../lib/query-contract";
import { resolveNibrsPlaces, type NibrsPlaceResolutionPlan } from "../lib/nibrs-place-resolver";
import { buildNibrsLocalDemographicQuery } from "../lib/nibrs-deterministic-queries";
import { planNibrsQuery } from "../lib/nibrs-query-planner";
import { isOwnedMultiAgencyRequest, ownedMemberDeclaration, memberCoverage, coverageTitle } from "../lib/agency-answer-ownership";
import { agencyFigureFailure, mapAgencyFigures } from "../lib/nibrs-member-figures";
import { applyResultDisclosures } from "../lib/result-disclosure";
import { runGuardrails } from "../lib/guardrails";
import { extractQueryContext } from "../lib/query-context";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const GC084 = "show me violent crimes by offender age for worcester county, md sheriff's office and pocomoke city, md police department";
const FIVE = "show me violent crime by offender age for worcester county, md sheriff's office, pocomoke city, md police department, salisbury, md police department, ocean city, md police department and berlin, md police department";
const SIX = FIVE.replace(" and berlin, md police department", ", berlin, md police department and snow hill, md police department");

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);
  CREATE TABLE agency_county_crosswalk (ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_key TEXT);
  CREATE TABLE summary_offender_demographics (ori TEXT, year INT, ucr_offense_code TEXT, weapon_category TEXT,
    race TEXT, sex TEXT, age_group TEXT, ethnicity TEXT, offender_count INTEGER, state TEXT);
  CREATE INDEX idx_sod_new_ori_year ON summary_offender_demographics(ori, year);
  CREATE TABLE nibrs_agency_completeness (ori TEXT, year INT, months_reported, total_offenses);
  CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year, months_reported);
  INSERT INTO agency_county_crosswalk VALUES ('MD02400', 'MD0240000', 'WORCESTER COUNTY SHERIFFS OFFICE', 'MD', 'WORCESTER');
`);
const agency = db.prepare("INSERT INTO agencies VALUES (?,?,?,?,?,?,?)");
// MD0240000 and MD0240300 as filed; the MD999xxxx agencies are SYNTHETIC, for the five- and six-member controls.
const AGENCIES: [string, string, string, number][] = [
  ["MD0240000", "SNOW HILL", "County", 24079], ["MD0240300", "POCOMOKE CITY", "City", 4456],
  ["MD9990100", "SALISBURY", "City", 33000], ["MD9990200", "OCEAN CITY", "City", 7000],
  ["MD9990300", "BERLIN", "City", 5000], ["MD9990400", "SNOW HILL", "City", 2000],
];
for (let year = 2013; year <= 2026; year++) for (const [ori, city, type, pop] of AGENCIES) agency.run(ori, year, "MD", city, type, pop, "6");
const sod = db.prepare("INSERT INTO summary_offender_demographics (ori, year, ucr_offense_code, age_group, offender_count, state) VALUES (?,?,?,?,?,'MD')");
const complete = db.prepare("INSERT INTO nibrs_agency_completeness VALUES (?,?,?,50)");
// Worcester: complete 2022-2025; 2021 incomplete (11 months) and must be excluded.
for (const year of [2021, 2022, 2023, 2024, 2025]) {
  sod.run("MD0240000", year, "13A", "25-34", 3);
  sod.run("MD0240000", year, "120", "Unknown", 1);
  if (year >= 2022) sod.run("MD0240000", year, "09A", "65+", 1);
  complete.run("MD0240000", year, year === 2021 ? 11 : 12);
}
// Pocomoke: complete 2023-2025; '45-54' is a RECORDED zero; a non-violent decoy (23C) must never count.
for (const year of [2023, 2024, 2025]) {
  sod.run("MD0240300", year, "13A", "25-34", 5);
  sod.run("MD0240300", year, "11A", "Unknown", 2);
  sod.run("MD0240300", year, "13A", "45-54", 0);
  complete.run("MD0240300", year, 12);
}
sod.run("MD0240300", 2024, "23C", "25-34", 900);
for (const [ori, count] of [["MD9990100", 7], ["MD9990200", 11], ["MD9990300", 13], ["MD9990400", 17]] as [string, number][]) {
  for (const year of [2023, 2024, 2025]) { sod.run(ori, year, "13A", "18-24", count); complete.run(ori, year, 12); }
}

const planFor = (q: string) => resolveNibrsPlaces(db, q, buildQueryContract(q, "nibrs"));
const run = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
const cell = (rows: Record<string, unknown>[], age: string, column: string) => rows.find((row) => row.age_group === age)?.[column];

console.log("\n1 - the exact saved GC-084 request is planned, built and attributed");
const plan84 = planFor(GC084);
const q84 = buildNibrsLocalDemographicQuery(GC084, plan84);
{
  check(buildQueryContract(GC084, "nibrs")?.metric.offenses[0]?.label === "Violent crime",
    "the plural 'violent crimes' now names the violent-crime family (it named no offense before)");
  check(plan84?.places.length === 2 && plan84.places.every((place) => place.status === "resolved"), "both named agencies resolve");
  const planned = planNibrsQuery(GC084, plan84, { allowDeterministic: true, dataCutoff: null });
  check(planned.kind === "deterministic" && "query" in planned && planned.query.guardrail === "deterministic-nibrs-local-demographic-count",
    "the planner selects the application-built answer, so the ownership refusal is not reached");
  check(Boolean(q84) && q84!.memberColumns?.length === 2 && q84!.memberColumns.map((m) => m.contractIndex).join() === "0,1",
    "one declared count column per agency, keyed by contract index");
  const declared = ownedMemberDeclaration(q84, q84!.sql);
  check(declared !== null, "the declaration binds to the statement that will run");
  check(ownedMemberDeclaration(q84, q84!.sql + " ") === null, "and not to any other statement");
  const rows = run(q84!.sql);
  const columns = Object.keys(rows[0] ?? {});
  const [w, p] = q84!.memberColumns!.map((m) => m.column);
  check(w === "worcester_county_sheriffs_office_offenders" && p === "pocomoke_city_police_department_offenders",
    `columns read back as the agencies (${w}, ${p})`);
  check(cell(rows, "25-34", w) === 12 && cell(rows, "25-34", p) === 15, "25-34: Worcester 12 (2022-2025 only), Pocomoke 15");
  check(cell(rows, "45-54", w) === null && cell(rows, "65+", p) === null, "a missing contribution stays NULL, never a fabricated 0");
  check(cell(rows, "45-54", p) === 0, "a recorded zero stays 0");
  check(cell(rows, "Unknown", w) === 4 && cell(rows, "Unknown", p) === 6, "Unknown stays visible");
  check(!JSON.stringify(rows).includes("900"), "the non-violent decoy is not counted");
  check(agencyFigureFailure(plan84, columns, rows, declared) === null, "the route's membership gate finds every agency attributed");
  const mapping = mapAgencyFigures(plan84, columns, rows, declared);
  const coverage = memberCoverage(plan84, mapping);
  check(coverage.length === 2 && coverage.every((entry) => entry.state === "figures"), "both members carry figures");
  check(coverageTitle(q84!.title, coverage) === q84!.title && /Worcester County sheriff's office and Pocomoke City police department$/.test(q84!.title),
    "a complete answer keeps its title, which names both agencies");
  check(/recorded offender counts, not incidents and not unique people/.test(q84!.explanation)
    && /blank cell is a missing contribution/.test(q84!.explanation)
    && /agencies can cover different years/.test(q84!.explanation),
    "the prose says what the counts are, what a blank means, and that periods can differ");
  check(!/\bzero\b/i.test(q84!.explanation), "and avoids wording the empty-state governor would strip");
}

console.log("\n2 - five agencies are attributed; six are outside the bound");
{
  const plan5 = planFor(FIVE);
  const q5 = buildNibrsLocalDemographicQuery(FIVE, plan5);
  check(q5?.memberColumns?.length === 5, "five resolved agencies get five declared columns");
  const rows = run(q5!.sql);
  const cols = q5!.memberColumns!.map((m) => m.column);
  const eighteen = rows.find((row) => row.age_group === "18-24")!;
  check(eighteen[cols[2]] === 21 && eighteen[cols[3]] === 33 && eighteen[cols[4]] === 39 && eighteen[cols[0]] === null && eighteen[cols[1]] === null,
    "each value sits in its own agency's column; the others stay NULL");
  check(agencyFigureFailure(plan5, Object.keys(rows[0]), rows, ownedMemberDeclaration(q5, q5!.sql)) === null, "membership gate passes at five");
  const plan6 = planFor(SIX);
  check((plan6?.places.length ?? 0) === 6, "six agencies resolve");
  check(buildNibrsLocalDemographicQuery(SIX, plan6) === null, "six is over the limit: no application-built answer");
  check(isOwnedMultiAgencyRequest(plan6), "so the unchanged ownership refusal applies");
}

console.log("\n3 - everything outside the bound still reaches the refusal");
{
  const outside: [string, string][] = [
    ["share", "share of violent crime offenders by age for worcester county, md sheriff's office and pocomoke city, md police department"],
    ["race", "violent crime offenders by race for worcester county, md sheriff's office and pocomoke city, md police department"],
    ["victims", "violent crime victims by age for worcester county, md sheriff's office and pocomoke city, md police department"],
    ["arrestees", "violent crime arrests by age for worcester county, md sheriff's office and pocomoke city, md police department"],
    ["annual", "violent crime offenders by age by year for worcester county, md sheriff's office and pocomoke city, md police department"],
    ["weapon", "violent crime offenders by age involving a firearm for worcester county, md sheriff's office and pocomoke city, md police department"],
  ];
  for (const [what, q] of outside) {
    const plan = planFor(q);
    check(buildNibrsLocalDemographicQuery(q, plan) === null && isOwnedMultiAgencyRequest(plan), `${what}: no builder answer; refusal applies`);
  }
  const unresolved = "violent crime offenders by age for worcester county, md sheriff's office and atlantis, md police department";
  const planU = planFor(unresolved);
  check(planU?.places.some((place) => place.status !== "resolved") === true, "an unknown agency does not resolve");
  check(buildNibrsLocalDemographicQuery(unresolved, planU) === null, "an unresolved member: no builder answer (no name-based fallback)");
}

console.log("\n4 - attribution cannot be borrowed: no fallback, no pooling");
{
  // The resolver's binding removed from one member: the builder must not fall back to guessing from its name.
  const stripped: NibrsPlaceResolutionPlan = { ...plan84!, places: plan84!.places.map((place, i) => i === 1 ? { ...place, status: "not_in_source" as const } : place) };
  check(buildNibrsLocalDemographicQuery(GC084, stripped) === null, "a member without its resolver binding is not rebuilt from its name");
  // Both members bound to the same ORI in the same year would pool one agency's figures under two names.
  const pooled: NibrsPlaceResolutionPlan = { ...plan84!, places: plan84!.places.map((place, i) => i === 1 ? { ...place, oriYears: plan84!.places[0].oriYears } : place) };
  check(buildNibrsLocalDemographicQuery(GC084, pooled) === null, "two members sharing an ORI-year are refused, not pooled");
  check(buildNibrsLocalDemographicQuery(GC084, null) === null, "no resolution plan, no multi-agency answer");
}

console.log("\n5 - the single-agency builder is unchanged");
{
  const single = "show me violent crime by offender age for pocomoke city, md police department";
  const q = buildNibrsLocalDemographicQuery(single, planFor(single));
  check(Boolean(q) && q!.memberColumns === undefined && /^NIBRS violent crime offenders by age group in /.test(q!.title),
    "a single agency keeps the single-agency answer (no member columns, its own title)");
  const rows = run(q!.sql);
  check(rows.length === 3 && rows.some((row) => row.age_group === "25-34" && row.offenders === 15), "and its figures");
  const share = "share of violent crime offenders by age for pocomoke city, md police department";
  check(buildNibrsLocalDemographicQuery(share, planFor(share))?.guardrail === "deterministic-nibrs-local-demographic-share", "single-agency shares still build");
}

console.log("\n6 - correction C3: partial current-year counts are not described as complete years");
{
  // Codex's counterexample (codex-review-witness.ts): both agencies report ONE month this year, 17 offenders each.
  const now = new Date().getFullYear();
  for (const ori of ["MD0240000", "MD0240300"]) { sod.run(ori, now, "13A", "25-34", 17); complete.run(ori, now, 1); }
  const q = GC084 + " in " + now;
  const built = buildNibrsLocalDemographicQuery(q, planFor(q));
  const rows = run(built!.sql);
  check(rows.length > 0 && rows.every((row) => Object.values(row).filter((v) => v === 17).length === 2),
    "the completeness policy is unchanged: current-year counts stay visible (17 and 17)");
  const final = applyResultDisclosures({ question: q, sql: built!.sql, tab: "nibrs", rows, explanation: built!.explanation });
  check(!/only the years it reported all 12 months/.test(final) && !/each agency contributes only/i.test(final),
    "the delivered prose no longer claims every counted year is a complete 12-month year");
  check(new RegExp(`if the period includes ${now}, its counts are partial-year counts`).test(final),
    "it says the current year's counts are partial");
  check(/Past years are counted only when the agency reported all 12 months/.test(final) && /agencies can cover different years/.test(final),
    "and keeps the complete-past-year rule and the different-periods warning");
}

console.log("\n7 - correction C2: plural and singular violent crime get the same guard and definition");
{
  // Codex's counterexample: simple assault (13B) in, robbery (120) out.
  const driftSql = "SELECT SUM(offender_count) AS offenders FROM summary_offender_demographics WHERE ucr_offense_code IN ('09A', '11A', '11B', '11C', '13A', '13B')";
  const validSql = "SELECT SUM(offender_count) AS offenders FROM summary_offender_demographics WHERE ucr_offense_code IN ('09A', '11A', '11B', '11C', '120', '13A')";
  const forms = ["violent crime", "violent crimes"].map((word) => {
    const question = "Show " + word + " by offender age nationally";
    return {
      word,
      drift: runGuardrails(extractQueryContext(driftSql, question, "nibrs")).fired.includes("nibrs-offense-category-drift"),
      valid: runGuardrails(extractQueryContext(validSql, question, "nibrs")).fired.includes("nibrs-offense-category-drift"),
      definition: /Definition: NIBRS violent crime is reported here using the UCR-aligned set/.test(
        applyResultDisclosures({ question, sql: validSql, tab: "nibrs", rows: [{ offenders: 17 }], explanation: "Recorded offender counts." })),
    };
  });
  for (const form of forms) {
    check(form.drift, `"${form.word}": the unsafe code set (13B in, 120 out) fires the category-drift guard`);
    check(!form.valid, `"${form.word}": the UCR-aligned set does not`);
    check(form.definition, `"${form.word}": the delivered answer carries the violent-crime definition`);
  }
  const alternative = "Show violent crimes including simple assault by offender age nationally";
  check(!runGuardrails(extractQueryContext(driftSql, alternative, "nibrs")).fired.includes("nibrs-offense-category-drift"),
    "the explicit alternative-taxonomy exception still applies to the plural");
  check(buildQueryContract(GC084, "nibrs")?.metric.offenses[0]?.codes.join(",") === "09A,11A,11B,11C,120,13A",
    "and the contract's violent-crime code set is the same one the guard enforces");
}

console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
