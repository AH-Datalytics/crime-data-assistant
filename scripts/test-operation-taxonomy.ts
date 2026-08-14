/**
 * Stage 2A operation-taxonomy regression.
 *
 * Derives every deterministic operation's dependency surface by EXECUTING its builder against
 * a real SQLite handle and recording what it actually touched -- never by reading SQL strings
 * out of the source. Three successive rounds of static extraction each missed builders reached
 * through a variable, a ternary, or a shared helper, and each produced a confidently wrong
 * inventory. An observation cannot miss those.
 *
 * Two surfaces are captured per branch:
 *   1. PREPARATION-TIME reads -- statements the builder/resolver prepared while deciding and
 *      constructing, captured by wrapping Database.prototype BEFORE lib is imported. Five
 *      capabilities read tables here that never appear in their SQL; the Historical scorecard
 *      reads live RTCI tables this way.
 *   2. EMITTED-SQL reads -- tables and columns named by the SQL the builder returned.
 *
 * Coverage is asserted, never inferred: each case must reach its expected plan family AND the
 * expected capability (artifact + preparation ∪ emitted table set). A builder that returns
 * null, or a different family, or a different dependency set, FAILS. Do not "fix" a failure by
 * relaxing an expectation -- either the fixture is wrong or the product changed.
 *
 * Fixtures are synthetic rows over production-derived DDL (including indexes, which several
 * builders require via INDEXED BY). No production data.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const DDL_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), "op-taxonomy-"));

// ---------------------------------------------------------------- instrumentation (first)
const prepared: string[] = [];
let recording = false;
const originalPrepare = Database.prototype.prepare;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Database.prototype as any).prepare = function (sql: string, ...rest: unknown[]) {
  if (recording) prepared.push(sql);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalPrepare as any).call(this, sql, ...rest);
};

// ---------------------------------------------------------------- fixtures
const YEARS = [2019, 2020, 2021, 2022, 2023];
const OFFENSES = ["09A", "11A", "120", "13A", "220", "23H", "240"];
const PERSON = ["09A", "11A", "13A"];

function fresh(name: string, ddl: string, dropMatching?: RegExp): Database.Database {
  const file = path.join(FIXTURES, name);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  const source = fs.readFileSync(path.join(DDL_DIR, ddl), "utf8");
  db.exec(dropMatching ? source.split(";").filter((s) => !dropMatching.test(s)).join(";") : source);
  return db;
}

function buildFixtures() {
  // --- NIBRS. city is UPPERCASE in production and normalizeCityLiteral() uppercases before
  // matching (lib/nibrs-city-aliases.ts:22); a title-cased fixture silently resolves
  // not_in_source. Schema convention, not data.
  const nibrs = fresh("nibrs.db", "nibrs.ddl.sql");
  const agency = nibrs.prepare("INSERT INTO agencies (ori, year, state_code, state, city, pop_group, country_division, covered_flag, agency_indicator, population, agency_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const completeness = nibrs.prepare("INSERT INTO nibrs_agency_completeness (ori, year, months_reported, total_offenses) VALUES (?,?,?,?)");
  const reporters = nibrs.prepare("INSERT INTO nibrs_consistent_reporters (start_year, end_year, ori, years_required) VALUES (?,?,?,?)");
  const xwalk = nibrs.prepare("INSERT INTO agency_county_crosswalk (ori, ori9, agency_name, state, fips_state_code, fips_county_code, county_fips, county_name, county_key, source) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const juvenile = nibrs.prepare("INSERT INTO summary_juvenile_offender_incidents (year, month, state, ori, offense_scope, incident_count) VALUES (?,?,?,?,?,?)");
  const clearType = nibrs.prepare("INSERT INTO summary_clearance_type (year, month, state, ori, ucr_offense_code, total_offenses, cleared_by_arrest, cleared_exceptional) VALUES (?,?,?,?,?,?,?,?)");
  const clearDetail = nibrs.prepare("INSERT INTO summary_clearance_detail (year, state, ori, ucr_offense_code, cleared_by_arrest, cleared_A, cleared_B, cleared_C, cleared_D, cleared_E, total_offenses) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const cityMonthly = nibrs.prepare("INSERT INTO summary_city_monthly (year, month, state, ori, ucr_offense_code, offense_count, cleared_count) VALUES (?,?,?,?,?,?,?)");
  const victimCity = nibrs.prepare("INSERT INTO summary_victim_city_monthly (year, month, state, ori, ucr_offense_code, victim_count) VALUES (?,?,?,?,?,?)");
  const victimState = nibrs.prepare("INSERT INTO summary_victim_state_monthly (state, year, month, ucr_offense_code, victim_count) VALUES (?,?,?,?,?)");
  const circumstance = nibrs.prepare("INSERT INTO summary_victim_circumstance (ori, year, ucr_offense_code, circumstance_code, victim_count, state) VALUES (?,?,?,?,?,?)");
  const victimDemo = nibrs.prepare("INSERT INTO summary_victim_demographics (ori, year, ucr_offense_code, weapon_category, race, sex, age_group, ethnicity, victim_count, state) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const offenderDemo = nibrs.prepare("INSERT INTO summary_offender_demographics (ori, year, ucr_offense_code, weapon_category, race, sex, age_group, ethnicity, offender_count, state) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const arresteeDemo = nibrs.prepare("INSERT INTO summary_arrestee_demographics (ori, year, ucr_arrest_offense, weapon_category, race, sex, age_group, ethnicity, arrestee_count, state) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const year of YEARS) {
    agency.run("TX0010000", year, 48, "TX", "AUSTIN", "1", "7", 0, "City", 950000, "City");
    agency.run("TX0020000", year, 48, "TX", "DALLAS", "1", "7", 0, "City", 1300000, "City");
    agency.run("AZ0070000", year, 4, "AZ", "PHOENIX", "1", "8", 0, "City", 1600000, "City");
    for (const ori of ["TX0010000", "TX0020000", "AZ0070000"]) completeness.run(ori, year, 12, 5000);
    for (const ori of ["TX0010000", "TX0020000"]) {
      juvenile.run(year, 1, "TX", ori, "violent", 12);
      circumstance.run(ori, year, "13A", "01", 20, "TX");
      for (const offense of OFFENSES) {
        clearType.run(year, 1, "TX", ori, offense, 100, 40, 5);
        clearDetail.run(year, "TX", ori, offense, 40, 10, 8, 7, 9, 6, 100);
        cityMonthly.run(year, 1, "TX", ori, offense, 100, 40);
      }
      for (const offense of PERSON) victimCity.run(year, 1, "TX", ori, offense, 55);
      for (const race of ["W", "B", "A"]) {
        for (const offense of PERSON) {
          victimDemo.run(ori, year, offense, "firearm", race, "M", "Under 18", "N", 11, "TX");
          offenderDemo.run(ori, year, offense, "firearm", race, "M", "Under 18", "N", 9, "TX");
        }
        arresteeDemo.run(ori, year, "09A", "firearm", race, "M", "Under 18", "N", 7, "TX");
      }
    }
    for (const offense of OFFENSES) victimState.run("TX", year, 1, offense, 500);
  }
  for (const ori of ["TX0010000", "TX0020000"]) reporters.run(2019, 2023, ori, 5);
  xwalk.run("TX0010000", "TX0010000", "AUSTIN", "TX", 48, 453, "48453", "Travis", "TRAVIS", "seed");
  xwalk.run("AZ0070000", "AZ0070000", "PHOENIX", "AZ", 4, 13, "04013", "Maricopa", "MARICOPA", "seed");
  xwalk.run("TX0020000", "TX0020000", "DALLAS", "TX", 48, 113, "48113", "Dallas", "DALLAS", "seed");
  nibrs.close();

  const rollup = fresh("nibrs_rollups.db", "rollup.ddl.sql");
  const rs = rollup.prepare("INSERT INTO state_summary_arrestee_demographics (state, year, ucr_arrest_offense, weapon_category, race, sex, age_group, ethnicity, arrestee_count) VALUES (?,?,?,?,?,?,?,?,?)");
  const rn = rollup.prepare("INSERT INTO national_summary_arrestee_demographics (state, year, ucr_arrest_offense, weapon_category, race, sex, age_group, ethnicity, arrestee_count) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const year of YEARS) for (const race of ["W", "B", "A"]) {
    rs.run("TX", year, "09A", "firearm", race, "M", "Under 18", "N", 40);
    rn.run(null, year, "09A", "firearm", race, "M", "Under 18", "N", 900);
  }
  rollup.close();

  const shr = fresh("shr.db", "shr.ddl.sql");
  const inc = shr.prepare("INSERT INTO incidents (id, year, month, state, state_name, ori, agency, population, division, homicide_type, situation, weapon, weapon_group, relationship, relationship_group, circumstance, circumstance_group, sub_circumstance, action_type, incident_num, off_age, off_age_num, off_sex, off_race, off_ethnicity, agency_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const vic = shr.prepare("INSERT INTO victims (id, incident_id, victim_num, age, age_num, sex, race, ethnicity) VALUES (?,?,?,?,?,?,?,?)");
  const sx = shr.prepare("INSERT INTO agency_county_crosswalk (ori, ori9, agency_name, state, fips_state_code, fips_county_code, county_fips, county_name, county_key, source) VALUES (?,?,?,?,?,?,?,?,?,?)");
  let id = 1;
  for (const year of YEARS) for (const [ori, name] of [["TX0010000", "Austin"], ["TX0020000", "Dallas"]]) {
    inc.run(id, year, 1, "TX", "Texas", ori, name, 950000, "West South Central", "Murder",
      "Single victim/single offender", "Handgun", "Firearm", "Acquaintance", "Acquaintance",
      "Argument", "Argument", null, "Normal", 1, "30", 30, "M", "W", "N", "City");
    vic.run(id, id, 1, "25", 25, "M", "B", "N");
    id += 1;
  }
  sx.run("TX0010000", "TX0010000", "AUSTIN", "TX", 48, 453, "48453", "Travis", "TRAVIS", "seed");
  shr.close();

  // Hate Crime WITHOUT agency_county_crosswalk, matching production: the county operation
  // takes the SQL-less unavailable exit. Conditionally unavailable, NOT structurally
  // unhealthy -- the builder decides at runtime.
  const hc = fresh("hate_crime.db", "hc.ddl.sql");
  const hi = hc.prepare("INSERT INTO hate_crime_incidents (id, year, state, state_name, ori, agency_name, population, pop_group, incident_number, incident_date, data_source, quarter, total_individual_victims, total_offenders, offender_race, offender_ethnicity, offense_group, offense_code, offense_name, offense_victims, location, bias_code, bias_desc, bias_category, victim_types, adult_victims, juvenile_victims, adult_offenders, juvenile_offenders) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const hp = hc.prepare("INSERT INTO hate_crime_participation (year, state, total_agencies, reporting_agencies, total_incidents, total_victims) VALUES (?,?,?,?,?,?)");
  let hid = 1;
  for (const year of YEARS) {
    hi.run(hid, year, "TX", "Texas", "TX0010000", "Austin PD", 950000, "1", `INC${hid}`, `${year}-01-15`, "SRS", 1, 1, 1,
      "W", "N", "Crime Against Person", "13A", "Aggravated Assault", 1, "Highway", "43",
      "Anti-Black or African American", "Race/Ethnicity/Ancestry", "Individual", 1, 0, 1, 0);
    hp.run(year, "TX", 1000, 800, 120, 140);
    hid += 1;
  }
  hc.close();

  const cd = fresh("crime_data.db", "crime_data.ddl.sql");
  const cdAgency = cd.prepare("INSERT INTO agencies (ori, agency, state, type, total_months, national_sample) VALUES (?,?,?,?,?,?)");
  const cdMonthly = cd.prepare("INSERT INTO agency_monthly (ori, agency, state, type, year, month, offense, count) VALUES (?,?,?,?,?,?,?,?)");
  const cdPop = cd.prepare("INSERT INTO agency_population (ori, year, population) VALUES (?,?,?)");
  const cdSample = cd.prepare("INSERT INTO sample_agencies (ori, agency, state, type) VALUES (?,?,?,?)");
  const cdNational = cd.prepare("INSERT INTO national_monthly (year, month, offense, count, agency_count) VALUES (?,?,?,?,?)");
  const cdHistAgency = cd.prepare("INSERT INTO historical_agency (ori, agency, state, type) VALUES (?,?,?,?)");
  // The agency scorecard selects every offense AND every clearance column and joins
  // population (agency-scorecard.ts:195); a partial row yields no card at all.
  const cdHistCrime = cd.prepare("INSERT INTO historical_agency_crime (ori, year, population, violent, murder, rape, robbery, assault, property, burglary, theft, motor_vehicle_theft) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const cdHistPop = cd.prepare("INSERT INTO historical_agency_population (ori, year, population) VALUES (?,?,?)");
  const cdHistClear = cd.prepare("INSERT INTO historical_agency_clearance (ori, year, violent_clr, murder_clr, rape_clr, robbery_clr, assault_clr, property_clr, burglary_clr, theft_clr, motor_vehicle_theft_clr) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const cdStaffing = cd.prepare("INSERT INTO historical_staffing (ori, year, all_total, officer_total, civilian_total) VALUES (?,?,?,?,?)");
  // Aggregate scorecards require BOTH the count and the rate column of every
  // AGGREGATE_COMPONENT to be non-null (historical-scorecard.ts:194-204); a row missing any
  // rate is skipped as incomplete and the card reports unavailable.
  const cdStateNat = cd.prepare(
    "INSERT INTO historical_state_national (state, year, population, murder, murder_rate, rape, rape_rate, robbery, robbery_rate, aggravated_assault, aggravated_assault_rate, burglary, burglary_rate, theft, theft_rate, auto_theft, auto_theft_rate) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const cdRel = cd.prepare("INSERT INTO agency_year_reliability (ori, year, kind, source, columns_json, evidence_json, algorithm_version, generated_at) VALUES (?,?,?,?,?,?,?,?)");
  const cdXwalk = cd.prepare("INSERT INTO agency_county_crosswalk (ori, ori9, agency_name, state, fips_state_code, fips_county_code, county_fips, county_name, county_key, source) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const CITIES: [string, string, string][] = [["TX0010000", "Austin", "TX"], ["TX0020000", "Dallas", "TX"], ["TX1010000", "Houston", "TX"], ["OH0480000", "Toledo", "OH"]];
  for (const [ori, name, state] of CITIES) {
    cdAgency.run(ori, name, state, "City", 96, 1);
    cdSample.run(ori, name, state, "City");
    // Production convention: agency is Title Case, state and type lowercase. The scorecard
    // matches ha.agency against the resolver's candidate name verbatim
    // (agency-scorecard.ts:148), so a lowercased fixture never matches.
    cdHistAgency.run(ori, name, state.toLowerCase(), "city");
    cdXwalk.run(ori, ori, name, state, 48, 453, "48453", "Travis", "TRAVIS", "seed");
  }
  for (let year = 2015; year <= 2024; year += 1) {
    for (const [ori] of CITIES) {
      cdPop.run(ori, year, 900000);
      cdHistCrime.run(ori, year, 900000, 4000, 40, 60, 700, 3200, 20000, 4000, 14000, 2000);
      cdHistPop.run(ori, year, 900000);
      cdHistClear.run(ori, year, 1200, 20, 15, 30, 400, 4000, 800, 2800, 400);
      cdStaffing.run(ori, year, 2400, 1800, 600);
      if (year >= 2017) for (let month = 1; month <= 12; month += 1) {
        cdMonthly.run(ori, "x", "TX", "City", year, month, "murder", 3);
      }
      cdRel.run(ori, year, "partial-year", "seed", "[]", "{}", "1.0.0-seed", `${year}-01-01`);
    }
    for (const state of ["Texas", "California", "United States"]) {
      cdStateNat.run(state, year, 29000000, 1400, 4.8, 1500, 5.2, 3000, 10.3, 9000, 31.0, 20000, 69.0, 60000, 207.0, 8000, 27.6);
    }
    if (year >= 2017) for (let month = 1; month <= 12; month += 1) cdNational.run(year, month, "murder", 900, 700);
  }
  cd.close();

  fresh("query_log.db", "query_log.ddl.sql").close();
}

buildFixtures();

process.env.NIBRS_DB_PATH = path.join(FIXTURES, "nibrs.db");
process.env.NIBRS_ROLLUP_DB_PATH = path.join(FIXTURES, "nibrs_rollups.db");
process.env.SHR_DB_PATH = path.join(FIXTURES, "shr.db");
process.env.HATE_CRIME_DB_PATH = path.join(FIXTURES, "hate_crime.db");
process.env.RTCI_DB_PATH = path.join(FIXTURES, "crime_data.db");
process.env.QUERY_LOG_DB_PATH = path.join(FIXTURES, "query_log.db");

// ---------------------------------------------------------------- schema knowledge
function tablesAndColumns(file: string): Map<string, Set<string>> {
  const db = new Database(file, { readonly: true });
  const out = new Map<string, Set<string>>();
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]) {
    out.set(row.name, new Set((db.prepare(`PRAGMA table_info(${row.name})`).all() as { name: string }[]).map((c) => c.name)));
  }
  db.close();
  return out;
}
const SCHEMAS = {
  nibrs: tablesAndColumns(path.join(FIXTURES, "nibrs.db")),
  rollup: tablesAndColumns(path.join(FIXTURES, "nibrs_rollups.db")),
  shr: tablesAndColumns(path.join(FIXTURES, "shr.db")),
  hate_crime: tablesAndColumns(path.join(FIXTURES, "hate_crime.db")),
  crime_data: tablesAndColumns(path.join(FIXTURES, "crime_data.db")),
};

/**
 * Artifact a logical source reads. current AND historical both live in crime_data.db;
 * mapping them to nothing silently fell back to the NIBRS schema and extracted zero tables,
 * corrupting an entire derivation pass. Explicit, and self-tested below.
 */
