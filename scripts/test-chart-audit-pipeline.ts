// End-to-end test for the chart-audit pipeline: artifacts + receipts must
// produce chart_audit_results.
// Run: npx tsx scripts/test-chart-audit-pipeline.ts
//
// WHY THIS EXISTS. In production on 2026-08-11 the chart chain held 24
// artifacts and 15 render receipts while chart_audit_results was empty. The
// unit tests in scripts/test-chart-audit.ts covered auditChartArtifact() and
// passed throughout, because the defect was not in the audit logic -- the
// runner had simply never executed against those artifacts. A test of the
// scoring function cannot catch a pipeline that is never invoked, so this test
// drives the real runner as a subprocess against a production-shaped fixture
// database and asserts that rows land in the results table.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { buildChartAuditArtifact, type ChartRenderReceipt } from "../lib/chart-audit";
import { runChartAudit } from "./run-chart-audit";

const repoRoot = path.resolve(__dirname, "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-audit-pipeline-"));
const dbPath = path.join(workDir, "query_log.db");
/**
 * The migration is a standalone node script, so it is still spawned. tsx is not
 * a local dependency, which is why the audit itself is exercised in-process via
 * runChartAudit() rather than through `npx tsx` -- spawning that on Windows
 * requires `shell: true`, which concatenates rather than escapes arguments and
 * breaks on a temp path containing a space (os.tmpdir() under a user profile
 * with a space in the name).
 */
const migrationScript = path.join(repoRoot, "scripts", "migrate-chart-audit-artifacts.js");

