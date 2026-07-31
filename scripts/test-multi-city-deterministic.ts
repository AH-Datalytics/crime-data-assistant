import assert from "node:assert/strict";
import { buildMultiCityTrendPlan } from "../lib/multi-city-deterministic";

const current = buildMultiCityTrendPlan(
  "Compare annual homicide rates in Austin TX, Boston MA, and Denver CO from 2022 to 2025",
  "current"
);
assert.ok(current);
assert.equal(current.chartConfig.xAxis, "year");
assert.deepEqual(current.chartConfig.yAxis, ["austin", "boston", "denver"]);
assert.match(current.sql, /agency_monthly/);
assert.match(current.sql, /Rate|ROUND\(100000\.0/i);
assert.match(current.explanation, /RTCI sample/);

const historical = buildMultiCityTrendPlan(
  "Compare robbery counts in Portland Oregon and Portland Maine from 2015 through 2024 by year",
  "historical"
);
assert.ok(historical);
assert.deepEqual(historical.columns, ["year", "portland_or", "portland_me"]);
assert.match(historical.sql, /historical_agency_crime/);
assert.match(historical.sql, /hac\.robbery/);

const monthly = buildMultiCityTrendPlan(
  "Show motor vehicle theft rates in Houston TX and Phoenix AZ from 2023 to 2025",
  "current"
);
assert.ok(monthly);
assert.equal(monthly.chartConfig.xAxis, "period");
assert.match(monthly.sql, /am\.year, am\.month/);

assert.equal(buildMultiCityTrendPlan("Homicide rates in Austin TX from 2022 to 2025", "current"), null);
assert.equal(buildMultiCityTrendPlan("Homicide rates in Austin TX and Boston MA", "current"), null);
assert.equal(buildMultiCityTrendPlan("Top cities for homicide rates from 2022 to 2025", "current"), null);
assert.equal(buildMultiCityTrendPlan("Homicide by offender age in Austin TX and Boston MA from 2022 to 2025", "current"), null);

console.log("multi-city deterministic tests passed");
