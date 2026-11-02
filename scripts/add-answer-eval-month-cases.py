#!/usr/bin/env python3
"""Adds the designed cases for breakdowns by month and by quarter (Jeff 2026-11-02: "we can't breakdown by month?
Something like Aggravated assault victims in Nashville by sex and month in 2023") to cases.json, with drafted labels.

    python scripts/add-answer-eval-month-cases.py [--reviewed-by codex:month-labels-1]

Cases are appended after every existing case (same group and question: left alone), so no earlier id changes. Each label
is written from the decided rows it cites, never from a candidate's output. --reviewed-by marks still-drafted labels of
this group reviewed. Run scripts/test-answer-eval-cases.ts afterwards.
"""
import hashlib
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CASES = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "cases.json")
GROUP = "designed:category-by-month"
DRAFTER = "claude-month"
HELDOUT_SHARE = 0.15

NASHVILLE = {"kind": "agency", "name": "Metropolitan Nashville Police Department", "state": "TN"}
MEMPHIS = {"kind": "agency", "name": "Memphis Police Department", "state": "TN"}
DETROIT = {"kind": "agency", "name": "Detroit Police Department", "state": "MI"}
YEAR = lambda y: {"from": f"{y}-01", "to": f"{y}-12"}
SOURCE = "Names its source at the end"
UNKNOWN_LAST = "Lists the unknown category after the known ones in each period"


def case(question, place, measure, unit, groupings, year, agency_name):
    return {
        "question": question,
        "policy": ["P01", "P16", "P86", "P89"],
        "expected": {
            "action": "answer",
            "meaning": {"source": "nibrs", "places": [place], "period": YEAR(year), "measures": [{"name": measure, "unit": unit}],
                        "filters": [], "groupings": groupings, "statistic": "count"},
            "values": {"status": "pending_build"},
            "statements": [f"Names the {agency_name} as the agency counted", UNKNOWN_LAST, SOURCE],
        },
    }


NEW = [
    # Jeff's question, both word orders.
    case("Aggravated assault victims in Nashville by sex and month in 2023", NASHVILLE, "aggravated assault", "victim", ["month", "victim sex"], 2023, "Metropolitan Nashville Police Department"),
    case("Aggravated assault victims in Nashville by month and sex in 2023", NASHVILLE, "aggravated assault", "victim", ["month", "victim sex"], 2023, "Metropolitan Nashville Police Department"),
    # Quarters, each the sum of its months, by an exclusive and a multi-valued breakdown.
    case("Aggravated assault victims in Nashville by sex by quarter in 2023", NASHVILLE, "aggravated assault", "victim", ["quarter", "victim sex"], 2023, "Metropolitan Nashville Police Department"),
    case("Robberies in Memphis by weapon by quarter in 2024", MEMPHIS, "robbery", "offense", ["quarter", "weapon"], 2024, "Memphis Police Department"),
    # Other breakdowns by month.
    case("Simple assault victims in Detroit by race and month in 2024", DETROIT, "simple assault", "victim", ["month", "victim race"], 2024, "Detroit Police Department"),
    case("Robbery offenders in Memphis by age and month in 2024", MEMPHIS, "robbery", "offender", ["month", "offender age"], 2024, "Memphis Police Department"),
]


def split_of(group):
    h = int(hashlib.sha256(group.encode()).hexdigest(), 16) % 10_000
    return "heldout" if h < HELDOUT_SHARE * 10_000 else "dev"


def main():
    reviewed_by = sys.argv[sys.argv.index("--reviewed-by") + 1] if "--reviewed-by" in sys.argv else None
    with open(CASES, encoding="utf-8") as f:
        data = json.load(f)
    cases = data["cases"]
    have = {(c["group"], c["question"]) for c in cases}
    n = max(int(c["id"][3:]) for c in cases)
    added = 0
    for c in NEW:
        if (GROUP, c["question"]) in have:
            continue
        n += 1
        added += 1
        cases.append({"id": f"LS-{n:03d}", "group": GROUP, "split": split_of(GROUP), "origin": {"kind": "designed", "ref": None},
                      "tab": "nibrs", "setup": [], "question": c["question"], "policy": c["policy"], "expected": c["expected"],
                      "label": {"status": "drafted", "drafted_by": DRAFTER, "reviewed_by": None, "notes": "Breakdowns by month or quarter (Jeff 2026-11-02)."}})
    if reviewed_by:
        for c in cases:
            if c["group"] == GROUP and c["label"]["status"] == "drafted":
                c["label"]["status"] = "reviewed"
                c["label"]["reviewed_by"] = reviewed_by
    with open(CASES, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"{added} added; {len(cases)} cases")


if __name__ == "__main__":
    main()
