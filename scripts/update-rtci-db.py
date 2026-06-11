"""
Update crime_data.db from the AH-Datalytics/crime-sample GitHub repo.

Downloads crime_YYYYMM.csv, inserts new month into agency_monthly,
then re-aggregates national_monthly. Optionally deploys to VPS and rebuilds.

Usage:
    # Add a new month (e.g. March 2026):
    python scripts/update-rtci-db.py --month 202603

    # Full rebuild from latest file (replaces all agency_monthly data):
    python scripts/update-rtci-db.py --month 202603 --full-rebuild

    # Deploy to VPS and rebuild after updating:
    python scripts/update-rtci-db.py --month 202603 --deploy

    # Use a local CSV instead of downloading:
    python scripts/update-rtci-db.py --month 202603 --csv /path/to/crime_202603.csv
"""

import argparse
import csv
import io
import os
import re
import sqlite3
import subprocess
import sys

GITHUB_REPO = "AH-Datalytics/crime-sample"
VPS_HOST = "root@178.156.243.51"
# Canonical production DB path (see CLAUDE.md Runtime Paths) — the old
# /opt/nibrs/app/ location is no longer read by the release-based deploys.
VPS_DB = "/opt/nibrs/shared/crime_data.db"
VPS_REPO = "/opt/nibrs/repo"
DEPLOY_BRANCH = "dev"

# Derived-table sources: agency_county_crosswalk must be rebuilt after any
# update because deploys wholesale-replace crime_data.db on the VPS.
CROSSWALK_BUILDER = os.path.join(os.path.dirname(__file__), "build-agency-county-crosswalk.py")
CROSSWALK_SOURCE_DEFAULT = r"C:\Users\jeffm\OneDrive\Documents\Participation Crosswalk.xlsx"
CROSSWALK_CDE_DEFAULT = r"C:\Users\jeffm\OneDrive\Documents\CDE Participation 2000-2023.csv"

# Population source — latest FBI agency populations
POP_CSV_DEFAULT = os.path.join(
    "C:/OneDrive/OneDrive - ahdatalytics.com/Clients/Real Time Crime Index",
    "Open Source Data/Historical Data/outputs/populations.csv"
)

OFFENSE_MAP = {
    "murder_total": "Murder",
    "rape_total": "Rape",
    "robbery_total": "Robbery",
    "assault_total": "Aggravated Assault",
    "burglary_total": "Burglary",
    "theft_total": "Theft",
    "motor_total": "Motor Vehicle Theft",
}


