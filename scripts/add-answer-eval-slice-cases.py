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
    "nashville": {"kind": "agency", "name": "Metropolitan Nashville Police Department", "state": "TN"},
    "denver": {"kind": "agency", "name": "Denver Police Department", "state": "CO"},
    "portland": {"kind": "agency", "name": "Portland Police Bureau", "state": "OR"},
    "atlanta": {"kind": "agency", "name": "Atlanta Police Department", "state": "GA"},
    "milwaukee": {"kind": "agency", "name": "Milwaukee Police Department", "state": "WI"},
    "albuquerque": {"kind": "agency", "name": "Albuquerque Police Department", "state": "NM"},
    "louisville": {"kind": "agency", "name": "Louisville Metro Police Department", "state": "KY"},
    "tucson": {"kind": "agency", "name": "Tucson Police Department", "state": "AZ"},
    "austin": {"kind": "agency", "name": "Austin Police Department", "state": "TX"},
    "okc": {"kind": "agency", "name": "Oklahoma City Police Department", "state": "OK"},
    "cosprings": {"kind": "agency", "name": "Colorado Springs Police Department", "state": "CO"},
    "fortworth": {"kind": "agency", "name": "Fort Worth Police Department", "state": "TX"},
    "wichita": {"kind": "agency", "name": "Wichita Police Department", "state": "KS"},
    "raleigh": {"kind": "agency", "name": "Raleigh Police Department", "state": "NC"},
    "vabeach": {"kind": "agency", "name": "Virginia Beach Police Department", "state": "VA"},
    "mesa": {"kind": "agency", "name": "Mesa Police Department", "state": "AZ"},
    "minneapolis": {"kind": "agency", "name": "Minneapolis Police Department", "state": "MN"},
    "aurora": {"kind": "agency", "name": "Aurora Police Department", "state": "CO"},
    "dallas": {"kind": "agency", "name": "Dallas Police Department", "state": "TX"},
    "charlotte": {"kind": "agency", "name": "Charlotte-Mecklenburg Police Department", "state": "NC"},
    "frisco": {"kind": "agency", "name": "Frisco Police Department", "state": "TX"},
    "greensboro": {"kind": "agency", "name": "Greensboro Police Department", "state": "NC"},
    "seattle": {"kind": "agency", "name": "Seattle Police Department", "state": "WA"},
    "arlington": {"kind": "agency", "name": "Arlington Police Department", "state": "TX"},
    "tulsa": {"kind": "agency", "name": "Tulsa Police Department", "state": "OK"},
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
     "P28: St. Louis names a city and a county of 100,000+ (the St. Louis County, Minnesota sheriff serves under 100,000). Carjacking by offense (D18). [superseded by P28]"),
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

