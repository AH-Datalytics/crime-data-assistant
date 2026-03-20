"""
Build summary_clearance_type table from incidents + offenses.
Breaks down clearances into arrest vs exceptional by agency/month/offense.

Usage:
  python build_clearance_summary.py [--db /path/to/nibrs.db]
"""

import sqlite3
import time
import argparse


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/opt/nibrs/nibrs.db")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db, timeout=60)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=60000")

    print("Building summary_clearance_type...", flush=True)
    start = time.time()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_clearance_type (
            year INTEGER,
            month INTEGER,
            state TEXT,
            ori TEXT,
            ucr_offense_code TEXT,
            total_offenses INTEGER,
            cleared_by_arrest INTEGER,
            cleared_exceptional INTEGER,
            PRIMARY KEY (year, month, state, ori, ucr_offense_code)
        )
    """)
    conn.execute("DELETE FROM summary_clearance_type")
    conn.commit()

    print("Running INSERT from incidents + offenses join (this may take a while)...", flush=True)

    # Step 1: Create temp table of incidents that have arrestees
    print("Step 1: Building temp table of incidents with arrestees...", flush=True)
    conn.execute("DROP TABLE IF EXISTS _tmp_has_arrestee")
    conn.execute("""
        CREATE TEMP TABLE _tmp_has_arrestee AS
        SELECT DISTINCT ori, incident_num, year
        FROM arrestees
    """)
    conn.execute("CREATE INDEX _tmp_ha_idx ON _tmp_has_arrestee(ori, incident_num, year)")
    conn.commit()
    ha_count = conn.execute("SELECT COUNT(*) FROM _tmp_has_arrestee").fetchone()[0]
    print(f"  {ha_count:,} incidents with arrestees", flush=True)

    # Step 2: Join incidents + offenses + arrestee flag and aggregate
    print("Step 2: Running INSERT (incidents + offenses + arrestee flag)...", flush=True)
    conn.execute("""
        INSERT INTO summary_clearance_type
        SELECT
            i.year,
            CAST(SUBSTR(i.incident_date, 5, 2) AS INTEGER) AS month,
            i.state,
            i.ori,
            o.ucr_offense_code,
            COUNT(*) AS total_offenses,
            SUM(CASE WHEN ha.ori IS NOT NULL AND (i.cleared_exceptionally = 'N' OR i.cleared_exceptionally = '') THEN 1 ELSE 0 END) AS cleared_by_arrest,
            SUM(CASE WHEN i.cleared_exceptionally IN ('A','B','C','D','E') THEN 1 ELSE 0 END) AS cleared_exceptional
        FROM incidents i
        JOIN offenses o ON o.ori = i.ori AND o.incident_num = i.incident_num AND o.year = i.year
        LEFT JOIN _tmp_has_arrestee ha ON ha.ori = i.ori AND ha.incident_num = i.incident_num AND ha.year = i.year
        GROUP BY i.year, CAST(SUBSTR(i.incident_date, 5, 2) AS INTEGER), i.state, i.ori, o.ucr_offense_code
    """)
    conn.commit()

    elapsed = time.time() - start
    cnt = conn.execute("SELECT COUNT(*) FROM summary_clearance_type").fetchone()[0]
    print(f"Built {cnt:,} rows in {elapsed:.0f}s", flush=True)

    print("Creating indexes...", flush=True)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sct_ori_year ON summary_clearance_type(ori, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sct_state_year ON summary_clearance_type(state, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sct_offense_year ON summary_clearance_type(ucr_offense_code, year)")
    conn.commit()

    elapsed2 = time.time() - start
    print(f"Done in {elapsed2:.0f}s total", flush=True)

    # Quick test
    rows = conn.execute("""
        SELECT year, SUM(total_offenses) AS offenses,
            SUM(cleared_by_arrest) AS by_arrest,
            SUM(cleared_exceptional) AS exceptional
        FROM summary_clearance_type
        WHERE state = 'VA' AND ucr_offense_code = '11A' AND year BETWEEN 2022 AND 2025
        GROUP BY year ORDER BY year
    """).fetchall()
    print("\nTest: VA rape clearances 2022-2025:")
    for r in rows:
        print(f"  {r[0]}: offenses={r[1]}, arrest={r[2]}, exceptional={r[3]}")

    conn.close()


if __name__ == "__main__":
    main()
