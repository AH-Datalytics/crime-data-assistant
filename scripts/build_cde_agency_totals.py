"""
Build cde_agency_totals table by comparing CDE aggregated counts
against our NIBRS master file counts per agency/offense/year.

Hits the CDE API: /LATEST/nibrs/agency/{ori}/{offense}?from=01-1991&to=2-2026&type=counts
Focuses on agencies with pop >= 50K and key offense codes.

Usage:
  python build_cde_agency_totals.py [--db /path/to/nibrs.db] [--min-pop 50000] [--resume]
"""

import sqlite3
import json
import time
import sys
import argparse
import urllib.request
import urllib.error
from collections import defaultdict

CDE_BASE = "https://cde.ucr.cjis.gov/LATEST/nibrs/agency"

# Key offense codes that users commonly query
OFFENSE_CODES = [
    "09A",  # Murder
    "09B",  # Negligent Manslaughter
    "11A",  # Rape
    "120",  # Robbery
    "13A",  # Aggravated Assault
    "200",  # Arson
    "220",  # Burglary
    "23F",  # Theft from Motor Vehicle
    "23H",  # All Other Larceny
    "240",  # Motor Vehicle Theft
    "510",  # Bribery
    "520",  # Weapon Law Violations
    "720",  # Animal Cruelty
    "64A",  # Human Trafficking - Commercial Sex
    "64B",  # Human Trafficking - Involuntary Servitude
    "26A",  # Fraud - False Pretenses
    "35A",  # Drug/Narcotic Violations
    "40A",  # Prostitution
    "90D",  # DUI — may not exist in master files
]

# Actually, let's just do ALL offenses the CDE supports
# We'll get them from whatever the DB has
# But focus on the big ones first, then expand

KEY_OFFENSES = None  # Will be populated from DB at runtime (all offense codes)


def fetch_cde_counts(ori: str, offense: str, retries: int = 3) -> dict:
    """Fetch CDE aggregated counts for an agency/offense combo.
    Returns {year: {"offenses": count, "clearances": count}} or empty dict on failure.
    """
    url = f"{CDE_BASE}/{ori}/{offense}?from=01-1991&to=2-2026&type=counts"

    for attempt in range(retries):
        try:
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "CrimeDataAssistant/1.0")
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())

            actuals = data.get("offenses", {}).get("actuals", {})

            # The actuals dict has keys like:
            #   "Baltimore Police Department Offenses"
            #   "Baltimore Police Department Clearances"
            #   (sometimes state and national keys too, but we filter those out)
            # Strategy: pick the first "Offenses" key that is NOT "United States"
            # and NOT a state name (state keys contain " Offenses" but no department/police/sheriff)
            agency_offenses = None
            agency_clearances = None
            for key, vals in actuals.items():
                key_lower = key.lower()
                is_national = "united states" in key_lower
                # State-level keys typically end with just "State Offenses" pattern
                # Agency keys contain department/police/sheriff/office etc.
                # Simplest: the actuals dict for single-agency queries has at most 2 keys
                # (agency offenses + agency clearances) — just take them
                if is_national:
                    continue
                if "offenses" in key_lower and agency_offenses is None:
                    agency_offenses = vals
                elif "clearances" in key_lower and agency_clearances is None:
                    agency_clearances = vals

            if not agency_offenses:
                return {}

            # Aggregate monthly to annual
            result = {}
            for k, v in agency_offenses.items():
                month, year = k.split("-")
                yr = int(year)
                if v is not None and v >= 0:
                    if yr not in result:
                        result[yr] = {"cde_count": 0, "cde_clearances": 0}
                    result[yr]["cde_count"] += v

            if agency_clearances:
                for k, v in agency_clearances.items():
                    month, year = k.split("-")
                    yr = int(year)
                    if v is not None and v >= 0:
                        if yr not in result:
                            result[yr] = {"cde_count": 0, "cde_clearances": 0}
                        result[yr]["cde_clearances"] += v

            return result

        except urllib.error.HTTPError as e:
            if e.code == 403:
                # Not found or not available
                return {}
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                print(f"  HTTP error {e.code} for {ori}/{offense}", file=sys.stderr)
                return {}
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                print(f"  Error for {ori}/{offense}: {e}", file=sys.stderr)
                return {}

    return {}


