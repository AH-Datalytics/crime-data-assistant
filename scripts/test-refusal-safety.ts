import assert from "node:assert/strict";
import { neutralizeUnverifiedAvailabilityClaim } from "../lib/refusal-safety";

const safe = neutralizeUnverifiedAvailabilityClaim("Iowa City is not in our dataset.", "Current Trends");
assert.match(safe, /couldn\'t verify/i);
assert.doesNotMatch(safe, /not in our dataset/i);
assert.equal(neutralizeUnverifiedAvailabilityClaim("SHR only contains homicide data.", "SHR"), "SHR only contains homicide data.");
console.log("refusal safety tests passed");
