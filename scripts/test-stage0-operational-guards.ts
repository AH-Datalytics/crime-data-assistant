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

    // Mirrors the deploy script's Step 8. Kept in step by the source assertions
    // below, which fail if the real block stops honouring the pin file.
    const script = `
      set -euo pipefail
      RELEASES_DIR="${releasesDir.replace(/\\/g, "/")}"
      PINNED_FILE="$RELEASES_DIR/.pinned"
      CURRENT_TARGET="${currentTarget.replace(/\\/g, "/")}"
      KEEP_RELEASES=5
      cd "$RELEASES_DIR"
      if [[ -f "$PINNED_FILE" ]]; then
        PINNED=$(grep -vE '^\\s*(#|$)' "$PINNED_FILE" 2>/dev/null | tr -d '\\r' | sed 's/[[:space:]]*$//')
      else
        PINNED=""
      fi
      is_pinned() {
        local name="$1"
        [[ -z "$PINNED" ]] && return 1
        while IFS= read -r pin; do
          [[ -n "$pin" && "$pin" == "$name" ]] && return 0
        done <<< "$PINNED"
        return 1
      }
      RELEASE_COUNT=$(ls -1d */ 2>/dev/null | wc -l)
      if (( RELEASE_COUNT > KEEP_RELEASES )); then
        REMOVE_COUNT=$(( RELEASE_COUNT - KEEP_RELEASES ))
        CANDIDATES=$(ls -1d */ | head -n "$REMOVE_COUNT")
        while IFS= read -r old; do
          [[ -z "$old" ]] && continue
          NAME="\${old%/}"
          OLD_FULL="$RELEASES_DIR/$NAME"
          if [[ "$OLD_FULL" == "$CURRENT_TARGET" ]]; then
            echo "keep-current $NAME"
          elif is_pinned "$NAME"; then
            echo "keep-pinned $NAME"
          else
            echo "remove $NAME"
            rm -rf "$OLD_FULL"
          fi
        done <<< "$CANDIDATES"
      fi
    `;
    const output = execFileSync("bash", ["-c", script], { encoding: "utf8" });

    assert.match(output, /keep-pinned 20260801_000000/, "the pinned baseline must be kept");
    assert.ok(fs.existsSync(path.join(releasesDir, "20260801_000000")), "pinned release must survive pruning");
    assert.match(output, /remove 20260802_000000/, "unpinned surplus releases are still pruned");
    assert.ok(!fs.existsSync(path.join(releasesDir, "20260802_000000")), "unpinned release must be removed");
    assert.ok(fs.existsSync(currentTarget), "the current symlink target must survive");

    // The real script must contain the same guards.
    const deploy = fs.readFileSync(path.join(repoRoot, "scripts", "deploy-zero-downtime.sh"), "utf8");
    assert.match(deploy, /PINNED_FILE="\$RELEASES_DIR\/\.pinned"/, "deploy script must define the pin file");
    assert.match(deploy, /is_pinned "\$NAME"/, "pruning must consult the pin list");
    assert.match(deploy, /Keeping \$NAME \(pinned\)/, "pinned keeps must be logged");
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
{
  const deploy = fs.readFileSync(path.join(repoRoot, "scripts", "deploy-zero-downtime.sh"), "utf8");

  assert.match(deploy, /DEPLOY_COMMIT=\$\(git -C "\$REPO_DIR" rev-parse HEAD/, "commit must be read from REPO_DIR");
  assert.match(deploy, /refusing to build a release with no provenance/, "an unreadable HEAD must abort the deploy");
  assert.match(deploy, /echo "commit=\$DEPLOY_COMMIT"/, "RELEASE_INFO must use the captured commit");
  assert.match(deploy, /refusing to build an unidentifiable release/, "an unwritable RELEASE_INFO must abort the deploy");

  // The capture must happen before the working directory moves to the release.
  // Anchored to a line start so a mention inside a comment cannot satisfy or
  // break the ordering check -- an unanchored search matched this file's own
  // explanatory comment on the first run.
  const captureAt = deploy.indexOf("DEPLOY_COMMIT=$(git -C");
  const firstReleaseCd = deploy.search(/^cd "\$RELEASE_DIR"/m);
  assert.ok(captureAt > 0, "the provenance capture must exist");
  assert.ok(firstReleaseCd > 0, "the release-directory cd must exist");
  assert.ok(captureAt < firstReleaseCd, "provenance must be captured before cd into the release directory");

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
for (const script of ["deploy-zero-downtime.sh", "nightly-audit-and-digest.sh"]) {
  execFileSync("bash", ["-n", path.join(repoRoot, "scripts", script)], { stdio: "pipe" });
}

// Guard against an unused import warning while keeping Database available for
// future coverage-window fixtures that need a real audit_runs table.
void Database;

console.log("stage0 operational guard tests passed");