function schemaFor(source: string): Map<string, Set<string>> {
  if (source === "nibrs") return new Map([...SCHEMAS.nibrs, ...SCHEMAS.rollup]);
  if (source === "shr") return SCHEMAS.shr;
  if (source === "hate_crime") return SCHEMAS.hate_crime;
  return SCHEMAS.crime_data;
}

function cteNames(sql: string): Set<string> {
  const names = new Set<string>();
  for (const m of sql.matchAll(/(?:WITH|,)\s+([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)) names.add(m[1].toLowerCase());
  return names;
}
function tablesIn(sql: string, schema: Map<string, Set<string>>): string[] {
  const ctes = cteNames(sql);
  const found = new Set<string>();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+((?:rollup|main)\.)?([a-z_][a-z0-9_]*)/gi)) {
    const qualifier = (m[1] ?? "").replace(".", "").toLowerCase();
    const name = m[2];
    if (ctes.has(name.toLowerCase())) continue;
    if (schema.has(name)) found.add(qualifier === "rollup" ? `rollup.${name}` : name);
    else if (qualifier === "rollup") found.add(`rollup.${name}`);
  }
  return [...found].sort();
}
function columnsIn(sql: string, table: string, schema: Map<string, Set<string>>): string[] {
  const declared = schema.get(table.replace(/^rollup\./, ""));
  if (!declared) return [];
  const tokens = new Set((sql.match(/[a-z_][a-z0-9_]*/gi) ?? []).map((t) => t.toLowerCase()));
  return [...declared].filter((c) => tokens.has(c.toLowerCase())).sort();
}

