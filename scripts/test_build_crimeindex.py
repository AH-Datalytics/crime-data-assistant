"""The Crime Index build (scripts/build-crimeindex.py) on synthetic snapshots: hashes checked, values typed as published
(a blank is NULL, never zero), rows with a blank type set aside and listed, staffing's unnamed agencies kept, a
duplicate place-year refused, and the diagnostics count what is outside the file's rounding.

Needs duckdb; without it the test is skipped (CI's harness Python has none). Run locally with a Python that has it.
"""
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest

try:
    import duckdb  # noqa: F401
    HAVE_DUCKDB = True
except ImportError:
    HAVE_DUCKDB = False

HERE = os.path.dirname(os.path.abspath(__file__))
OFF = ["violent", "murder", "rape", "robbery", "assault", "property", "burglary", "theft", "motor"]
CRIME_HEAD = "name,type,uid,id,year,population,agencies," + ",".join(f"{o}_total" for o in OFF) + "," + ",".join(f"{o}_change" for o in OFF) + "," + ",".join(f"{o}_capita" for o in OFF) + ",date"
CLEAR_HEAD = "name,type,uid,id,year,population," + ",".join(f"{o}_all_total" for o in OFF) + "," + ",".join(f"{o}_cleared_total" for o in OFF) + "," + ",".join(f"{o}_cleared_rate" for o in OFF)
STAFF_HEAD = "name,type,uid,id,year,population,all_total,officer_total,civilian_total,all_capita,officer_capita,civilian_capita,date"


def crime_row(name, typ, ori, year, pop, totals, change=None, capita=None):
    t = [str(totals.get(o, "")) for o in OFF]
    c = [str((change or {}).get(o, "")) for o in OFF]
    r = [str((capita or {}).get(o, "")) for o in OFF]
    return ",".join([name, typ, f"{ori}_{year}", ori, str(year), str(pop), ""] + t + c + r + [""])


