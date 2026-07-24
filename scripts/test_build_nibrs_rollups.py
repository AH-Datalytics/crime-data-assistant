#!/usr/bin/env python3
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TABLES = {
    "summary_arrestee_demographics": "ori TEXT,year INT,ucr_arrest_offense TEXT,weapon_category TEXT,race TEXT,sex TEXT,age_group TEXT,ethnicity TEXT,arrestee_count INT,state TEXT",
    "summary_victim_demographics": "ori TEXT,year INT,ucr_offense_code TEXT,weapon_category TEXT,race TEXT,sex TEXT,age_group TEXT,ethnicity TEXT,victim_count INT,state TEXT",
    "summary_offender_demographics": "ori TEXT,year INT,ucr_offense_code TEXT,weapon_category TEXT,race TEXT,sex TEXT,age_group TEXT,ethnicity TEXT,offender_count INT,state TEXT",
    "summary_victim_relationship": "state TEXT,ori TEXT,year INT,ucr_offense_code TEXT,relationship_code TEXT,sex TEXT,race TEXT,age_group TEXT,victim_count INT",
    "summary_victim_weapon": "ori TEXT,year INT,ucr_offense_code TEXT,weapon_type TEXT,victim_count INT,state TEXT",
    "summary_victim_circumstance": "ori TEXT,year INT,ucr_offense_code TEXT,circumstance_code TEXT,victim_count INT,state TEXT",
    "summary_victim_weapon_circumstance_demo": "state TEXT,ori TEXT,year INT,ucr_offense_code TEXT,weapon_type TEXT,circumstance_code TEXT,sex TEXT,race TEXT,age_group TEXT,victim_count INT",
    "summary_clearance_type": "year INT,month INT,state TEXT,ori TEXT,ucr_offense_code TEXT,total_offenses INT,cleared_by_arrest INT,cleared_exceptional INT",
    "summary_clearance_detail": "year INT,state TEXT,ori TEXT,ucr_offense_code TEXT,cleared_by_arrest INT,cleared_A INT,cleared_B INT,cleared_C INT,cleared_D INT,cleared_E INT,total_offenses INT",
}


class RollupBuilderTest(unittest.TestCase):
    def test_exact_state_and_national_totals(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.db"
            output = Path(tmp) / "rollups.db"
            db = sqlite3.connect(source)
            for table, columns in TABLES.items():
                db.execute(f"CREATE TABLE {table} ({columns})")
            db.executemany(
                "INSERT INTO summary_arrestee_demographics VALUES (?,?,?,?,?,?,?,?,?,?)",
                [("A", 2024, "90D", "Unknown", "W", "M", "Under 18", "N", 3, "TX"),
                 ("B", 2024, "90D", "Unknown", "W", "M", "Under 18", "N", 5, "TX"),
                 ("C", 2024, "90D", "Unknown", "B", "F", "Under 18", "N", 7, "OH")],
            )
            db.commit()
            db.close()

            subprocess.run(
                [sys.executable, str(Path(__file__).with_name("build-nibrs-rollups.py")),
                 "--source", str(source), "--output", str(output)],
                check=True, text=True,
            )
            result = sqlite3.connect(output)
            tx = result.execute("SELECT SUM(arrestee_count) FROM state_summary_arrestee_demographics WHERE state='TX'").fetchone()[0]
            us = result.execute("SELECT SUM(arrestee_count) FROM national_summary_arrestee_demographics").fetchone()[0]
            self.assertEqual(tx, 8)
            self.assertEqual(us, 15)
            self.assertEqual(result.execute("SELECT COUNT(*) FROM rollup_metadata WHERE key='schema_version'").fetchone()[0], 1)
            result.close()


if __name__ == "__main__":
    unittest.main()
