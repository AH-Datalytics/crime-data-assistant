#!/usr/bin/env python3
"""
Regression tests for the SHR incidents.population repair.

THESE PROTECT TWO BUGS I ACTUALLY SHIPPED AND HAD TO REVERT
----------------------------------------------------------
1. COLLISION DETECTION WAS SCOPED PER YEAR. OK05502 hosts both "Del City" and
   "Oklahoma Department of Corrections" under one 7-character RETA ORI. In 2025
   both appear, so that year showed two distinct populations and was excluded. In
   2026 only the Department of Corrections reported, so the year looked
   unambiguous -- and 4 of its incidents were given Del City's population of
   21,141. Detection must be scoped to the ORI across ALL years.

2. DISTINCT AGENCY NAMES WERE INVISIBLE. The audit grouped by
   (ori, year, population) without agency, so SQLite returned an arbitrary name
   per group and two agencies sharing one ORI *and* one population collapsed into
   a single row. That hid 6 of 14 colliding ORIs, mostly California Highway
   Patrol area offices -- CA01999 alone covers six distinct Los Angeles offices.

Both were caught by diffing against a backup, not by design. These tests make the
next occurrence fail loudly instead.

Usage: python scripts/test_shr_incident_populations.py
"""

import importlib.util
import os
import sqlite3
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "audit_shr", os.path.join(_HERE, "audit_shr_incident_populations.py")
)
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

PASSED = 0
FAILED = 0


def check(name, condition, detail=""):
    global PASSED, FAILED
    if condition:
        print(f"  PASS  {name}")
        PASSED += 1
    else:
        print(f"  FAIL  {name}" + (f"\n        {detail}" if detail else ""))
        FAILED += 1


def build(tmp, incidents, agencies, csv_rows):
    """incidents: (ori7, agency, state, year, population, n)"""
    shr_path = os.path.join(tmp, "shr.db")
    crime_path = os.path.join(tmp, "crime_data.db")
    csv_path = os.path.join(tmp, "populations.csv")

    shr = sqlite3.connect(shr_path)
    shr.execute(
        "CREATE TABLE incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, ori TEXT, agency TEXT, "
        "state TEXT, year INTEGER, population INTEGER)"
    )
    for ori, agency, state, year, population, count in incidents:
        for _ in range(count):
            shr.execute(
                "INSERT INTO incidents (ori, agency, state, year, population) VALUES (?,?,?,?,?)",
                (ori, agency, state, year, population),
            )
    shr.commit()
    shr.close()

    crime = sqlite3.connect(crime_path)
    crime.execute("CREATE TABLE historical_agency (ori TEXT PRIMARY KEY, agency TEXT, state TEXT, type TEXT)")
    for ori9 in agencies:
        crime.execute("INSERT INTO historical_agency VALUES (?,?,?,?)", (ori9, "x", "xx", "city"))
    crime.commit()
    crime.close()

    with open(csv_path, "w", encoding="utf-8", newline="") as handle:
        handle.write("id,size,year,population,agencies\n")
        for ori9, year, population in csv_rows:
            handle.write(f"{ori9},all,{year},{population},1\n")

    return shr_path, crime_path, csv_path


def run(shr_path, crime_path, csv_path, apply_it, years="2025,2026"):
    argv = sys.argv
    sys.argv = ["audit", "--shr-db", shr_path, "--crime-db", crime_path,
                "--pop-csv", csv_path, "--years", years]
    if apply_it:
        sys.argv.append("--apply")
    try:
        audit.main()
    finally:
        sys.argv = argv


def populations(shr_path, ori, year):
    conn = sqlite3.connect(shr_path)
    values = [r[0] for r in conn.execute(
        "SELECT population FROM incidents WHERE ori=? AND year=?", (ori, year)
    )]
    conn.close()
    return values


print("\n1. A colliding ORI is excluded in EVERY year, not only where both agencies report")
with tempfile.TemporaryDirectory() as tmp:
    # Exactly the OK05502 shape that produced the 4 bad rows.
    shr_path, crime_path, csv_path = build(
        tmp,
        incidents=[
            ("OK05502", "Del City", "OK", 2025, 21141, 1),
            ("OK05502", "Oklahoma Department of C", "OK", 2025, 0, 10),
            # 2026: only ONE agency reports, so the year looks unambiguous.
            ("OK05502", "Oklahoma Department of C", "OK", 2026, 0, 4),
        ],
        agencies=["OK0550200"],
        csv_rows=[("OK0550200", 2025, 21141), ("OK0550200", 2026, 21141)],
    )
    run(shr_path, crime_path, csv_path, apply_it=True)
    got_2026 = populations(shr_path, "OK05502", 2026)
    check(
        "the year where only one agency reports is NOT overwritten",
        got_2026 == [0, 0, 0, 0],
        f"got {got_2026} -- Del City's population was written onto Dept of Corrections incidents",
    )
    got_2025 = sorted(populations(shr_path, "OK05502", 2025))
    check("the visibly-conflicting year is also untouched", got_2025 == [0] * 10 + [21141], f"got {got_2025}")

