#!/usr/bin/env python3
"""
Build nibrs_state_coverage table from agencies + nibrs_agency_completeness.

For each (state, year), calculates:
  - total_agencies: all agencies in the state
  - reporting_agencies: agencies with >= 6 months reported
  - total_population: sum of all agency populations
  - reporting_population: sum of populations for reporting agencies
  - coverage_pct: reporting_population / total_population * 100

Depends on tables already in nibrs.db:
  - agencies (ori, year, state, population)
  - nibrs_agency_completeness (ori, year, months_reported, total_offenses)

Usage:
  python build-nibrs-state-coverage.py --db-path /opt/nibrs/nibrs.db
"""

import argparse
import sqlite3
import sys


def build_state_coverage(db_path: str):
    conn = sqlite3.connect(db_path)

    # Check required tables exist
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    for t in ("agencies", "nibrs_agency_completeness"):
        if t not in tables:
            print(f"ERROR: Required table '{t}' not found in {db_path}")
            sys.exit(1)

    print("Building nibrs_state_coverage from agencies + nibrs_agency_completeness...")

    conn.execute("DROP TABLE IF EXISTS nibrs_state_coverage")
    conn.execute("""
        CREATE TABLE nibrs_state_coverage (
            state TEXT NOT NULL,
            year INTEGER NOT NULL,
            total_agencies INTEGER,
            reporting_agencies INTEGER,
            total_population INTEGER,
            reporting_population INTEGER,
            coverage_pct REAL,
            PRIMARY KEY (state, year)
        )
    """)

    # Calculate coverage: an agency "reports" if it has >= 6 months in completeness table
    rows = conn.execute("""
        INSERT INTO nibrs_state_coverage
        SELECT
            a.state,
            a.year,
            COUNT(DISTINCT a.ori) AS total_agencies,
            COUNT(DISTINCT c.ori) AS reporting_agencies,
            SUM(a.population) AS total_population,
            SUM(CASE WHEN c.ori IS NOT NULL THEN a.population ELSE 0 END) AS reporting_population,
            ROUND(
                SUM(CASE WHEN c.ori IS NOT NULL THEN a.population ELSE 0 END) * 100.0
                / NULLIF(SUM(a.population), 0),
                2
            ) AS coverage_pct
        FROM agencies a
        LEFT JOIN nibrs_agency_completeness c
            ON a.ori = c.ori AND a.year = c.year AND c.months_reported >= 6
        WHERE a.population > 0
        GROUP BY a.state, a.year
        ORDER BY a.state, a.year
    """)
    conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM nibrs_state_coverage").fetchone()[0]
    states = conn.execute("SELECT COUNT(DISTINCT state) FROM nibrs_state_coverage").fetchone()[0]
    years = conn.execute("SELECT COUNT(DISTINCT year) FROM nibrs_state_coverage").fetchone()[0]
    print(f"Wrote {total} rows ({states} states × {years} years)")

    # Show low-coverage states for the latest year
    latest = conn.execute("SELECT MAX(year) FROM nibrs_state_coverage").fetchone()[0]
    print(f"\nLow-coverage states ({latest}, < 75% population coverage):")
    print(f"{'State':<6} {'Coverage':>9} {'Reporting Pop':>16} {'Total Pop':>14}")
    print("-" * 48)
    for r in conn.execute("""
        SELECT state, coverage_pct, reporting_population, total_population
        FROM nibrs_state_coverage
        WHERE year = ? AND coverage_pct < 75
        ORDER BY coverage_pct ASC
    """, (latest,)).fetchall():
        print(f"  {r[0]:<4} {r[1]:>8.1f}% {r[2]:>15,} {r[3]:>13,}")

    conn.close()


def main():
    parser = argparse.ArgumentParser(description="Build NIBRS state-level coverage table")
    parser.add_argument(
        "--db-path",
        default="/opt/nibrs/nibrs.db",
        help="Path to nibrs.db (default: /opt/nibrs/nibrs.db)",
    )
    args = parser.parse_args()
    build_state_coverage(args.db_path)


if __name__ == "__main__":
    # Writes nibrs.db, so it takes the same maintenance lock as the monthly updater and the
    # server-side rollup refresh instead of racing them.
    import nibrs_maintenance_lock
    with nibrs_maintenance_lock.held("build-nibrs-state-coverage"):
        main()
