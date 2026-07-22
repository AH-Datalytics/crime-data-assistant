import assert from "node:assert/strict";
import { historicalYearAvailability } from "../lib/year-availability";
import { HISTORICAL, NIBRS, RTCI, SHR } from "../lib/dynamic-facts";
import { partialCoverageRetryPrompt, sourceYearOverlap } from "../lib/source-year-overlap";

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


{
  const question = `murders in Omaha from 1900 to ${HISTORICAL.crimeMaxYear}`;
  const overlap = sourceYearOverlap("historical", question);
  assert.ok(overlap?.hasOverlap, "Historical should detect overlap for pre-coverage-to-available crime ranges");
  assert.equal(overlap.partial, true);
  assert.equal(overlap.overlapStartYear, HISTORICAL.crimeMinYear);
  assert.equal(overlap.overlapEndYear, HISTORICAL.crimeMaxYear);
  assert.ok(
    partialCoverageRetryPrompt("historical", question, `Historical annual crime data starts in ${HISTORICAL.crimeMinYear}.`),
    "Historical partial-coverage refusals should get an overlap retry"
  );
}

{
  const question = `murders in Detroit from 2010 to ${RTCI.maxYear}`;
  const overlap = sourceYearOverlap("current", question);
  assert.ok(overlap?.hasOverlap, "Current Trends should detect overlap for pre-coverage-to-current ranges");
  assert.equal(overlap.partial, true);
  assert.equal(overlap.overlapStartYear, RTCI.minYear);
  assert.equal(overlap.overlapEndYear, RTCI.maxYear);
  assert.ok(
    partialCoverageRetryPrompt("current", question, `Current Trends data is available from ${RTCI.minYear}.`),
    "Current Trends partial-coverage refusals should get an overlap retry"
  );
}

{
  const question = `fatal shootings in Houston from 1950 to ${SHR.maxYear}`;
  const overlap = sourceYearOverlap("shr", question);
  assert.ok(overlap?.hasOverlap, "SHR should detect overlap for pre-coverage-to-available ranges");
  assert.equal(overlap.partial, true);
  assert.equal(overlap.overlapStartYear, SHR.minYear);
  assert.equal(overlap.overlapEndYear, SHR.maxYear);
  assert.ok(
    partialCoverageRetryPrompt("shr", question, `SHR data begins in ${SHR.minYear}.`),
    "SHR partial-coverage refusals should get an overlap retry"
  );
}

{
  const question = "fatal shootings in Houston from 1950 to present";
  const overlap = sourceYearOverlap("shr", question);
  assert.ok(overlap?.hasOverlap, "Open-ended to-present ranges should detect source overlap");
  assert.equal(overlap.partial, true);
  assert.equal(overlap.overlapStartYear, SHR.minYear);
  assert.equal(overlap.overlapEndYear, SHR.maxYear);
}
{
  const question = `fatal shootings in Houston from 1950 to ${SHR.maxYear + 1}`;
  const overlap = sourceYearOverlap("shr", question);
  assert.ok(overlap?.hasOverlap, "SHR should detect overlap when both ends exceed coverage");
  assert.equal(overlap.partial, true);
  assert.equal(overlap.overlapStartYear, SHR.minYear);
  assert.equal(overlap.overlapEndYear, SHR.maxYear);
}
{
  const question = `fatal shootings in Houston from ${SHR.minYear - 20} to ${SHR.minYear - 1}`;
  const overlap = sourceYearOverlap("shr", question);
  assert.equal(overlap?.hasOverlap, false, "No-overlap SHR shooting ranges should not be retried");
  assert.equal(
    partialCoverageRetryPrompt("shr", question, `SHR data starts in ${SHR.minYear}.`),
    null,
    "No-overlap SHR shooting ranges should remain text-only refusals"
  );
}
{
  const question = "anti-Asian hate crimes in California from 1980 to 1995";
  const overlap = sourceYearOverlap("hate_crime", question);
  assert.ok(overlap?.hasOverlap, "Hate Crime should detect overlap for pre-coverage ranges");
  assert.equal(overlap.partial, true);
  assert.equal(overlap.overlapStartYear, 1991);
  assert.equal(overlap.overlapEndYear, 1995);
  assert.ok(
    partialCoverageRetryPrompt("hate_crime", question, "Hate crime data starts in 1991."),
    "Hate Crime partial-coverage refusals should get an overlap retry"
  );
}

{
  const question = `NIBRS burglaries from 1900 to ${NIBRS.minYear - 1}`;
  const overlap = sourceYearOverlap("nibrs", question);
  assert.equal(overlap?.hasOverlap, false, "No-overlap NIBRS ranges should not be retried");
  assert.equal(
    partialCoverageRetryPrompt("nibrs", question, `NIBRS data starts in ${NIBRS.minYear}.`),
    null,
    "No-overlap NIBRS ranges should remain text-only refusals"
  );
}

console.log("year availability tests passed");
