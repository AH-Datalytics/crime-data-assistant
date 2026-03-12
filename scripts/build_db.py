"""
Ingest RTCI CSV into SQLite with pre-computed summary tables.

Usage:
    python scripts/build_db.py

Reads: ../Downloads/December 2025 Combined Agencies with ORI.csv
Writes: crime_data.db
"""

import csv
import sqlite3
import os
from collections import defaultdict

CSV_PATH = os.path.join(
    os.path.expanduser("~"),
    "Downloads",
    "December 2025 Combined Agencies with ORI.csv",
)
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "crime_data.db")

OFFENSES = [
    "Murder",
    "Rape",
    "Robbery",
    "Aggravated Assault",
    "Burglary",
    "Theft",
    "Motor Vehicle Theft",
]


def main():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
        print(f"Removed existing {DB_PATH}")

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Create tables
    cur.executescript(
        """
        CREATE TABLE agency_monthly (
            ori TEXT NOT NULL,
            agency TEXT NOT NULL,
            state TEXT NOT NULL,
            type TEXT NOT NULL,
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            offense TEXT NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (ori, year, month, offense)
        );
        CREATE INDEX idx_am_agency ON agency_monthly(agency, state);
        CREATE INDEX idx_am_state ON agency_monthly(state, year, month);
        CREATE INDEX idx_am_offense ON agency_monthly(offense, year, month);

        CREATE TABLE agencies (
            ori TEXT PRIMARY KEY,
            agency TEXT NOT NULL,
            state TEXT NOT NULL,
            type TEXT NOT NULL,
            total_months INTEGER NOT NULL,
            national_sample INTEGER NOT NULL
        );

        CREATE TABLE national_monthly (
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            offense TEXT NOT NULL,
            count INTEGER NOT NULL,
            agency_count INTEGER NOT NULL,
            PRIMARY KEY (year, month, offense)
        );

        CREATE TABLE state_monthly (
            state TEXT NOT NULL,
            year INTEGER NOT NULL,
            month INTEGER NOT NULL,
            offense TEXT NOT NULL,
            count INTEGER NOT NULL,
            agency_count INTEGER NOT NULL,
            PRIMARY KEY (state, year, month, offense)
        );
    """
    )

    # Read CSV and pivot wide → long
    print(f"Reading {CSV_PATH} ...")
    row_count = 0
    agency_months = defaultdict(set)  # ori → set of (year, month)
    agency_meta = {}  # ori → (agency, state, type)

    with open(CSV_PATH, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        batch = []

        for row in reader:
            ori = row["ori"].strip()
            agency = row["Agency Name"].strip()
            state = row["State"].strip()
            typ = row["Type"].strip()
            year = int(row["Year"])
            month = int(row["Month"])

            agency_meta[ori] = (agency, state, typ)
            agency_months[ori].add((year, month))

            for offense in OFFENSES:
                val = row.get(offense, "").strip()
                if val == "" or val == "`":
                    continue  # Agency doesn't report that offense (or bad data)
                # Strip commas from numbers like "1,568"
                count = int(val.replace(",", ""))
                batch.append((ori, agency, state, typ, year, month, offense, count))

                if len(batch) >= 10000:
                    cur.executemany(
                        "INSERT OR REPLACE INTO agency_monthly VALUES (?,?,?,?,?,?,?,?)", batch
                    )
                    batch.clear()
            row_count += 1

        if batch:
            cur.executemany(
                "INSERT OR REPLACE INTO agency_monthly VALUES (?,?,?,?,?,?,?,?)", batch
            )

    print(f"  {row_count:,} CSV rows processed")

    # Compute max possible months
    all_months = set()
    for months_set in agency_months.values():
        all_months |= months_set
    max_months = len(all_months)
    print(f"  {max_months} distinct year-months in data")

    # Populate agencies table
    for ori, (agency, state, typ) in agency_meta.items():
        total = len(agency_months[ori])
        national_sample = 1 if total == max_months else 0
        cur.execute(
            "INSERT INTO agencies VALUES (?,?,?,?,?,?)",
            (ori, agency, state, typ, total, national_sample),
        )

    ns_count = sum(
        1 for ori in agency_meta if len(agency_months[ori]) == max_months
    )
    print(f"  {len(agency_meta):,} agencies, {ns_count:,} in national sample ({max_months} months)")

    # Aggregate national_monthly from national sample agencies only
    cur.execute(
        """
        INSERT INTO national_monthly (year, month, offense, count, agency_count)
        SELECT am.year, am.month, am.offense, SUM(am.count), COUNT(DISTINCT am.ori)
        FROM agency_monthly am
        JOIN agencies a ON a.ori = am.ori AND a.national_sample = 1
        GROUP BY am.year, am.month, am.offense
    """
    )
    national_rows = cur.execute("SELECT COUNT(*) FROM national_monthly").fetchone()[0]
    print(f"  {national_rows:,} national_monthly rows")

    # Aggregate state_monthly from complete reporters only (max months per state)
    cur.execute(
        """
        INSERT INTO state_monthly (state, year, month, offense, count, agency_count)
        SELECT am.state, am.year, am.month, am.offense, SUM(am.count), COUNT(DISTINCT am.ori)
        FROM agency_monthly am
        JOIN agencies a ON a.ori = am.ori
        WHERE a.total_months = (
            SELECT MAX(a2.total_months) FROM agencies a2 WHERE a2.state = a.state
        )
        GROUP BY am.state, am.year, am.month, am.offense
    """
    )
    state_rows = cur.execute("SELECT COUNT(*) FROM state_monthly").fetchone()[0]
    print(f"  {state_rows:,} state_monthly rows (complete reporters only)")

    conn.commit()
    conn.close()

    size_mb = os.path.getsize(DB_PATH) / (1024 * 1024)
    print(f"\nDone! {DB_PATH} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
