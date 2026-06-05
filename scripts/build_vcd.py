"""
Safe resumable builder for summary_victim_clearance_demographics.

All person crimes with clearance + demographics, no circumstance_code.
Reads from a NIBRS input DB (ATTACHed), writes to a separate output SQLite DB.
Processes one year at a time, optionally one offense per year.
Delete/rebuild per chunk so reruns are idempotent. Indexes built only after all inserts.

Usage:
  # Test mode (default: 2023 only)
  python build_vcd.py --input ./nibrs.db --output ./vcd.db

  # Full rebuild
  python build_vcd.py --input ./nibrs.db --output ./vcd.db --years 1991-2025

  # Per-offense chunks (smaller transactions)
  python build_vcd.py --input ./nibrs.db --output ./vcd.db --years 2020-2023 --per-offense

  # Fast compatibility mode (connected_offense_1 only)
  python build_vcd.py --input ./nibrs.db --output ./vcd.db --connected-slots 1

  # Dry run -- print SQL without executing
  python build_vcd.py --input ./nibrs.db --output ./vcd.db --dry-run-sql

  # Verify existing output only
  python build_vcd.py --input ./nibrs.db --output ./vcd.db --verify-only
"""

import sqlite3
import time
import argparse
import sys
import os

# All NIBRS person-crime UCR offense codes
OFFENSE_CODES = [
    '09A', '09B', '09C',           # Murder, neg. manslaughter, justifiable homicide
    '11A', '11B', '11C', '11D',    # Sex offenses (rape, sodomy, sexual assault, fondling)
    '13A', '13B', '13C',           # Assault (aggravated, simple, intimidation)
    '100',                          # Kidnapping/abduction
    '36A', '36B',                   # Sex offenses (incest, statutory rape)
    '64A', '64B',                   # Human trafficking (commercial sex, involuntary servitude)
]

TABLE_NAME = 'summary_victim_clearance_demographics'
DEFAULT_CONNECTED_OFFENSE_SLOTS = (1, 2, 3)

PRODUCTION_PATHS = [
    '/opt/nibrs/nibrs.db',
    os.path.normpath('/opt/nibrs/nibrs.db'),
]


def log(msg):
    print(msg)
    sys.stdout.flush()


def rss_mb():
    """Return resident set size in MB, or None if unavailable."""
    try:
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    except (ImportError, AttributeError):
        pass
    try:
        import psutil
        return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)
    except ImportError:
        return None


def age_group_expr(col):
    return f"""CASE
        WHEN {col} IS NULL OR {col} = '' THEN 'Unknown'
        WHEN {col} IN ('BB','NB','NN','00') THEN 'Under 1'
        WHEN CAST({col} AS INTEGER) BETWEEN 1 AND 17 THEN 'Under 18'
        WHEN CAST({col} AS INTEGER) BETWEEN 18 AND 24 THEN '18-24'
        WHEN CAST({col} AS INTEGER) BETWEEN 25 AND 34 THEN '25-34'
        WHEN CAST({col} AS INTEGER) BETWEEN 35 AND 44 THEN '35-44'
        WHEN CAST({col} AS INTEGER) BETWEEN 45 AND 54 THEN '45-54'
        WHEN CAST({col} AS INTEGER) BETWEEN 55 AND 64 THEN '55-64'
        WHEN CAST({col} AS INTEGER) >= 65 THEN '65+'
        ELSE 'Unknown'
    END"""


def parse_years(years_str):
    """Parse '2023' or '1991-2025' into list of ints."""
    if '-' in years_str:
        lo, hi = years_str.split('-', 1)
        return list(range(int(lo), int(hi) + 1))
    return [int(years_str)]


def parse_connected_slots(slots_str):
    """Parse '1', '1,2,3', or '1-3' into connected_offense slot numbers."""
    slots = []
    for part in slots_str.split(','):
        part = part.strip()
        if not part:
            continue
        if '-' in part:
            lo, hi = part.split('-', 1)
            slots.extend(range(int(lo), int(hi) + 1))
        else:
            slots.append(int(part))

    slots = tuple(sorted(set(slots)))
    if not slots:
        raise argparse.ArgumentTypeError("connected slots cannot be empty")

    invalid = [slot for slot in slots if slot < 1 or slot > 7]
    if invalid:
        raise argparse.ArgumentTypeError(
            f"connected offense slots must be between 1 and 7: {invalid}")

    return slots


