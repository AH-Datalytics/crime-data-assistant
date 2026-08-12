// End-to-end test for the chart-audit pipeline: artifacts + receipts must
// produce chart_audit_results.
// Run: npx tsx scripts/test-chart-audit-pipeline.ts
//
// WHY THIS EXISTS. In production on 2026-08-11 the chart chain held 24
// artifacts and 15 render receipts while chart_audit_results was empty. The
// unit tests in scripts/test-chart-audit.ts covered auditChartArtifact() and
// passed throughout, because the defect was not in the audit logic -- the
// runner had simply never executed against those artifacts. A test of the
// scoring function cannot catch a pipeline that is never invoked, so this test
// drives the real runner as a subprocess against a production-shaped fixture
// database and asserts that rows land in the results table.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { buildChartAuditArtifact, type ChartRenderReceipt } from "../lib/chart-audit";
import { CHART_AUDIT_SOURCE, runChartAudit } from "./run-chart-audit";

const repoRoot = path.resolve(__dirname, "..");
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-audit-pipeline-"));
const dbPath = path.join(workDir, "query_log.db");
/**
 * The migration is a standalone node script, so it is still spawned. tsx is not
 * a local dependency, which is why the audit itself is exercised in-process via
 * runChartAudit() rather than through `npx tsx` -- spawning that on Windows
 * requires `shell: true`, which concatenates rather than escapes arguments and
 * breaks on a temp path containing a space (os.tmpdir() under a user profile
 * with a space in the name).
 */
const migrationScript = path.join(repoRoot, "scripts", "migrate-chart-audit-artifacts.js");

/**
 * Kill a process and everything it spawned, then await its exit.
 *
 * TWO defects are fixed here, in order of discovery:
 *
 * 1. `child.kill()` on a shell-launched process kills the shell, not the tree
 *    beneath it. That is how an earlier revision "passed": it killed cmd.exe,
 *    the chart auditor kept running, and the test saw a row that was only
 *    momentarily 'running'. The runner is now spawned directly (no shell), and
 *    this still tree-kills for safety.
 *
 * 2. Waiting on `process.kill(pid, 0)` in a synchronous loop DEADLOCKS on
 *    POSIX. A killed child becomes a zombie until its parent reaps it, and Node
 *    reaps on the event loop -- which a synchronous spin blocks. Signal 0 then
 *    keeps succeeding against the zombie, so the wait ran to its timeout and
 *    failed on Linux while passing on Windows. Reproduced in a Linux container
 *    by Codex: {"alive":true,"exitCode":null,"signalCode":null}.
 *
 * The completion condition is therefore the child's own 'exit' event, never a
 * liveness probe.
 */
async function killTreeAndWait(child: ReturnType<typeof spawn>, timeoutMs = 30_000): Promise<void> {
  const pid = child.pid;
  assert.ok(pid, "spawned child must have a pid");

  if (child.exitCode !== null || child.signalCode !== null) return;

  // Subscribe BEFORE signalling, or a fast exit can fire before we listen.
  const exited = once(child, "exit").then(() => "exited" as const);

  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // Spawned detached, so the pid doubles as the process-group id.
      process.kill(-pid!, "SIGKILL");
    }
  } catch {
    // Already gone, or taskkill raced us; the exit wait below is the check.
  }

  // ref:false so a pending timer cannot keep this process alive after the race.
  const timedOut = delay(timeoutMs, "timeout" as const, { ref: false });
  const outcome = await Promise.race([exited, timedOut]);
  assert.equal(outcome, "exited", `child ${pid} did not exit within ${timeoutMs}ms; the row must not be inspected while it may still be running`);
}

/**
 * Remove a temp directory. STRICT -- a failure fails the suite.
 *
 * This was briefly tolerant, with the EPERM it produced on Windows explained
 * away as OS handle lag. It was not: the interruption test was killing a shell
 * rather than the auditor beneath it, and the surviving process still held the
 * database. A cleanup failure here means something this suite started is still
 * running, which is exactly the condition that would let the interruption
 * assertions pass for the wrong reason -- so it must be loud.
 *
 * Files are removed individually first, which succeeds on Windows in cases
 * where a single recursive remove does not.
 */
function removeDir(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { force: true, maxRetries: 10, retryDelay: 100 });
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * The suite body is async because the interruption case must await the child's
 * exit event -- a synchronous wait cannot work, since the event loop it blocks
 * is the same one that reaps the exited child on POSIX.
 */
