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
import { serializeChartConfigForLog } from "../lib/chart-config-log";
import {
  verifyEmbedOrigin,
  originIsVerified,
  embedPlanFamily,
  sharedChartsHasProof,
  REQUIRED_SHARED_CHART_COLUMNS,
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

  check("SQL is compared EXACTLY, so any reflow is a mismatch", () => {
    // query_log stores SQL verbatim and only truncates, so the logged copy is either
    // byte-identical or too short to compare. Tolerance bought nothing here and
    // widened what could claim provenance.
    const verdict = verifyEmbedOrigin(db, candidate({ sql: SQL.replace(/ /g, "\n  ") }));
    assert.strictEqual(verdict.state, "unbound");
  });

  check("whitespace INSIDE a literal is not collapsed away", () => {
    // The reported collision: `'New  York'` and `'New York'` are different queries and
    // must never share a fingerprint.
    const doubled = "SELECT 1 FROM t WHERE city = 'New  York'";
    const single = "SELECT 1 FROM t WHERE city = 'New York'";
    const literalDb = makeLog([{ request_id: "req-lit", sql: doubled }]);
    const verdict = verifyEmbedOrigin(literalDb, candidate({ requestId: "req-lit", sql: single }));
    literalDb.close();
    assert.strictEqual(verdict.state, "unbound", "a changed literal must not verify");
  });

  check("column metadata does not defeat the chart comparison", () => {
    // serializeChartConfigForLog records the result's `columns`/`columnCount` alongside
    // the chart fields. The embed route has no result set at creation, so comparing
    // those made every legitimate chart origin unbound. Only chart identity is compared.
    const withColumns = JSON.stringify({
      ...JSON.parse(CHART_JSON),
      columns: ["year", "agency", "murders"],
      columnCount: 3,
    });
    const columnDb = makeLog([{ chart_config: withColumns }]);
    const verdict = verifyEmbedOrigin(columnDb, candidate());
    columnDb.close();
    assert.strictEqual(verdict.state, "verified", verdict.reason);
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

  check("OMITTING the chart config no longer verifies", () => {
    // The presence bypass, which an earlier test explicitly blessed: comparing only
    // when both sides had a configuration meant a client could simply not send one.
    const verdict = verifyEmbedOrigin(db, candidate({ chartConfigJson: null }));
    assert.strictEqual(verdict.state, "unbound");
    assert.match(verdict.reason, /carried a chart configuration and the chart does not/);
  });

  check("ADDING a chart config the answer never had does not verify", () => {
    const noChartDb = makeLog([{ chart_config: null }]);
    const verdict = verifyEmbedOrigin(noChartDb, candidate());
    noChartDb.close();
    assert.strictEqual(verdict.state, "unbound");
    assert.match(verdict.reason, /a configuration the originating answer did not/);
  });

  check("both sides absent is a genuine no-chart export", () => {
    const noChartDb = makeLog([{ chart_config: null }]);
    const verdict = verifyEmbedOrigin(noChartDb, candidate({ chartConfigJson: null }));
    noChartDb.close();
    assert.strictEqual(verdict.state, "verified");
  });

  check("an unparseable chart configuration does not verify", () => {
    const brokenDb = makeLog([{ chart_config: "{not json" }]);
    const verdict = verifyEmbedOrigin(brokenDb, candidate());
    brokenDb.close();
    assert.strictEqual(verdict.state, "unbound");
    assert.match(verdict.reason, /could not be parsed/);
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

console.log("\nwhat the viewer is SHOWN is bound, not just the query");
{
  const CHART = {
    type: "line" as const,
    xAxis: "year",
    yAxis: ["murders"],
    title: "Murders",
    annotations: [{ label: "Policy change", value: 2015, axis: "x" as const }],
  };
  const META = { source: "RTCI", agencyCount: 412, population: 39_500_000 };

  /** As the answer logged it, and as the embed serializes it. */
  const logged = serializeChartConfigForLog(CHART, ["year", "murders"], META);
  const fromEmbed = (config: unknown, meta: unknown) =>
    serializeChartConfigForLog(config as never, [], meta as never);

  check("a legitimate chart with annotations and metadata verifies", () => {
    const db = makeLog([{ chart_config: logged }]);
    const verdict = verifyEmbedOrigin(db, candidate({ chartConfigJson: fromEmbed(CHART, META) }));
    db.close();
    assert.strictEqual(verdict.state, "verified", verdict.reason);
  });

  check("changing an annotation's LABEL is caught, though the count is identical", () => {
    // annotationCount alone was recorded, so a shared chart could rewrite what an
    // annotation claims while keeping the count. Those labels render directly to the
    // viewer in components/ChartPanel.tsx.
    const db = makeLog([{ chart_config: logged }]);
    const tampered = { ...CHART, annotations: [{ label: "Crime doubled here", value: 2015, axis: "x" as const }] };
    const verdict = verifyEmbedOrigin(db, candidate({ chartConfigJson: fromEmbed(tampered, META) }));
    db.close();
    assert.strictEqual(verdict.state, "unbound");
  });

  check("moving an annotation's POSITION is caught", () => {
    const db = makeLog([{ chart_config: logged }]);
    const moved = { ...CHART, annotations: [{ label: "Policy change", value: 2021, axis: "x" as const }] };
    const verdict = verifyEmbedOrigin(db, candidate({ chartConfigJson: fromEmbed(moved, META) }));
    db.close();
    assert.strictEqual(verdict.state, "unbound");
  });

  check("fabricating the POPULATION is caught", () => {
    // chartMeta arrived entirely from the client and was compared against nothing, so a
    // valid request id with matching SQL could bless invented figures. They render as
    // factual claims beneath the chart.
    const db = makeLog([{ chart_config: logged }]);
    const inflated = { ...META, population: 1_000 };
    const verdict = verifyEmbedOrigin(db, candidate({ chartConfigJson: fromEmbed(CHART, inflated) }));
    db.close();
    assert.strictEqual(verdict.state, "unbound");
  });

  check("fabricating the AGENCY COUNT is caught", () => {
    const db = makeLog([{ chart_config: logged }]);
    const verdict = verifyEmbedOrigin(
      db,
      candidate({ chartConfigJson: fromEmbed(CHART, { ...META, agencyCount: 9_999 }) }),
    );
    db.close();
    assert.strictEqual(verdict.state, "unbound");
  });

  check("changing the SOURCE label is caught", () => {
    const db = makeLog([{ chart_config: logged }]);
    const verdict = verifyEmbedOrigin(
      db,
      candidate({ chartConfigJson: fromEmbed(CHART, { ...META, source: "FBI NIBRS" }) }),
    );
    db.close();
    assert.strictEqual(verdict.state, "unbound");
  });

  check("dropping the metadata entirely is caught", () => {
    const db = makeLog([{ chart_config: logged }]);
    const verdict = verifyEmbedOrigin(db, candidate({ chartConfigJson: fromEmbed(CHART, null) }));
    db.close();
    assert.strictEqual(verdict.state, "unbound");
  });

  check("dropping the annotations entirely is caught", () => {
    const db = makeLog([{ chart_config: logged }]);
    const bare = { ...CHART, annotations: undefined };
    const verdict = verifyEmbedOrigin(db, candidate({ chartConfigJson: fromEmbed(bare, META) }));
    db.close();
    assert.strictEqual(verdict.state, "unbound");
  });

  check("the digests never store the annotation text itself", () => {
    // The allowlist's first constraint is that annotation bodies are not recorded. A
    // digest binds what they assert while leaking nothing.
    assert.ok(logged);
    assert.doesNotMatch(logged!, /Policy change/, "annotation text must not appear in the log payload");
    const parsed = JSON.parse(logged!) as Record<string, unknown>;
    assert.strictEqual(typeof parsed.annotationsDigest, "string");
    assert.strictEqual(typeof parsed.chartMetaDigest, "string");
  });
}

console.log("\nthe schema probe covers every column this version uses");
{
  /** shared_charts at a given migration stage. */
  function chartsTable(extra: string[]): Database.Database {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chartsprobe-"));
    const db = new Database(path.join(dir, "query_log.db"));
    db.exec(`CREATE TABLE shared_charts (
      id TEXT PRIMARY KEY, tab TEXT NOT NULL, title TEXT, sql TEXT NOT NULL,
      chart_config TEXT, chart_meta TEXT, created_at INTEGER NOT NULL
      ${extra.length ? "," + extra.map((c) => `${c} TEXT`).join(", ") : ""})`);
    return db;
  }

  check("the PREVIOUS migration shape is rejected", () => {
    // The reported defect: the probe checked two of six columns, so a database with
    // the earlier five-column shape answered true — after which POST inserted
    // origin_state and GET selected it, and every embed request 500'd. A runtime probe
    // exists for deploy-order freedom, which a partial check gives up.
    const db = chartsTable([
      "origin_request_id",
      "origin_delivery_action",
      "origin_proof_mode",
      "last_read_delivery_action",
      "last_read_at",
    ]);
    const result = sharedChartsHasProof(db);
    db.close();
    assert.strictEqual(result, false, "a schema missing origin_state must not be treated as ready");
  });

  check("the full current shape is accepted", () => {
    const db = chartsTable([...REQUIRED_SHARED_CHART_COLUMNS]);
    const result = sharedChartsHasProof(db);
    db.close();
    assert.strictEqual(result, true);
  });

  check("every required column is individually load-bearing", () => {
    // Any one of them missing must fail the probe, since the route reads or writes all.
    for (const omitted of REQUIRED_SHARED_CHART_COLUMNS) {
      const db = chartsTable(REQUIRED_SHARED_CHART_COLUMNS.filter((c) => c !== omitted));
      const result = sharedChartsHasProof(db);
      db.close();
      assert.strictEqual(result, false, `missing ${omitted} should fail the probe`);
    }
  });

  check("an unmigrated table and a missing table both fail", () => {
    const bare = chartsTable([]);
    assert.strictEqual(sharedChartsHasProof(bare), false);
    bare.close();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chartsprobe-none-"));
    const empty = new Database(path.join(dir, "query_log.db"));
    assert.strictEqual(sharedChartsHasProof(empty), false, "no table at all must fail");
    empty.close();
  });

  check("a null or closed handle fails rather than throwing", () => {
    assert.strictEqual(sharedChartsHasProof(null), false);
    const db = chartsTable([...REQUIRED_SHARED_CHART_COLUMNS]);
    db.close();
    assert.doesNotThrow(() => sharedChartsHasProof(db));
    assert.strictEqual(sharedChartsHasProof(db), false);
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