print("\n2. Distinct agency names sharing one ORI AND one population are still detected")
with tempfile.TemporaryDirectory() as tmp:
    # The CHP shape: two offices, one ORI, identical population, so grouping
    # without `agency` collapses them and the collision disappears.
    shr_path, crime_path, csv_path = build(
        tmp,
        incidents=[
            ("CA01999", "Hp: Newhall Area Office", "CA", 2025, 5000, 3),
            ("CA01999", "Hp: East Los Angeles Are", "CA", 2025, 5000, 2),
        ],
        agencies=["CA0199900"],
        csv_rows=[("CA0199900", 2025, 9999)],
    )
    run(shr_path, crime_path, csv_path, apply_it=True)
    got = populations(shr_path, "CA01999", 2025)
    check(
        "identical populations under two agency names are treated as a collision",
        got == [5000] * 5,
        f"got {got} -- a collision was overwritten because agency was not in the GROUP BY",
    )

print("\n3. Bucket C (no authoritative source) is preserved")
with tempfile.TemporaryDirectory() as tmp:
    shr_path, crime_path, csv_path = build(
        tmp,
        incidents=[("AK00125", "Some Tribal PD", "AK", 2025, 0, 3)],
        agencies=["AK0012500"],
        csv_rows=[("MOKPD0000", 2025, 518039)],  # nothing for AK0012500
    )
    run(shr_path, crime_path, csv_path, apply_it=True)
    got = populations(shr_path, "AK00125", 2025)
    check("a row with no CSV value is left unchanged", got == [0, 0, 0], f"got {got}")

print("\n4. A genuinely correctable row IS fixed (the test must not pass by doing nothing)")
with tempfile.TemporaryDirectory() as tmp:
    shr_path, crime_path, csv_path = build(
        tmp,
        incidents=[("MOKPD00", "Kansas City", "MO", 2025, 317692, 5)],
        agencies=["MOKPD0000"],
        csv_rows=[("MOKPD0000", 2025, 518039)],
    )
    run(shr_path, crime_path, csv_path, apply_it=False)
    got = populations(shr_path, "MOKPD00", 2025)
    check("without --apply nothing is written", got == [317692] * 5, f"got {got}")
    run(shr_path, crime_path, csv_path, apply_it=True)
    got = populations(shr_path, "MOKPD00", 2025)
    check("with --apply the correctable row is fixed", got == [518039] * 5, f"got {got}")

print("\n5. An unresolved ORI (tier 4) is never written")
with tempfile.TemporaryDirectory() as tmp:
    # ori7 + '00' does not exist in historical_agency and no prefix matches.
    shr_path, crime_path, csv_path = build(
        tmp,
        incidents=[("ZZ99999", "Nowhere PD", "ZZ", 2025, 111, 2)],
        agencies=["MOKPD0000"],
        csv_rows=[("ZZ9999900", 2025, 222)],
    )
    run(shr_path, crime_path, csv_path, apply_it=True)
    got = populations(shr_path, "ZZ99999", 2025)
    check("tier-4 (unverified) ORI is not overwritten even when the CSV has a value",
          got == [111, 111], f"got {got}")

print("\n6. The ORI_MAP exception is honoured, not bare padding")
with tempfile.TemporaryDirectory() as tmp:
    # INIPD00 must resolve to IN0494900, NOT to INIPD0000.
    shr_path, crime_path, csv_path = build(
        tmp,
        incidents=[("INIPD00", "Indianapolis", "IN", 2025, 100000, 2)],
        agencies=["IN0494900", "INIPD0000"],
        # Only the mapped ORI has an authoritative value; the padded one has a
        # decoy that must never be used.
        csv_rows=[("IN0494900", 2025, 887213), ("INIPD0000", 2025, 1)],
    )
    run(shr_path, crime_path, csv_path, apply_it=True)
    got = populations(shr_path, "INIPD00", 2025)
    check("resolves via ORI_MAP to IN0494900", got == [887213, 887213],
          f"got {got} -- expected the mapped agency's population, not the padded decoy")

print(f"\n{'FAILURES present.' if FAILED else f'All {PASSED} SHR incident population checks passed.'}")
sys.exit(1 if FAILED else 0)
