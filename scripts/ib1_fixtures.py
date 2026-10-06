"""Shared fixtures for the IB-1 server-side rollup tests (run in a disposable Linux container).

Nothing here touches production paths: every test builds its own directory tree, its own source
database, lock file, PM2 stub and freshness stub.
"""

from __future__ import annotations

import json
import os
import sqlite3
import stat
import sys
import textwrap
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent

TABLES = {
    "summary_arrestee_demographics": "ori TEXT,year INT,ucr_arrest_offense TEXT,weapon_category TEXT,race TEXT,sex TEXT,age_group TEXT,ethnicity TEXT,arrestee_count INT,state TEXT",
    "summary_victim_demographics": "ori TEXT,year INT,ucr_offense_code TEXT,weapon_category TEXT,race TEXT,sex TEXT,age_group TEXT,ethnicity TEXT,victim_count INT,state TEXT",
    "summary_offender_demographics": "ori TEXT,year INT,ucr_offense_code TEXT,weapon_category TEXT,race TEXT,sex TEXT,age_group TEXT,ethnicity TEXT,offender_count INT,state TEXT",
    "summary_victim_relationship": "state TEXT,ori TEXT,year INT,ucr_offense_code TEXT,relationship_code TEXT,sex TEXT,race TEXT,age_group TEXT,victim_count INT",
    "summary_victim_weapon": "ori TEXT,year INT,ucr_offense_code TEXT,weapon_type TEXT,victim_count INT,state TEXT",
    "summary_victim_circumstance": "ori TEXT,year INT,ucr_offense_code TEXT,circumstance_code TEXT,victim_count INT,state TEXT",
    "summary_victim_weapon_circumstance_demo": "state TEXT,ori TEXT,year INT,ucr_offense_code TEXT,weapon_type TEXT,circumstance_code TEXT,sex TEXT,race TEXT,age_group TEXT,victim_count INT",
    "summary_clearance_type": "year INT,month INT,state TEXT,ori TEXT,ucr_offense_code TEXT,total_offenses INT,cleared_by_arrest INT,cleared_exceptional INT",
    "summary_clearance_detail": "year INT,state TEXT,ori TEXT,ucr_offense_code TEXT,cleared_by_arrest INT,cleared_A INT,cleared_B INT,cleared_C INT,cleared_D INT,cleared_E INT,total_offenses INT",
}

ROWS = {
    "summary_arrestee_demographics": [("A", 2025, "90D", "Unknown", "W", "M", "18-24", "N", 3, "TX"),
                                      ("B", 2025, "90D", "Unknown", "W", "M", "18-24", "N", 5, "TX"),
                                      ("C", 2025, "90D", "Unknown", "B", "F", "25-34", "N", 7, "OH")],
    "summary_victim_demographics": [("A", 2025, "13A", "Firearm", "W", "M", "18-24", "N", 4, "TX"),
                                    ("C", 2025, "13A", "Firearm", "B", "F", "25-34", "H", 2, "OH")],
    "summary_offender_demographics": [("A", 2025, "120", "Knife", "W", "M", "25-34", "N", 6, "TX")],
    "summary_victim_relationship": [("TX", "A", 2025, "09A", "AQ", "M", "W", "25-34", 2),
                                    ("OH", "C", 2025, "09A", "SE", "F", "B", "35-44", 1)],
    "summary_victim_weapon": [("A", 2025, "09A", "11", 5, "TX"), ("C", 2025, "09A", "12", 1, "OH")],
    "summary_victim_circumstance": [("A", 2025, "09A", "01", 2, "TX")],
    "summary_victim_weapon_circumstance_demo": [("TX", "A", 2025, "09A", "11", "01", "M", "W", "18-24", 3)],
    "summary_clearance_type": [(2025, 1, "TX", "A", "13A", 10, 4, 1), (2025, 2, "OH", "C", "13A", 6, 2, 0)],
    "summary_clearance_detail": [(2025, "TX", "A", "13A", 4, 1, 0, 0, 0, 0, 10)],
}


