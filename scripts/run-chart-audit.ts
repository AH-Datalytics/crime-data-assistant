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
    persistAuditRun(db, accounting, verdict);
    return { counts, accounting, verdict };
  } catch (error) {
    // A run that dies before finishing must still leave a record, or the digest
    // cannot distinguish "the chart auditor found nothing" from "the chart
    // auditor never got there" -- the precise ambiguity this suite exists to
    // remove. finishedAt stays null, which evaluateAuditHealth reports invalid.
    const verdict = evaluateAuditHealth(accounting);
    persistAuditRun(db, accounting, verdict, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    db.close();
  }
}

/**
 * Write the run into audit_runs so it reaches the reviewer.
 *
 * The digest reads health from this table, not from the runner's stdout, so a
 * verdict computed only in memory is a verdict nobody sees. Uses the same table
 * and shape as the query auditor with a distinct `source`, so both auditors are
 * discoverable through one query.
 *
 * Best-effort by design: failing to record health must not fail the audit that
 * did run. A missing row is itself reported downstream as "the auditor never
 * ran", which is the safe direction.
 */
function persistAuditRun(
  db: Database.Database,
  accounting: AuditAccounting,
  verdict: AuditHealthVerdict,
  fatalError?: string
): void {
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_runs'").get();
    if (!exists) return;
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
    db.prepare(
      `INSERT INTO audit_runs (source, suite_version, started_ts, finished_ts, from_log_id, to_log_id, rows_audited, findings_written, status, detail)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`
    ).run(
      CHART_AUDIT_SOURCE,
      accounting.suiteVersion,
      accounting.startedAt,
      accounting.finishedAt,
      accounting.executed,
      status,
      detail.slice(0, 2000)
    );
  } catch (error) {
    console.warn("[run-chart-audit] could not record audit_runs health:", error instanceof Error ? error.message : error);
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
