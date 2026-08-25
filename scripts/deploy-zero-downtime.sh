#!/usr/bin/env bash
# deploy-zero-downtime.sh — Build in an isolated release directory,
# then atomically switch the /opt/nibrs/current symlink and reload PM2.
# If the build fails the live app is never touched.
#
# THE RELEASE INPUT IS AN EXACT COMMIT, NOT A BRANCH. The first argument is a
# full 40-character SHA; the optional second names the branch that SHA must be an
# ancestor of (default dev). Naming a branch meant the operator never named the
# artifact they received -- the tip could move between deciding to deploy and
# fetching -- and an identity claim about "the tested commit" cannot rest on an
# input that moves.
#
# THE RELEASE IS EXPORTED FROM GIT OBJECTS, never copied from this repo's working
# tree. `git reset --hard` restores tracked files but removes neither untracked
# nor ignored ones, and no `git clean` ever ran, so whatever sat in the operations
# tree shipped: release 20260824_134957 carried three such paths, one of them a
# gitignored .pyc that `git status -uall` cannot even see. Anything in a release
# that is neither tracked at the deployed commit nor named in
# scripts/fixtures/release-allowed-extras.json now stops the deploy BEFORE the
# symlink switch.
#
# BOOTSTRAP NOTE -- READ BEFORE THE FIRST DEPLOYMENT AFTER P1.4a/P1.4c.
#
# This script, scripts/lib/release-export.sh and scripts/fixtures/release-allowed-extras.json are read
# from whatever checkout invokes them, and the deploy refuses to run unless all three match their blobs
# at the target SHA. Because the deploy no longer checks anything out, /opt/nibrs/repo's working tree
# stays wherever it was, so invoking this from there will correctly refuse the moment those files
# differ from the commit being deployed.
#
# THE EXACT INVOCATION. Export the bundle from the target commit and run it from there:
#
#   SHA=<40-char-sha>
#   git -C /opt/nibrs/repo fetch origin
#   rm -rf /tmp/deploy-$SHA && mkdir -p /tmp/deploy-$SHA
#   git -C /opt/nibrs/repo archive "$SHA" | tar -x -C /tmp/deploy-$SHA
#   bash /tmp/deploy-$SHA/scripts/deploy-zero-downtime.sh "$SHA" dev
#
# The scratch copy is only the BUNDLE. Everything P1.4c adds -- the receipt generator, the verifier,
# the manifest, toolchain and build-input policies, and the receipt schema -- runs from
# $RELEASE_DIR/scripts/... instead, i.e. from the release exported and blob-verified inside this run.
# That is deliberate: the release IS the target commit's tree, proven path by path, so its rules are
# that commit's rules by construction, and no drifted operations checkout can supply them.
#
# Usage:
#   bash scripts/deploy-zero-downtime.sh <40-char-sha>           # assert against dev
#   bash scripts/deploy-zero-downtime.sh <40-char-sha> <branch>  # assert against another branch
#   RUN_SCOREBOARD=1 bash scripts/deploy-zero-downtime.sh <40-char-sha>
#     # optional post-deploy quick scoreboard
#   RUN_SCOREBOARD=1 SCOREBOARD_MODE=full bash scripts/deploy-zero-downtime.sh <40-char-sha>
#     # optional post-deploy full scoreboard
#
# Bootstrap mode (first migration only — PM2 not yet registered):
#   BOOTSTRAP=1 bash scripts/deploy-zero-downtime.sh <40-char-sha>
#   Builds and preflight-tests the release, switches the symlink,
#   but skips pm2 reload and post-deploy health checks.
#
# Run this ON THE VPS (ssh root@178.156.243.51).

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────
BASE_DIR="/opt/nibrs"
RELEASES_DIR="$BASE_DIR/releases"
SHARED_DIR="$BASE_DIR/shared"
CURRENT_LINK="$BASE_DIR/current"
REPO_DIR="$BASE_DIR/repo"          # full clone via SSH deploy key
PM2_APP="nibrs"
KEEP_RELEASES=5
# Release names listed here are never pruned, regardless of KEEP_RELEASES.
# One name per line; blank lines and #-comments ignored.
PINNED_FILE="$RELEASES_DIR/.pinned"

