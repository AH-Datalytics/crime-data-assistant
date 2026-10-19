/**
 * Stage 2A operation-taxonomy regression.
 *
 * Derives each deterministic operation's dependency surface by EXECUTING its builder against a
 * real SQLite handle and recording what it touched. Static extraction failed three times
 * (variable seals, ternary seals, helper reads); an observation cannot miss those.
 *
 * Successive versions of this suite were green while proving less than they claimed. Each
 * weakness is now an explicit assertion, because a green suite over vacuous checks manufactures
 * confidence:
 *
 *   - required columns were "at least one recognized token", then an exact set compared against
 *     the extractor's own output                            -> resolved through SQL scopes and
 *     then settled by EXECUTION: rename a column in the artifact and ask SQLite whether the
 *     operation's real SQL still compiles, in both directions
 *   - a missing case printed a NOTE                         -> denominator equality assertion
 *   - families were never enumerated independently          -> re-derived from source here
 *   - role branches were enumerated by hand                 -> read out of the builder source,
 *     required for every family that selects them
 *   - a route case passed on any matching guardrail         -> factual exits now require
 *     non-null SQL, the expected tables, AND SQL that executes
 *   - a fixture that never reached a contract was recorded
 *     as "unavailable", a claim about production            -> only an explicitly listed
 *     production exit may be unavailable; anything else fails
 *   - coverage/integrity/availability/receipt were generated
 *     and presented as policy                               -> hand-authored or null, and null
 *     authorizes nothing
 *   - prepare() recorded bare SQL globally                  -> {dbPath, sql}, scoped per case by
 *     AsyncLocalStorage so async and concurrent activity cannot cross cases
 *
 * Two standing rules, both learned the hard way:
 *
 *   1. BEFORE claiming a check works, name the input that would make it fail. If nothing can, it
 *      proves nothing. Several checks here therefore assert their own non-vacuity (a minimum
 *      number of probes, a non-empty requirement set) so that a derivation which stops measuring
 *      anything fails instead of passing.
 *   2. A mechanism sound in one direction is not sound in reverse, and an assertion that tests for
 *      a NAMED PATTERN does not constrain SHAPE. The group rename was introduced to close a
 *      rescue in the over-attribution direction and left the omission direction using the probe
 *      whose blind spot it had just documented; and a plan check that grepped for a rejected
 *      function name let six call sites of the identity model that function belonged to survive.
 *
 *   3. Prefer a SHAPE that cannot represent the invalid state over a validator that rejects it. A
 *      flat `availability: "conditional"` beside an optional condition can be written wrong, so the
 *      invariant lived only in the validator -- and the type meant to describe it omitted the
 *      condition entirely. A discriminated value cannot be written wrong. Likewise, deriving a
 *      value in one place and reading the pin everywhere else beats two implementations that agree
 *      today.
 *
 * Related: report failure categories in ONE assertion. Asserting them in sequence lets the first
 * failure hide the second, and a hidden category is one nobody can see stopped working.
 *
 * Also: select code by SHAPE, not by position. "The first block mentioning sourceHealthFor" picked
 * a signature-only declaration and reported a defect that was not there; and code-shape checks
 * strip comments first, because comments are where a rejected form is documented on purpose.
 *
 * TAXONOMY_DERIVE=1 regenerates the data files. TAXONOMY_DUMP_SQL=<path> writes every observed
 * branch with its SQL, so the derivation can be inspected against what produced it.
 */
import assert from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { POLICY_FIELDS, capabilityAuthorizes, policyIsComplete, policyShapeErrors, type UnvalidatedPolicy } from "../lib/capability-policy";
import { loadGeneratedPolicy } from "../lib/stage2b-authored-record";
import { currentContractFingerprint } from "./generate-stage2b-workbook";
import { artifactOf as sharedArtifactOf } from "../lib/source-artifact";
import { capabilityFlagKey } from "../lib/capability-flag-key";
import type { SourceId } from "../lib/proof-contract";

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const CASES_FILE = path.join(DATA_DIR, "operation-cases.json");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
/**
 * Fenced code blocks of a markdown document, with comments removed.
 *
 * Comments are prose: they are where a rejected form gets documented, so a check that scans for
 * shape must not read them as code. `//` preceded by `:` is left alone so a URL survives.
 */
function planCode(markdown: string): string[] {
  return markdown.split("```").filter((_, i) => i % 2 === 1).map((block) => block
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"));
}

/** Hand-authored, never generated. Absent entry == no policy == cannot authorize. */
const POLICY_FILE = path.join(DATA_DIR, "capability-policy.json");
const PLAN_FILE = path.join(process.cwd(), "docs", "superpowers", "plans", "2026-08-13-stage2-source-health-registry.md");
const DERIVE = process.env.TAXONOMY_DERIVE === "1";
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), "op-taxonomy-"));

// ---------------------------------------------------------------- background-error trap
const backgroundErrors: string[] = [];
// A trap that only RECORDS turns a fatal error into a silent exit 0 -- which is exactly how
// this suite briefly reported nothing at all. Record, print, and fail.
process.on("uncaughtException", (e) => {
  backgroundErrors.push(`uncaught: ${e.message}`);
  realConsoleError(`UNCAUGHT: ${e.stack}`);
  process.exitCode = 1;
});
process.on("unhandledRejection", (e) => {
  backgroundErrors.push(`unhandled: ${String(e)}`);
  realConsoleError(`UNHANDLED: ${String(e)}`);
  process.exitCode = 1;
});
const realConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const text = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
  if (/SQLITE_ERROR|SqliteError|no such (table|column)/i.test(text)) backgroundErrors.push(`console: ${text.slice(0, 160)}`);
  realConsoleError(...args);
};

// ---------------------------------------------------------------- instrumentation
type Prepared = { dbPath: string; sql: string };
/**
 * Scoped by ASYNC CONTEXT, not by a module-global assignment.
 *
 * A single mutable `sink` cleared in a `finally` is only correct for synchronous work. Across an
 * await it attributes reads to whichever scope happens to be assigned when the statement is
 * prepared: two concurrent route cases interleave into each other, and DB activity a route
 * started but did not await lands in an unrelated case -- or, once the last scope has exited,
 * appears after the success summary. AsyncLocalStorage binds each statement to the case whose
 * continuation actually issued it.
 */
const recording = new AsyncLocalStorage<Prepared[]>();
const originalPrepare = Database.prototype.prepare;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Database.prototype as any).prepare = function (sql: string, ...rest: unknown[]) {
  const sink = recording.getStore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (sink) sink.push({ dbPath: String((this as any).name ?? ""), sql });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalPrepare as any).call(this, sql, ...rest);
};
/** Recording is scoped to one case; nothing outside that async context can contribute. */
function withRecording<T>(fn: () => T): { value: T; entries: Prepared[] } {
  const entries: Prepared[] = [];
  return { value: recording.run(entries, fn), entries };
}
async function withRecordingAsync<T>(fn: () => Promise<T>): Promise<{ value: T; entries: Prepared[] }> {
  const entries: Prepared[] = [];
  return { value: await recording.run(entries, fn), entries };
}

// ---------------------------------------------------------------- fixtures
const YEARS = [2019, 2020, 2021, 2022, 2023];
const OFFENSES = ["09A", "11A", "120", "13A", "220", "23H", "240"];
const PERSON = ["09A", "11A", "13A"];

function open(name: string, ddl: string, transform?: (sql: string) => string): Database.Database {
  const db = new Database(path.join(FIXTURES, name));
  db.pragma("journal_mode = WAL");
  const source = fs.readFileSync(path.join(DATA_DIR, ddl), "utf8");
  db.exec(transform ? transform(source) : source);
  return db;
}

