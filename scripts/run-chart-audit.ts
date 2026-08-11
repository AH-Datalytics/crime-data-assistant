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
    return { counts, accounting, verdict };
  } finally {
    db.close();
  }
}

/** CLI entry point, invoked by scripts/nightly-audit-and-digest.sh. */
function main(): void {
  const { counts, accounting, verdict } = runChartAudit(process.argv[2]);
  console.log(
    `Chart audit: ${counts.total} eligible = ${counts.verified} verified + ${counts.incorrect} incorrect + ` +
      `${counts.needsReview} needs-review + ${counts.unverified} unverified`
  );
  console.log(describeAuditHealth(accounting, verdict));
  // A run whose accounting does not reconcile is a defect in this suite, not a
  // finding about charts. Exit non-zero so the caller notices; the nightly
  // wrapper treats a non-zero chart-audit exit as advisory and continues to the
  // digest, which reports the health line above.
  if (verdict.state === "invalid") process.exitCode = 1;
}

if (require.main === module) main();
