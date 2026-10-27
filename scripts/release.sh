#!/usr/bin/env bash
# release.sh <40-char sha> -- deploy, check and, on any failure, roll back by itself, entirely on the server.
# Design: docs/superpowers/specs/2026-10-27-server-side-release-design.md (Codex ACCEPT-WITH-CHANGES, folded in);
# code review r1 (Codex REVISE, 8 findings) addressed in r2.
#
# Run it from the exported bundle of the SHA, detached, then read the result whenever convenient:
#   ssh root@VPS 'cd /tmp && nohup bash /tmp/deploy-$SHA/scripts/release.sh $SHA > /dev/null 2>&1 &'
#   ssh root@VPS 'cat /opt/nibrs/release-logs/$SHA.latest'
# A dropped laptop connection changes nothing.
#
# Steps: RUNNING is published for this attempt -> this script, its helpers and the check fixtures are bound to the
# SHA in the server's repo -> one shared lock (release, deploy and rollback all take it) -> the NIBRS maintenance lock
# held throughout -> Studio stops claiming jobs and drains -> the live release, its commit and its scheduler link are
# recorded and the release is pinned against pruning -> the check questions are asked of the live release -> the
# deploy (bounded; a slow build cannot switch late) -> the switch state is read from the link, not from the
# deploy's exit code -> identity, health and the same questions on the new release -> LIVE, or a verified rollback.
# An interruption (TERM, INT, HUP, an unexpected exit) after the deploy started is recovered the same way: the
# deploy is stopped first, then the switch state decides between NOT DEPLOYED and a verified rollback.
#
# Results (<sha>.<attempt>.result, written atomically; <sha>.latest is a copy of the newest attempt's):
#   RUNNING                  this attempt has not decided yet
#   LIVE                     the new release passed every check
#   NOT DEPLOYED             production was never switched (lock held, Studio busy, baseline unusable, bundle not the
#                            SHA, build failed before the switch, ...)
#   ROLLED BACK              the new release was switched in, failed a check, and the previous release is verified
#                            live again (commit, every worker's loaded release, health)
#   ROLLBACK NOT CONFIRMED   the rollback could not be verified: exit 3 and a mail alert; act at once
# Exit 4 means the result itself could not be published: read the log.
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
: "${RELEASE_REPO_DIR:=$NIBRS_ROOT/repo}"
: "${RELEASE_LOG_DIR:=$NIBRS_ROOT/release-logs}"
: "${RELEASE_LOCK:=$NIBRS_ROOT/release.lock}"
: "${NIBRS_MAINTENANCE_LOCK:=$NIBRS_ROOT/maintenance.lock}"
: "${QUERY_LOG_DB:=$NIBRS_ROOT/shared/query_log.db}"
: "${RELEASE_BASE_URL:=https://nibrsai.com}"
: "${RELEASE_DEPLOY_CMD:=bash $BUNDLE/scripts/deploy-zero-downtime.sh}"
: "${RELEASE_ROLLBACK_CMD:=bash $BUNDLE/scripts/rollback.sh}"
: "${STUDIO_CTL:=/usr/bin/node /opt/studio/current/packages/db/dist/cli.js}"
: "${RELEASE_NOTIFY_CMD:=node $BUNDLE/scripts/release-notify.cjs}"
: "${SQLITE:=sqlite3}"
: "${STUDIO_DRAIN_MAX:=600}"   # seconds to wait for running Studio jobs to finish before giving up untouched
: "${DEPLOY_MAX:=1200}"        # build and switch
: "${CHECK_MAX:=420}"          # health and answer checks after the switch
: "${ROLLBACK_MAX:=300}"       # the rollback's own time: a third for the script, the rest for verification and repair
# The files this run trusts, which must be byte-identical to the SHA in the server's repo (a stale bundle would
# otherwise check or waive with rules the deployed commit does not have).
BOUND_FILES="scripts/release.sh scripts/release-checks.cjs scripts/release-notify.cjs scripts/lib/release-health.sh scripts/lib/bounded-run.sh scripts/lib/prune-releases.sh scripts/lib/resend-mailer.js"