# The reader round's fresh cases (2026-10-29): new wordings, crimes and places, written and labeled from policy BEFORE
# the reader changes ran, and held out as a whole: the reader is never tuned on them. Each new reading has boundary
# cases that must still decline, ask, or keep their own meaning.
READER_DRAFTER = "claude-reader"
SA = [("simple assault", "victim")]
YTD = {"rule": "year to date through the latest month"}
LAST10 = {"rule": "last 10 complete years"}
FORECAST = "The data records past crime and cannot predict next year."
COURT = "Court outcomes such as convictions are not in the data; it records police arrests and clearances."
MONTHS = "names the months covered"
READER = [
    ("reader-spell-shop", "Shopliftng in Nashville in 2024", ["D18", "D30", "P01", "P16"],
     answer(meaning("nashville", year(2024), SHOP), names("nashville"), SOURCE_LAST), "A misspelled crime with one near word: read as shoplifting."),
    ("reader-spell-sa", "How many simple asaults were there in Denver in 2023?", ["D18", "D30", "P01", "P09", "P16"],
     answer(meaning("denver", year(2023), SA), names("denver"), SOURCE_LAST), "Misspelled 'assaults'; simple assault named, a person crime by victim (D18)."),
    ("reader-spell-cj", "carjackngs in Atlanta by month in 2024", ["D04", "D18", "D30", "P01", "P16"],
     answer(meaning("atlanta", year(2024), CARJACK, ["month"]), names("atlanta"), MISSING, SOURCE_LAST), "Misspelled carjackings; by offense (D18)."),
    ("reader-spell-state", "Shoplifting in Nashville, Tennesee in 2024", ["D18", "D30", "P01", "P16"],
     answer(meaning("nashville", year(2024), SHOP), names("nashville"), SOURCE_LAST), "A misspelled state, one near state."),
    ("reader-phrase-cars", "Thefts from cars in Portland, Oregon in 2023", ["D18", "D30", "P01", "P16"],
     answer(meaning("portland", year(2023), TFMV), names("portland"), SOURCE_LAST), "Theft from a motor vehicle, plural and 'cars'; a NIBRS-only larceny subtype (P01)."),
    ("reader-phrase-autos", "How many thefts from automobiles were there in Atlanta in 2023?", ["D18", "D30", "P01", "P16"],
     answer(meaning("atlanta", year(2023), TFMV), names("atlanta"), SOURCE_LAST), "Theft from a motor vehicle, 'automobiles'."),
    ("reader-phrase-breakins", "Vehicle break-ins in Nashville in 2022", ["D18", "D30", "P01", "P16"],
     answer(meaning("nashville", year(2022), TFMV), names("nashville"), SOURCE_LAST), "A vehicle break-in is theft from a motor vehicle, not burglary."),
    ("reader-phrase-control", "theft from a motor vehicle in Denver in 2024", ["D18", "D30", "P01", "P16"],
     answer(meaning("denver", year(2024), TFMV), names("denver"), SOURCE_LAST), "Control: a wording the reader already reads."),
    ("reader-ytd-denver", "Shoplifting in Denver year to date", ["D06", "D18", "D30", "P01", "P16"],
     answer(meaning("denver", YTD, SHOP), MONTHS, names("denver"), SOURCE_LAST), "D06: year to date, the months covered named."),
    ("reader-ytd-atlanta", "How much shoplifting has Atlanta had this year?", ["D06", "D18", "D30", "P01", "P16"],
     answer(meaning("atlanta", YTD, SHOP), MONTHS, names("atlanta"), SOURCE_LAST), "'This year': the current year so far (D06)."),
    ("reader-ytd-nashville", "Carjackings in Nashville so far in 2026", ["D06", "D18", "D30", "P01", "P16"],
     answer(meaning("nashville", YTD, CARJACK), MONTHS, names("nashville"), SOURCE_LAST), "'So far in 2026' (the current year): through the latest month (D06)."),
    ("reader-ytd-portland", "Simple assaults in Portland, Oregon this year so far", ["D06", "D18", "D30", "P01", "P16"],
     answer(meaning("portland", YTD, SA), MONTHS, names("portland"), SOURCE_LAST), "D06; simple assault by victim (D18)."),
    ("reader-month-portland", "Monthly simple assault victims in Portland, Oregon for 2022", ["D04", "D18", "D30", "P01", "P16"],
     answer(meaning("portland", year(2022), SA, ["month"]), names("portland"), MISSING, SOURCE_LAST), "'Monthly' is a month grouping."),
    ("reader-victims-cj", "carjacking victims in Nashville in 2023", ["D18", "D30", "P01", "P11", "P16"],
     answer(meaning("nashville", year(2023), CARJACK), "Property crimes are counted by offense, not by victim.", names("nashville"), SOURCE_LAST),
     "P11: carjacking is robbery-based, a property crime: offenses, with the sentence."),
    ("reader-forecast-denver", "Will shoplifting rise in Denver next year?", ["D18", "P16", "P20"],
     {"action": "decline", "reason": FORECAST, "alternative": meaning("denver", LAST10, SHOP, ["year"])}, "P20."),
    ("reader-forecast-atlanta", "Can you forecast carjackings in Atlanta for 2027?", ["D18", "P16", "P20"],
     {"action": "decline", "reason": FORECAST, "alternative": meaning("atlanta", LAST10, CARJACK, ["year"])}, "P20: a forecast, not merely a year after the data."),
    ("reader-forecast-portland", "Predict simple assaults in Portland, Oregon next year", ["D18", "P16", "P20"],
     {"action": "decline", "reason": FORECAST, "alternative": meaning("portland", LAST10, SA, ["year"])}, "P20."),
    ("reader-forecast-nashville", "What will carjackings be in Nashville in 2027?", ["D18", "P16", "P20"],
     {"action": "decline", "reason": FORECAST, "alternative": meaning("nashville", LAST10, CARJACK, ["year"])}, "P20: 'what will ... be' asks for a prediction."),
    ("reader-court-denver", "How many simple assault arrests in Denver in 2023 resulted in a conviction?", ["D01", "P16"],
     {"action": "decline", "reason": COURT, "alternative": meaning("denver", year(2023), [("simple assault", "arrest")])}, "D01, as LS-201."),
    ("reader-court-nashville", "How many shoplifting cases in Nashville went to trial in 2024?", ["D01", "P16"],
     {"action": "decline", "reason": COURT, "alternative": meaning("nashville", year(2024), [("shoplifting", "arrest")])}, "D01: trials are court outcomes; offer the arrests."),
    # Boundaries: these must not be read as the new readings above.
    ("reader-b-mvt", "Motor vehicle thefts in Denver in 2023", ["D18", "P01", "P16"],
     answer(meaning("denver", year(2023), [("motor vehicle theft", "offense")], source="historical"), names("denver"), SOURCE_LAST),
     "Boundary: motor vehicle theft is not theft from a motor vehicle. A completed-year Part I count: Historical (P01)."),
    ("reader-b-shootings", "Shootings in Nashville in 2024", ["D14", "D18", "D28", "P01", "P10", "P16", "P22"],
     {"action": "clarify", "about": "fatal or non-fatal shootings", "options": [
         {"label": "Fatal shootings", "leads_to": "answer", "meaning": dict(meaning("nashville", year(2024), [("murder", "victim")], source="shr"), filters=["weapon: firearm"])},
         {"label": "Aggravated assaults with a firearm (includes people not hit)", "leads_to": "answer", "meaning": dict(meaning("nashville", year(2024), [("aggravated assault", "victim")]), filters=["weapon: firearm"])}]},
     "Boundary: 'shootings' is a real word, never corrected toward shoplifting; D14 asks, as LS-202."),
    ("reader-b-ytd-compare", "Is shoplifting in Denver up this year compared with last year?", ["D06", "D18", "D30", "P01", "P16"],
     {"action": "answer", "meaning": dict(meaning("denver", {"rule": "2025 through the latest month in the data"}, SHOP, ["year"]), statistic="change",
                                          filters=["the same months of each year: January through the latest month"]),
      "values": {"status": "pending_build"}, "statements": ["names the months compared", "compares the same months of each year", names("denver"), SOURCE_LAST]},
     "Boundary: a partial year against last year compares the same months (D06; as LS-055), never ten months with twelve. [P52 (Jeff 2026-10-29): the period ends at the latest reported month, a rule, not a fixed month]"),
    ("reader-b-will-past", "How many shoplifting offenses will Denver's 2024 numbers show?", ["D18", "D30", "P01", "P16"],
     answer(meaning("denver", year(2024), SHOP), names("denver"), SOURCE_LAST), "Boundary: 'will' about a past year is not a forecast."),
    ("reader-b-nonword", "Shplftg in Nashville in 2024", ["D09", "D18", "D31", "P01", "P16", "P22"],
     {"action": "clarify", "about": "which kind of crime", "options": [
         {"label": "Violent crime", "leads_to": "answer", "meaning": meaning("nashville", year(2024), [("violent crime", "victim (robbery by offense)")], source="historical")},
         {"label": "Property crime", "leads_to": "answer", "meaning": meaning("nashville", year(2024), [("property crime", "offense")], source="historical")},
         {"label": "Both", "leads_to": "answer", "meaning": meaning("nashville", year(2024), [("violent crime", "victim (robbery by offense)"), ("property crime", "offense")], source="historical")}]},
     "Boundary: a word near no crime is not guessed; the crime is missing, so ask (D31/D09), as LS-235."),
]

