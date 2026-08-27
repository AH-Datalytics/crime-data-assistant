#!/usr/bin/env python3
"""
Regression tests for the population repair.

THE DEFECT THESE PROTECT
------------------------
refresh_populations() in update-rtci-db.py ran only under --full-rebuild, so
routine monthly updates never applied populations.csv. 470 values in
agency_population were wrong (235 agencies x 2025 and 2026), plus 108 in
historical_agency_population and 132 in historical_agency_crime. Kansas City, MO
sat at RETA's 317,692 against an authoritative 518,039 -- a 38.7% undercount
that inflated every 2025 per-capita rate for a third of RTCI agencies.

Population is a DENOMINATOR. A stale one produces confidently wrong rates rather
than a visible failure, which is why the wiring must not depend on remembering a
flag, and why that specific property is asserted here rather than assumed.

Usage: python scripts/test_refresh_agency_populations.py
"""

import ast
import os
import re
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "refresh_agency_populations",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "refresh_agency_populations.py"),
)
rap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rap)

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


def make_csv(path, rows):
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write("id,size,year,population,agencies\n")
        for ori, year, pop in rows:
            handle.write(f"{ori},all,{year},{pop},1\n")


def make_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE agency_population (ori TEXT, year INTEGER, population INTEGER, PRIMARY KEY (ori, year));
        CREATE TABLE historical_agency_population (ori TEXT, year INTEGER, population INTEGER, PRIMARY KEY (ori, year));
        CREATE TABLE historical_agency_crime (ori TEXT, year INTEGER, population INTEGER, PRIMARY KEY (ori, year));
        """
    )
    return conn


print("\n1. A wrong population is corrected in every table")
with tempfile.TemporaryDirectory() as tmp:
    csv_path = os.path.join(tmp, "populations.csv")
    db_path = os.path.join(tmp, "crime_data.db")
    # KCMO's real numbers: the authoritative value against RETA's undercount.
    make_csv(csv_path, [("MOKPD0000", 2025, 518039), ("MOKPD0000", 2026, 518039),
                        ("TXHPD0000", 2025, 2413559), ("TXHPD0000", 2026, 2413559)])
    conn = make_db(db_path)
    conn.execute("INSERT INTO agency_population VALUES ('MOKPD0000', 2025, 317692)")
    conn.execute("INSERT INTO agency_population VALUES ('MOKPD0000', 2026, 317692)")
    conn.execute("INSERT INTO historical_agency_population VALUES ('MOKPD0000', 2025, 317692)")
    conn.execute("INSERT INTO historical_agency_crime VALUES ('MOKPD0000', 2025, 317692)")
    # A correct row must be left alone.
    conn.execute("INSERT INTO agency_population VALUES ('TXHPD0000', 2025, 2413559)")
    conn.commit()
    conn.close()

    rap.refresh(db_path, csv_path, None, False, list(rap.POPULATION_TABLES))

    conn = sqlite3.connect(db_path)
    got = {
        "agency_population 2025": conn.execute("SELECT population FROM agency_population WHERE ori='MOKPD0000' AND year=2025").fetchone()[0],
        "agency_population 2026": conn.execute("SELECT population FROM agency_population WHERE ori='MOKPD0000' AND year=2026").fetchone()[0],
        "historical_agency_population 2025": conn.execute("SELECT population FROM historical_agency_population WHERE ori='MOKPD0000'").fetchone()[0],
        "historical_agency_crime 2025": conn.execute("SELECT population FROM historical_agency_crime WHERE ori='MOKPD0000'").fetchone()[0],
    }
    untouched = conn.execute("SELECT population FROM agency_population WHERE ori='TXHPD0000' AND year=2025").fetchone()[0]
    conn.close()

    for label, value in got.items():
        check(f"{label} corrected to 518,039", value == 518039, f"got {value}")
    check("an already-correct row is unchanged", untouched == 2413559, f"got {untouched}")

print("\n2. Rows with no authoritative value for that year are left alone")
with tempfile.TemporaryDirectory() as tmp:
    csv_path = os.path.join(tmp, "populations.csv")
    db_path = os.path.join(tmp, "crime_data.db")
    # Contract city: present in the CSV but coverage stops in 2015, so the DB's
    # carry-forward value is intended, not corruption.
    make_csv(csv_path, [("CA030350X", 2015, 98217), ("MOKPD0000", 2025, 518039)])
    conn = make_db(db_path)
    conn.execute("INSERT INTO agency_population VALUES ('CA030350X', 2025, 89699)")
    conn.execute("INSERT INTO agency_population VALUES ('MOKPD0000', 2025, 317692)")
    # Junk ORI that is not a real agency.
    conn.execute("INSERT INTO agency_population VALUES ('NA', 2025, 1203)")
    conn.commit()
    conn.close()

    rap.refresh(db_path, csv_path, [2025], False, ["agency_population"])

    conn = sqlite3.connect(db_path)
    carry = conn.execute("SELECT population FROM agency_population WHERE ori='CA030350X'").fetchone()[0]
    junk = conn.execute("SELECT population FROM agency_population WHERE ori='NA'").fetchone()[0]
    fixed = conn.execute("SELECT population FROM agency_population WHERE ori='MOKPD0000'").fetchone()[0]
    conn.close()
    check("carry-forward row untouched", carry == 89699, f"got {carry}")
    check("invalid ORI untouched", junk == 1203, f"got {junk}")
    check("the genuinely wrong row was still fixed", fixed == 518039, f"got {fixed}")

print("\n3. Preflight refuses ambiguous or unsourceable input")
with tempfile.TemporaryDirectory() as tmp:
    csv_path = os.path.join(tmp, "populations.csv")
    db_path = os.path.join(tmp, "crime_data.db")
    # Same (ori, year) with two different values: the source is ambiguous and we
    # must not silently pick one.
    with open(csv_path, "w", encoding="utf-8", newline="") as handle:
        handle.write("id,size,year,population,agencies\n")
        handle.write("MOKPD0000,all,2025,518039,1\n")
        handle.write("MOKPD0000,all,2025,317692,1\n")
    conn = make_db(db_path)
    conn.execute("INSERT INTO agency_population VALUES ('MOKPD0000', 2025, 317692)")
    conn.commit()
    conn.close()
    raised = False
    try:
        rap.refresh(db_path, csv_path, [2025], False, ["agency_population"])
    except rap.PreflightError:
        raised = True
    check("conflicting duplicate (ori, year) raises PreflightError", raised)

    conn = sqlite3.connect(db_path)
    still = conn.execute("SELECT population FROM agency_population WHERE ori='MOKPD0000'").fetchone()[0]
    conn.close()
    check("nothing was written when preflight failed", still == 317692, f"got {still}")

with tempfile.TemporaryDirectory() as tmp:
    csv_path = os.path.join(tmp, "populations.csv")
    db_path = os.path.join(tmp, "crime_data.db")
    make_csv(csv_path, [("MOKPD0000", 2024, 511437)])
    conn = make_db(db_path)
    conn.execute("INSERT INTO agency_population VALUES ('MOKPD0000', 2025, 317692)")
    conn.commit()
    conn.close()
    raised = False
    try:
        rap.refresh(db_path, csv_path, [2025], False, ["agency_population"])
    except rap.PreflightError:
        raised = True
    check("a target year the CSV cannot source raises PreflightError", raised)

print("\n4. --dry-run writes nothing")
with tempfile.TemporaryDirectory() as tmp:
    csv_path = os.path.join(tmp, "populations.csv")
    db_path = os.path.join(tmp, "crime_data.db")
    make_csv(csv_path, [("MOKPD0000", 2025, 518039)])
    conn = make_db(db_path)
    conn.execute("INSERT INTO agency_population VALUES ('MOKPD0000', 2025, 317692)")
    conn.commit()
    conn.close()
    rap.refresh(db_path, csv_path, [2025], True, ["agency_population"])
    conn = sqlite3.connect(db_path)
    value = conn.execute("SELECT population FROM agency_population WHERE ori='MOKPD0000'").fetchone()[0]
    conn.close()
    check("dry-run left the wrong value in place", value == 317692, f"got {value}")

print("\n5. Routine updates refresh populations WITHOUT --full-rebuild")
source_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "update-rtci-db.py")
source = open(source_path, encoding="utf-8").read()

# ASSERTED FROM THE SYNTAX TREE, NOT FROM INDENTATION.
#
# This used to regex the literal text `refresh_populations(db_path, args.pop_csv)` and require it to
# sit exactly four spaces deep, on the reasoning that a deeper indent meant a conditional. Both
# halves were proxies rather than the invariant. The call legitimately gained required arguments
# (the expected-digest authorization) and legitimately moved inside a `try:` whose `finally` removes
# the verified-input staging directory -- neither of which makes it conditional, and both of which
# broke a text match that was never checking what it claimed to check.
#
# The invariant is: main() calls refresh_populations UNCONDITIONALLY. That is what is checked now,
# by walking the tree and confirming no `if` encloses the call. try/finally, with, and for are not
# conditionals; `if` is, and `if args.full_rebuild:` was the original defect.
tree = ast.parse(source)
main_fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main"), None)
check("update-rtci-db.py defines main()", main_fn is not None)


def enclosing_conditionals(root, target_name):
    """Every `if` test that encloses a call to `target_name`, as source text."""
    found = []

    def walk(node, guards):
        if isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name) and fn.id == target_name:
                found.append(list(guards))
        for child in ast.iter_child_nodes(node):
            if isinstance(node, ast.If) and child in node.body + node.orelse:
                walk(child, guards + [ast.unparse(node.test)])
            else:
                walk(child, guards)

    if root is not None:
        walk(root, [])
    return found

calls = enclosing_conditionals(main_fn, "refresh_populations")
check("main() calls refresh_populations", len(calls) >= 1, f"found {len(calls)} calls")
for guards in calls:
    check(
        "the call is NOT nested inside a conditional",
        not guards,
        f"guarded by: {guards} -- a --full-rebuild style gate is back",
    )

# The same invariant for the crosswalk rebuild, which has always been unconditional and whose
# absence would silently regress county support the same way.
for guards in enclosing_conditionals(main_fn, "ensure_crosswalk"):
    check("ensure_crosswalk is NOT nested inside a conditional", not guards, f"guarded by: {guards}")

print(f"\n{'FAILURES present.' if FAILED else f'All {PASSED} population repair checks passed.'}")
sys.exit(1 if FAILED else 0)
