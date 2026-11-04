#!/usr/bin/env python3
"""Records the NIBRS release the shadow reads: scripts/fixtures/nibrs-shadow/release.json.

    python scripts/build-nibrs-shadow-release.py --release-dir <canonical release dir (holds manifest.json)> \
        --source-archive <nibrs-model manifests/source-archive.json, e.g. `git -C ../nibrs-model show main:manifests/source-archive.json`>

Jeff's rule (2026-11-03): NIBRS, SHR and Hate Crime come from the FBI's monthly CDE releases (around the 15th), and the
latest month shown is the one before the latest release's month: month M appears only after the update of month M+1.
The release date is the CDE last-modified time of the build's latest-year master file, found in nibrs-model's source
archive by the SHA-256 the build's manifest records for that year; never the calendar. The engine computes the latest
month from it (lib/answer-contract/contract.ts latestShownMonth). Read-only on both inputs.
"""
import argparse
import json
import os
from email.utils import parsedate_to_datetime

ap = argparse.ArgumentParser()
ap.add_argument("--release-dir", required=True)
ap.add_argument("--source-archive", required=True)
a = ap.parse_args()
OUT = os.path.join(os.path.dirname(__file__), "fixtures", "nibrs-shadow", "release.json")

with open(os.path.join(a.release_dir, "manifest.json"), encoding="utf-8") as f:
    m = json.load(f)
years = sorted(int(y) for y in m["years"])
latest = str(years[-1])
sha = m["years"][latest]["source_sha256"]
with open(a.source_archive, encoding="utf-8") as f:
    archive = json.load(f)
obj = next((o for o in archive["objects"] if o["sha256"] == sha), None)
if obj is None:
    raise SystemExit(f"the source archive has no object with SHA-256 {sha} (the build's {latest} master file)")
released = parsedate_to_datetime(obj["cde_last_modified"]).strftime("%Y-%m-%dT%H:%M:%SZ")  # an RFC 1123 GMT time
out = {"_comment": "The NIBRS release the shadow reads (scripts/build-nibrs-shadow-release.py): its latest-year master file's CDE release date.",
       "release": m["release_id"], "first_year": years[0], "latest_year": years[-1], "source_sha256": sha,
       "cde_key": obj["cde_key"], "released": released}
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
print(json.dumps(out))
