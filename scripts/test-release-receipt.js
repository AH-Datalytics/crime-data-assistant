/**
 * P1.4c — the receipt: generated from the exported release, bound to the commit, closed at every edge.
 *
 * Run: node scripts/test-release-receipt.js
 *
 * Self-fixturing and offline: every check builds a throwaway git repository and a synthetic release in
 * a temp directory, then drives the SHIPPED generator and verifier. Nothing outside the temp
 * directories is written, and no network, database or production path is touched.
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const generator = require("./generate-release-receipt.js");
const verifier = require("./verify-deployed-artifact.js");
const m = require("./lib/artifact-manifest.js");

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `p14c-r-${label}-`));
  temps.push(d);
  return d;
}
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return (r.stdout || "").trim();
}

/** The tracked paths a release needs for the generator to work, copied from this repository. */
const TRACKED_FROM_REPO = [
  "scripts/lib/artifact-manifest.js",
  "scripts/lib/toolchain-identity.js",
  // L2 now recomputes closed extras by running the SHIPPED P1.4a helper from the exported release, so
  // the helper and its allowlist have to be part of the export. Without them closed_extras is
  // correctly `unverified` -- which is what a release missing its own rules deserves.
  "scripts/lib/release-export.sh",
  "scripts/fixtures/release-allowed-extras.json",
  "scripts/generate-release-receipt.js",
  "scripts/verify-deployed-artifact.js",
  "scripts/fixtures/artifact-manifest-policy.json",
  "scripts/fixtures/toolchain-policy.json",
  "scripts/fixtures/release-build-inputs.json",
  "scripts/fixtures/receipt-schema.json",
  ".github/workflows/canonical-harness.yml"
];

/**
 * A synthetic repo whose commit contains a real deploy bundle, plus an exported, built release.
 * `mutate` runs against the release directory before the receipt is generated.
 */
