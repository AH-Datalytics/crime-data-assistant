// Behavioral tests for two Stage 0 operational guards that live outside the
// TypeScript modules: the digest's chart-audit coverage window, and the deploy
// script's release pinning + RELEASE_INFO stamping.
// Run: npx tsx scripts/test-stage0-operational-guards.ts
//
// Both are shell/CJS surfaces that the type checker cannot reach, and both
// failed in production in exactly the way an unexercised guard does: silently.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const repoRoot = path.resolve(__dirname, "..");

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    console.warn(`[test-stage0-operational-guards] could not remove ${dir}: ${(error as Error).message}`);
  }
}

/**
 * Locate a POSIX bash.
 *
 * On Windows a bare `bash` resolves to the WSL launcher, which is absent on a
 * normal workstation -- so this suite passed only for someone who had already
 * put Git Bash first on PATH. Git Bash is located explicitly instead: from
 * `git.exe` (either cmd\ or mingw64\bin\) walk up to the install root and take
 * bin\bash.exe, falling back to the standard install locations.
 */
function resolveBash(): string {
  if (process.platform !== "win32") return "bash";

  const candidates: string[] = [];
  try {
    const gitPaths = execFileSync("where", ["git"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const gitPath of gitPaths) {
      // C:\...\Git\cmd\git.exe  ->  C:\...\Git ; C:\...\Git\mingw64\bin\git.exe -> C:\...\Git
      const dir = path.dirname(gitPath);
      const roots = [path.resolve(dir, ".."), path.resolve(dir, "..", "..")];
      for (const root of roots) candidates.push(path.join(root, "bin", "bash.exe"));
    }
  } catch {
    /* `where` missing or git not on PATH; fall through to the fixed paths */
  }

  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  candidates.push(
    path.join(programFiles, "Git", "bin", "bash.exe"),
    path.join(programFilesX86, "Git", "bin", "bash.exe")
  );

  const found = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(
      `Could not locate Git Bash. Tried: ${candidates.join(", ")}. Install Git for Windows or put a POSIX bash on PATH.`
    );
  }
  return found;
}

const BASH = resolveBash();

// Platform branch self-check. The Linux path is a plain `bash` with identity
// path conversion; asserting it here means the branch is covered even when the
// suite happens to run on Windows.
if (process.platform !== "win32") {
  assert.equal(BASH, "bash", "non-Windows must use the PATH bash");
  assert.equal(toBashPath("/opt/nibrs/releases"), "/opt/nibrs/releases", "POSIX paths pass through unchanged");
} else {
  assert.ok(fs.existsSync(BASH), `resolved bash must exist: ${BASH}`);
  assert.equal(toBashPath("C:\\Users\\x\\repo"), "/c/Users/x/repo", "Windows paths must convert for Git Bash");
}

/** Convert a Windows path to the form Git Bash understands: C:\x -> /c/x */
function toBashPath(value: string): string {
  if (process.platform !== "win32") return value;
  const normalized = value.replace(/\\/g, "/");
  return normalized.replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
}

// ---------------------------------------------------------------------------
// 1. Digest chart-audit coverage window
// ---------------------------------------------------------------------------
//
// The digest must not certify a review period on the strength of a run that
// merely STARTED inside it. A run that began halfway through yesterday saw only
// the artifacts captured before it ran, so treating its start time as coverage
// would vouch for charts it never looked at.
//
// getChartAuditorHealth() closes over the module's cutoff/cutoffEnd, which are
// computed at import time from the current date. Rather than reach into that,
// the rule is re-expressed here against the same inputs and asserted against
// the source, so a change to the predicate breaks this test.
{
  const coversWindow = (finishedTs: number | null, cutoffEnd: number): boolean =>
    finishedTs !== null && finishedTs >= cutoffEnd;

  const cutoff = Date.UTC(2026, 7, 10);
  const cutoffEnd = Date.UTC(2026, 7, 11);
  const midWindow = Date.UTC(2026, 7, 10, 12);

  assert.equal(coversWindow(midWindow, cutoffEnd), false, "a run finishing mid-window must NOT certify the whole window");
  assert.equal(coversWindow(cutoffEnd, cutoffEnd), true, "finishing exactly at the boundary covers the window");
  assert.equal(coversWindow(cutoffEnd + 1, cutoffEnd), true, "finishing after the window covers it");
  assert.equal(coversWindow(cutoff - 1, cutoffEnd), false, "a run predating the window covers nothing");
  assert.equal(coversWindow(null, cutoffEnd), false, "an unfinished run has no watermark and covers nothing");

  // The digest must implement exactly this rule, keyed on finished_ts.
  const digest = fs.readFileSync(path.join(repoRoot, "scripts", "daily-query-analysis.js"), "utf8");
  assert.match(
    digest,
    /const coversWindow = finishedAt !== null && finishedAt >= cutoffEnd;/,
    "digest coverage must require completion through the window end"
  );
  assert.match(digest, /available: run\.status === "ok" && coversWindow/, "availability must depend on coverage");
  assert.ok(
    !/ranInWindow = Number\(run\.started_ts\) >= cutoff/.test(digest),
    "the start-time-only coverage rule must be gone"
  );
  // A 'running' row must read as interrupted, not as coverage.
  assert.match(digest, /never recorded a finish/, "an interrupted run must be described as interrupted");
}

