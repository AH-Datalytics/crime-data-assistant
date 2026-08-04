import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { extractQueryContext } from "../lib/query-context";
import { runGuardrails } from "../lib/guardrails";

const badAnnual = `WITH annual AS (
  SELECT am.year, SUM(am.count) AS total_crimes, SUM(ap.population) AS total_population
  FROM agency_monthly am JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year
  WHERE am.offense IN ('Murder', 'Rape', 'Robbery', 'Aggravated Assault') GROUP BY am.year
) SELECT year, ROUND(total_crimes * 100000.0 / total_population, 1) AS rate_per_100k FROM annual`;
const badResult = runGuardrails(extractQueryContext(badAnnual, "violent crime rate since 2024", "current"));
assert.ok(badResult.fired.includes("rate-population-fanout"), "annual multi-offense fan-out must fire");

const correctMonthly = `SELECT am.year, am.month, ROUND(SUM(am.count) * 100000.0 / SUM(ap.population), 1) AS rate_per_100k
FROM agency_monthly am JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year
WHERE am.offense = 'Murder' GROUP BY am.year, am.month`;
const correctResult = runGuardrails(extractQueryContext(correctMonthly, "monthly murder rate", "current"));
assert.equal(correctResult.fired.includes("rate-population-fanout"), false, "monthly single-offense rate must not fire");

const deduped = `SELECT SUM(population) AS pop FROM (SELECT DISTINCT am.ori, p.population FROM agency_monthly am JOIN agency_population p ON p.ori = am.ori AND p.year = 2026 WHERE am.year = 2026 AND am.month = 5)`;
const dedupedResult = runGuardrails(extractQueryContext(deduped, "population", "current"));
assert.equal(dedupedResult.fired.includes("rate-population-fanout"), false, "deduped population query must not fire");

const maxCase = `SELECT ROUND(SUM(am.count) * 100000.0 / MAX(CASE WHEN am.agency = 'Baltimore' THEN ap.population END), 1) AS baltimore FROM agency_monthly am JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year WHERE am.offense = 'Murder' GROUP BY am.year`;
const maxCaseResult = runGuardrails(extractQueryContext(maxCase, "Baltimore murder rate", "current"));
assert.equal(maxCaseResult.fired.includes("rate-population-fanout"), false, "MAX CASE population idiom must not fire");

const noDirectJoin = `WITH monthly_data AS (
  SELECT nm.year, nm.month, nm.count,
    (SELECT SUM(ap.population) FROM agency_population ap JOIN agencies a ON a.ori = ap.ori WHERE ap.year = nm.year) AS national_pop,
    (SELECT SUM(am.count) FROM agency_monthly am WHERE am.agency = 'Baltimore' AND am.year = nm.year AND am.month = nm.month) AS baltimore_count
  FROM national_monthly nm WHERE nm.offense IN ('Murder', 'Rape', 'Robbery', 'Aggravated Assault')
) SELECT year, month, national_pop FROM monthly_data`;
const noDirectJoinResult = runGuardrails(extractQueryContext(noDirectJoin, "Baltimore rate over time", "current"));
// Production 2305: the population is an independent scalar subquery, not a
// direct agency_monthly x agency_population fan-out.
assert.equal(noDirectJoinResult.fired.includes("rate-population-fanout"), false, "independent population subquery must not fire");

const fixture = new Database(":memory:");
fixture.exec("CREATE TABLE agency_monthly (ori TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER); CREATE TABLE agency_population (ori TEXT, year INTEGER, population INTEGER);");
fixture.exec("INSERT INTO agency_monthly VALUES ('A',2024,1,'Murder',2),('A',2024,2,'Murder',3),('B',2024,1,'Murder',4),('B',2024,2,'Murder',5); INSERT INTO agency_population VALUES ('A',2024,100),('B',2024,200);");
const buggy = fixture.prepare("SELECT SUM(ap.population) AS pop FROM agency_monthly am JOIN agency_population ap ON ap.ori=am.ori AND ap.year=am.year WHERE am.offense='Murder' AND am.year=2024").get() as { pop: number };
const dedupedPop = fixture.prepare("SELECT SUM(population) AS pop FROM (SELECT DISTINCT am.ori, ap.population FROM agency_monthly am JOIN agency_population ap ON ap.ori=am.ori AND ap.year=am.year WHERE am.offense='Murder' AND am.year=2024)").get() as { pop: number };
assert.equal(dedupedPop.pop, 300, "deduped denominator sums one population per agency");
assert.equal(buggy.pop, 600, "buggy denominator reflects two months of fan-out");
fixture.close();

console.log("rate fan-out tests passed");