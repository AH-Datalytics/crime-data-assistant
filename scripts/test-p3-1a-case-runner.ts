/**
 * P3.1a — mutation suite for the frozen-case runner.
 *
 * The runner's accounting and verdicts are claims about the runner. This suite breaks its inputs on
 * purpose and requires each break to be CAUGHT, so that "63 conformant" is a measurement rather
 * than a sentence the runner is capable of printing regardless. Every control first shows the
 * healthy baseline it deviates from; a mutation that fails without a passing baseline proves
 * nothing.
 *
 * It uses SYNTHETIC cases throughout. It does not read, execute, or adjudicate the 63 frozen cases,
 * and it writes no run artifact.
 */
import {
  executeFrozenCases, accountFor, deriveCaseVerdict, projectFrozenContract, CONTRACT_SHELL,
  type CaseResult, type PredicateAgreement, type ParserAgreement, type ParserExecution,
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

const honestObserve = (c: any) =>
  c.expected_outcome.applies
    ? { inDenominator: true, state: "fired", action: "decline_capability", reason: "query_contract_failed" }
    : { inDenominator: true, state: "did_not_fire", action: null, reason: null };

const honestParser = (c: any) => (c.expected_contract ? { metric: { topic: "murder" } } : null);

const CASES = [applying("A1"), notApplying("A2"), applying("A3")];

// ── M0 — the healthy baseline ───────────────────────────────────────────────────────────────
console.log("M0 — healthy baseline");
{
  const r = executeFrozenCases({ cases: CASES, observe: honestObserve, buildContract: honestParser });
  check("M0  a clean run completes, accounts fully, and is conformant",
    [r.runState, r.accountingVerdict, r.evidenceVerdict], ["completed", "complete", "conformant"]);
  check("M0b every case agreed on both axes and is conformant",
    [r.predicateCounts.agreed, r.verdictCounts.conformant, r.verdictCounts.nonconformant], [3, 3, 0]);
  check("M0c parser agreement is recorded on its own axis",
    r.parserCounts, { agreed: 2, not_applicable: 1 });
  check("M0d and parser EXECUTION is recorded separately from what it concluded",
    r.parserExecutionCounts, { not_run: 0, completed: 3, error: 0 });
  check("M0e every case was parser-visited exactly once",
    r.parserVisits, { A1: 1, A2: 1, A3: 1 });
}

// ── M1 — a skipped case is never a passing case ─────────────────────────────────────────────
console.log("\nM1 — skipped case");
{
  const ran: CaseResult = {
    id: "X", pair: "p", role: "positive", predicateAgreement: "agreed", parserAgreement: "agreed",
    parserExecution: "completed", caseVerdict: "conformant", observed: null,
    expected: { applies: true, action: null, reason: null },
    parserDetail: null, predicateDetail: null,
  };
  const skipped: CaseResult = { ...ran, id: "Y", predicateAgreement: "not_run",
    caseVerdict: "not_established" };
  const diverged: CaseResult = { ...ran, id: "Z", predicateAgreement: "not_run",
    parserAgreement: "disagreed", caseVerdict: "nonconformant" };
  const ledger = (...rs: CaseResult[]) => Object.fromEntries(rs.map((r) => [r.id, 1]));

  check("M1  complete when nothing is skipped",
    accountFor({ list: [ran], entryCount: 1, duplicates: [], runState: "completed",
      parserVisits: ledger(ran) }).accountingVerdict, "complete");

  const one = accountFor({ list: [ran, skipped], entryCount: 2, duplicates: [],
    runState: "completed", parserVisits: ledger(ran, skipped) });
  check("M1b one unexecuted case makes the whole run incomplete", one.accountingVerdict, "incomplete");
  checkTrue("M1c and it says which rule caught it",
    (one.accountingDetail ?? "").includes("never executed"), one.accountingDetail ?? "");

  check("M1d a short result list is caught even with no not_run",
    accountFor({ list: [ran], entryCount: 3, duplicates: [], runState: "completed",
      parserVisits: ledger(ran) }).accountingVerdict, "incomplete");

  // The inverse: after a deliberate stop, every case MUST be not_run - and something must have
  // actually diverged.
  check("M1e a stopped run, all cases un-run, with a real divergence, accounts as complete",
    accountFor({ list: [diverged], entryCount: 1, duplicates: [],
      runState: "stopped_parser_divergence", parserVisits: ledger(diverged) }).accountingVerdict,
    "complete");
  const halfStopped = accountFor({ list: [ran, diverged], entryCount: 2, duplicates: [],
    runState: "stopped_parser_divergence", parserVisits: ledger(ran, diverged) });
  check("M1f a 'stopped' run that executed cases anyway is incomplete",
    halfStopped.accountingVerdict, "incomplete");
  checkTrue("M1g and it says the stop did not stop anything",
    (halfStopped.accountingDetail ?? "").includes("executed anyway"), halfStopped.accountingDetail ?? "");
}

// ── M9 — the parser phase is accounted for independently ────────────────────────────────────
//
// Round 3 found the escape these close. Accounting counted only `predicateAgreement`, so once one
// case diverged and the run entered `stopped_parser_divergence`, "every predicate is not_run" was
// the only rule left - and a parser case that was never visited satisfied it. Worse,
// `parserAgreement: "not_applicable"` is both the initial value and a legitimate result, so the
// skipped case was indistinguishable from a parsed one.
console.log("\nM9 — parser-phase accounting");
{
  const base: CaseResult = {
    id: "A", pair: "p", role: "positive", predicateAgreement: "not_run",
    parserAgreement: "not_applicable", parserExecution: "completed",
    caseVerdict: "not_established", observed: null,
    expected: { applies: true, action: null, reason: null },
    parserDetail: null, predicateDetail: null,
  };
  const divergedCase: CaseResult = { ...base, id: "B", parserAgreement: "disagreed",
    caseVerdict: "nonconformant" };
  const ledgerOf = (rs: CaseResult[], over: Record<string, number> = {}) =>
    ({ ...Object.fromEntries(rs.map((r) => [r.id, 1])), ...over });

  // The baseline these four deviate from: a legitimate stop.
  const good = [base, divergedCase];
  check("M9  baseline - a legitimate stop accounts as complete",
    accountFor({ list: good, entryCount: 2, duplicates: [],
      runState: "stopped_parser_divergence", parserVisits: ledgerOf(good) }).accountingVerdict,
    "complete");

  // (1) a skipped parser case, hidden behind another case's divergence
  const skippedParser = [{ ...base, parserExecution: "not_run" as ParserExecution }, divergedCase];
  const r1 = accountFor({ list: skippedParser, entryCount: 2, duplicates: [],
    runState: "stopped_parser_divergence", parserVisits: ledgerOf([divergedCase]) });
  check("M9b a case the parser never visited makes the run incomplete", r1.accountingVerdict, "incomplete");
  checkTrue("M9c and it names both the state and the missing ledger entry",
    (r1.accountingDetail ?? "").includes("never parser-processed") &&
    (r1.accountingDetail ?? "").includes("no parser visit recorded"), r1.accountingDetail ?? "");

  // (2) a duplicate parser visit
  const r2 = accountFor({ list: good, entryCount: 2, duplicates: [],
    runState: "stopped_parser_divergence", parserVisits: ledgerOf(good, { A: 2 }) });
  check("M9d a case parsed twice makes the run incomplete", r2.accountingVerdict, "incomplete");
  checkTrue("M9e and it says which case and how many times",
    (r2.accountingDetail ?? "").includes("A x2"), r2.accountingDetail ?? "");

  // (3) a fabricated stop state with nothing actually diverged
  const noDivergence = [base, { ...base, id: "B" }];
  const r3 = accountFor({ list: noDivergence, entryCount: 2, duplicates: [],
    runState: "stopped_parser_divergence", parserVisits: ledgerOf(noDivergence) });
  check("M9f a stop with no recorded divergence makes the run incomplete", r3.accountingVerdict, "incomplete");
  checkTrue("M9g and it says the stop is unexplained",
    (r3.accountingDetail ?? "").includes("no parser divergence was recorded"), r3.accountingDetail ?? "");

  // (4) a divergence followed by one predicate execution
  const leaked = [{ ...base, predicateAgreement: "agreed" as PredicateAgreement,
    caseVerdict: "conformant" as const }, divergedCase];
  const r4 = accountFor({ list: leaked, entryCount: 2, duplicates: [],
    runState: "stopped_parser_divergence", parserVisits: ledgerOf(leaked) });
  check("M9h a predicate that ran after the stop makes the run incomplete", r4.accountingVerdict, "incomplete");
  checkTrue("M9i and it says the stop did not stop anything",
    (r4.accountingDetail ?? "").includes("executed anyway"), r4.accountingDetail ?? "");

  // A skipped parser case in a COMPLETED run is equally a defect - checking only the stopped
  // branch would leave the ordinary path able to hide one.
  const completedSkip = [{ ...base, predicateAgreement: "agreed" as PredicateAgreement,
    parserExecution: "not_run" as ParserExecution, caseVerdict: "conformant" as const }];
  check("M9j a skipped parser case is a defect in a COMPLETED run too",
    accountFor({ list: completedSkip, entryCount: 1, duplicates: [], runState: "completed",
      parserVisits: {} }).accountingVerdict, "incomplete");

  // A ledger entry for a case that does not exist is a defect in the ledger itself.
  const r5 = accountFor({ list: good, entryCount: 2, duplicates: [],
    runState: "stopped_parser_divergence", parserVisits: ledgerOf(good, { GHOST: 1 }) });
  check("M9k a ledger entry for an unknown case makes the run incomplete", r5.accountingVerdict, "incomplete");
  checkTrue("M9l and it names the ghost",
    (r5.accountingDetail ?? "").includes("GHOST"), r5.accountingDetail ?? "");
}

// ── M2 — duplicate case ids ─────────────────────────────────────────────────────────────────
console.log("\nM2 — duplicate case ids");
{
  const dup = [applying("A1"), applying("A1"), notApplying("A2")];
  const r = executeFrozenCases({ cases: dup, observe: honestObserve, buildContract: honestParser });
  check("M2  a duplicated id makes the run incomplete", r.accountingVerdict, "incomplete");
  checkTrue("M2b the duplicate is named", (r.accountingDetail ?? "").includes("duplicate case ids: A1"),
    r.accountingDetail ?? "");
  check("M2c the duplicate does not inflate the conformant count", r.verdictCounts.conformant, 2);
}

// ── M3 — a substituted expectation is caught, not absorbed ──────────────────────────────────
console.log("\nM3 — substituted expected fields");
{
  const swap = (mutate: (c: any[]) => void) => {
    const cs = JSON.parse(JSON.stringify(CASES)); mutate(cs);
    return executeFrozenCases({ cases: cs, observe: honestObserve, buildContract: honestParser });
  };
  const r1 = swap((c) => { c[0].expected_outcome.reason = "unsupported_capability"; });
  check("M3  a substituted expected REASON is nonconformant, not conformant",
    [r1.verdictCounts.conformant, r1.verdictCounts.nonconformant, r1.evidenceVerdict],
    [2, 1, "nonconformant"]);
  checkTrue("M3b the disagreement names the field",
    (r1.results.find((x) => x.id === "A1")?.predicateDetail ?? "").includes("reason:"));

  check("M3c a substituted expected ACTION is nonconformant",
    swap((c) => { c[0].expected_outcome.action = "answer_delivered"; }).verdictCounts.nonconformant, 1);
  check("M3d a substituted expected APPLICABILITY is nonconformant",
    swap((c) => { c[1].expected_outcome.applies = true; }).verdictCounts.nonconformant, 1);

  const stray = executeFrozenCases({
    cases: [notApplying("A2")],
    observe: () => ({ inDenominator: true, state: "did_not_fire", action: "decline_capability", reason: "query_contract_failed" }),
    buildContract: honestParser,
  });
  check("M3e a typed pair on a non-applying case is nonconformant", stray.verdictCounts.nonconformant, 1);
}

// ── M4 — a parser divergence is never missed, never absorbed, and STOPS the run ─────────────
console.log("\nM4 — parser divergence stops the run");
{
  const drifted = executeFrozenCases({
    cases: CASES, observe: honestObserve,
    buildContract: (c) => (c.expected_contract ? { metric: { topic: "robbery" } } : null),
  });
  check("M4  a parser disagreeing with the frozen projection is recorded as disagreeing",
    drifted.parserCounts.disagreed, 2);
  checkTrue("M4b the disagreement carries both values",
    (drifted.results[0].parserDetail ?? "").includes('parser="robbery"') &&
    (drifted.results[0].parserDetail ?? "").includes('frozen="murder"'));
  check("M4c the run STOPS: no predicate is evaluated",
    [drifted.runState, drifted.predicateCounts.not_run, drifted.predicateCounts.agreed],
    ["stopped_parser_divergence", 3, 0]);
  check("M4d a stopped run still accounts completely, but establishes nothing",
    [drifted.accountingVerdict, drifted.evidenceVerdict], ["complete", "nonconformant"]);
  checkTrue("M4e the report says the run stopped and why",
    (drifted.evidenceDetail ?? "").includes("stopped"), drifted.evidenceDetail ?? "");
  check("M4f no case is conformant when the parser diverged", drifted.verdictCounts.conformant, 0);

  const missing = executeFrozenCases({
    cases: CASES, observe: honestObserve, buildContract: () => null,
  });
  check("M4g a parser returning nothing for a projected case diverges and stops",
    [missing.parserCounts.disagreed, missing.runState], [2, "stopped_parser_divergence"]);

  const thrown = executeFrozenCases({
    cases: CASES, observe: honestObserve,
    buildContract: () => { throw new Error("parser exploded"); },
  });
  check("M4h a throwing parser is its own state and also stops the run",
    [thrown.parserCounts.parser_error, thrown.runState, thrown.evidenceVerdict],
    [3, "stopped_parser_divergence", "nonconformant"]);
  check("M4i and no case is conformant", thrown.verdictCounts.conformant, 0);
  check("M4j a throwing parser still counts as VISITED, on the execution axis",
    [thrown.parserExecutionCounts.error, thrown.parserExecutionCounts.not_run,
     Object.values(thrown.parserVisits).every((n) => n === 1)],
    [3, 0, true]);
  check("M4k a stopped run still visited every case exactly once",
    drifted.parserVisits, { A1: 1, A2: 1, A3: 1 });
}

// ── M5 — analysis_incomplete never collapses into anything else ─────────────────────────────
console.log("\nM5 — incomplete is not a clean negative and not a failure");
{
  const r = executeFrozenCases({
    cases: [notApplying("A2")],
    observe: () => ({ inDenominator: true, state: "analysis_incomplete", action: null, reason: null }),
    buildContract: honestParser,
  });
  check("M5  an unmeasurable non-applying case is analysis_incomplete, NOT agreed",
    [r.predicateCounts.agreed, r.predicateCounts.analysis_incomplete], [0, 1]);
  check("M5b its verdict is not_established - neither a pass nor a system failure",
    [r.verdictCounts.conformant, r.verdictCounts.nonconformant, r.verdictCounts.not_established],
    [0, 0, 1]);
  check("M5c the run accounts completely but establishes no evidence",
    [r.accountingVerdict, r.evidenceVerdict], ["complete", "not_established"]);

  const baseline = executeFrozenCases({
    cases: [notApplying("A2")],
    observe: () => ({ inDenominator: true, state: "did_not_fire", action: null, reason: null }),
    buildContract: honestParser,
  });
  check("M5d the same case IS conformant when the predicate is measurable",
    [baseline.verdictCounts.conformant, baseline.evidenceVerdict], [1, "conformant"]);

  const broken = executeFrozenCases({
    cases: [applying("A1")],
    observe: () => { throw new Error("observer exploded"); },
    buildContract: honestParser,
  });
  check("M5e a harness throw is harness_error and establishes nothing",
    [broken.predicateCounts.harness_error, broken.verdictCounts.conformant, broken.evidenceVerdict],
    [1, 0, "not_established"]);
}

// ── M6 — a rule outside the denominator is not agreement by absence ─────────────────────────
console.log("\nM6 — absence is not agreement");
{
  const absent = executeFrozenCases({
    cases: [applying("A1")],
    observe: () => ({ inDenominator: false, state: null, action: null, reason: null }),
    buildContract: honestParser,
  });
  check("M6  an applying case whose rule never entered the denominator is nonconformant",
    [absent.verdictCounts.nonconformant, absent.verdictCounts.conformant], [1, 0]);
}

// ── M7 — the verdict derivation itself, exhaustively ────────────────────────────────────────
console.log("\nM7 — verdict derivation");
{
  const P: PredicateAgreement[] = ["not_run", "agreed", "disagreed", "analysis_incomplete", "harness_error"];
  const A: ParserAgreement[] = ["agreed", "disagreed", "not_applicable", "parser_error"];
  const table = P.flatMap((p) => A.map((a) => `${p}/${a}=${deriveCaseVerdict(p, a)}`));

  check("M7  a parser divergence is nonconformant regardless of the predicate axis",
    P.every((p) => deriveCaseVerdict(p, "disagreed") === "nonconformant" &&
                   deriveCaseVerdict(p, "parser_error") === "nonconformant"),
    true);
  check("M7b conformant requires BOTH axes clean",
    [deriveCaseVerdict("agreed", "agreed"), deriveCaseVerdict("agreed", "not_applicable"),
     deriveCaseVerdict("agreed", "disagreed"), deriveCaseVerdict("agreed", "parser_error")],
    ["conformant", "conformant", "nonconformant", "nonconformant"]);
  check("M7c un-run and unmeasurable never reach conformant",
    ["not_run", "analysis_incomplete", "harness_error"]
      .map((p) => deriveCaseVerdict(p as PredicateAgreement, "agreed")),
    ["not_established", "not_established", "not_established"]);
  check("M7d every combination is covered and none is undefined",
    [table.length, table.every((t) => /=(conformant|nonconformant|not_established)$/.test(t))],
    [20, true]);
}

// ── M8 — the frozen projection helper does not mutate its shell ─────────────────────────────
console.log("\nM8 — projection purity");
{
  const beforeShell = JSON.stringify(CONTRACT_SHELL);
  const projected: any = projectFrozenContract(CONTRACT_SHELL, "shr", { "metric.topic": "robbery" });
  check("M8  the projection applies to the copy", [projected.source, projected.metric.topic], ["shr", "robbery"]);
  check("M8b and the shared shell is untouched", JSON.stringify(CONTRACT_SHELL), beforeShell);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
