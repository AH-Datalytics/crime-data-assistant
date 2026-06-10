import assert from "node:assert/strict";
import {
  buildStatePopulationRows,
  stateNameToAbbr,
} from "../lib/state-population";

assert.equal(stateNameToAbbr("Pennsylvania"), "PA");
assert.equal(stateNameToAbbr(" District   of Columbia "), "DC");
assert.equal(stateNameToAbbr("United States"), "US");
assert.equal(stateNameToAbbr("Atlantis"), null);

const rows = buildStatePopulationRows([
  { state: "Pennsylvania", year: 2024, population: 12951275 },
  { state: "United States", year: 2024, population: 340110988 },
  { state: "Unknown", year: 2024, population: 10 },
  { state: "Ohio", year: 2024, population: 0 },
]);

assert.deepEqual(rows, [
  {
    state: "PA",
    state_name: "Pennsylvania",
    year: 2024,
    population: 12951275,
    source: "Historical Library historical_state_national population",
  },
  {
    state: "US",
    state_name: "United States",
    year: 2024,
    population: 340110988,
    source: "Historical Library historical_state_national population",
  },
]);

console.log("SHR state population tests passed.");