# Compiler increment 1 (2026-10-29): breakdowns the compiler already computes (victim race, sex, ethnicity; offense
# location type), delivered as category tables. Fresh, held out, labeled from policy before the delivery change runs.
# MUST ANSWER: the person-crime victim breakdowns and the location-type breakdowns below. MUST STILL REFUSE until
# increment 2: age groups, weapons, two-way breakdowns (they are boundaries here, labeled with their correct answer).
BREAKDOWN_DRAFTER = "claude-breakdown"
AA = [("aggravated assault", "victim")]
MURDER = [("murder", "victim")]
CATS = "shows unknown and not-recorded categories as their own rows, never dropped"
BREAKDOWN = [
    ("breakdown-race-sa", "Simple assault victims in Milwaukee by race in 2024", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("milwaukee", year(2024), SA, ["victim race"]), names("milwaukee"), CATS, SOURCE_LAST), "MUST ANSWER: person-crime victims by race (D18), NIBRS detail (P01)."),
    ("breakdown-sex-aa", "Breakdown of aggravated assault victims by sex in Albuquerque for 2022", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("albuquerque", year(2022), AA, ["victim sex"]), names("albuquerque"), CATS, SOURCE_LAST), "MUST ANSWER: a Part I crime's victim detail is NIBRS's (P01)."),
    ("breakdown-eth-sa", "Simple assault victims in Louisville by ethnicity, 2024", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("louisville", year(2024), SA, ["victim ethnicity"]), names("louisville"), CATS, SOURCE_LAST), "MUST ANSWER: by ethnicity. Louisville is Louisville Metro (KY)."),
    ("breakdown-loc-shop", "Shoplifting in Tucson by location type in 2024", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("tucson", year(2024), SHOP, ["location type"]), names("tucson"), CATS, SOURCE_LAST), "MUST ANSWER: offenses by location type (one location per offense)."),
    ("breakdown-loc-tfmv", "Theft from motor vehicle offenses in Austin by location in 2023", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("austin", year(2023), TFMV, ["location type"]), names("austin"), CATS, SOURCE_LAST), "MUST ANSWER: 'by location' is location type."),
    ("breakdown-race-murder", "Murder victims in Kansas City, Missouri by race in 2023", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("kcmo", year(2023), MURDER, ["victim race"]), names("kcmo"), CATS, SOURCE_LAST), "MUST ANSWER: murder victims by race, a NIBRS detail (P01)."),
    ("breakdown-race-span", "simple assault victims by race in Albuquerque from 2021 to 2023", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("albuquerque", {"from": "2021-01", "to": "2023-12"}, SA, ["victim race"]), names("albuquerque"), CATS, SOURCE_LAST), "MUST ANSWER: one total over three years, by race."),
    ("breakdown-sex-murder", "How many murder victims in Austin were male or female in 2023?", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("austin", year(2023), MURDER, ["victim sex"]), names("austin"), CATS, SOURCE_LAST), "MUST ANSWER if read: 'male or female' asks for the sex breakdown."),
    ("breakdown-year-race", "Aggravated assault victims in Albuquerque by race and year, 2021 to 2023", ["D04", "D18", "D29", "D30", "P01", "P16"],
     answer(meaning("albuquerque", {"from": "2021-01", "to": "2023-12"}, AA, ["year", "victim race"]), names("albuquerque"), CATS, MISSING, SOURCE_LAST), "A breakdown per year, if the reader reads it."),
    # Boundaries: correct answers that increment 1 must still refuse (increment 2), never answer wrongly.
    ("breakdown-b-age", "Simple assault victims in Milwaukee by age in 2024", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("milwaukee", year(2024), SA, ["victim age"]), names("milwaukee"), CATS, SOURCE_LAST), "BOUNDARY: age groups are increment 2."),
    ("breakdown-b-weapon", "Robberies in Albuquerque by weapon in 2023", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("albuquerque", year(2023), [("robbery", "offense")], ["weapon"]), names("albuquerque"), CATS, SOURCE_LAST), "BOUNDARY: weapons are multi-value, increment 2."),
    ("breakdown-b-twoway", "Simple assault victims in Louisville by race and sex in 2024", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("louisville", year(2024), SA, ["victim race", "victim sex"]), names("louisville"), CATS, SOURCE_LAST), "BOUNDARY: a two-way breakdown."),
    ("breakdown-b-carjack-loc", "Carjackings in Kansas City, Missouri by location type in 2024", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("kcmo", year(2024), CARJACK, ["location type"]), names("kcmo"), CATS, SOURCE_LAST), "BOUNDARY: carjacking offenses (D18) by location; an incident-level reading is multi-value."),
]

