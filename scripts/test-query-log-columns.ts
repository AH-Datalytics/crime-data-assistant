/**
 * The query_log INSERT builder, and deploy-order tolerance in both directions.
 *
 * WHY THIS SUITE IS LOAD-BEARING. Both loggers wrap their INSERT in a catch that
 * only console.warns. If the column list and the value list disagree, prepare()
 * throws, the throw is swallowed, and EVERY query log row is lost — with no
 * failing request and no error visible to a user. The repository has already paid
 * for this once: production defect 8375 had to be diagnosed by replaying requests
 * against the live API because the diagnostic capture was not there.
 *
 * Stage 1 takes both loggers from 18 columns to 24. These tests assert the
 * property that makes that safe: columns, placeholders, and values are derived
 * from one object, so they cannot desynchronize.
 *
 * Handoff §12.6 requires migrations to be "deploy-order tolerant, and readable by
 * the baseline application", so both directions are exercised:
 *   - new code, old (unmigrated) database
 *   - old code, new (migrated) database
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  buildQueryLogInsert,
  queryLogColumnSet,
  queryLogHasColumn,
  QUERY_LOG_BASE_COLUMNS,
  QUERY_LOG_MIGRATED_COLUMNS,
} from "../lib/query-log-columns";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

const BASE_DDL = `CREATE TABLE query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT, rows INTEGER,
  error TEXT, ms INTEGER, response TEXT, guardrails TEXT, model TEXT, session_id TEXT,
  routing_confidence TEXT, routing_mode TEXT, routing_reason TEXT, query_guidance TEXT, query_contract TEXT)`;

const PROOF_COLUMNS = [
  "delivery_action TEXT",
  "proof_manifest TEXT",
  "result_digest TEXT",
  "proof_schema_version INTEGER",
  "proof_mode TEXT",
  "plan_family TEXT",
];

function makeDb(extraColumns: string[] = []): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlcols-"));
  const db = new Database(path.join(dir, "query_log.db"));
  db.exec(BASE_DDL);
  for (const column of extraColumns) db.exec(`ALTER TABLE query_log ADD COLUMN ${column}`);
  return { db, dir };
}

/** A full logical row as the Stage 1 loggers now build it. */
function fullRow(): Record<string, unknown> {
  return {
    ts: 1_786_000_000_000,
    tab: "current",
    question: "murders in Baton Rouge 2024",
    sql: "SELECT 1",
    rows: 3,
    error: null,
    ms: 1200,
    response: "Here are the results.",
    guardrails: "geo-typo-corrected",
    model: "haiku-4.5",
    session_id: "abc",
    routing_confidence: "high",
    routing_mode: "auto",
    routing_reason: null,
    query_guidance: null,
    query_contract: null,
    chart_config: '{"type":"line"}',
    model_response: '{"attempt":1}',
    request_id: "req-1",
    delivery_action: "answer",
    proof_manifest: '{"manifest":{}}',
    result_digest: '{"v":1}',
    proof_schema_version: 1,
    proof_mode: "shadow",
    plan_family: "current-agency-trend",
  };
}

console.log("\nquery_log column set");
{
  const { db } = makeDb(["chart_config TEXT"]);

  check("reads the live schema, not a hardcoded list", () => {
    const columns = queryLogColumnSet(db);
    for (const base of QUERY_LOG_BASE_COLUMNS) assert.ok(columns.has(base), `missing base column ${base}`);
    assert.ok(columns.has("chart_config"));
    assert.ok(!columns.has("model_response"), "must not claim a column the table lacks");
  });

  check("queryLogHasColumn agrees with the set", () => {
    assert.strictEqual(queryLogHasColumn(db, "chart_config"), true);
    assert.strictEqual(queryLogHasColumn(db, "delivery_action"), false);
  });

  check("an unreadable handle yields an empty set rather than throwing", () => {
    // A closed handle is the request-path shape of "schema unavailable". It must
    // degrade, not throw: this runs inside the logger, and a throw here would be
    // swallowed by the logger's catch and lose the row anyway.
    const dead = new Database(":memory:");
    dead.close();
    const columns = queryLogColumnSet(dead);
    assert.strictEqual(columns.size, 0);
  });

  db.close();
}

