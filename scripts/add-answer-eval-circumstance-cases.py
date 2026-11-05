#!/usr/bin/env python3
"""Adds the designed cases for NIBRS data element 31, a victim's aggravated assault/homicide circumstances (coordinator
2026-11-04), to cases.json, with drafted labels.

    python scripts/add-answer-eval-circumstance-cases.py [--reviewed-by codex:circumstance-labels-1]

Cases are appended after every existing case (same group and question: left alone). Each label is written from the
decided rows it cites, never from a candidate's output: circumstances are a victim's, up to two (each victim counted once
under each, categories overlapping), for murder and aggravated assault victims (D18); a circumstance named is a filter
on the victims, said in the answer with the note that agencies often record it as unknown; murder by a Homicide Report
detail for a state is Homicide Reports' (P53); another crime is declined. Values come from nibrs-model (pending_build
until its files name these cases). Run scripts/test-answer-eval-cases.ts afterwards.
"""
import hashlib
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CASES = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "cases.json")
GROUP = "designed:category-circumstance"
DRAFTER = "claude-circumstance"
HELDOUT_SHARE = 0.15

MEMPHIS = [{"kind": "agency", "name": "Memphis Police Department", "state": "TN"}]
TN = [{"kind": "state", "name": "Tennessee", "state": "TN"}]
Y24 = {"from": "2024-01", "to": "2024-12"}
OVERLAP = "says a unit with several categories counts once in each, so the categories can add up to more than the total"
UNKNOWN = "says agencies often record the circumstance as unknown, so the count can be lower"
SOURCE = "names its source at the end"


def answer(question, places, measure, filters, groupings, statements, policy=("D18", "P01")):
    return {"question": question, "policy": list(policy), "expected": {"action": "answer",
            "meaning": {"source": "nibrs", "places": places, "period": Y24, "measures": [{"name": measure, "unit": "victim"}], "filters": filters,
                        "groupings": groupings, "statistic": "count"},
            "values": {"status": "pending_build"}, "statements": [*statements, SOURCE]}}


NEW = [
    answer("Murder victims in Memphis by circumstance in 2024", MEMPHIS, "murder", [], ["circumstance"], ["names the agency (Memphis Police Department)", OVERLAP]),
    answer("Aggravated assault victims in Tennessee by circumstance in 2024", TN, "aggravated assault", [], ["circumstance"], ["names how many agencies it sums over", OVERLAP],
           policy=("D18", "P53", "P61")),
    answer("Gang-related murders in Memphis in 2024", MEMPHIS, "murder", ["circumstance: gangland (organized crime involvement) or juvenile gang"], [],
           ["names the agency (Memphis Police Department)", UNKNOWN]),
    answer("Aggravated assault victims in Memphis from arguments in 2024", MEMPHIS, "aggravated assault", ["circumstance: argument"], [],
           ["names the agency (Memphis Police Department)", UNKNOWN]),
    # P53: a state's murders by a Homicide Report detail are Homicide Reports' (a route until it is built).
    {"question": "Gang-related murders in Tennessee in 2024", "policy": ["P01", "P53"], "expected": {"action": "answer",
     "meaning": {"source": "shr", "places": TN, "period": Y24, "measures": [{"name": "murder", "unit": "victim"}],
                 "filters": ["circumstance: gangland (organized crime involvement) or juvenile gang"], "groupings": [], "statistic": "count"},
     "values": {"status": "pending_build"}, "statements": []}},
    # Circumstances are recorded for murder and aggravated assault victims only (here): another crime is declined.
    {"question": "Gang-related robberies in Memphis in 2024", "policy": ["D18"], "expected": {"action": "decline",
     "reason": "Circumstances (element 31) are recorded for murder and aggravated assault victims, not robberies.", "alternative": None}},
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
                      "label": {"status": "drafted", "drafted_by": DRAFTER, "reviewed_by": None, "notes": "NIBRS data element 31, victims' circumstances (coordinator 2026-11-04)."}})
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
