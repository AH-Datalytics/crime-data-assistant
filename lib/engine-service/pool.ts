/**
 * The engine's process pool. The engine is synchronous (the DuckDB executor waits with Atomics.wait), so one worker answers one question at a time and concurrency is a small
 * number of worker PROCESSES. This pool is the queue and the guard rails around them, independent of how a worker is made (a forked process in production, a fake in the tests):
 *
 *   - `size` workers, each running one request at a time;
 *   - a bounded queue: when every worker is busy and `queueMax` requests are waiting, a new request is answered "busy" at once (a plain "try again", never a fallback to another engine);
 *   - a per-request time limit: a worker that has not answered in `timeoutMs` is killed and replaced, and the request is answered "timeout";
 *   - a worker that dies is replaced and its request is answered with an error.
 * `submit` never rejects.
 */
import type { EngineRequest, EngineResult } from "./protocol";

export interface PoolWorker {
  /** Runs one request; may reject if the worker dies. */
  run(req: EngineRequest): Promise<EngineResult>;
  kill(): void;
}
export type PoolOptions = { size: number; queueMax: number; timeoutMs: number; spawn: () => PoolWorker };
export type PoolStats = { size: number; busy: number; queued: number; served: number; timeouts: number; crashes: number; rejectedBusy: number };

type Slot = { worker: PoolWorker; busy: boolean };
type Waiting = { req: EngineRequest; resolve: (r: EngineResult) => void };

export class EnginePool {
  private slots: Slot[] = [];
  private queue: Waiting[] = [];
  private closed = false;
  private counters = { served: 0, timeouts: 0, crashes: 0, rejectedBusy: 0 };

  constructor(private opts: PoolOptions) {
    if (!(opts.size >= 1 && opts.queueMax >= 0 && opts.timeoutMs > 0)) throw new Error("pool: size must be at least 1, queueMax at least 0 and timeoutMs positive");
    for (let i = 0; i < opts.size; i++) this.slots.push({ worker: opts.spawn(), busy: false });
  }

  stats(): PoolStats {
    return { size: this.slots.length, busy: this.slots.filter((s) => s.busy).length, queued: this.queue.length, ...this.counters };
  }

  submit(req: EngineRequest): Promise<EngineResult> {
    if (this.closed) return Promise.resolve({ ok: false, kind: "error", message: "The engine service is shutting down." });
    return new Promise((resolve) => {
      const free = this.slots.some((s) => !s.busy);
      if (!free && this.queue.length >= this.opts.queueMax) {
        this.counters.rejectedBusy++;
        resolve({ ok: false, kind: "busy", message: "The engine is busy answering other questions. Try again in a moment." });
        return;
      }
      this.queue.push({ req, resolve });
      this.pump();
    });
  }

  close(): void {
    this.closed = true;
    for (const w of this.queue.splice(0)) w.resolve({ ok: false, kind: "error", message: "The engine service is shutting down." });
    for (const s of this.slots) s.worker.kill();
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.busy) continue;
      const next = this.queue.shift();
      if (!next) return;
      this.start(slot, next);
    }
  }

  private start(slot: Slot, w: Waiting): void {
    slot.busy = true;
    let settled = false;
    const t0 = performance.now();
    const finish = (r: EngineResult, replace: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (replace) {
        try { slot.worker.kill(); } catch { /* already gone */ }
        if (!this.closed) slot.worker = this.opts.spawn();
      }
      slot.busy = false;
      w.resolve(r);
      this.pump();
    };
    const timer = setTimeout(() => {
      this.counters.timeouts++;
      finish({ ok: false, kind: "timeout", message: "The engine took too long on this question and stopped it. Try a narrower question (one place, one year)." }, true);
    }, this.opts.timeoutMs);
    slot.worker.run(w.req).then(
      (r) => { this.counters.served++; finish(r.ok ? { ...r, ms: Math.round(performance.now() - t0) } : r, false); },
      (e) => { this.counters.crashes++; finish({ ok: false, kind: "error", message: `The engine worker stopped: ${e instanceof Error ? e.message : String(e)}` }, true); },
    );
  }
}
