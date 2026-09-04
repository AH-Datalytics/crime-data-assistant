import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { validateAndSanitize } from "../lib/sql-safety.js";
import { resolveNibrsPlaces } from "../lib/nibrs-place-resolver.js";
import {
  buildNibrsClearanceMethodQuery,
  buildNibrsClearanceTypeBreakdownQuery,
  buildNibrsComparableAgencyClearanceQuery,
  buildNibrsDomesticViolenceAggravatedAssaultShareQuery,
  buildNibrsLocalCityOffenseCountQuery,
  buildNibrsLocalDemographicQuery,
  buildNibrsStructuredLocalTrendQuery,
} from "../lib/nibrs-deterministic-queries.js";

{
  const query = buildNibrsComparableAgencyClearanceQuery(
    "Compare the rape clearance rate for the San Francisco Police Department against 3 agencies of similar size from 2021 to 2024",
    {
      question: "",
      startYear: 2021,
      endYear: 2024,
      hasStateComparison: false,
      elapsedMs: 0,
      places: [{
        contractIndex: 0,
        requestedName: "San Francisco",
        label: "San Francisco Police Department",
        state: "CA",
        kind: "city_police",
        status: "resolved",
        confidence: "high",
        oriYears: [
          { year: 2021, ori: "CA0380100", population: 815201 },
          { year: 2022, ori: "CA0380100", population: 808437 },
          { year: 2023, ori: "CA0380100", population: 808988 },
          { year: 2024, ori: "CA0380100", population: 827526 },
        ],
        oriRanges: [{ ori: "CA0380100", startYear: 2021, endYear: 2024 }],
        reason: "test",
      }],
    }
  );
  assert.ok(query, "similar-size agency clearance comparison should be deterministic");
  assert.match(query.sql, /LIMIT 3/);
  assert.match(query.sql, /summary_clearance_type sct INDEXED BY idx_sct_ori_year/);
  assert.match(query.sql, /ucr_offense_code IN \('11A', '11B', '11C'\)/);
  assert.match(query.sql, /sct\.year BETWEEN 2021 AND 2024/);
  assert.match(query.sql, /arrest_rate_pct/);
  assert.match(query.sql, /exceptional_rate_pct/);
  assert.equal(validateAndSanitize(query.sql).valid, true);
  assert.equal(query.guardrail, "deterministic-nibrs-comparable-agency-clearance");
}

