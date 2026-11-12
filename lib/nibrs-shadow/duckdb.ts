/**
 * Runs the shadow slice's SQL in an in-memory DuckDB through a local Python with duckdb (as scripts/nibrs-compile-gate.ts
 * does). The SQL only reads the canonical parquet files named in it; nothing is written but temp files. The progress
 * bar is off: on a slow query it would print into the rows read back.
 *
 * Speed (Jeff 2026-11-01, "it's very slow to load"): starting Python and importing DuckDB took about 0.7 s for every
 * query, and a state sum runs three. The executor keeps ONE Python process and its DuckDB connection for its lifetime:
 * a worker thread talks to the process, and the caller waits for the answer synchronously (Atomics.wait), so the engine
 * stays synchronous. Results are cached by SQL text: the build is read-only and pinned, so the same SQL always gives
 * the same rows (a state sum asks for its agencies' header rows twice). `persistent: false` keeps one process per
 * query, the reference path.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

/**
 * The Python side of the persistent executor: one JSON request per line in, one JSON response per line out. Exported for
 * the scorecard's cache fingerprint (the rows depend on it).
 */
export const SERVER = `import duckdb, json, sys
con = duckdb.connect()
con.execute("SET temp_directory = ?", [sys.argv[1]])
con.execute("SET enable_progress_bar = false")
for line in sys.stdin:
    try:
        out = {"rows": con.execute(json.loads(line)["sql"]).fetchall()}
    except Exception as e:
        out = {"error": f"{type(e).__name__}: {e}"}
    sys.stdout.write(json.dumps(out, default=str) + "\\n")
    sys.stdout.flush()
`;

/** The worker thread: starts the Python process, passes each request on, and wakes the caller with the response. */
const WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const { python, server, tmp, flag, port } = workerData;
const child = spawn(python, ["-I", "-c", server, tmp], { stdio: ["pipe", "pipe", "pipe"] });
const signal = new Int32Array(flag);
// The process id, so the caller can end the process itself when it closes the executor (a running query isn't stopped
// by ending the worker).
// -1 when it couldn't start. The caller may be waiting for it (closing an executor whose process is still starting).
Atomics.store(signal, 1, child.pid ?? -1);
Atomics.notify(signal, 1);
// A large result arrives in many chunks: they are kept as a list and joined once its line ends (scanning only the new
// chunk), never re-scanned as one growing string.
let parts = [], stderr = "";
// One reply per request, never one unasked (Codex speed review 01): a process that fails to start or exits is
// remembered, answers the request waiting if there is one, and answers every later request at once.
let pending = false, gone = null;
const reply = (msg) => { pending = false; port.postMessage(msg); Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); };
const fail = (why) => { gone ??= JSON.stringify({ error: "duckdb process exited: " + why + (stderr ? ": " + stderr : "") }); if (pending) reply(gone); };
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  let i;
  while ((i = d.indexOf("\\n")) >= 0) { parts.push(d.slice(0, i)); if (pending) reply(parts.join("")); parts = []; d = d.slice(i + 1); }
  if (d) parts.push(d);
});
child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
child.on("error", (e) => fail(String(e && e.message || e)));
child.on("exit", (code) => fail("code " + code));
child.stdin.on("error", (e) => fail(String(e && e.message || e)));
parentPort.on("message", (m) => {
  if (gone) { pending = true; reply(gone); return; }
  pending = true;
  child.stdin.write(JSON.stringify({ sql: m }) + "\\n");
});
`;

/**
 * `timeoutMs`: the longest one query may take on the persistent path (default 300 s). `memoryLimit` ("4GB") and
 * `threads`: DuckDB's own limits, set once when the process starts (persistent path only); unset, DuckDB's defaults
 * (80% of the machine's memory, every core) apply, as the app's routes use it. Spilling goes to the executor's temp
 * directory. They never change a query's rows.
 */
export type DuckdbOptions = { persistent?: boolean; cacheSize?: number; timeoutMs?: number; memoryLimit?: string; threads?: number };

/** An executor; `close()` ends its Python process (the worker's end closes the process's input, and it exits). */
export type DuckdbExecutor = ((sql: string) => unknown[][]) & { close(): void };
export function duckdbExecutor(python: string, opts: DuckdbOptions = {}): DuckdbExecutor {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-shadow-")).replace(/\\/g, "/");
  const run = opts.persistent === false ? spawnPerQuery(python, tmp) : persistent(python, tmp, opts.timeoutMs ?? 300_000);
  // The limits are set on the process before any query (the runner laptop, 16 GB, was killed twice for low memory by
  // DuckDB's default limit). Checked here, never passed into SQL as written.
  if (opts.memoryLimit !== undefined || opts.threads !== undefined) {
    if (opts.persistent === false) throw new Error("duckdb executor: memoryLimit and threads apply to the persistent executor only");
    if (opts.memoryLimit !== undefined) {
      if (!/^\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i.test(opts.memoryLimit)) throw new Error(`duckdb executor: memoryLimit "${opts.memoryLimit}" is not a size such as 4GB`);
      run(`SET memory_limit = '${opts.memoryLimit.replace(/\s+/g, "")}'`);
    }
    if (opts.threads !== undefined) {
      if (!Number.isInteger(opts.threads) || opts.threads < 1) throw new Error(`duckdb executor: threads ${opts.threads} is not a positive whole number`);
      run(`SET threads = ${opts.threads}`);
    }
  }
  // The build is pinned and read-only: the same SQL gives the same rows. Least recently used out first.
  const cache = new Map<string, unknown[][]>();
  const size = opts.cacheSize ?? 256;
  return Object.assign((sql: string) => {
    const hit = cache.get(sql);
    if (hit) { cache.delete(sql); cache.set(sql, hit); return hit; }
    // Diagnosis only (job AR1, recount mismatch): NIBRS_SQL_LOG names a file each query is appended to, so a checker
    // can diff the engine's own SQL against a recount key by key. Unset, nothing is written.
    if (process.env.NIBRS_SQL_LOG) fs.appendFileSync(process.env.NIBRS_SQL_LOG, `${sql}\n;\n`);
    const rows = run(sql);
    cache.set(sql, rows);
    if (cache.size > size) cache.delete(cache.keys().next().value!);
    return rows;
  }, { close: () => (run as { close?: () => void }).close?.() });
}

/** One Python process per query (the reference path). */
function spawnPerQuery(python: string, tmp: string): (sql: string) => unknown[][] {
  return (sql: string) => {
    const file = path.join(tmp, "q.sql");
    fs.writeFileSync(file, sql);
    const r = spawnSync(python, ["-I", "-c", `import duckdb, json, sys
