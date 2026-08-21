/**
 * Handler-level proof that a statewide Historical clearance question never executes SQL.
 *
 * WHY THIS EXISTS SEPARATELY FROM test-historical-clearance-grain.ts. That suite proves the
 * property at the validator boundary and proves placement by reading route source. Both are true
 * and neither runs the route. Source order says the gate is written before `db.prepare`; it does not
 * say the gate is REACHED on this input. A capability rule, a guardrail rewrite, a deterministic
 * plan, or an early return could each answer this question before the gate ever runs, and every
 * assertion in that suite would still pass. So this suite invokes the real POST handler.
 *
 * WHY EXECUTION IS OBSERVED AT better-sqlite3, NOT INFERRED FROM THE PAYLOAD. An empty `rows` array
 * proves the caller saw no data; it does not prove no query ran. A route could execute the wrong
 * SQL, discard the result, and still emit an empty payload -- which is a wrong answer that merely
 * failed to be displayed. `Database.prototype.prepare` is patched to record every statement, so the
 * assertion is about what the process DID, not about what the response happened to contain.
 *
 * WHAT MAKES THIS NON-VACUOUS. The stub returns exactly the SQL the corpus shows was really used --
 * `SELECT year, rape_rate FROM national_clearance_rate` -- for exactly the question the corpus shows
 * was really asked. That SQL runs fine against the fixture and returns rows, so the positive control
 * proves the pipeline can reach `prepare` with it. If the decline stopped working, the factual SQL
 * would appear in the recorded statements and the negative case would fail.
 *
 * HOW TO CONFIRM THIS SUITE IS LIVE. Disable the enforcement insertion in
 * lib/query-contract-validator.ts -- replace the `blockReasons.push(...)` line with
 * `void clearanceGrainObservation;` -- and the decline case must fail with the factual SQL recorded.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
    failed++;
    process.exitCode = 1;
  }
}

/* ---------------------------------------------------------------- */
/*  Execution observer: every prepared statement in this process     */
/* ---------------------------------------------------------------- */

const preparedSql: string[] = [];
{
  const proto = (Database as unknown as { prototype: { prepare: (sql: string) => unknown } }).prototype;
  const realPrepare = proto.prepare;
  proto.prepare = function patchedPrepare(this: unknown, sql: string) {
    preparedSql.push(sql);
    return realPrepare.call(this, sql);
  };
}
const resetPrepared = () => { preparedSql.length = 0; };
/** Did the model's factual SQL actually reach the database? */
const factualSqlExecuted = (needle: string) => preparedSql.some((s) => s.includes(needle));

/** A page token must be between 1 second and 1 hour old, so a freshly generated one fails. */
function agedPageToken(): string {
  const secret = process.env.AUTH_PASSWORD || "nibrs-page-token-secret";
  const ts = String(Date.now() - 5_000);
  const sig = createHmac("sha256", secret).update(ts).digest("hex").slice(0, 16);
  return Buffer.from(`${ts}:${sig}`).toString("base64");
}

/** The route rate-limits per IP and this suite issues several requests. */
let ipCounter = 0;
const nextIp = () => `10.9.${(ipCounter += 1) % 250}.1`;

type ModelReply = { sql: string; explanation: string; title?: string };

