/**
 * The executor's temp directory (lib/nibrs-shadow/duckdb.ts): removed when the executor ends, however it ends; old folders that no
 * live process owns are swept; nothing but this code's own folders and files is ever removed. (A killed national query left
 * 8-12 GB behind: 188 folders, 147 GB on the runner, 2026-11-16.) The last part needs a Python with duckdb (NIBRS_SHADOW_PYTHON,
 * else "python") and is skipped without one.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { duckdbExecutor, removeShadowTemp, sweepShadowTemp } from "../lib/nibrs-shadow/duckdb";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-temp-test-"));
const mk = (name: string, files: Record<string, string>, ageHours = 0): string => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(d, f), body);
  const t = new Date(Date.now() - ageHours * 3600_000);
  for (const f of Object.keys(files)) fs.utimesSync(path.join(d, f), t, t);
  fs.utimesSync(d, t, t);
  return d;
};
// A pid that is certainly not running: a child that has exited.
const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
try {
  // ---- removeShadowTemp: only this code's own folders and files
  const spill = { "duckdb_temp_storage_DEFAULT-0.tmp": "x".repeat(1000), "duckdb_temp_storage_S128K-0.tmp": "y", ".owner": "{}", "q.sql": "SELECT 1" };
  const ok = mk("nibrs-shadow-aB3dE9", spill);
  assert.equal(removeShadowTemp(ok, root), true);
  assert.equal(fs.existsSync(ok), false, "a folder with only its own files goes");
  const foreign = mk("nibrs-shadow-zZ9y8x", { "duckdb_temp_storage_DEFAULT-0.tmp": "x", "precious.txt": "keep" });
  assert.equal(removeShadowTemp(foreign, root), false, "a file this code never writes: the folder stays");
  assert.deepEqual(fs.readdirSync(foreign), ["precious.txt"], "its own spill file went, the other file stayed");
  const wrongName = mk("nibrs-shadow-toolongname", { "q.sql": "x" });
  assert.equal(removeShadowTemp(wrongName, root), false, "a name that is not nibrs-shadow-<6 characters>");
  assert.equal(fs.existsSync(wrongName), true);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-shadow-"));
  assert.equal(removeShadowTemp(elsewhere, root), false, "not a child of the given temp root");
  assert.equal(fs.existsSync(elsewhere), true);
  fs.rmdirSync(elsewhere);
  assert.equal(removeShadowTemp(path.join(root, "nibrs-shadow-nopeee"), root), true, "already gone counts as gone");
  assert.equal(removeShadowTemp(path.join(root, "..", path.basename(root), "nibrs-shadow-abcdef"), root), true);

  // ---- sweepShadowTemp
  const oldUnowned = mk("nibrs-shadow-old111", spill, 7);
  const oldNoOwnerFile = mk("nibrs-shadow-old222", { "duckdb_temp_storage_DEFAULT-0.tmp": "x" }, 30);
  const oldDeadOwner = mk("nibrs-shadow-old333", { ...spill, ".owner": JSON.stringify({ pid: dead }) }, 8);
  const oldLiveOwner = mk("nibrs-shadow-old444", { ...spill, ".owner": JSON.stringify({ pid: process.pid }) }, 9);
  const recent = mk("nibrs-shadow-new555", spill, 1);
  const otherOld = mk("some-other-folder", { "q.sql": "x" }, 50);
  const oldForeign = mk("nibrs-shadow-old666", { "q.sql": "x", "notes.txt": "keep" }, 20);
  const removed = sweepShadowTemp({ tmpRoot: root });
  assert.deepEqual(removed.sort(), ["nibrs-shadow-old111", "nibrs-shadow-old222", "nibrs-shadow-old333"], "old, no live owner, only its own files");
  assert.equal(fs.existsSync(oldLiveOwner), true, "a live process owns it: kept however old");
  assert.equal(fs.existsSync(recent), true, "under 6 hours: kept");
  assert.equal(fs.existsSync(otherOld), true, "another name: never touched");
  assert.equal(fs.existsSync(path.join(oldForeign, "notes.txt")), true, "a file that is not this code's: kept");
  assert.equal(fs.existsSync(oldUnowned) || fs.existsSync(oldNoOwnerFile) || fs.existsSync(oldDeadOwner), false);
  // The age is the newest file's: a spill file written a minute ago keeps an old folder.
  const active = mk("nibrs-shadow-act777", spill, 12);
  fs.utimesSync(path.join(active, "duckdb_temp_storage_DEFAULT-0.tmp"), new Date(), new Date());
  assert.deepEqual(sweepShadowTemp({ tmpRoot: root }), [], "a folder with a file written just now is not old");
  assert.equal(fs.existsSync(active), true);
  // A temp root that does not exist is nothing to sweep.
  assert.deepEqual(sweepShadowTemp({ tmpRoot: path.join(root, "no-such-dir") }), []);
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ---- the executor itself (needs Python with duckdb)
const python = process.env.NIBRS_SHADOW_PYTHON ?? "python";
if (spawnSync(python, ["-I", "-c", "import duckdb"]).status !== 0) {
  console.log("nibrs duckdb temp: removal and sweep checked; executor part skipped (no Python with duckdb)");
  process.exit(0);
}
const exists = (d: string) => fs.existsSync(d);
// Closed: the directory is gone.
const a = duckdbExecutor(python);
assert.deepEqual(a("SELECT 1"), [[1]]);
assert.ok(exists(a.tempDir) && exists(path.join(a.tempDir, ".owner")), "made, with its owner file");
assert.equal(path.dirname(path.resolve(a.tempDir)), path.resolve(os.tmpdir()));
a.close();
assert.equal(exists(a.tempDir), false, "closed: removed");
// The reference path (one process per query) writes q.sql: removed on close as well.
const b = duckdbExecutor(python, { persistent: false });
assert.deepEqual(b("SELECT 2"), [[2]]);
b.close();
assert.equal(exists(b.tempDir), false);
// A query past the time limit is killed; the spill files it wrote go with the directory.
const c = duckdbExecutor(python, { memoryLimit: "256MB", threads: 2, timeoutMs: 8000 });
assert.throws(() => c("SELECT count(*) FROM (SELECT i, random() AS r FROM range(400000000) t(i) ORDER BY r)"), /no answer within 8 s/);
assert.equal(exists(c.tempDir), false, "killed at the limit: no spill files left behind");
// The program ending: a child that never closes its executor leaves nothing.
const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
  const { duckdbExecutor } = require("./lib/nibrs-shadow/duckdb");
  const e = duckdbExecutor(${JSON.stringify(python)}); e("SELECT 1"); console.log(e.tempDir);`], { encoding: "utf8", cwd: path.join(__dirname, "..") });
const left = child.stdout.trim().split("\n").pop()!;
assert.ok(left.includes("nibrs-shadow-"), `child printed its temp directory: ${child.stdout}${child.stderr}`.slice(0, 300));
assert.equal(exists(left), false, "the program ended without closing: removed at exit");
console.log("nibrs duckdb temp: removed when the executor closes, is killed or the program ends; the sweep removes only old unowned folders of this code");
