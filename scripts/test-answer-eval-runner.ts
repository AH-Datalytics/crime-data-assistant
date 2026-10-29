/**
 * The runner's comparison and gates (lib/answer-eval/{compare,gates}.ts) judge correctly: a plan with the label's
 * meaning compares equal; a different place, period, measure, unit, filter or cohort is a material difference;
 * an unknown period wording is a naming difference, never a wrong answer; outcomes and gates follow their rules.
 * Offline: no database, no model, no network.
 */
import assert from "node:assert/strict";
import { compareMeaning, labelPeriod, planToMeaning, type Release } from "../lib/answer-eval/compare";
import { gates, outcomeOf, type CaseResult } from "../lib/answer-eval/gates";
import type { Meaning } from "../lib/answer-eval/case";
import * as X from "../lib/nibrs-plan/examples";

const r: Release = { firstMonth: "1991-01", lastMonth: "2026-10", asOf: "2026-10-28" };

// Label periods resolve against the release.
assert.deepEqual(labelPeriod({ rule: "latest complete year" }, r), { from: "2025-01", to: "2025-12" });
assert.deepEqual(labelPeriod({ rule: "last 10 complete years" }, r), { from: "2016-01", to: "2025-12" });
assert.deepEqual(labelPeriod({ rule: "calendar year before today" }, r), { from: "2025-01", to: "2025-12" });
assert.deepEqual(labelPeriod({ rule: "year to date through the latest month" }, r), { from: "2026-01", to: "2026-10" });
assert.equal(labelPeriod({ rule: "something new" }, r), null);

// H2: Memphis carjackings in 2025, the frozen release question.
const { meaning: h2, statistics } = planToMeaning(X.H2, { kind: "absolute", from: "2025-01", to: "2025-12" });
const label: Meaning = {
  source: "nibrs", places: [{ kind: "agency", name: "Memphis Police Department", state: "TN" }], period: { from: "2025-01", to: "2025-12" },
  measures: [{ name: "carjacking", unit: "incident" }], filters: [], groupings: [], statistic: "count",
};
assert.deepEqual(compareMeaning(label, h2, r, statistics), [], "the same meaning");
const fields = (e: Meaning) => compareMeaning(e, h2, r, statistics).filter((d) => d.kind === "material").map((d) => d.field);
assert.deepEqual(fields({ ...label, places: [{ kind: "agency", name: "Nashville Police Department", state: "TN" }] }), ["places"]);
assert.deepEqual(fields({ ...label, period: { from: "2024-01", to: "2024-12" } }), ["period"]);
assert.deepEqual(fields({ ...label, measures: [{ name: "robbery", unit: "incident" }] }), ["measures"]);
assert.deepEqual(fields({ ...label, measures: [{ name: "carjacking", unit: "victim" }] }), ["units"]);
assert.deepEqual(fields({ ...label, filters: ["weapon: firearm"] }), ["filters"]);
assert.deepEqual(fields({ ...label, cohort: "same_agencies" }), ["cohort"]);
assert.deepEqual(fields({ ...label, statistic: "rate" }), ["statistic"]);
assert.deepEqual(compareMeaning({ ...label, period: { rule: "the summer" } }, h2, r, statistics).map((d) => d.kind), ["naming"], "an unknown period wording is naming, not wrong");
assert.deepEqual(fields({ ...label, period: { rule: "latest complete year" } }), [], "a relative label period resolves");

// Outcomes.
assert.equal(outcomeOf("answer", "answer", 0, true), "correct");
assert.equal(outcomeOf("answer", "answer", 2, true), "wrong_answer");
assert.equal(outcomeOf("answer", "decline", 0, true), "avoidable_decline");
assert.equal(outcomeOf("answer", "no_reading", 0, true), "avoidable_decline");
assert.equal(outcomeOf("answer", "clarify", 0, true), "unnecessary_clarify");
assert.equal(outcomeOf("decline", "answer", 0, true), "wrong_answer", "a number where the label declines is a wrong answer");
assert.equal(outcomeOf("clarify", "answer", 0, true), "wrong_answer", "a number where the label asks is a wrong answer");
assert.equal(outcomeOf("decline", "decline", 0, false), "incomplete");
assert.equal(outcomeOf("clarify", "decline", 0, true), "wrong_action");

// Gates: one wrong answer fails; 19 of 20 correct passes the 95% bars.
const res = (n: number, outcome: CaseResult["outcome"], actual: CaseResult["actual"] = "answer"): CaseResult[] =>
  Array.from({ length: n }, (_, i) => ({ id: `LS-${i}`, split: "dev", expected: "answer", actual, outcome, diffs: [], notes: [], capability: "nibrs:count", era: "2021 and later" }));
assert.equal(gates([...res(19, "correct"), ...res(1, "avoidable_decline", "decline")])[0].pass, true, "95% passes");
assert.equal(gates([...res(18, "correct"), ...res(2, "avoidable_decline", "decline")])[0].pass, false, "90% fails");
assert.equal(gates([...res(99, "correct"), ...res(1, "wrong_answer")])[0].pass, false, "any wrong answer fails");

console.log("answer-eval runner: comparison, outcomes and gates as specified");
