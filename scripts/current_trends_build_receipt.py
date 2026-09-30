"""Loss-detecting build receipts for Current Trends SQLite imports.

A receipt is written in the same transaction as the data whenever possible.  It is evidence, not a
success log: incomplete or unreconciled input raises instead of producing a ``complete`` receipt.
Runtime validation lives in ``lib/current-trends-readiness.ts``.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Mapping


# ``current_trends_monthly`` covers ALL THREE monthly projections -- agency, state and national.
# There is deliberately no separate state_monthly receipt: three receipts for one import would let
# two of them be complete while the third described a different month, which is the disagreement the
# receipt exists to make impossible. Listing state_monthly here makes ``live_table_counts`` record it
# in ``table_counts_json`` and refuse to complete while it is empty, at no extra cost.
#
# THIS MAP HAS A SECOND HOME: lib/current-trends-readiness.ts. The validator there loops the same
# list demanding a recorded count per table, so the two drift silently unless both are changed.
COMPONENT_TABLES = {
    "current_trends_monthly": ("agency_monthly", "agencies", "sample_agencies", "national_monthly",
                               "state_monthly"),
    "current_trends_population": ("agency_population",),
    "current_trends_crosswalk": ("agency_county_crosswalk",),
}


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def live_table_counts(conn: sqlite3.Connection, component: str) -> dict[str, int]:
    try:
        tables = COMPONENT_TABLES[component]
    except KeyError as error:
        raise ValueError(f"unknown Current Trends receipt component: {component}") from error
    counts: dict[str, int] = {}
    for table in tables:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if not exists:
            raise ValueError(f"cannot receipt {component}: required table {table} is missing")
        counts[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    return counts


def ensure_receipt_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS source_build_receipts (
          component TEXT PRIMARY KEY,
          source_version TEXT NOT NULL,
          source_sha256 TEXT NOT NULL,
          source_rows INTEGER NOT NULL CHECK(source_rows >= 0),
          expected_rows INTEGER NOT NULL CHECK(expected_rows >= 0),
          actual_rows INTEGER NOT NULL CHECK(actual_rows >= 0),
          excluded_rows INTEGER NOT NULL CHECK(excluded_rows >= 0),
          table_counts_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status = 'complete'),
          built_at TEXT NOT NULL
        )
    """)


def write_complete_receipt(
    conn: sqlite3.Connection,
    *,
    component: str,
    source_version: str,
    source_sha256: str,
    source_rows: int,
    expected_rows: int,
    actual_rows: int,
    excluded_rows: int = 0,
    table_counts: Mapping[str, int] | None = None,
) -> None:
    if component not in COMPONENT_TABLES:
        raise ValueError(f"unknown Current Trends receipt component: {component}")
    if not source_version.strip():
        raise ValueError("source_version is required")
    if len(source_sha256) != 64 or any(c not in "0123456789abcdefABCDEF" for c in source_sha256):
        raise ValueError("source_sha256 must be a hexadecimal SHA-256 digest")
    values = (source_rows, expected_rows, actual_rows, excluded_rows)
    if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in values):
        raise ValueError("receipt row counts must be non-negative integers")
    if source_rows == 0 or expected_rows == 0:
        raise ValueError(f"cannot complete {component}: a complete receipt requires nonempty source and imported rows")
    if expected_rows != actual_rows:
        raise ValueError(f"cannot complete {component}: expected {expected_rows} rows but wrote {actual_rows}")

    live = live_table_counts(conn, component)
    empty_tables = [table for table, count in live.items() if count == 0]
    if empty_tables:
        raise ValueError(f"cannot complete {component}: required table(s) are empty: {', '.join(empty_tables)}")
    if table_counts is not None and dict(table_counts) != live:
        raise ValueError(f"cannot complete {component}: supplied table counts do not match the database")

    ensure_receipt_table(conn)
    conn.execute("""
        INSERT OR REPLACE INTO source_build_receipts (
          component, source_version, source_sha256, source_rows, expected_rows,
          actual_rows, excluded_rows, table_counts_json, status, built_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    """, (
        component, source_version, source_sha256.lower(), source_rows, expected_rows,
        actual_rows, excluded_rows, json.dumps(live, sort_keys=True, separators=(",", ":")),
    ))