function buildNibrs(name: string, dropColumn?: [string, string]) {
  // city is UPPERCASE in production and normalizeCityLiteral() uppercases before matching
  // (lib/nibrs-city-aliases.ts:22); a title-cased fixture silently resolves not_in_source.
  const db = open(name, "nibrs.ddl.sql", dropColumn
    ? (sql) => sql.replace(new RegExp(`(CREATE TABLE ${dropColumn[0]}[^;]*?),?\\s*\\b${dropColumn[1]}\\b[^,)]*`, "i"), "$1")
    : undefined);
  const A = db.prepare("INSERT INTO agencies (ori, year, state_code, state, city, pop_group, country_division, covered_flag, agency_indicator, population, agency_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const C = db.prepare("INSERT INTO nibrs_agency_completeness (ori, year, months_reported, total_offenses) VALUES (?,?,?,?)");
  const R = db.prepare("INSERT INTO nibrs_consistent_reporters (start_year, end_year, ori, years_required) VALUES (?,?,?,?)");
  const X = db.prepare("INSERT INTO agency_county_crosswalk (ori, ori9, agency_name, state, fips_state_code, fips_county_code, county_fips, county_name, county_key, source) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const J = db.prepare("INSERT INTO summary_juvenile_offender_incidents (year, month, state, ori, offense_scope, incident_count) VALUES (?,?,?,?,?,?)");
  const CT = db.prepare("INSERT INTO summary_clearance_type (year, month, state, ori, ucr_offense_code, total_offenses, cleared_by_arrest, cleared_exceptional) VALUES (?,?,?,?,?,?,?,?)");
  const CD = dropColumn && dropColumn[0] === "summary_clearance_detail"
    ? null
    : db.prepare("INSERT INTO summary_clearance_detail (year, state, ori, ucr_offense_code, cleared_by_arrest, cleared_A, cleared_B, cleared_C, cleared_D, cleared_E, total_offenses) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const CM = db.prepare("INSERT INTO summary_city_monthly (year, month, state, ori, ucr_offense_code, offense_count, cleared_count) VALUES (?,?,?,?,?,?,?)");
  const VC = db.prepare("INSERT INTO summary_victim_city_monthly (year, month, state, ori, ucr_offense_code, victim_count) VALUES (?,?,?,?,?,?)");
  const VS = db.prepare("INSERT INTO summary_victim_state_monthly (state, year, month, ucr_offense_code, victim_count) VALUES (?,?,?,?,?)");
  const CIR = db.prepare("INSERT INTO summary_victim_circumstance (ori, year, ucr_offense_code, circumstance_code, victim_count, state) VALUES (?,?,?,?,?,?)");
  const VD = db.prepare("INSERT INTO summary_victim_demographics (ori, year, ucr_offense_code, weapon_category, race, sex, age_group, ethnicity, victim_count, state) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const OD = db.prepare("INSERT INTO summary_offender_demographics (ori, year, ucr_offense_code, weapon_category, race, sex, age_group, ethnicity, offender_count, state) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const AD = db.prepare("INSERT INTO summary_arrestee_demographics (ori, year, ucr_arrest_offense, weapon_category, race, sex, age_group, ethnicity, arrestee_count, state) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const year of YEARS) {
    A.run("TX0010000", year, 48, "TX", "AUSTIN", "1", "7", 0, "City", 950000, "City");
    A.run("TX0020000", year, 48, "TX", "DALLAS", "1", "7", 0, "City", 1300000, "City");
    A.run("AZ0070000", year, 4, "AZ", "PHOENIX", "1", "8", 0, "City", 1600000, "City");
    for (const ori of ["TX0010000", "TX0020000", "AZ0070000"]) C.run(ori, year, 12, 5000);
    for (const ori of ["TX0010000", "TX0020000"]) {
      J.run(year, 1, "TX", ori, "violent", 12);
      CIR.run(ori, year, "13A", "01", 20, "TX");
      for (const offense of OFFENSES) {
        CT.run(year, 1, "TX", ori, offense, 100, 40, 5);
        CD?.run(year, "TX", ori, offense, 40, 10, 8, 7, 9, 6, 100);
        CM.run(year, 1, "TX", ori, offense, 100, 40);
      }
      for (const offense of PERSON) VC.run(year, 1, "TX", ori, offense, 55);
      for (const race of ["W", "B", "A"]) {
        for (const offense of PERSON) {
          VD.run(ori, year, offense, "firearm", race, "M", "Under 18", "N", 11, "TX");
          OD.run(ori, year, offense, "firearm", race, "M", "Under 18", "N", 9, "TX");
        }
        AD.run(ori, year, "09A", "firearm", race, "M", "Under 18", "N", 7, "TX");
      }
    }
    for (const offense of OFFENSES) VS.run("TX", year, 1, offense, 500);
  }
  // Seeded ONLY so module initialization is clean by construction: dynamic-facts unions
  // these at import (lib/dynamic-facts.ts:222-230) and throws if any is missing or empty.
  // No case depends on them; an unseeded fixture makes an unrelated error look like a finding.
  const SC = db.prepare("INSERT INTO nibrs_state_coverage (state, year) VALUES (?,?)");
  const SSM = db.prepare("INSERT INTO summary_state_monthly (state, year, month, ucr_offense_code, offense_count) VALUES (?,?,?,?,?)");
  for (const year of YEARS) { SC.run("TX", year); SSM.run("TX", year, 1, "09A", 100); }
  for (const ori of ["TX0010000", "TX0020000"]) R.run(2019, 2023, ori, 5);
  X.run("TX0010000", "TX0010000", "AUSTIN", "TX", 48, 453, "48453", "Travis", "TRAVIS", "seed");
  X.run("AZ0070000", "AZ0070000", "PHOENIX", "AZ", 4, 13, "04013", "Maricopa", "MARICOPA", "seed");
  X.run("TX0020000", "TX0020000", "DALLAS", "TX", 48, 113, "48113", "Dallas", "DALLAS", "seed");
  db.close();
}

function buildRollup() {
  const db = open("nibrs_rollups.db", "rollup.ddl.sql");
  const s = db.prepare("INSERT INTO state_summary_arrestee_demographics (state, year, ucr_arrest_offense, weapon_category, race, sex, age_group, ethnicity, arrestee_count) VALUES (?,?,?,?,?,?,?,?,?)");
  const n = db.prepare("INSERT INTO national_summary_arrestee_demographics (state, year, ucr_arrest_offense, weapon_category, race, sex, age_group, ethnicity, arrestee_count) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const year of YEARS) for (const race of ["W", "B", "A"]) {
    s.run("TX", year, "09A", "firearm", race, "M", "Under 18", "N", 40);
    n.run(null, year, "09A", "firearm", race, "M", "Under 18", "N", 900);
  }
  db.close();
}

function buildShr() {
  const db = open("shr.db", "shr.ddl.sql");
  const I = db.prepare("INSERT INTO incidents (id, year, month, state, state_name, ori, agency, population, division, homicide_type, situation, weapon, weapon_group, relationship, relationship_group, circumstance, circumstance_group, sub_circumstance, action_type, incident_num, off_age, off_age_num, off_sex, off_race, off_ethnicity, agency_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const V = db.prepare("INSERT INTO victims (id, incident_id, victim_num, age, age_num, sex, race, ethnicity) VALUES (?,?,?,?,?,?,?,?)");
  const X = db.prepare("INSERT INTO agency_county_crosswalk (ori, ori9, agency_name, state, fips_state_code, fips_county_code, county_fips, county_name, county_key, source) VALUES (?,?,?,?,?,?,?,?,?,?)");
  let id = 1;
  // homicide_type 'Murder' + weapon_group 'Firearm' is exactly what the shooting path filters
  // on (app/api/shr-query/route.ts:545). Without matching rows the exit is not factual, which
  // is how the previous suite "passed" that case while observing a decline.
  for (const year of YEARS) for (const [ori, name] of [["TX0010000", "Austin"], ["TX0020000", "Dallas"]]) {
    for (let month = 1; month <= 12; month += 1) {
      I.run(id, year, month, "TX", "Texas", ori, name, 950000, "West South Central", "Murder",
        "Single victim/single offender", "Handgun", "Firearm", "Acquaintance", "Acquaintance",
        "Argument", "Argument", null, "Normal", 1, "30", 30, "M", "W", "N", "City");
      V.run(id, id, 1, "25", 25, "M", "B", "N");
      id += 1;
    }
  }
  X.run("TX0010000", "TX0010000", "AUSTIN", "TX", 48, 453, "48453", "Travis", "TRAVIS", "seed");
  X.run("TX0020000", "TX0020000", "DALLAS", "TX", 48, 113, "48113", "Dallas", "DALLAS", "seed");
  // Without these two tables resolveShrAgency() returns `unsupported` for every city
  // (lib/shr-place-resolver.ts:123), the shooting route takes its place-resolution-block exit,
  // and the incidents+victims contract is never reached. The predecessor of this fixture
  // recorded that as "unavailable" -- a production verdict the fixture had not earned.
  // agency_type must be 'City': requestedType("city") filters the alias join on it (:96,:161).
  const ID = db.prepare("INSERT INTO shr_agency_identity (ori, state, canonical_agency, agency_type, search_key, source_agency_names, source_agency_types, nibrs_city, nibrs_agency_type, incident_count, first_year, last_year) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const AL = db.prepare("INSERT INTO shr_agency_alias (alias, alias_key, ori, state, canonical_agency, agency_type, source) VALUES (?,?,?,?,?,?,?)");
  for (const [ori, name] of [["TX0010000", "Austin"], ["TX0020000", "Dallas"]]) {
    // alias_key is agencySearchKey(requestedName) -- uppercase, punctuation collapsed
    // (lib/shr-agency-normalization.ts:71). A title-cased key silently resolves not_in_source.
    const key = name.toUpperCase();
    ID.run(ori, "TX", name, "City", key, name, "City", key, "City", 60, YEARS[0], YEARS[YEARS.length - 1]);
    AL.run(name, key, ori, "TX", name, "City", "seed");
  }
  db.close();
}

/** Both states: production lacks the crosswalk, so absent AND present are both exercised. */
function buildHateCrime(name: string, withCrosswalk: boolean) {
  const db = open(name, "hc.ddl.sql");
  const I = db.prepare("INSERT INTO hate_crime_incidents (id, year, state, state_name, ori, agency_name, population, pop_group, incident_number, incident_date, data_source, quarter, total_individual_victims, total_offenders, offender_race, offender_ethnicity, offense_group, offense_code, offense_name, offense_victims, location, bias_code, bias_desc, bias_category, victim_types, adult_victims, juvenile_victims, adult_offenders, juvenile_offenders) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const P = db.prepare("INSERT INTO hate_crime_participation (year, state, total_agencies, reporting_agencies, total_incidents, total_victims) VALUES (?,?,?,?,?,?)");
  let id = 1;
  for (const year of YEARS) {
    I.run(id, year, "TX", "Texas", "TX0020000", "Dallas PD", 1300000, "1", `INC${id}`, `${year}-01-15`, "SRS", 1, 1, 1,
      "W", "N", "Crime Against Person", "13A", "Aggravated Assault", 1, "Highway", "43",
      "Anti-Black or African American", "Race/Ethnicity/Ancestry", "Individual", 1, 0, 1, 0);
    P.run(year, "TX", 1000, 800, 120, 140);
    id += 1;
  }
  if (withCrosswalk) {
    db.exec("CREATE TABLE agency_county_crosswalk (ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, fips_state_code INTEGER, fips_county_code INTEGER, county_fips TEXT, county_name TEXT, county_key TEXT, source TEXT NOT NULL)");
    db.prepare("INSERT INTO agency_county_crosswalk VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("TX0020000", "TX0020000", "DALLAS", "TX", 48, 113, "48113", "Dallas", "DALLAS", "seed");
  }
  db.close();
}

function buildCrimeData(name: string, dropColumn?: [string, string]) {
  const db = open(name, "crime_data.ddl.sql", dropColumn
    ? (sql) => sql.replace(new RegExp(`(CREATE TABLE ${dropColumn[0]}[^;]*?),?\\s*\\b${dropColumn[1]}\\b[^,)]*`, "i"), "$1")
    : undefined);
  const A = db.prepare("INSERT INTO agencies (ori, agency, state, type, total_months, national_sample) VALUES (?,?,?,?,?,?)");
  const M = db.prepare("INSERT INTO agency_monthly (ori, agency, state, type, year, month, offense, count) VALUES (?,?,?,?,?,?,?,?)");
  const P = db.prepare("INSERT INTO agency_population (ori, year, population) VALUES (?,?,?)");
  const S = db.prepare("INSERT INTO sample_agencies (ori, agency, state, type) VALUES (?,?,?,?)");
  const N = db.prepare("INSERT INTO national_monthly (year, month, offense, count, agency_count) VALUES (?,?,?,?,?)");
  const HA = db.prepare("INSERT INTO historical_agency (ori, agency, state, type) VALUES (?,?,?,?)");
  const HC = db.prepare("INSERT INTO historical_agency_crime (ori, year, population, violent, murder, rape, robbery, assault, property, burglary, theft, motor_vehicle_theft) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const HP = db.prepare("INSERT INTO historical_agency_population (ori, year, population) VALUES (?,?,?)");
  const HL = db.prepare("INSERT INTO historical_agency_clearance (ori, year, violent_clr, murder_clr, rape_clr, robbery_clr, assault_clr, property_clr, burglary_clr, theft_clr, motor_vehicle_theft_clr) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const ST = db.prepare("INSERT INTO historical_staffing (ori, year, all_total, officer_total, civilian_total) VALUES (?,?,?,?,?)");
  const SN = db.prepare("INSERT INTO historical_state_national (state, year, population, murder, murder_rate, rape, rape_rate, robbery, robbery_rate, aggravated_assault, aggravated_assault_rate, burglary, burglary_rate, theft, theft_rate, auto_theft, auto_theft_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const RY = db.prepare("INSERT INTO agency_year_reliability (ori, year, kind, source, columns_json, evidence_json, algorithm_version, generated_at) VALUES (?,?,?,?,?,?,?,?)");
  const XW = db.prepare("INSERT INTO agency_county_crosswalk (ori, ori9, agency_name, state, fips_state_code, fips_county_code, county_fips, county_name, county_key, source) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const NCR = db.prepare("INSERT INTO national_clearance_rate (year) VALUES (?)");
  // historical_agency.agency is Title Case with lowercase state/type in production; the
  // scorecard matches it against the resolver candidate verbatim (agency-scorecard.ts:148).
  const CITIES: [string, string, string][] = [["TX0010000", "Austin", "TX"], ["TX0020000", "Dallas", "TX"], ["TX1010000", "Houston", "TX"], ["OH0480000", "Toledo", "OH"]];
  // Distinct counties per city: giving them all one county_key makes countyStates() return
  // multiple states, so the lookup goes AMBIGUOUS -- a fixture artifact that reads as an
  // unavailable product exit.
  const COUNTY: Record<string, [number, string, string]> = { Austin: [453, "48453", "Travis"], Dallas: [113, "48113", "Dallas"], Houston: [201, "48201", "Harris"], Toledo: [95, "39095", "Lucas"] };
  for (const [ori, nm, st] of CITIES) {
    A.run(ori, nm, st, "City", 96, 1);
    S.run(ori, nm, st, "City");
    HA.run(ori, nm, st.toLowerCase(), "city");
    XW.run(ori, ori, nm, st, 48, COUNTY[nm][0], COUNTY[nm][1], COUNTY[nm][2], COUNTY[nm][2].toUpperCase(), "seed");
  }
  for (let year = 2015; year <= 2024; year += 1) {
    NCR.run(year);
    for (const [ori] of CITIES) {
      P.run(ori, year, 900000);
      HC.run(ori, year, 900000, 4000, 40, 60, 700, 3200, 20000, 4000, 14000, 2000);
      HP.run(ori, year, 900000);
      HL.run(ori, year, 1200, 20, 15, 30, 400, 4000, 800, 2800, 400);
      ST.run(ori, year, 2400, 1800, 600);
      RY.run(ori, year, "partial-year", "seed", "[]", "{}", "1.0.0-seed", `${year}-01-01`);
      if (year >= 2017) for (let m = 1; m <= 12; m += 1) M.run(ori, "x", "TX", "City", year, m, "murder", 3);
    }
    for (const st of ["Texas", "California", "United States"]) {
      SN.run(st, year, 29000000, 1400, 4.8, 1500, 5.2, 3000, 10.3, 9000, 31.0, 20000, 69.0, 60000, 207.0, 8000, 27.6);
    }
    if (year >= 2017) for (let m = 1; m <= 12; m += 1) N.run(year, m, "murder", 900, 700);
  }
  db.close();
}

buildNibrs("nibrs.db");
buildRollup();
buildShr();
buildHateCrime("hate_crime.db", false);
buildHateCrime("hate_crime-xwalk.db", true);
buildCrimeData("crime_data.db");
open("query_log.db", "query_log.ddl.sql").close();

const PATHS = {
  nibrs: path.join(FIXTURES, "nibrs.db"),
  rollup: path.join(FIXTURES, "nibrs_rollups.db"),
  shr: path.join(FIXTURES, "shr.db"),
  hate_crime: path.join(FIXTURES, "hate_crime.db"),
  hate_crime_xwalk: path.join(FIXTURES, "hate_crime-xwalk.db"),
  crime_data: path.join(FIXTURES, "crime_data.db"),
  query_log: path.join(FIXTURES, "query_log.db"),
};
process.env.NIBRS_DB_PATH = PATHS.nibrs;
process.env.NIBRS_ROLLUP_DB_PATH = PATHS.rollup;
process.env.SHR_DB_PATH = PATHS.shr;
process.env.HATE_CRIME_DB_PATH = PATHS.hate_crime;
process.env.RTCI_DB_PATH = PATHS.crime_data;
process.env.QUERY_LOG_DB_PATH = PATHS.query_log;

// ---------------------------------------------------------------- schema knowledge
function schemaOf(file: string): Map<string, Set<string>> {
  const db = new Database(file, { readonly: true });
  const out = new Map<string, Set<string>>();
  for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]) {
    out.set(r.name, new Set((db.prepare(`PRAGMA table_info(${r.name})`).all() as { name: string }[]).map((c) => c.name)));
  }
  db.close();
  return out;
}
const SCHEMAS: Record<string, Map<string, Set<string>>> = {
  nibrs: new Map([...schemaOf(PATHS.nibrs), ...schemaOf(PATHS.rollup)]),
  shr: schemaOf(PATHS.shr),
  hate_crime: schemaOf(PATHS.hate_crime_xwalk),
  crime_data: schemaOf(PATHS.crime_data),
};
const ARTIFACT_PATHS: Record<string, string[]> = {
  nibrs: [PATHS.nibrs, PATHS.rollup],
  shr: [PATHS.shr],
  hate_crime: [PATHS.hate_crime, PATHS.hate_crime_xwalk],
  crime_data: [PATHS.crime_data],
};
// The source -> artifact mapping is imported, not restated. Two implementations would let the
// registry's pinned artifact and the runtime ownership check disagree about the same source.
const artifactOf = (s: string) => sharedArtifactOf(s as SourceId | "crime_data");

function cteNames(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/(?:WITH|,)\s+([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)) out.add(m[1].toLowerCase());
  return out;
}
function tablesIn(rawSql: string, schema: Map<string, Set<string>>): string[] {
  const sql = stripLiterals(rawSql);
  const ctes = cteNames(sql);
  const found = new Set<string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+((?:rollup|main)\.)?([a-z_][a-z0-9_]*)/gi)) {
    const q = (m[1] ?? "").replace(".", "").toLowerCase();
    if (ctes.has(m[2].toLowerCase())) continue;
    if (schema.has(m[2])) found.add(q === "rollup" ? `rollup.${m[2]}` : m[2]);
    else if (q === "rollup") found.add(`rollup.${m[2]}`);
  }
  return [...found].sort();
}
/**
 * SQL syntax and built-ins. Applied ONLY to unqualified identifiers: a qualified `ha.end` is a
 * real column reference, while a bare `END` closing a CASE is not. Getting this list wrong
 * understates a contract, which the "no UNDECLARED column is load-bearing" probe catches.
 */
const SQL_KEYWORDS = new Set(`
SELECT DISTINCT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET AS ON USING JOIN LEFT RIGHT INNER
OUTER CROSS NATURAL AND OR NOT NULL IS IN BETWEEN LIKE GLOB ESCAPE EXISTS CASE WHEN THEN ELSE END
CAST COLLATE ASC DESC NULLS FIRST LAST UNION ALL INTERSECT EXCEPT WITH RECURSIVE INDEXED
COUNT SUM MIN MAX AVG TOTAL ROUND ABS COALESCE NULLIF IFNULL TRIM UPPER LOWER SUBSTR REPLACE INSTR
LENGTH PRINTF STRFTIME DATE DATETIME JULIANDAY GROUP_CONCAT ROW_NUMBER OVER PARTITION
INTEGER TEXT REAL BLOB NUMERIC MAIN ROLLUP TRUE FALSE
`.trim().split(/\s+/));

/** String literals are not column references. `'monthly agency trends'` is not `agency_monthly.agency`. */
const stripLiterals = (sql: string) => sql.replace(/'(?:''|[^'])*'/g, "''");

/** Ordered contents of one name-resolution scope: its own text interleaved with nested scopes. */
type SqlScope = {
  parts: (string | SqlScope)[]; parent: SqlScope | null;
  tables: string[];
  /** alias -> table name, or `cte:<name>` for a common table expression. */
  aliases: Map<string, string>;
  /** CTEs declared in this scope, visible to it and its descendants. */
  ctes: Map<string, SqlScope>;
};
const newScope = (parent: SqlScope | null): SqlScope => ({ parts: [], parent, tables: [], aliases: new Map(), ctes: new Map() });
const ownText = (scope: SqlScope) => scope.parts.filter((p): p is string => typeof p === "string").join(" ");
const childScopes = (scope: SqlScope) => scope.parts.filter((p): p is SqlScope => typeof p !== "string");

/** Split on parentheses so an inner SELECT resolves names against its own FROM first. */
function parseScopes(sql: string): SqlScope {
  const root = newScope(null);
  let cur = root;
  let text = "";
  const flush = () => { if (text) { cur.parts.push(text); text = ""; } };
  for (const ch of sql) {
    if (ch === "(") {
      flush();
      const child = newScope(cur);
      cur.parts.push(child);
      cur = child;
    } else if (ch === ")") {
      flush();
      cur = cur.parent ?? root;
    } else text += ch;
  }
  flush();
  return root;
}

/**
 * Each arm of a UNION is its own scope.
 *
 * Without this, two arms of one compound SELECT share an alias map, and the builders reuse `AS s`
 * for a different table in each arm (`summary_victim_city_monthly AS s` then
 * `summary_city_monthly AS s`). The second binding overwrote the first, so every column read
 * through the first arm's `s.` was attributed to the wrong table and then dropped as undeclared --
 * an entire table silently left out of the contract.
 */
function splitCompoundSelects(scope: SqlScope): void {
  for (const child of childScopes(scope)) splitCompoundSelects(child);
  const arms: (string | SqlScope)[][] = [[]];
  let compound = false;
  for (const part of scope.parts) {
    if (typeof part !== "string") { arms[arms.length - 1].push(part); continue; }
    const pieces = part.split(/\b(?:UNION\s+ALL|UNION|INTERSECT|EXCEPT)\b/gi);
    arms[arms.length - 1].push(pieces[0]);
    for (const piece of pieces.slice(1)) { arms.push([piece]); compound = true; }
  }
  if (!compound) return;
  scope.parts = arms.map((parts) => {
    const arm = newScope(scope);
    arm.parts = parts;
    for (const part of parts) if (typeof part !== "string") part.parent = arm;
    return arm;
  });
}

/**
 * Register `name AS (...)` common table expressions against the scope they are declared in.
 *
 * A CTE re-exports base-table columns (`SELECT x.* FROM agency_county_crosswalk x`), and the outer
 * query then reads them through the CTE's alias. Without this, those reads resolve to nothing and
 * the contract omits columns the SQL genuinely depends on -- which the execution probe catches.
 */
function bindCtes(scope: SqlScope): void {
  scope.parts.forEach((part, index) => {
    if (typeof part === "string") return;
    const prev = scope.parts[index - 1];
    if (typeof prev !== "string") return;
    // `name AS (`, or `name(col, ...) AS (` where the column list is itself a nested scope.
    let name = prev.match(/\b([a-z_][a-z0-9_]*)\s+AS\s*$/i)?.[1];
    if (!name && /^\s*AS\s*$/i.test(prev) && typeof scope.parts[index - 3] === "string") {
      name = (scope.parts[index - 3] as string).match(/\b([a-z_][a-z0-9_]*)\s*$/i)?.[1];
    }
    if (name && !SQL_KEYWORDS.has(name.toUpperCase())) scope.ctes.set(name.toLowerCase(), part);
  });
  for (const child of childScopes(scope)) bindCtes(child);
}
function cteLookup(scope: SqlScope | null, name: string): SqlScope | null {
  for (let s = scope; s; s = s.parent) {
    const hit = s.ctes.get(name);
    if (hit) return hit;
  }
  return null;
}
/** Base tables a CTE ultimately reads, following nested scopes and other CTEs it selects from. */
function baseTablesOf(scope: SqlScope, seen = new Set<SqlScope>()): string[] {
  if (seen.has(scope)) return [];
  seen.add(scope);
  const out = [...scope.tables];
  for (const child of childScopes(scope)) out.push(...baseTablesOf(child, seen));
  for (const target of scope.aliases.values()) {
    if (!target.startsWith("cte:")) continue;
    const cte = cteLookup(scope, target.slice(4));
    if (cte) out.push(...baseTablesOf(cte, seen));
  }
  return [...new Set(out)];
}

function bindTables(scope: SqlScope, schema: Map<string, Set<string>>): void {
  for (const m of ownText(scope).matchAll(/\b(?:FROM|JOIN)\s+((?:rollup|main)\.)?([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi)) {
    const qualifier = (m[1] ?? "").replace(".", "").toLowerCase();
    const raw = m[2];
    const isTable = schema.has(raw) || qualifier === "rollup";
    const cte = isTable ? null : cteLookup(scope, raw.toLowerCase());
    if (!isTable && !cte) continue;                                  // an unknown name
    const name = cte ? `cte:${raw.toLowerCase()}` : qualifier === "rollup" ? `rollup.${raw}` : raw;
    if (!cte) scope.tables.push(name);
    scope.aliases.set(raw.toLowerCase(), name);
    const alias = m[3];
    if (alias && !SQL_KEYWORDS.has(alias.toUpperCase())) scope.aliases.set(alias.toLowerCase(), name);
  }
  for (const child of childScopes(scope)) bindTables(child, schema);
}

/**
 * Attribute each column reference to the table the SQL actually reads it from.
 *
 * The predecessor intersected every identifier in the statement with every participating table's
 * schema. That has no notion of which table a name belongs to, so a name declared by two tables
 * was credited to both, `CASE ... END` produced `historical_agency.end`, and words inside string
 * literals became columns.
 */
function columnsFor(sql: string, tables: string[], schema: Map<string, Set<string>>): Record<string, string[]> {
  const wanted = new Set(tables);
  const found = new Map<string, Set<string>>();
  const declares = (table: string, column: string): string | null => {
    const cols = schema.get(table.replace(/^rollup\./, ""));
    if (!cols) return null;
    for (const c of cols) if (c.toLowerCase() === column.toLowerCase()) return c;
    return null;
  };
  const add = (table: string, column: string) => {
    const real = declares(table, column);
    if (!real || !wanted.has(table)) return;
    found.set(table, (found.get(table) ?? new Set()).add(real));
  };
  const resolveAlias = (scope: SqlScope | null, name: string): string | null => {
    for (let s = scope; s; s = s.parent) {
      const hit = s.aliases.get(name);
      if (hit) return hit;
    }
    return null;
  };

  const root = parseScopes(stripLiterals(sql));
  splitCompoundSelects(root);
  bindCtes(root);
  bindTables(root, schema);

  const walk = (scope: SqlScope) => {
    const text = ownText(scope);
    for (const m of text.matchAll(/\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi)) {
      const target = resolveAlias(scope, m[1].toLowerCase());
      if (!target) continue;
      if (!target.startsWith("cte:")) { add(target, m[2]); continue; }
      // Read through the CTE to the base tables it re-exports.
      const cte = cteLookup(scope, target.slice(4));
      if (cte) for (const table of baseTablesOf(cte)) add(table, m[2]);
    }
    for (const m of text.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)\b(?!\s*[.(])/gi)) {
      const id = m[1].toLowerCase();
      if (SQL_KEYWORDS.has(id.toUpperCase()) || resolveAlias(scope, id)) continue;
      // A result name from `AS <name>` is NOT filtered here: `SELECT CASE ... END AS state FROM
      // agencies WHERE state IS NOT NULL` uses the same word as both, and suppressing it emptied
      // the contract. A name that is a real column of a table in scope is treated as a reference
      // to it; a name that is only a result alias matches no table and attributes nothing. Where
      // that guess is wrong, the "declared columns are load-bearing" probe rejects it.
      // Innermost FROM wins, exactly as SQL name resolution does: an unqualified `ori` inside a
      // subquery belongs to that subquery's table, not to the enclosing query's.
      for (let s: SqlScope | null = scope; s; s = s.parent) {
        const owners = s.tables.filter((t) => declares(t, id));
        if (owners.length) { owners.forEach((t) => add(t, id)); break; }
      }
    }
    for (const child of childScopes(scope)) walk(child);
  };
  walk(root);

  const out: Record<string, string[]> = {};
  for (const t of tables) if (found.has(t)) out[t] = [...found.get(t)!].sort();
  return out;
}

// ---------------------------------------------------------------- results
type CaseResult = { family: string; sql: string | null } | null;
type Observation = {
  branch: string; source: string; artifact: string;
  family: string | null; terminalKind: "factual" | "unavailable" | "unverified" | "none";
  prepDependencies: string[]; emittedDependencies: string[];
  requiredColumns: Record<string, string[]>;
  executed: boolean; note?: string; sql: string | null;
  /** The artifact file this case's SQL was executed against; probes must use the same one. */
  artifactPath: string;
};
const observations: Observation[] = [];
let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 5).join("\n        ")}`); }
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 5).join("\n        ")}`); }
}

/**
 * A capability's declared contract in the shape capabilityAuthorizes() needs.
 *
 * Eligibility is capability-SPECIFIC: shape completeness cannot see which tables the capability
 * reads, so a well-shaped policy naming a coverage basis outside the contract would otherwise be
 * pinned eligible.
 */
const declaredTables = (emitted: readonly string[], cols: Record<string, string[]>) =>
  emitted.map((name) => ({ name, requiredColumns: cols[name] ?? [] }));

// ---------------------------------------------------------------- capability flag names
/**
 * The ONE derivation, imported -- not a local copy. This file originally held its own
 * implementation used to pin `flagKey` into the registry, with a cross-check asserting the pin
 * equals the shared module's output; importing removes the second implementation entirely, which
 * is strictly stronger than checking that two implementations agree.
 */
const envKeyForCapability = capabilityFlagKey;

// ---------------------------------------------------------------- authored policy
// The validator lives in lib/capability-policy.ts, imported here rather than duplicated. Writing it
// twice is how the shallow "every field is non-null" rule came back after being corrected.
type CapabilityPolicy = UnvalidatedPolicy;
function readPolicy(): Record<string, CapabilityPolicy> {
  /**
   * Through the canonical loader, which refuses a generated policy that lags the authored record.
   * Reading the file directly would let the derivation pin a decision that has since been changed.
   */
  if (!fs.existsSync(POLICY_FILE)) return {};
  const raw = loadGeneratedPolicy(currentContractFingerprint()) as unknown as Record<string, CapabilityPolicy>;
  // Keys starting with _ document the file itself and are not capability ids.
  return Object.fromEntries(Object.entries(raw).filter(([id]) => !id.startsWith("_")));
}
/**
 * Fail closed: a null policy, one with any field still unauthored, or one whose fields are the
 * wrong SHAPE cannot authorize.
 *
 * "Every field is non-null" is not a schema. `{coverage: {}, integrity: true, availability: 1,
 * receiptOwner: false}` satisfies a non-null check and authorizes, while stating nothing — and
 * `availability` in particular is an enum the evaluator branches on, so a descriptive sentence
 * there is a value no consumer can act on.
 */
/** The artifact file a case's SQL runs against. */
function artifactFile(artifact: string, override?: string): string {
  return override ?? (artifact === "nibrs" ? PATHS.nibrs : artifact === "shr" ? PATHS.shr
    : artifact === "hate_crime" ? PATHS.hate_crime : PATHS.crime_data);
}

/** A dependency contract that cannot execute is not a contract. */
function executes(sql: string, artifact: string, override?: string): boolean {
  const file = artifactFile(artifact, override);
  const db = new Database(file, { readonly: true });
  try {
    if (artifact === "nibrs") db.exec(`ATTACH DATABASE '${PATHS.rollup.replace(/\\/g, "/")}' AS rollup`);
    db.prepare(sql).all();
    return true;
  } catch { return false; } finally { db.close(); }
}

function record(branch: string, source: string, result: CaseResult, entries: Prepared[], note?: string, only?: string) {
  const artifact = artifactOf(source);
  const allowed = only ? [only] : ARTIFACT_PATHS[artifact];
  const mine = entries.filter((e) => allowed.some((p) => path.resolve(p) === path.resolve(e.dbPath)));
  const schema = SCHEMAS[artifact];
  const sql = result?.sql ?? null;
  const emitted = sql ? tablesIn(sql, schema) : [];
  const prep = tablesIn(mine.map((e) => e.sql).join("\n;\n"), schema).filter((t) => !emitted.includes(t));
  const cols = sql ? columnsFor(sql, emitted, schema) : {};
  observations.push({
    branch, source, artifact,
    family: result?.family ?? null,
    // Classified by TABLES READ, not by SQL presence. The unavailable exits return a
    // synthetic `SELECT '...' AS answer` (lib/metadata-coverage.ts:247), so sql-presence
    // alone counts a canned refusal as a factual data claim and mints a phantom capability.
    terminalKind: sql && emitted.length > 0 ? "factual" : result ? "unavailable" : "none",
    prepDependencies: prep, emittedDependencies: emitted, requiredColumns: cols,
    executed: sql && emitted.length > 0 ? executes(sql, artifact, only) : false,
    note, sql, artifactPath: artifactFile(artifact, only),
  });
}

async function main() {
  // ------------------------------------------------------------ imports, recording OFF
  // Every module initializes here so no case can inherit another handle's reads.
  const { planNibrsQuery } = await import("../lib/nibrs-query-planner");
  const { resolveNibrsPlaces } = await import("../lib/nibrs-place-resolver");
  const { buildQueryContract } = await import("../lib/query-contract");
  const { getNibrsDb } = await import("../lib/nibrs-db");
  const { answerMetadataQuestion } = await import("../lib/metadata-coverage");
  const { getDb } = await import("../lib/rtci-db");
  const { getShrDb } = await import("../lib/shr-db");
  const { getHateCrimeDb } = await import("../lib/hc-db");
  const { buildCurrentIndexedStatePlan } = await import("../lib/current-indexed-state-deterministic");
  const { buildMultiCityTrendPlan } = await import("../lib/multi-city-deterministic");
  const { buildHistoricalScorecard } = await import("../lib/historical-scorecard");
  const { buildHistoricalLocalRecentChangePlan, buildHistoricalCityChangeRankingPlan } = await import("../lib/historical-deterministic-queries");
  const shrRoute = await import("../app/api/shr-query/route");
  const queryRoute = await import("../app/api/query/route");
  const { createHmac } = await import("node:crypto");

  check("module initialization produced no SQLite errors", () => {
    assert.deepStrictEqual(backgroundErrors, [], `initialization must be clean by construction:\n${backgroundErrors.join("\n")}`);
  });

  // ------------------------------------------------------------ self-tests
  for (const [label, opener, expected] of [
    ["nibrs", () => getNibrsDb(), PATHS.nibrs],
    ["shr", () => getShrDb(), PATHS.shr],
    ["hate_crime", () => getHateCrimeDb(), PATHS.hate_crime],
    ["crime_data", () => getDb(), PATHS.crime_data],
  ] as [string, () => { name?: string } | null, string][]) {
    check(`handle routing: ${label}`, () => {
      const actual = opener()?.name ?? null;
      assert.ok(actual, `${label} opened nothing`);
      assert.strictEqual(path.resolve(actual!), path.resolve(expected));
    });
  }
  check("handle routing: rollup env", () => assert.strictEqual(path.resolve(process.env.NIBRS_ROLLUP_DB_PATH!), path.resolve(PATHS.rollup)));
  for (const [source, marker] of [["current", "agency_monthly"], ["historical", "historical_agency_crime"], ["nibrs", "summary_victim_demographics"], ["shr", "incidents"], ["hate_crime", "hate_crime_incidents"], ["crime_data", "agencies"]] as [string, string][]) {
    check(`schema routing: ${source} has ${marker}`, () => assert.ok(SCHEMAS[artifactOf(source)].has(marker)));
  }

  // ------------------------------------------------------------ independent family enumeration
  check("sealed families enumerated from source match the pinned set", () => {
    const ROUTES = ["app/api/query/route.ts", "app/api/nibrs-query/route.ts", "app/api/shr-query/route.ts", "app/api/hc-query/route.ts"];
    const sites = ROUTES.reduce((n, f) => n + [...fs.readFileSync(f, "utf8").matchAll(/sealPlanDerivation\(/g)].length, 0);
    // 12 -> 18 on the Phase 3 integration (2026-09-30), enumerated against dev b285be3 before this
    // moved: query +2 (cityRankingPlan.guardrail, yoyComparisonPlan.guardrail), nibrs-query +2
    // (NIBRS_CATEGORY_CHANGE_GUARDRAIL, ownedQuery.guardrail), shr-query +2 ("owned-shr-count",
    // SHR_CITY_RANKING_GUARDRAIL). Only the string-literal one is visible to the family regex below.
    // 18 -> 19: request accounting stage 1 (plan r2.1) -- shr-query +1, the owned request-plan seal ("owned-shr-request-plan").
    // 19 -> 20 (GC-051 batch, 2026-10-07): query +1 (CURRENT_MONTH_COVERAGE_GUARDRAIL, the owned Current month-coverage
    // read, lib/current-month-coverage.ts). A constant, so the family regex below is unchanged.
    // 20 -> 21: request accounting stage 2a -- query +1, the Historical typed answer's seal (sealPlanDerivation(typeFamily, ...),
    // "historical-question-type:<H1-H6>"). A variable, so the family regex below is unchanged.
    assert.strictEqual(sites, 21, "seal-site count moved; re-run the two-pass enumeration");
    const families = new Set<string>();
    for (const f of ROUTES) for (const m of fs.readFileSync(f, "utf8").matchAll(/sealPlanDerivation\(\s*"([a-z0-9-]+)"/g)) families.add(m[1]);
    for (const f of ["lib/nibrs-deterministic-queries.ts", "lib/nibrs-rollup-deterministic.ts", "lib/nibrs-scope-deterministic.ts", "lib/current-indexed-state-deterministic.ts", "lib/multi-city-deterministic.ts", "lib/historical-deterministic-queries.ts", "lib/historical-national-violent.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/guardrail:\s*"([a-z0-9-]+)"/g)) families.add(m[1]);
      for (const m of src.matchAll(/guardrail:\s*[^?\n]+\?\s*"([a-z0-9-]+)"\s*:\s*"([a-z0-9-]+)"/g)) { families.add(m[1]); families.add(m[2]); }
      for (const m of src.matchAll(/guardrail:\s*`deterministic-\$\{source\}-([a-z-]+)`/g)) { families.add(`deterministic-current-${m[1]}`); families.add(`deterministic-historical-${m[1]}`); }
    }
    for (const scope of ["agency", "state", "national"]) families.add(`${scope}-scorecard`);
    const PINNED = [
      "agency-scorecard", "state-scorecard", "national-scorecard",
      "deterministic-current-indexed-state-followup", "deterministic-current-multi-city-trend",
      "deterministic-historical-multi-city-trend", "deterministic-historical-local-recent-change",
      "deterministic-historical-city-change-ranking", "deterministic-place-lookup",
      "metadata-coverage-answer",
      "deterministic-nibrs-juvenile-offender-incidents", "deterministic-nibrs-clearance-type-breakdown",
      "deterministic-nibrs-clearance-method", "deterministic-nibrs-comparable-agency-clearance",
      "deterministic-nibrs-local-city-offense-count", "deterministic-nibrs-local-demographic-count",
      "deterministic-nibrs-local-demographic-share", "deterministic-nibrs-structured-local-trend",
      "deterministic-nibrs-structured-local-rate", "deterministic-nibrs-dv-assault-share",
      "deterministic-nibrs-continuous-reporters", "deterministic-nibrs-countywide-demographic",
      "deterministic-nibrs-rollup-juvenile-arrests-race", "deterministic-nibrs-rollup-national-arrests",
      "deterministic-murder", "deterministic-shooting",
      // Phase 3 integration: the owned SHR count seal, and the NIBRS annual-clearance builder.
      "owned-shr-count", "nibrs-annual-clearance",
      // National violent-crime batch (Codex :36558/:36622): the owned U.S. annual violent-crime count.
      "deterministic-historical-national-violent-count",
      // Request accounting stage 1 (plan r2.1): every SHR number with conditions comes from the application-compiled request plan.
      "owned-shr-request-plan",
    ].sort();
    assert.deepStrictEqual([...families].sort(), PINNED, "family set drifted: a builder was added, renamed, or removed");
  });

  // ------------------------------------------------------------ NIBRS (25)
  const nibrs = (q: string): CaseResult => {
    const contract = buildQueryContract(q, "nibrs");
    const plan = resolveNibrsPlaces(getNibrsDb(), q, contract);
    const out = planNibrsQuery(q, plan, { allowDeterministic: true, juvenileIncidentRollupAvailable: true });
    return out.kind === "deterministic" ? { family: out.query.guardrail, sql: out.query.sql } : null;
  };
  const NIBRS_CASES: [string, string][] = [
    ["juvenile_offender_incidents", "how many violent crime incidents had at least one offender under 18 in Texas from 2019 to 2022"],
    ["rollup_juvenile_arrests_state", "juvenile arrests by race in Texas"],
    ["rollup_juvenile_arrests_national", "juvenile arrests by race nationally"],
    ["rollup_national_arrests", "national arrests by offense"],
    ["continuous_reporters_victim", "murder victims by race among continuously reporting agencies 2019 to 2023"],
    ["continuous_reporters_offender", "murder offenders by race among continuously reporting agencies 2019 to 2023"],
    ["continuous_reporters_arrestee", "murder arrests by race among continuously reporting agencies 2019 to 2023"],
    ["continuous_reporters_victim_city", "how many murders among continuously reporting agencies 2019 to 2023"],
    ["countywide_victim", "countywide murder victims by race in Maricopa County in Arizona 2019 to 2023"],
    ["countywide_offender", "countywide murder offenders by race in Maricopa County in Arizona 2019 to 2023"],
    ["countywide_arrestee", "countywide murder arrests by race in Maricopa County in Arizona 2019 to 2023"],
    ["countywide_victim_city", "countywide murders in Maricopa County in Arizona 2019 to 2023"],
    ["comparable_agency_clearance", "how does Austin, TX murder clearance compare to similar agencies 2019 to 2022"],
    ["clearance_method", "how many murders were cleared by arrest versus exceptional means in Austin, TX from 2019 to 2022"],
    ["clearance_type_breakdown", "breakdown of clearance types for murder in Texas 2019 to 2022"],
    ["local_demographic_count_victim", "how many murder victims by race in Austin, TX from 2019 to 2022"],
    ["local_demographic_count_offender", "how many murder offenders by race in Austin, TX from 2019 to 2022"],
    ["local_demographic_count_arrestee", "how many murder arrests by race in Austin, TX from 2019 to 2022"],
    ["local_demographic_share_victim", "what share of murder victims by race in Austin, TX from 2019 to 2022"],
    // The share branch selects among the same three role configs as the count branch. Only
    // victim was exercised, so an offender/arrestee share contract was never observed and could
    // have been dropped or changed without the suite noticing.
    ["local_demographic_share_offender", "what share of murder offenders by race in Austin, TX from 2019 to 2022"],
    ["local_demographic_share_arrestee", "what share of murder arrests by race in Austin, TX from 2019 to 2022"],
    ["structured_local_trend", "murders and robberies in Austin, TX each year from 2019 to 2022"],
    ["structured_local_rate", "murder rate per 100,000 in Austin, TX each year from 2019 to 2022"],
    ["structured_local_trend_person", "murders and aggravated assaults in Austin, TX each year from 2019 to 2022"],
    ["local_city_offense_count", "how many burglaries in Austin, TX in 2022"],
    ["local_city_offense_count_person", "how many murders in Austin, TX in 2022"],
    ["dv_assault_share", "what share of aggravated assaults were domestic violence in Texas 2019 to 2022"],
  ];
  for (const [branch, q] of NIBRS_CASES) {
    const { value, entries } = withRecording(() => nibrs(q));
    record(branch, "nibrs", value, entries);
  }

  // ------------------------------------------------------------ metadata (21: 5 sources x 4, + HC present-crosswalk)
  const dbFor = (s: string) => (s === "shr" ? getShrDb() : s === "hate_crime" ? getHateCrimeDb() : s === "nibrs" ? getNibrsDb() : getDb());
  const META: [string, string][] = [
    ["metadata-year-coverage", "what years of data are available"],
    ["metadata-state-coverage", "which states have data"],
    ["metadata-agency-directory", "how many agencies are included"],
    ["metadata-agency-directory-county", "how many agencies are in Dallas County"],
  ];
  for (const source of ["current", "historical", "nibrs", "shr", "hate_crime"]) {
    for (const [op, q] of META) {
      const { value, entries } = withRecording(() => {
        const r = answerMetadataQuestion(source as never, q, dbFor(source));
        // Task 1A will have the builder seal this; until then it is derived at the same branch.
        return r ? { family: op, sql: r.sql || null } : null;
      });
      record(`${source}:${op}`, source, value, entries);
    }
  }
  // Hate Crime WITH the crosswalk: production lacks it, so the real contract is otherwise unknown.
  {
    const hcx = new Database(PATHS.hate_crime_xwalk, { readonly: true });
    const { value, entries } = withRecording(() => {
      const r = answerMetadataQuestion("hate_crime" as never, "how many agencies are in Dallas County", hcx);
      return r ? { family: "metadata-agency-directory-county", sql: r.sql || null } : null;
    });
    record("hate_crime:metadata-agency-directory-county:crosswalk-present", "hate_crime", value, entries, undefined, PATHS.hate_crime_xwalk);
    hcx.close();
  }

  // ------------------------------------------------------------ Current + Historical (8)
  const CH: [string, () => CaseResult][] = [
    ["current:indexed_state_followup", () => { const p = buildCurrentIndexedStatePlan("murder rates per 100,000 in Texas and California indexed to 2019", []); return p ? { family: p.guardrail, sql: p.sql } : null; }],
    ["current:multi_city_trend", () => { const p = buildMultiCityTrendPlan("murders in Austin, Dallas and Houston each year from 2019 to 2022", "current"); return p ? { family: p.guardrail, sql: p.sql } : null; }],
    ["historical:multi_city_trend", () => { const p = buildMultiCityTrendPlan("murders in Austin, Dallas and Houston each year from 2015 to 2019", "historical"); return p ? { family: p.guardrail, sql: p.sql } : null; }],
    ["historical:agency_scorecard", () => { const p = buildHistoricalScorecard(getDb(), "give me a crime scorecard for Austin, TX"); return p ? { family: `${p.scope}-scorecard`, sql: p.sql ?? null } : null; }],
    ["historical:state_scorecard", () => { const p = buildHistoricalScorecard(getDb(), "give me a crime scorecard for Texas"); return p ? { family: `${p.scope}-scorecard`, sql: p.sql ?? null } : null; }],
    ["historical:national_scorecard", () => { const p = buildHistoricalScorecard(getDb(), "give me a national crime scorecard"); return p ? { family: `${p.scope}-scorecard`, sql: p.sql ?? null } : null; }],
    ["historical:local_recent_change", () => { const p = buildHistoricalLocalRecentChangePlan("how did violent crime change in Austin, TX over the past year", 2024); return p ? { family: p.guardrail, sql: p.sql ?? null } : null; }],
    ["historical:city_change_ranking", () => { const p = buildHistoricalCityChangeRankingPlan("which cities had the biggest increase in violent crime from 2015 to 2019", []); return p ? { family: p.guardrail, sql: p.sql ?? null } : null; }],
  ];
  for (const [branch, fn] of CH) {
    const { value, entries } = withRecording(fn);
    record(branch, "crime_data", value, entries);
  }

  // ------------------------------------------------------------ route handlers (2)
  function pageToken(): string {
    const ts = String(Date.now() - 5000);                                    // >1s old (page-token.ts:34)
    const secret = process.env.AUTH_PASSWORD || "nibrs-page-token-secret";   // page-token.ts:3
    return Buffer.from(`${ts}:${createHmac("sha256", secret).update(ts).digest("hex").slice(0, 16)}`).toString("base64");
  }
  async function runRoute(branch: string, source: string, mod: { POST: (r: Request) => Promise<Response> }, body: Record<string, unknown>, family: string) {
    const wipe = new Database(PATHS.query_log); wipe.prepare("DELETE FROM query_log").run(); wipe.close();
    let note: string | undefined;
    const { entries } = await withRecordingAsync(async () => {
      try {
        const res = await mod.POST(new Request("http://localhost/api/x", {
          method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
          body: JSON.stringify({ ...body, pageToken: pageToken() }),
        }));
        // /api/query is SSE: the deterministic exit and its writeLog run inside the stream's
        // start(), so the body must be drained or nothing executes.
        if (res && typeof res.text === "function") await res.text();
      } catch (e) { note = `threw: ${(e as Error).message}`; }
      return null;
    });
    const rd = new Database(PATHS.query_log, { readonly: true });
    const row = rd.prepare("SELECT sql, guardrails FROM query_log ORDER BY rowid DESC LIMIT 1").get() as { sql: string | null; guardrails: string | null } | undefined;
    rd.close();
    const fired = String(row?.guardrails ?? "");
    // A guardrail string alone proved nothing before: a decline exit tags it too. The SQL
    // logged by the factual exit is what distinguishes them.
    const result: CaseResult = fired.includes(family) ? { family, sql: row?.sql ?? null } : null;
    record(branch, source, result, entries, note);
  }
  await runRoute("route:deterministic_shooting", "shr", shrRoute as never,
    { question: "fatal shootings in Austin, TX each year from 2019 to 2022", tab: "shr" }, "deterministic-shooting");
  await runRoute("route:deterministic_place_lookup", "crime_data", queryRoute as never,
    { question: "Austin, TX", mode: "historical", tab: "historical" }, "deterministic-place-lookup");

  // ------------------------------------------------------------ derive or assert
  const capabilityId = (o: Observation) => {
    if (o.terminalKind !== "factual") return null;   // an unavailable answer seals NO capability
    const tables = [...new Set([...o.prepDependencies, ...o.emittedDependencies])].sort();
    const cols = Object.entries(o.requiredColumns).sort().map(([t, c]) => `${t}(${c.join(",")})`).join("|");
    return `${o.artifact}::${tables.join("+")}::${cols}`;
  };

  if (DERIVE) {
    // Observation derives STRUCTURE only: which artifact, which tables, which columns. Coverage
    // semantics, integrity rules, availability policy and receipt ownership are not properties of
    // a SQL execution -- deriving them produced a constant ("observed-available") and a string
    // built from the first emitted table, both presented as contract. They now come from a
    // hand-authored file, and a capability with no authored policy cannot authorize anything.
    const authored = readPolicy();
    const cases: Record<string, unknown> = {};
    const registry: Record<string, unknown> = {};
    for (const o of observations) {
      const id = capabilityId(o);
      cases[o.branch] = { family: o.family, terminalKind: o.terminalKind, capability: id };
      if (id && !registry[id]) {
        const policy = authored[id] ?? null;
        registry[id] = {
          artifact: o.artifact,
          prepDependencies: o.prepDependencies,
          emittedDependencies: o.emittedDependencies,
          requiredColumns: o.requiredColumns,
          // Pinned so an environment variable in ops config can be traced back to its
          // capability. A structural id cannot be uppercased into an identifier, and a short
          // readable label is not unique (two capabilities can share a table set), so the flag
          // name goes through a content digest.
          flagKey: envKeyForCapability(o.artifact, id),
          policy,
          // Capability-SPECIFIC: shape completeness alone cannot see which tables this capability
          // reads, so a well-shaped policy with a stray coverage basis pinned as eligible here.
          authorizationEligible: capabilityAuthorizes(policy, declaredTables(o.emittedDependencies, o.requiredColumns)),
        };
      }
    }
    fs.writeFileSync(CASES_FILE, JSON.stringify(cases, null, 2));
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
    const eligible = Object.values(registry).filter((r) => (r as { authorizationEligible: boolean }).authorizationEligible).length;
    console.log(`derived ${Object.keys(cases).length} cases, ${Object.keys(registry).length} capabilities, ${eligible} with complete authored policy`);
  } else {
    const CASES = JSON.parse(fs.readFileSync(CASES_FILE, "utf8")) as Record<string, { family: string | null; terminalKind: string; capability: string | null }>;
    const REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, Record<string, unknown>>;

    check("case denominator is exactly the pinned set", () => {
      assert.deepStrictEqual(observations.map((o) => o.branch).sort(), Object.keys(CASES).sort(),
        "a case was added or removed; missing cases must FAIL, not warn");
    });
    check("every capability referenced by a case exists in the registry", () => {
      for (const [b, c] of Object.entries(CASES)) if (c.capability) assert.ok(REGISTRY[c.capability], `${b} -> unknown capability ${c.capability}`);
    });
    check("every registry capability carries a complete structural contract", () => {
      for (const [id, c] of Object.entries(REGISTRY)) {
        for (const field of ["artifact", "prepDependencies", "emittedDependencies", "requiredColumns", "policy", "authorizationEligible"]) {
          assert.ok(field in c, `${id} is missing ${field}`);
        }
        assert.ok(Object.keys(c.requiredColumns as object).length > 0, `${id} declares no required columns`);
      }
    });
    for (const o of observations) {
      const expect = CASES[o.branch];
      check(o.branch, () => {
        assert.ok(expect, `${o.branch} is not in operation-cases.json`);
        assert.strictEqual(o.family, expect.family, `family: expected ${expect.family}, got ${o.family}${o.note ? ` (${o.note})` : ""}`);
        assert.strictEqual(o.terminalKind, expect.terminalKind, `terminal kind: expected ${expect.terminalKind}, got ${o.terminalKind}`);
        assert.strictEqual(capabilityId(o), expect.capability, "capability identity changed");
        if (expect.terminalKind === "factual") {
          assert.ok(o.emittedDependencies.length > 0, "a factual exit must name tables");
          assert.ok(o.executed, "the emitted SQL must execute against its artifact");
          const reg = REGISTRY[expect.capability!];
          assert.deepStrictEqual(o.requiredColumns, reg.requiredColumns, "required columns changed");
          assert.deepStrictEqual(o.prepDependencies, reg.prepDependencies, "preparation dependencies changed");
          assert.deepStrictEqual(o.emittedDependencies, reg.emittedDependencies, "emitted dependencies changed");
        } else {
          assert.strictEqual(expect.capability, null, "a non-factual exit must seal NO capability");
        }
      });
    }
    check("Hate Crime is exercised in BOTH crosswalk states", () => {
      const absent = CASES["hate_crime:metadata-agency-directory-county"];
      const present = CASES["hate_crime:metadata-agency-directory-county:crosswalk-present"];
      assert.ok(absent && present, "both Hate Crime county states must be cases");
      assert.strictEqual(absent.terminalKind, "unavailable", "crosswalk absent must be an unavailable answer");
      assert.strictEqual(absent.capability, null, "an unavailable answer seals no capability");
      assert.strictEqual(present.terminalKind, "factual", "crosswalk present must be factual");
      assert.ok(present.capability, "the present-crosswalk contract must be registered");
    });
  }

  // ------------------------------------------------------------ sensitivity probes
  /**
   * These drive the EXTRACTOR and real SQL, not the equality helper. A probe that only
   * compared two literals would prove the comparison works on literals -- which is how the
   * previous suite's "at least one recognized token" check passed while proving nothing.
   *
   * Every probe asserts that a mutation is DETECTED. If detection ever stops working the
   * probe fails here, before any summary line, and the process exits non-zero.
   */
  const factual = observations.filter((o) => o.terminalKind === "factual" && o.sql);
  const cloneSchema = (s: Map<string, Set<string>>) => new Map([...s].map(([k, v]) => [k, new Set(v)] as const));

  check("probe: removing cleared_E is detected by the extractor AND by execution", () => {
    const o = factual.find((x) => x.branch === "clearance_type_breakdown");
    assert.ok(o, "clearance_type_breakdown must be a factual case");
    assert.ok((o!.requiredColumns["summary_clearance_detail"] ?? []).includes("cleared_E"), "cleared_E must be a declared required column");
    // (a) extractor: the observed contract must change when the column leaves the schema.
    const mutated = cloneSchema(SCHEMAS.nibrs);
    mutated.get("summary_clearance_detail")!.delete("cleared_E");
    const cols = columnsFor(o!.sql!, o!.emittedDependencies, mutated);
    assert.notDeepStrictEqual(cols, o!.requiredColumns, "extractor did not notice cleared_E was gone");
    assert.ok(!(cols["summary_clearance_detail"] ?? []).includes("cleared_E"));
    // (b) execution: the real SQL must stop running against a schema without the column.
    buildNibrs("nibrs-probe.db", ["summary_clearance_detail", "cleared_E"]);
    assert.strictEqual(executes(o!.sql!, "nibrs", path.join(FIXTURES, "nibrs-probe.db")), false,
      "SQL selecting cleared_E must fail against a schema lacking it");
  });

  // ---------------------------------------------------------------- execution-backed column probe
  /**
   * The predecessor probe here removed a value the EXTRACTOR produced and then asked the
   * EXTRACTOR whether its output changed. Nothing could ever make it fail. It is replaced by a
   * mechanism the extractor does not participate in: rename the column in the artifact and ask
   * SQLite whether the operation's real SQL still compiles.
   *
   *   declared  + rename breaks compilation  -> load-bearing, correctly declared
   *   declared  + rename changes nothing     -> OVERATTRIBUTED (this is how `CASE ... END`
   *                                             put `historical_agency.end` in the registry)
   *   undeclared + rename breaks compilation -> MISSED, the contract understates its needs
   */
  const writers = new Map<string, Database.Database>();
  function writerFor(file: string, artifact: string): Database.Database {
    const key = path.resolve(file);
    let db = writers.get(key);
    if (!db) {
      db = new Database(file);
      if (artifact === "nibrs") db.exec(`ATTACH DATABASE '${PATHS.rollup.replace(/\\/g, "/")}' AS rollup`);
      writers.set(key, db);
    }
    return db;
  }
  /** Rename table.column, run fn, always rename back. */
  function withRenamedColumn<T>(o: Observation, table: string, column: string, fn: () => T): T {
    const writer = writerFor(o.artifactPath, o.artifact);
    const qualified = table.startsWith("rollup.") ? `rollup."${table.slice(7)}"` : `main."${table}"`;
    const probe = `${column}__probe`;
    writer.exec(`ALTER TABLE ${qualified} RENAME COLUMN "${column}" TO "${probe}"`);
    try { return fn(); }
    finally { writer.exec(`ALTER TABLE ${qualified} RENAME COLUMN "${probe}" TO "${column}"`); }
  }
  /** True when the operation's SQL no longer compiles with that column renamed away. */
  function loadBearing(o: Observation, table: string, column: string): boolean {
    return withRenamedColumn(o, table, column, () => !executes(o.sql!, o.artifact, o.artifactPath));
  }
  const tablesDeclaring = (o: Observation, column: string) => o.emittedDependencies.filter((t) =>
    (SCHEMAS[o.artifact].get(t.replace(/^rollup\./, "")) ?? new Set()).has(column));
  /**
   * Rename the column on EVERY participating table that declares it.
   *
   * A single-table rename is not sound on its own: SQL name resolution rescues an unqualified
   * reference inside a subquery by binding it to an enclosing table instead. `d.ori IN (SELECT
   * ori FROM nibrs_consistent_reporters)` still compiles with that table's `ori` renamed, because
   * `ori` then resolves to the outer `d.ori` as a correlated reference -- so the single-table
   * probe reports a column the operation genuinely reads as unused. Renaming every candidate
   * removes the rescue and tests the column NAME the operation depends on.
   */
  function loadBearingAnywhere(o: Observation, column: string): boolean {
    const targets = tablesDeclaring(o, column);
    const applied: string[] = [];
    const writer = writerFor(o.artifactPath, o.artifact);
    const qualify = (t: string) => (t.startsWith("rollup.") ? `rollup."${t.slice(7)}"` : `main."${t}"`);
    try {
      for (const t of targets) {
        writer.exec(`ALTER TABLE ${qualify(t)} RENAME COLUMN "${column}" TO "${column}__probe"`);
        applied.push(t);
      }
      return !executes(o.sql!, o.artifact, o.artifactPath);
    } finally {
      for (const t of applied.reverse()) {
        writer.exec(`ALTER TABLE ${qualify(t)} RENAME COLUMN "${column}__probe" TO "${column}"`);
      }
    }
  }

  /**
   * The compiled program's SHAPE: which cursor and which column ordinal each step reads.
   *
   * `EXPLAIN QUERY PLAN` is too coarse to be a resolution oracle. It reports join order and
   * subquery correlation, so it only notices a rebinding that *changes* correlation status. When
   * the subquery is ALREADY correlated, the plans are byte-identical while the semantics change:
   *
   *   SELECT (SELECT x FROM inner_t i WHERE i.y = o.y) FROM outer_t o
   *
   * renaming `inner_t.x` rebinds `x` to `outer_t.x`, and both plans read
   * `SCAN o / CORRELATED SCALAR SUBQUERY / SCAN i`. The bytecode does distinguish them, because
   * the `Column` step reads a different cursor.
   *
   * Two operands are excluded so the oracle answers "did resolution change" and nothing else:
   *   - p4/p5/comment carry NAMES, so a pure rename would look like a change even for a column
   *     nothing reads -- and under `SELECT t.*` that would inflate every contract to the whole table.
   *   - `Transaction` p3 is the schema cookie, which ANY `ALTER` bumps. Left in, every probe
   *     reports a change and the whole mechanism reads as "everything is load-bearing".
   */
  type ExplainRow = { opcode: string; p1: number; p2: number; p3: number };
  function programShape(sql: string, artifact: string, file: string): string {
    const db = new Database(file, { readonly: true });
    try {
      if (artifact === "nibrs") db.exec(`ATTACH DATABASE '${PATHS.rollup.replace(/\\/g, "/")}' AS rollup`);
      return JSON.stringify((db.prepare(`EXPLAIN ${sql}`).all() as ExplainRow[])
        .filter((r) => r.opcode !== "Transaction")
        .map((r) => [r.opcode, r.p1, r.p2, r.p3]));
    } catch { return "<did not compile>"; } finally { db.close(); }
  }
  const basePlans = new Map<Observation, string>();
  const basePlan = (o: Observation) => {
    if (!basePlans.has(o)) basePlans.set(o, programShape(o.sql!, o.artifact, o.artifactPath));
    return basePlans.get(o)!;
  };
  /**
   * True when renaming ONE table's column changes how the operation resolves.
   *
   * Compilability alone is not enough in the direction that matters for omissions. SQL rescues an
   * unqualified reference inside a subquery by binding it to an enclosing table: with
   * `nibrs_consistent_reporters.ori` renamed, `d.ori IN (SELECT ori FROM nibrs_consistent_reporters)`
   * still compiles, because `ori` re-binds to the outer `d.ori`. A compile-only probe therefore
   * reports that column as unused, and an extractor that dropped it would stay green -- the very
   * blind spot the group probe was introduced to close for DECLARED columns, left open here.
   *
   * The rebinding is invisible to compilation but visible in the compiled PROGRAM, because the
   * step that reads the column reads a different cursor. Comparing program shape catches the
   * rescue without depending on fixture rows being lucky enough to expose the difference.
   *
   * `EXPLAIN QUERY PLAN` was tried first and is too coarse -- see programShape(). It only sees a
   * rebinding that changes a subquery's correlation status, so it misses every rebinding inside a
   * subquery that was already correlated.
   */
  function affectsResolution(o: Observation, table: string, column: string): boolean {
    const before = basePlan(o);
    return withRenamedColumn(o, table, column, () =>
      programShape(o.sql!, o.artifact, o.artifactPath) !== before);
  }
  /** Columns the operation reads from a table that `declared` leaves out. The real detection path. */
  function missedColumns(o: Observation, declared: Record<string, string[]>): string[] {
    const missed: string[] = [];
    for (const table of o.emittedDependencies) {
      const have = new Set(declared[table] ?? []);
      const all = SCHEMAS[o.artifact].get(table.replace(/^rollup\./, "")) ?? new Set<string>();
      for (const column of all) {
        if (have.has(column)) continue;
        if (affectsResolution(o, table, column)) missed.push(`${o.branch}: ${table}.${column}`);
      }
    }
    return missed;
  }

  check("probe: every DECLARED required column is load-bearing under execution", () => {
    const notUsedAtAll: string[] = [];
    const misattributed: string[] = [];
    let probed = 0;
    for (const o of factual) {
      for (const [table, cols] of Object.entries(o.requiredColumns)) {
        for (const column of cols) {
          probed += 1;
          // (a) does the operation depend on this column name at all?
          if (!loadBearingAnywhere(o, column)) { notUsedAtAll.push(`${o.branch}: ${table}.${column}`); continue; }
          // (b) attribution. Comparing RESOLUTION, not just compilability, decides this even when
          // another participating table declares the same name: the rescue that makes the SQL
          // still compile also changes the plan. An earlier version skipped those columns as
          // "inconclusive", which left attribution for the most collision-prone names -- `ori`,
          // `year`, `state` -- resting on the extractor alone.
          if (!affectsResolution(o, table, column)) misattributed.push(`${o.branch}: ${table}.${column}`);
        }
      }
    }
    assert.ok(probed > 200, `expected to probe every declared column, only probed ${probed}`);
    // Reported together on purpose. Asserting the categories one after another lets the first
    // failure hide the second, and a hidden category is one nobody can see stopped working.
    const problems = [
      ...notUsedAtAll.map((x) => `not read at all: ${x}`),
      ...misattributed.map((x) => `read, but not from that table: ${x}`),
    ];
    assert.deepStrictEqual(problems, [],
      `over-attributed declared columns (${problems.length}):\n  ${problems.join("\n  ")}`);
  });

  check("probe: no UNDECLARED column is load-bearing under execution", () => {
    const missed = factual.flatMap((o) => missedColumns(o, o.requiredColumns));
    assert.deepStrictEqual(missed, [],
      `columns the SQL depends on but the contract omits (${missed.length}):\n  ${missed.join("\n  ")}`);
  });

  check("probe: the resolution oracle is sound where EXPLAIN QUERY PLAN is not", () => {
    // Synthetic, because the production builders do not happen to emit every shape the oracle has
    // to survive. Each row states what the oracle MUST answer.
    //
    // A PROPERTY MATRIX, not six independent defenses against oracle downgrade. Measured, not
    // reasoned about -- by renaming each column and recording what each candidate oracle saw:
    //
    //   pin                                | compiles | planChg | shapeChg | noisyChg | pins
    //   -----------------------------------|----------|---------|----------|----------|--------------------
    //   1 already-correlated rebind        | yes      | NO      | yes      | yes      | shape over plan
    //   2 column nothing reads             | yes      | no      | no       | YES      | no false positive
    //   3 SELECT * re-export, unread       | yes      | no      | no       | YES      | no false positive
    //   4 SELECT * re-export, read         | NO       | -       | -        | -        | compile failure
    //   5 self-join, both aliases lose it  | NO       | -       | -        | -        | compile failure
    //   6 bare col, uncorrelated subquery  | yes      | YES     | yes      | yes      | rebind, either oracle
    //
    // So: 1 pin decides program shape over query-plan shape, 2 pin compile-failure detection,
    // 2 constrain false positives under rename/schema noise, and 1 guards rebind detection that
    // both oracles share. Downgrading to EXPLAIN QUERY PLAN fails exactly pin 1; leaving
    // `Transaction` in fails exactly pins 2 and 3. Pin 6 discriminates nothing between the two and
    // is a regression guard on the mechanism, not on the choice of it.
    const file = path.join(FIXTURES, "oracle-selftest.db");
    const db = new Database(file);
    db.exec(`
      CREATE TABLE outer_t (x TEXT, y TEXT);
      CREATE TABLE inner_t (x TEXT, y TEXT, unused TEXT);
      CREATE TABLE wide (a TEXT, b TEXT, c TEXT);
      CREATE TABLE selfref (x TEXT, y TEXT);
    `);
    db.close();
    const synthetic = (sql: string): Observation => ({
      branch: "oracle-selftest", source: "shr", artifact: "shr", family: null, terminalKind: "factual",
      prepDependencies: [], emittedDependencies: [], requiredColumns: {}, executed: true,
      sql, artifactPath: file,
    });
    const CORRELATED = "SELECT (SELECT x FROM inner_t i WHERE i.y = o.y) FROM outer_t o";
    const STAR = "WITH cte AS (SELECT w.* FROM wide w) SELECT a FROM cte";
    const CASES: [string, string, string, string, boolean][] = [
      ["a rebind inside an ALREADY-correlated subquery", CORRELATED, "inner_t", "x", true],
      ["a column nothing reads", CORRELATED, "inner_t", "unused", false],
      ["a column re-exported by SELECT * but unread downstream", STAR, "wide", "c", false],
      ["a column re-exported by SELECT * and read downstream", STAR, "wide", "a", true],
      // NOT a rebind: renaming hits both aliases of the one table, so there is nothing to rebind
      // to and the reference stops compiling. Pinned because that is the shape a self-join takes.
      ["a self-joined table where both aliases lose the column at once",
        "SELECT (SELECT x FROM selfref b WHERE b.y = a.y) FROM selfref a", "selfref", "x", true],
      ["a bare column in an uncorrelated subquery rebinding outward",
        "SELECT o.y FROM outer_t o WHERE o.y IN (SELECT y FROM inner_t)", "inner_t", "y", true],
    ];
    // Every pin is evaluated before anything is asserted. Looping with an assert inside stops at
    // the first wrong answer, so a second regressed pin would not be reported -- and these pins
    // guard DIFFERENT properties, so knowing which ones moved is the whole diagnostic value.
    const wrong = CASES
      .filter(([, sql, table, column, expected]) => affectsResolution(synthetic(sql), table, column) !== expected)
      .map(([label, , table, column, expected]) => `${label} (${table}.${column}): expected ${expected}`);
    assert.deepStrictEqual(wrong, [],
      `the resolution oracle answered wrongly for ${wrong.length} of ${CASES.length} pins:\n  ${wrong.join("\n  ")}`);
    // The specific reason EXPLAIN QUERY PLAN cannot be the oracle: identical plans, changed meaning.
    const planOf = (f: string) => {
      const handle = new Database(f, { readonly: true });
      try { return JSON.stringify(handle.prepare(`EXPLAIN QUERY PLAN ${CORRELATED}`).all()); }
      finally { handle.close(); }
    };
    const o = synthetic(CORRELATED);
    const planBefore = planOf(file);
    const planAfter = withRenamedColumn(o, "inner_t", "x", () => planOf(file));
    assert.strictEqual(planBefore, planAfter,
      "if the query plan now differs here, re-check whether the coarser oracle would do; the pin is stale");
  });

  check("probe: the omission detector catches a column dropped from a correlated subquery", () => {
    // A mutation test of missedColumns() itself, on the exact shape that defeats a compile-only
    // probe. Without this, the completeness assertion above could be silently unable to fail for
    // every unqualified reference the builders make inside a subquery.
    const o = factual.find((x) => x.branch === "continuous_reporters_victim");
    assert.ok(o, "continuous_reporters_victim must be a factual case");
    const table = "nibrs_consistent_reporters";
    assert.ok((o!.requiredColumns[table] ?? []).includes("ori"),
      `${table}.ori must be in the derived contract for this mutation to mean anything`);
    // Compilation alone cannot see it -- this is the blind spot, pinned so it cannot reopen.
    assert.strictEqual(loadBearing(o!, table, "ori"), false,
      "if a single-table rename now breaks compilation, the rescue is gone and this pin is stale");
    // Resolution can. Drop the column from a COPY of the contract and require the detector to find it.
    const mutated = { ...o!.requiredColumns, [table]: (o!.requiredColumns[table] ?? []).filter((c) => c !== "ori") };
    assert.deepStrictEqual(missedColumns(o!, mutated), [`${o!.branch}: ${table}.ori`],
      "the omission detector did not notice a column the operation reads through a correlated subquery");
  });

  check("probe: the rename probe restored every artifact schema", () => {
    for (const [file] of writers) {
      for (const [table, cols] of schemaOf(file)) {
        for (const c of cols) assert.ok(!c.endsWith("__probe"), `${file} ${table}.${c} was left renamed`);
      }
    }
  });
  for (const [, db] of writers) db.close();
  writers.clear();

  check("probe: an unused column changes neither the contract nor capability identity", () => {
    const o = factual.find((x) => x.branch === "clearance_type_breakdown")!;
    const mutated = cloneSchema(SCHEMAS.nibrs);
    mutated.get("summary_clearance_detail")!.add("column_no_operation_reads");
    const observed = columnsFor(o.sql!, o.emittedDependencies, mutated);
    assert.deepStrictEqual(observed, o.requiredColumns, "an unread column must not enter the contract");
    const restated: Observation = { ...o, requiredColumns: observed };
    assert.strictEqual(capabilityId(restated), capabilityId(o), "capability identity must be stable under an unused column");
  });

  check("probe: identical tables with different required columns are DISTINCT capabilities", () => {
    const byTables = new Map<string, Observation[]>();
    for (const o of factual) {
      const key = `${o.artifact}::${[...new Set([...o.prepDependencies, ...o.emittedDependencies])].sort().join("+")}`;
      byTables.set(key, [...(byTables.get(key) ?? []), o]);
    }
    const split = [...byTables.values()].filter((group) => new Set(group.map(capabilityId)).size > 1);
    assert.ok(split.length > 0, "expected at least one table set split by required columns");
    for (const group of split) {
      const ids = new Set(group.map(capabilityId));
      assert.strictEqual(ids.size, new Set(group.map((g) => JSON.stringify(g.requiredColumns))).size,
        "capability identity must track required columns exactly");
    }
    // Pinned example, so the split cannot silently disappear.
    const dir = factual.find((o) => o.branch === "shr:metadata-agency-directory");
    const year = factual.find((o) => o.branch === "shr:metadata-year-coverage");
    assert.ok(dir && year, "both SHR metadata operations must be factual cases");
    assert.deepStrictEqual(dir!.emittedDependencies, year!.emittedDependencies, "this pin requires identical tables");
    assert.notStrictEqual(capabilityId(dir!), capabilityId(year!), "same tables + different columns must be different capabilities");
  });

  // ================================================================ P1 corrections
  // Each check below corresponds to one P1 finding against 81fab50. They were written to
  // fail against that commit's behaviour and artifacts.

  // ---- P1-1: a fixture that cannot reach a contract is UNVERIFIED, not "unavailable" ----
  /**
   * Only these cases may record `unavailable`, and only because PRODUCTION takes that exit.
   * Every other non-factual case is a fixture that failed to reach the contract, which is an
   * unverified contract -- recording it as "unavailable" converted a false pass into a false
   * baseline, and dropped the shooting contract out of the count entirely.
   */
  const UNAVAILABLE_IN_PRODUCTION: Record<string, string> = {
    "hate_crime:metadata-agency-directory-county":
      "production hate_crime.db has no agency_county_crosswalk; entitySql takes the SQL-less exit",
  };
  check("P1-1: no case is recorded unavailable unless production takes that exit", () => {
    const wrong = observations
      .filter((o) => o.terminalKind === "unavailable" && !(o.branch in UNAVAILABLE_IN_PRODUCTION))
      .map((o) => `${o.branch}${o.note ? ` (${o.note})` : ""}`);
    assert.deepStrictEqual(wrong, [],
      `these are unverified fixtures, not production-unavailable contracts:\n  ${wrong.join("\n  ")}`);
  });
  check("P1-1: deterministic-shooting reaches its factual incidents+victims contract", () => {
    const o = observations.find((x) => x.branch === "route:deterministic_shooting");
    assert.ok(o, "the shooting route case must exist");
    assert.strictEqual(o!.terminalKind, "factual",
      `the shooting route never reached the factual exit (got ${o!.terminalKind})`);
    assert.deepStrictEqual([...o!.emittedDependencies].sort(), ["incidents", "victims"],
      `the shooting contract joins victims; observed ${o!.emittedDependencies.join(",") || "nothing"}`);
    assert.ok(o!.executed, "the shooting SQL must execute against the SHR artifact");
  });

  // ---- P1-2: capability identity is builder-declared, never family-derived ----
  check("P1-2: the artifacts prove a family cannot identify a capability", () => {
    const byFamily = new Map<string, Set<string>>();
    for (const o of factual) {
      const id = capabilityId(o);
      if (!o.family || !id) continue;
      byFamily.set(o.family, (byFamily.get(o.family) ?? new Set()).add(id));
    }
    const ambiguous = [...byFamily].filter(([, ids]) => ids.size > 1).map(([f, ids]) => `${f} -> ${ids.size}`);
    assert.ok(ambiguous.some((a) => a.startsWith("deterministic-nibrs-continuous-reporters")),
      `continuous-reporters must be observed carrying several contracts; ambiguous families: ${ambiguous.join(", ") || "none"}`);
  });
  check("P1-2: the plan resolves capability from the sealed token, not from the family", () => {
    const plan = fs.readFileSync(PLAN_FILE, "utf8");
    // Only the CODE the plan specifies is forbidden from calling it. Prose that names it in order
    // to rule it out is the record of why, and must survive -- including comments INSIDE code
    // blocks, which is why every code-shape check here strips them first. One of these checks
    // otherwise flagged its own explanatory comment.
    const code = planCode(plan);
    const offenders = code.filter((block) => /capabilityForFamily\s*\(/.test(block));
    assert.strictEqual(offenders.length, 0,
      `${offenders.length} planned code block(s) still call capabilityForFamily(); one family maps to as many as four contracts, so this cannot be truthful`);
    assert.ok(/sealPlanDerivation\(\s*(?:planFamily|family)\s*,\s*capability\s*,\s*sql\s*\)/.test(plan),
      "plan must seal the builder-declared capability into the token: sealPlanDerivation(family, capability, sql)");
    assert.ok(/verified\.capability/.test(plan),
      "plan must read the capability off the VERIFIED token");
    // Embed provenance: the capability must be a persisted column and the replay entry point must
    // take it, rather than recovering a family and looking a capability up from it.
    assert.ok(code.some((block) => /origin_capability/.test(block)),
      "plan must persist the capability column in embed provenance, not just the family");
    assert.ok(code.some((block) => /originIsVerified/.test(block) && /originCapability/.test(block)),
      "the embed creation path must decide what capability to persist, not only the family");
    const replay = code.find((block) => /resolveCapabilityFromPersistedOrigin/.test(block));
    assert.ok(replay, "plan must define the persisted-origin replay entry point");
    assert.ok(/originCapability/.test(replay!) && !/originPlanFamily/.test(replay!),
      "the persisted-origin path must resolve from the persisted capability, not from a plan family");
  });

  /**
   * The checks above test for named patterns, which is why a whole second identity model survived
   * them: short per-source labels (`specFor("shr", "incidents")`) feeding
   * `PROOF_CAPABILITY_SHR_INCIDENTS`. Those cannot coexist with structural capability ids, and no
   * amount of prose fixes them. These assertions check SHAPE across every code block instead.
   */
  check("P1-2: no planned code uses the superseded short-label identity model", () => {
    const plan = fs.readFileSync(PLAN_FILE, "utf8");
    const code = planCode(plan);
    /**
     * Top-level arguments of every `name(...)` call, respecting nesting and strings.
     *
     * A regex that stops at the first `)` miscounts, because a capability id contains parentheses:
     * `sealPlanDerivation("f", "shr::invented::nothing(x)", SQL)` looked like a two-argument call.
     */
    const callArgs = (text: string, name: string): string[][] => {
      const calls: string[][] = [];
      const pattern = new RegExp(`\\b${name}\\(`, "g");
      for (const m of text.matchAll(pattern)) {
        let depth = 1, quote = "", current = "", args: string[] = [];
        for (let i = m.index! + m[0].length; i < text.length && depth > 0; i += 1) {
          const ch = text[i];
          if (quote) { if (ch === quote) quote = ""; current += ch; continue; }
          if (ch === '"' || ch === "'" || ch === "`") { quote = ch; current += ch; continue; }
          if (ch === "(" || ch === "[" || ch === "{") depth += 1;
          else if (ch === ")" || ch === "]" || ch === "}") {
            depth -= 1;
            if (depth === 0) break;
          }
          if (ch === "," && depth === 1) { args.push(current.trim()); current = ""; continue; }
          current += ch;
        }
        if (current.trim()) args.push(current.trim());
        calls.push(args);
      }
      return calls;
    };
    // EXACT arity, not "not the arity that was wrong last time". Rejecting only >= 2 let a
    // zero-argument specFor through, and rejecting only === 2 let one- and four-argument seals
    // through -- the same "target the known failure" mistake these checks exist to catch.
    const wrongArity: string[] = [];
    for (const block of code) {
      for (const args of callArgs(block, "specFor")) {
        if (args.length !== 1) wrongArity.push(`specFor takes (capabilityId): specFor(${args.join(", ")})`);
      }
      for (const args of callArgs(block, "sealPlanDerivation")) {
        if (args.length !== 3) wrongArity.push(`sealPlanDerivation takes (family, capability, sql): sealPlanDerivation(${args.join(", ")})`);
      }
    }
    assert.deepStrictEqual(wrongArity, [],
      `planned code calls these with the wrong arity, which is how the short-label identity model survived (${wrongArity.length}):\n  ${wrongArity.join("\n  ")}`);
  });

  check("P1-2: capability flag names are derivable from the capability id", () => {
    const plan = fs.readFileSync(PLAN_FILE, "utf8");
    // Every PROOF_CAPABILITY_* example must be producible by the documented derivation. A
    // structural id contains `::`, `+`, `(`, `)` and `,`, so uppercasing it cannot yield
    // PROOF_CAPABILITY_SHR_INCIDENTS -- those examples belong to the abandoned label model.
    const derivation = plan.match(/export function envKeyForCapability[\s\S]{0,400}?\n\}/)?.[0];
    assert.ok(derivation, "the plan no longer documents how a capability flag name is derived");
    assert.ok(/digest|slug|hash/i.test(derivation!),
      "flag names are derived by uppercasing the capability, but a structural id cannot be uppercased into an identifier; the derivation must go through a stable digest");
    // The derivation must be CALLED, not merely declared. Searching for the bare name is satisfied
    // by `export function envKeyForCapability(...)` itself, so the declaration is subtracted out.
    const code2 = planCode(plan);
    const callSites = code2.reduce((n, block) => {
      const all = (block.match(/\benvKeyForCapability\s*\(/g) ?? []).length;
      const declarations = (block.match(/function\s+envKeyForCapability\s*\(/g) ?? []).length;
      return n + all - declarations;
    }, 0);
    assert.ok(callSites > 0, "the plan documents a flag derivation that none of its code calls");
    // Any flag name still written by hand must match what the derivation can produce. Short
    // labels like PROOF_CAPABILITY_SHR_INCIDENTS name capabilities that no longer exist and
    // cannot select a generated id.
    const literals = [...plan.matchAll(/PROOF_CAPABILITY_[A-Z0-9_]+/g)].map((m) => m[0]);
    const shaped = new RegExp(`^PROOF_CAPABILITY_(${["CURRENT", "HISTORICAL", "NIBRS", "SHR", "HATE_CRIME", "CRIME_DATA"].join("|")})_[A-F0-9]{8}$`);
    const stale = [...new Set(literals)].filter((name) => !shaped.test(name));
    assert.deepStrictEqual(stale, [],
      `these hand-typed flag names name capabilities that no longer exist (short labels from the abandoned identity model):\n  ${stale.join("\n  ")}`);
  });

  check("the plan's sourceHealthFor snippet keeps the disciplines its comments claim", () => {
    /**
     * The plan is a TEMPLATE that later tasks copy from, so a snippet whose comments describe
     * bounded retention while its executable lines call `traces.push` and `cache.set` directly
     * reintroduces the defect in whatever task copies it. Comments are not enforcement; these are.
     */
    const plan = fs.readFileSync(PLAN_FILE, "utf8");
    const snippet = planCode(plan).find((block) => /export function sourceHealthFor[\s\S]*?\)\s*:\s*SourceHealth\s*\{/.test(block));
    assert.ok(snippet, "the plan no longer contains a sourceHealthFor implementation snippet");
    assert.ok(/function pushTrace/.test(snippet!) && /function storeVerdict/.test(snippet!),
      "the snippet claims bounds but defines neither helper, so a copy of it has none");
    // The ban on raw writes applies to sourceHealthFor's OWN body -- the two helpers legitimately
    // call traces.push and cache.set; that is what makes them the single bounded write path.
    const body = snippet!.slice(snippet!.indexOf("export function sourceHealthFor"));
    assert.ok(!/\btraces\.push\(/.test(body),
      "sourceHealthFor writes a trace directly instead of through pushTrace, restoring an unbounded log");
    assert.ok(!/\bcache\.set\(/.test(body),
      "sourceHealthFor writes the cache directly instead of through storeVerdict, restoring unbounded retention");
    // Acquisition must sit INSIDE the containment block, not before it.
    const acquireAt = body.indexOf("spec.database.acquire()");
    const tryAt = body.indexOf("try {");
    assert.ok(acquireAt > tryAt && tryAt !== -1,
      "the snippet acquires the handle outside its try/catch, so a throwing provider propagates");
  });

  check("P1-2: the runtime reads the pinned flag key instead of re-deriving it", () => {
    const plan = fs.readFileSync(PLAN_FILE, "utf8");
    const code = planCode(plan);
    // Generation owns the derivation and the uniqueness check; the request path reads the pin.
    // Two implementations of one derivation is a drift the registry pin cannot prevent -- the
    // runtime would silently ignore it.
    // The IMPLEMENTATION, selected by shape: a signature-only declaration ends in `;` and
    // legitimately has no body. Taking "the first block that mentions sourceHealthFor" picked the
    // declaration and reported a defect that was not there.
    const bodies = code.filter((block) => /export function sourceHealthFor[\s\S]*?\)\s*:\s*SourceHealth\s*\{/.test(block));
    assert.ok(bodies.length > 0, "the plan no longer contains a sourceHealthFor implementation");
    for (const runtime of bodies) {
      assert.ok(/spec\.flagKey/.test(runtime),
        "sourceHealthFor must read spec.flagKey, the name pinned in the registry");
      assert.ok(!/envKeyForCapability\s*\(/.test(runtime),
        "sourceHealthFor re-derives the flag name instead of reading the pin, so the harness and the runtime hold separate implementations of it");
    }
  });

  // ---- P1-3: independent anchors for the column contract ----
  // The two execution probes above and the deriver will share a mechanism once this is fixed,
  // so these anchors are stated independently of BOTH: they name specific columns that the SQL
  // text itself settles.
  check("P1-3: a SQL keyword is never harvested as a column (CASE ... END)", () => {
    const offenders = factual
      .filter((o) => (o.requiredColumns["historical_agency"] ?? []).includes("end"))
      .map((o) => o.branch);
    assert.deepStrictEqual(offenders, [],
      `historical_agency.end came from CASE ... END, not from a column reference: ${offenders.join(", ")}`);
  });
  check("P1-3: a column is attributed only to the table the SQL reads it from", () => {
    // Both tables declare `population`; only one is read. Token intersection cannot tell them apart.
    const both = factual.filter((o) =>
      o.emittedDependencies.includes("historical_agency_crime") &&
      o.emittedDependencies.includes("historical_agency_population"));
    // Without this the check passes by measuring nothing the moment that pairing stops occurring.
    assert.ok(both.length > 0, "no case reads both historical_agency_crime and historical_agency_population");
    for (const o of both) {
      const crime = o.requiredColumns["historical_agency_crime"] ?? [];
      const pop = o.requiredColumns["historical_agency_population"] ?? [];
      const readsCrimePopulation = /\bhac?\.population\b|historical_agency_crime\.population/i.test(o.sql!);
      if (!readsCrimePopulation) {
        assert.ok(!crime.includes("population"),
          `${o.branch}: population attributed to historical_agency_crime, which the SQL never reads it from`);
      }
      assert.ok(pop.length > 0, `${o.branch}: historical_agency_population contributed no columns`);
    }
  });

  // ---- P1-4: non-structural fields are authored policy or null, never generated ----
  check("P1-4: the deriver never invents coverage, integrity, availability or receipt", () => {
    const raw = fs.readFileSync(REGISTRY_FILE, "utf8");
    assert.ok(!/observed-available/.test(raw),
      "availability is a constant the observation cannot know; it must be authored policy or null");
    assert.ok(!/"provisional:/.test(raw),
      "receipt identity was generated from the first emitted table; it must be authored ownership or null");
    assert.ok(!/<fixture>/.test(raw),
      "handlePath names a fixture, which is not a production contract field");
  });
  check("P1-4: authorization requires a well-FORMED policy, not merely non-null fields", () => {
    // "Not null" is not a schema. A placeholder of the right arity would authorize.
    const wellFormed = {
      coverage: { kind: "column", table: "incidents", yearColumn: "year" },
      integrity: ["generation alignment: MAX(year) of a = MAX(year) of b"],
      availability: { kind: "always" },
      receiptOwner: "scripts/import-shr.py",
      evidence: "cited from the importer that writes the table and the spec section requiring it",
    };
    assert.strictEqual(policyIsComplete(wellFormed), true, "a well-formed policy must be eligible");
    const malformed: Record<string, unknown>[] = [
      { ...wellFormed, coverage: {} },                              // no kind to discriminate on
      { ...wellFormed, coverage: { kind: "column", table: "incidents" } },   // no yearColumn
      { ...wellFormed, coverage: { kind: "none" } },                // no-year-dimension with no reason
      { ...wellFormed, coverage: { table: "incidents", yearColumn: "year" } },   // the old untagged shape
      // A derived hint riding in beside the decision: refused, not silently stripped.
      { ...wellFormed, coverage: { kind: "column", table: "incidents", yearColumn: "year", yearBearing: false } },
      { ...wellFormed, integrity: true },
      { ...wellFormed, integrity: [] },                             // no rule is not a rule
      { ...wellFormed, integrity: [""] },
      { ...wellFormed, availability: 1 },
      { ...wellFormed, availability: "always" },                    // the flat form is not the shape
      { ...wellFormed, availability: "conditional" },
      { ...wellFormed, availability: "conditional-on-artifact: requires a crosswalk" },
      { ...wellFormed, availability: { kind: "sort-of" } },
      { ...wellFormed, availability: { kind: "conditional" } },     // conditional with no condition
      { ...wellFormed, availability: { kind: "conditional", condition: "" } },
      { ...wellFormed, availability: { kind: "always", condition: "why?" } },
      { ...wellFormed, receiptOwner: false },
      { ...wellFormed, receiptOwner: "" },
      /**
       * Evidence is optional metadata now, so its LENGTH is no longer a defect -- demanding that
       * the policy owner prove their own judgment was the defect. Its TYPE still is.
       */
      { ...wellFormed, evidence: 42 },
      { coverage: {}, integrity: true, availability: 1, receiptOwner: false },
      // The condition must live inside availability, not beside it, or the pair can disagree.
      { ...wellFormed, availability: { kind: "conditional" }, availabilityCondition: "requires a crosswalk" },
    ];
    for (const policy of malformed) {
      assert.strictEqual(policyIsComplete(policy), false,
        `a malformed policy must NOT authorize: ${JSON.stringify(policy)}`);
    }
    assert.strictEqual(
      policyIsComplete({ ...wellFormed, availability: { kind: "conditional", condition: "requires agency_county_crosswalk in the artifact" } }),
      true, "a conditional availability carrying its condition is well-formed");
  });

  check("P1-4: every capability carries authored policy or is fail-closed", () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, Record<string, unknown>>;
    const policy = readPolicy();
    for (const [id, entry] of Object.entries(registry)) {
      assert.ok("policy" in entry, `${id} has no policy field`);
      assert.ok("authorizationEligible" in entry, `${id} does not state whether it may authorize`);
      const authored = policy[id] ?? null;
      assert.deepStrictEqual(entry.policy, authored,
        `${id}: policy must be exactly what capability-policy.json authors, or null`);
      assert.strictEqual(entry.authorizationEligible, capabilityAuthorizes(authored,
          declaredTables(entry.emittedDependencies as string[], entry.requiredColumns as Record<string, string[]>)),
        `${id}: a capability whose policy is absent or partly unauthored must fail closed`);
      if (authored) {
        for (const field of [...POLICY_FIELDS, "evidence"]) {
          assert.ok(field in authored, `${id} authored policy does not state ${field} (null is allowed, absent is not)`);
        }
        // A field that IS authored must be well formed even while others remain null, or a
        // malformed value sits in the file until the day it completes the entry and authorizes.
        assert.deepStrictEqual(policyShapeErrors(authored), [],
          `${id} authored policy is malformed: ${policyShapeErrors(authored).join("; ")}`);
      }
    }
    for (const id of Object.keys(policy)) {
      assert.ok(registry[id], `capability-policy.json authors policy for unknown capability ${id}`);
    }
  });

  check("P1-2: every capability's flag key is derivable and unique", () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, { artifact: string; flagKey: string }>;
    const byFlag = new Map<string, string[]>();
    for (const [id, entry] of Object.entries(registry)) {
      assert.strictEqual(entry.flagKey, envKeyForCapability(entry.artifact, id),
        `${id} has a flag key that its own id does not produce`);
      byFlag.set(entry.flagKey, [...(byFlag.get(entry.flagKey) ?? []), id]);
    }
    // The key is a TRUNCATED digest. A collision would let one variable gate two capabilities,
    // silently enabling probing for a contract nobody decided about.
    const collisions = [...byFlag].filter(([, ids]) => ids.length > 1)
      .map(([flag, ids]) => `${flag} <- ${ids.length} capabilities`);
    assert.deepStrictEqual(collisions, [], `flag key collisions:\n  ${collisions.join("\n  ")}`);
  });

  // ---- P1-5: the case list is derived from the builders ----
  /**
   * A role branch is a `{ table, offenseColumn, countColumn, countAlias }` config a builder
   * selects between. The handwritten case list could omit one silently: a fifth branch changes
   * neither the family set nor the seal-site count. These are read out of the builder source, so
   * an unexercised branch fails here.
   */
  type RoleBranch = { module: string; group: string; table: string; countColumn: string };
  function roleBranchesFromSource(): RoleBranch[] {
    const MODULES = ["lib/nibrs-scope-deterministic.ts", "lib/nibrs-deterministic-queries.ts"];
    const out: RoleBranch[] = [];
    for (const file of MODULES) {
      const src = fs.readFileSync(file, "utf8");
      // Each config literal, tagged with the nearest preceding declaration that owns it.
      for (const m of src.matchAll(/\{\s*table:\s*"([a-z_.]+)"[^}]*?countColumn:\s*"([a-z_]+)"/gi)) {
        const before = src.slice(0, m.index);
        const owner = [...before.matchAll(/(?:function|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g)].pop()?.[1] ?? "?";
        out.push({ module: path.basename(file), group: owner, table: m[1], countColumn: m[2] });
      }
    }
    return out;
  }
  /**
   * Families that select between the branches of a group, read from the builder that calls it.
   *
   * Guardrails are NOT all plain literals -- two builders seal through a ternary
   * (`guardrail: isShare ? "...-share" : "...-count"`). A literal-only scan finds no family for
   * those builders, which silently produces an empty requirement set: the check would pass by
   * measuring nothing. Both forms are read, and a group that resolves to no family fails.
   */
  function familiesUsingGroup(group: string): string[] {
    const MODULES = ["lib/nibrs-scope-deterministic.ts", "lib/nibrs-deterministic-queries.ts"];
    const families: string[] = [];
    for (const file of MODULES) {
      const src = fs.readFileSync(file, "utf8");
      for (const chunk of src.split(/\nexport function /).slice(1)) {
        if (!new RegExp(`\\b${group}\\s*[({\\[]`).test(chunk)) continue;
        for (const g of chunk.matchAll(/guardrail:\s*"([a-z0-9-]+)"/g)) families.push(g[1]);
        for (const g of chunk.matchAll(/guardrail:\s*[^?\n]+\?\s*"([a-z0-9-]+)"\s*:\s*"([a-z0-9-]+)"/g)) {
          families.push(g[1], g[2]);
        }
      }
    }
    return [...new Set(families)];
  }
  check("P1-5: every builder role branch is exercised by a case, for every family that selects it", () => {
    const branches = roleBranchesFromSource();
    assert.ok(branches.length >= 7, `expected the role branches to be readable from source, found ${branches.length}`);
    const uncovered: string[] = [];
    const requirements: string[] = [];
    for (const branch of branches) {
      const families = familiesUsingGroup(branch.group);
      assert.ok(families.length > 0,
        `role branch group '${branch.group}' resolved to no family, so it would require nothing`);
      for (const family of families) {
        requirements.push(`${family} x ${branch.table}.${branch.countColumn}`);
        const covered = factual.some((o) =>
          o.family === family &&
          o.emittedDependencies.includes(branch.table) &&
          (o.requiredColumns[branch.table] ?? []).includes(branch.countColumn));
        if (!covered) uncovered.push(`${family} x ${branch.table}.${branch.countColumn} (${branch.group})`);
      }
    }
    assert.ok(requirements.length >= 14,
      `only ${requirements.length} role-branch requirements were derived; the scan is too narrow to bite`);
    assert.deepStrictEqual(uncovered, [],
      `builder role branches with no case (${uncovered.length}):\n  ${uncovered.join("\n  ")}`);
  });

  // ---- P1-6: plan structure, and an async-scoped recording sink ----
  check("P1-6: the plan's task structure is intact", () => {
    const plan = fs.readFileSync(PLAN_FILE, "utf8");
    const task1 = plan.indexOf("### Task 1:");
    const task1a = plan.indexOf("### Task 1A:");
    const task2 = plan.indexOf("### Task 2:");
    assert.ok(task1 >= 0, "Task 1 has no heading of its own");
    assert.ok(task1a > task1, "Task 1A must follow Task 1, not contain it");
    assert.ok(task2 > task1a, "Task 2 must follow Task 1A");
    assert.ok(!/deliberately\s+absent/.test(plan),
      "the 'nibrs:rollup deliberately absent' text contradicts the later finding that rollup is reachable");
  });
  check("P1-6: the plan's inventory/registry equality accounts for the sweep-only capability", () => {
    const plan = fs.readFileSync(PLAN_FILE, "utf8");
    // The contradiction was an EXACT equality between the inventory and the registry, followed by
    // an assertion requiring an id that by design is not in the registry. Both cannot hold. The
    // fenced block carrying the equality must therefore name the sweep-only capability.
    const block = plan.split("```").find((chunk) => chunk.includes("inventory drifted from the derived registry"));
    assert.ok(block, "the plan no longer contains the inventory/registry equality assertion");
    // Scoped to the ASSERTION, not the block: the sweep-only constant is declared in the same
    // block, so searching the whole block would pass whether or not the equality actually uses it.
    const messageAt = block!.indexOf('"inventory drifted from the derived registry"');
    const assertion = block!.slice(block!.lastIndexOf("assert.deepStrictEqual(", messageAt), messageAt);
    assert.ok(/SWEEP_ONLY|national_monthly::sweep/.test(assertion),
      `the equality compares the inventory against the registry alone, while a later assertion requires a capability that is deliberately absent from the registry:\n${assertion.trim()}`);
  });
  await checkAsync("P1-6: concurrent recordings do not cross-contaminate", async () => {
    const a = new Database(PATHS.crime_data, { readonly: true });
    const b = new Database(PATHS.nibrs, { readonly: true });
    try {
      const [ra, rb] = await Promise.all([
        withRecordingAsync(async () => {
          await new Promise((r) => setTimeout(r, 15));
          a.prepare("SELECT ori FROM agencies LIMIT 1").all();
          return null;
        }),
        withRecordingAsync(async () => {
          await new Promise((r) => setTimeout(r, 5));
          b.prepare("SELECT ori FROM nibrs_consistent_reporters LIMIT 1").all();
          return null;
        }),
      ]);
      const paths = (e: Prepared[]) => [...new Set(e.map((x) => path.resolve(x.dbPath)))];
      assert.deepStrictEqual(paths(ra.entries), [path.resolve(PATHS.crime_data)],
        `a recording scope captured another scope's reads: ${paths(ra.entries).join(", ") || "nothing"}`);
      assert.deepStrictEqual(paths(rb.entries), [path.resolve(PATHS.nibrs)],
        `a recording scope captured another scope's reads: ${paths(rb.entries).join(", ") || "nothing"}`);
    } finally { a.close(); b.close(); }
  });

  check("no background SQLite errors occurred during the run", () => {
    assert.deepStrictEqual(backgroundErrors, [], backgroundErrors.join("\n"));
  });

  // TAXONOMY_DUMP_SQL=<path> writes every observed branch with its SQL, so the derivation can be
  // inspected against the SQL that produced it rather than against a summary of it.
  if (process.env.TAXONOMY_DUMP_SQL) {
    fs.writeFileSync(process.env.TAXONOMY_DUMP_SQL, JSON.stringify(observations, null, 2));
  }

  const factualCount = observations.filter((o) => o.terminalKind === "factual").length;
  const caps = new Set(observations.map(capabilityId).filter(Boolean)).size;
  console.log(`\noperation taxonomy: ${passed} passed, ${failed} failed`);
  console.log(`cases ${observations.length} (factual ${factualCount}) | operation-backed capabilities ${caps}`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => { console.log("HARNESS ERROR:", (e as Error).stack); process.exitCode = 1; })
  .finally(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Database.prototype as any).prepare = originalPrepare;
    console.error = realConsoleError;
    try { fs.rmSync(FIXTURES, { recursive: true, force: true }); } catch { /* best effort */ }
  });
