#!/usr/bin/env bash
# release.sh <40-char sha> -- deploy, check and, on any failure, roll back by itself, entirely on the server.
# Design: docs/superpowers/specs/2026-10-27-server-side-release-design.md (Codex ACCEPT-WITH-CHANGES, folded in).
#
# Run it from the exported bundle of the SHA, detached, then read the result whenever convenient:
#   ssh root@VPS 'cd /tmp && nohup bash /tmp/deploy-$SHA/scripts/release.sh $SHA > /dev/null 2>&1 &'
#   ssh root@VPS 'cat /opt/nibrs/release-logs/$SHA.latest'
# A dropped laptop connection changes nothing.
#
# Steps: one shared lock (release, deploy and rollback all take it) -> the NIBRS maintenance lock held throughout
# -> Studio stops claiming jobs and drains -> the live release, its commit and its scheduler link are recorded and
# the release is pinned against pruning -> the check questions are asked of the live release -> deploy-zero-downtime
# (bounded; a slow build cannot switch late) -> the switch state is read from the link, not from the deploy's exit
# code -> identity, health and the same questions on the new release -> LIVE, or a verified rollback.
#
# Results (one file per attempt, written atomically; <sha>.latest points at the newest):
#   LIVE                     the new release passed every check
#   NOT DEPLOYED             production was never touched (lock held, Studio busy, baseline unusable, build failed
#                            before the switch, ...)
#   ROLLED BACK              the new release was switched in, failed a check, and the previous release is verified
#                            live again (commit, every worker's loaded release, health)
#   ROLLBACK NOT CONFIRMED   the rollback could not be verified: exit 3 and a notification; act at once
# Scope: code releases compatible with the current shared data. Rolling back never undoes a database change.
set -u -o pipefail

SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: release.sh <40-character commit sha>" >&2; exit 64; }

BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${NIBRS_ROOT:=/opt/nibrs}"
CURRENT_LINK="$NIBRS_ROOT/current"
RELEASES_DIR="$NIBRS_ROOT/releases"
PINNED_FILE="$RELEASES_DIR/.pinned"
UTIL_LINK="$NIBRS_ROOT/scripts/nibrs-auto-update.py"
: "${RELEASE_LOG_DIR:=$NIBRS_ROOT/release-logs}"
: "${RELEASE_LOCK:=$NIBRS_ROOT/release.lock}"
: "${NIBRS_MAINTENANCE_LOCK:=$NIBRS_ROOT/maintenance.lock}"
: "${QUERY_LOG_DB:=$NIBRS_ROOT/shared/query_log.db}"
: "${RELEASE_BASE_URL:=https://nibrsai.com}"
: "${RELEASE_DEPLOY_CMD:=bash $BUNDLE/scripts/deploy-zero-downtime.sh}"
: "${RELEASE_ROLLBACK_CMD:=bash $BUNDLE/scripts/rollback.sh}"
: "${STUDIO_CTL:=/usr/bin/node /opt/studio/current/packages/db/dist/cli.js}"
: "${RELEASE_NOTIFY_CMD:=logger -t cda-release}"
: "${SQLITE:=sqlite3}"
: "${STUDIO_DRAIN_MAX:=600}"   # seconds to wait for running Studio jobs to finish before giving up untouched
: "${DEPLOY_MAX:=1200}"        # build and switch
: "${CHECK_MAX:=420}"          # health and answer checks after the switch
: "${ROLLBACK_MAX:=300}"       # the rollback's own time, never shared with the checks
QUESTIONS="$BUNDLE/scripts/fixtures/release-checks/questions.json"
EXPECTED="$BUNDLE/scripts/fixtures/release-checks/expected-changes.json"

ATTEMPT="$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$RELEASE_LOG_DIR" || { echo "cannot create $RELEASE_LOG_DIR" >&2; exit 2; }
export WORK="$RELEASE_LOG_DIR/$SHA.$ATTEMPT"
mkdir -p "$WORK" || exit 2
LOG="$WORK/release.log"
exec >> "$LOG" 2>&1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
# shellcheck source=scripts/lib/bounded-run.sh
source "$BUNDLE/scripts/lib/bounded-run.sh"
# shellcheck source=scripts/lib/release-health.sh
source "$BUNDLE/scripts/lib/release-health.sh"

TARGET="" TARGET_COMMIT="" UTIL_PRIOR="" PINNED_BY_US=0 STUDIO_TOKEN="" FINISHED=0

