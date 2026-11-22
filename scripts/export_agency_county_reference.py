"""Export data/reference/agency_county.csv from crime_data.db (read-only).

One row per law-enforcement agency of a county: a Historical agency of type "county" that the
agency_county_crosswalk maps to a county by FIPS code. The engine resolves a county question
(state + county_key) to these rows and never matches an agency by name. County agency only:
there is no countywide rollup here (P25/P70).

first_year and last_year are the first and last year the agency has a violent-crime figure in
historical_agency_crime. A county can hold two county agencies where one stopped reporting long ago
(Baltimore County MD: MD0030000 last 2000, MD0030100 current); the engine uses last_year to tell them apart.

Usage: python scripts/export_agency_county_reference.py <crime_data.db> [output.csv]
"""
import csv
import sqlite3
import sys
from pathlib import Path

HEADER = ["state", "county_fips", "county_key", "county_name", "ori9", "agency_name",
          "crosswalk_agency_name", "first_year", "last_year", "source"]

SQL = """
SELECT w.state, w.county_fips, w.county_key, w.county_name, w.ori9, h.agency, w.agency_name,
       (SELECT min(c.year) FROM historical_agency_crime c WHERE c.ori = w.ori9 AND c.violent IS NOT NULL),
       (SELECT max(c.year) FROM historical_agency_crime c WHERE c.ori = w.ori9 AND c.violent IS NOT NULL),
       w.source
FROM agency_county_crosswalk w
JOIN historical_agency h ON h.ori = w.ori9
WHERE lower(h.type) = 'county' AND w.county_key IS NOT NULL AND w.county_fips IS NOT NULL
ORDER BY w.state, w.county_key, w.ori9
"""


def export(db_path, out_path):
    con = sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True)
    rows = con.execute(SQL).fetchall()
    seen = set()
    for r in rows:
        k = (r[0], r[2], r[4])
        if k in seen:
            raise SystemExit(f"duplicate (state, county_key, ori9): {k}")
        seen.add(k)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(HEADER)
        for r in rows:
            w.writerow(["" if v is None else v for v in r])
    return len(rows)


if __name__ == "__main__":
    default = Path(__file__).resolve().parent.parent / "data" / "reference" / "agency_county.csv"
    out = sys.argv[2] if len(sys.argv) > 2 else str(default)
    print(f"{export(sys.argv[1], out)} rows -> {out}")