ATTEMPT="$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$RELEASE_LOG_DIR" || { echo "cannot create $RELEASE_LOG_DIR" >&2; exit 4; }
export WORK="$RELEASE_LOG_DIR/$SHA.$ATTEMPT"
mkdir -p "$WORK" || exit 4
LOG="$WORK/release.log"
exec >> "$LOG" 2>&1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
# shellcheck source=scripts/lib/bounded-run.sh
source "$BUNDLE/scripts/lib/bounded-run.sh"
# shellcheck source=scripts/lib/release-health.sh
source "$BUNDLE/scripts/lib/release-health.sh"
# shellcheck source=scripts/lib/prune-releases.sh
source "$BUNDLE/scripts/lib/prune-releases.sh"

TARGET="" TARGET_COMMIT="" UTIL_PRIOR="" PINNED_BY_US=0 STUDIO_TOKEN="" FINISHED=0 ABORTING=0 PHASE=start DEPLOY_PID="" DEPLOY_PGID=""
PENDING_SIGNAL=""
IN_EXIT=0 FINAL_RC=""

# This attempt's result, written atomically, then copied atomically to <sha>.latest. Non-zero if either write fails.
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
  } > "$f.tmp" && mv -f "$f.tmp" "$f" \
    && cp -f "$f" "$RELEASE_LOG_DIR/$SHA.latest.tmp" && mv -f "$RELEASE_LOG_DIR/$SHA.latest.tmp" "$RELEASE_LOG_DIR/$SHA.latest" \
    || { log "COULD NOT PUBLISH RESULT=$state ($reason)"; return 1; }
  log "RESULT=$state ($reason)"
}

# The final word of this attempt (only the first call counts). A result that cannot be published is exit 4, never a
# success. Inside the EXIT trap it returns instead of exiting, so the trap can still clean up.
finish() {
  (( FINISHED )) && return 0
  FINISHED=1; FINAL_RC="${3:-0}"
  result "$1" "$2" || FINAL_RC=4
  (( IN_EXIT )) && return 0
  exit "$FINAL_RC"
}

notify() {
  if $RELEASE_NOTIFY_CMD "nibrsai.com release $1" "$2" > "$WORK/notify.log" 2>&1 8>&- 9>&-; then log "alert sent"
  else log "ALERT DELIVERY FAILED: $(tail -c 400 "$WORK/notify.log")"; logger -t cda-release "$1: $2" 2>/dev/null || true; fi
}

cleanup() {
  if (( PINNED_BY_US )) && [[ -f "$PINNED_FILE" ]]; then
    grep -vxF "$(basename "$TARGET")" "$PINNED_FILE" > "$PINNED_FILE.tmp"; mv -f "$PINNED_FILE.tmp" "$PINNED_FILE"
  fi
  [[ -n "$STUDIO_TOKEN" ]] && $STUDIO_CTL unlock "$STUDIO_TOKEN" > /dev/null 2>&1 8>&- 9>&-
}

