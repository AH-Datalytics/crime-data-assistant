/**
 * The Stage 1 proof migration must be additive, idempotent, and revertible.
 *
 * Same reasoning as test-model-response-migration and test-chart-config-migration,
 * with two additions specific to this migration:
 *
 *   1. It adds SIX columns plus an index in one run, so a run interrupted between
 *      two ALTERs leaves a partially-migrated table. The next run must complete it
 *      rather than either failing or claiming there was nothing to do.
 *
 *   2. It is the first query_log migration to create an index. SQLite refuses
 *      DROP COLUMN while an index references the column, so rollback has an
 *      ordering requirement that a column-only migration never had. A rollback
 *      that got that order wrong would fail halfway and leave the table in a state
 *      neither the baseline nor the new release expects.
 *
 * PRODUCTION IS NEVER TOUCHED HERE. Every case runs against a fresh temp-directory
 * fixture. Executing this migration against /opt/nibrs/shared/query_log.db is a
 * separate approval, documented in
 * docs/runbooks/2026-08-11-rollback-and-backup-manifest.md.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require("./migrate-query-log-proof.js") as {
  migrate: (opts: { dbPath: string; dryRun: boolean; rollback: boolean }) => {
    changed: boolean;
    columnsChanged: string[];
    indexChanged: boolean;
  };
  COLUMNS: { name: string; type: string }[];
  INDEX_NAME: string;
};

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

const EXPECTED_COLUMNS = [
  "delivery_action",
  "proof_manifest",
  "result_digest",
  "proof_schema_version",
  "proof_mode",
  "plan_family",
];

const BASE_DDL = `CREATE TABLE query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT, rows INTEGER,
  error TEXT, ms INTEGER, response TEXT, guardrails TEXT, model TEXT, session_id TEXT,
  routing_confidence TEXT, routing_mode TEXT, routing_reason TEXT, query_guidance TEXT, query_contract TEXT)`;

/** A fixture with pre-existing rows, so "existing rows survive" is a real assertion. */
function makeFixture(extra: string[] = [], rowCount = 3): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofmig-"));
  const dbPath = path.join(dir, "query_log.db");
  const db = new Database(dbPath);
  db.exec(BASE_DDL);
  for (const column of extra) db.exec(`ALTER TABLE query_log ADD COLUMN ${column}`);
  const insert = db.prepare("INSERT INTO query_log (ts, tab, question, rows) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < rowCount; i++) insert.run(1_786_000_000_000 + i, "current", `q${i}`, i);
  db.close();
  return dbPath;
}

function columnsOf(dbPath: string): string[] {
  const db = new Database(dbPath);
  const columns = (db.prepare("PRAGMA table_info(query_log)").all() as { name: string }[]).map((c) => c.name);
  db.close();
  return columns;
}

function indexExists(dbPath: string, name: string): boolean {
  const db = new Database(dbPath);
  const row = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name=?").get(name);
  db.close();
  return row !== undefined;
}

function rowCountOf(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number };
  db.close();
  return row.n;
}

console.log("\nforward migration");
{
  const dbPath = makeFixture();

  check("--dry-run changes nothing", () => {
    const result = migration.migrate({ dbPath, dryRun: true, rollback: false });
    assert.strictEqual(result.changed, false);
    for (const column of EXPECTED_COLUMNS) {
      assert.ok(!columnsOf(dbPath).includes(column), `${column} must not exist after a dry run`);
    }
  });

  check("adds all six columns and the index, preserving rows", () => {
    const result = migration.migrate({ dbPath, dryRun: false, rollback: false });
    assert.strictEqual(result.changed, true);
    const columns = columnsOf(dbPath);
    for (const column of EXPECTED_COLUMNS) assert.ok(columns.includes(column), `missing ${column}`);
    assert.ok(indexExists(dbPath, migration.INDEX_NAME), "delivery_action index missing");
    assert.strictEqual(rowCountOf(dbPath), 3, "existing rows must survive");
  });

  check("every new column is nullable on existing rows", () => {
    const db = new Database(dbPath);
    const row = db.prepare("SELECT * FROM query_log ORDER BY id LIMIT 1").get() as Record<string, unknown>;
    db.close();
    for (const column of EXPECTED_COLUMNS) {
      assert.strictEqual(row[column], null, `${column} should be NULL on a pre-existing row`);
    }
  });

  check("the index is partial, so NULL rows are not indexed", () => {
    const db = new Database(dbPath);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(migration.INDEX_NAME) as { sql: string }).sql;
    db.close();
    assert.match(sql, /WHERE delivery_action IS NOT NULL/i, `index is not partial: ${sql}`);
  });

  check("re-running is a no-op", () => {
    const result = migration.migrate({ dbPath, dryRun: false, rollback: false });
    assert.strictEqual(result.changed, false);
    assert.strictEqual(rowCountOf(dbPath), 3);
  });

  check("integrity_check is ok afterwards", () => {
    const db = new Database(dbPath);
    const integrity = db.pragma("integrity_check", { simple: true });
    db.close();
    assert.strictEqual(integrity, "ok");
  });
}