# Pruning logic, shared with scripts/test-stage0-operational-guards.ts so the
# test cannot pass against a copy that has drifted from what deploys.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/prune-releases.sh
source "$SCRIPT_DIR/lib/prune-releases.sh"
# Release input: SHA validation, ancestry, object-store export, blob equality, the
# LFS-pointer refusal and the closed-extras gate. Shared with
# scripts/test-release-export.js for the same reason as the pruning helper: a test
# against a copy asserts that the copy is correct, not that the rule ships.
# shellcheck source=scripts/lib/release-export.sh
source "$SCRIPT_DIR/lib/release-export.sh"
# The allowlist the GATE uses is the one exported from the deployed commit, assigned after the export.
# This is only the executing bundle's own copy, used to prove the bundle matches that commit.
SELF_ALLOWED_EXTRAS="$SCRIPT_DIR/fixtures/release-allowed-extras.json"
ALLOWED_EXTRAS_FILE=""
HEALTH_URL="http://localhost:3000"
HEALTH_TIMEOUT=15                   # seconds to wait for health check
HEALTH_RETRIES="${HEALTH_RETRIES:-8}" # post-reload attempts; app can need ~45s to warm
HEALTH_RETRY_SLEEP="${HEALTH_RETRY_SLEEP:-8}"
DEPLOY_SHA="${1:-}"
BRANCH="${2:-dev}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RELEASE_DIR="$RELEASES_DIR/$TIMESTAMP"
BOOTSTRAP="${BOOTSTRAP:-0}"
SKIP_GIT="${SKIP_GIT:-0}"

# ── Helpers ────────────────────────────────────────────────────────────
log()  { echo "[deploy] $(date +%H:%M:%S) $*"; }
die()  { log "FATAL: $*"; exit 1; }

check_http_status() {
  local path="$1"
  curl -s -o /dev/null -w '%{http_code}' --max-time "$HEALTH_TIMEOUT" "${HEALTH_URL}${path}" 2>/dev/null || echo "000"
}

cleanup_on_failure() {
  log "Build failed — removing incomplete release $RELEASE_DIR"
  rm -rf "$RELEASE_DIR"
  log "Live app at $CURRENT_LINK is unchanged."
  exit 1
}

# ── Pre-flight checks ─────────────────────────────────────────────────
if [[ "$BOOTSTRAP" == "1" ]]; then
  log "BOOTSTRAP mode — will skip pm2 reload and post-deploy health checks"
fi
log "Starting zero-downtime deploy  sha=$DEPLOY_SHA  branch=$BRANCH  release=$TIMESTAMP"

# Refuse a bad input before touching the filesystem. A missing argument used to
# mean "deploy dev"; it now means nothing at all, on purpose.
if [[ -z "$DEPLOY_SHA" ]]; then
  die "No commit given. Usage: bash scripts/deploy-zero-downtime.sh <40-char-sha> [branch]"
fi
release_export_validate_sha "$DEPLOY_SHA" ||
  die "Refusing to deploy: the first argument must be a full 40-character commit SHA, not a branch or an abbreviation."

[[ -d "$SHARED_DIR" ]]  || die "$SHARED_DIR does not exist. Run the one-time migration first."
[[ -d "$RELEASES_DIR" ]] || die "$RELEASES_DIR does not exist. Run the one-time migration first."
[[ -d "$REPO_DIR" ]]     || die "$REPO_DIR does not exist. Clone the repo there first."

# Verify shared files exist
for f in .env .env.local; do
  [[ -f "$SHARED_DIR/$f" ]] || log "WARNING: $SHARED_DIR/$f not found — app may fail to start"
done
for db in crime_data.db query_log.db; do
  [[ -f "$SHARED_DIR/$db" ]] || log "WARNING: $SHARED_DIR/$db not found"
done

# ── Step 1: Fetch objects, prove the commit, export the release ────────
#
# The operations working tree is no longer an input. Nothing is checked out and
# nothing is reset; only the object store is read.
if [[ "$SKIP_GIT" == "1" ]]; then
  log "SKIP_GIT=1 — not fetching; $DEPLOY_SHA must already be in the object store"
else
  log "Fetching latest from origin..."
  git -C "$REPO_DIR" fetch origin || die "git fetch failed; cannot prove the commit is on $BRANCH"
fi

# The object must exist and be a commit, and it must be reachable from the branch
# named. The ancestry assertion is what stops an arbitrary pasted hash -- a side
# branch, an abandoned experiment, a reverted change -- becoming a release.
release_export_assert_commit "$REPO_DIR" "$DEPLOY_SHA" ||
  die "Refusing to deploy: $DEPLOY_SHA is not a commit in $REPO_DIR."
release_export_assert_ancestor "$REPO_DIR" "$DEPLOY_SHA" "$BRANCH" ||
  die "Refusing to deploy: $DEPLOY_SHA is not on origin/$BRANCH."

DEPLOY_COMMIT="$DEPLOY_SHA"
DEPLOY_COMMIT_SUBJECT=$(git --no-optional-locks -C "$REPO_DIR" log -1 --format=%s "$DEPLOY_SHA" 2>/dev/null || echo unknown)
log "  Deploying commit: $DEPLOY_COMMIT ($DEPLOY_COMMIT_SUBJECT)"
log "  Proven an ancestor of: origin/$BRANCH"