# Stop the deploy and confirm it is gone. DEPLOY_PGID is GNU timeout's process group (timeout leads it), so the
# deploy and everything it started (npm, the build, pm2 calls) are signalled together: TERM, then KILL, then the group
# must be empty. The group is kept until it is confirmed empty, also after a normal exit of timeout (a descendant that
# ignores TERM can outlive it). Non-zero if anything in it survives; then nothing may be called verified.
stop_deploy() {
  [[ -n "$DEPLOY_PGID" ]] || return 0
  local pg="$DEPLOY_PGID"
  # timeout alive but its group not formed yet: it has started nothing, so it is killed directly.
  if ! kill -0 -- "-$pg" 2>/dev/null && [[ -n "$DEPLOY_PID" ]] && kill -0 "$DEPLOY_PID" 2>/dev/null; then
    log "the deploy has not formed its process group; killing timeout ($DEPLOY_PID) directly"
    kill -KILL "$DEPLOY_PID" 2>/dev/null
  fi
  if kill -0 -- "-$pg" 2>/dev/null; then
    log "stopping the deploy (process group $pg)"
    kill -TERM -- "-$pg" 2>/dev/null
    for _ in $(seq 1 10); do kill -0 -- "-$pg" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$pg" 2>/dev/null
    for _ in $(seq 1 10); do kill -0 -- "-$pg" 2>/dev/null || break; sleep 1; done
  fi
  [[ -n "$DEPLOY_PID" ]] && wait "$DEPLOY_PID" 2>/dev/null
  DEPLOY_PID=""
  if kill -0 -- "-$pg" 2>/dev/null; then log "the deploy's process group $pg is still alive"; return 1; fi
  DEPLOY_PGID=""
}

# The rollback could not be verified: alert, then the result (shared by every path that ends this way).
unconfirmed() {
  notify "ROLLBACK NOT CONFIRMED for $SHA" "Attempt $ATTEMPT: $1. The previous release $TARGET could not be verified live. Log: $LOG"
  finish "ROLLBACK NOT CONFIRMED" "$1 -- act at once" 3
}

rollback() {
  local why="$1" start now commit fail=0 rb_dl cmd_dl verify_dl
  PHASE=rollback
  start=$(date +%s); rb_dl=$(( start + ROLLBACK_MAX )); cmd_dl=$(( start + ROLLBACK_MAX / 3 )); verify_dl=$(( start + 2 * ROLLBACK_MAX / 3 ))
  log "ROLLING BACK to $TARGET: $why"
  stop_deploy || { unconfirmed "$why; the deploy could not be stopped, so production may still change"; return; }
  bounded_run "$cmd_dl" 10 -- $RELEASE_ROLLBACK_CMD "$(basename "$TARGET")" > "$WORK/rollback.log" 2>&1 < /dev/null 8>&- 9>&-
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
  if (( ! fail )) && ! app_healthy "$TARGET" "$verify_dl"; then
    log "not healthy on $TARGET; one corrective reload from its own ecosystem file"
    bounded_run "$rb_dl" 10 -- $PM2 reload "$TARGET/ecosystem.config.js" --only "$APP" --update-env > "$WORK/corrective-reload.log" 2>&1 8>&- 9>&-
    log "corrective reload exited $?"
    app_healthy "$TARGET" "$rb_dl" || fail=1
  fi
  if [[ -n "$UTIL_PRIOR" && "$(readlink "$UTIL_LINK" 2>/dev/null)" != "$UTIL_PRIOR" ]]; then
    ln -sfn "$UTIL_PRIOR" "$UTIL_LINK"
    [[ "$(readlink "$UTIL_LINK" 2>/dev/null)" == "$UTIL_PRIOR" ]] || { log "scheduler link not restored"; fail=1; }
  fi
  (( fail )) && { unconfirmed "$why; the previous release could not be verified live"; return; }
  finish "ROLLED BACK" "$why" 1
}

# Interruptions and unexpected exits: once the deploy has started, only the switch state may decide the result.
abort() {
  (( ABORTING || FINISHED )) && return
  ABORTING=1
  log "ABORT: $1 (phase $PHASE)"
  case "$PHASE" in
    deploy|checks)
      stop_deploy || { unconfirmed "$1; the deploy could not be stopped, so production may still change"; return; }
      local state
      state=$(deploy_target_state "$CURRENT_LINK" "$TARGET" "$(( $(date +%s) + 10 ))")
      if [[ "$state" == unchanged ]]; then finish "NOT DEPLOYED" "$1, before the switch" 2
      else rollback "$1 after the switch"; fi ;;
    rollback) unconfirmed "$1 during the rollback" ;;
    *) finish "NOT DEPLOYED" "$1, before the deploy" 2 ;;
  esac
}
on_exit() {
  local rc=$?
  IN_EXIT=1; trap - TERM INT HUP
  (( FINISHED )) || abort "release.sh exited unexpectedly (rc $rc)"
  cleanup
  exit "${FINAL_RC:-$rc}"
}
trap on_exit EXIT
trap 'abort "terminated by SIGTERM"' TERM
trap 'abort "interrupted by SIGINT"' INT
trap 'abort "terminated by SIGHUP"' HUP

