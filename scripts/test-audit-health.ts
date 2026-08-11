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
  assert.ok(verdict.reasons.some((reason) => /executed 0/.test(reason)));
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

// eligible may be less than expected (a filter excluded some), but never more.
{
  const filtered = healthyRun();
  filtered.expected = 20;
  filtered.eligible = 10;
  const filteredVerdict = evaluateAuditHealth(filtered);
  assert.equal(filteredVerdict.state, "incomplete");
  assert.equal(filteredVerdict.cleanReportPermitted, false);

  const impossible = healthyRun();
  impossible.expected = 5;
  const impossibleVerdict = evaluateAuditHealth(impossible); // eligible 10 > expected 5
  assert.equal(impossibleVerdict.state, "invalid");
  assert.ok(impossibleVerdict.reasons.some((reason) => /exceeds expected/.test(reason)));
}

// A suite that expected nothing and did nothing is vacuously healthy. This is
// the legitimate "no traffic in the window" case, distinct from the D6 case
// above where work was expected.
{
  const idle = createAccounting("chart-audit", "v1", 1_000);
  idle.finishedAt = 2_000;
  const verdict = evaluateAuditHealth(idle);
  assert.equal(verdict.state, "healthy");
  assert.equal(verdict.cleanReportPermitted, true);
}

console.log("audit-health tests passed");
