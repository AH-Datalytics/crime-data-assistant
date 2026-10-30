#!/usr/bin/env python3
"""Builds the agencies' FBI names: scripts/fixtures/nibrs-shadow/agency-names.json.

    python -I scripts/build-nibrs-agency-names.py --model <nibrs-model checkout>

The names are nibrs-model's reference/agency-names/agency-names.csv on its main branch (read with git show, never from
a work tree): the FBI Crime Data Explorer agency directory (retrieved 2026-10-29), then the CDE participation download
(2026-10-29), each archived by SHA-256 on B2. An ORI neither names has no entry (the engine then falls back to the
build's city, as nibrs-model's ranking values do). Never built from a city and an agency type (Jeff 2026-10-30): the
build's city is a mailing city (OH0311100 says CINCINNATI and is the Fairfax Police Department).
"""
import argparse
import csv
import io
import json
import os
import subprocess

ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
a = ap.parse_args()
OUT = os.path.join(os.path.dirname(__file__), "fixtures", "nibrs-shadow", "agency-names.json")

def git(*args):
    return subprocess.run(["git", "-C", a.model, *args], check=True, capture_output=True, text=True, encoding="utf-8").stdout

commit = git("rev-parse", "main").strip()
rows = list(csv.DictReader(io.StringIO(git("show", "main:reference/agency-names/agency-names.csv"))))
names = {r["ori"]: r["agency_name"] for r in rows if r["agency_name"].strip()}
sources = sorted({(r["source"], r["source_date"]) for r in rows if r["source"]})

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps({
        "_comment": "FBI agency names for the ORIs of canonical release 20261028-test5, from nibrs-model's reference/agency-names/agency-names.csv (scripts/build-nibrs-agency-names.py).",
        "release": "20261028-test5",
        "source": {"repo": "nibrs-model", "commit": commit, "file": "reference/agency-names/agency-names.csv",
                   "sources": [{"source": s, "date": d} for s, d in sources]},
        "build_oris": len(rows), "named": len(names),
        "names": names,
    }, indent=0, ensure_ascii=False))
    f.write("\n")
print(f"{len(names)} of {len(rows)} build ORIs named (nibrs-model {commit[:7]}) -> {OUT}")
