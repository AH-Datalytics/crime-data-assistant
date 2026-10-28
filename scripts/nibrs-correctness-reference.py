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
        cells = [{"race": r, "sex": s, **pct(by_month[m][(r, s)], den)} for (r, s) in combos]
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
               "interpretation": "the latest complete year, 2025, by month (today's default; a change to it must be declared)",
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
        "within_month": [{"sex": s, **pct(sum(v["sex"] == s for v in may), len(may))} for s in sexes],
        "within_period": [{"sex": s, **pct(sum(v["sex"] == s for v in may), len(victims))} for s in sexes],
        "within_group": [{"race": r, "sex": s, **pct(sum(v["race"] == r and v["sex"] == s for v in may), by_month_race[r])}
                         for r in sorted(by_month_race) for s in sexes],
        "must_not": ["recompute shares over only the displayed cells", "substitute one scope for another"],
    }


# --------------------------------------------------------------- R: rates and partial years
def r_houston_murder_rate():
    victims = Counter(v["incident_date"][:4] for v in rows("houston_09a_victims_2018_2026.csv"))
    status = agency_month_status("TXHPD0000")
    pop = {"2018": 2296862, "2019": 2307560}  # nibrs.db agencies.population for TXHPD0000, read 2026-10-28
    out = []
    for y in ("2018", "2019"):
        reported = [m for m in months(f"{y}-01", f"{y}-12") if status(m)[0] == "REPORTED_CRIMES"]
        row = {"year": int(y), "murder_victims": victims[y], "months_with_data": len(reported), "population": pop[y],
               "population_source": "FBI agency population (nibrs.db agencies.population) for the data year"}
        if len(reported) == 12:
            row["rate_per_100k"] = round(victims[y] * 100000 / pop[y], 2)
        else:
            row["rate_per_100k"] = None
            row["rate_unavailable_reason"] = f"only {len(reported)} of 12 months have Houston NIBRS data; an annual rate needs the agency's whole year (numerator and denominator use the same agency-period eligibility, D6)"
        out.append(row)
    return {"case": "R", "question": "Murder victim rate per 100,000 residents in Houston, 2018 and 2019.",
            "counting_unit": "victim", "rows": out}


CASES = {
    "N1-houston-murder-victims-race-sex-monthly-share.json": n1_houston_murder_victims_race_sex,
    "N2-memphis-23f-with-stolen-firearm-2024.json": n2_memphis_23f_with_stolen_firearm,
    "N3-baltimore-motor-vehicle-theft-2022-01-to-2026-06.json": n3_baltimore_240_by_month,
    "N4-frozen-release-H1-H3-memphis-carjacking.json": n4_memphis_carjacking,
    "Z-houston-09c-missing-zero-unknown.json": z_houston_justifiable_homicide_months,
    "D-denominator-scopes.json": d_denominator_scopes,
    "R-houston-murder-rate-partial-year.json": r_houston_murder_rate,
}


def check_micro():
    """Cross-check the hand-traced micro expectations against the micro extract."""
    with open(os.path.join(EXPECTED, "micro.json"), encoding="utf-8") as f:
        micro = json.load(f)
    seg = {t: rows(f"micro/{t}.csv") for t in ("incidents", "offenses", "victims", "offenders", "property", "arrestees")}
    bad = []
    for case in micro["cases"]:
        key = lambda r: r["ori"] == case["ori"] and r["year"] == str(case["data_year"]) and r["incident_num"] == case["incident_num"]
        s = {t: [r for r in v if key(r)] for t, v in seg.items()}
        conn = lambda v: [c for c in (v["connected_offense_1"], v["connected_offense_2"], v["connected_offense_3"]) if c]
        got = {
            "offense_segments": len(s["offenses"]),
            "victim_segments": len(s["victims"]),
            "victim_offense_pairs": sum(len(conn(v)) for v in s["victims"]),
            "offender_segments": len(s["offenders"]),
            "known_offenders": sum(o["offender_sequence"] != "00" for o in s["offenders"]),
            "arrestee_segments": len(s["arrestees"]),
            "property_segments": len(s["property"]),
        }
        for k, v in got.items():
            if case["counts"].get(k) != v:
                bad.append(f"{case['id']}: {k} hand={case['counts'].get(k)} extract={v}")
    return bad


def main():
    check = "--check" in sys.argv
    os.makedirs(EXPECTED, exist_ok=True)
    failures = check_micro()
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
