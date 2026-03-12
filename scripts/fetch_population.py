"""
Extract agency population data from Jacob Kaplan's Offenses Known dataset (2017-2024).
For 2025-2026, use CDE API. Use previous year's population for missing years.

Usage:
    python scripts/fetch_population.py

Reads: ../Downloads/offenses_known_csv_1960_2024_year.zip
Updates: crime_data.db (adds agency_population table)
Outputs: missing_population.csv (agencies with gaps)
"""

import zipfile
import csv
import io
import sqlite3
import os
import json
import time
import urllib.request

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "crime_data.db")
KAPLAN_ZIP = os.path.join(os.path.expanduser("~"), "Downloads", "offenses_known_csv_1960_2024_year.zip")

# Manual ORI mappings for agencies whose ORI doesn't match Kaplan's ori9
# Format: our_ori -> (kaplan_agency_name_lower, kaplan_state_abb)
MANUAL_MATCHES = {
    "CA030350X": ("mission viejo", "CA"),
    "CA030390X": ("laguna niguel", "CA"),
    "CA030490X": ("aliso viejo", "CA"),
    "GA0447200": ("brookhaven", "GA"),
    "MI631900X": ("pontiac", "MI"),
    "MI631910X": ("rochester hills", "MI"),
    "MO0922400": ("st charles", "MO"),
    "OH0314400": ("green township", "OH"),
}

# State abbreviation to FIPS code for CDE API
STATE_FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08",
    "CT": "09", "DE": "10", "FL": "12", "GA": "13", "HI": "15", "ID": "16",
    "IL": "17", "IN": "18", "IA": "19", "KS": "20", "KY": "21", "LA": "22",
    "ME": "23", "MD": "24", "MA": "25", "MI": "26", "MN": "27", "MS": "28",
    "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33", "NJ": "34",
    "NM": "35", "NY": "36", "NC": "37", "ND": "38", "OH": "39", "OK": "40",
    "OR": "41", "PA": "42", "RI": "44", "SC": "45", "SD": "46", "TN": "47",
    "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53", "WV": "54",
    "WI": "55", "WY": "56", "DC": "11",
}