function installModelStub(initial: ModelReply) {
  const realFetch = globalThis.fetch;
  let reply = initial;
  let translateCalls = 0;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
    if (!url.includes("api.anthropic.com")) {
      return (realFetch as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
    }
    let isTranslate = false;
    try {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
      const system = String((Array.isArray(body.system) ? body.system[0]?.text : body.system) ?? "");
      isTranslate = system.includes("SQL query generator") || system.includes("translates natural-language questions");
    } catch { /* treated as a narrative call */ }
    if (isTranslate) translateCalls += 1;
    return new Response(JSON.stringify({
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{
        type: "text",
        text: isTranslate
          ? JSON.stringify({ sql: reply.sql, explanation: reply.explanation, title: reply.title ?? "", chartHint: "none", xAxis: "", yAxis: "" })
          : reply.explanation,
      }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
  return {
    setReply: (next: ModelReply) => { reply = next; },
    translateCalls: () => translateCalls,
    restore: () => { globalThis.fetch = realFetch; },
  };
}

const TEMP_PREFIX = "histclearance-";

/**
 * Remove one fixture directory, best effort.
 *
 * Best effort is not laziness here. The route caches its database handles at module scope and never
 * closes them, so on Windows the fixture files are still open when this process finishes -- an
 * unlink can legitimately fail with EBUSY. A cleanup failure must never turn a passing suite red, so
 * this swallows the error and leaves the directory for the sweep below to collect next run.
 */
function removeQuietly(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return !fs.existsSync(dir);
  } catch {
    return false;
  }
}

/**
 * Collect fixture directories that earlier runs could not delete.
 *
 * This is the half of the cleanup that actually works on Windows: by the time the next run starts,
 * the previous process has exited and released its handles.
 *
 * The five-minute floor is a courtesy to a concurrently running copy of this suite, not the real
 * safeguard. The real safeguard is that a directory whose files are still open CANNOT be deleted --
 * `removeQuietly` fails and skips it -- so being slightly too eager here is harmless, while being too
 * conservative is how the directories accumulated.
 */
function sweepStaleFixtures(): number {
  const cutoff = Date.now() - 5 * 60 * 1000;
  let swept = 0;
  try {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (!entry.startsWith(TEMP_PREFIX)) continue;
      const full = path.join(os.tmpdir(), entry);
      try {
        if (fs.statSync(full).mtimeMs > cutoff) continue;
      } catch { continue; }
      if (removeQuietly(full)) swept += 1;
    }
  } catch { /* the temp directory is unreadable; nothing to sweep */ }
  return swept;
}

/** Module scope so the failure path can clean up too, not just the normal exit. */
let fixtureDir: string | null = null;

async function main() {
  const swept = sweepStaleFixtures();
  if (swept > 0) console.log(`  (swept ${swept} stale fixture director${swept === 1 ? "y" : "ies"} from earlier runs)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  fixtureDir = dir;
  const paths = {
    rtci: path.join(dir, "crime_data.db"),
    log: path.join(dir, "query_log.db"),
    nibrs: path.join(dir, "nibrs.db"),
    rollup: path.join(dir, "nibrs_rollups.db"),
    shr: path.join(dir, "shr.db"),
    hc: path.join(dir, "hate_crime.db"),
  };

  // WAL on every fixture: getManagedDb opens readonly and then sets journal_mode = WAL, which needs
  // write access on a freshly created `delete`-mode file and otherwise throws.
  {
    const db = new Database(paths.rtci);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE agencies (ori TEXT, agency_name TEXT, state TEXT, total_months INTEGER);
      CREATE TABLE agency_monthly (ori TEXT, agency_name TEXT, agency TEXT, state TEXT, year INTEGER, month INTEGER, murders INTEGER, population INTEGER);
      CREATE TABLE agency_population (ori TEXT, year INTEGER, population INTEGER);
      CREATE TABLE historical_state_national (state TEXT, year INTEGER, population INTEGER, murder INTEGER, rape INTEGER, rape_rate REAL, murder_rate REAL);
      CREATE TABLE national_clearance_rate (year INTEGER, violent_rate REAL, property_rate REAL, murder_rate REAL, rape_rate REAL);
      CREATE TABLE historical_agency (ori TEXT, agency TEXT, state TEXT, type TEXT, start INTEGER, end INTEGER);
      CREATE TABLE historical_agency_clearance (ori TEXT, year INTEGER, murder_clr REAL, rape_clr REAL, violent_clr REAL);
      CREATE TABLE historical_agency_crime (ori TEXT, year INTEGER, population INTEGER, violent INTEGER, murder INTEGER, rape INTEGER);
      CREATE TABLE historical_agency_population (ori TEXT, year INTEGER, population INTEGER);
      CREATE TABLE historical_staffing (ori TEXT, year INTEGER, all_total INTEGER, officer_total INTEGER, civilian_total INTEGER);
    `);
    const stateIns = db.prepare("INSERT INTO historical_state_national VALUES (?,?,?,?,?,?,?)");
    const natIns = db.prepare("INSERT INTO national_clearance_rate VALUES (?,?,?,?,?)");
    const agIns = db.prepare("INSERT INTO historical_agency_clearance VALUES (?,?,?,?,?)");
    for (const year of [2020, 2021, 2022, 2023, 2024]) {
      stateIns.run("Florida", year, 22_000_000, 1200, 6500, 27.9, 5.4);
      // The two rape_rate columns hold unrelated quantities. Both are present here on purpose: the
      // collision is the defect, so the fixture has to be able to express it.
      natIns.run(year, 45.0, 16.0, 57.8, 27.2);
      agIns.run("FL0010100", year, 60.0, 8.3, 45.0);
    }
    db.prepare("INSERT INTO historical_agency VALUES (?,?,?,?,?,?)").run("FL0010100", "Gainesville", "fl", "city", 1960, 2025);
    db.prepare("INSERT INTO agencies VALUES (?,?,?,?)").run("TX0001", "Austin", "TX", 96);
    db.prepare("INSERT INTO agency_population VALUES (?,?,?)").run("TX0001", 2022, 950_000);
    db.close();
  }
  {
    const db = new Database(paths.log);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT,
      row_count INTEGER, error TEXT, duration_ms INTEGER, response TEXT, guardrails TEXT,
      model TEXT, session_id TEXT, chart_config TEXT, request_id TEXT, model_response TEXT,
      delivery_action TEXT, proof_mode TEXT, proof_manifest TEXT)`);
    db.close();
  }
  for (const [p, ddl] of [
    [paths.nibrs, "CREATE TABLE summary_victim_state_monthly (state TEXT, year INTEGER, month INTEGER, offense TEXT, victim_count INTEGER)"],
    [paths.rollup, "CREATE TABLE rollup_meta (key TEXT, value TEXT)"],
    [paths.shr, "CREATE TABLE incidents (ori TEXT, year INTEGER, month INTEGER, state TEXT, agency TEXT, homicide_type TEXT, victim_count INTEGER)"],
    [paths.hc, "CREATE TABLE hate_crime_incidents (incident_number TEXT, ori TEXT, year INTEGER, state_abbr TEXT, bias_motivation TEXT, offense_name TEXT, victim_count INTEGER)"],
  ] as Array<[string, string]>) {
    const db = new Database(p);
    db.pragma("journal_mode = WAL");
    db.exec(ddl);
    db.close();
  }

  // Set before importing the route: lib/claude.ts builds its client at module scope and
  // lib/dynamic-facts.ts introspects every database at module load.
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-stub";
  process.env.RTCI_DB_PATH = paths.rtci;
  process.env.QUERY_LOG_DB_PATH = paths.log;
  process.env.NIBRS_DB_PATH = paths.nibrs;
  process.env.NIBRS_ROLLUP_DB_PATH = paths.rollup;
  process.env.SHR_DB_PATH = paths.shr;
  process.env.HATE_CRIME_DB_PATH = paths.hc;
  delete process.env.PROOF_MODE;

  // The exact SQL the replay corpus shows was really used for the declined question (#5382, #5670,
  // #5877): the national table, whose rape_rate is a CLEARANCE percentage and which has no state
  // column at all, so the state filter silently disappears.
  const WRONG_NATIONAL_SQL =
    "SELECT year, rape_rate FROM national_clearance_rate ORDER BY year";

  const stub = installModelStub({ sql: WRONG_NATIONAL_SQL, explanation: "Rape clearance rate." });
  const { NextRequest } = await import("next/server");
  const { POST } = (await import("../app/api/query/route")) as { POST: (req: unknown) => Promise<Response> };
  const { buildQueryContract } = await import("../lib/query-contract");
  const { observeHistoricalClearanceGrain } = await import("../lib/historical-clearance-grain");

  /**
   * The response is an SSE stream of several events, so the terminal payload has to be picked out of
   * it rather than sliced between the first and last brace.
   */
  function resultEvent(body: string): Record<string, unknown> {
    const payloads: Record<string, unknown>[] = [];
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try { payloads.push(JSON.parse(raw) as Record<string, unknown>); } catch { /* not JSON: skipped */ }
    }
    const result = payloads.reverse().find((p) => p.type === "result" || "rowCount" in p || "explanation" in p);
    assert.ok(result, `no result event in the stream:\n        ${body.slice(0, 500)}`);
    return result!;
  }

  async function ask(question: string) {
    resetPrepared();
    const res = await POST(new NextRequest("http://localhost/api/query", {
      method: "POST",
      body: JSON.stringify({ question, mode: "historical", pageToken: agedPageToken() }),
      headers: { "Content-Type": "application/json", "x-forwarded-for": nextIp() },
    }));
    const body = await res.text();
    return { status: res.status, body, prepared: [...preparedSql] };
  }

  /* -------------------------------------------------------------- */
  /*  The decline                                                    */
  /* -------------------------------------------------------------- */

  const DECLINE_QUESTION = "What is the rape clearance rate in Florida by year?";

  // Derived from the module rather than pasted, so the two cannot drift apart; the literal phrase
  // assertions below stop that from making the check vacuous.
  const expectedMessage = observeHistoricalClearanceGrain(
    buildQueryContract(DECLINE_QUESTION, "historical", null)!,
  )!.message;

  console.log("\n-- the real handler declines a statewide clearance question --");
  const declined = await ask(DECLINE_QUESTION);

  await check("the response carries the exact server-authored decline", () => {
    assert.strictEqual(declined.status, 200, `unexpected status; body: ${declined.body.slice(0, 300)}`);
    const payload = resultEvent(declined.body);
    assert.strictEqual(payload.explanation, expectedMessage,
      `explanation was:\n        ${String(payload.explanation).slice(0, 300)}`);
    // Literal, so deriving the expectation above cannot make this pass vacuously.
    assert.ok(/does not provide a statewide rape clearance rate for Florida/.test(payload.explanation), "missing the statewide sentence");
    assert.ok(/national clearance rate/.test(payload.explanation), "the national alternative is not labelled");
    assert.ok(/individual Florida agencies' reported rates where available/.test(payload.explanation), "the agency alternative is not labelled");
  });

  await check("the response carries no rows, no SQL, and no numeric rate", () => {
    const payload = resultEvent(declined.body);
    assert.deepStrictEqual(payload.rows, [], `rows were: ${JSON.stringify(payload.rows).slice(0, 200)}`);
    assert.strictEqual(payload.rowCount, 0, `rowCount was ${payload.rowCount}`);
    assert.deepStrictEqual(payload.columns, [], `columns were: ${JSON.stringify(payload.columns)}`);
    assert.ok(payload.sql === null || payload.sql === undefined, `SQL was returned: ${payload.sql}`);
    // The offer must not smuggle a number back in.
    assert.ok(!/[0-9]/.test(String(payload.explanation)), `the explanation contains a digit: ${payload.explanation}`);
  });

  await check("EXECUTION: the model's factual SQL never reached the database", () => {
    // The observable claim. An empty payload alone would not distinguish "never ran" from
    // "ran and the result was discarded".
    assert.ok(!factualSqlExecuted("national_clearance_rate"),
      `the factual SQL was prepared:\n        ${declined.prepared.filter((s) => s.includes("national_clearance_rate")).join("\n        ")}`);
    assert.ok(!factualSqlExecuted("historical_agency_clearance"),
      "an agency-clearance aggregate was prepared instead");
    // Non-vacuity: something WAS prepared on this request (the query-log write), so an empty
    // recorder is not what makes the assertion above pass.
    assert.ok(declined.prepared.length > 0, "no statements were recorded at all; the observer is not wired");
  });

  /* -------------------------------------------------------------- */
  /*  The positive control                                           */
  /* -------------------------------------------------------------- */

  console.log("\n-- a national clearance question still executes normally --");
  stub.setReply({ sql: WRONG_NATIONAL_SQL, explanation: "National rape clearance rate by year.", title: "National rape clearance" });
  const allowed = await ask("What is the national rape clearance rate by year?");

  await check("the national question executes and returns rows", () => {
    assert.strictEqual(allowed.status, 200, `unexpected status; body: ${allowed.body.slice(0, 300)}`);
    const payload = resultEvent(allowed.body);
    assert.ok(Array.isArray(payload.rows) && payload.rows.length > 0,
      `expected rows; got ${JSON.stringify(payload.rows).slice(0, 200)} with explanation "${String(payload.explanation).slice(0, 160)}"`);
    assert.ok(payload.explanation !== expectedMessage, "the national question received the state decline");
  });

  await check("EXECUTION: the same SQL DID reach the database for the national question", () => {
    // This is what proves the negative case above is a real difference and not a broken pipeline:
    // identical SQL, one executed and one not, decided by the requested grain.
    assert.ok(allowed.prepared.some((s) => s.includes("national_clearance_rate")),
      `the factual SQL never executed; prepared:\n        ${allowed.prepared.slice(0, 6).join("\n        ")}`);
  });

  stub.restore();
  // Best effort, and reported either way: a silent failure here is how the temp directory quietly
  // accumulated in the first place. Whatever cannot be removed now is collected by the sweep on the
  // next run, once this process has released its handles.
  if (!removeQuietly(dir)) {
    console.log(`  (fixtures still held by open handles, left for the next run to sweep: ${dir})`);
  }
  console.log(`\nHistorical clearance route: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  // The suite failed before its normal cleanup, so the fixtures would otherwise be left behind on
  // exactly the runs someone is most likely to repeat.
  if (fixtureDir) removeQuietly(fixtureDir);
  process.exit(1);
});
