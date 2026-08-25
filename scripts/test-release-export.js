/**
 * P1.4a — the release input must be an exact commit, exported from Git objects.
 *
 * Run: node scripts/test-release-export.js
 *
 * WHAT THIS GUARDS. Until P1.4a, a release was an `rsync -a` of the operations repo's WORKING TREE.
 * `git reset --hard` restores tracked files but removes neither untracked nor ignored ones, and no
 * `git clean` appeared anywhere in the deploy, so anything left in that tree shipped. Measured on the
 * live release 20260824_134957: three paths present in production that are in no commit --
 * two untracked documents and one GITIGNORED `.pyc`. The `.pyc` is the instructive one: it is invisible
 * to `git status -uall` and shows up only under `--ignored`, so a contamination check written against
 * the obvious predicate would have called that release clean.
 *
 * The deploy also named a BRANCH, so the operator never named the artifact they received -- the tip
 * could move between the decision to deploy and the fetch.
 *
 * SELF-FIXTURING AND OFFLINE. Every check below builds its own throwaway Git repository in a temp
 * directory and exercises the SHIPPED shell library, `scripts/lib/release-export.sh`, the same file the
 * deploy sources. No network, no fixture tree in the repository, no state outside the temp directory.
 * The prune-releases.sh precedent applies: a test that re-implemented the rule would assert that a copy
 * was correct, not that the rule ships.
 */
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "scripts", "lib", "release-export.sh");
const DEPLOY = path.join(REPO, "scripts", "deploy-zero-downtime.sh");
const ALLOWED = path.join(REPO, "scripts", "fixtures", "release-allowed-extras.json");

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

// ---------------------------------------------------------------------------
// bash, located explicitly
// ---------------------------------------------------------------------------
//
// On Windows a bare `bash` resolves to the WSL launcher, which is absent on a normal workstation and
// dies with `execvpe(/bin/bash) failed`. Git Bash is located from git.exe, exactly as
// scripts/test-stage0-operational-guards.ts does, so this suite cannot pass merely because someone had
// already put Git Bash first on PATH.
function resolveBash() {
  if (process.platform !== "win32") return "bash";
  const candidates = [];
  try {
    const gitPaths = execFileSync("where", ["git"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const gitPath of gitPaths) {
      const dir = path.dirname(gitPath);
      for (const root of [path.resolve(dir, ".."), path.resolve(dir, "..", "..")]) {
        candidates.push(path.join(root, "bin", "bash.exe"));
      }
    }
  } catch {
    /* `where` missing or git absent from PATH; fall through to the fixed locations */
  }
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  candidates.push(path.join(pf, "Git", "bin", "bash.exe"), path.join(pf86, "Git", "bin", "bash.exe"));
  const found = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(`Could not locate Git Bash. Tried: ${candidates.join(", ")}`);
  }
  return found;
}

const BASH = resolveBash();

/** C:\x -> /c/x, so a Windows path is usable inside Git Bash. */
function toBashPath(value) {
  if (process.platform !== "win32") return value;
  return String(value).replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_m, d) => `/${d.toLowerCase()}/`);
}

check("platform branch: bash resolution and path conversion are both covered", () => {
  if (process.platform === "win32") {
    assert.ok(fs.existsSync(BASH), `resolved bash must exist: ${BASH}`);
    assert.equal(toBashPath("C:\\work\\r"), "/c/work/r", "a Windows path must convert for Git Bash");
  } else {
    assert.equal(BASH, "bash", "non-Windows must use the PATH bash");
    assert.equal(toBashPath("/opt/nibrs"), "/opt/nibrs", "a POSIX path must pass through unchanged");
  }
});

/**
 * Run a snippet with the shipped library sourced. Returns {status, stdout, stderr}.
 * Never throws on a non-zero exit: the exit code is the thing under test.
 */
function sh(snippet) {
  const script = `set -uo pipefail\n. "${toBashPath(LIB)}"\n${snippet}\n`;
  const result = spawnSync(BASH, ["-c", script], { encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

// ---------------------------------------------------------------------------
// throwaway repositories
// ---------------------------------------------------------------------------

const tempRoots = [];

function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p14a-${label}-`));
  tempRoots.push(dir);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return (result.stdout || "").trim();
}

/**
 * A synthetic operations repo: a real commit, a real tree, and a real `origin/dev` remote-tracking
 * ref created with update-ref so nothing has to reach the network.
 *
 * `files` maps a repo-relative path to its exact byte content.
 */
function makeRepo(files, options) {
  const opts = options || {};
  const dir = makeTempDir("repo");
  git(dir, ["init", "--quiet", "-b", "dev"]);
  git(dir, ["config", "user.email", "p14a@example.invalid"]);
  git(dir, ["config", "user.name", "p14a"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "synthetic"]);
  const sha = git(dir, ["rev-parse", "HEAD"]);
  // The branch the deploy will assert ancestry against.
  git(dir, ["update-ref", opts.remoteRef || "refs/remotes/origin/dev", opts.remoteAt || sha]);
  return { dir, sha };
}

/** Export a commit into a fresh directory using the shipped function. */
function exportTo(repo, sha) {
  const dest = makeTempDir("release");
  const out = sh(`release_export_tree "${toBashPath(repo)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 0, `release_export_tree must succeed: ${out.stderr}`);
  return dest;
}

const LFS_POINTER =
  "version https://git-lfs.github.com/spec/v1\n" +
  "oid sha256:" + "a".repeat(64) + "\n" +
  "size 12345\n";

// ---------------------------------------------------------------------------
// A1 — a full immutable SHA, and nothing else, is accepted
// ---------------------------------------------------------------------------

check("A1 a full 40-character lowercase SHA is accepted", () => {
  const sha = "0".repeat(39) + "f";
  assert.equal(sh(`release_export_validate_sha "${sha}"`).status, 0, "a 40-hex SHA must validate");
});

check("A1 a branch name is refused and named", () => {
  const out = sh('release_export_validate_sha "dev"');
  assert.equal(out.status, 1, "a branch name must be refused");
  assert.match(out.stderr, /40-character/, "the refusal must say what was expected");
  assert.match(out.stderr, /dev/, "the refusal must quote the offending value");
});

check("A1 an abbreviated SHA is refused", () => {
  assert.equal(sh('release_export_validate_sha "8bf966e"').status, 1, "an abbreviation must be refused");
  assert.equal(
    sh(`release_export_validate_sha "${"a".repeat(41)}"`).status,
    1,
    "41 characters must be refused too, not merely truncated"
  );
});

check("A1 an uppercase or non-hex SHA is refused", () => {
  assert.equal(sh(`release_export_validate_sha "${"A".repeat(40)}"`).status, 1, "uppercase must be refused");
  assert.equal(sh(`release_export_validate_sha "${"z".repeat(40)}"`).status, 1, "non-hex must be refused");
});

check("A1 a SHA absent from the object store is refused, naming the repository", () => {
  const { dir } = makeRepo({ "a.txt": "a\n" });
  const absent = "b".repeat(40);
  const out = sh(`release_export_assert_commit "${toBashPath(dir)}" "${absent}"`);
  assert.equal(out.status, 1, "an absent object must be refused");
  assert.match(out.stderr, /not present/, "the refusal must say the object is absent");
});

check("A1 a SHA that exists but is not a commit is refused, naming what it is", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const treeSha = git(dir, ["rev-parse", `${sha}^{tree}`]);
  const out = sh(`release_export_assert_commit "${toBashPath(dir)}" "${treeSha}"`);
  assert.equal(out.status, 1, "a tree object must not be accepted as a commit");
  assert.match(out.stderr, /tree/, "the refusal must name the actual object type");
});

// ---------------------------------------------------------------------------
// A2 — the SHA must be an ancestor of the branch
// ---------------------------------------------------------------------------

check("A2 a commit on the branch is accepted", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const out = sh(`release_export_assert_ancestor "${toBashPath(dir)}" "${sha}" dev`);
  assert.equal(out.status, 0, `an ancestor must be accepted: ${out.stderr}`);
});

