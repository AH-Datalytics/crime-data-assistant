#!/usr/bin/env python3
"""Build and optionally publish the juvenile-offender incident rollup.

The source database is scanned read-only. A resumable work database holds only
incident keys that have a known offender age 1-17 and their distinct offense
scopes. SQLITE_TMPDIR should point at a volume with ample scratch space.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import socket
import time
from pathlib import Path


TABLE = "summary_juvenile_offender_incidents"
PRODUCTION_HOSTNAMES = {"ubuntu-8gb-ash-2"}


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def source_uri(path: Path, mode: str = "ro") -> str:
    return f"{path.as_uri()}?mode={mode}"


def scopes() -> dict[str, list[str]]:
    path = Path(__file__).resolve().parents[1] / "lib" / "nibrs-incident-offense-scopes.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not all(isinstance(v, list) and v for v in value.values()):
        raise RuntimeError("Invalid NIBRS incident offense scopes")
    return value


def free_bytes(path: Path) -> int:
    return shutil.disk_usage(path).free


def completed(conn: sqlite3.Connection, step: str) -> bool:
    return conn.execute("SELECT 1 FROM build_progress WHERE step=? AND completed=1", (step,)).fetchone() is not None


def mark_completed(conn: sqlite3.Connection, step: str) -> None:
    conn.execute(
        "INSERT INTO build_progress(step,completed,completed_at) VALUES (?,1,datetime('now')) "
        "ON CONFLICT(step) DO UPDATE SET completed=1,completed_at=excluded.completed_at",
        (step,),
    )
    conn.commit()


def run_step(conn: sqlite3.Connection, step: str, sql: str) -> None:
    if completed(conn, step):
        log(f"Skipping completed step: {step}")
        return
    started = time.monotonic()
    log(f"Starting: {step}")
    conn.executescript(sql)
    mark_completed(conn, step)
    log(f"Completed: {step} ({time.monotonic() - started:.1f}s)")


def build(source: Path, work: Path) -> None:
    work.parent.mkdir(parents=True, exist_ok=True)
    if free_bytes(work.parent) < 20 * 1024**3:
        raise RuntimeError(f"At least 20 GiB free is required on the work volume: {work.parent}")

    conn = sqlite3.connect(work, uri=True)
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=FILE")
    conn.execute("PRAGMA cache_size=-524288")
    conn.execute("CREATE TABLE IF NOT EXISTS build_progress(step TEXT PRIMARY KEY, completed INT NOT NULL, completed_at TEXT)")
    try:
        conn.execute("ATTACH DATABASE ? AS source", (source_uri(source),))
        run_step(conn, "juvenile_incident_keys", """
            CREATE TABLE IF NOT EXISTS juvenile_incidents (
              year INTEGER NOT NULL,
              ori TEXT NOT NULL,
              incident_num TEXT NOT NULL,
              state TEXT,
              month INTEGER,
              PRIMARY KEY(year, ori, incident_num)
            ) WITHOUT ROWID;
            INSERT OR IGNORE INTO juvenile_incidents(year,ori,incident_num,state,month)
            SELECT year, ori, incident_num, state,
                   CASE WHEN length(incident_date) >= 6 THEN CAST(substr(incident_date,5,2) AS INTEGER) END
            FROM source.offenders NOT INDEXED
            WHERE age GLOB '[0-9][0-9]'
              AND CAST(age AS INTEGER) BETWEEN 1 AND 17
              AND year IS NOT NULL AND ori IS NOT NULL AND incident_num IS NOT NULL;
        """)

        run_step(conn, "individual_offense_scopes", """
            CREATE TABLE IF NOT EXISTS qualifying_incident_scopes (
              year INTEGER NOT NULL,
              ori TEXT NOT NULL,
              incident_num TEXT NOT NULL,
              state TEXT,
              month INTEGER,
              offense_scope TEXT NOT NULL,
              PRIMARY KEY(year, ori, incident_num, offense_scope)
            ) WITHOUT ROWID;
            INSERT OR IGNORE INTO qualifying_incident_scopes
            SELECT j.year, j.ori, j.incident_num, COALESCE(o.state,j.state),
                   COALESCE(CASE WHEN length(o.incident_date) >= 6 THEN CAST(substr(o.incident_date,5,2) AS INTEGER) END,j.month),
                   o.ucr_offense_code
            FROM source.offenses AS o NOT INDEXED
            JOIN juvenile_incidents AS j
              ON j.year=o.year AND j.ori=o.ori AND j.incident_num=o.incident_num
            WHERE o.ucr_offense_code IS NOT NULL AND o.ucr_offense_code <> '';
        """)

        for name, codes in scopes().items():
            quoted = ",".join("'" + code.replace("'", "''") + "'" for code in codes)
            run_step(conn, f"combined_scope_{name}", f"""
                INSERT OR IGNORE INTO qualifying_incident_scopes
                SELECT year,ori,incident_num,state,month,'{name}'
                FROM qualifying_incident_scopes
                WHERE offense_scope IN ({quoted});
            """)

        run_step(conn, "aggregate", f"""
            CREATE TABLE IF NOT EXISTS {TABLE} (
              year INTEGER NOT NULL,
              month INTEGER,
              state TEXT,
              ori TEXT NOT NULL,
              offense_scope TEXT NOT NULL,
              incident_count INTEGER NOT NULL,
              PRIMARY KEY(year, month, ori, offense_scope)
            ) WITHOUT ROWID;
            INSERT OR REPLACE INTO {TABLE}
            SELECT year,month,state,ori,offense_scope,COUNT(*)
            FROM qualifying_incident_scopes
            GROUP BY year,month,state,ori,offense_scope;
            CREATE INDEX IF NOT EXISTS idx_sjoi_scope_year ON {TABLE}(offense_scope,year);
            CREATE INDEX IF NOT EXISTS idx_sjoi_state_year ON {TABLE}(state,year,offense_scope);
            CREATE TABLE IF NOT EXISTS build_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            INSERT OR REPLACE INTO build_metadata VALUES
              ('source_path',{json.dumps(str(source))}),
              ('source_size',{json.dumps(str(source.stat().st_size))}),
              ('built_at_utc',datetime('now'));
        """)
        validate(conn)
    finally:
        conn.close()


def validate(conn: sqlite3.Connection) -> None:
    duplicates = conn.execute(
        f"SELECT COUNT(*) FROM (SELECT year,month,ori,offense_scope,COUNT(*) n FROM {TABLE} GROUP BY year,month,ori,offense_scope HAVING n<>1)"
    ).fetchone()[0]
    invalid = conn.execute(f"SELECT COUNT(*) FROM {TABLE} WHERE incident_count <= 0 OR month NOT BETWEEN 1 AND 12").fetchone()[0]
    violent = conn.execute(f"SELECT COALESCE(SUM(incident_count),0) FROM {TABLE} WHERE offense_scope='violent_crime'").fetchone()[0]
    if duplicates or invalid or not violent:
        raise RuntimeError(f"Validation failed: duplicates={duplicates}, invalid={invalid}, violent_total={violent}")
    log(f"Validated rollup: violent incident total={violent:,}")


def publish(source: Path, work: Path, allow_production: bool, create_update_index: bool = False) -> None:
    if socket.gethostname().lower() in PRODUCTION_HOSTNAMES and not allow_production:
        raise RuntimeError("Publishing on production requires --allow-production")
    work_conn = sqlite3.connect(source_uri(work), uri=True)
    try:
        validate(work_conn)
    finally:
        work_conn.close()

    conn = sqlite3.connect(source, uri=True)
    conn.execute("PRAGMA busy_timeout=60000")
    try:
        conn.execute("ATTACH DATABASE ? AS build", (source_uri(work),))
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(f"DROP TABLE IF EXISTS main.{TABLE}_new")
        conn.execute(f"CREATE TABLE main.{TABLE}_new AS SELECT * FROM build.{TABLE}")
        conn.execute(f"DROP TABLE IF EXISTS main.{TABLE}")
        conn.execute(f"ALTER TABLE main.{TABLE}_new RENAME TO {TABLE}")
        conn.execute(f"CREATE UNIQUE INDEX main.idx_sjoi_key ON {TABLE}(year,month,ori,offense_scope)")
        conn.execute(f"CREATE INDEX main.idx_sjoi_scope_year ON {TABLE}(offense_scope,year)")
        conn.execute(f"CREATE INDEX main.idx_sjoi_state_year ON {TABLE}(state,year,offense_scope)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS main.nibrs_summary_freshness (
              summary_name TEXT PRIMARY KEY, ready INTEGER NOT NULL,
              refreshed_at TEXT NOT NULL, max_year INTEGER
            )
        """)
        conn.execute(
            f"INSERT OR REPLACE INTO main.nibrs_summary_freshness(summary_name,ready,refreshed_at,max_year) "
            f"SELECT ?,1,datetime('now'),MAX(year) FROM main.{TABLE}",
            (TABLE,),
        )
        conn.commit()
        log(f"Published {TABLE} atomically to {source}")
        if create_update_index:
            log("Creating idx_offenders_year_age for incremental refreshes...")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_offenders_year_age ON offenders(year,age)")
            conn.commit()
            log("Created idx_offenders_year_age")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--allow-production", action="store_true")
    parser.add_argument("--create-update-index", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve()
    work = args.work.resolve()
    if not source.is_file() or source.stat().st_size == 0:
        raise SystemExit(f"Missing source database: {source}")
    if source == work:
        raise SystemExit("Work database must differ from source")
    build(source, work)
    if args.publish:
        publish(source, work, args.allow_production, args.create_update_index)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
