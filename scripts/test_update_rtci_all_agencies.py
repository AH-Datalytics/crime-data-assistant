import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("update_rtci_db", Path(__file__).with_name("update-rtci-db.py"))
UPDATE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(UPDATE)


def source_row(ori, murder):
    row = {"id": ori, "size": "all", "year": "2026", "month": "5"}
    for column in UPDATE.OFFENSE_MAP:
        row[column] = str(murder if column == "murder_total" else 0)
    return row


class AllAgencyImportTests(unittest.TestCase):
    def test_agencies_outside_national_sample_are_not_dropped(self):
        rows = [source_row("AA0000000", 2), source_row("BB0000000", 3)]
        directory = {"AA0000000": ("Alpha", "AA", "City")}
        records = UPDATE.rows_to_records(rows, directory)
        self.assertEqual({record[0] for record in records}, {"AA0000000", "BB0000000"})
        fallback = next(record for record in records if record[0] == "BB0000000")
        self.assertEqual(fallback[1:4], ("BB0000000", "BB", ""))

    def test_the_national_sample_is_used_only_by_the_aggregate_sql(self):
        source = Path(UPDATE.__file__).read_text(encoding="utf-8")
        conversion = source[source.index("def rows_to_records"):source.index("def get_agency_info")]
        self.assertNotIn("sample_agencies", conversion.split('"""', 2)[-1])
        self.assertIn("JOIN sample_agencies sa ON sa.ori = am.ori", source)

    def test_historical_directory_labels_new_source_ori_when_current_directory_lags(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "crime_data.db"
            conn = sqlite3.connect(db_path)
            conn.execute("CREATE TABLE agencies (ori TEXT, agency TEXT, state TEXT, type TEXT)")
            conn.execute(
                "CREATE TABLE historical_agency (ori TEXT, agency TEXT, state TEXT, type TEXT)"
            )
            conn.executemany(
                "INSERT INTO historical_agency VALUES (?, ?, ?, ?)",
                [
                    ("MI6367300", "Pontiac", "mi", "city"),
                    ("AA0000000", "Unknown State", None, "city"),
                ],
            )
            conn.commit()
            conn.close()

            agency_info = UPDATE.get_agency_info(db_path)
            self.assertEqual(agency_info["MI6367300"], ("Pontiac", "MI", "city"))
            self.assertEqual(agency_info["AA0000000"], ("Unknown State", "AA", "city"))


if __name__ == "__main__":
    unittest.main()
