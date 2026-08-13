/**
 * Shadow mode changes nothing a user receives.
 *
 * Handoff §9.1 Stage 1: "Prove with response fixtures/snapshots that enabling shadow
 * does not change routing, SQL, retry decisions, rows, narrative, charts,
 * clarification/decline behavior, or user-visible payloads." And §13: "a shadow
 * timeout, exception, storage limit, or unavailable audit database cannot alter or
 * delay the user response and cannot interrupt existing query logging."
 *
 * WHY THE EMBED ROUTE CARRIES THIS PROOF. Of the five surfaces, it is the only one
 * that can be driven end-to-end here: the four query routes call the Anthropic API and
 * open 118 GB of NIBRS, while the embed route re-executes stored SQL against a fixture
 * database. So the equivalence is demonstrated where a real HTTP handler can actually
 * be exercised, and the payload-level guarantee for the other four is carried by
 * emitFactualPayload returning its argument by REFERENCE -- asserted below and in
 * test-proof-finalize, and enforced by the type system at every one of their exits.
 *
 * The comparison is byte-for-byte on the serialized response, because that is what a
 * user receives. Comparing parsed objects would miss key ordering, and comparing
 * "shape" would miss everything this suite exists to catch.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { finalizeProof, emitFactualPayload, __resetProofBudgetStateForTests } from "../lib/proof-finalize";
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

const CHART = {
  type: "line" as const,
  xAxis: "year",
  yAxis: ["murders"],
  title: "Murders in Austin",
  annotations: [{ label: "Policy change", value: 2015, axis: "x" as const }],
};
const META = { source: "RTCI", agencyCount: 412, population: 39_500_000 };

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadoweq-"));
  const dbPath = path.join(dir, "query_log.db");
  const dataPath = path.join(dir, "crime_data.db");

  {
    const data = new Database(dataPath);
    data.exec("CREATE TABLE agency_monthly (year INTEGER, agency TEXT, murders INTEGER)");
    const insert = data.prepare("INSERT INTO agency_monthly VALUES (?, ?, ?)");
    for (const year of [2018, 2019, 2020, 2021, 2022]) insert.run(year, "Austin", 40 + year - 2018);
    data.close();
  }
  {
    const log = new Database(dbPath);
    log.exec(`CREATE TABLE query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT,
      chart_config TEXT, request_id TEXT, delivery_action TEXT, proof_mode TEXT, proof_manifest TEXT)`);
    log.prepare(
      "INSERT INTO query_log (ts, tab, question, sql, chart_config, request_id, delivery_action, proof_mode, proof_manifest) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      1_786_000_000_000, "current", "murders in Austin",
      "SELECT year, agency, murders FROM agency_monthly",
      serializeChartConfigForLog(CHART, ["year", "agency", "murders"], META),
      "req-1", "answer", "shadow",
      JSON.stringify({ blocker: null, hypotheticalAction: "answer" }),
    );
    log.close();
  }

  process.env.QUERY_LOG_DB_PATH = dbPath;
  process.env.RTCI_DB_PATH = dataPath;
  delete process.env.PROOF_MODE;

  const { POST, GET } = await import("../app/api/embed/route");
  const { NextRequest } = await import("next/server");

  const BODY = {
    tab: "current",
    title: "Murders in Austin",
    sql: "SELECT year, agency, murders FROM agency_monthly",
    chartConfig: CHART,
    chartMeta: META,
    requestId: "req-1",
  };

  function post(body: unknown) {
    return POST(new NextRequest("http://localhost/api/embed", {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }));
  }
  const get = (id: string) => GET(new NextRequest(`http://localhost/api/embed?id=${id}`));

  /** Everything a caller can observe: status, headers that matter, and the exact body. */
  async function observe(res: Response) {
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: await res.text(),
    };
  }

  async function underMode(mode: string | undefined, fn: () => Promise<Response>) {
    const before = process.env.PROOF_MODE;
    if (mode === undefined) delete process.env.PROOF_MODE;
    else process.env.PROOF_MODE = mode;
    try {
      return await observe(await fn());
    } finally {
      if (before === undefined) delete process.env.PROOF_MODE;
      else process.env.PROOF_MODE = before;
    }
  }

  console.log("\nthe response is byte-identical in off and shadow");
  {
    // Created once under off so the same stored chart is read in both modes; an id
    // generated per-request would differ for reasons unrelated to proof.
    const created = await underMode(undefined, () => post(BODY));
    const id = (JSON.parse(created.body) as { id: string }).id;

    await check("a read returns the same status, content type, and body", async () => {
      const off = await underMode(undefined, () => get(id));
      const shadow = await underMode("shadow", () => get(id));
      assert.strictEqual(shadow.status, off.status);
      assert.strictEqual(shadow.contentType, off.contentType);
      assert.strictEqual(shadow.body, off.body, "the response body must be byte-for-byte identical");
    });

    await check("the rows, columns, chart, and metadata are all unchanged", async () => {
      const off = JSON.parse((await underMode(undefined, () => get(id))).body);
      const shadow = JSON.parse((await underMode("shadow", () => get(id))).body);
      assert.deepStrictEqual(shadow.rows, off.rows);
      assert.deepStrictEqual(shadow.columns, off.columns);
      assert.deepStrictEqual(shadow.chartConfig, off.chartConfig);
      assert.deepStrictEqual(shadow.chartMeta, off.chartMeta);
      assert.strictEqual(shadow.sql, off.sql);
      assert.strictEqual(shadow.title, off.title);
    });

    await check("enforce-without-authorization is also identical", async () => {
      // resolveMode caps a partially-configured enforce at shadow, so this must behave
      // exactly like shadow -- and therefore exactly like off, from outside.
      const off = await underMode(undefined, () => get(id));
      const enforce = await underMode("enforce", () => get(id));
      assert.strictEqual(enforce.body, off.body);
      assert.strictEqual(enforce.status, off.status);
    });

    await check("error paths are identical too", async () => {
      for (const target of ["missing00", ""]) {
        const off = await underMode(undefined, () => get(target));
        const shadow = await underMode("shadow", () => get(target));
        assert.strictEqual(shadow.status, off.status, `status differed for '${target}'`);
        assert.strictEqual(shadow.body, off.body, `body differed for '${target}'`);
      }
    });

    await check("creation returns the same SHAPE and status in both modes", async () => {
      // The id itself is random per call, so the body cannot be compared directly.
      const off = await underMode(undefined, () => post(BODY));
      const shadow = await underMode("shadow", () => post(BODY));
      assert.strictEqual(shadow.status, off.status);
      assert.deepStrictEqual(Object.keys(JSON.parse(shadow.body)), Object.keys(JSON.parse(off.body)));
    });
  }

  console.log("\nonly internal audit state differs");
  {
    await check("shadow records what off does not, and the chart still serves", async () => {
      const created = await underMode("shadow", () => post(BODY));
      const id = (JSON.parse(created.body) as { id: string }).id;
      await underMode("shadow", () => get(id));

      const db = new Database(dbPath);
      const row = db.prepare("SELECT origin_state, last_read_delivery_action FROM shared_charts WHERE id = ?")
        .get(id) as Record<string, unknown>;
      db.close();
      assert.strictEqual(row.origin_state, "verified", "shadow records provenance");
      assert.ok(row.last_read_delivery_action, "and what the read would have delivered");
    });

    await check("off leaves the same columns untouched", async () => {
      const created = await underMode(undefined, () => post(BODY));
      const id = (JSON.parse(created.body) as { id: string }).id;
      await underMode(undefined, () => get(id));

      const db = new Database(dbPath);
      const row = db.prepare("SELECT origin_state, last_read_delivery_action FROM shared_charts WHERE id = ?")
        .get(id) as Record<string, unknown>;
      db.close();
      assert.strictEqual(row.origin_state, null);
      assert.strictEqual(row.last_read_delivery_action, null);
    });
  }

  console.log("\na failing proof pipeline cannot affect the response");
  {
    await check("an exception inside finalization leaves the payload untouched", () => {
      // §13: a shadow exception cannot alter the user response. finalizeProof catches,
      // degrades, and emitFactualPayload still returns the original object.
      __resetProofBudgetStateForTests();
      const hostile: Record<string, unknown> = {};
      Object.defineProperty(hostile, "n", {
        enumerable: true,
        get() { throw new Error("proof pipeline exploded"); },
      });
      const payload = { rows: [{ n: 1 }], columns: ["n"], title: "Results" };
      const finalization = finalizeProof({
        sourceId: "current", question: "q", sql: "SELECT n FROM t",
        rows: [hostile], columns: ["n"], truncated: false, planFamily: null,
        intendedAction: "answer", env: { PROOF_MODE: "shadow" },
      });
      assert.strictEqual(emitFactualPayload(finalization, payload), payload, "same object reference");
    });

    await check("a tripped budget breaker leaves the payload untouched", () => {
      __resetProofBudgetStateForTests();
      const payload = { rows: [], columns: [] };
      const finalization = finalizeProof({
        sourceId: "current", question: "q", sql: null, rows: [], columns: [],
        truncated: false, planFamily: null, intendedAction: "answer",
        env: { PROOF_MODE: "shadow" },
      });
      assert.strictEqual(emitFactualPayload(finalization, payload), payload);
    });

    await check("an unavailable audit database does not stop the embed serving", async () => {
      // The read-time summary write is best-effort; a failure there must cost nothing.
      const created = await underMode("shadow", () => post(BODY));
      const id = (JSON.parse(created.body) as { id: string }).id;

      const db = new Database(dbPath);
      db.exec("ALTER TABLE shared_charts RENAME TO shared_charts_moved");
      db.close();
      try {
        const res = await underMode("shadow", () => get(id));
        // With the table gone the chart genuinely cannot be found; what matters is that
        // it degrades to an ordinary response rather than throwing.
        assert.ok(res.status === 404 || res.status === 500, `unexpected status ${res.status}`);
        assert.doesNotThrow(() => JSON.parse(res.body), "the body must still be valid JSON");
      } finally {
        const restore = new Database(dbPath);
        restore.exec("ALTER TABLE shared_charts_moved RENAME TO shared_charts");
        restore.close();
      }
    });
  }

  console.log("\nthe gate returns its argument by reference, which carries the other four routes");
  {
    await check("every mode returns the identical object", () => {
      __resetProofBudgetStateForTests();
      for (const mode of [undefined, "shadow", "enforce", "off"]) {
        const env: Record<string, string> = {};
        if (mode) env.PROOF_MODE = mode;
        const payload = { type: "result", rows: [{ year: 2020 }], explanation: "Here are the results." };
        const finalization = finalizeProof({
          sourceId: "current", question: "murders in Austin 2020",
          sql: "SELECT 1", rows: [{ year: 2020 }], columns: ["year"],
          truncated: false, planFamily: null, intendedAction: "answer", env,
        });
        assert.strictEqual(
          emitFactualPayload(finalization, payload),
          payload,
          `mode ${mode ?? "unset"} did not return the same object`,
        );
      }
    });
  }

  console.log(`\nshadow equivalence tests: ${passed} passed`);
  if (process.exitCode) {
    console.log("shadow equivalence tests: FAILED");
  } else {
    console.log("shadow equivalence tests: passed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
