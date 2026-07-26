import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import {
  buildNibrsClearanceMethodQuery,
  buildNibrsDomesticViolenceAggravatedAssaultShareQuery,
  buildNibrsLocalCityOffenseCountQuery,
  buildNibrsLocalDemographicQuery,
  buildNibrsStructuredLocalTrendQuery,
} from "../lib/nibrs-deterministic-queries.js";

{
  const query = buildNibrsClearanceMethodQuery(
    "How many robberies in Chicago were cleared by arrest versus exceptional means from 2021 to 2025?"
  );
  assert.ok(query, "city clearance-method comparison should be deterministic");
  assert.match(query.sql, /summary_clearance_type sct INDEXED BY idx_sct_ori_year/i);
  assert.match(query.sql, /sct\.ucr_offense_code = '120'/i);
  assert.match(query.sql, /city = 'CHICAGO'/i);
  assert.match(query.sql, /sct\.year BETWEEN 2021 AND 2025/i);
  assert.equal(query.guardrail, "deterministic-nibrs-clearance-method");
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
  assert.match(query.sql, /\bFROM summary_city_monthly INDEXED BY idx_scm_ori_year\b/i);
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
  assert.match(query.sql, /SELECT year, month,/i);
  assert.match(query.sql, /GROUP BY year, month/i);
}

