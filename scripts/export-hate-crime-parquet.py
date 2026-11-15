#!/usr/bin/env python3
"""Exports the hate crime incidents of a hate_crime.db to a parquet build the new engine reads (read-only on the db).

    python scripts/export-hate-crime-parquet.py --db <hate_crime.db> --out <new empty folder> [--audit-only]

What it does, in this order, and nothing else:
  1. opens the database read-only (SQLite URI mode=ro) and records its size, sha256 and row counts;
  2. decodes every row's bias from its stored bias_code and data year with the shared FBI decoder
     (scripts/hate_crime_bias.py); the stored bias_desc and bias_category are never trusted. It prints one line per
     (bias_code, year range) with the count, the decoder's name and group, and how many rows' stored label differs from it
     (the audit); a code the FBI list does not have is kept as itself, group "Other", listed false;
  3. unless --audit-only, writes <out>/hate_crime_incident/data.parquet (one row per incident-offense, as in the db, with
     bias_label / bias_group / bias_listed added and incident_date as a DATE) and <out>/release.json (source db sha256,
     row counts, first and latest incident date, the decoder's reference file sha256).
Writes only under --out, which must not exist or must be empty; never writes the database. Needs python 3 and the duckdb
module (the runner has it). Never run on the web server.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hate_crime_bias import decode, REFERENCE_PATH  # noqa: E402

COLS = ["year", "state", "state_name", "ori", "agency_name", "population", "pop_group", "incident_number", "incident_date",
        "data_source", "quarter", "total_individual_victims", "total_offenders", "offender_race", "offender_ethnicity",
        "offense_group", "offense_code", "offense_name", "offense_victims", "location", "location_code", "bias_code",
        "victim_types", "adult_victims", "juvenile_victims", "adult_offenders", "juvenile_offenders"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--audit-only", action="store_true")
    a = ap.parse_args()
    if not a.audit_only and os.path.exists(a.out) and os.listdir(a.out):
        sys.exit(f"{a.out} exists and is not empty: give a new folder")
    con = sqlite3.connect(f"file:{os.path.abspath(a.db).replace(os.sep, '/')}?mode=ro", uri=True)
    sel = ", ".join(COLS + ["bias_desc", "bias_category"])
    rows = con.execute(f"SELECT {sel} FROM hate_crime_incidents").fetchall()
    n = len(rows)
    ib, iy, idate = COLS.index("bias_code"), COLS.index("year"), COLS.index("incident_date")
    audit = collections.OrderedDict()
    out = []
    for r in rows:
        code = (r[ib] or "").strip()
        label, group, unresolved, listed = decode(code, r[iy])
        key = (code, label, group, listed)
        s = audit.setdefault(key, {"n": 0, "min": r[iy], "max": r[iy], "differs": 0})
        s["n"] += 1
        s["min"], s["max"] = min(s["min"], r[iy]), max(s["max"], r[iy])
        if (r[-2] or "") != label or (r[-1] or "") != group:
            s["differs"] += 1
        d = r[idate]
        try:
            d = datetime.date.fromisoformat(d) if d else None
        except ValueError:
            d = None
        out.append(tuple(r[: len(COLS)]) [: idate] + (d,) + tuple(r[: len(COLS)])[idate + 1:] + (label, group, bool(listed)))
    print(f"rows {n}")
    print("bias_code | years | rows | decoder name | decoder group | listed | rows whose stored label differs")
    total_diff = 0
    for (code, label, group, listed), s in sorted(audit.items()):
        total_diff += s["differs"]
        print(f"{code or '(blank)'} | {s['min']}-{s['max']} | {s['n']} | {label} | {group} | {listed} | {s['differs']}")
    print(f"rows whose stored bias_desc/bias_category differ from the decoder: {total_diff}")
    if a.audit_only:
        return
    import duckdb  # noqa: E402
    os.makedirs(os.path.join(a.out, "hate_crime_incident"), exist_ok=True)
    db = duckdb.connect()
    cols = COLS + ["bias_label", "bias_group", "bias_listed"]
    types = {"year": "INTEGER", "population": "INTEGER", "total_individual_victims": "INTEGER", "total_offenders": "INTEGER",
             "offense_group": "INTEGER", "offense_victims": "INTEGER", "adult_victims": "INTEGER", "juvenile_victims": "INTEGER",
             "adult_offenders": "INTEGER", "juvenile_offenders": "INTEGER", "incident_date": "DATE", "bias_listed": "BOOLEAN"}
    db.execute("CREATE TABLE t (" + ", ".join(f"{c} {types.get(c, 'VARCHAR')}" for c in cols) + ")")
    db.executemany("INSERT INTO t VALUES (" + ", ".join("?" * len(cols)) + ")", out)
    target = os.path.join(a.out, "hate_crime_incident", "data.parquet").replace("\\", "/")
    db.execute(f"COPY (SELECT * FROM t ORDER BY year, state, ori, incident_number, offense_group) TO '{target}' (FORMAT PARQUET)")
    back = db.execute(f"SELECT count(*), min(incident_date), max(incident_date) FROM read_parquet('{target}')").fetchone()
    if back[0] != n:
        sys.exit(f"the parquet holds {back[0]} rows, the database {n}: stopped")
    release = {"source_db": os.path.basename(a.db), "source_sha256": sha256(a.db), "rows": n, "first_incident_date": str(back[1]),
               "latest_incident_date": str(back[2]), "rows_whose_stored_label_differs": total_diff,
               "decoder_reference_sha256": sha256(REFERENCE_PATH), "exported": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    with open(os.path.join(a.out, "release.json"), "w", encoding="utf-8") as f:
        json.dump(release, f, indent=1)
    print("wrote", target, "and release.json", json.dumps(release))


if __name__ == "__main__":
    main()