// ---------------------------------------------------------------------------
// 2. Deploy script: release pinning
// ---------------------------------------------------------------------------
//
// Pruning keeps the last KEEP_RELEASES and previously protected only the
// current symlink target, so a baseline preserved for an observation window
// would age out while still needed. The pruning block is extracted and run
// against a fixture tree rather than executing the whole deploy script, which
// would build and restart an app.
{
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-prune-"));
  try {
    const releasesDir = path.join(workDir, "releases");
    fs.mkdirSync(releasesDir, { recursive: true });
    const names = ["20260801_000000", "20260802_000000", "20260803_000000", "20260804_000000", "20260805_000000", "20260806_000000", "20260807_000000"];
    for (const name of names) {
      fs.mkdirSync(path.join(releasesDir, name));
      fs.writeFileSync(path.join(releasesDir, name, "marker"), name);
    }
    // Pin the oldest -- the one "keep the last 5" would delete first.
    fs.writeFileSync(path.join(releasesDir, ".pinned"), "# baseline for the verified-answer observation window\n20260801_000000\n\n");
    const currentTarget = path.join(releasesDir, "20260807_000000");

    // Source and call the SHIPPED helper. An earlier revision of this test
    // pasted the pruning logic into a here-doc, which meant it could pass while
    // the deployed rule drifted -- it asserted a copy was correct, not that the
    // correct rule ships. scripts/lib/prune-releases.sh is now the single
    // definition, sourced both here and by deploy-zero-downtime.sh.
    const helper = toBashPath(path.join(repoRoot, "scripts", "lib", "prune-releases.sh"));
    const script = `
      set -euo pipefail
      source "${helper}"
      prune_releases "${toBashPath(releasesDir)}" "${toBashPath(currentTarget)}" 5 "${toBashPath(path.join(releasesDir, ".pinned"))}"
    `;
    const output = execFileSync(BASH, ["-c", script], { encoding: "utf8" });

    assert.match(output, /keep-pinned 20260801_000000/, "the pinned baseline must be kept");
    assert.ok(fs.existsSync(path.join(releasesDir, "20260801_000000")), "pinned release must survive pruning");
    assert.match(output, /remove 20260802_000000/, "unpinned surplus releases are still pruned");
    assert.ok(!fs.existsSync(path.join(releasesDir, "20260802_000000")), "unpinned release must be removed");
    assert.ok(fs.existsSync(currentTarget), "the current symlink target must survive");

    // The deploy script must call that same helper rather than reimplementing it.
    const deploy = fs.readFileSync(path.join(repoRoot, "scripts", "deploy-zero-downtime.sh"), "utf8");
    assert.match(deploy, /PINNED_FILE="\$RELEASES_DIR\/\.pinned"/, "deploy script must define the pin file");
    assert.match(deploy, /source "\$SCRIPT_DIR\/lib\/prune-releases\.sh"/, "deploy must source the shared pruning helper");
    assert.match(deploy, /prune_releases "\$RELEASES_DIR" "\$CURRENT_TARGET" "\$KEEP_RELEASES" "\$PINNED_FILE"/, "deploy must call the helper");
    assert.match(deploy, /Keeping \$\{decision#keep-pinned \} \(pinned\)/, "pinned keeps must be logged");
    // And must not carry a second, divergent copy of the rule.
    assert.ok(!/^\s*is_pinned\(\)/m.test(deploy), "deploy must not redefine is_pinned locally");
  } finally {
    removeDir(workDir);
  }
}

// ---------------------------------------------------------------------------
// 3. Deploy script: RELEASE_INFO provenance
// ---------------------------------------------------------------------------
//
// The stamp must be taken from the repo, where a .git exists -- not from the
// release directory, which is a copy that deliberately excludes .git. Reading it
// there yields commit=unknown: a file that looks like provenance while carrying
// none, which is worse than no file at all.
//
// P1.4a MOVED THE SOURCE OF PROVENANCE, so the literals below moved with it. The
// deploy no longer derives the commit from the repo's HEAD: HEAD is whatever a
// branch tip happens to be at fetch time, which is an input that can move between
// deciding to deploy and fetching. The operator now supplies an immutable
// 40-character SHA and the deploy proves three things about it before building --
// that it is well formed, that it is a commit present in the object store, and
// that it is an ancestor of origin/<branch>. That is strictly more provenance than
// reading HEAD ever gave, and it is asserted here rather than assumed.
{
  const deploy = fs.readFileSync(path.join(repoRoot, "scripts", "deploy-zero-downtime.sh"), "utf8");

  assert.match(deploy, /DEPLOY_COMMIT="\$DEPLOY_SHA"/, "the stamped commit must be the immutable input, not a resolved tip");
  assert.match(deploy, /DEPLOY_SHA="\$\{1:-\}"/, "the first argument must be the commit itself");
  assert.match(deploy, /release_export_validate_sha "\$DEPLOY_SHA"/, "the SHA must be validated before anything is built");
  assert.match(deploy, /release_export_assert_commit "\$REPO_DIR" "\$DEPLOY_SHA"/, "the object must be proven to exist and be a commit");
  assert.match(deploy, /release_export_assert_ancestor "\$REPO_DIR" "\$DEPLOY_SHA" "\$BRANCH"/, "the commit must be proven to be on the branch");
  assert.match(deploy, /is not a commit in/, "a SHA that is not a commit must abort the deploy");
  assert.match(deploy, /is not on origin\//, "a commit off the branch must abort the deploy");
  assert.match(deploy, /echo "commit=\$DEPLOY_COMMIT"/, "RELEASE_INFO must use the captured commit");
  assert.match(deploy, /refusing to build an unidentifiable release/, "an unwritable RELEASE_INFO must abort the deploy");

  // The old HEAD-derived form must be gone, not merely unused.
  assert.ok(
    !/DEPLOY_COMMIT=\$\(git .*rev-parse HEAD/.test(deploy),
    "provenance must not be derived from a branch tip that can move"
  );

  // Ordering: the commit must be bound and proven BEFORE the release directory is
  // created and exported into, so a bad input costs nothing. Anchored to line
  // starts so a mention inside a comment can neither satisfy nor break the check
  // -- an unanchored search matched this file's own explanatory comment once.
  const validateAt = deploy.search(/^release_export_validate_sha "\$DEPLOY_SHA"/m);
  const assignAt = deploy.search(/^DEPLOY_COMMIT="\$DEPLOY_SHA"/m);
  const ancestorAt = deploy.search(/^release_export_assert_ancestor /m);
  const mkReleaseAt = deploy.search(/^mkdir -p "\$RELEASE_DIR"/m);
  const exportAt = deploy.search(/^release_export_tree /m);
  const firstReleaseCd = deploy.search(/^cd "\$RELEASE_DIR"/m);

  assert.ok(validateAt > 0, "the SHA validation must exist");
  assert.ok(assignAt > 0, "the provenance assignment must exist");
  assert.ok(ancestorAt > 0, "the ancestry assertion must exist");
  assert.ok(mkReleaseAt > 0, "the release-directory creation must exist");
  assert.ok(exportAt > 0, "the export must exist");
  assert.ok(firstReleaseCd > 0, "the release-directory cd must exist");

  assert.ok(validateAt < mkReleaseAt, "the SHA must be validated before the release directory is created");
  assert.ok(ancestorAt < mkReleaseAt, "ancestry must be proven before the release directory is created");
  assert.ok(assignAt < mkReleaseAt, "provenance must be bound before the release directory is created");
  assert.ok(assignAt < exportAt, "provenance must be bound before the export runs");
  assert.ok(assignAt < firstReleaseCd, "provenance must be bound before cd into the release directory");

  // And the old form -- reading git from inside the release -- must be gone.
  assert.ok(
    !/git -C "\$RELEASE_DIR" rev-parse HEAD/.test(deploy),
    "must not read git metadata from the .git-less release copy"
  );

  // Sanity: the fields a rollback needs are all present.
  for (const field of ["release=", "commit=", "commit_subject=", "branch=", "built_at=", "built_by=", "host="]) {
    assert.ok(deploy.includes(`echo "${field}`), `RELEASE_INFO must record ${field}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Both shell scripts remain syntactically valid
// ---------------------------------------------------------------------------
for (const script of ["deploy-zero-downtime.sh", "nightly-audit-and-digest.sh", "lib/prune-releases.sh"]) {
  execFileSync(BASH, ["-n", toBashPath(path.join(repoRoot, "scripts", script))], { stdio: "pipe" });
}

// Guard against an unused import warning while keeping Database available for
// future coverage-window fixtures that need a real audit_runs table.
void Database;

console.log("stage0 operational guard tests passed");
