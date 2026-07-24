#!/usr/bin/env bash
set -euo pipefail

ARTIFACT=${1:?Usage: deploy-nibrs-rollup.sh ARTIFACT WEB_HOST}
WEB_HOST=${2:?Usage: deploy-nibrs-rollup.sh ARTIFACT WEB_HOST}
SIDECAR="${ARTIFACT}.generation"
BASENAME=$(basename "$ARTIFACT")
REMOTE_DIR=/opt/nibrs/shared

if [[ ! "$BASENAME" =~ ^nibrs_rollups-[0-9]{8}([_-][0-9]+)?\.db$ ]]; then
  echo "Artifact must use a versioned nibrs_rollups-YYYYMMDD.db name" >&2
  exit 1
fi
[[ -s "$ARTIFACT" ]] || { echo "Missing artifact: $ARTIFACT" >&2; exit 1; }
[[ -s "$SIDECAR" ]] || { echo "Missing generation sidecar: $SIDECAR" >&2; exit 1; }

GENERATION=$(tr -d '\r\n' < "$SIDECAR")
[[ "$GENERATION" =~ ^[0-9]+:[0-9]+$ ]] || { echo "Invalid generation token" >&2; exit 1; }
DIGEST=$(sha256sum "$ARTIFACT" | awk '{print $1}')
REMOTE_DB="$REMOTE_DIR/$BASENAME"
REMOTE_GENERATION="$REMOTE_DB.generation"

# The source marker must match before and after the potentially long transfer.
REMOTE_SOURCE_GENERATION=$(ssh "$WEB_HOST" "tr -d '\\r\\n' < '$REMOTE_DIR/nibrs_source.generation'")
[[ "$REMOTE_SOURCE_GENERATION" == "$GENERATION" ]] || {
  echo "Artifact generation does not match the current production source" >&2
  exit 1
}
ssh "$WEB_HOST" "test ! -e '$REMOTE_DB' && test ! -e '$REMOTE_DB.tmp' && test ! -e '$REMOTE_GENERATION' && test ! -e '$REMOTE_GENERATION.tmp'"

scp "$ARTIFACT" "$WEB_HOST:$REMOTE_DB.tmp"
scp "$SIDECAR" "$WEB_HOST:$REMOTE_GENERATION.tmp"

REMOTE_DIGEST=$(ssh "$WEB_HOST" "sha256sum '$REMOTE_DB.tmp' | awk '{print \$1}'")
[[ "$REMOTE_DIGEST" == "$DIGEST" ]] || { echo "Remote SHA-256 mismatch" >&2; exit 1; }
REMOTE_SOURCE_GENERATION=$(ssh "$WEB_HOST" "tr -d '\\r\\n' < '$REMOTE_DIR/nibrs_source.generation'")
[[ "$REMOTE_SOURCE_GENERATION" == "$GENERATION" ]] || {
  echo "Production source changed during upload; refusing activation" >&2
  exit 1
}

# Install the target and its sidecar before atomically switching the DB symlink.
ssh "$WEB_HOST" "set -e; mv '$REMOTE_DB.tmp' '$REMOTE_DB'; mv '$REMOTE_GENERATION.tmp' '$REMOTE_GENERATION'; ln -sfn '$BASENAME' '$REMOTE_DIR/nibrs_rollups.db'"
echo "Activated $REMOTE_DB"
