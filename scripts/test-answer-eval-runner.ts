/**
 * The runner's comparison and gates (lib/answer-eval/{compare,gates}.ts) judge correctly. A plan with the label's
 * meaning matches. A different place, period, measure, unit, filter value, combination, rank or cohort is material.
 * An unknown word or a detail the label cannot express is unverified: never correct, never wrong. Outcomes keep the
 * observed action, and gates report every mandatory category, with "not measured" where it cannot be checked.
 * Includes the probes from Codex's runner review (r1). Offline: no database, no model, no network.
 */
import assert from "node:assert/strict";
import { compareMeaning, labelPeriod, planToMeaning, type Release } from "../lib/answer-eval/compare";
import { gates, outcomeOf, type CaseResult } from "../lib/answer-eval/gates";
import type { Meaning } from "../lib/answer-eval/case";
import * as X from "../lib/nibrs-plan/examples";

const r: Release = { firstMonth: "1991-01", lastMonth: "2026-10", asOf: "2026-10-28" };
const year = (y: number) => ({ kind: "absolute" as const, from: `${y}-01`, to: `${y}-12` });

// Label periods resolve against the release.
assert.deepEqual(labelPeriod({ rule: "latest complete year" }, r), { from: "2025-01", to: "2025-12" });
assert.deepEqual(labelPeriod({ rule: "last 10 complete years" }, r), { from: "2016-01", to: "2025-12" });
assert.deepEqual(labelPeriod({ rule: "calendar year before today" }, r), { from: "2025-01", to: "2025-12" });
assert.deepEqual(labelPeriod({ rule: "year to date through the latest month" }, r), { from: "2026-01", to: "2026-10" });
assert.equal(labelPeriod({ rule: "something new" }, r), null);

// H2: Memphis carjackings in 2025, the frozen release question.
const h2 = planToMeaning(X.H2, year(2025));
const label: Meaning = {
  source: "nibrs", places: [{ kind: "city", name: "Memphis", state: "TN" }], period: { from: "2025-01", to: "2025-12" },
  measures: [{ name: "carjacking", unit: "incident" }], filters: [], groupings: [], statistic: "count",
};
const kinds = (e: Meaning, v = h2) => compareMeaning(e, v, r).map((d) => `${d.kind}:${d.field}`);
assert.deepEqual(kinds(label), [], "the same meaning (a city and its police department are one place)");
assert.deepEqual(kinds({ ...label, places: [{ kind: "agency", name: "Nashville Police Department", state: "TN" }] }), ["material:places"]);
assert.deepEqual(kinds({ ...label, period: { from: "2024-01", to: "2024-12" } }), ["material:period"]);
assert.deepEqual(kinds({ ...label, measures: [{ name: "robbery", unit: "incident" }] }), ["material:measures"]);
assert.deepEqual(kinds({ ...label, measures: [{ name: "carjacking", unit: "victim" }] }), ["material:measures"]);
assert.deepEqual(kinds({ ...label, cohort: "same_agencies" }), ["material:cohort"]);
assert.deepEqual(kinds({ ...label, statistic: "rate" }), ["material:statistic"]);
assert.deepEqual(kinds({ ...label, period: { rule: "latest complete year" } }), [], "a relative label period resolves");
assert.deepEqual(kinds({ ...label, period: { rule: "the summer" } }), ["unverified:period"], "an unknown period wording is unverified");
assert.deepEqual(kinds({ ...label, measures: [{ name: "zorbing", unit: "incident" }] }), ["unverified:measures"], "an unknown measure word is unverified");

