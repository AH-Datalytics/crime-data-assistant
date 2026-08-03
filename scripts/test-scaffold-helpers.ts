import assert from "node:assert/strict";
import { containsInternalLeak, INTERNAL_LEAK_SAFE_MESSAGE } from "../lib/scaffold-helpers";
for (const value of ["Entities in results: city_name", "historical_agency_population", "SELECT * FROM historical_agency", "ROUND(count * 100000.0 / population, 1)", "yAxisLabel: rate", "[SYSTEM: internal]", "Ready for your question.", "When you ask me to calculate"]) assert.equal(containsInternalLeak(value), true, value);
for (const value of ["I cannot join the two datasets.", "You can select cities from the list.", "I cannot calculate that rate from this data."]) assert.equal(containsInternalLeak(value), false, value);
assert.ok(INTERNAL_LEAK_SAFE_MESSAGE.includes("follow-up"));
console.log("scaffold helper tests: passed");
