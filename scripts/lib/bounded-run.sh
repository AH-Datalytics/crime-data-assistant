# bounded-run.sh — run each step of an operator window against ABSOLUTE deadlines.
#
# Sourced by the Phase 3 activation runbook (audit/phase3-integration-2026-09-30/deployment-request.md)
# from the staged bundle of the deploy commit. A per-step `timeout N` cannot keep a promise about the
# window as a whole: three steps that each run to their own limit can together eat the time reserved
# for rollback. So every step here is given the epoch second by which it must be over, its timeout is
# derived from the time actually left, and a step whose time has already gone is never started.
#
#   bounded_run DEADLINE_EPOCH GRACE_SECONDS -- command [args...]
#     - refuses to dispatch (returns 75, the command never starts) when DEADLINE_EPOCH has passed;
#     - otherwise runs the command under GNU `timeout`, which sends TERM to the command's whole
#       process group at the deadline and KILL GRACE_SECONDS later if anything is still alive, so a
#       child that ignores TERM cannot hold the window;
#     - returns the command's own exit status (124 = stopped by TERM, 137 = needed KILL).
#   Redirect output to a file rather than piping it, so the status is the command's, not a pipe's.
#
#   deploy_target_state CURRENT_LINK PREVIOUS_TARGET DEADLINE_EPOCH
#     prints exactly one of: unchanged | switched | uncertain
#     "uncertain" when the link cannot be read in time or reads empty -- a failed read is NEVER taken
#     as proof that nothing switched.

bounded_run() {
  local deadline="$1" grace="$2"
  shift 2
  [[ "${1:-}" == "--" ]] && shift
  if ! [[ "$deadline" =~ ^[0-9]+$ && "$grace" =~ ^[0-9]+$ ]] || (( $# == 0 )); then
    echo "[bounded] usage: bounded_run DEADLINE_EPOCH GRACE_SECONDS -- command [args...]" >&2
    return 64
  fi
  local remaining=$(( deadline - $(date +%s) ))
  if (( remaining <= 0 )); then
    echo "[bounded] REFUSED (budget expired $(( -remaining ))s ago), not started: $*" >&2
    return 75
  fi
  timeout --kill-after="${grace}s" "${remaining}s" "$@"
}

deploy_target_state() {
  local link="$1" previous="$2" deadline="$3" now_target
  [[ -L "$link" ]] || { echo uncertain; return 0; }   # absent or not a symlink: never a known state
  now_target=$(bounded_run "$deadline" 2 -- readlink -f "$link" 2>/dev/null) || { echo uncertain; return 0; }
  if [[ -z "$now_target" ]]; then echo uncertain
  elif [[ "$now_target" == "$previous" ]]; then echo unchanged
  else echo switched
  fi
}