# THE RULES MUST COME FROM THE COMMIT BEING DEPLOYED. This script, its helper and its allowlist are
# read from whatever checkout the operator invoked, and since the deploy no longer checks anything out,
# that checkout drifts. Without this, a release could be built from SHA X while the rules deciding what
# may be inside it come from SHA Y -- and the gap widens with every future deployment.
log "Binding the deploy bundle to $DEPLOY_COMMIT..."
if ! BUNDLE_PROBLEMS=$(release_export_assert_self_matches "$REPO_DIR" "$DEPLOY_SHA" "$SCRIPT_DIR"); then
  while IFS= read -r line; do [[ -n "$line" ]] && log "  $line"; done <<< "$BUNDLE_PROBLEMS"
  die "The executing deploy bundle does not match $DEPLOY_SHA. Invoke the deploy script, its helper and its allowlist FROM THE TARGET COMMIT (see the bootstrap note at the top of this file). Nothing was created."
fi
log "  deploy script, helper and allowlist all match their blobs at $DEPLOY_COMMIT."

log "Creating release directory: $RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# Export the tracked tree of exactly that commit. `git archive` reads objects, so
# an untracked or ignored file in $REPO_DIR cannot be emitted -- the contamination
# channel is removed rather than reported.
log "Exporting the tracked tree of $DEPLOY_COMMIT..."
release_export_tree "$REPO_DIR" "$DEPLOY_SHA" "$RELEASE_DIR" ||
  { rm -rf "$RELEASE_DIR"; die "Export failed; live app untouched."; }

# Byte equality per path, not "the archive extracted cleanly": `export-ignore`
# omits a path and `export-subst` rewrites one, both while git exits 0.
log "Verifying every exported path against the commit tree..."
if ! EXPORT_PROBLEMS=$(release_export_verify_blobs "$REPO_DIR" "$DEPLOY_SHA" "$RELEASE_DIR"); then
  while IFS= read -r line; do [[ -n "$line" ]] && log "  EXPORT MISMATCH: $line"; done <<< "$EXPORT_PROBLEMS"
  rm -rf "$RELEASE_DIR"
  die "The export does not match the commit tree; live app untouched."
fi
log "  Export matches the commit tree on every tracked path."

# A committed LFS pointer IS the blob, so the equality check above passes on it and
# a release would publish a 130-byte text file where a database was expected.
if ! LFS_PROBLEMS=$(release_export_refuse_lfs "$REPO_DIR" "$DEPLOY_SHA" "$RELEASE_DIR"); then
  while IFS= read -r line; do [[ -n "$line" ]] && log "  $line"; done <<< "$LFS_PROBLEMS"
  rm -rf "$RELEASE_DIR"
  die "Refusing to publish a Git LFS pointer as file content; materialized LFS exports are not supported."
fi

# From here on the AUTHORITATIVE allowlist is the one exported from the deployed commit, whose bytes
# were just proven equal to that commit's blob. The executing bundle's copy is not consulted again.
ALLOWED_EXTRAS_FILE="$RELEASE_DIR/scripts/fixtures/release-allowed-extras.json"
[[ -f "$ALLOWED_EXTRAS_FILE" ]] || {
  rm -rf "$RELEASE_DIR"
  die "The exported tree of $DEPLOY_SHA has no scripts/fixtures/release-allowed-extras.json; refusing to judge a release with no closed set."
}

# ── Step 2: Symlink shared files into release ──────────────────────────
log "Linking shared files..."

# Environment files
for f in .env .env.local; do
  [[ -f "$SHARED_DIR/$f" ]] && ln -sf "$SHARED_DIR/$f" "$RELEASE_DIR/$f"
done

# Database files that the app expects relative to cwd
# (env vars point here; symlinks let fallback paths work too)
for db in crime_data.db query_log.db; do
  [[ -f "$SHARED_DIR/$db" ]] && ln -sf "$SHARED_DIR/$db" "$RELEASE_DIR/$db"
done

# ── Step 2b: Verify feature flags ──────────────────────────────────────
# NEXT_PUBLIC_ vars are baked into the client bundle at build time.
# If a flag is missing, the build will silently produce wrong behavior.
HC_FLAG=$(grep -oP 'NEXT_PUBLIC_ENABLE_HATE_CRIME=\K.*' "$RELEASE_DIR/.env.local" 2>/dev/null || \
          grep -oP 'NEXT_PUBLIC_ENABLE_HATE_CRIME=\K.*' "$RELEASE_DIR/.env" 2>/dev/null || echo "")
if [[ -z "$HC_FLAG" ]]; then
  die "NEXT_PUBLIC_ENABLE_HATE_CRIME not found in .env.local or .env. Set it in $SHARED_DIR/.env.local before deploying."
fi
if [[ "$HC_FLAG" != "true" && "$HC_FLAG" != "false" ]]; then
  die "NEXT_PUBLIC_ENABLE_HATE_CRIME='$HC_FLAG' — must be 'true' or 'false'."
