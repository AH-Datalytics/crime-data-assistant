"""
Update crime_data.db from the latest RTCI monthly CSV.

Usage:
  python scripts/update-rtci.py                          # auto-detect latest CSV
  python scripts/update-rtci.py "path/to/February 2026 Final.csv"  # explicit path

CSV location pattern:
  C:\OneDrive\OneDrive - ahdatalytics.com\Clients\Real Time Crime Index\
  Open Source Data\_Ben and Jeff work\Months\{YYYY}\{Month YYYY} Final.csv

Rebuilds: agency_monthly, agencies, state_monthly, national_monthly
Then copies to VPS: scp crime_data.db root@178.156.243.51:/opt/nibrs/crime_data.db
"""
import csv
import os
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

MONTHS_DIR = Path(r"C:/OneDrive/OneDrive - ahdatalytics.com/Clients/Real Time Crime Index/Open Source Data/_Ben and Jeff work/Months")
DB_PATH = Path(__file__).resolve().parent.parent / "crime_data.db"
VPS_DEST = "root@178.156.243.51:/opt/nibrs/crime_data.db"

OFFENSE_COLS = [
    ("Murder", "Murder"),
    ("Rape", "Rape"),
    ("Robbery", "Robbery"),
    ("Aggravated Assault", "Aggravated Assault"),
    ("Burglary", "Burglary"),
    ("Theft", "Theft"),
    ("Motor Vehicle Theft", "Motor Vehicle Theft"),
]


def find_latest_csv():
    """Find the most recent '*Final.csv' in the Months directory."""
    candidates = []
    for yeardir in MONTHS_DIR.iterdir():
        if not yeardir.is_dir():
            continue
        for f in yeardir.glob("*Final.csv"):
            candidates.append(f)
    if not candidates:
        print("ERROR: No '*Final.csv' files found in", MONTHS_DIR)
        sys.exit(1)
    # Sort by modified time, newest first
    candidates.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    return candidates[0]


def load_csv(csv_path):
    """Read wide CSV, unpivot to long format rows."""
    rows = []
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for r in reader:
            ori = r.get("ori", "").strip()
            agency = r.get("Agency Name", "").strip()
            state = r.get("State", "").strip()
            atype = r.get("Type", "").strip()
            try:
                year = int(r.get("Year", 0))
                month = int(r.get("Month", 0))
            except (ValueError, TypeError):
                continue
            if not ori or not year or not month:
                continue
            for csv_col, offense_name in OFFENSE_COLS:
                val = r.get(csv_col, "").strip()
                if val == "":
                    continue
                try:
                    count = int(float(val))
                except (ValueError, TypeError):
                    continue
                rows.append((ori, agency, state, atype, year, month, offense_name, count))
    return rows


def update_db(rows):
    """Replace agency_monthly and rebuild aggregate tables."""
    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()

    print(f"  Clearing agency_monthly...")
    cur.execute("DELETE FROM agency_monthly")

    print(f"  Inserting {len(rows):,} rows into agency_monthly...")
    cur.executemany(
        "INSERT INTO agency_monthly (ori, agency, state, type, year, month, offense, count) VALUES (?,?,?,?,?,?,?,?)",
        rows,
    )

    # Compute the total month span in the data
    span = cur.execute("""
        SELECT COUNT(DISTINCT year * 100 + month) FROM agency_monthly
    """).fetchone()[0]
    print(f"  Total month span: {span} months")

    # Rebuild agencies table — national_sample = 1 only if agency has all months
    print("  Rebuilding agencies...")
    cur.execute("DELETE FROM agencies")
    cur.execute("""
        INSERT INTO agencies (ori, agency, state, type, total_months, national_sample)
        SELECT ori, agency, state, type,
               COUNT(DISTINCT year * 100 + month) as total_months,
               CASE WHEN COUNT(DISTINCT year * 100 + month) >= ? THEN 1 ELSE 0 END as national_sample
        FROM agency_monthly
        GROUP BY ori
    """, (span,))

    # Rebuild national_monthly — only agencies in the national sample
    sample_count = cur.execute("SELECT COUNT(*) FROM agencies WHERE national_sample = 1").fetchone()[0]
    print(f"  National sample: {sample_count} agencies (all {span} months)")
    print("  Rebuilding national_monthly...")
    cur.execute("DELETE FROM national_monthly")
    cur.execute("""
        INSERT INTO national_monthly (year, month, offense, count, agency_count)
        SELECT am.year, am.month, am.offense, SUM(am.count), COUNT(DISTINCT am.ori)
        FROM agency_monthly am
        JOIN agencies a ON a.ori = am.ori AND a.national_sample = 1
        GROUP BY am.year, am.month, am.offense
    """)

    # Rebuild state_monthly
    print("  Rebuilding state_monthly...")
    cur.execute("DELETE FROM state_monthly")
    cur.execute("""
        INSERT INTO state_monthly (state, year, month, offense, count, agency_count)
        SELECT state, year, month, offense, SUM(count), COUNT(DISTINCT ori)
        FROM agency_monthly
        GROUP BY state, year, month, offense
    """)

    conn.commit()

    # Stats
    agency_count = cur.execute("SELECT COUNT(*) FROM agencies").fetchone()[0]
    max_period = cur.execute("SELECT MAX(year || '-' || printf('%02d', month)) FROM agency_monthly").fetchone()[0]
    min_period = cur.execute("SELECT MIN(year || '-' || printf('%02d', month)) FROM agency_monthly").fetchone()[0]
    print(f"  Done: {agency_count} agencies, {min_period} to {max_period}")

    conn.close()


def deploy_to_vps():
    """Copy updated DB to VPS and restart app."""
    print(f"\n  Copying to VPS...")
    result = subprocess.run(["scp", str(DB_PATH), VPS_DEST], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  WARNING: scp failed: {result.stderr}")
        return False
    print(f"  Restarting app...")
    result = subprocess.run(
        ["ssh", "root@178.156.243.51", "pm2 restart nibrs"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"  WARNING: restart failed: {result.stderr}")
        return False
    print(f"  Deployed successfully.")
    return True


def main():
    if len(sys.argv) > 1:
        csv_path = Path(sys.argv[1])
    else:
        csv_path = find_latest_csv()

    print(f"RTCI Update: {csv_path.name}")
    print(f"  DB: {DB_PATH}")

    if not csv_path.exists():
        print(f"ERROR: CSV not found: {csv_path}")
        sys.exit(1)

    rows = load_csv(csv_path)
    print(f"  Parsed {len(rows):,} records from CSV")

    if not rows:
        print("ERROR: No data parsed from CSV")
        sys.exit(1)

    update_db(rows)

    if "--auto" in sys.argv:
        deploy_to_vps()
    else:
        resp = input("\nDeploy to VPS? [y/N] ").strip().lower()
        if resp == "y":
            deploy_to_vps()
        else:
            print("  Skipped VPS deploy. Run manually:")
            print(f"    scp {DB_PATH} {VPS_DEST}")
            print(f"    ssh root@178.156.243.51 'pm2 restart nibrs'")


if __name__ == "__main__":
    main()
