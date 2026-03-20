"""
Build agency_reporting_gaps table from summary_city_monthly.
Detects agencies (pop >= 50K) with incomplete reporting:
- Missing months (reported < expected)
- Suspicious year-over-year drops
- Ramp-up periods (transitioning to NIBRS)

Usage:
  python build_reporting_gaps.py [--db /path/to/nibrs.db] [--min-pop 50000]
"""

import sqlite3
import argparse
import datetime


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/opt/nibrs/nibrs.db")
    parser.add_argument("--min-pop", type=int, default=50000)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS agency_reporting_gaps (
            ori TEXT NOT NULL,
            year INTEGER NOT NULL,
            city TEXT,
            state TEXT,
            population INTEGER,
            months_reported INTEGER,
            expected_months INTEGER,
            total_offenses INTEGER,
            prior_year_offenses INTEGER,
            yoy_ratio REAL,
            gap_type TEXT,
            severity TEXT,
            PRIMARY KEY (ori, year)
        )
    """)
    conn.execute("DELETE FROM agency_reporting_gaps")
    conn.commit()

    current_year = datetime.datetime.now().year
    current_month = datetime.datetime.now().month

    # Get agencies with pop >= threshold
    agencies = conn.execute("""
        SELECT DISTINCT a.ori, a.city, a.state, MAX(a.population) as pop
        FROM agencies a
        WHERE a.population >= ?
        GROUP BY a.ori
        ORDER BY pop DESC
    """, (args.min_pop,)).fetchall()
    print(f"Checking {len(agencies)} agencies (pop >= {args.min_pop:,})")

    # Build a lookup of monthly reporting from summary table
    # This is one big query instead of per-agency
    print("Loading summary data...")
    ori_set = {a[0] for a in agencies}

    rows = conn.execute("""
        SELECT ori, year, COUNT(DISTINCT month) as months_reported, SUM(offense_count) as total_offenses
        FROM summary_city_monthly
        GROUP BY ori, year
    """).fetchall()

    # Build nested dict: {ori: {year: {months, offenses}}}
    data = {}
    for ori, year, months, offenses in rows:
        if ori not in ori_set:
            continue
        if ori not in data:
            data[ori] = {}
        data[ori][year] = {"months": months, "offenses": offenses}

    print(f"Loaded data for {len(data)} agencies")

    insert_count = 0
    batch = []

    for ori, city, state, pop in agencies:
        if ori not in data:
            continue

        year_data = data[ori]
        years = sorted(year_data.keys())

        for yr in years:
            d = year_data[yr]
            months = d["months"]
            offenses = d["offenses"]

            # Expected months
            if yr == current_year:
                expected = max(current_month - 1, 1)
            else:
                expected = 12

            # Prior year data
            prior = year_data.get(yr - 1)
            prior_offenses = prior["offenses"] if prior else None
            prior_months = prior["months"] if prior else None

            # YoY ratio (monthly average comparison)
            yoy_ratio = None
            if prior_offenses and prior_months and prior_months >= 6 and months >= 1:
                avg_current = offenses / months
                avg_prior = prior_offenses / prior_months
                if avg_prior > 0:
                    yoy_ratio = round(avg_current / avg_prior, 2)

            # Determine gap type and severity
            gap_type = None
            severity = None

            missing_months = months < expected
            yoy_drop = yoy_ratio is not None and yoy_ratio < 0.5

            # Check if this is a ramp-up year (first few years of NIBRS reporting)
            first_year = years[0] if years else yr
            is_ramp_up = (yr - first_year) <= 1 and yr > 1991

            if missing_months and yoy_drop:
                gap_type = "both"
                severity = "partial" if months < expected * 0.75 else "minor"
            elif missing_months:
                if months < expected * 0.75:
                    gap_type = "missing_months"
                    severity = "partial"
                elif months < expected * 0.92:
                    gap_type = "missing_months"
                    severity = "minor"
            elif yoy_drop:
                gap_type = "yoy_drop"
                severity = "yoy_only"

            if is_ramp_up and gap_type:
                gap_type = "ramp_up"
                severity = "transition"
            elif is_ramp_up and months < 10:
                gap_type = "ramp_up"
                severity = "transition"

            if gap_type:
                batch.append((ori, yr, city, state, pop, months, expected,
                              offenses, prior_offenses, yoy_ratio, gap_type, severity))
                insert_count += 1

    # Bulk insert
    print(f"Inserting {insert_count} gap records...")
    conn.executemany("""
        INSERT OR REPLACE INTO agency_reporting_gaps
        (ori, year, city, state, population, months_reported, expected_months,
         total_offenses, prior_year_offenses, yoy_ratio, gap_type, severity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, batch)
    conn.commit()

    # Summary
    by_type = conn.execute(
        "SELECT gap_type, severity, COUNT(*) FROM agency_reporting_gaps GROUP BY gap_type, severity ORDER BY gap_type, severity"
    ).fetchall()

    print(f"\nDone. {insert_count} gaps detected:")
    for gap_type, severity, cnt in by_type:
        print(f"  {gap_type}/{severity}: {cnt}")

    conn.close()


if __name__ == "__main__":
    main()
