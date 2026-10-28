#!/usr/bin/env python3
"""Tables for the property-value outlier report, from the output of nibrs-property-value-scan.py.

    python scripts/nibrs-property-value-report.py SCAN_DIR OUT_DIR

Writes OUT_DIR/tables.md (the report's numbers) and three CSVs: by_year_description.csv (distribution per year, loss
type and description), sentinel_agencies.csv (every agency-year holding a sentinel value) and
stolen_by_state_year.csv (stolen dollars by state and year, as reported and under each candidate rule).
Read-only; every number comes from the scan's files.
"""
import collections
import csv
import json
import os
import sys

SCAN, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
load = lambda n: json.load(open(os.path.join(SCAN, n), encoding="utf-8"))
groups, value_counts, stolen = load("groups.json"), load("value_counts.json"), load("stolen_by_state_year.json")
high = list(csv.DictReader(open(os.path.join(SCAN, "high_value_segments.csv"), encoding="utf-8")))
for r in high:
    r["value"] = int(r["value"])
YEARS = sorted(groups)

DESC = dict(line.split("=", 1) for line in """01=Aircraft;02=Alcohol;03=Automobile;04=Bicycles;05=Buses;06=Clothes/furs;07=Computer hardware/software;08=Consumable goods;09=Credit/debit cards;10=Drugs/narcotics;11=Drug equipment;12=Farm equipment;13=Firearms;14=Gambling equipment;15=Industrial equipment;16=Household goods;17=Jewelry/precious metals;18=Livestock;19=Merchandise;20=Money;21=Negotiable instruments;22=Nonnegotiable instruments;23=Office equipment;24=Other motor vehicles;25=Purse/wallet;26=Radio/TV/VCR;27=Recordings;28=Recreational vehicles;29=Structure, single dwelling;30=Structure, other residence;31=Structure, commercial;32=Structure, industrial;33=Structure, public;34=Structure, storage;35=Structure, other;36=Tools;37=Trucks;38=Vehicle parts;39=Watercraft;41=Aircraft parts;42=Artistic supplies;43=Building materials;44=Camping/hunting/fishing;45=Chemicals;46=Collections/collectibles;47=Crops;48=Documents;49=Explosives;59=Firearm accessories;64=Fuel;65=Identity documents;66=Identity, intangible;67=Law enforcement equipment;68=Lawn/yard/garden equipment;69=Logging equipment;70=Medical equipment;71=Metals, non-precious;72=Musical instruments;73=Pets;74=Photographic/optical;75=Portable electronic communications;76=Recreational/sports equipment;77=Other;78=Trailers;79=Watercraft parts;80=Weapons, other;88=Pending inventory;99=Special""".split(";"))
DESC["  "] = "(blank: loss type None or Unknown)"
LOSS = {"1": "None", "2": "Burned", "3": "Counterfeited/forged", "4": "Destroyed/damaged/vandalized", "5": "Recovered", "6": "Seized", "7": "Stolen", "8": "Unknown"}

# ---- candidate rules: each says whether a segment's value is excluded ----
SENTINELS = {999_999_999, 999_999_998, 99_999_999, 9_999_999}  # the field maximum, one below it, and the all-nines
REPEATS = {7_777_777, 1_111_111, 19_999_998}  # repeated filler values found by the scan, concentrated in a few agencies
CAP_1M = set("02 04 06 08 09 10 11 13 14 16 25 26 27 36 38 42 44 48 59 65 67 68 72 73 74 75 76 79 80".split())
CAP_100M = set("01 05 12 15 19 20 21 22 29 30 31 32 33 34 35 37 39 47 66 69 71".split())
cap = lambda d: 1_000_000 if d in CAP_1M else 100_000_000 if d in CAP_100M else 10_000_000
# Rule C's flag: an agency-year with 10 or more non-sentinel segments of $1M or more.
million_ay = collections.Counter((r["ori"], r["data_year"]) for r in high if r["value"] not in SENTINELS)
FLAGGED = {k for k, n in million_ay.items() if n >= 10}
RULES = {
    "A": ("exact sentinels", lambda r: r["value"] in SENTINELS),
    "A+": ("exact sentinels and repeated fillers", lambda r: r["value"] in SENTINELS | REPEATS),
    "B": ("rule A plus per-description caps", lambda r: r["value"] in SENTINELS or r["value"] > cap(r["description"])),
    "C": ("rule A plus an agency-year flag", lambda r: r["value"] in SENTINELS or (r["ori"], r["data_year"]) in FLAGGED),
}
md = []
w = md.append
fmt = lambda n: f"{n:,}"
usd = lambda n: f"${n / 1e9:,.2f}B" if n >= 1e9 else f"${n / 1e6:,.1f}M"