fi
log "  NEXT_PUBLIC_ENABLE_HATE_CRIME=$HC_FLAG"
if [[ "$HC_FLAG" == "true" ]]; then
  if ! grep -q 'HATE_CRIME_DB_PATH=' "$RELEASE_DIR/.env.local" 2>/dev/null && \
     ! grep -q 'HATE_CRIME_DB_PATH=' "$RELEASE_DIR/.env" 2>/dev/null; then
    die "Hate Crime enabled but HATE_CRIME_DB_PATH not set. Add it to $SHARED_DIR/.env.local."
  fi
fi

# ── Step 3: Install dependencies ───────────────────────────────────────
log "Installing dependencies..."
cd "$RELEASE_DIR"

# A hardlink pre-copy of the previous release's node_modules used to sit here, on
# the theory that an unchanged package-lock made it reusable. `npm ci` removes and
# recreates node_modules unconditionally, so the copy was discarded moments later:
# it bought nothing and it put 26,798 files into the release before the closed-set
# gate could describe them. Removed.
npm ci --production=false || die "npm ci failed"

# Cron scripts run from this release dir — verify their runtime deps resolve
# here, or a missing package.json entry silently kills the cron for weeks
# (resend was absent June 5 – July 2, 2026: no daily email, no audit findings).
for dep in resend better-sqlite3; do
  node -e "require('$dep')" || die "cron runtime dep '$dep' does not resolve in release dir"
done

# INDEXED BY is a hard SQLite requirement. Refuse the release before the
# symlink switch if a rebuild removed an index the deterministic path needs.
NIBRS_DB_PATH="${NIBRS_DB_PATH:-$BASE_DIR/nibrs.db}"
REQUIRED_NIBRS_INDEXES=(
  idx_scm_ori_year
  idx_svcm_ori
  idx_nac_ori_year
  idx_sct_ori_year
  idx_sct_state_year
  idx_svd_new_ori_year
  idx_sod_new_ori_year
  idx_sad_new_ori_year
  idx_scd_ori_year
  idx_agencies_state_city_year
)
[[ -f "$NIBRS_DB_PATH" ]] || die "NIBRS database not found at $NIBRS_DB_PATH"
node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true });
  const required = process.argv.slice(2);
  const found = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = ? AND name IN (" +
    required.map(() => "?").join(",") + ")"
  ).all("index", ...required).map((row) => row.name));
  db.close();
  const missing = required.filter((name) => !found.has(name));
  if (missing.length) {
    console.error("Missing required NIBRS indexes: " + missing.join(", "));
    process.exit(1);
  }
' "$NIBRS_DB_PATH" "${REQUIRED_NIBRS_INDEXES[@]}" ||
  die "NIBRS deterministic-index preflight failed; run ensure_performance_indexes before deploying"
log "  NIBRS deterministic indexes present"

# ── Step 4: Build ──────────────────────────────────────────────────────
#
# Stamp the release with its own provenance BEFORE building, so an aborted build
# still leaves an identifiable directory.
#
# Until now a release directory contained no commit identifier at all, so
# mapping a release back to a commit meant inferring it from the VPS repo HEAD
# and deploy timestamps. That inference silently breaks the moment someone
# deploys a different branch, and it breaks exactly when it is needed most:
# during a rollback, when the question is "which release was known good?".
RELEASE_INFO_FILE="$RELEASE_DIR/RELEASE_INFO"
{
  echo "release=$TIMESTAMP"
  echo "commit=$DEPLOY_COMMIT"
  echo "commit_subject=$DEPLOY_COMMIT_SUBJECT"
  echo "branch=${BRANCH:-unknown}"
  echo "built_at=$(date -Is)"
  echo "built_by=$(whoami 2>/dev/null || echo unknown)"
  echo "host=$(hostname 2>/dev/null || echo unknown)"
} > "$RELEASE_INFO_FILE" || die "Could not write $RELEASE_INFO_FILE; refusing to build an unidentifiable release."
log "  Release provenance: $(tr '\n' ' ' < "$RELEASE_INFO_FILE")"

# ── Bind the build inputs BEFORE building ──────────────────────────────
#
# `next build` bakes NEXT_PUBLIC_* into the client bundle, so those values decide what the artifact
# IS. They come from .env/.env.local, which are symlinks into mutable shared storage, and from this
# process's own environment -- so reading them AFTER the build would record whatever shared state held
# at that later moment, not necessarily what Next compiled.
#
# So: capture the effective set now, refuse any undeclared name before a single file is built, then
# pass the captured values into the build EXPLICITLY. Next gives the process environment precedence
# over the env files, so exporting them pins exactly what was captured even if the shared files change
# underneath the build.
BUILD_INPUTS_SNAPSHOT="$(mktemp)"
# Removed on EVERY path -- success, die, an unexpected error, or a signal. An earlier version removed
# it only on the paths it happened to think of.
trap 'rm -f "$BUILD_INPUTS_SNAPSHOT"' EXIT

