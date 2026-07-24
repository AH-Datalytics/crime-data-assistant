import assert from "node:assert/strict";
import { SHR } from "../lib/dynamic-facts";
import { shootingCityIntents, shootingYearIntent } from "../lib/shr-deterministic-shooting";
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

console.log("SHR deterministic shooting tests passed");
