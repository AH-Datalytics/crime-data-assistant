import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  detectQueryAuditFindings,
  QUERY_AUDIT_DETECTORS,
  QUERY_AUDIT_SUITE_VERSION,
  type QueryAuditRow,
} from "../lib/query-audit-detectors";
import { AUDIT_MUST_FLAG } from "../lib/query-audit-corpus";

/**
 * Provenance label written to audit_findings.source. Must stay distinct from the
 * digest's 'daily-digest' -- the unique index is (query_log_id, category, source),
 * so a shared label would let the two writers overwrite each other.
 */
const SOURCE_ID = "phase1-detector";

/** Findings are advisory. Nothing here gates a user response or a deployment. */
const ADVISORY_NOTICE =
  "findings are informational and do not gate responses, guardrails, or deployments.";

function resolveQueryLogPath(): string {
  const argumentIndex = process.argv.indexOf("--db");
  const argument = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
  const candidates = [argument, process.env.QUERY_LOG_DB_PATH, path.join(process.cwd(), "query_log.db"), "/opt/nibrs/shared/query_log.db", "/opt/nibrs/app/query_log.db"].filter(Boolean) as string[];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`No query_log.db found. Checked: ${candidates.join(", ")}`);
  return found;
}

export function loadCanonicalValues(): string[] {
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

/**
 * Detectors whose reference data is missing are UNVALIDATABLE, not clean.
 * Reporting them as "0 flagged" would be a false all-clear, so the runner
 * surfaces them separately and records them in the run's detail column.
 */
function inertDetectors(canonicalValues: string[]): string[] {
  if (canonicalValues.length > 0) return [];
  return QUERY_AUDIT_DETECTORS.filter((detector) => detector.requiresCanonicalValues).map((detector) => detector.id);
}

function requireMigrated(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(audit_findings)").all() as Array<{ name: string }>).map((column) => column.name));
  if (columns.size === 0) throw new Error("audit_findings does not exist. Run scripts/migrate-audit-findings-source.js first.");
  if (!columns.has("source")) {
    throw new Error("audit_findings has no `source` column. Run scripts/migrate-audit-findings-source.js first -- writing without provenance would make detector findings indistinguishable from digest findings.");
  }
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  if (!tables.has("audit_runs")) throw new Error("audit_runs does not exist. Run scripts/migrate-audit-findings-source.js first.");
}

function numericArg(flag: string): number | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${flag} requires a number`);
  return value;
}

export interface AuditWindow {
  fromId: number;
  toId: number;
  mode: "watermark" | "all" | "explicit" | "days";
}

/**
 * The window is exclusive of fromId and inclusive of toId, so consecutive runs
 * never re-audit a row and never skip one. toId is pinned once at the start of
 * the run; rows logged while the audit is in flight belong to the next run.
 */
export function resolveWindow(db: Database.Database): AuditWindow {
  const maxId = (db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM query_log").get() as { n: number }).n;
  const toId = numericArg("--until") ?? maxId;

  if (process.argv.includes("--all")) return { fromId: 0, toId, mode: "all" };

  const since = numericArg("--since");
  if (since !== undefined) return { fromId: since, toId, mode: "explicit" };

  const days = numericArg("--days");
  if (days !== undefined) {
    const cutoff = Date.now() - days * 86400000;
    const row = db.prepare("SELECT COALESCE(MIN(id), 0) AS n FROM query_log WHERE ts >= ?").get(cutoff) as { n: number };
    // MIN(id) is the first row IN the window, and fromId is exclusive.
    return { fromId: Math.max(0, row.n - 1), toId, mode: "days" };
  }

  const watermark = db.prepare(
    "SELECT COALESCE(MAX(to_log_id), 0) AS n FROM audit_runs WHERE source = ? AND suite_version = ? AND status = 'ok'"
  ).get(SOURCE_ID, QUERY_AUDIT_SUITE_VERSION) as { n: number };
  return { fromId: watermark.n, toId, mode: "watermark" };
}

export interface AuditResult {
  total: number;
  window: AuditWindow;
  flagged: Record<string, number>;
  unflagged: Record<string, number>;
  findingsWritten: number;
  inert: string[];
  runId: number;
}

export function runQueryAudit(dbPath = resolveQueryLogPath()): AuditResult {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  requireMigrated(db);

  const canonicalValues = loadCanonicalValues();
  const inert = inertDetectors(canonicalValues);
  const window = resolveWindow(db);

  const startRun = db.prepare(
    "INSERT INTO audit_runs (source, suite_version, started_ts, from_log_id, to_log_id, status) VALUES (?, ?, ?, ?, ?, 'running')"
  ).run(SOURCE_ID, QUERY_AUDIT_SUITE_VERSION, Date.now(), window.fromId, window.toId);
  const runId = Number(startRun.lastInsertRowid);

  try {
    const logColumns = new Set((db.prepare("PRAGMA table_info(query_log)").all() as Array<{ name: string }>).map((column) => column.name));
    const contractExpression = logColumns.has("query_contract") ? "query_contract" : "NULL";
    const rows = db.prepare(
      `SELECT id, ts, question, sql, response, rows, guardrails, ${contractExpression} AS query_contract, tab
       FROM query_log WHERE id > ? AND id <= ? ORDER BY id`
    ).all(window.fromId, window.toId) as QueryAuditRow[];

    const insert = db.prepare(
      `INSERT INTO audit_findings (query_log_id, ts, severity, category, finding, proposed_fix, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(query_log_id, category, source)
       DO UPDATE SET ts=excluded.ts, severity=excluded.severity, finding=excluded.finding, proposed_fix=excluded.proposed_fix`
    );
    const flagged = Object.fromEntries(QUERY_AUDIT_DETECTORS.map((detector) => [detector.id, 0]));
    let findingsWritten = 0;

    // Batched rather than one long transaction: the app logs live traffic into
    // this file, and a single transaction over a full backfill would hold a
    // write lock for the entire run.
    const BATCH = 500;
    for (let offset = 0; offset < rows.length; offset += BATCH) {
      const batch = rows.slice(offset, offset + BATCH);
      db.transaction(() => {
        for (const row of batch) {
          const rowId = row.id || row.query_log_id || 0;
          for (const item of detectQueryAuditFindings({ ...row, canonicalValues })) {
            insert.run(rowId, row.ts || Date.now(), item.severity, item.category, item.finding, item.proposedFix, SOURCE_ID);
            flagged[item.detectorId]++;
            findingsWritten++;
          }
        }
      })();
    }

    const detail = inert.length ? `inert detectors (missing reference data): ${inert.join(",")}` : null;
    db.prepare(
      "UPDATE audit_runs SET finished_ts = ?, rows_audited = ?, findings_written = ?, status = 'ok', detail = ? WHERE id = ?"
    ).run(Date.now(), rows.length, findingsWritten, detail, runId);

    const unflagged = Object.fromEntries(QUERY_AUDIT_DETECTORS.map((detector) => [detector.id, rows.length - flagged[detector.id]]));
    db.close();
    return { total: rows.length, window, flagged, unflagged, findingsWritten, inert, runId };
  } catch (error) {
    // The watermark only advances on status='ok', so a failed run is safely
    // re-audited next time rather than silently skipped.
    try {
      db.prepare("UPDATE audit_runs SET finished_ts = ?, status = 'failed', detail = ? WHERE id = ?")
        .run(Date.now(), (error as Error).message.slice(0, 500), runId);
    } catch { /* the failure to record a failure must not mask the original error */ }
    db.close();
    throw error;
  }
}

/** A detector is only "calibrated" if the corpus actually asserts a case for it. */
function calibrationStatus(detectorId: string, inert: string[]): string {
  if (inert.includes(detectorId)) return "INERT (no reference data)";
  const covered = Object.values(AUDIT_MUST_FLAG).some((detectors) => detectors.includes(detectorId));
  return covered ? "calibrated" : "unvalidated";
}

if (require.main === module) {
  const result = runQueryAudit();
  console.table(QUERY_AUDIT_DETECTORS.map((detector) => ({
    detector: detector.id,
    category: detector.category,
    flagged: result.flagged[detector.id],
    unflagged: result.unflagged[detector.id],
    status: calibrationStatus(detector.id, result.inert),
  })));
  const { window } = result;
  console.log(
    `Run ${result.runId}: audited ${result.total} query_log rows ` +
      `(${window.mode} window, id ${window.fromId + 1}..${window.toId}); ` +
      `wrote ${result.findingsWritten} findings as source='${SOURCE_ID}'; ${ADVISORY_NOTICE}`
  );
  if (result.inert.length) {
    console.warn(
      `WARNING: ${result.inert.join(", ")} could not run -- no canonical reference values were available ` +
        `(set SHR_DB_PATH). Their zero counts above are NOT an all-clear.`
    );
  }
}