result RUNNING "attempt $ATTEMPT started" || exit 4
log "release.sh $SHA attempt $ATTEMPT (bundle $BUNDLE)"

# 0. Bind this run to the SHA: the bundle's own files must equal the SHA's, and the check fixtures are read from the
#    SHA itself, never from the bundle directory.
bounded_run "$(( $(date +%s) + 120 ))" 10 -- git -C "$RELEASE_REPO_DIR" fetch -q origin > "$WORK/fetch.log" 2>&1 || log "git fetch failed (continuing with the local objects)"
git -C "$RELEASE_REPO_DIR" cat-file -e "$SHA^{commit}" 2>/dev/null || finish "NOT DEPLOYED" "$SHA is not a commit in $RELEASE_REPO_DIR" 2
for f in $BOUND_FILES; do
  cmp -s <(git -C "$RELEASE_REPO_DIR" show "$SHA:$f" 2>/dev/null) "$BUNDLE/$f" || finish "NOT DEPLOYED" "the bundle's $f is not the file at $SHA" 2
done
mkdir -p "$WORK/sha" && git -C "$RELEASE_REPO_DIR" archive "$SHA" scripts/fixtures/release-checks | tar -x -C "$WORK/sha" \
  || finish "NOT DEPLOYED" "cannot extract scripts/fixtures/release-checks at $SHA" 2
QUESTIONS="$WORK/sha/scripts/fixtures/release-checks/questions.json"
EXPECTED="$WORK/sha/scripts/fixtures/release-checks/expected-changes.json"
[[ -f "$QUESTIONS" ]] || finish "NOT DEPLOYED" "no scripts/fixtures/release-checks/questions.json at $SHA" 2
node "$BUNDLE/scripts/release-checks.cjs" expected "$QUESTIONS" "$EXPECTED" > "$WORK/expected.txt" 2>&1   || finish "NOT DEPLOYED" "expected-changes.json at $SHA is not valid: $(tail -c 300 "$WORK/expected.txt")" 2

# 1. One lock for every way of changing production; deploy-zero-downtime.sh, rollback.sh and the data publishers
#    take the same lock, and the deploy and rollback run here inherit it through CDA_RELEASE_LOCK_HELD. Children get
#    both lock descriptors closed, so nothing they leave running can keep a lock after this script exits.
exec 9> "$RELEASE_LOCK" || finish "NOT DEPLOYED" "cannot open $RELEASE_LOCK" 2
flock -n 9 || finish "NOT DEPLOYED" "another release, deploy, rollback or data publication holds $RELEASE_LOCK" 2
export CDA_RELEASE_LOCK_HELD=1
exec 8> "$NIBRS_MAINTENANCE_LOCK" || finish "NOT DEPLOYED" "cannot open $NIBRS_MAINTENANCE_LOCK" 2
flock -n 8 || finish "NOT DEPLOYED" "the NIBRS maintenance lock is held (a data update is running)" 2
log "locks held: $RELEASE_LOCK and $NIBRS_MAINTENANCE_LOCK"

