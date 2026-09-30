/**
 * Handler-level proof that `/api/session-analytics` WIRES its request facts into the authorization
 * decision correctly, and that no rejected request reaches the database.
 *
 * WHY THIS EXISTS SEPARATELY FROM test-analytics-credential-containment.ts. That suite calls
 * `authorizeAnalytics()` with every rejection case and proves the decision is right. It then reads the
 * route's source to confirm the call and the `!auth.ok` return are present. Both claims are true and
 * neither one runs the route. A route that computed a correct decision from the WRONG INPUTS would pass
 * every assertion there. Concretely, `hasUrlCredential: false` -- one token -- re-opens URL-carried
 * credentials while the helper tests stay green and the source still shows the call and the guard. The
 * security boundary is the exported `GET`, so this suite invokes it.
 *
 * WHY DATABASE ACCESS IS OBSERVED AT better-sqlite3 RATHER THAN INFERRED FROM THE RESPONSE. A 401 body
 * proves the caller saw no data; it does not prove no SQL ran. A route could authorize late, read
 * session detail, discard it, and still return 401 -- an exposure that merely failed to be displayed.
 * `Database.prototype.prepare` and `.exec` are patched BEFORE the route is imported, so every rejection
 * case is measured against what the process DID.
 *
 *   `exec` is recorded as well as `prepare` for a specific reason: `getWriteDb()` in lib/rtci-db.ts
 *   always follows `new Database(path)` with `CREATE TABLE IF NOT EXISTS` statements. Zero recorded
 *   `exec` calls therefore also means no database HANDLE was opened, which the constructor itself does
 *   not report.
 *
 * WHAT MAKES THE OBSERVER NON-VACUOUS. The authorized case at the end is a positive control: the same
 * recorder must show `SELECT ... FROM query_log`, and the response must carry rows that exist ONLY in
 * this suite's temporary fixture. If the recorder were dead, or if the route had opened some other
 * database, that case fails.
 *
 * HOW TO CONFIRM THIS SUITE IS LIVE -- the four wiring mutations, each of which must break it alone:
 *
 *   1. `hasUrlCredential:` forced to `false`            -> the URL-credential cases return 200.
 *   2. `authorization:` replaced with `null`/another header -> the authorized case returns 401.
 *   3. `analyticsPassword:` replaced with `QUERY_LOG_KEY`   -> the authorized case 401s and the
 *                                                              query-log-shaped key is accepted.
 *   4. the `if (!auth.ok) return unauthorized();` line deleted -> the no-header case returns 200.
 *
 * NOTHING IS CONTACTED. The handler runs in this process against a temporary SQLite file. The obsolete
 * tracked literal is assembled from character codes and presented only to this in-process handler, so it
 * is neither tracked text nor network traffic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

const TEMP_PREFIX = "analytics-handler-";

let passed = 0;
const failures: string[] = [];
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Fixture, built BEFORE the observer so its own writes are not      */
/*  mistaken for the route's.                                         */
/* ------------------------------------------------------------------ */

/** Present only in this fixture, so finding it in a response proves which database was read. */
const FIXTURE_QUESTION = "handler-boundary-fixture-question-9f3c";
const FIXTURE_SESSION = "handler-boundary-fixture-session-9f3c";

function buildFixture(dir: string): string {
  const file = path.join(dir, "query_log.db");
  const db = new Database(file);
  // The same column set lib/rtci-db.ts creates, so its CREATE TABLE IF NOT EXISTS and its ALTER TABLE
  // migrations are both no-ops and the fixture cannot drift from the real shape.
  db.exec(`
    CREATE TABLE query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER, tab TEXT, question TEXT, sql TEXT, rows INTEGER, error TEXT, ms INTEGER,
      response TEXT, guardrails TEXT, model TEXT, session_id TEXT,
      routing_confidence TEXT, routing_mode TEXT, routing_reason TEXT,
      query_guidance TEXT, query_contract TEXT
    )
  `);
  const insert = db.prepare(
    "INSERT INTO query_log (ts, tab, question, sql, rows, error, ms, session_id) VALUES (?,?,?,?,?,?,?,?)",
  );
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) {
    insert.run(now - i * 3_600_000, "current", FIXTURE_QUESTION, "SELECT 1", 1, null, 5, FIXTURE_SESSION);
  }
  db.close();
  return file;
}

/* ------------------------------------------------------------------ */
/*  Cleanup. The route caches its handle at module scope and never    */
/*  closes it, so on Windows the fixture is still open at exit.       */
/* ------------------------------------------------------------------ */

function removeQuietly(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return !fs.existsSync(dir);
  } catch {
    return false;
  }
}

/** Collect fixture directories a previous run could not delete; by now those processes have exited. */
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

