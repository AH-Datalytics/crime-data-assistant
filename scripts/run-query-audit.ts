import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { detectQueryAuditFindings, QUERY_AUDIT_DETECTORS, type QueryAuditRow } from "../lib/query-audit-detectors";

function resolveQueryLogPath(): string {
  const candidates = [process.env.QUERY_LOG_DB_PATH, path.join(process.cwd(), "query_log.db"), "/opt/nibrs/app/query_log.db"].filter(Boolean) as string[];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`No query_log.db found. Checked: ${candidates.join(", ")}`);
  return found;
}

function loadCanonicalValues(): string[] {
  const candidates = [process.env.SHR_DB_PATH, path.join(process.cwd(), "shr.db"), "/opt/nibrs/shr.db"].filter(Boolean) as string[];
  const source = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).size > 0);
  if (!source) return [];
  let sourceDb: Database.Database | undefined;
  try {
    sourceDb = new Database(source, { readonly: true });
    const tables = sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const values = new Set<string>();
    for (const table of tables) {
      const columns = sourceDb.prepare(`PRAGMA table_info("${table.name.replace(/"/g, '""')}")`).all() as Array<{ name: string; type: string }>;
      for (const column of columns.filter((item) => /race|ethnic|relationship|circumstance/i.test(item.name))) {
        try {
          const quotedTable = `"${table.name.replace(/"/g, '""')}"`;
          const quotedColumn = `"${column.name.replace(/"/g, '""')}"`;
          const rows = sourceDb.prepare(`SELECT DISTINCT ${quotedColumn} AS value FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL LIMIT 500`).all() as Array<{ value: unknown }>;
          for (const row of rows) if (typeof row.value === "string" && row.value.trim()) values.add(row.value.trim());
        } catch { /* One source table may be a view or have incompatible quoting; continue. */ }
      }
    }
    return [...values];
  } finally {
    sourceDb?.close();
  }
}

function ensureFindingsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS audit_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query_log_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    finding TEXT NOT NULL,
    proposed_fix TEXT,
    status TEXT DEFAULT 'open'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_findings_unique ON audit_findings (query_log_id, category);`);
}

export function runQueryAudit(dbPath = resolveQueryLogPath()): { total: number; flagged: Record<string, number>; unflagged: Record<string, number> } {
  const db = new Database(dbPath);
  const canonicalValues = loadCanonicalValues();
  const rows = db.prepare("SELECT id, ts, question, sql, response, rows, guardrails, query_contract, tab FROM query_log ORDER BY id").all() as QueryAuditRow[];
  ensureFindingsTable(db);
  const insert = db.prepare(`INSERT INTO audit_findings (query_log_id, ts, severity, category, finding, proposed_fix)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(query_log_id, category) DO UPDATE SET ts=excluded.ts, severity=excluded.severity, finding=excluded.finding, proposed_fix=excluded.proposed_fix`);
  const flagged = Object.fromEntries(QUERY_AUDIT_DETECTORS.map((detector) => [detector.id, 0]));
  const write = db.transaction((items: Array<{ id: number; ts: number; severity: string; category: string; finding: string; proposedFix: string }>) => {
    for (const item of items) insert.run(item.id, item.ts || Date.now(), item.severity, item.category, item.finding, item.proposedFix);
  });
  for (const row of rows) {
    const findings = detectQueryAuditFindings({ ...row, canonicalValues });
    write(findings.map((item) => ({ id: row.id || row.query_log_id || 0, ts: row.ts || Date.now(), severity: item.severity, category: item.category, finding: item.finding, proposedFix: item.proposedFix })));
    for (const item of findings) flagged[item.detectorId]++;
  }
  db.close();
  const unflagged = Object.fromEntries(QUERY_AUDIT_DETECTORS.map((detector) => [detector.id, rows.length - flagged[detector.id]]));
  return { total: rows.length, flagged, unflagged };
}

if (require.main === module) {
  const result = runQueryAudit();
  console.table(QUERY_AUDIT_DETECTORS.map((detector) => ({ detector: detector.id, category: detector.category, flagged: result.flagged[detector.id], unflagged: result.unflagged[detector.id], status: "uncalibrated" })));
  console.log(`Audited ${result.total} query_log rows; findings are informational and do not gate responses or deployments.`);
}
