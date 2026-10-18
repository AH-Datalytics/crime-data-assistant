/**
 * P1.4c — the artifact manifest: records, determinism, exclusion policy.
 *
 * Run: node scripts/test-artifact-manifest.js
 *
 * PLATFORM SPLIT, STATED. `buildRecord` is a pure function over a stat-like object, so every field --
 * including the symlink and executable-bit branches -- is exercised here on any platform. `walkRelease`
 * touches the filesystem, and NTFS has no executable bit while creating a symlink on Windows needs a
 * privilege this workstation does not have (measured: fs.symlinkSync returns EPERM). The behavioural
 * filesystem controls for links and exec bits therefore run in a Linux container where the Docker
 * daemon actually serves Linux containers; what runs here on every platform is the record layer and the
 * policy.
 *
 * Where no Linux kernel is reachable the controls are reported as NOT EXERCISED and are counted as
 * neither passed nor failed -- see the OSType classification below, and the CI failure that forced it.
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const m = require("./lib/artifact-manifest.js");

const REPO = path.resolve(__dirname, "..");
const POLICY_FILE = path.join(REPO, "scripts", "fixtures", "artifact-manifest-policy.json");

let passed = 0;
const failures = [];
// A probe that did not run is neither a pass nor a failure, and must not be counted as either. The
// summary line reports it as its own state so no reader can take "N passed, 0 failed" to mean the
// Linux filesystem controls were exercised.
const notExercised = [];
function check(name, fn) {
  const before = notExercised.length;
  try {
    fn();
    // A check that recorded a not-exercised probe is NOT a pass. Counting it as one is exactly how a
    // suite comes to report "22 passed, 0 failed" for controls that never ran.
    if (notExercised.length > before) {
      console.log(`skip  ${name}  (NOT EXERCISED -- see above)`);
      return;
    }
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `p14c-${label}-`));
  temps.push(d);
  return d;
}

/** Stat-like doubles, so link and exec semantics are testable where the OS cannot express them. */
const asFile = (mode, size) => ({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, mode, size });
const asDir = () => ({ isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false, mode: 0o755, size: 4096 });
const asLink = () => ({ isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, mode: 0o777, size: 12 });
const H = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// the record
// ---------------------------------------------------------------------------

check("a file record carries path, exec, size and sha256 -- and no mtime", () => {
  const r = m.buildRecord(asFile(0o644, 12), "a/b.txt", { sha256: H("x") });
  assert.deepEqual(Object.keys(r).sort(), ["exec", "path", "sha256", "size", "type"]);
  assert.equal(r.type, "file");
  assert.equal(r.exec, false);
  assert.equal(r.size, 12);
  assert.ok(!("mtime" in r), "mtime must never appear: it varies with the copy mechanism");
});

check("the EXECUTABLE BIT is recorded, and only the bit -- umask noise cannot move the digest", () => {
  assert.equal(m.buildRecord(asFile(0o644, 1), "f", { sha256: H("a") }).exec, false);
  assert.equal(m.buildRecord(asFile(0o755, 1), "f", { sha256: H("a") }).exec, true);
  // 0o644 and 0o664 differ in mode but not in executability: the digest must not move.
  const a = m.serialize([m.buildRecord(asFile(0o644, 1), "f", { sha256: H("a") })]).toString();
  const b = m.serialize([m.buildRecord(asFile(0o664, 1), "f", { sha256: H("a") })]).toString();
  assert.equal(a, b, "a non-executable mode difference must not change the record");
  const c = m.serialize([m.buildRecord(asFile(0o755, 1), "f", { sha256: H("a") })]).toString();
  assert.notEqual(a, c, "flipping the executable bit MUST change the record");
});

check("a symlink is recorded by TARGET TEXT and carries no size, sha256 or exec", () => {
  const r = m.buildRecord(asLink(), ".env", { target: "/opt/nibrs/shared/.env" });
  assert.deepEqual(Object.keys(r).sort(), ["path", "target", "type"]);
  assert.equal(r.target, "/opt/nibrs/shared/.env");
  assert.ok(!("sha256" in r), "a link target must never be hashed -- that is how shared state stays unread");
  assert.ok(!("size" in r), "nor sized");
});

