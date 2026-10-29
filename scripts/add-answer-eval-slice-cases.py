#!/usr/bin/env python3
"""Adds the shadow slice's designed cases to scripts/fixtures/answer-eval/cases.json, with drafted labels.

    python scripts/add-answer-eval-slice-cases.py [--reviewed-by codex:slice-1]

The slice is single-agency NIBRS counts, 2017-2026 (what the plan compiler runs). These questions sit inside it and
just outside it: paraphrases, five agencies, month, year and total, offenses, incidents counted as offenses, person
crimes by victim, a missing place, period or crime, a city name in two states, a year outside the data, and near-scope
declines. Each label is written from the decided policy rows it cites (docs/policy/nibrsai-answer-policy.csv), never
from a candidate's output.

Cases are appended after every existing case, so no earlier id changes, and a case already present (same group and
question) is left alone. --reviewed-by marks still-drafted slice labels reviewed by that reviewer after their review.
Run scripts/test-answer-eval-cases.ts afterwards.
"""
import hashlib
import json
import os
import sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
CASES = os.path.join(ROOT, "scripts", "fixtures", "answer-eval", "cases.json")
HELDOUT_SHARE = 0.15  # as in build-answer-eval-seed.py: whole groups, by a hash of the group name
DRAFTER = "claude-slice"

AG = {
    "memphis": {"kind": "agency", "name": "Memphis Police Department", "state": "TN"},
    "baltimore": {"kind": "agency", "name": "Baltimore Police Department", "state": "MD"},
    "stl": {"kind": "agency", "name": "St. Louis Metropolitan Police Department", "state": "MO"},
    "detroit": {"kind": "agency", "name": "Detroit Police Department", "state": "MI"},
    "columbus": {"kind": "agency", "name": "Columbus Police Department", "state": "OH"},
    "kcmo": {"kind": "agency", "name": "Kansas City Police Department", "state": "MO"},
    "kcks": {"kind": "agency", "name": "Kansas City Police Department", "state": "KS"},
    "baltimore_county": {"kind": "agency", "name": "Baltimore County Police Department", "state": "MD"},
    "stl_county": {"kind": "agency", "name": "St. Louis County Police Department", "state": "MO"},
    "dc": {"kind": "agency", "name": "Washington Metropolitan Police Department", "state": "DC"},
    "washington_or": {"kind": "agency", "name": "Washington County Sheriff's Office", "state": "OR"},
    "washington_md": {"kind": "agency", "name": "Washington County Sheriff's Office", "state": "MD"},
    "columbus_ga": {"kind": "agency", "name": "Columbus Police Department", "state": "GA"},
    "nyc": {"kind": "agency", "name": "New York City Police Department", "state": "NY"},
}


def choose(about, *options):
    """A P28 place question: (label, meaning or None, next part asked when the meaning is None)."""
    return {"action": "clarify", "about": about, "options": [
        {"label": l, "leads_to": "answer", "meaning": m} if m else {"label": l, "leads_to": "clarify", "meaning": None, "next_about": nxt}
        for l, m, nxt in options]}


def year(y):
    return {"from": f"{y}-01", "to": f"{y}-12"}


def meaning(place, period, measures, groupings=(), source="nibrs", cohort=None):
    m = {"source": source, "places": [AG[place] if isinstance(place, str) else place], "period": period,
         "measures": [{"name": n, "unit": u} for n, u in measures], "filters": [], "groupings": list(groupings), "statistic": "count"}
    if cohort:
        m["cohort"] = cohort
    return m


def answer(m, *statements):
    return {"action": "answer", "meaning": m, "values": {"status": "pending_build"}, "statements": list(statements)}


def names(place):
    return f"names the agency ({AG[place]['name']})"


SOURCE_LAST = "names its source at the end"
MISSING = "names any months with no data as missing, not zero"
SHOP = [("shoplifting", "offense")]
CARJACK = [("carjacking", "offense")]
TFMV = [("theft from motor vehicle", "offense")]

memphis_shop_2024 = answer(meaning("memphis", year(2024), SHOP), names("memphis"), SOURCE_LAST)

