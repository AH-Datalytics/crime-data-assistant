/**
 * P1.4c — the verifier: six links, the verdict vocabulary, worker identity, and rollback tolerance.
 *
 * Run: node scripts/test-deployed-artifact-verifier.js
 *
 * The /proc readers are injected, so the per-pid reporting logic -- where a partial reload is either
 * surfaced or lost -- is exercised on a platform that has no /proc. Real /proc behaviour on the
 * deployment target is a different question, and is not claimed here.
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const v = require("./verify-deployed-artifact.js");
const toolchain = require("./lib/toolchain-identity.js");
const manifest = require("./lib/artifact-manifest.js");

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok    ${name}`);
  } catch (error) {
    failures.push({ name, message: error && error.message ? error.message : String(error) });
    console.log(`FAIL  ${name}`);
    console.log(`      ${error && error.message ? error.message : error}`);
  }
}

const temps = [];
function tempDir(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `p14c-v-${label}-`));
  temps.push(d);
  return d;
}

const RELEASES = "/opt/nibrs/releases";
const ACTIVE = `${RELEASES}/20260825_000000`;
const H = (s) => crypto.createHash("sha256").update(s).digest("hex");

function fakeReceipt(overrides) {
  return Object.assign({
    release: "20260825_000000",
    release_path: ACTIVE,
    commit: "a".repeat(40),
    branch: "dev",
    pm2_expected_instances: 4,
    build_node: { path: "/usr/bin/node", version: "24.14.0", sha256: H("node-24.14.0-linux") },
    build_npm: { version: "11.9.0" },
    certified_toolchain: { node: "24.14.0", npm: null },
    source_verdict: "identical"
  }, overrides || {});
}

/** Injected /proc doubles: a map of pid -> {cwd, maps}. */
function readersFor(table) {
  return {
    cwd: (pid) => {
      if (!table[pid] || table[pid].cwd === undefined) {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      }
      return table[pid].cwd;
    },
    maps: (pid) => {
      if (!table[pid] || table[pid].maps === undefined) {
        const e = new Error("EACCES");
        e.code = "EACCES";
        throw e;
      }
      return table[pid].maps;
    }
  };
}

const mapsFor = (release) =>
  `7f00-7f01 r-xp 00000000 00:00 1 ${release}/node_modules/better-sqlite3/build/Release/better_sqlite3.node\n` +
  `7f02-7f03 r-xp 00000000 00:00 2 ${release}/node_modules/@next/swc-linux-x64-gnu/next-swc.linux-x64-gnu.node\n`;

// ---------------------------------------------------------------------------
// verdict vocabulary
// ---------------------------------------------------------------------------

check("fail dominates unverified; both dominate pass", () => {
  assert.equal(v.worst(["pass", "pass"]), "pass");
  assert.equal(v.worst(["pass", "unverified"]), "unverified");
  assert.equal(v.worst(["unverified", "fail"]), "fail");
  assert.equal(v.worst(["fail", "pass", "unverified"]), "fail");
});

check("L1 is always unverified offline, and is never inferred from another link", () => {
  const l1 = v.checkL1(fakeReceipt());
  assert.equal(l1.state, "unverified");
  assert.match(l1.findings.join(" "), /no API authorization/);
  assert.match(l1.findings.join(" "), /pull requests plus a required hosted check/);
});

check("the two refusal sentences are verbatim and distinct", () => {
  assert.match(v.CI_REFUSAL, /did NOT verify that the deployed commit passed hosted CI/);
  assert.match(v.TOOLCHAIN_REFUSAL, /did NOT verify toolchain alignment/);
  assert.notEqual(v.CI_REFUSAL, v.TOOLCHAIN_REFUSAL,
    "a missing CI run and a misaligned toolchain are different faults, fixed by different people");
});

// ---------------------------------------------------------------------------
// L4
// ---------------------------------------------------------------------------

check("L4 passes only when the symlink resolves to the receipted release", () => {
  const root = tempDir("l4");
  const releases = path.join(root, "releases");
  const active = path.join(releases, "20260825_000000");
  fs.mkdirSync(active, { recursive: true });
  const receipt = fakeReceipt({ release_path: active });
  const link = path.join(root, "current");

  if (process.platform === "win32") {
    // A symlink cannot be created here (EPERM). The resolution logic is exercised by pointing the
    // check straight at the directory, which realpath resolves to itself.
    assert.equal(v.checkL4(active, receipt).state, "pass");
    const wrong = path.join(releases, "20260821_212715");
    fs.mkdirSync(wrong, { recursive: true });
    const bad = v.checkL4(wrong, receipt);
    assert.equal(bad.state, "fail");
    assert.match(bad.findings.join(" "), /receipt names 20260825_000000/);
    return;
  }
  fs.symlinkSync(active, link);
  assert.equal(v.checkL4(link, receipt).state, "pass");
  const wrong = path.join(releases, "20260821_212715");
  fs.mkdirSync(wrong, { recursive: true });
  fs.unlinkSync(link);
  fs.symlinkSync(wrong, link);
  assert.equal(v.checkL4(link, receipt).state, "fail");
});

check("L4 fails when the symlink does not resolve at all", () => {
  const r = v.checkL4(path.join(tempDir("l4-missing"), "nothing"), fakeReceipt());
  assert.equal(r.state, "fail");
  assert.match(r.findings.join(" "), /does not resolve/);
});

// ---------------------------------------------------------------------------
// C7 workers
// ---------------------------------------------------------------------------

check("L5 passes when every worker's cwd and mapped code are the receipted release", () => {
  const table = {};
  for (const pid of [101, 102, 103, 104]) table[pid] = { cwd: ACTIVE, maps: mapsFor(ACTIVE) };
  const r = v.checkL5(fakeReceipt(), [101, 102, 103, 104], readersFor(table));
  assert.equal(r.state, "pass");
  assert.equal(r.workers.length, 4);
  assert.ok(r.workers.every((w) => w.native_inside.length === 2),
    "both native modules must be recorded as mapped from inside the receipted release");
});

check("C7 a PARTIAL RELOAD is reported per pid as a split, not as one global result", () => {
  const stale = `${RELEASES}/20260821_212715`;
  const table = {
    101: { cwd: ACTIVE, maps: mapsFor(ACTIVE) },
    102: { cwd: ACTIVE, maps: mapsFor(ACTIVE) },
    103: { cwd: stale, maps: mapsFor(stale) },
    104: { cwd: ACTIVE, maps: mapsFor(ACTIVE) }
  };
  const r = v.checkL5(fakeReceipt(), [101, 102, 103, 104], readersFor(table));
  assert.equal(r.state, "fail");
  assert.equal(r.split, true, "the split must be named as such");
  const byPid = Object.fromEntries(r.workers.map((w) => [w.pid, w.state]));
  assert.deepEqual(byPid, { 101: "pass", 102: "pass", 103: "fail", 104: "pass" },
    "each worker is judged individually");
  const text = r.findings.join("\n");
  assert.match(text, /pid 103: cwd .*20260821_212715/);
  assert.match(text, /pid 103: native module mapped from OUTSIDE the receipted release/);
  assert.doesNotMatch(text, /pid 101|pid 102|pid 104/, "healthy workers must not be blamed");
});

