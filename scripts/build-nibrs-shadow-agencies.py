#!/usr/bin/env python3
"""Builds the shadow slice's place index: scripts/fixtures/nibrs-shadow/agencies.json.

    <python with duckdb> -I scripts/build-nibrs-shadow-agencies.py --root <canonical dir> --names <crime_data.db> --release <release id>
        [--crosswalk <crosswalk release dir> --crimeindex <Crime Index build dir>]

One row per city police agency (agency indicator 1) and per county agency (crime_data.db's Historical agency type
"county", named "<X> County") in the canonical build, with its population in the build's latest year, at or above
MIN_POPULATION. A place named in a question resolves through this index (lib/nibrs-shadow/places.ts). It stands in for
the app's resolveNibrsPlaces, which needs nibrs.db, until the canonical build ships the app's agency tables. City names
come from the canonical agency table, display casing and county names from crime_data.db's Historical agency names.
Read-only on both.
"""
import argparse
import json
import os
import re
import sqlite3

import duckdb

MIN_POPULATION = 10_000
CURRENT_YEAR = 2015  # a Crime Index agency with no figures since then is not a current place
ap = argparse.ArgumentParser()
ap.add_argument("--root", required=True)
ap.add_argument("--names", required=True)
ap.add_argument("--release", required=True)  # the canonical release id, recorded in the file
ap.add_argument("--crosswalk")   # nibrs-model's agency crosswalk release dir (aliases, place names)
ap.add_argument("--crimeindex")  # the Crime Index build dir (agencies NIBRS does not have)
a = ap.parse_args()
OUT = os.path.join(os.path.dirname(__file__), "fixtures", "nibrs-shadow", "agencies.json")

rows = duckdb.connect().execute(f"""
  WITH y AS (SELECT ori, u.data_year, trim(u.city) AS city, u.state_abbr AS state, u.agency_indicator AS ind, u.population
             FROM read_parquet('{a.root}/agency/data.parquet'), unnest(by_year) AS t(u))
  SELECT ori, arg_max(city, data_year), arg_max(state, data_year), arg_max(ind, data_year), arg_max(population, data_year), max(data_year)
  FROM y GROUP BY ori
  HAVING arg_max(population, data_year) >= {MIN_POPULATION} ORDER BY 3, 2, 5 DESC""").fetchall()
names = sqlite3.connect(f"file:{a.names}?mode=ro", uri=True)
hist = {o: (n, t) for o, n, t in names.execute("SELECT ori, agency, type FROM historical_agency WHERE type IN ('city', 'county')")}
out = []
for o, c, s, ind, p, y in rows:
    name, kind = hist.get(o, (None, None))
    if ind == "1":
        out.append({"ori": o, "kind": "city", "name": name if kind == "city" and name else c.title(), "state": s, "population": p, "year": y})
    elif kind == "county" and name and name.endswith(" County"):
        out.append({"ori": o, "kind": "county", "name": name, "state": s, "population": p, "year": y})

# The shared place index (coordinator 2026-11-02): NIBRS's agencies and the Crime Index's, one reader for every source.
# The crosswalk (nibrs-model's agency crosswalk, --crosswalk) gives each ORI's place names (its "city" and "county"
# aliases: "new york city" for New York's police); the Crime Index build (--crimeindex) gives the agencies NIBRS doesn't
# have (Jefferson Parish, small towns), with their latest population there. Read-only on both.
if a.crosswalk:
    cw = duckdb.connect()
    alias_rows = cw.execute(f"""
      SELECT i.code, a.alias, a.kind FROM read_parquet('{a.crosswalk}/identifier.parquet') i
      JOIN read_parquet('{a.crosswalk}/alias.parquet') a USING (agency_key)
      WHERE i.scheme = 'ORI9' AND a.kind IN ('city', 'county') GROUP BY ALL""").fetchall()
    aliases = {}
    for code, al, k in alias_rows:
        aliases.setdefault(code, set()).add((al, k))
    have = {r["ori"] for r in out}
    def norm(s):
        return " ".join(s.lower().replace(".", " ").split())
    for r in out:
        own = norm(r["name"])
        r["aliases"] = sorted({al for al, k in aliases.get(r["ori"], ()) if norm(al) != own and norm(al) + " county" != own})
        r["sources"] = ["nibrs"]
    if a.crimeindex:
        ci = cw.execute(f"""
          SELECT ori, arg_max(name, year), arg_max(type, year), arg_max(state, year), arg_max(population, year) FILTER (WHERE population > 0 AND has),
                 max(year) FILTER (WHERE population > 0 AND has)
          FROM (SELECT *, violent_total IS NOT NULL OR property_total IS NOT NULL AS has FROM read_parquet('{a.crimeindex}/agency_crime.parquet'))
          GROUP BY ori""").fetchall()  # the population of the latest year with figures (later rows carry it with none)
        ci_oris = {o for o, *_ in ci}
        for r in out:
            if r["ori"] in ci_oris:
                r["sources"].append("crime_index")
        added = 0
        for o, n, t, s, p, y in ci:
            # An agency with no figures since CURRENT_YEAR is gone or merged (Eau Gallie; Louisville before its
            # 2003 merger), so its name would shadow the place's current agency.
            if o in have or t not in ("city", "county") or p is None or p < MIN_POPULATION or y < CURRENT_YEAR:
                continue
            # The Crime Index's own name is the place's ("New York City", "Jefferson Parish"); the crosswalk's are aliases.
            name = n
            if t == "county" and not name.endswith((" County", " Parish", " Borough")):
                name = f"{name} County"
            own = norm(name)
            out.append({"ori": o, "kind": t, "name": name, "state": s, "population": int(p), "year": int(y),
                        "aliases": sorted({al for al, k in aliases.get(o, ()) if norm(al) != own and norm(al) + " county" != own}), "sources": ["crime_index"]})
            added += 1
        print(added, "Crime Index agencies added")
    # An agency's own name wins over another's alias: "flint" is Flint, not Flint Township's mailing city; "perris" is
    # Perris, not the county agency serving Menifee. Names are compared as places.ts compares them (base()).
    def base(s):
        k = " ".join(re.sub(r"[^a-z0-9 ]+", " ", s.lower()).replace("saint", "st").split())
        return re.sub(r" (county|parish|borough)$", "", k)
    owned = {(base(r["name"]), r["state"]) for r in out}
    dropped = 0
    for r in out:
        keep = [al for al in r["aliases"] if (base(al), r["state"]) not in owned]
        dropped += len(r["aliases"]) - len(keep)
        r["aliases"] = keep
    print(dropped, "aliases dropped (another agency's own name in the state)")
    out.sort(key=lambda r: (r["state"], r["name"], -r["population"]))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    # One agency per line, so a rebuild diffs by agency.
    f.write('{"_comment": "City police and county agencies in canonical release ' + a.release + ' with 10,000+ residents (scripts/build-nibrs-shadow-agencies.py).",\n')
    f.write(' "release": "' + a.release + '",\n "agencies": [\n')
    f.write(",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in out))
    f.write("\n ]\n}\n")
print(len(out), "agencies:", sum(r["kind"] == "city" for r in out), "city,", sum(r["kind"] == "county" for r in out), "county")
