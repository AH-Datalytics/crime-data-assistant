import sqlite3
import unittest

from current_trends_build_receipt import sha256_text, write_complete_receipt


class NonemptyReceiptTests(unittest.TestCase):
    def test_zero_row_source_cannot_receive_a_complete_receipt(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
            CREATE TABLE agency_monthly (ori TEXT);
            CREATE TABLE agencies (ori TEXT);
            CREATE TABLE sample_agencies (ori TEXT);
            CREATE TABLE national_monthly (year INTEGER);
        """)
        with self.assertRaisesRegex(ValueError, "requires nonempty source and imported rows"):
            write_complete_receipt(
                db,
                component="current_trends_monthly",
                source_version="2025-01",
                source_sha256=sha256_text("empty fixture"),
                source_rows=0,
                expected_rows=0,
                actual_rows=0,
            )
        self.assertIsNone(db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_build_receipts'"
        ).fetchone())
        db.close()

    def test_nonempty_source_cannot_receipt_empty_required_tables(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
            CREATE TABLE agency_monthly (ori TEXT);
            CREATE TABLE agencies (ori TEXT);
            CREATE TABLE sample_agencies (ori TEXT);
            CREATE TABLE national_monthly (year INTEGER);
        """)
        with self.assertRaisesRegex(ValueError, "required table.*empty"):
            write_complete_receipt(
                db,
                component="current_trends_monthly",
                source_version="2025-01",
                source_sha256=sha256_text("fixture"),
                source_rows=1,
                expected_rows=1,
                actual_rows=1,
            )
        db.close()


if __name__ == "__main__":
    unittest.main()