# ── Step 4: Build, with its inputs bound in the SAME PROCESS ───────────
#
# `next build` bakes NEXT_PUBLIC_* into the client bundle, so those values decide what the artifact IS.
# They come from .env/.env.local, which are symlinks into mutable shared storage, and from this
# process's environment.
#
# The build therefore runs INSIDE the capture step. That wrapper loads Next's own environment, refuses
# any undeclared public name before a single file is built, and then launches `npm run build` from that
# same environment -- so the values recorded are the values Next compiled against, by construction.
#
# WHAT THIS REPLACED, AND WHY. The previous shape captured in one process, marshalled the values through
# a NUL-delimited stream, exported them here, built, and then "verified" nothing had changed. That last
# check read back its own exports: it was self-fulfilling in this exact code path and only ever detected
# drift in tests, which inject an environment explicitly. One process removes the transport and the
# misleading assertion together.
log "Binding build inputs and building Next.js app..."
if ! node "$RELEASE_DIR/scripts/generate-release-receipt.js" \
      --release "$RELEASE_DIR" --capture-build-inputs "$BUILD_INPUTS_SNAPSHOT" --run-build true; then
  cd "$BASE_DIR"
  rm -rf "$RELEASE_DIR"
  log "Live app at $CURRENT_LINK is unchanged."
  die "Build failed, or refused to run against undeclared public build inputs."
fi
log "Build succeeded."

