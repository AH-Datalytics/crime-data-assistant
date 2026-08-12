#!/usr/bin/env npx tsx
/**
 * Rendered-chart correctness audit.
 *
 * Reads captured chart artifacts (and render receipts where the browser sent
 * one), scores each with lib/chart-audit, and upserts chart_audit_results.
 *
 * STAGE 0 CHANGE (2026-08-11). Two things were added without altering the audit
 * logic:
 *
 *   1. The body moved into an exported runChartAudit() with a thin CLI shim, so
 *      the pipeline can be exercised in-process by a test. The previous
 *      top-level-side-effect shape could only be tested by spawning a
 *      subprocess, which is why scripts/test-chart-audit.ts covered the scoring
 *      function while nothing covered the pipeline that invokes it.
 *
 *   2. Audit-health accounting (lib/audit-health) now reconciles expected,
 *      eligible, executed, skipped, and failed. In production on 2026-08-11
 *      this table held 24 artifacts and 15 receipts while chart_audit_results
 *      was empty, and nothing reported the gap -- the digest simply rendered
 *      every chart as "unverified". A run that processes nothing now says so
 *      instead of printing a zero that reads as a clean result.
 *
 * The scheduling defect that caused the empty table is fixed separately, in the
 * crontab entry documented in scripts/nightly-audit-and-digest.sh.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { auditChartArtifact, type ChartAuditArtifact, type ChartRenderReceipt } from "../lib/chart-audit";
import {
  createAccounting,
  describeAuditHealth,
  evaluateAuditHealth,
  type AuditAccounting,
  type AuditHealthVerdict,
} from "../lib/audit-health";

/** Bump when scoring changes in a way that invalidates stored results. */
export const CHART_AUDIT_SUITE_VERSION = "chart-audit-2026-08-11";

/**
 * Provenance label written to audit_runs.source. Must stay distinct from the
 * query auditor's 'phase1-detector' so the digest can read each auditor's health
 * independently; scripts/daily-query-analysis.js imports this value's literal
 * form and scripts/test-chart-audit-pipeline.ts asserts they do not collide.
 */
export const CHART_AUDIT_SOURCE = "chart-audit";

export function resolveDbPath(argument?: string): string {
  const candidates = [argument, process.env.QUERY_LOG_DB_PATH, path.join(process.cwd(), "query_log.db"), "/opt/nibrs/shared/query_log.db"]
    .filter(Boolean) as string[];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`No query_log.db found. Checked: ${candidates.join(", ")}`);
  return path.resolve(found);
}

export interface ChartAuditCounts {
  total: number;
  verified: number;
  incorrect: number;
  needsReview: number;
  unverified: number;
}

export interface ChartAuditRun {
  counts: ChartAuditCounts;
  accounting: AuditAccounting;
  verdict: AuditHealthVerdict;
}

