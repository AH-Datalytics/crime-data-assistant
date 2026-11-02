#!/usr/bin/env python3
"""Adds the designed cases for everyday period words in Crime Index questions (Jeff 2026-11-02: "Memphis murders since
1930" declined; the Historical tab's real first questions, query-log step one) to cases.json, with drafted labels.

    python scripts/add-answer-eval-period-cases.py [--reviewed-by codex:period-labels-1]

Cases are appended after every existing case (same group and question: left alone). Each label is written from the
decided rows it cites, never from a candidate's output: a series starts at the place's first year with a figure in the
Crime Index build (Memphis murders: 1932), "since YEAR" runs through the latest complete year (2025), a decade is its
ten years, "the past 10 years" ends at the latest complete year. Run scripts/test-answer-eval-cases.ts afterwards.
"""
import hashlib
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CASES = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "cases.json")
GROUP = "designed:period-phrasings"
DRAFTER = "claude-period"
HELDOUT_SHARE = 0.15

MEMPHIS = {"kind": "agency", "name": "Memphis Police Department", "state": "TN"}
PHILADELPHIA = {"kind": "agency", "name": "Philadelphia Police Department", "state": "PA"}
CHICAGO = {"kind": "agency", "name": "Chicago Police Department", "state": "IL"}
TENNESSEE = {"kind": "state", "name": "Tennessee", "state": "TN"}
SOURCE = "names its source at the end"


def case(question, place, measure, unit, start, end):
    statements = ([f"names the agency ({place['name']})"] if place["kind"] == "agency" else []) + [SOURCE]
    return {
        "question": question,
        "policy": ["D04", "P01", "P75"],
        "expected": {
            "action": "answer",
            "meaning": {"source": "historical", "places": [place], "period": {"from": f"{start}-01", "to": f"{end}-12"},
                        "measures": [{"name": measure, "unit": unit}], "filters": [], "groupings": ["year"], "statistic": "count"},
            "values": {"status": "pending_build"},
            "statements": statements,
        },
    }


NEW = [
    # Jeff's question and its kin: the series from the first year with a figure (Memphis murders: 1932) to 2025.
    case("Memphis murders since 1930", MEMPHIS, "murder", "victim", 1932, 2025),
    case("Memphis homicides by year", MEMPHIS, "murder", "victim", 1932, 2025),
    case("Memphis murders over time", MEMPHIS, "murder", "victim", 1932, 2025),
    case("Memphis robberies since 1990", MEMPHIS, "robbery", "offense", 1990, 2025),
    # A decade, the past N years, "after YEAR".
    case("Philadelphia murders in the 90s", PHILADELPHIA, "murder", "victim", 1990, 1999),
    case("Philadelphia murders over the past 10 years", PHILADELPHIA, "murder", "victim", 2016, 2025),
    case("Chicago robberies after 2010", CHICAGO, "robbery", "offense", 2010, 2025),
    # A state's figures (the historical file), the same words.
    case("Tennessee robberies since 2000", TENNESSEE, "robbery", "offense", 2000, 2025),
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
                      "tab": "historical", "setup": [], "question": c["question"], "policy": c["policy"], "expected": c["expected"],
                      "label": {"status": "drafted", "drafted_by": DRAFTER, "reviewed_by": None, "notes": "Everyday period words in Crime Index questions (Jeff 2026-11-02)."}})
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
