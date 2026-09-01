/**
 * P3.1a — mutation suite for the frozen-case runner.
 *
 * The runner's accounting is a claim about the runner. This suite breaks the runner's inputs on
 * purpose and requires each break to be CAUGHT, so that "63 agreed" is a measurement rather than a
 * sentence the runner is capable of printing regardless. Every control here first shows the healthy
 * baseline it deviates from; a mutation that fails without a passing baseline proves nothing.
 *
 * It uses SYNTHETIC cases throughout. It does not read, execute, or adjudicate the 63 frozen cases,
 * and it writes no run artifact.
 */
import {
  executeFrozenCases, accountFor, projectFrozenContract, CONTRACT_SHELL,
  type CaseResult,
} from "./run-p3-1a-frozen-cases";

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`); }
}
function checkTrue(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "\n          " + detail : ""}`); }
}

/** A synthetic applying case and a synthetic non-applying case. */
const applying = (id: string) => ({
  id, rule_id: "r-" + id, source: "current", pair: "r x current", role: "positive",
  question: "q-" + id,
  expected_outcome: { store: "query_log", action: "decline_capability", reason: "query_contract_failed", applies: true },
  expected_contract: { "metric.topic": "murder" },
});
const notApplying = (id: string) => ({
  id, rule_id: "r-" + id, source: "current", pair: "r x current", role: "false_acceptance",
  question: "q-" + id,
  expected_outcome: { store: "query_log", action: null, reason: null, applies: false },
  expected_contract: null,
});

/** A well-behaved observer: reports exactly what each synthetic case expects. */
const honestObserve = (c: any) =>
  c.expected_outcome.applies
    ? { inDenominator: true, state: "fired", action: "decline_capability", reason: "query_contract_failed" }
    : { inDenominator: true, state: "did_not_fire", action: null, reason: null };

/** A well-behaved parser: reproduces each case's frozen projection. */
const honestParser = (c: any) => (c.expected_contract ? { metric: { topic: "murder" } } : null);

const CASES = [applying("A1"), notApplying("A2"), applying("A3")];

// ── M0 — the healthy baseline ───────────────────────────────────────────────────────────────
console.log("M0 — healthy baseline");
{
  const r = executeFrozenCases({ cases: CASES, observe: honestObserve, buildContract: honestParser });
  check("M0  a clean run is complete with every case agreed",
    [r.accounting, r.counts.agreed, r.counts.not_run, r.counts.disagreed], ["complete", 3, 0, 0]);
  check("M0b parser agreement recorded on its own axis",
    r.parserCounts, { agreed: 2, not_applicable: 1 });
}

// ── M1 — a skipped case is never a passing case ─────────────────────────────────────────────
console.log("\nM1 — skipped case");
{
  const list: CaseResult[] = [
    { id: "A1", pair: "p", role: "positive", disposition: "agreed", observed: null,
      expected: { applies: true, action: null, reason: null }, parserAgreement: "agreed", parserDetail: null, detail: null },
    { id: "A2", pair: "p", role: "positive", disposition: "not_run", observed: null,
      expected: { applies: true, action: null, reason: null }, parserAgreement: "agreed", parserDetail: null, detail: null },
  ];
  const clean = accountFor([list[0]], 1, []);
  const skipped = accountFor(list, 2, []);
  check("M1  the same accounting call is complete when nothing is skipped", clean.accounting, "complete");
  check("M1b one unexecuted case makes the whole run incomplete", skipped.accounting, "incomplete");
  checkTrue("M1c and it says which rule caught it",
    (skipped.accountingDetail ?? "").includes("never executed"), skipped.accountingDetail ?? "");
  check("M1d a short result list is caught even with no not_run",
    accountFor([list[0]], 3, []).accounting, "incomplete");
}

// ── M2 — duplicate case ids ─────────────────────────────────────────────────────────────────
console.log("\nM2 — duplicate case ids");
{
  const dup = [applying("A1"), applying("A1"), notApplying("A2")];
  const r = executeFrozenCases({ cases: dup, observe: honestObserve, buildContract: honestParser });
  check("M2  a duplicated id makes the run incomplete", r.accounting, "incomplete");
  checkTrue("M2b the duplicate is named", (r.accountingDetail ?? "").includes("duplicate case ids: A1"),
    r.accountingDetail ?? "");
  check("M2c the duplicate does not inflate the agreed count", r.counts.agreed, 2);
}