{
  // A city clearance-method query must filter by the RESOLVED agency, never by
  // agencies.city. That column is a mailing city: 'SAINT LOUIS' matches 53
  // agencies in production, so the old city-name predicate summed the entire
  // metro into one figure -- the 8376 defect, in the deterministic path, where
  // the model-path ORI enforcement cannot see it.
  const cityDb = new Database(":memory:");
  cityDb.exec(`
    CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT, covered_flag TEXT, agency_indicator TEXT);
    CREATE INDEX idx_agencies_state_city_year ON agencies(state, city, year);
    INSERT INTO agencies VALUES
      ('ILCPD0000', 2021, 'IL', 'CHICAGO', 'City', 2700000, '1A', 'N', 'E'),
      ('ILCPD0000', 2025, 'IL', 'CHICAGO', 'City', 2660000, '1A', 'N', 'E'),
      ('MOSPD0000', 2025, 'MO', 'SAINT LOUIS', 'City', 274819, '1C', 'N', 'E'),
      ('MO0957300', 2025, 'MO', 'SAINT LOUIS', 'City', 34147, '4', 'N', 'E'),
      ('MO0956200', 2025, 'MO', 'ST LOUIS', 'City', 9052, '6', 'N', 'E');
  `);

  const chicagoQ = "How many robberies in Chicago were cleared by arrest versus exceptional means from 2021 to 2025?";
  const query = buildNibrsClearanceMethodQuery(chicagoQ, resolveNibrsPlaces(cityDb, chicagoQ));
  assert.ok(query, "city clearance-method comparison should be deterministic");
  assert.match(query.sql, /summary_clearance_type sct INDEXED BY idx_sct_ori_year/i);
  assert.match(query.sql, /sct\.ucr_offense_code = '120'/i);
  assert.match(query.sql, /sct\.ori IN \('ILCPD0000'\)/i);
  assert.doesNotMatch(query.sql, /city\s*=/i, "must not select the agency by city name");
  assert.match(query.sql, /sct\.year BETWEEN 2021 AND 2025/i);
  assert.equal(query.guardrail, "deterministic-nibrs-clearance-method");

  // St. Louis resolves to SLMPD alone, not every agency sharing the mailing city
  for (const stl of [
    "murder clearance by arrest and exceptional means in St Louis, MO in 2025",
    "murder clearances by arrest and exceptional means in St Louis, MO in 2025",
  ]) {
    const built = buildNibrsClearanceMethodQuery(stl, resolveNibrsPlaces(cityDb, stl));
    assert.ok(built, `plural and singular must both reach the deterministic path: ${stl}`);
    assert.match(built.sql, /sct\.ori IN \('MOSPD0000'\)/i);
    assert.doesNotMatch(built.sql, /city\s*=/i);
  }

  // With nothing resolved there is no safe query to build; fall through to the
  // model, where resolvedOriEnforcementIssue applies.
  assert.equal(buildNibrsClearanceMethodQuery(chicagoQ, null), null);

  // This builder emits one geography predicate, so a multi-place request must not
  // reach it. Left unguarded it answered for the first city and dropped the rest
  // silently -- an answer that looks complete and is not.
  cityDb.exec("INSERT INTO agencies VALUES ('TXDPD0000', 2025, 'TX', 'DALLAS', 'City', 1246336, '1A', 'N', 'E');");
  const twoCityQ = "murder clearances by arrest and exceptional means in Chicago and Dallas in 2025";
  const twoCityPlan = resolveNibrsPlaces(cityDb, twoCityQ);
  assert.equal(
    twoCityPlan?.places.filter((p) => p.status === "resolved").length,
    2,
    "fixture must resolve both cities, so the guard is what declines and not a resolution failure"
  );
  assert.equal(
    buildNibrsClearanceMethodQuery(twoCityQ, twoCityPlan),
    null,
    "multi-city clearance requests must go to the model path, not answer for city one"
  );
  cityDb.close();
}

{
  const query = buildNibrsClearanceMethodQuery(
    "How many robberies in Texas were cleared by arrest versus exceptional means from 2021 to 2025?"
  );
  assert.ok(query, "state clearance-method comparison should be deterministic");
  assert.match(query.sql, /summary_clearance_type sct INDEXED BY idx_sct_state_year/i);
  assert.match(query.sql, /sct\.state = 'TX'/i);
  assert.match(query.sql, /sct\.year BETWEEN 2021 AND 2025/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults are domestic violence?"
  );
  assert.ok(query, "national DV aggravated-assault share should be deterministic");
  assert.match(query.sql, /\bFROM summary_victim_circumstance\b/i);
  assert.match(query.sql, /\bFROM summary_victim_state_monthly\b/i);
  assert.match(query.sql, /\bucr_offense_code = '13A'/i);
  assert.match(query.sql, /\bcircumstance_code = '06'/i);
  assert.doesNotMatch(query.sql, /\bsummary_domestic_violence\b/i);
  assert.doesNotMatch(query.sql, /\bJOIN\s+summary_victim_circumstance\b/i);
  assert.match(query.sql, /\byear BETWEEN 2021 AND 2025\b/i);
  assert.match(query.explanation, /default last five complete calendar years/i);
  assert.equal(query.chartHint, "line");
  assert.equal(query.xAxis, "year");
  assert.equal(query.yAxis, "domestic_violence_share_pct");
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults over the past 5 years are domestic violence incidents?"
  );
  assert.ok(query, "relative-year DV aggravated-assault share should be deterministic");
  assert.match(query.sql, /\byear BETWEEN 2021 AND 2025\b/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults in Nebraska are domestic violence?"
  );
  assert.ok(query, "Nebraska state DV aggravated-assault share should be deterministic");
  assert.match(query.sql, /\bstate IN \('NE', 'NB'\)/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "what share of aggravated assaults are domestic violence over all available years?"
  );
  assert.ok(query, "explicit all-years DV aggravated-assault share should be deterministic");
  assert.doesNotMatch(query.sql, /\byear BETWEEN 2021 AND 2025\b/i);
  assert.match(query.explanation, /over all available years/i);
}

