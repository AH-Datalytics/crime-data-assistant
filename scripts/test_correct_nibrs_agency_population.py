#!/usr/bin/env python3
"""Tests for correct-nibrs-agency-population.py: compute statuses, apply (dry run and commit), the stale-value
guard, the input checks and restore. Uses temporary files only; the locks are replaced by no-ops.

Usage: python scripts/test_correct_nibrs_agency_population.py
"""

import contextlib
import csv
import importlib.util
import os
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

spec = importlib.util.spec_from_file_location("correct_pop", SCRIPTS / "correct-nibrs-agency-population.py")
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)

import nibrs_maintenance_lock  # noqa: E402

nibrs_maintenance_lock.held = lambda *a, **k: contextlib.nullcontext()
C._release_lock = lambda: None


def bh(ori, slots):
    line = list("BH00" + ori.ljust(9) + " " * 247)
    for k, v in enumerate(slots):
        start = 105 + 24 * k
        line[start:start + 9] = " " * 9 if v is None else str(v).rjust(9, "0")
    return "".join(line)


def make_db(path):
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE agencies (ori TEXT, year INT, state TEXT, population INT);
        CREATE TABLE summary_clearance_city_annual (ori TEXT, year INT, ucr_offense_code TEXT, population INT);
        CREATE TABLE summary_carjacking_clearance (ori TEXT, year INT, month INT, population INT);
        CREATE TABLE agency_reporting_gaps (ori TEXT, year INT, population INT, PRIMARY KEY (ori, year));
        INSERT INTO agencies VALUES ('MOKPD0000', 2025, 'MO', 317692), ('TX0000001', 2025, 'TX', 5000),
                                    ('MOKPD0000', 2024, 'MO', 314045);
        INSERT INTO summary_clearance_city_annual VALUES ('MOKPD0000', 2025, '09A', 317692), ('MOKPD0000', 2025, '120', 317692),
                                                         ('TX0000001', 2025, '09A', 5000), ('MOKPD0000', 2024, '09A', 314045);
        INSERT INTO summary_carjacking_clearance VALUES ('MOKPD0000', 2025, 1, 317692);
        INSERT INTO agency_reporting_gaps VALUES ('MOKPD0000', 2025, 317692), ('MOKPD0000', 2024, 317692);
    """)
    conn.commit()
    conn.close()


def snapshot(path):
    conn = sqlite3.connect(path)
    try:
        return {t: sorted(conn.execute(f"SELECT * FROM {t}").fetchall()) for t in
                ("agencies", "summary_clearance_city_annual", "summary_carjacking_clearance", "agency_reporting_gaps")}
    finally:
        conn.close()


def write_corrections(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(C.FIELDS)
        w.writerows(rows)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.db = os.path.join(self.dir, "nibrs.db")
        make_db(self.db)
        self.csv = os.path.join(self.dir, "corrections.csv")
        write_corrections(self.csv, [(2025, "MOKPD0000", 317692, 317692, 518039, "change")])

    def tearDown(self):
        self.tmp.cleanup()

    def backup(self, name="bk.db"):
        return os.path.join(self.dir, name)


class Apply(Base):
    def test_dry_run_changes_nothing(self):
        before = snapshot(self.db)
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=False), C.EXIT_OK)
        self.assertEqual(snapshot(self.db), before)
        self.assertTrue(os.path.exists(self.backup()))

    def test_commit_updates_agency_and_copies_only(self):
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_OK)
        after = snapshot(self.db)
        self.assertIn(("MOKPD0000", 2025, "MO", 518039), after["agencies"])
        self.assertIn(("MOKPD0000", 2024, "MO", 314045), after["agencies"])  # other year untouched
        self.assertIn(("TX0000001", 2025, "TX", 5000), after["agencies"])
        self.assertEqual([r for r in after["summary_clearance_city_annual"] if r[0] == "MOKPD0000" and r[1] == 2025],
                         [("MOKPD0000", 2025, "09A", 518039), ("MOKPD0000", 2025, "120", 518039)])
        self.assertIn(("MOKPD0000", 2024, "09A", 314045), after["summary_clearance_city_annual"])
        self.assertEqual(after["summary_carjacking_clearance"], [("MOKPD0000", 2025, 1, 518039)])
        # agency_reporting_gaps holds the all-year maximum, in every year of the ORI.
        self.assertEqual(after["agency_reporting_gaps"], [("MOKPD0000", 2024, 518039), ("MOKPD0000", 2025, 518039)])

    def test_stale_value_refused(self):
        write_corrections(self.csv, [(2025, "MOKPD0000", 300000, 300000, 518039, "change")])
        before = snapshot(self.db)
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_REFUSED)
        self.assertEqual(snapshot(self.db), before)

    def test_copy_out_of_step_refused(self):
        conn = sqlite3.connect(self.db)
        conn.execute("UPDATE summary_carjacking_clearance SET population = 1")
        conn.commit()
        conn.close()
        before = snapshot(self.db)
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_REFUSED)
        self.assertEqual(snapshot(self.db), before)

    def test_existing_backup_refused(self):
        Path(self.backup()).write_bytes(b"")
        before = snapshot(self.db)
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_REFUSED)
        self.assertEqual(snapshot(self.db), before)

    def test_bad_inputs_refused(self):
        for rows in ([(2025, "MOKPD0000", 317692, 317692, 100_000_000, "change")],
                     [(2025, "MOKPD0000", 317692, 317692, 518039, "change")] * 2,
                     [(2025, "MOKPD0000", 317692, 317692, 317692, "change")]):
            write_corrections(self.csv, rows)
            self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_REFUSED)

    def test_only_change_rows_applied(self):
        write_corrections(self.csv, [(2025, "MOKPD0000", 317692, 317692, 518039, "change"),
                                     (2025, "TX0000001", 5000, 4000, 9000, "mismatch")])
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_OK)
        self.assertIn(("TX0000001", 2025, "TX", 5000), snapshot(self.db)["agencies"])

    def test_gaps_keep_max_from_another_year(self):
        # The corrected year stays below the ORI's maximum in another year: the gap rows keep that maximum.
        conn = sqlite3.connect(self.db)
        conn.execute("INSERT INTO agencies VALUES ('TX0000009', 2024, 'TX', 90000), ('TX0000009', 2025, 'TX', 60000)")
        conn.execute("INSERT INTO agency_reporting_gaps VALUES ('TX0000009', 2024, 90000), ('TX0000009', 2025, 90000)")
        conn.commit()
        conn.close()
        write_corrections(self.csv, [(2025, "TX0000009", 60000, 60000, 70000, "change")])
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_OK)
        after = snapshot(self.db)
        self.assertIn(("TX0000009", 2025, "TX", 70000), after["agencies"])
        self.assertEqual([r for r in after["agency_reporting_gaps"] if r[0] == "TX0000009"],
                         [("TX0000009", 2024, 90000), ("TX0000009", 2025, 90000)])

    def test_gap_not_at_maximum_refused(self):
        conn = sqlite3.connect(self.db)
        conn.execute("UPDATE agency_reporting_gaps SET population = 1 WHERE year = 2024")
        conn.commit()
        conn.close()
        before = snapshot(self.db)
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_REFUSED)
        self.assertEqual(snapshot(self.db), before)

    def test_duplicate_agency_row_refused(self):
        conn = sqlite3.connect(self.db)
        conn.execute("INSERT INTO agencies VALUES ('MOKPD0000', 2025, 'MO', 317692)")
        conn.commit()
        conn.close()
        before = snapshot(self.db)
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_REFUSED)
        self.assertEqual(snapshot(self.db), before)

    def test_null_old_population(self):
        conn = sqlite3.connect(self.db)
        conn.execute("INSERT INTO agencies VALUES ('TX0000008', 2025, 'TX', NULL)")
        conn.commit()
        conn.close()
        write_corrections(self.csv, [(2025, "TX0000008", "", "", 1200, "change")])
        before = snapshot(self.db)
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_OK)
        self.assertIn(("TX0000008", 2025, "TX", 1200), snapshot(self.db)["agencies"])
        self.assertEqual(C.restore(self.db, self.backup()), C.EXIT_OK)
        self.assertEqual(snapshot(self.db), before)

    def test_restore_refuses_changed_identity(self):
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_OK)
        # A rebuild reuses the rowid for a different agency.
        conn = sqlite3.connect(self.db)
        rowid = conn.execute("SELECT rowid FROM agencies WHERE ori = 'MOKPD0000' AND year = 2025").fetchone()[0]
        conn.execute("UPDATE agencies SET ori = 'XX0000001' WHERE rowid = ?", (rowid,))
        conn.commit()
        conn.close()
        mid = snapshot(self.db)
        self.assertEqual(C.restore(self.db, self.backup()), C.EXIT_REFUSED)
        self.assertEqual(snapshot(self.db), mid)

    def test_restore_refuses_changed_value(self):
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_OK)
        conn = sqlite3.connect(self.db)
        conn.execute("UPDATE summary_carjacking_clearance SET population = 7")
        conn.commit()
        conn.close()
        mid = snapshot(self.db)
        self.assertEqual(C.restore(self.db, self.backup()), C.EXIT_REFUSED)
        self.assertEqual(snapshot(self.db), mid)

    def test_restore_puts_values_back(self):
        before = snapshot(self.db)
        self.assertEqual(C.apply(self.db, self.csv, self.backup(), commit=True), C.EXIT_OK)
        self.assertNotEqual(snapshot(self.db), before)
        self.assertEqual(C.restore(self.db, self.backup()), C.EXIT_OK)
        self.assertEqual(snapshot(self.db), before)


class Compute(Base):
    def test_statuses(self):
        zdir = os.path.join(self.dir, "zips")
        os.mkdir(zdir)
        lines = [bh("MOKPD0000", [317692, 144216, 56034, 97, 0]),   # change
                 bh("TX0000001", [5000]),                            # unchanged
                 bh("TX0000002", [7000, 1000]),                      # not_stored
                 "IN00 not a header line"]
        with zipfile.ZipFile(os.path.join(zdir, "nibrs-2025.zip"), "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("nibrs-2025.txt", "\n".join(lines) + "\n")
        agencies = os.path.join(self.dir, "agencies.csv")
        with open(agencies, "w", newline="") as f:
            csv.writer(f).writerows([("MOKPD0000", 2025, 317692), ("TX0000001", 2025, 5000)])
        out = os.path.join(self.dir, "out.csv")
        self.assertEqual(C.compute(zdir, agencies, out, [2025]), C.EXIT_OK)
        with open(out, newline="") as f:
            rows = {r["ori"]: r for r in csv.DictReader(f)}
        self.assertEqual(rows["MOKPD0000"]["status"], "change")
        self.assertEqual(rows["MOKPD0000"]["fixed"], "518039")
        self.assertEqual(rows["TX0000002"]["status"], "not_stored")
        self.assertNotIn("TX0000001", rows)  # unchanged rows are not written

    def _compute(self, lines, agencies_rows):
        zdir = os.path.join(self.dir, "zips")
        os.makedirs(zdir, exist_ok=True)
        with zipfile.ZipFile(os.path.join(zdir, "nibrs-2025.zip"), "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("nibrs-2025.txt", "\n".join(lines) + "\n")
        agencies = os.path.join(self.dir, "agencies.csv")
        with open(agencies, "w", newline="") as f:
            csv.writer(f).writerows(agencies_rows)
        out = os.path.join(self.dir, "out.csv")
        self.assertEqual(C.compute(zdir, agencies, out, [2025]), C.EXIT_OK)
        with open(out, newline="") as f:
            return {r["ori"]: r for r in csv.DictReader(f)}

    def test_repeated_headers(self):
        rows = self._compute([bh("MOKPD0000", [317692, 200347]), bh("MOKPD0000", [317692, 200347]),   # identical
                              bh("TX0000003", [1000, 2000]), bh("TX0000003", [1000, 3000])],           # conflicting
                             [("MOKPD0000", 2025, 317692), ("TX0000003", 2025, 1000)])
        self.assertEqual(rows["MOKPD0000"]["status"], "change")
        self.assertEqual(rows["TX0000003"]["status"], "conflict")

    def test_duplicate_stored_rows(self):
        rows = self._compute([bh("MOKPD0000", [317692, 200347])],
                             [("MOKPD0000", 2025, 317692), ("MOKPD0000", 2025, 317692)])
        self.assertEqual(rows["MOKPD0000"]["status"], "duplicate_stored")

    def test_thresholds(self):
        zero, crossing = C.report_thresholds(
            {(2025, "A"): 0, (2025, "B"): 40000, (2024, "B"): 45000, (2025, "C"): 60000},
            [(2025, "A", 0, 0, 500, "change"), (2025, "B", 40000, 40000, 55000, "change"),
             (2025, "C", 60000, 60000, 70000, "change")])
        self.assertEqual(zero, [(2025, "A")])
        self.assertEqual(crossing, ["B"])


if __name__ == "__main__":
    unittest.main()
