import assert from "node:assert/strict";
import { buildNibrsContinuousReporterQuery, buildNibrsCountywideDemographicQuery } from "../lib/nibrs-scope-deterministic";
import { validateAndSanitize } from "../lib/sql-safety";

const continuousDemo = buildNibrsContinuousReporterQuery(
  "show me violent crimes by offender age by year for 2017 to 2025 for continuously reporting agencies"
);
assert.ok(continuousDemo);
assert.match(continuousDemo.sql, /summary_offender_demographics/);
assert.match(continuousDemo.sql, /nibrs_consistent_reporters WHERE start_year = 2017 AND end_year = 2025/);
assert.match(continuousDemo.sql, /ucr_offense_code IN \('09A', '11A', '11B', '11C', '120', '13A'\)/);
assert.equal(validateAndSanitize(continuousDemo.sql).valid, true);

const continuousCount = buildNibrsContinuousReporterQuery(
  "murder trend from 2020 to 2024 among agencies that reported all 12 months every year"
);
assert.ok(continuousCount);
assert.match(continuousCount.sql, /summary_victim_city_monthly/);
assert.match(continuousCount.sql, /start_year = 2020 AND end_year = 2024/);

const countywide = buildNibrsCountywideDemographicQuery(
  "show me countywide violent crime incidents by offender age by year for 2021 to 2025 for Tarrant County, Texas"
);
assert.ok(countywide);
assert.match(countywide.sql, /summary_offender_demographics/);
assert.match(countywide.sql, /UPPER\(ac\.county_key\) = 'TARRANT'/);
assert.match(countywide.sql, /ac\.state = 'TX'/);
assert.match(countywide.sql, /a\.year BETWEEN 2021 AND 2025/);
assert.equal(validateAndSanitize(countywide.sql).valid, true);

assert.equal(buildNibrsCountywideDemographicQuery("violent crime in Tarrant County, Texas"), null);
assert.equal(buildNibrsContinuousReporterQuery("violent crime rate for continuously reporting agencies"), null);
console.log("nibrs scoped deterministic tests passed");
