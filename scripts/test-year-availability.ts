import assert from "node:assert/strict";
import { historicalYearAvailability } from "../lib/year-availability";
import { HISTORICAL } from "../lib/dynamic-facts";

{
  const result = historicalYearAvailability("what is seattle's 2026 per capita murder rate");
  assert.ok(result, "2026 should be unavailable in Historical when Historical ends earlier");
  assert.equal(result.maxYear, HISTORICAL.crimeMaxYear);
  assert.match(result.explanation, new RegExp(`through ${HISTORICAL.crimeMaxYear}`));
  assert.match(result.explanation, /Current Trends/);
}

{
  const result = historicalYearAvailability(`what is seattle's ${HISTORICAL.crimeMaxYear} per capita murder rate`);
  assert.equal(result, null, "latest Historical crime year should remain queryable");
}

{
  const result = historicalYearAvailability(`homicide rate graph from 1960 to ${HISTORICAL.crimeMaxYear + 1}`);
  assert.equal(result, null, "Historical trend queries spanning available years should return the available range");
}

{
  const result = historicalYearAvailability("how many officers did Chicago have in 2026");
  assert.ok(result, "future staffing year should be unavailable in Historical");
  assert.equal(result.maxYear, HISTORICAL.staffingMaxYear);
  assert.doesNotMatch(result.explanation, /Current Trends/, "Current Trends does not have staffing");
}

console.log("year availability tests passed");