def build_arrested_sql(year):
    """Per-year temp table of incident/offense pairs with at least one arrestee.
    Includes ucr_arrest_offense so clearance is matched per-offense, not per-incident."""
    return f"""
    CREATE TEMP TABLE _tmp_arrested AS
    SELECT DISTINCT year, ori, incident_num, ucr_arrest_offense
    FROM nibrs.arrestees
    WHERE year = {year}
    """


def build_create_victim_offense_sql():
    """Create narrow-key staging table for deduped victim/offense rows.
    No circumstance_code -- this table covers all person crimes."""
    return """
    CREATE TEMP TABLE _tmp_victim_offense (
        victim_rowid INTEGER NOT NULL,
        offense_rowid INTEGER NOT NULL,
        state TEXT,
        ori TEXT,
        year INTEGER,
        ucr_offense_code TEXT,
        cleared_exceptionally TEXT,
        arrest_ori TEXT,
        sex TEXT,
        race TEXT,
        age TEXT,
        PRIMARY KEY (victim_rowid, offense_rowid)
    ) WITHOUT ROWID
    """


def build_insert_victim_offense_sql(year, connected_slot, offense=None):
    """Insert one connected_offense_N branch into the dedup staging table."""
    connected_offense_col = f"connected_offense_{connected_slot}"
    if offense:
        offense_filter = (f"AND v.{connected_offense_col} = '{offense}'\n"
                          f"            AND o.ucr_offense_code = '{offense}'")
    else:
        in_list = ','.join(repr(c) for c in OFFENSE_CODES)
        offense_filter = (f"AND v.{connected_offense_col} IN ({in_list})\n"
                          f"            AND o.ucr_offense_code IN ({in_list})")

    return f"""
    INSERT OR IGNORE INTO _tmp_victim_offense (
        victim_rowid,
        offense_rowid,
        state,
        ori,
        year,
        ucr_offense_code,
        cleared_exceptionally,
        arrest_ori,
        sex,
        race,
        age
    )
    SELECT
        v.rowid AS victim_rowid,
        o.rowid AS offense_rowid,
        v.state,
        v.ori,
        v.year,
        o.ucr_offense_code,
        i.cleared_exceptionally,
        _arr.ori AS arrest_ori,
        v.sex,
        v.race,
        v.age
    FROM nibrs.victims v
    JOIN nibrs.offenses o
        ON o.year = v.year AND o.state = v.state AND o.ori = v.ori
        AND o.incident_num = v.incident_num
        AND o.ucr_offense_code = v.{connected_offense_col}
    JOIN nibrs.incidents i
        ON i.year = v.year AND i.state = v.state AND i.ori = v.ori
        AND i.incident_num = v.incident_num
    LEFT JOIN _tmp_arrested _arr
        ON _arr.year = v.year AND _arr.ori = v.ori
        AND _arr.incident_num = v.incident_num
        AND _arr.ucr_arrest_offense = o.ucr_offense_code
    WHERE v.year = {year}
        {offense_filter}
    """


def build_delete_sql(year, offense=None):
    """Delete existing rows for this chunk so reruns are safe."""
    if offense:
        return (f"DELETE FROM {TABLE_NAME} "
                f"WHERE year = {year} AND ucr_offense_code = '{offense}'")
    return f"DELETE FROM {TABLE_NAME} WHERE year = {year}"


def build_aggregate_sql():
    """Aggregate deduped victim/offense staging rows into the output table."""
    agg_age = age_group_expr('j.age')
    return f"""
    INSERT INTO {TABLE_NAME}
    SELECT
        j.state,
        j.ori,
        j.year,
        j.ucr_offense_code,
        CASE
            WHEN j.cleared_exceptionally IN ('A','B','C','D','E') THEN 'exceptional'
            WHEN j.arrest_ori IS NOT NULL THEN 'arrest'
            ELSE 'not_cleared'
        END AS clearance_status,
        j.sex,
        j.race,
        {agg_age} AS age_group,
        COUNT(*) AS victim_count
    FROM _tmp_victim_offense j
    GROUP BY j.state, j.ori, j.year, j.ucr_offense_code,
        CASE
            WHEN j.cleared_exceptionally IN ('A','B','C','D','E') THEN 'exceptional'
            WHEN j.arrest_ori IS NOT NULL THEN 'arrest'
            ELSE 'not_cleared'
        END,
        j.sex, j.race,
        {agg_age}
    """