check("L5 fails when the worker COUNT disagrees with the receipt", () => {
  const table = { 101: { cwd: ACTIVE, maps: mapsFor(ACTIVE) }, 102: { cwd: ACTIVE, maps: mapsFor(ACTIVE) } };
  const r = v.checkL5(fakeReceipt(), [101, 102], readersFor(table));
  assert.equal(r.state, "fail");
  assert.match(r.findings.join(" "), /2 worker\(s\) online, receipt expects 4/);
});

check("L5 reports an unreadable /proc entry as unverified for that pid, not as a pass", () => {
  const table = {
    101: { cwd: ACTIVE, maps: mapsFor(ACTIVE) },
    102: { cwd: ACTIVE, maps: mapsFor(ACTIVE) },
    103: { cwd: ACTIVE, maps: mapsFor(ACTIVE) },
    104: {}
  };
  const r = v.checkL5(fakeReceipt(), [101, 102, 103, 104], readersFor(table));
  // `unverified`, not `fail`: fail dominates unverified, and nothing here actually failed. An
  // unreadable /proc entry means we could not look, which is a different claim from "that worker is
  // running the wrong code".
  assert.equal(r.state, "unverified");
  assert.equal(r.split, true, "it is still a split and must be reported as one");
  assert.equal(r.workers.find((w) => w.pid === 104).state, "unverified");
  assert.match(r.findings.join("\n"), /pid 104: \/proc\/104\/cwd unreadable/);
});

check("L5 with ZERO native mappings is unverified -- a matching cwd alone proves nothing", () => {
  // The earlier implementation passed here: it only looked for paths under releases/, found none, and
  // reported success on the strength of cwd. cwd says where the process chdir'd; it does not say whose
  // code it loaded.
  const table = {};
  for (const pid of [101, 102, 103, 104]) {
    table[pid] = { cwd: ACTIVE, maps: "7f00-7f01 r-xp 00000000 00:00 0 \n7f02-7f03 rw-p 0 00:00 0 [heap]\n" };
  }
  const r = v.checkL5(fakeReceipt(), [101, 102, 103, 104], readersFor(table));
  assert.equal(r.state, "unverified", "zero mappings is unverified, never pass");
  assert.match(r.findings.join("\n"), /no native module is mapped from/);
  assert.match(r.findings.join("\n"), /a matching cwd alone is not evidence/);
});

check("L5 fails on a native module mapped from a GLOBAL path outside any release", () => {
  // Not another release directory -- a shared system path, which the old releases/-anchored search
  // could not see at all.
  const table = {};
  for (const pid of [101, 102, 103, 104]) table[pid] = { cwd: ACTIVE, maps: mapsFor(ACTIVE) };
  table[103] = {
    cwd: ACTIVE,
    maps: mapsFor(ACTIVE) + "7f04-7f05 r-xp 00000000 00:00 9 /usr/lib/node_modules/better-sqlite3/better_sqlite3.node\n"
  };
  const r = v.checkL5(fakeReceipt(), [101, 102, 103, 104], readersFor(table));
  assert.equal(r.state, "fail");
  assert.equal(r.workers.find((w) => w.pid === 103).state, "fail");
  assert.match(r.findings.join("\n"), /pid 103: native module mapped from OUTSIDE the receipted release: \/usr\/lib/);
  assert.doesNotMatch(r.findings.join("\n"), /pid 101|pid 102|pid 104/, "the healthy workers are not blamed");
});

check("L5 fails when a mapped native module is not on the surface L3 digested", () => {
  const table = {};
  for (const pid of [101, 102, 103, 104]) table[pid] = { cwd: ACTIVE, maps: mapsFor(ACTIVE) };
  // L3 digested only ONE of the two modules the workers have mapped.
  const digested = new Set(["node_modules/better-sqlite3/build/Release/better_sqlite3.node"]);
  const r = v.checkL5(fakeReceipt(), [101, 102, 103, 104], readersFor(table), digested);
  assert.equal(r.state, "fail");
  assert.match(
    r.findings.join("\n"),
    /mapped native module node_modules\/@next\/swc-linux-x64-gnu\/next-swc\.linux-x64-gnu\.node is not on the digested surface/
  );
});

check("L5 passes when every mapped native module IS on the digested surface", () => {
  const table = {};
  for (const pid of [101, 102, 103, 104]) table[pid] = { cwd: ACTIVE, maps: mapsFor(ACTIVE) };
  const digested = new Set([
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "node_modules/@next/swc-linux-x64-gnu/next-swc.linux-x64-gnu.node"
  ]);
  assert.equal(v.checkL5(fakeReceipt(), [101, 102, 103, 104], readersFor(table), digested).state, "pass");
});

check("a DELETED native mapping cannot satisfy L5, even when the replacement file is digested", () => {
  // The worker holds an unlinked inode open while a different file now sits at that path. L3 digests
  // the REPLACEMENT and agrees with the receipt, so treating the path as the on-disk file was a false
  // pass: the running bytes were never the receipted bytes.
  const inside = `${ACTIVE}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`;
  const table = {};
  for (const pid of [101, 102, 103, 104]) table[pid] = { cwd: ACTIVE, maps: mapsFor(ACTIVE) };
  table[103] = { cwd: ACTIVE, maps: `7f00-7f01 r-xp 00000000 fd:01 99 ${inside} (deleted)\n` };
  const digested = new Set([
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "node_modules/@next/swc-linux-x64-gnu/next-swc.linux-x64-gnu.node"
  ]);
  const r = v.checkL5(fakeReceipt(), [101, 102, 103, 104], readersFor(table), digested);
  assert.equal(r.state, "fail");
  assert.equal(r.workers.find((w) => w.pid === 103).state, "fail");
  assert.deepEqual(r.workers.find((w) => w.pid === 103).native_deleted, [inside]);
  assert.deepEqual(r.workers.find((w) => w.pid === 103).native_inside, [],
    "a deleted mapping must never count as an inside mapping");
  assert.match(r.findings.join("\n"), /pid 103: native module mapped from a DELETED inode/);
  assert.match(r.findings.join("\n"), /no longer exist on disk/);
  assert.doesNotMatch(r.findings.join("\n"), /pid 101|pid 102|pid 104/);
});