export function runChartAudit(dbPathArgument?: string): ChartAuditRun {
  const db = new Database(resolveDbPath(dbPathArgument));
  const accounting = createAccounting("chart-audit", CHART_AUDIT_SUITE_VERSION, Date.now());
  // Claim a 'running' row BEFORE any work. Writing the record only on
  // completion or a caught error means a timeout or SIGKILL leaves no evidence
  // the auditor ran at all -- and the wrapper does bound this suite
  // (CHART_AUDIT_TIMEOUT_SECONDS=300, escalating to SIGKILL), so that is a
  // reachable state, not a hypothetical. A row stuck at 'running' is exactly the
  // signal the digest needs: it ran, and it did not finish.
  const runId = beginAuditRun(db, accounting);
  pauseForInterruptionTest();
  try {
    const hasResults = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chart_audit_results'").get();
    // Recorded as a missing required input rather than thrown, so a caller that
    // catches this still cannot report the run as clean.
    accounting.requiredInputs = [
      {
        name: "chart_audit_results",
        locator: resolveDbPath(dbPathArgument),
        present: Boolean(hasResults),
        detail: hasResults ? null : "table absent; run scripts/migrate-chart-audit-artifacts.js",
      },
    ];
    if (!hasResults) throw new Error("Chart audit schema is not installed. Run scripts/migrate-chart-audit-artifacts.js first.");

    const rows = db.prepare(`
      SELECT a.*, COALESCE(a.query_log_id, q.id) AS joined_query_log_id, q.question, r.receipt_json
      FROM chart_audit_artifacts a
      LEFT JOIN query_log q ON q.request_id = a.request_id
      LEFT JOIN chart_render_receipts r ON r.request_id = a.request_id
      ORDER BY a.created_at
    `).all() as Array<Record<string, unknown>>;

    accounting.expected = rows.length;
    // The runner audits every captured artifact; nothing is filtered out of
    // scope here. Recorded explicitly so the expected = excluded + eligible
    // identity holds rather than being satisfied by omission.
    accounting.excluded = [];
    accounting.eligible = rows.length;

    const upsert = db.prepare(`INSERT INTO chart_audit_results
      (request_id, query_log_id, audited_at, status, summary, findings_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET query_log_id=excluded.query_log_id,
        audited_at=excluded.audited_at, status=excluded.status, summary=excluded.summary,
        findings_json=excluded.findings_json`);
    const findingTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_findings'").get());
    const findingColumns = findingTable
      ? new Set((db.prepare("PRAGMA table_info(audit_findings)").all() as Array<{ name: string }>).map((column) => column.name))
      : new Set<string>();

    const run = db.transaction(() => {
      const counts: ChartAuditCounts = { total: 0, verified: 0, incorrect: 0, needsReview: 0, unverified: 0 };
      for (const row of rows) {
        const requestId = String(row.request_id);
        try {
          const artifact: ChartAuditArtifact = {
            requestId, source: row.source as ChartAuditArtifact["source"], createdAt: Number(row.created_at),
            chartConfig: JSON.parse(String(row.chart_config)), columns: JSON.parse(String(row.columns_json)), rows: JSON.parse(String(row.data_json)),
            rowCount: Number(row.row_count), columnCount: Number(row.column_count), capturedRowCount: Number(row.captured_row_count),
            capturedColumnCount: Number(row.captured_column_count), dataHash: String(row.data_hash), truncated: Boolean(row.truncated),
            truncationReason: row.truncation_reason ? String(row.truncation_reason) : null,
          };
          const receipt = row.receipt_json ? JSON.parse(String(row.receipt_json)) as ChartRenderReceipt : null;
          const result = auditChartArtifact(String(row.question || ""), artifact, receipt);
          const queryLogId = row.joined_query_log_id == null ? null : Number(row.joined_query_log_id);
          upsert.run(artifact.requestId, queryLogId, Date.now(), result.status, result.summary, JSON.stringify(result.findings));
          counts.total++;
          accounting.executed++;
          if (result.status === "verified-rendered") counts.verified++;
          else if (result.status === "incorrect") counts.incorrect++;
          else if (result.status === "needs-review") counts.needsReview++;
          else counts.unverified++;

          if (findingTable && queryLogId !== null && findingColumns.has("source")) {
            db.prepare("DELETE FROM audit_findings WHERE query_log_id = ? AND source = 'chart-audit'").run(queryLogId);
            if (result.status === "incorrect" || result.status === "needs-review") {
              db.prepare(`INSERT OR REPLACE INTO audit_findings (query_log_id, ts, severity, category, finding, source)
                VALUES (?, ?, ?, ?, ?, ?)`)
                .run(queryLogId, Date.now(), result.status === "incorrect" ? "high" : "medium", `chart-${result.status}`, result.summary, "chart-audit");
            }
          }
        } catch (error) {
          // One malformed artifact must not abort the batch or silently vanish;
          // it is recorded so the reconciliation identity still holds.
          accounting.failed.push({ id: requestId, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return counts;
    });

    const counts = run();
    accounting.finishedAt = Date.now();
    const verdict = evaluateAuditHealth(accounting);
    const recorded = finishAuditRun(db, runId, accounting, verdict);
    if (!recorded && verdict.cleanReportPermitted) {
      // Health that was not written is health nobody can read. Reporting a clean
      // run whose record failed to persist would recreate the exact blind spot
      // this suite exists to close, so the in-memory verdict is downgraded to
      // match what a reviewer will actually see.
      const downgraded: AuditHealthVerdict = {
        state: "incomplete",
        reasons: [...verdict.reasons, "audit_runs health record could not be written; this run is not verifiable"],
        cleanReportPermitted: false,
      };
      return { counts, accounting, verdict: downgraded };
    }
    return { counts, accounting, verdict };
  } catch (error) {
    // A run that dies inside this function must still leave a record, or the
    // digest cannot distinguish "the chart auditor found nothing" from "the
    // chart auditor never got there". finishedAt stays null, which
    // evaluateAuditHealth reports invalid.
    const verdict = evaluateAuditHealth(accounting);
    finishAuditRun(db, runId, accounting, verdict, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    db.close();
  }
}

/**
 * Test hook: block after the run row is claimed but before any auditing.
 *
 * Exists so scripts/test-stage0-operational-guards.ts can kill THIS process at
 * the exact point a production timeout would kill it, and then assert the real
 * row is still 'running'. Without a hook the test could only insert a row by
 * hand, which proves the schema allows that state rather than that this code
 * reaches it.
 *
 * Blocks synchronously via Atomics.wait rather than an async timer: the point is
 * to hold the process in a killable state with the claim already committed, and
 * a synchronous block cannot be skipped by the event loop draining first.
 * Inert unless CHART_AUDIT_TEST_PAUSE_MS is set to a positive number, and capped
 * so a stray environment variable cannot wedge a production run.
 */
function pauseForInterruptionTest(): void {
  const raw = process.env.CHART_AUDIT_TEST_PAUSE_MS;
  if (!raw) return;
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) return;
  const ms = Math.min(requested, 30_000);
  console.log(`[run-chart-audit] TEST PAUSE ${ms}ms after claiming the run row`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Claim a 'running' row in audit_runs before any auditing happens.
 *
 * Returns the row id, or null when the table is absent or the insert failed.
 * A null id does not stop the run, but finishAuditRun() then reports that
 * nothing was recorded and the caller downgrades a clean verdict accordingly.
 *
 * A row left at 'running' -- because the process was killed between here and
 * completion -- is a deliberate, readable signal: the auditor started and did
 * not finish. The wrapper bounds this suite at CHART_AUDIT_TIMEOUT_SECONDS=300
 * and escalates to SIGKILL, so that is a reachable state.
 */
function beginAuditRun(db: Database.Database, accounting: AuditAccounting): number | null {
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_runs'").get();
    if (!exists) return null;
    const result = db
      .prepare(
        `INSERT INTO audit_runs (source, suite_version, started_ts, finished_ts, from_log_id, to_log_id, rows_audited, findings_written, status, detail)
         VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'running', ?)`
      )
      .run(CHART_AUDIT_SOURCE, accounting.suiteVersion, accounting.startedAt, "run started; not yet finished");
    return Number(result.lastInsertRowid);
  } catch (error) {
    console.warn("[run-chart-audit] could not claim an audit_runs row:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Complete the claimed run record. Returns true when health was durably written.
 *
 * The digest reads health from this table, not from the runner's stdout, so a
 * verdict computed only in memory is a verdict nobody sees. The caller treats a
 * false return as disqualifying for a clean report.
 */
function finishAuditRun(
  db: Database.Database,
  runId: number | null,
  accounting: AuditAccounting,
  verdict: AuditHealthVerdict,
  fatalError?: string
): boolean {
  if (runId === null) return false;
  try {
    const detail = [
      describeAuditHealth(accounting, verdict),
      fatalError ? `fatal: ${fatalError}` : null,
      accounting.failed.length ? `failed: ${accounting.failed.map((item) => `${item.id} (${item.reason})`).join("; ")}` : null,
      accounting.skipped.length ? `skipped: ${accounting.skipped.map((item) => `${item.id} (${item.reason})`).join("; ")}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    // 'ok' only when a clean report is permitted; anything else must not read as
    // a healthy run to the digest.
    const status = fatalError ? "error" : verdict.cleanReportPermitted ? "ok" : verdict.state;
    const result = db
      .prepare("UPDATE audit_runs SET finished_ts = ?, rows_audited = ?, status = ?, detail = ? WHERE id = ?")
      .run(accounting.finishedAt, accounting.executed, status, detail.slice(0, 2000), runId);
    return result.changes === 1;
  } catch (error) {
    console.warn("[run-chart-audit] could not record audit_runs health:", error instanceof Error ? error.message : error);
    return false;
  }
}

/** CLI entry point, invoked by scripts/nightly-audit-and-digest.sh. */
function main(): void {
  const { counts, accounting, verdict } = runChartAudit(process.argv[2]);
  // `counts.total` is the number of artifacts actually SCORED, which is not the
  // same as the number eligible: a malformed artifact is eligible but lands in
  // accounting.failed instead. Labelling scored rows "eligible" hid exactly the
  // discrepancy this suite is meant to expose, so the two are now printed
  // separately and the health line carries the full ledger.
  console.log(
    `Chart audit: scored ${counts.total} of ${accounting.eligible} eligible = ${counts.verified} verified + ` +
      `${counts.incorrect} incorrect + ${counts.needsReview} needs-review + ${counts.unverified} unverified`
  );
  console.log(describeAuditHealth(accounting, verdict));
  // Any run that may not be reported as clean exits non-zero -- incomplete as
  // well as invalid. A malformed artifact that leaves findings unwritten is not
  // a successful run just because the process reached the end. The nightly
  // wrapper treats a non-zero chart-audit exit as advisory and continues to the
  // digest, which now reads the persisted health rather than this stdout.
  if (!verdict.cleanReportPermitted) process.exitCode = 1;
}

if (require.main === module) main();
