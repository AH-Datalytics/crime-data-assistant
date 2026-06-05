#!/usr/bin/env bash
# migrate-to-zero-downtime.sh — One-time migration from /opt/nibrs/app
# to the symlink-based release structure.
#
# Run ON THE VPS:  bash /path/to/migrate-to-zero-downtime.sh
#
# This script is idempotent — safe to re-run if a step fails partway through.
# It does NOT touch the running app until Step 6 (pm2 delete + start).

set -euo pipefail

BASE_DIR="/opt/nibrs"
SHARED_DIR="$BASE_DIR/shared"
RELEASES_DIR="$BASE_DIR/releases"
REPO_DIR="$BASE_DIR/repo"
OLD_APP="$BASE_DIR/app"

log() { echo "[migrate] $(date +%H:%M:%S) $*"; }
die() { log "FATAL: $*"; exit 1; }

# ── Step 1: Create directories ─────────────────────────────────────────
log "Step 1: Creating directories..."
mkdir -p "$RELEASES_DIR" "$SHARED_DIR" "$REPO_DIR"

# ── Step 2: Copy env and DB files into shared ──────────────────────────
log "Step 2: Copying shared files..."

# Environment files
for f in .env .env.local; do
  if [[ -f "$OLD_APP/$f" && ! -f "$SHARED_DIR/$f" ]]; then
    cp "$OLD_APP/$f" "$SHARED_DIR/$f"
    log "  Copied $f"
  elif [[ -f "$SHARED_DIR/$f" ]]; then
    log "  $f already in shared, skipping"
  else
    log "  WARNING: $OLD_APP/$f not found"
  fi
done

# Databases — use SQLite .backup for consistency (safe even if app is writing)
for db in query_log.db crime_data.db; do
  if [[ -f "$OLD_APP/$db" && ! -f "$SHARED_DIR/$db" ]]; then
    log "  Backing up $db via sqlite3 .backup (this may take a moment for large files)..."
    sqlite3 "$OLD_APP/$db" ".backup '$SHARED_DIR/$db'"
    log "  Backed up $db"
  elif [[ -f "$SHARED_DIR/$db" ]]; then
    log "  $db already in shared, skipping"
  else
    log "  WARNING: $OLD_APP/$db not found"
  fi
done

# ── Step 3: Verify feature flag ────────────────────────────────────────
log "Step 3: Checking feature flag..."
if grep -q '^NEXT_PUBLIC_ENABLE_HATE_CRIME=false' "$SHARED_DIR/.env.local" 2>/dev/null; then
  log "  NEXT_PUBLIC_ENABLE_HATE_CRIME=false confirmed"
else
  die "NEXT_PUBLIC_ENABLE_HATE_CRIME=false not found in $SHARED_DIR/.env.local. Add it before continuing."
fi

# ── Step 4: Clone or update repo ───────────────────────────────────────
log "Step 4: Setting up repo..."
if [[ ! -d "$REPO_DIR/.git" ]]; then
  git clone https://github.com/AH-Datalytics/crime-data-assistant.git "$REPO_DIR"
  log "  Cloned repo"
else
  log "  Repo already exists"
fi
cd "$REPO_DIR"
git fetch origin
git checkout dev
git reset --hard origin/dev
log "  Repo at $(git log --oneline -1)"

# ── Step 5: Build first release (bootstrap mode) ──────────────────────
log "Step 5: Building first release (BOOTSTRAP=1)..."
BOOTSTRAP=1 bash scripts/deploy-zero-downtime.sh dev

# At this point:
#   /opt/nibrs/current -> /opt/nibrs/releases/<timestamp>
#   The release has been built and preflight-tested
#   PM2 is still serving from /opt/nibrs/app (untouched)

# ── Step 6: Re-register PM2 ───────────────────────────────────────────
log "Step 6: Re-registering PM2 (brief cutover outage)..."
pm2 delete nibrs 2>/dev/null || true
cd "$BASE_DIR/current"
pm2 start ecosystem.config.js
pm2 save
log "  PM2 re-registered against /opt/nibrs/current"

# Give workers time to start
sleep 3

# ── Step 7: Verify ────────────────────────────────────────────────────
log "Step 7: Verifying..."
PASS=true

# PM2 cwd
PM2_CWD=$(pm2 show nibrs 2>/dev/null | grep "exec cwd" | awk '{print $NF}' || echo "unknown")
log "  PM2 cwd: $PM2_CWD"

# Health checks
for path in "/" "/test"; do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://localhost:3000${path}" 2>/dev/null || echo "000")
  if [[ "$STATUS" =~ ^(200|304)$ ]]; then
    log "  ${path} → $STATUS"
  else
    log "  ${path} → $STATUS  ← PROBLEM"
    PASS=false
  fi
done

# Hate Crime hidden on /test
if curl -s http://localhost:3000/test 2>/dev/null | grep -iqE 'Hate Crime|hate_crime'; then
  log "  /test contains Hate Crime text  ← LEAK"
  PASS=false
else
  log "  /test: no Hate Crime text"
fi

# API guard
HC_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Content-Type: application/json" -d '{"question":"test"}' \
  http://localhost:3000/api/hc-query 2>/dev/null || echo "000")
if [[ "$HC_STATUS" == "404" ]]; then
  log "  /api/hc-query → 404"
else
  log "  /api/hc-query → $HC_STATUS  ← expected 404"
  PASS=false
fi

if [[ "$PASS" == "true" ]]; then
  log ""
  log "Migration complete. All checks passed."
  log ""
  log "Next steps:"
  log "  1. Update crontab: change /opt/nibrs/app → /opt/nibrs/current"
  log "     Keep only:  0 12 * * * cd /opt/nibrs/current && node scripts/daily-query-analysis.js"
  log "     Remove the hate crime update cron (source is disabled)."
  log "  2. Leave /opt/nibrs/app alone for now. Archive it in a few days."
  log "  3. Future deploys:  cd /opt/nibrs/repo && bash scripts/deploy-zero-downtime.sh"
else
  log ""
  log "WARNING: Some checks failed. Investigate before proceeding."
  log "The old app at /opt/nibrs/app is still intact if you need to revert manually."
fi
log ""
