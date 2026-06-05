#!/usr/bin/env bash
# deploy-zero-downtime.sh — Build in an isolated release directory,
# then atomically switch the /opt/nibrs/current symlink and reload PM2.
# If the build fails the live app is never touched.
#
# Usage:
#   bash scripts/deploy-zero-downtime.sh          # deploy from current git HEAD
#   bash scripts/deploy-zero-downtime.sh <branch>  # deploy a specific branch/tag
#
# Run this ON THE VPS (ssh root@178.156.243.51).

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────
BASE_DIR="/opt/nibrs"
RELEASES_DIR="$BASE_DIR/releases"
SHARED_DIR="$BASE_DIR/shared"
CURRENT_LINK="$BASE_DIR/current"
REPO_DIR="$BASE_DIR/repo"          # bare or full clone of the app repo
PM2_APP="nibrs"
KEEP_RELEASES=5
HEALTH_URL="http://localhost:3000"
HEALTH_TIMEOUT=15                   # seconds to wait for health check
BRANCH="${1:-dev}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RELEASE_DIR="$RELEASES_DIR/$TIMESTAMP"

# ── Helpers ────────────────────────────────────────────────────────────
log()  { echo "[deploy] $(date +%H:%M:%S) $*"; }
die()  { log "FATAL: $*"; exit 1; }

cleanup_on_failure() {
  log "Build failed — removing incomplete release $RELEASE_DIR"
  rm -rf "$RELEASE_DIR"
  log "Live app at $CURRENT_LINK is unchanged."
  exit 1
}

# ── Pre-flight checks ─────────────────────────────────────────────────
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
log "Fetching latest from origin..."
cd "$REPO_DIR"
git fetch origin
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

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
if ! grep -q 'NEXT_PUBLIC_ENABLE_HATE_CRIME=false' "$RELEASE_DIR/.env.local" 2>/dev/null && \
   ! grep -q 'NEXT_PUBLIC_ENABLE_HATE_CRIME=false' "$RELEASE_DIR/.env" 2>/dev/null; then
  die "NEXT_PUBLIC_ENABLE_HATE_CRIME=false not found in .env.local or .env. Set it in $SHARED_DIR/.env.local before deploying."
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
    # Still run npm ci to verify integrity, but it will be near-instant
  fi
fi

npm ci --production=false || die "npm ci failed"

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

# Check that /test renders and contains no Hate Crime text when the flag is off
HC_FLAG=$(grep -oP 'NEXT_PUBLIC_ENABLE_HATE_CRIME=\K.*' "$RELEASE_DIR/.env.local" 2>/dev/null || \
          grep -oP 'NEXT_PUBLIC_ENABLE_HATE_CRIME=\K.*' "$RELEASE_DIR/.env" 2>/dev/null || echo "")
if [[ "$HC_FLAG" == "false" || "$HC_FLAG" == "0" ]]; then
  TEST_HTML=$(curl -s "http://localhost:$PREFLIGHT_PORT/test" 2>/dev/null)
  if echo "$TEST_HTML" | grep -iqE 'Hate Crime|hate_crime'; then
    kill "$PREFLIGHT_PID" 2>/dev/null || true
    wait "$PREFLIGHT_PID" 2>/dev/null || true
    log "FATAL: /test page contains 'Hate Crime' text but ENABLE_HATE_CRIME=false"
    cleanup_on_failure
  fi
  log "  Preflight: /test contains no Hate Crime text (flag=false)"

  # Verify API returns 404
  HC_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H "Content-Type: application/json" -d '{"question":"test"}' \
    "http://localhost:$PREFLIGHT_PORT/api/hc-query" 2>/dev/null || echo "000")
  if [[ "$HC_STATUS" != "404" ]]; then
    kill "$PREFLIGHT_PID" 2>/dev/null || true
    wait "$PREFLIGHT_PID" 2>/dev/null || true
    log "FATAL: /api/hc-query returned $HC_STATUS, expected 404 when Hate Crime disabled"
    cleanup_on_failure
  fi
  log "  Preflight: /api/hc-query → 404 (correct)"
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

# ── Step 6: Reload PM2 ────────────────────────────────────────────────
log "Reloading PM2 app '$PM2_APP'..."
pm2 reload "$PM2_APP" --update-env

# Give workers time to restart
sleep 3

# ── Step 7: Health check ──────────────────────────────────────────────
log "Running health checks..."
HEALTHY=true

for path in "/" "/test"; do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$HEALTH_TIMEOUT" "${HEALTH_URL}${path}" 2>/dev/null || echo "000")
  if [[ "$STATUS" =~ ^(200|304)$ ]]; then
    log "  ${path} → $STATUS ✓"
  else
    log "  ${path} → $STATUS ✗"
    HEALTHY=false
  fi
done

if [[ "$HEALTHY" != "true" ]]; then
  log ""
  log "WARNING: Health check failed. The new release is live but may not be serving correctly."
  log "To rollback:  bash scripts/rollback.sh"
  log ""
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
log "Deploy complete."
log "  Release:  $RELEASE_DIR"
log "  Symlink:  $CURRENT_LINK -> $(readlink -f "$CURRENT_LINK")"
log "  PM2:      $(pm2 show "$PM2_APP" 2>/dev/null | grep status | head -1 || echo 'check pm2 status')"
log ""
