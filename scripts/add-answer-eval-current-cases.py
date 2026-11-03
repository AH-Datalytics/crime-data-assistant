#!/usr/bin/env python3
"""Adds the designed Current Trends cases (design note docs/superpowers/specs/2026-11-03-current-trends-design.md;
P90, P91; Jeff's decisions A-C) to cases.json, with drafted labels.

    python scripts/add-answer-eval-current-cases.py [--reviewed-by codex:current-labels-1]

Cases are appended after every existing case (same group and question: left alone). Each label is written from the
design note and the decided rows it cites, never from a candidate's output: a state, region or the nation is the sum of
its Consistent Reporting Agencies (P91), an unknown month is never zero, "so far this year" is the year to date through
Current Trends' latest month (2026-08), and NIBRS named in words is NIBRS (P01). Values are nibrs-model's V173-V176
(main 8bc9eca), named by file, group, size, month and column in values.source; the runner reads them
(lib/answer-eval/shadow.ts bindValueSources). Run scripts/test-answer-eval-cases.ts afterwards.
"""
import hashlib
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CASES = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "cases.json")
GROUP = "designed:current-trends"
DRAFTER = "claude-current"
HELDOUT_SHARE = 0.15

US = [{"kind": "national", "name": "United States"}]
STATES = {"TN": "Tennessee", "TX": "Texas", "AL": "Alabama"}
REGION = {"noe": "CT ME MA NH RI VT NJ NY PA".split(), "mdw": "IL IN MI OH WI IA KS MN MO NE ND SD".split()}
NAMES = {"CT": "Connecticut", "ME": "Maine", "MA": "Massachusetts", "NH": "New Hampshire", "RI": "Rhode Island", "VT": "Vermont", "NJ": "New Jersey",
         "NY": "New York", "PA": "Pennsylvania", "IL": "Illinois", "IN": "Indiana", "MI": "Michigan", "OH": "Ohio", "WI": "Wisconsin", "IA": "Iowa",
         "KS": "Kansas", "MN": "Minnesota", "MO": "Missouri", "NE": "Nebraska", "ND": "North Dakota", "SD": "South Dakota", **STATES}
MEMPHIS = {"kind": "agency", "name": "Memphis Police Department", "state": "TN"}
UNIT = {"murder": "victim", "rape": "victim", "robbery": "offense", "aggravated assault": "victim", "violent crime": "victim (robbery by offense)", "property crime": "offense"}
COHORT = "names the Consistent Reporting Agencies it counts and the people they cover"
SOURCE = "names its source at the end"


def state(code):
    return [{"kind": "state", "name": NAMES[code], "state": code}]


def group_case(question, places, measure, frm, to, value_file, group, column, groupings, statements=()):
    return {
        "question": question,
        "policy": ["P01", "P90", "P91", "D04"],
        "expected": {
            "action": "answer",
            "meaning": {"source": "rtci", "places": places, "period": {"from": frm, "to": to}, "measures": [{"name": measure, "unit": UNIT[measure]}],
                        "filters": [], "groupings": groupings, "statistic": "count", "cohort": "same_agencies",
                        **({"combine": "combined"} if len(places) > 1 else {})},  # a region: its states as one total
            "values": {"status": "verified", "source": f"nibrs-model {value_file} {group} all {to} {column}"},
            "statements": [COHORT, *statements, SOURCE],
        },
    }


def agency_case(question, source, frm, to, groupings, policy):
    return {
        "question": question,
        "policy": policy,
        "expected": {
            "action": "answer",
            "meaning": {"source": source, "places": [MEMPHIS], "period": {"from": frm, "to": to}, "measures": [{"name": "murder", "unit": "victim"}],
                        "filters": [], "groupings": groupings, "statistic": "count"},
            "values": {"status": "pending_build"},
            "statements": ["names the agency (Memphis Police Department)", SOURCE],
        },
    }


NEW = [
    # The nation, a month (V173): the consistent sum, and a total that leaves agencies out names them.
    group_case("Murders in the United States in August 2026", US, "murder", "2026-08", "2026-08", "V173", "us", "murder_total", ["month"]),
    group_case("Rapes in the United States in August 2026", US, "rape", "2026-08", "2026-08", "V173", "us", "rape_total", ["month"],
               ["names the agencies with no figure, left out of the total (14 of 547)"]),
    # The year to date (V173's murder_ytd): "so far this year" is January through Current Trends' latest month.
    group_case("Murders in the United States so far this year", US, "murder", "2026-01", "2026-08", "V173", "us", "murder_ytd", []),
    # Census regions (V174).
    group_case("Robberies in the Northeast in August 2026", [p for c in REGION["noe"] for p in state(c)], "robbery", "2026-08", "2026-08", "V174", "noe", "robbery_total", ["month"]),
    group_case("Murders in the Midwest in August 2026", [p for c in REGION["mdw"] for p in state(c)], "murder", "2026-08", "2026-08", "V174", "mdw", "murder_total", ["month"]),
    # States (V175), including one whose every agency is blank: unknown, never zero.
    group_case("Violent crime in Tennessee in August 2026", state("TN"), "violent crime", "2026-08", "2026-08", "V175", "tn", "violent_total", ["month"]),
    group_case("Property crime in Texas in August 2026", state("TX"), "property crime", "2026-08", "2026-08", "V175", "tx", "property_total", ["month"]),
    group_case("Rapes in Alabama in August 2026", state("AL"), "rape", "2026-08", "2026-08", "V175", "al", "rape_total", ["month"],
               ["says no figure is known for August 2026 (never zero)"]),
    # Routing (design note section 4): a Part I crime by month at a Current Trends agency is Current Trends'; NIBRS named
    # in words is NIBRS (P01).
    agency_case("Memphis murders by month in 2025", "rtci", "2025-01", "2025-12", ["month"], ["P01", "D04"]),
    agency_case("Memphis murders by month in 2025 according to NIBRS", "nibrs", "2025-01", "2025-12", ["month"], ["P01"]),
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
                      "tab": "current", "setup": [], "question": c["question"], "policy": c["policy"], "expected": c["expected"],
                      "label": {"status": "drafted", "drafted_by": DRAFTER, "reviewed_by": None, "notes": "Current Trends in the new engine (design note 2026-11-03)."}})
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
