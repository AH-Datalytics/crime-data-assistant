#!/usr/bin/env node
const Database = require("better-sqlite3");
const path = require("path");

const args = process.argv.slice(2);
const rollback = args.includes("--rollback");
const dryRun = args.includes("--dry-run");
const dbArg = args.find((arg) => !arg.startsWith("--"));
const dbPath = path.resolve(dbArg || process.env.QUERY_LOG_DB_PATH || path.join(process.cwd(), "query_log.db"));
const db = new Database(dbPath);

function hasColumn(table, name) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === name);
}

function migrate() {
  if (!hasColumn("query_log", "request_id")) db.exec("ALTER TABLE query_log ADD COLUMN request_id TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_query_log_request_id ON query_log(request_id) WHERE request_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS chart_audit_artifacts (
      request_id TEXT PRIMARY KEY,
      query_log_id INTEGER,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      chart_config TEXT NOT NULL,
      columns_json TEXT NOT NULL,
      data_json TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      column_count INTEGER NOT NULL,
      captured_row_count INTEGER NOT NULL,
      captured_column_count INTEGER NOT NULL,
      data_hash TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      truncation_reason TEXT,
      FOREIGN KEY(query_log_id) REFERENCES query_log(id)
    );
    CREATE INDEX IF NOT EXISTS idx_chart_audit_query_log_id ON chart_audit_artifacts(query_log_id);
    CREATE TABLE IF NOT EXISTS chart_render_receipts (
      request_id TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL,
      receipt_json TEXT NOT NULL,
      FOREIGN KEY(request_id) REFERENCES chart_audit_artifacts(request_id)
    );
    CREATE TABLE IF NOT EXISTS chart_audit_results (
      request_id TEXT PRIMARY KEY,
      query_log_id INTEGER,
      audited_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      FOREIGN KEY(request_id) REFERENCES chart_audit_artifacts(request_id),
      FOREIGN KEY(query_log_id) REFERENCES query_log(id)
    );
    CREATE INDEX IF NOT EXISTS idx_chart_audit_results_query_log_id ON chart_audit_results(query_log_id);
  `);
}

function revert() {
  db.exec("DROP TABLE IF EXISTS chart_audit_results; DROP TABLE IF EXISTS chart_render_receipts; DROP TABLE IF EXISTS chart_audit_artifacts; DROP INDEX IF EXISTS idx_query_log_request_id");
  if (hasColumn("query_log", "request_id")) db.exec("ALTER TABLE query_log DROP COLUMN request_id");
}

if (dryRun) {
  console.log(`${rollback ? "Would remove" : "Would add"} chart audit schema in ${dbPath}`);
} else {
  db.transaction(rollback ? revert : migrate)();
  console.log(`${rollback ? "Removed" : "Installed"} chart audit schema in ${dbPath}`);
}
db.close();
