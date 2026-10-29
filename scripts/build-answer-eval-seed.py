#!/usr/bin/env python3
"""Builds the question side of the labeled interaction set: scripts/fixtures/answer-eval/cases.json.

    python scripts/build-answer-eval-seed.py

Three origins (spec: docs/superpowers/specs/2026-10-28-answer-eval-labeled-set.md):
- gold: all 120 cases of the frozen gold set (docs/superpowers/2026-09-06-correctness-gold-set-v7.json, sha256-checked),
  real logged questions across every tab, with their setup turns;
- replay: NIBRS questions from the 605-question replay inventory that the gold set does not hold, one per normalized
  wording, chosen deterministically across the reachability categories;
- designed: questions written for the open and decided policy rows, paraphrase groups and button continuations.

Labels start "unlabeled". An existing cases.json keeps every label already written for a case with the same
origin and question; this script never overwrites a label.
"""
import collections
import hashlib
import json
import os
import re

ROOT = os.path.join(os.path.dirname(__file__), "..")
GOLD = os.path.join(ROOT, "docs", "superpowers", "2026-09-06-correctness-gold-set-v7.json")
GOLD_SHA256 = "24e4d15068a343a0436995261937050e9324dece4cf140aa3274dd1f01f80c3b"
OUT = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "cases.json")
REPLAY_PICKS = 36
HELDOUT_SHARE = 0.15

raw = open(GOLD, "rb").read()
assert hashlib.sha256(raw).hexdigest() == GOLD_SHA256, "gold set hash"
gold = json.loads(raw.decode("utf-8"))
TAB = {"nibrs": "nibrs", "current": "current", "historical": "historical", "shr": "shr", "hate_crime": "hate_crime"}

cases = []


def add(origin, ref, tab, question, group, policy=(), setup=(), button=None):
    cases.append({"origin": {"kind": origin, "ref": ref}, "tab": tab, "setup": list(setup), "question": question, "group": group,
                  "policy": list(policy), **({"button": button} if button else {})})


# ---- gold: every frozen case, its setup turns kept together ----
for c in gold["cases"]:
    add("gold", c["id"], TAB[c["tab"]], c["question"], f"gold:{c['id']}", [f"D{int(d):02d}" for d in c.get("decisions", []) if str(d).isdigit()],
        [{"question": s["question"], "tab": TAB[s["tab"]]} for s in c.get("setup_turns", [])])

# ---- replay: NIBRS questions not in the gold set, one per wording, spread over reachability categories ----
inv = json.load(open(os.path.join(ROOT, "scripts", "fixtures", "nibrs-replay", "inventory.json"), encoding="utf-8"))["items"]
reach = {r["id"]: r["category"] for r in json.load(open(os.path.join(ROOT, "scripts", "fixtures", "nibrs-replay", "reachability", "results.json"), encoding="utf-8"))["rows"]}
gold_logs = {c.get("source_log_id") for c in gold["cases"]} | {s.get("log_id") for c in gold["cases"] for s in c.get("setup_turns", [])}
norm = lambda q: re.sub(r"[^a-z0-9 ]", "", q.lower()).strip()
seen, by_cat = set(), collections.defaultdict(list)
for it in sorted(inv, key=lambda x: x["id"]):
    n = norm(it["question"])
    if it["id"] in gold_logs or n in seen or it["context"].get("follow_up_likely") or len(n) < 12:
        continue
    seen.add(n)
    by_cat[reach.get(it["id"], "unknown")].append(it)
# Deterministic round-robin over categories, each category ordered by a hash of the question.
for cat in by_cat:
    by_cat[cat].sort(key=lambda x: hashlib.sha256(x["question"].encode()).hexdigest())
picked = []
while len(picked) < REPLAY_PICKS and any(by_cat.values()):
    for cat in sorted(by_cat):
        if by_cat[cat] and len(picked) < REPLAY_PICKS:
            picked.append(by_cat[cat].pop(0))
for it in picked:
    add("replay", f"replay:{it['id']}", "nibrs", it["question"], f"replay:{it['id']}")