{
  const query = buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
    "domestic violence aggravated assault counts by race"
  );
  assert.equal(query, null, "non-share DV aggravated-assault questions should stay with normal routing");
}


{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "Omaha NE burglaries from 2000 to 2026"
  );
  assert.ok(query, "local Omaha burglary trend should be deterministic");
  assert.match(query.sql, /summary_city_monthly AS s INDEXED BY idx_scm_ori_year/i);
  assert.match(query.sql, /\bucr_offense_code = '220'/i);
  assert.match(query.sql, /\bstate IN \('NE','NB'\)/i);
  assert.match(query.sql, /\bcity = 'OMAHA'/i);
  assert.match(query.sql, /\byear BETWEEN 2000 AND 2026\b/i);
  assert.doesNotMatch(query.sql, /\bsummary_state_monthly\b/i);
  assert.equal(query.guardrail, "deterministic-nibrs-local-city-offense-count");
}

{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "Omaha NE burglaries per month from 2023 to 2026"
  );
  assert.ok(query, "monthly local Omaha burglary trend should be deterministic");
  assert.match(query.sql, /SELECT s\.year, s\.month,/i);
  assert.match(query.sql, /GROUP BY s\.year, s\.month/i);
}

{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "Omaha NE homicides from 2021 to 2025"
  );
  assert.ok(query, "person-count city trend should be deterministic");
  assert.match(query.sql, /summary_victim_city_monthly AS s INDEXED BY idx_svcm_ori/i);
}

{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "Omaha NE burglary rate from 2000 to 2026"
  );
  assert.equal(query, null, "local rates should stay with the normal model/validator path");
}

{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "shootings in Omaha NE from 2020 to 2026"
  );
  assert.equal(query, null, "shooting/firearm proxy questions should not use the simple count builder");
}
{
  const question = "show me murders for albuquerque police department and bernalillo county sheriff by year for 2020 to 2025";
  assert.equal(
    buildNibrsStructuredLocalTrendQuery(question),
    null,
    "sheriff comparisons must fall through until a unique ORI resolver is available"
  );
  assert.equal(
    buildNibrsStructuredLocalTrendQuery("compare murders for Jackson County Sheriff's Office in Missouri and Kansas City Police Department since 2020"),
    null,
    "same-name county sheriff wording must not use substring crosswalk resolution"
  );
  assert.equal(
    buildNibrsStructuredLocalTrendQuery("compare murders for Fairfax County Police Department and Arlington Police Department since 2020"),
    null,
    "county-police wording must not be treated as a city name"
  );
  assert.equal(
    buildNibrsStructuredLocalTrendQuery("compare murders for Jefferson County Sheriff's Office in Alabama and Birmingham Police Department since 2020"),
    null,
    "an accompanying state must remain disambiguation rather than creating an unsafe sheriff plan"
  );
}

{
  const query = buildNibrsStructuredLocalTrendQuery("compare murders in Houston and Dallas by year since 2020");
  assert.ok(query, "multi-city annual comparison should be deterministic");
  assert.match(query.sql, /city = 'HOUSTON'/i);
  assert.match(query.sql, /city = 'DALLAS'/i);
  assert.equal(query.sql.match(/ORDER BY primary_agency\.pop_group/gi)?.length, 2);
  assert.equal(query.yAxis, "houston_tx_murders,dallas_tx_murders");
}