check("/proc maps pathnames are parsed by line, with kernel escapes decoded", () => {
  const lines = [
    "7f00-7f01 r-xp 00000000 fd:01 1 /r/plain.node",
    "7f02-7f03 r-xp 00000000 fd:01 2 /r/gone.node (deleted)",
    "7f04-7f05 r-xp 00000000 fd:01 3 /r/with\\040space/x.node",
    "7f06-7f07 r-xp 00000000 fd:01 4 /r/tab\\011sep/y.node",
    "7f08-7f09 rw-p 00000000 00:00 0 [heap]",
    "7f0a-7f0b r-xp 00000000 fd:01 5 /r/shared.so",
    "7f0c-7f0d r-xp 00000000 fd:01 6 /r/no-extension"
  ].join("\n");
  const parsed = v.parseNativeMappings(lines);
  assert.deepEqual(parsed, [
    { path: "/r/plain.node", deleted: false },
    { path: "/r/gone.node", deleted: true },
    { path: "/r/with space/x.node", deleted: false },
    { path: "/r/tab\tsep/y.node", deleted: false }
  ], "only .node mappings, with (deleted) recognised and \\040 / \\011 decoded");

  // ONLY the four escapes mangle_path emits are decoded. Decoding every \\ooo triple was wrong: a
  // literal backslash followed by octal digits -- as in a Windows-shaped path -- was corrupted, and the
  // mapping was then reported as coming from outside the release.
  const literal = "/r/keep" + String.fromCharCode(92) + "202literal/z.node";
  assert.equal(v.decodeMapsPath(literal), literal, "a non-kernel escape must be left alone");
  assert.equal(v.decodeMapsPath("/a" + String.fromCharCode(92) + "134b"), "/a" + String.fromCharCode(92) + "b");
});

check("L5 with no pids is unverified, never a pass", () => {
  assert.equal(v.checkL5(fakeReceipt(), [], readersFor({})).state, "unverified");
  assert.equal(v.checkL5(fakeReceipt(), null, readersFor({})).state, "unverified");
});

// ---------------------------------------------------------------------------
// C8 executables
// ---------------------------------------------------------------------------

const buildNode = fakeReceipt().build_node;

check("C8 a worker executable digest that disagrees with the receipt is reported", () => {
  const r = toolchain.compareExecutables(buildNode, [
    { pid: 101, exePath: "/usr/bin/node", version: "24.14.0", sha256: buildNode.sha256, deleted: false },
    { pid: 102, exePath: "/usr/bin/node", version: "24.14.0", sha256: H("a-different-binary"), deleted: false }
  ]);
  assert.equal(r.state, "fail");
  assert.match(r.findings.join("\n"), /pid 102: executable digest/);
  assert.doesNotMatch(r.findings.join("\n"), /pid 101/);
});

check("C8 a DELETED running image is reported distinctly from a digest mismatch", () => {
  const r = toolchain.compareExecutables(buildNode, [
    { pid: 101, exePath: "/usr/bin/node", version: "24.14.0", sha256: buildNode.sha256, deleted: true }
  ]);
  assert.equal(r.state, "fail");
  assert.match(r.findings.join("\n"), /names a DELETED file/);
  assert.doesNotMatch(r.findings.join("\n"), /executable digest/, "the digest still matched; only the file is gone");
});

check("C8 the PM2-daemon hazard: same version on PATH, different binary, still caught", () => {
  // Node upgraded on disk, app reloaded, but the workers were forked by a daemon holding the old
  // interpreter. Versions can even agree; the digest is what separates them.
  const r = toolchain.compareExecutables(buildNode, [
    { pid: 101, exePath: "/usr/bin/node", version: "24.14.0", sha256: H("stale-daemon-interpreter"), deleted: false }
  ]);
  assert.equal(r.state, "fail");
  assert.match(r.findings.join("\n"), /executable digest/);
});

check("C8 no digest in the receipt means unverified, never a pass", () => {
  const r = toolchain.compareExecutables({ path: "/usr/bin/node", version: "24.14.0", sha256: null }, [
    { pid: 101, exePath: "/usr/bin/node", version: "24.14.0", sha256: H("x"), deleted: false }
  ]);
  assert.equal(r.state, "unverified");
});

check("L6 half A: no executable hash ever crosses the platform boundary", () => {
  const src = fs.readFileSync(path.join(REPO, "scripts", "lib", "toolchain-identity.js"), "utf8");
  const fn = src.slice(src.indexOf("function compareVersions"), src.indexOf("function compareExecutables"))
    .split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(fn, /sha256/, "half A compares versions only: a Windows and a Linux Node can never share a digest");
  const policy = toolchain.loadToolchainPolicy(path.join(REPO, "scripts", "fixtures", "toolchain-policy.json"));
  const ci = toolchain.readCiPins(fs.readFileSync(path.join(REPO, ".github", "workflows", "canonical-harness.yml"), "utf8"));
  assert.equal(policy.node, ci.node, "the declared node must match the CI pin");
  const mismatch = toolchain.compareVersions(policy, ci, {
    node: { version: "22.22.1" },
    npm: { version: "10.9.4" }
  });
  assert.equal(mismatch.state, "fail", "production's measured Node 22.22.1 must fail half A");
  assert.match(mismatch.findings.join("\n"), /declared node 24\.14\.0 != build node 22\.22\.1/);
});

// ---------------------------------------------------------------------------
// C9 rollback tolerance
// ---------------------------------------------------------------------------

check("C9 a release with NO receipt is unverified -- never failed", () => {
  const release = tempDir("legacy");
  fs.writeFileSync(path.join(release, "app.txt"), "legacy release\n");
  const r = v.verify({ releaseDir: release, repoDir: null, currentLink: null, pids: null });
  assert.equal(r.receipt_present, false);
  for (const id of ["L2", "L3", "L4", "L5", "L6"]) {
    assert.notEqual(r.links[id].state, "fail", `${id} must not FAIL merely because a legacy release has no receipt`);
  }
  assert.equal(r.verdicts.artifact_identity, "artifact_identity_unverified");
  assert.equal(r.verdicts.release_identity, "release_identity_unverified");
  const text = v.report(r, "post-reload");
  assert.match(text, /unverified.*never .*failed|`unverified`, never `failed`/,
    "the report must say so, since this is every release built before P1.4c");
});

check("C9 the rollback exits 0 for a receiptless release, so a rollback is never blocked", () => {
  const release = tempDir("legacy2");
  fs.writeFileSync(path.join(release, "app.txt"), "legacy\n");
  const r = spawnSync(process.execPath, [
    path.join(REPO, "scripts", "verify-deployed-artifact.js"),
    "--release", release, "--stage", "rollback", "--pids", ""
  ], { encoding: "utf8" });
  assert.equal(r.status, 0, `the rollback stage must not fail on a legacy release:\n${r.stdout}${r.stderr}`);
});