async function main(): Promise<void> {
  const swept = sweepStaleFixtures();
  if (swept > 0) console.log(`  (swept ${swept} stale fixture director${swept === 1 ? "y" : "ies"})`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const fixture = buildFixture(dir);

  /* ---------------------------------------------------------------- */
  /*  Environment, set BEFORE the route is imported                   */
  /* ---------------------------------------------------------------- */

  const GOOD_KEY = "handler-boundary-analytics-key-not-a-real-secret";
  /** A second, DISTINCT key of the shape the route used to also accept. */
  const QUERY_LOG_SHAPED = "handler-boundary-query-log-key-not-a-real-secret";
  /** The obsolete tracked literal, assembled so it is not tracked text here either. */
  const OBSOLETE = String.fromCharCode(78, 73, 66, 82, 83, 65, 72, 68);

  process.env.QUERY_LOG_DB_PATH = fixture;
  process.env.ANALYTICS_PASSWORD = GOOD_KEY;
  process.env.QUERY_LOG_KEY = QUERY_LOG_SHAPED;

  /* ---------------------------------------------------------------- */
  /*  Database boundary observer, installed BEFORE the route import   */
  /* ---------------------------------------------------------------- */

  const dbOps: string[] = [];
  {
    type Proto = { prepare: (sql: string) => unknown; exec: (sql: string) => unknown };
    const proto = (Database as unknown as { prototype: Proto }).prototype;
    const realPrepare = proto.prepare;
    const realExec = proto.exec;
    proto.prepare = function patchedPrepare(this: unknown, sql: string) {
      dbOps.push(`prepare ${sql}`);
      return realPrepare.call(this, sql);
    };
    proto.exec = function patchedExec(this: unknown, sql: string) {
      dbOps.push(`exec ${sql}`);
      return realExec.call(this, sql);
    };
  }

  const { NextRequest } = await import("next/server");
  const routeModule = await import("../app/api/session-analytics/route");
  const GET = (routeModule as { GET: (req: unknown) => Promise<Response> }).GET;
  const { URL_CREDENTIAL_PARAMS } = await import("../lib/analytics-auth");

  const url = (query = "days=30") => `http://localhost/api/session-analytics?${query}`;
  const request = (query: string, headers: Record<string, string> = {}) =>
    new NextRequest(url(query), { headers });

  /* ---------------------------------------------------------------- */
  /*  Rejections. Every one runs BEFORE the authorized case, so the   */
  /*  no-database claim below is measured over all of them.           */
  /* ---------------------------------------------------------------- */

  type Case = { label: string; query: string; headers?: Record<string, string>; unsetKey?: "" | "delete" };

  const rejectionCases: Case[] = [
    { label: "no Authorization header", query: "days=30" },
    { label: "absent ANALYTICS_PASSWORD, correct-shaped header",
      query: "days=30", headers: { authorization: `Bearer ${GOOD_KEY}` }, unsetKey: "delete" },
    { label: "empty ANALYTICS_PASSWORD, correct-shaped header",
      query: "days=30", headers: { authorization: `Bearer ${GOOD_KEY}` }, unsetKey: "" },
    { label: "malformed header: Basic", query: "days=30", headers: { authorization: `Basic ${GOOD_KEY}` } },
    { label: "malformed header: bare value", query: "days=30", headers: { authorization: GOOD_KEY } },
    { label: "malformed header: Bearer with no value", query: "days=30", headers: { authorization: "Bearer" } },
    { label: "wrong Bearer value", query: "days=30", headers: { authorization: "Bearer not-the-key" } },
    { label: "near-miss Bearer value", query: "days=30", headers: { authorization: `Bearer ${GOOD_KEY}x` } },
    { label: "the obsolete tracked literal in a Bearer header",
      query: "days=30", headers: { authorization: `Bearer ${OBSOLETE}` } },
    { label: "a distinct query-log-shaped key in a Bearer header",
      query: "days=30", headers: { authorization: `Bearer ${QUERY_LOG_SHAPED}` } },
    // Fail-closed must not be satisfiable by the OTHER key. Without this case, restoring
    // `process.env.ANALYTICS_PASSWORD || process.env.QUERY_LOG_KEY` would be invisible here, because
    // the `||` short-circuits whenever the dedicated key is configured.
    { label: "absent ANALYTICS_PASSWORD with the query-log-shaped key in the header",
      query: "days=30", headers: { authorization: `Bearer ${QUERY_LOG_SHAPED}` }, unsetKey: "delete" },
  ];

  await check("the governed URL credential list is not empty, so the loop below proves something", () => {
    /**
     * Vacuity guard. The cases below are generated FROM `URL_CREDENTIAL_PARAMS`. Emptying that list
     * would re-open every query-string credential and generate zero cases, so this suite would go green
     * on a wide-open endpoint. The three names are the ones the route historically accepted.
     */
    for (const required of ["pw", "password", "key"]) {
      assert.ok((URL_CREDENTIAL_PARAMS as readonly string[]).includes(required),
        `the governed URL credential list no longer covers "${required}"`);
    }
  });

  // Every governed URL credential name, each one alongside the CORRECT Bearer key. This is the pairing
  // the `hasUrlCredential: false` mutation breaks and the helper tests cannot see.
  for (const param of URL_CREDENTIAL_PARAMS) {
    rejectionCases.push({
      label: `?${param}= carrying the CORRECT key, alongside the correct Bearer header`,
      query: `${param}=${encodeURIComponent(GOOD_KEY)}&days=30`,
      headers: { authorization: `Bearer ${GOOD_KEY}` },
    });
    rejectionCases.push({
      label: `?${param}= carrying the CORRECT key, with no header at all`,
      query: `${param}=${encodeURIComponent(GOOD_KEY)}&days=30`,
    });
  }

  const bodies: string[] = [];
  for (const c of rejectionCases) {
    await check(`the real handler rejects: ${c.label}`, async () => {
      const restore = process.env.ANALYTICS_PASSWORD;
      if (c.unsetKey === "delete") delete process.env.ANALYTICS_PASSWORD;
      if (c.unsetKey === "") process.env.ANALYTICS_PASSWORD = "";
      try {
        const res = await GET(request(c.query, c.headers));
        assert.equal(res.status, 401, `expected 401, got ${res.status}`);
        bodies.push(await res.text());
        assert.equal(res.headers.get("access-control-allow-origin"), null,
          "a rejected request still emitted a CORS allow-origin header");
      } finally {
        process.env.ANALYTICS_PASSWORD = restore as string;
      }
    });
  }

  await check("every rejection returns the identical body, so no reason leaks", () => {
    assert.equal(bodies.length, rejectionCases.length, "a rejection case did not record a body");
    const unique = new Set(bodies);
    assert.equal(unique.size, 1, `rejection bodies differ: ${[...unique].join(" | ")}`);
    assert.equal(bodies[0], JSON.stringify({ error: "Unauthorized" }));
  });

  await check("NO rejected request touched the database -- not one statement, not one handle", () => {
    assert.deepEqual(dbOps, [],
      `a rejected request reached the database:\n        ${dbOps.slice(0, 5).join("\n        ")}`);
  });

  /* ---------------------------------------------------------------- */
  /*  The one accept, which is also the recorder's positive control    */
  /* ---------------------------------------------------------------- */

  let authorized: { status: number; payload: Record<string, unknown>; cors: string | null } | null = null;

  await check("the correct dedicated Bearer key reaches the authorized path and returns fixture data", async () => {
    const res = await GET(request("days=30", { authorization: `Bearer ${GOOD_KEY}` }));
    authorized = {
      status: res.status,
      payload: (await res.json()) as Record<string, unknown>,
      cors: res.headers.get("access-control-allow-origin"),
    };
    assert.equal(authorized.status, 200, `expected 200, got ${authorized.status}`);

    const questions = authorized.payload.topQuestions as { question: string }[];
    const sessions = authorized.payload.sessionDetails as { session_id: string }[];
    assert.ok(Array.isArray(questions) && Array.isArray(sessions), "the payload is not analytics-shaped");
    // These strings exist ONLY in this suite's fixture, so this is also the proof that the handler read
    // the temporary database rather than some other file that happened to be on disk.
    assert.ok(questions.some((q) => q.question === FIXTURE_QUESTION),
      `the fixture question is absent from the authorized payload: ${JSON.stringify(questions).slice(0, 200)}`);
    assert.ok(sessions.some((s) => s.session_id === FIXTURE_SESSION),
      `the fixture session is absent from the authorized payload: ${JSON.stringify(sessions).slice(0, 200)}`);
  });

  await check("the recorder can observe access -- the authorized request DID execute SQL", () => {
    assert.ok(dbOps.length > 0, "the authorized request recorded no database operation at all, so the "
      + "no-database claim above proves nothing");
    assert.ok(dbOps.some((op) => /prepare[\s\S]*FROM query_log/.test(op)),
      `no query_log read was recorded; observed: ${dbOps.slice(0, 5).join(" | ")}`);
  });

  await check("the authorized response emits no wildcard CORS", () => {
    assert.ok(authorized, "the authorized case did not run");
    assert.equal(authorized!.cors, null, `the authorized response emitted allow-origin: ${authorized!.cors}`);
  });

  await check("the route module exports no public preflight handler", () => {
    // Structural, not source text: an OPTIONS export is what makes a public preflight reachable.
    assert.equal((routeModule as Record<string, unknown>).OPTIONS, undefined,
      "the route exports an OPTIONS handler again");
  });

  removeQuietly(dir);
}

main().then(() => {
  console.log("");
  console.log(`analytics handler boundary: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log("  " + f);
    process.exit(1);
  }
}).catch((error) => {
  console.log(`  FAIL  the suite could not run: ${(error as Error).stack}`);
  process.exit(1);
});
