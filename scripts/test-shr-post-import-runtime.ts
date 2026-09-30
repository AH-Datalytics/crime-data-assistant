/**
 * The SHR post-import runtime correction (scripts/ops/shr-post-import-runtime.js, scripts/ops/shr-auto-update.js,
 * scripts/ops/shr-post-import-recover.js), on disposable fixtures through the actual launch mechanism: this Node
 * binary, the release's installed tsx loader, real child processes and the real sqlite3 CLI. Nothing here reads
 * or writes a real database, contacts a server or installs anything.
 *
 *   1. the runtime module: pinned release, reviewed-hash check, no npx, a native load that reaches the addon
 *      (Codex SR-1), deadline admission before every dispatch including preflight's own (SR-2), a stalled
 *      command killed at the deadline, failure stops with a status record, arguments and environment preserved;
 *   2. the reviewed importer, loaded in memory with only its paths and its curl/unzip calls redirected to the
 *      fixture: an unusable runtime refuses BEFORE any delete or download; an expiry at any point before or
 *      during the replacement leaves the year exactly as it was (SR-2); a usable runtime imports and runs the
 *      steps; a failing step fails the run; the served importer's other behavior is unchanged;
 *   3. the recovery entry: type fill-in only (SR-3), preflight-only dispatches nothing, and the REAL reviewed
 *      normalizer run on a disposable database shows exactly what the recovery writes.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Module from "node:module";
import childProcess, { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { classifyShrAgency, loadShrTypeEvidence } from "../lib/shr-agency-classification";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const runtimeModule = require("./ops/shr-post-import-runtime.js");
const { createDeadline, shrPostImportSteps, shrTypeRecoverySteps, resolveRuntime, preflight, runSteps, PostImportRefusal } = runtimeModule;

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${String((error as Error).message).split("\n")[0]}`); }
}

const REPO = path.resolve(__dirname, "..");
// Importer runs that throw leave their in-process database handle open until this process exits, which can
// block removing this run's folder on Windows; sweep earlier runs' leftovers first (best effort).
for (const old of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("shr-runtime-"))) {
  try { fs.rmSync(path.join(os.tmpdir(), old), { recursive: true, force: true }); } catch { /* still in use by a live run */ }
}
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "shr-runtime-"));
const SQLITE = process.env.SHR_SQLITE3 || "sqlite3";
const RUNTIME_FILE = path.join(REPO, "scripts", "ops", "shr-post-import-runtime.js");
const SHIPPED_MANIFEST = path.join(REPO, "scripts", "ops", "shr-post-import-manifest.json");
const sha = (text: string | Buffer) => crypto.createHash("sha256").update(text).digest("hex");
/** Committed at HEAD: pinned as the git blob. */
const COMMITTED = ["scripts/normalize-shr-agencies.ts", "scripts/build-shr-state-population.ts", "scripts/extend-state-population-cde.ts",
  "lib/shr-agency-normalization.ts", "lib/state-population.ts"];
/** The policy-enforcing evidence builder and its library (2026-09-30), not yet committed: pinned as LF-normalized bytes. */
const POLICY = ["scripts/build-shr-agency-type-evidence.ts", "lib/shr-agency-classification.ts"];
const REVIEWED = [...COMMITTED, ...POLICY];
/** The bytes a git-built Linux release carries for a reviewed file. */
const releaseBytes = (rel: string): Buffer => COMMITTED.includes(rel)
  ? spawnSync("git", ["show", `HEAD:${rel}`], { cwd: REPO, windowsHide: true, maxBuffer: 1 << 26 }).stdout
  : Buffer.from(fs.readFileSync(path.join(REPO, rel), "utf8").replace(/\r\n/g, "\n"), "utf8");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A fake step script: records how it was launched (and its own pid), optionally sleeps, stalls or fails. */
function stepScript(name: string) {
  return `import fs from "node:fs";
const out = process.env.SHR_TEST_MARKERS + "/${name}.json";
fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath, pid: process.pid,
  env: { SHR_DB_PATH: process.env.SHR_DB_PATH, NIBRS_DB_PATH: process.env.NIBRS_DB_PATH, RTCI_DB_PATH: process.env.RTCI_DB_PATH,
    NODE_PATH: process.env.NODE_PATH, npm_config_offline: process.env.npm_config_offline } }));
const sleep = Number(process.env.SHR_TEST_SLEEP_${name.replace(/-/g, "_").toUpperCase()} || 0);
if (sleep) { const end = Date.now() + sleep; while (Date.now() < end) { /* busy wait */ } }
if (process.env.SHR_TEST_FAIL === "${name}") { console.error("simulated failure"); process.exit(1); }
if (process.env.SHR_TEST_STALL === "${name}") setInterval(() => {}, 1000);
`;
}

