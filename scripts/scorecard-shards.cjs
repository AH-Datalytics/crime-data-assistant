/**
 * The shard launcher of scripts/run-qlog-scorecard.ts (--workers N): N copies of the runner at once, each on every Nth label with its own
 * DuckDB process, progress file and cache file, plus a watchdog (the shard that hung on 2026-11-07 had no one watching it).
 *
 * The watchdog: a shard whose progress file has not grown for `stallMs` is stopped (its whole process tree) and, up to `restarts` times,
 * started again; it resumes where its progress file ends. The question it was on (named in the shard's "current" file) is recorded as an
 * error outcome, so a question that hangs is that question's error and never the run's: the other questions finish and the run is complete.
 * After the last restart a shard that stalls again is left stopped (the run reports it and is incomplete).
 *
 * Plain CommonJS, run by `node scripts/scorecard-shards.cjs <config json>` or required by the test, so it is exercised as it runs.
 */
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");

/**
 * cfg: { cmds: [[command, ...args], ...], progress: [file per shard], current: [file per shard holding the label id it is on],
 *        stallMs, restarts, pollMs, stalledReason }
 * Resolves { bad: number of shards that failed or were given up, stalled: [shard indexes that were stopped at least once] }.
 */
function runShards(cfg) {
  const { cmds, progress, current } = cfg;
  const stallMs = cfg.stallMs ?? 20 * 60_000, restarts = cfg.restarts ?? 2, pollMs = cfg.pollMs ?? 15_000;
  const reason = cfg.stalledReason ?? "the shard stalled on this question and was stopped by the watchdog";
  return new Promise((resolve) => {
    const state = cmds.map(() => ({ child: null, done: false, failed: false, starts: 0, lastSize: -1, lastChange: Date.now(), killed: false, stalled: false }));
    let timer = null;
    const finish = () => {
      if (!state.every((s) => s.done || s.failed)) return;
      if (timer) clearInterval(timer);
      resolve({ bad: state.filter((s) => s.failed).length, stalled: state.map((s, i) => (s.stalled ? i : -1)).filter((i) => i >= 0) });
    };
    const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
    const start = (i) => {
      const s = state[i], [cmd, ...args] = cmds[i];
      s.starts++; s.killed = false; s.lastChange = Date.now(); s.lastSize = size(progress[i]);
      s.child = spawn(cmd, args, { stdio: "inherit" });
      s.child.on("exit", (code) => {
        s.child = null;
        if (s.killed) {
          // Stopped by the watchdog: the question it was on is an error, then the shard resumes after it (or is given up on).
          let id = "";
          try { id = fs.readFileSync(current[i], "utf8").trim(); } catch { /* the shard had not named one */ }
          // The "current" file is empty between questions: a stall there (a shard that never began one) records nothing and only restarts.
          if (id) fs.appendFileSync(progress[i], JSON.stringify({ id, got: { kind: "error", source: null, reason, ms: stallMs } }) + "\n");
          if (s.starts <= restarts) { console.log(`shard ${i}: restarted${id ? ` after ${id}` : ""} (stall ${s.starts})`); start(i); return; }
          s.failed = true; finish(); return;
        }
        if (code === 0) s.done = true; else s.failed = true;
        finish();
      });
    };
    cmds.forEach((_, i) => start(i));
    timer = setInterval(() => {
      const now = Date.now();
      state.forEach((s, i) => {
        if (!s.child || s.done || s.failed || s.killed) return;
        const sz = size(progress[i]);
        if (sz !== s.lastSize) { s.lastSize = sz; s.lastChange = now; return; }
        if (now - s.lastChange < stallMs) return;
        s.killed = true; s.stalled = true;
        console.log(`shard ${i}: no progress for ${Math.round((now - s.lastChange) / 60_000)} min (pid ${s.child.pid}): stopping it`);
        // The whole tree: the shard's DuckDB process must not outlive it (the next one must never run beside it).
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(s.child.pid), "/T", "/F"], { stdio: "ignore" });
        else s.child.kill("SIGKILL");
      });
    }, pollMs);
  });
}

module.exports = { runShards };

if (require.main === module) {
  const cfg = JSON.parse(process.argv[2]);
  runShards(cfg).then((r) => process.exit(r.bad ? 1 : 0));
}