const EXPECTED: Record<string, { family: string; capability: string; artifact: string; tables: string[]; prepOnly: string[] }> =
  JSON.parse(fs.readFileSync(path.join(DDL_DIR, "expected-capabilities.json"), "utf8"));

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${(error as Error).message}`); }
}

const ARTIFACT = (source: string) => (["current", "historical", "crime_data"].includes(source) ? "crime_data" : source);

function assess(source: string, branch: string, reached: string | null, sql: string | null, note?: string) {
  const expect = EXPECTED[branch];
  check(branch, () => {
    assert.ok(expect, `${branch} has no entry in expected-capabilities.json`);
    assert.strictEqual(reached, expect.family, `expected family ${expect.family}, reached ${reached ?? "null"}${note ? ` (${note})` : ""}`);
    const schema = schemaFor(source);
    const prep = tablesIn(prepared.join("\n;\n"), schema);
    const emitted = sql ? tablesIn(sql, schema) : [];
    const tables = [...new Set([...prep, ...emitted])].sort();
    assert.deepStrictEqual(tables, expect.tables, `dependency set changed for ${expect.capability}`);
    assert.strictEqual(ARTIFACT(source), expect.artifact);
    // Preparation-time reads are part of the contract, not incidental.
    assert.deepStrictEqual(prep.filter((t) => !emitted.includes(t)).sort(), expect.prepOnly,
      `preparation-only dependencies changed for ${expect.capability}`);
    if (sql) for (const t of emitted) assert.ok(columnsIn(sql, t, t.startsWith("rollup.") ? SCHEMAS.rollup : schema).length > 0,
      `${expect.capability}: no required columns observed on ${t}`);
  });
}

async function run(source: string, branch: string, fn: () => { guardrail: string; sql: string } | null) {
  prepared.length = 0;
  recording = true;
  let result: { guardrail: string; sql: string } | null = null;
  let note: string | undefined;
  try { result = fn(); } catch (error) { note = `threw: ${(error as Error).message}`; }
  recording = false;
  assess(source, branch, result?.guardrail ?? null, result?.sql ?? null, note);
}

// ---------------------------------------------------------------- lib (after instrumentation)
async function main() {
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

  // ---------------------------------------------------------------- self-tests (load-bearing)
  console.log("self-tests");
  for (const [label, open, expected] of [
    ["nibrs", () => getNibrsDb(), path.join(FIXTURES, "nibrs.db")],
    ["shr", () => getShrDb(), path.join(FIXTURES, "shr.db")],
    ["hate_crime", () => getHateCrimeDb(), path.join(FIXTURES, "hate_crime.db")],
    ["crime_data", () => getDb(), path.join(FIXTURES, "crime_data.db")],
  ] as [string, () => { name?: string } | null, string][]) {
    check(`handle routing: ${label}`, () => {
      const actual = open()?.name ?? null;
      assert.ok(actual, `${label} opened no database`);
      assert.strictEqual(path.resolve(actual!), path.resolve(expected));
    });
  }
  check("handle routing: rollup env", () => {
    assert.strictEqual(path.resolve(process.env.NIBRS_ROLLUP_DB_PATH!), path.resolve(path.join(FIXTURES, "nibrs_rollups.db")));
  });
  for (const [source, marker] of [
    ["current", "agency_monthly"], ["historical", "historical_agency_crime"], ["nibrs", "summary_victim_demographics"],
    ["shr", "incidents"], ["hate_crime", "hate_crime_incidents"], ["crime_data", "agencies"],
  ] as [string, string][]) {
    check(`schema routing: ${source} has ${marker}`, () => assert.ok(schemaFor(source).has(marker)));
  }
  if (failed > 0) {
    console.log(`\n${failed} self-test failure(s); branch results are NOT trustworthy.`);
    process.exit(1);
  }

  // ---------------------------------------------------------------- NIBRS (25)
  function nibrs(question: string) {
    const contract = buildQueryContract(question, "nibrs");
    const plan = resolveNibrsPlaces(getNibrsDb(), question, contract);
    const out = planNibrsQuery(question, plan, { allowDeterministic: true, juvenileIncidentRollupAvailable: true });
    return out.kind === "deterministic" ? { guardrail: out.query.guardrail, sql: out.query.sql } : null;
  }
  console.log("\nNIBRS branches");
  const NIBRS_CASES: [string, string][] = [
    ["juvenile_offender_incidents", "how many violent crime incidents had at least one offender under 18 in Texas from 2019 to 2022"],
    ["rollup_juvenile_arrests_state", "juvenile arrests by race in Texas"],
    ["rollup_juvenile_arrests_national", "juvenile arrests by race nationally"],
    ["rollup_national_arrests", "national arrests by offense"],
    // Continuous reporters rejects ANY named geography (nibrs-scope-deterministic.ts:105).
    ["continuous_reporters_victim", "murder victims by race among continuously reporting agencies 2019 to 2023"],
    ["continuous_reporters_offender", "murder offenders by race among continuously reporting agencies 2019 to 2023"],
    ["continuous_reporters_arrestee", "murder arrests by race among continuously reporting agencies 2019 to 2023"],
    ["continuous_reporters_victim_city", "how many murders among continuously reporting agencies 2019 to 2023"],
    // Countywide needs the literal word (:142), a county geography, AND a separate state
    // geography because stateCode() (:67) only reads kind==="state". Maricopa/Arizona is the
    // one shape yielding an INTERNALLY CONSISTENT pair. See the county/state defect note.
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
    // :966 rejects single-offense + single-city COUNT, so the trend branch needs two offenses.
    ["structured_local_trend", "murders and robberies in Austin, TX each year from 2019 to 2022"],
    ["structured_local_rate", "murder rate per 100,000 in Austin, TX each year from 2019 to 2022"],
    ["structured_local_trend_person", "murders and aggravated assaults in Austin, TX each year from 2019 to 2022"],
    ["local_city_offense_count", "how many burglaries in Austin, TX in 2022"],
    ["local_city_offense_count_person", "how many murders in Austin, TX in 2022"],
    ["dv_assault_share", "what share of aggravated assaults were domestic violence in Texas 2019 to 2022"],
  ];
  for (const [branch, question] of NIBRS_CASES) await run("nibrs", branch, () => nibrs(question));

  // ---------------------------------------------------------------- metadata (20)
  console.log("\nmetadata operations");
  const dbFor = (source: string) =>
    source === "shr" ? getShrDb() : source === "hate_crime" ? getHateCrimeDb() : source === "nibrs" ? getNibrsDb() : getDb();
  for (const source of ["current", "historical", "nibrs", "shr", "hate_crime"]) {
    for (const [operation, question] of [
      ["metadata-year-coverage", "what years of data are available"],
      ["metadata-state-coverage", "which states have data"],
      ["metadata-agency-directory", "how many agencies are included"],
      ["metadata-agency-directory-county", "how many agencies are in Dallas County"],
    ] as [string, string][]) {
      await run(source, `${source}:${operation}`, () => {
        const result = answerMetadataQuestion(source as never, question, dbFor(source));
        // Task 1A will have the builder seal this identity; until then it is derived here the
        // same way, from the branch that constructed the SQL.
        return result?.sql ? { guardrail: operation, sql: result.sql } : null;
      });
    }
  }

  // ---------------------------------------------------------------- Current + Historical (8)
  console.log("\nCurrent and Historical builders");
  await run("crime_data", "current:indexed_state_followup", () => {
    const p = buildCurrentIndexedStatePlan("murder rates per 100,000 in Texas and California indexed to 2019", []);
    return p ? { guardrail: p.guardrail, sql: p.sql } : null;
  });
  await run("crime_data", "current:multi_city_trend", () => {
    const p = buildMultiCityTrendPlan("murders in Austin, Dallas and Houston each year from 2019 to 2022", "current");
    return p ? { guardrail: p.guardrail, sql: p.sql } : null;
  });
  await run("crime_data", "historical:multi_city_trend", () => {
    const p = buildMultiCityTrendPlan("murders in Austin, Dallas and Houston each year from 2015 to 2019", "historical");
    return p ? { guardrail: p.guardrail, sql: p.sql } : null;
  });
  for (const [branch, question] of [
    ["historical:agency_scorecard", "give me a crime scorecard for Austin, TX"],
    ["historical:state_scorecard", "give me a crime scorecard for Texas"],
    ["historical:national_scorecard", "give me a national crime scorecard"],
  ] as [string, string][]) {
    await run("crime_data", branch, () => {
      const p = buildHistoricalScorecard(getDb(), question);
      return p?.sql ? { guardrail: `${p.scope}-scorecard`, sql: p.sql } : null;
    });
  }
  await run("crime_data", "historical:local_recent_change", () => {
    const p = buildHistoricalLocalRecentChangePlan("how did violent crime change in Austin, TX over the past year", 2024);
    return p?.sql ? { guardrail: p.guardrail, sql: p.sql } : null;
  });
  await run("crime_data", "historical:city_change_ranking", () => {
    const p = buildHistoricalCityChangeRankingPlan("which cities had the biggest increase in violent crime from 2015 to 2019", []);
    return p?.sql ? { guardrail: p.guardrail, sql: p.sql } : null;
  });

  // ---------------------------------------------------------------- route handlers (2)
  /**
   * deterministic-shooting and deterministic-place-lookup are constructed INSIDE their route
   * files, so no importable builder exists. These MUST stay route-driven: a static assertion
   * would not observe the prerequisite reads or prove the deterministic exit was taken.
   */
  console.log("\nroute-handler branches");
  const { createHmac } = await import("node:crypto");
  function pageToken(): string {
    const ts = String(Date.now() - 5000);                       // must be >1s old (page-token.ts:34)
    const secret = process.env.AUTH_PASSWORD || "nibrs-page-token-secret";  // page-token.ts:3
    return Buffer.from(`${ts}:${createHmac("sha256", secret).update(ts).digest("hex").slice(0, 16)}`).toString("base64");
  }
  async function runRoute(source: string, branch: string, importPath: string, body: Record<string, unknown>) {
    const wipe = new Database(process.env.QUERY_LOG_DB_PATH!);
    wipe.prepare("DELETE FROM query_log").run();
    wipe.close();
    prepared.length = 0;
    recording = true;
    let note: string | undefined;
    try {
      const mod = await import(importPath);
      const req = new Request("http://localhost/api/x", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
        body: JSON.stringify({ ...body, pageToken: pageToken() }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (mod as any).POST(req);
      // /api/query is SSE: the deterministic exit and its writeLog run inside the stream's
      // start(), so the body must be drained or nothing executes.
      if (res && typeof res.text === "function") await res.text();
    } catch (error) { note = `threw: ${(error as Error).message}`; }
    recording = false;
    const check2 = new Database(process.env.QUERY_LOG_DB_PATH!, { readonly: true });
    const row = check2.prepare("SELECT sql, guardrails FROM query_log ORDER BY rowid DESC LIMIT 1").get() as
      { sql: string | null; guardrails: string | null } | undefined;
    check2.close();
    const fired = (row?.guardrails ?? "").toString();
    const expected = EXPECTED[branch]?.family ?? "";
    assess(source, branch, fired.includes(expected) ? expected : (fired || null), row?.sql ?? null, note);
  }
  await runRoute("shr", "route:deterministic_shooting", "../app/api/shr-query/route",
    { question: "fatal shootings in Austin, TX each year from 2019 to 2022", tab: "shr" });
  await runRoute("crime_data", "route:deterministic_place_lookup", "../app/api/query/route",
    { question: "Austin, TX", mode: "historical", tab: "historical" });

  // ---------------------------------------------------------------- summary
  const total = Object.keys(EXPECTED).length;
  console.log(`\noperation taxonomy: ${passed} passed, ${failed} failed`);
  console.log(`coverage denominator: ${total} eligible operation cases (53 importable-builder + 2 route-handler)`);
  if (passed - 11 < total) {
    // 11 self-tests precede the branch cases.
    console.log(`NOTE: ${total - (passed - 11 + failed)} case(s) never ran; every eligible case must be observed.`);
  }
  try { fs.rmSync(FIXTURES, { recursive: true, force: true }); } catch { /* leave temp dir */ }
  if (failed > 0) process.exitCode = 1;

}

main();
