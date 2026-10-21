/*
 * GC-080 — a county on the Homicide Reports tab means the sheriff agency; "homicides" means all
 * homicide victims (Jeff's ruling, 2026-09-26; Codex design ruling, same day).
 *
 * Held here:
 *   1. the county request: which county, which state, which scope ("countywide" only when asked);
 *   2. SHERIFF IDENTITY IS READ, NOT INFERRED: an explicit sheriff designation in the recorded
 *      agency name plus the crosswalk's county/state link -- County type alone is not a sheriff;
 *      a sheriff plus a county police department uses the sheriff; two sheriffs ask; none is an
 *      owned limitation, never a countywide substitute;
 *   3. the ORI scope is enforced on the statement that executes (crosswalk joins, unrestricted
 *      incidents, foreign ORIs, outer-join "restrictions" and unrestricted CTEs are refused);
 *   4. the REQUEST selects the victim licence: murder keeps the accepted Murder restriction;
 *      homicide refuses a homicide-type restriction, an incident count and an extra joined table;
 *   5. the validator the route calls at every boundary, including execution, carries both;
 *   6. placement in the route, the prompt and the two retired guardrail retries.
 * Delivered answers through the real route: audit/phase3-gc080-2026-09-26/delivery-witness.cjs.
 * Disposable in-memory fixtures; agencies other than AL00500 are SYNTHETIC.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { shrCountyRequest, resolveShrCountyScope, shrScopeViolation, withShrScopeAndMeasureDisclosures, allHomicideTitle, type ShrScopeBinding } from "../lib/shr-county-scope";
import { shrRequestedMeasure, proveShrVictimLicence, proveShrMurderLicence } from "../lib/shr-murder-licence";
import { validateModelAuthoredShrSql } from "../lib/shr-authority";
import { runGuardrails } from "../lib/guardrails";
import { extractQueryContext } from "../lib/query-context";
import { getShrSystemPrompt } from "../lib/shr-claude";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const GC080 = "number of homicides in baldwin county al in 2025";

console.log("\n1 - the county request");
{
  const r = shrCountyRequest(GC080);
  check(r?.countyKey === "BALDWIN" && r.state === "AL" && r.scope === "sheriff", "GC-080: Baldwin, AL (lowercase state after the county word), sheriff scope");
  check(shrCountyRequest("number of homicides across all agencies in baldwin county al in 2025")?.scope === "countywide", "\"all agencies in\" asks for the countywide total");
  check(shrCountyRequest("countywide homicides in Cook County IL")?.scope === "countywide", "\"countywide\" asks for the countywide total");
  check(shrCountyRequest("number of murders for Metro County Police Department, AL in 2025") === null, "an explicitly named county police department is not a county request");
  for (const q of ["fatal shootings by county in Illinois", "homicides in each county in Texas", "which county had the most murders"]) {
    check(shrCountyRequest(q) === null, `no county named: "${q}"`);
  }
  check(shrCountyRequest("murders in St. Louis County, MO")?.countyDisplay === "St. Louis", "multi-word names read back to the preposition");
}

console.log("\n2 - sheriff identity is read, never inferred");
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE agency_county_crosswalk (ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_fips TEXT, county_key TEXT);
  CREATE TABLE shr_agency_identity (ori TEXT, state TEXT, canonical_agency TEXT, agency_type TEXT, source_agency_names TEXT, first_year INTEGER, last_year INTEGER);
  INSERT INTO agency_county_crosswalk VALUES
    ('AL00500','AL0050000','BALDWIN COUNTY SHERIFFS OFFICE','AL','01003','BALDWIN'),
    ('AL00201','AL0020100','BAY MINETTE PD','AL','01003','BALDWIN'),
    ('GA00500','GA0050000','BALDWIN COUNTY SHERIFFS OFFICE','GA','13009','BALDWIN'),
    ('AL99100','AL9910000','METRO COUNTY SHERIFFS OFFICE','AL','01901','METRO'),
    ('AL99101','AL9910100','METRO COUNTY POLICE DEPARTMENT','AL','01901','METRO'),
    ('AL99200','AL9920000','PLAIN COUNTY','AL','01902','PLAIN'),
    ('AL99300','AL9930000','TWIN COUNTY SHERIFFS OFFICE','AL','01903','TWIN'),
    ('AL99301','AL9930100','TWIN COUNTY SHERIFF DEPT','AL','01903','TWIN'),
    ('AL99400','AL9940000','LONE COUNTY SHERIFFS OFFICE','AL','01904','LONE');
  INSERT INTO shr_agency_identity VALUES
    ('AL00500','AL','Baldwin County Sheriff''s Office','County','["BALDWIN COUNTY SHERIFFS OFFICE"]',1990,2025),
    ('AL0020100','AL','Bay Minette Police Department','City','["Bay Minette PD"]',1990,2025),
    ('AL99100','AL','Metro County Sheriff''s Office','County','["METRO CO SO"]',1990,2025),
    ('AL99101','AL','Metro County Police Department','County','["METRO COUNTY POL DEP"]',1990,2025),
    ('AL99200','AL','Plain County','County','["PLAIN COUNTY"]',1990,2025),
    ('AL99300','AL','Twin County Sheriff''s Office','County','["TWIN COUNTY SO"]',1990,2025),
    ('AL99301','AL','Twin County Sheriff Department','County','["TWIN COUNTY SHERIFF DEPT"]',1990,2025);
`);
const resolve = (q: string) => resolveShrCountyScope(db, shrCountyRequest(q)!);
{
  const r = resolve(GC080);
  check(r.status === "resolved" && r.binding.kind === "sheriff" && r.binding.oris.join() === "AL00500" && /Sheriff's Office/.test(r.binding.label),
    "Baldwin, AL resolves to its sheriff (AL00500) from the recorded sheriff name");
  const metro = resolve("number of homicides in metro county al in 2025");
  check(metro.status === "resolved" && metro.binding.oris.join() === "AL99100", "sheriff + county police department: the sheriff, no question asked");
  const plain = resolve("number of homicides in plain county al in 2025");
  check(plain.status === "unavailable" && /can't identify Plain County, AL's sheriff's agency/.test((plain as { explanation: string }).explanation)
    && /not going to answer with a countywide total/.test((plain as { explanation: string }).explanation),
    "a County agency with no sheriff designation is NOT a sheriff: owned limitation, no countywide substitute");
  const twin = resolve("number of homicides in twin county al in 2025");
  check(twin.status === "clarify" && /Which one do you mean\?/.test((twin as { explanation: string }).explanation), "two sheriff-designated agencies: ask which");
  const lone = resolve("number of homicides in lone county al in 2025");
  check(lone.status === "unavailable" && /no homicide reports in this database/.test((lone as { explanation: string }).explanation), "a sheriff with no SHR identity: owned limitation, no substitute");
  const noState = resolveShrCountyScope(db, { ...shrCountyRequest(GC080)!, state: null });
  check(noState.status === "clarify" && /more than one state/.test((noState as { explanation: string }).explanation), "a county in two states with no state named: ask which state");
  const wide = resolve("number of homicides across all agencies in baldwin county al in 2025");
  check(wide.status === "resolved" && wide.binding.kind === "countywide" && wide.binding.oris.slice().sort().join() === "AL0020100,AL00500",
    "explicit countywide: every mapped Baldwin agency with SHR records, bound as ORIs");
}

console.log("\n3 - the scope is enforced on the statement that executes");
const sheriff: ShrScopeBinding = (resolve(GC080) as { binding: ShrScopeBinding }).binding;
{
  const ok = "SELECT COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.ori IN ('AL00500') AND i.year = 2025";
  check(shrScopeViolation(ok, sheriff) === null, "restricted to the sheriff ORI: accepted");
  check(shrScopeViolation("SELECT COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.ori = 'AL00500'", sheriff) === null, "an = restriction is accepted too");
  const saved = "SELECT COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id JOIN agency_county_crosswalk ac ON (i.ori = ac.ori OR substr(i.ori, 1, 7) = ac.ori) WHERE ac.state = 'AL' AND ac.county_key = 'BALDWIN' AND i.year = 2025 AND i.homicide_type = 'Murder' LIMIT 1000";
  check(/crosswalk/.test(shrScopeViolation(saved, sheriff) ?? ""), "the saved countywide statement: refused (crosswalk)");
  check(/not restricted/.test(shrScopeViolation("SELECT COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.year = 2025", sheriff) ?? ""), "no ORI restriction: refused");
  check(/outside the resolved scope/.test(shrScopeViolation("SELECT COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.ori IN ('AL00500','AL0020100')", sheriff) ?? ""), "a municipal ORI added: refused");
  check(shrScopeViolation("SELECT COUNT(*) FROM victims v LEFT JOIN incidents i ON i.id = v.incident_id AND i.ori = 'AL00500'", sheriff) !== null, "an ORI condition inside an OUTER join restricts nothing: refused");
  check(shrScopeViolation("WITH x AS (SELECT id FROM incidents WHERE year = 2025) SELECT COUNT(*) FROM x JOIN victims v ON v.incident_id = x.id", sheriff) !== null, "a CTE reading incidents without the ORI restriction: refused");
  // G80-2: the restriction binds to the instance, and the complete bound set must be kept.
  check(/more than once/.test(shrScopeViolation("SELECT COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id CROSS JOIN incidents j WHERE j.ori='AL00500' AND i.year=2025 AND j.year=2025", sheriff) ?? ""),
    "restricting a second incidents copy does not scope the counted one: refused (Codex saw 3,429 delivered)");
  const county: ShrScopeBinding = (resolve("number of homicides across all agencies in baldwin county al in 2025") as { binding: ShrScopeBinding }).binding;
  check(/keeps 1 of the 2 agencies/.test(shrScopeViolation("SELECT COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.ori = 'AL00500'", county) ?? ""),
    "a countywide request narrowed to the sheriff: refused, not delivered as the county");
  check(shrScopeViolation(`SELECT COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.ori IN (${county.oris.map((o) => `'${o}'`).join(", ")})`, county) === null,
    "the complete countywide set: accepted");
}

console.log("\n4 - the request selects the victim licence");
{
  check(shrRequestedMeasure(GC080) === "homicide", "\"homicides\" -> all homicide victims");
  check(shrRequestedMeasure("number of murders in baldwin county al") === "murder", "\"murders\" -> murder victims");
  check(shrRequestedMeasure("homicide incidents in baldwin county") === "homicide_incident", "\"homicide incidents\" -> incidents, a distinct unit");
  // G80-3: the affirmative request decides; competing measures ask instead of guessing.
  check(shrRequestedMeasure("murders and homicides in 2025") === "conflict", "both measures asked for: conflict (an owned question), never a guess");
  check(shrRequestedMeasure("number of all homicides including murders and negligent manslaughter in baldwin county al in 2025") === "homicide",
    "an inclusion clause naming murders does not replace all homicides");
  check(shrRequestedMeasure("number of homicides, not incidents, in baldwin county al in 2025") === "homicide", "\"homicides, not incidents\": homicide victims");
  check(shrRequestedMeasure("homicides excluding murders in 2025") === "conflict", "an excluded homicide type: conflict, not a silent subset");
  check(shrRequestedMeasure("murders, not all homicides, in 2025") === "murder", "\"murders, not all homicides\": murder");
  check(shrRequestedMeasure("fatal shootings in baldwin county") === "murder", "neither word (e.g. \"shootings\"): the existing murder default");
  const all = "SELECT COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.ori IN ('AL00500') AND i.year = 2025";
  const murder = all + " AND i.homicide_type = 'Murder'";
  check(proveShrVictimLicence(all, "homicide").proved, "homicide licence: an unrestricted victim count through the incident key is proved");
  check(!proveShrVictimLicence(murder, "homicide").proved, "homicide licence: a Murder-only restriction is refused (wrong answer to an all-homicide question)");
  check(!proveShrVictimLicence("SELECT COUNT(*) AS homicides FROM incidents i WHERE i.year = 2025", "homicide").proved, "homicide licence: an incident count is not a victim count");
  check(!proveShrVictimLicence("SELECT COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id JOIN shr_agency_alias a ON a.ori = i.ori WHERE i.year = 2025", "homicide").proved,
    "homicide licence: a victim count through an extra joined table is refused (it can repeat victims)");
  check(!proveShrVictimLicence("SELECT COUNT(*) FROM incidents i, victims v WHERE i.year = 2025", "homicide").proved, "homicide licence: no incident-key join, refused");
  check(proveShrVictimLicence("SELECT COUNT(*) AS homicides FROM incidents i WHERE i.year = 2025", "homicide_incident").proved, "homicide incidents: an incident count is the requested unit");
  check(proveShrMurderLicence(murder).proved && !proveShrMurderLicence(all).proved, "the accepted murder licence is unchanged: Murder-restricted proved, unrestricted refused");
  // G80-1: Codex's retained shapes, proved at the returned expression and the counted instances.
  const j = "FROM incidents i JOIN victims v ON v.incident_id=i.id"; const f = "WHERE i.ori='AL00500' AND i.year=2025";
  const refusedShapes: [string, string, "homicide" | "homicide_incident"][] = [
    ["a second victims instance (delivered 6)", `SELECT COUNT(*) AS victims ${j} JOIN victims v2 ON v2.incident_id=i.id ${f}`, "homicide"],
    ["a cross-joined CTE of victim ids (delivered 16)", `WITH x AS (SELECT id FROM victims WHERE incident_id IN (900001,900002,900003)) SELECT COUNT(*) AS victims ${j} CROSS JOIN x ${f}`, "homicide"],
    ["COUNT(CASE WHEN homicide_type = 'Murder' ...) (delivered 3)", `SELECT COUNT(CASE WHEN i.homicide_type='Murder' THEN v.id END) AS victims ${j} ${f}`, "homicide"],
    ["COUNT(DISTINCT v.incident_id) labelled victims (delivered 3)", `SELECT COUNT(DISTINCT v.incident_id) AS victims ${j} ${f}`, "homicide"],
    ["a victim COUNT(*) answering an incident request (delivered 4)", `SELECT COUNT(*) AS homicides ${j} ${f}`, "homicide_incident"],
    ["a second incidents instance (delivered 3,429)", `SELECT COUNT(*) AS victims ${j} CROSS JOIN incidents j WHERE j.ori='AL00500' AND i.year=2025 AND j.year=2025`, "homicide"],
    ["SUM(CASE WHEN homicide_type ...)", `SELECT SUM(CASE WHEN i.homicide_type='Murder' THEN 1 ELSE 0 END) AS victims ${j} ${f}`, "homicide"],
    ["a windowed count", `SELECT COUNT(*) OVER () AS victims ${j} ${f}`, "homicide"],
  ];
  for (const [what, sql, m] of refusedShapes) check(!proveShrVictimLicence(sql, m).proved, `refused: ${what}`);
  check(proveShrVictimLicence(`SELECT i.year, COUNT(v.id) AS victims ${j} ${f} GROUP BY i.year`, "homicide").proved, "COUNT(v.id) by year over the keyed pair: proved");
  check(proveShrVictimLicence(`SELECT COUNT(DISTINCT i.id) AS homicides ${j} ${f}`, "homicide_incident").proved, "COUNT(DISTINCT i.id) over the keyed pair answers an incident request");
  check(!proveShrVictimLicence(`SELECT COUNT(*) AS victims ${j} ${f}`, "conflict").proved, "a conflicting request never gets a licence");
}

console.log("\n5 - the validator the route calls at every boundary, including execution");
{
  const saved = "SELECT COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id JOIN agency_county_crosswalk ac ON (i.ori = ac.ori OR substr(i.ori, 1, 7) = ac.ori) WHERE ac.state = 'AL' AND ac.county_key = 'BALDWIN' AND i.year = 2025 AND i.homicide_type = 'Murder' LIMIT 1000";
  const v = validateModelAuthoredShrSql({ question: GC080, sql: saved, scope: sheriff });
  check(v.blockReasons.length >= 2 && v.enforced.includes("shr-county-scope-violation") && v.licenceRefusal !== null,
    "the saved GC-080 statement is blocked twice over: wrong scope AND wrong measure");
  const good = validateModelAuthoredShrSql({ question: GC080, sql: "SELECT COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.ori IN ('AL00500') AND i.year = 2025", scope: sheriff });
  check(good.licenceRefusal === null && !good.enforced.includes("shr-county-scope-violation"), "the sheriff all-homicide statement passes both");
  const noScope = validateModelAuthoredShrSql({ question: "number of murders in Pennsylvania in 2025", sql: "SELECT COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'PA' AND i.homicide_type = 'Murder'" });
  check(noScope.licenceRefusal === null && !noScope.enforced.includes("shr-county-scope-violation"), "no county bound: the scope check does not engage");
}

console.log("\n6 - delivery wording");
{
  const text = withShrScopeAndMeasureDisclosures("Count.", sheriff, true);
  check(/These figures are for Baldwin County Sheriff's Office, AL — the county sheriff's agency/.test(text) && /They don't include the city police departments/.test(text),
    "the sheriff answer plainly names the agency and rules out the county's other agencies");
  check(/These are all homicide victims: murder and nonnegligent manslaughter, plus negligent manslaughter\./.test(text), "the all-homicide answer says negligent manslaughter is included");
  check(withShrScopeAndMeasureDisclosures(text, sheriff, true) === text, "applied once");
  check(allHomicideTitle("Murder Victims in Baldwin County, 2025") === "Homicide Victims in Baldwin County, 2025", "an all-homicide title never says \"Murder\"");
}

console.log("\n7 - placement in the route, the prompt and the retired retries");
{
  const route = readFileSync("app/api/shr-query/route.ts", "utf8");
  check((route.match(/scope: shrCountyScope,/g) ?? []).length === 2, "both validators (model-authored and deterministic) receive the bound scope");
  check(route.indexOf("const executionContract = runModelAuthoredValidation(sql);") > 0 && route.indexOf("const correctedContract = runModelAuthoredValidation(sql);") > 0,
    "the execution-boundary and schema-corrected re-proofs go through the scope-carrying validator");
  // Owned count (reassessment ruling): the conflict question precedes every builder; the owned gate
  // precedes the cache and the model; the model path no longer binds or receives a county scope.
  const conflictAt = route.indexOf("if (shrRequestedMeasure(guardrailQuestion) === \"conflict\") {");
  // Request accounting (plan r2.1): the owned count also requires that nothing restricts which records are counted.
  const ownedGate = route.indexOf("if (shrOwnedCountFamily(guardrailQuestion) && !shrHasRowRestriction(requestLedger) && !unreadFall) {") // Option 2 stopgap: + !unreadFall;
  check(conflictAt > 0 && conflictAt < route.indexOf("const murderPlan = murderDb ? buildShrMurderPlan(question, murderDb) : null;")
    && ownedGate > route.indexOf("} else if (county) {") && ownedGate < route.indexOf("// Check response cache (only for standalone questions, not follow-ups)")
    && !route.includes("const modelCountyRequest = shrCountyRequest(guardrailQuestion);") && !route.includes("shrScopeGuidance("),
    "conflict before every builder; the owned count gate after shooting and before the cache and the model; no model-path county binding");
  const sheriffBranch = route.indexOf("if (countyRequest?.scope === \"sheriff\") {");
  check(sheriffBranch > 0 && sheriffBranch < route.indexOf("} else if (county) {"), "the built-in shooting path takes the sheriff branch before the countywide one");
  check(route.indexOf("explanation = withShrScopeAndMeasureDisclosures(explanation, shrCountyScope, allHomicides);") > route.indexOf("explanation = sanitizeExplanation(explanation);"),
    "the sheriff and all-homicide sentences are applied after the agency-name tidying and sanitizing");
  const prompt = getShrSystemPrompt();
  check(/A question about one named county is answered by the application itself/.test(prompt)
    && /"Homicide\(s\)" means ALL homicide victims, including negligent manslaughter; the application answers those requests itself/.test(prompt)
    && !/supplies its ORIs/.test(prompt) && !/homicides? means murders?/i.test(prompt),
    "the prompt matches the model's remaining capability: named counties and all-homicide requests are the application's, and homicides never means murders");
  const unfiltered = "SELECT i.year, COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.year = 2025 GROUP BY i.year";
  check(!runGuardrails(extractQueryContext(unfiltered, GC080, "shr")).fired.includes("shr-homicide-type-missing"), "the Murder-filter retry no longer fires for a homicide question");
  check(!runGuardrails(extractQueryContext(unfiltered, GC080, "shr")).fired.includes("countywide-crosswalk-required"), "the crosswalk retry no longer fires for a named SHR county");
}

console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
