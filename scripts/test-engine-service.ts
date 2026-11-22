/**
 * The engine service's pool, protocol and HTTP face (lib/engine-service): worker count and queue bound, the busy answer, the timeout that kills and replaces a worker, a crashed
 * worker, shutdown, the token and body limits, and the configuration read from the environment. Fake workers stand in for the engine (no data, no Python, no network but loopback).
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { askedOf, configFromEnv, createCore } from "../lib/engine-service/core";
import { createEngineServer } from "../lib/engine-service/http";
import { EnginePool, type PoolWorker } from "../lib/engine-service/pool";
import { parseEngineRequest, statusOf, type EngineRequest, type EngineResult } from "../lib/engine-service/protocol";

console.log("engine service: pool, protocol and HTTP face");

const req = (question: string, extra: Partial<EngineRequest> = {}): EngineRequest => ({ tab: "nibrs", question, path: [], ...extra });
const ok = (text: string): EngineResult => ({ ok: true, response: { kind: "answer", text }, ms: 0, release: "rel-1" });
const sleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));

async function main(): Promise<void> {
// --- protocol
{
  assert.deepEqual(parseEngineRequest({ tab: "nibrs", question: "  Robberies in Texas in 2024  " }), { tab: "nibrs", question: "Robberies in Texas in 2024", path: [] });
  assert.deepEqual(parseEngineRequest({ tab: "nibrs", question: "q", path: ["a", "b"], previous: " earlier " }), { tab: "nibrs", question: "q", path: ["a", "b"], previous: "earlier" });
  for (const bad of [null, "x", 1, {}, { tab: "NIBRS", question: "q" }, { tab: "nibrs" }, { tab: "nibrs", question: "  " }, { tab: "nibrs", question: "x".repeat(501) }, { tab: "nibrs", question: "q", path: "a" },
    { tab: "nibrs", question: "q", path: [1] }, { tab: "nibrs", question: "q", path: Array(13).fill("a") }, { tab: "nibrs", question: "q", path: [""] }, { tab: "nibrs", question: "q", previous: "" }, { tab: "nibrs", question: "q", previous: 5 }])
    assert.ok("error" in parseEngineRequest(bad), `refused: ${JSON.stringify(bad)?.slice(0, 40)}`);
  assert.equal(statusOf(ok("x")), 200);
  assert.deepEqual((["busy", "timeout", "unavailable", "bad_request", "error"] as const).map((kind) => statusOf({ ok: false, kind, message: "m" })), [503, 504, 404, 400, 500]);
}

// --- a controllable fake worker
type Held = { req: EngineRequest; resolve: (r: EngineResult) => void; reject: (e: Error) => void };
function fakes() {
  const spawned: { held: Held[]; killed: boolean }[] = [];
  const spawn = (): PoolWorker => {
    const rec = { held: [] as Held[], killed: false };
    spawned.push(rec);
    return { run: (r) => new Promise<EngineResult>((resolve, reject) => rec.held.push({ req: r, resolve, reject })), kill: () => { rec.killed = true; } };
  };
  return { spawned, spawn };
}

// --- two workers, a bounded queue, and the busy answer
{
  const f = fakes();
  const pool = new EnginePool({ size: 2, queueMax: 1, timeoutMs: 5000, spawn: f.spawn });
  const a = pool.submit(req("a")), b = pool.submit(req("b")), c = pool.submit(req("c")), d = pool.submit(req("d"));
  assert.deepEqual(pool.stats(), { size: 2, busy: 2, queued: 1, served: 0, timeouts: 0, crashes: 0, rejectedBusy: 1 }, "two running, one waiting, the fourth refused at once");
  const dr = await d;
  assert.ok(!dr.ok && dr.kind === "busy", "a full queue answers busy");
  assert.equal(f.spawned[0].held.length + f.spawned[1].held.length, 2, "only two requests reached workers");
  f.spawned[0].held[0].resolve(ok("a"));
  const ar = await a;
  assert.ok(ar.ok && (ar.response as { text: string }).text === "a" && typeof ar.ms === "number", "the answer comes back with its time");
  assert.equal(f.spawned[0].held.length, 2, "the waiting request went to the worker that freed up");
  assert.equal(f.spawned[0].held[1].req.question, "c");
  f.spawned[1].held[0].resolve(ok("b")); f.spawned[0].held[1].resolve(ok("c"));
  await Promise.all([b, c]);
  assert.deepEqual(pool.stats(), { size: 2, busy: 0, queued: 0, served: 3, timeouts: 0, crashes: 0, rejectedBusy: 1 });
  pool.close();
}

// --- a worker that overruns is killed and replaced; the next request works
{
  const f = fakes();
  const pool = new EnginePool({ size: 1, queueMax: 2, timeoutMs: 25, spawn: f.spawn });
  const slow = await pool.submit(req("slow"));
  assert.ok(!slow.ok && slow.kind === "timeout", "an overrun is answered with a timeout");
  assert.ok(f.spawned[0].killed && f.spawned.length === 2, "the stuck worker was killed and a new one started");
  assert.equal(pool.stats().timeouts, 1);
  const next = pool.submit(req("next"));
  f.spawned[1].held[0].resolve(ok("fine"));
  assert.ok((await next).ok, "the replacement answers");
  f.spawned[0].held[0].resolve(ok("late")); // a late answer from the killed worker is ignored
  assert.equal(pool.stats().served, 1);
  pool.close();
}

// --- a worker that dies
{
  const f = fakes();
  const pool = new EnginePool({ size: 1, queueMax: 1, timeoutMs: 5000, spawn: f.spawn });
  const p = pool.submit(req("boom"));
  f.spawned[0].held[0].reject(new Error("worker exited (SIGKILL)"));
  const r = await p;
  assert.ok(!r.ok && r.kind === "error" && /worker exited/.test(r.message), "a dead worker is an error answer");
  assert.ok(f.spawned.length === 2 && f.spawned[0].killed, "and is replaced");
  assert.equal(pool.stats().crashes, 1);
  pool.close();
}

// --- shutdown
{
  const f = fakes();
  const pool = new EnginePool({ size: 1, queueMax: 4, timeoutMs: 5000, spawn: f.spawn });
  pool.submit(req("running")); const waiting = pool.submit(req("waiting"));
  pool.close();
  const w = await waiting;
  assert.ok(!w.ok && /shutting down/.test(w.message), "queued requests are answered when the service stops");
  assert.ok(f.spawned[0].killed);
  const after = await pool.submit(req("late"));
  assert.ok(!after.ok && after.kind === "error", "nothing is accepted after close");
  assert.throws(() => new EnginePool({ size: 0, queueMax: 0, timeoutMs: 10, spawn: f.spawn }));
}

// --- the HTTP face
{
  const f = fakes();
  const pool = new EnginePool({ size: 1, queueMax: 0, timeoutMs: 5000, spawn: f.spawn });
  assert.throws(() => createEngineServer({ pool, token: "short" }), /ENGINE_TOKEN/);
  const TOKEN = "0123456789abcdef-token";
  const server = createEngineServer({ pool, token: TOKEN, info: () => ({ release: "rel-1" }) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init?: RequestInit) => fetch(base + path, init).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
  const post = (body: string, headers: Record<string, string> = { "x-engine-token": TOKEN }) => call("/answer", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  try {
    const h = await call("/health");
    assert.equal(h.status, 200);
    assert.deepEqual([h.body.ok, h.body.info], [true, { release: "rel-1" }], "health needs no token and reports the pool and what the workers said");
    assert.equal((await post(JSON.stringify(req("q")), {})).status, 401, "no token");
    assert.equal((await post(JSON.stringify(req("q")), { "x-engine-token": "0123456789abcdef-tokeX" })).status, 401, "wrong token");
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post(JSON.stringify({ tab: "nibrs", question: "" }))).status, 400);
    assert.equal((await post(JSON.stringify({ tab: "nibrs", question: "x", pad: "y".repeat(20000) }))).status, 413, "an oversized body");
    assert.equal((await call("/nope")).status, 404);
    assert.equal((await call("/answer")).status, 404, "GET /answer");
    // a good request: held by the fake worker, then answered
    const pending = post(JSON.stringify(req("Robberies in Texas in 2024")));
    while (!f.spawned[0].held.length) await sleep(5);
    // the single worker is busy and the queue holds nothing: the next request is busy at once
    const busy = await post(JSON.stringify(req("another")));
    assert.equal(busy.status, 503);
    assert.deepEqual([busy.body.ok, busy.body.kind], [false, "busy"]);
    f.spawned[0].held[0].resolve(ok("done"));
    const done = await pending;
    assert.equal(done.status, 200);
    assert.deepEqual([done.body.ok, (done.body.response as { text: string }).text, done.body.release], [true, "done", "rel-1"]);
  } finally { await new Promise<void>((r) => server.close(() => r())); pool.close(); }
}

// --- configuration and the core's refusal of an unconfigured source
{
  const c = configFromEnv({ ENGINE_NIBRS_ROOT: "/r/canonical", ENGINE_PYTHON: "/p/python", ENGINE_DUCKDB_MEMORY: "3GB", ENGINE_DUCKDB_THREADS: "2", ENGINE_TIMEOUT_MS: "90000" });
  assert.deepEqual(c, { tabs: { nibrs: { root: "/r/canonical", python: "/p/python" } }, memoryLimit: "3GB", threads: 2, timeoutMs: 90000 });
  assert.deepEqual(configFromEnv({}), { tabs: {}, memoryLimit: "2GB", threads: 1, timeoutMs: 120000 }, "defaults: no tab, 2 GB, one thread");
  assert.equal(configFromEnv({ ENGINE_DUCKDB_THREADS: "0" }).threads, 1, "a bad thread count falls back to one");
  // Follow-ups #2: the whole question a reply answered or asked about, which the page sends back as the next follow-up's `previous`.
  assert.equal(askedOf({ question: "violent crime in Houston by year" }, { kind: "answer" }), "violent crime in Houston by year", "a first question is itself");
  assert.equal(askedOf({ question: "show rates instead", previous: "violent crime in Houston by year" }, { kind: "answer", rewrite: "violent crime rate in Houston by year" }),
    "violent crime rate in Houston by year", "a follow-up is its rewritten question");
  assert.equal(askedOf({ question: "hmm", previous: "violent crime in Houston by year" }, { kind: "clarify", rewrite: null }), "violent crime in Houston by year",
    "a follow-up that could not be read keeps the previous question");
  const core = createCore(configFromEnv({}));
  const r = core.answer(req("q", { tab: "historical" }));
  assert.ok(!r.ok && r.kind === "unavailable", "a source with no root is not available (no engine is built for it)");
  assert.deepEqual(core.info().tabs, []);
  core.close();
}

  console.log("engine service: pool, protocol and HTTP face: ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