def table(head, rows):
    w("| " + " | ".join(head) + " |")
    w("|" + "---|" * len(head))
    for r in rows:
        w("| " + " | ".join(str(x) for x in r) + " |")
    w("")


# ---- 1. distribution: by year, all segments ----
w("## Distribution by year (every property segment, every loss type)\n")
rows = []
for y in YEARS:
    g = groups[y].values()
    seg = sum(x["segments"] for x in g)
    dol = sum(x["dollars"] for x in g)
    b = collections.Counter()
    for x in g:
        b.update(x["bands"])
    ge1m = sum(b.get(f"1e{k}", 0) for k in (6, 7, 8))
    hi = [r for r in high if r["data_year"] == y]
    rows.append([y, fmt(seg), f"{100 * b['blank'] / seg:.1f}%", f"{100 * b['0'] / seg:.1f}%", fmt(b.get("1e5", 0)), fmt(ge1m),
                 fmt(b.get("1e8", 0)), usd(dol), usd(sum(r["value"] for r in hi)), f"{100 * sum(r['value'] for r in hi) / dol:.1f}%"])
table(["Year", "Segments", "Blank", "$0", "$100k-$999,999", "$1M+", "$100M+", "Dollars", "Dollars in $1M+ segments", "Share"], rows)

# ---- by description, 2017-2026 ----
w("## Distribution by description (2017-2026, every loss type)\n")
agg = collections.defaultdict(lambda: {"segments": 0, "dollars": 0, "max": 0, "bands": collections.Counter()})
with open(os.path.join(OUT, "by_year_description.csv"), "w", encoding="utf-8", newline="") as f:
    cw = csv.writer(f, lineterminator="\n")
    cw.writerow(["data_year", "loss_type", "description", "segments", "blank", "zero", "dollars", "max", *[f"band_1e{k}" for k in range(9)]])
    for y in YEARS:
        for k, x in sorted(groups[y].items()):
            loss, d = k.split("|")
            cw.writerow([y, loss, d, x["segments"], x["blank"], x["zero"], x["dollars"], x["max"], *[x["bands"].get(f"1e{i}", 0) for i in range(9)]])
            a = agg[d]
            a["segments"] += x["segments"]
            a["dollars"] += x["dollars"]
            a["max"] = max(a["max"], x["max"])
            a["bands"].update(x["bands"])
rows = []
for d, a in sorted(agg.items(), key=lambda kv: -kv[1]["dollars"]):
    hi = [r["value"] for r in high if r["description"] == d]
    rows.append([d, DESC.get(d, "?"), fmt(a["segments"]), usd(a["dollars"]), fmt(len(hi)), usd(sum(hi)), f"{100 * sum(hi) / a['dollars']:.0f}%" if a["dollars"] else "",
                 fmt(sum(1 for v in hi if v in SENTINELS)), fmt(a["max"]), fmt(cap(d))])
table(["Code", "Description", "Segments", "Dollars", "$1M+ segments", "$1M+ dollars", "Share", "Sentinel segments", "Maximum", "Rule B cap"], rows)

# ---- 2. sentinels and repeated values ----
w("## Repeated values of $1M or more (2017-2026, every loss type), by count\n")
tot = collections.Counter()
for y in YEARS:
    for v, c in value_counts[y].items():
        tot[int(v)] += c
named = [999_999_999, 999_999_998, 99_999_999, 9_999_999, 10_000_000, 100_000_000, 7_777_777, 1_111_111, 19_999_998]
top = [v for v, _ in sorted(((v, c) for v, c in tot.items() if v >= 1_000_000), key=lambda x: -x[1])[:25]]
rows = []
for v in named + [v for v in top if v not in named]:
    rs = [r for r in high if r["value"] == v]
    ay = collections.Counter((r["ori"], r["data_year"]) for r in rs)
    states = collections.Counter(r["ori"][:2] for r in rs)
    rows.append([fmt(v), fmt(tot[v]), usd(v * tot[v]), len({r["ori"] for r in rs}), ", ".join(f"{s} {n}" for s, n in states.most_common(3)),
                 "; ".join(f"{o} {yy}: {n}" for (o, yy), n in ay.most_common(2)), " ".join(f"{y[2:]}:{value_counts[y].get(str(v), 0)}" for y in YEARS)])
table(["Value", "Segments", "Dollars", "Agencies", "Top states", "Top agency-years", "By year (17-26)"], rows)

