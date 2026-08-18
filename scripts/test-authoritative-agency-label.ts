/**
 * The identity attached to a set of figures must come from the resolved record.
 *
 * The regression is verbatim from production. A user asked about Baltimore County, was asked
 * countywide-or-county-agency, answered "sheriff's office only", could not be answered because the
 * old data recorded both agencies under one name, and picked `MD0030100` by its ORI. The figures
 * came back correctly restricted to that agency, under the heading "Baltimore County Sheriff's
 * Office". `MD0030100` is the Baltimore County *Police Department*.
 *
 * The query selected only year and violent count, so no agency name was in the result set — which
 * is why this cannot be fixed by reading the rows.
 *
 * Three attempts to correct the name *in place* each produced a new defect, because the span of a
 * name in free prose cannot be discovered reliably. So the design changed: render the label from
 * the record, detect contradiction, and on contradiction replace the narrative rather than patch
 * it. These tests hold that line — in particular that no output ever contains two adjacent
 * identities, which is what the last attempt produced.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  applyAuthoritativeIdentity,
  authoritativeFallbackExplanation,
  lookupAuthoritativeAgency,
  narrativeContradictsRecord,
  renderAuthoritativeAgencyLabel,
  type AuthoritativeAgency,
} from "../lib/authoritative-agency-label";

let failures = 0;
let checks = 0;

function assert(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${message}`);
  }
}

/** The explanation production actually returned, from query log 8602. */
const PRODUCTION_EXPLANATION =
  "Annual violent crime counts for Baltimore County Sheriff's Office (ORI MD0030100) across all "
  + "available years. Some years may show no data if the agency did not report to the FBI for that period.";

const POLICE: AuthoritativeAgency = {
  ori: "MD0030100", agency: "Baltimore County Police Department", state: "md", type: "county",
};
const SHERIFF_SIDE: AuthoritativeAgency = {
  ori: "MD0030000", agency: "Baltimore County", state: "md", type: "county",
};

/** No answer may present two identities next to each other. */
function hasAdjacentDuplicateIdentity(text: string, record: AuthoritativeAgency): boolean {
  const name = record.agency.toLowerCase();
  const head = name.split(/\s+/).slice(0, 2).join(" ");
  const lowered = text.toLowerCase();
  // e.g. "baltimore county Baltimore County Police Department"
  const doubled = new RegExp(`${head}\\s+${head}`, "i");
  return doubled.test(lowered);
}

console.log("the production regression");
{
  assert(/Sheriff/i.test(PRODUCTION_EXPLANATION), "the recorded production explanation names a sheriff's office");
  const fixed = applyAuthoritativeIdentity(PRODUCTION_EXPLANATION, "Baltimore County Sheriff's Office", POLICE);
  assert(fixed.changed, "the correction fires on it");
  assert(!/sheriff/i.test(fixed.explanation), `no sheriff survives in the explanation (${fixed.explanation})`);
  assert(!/sheriff/i.test(fixed.title), `no sheriff survives in the title (${fixed.title})`);
  assert(fixed.explanation.includes("Baltimore County Police Department"), "the authoritative name is stated");
  assert(fixed.explanation.includes("MD0030100"), "the ORI is stated");
  assert(!fixed.explanation.includes("MD0030000"), "the other Baltimore agency is not introduced");
  console.log(`        explanation: ${fixed.explanation}`);
  console.log(`        title:       ${fixed.title}`);
}

console.log("\nlowercase and mixed-case wording never duplicates the identity");
for (const input of [
  "baltimore county sheriff's office reported 12 murders.",
  "The baltimore county sheriff's office reported 12 murders.",
  "Baltimore county Sheriff's Office reported 12 murders.",
  "BALTIMORE COUNTY SHERIFF'S OFFICE reported 12 murders.",
  "the baltimore county sheriff’s office reported 12 murders.",
  "Baltimore County Sheriff's Office reported 12 murders.",
]) {
  const fixed = applyAuthoritativeIdentity(input, "Results", POLICE);
  assert(!/sheriff/i.test(fixed.explanation), `no sheriff survives: ${JSON.stringify(input)} -> ${fixed.explanation}`);
  assert(!hasAdjacentDuplicateIdentity(fixed.explanation, POLICE),
    `no adjacent duplicate identity: ${JSON.stringify(input)} -> ${fixed.explanation}`);
  const occurrences = (fixed.explanation.match(/Baltimore County Police Department/gi) || []).length;
  assert(occurrences === 1, `the authoritative name appears exactly once (${occurrences}): ${fixed.explanation}`);
}

