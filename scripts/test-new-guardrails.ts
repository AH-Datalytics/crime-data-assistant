#!/usr/bin/env npx tsx
/**
 * Tests for 2026-05-31 punch list items.
 * Calls the REAL extractQueryContext() and runGuardrails() functions,
 * and the REAL detectAllNullData() helper.
 *
 * Usage: npx tsx scripts/test-new-guardrails.ts
 */

import { extractQueryContext } from "../lib/query-context.js";
import { runGuardrails } from "../lib/guardrails.js";
import { detectAllNullData } from "../lib/all-null-detection.js";
import { currentCalendarYear, pastCompleteCalendarYearsRange, pastYearsIncludingCurrentRange } from "../lib/time-conventions.js";

let pass = 0;
let fail = 0;
const failures: { name: string; detail?: string }[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  agency-lookup-not-crime-data guardrail
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ agency-lookup-not-crime-data ═══\n");

{
  // TP: agency-only SQL when user asks about crime
  const ctx = extractQueryContext(
    "SELECT DISTINCT agency, state, type FROM agencies WHERE agency LIKE '%Delaware%' ORDER BY agency LIMIT 5000",
    "Can you provide crime trends for Part 1 crimes at the University of Delaware?",
    "current"
  );
  const r = runGuardrails(ctx);
  assert("TP: fires for crime question + agency-only SQL",
    r.fired.includes("agency-lookup-not-crime-data"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: user asks what agencies exist (not asking for crime data)
  const ctx = extractQueryContext(
    "SELECT DISTINCT agency, state, type FROM agencies WHERE state = 'VA'",
    "what agencies do you have for Arlington VA?",
    "current"
  );
  const r = runGuardrails(ctx);
  assert("FP: does NOT fire for 'what agencies' question",
    !r.fired.includes("agency-lookup-not-crime-data"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: SQL includes agency_monthly (real crime data)
  const ctx = extractQueryContext(
    "SELECT am.year, SUM(am.count) FROM agency_monthly am WHERE am.agency = 'Denver' GROUP BY am.year",
    "crime trends in Denver",
    "current"
  );
  const r = runGuardrails(ctx);
  assert("FP: does NOT fire when SQL uses agency_monthly",
    !r.fired.includes("agency-lookup-not-crime-data"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: "tell me about crime in Arlington VA" with agency-only SQL
  const ctx = extractQueryContext(
    "SELECT DISTINCT agency, state, type FROM agencies WHERE agency LIKE '%Arlington%' AND state = 'VA' LIMIT 5000",
    "Tell me more about crime in Arlington, VA",
    "current"
  );
  const r = runGuardrails(ctx);
  assert("TP: fires for 'tell me about crime' + agency-only SQL",
    r.fired.includes("agency-lookup-not-crime-data"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  historical-city-got-state guardrail
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ historical-city-got-state ═══\n");

{
  // TP: Denver question → Colorado state data
  const ctx = extractQueryContext(
    "SELECT year, ROUND(murder_rate, 1) AS murder_rate FROM historical_state_national WHERE state = 'Colorado' ORDER BY year LIMIT 5000",
    "Denver crime rates over time",
    "historical"
  );
  const r = runGuardrails(ctx);
  assert("TP: Denver question + state SQL fires",
    r.fired.includes("historical-city-got-state"),
    `geos: ${JSON.stringify(ctx.geos)}, fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: "California murder rate" should NOT fire
  const ctx = extractQueryContext(
    "SELECT year, murder_rate FROM historical_state_national WHERE state = 'California' ORDER BY year",
    "murder rate in California over time",
    "historical"
  );
  const r = runGuardrails(ctx);
  assert("FP: California state query does NOT fire",
    !r.fired.includes("historical-city-got-state"),
    `geos: ${JSON.stringify(ctx.geos)}, fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: "North Carolina violent crime rate" should NOT fire
  const ctx = extractQueryContext(
    "SELECT year, murder_rate FROM historical_state_national WHERE state = 'North Carolina' ORDER BY year",
    "North Carolina violent crime rate since 1960",
    "historical"
  );
  const r = runGuardrails(ctx);
  assert("FP: North Carolina state query does NOT fire",
    !r.fired.includes("historical-city-got-state"),
    `geos: ${JSON.stringify(ctx.geos)}, fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: "United States murder rate" should NOT fire
  const ctx = extractQueryContext(
    "SELECT year, murder FROM historical_state_national WHERE state = 'United States' ORDER BY year",
    "national murder trend since 2000",
    "historical"
  );
  const r = runGuardrails(ctx);
  assert("FP: United States query does NOT fire",
    !r.fired.includes("historical-city-got-state"),
    `geos: ${JSON.stringify(ctx.geos)}, fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: "Texas murder rate" should NOT fire
  const ctx = extractQueryContext(
    "SELECT year, murder_rate FROM historical_state_national WHERE state = 'Texas' ORDER BY year",
    "Texas murder rate since 1960",
    "historical"
  );
  const r = runGuardrails(ctx);
  assert("FP: Texas state query does NOT fire",
    !r.fired.includes("historical-city-got-state"),
    `geos: ${JSON.stringify(ctx.geos)}, fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: "Portland murder rate" using Oregon state data
  const ctx = extractQueryContext(
    "SELECT year, murder_rate FROM historical_state_national WHERE state = 'Oregon' ORDER BY year",
    "Portland murder rate since 1960",
    "historical"
  );
  const r = runGuardrails(ctx);
  assert("TP: Portland question + Oregon state SQL fires",
    r.fired.includes("historical-city-got-state"),
    `geos: ${JSON.stringify(ctx.geos)}, fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  detectAllNullData helper
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ detectAllNullData ═══\n");

{
  // Basic: year + null value → detected
  const r = detectAllNullData(
    ["year", "murder_rate"],
    [{ year: 2020, murder_rate: null }, { year: 2021, murder_rate: null }]
  );
  assert("all-null: year + null value detected", r.allNull);
  assert("all-null: dataCols = ['murder_rate']", r.dataCols.length === 1 && r.dataCols[0] === "murder_rate");
}

{
  // Long-format: year, agency, null value → detected (agency is dimension)
  const r = detectAllNullData(
    ["year", "agency", "indexed_rate"],
    [
      { year: 2020, agency: "Baltimore", indexed_rate: null },
      { year: 2021, agency: "Baltimore", indexed_rate: null },
    ]
  );
  assert("all-null: long-format year,agency,null_value detected", r.allNull);
  assert("all-null: agency excluded from dataCols",
    r.dataCols.length === 1 && r.dataCols[0] === "indexed_rate");
}

{
  // Long-format with offense dimension
  const r = detectAllNullData(
    ["year", "offense", "rate"],
    [
      { year: 2020, offense: "Murder", rate: null },
      { year: 2021, offense: "Robbery", rate: null },
    ]
  );
  assert("all-null: year,offense,null_rate detected", r.allNull);
}

{
  // Partial null: one data col null, another has values → NOT all-null
  const r = detectAllNullData(
    ["year", "baltimore_indexed", "national_indexed"],
    [
      { year: 2020, baltimore_indexed: null, national_indexed: 100 },
      { year: 2021, baltimore_indexed: null, national_indexed: 95 },
    ]
  );
  assert("all-null: partial null (one col has data) → false", !r.allNull);
}

{
  // All values present → not detected
  const r = detectAllNullData(
    ["year", "month", "count"],
    [{ year: 2020, month: 1, count: 42 }, { year: 2020, month: 2, count: 35 }]
  );
  assert("all-null: real data → false", !r.allNull);
}

{
  // Empty rows → not detected
  const r = detectAllNullData(["year", "count"], []);
  assert("all-null: empty rows → false", !r.allNull);
}

{
  // Single column (just year) → not detected (no data cols)
  const r = detectAllNullData(["year"], [{ year: 2020 }]);
  assert("all-null: single dimension col → false", !r.allNull);
  assert("all-null: single dimension col → 0 dataCols", r.dataCols.length === 0);
}

{
  // Pivoted: year, month, city1, city2 all null → detected
  const r = detectAllNullData(
    ["year", "month", "baltimore_indexed", "national_indexed"],
    [
      { year: 2020, month: 1, baltimore_indexed: null, national_indexed: null },
      { year: 2020, month: 2, baltimore_indexed: null, national_indexed: null },
    ]
  );
  assert("all-null: pivoted with all null values → detected", r.allNull);
  assert("all-null: pivoted dataCols = 2", r.dataCols.length === 2);
}

{
  // SHR-specific dimensions: weapon_group, circumstance_group are dimensions
  const r = detectAllNullData(
    ["year", "weapon_group", "victim_count"],
    [
      { year: 2020, weapon_group: "Firearm", victim_count: null },
      { year: 2021, weapon_group: "Knife", victim_count: null },
    ]
  );
  assert("all-null: SHR weapon_group excluded, null victim_count detected", r.allNull);
}

{
  // Mixed null/undefined
  const r = detectAllNullData(
    ["year", "agency", "rate_per_100k"],
    [
      { year: 2020, agency: "Denver", rate_per_100k: null },
      { year: 2021, agency: "Denver" }, // rate_per_100k is undefined
    ]
  );
  assert("all-null: null and undefined both treated as null", r.allNull);
}

// ══════════════════════════════════════════════════════════════════════
//  nibrs-city-got-state guardrail
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ nibrs-city-got-state ═══\n");

{
  // TP: "Maplewood Police Department" → state-level table with no ORI
  const ctx = extractQueryContext(
    "SELECT s.year, SUM(s.victim_count) AS total_crimes FROM summary_victim_state_monthly s WHERE s.state = 'NJ' AND s.year BETWEEN 1991 AND 2026 GROUP BY s.year ORDER BY s.year LIMIT 1000",
    "Maplewood Police Department in Maplewood, NJ",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("TP: Maplewood city question + NJ state SQL fires nibrs-city-got-state",
    r.fired.includes("nibrs-city-got-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: legitimate state query ("crime in New Jersey")
  const ctx = extractQueryContext(
    "SELECT s.year, SUM(s.victim_count) FROM summary_victim_state_monthly s WHERE s.state = 'NJ' GROUP BY s.year",
    "violent crime in New Jersey since 2020",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: state query does NOT fire nibrs-city-got-state",
    !r.fired.includes("nibrs-city-got-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: state table with ORI filter (handled by nibrs-state-table-with-ori instead)
  const ctx = extractQueryContext(
    "SELECT s.year, SUM(s.victim_count) FROM summary_victim_state_monthly s WHERE s.ori = 'NJ1234' GROUP BY s.year",
    "crimes in Newark NJ",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: state table + ORI does NOT fire nibrs-city-got-state (handled by other guardrail)",
    !r.fired.includes("nibrs-city-got-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  city-like-no-state guardrail
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ city-like-no-state ═══\n");

{
  // TP: LIKE prefix without state (the Kings County bug)
  const ctx = extractQueryContext(
    "SELECT s.year, SUM(s.victim_count) FROM summary_victim_city_monthly s WHERE s.ori IN (SELECT ori FROM agencies WHERE city LIKE 'KINGS%' AND population > 0 ORDER BY pop_group LIMIT 1) GROUP BY s.year",
    "show me trends on gun crime in Kings County since 2015",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("TP: LIKE 'KINGS%' without state fires",
    r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: contains LIKE without state (the BART/Bartlett bug)
  const ctx = extractQueryContext(
    "SELECT year, SUM(offenses) FROM agency_monthly WHERE agency LIKE '%BART%' GROUP BY year",
    "crime reported by BART",
    "current"
  );
  const r = runGuardrails(ctx);
  assert("TP: LIKE '%BART%' without state fires",
    r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: suffix LIKE without state is also ambiguous
  const ctx = extractQueryContext(
    "SELECT year, SUM(offenses) FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency LIKE '%MTA' GROUP BY year",
    "crime reported by MTA",
    "historical"
  );
  const r = runGuardrails(ctx);
  assert("TP: LIKE '%MTA' without state fires",
    r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: contains LIKE with state filter is fine
  const ctx = extractQueryContext(
    "SELECT year, SUM(offenses) FROM agency_monthly WHERE agency LIKE '%BART%' AND state = 'CA' GROUP BY year",
    "crime reported by BART in California",
    "current"
  );
  const r = runGuardrails(ctx);
  assert("FP: LIKE '%BART%' with state does NOT fire",
    !r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: LIKE with state filter is fine
  const ctx = extractQueryContext(
    "SELECT i.year, COUNT(*) FROM incidents i WHERE i.agency LIKE '%Maplewood%' AND i.state = 'NJ' GROUP BY i.year",
    "homicides in Maplewood NJ",
    "shr"
  );
  const r = runGuardrails(ctx);
  assert("FP: LIKE with state filter does NOT fire",
    !r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: exact city = match (not LIKE) without state — different guardrail's job
  const ctx = extractQueryContext(
    "SELECT s.year FROM summary_victim_city_monthly s WHERE s.ori IN (SELECT ori FROM agencies WHERE city = 'HOUSTON') GROUP BY s.year",
    "crime in Houston",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: exact city = match does NOT fire city-like-no-state",
    !r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: LIKE prefix in subquery without state, even though outer query has state filter
  const ctx = extractQueryContext(
    "SELECT s.year, SUM(s.victim_count) FROM summary_victim_city_monthly s WHERE s.state = 'NY' AND s.ori IN (SELECT ori FROM agencies WHERE city LIKE 'KINGS%' AND population > 0 LIMIT 1) GROUP BY s.year",
    "gun crime in Kings County NY since 2015",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("TP: LIKE in subquery without state fires even with outer state filter",
    r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: LIKE prefix in subquery WITH state filter in same subquery
  const ctx = extractQueryContext(
    "SELECT s.year FROM summary_victim_city_monthly s WHERE s.ori IN (SELECT ori FROM agencies WHERE city LIKE 'KINGS%' AND state = 'NY' AND population > 0 LIMIT 1) GROUP BY s.year",
    "gun crime in Kings County NY",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: LIKE with state in same subquery does NOT fire",
    !r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  nibrs-city-no-agency-type guardrail (auto-fix)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ nibrs-city-no-agency-type ═══\n");

{
  // TP: Portland query without agency_type — should fire retry message
  const sql = `WITH portland_data AS (
  SELECT s.year, SUM(s.offense_count) AS portland_offenses, a.population AS portland_pop
  FROM summary_city_monthly s
  JOIN agencies a ON a.ori = s.ori AND a.year = s.year
  WHERE s.ucr_offense_code = '240' AND s.year >= 2022
    AND a.city = 'PORTLAND' AND a.state = 'OR' AND a.population > 0
  GROUP BY s.year, a.population
) SELECT * FROM portland_data`;
  const ctx = extractQueryContext(sql, "Portland Oregon motor vehicle theft", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: Portland city query without agency_type fires",
    r.fired.includes("nibrs-city-no-agency-type"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: retry message references PORTLAND and OR",
    r.issues.some(i => i.includes("PORTLAND") && i.includes("OR")),
    `issues: ${r.issues.map(i => i.substring(0, 80))}`);
}

{
  // TP: ORI subquery with bare city, no ORDER BY population LIMIT 1
  const sql = `SELECT * FROM summary_city_monthly WHERE ori IN (SELECT ori FROM agencies WHERE city = 'DENVER' AND state = 'CO' AND population > 0)`;
  const ctx = extractQueryContext(sql, "Denver crime", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: bare city filter without pop sort fires",
    r.fired.includes("nibrs-city-no-agency-type"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: ORI subquery with ORDER BY population DESC LIMIT 1 — already picks main PD
  const sql = `SELECT * FROM summary_city_monthly WHERE ori IN (SELECT ori FROM agencies WHERE city = 'DENVER' AND state = 'CO' AND population > 0 ORDER BY population DESC LIMIT 1)`;
  const ctx = extractQueryContext(sql, "Denver crime", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: ORDER BY population DESC LIMIT 1 does NOT fire",
    !r.fired.includes("nibrs-city-no-agency-type"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: query that already has agency_type
  const sql = `SELECT * FROM summary_city_monthly s JOIN agencies a ON a.ori = s.ori WHERE a.city = 'HOUSTON' AND a.state = 'TX' AND a.agency_type = 'City'`;
  const ctx = extractQueryContext(sql, "Houston crime", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: query with agency_type does NOT fire",
    !r.fired.includes("nibrs-city-no-agency-type"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: user asks about county — don't add City filter
  const sql = `SELECT * FROM summary_city_monthly s JOIN agencies a ON a.ori = s.ori WHERE a.city = 'HOUSTON' AND a.state = 'TX'`;
  const ctx = extractQueryContext(sql, "Harris County sheriff crime data", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: county question does NOT fire",
    !r.fired.includes("nibrs-city-no-agency-type"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  SHR scope refusal regex
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ SHR scope refusal ═══\n");

{
  // The scopeRefusal regex from shr-query/route.ts (widened to allow words between verb and topic)
  const scopeRefusal = /only (homicides?|murders?|manslaughter)|does(?:n't| not)\s+(?:include|contain|track|cover|have)\s+.*?\b(theft|robbery|assault|burglary|property|arrests?|drugs?|clearance|staffing|officers?|sworn|personnel|employment|auto theft|motor vehicle|violent crime|property crime|non-homicide|shootings?|rape)\b|homicides only|murder and manslaughter only/i;

  // Should match (correct scope refusals — skip retry)
  assert("scope: 'only homicide' matches",
    scopeRefusal.test("This dataset covers only homicide incidents"));
  assert("scope: 'does not include theft' matches",
    scopeRefusal.test("SHR does not include theft data"));
  assert("scope: 'does not track arrest' matches",
    scopeRefusal.test("This dataset does not track arrest data"));
  assert("scope: 'does not contain auto theft' matches",
    scopeRefusal.test("The database does not contain auto theft information"));
  assert("scope: 'homicides only' matches",
    scopeRefusal.test("This database contains homicides only"));
  assert("scope: 'does not include violent crime' matches",
    scopeRefusal.test("SHR does not include violent crime rates"));
  assert("scope: 'does not cover property crime' matches",
    scopeRefusal.test("This dataset does not cover property crime"));

  // Widened: "does not include data on sworn officers" — words between verb and topic
  assert("scope: 'does not include data on sworn officers' matches",
    scopeRefusal.test("This dataset does not include data on sworn officers"));
  assert("scope: 'doesn't contain information about theft' matches",
    scopeRefusal.test("SHR doesn't contain information about theft"));

  // Should NOT match (murder rate refusals — should retry)
  assert("scope: 'does not include crime rate' does NOT match",
    !scopeRefusal.test("This dataset does not include crime rate data"));
  assert("scope: 'murder rate not available' does NOT match",
    !scopeRefusal.test("Murder rate data is not available for this agency"));
  assert("scope: 'agency not in dataset' does NOT match",
    !scopeRefusal.test("This agency does not appear in our dataset"));
  assert("scope: 'no data found' does NOT match",
    !scopeRefusal.test("No data found for Houston"));
}

// ══════════════════════════════════════════════════════════════════════
//  Explanation entity validation (hyphenated names)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Explanation entity validation ═══\n");

{
  // Simulate the validNames logic from explain.ts
  const resultEntities = ["Charlotte-Mecklenburg, NC", "Chicago, IL"];
  const validNames = new Set<string>();
  for (const e of resultEntities) {
    validNames.add(e.toLowerCase());
    const commaIdx = e.indexOf(",");
    if (commaIdx > 0) validNames.add(e.slice(0, commaIdx).trim().toLowerCase());
    if (e.includes("-")) {
      for (const part of e.split("-")) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed.length > 2) {
          // Also split on comma for "Mecklenburg, NC" → "mecklenburg"
          const commaPart = trimmed.indexOf(",");
          validNames.add(commaPart > 0 ? trimmed.slice(0, commaPart).trim() : trimmed);
        }
      }
    }
  }

  assert("entity: 'charlotte' is valid (from hyphenated split)",
    validNames.has("charlotte"));
  assert("entity: 'mecklenburg' is valid (from hyphenated split)",
    validNames.has("mecklenburg"));
  assert("entity: 'charlotte-mecklenburg, nc' is valid (full entity)",
    validNames.has("charlotte-mecklenburg, nc"));
  assert("entity: 'chicago' is valid (from comma split)",
    validNames.has("chicago"));

  // A city NOT in the results should NOT be valid
  assert("entity: 'denver' is NOT valid",
    !validNames.has("denver"));
}

// ══════════════════════════════════════════════════════════════════════
//  Hard override guardrails (2026-06-02)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Hard override guardrails ═══\n");

// Explicit state questions must not silently narrow to a city/agency with the same name.
{
  const sql = `SELECT i.year, COUNT(*) AS fatal_shootings FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.agency = 'New York' AND i.state = 'NY' AND i.homicide_type = 'Murder' AND i.weapon_group = 'Firearm' AND i.year >= 2022 GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "how has gun violence changed in New York State since 2022?", "shr");
  const r = runGuardrails(ctx);
  assert("state-vs-agency: SHR New York State agency filter fires", r.fired.includes("explicit-state-not-agency"));
}

{
  const sql = `SELECT i.year, COUNT(*) AS fatal_shootings FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'NY' AND i.homicide_type = 'Murder' AND i.weapon_group = 'Firearm' AND i.year >= 2022 GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "how has gun violence changed in New York State since 2022?", "shr");
  const r = runGuardrails(ctx);
  assert("state-vs-agency: SHR New York State state filter does not fire", !r.fired.includes("explicit-state-not-agency"));
}

{
  const sql = `SELECT year, SUM(offense_count) AS assaults FROM summary_city_monthly WHERE ori IN (SELECT ori FROM agencies WHERE city = 'NEW YORK' AND state = 'NY') GROUP BY year`;
  const ctx = extractQueryContext(sql, "aggravated assault in New York State since 2022", "nibrs");
  const r = runGuardrails(ctx);
  assert("state-vs-agency: NIBRS New York State city/ORI filter fires", r.fired.includes("explicit-state-not-agency"));
}

{
  const sql = `SELECT year, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Washington' AND state = 'DC' AND offense = 'Murder' GROUP BY year`;
  const ctx = extractQueryContext(sql, "murders in Washington State since 2022", "current");
  const r = runGuardrails(ctx);
  assert("state-vs-agency: Current Washington State agency filter fires", r.fired.includes("explicit-state-not-agency"));
}

{
  const sql = `SELECT hac.year, SUM(hac.murder) AS murders FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'New York' AND ha.state = 'ny' GROUP BY hac.year`;
  const ctx = extractQueryContext(sql, "murder in New York State since 2022", "historical");
  const r = runGuardrails(ctx);
  assert("state-vs-agency: Historical New York State agency filter fires", r.fired.includes("explicit-state-not-agency"));
}

{
  const sql = `SELECT i.year, COUNT(*) AS fatal_shootings FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.agency = 'New York' AND i.state = 'NY' AND i.homicide_type = 'Murder' AND i.weapon_group = 'Firearm' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "how has gun violence changed in New York City since 2022?", "shr");
  const r = runGuardrails(ctx);
  assert("state-vs-agency: New York City does not fire", !r.fired.includes("explicit-state-not-agency"));
}

{
  const sql = `SELECT i.year, COUNT(*) AS homicides FROM incidents i WHERE i.agency LIKE '%State Police%' AND i.state = 'NY' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "New York State Police homicides since 2022", "shr");
  const r = runGuardrails(ctx);
  assert("state-vs-agency: New York State Police does not fire", !r.fired.includes("explicit-state-not-agency"));
}

{
  const sql = `SELECT a.city, SUM(s.offense_count) AS assaults FROM summary_city_monthly s JOIN agencies a ON a.ori = s.ori AND a.year = s.year WHERE a.state = 'WA' AND a.agency_type = 'City' GROUP BY a.city ORDER BY assaults DESC LIMIT 10`;
  const ctx = extractQueryContext(sql, "top cities for aggravated assault in Washington state", "nibrs");
  const r = runGuardrails(ctx);
  assert("state-vs-agency: top cities in Washington state does not fire", !r.fired.includes("explicit-state-not-agency"));
}

// Post-rewrite override evaluation test
{
  // shr-gang-felony-mislabel rewrites circumstance_group='Felony Type' → circumstance IN ('Gangland Killings', ...)
  // After rewrite, shr-non-homicide-topic should NOT fire because the SQL is now valid gang-homicide SQL
  const sql = `SELECT i.year, COUNT(*) as victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.agency = 'Chicago' AND i.state = 'IL' AND i.circumstance_group = 'Felony Type' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "gang homicides in Chicago", "shr");
  const r = runGuardrails(ctx);
  // Gang rewrite should fire
  assert("post-rewrite: gang rewrite fires", r.fired.includes("shr-gang-felony-mislabel"));
  // After rewrite, the SQL should have 'Gangland Killings' not 'Felony Type'
  assert("post-rewrite: rewritten SQL has Gangland Killings", r.sql.includes("Gangland Killings"));
  // shr-non-homicide-topic should NOT fire as override — question has "homicides" (exempt)
  assert("post-rewrite: non-homicide override does NOT fire", r.overrideResponse === null);
}

// #1: Gang → Felony Type (retry/rewrite)
{
  const sql = `SELECT i.year, COUNT(*) as victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.agency = 'Chicago' AND i.state = 'IL' AND i.homicide_type = 'Murder' AND i.circumstance_group = 'Felony Type' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "Show me trends in gang homicides in Chicago", "shr");
  const r = runGuardrails(ctx);
  assert("#1 gang-felony: fires", r.fired.includes("shr-gang-felony-mislabel"));
  assert("#1 gang-felony: rewrites to Gangland Killings", r.sql.includes("Gangland Killings"));
  assert("#1 gang-felony: no override (retry only)", r.overrideResponse === null);
}

// #2: SHR SUM(population) — multi-agency override
{
  const sql = `SELECT i.year, COUNT(*) as victims, ROUND(COUNT(*) * 100000.0 / NULLIF(SUM(i.population), 0), 1) as rate FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.homicide_type = 'Murder' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "Nationwide murder rate 2022", "shr");
  const r = runGuardrails(ctx);
  assert("#2 sum-pop multi: fires", r.fired.includes("shr-sum-population"));
  assert("#2 sum-pop multi: override (not just rewrite)", r.overrideResponse !== null);
}

{
  const sql = `SELECT i.year, ROUND(COUNT(*) * 100000.0 / NULLIF(AVG(i.population), 0), 1) as rate_per_100k FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'PA' AND i.homicide_type = 'Murder' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "firearm homicide rate in PA", "shr");
  const r = runGuardrails(ctx);
  assert("#2 avg-pop state rate: fires", r.fired.includes("shr-rate-bad-denominator"));
  assert("#2 avg-pop state rate: override", r.overrideResponse !== null && r.overrideResponse.includes("state_population"));
}

{
  const sql = `SELECT i.year, ROUND(COUNT(*) * 100000.0 / NULLIF(sp.population, 0), 1) as rate_per_100k FROM incidents i JOIN victims v ON v.incident_id = i.id JOIN state_population sp ON sp.state = i.state AND sp.year = i.year WHERE i.state = 'PA' AND i.homicide_type = 'Murder' GROUP BY i.year, sp.population`;
  const ctx = extractQueryContext(sql, "firearm homicide rate in PA", "shr");
  const r = runGuardrails(ctx);
  assert("#2 state-pop state rate: no bad denominator", !r.fired.includes("shr-rate-bad-denominator"));
  assert("#2 state-pop state rate: no sum-pop", !r.fired.includes("shr-sum-population"));
}

{
  const sql = `WITH counts AS (SELECT i.year, COUNT(*) as victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.homicide_type = 'Murder' GROUP BY i.year) SELECT counts.year, ROUND(counts.victims * 100000.0 / NULLIF(sp.population, 0), 1) as rate_per_100k FROM counts JOIN state_population sp ON sp.state = 'US' AND sp.year = counts.year`;
  const ctx = extractQueryContext(sql, "national murder rate", "shr");
  const r = runGuardrails(ctx);
  assert("#2 state-pop national rate: no bad denominator", !r.fired.includes("shr-rate-bad-denominator"));
  assert("#2 state-pop national rate: no sum-pop", !r.fired.includes("shr-sum-population"));
}

// #2: SHR SUM(population) — single-agency rewrite (no override)
{
  const sql = `SELECT i.year, COUNT(*) as victims, ROUND(COUNT(*) * 100000.0 / NULLIF(SUM(i.population), 0), 1) as rate FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.agency = 'Chicago' AND i.state = 'IL' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "Chicago murder rate", "shr");
  const r = runGuardrails(ctx);
  assert("#2 sum-pop single: fires", r.fired.includes("shr-sum-population"));
  assert("#2 sum-pop single: auto-rewrites to AVG", r.sql.includes("AVG(i.population)"));
  assert("#2 sum-pop single: no override", r.overrideResponse === null);
}

// #3: SHR non-homicide topic
{
  const sql = `SELECT i.year, COUNT(*) as count FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.agency = 'Houston' AND i.state = 'TX' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "Give me robbery numbers in Houston 2020-2025", "shr");
  const r = runGuardrails(ctx);
  assert("#3 SHR non-homicide: fires", r.fired.includes("shr-non-homicide-topic"));
  assert("#3 SHR non-homicide: override", r.overrideResponse !== null && r.overrideResponse.includes("robbery"));
}

// #3: FP — robbery-homicide is exempt
{
  const sql = `SELECT i.year, COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.circumstance = 'Robbery' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "homicides during robbery in Chicago", "shr");
  const r = runGuardrails(ctx);
  assert("#3 SHR robbery-homicide exempt", !r.fired.includes("shr-non-homicide-topic"));
}

// #4: Drug type silent filter drop
{
  const sql = `SELECT year, SUM(arrestee_count) AS marijuana_arrests FROM summary_arrestee_demographics WHERE ucr_arrest_offense = '35A' AND year >= 2022 GROUP BY year`;
  const ctx = extractQueryContext(sql, "marijuana possession arrests", "nibrs");
  const r = runGuardrails(ctx);
  assert("#4 drug-type: fires for marijuana", r.fired.includes("nibrs-drug-type-unavailable"));
  assert("#4 drug-type: override", r.overrideResponse !== null && r.overrideResponse.includes("marijuana"));
}

// #4: FP — "drug possession" without naming a substance
{
  const sql = `SELECT year, SUM(arrestee_count) FROM summary_arrestee_demographics WHERE ucr_arrest_offense = '35A' GROUP BY year`;
  const ctx = extractQueryContext(sql, "drug possession arrests nationally", "nibrs");
  const r = runGuardrails(ctx);
  assert("#4 drug-type: does NOT fire for generic 'drug'", !r.fired.includes("nibrs-drug-type-unavailable"));
}

// #5: NIBRS shooting override
{
  const sql = `SELECT year, SUM(victim_count) AS victims FROM summary_victim_state_monthly WHERE ucr_offense_code = '13A' GROUP BY year`;
  const ctx = extractQueryContext(sql, "Give me shooting counts", "nibrs");
  const r = runGuardrails(ctx);
  assert("#5 shooting: fires", r.fired.includes("nibrs-shooting-override"));
  assert("#5 shooting: override", r.overrideResponse !== null);
}

// #5: FP — "firearm murder rate" is exempt
{
  const sql = `SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE ucr_offense_code = '09A' GROUP BY year`;
  const ctx = extractQueryContext(sql, "firearm murder rate nationally", "nibrs");
  const r = runGuardrails(ctx);
  assert("#5 shooting: firearm murder exempt", !r.fired.includes("nibrs-shooting-override"));
}

// #7: SHR clearance hard override
{
  const ctx = extractQueryContext(
    "SELECT * FROM incidents", "clearance rate in Chicago", "shr"
  );
  const r = runGuardrails(ctx);
  assert("#7 clearance: fires", r.fired.includes("shr-clearance-override"));
  assert("#7 clearance: override has FBI definition", r.overrideResponse !== null && r.overrideResponse.includes("arrest"));
}

// #9: SQLite dialect
{
  const sql = `SELECT SUBSTRING_INDEX(agency, ' ', 1) FROM incidents`;
  const ctx = extractQueryContext(sql, "show me agencies", "shr");
  const r = runGuardrails(ctx);
  assert("#9 sqlite-dialect: fires for SUBSTRING_INDEX", r.fired.includes("sqlite-dialect-error"));
}

// #10: Ethnicity — guardrail REMOVED, ethnicity now live in all 3 demographics tables.
// Positive tests: ethnicity queries should use summary tables, not raw tables.
{
  const ratioSql = `SELECT i.year, ROUND(SUM(CASE WHEN v.sex = 'Male' THEN 1 ELSE 0 END)::numeric / NULLIF(SUM(CASE WHEN v.sex = 'Female' THEN 1 ELSE 0 END), 0), 2) AS male_to_female_ratio FROM incidents i JOIN victims v ON v.incident_id = i.id GROUP BY i.year`;
  const ratioCtx = extractQueryContext(ratioSql, "ratio of male to female homicide victims", "shr");
  const ratioResult = runGuardrails(ratioCtx);
  assert("#9 sqlite-dialect: fires for PostgreSQL cast", ratioResult.fired.includes("sqlite-dialect-error"));

  // Ethnicity query using summary_arrestee_demographics — should NOT fire raw-table guardrail
  const sql = `SELECT CASE WHEN d.ethnicity = 'H' THEN 'Hispanic' WHEN d.ethnicity = 'N' THEN 'Not Hispanic' ELSE 'Unknown' END AS ethnicity, SUM(d.arrestee_count) AS arrests FROM summary_arrestee_demographics d WHERE d.ucr_arrest_offense = '35A' AND d.year >= 2022 GROUP BY ethnicity ORDER BY arrests DESC`;
  const ctx = extractQueryContext(sql, "drug arrests by ethnicity", "nibrs");
  const r = runGuardrails(ctx);
  assert("#10a ethnicity: summary_arrestee_demographics does NOT fire raw-table",
    !r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // Ethnicity query using summary_victim_demographics — should NOT fire raw-table guardrail
  const sql = `SELECT CASE WHEN d.ethnicity = 'H' THEN 'Hispanic' WHEN d.ethnicity = 'N' THEN 'Not Hispanic' ELSE 'Unknown' END AS ethnicity, SUM(d.victim_count) AS victims FROM summary_victim_demographics d WHERE d.ucr_offense_code = '09A' AND d.state = 'TX' AND d.year >= 2022 GROUP BY ethnicity`;
  const ctx = extractQueryContext(sql, "Hispanic murder victims in Texas", "nibrs");
  const r = runGuardrails(ctx);
  assert("#10b ethnicity: summary_victim_demographics does NOT fire raw-table",
    !r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // Ethnicity query using summary_offender_demographics — should NOT fire raw-table guardrail
  const sql = `SELECT CASE WHEN d.ethnicity = 'H' THEN 'Hispanic' WHEN d.ethnicity = 'N' THEN 'Not Hispanic' ELSE 'Unknown' END AS ethnicity, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ucr_offense_code = '09A' AND d.state = 'CA' AND d.year >= 2022 AND d.ethnicity IN ('H','N') GROUP BY ethnicity`;
  const ctx = extractQueryContext(sql, "Hispanic murder offenders in California", "nibrs");
  const r = runGuardrails(ctx);
  assert("#10c ethnicity: summary_offender_demographics does NOT fire raw-table",
    !r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// #11: Sub-city geography
{
  const ctx = extractQueryContext("SELECT * FROM offenses", "crime in zip code 07040", "nibrs");
  const r = runGuardrails(ctx);
  assert("#11 sub-city: fires for zip code", r.fired.includes("sub-city-geography-override"));
  assert("#11 sub-city: override", r.overrideResponse !== null);
}

// #12: Juvenile raw table
{
  const sql = `SELECT year, COUNT(*) FROM offenders WHERE age < 18 GROUP BY year`;
  const ctx = extractQueryContext(sql, "crimes by juveniles per year", "nibrs");
  const r = runGuardrails(ctx);
  assert("#12 juvenile raw: fires", r.fired.includes("nibrs-age-raw-table"));
}

// #16: Out of scope
{
  const ctx = extractQueryContext("SELECT * FROM incidents", "How many people were convicted of murder in 2024?", "shr");
  const r = runGuardrails(ctx);
  assert("#16 out-of-scope: fires for conviction", r.fired.includes("out-of-scope-override"));
  assert("#16 out-of-scope: override", r.overrideResponse !== null);
}

// FP: "arrest" should NOT trigger out-of-scope (arrests ARE in NIBRS)
{
  const ctx = extractQueryContext("SELECT * FROM summary_arrestee_demographics", "gun arrests in Houston", "nibrs");
  const r = runGuardrails(ctx);
  assert("#16 out-of-scope: 'arrest' does NOT fire", !r.fired.includes("out-of-scope-override"));
}

{
  const ctx = extractQueryContext("SELECT year, SUM(arrestee_count) AS arrests FROM summary_arrestee_demographics GROUP BY year", "misdemeanor arrests in Pennsylvania", "nibrs");
  const r = runGuardrails(ctx);
  assert("charge severity: misdemeanor arrests hard-stop", r.fired.includes("charge-severity-unavailable"));
  assert("charge severity: misdemeanor arrests override", r.overrideResponse !== null && r.overrideResponse.includes("misdemeanors versus felonies"));
}

{
  const ctx = extractQueryContext("SELECT year, SUM(arrestee_count) AS arrests FROM summary_arrestee_demographics GROUP BY year", "felony arrests by race", "nibrs");
  const r = runGuardrails(ctx);
  assert("charge severity: felony arrests hard-stop", r.fired.includes("charge-severity-unavailable"));
}

{
  const ctx = extractQueryContext("SELECT * FROM incidents WHERE circumstance_group = 'Felony Type'", "felony murder vs argument murder trend", "shr");
  const r = runGuardrails(ctx);
  assert("charge severity: felony murder not hard-stopped", !r.fired.includes("charge-severity-unavailable"));
}

// ══════════════════════════════════════════════════════════════════════
//  washington-ambiguity guardrail (2026-06-06 regression)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ washington-ambiguity ═══\n");

{
  // TP: bare "Washington" — should fire
  const ctx = extractQueryContext(
    "SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'WA' GROUP BY year",
    "domestic violence by city in Washington",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("TP: bare 'Washington' fires",
    r.fired.includes("washington-ambiguity"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: "Washington state" — should NOT fire
  const ctx = extractQueryContext(
    "SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'WA' GROUP BY year",
    "domestic violence in Washington state",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: 'Washington state' does NOT fire",
    !r.fired.includes("washington-ambiguity"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: "state of Washington" — should NOT fire
  const ctx = extractQueryContext(
    "SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'WA' GROUP BY year",
    "domestic violence by city in the state of Washington",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: 'state of Washington' does NOT fire",
    !r.fired.includes("washington-ambiguity"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: "in the state of Washington" — should NOT fire
  const ctx = extractQueryContext(
    "SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'WA' GROUP BY year",
    "show me crime in the state of Washington",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: 'in the state of Washington' does NOT fire",
    !r.fired.includes("washington-ambiguity"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: "WA" state abbreviation — should NOT fire
  const ctx = extractQueryContext(
    "SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'WA' GROUP BY year",
    "murder rate in WA",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: 'WA' state abbreviation does NOT fire",
    !r.fired.includes("washington-ambiguity"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: "Washington, DC" — should NOT fire
  const ctx = extractQueryContext(
    "SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'DC' GROUP BY year",
    "crime in Washington, DC",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: 'Washington, DC' does NOT fire",
    !r.fired.includes("washington-ambiguity"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: "by city in the state of Washington" — combined geography + state phrase
  const ctx = extractQueryContext(
    "SELECT d.data_year, a.city, a.state, COUNT(DISTINCT d.incident_num) AS dv_incidents FROM summary_domestic_violence d JOIN agencies a ON a.ori = d.ori WHERE a.state = 'WA' GROUP BY a.city, a.state ORDER BY dv_incidents DESC LIMIT 50",
    "domestic violence by city in the state of Washington",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: 'by city in the state of Washington' does NOT fire",
    !r.fired.includes("washington-ambiguity"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: still fires for genuinely ambiguous "Washington" with no context
  const ctx = extractQueryContext(
    "SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'WA' GROUP BY year",
    "crime in Washington",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("TP: bare 'crime in Washington' still fires",
    r.fired.includes("washington-ambiguity"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  nibrs-dv-wrong-table guardrail (2026-06-06)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ nibrs-dv-wrong-table ═══\n");

{
  // TP: user asks DV, model uses summary_city_monthly with 13A/13B/13C
  const ctx = extractQueryContext(
    "SELECT s.year, SUM(s.offense_count) AS assaults FROM summary_city_monthly s WHERE s.ucr_offense_code IN ('13A','13B','13C') AND s.state = 'WA' GROUP BY s.year",
    "domestic violence by city in Washington state",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("TP: DV question + summary_city_monthly fires dv-wrong-table",
    r.fired.includes("nibrs-dv-wrong-table"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: user says "DV" and model uses summary_state_monthly
  const ctx = extractQueryContext(
    "SELECT s.year, SUM(s.offense_count) FROM summary_state_monthly s WHERE s.ucr_offense_code = '13A' AND s.state = 'TX' GROUP BY s.year",
    "DV trends in Texas",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("TP: 'DV' question + summary_state_monthly fires",
    r.fired.includes("nibrs-dv-wrong-table"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: DV question using summary_domestic_violence — correct table
  const ctx = extractQueryContext(
    "SELECT data_year, COUNT(DISTINCT incident_num) AS dv_incidents FROM summary_domestic_violence WHERE state = 'WA' GROUP BY data_year ORDER BY data_year",
    "domestic violence trends in Washington state",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: DV question + summary_domestic_violence does NOT fire",
    !r.fired.includes("nibrs-dv-wrong-table"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: DV question using summary_dv_arrests — correct table
  const ctx = extractQueryContext(
    "SELECT year, SUM(arrest_count) AS arrests FROM summary_dv_arrests WHERE state = 'TX' GROUP BY year",
    "DV arrests in Texas",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: DV question + summary_dv_arrests does NOT fire",
    !r.fired.includes("nibrs-dv-wrong-table"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: non-DV assault question — should NOT fire even with summary_city_monthly
  const ctx = extractQueryContext(
    "SELECT s.year, SUM(s.offense_count) FROM summary_city_monthly s WHERE s.ucr_offense_code = '13A' GROUP BY s.year",
    "aggravated assault trends in Houston",
    "nibrs"
  );
  const r = runGuardrails(ctx);
  assert("FP: assault question (not DV) does NOT fire",
    !r.fired.includes("nibrs-dv-wrong-table"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  nibrs-raw-table-for-counts property value carveout (2026-06-06)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ nibrs-raw-table-for-counts property value carveout ═══\n");

{
  // FP: median shoplifting value — should NOT fire (legitimate raw-table use)
  const sql = `SELECT value FROM property p JOIN offenses o ON o.year = p.year AND o.state = p.state AND o.ori = p.ori AND o.incident_num = p.incident_num WHERE p.state = 'CA' AND p.year = 2024 AND o.ucr_offense_code = '23C' AND p.type_property_loss = '7' AND p.value > 0 AND p.value < 1000000 ORDER BY p.value LIMIT 1 OFFSET 50000`;
  const ctx = extractQueryContext(sql, "typical dollar value of shoplifting offenses in California", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: median shoplifting value does NOT fire raw-table guardrail",
    !r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: AVG(value) with tight filters — should NOT fire
  const sql = `SELECT AVG(p.value) AS avg_value FROM property p JOIN offenses o ON o.year = p.year AND o.state = p.state AND o.ori = p.ori AND o.incident_num = p.incident_num WHERE p.state = 'CA' AND p.year = 2024 AND o.ucr_offense_code = '23C' AND p.value > 0 GROUP BY o.location_type`;
  const ctx = extractQueryContext(sql, "average shoplifting value by location in California", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: AVG(value) with tight filters does NOT fire",
    !r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: raw property table for broad counts (no value analysis) — should still fire
  const sql = `SELECT p.property_description, COUNT(*) AS cnt FROM property p WHERE p.state = 'CA' AND p.year = 2024 GROUP BY p.property_description ORDER BY cnt DESC`;
  const ctx = extractQueryContext(sql, "what property is stolen most in California", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: raw property for COUNT still fires",
    r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: raw offenses table for counts — should still fire
  const sql = `SELECT o.ucr_offense_code, COUNT(*) FROM offenses o WHERE o.state = 'TX' AND o.year = 2024 GROUP BY o.ucr_offense_code`;
  const ctx = extractQueryContext(sql, "offense counts in Texas", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: raw offenses for COUNT still fires",
    r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: property value query without state filter — too broad, should fire
  const sql = `SELECT AVG(p.value) FROM property p JOIN offenses o ON o.year = p.year AND o.state = p.state AND o.ori = p.ori AND o.incident_num = p.incident_num WHERE o.ucr_offense_code = '23C' AND p.year = 2024 AND p.value > 0 GROUP BY o.location_type`;
  const ctx = extractQueryContext(sql, "shoplifting value by location nationally", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: property value without state filter still fires",
    r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: raw arrestees still fires
  const sql = `SELECT age, COUNT(*) FROM arrestees WHERE state = 'CA' AND year = 2024 GROUP BY age`;
  const ctx = extractQueryContext(sql, "arrests by age in California", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: raw arrestees for COUNT still fires",
    r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: 3762 replay — AVG(CAST(p.value AS FLOAT)) with tight filters
  const sql = `SELECT AVG(CAST(p.value AS FLOAT)) AS avg_value, COUNT(*) AS incidents, MIN(p.value) AS min_value, MAX(p.value) AS max_value FROM property p JOIN offenses o ON o.year = p.year AND o.state = p.state AND o.ori = p.ori AND o.incident_num = p.incident_num WHERE p.state = 'CA' AND p.year = 2024 AND o.ucr_offense_code = '23C' AND p.type_property_loss = '7' AND p.value > 0 AND p.value < 1000000`;
  const ctx = extractQueryContext(sql, "typical dollar value of shoplifting offenses in california", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: 3762 AVG(CAST(value)) does NOT fire raw-table guardrail",
    !r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: 3764 replay — SUM(p.value)/SUM(...) manual average with tight filters
  const sql = `SELECT o.ucr_offense_code, ROUND(SUM(p.value) / SUM(CASE WHEN p.value > 0 THEN 1 ELSE 0 END), 2) AS avg_value, COUNT(*) AS incidents FROM offenses o JOIN property p ON p.ori = o.ori AND p.incident_num = o.incident_num AND p.year = o.year WHERE o.state = 'CA' AND o.year BETWEEN 2022 AND 2026 AND o.ucr_offense_code IN ('23A','23B','23C','23D','23E','23F','23G','23H') AND o.location_type IN ('05','08','12','24','41','55') AND p.type_property_loss = '7' AND p.value > 0 AND p.value < 1000000 GROUP BY o.ucr_offense_code ORDER BY avg_value DESC`;
  const ctx = extractQueryContext(sql, "typical dollar value of theft offenses with business location in california", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: 3764 SUM(p.value) manual average does NOT fire raw-table guardrail",
    !r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: 3764-shaped — distribution/histogram with GROUP BY value, tight filters
  const sql = `SELECT p.value, COUNT(*) AS incidents FROM property p JOIN offenses o ON o.year = p.year AND o.state = p.state AND o.ori = p.ori AND o.incident_num = p.incident_num WHERE p.state = 'CA' AND o.year BETWEEN 2022 AND 2025 AND o.ucr_offense_code IN ('23A','23B','23C','23D','23E','23F','23G','23H') AND o.location_type IN ('07','08','09','19') AND p.type_property_loss = '7' AND p.value > 0 AND p.value < 1000000 GROUP BY p.value ORDER BY incidents DESC LIMIT 50`;
  const ctx = extractQueryContext(sql, "theft offenses with location type is a type of business in California", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: 3764-shaped distribution (GROUP BY value, BETWEEN year) does NOT fire",
    !r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: year IN (...) filter recognized
  const sql = `SELECT p.value, COUNT(*) AS cnt FROM property p JOIN offenses o ON o.year = p.year AND o.state = p.state AND o.ori = p.ori AND o.incident_num = p.incident_num WHERE p.state = 'TX' AND o.year IN (2023, 2024) AND o.ucr_offense_code = '23C' AND p.type_property_loss = '7' AND p.value > 0 GROUP BY p.value ORDER BY cnt DESC`;
  const ctx = extractQueryContext(sql, "shoplifting value distribution in Texas", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: year IN (...) filter recognized in property carveout",
    !r.fired.includes("nibrs-raw-table-for-counts"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  nibrs-dv-city-schema guardrail (2026-06-06)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ nibrs-dv-city-schema ═══\n");

{
  // TP: DV by city without agencies join
  const sql = `SELECT ori, COUNT(DISTINCT incident_num) AS dv_incidents FROM summary_domestic_violence WHERE state = 'WA' GROUP BY ori ORDER BY dv_incidents DESC LIMIT 50`;
  const ctx = extractQueryContext(sql, "domestic violence by city in Washington state", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: DV by city without agencies join fires dv-city-schema",
    r.fired.includes("nibrs-dv-city-schema"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: DV by city with COUNT(DISTINCT incident_num) — wrong counting method
  const sql = `SELECT a.city, a.state, COUNT(DISTINCT dv.incident_num) AS dv_incidents FROM summary_domestic_violence dv JOIN agencies a ON a.ori = dv.ori AND a.year = dv.data_year WHERE a.state = 'WA' AND a.agency_type = 'City' AND a.population > 0 GROUP BY a.city, a.state ORDER BY dv_incidents DESC LIMIT 50`;
  const ctx = extractQueryContext(sql, "top cities for domestic violence in Washington state", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: COUNT(DISTINCT incident_num) without ori composite fires",
    r.fired.includes("nibrs-dv-city-schema"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: correct DV by city query — all checks pass
  const sql = `SELECT a.city, a.state, COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num) AS dv_incidents FROM summary_domestic_violence dv JOIN agencies a ON a.ori = dv.ori AND a.year = dv.data_year WHERE a.state = 'WA' AND a.agency_type = 'City' AND a.population > 0 GROUP BY a.city, a.state ORDER BY dv_incidents DESC LIMIT 50`;
  const ctx = extractQueryContext(sql, "top cities for domestic violence in Washington state", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: correct DV by city query does NOT fire",
    !r.fired.includes("nibrs-dv-city-schema"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: DV state-level query — no city mention, should not fire
  const sql = `SELECT data_year, COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num) AS incidents FROM summary_domestic_violence dv WHERE dv.state = 'WA' GROUP BY dv.data_year ORDER BY dv.data_year`;
  const ctx = extractQueryContext(sql, "domestic violence trends in Washington state", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: state-level DV query does NOT fire dv-city-schema",
    !r.fired.includes("nibrs-dv-city-schema"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `WITH state_dv_incidents AS (SELECT dv.state, COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num) AS dv_incidents FROM summary_domestic_violence dv WHERE dv.data_year = 2025 GROUP BY dv.state), state_population AS (SELECT a.state, SUM(a.population * rpt.months_reported / 12.0) AS adj_population FROM agencies a JOIN (SELECT ori, year, COUNT(DISTINCT month) AS months_reported FROM summary_city_monthly WHERE year = 2025 GROUP BY ori, year) rpt ON rpt.ori = a.ori AND rpt.year = a.year WHERE a.year = 2025 AND a.population > 0 GROUP BY a.state) SELECT dv.state, dv.dv_incidents, ROUND(dv.dv_incidents * 100000.0 / NULLIF(pop.adj_population, 0), 1) AS rate_per_100k FROM state_dv_incidents dv LEFT JOIN state_population pop ON pop.state = dv.state ORDER BY rate_per_100k DESC LIMIT 50`;
  const ctx = extractQueryContext(sql, "please use Domestic violence incident counts per 100,000 population (per-capita rates), comparing cities or states, and lets compare across states", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: DV state-rate cross-summary join retries instead of hard-stopping",
    r.fired.includes("nibrs-cross-summary-join") && r.overrideResponse === null,
    `fired: ${JSON.stringify(r.fired)}, override=${r.overrideResponse}`);
  assert("TP: DV state-rate retry message points to nibrs_agency_completeness",
    r.issues.some((issue) => /nibrs_agency_completeness/.test(issue)),
    `issues: ${JSON.stringify(r.issues)}`);
  assert("TP: DV state-rate retry message uses reporting-population denominator",
    r.issues.some((issue) => /SUM\(a\.population \* nac\.months_reported \/ 12\.0\)/.test(issue) && /rate_per_100k/.test(issue) && /not a complete official state population/.test(issue)),
    `issues: ${JSON.stringify(r.issues)}`);
  assert("FP: DV state-rate question with quoted cities does not fire city-schema",
    !r.fired.includes("nibrs-dv-city-schema"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: DV by city, GROUP BY city only (missing state)
  const sql = `SELECT a.city, COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num) AS dv_incidents FROM summary_domestic_violence dv JOIN agencies a ON a.ori = dv.ori AND a.year = dv.data_year WHERE a.agency_type = 'City' GROUP BY a.city ORDER BY dv_incidents DESC LIMIT 50`;
  const ctx = extractQueryContext(sql, "top cities for domestic violence nationwide", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: GROUP BY city without state fires",
    r.fired.includes("nibrs-dv-city-schema"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT dv.state, SUM(dv.victim_count) AS victims FROM summary_domestic_violence dv WHERE dv.data_year = 2025 GROUP BY dv.state`;
  const ctx = extractQueryContext(sql, "domestic violence victim demographics across states", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: summary_domestic_violence victim_count column fires",
    r.fired.includes("nibrs-dv-victim-count-column"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: victim_count message tells model to count distinct victims",
    r.issues.some((issue) => /victim_sequence/.test(issue) && /Do not use SUM/.test(issue)),
    `issues: ${JSON.stringify(r.issues)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  missing-group-by-year guardrail (2026-06-06)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ missing-group-by-year ═══\n");

{
  // FP: 3791 shape — year only in WHERE + agency subquery, not in SELECT
  const sql = `SELECT CASE WHEN s.weapon_type IN ('11','11A') THEN 'Firearm' WHEN s.weapon_type = '12' THEN 'Handgun' ELSE s.weapon_type END AS weapon, SUM(s.victim_count) AS victims FROM summary_victim_weapon s WHERE s.ucr_offense_code = '09A' AND s.year = 2025 AND s.ori IN (SELECT ori FROM agencies WHERE city = 'HOUSTON' AND state = 'TX' AND year = 2025) GROUP BY weapon ORDER BY victims DESC`;
  const ctx = extractQueryContext(sql, "murders by weapon in Houston in 2025", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: 3791 — year in WHERE not SELECT does NOT fire",
    !r.fired.includes("missing-group-by-year"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: year in SELECT, GROUP BY weapon but not year → should fire and rewrite
  const sql = `SELECT year, weapon_category, SUM(victim_count) AS victims FROM summary_victim_weapon WHERE ucr_offense_code = '09A' GROUP BY weapon_category ORDER BY victims DESC`;
  const ctx = extractQueryContext(sql, "murders by weapon and year", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: year in SELECT, GROUP BY weapon without year fires",
    r.fired.includes("missing-group-by-year"),
    `fired: ${JSON.stringify(r.fired)}`);
  // Rewrite should append ", year" to existing GROUP BY, not create a second one
  assert("TP: rewrite appends year to existing GROUP BY",
    /GROUP\s+BY\s+weapon_category\s*,\s*year\b/i.test(r.sql) && !/GROUP\s+BY[\s\S]*GROUP\s+BY/i.test(r.sql),
    `rewritten: ${r.sql}`);
}

{
  // TP: year in SELECT, no GROUP BY at all → should insert GROUP BY year
  const sql = `SELECT year, SUM(victim_count) AS victims FROM summary_victim_state_monthly WHERE ucr_offense_code = '09A' AND state = 'TX' ORDER BY year`;
  const ctx = extractQueryContext(sql, "murders in Texas by year", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: year in SELECT, no GROUP BY fires",
    r.fired.includes("missing-group-by-year"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: rewrite inserts GROUP BY year before ORDER BY",
    /GROUP BY year\s+ORDER BY/i.test(r.sql),
    `rewritten: ${r.sql}`);
}

{
  // FP: scalar subquery with year in SELECT — should NOT fire
  const sql = `SELECT (SELECT MAX(year) FROM agencies) AS max_year, SUM(victim_count) AS total FROM summary_victim_state_monthly WHERE state = 'TX' AND year = 2024`;
  const ctx = extractQueryContext(sql, "total murders in Texas with max year", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: scalar subquery containing year does NOT fire",
    !r.fired.includes("missing-group-by-year"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: CTE with year — should skip (too risky to auto-fix)
  const sql = `WITH cte AS (SELECT year, state, SUM(victim_count) AS cnt FROM summary_victim_state_monthly WHERE ucr_offense_code = '09A' GROUP BY year, state) SELECT year, SUM(cnt) FROM cte GROUP BY year`;
  const ctx = extractQueryContext(sql, "murders by year nationally", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: CTE query does NOT fire (skipped)",
    !r.fired.includes("missing-group-by-year"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: year already in GROUP BY — should not fire
  const sql = `SELECT year, SUM(victim_count) AS victims FROM summary_victim_state_monthly WHERE state = 'TX' GROUP BY year ORDER BY year`;
  const ctx = extractQueryContext(sql, "murders in Texas by year", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: year already in GROUP BY does NOT fire",
    !r.fired.includes("missing-group-by-year"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: GROUP BY weapon ORDER BY year — year in ORDER BY not GROUP BY
  const sql = `SELECT year, weapon_category, SUM(victim_count) AS victims FROM summary_victim_weapon WHERE ucr_offense_code = '09A' GROUP BY weapon_category ORDER BY year`;
  const ctx = extractQueryContext(sql, "murders by weapon by year", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: year in ORDER BY but not GROUP BY fires",
    r.fired.includes("missing-group-by-year"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: rewrite becomes GROUP BY weapon_category, year ORDER BY year",
    /GROUP BY weapon_category, year\s+ORDER BY year/i.test(r.sql),
    `rewritten: ${r.sql}`);
}

// ══════════════════════════════════════════════════════════════════════
//  current-county-name-suffix guardrail (2026-06-06)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ current-county-name-suffix ═══\n");

{
  // TP: explicit Fairfax County agency — strip suffix, add type='County'
  const sql = `SELECT am.year, am.month, am.offense, am.count FROM agency_monthly am WHERE am.agency = 'Fairfax County' AND am.state = 'VA' ORDER BY am.year`;
  const ctx = extractQueryContext(sql, "crime for the Fairfax County agency in VA", "current");
  const r = runGuardrails(ctx);
  assert("TP: Fairfax County fires current-county-name-suffix",
    r.fired.includes("current-county-name-suffix"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: rewrite strips County, adds type='County'",
    /am\.agency\s*=\s*'Fairfax'/i.test(r.sql) && /am\.type\s*=\s*'County'/i.test(r.sql) && !/Fairfax County/i.test(r.sql),
    `rewritten: ${r.sql}`);
}

{
  // TP: explicit Jefferson Parish sheriff agency — Parish also maps to type='County'
  const sql = `SELECT am.year, am.offense, am.count FROM agency_monthly am WHERE am.agency = 'Jefferson Parish' AND am.state = 'LA' ORDER BY am.year`;
  const ctx = extractQueryContext(sql, "crime for the Jefferson Parish Sheriff in LA", "current");
  const r = runGuardrails(ctx);
  assert("TP: Jefferson Parish fires and rewrites",
    r.fired.includes("current-county-name-suffix"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: Parish stripped, type='County'",
    /am\.agency\s*=\s*'Jefferson'/i.test(r.sql) && /am\.type\s*=\s*'County'/i.test(r.sql),
    `rewritten: ${r.sql}`);
}

{
  // TP: bare agency (no alias) — agency = 'Baltimore County'
  const sql = `SELECT year, offense, count FROM agency_monthly WHERE agency = 'Baltimore County' AND state = 'MD'`;
  const ctx = extractQueryContext(sql, "crime for the Baltimore County Police Department in MD", "current");
  const r = runGuardrails(ctx);
  assert("TP: bare agency='Baltimore County' fires",
    r.fired.includes("current-county-name-suffix"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: bare agency rewrite strips suffix",
    /agency\s*=\s*'Baltimore'/i.test(r.sql) && /type\s*=\s*'County'/i.test(r.sql) && !/Baltimore County/i.test(r.sql),
    `rewritten: ${r.sql}`);
}

{
  // TP: conflicting type='City' should be replaced with 'County'
  const sql = `SELECT * FROM agency_monthly WHERE agency = 'Baltimore County' AND type = 'City' AND state = 'MD'`;
  const ctx = extractQueryContext(sql, "crime for the Baltimore County Police Department in MD", "current");
  const r = runGuardrails(ctx);
  assert("TP: conflicting type='City' replaced with 'County'",
    r.fired.includes("current-county-name-suffix"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: type='City' becomes type='County'",
    /type\s*=\s*'County'/i.test(r.sql) && !/type\s*=\s*'City'/i.test(r.sql),
    `rewritten: ${r.sql}`);
}

{
  // FP: Historical query with 'Alameda County' — should NOT fire (historical keeps suffix)
  const sql = `SELECT year, murder FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Alameda County' AND ha.type = 'county'`;
  const ctx = extractQueryContext(sql, "crime in Alameda County", "historical");
  const r = runGuardrails(ctx);
  assert("FP: historical 'Alameda County' does NOT fire current-county-name-suffix",
    !r.fired.includes("current-county-name-suffix"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: Current query without county suffix — should NOT fire
  const sql = `SELECT am.year, am.offense, am.count FROM agency_monthly am WHERE am.agency = 'Houston' AND am.state = 'TX'`;
  const ctx = extractQueryContext(sql, "crime in Houston", "current");
  const r = runGuardrails(ctx);
  assert("FP: plain city name does NOT fire",
    !r.fired.includes("current-county-name-suffix"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  shr-county-agency-name guardrail (2026-06-06)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ shr-county-agency-name ═══\n");

{
  // TP: Fairfax County exact match on SHR — should fire retry
  const sql = `SELECT i.year, COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.agency = 'Fairfax County' AND i.state = 'VA' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "Fairfax County Sheriff murders in Virginia", "shr");
  const r = runGuardrails(ctx);
  assert("TP: SHR Fairfax County fires shr-county-agency-name",
    r.fired.includes("shr-county-agency-name"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: retry message has LIKE and agency_type guidance",
    r.issues.some(i => /LIKE/i.test(i) && /agency_type/i.test(i)),
    `issues: ${r.issues.map(i => i.substring(0, 80))}`);
}

{
  // FP: city question on SHR — should NOT fire
  const sql = `SELECT i.year, COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.agency = 'Houston' AND i.state = 'TX' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "Houston murders", "shr");
  const r = runGuardrails(ctx);
  assert("FP: SHR city query does NOT fire shr-county-agency-name",
    !r.fired.includes("shr-county-agency-name"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: SHR query already using LIKE — should NOT fire
  const sql = `SELECT i.year, COUNT(*) FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.agency LIKE '%Fairfax%' AND i.state = 'VA' AND i.agency_type = 'County' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "Fairfax County Sheriff murders in Virginia", "shr");
  const r = runGuardrails(ctx);
  assert("FP: SHR LIKE query does NOT fire shr-county-agency-name",
    !r.fired.includes("shr-county-agency-name"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  city-like-no-state expansion (2026-06-06)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ city-like-no-state (expanded) ═══\n");

{
  // TP: Current — agency LIKE 'KINGS%' without state
  const sql = `SELECT * FROM agency_monthly WHERE agency LIKE 'KINGS%' ORDER BY year`;
  const ctx = extractQueryContext(sql, "crime in Kings County", "current");
  const r = runGuardrails(ctx);
  assert("TP: Current LIKE without state fires",
    r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: Historical — agency LIKE 'KINGS%' without state
  const sql = `SELECT * FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency LIKE 'KINGS%' ORDER BY hac.year`;
  const ctx = extractQueryContext(sql, "crime in Kings County", "historical");
  const r = runGuardrails(ctx);
  assert("TP: Historical LIKE without state fires",
    r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: Current — LIKE with uppercase state
  const sql = `SELECT * FROM agency_monthly WHERE agency LIKE 'KINGS%' AND state = 'NY'`;
  const ctx = extractQueryContext(sql, "crime in Kings County NY", "current");
  const r = runGuardrails(ctx);
  assert("FP: Current LIKE with state='NY' does NOT fire",
    !r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // FP: Historical — LIKE with lowercase state
  const sql = `SELECT * FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency LIKE 'KINGS%' AND ha.state = 'ny'`;
  const ctx = extractQueryContext(sql, "crime in Kings County NY", "historical");
  const r = runGuardrails(ctx);
  assert("FP: Historical LIKE with state='ny' (lowercase) does NOT fire",
    !r.fired.includes("city-like-no-state"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ══════════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════════

// topn-no-entity-limit
console.log("\n═══ topn-no-entity-limit ═══\n");

{
  // FP: one-row-per-entity ranking with outer LIMIT is correct
  const sql = `SELECT state, SUM(offense_count) AS drug_violations FROM summary_drug_monthly WHERE year = 2022 GROUP BY state ORDER BY drug_violations DESC LIMIT 10`;
  const ctx = extractQueryContext(sql, "Drug violations by state in 2022, top 10", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: top 10 one-row-per-state ranking does NOT fire",
    !r.fired.includes("topn-no-entity-limit"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: entity + time grouping needs a CTE/subquery to limit entities first
  const sql = `SELECT a.city, s.year, SUM(s.victim_count) AS murders FROM summary_victim_city_monthly s JOIN agencies a ON a.ori = s.ori AND a.year = s.year WHERE s.ucr_offense_code = '09A' AND s.year BETWEEN 2020 AND 2024 GROUP BY a.city, s.year ORDER BY murders DESC LIMIT 10`;
  const ctx = extractQueryContext(sql, "top 10 cities by murder trend from 2020 to 2024", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: top 10 grouped by city and year fires",
    r.fired.includes("topn-no-entity-limit"),
    `fired: ${JSON.stringify(r.fired)}`);
}
// nibrs city/state summary joins
console.log("\n═══ nibrs city/state summary joins ═══\n");

{
  // FP: separate city/state CTEs joined by year are the correct pattern
  const sql = `WITH city_data AS (SELECT year, SUM(offense_count) AS city_count FROM summary_city_monthly WHERE ucr_offense_code = '240' AND ori IN (SELECT ori FROM agencies WHERE city = 'EVERETT' AND state = 'WA' AND agency_type = 'City') GROUP BY year), state_data AS (SELECT year, SUM(offense_count) AS state_count FROM summary_state_monthly WHERE ucr_offense_code = '240' AND state = 'WA' GROUP BY year) SELECT c.year, c.city_count, s.state_count FROM city_data c JOIN state_data s ON s.year = c.year ORDER BY c.year`;
  const ctx = extractQueryContext(sql, "motor vehicle theft in Everett WA vs statewide", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: separate city/state CTE join does NOT fire cross-level guardrails",
    !r.fired.includes("nibrs-cross-level-join") && !r.fired.includes("nibrs-state-table-with-ori"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  // TP: direct city summary to state summary join multiplies rows
  const sql = `SELECT c.year, SUM(c.offense_count) AS city_count, SUM(s.offense_count) AS state_count FROM summary_city_monthly c JOIN summary_state_monthly s ON s.year = c.year WHERE c.ucr_offense_code = '240' AND s.ucr_offense_code = '240' GROUP BY c.year`;
  const ctx = extractQueryContext(sql, "motor vehicle theft in Everett WA vs statewide", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: direct city/state summary join fires",
    r.fired.includes("nibrs-cross-level-join"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// Wave 1: OR/AND precedence, lower-bound years, SHR homicide type, theft subtype labels
console.log("\n=== wave-1 query-contract guardrails ===\n");

{
  const sql = `SELECT year, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Houston' OR agency = 'Dallas' AND offense = 'Murder' GROUP BY year`;
  const ctx = extractQueryContext(sql, "Compare Houston and Dallas murders", "current");
  const r = runGuardrails(ctx);
  assert("TP: unparenthesized top-level OR/AND fires",
    r.fired.includes("or-and-precedence"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(count) AS murders FROM agency_monthly WHERE (agency = 'Houston' OR agency = 'Dallas') AND offense = 'Murder' GROUP BY year`;
  const ctx = extractQueryContext(sql, "Compare Houston and Dallas murders", "current");
  const r = runGuardrails(ctx);
  assert("FP: parenthesized OR group does not fire",
    !r.fired.includes("or-and-precedence"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(count) AS thefts FROM agency_monthly WHERE agency = 'Chicago' AND offense = 'Motor Vehicle Theft' GROUP BY year ORDER BY year`;
  const ctx = extractQueryContext(sql, "Chicago auto thefts from 2019 to present", "current");
  const r = runGuardrails(ctx);
  assert("TP: requested start year without SQL lower bound fires",
    r.fired.includes("contract-year-lower-bound-missing"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(count) AS thefts FROM agency_monthly WHERE agency = 'Chicago' AND offense = 'Motor Vehicle Theft' AND year >= 2019 GROUP BY year ORDER BY year`;
  const ctx = extractQueryContext(sql, "Chicago auto thefts from 2019 to present", "current");
  const r = runGuardrails(ctx);
  assert("FP: requested start year with SQL lower bound does not fire",
    !r.fired.includes("contract-year-lower-bound-missing"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const current = currentCalendarYear();
  const sql = `SELECT i.year, ROUND(100.0 * SUM(CASE WHEN i.weapon_group = 'Firearm' THEN 1 ELSE 0 END) / COUNT(*), 1) AS firearm_pct FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.homicide_type = 'Murder' AND i.year BETWEEN 2000 AND ${current - 1} GROUP BY i.year ORDER BY i.year`;
  const ctx = extractQueryContext(sql, `Share of murder committed via firearm, 2000 - ${current}, start Y-axis at 60%`, "shr");
  const r = runGuardrails(ctx);
  assert("TP: explicit current end year truncated to prior year fires",
    r.fired.includes("contract-year-upper-bound-missing"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const current = currentCalendarYear();
  const sql = `SELECT i.year, ROUND(100.0 * SUM(CASE WHEN i.weapon_group = 'Firearm' THEN 1 ELSE 0 END) / COUNT(*), 1) AS firearm_pct FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.homicide_type = 'Murder' AND i.year BETWEEN 2000 AND ${current} GROUP BY i.year ORDER BY i.year`;
  const ctx = extractQueryContext(sql, `Share of murder committed via firearm, 2000 - ${current}, start Y-axis at 60%`, "shr");
  const r = runGuardrails(ctx);
  assert("FP: explicit current end year included does not fire",
    !r.fired.includes("contract-year-upper-bound-missing"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const range = pastCompleteCalendarYearsRange(5);
  const current = currentCalendarYear();
  const sql = `SELECT year, SUM(count) AS murders FROM agency_monthly WHERE offense = 'Murder' AND year BETWEEN ${current - 4} AND ${current} GROUP BY year ORDER BY year`;
  const ctx = extractQueryContext(sql, "murder trend over the past 5 years", "current");
  const r = runGuardrails(ctx);
  assert("TP: past N years including current year fires",
    r.fired.includes("relative-past-years-complete-calendar"),
    `expected ${range.start}-${range.end}; fired: ${JSON.stringify(r.fired)}`);
}

{
  const range = pastCompleteCalendarYearsRange(5);
  const sql = `SELECT year, SUM(count) AS murders FROM agency_monthly WHERE offense = 'Murder' AND year BETWEEN ${range.start} AND ${range.end} GROUP BY year ORDER BY year`;
  const ctx = extractQueryContext(sql, "murder trend over the past 5 years", "current");
  const r = runGuardrails(ctx);
  assert("FP: past N complete-year range does not fire",
    !r.fired.includes("relative-past-years-complete-calendar"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const range = pastYearsIncludingCurrentRange(5);
  const sql = `SELECT year, SUM(count) AS murders FROM agency_monthly WHERE offense = 'Murder' AND year BETWEEN ${range.start} AND ${range.end} GROUP BY year ORDER BY year`;
  const ctx = extractQueryContext(sql, "murder trend over the past 5 years including this year", "current");
  const r = runGuardrails(ctx);
  assert("FP: past N including this year is allowed",
    !r.fired.includes("relative-past-years-complete-calendar"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT i.year, COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'PA' AND i.year = 2023 GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "How many homicides in Pennsylvania in 2023?", "shr");
  const r = runGuardrails(ctx);
  assert("TP: SHR homicide question without homicide_type fires",
    r.fired.includes("shr-homicide-type-missing"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT i.year, COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.state = 'PA' AND i.year = 2023 AND i.homicide_type = 'Murder' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "How many homicides in Pennsylvania in 2023?", "shr");
  const r = runGuardrails(ctx);
  assert("FP: SHR homicide question with homicide_type does not fire",
    !r.fired.includes("shr-homicide-type-missing"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(count) AS thefts FROM agency_monthly WHERE agency = 'Edmond' AND offense = 'Theft' GROUP BY year`;
  const ctx = extractQueryContext(sql, "larceny from auto in Edmond", "current");
  const r = runGuardrails(ctx);
  assert("TP: Current parent Theft for subtype request fires",
    r.fired.includes("current-historical-theft-subtype-parent"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(offense_count) AS larceny_from_auto FROM summary_city_monthly WHERE ucr_offense_code = '23F' GROUP BY year`;
  const ctx = extractQueryContext(sql, "larceny from auto in Edmond", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: NIBRS subtype code does not fire Current/Historical Theft caveat guardrail",
    !r.fired.includes("current-historical-theft-subtype-parent"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// Wave 2: NIBRS canonical offense categories and homicide semantics
console.log("\n=== wave-2 nibrs category guardrails ===\n");

{
  const sql = `SELECT year, SUM(victim_count) AS violent_crime FROM summary_victim_state_monthly WHERE ucr_offense_code IN ('09A','09B','09C','11A','11B','11C','11D','13A','13B','13C','100','36A','36B','64A','64B') GROUP BY year`;
  const ctx = extractQueryContext(sql, "violent crime in Texas since 2020", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: NIBRS broad persons taxonomy for bare violent crime fires",
    r.fired.includes("nibrs-offense-category-drift"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `WITH person AS (SELECT year, SUM(victim_count) AS cnt FROM summary_victim_state_monthly WHERE ucr_offense_code IN ('09A','11A','11B','11C','13A') GROUP BY year), robbery AS (SELECT year, SUM(offense_count) AS cnt FROM summary_state_monthly WHERE ucr_offense_code = '120' GROUP BY year) SELECT person.year, person.cnt + robbery.cnt AS violent_crime FROM person JOIN robbery ON robbery.year = person.year`;
  const ctx = extractQueryContext(sql, "violent crime in Texas since 2020", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: UCR-aligned violent code set does not fire",
    !r.fired.includes("nibrs-offense-category-drift"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(offense_count) AS property_crime FROM summary_state_monthly WHERE ucr_offense_code IN ('120','200','210','220','23A','23B','23C','23D','23E','23F','23G','23H','240','250','26A','26B','26C','26D','26E','26F','26G','270','280','290','510') GROUP BY year`;
  const ctx = extractQueryContext(sql, "property crime in Texas since 2020", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: NIBRS property taxonomy for bare property crime fires",
    r.fired.includes("nibrs-offense-category-drift"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(offense_count) AS property_crime FROM summary_state_monthly WHERE ucr_offense_code IN ('200','220','23A','23B','23C','23D','23E','23F','23G','23H','240') GROUP BY year`;
  const ctx = extractQueryContext(sql, "property crime in Texas since 2020", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: UCR-aligned property code set does not fire",
    !r.fired.includes("nibrs-offense-category-drift"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(victim_count) AS homicides FROM summary_victim_state_monthly WHERE ucr_offense_code IN ('09A','09B','09C') GROUP BY year`;
  const ctx = extractQueryContext(sql, "homicides in Pennsylvania", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: NIBRS ordinary homicide with 09B/09C fires",
    r.fired.includes("nibrs-homicide-code-drift"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(victim_count) AS homicides FROM summary_victim_state_monthly WHERE ucr_offense_code IN ('09A','09B','09C') GROUP BY year`;
  const ctx = extractQueryContext(sql, "all homicide types in Pennsylvania", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: explicit all homicide types does not fire",
    !r.fired.includes("nibrs-homicide-code-drift"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT dv.data_year, COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num) AS dv_incidents FROM summary_domestic_violence dv JOIN agencies a ON a.ori = dv.ori AND a.year = dv.data_year WHERE a.city = 'Chicago' AND dv.data_year = 2024 GROUP BY dv.data_year`;
  const ctx = extractQueryContext(sql, "police involved domestic violence incidents in Chicago 2024", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: NIBRS police-involved DV hard-stops",
    r.fired.includes("nibrs-officer-involved-unsupported"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: NIBRS police-involved DV override",
    r.overrideResponse !== null && r.overrideResponse.includes("does not identify whether a police officer"),
    r.overrideResponse || "no override");
}

{
  const sql = `SELECT year, SUM(victim_count) AS victims FROM summary_victim_circumstance WHERE ucr_offense_code = '09C' AND circumstance_code = '21' GROUP BY year`;
  const ctx = extractQueryContext(sql, "justifiable homicides where criminals were killed by police", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: NIBRS killed-by-police justifiable homicide remains answerable",
    !r.fired.includes("nibrs-officer-involved-unsupported"),
    `fired: ${JSON.stringify(r.fired)}`);
}

// ═════════════════════════════════════════════════════════════════════
//  countywide-crosswalk-required guardrail
// ═════════════════════════════════════════════════════════════════════

console.log("\n═══ countywide-crosswalk-required ═══\n");

{
  const sql = `SELECT hac.year, hac.violent FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency LIKE '%Mecklenburg%' AND ha.state = 'nc' AND ha.type = 'county' AND hac.year BETWEEN 2002 AND 2024 ORDER BY hac.year LIMIT 1000`;
  const ctx = extractQueryContext(sql, "Show me violent crime trends in Mecklenburg county in North Carolina between 2002 and 2024", "historical");
  const r = runGuardrails(ctx);
  assert("TP: #4213 Historical countywide agency pattern fires",
    r.fired.includes("countywide-crosswalk-required"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: #4213 retry instruction names crosswalk",
    r.issues.some((m) => m.includes("agency_county_crosswalk") && m.includes("MECKLENBURG") && m.includes("NC")),
    r.issues.join("\n"));
}

{
  const sql = `SELECT hac.year, SUM(hac.violent) AS violent FROM historical_agency_crime hac JOIN agency_county_crosswalk ac ON hac.ori = ac.ori9 OR substr(hac.ori, 1, 7) = ac.ori WHERE ac.state = 'NC' AND ac.county_key = 'MECKLENBURG' AND hac.year BETWEEN 2002 AND 2024 GROUP BY hac.year ORDER BY hac.year`;
  const ctx = extractQueryContext(sql, "Show me violent crime trends in Mecklenburg county in North Carolina between 2002 and 2024", "historical");
  const r = runGuardrails(ctx);
  assert("FP: Historical countywide query using crosswalk does not fire",
    !r.fired.includes("countywide-crosswalk-required"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT hac.year, hac.violent FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency LIKE '%Mecklenburg%' AND ha.state = 'NC' AND ha.type = 'county' AND hac.year BETWEEN 2002 AND 2024 ORDER BY hac.year`;
  const ctx = extractQueryContext(sql, "Show violent crime for Mecklenburg County Sheriff in North Carolina between 2002 and 2024", "historical");
  const r = runGuardrails(ctx);
  assert("FP: explicit county sheriff agency question does not require crosswalk",
    !r.fired.includes("countywide-crosswalk-required"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT data_year, SUM(offense_count) AS robberies FROM summary_city_monthly WHERE state = 'CA' AND agency_name LIKE '%Santa Clara%' AND ucr_offense_code = '120' GROUP BY data_year`;
  const ctx = extractQueryContext(sql, "show robberies in Santa Clara County California", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: NIBRS countywide query without crosswalk fires",
    r.fired.includes("countywide-crosswalk-required"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT data_year, SUM(offense_count) AS robberies FROM summary_city_monthly scm JOIN agency_county_crosswalk ac ON scm.ori = ac.ori9 OR substr(scm.ori, 1, 7) = ac.ori WHERE ac.state = 'CA' AND ac.county_key = 'SANTA CLARA' AND ucr_offense_code = '120' GROUP BY data_year`;
  const ctx = extractQueryContext(sql, "show robberies in Santa Clara County California", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: NIBRS countywide query using crosswalk does not fire",
    !r.fired.includes("countywide-crosswalk-required"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT i.year, COUNT(*) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.agency = 'Cook County' AND i.state = 'IL' GROUP BY i.year`;
  const ctx = extractQueryContext(sql, "murders in Cook County Illinois since 2020", "shr");
  const r = runGuardrails(ctx);
  assert("TP: SHR countywide query using agency name fires",
    r.fired.includes("countywide-crosswalk-required"),
    `fired: ${JSON.stringify(r.fired)}`);
}
console.log("\n=== nibrs-continuous-reporting-required ===\n");

{
  const sql = `SELECT d.year, d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ucr_offense_code IN ('09A','120','13A') AND d.year BETWEEN 2018 AND 2025 GROUP BY d.year, d.age_group`;
  const ctx = extractQueryContext(sql, "show murders, robberies, and aggravated assaults by offender age and year from continuously reporting agencies", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: continuous reporter request without filter fires",
    r.fired.includes("nibrs-continuous-reporting-required"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT d.year, d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ucr_offense_code IN ('09A','120','13A') AND d.year BETWEEN 2018 AND 2025 AND d.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = 2018 AND end_year = 2025) GROUP BY d.year, d.age_group`;
  const ctx = extractQueryContext(sql, "show murders, robberies, and aggravated assaults by offender age and year from continuously reporting agencies", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: continuous reporter request with range table passes",
    !r.fired.includes("nibrs-continuous-reporting-required"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT d.year, d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ucr_offense_code IN ('09A','120','13A') AND d.year BETWEEN 2018 AND 2025 AND d.ori IN (SELECT ori FROM nibrs_agency_completeness WHERE year BETWEEN 2018 AND 2025 AND months_reported = 12 GROUP BY ori HAVING COUNT(*) = 8) GROUP BY d.year, d.age_group`;
  const ctx = extractQueryContext(sql, "only include agencies that reported every year from 2018 through 2025", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: completeness fallback must use precomputed consistent reporter table",
    r.fired.includes("nibrs-continuous-reporting-required"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT d.year, d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ucr_offense_code IN ('09A','120','13A') AND d.year BETWEEN 2018 AND 2025 AND d.ori IN (SELECT ori FROM nibrs_agency_completeness WHERE year BETWEEN 2018 AND 2025 GROUP BY ori HAVING COUNT(*) = 8) GROUP BY d.year, d.age_group`;
  const ctx = extractQueryContext(sql, "only include agencies that reported every year from 2018 through 2025", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: completeness fallback without 12 months still fires",
    r.fired.includes("nibrs-continuous-reporting-required"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(victim_count) AS murders
    FROM summary_victim_state_monthly
    WHERE ucr_offense_code = '09A' AND year BETWEEN 2020 AND 2024
    GROUP BY year`;
  const ctx = extractQueryContext(sql, "murder trend from 2020 to 2024 among agencies that reported all 12 months every year", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: continuous reporter request using state summary table fires",
    r.fired.includes("nibrs-continuous-reporting-required"),
    `fired: ${JSON.stringify(r.fired)}`);
}

console.log("\n=== historical staffing per-100k scatter regression ===\n");

{
  const sql = `
WITH city_pop AS (
  SELECT DISTINCT ha.ori, ha.agency, ha.state, hap.population
  FROM historical_agency ha
  JOIN historical_agency_population hap ON hap.ori = ha.ori AND hap.year = 2024
  WHERE ha.type = 'city' AND hap.population >= 250000
),
crime_data AS (
  SELECT cp.ori, cp.agency, cp.state, cp.population,
         ROUND(hac.violent * 100000.0 / cp.population, 1) AS violent_rate
  FROM city_pop cp
  JOIN historical_agency_crime hac ON hac.ori = cp.ori AND hac.year = 2024
),
staff_data AS (
  SELECT cp.ori,
         ROUND(hs.officer_total * 1000.0 / cp.population, 1) AS officers_per_1k
  FROM city_pop cp
  JOIN historical_staffing hs ON hs.ori = cp.ori AND hs.year = 2024
  WHERE hs.officer_total > 0
)
SELECT cd.agency || ', ' || UPPER(cd.state) AS city, cd.violent_rate, sd.officers_per_1k
FROM crime_data cd
LEFT JOIN staff_data sd ON sd.ori = cd.ori
WHERE cd.violent_rate IS NOT NULL AND sd.officers_per_1k IS NOT NULL
ORDER BY cd.violent_rate DESC LIMIT 1000`;
  const ctx = extractQueryContext(sql, "give me a scatter plot of violent crime rate per 100k in 2024 vs officers per 100k in cities of 250k or more", "historical");
  const r = runGuardrails(ctx);
  assert("TP: #4272 officer per-100k unit guardrail fires",
    r.fired.includes("historical-officers-per-100k-unit"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: #4272 violent rate alias guardrail fires",
    r.fired.includes("historical-violent-rate-per-100k-alias"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: #4272 rewritten SQL uses officers_per_100k",
    /\bofficers_per_100k\b/i.test(r.sql) && !/\bofficers_per_1k\b/i.test(r.sql),
    r.sql);
  assert("TP: #4272 rewritten SQL uses 100k officer denominator",
    /officer_total\s*\*\s*100000\.0/i.test(r.sql) && !/officer_total\s*\*\s*1000\.0/i.test(r.sql),
    r.sql);
  assert("TP: #4272 rewritten SQL uses explicit violent per-100k alias",
    /\bviolent_crime_rate_per_100k\b/i.test(r.sql) && !/\bviolent_rate\b/i.test(r.sql),
    r.sql);
}

console.log("\n=== historical state/national aggregate column regression ===\n");

{
  const sql = `SELECT year, state, ROUND(violent_rate, 1) AS violent_crime_rate FROM historical_state_national WHERE state IN ('New Hampshire', 'Massachusetts') AND year >= 2000 ORDER BY state, year LIMIT 1000`;
  const ctx = extractQueryContext(sql, "What is the vilont ctime rate in NH versus Massachussetts sincce 2000", "historical");
  const r = runGuardrails(ctx);
  assert("TP: #4279 historical_state_national violent_rate rewrite fires",
    r.fired.includes("historical-state-national-aggregate-columns"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: #4279 rewritten SQL computes violent rate from component rates",
    /murder_rate\s*\+\s*rape_rate\s*\+\s*robbery_rate\s*\+\s*aggravated_assault_rate/i.test(r.sql) && !/\bviolent_rate\b/i.test(r.sql),
    r.sql);
}

{
  const sql = `SELECT year, ROUND((murder + rape + robbery + assault) * 100000.0 / population, 1) AS violent_crime_rate FROM historical_state_national WHERE state = 'Massachusetts' AND year >= 2000 ORDER BY year LIMIT 1000`;
  const ctx = extractQueryContext(sql, "violent crime rate in Massachusetts since 2000", "historical");
  const r = runGuardrails(ctx);
  assert("TP: historical_state_national assault alias rewrite fires",
    r.fired.includes("historical-state-national-aggregate-columns"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: historical_state_national assault alias rewritten",
    /\baggravated_assault\b/i.test(r.sql) && !/(?<!aggravated_)\bassault\b/i.test(r.sql),
    r.sql);
}

{
  const sql = `SELECT year,
    ROUND(CASE WHEN state = 'California' THEN murder_rate END, 1) AS california,
    ROUND(CASE WHEN state = 'Texas' THEN murder_rate END, 1) AS texas,
    ROUND(CASE WHEN state = 'Georgia' THEN murder_rate END, 1) AS georgia,
    ROUND(CASE WHEN state = 'New York' THEN murder_rate END, 1) AS new_york,
    ROUND(CASE WHEN state = 'Illinois' THEN murder_rate END, 1) AS illinois
  FROM historical_state_national
  WHERE state IN ('California', 'Texas', 'Georgia', 'New York', 'Illinois')
  ORDER BY year LIMIT 1000`;
  const ctx = extractQueryContext(sql, "CA vs. TX vs. GA vs NY vs IL murder rate per year", "historical");
  const r = runGuardrails(ctx);
  assert("TP: #4476 historical pivot without GROUP BY year fires",
    r.fired.includes("historical-state-pivot-missing-group-by"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: #4476 retry instruction requires GROUP BY year",
    r.issues.some((issue) => /GROUP BY year/i.test(issue) && /one row per year/i.test(issue)),
    `issues: ${JSON.stringify(r.issues)}`);
}

{
  const sql = `SELECT year,
    ROUND(MAX(CASE WHEN state = 'California' THEN murder_rate END), 1) AS california,
    ROUND(MAX(CASE WHEN state = 'Texas' THEN murder_rate END), 1) AS texas,
    ROUND(MAX(CASE WHEN state = 'New York' THEN murder_rate END), 1) AS new_york
  FROM historical_state_national
  WHERE state IN ('California', 'Texas', 'New York')
  GROUP BY year
  ORDER BY year LIMIT 1000`;
  const ctx = extractQueryContext(sql, "CA vs TX vs NY murder rate per year", "historical");
  const r = runGuardrails(ctx);
  assert("FP: valid historical pivot with GROUP BY year passes",
    !r.fired.includes("historical-state-pivot-missing-group-by"),
    `fired: ${JSON.stringify(r.fired)}`);
}

console.log("\n=== June 14-15 query audit regressions ===\n");

{
  const sql = `WITH city_data AS (
  SELECT am.ori, am.agency, am.state, am.year, SUM(am.count) as murders
  FROM agency_monthly am
  JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year
  WHERE am.type = 'City' AND am.offense = 'Murder' AND am.year = 2025 AND ap.population >= 500000
  GROUP BY am.ori, am.agency, am.state, am.year
)
SELECT cd.agency || ', ' || cd.state as city, cd.murders, ap.population,
  ROUND(cd.murders * 100000.0 / ap.population, 1) as rate_per_100k
FROM city_data cd JOIN agency_population ap ON ap.ori = cd.ori AND ap.year = cd.year
ORDER BY rate_per_100k DESC LIMIT 20`;
  const ctx = extractQueryContext(sql, "los angeles homicide rate in 2025 vs. other large cities", "current");
  const r = runGuardrails(ctx);
  assert("TP: #4322 requested city cannot be omitted by LIMIT",
    r.fired.includes("requested-entity-vs-other-omitted"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT i.state, i.agency, COUNT(*) as victims,
    ROUND(COUNT(*) * 100000.0 / NULLIF(AVG(i.population), 0), 1) as rate_per_100k
    FROM incidents i JOIN victims v ON v.incident_id = i.id
    WHERE i.year = 2025 AND i.homicide_type = 'Murder'
    AND (i.agency_type = 'City' OR i.agency_type IS NULL OR i.agency_type = '')
    AND AVG(i.population) >= 250000
    GROUP BY i.state, i.agency ORDER BY rate_per_100k DESC LIMIT 20`;
  const ctx = extractQueryContext(sql, "los angeles homicide rate in 2025 vs. other large cities", "shr");
  const r = runGuardrails(ctx);
  assert("FP: #4323 SHR city ranking may use AVG population per agency",
    !r.fired.includes("shr-rate-bad-denominator"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: #4323 aggregate function in WHERE still retries",
    r.fired.includes("shr-aggregate-in-where"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, month, rolling_12month FROM (
    SELECT year, month, SUM(offense_count) OVER (ORDER BY year, month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS rolling_12month
    FROM (SELECT s.year, s.month, SUM(s.offense_count) AS offense_count
      FROM summary_carjacking_monthly s
      WHERE s.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year <= 2019 AND end_year >= 2019)
      AND s.year >= 2019 AND s.year <= 2026 GROUP BY s.year, s.month)
  ) WHERE year >= 2019 ORDER BY year, month LIMIT 1000`;
  const ctx = extractQueryContext(sql, "Carjackings rolling over 12 months since 2019 in consistent reporting agencies", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: #4327 broad start-only consistent reporter interval fires",
    r.fired.includes("nibrs-consistent-reporter-range-contract"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, month, rolling_12month FROM (
    SELECT year, month, SUM(offense_count) OVER (ORDER BY year, month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS rolling_12month
    FROM (SELECT s.year, s.month, SUM(s.offense_count) AS offense_count
      FROM summary_carjacking_monthly s
      WHERE s.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = 2018 AND end_year = 2026)
      AND s.year >= 2018 AND s.year <= 2026 GROUP BY s.year, s.month)
  ) WHERE year >= 2019 AND (year < 2026 OR (year = 2026 AND month = 1)) ORDER BY year, month LIMIT 1000`;
  const ctx = extractQueryContext(sql, "No, in the consistent reporters", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: #4331 current partial year cannot be exact consistent-reporter end",
    r.fired.includes("nibrs-consistent-reporter-range-contract"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT d.year, COUNT(DISTINCT d.ori || ':' || d.year || ':' || d.ucr_offense_code) AS offenses
    FROM summary_offender_demographics d
    WHERE d.age_group = 'Under 18' AND d.year BETWEEN 2021 AND 2025
    GROUP BY d.year`;
  const ctx = extractQueryContext(sql, "juvenile offender offenses by year since 2021", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: #4348 offender summary combo count fires",
    r.fired.includes("nibrs-offender-summary-count-contract"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT d.year, SUM(d.offender_count) AS offenders
    FROM summary_offender_demographics d
    WHERE d.age_group = 'Under 18' AND d.year BETWEEN 2021 AND 2025
    GROUP BY d.year`;
  const ctx = extractQueryContext(sql, "juvenile offenders by year since 2021", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: offender summary SUM(offender_count) passes",
    !r.fired.includes("nibrs-offender-summary-count-contract"),
    `fired: ${JSON.stringify(r.fired)}`);
}

console.log("\n=== June 16 query audit regressions ===\n");

{
  const sql = `SELECT d.year, SUM(d.offender_count) AS offenders
    FROM summary_offender_demographics d
    WHERE d.year BETWEEN 2017 AND 2025
      AND d.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year <= 2017 AND end_year >= 2025)
    GROUP BY d.year`;
  const ctx = extractQueryContext(sql, "show offender counts from 2017 to 2025 among consistent reporting agencies", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: #4375 broad containing consistent-reporter range fires",
    r.fired.includes("nibrs-consistent-reporter-range-contract"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT CASE WHEN w.weapon_type IN ('11','12','13','14','15') THEN 'Firearm' WHEN w.weapon_type = '20' THEN 'Knife/Stabbing' ELSE 'Other' END AS weapon_type,
    SUM(w.offense_count) AS offenses
    FROM summary_offense_weapon w
    WHERE w.year = 2024 AND w.ucr_offense_code IN ('09A','120','13A')
    GROUP BY weapon_type
    ORDER BY offenses DESC`;
  const ctx = extractQueryContext(sql, "number of gun crimes vs stabbings in 2024", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: #4389 weapon CASE alias shadow fires",
    r.fired.includes("nibrs-weapon-group-by-code"),
    `fired: ${JSON.stringify(r.fired)}`);
  assert("TP: #4389 weapon CASE alias rewritten",
    /\bAS\s+weapon_group\b/i.test(r.sql) && /\bGROUP\s+BY\s+weapon_group\b/i.test(r.sql),
    r.sql);
}

{
  const sql = `SELECT v.injury_type, w.weapon_type, COUNT(*) AS victims
    FROM victims v
    JOIN offense_weapons w ON w.ori = v.ori AND w.year = v.year AND w.incident_num = v.incident_num
    WHERE v.year = 2024
    GROUP BY v.injury_type, w.weapon_type`;
  const ctx = extractQueryContext(sql, "firearm crimes in 2024 by injury type", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: #4393 broad weapon+injury combination returns friendly override",
    r.fired.includes("nibrs-weapon-injury-combination-unsupported") && /combined weapon-by-injury table/i.test(r.overrideResponse || ""),
    `fired: ${JSON.stringify(r.fired)} override=${r.overrideResponse}`);
}

{
  const sql = `SELECT CASE WHEN w.weapon_type IN ('11','12','13','14','15') THEN 'Firearm' ELSE 'Other' END AS weapon_group,
    SUM(w.offense_count) AS assaults
    FROM summary_offense_weapon w
    WHERE w.year = 2024 AND w.ucr_offense_code IN ('13A','13B')
    GROUP BY weapon_group`;
  const ctx = extractQueryContext(sql, "breakdown of weapons used in assaults 2024", "nibrs");
  const r = runGuardrails(ctx);
  assert("TP: #4394 bare assault partial code set fires",
    r.fired.includes("nibrs-bare-assault-partial-code-set"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT CASE WHEN w.weapon_type IN ('11','12','13','14','15') THEN 'Firearm' ELSE 'Other' END AS weapon_group,
    SUM(w.offense_count) AS assaults
    FROM summary_offense_weapon w
    WHERE w.year = 2024 AND w.ucr_offense_code IN ('13A','13B','13C')
    GROUP BY weapon_group`;
  const ctx = extractQueryContext(sql, "breakdown of weapons used in assaults 2024", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: bare assault all three NIBRS assault codes passes",
    !r.fired.includes("nibrs-bare-assault-partial-code-set"),
    `fired: ${JSON.stringify(r.fired)}`);
}

{
  const sql = `SELECT year, SUM(victim_count) AS aggravated_assaults
    FROM summary_victim_state_monthly
    WHERE ucr_offense_code = '13A' AND year >= 2020
    GROUP BY year`;
  const ctx = extractQueryContext(sql, "aggravated assault trend since 2020", "nibrs");
  const r = runGuardrails(ctx);
  assert("FP: explicit aggravated assault single code passes",
    !r.fired.includes("nibrs-bare-assault-partial-code-set"),
    `fired: ${JSON.stringify(r.fired)}`);
}

console.log("\n" + "═".repeat(60));
console.log(`SUMMARY: ${pass} passed, ${fail} failed out of ${pass + fail} tests`);
console.log("═".repeat(60));

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  }
}

process.exit(fail > 0 ? 1 : 0);
