#!/usr/bin/env bash
# deploy-zero-downtime.sh — Build in an isolated release directory,
# then atomically switch the /opt/nibrs/current symlink and reload PM2.
# If the build fails the live app is never touched.
#
# Usage:
#   bash scripts/deploy-zero-downtime.sh          # deploy HEAD of dev
#   bash scripts/deploy-zero-downtime.sh <branch>  # deploy a specific branch/tag
#   RUN_SCOREBOARD=1 bash scripts/deploy-zero-downtime.sh dev
#     # optional post-deploy quick scoreboard
#   RUN_SCOREBOARD=1 SCOREBOARD_MODE=full bash scripts/deploy-zero-downtime.sh dev
#     # optional post-deploy full scoreboard
#
# Bootstrap mode (first migration only — PM2 not yet registered):
#   BOOTSTRAP=1 bash scripts/deploy-zero-downtime.sh dev
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
HEALTH_URL="http://localhost:3000"
HEALTH_TIMEOUT=15                   # seconds to wait for health check
HEALTH_RETRIES="${HEALTH_RETRIES:-8}" # post-reload attempts; app can need ~45s to warm
HEALTH_RETRY_SLEEP="${HEALTH_RETRY_SLEEP:-8}"
BRANCH="${1:-dev}"
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
log "Starting zero-downtime deploy  branch=$BRANCH  release=$TIMESTAMP"

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

# ── Step 1: Update repo and create release directory ───────────────────
cd "$REPO_DIR"
if [[ "$SKIP_GIT" == "1" ]]; then
  log "SKIP_GIT=1 — using existing repo working tree without fetch/reset"
else
  log "Fetching latest from origin..."
  git fetch origin
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
fi

log "Creating release directory: $RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# Copy app files (exclude .git, node_modules, db files, .next build cache)
rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='*.db' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  "$REPO_DIR/" "$RELEASE_DIR/"

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

# Reuse node_modules from the previous release if package-lock hasn't changed
PREV_RELEASE=$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)
if [[ -n "$PREV_RELEASE" && -d "$PREV_RELEASE/node_modules" ]]; then
  if diff -q "$PREV_RELEASE/package-lock.json" "$RELEASE_DIR/package-lock.json" >/dev/null 2>&1; then
    log "package-lock.json unchanged — copying node_modules from previous release"
    cp -al "$PREV_RELEASE/node_modules" "$RELEASE_DIR/node_modules"
  fi
fi

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
log "Building Next.js app..."
trap cleanup_on_failure ERR
npm run build
trap - ERR
log "Build succeeded."

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
chmod +x "$CURRENT_LINK/scripts/nibrs-auto-update.py"
ln -sfn "$CURRENT_LINK/scripts/nibrs-auto-update.py" "$BASE_DIR/scripts/nibrs-auto-update.py"
log "  $BASE_DIR/scripts/nibrs-auto-update.py -> $CURRENT_LINK/scripts/nibrs-auto-update.py"

# ── Step 6: Reload PM2 (skip in bootstrap mode) ──────────────────────
if [[ "$BOOTSTRAP" == "1" ]]; then
  log "BOOTSTRAP mode — skipping pm2 reload."
  log "Next step: pm2 delete nibrs && cd /opt/nibrs/current && pm2 start ecosystem.config.js && pm2 save"
else
  log "Reloading PM2 app '$PM2_APP'..."
  pm2 reload "$PM2_APP" --update-env

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
fi

# ── Step 8: Cleanup old releases ──────────────────────────────────────
log "Pruning old releases (keeping last $KEEP_RELEASES)..."
cd "$RELEASES_DIR"
RELEASE_COUNT=$(ls -1d */ 2>/dev/null | wc -l)
if (( RELEASE_COUNT > KEEP_RELEASES )); then
  REMOVE_COUNT=$(( RELEASE_COUNT - KEEP_RELEASES ))
  ls -1d */ | head -n "$REMOVE_COUNT" | while read -r old; do
    # Never delete the release currently pointed to by the symlink
    CURRENT_TARGET=$(readlink -f "$CURRENT_LINK")
    OLD_FULL="$RELEASES_DIR/${old%/}"
    if [[ "$OLD_FULL" != "$CURRENT_TARGET" ]]; then
      log "  Removing old release: $old"
      rm -rf "$RELEASES_DIR/$old"
    fi
  done
fi

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