console.log("\nINSERT builder cannot desynchronize columns and values");
{
  const { db } = makeDb([...PROOF_COLUMNS, "chart_config TEXT", "model_response TEXT", "request_id TEXT"]);

  check("every supplied column is written and reads back identically", () => {
    const row = fullRow();
    const insert = buildQueryLogInsert(db, row);
    assert.ok(insert, "builder returned null on a fully-migrated table");
    assert.strictEqual(insert!.omitted.length, 0, `unexpectedly omitted: ${insert!.omitted.join(",")}`);
    db.prepare(insert!.sql).run(...insert!.values);
    const stored = db.prepare("SELECT * FROM query_log ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
    for (const [column, value] of Object.entries(row)) {
      assert.deepStrictEqual(stored[column], value, `column ${column} round-tripped incorrectly`);
    }
  });

  check("placeholder count always equals value count", () => {
    // The specific failure the old hand-counted arithmetic could produce.
    for (const keys of [["ts"], ["ts", "tab"], Object.keys(fullRow())]) {
      const partial: Record<string, unknown> = {};
      for (const key of keys) partial[key] = fullRow()[key];
      const insert = buildQueryLogInsert(db, partial)!;
      const placeholders = (insert.sql.match(/\?/g) || []).length;
      assert.strictEqual(placeholders, insert.values.length, `${keys.length}-column row: ${insert.sql}`);
    }
  });

  check("undefined is dropped but null is written", () => {
    // "No opinion" and "assert empty" are different facts; only the second writes.
    const insert = buildQueryLogInsert(db, { ts: 1, tab: "shr", error: null, response: undefined })!;
    assert.ok(insert.sql.includes("error"), "explicit null must be written");
    assert.ok(!insert.sql.includes("response"), "undefined must be dropped");
    assert.strictEqual(insert.values.length, 3);
  });

  db.close();
}

console.log("\ndeploy order: new code against an unmigrated database");
{
  // Direction 1: a Stage 1 release deployed BEFORE the migration runs.
  const { db } = makeDb();

  check("proof columns are dropped from the insert, not fatal", () => {
    const insert = buildQueryLogInsert(db, fullRow());
    assert.ok(insert, "builder must still produce an insert");
    for (const column of QUERY_LOG_MIGRATED_COLUMNS) {
      assert.ok(insert!.omitted.includes(column), `${column} should have been omitted`);
      assert.ok(!insert!.sql.includes(column), `${column} must not appear in the SQL`);
    }
    db.prepare(insert!.sql).run(...insert!.values);
    const stored = db.prepare("SELECT question, rows FROM query_log ORDER BY id DESC LIMIT 1").get() as {
      question: string;
      rows: number;
    };
    assert.strictEqual(stored.question, "murders in Baton Rouge 2024");
    assert.strictEqual(stored.rows, 3);
  });

  check("the base 16 columns still all land", () => {
    const insert = buildQueryLogInsert(db, fullRow())!;
    for (const base of QUERY_LOG_BASE_COLUMNS) {
      assert.ok(insert.sql.includes(base), `base column ${base} must still be written`);
    }
  });

  db.close();
}

console.log("\ndeploy order: baseline code against a migrated database");
{
  // Direction 2: the migration has run and the app rolls back to baseline c2b52ca,
  // which knows nothing about the proof columns. The manifest in
  // docs/runbooks/2026-08-11-rollback-and-backup-manifest.md §2 makes this the
  // check that proves the additive-schema requirement held.
  const { db } = makeDb([...PROOF_COLUMNS, "chart_config TEXT", "model_response TEXT", "request_id TEXT"]);

  check("a baseline-shaped 16-column insert still succeeds", () => {
    const baselineColumns = QUERY_LOG_BASE_COLUMNS.join(", ");
    const placeholders = QUERY_LOG_BASE_COLUMNS.map(() => "?").join(", ");
    db.prepare(`INSERT INTO query_log (${baselineColumns}) VALUES (${placeholders})`).run(
      1_786_000_000_001, "historical", "q", "SELECT 1", 1, null, 5, "r", null, "haiku-4.5",
      null, null, null, null, null, null,
    );
    const stored = db.prepare("SELECT delivery_action, proof_mode FROM query_log ORDER BY id DESC LIMIT 1").get() as {
      delivery_action: string | null;
      proof_mode: string | null;
    };
    assert.strictEqual(stored.delivery_action, null, "new columns must be nullable");
    assert.strictEqual(stored.proof_mode, null);
  });

  check("baseline SELECT * tolerates the wider row", () => {
    const rows = db.prepare("SELECT * FROM query_log").all();
    assert.ok(rows.length >= 1);
  });

  db.close();
}

console.log(`\nquery_log column builder tests: ${passed} passed`);
if (process.exitCode) {
  console.log("query_log column builder tests: FAILED");
} else {
  console.log("query_log column builder tests: passed");
}
