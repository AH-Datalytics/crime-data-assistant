/**
 * The engine service (stage 1): an HTTP service on 127.0.0.1 with a small pool of forked worker processes. Built to services/engine/dist/main.cjs and worker.cjs by
 * scripts/build-engine-service.mjs; started by the process manager (a systemd unit with MemoryMax, CPUQuota; docs/runbooks/engine-service.md). Nothing here starts by itself.
 *
 * Environment (all required unless a default is shown):
 *   ENGINE_TOKEN          shared secret the web route sends in x-engine-token (at least 16 characters)
 *   ENGINE_PORT           default 8420; the service listens on 127.0.0.1 only
 *   ENGINE_WORKERS        default 2
 *   ENGINE_QUEUE_MAX      default 8 waiting requests beyond the busy workers; more is answered "busy"
 *   ENGINE_TIMEOUT_MS     default 120000: a worker that overruns is killed and replaced
 *   ENGINE_DUCKDB_MEMORY  default 2GB, ENGINE_DUCKDB_THREADS default 1 (per worker)
 *   ENGINE_NIBRS_ROOT     the canonical release folder (.../canonical); ENGINE_PYTHON the python with duckdb; ENGINE_RELEASE_FILE optional
 *   NIBRS_CUBE, NIBRS_CUBE_SET, NIBRS_CUBE_SET_SHA256 (or the four root variables): the cubes, as the engine reads them
 */
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createEngineServer } from "../../lib/engine-service/http";
import { EnginePool, type PoolWorker } from "../../lib/engine-service/pool";
import type { EngineRequest, EngineResult } from "../../lib/engine-service/protocol";

const env = process.env;
const num = (v: string | undefined, d: number) => { const n = Number(v ?? d); return Number.isFinite(n) && n > 0 ? n : d; };
const info: Record<string, unknown> = {};

/** A worker process behind the pool's interface. */
function forkWorker(): PoolWorker {
  const child: ChildProcess = fork(path.join(__dirname, "worker.cjs"), [], { env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let next = 1;
  const pending = new Map<number, { resolve: (r: EngineResult) => void; reject: (e: Error) => void }>();
  const dead = (why: string) => { for (const p of pending.values()) p.reject(new Error(why)); pending.clear(); };
  child.on("message", (m: { id?: number; result?: EngineResult; ready?: boolean; info?: Record<string, unknown> }) => {
    if (m.info) Object.assign(info, m.info);
    if (m.id !== undefined && m.result) { const p = pending.get(m.id); pending.delete(m.id); p?.resolve(m.result); }
  });
  child.on("exit", (code, signal) => dead(`worker exited (${signal ?? code})`));
  child.on("error", (e) => dead(e.message));
  return {
    run(req: EngineRequest) {
      return new Promise<EngineResult>((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        child.send({ id, req }, (e) => { if (e) { pending.delete(id); reject(e); } });
      });
    },
    kill() { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
  };
}

const token = env.ENGINE_TOKEN ?? "";
const pool = new EnginePool({ size: Math.floor(num(env.ENGINE_WORKERS, 2)), queueMax: Math.floor(num(env.ENGINE_QUEUE_MAX, 8)), timeoutMs: num(env.ENGINE_TIMEOUT_MS, 120000), spawn: forkWorker });
const server = createEngineServer({ pool, token, info: () => info, startedAt: new Date().getTime() });
const port = Math.floor(num(env.ENGINE_PORT, 8420));
server.listen(port, "127.0.0.1", () => console.log(`engine service listening on 127.0.0.1:${port} with ${pool.stats().size} workers`));
const stop = () => { pool.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