# The preflight assertions below must test the flag THE BUILD ACTUALLY USED. The grep at step 2b is a
# coarse early gate and cannot see an inherited value, quoting, expansion, or .env.production* -- so the
# authoritative value is re-read here from the snapshot the wrapper wrote, which is Next's own effective
# result. The comparison is done inside node and reported as a token, so command substitution cannot
# turn "true\n" into an accepted "true".
HC_FLAG=$(node -e '
const snap = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const value = snap.present.NEXT_PUBLIC_ENABLE_HATE_CRIME;
process.stdout.write(value === "true" ? "true" : value === "false" ? "false" : "not-exactly-true-or-false");
' "$BUILD_INPUTS_SNAPSHOT")
if [[ "$HC_FLAG" != "true" && "$HC_FLAG" != "false" ]]; then
  cd "$BASE_DIR"
  rm -rf "$RELEASE_DIR"
  log "Live app at $CURRENT_LINK is unchanged."
  die "The build's effective NEXT_PUBLIC_ENABLE_HATE_CRIME is $HC_FLAG; it must be exactly 'true' or 'false'."
fi
log "  effective NEXT_PUBLIC_ENABLE_HATE_CRIME=$HC_FLAG (from the environment the build compiled against)"

# ── Step 4b: Preflight — smoke-test the build before going live ────────
PREFLIGHT_PORT=3099
log "Running preflight smoke test on port $PREFLIGHT_PORT..."

# Start a temporary Next.js server from the release directory
cd "$RELEASE_DIR"
PORT=$PREFLIGHT_PORT node_modules/next/dist/bin/next start &
PREFLIGHT_PID=$!

# Wait for the server to be ready (up to 20 seconds)
PREFLIGHT_READY=false
for i in $(seq 1 20); do
  if curl -s -o /dev/null -w '' "http://localhost:$PREFLIGHT_PORT/" 2>/dev/null; then
    PREFLIGHT_READY=true
    break
  fi
  sleep 1
done

if [[ "$PREFLIGHT_READY" != "true" ]]; then
  kill "$PREFLIGHT_PID" 2>/dev/null || true
  wait "$PREFLIGHT_PID" 2>/dev/null || true
  cleanup_on_failure
fi

# Hate Crime preflight — verify /test content and API match the flag
TEST_HTML=$(curl -s "http://localhost:$PREFLIGHT_PORT/test" 2>/dev/null)
HC_API_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Content-Type: application/json" -d '{"question":"test"}' \
  "http://localhost:$PREFLIGHT_PORT/api/hc-query" 2>/dev/null || echo "000")

if [[ "$HC_FLAG" == "false" ]]; then
  # Disabled: no Hate Crime text on /test, API returns 404
  if echo "$TEST_HTML" | grep -iqE 'Hate Crime|hate_crime'; then
    kill "$PREFLIGHT_PID" 2>/dev/null || true
    wait "$PREFLIGHT_PID" 2>/dev/null || true
    log "FATAL: /test contains 'Hate Crime' text but ENABLE_HATE_CRIME=false"
    cleanup_on_failure
  fi
  log "  Preflight: /test contains no Hate Crime text (flag=false)"

  if [[ "$HC_API_STATUS" != "404" ]]; then
    kill "$PREFLIGHT_PID" 2>/dev/null || true
    wait "$PREFLIGHT_PID" 2>/dev/null || true
    log "FATAL: /api/hc-query returned $HC_API_STATUS, expected 404 when disabled"
    cleanup_on_failure
  fi
  log "  Preflight: /api/hc-query → 404 (correct)"

elif [[ "$HC_FLAG" == "true" ]]; then
  # Enabled: API must not be disabled. The landing guide may intentionally omit
  # Hate Crime even while the source remains available through routing/picker.
  # API may return 403 (page-token required) or 400 etc — only 404 is wrong.
  if [[ "$HC_API_STATUS" == "404" ]]; then
    kill "$PREFLIGHT_PID" 2>/dev/null || true
    wait "$PREFLIGHT_PID" 2>/dev/null || true
    log "FATAL: /api/hc-query returned 404 but ENABLE_HATE_CRIME=true"
    cleanup_on_failure
  fi
  log "  Preflight: /api/hc-query → $HC_API_STATUS (not 404, correct)"
fi

# Verify / returns 200
PREFLIGHT_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PREFLIGHT_PORT/" 2>/dev/null || echo "000")
if [[ ! "$PREFLIGHT_STATUS" =~ ^(200|304)$ ]]; then
  kill "$PREFLIGHT_PID" 2>/dev/null || true
  wait "$PREFLIGHT_PID" 2>/dev/null || true
  log "FATAL: Preflight / returned $PREFLIGHT_STATUS"
  cleanup_on_failure
fi
log "  Preflight: / → $PREFLIGHT_STATUS"

# Stop preflight server
kill "$PREFLIGHT_PID" 2>/dev/null || true
wait "$PREFLIGHT_PID" 2>/dev/null || true
log "Preflight passed."

# ── Step 4b2: Receipt — the artifact's identity, recorded after the build ──
#
# `.next` is NOT reproducible: Next leaves generateBuildId at its default, which falls back to nanoid,
# and the five live releases carry five distinct random ids. `next build` also embeds the absolute
# release path in its output. So nothing here compares two builds; the bytes are digested ONCE, now,
# and every later check proves the running bytes are still these bytes.
#
# EVERYTHING RUNS FROM THE EXPORTED RELEASE, not from this checkout: the generator, the manifest
# policy, the toolchain policy, the build-input allowlist and the receipt schema. The export was
# already proven blob-equal to $DEPLOY_SHA, so those are that commit's rules by construction. Using
# $SCRIPT_DIR here would reintroduce exactly the drift the bundle binding exists to prevent.
log "Generating the release receipt from the exported tree..."
RECEIPT_BUILT_AT_START=$(grep -m1 '^built_at=' "$RELEASE_INFO_FILE" | cut -d= -f2- || echo unknown)
# The receipt is generated from the PRE-BUILD snapshot, and the generator additionally recomputes the
# effective set and refuses if it drifted -- the artifact was compiled against the earlier values, so a
# receipt describing later ones would be describing something that was never built.
if ! node "$RELEASE_DIR/scripts/generate-release-receipt.js" \
      --release "$RELEASE_DIR" --repo "$REPO_DIR" --sha "$DEPLOY_SHA" --branch "$BRANCH" \
      --built-at-start "$RECEIPT_BUILT_AT_START" --build-inputs "$BUILD_INPUTS_SNAPSHOT"; then
  cd "$BASE_DIR"
  rm -rf "$RELEASE_DIR"
  log "Live app at $CURRENT_LINK is unchanged."
  die "Could not generate the release receipt; refusing to publish an unidentifiable artifact."
fi

# ── Step 4c: Closed-set gate — the LAST check before publication ───────
#
# Everything a release may contain beyond the commit's tracked tree is named in
# scripts/fixtures/release-allowed-extras.json: four shared symlinks, RELEASE_INFO,
# next-env.d.ts, and the .next and node_modules trees. Anything else stops the
# deploy HERE, before the symlink moves, because recording an unexplained path is
# not an identity proof -- the three that shipped in release 20260824_134957 sat in
# production for weeks and one of them was invisible to `git status -uall`.
#
# This runs after the build so it sees the release exactly as it will be published.
log "Checking the release contains nothing unexplained..."
if ! UNEXPLAINED=$(release_export_unexplained "$REPO_DIR" "$DEPLOY_SHA" "$RELEASE_DIR" "$ALLOWED_EXTRAS_FILE"); then
  while IFS= read -r line; do [[ -n "$line" ]] && log "  $line"; done <<< "$UNEXPLAINED"
  # Step 3 left the working directory inside the release; leave it before removing
  # the release, or the remaining commands run from a directory that no longer exists.
  cd "$BASE_DIR"
  rm -rf "$RELEASE_DIR"
  log "Live app at $CURRENT_LINK is unchanged."
  die "The release contains content that is neither tracked at $DEPLOY_SHA nor a permitted addition; refusing to publish."
fi
log "  Nothing unexplained: every path is tracked at $DEPLOY_SHA or a declared addition."

# ── Step 4d: Pre-switch verification — gates L2 and L3 ─────────────────
#
# Source exactness and artifact-vs-receipt agreement, checked while a failure still costs nothing: the
# incomplete release is removed and `current` never moves. L1 (a qualifying hosted run) and L6
# (toolchain alignment) are REPORTED here, never gated -- L6 fails on every deploy until the Node
# alignment lands, and a gate that blocked every deploy would be switched off within a day.
log "Verifying the artifact against its receipt (pre-switch: gates L2 and L3)..."
if ! node "$RELEASE_DIR/scripts/verify-deployed-artifact.js" \
      --release "$RELEASE_DIR" --repo "$REPO_DIR" --stage pre-switch; then
  cd "$BASE_DIR"
  rm -rf "$RELEASE_DIR"
  log "Live app at $CURRENT_LINK is unchanged."
  die "Pre-switch verification failed; refusing to publish."
fi

# ── Step 5: Atomic symlink switch ──────────────────────────────────────
log "Switching symlink: $CURRENT_LINK -> $RELEASE_DIR"

# ln -sfn is atomic on Linux (single rename() syscall for the temp link)
ln -sfn "$RELEASE_DIR" "${CURRENT_LINK}.tmp"
mv -Tf "${CURRENT_LINK}.tmp" "$CURRENT_LINK"

log "Symlink updated."

# Keep VPS utility scripts versioned with the active release. Cron calls
# /opt/nibrs/scripts/nibrs-auto-update.py; point that path at /opt/nibrs/current
# so rollback automatically rolls the script back too.
log "Linking VPS utility scripts..."
mkdir -p "$BASE_DIR/scripts"
if [[ ! -f "$CURRENT_LINK/scripts/nibrs-auto-update.py" ]]; then
  die "Missing scripts/nibrs-auto-update.py in current release."
fi
# A `chmod +x` on that path used to sit here. It was the only mode mutation in the
# deploy, and it ran AFTER publication, so an exact export was still being altered
# once live. The bit is also unnecessary: the script's own documented cron line is
# `/usr/bin/python3 /opt/nibrs/scripts/nibrs-auto-update.py`, which names the
# interpreter, and the only other consumer -- test_build_juvenile_offender_incident
# _summary.py -- imports it as a module through spec_from_file_location. Every
# tracked file in this repository is mode 100644, so committing 100755 would have
# added the tree's sole executable to grant a permission nothing uses. Removed.
ln -sfn "$CURRENT_LINK/scripts/nibrs-auto-update.py" "$BASE_DIR/scripts/nibrs-auto-update.py"
log "  $BASE_DIR/scripts/nibrs-auto-update.py -> $CURRENT_LINK/scripts/nibrs-auto-update.py"

# ── Step 6: Reload PM2 (skip in bootstrap mode) ──────────────────────
if [[ "$BOOTSTRAP" == "1" ]]; then
  log "BOOTSTRAP mode — skipping pm2 reload."
  log "Next step: pm2 delete nibrs && cd /opt/nibrs/current && pm2 start ecosystem.config.js && pm2 save"
else
  log "Reloading PM2 app '$PM2_APP'..."
  # Reload from the active ecosystem file so newly added runtime paths apply.
  pm2 reload "$CURRENT_LINK/ecosystem.config.js" --only "$PM2_APP" --update-env

  # Give workers time to restart
  sleep 3

  # ── Step 7: Health check ──────────────────────────────────────────────
  log "Running health checks (up to $HEALTH_RETRIES attempts; timeout=${HEALTH_TIMEOUT}s, sleep=${HEALTH_RETRY_SLEEP}s)..."
  HEALTHY=false

  for attempt in $(seq 1 "$HEALTH_RETRIES"); do
    ATTEMPT_OK=true
    for path in "/" "/test"; do
      STATUS=$(check_http_status "$path")
      if [[ "$STATUS" =~ ^(200|304)$ ]]; then
        log "  attempt ${attempt}/${HEALTH_RETRIES}: ${path} -> $STATUS ok"
      else
        log "  attempt ${attempt}/${HEALTH_RETRIES}: ${path} -> $STATUS"
        ATTEMPT_OK=false
      fi
    done
    if [[ "$ATTEMPT_OK" == "true" ]]; then
      HEALTHY=true
      break
    fi
    if (( attempt < HEALTH_RETRIES )); then
      sleep "$HEALTH_RETRY_SLEEP"
    fi
  done

  if [[ "$HEALTHY" != "true" ]]; then
    log ""
    log "WARNING: Health check failed. The new release is live but may not be serving correctly."
    log "To rollback:  bash scripts/rollback.sh"
    log ""
  fi

  # ── Step 7b: Post-reload verification — reports L4 and L5 ────────────
  #
  # Did the symlink land on the receipted release, and did EVERY worker load it? Worker identity comes
  # from /proc/<pid>/cwd -- resolved by the kernel at chdir time, so it does not re-follow a symlink
  # that has since moved -- and from the absolute paths of natively mapped code, which is loaded code
  # rather than a claim. Disagreement is reported per pid, because a partial reload is a split.
  #
  # NO AUTOMATIC ROLLBACK, ever. A verifier that moves production is a verifier that can take the site
  # down over its own bug. This reports, exits non-zero, and leaves the decision to a person.
  log "Verifying the published release and its workers (post-reload: reports L4 and L5)..."
  if ! node "$CURRENT_LINK/scripts/verify-deployed-artifact.js" \
        --release "$CURRENT_LINK" --repo "$REPO_DIR" --current "$CURRENT_LINK" \
        --app "$PM2_APP" --stage post-reload; then
    log ""
    log "WARNING: post-reload verification reported a problem. The release IS live."
    log "Nothing was rolled back automatically. To roll back:  bash scripts/rollback.sh"
    log ""
  fi
fi

# ── Step 8: Cleanup old releases ──────────────────────────────────────
#
# Two releases are protected from pruning: the one the symlink currently points
# at, and any release listed in $PINNED_FILE.
#
# Pinning exists because "keep the last N" is not a rollback guarantee. A
# baseline preserved for a migration's observation window is exactly the release
# that ages out of the window while it is still needed -- five deploys after
# pinning, the artifact you planned to roll back to is gone. A git tag does not
# help: it preserves the source, not the built release directory, and rebuilding
# is not the same artifact.
#
# To pin:    echo 20260811_151557 >> /opt/nibrs/releases/.pinned
# To unpin:  remove that line (requires owner approval while an observation
#            window is open -- see docs/runbooks/2026-08-11-rollback-and-backup-manifest.md)
log "Pruning old releases (keeping last $KEEP_RELEASES)..."

CURRENT_TARGET=$(readlink -f "$CURRENT_LINK")
PINNED_NAMES="$(prune_read_pinned "$PINNED_FILE")"
if [[ -n "$PINNED_NAMES" ]]; then
  log "  Pinned releases (never pruned): $(echo "$PINNED_NAMES" | tr '\n' ' ')"
fi

# The pruning rule itself lives in scripts/lib/prune-releases.sh so that its
# test exercises the shipped code rather than a copy of it. Decisions come back
# on stdout and are mirrored into the deploy log here.
while IFS= read -r decision; do
  [[ -z "$decision" ]] && continue
  case "$decision" in
    "keep-current "*) log "  Keeping ${decision#keep-current } (current symlink target)" ;;
    "keep-pinned "*)  log "  Keeping ${decision#keep-pinned } (pinned)" ;;
    "remove "*)       log "  Removing old release: ${decision#remove }" ;;
    *)                log "  $decision" ;;
  esac
