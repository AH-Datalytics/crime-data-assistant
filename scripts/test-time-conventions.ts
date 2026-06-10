import assert from "node:assert/strict";
import {
  asksToIncludeCurrentYear,
  pastCompleteCalendarYearsRange,
  pastYearsIncludingCurrentRange,
  relativeYearConventionPrompt,
  relativeYearRangeForQuestion,
} from "../lib/time-conventions";
import { parseIntent } from "../lib/tab-suggest";

const now = new Date("2026-06-10T12:00:00-05:00");

assert.deepEqual(pastCompleteCalendarYearsRange(5, now), { start: 2021, end: 2025 });
assert.deepEqual(pastYearsIncludingCurrentRange(5, now), { start: 2022, end: 2026 });

assert.deepEqual(relativeYearRangeForQuestion("murders over the past 5 years", now), { start: 2021, end: 2025 });
assert.deepEqual(relativeYearRangeForQuestion("murders over the past five years", now), { start: 2021, end: 2025 });
assert.deepEqual(relativeYearRangeForQuestion("murders over the past 5 years including this year", now), { start: 2022, end: 2026 });
assert.equal(asksToIncludeCurrentYear("murders over the past 5 years to date"), true);

assert.match(relativeYearConventionPrompt(now), /past 5 years" means 2021-2025/);
assert.match(relativeYearConventionPrompt(now), /past 5 years including this year" means 2022-2026/);

assert.deepEqual(parseIntent("murders over the past 5 years").timeRange, { start: 2021, end: 2025 });
assert.deepEqual(parseIntent("murders over the past 5 years including this year").timeRange, { start: 2022, end: 2026 });

console.log("time convention tests passed");