check("a symlink without its target text is refused rather than silently followed", () => {
  assert.throws(() => m.buildRecord(asLink(), ".env", {}), /needs its target text/);
});

check("a directory record appears only for the empty case", () => {
  const r = m.buildRecord(asDir(), ".next/node_modules");
  assert.deepEqual(Object.keys(r).sort(), ["path", "type"]);
  assert.equal(r.type, "dir");
});

check("a file without a valid sha256 is refused", () => {
  assert.throws(() => m.buildRecord(asFile(0o644, 1), "f", {}), /needs a sha256/);
  assert.throws(() => m.buildRecord(asFile(0o644, 1), "f", { sha256: "nope" }), /needs a sha256/);
});

check("paths must be normalized POSIX-relative", () => {
  assert.throws(() => m.buildRecord(asFile(0o644, 1), "/abs", { sha256: H("a") }), /normalized/);
  assert.throws(() => m.buildRecord(asFile(0o644, 1), "a\\b", { sha256: H("a") }), /normalized/);
  assert.throws(() => m.buildRecord(asFile(0o644, 1), "./a", { sha256: H("a") }), /normalized/);
});

// ---------------------------------------------------------------------------
// C1 determinism
// ---------------------------------------------------------------------------

check("the encoding is UNAMBIGUOUS: a target cannot forge a record boundary", () => {
  // v1 joined unescaped tab-separated fields with newlines, so these two DIFFERENT trees serialized
  // byte-identically and collided onto one digest. Reachable, not theoretical: a path or link target
  // may contain a newline or a tab on Linux, which is why /proc/<pid>/maps escapes them.
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  const link = (p, t) => m.buildRecord(asLink(), p, { target: t });
  const one = [link("a", "x" + NL + "symlink" + TAB + "b" + TAB + "y")];
  const two = [link("a", "x"), link("b", "y")];
  assert.notEqual(m.digestRecords(one), m.digestRecords(two),
    "a forged record boundary must not collide two different trees");
  assert.notEqual(m.serialize(one).toString(), m.serialize(two).toString());
  // Every line must be a parseable tuple, so structure can never come from a value.
  for (const line of m.serialize(one).toString().split("\n").filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line), "each record must be one JSON tuple");
  }
  assert.equal(m.MANIFEST_ALGORITHM, "sha256-over-sorted-json-records-v2",
    "the algorithm version must move with the encoding, so a v1 receipt is refused rather than compared");
});

check("a path containing a newline or tab round-trips distinctly", () => {
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  const a = [m.buildRecord(asFile(0o644, 1), "dir" + NL + "x/f", { sha256: H("a") })];
  const b = [m.buildRecord(asFile(0o644, 1), "dir" + TAB + "x/f", { sha256: H("a") })];
  assert.notEqual(m.digestRecords(a), m.digestRecords(b), "newline and tab must not be interchangeable");
});

check("C1 the digest is order-independent and sorted by RAW BYTES, not locale", () => {
  const recs = [
    m.buildRecord(asFile(0o644, 1), "b.txt", { sha256: H("b") }),
    m.buildRecord(asFile(0o644, 1), "A.txt", { sha256: H("A") }),
    m.buildRecord(asFile(0o644, 1), "a.txt", { sha256: H("a") }),
    m.buildRecord(asFile(0o644, 1), "Z.txt", { sha256: H("Z") })
  ];
  const one = m.digestRecords(recs);
  const two = m.digestRecords([...recs].reverse());
  assert.equal(one, two, "record order must not change the digest");
  // Records are JSON tuples now: ["file", path, exec, size, sha256]. Element 1 is the path.
  const order = m.serialize(recs).toString().split("\n").filter(Boolean).map((l) => JSON.parse(l)[1]);
  assert.deepEqual(order, ["A.txt", "Z.txt", "a.txt", "b.txt"],
    "uppercase must sort before lowercase: byte order, not a locale collation that would interleave them");
});

check("C1 two walks of an unchanged tree produce an identical digest", () => {
  const root = tempDir("stable");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "sub", "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(root, "b.bin"), Buffer.from([0, 1, 2, 255]));
  const policy = m.loadPolicy(POLICY_FILE);
  assert.equal(m.digestRecords(m.walkRelease(root, policy)), m.digestRecords(m.walkRelease(root, policy)));
});

