/**
 * Audit-health accounting: proving that a check suite actually ran.
 *
 * Source of truth: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * Stage 0 ("explicit audit-health reporting: expected, eligible, executed,
 * skipped, failed, and reconciled counts") and section 13 ("expected = executed
 * + skipped + failed accounting, with every skipped/failed item represented").
 *
 * WHY THIS MODULE EXISTS. Two production incidents in this repository share one
 * shape, and this module is the generalization of the fix:
 *
 *   1. Detector D6 reported "0 flagged" for weeks while its reference database
 *      was a 0-byte stub. Zero findings was indistinguishable from a clean bill
 *      of health. getAuditorHealth() in scripts/daily-query-analysis.js was
 *      written afterwards to separate "did not run" from "ran and passed".
 *
 *   2. chart_audit_results sat empty in production with 24 artifacts and 15
 *      render receipts present, because the runner was only invoked from a
 *      script whose production schedule was weekly. Nothing reported the gap;
 *      the digest simply showed every chart as "unverified".
 *
 * In both cases the failure was silent because the suite reported findings
 * rather than reporting its own execution. An AuditAccounting makes execution a
 * first-class, reconciled, assertable fact.
 */

/** Why an eligible unit of work was not executed. */
export interface AuditSkip {
  /** Identifier of the item skipped -- a row id, a fixture name, a detector id. */
  id: string;
  /** Machine-readable cause, e.g. "missing_reference_data", "unsupported_shape". */
  reason: string;
}

/** A unit of work that was attempted and errored. Distinct from a check that ran and failed its assertion. */
export interface AuditFailure {
  id: string;
  reason: string;
}

/**
 * The execution ledger for one suite run.
 *
 * `expected` is what the suite intended to process, decided BEFORE processing
 * begins. Computing it afterwards from what happened would make the identity
 * below trivially true and therefore worthless.
 */
export interface AuditAccounting {
  suite: string;
  suiteVersion: string;
  expected: number;
  /** Of `expected`, those that passed the suite's own eligibility filter. */
  eligible: number;
  executed: number;
  skipped: AuditSkip[];
  failed: AuditFailure[];
  /** Inputs the suite required. A missing required input invalidates the run. */
  requiredInputs: AuditInput[];
  startedAt: number;
  finishedAt: number | null;
}

export interface AuditInput {
  name: string;
  /** e.g. a database path, a fixture directory. */
  locator: string;
  present: boolean;
  /** Non-null when presence alone is insufficient -- a 0-byte file is "present". */
  detail: string | null;
}

export type AuditHealthState = "healthy" | "incomplete" | "invalid";

export interface AuditHealthVerdict {
  state: AuditHealthState;
  /** Human-readable reasons, empty only when state is healthy. */
  reasons: string[];
  /** True only when a caller may report this run's findings as a clean result. */
  cleanReportPermitted: boolean;
}

export function createAccounting(suite: string, suiteVersion: string, startedAt: number): AuditAccounting {
  return {
    suite,
    suiteVersion,
    expected: 0,
    eligible: 0,
    executed: 0,
    skipped: [],
    failed: [],
    requiredInputs: [],
    startedAt,
    finishedAt: null,
  };
}

/**
 * Evaluate a run's health.
 *
 * The ordering of these rules matters. `invalid` outranks `incomplete` because a
 * run with a missing input never had the chance to be merely incomplete -- its
 * counts describe nothing.
 */
export function evaluateAuditHealth(accounting: AuditAccounting): AuditHealthVerdict {
  const reasons: string[] = [];
  let state: AuditHealthState = "healthy";

  const missingInputs = accounting.requiredInputs.filter((input) => !input.present);
  if (missingInputs.length > 0) {
    state = "invalid";
    for (const input of missingInputs) {
      reasons.push(`required input '${input.name}' is missing at ${input.locator}${input.detail ? ` (${input.detail})` : ""}`);
    }
  }

  if (accounting.finishedAt === null) {
    state = "invalid";
    reasons.push("run never recorded a finish time; it was killed, timed out, or crashed");
  }

  // The reconciliation identity. Every eligible unit must be accounted for
  // exactly once as executed, skipped, or failed. A mismatch means the suite
  // lost track of its own work, which disqualifies its findings entirely.
  const accountedFor = accounting.executed + accounting.skipped.length + accounting.failed.length;
  if (accountedFor !== accounting.eligible) {
    state = "invalid";
    reasons.push(
      `accounting does not reconcile: eligible=${accounting.eligible} but executed+skipped+failed=${accountedFor} ` +
        `(executed=${accounting.executed}, skipped=${accounting.skipped.length}, failed=${accounting.failed.length})`
    );
  }

  if (accounting.eligible > accounting.expected) {
    state = "invalid";
    reasons.push(`eligible=${accounting.eligible} exceeds expected=${accounting.expected}`);
  }

  // The D6 rule. A suite that intended to do work and executed none of it has
  // produced no evidence, regardless of how few findings it reported.
  if (accounting.expected > 0 && accounting.executed === 0) {
    if (state === "healthy") state = "incomplete";
    reasons.push(`expected ${accounting.expected} item(s) but executed 0; zero findings here is not an all-clear`);
  }

  if (accounting.failed.length > 0 && state === "healthy") {
    state = "incomplete";
    reasons.push(`${accounting.failed.length} item(s) failed to execute`);
  }

  if (accounting.eligible < accounting.expected && state === "healthy") {
    state = "incomplete";
    reasons.push(`${accounting.expected - accounting.eligible} expected item(s) were never eligible`);
  }

  return {
    state,
    reasons,
    // Deliberately requires state === "healthy" rather than state !== "invalid".
    // An incomplete run may still be worth reporting, but never as "clean".
    cleanReportPermitted: state === "healthy",
  };
}

/**
 * One-line summary for logs and the reviewer email.
 *
 * Never returns a bare zero. When a clean report is not permitted the string
 * says so, so that a count of 0 findings can never be pasted into a digest
 * without its health context.
 */
export function describeAuditHealth(accounting: AuditAccounting, verdict: AuditHealthVerdict): string {
  const base =
    `${accounting.suite}@${accounting.suiteVersion}: expected=${accounting.expected} eligible=${accounting.eligible} ` +
    `executed=${accounting.executed} skipped=${accounting.skipped.length} failed=${accounting.failed.length}`;
  if (verdict.cleanReportPermitted) return `${base} — healthy`;
  return `${base} — ${verdict.state.toUpperCase()}: ${verdict.reasons.join("; ")}`;
}

/**
 * Guard for callers about to report "nothing wrong found".
 *
 * Call sites should prefer this over inspecting `verdict.state` directly, so the
 * intent reads as a claim being checked rather than a status being branched on.
 */
export function assertCleanReportPermitted(accounting: AuditAccounting, verdict: AuditHealthVerdict): void {
  if (!verdict.cleanReportPermitted) {
    throw new Error(`Refusing to report a clean result. ${describeAuditHealth(accounting, verdict)}`);
  }
}
