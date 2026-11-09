#!/usr/bin/env bash
# Deploy /redesign (PM2 process nibrs-redesign) from a git SHA, on the VPS. Never touches /opt/nibrs or the live `nibrs` process.
# Usage: bash scripts/deploy-redesign.sh <full-sha>
# Prerequisites: /opt/nibrs-beta layout; the SHA is fetched into /opt/nibrs/repo (read-only use of that clone).
set -euo pipefail

SHA=${1:?usage: deploy-redesign.sh <full-sha>}
BASE=/opt/nibrs-beta
LOCKS="/opt/nibrs/maintenance.lock /opt/nibrs/release.lock"

# Locks are checked read-only with fuser (no output = free), never flock.
if [ -n "$(fuser $LOCKS 2>&1 || true)" ]; then echo "deploy: a /opt/nibrs lock is in use; aborting" >&2; exit 1; fi

TS=$(date -u +%Y%m%d_%H%M%S)
D="$BASE/releases/$TS"
mkdir -p "$D"
git -C /opt/nibrs/repo archive "$SHA" | tar -x -C "$D"
cd "$D"
nice -n 19 npm ci
NEXT_PUBLIC_BASE_PATH=/redesign NODE_OPTIONS=--max-old-space-size=2048 nice -n 19 npm run build
test -f .next/BUILD_ID

if [ -n "$(fuser $LOCKS 2>&1 || true)" ]; then echo "deploy: a /opt/nibrs lock is in use; not swapping" >&2; exit 1; fi
ln -sfn "$D" "$BASE/current"
pm2 restart nibrs-redesign --update-env   # by name only
pm2 save
sleep 6
curl -fsS -o /dev/null -w "local %{http_code}\n" http://127.0.0.1:3011/redesign/assistant

# After a successful swap: keep the 3 newest releases, current, and the one before it.
bash "$(dirname "$0")/prune-redesign-releases.sh" || echo "deploy: prune skipped or failed (deploy itself succeeded)" >&2
echo "release $TS"
