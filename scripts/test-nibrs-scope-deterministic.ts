import assert from "node:assert/strict";
import { buildNibrsContinuousReporterQuery, buildNibrsCountywideDemographicQuery } from "../lib/nibrs-scope-deterministic";
import { validateAndSanitize } from "../lib/sql-safety";
import { accountNibrsRequest, nibrsRecognitionRefusal } from "../lib/nibrs-request-accounting";
import { nibrsUnboundParts } from "../lib/nibrs-legacy-binding";

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

// Bounded fix (2026-10-23): "nationwide" and a named state are scopes this path filters; it declined them before because
// both carry a name. Each built answer must also bind every part of the request.
const owns = (q: string) => {
  const built = buildNibrsContinuousReporterQuery(q);
  assert.ok(built, q);
  assert.deepEqual(nibrsUnboundParts(accountNibrsRequest(q), built.applied!).map((p) => p.concept), [], q);
  assert.equal(validateAndSanitize(built.sql).valid, true, q);
  return built;
};
const nationwide = owns("show me nationwide violent crime by offender age by year for 2018 to 2025 for consistent reporters");
assert.doesNotMatch(nationwide.sql, /d\.state =/);
const pennsylvania = owns("show me violent crime in pennsylvania by offender age for 2015 to 2025 for consistent reporters");
assert.match(pennsylvania.sql, /d\.state = 'PA'/);
assert.match(pennsylvania.explanation, / in Pennsylvania /);
owns("show me nationwide violent crimes by victim age for consistent reporters for 2017 to 2025");

// "involving a gun/firearm" on the demographic tables: weapon_category, as the typed answers read it.
const gun = owns("show me nationwide violent crimes involving use of a gun by offender age by year for consistent reporters for 2018 to 2025");
assert.match(gun.sql, /summary_offender_demographics/);
assert.match(gun.sql, /d\.weapon_category = 'Firearm'/);
assert.match(gun.explanation, /offenders involving a firearm by age group/);
const msArrests = owns("show me violent crimes involving use of a firearm in mississippi by age of arrestee from 2021 to 2025 for continuously reporting agencies");
assert.match(msArrests.sql, /summary_arrestee_demographics[\s\S]*d\.state = 'MS'[\s\S]*d\.weapon_category = 'Firearm'/);
const victimGun = owns("show me firearm murder victims by age for 2018 to 2024 for consistent reporters");
assert.match(victimGun.explanation, /first-listed weapon/);

// Controls: still declined or left unbound, never answered without a part.
assert.equal(buildNibrsContinuousReporterQuery("violent crime in Austin, Texas by offender age for 2018 to 2025 for consistent reporters"), null);
assert.equal(buildNibrsContinuousReporterQuery("show me nationwide violent crime by offender age by month for 2018 to 2025 for consistent reporters"), null);
const plainGun = buildNibrsContinuousReporterQuery("show me violent crime involving use of a firearm by year for 2017 to 2025 for consistent reporters");
assert.ok(plainGun);
assert.doesNotMatch(plainGun.sql, /weapon_category/);
assert.deepEqual(nibrsUnboundParts(accountNibrsRequest("show me violent crime involving use of a firearm by year for 2017 to 2025 for consistent reporters"), plainGun.applied!).map((p) => p.value), ["weapon:firearm"]);
// The SHR-only linking words never reach NIBRS: the stolen firearm is not a weapon used (logged L8998).
assert.ok(nibrsRecognitionRefusal(accountNibrsRequest("share of auto thefts where a firearm was stolen per year")));
const knife = buildNibrsContinuousReporterQuery("show me violent crime involving a knife by offender age for 2018 to 2025 for consistent reporters");
assert.ok(!knife || !/weapon_category = 'Firearm'/.test(knife.sql));
console.log("nibrs scoped deterministic tests passed");
