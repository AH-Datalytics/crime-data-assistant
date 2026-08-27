import csv
import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

from current_trends_build_receipt import sha256_text


SPEC = importlib.util.spec_from_file_location("update_rtci_db", Path(__file__).with_name("update-rtci-db.py"))
UPDATE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(UPDATE)


class UpdateRtciReceiptIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "crime.db"

    def tearDown(self):
        self.temp.cleanup()

    def create_monthly_schema(self):
        db = sqlite3.connect(self.db_path)
        db.executescript("""
            CREATE TABLE agency_monthly (
              ori TEXT, agency TEXT, state TEXT, type TEXT, year INTEGER,
              month INTEGER, offense TEXT, count INTEGER
            );
            CREATE TABLE agencies (ori TEXT, agency TEXT, state TEXT, type TEXT);
            CREATE TABLE sample_agencies (ori TEXT, agency TEXT, state TEXT, type TEXT);
            CREATE TABLE national_monthly (
              year INTEGER, month INTEGER, offense TEXT, count INTEGER, agency_count INTEGER
            );
            CREATE TABLE state_monthly (
              state TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER, agency_count INTEGER
            );
            INSERT INTO agencies VALUES ('AA0000000', 'Alpha', 'AA', 'City');
        """)
        db.commit()
        db.close()

    def test_monthly_update_writes_reconciled_receipt(self):
        self.create_monthly_schema()
        records = [("AA0000000", "Alpha", "AA", "City", 2025, 1, "Murder", 2)]
        UPDATE.update_local_db(
            str(self.db_path), records, True, 2025, 1,
            source_rows=1, excluded_rows=0, source_sha256=sha256_text("monthly fixture"),
        )
        db = sqlite3.connect(self.db_path)
        receipt = db.execute("""
            SELECT component, source_version, expected_rows, actual_rows, status
            FROM source_build_receipts
        """).fetchone()
        db.close()
        self.assertEqual(receipt, ("current_trends_monthly", "2025-01", 1, 1, "complete"))

    def test_population_refresh_writes_only_after_values_reconcile(self):
        db = sqlite3.connect(self.db_path)
        db.executescript("""
            CREATE TABLE sample_agencies (ori TEXT, agency TEXT, state TEXT, type TEXT);
            CREATE TABLE agency_population (ori TEXT, year INTEGER, population INTEGER);
            INSERT INTO sample_agencies VALUES ('AA0000000', 'Alpha', 'AA', 'City');
        """)
        db.commit()
        db.close()
        source = Path(self.temp.name) / "populations.csv"
        with source.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["size", "id", "year", "population"])
            writer.writeheader()
            writer.writerow({"size": "all", "id": "AA0000000", "year": 2025, "population": 12345})

        UPDATE.refresh_populations(str(self.db_path), str(source))
        db = sqlite3.connect(self.db_path)
        population = db.execute("SELECT population FROM agency_population").fetchone()[0]
        receipt = db.execute("""
            SELECT component, expected_rows, actual_rows, status FROM source_build_receipts
        """).fetchone()
        db.close()
        self.assertEqual(population, 12345)
        self.assertEqual(receipt, ("current_trends_population", 1, 1, "complete"))


