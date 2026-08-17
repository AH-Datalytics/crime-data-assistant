"""
Build the two Historical core tables into a throwaway database, and account for the build.

This is the offline proof that the Historical core can be produced from named source files
rather than inherited from whatever the canonical database happens to contain. It writes
`historical_agency` and `historical_agency_crime` and nothing else, refuses to open any
canonical or production database, and emits a manifest describing every input it read, every
row it declined, and every identity decision it made.

Usage:

    python scripts/build_historical_core.py \
        --geographies "<dir>/geographies.csv" \
        --base-crime  "<dir>/historical_crime_1930_2024.csv" \
        --annual      "<path>/reta-2025-annual.csv" \
        --annual-year 2025 \
        --consolidations scripts/historical_consolidations.json \
        --ori-map        scripts/historical_annual_ori_map.json \
        --out "<a new file in a temp directory>" \
        --manifest "<a new .json file>"

Every path is supplied by the caller. Nothing here knows where anyone's data lives.
"""

import argparse
import csv
import json
import os
import sys

import historical_core as core


def read_csv(path, reverse=False):
    with open(path, newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    return reversed(rows) if reverse else iter(rows)


def count_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as handle:
        return sum(1 for _ in csv.DictReader(handle))


def load_ori_map(path):
    if not path:
        return []
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    return [core.OriMapping.from_dict(entry) for entry in payload["mappings"]]


def build(args):
    # No output may sit on top of a source file, and the two outputs must not be the same file.
    core.assert_distinct_outputs(
        [args.geographies, args.base_crime, args.annual, args.consolidations, args.ori_map],
        [args.out, args.manifest],
    )
    conn = core.open_build_database(args.out)
    manifest = {
        "tool": core.TOOL_VERSION,
        "schema_version": core.SCHEMA_VERSION,
        "status": "incomplete",
        "inputs": [],
        "steps": {},
        "tables": {},
    }

    def record_input(role, path, source_rows):
        manifest["inputs"].append({
            "role": role,
            # Basename only. A manifest is evidence, and nobody's directory layout is evidence.
            "filename": os.path.basename(path),
            "sha256": core.sha256_file(path),
            "source_rows": source_rows,
        })

    # ── 1. base sources ──────────────────────────────────────────────────────────────
    agency_rows = count_rows(args.geographies)
    written = core.load_agencies(conn, read_csv(args.geographies, args.reverse_input_order))
    record_input("agency_directory", args.geographies, agency_rows)
    manifest["steps"]["agencies"] = {
        "read": agency_rows,
        "written": written,
        "excluded": {"blank_identifier": agency_rows - written},
    }

    base_rows = count_rows(args.base_crime)
    base = core.load_base_crime(conn, read_csv(args.base_crime, args.reverse_input_order))
    record_input("base_annual_crime", args.base_crime, base_rows)
    manifest["steps"]["base_crime"] = {
        "read": base["read"],
        "written": base["written"],
        "excluded": {"blank_identifier": base_rows - base["read"]},
        "note": "blank stays NULL and zero stays zero; no all-zero rewrite is applied",
    }

    # ── 2. annual year ───────────────────────────────────────────────────────────────
    if args.annual:
        mappings = load_ori_map(args.ori_map)
        if args.ori_map:
            record_input("annual_ori_map", args.ori_map, len(mappings))
        errors = core.validate_ori_mappings(mappings, conn)
        if errors:
            raise core.BuildError("ORI mappings disagree with the agency directory:\n  " + "\n  ".join(errors))
        annual_rows = count_rows(args.annual)
        annual = core.load_annual(conn, read_csv(args.annual, args.reverse_input_order), mappings, args.annual_year)
        record_input("annual_crime", args.annual, annual_rows)
        manifest["steps"]["annual_crime"] = {
            "year": args.annual_year,
            "read": annual_rows,
            "written": annual["written"],
            "new_agencies": annual["new_agencies"],
            "excluded": annual["excluded"],
            "ambiguity_count": len(annual["ambiguities"]),
            "resolutions": annual["resolutions"],
            "ambiguities": annual["ambiguities"],
            "validated_mappings": len(mappings),
            "note": "reporting status is read from Months_Reported, never inferred from the totals",
        }

    # ── 3. consolidations ────────────────────────────────────────────────────────────
    entries = core.load_consolidations(args.consolidations)
    record_input("consolidations", args.consolidations, len(entries))
    applied = core.apply_consolidations(conn, entries)
    manifest["steps"]["consolidations"] = {
        "proposed": len(entries),
        "applied": applied["applied"],
        "refused": applied["refused"],
        "survivor_rows_added": applied["survivor_rows_added"],
        "predecessor_rows_removed": applied["predecessor_rows_removed"],
        "predecessor_agencies_removed": applied["predecessor_agencies_removed"],
    }

    conn.commit()

    # Expected counts are stated from the steps, then compared with the tables themselves, so a
    # row lost between two stages shows up as a mismatch rather than as a plausible total.
    expected_crime = manifest["steps"]["base_crime"]["written"]
    if args.annual:
        expected_crime += manifest["steps"]["annual_crime"]["written"]
    expected_crime += applied["survivor_rows_added"] - applied["predecessor_rows_removed"]
    expected_agency = manifest["steps"]["agencies"]["written"]
    if args.annual:
        expected_agency += manifest["steps"]["annual_crime"]["new_agencies"]
    expected_agency -= applied["predecessor_agencies_removed"]

    for table, expected in (("historical_agency", expected_agency),
                            ("historical_agency_crime", expected_crime)):
        actual = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        manifest["tables"][table] = {
            "expected_rows": expected,
            "rows": actual,
            "reconciles": expected == actual,
            "content_sha256": core.table_digest(conn, table),
            "schema_sha256": core.table_schema_digest(conn, table),
        }
        if expected != actual:
            raise core.BuildError(
                f"{table} holds {actual} rows but the steps account for {expected}; "
                "rows appeared or vanished between stages"
            )

    zero_rows = conn.execute(
        "SELECT COUNT(*) FROM historical_agency_crime WHERE " + " AND ".join(f"{m} = 0" for m in core.CRIME_MEASURES)
    ).fetchone()[0]
    null_rows = conn.execute(
        "SELECT COUNT(*) FROM historical_agency_crime WHERE " + " AND ".join(f"{m} IS NULL" for m in core.CRIME_MEASURES)
    ).fetchone()[0]
    manifest["zero_versus_missing"] = {
        "agency_years_reported_all_zero": zero_rows,
        "agency_years_with_no_values": null_rows,
        "note": "these two were the same row before this pipeline; keeping them apart is the point",
    }

    manifest["status"] = "complete"
    conn.close()
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--geographies", required=True, help="agency directory CSV")
    parser.add_argument("--base-crime", required=True, help="1930-2024 annual crime CSV")
    parser.add_argument("--annual", help="annual RETA CSV for one later year")
    parser.add_argument("--annual-year", type=int, default=2025)
    parser.add_argument("--reverse-input-order", action="store_true",
                        help="read every source in reverse row order; the build must not care")
    parser.add_argument("--consolidations", required=True, help="consolidation manifest JSON")
    parser.add_argument("--ori-map", help="validated annual ORI mapping JSON")
    parser.add_argument("--out", required=True, help="destination database; must not exist and must not be canonical")
    parser.add_argument("--manifest", required=True, help="where to write the build manifest JSON")
    args = parser.parse_args(argv)

    try:
        manifest = build(args)
    except core.BuildError as failure:
        print(f"BUILD REFUSED: {failure}", file=sys.stderr)
        return 2

    with open(args.manifest, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
