"""
Build clean property value summary tables.

1. Clean summary_property_offense in-place: zero out rows where per-record avg >= $1M
   (catches NIBRS $999M cap values, near-cap $999,999,998, and systematic data entry errors like NY kidnapping)
2. Build summary_property_value_state: pre-aggregated at (state, year, offense, loss_type, description)
   with a 'US' national rollup for fast aggregate queries

Run on VPS: cd /opt/nibrs/app && python3 ../scripts/build_property_summary.py
"""
import sqlite3
import time
import sys

DB_PATH = "/opt/nibrs/nibrs.db"

def main():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    cur = conn.cursor()

    # Step 1: Clean summary_property_offense — zero out outlier rows
    print("Step 1: Cleaning outliers from summary_property_offense...")
    t0 = time.time()

    # Count affected rows first
    cur.execute("""
        SELECT COUNT(*), SUM(total_value)
        FROM summary_property_offense
        WHERE record_count > 0
          AND CAST(total_value AS REAL) / record_count >= 1000000
    """)
    affected_rows, affected_value = cur.fetchone()
    print(f"  Found {affected_rows:,} outlier rows totaling ${affected_value:,.0f}")

    # Zero out the value on outlier rows (keep record_count for counting incidents)
    cur.execute("""
        UPDATE summary_property_offense
        SET total_value = 0
        WHERE record_count > 0
          AND CAST(total_value AS REAL) / record_count >= 1000000
    """)
    conn.commit()
    print(f"  Cleaned {cur.rowcount:,} rows in {time.time() - t0:.1f}s")

    # Step 2: Build state-level summary table
    print("\nStep 2: Building summary_property_value_state...")
    t0 = time.time()

    cur.execute("DROP TABLE IF EXISTS summary_property_value_state")
    conn.commit()

    cur.execute("""
        CREATE TABLE summary_property_value_state (
            state TEXT NOT NULL,
            year INTEGER NOT NULL,
            ucr_offense_code TEXT NOT NULL,
            type_property_loss TEXT NOT NULL,
            property_description TEXT NOT NULL,
            total_value INTEGER NOT NULL DEFAULT 0,
            record_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (state, year, ucr_offense_code, type_property_loss, property_description)
        )
    """)
    conn.commit()

    # Insert state-level aggregates
    cur.execute("""
        INSERT INTO summary_property_value_state
            (state, year, ucr_offense_code, type_property_loss, property_description, total_value, record_count)
        SELECT state, year, ucr_offense_code, type_property_loss, property_description,
            SUM(total_value), SUM(record_count)
        FROM summary_property_offense
        GROUP BY state, year, ucr_offense_code, type_property_loss, property_description
    """)
    state_rows = cur.rowcount
    conn.commit()
    print(f"  Inserted {state_rows:,} state-level rows in {time.time() - t0:.1f}s")

    # Insert national rollup (state = 'US')
    t0 = time.time()
    cur.execute("""
        INSERT INTO summary_property_value_state
            (state, year, ucr_offense_code, type_property_loss, property_description, total_value, record_count)
        SELECT 'US', year, ucr_offense_code, type_property_loss, property_description,
            SUM(total_value), SUM(record_count)
        FROM summary_property_offense
        GROUP BY year, ucr_offense_code, type_property_loss, property_description
    """)
    national_rows = cur.rowcount
    conn.commit()
    print(f"  Inserted {national_rows:,} national rollup rows in {time.time() - t0:.1f}s")

    # Step 3: Create indexes
    print("\nStep 3: Creating indexes...")
    t0 = time.time()
    cur.execute("CREATE INDEX IF NOT EXISTS idx_spvs_year ON summary_property_value_state(year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_spvs_state_year ON summary_property_value_state(state, year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_spvs_offense ON summary_property_value_state(ucr_offense_code, year)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_spvs_loss_type ON summary_property_value_state(type_property_loss, year)")
    conn.commit()
    print(f"  Indexes created in {time.time() - t0:.1f}s")

    # Step 4: Verify
    print("\nStep 4: Verification...")
    cur.execute("SELECT COUNT(*) FROM summary_property_value_state")
    total = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM summary_property_value_state WHERE state = 'US'")
    us_rows = cur.fetchone()[0]
    print(f"  Total rows: {total:,} ({total - us_rows:,} state + {us_rows:,} national)")

    # Spot check: national stolen value by year
    cur.execute("""
        SELECT year, SUM(total_value) as total, SUM(record_count) as records,
            ROUND(CAST(SUM(total_value) AS REAL) / NULLIF(SUM(record_count), 0), 0) as avg_per
        FROM summary_property_value_state
        WHERE state = 'US' AND type_property_loss = '7' AND total_value > 0
        GROUP BY year ORDER BY year
    """)
    print("\n  National stolen value by year (cleaned):")
    print(f"  {'Year':<6} {'Total':>16} {'Records':>10} {'Avg/Record':>12}")
    for row in cur.fetchall():
        yr, tot, rec, avg = row
        print(f"  {yr:<6} ${tot:>15,} {rec:>10,} ${avg:>11,.0f}")

    conn.close()
    print("\nDone!")

if __name__ == "__main__":
    main()