class MonthlyProjectionAlignmentTests(unittest.TestCase):
    """state_monthly must advance with the other two projections, in the same transaction.

    Before this, a monthly update advanced agency_monthly and national_monthly and silently left
    state_monthly on the previous month, so a state-scoped question answered a month behind an
    agency one.
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "crime.db"
        db = sqlite3.connect(self.db_path)
        db.executescript("""
            CREATE TABLE agency_monthly (
              ori TEXT, agency TEXT, state TEXT, type TEXT, year INTEGER,
              month INTEGER, offense TEXT, count INTEGER
            );
            CREATE TABLE agencies (ori TEXT, agency TEXT, state TEXT, type TEXT);
            CREATE TABLE sample_agencies (ori TEXT, agency TEXT, state TEXT, type TEXT);
            CREATE TABLE national_monthly (
              year INTEGER, month INTEGER, offense TEXT, count INTEGER, agency_count INTEGER
            );
            CREATE TABLE state_monthly (
              state TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER, agency_count INTEGER
            );
            -- Only ALPHA is in the national aggregation cohort; BRAVO shares its state.
            INSERT INTO agencies VALUES ('AA0000001', 'Alpha', 'AA', 'City');
            INSERT INTO agencies VALUES ('AA0000002', 'Bravo', 'AA', 'City');
            INSERT INTO sample_agencies VALUES ('AA0000001', 'Alpha', 'AA', 'City');
        """)
        db.commit()
        db.close()

    def tearDown(self):
        self.temp.cleanup()

    RECORDS = [
        ("AA0000001", "Alpha", "AA", "City", 2026, 6, "Murder", 4),
        ("AA0000002", "Bravo", "AA", "City", 2026, 6, "Murder", 3),
    ]

    def run_update(self, records=None, year=2026, month=6):
        UPDATE.update_local_db(
            str(self.db_path), records or self.RECORDS, False, year, month,
            source_rows=2, excluded_rows=0, source_sha256=sha256_text("monthly fixture"),
        )

    def test_all_three_projections_reach_the_imported_month(self):
        self.run_update()
        db = sqlite3.connect(self.db_path)
        maxima = {
            table: db.execute(f"SELECT MAX(year*100+month) FROM {table}").fetchone()[0]
            for table in UPDATE.MONTHLY_PROJECTIONS
        }
        db.close()
        self.assertEqual(maxima, {t: 202606 for t in UPDATE.MONTHLY_PROJECTIONS})

    def test_state_monthly_aggregates_every_agency_not_the_national_sample(self):
        """The cohort rule, asserted by behaviour.

        build_db.py aggregates state_monthly from 'complete reporters'; update-rtci.py aggregates
        from every agency. Measured against production, the all-agencies rule reproduces all 36,725
        rows and the other reproduces 13,338 -- so the all-agencies rule is the series production
        serves. Bravo is outside sample_agencies: the state total must still include it, while the
        national total must not.
        """
        self.run_update()
        db = sqlite3.connect(self.db_path)
        state = db.execute(
            "SELECT count, agency_count FROM state_monthly WHERE state='AA' AND year=2026 AND month=6"
        ).fetchone()
        national = db.execute(
            "SELECT count, agency_count FROM national_monthly WHERE year=2026 AND month=6"
        ).fetchone()
        db.close()
        self.assertEqual(state, (7, 2), "state_monthly must carry Alpha + Bravo")
        self.assertEqual(national, (4, 1), "national_monthly must carry only the sample cohort")

    def test_state_monthly_equals_a_recomputation_from_agency_monthly(self):
        """Bind the rule by recomputing it, never by restating its SQL.

        A copy of an aggregation drifts with the aggregation, so this compares against a value
        derived from agency_monthly rather than against a second copy of the INSERT.
        """
        self.run_update()
        db = sqlite3.connect(self.db_path)
        stored = db.execute(
            "SELECT state, year, month, offense, count, agency_count FROM state_monthly ORDER BY 1,2,3,4"
        ).fetchall()
        recomputed = db.execute("""
            SELECT state, year, month, offense, SUM(count), COUNT(DISTINCT ori)
            FROM agency_monthly GROUP BY state, year, month, offense ORDER BY 1,2,3,4
        """).fetchall()
        db.close()
        self.assertEqual(stored, recomputed)

    def test_reimporting_the_same_month_is_idempotent(self):
        self.run_update()
        db = sqlite3.connect(self.db_path)
        before = {t: db.execute(f"SELECT * FROM {t} ORDER BY 1,2,3,4").fetchall()
                  for t in UPDATE.MONTHLY_PROJECTIONS}
        db.close()
        self.run_update()
        db = sqlite3.connect(self.db_path)
        after = {t: db.execute(f"SELECT * FROM {t} ORDER BY 1,2,3,4").fetchall()
                 for t in UPDATE.MONTHLY_PROJECTIONS}
        db.close()
        self.assertEqual(before, after)

    def test_a_lagging_projection_raises_and_commits_nothing(self):
        """The guard runs before the receipt and before the single commit."""
        db = sqlite3.connect(self.db_path)
        # A later period in state_monthly alone: the three maxima can no longer agree.
        db.execute("INSERT INTO state_monthly VALUES ('AA', 2026, 7, 'Murder', 1, 1)")
        db.commit()
        db.close()
        with self.assertRaisesRegex(RuntimeError, "monthly projections disagree"):
            self.run_update()
        db = sqlite3.connect(self.db_path)
        receipts = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_build_receipts'"
        ).fetchone()
        agency = db.execute("SELECT COUNT(*) FROM agency_monthly").fetchone()[0]
        db.close()
        self.assertIsNone(receipts, "no receipt may exist after a refused import")
        self.assertEqual(agency, 0, "the refused import must not leave agency rows behind")

    def test_alignment_guard_names_a_table_missing_the_imported_period(self):
        db = sqlite3.connect(self.db_path)
        db.executescript("""
            INSERT INTO agency_monthly VALUES ('AA0000001','Alpha','AA','City',2026,6,'Murder',4);
            INSERT INTO national_monthly VALUES (2026, 6, 'Murder', 4, 1);
        """)
        db.commit()
        with self.assertRaisesRegex(RuntimeError, "imported period missing from state_monthly"):
            UPDATE.assert_monthly_projections_aligned(db, 2026, 6)
        db.close()

    def test_the_receipt_records_all_three_projections(self):
        self.run_update()
        db = sqlite3.connect(self.db_path)
        counts = db.execute(
            "SELECT table_counts_json FROM source_build_receipts WHERE component='current_trends_monthly'"
        ).fetchone()[0]
        db.close()
        self.assertIn('"state_monthly"', counts)
        self.assertIn('"national_monthly"', counts)
        self.assertIn('"agency_monthly"', counts)


if __name__ == "__main__":
    unittest.main()
