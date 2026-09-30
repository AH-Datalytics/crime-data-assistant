/**
 * Verify that the bytes running in production are the bytes that were published, and say exactly how
 * much that establishes.
 *
 * SIX LINKS, reported independently, each `pass | fail | unverified` -- never collapsed:
 *
 *   L1  a qualifying hosted canonical-harness run exists for the deployed SHA
 *   L2  the release's tracked content is exactly the commit tree (sub-results: tracked_content, closed_extras)
 *   L3  the artifact and dependencies are the bytes the receipt recorded at publication
 *   L4  the active symlink resolves to the receipted release
 *   L5  every live worker loaded that release's code
 *   L6  certified/build/runtime toolchains satisfy the declared alignment contract
 *       (half A: versions across platforms; half B: the exact Linux executable)
 *
 *   artifact_identity_verified  =  L2 & L3 & L4 & L5
 *   release_identity_verified   =  L1 & L2 & L3 & L4 & L5 & L6
 *
 * A `fail` dominates an `unverified`; both dominate `pass`.
 *
 * WHAT THIS DOES NOT READ. No .env line, no database byte, no log, and no `pm2 jlist` / `pm2 env` /
 * `pm2 describe` output -- those embed the process environment, which holds secrets. Worker identity
 * comes from `pm2 pid` (integers), `pm2 list` (a status table) and /proc. Symlinks are recorded by
 * target text and never followed.
 *
 * TRUST BOUNDARY, stated because everything here is worthless if read as more: an unsigned receipt
 * sitting beside the artifact it describes proves INTERNAL CONSISTENCY under a trusted-deployer and
 * trusted-root assumption. It detects accidental divergence -- a stale worker, a partial reload, a
 * hand-edited file, a rebuild that did not match its source, a swapped native module, an interpreter
 * that changed underneath a running process. It does not protect against an actor who can write both
 * the artifact and the receipt, which is the actor with root, which is the actor who deploys. Signing
 * or an external anchor is later hardening and is not delivered here.
 *
 * Usage:
 *   node scripts/verify-deployed-artifact.js --release <dir> [--repo <dir>] [--current <symlink>]
 *        [--pids 1,2,3] [--json <file>] [--stage pre-switch|post-reload|adhoc]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const manifest = require("./lib/artifact-manifest.js");
const toolchain = require("./lib/toolchain-identity.js");
const receiptModule = require("./generate-release-receipt.js");

const PASS = "pass";
const FAIL = "fail";
const UNVERIFIED = "unverified";

const CI_REFUSAL =
  "This run did NOT verify that the deployed commit passed hosted CI. It must not be described as " +
  '"verified against CI".';
const TOOLCHAIN_REFUSAL =
  "This run did NOT verify toolchain alignment. The interpreter that certified this commit is not " +
  "proven to be the interpreter that built or runs it.";

function worst(states) {
  if (states.includes(FAIL)) return FAIL;
  if (states.includes(UNVERIFIED)) return UNVERIFIED;
  return PASS;
}

function link(id, state, findings, extra) {
  return Object.assign({ id, state, findings: findings || [] }, extra || {});
}

// ---------------------------------------------------------------------------

function gitOk(repoDir) {
  if (!repoDir) return false;
  const r = spawnSync("git", ["--no-optional-locks", "-C", repoDir, "rev-parse", "--git-dir"], { encoding: "utf8" });
  return r.status === 0;
}

function git(repoDir, args) {
  return execFileSync("git", ["--no-optional-locks", "-C", repoDir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  }).trim();
}

/**
 * L1. Unprovable from this machine today: the repository is private, and the VPS authenticates to
 * GitHub with an SSH deploy key, which is a git-transport credential carrying no REST or GraphQL
 * authorization. The chosen route is pull requests plus a required hosted check on the branch, at
 * which point "this SHA is an ancestor of origin/<branch>" becomes the evidence -- and that assertion
 * already runs in the deploy, needing no credential. Until that policy exists this is `unverified`,
 * and it is never inferred from anything else.
 */
function checkL1(receipt) {
  return link("L1", UNVERIFIED, [
    "no qualifying-run evidence is available offline: the repository is private and the deploy key " +
    "carries no API authorization",
    "planned route: pull requests plus a required hosted check, making ancestry of origin/" +
    (receipt ? receipt.branch : "<branch>") + " the evidence"
  ], { proposition: "a qualifying hosted canonical-harness run exists for the deployed SHA" });
}

