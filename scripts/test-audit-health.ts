// Tests for lib/audit-health.ts — proving a check suite actually ran.
// Run: npx tsx scripts/test-audit-health.ts
//
// These tests encode two real production failures so they cannot recur silently:
//   - D6 reported "0 flagged" for weeks against a 0-byte reference database.
//   - chart_audit_results stayed empty with 24 artifacts and 15 receipts present,
//     because the runner's production schedule was weekly, not nightly.
// Both looked like clean results. The assertions below make that impossible.
import assert from "node:assert/strict";
import {
  assertCleanReportPermitted,
  createAccounting,
  describeAuditHealth,
  evaluateAuditHealth,
  type AuditAccounting,
} from "../lib/audit-health";

function healthyRun(): AuditAccounting {
  const accounting = createAccounting("phase1-detector", "phase1-2026-08-05", 1_000);
  accounting.expected = 10;
  accounting.eligible = 10;
  accounting.executed = 10;
  accounting.finishedAt = 2_000;
  accounting.requiredInputs = [{ name: "query_log", locator: "/tmp/query_log.db", present: true, detail: null }];
  return accounting;
}

// Baseline: a complete run is healthy and may report cleanly.
{
  const accounting = healthyRun();
  const verdict = evaluateAuditHealth(accounting);
  assert.equal(verdict.state, "healthy");
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.cleanReportPermitted, true);
  assert.doesNotThrow(() => assertCleanReportPermitted(accounting, verdict));
  assert.match(describeAuditHealth(accounting, verdict), /healthy/);
}

// THE D6 CASE. Work was expected, nothing executed. Zero findings here is not
// an all-clear, and the suite must refuse to report one.
{
  const accounting = healthyRun();
  accounting.executed = 0;
  accounting.skipped = Array.from({ length: 10 }, (_, i) => ({ id: `row-${i}`, reason: "missing_reference_data" }));
  const verdict = evaluateAuditHealth(accounting);
  assert.equal(verdict.state, "incomplete");
  assert.equal(verdict.cleanReportPermitted, false, "zero executed can never be clean");
  assert.ok(verdict.reasons.some((reason) => /0 executed/.test(reason)));
  assert.throws(() => assertCleanReportPermitted(accounting, verdict), /Refusing to report a clean result/);
  // The summary line must carry the health context, never a bare zero.
  assert.match(describeAuditHealth(accounting, verdict), /INCOMPLETE/);
}

// A missing required input invalidates the run outright. Presence is checked
// separately from usefulness: see the 0-byte case below.
{
  const accounting = healthyRun();
  accounting.requiredInputs = [
    { name: "query_log", locator: "/tmp/query_log.db", present: true, detail: null },
    { name: "shr_reference", locator: "/opt/nibrs/shr.db", present: false, detail: "file does not exist" },
  ];
  const verdict = evaluateAuditHealth(accounting);
  assert.equal(verdict.state, "invalid");
  assert.equal(verdict.cleanReportPermitted, false);
  assert.ok(verdict.reasons.some((reason) => /shr_reference/.test(reason)));
}

// The literal D6 shape: a file that exists but is a 0-byte stub. `present` must
// be false, with the detail explaining why, or the run reads as healthy again.
{
  const accounting = healthyRun();
  accounting.requiredInputs = [
    { name: "shr_reference", locator: "/opt/nibrs/shr.db", present: false, detail: "0 bytes" },
  ];
  const verdict = evaluateAuditHealth(accounting);
  assert.equal(verdict.state, "invalid");
  assert.ok(verdict.reasons.some((reason) => /0 bytes/.test(reason)));
}

// Reconciliation: every eligible unit must be accounted for exactly once.
{
  const lost = healthyRun();
  lost.executed = 7; // 3 units vanished with no skip or failure recorded
  const lostVerdict = evaluateAuditHealth(lost);
  assert.equal(lostVerdict.state, "invalid");
  assert.ok(lostVerdict.reasons.some((reason) => /does not reconcile/.test(reason)));

  const doubleCounted = healthyRun();
  doubleCounted.skipped = [{ id: "row-1", reason: "unsupported_shape" }];
  const doubleVerdict = evaluateAuditHealth(doubleCounted); // 10 executed + 1 skipped > 10 eligible
  assert.equal(doubleVerdict.state, "invalid");
  assert.ok(doubleVerdict.reasons.some((reason) => /does not reconcile/.test(reason)));

  // Reconciling with a mix of executed, skipped, and failed is healthy only when
  // the identity holds exactly.
  const mixed = healthyRun();
  mixed.executed = 7;
  mixed.skipped = [{ id: "a", reason: "unsupported_shape" }, { id: "b", reason: "unsupported_shape" }];
  mixed.failed = [{ id: "c", reason: "sqlite_error" }];
  const mixedVerdict = evaluateAuditHealth(mixed);
  assert.notEqual(mixedVerdict.state, "invalid", "a reconciling ledger is not invalid");
  assert.equal(mixedVerdict.cleanReportPermitted, false, "recorded failures still block a clean report");
}