def make_source(path: Path) -> None:
    db = sqlite3.connect(path)
    for table, columns in TABLES.items():
        db.execute(f"CREATE TABLE {table} ({columns})")
        rows = ROWS.get(table, [])
        if rows:
            db.executemany(f"INSERT INTO {table} VALUES ({','.join('?' * len(rows[0]))})", rows)
    db.commit()
    db.close()


def publish(source: Path, shared: Path) -> str:
    """Mirror publish_source_generation(): the marker is size:mtime_ns of the resolved source."""
    st = os.stat(os.path.realpath(source))
    token = f"{st.st_size}:{st.st_mtime_ns}"
    (shared / "nibrs_source.generation").write_text(token + "\n", encoding="utf-8")
    return token


def executable(path: Path, body: str) -> Path:
    path.write_text(textwrap.dedent(body).lstrip(), encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def pm2_stub(directory: Path, pid_text: str = "0", exit_code: int = 0) -> Path:
    """`pm2 pid` stand-in. pid_text may hold several lines (one per worker) or be empty."""
    escaped = pid_text.replace("\n", "\\n")
    path = directory / "pm2"
    path.write_text(f"#!/bin/sh\nprintf '%b\\n' '{escaped}'\nexit {exit_code}\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


# A faithful Python stand-in for scripts/check-nibrs-rollup-freshness.ts, implementing the router's
# inspectNibrsRollupAvailability() rules (lib/nibrs-rollup-router.ts). FRESHNESS_FORCE_FAIL=live
# makes checks against the live link fail, to exercise containment.
FRESHNESS_STUB = f"""
#!{sys.executable}
import json, os, sys
def gen(p):
    try:
        v = open(p, encoding='utf-8').read().replace('\\r', '').replace('\\n', '')
        return v or None
    except OSError:
        return None
def main():
    rollup = os.environ.get('NIBRS_ROLLUP_DB_PATH', '').strip()
    if not rollup:
        return {{'path': None, 'available': False, 'reason': 'rollup-unconfigured'}}
    force = os.environ.get('FRESHNESS_FORCE_FAIL', '')
    if force == 'live' and os.path.basename(rollup) == 'nibrs_rollups.db':
        return {{'path': None, 'available': False, 'reason': 'forced-test-failure'}}
    if force == 'live-new' and os.path.basename(rollup) == 'nibrs_rollups.db':
        # Fail only while the live link points at an artifact for the CURRENT generation (the new
        # one); once contained to a stale prior, report what the router would: a mismatch.
        if gen(os.path.realpath(rollup) + '.generation') == gen(os.environ['NIBRS_SOURCE_GENERATION_PATH']):
            return {{'path': None, 'available': False, 'reason': 'forced-test-failure'}}
    if force == 'all':
        return {{'path': None, 'available': False, 'reason': 'forced-test-failure'}}
    try:
        r = os.stat(rollup)
        if r.st_size <= 0:
            return {{'path': None, 'available': False, 'reason': 'rollup-empty'}}
        s = os.stat(os.environ['NIBRS_DB_PATH'])
        if s.st_mtime > r.st_mtime:
            return {{'path': None, 'available': False, 'reason': 'source-newer-than-rollup'}}
        source_gen = gen(os.environ['NIBRS_SOURCE_GENERATION_PATH'])
        rollup_gen = gen(os.path.realpath(rollup) + '.generation')
        if not source_gen or not rollup_gen:
            return {{'path': None, 'available': False, 'reason': 'generation-missing'}}
        if source_gen != rollup_gen:
            return {{'path': None, 'available': False, 'reason': 'generation-mismatch'}}
        return {{'path': rollup, 'available': True, 'reason': 'rollup-current'}}
    except OSError:
        return {{'path': None, 'available': False, 'reason': 'rollup-or-source-missing'}}
status = main()
print(json.dumps(status))
sys.exit(0 if status['available'] else 1)
"""


def freshness_stub(directory: Path) -> Path:
    return executable(directory / "freshness", FRESHNESS_STUB)


def old_artifact(shared: Path, name: str, generation: str) -> Path:
    path = shared / name
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE t (x)")
    db.commit()
    db.close()
    (shared / (name + ".generation")).write_text(generation + "\n", encoding="utf-8")
    return path


def read_json(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))