check("rollback.sh verifies the target, tolerates a receiptless release, and undoes nothing", () => {
  const src = fs.readFileSync(path.join(REPO, "scripts", "rollback.sh"), "utf8");
  const code = src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  // An INVOCATION, not a mention. The earlier version matched the filename anywhere in the file, and
  // the `-f` guard line below contains it too -- so replacing the actual `node …` call with `true`
  // left this check green. A mutation found that hole.
  assert.match(code, /\bnode\s+"\$CURRENT_LINK\/scripts\/verify-deployed-artifact\.js"/,
    "the rollback must actually RUN the verifier on what it rolled back to");
  assert.match(code, /--stage rollback/);
  assert.match(code, /if \[\[ -f "\$CURRENT_LINK\/scripts\/verify-deployed-artifact\.js" \]\]/,
    "a release predating the verifier must be handled, not assumed");
  assert.doesNotMatch(code, /rollback\.sh|deploy-zero-downtime\.sh/, "verification must never trigger another switch");
  const verifyIdx = code.indexOf("verify-deployed-artifact.js");
  const switchIdx = code.indexOf("mv -Tf");
  assert.ok(switchIdx > 0 && verifyIdx > switchIdx, "it runs AFTER the switch: it reports, it does not gate");
});

check("scripts/rollback.sh parses", () => {
  const bash = process.platform === "win32"
    ? (() => {
      const c = [];
      try {
        for (const g of execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
          const d = path.dirname(g);
          for (const root of [path.resolve(d, ".."), path.resolve(d, "..", "..")]) c.push(path.join(root, "bin", "bash.exe"));
        }
      } catch { /* fall through */ }
      c.push(path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"));
      return c.find((x) => { try { return fs.existsSync(x); } catch { return false; } });
    })()
    : "bash";
  assert.ok(bash, "a POSIX bash must be locatable");
  const toBash = (p) => (process.platform === "win32"
    ? p.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_m, d) => `/${d.toLowerCase()}/`)
    : p);
  const r = spawnSync(bash, ["-n", toBash(path.join(REPO, "scripts", "rollback.sh"))], { encoding: "utf8" });
  assert.equal(r.status, 0, `rollback.sh must parse: ${r.stderr}`);
});

// ---------------------------------------------------------------------------
// C10 what the verifier must never read
// ---------------------------------------------------------------------------

