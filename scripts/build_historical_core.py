"""
Build the five aligned Historical tables into a throwaway database, and account for the build.

This is the offline proof that Historical can be produced from named source files rather
than inherited from whatever the canonical database happens to contain. It writes
`historical_agency`, `historical_agency_crime`, `historical_agency_population`,
`historical_agency_clearance` and `historical_staffing` and nothing else, refuses to open any
canonical or production database, and emits a manifest describing every input it read, every
row it declined, and every identity decision it made.

Five tables, not two, and in one pass. Four of them key on `ori`, so they inherit the same
identity decisions -- the restored agencies, the refused consolidations, the resolved
seven-character ORIs. Building some of them and leaving the rest is not a smaller version of
this job: `lib/claude.ts` instructs every per-capita query to join `historical_agency_population`,
so an agency restored in crime but missing from population answers a "how many" question and
returns nothing at all for "how many per person". Nothing errors. The number simply is not there.

`historical_state_national` is not built here. It keys on state name rather than `ori`, no
identity decision in this pipeline can reach it, and it remains the application's authority
for state and national questions.

Usage:

    python scripts/build_historical_core.py \
        --geographies "<dir>/geographies.csv" \
        --base-crime  "<dir>/historical_crime_1930_2024.csv" \
        --populations "<dir>/populations.csv" \
        --clearance   "<dir>/historical_clearance_1960_2024.csv" \
        --staffing    "<dir>/historical_staffing_1930_2025.csv" \
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
    sources = [args.geographies, args.base_crime, args.populations, args.clearance,
               args.staffing, args.annual, args.consolidations, args.ori_map, args.exclusions]
    # No output may sit on top of a source file, and the two outputs must not be the same file.
    core.assert_distinct_outputs(sources, [args.out, args.manifest])
    # The manifest is evidence too: it has to be new, or a rerun quietly replaces the record
    # of the previous build. Checked before the database is created, so a refusal leaves
    # nothing behind.
    core.assert_safe_destination(args.manifest)
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

    # ── 1. the agency directory, and the identifiers it explains away ────────────────
    agency_rows = count_rows(args.geographies)
    agencies = core.load_agencies(conn, read_csv(args.geographies, args.reverse_input_order))
    pseudo = agencies["pseudo_identifiers"]
    record_input("agency_directory", args.geographies, agency_rows)
    manifest["steps"]["agencies"] = {
        "read": agency_rows,
        "written": agencies["written"],
        "excluded": {
            "blank_identifier": agency_rows - agencies["written"] - len(pseudo),
            "pseudo_identifier": len(pseudo),
        },
        "pseudo_identifiers": dict(sorted(pseudo.items())),
        "note": "names are written exactly as the source spells them; the importer this "
                "replaces rewrote county names into forms no source states",
    }

    # Everything a source identifier is allowed to be. Anything else stops the build, so an
    # unplaceable row can only survive by being named in tracked evidence first.
    exclusions = core.load_identifier_exclusions(args.exclusions, conn)
    if args.exclusions:
        record_input("identifier_exclusions", args.exclusions, len(exclusions))
    policy = core.IdentifierPolicy(pseudo, exclusions)

    # ── 2. base sources ──────────────────────────────────────────────────────────────
    base_rows = count_rows(args.base_crime)
    base = core.load_base_crime(conn, read_csv(args.base_crime, args.reverse_input_order), policy)
    record_input("base_annual_crime", args.base_crime, base_rows)
    manifest["steps"]["base_crime"] = {
        "read": base["read"],
        "written": base["written"],
        "excluded": {
            "blank_identifier": base_rows - base["read"] - base["pseudo_rows_excluded"]
            - base["unplaceable_rows_excluded"],
            "pseudo_identifier": base["pseudo_rows_excluded"],
            "unplaceable_identifier": base["unplaceable_rows_excluded"],
        },
        "note": "blank stays NULL and zero stays zero; no all-zero rewrite is applied",
    }

    for role, path, loader, step, note in (
        ("base_population", args.populations, core.load_base_population, "base_population",
         "a population of zero is a stated population"),
        ("base_clearance", args.clearance, core.load_base_clearance, "base_clearance",
         "a rate is computed per measure from its own offence/cleared pair; offences with no "
         "clearances is zero per cent, and a zero or missing denominator is NULL"),
        ("base_staffing", args.staffing, core.load_base_staffing, "base_staffing",
         "zero employees is a count, not a silence"),
    ):
        source_rows = count_rows(path)
        result = loader(conn, read_csv(path, args.reverse_input_order), policy)
        record_input(role, path, source_rows)
        manifest["steps"][step] = {
            "read": result["read"],
            "written": result["written"],
            "excluded": {
                "blank_identifier": source_rows - result["read"] - result["pseudo_rows_excluded"]
                - result["unplaceable_rows_excluded"],
                "pseudo_identifier": result["pseudo_rows_excluded"],
                "unplaceable_identifier": result["unplaceable_rows_excluded"],
            },
            "note": note,
        }

    # ── 3. annual year: crime, population and clearance from one resolution ──────────
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
        manifest["steps"]["annual"] = {
            "year": args.annual_year,
            "read": annual_rows,
            "written": {
                "historical_agency_crime": annual["written"],
                "historical_agency_population": annual["population_written"],
                "historical_agency_clearance": annual["clearance_written"],
            },
            "new_agencies": annual["new_agencies"],
            "excluded": annual["excluded"],
            "ambiguity_count": len(annual["ambiguities"]),
            "resolutions": annual["resolutions"],
            "ambiguities": annual["ambiguities"],
            "validated_mappings": len(mappings),
            "state_aliases": dict(sorted(core.STATE_ALIASES.items())),
            "unknown_state_codes": annual["unknown_state_codes"],
            "note": "reporting status is read from Months_Reported, never inferred from the "
                    "totals; all three tables are written from one set of resolved identities. "
                    "Staffing is not here: its source already covers this year.",
        }

    # ── 4. consolidations, decided across every table at once ────────────────────────
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
        "note": "an entry is applied only where no field in any of the four keyed tables "
                "would be discarded; the table that objected is named",
    }

    conn.commit()

    # ── 5. reconcile every table against the steps that filled it ────────────────────
    # Expected counts are stated from the steps, then compared with the tables themselves, so
    # a row lost between two stages shows up as a mismatch rather than as a plausible total.
    annual_written = manifest["steps"]["annual"]["written"] if args.annual else {}
    expected = {
        "historical_agency": manifest["steps"]["agencies"]["written"]
        + (manifest["steps"]["annual"]["new_agencies"] if args.annual else 0)
        - applied["predecessor_agencies_removed"],
    }
    for table, step in (("historical_agency_crime", "base_crime"),
                        ("historical_agency_population", "base_population"),
                        ("historical_agency_clearance", "base_clearance"),
                        ("historical_staffing", "base_staffing")):
        expected[table] = (
            manifest["steps"][step]["written"]
            + annual_written.get(table, 0)
            + applied["survivor_rows_added"][table]
            - applied["predecessor_rows_removed"][table]
        )

    for table in core.BUILT_TABLES:
        actual = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        manifest["tables"][table] = {
            "expected_rows": expected[table],
            "rows": actual,
            "reconciles": expected[table] == actual,
            "content_sha256": core.table_digest(conn, table),
            "schema_sha256": core.table_schema_digest(conn, table),
        }
        if expected[table] != actual:
            raise core.BuildError(
                f"{table} holds {actual} rows but the steps account for {expected[table]}; "
                "rows appeared or vanished between stages"
            )

    # ── 6. what the build is for, stated as a number ─────────────────────────────────
    zero_rows = conn.execute(
        "SELECT COUNT(*) FROM historical_agency_crime WHERE " + " AND ".join(f"{m} = 0" for m in core.CRIME_MEASURES)
    ).fetchone()[0]
    null_rows = conn.execute(
        "SELECT COUNT(*) FROM historical_agency_crime WHERE " + " AND ".join(f"{m} IS NULL" for m in core.CRIME_MEASURES)
    ).fetchone()[0]
    clearance_zero = conn.execute(
        "SELECT COUNT(*) FROM historical_agency_clearance WHERE "
        + " AND ".join(f"{c} = 0" for c in core.CLEARANCE_COLUMNS)
    ).fetchone()[0]
    clearance_null = conn.execute(
        "SELECT COUNT(*) FROM historical_agency_clearance WHERE "
        + " AND ".join(f"{c} IS NULL" for c in core.CLEARANCE_COLUMNS)
    ).fetchone()[0]
    manifest["zero_versus_missing"] = {
        "crime_agency_years_reported_all_zero": zero_rows,
        "crime_agency_years_with_no_values": null_rows,
        "clearance_agency_years_all_zero_percent": clearance_zero,
        "clearance_agency_years_with_no_rate": clearance_null,
        "note": "each pair was one row before this pipeline; keeping them apart is the point",
    }

    # An agency-year whose ORI is in no directory row can never be joined to a name, so it is
    # invisible to every reader: it answers no question and appears in no total, while still
    # counting towards the row totals the system prompt publishes. A build that produced one
    # would be reporting a number it cannot stand behind, so it fails instead.
    child_tables = [t for t in core.BUILT_TABLES if t != "historical_agency"]
    manifest["steps"]["identifier_exclusions"] = {
        "entries": core.verify_identifier_exclusions(conn, exclusions, child_tables, policy),
        "note": "checked against the finished directory, after the annual step has created "
                "the agencies it creates",
    }
    core.assert_no_orphan_rows(conn, child_tables)
    manifest["unjoinable_rows"] = {table: 0 for table in child_tables}

    manifest["status"] = "complete"
    conn.close()
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--geographies", required=True, help="agency directory CSV")
    parser.add_argument("--base-crime", required=True, help="1930-2024 annual crime CSV")
    parser.add_argument("--populations", required=True, help="agency population CSV")
    parser.add_argument("--clearance", required=True, help="1960-2024 clearance CSV")
    parser.add_argument("--staffing", required=True, help="1930-2025 staffing CSV")
    parser.add_argument("--annual", help="annual RETA CSV for one later year")
    parser.add_argument("--annual-year", type=int, default=2025)
    parser.add_argument("--reverse-input-order", action="store_true",
                        help="read every source in reverse row order; the build must not care")
    parser.add_argument("--consolidations", required=True, help="consolidation manifest JSON")
    parser.add_argument("--ori-map", help="validated annual ORI mapping JSON")
    parser.add_argument("--exclusions", help="tracked identifier-exclusion JSON")
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
