import sqlite3
import unittest

from current_trends_build_receipt import sha256_text, write_complete_receipt


class CurrentTrendsBuildReceiptTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript("""
            CREATE TABLE agency_monthly (ori TEXT);
            CREATE TABLE agencies (ori TEXT);
            CREATE TABLE sample_agencies (ori TEXT);
            CREATE TABLE national_monthly (year INTEGER);
            CREATE TABLE state_monthly (state TEXT);
            INSERT INTO agency_monthly VALUES ('A');
            INSERT INTO agencies VALUES ('A');
            INSERT INTO sample_agencies VALUES ('A');
            INSERT INTO national_monthly VALUES (2025);
            INSERT INTO state_monthly VALUES ('AA');
        """)

    def tearDown(self):
        self.db.close()

    def write(self, **overrides):
        values = dict(
            component="current_trends_monthly",
            source_version="2025-01",
            source_sha256=sha256_text("fixture"),
            source_rows=1,
            expected_rows=1,
            actual_rows=1,
        )
        values.update(overrides)
        write_complete_receipt(self.db, **values)

    def test_records_live_table_counts(self):
        self.write()
        row = self.db.execute("SELECT status, table_counts_json FROM source_build_receipts").fetchone()
        self.assertEqual(row[0], "complete")
        self.assertEqual(
            row[1],
            '{"agencies":1,"agency_monthly":1,"national_monthly":1,"sample_agencies":1,"state_monthly":1}',
        )

    def test_refuses_expected_actual_mismatch(self):
        with self.assertRaisesRegex(ValueError, "expected 2 rows but wrote 1"):
            self.write(expected_rows=2)
        self.assertIsNone(self.db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_build_receipts'"
        ).fetchone())

    def test_refuses_missing_component_table(self):
        self.db.execute("DROP TABLE agencies")
        with self.assertRaisesRegex(ValueError, "required table agencies is missing"):
            self.write()

    def test_refuses_false_supplied_counts(self):
        with self.assertRaisesRegex(ValueError, "supplied table counts do not match"):
            self.write(table_counts={"agency_monthly": 999})

    def test_refuses_invalid_digest(self):
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            self.write(source_sha256="not-a-digest")


if __name__ == "__main__":
    unittest.main()
