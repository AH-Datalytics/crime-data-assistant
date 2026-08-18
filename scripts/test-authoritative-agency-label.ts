/**
 * The identity attached to a set of figures must come from the resolved record.
 *
 * The regression this exists for is verbatim from production. A user asked about Baltimore
 * County, was asked countywide-or-county-agency, answered "sheriff's office only", could not be
 * answered because the old data recorded both agencies under one name, and picked `MD0030100`
 * by its ORI. The figures came back correctly restricted to that agency, under the heading
 * "Baltimore County Sheriff's Office". `MD0030100` is the Baltimore County *Police Department*.
 *
 * The query selected only year and violent count, so no agency name was in the result set at
 * all — which is why this cannot be fixed by reading the rows, and why the test below asserts
 * the correction holds when no name column exists.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  enforceAuthoritativeAgencyLabel,
  lookupAuthoritativeAgency,
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
  ori: "MD0030100",
  agency: "Baltimore County Police Department",
  state: "md",
  type: "county",
};
const SHERIFF_SIDE: AuthoritativeAgency = {
  ori: "MD0030000",
  agency: "Baltimore County",
  state: "md",
  type: "county",
};

console.log("the production regression");
{
  // Reproduction: untouched, the narrative names the wrong agency.
  assert(/Sheriff/i.test(PRODUCTION_EXPLANATION),
    "the recorded production explanation does call it a sheriff's office");

  const fixed = enforceAuthoritativeAgencyLabel(PRODUCTION_EXPLANATION, POLICE);
  assert(fixed.changed, "the correction fires on it");
  assert(/Baltimore County Police Department/.test(fixed.text),
    `it is named as the Police Department (${fixed.text.slice(0, 120)})`);
  assert(!/Sheriff/i.test(fixed.text),
    `the word Sheriff does not survive (${fixed.text.slice(0, 160)})`);
  assert(fixed.text.includes("(ORI MD0030100)"), "the ORI is still stated");
  assert(!fixed.text.includes("MD0030000"), "the other Baltimore agency is not introduced");
  // The rest of the sentence is left alone.
  assert(fixed.text.includes("Annual violent crime counts")
    && fixed.text.includes("did not report to the FBI"),
    "the surrounding prose is untouched");
  console.log(`        after: ${fixed.text.slice(0, 150)}`);
}

console.log("\nwording cannot override the resolved identity");
for (const [label, text] of [
  ["a bare role phrase", "The sheriff's office reported 12 murders in 2024."],
  ["a named role phrase", "Baltimore County Sheriff's Office reported 12 murders in 2024."],
  ["a possessive with a curly apostrophe", "The Baltimore County Sheriff’s Office reported 12 murders."],
  ["the role without the possessive", "The county sheriff reported 12 murders in 2024."],
] as const) {
  const fixed = enforceAuthoritativeAgencyLabel(text, POLICE);
  assert(!/sheriff/i.test(fixed.text), `${label}: no sheriff survives (${fixed.text})`);
  assert(fixed.text.includes("Baltimore County Police Department"),
    `${label}: the authoritative name appears (${fixed.text})`);
}

console.log("\nwhat it must not do");
{
  // The agency really is a police department: leave it alone.
  const kept = enforceAuthoritativeAgencyLabel(
    "Baltimore County Police Department (ORI MD0030100) reported 12 murders.", POLICE);
  assert(!kept.changed, `a correct label is not rewritten (${kept.text})`);

  // A different agency's authoritative name is plain "Baltimore County" — and "sheriff" is not
  // in it, so a sheriff claim about it is corrected too, without inventing a department.
  const other = enforceAuthoritativeAgencyLabel(
    "Baltimore County Sheriff's Office (ORI MD0030000) reported 3 murders.", SHERIFF_SIDE);
  assert(other.text.includes("Baltimore County (ORI MD0030000)"),
    `the other ORI takes its own authoritative name (${other.text})`);
  assert(!other.text.includes("Police Department"),
    `nothing is borrowed from the other agency (${other.text})`);

  // Prose that says nothing about identity is untouched.
  const neutral = enforceAuthoritativeAgencyLabel(
    "Violent crime fell 4% between 2023 and 2024.", POLICE);
  assert(!neutral.changed, `identity-free prose is untouched (${neutral.text})`);

  // Empty input is not an error.
  assert(enforceAuthoritativeAgencyLabel("", POLICE).text === "", "empty text is handled");
  assert(enforceAuthoritativeAgencyLabel(null, POLICE).text === "", "null text is handled");
}

console.log("\nthe authoritative record comes from the database");
const dbPath = process.env.RTCI_DB_PATH || path.join(process.cwd(), "crime_data.db");
if (fs.existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true });
  const police = lookupAuthoritativeAgency(db, "MD0030100");
  const sheriffSide = lookupAuthoritativeAgency(db, "MD0030000");
  assert(!!police, "MD0030100 has an authoritative record");
  assert(!!sheriffSide, "MD0030000 has an authoritative record");

  // The property under test is that the label comes from the record, whatever the record says.
  // Asserting a particular string here would only be testing which vintage of the database this
  // machine happens to hold: production now separates the two Baltimore agencies, and a
  // pre-swap copy still records both as "Baltimore County".
  const separated = !!police && !!sheriffSide && police.agency !== sheriffSide.agency;
  console.log(`        MD0030100 = ${police?.agency} | MD0030000 = ${sheriffSide?.agency}`);
  console.log(`        this database ${separated ? "distinguishes" : "does NOT distinguish"} the two agencies`);
  if (separated) {
    assert(police!.agency === "Baltimore County Police Department",
      `on data that separates them, MD0030100 is the Police Department (got ${police!.agency})`);
    assert(!/sheriff/i.test(police!.agency),
      "the police department is not recorded as a sheriff's office");
  }

  // An ORI the table does not hold has no authoritative name, so the caller must decline
  // rather than publish one. Returning null is what makes that possible.
  assert(lookupAuthoritativeAgency(db, "ZZ9999999") === null,
    "an unknown ORI yields no label rather than an invented one");
  assert(lookupAuthoritativeAgency(db, null) === null, "no ORI yields no label");
  assert(lookupAuthoritativeAgency(null, "MD0030100") === null, "no database yields no label");

  // End to end on the real record: the production sentence, corrected from the database.
  if (police) {
    const fixed = enforceAuthoritativeAgencyLabel(PRODUCTION_EXPLANATION, police);
    assert(!/Sheriff/i.test(fixed.text) && fixed.text.includes(police.agency),
      `the database-sourced label corrects the production sentence (${fixed.text.slice(0, 120)})`);
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
