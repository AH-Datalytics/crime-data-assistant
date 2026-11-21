/**
 * The web side of the engine switch's stage 1 (lib/engine-private.ts, lib/engine-client.ts, lib/engine-route.ts): the private flag, the client of the engine service, and what the route
 * does around an answer (rate limit, page token, session limit, the log row for every outcome, no fallback). Fakes for the page token, the limits and the log; a real loopback service with
 * a fake worker for the client. No Next, no database, no data.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { callEngine, engineClientConfig } from "../lib/engine-client";
import { engineCookieValue, isEngineKey, isEnginePrivate } from "../lib/engine-private";
import { adaptEngineResponse } from "../lib/engine-adapt";
import { engineLogRow, handleEngineQuery, type EngineLogRow, type RouteDeps } from "../lib/engine-route";
import { createEngineServer } from "../lib/engine-service/http";
import { EnginePool, type PoolWorker } from "../lib/engine-service/pool";
import type { EngineRequest, EngineResult } from "../lib/engine-service/protocol";

console.log("engine route: the private flag, the service client and the route logic");

const KEY = "owner-held-secret-key-1234";
const answer: EngineResult = { ok: true, ms: 12, release: "canon2-x", sql: "SELECT 1", response: { kind: "answer", columns: ["Weapon", "Robbery offenses"], rows: [{ Weapon: "Handgun", "Robbery offenses": 5 }, { Weapon: "Knife", "Robbery offenses": 3 }],
  text: ["Counted by offense."], presentation: { title: "Robberies by weapon in Texas in 2024", lead: "There were 8 robbery offenses." } } };

async function main(): Promise<void> {
  // --- the private flag
  {
    const env = { ENGINE_PRIVATE_KEY: KEY };
    const v = engineCookieValue(env)!;
    assert.match(v, /^[0-9a-f]{64}$/);
    assert.notEqual(v, KEY, "the cookie is a keyed hash, never the key");
    assert.equal(engineCookieValue({ ENGINE_PRIVATE_KEY: "short" }), null, "a short key: no flag");
    assert.equal(engineCookieValue({}), null, "no key: no flag");
    assert.ok(isEnginePrivate(v, env));
    for (const bad of [undefined, null, "", "x", v.slice(1), v + "0", v.replace(/./, (c) => (c === "a" ? "b" : "a"))]) assert.ok(!isEnginePrivate(bad as string, env), `not the cookie: ${String(bad).slice(0, 8)}`);
    assert.ok(!isEnginePrivate(v, {}), "with no key configured nobody is private");
    assert.ok(!isEnginePrivate(v, { ENGINE_PRIVATE_KEY: KEY + "x" }), "a cookie made under another key is refused");
    assert.ok(isEngineKey(KEY, env) && !isEngineKey(KEY + "x", env) && !isEngineKey(null, env) && !isEngineKey(KEY, {}), "the link's key is the configured key");
  }

  // --- the client, against a real loopback service with a fake worker
  {
    const worker: PoolWorker = { run: async (r: EngineRequest) => (r.question === "slow" ? new Promise<EngineResult>(() => {}) : answer), kill: () => {} };
    const pool = new EnginePool({ size: 1, queueMax: 0, timeoutMs: 5000, spawn: () => worker });
    const TOKEN = "service-token-0123456789";
    const server = createEngineServer({ pool, token: TOKEN });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const cfg = engineClientConfig({ ENGINE_TOKEN: TOKEN, ENGINE_SERVICE_URL: url + "/", ENGINE_TIMEOUT_MS: "5000" })!;
      assert.deepEqual([cfg.url, cfg.token, cfg.timeoutMs], [url, TOKEN, 15000], "the route waits a little longer than the service's own limit");
      assert.equal(engineClientConfig({}), null);
      assert.equal(engineClientConfig({ ENGINE_TOKEN: "short" }), null);
      const ok = await callEngine({ tab: "nibrs", question: "Robberies by weapon in Texas in 2024", path: [] }, cfg);
      assert.ok(ok.ok && ok.release === "canon2-x");
      const wrongToken = await callEngine({ tab: "nibrs", question: "q", path: [] }, { ...cfg, token: "another-token-0123456789" });
      assert.ok(!wrongToken.ok && wrongToken.kind === "error", "the service's refusal comes back as an error result");
      const unconfigured = await callEngine({ tab: "nibrs", question: "q", path: [] }, null);
      assert.ok(!unconfigured.ok && unconfigured.kind === "unavailable");
      const down = await callEngine({ tab: "nibrs", question: "q", path: [] }, { ...cfg, url: "http://127.0.0.1:9" });
      assert.ok(!down.ok && down.kind === "unavailable" && /not reachable/.test(down.message), "an unreachable service is 'unavailable', never a fallback");
      const unreadable = await callEngine({ tab: "nibrs", question: "q", path: [] }, cfg, async () => new Response("<html>", { status: 502 }));
      assert.ok(!unreadable.ok && unreadable.kind === "unavailable", "an unreadable reply is 'unavailable'");
      const timeout = await callEngine({ tab: "nibrs", question: "slow", path: [] }, { ...cfg, timeoutMs: 40 });
      assert.ok(!timeout.ok && timeout.kind === "unavailable" && /in time/.test(timeout.message), "a service that does not answer in time is reported as such");
    } finally { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); pool.close(); }
  }

  // --- the log row for every outcome
  {
    const req: EngineRequest = { tab: "nibrs", question: "Robberies by weapon in Texas in 2024", path: [] };
    const a = engineLogRow(req, answer, 123.6, "sess-1");
    assert.deepEqual([a.sql, a.rowCount, a.error, a.ms, a.model, a.sessionId], ["SELECT 1", 2, null, 124, "engine", "sess-1"]);
    assert.deepEqual(a.guardrails, ["engine", "engine:answer", "engine-release:canon2-x"]);
    assert.match(a.response!, /Robberies by weapon in Texas in 2024 There were 8 robbery offenses\. Counted by offense\./);
    const long = engineLogRow(req, { ...answer, sql: "S".repeat(9000) } as EngineResult, 1, null);
    assert.ok(long.sql!.length <= 4000 && long.sql!.endsWith("…"), "a long statement is cut for the log");
    const clar = engineLogRow({ ...req, path: ["Violent"], previous: "earlier" }, { ok: true, ms: 1, release: "r", sql: null, response: { kind: "clarify", about: "Which place?" } }, 1, null);
    assert.deepEqual([clar.rowCount, clar.sql, clar.response], [0, null, "Which place?"]);
    assert.deepEqual(clar.guardrails, ["engine", "engine:clarify", "engine-release:r", "engine:button", "engine:follow-up"]);
    const dec = engineLogRow(req, { ok: true, ms: 1, release: "r", response: { kind: "decline", reason: "not_held", text: ["We do not track that."] } }, 1, null);
    assert.match(dec.response!, /We do not track that\. not_held/);
    for (const kind of ["busy", "timeout", "unavailable", "bad_request", "error"] as const) {
      const f = engineLogRow(req, { ok: false, kind, message: "msg" }, 5, null);
      assert.deepEqual([f.error, f.sql, f.rowCount, f.response, f.guardrails], [`engine_${kind}`, null, 0, "msg", ["engine", `engine:${kind}`]]);
    }
  }

  // --- the engine's answer in the page's shape
  {
    const req: EngineRequest = { tab: "nibrs", question: "Robberies in Texas in 2024", path: ["Violent crime"], previous: "Crime in Texas" };
    const btn = { label: "By month", path: ["Violent crime", "By month"], kind: "continuation" as const };
    const a = adaptEngineResponse(req, { kind: "answer", columns: ["Year", "Robberies"], rows: [{ Year: 2024, Robberies: 5 }], chart: { type: "bar", xAxis: "Year", yAxis: "Robberies", title: "t" }, text: ["There were 5 robberies.", "Counted by offense."], buttons: [btn] }, "rel-1", 41.6);
    assert.deepEqual([a.success, a.title, a.explanation, a.columns, a.rowCount, a.executionTimeMs, a.sql, a.truncated, a.chartMeta], [true, "There were 5 robberies.", "There were 5 robberies.\n\nCounted by offense.", ["Year", "Robberies"], 1, 42, "", false, null]);
    assert.deepEqual(a.chartConfig, { type: "bar", xAxis: "Year", yAxis: "Robberies", title: "t" });
    assert.deepEqual(a.engine, { kind: "answer", release: "rel-1", question: "Robberies in Texas in 2024", previous: "Crime in Texas", path: ["Violent crime"], buttons: [btn] }, "the engine meta carries what a button step needs");
    const c = adaptEngineResponse({ tab: "nibrs", question: "Crime in Ohio", path: [] }, { kind: "clarify", about: "which Ohio", note: "Two places match.", buttons: [btn, { label: "x" }, null] }, "rel-1", 1);
    assert.deepEqual([c.success, c.explanation, c.rows, c.chartConfig, c.engine.kind, c.engine.buttons.length], [true, "Which Ohio?\n\nTwo places match.", [], null, "clarify", 1], "a question back has words and buttons, no table; malformed buttons are dropped");
    const d = adaptEngineResponse({ tab: "nibrs", question: "Non-fatal shootings", path: [] }, { kind: "decline", reason: "not_held", text: "We do not track non-fatal shootings.", buttons: [] }, "rel-1", 1);
    assert.deepEqual([d.explanation, d.engine.kind, d.columns], ["We do not track non-fatal shootings.", "decline", []]);
    const u = adaptEngineResponse({ tab: "nibrs", question: "q", path: [] }, { kind: "something-new" }, "rel-1", 1);
    assert.deepEqual([u.engine.kind, typeof u.explanation], ["decline", "string"], "an unknown kind is shown as a decline, never a crash");
    assert.equal(adaptEngineResponse({ tab: "nibrs", question: "q", path: [] }, null, "r", 1).rowCount, 0);
  }

  // --- the route logic, with fakes
  {
    const logs: EngineLogRow[] = [];
    const calls: EngineRequest[] = [];
    let result: EngineResult = answer;
    let tick = 0;
    const deps = (over: Partial<RouteDeps> = {}): RouteDeps => ({ isPrivate: true, ip: "1.2.3.4", validatePageToken: (t) => t === "good-token", rateLimit: () => ({ allowed: true }),
      sessionLimit: () => ({ allowed: true }), call: async (r) => { calls.push(r); return result; }, log: (row) => { logs.push(row); }, clock: () => (tick += 50), ...over });
    const body = { question: "  Robberies by weapon in Texas in 2024 ", pageToken: "good-token", sessionId: "sess-1" };
    const count = (a: readonly unknown[]) => a.length; // (a plain read: the assertions above must not narrow what a later one reads)
    const reset = () => { logs.length = 0; calls.length = 0; result = answer; };

    let r = await handleEngineQuery(body, deps());
    assert.equal(r.status, 200);
    const eng = r.json.engine as { kind: string; release: string; question: string; path: string[]; buttons: unknown[] };
    assert.deepEqual([r.json.success, eng.kind, eng.release, eng.question, eng.path, r.json.executionTimeMs], [true, "answer", "canon2-x", "Robberies by weapon in Texas in 2024", [], 50]);
    assert.deepEqual([r.json.title, r.json.columns, r.json.rowCount, r.json.sql], ["Counted by offense.", ["Weapon", "Robbery offenses"], 2, ""], "the answer is in the shape the page renders");
    assert.deepEqual([...calls], [{ tab: "nibrs", question: "Robberies by weapon in Texas in 2024", path: [] }], "tab defaults to nibrs; the question is trimmed");
    assert.equal(count(logs), 1, "one log row for an answer");
    assert.equal(logs[0].sessionId, "sess-1");

    reset();
    r = await handleEngineQuery(body, deps({ isPrivate: false }));
    assert.equal(r.status, 404, "without the private cookie the route does not exist");
    assert.ok(count(calls) === 0 && count(logs) === 0, "and nothing runs: no engine call, no log row");

    r = await handleEngineQuery(body, deps({ rateLimit: () => ({ allowed: false, retryAfterMs: 7000 }) }));
    assert.deepEqual([r.status, r.json.error], [429, "Too many requests. Please wait 7 seconds and try again."]);
    r = await handleEngineQuery({ ...body, pageToken: "bad" }, deps());
    assert.deepEqual([r.status, r.json.error], [403, "Please refresh the page and try again."]);
    r = await handleEngineQuery(body, deps({ sessionLimit: () => ({ allowed: false, dailyLimitReached: true }) }));
    assert.deepEqual([r.status, r.json.error], [429, "You've reached the daily query limit. Please come back tomorrow."]);
    r = await handleEngineQuery(body, deps({ sessionLimit: () => ({ allowed: false, captchaRequired: true }) }));
    assert.deepEqual([r.status, r.json.captchaRequired], [202, true]);
    assert.equal(count(calls), 0, "a refused request never reaches the engine");

    for (const [bad, why] of [[{ pageToken: "good-token" }, "no question"], [{ ...body, question: "x".repeat(501) }, "too long"], [{ ...body, path: "a" }, "bad path"], [null, "no body"]] as const) {
      const rr = await handleEngineQuery(bad, deps());
      assert.ok(rr.status === 400 || rr.status === 403, `${why}: refused (${rr.status})`);
    }

    // a follow-up and a button keep their fields
    reset();
    await handleEngineQuery({ ...body, path: ["Violent crime"], previous: "Crime in Ohio" }, deps());
    assert.deepEqual(calls[0].path, ["Violent crime"]);
    assert.equal(calls[0].previous, "Crime in Ohio");

    // failures are shown as what they are, are logged, and never fall back
    for (const [kind, status] of [["busy", 503], ["timeout", 504], ["unavailable", 503], ["bad_request", 409], ["error", 500]] as const) {
      reset();
      result = { ok: false, kind, message: `m-${kind}` };
      r = await handleEngineQuery(body, deps());
      assert.deepEqual([r.status, r.json.success, r.json.engineFailure, r.json.kind, r.json.error], [status, false, true, kind, `m-${kind}`]);
      assert.deepEqual([count(logs), logs[0].error], [1, `engine_${kind}`], "every outcome is logged");
    }

    // a log failure never changes what the visitor sees
    reset();
    r = await handleEngineQuery(body, deps({ log: () => { throw new Error("db locked"); } }));
    assert.equal(r.status, 200);
  }

  console.log("engine route: the private flag, the service client and the route logic: ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