check("C1 the same content at a DIFFERENT path digests identically", () => {
  const policy = m.loadPolicy(POLICY_FILE);
  const mk = (label) => {
    const root = tempDir(label);
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "a.txt"), "alpha\n");
    return m.digestRecords(m.walkRelease(root, policy));
  };
  assert.equal(mk("copy-a"), mk("copy-b"),
    "records are release-relative, so a copy at another absolute path is the same artifact");
});

// ---------------------------------------------------------------------------
// C2 exclusions
// ---------------------------------------------------------------------------

function releaseWithNext() {
  const root = tempDir("release");
  fs.mkdirSync(path.join(root, ".next", "server"), { recursive: true });
  fs.mkdirSync(path.join(root, ".next", "cache", "fetch"), { recursive: true });
  fs.mkdirSync(path.join(root, ".next", "diagnostics"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
  fs.writeFileSync(path.join(root, ".next", "BUILD_ID"), "abc123\n");
  fs.writeFileSync(path.join(root, ".next", "server", "app.js"), "server\n");
  fs.writeFileSync(path.join(root, ".next", "cache", "fetch", "e1"), "cached\n");
  fs.writeFileSync(path.join(root, ".next", "diagnostics", "d.json"), "{}\n");
  fs.writeFileSync(path.join(root, ".next", "trace"), "trace\n");
  fs.writeFileSync(path.join(root, ".next", "trace-build"), "trace\n");
  fs.writeFileSync(path.join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "NATIVE-v1\n");
  fs.writeFileSync(path.join(root, "RELEASE_INFO"), "release=t\n");
  fs.writeFileSync(path.join(root, "RELEASE_RECEIPT.json"), "{}\n");
  fs.writeFileSync(path.join(root, "app.txt"), "app\n");
  return root;
}

check("C2 touching an EXCLUDED file leaves the digest unchanged", () => {
  const root = releaseWithNext();
  const policy = m.loadPolicy(POLICY_FILE);
  const before = m.digestRecords(m.walkRelease(root, policy));
  fs.writeFileSync(path.join(root, ".next", "cache", "fetch", "e1"), "DIFFERENT\n");
  fs.writeFileSync(path.join(root, ".next", "trace"), "DIFFERENT\n");
  fs.writeFileSync(path.join(root, ".next", "diagnostics", "d.json"), '{"x":1}\n');
  fs.writeFileSync(path.join(root, "RELEASE_INFO"), "release=CHANGED\n");
  fs.writeFileSync(path.join(root, "RELEASE_RECEIPT.json"), '{"changed":true}\n');
  assert.equal(m.digestRecords(m.walkRelease(root, policy)), before, "excluded content must not move the digest");
});

check("C2 touching an INCLUDED file changes the digest and the path is named", () => {
  const root = releaseWithNext();
  const policy = m.loadPolicy(POLICY_FILE);
  const before = m.walkRelease(root, policy);
  fs.writeFileSync(path.join(root, ".next", "server", "app.js"), "server-CHANGED\n");
  const after = m.walkRelease(root, policy);
  assert.notEqual(m.digestRecords(after), m.digestRecords(before));
  const diff = m.compareRecords(before, after);
  assert.equal(diff.equal, false);
  assert.deepEqual(diff.changed.map((c) => c.path), [".next/server/app.js"], "the changed path must be named");
});

check("C3 replacing a native .node under node_modules is detected", () => {
  const root = releaseWithNext();
  const policy = m.loadPolicy(POLICY_FILE);
  const before = m.walkRelease(root, policy);
  const native = path.join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  fs.writeFileSync(native, "NATIVE-v2-SWAPPED\n");
  const diff = m.compareRecords(before, m.walkRelease(root, policy));
  assert.deepEqual(
    diff.changed.map((c) => c.path),
    ["node_modules/better-sqlite3/build/Release/better_sqlite3.node"],
    "the native module the workers memory-map is exactly what excluding node_modules would have missed"
  );
});

check("C6 an empty directory removed is detected", () => {
  const root = tempDir("empty");
  fs.mkdirSync(path.join(root, "hollow"));
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  const policy = m.loadPolicy(POLICY_FILE);
  const before = m.walkRelease(root, policy);
  assert.ok(before.some((r) => r.path === "hollow" && r.type === "dir"), "an empty directory must be recorded");
  fs.rmdirSync(path.join(root, "hollow"));
  const diff = m.compareRecords(before, m.walkRelease(root, policy));
  assert.deepEqual(diff.missing, ["hollow"], "its removal must be reported");
});

check("a directory with contents is NOT recorded -- its contents imply it", () => {
  const root = tempDir("implied");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "a.txt"), "a\n");
  const records = m.walkRelease(root, m.loadPolicy(POLICY_FILE));
  assert.deepEqual(records.map((r) => r.path), ["sub/a.txt"]);
});