try {
  // A minimal query_log, then the real migration -- so a schema drift in the
  // migration surfaces here rather than in production.
  {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, question TEXT, sql TEXT, rows INTEGER,
      error TEXT, ms INTEGER, response TEXT, tab TEXT, guardrails TEXT, model TEXT, session_id TEXT);
      CREATE TABLE audit_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, query_log_id INTEGER NOT NULL, ts INTEGER NOT NULL,
        severity TEXT NOT NULL, category TEXT NOT NULL, finding TEXT NOT NULL, proposed_fix TEXT,
        status TEXT DEFAULT 'open', source TEXT NOT NULL DEFAULT 'legacy');
      CREATE UNIQUE INDEX idx_audit_findings_unique_v2 ON audit_findings (query_log_id, category, source);`);
    db.close();
  }

  execFileSync(process.execPath, [migrationScript, dbPath], { cwd: repoRoot, stdio: "pipe" });

  const db = new Database(dbPath);
  for (const table of ["chart_audit_artifacts", "chart_render_receipts", "chart_audit_results"]) {
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
      `${table} must exist after migration`
    );
  }

  // Two production-shaped artifacts: one joined to a query_log row via
  // request_id (the normal case) and one orphaned (a chart captured for a row
  // that was never logged). Both must produce a result row; the orphan is the
  // case most likely to be silently dropped by a JOIN.
  const joinedRequestId = "req-joined-0001";
  const orphanRequestId = "req-orphan-0002";

  db.prepare(
    "INSERT INTO query_log (ts, question, sql, rows, ms, response, tab, model, request_id) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(
    Date.now(),
    "Show murder clearances by type in Las Vegas in 2025",
    "SELECT clearance_outcome, count FROM x",
    3,
    1200,
    "Explanation",
    "nibrs",
    "haiku-4.5",
    joinedRequestId
  );

  const rows = [
    { clearance_outcome: "Cleared by arrest", count: 62 },
    { clearance_outcome: "Death of offender", count: 11 },
    { clearance_outcome: "Not cleared", count: 9 },
  ];
  const insertArtifact = db.prepare(`INSERT INTO chart_audit_artifacts
    (request_id, query_log_id, source, created_at, chart_config, columns_json, data_json, row_count,
     column_count, captured_row_count, captured_column_count, data_hash, truncated, truncation_reason)
    VALUES (@requestId, NULL, @source, @createdAt, @chartConfig, @columnsJson, @dataJson, @rowCount,
     @columnCount, @capturedRowCount, @capturedColumnCount, @dataHash, @truncated, @truncationReason)`);

  for (const requestId of [joinedRequestId, orphanRequestId]) {
    const artifact = buildChartAuditArtifact({
      requestId,
      source: "nibrs",
      chartConfig: { type: "bar", xAxis: "clearance_outcome", yAxis: ["count"], title: "Las Vegas murder clearances by type, 2025" },
      columns: ["clearance_outcome", "count"],
      rows,
    });
    insertArtifact.run({
      requestId: artifact.requestId,
      source: artifact.source,
      createdAt: artifact.createdAt,
      chartConfig: JSON.stringify(artifact.chartConfig),
      columnsJson: JSON.stringify(artifact.columns),
      dataJson: JSON.stringify(artifact.rows),
      rowCount: artifact.rowCount,
      columnCount: artifact.columnCount,
      capturedRowCount: artifact.capturedRowCount,
      capturedColumnCount: artifact.capturedColumnCount,
      dataHash: artifact.dataHash,
      truncated: artifact.truncated ? 1 : 0,
      truncationReason: artifact.truncationReason,
    });
  }

  // A render receipt for the joined artifact only, so the run exercises both the
  // rendered and unrendered branches in one pass.
  const receipt: ChartRenderReceipt = {
    requestId: joinedRequestId,
    component: "NibrsChartPanel",
    chartType: "bar",
    effectiveXKey: "clearance_outcome",
    effectiveYKeys: ["count"],
    lineCount: 0,
    barCount: 3,
    pointCount: 0,
    areaCount: 0,
    legendLabels: [],
    xTickLabels: rows.map((row) => row.clearance_outcome),
    yTickLabels: ["0", "20", "40", "60"],
    svgWidth: 800,
    svgHeight: 400,
    overflow: false,
    zeroSize: false,
    invalidText: false,
    renderError: false,
    viewportClass: "desktop",
    renderedAt: Date.now(),
  };
  db.prepare("INSERT INTO chart_render_receipts (request_id, received_at, receipt_json) VALUES (?,?,?)").run(
    receipt.requestId,
    Date.now(),
    JSON.stringify(receipt)
  );

  const artifactCount = (db.prepare("SELECT COUNT(*) AS n FROM chart_audit_artifacts").get() as { n: number }).n;
  const receiptCount = (db.prepare("SELECT COUNT(*) AS n FROM chart_render_receipts").get() as { n: number }).n;
  assert.equal(artifactCount, 2);
  assert.equal(receiptCount, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM chart_audit_results").get() as { n: number }).n,
    0,
    "results must start empty so the assertion below proves the runner wrote them"
  );
  db.close();

  // Drive the real runner exactly as cron does, passing the db path as argv[2].
  // Invoked through the local tsx binary rather than `npx ... shell:true`, which
  // concatenates rather than escapes its arguments -- a temp path containing a
  // space would break the command.
  const first = runChartAudit(dbPath);
  assert.equal(first.counts.total, 2, "both artifacts must be scored");
  assert.equal(first.accounting.executed, 2);
  assert.equal(first.accounting.failed.length, 0);
  assert.equal(first.verdict.state, "healthy", "a complete run must be healthy");
  assert.equal(first.verdict.cleanReportPermitted, true);

  const verify = new Database(dbPath, { readonly: true });
  const results = verify.prepare("SELECT request_id, query_log_id, status FROM chart_audit_results ORDER BY request_id").all() as Array<{
    request_id: string;
    query_log_id: number | null;
    status: string;
  }>;

  // The core assertion: artifacts + receipts produce results.
  assert.equal(results.length, 2, "every artifact must produce a chart_audit_results row");

  const byRequest = new Map(results.map((row) => [row.request_id, row]));
  const joined = byRequest.get(joinedRequestId);
  const orphan = byRequest.get(orphanRequestId);
  assert.ok(joined, "joined artifact must have a result");
  assert.ok(orphan, "orphaned artifact must have a result, not be dropped by the join");

  // The receipt-backed artifact reaches a rendered verdict; the one without a
  // receipt cannot, and must say so rather than defaulting to a pass.
  assert.equal(joined!.status, "verified-rendered");
  assert.equal(joined!.query_log_id, 1, "request_id join to query_log must resolve");
  assert.equal(orphan!.status, "unverified", "no receipt means unverified, never verified");
  assert.equal(orphan!.query_log_id, null);
  verify.close();

  // Idempotence: cron may run the suite repeatedly over the same artifacts.
  runChartAudit(dbPath);
  const rerun = new Database(dbPath, { readonly: true });
  assert.equal(
    (rerun.prepare("SELECT COUNT(*) AS n FROM chart_audit_results").get() as { n: number }).n,
    2,
    "a second run must upsert, not duplicate"
  );
  rerun.close();
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

console.log("chart-audit pipeline tests passed");
