#!/usr/bin/env bash
# The private preview is never reachable on a production build (coordinator, 2026-10-29): build the app for production,
# start it WITH the preview's build path set (the worst case), and require 404 from the /preview and /assistant pages
# and their API routes. Local only: it builds into .next (stop any dev server first) and serves on a spare port.
#
#   bash scripts/test-nibrs-preview-production.sh [port]
set -euo pipefail
PORT="${1:-3197}"
cd "$(dirname "$0")/.."
export NIBRS_SHADOW_ROOT="${NIBRS_SHADOW_ROOT:-/any/canonical/build}"
npx next build > /tmp/nibrs-preview-build.log 2>&1 || { tail -40 /tmp/nibrs-preview-build.log; echo "FAIL: production build"; exit 1; }
NODE_ENV=production npx next start -p "$PORT" > /tmp/nibrs-preview-start.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$PORT/login" && break; sleep 1; done
page=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/preview")
apiPost=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{"question":"Shoplifting in Memphis in 2024"}' "http://localhost:$PORT/api/nibrs-shadow-query")
apiGet=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/nibrs-shadow-query")
# The Crime Data Assistant preview (/assistant and its API) sits behind the same gate.
aPage=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/assistant")
aPost=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{"question":"Shoplifting in Memphis in 2024"}' "http://localhost:$PORT/api/assistant-query")
aGet=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/assistant-query")
echo "production build: /preview $page; POST /api/nibrs-shadow-query $apiPost; GET $apiGet; /assistant $aPage; POST /api/assistant-query $aPost; GET $aGet"
[ "$page" = 404 ] && [ "$apiPost" = 404 ] && [ "$apiGet" = 404 ] && [ "$aPage" = 404 ] && [ "$aPost" = 404 ] && [ "$aGet" = 404 ] && echo "PASS: nothing new is reachable on a production build" || { echo "FAIL"; exit 1; }
