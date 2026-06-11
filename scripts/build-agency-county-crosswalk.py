#!/usr/bin/env python3
"""Build agency_county_crosswalk from a participation workbook or CSV.

The participation source uses 7-character legacy ORIs plus an optional 9-character
ORI. Do not derive ORI9 mechanically: a small number of rows, including
Indianapolis, intentionally map to non-obvious ORI9 values.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree


EXPECTED_HEADERS = [
    "ori",
    "ori9",
    "agency_name",
    "state_abb",
    "fips_state_code",
    "fips_county_code",
]


def clean(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.upper() == "NA":
        return None
    return text


def norm_key(value: str | None) -> str | None:
    if not value:
        return None
    return re.sub(r"[^A-Z0-9]+", " ", value.upper()).strip() or None


def title_name(value: str | None) -> str | None:
    if not value:
        return None
    text = re.sub(r"\s+", " ", value.strip())
    words = []
    for word in text.lower().split(" "):
        if word in {"of", "and", "the"}:
            words.append(word)
        elif word in {"st", "st."}:
            words.append("St.")
        else:
            words.append("-".join(part.capitalize() for part in word.split("-")))
    return " ".join(words)


def county_fips(state_code: str | None, county_code: str | None) -> str | None:
    if not state_code or not county_code:
        return None
    try:
        return f"{int(float(state_code)):02d}{int(float(county_code)):03d}"
    except ValueError:
        return None


def load_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    try:
        raw = zf.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ElementTree.fromstring(raw)
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    strings: list[str] = []
    for si in root.findall(f"{ns}si"):
        parts = [t.text or "" for t in si.findall(f".//{ns}t")]
        strings.append("".join(parts))
    return strings


def cell_column(ref: str) -> int:
    letters = re.match(r"([A-Z]+)", ref)
    if not letters:
        return 0
    idx = 0
    for ch in letters.group(1):
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx - 1


def read_xlsx(path: Path) -> Iterable[dict[str, str | None]]:
    with zipfile.ZipFile(path) as zf:
      shared = load_shared_strings(zf)
      sheet_name = "xl/worksheets/sheet1.xml"
      root = ElementTree.fromstring(zf.read(sheet_name))

    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rows: list[list[str | None]] = []
    for row in root.findall(f".//{ns}row"):
        cells: dict[int, str | None] = {}
        for cell in row.findall(f"{ns}c"):
            ref = cell.attrib.get("r", "")
            col = cell_column(ref)
            cell_type = cell.attrib.get("t")
            value_node = cell.find(f"{ns}v")
            value = value_node.text if value_node is not None else None
            if cell_type == "s" and value is not None:
                value = shared[int(value)]
            elif cell_type == "inlineStr":
                value = "".join(t.text or "" for t in cell.findall(f".//{ns}t"))
            cells[col] = clean(value)
        if cells:
            width = max(cells) + 1
            rows.append([cells.get(i) for i in range(width)])

    if not rows:
        return
    headers = [clean(h) or "" for h in rows[0]]
    missing = [h for h in EXPECTED_HEADERS if h not in headers]
    if missing:
        raise SystemExit(f"Source workbook is missing expected headers: {', '.join(missing)}")
    for row in rows[1:]:
        yield {header: row[i] if i < len(row) else None for i, header in enumerate(headers)}


def read_csv(path: Path) -> Iterable[dict[str, str | None]]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        missing = [h for h in EXPECTED_HEADERS if h not in (reader.fieldnames or [])]
        if missing:
            raise SystemExit(f"Source CSV is missing expected headers: {', '.join(missing)}")
        for row in reader:
            yield {key: clean(value) for key, value in row.items()}


def read_source(path: Path) -> list[dict[str, str | None]]:
    suffix = path.suffix.lower()
    if suffix == ".xlsx":
        return list(read_xlsx(path))
    if suffix == ".csv":
        return list(read_csv(path))
    raise SystemExit("Participation source must be .xlsx or .csv")


def read_cde_counties(path: Path | None) -> dict[str, str]:
    if not path:
        return {}
    by_ori: dict[str, Counter[str]] = defaultdict(Counter)
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            ori = clean(row.get("ori"))
            county = clean(row.get("county_name"))
            if county and norm_key(county) in {"NOT SPECIFIED", "UNKNOWN"}:
                county = None
            if ori and county:
                by_ori[ori.upper()][county.upper()] += 1
    return {ori: counts.most_common(1)[0][0] for ori, counts in by_ori.items()}


def build_rows(source_rows: list[dict[str, str | None]], cde_by_ori9: dict[str, str]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    county_names_by_fips: dict[str, Counter[str]] = defaultdict(Counter)

    for row in source_rows:
        ori = clean(row.get("ori"))
        if not ori:
            continue
        ori = ori.upper()
        ori9 = clean(row.get("ori9"))
        ori9 = ori9.upper() if ori9 else None
        state = clean(row.get("state_abb"))
        state = state.upper() if state else None
        fips_state = clean(row.get("fips_state_code"))
        fips_county = clean(row.get("fips_county_code"))
        fips = county_fips(fips_state, fips_county)
        county_name_raw = cde_by_ori9.get(ori9 or "") if ori9 else None
        if fips and county_name_raw:
            county_names_by_fips[fips][county_name_raw] += 1
        rows.append({
            "ori": ori,
            "ori9": ori9,
            "agency_name": title_name(clean(row.get("agency_name"))),
            "state": state,
            "fips_state_code": int(float(fips_state)) if fips_state else None,
            "fips_county_code": int(float(fips_county)) if fips_county else None,
            "county_fips": fips,
            "county_name_raw": county_name_raw,
        })

    county_name_by_fips = {
        fips: counter.most_common(1)[0][0]
        for fips, counter in county_names_by_fips.items()
    }
    for row in rows:
        county_name_raw = county_name_by_fips.get(row["county_fips"]) or row["county_name_raw"]
        county_name = title_name(str(county_name_raw)) if county_name_raw else None
        row["county_name"] = county_name
        row["county_key"] = norm_key(county_name)
        row["source"] = "participation_crosswalk"
        del row["county_name_raw"]

    seen: set[str] = set()
    duplicates: list[str] = []
    for row in rows:
        ori = str(row["ori"])
        if ori in seen:
            duplicates.append(ori)
        seen.add(ori)
    if duplicates:
        raise SystemExit(f"Duplicate ORI values in source: {', '.join(sorted(set(duplicates))[:10])}")
    return rows


def create_table(conn: sqlite3.Connection) -> None:
    conn.executescript("""
    DROP TABLE IF EXISTS agency_county_crosswalk;
    CREATE TABLE agency_county_crosswalk (
      ori TEXT PRIMARY KEY,
      ori9 TEXT,
      agency_name TEXT,
      state TEXT,
      fips_state_code INTEGER,
      fips_county_code INTEGER,
      county_fips TEXT,
      county_name TEXT,
      county_key TEXT,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agency_county_crosswalk_ori9
      ON agency_county_crosswalk(ori9);
    CREATE INDEX IF NOT EXISTS idx_agency_county_crosswalk_state_fips
      ON agency_county_crosswalk(state, county_fips);
    CREATE INDEX IF NOT EXISTS idx_agency_county_crosswalk_state_county
      ON agency_county_crosswalk(state, county_key);
    CREATE INDEX IF NOT EXISTS idx_agency_county_crosswalk_county
      ON agency_county_crosswalk(county_key);
    """)


def insert_rows(conn: sqlite3.Connection, rows: list[dict[str, object]]) -> None:
    conn.executemany(
        """
        INSERT INTO agency_county_crosswalk (
          ori, ori9, agency_name, state, fips_state_code, fips_county_code,
          county_fips, county_name, county_key, source
        ) VALUES (
          :ori, :ori9, :agency_name, :state, :fips_state_code, :fips_county_code,
          :county_fips, :county_name, :county_key, :source
        )
        """,
        rows,
    )


def summarize(rows: list[dict[str, object]], applied: bool, target: Path | None) -> dict[str, object]:
    non_na_ori9 = [r for r in rows if r["ori9"]]
    exceptions = [
        {"ori": r["ori"], "ori9": r["ori9"], "agency_name": r["agency_name"]}
        for r in rows
        if r["ori9"] and r["ori9"] != f"{r['ori']}00"
    ]
    indianapolis = [r for r in rows if r["ori"] == "INIPD00"]
    return {
        "applied": applied,
        "target": str(target) if target else None,
        "rows": len(rows),
        "rows_with_ori9": len(non_na_ori9),
        "rows_with_county_fips": sum(1 for r in rows if r["county_fips"]),
        "rows_with_county_name": sum(1 for r in rows if r["county_name"]),
        "distinct_county_fips": len({r["county_fips"] for r in rows if r["county_fips"]}),
        "ori_ending_x": sum(1 for r in rows if str(r["ori"]).endswith("X")),
        "ori9_exceptions": exceptions,
        "indianapolis": indianapolis,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="Participation Crosswalk .xlsx or .csv")
    parser.add_argument("--target", help="SQLite database to receive agency_county_crosswalk")
    parser.add_argument("--cde", help="Optional CDE Participation CSV for county names")
    parser.add_argument("--apply", action="store_true", help="Replace table in target DB")
    args = parser.parse_args()

    source = Path(args.source)
    target = Path(args.target) if args.target else None
    cde = Path(args.cde) if args.cde else None
    if args.apply and not target:
        raise SystemExit("--target is required with --apply")

    rows = build_rows(read_source(source), read_cde_counties(cde))

    if args.apply:
        assert target is not None
        conn = sqlite3.connect(target)
        try:
            with conn:
                create_table(conn)
                insert_rows(conn, rows)
        finally:
            conn.close()

    print(json.dumps(summarize(rows, args.apply, target), indent=2))
    if not args.apply:
        print("\nDry run only. Re-run with --apply --target=PATH to replace agency_county_crosswalk.")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)