# Compiler increment 2 (2026-10-29): several measures, multi-value and relationship breakdowns, age groups, offender
# breakdowns (P29, P49), weapon filters (P31), the composite gun crime (P31), arrests by arrest date (P46, P50). Fresh,
# held out, labeled from policy before the build. MUST ANSWER unless marked; boundaries must decline or ask.
INC2_DRAFTER = "claude-inc2"
DRUG = [("drug/narcotic violation", "offense"), ("drug equipment violation", "offense")]
OVERLAP = "says a unit with several categories counts once in each, so the categories can add up to more than the total"
ARREST_ONCE = "says each arrest counts once and NIBRS cannot tell when one person was arrested twice"
INC2 = [
    ("inc2-two-measures", "Shoplifting and theft from motor vehicle offenses in Oklahoma City in 2024", ["D18", "D30", "P01", "P16"],
     answer(meaning("okc", year(2024), SHOP + TFMV), names("okc"), SOURCE_LAST), "MUST ANSWER: two measures side by side, each with its own status (D6)."),
    ("inc2-drug", "Drug crimes in Wichita in 2023", ["D18", "D19", "D30", "P01", "P16"],
     answer(meaning("wichita", year(2023), DRUG), "says drug crimes include drug/narcotic and drug equipment violations",
            "gives the combined drug-crimes total (drug/narcotic plus drug equipment offenses)", names("wichita"), SOURCE_LAST),
     "MUST ANSWER: D19, the combined total; the two parts may accompany it (Codex label check)."),
    ("inc2-two-measures-month", "Carjackings and shoplifting in Raleigh by month in 2024", ["D04", "D18", "D30", "P01", "P16"],
     answer(meaning("raleigh", year(2024), CARJACK + SHOP, ["month"]), names("raleigh"), MISSING, SOURCE_LAST), "MUST ANSWER: two measures by month."),
    ("inc2-weapon", "Robberies in Fort Worth by weapon in 2023", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("fortworth", year(2023), [("robbery", "offense")], ["weapon"]), names("fortworth"), CATS, OVERLAP, SOURCE_LAST),
     "MUST ANSWER: weapons are multi-valued per offense."),
    ("inc2-age", "Aggravated assault victims in Mesa by age in 2024", ["D18", "D29", "D30", "P01", "P16", "P30"],
     answer(meaning("mesa", year(2024), AA, ["victim age"]), "groups ages as Under 18 (01-17 and infants NN, NB, BB), 18-24, 25-34, 35-44, 45-54, 55-64, 65+ (65-99), Unknown (00) and Not recorded (blank)",
            names("mesa"), CATS, SOURCE_LAST),
     "MUST ANSWER: victim age groups with infants in Under 18 (P30); 00 unknown, 99 'over 98' in 65+ (Jeff confirmed 00 is unknown)."),
    ("inc2-relationship", "Murder victims in Colorado Springs by relationship to the offender in 2023", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("cosprings", year(2023), MURDER, ["relationship"]), names("cosprings"), CATS, OVERLAP, SOURCE_LAST),
     "MUST ANSWER: a victim with several offenders can have several relationships."),
    ("inc2-strangers", "Murders by strangers in Virginia Beach in 2024", ["D18", "D30", "P01", "P16", "P36"],
     answer(dict(meaning("vabeach", year(2024), MURDER), filters=["relationship: stranger"]), names("vabeach"), SOURCE_LAST), "MUST ANSWER: P36."),
    ("inc2-carjack-loc", "Carjackings in Wichita by location type in 2024", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("wichita", year(2024), CARJACK, ["location type"]), names("wichita"), CATS, SOURCE_LAST), "MUST ANSWER: carjacking offenses (D18); one location per offense."),
    ("inc2-offender-sex", "Simple assaults by men and women in Oklahoma City in 2024", ["D18", "D29", "D30", "P01", "P16", "P29", "P49"],
     answer(meaning("okc", year(2024), SA, ["offender sex"]), names("okc"), CATS, OVERLAP, SOURCE_LAST),
     "MUST ANSWER: P29 offenders; P49 counts the crimes (victims, D18) by the incident's offender sexes, once in each."),
    ("inc2-offenders", "Robbery offenders in Raleigh by sex in 2024", ["D18", "D29", "D30", "P01", "P16", "P44"],
     answer(meaning("raleigh", year(2024), [("robbery", "offender")], ["offender sex"]), names("raleigh"), CATS, SOURCE_LAST),
     "MUST ANSWER: 'offenders' asks for the offenders themselves (P44), counted per offender record."),
    ("inc2-twoway", "Aggravated assault victims in Mesa by race and sex in 2024", ["D18", "D29", "D30", "P01", "P16"],
     answer(meaning("mesa", year(2024), AA, ["victim race", "victim sex"]), names("mesa"), CATS, SOURCE_LAST), "A two-way breakdown, if the reader reads it."),
    ("inc2-gun-crime", "Gun crime in Fort Worth in 2023", ["D18", "D30", "P01", "P16", "P31"],
     answer(dict(meaning("fortworth", year(2023), MURDER + [("robbery", "offense")] + AA), filters=["weapon: firearm"]),
            "names the crimes counted (murder, robbery and aggravated assault with a firearm)",
            "gives the gun-crime total (firearm murder victims plus firearm robbery offenses plus firearm aggravated assault victims)", names("fortworth"), SOURCE_LAST),
     "MUST ANSWER: P31's gun crime as a total; each crime in its D18 unit (Codex label check)."),
    ("inc2-stabbings", "Stabbings in Oklahoma City in 2024", ["D18", "D30", "P01", "P16", "P31"],
     answer(dict(meaning("okc", year(2024), MURDER + AA), filters=["weapon: knife or cutting instrument"]),
            "names the crimes counted (murder and aggravated assault with a knife or cutting instrument)",
            "gives the stabbings total (murder victims plus aggravated assault victims with a knife or cutting instrument)", names("okc"), SOURCE_LAST),
     "MUST ANSWER: P31's stabbings as a total, victims (D18) (Codex label check)."),
    ("inc2-arrests", "Shoplifting arrests in Colorado Springs in 2024", ["D18", "D30", "P01", "P16", "P46", "P50"],
     answer(meaning("cosprings", year(2024), [("shoplifting", "arrest")]), ARREST_ONCE, names("cosprings"), SOURCE_LAST), "MUST ANSWER: arrests made in 2024 (P50)."),
    ("inc2-arrests-month", "Robbery arrests in Wichita by month in 2023", ["D04", "D18", "D30", "P01", "P16", "P46", "P50"],
     answer(meaning("wichita", year(2023), [("robbery", "arrest")], ["month"]), ARREST_ONCE, names("wichita"), MISSING, SOURCE_LAST), "MUST ANSWER: by month of arrest."),
    ("inc2-people-arrested", "How many people were arrested for burglary in Raleigh in 2024?", ["D18", "D30", "P01", "P16", "P46", "P48", "P50"],
     answer(meaning("raleigh", year(2024), [("burglary", "arrest")]), ARREST_ONCE, names("raleigh"), SOURCE_LAST), "MUST ANSWER: P48 'were arrested' -> arrests; arrests are NIBRS's detail."),
    # Boundaries: declined by decided policy.
    ("inc2-b-charged", "How many robbery suspects were charged in Wichita in 2024?", ["D01", "P16", "P46"],
     {"action": "decline", "reason": "Charging records are not in the data; it records police arrests and clearances.", "alternative": meaning("wichita", year(2024), [("robbery", "arrest")])},
     "BOUNDARY: P46 charged is declined; offer the arrests (D01)."),
    ("inc2-b-shooters", "How many shooters were there in Raleigh in 2024?", ["P16", "P45"],
     {"action": "decline", "reason": "\"Shooters\" is not a term the data defines.", "alternative": None}, "BOUNDARY: P45 shooters declined."),
    ("inc2-b-gun-violence", "Gun violence in Fort Worth in 2024", ["P16", "P31"],
     {"action": "decline", "reason": "The data has no counts of non-fatal shootings, so gun violence cannot be counted.", "alternative": None}, "BOUNDARY: P31 gun violence declined with the note."),
]

