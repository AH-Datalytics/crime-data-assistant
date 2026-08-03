import assert from "node:assert/strict";
import { neutralizeUnverifiedAvailabilityClaim, buildNoSqlFallbackMessage } from "../lib/refusal-safety";

const safe = neutralizeUnverifiedAvailabilityClaim("Iowa City is not in our dataset.", "Current Trends");
assert.match(safe, /couldn\'t verify/i);
assert.doesNotMatch(safe, /not in our dataset/i);
assert.equal(neutralizeUnverifiedAvailabilityClaim("SHR only contains homicide data.", "SHR"), "SHR only contains homicide data.");
for (const source of ["current", "historical", "nibrs", "shr", "hate_crime"]) assert.doesNotMatch(buildNoSqlFallbackMessage(source), /historical_|SELECT|yAxisLabel|Ready for your question/i);
console.log("refusal safety tests passed");
