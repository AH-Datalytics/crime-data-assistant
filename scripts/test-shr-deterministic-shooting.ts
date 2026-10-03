import assert from "node:assert/strict";
import { SHR } from "../lib/dynamic-facts";
import { shootingCityIntents, shootingMeasure, shootingMonthWindow, shootingYearIntent } from "../lib/shr-deterministic-shooting";
import { asksSimpleFirearmHomicideTrend } from "../lib/shr-firearm-trend-intent";
import { sourceYearOverlap } from "../lib/source-year-overlap";

{
  const cities = shootingCityIntents(`fatal shootings in Houston from 1950 to ${SHR.maxYear + 1}`);
  assert.deepEqual(cities, [{ agency: "Houston", display: "Houston", state: "TX" }]);
  assert.equal(cities.some((city) => city.state === "GA"), false, "Houston city intent must not include Houston, GA");
}

{
  const overlap = sourceYearOverlap("shr", `fatal shootings in Houston from 1950 to ${SHR.maxYear + 1}`);
  assert.ok(overlap?.hasOverlap, "SHR should keep the available overlap when both requested ends exceed coverage");
  assert.equal(overlap.partial, true);
  assert.equal(overlap.overlapStartYear, SHR.minYear);
  assert.equal(overlap.overlapEndYear, SHR.maxYear);
}

{
  const overlap = sourceYearOverlap("shr", `fatal shootings in Houston from ${SHR.minYear - 20} to ${SHR.minYear - 1}`);
  assert.equal(overlap?.hasOverlap, false, "SHR should treat fully pre-coverage shooting ranges as no-overlap");
}

{
  const year = shootingYearIntent("fatal shootings in Houston from 1950 to 2026");
  assert.equal(year.clause, "i.year BETWEEN 1950 AND 2026");
  assert.equal(year.label, "1950-2026");
}

{
  const cities = shootingCityIntents("fatal shootings in Kansas City");
  assert.deepEqual(cities, [], "ambiguous Kansas City must not be resolved by the shared parser");
}

{
  const cities = shootingCityIntents("fatal shootings in Los Angeles since 2020");
  assert.deepEqual(cities, [{ agency: "Los Angeles", agencyLike: undefined, display: "Los Angeles", state: "CA" }]);
}

{
  const question = "firearm murders in Houston since 2010";
  assert.equal(
    asksSimpleFirearmHomicideTrend(question) && shootingCityIntents(question).length > 0,
    true,
    "simple city firearm-homicide trends should enter the deterministic shooting route"
  );
}

// GC-108: a month window kept within every requested year.
{
  const w = shootingMonthWindow("Birmingham, Alabama, fatal shootings through July of each year");
  assert.deepEqual(w, { kind: "supported", startMonth: 1, endMonth: 7, label: "January–July", explanation: "January through July of each year" });
  const r = shootingMonthWindow("fatal shootings from March through July of each year in Chicago");
  assert.equal(r.kind === "supported" && r.startMonth === 3 && r.endMonth === 7, true, "a March-July range keeps months 3-7");
  assert.equal(shootingMonthWindow("fatal shootings in Chicago Jan-Jul since 2015").kind, "supported", "abbreviated month range");
  assert.equal(shootingMonthWindow("fatal shootings in Houston from 2015 through 2020").kind, "none", "a YEAR range is not a month window");
  assert.equal(shootingMonthWindow("fatal shootings in Houston since 2010").kind, "none");
  assert.equal(shootingMonthWindow("Birmingham fatal shootings through July 2024").kind, "unsupported", "a month tied to one year is a different request");
  assert.equal(shootingMonthWindow("fatal shootings from November through February").kind, "unsupported", "a window wrapping the year end is not built");
}

// GC-109: the measure the deterministic shooting path delivers.
{
  assert.deepEqual(shootingMeasure("median age of fatal shooting victims per year"), { kind: "median_age" });
  assert.deepEqual(shootingMeasure("fatal shootings in Chicago since 2015"), { kind: "count" });
  assert.equal(shootingMeasure("average age of fatal shooting victims per year").kind, "unsupported", "only the median is built");
  assert.equal(shootingMeasure("median age of shooters in fatal shootings").kind, "unsupported", "offender age is not victim age");
  assert.deepEqual(shootingMeasure("police fatal shootings percentage by year"), { kind: "count" }, "'percentage' does not mention an age");
}

console.log("SHR deterministic shooting tests passed");