# 2. Studio: refuse new job claims, then wait for running jobs to finish (bounded).
lock_json=$($STUDIO_CTL lock "cda-release:$SHA:$ATTEMPT" 2>&1 8>&- 9>&-) || finish "NOT DEPLOYED" "Studio refused its deploy lock (held or maintenance): $lock_json" 2
STUDIO_TOKEN=$(printf '%s' "$lock_json" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[[ -n "$STUDIO_TOKEN" ]] || finish "NOT DEPLOYED" "could not read the Studio lock token from: $lock_json" 2
$STUDIO_CTL wait-drained "$STUDIO_DRAIN_MAX" --token "$STUDIO_TOKEN" 8>&- 9>&- || finish "NOT DEPLOYED" "Studio did not drain within ${STUDIO_DRAIN_MAX}s" 2
log "Studio drained (lock token held)"

# 3. The rollback target: the live release, its commit, the scheduler link; pinned against pruning (one bare name
#    per line, the format scripts/lib/prune-releases.sh reads), verified through the pruning helper's own reader.
TARGET=$(readlink -f "$CURRENT_LINK" 2>/dev/null) || TARGET=""
[[ -n "$TARGET" && -d "$TARGET" && "$(dirname "$TARGET")" == "$(readlink -f "$RELEASES_DIR")" ]] || finish "NOT DEPLOYED" "cannot read the live release from $CURRENT_LINK" 2
TARGET_COMMIT=$(sed -n 's/^commit=//p' "$TARGET/RELEASE_INFO" 2>/dev/null)
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || finish "NOT DEPLOYED" "the live release $TARGET has no readable commit" 2
[[ "$TARGET_COMMIT" != "$SHA" ]] || finish "NOT DEPLOYED" "$SHA is already live ($TARGET)" 0
UTIL_PRIOR=$(readlink "$UTIL_LINK" 2>/dev/null || echo "")
if ! prune_is_pinned "$(basename "$TARGET")" "$(prune_read_pinned "$PINNED_FILE")"; then
  echo "$(basename "$TARGET")" >> "$PINNED_FILE" && PINNED_BY_US=1
  prune_is_pinned "$(basename "$TARGET")" "$(prune_read_pinned "$PINNED_FILE")" || finish "NOT DEPLOYED" "could not pin the rollback target in $PINNED_FILE" 2
fi
log "rollback target $TARGET ($TARGET_COMMIT), pinned; scheduler link -> ${UTIL_PRIOR:-none}"

# The site password, if the site has one (production runs without; the checks then sign with the built-in
# secrets, as the site verifies). Never printed.
AUTH_PASSWORD="${AUTH_PASSWORD:-$(sed -n 's/^AUTH_PASSWORD=//p' "$NIBRS_ROOT/shared/.env.local" "$NIBRS_ROOT/shared/.env" 2>/dev/null | head -1 | sed "s/^[\"']//; s/[\"']\$//")}"
export AUTH_PASSWORD
if [[ -n "$AUTH_PASSWORD" ]]; then
  HEALTH_COOKIE=$(node "$BUNDLE/scripts/release-checks.cjs" cookie) || finish "NOT DEPLOYED" "cannot build the health-check cookie" 2
  export HEALTH_COOKIE
fi

# Every check session must be one query_log row on the model-free path.
model_free() {
  local sessions="$1" name sid row
  while read -r name sid; do
    [[ -z "$name" ]] && continue
    row=""
    for _ in 1 2 3 4 5; do
      row=$("$SQLITE" -readonly "$QUERY_LOG_DB" "SELECT COUNT(*) || '|' || COALESCE(SUM(model = 'deterministic'), 0) FROM query_log WHERE session_id = '$sid'" 2>/dev/null | tr -d '\r')
      [[ "$row" == "1|1" ]] && break
      sleep 1
    done
    [[ "$row" == "1|1" ]] || { log "check $name ($sid): query_log rows|model-free = ${row:-unreadable}, want 1|1"; return 1; }
  done < "$sessions"
  log "every check answer was logged once, on the model-free path"
}

# 4. Baseline answers from the live release, through the public site; they must be complete and model-free.
CHECK_DL=$(( $(date +%s) + CHECK_MAX ))
bounded_run "$CHECK_DL" 10 -- node "$BUNDLE/scripts/release-checks.cjs" ask "$QUESTIONS" "$RELEASE_BASE_URL" "$WORK/before" "release-$ATTEMPT-before" 8>&- 9>&- \
  || finish "NOT DEPLOYED" "the live release did not answer the check questions (baseline unusable)" 2