def digest(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def load_builder():
    spec = importlib.util.spec_from_file_location("build_crimeindex", os.path.join(HERE, "build-crimeindex.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@unittest.skipUnless(HAVE_DUCKDB, "duckdb is not installed")
class CrimeIndexBuild(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.b = load_builder()
        v = self.v = {"violent": 30, "murder": 2, "rape": 3, "robbery": 5, "assault": 20, "property": 100, "burglary": 20, "theft": 70, "motor": 10}
        self.crime = [CRIME_HEAD,
                      crime_row("Memphis", "city", "TNMPD0000", 2022, 100000, v, capita={"violent": 30.0}),
                      # The rate is wrong in the file (outside its rounding): a diagnostic, never corrected.
                      crime_row("Memphis", "city", "TNMPD0000", 2023, 100000, {**v, "violent": 33, "assault": 23}, change={"violent": 10.0}, capita={"violent": 99.9}),
                      # A blank murder count stays blank, not zero.
                      crime_row("Knoxville", "city", "TN0470500", 2023, 50000, {k: x for k, x in v.items() if k != "murder"})]
        self.crime_sn = [CRIME_HEAD, crime_row("Tennessee", "state", "tn", 2023, 7000000, v), crime_row("United States", "nation", "us", 2023, 330000000, v)]
        self.clear = [CLEAR_HEAD, "Memphis,city,TNMPD0000_2023,TNMPD0000,2023,100000," + ",".join(["10"] * 9) + "," + ",".join(["5"] * 9) + "," + ",".join(["50"] * 9),
                      # A blank type: set aside and listed, never placed.
                      "Somewhere,,XX0000000_1960,XX0000000,1960,100," + ",".join([""] * 27)]
        self.clear_sn = [CLEAR_HEAD, "United States,nation,us_2023,us,2023,330000000," + ",".join([""] * 18) + "," + ",".join(["45.5"] * 9)]
        self.staff = [STAFF_HEAD, "Memphis,city,TNMPD0000_2023,TNMPD0000,2023,100000,2000,1800,200,2000,1800,200,",
                      # An agency with no name or type: kept (ORI-keyed), type NULL, counted.
                      ",,IN0494900_1930,IN0494900,1930,,568,568,,,,,"]
        self.staff_sn = [STAFF_HEAD]
        self.files = {}
        for snap, ds, name, lines in [("20261101", "historical_crime", "historical_crime_1930-2025.csv", self.crime),
                                      ("20261101", "historical_crime", "historical_crime_states_nation_1930-2025.csv", self.crime_sn),
                                      ("20261030", "historical_clearances", "historical_clearances_1960-2025.csv", self.clear),
                                      ("20261030", "historical_clearances", "historical_clearances_states_nation_1960-2025.csv", self.clear_sn),
                                      ("20261101", "historical_staffing", "historical_staffing_1930-2025.csv", self.staff),
                                      ("20261101", "historical_staffing", "historical_staffing_states_nation_1930-2025.csv", self.staff_sn)]:
            d = os.path.join(self.root, "snapshots", snap, ds)
            os.makedirs(d, exist_ok=True)
            p = os.path.join(d, name)
            with open(p, "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(lines) + "\n")
            self.files.setdefault((snap, ds), []).append({"file_name": name, "sha256": digest(p)})
        self.write_manifest()

    def write_manifest(self, tamper=None):
        snaps = [{"snapshot": s, "dataset": d, "years": [1930, 2025], "files": [dict(f) for f in fs]} for (s, d), fs in self.files.items()]
        if tamper:
            snaps[0]["files"][0]["sha256"] = "0" * 64
        self.manifest = os.path.join(self.root, "manifest.json")
        with open(self.manifest, "w", encoding="utf-8") as f:
            json.dump({"snapshots": snaps}, f)

    def tearDown(self):
        self.tmp.cleanup()

    def run_build(self):
        out = os.path.join(self.root, "out")
        return out, self.b.build(self.manifest, os.path.join(self.root, "snapshots"), out)

    def q(self, out, sql):
        import duckdb
        return duckdb.sql(sql.replace("{out}", out.replace("\\", "/"))).fetchall()

    def test_tables_values_and_manifest(self):
        out, rec = self.run_build()
        self.assertEqual(rec["tables"]["agency_crime"], 3)
        self.assertEqual(rec["tables"]["state_crime"], 1)
        self.assertEqual(rec["tables"]["nation_crime"], 1)
        # As published: the Memphis 2023 total and its (wrong) rate; Knoxville's blank murder is NULL, not 0.
        self.assertEqual(self.q(out, "SELECT violent_total, violent_capita, state FROM '{out}/agency_crime.parquet' WHERE ori = 'TNMPD0000' AND year = 2023"), [(33, 99.9, "TN")])
        self.assertEqual(self.q(out, "SELECT murder_total FROM '{out}/agency_crime.parquet' WHERE ori = 'TN0470500'"), [(None,)])
        self.assertEqual(self.q(out, "SELECT state FROM '{out}/state_crime.parquet'"), [("TN",)])
        # The blank-type clearance row is set aside and listed; staffing's unnamed agency is kept.
        self.assertEqual(rec["set_aside"]["agency_clearances"]["rows"], [["XX0000000_1960", "XX0000000", "1960"]])
        self.assertEqual(rec["tables"]["agency_clearances"], 1)
        self.assertEqual(rec["flags"]["agency_staffing_no_name_or_type"], 1)
        self.assertEqual(rec["tables"]["nation_staffing"], 0)
        self.assertNotIn("state_staffing", rec["tables"])
        # Diagnostics: the wrong rate is counted, with its example; the sums hold.
        d = rec["diagnostics"]
        self.assertEqual(d["agency_crime.violent_capita = total / population x 100,000"]["outside_rounding"], 1)
        self.assertEqual(d["agency_crime.violent_capita = total / population x 100,000"]["examples"], [["TNMPD0000", 2023]])
        self.assertEqual(d["agency_crime.violent = murder + rape + robbery + assault"]["outside_rounding"], 0)
        self.assertEqual(d["agency_crime.violent_change = change from the year before"]["outside_rounding"], 0)
        with open(os.path.join(out, "manifest.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["release"], "crimeindex-20261101")

    def test_hash_mismatch_stops_the_build(self):
        self.write_manifest(tamper=True)
        with self.assertRaises(SystemExit) as e:
            self.run_build()
        self.assertIn("SHA-256 mismatch", str(e.exception))

    def test_a_count_that_is_not_a_whole_number_stops_the_build(self):
        # Codex review 01.4: "0.4" would cast to 0 and "1,234" to NULL; neither may pass silently.
        for bad in ("0.4", "1 234"):
            p = os.path.join(self.root, "snapshots", "20261101", "historical_crime", "historical_crime_1930-2025.csv")
            lines = list(self.crime)
            lines[3] = crime_row("Knoxville", "city", "TN0470500", 2023, 50000, {**self.v, "murder": bad})
            with open(p, "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(lines) + "\n")
            self.files[("20261101", "historical_crime")][0]["sha256"] = digest(p)
            self.write_manifest()
            with self.assertRaises(SystemExit) as e:
                self.run_build()
            self.assertIn("not exactly a number", str(e.exception))

    def test_out_inside_the_repository_is_refused_whatever_its_case(self):
        repo = os.path.dirname(HERE)
        with self.assertRaises(SystemExit) as e:
            self.b.main(["--manifest", self.manifest, "--snapshots", os.path.join(self.root, "snapshots"), "--out", os.path.join(repo.swapcase() if os.name == "nt" else repo, "review-output")])
        self.assertIn("outside the repository", str(e.exception))

    def test_duplicate_place_year_stops_the_build(self):
        p = os.path.join(self.root, "snapshots", "20261101", "historical_crime", "historical_crime_1930-2025.csv")
        with open(p, "a", encoding="utf-8", newline="\n") as f:
            f.write(self.crime[1] + "\n")
        self.files[("20261101", "historical_crime")][0]["sha256"] = digest(p)
        self.write_manifest()
        with self.assertRaises(SystemExit) as e:
            self.run_build()
        self.assertIn("more than once", str(e.exception))


if __name__ == "__main__":
    unittest.main()
