"""
Build summary_clearance_detail table from incidents + offenses + arrestees.
Breaks down clearances into: arrest, and each exceptional type (A-E).

Usage:
  python build_clearance_detail.py [--db /path/to/nibrs.db]
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

    print("Building summary_clearance_detail...", flush=True)
    start = time.time()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS summary_clearance_detail (
            year INTEGER,
            state TEXT,
            ori TEXT,
            ucr_offense_code TEXT,
            cleared_by_arrest INTEGER,
            cleared_A INTEGER,
            cleared_B INTEGER,
            cleared_C INTEGER,
            cleared_D INTEGER,
            cleared_E INTEGER,
            total_offenses INTEGER,
            PRIMARY KEY (year, state, ori, ucr_offense_code)
        )
    """)
    conn.execute("DELETE FROM summary_clearance_detail")
    conn.commit()

    # Step 1: Build temp table of incidents with arrestees
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
    print("Step 2: Running INSERT...", flush=True)
    conn.execute("""
        INSERT INTO summary_clearance_detail
        SELECT
            i.year,
            i.state,
            i.ori,
            o.ucr_offense_code,
            SUM(CASE WHEN ha.ori IS NOT NULL AND (i.cleared_exceptionally = 'N' OR i.cleared_exceptionally = '') THEN 1 ELSE 0 END) AS cleared_by_arrest,
            SUM(CASE WHEN i.cleared_exceptionally = 'A' THEN 1 ELSE 0 END) AS cleared_A,
            SUM(CASE WHEN i.cleared_exceptionally = 'B' THEN 1 ELSE 0 END) AS cleared_B,
            SUM(CASE WHEN i.cleared_exceptionally = 'C' THEN 1 ELSE 0 END) AS cleared_C,
            SUM(CASE WHEN i.cleared_exceptionally = 'D' THEN 1 ELSE 0 END) AS cleared_D,
            SUM(CASE WHEN i.cleared_exceptionally = 'E' THEN 1 ELSE 0 END) AS cleared_E,
            COUNT(*) AS total_offenses
        FROM incidents i
        JOIN offenses o ON o.ori = i.ori AND o.incident_num = i.incident_num AND o.year = i.year
        LEFT JOIN _tmp_has_arrestee ha ON ha.ori = i.ori AND ha.incident_num = i.incident_num AND ha.year = i.year
        GROUP BY i.year, i.state, i.ori, o.ucr_offense_code
    """)
    conn.commit()

    elapsed = time.time() - start
    cnt = conn.execute("SELECT COUNT(*) FROM summary_clearance_detail").fetchone()[0]
    print(f"Built {cnt:,} rows in {elapsed:.0f}s", flush=True)

    print("Creating indexes...", flush=True)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scd_ori_year ON summary_clearance_detail(ori, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scd_state_year ON summary_clearance_detail(state, year)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_scd_offense_year ON summary_clearance_detail(ucr_offense_code, year)")
    conn.commit()

    elapsed2 = time.time() - start
    print(f"Done in {elapsed2:.0f}s total", flush=True)

    # Quick test
    rows = conn.execute("""
        SELECT year, total_offenses, cleared_by_arrest,
            cleared_A, cleared_B, cleared_C, cleared_D, cleared_E
        FROM summary_clearance_detail
        WHERE ori = 'TXHPD0000' AND ucr_offense_code = '11A' AND year BETWEEN 2022 AND 2025
        ORDER BY year
    """).fetchall()
    print("\nTest: Houston rape clearance detail 2022-2025:")
    for r in rows:
        print(f"  {r[0]}: total={r[1]}, arrest={r[2]}, A(death)={r[3]}, B(prosecution)={r[4]}, C(custody)={r[5]}, D(victim)={r[6]}, E(juvenile)={r[7]}")

    conn.close()


if __name__ == "__main__":
    main()