{
  const currentYear = new Date().getFullYear();
  const query = buildNibrsStructuredLocalTrendQuery(
    `compare murders in Chicago and Milwaukee by year from 2018 to ${currentYear}`
  );
  assert.ok(query, "late-adopter count comparison should be deterministic");
  assert.match(query.sql, /requested_years\(year\)/i);
  assert.match(query.sql, /LEFT JOIN nibrs_agency_completeness AS c INDEXED BY idx_nac_ori_year/i);
  assert.match(query.explanation, /Historical counts are left blank unless the agency reported all 12 months/i);

  const db = new Database(":memory:");
  db.exec([
    "CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);",
    "CREATE TABLE summary_victim_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, victim_count INTEGER);",
    "CREATE TABLE summary_city_monthly (ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, offense_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_svcm_ori ON summary_victim_city_monthly(ori);",
    "CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    `INSERT INTO agencies VALUES ('ILCPD0000', ${currentYear}, 'IL', 'CHICAGO', 'City', 2700000, '1A'), ('WIMPD0000', ${currentYear}, 'WI', 'MILWAUKEE', 'City', 560000, '1B');`,
    `INSERT INTO summary_victim_city_monthly VALUES ('ILCPD0000', 2021, 1, '09A', 370), ('ILCPD0000', 2022, 1, '09A', 700), ('ILCPD0000', ${currentYear}, 1, '09A', 300), ('WIMPD0000', 2018, 1, '09A', 100), ('WIMPD0000', 2019, 1, '09A', 110), ('WIMPD0000', ${currentYear}, 1, '09A', 50);`,
    `INSERT INTO summary_city_monthly VALUES ('ILCPD0000', ${currentYear}, 1, '220', 1), ('WIMPD0000', ${currentYear}, 1, '220', 1);`,
    `INSERT INTO nibrs_agency_completeness VALUES ('ILCPD0000', 2021, 6), ('ILCPD0000', 2022, 12), ('WIMPD0000', 2018, 12), ('WIMPD0000', 2019, 12), ('WIMPD0000', 2020, 12), ('WIMPD0000', 2021, 12), ('WIMPD0000', 2022, 12), ('WIMPD0000', ${currentYear}, 7);`,
  ].join("\n"));
  const rows = db.prepare(query.sql).all() as Record<string, number | null>[];
  db.close();

  const byYear = new Map(rows.map((row) => [row.year, row]));
  assert.equal(byYear.get(2018)?.chicago_il_murders, null, "pre-adoption years must be null, not false zero");
  assert.equal(byYear.get(2021)?.chicago_il_murders, null, "historical partial years must be null");
  assert.equal(byYear.get(2022)?.chicago_il_murders, 700, "complete historical counts remain visible");
  assert.equal(byYear.get(2020)?.milwaukee_wi_murders, 0, "a complete reporting year with no matching offense is a real zero");
  assert.equal(byYear.get(currentYear)?.chicago_il_murders, 300, "current-year summary data remains visible when completeness has not been rebuilt");

  const rateQuery = buildNibrsStructuredLocalTrendQuery("compare murder rates in Houston and Dallas by year from 2024 to 2025");
  assert.ok(rateQuery, "city rate comparisons should remain deterministic");
  assert.match(rateQuery.sql, /months_reported END\) = 12/i);
}

for (const question of [
  "Murder rate for teenagers in Chicago since 2019",
  "Murder rate for elderly residents in Chicago since 2019",
  "Murder rate for the elderly in Chicago since 2019",
  "Women's robbery victimization rate in Chicago",
]) {
  assert.equal(
    buildNibrsStructuredLocalTrendQuery(question),
    null,
    "demographic rate language must never compile as an overall rate: " + question
  );
}

{
  assert.equal(
    buildNibrsStructuredLocalTrendQuery("compare murders per 10,000 in Houston and Dallas since 2020"),
    null,
    "non-100k rate scales must stay on the validated model path"
  );
  assert.equal(
    buildNibrsStructuredLocalTrendQuery("compare firearm murders in Houston and Dallas since 2020"),
    null,
    "weapon-qualified comparisons must stay on the validated model path"
  );
}

