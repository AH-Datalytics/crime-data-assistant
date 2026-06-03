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

// #10: Ethnicity override
{
  const sql = `SELECT year, ethnicity, SUM(arrestee_count) FROM summary_arrestee_demographics GROUP BY year, ethnicity`;
  const ctx = extractQueryContext(sql, "What percentage of white people are hispanic?", "nibrs");
  const r = runGuardrails(ctx);
  assert("#10 ethnicity: fires", r.fired.includes("nibrs-ethnicity-unavailable"));
  // Override should fire since ethnicity isn't in the deployed summary tables yet
  assert("#10 ethnicity: override", r.overrideResponse !== null);
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

// ══════════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════════

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
