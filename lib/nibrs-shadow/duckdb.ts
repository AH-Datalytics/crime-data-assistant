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

/** The Python side of the persistent executor: one JSON request per line in, one JSON response per line out. */
const SERVER = `import duckdb, json, sys
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
// A large result arrives in many chunks: they are kept as a list and joined once its line ends (scanning only the new
// chunk), never re-scanned as one growing string.
let parts = [], stderr = "";
const reply = (msg) => { port.postMessage(msg); Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); };
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  let i;
  while ((i = d.indexOf("\\n")) >= 0) { parts.push(d.slice(0, i)); reply(parts.join("")); parts = []; d = d.slice(i + 1); }
  if (d) parts.push(d);
});
child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
child.on("exit", (code) => reply(JSON.stringify({ error: "duckdb process exited (" + code + "): " + stderr })));
parentPort.on("message", (m) => child.stdin.write(JSON.stringify({ sql: m }) + "\\n"));
`;

export type DuckdbOptions = { persistent?: boolean; cacheSize?: number };

export function duckdbExecutor(python: string, opts: DuckdbOptions = {}): (sql: string) => unknown[][] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-shadow-")).replace(/\\/g, "/");
  const run = opts.persistent === false ? spawnPerQuery(python, tmp) : persistent(python, tmp);
  // The build is pinned and read-only: the same SQL gives the same rows. Least recently used out first.
  const cache = new Map<string, unknown[][]>();
  const size = opts.cacheSize ?? 256;
  return (sql: string) => {
    const hit = cache.get(sql);
    if (hit) { cache.delete(sql); cache.set(sql, hit); return hit; }
    const rows = run(sql);
    cache.set(sql, rows);
    if (cache.size > size) cache.delete(cache.keys().next().value!);
    return rows;
  };
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
function persistent(python: string, tmp: string): (sql: string) => unknown[][] {
  const flag = new SharedArrayBuffer(4);
  const signal = new Int32Array(flag);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(WORKER, { eval: true, workerData: { python, server: SERVER, tmp, flag, port: port2 }, transferList: [port2] });
  // The worker and its process never keep the program alive on their own.
  worker.unref();
  port1.unref();
  let dead: string | null = null;
  return (sql: string) => {
    if (dead) throw new Error(dead);
    Atomics.store(signal, 0, 0);
    worker.postMessage(sql);
    Atomics.wait(signal, 0, 0);
    const msg = receiveMessageOnPort(port1);
    if (!msg) throw new Error("duckdb worker gave no response");
    const out = JSON.parse(String(msg.message)) as { rows?: unknown[][]; error?: string };
    if (out.error) {
      if (/process exited/.test(out.error)) dead = `duckdb failed: ${out.error}`;
      throw new Error(`duckdb failed: ${out.error}`);
    }
    return out.rows!;
  };
}