bounded_run "$CHECK_DL" 10 -- node "$BUNDLE/scripts/release-checks.cjs" validate "$QUESTIONS" "$WORK/before" > "$WORK/baseline.txt" 2>&1 8>&- 9>&- \
  || finish "NOT DEPLOYED" "the live release's check answers are not complete answers (baseline unusable; see $WORK/baseline.txt)" 2
model_free "$WORK/before/sessions.txt" || finish "NOT DEPLOYED" "a baseline check answer did not take the model-free path" 2

# 5. Deploy, bounded, in the background so a signal can stop it. The build may not switch later than 60 s before
#    the deploy deadline.
DEPLOY_DL=$(( $(date +%s) + DEPLOY_MAX ))
export SWITCH_NOT_AFTER_EPOCH=$(( DEPLOY_DL - 60 ))
log "deploying $SHA (deadline in ${DEPLOY_MAX}s)"
PHASE=deploy
# timeout runs as the direct background child (not through a function), so $! is timeout itself, which becomes the
# leader of the deploy's process group. Signals are held while it starts: a TERM that arrived before the group existed
# could otherwise find nothing to stop and let the deploy go on.
trap 'PENDING_SIGNAL="terminated by SIGTERM"' TERM
trap 'PENDING_SIGNAL="interrupted by SIGINT"' INT
trap 'PENDING_SIGNAL="terminated by SIGHUP"' HUP
timeout --kill-after=30s "$DEPLOY_MAX"s $RELEASE_DEPLOY_CMD "$SHA" dev > "$WORK/deploy.log" 2>&1 < /dev/null 8>&- 9>&- &
DEPLOY_PID=$!; DEPLOY_PGID=$DEPLOY_PID
for _ in $(seq 1 50); do kill -0 -- "-$DEPLOY_PGID" 2>/dev/null && break; kill -0 "$DEPLOY_PID" 2>/dev/null || break; sleep 0.1; done
if ! kill -0 -- "-$DEPLOY_PGID" 2>/dev/null && kill -0 "$DEPLOY_PID" 2>/dev/null; then
  # Still alive after 5 s without its process group: stop it through the normal recovery, which reads the switch
  # state after stopping (it may have formed its group and run in the meantime) and rolls back if it switched.
  abort "the deploy did not form its process group within 5 s"
fi
trap 'abort "terminated by SIGTERM"' TERM
trap 'abort "interrupted by SIGINT"' INT
trap 'abort "terminated by SIGHUP"' HUP
[[ -n "$PENDING_SIGNAL" ]] && abort "$PENDING_SIGNAL"
wait "$DEPLOY_PID"
deploy_rc=$?
DEPLOY_PID=""
log "deploy exited $deploy_rc (124/137 = stopped at the deadline)"
# Whatever the deploy left running is stopped before anything is checked or rolled back.
if ! stop_deploy; then
  state=$(deploy_target_state "$CURRENT_LINK" "$TARGET" "$(( $(date +%s) + 10 ))")
  PHASE=rollback
  unconfirmed "processes the deploy started could not be stopped (switch state $state); production may still change"
fi
state=$(deploy_target_state "$CURRENT_LINK" "$TARGET" "$(( $(date +%s) + 10 ))")
log "switch state: $state"

if [[ "$state" == unchanged ]]; then
  # The link never moved, so nothing was published (the deploy reloads PM2 only after the switch).
  (( deploy_rc == 0 )) && finish "NOT DEPLOYED" "the deploy exited 0 but the live release did not change" 2
  finish "NOT DEPLOYED" "the deploy failed before the switch (exit $deploy_rc); see $WORK/deploy.log" 2
fi
PHASE=checks
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