// ---------------------------------------------------------------------------
// the policy
// ---------------------------------------------------------------------------

check("the shipped policy loads, covers exactly the reviewed exclusions, and digests", () => {
  const policy = m.loadPolicy(POLICY_FILE);
  assert.equal(policy.policy_version, 1);
  assert.match(policy.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(m.exclusionList(policy).sort(), [
    "path RELEASE_INFO",
    "path RELEASE_RECEIPT.json",
    "path .next/trace",
    "path .next/trace-build",
    "tree .next/cache",
    "tree .next/diagnostics"
  ].sort());
  const paths = policy.exclusions.map((e) => e.path);
  assert.ok(!paths.some((p) => p.startsWith("node_modules")), "node_modules must NEVER be excluded: the workers load native code from it");
  assert.ok(!paths.includes(".env") && !paths.includes("crime_data.db"),
    "shared symlink targets are excluded BEHAVIOURALLY by never following a link; listing them here would imply the walker looked");
});

check("the policy schema is closed at both levels", () => {
  const good = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
  const cases = [
    ["unknown top-level field", (d) => { d.extra_rules = []; }, /unknown top-level field extra_rules/],
    ["unknown entry field", (d) => { d.exclusions[0].corpus_ids = ["x"]; }, /unknown field corpus_ids/],
    ["unknown scope", (d) => { d.exclusions[0].scope = "recursive"; }, /unknown scope/],
    ["unknown reason", (d) => { d.exclusions[0].reason = "because"; }, /unknown reason/],
    ["missing detail", (d) => { delete d.exclusions[0].detail; }, /missing or empty required field detail/],
    ["absolute path", (d) => { d.exclusions[0].path = "/etc/passwd"; }, /relative POSIX path/],
    ["escaping path", (d) => { d.exclusions[0].path = "../outside"; }, /relative POSIX path/],
    ["duplicate", (d) => { d.exclusions.push({ ...d.exclusions[0] }); }, /duplicate exclusion/],
    ["empty exclusions", (d) => { d.exclusions = []; }, /non-empty array/],
    ["wrong version", (d) => { d.policy_version = 2; }, /unsupported policy_version/]
  ];
  for (const [label, mutate, expected] of cases) {
    const doc = JSON.parse(JSON.stringify(good));
    mutate(doc);
    assert.throws(() => m.parsePolicy(JSON.stringify(doc), "t"), expected, `${label} must be refused`);
  }
});

check("an unreadable or malformed policy THROWS -- there is no default to fall back to", () => {
  assert.throws(() => m.loadPolicy(path.join(tempDir("absent"), "nope.json")), /not readable/);
  assert.throws(() => m.parsePolicy("{ not json", "t"), /not valid JSON/);
  const src = fs.readFileSync(path.join(REPO, "scripts", "lib", "artifact-manifest.js"), "utf8");
  assert.doesNotMatch(src, /DEFAULT_EXCLUSIONS|FALLBACK_EXCLUSIONS/,
    "no built-in exclusion set may exist: a verifier with defaults passes when its policy is missing");
});

check("tree scope excludes the subtree; path scope excludes exactly one entry", () => {
  const policy = m.loadPolicy(POLICY_FILE);
  assert.equal(m.isExcluded(".next/cache", policy), true);
  assert.equal(m.isExcluded(".next/cache/fetch/e1", policy), true);
  assert.equal(m.isExcluded(".next/trace", policy), true);
  assert.equal(m.isExcluded(".next/trace/inner", policy), false, "a path-scoped entry must not swallow a subtree");
  assert.equal(m.isExcluded(".next/cachexyz", policy), false, "prefix matching must respect the separator");
  assert.equal(m.isExcluded(".next/server/app.js", policy), false);
});

// ---------------------------------------------------------------------------
// C5 / C6 behavioural — a real Linux filesystem, or an honest skip
// ---------------------------------------------------------------------------
//
// NTFS has no executable bit and fs.symlinkSync returns EPERM on this workstation, so Windows cannot
// express the objects these controls are about. Where a Linux container is available the controls run
// for real; where it is not, they are recorded as a MANDATORY PRE-DEPLOYMENT PROBE rather than
// claimed. The structural guarantees above (a link is recorded by target text, never followed; the
// exec bit is a recorded field) hold on every platform.

const DOCKER_LINUX = "linux";
const DOCKER_WINDOWS_CONTAINERS = "windows-containers";
const DOCKER_DAEMON_UNAVAILABLE = "daemon-unavailable";
const DOCKER_ABSENT = "absent";
const HOST_LINUX = "host-linux";

/**
 * Classify the Docker daemon by the OS its containers actually run.
 *
 * WHAT THIS REPLACED, AND WHY. The previous check asked `docker version` for a Server.Version and
 * treated any answer as "a Linux container is available". The hosted Windows runner has Docker, and its
 * daemon answers with a version -- while serving WINDOWS containers. So the probe launched a Linux image
 * against it and got `no matching manifest for windows(10.0.26100)/amd64`, exit 125, which failed the
 * suite and blocked 127 downstream commands. Presence of a CLI is not a capability; OSType is.
 *
 * `run` is a seam for the focused controls below, which have to cover daemon states this machine is not
 * in. The shipped path passes nothing and spawns docker itself.
 */
function classifyDocker(run) {
  const exec = run || ((args) => spawnSync("docker", args, { encoding: "utf8", timeout: 30000 }));
  const r = exec(["info", "--format", "{{.OSType}}"]);
  if (!r || r.error) {
    return r && r.error && r.error.code === "ENOENT" ? DOCKER_ABSENT : DOCKER_DAEMON_UNAVAILABLE;
  }
  if (r.status !== 0) return DOCKER_DAEMON_UNAVAILABLE;
  const osType = String(r.stdout || "").trim().toLowerCase();
  if (osType === "linux") return DOCKER_LINUX;
  if (osType === "windows") return DOCKER_WINDOWS_CONTAINERS;
  // An answer we do not understand is not a capability. Guessing here is how the last defect happened.
  return DOCKER_DAEMON_UNAVAILABLE;
}

/** The report for a classification that cannot run the controls. It never claims coverage. */
function probeNotExercisedReport(classification) {
  const why = {
    [DOCKER_WINDOWS_CONTAINERS]:
      "the Docker daemon here serves WINDOWS containers, so a Linux image cannot start against it",
    [DOCKER_DAEMON_UNAVAILABLE]:
      "the Docker daemon did not answer, so no container of any kind can start",
    [DOCKER_ABSENT]:
      "Docker is not installed on this machine"
  }[classification] || `the Docker classification ${classification} is not one this suite understands`;
  return [
    `NOT EXERCISED HERE: ${why}.`,
    "Windows cannot create a symlink or express an executable bit, so these controls ran in no form at",
    "all -- not here, and not in a container. This remains a MANDATORY PRE-DEPLOYMENT PROBE, it is NOT",
    "covered by this run, and this run is not evidence about it either way."
  ];
}

/** The Linux path's acceptance. Separated so a control can prove a failing probe really fails. */
function assertProbeOutput(out, text) {
  assert.equal(out.status, 0, `the Linux probe must pass:\n${text}`);
  assert.match(text, /C5 repointed symlink detected/, "C5 must have run");
  assert.match(text, /C6 exec bit flip detected/, "C6 must have run");
  assert.match(text, /link target never read/, "the target-not-followed control must have run");
}

check("the Linux probe is classified by the daemon's OSType, not by the CLI's presence", () => {
  assert.equal(classifyDocker(() => ({ status: 0, stdout: "linux\n" })), DOCKER_LINUX);
  assert.equal(classifyDocker(() => ({ status: 0, stdout: "windows\r\n" })), DOCKER_WINDOWS_CONTAINERS,
    "a daemon serving Windows containers is not a Linux capability -- this is the case that failed CI");
  assert.equal(classifyDocker(() => ({ status: 1, stderr: "error during connect: daemon not running" })),
    DOCKER_DAEMON_UNAVAILABLE);
  assert.equal(classifyDocker(() => ({ error: Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }) })),
    DOCKER_ABSENT);
  assert.equal(classifyDocker(() => ({ error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) })),
    DOCKER_DAEMON_UNAVAILABLE, "a hung daemon is unavailable, not absent");
  assert.equal(classifyDocker(() => ({ status: 0, stdout: "freebsd\n" })), DOCKER_DAEMON_UNAVAILABLE,
    "an OSType this suite does not understand must never be treated as runnable");
  assert.equal(classifyDocker(() => ({ status: 0, stdout: "" })), DOCKER_DAEMON_UNAVAILABLE,
    "an empty answer is not Linux");

  // The classification must come from the OSType query specifically, so no version string can supply it.
  const asked = [];
  classifyDocker((args) => { asked.push(args.join(" ")); return { status: 0, stdout: "linux\n" }; });
  assert.deepEqual(asked, ["info --format {{.OSType}}"], "one query, and it asks for OSType");
});

