/**
 * The engine service's pool, protocol and HTTP face (lib/engine-service): worker count and queue bound, the busy answer, the timeout that kills and replaces a worker, a crashed
 * worker, shutdown, the token and body limits, and the configuration read from the environment. Fake workers stand in for the engine (no data, no Python, no network but loopback).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crimeIndexBuilder } from "../lib/engine-service/sources";
import { asSourceTab, SOURCE_TABS } from "../lib/nibrs-shadow/source-description";
import type { AddressInfo } from "node:net";
import type { ShadowDeps, ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { askedOf, configFromEnv, createCore, TAB_SOURCE, type CoreHooks } from "../lib/engine-service/core";
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
  assert.deepEqual(c, { roots: { nibrs: "/r/canonical" }, python: "/p/python", memoryLimit: "3GB", threads: 2, timeoutMs: 90000 });
  assert.deepEqual(configFromEnv({}), { roots: {}, python: "python3", memoryLimit: "2GB", threads: 1, timeoutMs: 120000 }, "defaults: no source, 2 GB, one thread");
  assert.deepEqual(configFromEnv({ ENGINE_CRIME_INDEX_ROOT: "/ci", ENGINE_SHR_ROOT: "/s", ENGINE_HATE_ROOT: "/h" }).roots, { crimeIndex: "/ci", shr: "/s", hate: "/h" }, "one root per source");
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

// --- P234: the tab names the service, the app and the labels use are one set, and the service tells the engine the tab
{
  const labels = JSON.parse(readFileSync("scripts/fixtures/answer-eval/qlog-labels.json", "utf8")) as { labels?: { tab: string }[] } | { tab: string }[];
  const labelTabs = [...new Set((Array.isArray(labels) ? labels : labels.labels ?? []).map((l) => l.tab))].sort();
  assert.deepEqual(labelTabs, [...SOURCE_TABS].sort(), "the qlog labels' tab names are the five source tabs");
  const ui = /type TabId = ([^;]+);/.exec(readFileSync("components/ChatInterface.tsx", "utf8"))?.[1] ?? "";
  const uiTabs = [...ui.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((t) => t !== "explainer").sort();
  assert.deepEqual(uiTabs, [...SOURCE_TABS].sort(), "the app's tab ids are the five source tabs");
  assert.deepEqual(Object.keys(TAB_SOURCE).sort(), [...SOURCE_TABS].sort(), "every source tab has a source in the service config");
  assert.equal(asSourceTab("hate_crime"), "hate_crime");
  assert.equal(asSourceTab("hate"), undefined, "a name that is not a source tab is not one");
  assert.equal(asSourceTab(undefined), undefined);
}

// --- piece 1: one shared executor, per-source loading, a failed source stays its own tabs' problem
{
  const exec = (() => []) as unknown as ShadowDeps["execute"];
  const baseDeps = { places: {} as ShadowDeps["places"], release: { id: "n-1", firstMonth: "1991-01", lastMonth: "2025-12", asOf: "2026-11-22" }, target: { root: "/n", builtYears: [2025] }, execute: exec };
  const cfg = configFromEnv({ ENGINE_NIBRS_ROOT: "/n", ENGINE_SHR_ROOT: "/s", ENGINE_HATE_ROOT: "/h" });
  let clock = 0, shrWorks = false; const tries = { shr: 0 };
  const seen: { tab?: string; hate: boolean; shr: boolean; exec: unknown }[] = [];
  const hooks: CoreHooks = {
    now: () => clock,
    base: () => ({ deps: baseDeps, release: "n-1" }),
    sources: {
      shr: () => { tries.shr++; if (!shrWorks) throw new Error("manifest missing"); return { deps: { shr: { latestMonth: "2024-12" } as unknown as ShadowDeps["shr"] }, releases: { shr: "s-1" } }; },
      hate: () => ({ deps: { hate: { latestDate: "2024-12-31" } as unknown as ShadowDeps["hate"] }, releases: { hate_crime: "h-1" } }),
    },
    answerOutcome: (_r, d) => { seen.push({ tab: d.tab, hate: !!d.hate, shr: !!d.shr, exec: d.execute }); return { kind: "decline", reason: "x", about: "x" } as unknown as ShadowOutcome; },
  };
  const core = createCore(cfg, hooks);
  assert.deepEqual(core.info().tabs, ["nibrs", "shr", "hate_crime"], "served: nibrs, and the sources with a root and a builder (crimeIndex has no root here)");
  const n = core.answer(req("q", { tab: "nibrs" }));
  assert.ok(n.ok && n.release === "n-1", "nibrs answers on the base release");
  const h = core.answer(req("q", { tab: "hate_crime" }));
  assert.ok(h.ok && h.release === "h-1", "hate crime reports its own release");
  const s = core.answer(req("q", { tab: "shr" }));
  assert.ok(!s.ok && s.kind === "unavailable" && /manifest missing/.test(s.message), "a source that fails to load makes only its own tab unavailable, with its reason");
  assert.equal(core.answer(req("q", { tab: "historical" })).ok, false, "a tab whose source has no root is unavailable");
  assert.ok(seen.every((x) => x.exec === exec), "every tab shares the one executor");
  assert.ok(seen.find((x) => x.tab === "nibrs")?.hate, "a question on one tab can still read another loaded source");
  tries.shr = 0; core.answer(req("q", { tab: "shr" })); assert.equal(tries.shr, 0, "a failed source is not retried at once");
  clock = 31_000; shrWorks = true;
  const again = core.answer(req("q", { tab: "shr" }));
  assert.ok(again.ok && again.release === "s-1" && Number(tries.shr) === 1, "after the pause it is tried again and, once fixed, answers");
  assert.deepEqual((core.info().sources as Record<string, string>), { shr: "loaded", hate: "loaded" });
  core.close();
}
// --- piece 2: Crime Index builder serves Historical and Current from one folder; a bad folder is a reason, not a crash
{
  const dir = mkdtempSync(path.join(tmpdir(), "ci-"));
  const exec = ((sql: string) => (/current_final/.test(sql) ? [[201901]] : [[201701, 202609]])) as unknown as ShadowDeps["execute"];
  assert.throws(() => crimeIndexBuilder(dir, { execute: exec }), /no Crime Index manifest\.json/, "no manifest: said plainly");
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ release: "ci-1", inputs: { historical_crime: { years: [1930, 2024] }, historical_clearances: { years: [1960, 2024] } } }));
  assert.throws(() => crimeIndexBuilder(dir, { execute: exec }), /lists no current_crime table/, "a manifest without the current table is refused, not half served");
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ release: "ci-1", inputs: { historical_crime: { years: [1930, 2024] }, historical_clearances: { years: [1960, 2024] }, current_crime: {} } }));
  const built = crimeIndexBuilder(dir, { execute: exec });
  assert.deepEqual(built.releases, { historical: "ci-1", current: "ci-1" });
  assert.equal((built.deps.historical as { lastYear: number }).lastYear, 2024);
  assert.equal((built.deps.current as { lastMonth: string }).lastMonth, "2026-09");
  assert.throws(() => crimeIndexBuilder(dir, { execute: (() => { throw new Error("no such file"); }) as unknown as ShadowDeps["execute"] }), /current tables .* could not be read: no such file/, "an unreadable current table is a reason");

  // Through the core, with the registered builder: both tabs answer on the folder's release; a bad folder leaves nibrs answering.
  const baseDeps = { places: {} as ShadowDeps["places"], release: { id: "n-1", firstMonth: "1991-01", lastMonth: "2025-12", asOf: "2026-11-22" }, target: { root: "/n", builtYears: [2025] }, execute: exec };
  const seen: { tab?: string; hist: boolean; cur: boolean }[] = [];
  const hooks: CoreHooks = { base: () => ({ deps: baseDeps, release: "n-1" }),
    answerOutcome: (_r, d) => { seen.push({ tab: d.tab, hist: !!d.historical, cur: !!d.current }); return { kind: "decline", reason: "x", about: "x" } as unknown as ShadowOutcome; } };
  const core = createCore(configFromEnv({ ENGINE_NIBRS_ROOT: "/n", ENGINE_CRIME_INDEX_ROOT: dir }), hooks);
  assert.deepEqual(core.info().tabs, ["nibrs", "historical", "current"]);
  for (const tab of ["historical", "current", "nibrs"]) { const r = core.answer(req("q", { tab })); assert.ok(r.ok, `${tab} answers`); assert.equal((r as { release: string }).release, tab === "nibrs" ? "n-1" : "ci-1"); }
  assert.ok(seen.every((x) => x.hist && x.cur), "every tab's question can read both Crime Index sources");
  assert.deepEqual(core.info().sources, { crimeIndex: "loaded" });
  core.close();
  const bad = createCore(configFromEnv({ ENGINE_NIBRS_ROOT: "/n", ENGINE_CRIME_INDEX_ROOT: path.join(dir, "missing") }), hooks);
  const h = bad.answer(req("q", { tab: "historical" }));
  assert.ok(!h.ok && h.kind === "unavailable" && /no Crime Index manifest\.json/.test(h.message));
  assert.ok(bad.answer(req("q", { tab: "nibrs" })).ok, "nibrs keeps answering when the Crime Index folder is bad");
  assert.match(String((bad.info().sources as Record<string, string>).crimeIndex), /^failed: there is no Crime Index manifest/);
  bad.close();
  // info() alone tries every configured source, and a broken folder is not hammered inside its pause.
  let tries = 0, clock = 0;
  const live = createCore(configFromEnv({ ENGINE_NIBRS_ROOT: "/n", ENGINE_CRIME_INDEX_ROOT: "/nowhere" }), { base: hooks.base, now: () => clock, sources: { crimeIndex: () => { tries++; throw new Error("boom"); } } });
  assert.equal((live.info() as { base: string }).base, "loaded");
  assert.deepEqual(live.info().sources, { crimeIndex: "failed: boom" });
  assert.equal(tries, 1, "a second check inside the pause does not try again");
  clock = 31_000; live.info();
  assert.equal(tries, 2, "after the pause it tries again");
  live.close();
  const ok = createCore(configFromEnv({ ENGINE_NIBRS_ROOT: "/n", ENGINE_CRIME_INDEX_ROOT: dir }), hooks);
  assert.deepEqual(ok.info().sources, { crimeIndex: "loaded" }, "loaded shows without a question first");
  ok.close();
}
  console.log("engine service: pool, protocol and HTTP face: ok");
}
main().catch((e) => { console.error(e); process.exit(1); });