# ---- designed: one or more questions per policy row; paraphrases share a group ----
D = [
    # (group, tab, question, policy rows)
    ("src-chicago", "auto", "How many murders were there in Chicago in 2024?", ["P01"]),
    ("src-chicago", "auto", "Chicago murder count for 2024", ["P01"]),
    ("src-hate", "auto", "How many hate crimes against Jewish people were reported in New York in 2023?", ["P01", "D24"]),
    ("src-weapons", "auto", "What weapons were used in robberies in Atlanta in 2024?", ["P01"]),
    ("src-ytd", "auto", "How many murders has Dallas had so far this year?", ["P01", "D06"]),
    ("src-staff", "auto", "How many police officers did Seattle have in 2022?", ["P01", "D26"]),
    ("nat-cov", "nibrs", "How many robberies were there in the US in 2015?", ["P02", "P12"]),
    ("nat-cov2", "nibrs", "Total rapes reported in California in 2018", ["P02"]),
    ("trend-cohort", "nibrs", "How did aggravated assaults change in Texas from 2018 to 2024?", ["P03"]),
    ("trend-cohort2", "nibrs", "Burglaries per year in Florida from 2019 to 2024", ["P03"]),
    ("rank-partial", "current", "Top 20 cities by murder rate in 2024", ["P04", "D05"]),
    ("rank-partial2", "nibrs", "Which cities had the most motor vehicle thefts in 2023?", ["P04", "D05"]),
    ("rank-year", "current", "Which cities had the most murders?", ["P05", "D05"]),
    ("noperiod", "nibrs", "Murders in Houston", ["P06"]),
    ("noperiod-trend", "nibrs", "Murders in Houston over time", ["P06"]),
    ("noperiod-hist", "historical", "Robberies in Phoenix", ["P06"]),
    ("lastyear", "current", "Burglaries in Texas last year", ["P07"]),
    ("lastyear-n", "nibrs", "Burglaries in Texas last year", ["P07"]),
    ("large-city", "auto", "Which large US city had the highest violent crime rate in 2023?", ["P08"]),
    ("assault", "nibrs", "How many assaults were there in Phoenix in 2024?", ["P09"]),
    ("assault-c", "current", "How many assaults were there in Phoenix in 2024?", ["P09"]),
    ("homicide-shr", "shr", "How many homicides were there in Memphis in 2023?", ["P10"]),
    ("homicide-n", "nibrs", "How many homicides were there in Memphis in 2023?", ["P10"]),
    ("victims", "nibrs", "How many theft victims were there in Ohio in 2024?", ["P11"]),
    ("victims-off", "nibrs", "How many thefts were there in Ohio in 2024?", ["P11", "D18"]),
    ("noplace", "nibrs", "How many murders were there in 2024?", ["P12", "P02"]),
    ("safest", "auto", "What is the safest city in America?", ["P13"]),
    ("safest", "auto", "Which US city is the most dangerous?", ["P13"]),
    ("span", "nibrs", "Murders in Chicago from 1990 to 2024", ["P14", "D04"]),
    ("rate-den", "nibrs", "What was the robbery rate in Georgia in 2024?", ["P15"]),
    ("city-agency", "current", "Crime in Las Vegas in 2024", ["P16", "D09"]),
    ("city-agency2", "current", "Violent crime in Las Vegas in 2024", ["P16"]),
    ("ties", "current", "Top 10 cities by murders in 2024", ["P17", "D05"]),
    ("state-clr", "historical", "What was the burglary clearance rate in Ohio in 2023?", ["P18"]),
    ("fentanyl", "nibrs", "How many fentanyl seizures were there in Ohio in 2024?", ["P19"]),
    ("forecast", "auto", "Will crime go up in Chicago next year?", ["P20"]),
    ("incident", "auto", "What happened in the shooting on Main Street in Akron last Friday?", ["P21"]),
    ("future", "current", "Burglaries in Denver in 2027", ["P24", "D04"]),
    # decided rules, designed counterparts
    ("county", "historical", "Violent crime in Cook County, Illinois in 2022", ["D10"]),
    ("bare-crime", "nibrs", "Crime in Denver in 2024", ["D09", "P22"]),
    ("why", "current", "Why did murders rise in 2020?", ["D12"]),
    ("why-data", "current", "Why is the 2026 murder count for Chicago lower than 2025's?", ["D12", "D06"]),
    ("neighborhood", "auto", "Crime in the Mission District of San Francisco", ["D02"]),
    ("demo-rate", "nibrs", "What is the murder rate for Black victims in Chicago in 2024?", ["D03"]),
    ("court", "nibrs", "How many robbery arrests in Georgia in 2024 led to convictions?", ["D01"]),
    ("shootings", "shr", "Shootings in Chicago in 2024", ["D14", "P22"]),
    ("peers", "historical", "How does Austin's 2023 violent crime rate compare with similar cities?", ["D16"]),
    ("drug", "nibrs", "Drug crimes in Kentucky in 2024", ["D19"]),
    ("dv", "nibrs", "Domestic violence murders in Texas in 2023", ["D20"]),
    ("flashmob", "nibrs", "How many flash mob shoplifting incidents were there in California in 2024?", ["D21"]),
    ("coverage", "nibrs", "What share of Florida's population is covered by NIBRS reporting in 2024?", ["D22"]),
    ("propval", "nibrs", "What was the value of stolen property in New York in 2021?", ["D23"]),
    ("hate-file", "hate_crime", "How many hate crimes were reported in Texas in 2023?", ["D24"]),
    ("staffing", "historical", "How many police officers did Baltimore have in 2020?", ["D26"]),
    ("state-rtci", "current", "Robberies in Ohio this year", ["D27", "D06"]),
    ("change-rank", "nibrs", "Which states saw the biggest increase in murders from 2022 to 2024?", ["D07"]),
    ("rape-2013", "historical", "Rapes in the United States from 2010 to 2016", ["D11"]),
]
for g, tab, q, pol in D:
    add("designed", None, tab, q, f"designed:{g}", pol)