# The result for this attempt, written atomically, then the .latest pointer (also atomic).
result() {
  local state="$1" reason="$2" f="$RELEASE_LOG_DIR/$SHA.$ATTEMPT.result"
  {
    echo "RESULT=$state"
    echo "REASON=$reason"
    echo "SHA=$SHA"
    echo "ATTEMPT=$ATTEMPT"
    echo "LIVE_RELEASE=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo unreadable)"
    echo "ROLLBACK_TARGET=$TARGET"
    echo "ROLLBACK_TARGET_COMMIT=$TARGET_COMMIT"
    echo "LOG=$LOG"
    echo "AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$f.tmp" && mv -f "$f.tmp" "$f"
  cp -f "$f" "$RELEASE_LOG_DIR/$SHA.latest.tmp" && mv -f "$RELEASE_LOG_DIR/$SHA.latest.tmp" "$RELEASE_LOG_DIR/$SHA.latest"
  log "RESULT=$state ($reason)"
}

cleanup() {
  if (( PINNED_BY_US )) && [[ -f "$PINNED_FILE" ]]; then
    grep -vxF "$(basename "$TARGET") # release.sh $ATTEMPT" "$PINNED_FILE" > "$PINNED_FILE.tmp"; mv -f "$PINNED_FILE.tmp" "$PINNED_FILE"
  fi
  [[ -n "$STUDIO_TOKEN" ]] && $STUDIO_CTL unlock "$STUDIO_TOKEN" > /dev/null 2>&1
  (( FINISHED )) || result "NOT DEPLOYED" "release.sh stopped unexpectedly before deciding; read $LOG"
}
trap cleanup EXIT

finish() { FINISHED=1; result "$1" "$2"; exit "${3:-0}"; }

log "release.sh $SHA attempt $ATTEMPT (bundle $BUNDLE)"

# 1. One lock for every way of changing production; deploy-zero-downtime.sh and rollback.sh take the same lock and
#    inherit it through CDA_RELEASE_LOCK_HELD. Children get both lock descriptors closed, so nothing they leave
#    running can keep a lock after this script exits.
exec 9> "$RELEASE_LOCK" || finish "NOT DEPLOYED" "cannot open $RELEASE_LOCK" 2
flock -n 9 || finish "NOT DEPLOYED" "another release, deploy or rollback holds $RELEASE_LOCK" 2
export CDA_RELEASE_LOCK_HELD=1
exec 8> "$NIBRS_MAINTENANCE_LOCK" || finish "NOT DEPLOYED" "cannot open $NIBRS_MAINTENANCE_LOCK" 2
flock -n 8 || finish "NOT DEPLOYED" "the NIBRS maintenance lock is held (a data update is running)" 2
log "locks held: $RELEASE_LOCK and $NIBRS_MAINTENANCE_LOCK"

# 2. Studio: refuse new job claims, then wait for running jobs to finish (bounded).
lock_json=$($STUDIO_CTL lock "cda-release:$SHA:$ATTEMPT" 2>&1) || finish "NOT DEPLOYED" "Studio refused its deploy lock (held or maintenance): $lock_json" 2
STUDIO_TOKEN=$(printf '%s' "$lock_json" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[[ -n "$STUDIO_TOKEN" ]] || finish "NOT DEPLOYED" "could not read the Studio lock token from: $lock_json" 2
$STUDIO_CTL wait-drained "$STUDIO_DRAIN_MAX" --token "$STUDIO_TOKEN" 8>&- 9>&- || finish "NOT DEPLOYED" "Studio did not drain within ${STUDIO_DRAIN_MAX}s" 2
log "Studio drained (lock token held)"

# 3. The rollback target: the live release, its commit, the scheduler link; pinned against pruning.
TARGET=$(readlink -f "$CURRENT_LINK" 2>/dev/null) || TARGET=""
[[ -n "$TARGET" && -d "$TARGET" && "$(dirname "$TARGET")" == "$(readlink -f "$RELEASES_DIR")" ]] || finish "NOT DEPLOYED" "cannot read the live release from $CURRENT_LINK" 2
TARGET_COMMIT=$(sed -n 's/^commit=//p' "$TARGET/RELEASE_INFO" 2>/dev/null)
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || finish "NOT DEPLOYED" "the live release $TARGET has no readable commit" 2
[[ "$TARGET_COMMIT" != "$SHA" ]] || finish "NOT DEPLOYED" "$SHA is already live ($TARGET)" 0
UTIL_PRIOR=$(readlink "$UTIL_LINK" 2>/dev/null || echo "")
if ! grep -qx "$(basename "$TARGET")\( #.*\)\?" "$PINNED_FILE" 2>/dev/null; then
  echo "$(basename "$TARGET") # release.sh $ATTEMPT" >> "$PINNED_FILE" && PINNED_BY_US=1
fi
log "rollback target $TARGET ($TARGET_COMMIT); scheduler link -> ${UTIL_PRIOR:-none}"

# The auth secret the checks sign with, read from the shared env files (never printed).
AUTH_PASSWORD="${AUTH_PASSWORD:-$(sed -n 's/^AUTH_PASSWORD=//p' "$NIBRS_ROOT/shared/.env.local" "$NIBRS_ROOT/shared/.env" 2>/dev/null | head -1 | sed "s/^[\"']//; s/[\"']\$//")}"
[[ -n "$AUTH_PASSWORD" ]] || finish "NOT DEPLOYED" "AUTH_PASSWORD not found in $NIBRS_ROOT/shared/.env.local or .env" 2
export AUTH_PASSWORD

# Every check session must be one query_log row on the model-free path.
model_free() {
  local sessions="$1" name sid row tries
  while read -r name sid; do
    [[ -z "$name" ]] && continue
    row=""
    for tries in 1 2 3 4 5; do
      row=$("$SQLITE" -readonly "$QUERY_LOG_DB" "SELECT COUNT(*) || '|' || COALESCE(SUM(model = 'deterministic'), 0) FROM query_log WHERE session_id = '$sid'" 2>/dev/null | tr -d '\r')
      [[ "$row" == "1|1" ]] && break
      sleep 1
    done
    [[ "$row" == "1|1" ]] || { log "check $name ($sid): query_log rows|model-free = ${row:-unreadable}, want 1|1"; return 1; }
  done < "$sessions"
  log "every check answer was logged once, on the model-free path"
}

# 4. Baseline answers from the live release, through the public site.
CHECK_DL=$(( $(date +%s) + CHECK_MAX ))
bounded_run "$CHECK_DL" 10 -- node "$BUNDLE/scripts/release-checks.cjs" ask "$QUESTIONS" "$RELEASE_BASE_URL" "$WORK/before" "release-$ATTEMPT-before" 8>&- 9>&- \
  || finish "NOT DEPLOYED" "the live release did not answer the check questions (baseline unusable)" 2
bounded_run "$CHECK_DL" 10 -- node "$BUNDLE/scripts/release-checks.cjs" validate "$QUESTIONS" "$WORK/before" > "$WORK/baseline.txt" 2>&1 8>&- 9>&-   || finish "NOT DEPLOYED" "the live release's check answers are not complete answers (baseline unusable; see $WORK/baseline.txt)" 2
model_free "$WORK/before/sessions.txt" || finish "NOT DEPLOYED" "a baseline check answer did not take the model-free path" 2

# 5. Deploy, bounded. The build may not switch later than 60 s before the deploy deadline.
DEPLOY_DL=$(( $(date +%s) + DEPLOY_MAX ))
log "deploying $SHA (deadline in ${DEPLOY_MAX}s)"
export SWITCH_NOT_AFTER_EPOCH=$(( DEPLOY_DL - 60 )); bounded_run "$DEPLOY_DL" 30 -- $RELEASE_DEPLOY_CMD "$SHA" dev > "$WORK/deploy.log" 2>&1 < /dev/null 8>&- 9>&-
deploy_rc=$?
log "deploy exited $deploy_rc (124/137 = stopped at the deadline)"
state=$(deploy_target_state "$CURRENT_LINK" "$TARGET" "$(( $(date +%s) + 10 ))")
log "switch state: $state"

rollback() {
  local why="$1" rb_dl=$(( $(date +%s) + ROLLBACK_MAX )) fail=0 now commit
  log "ROLLING BACK to $TARGET: $why"
  bounded_run "$rb_dl" 15 -- $RELEASE_ROLLBACK_CMD "$(basename "$TARGET")" > "$WORK/rollback.log" 2>&1 < /dev/null 8>&- 9>&-
  log "rollback script exited $? (not trusted; verifying)"
  now=$(readlink -f "$CURRENT_LINK" 2>/dev/null)
  if [[ "$now" != "$TARGET" ]]; then
    log "current -> ${now:-unreadable}, not $TARGET; switching the link directly"
    ln -sfn "$TARGET" "$CURRENT_LINK.tmp" && mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
    now=$(readlink -f "$CURRENT_LINK" 2>/dev/null)
  fi
  [[ "$now" == "$TARGET" ]] || fail=1
  commit=$(sed -n 's/^commit=//p' "$CURRENT_LINK/RELEASE_INFO" 2>/dev/null)
  [[ "$commit" == "$TARGET_COMMIT" ]] || { log "RELEASE_INFO commit after rollback: ${commit:-unreadable}"; fail=1; }
  if (( ! fail )) && ! app_healthy "$TARGET" "$(( $(date +%s) + ROLLBACK_MAX / 2 ))"; then
    log "not healthy on $TARGET; one corrective reload from its own ecosystem file"
    bounded_run "$rb_dl" 10 -- $PM2 reload "$TARGET/ecosystem.config.js" --only "$APP" --update-env > "$WORK/corrective-reload.log" 2>&1 8>&- 9>&-
    app_healthy "$TARGET" "$rb_dl" || fail=1
  fi
  if [[ -n "$UTIL_PRIOR" && "$(readlink "$UTIL_LINK" 2>/dev/null)" != "$UTIL_PRIOR" ]]; then
    ln -sfn "$UTIL_PRIOR" "$UTIL_LINK"
    [[ "$(readlink "$UTIL_LINK" 2>/dev/null)" == "$UTIL_PRIOR" ]] || { log "scheduler link not restored"; fail=1; }
  fi
  if (( fail )); then
    $RELEASE_NOTIFY_CMD "ROLLBACK NOT CONFIRMED for $SHA (attempt $ATTEMPT): $why; see $LOG" 8>&- 9>&- || true
    finish "ROLLBACK NOT CONFIRMED" "$why; the previous release could not be verified live -- act at once" 3
  fi
  finish "ROLLED BACK" "$why" 1
}

if [[ "$state" == unchanged ]]; then
  # The link never moved, so nothing was published (the deploy reloads PM2 only after the switch).
  if (( deploy_rc == 0 )); then finish "NOT DEPLOYED" "the deploy exited 0 but the live release did not change" 2; fi
  finish "NOT DEPLOYED" "the deploy failed before the switch (exit $deploy_rc); see $WORK/deploy.log" 2
fi
[[ "$state" == switched ]] || rollback "the switch state could not be read after the deploy (exit $deploy_rc)"
(( deploy_rc == 0 )) || rollback "the deploy failed after the switch (exit $deploy_rc)"

# 6. Checks on the new release, all bounded by the check deadline.
NEW=$(readlink -f "$CURRENT_LINK" 2>/dev/null)
CHECK_DL=$(( $(date +%s) + CHECK_MAX ))
[[ -n "$NEW" && "$(dirname "$NEW")" == "$(readlink -f "$RELEASES_DIR")" ]] || rollback "the new release is not under $RELEASES_DIR ($NEW)"
[[ "$(sed -n 's/^commit=//p' "$NEW/RELEASE_INFO" 2>/dev/null)" == "$SHA" ]] || rollback "the new release's RELEASE_INFO does not name $SHA"
app_healthy "$NEW" "$CHECK_DL" || rollback "the new release is not healthy"
bounded_run "$CHECK_DL" 10 -- node "$BUNDLE/scripts/release-checks.cjs" ask "$QUESTIONS" "$RELEASE_BASE_URL" "$WORK/after" "release-$ATTEMPT-after" 8>&- 9>&- \
  || rollback "the new release did not answer the check questions"
model_free "$WORK/after/sessions.txt" || rollback "a check answer on the new release did not take the model-free path"
bounded_run "$CHECK_DL" 10 -- node "$BUNDLE/scripts/release-checks.cjs" compare "$QUESTIONS" "$WORK/before" "$WORK/after" "$EXPECTED" > "$WORK/compare.txt" 2>&1 8>&- 9>&-
cmp_rc=$?
cat "$WORK/compare.txt"
(( cmp_rc == 0 )) || rollback "the check answers changed (see $WORK/compare.txt)"

finish "LIVE" "$NEW ($SHA): identity, health and $(grep -c '^PASS' "$WORK/compare.txt") answer checks passed; rollback target $TARGET" 0