def run_verification(conn):
    """Print verification queries for 2023 data."""
    log("\n=== Verification (2023) ===")
    rows = conn.execute(f"""
        SELECT ucr_offense_code, clearance_status, SUM(victim_count)
        FROM {TABLE_NAME}
        WHERE year = 2023
        GROUP BY ucr_offense_code, clearance_status
        ORDER BY ucr_offense_code, clearance_status
    """).fetchall()
    if not rows:
        log("  No 2023 data found.")
    else:
        log(f"  {'Offense':<10} {'Clearance':<15} {'Victims':>10}")
        log(f"  {'-'*10} {'-'*15} {'-'*10}")
        for r in rows:
            log(f"  {r[0]:<10} {r[1]:<15} {r[2]:>10,}")

    log(f"\n=== Row counts by year ===")
    rows3 = conn.execute(f"""
        SELECT year, COUNT(*) AS rows, SUM(victim_count) AS victims
        FROM {TABLE_NAME}
        GROUP BY year ORDER BY year
    """).fetchall()
    for r in rows3:
        log(f"  {r[0]}: {r[1]:>8,} rows, {r[2]:>10,} victims")

    total = conn.execute(
        f"SELECT COUNT(*), COALESCE(SUM(victim_count),0) FROM {TABLE_NAME}"
    ).fetchone()
    log(f"\n  TOTAL: {total[0]:,} rows, {total[1]:,} victims")

    # Cross-validation against existing summary_victim_demographics
    log(f"\n=== Cross-validation vs nibrs.summary_victim_demographics (2023) ===")
    try:
        new_rows = conn.execute(f"""
            SELECT ucr_offense_code, SUM(victim_count) AS victims
            FROM {TABLE_NAME}
            WHERE year = 2023
            GROUP BY ucr_offense_code
            ORDER BY ucr_offense_code
        """).fetchall()
        existing_rows = conn.execute("""
            SELECT ucr_offense_code, SUM(victim_count) AS victims
            FROM nibrs.summary_victim_demographics
            WHERE year = 2023
            GROUP BY ucr_offense_code
            ORDER BY ucr_offense_code
        """).fetchall()
        existing_map = {r[0]: r[1] for r in existing_rows}
        new_map = {r[0]: r[1] for r in new_rows}
        # Only compare offense codes that appear in either set
        person_codes = set(OFFENSE_CODES)
        all_codes = sorted(
            (set(existing_map.keys()) | set(new_map.keys())) & person_codes
        )
        log(f"  {'Offense':<10} {'This build':>12} {'Existing':>12} {'Delta':>10}")
        log(f"  {'-'*10} {'-'*12} {'-'*12} {'-'*10}")
        for code in all_codes:
            n = new_map.get(code, 0)
            e = existing_map.get(code, 0)
            delta = n - e
            flag = " WARNING" if delta != 0 else ""
            log(f"  {code:<10} {n:>12,} {e:>12,} {delta:>+10,}{flag}")
        total_new = sum(new_map.get(c, 0) for c in all_codes)
        total_existing = sum(existing_map.get(c, 0) for c in all_codes)
        total_delta = total_new - total_existing
        flag = " WARNING" if total_delta != 0 else ""
        log(f"  {'TOTAL':<10} {total_new:>12,} {total_existing:>12,} {total_delta:>+10,}{flag}")
        if total_delta != 0:
            log("  WARNING: Deltas detected. Inspect by offense before trusting this build.")
            log("  Possible cause: existing table may use different connected_offense logic or victim_type filter.")
    except Exception as e:
        log(f"  Cross-validation skipped: {e}")