with open(os.path.join(OUT, "sentinel_agencies.csv"), "w", encoding="utf-8", newline="") as f:
    cw = csv.writer(f, lineterminator="\n")
    cw.writerow(["ori", "data_year", "value", "segments", "stolen_segments", "agency_year_flagged_rule_c"])
    by = collections.Counter((r["ori"], r["data_year"], r["value"]) for r in high if r["value"] in SENTINELS | REPEATS | {10_000_000})
    st = collections.Counter((r["ori"], r["data_year"], r["value"]) for r in high if r["value"] in SENTINELS | REPEATS | {10_000_000} and r["loss_type"] == "7")
    for (o, y, v), n in sorted(by.items(), key=lambda kv: (-kv[1], kv[0])):
        cw.writerow([o, y, v, n, st[(o, y, v)], (o, y) in FLAGGED])

# ---- 3. what each rule removes ----
w("## What each candidate rule removes (2017-2026, every loss type)\n")
rows = []
for name, (label, f) in RULES.items():
    rs = [r for r in high if f(r)]
    s7 = [r for r in rs if r["loss_type"] == "7"]
    rows.append([name, label, fmt(len(rs)), usd(sum(r["value"] for r in rs)), fmt(len(s7)), usd(sum(r["value"] for r in s7)),
                 len({r["ori"] for r in rs}), len({(r["ori"], r["data_year"]) for r in rs})])
table(["Rule", "", "Segments", "Dollars", "Stolen segments", "Stolen dollars", "Agencies", "Agency-years"], rows)
w(f"Rule C flags {len(FLAGGED)} agency-years (10 or more non-sentinel segments of $1M or more) and removes every $1M+ value in them.\n")
for name in ("B", "C"):
    _, f = RULES[name]
    extra = collections.Counter()
    for r in high:
        if f(r) and not RULES["A"][1](r):
            extra[r["description"]] += r["value"]
    w(f"Rule {name} beyond rule A, dollars by description: " + ", ".join(f"{d} {DESC.get(d, '?')} {usd(n)}" for d, n in extra.most_common(8)) + "\n")
w("Flagged agency-years (rule C), by $1M+ segments: " + ", ".join(f"{o} {y} ({million_ay[(o, y)]})" for o, y in sorted(FLAGGED, key=lambda k: -million_ay[k])[:20]) + "\n")

w("## The largest stolen segments that rule A keeps\n")
keep = sorted((r for r in high if r["loss_type"] == "7" and not RULES["A"][1](r)), key=lambda r: -r["value"])[:25]
table(["Year", "ORI", "Description", "Value", "Rule B", "Rule C"], [[r["data_year"], r["ori"], f"{r['description']} {DESC.get(r['description'], '?')}", fmt(r["value"]),
      "removed" if RULES["B"][1](r) else "kept", "removed" if RULES["C"][1](r) else "kept"] for r in keep])

# ---- 4. stolen dollars by state and year ----
removed = {n: collections.Counter() for n in RULES}
for r in high:
    if r["loss_type"] != "7":
        continue
    for n, (_, f) in RULES.items():
        if f(r):
            removed[n][(r["ori"][:2], r["data_year"])] += r["value"]
with open(os.path.join(OUT, "stolen_by_state_year.csv"), "w", encoding="utf-8", newline="") as f:
    cw = csv.writer(f, lineterminator="\n")
    cw.writerow(["state", "data_year", "segments", "stolen_dollars", *[f"without_rule_{n}" for n in RULES]])
    for k, (dol, seg) in sorted(stolen.items()):
        s, y = k.split("|")
        cw.writerow([s, y, seg, dol, *[dol - removed[n][(s, y)] for n in RULES]])
w("## Stolen dollars, all states, by year: as reported and under each rule\n")
rows = []
for y in YEARS:
    dol = sum(v[0] for k, v in stolen.items() if k.endswith("|" + y))
    rows.append([y, usd(dol), *[f"{usd(dol - sum(c for (s, yy), c in removed[n].items() if yy == y))} ({-100 * sum(c for (s, yy), c in removed[n].items() if yy == y) / dol:.1f}%)" for n in RULES]])
table(["Year", "Reported", *[f"Rule {n}" for n in RULES]], rows)
w("## State-years whose stolen dollars move most under rule A\n")
rows = []
for (s, y), c in removed["A"].most_common(15):
    dol = stolen[f"{s}|{y}"][0]
    rows.append([s, y, usd(dol), usd(dol - c), f"{-100 * c / dol:.0f}%", *[usd(dol - removed[n][(s, y)]) for n in ("B", "C")]])
table(["State", "Year", "Reported", "Rule A", "Change", "Rule B", "Rule C"], rows)
moved = {n: sum(1 for (s, y), c in removed[n].items() if c / stolen[f"{s}|{y}"][0] >= 0.10) for n in RULES}
w("State-years whose stolen dollars fall by 10% or more: " + ", ".join(f"rule {n} {k}" for n, k in moved.items()) + f" (of {len(stolen)}).\n")

open(os.path.join(OUT, "tables.md"), "w", encoding="utf-8", newline="\n").write("\n".join(md))
print("\n".join(md))