{
  // Local plan compilation is a pure function of the question: no database, no cache, no state.
  // The structural claim worth gating is that repeated compilation is deterministic. The elapsed
  // time is printed for information only -- the former "500 compilations under one second" gate
  // measured runner speed, not the planner, and is deliberately not a pass/fail condition.
  const question = "compare murders in Houston and Dallas by year since 2020";
  const first = buildNibrsStructuredLocalTrendQuery(question);
  assert.ok(first, "the comparison question must compile to a local plan");
  const started = performance.now();
  for (let i = 0; i < 500; i += 1) {
    assert.deepEqual(buildNibrsStructuredLocalTrendQuery(question), first, "local plan compilation must be deterministic");
  }
  const elapsed = performance.now() - started;
  console.log(`  500 local plan compilations took ${elapsed.toFixed(1)}ms (informational, not gated)`);
}
{
  const query = buildNibrsLocalCityOffenseCountQuery("Omaha NE motor vehicle thefts from 2020 to 2025");
  assert.ok(query, "nested motor-vehicle-theft wording should remain a single deterministic offense");
  assert.match(query.sql, /ucr_offense_code = '240'/i);
  assert.doesNotMatch(query.sql, /23A-23H/i);
}
{
  const countQuery = buildNibrsLocalDemographicQuery("murder victims by race in Houston since 2020");
  assert.ok(countQuery, "local victim race counts should be deterministic");
  assert.equal(countQuery.guardrail, "deterministic-nibrs-local-demographic-count");
  assert.match(countQuery.sql, /summary_victim_demographics AS d INDEXED BY idx_svd_new_ori_year/i);
  assert.equal(countQuery.xAxis, "race");
  assert.equal(countQuery.yAxis, "victims");

  const db = new Database(":memory:");
  db.exec([
    "CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);",
    "CREATE TABLE summary_victim_demographics (ori TEXT, year INTEGER, ucr_offense_code TEXT, race TEXT, sex TEXT, age_group TEXT, ethnicity TEXT, victim_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_svd_new_ori_year ON summary_victim_demographics(ori, year);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    "INSERT INTO agencies VALUES ('TXHPD0000', 2024, 'TX', 'HOUSTON', 'City', 2300000, '1A'), ('TXHPD0000', 2025, 'TX', 'HOUSTON', 'City', 2350000, '1A'), ('TX1012400', 2024, 'TX', 'HOUSTON', 'City', 12000, '5'), ('TX1012400', 2025, 'TX', 'HOUSTON', 'City', 12000, '5');",
    "INSERT INTO summary_victim_demographics VALUES ('TXHPD0000', 2024, '09A', 'W', 'M', '25-34', 'N', 10), ('TXHPD0000', 2024, '09A', 'B', 'M', '25-34', 'N', 20), ('TXHPD0000', 2024, '09A', 'U', 'U', 'Unknown', 'U', 5), ('TXHPD0000', 2025, '09A', 'W', 'F', '25-34', 'H', 15), ('TXHPD0000', 2025, '09A', 'B', 'F', '25-34', 'N', 25), ('TXHPD0000', 2025, '09A', '', '', '', '', 2), ('TX1012400', 2024, '09A', 'B', 'M', '25-34', 'N', 999);",
    "INSERT INTO nibrs_agency_completeness VALUES ('TXHPD0000', 2024, 12), ('TXHPD0000', 2025, 12), ('TX1012400', 2024, 12);",
  ].join("\n"));
  const countRows = db.prepare(countQuery.sql).all() as Record<string, number | string>[];
  assert.deepEqual(countRows, [
    { race: "Black or African American", victims: 45 },
    { race: "White", victims: 25 },
    { race: "Unknown", victims: 7 },
  ]);

  const shareQuery = buildNibrsLocalDemographicQuery("what share of murder victims are in each race in Houston since 2020");
  assert.ok(shareQuery, "local victim race shares should be deterministic");
  assert.equal(shareQuery.guardrail, "deterministic-nibrs-local-demographic-share");
  const shareRows = db.prepare(shareQuery.sql).all() as Record<string, number | string>[];
  assert.deepEqual(shareRows, [
    { race: "Black or African American", victims: 45, share_pct: 58.4 },
    { race: "White", victims: 25, share_pct: 32.5 },
    { race: "Unknown", victims: 7, share_pct: 9.1 },
  ]);

  const annualQuery = buildNibrsLocalDemographicQuery("murder victims by race by year in Houston from 2024 to 2025");
  assert.ok(annualQuery, "annual local victim race counts should be deterministic");
  assert.equal(annualQuery.xAxis, "chart_category");
  const annualRows = db.prepare(annualQuery.sql).all() as Record<string, number | string>[];
  assert.equal(annualRows.length, 6);
  assert.equal(annualRows[0].chart_category, "2024 - Black or African American");
  db.close();
}