check("C10 the verifier reads no env file, no database and no pm2 environment output", () => {
  const src = fs.readFileSync(path.join(REPO, "scripts", "verify-deployed-artifact.js"), "utf8");
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

  // Quoted ARGUMENT TOKENS, not substrings: the CI refusal sentence contains the word "described",
  // and an assertion that trips on prose is not an assertion about behaviour.
  for (const forbidden of ["jlist", "prettylist", "describe"]) {
    assert.doesNotMatch(code, new RegExp(`["']${forbidden}["']`),
      `the verifier must never pass ${forbidden} to pm2: that output embeds the process environment`);
  }
  const pm2Calls = [...code.matchAll(/spawnSync\([^)]*pm2[^)]*\)/g)].map((mm) => mm[0]);
  assert.equal(pm2Calls.length, 1, "there must be exactly one pm2 invocation");
  assert.match(pm2Calls[0], /\["pid", app\]/, "and it must be `pm2 pid`, which prints integers");
  assert.doesNotMatch(code, /\.env\b/, "no env file may be opened by the verifier");
  assert.doesNotMatch(code, /better-sqlite3|\.db['"]/, "no database may be opened");
  assert.doesNotMatch(code, /readlinkSync\([^)]*shared/, "shared state is never dereferenced");
  assert.match(code, /spawnSync\(process\.platform === "win32" \? "pm2\.cmd" : "pm2", \["pid", app\]/,
    "worker discovery must be `pm2 pid`, which prints integers");

  // The generator MAY read NEXT_PUBLIC_ values; the verifier may not read env at all. That split is
  // the point, so assert both halves rather than one.
  // The generator PARSES every assignment -- it must, because Next's $VAR expansion can reference a
  // non-public variable -- but RECORDS only the NEXT_PUBLIC_ subset. The distinction matters, so both
  // halves are asserted: the prefix filter exists, and the behavioural proof that no other name or
  // value reaches the receipt lives in scripts/test-release-receipt.js.
  const genSrc = fs.readFileSync(path.join(REPO, "scripts", "generate-release-receipt.js"), "utf8");
  assert.match(genSrc, /startsWith\("NEXT_PUBLIC_"\)/, "the generator must filter to the NEXT_PUBLIC_ prefix");
  assert.match(genSrc, /Only the NEXT_PUBLIC_ subset crosses back/,
    "and must say so where a reader will see it");
  // The filter runs in the CHILD, before anything is serialized, so a non-public value never enters
  // the generator's own process either.
  assert.match(genSrc, /if \(k\.startsWith\("NEXT_PUBLIC_"\)\) out\[k\] = v;/,
    "the loader child must filter before serializing");
});

check("the verifier never dereferences a symlink into shared state", () => {
  const src = fs.readFileSync(path.join(REPO, "scripts", "lib", "artifact-manifest.js"), "utf8");
  assert.match(src, /fs\.lstatSync/, "the walker must lstat");
  assert.doesNotMatch(src, /fs\.statSync\(/, "a plain stat would follow a link and could hash shared data");
});

// ---------------------------------------------------------------------------
// gating
// ---------------------------------------------------------------------------

check("only L2 and L3 gate publication; L1, L4, L5 and L6 are reported", () => {
  const src = fs.readFileSync(path.join(REPO, "scripts", "verify-deployed-artifact.js"), "utf8");
  const main = src.slice(src.indexOf("if (stage === \"pre-switch\")"));
  const preSwitch = main.slice(main.indexOf('stage === "pre-switch"'), main.indexOf('stage === "post-reload"'));
  assert.match(preSwitch, /links\.L2\.state, result\.links\.L3\.state\]\s*\.every/,
    "pre-switch gates exactly L2 and L3, and requires both to PASS");
  assert.ok(!/L6/.test(preSwitch), "L6 must not gate: it fails on every deploy until the Node alignment lands");

  // post-reload must re-check the artifact too. Gating only on L4 and L5 let an artifact that changed
  // after publication print artifact_identity_failed while handing the deploy exit 0 -- so the deploy
  // saw success and printed no warning at all.
  const postReload = main.slice(main.indexOf('stage === "post-reload"'), main.indexOf('stage === "rollback"'));
  for (const id of ["L2", "L3", "L4", "L5"]) {
    assert.match(postReload, new RegExp(`links\\.${id}\\.state`), `post-reload must require ${id}`);
  }
  assert.match(postReload, /\.every\(\(s\) => s === PASS\)/, "and require all four to PASS");

  // The rollback stage reports without ever blocking a rollback: only a positive FAIL is non-zero.
  const rollbackStage = main.slice(main.indexOf('stage === "rollback"'));
  assert.match(rollbackStage, /\.some\(\(l\) => l\.state === FAIL\)/,
    "a receiptless legacy release is unverified, which must not be treated as a failure");
  const deploy = fs.readFileSync(path.join(REPO, "scripts", "deploy-zero-downtime.sh"), "utf8");
  const code = deploy.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.match(code, /--stage post-reload/, "post-reload verification must run");
  const post = code.slice(code.indexOf("--stage post-reload"));
  assert.doesNotMatch(post, /^\s*(bash|sh|exec)\s+[^\n]*rollback\.sh/m,
    "no automatic rollback: a verifier that moves production can take the site down over its own bug");
  assert.match(post, /To roll back:/, "it must PRINT the command for a person to run");
  assert.match(post, /Nothing was rolled back automatically/, "and it must say so");
});

// ---------------------------------------------------------------------------
// byte integrity of everything P1.4c ships
// ---------------------------------------------------------------------------

check("every P1.4c source file carries no NUL and no other raw control byte", () => {
  // This exists because a literal NUL byte reached both the worktree and the staged blob of
  // verify-deployed-artifact.js -- written where the source escape \u0000 belonged. Git reclassified
  // the file as BINARY, and scripts/check-control-characters.py caught it. But that gate lives in the
  // canonical harness, a twelve-minute run, while the four focused suites carried a byte assertion for
  // three P1.4a files only. So the shortest feedback loop could not see it, and "all four suites green"
  // was reported over a defect the slow gate would later refuse. The loop is closed here.
  const shipped = [
    "scripts/lib/artifact-manifest.js",
    "scripts/lib/toolchain-identity.js",
    "scripts/generate-release-receipt.js",
    "scripts/verify-deployed-artifact.js",
    "scripts/fixtures/artifact-manifest-policy.json",
    "scripts/fixtures/toolchain-policy.json",
    "scripts/fixtures/release-build-inputs.json",
    "scripts/fixtures/receipt-schema.json",
    "scripts/test-artifact-manifest.js",
    "scripts/test-release-receipt.js",
    "scripts/test-deployed-artifact-verifier.js"
  ];
  // TWO VERDICTS, NOT ONE -- the same split scripts/check-control-characters.py makes, and for the
  // same reason. On disk, CR is LEGITIMATE: none of these paths declares `eol=lf`, so a
  // `core.autocrlf=true` checkout materialises them with CRLF, and asserting otherwise fails by
  // construction in that checkout. What is never legitimate anywhere is a NUL or another raw control
  // byte. CR is forbidden only in the INDEX BLOB, which is checkout-independent -- and the first
  // version of this check conflated the two, which is a mistake already made and fixed once in
  // scripts/test-release-export.js this same session.
  const rawControl = (bytes, allowCr) =>
    [...bytes].filter((b) => b < 32 && b !== 9 && b !== 10 && !(allowCr && b === 13));

  for (const rel of shipped) {
    const onDisk = fs.readFileSync(path.join(REPO, rel));
    assert.equal(onDisk.indexOf(0), -1, `${rel}: a raw NUL byte -- write \\u0000 in the source instead`);
    const diskControl = rawControl(onDisk, true);
    assert.equal(diskControl.length, 0,
      `${rel}: ${diskControl.length} raw control byte(s) on disk where an escape belongs`);

    // The index blob is checkout-independent, so it carries the stricter rule -- and a staged-only
    // corruption is exactly the blind spot a worktree-only check cannot see.
    const blob = spawnSync("git", ["cat-file", "blob", `:${rel}`], {
      cwd: REPO, encoding: "buffer", maxBuffer: 32 * 1024 * 1024
    });
    if (blob.status !== 0) continue; // not staged yet: nothing to assert about a blob that does not exist
    const staged = blob.stdout;
    assert.equal(staged.indexOf(0), -1, `${rel} [index blob]: a raw NUL byte`);
    assert.equal(rawControl(staged, false).length, 0,
      `${rel} [index blob]: a raw control byte where an escape belongs`);
    assert.equal(staged.indexOf(13), -1, `${rel} [index blob]: a CR byte -- what is committed must be checkout-independent`);
  }

  // Non-vacuity: the assertion must actually reject a NUL, not merely iterate a list.
  const probe = Buffer.concat([Buffer.from("a"), Buffer.from([0]), Buffer.from("b")]);
  assert.notEqual(probe.indexOf(0), -1, "the NUL predicate must be able to fire");
});

// ---------------------------------------------------------------------------
// stage exit contracts
// ---------------------------------------------------------------------------

check("--stage is validated against a closed set", () => {
  const release = tempDir("stage-closed");
  fs.writeFileSync(path.join(release, "app.txt"), "x\n");
  for (const bad of ["preswitch", "post_reload", "PRE-SWITCH", "anything"]) {
    const r = spawnSync(process.execPath, [
      path.join(REPO, "scripts", "verify-deployed-artifact.js"), "--release", release, "--stage", bad
    ], { encoding: "utf8" });
    assert.notEqual(r.status, 0, `--stage ${bad} must be refused`);
    assert.match(r.stderr, /unknown --stage/, "and the refusal must say so");
  }
  for (const good of ["pre-switch", "post-reload", "rollback", "adhoc"]) {
    const r = spawnSync(process.execPath, [
      path.join(REPO, "scripts", "verify-deployed-artifact.js"), "--release", release, "--stage", good, "--pids", ""
    ], { encoding: "utf8" });
    assert.doesNotMatch(r.stderr, /unknown --stage/, `--stage ${good} must be accepted`);
  }
});

check("post-reload returns NON-ZERO when the artifact changed after publication", () => {
  // L4 and L5 can both be fine while L3 has moved: the symlink still points at the release and the
  // workers still loaded it, but a digested byte changed since the receipt was written. Gating only on
  // L4 and L5 printed artifact_identity_failed and handed the deploy exit 0 -- so the deploy saw
  // success and printed no warning at all.
  const src = fs.readFileSync(path.join(REPO, "scripts", "verify-deployed-artifact.js"), "utf8");
  const main = src.slice(src.indexOf("function main(argv)"));
  const postReload = main.slice(main.indexOf('stage === "post-reload"'), main.indexOf('stage === "rollback"'));
  for (const id of ["L2", "L3", "L4", "L5"]) {
    assert.match(postReload, new RegExp(`links\\.${id}\\.state`), `post-reload must include ${id}`);
  }

  // Behavioural: a release with a receipt whose digest no longer matches must exit non-zero.
  const release = tempDir("post-reload-drift");
  fs.mkdirSync(path.join(release, "scripts", "fixtures"), { recursive: true });
  fs.mkdirSync(path.join(release, "scripts", "lib"), { recursive: true });
  for (const rel of [
    "scripts/fixtures/artifact-manifest-policy.json",
    "scripts/fixtures/toolchain-policy.json",
    "scripts/fixtures/receipt-schema.json",
    "scripts/fixtures/release-allowed-extras.json",
    "scripts/lib/release-export.sh"
  ]) {
    fs.copyFileSync(path.join(REPO, rel), path.join(release, rel));
  }
  fs.writeFileSync(path.join(release, "app.txt"), "changed after the receipt\n");
  const receipt = {
    schema_version: 1, release: path.basename(release), release_path: release,
    commit: "b".repeat(40), commit_tree: "c".repeat(40), branch: "dev",
    ref_resolution: { mode: "explicit_sha", ancestor_of: "refs/remotes/origin/dev" },
    tracked_path_count: 1, tracked_source_verdict: "identical",
    package_lock_sha256: H("lock"), harness_lock_sha256: null,
    next_version: "16.1.6", build_id: "abc",
    build_node: { path: "/usr/bin/node", version: "24.14.0", sha256: H("n") },
    build_npm: { version: "11.9.0" },
    certified_toolchain: { node: "24.14.0", npm: null },
    // The CURRENT algorithm and the REAL record count, so the digest comparison is what fails here.
    // Leaving a stale algorithm made L3 `unverified` (refused, not compared) and leaving a wrong count
    // made the count check fire first -- either way this test stopped exercising the digest at all.
    manifest_algorithm: manifest.MANIFEST_ALGORITHM,
    manifest_digest: H("a digest that will not match"),
    manifest_record_count: manifest.walkRelease(release,
      manifest.loadPolicy(path.join(release, "scripts", "fixtures", "artifact-manifest-policy.json"))).length,
    manifest_exclusions: [
      "path .next/trace", "path .next/trace-build", "path RELEASE_INFO",
      "path RELEASE_RECEIPT.json", "tree .next/cache", "tree .next/diagnostics"
    ],
    manifest_policy_digest: crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(REPO, "scripts", "fixtures", "artifact-manifest-policy.json"))).digest("hex"),
    build_inputs: { policy_digest: H("p"), declared: [], present: {} },
    pm2_expected_instances: 1,
    built_at_start: "2026-08-25T00:00:00+00:00", built_at_end: "2026-08-25T00:01:00+00:00"
  };
  fs.writeFileSync(path.join(release, "RELEASE_RECEIPT.json"), JSON.stringify(receipt, null, 2) + "\n");

  const post = spawnSync(process.execPath, [
    path.join(REPO, "scripts", "verify-deployed-artifact.js"),
    "--release", release, "--current", release, "--stage", "post-reload", "--pids", ""
  ], { encoding: "utf8" });
  assert.notEqual(post.status, 0, "post-reload must be non-zero so the deploy warns");
  assert.match(post.stdout, /L3\s+FAIL/, "and the report must name L3");

  // The same release under the rollback stage: L3 FAILs, so it is reported non-zero too -- but a
  // release with NO receipt stays zero, which is the case that must never block a rollback.
  const legacy = tempDir("post-reload-legacy");
  fs.writeFileSync(path.join(legacy, "app.txt"), "legacy\n");
  const legacyRollback = spawnSync(process.execPath, [
    path.join(REPO, "scripts", "verify-deployed-artifact.js"),
    "--release", legacy, "--stage", "rollback", "--pids", ""
  ], { encoding: "utf8" });
  assert.equal(legacyRollback.status, 0, "a receiptless release must never block a rollback");
});

