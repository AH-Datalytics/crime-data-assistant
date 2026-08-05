import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { validateSqlSchema } from "../lib/schema-validation";
import {
  ensureNibrsRollupAttached,
  nibrsRollupContextForDb,
  routeNibrsRollupSql,
} from "../lib/nibrs-rollup-router";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-rollup-context-"));
const sourcePath = path.join(dir, "nibrs.db");
const rollupA = path.join(dir, "nibrs_rollups-a.db");
const rollupB = path.join(dir, "nibrs_rollups-b.db");
fs.writeFileSync(path.join(dir, "source.generation"), "generation-a\\n");

function makeRollup(filePath: string, value: number): void {
  const db = new Database(filePath);
  db.exec("CREATE TABLE national_summary_clearance_detail (year INTEGER, cleared_by_arrest INTEGER)");
  if (value === 10) {
    db.exec("CREATE TABLE national_summary_arrestee_demographics (arrestee_count INTEGER)");
  }
  db.prepare("INSERT INTO national_summary_clearance_detail VALUES (2024, ?)").run(value);
  db.close();
}

new Database(sourcePath).close();
makeRollup(rollupA, 10);
makeRollup(rollupB, 20);
process.env.NIBRS_DB_PATH = sourcePath;
process.env.NIBRS_ROLLUP_DB_PATH = rollupA;
delete process.env.NIBRS_SOURCE_GENERATION_PATH;

console.log("\n1. 7973-shaped rollup SQL validates only with the attached context");
{
  const db = new Database(":memory:");
  const unqualified = "SELECT year, cleared_by_arrest FROM summary_clearance_detail";
  const routed = routeNibrsRollupSql(unqualified, true);
  assert.equal(routed.routed, true);
  assert.equal(validateSqlSchema(db, routed.sql).ok, false, "old unattached validation must fail");
  const context = ensureNibrsRollupAttached(db);
  assert.equal(context.available, true);
  assert.equal(validateSqlSchema(db, routed.sql).ok, true, "attached validation must pass");
  const row = db.prepare(routed.sql).get() as { cleared_by_arrest: number };
  assert.equal(row.cleared_by_arrest, 10);
  db.close();
}

console.log("\n2. Ordinary main-database SQL remains unchanged");
{
  const db = new Database(":memory:");
  db.exec("CREATE TABLE ordinary_control (value INTEGER)");
  db.prepare("INSERT INTO ordinary_control VALUES (7)").run();
  const result = db.prepare("SELECT value FROM ordinary_control").get() as { value: number };
  assert.equal(result.value, 7);
  assert.equal(routeNibrsRollupSql("SELECT value FROM ordinary_control", true).routed, false);
  db.close();
}

console.log("\n3. Missing rollup fails closed without main-database fallback");
{
  const db = new Database(sourcePath);
  process.env.NIBRS_ROLLUP_DB_PATH = path.join(dir, "missing-rollups.db");
  const context = ensureNibrsRollupAttached(db);
  assert.equal(context.available, false);
  assert.equal(nibrsRollupContextForDb(db)?.available, false);
  assert.equal(routeNibrsRollupSql("SELECT year FROM summary_clearance_detail", true).routed, true);
  db.close();
}

console.log("\n4. Rollup target changes refresh attachment and schema metadata");
{
  process.env.NIBRS_ROLLUP_DB_PATH = rollupA;
  const db = new Database(sourcePath);
  const first = ensureNibrsRollupAttached(db);
  assert.equal(first.available, true);
  assert.equal((db.prepare("SELECT cleared_by_arrest FROM rollup.national_summary_clearance_detail").get() as { cleared_by_arrest: number }).cleared_by_arrest, 10);
  const cachedCorrection = validateSqlSchema(db, "SELECT arrest_count FROM rollup.national_summary_arrestee_demographics");
  assert.equal(cachedCorrection.corrected, true);
  process.env.NIBRS_ROLLUP_DB_PATH = rollupB;
  const second = ensureNibrsRollupAttached(db);
  assert.equal(second.available, true);
  assert.notEqual(second.generationKey, first.generationKey);
  assert.equal((db.prepare("SELECT cleared_by_arrest FROM rollup.national_summary_clearance_detail").get() as { cleared_by_arrest: number }).cleared_by_arrest, 20);
  assert.equal(validateSqlSchema(db, "SELECT arrest_count FROM rollup.national_summary_arrestee_demographics").ok, false, "stale column cache must not survive the swap");
  db.close();
}

console.log("\n5. Unauthorized agency-scoped rollup routing remains blocked");
{
  assert.equal(routeNibrsRollupSql("SELECT * FROM summary_clearance_detail WHERE ori = 'ABC'", true).routed, false);
}

console.log("All NIBRS rollup context checks passed.");
