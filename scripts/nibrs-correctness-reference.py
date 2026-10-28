#!/usr/bin/env python3
"""Independent reference computation for the NIBRS hand-traced correctness set.

Reads ONLY the raw-row extracts in scripts/fixtures/nibrs-correctness/extracts/ (rows copied
from nibrs.db's raw segment tables, never from summary tables or any engine) and writes the
expected answers for the large named cases to scripts/fixtures/nibrs-correctness/expected/.

It is deliberately plain: Python stdlib only, one loop per case, no shared query layer, so that
a reviewer can check every number against the extracts by reading this file. The micro cases
(expected/micro.json) are traced by hand in CASES.md; this script only cross-checks them.

    python scripts/nibrs-correctness-reference.py          # rewrite expected/*.json
    python scripts/nibrs-correctness-reference.py --check  # fail if expected/*.json differs
"""
import csv
import gzip
import io
import json
import os
import sys
from collections import Counter, defaultdict
from fractions import Fraction

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "nibrs-correctness")
EXTRACTS = os.path.join(ROOT, "extracts")
EXPECTED = os.path.join(ROOT, "expected")

# The latest incident month present anywhere in the extracts (Memphis, October 2026). The
# extracts were read from nibrs.db after its 2026-10-16 refresh; a canonical release sets its
# own end month, and comparison then runs on the overlapping months.
DATASET_LAST_MONTH = "2026-10"

RACE = {"A": "Asian", "B": "Black or African American", "I": "American Indian or Alaska Native",
        "P": "Native Hawaiian or Other Pacific Islander", "W": "White", "U": "Unknown"}
SEX = {"F": "Female", "M": "Male", "U": "Unknown"}
VEHICLE_CODES = ("03", "05", "24", "28", "37")  # automobiles, buses, other motor vehicles, recreational vehicles, trucks


def rows(name):
    path = os.path.join(EXTRACTS, name)
    if name.endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8", newline="") as f:
            return list(csv.DictReader(f))
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def ym(incident_date):
    return f"{incident_date[:4]}-{incident_date[4:6]}"


