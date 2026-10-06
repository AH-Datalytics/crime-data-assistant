#!/usr/bin/env python3
"""
Fetch NIBRS national coverage data from the CDE API and store in nibrs.db.

Creates/replaces table `nibrs_national_coverage` with columns:
  year INTEGER PRIMARY KEY, us_population INTEGER,
  participated_population INTEGER, coverage_pct REAL

Usage:
  python update-nibrs-coverage.py --db-path /opt/nibrs/nibrs.db
  python update-nibrs-coverage.py --db-path C:/Users/jeffm/some/local/nibrs.db
"""

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime
from urllib.request import urlopen, Request


def get_api_url():
    """Build API URL with dynamic end date (current year + 1)."""
    end_year = datetime.now().year + 1
    return (
        f"https://cde.ucr.cjis.gov/LATEST/nibrs/agency/0/23F"
        f"?from=01-1991&to=12-{end_year}&type=counts"
    )


def fetch_coverage_data():
    """Fetch national coverage JSON from CDE API."""
    url = get_api_url()
    print(f"Fetching: {url}")
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())
    return data


def parse_annual_coverage(data):
    """
    For each year, compute:
      - us_population: January population value
      - participated_population: MAX across all 12 months (skip None)
      - coverage_pct: participated / population * 100
    """
    pops = data["populations"]
    participated = pops["participated_population"]["United States"]
    population = pops["population"]["United States"]

    # Group by year
    yearly_participated = defaultdict(list)  # year -> [values]
    yearly_population = {}  # year -> Jan population

    for key, val in participated.items():
        month, year = key.split("-")
        year = int(year)
        if val is not None:
            yearly_participated[year].append(val)

    for key, val in population.items():
        month, year = key.split("-")
        year = int(year)
        # Use January population (first encountered per year, or always overwrite with 01)
        if month == "01" and val is not None:
            yearly_population[year] = val
        elif year not in yearly_population and val is not None:
            yearly_population[year] = val

    rows = []
    for year in sorted(yearly_participated.keys()):
        if year not in yearly_population:
            continue
        pop = yearly_population[year]
        max_part = max(yearly_participated[year])
        pct = round(max_part / pop * 100, 2) if pop > 0 else 0.0
        rows.append((year, pop, max_part, pct))

    return rows


def write_to_db(rows, db_path):
    """Create/replace nibrs_national_coverage table."""
    conn = sqlite3.connect(db_path)
    conn.execute("DROP TABLE IF EXISTS nibrs_national_coverage")
    conn.execute("""
        CREATE TABLE nibrs_national_coverage (
            year INTEGER PRIMARY KEY,
            us_population INTEGER,
            participated_population INTEGER,
            coverage_pct REAL
        )
    """)
    conn.executemany(
        "INSERT INTO nibrs_national_coverage VALUES (?, ?, ?, ?)", rows
    )
    conn.commit()
    print(f"\nWrote {len(rows)} rows to {db_path}")
    conn.close()


def main():
    parser = argparse.ArgumentParser(description="Update NIBRS national coverage table")
    parser.add_argument(
        "--db-path",
        default="/opt/nibrs/nibrs.db",
        help="Path to nibrs.db (default: /opt/nibrs/nibrs.db)",
    )
    args = parser.parse_args()

    data = fetch_coverage_data()
    rows = parse_annual_coverage(data)

    # Print summary
    print(f"\n{'Year':<6} {'Population':>14} {'Participated':>14} {'Coverage':>9}")
    print("-" * 46)
    for year, pop, part, pct in rows:
        print(f"{year:<6} {pop:>14,} {part:>14,} {pct:>8.2f}%")

    write_to_db(rows, args.db_path)


if __name__ == "__main__":
    # Writes nibrs.db, so it takes the same maintenance lock as the monthly updater and the
    # server-side rollup refresh instead of racing them.
    import nibrs_maintenance_lock
    with nibrs_maintenance_lock.held("update-nibrs-coverage"):
        main()
