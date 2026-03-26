"""
Incremental update of cde_agency_totals — fetches only the last 3 years
from CDE API to catch FBI updates without re-scraping everything.

Run monthly or after FBI data updates.

Usage:
  python update_cde_totals.py [--db /path/to/nibrs.db] [--years 3]
"""

import sqlite3
import json
import time
import sys
import argparse
import urllib.request
import urllib.error
import datetime
from collections import defaultdict

CDE_BASE = "https://cde.ucr.cjis.gov/LATEST/nibrs/agency"

# Person crime codes — CDE counts these by victim, not by offense
PERSON_CRIME_CODES = {
    "09A", "09B", "09C", "11A", "11B", "11C", "11D",
    "13A", "13B", "13C", "100", "36A", "36B", "64A", "64B",
}


def fetch_cde_counts(ori, offense, from_year, to_year, retries=3):
    """Fetch CDE counts for a date range. Returns {year: {cde_count, cde_clearances}}."""
    url = f"{CDE_BASE}/{ori}/{offense}?from=01-{from_year}&to=12-{to_year}&type=counts"

    for attempt in range(retries):
        try:
            req = urllib.request.Request(url)
            req.add_header("User-Agent", "CrimeDataAssistant/1.0")
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())

            actuals = data.get("offenses", {}).get("actuals", {})
            agency_offenses = None
            agency_clearances = None

            for key, vals in actuals.items():
                key_lower = key.lower()
                if "united states" in key_lower:
                    continue
                if "offenses" in key_lower and agency_offenses is None:
                    agency_offenses = vals
                elif "clearances" in key_lower and agency_clearances is None:
                    agency_clearances = vals

            if not agency_offenses:
                return {}

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

        except urllib.error.HTTPError:
            return {}
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                print(f"  Error {ori}/{offense}: {e}", file=sys.stderr)
                return {}

    return {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/opt/nibrs/nibrs.db")
    parser.add_argument("--years", type=int, default=3, help="How many recent years to update")
    parser.add_argument("--min-pop", type=int, default=50000)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")

    current_year = datetime.datetime.now().year
    from_year = current_year - args.years
    to_year = current_year

    print(f"Updating CDE totals for {from_year}-{to_year}", flush=True)

    agencies = conn.execute(
        "SELECT DISTINCT ori, city, state FROM agencies WHERE population >= ? AND state != 'FS' AND city != '' ORDER BY population DESC",
        (args.min_pop,)
    ).fetchall()

    offenses = [r[0] for r in conn.execute(
        "SELECT DISTINCT ucr_offense_code FROM summary_city_monthly ORDER BY ucr_offense_code"
    ).fetchall()]

    # Preload master counts for the date range
    # Person crimes use victim counts, property/society use offense counts
    master_data = {}
    for row in conn.execute(
        "SELECT ori, ucr_offense_code, year, SUM(offense_count) FROM summary_city_monthly WHERE year >= ? GROUP BY ori, ucr_offense_code, year",
        (from_year,)
    ).fetchall():
        if row[1] not in PERSON_CRIME_CODES:
            master_data[(row[0], row[1], row[2])] = row[3]
    for row in conn.execute(
        "SELECT ori, ucr_offense_code, year, SUM(victim_count) FROM summary_victim_city_monthly WHERE year >= ? GROUP BY ori, ucr_offense_code, year",
        (from_year,)
    ).fetchall():
        if row[1] in PERSON_CRIME_CODES:
            master_data[(row[0], row[1], row[2])] = row[3]

    print(f"{len(agencies)} agencies, {len(offenses)} offenses, {len(master_data):,} master entries", flush=True)

    updated = 0
    flagged = 0

    for i, (ori, city, state) in enumerate(agencies):
        for offense in offenses:
            time.sleep(0.25)
            cde_data = fetch_cde_counts(ori, offense, from_year, to_year)
            if not cde_data:
                continue

            for year, cde_vals in cde_data.items():
                cde_count = cde_vals["cde_count"]
                cde_clear = cde_vals["cde_clearances"]
                master_count = master_data.get((ori, offense, year), 0)

                if cde_count == 0 and master_count == 0:
                    continue

                ratio = round(master_count / cde_count, 3) if cde_count > 0 else None
                is_flagged = 0
                if cde_count >= 50:
                    if master_count == 0:
                        is_flagged = 1
                    elif ratio is not None and ratio < 0.8:
                        is_flagged = 1

                conn.execute("""
                    INSERT OR REPLACE INTO cde_agency_totals
                    (ori, year, offense_abbrev, cde_count, cde_clearances, master_count, ratio, flagged)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (ori, year, offense, cde_count, cde_clear, master_count, ratio, is_flagged))
                updated += 1
                if is_flagged:
                    flagged += 1

        conn.commit()

        if (i + 1) % 10 == 0:
            pct = (i + 1) / len(agencies) * 100
            print(f"  [{pct:.1f}%] {i+1}/{len(agencies)} agencies, {updated} updated, {flagged} flagged", flush=True)

    conn.commit()
    conn.close()
    print(f"\nDone. {updated} rows updated, {flagged} flagged.", flush=True)


if __name__ == "__main__":
    main()