def get_master_counts(conn: sqlite3.Connection, ori: str, offense: str) -> dict:
    """Get annual offense counts from summary_city_monthly (much faster than raw offenses table)."""
    rows = conn.execute(
        "SELECT year, SUM(offense_count) FROM summary_city_monthly WHERE ori = ? AND ucr_offense_code = ? GROUP BY year",
        (ori, offense)
    ).fetchall()
    return {r[0]: r[1] for r in rows}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/opt/nibrs/nibrs.db")
    parser.add_argument("--min-pop", type=int, default=50000)
    parser.add_argument("--resume", action="store_true", help="Skip ORIs already in table")
    parser.add_argument("--offense", help="Single offense code to process")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")

    # Create table
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cde_agency_totals (
            ori TEXT NOT NULL,
            year INTEGER NOT NULL,
            offense_abbrev TEXT NOT NULL,
            cde_count INTEGER,
            cde_clearances INTEGER,
            master_count INTEGER,
            ratio REAL,
            flagged INTEGER DEFAULT 0,
            PRIMARY KEY (ori, year, offense_abbrev)
        )
    """)
    conn.commit()

    # Get agencies
    agencies = conn.execute(
        "SELECT DISTINCT ori, city, state FROM agencies WHERE population >= ? AND state != 'FS' AND city != '' ORDER BY population DESC",
        (args.min_pop,)
    ).fetchall()
    print(f"Processing {len(agencies)} agencies (pop >= {args.min_pop:,})", flush=True)

    # Get all offense codes from summary table (much faster than offenses table)
    all_offenses = [r[0] for r in conn.execute(
        "SELECT DISTINCT ucr_offense_code FROM summary_city_monthly ORDER BY ucr_offense_code"
    ).fetchall()]
    offenses = [args.offense] if args.offense else all_offenses
    print(f"Offense codes ({len(offenses)}): {offenses}", flush=True)
    total_calls = len(agencies) * len(offenses)
    print(f"Total API calls: {total_calls:,}", flush=True)

    # Preload all master counts into memory (one big query, avoids per-agency DB hits)
    print("Preloading master file counts from summary table...", flush=True)
    ori_set = {a[0] for a in agencies}
    master_data = {}  # {(ori, offense, year): count}
    for row in conn.execute(
        "SELECT ori, ucr_offense_code, year, SUM(offense_count) FROM summary_city_monthly GROUP BY ori, ucr_offense_code, year"
    ).fetchall():
        if row[0] in ori_set:
            master_data[(row[0], row[1], row[2])] = row[3]
    print(f"Loaded {len(master_data):,} master count entries", flush=True)

    # Track which ORIs are already done (for resume)
    done_oris = set()
    if args.resume:
        rows = conn.execute("SELECT DISTINCT ori FROM cde_agency_totals").fetchall()
        done_oris = {r[0] for r in rows}
        print(f"Resuming: {len(done_oris)} agencies already done", flush=True)

    call_count = 0
    insert_count = 0
    flagged_count = 0

    for i, (ori, city, state) in enumerate(agencies):
        if args.resume and ori in done_oris:
            continue

        for offense in offenses:
            call_count += 1

            # Rate limit: ~4 requests/sec
            time.sleep(0.25)

            cde_data = fetch_cde_counts(ori, offense)
            if not cde_data:
                continue

            for year, cde_vals in cde_data.items():
                cde_count = cde_vals["cde_count"]
                cde_clear = cde_vals["cde_clearances"]
                master_count = master_data.get((ori, offense, year), 0)

                if cde_count == 0 and master_count == 0:
                    continue

                ratio = round(master_count / cde_count, 3) if cde_count > 0 else None

                # Flag if ratio is below 0.8 (master has < 80% of CDE count)
                # or if CDE has data but master has 0
                flagged = 0
                if cde_count >= 50:  # Only flag if meaningful count
                    if master_count == 0:
                        flagged = 1
                    elif ratio is not None and ratio < 0.8:
                        flagged = 1

                conn.execute("""
                    INSERT OR REPLACE INTO cde_agency_totals
                    (ori, year, offense_abbrev, cde_count, cde_clearances, master_count, ratio, flagged)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (ori, year, offense, cde_count, cde_clear, master_count, ratio, flagged))
                insert_count += 1
                if flagged:
                    flagged_count += 1

            # Commit every agency
            conn.commit()

        if (i + 1) % 10 == 0:
            pct = (i + 1) / len(agencies) * 100
            print(f"  [{pct:.1f}%] {i+1}/{len(agencies)} agencies, {call_count} API calls, {insert_count} rows, {flagged_count} flagged", flush=True)

    conn.commit()
    conn.close()
    print(f"\nDone. {insert_count} rows inserted, {flagged_count} flagged.")


if __name__ == "__main__":
    main()
