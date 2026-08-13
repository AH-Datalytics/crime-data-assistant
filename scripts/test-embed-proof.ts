/**
 * Shared charts under the proof contract: the migration, and the route's real behavior.
 *
 * A shared chart re-executes stored SQL on every view, forever, for anyone with the
 * link. Before Stage 1 it did so with no connection to the answer it came from and no
 * validation at all — handoff §4 calls it out by name as a surface inside the
 * contract.
 *
 * These tests drive the ACTUAL route handlers against a temp-directory query_log,
 * rather than asserting on source text, because the properties that matter here are
 * behavioral: does a legacy chart stay distinguishable from a proven one, and does a
 * read still serve when the proof machinery is off?
 *
 * The environment is pointed at a fixture BEFORE the route is imported, because
 * getWriteDb() resolves and caches its path on first use.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { serializeChartConfigForLog } from "../lib/chart-config-log";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  PASS  ${name}`);
      passed++;
    })
    .catch((error: Error) => {
      console.log(`  FAIL  ${name}\n        ${error.message}`);
      process.exitCode = 1;
    });
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const migration = require("./migrate-shared-charts-proof.js") as {
  migrate: (opts: { dbPath: string; dryRun: boolean; rollback: boolean }) => {
    changed: boolean;
    columnsChanged: string[];
  };
  COLUMNS: { name: string; type: string }[];
};

const PROOF_COLUMNS = [
  "origin_request_id",
  "origin_delivery_action",
  "origin_proof_mode",
  "origin_state",
  "last_read_delivery_action",
  "last_read_at",
];

/** A shared_charts table as it exists in production today: no proof columns. */
function legacyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embedproof-"));
  const dbPath = path.join(dir, "query_log.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE shared_charts (
    id TEXT PRIMARY KEY, tab TEXT NOT NULL, title TEXT, sql TEXT NOT NULL,
    chart_config TEXT, chart_meta TEXT, created_at INTEGER NOT NULL)`);
  db.prepare(
    "INSERT INTO shared_charts (id, tab, title, sql, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("legacy01", "current", "Murders", "SELECT 1 AS n", 1_786_000_000_000);
  db.close();
  return dbPath;
}

function columnsOf(dbPath: string, table: string): string[] {
  const db = new Database(dbPath);
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  db.close();
  return columns;
}

async function main() {
  console.log("\nshared_charts migration");
  {
    const dbPath = legacyFixture();

    await check("--dry-run changes nothing", () => {
      assert.strictEqual(migration.migrate({ dbPath, dryRun: true, rollback: false }).changed, false);
      for (const column of PROOF_COLUMNS) {
        assert.ok(!columnsOf(dbPath, "shared_charts").includes(column));
      }
    });

    await check("adds all six columns and preserves existing charts", () => {
      const result = migration.migrate({ dbPath, dryRun: false, rollback: false });
      assert.strictEqual(result.changed, true);
      const columns = columnsOf(dbPath, "shared_charts");
      for (const column of PROOF_COLUMNS) assert.ok(columns.includes(column), `missing ${column}`);
      const db = new Database(dbPath);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM shared_charts").get() as { n: number }).n;
      db.close();
      assert.strictEqual(n, 1, "the pre-existing chart must survive");
    });

    await check("pre-existing charts are NOT backfilled into looking proven", () => {
      // The whole point of §4's "must not be silently treated as compliant". A
      // backfilled default here would make every legacy chart indistinguishable from
      // one whose originating answer was actually recorded.
      const db = new Database(dbPath);
      const row = db.prepare("SELECT * FROM shared_charts WHERE id = 'legacy01'").get() as Record<string, unknown>;
      db.close();
      for (const column of PROOF_COLUMNS) {
        assert.strictEqual(row[column], null, `${column} must be NULL on a legacy chart`);
      }
    });

    await check("re-running is a no-op", () => {
      assert.strictEqual(migration.migrate({ dbPath, dryRun: false, rollback: false }).changed, false);
    });

    await check("a partially-applied migration completes", () => {
      const partial = legacyFixture();
      const db = new Database(partial);
      db.exec("ALTER TABLE shared_charts ADD COLUMN origin_request_id TEXT");
      db.close();
      const result = migration.migrate({ dbPath: partial, dryRun: false, rollback: false });
      assert.strictEqual(result.changed, true);
      assert.ok(!result.columnsChanged.includes("origin_request_id"), "must not re-add an existing column");
      for (const column of PROOF_COLUMNS) {
        assert.ok(columnsOf(partial, "shared_charts").includes(column));
      }
    });

    await check("rollback removes them and keeps the charts", () => {
      migration.migrate({ dbPath, dryRun: false, rollback: true });
      const columns = columnsOf(dbPath, "shared_charts");
      for (const column of PROOF_COLUMNS) assert.ok(!columns.includes(column), `${column} should be gone`);
      const db = new Database(dbPath);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM shared_charts").get() as { n: number }).n;
      const integrity = db.pragma("integrity_check", { simple: true });
      db.close();
      assert.strictEqual(n, 1);
      assert.strictEqual(integrity, "ok");
    });

    await check("a database with no shared_charts table is handled, not crashed", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embedproof-empty-"));
      const empty = path.join(dir, "query_log.db");
      new Database(empty).close();
      assert.doesNotThrow(() => migration.migrate({ dbPath: empty, dryRun: false, rollback: false }));
    });
  }

  // ---- Real route behavior, against a fixture database ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embedroute-"));
  const dbPath = path.join(dir, "query_log.db");
  const dataPath = path.join(dir, "crime_data.db");
  {
    const data = new Database(dataPath);
    data.exec("CREATE TABLE agency_monthly (year INTEGER, agency TEXT, count INTEGER)");
    data.prepare("INSERT INTO agency_monthly VALUES (?, ?, ?)").run(2020, "Austin", 60);
    data.close();
  }
  // Set BEFORE importing the route: getWriteDb resolves its path on first use.
  process.env.QUERY_LOG_DB_PATH = dbPath;
  process.env.RTCI_DB_PATH = dataPath;
  // Shadow for the bulk of the suite; the off-mode cases below clear it explicitly.
  process.env.PROOF_MODE = "shadow";

  const { POST, GET } = await import("../app/api/embed/route");
  const { NextRequest } = await import("next/server");

  function post(body: unknown) {
    return POST(new NextRequest("http://localhost/api/embed", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }));
  }
  function get(id: string) {
    return GET(new NextRequest(`http://localhost/api/embed?id=${encodeURIComponent(id)}`));
  }

  const CHART = {
    tab: "current",
    title: "Murders in Austin",
    sql: "SELECT year, agency, count FROM agency_monthly",
    chartConfig: { type: "line" as const, xAxis: "year", yAxis: ["count"], title: "Murders in Austin" },
    chartMeta: { source: "RTCI" },
  };

  console.log("\nembed creation records the originating proof");
  {
    // A proven originating answer, as query_log would have recorded it.
    const log = new Database(dbPath);
    log.exec(`CREATE TABLE IF NOT EXISTS query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT, rows INTEGER,
      error TEXT, ms INTEGER, response TEXT, guardrails TEXT, model TEXT, session_id TEXT,
      routing_confidence TEXT, routing_mode TEXT, routing_reason TEXT, query_guidance TEXT,
      query_contract TEXT, chart_config TEXT, request_id TEXT, delivery_action TEXT,
      proof_mode TEXT, proof_manifest TEXT)`);
    // A PROVEN answer: the artifact matches, and the envelope has no blocker. Both
    // halves are required now -- a delivery_action of "answer" alone is what shadow
    // records for every legacy answer and says nothing about proof.
    log.prepare(
      "INSERT INTO query_log (ts, tab, question, sql, chart_config, request_id, delivery_action, proof_mode, proof_manifest) " +
        "VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      1_786_000_000_000,
      "current",
      "murders in Austin",
      CHART.sql,
      serializeChartConfigForLog(CHART.chartConfig, []),
      "req-proven",
      "answer",
      "shadow",
      JSON.stringify({ blocker: null, hypotheticalAction: "answer" }),
    );
    // A SERVED-BUT-BLOCKED answer, which is the ordinary shadow-era state.
    log.prepare(
      "INSERT INTO query_log (ts, tab, question, sql, chart_config, request_id, delivery_action, proof_mode, proof_manifest) " +
        "VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      1_786_000_000_001,
      "current",
      "murders in Austin",
      CHART.sql,
      serializeChartConfigForLog(CHART.chartConfig, []),
      "req-blocked",
      "answer",
      "shadow",
      JSON.stringify({ blocker: "check 'semanticPlan' is 'unknown'", hypotheticalAction: "decline_capability" }),
    );
    log.close();

    let provenId = "";
    let legacyId = "";

    await check("a chart created WITH a request id records its origin", async () => {
      const res = await post({ ...CHART, requestId: "req-proven" });
      const body = await res.json() as { id: string };
      provenId = body.id;
      assert.ok(provenId, "an id must be returned");
      const db = new Database(dbPath);
      const row = db.prepare("SELECT * FROM shared_charts WHERE id = ?").get(provenId) as Record<string, unknown>;
      db.close();
      assert.strictEqual(row.origin_request_id, "req-proven");
      assert.strictEqual(row.origin_delivery_action, "answer");
      assert.strictEqual(row.origin_proof_mode, "shadow");
      assert.strictEqual(row.origin_state, "verified", "the artifact matched and the envelope passed");
    });

    await check("a chart claiming a DIFFERENT query's answer is not verified", async () => {
      // Provenance cannot be borrowed: the SQL must be that answer's SQL.
      const res = await post({ ...CHART, sql: "SELECT 1 AS n FROM agency_monthly", requestId: "req-proven" });
      const { id } = await res.json() as { id: string };
      const db = new Database(dbPath);
      const row = db.prepare("SELECT origin_state FROM shared_charts WHERE id = ?").get(id) as Record<string, unknown>;
      db.close();
      assert.strictEqual(row.origin_state, "unbound");
    });

    await check("a served-but-blocked answer is bound_unproven, not verified", async () => {
      // delivery_action is "answer" here, which is what the old check read.
      const res = await post({ ...CHART, requestId: "req-blocked" });
      const { id } = await res.json() as { id: string };
      const db = new Database(dbPath);
      const row = db.prepare("SELECT origin_state, origin_delivery_action FROM shared_charts WHERE id = ?")
        .get(id) as Record<string, unknown>;
      db.close();
      assert.strictEqual(row.origin_delivery_action, "answer", "what was served is still recorded");
      assert.strictEqual(row.origin_state, "bound_unproven", "but proof did not pass");
    });

    await check("a chart created WITHOUT one is recorded as unproved, not defaulted", () => {
      // The legacy case must stay visible. A default of "answer" here would be the
      // silent-compliance failure §4 forbids.
      return post(CHART).then(async (res) => {
        const body = await res.json() as { id: string };
        legacyId = body.id;
        const db = new Database(dbPath);
        const row = db.prepare("SELECT * FROM shared_charts WHERE id = ?").get(legacyId) as Record<string, unknown>;
        db.close();
        assert.strictEqual(row.origin_request_id, null);
        assert.strictEqual(row.origin_delivery_action, null);
        assert.strictEqual(row.origin_state, "absent", "no claim was made, as distinct from an unmatched one");
      });
    });

    await check("an unknown request id does not fabricate an origin", async () => {
      const res = await post({ ...CHART, requestId: "req-does-not-exist" });
      const { id } = await res.json() as { id: string };
      const db = new Database(dbPath);
      const row = db.prepare("SELECT * FROM shared_charts WHERE id = ?").get(id) as Record<string, unknown>;
      db.close();
      assert.strictEqual(row.origin_request_id, "req-does-not-exist", "the attempted link is kept");
      assert.strictEqual(row.origin_delivery_action, null, "but no proof is invented for it");
      assert.strictEqual(row.origin_state, "unbound", "and it is recorded as unmatched, not absent");
    });

    console.log("\nembed reads finalize, and still serve");
    await check("a read returns the same payload it always did", async () => {
      const res = await get(provenId);
      const body = await res.json() as { tab: string; rows: unknown[]; columns: string[]; chartConfig: unknown };
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.tab, "current");
      assert.deepStrictEqual(body.columns, ["year", "agency", "count"]);
      assert.strictEqual(body.rows.length, 1);
      assert.deepStrictEqual(body.chartConfig, CHART.chartConfig);
    });

    await check("the read records what it would have delivered", async () => {
      await get(provenId);
      const db = new Database(dbPath);
      const row = db.prepare("SELECT last_read_delivery_action, last_read_at FROM shared_charts WHERE id = ?")
        .get(provenId) as { last_read_delivery_action: string | null; last_read_at: number | null };
      db.close();
      // Blocked, because an embed replays SQL it did not author and has no derivation
      // of its own -- which is the honest state, not a defect.
      assert.strictEqual(row.last_read_delivery_action, "decline_capability");
      assert.ok((row.last_read_at ?? 0) > 0, "a read timestamp must be recorded");
    });

    await check("a legacy chart still serves and is recorded as unproved", async () => {
      const res = await get(legacyId);
      assert.strictEqual(res.status, 200, "shadow mode must not stop serving");
      const body = await res.json() as { rows: unknown[] };
      assert.strictEqual(body.rows.length, 1);
      const db = new Database(dbPath);
      const row = db.prepare("SELECT origin_delivery_action, last_read_delivery_action FROM shared_charts WHERE id = ?")
        .get(legacyId) as Record<string, unknown>;
      db.close();
      assert.strictEqual(row.origin_delivery_action, null);
      assert.strictEqual(row.last_read_delivery_action, "decline_capability");
    });

    await check("a missing chart is still a 404", async () => {
      const res = await get("nope0000");
      assert.strictEqual(res.status, 404);
    });

    await check("a missing id is still a 400", async () => {
      const res = await GET(new NextRequest("http://localhost/api/embed"));
      assert.strictEqual(res.status, 400);
    });

    await check("unsafe stored SQL is still rejected", async () => {
      const db = new Database(dbPath);
      db.prepare("INSERT INTO shared_charts (id, tab, title, sql, created_at) VALUES (?,?,?,?,?)")
        .run("evil0001", "current", "bad", "DROP TABLE agency_monthly", Date.now());
      db.close();
      const res = await get("evil0001");
      assert.strictEqual(res.status, 400);
    });

    console.log("\noff mode leaves shared_charts exactly as the baseline would");
    await check("an off-mode creation writes no proof columns at all", async () => {
      // §9.1 again: `off` has no effect. A first revision ran the origin lookup and
      // wrote origin_request_id regardless of mode, producing rows the baseline
      // release would never write. The off-mode test covered only reads and missed it.
      delete process.env.PROOF_MODE;
      let id = "";
      try {
        const res = await post({ ...CHART, requestId: "req-proven" });
        ({ id } = await res.json() as { id: string });
      } finally {
        process.env.PROOF_MODE = "shadow";
      }
      const db = new Database(dbPath);
      const row = db.prepare("SELECT * FROM shared_charts WHERE id = ?").get(id) as Record<string, unknown>;
      db.close();
      assert.ok(row, "the chart is still saved");
      for (const column of PROOF_COLUMNS) {
        assert.strictEqual(row[column], null, `${column} must be NULL when off`);
      }
    });

    await check("an off-mode read records nothing", async () => {
      // §9.1: `off` "performs no request-path work and has no effect". An UPDATE is an
      // effect, so an off-mode deployment must leave this table byte-identical to what
      // the baseline release writes -- the same rule proofLogFields() follows for
      // query_log. An earlier revision wrote the summary unconditionally.
      const db = new Database(dbPath);
      db.prepare("UPDATE shared_charts SET last_read_delivery_action = NULL, last_read_at = NULL WHERE id = ?")
        .run(provenId);
      db.close();

      delete process.env.PROOF_MODE;
      try {
        const res = await get(provenId);
        assert.strictEqual(res.status, 200, "off mode must still serve the chart");
        const body = await res.json() as { rows: unknown[] };
        assert.strictEqual(body.rows.length, 1, "and return the same rows");
      } finally {
        process.env.PROOF_MODE = "shadow";
      }

      const after = new Database(dbPath);
      const row = after.prepare("SELECT last_read_delivery_action, last_read_at FROM shared_charts WHERE id = ?")
        .get(provenId) as { last_read_delivery_action: string | null; last_read_at: number | null };
      after.close();
      assert.strictEqual(row.last_read_delivery_action, null, "off mode must not write a read summary");
      assert.strictEqual(row.last_read_at, null);
    });

    await check("a shadow read then records it again", async () => {
      await get(provenId);
      const db = new Database(dbPath);
      const row = db.prepare("SELECT last_read_delivery_action FROM shared_charts WHERE id = ?")
        .get(provenId) as { last_read_delivery_action: string | null };
      db.close();
      assert.strictEqual(row.last_read_delivery_action, "decline_capability");
    });
  }

  console.log(`\nembed proof tests: ${passed} passed`);
  if (process.exitCode) {
    console.log("embed proof tests: FAILED");
  } else {
    console.log("embed proof tests: passed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