check("every classification that cannot run the controls is reported as NOT EXERCISED", () => {
  const reasons = new Set();
  for (const c of [DOCKER_WINDOWS_CONTAINERS, DOCKER_DAEMON_UNAVAILABLE, DOCKER_ABSENT]) {
    const text = probeNotExercisedReport(c).join("\n");
    assert.match(text, /NOT EXERCISED HERE/, `${c} must say the controls did not run`);
    assert.match(text, /MANDATORY PRE-DEPLOYMENT PROBE/, `${c} must retain the standing warning`);
    assert.doesNotMatch(text, /all controls passed/,
      `${c} must not carry the probe's own success marker`);
    reasons.add(text.split("\n")[0]);
  }
  assert.equal(reasons.size, 3, "each classification must state its own distinct reason");
});

check("on a Linux daemon a failing probe FAILS; it is never downgraded to a skip", () => {
  assert.throws(() => assertProbeOutput({ status: 125 },
    "docker: no matching manifest for windows(10.0.26100)/amd64\n"),
    /the Linux probe must pass/, "the exact CI failure must still be a failure where Linux IS available");
  assert.throws(() => assertProbeOutput({ status: 0 },
    "linux probe: all controls passed on linux v24.19.0\n"),
    /C5 must have run/, "a zero exit with no control output is a failure, not a pass");
});