/**
 * Locate a POSIX bash. On Linux -- the only platform this verifier runs on in production -- that is
 * simply `bash`. On Windows a bare `bash` resolves to the WSL launcher, which is usually absent, so
 * Git Bash is located explicitly from git.exe.
 */
function resolveBash() {
  if (process.platform !== "win32") return "bash";
  const candidates = [];
  try {
    for (const g of execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const dir = path.dirname(g);
      for (const root of [path.resolve(dir, ".."), path.resolve(dir, "..", "..")]) {
        candidates.push(path.join(root, "bin", "bash.exe"));
      }
    }
  } catch {
    /* `where` missing or git absent; fall through to the fixed locations */
  }
  // Literal fallbacks rather than %ProgramFiles%: this verifier must consult NO environment variable
  // at all, so that nothing in the environment can influence what it concludes. `where git` above
  // already covers a non-standard install location, which is the case the variable would have served.
  candidates.push(
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe"
  );
  return candidates.find((c) => {
    try {
      return fs.existsSync(c);
    } catch {
      return false;
    }
  }) || null;
}

/** C:\x -> /c/x for Git Bash; identity on POSIX. */
function toBashPath(value) {
  if (process.platform !== "win32") return value;
  return String(value).replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_m, d) => `/${d.toLowerCase()}/`);
}

// The helper is sourced and called with POSITIONAL PARAMETERS -- no path is interpolated into the
// script text, so a release directory containing a quote or a space cannot change what runs.
const EXTRAS_SCRIPT = 'set -uo pipefail\n. "$1"\nrelease_export_unexplained "$2" "$3" "$4" "$5"\n';

/**
 * Recompute the closed-extras property by running the SHIPPED P1.4a implementation from the exported
 * release, rather than reimplementing its walker here. A second implementation in JavaScript would be
 * a copy that could drift from the one the deploy gates on -- the same reason the helper was extracted
 * from the deploy in the first place.
 *
 * exit 0                              -> pass
 * named unexplained/wrong-type lines  -> fail
 * missing bash, helper or policy, or any other execution failure -> unverified
 */