# (group, question, policy rows, expected, notes)
SLICE = [
    ("slice-memphis-shop", "How many shoplifting offenses were there in Memphis in 2024?", ["D18", "D30", "P01", "P16"], memphis_shop_2024,
     "Shoplifting is a NIBRS-only detail (P01). Memphis means the city's principal police agency (P16). Property crime by offense (D18)."),
    ("slice-memphis-shop", "Memphis shoplifting 2024", ["D18", "D30", "P01", "P16"], memphis_shop_2024, "Paraphrase of the first case in its group."),
    ("slice-memphis-shop", "shoplifting in Memphis, TN in 2024", ["D18", "D30", "P01", "P16"], memphis_shop_2024, "Paraphrase, state named."),
    ("slice-victims", "How many shoplifting victims were there in Memphis in 2024?", ["D18", "D30", "P01", "P11", "P16"],
     answer(meaning("memphis", year(2024), SHOP), "Property crimes are counted by offense, not by victim.", names("memphis"), SOURCE_LAST),
     "P11: victims of a property crime -> offenses, with the fixed sentence."),
    ("slice-baltimore-month", "Shoplifting in Baltimore by month from 2022 to 2025", ["D04", "D18", "D30", "P01", "P16", "P22", "P28"],
     choose("which Baltimore",
            ("Baltimore city, Maryland", meaning("baltimore", {"from": "2022-01", "to": "2025-12"}, SHOP, ["month"]), None),
            ("Baltimore County, Maryland", meaning("baltimore_county", {"from": "2022-01", "to": "2025-12"}, SHOP, ["month"]), None)),
     "P28: Baltimore names a city and a county of 100,000+, so ask; each button keeps crime, months and grouping (P22). [superseded by P28]"),
    ("slice-stl-year", "Carjackings in St. Louis by year, 2021 to 2025", ["D04", "D18", "D30", "P01", "P16", "P22", "P28"],
     choose("which St. Louis",
            ("St. Louis city, Missouri", meaning("stl", {"from": "2021-01", "to": "2025-12"}, CARJACK, ["year"]), None),
            ("St. Louis County, Missouri", meaning("stl_county", {"from": "2021-01", "to": "2025-12"}, CARJACK, ["year"]), None)),
     "P28: St. Louis names a city and a county of 100,000+ (St. Louis County, Minnesota is under 100,000). Carjacking by offense (D18). [superseded by P28]"),
    ("slice-memphis-cj", "carjackings in Memphis TN by month in 2025", ["D18", "D30", "P01", "P16"],
     answer(meaning("memphis", year(2025), CARJACK, ["month"]), names("memphis"), MISSING, SOURCE_LAST), "Carjacking by offense (D18)."),
    ("slice-detroit-sa", "How many simple assaults were there in Detroit in 2023?", ["D18", "D30", "P01", "P09", "P16"],
     answer(meaning("detroit", year(2023), [("simple assault", "victim")]), names("detroit"), SOURCE_LAST),
     "Simple assault asked for by name (P09); a crime against persons, counted by victim (D18). NIBRS-only detail (P01)."),
    ("slice-detroit-sa-month", "simple assault victims in Detroit by month in 2023", ["D18", "D30", "P01", "P16"],
     answer(meaning("detroit", year(2023), [("simple assault", "victim")], ["month"]), names("detroit"), MISSING, SOURCE_LAST), "Person crime by victim (D18)."),
    ("slice-tfmv", "Thefts from motor vehicles in Columbus, Ohio in 2022", ["D18", "D30", "P01", "P16"],
     answer(meaning("columbus", year(2022), TFMV), names("columbus"), SOURCE_LAST),
     "Theft from a motor vehicle is a larceny subtype only NIBRS holds (P01); by offense (D18). The agency is the Columbus Division of Police."),
    ("slice-drug", "Drug crimes in Detroit in 2024", ["D18", "D19", "D30", "P01", "P16"],
     answer(meaning("detroit", year(2024), [("drug/narcotic violation", "offense"), ("drug equipment violation", "offense")]),
            "says drug crimes include drug/narcotic and drug equipment violations", names("detroit"), SOURCE_LAST),
     "D19: drug crimes are drug/narcotic plus drug equipment violations."),
    ("slice-ytd", "Shoplifting in Memphis so far this year", ["D06", "D18", "D30", "P01", "P16"],
     answer(meaning("memphis", {"rule": "year to date through the latest month"}, SHOP), "names the months covered", names("memphis"), SOURCE_LAST),
     "D06: year to date through the latest month, months named. Current Trends has no shoplifting, so NIBRS (P01)."),
    ("slice-kc", "Thefts from motor vehicles in Kansas City in 2024", ["D18", "D28", "P01", "P22"],
     {"action": "clarify", "about": "which Kansas City", "options": [
         {"label": "Kansas City, Missouri", "leads_to": "answer", "meaning": meaning("kcmo", year(2024), TFMV)},
         {"label": "Kansas City, Kansas", "leads_to": "answer", "meaning": meaning("kcks", year(2024), TFMV)}]},
     "Two cities of this name in two states, both large: materially different readings (D28). A button keeps crime and year (P22)."),
    ("slice-noplace", "How many shoplifting offenses were there in 2024?", ["D18", "D31", "P01", "P12", "P22"],
     {"action": "clarify", "about": "which place", "options": [
         {"label": "The United States", "leads_to": "answer", "meaning": meaning({"kind": "national", "name": "United States"}, year(2024), SHOP, cohort="all_reporting")},
         {"label": "A state", "leads_to": "clarify", "meaning": None, "next_about": "which state"},
         {"label": "A city or agency", "leads_to": "clarify", "meaning": None, "next_about": "which city or agency"}]},
     "P12/D31: ask for the missing place. Shoplifting stays on NIBRS (P01), counted from reporting agencies."),
    ("slice-noperiod", "Shoplifting in Memphis", ["D18", "D31", "P01", "P06", "P16", "P22"],
     {"action": "clarify", "about": "which period", "options": [
         {"label": "The latest complete year (2025)", "leads_to": "answer", "meaning": meaning("memphis", {"rule": "latest complete year"}, SHOP)},
         {"label": "This year so far", "leads_to": "answer", "meaning": meaning("memphis", {"rule": "year to date through the latest month"}, SHOP)},
         {"label": "Another year", "leads_to": "clarify", "meaning": None, "next_about": "which year"}]},
     "P06 single figure: the latest complete year, named (2025 for this release); this year so far; another year. NIBRS for both (P01: no shoplifting in Current Trends). Codex slice review 1: the year is named."),
    ("slice-noperiod-trend", "Carjackings in Memphis by month", ["D18", "D31", "P01", "P06", "P16", "P22"],
     {"action": "clarify", "about": "which range of years", "options": [
         {"label": "The last 10 complete years", "leads_to": "answer", "meaning": meaning("memphis", {"rule": "last 10 complete years"}, CARJACK, ["month"])},
         {"label": "Every year available", "leads_to": "answer", "meaning": meaning("memphis", {"rule": "every year in the data"}, CARJACK, ["month"])},
         {"label": "Another range", "leads_to": "clarify", "meaning": None, "next_about": "which range of years"}]},
     "P06 trend: last 10 complete years; every year available; another range. The month breakdown is kept (P22)."),
    ("slice-nocrime", "How many crimes were there in Detroit in 2024?", ["D09", "D18", "D31", "P01", "P16", "P22"],
     {"action": "clarify", "about": "which kind of crime", "options": [
         {"label": "Violent crime", "leads_to": "answer", "meaning": meaning("detroit", year(2024), [("violent crime", "victim (robbery by offense)")], source="historical")},
         {"label": "Property crime", "leads_to": "answer", "meaning": meaning("detroit", year(2024), [("property crime", "offense")], source="historical")},
         {"label": "Both", "leads_to": "answer", "meaning": meaning("detroit", year(2024), [("violent crime", "victim (robbery by offense)"), ("property crime", "offense")], source="historical")}]},
     "D09 bare 'crime': violent; property; both. Completed-year Part I counts go to Historical (P01), as LS-196."),
    ("slice-future", "Shoplifting in Memphis in 2027", ["D04", "P16", "P24"],
     {"action": "decline", "reason": "2027 is not in the data; the latest month available is the latest month NIBRS holds for 2026.",
      "alternative": meaning("memphis", {"rule": "year to date through the latest month"}, SHOP)},
     "P24: say the year is not in the data, name the latest month, offer the latest year available."),
    ("slice-early", "Shoplifting in Memphis in 2012", ["D04", "D18", "D30", "P01", "P16"],
     answer(meaning("memphis", year(2012), SHOP), names("memphis"), SOURCE_LAST),
     "NIBRS holds 2012 for Memphis in the full data. The shadow build starts in 2017, so it may only refuse this one as not built."),
    ("slice-zip", "Shoplifting in Memphis by ZIP code in 2024", ["D02"],
     {"action": "decline", "reason": "The data stops at the agency level; no source here has counts by ZIP code, neighborhood, ward, precinct or beat.", "alternative": None},
     "D02: say so and stop (as LS-141)."),
    ("slice-court", "How many shoplifting arrests in Memphis in 2024 led to convictions?", ["D01", "P16"],
     {"action": "decline", "reason": "Court outcomes such as convictions are not in the data; it records police arrests and clearances.",
      "alternative": meaning("memphis", year(2024), [("shoplifting", "arrest")])},
     "D01, as LS-201: offer the arrests."),
    ("slice-forecast", "Will carjackings go up in Memphis next year?", ["D18", "P16", "P20"],
     {"action": "decline", "reason": "The data records past crime and cannot predict next year.",
      "alternative": meaning("memphis", {"rule": "last 10 complete years"}, CARJACK, ["year"])},
     "P20: decline, offer the last 10 complete years for the same place and measure."),
    ("slice-arrests", "Shoplifting arrests in Memphis in 2024", ["D18", "D30", "P01", "P16"],
     answer(meaning("memphis", year(2024), [("shoplifting", "arrest")]), names("memphis"), SOURCE_LAST),
     "Arrests asked for by name: counted by arrest."),
    ("slice-place-baltimore", "Shoplifting in Baltimore in 2024", ["D18", "P01", "P22", "P28"],
     choose("which Baltimore",
            ("Baltimore city, Maryland", meaning("baltimore", year(2024), SHOP), None),
            ("Baltimore County, Maryland", meaning("baltimore_county", year(2024), SHOP), None)),
     "P28: a city and a county share the name, both 100,000+."),
    ("slice-place-washington", "Shoplifting in Washington in 2024", ["D18", "P01", "P22", "P28"],
     choose("which Washington",
            ("Washington, D.C.", meaning("dc", year(2024), SHOP), None),
            ("Washington state", meaning({"kind": "state", "name": "Washington", "state": "WA"}, year(2024), SHOP, cohort="all_reporting"), None),
            ("Washington County, Oregon", meaning("washington_or", year(2024), SHOP), None),
            ("Washington County, Maryland", meaning("washington_md", year(2024), SHOP), None)),
     "P28: the name is a state, so the state is always offered, beside D.C. and the Washington County agencies of 100,000+ (Oregon, Maryland). Shoplifting stays on NIBRS (P01)."),
    ("slice-place-columbus", "Shoplifting in Columbus in 2024", ["D18", "P01", "P22", "P28"],
     choose("which Columbus",
            ("Columbus, Ohio", meaning("columbus", year(2024), SHOP), None),
            ("Columbus, Georgia", meaning("columbus_ga", year(2024), SHOP), None)),
     "P28: two states have a Columbus of 100,000+."),
    ("slice-place-newyork", "Shoplifting in New York in 2024", ["D18", "P01", "P22", "P26", "P28"],
     choose("which New York",
            ("New York City", meaning("nyc", year(2024), SHOP), None),
            ("New York state", meaning({"kind": "state", "name": "New York", "state": "NY"}, year(2024), SHOP, cohort="all_reporting"), None)),
     "P26: New York alone asks city or state."),
]

