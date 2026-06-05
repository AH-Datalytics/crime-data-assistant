#!/usr/bin/env bash
# rollback.sh — Repoint /opt/nibrs/current to a previous release and reload PM2.
#
# Usage:
#   bash scripts/rollback.sh              # rollback to the previous release
#   bash scripts/rollback.sh <timestamp>  # rollback to a specific release
#   bash scripts/rollback.sh --list       # list available releases
#
# Run this ON THE VPS (ssh root@178.156.243.51).

set -euo pipefail

BASE_DIR="/opt/nibrs"
RELEASES_DIR="$BASE_DIR/releases"
CURRENT_LINK="$BASE_DIR/current"
PM2_APP="nibrs"
HEALTH_URL="http://localhost:3000"
HEALTH_TIMEOUT=15

log() { echo "[rollback] $(date +%H:%M:%S) $*"; }

# ── List releases ──────────────────────────────────────────────────────
list_releases() {
  CURRENT_TARGET=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")
  echo ""
  echo "Available releases in $RELEASES_DIR:"
  echo "──────────────────────────────────────────"
  for d in "$RELEASES_DIR"/*/; do
    [[ -d "$d" ]] || continue
    name=$(basename "$d")
    if [[ "$RELEASES_DIR/$name" == "$CURRENT_TARGET" ]]; then
      echo "  $name  ← CURRENT"
    else
      echo "  $name"
    fi
  done
  echo ""
}

if [[ "${1:-}" == "--list" || "${1:-}" == "-l" ]]; then
  list_releases
  exit 0
fi

# ── Determine target release ──────────────────────────────────────────
CURRENT_TARGET=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")
CURRENT_NAME=$(basename "$CURRENT_TARGET" 2>/dev/null || echo "")

if [[ -n "${1:-}" ]]; then
  # Explicit release specified
  TARGET_NAME="$1"
  TARGET_DIR="$RELEASES_DIR/$TARGET_NAME"
  [[ -d "$TARGET_DIR" ]] || { log "ERROR: Release '$TARGET_NAME' not found in $RELEASES_DIR"; list_releases; exit 1; }
else
  # Find the release immediately before the current one
  PREV=""
  for d in "$RELEASES_DIR"/*/; do
    [[ -d "$d" ]] || continue
    name=$(basename "$d")
    if [[ "$RELEASES_DIR/$name" == "$CURRENT_TARGET" ]]; then
      break
    fi
    PREV="$name"
  done

  if [[ -z "$PREV" ]]; then
    log "ERROR: No previous release found to rollback to."
    list_releases
    exit 1
  fi

  TARGET_NAME="$PREV"
  TARGET_DIR="$RELEASES_DIR/$TARGET_NAME"
fi

if [[ "$RELEASES_DIR/$TARGET_NAME" == "$CURRENT_TARGET" ]]; then
  log "Already pointing to $TARGET_NAME — nothing to do."
  exit 0
fi

# ── Rollback ───────────────────────────────────────────────────────────
log "Rolling back:"
log "  From: $CURRENT_NAME"
log "  To:   $TARGET_NAME"

# Verify the target has a .next build
if [[ ! -d "$TARGET_DIR/.next" ]]; then
  log "WARNING: $TARGET_DIR/.next does not exist — app may not start"
fi

# Atomic symlink switch
ln -sfn "$TARGET_DIR" "${CURRENT_LINK}.tmp"
mv -Tf "${CURRENT_LINK}.tmp" "$CURRENT_LINK"
log "Symlink updated."

# Reload PM2
log "Reloading PM2..."
pm2 reload "$PM2_APP" --update-env
sleep 3

# Health check
log "Running health check..."
STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$HEALTH_TIMEOUT" "${HEALTH_URL}/" 2>/dev/null || echo "000")
if [[ "$STATUS" =~ ^(200|304)$ ]]; then
  log "Health check passed: / → $STATUS"
else
  log "WARNING: Health check returned $STATUS — investigate immediately"
fi

log ""
log "Rollback complete."
log "  Now serving: $TARGET_NAME"
log "  Symlink: $CURRENT_LINK -> $(readlink -f "$CURRENT_LINK")"
log ""
