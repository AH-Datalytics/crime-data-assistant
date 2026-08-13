/**
 * Embed provenance: "proven originating chart" must be a validated property.
 *
 * Two defects made it a label instead, and both are pinned here.
 *
 *   BORROWED PROVENANCE. The first version looked up a request id and read that row's
 *   delivery_action. Nothing compared the client's payload to what the server had
 *   logged, so ANY valid request id blessed ANY read-only SQL the client submitted —
 *   a chart could claim to come from an answer it had no relationship to.
 *
 *   delivery_action IS NOT PROOF. In shadow it records what was actually SERVED, which
 *   is `answer` for essentially every legacy answer in the system, including ones whose
 *   proof was blocked. hypotheticalAction inside the stored envelope is the value that
 *   says whether proof passed — it exists precisely to separate the two, and reading
 *   the wrong one made every shadow-era answer look proven.
 *
 * The negative cases matter more than the positive one here: a verification that
 * accepts too much is worse than none, because it reports success.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  verifyEmbedOrigin,
  originIsVerified,
  embedPlanFamily,
  type OriginVerdict,
} from "../lib/embed-origin";

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

const SQL = "SELECT year, agency, SUM(count) AS murders FROM agency_monthly GROUP BY year";
const CHART_JSON = '{"type":"line","xAxis":"year"}';

/** A proven envelope: no blocker, and the contract would have permitted an answer. */
const PROVEN_ENVELOPE = JSON.stringify({ blocker: null, hypotheticalAction: "answer" });
/** A shadow-era envelope: served an answer, but proof was blocked. */
const BLOCKED_ENVELOPE = JSON.stringify({
  blocker: "check 'semanticPlan' is 'unknown'",
  hypotheticalAction: "decline_capability",
});

function makeLog(rows: Array<Record<string, unknown>>): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embedorigin-"));
  const db = new Database(path.join(dir, "query_log.db"));
  db.exec(`CREATE TABLE query_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT,
    chart_config TEXT, request_id TEXT, delivery_action TEXT, proof_mode TEXT, proof_manifest TEXT)`);
  const insert = db.prepare(
    "INSERT INTO query_log (ts, tab, question, sql, chart_config, request_id, delivery_action, proof_mode, proof_manifest) " +
      "VALUES (@ts, @tab, @question, @sql, @chart_config, @request_id, @delivery_action, @proof_mode, @proof_manifest)",
  );
  for (const row of rows) {
    insert.run({
      ts: 1_786_000_000_000,
      tab: "current",
      question: "murders",
      sql: SQL,
      chart_config: CHART_JSON,
      request_id: "req-1",
      delivery_action: "answer",
      proof_mode: "shadow",
      proof_manifest: PROVEN_ENVELOPE,
      ...row,
    });
  }
  return db;
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    tab: "current",
    sql: SQL,
    chartConfigJson: CHART_JSON,
    ...overrides,
  } as Parameters<typeof verifyEmbedOrigin>[1];
}

console.log("\nthe positive case");
{
  const db = makeLog([{}]);
  check("matching tab, SQL, and chart config with a passing envelope verifies", () => {
    const verdict = verifyEmbedOrigin(db, candidate());
    assert.strictEqual(verdict.state, "verified", verdict.reason);
    assert.strictEqual(originIsVerified(verdict), true);
  });

  check("whitespace reflow in the SQL does not break the binding", () => {
    const verdict = verifyEmbedOrigin(db, candidate({ sql: SQL.replace(/ /g, "\n  ") }));
    assert.strictEqual(verdict.state, "verified");
  });

  check("a chart with no config still binds when the answer logged one", () => {
    // Only compared when both sides have one; an export without a chart is not a
    // provenance failure.
    assert.strictEqual(verifyEmbedOrigin(db, candidate({ chartConfigJson: null })).state, "verified");
  });
  db.close();
}