console.log("\nprose that says nothing contradictory is left alone");
for (const input of [
  "Violent crime fell 4% between 2023 and 2024.",
  "Annual violent crime counts across all available years. Some years may show no data.",
  "Baltimore County Police Department (ORI MD0030100) reported 12 murders.",
  "Rates for the selected agency fell in 2024.",
]) {
  const fixed = applyAuthoritativeIdentity(input, "Violent Crime by Year", POLICE);
  assert(fixed.explanation === input, `untouched: ${JSON.stringify(input)} -> ${JSON.stringify(fixed.explanation)}`);
  assert(fixed.title === "Violent Crime by Year", "a title that says nothing contradictory keeps its meaning");
  assert(!fixed.changed, "nothing is reported as changed");
}

console.log("\ndetection, rendering and the fallback");
{
  assert(narrativeContradictsRecord("the sheriff's office", POLICE).contradicts, "a sheriff claim contradicts a police department");
  assert(!narrativeContradictsRecord("the police department", POLICE).contradicts, "a police department claim does not");
  assert(narrativeContradictsRecord("the police department", SHERIFF_SIDE).contradicts,
    "a police department claim contradicts an agency simply named Baltimore County");
  assert(renderAuthoritativeAgencyLabel(POLICE) === "Baltimore County Police Department, MD",
    `the label is rendered from the record (${renderAuthoritativeAgencyLabel(POLICE)})`);
  const fallback = authoritativeFallbackExplanation(POLICE);
  assert((fallback.match(/Baltimore County Police Department/g) || []).length === 1,
    "the fallback names the agency exactly once");
  assert(!hasAdjacentDuplicateIdentity(fallback, POLICE), "the fallback cannot duplicate the identity");
  // The other agency takes its own name, never the neighbour's.
  const other = applyAuthoritativeIdentity("the police department reported 3 murders.", "Results", SHERIFF_SIDE);
  assert(other.explanation.includes("Baltimore County") && !other.explanation.includes("Police Department"),
    `the other ORI takes its own authoritative name (${other.explanation})`);
  assert(applyAuthoritativeIdentity("", "", POLICE).explanation === "", "empty text is handled");
  assert(applyAuthoritativeIdentity(null, null, POLICE).explanation === "", "null text is handled");
}

console.log("\nthe authoritative record comes from the database");
const dbPath = process.env.RTCI_DB_PATH || path.join(process.cwd(), "crime_data.db");
if (fs.existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true });
  const police = lookupAuthoritativeAgency(db, "MD0030100");
  const sheriffSide = lookupAuthoritativeAgency(db, "MD0030000");
  assert(!!police, "MD0030100 has an authoritative record");
  assert(!!sheriffSide, "MD0030000 has an authoritative record");

  // Asserting a particular string here would test which vintage this machine holds, not the
  // property: production separates the two agencies, a pre-swap copy calls both "Baltimore County".
  const separated = !!police && !!sheriffSide && police.agency !== sheriffSide.agency;
  console.log(`        MD0030100 = ${police?.agency} | MD0030000 = ${sheriffSide?.agency}`);
  console.log(`        this database ${separated ? "distinguishes" : "does NOT distinguish"} the two agencies`);
  if (separated) {
    assert(police!.agency === "Baltimore County Police Department",
      `on data that separates them, MD0030100 is the Police Department (got ${police!.agency})`);
  }

  assert(lookupAuthoritativeAgency(db, "ZZ9999999") === null,
    "an unknown ORI yields no label rather than an invented one");
  assert(lookupAuthoritativeAgency(db, null) === null, "no ORI yields no label");
  assert(lookupAuthoritativeAgency(null, "MD0030100") === null, "no database yields no label");

  if (police) {
    const fixed = applyAuthoritativeIdentity(PRODUCTION_EXPLANATION, "Results", police);
    assert(!/sheriff/i.test(fixed.explanation) && fixed.explanation.includes(police.agency),
      `the database-sourced label corrects the production sentence (${fixed.explanation})`);
    assert(!hasAdjacentDuplicateIdentity(fixed.explanation, police), "and does not duplicate it");
  }
  db.close();
} else {
  console.log(`        (skipped database checks: ${dbPath} not readable)`);
}

console.log(`\n${checks - failures}/${checks} authoritative label checks passed`);
if (failures > 0) {
  console.error(`${failures} authoritative label check(s) failed`);
  process.exit(1);
}
console.log("authoritative agency label tests passed");