# Replay labels P28 changes (reviewed before P28): drafted again, for review.
RELABEL = {
    "LS-151": (["P22", "P28"], choose("which Baltimore",
        ("Baltimore city, Maryland", meaning("baltimore", {"from": "2021-01", "to": "2025-12"}, SHOP, ["month"]), None),
        ("Baltimore County, Maryland", meaning("baltimore_county", {"from": "2021-01", "to": "2025-12"}, SHOP, ["month"]), None)),
        "P28 (Jeff 2026-10-29): Baltimore names a city and a county of 100,000+, so ask first; each button keeps crime, months and grouping."),
    "LS-140": (["P22", "P28"], choose("which St. Louis",
        ("St. Louis city, Missouri", None, "which range of years"),
        ("St. Louis County, Missouri", None, "which range of years")),
        "P28 (Jeff 2026-10-29): ask which St. Louis first; the years are asked next, one part at a time (D31)."),
}

args = sys.argv[1:]
reviewer = args[1] if args[:1] == ["--reviewed-by"] else None
data = json.load(open(CASES, encoding="utf-8"))
have = {(c["group"], c["question"]) for c in data["cases"]}
added = 0
for c in data["cases"]:
    if c["id"] in RELABEL and c["label"]["drafted_by"] != DRAFTER:
        add, exp, why = RELABEL[c["id"]]
        c["expected"], c["policy"] = exp, sorted(set(c["policy"]) | set(add))
        c["label"] = {"status": "drafted", "drafted_by": DRAFTER, "reviewed_by": None, "notes": f"{c['label']['notes']} [superseded by P28: {why}]"}
