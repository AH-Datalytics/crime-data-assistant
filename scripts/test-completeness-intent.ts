import assert from "node:assert/strict";
import { containsInternalLeak } from "../lib/scaffold-helpers";
import { buildCompletenessAnswer, detectCompletenessQuestion, latestCompleteYear } from "../lib/completeness-intent";

assert.deepEqual(detectCompletenessQuestion("Is the 2026 data complete?"), { year: 2026 });
assert.deepEqual(detectCompletenessQuestion("Is 2025 hate crime data final?"), { year: 2025 });
assert.deepEqual(detectCompletenessQuestion("How up to date is the data?"), { year: null });
assert.equal(detectCompletenessQuestion("Which states are safest?"), null);
assert.equal(detectCompletenessQuestion("What's the completeness rate of agencies?"), null);
assert.equal(detectCompletenessQuestion("Give me a complete list of offenses"), null);

const hateRows = [
  { year: 2022, value: 12000 }, { year: 2023, value: 11800 }, { year: 2024, value: 11689 },
  { year: 2025, value: 10647 }, { year: 2026, value: 4806 },
];
const classification = latestCompleteYear(hateRows, 2026);
assert.equal(classification.latestPresent, 2026);
assert.equal(classification.latestComplete, 2024);
assert.deepEqual(classification.preliminaryYears, [2025, 2026]);
const answer = buildCompletenessAnswer("hate_crime", hateRows, 2026, 2026);
assert.match(answer, /2026/);
assert.match(answer, /incomplete/);
assert.match(answer, /2024/);
assert.doesNotMatch(answer, /summary_|historical_|yAxisLabel|SELECT|FROM/i);
assert.equal(containsInternalLeak(answer), false);

const shifted = latestCompleteYear(hateRows, 2027);
assert.equal(shifted.latestPresent, 2026);
assert.equal(shifted.latestComplete, 2025);
const sourceAnswers = [
  buildCompletenessAnswer("nibrs", hateRows, 2026, 2026),
  buildCompletenessAnswer("shr", hateRows, 2026, 2026),
  buildCompletenessAnswer("historical", hateRows, 2026, 2026),
];
for (const sourceAnswer of sourceAnswers) assert.match(sourceAnswer, /incomplete|reasonably complete/);
const currentAnswer = buildCompletenessAnswer("current", [{ year: 2026, month: 5, value: 1 }], 2026, 2026);
assert.match(currentAnswer, /monthly|incomplete/i);

console.log("completeness intent tests passed");