# Compiler increment 3 (2026-10-29): time. Separate years, changes between two periods (P54 implied year, P55 zero base,
# D17 matched months), the last 12 months (P56), rolling windows. Fresh, held out, labeled from policy before the build.
# NIBRS measures only: a Part I crime's plain count or change is Historical's (P01). Agencies reported every month of
# 2019-2026-09 except Greensboro (no data Nov-Dec 2025) and Seattle (none for Sep 2026), chosen for those gaps.
INC3_DRAFTER = "claude-inc3"
ROBBERY_GUN = [("robbery", "offense")]
CHANGE = "gives both counts, the change and the percent change, with no adjectives"
WINDOWS = "defines each point as the sum of the 12 months ending that month"


def change(place, earlier, later, measures, filters=()):
    m = meaning(place, {"from": earlier["from"], "to": later["to"]}, measures, ["year"])
    m["statistic"] = "change"
    m["filters"] = list(filters)
    return m


INC3 = [
    ("inc3-separate-years", "Shoplifting in Columbus, Ohio in 2019 and 2024", ["D04", "D18", "D30", "P01", "P16"],
     answer(meaning("columbus", {"rule": "the years 2019 and 2024"}, SHOP, ["year"]), names("columbus"), SOURCE_LAST),
     "MUST ANSWER: one row per year asked, no change computed (none asked)."),
    ("inc3-change", "Change in simple assaults in Austin from 2022 to 2024", ["D17", "D18", "D30", "P01", "P16", "P54"],
     answer(change("austin", year(2022), year(2024), [("simple assault", "victim")]), CHANGE, names("austin"), SOURCE_LAST),
     "MUST ANSWER: 2022 against 2024, whole years; victims (D18)."),
    ("inc3-compared-with", "Theft from motor vehicle in Minneapolis in 2024 compared with 2023", ["D17", "D18", "D30", "P01", "P16", "P54"],
     answer(change("minneapolis", year(2023), year(2024), TFMV), CHANGE, names("minneapolis"), SOURCE_LAST),
     "MUST ANSWER: 'compared with' names the earlier year."),
    ("inc3-go-up", "Did drug possession offenses go up in Aurora, Colorado in 2025?", ["D17", "D18", "D30", "P01", "P16", "P54"],
     answer(change("aurora", year(2024), year(2025), [("drug possession", "offense")]), CHANGE, "names the comparison year (2024)", names("aurora"), SOURCE_LAST),
     "MUST ANSWER: P54, no comparison year named -> the year before, same months."),
    ("inc3-this-year", "Are carjackings in Dallas up this year compared with last year?", ["D06", "D17", "D18", "D30", "P01", "P16", "P52", "P54"],
     answer(dict(change("dallas", {"from": "2025-01"}, {"to": "2026-09"}, CARJACK), period={"rule": "2025 through the latest month in the data"},
                 filters=["the same months of each year: January through the latest month"]),
            "names the months compared", "compares the same months of each year", CHANGE, names("dallas"), SOURCE_LAST),
     "MUST ANSWER: January-September 2026 against January-September 2025 (P52: September is the latest month); as LS-268."),
    ("inc3-percent", "Percent change in robberies with a firearm in Charlotte, North Carolina from 2021 to 2025", ["D17", "D18", "D30", "P01", "P16", "P31", "P54"],
     answer(change("charlotte", year(2021), year(2025), ROBBERY_GUN, ["weapon: firearm"]), CHANGE, names("charlotte"), SOURCE_LAST),
     "MUST ANSWER: a Part I crime with a NIBRS detail (the weapon) is NIBRS's (P01). [State named before the build: a bare 'Charlotte' is a city and a county of 100,000+ (Charlotte County, FL), which P28 asks about]"),
    ("inc3-matched-months", "Shoplifting in Austin January through June 2024 compared with January through June 2023", ["D17", "D18", "D30", "P01", "P16", "P54"],
     answer(change("austin", {"from": "2023-01"}, {"to": "2024-06"}, SHOP, ["the same months of each year: January through June"]),
            "names the months compared", CHANGE, names("austin"), SOURCE_LAST),
     "MUST ANSWER: matched months as asked."),
    ("inc3-zero-base", "Change in carjackings in Frisco, Texas from 2022 to 2023", ["D17", "D18", "D30", "P01", "P16", "P51", "P55"],
     answer(change("frisco", year(2022), year(2023), CARJACK), "gives both counts and the change", "says the percent change cannot be computed from a zero base",
            names("frisco"), SOURCE_LAST),
     "MUST ANSWER: P55; 2022 is a known 0 (P51: every month reported)."),
    ("inc3-missing-months", "Did shoplifting go up in Greensboro in 2025?", ["D04", "D17", "D18", "D30", "P01", "P16", "P54"],
     answer(change("greensboro", year(2024), year(2025), SHOP), "names November and December 2025 as having no data",
            "makes no change claim: the 2025 total is not established", names("greensboro"), SOURCE_LAST),
     "MUST ANSWER (no change): D17 and D04; the comparison is not made across a year with missing months."),
    ("inc3-missing-month-ytd", "Is shoplifting in Seattle up this year compared with last year?", ["D04", "D06", "D17", "D18", "D30", "P01", "P16", "P52", "P54"],
     answer(dict(change("seattle", {"from": "2025-01"}, {"to": "2026-09"}, SHOP), period={"rule": "2025 through the latest month in the data"},
                 filters=["the same months of each year: January through the latest month"]),
            "names September 2026 as having no data", "makes no change claim: the 2026 months are not all established", names("seattle"), SOURCE_LAST),
     "MUST ANSWER (no change): D17, D04; never a shorter period substituted silently."),
    ("inc3-rolling", "Rolling 12-month carjackings in Arlington, Texas since 2023", ["D04", "D18", "D30", "P01", "P16"],
     answer(dict(meaning("arlington", {"rule": "2023 through the latest month in the data"}, CARJACK, ["month (rolling 12-month total ending that month)"]),
                 filters=["Each displayed month requires all twelve source months; January 2023 uses February 2022 through January 2023; never sum an incomplete window"]),
            WINDOWS, "shows any window lacking a month as missing, not zero or a shorter-window total", names("arlington"), SOURCE_LAST),
     "MUST ANSWER: windows use months before the period start when the build holds them (as LS-137)."),
    ("inc3-last-12", "Carjackings in Arlington, Texas over the last 12 months", ["D06", "D18", "D30", "P01", "P16", "P52", "P56"],
     answer(meaning("arlington", {"rule": "the 12 months ending at the latest month in the data"}, CARJACK), "names the months covered", names("arlington"), SOURCE_LAST),
     "MUST ANSWER: P56, October 2025 through September 2026, one total."),
    # Codex inc3 label check: rolling windows with missing inputs (Greensboro has no data for November-December 2025).
    ("inc3-rolling-gap", "Rolling 12-month shoplifting in Greensboro since 2025", ["D04", "D18", "D30", "P01", "P16"],
     answer(dict(meaning("greensboro", {"rule": "2025 through the latest month in the data"}, SHOP, ["month (rolling 12-month total ending that month)"]),
                 filters=["Each displayed month requires all twelve source months; never sum an incomplete window"]),
            WINDOWS, "shows the windows ending November 2025 through September 2026 as missing (each contains November or December 2025), never zero or a shorter-window total",
            "names November and December 2025 as having no data", names("greensboro"), SOURCE_LAST),
     "MUST ANSWER: windows ending January-October 2025 are complete; every later window contains a missing month."),
    ("inc3-rolling-prehistory-gap", "Rolling 12-month shoplifting in Greensboro since 2026", ["D04", "D18", "D30", "P01", "P16"],
     answer(dict(meaning("greensboro", {"rule": "2026 through the latest month in the data"}, SHOP, ["month (rolling 12-month total ending that month)"]),
                 filters=["Each displayed month requires all twelve source months; January 2026 uses February 2025 through January 2026; never sum an incomplete window"]),
            WINDOWS, "shows every window as missing (each contains November or December 2025), never zero or a shorter-window total",
            "names November and December 2025 as having no data", names("greensboro"), SOURCE_LAST),
     "MUST ANSWER (all windows missing): the missing months fall before the period start, inside the first windows."),
]