check("C5/C6 real symlink and executable-bit behaviour on Linux", () => {
  // The ordinary record-layer and policy assertions above run on every platform and never consult
  // Docker. Only these filesystem controls need a Linux kernel.
  const classification = process.platform === "linux" ? HOST_LINUX : classifyDocker();
  if (classification !== HOST_LINUX && classification !== DOCKER_LINUX) {
    for (const line of probeNotExercisedReport(classification)) console.log(`      ${line}`);
    notExercised.push(`C5/C6 Linux filesystem controls (${classification})`);
    return;
  }

  const work = tempDir("linux-probe");
  fs.mkdirSync(path.join(work, "lib"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "scripts", "lib", "artifact-manifest.js"), path.join(work, "lib", "artifact-manifest.js"));
  fs.copyFileSync(POLICY_FILE, path.join(work, "policy.json"));
  fs.writeFileSync(path.join(work, "probe.js"), probeSource());

  // The probe takes its module directory and its scratch directory as arguments. Inside the container
  // they are /w and the container's own /tmp. On a Linux HOST they are this throwaway directory and a
  // fresh directory inside it: the probe once hardcoded /w and /tmp, so the host path could not load
  // its module (first exercised on the hosted Linux runner, 2026-10-09) and would have written into
  // the runner's shared /tmp.
  let out;
  if (classification === HOST_LINUX) {
    const scratch = path.join(work, "scratch");
    fs.mkdirSync(scratch);
    out = spawnSync(process.execPath, [path.join(work, "probe.js"), work, scratch],
      { encoding: "utf8", cwd: work });
  } else {
    // --network none, and only this throwaway directory is mounted: no credentials, no databases, no
    // developer checkout, no production path.
    out = spawnSync("docker", [
      "run", "--rm", "--network", "none",
      "-v", `${work}:/w`, "-w", "/w",
      "node:24-alpine", "node", "/w/probe.js", "/w", "/tmp"
    ], { encoding: "utf8", timeout: 180000 });
  }
  const text = (out.stdout || "") + (out.stderr || "");
  for (const line of text.split(/\r?\n/).filter(Boolean)) console.log(`      ${line}`);
  // A Linux daemon WAS available, so anything short of a clean pass is a real failure of this suite.
  assertProbeOutput(out, text);
});