console.log("\npartially-applied migration completes");
{
  // The interrupted-run case: three of six columns already exist and the index does
  // not. A migration that checked only one sentinel column would report "already
  // present; nothing to do" and leave the table permanently half-migrated.
  const dbPath = makeFixture(["delivery_action TEXT", "proof_manifest TEXT", "result_digest TEXT"]);

  check("adds only the missing columns", () => {
    const result = migration.migrate({ dbPath, dryRun: false, rollback: false });
    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual(
      result.columnsChanged.sort(),
      ["plan_family", "proof_mode", "proof_schema_version"],
      "should have added exactly the three missing columns",
    );
  });

  check("the table ends fully migrated", () => {
    const columns = columnsOf(dbPath);
    for (const column of EXPECTED_COLUMNS) assert.ok(columns.includes(column), `missing ${column}`);
    assert.ok(indexExists(dbPath, migration.INDEX_NAME));
  });
}

console.log("\nmissing index alone is repaired");
{
  // Columns present, index dropped by hand (or by a rollback that stopped early).
  const dbPath = makeFixture(EXPECTED_COLUMNS.map((c) => `${c} TEXT`));

  check("creates the index without touching columns", () => {
    assert.ok(!indexExists(dbPath, migration.INDEX_NAME), "fixture should start without the index");
    const result = migration.migrate({ dbPath, dryRun: false, rollback: false });
    assert.strictEqual(result.changed, true);
    assert.deepStrictEqual(result.columnsChanged, [], "no columns should have been added");
    assert.ok(indexExists(dbPath, migration.INDEX_NAME));
  });
}

console.log("\nrollback");
{
  const dbPath = makeFixture();
  migration.migrate({ dbPath, dryRun: false, rollback: false });

  // Populate the new columns so rollback is dropping real data, not empty columns.
  {
    const db = new Database(dbPath);
    db.prepare("UPDATE query_log SET delivery_action = 'answer', proof_mode = 'shadow' WHERE id = 1").run();
    db.close();
  }

  check("--rollback --dry-run changes nothing", () => {
    const result = migration.migrate({ dbPath, dryRun: true, rollback: true });
    assert.strictEqual(result.changed, false);
    assert.ok(columnsOf(dbPath).includes("delivery_action"));
    assert.ok(indexExists(dbPath, migration.INDEX_NAME));
  });

  check("drops the index before the column it references", () => {
    // The ordering requirement. If the index were dropped after (or not at all),
    // SQLite raises "error in index ... after drop column" and the rollback fails
    // partway through.
    const result = migration.migrate({ dbPath, dryRun: false, rollback: true });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.indexChanged, true);
    assert.ok(!indexExists(dbPath, migration.INDEX_NAME), "index should be gone");
    for (const column of EXPECTED_COLUMNS) {
      assert.ok(!columnsOf(dbPath).includes(column), `${column} should be gone`);
    }
  });

  check("rows and integrity survive the rollback", () => {
    assert.strictEqual(rowCountOf(dbPath), 3);
    const db = new Database(dbPath);
    const integrity = db.pragma("integrity_check", { simple: true });
    db.close();
    assert.strictEqual(integrity, "ok");
  });

  check("rolling back twice is a no-op", () => {
    const result = migration.migrate({ dbPath, dryRun: false, rollback: true });
    assert.strictEqual(result.changed, false);
  });

  check("forward migration works again after a rollback", () => {
    const result = migration.migrate({ dbPath, dryRun: false, rollback: false });
    assert.strictEqual(result.changed, true);
    assert.ok(indexExists(dbPath, migration.INDEX_NAME));
    assert.strictEqual(rowCountOf(dbPath), 3);
  });
}

console.log("\ncoexistence with the earlier query_log migrations");
{
  // chart_config, model_response, and request_id may each be present or absent in
  // production. The proof migration must not care.
  const dbPath = makeFixture(["chart_config TEXT", "model_response TEXT", "request_id TEXT"]);

  check("applies cleanly alongside chart_config/model_response/request_id", () => {
    const result = migration.migrate({ dbPath, dryRun: false, rollback: false });
    assert.strictEqual(result.changed, true);
    const columns = columnsOf(dbPath);
    for (const column of [...EXPECTED_COLUMNS, "chart_config", "model_response", "request_id"]) {
      assert.ok(columns.includes(column), `missing ${column}`);
    }
  });

  check("rollback leaves the earlier columns intact", () => {
    migration.migrate({ dbPath, dryRun: false, rollback: true });
    const columns = columnsOf(dbPath);
    for (const column of ["chart_config", "model_response", "request_id"]) {
      assert.ok(columns.includes(column), `rollback must not drop ${column}`);
    }
    for (const column of EXPECTED_COLUMNS) assert.ok(!columns.includes(column));
  });
}

console.log(`\nproof migration tests: ${passed} passed`);
if (process.exitCode) {
  console.log("proof migration tests: FAILED");
} else {
  console.log("proof migration tests: passed");
}
