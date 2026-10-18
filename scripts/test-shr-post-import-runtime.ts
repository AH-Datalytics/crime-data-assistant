/**
 * The SHR post-import runtime correction (scripts/ops/shr-post-import-runtime.js, scripts/ops/shr-auto-update.js,
 * scripts/ops/shr-post-import-recover.js), on disposable fixtures through the actual launch mechanism: this Node
 * binary, the release's installed tsx loader, real child processes and the real sqlite3 CLI. Nothing here reads
 * or writes a real database, contacts a server or installs anything.
 *
 *   1. the runtime module: pinned release, reviewed-hash check, no npx, a native load that reaches the addon
 *      (Codex SR-1), deadline admission before every dispatch including preflight's own (SR-2), a stalled
 *      command killed at the deadline, failure stops with a status record, arguments and environment preserved;
 *   2. the SAFE REFRESH (owner-approved SHR repair, 2026-10-02), the importer loaded in memory with only its paths
 *      and its curl calls redirected (unzip and sqlite3 are the real programs on real files): a valid file reaches
 *      the delivered ranking through a candidate and a backup-API activation, history untouched; and every failure
 *      that motivated the repair -- HTTP error, error page, truncated archive, wrong-year file, unreadable lines,
 *      shrinking file, expiry after the delete began, post-step failure, too little time to activate, a
 *      read-back mismatch and a failed restore -- leaves every table of the live database exactly as it was;
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
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { classifyShrAgency, loadShrTypeEvidence, SHR_TYPE_EVIDENCE_DDL } from "../lib/shr-agency-classification";
import { planShrCityRanking, runShrCityRanking } from "../lib/city-ranking-shr";
import { validateDeterministicShrPlanSql } from "../lib/shr-authority";
import { queryContractFailureMessage } from "../lib/query-contract-validator";

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
const POLICY = ["scripts/build-shr-agency-type-evidence.ts", "lib/shr-agency-classification.ts", "lib/shr-agency-year-class.ts"];
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
    // Observation only (dev's timing-gate rule: no wall-clock pass/fail gate). The kill is proved structurally
    // below: the recorded bound is within the budget, the step ended in ETIMEDOUT, and the process is gone.
    console.log(`        (observed: the stalled run returned after ${Date.now() - t0} ms against an 8000 ms budget)`);
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

  console.log("\n2 - the safe refresh, through the importer's own code (owner-approved SHR repair, 2026-10-02)");
  // The served bytes, read from production 2026-09-29 (git blob d41197bf). The parser and its code tables are
  // the data semantics; the refresh may move WHERE rows are written, never WHAT a record becomes.
  const SERVED = path.join(REPO, "scripts", "fixtures", "shr-auto-update.served.js");
  const IMPORTER = path.join(REPO, "scripts", "ops", "shr-auto-update.js");
  await check("the parser, its code tables and the insert column lists are byte-identical to the served importer", () => {
    const served = fs.readFileSync(SERVED, "utf8");
    const now = fs.readFileSync(IMPORTER, "utf8");
    const block = (text: string, start: string, end: string) => { const i = text.indexOf(start); const j = text.indexOf(end, i); assert.ok(i >= 0 && j > i, start); return text.slice(i, j); };
    // The one approved change since the served bytes: the FBI CDE codebook fix (2026-10-13,
    // audit/cde-codebook-fixes-2026-10-13): 30/31 added, 40 = CDE's "Domestic Violence". Any other change still fails.
    const CDE_FROM = "const CIRCUMSTANCE_CODES = {\n  '02'";
    const CDE_TO = "// Circumstance names: the FBI CDE codebook (scripts/fixtures/cde/shr-codebook.json). 30/31 added; 40 is CDE's\n// \"Domestic Violence\" (formerly labeled \"Lover's Triangle\" here). 30/31 have no CDE grouping, so their group is \"Unknown\".\n" + CDE_FROM;
    const OLD_40 = "  '40':\"Lover's Triangle\",'41':'Child Killed by Babysitter',\n";
    const NEW_40 = "  '30':'Human Trafficking/Commercial Sex Acts','31':'Human Trafficking/Involuntary Servitude',\n  '40':'Domestic Violence','41':'Child Killed by Babysitter',\n";
    const servedBlock = block(served, "const STATE_CODES", "// Download a file").replace(/\r\n/g, "\n");
    assert.ok(servedBlock.split(CDE_FROM).length === 2 && servedBlock.split(OLD_40).length === 2, "the served block has the pre-CDE circumstance table");
    assert.strictEqual(block(now, "const STATE_CODES", "// Download a file").replace(/\r\n/g, "\n"), servedBlock.replace(CDE_FROM, CDE_TO).replace(OLD_40, NEW_40));
    for (const sql of ["INSERT INTO incidents (year, month, state, ori, agency, population, situation,", "INSERT INTO victims (incident_id, victim_num, age, age_num, sex, race, ethnicity)"]) {
      assert.strictEqual(block(now, sql, "`);"), block(served, sql, "`);"), sql);
    }
  });
  await check("the live database is written only by the activation and rollback restores: no delete, insert or rename touches it", () => {
    const code = fs.readFileSync(IMPORTER, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(code, /new Database\(dbPath(?![^)]*readonly)/, "the live file is never opened writable by the importer");
    assert.doesNotMatch(code, /renameSync\([^)]*dbPath|renameSync\(candidate/, "no database is renamed into place");
    assert.strictEqual((code.match(/\.restore /g) || []).length, 2, "exactly two writes to the live file: activation and rollback");
    assert.match(code, /'--fail'[\s\S]*'--fail'/, "both curl calls use --fail");
    assert.doesNotMatch(code, /\/opt\/nibrs\/repo|normalize-shr-agencies/, "no legacy repository path and no old normalizer");
  });

  /** A stored (uncompressed) ZIP archive, written here so the real `unzip` tests, lists and extracts it. */
  function zipOf(entries: { name: string; data: Buffer }[]): Buffer {
    const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
    for (const e of entries) {
      const name = Buffer.from(e.name); const crc = zlib.crc32(e.data) >>> 0;
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(e.data.length, 20); central.writeUInt32LE(e.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
      locals.push(local, name, e.data); centrals.push(central, name); offset += 30 + name.length + e.data.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
  }
  /** A fixed-width SHR record (positions as in parseRecord); `addl` adds victims in the served additional-victim blocks. */
  function rec(o: { ori: string; month: number; n: number; state?: string; yy?: string; agency?: string; pop?: number; addl?: number }): string {
    const chars = Array(100 + 5 * (o.addl ?? 0)).fill(" ");
    const put = (at: number, s: string) => { for (let i = 0; i < s.length; i++) chars[at + i] = s[i]; };
    put(0, "6"); put(1, o.state ?? "24"); put(3, o.ori.padEnd(7)); put(10, "1A"); put(12, "4"); put(13, o.yy ?? "26"); put(15, String(o.pop ?? 274819).padStart(9, "0"));
    put(31, (o.agency ?? "ST. LOUIS").padEnd(24)); put(55, "MISSOU"); put(61, String(o.month).padStart(2, "0")); put(69, "0"); put(70, "A");
    put(71, String(o.n % 1000).padStart(3, "0")); put(74, o.addl ? "D" : "A"); put(75, "25MBN"); put(80, "30MBN"); put(85, "12"); put(87, "AQ"); put(89, "03");
    put(92, String(o.addl ?? 0).padStart(3, "0"));
    for (let a = 0; a < (o.addl ?? 0); a++) put(98 + 5 * a, "31FWN");
    return chars.join("");
  }
  const archiveOf = (lines: string[]) => zipOf([{ name: "SHR2026.txt", data: Buffer.from(lines.join("\r\n") + "\r\n", "latin1") }]);
  /** The October file: 2026 grows (St. Louis through month 9, one multi-victim incident) and a new agency appears. */
  const OCTOBER = [
    ...Array.from({ length: 6 }, (_, i) => rec({ ori: "MOSPD00", month: (i % 9) + 1, n: i + 1 })),
    rec({ ori: "MOSPD00", month: 9, n: 7, addl: 2 }),
    rec({ ori: "MOKPD00", month: 8, n: 8, agency: "KANSAS CITY", pop: 508000 }),
    rec({ ori: "MOKPD00", month: 9, n: 9, agency: "KANSAS CITY", pop: 508000 }),
    rec({ ori: "MONEW00", month: 9, n: 10, agency: "NEW AGENCY", pop: 120000 }),
  ];

  /** Live fixture: 2024 and 2025 history, 2026 as loaded before the refresh, and evidence for the old agencies. */
  function liveFixture(file: string) {
    const db = new Database(file);
    db.exec(fs.readFileSync(path.join(REPO, "scripts", "fixtures", "operation-taxonomy", "shr.ddl.sql"), "utf8"));
    db.pragma("journal_mode = WAL");
    const inc = db.prepare("INSERT INTO incidents (year, month, state, ori, agency, population, homicide_type, weapon_group) VALUES (?, ?, 'MO', ?, ?, ?, 'Murder', 'Firearm')");
    const vic = db.prepare("INSERT INTO victims (incident_id, victim_num, age, sex) VALUES (?, 1, '25', 'Male')");
    for (const [year, month, ori, agency, pop] of [[2024, 5, "MOSPD00", "St. Louis", 280000], [2024, 6, "MOKPD00", "Kansas City", 508000], [2025, 1, "MOSPD00", "St. Louis", 280000],
      [2025, 2, "MOSPD00", "St. Louis", 280000], [2026, 1, "MOSPD00", "St. Louis", 274819], [2026, 2, "MOSPD00", "St. Louis", 274819], [2026, 4, "MOSPD00", "St. Louis", 274819]] as const) {
      vic.run(inc.run(year, month, ori, agency, pop).lastInsertRowid);
    }
    db.exec(SHR_TYPE_EVIDENCE_DDL);
    db.prepare("INSERT INTO shr_agency_type_binding VALUES ('MOSPD00', 'MO', '[\"MOSPD0000\"]', 'fixture-september')").run();
    db.prepare("INSERT INTO shr_agency_type_evidence VALUES ('MOSPD00', 'MO', 'MOSPD0000', 2025, 'MO', 'City', 'NIBRS agencies.agency_type')").run();
    db.close();
  }
  /** NIBRS agencies for the evidence builder: both Missouri cities typed City; the new agency has no match. */
  const refreshNibrs = path.join(WORK, "nibrs-refresh.db");
  {
    const db = new Database(refreshNibrs);
    db.exec(fs.readFileSync(path.join(REPO, "scripts", "fixtures", "operation-taxonomy", "nibrs.ddl.sql"), "utf8"));
    const a = db.prepare("INSERT INTO agencies (ori, year, state, city, population, agency_type) VALUES (?, ?, 'MO', ?, ?, 'City')");
    for (const year of [2024, 2025]) { a.run("MOSPD0000", year, "St. Louis", 280000); a.run("MOKPD0000", year, "Kansas City", 508000); }
    db.close();
  }
  /** Everything a reader could see: every row of every table, in a stable order. */
  const digest = (file: string) => {
    const d = new Database(file, { readonly: true });
    try {
      const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
      return sha(JSON.stringify(tables.map((t) => [t.name, d.prepare(`SELECT * FROM "${t.name}" ORDER BY 1, 2, 3`).all()])));
    } finally { d.close(); }
  };
  const yearRows = (file: string, year: number) => readAll(file, `SELECT * FROM incidents WHERE year = ${year} ORDER BY id`);

  type Child = { execFileSync: (file: string, args: string[], opts: any) => Buffer };
  type RefreshOpts = { archive?: Buffer | null; curl?: (args: string[]) => Buffer; intercept?: (file: string, args: string[], opts: any) => Buffer | undefined;
    deadline?: { remainingMs(): number }; env?: Record<string, string>; preArchive?: Buffer | null; nibrs?: string };
  /**
   * Run the importer's own main() in this process with only its paths and its child-process boundary redirected:
   * curl is the fixture (no network); unzip and sqlite3 are the REAL programs on the real files.
   */
  async function runRefresh(release: ReturnType<typeof makeRelease>, live: string, o: RefreshOpts = {}) {
    const tag = path.basename(release.root);
    const dataDir = path.join(WORK, `data-${tag}`); const backups = path.join(WORK, `backups-${tag}`);
    fs.mkdirSync(dataDir, { recursive: true });
    if (o.preArchive !== null) fs.writeFileSync(path.join(dataDir, "shr-2026.zip"), o.preArchive ?? archiveOf([rec({ ori: "MOSPD00", month: 4, n: 1 })]));
    const calls: string[] = [];
    let curlN = 0;
    const child: Child = { execFileSync: (file, args, opts) => {
      calls.push(`${path.basename(file)} ${args.join(" ")}`);
      const hooked = o.intercept?.(file, args, opts);
      if (hooked !== undefined) return hooked;
      if (file === "curl") {
        if (o.curl) return o.curl(args);
        if (curlN++ === 0) return Buffer.from('{"url":"https://fixture.invalid/shr-2026.zip"}');
        if (o.archive === null) throw Object.assign(new Error("curl: (22) The requested URL returned error: 403"), { status: 22 });
        fs.writeFileSync(args[args.indexOf("-o") + 1], o.archive ?? archiveOf(OCTOBER));
        return Buffer.from("");
      }
      return childProcess.execFileSync(file, args, { ...opts, windowsHide: true }) as unknown as Buffer;
    } };
    (globalThis as any).__shrTestChildProcess = child;
    let text = fs.readFileSync(IMPORTER, "utf8");
    const swap = (from: string, to: string) => { assert.strictEqual(text.split(from).length, 2, `anchor: ${from}`); text = text.replace(from, to); };
    swap("const { execFileSync } = require('child_process');", "const { execFileSync } = globalThis.__shrTestChildProcess;");
    swap('const dataDir = "/opt/nibrs/data";', `const dataDir = ${JSON.stringify(dataDir)};`);
    swap('const dbPath = "/opt/nibrs/shr.db";', `const dbPath = ${JSON.stringify(live)};`);
    swap('const nibrsPath = "/opt/nibrs/nibrs.db";', `const nibrsPath = ${JSON.stringify(o.nibrs ?? refreshNibrs)};`);
    swap('const backupDir = "/opt/nibrs/backups";', `const backupDir = ${JSON.stringify(backups)};`);
    swap("require('./shr-post-import-runtime')", `require(${JSON.stringify(RUNTIME_FILE)})`);
    swap("main().catch(e => { console.error(e); process.exit(1); });", "module.exports.run = main;");
    const statusPath = path.join(WORK, `refresh-status-${tag}.json`);
    const env: Record<string, string> = { SHR_RELEASE_LINK: release.link, SHR_REFRESH_STATUS_PATH: statusPath, SHR_UPDATE_STATUS_PATH: path.join(WORK, `post-status-${tag}.json`),
      SHR_UPDATE_YEARS: "2026", PROTECTED_UPDATE_YEARS: "", SHR_SQLITE3: SQLITE, SHR_TEST_MARKERS: release.markers, ...(o.env ?? {}) };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    const m = new Module(IMPORTER, module);
    m.filename = IMPORTER; m.paths = (Module as any)._nodeModulePaths(path.dirname(IMPORTER));
    (m as any)._compile(text, IMPORTER);
    const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {};
    const origResolve = runtimeModule.resolveRuntime; const origDeadline = runtimeModule.createDeadline;
    try {
      runtimeModule.resolveRuntime = (x: any = {}) => origResolve({ ...x, manifestPath: release.manifest, sqliteBin: SQLITE });
      if (o.deadline) runtimeModule.createDeadline = () => o.deadline;
      let error: Error | null = null;
      try { await (m.exports as any).run(); } catch (e) { error = e as Error; }
      const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, "utf8")) : null;
      return { error, calls, status, dataDir, backups, archive: path.join(dataDir, "shr-2026.zip") };
    } finally {
      runtimeModule.resolveRuntime = origResolve; runtimeModule.createDeadline = origDeadline;
      console.log = log; console.error = err;
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
  /** The delivered SHR city ranking, through the application's own planner, validator and classification. */
  const RANK_Q = "Which cities had the most murders in 2026?";
  function delivered(file: string, cutoffMonth: number) {
    const db = new Database(file, { readonly: true });
    try {
      const plan = planShrCityRanking(RANK_Q, { year: 2026, month: cutoffMonth, observed: true });
      assert.ok(plan && plan.kind === "deterministic", `the ranking is planned (${JSON.stringify(plan && (plan as any).kind)})`);
      const out = runShrCityRanking(plan as any, {
        validate: (sql: string) => { const v = validateDeterministicShrPlanSql({ question: RANK_Q, sql }); return queryContractFailureMessage(v) ? null : { sql: v.sql, rows: () => db.prepare(v.sql).all() as Record<string, unknown>[] }; },
        typeEvidence: (year: number) => loadShrTypeEvidence(db, year),
      });
      assert.strictEqual(out.kind, "answer", JSON.stringify(out).slice(0, 200));
      const a = out as any;
      return { rows: a.rows.map((r: any) => [r.ori, r.victims]), title: a.title as string, explanation: a.explanation as string };
    } finally { db.close(); }
  }

  const goodRel = makeRelease("refresh-real", { realScripts: true });
  await check("SUCCESS: a valid October file reaches the delivered ranking; history is untouched; the candidate is gone and a snapshot kept", async () => {
    const live = path.join(WORK, "live-success.db"); liveFixture(live);
    const before = delivered(live, 4);
    const history = [yearRows(live, 2024), yearRows(live, 2025)];
    const out = await runRefresh(goodRel, live);
    assert.strictEqual(out.error, null, String(out.error));
    assert.strictEqual(out.status.outcome, "ok");
    assert.deepStrictEqual(counts(live, 2026), { incidents: 10, victims: 12 }, "2026 replaced by the 10 validated records and their 12 victims");
    assert.deepStrictEqual([yearRows(live, 2024), yearRows(live, 2025)], history, "every 2024 and 2025 row is exactly as before");
    assert.deepStrictEqual(readAll(live, "SELECT COUNT(*) AS n FROM incidents WHERE agency_type IS NOT NULL AND agency_type <> ''"), [{ n: 0 }],
      "no derived type was written into incidents (policy: provenance stays in the evidence tables)");
    assert.deepStrictEqual(readAll(live, "SELECT ori, candidate_oris FROM shr_agency_type_binding ORDER BY ori"),
      [{ ori: "MOKPD00", candidate_oris: '["MOKPD0000"]' }, { ori: "MONEW00", candidate_oris: "[]" }, { ori: "MOSPD00", candidate_oris: '["MOSPD0000"]' }],
      "the evidence was rebuilt and covers every 2026 agency, including the new ones");
    const after = delivered(live, 9);
    assert.deepStrictEqual(before.rows, [["MOSPD00", 3]]);
    assert.deepStrictEqual(after.rows, [["MOSPD00", 9], ["MOKPD00", 2]], "the delivered ranking now reads the refreshed rows");
    assert.match(after.explanation, /New Agency/i, "the agency with no NIBRS match is disclosed as unresolved, not ranked or dropped silently");
    assert.ok(!fs.readdirSync(out.backups).some((n) => n.startsWith("shr-candidate-")), "the candidate is removed after activation");
    assert.strictEqual(fs.readdirSync(out.backups).filter((n) => /^shr-pre-.*\.db$/.test(n)).length, 1, "the rollback snapshot is kept");
    assert.ok(!fs.existsSync(path.join(out.backups, "shr-refresh.lock")), "the lock is released");
    assert.deepStrictEqual(out.status.candidateCounts, [{ year: 2026, before: { year: 2026, incidents: 3, victims: 3, maxMonth: 4 }, after: { year: 2026, incidents: 10, victims: 12, maxMonth: 9 } }]);
    assert.deepStrictEqual(out.status.validation[0].rejected, { short: 0, "not-a-record": 0, "unknown-state": 0, "year-out-of-range": 0, "other-year": 0 });
  });
  await check("SUCCESS while a reader holds the live file open: the restore reaches it without a rename or a reopen", async () => {
    const live = path.join(WORK, "live-reader.db"); liveFixture(live);
    // A separate process with a read-only connection that stays open and re-reads, as an app worker does.
    const reader = childProcess.spawn(process.execPath, ["-e", `const D=require(${JSON.stringify(path.join(REPO, "node_modules", "better-sqlite3"))});
      const db=new D(${JSON.stringify(live)},{readonly:true}); const q=db.prepare("SELECT COUNT(*) AS n FROM incidents WHERE year=2026");
      process.stdout.write("first " + q.get().n + "\\n"); process.stdin.on("data",()=>{ process.stdout.write("again " + q.get().n + "\\n"); });`], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    const lines: string[] = [];
    const next = () => new Promise<string>((resolve) => { const t = setInterval(() => { if (lines.length) { clearInterval(t); resolve(lines.shift()!); } }, 20); });
    reader.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
    try {
      assert.strictEqual(await next(), "first 3");
      const out = await runRefresh(makeRelease("refresh-reader", { realScripts: true }), live);
      assert.strictEqual(out.error, null, String(out.error));
      reader.stdin.write("x\n");
      assert.strictEqual(await next(), "again 10", "the open connection sees the refreshed year on its next read");
    } finally { reader.kill(); }
  });
  await check("--no-activate builds and checks the candidate but changes nothing live, keeping the candidate and snapshot", async () => {
    const live = path.join(WORK, "live-noact.db"); liveFixture(live); const d0 = digest(live);
    const out = await runRefresh(makeRelease("refresh-noact", { realScripts: true }), live, { env: { SHR_REFRESH_NO_ACTIVATE: "1" } });
    assert.strictEqual(out.error, null, String(out.error));
    assert.strictEqual(out.status.outcome, "validated-not-activated");
    assert.strictEqual(digest(live), d0, "live is byte-for-byte the same in every table");
    const cand = fs.readdirSync(out.backups).find((n) => /^shr-candidate-.*\.db$/.test(n))!;
    assert.deepStrictEqual(counts(path.join(out.backups, cand), 2026), { incidents: 10, victims: 12 }, "the kept candidate holds the refresh");
  });

  // ---- the failures that motivated this work: each leaves the live database exactly as it was ----
  const failing = async (label: string, o: RefreshOpts, stage: RegExp, extra?: (out: Awaited<ReturnType<typeof runRefresh>>, live: string) => void) => {
    const live = path.join(WORK, `live-${label}.db`); liveFixture(live); const d0 = digest(live);
    const out = await runRefresh(makeRelease(`refresh-${label}`, { realScripts: true }), live, o);
    assert.ok(out.error, "the run fails");
    assert.match(String(out.error!.message), stage, `actual: ${String(out.error!.message).replace(/\s+/g, " ")}`);
    assert.strictEqual(digest(live), d0, "every table of the live database is exactly as before");
    assert.ok(out.status && /refused|failed|rolled-back/.test(out.status.outcome), `status ${out.status && out.status.outcome}`);
    assert.ok(!fs.existsSync(path.join(out.backups, "shr-refresh.lock")), "the lock is released after a failure");
    extra?.(out, live);
    return out;
  };
  const previous = archiveOf([rec({ ori: "MOSPD00", month: 4, n: 1 })]);
  const keepsPrevious = (out: Awaited<ReturnType<typeof runRefresh>>) => {
    assert.ok(fs.readFileSync(out.archive).equals(previous), "the previous archive is preserved byte-for-byte");
    assert.ok(!fs.readdirSync(out.dataDir).some((n) => n.includes(".download-")), "no partial download is left behind");
    assert.ok(!out.calls.some((c) => c.startsWith("sqlite3")), "no database work was even started");
  };
  await check("HTTP error: curl --fail refuses; no fallback import from the old archive; the previous archive is preserved", () =>
    failing("http", { archive: null, preArchive: previous }, /download refused: shr-2026\.zip: curl: \(22\)/, keepsPrevious).then(() => undefined));
  await check("an error page saved as the archive is not a zip: the archive test refuses it", () =>
    failing("html", { archive: Buffer.from("<html><body>Access Denied</body></html>".repeat(40)), preArchive: previous }, /download refused/, keepsPrevious).then(() => undefined));
  await check("a truncated archive fails the archive test and is not accepted", () =>
    failing("truncated", { archive: archiveOf(OCTOBER).subarray(0, archiveOf(OCTOBER).length - 40), preArchive: previous }, /download refused/, keepsPrevious).then(() => undefined));
  await check("WRONG-YEAR input: a file of 2025 records offered as 2026 is refused, and none of them is written", () =>
    failing("wrong-year", { archive: archiveOf(Array.from({ length: 20 }, (_, i) => rec({ ori: "MOSPD00", month: 3, n: i + 1, yy: "25" }))), preArchive: previous },
      /validation refused: no records for 2026[\s\S]*20 of 20 records are for another year/, (out) => {
        assert.ok(fs.readFileSync(out.archive).equals(previous), "the refused file did not replace the previous archive");
        assert.strictEqual(out.status.validation[0].rejected["other-year"], 20);
      }).then(() => undefined));
  await check("unreadable lines beyond the tolerance are refused, with the reasons counted", () =>
    failing("unreadable", { archive: archiveOf([...OCTOBER, ...Array.from({ length: 8 }, () => "X".repeat(120)), "too short"]) },
      /validation refused: 9 of 19 lines are not readable records/, (out) => assert.deepStrictEqual(out.status.validation[0].rejected,
        { short: 1, "not-a-record": 8, "unknown-state": 0, "year-out-of-range": 0, "other-year": 0 })).then(() => undefined));
  await check("a file that would shrink the loaded year is refused (a larger count alone is not taken as proof of completeness)", () =>
    // Padded with a whitespace-only entry (blank lines are not records) so the archive clears the 1,000-byte floor.
    failing("shrink", { archive: zipOf([{ name: "SHR2026.txt", data: Buffer.from(rec({ ori: "MOSPD00", month: 4, n: 1 }) + "\r\n", "latin1") },
      { name: "pad.txt", data: Buffer.from(" \r\n".repeat(600)) }]) }, /validation refused: the file has 1 incidents for 2026, fewer than 95% of the 3/).then(() => undefined));
  await check("FAILURE AFTER DELETION HAS BEGUN: the deadline expiring inside the candidate's replacement rolls it back; live untouched", async () => {
    let armed = false;
    const big = archiveOf(Array.from({ length: 2500 }, (_, i) => rec({ ori: "MOSPD00", month: (i % 9) + 1, n: i + 1 })));
    await failing("mid-replace", {
      archive: big,
      intercept: (file, args) => { if (file === SQLITE && args.some((a) => a.startsWith(".backup") && a.includes("shr-candidate-"))) armed = true; return undefined; },
      // Ample time until the candidate copy exists; the replacement's record-1000 admission then sees an expired clock.
      deadline: { remainingMs: () => (armed ? 0 : 3600000) },
    }, /replace 2026 \(record 1000\) not dispatched/, (out) => {
      const cand = fs.readdirSync(out.backups).find((x) => /^shr-candidate-.*\.db$/.test(x))!;
      assert.deepStrictEqual(counts(path.join(out.backups, cand), 2026), { incidents: 3, victims: 3 }, "inside the candidate too, the delete was rolled back");
    });
  });
  await check("POST-STEP FAILURE: a failing evidence build stops the run before activation; live untouched", () =>
    // The evidence builder cannot open its NIBRS database: the importer's nibrs path points at a missing file.
    failing("post-step", { nibrs: path.join(WORK, "missing-nibrs.db") }, /build-shr-agency-type-evidence failed/).then(() => undefined));
  await check("DEADLINE: too little time left for activation (with its rollback reserve) refuses before the restore; live untouched", () =>
    (() => {
      // Nine minutes left once the candidate check has run: less than the 10-minute activation reserve.
      const clock = { activating: false };
      return failing("deadline", {
        deadline: { remainingMs: () => (clock.activating ? 9 * 60 * 1000 : 3600000) },
        intercept: (file, args) => { if (file === SQLITE && args.includes("PRAGMA quick_check;") && args.some((a) => a.includes("shr-candidate-"))) clock.activating = true; return undefined; },
      }, /activation refused: not admitted/).then(() => undefined);
    })());
  await check("ACTIVATION READ-BACK MISMATCH: the snapshot is restored the same way and verified; live ends exactly as before", () =>
    failing("readback", {
      // The activation restore copies the WRONG file (the snapshot itself): the read-back disagrees with the candidate.
      intercept: (file, args, opts) => {
        const i = args.findIndex((a) => a.startsWith(".restore") && a.includes("shr-candidate-"));
        if (file === SQLITE && i >= 0) { const wrong = [...args]; wrong[i] = args[i].replace(/shr-candidate-/, "shr-pre-"); return childProcess.execFileSync(file, wrong, { ...opts, windowsHide: true }) as unknown as Buffer; }
        return undefined;
      },
    }, /activation refused: the live year counts or agency-type evidence count differ[\s\S]*the snapshot was restored and verified/, (out) => assert.strictEqual(out.status.outcome, "rolled-back")).then(() => undefined));
  await check("ACTIVATION CHANGED LIVE, THEN FAILED ITS CHECK: only the rollback restore can bring it back -- and it does", () =>
    failing("changed-then-bad", {
      // The real activation restore runs, and then one refreshed row is lost, so the live file differs both
      // from the candidate (the read-back fails) and from the original (only the snapshot restore repairs it).
      intercept: (file, args, opts) => {
        if (file === SQLITE && args.some((a) => a.startsWith(".restore") && a.includes("shr-candidate-"))) {
          const result = childProcess.execFileSync(file, args, { ...opts, windowsHide: true }) as unknown as Buffer;
          const d = new Database(args[1]);
          const id = (d.prepare("SELECT MAX(id) AS id FROM incidents WHERE year = 2026").get() as { id: number }).id;
          d.prepare("DELETE FROM victims WHERE incident_id = ?").run(id); d.prepare("DELETE FROM incidents WHERE id = ?").run(id); d.close();
          return result;
        }
        return undefined;
      },
    }, /activation refused: the live year counts or agency-type evidence count differ[\s\S]*the snapshot was restored and verified/, (out) => assert.strictEqual(out.status.outcome, "rolled-back")).then(() => undefined));
  // ---- Codex SRF-1: the read-back must not be able to spend the time the rollback needs ----
  /** Real activation restore, then one refreshed row lost (so only the rollback can repair live); clock is the test's. */
  function srf1(live: string, clock: { remaining: number }, o: { atActivation: number; checkFails?: boolean; recoveryRestoreFails?: boolean }) {
    const seen = { liveCheckTimeouts: [] as number[], recoveryRestoreTimeout: -1, recoveryCheckTimeout: -1 };
    let activated = false; let recovering = false;
    const intercept = (file: string, args: string[], opts: any): Buffer | undefined => {
      if (file !== SQLITE) return undefined;
      if (args.some((a) => a.startsWith(".restore") && a.includes("shr-candidate-"))) {
        const result = childProcess.execFileSync(file, args, { ...opts, windowsHide: true }) as unknown as Buffer;
        const d = new Database(live);
        const id = (d.prepare("SELECT MAX(id) AS id FROM incidents WHERE year = 2026").get() as { id: number }).id;
        d.prepare("DELETE FROM victims WHERE incident_id = ?").run(id); d.prepare("DELETE FROM incidents WHERE id = ?").run(id); d.close();
        activated = true; clock.remaining = o.atActivation;
        return result;
      }
      if (args.some((a) => a.startsWith(".restore") && a.includes("shr-pre-"))) {
        recovering = true; seen.recoveryRestoreTimeout = opts.timeout;
        if (o.recoveryRestoreFails) throw new Error("simulated recovery restore failure");
        const result = childProcess.execFileSync(file, args, { ...opts, windowsHide: true }) as unknown as Buffer;
        clock.remaining -= opts.timeout;            // the restore used ALL of its admitted time
        return result;
      }
      if (activated && !recovering && args.includes("PRAGMA quick_check;") && args.includes(live)) {
        seen.liveCheckTimeouts.push(opts.timeout);
        clock.remaining -= opts.timeout;            // the check used ALL of its admitted time ...
        if (o.checkFails !== false) throw new Error("simulated live check consumed its allowed timeout");   // ... and then failed
      }
      if (recovering && args.includes("PRAGMA quick_check;") && args.includes(live)) seen.recoveryCheckTimeout = opts.timeout;
      return undefined;
    };
    return { intercept, seen };
  }
  await check("SRF-1 (Codex witness, kept): 301 s left when the live check starts -- it cannot spend the 300 s recovery reserve; the original is restored and verified", async () => {
    const live = path.join(WORK, "live-srf1-witness.db"); liveFixture(live); const d0 = digest(live);
    const clock = { remaining: 3600000 };
    const { intercept, seen } = srf1(live, clock, { atActivation: 301000 });
    const out = await runRefresh(makeRelease("srf1-witness", { realScripts: true }), live, { deadline: { remainingMs: () => clock.remaining }, intercept });
    // Before the correction this check was admitted for 301,000 ms and the rollback was "not dispatched: 0 ms left".
    assert.ok(seen.liveCheckTimeouts.every((t) => t <= 1000), `the live check is bounded by the work budget (${seen.liveCheckTimeouts})`);
    assert.strictEqual(out.status.outcome, "rolled-back", JSON.stringify(out.status.rollback));
    assert.strictEqual(digest(live), d0, "every table of the live database is back exactly as before");
    assert.ok(seen.recoveryCheckTimeout >= 5000, "the recovery's own check was dispatched");
  });
  await check("SRF-1: with a large budget, the live check AND the recovery restore each use all their admitted time -- the recovery check still runs", async () => {
    const live = path.join(WORK, "live-srf1-large.db"); liveFixture(live); const d0 = digest(live);
    const clock = { remaining: 3600000 };
    const { intercept, seen } = srf1(live, clock, { atActivation: 3600000 });
    const out = await runRefresh(makeRelease("srf1-large", { realScripts: true }), live, { deadline: { remainingMs: () => clock.remaining }, intercept });
    assert.strictEqual(seen.liveCheckTimeouts.length, 1);
    assert.ok(seen.liveCheckTimeouts[0] <= 600000 && seen.liveCheckTimeouts[0] <= 3600000 - 300000, `bounded check (${seen.liveCheckTimeouts[0]})`);
    assert.ok(seen.recoveryRestoreTimeout > 0 && seen.recoveryRestoreTimeout <= (3600000 - seen.liveCheckTimeouts[0]) - 120000,
      `the recovery restore leaves the 120 s verification reserve (${seen.recoveryRestoreTimeout})`);
    assert.ok(seen.recoveryCheckTimeout >= 5000, `the recovery check ran after a restore that used all its time (${seen.recoveryCheckTimeout})`);
    assert.strictEqual(out.status.outcome, "rolled-back", JSON.stringify(out.status.rollback));
    assert.strictEqual(digest(live), d0);
  });
  await check("SRF-1: with 610 s left, an activation restore that uses ALL its admitted time still leaves the recovery reserve; the original is restored", async () => {
    const live = path.join(WORK, "live-srf1-restore.db"); liveFixture(live); const d0 = digest(live);
    const clock = { remaining: 610000 };
    let activationTimeout = -1;
    const { intercept: base, seen } = srf1(live, clock, { atActivation: 610000 });
    const intercept = (file: string, args: string[], opts: any) => {
      const isActivation = file === SQLITE && args.some((a) => a.startsWith(".restore") && a.includes("shr-candidate-"));
      const result = base(file, args, opts);
      if (isActivation) { activationTimeout = opts.timeout; clock.remaining -= opts.timeout; }   // the restore used ALL of its admitted time
      return result;
    };
    const out = await runRefresh(makeRelease("srf1-restore", { realScripts: true }), live, { deadline: { remainingMs: () => clock.remaining }, intercept });
    assert.ok(activationTimeout > 0 && activationTimeout <= 610000 - 300000, `the activation restore is bounded by the work budget (${activationTimeout})`);
    assert.strictEqual(out.status.outcome, "rolled-back", JSON.stringify(out.status.rollback));
    assert.strictEqual(digest(live), d0);
    assert.ok(seen.recoveryCheckTimeout >= 5000, "the recovery's own check was dispatched");
  });
  await check("SRF-1: when recovery itself cannot finish, the run says so honestly (rollback-failed), and live is reported changed", async () => {
    const live = path.join(WORK, "live-srf1-fails.db"); liveFixture(live); const d0 = digest(live);
    const clock = { remaining: 3600000 };
    const { intercept } = srf1(live, clock, { atActivation: 3600000, recoveryRestoreFails: true });
    const out = await runRefresh(makeRelease("srf1-fails", { realScripts: true }), live, { deadline: { remainingMs: () => clock.remaining }, intercept });
    assert.ok(out.error && /rollback failed: simulated recovery restore failure/.test(out.error.message), String(out.error));
    assert.strictEqual(out.status.outcome, "rollback-failed");
    assert.notStrictEqual(digest(live), d0, "the fixture really is left changed: the report is not a false success");
  });
  await check("ACTIVATION FAILURE: a failed restore is followed by the snapshot restore; live ends exactly as before", () =>
    failing("restore-fails", {
      intercept: (file, args) => { if (file === SQLITE && args.some((a) => a.startsWith(".restore") && a.includes("shr-candidate-"))) throw new Error("simulated restore failure"); return undefined; },
    }, /activation refused: activation failed: simulated restore failure[\s\S]*the snapshot was restored and verified/).then(() => undefined));
  await check("an unusable runtime refuses BEFORE any download (no curl, no unzip, no snapshot)", async () => {
    const live = path.join(WORK, "live-abi.db"); liveFixture(live); const d0 = digest(live);
    const out = await runRefresh(makeRelease("refresh-abi", { betterSqlite3: "incompatible" }), live);
    assert.ok(out.error instanceof PostImportRefusal && /NODE_MODULE_VERSION/.test((out.error as Error).message), String(out.error));
    assert.deepStrictEqual(out.calls, []);
    assert.strictEqual(digest(live), d0);
  });
  await check("a second refresh is refused while the lock exists, and the lock is not removed by the refused run", async () => {
    const live = path.join(WORK, "live-lock.db"); liveFixture(live); const d0 = digest(live);
    const rel = makeRelease("refresh-lock", { realScripts: true });
    fs.mkdirSync(path.join(WORK, `backups-${path.basename(rel.root)}`), { recursive: true });
    fs.writeFileSync(path.join(WORK, `backups-${path.basename(rel.root)}`, "shr-refresh.lock"), "held");
    const out = await runRefresh(rel, live);
    assert.ok(out.error && /lock refused/.test(out.error.message), String(out.error));
    assert.deepStrictEqual(out.calls, []);
    assert.strictEqual(digest(live), d0);
    assert.ok(fs.existsSync(path.join(out.backups, "shr-refresh.lock")), "someone else's lock is left in place");
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
