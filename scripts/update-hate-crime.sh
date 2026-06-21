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
PROTECTED_YEARS="${PROTECTED_UPDATE_YEARS:-2025}"
TARGET_YEAR="${HATE_CRIME_UPDATE_YEAR:-$CURRENT_YEAR}"

echo "[$(date)] Checking for hate crime data updates..."
echo "  Protected years: $PROTECTED_YEARS"

# Get current max year in DB
MAX_YEAR=$(sqlite3 "$DB_PATH" "SELECT MAX(year) FROM hate_crime_incidents" 2>/dev/null || echo "0")
echo "  Current max year in DB: $MAX_YEAR"

IFS=',' read -ra PROTECTED_YEAR_LIST <<< "$PROTECTED_YEARS"
for protected_year in "${PROTECTED_YEAR_LIST[@]}"; do
    protected_year="${protected_year//[[:space:]]/}"
    if [ "$protected_year" = "$TARGET_YEAR" ]; then
        echo "  Refusing to update protected hate crime year $TARGET_YEAR."
        exit 1
    fi
done

# Attempt import — will fail gracefully if the year isn't available on CDE yet
echo "  Attempting to import year $TARGET_YEAR..."
cd "$APP_DIR"

# Save row count before
BEFORE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM hate_crime_incidents WHERE year = $TARGET_YEAR" 2>/dev/null || echo "0")

python3 -u "$SCRIPT" --years "$TARGET_YEAR" --db "$DB_PATH" --protected-years "$PROTECTED_YEARS" 2>&1 || {
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