// Codex probe: Los Angeles is not Los Banos.
const la = planToMeaning({ ...X.H2, geography: { places: [{ kind: "agency", ori: "CA0194200", label: "Los Angeles Police Department, CA" }], combine: "separate" } }, year(2025));
assert.deepEqual(kinds({ ...label, places: [{ kind: "agency", name: "Los Banos Police Department", state: "CA" }] }, la), ["material:places"]);
// Codex probe: firearm versus knife is a different filter value; only the full firearm set is "firearm".
const weapon = (values: string[], op: "in" | "not_in" = "in", negate = false) => planToMeaning({ ...X.H2, filters: [{ kind: "exists", scope: "offense", entity: "offense_weapon", ...(negate ? { negate } : {}), where: [{ kind: "attribute", dimension: "offense_weapon.weapon", op, values }] }] }, year(2025));
const ALL_FIREARMS = ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"];
assert.deepEqual(kinds({ ...label, filters: ["weapon: firearm"] }, weapon(ALL_FIREARMS)), []);
assert.deepEqual(kinds({ ...label, filters: ["weapon: knife"] }, weapon(ALL_FIREARMS)), ["material:filters"]);
assert.deepEqual(kinds({ ...label, filters: ["weapon: firearm"] }, weapon(["12"])), ["unverified:filters"], "handgun only is not all firearms");
assert.deepEqual(kinds({ ...label, filters: ["weapon: knife"] }, weapon(["20"], "not_in")), ["unverified:filters"], "an exclusion is not the value");
assert.deepEqual(kinds({ ...label, filters: ["weapon: knife"] }, weapon(["20"], "in", true)), ["unverified:filters"], "a negated existence is not the value");
// Codex probe: two different unknowns never match.
assert.deepEqual(kinds({ ...label, filters: ["victim race: White"] }, planToMeaning({ ...X.H2, filters: [{ kind: "exists", scope: "incident", entity: "victim", where: [{ kind: "attribute", dimension: "victim.race", op: "in", values: ["B"] }] }] }, year(2025))), ["unverified:filters"]);
assert.deepEqual(kinds({ ...label, groupings: ["victim ethnicity"] }, planToMeaning({ ...X.H2, groupings: [{ dimension: "victim.resident_status", unknown: "visible", absent: "show" }] }, year(2025))), ["unverified:groupings"]);
// Codex probe: month boundaries hold for a year selection; comparison baselines and native shares are unverified.
const yrs = planToMeaning({ ...X.SEPARATE_YEARS, period: { kind: "years", years: [2025] } }, { kind: "years", years: [2025] });
assert.ok(compareMeaning({ ...label, places: yrs.meaning.places, measures: yrs.meaning.measures, groupings: yrs.meaning.groupings, period: { from: "2025-06", to: "2025-08" } }, yrs, r).some((d) => d.kind === "material" && d.field === "period"), "June-August is not 2025");
// Codex probe: a year clipped to the release's last month ends there.
const clipped = planToMeaning({ ...X.SEPARATE_YEARS, period: { kind: "years", years: [2026] } }, { kind: "years", years: [2026], through: "2026-10" });
const clippedLabel = (to: string) => compareMeaning({ ...label, places: clipped.meaning.places, measures: clipped.meaning.measures, groupings: clipped.meaning.groupings, period: { from: "2026-01", to } }, clipped, r).filter((d) => d.field === "period").map((d) => d.kind);
assert.deepEqual(clippedLabel("2026-10"), [], "January-October 2026 is the clipped year");
assert.deepEqual(clippedLabel("2026-12"), ["material"], "a full 2026 is not the clipped year");
const cmp = planToMeaning(X.SAME_AGENCIES_CHANGE, { kind: "absolute", from: "2023-01", to: "2025-12" });
// Increment 3: a change label implies its two periods (the first and last years of its period, or the same months it
// names); the comparison is checked against them, a different baseline is material, and unnamed months stay unverified.
const cmpLabel = (extra: Partial<Meaning>) => compareMeaning({ ...label, places: cmp.meaning.places, measures: cmp.meaning.measures, period: { from: "2023-01", to: "2025-12" }, statistic: "change", cohort: "same_agencies", groupings: ["year"], ...extra }, cmp, r).filter((d) => d.field === "comparison").map((d) => d.kind);
assert.deepEqual(cmpLabel({}), [], "2023 against 2025, as the label's period implies");
assert.deepEqual(cmpLabel({ period: { from: "2024-01", to: "2025-12" } }), ["material"], "a different baseline is a different comparison");
assert.deepEqual(cmpLabel({ filters: ["the same months of each year: some of them"] }), ["unverified"], "months the label does not name stay unverified");
// Codex probe: combined versus separate places.
const two = planToMeaning({ ...X.NAMED_PLACES }, year(2024));
const twoLabel: Meaning = { ...label, places: two.meaning.places, measures: two.meaning.measures.map((m) => ({ name: m.name, unit: m.unit })), period: two.meaning.period, groupings: two.meaning.groupings, statistic: two.meaning.statistic as Meaning["statistic"], combine: two.meaning.combine === "combined" ? "separate" : "combined" };
assert.ok(kinds(twoLabel, two).includes("material:combine"), "combined vs separate places");
// Codex probe: a share's roles cannot be read from the label, so a share is never credited as correct.
const share = planToMeaning(X.SUBSET_SHARE, year(2025));
assert.ok(compareMeaning({ ...label, places: share.meaning.places, measures: [{ name: share.measures[0].name, unit: share.measures[0].unit }], statistic: "share", period: share.meaning.period }, share, r).some((d) => d.kind === "unverified" && d.field === "share roles"));
// Codex probe: units stay with their measures.
assert.deepEqual(kinds({ ...label, measures: [{ name: "carjacking", unit: "offense" }] }), ["material:measures"]);