check("L3 compares the RECORD COUNT explicitly, and refuses a receipt from another algorithm", () => {
  // Two properties the digest alone cannot give. The count is compared rather than merely recorded: if
  // the count disagreed while the digest matched, the encoding would be ambiguous -- which is precisely
  // the v1 defect where a link target could forge a record boundary. And a receipt written under a
  // different algorithm is REFUSED rather than compared, so bumping the version can never mean silently
  // digesting one tree and comparing it against another encoding's number.
  const release = tempDir("l3-count");
  fs.mkdirSync(path.join(release, "scripts", "fixtures"), { recursive: true });
  fs.mkdirSync(path.join(release, "scripts", "lib"), { recursive: true });
  for (const rel of [
    "scripts/fixtures/artifact-manifest-policy.json",
    "scripts/fixtures/toolchain-policy.json",
    "scripts/fixtures/receipt-schema.json",
    "scripts/fixtures/release-allowed-extras.json",
    "scripts/lib/release-export.sh"
  ]) {
    fs.copyFileSync(path.join(REPO, rel), path.join(release, rel));
  }
  fs.writeFileSync(path.join(release, "app.txt"), "unchanged\n");
  const policy = manifest.loadPolicy(path.join(release, "scripts", "fixtures", "artifact-manifest-policy.json"));
  const records = manifest.walkRelease(release, policy);
  const base = {
    schema_version: 1, release: path.basename(release), release_path: release,
    commit: "b".repeat(40), commit_tree: "c".repeat(40), branch: "dev",
    ref_resolution: { mode: "explicit_sha", ancestor_of: "refs/remotes/origin/dev" },
    tracked_path_count: 1, tracked_source_verdict: "identical",
    package_lock_sha256: H("lock"), harness_lock_sha256: null,
    next_version: "16.1.6", build_id: "abc",
    build_node: { path: "/usr/bin/node", version: "24.14.0", sha256: H("n") },
    build_npm: { version: "11.9.0" },
    certified_toolchain: { node: "24.14.0", npm: null },
    manifest_algorithm: manifest.MANIFEST_ALGORITHM,
    manifest_digest: manifest.digestRecords(records),
    manifest_record_count: records.length,
    manifest_exclusions: manifest.exclusionList(policy),
    manifest_policy_digest: policy.digest,
    build_inputs: { policy_digest: H("p"), declared: [], present: {} },
    pm2_expected_instances: 1,
    built_at_start: "2026-08-25T00:00:00+00:00", built_at_end: "2026-08-25T00:01:00+00:00"
  };
  // `--json` takes a report path, like every other flag: arity is uniform, exactly one value each.
  const report = path.join(tempDir("l3-count-report"), "report.json");
  const run = (receipt) => {
    fs.writeFileSync(path.join(release, "RELEASE_RECEIPT.json"), JSON.stringify(receipt, null, 2) + "\n");
    const r = spawnSync(process.execPath, [
      path.join(REPO, "scripts", "verify-deployed-artifact.js"),
      "--release", release, "--stage", "adhoc", "--pids", "", "--json", report
    ], { encoding: "utf8" });
    assert.ok(fs.existsSync(report), `the verifier must write its report: ${r.stdout}${r.stderr}`);
    return JSON.parse(fs.readFileSync(report, "utf8"));
  };

  // Baseline: this receipt genuinely describes this release, so nothing below fires by accident. L3 is
  // `unverified` rather than `pass` here for a different and correct reason -- no --repo is given, so the
  // policy blob is not proven to be the commit's -- and that is the ONLY complaint it has.
  const ok = run(base);
  assert.equal(ok.links.L3.digest, base.manifest_digest, "the digest must have been compared and matched");
  assert.deepEqual(ok.links.L3.findings, [
    "policy provenance unverified: L2 is unverified, so this policy blob is not proven to be the commit's"
  ], "no digest or count complaint may be present in the baseline");

  // Digest matches, count does not.
  const miscounted = run(Object.assign({}, base, { manifest_record_count: records.length + 1 }));
  assert.equal(miscounted.links.L3.state, "fail", "a disagreeing count must FAIL even with a matching digest");
  assert.ok(miscounted.links.L3.findings.some((f) => /record count/.test(f)),
    `the finding must name the count: ${JSON.stringify(miscounted.links.L3.findings)}`);

  // Correct digest under the superseded algorithm name.
  const oldAlgorithm = run(Object.assign({}, base, { manifest_algorithm: "sha256-over-sorted-records-v1" }));
  assert.equal(oldAlgorithm.links.L3.state, "unverified",
    "a receipt from another algorithm is refused, not compared");
  assert.ok(oldAlgorithm.links.L3.findings.some((f) => /manifest_algorithm/.test(f)),
    "and the refusal must say which algorithm it saw");
});

