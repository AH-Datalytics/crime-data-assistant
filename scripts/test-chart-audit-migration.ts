import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-audit-migration-"));
const dbPath = path.join(dir, "query_log.db");
const db = new Database(dbPath);
db.exec("CREATE TABLE query_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, question TEXT)");
db.prepare("INSERT INTO query_log (ts, question) VALUES (?, ?)").run(1, "keep me");
db.close();

const script = path.resolve("scripts/migrate-chart-audit-artifacts.js");
execFileSync(process.execPath, [script, dbPath], { stdio: "pipe" });
execFileSync(process.execPath, [script, dbPath], { stdio: "pipe" });
let check = new Database(dbPath);
assert.ok(check.prepare("PRAGMA table_info(query_log)").all().some((column: any) => column.name === "request_id"));
assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chart_audit_artifacts'").get());
assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chart_render_receipts'").get());
assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chart_audit_results'").get());
assert.equal((check.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number }).n, 1);
check.close();

execFileSync(process.execPath, [script, dbPath, "--rollback"], { stdio: "pipe" });
check = new Database(dbPath);
assert.ok(!check.prepare("PRAGMA table_info(query_log)").all().some((column: any) => column.name === "request_id"));
assert.equal((check.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number }).n, 1);
check.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("chart audit migration tests passed");
