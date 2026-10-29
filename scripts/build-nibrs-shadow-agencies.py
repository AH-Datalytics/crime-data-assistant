#!/usr/bin/env python3
"""Builds the shadow slice's place index: scripts/fixtures/nibrs-shadow/agencies.json.

    <python with duckdb> -I scripts/build-nibrs-shadow-agencies.py --root <canonical dir> --names <crime_data.db>

One row per city police agency (agency indicator 1) in the canonical build, with its population in the build's latest
year, at or above MIN_POPULATION. A city named in a question resolves through this index (lib/nibrs-shadow/places.ts).
It stands in for the app's resolveNibrsPlaces, which needs nibrs.db, until the canonical build ships the app's agency
tables. City names come from the canonical agency table; display casing comes from crime_data.db's Historical agency
names where an ORI has one. Read-only on both.
"""
import argparse
import json
import os
import sqlite3

import duckdb

MIN_POPULATION = 10_000
ap = argparse.ArgumentParser()
ap.add_argument("--root", required=True)
ap.add_argument("--names", required=True)
a = ap.parse_args()
OUT = os.path.join(os.path.dirname(__file__), "fixtures", "nibrs-shadow", "agencies.json")

rows = duckdb.connect().execute(f"""
  WITH y AS (SELECT ori, u.data_year, trim(u.city) AS city, u.state_abbr AS state, u.agency_indicator AS ind, u.population
             FROM read_parquet('{a.root}/agency/data.parquet'), unnest(by_year) AS t(u))
  SELECT ori, arg_max(city, data_year), arg_max(state, data_year), arg_max(population, data_year), max(data_year)
  FROM y WHERE ind = '1' GROUP BY ori
  HAVING arg_max(population, data_year) >= {MIN_POPULATION} ORDER BY 3, 2, 4 DESC""").fetchall()
names = sqlite3.connect(f"file:{a.names}?mode=ro", uri=True)
display = {o: n for o, n in names.execute("SELECT ori, agency FROM historical_agency WHERE type = 'city'")}
out = [{"ori": o, "city": display.get(o) or c.title(), "state": s, "population": p, "year": y} for o, c, s, p, y in rows]
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    # One agency per line, so a rebuild diffs by agency.
    f.write('{"_comment": "City police agencies in canonical release 20261028-test5 with 10,000+ residents (scripts/build-nibrs-shadow-agencies.py).",\n')
    f.write(' "release": "20261028-test5",\n "agencies": [\n')
    f.write(",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in out))
    f.write("\n ]\n}\n")
print(len(out), "agencies")