# Compiler increment 4 (2026-10-30): several places, rates, rankings. Fresh, held out, labeled from policy before the build.
# NIBRS measures only (P01). Populations: the FBI's agency population for the data year. Every agency here reported every
# month of its period except Greensboro (no data Nov-Dec 2025), chosen for that gap. City agencies: FBI agency indicator 1.
INC4_DRAFTER = "claude-inc4"
TEXAS = {"kind": "state", "name": "Texas", "state": "TX"}
OHIO = {"kind": "state", "name": "Ohio", "state": "OH"}
COLORADO = {"kind": "state", "name": "Colorado", "state": "CO"}
RANKED = "ranks only agencies that reported all 12 months of 2024, and names those left out with their months reported; no button to include them, and they appear in neither the chart nor the table (P60)"
TIES = "orders ties alphabetically by agency name"
NO_FILTER = "adds no other eligibility filter"


def places(*keys, combine="separate"):
    m = meaning(keys[0], year(2024), SHOP)
    m["places"] = [AG[k] for k in keys]
    m["combine"] = combine
    return m


def rate(place, period, measures, groupings=(), denominator=None):
    m = meaning(place, period, measures, groupings)
    m["statistic"] = "rate"
    m["denominator"] = denominator or f"residents of the {AG[place]['name']}'s jurisdiction (the FBI's agency population), per 100,000"
    return m


def ranking(state, measures, by, direction, limit, filters, denominator=None):
    m = meaning(state, year(2024), measures, ["agency"])
    m["filters"] = filters
    m["statistic"] = "rate" if by == "rate" else "count"
    m["rank"] = {"by": by, "direction": direction, "limit": limit}
    if denominator:
        m["denominator"] = denominator
    return m


