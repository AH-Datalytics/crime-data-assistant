#!/usr/bin/env python3
"""Builds the agencies' FBI names: scripts/fixtures/nibrs-shadow/agency-names.json.

    <python with duckdb> -I scripts/build-nibrs-agency-names.py --root <canonical dir> --directory <directory json>

The names are the FBI Crime Data Explorer agency directory's (agency/byStateAbbr), as archived by nibrs-model
(work/reference/sha256/<sha256>.json, retrieved 2026-10-29), checked against its SHA-256. One name per ORI of the
canonical build that the directory lists; an ORI it does not list has no entry (the engine then falls back to the
build's city, as nibrs-model's expected values do). Never built from a city and an agency type (Jeff 2026-10-30): the
build's city is a mailing city (OH0311100 says CINCINNATI and is the Fairfax Police Department). Read-only on both.
"""
import argparse
import hashlib
import json
import os

import duckdb

SHA256 = "0cf262da1c910d8e0ee17982d1099a2caedf8ce637f10a1c5de9de55ad88950d"
ap = argparse.ArgumentParser()
ap.add_argument("--root", required=True)
ap.add_argument("--directory", required=True)
a = ap.parse_args()
OUT = os.path.join(os.path.dirname(__file__), "fixtures", "nibrs-shadow", "agency-names.json")

data = open(a.directory, "rb").read()
if hashlib.sha256(data).hexdigest() != SHA256:
    raise SystemExit("the CDE agency directory does not match its SHA-256")
d = json.loads(data)
directory = {x["ori"]: x["agency_name"].strip() for x in d["agencies"] if (x.get("agency_name") or "").strip()}
oris = [r[0] for r in duckdb.connect().execute(f"SELECT DISTINCT ori FROM read_parquet('{a.root}/agency/data.parquet') ORDER BY ori").fetchall()]
names = {o: directory[o] for o in oris if o in directory}

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps({
        "_comment": "FBI agency names (CDE agency directory) for the ORIs of canonical release 20261028-test5 (scripts/build-nibrs-agency-names.py).",
        "release": "20261028-test5",
        "source": {"endpoint": d["endpoint"], "retrieved_at": d["retrieved_at"], "sha256": SHA256},
        "build_oris": len(oris), "named": len(names),
        "names": names,
    }, indent=0, ensure_ascii=False, sort_keys=False))
    f.write("\n")
print(f"{len(names)} of {len(oris)} build ORIs named -> {OUT}")