// ── M3 — a substituted expectation is caught, not absorbed ──────────────────────────────────
console.log("\nM3 — substituted expected fields");
{
  const swappedReason = JSON.parse(JSON.stringify(CASES));
  swappedReason[0].expected_outcome.reason = "unsupported_capability";
  const r1 = executeFrozenCases({ cases: swappedReason, observe: honestObserve, buildContract: honestParser });
  check("M3  a substituted expected REASON is a disagreement, not an agreement",
    [r1.counts.agreed, r1.counts.disagreed], [2, 1]);
  checkTrue("M3b the disagreement names the field",
    (r1.results.find((x) => x.id === "A1")?.detail ?? "").includes("reason:"));

  const swappedAction = JSON.parse(JSON.stringify(CASES));
  swappedAction[0].expected_outcome.action = "answer_delivered";
  const r2 = executeFrozenCases({ cases: swappedAction, observe: honestObserve, buildContract: honestParser });
  check("M3c a substituted expected ACTION is a disagreement", r2.counts.disagreed, 1);

  const swappedApplies = JSON.parse(JSON.stringify(CASES));
  swappedApplies[1].expected_outcome.applies = true;
  const r3 = executeFrozenCases({ cases: swappedApplies, observe: honestObserve, buildContract: honestParser });
  check("M3d a substituted expected APPLICABILITY is a disagreement", r3.counts.disagreed, 1);

  // The mirror case: a non-applying expectation must not tolerate a typed pair appearing anyway.
  const stray = executeFrozenCases({
    cases: [notApplying("A2")],
    observe: () => ({ inDenominator: true, state: "did_not_fire", action: "decline_capability", reason: "query_contract_failed" }),
    buildContract: honestParser,
  });
  check("M3e a typed pair on a non-applying case is a disagreement", stray.counts.disagreed, 1);
}

// ── M4 — a parser disagreement is never missed and never rewrites the verdict ───────────────
console.log("\nM4 — parser disagreement");
{
  const drifted = executeFrozenCases({
    cases: CASES, observe: honestObserve,
    buildContract: (c) => (c.expected_contract ? { metric: { topic: "robbery" } } : null),
  });
  check("M4  a parser that disagrees with the frozen projection is recorded as disagreeing",
    drifted.parserCounts.disagreed, 2);
  checkTrue("M4b the disagreement carries both values",
    (drifted.results[0].parserDetail ?? "").includes("parser=\"robbery\"") &&
    (drifted.results[0].parserDetail ?? "").includes("frozen=\"murder\""));
  check("M4c but the applicability verdict is UNCHANGED - the parser is not the oracle",
    [drifted.counts.agreed, drifted.counts.disagreed], [3, 0]);

  const missing = executeFrozenCases({
    cases: CASES, observe: honestObserve, buildContract: () => null,
  });
  check("M4d a parser that returns nothing for a projected case is a disagreement, not silence",
    missing.parserCounts.disagreed, 2);

  const thrown = executeFrozenCases({
    cases: CASES, observe: honestObserve,
    buildContract: () => { throw new Error("parser exploded"); },
  });
  check("M4e a throwing parser is its own state, never agreement", thrown.parserCounts.parser_error, 3);
  check("M4f and it still does not change the applicability verdict", thrown.counts.agreed, 3);
}

// ── M5 — analysis_incomplete never collapses into did_not_fire ──────────────────────────────
console.log("\nM5 — incomplete is not a clean negative");
{
  // The dangerous shape: a case EXPECTING not-to-apply, whose predicate could not be evaluated.
  // Collapsing incomplete into did_not_fire would score this as agreement.
  const r = executeFrozenCases({
    cases: [notApplying("A2")],
    observe: () => ({ inDenominator: true, state: "analysis_incomplete", action: null, reason: null }),
    buildContract: honestParser,
  });
  check("M5  an unmeasurable non-applying case is analysis_incomplete, NOT agreed",
    [r.counts.agreed, r.counts.analysis_incomplete, r.accounting], [0, 1, "complete"]);
  checkTrue("M5b and it is not silently a disagreement either",
    r.counts.disagreed === 0 && r.results[0].disposition === "analysis_incomplete");

  const baseline = executeFrozenCases({
    cases: [notApplying("A2")],
    observe: () => ({ inDenominator: true, state: "did_not_fire", action: null, reason: null }),
    buildContract: honestParser,
  });
  check("M5c the same case DOES agree when the predicate is measurable",
    baseline.counts.agreed, 1);

  // A runner-level throw is a third, separate state.
  const broken = executeFrozenCases({
    cases: [applying("A1")],
    observe: () => { throw new Error("observer exploded"); },
    buildContract: honestParser,
  });
  check("M5d a harness throw is harness_error, never agreement",
    [broken.counts.harness_error, broken.counts.agreed], [1, 0]);
}

// ── M6 — a rule outside the denominator is not an agreement by absence ──────────────────────
console.log("\nM6 — absence is not agreement");
{
  const absent = executeFrozenCases({
    cases: [applying("A1")],
    observe: () => ({ inDenominator: false, state: null, action: null, reason: null }),
    buildContract: honestParser,
  });
  check("M6  an applying case whose rule never entered the denominator disagrees",
    [absent.counts.disagreed, absent.counts.agreed], [1, 0]);
}

// ── M7 — the frozen projection helper does not mutate its shell ─────────────────────────────
console.log("\nM7 — projection purity");
{
  const beforeShell = JSON.stringify(CONTRACT_SHELL);
  const projected: any = projectFrozenContract(CONTRACT_SHELL, "shr", { "metric.topic": "robbery" });
  check("M7  the projection applies to the copy", [projected.source, projected.metric.topic], ["shr", "robbery"]);
  check("M7b and the shared shell is untouched", JSON.stringify(CONTRACT_SHELL), beforeShell);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