def main():
    parser = argparse.ArgumentParser(
        description='Build summary_victim_clearance_demographics (safe, resumable)')
    parser.add_argument('--input', required=True,
                        help='Path to input nibrs.db (read only)')
    parser.add_argument('--output', required=True,
                        help='Path to output SQLite DB (created if missing)')
    parser.add_argument('--years', default='2023',
                        help='Year or range, e.g. 2023 or 1991-2025 (default: 2023)')
    parser.add_argument('--per-offense', action='store_true',
                        help='Process one offense code per chunk within each year')
    parser.add_argument('--connected-slots',
                        default=','.join(str(s) for s in DEFAULT_CONNECTED_OFFENSE_SLOTS),
                        help='Connected offense slots to use, e.g. 1, 1-3, or 1,2,3 (default: 1-3)')
    parser.add_argument('--dry-run-sql', action='store_true',
                        help='Print generated SQL without executing')
    parser.add_argument('--verify-only', action='store_true',
                        help='Run verification queries on existing output DB')
    parser.add_argument('--allow-production-input', action='store_true',
                        help='Allow /opt/nibrs/nibrs.db as input (disabled by default)')
    args = parser.parse_args()

    # -- Production guard --
    input_abs = os.path.abspath(args.input)
    for prod_path in PRODUCTION_PATHS:
        if input_abs == os.path.abspath(prod_path):
            if not args.allow_production_input:
                log(f"REFUSED: input path resolves to production DB ({input_abs})")
                log("Pass --allow-production-input to override this safety guard.")
                sys.exit(1)
            else:
                log(f"WARNING: using production DB as input ({input_abs})")

    if not os.path.exists(args.input):
        log(f"ERROR: input DB not found: {args.input}")
        sys.exit(1)

    years = parse_years(args.years)
    connected_slots = parse_connected_slots(args.connected_slots)
    log(f"Input:  {os.path.abspath(args.input)}")
    log(f"Output: {os.path.abspath(args.output)}")
    log(f"Years:  {years[0]}-{years[-1]} ({len(years)} years)")
    log(f"Mode:   {'per-offense' if args.per_offense else 'per-year'}")
    log(f"Slots:  {','.join(str(s) for s in connected_slots)}")
    log(f"Offenses: {', '.join(OFFENSE_CODES)}")

    # -- Dry-run mode --
    if args.dry_run_sql:
        log("\n=== DRY RUN -- SQL only, no execution ===\n")
        for yr in years:
            log(f"-- Year {yr}: build per-year arrested lookup")
            log("DROP TABLE IF EXISTS _tmp_arrested;")
            log(build_arrested_sql(yr).strip() + ";")
            log("CREATE INDEX _tmp_arr_idx ON _tmp_arrested(year, ori, incident_num, ucr_arrest_offense);\n")

            offenses = OFFENSE_CODES if args.per_offense else [None]
            for off in offenses:
                label = f"Year {yr}, Offense {off}" if off else f"Year {yr}"
                log(f"-- {label}: stage deduped victim/offense rows")
                log("DROP TABLE IF EXISTS _tmp_victim_offense;")
                log(build_create_victim_offense_sql().strip() + ";")
                for slot in connected_slots:
                    log(f"-- {label}: connected_offense_{slot}")
                    log(build_insert_victim_offense_sql(yr, slot, off).strip() + ";\n")
                log(f"-- {label}: delete + aggregate")
                log(build_delete_sql(yr, off) + ";\n")
                log(build_aggregate_sql().strip() + ";\n")
                log("DROP TABLE IF EXISTS _tmp_victim_offense;\n")

            log("DROP TABLE IF EXISTS _tmp_arrested;\n")
        return

    # -- Open connections --
    conn = sqlite3.connect(args.output, timeout=300)
    conn.execute("PRAGMA temp_store = FILE")
    conn.execute("PRAGMA cache_size = -16000")
    conn.execute("PRAGMA busy_timeout = 300000")
    conn.execute("PRAGMA journal_mode = WAL")

    conn.execute("ATTACH DATABASE ? AS nibrs", (args.input,))

    # -- Create table (no circumstance_code) --
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
            state TEXT,
            ori TEXT,
            year INTEGER,
            ucr_offense_code TEXT,
            clearance_status TEXT,
            sex TEXT,
            race TEXT,
            age_group TEXT,
            victim_count INTEGER
        )
    """)
    conn.commit()

    # -- Verify-only mode --
    if args.verify_only:
        run_verification(conn)
        conn.close()
        return

    # -- Main build loop --
    t_total = time.time()

    for yr in years:
        t_year = time.time()

        # Build per-year arrested lookup (once per year, reused across offenses)
        conn.execute("DROP TABLE IF EXISTS _tmp_arrested")
        conn.execute(build_arrested_sql(yr))
        conn.execute("CREATE INDEX _tmp_arr_idx ON _tmp_arrested(year, ori, incident_num, ucr_arrest_offense)")

        arr_count = conn.execute("SELECT COUNT(*) FROM _tmp_arrested").fetchone()[0]
        log(f"\nYear {yr}: {arr_count:,} arrestee/offense pairs")

        offenses = OFFENSE_CODES if args.per_offense else [None]

        for off in offenses:
            label = f"  {yr}/{off}" if off else f"  {yr}"
            t0 = time.time()

            conn.execute("DROP TABLE IF EXISTS _tmp_victim_offense")
            conn.execute(build_create_victim_offense_sql())

            for slot in connected_slots:
                conn.execute(build_insert_victim_offense_sql(yr, slot, off))

            staged_count = conn.execute(
                "SELECT COUNT(*) FROM _tmp_victim_offense"
            ).fetchone()[0]

            # Delete existing chunk (idempotent)
            conn.execute(build_delete_sql(yr, off))

            # Aggregate staged, deduped victim/offense rows into output
            conn.execute(build_aggregate_sql())
            conn.commit()

            # Count what we inserted
            where = f"WHERE year = {yr}"
            if off:
                where += f" AND ucr_offense_code = '{off}'"
            row_count = conn.execute(
                f"SELECT COUNT(*) FROM {TABLE_NAME} {where}"
            ).fetchone()[0]
            victim_sum = conn.execute(
                f"SELECT COALESCE(SUM(victim_count),0) FROM {TABLE_NAME} {where}"
            ).fetchone()[0]

            elapsed = time.time() - t0
            mem = rss_mb()
            mem_str = f", RSS={mem:.0f}MB" if mem else ""
            log(f"{label}: {row_count:,} rows, {victim_sum:,} victims, "
                f"{staged_count:,} staged pairs, {elapsed:.1f}s{mem_str}")

            conn.execute("DROP TABLE IF EXISTS _tmp_victim_offense")

        # Drop temp after all offenses for this year
        conn.execute("DROP TABLE IF EXISTS _tmp_arrested")

        year_elapsed = time.time() - t_year
        log(f"  Year {yr} total: {year_elapsed:.1f}s")

    # -- Build indexes (after all inserts) --
    log("\nCreating indexes...")
    t_idx = time.time()
    indexes = [
        ("idx_vcd_state_year",  "state, year, ucr_offense_code"),
        ("idx_vcd_ori_year",    "ori, year"),
        ("idx_vcd_clearance",   "clearance_status, year"),
        ("idx_vcd_sex",         "sex, year"),
        ("idx_vcd_race",        "race, year"),
        ("idx_vcd_offense",     "ucr_offense_code, year"),
    ]
    for name, cols in indexes:
        conn.execute(f"DROP INDEX IF EXISTS {name}")
        conn.execute(f"CREATE INDEX {name} ON {TABLE_NAME}({cols})")
    conn.commit()
    log(f"  Indexes built in {time.time() - t_idx:.1f}s")

    # -- Summary --
    total_elapsed = time.time() - t_total
    total_rows = conn.execute(
        f"SELECT COUNT(*) FROM {TABLE_NAME}"
    ).fetchone()[0]
    total_victims = conn.execute(
        f"SELECT COALESCE(SUM(victim_count),0) FROM {TABLE_NAME}"
    ).fetchone()[0]
    log(f"\nDone: {total_rows:,} rows, {total_victims:,} victims "
        f"in {total_elapsed:.1f}s ({total_elapsed/60:.1f} min)")

    # -- Verification --
    run_verification(conn)

    conn.close()


if __name__ == '__main__':
    main()
