#!/usr/bin/env python3
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class RollupBenchmarkTest(unittest.TestCase):
    def test_replays_eligible_logged_query(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, rollup, query_log, report = (root / name for name in ("source.db", "rollup.db", "query_log.db", "report.json"))
            db = sqlite3.connect(source)
            db.execute("CREATE TABLE summary_arrestee_demographics (year INT, race TEXT, age_group TEXT, arrestee_count INT)")
            db.close()
            db = sqlite3.connect(rollup)
            db.execute("CREATE TABLE national_summary_arrestee_demographics (state TEXT, year INT, race TEXT, age_group TEXT, arrestee_count INT)")
            db.execute("INSERT INTO national_summary_arrestee_demographics VALUES ('US',2024,'W','Under 18',38)")
            db.commit(); db.close()
            sql = "SELECT race,SUM(arrestee_count) arrests FROM summary_arrestee_demographics WHERE age_group='Under 18' GROUP BY race"
            db = sqlite3.connect(query_log)
            db.execute("CREATE TABLE query_log (id INT, ts INT, tab TEXT, question TEXT, sql TEXT, ms INT)")
            db.execute("INSERT INTO query_log VALUES (1,1778000000000,'nibrs','juvenile arrests by race nationally',?,38000)", (sql,))
            db.commit(); db.close()

            subprocess.run([
                sys.executable, str(Path(__file__).with_name("benchmark-nibrs-rollups.py")),
                "--query-log", str(query_log), "--source", str(source), "--rollup", str(rollup),
                "--output", str(report),
            ], check=True, capture_output=True, text=True)
            result = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(result["successful"], 1)
            self.assertEqual(result["queries"][0]["rows"], 1)
            self.assertEqual(result["queries"][0]["baseline_ms"], 38000)


if __name__ == "__main__":
    unittest.main()
