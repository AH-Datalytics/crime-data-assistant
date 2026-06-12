#!/usr/bin/env python3
"""Build nibrs_consistent_reporters from nibrs_agency_completeness.

An ORI is a consistent reporter for a chosen year span only when it has
months_reported = 12 for every year in that span.
"""

import argparse
import os
import sqlite3
import time
from collections import defaultdict


BATCH_SIZE = 100_000


def table_exists(conn, table):
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def create_table(conn):
    conn.executescript(
        """
        DROP TABLE IF EXISTS nibrs_consistent_reporters;
        CREATE TABLE nibrs_consistent_reporters (
          start_year INTEGER NOT NULL,
          end_year INTEGER NOT NULL,
          ori TEXT NOT NULL,
          years_required INTEGER NOT NULL,
          PRIMARY KEY (start_year, end_year, ori)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_ncr_ori_range
          ON nibrs_consistent_reporters(ori, start_year, end_year);
        CREATE INDEX IF NOT EXISTS idx_ncr_end_start
          ON nibrs_consistent_reporters(end_year, start_year);
        """
    )


def contiguous_runs(years):
    if not years:
        return
    start = prev = years[0]
    for year in years[1:]:
        if year == prev + 1:
            prev = year
            continue
        yield start, prev
        start = prev = year
    yield start, prev


def span_rows(full_years_by_ori):
    for ori, years in full_years_by_ori.items():
        for run_start, run_end in contiguous_runs(years):
            run = list(range(run_start, run_end + 1))
            for i, start_year in enumerate(run):
                for end_year in run[i:]:
                    yield (start_year, end_year, ori, end_year - start_year + 1)


def rebuild_consistent_reporters(conn, log=print):
    if not table_exists(conn, "nibrs_agency_completeness"):
        raise RuntimeError("nibrs_agency_completeness table not found")

    t = time.time()
    log("Building nibrs_consistent_reporters...")
    rows = conn.execute(
        """
        SELECT ori, year
        FROM nibrs_agency_completeness
        WHERE months_reported = 12
        ORDER BY ori, year
        """
    ).fetchall()

    full_years_by_ori = defaultdict(list)
    for ori, year in rows:
        if ori is None or year is None:
            continue
        full_years_by_ori[str(ori)].append(int(year))

    create_table(conn)
    insert = conn.cursor()
    batch = []
    total = 0
    for row in span_rows(full_years_by_ori):
        batch.append(row)
        if len(batch) >= BATCH_SIZE:
            insert.executemany(
                "INSERT INTO nibrs_consistent_reporters (start_year, end_year, ori, years_required) VALUES (?, ?, ?, ?)",
                batch,
            )
            total += len(batch)
            batch.clear()
    if batch:
        insert.executemany(
            "INSERT INTO nibrs_consistent_reporters (start_year, end_year, ori, years_required) VALUES (?, ?, ?, ?)",
            batch,
        )
        total += len(batch)

    conn.commit()
    if total == 0:
        raise RuntimeError("nibrs_consistent_reporters build produced zero rows")

    stats = conn.execute(
        """
        SELECT COUNT(*) AS rows,
               COUNT(DISTINCT ori) AS agencies,
               MIN(start_year) AS first_year,
               MAX(end_year) AS last_year,
               COUNT(DISTINCT start_year || '-' || end_year) AS spans
        FROM nibrs_consistent_reporters
        """
    ).fetchone()
    log(
        "  nibrs_consistent_reporters ready: "
        f"{stats[0]:,} rows, {stats[1]:,} agencies, {stats[4]:,} spans, "
        f"{stats[2]}-{stats[3]} ({time.time() - t:.0f}s)"
    )
    return {
        "rows": stats[0],
        "agencies": stats[1],
        "first_year": stats[2],
        "last_year": stats[3],
        "spans": stats[4],
    }


def main():
    parser = argparse.ArgumentParser(description="Build nibrs_consistent_reporters")
    parser.add_argument("--db", default=os.environ.get("NIBRS_DB_PATH", "nibrs.db"))
    parser.add_argument("--apply", action="store_true", help="Replace nibrs_consistent_reporters in the database")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    try:
        if args.apply:
            rebuild_consistent_reporters(conn)
        else:
            if not table_exists(conn, "nibrs_agency_completeness"):
                raise RuntimeError("nibrs_agency_completeness table not found")
            count = conn.execute(
                "SELECT COUNT(*) FROM nibrs_agency_completeness WHERE months_reported = 12"
            ).fetchone()[0]
            print(f"Dry run: {count:,} full-agency-year rows are available.")
            print("Re-run with --apply to replace nibrs_consistent_reporters.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
