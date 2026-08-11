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
#
# ---------------------------------------------------------------------------
# SCHEDULE DRIFT OBSERVED 2026-08-11 -- production does not match the line above
# ---------------------------------------------------------------------------
# The installed crontab was measured as:
#
#   0 13 * * *   cd /opt/nibrs/current && SHR_DB_PATH=... npx tsx scripts/run-query-audit.ts
#   5 13 * * 1   bash /opt/nibrs/current/scripts/nightly-audit-and-digest.sh
#
# That is two defects, not one:
#
#   1. This wrapper runs WEEKLY (Mondays), despite being named and documented as
#      nightly. The digest email and the rendered-chart audit therefore run once
#      a week.
#   2. run-query-audit.ts is ALSO scheduled directly and daily, so on Mondays the
#      query auditor runs twice -- once standalone at 13:00 and again inside this
#      wrapper at 13:05.
#
# Consequence measured the same day: chart_audit_results was empty in production
# while chart_audit_artifacts held 24 rows and chart_render_receipts held 15. The
# chart auditor was added to this script in 99803bf (2026-08-10 18:28 CDT) and
# first deployed in release 20260810_234249; this wrapper's next weekly firing was
# 2026-08-17, so the chart auditor had never executed in production. The audit
# logic was never at fault -- see scripts/test-chart-audit-pipeline.ts, which
# drives the real runner and asserts artifacts + receipts produce results.
#
# CORRECTIVE CRONTAB (production change -- requires owner approval, not applied
# by Stage 0). Replace BOTH lines above with this single entry:
#
#   0 13 * * * /opt/nibrs/current/scripts/nightly-audit-and-digest.sh >> /var/log/cda-analysis.log 2>&1
#
# Removing the standalone run-query-audit.ts line is part of the fix, not an
# optional tidy-up: this wrapper already runs that auditor as its first step, and
# leaving both scheduled reintroduces the double-run. The wrapper is the only
# entry point that also runs the chart auditor and the digest.
#
# Rollback for the crontab change is to restore the two original lines; see
# docs/runbooks/2026-08-11-rollback-and-backup-manifest.md.

set -uo pipefail

APP_DIR="${APP_DIR:-/opt/nibrs/current}"
AUDIT_TIMEOUT_SECONDS="${AUDIT_TIMEOUT_SECONDS:-900}"
CHART_AUDIT_TIMEOUT_SECONDS="${CHART_AUDIT_TIMEOUT_SECONDS:-300}"
ENV_FILE="${CDA_ENV_FILE:-/opt/nibrs/shared/.env.cron}"

cd "$APP_DIR" || { echo "FATAL: cannot cd to $APP_DIR"; exit 1; }

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------
# RESEND_API_KEY must NOT be set inline in the crontab. An inline `VAR=value`
# assignment in a cron command becomes part of the process command line, so any
# local user running `ps aux` can read it -- even though the crontab file itself
# is mode 600. Sourcing a 600 file keeps the value out of both.
#
# The `tr -d '\r'` is not cosmetic: an env file saved with CRLF endings yields
# values with a trailing carriage return, which produces authentication failures
# that look exactly like a wrong or rotated key.
if [ -f "$ENV_FILE" ]; then
  perms=$(stat -c %a "$ENV_FILE" 2>/dev/null || echo "unknown")
  if [ "$perms" != "600" ]; then
    echo "WARNING: $ENV_FILE is mode $perms; it holds a secret and should be 600."
  fi
  set -a
  # shellcheck disable=SC1090
  . <(tr -d '\r' < "$ENV_FILE")
  set +a
else
  echo "WARNING: $ENV_FILE not found; relying on the inherited environment."
fi

if [ -z "${RESEND_API_KEY:-}" ]; then
  echo "FATAL: RESEND_API_KEY is not set. The digest cannot send. Populate $ENV_FILE (mode 600)."
  exit 1
fi

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
# Step 2: rendered-chart audit (advisory and model-free)
# ---------------------------------------------------------------------------
chart_audit_status=0
echo "--- rendered-chart auditor (timeout ${CHART_AUDIT_TIMEOUT_SECONDS}s) ---"
timeout --signal=TERM --kill-after=30s "${CHART_AUDIT_TIMEOUT_SECONDS}s" npx tsx scripts/run-chart-audit.ts || chart_audit_status=$?

if [ "$chart_audit_status" -eq 0 ]; then
  echo "--- rendered-chart auditor completed ---"
elif [ "$chart_audit_status" -eq 124 ] || [ "$chart_audit_status" -eq 137 ]; then
  echo "--- WARNING: rendered-chart auditor TIMED OUT after ${CHART_AUDIT_TIMEOUT_SECONDS}s (exit ${chart_audit_status}); continuing to digest ---"
else
  echo "--- WARNING: rendered-chart auditor FAILED with exit ${chart_audit_status}; continuing to digest ---"
fi

# ---------------------------------------------------------------------------
# Step 3: digest (critical path -- runs regardless of either auditor's outcome)
# ---------------------------------------------------------------------------
echo "--- daily digest ---"
digest_status=0
node scripts/daily-query-analysis.js || digest_status=$?

if [ "$digest_status" -ne 0 ]; then
  echo "=== $(date -Is) FAILED: digest exited ${digest_status} (query auditor ${audit_status}, chart auditor ${chart_audit_status}) ==="
  exit "$digest_status"
fi

echo "=== $(date -Is) done (query auditor ${audit_status}, chart auditor ${chart_audit_status}, digest ${digest_status}) ==="
# Deliberately exits 0 on auditor failure: both auditors are advisory, and a
# non-zero exit here would make cron mail noise for conditions the digest already
# reports in the email body.
exit 0