# Conversations and button continuations (the button refers to the case it answers; ids are filled below).
CONV = [
    ("conv-dallas", "nibrs", [("Murders in Houston in 2024 by victim race", None)], "What about Dallas?", ["P23"]),
    ("conv-year", "current", [("Robberies in Atlanta in 2023", None)], "And in 2024?", ["P23"]),
]
for g, tab, setup, q, pol in CONV:
    add("designed", None, tab, q, f"designed:{g}", pol, [{"question": s, "tab": tab} for s, _ in setup])

BUTTONS = [
    ("designed:bare-crime", "Violent crime", ["D09", "P22"]),
    ("designed:shootings", "Fatal shootings", ["D14", "P22"]),
    ("designed:safest", "Violent crime rate", ["P13", "P22"]),
]

# ---- ids, splits, and labels carried over ----
prev = {}
if os.path.exists(OUT):
    for c in json.load(open(OUT, encoding="utf-8"))["cases"]:
        prev[(c["origin"]["kind"], c["origin"]["ref"], c["question"], json.dumps(c.get("button")))] = c
out = []
for i, c in enumerate(cases, 1):
    c["id"] = f"LS-{i:03d}"
for g, opt, pol in BUTTONS:
    first = next(c for c in cases if c["group"] == g)
    cases.append({"origin": {"kind": "designed", "ref": None}, "tab": first["tab"], "setup": [], "question": first["question"], "group": g,
                  "policy": pol, "button": {"answers": first["id"], "option": opt}, "id": f"LS-{len(cases) + 1:03d}"})
for c in cases:
    # Whole groups go to held-out, chosen by a hash of the group (never by content or by a candidate's results).
    h = int(hashlib.sha256(c["group"].encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    c["split"] = "heldout" if h < HELDOUT_SHARE else "dev"
    key = (c["origin"]["kind"], c["origin"]["ref"], c["question"], json.dumps(c.get("button")))
    old = prev.get(key)
    c["expected"] = old["expected"] if old else None
    c["label"] = old["label"] if old else {"status": "unlabeled", "drafted_by": None, "reviewed_by": None, "notes": ""}
    out.append({k: c[k] for k in ["id", "group", "split", "origin", "tab", "setup", "question", *(["button"] if "button" in c else []), "policy", "expected", "label"]})

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    json.dump({"version": 1, "gold_set_sha256": GOLD_SHA256, "cases": out}, f, indent=1, ensure_ascii=False)
    f.write("\n")
n = collections.Counter(c["origin"]["kind"] for c in out)
print(len(out), "cases:", dict(n), "| heldout", sum(c["split"] == "heldout" for c in out))
