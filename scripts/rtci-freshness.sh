#!/usr/bin/env bash
# rtci-freshness.sh — the lock, and nothing else.
#
# This file owns exactly one thing: whether the freshness check may run concurrently. Every decision
# about outcomes, exit codes, logging and alerting lives in scripts/rtci-freshness.js and
# scripts/lib/rtci-freshness-policy.js, which is why this stays short enough to read in one go.
#
#   bash scripts/rtci-freshness.sh check       # takes the lock; on failure reports the skip
#   bash scripts/rtci-freshness.sh heartbeat   # NO lock, by design
#
# THE HEARTBEAT MUST NOT TAKE THE LOCK. A heartbeat gated on the same lock as the check would be
# suppressed by exactly the hung run it exists to report, and silence would once again be
# indistinguishable from health -- the April failure, one level up.
#
# `flock -n` matches the convention already used by other jobs on this host. A run that cannot take
# the lock does not simply vanish: it invokes the shell in `locked` mode, which decides whether an
# ordinary overlap or a stalled monitor is the right report.

set -euo pipefail
IFS=$'\n\t'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${RTCI_FRESHNESS_NODE:-node}"
LOCK="${RTCI_FRESHNESS_LOCK:-/var/lock/rtci-freshness.lock}"
SHELL_JS="$HERE/rtci-freshness.js"

usage() { printf 'usage: %s check | heartbeat\n' "${BASH_SOURCE[0]}" >&2; exit 2; }
[[ $# -eq 1 ]] || usage

case "$1" in
  heartbeat)
    exec "$NODE_BIN" "$SHELL_JS" heartbeat
    ;;
  check)
    exec 9>"$LOCK"
    if flock -n 9; then
      exec "$NODE_BIN" "$SHELL_JS" check
    else
      exec "$NODE_BIN" "$SHELL_JS" locked
    fi
    ;;
  *)
    usage
    ;;
esac