// An unfinished run -- killed, timed out, or crashed -- is invalid regardless of
// how many items it managed to process. nightly-audit-and-digest.sh times the
// auditor out at 900s, so this state is reachable in production today.
{
  const accounting = healthyRun();
  accounting.finishedAt = null;
  const verdict = evaluateAuditHealth(accounting);
  assert.equal(verdict.state, "invalid");
  assert.ok(verdict.reasons.some((reason) => /never recorded a finish time/.test(reason)));
}

// SCOPE RECONCILIATION. Deliberate filtering is normal and must not make a run
// look unhealthy -- but it has to be individually accounted, or a filter that
// silently swallows real traffic is indistinguishable from one working as
// designed. Both identities are required:
//   expected = excluded + eligible
//   eligible = executed + skipped + failed
{
  // The ordinary case: a window of 20 rows, 10 of them internal replay traffic.
  const filtered = healthyRun();
  filtered.expected = 20;
  filtered.excluded = Array.from({ length: 10 }, (_, i) => ({ id: `replay-${i}`, reason: "internal_session" }));
  filtered.eligible = 10;
  filtered.executed = 10;
  const filteredVerdict = evaluateAuditHealth(filtered);
  assert.equal(filteredVerdict.state, "healthy", "fully accounted filtering is healthy");
  assert.equal(filteredVerdict.cleanReportPermitted, true);
  assert.match(describeAuditHealth(filtered, filteredVerdict), /excluded=10/);

  // An unexplained gap between expected and eligible is the silent-coverage-loss
  // shape and must be invalid, not merely incomplete.
  const unexplained = healthyRun();
  unexplained.expected = 20;
  unexplained.eligible = 10;
  unexplained.executed = 10;
  const unexplainedVerdict = evaluateAuditHealth(unexplained);
  assert.equal(unexplainedVerdict.state, "invalid");
  assert.ok(unexplainedVerdict.reasons.some((reason) => /scope does not reconcile/.test(reason)));

  const impossible = healthyRun();
  impossible.expected = 5; // eligible 10 > expected 5
  const impossibleVerdict = evaluateAuditHealth(impossible);
  assert.equal(impossibleVerdict.state, "invalid");
  assert.ok(impossibleVerdict.reasons.some((reason) => /scope does not reconcile/.test(reason)));
}

// Everything filtered out. Executing zero is correct here, and keying the D6
// rule on `eligible` rather than `expected` is what makes this healthy -- a
// window containing only replay traffic must not raise an alarm, or readers
// learn to ignore the alarm.
{
  const allFiltered = createAccounting("phase1-detector", "v1", 1_000);
  allFiltered.expected = 8;
  allFiltered.excluded = Array.from({ length: 8 }, (_, i) => ({ id: `canary-${i}`, reason: "internal_session" }));
  allFiltered.eligible = 0;
  allFiltered.executed = 0;
  allFiltered.finishedAt = 2_000;
  const verdict = evaluateAuditHealth(allFiltered);
  assert.equal(verdict.state, "healthy");
  assert.equal(verdict.cleanReportPermitted, true);

  // But eligible work that went unexecuted is still the D6 case. The skip keeps
  // the execution identity balanced, so this is `incomplete` (work was in scope
  // and none of it ran) rather than `invalid` (the ledger lost track of it).
  const eligibleButIdle: AuditAccounting = {
    ...allFiltered,
    excluded: allFiltered.excluded.slice(0, 7),
    eligible: 1,
    executed: 0,
    skipped: [{ id: "row-1", reason: "missing_reference_data" }],
  };
  const idleVerdict = evaluateAuditHealth(eligibleButIdle);
  assert.equal(idleVerdict.state, "incomplete");
  assert.equal(idleVerdict.cleanReportPermitted, false);
  assert.ok(idleVerdict.reasons.some((reason) => /0 executed/.test(reason)));
}

// A suite that saw nothing and did nothing is vacuously healthy -- the
// legitimate "no traffic at all" case.
{
  const idle = createAccounting("chart-audit", "v1", 1_000);
  idle.finishedAt = 2_000;
  const verdict = evaluateAuditHealth(idle);
  assert.equal(verdict.state, "healthy");
  assert.equal(verdict.cleanReportPermitted, true);
}

// Skipped eligible items block a clean report even when nothing failed: the
// suite intended to process them and did not.
{
  const skipped = healthyRun();
  skipped.executed = 9;
  skipped.skipped = [{ id: "row-9", reason: "unsupported_shape" }];
  const verdict = evaluateAuditHealth(skipped);
  assert.equal(verdict.state, "incomplete");
  assert.equal(verdict.cleanReportPermitted, false);
  assert.ok(verdict.reasons.some((reason) => /skipped/.test(reason)));
}

console.log("audit-health tests passed");
