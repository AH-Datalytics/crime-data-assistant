#!/usr/bin/env bash
#
# Nightly: run the Phase 1 cross-artifact auditor, then send the daily digest.
#
# Ordering matters: the auditor must finish first so the digest can report its
# counts. But the digest is the critical path -- it is the only thing that
# actually reaches a human -- so a failed or hung auditor must NEVER stop the
# email. That is why the digest runs unconditionally rather than after `&&`.
#
# The auditor's health reaches the digest through the `audit_runs` table, not
# through this script. That means the digest reports honestly even if the
# auditor was killed by the timeout and never got to print anything: the run row
# stays 'running' and the digest labels the section UNAVAILABLE rather than
# printing zeros that read as a clean bill of health.
#
# Install (VPS), replacing the existing bare digest entry:
#   0 13 * * * /opt/nibrs/current/scripts/nightly-audit-and-digest.sh >> /var/log/cda-analysis.log 2>&1
#
# Note the RESEND_API_KEY must be available to this script's environment; the
# previous crontab line set it inline.

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/nibrs/current}"
AUDIT_TIMEOUT_SECONDS="${AUDIT_TIMEOUT_SECONDS:-900}"

cd "$APP_DIR" || { echo "FATAL: cannot cd to $APP_DIR"; exit 1; }

echo "=== $(date -Is) nightly-audit-and-digest starting in $APP_DIR ==="

# ---------------------------------------------------------------------------
# Step 1: auditor (advisory, non-gating, failure-tolerant)
# ---------------------------------------------------------------------------
audit_status=0
echo "--- Phase 1 cross-artifact auditor (timeout ${AUDIT_TIMEOUT_SECONDS}s) ---"
timeout --signal=TERM --kill-after=30s "${AUDIT_TIMEOUT_SECONDS}s" \
  npx tsx scripts/run-query-audit.ts || audit_status=$?

if [ "$audit_status" -eq 0 ]; then
  echo "--- auditor completed ---"
elif [ "$audit_status" -eq 124 ] || [ "$audit_status" -eq 137 ]; then
  echo "--- WARNING: auditor TIMED OUT after ${AUDIT_TIMEOUT_SECONDS}s (exit ${audit_status}); continuing to digest ---"
else
  echo "--- WARNING: auditor FAILED with exit ${audit_status}; continuing to digest ---"
fi

# ---------------------------------------------------------------------------
# Step 2: digest (critical path -- runs regardless of the auditor's outcome)
# ---------------------------------------------------------------------------
echo "--- daily digest ---"
digest_status=0
node scripts/daily-query-analysis.js || digest_status=$?

if [ "$digest_status" -ne 0 ]; then
  echo "=== $(date -Is) FAILED: digest exited ${digest_status} (auditor exited ${audit_status}) ==="
  exit "$digest_status"
fi

echo "=== $(date -Is) done (auditor exit ${audit_status}, digest exit ${digest_status}) ==="
# Deliberately exits 0 on auditor failure: the auditor is advisory, and a
# non-zero exit here would make cron mail noise for something the digest already
# reports in the email body.
exit 0
