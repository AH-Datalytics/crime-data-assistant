#!/usr/bin/env python3
"""Build the compact state/national NIBRS query database off-production.

The source is opened read-only.  This process intentionally refuses to run on
the production web host because the GROUP BY scans are large enough to affect
the live application.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import socket
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path


SCHEMA_VERSION = 1
PRODUCTION_HOSTNAMES = {"ubuntu-8gb-ash-2"}


@dataclass(frozen=True)
class RollupSpec:
    source: str
    dimensions: tuple[str, ...]
    measures: tuple[str, ...]


SPECS = (
    RollupSpec("summary_arrestee_demographics", ("year", "ucr_arrest_offense", "weapon_category", "race", "sex", "age_group", "ethnicity"), ("arrestee_count",)),
    RollupSpec("summary_victim_demographics", ("year", "ucr_offense_code", "weapon_category", "race", "sex", "age_group", "ethnicity"), ("victim_count",)),
    RollupSpec("summary_offender_demographics", ("year", "ucr_offense_code", "weapon_category", "race", "sex", "age_group", "ethnicity"), ("offender_count",)),
    RollupSpec("summary_victim_relationship", ("year", "ucr_offense_code", "relationship_code", "sex", "race", "age_group"), ("victim_count",)),
    RollupSpec("summary_victim_weapon", ("year", "ucr_offense_code", "weapon_type"), ("victim_count",)),
    RollupSpec("summary_victim_circumstance", ("year", "ucr_offense_code", "circumstance_code"), ("victim_count",)),
    RollupSpec("summary_victim_weapon_circumstance_demo", ("year", "ucr_offense_code", "weapon_type", "circumstance_code", "sex", "race", "age_group"), ("victim_count",)),
    RollupSpec("summary_clearance_type", ("year", "month", "ucr_offense_code"), ("total_offenses", "cleared_by_arrest", "cleared_exceptional")),
    RollupSpec("summary_clearance_detail", ("year", "ucr_offense_code"), ("total_offenses", "cleared_by_arrest", "cleared_A", "cleared_B", "cleared_C", "cleared_D", "cleared_E")),
)


def quote_ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def source_uri(path: Path) -> str:
    return f"{path.as_uri()}?mode=ro"


def refuse_production() -> None:
    hostname = socket.gethostname().lower()
    configured = {h.strip().lower() for h in os.environ.get("NIBRS_PRODUCTION_HOSTNAMES", "").split(",") if h.strip()}
    if hostname in PRODUCTION_HOSTNAMES | configured:
        raise SystemExit(f"Refusing heavy rollup build on production web host {hostname!r}")


def table_columns(conn: sqlite3.Connection, schema: str, table: str) -> dict[str, str]:
    rows = conn.execute(f"PRAGMA {quote_ident(schema)}.table_info({quote_ident(table)})").fetchall()
    return {row[1]: (row[2] or "TEXT") for row in rows}


def validate_specs(conn: sqlite3.Connection) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for spec in SPECS:
        columns = table_columns(conn, "source", spec.source)
        required = {"state", *spec.dimensions, *spec.measures}
        missing = required - columns.keys()
        if missing:
            raise RuntimeError(f"{spec.source} is missing required columns: {sorted(missing)}")
        result[spec.source] = columns
    return result


def create_metadata(conn: sqlite3.Connection, source: Path, source_generation: str) -> None:
    conn.executescript("""
        CREATE TABLE rollup_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
    """)
    stat = source.stat()
    values = {
        "schema_version": str(SCHEMA_VERSION),
        "source_path": str(source),
        "source_size": str(stat.st_size),
        "source_mtime_ns": str(stat.st_mtime_ns),
        "source_generation": source_generation,
        "built_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "builder_host": socket.gethostname(),
    }
    conn.executemany("INSERT INTO rollup_metadata(key,value) VALUES (?,?)", values.items())


def build_table(conn: sqlite3.Connection, spec: RollupSpec, source_columns: dict[str, str], level: str) -> None:
    if level not in {"state", "national"}:
        raise ValueError(level)
    target = f"{level}_{spec.source}"
    dimension_defs = [f"{quote_ident(c)} {source_columns[c]}" for c in spec.dimensions]
    measure_defs = [f"{quote_ident(c)} INTEGER NOT NULL" for c in spec.measures]
    conn.execute(f"CREATE TABLE {quote_ident(target)} (state TEXT, {', '.join(dimension_defs + measure_defs)})")

    select_state = "state" if level == "state" else "'US'"
    group_columns = (["state"] if level == "state" else []) + list(spec.dimensions)
    select_dimensions = ", ".join(quote_ident(c) for c in spec.dimensions)
    select_measures = ", ".join(f"SUM(COALESCE({quote_ident(c)},0)) AS {quote_ident(c)}" for c in spec.measures)
    source_relation = f"source.{quote_ident(spec.source)}" if level == "state" else quote_ident(f"state_{spec.source}")
    sql = f"""
      INSERT INTO {quote_ident(target)}
      SELECT {select_state}, {select_dimensions}, {select_measures}
      FROM {source_relation}
      GROUP BY {', '.join(quote_ident(c) for c in group_columns)}
    """
    started = time.monotonic()
    conn.execute(sql)

    prefix = ["state"] if level == "state" else []
    offense = next((c for c in spec.dimensions if c in {"ucr_arrest_offense", "ucr_offense_code"}), None)
    route_columns = prefix + ([offense] if offense else []) + ["year"]
    time_columns = prefix + ["year"]
    indexes = [("route", route_columns), ("time", time_columns)]
    for selective in ("age_group", "weapon_category", "weapon_type", "relationship_code", "circumstance_code"):
        if selective in spec.dimensions:
            indexes.append((selective, prefix + [selective, "year"] + ([offense] if offense else [])))
    for suffix, index_columns in indexes:
        conn.execute(
            f"CREATE INDEX {quote_ident('idx_' + target + '_' + suffix)} ON {quote_ident(target)} "
            f"({', '.join(quote_ident(c) for c in index_columns)})"
        )
    rows = conn.execute(f"SELECT COUNT(*) FROM {quote_ident(target)}").fetchone()[0]
    print(f"built {target}: {rows:,} rows in {time.monotonic() - started:.1f}s", flush=True)


def verify_table(conn: sqlite3.Connection, spec: RollupSpec, level: str) -> None:
    target = f"{level}_{spec.source}"

    geo_columns = ["state", "year"] if level == "state" else ["year"]
    geo_select = ", ".join(quote_ident(c) for c in geo_columns)
    actual_filter = "state <> 'US'" if level == "state" else "state = 'US'"
    join_columns = ",".join(geo_columns)
    expected_relation = f"source.{quote_ident(spec.source)}" if level == "state" else quote_ident(f"state_{spec.source}")
    mismatches = conn.execute(f"""
      WITH expected AS (
        SELECT {geo_select}, {', '.join(f'SUM(COALESCE({quote_ident(m)},0)) AS {quote_ident(m)}' for m in spec.measures)}
        FROM {expected_relation} GROUP BY {geo_select}
      ), actual AS (
        SELECT {geo_select}, {', '.join(f'SUM({quote_ident(m)}) AS {quote_ident(m)}' for m in spec.measures)}
        FROM {quote_ident(target)}
        WHERE {actual_filter} GROUP BY {geo_select}
      )
      SELECT COUNT(*) FROM expected e LEFT JOIN actual a USING({join_columns})
      WHERE {' OR '.join(f'COALESCE(e.{quote_ident(m)},0) <> COALESCE(a.{quote_ident(m)},0)' for m in spec.measures)}
    """).fetchone()[0]
    if mismatches:
        raise RuntimeError(f"{level}/year mismatch: {target}: {mismatches} groups")
    print(f"verified {target}", flush=True)
def fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="Snapshot/copy of nibrs.db")
    parser.add_argument("--output", required=True, type=Path, help="New compact SQLite database")
    parser.add_argument("--skip-verify", action="store_true", help="Skip exact total verification (not for release builds)")
    parser.add_argument("--source-generation", help="Generation token captured from the production source marker")
    args = parser.parse_args()

    refuse_production()
    source = args.source.resolve()
    output = args.output.resolve()
    generation_output = Path(str(output) + ".generation")
    if not source.is_file() or source.stat().st_size == 0:
        raise SystemExit(f"Source database is missing or empty: {source}")
    if source == output:
        raise SystemExit("Output must not be the source database")
    if output.exists():
        raise SystemExit(f"Output already exists: {output}")
    if generation_output.exists():
        raise SystemExit(f"Generation sidecar already exists: {generation_output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    source_generation = (args.source_generation or f"{source.stat().st_size}:{source.stat().st_mtime_ns}").strip()
    if not source_generation:
        raise SystemExit("Source generation token cannot be empty")

    conn = sqlite3.connect(output, uri=True)
    try:
        conn.execute("PRAGMA page_size=8192")
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA temp_store=FILE")
        conn.execute("PRAGMA cache_size=-524288")
        conn.execute("ATTACH DATABASE ? AS source", (source_uri(source),))
        columns = validate_specs(conn)
        create_metadata(conn, source, source_generation)
        conn.commit()
        for spec in SPECS:
            for level in ("state", "national"):
                build_table(conn, spec, columns[spec.source], level)
                conn.commit()
        conn.execute("ANALYZE main")
        if not args.skip_verify:
            for spec in SPECS:
                verify_table(conn, spec, "state")
                verify_table(conn, spec, "national")
        conn.commit()
    except Exception:
        conn.close()
        if output.exists():
            output.unlink()
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass

    generation_output.write_text(source_generation + "\n", encoding="utf-8")
    print(f"output={output}")
    print(f"bytes={output.stat().st_size}")
    print(f"sha256={fingerprint(output)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
