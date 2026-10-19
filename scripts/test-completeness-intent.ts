import assert from "node:assert/strict";
import { containsInternalLeak } from "../lib/scaffold-helpers";
import { buildCompletenessAnswer, detectCompletenessQuestion, latestCompleteYear } from "../lib/completeness-intent";
import { MONTH_COVERAGE_FAILED, monthCoverageAnswer, monthCoverageSql, ownsMonthCoverage, recognizeMonthCoverageQuestion } from "../lib/current-month-coverage";

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

// GC-051 batch (lib/current-month-coverage.ts): a standalone Current "what months does YEAR include?".
{
  for (const [q, year] of [
    ["what months does 2026 include?", 2026], ["Which months of 2026 are available?", 2026], ["what months are available for 2025", 2025],
    ["months available for 2026", 2026], ["2026 months available", 2026], ["what months of 2026 do you have data for?", 2026],
    ["Which months does the 2026 data cover?", 2026],
  ] as [string, number][]) {
    assert.deepEqual(recognizeMonthCoverageQuestion(q), { year }, q);
    assert.equal(detectCompletenessQuestion(q), null, `${q}: not the completeness family`);
  }
  for (const q of [
    "what months does 2026 include for Chicago?", "what months does 2026 include for murders?", "what months do 2025 and 2026 include?",
    "murders by month in 2026", "is 2026 data complete?", "what months does the data include?",
    "what months does 2026 include and how many murders were there?",
  ]) assert.equal(recognizeMonthCoverageQuestion(q), null, q);
  // Owned only as a standalone turn.
  assert.deepEqual(ownsMonthCoverage("what months does 2026 include?", []), { year: 2026 });
  assert.deepEqual(ownsMonthCoverage("what months does 2026 include?", undefined), { year: 2026 });
  assert.equal(ownsMonthCoverage("what months does 2026 include?", [{ role: "user", content: "Chicago murders in 2026" }]), null);
  assert.equal(monthCoverageSql(2026), "SELECT DISTINCT month FROM national_monthly WHERE year = 2026 ORDER BY month");
  // The answer: present months, named gaps, the source scope, no completeness claim, no table name (response firewall).
  const answer = monthCoverageAnswer(2026, [{ month: 9 }, { month: 2 }, { month: 3 }, { month: 5 }, { month: 3 }]);
  assert.ok(answer.startsWith("For 2026, Current Trends' national monthly totals include 4 months: February, March, May and September. Not included: January, April, June, July, August, October, November and December."), answer);
  assert.ok(answer.includes("It does not show that every agency reported in those months"), answer);
  assert.equal(containsInternalLeak(answer), false, "no internal identifier reaches the reader");
  assert.ok(monthCoverageAnswer(2025, Array.from({ length: 12 }, (_, i) => ({ month: i + 1 }))).includes("include all 12 months"));
  assert.ok(monthCoverageAnswer(2027, [{ month: 1 }]).includes("include 1 month: January. Not included: February,"));
  const empty = monthCoverageAnswer(2024, []);
  assert.ok(empty.startsWith("Current Trends' national monthly totals have no months for 2024") && empty.includes("not a count of zero crimes"), empty);
  assert.equal(containsInternalLeak(empty), false);
  assert.ok(MONTH_COVERAGE_FAILED(2026).includes("failure on our side") && !/no months/.test(MONTH_COVERAGE_FAILED(2026)));
  assert.equal(containsInternalLeak(MONTH_COVERAGE_FAILED(2026)), false);
}

console.log("completeness intent tests passed");