check("A2 a commit that exists but is NOT an ancestor of the branch is refused", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  // A second commit on a side branch, deliberately left out of origin/dev.
  fs.writeFileSync(path.join(dir, "side.txt"), "side\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "side"]);
  const sideSha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["update-ref", "refs/remotes/origin/dev", sha]);

  const ok = sh(`release_export_assert_ancestor "${toBashPath(dir)}" "${sha}" dev`);
  assert.equal(ok.status, 0, "the recorded tip must still be an ancestor");

  const out = sh(`release_export_assert_ancestor "${toBashPath(dir)}" "${sideSha}" dev`);
  assert.equal(out.status, 1, "a commit off the branch must be refused");
  assert.match(out.stderr, /not an ancestor/, "the refusal must say why");
  assert.match(out.stderr, new RegExp(sideSha.slice(0, 12)), "the refusal must name the commit");
});

check("A2 a missing remote-tracking ref is refused rather than silently passing", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const out = sh(`release_export_assert_ancestor "${toBashPath(dir)}" "${sha}" nosuchbranch`);
  assert.equal(out.status, 1, "an absent branch ref must be refused");
  assert.match(out.stderr, /refs\/remotes\/origin\/nosuchbranch/, "the refusal must name the ref it wanted");
});

// ---------------------------------------------------------------------------
// A3 — per-path blob equality against the commit tree
// ---------------------------------------------------------------------------

check("A3 an untouched export is byte-equal to the commit tree on every path", () => {
  const { dir, sha } = makeRepo({
    "a.txt": "alpha\n",
    "nested/deep/b.json": '{"k":"v"}\n',
    "crlf.txt": "one\r\ntwo\r\n",
    "empty.txt": "",
    "binary.bin": Buffer.from([0, 1, 2, 255, 254, 10]).toString("binary")
  });
  const dest = exportTo(dir, sha);
  const out = sh(`release_export_verify_blobs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 0, `equality must hold: ${out.stdout}${out.stderr}`);
  assert.equal(out.stdout.trim(), "", "a clean export must report nothing");
});

check("A3 a single changed byte is reported as differing, with both hashes", () => {
  const { dir, sha } = makeRepo({ "a.txt": "alpha\n", "b.txt": "beta\n" });
  const dest = exportTo(dir, sha);
  fs.writeFileSync(path.join(dest, "a.txt"), "alphb\n");
  const out = sh(`release_export_verify_blobs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 1, "a changed byte must fail");
  assert.match(out.stdout, /^differs a\.txt expected=[0-9a-f]{40} actual=[0-9a-f]{40}$/m, "both hashes must be named");
  assert.doesNotMatch(out.stdout, /b\.txt/, "an untouched path must not be reported");
});

