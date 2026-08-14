/**
 * Stage 2A operation-taxonomy regression.
 *
 * Derives each deterministic operation's dependency surface by EXECUTING its builder against a
 * real SQLite handle and recording what it touched. Static extraction failed three times
 * (variable seals, ternary seals, helper reads); an observation cannot miss those.
 *
 * The FIRST version of this suite reported 66/66 while proving very little. Each weakness is
 * now an explicit assertion, because a green suite over vacuous checks manufactures confidence:
 *
 *   - required columns were "at least one recognized token" -> exact set comparison, with
 *     sensitivity probes that FAIL if the comparison stops biting
 *   - a missing case printed a NOTE                         -> denominator equality assertion
 *   - families were never enumerated independently          -> re-derived from source here
 *   - a route case passed on any matching guardrail         -> factual exits now require
 *     non-null SQL, the expected tables, AND SQL that executes
 *   - prepare() recorded bare SQL globally                  -> {dbPath, sql}, scoped per case,
 *     with all module initialization completed before any case records
 *
 * TAXONOMY_DERIVE=1 regenerates the data files. Derived output is only trustworthy because the
 * probes prove the assertions detect change.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const CASES_FILE = path.join(DATA_DIR, "operation-cases.json");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
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
let sink: Prepared[] | null = null;
const originalPrepare = Database.prototype.prepare;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Database.prototype as any).prepare = function (sql: string, ...rest: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (sink) sink.push({ dbPath: String((this as any).name ?? ""), sql });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalPrepare as any).call(this, sql, ...rest);
};
/** Recording is scoped to one case; nothing outside the callback can contribute. */
function withRecording<T>(fn: () => T): { value: T; entries: Prepared[] } {
  const entries: Prepared[] = [];
  sink = entries;
  try { return { value: fn(), entries }; }
  finally { sink = null; }
}
async function withRecordingAsync<T>(fn: () => Promise<T>): Promise<{ value: T; entries: Prepared[] }> {
  const entries: Prepared[] = [];
  sink = entries;
  try { return { value: await fn(), entries }; }
  finally { sink = null; }
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
const artifactOf = (s: string) => (["current", "historical", "crime_data"].includes(s) ? "crime_data" : s);

function cteNames(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/(?:WITH|,)\s+([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)) out.add(m[1].toLowerCase());
  return out;
}
function tablesIn(sql: string, schema: Map<string, Set<string>>): string[] {
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
function columnsFor(sql: string, tables: string[], schema: Map<string, Set<string>>): Record<string, string[]> {
  const tokens = new Set((sql.match(/[a-z_][a-z0-9_]*/gi) ?? []).map((t) => t.toLowerCase()));
  const out: Record<string, string[]> = {};
  for (const t of tables) {
    const declared = schema.get(t.replace(/^rollup\./, ""));
    if (declared) out[t] = [...declared].filter((c) => tokens.has(c.toLowerCase())).sort();
  }
  return out;
}

// ---------------------------------------------------------------- results
type CaseResult = { family: string; sql: string | null } | null;
type Observation = {
  branch: string; source: string; artifact: string;
  family: string | null; terminalKind: "factual" | "unavailable" | "none";
  prepDependencies: string[]; emittedDependencies: string[];
  requiredColumns: Record<string, string[]>;
  coverage: string | null; executed: boolean; note?: string; sql: string | null;
};
const observations: Observation[] = [];
let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 5).join("\n        ")}`); }
}

/** A dependency contract that cannot execute is not a contract. */
function executes(sql: string, artifact: string, override?: string): boolean {
  const file = override ?? (artifact === "nibrs" ? PATHS.nibrs : artifact === "shr" ? PATHS.shr
    : artifact === "hate_crime" ? PATHS.hate_crime : PATHS.crime_data);
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
  const coverageTable = emitted.find((t) => (cols[t] ?? []).includes("year")) ?? null;
  observations.push({
    branch, source, artifact,
    family: result?.family ?? null,
    // Classified by TABLES READ, not by SQL presence. The unavailable exits return a
    // synthetic `SELECT '...' AS answer` (lib/metadata-coverage.ts:247), so sql-presence
    // alone counts a canned refusal as a factual data claim and mints a phantom capability.
    terminalKind: sql && emitted.length > 0 ? "factual" : result ? "unavailable" : "none",
    prepDependencies: prep, emittedDependencies: emitted, requiredColumns: cols,
    coverage: coverageTable ? `${coverageTable}.year` : null,
    executed: sql && emitted.length > 0 ? executes(sql, artifact, only) : false,
    note, sql,
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
    assert.strictEqual(sites, 12, "seal-site count moved; re-run the two-pass enumeration");
    const families = new Set<string>();
    for (const f of ROUTES) for (const m of fs.readFileSync(f, "utf8").matchAll(/sealPlanDerivation\(\s*"([a-z0-9-]+)"/g)) families.add(m[1]);
    for (const f of ["lib/nibrs-deterministic-queries.ts", "lib/nibrs-rollup-deterministic.ts", "lib/nibrs-scope-deterministic.ts", "lib/current-indexed-state-deterministic.ts", "lib/multi-city-deterministic.ts", "lib/historical-deterministic-queries.ts"]) {
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
    const cases: Record<string, unknown> = {};
    const registry: Record<string, unknown> = {};
    for (const o of observations) {
      const id = capabilityId(o);
      cases[o.branch] = { family: o.family, terminalKind: o.terminalKind, capability: id };
      if (id && !registry[id]) {
        registry[id] = {
          artifact: o.artifact,
          handlePath: `<fixture>/${path.basename(ARTIFACT_PATHS[o.artifact][0])}`,
          prepDependencies: o.prepDependencies,
          emittedDependencies: o.emittedDependencies,
          requiredColumns: o.requiredColumns,
          coverage: o.coverage,
          integrity: o.artifact === "crime_data" && o.emittedDependencies.includes("historical_agency_crime")
            ? ["agency_year_reliability alignment (ori,year); single algorithm_version"]
            : o.emittedDependencies.some((t) => t.startsWith("rollup."))
              ? ["inspectNibrsRollupAvailability preflight; artifact coherence"] : [],
          availability: "observed-available",
          receiptIdentity: `provisional:${o.artifact}:${o.emittedDependencies[0] ?? "none"}`,
        };
      }
    }
    fs.writeFileSync(CASES_FILE, JSON.stringify(cases, null, 2));
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
    console.log(`derived ${Object.keys(cases).length} cases, ${Object.keys(registry).length} capabilities`);
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
    check("every registry capability carries a complete contract", () => {
      for (const [id, c] of Object.entries(REGISTRY)) {
        for (const field of ["artifact", "handlePath", "prepDependencies", "emittedDependencies", "requiredColumns", "coverage", "integrity", "availability", "receiptIdentity"]) {
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

  check("probe: every declared required column is load-bearing", () => {
    let checked = 0;
    for (const o of factual) {
      const schema = SCHEMAS[o.artifact];
      for (const [table, cols] of Object.entries(o.requiredColumns)) {
        for (const column of cols) {
          const mutated = cloneSchema(schema);
          mutated.get(table.replace(/^rollup\./, ""))?.delete(column);
          const observed = columnsFor(o.sql!, o.emittedDependencies, mutated);
          assert.notDeepStrictEqual(observed, o.requiredColumns,
            `${o.branch}: removing ${table}.${column} produced an identical contract, so it is not load-bearing`);
          checked += 1;
        }
      }
    }
    assert.ok(checked > 200, `expected to probe every declared column, only probed ${checked}`);
  });

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

  check("no background SQLite errors occurred during the run", () => {
    assert.deepStrictEqual(backgroundErrors, [], backgroundErrors.join("\n"));
  });

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