check("malformed --pids is REFUSED, not silently filtered", () => {
  const release = tempDir("pids");
  fs.writeFileSync(path.join(release, "app.txt"), "x\n");
  const run = (pids) => spawnSync(process.execPath, [
    path.join(REPO, "scripts", "verify-deployed-artifact.js"), "--release", release, "--stage", "adhoc", "--pids", pids
  ], { encoding: "utf8" });

  for (const bad of ["101,abc,103", "abc", "101,-2", "101, ,103", "1.5"]) {
    const r = run(bad);
    assert.notEqual(r.status, 0, `--pids ${bad} must be refused`);
    assert.match(r.stderr, /--pids contains (non-numeric entries|an empty entry)/,
      `and the refusal must say why: ${bad}`);
  }
  assert.equal(run("101,102").status !== 2, true, "a well-formed list is accepted");
  assert.equal(run("").status !== 2, true, "an explicitly empty list is accepted as 'no workers'");
});

// ---------------------------------------------------------------------------
// the readers seam: reachable ONLY by an in-process caller
// ---------------------------------------------------------------------------
//
// The seam exists because on a host without /proc, L4 and L5 would be permanently `unverified`, which
// masked a link dropping out of the verdict arithmetic entirely -- a mutation proved that hole was
// real. It must not be reachable from anything an operator or a file controls, or a production run
// could be talked out of reading /proc.

const VERIFIER_SRC = fs.readFileSync(path.join(REPO, "scripts", "verify-deployed-artifact.js"), "utf8");
const GENERATOR_SRC = fs.readFileSync(path.join(REPO, "scripts", "generate-release-receipt.js"), "utf8");
const DEPLOY_SRC = fs.readFileSync(path.join(REPO, "scripts", "deploy-zero-downtime.sh"), "utf8");
const ROLLBACK_SRC = fs.readFileSync(path.join(REPO, "scripts", "rollback.sh"), "utf8");
const stripComments = (src, lineComment) =>
  src.split(/\r?\n/).filter((l) => !new RegExp(`^\\s*(${lineComment})`).test(l)).join("\n");

/**
 * The argument list of every `verify(` call in `text`, found by matching parentheses rather than by a
 * regex. The first attempt at this used a pattern anchored on `\n  );` and silently matched nothing
 * because the real call closes with `\n  });` -- a check that finds no call sites cannot notice a
 * second argument appearing in one.
 */
function verifyCallArgs(text) {
  const out = [];
  const needle = "verify(";
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    // Skip `function verify(` and any identifier that merely ends in "verify".
    const before = text.slice(Math.max(0, i - 9), i);
    if (/function\s+$/.test(before) || /[A-Za-z0-9_$.]$/.test(before)) continue;
    let depth = 0;
    let j = i + needle.length - 1;
    for (; j < text.length; j += 1) {
      if (text[j] === "(") depth += 1;
      else if (text[j] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(i + needle.length, j));
  }
  return out;
}

/** Top-level commas only: a comma inside the options object literal is not a second argument. */
function topLevelArgCount(argText) {
  let depth = 0;
  let count = 1;
  for (const ch of argText) {
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) count += 1;
  }
  return argText.trim() === "" ? 0 : count;
}

check("seam 1: main() calls verify() with exactly ONE argument and names no reader", () => {
  const code = stripComments(VERIFIER_SRC, "\\*|//|/\\*");
  const mainBody = code.slice(code.indexOf("function main(argv)"));
  const calls = verifyCallArgs(mainBody);
  assert.equal(calls.length, 1, "main() must call verify() exactly once");
  assert.equal(topLevelArgCount(calls[0]), 1,
    "the call must pass ONE argument: a second would be the injection seam");
  assert.doesNotMatch(mainBody, /readers/i, "main() must not mention readers in any form");
});

check("seam 2: only the second positional parameter can substitute readers", () => {
  assert.match(VERIFIER_SRC, /function verify\(options, testReaders\)/,
    "the seam must be positional, not a property of the options object");
  assert.match(VERIFIER_SRC, /checkL5\(receipt, options\.pids, testReaders, links\.L3\.digested_paths\)/,
    "and it must be the only reader source handed to checkL5, alongside L3's digested surface");
  const code = stripComments(VERIFIER_SRC, "\\*|//|/\\*");
  assert.doesNotMatch(code, /options\.readers|options\["readers"\]|options\.testReaders/,
    "no options property may supply readers");
  // Proof by behaviour: a readers-shaped OPTION is inert, while the positional parameter works.
  const table = {};
  for (const pid of [201, 202, 203, 204]) table[pid] = { cwd: ACTIVE, maps: mapsFor(ACTIVE) };
  const asOption = v.verify({ releaseDir: tempDir("seam-a"), repoDir: null, pids: [201], readers: readersFor(table) });
  assert.equal(asOption.links.L5.state, "unverified", "a readers OPTION must have no effect at all");
  const positional = v.checkL5(fakeReceipt(), [201, 202, 203, 204], readersFor(table));
  assert.equal(positional.state, "pass", "while the positional seam does work, so the test is not vacuous");
});

check("seam 3: the receipt schema admits no reader-shaped field", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, "scripts", "fixtures", "receipt-schema.json"), "utf8"));
  const fields = Object.keys(schema.fields).map((f) => f.toLowerCase());
  for (const shape of ["readers", "testreaders", "proc", "proc_readers", "cwd", "maps"]) {
    assert.ok(!fields.includes(shape), `the receipt must not carry a ${shape} field`);
  }
  assert.doesNotMatch(stripComments(VERIFIER_SRC, "\\*|//|/\\*"), /receipt\.(readers|testReaders)/,
    "and the verifier must never read one from the receipt");
});