INC4 = [
    ("inc4-places", "Shoplifting in Tulsa and Oklahoma City in 2024", ["D18", "D30", "P01", "P16"],
     answer(places("tulsa", "okc"), names("tulsa"), names("okc"), SOURCE_LAST), "MUST ANSWER: a count per agency."),
    ("inc4-combined", "Shoplifting in Tulsa and Oklahoma City combined in 2024", ["D18", "D30", "P01", "P16"],
     answer(places("tulsa", "okc", combine="combined"), "gives one total of both agencies", names("tulsa"), names("okc"), SOURCE_LAST),
     "MUST ANSWER: 'combined' is one total of both agencies' offenses."),
    ("inc4-places-gap", "Shoplifting in Greensboro and Raleigh in 2025", ["D04", "D18", "D30", "P01", "P16"],
     answer(dict(places("greensboro", "raleigh"), period=year(2025)), "names November and December 2025 as having no data", names("greensboro"), names("raleigh"), SOURCE_LAST),
     "MUST ANSWER: Raleigh's count; Greensboro's total not established (D6), its missing months named."),
    ("inc4-rate", "Shoplifting rate in Wichita in 2024", ["D18", "D30", "P01", "P15", "P16", "P58"],
     answer(rate("wichita", year(2024), SHOP), "gives the rate per 100,000 residents and names the population and its year", names("wichita"), SOURCE_LAST),
     "MUST ANSWER: the year's count over the FBI's 2024 population for the agency."),
    ("inc4-rate-years", "Shoplifting rate in Memphis by year from 2021 to 2024", ["D18", "D30", "P01", "P15", "P16", "P58"],
     answer(rate("memphis", {"from": "2021-01", "to": "2024-12"}, SHOP, ["year"]), "gives each year's rate over that year's population", names("memphis"), SOURCE_LAST),
     "MUST ANSWER: each year over its own population."),
    ("inc4-rate-part-year", "Carjackings per 100,000 residents in Dallas this year", ["D06", "D18", "D30", "P01", "P15", "P16", "P52", "P58", "P59"],
     answer(rate("dallas", {"rule": "2026 through the latest month in the data"}, CARJACK), "names the months covered",
            "says the rate is for those months and is not annualized", names("dallas"), SOURCE_LAST),
     "MUST ANSWER: P59, January-September 2026, the FBI population carried forward."),
    ("inc4-rate-gap", "Shoplifting rate in Greensboro in 2025", ["D04", "D18", "D30", "P01", "P15", "P16", "P58"],
     answer(rate("greensboro", year(2025), SHOP), "gives no rate, because not every month of 2025 is known", "names November and December 2025 as having no data",
            names("greensboro"), SOURCE_LAST),
     "MUST ANSWER (no rate): P58."),
    ("inc4-rank", "Which Texas cities had the most carjackings in 2024?", ["D05", "D18", "D30", "P01", "P04", "P16", "P17", "P60"],
     answer(ranking(TEXAS, CARJACK, "count", "top", 20, ["city agencies", "agencies that reported every month of 2024"]),
            "shows 20 agencies (D05)", RANKED, TIES, NO_FILTER, SOURCE_LAST),
     "MUST ANSWER: Texas city agencies (indicator 1), full-year reporters (P04), 20 rows (D05), ties alphabetical (P17)."),
    ("inc4-rank-rate", "Top 10 cities by shoplifting rate in Ohio in 2024", ["D05", "D18", "D30", "P01", "P04", "P15", "P16", "P17", "P58", "P60"],
     answer(ranking(OHIO, SHOP, "rate", "top", 10, ["city agencies", "agencies that reported every month of 2024"], "each agency's residents (the FBI's agency population), per 100,000"),
            "shows exactly 10 agencies", RANKED, TIES, NO_FILTER, SOURCE_LAST),
     "MUST ANSWER: each city's own rate; exactly 10 (P17)."),
    ("inc4-rank-large", "Which large Texas cities had the highest shoplifting rate in 2024?", ["D05", "D18", "D30", "P01", "P04", "P08", "P15", "P16", "P17", "P58", "P60"],
     answer(ranking(TEXAS, SHOP, "rate", "top", 20, ["city agencies", "250,000 residents or more", "agencies that reported every month of 2024"], "each agency's residents (the FBI's agency population), per 100,000"),
            "says large means 250,000 residents or more", RANKED, TIES, SOURCE_LAST),
     "MUST ANSWER: P08 (large = 250,000+); at most 20 rows (D05)."),
    ("inc4-rank-bottom", "Which Colorado cities had the fewest carjackings in 2024?", ["D05", "D18", "D30", "P01", "P04", "P16", "P17", "P51", "P60"],
     answer(ranking(COLORADO, CARJACK, "count", "bottom", 20, ["city agencies", "agencies that reported every month of 2024"]),
            "shows 20 agencies (D05)", RANKED, TIES, NO_FILTER, SOURCE_LAST),
     "MUST ANSWER: many known zeros (P51); the cut falls inside a tie, ordered alphabetically (P17)."),
    # Codex inc4 label check: combined membership and evidence, combined rates, a current-year ranking.
    ("inc4-combined-dup", "Shoplifting in Tulsa Police Department, Tulsa, and Oklahoma City combined in 2024", ["D18", "D30", "P01", "P16"],
     answer(places("tulsa", "okc", combine="combined"), "gives one total of both agencies, counting Tulsa once", names("tulsa"), names("okc"), SOURCE_LAST),
     "MUST ANSWER: two references to one agency are one member; never double-counted."),
    ("inc4-combined-gap", "Shoplifting in Greensboro and Raleigh combined in 2025", ["D04", "D18", "D30", "P01", "P16"],
     answer(dict(places("greensboro", "raleigh", combine="combined"), period=year(2025)), "gives no combined total, because Greensboro's 2025 total is not established",
            "names November and December 2025 as having no data", names("greensboro"), names("raleigh"), SOURCE_LAST),
     "MUST ANSWER (no total): D6; Raleigh's months cannot stand in for Greensboro's."),
    ("inc4-rates-separate", "Shoplifting rates in Tulsa and Oklahoma City in 2024", ["D18", "D30", "P01", "P15", "P16", "P58"],
     answer(dict(places("tulsa", "okc"), statistic="rate", denominator="each agency's residents (the FBI's agency population), per 100,000"),
            "gives each agency's rate over its own population", names("tulsa"), names("okc"), SOURCE_LAST),
     "MUST ANSWER: a rate per agency."),
    ("inc4-rate-combined", "Shoplifting rate in Tulsa and Oklahoma City combined in 2024", ["D18", "D30", "P01", "P15", "P16", "P58"],
     answer(dict(places("tulsa", "okc", combine="combined"), statistic="rate", denominator="the two agencies' residents together (the FBI's agency populations), per 100,000"),
            "gives one rate: both agencies' offenses over both agencies' populations, not an average of their rates", names("tulsa"), names("okc"), SOURCE_LAST),
     "MUST ANSWER: 100,000 x (sum of counts) / (sum of populations)."),
    ("inc4-rate-combined-gap", "Shoplifting rate in Greensboro and Raleigh combined in 2025", ["D04", "D18", "D30", "P01", "P15", "P16", "P58"],
     answer(dict(places("greensboro", "raleigh", combine="combined"), period=year(2025), statistic="rate", denominator="the two agencies' residents together (the FBI's agency populations), per 100,000"),
            "gives no rate, because not every month of 2025 is known for every agency counted", "names November and December 2025 as having no data",
            names("greensboro"), names("raleigh"), SOURCE_LAST),
     "MUST ANSWER (no rate): P58; Greensboro is never dropped from the numerator or kept only in the denominator."),
    ("inc4-rank-ytd", "Which Texas cities had the most carjackings so far this year?", ["D05", "D06", "D18", "D30", "P01", "P04", "P16", "P17", "P52", "P60"],
     answer(dict(ranking(TEXAS, CARJACK, "count", "top", 20, ["city agencies", "agencies that reported every month of 2026 so far"]), period={"rule": "2026 through the latest month in the data"}),
            "names the months covered", "shows 20 agencies (D05)", "ranks only agencies that reported every month of 2026 so far, and names those left out with their months reported; no button to include them, and they appear in neither the chart nor the table (P60)",
            TIES, NO_FILTER, SOURCE_LAST),
     "MUST ANSWER: P04 for the current year: every month available so far (January-September 2026, P52)."),
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
reader_reviewer = args[1] if args[:1] == ["--reader-reviewed-by"] else None
breakdown_reviewer = args[1] if args[:1] == ["--breakdown-reviewed-by"] else None
inc2_reviewer = args[1] if args[:1] == ["--inc2-reviewed-by"] else None
inc3_reviewer = args[1] if args[:1] == ["--inc3-reviewed-by"] else None
inc4_reviewer = args[1] if args[:1] == ["--inc4-reviewed-by"] else None
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
for g, q, pol, exp, notes in READER:
    group = f"designed:{g}"
    if (group, q) in have:
        old = next(c for c in data["cases"] if (c["group"], c["question"]) == (group, q))
        if old["label"]["drafted_by"] == READER_DRAFTER and old["label"]["status"] == "drafted":
            old.update(policy=pol, expected=exp)
            old["label"]["notes"] = notes
        continue
    data["cases"].append({
        "id": f"LS-{len(data['cases']) + 1:03d}", "group": group, "split": "heldout",
        "origin": {"kind": "designed", "ref": None}, "tab": "nibrs", "setup": [], "question": q, "policy": pol, "expected": exp,
        "label": {"status": "drafted", "drafted_by": READER_DRAFTER, "reviewed_by": None, "notes": notes}})
    added += 1
for g, q, pol, exp, notes in BREAKDOWN:
    group = f"designed:{g}"
    if (group, q) in have:
        old = next(c for c in data["cases"] if (c["group"], c["question"]) == (group, q))
        if old["label"]["drafted_by"] == BREAKDOWN_DRAFTER and old["label"]["status"] == "drafted":
            old.update(policy=pol, expected=exp)
            old["label"]["notes"] = notes
        continue
    data["cases"].append({
        "id": f"LS-{len(data['cases']) + 1:03d}", "group": group, "split": "heldout",
        "origin": {"kind": "designed", "ref": None}, "tab": "nibrs", "setup": [], "question": q, "policy": pol, "expected": exp,
        "label": {"status": "drafted", "drafted_by": BREAKDOWN_DRAFTER, "reviewed_by": None, "notes": notes}})
    added += 1
for g, q, pol, exp, notes in INC2:
    group = f"designed:{g}"
    if (group, q) in have:
        old = next(c for c in data["cases"] if (c["group"], c["question"]) == (group, q))
        if old["label"]["drafted_by"] == INC2_DRAFTER and old["label"]["status"] == "drafted":
            old.update(policy=pol, expected=exp)
            old["label"]["notes"] = notes
        continue
    data["cases"].append({
        "id": f"LS-{len(data['cases']) + 1:03d}", "group": group, "split": "heldout",
        "origin": {"kind": "designed", "ref": None}, "tab": "nibrs", "setup": [], "question": q, "policy": pol, "expected": exp,
        "label": {"status": "drafted", "drafted_by": INC2_DRAFTER, "reviewed_by": None, "notes": notes}})
    added += 1
for g, q, pol, exp, notes in INC3:
    group = f"designed:{g}"
    if (group, q) in have:
        old = next(c for c in data["cases"] if (c["group"], c["question"]) == (group, q))
        if old["label"]["drafted_by"] == INC3_DRAFTER and old["label"]["status"] == "drafted":
            old.update(policy=pol, expected=exp)
            old["label"]["notes"] = notes
        continue
    data["cases"].append({
        "id": f"LS-{len(data['cases']) + 1:03d}", "group": group, "split": "heldout",
        "origin": {"kind": "designed", "ref": None}, "tab": "nibrs", "setup": [], "question": q, "policy": pol, "expected": exp,
        "label": {"status": "drafted", "drafted_by": INC3_DRAFTER, "reviewed_by": None, "notes": notes}})
    added += 1
for g, q, pol, exp, notes in INC4:
    group = f"designed:{g}"
    if (group, q) in have:
        old = next(c for c in data["cases"] if (c["group"], c["question"]) == (group, q))
        if old["label"]["drafted_by"] == INC4_DRAFTER and old["label"]["status"] == "drafted":
            old.update(policy=pol, expected=exp)
            old["label"]["notes"] = notes
        continue
    data["cases"].append({
        "id": f"LS-{len(data['cases']) + 1:03d}", "group": group, "split": "heldout",
        "origin": {"kind": "designed", "ref": None}, "tab": "nibrs", "setup": [], "question": q, "policy": pol, "expected": exp,
        "label": {"status": "drafted", "drafted_by": INC4_DRAFTER, "reviewed_by": None, "notes": notes}})
    added += 1
marked = 0
if inc4_reviewer:
    for c in data["cases"]:
        if c["label"]["drafted_by"] == INC4_DRAFTER and c["label"]["status"] == "drafted":
            c["label"].update(status="reviewed", reviewed_by=inc4_reviewer)
            marked += 1
if inc3_reviewer:
    for c in data["cases"]:
        if c["label"]["drafted_by"] == INC3_DRAFTER and c["label"]["status"] == "drafted":
            c["label"].update(status="reviewed", reviewed_by=inc3_reviewer)
            marked += 1
if inc2_reviewer:
    for c in data["cases"]:
        if c["label"]["drafted_by"] == INC2_DRAFTER and c["label"]["status"] == "drafted":
            c["label"].update(status="reviewed", reviewed_by=inc2_reviewer)
            marked += 1
if breakdown_reviewer:
    for c in data["cases"]:
        if c["label"]["drafted_by"] == BREAKDOWN_DRAFTER and c["label"]["status"] == "drafted":
            c["label"].update(status="reviewed", reviewed_by=breakdown_reviewer)
            marked += 1
if reader_reviewer:
    for c in data["cases"]:
        if c["label"]["drafted_by"] == READER_DRAFTER and c["label"]["status"] == "drafted":
            c["label"].update(status="reviewed", reviewed_by=reader_reviewer)
            marked += 1
if reviewer:
    for c in data["cases"]:
        if c["label"]["drafted_by"] == DRAFTER and c["label"]["status"] == "drafted":
            c["label"].update(status="reviewed", reviewed_by=reviewer)
            marked += 1
with open(CASES, "w", encoding="utf-8", newline="\n") as f:
    json.dump(data, f, indent=1, ensure_ascii=False)
    f.write("\n")
print(f"added {added} cases; marked {marked} reviewed; {len(data['cases'])} cases")