function recomputeClosedExtras(releaseDir, repoDir, sha) {
  const helper = path.join(releaseDir, "scripts", "lib", "release-export.sh");
  const allowed = path.join(releaseDir, "scripts", "fixtures", "release-allowed-extras.json");
  for (const [label, file] of [["helper", helper], ["allowlist", allowed]]) {
    if (!fs.existsSync(file)) {
      return { state: UNVERIFIED, findings: [`closed_extras unverified: the exported release has no ${label} at ${file}`] };
    }
  }
  const bash = resolveBash();
  if (!bash) {
    return { state: UNVERIFIED, findings: ["closed_extras unverified: no POSIX bash is available to run the shipped helper"] };
  }

  const result = spawnSync(bash, [
    "-c", EXTRAS_SCRIPT, "release-export",
    toBashPath(helper), toBashPath(repoDir), sha, toBashPath(releaseDir), toBashPath(allowed)
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  if (result.error) {
    return { state: UNVERIFIED, findings: [`closed_extras unverified: could not run the helper (${result.error.code || result.error.message})`] };
  }
  const named = (result.stdout || "").split(/\r?\n/).filter((l) => /^(unexplained|wrong-type) /.test(l.trim()));
  if (result.status === 0) {
    return { state: PASS, findings: [] };
  }
  if (named.length) {
    return { state: FAIL, findings: named.map((l) => `closed_extras: ${l.trim()}`) };
  }
  const why = (result.stderr || "").split(/\r?\n/).filter(Boolean).slice(0, 3);
  return {
    state: UNVERIFIED,
    findings: [`closed_extras unverified: the helper exited ${result.status} without naming a path`, ...why]
  };
}

/** L2, with sub-results preserved: the combined link is the conjunction. */
function checkL2(releaseDir, repoDir, receipt) {
  if (!receipt) return link("L2", UNVERIFIED, ["no receipt: nothing names the commit this release should match"]);
  if (!gitOk(repoDir)) {
    return link("L2", UNVERIFIED, [
      `no readable git object store at ${repoDir || "(none given)"}; the commit tree cannot be consulted`
    ], { tracked_content: UNVERIFIED, closed_extras: UNVERIFIED });
  }
  let tracked;
  try {
    tracked = git(repoDir, ["ls-tree", "-r", "--format=%(objectname)%x09%(path)", receipt.commit]).split("\n").filter(Boolean);
  } catch {
    return link("L2", UNVERIFIED, [`commit ${receipt.commit} is not in the object store (garbage-collected or never fetched)`],
      { tracked_content: UNVERIFIED, closed_extras: UNVERIFIED });
  }

  const findings = [];
  let differ = 0;
  let missing = 0;
  for (const line of tracked) {
    const [oid, rel] = line.split("\t");
    const full = path.join(releaseDir, rel);
    if (!fs.existsSync(full)) {
      missing += 1;
      if (findings.length < 20) findings.push(`missing ${rel}`);
      continue;
    }
    const got = execFileSync("git", ["hash-object", "--no-filters", "--", rel], { cwd: releaseDir, encoding: "utf8" }).trim();
    if (got !== oid) {
      differ += 1;
      if (findings.length < 20) findings.push(`differs ${rel} expected=${oid} actual=${got}`);
    }
  }
  const trackedState = missing || differ ? FAIL : PASS;

  // closed_extras is RECOMPUTED, not read from the receipt.
  //
  // It used to be inferred from the receipt's tracked-blob verdict, which was a false pass twice over:
  // that field measures only per-path blob equality and says nothing about unexplained content, and
  // the receipt is generated BEFORE the closed-set gate runs, so it cannot record that gate's outcome
  // even in principle. A release could carry a stray file and pass.
  const extras = recomputeClosedExtras(releaseDir, repoDir, receipt.commit);
  findings.push(...extras.findings);

  return link("L2", worst([trackedState, extras.state]), findings, {
    tracked_content: trackedState,
    closed_extras: extras.state,
    tracked_paths: tracked.length,
    differ,
    missing
  });
}

/**
 * L3. The policy is loaded FROM THE RELEASE, and its authority comes from L2 having proven that blob
 * equal to the commit tree -- not from the file sitting there. If L2 could not be established, the
 * policy's provenance is unverified too, and this reports that rather than trusting the file. There
 * are no built-in exclusions to fall back on, deliberately.
 */
function checkL3(releaseDir, receipt, l2) {
  if (!receipt) return link("L3", UNVERIFIED, ["no receipt: nothing records what the artifact should be"]);

  const policyPath = path.join(releaseDir, "scripts", "fixtures", "artifact-manifest-policy.json");
  let policy;
  try {
    policy = manifest.loadPolicy(policyPath);
  } catch (error) {
    return link("L3", UNVERIFIED, [`manifest policy unusable: ${error.message}`, "no default exclusions exist; refusing to guess"]);
  }

  const findings = [];
  let provenance = PASS;
  if (l2.state !== PASS) {
    provenance = UNVERIFIED;
    findings.push(`policy provenance ${UNVERIFIED}: L2 is ${l2.state}, so this policy blob is not proven to be the commit's`);
  }

  // A receipt may RECORD exclusions; it may never DEFINE them. Exact equality both ways.
  const fromPolicy = manifest.exclusionList(policy);
  const fromReceipt = Array.isArray(receipt.manifest_exclusions) ? [...receipt.manifest_exclusions].sort() : null;
  if (!fromReceipt) {
    findings.push("the receipt records no exclusion list");
    return link("L3", FAIL, findings, { policy_provenance: provenance });
  }
  const extra = fromReceipt.filter((e) => !fromPolicy.includes(e));
  const absent = fromPolicy.filter((e) => !fromReceipt.includes(e));
  if (extra.length) findings.push(`the receipt claims exclusions the committed policy does not contain: ${extra.join(", ")}`);
  if (absent.length) findings.push(`the receipt omits exclusions the committed policy requires: ${absent.join(", ")}`);
  if (receipt.manifest_policy_digest !== policy.digest) {
    findings.push(`policy digest mismatch: receipt ${receipt.manifest_policy_digest.slice(0, 16)}… vs release ${policy.digest.slice(0, 16)}…`);
  }
  if (extra.length || absent.length || receipt.manifest_policy_digest !== policy.digest) {
    return link("L3", FAIL, findings, { policy_provenance: provenance });
  }

  if (receipt.manifest_algorithm !== manifest.MANIFEST_ALGORITHM) {
    findings.push(`receipt manifest_algorithm ${receipt.manifest_algorithm} is not ${manifest.MANIFEST_ALGORITHM}`);
    return link("L3", UNVERIFIED, findings, { policy_provenance: provenance });
  }

  const records = manifest.walkRelease(releaseDir, policy);
  // The record count is compared EXPLICITLY, not left as a diagnostic the digest is assumed to cover.
  // A count that disagrees while the digest matches would mean the encoding is ambiguous -- exactly the
  // defect that made v1 of the manifest algorithm collide two different trees onto one digest.
  if (Number.isInteger(receipt.manifest_record_count) && receipt.manifest_record_count !== records.length) {
    findings.push(`manifest record count ${records.length} != receipt ${receipt.manifest_record_count}`);
    return link("L3", FAIL, findings, { policy_provenance: provenance, records: records.length });
  }
  const digest = manifest.digestRecords(records);
  if (digest !== receipt.manifest_digest) {
    findings.push(`manifest digest ${digest.slice(0, 16)}… != receipt ${receipt.manifest_digest.slice(0, 16)}…`);
    findings.push(`records now ${records.length}, receipt recorded ${receipt.manifest_record_count}`);
    return link("L3", FAIL, findings, { policy_provenance: provenance, records: records.length });
  }

  return link("L3", provenance === PASS ? PASS : UNVERIFIED, findings, {
    policy_provenance: provenance,
    records: records.length,
    digest,
    // The digested surface, handed to L5 so "inside the release" cannot mean "inside the release but
    // never covered by the receipt".
    digested_paths: new Set(records.map((r) => r.path))
  });
}

/** L4: the active symlink resolves inside releases/ and to the receipted release. */
function checkL4(currentLink, receipt) {
  if (!currentLink) return link("L4", UNVERIFIED, ["no --current symlink given; publication was not inspected"]);
  if (!receipt) return link("L4", UNVERIFIED, ["no receipt to compare the resolved target against"]);
  let resolved;
  try {
    resolved = fs.realpathSync(currentLink);
  } catch (error) {
    return link("L4", FAIL, [`${currentLink} does not resolve: ${error.code || error.message}`]);
  }
  const findings = [];
  const releasesDir = path.dirname(receipt.release_path);
  if (path.dirname(resolved) !== releasesDir) {
    findings.push(`resolves outside the releases directory: ${resolved} (expected under ${releasesDir})`);
  }
  if (path.basename(resolved) !== receipt.release) {
    findings.push(`resolves to ${path.basename(resolved)}, receipt names ${receipt.release}`);
  }
  if (resolved !== receipt.release_path) {
    findings.push(`resolved path ${resolved} != receipt release_path ${receipt.release_path}`);
  }
  return link("L4", findings.length ? FAIL : PASS, findings, { resolved });
}

/** PM2 worker pids. `pm2 pid <app>` prints integers; jlist/describe/env are never used. */
function readWorkerPids(app) {
  const r = spawnSync(process.platform === "win32" ? "pm2.cmd" : "pm2", ["pid", app], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
}

/**
 * L5. Two independent primitives, neither of which reads the symlink or any mutable receipt per
 * request: /proc/<pid>/cwd, which the kernel resolved at chdir time and does not re-follow, and the
 * absolute paths of natively mapped code in /proc/<pid>/maps, which is loaded code rather than a
 * claim. Disagreement between workers is reported PER PID, because a partial reload is a split, not a
 * global failure.
 */
/**
 * Decode the escapes the kernel writes into a /proc/<pid>/maps pathname.
 *
 * `seq_path` passes `mangle_path` an escape set of exactly space, tab, newline and backslash, so ONLY
 * `\040`, `\011`, `\012` and `\134` can appear. Decoding every `\ooo` triple was over-eager and
 * actively wrong: a path containing a literal backslash followed by three octal digits -- for example
 * a Windows-shaped `…\releases\20260825_000000` -- had `\202` eaten, turning the path into one the
 * filesystem never held and reporting it as mapped from outside the release.
 */
const MAPS_ESCAPES = { "011": "\t", "012": "\n", "040": " ", "134": "\\" };

function decodeMapsPath(value) {
  return value.replace(/\\(011|012|040|134)/g, (_m, octal) => MAPS_ESCAPES[octal]);
}

/**
 * Native `.node` mappings from /proc/<pid>/maps, parsed LINE BY LINE.
 *
 * A whole-file regex could not distinguish `/path/mod.node` from `/path/mod.node (deleted)` and
 * reported the second as though it were the first. The pathname is the sixth field and may itself
 * contain spaces, so it is taken as "everything after the inode" rather than by splitting on
 * whitespace.
 */
function parseNativeMappings(maps) {
  const out = [];
  const seen = new Set();
  for (const line of String(maps).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^[0-9a-fA-F]+-[0-9a-fA-F]+\s+\S{4}\s+[0-9a-fA-F]+\s+\S+\s+\d+\s+(.+)$/);
    if (!m) continue;
    let pathname = m[1].replace(/\s+$/, ""); // trailing only; interior spaces belong to the path
    let deleted = false;
    if (pathname.endsWith(" (deleted)")) {
      deleted = true;
      pathname = pathname.slice(0, -" (deleted)".length);
    }
    pathname = decodeMapsPath(pathname);
    if (!pathname.endsWith(".node")) continue;
    const key = `${pathname}\u0000${deleted}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: pathname, deleted });
  }
  return out;
}

function checkL5(receipt, pids, readers, digestedPaths) {
  if (!receipt) return link("L5", UNVERIFIED, ["no receipt to compare workers against"]);
  // The /proc readers are injectable so the per-pid reporting logic -- which is where a partial reload
  // is either surfaced or lost -- can be exercised on a platform without /proc. The default readers
  // are the real ones; nothing else changes.
  const read = readers || {
    cwd: (pid) => fs.readlinkSync(`/proc/${pid}/cwd`),
    maps: (pid) => fs.readFileSync(`/proc/${pid}/maps`, "utf8")
  };
  if (!readers && process.platform !== "linux") {
    return link("L5", UNVERIFIED, [`worker inspection needs /proc; this host is ${process.platform}`]);
  }
  if (!pids || pids.length === 0) {
    return link("L5", UNVERIFIED, ["no worker pids were readable"]);
  }
  const findings = [];
  const perWorker = [];
  for (const pid of pids) {
    const entry = { pid, cwd: null, mapped_outside: [], state: PASS };
    try {
      entry.cwd = read.cwd(pid);
    } catch (error) {
      entry.state = UNVERIFIED;
      findings.push(`pid ${pid}: /proc/${pid}/cwd unreadable (${error.code || error.message})`);
    }
    if (entry.cwd && entry.cwd !== receipt.release_path) {
      entry.state = FAIL;
      findings.push(`pid ${pid}: cwd ${entry.cwd} != receipted release ${receipt.release_path}`);
    }
    // NATIVE MAPPINGS ARE THE SECOND, INDEPENDENT PROOF, and it must not be vacuous.
    //
    // The earlier version only looked for paths under the releases directory, so a worker with a
    // matching cwd and ZERO mapped release files passed -- and a native module loaded from a global
    // path such as /usr/lib was invisible, because it was not under releases/ at all. Both are now
    // handled: at least one native module must be mapped from INSIDE the receipted release, any
    // native module mapped from outside it fails wherever it lives, and every accepted inside
    // mapping must be on the surface L3 digested.
    try {
      const native = parseNativeMappings(read.maps(pid));
      entry.native_inside = [];
      entry.native_deleted = [];
      for (const mapping of native) {
        if (mapping.deleted) {
          // A DELETED mapping is an old inode the worker still holds open while a different file now
          // sits at that path. Treating the path as the on-disk file was a false pass: L3 digests the
          // REPLACEMENT and agrees with the receipt, while the worker runs the bytes that were unlinked.
          entry.native_deleted.push(mapping.path);
          entry.state = FAIL;
          findings.push(
            `pid ${pid}: native module mapped from a DELETED inode: ${mapping.path} -- the worker is ` +
            "running bytes that no longer exist on disk, so the file now at that path is not what it loaded"
          );
          continue;
        }
        if (mapping.path.startsWith(receipt.release_path + "/")) {
          entry.native_inside.push(mapping.path);
        } else {
          entry.mapped_outside.push(mapping.path);
          entry.state = FAIL;
          findings.push(`pid ${pid}: native module mapped from OUTSIDE the receipted release: ${mapping.path}`);
        }
      }
      if (entry.native_inside.length === 0) {
        if (entry.state === PASS) entry.state = UNVERIFIED;
        findings.push(
          `pid ${pid}: no native module is mapped from ${receipt.release_path}; a matching cwd alone is not ` +
          "evidence that this worker loaded this release's code"
        );
      } else if (digestedPaths) {
        // Every accepted mapping must be a file L3 actually digested, or "inside the release" would
        // include content the receipt never covered.
        for (const p of entry.native_inside) {
          const rel = p.slice(receipt.release_path.length + 1);
          if (!digestedPaths.has(rel)) {
            entry.state = FAIL;
            findings.push(`pid ${pid}: mapped native module ${rel} is not on the digested surface L3 verified`);
          }
        }
      }
    } catch (error) {
      if (entry.state === PASS) entry.state = UNVERIFIED;
      findings.push(`pid ${pid}: /proc/${pid}/maps unreadable (${error.code || error.message})`);
    }
    perWorker.push(entry);
  }
  const expected = receipt.pm2_expected_instances;
  if (Number.isInteger(expected) && pids.length !== expected) {
    findings.push(`${pids.length} worker(s) online, receipt expects ${expected}`);
    return link("L5", FAIL, findings, { workers: perWorker, expected });
  }
  const states = perWorker.map((w) => w.state);
  const split = new Set(states).size > 1;
  if (split) findings.push(`workers disagree: ${states.join(", ")} -- a partial reload, not a global result`);
  return link("L5", worst(states), findings, { workers: perWorker, expected, split });
}

/** L6, both halves reported separately. */
function checkL6(releaseDir, receipt, pids) {
  if (!receipt) return link("L6", UNVERIFIED, ["no receipt to compare toolchains against"]);
  let policy;
  try {
    policy = toolchain.loadToolchainPolicy(path.join(releaseDir, "scripts", "fixtures", "toolchain-policy.json"));
  } catch (error) {
    return link("L6", UNVERIFIED, [`toolchain policy unusable: ${error.message}`]);
  }
  const halfA = toolchain.compareVersions(policy, receipt.certified_toolchain, {
    node: receipt.build_node,
    npm: receipt.build_npm
  });
  let halfB;
  if (process.platform !== "linux") {
    halfB = { state: UNVERIFIED, findings: [`executable comparison needs /proc; this host is ${process.platform}`] };
  } else if (!pids || pids.length === 0) {
    halfB = { state: UNVERIFIED, findings: ["no worker pids were readable"] };
  } else {
    const workers = pids.map((pid) => toolchain.readWorkerToolchain(pid)).filter(Boolean);
    halfB = toolchain.compareExecutables(receipt.build_node, workers);
  }
  return link("L6", worst([halfA.state, halfB.state]), [...halfA.findings, ...halfB.findings], {
    half_a_versions: halfA,
    half_b_executables: halfB,
    declared: { node: policy.node, npm: policy.npm }
  });
}

// ---------------------------------------------------------------------------

function loadReceipt(releaseDir) {
  const file = path.join(releaseDir, receiptModule.RECEIPT_NAME);
  if (!fs.existsSync(file)) return { receipt: null, problems: ["no receipt in this release"] };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { receipt: null, problems: [`receipt is not valid JSON: ${error.message}`] };
  }
  let schema;
  try {
    schema = receiptModule.loadSchema(releaseDir);
  } catch (error) {
    return { receipt: null, problems: [error.message] };
  }
  const problems = receiptModule.validateReceipt(doc, schema);
  if (problems.length) return { receipt: null, problems };
  return { receipt: doc, problems: [] };
}

function verify(options, testReaders) {
  const releaseDir = path.resolve(options.releaseDir);
  const { receipt, problems } = loadReceipt(releaseDir);

  const links = {};
  links.L1 = checkL1(receipt);
  links.L2 = checkL2(releaseDir, options.repoDir, receipt);
  links.L3 = checkL3(releaseDir, receipt, links.L2);
  links.L4 = checkL4(options.currentLink, receipt);
  // testReaders is a SECOND POSITIONAL PARAMETER, not an option, so that no options object -- however
  // it was constructed, from CLI flags, environment variables or receipt contents -- can substitute
  // the /proc readers. Only an in-process caller can reach it, and main() calls verify() with exactly
  // one argument. It exists because on a host without /proc, L4 and L5 would be permanently
  // `unverified`, which would mask a link dropping out of the verdict arithmetic entirely -- a
  // mutation proved that hole was real.
  links.L5 = checkL5(receipt, options.pids, testReaders, links.L3.digested_paths);
  links.L6 = checkL6(releaseDir, receipt, options.pids);

  const artifactStates = [links.L2.state, links.L3.state, links.L4.state, links.L5.state];
  const artifact = worst(artifactStates);
  const releaseStates = [links.L1.state, ...artifactStates, links.L6.state];
  const release = worst(releaseStates);

  const verdicts = {
    artifact_identity:
      artifact === PASS ? "artifact_identity_verified"
        : artifact === FAIL ? "artifact_identity_failed"
          : "artifact_identity_unverified",
    release_identity:
      release === PASS ? "release_identity_verified"
        : release === FAIL ? "release_identity_failed"
          : "release_identity_unverified"
  };

  // Belt and braces: release_identity_verified must be structurally unreachable unless L1 and L6 pass.
  if (verdicts.release_identity === "release_identity_verified" && (links.L1.state !== PASS || links.L6.state !== PASS)) {
    throw new Error("internal: release_identity_verified reached with L1 or L6 not pass");
  }

  return { releaseDir, receipt_problems: problems, receipt_present: Boolean(receipt), links, verdicts };
}

function report(result, stage) {
  const lines = [];
  lines.push(`deployed-artifact verification  (${stage || "adhoc"})`);
  lines.push(`  release: ${result.releaseDir}`);
  if (!result.receipt_present) {
    lines.push(`  receipt: ABSENT or invalid -- ${result.receipt_problems.join("; ")}`);
    lines.push("           a release published before P1.4c has no receipt; that is `unverified`, never `failed`,");
    lines.push("           and must never block a rollback.");
  }
  lines.push("");
  for (const id of ["L1", "L2", "L3", "L4", "L5", "L6"]) {
    const l = result.links[id];
    lines.push(`  ${id}  ${l.state.toUpperCase().padEnd(10)} ${l.proposition || ""}`);
    if (id === "L2" && l.tracked_content) {
      lines.push(`        tracked_content=${l.tracked_content}  closed_extras=${l.closed_extras}`);
    }
    if (id === "L6" && l.half_a_versions) {
      lines.push(`        half A (versions)=${l.half_a_versions.state}  half B (executables)=${l.half_b_executables.state}`);
    }
    for (const f of l.findings.slice(0, 12)) lines.push(`        - ${f}`);
    if (l.findings.length > 12) lines.push(`        - …and ${l.findings.length - 12} more`);
  }
  lines.push("");
  lines.push(`  ${result.verdicts.artifact_identity}`);
  lines.push(`  ${result.verdicts.release_identity}`);
  if (result.links.L1.state !== PASS) lines.push(`  ${CI_REFUSAL}`);
  if (result.links.L6.state !== PASS) lines.push(`  ${TOOLCHAIN_REFUSAL}`);
  return lines.join("\n");
}

/**
 * The CLI's closed argument set. Every flag takes exactly one following value; there are no boolean
 * flags, which keeps arity uniform and testable.
 *
 * `readers` is deliberately absent, and cannot be added by accident: it is not an option at all --
 * see the second positional parameter of verify().
 */
const VERIFY_FLAGS = ["release", "repo", "current", "pids", "json", "stage", "app"];

/**
 * The closed set of stages, each with its own exit contract:
 *   pre-switch   gates publication on L2 and L3
 *   post-reload  requires L2, L3, L4 and L5 -- a non-zero exit is what makes the deploy warn
 *   rollback     reports only; a receiptless legacy release is `unverified`, never a failure
 *   adhoc        reports; non-zero only on a positive artifact-identity failure
 */
const STAGES = ["pre-switch", "post-reload", "rollback", "adhoc"];

/**
 * Parse `--flag value` pairs against a closed set, REFUSING anything unexpected.
 *
 * An unknown flag must never be silently dropped: that turns an operator's typo -- `--currrent`, or a
 * flag this build does not support -- into an apparently successful verification, which is worse than
 * no verification at all. Duplicates are refused rather than resolved to first-or-last, because
 * either choice silently discards what the operator asked for. `--flag=value` is refused because it
 * is not supported and therefore not tested.
 */
function parseArgs(argv, known, program) {
  const out = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string" || !token.startsWith("--")) {
      throw new Error(`${program}: unexpected argument ${JSON.stringify(token)}; every argument must be a --flag with one value`);
    }
    if (token.includes("=")) {
      throw new Error(`${program}: ${token} uses --flag=value, which is not supported; write --flag value`);
    }
    const name = token.slice(2);
    if (!known.includes(name)) {
      throw new Error(`${program}: unknown flag ${token} (supported: ${known.map((k) => "--" + k).join(" ")})`);
    }
    if (seen.has(name)) {
      throw new Error(`${program}: ${token} given more than once`);
    }
    const value = argv[i + 1];
    if (value === undefined || (typeof value === "string" && value.startsWith("--"))) {
      throw new Error(`${program}: ${token} requires exactly one value`);
    }
    seen.add(name);
    out[name] = value;
    i += 1;
  }
  return out;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv, VERIFY_FLAGS, "verify-deployed-artifact");
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (!args.release) {
    console.error("verify-deployed-artifact: --release <dir> is required");
    return 2;
  }
  const stage = args.stage || "adhoc";
  if (!STAGES.includes(stage)) {
    console.error(`verify-deployed-artifact: unknown --stage ${JSON.stringify(stage)} (supported: ${STAGES.join(", ")})`);
    return 2;
  }
  let pids = null;
  if (args.pids !== undefined) {
    // Malformed pids are REFUSED, not silently filtered. Quietly dropping "abc" from
    // "101,abc,103" would verify three workers while reporting on two, and an empty list would read
    // as "no workers online" rather than "the operator mistyped".
    const raw = args.pids.split(",").map((s) => s.trim());
    const bad = raw.filter((s) => s !== "" && !/^[0-9]+$/.test(s));
    if (bad.length) {
      console.error(`verify-deployed-artifact: --pids contains non-numeric entries: ${bad.join(", ")}`);
      return 2;
    }
    if (raw.length === 1 && raw[0] === "") {
      pids = [];
    } else if (raw.some((s) => s === "")) {
      console.error("verify-deployed-artifact: --pids contains an empty entry");
      return 2;
    } else {
      pids = raw.map(Number);
    }
  } else if (stage !== "pre-switch") {
    pids = readWorkerPids(args.app || "nibrs");
  }

  const result = verify({
    releaseDir: args.release,
    repoDir: args.repo,
    currentLink: args.current,
    pids
  });
  console.log(report(result, stage));
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(result, null, 2) + "\n");

  // Only the defined pre-switch links gate publication. L1, L4, L5 and L6 are reported: L6 will fail
  // on every deploy until the Node alignment lands, and a contract that blocked deploys on it would be
  // abandoned within a day. No automatic rollback, ever.
  if (stage === "pre-switch") {
    // Publication is gated on source and artifact only.
    return [result.links.L2.state, result.links.L3.state].every((s) => s === PASS) ? 0 : 1;
  }
  if (stage === "post-reload") {
    // L2 and L3 are re-checked HERE too, not just before the switch. The earlier version looked only
    // at L4 and L5, so an artifact that changed between publication and reload printed
    // artifact_identity_failed while handing the deploy exit 0 -- and the deploy, seeing success,
    // emitted no warning at all. Anything short of all four passing is non-zero.
    return [result.links.L2.state, result.links.L3.state, result.links.L4.state, result.links.L5.state]
      .every((s) => s === PASS) ? 0 : 1;
  }
  if (stage === "rollback") {
    // A rollback must never be blocked or undone by verification. Every release built before P1.4c
    // has no receipt and reports `unverified` throughout; that is not a failure. Only a positive
    // FAIL -- a receipt that exists and disagrees with the bytes -- is worth a non-zero exit, and
    // even then the rollback stands and nothing is undone.
    return [result.links.L2, result.links.L3, result.links.L4, result.links.L5]
      .some((l) => l.state === FAIL) ? 1 : 0;
  }
  return result.verdicts.artifact_identity === "artifact_identity_failed" ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { verify, parseArgs, VERIFY_FLAGS, parseNativeMappings, decodeMapsPath, report, checkL1, checkL2, checkL3, checkL4, checkL5, checkL6, loadReceipt, readWorkerPids, worst, main, CI_REFUSAL, TOOLCHAIN_REFUSAL, PASS, FAIL, UNVERIFIED };
