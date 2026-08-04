import assert from "node:assert/strict";
import { implausiblePopulationDenominator, populationDenominatorCeiling } from "../lib/rate-denominator-safety";

const samplePopulation = 115_499_393;
assert.equal(populationDenominatorCeiling(samplePopulation), 230_998_786);
assert.equal(implausiblePopulationDenominator([{ population: 1_385_992_716 }], null, samplePopulation), true);
assert.equal(implausiblePopulationDenominator([{ population: 122_283_158 }], 122_283_158, 122_283_158), false);
assert.equal(implausiblePopulationDenominator([], null, samplePopulation), false);

console.log("rate denominator backstop tests passed");