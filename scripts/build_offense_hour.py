"""
Build summary_offense_hour table from raw incidents + offenses.

Aggregates offense counts by year, state, ucr_offense_code, and incident_hour.
Joins incidents (has hour) to offenses (has offense code) on (year, ori, incident_num).

Usage:
    python build_offense_hour.py [--db /path/to/nibrs.db]
"""

import argparse
import sqlite3
import time

DEFAULT_DB = "/opt/nibrs/nibrs.db"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DEFAULT_DB)
    args = parser.parse_args()

    db = sqlite3.connect(args.db)
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA busy_timeout = 30000")
    db.execute("PRAGMA cache_size = -512000")  # 512MB cache

    print("Dropping old table if exists...")
    db.execute("DROP TABLE IF EXISTS summary_offense_hour")

    print("Building summary_offense_hour (this will take a while)...")
    t0 = time.time()

    db.execute("""
        CREATE TABLE summary_offense_hour AS
        SELECT
            i.year,
            i.state,
            o.ucr_offense_code,
            i.incident_hour,
            COUNT(*) AS offense_count
        FROM incidents i
        JOIN offenses o ON o.year = i.year AND o.ori = i.ori AND o.incident_num = i.incident_num
        WHERE i.incident_hour != '' AND i.incident_hour IS NOT NULL
        GROUP BY i.year, i.state, o.ucr_offense_code, i.incident_hour
    """)
    db.commit()

    elapsed = time.time() - t0
    row_count = db.execute("SELECT COUNT(*) FROM summary_offense_hour").fetchone()[0]
    print(f"Created summary_offense_hour: {row_count:,} rows in {elapsed:.0f}s")

    print("Creating indexes...")
    db.execute("CREATE INDEX idx_soh_offense_year ON summary_offense_hour(ucr_offense_code, year)")
    db.execute("CREATE INDEX idx_soh_state_year ON summary_offense_hour(state, year)")
    db.commit()

    print("Done!")
    db.close()

if __name__ == "__main__":
    main()