console.log("\nprovenance cannot be borrowed");
{
  const db = makeLog([{}]);

  check("a DIFFERENT query's SQL is rejected", () => {
    // The reported defect: any valid request id blessed any SQL.
    const verdict = verifyEmbedOrigin(db, candidate({ sql: "SELECT * FROM agency_monthly" }));
    assert.strictEqual(verdict.state, "unbound");
    assert.match(verdict.reason, /not the SQL of the claimed originating answer/);
  });

  check("a changed literal in otherwise-identical SQL is rejected", () => {
    const verdict = verifyEmbedOrigin(db, candidate({ sql: SQL.replace("agency_monthly", "state_monthly") }));
    assert.strictEqual(verdict.state, "unbound");
  });

  check("a mismatched tab is rejected", () => {
    const verdict = verifyEmbedOrigin(db, candidate({ tab: "nibrs" }));
    assert.strictEqual(verdict.state, "unbound");
    assert.match(verdict.reason, /does not match the chart's/);
  });

  check("a mismatched chart configuration is rejected", () => {
    const verdict = verifyEmbedOrigin(db, candidate({ chartConfigJson: '{"type":"bar"}' }));
    assert.strictEqual(verdict.state, "unbound");
    assert.match(verdict.reason, /chart configuration/);
  });

  check("an unknown request id is rejected", () => {
    const verdict = verifyEmbedOrigin(db, candidate({ requestId: "req-nonexistent" }));
    assert.strictEqual(verdict.state, "unbound");
    assert.match(verdict.reason, /no logged answer matches/);
  });

  check("a truncated logged SQL cannot be compared, so it is not accepted", () => {
    // query_log truncates at 4000 characters; equality against a truncated copy would
    // prove nothing either way, so it must not pass.
    const long = "SELECT " + "x".repeat(4100);
    const truncatedDb = makeLog([{ request_id: "req-long", sql: long.slice(0, 4000) }]);
    const verdict = verifyEmbedOrigin(truncatedDb, candidate({ requestId: "req-long", sql: long }));
    truncatedDb.close();
    assert.strictEqual(verdict.state, "unbound");
    assert.match(verdict.reason, /truncated/);
  });

  db.close();
}

console.log("\ndelivery_action is not proof");
{
  check("a served answer whose proof was BLOCKED is bound_unproven, not verified", () => {
    // The second reported defect. In shadow this is the state of essentially every
    // answer in the system, so reading delivery_action made them all look proven.
    const db = makeLog([{ delivery_action: "answer", proof_manifest: BLOCKED_ENVELOPE }]);
    const verdict = verifyEmbedOrigin(db, candidate());
    db.close();
    assert.strictEqual(verdict.state, "bound_unproven");
    assert.strictEqual(originIsVerified(verdict), false);
    assert.strictEqual(verdict.deliveryAction, "answer", "what was served is still recorded");
  });

  check("a missing envelope is not proof", () => {
    const db = makeLog([{ proof_manifest: null }]);
    const verdict = verifyEmbedOrigin(db, candidate());
    db.close();
    assert.strictEqual(verdict.state, "bound_unproven");
  });

  check("an unparseable envelope is not proof", () => {
    const db = makeLog([{ proof_manifest: "{not json" }]);
    const verdict = verifyEmbedOrigin(db, candidate());
    db.close();
    assert.strictEqual(verdict.state, "bound_unproven");
  });

  check("a limited-scope answer with a clean envelope does verify", () => {
    const db = makeLog([{
      delivery_action: "answer_limited_scope",
      proof_manifest: JSON.stringify({ blocker: null, hypotheticalAction: "answer_limited_scope" }),
    }]);
    const verdict = verifyEmbedOrigin(db, candidate());
    db.close();
    assert.strictEqual(verdict.state, "verified");
  });

  check("a clean blocker but a declining hypothetical does not verify", () => {
    const db = makeLog([{ proof_manifest: JSON.stringify({ blocker: null, hypotheticalAction: "decline_data" }) }]);
    const verdict = verifyEmbedOrigin(db, candidate());
    db.close();
    assert.strictEqual(verdict.state, "bound_unproven");
  });
}

console.log("\nabsent and unavailable are distinct from forged");
{
  check("no request id is `absent`, not `unbound`", () => {
    const db = makeLog([{}]);
    const verdict = verifyEmbedOrigin(db, candidate({ requestId: null }));
    db.close();
    assert.strictEqual(verdict.state, "absent");
  });

  check("an unavailable log is `unbound`, never verified", () => {
    const verdict = verifyEmbedOrigin(null, candidate());
    assert.strictEqual(verdict.state, "unbound");
    assert.strictEqual(originIsVerified(verdict), false);
  });

  check("a log lacking the proof columns is `unbound`", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embedorigin-bare-"));
    const db = new Database(path.join(dir, "query_log.db"));
    db.exec("CREATE TABLE query_log (id INTEGER PRIMARY KEY, tab TEXT, sql TEXT)");
    const verdict = verifyEmbedOrigin(db, candidate());
    db.close();
    assert.strictEqual(verdict.state, "unbound");
  });

  check("a broken query degrades rather than throwing", () => {
    const db = makeLog([{}]);
    db.close();
    let verdict: OriginVerdict | undefined;
    assert.doesNotThrow(() => {
      verdict = verifyEmbedOrigin(db, candidate());
    });
    assert.strictEqual(verdict!.state, "unbound");
  });
}

console.log("\nthe verdict reaches the recorded evidence");
{
  check("each state gets its own plan family", () => {
    // The first revision assigned `embed-replay` whenever a request id was merely
    // non-null, so a forged origin and a verified one were indistinguishable in the
    // shadow record.
    const families = new Set(
      (["verified", "bound_unproven", "unbound", "absent"] as const).map((state) =>
        embedPlanFamily({ state, reason: "", deliveryAction: null, proofMode: null }),
      ),
    );
    assert.strictEqual(families.size, 4, "every state must be distinguishable in the record");
    assert.strictEqual(
      embedPlanFamily({ state: "verified", reason: "", deliveryAction: null, proofMode: null }),
      "embed-verified-origin",
    );
  });
}

console.log(`\nembed origin tests: ${passed} passed`);
if (process.exitCode) {
  console.log("embed origin tests: FAILED");
} else {
  console.log("embed origin tests: passed");
}
