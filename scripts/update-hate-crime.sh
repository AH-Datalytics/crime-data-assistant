#!/bin/bash
# Automated hate crime data update for VPS
# FBI CDE publishes annual hate crime master files (typically in fall).
# This script checks for new data for the current year and rebuilds if found.
#
# Usage: bash /opt/nibrs/current/scripts/update-hate-crime.sh
# Cron:  0 17 15 * * bash /opt/nibrs/current/scripts/update-hate-crime.sh >> /var/log/hate-crime-update.log 2>&1
#
set -e

APP_DIR="/opt/nibrs/current"
DB_PATH="/opt/nibrs/hate_crime.db"
SCRIPT="$APP_DIR/scripts/import-hate-crime.py"
CURRENT_YEAR=$(date +%Y)

echo "[$(date)] Checking for hate crime data updates..."

# Get current max year in DB
MAX_YEAR=$(sqlite3 "$DB_PATH" "SELECT MAX(year) FROM hate_crime_incidents" 2>/dev/null || echo "0")
echo "  Current max year in DB: $MAX_YEAR"

# Try to import the latest year (current - 1, since CDE publishes with a lag)
TARGET_YEAR=$((CURRENT_YEAR - 1))

if [ "$MAX_YEAR" -ge "$TARGET_YEAR" ]; then
    echo "  Already have data through $MAX_YEAR, checking for current year $CURRENT_YEAR..."
    TARGET_YEAR=$CURRENT_YEAR
fi

# Attempt import — will fail gracefully if the year isn't available on CDE yet
echo "  Attempting to import year $TARGET_YEAR..."
cd "$APP_DIR"

# Save row count before
BEFORE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM hate_crime_incidents WHERE year = $TARGET_YEAR" 2>/dev/null || echo "0")

python3 -u "$SCRIPT" --years "$TARGET_YEAR" --db "$DB_PATH" 2>&1 || {
    echo "  Import failed or no data available for $TARGET_YEAR. This is expected if CDE hasn't published yet."
    exit 0
}

# Check if anything changed
AFTER=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM hate_crime_incidents WHERE year = $TARGET_YEAR" 2>/dev/null || echo "0")

if [ "$BEFORE" = "$AFTER" ]; then
    echo "  No new data for $TARGET_YEAR (rows unchanged: $AFTER)"
else
    echo "  Updated! $TARGET_YEAR: $BEFORE → $AFTER rows"
    # Checkpoint WAL and verify
    sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;"
    echo "  DB checkpointed and verified."
fi

echo "[$(date)] Done."