def download_csv(month_str):
    """Download crime_YYYYMM.csv from private GitHub repo using gh CLI."""
    filename = f"crime_{month_str}.csv"
    print(f"Downloading {filename} from {GITHUB_REPO}...")
    result = subprocess.run(
        ["gh", "api", f"repos/{GITHUB_REPO}/contents/outputs/{filename}", "--jq", ".download_url"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"ERROR: {result.stderr.strip()}")
        sys.exit(1)
    url = result.stdout.strip()
    dl = subprocess.run(["curl", "-s", url], capture_output=True, text=True)
    rows = list(csv.DictReader(io.StringIO(dl.stdout)))
    print(f"  {len(rows):,} rows downloaded")
    return rows


def load_local_csv(path):
    print(f"Loading {path}...")
    with open(path, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    print(f"  {len(rows):,} rows")
    return rows


def filter_ori_rows(rows, year=None, month=None):
    """Keep only ORI rows (size=all, id starts with 2 uppercase letters)."""
    filtered = [
        r for r in rows
        if re.match(r"^[A-Z]{2}", r["id"]) and r["size"] == "all"
        and (year is None or int(r["year"]) == year)
        and (month is None or int(r["month"]) == month)
    ]
    print(f"  {len(filtered):,} ORI rows" + (f" for {year}-{month:02d}" if year else ""))
    return filtered


def rows_to_records(ori_rows, sample_oris=None):
    """Convert wide CSV rows to (ori, agency, state, type, year, month, offense, count) tuples.
    If sample_oris is None, include all ORIs (for full rebuild before sample recalc)."""
    records = []
    skipped = 0
    for r in ori_rows:
        ori = r["id"]
        if sample_oris is not None and ori not in sample_oris:
            skipped += 1
            continue
        if sample_oris is not None:
            agency, state, typ = sample_oris[ori]
        else:
            # Extract agency info from CSV row (agency name not in CSV, use ORI prefix for state)
            agency = ori  # placeholder, will be resolved from agencies table later
            state = ori[:2]
            typ = ""
        year = int(r["year"])
        month = int(r["month"])
        for col, offense in OFFENSE_MAP.items():
            val = r.get(col, "").strip().replace(",", "")
            if not val:
                continue
            try:
                count = int(float(val))
            except ValueError:
                continue
            records.append((ori, agency, state, typ, year, month, offense, count))
    if skipped:
        print(f"  {skipped} rows skipped (ORI not in sample_agencies)")
    print(f"  {len(records):,} records")
    return records


def get_sample_oris(db_path):
    """Load sample_agencies from local DB."""
    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT ori, agency, state, type FROM sample_agencies").fetchall()
    conn.close()
    return {ori: (agency, state, typ) for ori, agency, state, typ in rows}


def refresh_populations(db_path, pop_csv):
    """Refresh agency_population from the FBI populations CSV for sample agencies."""
    if not os.path.exists(pop_csv):
        print(f"  WARNING: populations CSV not found at {pop_csv}, skipping population refresh")
        return

    print(f"\nRefreshing agency_population from {os.path.basename(pop_csv)}...")
    conn = sqlite3.connect(db_path)
    sample_oris = set(r[0] for r in conn.execute("SELECT ori FROM sample_agencies"))

    updated = 0
    inserted = 0
    with open(pop_csv, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if r["size"] != "all" or len(r["id"]) != 9:
                continue
            ori = r["id"]
            if ori not in sample_oris:
                continue
            yr = int(r["year"])
            if yr < 2017:
                continue
            pop = int(r["population"])
            existing = conn.execute(
                "SELECT population FROM agency_population WHERE ori=? AND year=?",
                (ori, yr)
            ).fetchone()
            if existing:
                if existing[0] != pop:
                    conn.execute(
                        "UPDATE agency_population SET population=? WHERE ori=? AND year=?",
                        (pop, ori, yr)
                    )
                    updated += 1
            else:
                conn.execute(
                    "INSERT INTO agency_population (ori, year, population) VALUES (?,?,?)",
                    (ori, yr, pop)
                )
                inserted += 1

    conn.commit()
    total_pop = conn.execute(
        "SELECT SUM(p.population) FROM agency_population p "
        "JOIN sample_agencies sa ON sa.ori = p.ori "
        "WHERE p.year = (SELECT MAX(year) FROM agency_population)"
    ).fetchone()[0]
    conn.close()
    print(f"  Updated: {updated}, Inserted: {inserted}")
    print(f"  Sample population (latest year): {total_pop:,}")


def update_local_db(db_path, records, full_rebuild, year, month):
    """Insert records into local crime_data.db."""
    print(f"\nUpdating local DB: {db_path}")
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")

    if full_rebuild:
        conn.execute("DELETE FROM agency_monthly")
        print("  Cleared agency_monthly (full rebuild)")
    else:
        conn.execute(
            "DELETE FROM agency_monthly WHERE year=? AND month=?", (year, month)
        )
        print(f"  Removed existing {year}-{month:02d} rows")

    conn.executemany(
        "INSERT INTO agency_monthly (ori,agency,state,type,year,month,offense,count) VALUES (?,?,?,?,?,?,?,?)",
        records
    )
    print(f"  Inserted {len(records):,} rows into agency_monthly")

    # On full rebuild, recalculate sample_agencies from agencies with complete data
    if full_rebuild:
        total_months = conn.execute(
            "SELECT COUNT(DISTINCT year * 100 + month) FROM agency_monthly"
        ).fetchone()[0]
        print(f"\n  Rebuilding sample_agencies (agencies with all {total_months} months)...")
        conn.execute("DELETE FROM sample_agencies")
        conn.execute("""
            INSERT INTO sample_agencies (ori, agency, state, type)
            SELECT am.ori,
                   COALESCE(a.agency, am.ori) as agency,
                   COALESCE(a.state, am.state) as state,
                   COALESCE(a.type, '') as type
            FROM agency_monthly am
            LEFT JOIN agencies a ON a.ori = am.ori
            GROUP BY am.ori
            HAVING COUNT(DISTINCT am.year * 100 + am.month) = ?
        """, (total_months,))
        sample_count = conn.execute("SELECT COUNT(*) FROM sample_agencies").fetchone()[0]
        print(f"  sample_agencies rebuilt: {sample_count} agencies with {total_months} complete months")

    # Rebuild national_monthly
    if full_rebuild:
        conn.execute("DELETE FROM national_monthly")
    else:
        conn.execute("DELETE FROM national_monthly WHERE year=? AND month=?", (year, month))

    conn.execute("""
        INSERT INTO national_monthly (year, month, offense, count, agency_count)
        SELECT am.year, am.month, am.offense, SUM(am.count), COUNT(DISTINCT am.ori)
        FROM agency_monthly am
        JOIN sample_agencies sa ON sa.ori = am.ori
        """ + ("" if full_rebuild else f"WHERE am.year={year} AND am.month={month}") + """
        GROUP BY am.year, am.month, am.offense
    """)

    latest = conn.execute("SELECT MAX(year*100+month) FROM national_monthly").fetchone()[0]
    nm_rows = conn.execute("SELECT COUNT(*) FROM national_monthly").fetchone()[0]
    sa_count = conn.execute("SELECT COUNT(*) FROM sample_agencies").fetchone()[0]
    conn.commit()
    conn.close()
    print(f"  national_monthly: {nm_rows:,} rows, latest {latest // 100}-{latest % 100:02d}")
    print(f"  sample: {sa_count} agencies")


def ensure_crosswalk(db_path, source_path, cde_path):
    """Rebuild agency_county_crosswalk in the local DB and verify it.

    crime_data.db is wholesale-replaced on the VPS at deploy time, so any
    derived table must exist in the LOCAL file before scp or it regresses
    Current/Historical county support (see docs/query-audit-2026-06-09-proposals.md).
    Aborts (sys.exit) on failure so a bad DB is never deployed.
    """
    print("\nRebuilding agency_county_crosswalk (derived table)...")
    if not os.path.exists(source_path):
        print(f"  ERROR: crosswalk source not found: {source_path}")
        sys.exit(1)
    result = subprocess.run(
        [sys.executable, CROSSWALK_BUILDER,
         "--source", source_path, "--cde", cde_path,
         "--target", db_path, "--apply"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  ERROR: crosswalk build failed: {result.stderr.strip()[:500]}")
        sys.exit(1)

    import sqlite3
    db = sqlite3.connect(db_path)
    try:
        count = db.execute("SELECT COUNT(*) FROM agency_county_crosswalk").fetchone()[0]
        inipd = db.execute(
            "SELECT ori9, county_fips FROM agency_county_crosswalk WHERE ori = 'INIPD00'"
        ).fetchone()
        santa_clara = db.execute(
            "SELECT COUNT(*) FROM agency_county_crosswalk WHERE state='CA' AND county_key='SANTA CLARA'"
        ).fetchone()[0]
    finally:
        db.close()

    failures = []
    if count < 25000:
        failures.append(f"row count {count} < 25000 (expected ~25,764)")
    if not inipd or inipd[0] != "IN0494900" or inipd[1] != "18097":
        failures.append(f"INIPD00 mapping wrong: {inipd} (expected IN0494900 / 18097)")
    if santa_clara < 20:
        failures.append(f"Santa Clara CA agencies {santa_clara} < 20")
    if failures:
        print("  ERROR: crosswalk verification failed:")
        for f in failures:
            print(f"    - {f}")
        sys.exit(1)
    print(f"  Crosswalk OK: {count:,} rows; INIPD00 -> {inipd[0]}/{inipd[1]}; Santa Clara CA agencies: {santa_clara}")


def deploy_to_vps(db_path, year, month, full_rebuild):
    """SCP updated DB to the canonical shared path, then zero-downtime rebuild."""
    print(f"\nDeploying to VPS ({VPS_HOST})...")

    print("  Copying DB to VPS (shared path)...")
    result = subprocess.run(
        ["scp", db_path, f"{VPS_HOST}:{VPS_DB}"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  ERROR: scp failed: {result.stderr.strip()}")
        sys.exit(1)
    print("  DB copied.")

    print("  Zero-downtime rebuild (regenerates static pages; ~2-4 min)...")
    result = subprocess.run(
        ["ssh", VPS_HOST, f"cd {VPS_REPO} && bash scripts/deploy-zero-downtime.sh {DEPLOY_BRANCH}"],
        capture_output=False
    )
    if result.returncode != 0:
        print("  ERROR: zero-downtime deploy failed (live app untouched; see rollback.sh)")
        sys.exit(1)
    print("  Deploy complete.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--month", required=True, help="YYYYMM, e.g. 202603")
    parser.add_argument("--csv", help="Local CSV path instead of GitHub download")
    parser.add_argument("--full-rebuild", action="store_true",
                        help="Replace all agency_monthly data (not just new month)")
    parser.add_argument("--deploy", action="store_true",
                        help="SCP DB to VPS and rebuild app after update")
    parser.add_argument("--db", default=None, help="Local DB path (default: crime_data.db next to scripts/)")
    parser.add_argument("--pop-csv", default=POP_CSV_DEFAULT,
                        help="Path to populations.csv for agency population refresh")
    parser.add_argument("--crosswalk-source", default=CROSSWALK_SOURCE_DEFAULT,
                        help="Participation Crosswalk.xlsx for agency_county_crosswalk rebuild")
    parser.add_argument("--crosswalk-cde", default=CROSSWALK_CDE_DEFAULT,
                        help="CDE Participation CSV for agency_county_crosswalk rebuild")
    args = parser.parse_args()

    if not re.match(r"^\d{6}$", args.month):
        print("ERROR: --month must be YYYYMM, e.g. 202603")
        sys.exit(1)

    year = int(args.month[:4])
    month = int(args.month[4:])

    db_path = args.db or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "crime_data.db")
    )
    if not os.path.exists(db_path):
        print(f"ERROR: DB not found at {db_path}")
        sys.exit(1)

    # Load CSV
    if args.csv:
        all_rows = load_local_csv(args.csv)
    else:
        all_rows = download_csv(args.month)

    # Filter rows
    if args.full_rebuild:
        ori_rows = filter_ori_rows(all_rows)
        year_filter, month_filter = None, None
    else:
        ori_rows = filter_ori_rows(all_rows, year=year, month=month)
        year_filter, month_filter = year, month

    # Convert to records
    if args.full_rebuild:
        # Import ALL agencies first, then recalculate sample in update_local_db
        print("\nBuilding records (all agencies, sample will be recalculated)...")
        records = rows_to_records(ori_rows, sample_oris=None)
    else:
        # Incremental: filter by existing sample
        print("\nLoading sample_agencies from DB...")
        sample_oris = get_sample_oris(db_path)
        print(f"  {len(sample_oris)} agencies")
        print("\nBuilding records...")
        records = rows_to_records(ori_rows, sample_oris)

    # Update local DB
    update_local_db(db_path, records, args.full_rebuild, year, month)

    # Refresh agency populations from FBI data
    if args.full_rebuild:
        refresh_populations(db_path, args.pop_csv)

    # Rebuild + verify derived tables BEFORE any deploy — the scp wholesale-
    # replaces the VPS file, so missing derived tables would regress
    # Current/Historical county support.
    ensure_crosswalk(db_path, args.crosswalk_source, args.crosswalk_cde)

    # Deploy if requested
    if args.deploy:
        deploy_to_vps(db_path, year, month, args.full_rebuild)

    print("\nDone!")
    if not args.deploy:
        print(f"  Run with --deploy to push to VPS and rebuild.")


if __name__ == "__main__":
    main()