check("A3 a deleted path is reported as missing", () => {
  const { dir, sha } = makeRepo({ "a.txt": "alpha\n" });
  const dest = exportTo(dir, sha);
  fs.rmSync(path.join(dest, "a.txt"));
  const out = sh(`release_export_verify_blobs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 1, "a missing path must fail");
  assert.match(out.stdout, /^missing a\.txt$/m, "the missing path must be named");
});

check("A3 mode-preserving: an executable tracked blob exports and verifies", () => {
  const { dir, sha } = makeRepo({ "run.sh": "#!/bin/sh\necho hi\n" });
  git(dir, ["update-index", "--chmod=+x", "run.sh"]);
  git(dir, ["commit", "--quiet", "-m", "exec"]);
  const sha2 = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["update-ref", "refs/remotes/origin/dev", sha2]);
  const mode = git(dir, ["ls-tree", sha2, "--", "run.sh"]).split(/\s+/)[0];
  assert.equal(mode, "100755", "the fixture must actually carry the executable bit");
  const dest = exportTo(dir, sha2);
  const out = sh(`release_export_verify_blobs "${toBashPath(dir)}" "${sha2}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 0, `an executable blob must verify: ${out.stdout}${out.stderr}`);
});

// ---------------------------------------------------------------------------
// A4 — a planted export-ignore makes A3 fail
// ---------------------------------------------------------------------------
//
// This is what makes A3 a check on BYTES rather than on `git archive`'s exit code. `export-ignore`
// silently omits a path from the archive; the extraction still succeeds.

check("A4 an export-ignore attribute omits a tracked path and A3 catches it", () => {
  const { dir, sha } = makeRepo({
    ".gitattributes": "secret.txt export-ignore\n",
    "secret.txt": "omitted\n",
    "kept.txt": "kept\n"
  });
  const dest = exportTo(dir, sha);

  assert.ok(fs.existsSync(path.join(dest, "kept.txt")), "the unaffected path must be present");
  assert.ok(!fs.existsSync(path.join(dest, "secret.txt")), "export-ignore must actually omit the path");

  const out = sh(`release_export_verify_blobs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 1, "an omitted tracked path must fail the export gate");
  assert.match(out.stdout, /^missing secret\.txt$/m, "the omitted path must be named");
});

check("A4 an export-subst attribute rewrites bytes and A3 catches it", () => {
  const { dir, sha } = makeRepo({
    ".gitattributes": "stamp.txt export-subst\n",
    "stamp.txt": "commit $Format:%H$\n"
  });
  const dest = exportTo(dir, sha);
  const exported = fs.readFileSync(path.join(dest, "stamp.txt"), "utf8");
  assert.ok(exported.includes(sha), "export-subst must actually have rewritten the bytes");
  const out = sh(`release_export_verify_blobs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 1, "a rewritten blob must fail the export gate");
  assert.match(out.stdout, /^differs stamp\.txt /m, "the rewritten path must be named");
});

// ---------------------------------------------------------------------------
// A10 / A11 / A12 — whole-file Git LFS pointer refusal
// ---------------------------------------------------------------------------
//
// A committed LFS pointer IS the Git blob, so its hash matches the tree object exactly and A3 passes,
// correctly, by its own definition. Without a separate refusal a release would publish a 130-byte text
// file where a database was expected.

check("A10 a tracked whole-file LFS pointer is refused, by name", () => {
  const { dir, sha } = makeRepo({ "data/big.db": LFS_POINTER, "plain.txt": "plain\n" });
  const dest = exportTo(dir, sha);
  const out = sh(`release_export_refuse_lfs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 1, "a pointer must be refused");
  assert.match(out.stdout, /^lfs-pointer data\/big\.db$/m, "the pointer path must be named");
  assert.doesNotMatch(out.stdout, /plain\.txt/, "an ordinary file must not be refused");
});

check("A12 the LFS refusal fires while per-path blob equality still passes on the same blob", () => {
  const { dir, sha } = makeRepo({ "data/big.db": LFS_POINTER });
  const dest = exportTo(dir, sha);

  const equality = sh(`release_export_verify_blobs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(equality.status, 0, "blob equality must PASS on a pointer -- that is the whole problem");
  assert.equal(equality.stdout.trim(), "", "equality must report nothing for the pointer");

  const refusal = sh(`release_export_refuse_lfs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(refusal.status, 1, "the refusal must fire on exactly the blob equality accepted");
  assert.match(refusal.stdout, /^lfs-pointer data\/big\.db$/m, "and must name it");
});

check("A11 a document that merely QUOTES the pointer format is accepted", () => {
  // The three pointer lines verbatim, inside a larger file. A substring rule would refuse this --
  // and would refuse the P1.4 contract document itself, which quotes the same format.
  const doc =
    "# Notes on Git LFS\n\nA pointer file looks like this:\n\n" +
    LFS_POINTER +
    "\nand it is exactly three lines long.\n";
  const { dir, sha } = makeRepo({ "docs/lfs-notes.md": doc, "data/real.db": LFS_POINTER });
  const dest = exportTo(dir, sha);
  const out = sh(`release_export_refuse_lfs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 1, "the genuine pointer must still be refused");
  assert.match(out.stdout, /^lfs-pointer data\/real\.db$/m, "the genuine pointer must be named");
  assert.doesNotMatch(out.stdout, /lfs-notes/, "a document quoting the format must NOT be refused");
});

check("A11 near-misses are accepted: wrong oid, missing size, extra line, trailing content", () => {
  const nearMisses = {
    "wrong-oid.txt": "version https://git-lfs.github.com/spec/v1\noid sha256:short\nsize 1\n",
    "no-size.txt": "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\n",
    "extra-line.txt": LFS_POINTER + "extra\n",
    "wrong-order.txt": "oid sha256:" + "a".repeat(64) + "\nversion https://git-lfs.github.com/spec/v1\nsize 1\n"
  };
  const { dir, sha } = makeRepo(nearMisses);
  const dest = exportTo(dir, sha);
  const out = sh(`release_export_refuse_lfs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 0, `no near-miss may be refused: ${out.stdout}`);
  assert.equal(out.stdout.trim(), "", "nothing should be reported");
});

check("A10 a clean tree is not refused", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n", "b/c.txt": "c\n" });
  const dest = exportTo(dir, sha);
  const out = sh(`release_export_refuse_lfs "${toBashPath(dir)}" "${sha}" "${toBashPath(dest)}"`);
  assert.equal(out.status, 0, "a clean tree must pass");
});

// ---------------------------------------------------------------------------
// A5 / A6 / A7 — the closed set of post-export additions
// ---------------------------------------------------------------------------

/** Write an allowlist fixture into a temp file and return its path. */
function writeAllowed(entries) {
  const dir = makeTempDir("allowed");
  const file = path.join(dir, "release-allowed-extras.json");
  fs.writeFileSync(file, JSON.stringify({ entries }, null, 2) + "\n");
  return file;
}

const REAL_ALLOWED = JSON.parse(fs.readFileSync(ALLOWED, "utf8"));

function unexplained(repo, sha, dest, allowedFile) {
  return sh(
    `release_export_unexplained "${toBashPath(repo)}" "${sha}" "${toBashPath(dest)}" "${toBashPath(allowedFile)}"`
  );
}

check("A5 a release carrying only tracked content and permitted additions is accepted", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n", "scripts/x.py": "x\n" });
  const dest = exportTo(dir, sha);
  fs.writeFileSync(path.join(dest, "RELEASE_INFO"), "release=t\n");
  fs.mkdirSync(path.join(dest, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dest, "node_modules", "pkg", "index.js"), "1\n");
  fs.mkdirSync(path.join(dest, ".next", "server"), { recursive: true });
  fs.writeFileSync(path.join(dest, ".next", "BUILD_ID"), "abc\n");
  fs.writeFileSync(path.join(dest, "next-env.d.ts"), "// generated\n");

  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 0, `a compliant release must pass: ${out.stdout}${out.stderr}`);
  assert.equal(out.stdout.trim(), "", "nothing should be reported");
});

check("A5 an unexplained file stops publication and names itself", () => {
  // Reproduces the three paths measured in production release 20260824_134957:
  // two untracked documents beside tracked content, and one gitignored .pyc under a tracked directory.
  const { dir, sha } = makeRepo({ "a.txt": "a\n", "scripts/keep.py": "k\n", "docs/tracked.md": "t\n" });
  const dest = exportTo(dir, sha);
  fs.writeFileSync(path.join(dest, "RELEASE_INFO"), "release=t\n");
  fs.mkdirSync(path.join(dest, "scripts", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(dest, "scripts", "__pycache__", "m.cpython-312.pyc"), "junk\n");
  fs.writeFileSync(path.join(dest, "docs", "sweep-prod-2026-07-21.md"), "sweep output\n");
  fs.writeFileSync(path.join(dest, "leftover.md"), "sweep output\n");

  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 1, "unexplained content must fail");

  // File-level naming, inside a tracked directory and at the release root.
  assert.match(
    out.stdout,
    /^unexplained docs\/sweep-prod-2026-07-21\.md$/m,
    "a stray document beside tracked content must be named individually"
  );
  assert.match(out.stdout, /^unexplained leftover\.md$/m, "a stray document at the root must be named");

  // Directory-level naming: the HIGHEST unexplained entry is reported and not descended into, so an
  // unlisted node_modules is one actionable line instead of 26,798.
  assert.match(
    out.stdout,
    /^unexplained scripts\/__pycache__$/m,
    "the gitignored .pyc's directory -- the case measured in production -- must be named"
  );
  assert.doesNotMatch(
    out.stdout,
    /m\.cpython-312\.pyc/,
    "and the walk must not descend past it, or an unlisted tree would print every file beneath"
  );
  assert.doesNotMatch(out.stdout, /^unexplained scripts$/m, "a directory holding tracked content is not itself unexplained");
  assert.doesNotMatch(out.stdout, /^unexplained docs$/m, "nor is docs/");
  assert.equal(out.stdout.trim().split(/\n/).length, 3, "exactly three findings, one per planted path");
});

check("A5 the walker judges a symlink AS a link: -L is tested before -d, so no target is followed", () => {
  // A structural assertion, not a behavioural one, and deliberately so. `fs.symlinkSync` returns
  // EPERM on this platform -- measured, not assumed -- because creating a symlink on Windows needs a
  // privilege neither this workstation nor windows-latest reliably has. The behavioural check below
  // therefore cannot run here, and an unconditional `assert.ok(true)` would be a vacuous pass on the
  // only platform the harness runs on.
  //
  // What CAN be checked anywhere is the shipped walker's test order. If `-d` were tested first, a
  // symlink pointing at a directory would be descended into, and the gate would read shared state --
  // /opt/nibrs/shared and its databases sit behind exactly such links. The ordering is the property
  // that keeps the gate from following them.
  const lib = fs.readFileSync(LIB, "utf8");
  const walkerStart = lib.indexOf("release_export_unexplained()");
  assert.ok(walkerStart > 0, "the walker must exist");
  const walker = lib.slice(walkerStart);

  // The walker classifies a candidate in TWO places -- once to check an allowlisted entry's declared
  // type, once to dispose of an unknown path -- and each must reach -L before -d.
  const offsets = (needle) => {
    const found = [];
    for (let i = walker.indexOf(needle); i !== -1; i = walker.indexOf(needle, i + 1)) found.push(i);
    return found;
  };
  const links = offsets('[[ -L "$here/$name" ]]');
  const dirs = offsets('[[ -d "$here/$name" ]]');
  assert.equal(links.length, 2, "expected exactly two -L classifications: allowlisted, and unknown");
  assert.equal(dirs.length, 2, "expected exactly two -d classifications: allowlisted, and unknown");
  for (let i = 0; i < 2; i += 1) {
    assert.ok(
      links[i] < dirs[i],
      `classification ${i + 1}: -L must be tested BEFORE -d, or a symlinked directory would be followed`
    );
  }

  // The allowlisted branch must label it a symlink rather than dereference it.
  const typeBranch = walker.slice(links[0], dirs[0]);
  assert.match(typeBranch, /actual_type="symlink"/, "an allowlisted symlink must be classified as a link");
  assert.doesNotMatch(typeBranch, /queue\+=/, "and must never enqueue a descent");

  // The unknown branch must report, not descend.
  const unknownBranch = walker.slice(links[1], dirs[1]);
  assert.match(unknownBranch, /unexplained \$candidate/, "an unknown symlink must be reported");
  assert.doesNotMatch(unknownBranch, /queue\+=/, "and must never enqueue a descent");

  // Nothing anywhere in the walker may dereference a candidate.
  assert.doesNotMatch(walker, /readlink/, "the walker must never read a link target");

  // End-to-end symlink behaviour on a real filesystem remains deployment-target evidence, and is
  // covered by P1.4c's verifier on Linux rather than claimed here.
  if (process.platform === "win32") return;
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const dest = exportTo(dir, sha);
  fs.writeFileSync(path.join(dest, "RELEASE_INFO"), "release=t\n");
  fs.symlinkSync("/etc/shadow", path.join(dest, "rogue"));
  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 1, "an unexplained symlink must fail");
  assert.match(out.stdout, /^unexplained rogue$/m, "the symlink must be named");
});

check("A5 an empty directory is reported: no tracked path implies it", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const dest = exportTo(dir, sha);
  fs.writeFileSync(path.join(dest, "RELEASE_INFO"), "release=t\n");
  fs.mkdirSync(path.join(dest, "hollow"));
  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 1, "an empty directory must fail");
  assert.match(out.stdout, /^unexplained hollow$/m, "the empty directory must be named");
});

check("A6 removing a permitted addition from the fixture makes it unexplained", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const dest = exportTo(dir, sha);
  fs.writeFileSync(path.join(dest, "RELEASE_INFO"), "release=t\n");

  const withStamp = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(withStamp.status, 0, `RELEASE_INFO must be permitted by the real fixture: ${withStamp.stdout}`);

  const trimmed = REAL_ALLOWED.entries.filter((e) => e.path !== "RELEASE_INFO");
  assert.equal(trimmed.length, REAL_ALLOWED.entries.length - 1, "the fixture must really have contained it");
  const out = unexplained(dir, sha, dest, writeAllowed(trimmed));
  assert.equal(out.status, 1, "a stale fixture must fail loudly, not widen silently");
  assert.match(out.stdout, /^unexplained RELEASE_INFO$/m, "the now-unpermitted path must be named");
});

check("A6 removing a tree-scoped entry makes its whole subtree unexplained", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const dest = exportTo(dir, sha);
  fs.mkdirSync(path.join(dest, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dest, "node_modules", "pkg", "index.js"), "1\n");

  const trimmed = REAL_ALLOWED.entries.filter((e) => e.path !== "node_modules");
  const out = unexplained(dir, sha, dest, writeAllowed(trimmed));
  assert.equal(out.status, 1, "an unpermitted tree must fail");
  assert.match(out.stdout, /^unexplained node_modules$/m, "the tree root must be named, not every file beneath it");
});

check("A7 the fixture schema is closed: an unknown field is refused", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const dest = exportTo(dir, sha);
  const bad = REAL_ALLOWED.entries.map((e) => Object.assign({}, e));
  bad[0].corpus_ids = ["sneaky"];
  const out = unexplained(dir, sha, dest, writeAllowed(bad));
  assert.equal(out.status, 1, "an unknown field must be refused");
  assert.match(out.stderr, /corpus_ids/, "the unknown field must be named");
});

check("A7 the fixture schema is closed: unknown kind, unknown scope, missing field, bad shape", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const dest = exportTo(dir, sha);

  const cases = [
    ["unknown kind", (e) => { e[0].kind = "whatever"; }, /kind/],
    ["unknown scope", (e) => { e[0].scope = "recursive-ish"; }, /scope/],
    ["missing path", (e) => { delete e[0].path; }, /path/],
    ["missing detail", (e) => { delete e[0].detail; }, /detail/],
    ["absolute path", (e) => { e[0].path = "/etc/passwd"; }, /path/],
    ["escaping path", (e) => { e[0].path = "../outside"; }, /path/],
    ["duplicate path", (e) => { e.push(Object.assign({}, e[0])); }, /duplicate/]
  ];

  for (const [label, mutate, expected] of cases) {
    const entries = REAL_ALLOWED.entries.map((e) => Object.assign({}, e));
    mutate(entries);
    const out = unexplained(dir, sha, dest, writeAllowed(entries));
    assert.equal(out.status, 1, `${label}: must be refused`);
    assert.match(out.stderr, expected, `${label}: the refusal must name the problem`);
  }
});

check("A7 a malformed or absent fixture is refused rather than treated as empty", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const dest = exportTo(dir, sha);

  const brokenDir = makeTempDir("broken");
  const broken = path.join(brokenDir, "release-allowed-extras.json");
  fs.writeFileSync(broken, "{ not json\n");
  const bad = unexplained(dir, sha, dest, broken);
  assert.equal(bad.status, 1, "unparseable JSON must be refused");

  const missing = unexplained(dir, sha, dest, path.join(brokenDir, "absent.json"));
  assert.equal(missing.status, 1, "an absent fixture must be refused, never defaulted to empty");
  assert.match(missing.stderr, /release-allowed-extras|absent\.json|not readable|no such/i, "and must say so");
});

check("the shipped fixture validates, and covers every addition the deploy makes", () => {
  const { dir, sha } = makeRepo({ "a.txt": "a\n" });
  const dest = exportTo(dir, sha);
  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 0, `the shipped fixture must validate: ${out.stderr}`);

  const paths = REAL_ALLOWED.entries.map((e) => e.path).sort();
  for (const required of [
    ".env",
    ".env.local",
    ".next",
    "RELEASE_INFO",
    "crime_data.db",
    "next-env.d.ts",
    "node_modules",
    "query_log.db"
  ]) {
    assert.ok(paths.includes(required), `the fixture must permit ${required}`);
  }
  assert.ok(
    !paths.includes("RELEASE_RECEIPT.json"),
    "the receipt belongs to P1.4c and must not be pre-permitted here"
  );
});

// ---------------------------------------------------------------------------
// A13 — the DECLARED OBJECT TYPE is enforced, not just the pathname
// ---------------------------------------------------------------------------
//
// The allowlist declares a kind for every entry. Matching on pathname alone accepted a permitted name
// whatever it actually was: `.env` as a regular file, `node_modules` as a symlink, a permitted file as
// a directory. Each of those is a different artifact with different behaviour, and each passed.

/** A release directory carrying only tracked content, ready for one planted defect. */
function releaseWithTracked() {
  const { dir, sha } = makeRepo({ "a.txt": "a\n", "scripts/keep.py": "k\n" });
  const dest = exportTo(dir, sha);
  return { dir, sha, dest };
}

check("A13 a shared symlink arriving as a REGULAR FILE is refused, naming both types", () => {
  const { dir, sha, dest } = releaseWithTracked();
  fs.writeFileSync(path.join(dest, ".env"), "SECRET=oops\n");
  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 1, "a permitted name with the wrong type must fail");
  assert.match(
    out.stdout,
    /^wrong-type \.env expected=symlink actual=file$/m,
    "the finding must name the path, the expected type and the actual type"
  );
  assert.doesNotMatch(out.stdout, /^unexplained \.env$/m, "it is a type failure, not an unknown path");
});

check("A13 a permitted FILE arriving as a directory is refused", () => {
  const { dir, sha, dest } = releaseWithTracked();
  fs.mkdirSync(path.join(dest, "RELEASE_INFO"));
  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 1, "RELEASE_INFO as a directory must fail");
  assert.match(out.stdout, /^wrong-type RELEASE_INFO expected=file actual=directory$/m, "both types must be named");
});

check("A13 a dependency TREE arriving as a regular file is refused", () => {
  const { dir, sha, dest } = releaseWithTracked();
  fs.writeFileSync(path.join(dest, "node_modules"), "not a tree\n");
  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 1, "node_modules as a file must fail");
  assert.match(out.stdout, /^wrong-type node_modules expected=directory actual=file$/m, "both types must be named");
});

check("A13 a build-output tree arriving as a real directory is accepted", () => {
  const { dir, sha, dest } = releaseWithTracked();
  fs.mkdirSync(path.join(dest, ".next", "server"), { recursive: true });
  fs.writeFileSync(path.join(dest, ".next", "BUILD_ID"), "abc\n");
  fs.mkdirSync(path.join(dest, "node_modules"));
  fs.writeFileSync(path.join(dest, "RELEASE_INFO"), "release=t\n");
  fs.writeFileSync(path.join(dest, "next-env.d.ts"), "// generated\n");
  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 0, `the correct types must be accepted: ${out.stdout}${out.stderr}`);
  assert.equal(out.stdout.trim(), "", "nothing should be reported");
});

check("A13 a dependency tree arriving as a SYMLINK is refused, and the link is not followed", () => {
  if (process.platform === "win32") {
    // fs.symlinkSync returns EPERM here -- measured, not assumed. The structural guarantee that a
    // symlink is classified before -d is asserted separately; end-to-end coverage is Linux evidence.
    return;
  }
  const { dir, sha, dest } = releaseWithTracked();
  const elsewhere = makeTempDir("elsewhere");
  fs.writeFileSync(path.join(elsewhere, "marker.txt"), "must not be read\n");
  fs.symlinkSync(elsewhere, path.join(dest, "node_modules"));
  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 1, "node_modules as a symlink must fail");
  assert.match(out.stdout, /^wrong-type node_modules expected=directory actual=symlink$/m, "both types must be named");
  assert.doesNotMatch(out.stdout, /marker\.txt/, "the link target must never be enumerated");
});

check("A13 genuine shared symlinks are accepted", () => {
  if (process.platform === "win32") return; // see the note above
  const { dir, sha, dest } = releaseWithTracked();
  const shared = makeTempDir("shared");
  for (const name of [".env", ".env.local", "crime_data.db", "query_log.db"]) {
    fs.writeFileSync(path.join(shared, name), "shared\n");
    fs.symlinkSync(path.join(shared, name), path.join(dest, name));
  }
  fs.writeFileSync(path.join(dest, "RELEASE_INFO"), "release=t\n");
  const out = unexplained(dir, sha, dest, ALLOWED);
  assert.equal(out.status, 0, `real symlinks must be accepted: ${out.stdout}${out.stderr}`);
});

check("A13 the reviewed (kind, scope) pairs are closed", () => {
  const { dir, sha, dest } = releaseWithTracked();
  // shared_symlink only makes sense for a single path; a tree of symlinks is not a reviewed shape.
  const entries = REAL_ALLOWED.entries.map((e) => Object.assign({}, e));
  entries[0].scope = "tree";
  const out = unexplained(dir, sha, dest, writeAllowed(entries));
  assert.equal(out.status, 1, "an unreviewed kind/scope pair must be refused");
  assert.match(out.stderr, /not a reviewed combination/, "the refusal must say so");
});

check("A7 the document schema is closed at the TOP level too", () => {
  const { dir, sha, dest } = releaseWithTracked();
  const doc = { _README: ["fine"], entries: REAL_ALLOWED.entries, extra_rules: ["sneaky"] };
  const dirOut = makeTempDir("topfield");
  const file = path.join(dirOut, "release-allowed-extras.json");
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  const out = unexplained(dir, sha, dest, file);
  assert.equal(out.status, 1, "an unknown top-level field must be refused");
  assert.match(out.stderr, /unknown top-level field extra_rules/, "and must be named");

  // _README and entries remain permitted.
  const ok = { _README: ["fine"], entries: REAL_ALLOWED.entries };
  const okFile = path.join(dirOut, "ok.json");
  fs.writeFileSync(okFile, JSON.stringify(ok, null, 2) + "\n");
  assert.equal(unexplained(dir, sha, dest, okFile).status, 0, "_README and entries must stay permitted");
});

// ---------------------------------------------------------------------------
// A14 — the deployment rules are bound to the commit being deployed
// ---------------------------------------------------------------------------
//
// The deploy sources its helper and reads its allowlist from whatever checkout invoked it. Since it no
// longer checks anything out, that checkout drifts, and a release could be built from SHA X under
// rules from SHA Y.

/** A synthetic repo carrying a deploy bundle, plus a bundle directory on disk. */
function makeBundle(overrides) {
  const files = {
    "scripts/deploy-zero-downtime.sh": "#!/usr/bin/env bash\necho deploy v1\n",
    "scripts/lib/release-export.sh": "#!/usr/bin/env bash\necho helper v1\n",
    "scripts/fixtures/release-allowed-extras.json": '{"entries":[]}\n',
    "app.txt": "app\n"
  };
  const { dir, sha } = makeRepo(files);
  const bundle = makeTempDir("bundle");
  fs.mkdirSync(path.join(bundle, "lib"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "fixtures"), { recursive: true });
  const onDisk = {
    "deploy-zero-downtime.sh": files["scripts/deploy-zero-downtime.sh"],
    "lib/release-export.sh": files["scripts/lib/release-export.sh"],
    "fixtures/release-allowed-extras.json": files["scripts/fixtures/release-allowed-extras.json"]
  };
  for (const [rel, content] of Object.entries(Object.assign(onDisk, overrides || {}))) {
    if (content === null) {
      continue;
    }
    fs.writeFileSync(path.join(bundle, rel), content);
  }
  return { dir, sha, bundle };
}

function selfMatch(repo, sha, bundle) {
  return sh(
    `release_export_assert_self_matches "${toBashPath(repo)}" "${sha}" "${toBashPath(bundle)}"`
  );
}

check("A14 a bundle identical to the deployed commit is accepted", () => {
  const { dir, sha, bundle } = makeBundle();
  const out = selfMatch(dir, sha, bundle);
  assert.equal(out.status, 0, `an identical bundle must be accepted: ${out.stdout}${out.stderr}`);
  assert.equal(out.stdout.trim(), "", "nothing should be reported");
});

check("A14 a HELPER from a different commit is refused, with both blob ids", () => {
  const { dir, sha, bundle } = makeBundle({ "lib/release-export.sh": "#!/usr/bin/env bash\necho helper v2\n" });
  const out = selfMatch(dir, sha, bundle);
  assert.equal(out.status, 1, "a drifted helper must be refused");
  assert.match(
    out.stdout,
    /^deploy-bundle-differs scripts\/lib\/release-export\.sh expected=[0-9a-f]{40} actual=[0-9a-f]{40}$/m,
    "the finding must name the path and both blob ids"
  );
});

check("A14 a POLICY from a different commit is refused", () => {
  const { dir, sha, bundle } = makeBundle({
    "fixtures/release-allowed-extras.json": '{"entries":[],"_README":["drifted"]}\n'
  });
  const out = selfMatch(dir, sha, bundle);
  assert.equal(out.status, 1, "a drifted allowlist must be refused");
  assert.match(out.stdout, /^deploy-bundle-differs scripts\/fixtures\/release-allowed-extras\.json /m, "named");
});

check("A14 a drifted DEPLOY SCRIPT is refused", () => {
  const { dir, sha, bundle } = makeBundle({ "deploy-zero-downtime.sh": "#!/usr/bin/env bash\necho deploy v2\n" });
  const out = selfMatch(dir, sha, bundle);
  assert.equal(out.status, 1, "a drifted deploy script must be refused");
  assert.match(out.stdout, /^deploy-bundle-differs scripts\/deploy-zero-downtime\.sh /m, "named");
});

check("A14 an absent bundle member is refused, and a commit lacking the bundle is refused", () => {
  const { dir, sha, bundle } = makeBundle();
  fs.rmSync(path.join(bundle, "lib", "release-export.sh"));
  const absent = selfMatch(dir, sha, bundle);
  assert.equal(absent.status, 1, "a missing bundle member must be refused");
  assert.match(absent.stdout, /^deploy-bundle-absent scripts\/lib\/release-export\.sh /m, "named");

  // A commit that predates the bundle cannot be deployed by this script either.
  const bare = makeRepo({ "app.txt": "app\n" });
  const untracked = selfMatch(bare.dir, bare.sha, bundle);
  assert.equal(untracked.status, 1, "a commit without the bundle must be refused");
  assert.match(untracked.stdout, /^deploy-bundle-untracked scripts\//m, "named");
});

check("A14 the deploy binds the bundle BEFORE creating or exporting a release", () => {
  bothViews("scripts/deploy-zero-downtime.sh", (_raw, code) => {
    const bind = code.indexOf("release_export_assert_self_matches");
    const mk = code.search(/^mkdir -p "\$RELEASE_DIR"/m);
    const exportAt = code.indexOf("release_export_tree");
    const switchPoint = code.indexOf("mv -Tf");
    assert.ok(bind > 0, "the bundle binding must exist");
    assert.ok(mk > 0 && exportAt > 0 && switchPoint > 0, "the release steps must exist");
    assert.ok(bind < mk, "the binding must precede release-directory creation");
    assert.ok(bind < exportAt, "the binding must precede the export");
    assert.ok(bind < switchPoint, "and certainly precede publication");
  });
});

check("A14 the gate reads the allowlist EXPORTED from the deployed commit, not the executing copy", () => {
  bothViews("scripts/deploy-zero-downtime.sh", (_raw, code) => {
    assert.match(
      code,
      /ALLOWED_EXTRAS_FILE="\$RELEASE_DIR\/scripts\/fixtures\/release-allowed-extras\.json"/,
      "the authoritative allowlist must come from the exported release"
    );
    const assignExported = code.indexOf('ALLOWED_EXTRAS_FILE="$RELEASE_DIR');
    const exportAt = code.indexOf("release_export_tree");
    const gate = code.indexOf("release_export_unexplained");
    assert.ok(exportAt > 0 && assignExported > exportAt, "it can only be assigned after the export");
    assert.ok(assignExported < gate, "and must be assigned before the gate uses it");
    assert.match(
      code,
      /release_export_unexplained "\$REPO_DIR" "\$DEPLOY_SHA" "\$RELEASE_DIR" "\$ALLOWED_EXTRAS_FILE"/,
      "the gate must be called with that file"
    );
    // The executing copy is used only to prove the bundle matches, never as the gate's input.
    assert.match(code, /SELF_ALLOWED_EXTRAS="\$SCRIPT_DIR\/fixtures\/release-allowed-extras\.json"/, "kept separate");
    assert.doesNotMatch(
      code,
      /release_export_unexplained [^\n]*SCRIPT_DIR/,
      "the gate must never be handed the operations checkout's copy"
    );
  });
});

// ---------------------------------------------------------------------------
// A8 and the removals — the deploy script itself
// ---------------------------------------------------------------------------
//
// Dual-view source assertions: the INDEX blob and the tracked working tree, naming which view failed.
// A staged-only or worktree-only edit is exactly the blind spot this closes.

function sourceViews(relPath) {
  const views = [];
  const staged = spawnSync("git", ["cat-file", "blob", `:${relPath}`], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  views.push({
    view: "index",
    available: staged.status === 0,
    text: staged.status === 0 ? staged.stdout : ""
  });
  views.push({
    view: "worktree",
    available: true,
    text: fs.readFileSync(path.join(REPO, relPath), "utf8")
  });
  return views;
}

/** Strip whole-line comments so an assertion cannot be satisfied by prose. */
function effective(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function bothViews(relPath, assertFn) {
  const views = sourceViews(relPath);
  const usable = views.filter((v) => v.available);
  assert.ok(usable.length >= 1, `${relPath}: no view of the file was readable`);
  for (const v of usable) {
    try {
      assertFn(v.text, effective(v.text));
    } catch (error) {
      throw new Error(`${relPath} [${v.view} view]: ${error.message}`);
    }
  }
  return usable.map((v) => v.view);
}

check("A8 no rsync of the operations working tree remains in the deploy path", () => {
  const views = bothViews("scripts/deploy-zero-downtime.sh", (_raw, code) => {
    assert.doesNotMatch(code, /\brsync\b/, "rsync must be gone from the deploy");
    assert.doesNotMatch(code, /git\s+reset\s+--hard/, "the deploy must not reset the operations working tree");
    assert.doesNotMatch(code, /git\s+checkout\s+"\$BRANCH"/, "the deploy must not check out a branch");
  });
  assert.ok(views.includes("worktree"), "the worktree view must have been checked");
});

check("the deploy sources the shipped export library rather than re-implementing it", () => {
  bothViews("scripts/deploy-zero-downtime.sh", (_raw, code) => {
    assert.match(code, /source "\$SCRIPT_DIR\/lib\/release-export\.sh"/, "the library must be sourced");
    for (const fn of [
      "release_export_validate_sha",
      "release_export_assert_commit",
      "release_export_assert_ancestor",
      "release_export_tree",
      "release_export_verify_blobs",
      "release_export_refuse_lfs",
      "release_export_unexplained"
    ]) {
      assert.match(code, new RegExp(`\\b${fn}\\b`), `the deploy must call ${fn}`);
    }
  });
});

check("the unnecessary deploy-time chmod is removed entirely", () => {
  bothViews("scripts/deploy-zero-downtime.sh", (_raw, code) => {
    assert.doesNotMatch(code, /\bchmod\b/, "no chmod may remain: an exact export must not mutate a tracked mode");
  });
  // ...and the reason it is unnecessary is a tracked fact, asserted here so a future reader does not
  // have to rediscover it: cron names the interpreter, and the only other consumer imports the module.
  const script = fs.readFileSync(path.join(REPO, "scripts", "nibrs-auto-update.py"), "utf8");
  assert.match(
    script,
    /\/usr\/bin\/python3 \/opt\/nibrs\/scripts\/nibrs-auto-update\.py/,
    "the script's own documented cron line must still invoke it through an explicit interpreter"
  );
  const importer = fs.readFileSync(
    path.join(REPO, "scripts", "test_build_juvenile_offender_incident_summary.py"),
    "utf8"
  );
  assert.match(importer, /spec_from_file_location\(/, "the only other consumer must still import it as a module");
});

check("the ineffective cp -al node_modules pre-copy is removed", () => {
  bothViews("scripts/deploy-zero-downtime.sh", (_raw, code) => {
    assert.doesNotMatch(code, /cp\s+-al/, "the hardlink pre-copy must be gone: npm ci discards it");
  });
});

check("the deploy requires a full SHA and refuses a bare branch invocation", () => {
  bothViews("scripts/deploy-zero-downtime.sh", (_raw, code) => {
    assert.match(code, /release_export_validate_sha/, "the SHA must be validated");
    assert.doesNotMatch(code, /BRANCH="\$\{1:-dev\}"/, "the first argument must no longer be a branch");
    assert.match(code, /DEPLOY_SHA=/, "the deploy must bind an explicit SHA");
  });
});

check("the closed-extras gate runs BEFORE the symlink switch", () => {
  bothViews("scripts/deploy-zero-downtime.sh", (_raw, code) => {
    const gate = code.indexOf("release_export_unexplained");
    const switchPoint = code.indexOf("mv -Tf");
    assert.ok(gate > 0, "the gate must be present");
    assert.ok(switchPoint > 0, "the symlink switch must still be present");
    assert.ok(gate < switchPoint, "an unexplained path must stop the deploy before publication");
  });
});

check("the export and its two refusals run before the build", () => {
  bothViews("scripts/deploy-zero-downtime.sh", (_raw, code) => {
    const exportAt = code.indexOf("release_export_tree");
    const equality = code.indexOf("release_export_verify_blobs");
    const lfs = code.indexOf("release_export_refuse_lfs");
    const build = code.indexOf("npm run build");
    assert.ok(exportAt > 0 && equality > exportAt, "equality must follow the export");
    assert.ok(lfs > exportAt, "the LFS refusal must follow the export");
    assert.ok(build > equality && build > lfs, "both refusals must precede the build");
  });
});

check("every changed shell file parses", () => {
  for (const rel of ["scripts/deploy-zero-downtime.sh", "scripts/lib/release-export.sh"]) {
    const result = spawnSync(BASH, ["-n", toBashPath(path.join(REPO, rel))], { encoding: "utf8" });
    assert.equal(result.status, 0, `${rel} must parse: ${result.stderr}`);
  }
});

check("what P1.4a commits carries no CR and no other control bytes", () => {
  // Asserted on the INDEX BLOB, not the bytes on disk. What is committed is checkout-independent;
  // the working tree is not. None of these paths declares `eol=lf`, so a `core.autocrlf=true`
  // checkout materialises them with CRLF quite legitimately -- prune-releases.sh already sits on disk
  // that way -- and asserting the worktree would fail in that checkout for a reason that says nothing
  // about what was committed. scripts/check-control-characters.py owns the worktree question, as its
  // verdict B.
  for (const rel of [
    "scripts/lib/release-export.sh",
    "scripts/fixtures/release-allowed-extras.json",
    "scripts/test-release-export.js"
  ]) {
    const blob = spawnSync("git", ["cat-file", "blob", `:${rel}`], {
      cwd: REPO,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024
    });
    if (blob.status !== 0) {
      // Unstaged: nothing to assert about a blob that does not exist yet, and saying so beats a
      // silent pass. The dual-view assertions above already report an unavailable index view.
      assert.ok(true, `${rel} is not staged; the index-blob byte check has nothing to read`);
      continue;
    }
    const bytes = blob.stdout;
    assert.equal(bytes.indexOf(13), -1, `${rel} must carry no CR in the index blob`);
    const control = bytes.filter((b) => b < 32 && b !== 9 && b !== 10).length;
    assert.equal(control, 0, `${rel} must carry no other control bytes in the index blob`);
  }
});

// ---------------------------------------------------------------------------
// non-vacuity
// ---------------------------------------------------------------------------

check("non-vacuity: the shipped library really defines every function asserted above", () => {
  const text = fs.readFileSync(LIB, "utf8");
  const defined = [...text.matchAll(/^([a-z_]+)\(\)\s*\{/gm)].map((m) => m[1]);
  for (const fn of [
    "release_export_validate_sha",
    "release_export_assert_commit",
    "release_export_assert_ancestor",
    "release_export_tree",
    "release_export_verify_blobs",
    "release_export_is_lfs_pointer",
    "release_export_refuse_lfs",
    "release_export_unexplained"
  ]) {
    assert.ok(defined.includes(fn), `${fn} must be defined in the shipped library, not only referenced`);
  }
  assert.ok(
    /sha256:\[0-9a-f\]\{64\}/.test(text),
    "the pointer predicate must actually constrain the oid, or A11's near-misses prove nothing"
  );
});

// ---------------------------------------------------------------------------

for (const dir of tempRoots) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* a temp directory that resists removal must not fail the suite */
  }
}

console.log("");
console.log(`release export: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAILED ${f.name}: ${f.message}`);
  process.exit(1);
}
