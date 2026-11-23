/**
 * The scorecard's shard launcher (scripts/scorecard-shards.cjs, used by run-qlog-scorecard.ts --workers N), executed with real child processes:
 * a shard that finishes; a shard that stalls once (the watchdog stops its process tree, records the question it was on as an error, restarts it,
 * and it finishes after that question); a shard that stalls every time (given up after its restarts, the run says so); and the labels' order the
 * runner folds shard outcomes in. Offline: the fake shards are tiny node programs, no data and no DuckDB.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { runShards } = createRequire(import.meta.url ?? __filename)("./scorecard-shards.cjs") as { runShards: (cfg: Record<string, unknown>) => Promise<{ bad: number; stalled: number[] }> };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorecard-workers-test-"));
const f = (n: string) => path.join(dir, n);
const NODE = process.execPath;
// A fake shard: per question it writes the id to its "current" file, then (a) finishes the question: appends its outcome and clears the file, or (b) hangs.
// `hangOn`: the id it hangs on, unless that id is already in its progress file (an error recorded by the watchdog), "always": hangs on the first undone id every time.
const shard = (progress: string, current: string, ids: string[], hangOn: string | null) => [NODE, "-e", `
const fs = require("node:fs");
const [progress, current, ids, hangOn] = JSON.parse(process.argv[1]);
const doneIds = () => fs.existsSync(progress) ? fs.readFileSync(progress, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l).id) : [];
let hung = false;
for (const id of ids) {
  if (doneIds().includes(id)) continue;
  fs.writeFileSync(current, id);
  if (hangOn === "db:" + id) fs.writeFileSync(current, id + "\\tdatabase");
  if (hangOn === id || hangOn === "always" || hangOn === "db:" + id || (hangOn === "reader-twice" && ["b", "c"].includes(id))) { hung = true; setInterval(() => {}, 1000); break; }
  fs.appendFileSync(progress, JSON.stringify({ id, got: { kind: "answer", source: "nibrs", ms: 1 } }) + "\\n");
  fs.writeFileSync(current, "");
}
if (!hung) process.exit(0);`, JSON.stringify([progress, current, ids, hangOn])];

(async () => {
  const run = (shards: [string[], string | null][], extra: Record<string, unknown> = {}) => {
    const progress = shards.map((_, i) => f(`p${Math.random().toString(36).slice(2)}.w${i}`));
    const current = progress.map((p) => `${p}.current`);
    return runShards({ cmds: shards.map(([ids, hang], i) => shard(progress[i], current[i], ids, hang)), progress, current, stallMs: 800, pollMs: 100, restarts: 2, ...extra })
      .then((r) => ({ ...r, outcomes: progress.map((p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])) }));
  };
  // Two shards that finish.
  {
    const r = await run([[["a", "c"], null], [["b", "d"], null]]);
    assert.deepEqual([r.bad, r.stalled], [0, []]);
    assert.deepEqual(r.outcomes.map((o) => o.map((x: { id: string }) => x.id)), [["a", "c"], ["b", "d"]]);
  }
  // One stalls on its second question: stopped, that question is an error, the rest of the shard runs after the restart; the other shard is untouched.
  {
    const r = await run([[["a", "c", "e"], "c"], [["b", "d"], null]]);
    assert.deepEqual([r.bad, r.stalled], [0, [0]], JSON.stringify(r));
    const o = r.outcomes[0];
    assert.deepEqual(o.map((x: { id: string }) => x.id), ["a", "c", "e"]);
    assert.equal(o[1].got.kind, "error");
    assert.match(o[1].got.reason, /stopped by the watchdog/);
    assert.equal(o[0].got.kind, "answer");
    assert.equal(o[2].got.kind, "answer", "the shard went on after the question it stalled on");
    assert.deepEqual(r.outcomes[1].map((x: { id: string }) => x.id), ["b", "d"]);
  }
  // A shard that stalls on every question: each stalled question is recorded as an error and it goes on, until its restarts are used; then it is given up.
  {
    const r = await run([[["a", "b", "c", "d"], "always"]], { restarts: 2 });
    assert.deepEqual([r.bad, r.stalled], [1, [0]], JSON.stringify(r));
    assert.deepEqual(r.outcomes[0].map((x: { id: string }) => x.id), ["a", "b", "c"], "three stalls: two restarts, then given up");
    assert.ok(r.outcomes[0].every((x: { got: { kind: string } }) => x.got.kind === "error"));
  }
  // A shard that fails (a non-zero exit) is a bad shard, never a stall.
  {
    const progress = [f("fail.w0")], current = [f("fail.w0.current")];
    const r = await runShards({ cmds: [[NODE, "-e", "process.exit(3)"]], progress, current, stallMs: 800, pollMs: 100, restarts: 2 });
    assert.deepEqual([r.bad, r.stalled], [1, []]);
  }
  // A reader that overruns (the label alone in the "current" file for readerStallMs) is stopped long before the stall limit, its question is an
  // error with the reader's reason, and it does not use up a restart: with restarts 0 the shard still goes on and finishes every other question.
  {
    const t = Date.now();
    const r = await run([[["a", "b", "c", "d"], "reader-twice"]], { stallMs: 60_000, readerStallMs: 400, restarts: 0 });
    assert.deepEqual([r.bad, r.stalled], [0, []], JSON.stringify(r));
    assert.ok(Date.now() - t < 30_000, "stopped by the reader limit, not the stall limit");
    const o = r.outcomes[0];
    assert.deepEqual(o.map((x: { id: string }) => x.id), ["a", "b", "c", "d"]);
    assert.deepEqual(o.map((x: { got: { kind: string } }) => x.got.kind), ["answer", "error", "error", "answer"]);
    assert.match(o[1].got.reason, /reader took too long/);
    assert.equal(o[1].got.source, null);
  }
  // A question waiting for the database ("id<TAB>database" in the file) is not a reader: the reader limit leaves it, only the stall limit stops it.
  {
    const r = await run([[["a", "b"], "db:b"]], { stallMs: 1500, readerStallMs: 300, restarts: 2 });
    assert.deepEqual([r.bad, r.stalled], [0, [0]], JSON.stringify(r));
    const o = r.outcomes[0];
    assert.match(o[1].got.reason, /stopped by the watchdog/);
    assert.doesNotMatch(o[1].got.reason, /reader/);
  }
  // The reader's own clock (lib/reader-deadline.ts): no limit set does nothing; past the limit it throws; database time is not the reader's.
  {
    const { startReaderClock, noteDatabaseTime, checkReaderClock, ReaderTookTooLong } = await import("../lib/reader-deadline");
    startReaderClock(null, 0);
    checkReaderClock(10 ** 9);
    startReaderClock(45_000, 1000);
    checkReaderClock(1000 + 45_000);
    assert.throws(() => checkReaderClock(1000 + 45_001), (e: unknown) => e instanceof ReaderTookTooLong && /took too long/.test(String(e)) && !/no answer within/.test(String(e)));
    noteDatabaseTime(100_000);
    checkReaderClock(1000 + 100_000 + 45_000);
    assert.throws(() => checkReaderClock(1000 + 100_000 + 45_001), ReaderTookTooLong);
    startReaderClock(null);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("scorecard workers: shards finish, a stalled one is stopped and its question is an error, a shard that keeps stalling is given up, a slow reader is stopped without a restart");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
