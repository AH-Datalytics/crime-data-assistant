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
assert.match(current.explanation, /homicide/i);

const murderWording = buildMultiCityTrendPlan(
  "Murders per year from 2022 to 2025 in Houston TX, Dallas TX, Plano TX, Atlanta GA, Memphis TN, New Orleans LA, Birmingham AL, Baton Rouge LA and Mobile AL",
  "current",
);
assert.ok(murderWording);
assert.match(murderWording.title, /^Murder Counts/);
assert.match(murderWording.explanation, /Current murder reported count/);
assert.doesNotMatch(murderWording.explanation, /homicide/i);

const historical = buildMultiCityTrendPlan(
  "Compare robbery counts in Portland Oregon and Portland Maine from 2015 through 2024 by year",
  "historical"
);
assert.ok(historical);
assert.deepEqual(historical.columns, ["year", "portland_or", "portland_me"]);
assert.match(historical.sql, /historical_agency_crime/);
assert.match(historical.sql, /hac\.robbery/);

const historicalAllYears = buildMultiCityTrendPlan(
  "What are the homicide rates in Baltimore city Boston Chicago Cleveland Detroit Houston Phoenix Pittsburgh Washington DC Philadelphia",
  "historical"
);
assert.ok(historicalAllYears);
assert.match(historicalAllYears.sql, /WHERE 1 = 1/);
assert.match(historicalAllYears.title, /All Available Years/);

const currentProductionPhrasing = buildMultiCityTrendPlan(
  "What are the homicide rates in Baltimore City Boston Chicago Cleveland Detroit Houston Phoenix Pittsburgh Washington DC Philadelphia from. 2022 to 2025?",
  "current"
);
assert.ok(currentProductionPhrasing);
assert.equal(currentProductionPhrasing.chartConfig.xAxis, "period");

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

// --- Production 8378: the question that never reached this builder ---
// It was misclassified as a follow-up of 8377 (a different tab), so the route
// skipped the deterministic plan and the model's SQL failed schema validation.
const eightThreeSevenEight = buildMultiCityTrendPlan(
  "compare tulsa and oklahoma city homicides over time",
  "historical"
);
assert.ok(eightThreeSevenEight, "8378 must qualify for a deterministic historical plan");
assert.deepEqual(eightThreeSevenEight.columns, ["year", "tulsa", "oklahoma_city"]);
assert.match(eightThreeSevenEight.sql, /WHERE 1 = 1/);

// A non-reporting agency-year stays NULL rather than becoming a false zero
assert.doesNotMatch(eightThreeSevenEight.sql, /ELSE 0/);
assert.doesNotMatch(historical.sql, /ELSE 0/);

console.log("multi-city deterministic tests passed");
