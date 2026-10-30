#!/usr/bin/env python3
"""Copies the Crime Index historical snapshot's state and national files into scripts/fixtures/nibrs-shadow/crimeindex/.

    python -I scripts/build-crimeindex-fixture.py --snapshot <nibrs-model>/work/crimeindex/20261030

The shadow engine reads Part I state and national figures (P53) and the national clearance rate (P57) from these, never
the live site. Each file must match the SHA-256 that nibrs-model's manifest (manifests/crimeindex-archive.json, snapshot
20261030) pins; the copy is byte-exact. crimeindex.org is AH Datalytics' compilation of FBI SRS figures; answers name the
source "FBI SRS" (P63).
"""
import argparse
import hashlib
import os
import shutil

FILES = {
    "historical_crime_states_nation_1960-2025.csv": "0989de024cdab3cfd49a176ee6e96b5cbe6c2db746db93701350c9c06540b3c9",
    "historical_clearances/historical_clearances_states_nation_1960-2025.csv": "7592748e0856017e49023bce2c8ccdd230ee2ffc1c64d80f7db9ecfb3b0a4c7c",
}
ap = argparse.ArgumentParser()
ap.add_argument("--snapshot", required=True)
a = ap.parse_args()
OUT = os.path.join(os.path.dirname(__file__), "fixtures", "nibrs-shadow", "crimeindex")
os.makedirs(OUT, exist_ok=True)
for rel, sha in FILES.items():
    src = os.path.join(a.snapshot, rel)
    if hashlib.sha256(open(src, "rb").read()).hexdigest() != sha:
        raise SystemExit(f"{rel} does not match its pinned SHA-256")
    shutil.copyfile(src, os.path.join(OUT, os.path.basename(rel)))
    print(f"{os.path.basename(rel)}: {sha[:12]} ok")