def months(first, last):
    y, m = int(first[:4]), int(first[5:])
    out = []
    while f"{y}-{m:02d}" <= last:
        out.append(f"{y}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def pct(num, den):
    # Shares are carried as exact fractions; the decimal is rounded half-up to 1 place for display.
    tenths = Fraction(num * 1000, den) + Fraction(1, 2)
    return {"num": num, "den": den, "pct_1dp": (tenths.numerator // tenths.denominator) / 10}


def cell(num, den):
    """One cell of a share table. A combination with no rows is a filtered zero, and D6 allows 0 only with
    submission evidence for the month: until then it is UNKNOWN, with the value it takes once the month is
    evidenced complete. The observed denominator is kept."""
    if num:
        return pct(num, den)
    return {"num": None, "den": den, "pct_1dp": None, "status": "UNKNOWN_UNEVIDENCED_ZERO",
            "if_month_evidenced_complete": {"num": 0, "pct_1dp": 0.0}}


def agency_month_status(ori):
    """Evidence available in phase 1: crime rows only. A month with rows is REPORTED_CRIMES
    (which does not prove the month's submission is complete). A month without rows is
    UNKNOWN: the BH month indicators are not decoded yet, so neither REPORTED_ZERO nor
    NOT_REPORTED can be established (shared spec r4, D6)."""
    n = {}
    for r in rows("agency_month_incident_counts_2017_2026.csv"):
        if r["ori"] == ori:
            n[f"{r['ym'][:4]}-{r['ym'][4:]}"] = int(r["n"])
    return lambda m: ("REPORTED_CRIMES", n[m]) if m in n else ("UNKNOWN", 0)


# ---------------------------------------------------------------- N1: Houston murder victims
def n1_houston_murder_victims_race_sex():
    status = agency_month_status("TXHPD0000")
    victims = rows("houston_09a_victims_2018_2026.csv")
    by_month = defaultdict(Counter)
    for v in victims:
        assert "09A" in (v["connected_offense_1"], v["connected_offense_2"], v["connected_offense_3"])
        by_month[ym(v["incident_date"])][(v["race"], v["sex"])] += 1
    combos = sorted({k for c in by_month.values() for k in c})
    out = []
    for m in months("2018-01", DATASET_LAST_MONTH):
        st, incidents = status(m)
        den = sum(by_month[m].values())
        if st != "REPORTED_CRIMES":
            out.append({"month": m, "status": st, "murder_victims": None, "cells": None})
            continue
        if den == 0:
            # A filtered zero needs submission evidence for the month (D6); none exists yet.
            out.append({"month": m, "status": "REPORTED_CRIMES_NO_MURDER_ROWS", "murder_victims": None, "cells": None})
            continue
        cells = [{"race": r, "sex": s, **cell(by_month[m][(r, s)], den)} for (r, s) in combos]
        out.append({"month": m, "status": st, "murder_victims": den, "cells": cells})
    return {
        "case": "N1",
        "question": "What share of murder victims were of each race and sex, per month, in Houston since 2018?",
        "interpretation": {
            "agency": "TXHPD0000 (Houston Police Department, TX)",
            "measure": "murder victims: distinct victim segments with a connected offense of 09A (murder and nonnegligent manslaughter)",
            "counting_unit": "victim",
            "groupings": ["month (incident date)", "victim race", "victim sex"],
            "denominator": "all murder victims of the same agency in the same month (partition: month)",
            "period": f"2018-01 through {DATASET_LAST_MONTH} (dataset end)",
            "unknown_handling": "race U and sex U are their own visible categories",
            "absent_combinations": "a race-sex combination with no victims in a month is UNKNOWN_UNEVIDENCED_ZERO (D6), not 0; it becomes 0 when the month is evidenced complete",
        },
        "must_state": [
            "Houston's NIBRS data begins in June 2018: January-May 2018 have no Houston NIBRS records.",
            "Each month's shares are of that month's murder victims; numerators and denominators are shown.",
        ],
        "must_not": [
            "divide by the whole-period total (NIBRS Savant's pct_of_total does this)",
            "drop unknown race or sex",
            "show months without data as 0",
        ],
        "combos_observed": [{"race": r, "race_label": RACE[r], "sex": s, "sex_label": SEX[s]} for r, s in combos],
        "totals": {"murder_victims": len(victims),
                   "months_reported": sum(1 for r in out if r["status"] == "REPORTED_CRIMES"),
                   "first_month_with_data": next(r["month"] for r in out if r["status"] == "REPORTED_CRIMES")},
        "rows": out,
    }


# ------------------------------------------------- N2: thefts from motor vehicles + stolen firearm
def n2_memphis_23f_with_stolen_firearm():
    status = agency_month_status("TNMPD0000")
    offenses = rows("memphis_23f_offenses_2024.csv.gz")
    prop = rows("memphis_firearm_property_for_23f_incidents_2024.csv")
    multi = {r["incident_num"]: r["offense_codes"].split(",") for r in rows("memphis_23f_incidents_with_other_offenses_2024.csv")}
    stolen = {p["incident_num"] for p in prop if p["type_property_loss"] == "7" and p["property_description"] == "13"}
    recovered_only = {p["incident_num"] for p in prop if p["type_property_loss"] == "5"} - stolen
    keys = [o["incident_num"] for o in offenses]
    assert len(keys) == len(set(keys)), "one 23F offense segment per incident"
    per_month, shared = Counter(), Counter()
    all_23f = Counter(ym(o["incident_date"]) for o in offenses)
    for o in offenses:
        if o["incident_num"] in stolen:
            m = ym(o["incident_date"])
            per_month[m] += 1
            if len(multi.get(o["incident_num"], ["23F"])) > 1:
                shared[m] += 1
    out = []
    for m in months("2024-01", "2024-12"):
        st, _ = status(m)
        out.append({"month": m, "status": st, "theft_from_motor_vehicle_offenses_in_incidents_with_stolen_firearm": per_month[m],
                    "of_which_incident_has_another_offense": shared[m], "all_theft_from_motor_vehicle_offenses": all_23f[m]})
    return {
        "case": "N2",
        "question": "Thefts from motor vehicles where a firearm was stolen, per month (Memphis, 2024).",
        "interpretation": {
            "agency": "TNMPD0000 (Memphis Police Department, TN), data year 2024 (the extract's scope)",
            "measure": "23F (theft from motor vehicle) offenses in incidents that contain at least one property segment with loss type 7 (stolen) and description 13 (firearms)",
            "counting_unit": "offense (equal to incidents here: an incident holds at most one 23F offense segment)",
            "filter_kind": "scoped existence filter at incident scope: exists(property where loss=stolen and description=firearm)",
            "groupings": ["month (incident date)"],
            "excluded": "property segments with loss type 5 (recovered) or 6 (seized) alone; firearms as a weapon (offense weapon codes) are a different field",
        },
        "must_state": [
            "NIBRS records property per incident, not per offense: in an incident with several offenses the stolen firearm is not attributed to the theft from motor vehicle.",
        ],
        "must_not": ["read 'firearm stolen' as the weapon used", "attribute the property to the 23F offense"],
        "totals": {"matching_offenses": sum(per_month.values()), "incidents_with_another_offense": sum(shared.values()),
                   "incidents_with_recovered_firearm_but_no_stolen_firearm_segment": len(recovered_only & set(keys))},
        "rows": out,
    }


# --------------------------------------------------------------- N3: Baltimore car thefts
def n3_baltimore_240_by_month():
    status = agency_month_status("MDBPD0000")
    offenses = rows("baltimore_240_offenses_2022_2026.csv.gz")
    prop = rows("baltimore_vehicle_property_for_240_incidents_2022_2026.csv.gz")
    # nibrs.db holds five 2023 Baltimore incidents twice, every segment identical (CASES.md, N3).
    # An incident has at most one offense segment per offense code, so each key counts once.
    seen, duplicates, unique = set(), [], []
    for o in offenses:
        k = (o["year"], o["incident_num"])
        if k in seen:
            duplicates.append({"data_year": int(k[0]), "incident_num": k[1], "month": ym(o["incident_date"])})
        else:
            seen.add(k)
            unique.append(o)
    auto = {(p["year"], p["incident_num"]) for p in prop if p["type_property_loss"] == "7" and p["property_description"] == "03"}
    n, att, n_auto = Counter(), Counter(), Counter()
    for o in unique:
        m = ym(o["incident_date"])
        n[m] += 1
        att[m] += o["attempted_completed"] == "A"
        n_auto[m] += (o["year"], o["incident_num"]) in auto
    out = []
    for m in months("2022-01", "2026-06"):
        st, _ = status(m)
        out.append({"month": m, "status": st, "motor_vehicle_theft_offenses": n[m] if st == "REPORTED_CRIMES" else None,
                    "of_which_attempted": att[m], "variant_with_stolen_automobile_segment": n_auto[m]})
    return {
        "case": "N3",
        "question": "Car thefts in Baltimore by month, January 2022 to June 2026.",
        "interpretation": {
            "agency": "MDBPD0000 (Baltimore Police Department, MD)",
            "measure": "240 (motor vehicle theft) offenses, completed and attempted",
            "counting_unit": "offense",
            "groupings": ["month (incident date)"],
            "period": "2022-01 through 2026-06: 54 months spanning five calendar years",
            "label": "Motor vehicle theft",
        },
        "variant": "variant_with_stolen_automobile_segment counts 240 offenses whose incident has a stolen property segment with description 03 (automobiles). It is recorded so a reviewer can see how much 'car' read narrowly would change the answer; the primary expectation is motor vehicle theft.",
        "must_not": ["clip the range to one calendar year", "treat the range as 2022 and 2026 only",
                     "count a duplicated incident twice"],
        "duplicated_incidents_in_source_rows": duplicates,
        "totals": {"motor_vehicle_theft_offenses": sum(r["motor_vehicle_theft_offenses"] or 0 for r in out),
                   "months_reported": sum(1 for r in out if r["status"] == "REPORTED_CRIMES")},
        "rows": out,
    }


# ------------------------------------------------------------ N4: frozen release questions H1-H3
def n4_memphis_carjacking():
    offenses = rows("memphis_120_offenses_2017_2026.csv.gz")
    prop = rows("memphis_vehicle_property_for_120_incidents_2017_2026.csv.gz")
    stolen_vehicle = {(p["year"], p["incident_num"]) for p in prop if p["type_property_loss"] == "7" and p["property_description"] in VEHICLE_CODES}
    n = Counter()
    for o in offenses:
        if (o["year"], o["incident_num"]) in stolen_vehicle:
            n[ym(o["incident_date"])] += 1
    year = lambda y: sum(v for k, v in n.items() if k.startswith(f"{y}-"))
    return {
        "case": "N4",
        "definition": "Carjacking (NIBRSAI's derived measure, unchanged): incidents with a 120 (robbery) offense and a property segment with loss type 7 (stolen) and a motor-vehicle description (03, 05, 24, 28, 37). NIBRS has no carjacking offense code.",
        "counting_unit": "incident",
        "H1": {"question": "carjacking per month in Memphis",
               "interpretation": "calendar year 2025 by month: today's legacy default year for a monthly series with no period (the year is not evidenced complete; a change to the default must be declared)",
               "rows": [{"month": m, "carjackings": n[m]} for m in months("2025-01", "2025-12")]},
        "H2": {"question": "carjackings in Memphis in 2025", "rows": [{"year": 2025, "carjackings": year(2025)}]},
        "H3": {"question": "carjackings per year in Memphis from 2020 to 2025",
               "rows": [{"year": y, "carjackings": year(y)} for y in range(2020, 2026)]},
        "live_check": "On 2026-10-27 these equal the live answers (query_log ids 10631-10633, summary_carjacking_monthly) month for month, 2017-01 through 2026-10.",
    }


# -------------------------------------------------- Z: missing vs zero vs unknown (filtered measure)
def z_houston_justifiable_homicide_months():
    status = agency_month_status("TXHPD0000")
    n = Counter(ym(r["incident_date"]) for r in rows("houston_09c_offenses_2018_2026.csv"))
    out = []
    for m in months("2018-01", DATASET_LAST_MONTH):
        st, incidents = status(m)
        if st == "UNKNOWN":
            out.append({"month": m, "agency_status": "UNKNOWN", "value": None, "value_if_month_evidenced_complete": None})
        elif n[m]:
            out.append({"month": m, "agency_status": st, "value": n[m], "value_if_month_evidenced_complete": n[m]})
        else:
            # Houston submitted thousands of other incidents this month, but D6: positive rows in
            # other categories do not establish that the 09C count is a true zero.
            out.append({"month": m, "agency_status": st, "value": None, "value_if_month_evidenced_complete": 0,
                        "other_incidents_in_month": incidents})
    return {
        "case": "Z",
        "question": "Justifiable homicides (09C) per month in Houston since 2018.",
        "rule": "Shared spec r4 D6: a filtered measure is 0 only with submission evidence for that month (REPORTED_ZERO, or evidence that the agency's whole submission for the month is complete). Until the BH month indicators are decoded, months with Houston rows but no 09C rows are UNKNOWN for this measure (value null), and months with no Houston rows at all are UNKNOWN for the agency. With evidence of a complete submission, value_if_month_evidenced_complete applies.",
        "counts": {"offenses": sum(n.values()),
                   "months_with_09c": sum(1 for r in out if r["value"]),
                   "months_unknown_for_measure_only": sum(1 for r in out if r["agency_status"] == "REPORTED_CRIMES" and r["value"] is None),
                   "months_unknown_for_agency": sum(1 for r in out if r["agency_status"] == "UNKNOWN")},
        "rows": out,
    }


# --------------------------------------------------------------- D: denominator scopes
def d_denominator_scopes():
    victims = [v for v in rows("houston_09a_victims_2018_2026.csv") if v["incident_date"].startswith("2021")]
    may = [v for v in victims if v["incident_date"][4:6] == "05"]
    sexes = sorted({v["sex"] for v in victims})
    by_month_race = Counter(v["race"] for v in may)
    return {
        "case": "D",
        "question_variants": {
            "within_month": "share of Houston murder victims in May 2021 by sex (denominator: May 2021 murder victims)",
            "within_period": "share of all 2021 Houston murder victims who were May 2021 victims of each sex (denominator: whole 2021 total; what pct_of_total over a 2021 monthly result computes)",
            "within_group": "share of May 2021 Houston murder victims of each race who were of each sex (denominator: that race's May 2021 victims)",
        },
        "within_month": [{"sex": s, **cell(sum(v["sex"] == s for v in may), len(may))} for s in sexes],
        "within_period": [{"sex": s, **cell(sum(v["sex"] == s for v in may), len(victims))} for s in sexes],
        "within_group": [{"race": r, "sex": s, **cell(sum(v["race"] == r and v["sex"] == s for v in may), by_month_race[r])}
                         for r in sorted(by_month_race) for s in sexes],
        "must_not": ["recompute shares over only the displayed cells", "substitute one scope for another"],
    }


# --------------------------------------------------------------- R: rates and partial years
def r_houston_murder_rate():
    victims = Counter(v["incident_date"][:4] for v in rows("houston_09a_victims_2018_2026.csv"))
    status = agency_month_status("TXHPD0000")
    agency = {r["year"]: r for r in rows("agency_years_2017_2026.csv") if r["ori"] == "TXHPD0000"}
    out = []
    for y in ("2018", "2019"):
        reported = [m for m in months(f"{y}-01", f"{y}-12") if status(m)[0] == "REPORTED_CRIMES"]
        pop = int(agency[y]["population"])
        row = {"year": int(y), "murder_victims": victims[y], "months_with_data": len(reported), "population": pop,
               "population_source": f"FBI agency population for TXHPD0000, data year {y} (extracts/agency_years_2017_2026.csv: "
                                    f"population group {agency[y]['pop_group']}, covered_flag {agency[y]['covered_flag']})",
               "rate_per_100k": None}
        if len(reported) == 12:
            # Crime rows in all 12 months do not prove the submission complete (D6), so the annual rate waits for
            # completeness evidence. The arithmetic it will then show is fixed here.
            row["rate_unavailable_reason"] = "the agency's year is not evidenced complete (12 months have crime rows; BH evidence is not decoded)"
            row["rate_per_100k_if_year_evidenced_complete"] = round(victims[y] * 100000 / pop, 2)
        else:
            row["rate_unavailable_reason"] = f"{12 - len(reported)} of 12 months have no Houston NIBRS data (UNKNOWN), so the year cannot be evidenced complete; numerator and denominator use the same agency-period eligibility (D6)"
            row["rate_per_100k_if_year_evidenced_complete"] = None
        out.append(row)
    return {"case": "R", "question": "Murder victim rate per 100,000 residents in Houston, 2018 and 2019.",
            "counting_unit": "victim",
            "jurisdiction": "Houston Police Department is the primary agency for the city of Houston; under D8 its covered population is the denominator. The canonical agency_jurisdiction table must confirm population_counted for TXHPD0000.",
            "scope_note": "This case tests annual rates only. A rate over an explicitly labelled partial period (year to date) is a separate rule with its own case, not covered here.",
            "rows": out}


CASES = {
    "N1-houston-murder-victims-race-sex-monthly-share.json": n1_houston_murder_victims_race_sex,
    "N2-memphis-23f-with-stolen-firearm-2024.json": n2_memphis_23f_with_stolen_firearm,
    "N3-baltimore-motor-vehicle-theft-2022-01-to-2026-06.json": n3_baltimore_240_by_month,
    "N4-frozen-release-H1-H3-memphis-carjacking.json": n4_memphis_carjacking,
    "Z-houston-09c-missing-zero-unknown.json": z_houston_justifiable_homicide_months,
    "D-denominator-scopes.json": d_denominator_scopes,
    "R-houston-murder-rate-partial-year.json": r_houston_murder_rate,
}


COMPLETE = ("REPORTED_CRIMES_COMPLETE", "REPORTED_ZERO")


def synthetic_status():
    """S1-S5 from synthetic/status-fixture.json, computed independently of the hand-written expected file."""
    with open(os.path.join(ROOT, "synthetic", "status-fixture.json"), encoding="utf-8") as f:
        fx = json.load(f)
    agencies = {a["ori"]: a for a in fx["agencies"]}
    am = {(r["ori"], r["month"]): r for r in fx["agency_months"]}
    first, last = fx["months"][0], fx["months"][-1]
    every = lambda v: True

    def value(ori, month, keep):
        r = am[(ori, month)]
        if r["status"] in ("NOT_REPORTED", "UNKNOWN"):
            return None, r["status"]
        n = sum(1 for v in r["murder_victims"] if keep(v))
        if n == 0 and r["status"] not in COMPLETE:
            return None, "UNKNOWN_UNEVIDENCED_ZERO"
        return n, r["status"]

    def series(keep):
        out = []
        for o in agencies:
            for m in fx["months"]:
                n, st = value(o, m, keep)
                out.append({"ori": o, "month": m, "value": n, "status": st})
        return out

    totals = []
    for m in fx["months"]:
        known = [o for o in agencies if value(o, m, every)[0] is not None]
        totals.append({"month": m, "reported_murder_victims": sum(value(o, m, every)[0] for o in known),
                       "agencies_contributing": known,
                       "not_reported": [o for o in agencies if am[(o, m)]["status"] == "NOT_REPORTED"],
                       "unknown": [o for o in agencies if am[(o, m)]["status"] == "UNKNOWN"]})
    by_m = {t["month"]: t for t in totals}
    cohort = [o for o in agencies if value(o, first, every)[0] is not None and value(o, last, every)[0] is not None]
    same = lambda m: sum(value(o, m, every)[0] for o in cohort)

    rates, eligible = [], []
    for o, a in agencies.items():
        missing = [f"{m} {am[(o, m)]['status']}" for m in fx["months"] if am[(o, m)]["status"] not in COMPLETE]
        row = {"ori": o, "eligible": not missing}
        if missing:
            row.update({"murder_victims": None, "population": a["population"], "rate": None,
                        "reason": "months not evidenced complete: " + ", ".join(missing)})
        else:
            eligible.append(o)
            n = sum(len(am[(o, m)]["murder_victims"]) for m in fx["months"])
            if a["population_counted"]:
                row.update({"murder_victims": n, "population": a["population"], "rate": round(n * 100000 / a["population"], 2)})
            else:
                row.update({"murder_victims": n, "population": None, "rate": None,
                            "reason": f"no counted population: its population is counted under its primary agency {a['primary_ori']}"})
        rates.append(row)
    orphans = [o for o in eligible if not agencies[o]["population_counted"] and agencies[o]["primary_ori"] not in eligible]
    state = {"cohort": eligible, "cohort_murder_victims": sum(r["murder_victims"] for r in rates if r["eligible"])}
    if orphans:
        o = orphans[0]
        state.update({"covered_population": None, "rate": None,
                      "reason": f"covered population cannot be established: {o} is in the cohort but its primary agency {agencies[o]['primary_ori']} is not (D8)"})
    else:
        pop = sum(agencies[o]["population"] for o in eligible if agencies[o]["population_counted"])
        state.update({"covered_population": pop, "rate": round(state["cohort_murder_victims"] * 100000 / pop, 2)})

    a = agencies["ZZ0000A00"]
    female = sum(1 for m in fx["months"] for v in am[("ZZ0000A00", m)]["murder_victims"] if v["sex"] == "F")
    earlier, later = by_m[first]["reported_murder_victims"], by_m[last]["reported_murder_victims"]
    return {
        "S1_murder_victims_by_agency_month": series(every),
        "S1_female_murder_victims_by_agency_month": series(lambda v: v["sex"] == "F"),
        "S2_state_reported_totals_by_month": totals,
        "S3_change_january_to_march": {
            "all_reporting": {"earlier": earlier, "later": later, "change": later - earlier},
            "same_agencies": {"cohort": cohort, "earlier": same(first), "later": same(last), "change": same(last) - same(first)}},
        "S4_rates_january_to_march_per_100k_not_annualized": {"by_agency": rates, "state": state},
        "S5_female_murder_victims_per_100k_all_residents": {
            "ori": "ZZ0000A00", "female_murder_victims": female, "population": a["population"],
            "rate": round(female * 100000 / a["population"], 2),
            "label": "female murder victims per 100,000 residents (all residents, not per 100,000 women)"},
    }


def check_synthetic():
    with open(os.path.join(EXPECTED, "S-synthetic-status.json"), encoding="utf-8") as f:
        hand = json.load(f)
    hand.pop("_comment", None)
    got = synthetic_status()
    return [f"S: {k} hand-traced value differs from the reference computation" for k in hand if hand[k] != got.get(k)]


def check_micro():
    """Cross-check the hand-traced micro expectations against the micro extract: every segment count, and each
    measure below wherever a case states it."""
    with open(os.path.join(EXPECTED, "micro.json"), encoding="utf-8") as f:
        micro = json.load(f)
    seg = {t: rows(f"micro/{t}.csv") for t in ("incidents", "offenses", "victims", "offenders", "property", "arrestees")}
    bad = []
    for case in micro["cases"]:
        key = lambda r: r["ori"] == case["ori"] and r["year"] == str(case["data_year"]) and r["incident_num"] == case["incident_num"]
        s = {t: [r for r in v if key(r)] for t, v in seg.items()}
        conn = lambda v: [c for c in (v["connected_offense_1"], v["connected_offense_2"], v["connected_offense_3"]) if c]
        value = lambda loss: sum(int(p["value"] or 0) for p in s["property"] if p["type_property_loss"] == loss)
        under18 = lambda rs: sum(r["age"].isdigit() and 0 < int(r["age"]) < 18 for r in rs)
        codes = [o["ucr_offense_code"] for o in s["offenses"]]
        firearm = [p for p in s["property"] if p["property_description"] == "13"]
        known = [o for o in s["offenders"] if o["offender_sequence"] != "00"]
        got = {
            "offense_segments": len(s["offenses"]),
            "victim_segments": len(s["victims"]),
            "victim_offense_pairs": sum(len(conn(v)) for v in s["victims"]),
            "offender_segments": len(s["offenders"]),
            "known_offenders": len(known),
            "arrestee_segments": len(s["arrestees"]),
            "property_segments": len(s["property"]),
        }
        measures = {
            "incidents": 1,
            "offenses": len(s["offenses"]),
            "murder_victims": sum("09A" in conn(v) for v in s["victims"]),
            "aggravated_assault_victims": sum("13A" in conn(v) for v in s["victims"]),
            "victims_distinct": len(s["victims"]),
            "victim_offense_pairs": got["victim_offense_pairs"],
            "offenders": len(known),
            "offenders_with_information": len(known),
            "arrestees": len(s["arrestees"]),
            "stolen_property_value": value("7"),
            "recovered_property_value": value("5"),
            "firearm_property_segments": len(firearm),
            "stolen_firearm_segments": sum(p["type_property_loss"] == "7" for p in firearm),
            "theft_from_motor_vehicle_offenses_23F": codes.count("23F"),
            "motor_vehicle_theft_offenses_240": codes.count("240"),
            "robbery_offenses_120": codes.count("120"),
            "theft_from_motor_vehicle_offenses_in_incidents_with_stolen_firearm":
                codes.count("23F") * any(p["type_property_loss"] == "7" for p in firearm),
            "theft_from_motor_vehicle_offenses_in_incidents_with_any_firearm_segment": codes.count("23F") * bool(firearm),
            "rows_if_23F_joined_to_firearm_segments": codes.count("23F") * len(firearm),
            "juvenile_offenders_under_18": under18(known),
            "juvenile_arrestees_under_18": under18(s["arrestees"]),
            "offenders_by_age": dict(sorted(Counter(o["age"] for o in known).items())),
        }
        for k, v in got.items():
            if case["counts"].get(k) != v:
                bad.append(f"{case['id']}: {k} hand={case['counts'].get(k)} extract={v}")
        for k, v in measures.items():
            hand = case["measures"].get(k)
            if hand is None:
                continue
            if k == "offenders_by_age":
                hand = {a.split(" ")[0]: n for a, n in hand.items()}
            if hand != v:
                bad.append(f"{case['id']}: measure {k} hand={hand} extract={v}")
    return bad


# ----------------------------------------------------------------- comparing a candidate engine
# The answer-bearing parts of each expected file. Wording (must_state, labels, reasons) is reviewed by a person against
# the expected file; the numbers, nulls and statuses must match exactly.
ANSWER_KEYS = {
    "N1": ["rows"], "N2": ["rows"], "N3": ["rows"], "N4": ["H1", "H2", "H3"], "Z": ["rows"],
    "D": ["within_month", "within_period", "within_group"], "R": ["rows"],
}
WORDING = {"population_source", "rate_unavailable_reason", "reason", "label", "question", "interpretation"}


def strip(x):
    if isinstance(x, dict):
        return {k: strip(v) for k, v in x.items() if k not in WORDING}
    if isinstance(x, list):
        return [strip(v) for v in x]
    return x


def compare(candidate_dir):
    """Compare a candidate engine's answers, written in the expected files' shapes, with the expected answers."""
    bad = []
    for name in list(CASES) + ["micro.json", "S-synthetic-status.json"]:
        path = os.path.join(candidate_dir, name)
        if not os.path.exists(path):
            bad.append(f"{name}: no candidate answer")
            continue
        with open(path, encoding="utf-8") as f:
            got = json.load(f)
        with open(os.path.join(EXPECTED, name), encoding="utf-8") as f:
            want = json.load(f)
        if name == "micro.json":
            gm = {c["id"]: c.get("measures", {}) for c in got.get("cases", [])}
            for c in want["cases"]:
                for k, v in c["measures"].items():
                    if isinstance(v, str) and (v == "PENDING_MASTER_FILE" or v.startswith("NOT DETERMINABLE")):
                        continue
                    if gm.get(c["id"], {}).get(k) != v:
                        bad.append(f"micro {c['id']}.{k}: expected {v!r}, got {gm.get(c['id'], {}).get(k)!r}")
            continue
        keys = [k for k in want if k != "_comment"] if name.startswith("S-") else ANSWER_KEYS[want["case"]]
        for k in keys:
            if strip(got.get(k)) != strip(want[k]):
                bad.append(f"{name}: {k} differs")
    return bad


def main():
    if "--compare" in sys.argv:
        failures = compare(sys.argv[sys.argv.index("--compare") + 1])
        for line in failures:
            print("DIFF", line)
        print("MATCH" if not failures else f"{len(failures)} difference(s)")
        sys.exit(1 if failures else 0)
    check = "--check" in sys.argv
    os.makedirs(EXPECTED, exist_ok=True)
    failures = check_micro() + check_synthetic()
    for name, fn in CASES.items():
        text = json.dumps(fn(), indent=1, ensure_ascii=False) + "\n"
        path = os.path.join(EXPECTED, name)
        if check:
            with open(path, encoding="utf-8") as f:
                if f.read() != text:
                    failures.append(f"{name} differs from the reference computation")
        else:
            with io.open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
    for line in failures:
        print("FAIL", line)
    print("OK" if not failures else f"{len(failures)} failure(s)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