for g, q, pol, exp, notes in SLICE:
    group = f"designed:{g}"
    if (group, q) in have:
        old = next(c for c in data["cases"] if (c["group"], c["question"]) == (group, q))
        if old["label"]["drafted_by"] == DRAFTER and old["label"]["status"] == "drafted":
            old.update(policy=pol, expected=exp)
            old["label"]["notes"] = notes
        continue
    h = int(hashlib.sha256(group.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    data["cases"].append({
        "id": f"LS-{len(data['cases']) + 1:03d}", "group": group, "split": "heldout" if h < HELDOUT_SHARE else "dev",
        "origin": {"kind": "designed", "ref": None}, "tab": "nibrs", "setup": [], "question": q, "policy": pol, "expected": exp,
        "label": {"status": "drafted", "drafted_by": DRAFTER, "reviewed_by": None, "notes": notes}})
    added += 1
marked = 0
if reviewer:
    for c in data["cases"]:
        if c["label"]["drafted_by"] == DRAFTER and c["label"]["status"] == "drafted":
            c["label"].update(status="reviewed", reviewed_by=reviewer)
            marked += 1
with open(CASES, "w", encoding="utf-8", newline="\n") as f:
    json.dump(data, f, indent=1, ensure_ascii=False)
    f.write("\n")
print(f"added {added} slice cases; marked {marked} reviewed; {len(data['cases'])} cases")