con = duckdb.connect()
con.execute("SET temp_directory = ?", [sys.argv[2]])
con.execute("SET enable_progress_bar = false")
print(json.dumps(con.execute(open(sys.argv[1], encoding="utf-8").read()).fetchall(), default=str))`, file, tmp], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`duckdb failed: ${r.stderr.slice(-2000)}`);
    return JSON.parse(r.stdout);
  };
}

/** One Python process for the executor's lifetime; each call waits for its own response. */
function persistent(python: string, tmp: string, timeoutMs: number): (sql: string) => unknown[][] {
  const flag = new SharedArrayBuffer(8);
  const signal = new Int32Array(flag);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER, { eval: true, workerData: { python, server: SERVER, tmp, flag, port: port2 }, transferList: [port2] });
  // The worker and its process never keep the program alive on their own.
  worker.unref();
  port1.unref();
  let dead: string | null = null;
  // Ends the Python process and everything it started (a venv's python.exe starts the real one) before returning, so a
  // query past the limit stops using the machine and a replacement never runs beside it (Codex PR-mode review 02.2).
  // A process still starting is waited for (up to a minute), so it can't come up after the close (Codex PR-mode review
  // 03). If it can't be ended, the program stops: a replacement must never run beside it.
  const end = () => {
    if (Atomics.load(signal, 1) === 0) Atomics.wait(signal, 1, 0, 60_000);
    const pid = Atomics.load(signal, 1);
    if (pid === 0) throw new Error("duckdb executor: the process never started and can't be closed");
    if (pid > 0) {
      if (process.platform === "win32") {
        // 128: no such process (it has exited already).
        const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        if (r.status !== 0 && r.status !== 128) throw new Error(`duckdb executor: taskkill failed (${r.error ?? r.status})`);
      } else try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    void worker.terminate();
  };
  return Object.assign((sql: string) => {
    if (dead) throw new Error(dead);
    Atomics.store(signal, 0, 0);
    worker.postMessage(sql);
    // Never wait forever (Codex speed review 01): past the limit the executor is closed and the call fails.
    if (Atomics.wait(signal, 0, 0, timeoutMs) === "timed-out") {
      dead = `duckdb failed: no answer within ${timeoutMs / 1000} s`;
      end();
      throw new Error(dead);
    }
    const msg = receiveMessageOnPort(port1);
    if (!msg) throw new Error("duckdb worker gave no response");
    const out = JSON.parse(String(msg.message)) as { rows?: unknown[][]; error?: string };
    if (out.error) {
      if (/process exited/.test(out.error)) dead = `duckdb failed: ${out.error}`;
      throw new Error(`duckdb failed: ${out.error}`);
    }
    return out.rows!;
  }, { close: () => { dead ??= "duckdb executor closed"; end(); } });
}

/** The built monthly totals at `root` (scripts/build-nibrs-month-totals.ts): a measure's file, or null where not built. */
export function monthTotalsAt(root: string | undefined): ((measureId: string) => string | null) | undefined {
  if (!root || !fs.existsSync(path.join(root, "manifest.json"))) return undefined;
  const built = new Set(Object.keys((JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as { built: Record<string, unknown> }).built));
  const dir = root.replace(/\\/g, "/");
  return (id) => (built.has(id) ? `${dir}/${id}.parquet` : null);
}