def fetch_cde_population(ori, state_abb):
    """Fetch population from CDE API for 2025-2026."""
    fips = STATE_FIPS.get(state_abb)
    if not fips:
        return {}
    url = f"https://cde.ucr.cjis.gov/LATEST/nibrs/agency/{ori}/{fips}F?from=01-2025&to=12-2026&type=counts"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        pops = data.get("populations", {}).get("population", {})
        # Find the agency key (not the state or US key)
        agency_key = None
        for k in pops:
            if k not in ("United States",) and k != state_abb and not k.startswith("United"):
                # Check it's not a state name
                if len(k) > 2:
                    agency_key = k
                    break
        if not agency_key:
            return {}
        monthly = pops[agency_key]
        # Extract unique year populations (same within year)
        year_pops = {}
        for month_key, pop in monthly.items():
            if pop is None:
                continue
            parts = month_key.split("-")
            yr = int(parts[1])
            if yr >= 2025 and pop > 0:
                year_pops[yr] = pop
        return year_pops
    except Exception as e:
        print(f"    CDE error for {ori}: {e}")
        return {}


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    # Get our agencies
    agencies = {
        row[0]: {"agency": row[1], "state": row[2], "type": row[3]}
        for row in cur.execute("SELECT ori, agency, state, type FROM agencies").fetchall()
    }
    print(f"Our agencies: {len(agencies)}")

    # --- Phase 1: Extract from Kaplan (2017-2024) ---
    print(f"\nReading Kaplan dataset...")
    z = zipfile.ZipFile(KAPLAN_ZIP)

    # Build name-based lookup for manual matches
    # (name_lower, state) -> {year: population}
    name_pops = {}

    pop_data = {}  # (ori, year) -> population

    with z.open("offenses_known_yearly_1960_2024.csv") as f:
        reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
        for row in reader:
            yr_str = row["year"]
            if yr_str == "NA":
                continue
            yr = int(yr_str)
            if yr < 2017 or yr > 2024:
                continue

            ori9 = row["ori9"].strip()
            name = row["agency_name"].strip().lower()
            state = row["state_abb"].strip()
            pop_str = row["population"].strip()

            if pop_str == "NA" or pop_str == "" or pop_str == "0":
                pop = 0
            else:
                pop = int(pop_str)

            # Direct ORI match
            if ori9 in agencies and pop > 0:
                pop_data[(ori9, yr)] = pop

            # Store for name-based matching
            key = (name, state)
            if key not in name_pops:
                name_pops[key] = {}
            if pop > 0:
                name_pops[key][yr] = pop

    # Apply manual matches
    for our_ori, (kaplan_name, kaplan_state) in MANUAL_MATCHES.items():
        key = (kaplan_name, kaplan_state)
        if key in name_pops:
            for yr, pop in name_pops[key].items():
                if (our_ori, yr) not in pop_data:
                    pop_data[(our_ori, yr)] = pop
                    print(f"  Manual match: {our_ori} ({agencies[our_ori]['agency']}) {yr} -> {pop:,}")

    matched = set(ori for ori, yr in pop_data)
    print(f"Matched from Kaplan: {len(matched)} of {len(agencies)}")

    # --- Phase 2: Fetch 2025-2026 from CDE API ---
    print(f"\nFetching 2025-2026 from CDE API...")
    cde_count = 0
    for i, (ori, info) in enumerate(agencies.items()):
        if i % 50 == 0 and i > 0:
            print(f"  Progress: {i}/{len(agencies)}...")
        cde_pops = fetch_cde_population(ori, info["state"])
        for yr, pop in cde_pops.items():
            pop_data[(ori, yr)] = pop
            cde_count += 1
        if cde_pops:
            time.sleep(0.1)  # Be polite to the API
        else:
            time.sleep(0.05)

    print(f"  Added {cde_count} records from CDE")

    # --- Phase 3: Fill gaps with previous year's population ---
    print(f"\nFilling gaps with previous year's population...")
    fill_count = 0
    for ori in agencies:
        for yr in range(2017, 2027):
            if (ori, yr) not in pop_data:
                # Try previous year
                for prev_yr in range(yr - 1, 2015, -1):
                    if (ori, prev_yr) in pop_data:
                        pop_data[(ori, yr)] = pop_data[(ori, prev_yr)]
                        fill_count += 1
                        break
    print(f"  Filled {fill_count} gaps")

    # --- Phase 4: Create agency_population table ---
    cur.execute("DROP TABLE IF EXISTS agency_population")
    cur.execute("""
        CREATE TABLE agency_population (
            ori TEXT NOT NULL,
            year INTEGER NOT NULL,
            population INTEGER NOT NULL,
            PRIMARY KEY (ori, year)
        )
    """)
    cur.execute("CREATE INDEX idx_ap_year ON agency_population(year)")

    batch = []
    for (ori, yr), pop in sorted(pop_data.items()):
        if yr >= 2017 and yr <= 2026 and pop > 0:
            batch.append((ori, yr, pop))

    cur.executemany("INSERT OR REPLACE INTO agency_population VALUES (?,?,?)", batch)
    total = cur.execute("SELECT COUNT(*) FROM agency_population").fetchone()[0]
    print(f"\nagency_population: {total:,} rows")

    # --- Phase 5: Generate missing coverage CSV ---
    missing_rows = []
    for ori, info in agencies.items():
        for yr in range(2017, 2026):  # 2017-2025
            if (ori, yr) not in pop_data or pop_data.get((ori, yr), 0) == 0:
                missing_rows.append({
                    "ori": ori,
                    "agency": info["agency"],
                    "state": info["state"],
                    "type": info["type"],
                    "year": yr,
                })

    csv_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "missing_population.csv")
    if missing_rows:
        with open(csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["ori", "agency", "state", "type", "year"])
            writer.writeheader()
            writer.writerows(missing_rows)
        print(f"\n{len(missing_rows)} missing agency-year combos written to {csv_path}")
    else:
        print(f"\nNo missing population data!")

    # Summary
    print(f"\nCoverage by year:")
    for yr in range(2017, 2027):
        count = sum(1 for (o, y) in pop_data if y == yr and pop_data[(o, y)] > 0)
        print(f"  {yr}: {count}/{len(agencies)} agencies")

    conn.commit()
    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
