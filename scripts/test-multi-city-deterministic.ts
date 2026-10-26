import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildMultiCityTrendPlan, multiCityChartTitle } from "../lib/multi-city-deterministic";

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

// Owner 2026-10-25 ("new york city vs chicago robbery rate per year only gives chicago"): Historical stores NYPD as
// "New York"; the name without "City" is used only when no city agency has the full name (Oklahoma City keeps its own).
{
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE historical_agency (ori TEXT, agency TEXT, state TEXT, type TEXT);
    CREATE TABLE historical_agency_crime (ori TEXT, year INTEGER, robbery INTEGER, murder INTEGER);
    CREATE TABLE historical_agency_population (ori TEXT, year INTEGER, population INTEGER);
    INSERT INTO historical_agency VALUES ('NY0303000','New York','ny','city'), ('ILCPD0000','Chicago','il','city'),
      ('OK0550000','Oklahoma City','ok','city'), ('OKFAKE000','Oklahoma','ok','city'), ('OK0720000','Tulsa','ok','city');
    INSERT INTO historical_agency_crime VALUES ('NY0303000',2024,1000,10), ('ILCPD0000',2024,500,5),
      ('OK0550000',2024,0,70), ('OKFAKE000',2024,0,9999), ('OK0720000',2024,0,60);
    INSERT INTO historical_agency_population VALUES ('NY0303000',2024,1000000), ('ILCPD0000',2024,500000),
      ('OK0550000',2024,700000), ('OKFAKE000',2024,1), ('OK0720000',2024,400000);`);
  const nyc = buildMultiCityTrendPlan("new york city vs chicago robbery rate per year", "historical");
  assert.ok(nyc, "the owner's question gets a deterministic plan");
  const row = db.prepare(nyc.sql).all()[0] as Record<string, unknown>;
  assert.equal(row.new_york_city, 100, `New York City is read from the "New York" agency (${JSON.stringify(row)})`);
  assert.equal(row.chicago, 100);
  assert.equal(multiCityChartTitle(nyc.chartConfig.title, [{ year: 1932 }, { year: 2025 }], "year"), "New York City, NY and Chicago, IL Robbery Rate, 1932 - 2025");
  const okc = db.prepare(eightThreeSevenEight.sql).all()[0] as Record<string, unknown>;
  assert.equal(okc.oklahoma_city, 70, "a full-name city agency is used, never the shortened name");
  // Codex PF-01: two city agencies under the shorter name are never summed; the column is left empty.
  db.exec(`INSERT INTO historical_agency VALUES ('NYDUP0000','New York','ny','city');
    INSERT INTO historical_agency_crime VALUES ('NYDUP0000',2024,7,1);
    INSERT INTO historical_agency_population VALUES ('NYDUP0000',2024,5);`);
  const dup = db.prepare(nyc.sql).all()[0] as Record<string, unknown>;
  assert.equal(dup.new_york_city, null, `an ambiguous shorter name gives no value (${JSON.stringify(dup)})`);
  assert.equal(dup.chicago, 100);
}

console.log("multi-city deterministic tests passed");
