#!/usr/bin/env npx tsx
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { auditChartArtifact, type ChartAuditArtifact, type ChartRenderReceipt } from "../lib/chart-audit";

function resolveDbPath(argument?: string): string {
  const candidates = [argument, process.env.QUERY_LOG_DB_PATH, path.join(process.cwd(), "query_log.db"), "/opt/nibrs/shared/query_log.db"]
    .filter(Boolean) as string[];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`No query_log.db found. Checked: ${candidates.join(", ")}`);
  return path.resolve(found);
}

const db = new Database(resolveDbPath(process.argv[2]));
const hasResults = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chart_audit_results'").get();
if (!hasResults) throw new Error("Chart audit schema is not installed. Run scripts/migrate-chart-audit-artifacts.js first.");

const rows = db.prepare(`
  SELECT a.*, COALESCE(a.query_log_id, q.id) AS joined_query_log_id, q.question, r.receipt_json
  FROM chart_audit_artifacts a
  LEFT JOIN query_log q ON q.request_id = a.request_id
  LEFT JOIN chart_render_receipts r ON r.request_id = a.request_id
  ORDER BY a.created_at
`).all() as Array<Record<string, unknown>>;

const upsert = db.prepare(`INSERT INTO chart_audit_results
  (request_id, query_log_id, audited_at, status, summary, findings_json)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(request_id) DO UPDATE SET query_log_id=excluded.query_log_id,
    audited_at=excluded.audited_at, status=excluded.status, summary=excluded.summary,
    findings_json=excluded.findings_json`);
const findingTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_findings'").get());
const findingColumns = findingTable ? new Set((db.prepare("PRAGMA table_info(audit_findings)").all() as Array<{ name: string }>).map((column) => column.name)) : new Set<string>();

const run = db.transaction(() => {
  const counts = { total: 0, verified: 0, incorrect: 0, needsReview: 0, unverified: 0 };
  for (const row of rows) {
    const artifact: ChartAuditArtifact = {
      requestId: String(row.request_id), source: row.source as ChartAuditArtifact["source"], createdAt: Number(row.created_at),
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
  }
  return counts;
});

const counts = run();
console.log(`Chart audit: ${counts.total} eligible = ${counts.verified} verified + ${counts.incorrect} incorrect + ${counts.needsReview} needs-review + ${counts.unverified} unverified`);
db.close();