function probeSource() { return `
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [W, T] = process.argv.slice(2);
assert.ok(W && T && path.isAbsolute(W) && path.isAbsolute(T), "usage: probe.js <module dir> <scratch dir>");
const m = require(W + "/lib/artifact-manifest.js");
const policy = m.loadPolicy(W + "/policy.json");
const root = T + "/release";
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root + "/shared", { recursive: true });

// A "shared" target whose content must never enter the manifest.
fs.writeFileSync(T + "/shared-secret", "SECRET_VALUE_MUST_NOT_BE_HASHED\\n");
fs.writeFileSync(root + "/app.txt", "app\\n");
fs.symlinkSync(T + "/shared-secret", root + "/.env");

let records = m.walkRelease(root, policy);
const link = records.find((r) => r.path === ".env");
assert.ok(link, "the symlink must be recorded");
assert.equal(link.type, "symlink");
assert.equal(link.target, T + "/shared-secret");
assert.ok(!("sha256" in link) && !("size" in link), "a link must carry no content digest");
const secretHash = require("node:crypto").createHash("sha256").update(fs.readFileSync(T + "/shared-secret")).digest("hex");
assert.ok(!m.serialize(records).toString().includes(secretHash), "the target's digest must appear nowhere");
console.log("link target never read: recorded as target text only");

// C5 -- repoint the link; the target is still never read.
const before = m.digestRecords(records);
fs.writeFileSync(T + "/shared-other", "SECRET_VALUE_MUST_NOT_BE_HASHED\\n"); // identical CONTENT
fs.unlinkSync(root + "/.env");
fs.symlinkSync(T + "/shared-other", root + "/.env");
records = m.walkRelease(root, policy);
assert.notEqual(m.digestRecords(records), before, "repointing a link must change the digest");
const diff = m.compareRecords([link], records.filter((r) => r.path === ".env"));
assert.equal(diff.changed.length, 1, "the link must be reported as changed");
console.log("C5 repointed symlink detected (target text differs; identical target CONTENT would have hidden it)");

// C6 -- flip the executable bit only.
const mid = m.digestRecords(m.walkRelease(root, policy));
fs.chmodSync(root + "/app.txt", 0o755);
const after = m.walkRelease(root, policy);
assert.notEqual(m.digestRecords(after), mid, "flipping the exec bit must change the digest");
assert.equal(after.find((r) => r.path === "app.txt").exec, true);
console.log("C6 exec bit flip detected (content unchanged, digest moved)");

// A symlinked DIRECTORY must not be descended into.
fs.mkdirSync(T + "/outside/deep", { recursive: true });
fs.writeFileSync(T + "/outside/deep/leak.txt", "leak\\n");
fs.symlinkSync(T + "/outside", root + "/linked-dir");
const withDir = m.walkRelease(root, policy);
assert.ok(withDir.some((r) => r.path === "linked-dir" && r.type === "symlink"), "a linked dir is a link");
assert.ok(!withDir.some((r) => r.path.includes("leak.txt")), "the walker must not descend through a link");
console.log("symlinked directory recorded as a link, not descended into");
console.log("linux probe: all controls passed on " + process.platform + " " + process.version);
`; }

for (const d of temps) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* a temp directory that resists removal must not fail the suite */ }
}

console.log("");
const tally = `artifact manifest: ${passed} passed, ${failures.length} failed` +
  (notExercised.length ? `, ${notExercised.length} NOT EXERCISED` : "");
console.log(tally);
for (const n of notExercised) console.log(`  NOT EXERCISED ${n} -- mandatory pre-deployment probe, not evidence`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED ${f.name}: ${f.message}`);
  process.exit(1);
}