type ReleaseOpts = { tsx?: boolean; betterSqlite3?: "real" | "incompatible" | "invalid-native" | "absent"; drop?: string; tamper?: string; realScripts?: boolean };
function makeRelease(label: string, opts: ReleaseOpts = {}) {
  const root = path.join(WORK, label);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  let manifest = SHIPPED_MANIFEST;
  if (opts.realScripts) {
    // The reviewed bytes themselves (the committed blobs, as a Linux release carries them -- a Windows
    // checkout may have CRLF), so the SHIPPED manifest matches and the real normalizer runs.
    for (const rel of REVIEWED) fs.writeFileSync(path.join(root, rel), releaseBytes(rel));
  } else {
    const files: Record<string, string> = {};
    for (const rel of REVIEWED) {
      const name = path.basename(rel, ".ts");
      const body = rel.startsWith("scripts/") ? stepScript(name) : `export const fixture = "${name}";\n`;
      files[rel] = sha(body);
      if (opts.drop === rel) continue;
      fs.writeFileSync(path.join(root, rel), opts.tamper === rel ? body + "// changed\n" : body);
    }
    manifest = path.join(root, "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ kind: "test", files }));
  }
  const nm = path.join(root, "node_modules");
  fs.mkdirSync(nm);
  if (opts.tsx !== false) fs.symlinkSync(path.join(REPO, "node_modules", "tsx"), path.join(nm, "tsx"), "junction");
  const bs = opts.betterSqlite3 ?? "real";
  if (bs === "real") fs.symlinkSync(path.join(REPO, "node_modules", "better-sqlite3"), path.join(nm, "better-sqlite3"), "junction");
  if (bs === "incompatible") {
    fs.mkdirSync(path.join(nm, "better-sqlite3"));
    fs.writeFileSync(path.join(nm, "better-sqlite3", "package.json"), JSON.stringify({ name: "better-sqlite3", main: "index.js" }));
    // The September error text, thrown on require (earlier than the real package fails).
    fs.writeFileSync(path.join(nm, "better-sqlite3", "index.js"),
      "const e = new Error('The module better_sqlite3.node\\nwas compiled against a different Node.js version using\\nNODE_MODULE_VERSION 127. This version of Node.js requires\\nNODE_MODULE_VERSION 137.'); e.code = 'ERR_DLOPEN_FAILED'; throw e;\n");
  }
  if (bs === "invalid-native") {
    // Codex SR-1 control: the REAL JS wrapper (which loads its addon only in the Database constructor) over an
    // unusable native binary. `require` succeeds; constructing a database fails with ERR_DLOPEN_FAILED.
    const dir = path.join(nm, "better-sqlite3");
    fs.mkdirSync(path.join(dir, "build", "Release"), { recursive: true });
    fs.cpSync(path.join(REPO, "node_modules", "better-sqlite3", "lib"), path.join(dir, "lib"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "node_modules", "better-sqlite3", "package.json"), path.join(dir, "package.json"));
    fs.writeFileSync(path.join(dir, "build", "Release", "better_sqlite3.node"), "deliberately invalid native fixture");
    for (const dep of ["bindings", "file-uri-to-path"]) fs.symlinkSync(path.join(REPO, "node_modules", dep), path.join(nm, dep), "junction");
  }
  const markers = path.join(root, "markers");
  fs.mkdirSync(markers);
  // The release link is a symlink, as /opt/nibrs/current is.
  const link = path.join(WORK, `${label}-link`);
  fs.symlinkSync(root, link, "junction");
  return { root, link, manifest, markers };
}

function freshDb(file: string, seed2026 = 3) {
  const db = new Database(file);
  db.exec(fs.readFileSync(path.join(REPO, "scripts", "fixtures", "operation-taxonomy", "shr.ddl.sql"), "utf8"));
  const inc = db.prepare("INSERT INTO incidents (year, month, state, ori, agency) VALUES (?, 1, 'MO', 'MOSPD00', 'St. Louis')");
  const vic = db.prepare("INSERT INTO victims (incident_id, victim_num, age, sex) VALUES (?, 1, '25', 'Male')");
  for (let i = 0; i < seed2026; i++) vic.run(inc.run(2026).lastInsertRowid);
  vic.run(inc.run(2025).lastInsertRowid);
  db.close();
}
function counts(file: string, year: number) {
  const db = new Database(file, { readonly: true });
  const n = (db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE year = ?").get(year) as { n: number }).n;
  const v = (db.prepare("SELECT COUNT(*) AS n FROM victims WHERE incident_id IN (SELECT id FROM incidents WHERE year = ?)").get(year) as { n: number }).n;
  db.close();
  return { incidents: n, victims: v };
}
const count = (file: string, year: number) => counts(file, year).incidents;
const readAll = (file: string, sql: string) => { const d = new Database(file, { readonly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };

/** A fixed-width SHR record the importer's parser accepts (positions as in parseRecord). */
function record(ori: string, month: number, incident: number): string {
  const chars = Array(100).fill(" ");
  const put = (at: number, s: string) => { for (let i = 0; i < s.length; i++) chars[at + i] = s[i]; };
  put(0, "6"); put(1, "24"); put(3, ori.padEnd(7)); put(10, "1A"); put(12, "4"); put(13, "26"); put(15, "000274819");
  put(31, "ST. LOUIS".padEnd(24)); put(55, "MISSOU"); put(61, String(month).padStart(2, "0")); put(69, "0"); put(70, "A");
  put(71, String(incident % 1000).padStart(3, "0")); put(74, "A"); put(75, "25MBN"); put(80, "30MBN"); put(85, "12"); put(87, "AQ"); put(89, "03"); put(92, "000");
  return chars.join("");
}

/** A second, instrumented instance of the runtime module whose child-process dispatches are recorded, not run. */
function instrumentedRuntime() {
  const calls: { file: string; args: string[] }[] = [];
  const m = new Module(RUNTIME_FILE, module);
  m.filename = RUNTIME_FILE; m.paths = (Module as any)._nodeModulePaths(path.dirname(RUNTIME_FILE));
  (m as any).require = (name: string) => name === "child_process"
    ? { spawnSync: (file: string, args: string[]) => { calls.push({ file, args }); return { status: 0, stdout: "better-sqlite3 ok", stderr: "" }; } }
    : require(name);
  (m as any)._compile(fs.readFileSync(RUNTIME_FILE, "utf8"), RUNTIME_FILE);
  return { rt: m.exports as typeof runtimeModule, calls };
}

async function main() {
  const shrDb = path.join(WORK, "shr.db");
  const steps = shrPostImportSteps({ shrDbPath: shrDb, nibrsDbPath: "/fixture/nibrs.db", rtciDbPath: "/fixture/crime_data.db" });

  console.log("\n1 - the runtime module");
  await check("the four steps are the importer's existing commands, in order, with the same arguments and environment", () => {
    const real = shrPostImportSteps({ shrDbPath: "/opt/nibrs/shr.db", nibrsDbPath: "/opt/nibrs/nibrs.db", rtciDbPath: "/opt/nibrs/shared/crime_data.db" });
    assert.deepStrictEqual(real.map((s: any) => [s.name, s.script ?? null, s.args, s.env ?? null, s.timeoutMs]), [
      ["normalize-shr-agencies", "scripts/normalize-shr-agencies.ts", ["--apply"], { SHR_DB_PATH: "/opt/nibrs/shr.db", NIBRS_DB_PATH: "/opt/nibrs/nibrs.db" }, 600000],
      ["build-shr-state-population", "scripts/build-shr-state-population.ts", ["--apply"], { SHR_DB_PATH: "/opt/nibrs/shr.db", RTCI_DB_PATH: "/opt/nibrs/shared/crime_data.db" }, 600000],
      ["extend-state-population-cde", "scripts/extend-state-population-cde.ts", ["--db=/opt/nibrs/shr.db", "--apply"], {}, 600000],
      ["analyze", null, ["/opt/nibrs/shr.db", "PRAGMA analysis_limit=1000; ANALYZE;"], null, 120000],
    ]);
  });
  await check("policy: the one-time type recovery is exactly the evidence builder and ANALYZE -- no old normalizer, no population rebuild, no CDE call", () => {
    const rec = shrTypeRecoverySteps({ shrDbPath: "/opt/nibrs/shr.db", nibrsDbPath: "/opt/nibrs/nibrs.db", rtciDbPath: "/opt/nibrs/shared/crime_data.db" });
    const all = shrPostImportSteps({ shrDbPath: "/opt/nibrs/shr.db", nibrsDbPath: "/opt/nibrs/nibrs.db", rtciDbPath: "/opt/nibrs/shared/crime_data.db" });
    assert.deepStrictEqual(rec, [
      { name: "build-shr-agency-type-evidence", kind: "tsx", script: "scripts/build-shr-agency-type-evidence.ts", args: ["--apply"],
        env: { SHR_DB_PATH: "/opt/nibrs/shr.db", NIBRS_DB_PATH: "/opt/nibrs/nibrs.db" }, timeoutMs: 600000 },
      all[3],
    ]);
    assert.ok(!rec.some((s: any) => s.script === "scripts/normalize-shr-agencies.ts"), "the old normalizer is not in the recovery");
  });
  await check("the shipped manifest pins the reviewed scripts and their local imports to the bytes a git-built release carries", () => {
    const m = JSON.parse(fs.readFileSync(SHIPPED_MANIFEST, "utf8"));
    assert.deepStrictEqual(Object.keys(m.files).sort(), [...REVIEWED].sort());
    for (const rel of REVIEWED) assert.strictEqual(m.files[rel], sha(releaseBytes(rel)), rel);
    assert.strictEqual(m.files["scripts/normalize-shr-agencies.ts"], "dc979eca401bfb9bd3049526cfe559ee551eb671f3fc85e4d2b70143c34acf8a",
      "equals the served normalizer the read observed");
  });
  await check("no npx, npm, registry path or shell command anywhere in the correction", () => {
    for (const f of ["shr-post-import-runtime.js", "shr-auto-update.js", "shr-post-import-recover.js"]) {
      const code = fs.readFileSync(path.join(REPO, "scripts", "ops", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.doesNotMatch(code, /\bnpx\b|\bnpm\s+(?:install|exec|i)\b|registry\.npmjs/, f);
      assert.doesNotMatch(code, /\bexecSync\b|\bshell\s*:\s*true/, `${f} runs no command through a shell`);
    }
  });

  const good = makeRelease("good");
  freshDb(shrDb);
  process.env.SHR_TEST_MARKERS = good.markers;
  await check("the release is resolved once through its link, and every path is inside that one directory", () => {
    const rt = resolveRuntime({ releaseLink: good.link, manifestPath: good.manifest, sqliteBin: SQLITE });
    assert.strictEqual(fs.realpathSync(rt.release), fs.realpathSync(good.root));
    for (const p of [rt.nodeModules, rt.tsxLoader, rt.betterSqlite3]) assert.ok(p.startsWith(rt.release), p);
  });
  await check("a good release passes preflight, including a real in-memory native load, without opening any file database", () => {
    const before = fs.statSync(shrDb).mtimeMs;
    assert.strictEqual(preflight(resolveRuntime({ releaseLink: good.link, manifestPath: good.manifest, sqliteBin: SQLITE }), steps, createDeadline(60000)), true);
    assert.strictEqual(fs.statSync(shrDb).mtimeMs, before);
  });
  await check("the steps run on this Node, in the spawned process, through the release's tsx loader, with their arguments, environment and a pinned module path", () => {
    const status = runSteps(resolveRuntime({ releaseLink: good.link, manifestPath: good.manifest, sqliteBin: SQLITE }), steps, createDeadline(120000),
      { statusPath: path.join(WORK, "status-good.json"), log: () => {} });
    assert.strictEqual(status.outcome, "ok");
    assert.deepStrictEqual(status.steps.map((s: any) => [s.name, s.outcome]), steps.map((s: any) => [s.name, "ok"]));
    const n = JSON.parse(fs.readFileSync(path.join(good.markers, "normalize-shr-agencies.json"), "utf8"));
    assert.deepStrictEqual(n.argv, ["--apply"]);
    assert.strictEqual(n.execPath, process.execPath);
    assert.strictEqual(fs.realpathSync(n.cwd), fs.realpathSync(good.root));
    assert.strictEqual(n.env.SHR_DB_PATH, shrDb);
    assert.strictEqual(n.env.NIBRS_DB_PATH, "/fixture/nibrs.db");
    assert.strictEqual(fs.realpathSync(n.env.NODE_PATH), fs.realpathSync(path.join(good.root, "node_modules")));
    assert.strictEqual(n.env.npm_config_offline, "true");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(good.markers, "extend-state-population-cde.json"), "utf8")).argv, [`--db=${shrDb}`, "--apply"]);
    assert.ok(readAll(shrDb, "SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'").length === 1, "ANALYZE ran through the sqlite3 CLI");
  });

  for (const [label, opts, reason] of [
    ["no-tsx", { tsx: false }, /tsx is not installed in the release/],
    ["abi", { betterSqlite3: "incompatible" }, /better-sqlite3 does not load under Node .*NODE_MODULE_VERSION/],
    ["invalid-native (real wrapper, unusable addon: Codex SR-1)", { betterSqlite3: "invalid-native" }, /better-sqlite3 does not load under Node /],
    ["no-bs3", { betterSqlite3: "absent" }, /better-sqlite3 is not installed in the release/],
    ["tampered", { tamper: "scripts/normalize-shr-agencies.ts" }, /release scripts\/normalize-shr-agencies\.ts is not the reviewed version/],
    ["dropped", { drop: "lib/state-population.ts" }, /reviewed file missing from the release: lib\/state-population\.ts/],
  ] as const) {
    await check(`preflight refuses an unusable release: ${label}`, () => {
      const rel = makeRelease(label.split(" ")[0], opts as ReleaseOpts);
      assert.throws(() => preflight(resolveRuntime({ releaseLink: rel.link, manifestPath: rel.manifest, sqliteBin: SQLITE }), steps, createDeadline(60000)),
        (e: any) => e instanceof PostImportRefusal && reason.test(e.message));
    });
  }
  await check("SR-1 control: the invalid-native release really does import but fail on construction (so the check above is the constructor)", () => {
    const rt = resolveRuntime({ releaseLink: path.join(WORK, "invalid-native-link"), manifestPath: good.manifest });
    const r = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(rt.betterSqlite3)}); console.log("required");
      try { new (require(${JSON.stringify(rt.betterSqlite3)}))(":memory:"); } catch (e) { console.log("construct:" + e.code); }`], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    assert.match(r.stdout, /required\s+construct:ERR_DLOPEN_FAILED/);
  });
  await check("preflight refuses a step whose script is not in the reviewed manifest", () => {
    const extra = [...steps, { name: "surprise", kind: "tsx", script: "scripts/surprise.ts", args: [], env: {}, timeoutMs: 1000 }];
    assert.throws(() => preflight(resolveRuntime({ releaseLink: good.link, manifestPath: good.manifest, sqliteBin: SQLITE }), extra, createDeadline(60000)),
      (e: any) => /unreviewed script scripts\/surprise\.ts/.test(e.message));
  });
  await check("an expired deadline refuses at preflight", async () => {
    const d = createDeadline(10);
    await new Promise((r) => setTimeout(r, 30));
    assert.throws(() => preflight(resolveRuntime({ releaseLink: good.link, manifestPath: good.manifest, sqliteBin: SQLITE }), steps, d), /deadline/);
  });
  await check("SR-2: an expired preflight dispatches NO child process (instrumented at the dispatch boundary); a live one dispatches its two checks", () => {
    const { rt, calls } = instrumentedRuntime();
    const runtime = resolveRuntime({ releaseLink: good.link, manifestPath: good.manifest, sqliteBin: SQLITE });
    assert.throws(() => rt.preflight(runtime, steps, { remainingMs: () => 0 }), /deadline.*nothing dispatched/);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(rt.preflight(runtime, steps, { remainingMs: () => 60000 }), true);
    assert.deepStrictEqual(calls.map((c) => path.basename(c.file)), [path.basename(process.execPath), SQLITE]);
    // Budget lasting only for the first check (clock reads: entry, native-check admission): the second is not dispatched.
    calls.length = 0;
    let n = 0;
    assert.throws(() => rt.preflight(runtime, steps, { remainingMs: () => (n++ < 2 ? 60000 : 0) }), /sqlite3 check not dispatched/);
    assert.strictEqual(calls.length, 1);
  });
  await check("a dispatch is admitted only with time left: the next step is not started, and the run fails with a record", () => {
    const rel = makeRelease("deadline");
    process.env.SHR_TEST_MARKERS = rel.markers;
    process.env.SHR_TEST_SLEEP_NORMALIZE_SHR_AGENCIES = "2500";
    const statusPath = path.join(WORK, "status-deadline.json");
    try {
      assert.throws(() => runSteps(resolveRuntime({ releaseLink: rel.link, manifestPath: rel.manifest, sqliteBin: SQLITE }), steps, createDeadline(7000), { statusPath, log: () => {} }),
        (e: any) => e instanceof PostImportRefusal && /build-shr-state-population not dispatched/.test(e.message));
    } finally { delete process.env.SHR_TEST_SLEEP_NORMALIZE_SHR_AGENCIES; }
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    assert.strictEqual(status.outcome, "failed");
    assert.deepStrictEqual(status.steps.map((s: any) => [s.name, s.outcome]), [["normalize-shr-agencies", "ok"], ["build-shr-state-population", "not-dispatched"]]);
    assert.ok(status.steps[0].timeoutMs <= 7000, "each command is bounded by the time remaining, not its own 600 s limit");
    assert.ok(!fs.existsSync(path.join(rel.markers, "build-shr-state-population.json")));
  });
  await check("SR-2 real-launch stall: a step that never ends is killed AT the deadline, the stalled process is gone, and the run fails honestly", () => {
    const rel = makeRelease("stall");
    process.env.SHR_TEST_MARKERS = rel.markers;
    process.env.SHR_TEST_STALL = "normalize-shr-agencies";
    const statusPath = path.join(WORK, "status-stall.json");
    const t0 = Date.now();
    try {
      assert.throws(() => runSteps(resolveRuntime({ releaseLink: rel.link, manifestPath: rel.manifest, sqliteBin: SQLITE }), steps, createDeadline(8000), { statusPath, log: () => {} }),
        /normalize-shr-agencies failed/);
    } finally { delete process.env.SHR_TEST_STALL; }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 8000 + 2000, `whole run bounded by the 8 s budget (took ${elapsed} ms)`);
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    const s = status.steps[0];
    assert.deepStrictEqual([status.outcome, status.steps.length, s.outcome, s.exit], ["failed", 1, "failed", null]);
    assert.ok(s.timeoutMs <= 8000 && /ETIMEDOUT/.test(String(s.error)), JSON.stringify(s));
    const pid = JSON.parse(fs.readFileSync(path.join(rel.markers, "normalize-shr-agencies.json"), "utf8")).pid;
    assert.strictEqual(alive(pid), false, "the stalled script process itself was killed (it runs in the spawned process)");
  });
  await check("a failed step stops the run: non-zero result, a status record naming it, and no later step", () => {
    const rel = makeRelease("fails");
    process.env.SHR_TEST_MARKERS = rel.markers;
    process.env.SHR_TEST_FAIL = "build-shr-state-population";
    const statusPath = path.join(WORK, "status-fails.json");
    try {
      assert.throws(() => runSteps(resolveRuntime({ releaseLink: rel.link, manifestPath: rel.manifest, sqliteBin: SQLITE }), steps, createDeadline(120000), { statusPath, log: () => {} }),
        /build-shr-state-population failed \(exit 1/);
    } finally { delete process.env.SHR_TEST_FAIL; }
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    assert.deepStrictEqual(status.steps.map((s: any) => [s.name, s.outcome, s.exit]), [["normalize-shr-agencies", "ok", 0], ["build-shr-state-population", "failed", 1]]);
    assert.ok(!fs.existsSync(path.join(rel.markers, "extend-state-population-cde.json")));
  });

  console.log("\n2 - the reviewed importer, through its own code");
  const SERVED = path.join(REPO, "audit", "phase3-shr-runtime-repair-2026-09-30", "shr-auto-update.served.js");
  await check("the reviewed importer differs from the served one only in the listed runtime and deadline lines", () => {
    const served = fs.readFileSync(SERVED, "utf8").split("\n");
    const reviewed = fs.readFileSync(path.join(REPO, "scripts", "ops", "shr-auto-update.js"), "utf8").split("\n");
    const removed = served.filter((l) => !reviewed.includes(l)).map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    // Every served (non-comment) line that no longer appears verbatim, and why.
    assert.deepStrictEqual(removed, [
      "const { execSync } = require('child_process');",                                      // no shell anywhere
      "async function downloadSHR(year) {",                                                   // + deadline
      "const jsonStr = execSync(`curl -s \"${signedUrlEndpoint}\"`, { timeout: 30000 }).toString();", // admitted, bounded, no shell
      "execSync(`curl -sL -o \"${dest}\" \"${signedUrl}\"`, { timeout: 120000 });",           // admitted, bounded, no shell
      "await downloadSHR(year);",
      "const delResult = db.prepare('DELETE FROM victims WHERE incident_id IN (SELECT id FROM incidents WHERE year = ?)').run(year);", // moved into the transaction
      "const delInc = db.prepare('DELETE FROM incidents WHERE year = ?').run(year);",
      "console.log(`Deleted ${delInc.changes} incidents, ${delResult.changes} victims for ${year}`);",
      "content = execSync(`unzip -p \"${zipPath}\"`, { maxBuffer: 50 * 1024 * 1024 }).toString('latin1');", // before the delete; admitted, bounded
      "execSync('cd /opt/nibrs/repo && SHR_DB_PATH=/opt/nibrs/shr.db NIBRS_DB_PATH=/opt/nibrs/nibrs.db npx tsx scripts/normalize-shr-agencies.ts --apply', { stdio: 'inherit', timeout: 600000 });",
      "execSync('cd /opt/nibrs/repo && SHR_DB_PATH=/opt/nibrs/shr.db RTCI_DB_PATH=/opt/nibrs/shared/crime_data.db npx tsx scripts/build-shr-state-population.ts --apply', { stdio: 'inherit', timeout: 600000 });",
      "execSync('cd /opt/nibrs/repo && npx tsx scripts/extend-state-population-cde.ts --db=/opt/nibrs/shr.db --apply', { stdio: 'inherit', timeout: 600000 });",
      "console.log('Refreshing query-planner statistics (ANALYZE)...');",
      "execSync('sqlite3 /opt/nibrs/shr.db \"PRAGMA analysis_limit=1000; ANALYZE;\"', { stdio: 'inherit', timeout: 120000 });",
    ]);
    // The three delete lines are moved, not changed: they appear, re-indented, inside the transaction.
    for (const l of removed.slice(5, 8)) assert.ok(reviewed.some((r) => r.trim() === l), `moved verbatim: ${l}`);
    assert.ok(reviewed.includes("main().catch(e => { console.error(e); process.exit(1); });"), "a failure still ends the process non-zero");
  });

  type Child = { execFileSync: (file: string, args: string[], opts: any) => Buffer };
  /** Load the reviewed importer with only its paths, its child-process calls and (optionally) its clock redirected. */
  async function runImporter(release: ReturnType<typeof makeRelease>, db: string, lines: string[],
    o: { child?: (calls: string[], lines: string[]) => Child; deadline?: { remainingMs(): number }; deadlineMs?: number } = {}) {
    const dataDir = path.join(WORK, `data-${path.basename(release.root)}`);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "shr-2026.zip"), Buffer.alloc(2048));   // present, as the fallback requires
    const calls: string[] = [];
    const offline: Child = {
      execFileSync: (file: string, args: string[]) => {
        calls.push(`${file} ${args.join(" ")}`);
        if (file === "curl") throw new Error("offline fixture: no download");
        if (file === "unzip" && args[0] === "-p") return Buffer.from(lines.join("\n"), "latin1");
        throw new Error(`unexpected command in fixture: ${file}`);
      },
    };
    (globalThis as any).__shrTestChildProcess = o.child ? o.child(calls, lines) : offline;
    let text = fs.readFileSync(path.join(REPO, "scripts", "ops", "shr-auto-update.js"), "utf8");
    const swap = (from: string, to: string) => { assert.strictEqual(text.split(from).length, 2, `anchor: ${from}`); text = text.replace(from, to); };
    swap("const { execFileSync } = require('child_process');", "const { execFileSync } = globalThis.__shrTestChildProcess;");
    swap('const dataDir = "/opt/nibrs/data";', `const dataDir = ${JSON.stringify(dataDir)};`);
    swap('const dbPath = "/opt/nibrs/shr.db";', `const dbPath = ${JSON.stringify(db)};`);
    swap("require('./shr-post-import-runtime')", `require(${JSON.stringify(RUNTIME_FILE)})`);
    swap("main().catch(e => { console.error(e); process.exit(1); });", "module.exports.run = main;");
    const file = path.join(REPO, "scripts", "ops", "shr-auto-update.js");
    const m = new Module(file, module);
    m.filename = file; m.paths = (Module as any)._nodeModulePaths(path.dirname(file));
    (m as any)._compile(text, file);
    const env: Record<string, string> = { SHR_RELEASE_LINK: release.link, SHR_UPDATE_STATUS_PATH: path.join(WORK, `status-imp-${path.basename(release.root)}.json`),
      SHR_UPDATE_YEARS: "2026", PROTECTED_UPDATE_YEARS: "", SHR_SQLITE3: SQLITE, SHR_TEST_MARKERS: release.markers };
    if (o.deadlineMs) env.SHR_UPDATE_DEADLINE_MS = String(o.deadlineMs);
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {};
    const origResolve = runtimeModule.resolveRuntime;
    const origDeadline = runtimeModule.createDeadline;
    try {
      // The manifest path defaults beside the runtime module; point it at the fixture's for this run.
      runtimeModule.resolveRuntime = (x: any = {}) => origResolve({ ...x, manifestPath: release.manifest, sqliteBin: SQLITE });
      if (o.deadline) runtimeModule.createDeadline = () => o.deadline;
      try { await (m.exports as any).run(); return { error: null as Error | null, calls, status: env.SHR_UPDATE_STATUS_PATH }; }
      catch (e) { return { error: e as Error, calls, status: env.SHR_UPDATE_STATUS_PATH }; }
    } finally {
      runtimeModule.resolveRuntime = origResolve; runtimeModule.createDeadline = origDeadline;
      console.log = log; console.error = err;
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }

  for (const [label, bs, reason] of [["abi", "incompatible", /NODE_MODULE_VERSION/], ["invalid-native", "invalid-native", /better-sqlite3 does not load/]] as const) {
    await check(`an unusable runtime (${label}) refuses BEFORE any download or delete: the year's rows are untouched`, async () => {
      const rel = makeRelease(`imp-${label}`, { betterSqlite3: bs });
      const db = path.join(WORK, `shr-imp-${label}.db`); freshDb(db, 3);
      const out = await runImporter(rel, db, [record("MOSPD00", 3, 1)]);
      assert.ok(out.error instanceof PostImportRefusal && reason.test((out.error as Error).message), String(out.error));
      assert.deepStrictEqual(out.calls, [], "no curl or unzip was even attempted");
      assert.deepStrictEqual(counts(db, 2026), { incidents: 3, victims: 3 }, "the 2026 rows are exactly as before");
    });
  }
  await check("a usable runtime imports the year and then runs every step", async () => {
    const rel = makeRelease("imp-good");
    const db = path.join(WORK, "shr-imp-good.db"); freshDb(db, 3);
    const out = await runImporter(rel, db, [record("MOSPD00", 3, 1), record("MOSPD00", 4, 2)]);
    assert.strictEqual(out.error, null, String(out.error));
    assert.deepStrictEqual(counts(db, 2026), { incidents: 2, victims: 2 }, "2026 replaced by the fixture file's two records");
    assert.deepStrictEqual(counts(db, 2025), { incidents: 1, victims: 1 }, "the other year untouched");
    const status = JSON.parse(fs.readFileSync(out.status, "utf8"));
    assert.strictEqual(status.outcome, "ok");
    assert.strictEqual(status.steps.length, 4);
    assert.deepStrictEqual(out.calls.map((c) => c.split(" ").slice(0, 2).join(" ")), ["curl -s", "unzip -p"],
      "the importer's only child processes are its own download attempt and unzip, without a shell");
  });
  await check("SR-2 (Codex witness): the clock expiring after the first curl stops the run -- no second curl, no unzip, no delete", async () => {
    const rel = makeRelease("imp-expire-curl");
    const db = path.join(WORK, "shr-imp-expire-curl.db"); freshDb(db, 3);
    let remaining = 60000;
    const out = await runImporter(rel, db, [record("MOSPD00", 3, 1)], {
      deadline: { remainingMs: () => remaining },
      child: (calls) => ({ execFileSync: (file, args) => {
        calls.push(`${file} ${args.join(" ")}`);
        if (file === "curl" && args[0] === "-s") { remaining = 0; return Buffer.from('{"url":"https://fixture.invalid/archive.zip"}'); }
        if (file === "curl") return Buffer.from("");
        if (file === "unzip") return Buffer.from(record("MOSPD00", 3, 1), "latin1");
        throw new Error(`unexpected ${file}`);
      } }),
    });
    assert.ok(out.error instanceof PostImportRefusal && /download curl not dispatched: 0 ms left/.test((out.error as Error).message), String(out.error));
    assert.deepStrictEqual(out.calls.map((c) => c.split(" ").slice(0, 2).join(" ")), ["curl -s"]);
    assert.deepStrictEqual(counts(db, 2026), { incidents: 3, victims: 3 }, "no row deleted or inserted after expiry");
  });
  await check("SR-2: the clock expiring inside the replacement rolls back the delete and every insert", async () => {
    const rel = makeRelease("imp-expire-tx");
    const db = path.join(WORK, "shr-imp-expire-tx.db"); freshDb(db, 3);
    const lines = Array.from({ length: 2500 }, (_, i) => record("MOSPD00", 3, i + 1));
    let allowAfterUnzip: number | null = null;   // after unzip: admit the replacement and the line-1000 check, expire at line 2000
    const out = await runImporter(rel, db, lines, {
      deadline: { remainingMs: () => allowAfterUnzip === null ? 60000 : (allowAfterUnzip-- > 0 ? 60000 : 0) },
      child: (calls, ls) => ({ execFileSync: (file, args) => {
        calls.push(`${file} ${args.join(" ")}`);
        if (file === "curl") throw new Error("offline");
        allowAfterUnzip = 2;
        return Buffer.from(ls.join("\n"), "latin1");
      } }),
    });
    assert.ok(out.error instanceof PostImportRefusal && /replace 2026 \(line 2000\) not dispatched/.test((out.error as Error).message), String(out.error));
    assert.deepStrictEqual(counts(db, 2026), { incidents: 3, victims: 3 }, "the year is exactly as before: delete and 1,999 inserts rolled back");
  });
  await check("SR-2 real-launch stall: an unzip that never ends is killed at the deadline, the year is untouched, and the run fails", async () => {
    const rel = makeRelease("imp-stall");
    const db = path.join(WORK, "shr-imp-stall.db"); freshDb(db, 3);
    let unzipTimeout = -1;
    const t0 = Date.now();
    const out = await runImporter(rel, db, [record("MOSPD00", 3, 1)], {
      deadlineMs: 9000,
      child: (calls) => ({ execFileSync: (file, args, opts) => {
        calls.push(`${file} ${args.join(" ")}`);
        if (file === "curl") throw new Error("offline");
        unzipTimeout = opts.timeout;
        // A REAL child that never exits, launched with exactly the options the importer passed.
        return childProcess.execFileSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { ...opts, windowsHide: true }) as unknown as Buffer;   // no encoding passed: a Buffer at run time
      } }),
    });
    const elapsed = Date.now() - t0;
    assert.ok(unzipTimeout > 0 && unzipTimeout <= 9000, `unzip bounded by the remaining time (${unzipTimeout})`);
    assert.ok(elapsed < 9000 + 3000, `whole invocation bounded by its 9 s budget (took ${elapsed} ms)`);
    assert.ok(out.error instanceof PostImportRefusal && /not dispatched/.test((out.error as Error).message), String(out.error));
    assert.deepStrictEqual(counts(db, 2026), { incidents: 3, victims: 3 });
    assert.strictEqual(JSON.parse(fs.readFileSync(out.status, "utf8")).outcome, "failed");
  });
  await check("disclosed behavior change: an unzip failure now skips the year WITHOUT deleting it (the served order deleted first)", async () => {
    const rel = makeRelease("imp-unzip-fail");
    const db = path.join(WORK, "shr-imp-unzip-fail.db"); freshDb(db, 3);
    const out = await runImporter(rel, db, [], {
      child: (calls) => ({ execFileSync: (file, args) => { calls.push(`${file} ${args.join(" ")}`); throw new Error(`${file} failed`); } }),
    });
    assert.strictEqual(out.error, null, String(out.error));
    assert.deepStrictEqual(counts(db, 2026), { incidents: 3, victims: 3 });
  });
  await check("a failing step after the import fails the importer (the process would exit 1)", async () => {
    const rel = makeRelease("imp-fails");
    const db = path.join(WORK, "shr-imp-fails.db"); freshDb(db, 3);
    process.env.SHR_TEST_FAIL = "normalize-shr-agencies";
    try {
      const out = await runImporter(rel, db, [record("MOSPD00", 3, 1)]);
      assert.ok(out.error && /normalize-shr-agencies failed/.test(out.error.message), String(out.error));
      assert.strictEqual(JSON.parse(fs.readFileSync(out.status, "utf8")).outcome, "failed");
    } finally { delete process.env.SHR_TEST_FAIL; }
  });

  console.log("\n3 - the recovery entry (type fill-in only)");
  const RECOVER = path.join(REPO, "scripts", "ops", "shr-post-import-recover.js");
  const recover = (rel: { link: string; markers: string }, db: string, args: string[], statusPath: string, nibrs = path.join(WORK, "no-nibrs.db")) =>
    spawnSync(process.execPath, [RECOVER, ...args], {
      encoding: "utf8", windowsHide: true, timeout: 120000,
      env: { ...process.env, SHR_RELEASE_LINK: rel.link, SHR_TEST_MARKERS: rel.markers, SHR_SQLITE3: SQLITE, SHR_DB_PATH: db, NIBRS_DB_PATH: nibrs,
        RTCI_DB_PATH: path.join(WORK, "no-rtci.db"), SHR_UPDATE_STATUS_PATH: statusPath, SHR_UPDATE_DEADLINE_MS: "60000" },
    });
  await check("recovery refuses a release whose scripts are not the reviewed bytes, and dispatches nothing", () => {
    const rel = makeRelease("rec-pre");
    const r = recover(rel, path.join(WORK, "shr.db"), ["--preflight-only"], path.join(WORK, "status-rec.json"));
    // The recovery entry uses the shipped manifest, so this fixture release (fake scripts) must be REFUSED.
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /is not the reviewed version/);
    assert.strictEqual(fs.readdirSync(rel.markers).length, 0, "no step ran");
  });

  // A disposable database shaped like the observed cases: an agency with an earlier City value and blank 2026
  // (and one blank earlier year), a default-only agency like Jackson, and a state_population sentinel.
  const recDb = path.join(WORK, "shr-recovery.db");
  {
    const db = new Database(recDb);
    db.exec(fs.readFileSync(path.join(REPO, "scripts", "fixtures", "operation-taxonomy", "shr.ddl.sql"), "utf8"));
    if (!db.prepare("PRAGMA table_info(incidents)").all().some((c: any) => c.name === "agency_type")) db.exec("ALTER TABLE incidents ADD COLUMN agency_type TEXT");
    const inc = db.prepare("INSERT INTO incidents (year, month, state, ori, agency, agency_type) VALUES (?, 1, ?, ?, ?, ?)");
    for (const [year, type] of [[2024, "City"], [2025, "City"], [2019, ""], [2026, ""], [2026, ""]] as const) inc.run(year, "MO", "MOSPD00", "St. Louis", type);
    for (const year of [2024, 2025, 2026]) inc.run(year, "MS", "MS02501", "Jackson", "");
    db.exec("CREATE TABLE state_population (state TEXT, state_name TEXT, year INTEGER, population INTEGER, source TEXT, PRIMARY KEY (state, year));");
    db.prepare("INSERT INTO state_population VALUES ('MO','Missouri',2026,6200000,'FBI CDE API populations.population')").run();
    db.close();
  }
  // A sentinel identity table, as the old normalizer would have left one: the policy recovery must not touch it.
  {
    const db = new Database(recDb);
    db.prepare("INSERT INTO shr_agency_identity (ori, state, canonical_agency, agency_type, search_key, source_agency_names, source_agency_types, incident_count, first_year, last_year)" +
      " VALUES ('MS02501', 'MS', 'Jackson', 'City', 'jackson', '[\"Jackson\"]', '[\"\"]', 3, 2024, 2026)").run();
    db.close();
  }
  // Disposable NIBRS agencies: St. Louis's 9-character ORI is the one NIBRS agency its SHR ORI begins with;
  // the MS 7-character ORI is shared by two NIBRS agencies (ambiguous); DC has none (unbound).
  const recNibrs = path.join(WORK, "nibrs-recovery.db");
  {
    const db = new Database(recNibrs);
    db.exec(fs.readFileSync(path.join(REPO, "scripts", "fixtures", "operation-taxonomy", "nibrs.ddl.sql"), "utf8"));
    const a = db.prepare("INSERT INTO agencies (ori, year, state, city, population, agency_type) VALUES (?, ?, ?, ?, ?, ?)");
    for (const year of [2021, 2022, 2023, 2024, 2025]) a.run("MOSPD0000", year, "MO", "St. Louis", 280000, "City");
    a.run("MOSPD0099", 2025, "IL", "Elsewhere", 1000, "City");            // same prefix, other state: not a match
    a.run("MS0250100", 2025, "MS", "Jackson", 150000, "City");
    a.run("MS0250101", 2025, "MS", "Jackson County SO", 140000, "County");
    db.close();
  }
  {
    const db = new Database(recDb);
    db.prepare("INSERT INTO incidents (year, month, state, ori, agency, agency_type) VALUES (2026, 1, 'DC', 'DCMPD00', 'Washington', 'City')").run();
    db.close();
  }
  const typesBy = (file: string) => readAll(file, "SELECT ori, year, COALESCE(agency_type,'') AS t FROM incidents ORDER BY ori, year, id");
  const popRows = (file: string) => readAll(file, "SELECT * FROM state_population");
  const realRel = makeRelease("rec-real", { realScripts: true });
  await check("recovery --preflight-only passes on the reviewed bytes and dispatches no step (no status written, database untouched)", () => {
    const statusPath = path.join(WORK, "status-rec-pre.json");
    const before = sha(fs.readFileSync(recDb));
    const r = recover(realRel, recDb, ["--preflight-only"], statusPath, recNibrs);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /steps: build-shr-agency-type-evidence, analyze[\s\S]*Preflight passed; no step dispatched/);
    assert.strictEqual(fs.existsSync(statusPath), false);
    assert.strictEqual(sha(fs.readFileSync(recDb)), before);
  });
  await check("policy: the REAL reviewed evidence builder, run by recovery on disposable databases, writes only its two tables and statistics", () => {
    const statusPath = path.join(WORK, "status-rec-real.json");
    const popBefore = popRows(recDb);
    const typesBefore = typesBy(recDb);
    const idsBefore = readAll(recDb, "SELECT * FROM shr_agency_identity");
    const nibrsBefore = sha(fs.readFileSync(recNibrs));
    const r = recover(realRel, recDb, [], statusPath, recNibrs);
    assert.strictEqual(r.status, 0, r.stderr);
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    assert.deepStrictEqual(status.steps.map((s: any) => [s.name, s.outcome]), [["build-shr-agency-type-evidence", "ok"], ["analyze", "ok"]]);
    assert.deepStrictEqual(typesBy(recDb), typesBefore, "incidents untouched: no agency_type fill in any year, legacy labels neither copied nor removed");
    assert.deepStrictEqual(readAll(recDb, "SELECT * FROM shr_agency_identity"), idsBefore, "the old identity table is untouched (the normalizer does not run)");
    assert.deepStrictEqual(popRows(recDb), popBefore, "state_population untouched: no rebuild and no CDE call");
    assert.strictEqual(sha(fs.readFileSync(recNibrs)), nibrsBefore, "nibrs.db is only read");
    assert.deepStrictEqual(readAll(recDb, "SELECT ori, state, candidate_oris FROM shr_agency_type_binding ORDER BY ori"), [
      { ori: "DCMPD00", state: "DC", candidate_oris: "[]" },
      { ori: "MOSPD00", state: "MO", candidate_oris: '["MOSPD0000"]' },   // the IL agency with the same prefix is not a candidate
      { ori: "MS02501", state: "MS", candidate_oris: '["MS0250100","MS0250101"]' },
    ]);
    assert.deepStrictEqual(readAll(recDb, "SELECT ori, nibrs_ori, year, nibrs_state, agency_type, source FROM shr_agency_type_evidence WHERE ori = 'MOSPD00' ORDER BY year"),
      [2021, 2022, 2023, 2024, 2025].map((year) => ({ ori: "MOSPD00", nibrs_ori: "MOSPD0000", year, nibrs_state: "MO", agency_type: "City", source: "NIBRS agencies.agency_type" })));
    assert.ok(readAll(recDb, "SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'").length === 1, "ANALYZE ran");
    // What the ranking then reads for 2026: St. Louis a city typed 2021-2025, carried forward to 2026; Jackson and Washington unresolved.
    const db = new Database(recDb, { readonly: true });
    const ev = loadShrTypeEvidence(db, 2026);
    db.close();
    assert.deepStrictEqual(classifyShrAgency(ev.byAgency.get("MOSPD00|MO") ?? null, ev.built, 2026),
      { membership: "eligible", agencyType: "City", basis: { source: "NIBRS agencies.agency_type", nibrsOri: "MOSPD0000", typedYears: [2021, 2022, 2023, 2024, 2025], blankYears: [], carriedForwardFrom: 2025 } });
    assert.deepStrictEqual(classifyShrAgency(ev.byAgency.get("MS02501|MS") ?? null, ev.built, 2026), { membership: "unresolved", reason: "several-nibrs-matches" });
    assert.deepStrictEqual(classifyShrAgency(ev.byAgency.get("DCMPD00|DC") ?? null, ev.built, 2026), { membership: "unresolved", reason: "no-nibrs-match" });
  });
  await check("a failed evidence build leaves the previous tables (one transaction; nothing half-written)", () => {
    const before = readAll(recDb, "SELECT * FROM shr_agency_type_binding ORDER BY ori");
    const r = recover(realRel, recDb, [], path.join(WORK, "status-rec-fail.json"), path.join(WORK, "missing-nibrs.db"));
    assert.notStrictEqual(r.status, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(WORK, "status-rec-fail.json"), "utf8")).steps[0].outcome, "failed");
    assert.deepStrictEqual(readAll(recDb, "SELECT * FROM shr_agency_type_binding ORDER BY ori"), before);
  });

  console.log(`\nSHR post-import runtime: ${passed} passed, ${failed} failed`);
  // Killed children (the stall witnesses) can hold a handle briefly on Windows; retry, never fail the result on cleanup.
  try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
  catch (e) { console.log(`  (temporary folder not removed: ${(e as Error).message.split("\n")[0]})`); }
  if (failed > 0) process.exit(1);
}
main();