{
  const query = buildNibrsLocalCityOffenseCountQuery(
    "Omaha NE homicides from 2021 to 2025"
  );
  assert.ok(query, "person-count city trend should be deterministic");
  assert.match(query.sql, /\bFROM summary_victim_city_monthly INDEXED BY idx_svcm_ori\b/i);
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
  const question = "show me murders, robberies, and aggravated assaults for albuquerque police department and bernalillo county sheriff by year for 2020 to 2025";
  const query = buildNibrsStructuredLocalTrendQuery(question);
  assert.ok(query, "multi-agency multi-offense trend should be deterministic");
  assert.equal(query.guardrail, "deterministic-nibrs-structured-local-trend");
  assert.match(query.sql, /city = 'ALBUQUERQUE'/i);
  assert.match(query.sql, /agency_name\) LIKE '%BERNALILLO%'/i);
  assert.match(query.sql, /agency_name\) LIKE '%SHERIFF%' OR UPPER\(county_name\) LIKE '%BERNALILLO%'/i);
  assert.match(query.sql, /FROM target_places AS tp\s+CROSS JOIN summary_victim_city_monthly AS s INDEXED BY idx_svcm_ori/i);
  assert.match(query.sql, /FROM target_places AS tp\s+CROSS JOIN summary_city_monthly AS s INDEXED BY idx_scm_ori_year/i);
  assert.equal(query.sql.match(/FROM target_places AS tp\s+CROSS JOIN summary_/gi)?.length, 3,
    "every offense branch must keep target ORIs on the outer side of the indexed join");
  assert.match(query.sql, /s\.ucr_offense_code = '09A'/i);
  assert.match(query.sql, /s\.ucr_offense_code = '120'/i);
  assert.match(query.sql, /s\.ucr_offense_code = '13A'/i);
  assert.match(query.sql, /s\.year BETWEEN 2020 AND 2025/i);
  assert.match(query.yAxis, /albuquerque_police_department_murders/);
  assert.match(query.yAxis, /bernalillo_county_sheriff_robberies/);

  const db = new Database(":memory:");
  db.exec([
    "CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);",
    "CREATE TABLE agency_county_crosswalk (ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_name TEXT);",
    "CREATE TABLE summary_victim_city_monthly (ori TEXT, year INTEGER, ucr_offense_code TEXT, victim_count INTEGER);",
    "CREATE TABLE summary_city_monthly (ori TEXT, year INTEGER, ucr_offense_code TEXT, offense_count INTEGER);",
    "CREATE INDEX idx_svcm_ori ON summary_victim_city_monthly(ori);",
    "CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year);",
    "INSERT INTO agencies VALUES ('NM0010100', 2025, 'NM', 'ALBUQUERQUE', 'City', 560000, '1B');",
    "INSERT INTO agencies VALUES ('NM0010200', 2025, 'NM', 'ALBUQUERQUE', 'City', 15000, '7');",
    "INSERT INTO agency_county_crosswalk VALUES ('NM00100', 'NM0010000', 'Bernalillo', 'NM', 'Bernalillo');",
    "INSERT INTO summary_victim_city_monthly VALUES ('NM0010100', 2024, '09A', 10), ('NM0010100', 2024, '13A', 100), ('NM0010200', 2024, '09A', 999), ('NM0010200', 2024, '13A', 999), ('NM0010000', 2024, '09A', 3), ('NM0010000', 2024, '13A', 30);",
    "INSERT INTO summary_city_monthly VALUES ('NM0010100', 2024, '120', 20), ('NM0010200', 2024, '120', 999), ('NM0010000', 2024, '120', 7);",
  ].join("\n"));
  const rows = db.prepare(query.sql).all() as Record<string, number>[];
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].albuquerque_police_department_murders, 10);
  assert.equal(rows[0].albuquerque_police_department_robberies, 20);
  assert.equal(rows[0].albuquerque_police_department_aggravated_assaults, 100);
  assert.equal(rows[0].bernalillo_county_sheriff_murders, 3);
  assert.equal(rows[0].bernalillo_county_sheriff_robberies, 7);
  assert.equal(rows[0].bernalillo_county_sheriff_aggravated_assaults, 30);
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
  const question = "compare murder rates for albuquerque police department and bernalillo county sheriff by year for 2024 to 2025";
  const query = buildNibrsStructuredLocalTrendQuery(question);
  assert.ok(query, "local annual rate comparison should be deterministic");
  assert.equal(query.guardrail, "deterministic-nibrs-structured-local-rate");
  assert.equal(query.yAxis, "albuquerque_police_department_murders_rate_per_100k,bernalillo_county_sheriff_murders_rate_per_100k");
  assert.match(query.sql, /LEFT JOIN nibrs_agency_completeness AS c INDEXED BY idx_nac_ori_year/i);
  assert.match(query.sql, /months_reported END\) = 12/i);

  const db = new Database(":memory:");
  db.exec([
    "CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT);",
    "CREATE TABLE agency_county_crosswalk (ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_name TEXT);",
    "CREATE TABLE summary_victim_city_monthly (ori TEXT, year INTEGER, ucr_offense_code TEXT, victim_count INTEGER);",
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INTEGER, months_reported INTEGER);",
    "CREATE INDEX idx_svcm_ori ON summary_victim_city_monthly(ori);",
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);",
    "INSERT INTO agencies VALUES ('NM0010100', 2024, 'NM', 'ALBUQUERQUE', 'City', 500000, '1B'), ('NM0010100', 2025, 'NM', 'ALBUQUERQUE', 'City', 500000, '1B'), ('NM0010200', 2024, 'NM', 'ALBUQUERQUE', 'City', 15000, '7'), ('NM0010200', 2025, 'NM', 'ALBUQUERQUE', 'City', 15000, '7'), ('NM0010000', 2024, 'NM', 'ALBUQUERQUE', 'County', 100000, '9A'), ('NM0010000', 2025, 'NM', 'ALBUQUERQUE', 'County', 100000, '9A');",
    "INSERT INTO agency_county_crosswalk VALUES ('NM00100', 'NM0010000', 'Bernalillo', 'NM', 'Bernalillo');",
    "INSERT INTO summary_victim_city_monthly VALUES ('NM0010100', 2024, '09A', 10), ('NM0010100', 2025, '09A', 5), ('NM0010200', 2024, '09A', 999), ('NM0010200', 2025, '09A', 999), ('NM0010000', 2024, '09A', 3), ('NM0010000', 2025, '09A', 4);",
    "INSERT INTO nibrs_agency_completeness VALUES ('NM0010100', 2024, 12), ('NM0010100', 2025, 12), ('NM0010000', 2024, 12), ('NM0010000', 2025, 6);",
  ].join("\n"));
  const rows = db.prepare(query.sql).all() as Record<string, number | null>[];
  db.close();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].albuquerque_police_department_murders_rate_per_100k, 2);
  assert.equal(rows[0].bernalillo_county_sheriff_murders_rate_per_100k, 3);
  assert.equal(rows[1].albuquerque_police_department_murders_rate_per_100k, 1);
  assert.equal(rows[1].bernalillo_county_sheriff_murders_rate_per_100k, null);
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
  const question = "compare murders in Houston and Dallas by year since 2020";
  const started = performance.now();
  for (let i = 0; i < 500; i += 1) buildNibrsStructuredLocalTrendQuery(question);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, "500 local plan compilations should stay under one second; took " + elapsed.toFixed(1) + "ms");
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
    "CREATE INDEX idx_svd_new_ori_year ON summary_victim_demographics(ori, year);",
    "INSERT INTO agencies VALUES ('TXHPD0000', 2024, 'TX', 'HOUSTON', 'City', 2300000, '1A'), ('TXHPD0000', 2025, 'TX', 'HOUSTON', 'City', 2350000, '1A'), ('TX1012400', 2024, 'TX', 'HOUSTON', 'City', 12000, '5'), ('TX1012400', 2025, 'TX', 'HOUSTON', 'City', 12000, '5');",
    "INSERT INTO summary_victim_demographics VALUES ('TXHPD0000', 2024, '09A', 'W', 'M', '25-34', 'N', 10), ('TXHPD0000', 2024, '09A', 'B', 'M', '25-34', 'N', 20), ('TXHPD0000', 2024, '09A', 'U', 'U', 'Unknown', 'U', 5), ('TXHPD0000', 2025, '09A', 'W', 'F', '25-34', 'H', 15), ('TXHPD0000', 2025, '09A', 'B', 'F', '25-34', 'N', 25), ('TXHPD0000', 2025, '09A', '', '', '', '', 2), ('TX1012400', 2024, '09A', 'B', 'M', '25-34', 'N', 999);",
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
console.log("nibrs deterministic query tests passed");
