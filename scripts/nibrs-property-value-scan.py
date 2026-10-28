#!/usr/bin/env python3
"""Scan every property segment (03) of the archived FBI NIBRS master files for the property-value outlier report.

    <nibrs-model venv python> scripts/nibrs-property-value-scan.py NIBRS_MODEL_DIR OUT_DIR [ZIP_DIR]

Read-only. NIBRS_MODEL_DIR is a nibrs-model checkout (its manifest, ZIP reader and E2017 field map); ZIP_DIR defaults to
its work/source/sha256. Covers the E2017 layout era (data years 2017-2026), the only era with a verified field map.

Writes to OUT_DIR:
- high_value_segments.csv: every segment whose value is $1,000,000 or more (year, ORI, incident, line, loss type,
  description, value);
- value_counts.json: per year, how many segments carry each value of $100,000 or more (to find repeated values);
- value_desc_counts.json: the same per year by "loss|description|value";
- groups.json: per year, loss type and description: segments, blank values, zero values, total dollars, maximum, and
  a count per power-of-ten band;
- stolen_by_state_year.json: stolen (loss 7) dollars and segments by state (the ORI's first two letters) and year.
Repeated identical incidents (build rule T1) are not removed here; their effect on totals is negligible and noted.
"""
import collections
import csv
import json
import os
import sys
import zipfile

MODEL, OUT = sys.argv[1], sys.argv[2]
ZIP_DIR = sys.argv[3] if len(sys.argv) > 3 else os.path.join(MODEL, "work", "source", "sha256")
sys.path.insert(0, os.path.join(MODEL, "src"))
from nibrs_model.zipread import open_member  # noqa: E402

YEARS = range(2017, 2027)
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(MODEL, "manifests", "source-archive.json"), encoding="utf-8") as f:
    SRC = {o["year"]: o for o in json.load(f)["objects"]}


def band(v):
    if v is None:
        return "blank"
    if v == 0:
        return "0"
    return f"1e{len(str(v)) - 1}"  # 1e0: 1-9, 1e1: 10-99 ... 1e8: 100,000,000-999,999,999


groups = {}
value_counts = {}
value_desc_counts = {}
stolen = collections.defaultdict(lambda: [0, 0])
bad_lines = collections.Counter()
with open(os.path.join(OUT, "high_value_segments.csv"), "w", encoding="utf-8", newline="") as hf:
    hw = csv.writer(hf, lineterminator="\n")
    hw.writerow(["data_year", "ori", "incident_num", "line", "loss_type", "description", "value"])
    for year in YEARS:
        rec = SRC[year]
        path = os.path.join(ZIP_DIR, f"{rec['sha256']}.zip")
        with zipfile.ZipFile(path) as zf:
            [info] = zf.infolist()
        g = collections.defaultdict(lambda: {"segments": 0, "blank": 0, "zero": 0, "dollars": 0, "max": 0, "bands": collections.Counter()})
        vc = collections.Counter()
        vd = collections.Counter()
        with open_member(path, info) as stream:
            for n, line in enumerate(stream, 1):
                if line[:2] != b"03":
                    continue
                body = line.rstrip(b"\r\n")
                if len(body) == 100:  # the last two positions blank and trimmed (layouts.SEG03_LENGTH)
                    body += b"  "
                if len(body) != 102:
                    bad_lines[(year, len(body))] += 1
                    continue
                loss, desc, raw = body[33:34].decode(), body[34:36].decode(), body[36:45].decode().strip()
                v = int(raw) if raw.isdigit() else None
                k = f"{loss}|{desc}"
                x = g[k]
                x["segments"] += 1
                x["bands"][band(v)] += 1
                if v is None:
                    x["blank"] += 1
                    continue
                if v == 0:
                    x["zero"] += 1
                x["dollars"] += v
                x["max"] = max(x["max"], v)
                if v >= 100_000:
                    vc[v] += 1
                    vd[f"{k}|{v}"] += 1
                if v >= 1_000_000:
                    hw.writerow([year, body[4:13].decode(), body[13:25].decode(), n, loss, desc, v])
                if loss == "7":
                    s = stolen[(body[4:6].decode(), year)]
                    s[0] += v
                    s[1] += 1
        groups[year] = {k: {**x, "bands": dict(x["bands"])} for k, x in g.items()}
        value_counts[year] = {str(v): c for v, c in vc.most_common()}
        value_desc_counts[year] = dict(vd)
        print(year, sum(x["segments"] for x in g.values()), "property segments", flush=True)

with open(os.path.join(OUT, "groups.json"), "w", encoding="utf-8") as f:
    json.dump(groups, f)
with open(os.path.join(OUT, "value_counts.json"), "w", encoding="utf-8") as f:
    json.dump(value_counts, f)
with open(os.path.join(OUT, "value_desc_counts.json"), "w", encoding="utf-8") as f:
    json.dump(value_desc_counts, f)
with open(os.path.join(OUT, "stolen_by_state_year.json"), "w", encoding="utf-8") as f:
    json.dump({f"{s}|{y}": v for (s, y), v in sorted(stolen.items())}, f)
with open(os.path.join(OUT, "scan_info.json"), "w", encoding="utf-8") as f:
    json.dump({"years": list(YEARS), "zip_sha256": {y: SRC[y]["sha256"] for y in YEARS},
               "lines_with_unexpected_length": {f"{y}|{n}": c for (y, n), c in bad_lines.items()}}, f, indent=1)
print("done; unexpected-length lines:", dict(bad_lines))