{
  const offender = buildNibrsLocalDemographicQuery("robbery offenders by sex in Dallas from 2020 to 2025");
  assert.ok(offender);
  assert.match(offender.sql, /summary_offender_demographics AS d INDEXED BY idx_sod_new_ori_year/i);
  assert.match(offender.sql, /SUM\(d\.offender_count\) AS offenders/i);

  const arrestee = buildNibrsLocalDemographicQuery("murder arrestees by age in Dallas from 2020 to 2025");
  assert.ok(arrestee);
  assert.match(arrestee.sql, /summary_arrestee_demographics AS d INDEXED BY idx_sad_new_ori_year/i);
  assert.match(arrestee.sql, /d\.ucr_arrest_offense = '09A'/i);

  const ethnicity = buildNibrsLocalDemographicQuery("robbery victims by ethnicity in Dallas from 2020 to 2025");
  assert.ok(ethnicity);
  assert.match(ethnicity.sql, /Hispanic or Latino/i);

  assert.equal(buildNibrsLocalDemographicQuery("murders by race in Houston since 2020"), null,
    "ambiguous person role must stay on the validated model path");
  assert.equal(buildNibrsLocalDemographicQuery("murder victim rates by race in Houston since 2020"), null,
    "demographic population rates must remain unsupported");
  assert.equal(buildNibrsLocalDemographicQuery("firearm murder victims by race in Houston since 2020"), null,
    "weapon-qualified demographics require the existing specialized path");
  assert.equal(buildNibrsLocalDemographicQuery("murder victims by race and sex in Houston since 2020"), null,
    "multi-dimensional demographics stay on the validated model path initially");
}

{
  const whitePlainsRate = buildNibrsStructuredLocalTrendQuery(
    "What is the aggravated assault rate in White Plains, NY?"
  );
  assert.ok(whitePlainsRate, "single-city overall rates should default to five complete years");
  assert.equal(whitePlainsRate.guardrail, "deterministic-nibrs-structured-local-rate");
  assert.match(whitePlainsRate.sql, /city = 'WHITE PLAINS'/i);
  assert.match(whitePlainsRate.sql, /s\.ucr_offense_code = '13A'/i);

  const sexOffenseRate = buildNibrsStructuredLocalTrendQuery(
    "Sex offense rates in Denver since 2019"
  );
  assert.ok(sexOffenseRate, "sex-offense category rates must not be treated as demographic rates");
  assert.match(sexOffenseRate.sql, /s\.ucr_offense_code IN \('11A','11B','11C','11D','36A','36B'\)/i);
  assert.doesNotMatch(sexOffenseRate.explanation, /demographic population/i);
  assert.match(sexOffenseRate.explanation, /forcible and nonforcible.*statutory rape/i);
}