done < <(prune_releases "$RELEASES_DIR" "$CURRENT_TARGET" "$KEEP_RELEASES" "$PINNED_FILE")

# ── Done ───────────────────────────────────────────────────────────────
log ""
if [[ "$BOOTSTRAP" == "1" ]]; then
  log "Bootstrap deploy complete."
  log "  Release:  $RELEASE_DIR"
  log "  Symlink:  $CURRENT_LINK -> $(readlink -f "$CURRENT_LINK")"
  log ""
  log "PM2 was NOT reloaded. To finish migration:"
  log "  pm2 delete nibrs"
  log "  cd /opt/nibrs/current && pm2 start ecosystem.config.js && pm2 save"
else
  log "Deploy complete."
  log "  Release:  $RELEASE_DIR"
  log "  Symlink:  $CURRENT_LINK -> $(readlink -f "$CURRENT_LINK")"
  log "  PM2:      $(pm2 show "$PM2_APP" 2>/dev/null | grep status | head -1 || echo 'check pm2 status')"

  # Model-free: persist a production-traffic latency baseline for every release
  # without adding application traffic or API cost.
  log "  Recording 24-hour latency scoreboard..."
  (cd "$CURRENT_LINK" && npx tsx scripts/nightly-latency-scoreboard.ts --hours 24) >> /var/log/latency-scoreboard.log 2>&1 || log "  WARNING: latency scoreboard failed; see /var/log/latency-scoreboard.log"

  # Optional post-deploy scoreboard in the BACKGROUND. It is opt-in because
  # replaying queries can create material API cost, especially across repeated
  # deploys. Use RUN_SCOREBOARD=1 SCOREBOARD_MODE=quick|full when needed.
  if [[ "${RUN_SCOREBOARD:-0}" == "1" ]]; then
    SCOREBOARD_ARGS="--quick"
    if [[ "${SCOREBOARD_MODE:-quick}" == "full" ]]; then
      SCOREBOARD_ARGS=""
    fi
    log "  Launching post-deploy ${SCOREBOARD_MODE:-quick} scoreboard in background (log: /var/log/scoreboard.log)..."
    nohup bash -c "cd '$CURRENT_LINK' && npx tsx scripts/nightly-scoreboard.ts $SCOREBOARD_ARGS" >> /var/log/scoreboard.log 2>&1 &
  else
    log "  Post-deploy scoreboard skipped (set RUN_SCOREBOARD=1 to run it)."
  fi
fi
log ""
