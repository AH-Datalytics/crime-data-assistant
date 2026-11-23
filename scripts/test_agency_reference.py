"""Validator and tests for data/reference/agency_county.csv and agency_succession.csv.

Usage:
  python scripts/test_agency_reference.py                       checks the two files on their own
  python scripts/test_agency_reference.py --db <crime_data.db>  also regenerates agency_county.csv from the database and
                                                                requires the same bytes (the monthly check)
  python scripts/test_agency_reference.py --release <canonical dir>  also requires every ORI of the succession file to
                                                                have a header (agency_year) in the latest data year (needs duckdb)
"""
import argparse
import csv
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "data" / "reference"
sys.path.insert(0, str(Path(__file__).resolve().parent))

COUNTY_HEADER = ["state", "county_fips", "county_key", "county_name", "ori9", "agency_name",
                 "crosswalk_agency_name", "first_year", "last_year", "source"]
SUCC_HEADER = ["state", "alias", "rule", "successor_ori9", "successor_shr_ori7", "predecessor_name",
               "predecessor_shr_ori7", "predecessor_last_year", "survivor_agency", "survivor_type", "display_names", "evidence_note"]
ORI9 = re.compile(r"^[A-Z]{2}[A-Z0-9]{7}$")
STATES = set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU VI AS CZ".split())


def ori_state(ori):
    """The state of an ORI prefix; Nebraska ORIs begin NB."""
    return "NE" if ori[:2] == "NB" else ori[:2]


def read(path, header):
    with open(path, newline="", encoding="utf-8") as f:
        r = csv.reader(f)
        head = next(r)
        assert head == header, f"{path.name}: header {head}"
        return [dict(zip(header, row)) for row in r if row]


def check_county(rows):
    assert len(rows) > 3000, len(rows)
    keys = set()
    for r in rows:
        assert r["state"] in STATES, r
        assert ORI9.match(r["ori9"]) and ori_state(r["ori9"]) == r["state"], r
        assert re.match(r"^\d{5}$", r["county_fips"]), r
        assert re.match(r"^[A-Z0-9 ]+$", r["county_key"]) and "COUNTY" not in r["county_key"].split(), r
        k = (r["state"], r["county_key"], r["ori9"])
        assert k not in keys, f"duplicate {k}"
        keys.add(k)
        if r["first_year"] or r["last_year"]:
            assert 1930 <= int(r["first_year"]) <= int(r["last_year"]) <= 2030, r
    # one county_key is one county: the same (state, county_key) never carries two FIPS codes
    # One known exception, copied from the source crosswalk and not repaired here: VA0020000 (Albemarle County, last
    # data 1984) carries FIPS 51540 (Charlottesville) under the county name Albemarle. Any other case fails.
    known = {("VA", "ALBEMARLE"): {"51003", "51540"}}
    fips = {}
    for r in rows:
        fips.setdefault((r["state"], r["county_key"]), set()).add(r["county_fips"])
    for k, v in fips.items():
        assert len(v) == 1 or known.get(k) == v, f"{k} carries several FIPS codes: {sorted(v)}"
    # the order is state, county_key, ori9 so a diff of two exports is readable
    order = [(r["state"], r["county_key"], r["ori9"]) for r in rows]
    assert order == sorted(order), "rows not sorted"
    counties = {(r["state"], r["county_key"]) for r in rows}
    many = {c for c in counties if sum(1 for r in rows if (r["state"], r["county_key"]) == c) > 1}
    return counties, many


def check_succession(rows):
    merges = [r for r in rows if r["rule"] == "merge"]
    excl = [r for r in rows if r["rule"] == "exclude"]
    assert merges and {r["rule"] for r in rows} == {"merge", "exclude"}
    seen = set()
    for r in rows:
        assert r["state"] in STATES and r["alias"], r
        assert (r["state"], r["alias"]) not in seen, f"duplicate {(r['state'], r['alias'])}"
        seen.add((r["state"], r["alias"]))
    for r in merges:
        assert ORI9.match(r["successor_ori9"]) and ori_state(r["successor_ori9"]) == r["state"], r
        if r["successor_shr_ori7"]:
            assert r["successor_shr_ori7"] == r["successor_ori9"][:7], r
        if r["predecessor_shr_ori7"]:
            assert ori_state(r["predecessor_shr_ori7"]) == r["state"] and len(r["predecessor_shr_ori7"]) == 7, r
        if r["predecessor_last_year"]:
            assert r["predecessor_name"] and 1930 <= int(r["predecessor_last_year"]) <= 2026, r
        assert r["survivor_type"] in ("city", "county") and r["survivor_agency"] and r["evidence_note"], r
    for r in excl:
        assert not r["successor_ori9"], r
    return merges, excl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db")
    ap.add_argument("--release")
    a = ap.parse_args()

    county = read(REF / "agency_county.csv", COUNTY_HEADER)
    succ = read(REF / "agency_succession.csv", SUCC_HEADER)
    counties, many = check_county(county)
    merges, excl = check_succession(succ)

    # Baltimore County MD: two county agencies, one stopped reporting in 2000 (the reason last_year is in the file)
    bal = [r for r in county if (r["state"], r["county_key"]) == ("MD", "BALTIMORE")]
    assert {(r["ori9"], r["last_year"]) for r in bal} == {("MD0030000", "2000"), ("MD0030100", "2025")}, bal
    # Baltimore city is a city agency: it must not appear as a county agency
    assert not any(r["ori9"] in ("MDBPD0000", "MD0040600") for r in county)
    # the merged agencies of county type are county agencies of their county, the cities are not
    assert any(r["ori9"] == "KS0810000" for r in county), "Riley County KS missing"
    assert {(r["state"], r["alias"]) for r in excl} == {("FL", "Jacksonville"), ("IL", "Kankakee")}
    assert len(merges) == 15, len(merges)
    print(f"agency_county.csv: {len(county)} rows, {len(counties)} counties, {len(many)} with more than one county agency")
    print(f"agency_succession.csv: {len(merges)} merges, {len(excl)} exclusions")
    assert len(county) == 3124 and len(counties) == 3058 and len(many) == 66, (len(county), len(counties), len(many))

    if a.db:
        import export_agency_county_reference as ex
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "agency_county.csv"
            ex.export(a.db, out)
            assert out.read_bytes() == (REF / "agency_county.csv").read_bytes(), "agency_county.csv differs from the database export"
        print("agency_county.csv equals a fresh export of the database")

    if a.release:
        import duckdb
        root = Path(a.release) / "agency_year"
        years = sorted(int(p.name.split("=")[1]) for p in root.glob("data_year=*"))
        latest = years[-1]
        con = duckdb.connect()
        have = {r[0] for r in con.execute(f"SELECT DISTINCT ori FROM read_parquet('{(root / f'data_year={latest}' / 'data.parquet').as_posix()}')").fetchall()}
        bad = [r["successor_ori9"] for r in merges if r["successor_ori9"] not in have]
        assert not bad, f"successor ORIs without a {latest} header: {bad}"
        print(f"every successor ORI has a {latest} header")
    print("OK")


if __name__ == "__main__":
    main()