check("seam 4: reader-shaped ENVIRONMENT VARIABLES have no effect", () => {
  const code = stripComments(VERIFIER_SRC, "\\*|//|/\\*");
  assert.doesNotMatch(code, /process\.env/, "the verifier must consult no environment variable at all");
  const release = tempDir("seam-env");
  fs.writeFileSync(path.join(release, "app.txt"), "legacy\n");
  const base = spawnSync(process.execPath, [
    path.join(REPO, "scripts", "verify-deployed-artifact.js"), "--release", release, "--stage", "post-reload", "--pids", ""
  ], { encoding: "utf8" });
  const hostile = spawnSync(process.execPath, [
    path.join(REPO, "scripts", "verify-deployed-artifact.js"), "--release", release, "--stage", "post-reload", "--pids", ""
  ], {
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      READERS: "/tmp/evil", TEST_READERS: "/tmp/evil", VERIFY_READERS: "/tmp/evil",
      PROC_READERS: "/tmp/evil", CDA_READERS: "/tmp/evil", NODE_OPTIONS: ""
    })
  });
  assert.equal(base.status, hostile.status, "the exit code must not move");
  assert.equal(base.stdout, hostile.stdout, "nor the report, byte for byte");
});

check("seam 5: reader-shaped and arbitrary unknown CLI flags are REFUSED, not ignored", () => {
  const release = tempDir("seam-cli");
  fs.writeFileSync(path.join(release, "app.txt"), "legacy\n");
  const cases = [
    ["--readers", "x"], ["--testReaders", "x"], ["--test-readers", "x"],
    ["--currrent", "/tmp"], ["--nonsense", "1"], ["--json=/tmp/x.json"], ["bare-token"]
  ];
  for (const extra of cases) {
    const r = spawnSync(process.execPath, [
      path.join(REPO, "scripts", "verify-deployed-artifact.js"), "--release", release, ...extra
    ], { encoding: "utf8" });
    assert.notEqual(r.status, 0, `${extra.join(" ")} must be refused with a non-zero exit`);
    const token = extra[0].split("=")[0];
    assert.match(r.stderr, new RegExp(token.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")),
      `the refusal must NAME the offending argument: ${extra.join(" ")}`);
  }
  // Duplicates and missing values are refused rather than resolved.
  const dup = spawnSync(process.execPath, [
    path.join(REPO, "scripts", "verify-deployed-artifact.js"), "--release", release, "--release", release
  ], { encoding: "utf8" });
  assert.notEqual(dup.status, 0, "a duplicate flag must be refused, never resolved to first-or-last");
  assert.match(dup.stderr, /--release given more than once/);
  const arity = spawnSync(process.execPath, [
    path.join(REPO, "scripts", "verify-deployed-artifact.js"), "--release", release, "--stage"
  ], { encoding: "utf8" });
  assert.notEqual(arity.status, 0, "a flag with no value must be refused");
  assert.match(arity.stderr, /--stage requires exactly one value/);

  // The same discipline in the generator, whose --out silently defaulting would misplace a receipt.
  const gen = spawnSync(process.execPath, [
    path.join(REPO, "scripts", "generate-release-receipt.js"), "--release", release, "--output", "/tmp/x"
  ], { encoding: "utf8" });
  assert.notEqual(gen.status, 0, "the generator must refuse --output");
  assert.match(gen.stderr, /unknown flag --output/);
});

check("seam 6: a mutation forwarding a CLI-derived value into argument two would be caught", () => {
  // Non-vacuity for seam 1: prove the assertion actually inspects the call site by running it against
  // a forwarded second argument, rather than trusting that the shape would be noticed.
  const code = stripComments(VERIFIER_SRC, "\\*|//|/\\*");
  const mainBody = code.slice(code.indexOf("function main(argv)"));
  const original = verifyCallArgs(mainBody);
  assert.equal(original.length, 1, "there must be a call site to rewrite");
  assert.equal(topLevelArgCount(original[0]), 1, "which today passes one argument");

  // Forward a CLI-derived value as a second argument and confirm seam 1's machinery flags it.
  const forwarded = mainBody.replace(
    `verify(${original[0]})`,
    `verify(${original[0]}, args.readers)`
  );
  assert.notEqual(forwarded, mainBody, "the rewrite must have changed something, or this proves nothing");
  const mutated = verifyCallArgs(forwarded);
  assert.equal(mutated.length, 1, "still exactly one call site");
  assert.equal(topLevelArgCount(mutated[0]), 2,
    "the seam-1 assertion must FLAG a forwarded second argument -- otherwise it cannot detect one");
  assert.match(forwarded, /readers/i, "and the reader-name assertion must trip on it too");
});

check("seam 7: the deploy and rollback use only the single-argument path and supported flags", () => {
  const deployCode = stripComments(DEPLOY_SRC, "#");
  const rollbackCode = stripComments(ROLLBACK_SRC, "#");
  for (const [label, code] of [["deploy", deployCode], ["rollback", rollbackCode]]) {
    assert.doesNotMatch(code, /readers/i, `${label} must never mention readers`);
  }
  // Every flag either script passes must be in the closed set of the CLI it invokes.
  const verifyFlags = v.VERIFY_FLAGS;
  const generateFlags = require("./generate-release-receipt.js").GENERATE_FLAGS;
  for (const [label, code, script, known] of [
    ["deploy/verify", deployCode, "verify-deployed-artifact.js", verifyFlags],
    ["rollback/verify", rollbackCode, "verify-deployed-artifact.js", verifyFlags],
    ["deploy/generate", deployCode, "generate-release-receipt.js", generateFlags]
  ]) {
    const idx = code.indexOf(script);
    if (idx === -1) continue;
    // The invocation runs until the next unescaped newline that is not a line continuation.
    const tail = code.slice(idx);
    const invocation = tail.slice(0, tail.search(/\n(?!\s)/) === -1 ? tail.length : tail.search(/\n(?!\s)/));
    for (const flag of [...invocation.matchAll(/--([a-z][a-z-]*)/g)].map((mm) => mm[1])) {
      assert.ok(known.includes(flag), `${label}: --${flag} is not in that CLI's closed flag set`);
    }
  }
  assert.match(deployCode, /--stage pre-switch/, "the deploy must gate pre-switch");
  assert.match(deployCode, /--stage post-reload/, "and report post-reload");
  assert.match(rollbackCode, /--stage rollback/, "the rollback uses its own stage, which never blocks a rollback");
});

// ---------------------------------------------------------------------------

for (const d of temps) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* a temp directory that resists removal must not fail the suite */ }
}

console.log("");
console.log(`deployed artifact verifier: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED ${f.name}: ${f.message}`);
  process.exit(1);
}