// --- Production 8388: clearances by type must include the uncleared remainder ---
// The model answered with a "Cleared by Arrest" row holding every measure and a
// "Not Cleared" row of literal zeros. Las Vegas 2025 is 82 = 62 + 11 + 9. These
// tests run the generated SQL rather than pattern-matching it, because the bug
// was a plausible-looking query that returned wrong numbers.
{
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT, covered_flag TEXT, agency_indicator TEXT);
    CREATE INDEX idx_agencies_state_city_year ON agencies(state, city, year);
    CREATE TABLE summary_clearance_detail (year INTEGER, state TEXT, ori TEXT, ucr_offense_code TEXT,
      cleared_by_arrest INTEGER, cleared_A INTEGER, cleared_B INTEGER, cleared_C INTEGER,
      cleared_D INTEGER, cleared_E INTEGER, total_offenses INTEGER);
    CREATE INDEX idx_scd_ori_year ON summary_clearance_detail(ori, year);
    CREATE INDEX idx_scd_state_year ON summary_clearance_detail(state, year);
    INSERT INTO agencies VALUES
      ('NV0020100', 2025, 'NV', 'LAS VEGAS', 'City', 1712136, '1A', 'N', 'E'),
      ('ILCPD0000', 2025, 'IL', 'CHICAGO', 'City', 2660000, '1A', 'N', 'E');
    INSERT INTO summary_clearance_detail VALUES
      (2025, 'NV', 'NV0020100', '09A', 62, 11, 0, 0, 0, 0, 82),
      (2025, 'IL', 'ILCPD0000', '09A', 62, 0, 0, 0, 0, 0, 321);
  `);

  const q = "las vegas murder clearances by type of clearance in 2025";
  const built = buildNibrsClearanceTypeBreakdownQuery(q, resolveNibrsPlaces(db, q));
  assert.ok(built, "8388's phrasing must reach a deterministic builder");
  assert.equal(built.guardrail, "deterministic-nibrs-clearance-type-breakdown");
  assert.match(built.sql, /scd\.ori IN \('NV0020100'\)/);

  const rows = db.prepare(built.sql).all() as { year: number; clearance_type: string; offenses: number }[];
  const byType = new Map(rows.map((r) => [r.clearance_type, r.offenses]));
  assert.equal(byType.get("Cleared by arrest"), 62);
  assert.equal(byType.get("Death of offender"), 11);
  assert.equal(byType.get("Not cleared"), 9, "the uncleared remainder is derived, not assumed to be zero");
  assert.equal(
    rows.reduce((sum, r) => sum + r.offenses, 0),
    82,
    "categories must sum to the reported total, or the chart lies about the whole"
  );
  assert.equal(rows[0].clearance_type, "Cleared by arrest", "categories come back in a stable order");
  assert.equal(rows[rows.length - 1].clearance_type, "Not cleared");

  // Phrasing variants that name "type" reach the same builder
  for (const variant of [
    "murder clearances by type in Las Vegas, NV in 2025",
    "murder clearance types in Las Vegas, NV in 2025",
    "murder clearances by type of clearance in Las Vegas, NV in 2025",
    "break down murder clearances by type in Las Vegas, NV in 2025",
    "clearances for murder by type in Las Vegas, NV in 2025",
  ]) {
    assert.ok(
      buildNibrsClearanceTypeBreakdownQuery(variant, resolveNibrsPlaces(db, variant)),
      `variant must build: ${variant}`
    );
  }

  // Requests that say "breakdown" without naming type are ambiguous -- by city,
  // by agency and by year are all common -- so this builder must not claim them.
  for (const other of [
    "breakdown of murder clearances in Las Vegas, NV in 2025",
    "murder clearances by city in Nevada in 2025",
    "murder clearances by year in Las Vegas, NV",
  ]) {
    assert.equal(
      buildNibrsClearanceTypeBreakdownQuery(other, resolveNibrsPlaces(db, other)),
      null,
      `must not claim an ambiguous or differently-grouped request: ${other}`
    );
  }

  // Same guards as the sibling builder: one place, and a resolved agency
  const multi = "murder clearances by type for Chicago, IL and Las Vegas, NV in 2025";
  assert.equal(
    buildNibrsClearanceTypeBreakdownQuery(multi, resolveNibrsPlaces(db, multi)),
    null,
    "multi-place requests go to the model path, not to a single-geography builder"
  );
  assert.equal(buildNibrsClearanceTypeBreakdownQuery(q, null), null, "no resolved agency means no deterministic query");
  db.close();
}

console.log("nibrs deterministic query tests passed");
