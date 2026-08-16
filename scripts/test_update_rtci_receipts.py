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


if __name__ == "__main__":
    unittest.main()