// Outcomes keep the observed action.
assert.equal(outcomeOf("answer", "answer", { material: 0 }), "correct");
assert.equal(outcomeOf("answer", "answer", { unverified: 1 }), "unverified");
assert.equal(outcomeOf("answer", "answer", { material: 2 }), "wrong_answer");
assert.equal(outcomeOf("answer", "decline"), "avoidable_decline");
assert.equal(outcomeOf("answer", "no_reading"), "avoidable_decline");
assert.equal(outcomeOf("answer", "clarify"), "unnecessary_clarify");
assert.equal(outcomeOf("decline", "answer"), "wrong_answer");
assert.equal(outcomeOf("clarify", "answer"), "wrong_answer");
assert.equal(outcomeOf("decline", "no_reading"), "incomplete", "no reading is not a decline: no reason was given");
assert.equal(outcomeOf("decline", "decline", { structured: false }), "unverified", "an unjudged reason is not credited");
assert.equal(outcomeOf("decline", "decline", { structured: true }), "correct");
assert.equal(outcomeOf("decline", "decline", { structured: true, alternativeMissing: true }), "incomplete");
assert.equal(outcomeOf("clarify", "decline"), "wrong_action");
assert.equal(outcomeOf("clarify", "clarify", { structured: false }), "unverified");

// Gates.
const res = (n: number, expected: CaseResult["expected"], actual: CaseResult["actual"], outcome: CaseResult["outcome"]): CaseResult[] =>
  Array.from({ length: n }, (_, i) => ({ id: `LS-${i}`, split: "dev", expected, actual, outcome, diffs: [], notes: [], capability: "x", era: "2021 and later" }));
const status = (rs: CaseResult[]) => gates(rs)[0].status;
const category = (rs: CaseResult[], name: string) => gates(rs)[0].categories.find((c) => c.name === name)!.status;
assert.equal(status([...res(19, "answer", "answer", "correct"), ...res(1, "answer", "decline", "avoidable_decline")]), "not measured", "95% direct answers, numeric fixtures not measured");
assert.equal(category([...res(19, "answer", "answer", "correct"), ...res(1, "answer", "decline", "avoidable_decline")], "direct answers"), "pass");
assert.equal(category([...res(18, "answer", "answer", "correct"), ...res(2, "answer", "decline", "avoidable_decline")], "direct answers"), "fail");
assert.equal(status([...res(99, "answer", "answer", "correct"), ...res(1, "answer", "answer", "wrong_answer")]), "fail", "any wrong answer fails");
// Codex probe: 19 correct declines and one clarification where a decline was expected must not pass.
assert.equal(category([...res(19, "decline", "decline", "correct"), ...res(1, "decline", "clarify", "wrong_action")], "declines"), "fail");
assert.equal(category(res(5, "decline", "decline", "unverified"), "declines"), "not measured");
assert.equal(category(res(5, "clarify", "clarify", "unverified"), "clarifications"), "not measured");
// Codex probe: zero wrong answers is not established while answers are unverified.
assert.equal(category(res(1, "answer", "answer", "unverified"), "wrong answers"), "not measured");

console.log("answer-eval runner: comparison, outcomes and gates as specified");
