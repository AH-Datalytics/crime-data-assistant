#!/usr/bin/env python3
"""Adds the designed cases for a state or national NIBRS sum by one category (coordinator 2026-11-04) to cases.json,
with drafted labels.

    python scripts/add-answer-eval-statecat-cases.py [--reviewed-by codex:statecat-labels-1]

Cases are appended after every existing case (same group and question: left alone). Each label is written from the
decided rows it cites, never from a candidate's output: a state's or the nation's sum is over the agencies that reported
(P61), its button's view the Consistent Reporting Agencies (P80), each category summed over the reported months of the
agencies counted; "by" names offenders and "against" victims (P29). Values come from nibrs-model (pending_build until
its files name these cases). Run scripts/test-answer-eval-cases.ts afterwards.
"""
import hashlib
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CASES = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "cases.json")
GROUP = "designed:category-state"
DRAFTER = "claude-statecat"
HELDOUT_SHARE = 0.15

TN = [{"kind": "state", "name": "Tennessee", "state": "TN"}]
TX = [{"kind": "state", "name": "Texas", "state": "TX"}]
US = [{"kind": "national", "name": "United States"}]
SOURCE = "names its source at the end"
COUNTED = "names how many agencies it sums over"


def case(question, places, measure, unit, frm, to, groupings, cohort="all_reporting", statements=(), filters=()):
    return {
        "question": question,
        "policy": ["P29", "P53", "P61", "P80"],
        "expected": {
            "action": "answer",
            "meaning": {"source": "nibrs", "places": places, "period": {"from": frm, "to": to}, "measures": [{"name": measure, "unit": unit}],
                        "filters": list(filters), "groupings": groupings, "statistic": "count", "cohort": cohort},
            "values": {"status": "pending_build"},
            "statements": [*statements, SOURCE],
        },
    }


NEW = [
    case("Simple assault victims in Tennessee by sex in 2024", TN, "simple assault", "victim", "2024-01", "2024-12", ["victim sex"], statements=[COUNTED]),
    case("Murder victims in the United States by race in 2024", US, "murder", "victim", "2024-01", "2024-12", ["victim race"], statements=[COUNTED]),
    case("Robbery offenders in Tennessee by race in 2024", TN, "robbery", "offender", "2024-01", "2024-12", ["offender race"], statements=[COUNTED]),
    case("Robbery arrests in Tennessee by age in 2024", TN, "robbery", "arrest", "2024-01", "2024-12", ["arrestee age"], statements=[COUNTED]),
    case("Aggravated assault offenses in Texas by location type in 2024", TX, "aggravated assault", "offense", "2024-01", "2024-12", ["location type"], statements=[COUNTED]),
    case("Simple assault victims in Tennessee by sex by year from 2023 to 2024", TN, "simple assault", "victim", "2023-01", "2024-12", ["year", "victim sex"]),
    # The button's view, asked in words (P80): the agencies that reported every month of the period.
    case("Murder victims in the United States by race in 2024, only agencies that reported every month", US, "murder", "victim", "2024-01", "2024-12", ["victim race"],
         cohort="same_agencies", statements=["names the Consistent Reporting Agencies it counts"], filters=["agencies that reported every month of 2024"]),
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
                      "label": {"status": "drafted", "drafted_by": DRAFTER, "reviewed_by": None, "notes": "A state or national NIBRS sum by one category (coordinator 2026-11-04)."}})
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