function makeReleaseWorld(options) {
  const opts = options || {};
  const root = tempDir("world");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "--quiet", "-b", "dev"]);
  git(repo, ["config", "user.email", "p14c@example.invalid"]);
  git(repo, ["config", "user.name", "p14c"]);
  git(repo, ["config", "core.autocrlf", "false"]);

  // `omitTracked` leaves a path out of the COMMIT, not just out of the release. Deleting a tracked
  // file from the release instead would fail tracked_content, which is a different finding and would
  // mask the one under test.
  const omit = new Set(opts.omitTracked || []);
  for (const rel of TRACKED_FROM_REPO) {
    if (omit.has(rel)) continue;
    const dest = path.join(repo, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), dest);
  }
  // A real `build` script, because capture and build are one step now: a release whose package.json has
  // no build script cannot exercise the shipped wrapper at all. It stands in for `next build`, which is
  // not needed to prove input binding and would make these tests depend on a full toolchain.
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({
    name: "synthetic",
    dependencies: { next: "16.1.6" },
    scripts: { build: "node -e \"0\"" }
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(repo, "ecosystem.config.js"), "module.exports = {\n  apps: [{\n    name: 'nibrs',\n    instances: 4,\n  }],\n};\n");
  fs.writeFileSync(path.join(repo, "app.txt"), "application source\n");
  if (opts.harnessLock) fs.writeFileSync(path.join(repo, "requirements-harness.txt"), "requests==2.34.2\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "--quiet", "-m", "synthetic release commit"]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/remotes/origin/dev", sha]);

  // Export the commit's tree, blob by blob. `git archive | tar` is what the deploy uses, but Windows
  // tar reads an absolute path like C:\… as a remote host spec, and this test has to run on the
  // platform the harness runs on. Writing each blob is the same content by construction -- it is the
  // tree -- and keeps the fixture portable.
  const release = path.join(root, "releases", "20260825_000000");
  fs.mkdirSync(release, { recursive: true });
  for (const line of git(repo, ["ls-tree", "-r", "--format=%(objectmode)%x09%(path)", sha]).split("\n").filter(Boolean)) {
    const [mode, rel] = line.split("\t");
    const dest = path.join(release, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const blob = spawnSync("git", ["cat-file", "blob", `${sha}:${rel}`], { cwd: repo, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
    if (blob.status !== 0) throw new Error(`cat-file ${rel}: ${blob.stderr}`);
    fs.writeFileSync(dest, blob.stdout);
    if (mode === "100755" && process.platform !== "win32") fs.chmodSync(dest, 0o755);
  }

  // A real release has node_modules after `npm ci`, and the build inputs are now resolved by NEXT'S
  // OWN loader rather than a reimplementation -- so @next/env must be present, resolved from the
  // release, exactly as it is in production.
  fs.mkdirSync(path.join(release, "node_modules", "@next"), { recursive: true });
  fs.cpSync(path.join(REPO, "node_modules", "@next", "env"), path.join(release, "node_modules", "@next", "env"), { recursive: true });

  fs.mkdirSync(path.join(release, ".next", "server"), { recursive: true });
  fs.mkdirSync(path.join(release, ".next", "cache"), { recursive: true });
  fs.mkdirSync(path.join(release, "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
  fs.writeFileSync(path.join(release, ".next", "BUILD_ID"), "x5lidw60sdrUSIE1_rLla\n");
  fs.writeFileSync(path.join(release, ".next", "server", "app.js"), "compiled server\n");
  fs.writeFileSync(path.join(release, ".next", "cache", "entry"), "runtime cache\n");
  fs.writeFileSync(path.join(release, ".next", "trace"), "profiling\n");
  fs.writeFileSync(path.join(release, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "NATIVE-v1\n");
  fs.writeFileSync(path.join(release, "next-env.d.ts"), "// generated\n");
  fs.writeFileSync(path.join(release, "RELEASE_INFO"), "release=20260825_000000\nbuilt_at=2026-08-25T00:00:00+00:00\n");

  // NO .env FILE BY DEFAULT, and that is not a shortcut. In a real release .env is a SYMLINK into
  // shared storage, which Windows cannot create -- and now that L2 recomputes closed extras through
  // the shipped helper, a regular file at that path is correctly reported `wrong-type`. So the default
  // world is a release that would genuinely pass the gate, and public inputs arrive through the
  // INHERITED ENVIRONMENT, which is the path the old implementation could not see at all. Env-file
  // precedence and expansion are covered separately, against capture only.
  const env = { NEXT_PUBLIC_ENABLE_HATE_CRIME: opts.hcFlag || "true" };
  if (opts.extraPublic) env[opts.extraPublic] = "surprise";
  if (opts.envFile) {
    fs.writeFileSync(path.join(release, ".env"), opts.envFile);
  }

  if (opts.mutate) opts.mutate(release, repo, sha);
  return { root, repo, release, sha, env };
}

/**
 * A snapshot in the state the deploy hands to the generator: written by the process that ran the build,
 * hence `built: true`. Capture and build are ONE step now (`--capture-build-inputs … --run-build`), so a
 * capture-only snapshot never reaches a receipt -- "(a1)" proves that. These worlds do not run a real
 * `next build`; the one-process binding itself is proved end-to-end in "the wrapper hands the captured
 * value to the build process".
 */
function captureInputs(world, env) {
  const file = path.join(tempDir("snapshot"), "build-inputs.json");
  const snapshot = Object.assign({}, generator.captureBuildInputs(world.release, env), { built: true });
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
  return file;
}

/**
 * `opts.env` feeds the CAPTURE only. Generation takes no environment: it reports the snapshot the build
 * wrote, so there is nothing to substitute at generation time.
 */
function generate(world, options) {
  const opts = options || {};
  return generator.buildReceipt({
    releaseDir: world.release,
    repoDir: world.repo,
    sha: world.sha,
    branch: "dev",
    builtAtStart: "2026-08-25T00:00:00+00:00",
    buildInputsFile: opts.buildInputsFile || captureInputs(world, opts.env || world.env)
  });
}

function writeReceipt(world, receipt) {
  fs.writeFileSync(path.join(world.release, "RELEASE_RECEIPT.json"), JSON.stringify(receipt, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

let sample = null;

check("a receipt is generated from the exported release and satisfies its own closed schema", () => {
  const world = makeReleaseWorld();
  const { receipt, records } = generate(world);
  sample = receipt;
  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.commit, world.sha);
  assert.equal(receipt.tracked_source_verdict, "identical");
  assert.ok(!("source_verdict" in receipt),
    "the old name is gone: it measured tracked blobs only, and was misread as proof the closed-extras gate passed");
  assert.equal(receipt.ref_resolution.mode, "explicit_sha");
  assert.equal(receipt.ref_resolution.ancestor_of, "refs/remotes/origin/dev");
  assert.match(receipt.manifest_digest, /^[0-9a-f]{64}$/);
  assert.equal(receipt.manifest_record_count, records.length);
  assert.equal(receipt.pm2_expected_instances, 4);
  assert.equal(receipt.build_id, "x5lidw60sdrUSIE1_rLla");
  assert.equal(receipt.certified_toolchain.node, "24.14.0");
  assert.equal(receipt.certified_toolchain.npm, null, "the workflow pins no npm; inventing one would assert what it never said");
  assert.equal(receipt.harness_lock_sha256, null, "nullable by design for commits before the lock existed");
  const schema = generator.loadSchema(world.release);
  assert.deepEqual(generator.validateReceipt(receipt, schema), []);
});

check("the harness lock is recorded when the commit has one", () => {
  const world = makeReleaseWorld({ harnessLock: true });
  const { receipt } = generate(world);
  assert.match(receipt.harness_lock_sha256, /^[0-9a-f]{64}$/);
});

check("the manifest digests node_modules and the native module, and excludes what the policy says", () => {
  const world = makeReleaseWorld();
  const { records } = generate(world);
  const paths = records.map((r) => r.path);
  assert.ok(paths.includes("node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
    "the native module the workers memory-map must be digested");
  assert.ok(paths.includes(".next/server/app.js"));
  assert.ok(!paths.includes(".next/cache/entry"), "the runtime cache is excluded");
  assert.ok(!paths.includes(".next/trace"), "build profiling is excluded");
  assert.ok(!paths.includes("RELEASE_INFO"), "the pre-build stamp is excluded");
  assert.ok(!paths.includes("RELEASE_RECEIPT.json"), "the receipt cannot digest itself");
});

check("C10 the receipt records ONLY NEXT_PUBLIC_ values, and no other env name or value anywhere", () => {
  // The fixture MUST contain secrets, or the three "must not appear" assertions below have nothing to
  // catch and pass vacuously. That is exactly what happened once: when the default world stopped
  // writing a .env file, these assertions kept passing while the property went untested, and a
  // mutation removing the NEXT_PUBLIC_ filter was caught by a neighbouring check instead of this one.
  const world = makeReleaseWorld({
    envFile:
      "NEXT_PUBLIC_ENABLE_HATE_CRIME=true\n" +
      "ANTHROPIC_API_KEY=sk-must-never-be-read\n" +
      "QUERY_LOG_KEY=also-secret\n"
  });
  const raw = fs.readFileSync(path.join(world.release, ".env"), "utf8");
  assert.match(raw, /ANTHROPIC_API_KEY/, "non-vacuity: the fixture really does hold a secret to leak");

  const { receipt } = generate(world, { env: {} });
  assert.deepEqual(Object.keys(receipt.build_inputs.present), ["NEXT_PUBLIC_ENABLE_HATE_CRIME"]);
  assert.equal(receipt.build_inputs.present.NEXT_PUBLIC_ENABLE_HATE_CRIME, "true");
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /ANTHROPIC_API_KEY/, "a secret NAME must not appear");
  assert.doesNotMatch(serialized, /sk-must-never-be-read/, "a secret VALUE must not appear");
  assert.doesNotMatch(serialized, /QUERY_LOG_KEY|also-secret/, "nor any other env entry");
});

check("the NEXT_PUBLIC_ set is CLOSED: an undeclared one blocks the BUILD and names itself", () => {
  const world = makeReleaseWorld({ extraPublic: "NEXT_PUBLIC_SURPRISE_FLAG" });
  // Refused at capture, before a single file is built -- not after, when the artifact already exists.
  assert.throws(() => generator.captureBuildInputs(world.release, world.env), (error) => {
    assert.match(error.message, /closed set/);
    assert.match(error.message, /NEXT_PUBLIC_SURPRISE_FLAG/);
    assert.doesNotMatch(error.message, /ANTHROPIC_API_KEY|sk-must-never-be-read/,
      "not even an ERROR message may leak a non-public variable");
    return true;
  });
});

check("C4 the artifact digest moves when the build changes while the SOURCE still matches", () => {
  const world = makeReleaseWorld();
  const before = generate(world).receipt;
  fs.writeFileSync(path.join(world.release, ".next", "server", "app.js"), "compiled server -- DIFFERENT BUILD\n");
  const after = generate(world).receipt;
  assert.equal(after.tracked_source_verdict, "identical", "source equality is untouched: this is L3, not L2");
  assert.notEqual(after.manifest_digest, before.manifest_digest, "swapping build output must move the digest");
});

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

function verifyRelease(world, extra, testReaders) {
  // testReaders is passed POSITIONALLY, never inside the options object: the seam is deliberately not
  // an option, so nothing built from CLI flags, environment or receipt contents can reach it.
  return verifier.verify(Object.assign({ releaseDir: world.release, repoDir: world.repo }, extra || {}), testReaders);
}

check("a freshly receipted release verifies L2 and L3, and NEVER claims release identity", () => {
  const world = makeReleaseWorld();
  writeReceipt(world, generate(world).receipt);
  const r = verifyRelease(world);
  assert.equal(r.links.L2.state, "pass");
  assert.equal(r.links.L2.tracked_content, "pass");
  assert.equal(r.links.L3.state, "pass");
  assert.equal(r.links.L1.state, "unverified", "no offline evidence of a hosted run exists");
  assert.notEqual(r.verdicts.release_identity, "release_identity_verified");
});

check("C11 release_identity_verified is unreachable while L1 is unverified, even with L2-L5 all PASS", () => {
  // The earlier version of this check let L4 and L5 sit at `unverified`, so the overall verdict was
  // `unverified` for reasons that had nothing to do with L1 -- and a mutation dropping L1 out of the
  // computation went undetected. A mutation found that hole. The scenario now drives L2, L3, L4 and L5
  // all the way to PASS, so L1 and L6 are the ONLY things holding the verdict back.
  const world = makeReleaseWorld();
  const receipt = generate(world).receipt;
  writeReceipt(world, receipt);

  const pids = [901, 902, 903, 904];
  const maps = (release) => `7f00-7f01 r-xp 0 00:00 1 ${release}/node_modules/better-sqlite3/build/Release/better_sqlite3.node\n`;
  const readers = { cwd: () => receipt.release_path, maps: () => maps(receipt.release_path) };

  const r = verifyRelease(world, { currentLink: world.release, pids }, readers);
  for (const id of ["L2", "L3", "L4", "L5"]) {
    assert.equal(r.links[id].state, "pass", `${id} must PASS so this scenario isolates L1 and L6`);
  }
  assert.equal(r.links.L1.state, "unverified");
  // The same on every platform: these pids are invented, so L6 must not read the real /proc for them.
  assert.equal(r.links.L6.state, "unverified", "L6 must be unverified here, not failed against an unrelated process");
  assert.equal(r.verdicts.artifact_identity, "artifact_identity_verified",
    "L2-L5 all passing is exactly what artifact identity means");
  assert.equal(r.verdicts.release_identity, "release_identity_unverified",
    "and release identity must STILL be withheld, on L1 and L6 alone");

  const src = fs.readFileSync(path.join(REPO, "scripts", "verify-deployed-artifact.js"), "utf8");
  assert.match(src, /release_identity_verified reached with L1 or L6 not pass/,
    "the impossibility must be enforced in code, not merely by convention");
});

check("L3 fails when a digested byte changes after publication, naming the artifact mismatch", () => {
  const world = makeReleaseWorld();
  writeReceipt(world, generate(world).receipt);
  fs.writeFileSync(path.join(world.release, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "NATIVE-v2-SWAPPED\n");
  const r = verifyRelease(world);
  assert.equal(r.links.L3.state, "fail");
  assert.match(r.links.L3.findings.join("\n"), /manifest digest .* != receipt/);
  assert.equal(r.links.L2.state, "pass", "the source is untouched: L3 is independent of L2");
});

check("L3 IGNORES a change to an excluded path", () => {
  const world = makeReleaseWorld();
  writeReceipt(world, generate(world).receipt);
  fs.writeFileSync(path.join(world.release, ".next", "cache", "entry"), "cache churn\n");
  fs.writeFileSync(path.join(world.release, ".next", "trace"), "more profiling\n");
  assert.equal(verifyRelease(world).links.L3.state, "pass");
});

check("A RECEIPT CANNOT WIDEN ITS OWN EXCLUSIONS: claiming node_modules is refused", () => {
  const world = makeReleaseWorld();
  const receipt = generate(world).receipt;
  receipt.manifest_exclusions = [...receipt.manifest_exclusions, "tree node_modules"].sort();
  writeReceipt(world, receipt);
  const r = verifyRelease(world);
  assert.equal(r.links.L3.state, "fail");
  assert.match(r.links.L3.findings.join("\n"), /claims exclusions the committed policy does not contain: tree node_modules/);
});

check("a receipt that OMITS a policy exclusion is refused too -- equality runs both ways", () => {
  const world = makeReleaseWorld();
  const receipt = generate(world).receipt;
  receipt.manifest_exclusions = receipt.manifest_exclusions.filter((e) => e !== "tree .next/cache");
  writeReceipt(world, receipt);
  const r = verifyRelease(world);
  assert.equal(r.links.L3.state, "fail");
  assert.match(r.links.L3.findings.join("\n"), /omits exclusions the committed policy requires/);
});

check("a forged policy digest is refused", () => {
  const world = makeReleaseWorld();
  const receipt = generate(world).receipt;
  receipt.manifest_policy_digest = crypto.createHash("sha256").update("forged").digest("hex");
  writeReceipt(world, receipt);
  assert.match(verifyRelease(world).links.L3.findings.join("\n"), /policy digest mismatch/);
});

check("MISSING GIT OBJECTS produce unverified, and drag the policy's provenance with them", () => {
  const world = makeReleaseWorld();
  writeReceipt(world, generate(world).receipt);
  const r = verifier.verify({ releaseDir: world.release, repoDir: path.join(world.root, "no-such-repo") });
  assert.equal(r.links.L2.state, "unverified");
  assert.equal(r.links.L3.state, "unverified", "the policy is only as trustworthy as L2 makes it");
  assert.match(r.links.L3.findings.join("\n"), /policy provenance unverified/);
  assert.notEqual(r.verdicts.artifact_identity, "artifact_identity_verified");
});

check("an ABSENT manifest policy is unverified -- and no default exclusions exist to fall back on", () => {
  const world = makeReleaseWorld();
  writeReceipt(world, generate(world).receipt);
  fs.rmSync(path.join(world.release, "scripts", "fixtures", "artifact-manifest-policy.json"));
  const r = verifyRelease(world);
  assert.equal(r.links.L3.state, "unverified");
  assert.match(r.links.L3.findings.join("\n"), /no default exclusions exist; refusing to guess/);
});

check("the receipt schema is CLOSED: unknown, missing and mistyped fields are all refused", () => {
  const world = makeReleaseWorld();
  const good = generate(world).receipt;
  const schema = generator.loadSchema(world.release);
  const mutate = (fn) => { const r = JSON.parse(JSON.stringify(good)); fn(r); return generator.validateReceipt(r, schema); };
  assert.match(mutate((r) => { r.sneaky = 1; }).join(";"), /unknown field sneaky/);
  assert.match(mutate((r) => { delete r.manifest_digest; }).join(";"), /missing field manifest_digest/);
  assert.match(mutate((r) => { r.manifest_digest = "short"; }).join(";"), /manifest_digest is not sha256/);
  assert.match(mutate((r) => { r.pm2_expected_instances = "4"; }).join(";"), /pm2_expected_instances is not integer/);
  assert.match(mutate((r) => { r.commit = "zzz"; }).join(";"), /commit is not sha1/);
  assert.equal(mutate((r) => { r.harness_lock_sha256 = null; }).length, 0, "nullable stays nullable");
});

check("an invalid receipt is treated as ABSENT, not as a passing one", () => {
  const world = makeReleaseWorld();
  const receipt = generate(world).receipt;
  delete receipt.manifest_digest;
  writeReceipt(world, receipt);
  const r = verifyRelease(world);
  assert.equal(r.receipt_present, false);
  assert.match(r.receipt_problems.join(";"), /missing field manifest_digest/);
  assert.equal(r.links.L3.state, "unverified");
  assert.notEqual(r.verdicts.artifact_identity, "artifact_identity_verified");
});

// ---------------------------------------------------------------------------
// closed extras: RECOMPUTED, never taken from the receipt
// ---------------------------------------------------------------------------

check("L2 fails on a new unexplained path while every tracked blob is still identical", () => {
  const world = makeReleaseWorld();
  writeReceipt(world, generate(world).receipt);
  const clean = verifyRelease(world);
  assert.equal(clean.links.L2.state, "pass");
  assert.equal(clean.links.L2.closed_extras, "pass");

  // Nothing tracked is touched -- only a stray file appears.
  fs.writeFileSync(path.join(world.release, "leftover-sweep.md"), "left behind\n");
  const dirty = verifyRelease(world);
  assert.equal(dirty.links.L2.tracked_content, "pass", "every tracked blob is still byte-identical");
  assert.equal(dirty.links.L2.closed_extras, "fail", "but the release is no longer a closed set");
  assert.equal(dirty.links.L2.state, "fail", "so the combined link fails");
  assert.match(dirty.links.L2.findings.join("\n"), /closed_extras: unexplained leftover-sweep\.md/);
  assert.notEqual(dirty.verdicts.artifact_identity, "artifact_identity_verified");
});

check("L2 fails on a wrong-type permitted path, recomputed through the shipped helper", () => {
  const world = makeReleaseWorld();
  writeReceipt(world, generate(world).receipt);
  // RELEASE_INFO is permitted as a FILE; a directory there is a different object.
  fs.rmSync(path.join(world.release, "RELEASE_INFO"));
  fs.mkdirSync(path.join(world.release, "RELEASE_INFO"));
  const r = verifyRelease(world);
  assert.equal(r.links.L2.closed_extras, "fail");
  assert.match(r.links.L2.findings.join("\n"), /closed_extras: wrong-type RELEASE_INFO expected=file actual=directory/);
});

check("THE RECEIPT CANNOT CLAIM closed_extras PASSED: the field no longer exists to be believed", () => {
  const world = makeReleaseWorld();
  const receipt = generate(world).receipt;
  // Plant every shape a forger might try, then confirm the verifier still recomputes.
  receipt.tracked_source_verdict = "identical";
  writeReceipt(world, receipt);
  fs.writeFileSync(path.join(world.release, "smuggled.txt"), "x\n");

  const r = verifyRelease(world);
  assert.equal(r.links.L2.closed_extras, "fail", "a receipt claim cannot make an unexplained path acceptable");

  // And a receipt carrying a closed_extras field at all is refused by the closed schema.
  const forged = generate(makeReleaseWorld()).receipt;
  forged.closed_extras = "pass";
  const schema = generator.loadSchema(world.release);
  assert.match(generator.validateReceipt(forged, schema).join(";"), /unknown field closed_extras/);

  // The verifier must never read such a field even if one appeared.
  const src = fs.readFileSync(path.join(REPO, "scripts", "verify-deployed-artifact.js"), "utf8");
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /receipt\.closed_extras|receipt\.source_verdict/,
    "closed extras must be recomputed, never read from the receipt");
});

check("closed_extras is unverified -- not a pass -- when the helper is absent from the commit", () => {
  const world = makeReleaseWorld({ omitTracked: ["scripts/lib/release-export.sh"] });
  writeReceipt(world, generate(world).receipt);
  const r = verifyRelease(world);
  assert.equal(r.links.L2.tracked_content, "pass", "every path the commit does have is still identical");
  assert.equal(r.links.L2.closed_extras, "unverified", "but the rule cannot be recomputed");
  assert.equal(r.links.L2.state, "unverified", "unverified, never a silent pass");
  assert.match(r.links.L2.findings.join("\n"), /no helper at/);
  assert.notEqual(r.verdicts.artifact_identity, "artifact_identity_verified");
});

check("closed_extras is unverified when the ALLOWLIST is absent from the commit", () => {
  const world = makeReleaseWorld({ omitTracked: ["scripts/fixtures/release-allowed-extras.json"] });
  writeReceipt(world, generate(world).receipt);
  const r = verifyRelease(world);
  assert.equal(r.links.L2.closed_extras, "unverified");
  assert.match(r.links.L2.findings.join("\n"), /no allowlist at/);
});

// ---------------------------------------------------------------------------
// build inputs: bound by the process that runs the build, in ONE step
// ---------------------------------------------------------------------------

check("(a1) a capture-only snapshot is REFUSED: only the process that BUILT may vouch for one", () => {
  // The earlier shape captured in one process, marshalled the values out, built, then compared the
  // environment again -- reading back its own exports. Removing that check leaves one obligation in its
  // place: the snapshot a receipt describes must be the one the BUILD wrote. Nothing else can attest it.
  const world = makeReleaseWorld();
  const file = path.join(tempDir("capture-only"), "build-inputs.json");
  const captureOnly = generator.captureBuildInputs(world.release, world.env);
  assert.equal(captureOnly.built, undefined, "capture alone must not claim a build happened");
  fs.writeFileSync(file, JSON.stringify(captureOnly, null, 2) + "\n");
  assert.throws(() => generate(world, { buildInputsFile: file }), (error) => {
    assert.match(error.message, /not produced by a build run/);
    assert.match(error.message, /--run-build/, "the message must name the flag that produces a valid one");
    return true;
  });
  // And a forged flag is the trust boundary being relied on, not a hole being denied: an attacker with
  // write access to the snapshot is already root on the deploy host. L3 is what constrains the artifact.
  fs.writeFileSync(file, JSON.stringify(Object.assign({}, captureOnly, { built: "yes" }), null, 2) + "\n");
  assert.throws(() => generate(world, { buildInputsFile: file }), /not produced by a build run/,
    "`built` must be exactly true, not merely truthy");
});

check("(a2) the receipt reports the SNAPSHOT and never re-reads the environment", () => {
  // The decisive property left after the drift check went away. Driven through the SHIPPED CLI with both
  // sources of truth moved underneath it -- the shared env files AND the inherited environment -- because
  // an in-process call could only prove that a seam it no longer has was not used.
  const world = makeReleaseWorld();
  const snapshot = captureInputs(world, world.env);
  fs.writeFileSync(path.join(world.release, ".env.production.local"),
    "NEXT_PUBLIC_ENABLE_HATE_CRIME=false\n");
  const out = path.join(tempDir("out"), "RELEASE_RECEIPT.json");
  const env = { NEXT_PUBLIC_ENABLE_HATE_CRIME: "false" };
  for (const name of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "ComSpec"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const run = spawnSync(process.execPath, [
    path.join(world.release, "scripts", "generate-release-receipt.js"),
    "--release", world.release, "--repo", world.repo, "--sha", world.sha, "--branch", "dev",
    "--built-at-start", "2026-08-25T00:00:00+00:00", "--build-inputs", snapshot, "--out", out
  ], { encoding: "utf8", env });
  assert.equal(run.status, 0, `generation must succeed: ${run.stdout}\n${run.stderr}`);

  const receipt = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(receipt.build_inputs.present.NEXT_PUBLIC_ENABLE_HATE_CRIME, "true",
    "the value the build compiled against, not the one both sources moved to afterwards");
  assert.deepEqual(receipt.build_inputs.present,
    JSON.parse(fs.readFileSync(snapshot, "utf8")).present,
    "the receipt's inputs must be the snapshot's inputs exactly");

  // And the seam is gone, not merely unused: buildReceipt accepts no environment to substitute.
  assert.doesNotMatch(
    fs.readFileSync(path.join(REPO, "scripts", "generate-release-receipt.js"), "utf8")
      .split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n"),
    /buildInputsFile, env \}/, "buildReceipt must not destructure an env seam");
});

check("(b) an inherited NEXT_PUBLIC_ override is captured, not the file value", () => {
  const world = makeReleaseWorld({ envFile: "NEXT_PUBLIC_ENABLE_HATE_CRIME=false\n" });
  // Next gives the process environment precedence over .env, so the inherited value is what builds.
  const captured = generator.captureBuildInputs(world.release, { NEXT_PUBLIC_ENABLE_HATE_CRIME: "true" });
  assert.equal(captured.present.NEXT_PUBLIC_ENABLE_HATE_CRIME, "true",
    "the inherited value wins -- the earlier implementation read only the files and could not see it");
});

check("(c) an UNDECLARED inherited NEXT_PUBLIC_ name blocks the build", () => {
  const world = makeReleaseWorld();
  assert.throws(
    () => generator.captureBuildInputs(world.release, {
      NEXT_PUBLIC_ENABLE_HATE_CRIME: "true",
      NEXT_PUBLIC_SNEAKED_IN_VIA_ENV: "1"
    }),
    (error) => {
      assert.match(error.message, /closed set/);
      assert.match(error.message, /NEXT_PUBLIC_SNEAKED_IN_VIA_ENV/);
      assert.match(error.message, /would be consumed by the build/);
      return true;
    }
  );
});

check("(d1) production env precedence matches @next/env EXACTLY, including .env.production*", () => {
  // A hand-written parser read only .env and .env.local. Next also loads .env.production.local and
  // .env.production for a production build, and the real order is
  // .env.production.local > .env.local > .env.production > .env, with the inherited environment above
  // all of them. This asserts against the loader's own answer, not against a belief about it.
  const world = makeReleaseWorld({ envFile: "NEXT_PUBLIC_BASE_URL=from-dot-env\nNEXT_PUBLIC_ENABLE_HATE_CRIME=false\n" });
  fs.writeFileSync(path.join(world.release, ".env.production"), "NEXT_PUBLIC_BASE_URL=from-dot-env-production\n");
  fs.writeFileSync(path.join(world.release, ".env.local"), "NEXT_PUBLIC_BASE_URL=from-dot-env-local\n");
  fs.writeFileSync(path.join(world.release, ".env.production.local"), "NEXT_PUBLIC_ENABLE_HATE_CRIME=true\n");

  const captured = generator.captureBuildInputs(world.release, {});
  assert.equal(captured.present.NEXT_PUBLIC_BASE_URL, "from-dot-env-local",
    ".env.local outranks .env.production, which outranks .env");
  assert.equal(captured.present.NEXT_PUBLIC_ENABLE_HATE_CRIME, "true",
    ".env.production.local outranks everything below it");

  // Cross-check against @next/env directly, so this asserts agreement rather than a remembered order.
  const { loadEnvConfig } = require(require.resolve("@next/env", { paths: [world.release] }));
  const silent = { info() {}, error() {}, warn() {} };
  const loaded = loadEnvConfig(world.release, false, silent, true);
  for (const [name, value] of Object.entries(captured.present)) {
    assert.equal(value, loaded.combinedEnv[name], `${name} must match the loader's own result`);
  }
});

check("(d2) ${VAR:-default} resolves as Next resolves it, not to the empty string", () => {
  const world = makeReleaseWorld({
    envFile: "PRIVATE_HOST=nibrsai.com\nNEXT_PUBLIC_BASE_URL=${MISSING_HOST:-https://fallback.example}\n"
  });
  const captured = generator.captureBuildInputs(world.release, {});
  assert.equal(captured.present.NEXT_PUBLIC_BASE_URL, "https://fallback.example",
    "the reimplementation resolved this to \"\" -- a value the build would never have used");
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE_HOST/, "the helper variable's name is not recorded");
});

check("(d) env-file precedence and $VAR expansion match what the build would resolve", () => {
  // .env.local overrides .env; $VAR expands, including through a NON-public variable; single quotes
  // are literal. The non-public variable is used for resolution and never recorded.
  const world = makeReleaseWorld({
    envFile: "NEXT_PUBLIC_BASE_URL=http://from-dot-env\nNEXT_PUBLIC_ENABLE_HATE_CRIME=false\n"
  });
  fs.writeFileSync(path.join(world.release, ".env.local"),
    "PRIVATE_HOST=nibrsai.com\n" +
    "NEXT_PUBLIC_BASE_URL=\"https://${PRIVATE_HOST}/app\"\n" +
    "NEXT_PUBLIC_ENABLE_HATE_CRIME='true'\n");

  const captured = generator.captureBuildInputs(world.release, {});
  assert.equal(captured.present.NEXT_PUBLIC_BASE_URL, "https://nibrsai.com/app",
    ".env.local must win over .env, and ${VAR} must expand through a non-public variable");
  assert.equal(captured.present.NEXT_PUBLIC_ENABLE_HATE_CRIME, "true", "single quotes are literal");
  assert.deepEqual(Object.keys(captured.present).sort(), ["NEXT_PUBLIC_BASE_URL", "NEXT_PUBLIC_ENABLE_HATE_CRIME"]);
  const serialized = JSON.stringify(captured);
  assert.doesNotMatch(serialized, /PRIVATE_HOST/, "the helper variable's NAME must not be recorded");
});

check("the wrapper hands the captured value to the BUILD PROCESS, byte-exactly", () => {
  // The decisive regression for real deploy-path input binding. Two earlier shapes were wrong in the
  // same place: reading env files after the build (the receipt could describe what the build never saw),
  // then marshalling values out through bash command substitution (which strips trailing newlines, so a
  // value ending in a newline reached `next build` shortened while the receipt recorded the original).
  // Now one process loads Next's environment, captures it, and launches the build from that same
  // environment -- so this drives the SHIPPED wrapper and reads what the build actually received.
  const value = "https://x.example\n\n";
  const world = makeReleaseWorld({
    envFile: 'NEXT_PUBLIC_BASE_URL="https://x.example\n\n"\n',
    mutate: (release) => {
      // A stand-in for `next build` that records exactly what it inherited. `next build` itself is not
      // needed to prove the binding, and would make this test depend on a full toolchain.
      fs.writeFileSync(path.join(release, "record-build-env.js"),
        'const fs = require("node:fs");\n' +
        'fs.writeFileSync(process.env.RECORD_TO, JSON.stringify({\n' +
        '  base: process.env.NEXT_PUBLIC_BASE_URL,\n' +
        '  hc: process.env.NEXT_PUBLIC_ENABLE_HATE_CRIME,\n' +
        '  cwd: process.cwd()\n' +
        '}));\n');
      fs.writeFileSync(path.join(release, "package.json"), JSON.stringify({
        name: "synthetic", dependencies: { next: "16.1.6" },
        scripts: { build: "node record-build-env.js" }
      }, null, 2) + "\n");
    }
  });

  const dir = tempDir("runbuild");
  const snapshot = path.join(dir, "snapshot.json");
  const recorded = path.join(dir, "build-env.json");
  const env = { RECORD_TO: recorded };
  for (const name of ["PATH", "Path", "SystemRoot", "APPDATA", "TEMP", "TMP", "HOME", "USERPROFILE", "ComSpec"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const run = spawnSync(process.execPath, [
    path.join(world.release, "scripts", "generate-release-receipt.js"),
    "--release", world.release, "--capture-build-inputs", snapshot, "--run-build", "true"
  ], { encoding: "utf8", env });
  assert.equal(run.status, 0, `the wrapper must run the build: ${run.stdout}\n${run.stderr}`);

  const seen = JSON.parse(fs.readFileSync(recorded, "utf8"));
  assert.equal(seen.base, value, "the build inherited both trailing newlines -- no serialization step");
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(world.release), "the build ran in the release");

  // And the snapshot the receipt is built from is the same process's record of the same values.
  const snap = JSON.parse(fs.readFileSync(snapshot, "utf8"));
  assert.equal(snap.built, true, "only a snapshot written by the build run may back a receipt");
  assert.equal(snap.present.NEXT_PUBLIC_BASE_URL, seen.base,
    "receipt source and the build's actual environment must carry the same bytes");

  // Names only in the log: a public value may be multiline, and a multiline value can forge log lines.
  assert.match(run.stdout, /build inputs bound before the build: NEXT_PUBLIC_BASE_URL/);
  assert.doesNotMatch(run.stdout, /x\.example/, "no VALUE is ever logged, public or not");
});

check("both input paths produce the SAME snapshot, and share one closed-set gate", () => {
  // Two ways of resolving the effective inputs exist for a real reason: the build must INHERIT the
  // environment, so runBuild loads it into this process; inspection must not, so captureBuildInputs uses
  // a hermetic child. If each also owned its refusal and its record shape, one could stop refusing while
  // every test stayed green. This drives both against the same release and compares the results.
  const world = makeReleaseWorld({
    envFile: 'NEXT_PUBLIC_BASE_URL="https://x.example/app"\n',
    mutate: (release) => {
      fs.writeFileSync(path.join(release, "package.json"), JSON.stringify({
        name: "synthetic", dependencies: { next: "16.1.6" },
        scripts: { build: "node -e \"0\"" }
      }, null, 2) + "\n");
    }
  });
  const dir = tempDir("bothpaths");
  const snapshot = path.join(dir, "snapshot.json");
  const env = { NEXT_PUBLIC_ENABLE_HATE_CRIME: "true" };
  for (const name of ["PATH", "Path", "SystemRoot", "APPDATA", "TEMP", "TMP", "HOME", "USERPROFILE", "ComSpec"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const run = spawnSync(process.execPath, [
    path.join(world.release, "scripts", "generate-release-receipt.js"),
    "--release", world.release, "--capture-build-inputs", snapshot, "--run-build", "true"
  ], { encoding: "utf8", env });
  assert.equal(run.status, 0, `the build path must succeed: ${run.stdout}${run.stderr}`);

  const fromBuild = JSON.parse(fs.readFileSync(snapshot, "utf8"));
  const fromInspection = generator.captureBuildInputs(world.release, { NEXT_PUBLIC_ENABLE_HATE_CRIME: "true" });
  assert.equal(fromBuild.built, true, "only the build path records `built`");
  assert.equal(fromInspection.built, undefined, "and inspection must never claim it");
  delete fromBuild.built;
  assert.deepEqual(fromBuild, fromInspection, "otherwise the two paths must agree exactly");

  // And the gate refuses an undeclared name on BOTH paths, with the same message.
  const undeclared = Object.assign({}, env, { NEXT_PUBLIC_SNEAKED_IN_VIA_ENV: "1" });
  const refusedBuild = spawnSync(process.execPath, [
    path.join(world.release, "scripts", "generate-release-receipt.js"),
    "--release", world.release, "--capture-build-inputs", path.join(dir, "never.json"), "--run-build", "true"
  ], { encoding: "utf8", env: undeclared });
  assert.notEqual(refusedBuild.status, 0, "the build path must refuse an undeclared public name");
  assert.match(refusedBuild.stderr, /closed set/);
  assert.match(refusedBuild.stderr, /NEXT_PUBLIC_SNEAKED_IN_VIA_ENV/);
  assert.ok(!fs.existsSync(path.join(dir, "never.json")),
    "and refuse BEFORE building, leaving no snapshot behind");
  assert.throws(
    () => generator.captureBuildInputs(world.release, {
      NEXT_PUBLIC_ENABLE_HATE_CRIME: "true", NEXT_PUBLIC_SNEAKED_IN_VIA_ENV: "1"
    }),
    /closed set/, "and inspection must refuse it identically");
});

check("a failing build is recorded as NOT built, so no receipt can be generated from it", () => {
  const world = makeReleaseWorld({
    mutate: (release) => {
      fs.writeFileSync(path.join(release, "package.json"), JSON.stringify({
        name: "synthetic", dependencies: { next: "16.1.6" },
        scripts: { build: "node -e \"process.exit(3)\"" }
      }, null, 2) + "\n");
    }
  });
  const dir = tempDir("failbuild");
  const snapshot = path.join(dir, "snapshot.json");
  const env = {};
  for (const name of ["PATH", "Path", "SystemRoot", "APPDATA", "TEMP", "TMP", "HOME", "USERPROFILE", "ComSpec"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.NEXT_PUBLIC_ENABLE_HATE_CRIME = "true";
  const run = spawnSync(process.execPath, [
    path.join(world.release, "scripts", "generate-release-receipt.js"),
    "--release", world.release, "--capture-build-inputs", snapshot, "--run-build", "true"
  ], { encoding: "utf8", env });
  assert.notEqual(run.status, 0, "the wrapper must propagate the build's failure");
  const snap = JSON.parse(fs.readFileSync(snapshot, "utf8"));
  assert.equal(snap.built, false, "a failed build must not leave a snapshot that looks buildable");
  const file = path.join(dir, "copy.json");
  fs.writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");
  assert.throws(() => generate(world, { buildInputsFile: file }), /not produced by a build run/);
});

check("the deploy captures and builds in ONE step, with no transport and no drift assertion", () => {
  const deploy = fs.readFileSync(path.join(REPO, "scripts", "deploy-zero-downtime.sh"), "utf8");
  const code = deploy.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");

  // Exactly one invocation, and it both captures and builds. Two invocations would reintroduce the
  // window between capture and build that the whole correction exists to close.
  const capture = [...code.matchAll(/--capture-build-inputs "\$BUILD_INPUTS_SNAPSHOT" --run-build true/g)];
  assert.equal(capture.length, 1, "one invocation must both capture and build");
  assert.equal([...code.matchAll(/--capture-build-inputs/g)].length, 1, "and it is the only capture");
  assert.doesNotMatch(code, /npm run build|next build/,
    "the deploy must not build on its own: the build belongs inside the wrapper that captured its inputs");

  // No marshalling of values through the shell, in any form.
  assert.doesNotMatch(code, /--capture-env-stream|BUILD_INPUTS_STREAM|BUILD_INPUT_EXPORTS/,
    "the NUL-delimited transport is gone; process.env carries the values now");
  assert.doesNotMatch(code, /read -r -d ''/, "nothing reads a value stream any more");
  assert.doesNotMatch(code, /export "\$name=/, "and nothing re-exports a captured value");
  assert.doesNotMatch(code, /changed between the build and the receipt|Build-input transport mismatch/,
    "the post-build drift assertion read back its own exports; it must not return");

  // The authoritative flag comes from the snapshot the wrapper wrote, compared inside node so command
  // substitution cannot turn "true\n" into an accepted "true".
  assert.match(code, /HC_FLAG=\$\(node -e '/, "the effective flag must be re-derived from the snapshot");
  assert.match(code, /not-exactly-true-or-false/, "any third answer must fail the comparison");
  const derive = code.indexOf("HC_FLAG=$(node -e '");
  assert.ok(derive > capture[0].index, "it is derived AFTER the build, from what the build compiled against");

  // Cleanup on EVERY path, including die, an unexpected error and a signal.
  assert.match(code, /trap 'rm -f "\$BUILD_INPUTS_SNAPSHOT"' EXIT/,
    "an EXIT trap must own removal, not a hand-written rm on each failure branch");
  const traps = [...code.matchAll(/trap '[^']*' EXIT/g)];
  assert.equal(traps.length, 1, "exactly one EXIT trap, so a later one cannot silently replace it");
  assert.equal([...code.matchAll(/rm -f "\$BUILD_INPUTS/g)].length, 1, "the trap is the only remover");
});

check("the receipt is built from the SNAPSHOT, and refuses to run without one", () => {
  const world = makeReleaseWorld();
  assert.throws(() => generator.buildReceipt({
    releaseDir: world.release, repoDir: world.repo, sha: world.sha, branch: "dev",
    builtAtStart: "2026-08-25T00:00:00+00:00", env: world.env
  }), /no build-input snapshot given/);
});

// ---------------------------------------------------------------------------
// bootstrap composition
// ---------------------------------------------------------------------------

check("BOOTSTRAP: the generator and verifier run FROM THE EXPORTED RELEASE, not this checkout", () => {
  const world = makeReleaseWorld();
  // Prove the export really carries them, then execute the exported copies.
  for (const rel of TRACKED_FROM_REPO) {
    assert.ok(fs.existsSync(path.join(world.release, rel)), `${rel} must be present in the exported release`);
  }
  // The exported generator is driven exactly as the deploy drives it: capture-and-build, then receipt.
  const snapshot = path.join(tempDir("bootstrap-snap"), "build-inputs.json");
  const cap = spawnSync(process.execPath, [
    path.join(world.release, "scripts", "generate-release-receipt.js"),
    "--release", world.release, "--capture-build-inputs", snapshot, "--run-build", "true"
  ], { encoding: "utf8", env: Object.assign({}, process.env, world.env) });
  assert.equal(cap.status, 0, `the exported capture-and-build step must run: ${cap.stdout}${cap.stderr}`);
  assert.ok(fs.existsSync(snapshot), "it must write the snapshot the receipt is built from");

  const gen = spawnSync(process.execPath, [
    path.join(world.release, "scripts", "generate-release-receipt.js"),
    "--release", world.release, "--repo", world.repo, "--sha", world.sha, "--branch", "dev",
    "--built-at-start", "2026-08-25T00:00:00+00:00", "--build-inputs", snapshot
  ], { encoding: "utf8", env: Object.assign({}, process.env, world.env) });
  assert.equal(gen.status, 0, `the exported generator must run: ${gen.stderr}`);
  assert.ok(fs.existsSync(path.join(world.release, "RELEASE_RECEIPT.json")), "it must write the receipt");

  const ver = spawnSync(process.execPath, [
    path.join(world.release, "scripts", "verify-deployed-artifact.js"),
    "--release", world.release, "--repo", world.repo, "--stage", "pre-switch"
  ], { encoding: "utf8" });
  assert.equal(ver.status, 0, `pre-switch verification must pass: ${ver.stdout}${ver.stderr}`);
  assert.match(ver.stdout, /L2\s+PASS/);
  assert.match(ver.stdout, /L3\s+PASS/);

  // And the deploy must be wired that way, not to $SCRIPT_DIR.
  //
  // EVERY invocation is checked, not just the first. There are two generator calls -- the combined
  // capture-and-build step and the receipt -- and an earlier version of this assertion matched the file
  // anywhere, so repointing only the capture at $SCRIPT_DIR left it green. A mutation found that.
  const deploy = fs.readFileSync(path.join(REPO, "scripts", "deploy-zero-downtime.sh"), "utf8");
  const code = deploy.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  const generatorCalls = [...code.matchAll(/node "([^"]*)\/scripts\/generate-release-receipt\.js"/g)].map((mm) => mm[1]);
  const verifierCalls = [...code.matchAll(/node "([^"]*)\/scripts\/verify-deployed-artifact\.js"/g)].map((mm) => mm[1]);
  assert.equal(generatorCalls.length, 2, "two generator invocations: capture-and-build, then the receipt");
  assert.ok(verifierCalls.length >= 1, "and at least one verifier invocation");
  for (const base of [...generatorCalls, ...verifierCalls]) {
    assert.ok(
      base === "$RELEASE_DIR" || base === "$CURRENT_LINK",
      `every P1.4c invocation must run from the exported release, not ${base}`
    );
  }
  assert.doesNotMatch(code, /\$SCRIPT_DIR\/(scripts\/)?(generate-release-receipt|verify-deployed-artifact)/,
    "neither may be run from the operations checkout");
});

check("the deploy generates the receipt after the build and before publication", () => {
  const deploy = fs.readFileSync(path.join(REPO, "scripts", "deploy-zero-downtime.sh"), "utf8");
  const code = deploy.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
  // The build IS the wrapper invocation now -- capture and build are one step, so there is no longer a
  // separate `npm run build` line in the deploy to order against. Two generator invocations exist: the
  // capture-and-build one, and the receipt one, identified by --build-inputs rather than by position.
  const build = code.indexOf("--run-build true");
  const gen = code.indexOf("--build-inputs \"$BUILD_INPUTS_SNAPSHOT\"");
  assert.ok(build > 0, "the deploy must build through the wrapper that captured the inputs");
  assert.ok(gen !== build, "the receipt invocation is a different one from the build invocation");
  const gate = code.indexOf("release_export_unexplained");
  const pre = code.indexOf("--stage pre-switch");
  const swap = code.indexOf("mv -Tf");
  assert.ok(build > 0 && gen > build, "the receipt can only be generated after the build");
  assert.ok(gen < gate, "the closed-set gate must see the receipt, or it would refuse to publish it");
  assert.ok(pre > gen && pre < swap, "pre-switch verification runs between generation and publication");
  assert.ok(swap > pre, "publication is last");
});

// ---------------------------------------------------------------------------

for (const d of temps) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* a temp directory that resists removal must not fail the suite */ }
}

console.log("");
console.log(`release receipt: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED ${f.name}: ${f.message}`);
  process.exit(1);
}