async function main(): Promise<void> {
try {
  // A minimal query_log, then the real migration -- so a schema drift in the
  // migration surfaces here rather than in production.
  {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, question TEXT, sql TEXT, rows INTEGER,
      error TEXT, ms INTEGER, response TEXT, tab TEXT, guardrails TEXT, model TEXT, session_id TEXT);
      CREATE TABLE audit_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, query_log_id INTEGER NOT NULL, ts INTEGER NOT NULL,
        severity TEXT NOT NULL, category TEXT NOT NULL, finding TEXT NOT NULL, proposed_fix TEXT,
        status TEXT DEFAULT 'open', source TEXT NOT NULL DEFAULT 'legacy');
      CREATE UNIQUE INDEX idx_audit_findings_unique_v2 ON audit_findings (query_log_id, category, source);
      CREATE TABLE audit_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, suite_version TEXT NOT NULL,
        started_ts INTEGER NOT NULL, finished_ts INTEGER, from_log_id INTEGER, to_log_id INTEGER,
        rows_audited INTEGER, findings_written INTEGER, status TEXT NOT NULL DEFAULT 'running', detail TEXT);
      CREATE INDEX idx_audit_runs_watermark ON audit_runs (source, status, to_log_id);`);
    db.close();
  }

  execFileSync(process.execPath, [migrationScript, dbPath], { cwd: repoRoot, stdio: "pipe" });

  const db = new Database(dbPath);
  for (const table of ["chart_audit_artifacts", "chart_render_receipts", "chart_audit_results"]) {
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
      `${table} must exist after migration`
    );
  }

  // Two production-shaped artifacts: one joined to a query_log row via
  // request_id (the normal case) and one orphaned (a chart captured for a row
  // that was never logged). Both must produce a result row; the orphan is the
  // case most likely to be silently dropped by a JOIN.
  const joinedRequestId = "req-joined-0001";
  const orphanRequestId = "req-orphan-0002";

  db.prepare(
    "INSERT INTO query_log (ts, question, sql, rows, ms, response, tab, model, request_id) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(
    Date.now(),
    "Show murder clearances by type in Las Vegas in 2025",
    "SELECT clearance_outcome, count FROM x",
    3,
    1200,
    "Explanation",
    "nibrs",
    "haiku-4.5",
    joinedRequestId
  );

  const rows = [
    { clearance_outcome: "Cleared by arrest", count: 62 },
    { clearance_outcome: "Death of offender", count: 11 },
    { clearance_outcome: "Not cleared", count: 9 },
  ];
  const insertArtifact = db.prepare(`INSERT INTO chart_audit_artifacts
    (request_id, query_log_id, source, created_at, chart_config, columns_json, data_json, row_count,
     column_count, captured_row_count, captured_column_count, data_hash, truncated, truncation_reason)
    VALUES (@requestId, NULL, @source, @createdAt, @chartConfig, @columnsJson, @dataJson, @rowCount,
     @columnCount, @capturedRowCount, @capturedColumnCount, @dataHash, @truncated, @truncationReason)`);

  for (const requestId of [joinedRequestId, orphanRequestId]) {
    const artifact = buildChartAuditArtifact({
      requestId,
      source: "nibrs",
      chartConfig: { type: "bar", xAxis: "clearance_outcome", yAxis: ["count"], title: "Las Vegas murder clearances by type, 2025" },
      columns: ["clearance_outcome", "count"],
      rows,
    });
    insertArtifact.run({
      requestId: artifact.requestId,
      source: artifact.source,
      createdAt: artifact.createdAt,
      chartConfig: JSON.stringify(artifact.chartConfig),
      columnsJson: JSON.stringify(artifact.columns),
      dataJson: JSON.stringify(artifact.rows),
      rowCount: artifact.rowCount,
      columnCount: artifact.columnCount,
      capturedRowCount: artifact.capturedRowCount,
      capturedColumnCount: artifact.capturedColumnCount,
      dataHash: artifact.dataHash,
      truncated: artifact.truncated ? 1 : 0,
      truncationReason: artifact.truncationReason,
    });
  }

  // A render receipt for the joined artifact only, so the run exercises both the
  // rendered and unrendered branches in one pass.
  const receipt: ChartRenderReceipt = {
    requestId: joinedRequestId,
    component: "NibrsChartPanel",
    chartType: "bar",
    effectiveXKey: "clearance_outcome",
    effectiveYKeys: ["count"],
    lineCount: 0,
    barCount: 3,
    pointCount: 0,
    areaCount: 0,
    legendLabels: [],
    xTickLabels: rows.map((row) => row.clearance_outcome),
    yTickLabels: ["0", "20", "40", "60"],
    svgWidth: 800,
    svgHeight: 400,
    overflow: false,
    zeroSize: false,
    invalidText: false,
    renderError: false,
    viewportClass: "desktop",
    renderedAt: Date.now(),
  };
  db.prepare("INSERT INTO chart_render_receipts (request_id, received_at, receipt_json) VALUES (?,?,?)").run(
    receipt.requestId,
    Date.now(),
    JSON.stringify(receipt)
  );

  const artifactCount = (db.prepare("SELECT COUNT(*) AS n FROM chart_audit_artifacts").get() as { n: number }).n;
  const receiptCount = (db.prepare("SELECT COUNT(*) AS n FROM chart_render_receipts").get() as { n: number }).n;
  assert.equal(artifactCount, 2);
  assert.equal(receiptCount, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM chart_audit_results").get() as { n: number }).n,
    0,
    "results must start empty so the assertion below proves the runner wrote them"
  );
  db.close();

  // Drive the real runner exactly as cron does, passing the db path as argv[2].
  // Invoked through the local tsx binary rather than `npx ... shell:true`, which
  // concatenates rather than escapes its arguments -- a temp path containing a
  // space would break the command.
  const first = runChartAudit(dbPath);
  assert.equal(first.counts.total, 2, "both artifacts must be scored");
  assert.equal(first.accounting.executed, 2);
  assert.equal(first.accounting.failed.length, 0);
  assert.equal(first.verdict.state, "healthy", "a complete run must be healthy");
  assert.equal(first.verdict.cleanReportPermitted, true);

  const verify = new Database(dbPath, { readonly: true });
  const results = verify.prepare("SELECT request_id, query_log_id, status FROM chart_audit_results ORDER BY request_id").all() as Array<{
    request_id: string;
    query_log_id: number | null;
    status: string;
  }>;

  // The core assertion: artifacts + receipts produce results.
  assert.equal(results.length, 2, "every artifact must produce a chart_audit_results row");

  const byRequest = new Map(results.map((row) => [row.request_id, row]));
  const joined = byRequest.get(joinedRequestId);
  const orphan = byRequest.get(orphanRequestId);
  assert.ok(joined, "joined artifact must have a result");
  assert.ok(orphan, "orphaned artifact must have a result, not be dropped by the join");

  // The receipt-backed artifact reaches a rendered verdict; the one without a
  // receipt cannot, and must say so rather than defaulting to a pass.
  assert.equal(joined!.status, "verified-rendered");
  assert.equal(joined!.query_log_id, 1, "request_id join to query_log must resolve");
  assert.equal(orphan!.status, "unverified", "no receipt means unverified, never verified");
  assert.equal(orphan!.query_log_id, null);
  verify.close();

  // Idempotence: cron may run the suite repeatedly over the same artifacts.
  runChartAudit(dbPath);
  const rerun = new Database(dbPath, { readonly: true });
  assert.equal(
    (rerun.prepare("SELECT COUNT(*) AS n FROM chart_audit_results").get() as { n: number }).n,
    2,
    "a second run must upsert, not duplicate"
  );

  // HEALTH REACHES THE REVIEWER. A verdict computed in memory and printed to
  // stdout is a verdict nobody sees; the digest reads audit_runs. Without this
  // record an empty results table and a healthy auditor with nothing to do are
  // indistinguishable -- the exact ambiguity that let production sit with 24
  // artifacts, 15 receipts, and 0 results while every chart was labelled
  // "unverified".
  const runs = rerun.prepare("SELECT source, suite_version, status, rows_audited, detail FROM audit_runs ORDER BY id").all() as Array<{
    source: string;
    suite_version: string;
    status: string;
    rows_audited: number;
    detail: string;
  }>;
  assert.equal(runs.length, 2, "each run must record its health");
  assert.equal(runs[0].source, CHART_AUDIT_SOURCE);
  assert.notEqual(CHART_AUDIT_SOURCE, "phase1-detector", "chart-audit health must not collide with the query auditor's");
  assert.equal(runs[0].status, "ok");
  assert.equal(runs[0].rows_audited, 2);
  assert.match(runs[0].detail, /expected=2 excluded=0 eligible=2 executed=2/);
  // The digest reads this literal; keep the two in step.
  const digestSource = fs.readFileSync(path.join(repoRoot, "scripts", "daily-query-analysis.js"), "utf8");
  assert.match(digestSource, new RegExp(`CHART_AUDIT_SOURCE = "${CHART_AUDIT_SOURCE}"`), "digest must read the same audit_runs source");
  rerun.close();

  // A MALFORMED ARTIFACT must be individually accounted, must not abort the
  // batch, and must stop the run being reported as clean.
  {
    const corrupt = new Database(dbPath);
    corrupt.prepare("UPDATE chart_audit_artifacts SET chart_config = ? WHERE request_id = ?").run("{not json", orphanRequestId);
    corrupt.close();

    const result = runChartAudit(dbPath);
    assert.equal(result.accounting.failed.length, 1, "the malformed artifact must be recorded as failed");
    assert.equal(result.accounting.failed[0].id, orphanRequestId);
    assert.equal(result.counts.total, 1, "the healthy artifact must still be scored");
    assert.equal(result.accounting.executed, 1);
    assert.equal(result.verdict.state, "incomplete");
    assert.equal(result.verdict.cleanReportPermitted, false, "a run with a failed artifact is not clean");

    const health = new Database(dbPath, { readonly: true });
    const latest = health.prepare("SELECT status, detail FROM audit_runs ORDER BY id DESC LIMIT 1").get() as { status: string; detail: string };
    assert.equal(latest.status, "incomplete", "a non-clean run must not be recorded as ok");
    assert.match(latest.detail, new RegExp(orphanRequestId), "the failing artifact must be named in the record");
    health.close();
  }

  // AN INTERRUPTED RUN must leave evidence it started. The wrapper bounds this
  // suite at 300s and escalates to SIGKILL, so a process that dies mid-audit is
  // reachable -- and recording health only on completion would leave no trace,
  // which the digest would read as "never ran" rather than "ran and died".
  //
  // The REAL runner is spawned and killed here. An earlier revision inserted a
  // 'running' row by hand, which only proved the schema permits that state, not
  // that run-chart-audit.ts reaches it. CHART_AUDIT_TEST_PAUSE_MS holds the
  // child immediately after it claims its row (see pauseForInterruptionTest).
  {
    const claimed = new Database(dbPath, { readonly: true });
    const before = (claimed.prepare("SELECT COUNT(*) AS n FROM audit_runs").get() as { n: number }).n;
    claimed.close();

    // Spawn the runner as a DIRECT node child, with no shell.
    //
    // process.execArgv carries the tsx loader flags this suite is already
    // running under (--require .../preflight.cjs --import .../loader.mjs), so
    // reusing them runs the TypeScript runner without npx and without cmd.exe.
    // That matters for correctness, not tidiness: with a shell in between,
    // killing the child kills only the shell.
    //
    // The database path travels in QUERY_LOG_DB_PATH -- which resolveDbPath()
    // already honours -- so no argument can be split by a path containing a
    // space.
    assert.ok(
      process.execArgv.some((flag) => /tsx/.test(flag)),
      "this suite must run under tsx (npm test / npx tsx) so the child can inherit its loader"
    );
    const child = spawn(process.execPath, [...process.execArgv, path.join(repoRoot, "scripts", "run-chart-audit.ts")], {
      cwd: repoRoot,
      env: { ...process.env, QUERY_LOG_DB_PATH: dbPath, CHART_AUDIT_TEST_PAUSE_MS: "15000" },
      stdio: "ignore",
      // A process group on POSIX so the whole group can be signalled; Windows
      // uses taskkill /T instead.
      detached: process.platform !== "win32",
    });

    // Wait for the child's own claim to land, then kill it mid-run.
    //
    // Under a loaded full-suite run, node startup plus tsx transpilation can
    // take seconds, so the deadline is generous. If the child dies before
    // claiming, stop waiting immediately and say so -- spinning to the deadline
    // and then reporting "no row" would hide the real cause (a child that
    // failed to start) behind a timeout.
    // Awaited rather than spun on: the event loop must keep turning so Node can
    // observe the child's state at all (see killTreeAndWait). Early exit is
    // detected from child.exitCode, which only becomes non-null once the loop
    // has processed the exit -- a liveness probe would report a zombie as alive.
    const deadline = Date.now() + 60_000;
    let claimedRunId: number | null = null;
    let childExitedEarly = false;
    while (Date.now() < deadline && claimedRunId === null) {
      const poll = new Database(dbPath, { readonly: true });
      const row = poll.prepare("SELECT id FROM audit_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1").get() as
        | { id: number }
        | undefined;
      poll.close();
      if (row) {
        claimedRunId = row.id;
      } else if (child.exitCode !== null || child.signalCode !== null) {
        childExitedEarly = true;
        break;
      } else {
        await delay(100);
      }
    }
    assert.equal(
      childExitedEarly,
      false,
      `the spawned runner exited before claiming a row (exit=${child.exitCode}, signal=${child.signalCode}); ` +
        "it failed to start rather than being interrupted"
    );
    assert.notEqual(
      claimedRunId,
      null,
      `the runner must claim a 'running' row before auditing; none appeared within 60s (exit=${child.exitCode}, signal=${child.signalCode})`
    );

    // Kill the whole tree and await the child's exit. Inspecting the row while
    // the auditor might still be running would let a momentarily-'running' row
    // pass as proof of a durable interrupted state.
    await killTreeAndWait(child);

    const after = new Database(dbPath, { readonly: true });
    const rows = (after.prepare("SELECT COUNT(*) AS n FROM audit_runs").get() as { n: number }).n;
    const stuck = after.prepare("SELECT source, status, finished_ts FROM audit_runs WHERE id = ?").get(claimedRunId) as {
      source: string;
      status: string;
      finished_ts: number | null;
    };
    after.close();
    assert.equal(rows, before + 1, "an interrupted run must leave exactly one new record");
    assert.equal(stuck.source, CHART_AUDIT_SOURCE);
    assert.equal(stuck.status, "running", "a killed run stays 'running' -- the readable signal that it did not finish");
    assert.equal(stuck.finished_ts, null, "no finish timestamp means no audited-through watermark");

    // A completed run afterwards must claim its OWN row, never adopt the stuck
    // one, so the interrupted run stays visible to the reviewer.
    const next = runChartAudit(dbPath);
    const verify2 = new Database(dbPath, { readonly: true });
    const stillStuck = verify2
      .prepare("SELECT COUNT(*) AS n FROM audit_runs WHERE status = 'running'")
      .get() as { n: number };
    const latest = verify2.prepare("SELECT status, finished_ts FROM audit_runs ORDER BY id DESC LIMIT 1").get() as {
      status: string;
      finished_ts: number | null;
    };
    verify2.close();
    assert.equal(stillStuck.n, 1, "the interrupted run must not be silently repaired by a later run");
    assert.notEqual(latest.finished_ts, null, "the new run records its own finish");
    assert.equal(latest.status, next.verdict.cleanReportPermitted ? "ok" : next.verdict.state);
  }

  // MISSING SCHEMA is invalid, not clean -- and still leaves a record, so the
  // reviewer can tell the auditor tried and could not run.
  {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "chart-audit-bare-"));
    const barePath = path.join(bareDir, "query_log.db");
    try {
      const bare = new Database(barePath);
      bare.exec(`CREATE TABLE query_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, question TEXT);
        CREATE TABLE audit_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, suite_version TEXT NOT NULL,
          started_ts INTEGER NOT NULL, finished_ts INTEGER, from_log_id INTEGER, to_log_id INTEGER,
          rows_audited INTEGER, findings_written INTEGER, status TEXT NOT NULL DEFAULT 'running', detail TEXT);`);
      bare.close();

      assert.throws(() => runChartAudit(barePath), /schema is not installed/);

      const recorded = new Database(barePath, { readonly: true });
      const row = recorded.prepare("SELECT status, detail FROM audit_runs ORDER BY id DESC LIMIT 1").get() as
        | { status: string; detail: string }
        | undefined;
      assert.ok(row, "a run that could not start must still be recorded");
      assert.equal(row!.status, "error");
      assert.match(row!.detail, /INVALID|schema is not installed/);
      recorded.close();
    } finally {
      removeDir(bareDir);
    }
  }
} finally {
  removeDir(workDir);
}
}

main()
  .then(() => console.log("chart-audit pipeline tests passed"))
  .catch((error) => {
    // Surface the failure and set a non-zero exit explicitly: an unhandled
    // rejection in an async entry point would otherwise be easy to miss in the
    // middle of a long `npm test` run.
    console.error(error);
    process.exitCode = 1;
  });
