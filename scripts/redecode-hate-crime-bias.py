"""Re-decode the bias labels of an existing hate_crime.db (hotfix 2026-10-12).

Every row's bias_desc and bias_category are set from its stored bias_code and data year by the shared FBI decoder
(scripts/hate_crime_bias.py), then the derived tables are rebuilt by the importer's own function. Order:
  1. take the exclusive lock shared with scripts/update-hate-crime.sh (busy: exit, nothing touched);
  2. an SQLite online backup of the database to --backup, then its check (integrity_check, equal row counts for every
     table); a failed check exits before any change;
  3. ONE transaction: the updates, the rebuild (commit=False), then every check:
       - each row carries its (code, year) reference label and group;
       - non-bias columns and the row count are unchanged;
       - no code outside the FBI list;
     COMMIT only if all pass; otherwise ROLLBACK.
Prints the counts by code and by group, before and after.

Usage: python3 scripts/redecode-hate-crime-bias.py --db /opt/nibrs/hate_crime.db --backup /opt/nibrs/backups/hate_crime.<ts>.db [--dry-run]
"""
import argparse
import importlib.util
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hate_crime_bias import decode, exclusive_lock, LockBusy  # noqa: E402

EXIT_OK = 0
EXIT_BUSY = 3
EXIT_BACKUP = 4
EXIT_FAILED = 5
EXIT_UNLISTED = 6

NON_BIAS = "id, year, state, state_name, ori, agency_name, population, pop_group, incident_number, incident_date, data_source, quarter, " \
           "total_individual_victims, total_offenders, offender_race, offender_ethnicity, offense_group, offense_code, offense_name, " \
           "offense_victims, location, bias_code, victim_types, adult_victims, juvenile_victims, adult_offenders, juvenile_offenders"


def _importer():
    spec = importlib.util.spec_from_file_location("import_hate_crime", os.path.join(HERE, "import-hate-crime.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _tables(conn):
    return [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def verify_backup(src_path, dst_path):
    """The backup is sound and holds the same rows: integrity_check ok, equal row counts for every table."""
    src = sqlite3.connect(src_path)
    dst = sqlite3.connect(dst_path)
    try:
        if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            return False
        tables = _tables(src)
        if tables != _tables(dst):
            return False
        return all(src.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] == dst.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables)
    finally:
        src.close()
        dst.close()


def _columns(conn):
    return [r[1] for r in conn.execute("PRAGMA table_info(hate_crime_incidents)")]


def _fingerprint(conn):
    cols = [c for c in NON_BIAS.split(", ") if c in _columns(conn)]
    rows = conn.execute(f"SELECT {', '.join(cols)} FROM hate_crime_incidents ORDER BY id").fetchall()
    return len(rows), hash(tuple(rows))


def _counts(conn):
    by_code = conn.execute("SELECT bias_code, bias_desc, bias_category, COUNT(*) FROM hate_crime_incidents GROUP BY 1, 2, 3 ORDER BY 1, 2").fetchall()
    by_group = conn.execute("SELECT bias_category, COUNT(*) FROM hate_crime_incidents GROUP BY 1 ORDER BY 1").fetchall()
    return by_code, by_group


def run(db_path, backup_path, dry_run=False, lock_path=None, rebuild=None):
    lock_path = lock_path or os.path.join(os.path.dirname(os.path.abspath(db_path)), "hate_crime.lock")
    try:
        with exclusive_lock(lock_path):
            return _run_locked(db_path, backup_path, dry_run, rebuild)
    except LockBusy:
        print(f"busy: {lock_path} is held (an import is running); nothing was changed")
        return EXIT_BUSY


def _run_locked(db_path, backup_path, dry_run, rebuild):
    # 2. a fresh online backup, checked before anything changes
    if os.path.exists(backup_path):
        print(f"backup path already exists: {backup_path}; refusing to overwrite")
        return EXIT_BACKUP
    src = sqlite3.connect(db_path)
    dst = sqlite3.connect(backup_path)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    if not verify_backup(db_path, backup_path):
        print(f"backup check FAILED for {backup_path}; nothing was changed")
        return EXIT_BACKUP
    print(f"backup written and checked: {backup_path}")

    rebuild = rebuild or _importer().rebuild_hate_crime_derived_tables
    conn = sqlite3.connect(db_path, isolation_level=None)
    try:
        before_counts = _counts(conn)
        before_print = _fingerprint(conn)
        pairs = conn.execute("SELECT DISTINCT bias_code, year FROM hate_crime_incidents").fetchall()
        unlisted = sorted({c for c, y in pairs if not decode(c, y)[3]})
        if unlisted:
            print(f"codes not in the FBI list: {unlisted}; nothing was changed")
            return EXIT_UNLISTED
        conn.execute("BEGIN IMMEDIATE")
        try:
            for code, year in pairs:
                label, group, _unresolved, _listed = decode(code, year)
                conn.execute("UPDATE hate_crime_incidents SET bias_desc = ?, bias_category = ? WHERE bias_code IS ? AND year IS ?", (label, group, code, year))
            rebuild(conn, None, commit=False)
            # Amendment 1: if anything committed early, nothing after this point can be validated before it lands.
            if not conn.in_transaction:
                raise RuntimeError("the transaction was committed before validation")
            # every check before the commit
            wrong = [(c, y) for c, y, d, g in conn.execute("SELECT DISTINCT bias_code, year, bias_desc, bias_category FROM hate_crime_incidents").fetchall()
                     if (d, g) != decode(c, y)[:2]]
            if wrong:
                raise RuntimeError(f"rows without their reference label: {wrong[:5]}")
            if _fingerprint(conn) != before_print:
                raise RuntimeError("non-bias data changed")
            if dry_run:
                raise _DryRun()
            conn.execute("COMMIT")
        except _DryRun:
            conn.execute("ROLLBACK")
            print("dry run: every check passed; rolled back")
        except Exception as exc:  # noqa: BLE001 - any failure rolls back, or restores the backup
            if conn.in_transaction:
                conn.execute("ROLLBACK")
                print(f"FAILED, rolled back: {exc}")
            else:
                # Amendment 1: a commit happened before the checks; the verified backup is the before-state.
                conn.close()
                _restore(backup_path, db_path)
                print(f"FAILED after an early commit; restored from the backup {backup_path}: {exc}")
            return EXIT_FAILED
        after_counts = _counts(conn) if not dry_run else None
        _report(before_counts, after_counts)
        return EXIT_OK
    finally:
        conn.close()


class _DryRun(Exception):
    pass


def _restore(backup_path, db_path):
    """Copy the verified backup back over the database (SQLite backup API), the whole database in one step."""
    src = sqlite3.connect(backup_path)
    dst = sqlite3.connect(db_path)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


def _report(before, after):
    print("\nbefore, by code: " + "; ".join(f"{c} {d} [{g}] {n:,}" for c, d, g, n in before[0]))
    print("before, by group: " + "; ".join(f"{g} {n:,}" for g, n in before[1]))
    if after:
        print("after, by code: " + "; ".join(f"{c} {d} [{g}] {n:,}" for c, d, g, n in after[0]))
        print("after, by group: " + "; ".join(f"{g} {n:,}" for g, n in after[1]))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--db", required=True)
    p.add_argument("--backup", required=True, help="where to write the fresh backup taken before any change (must not exist)")
    p.add_argument("--lock", default=None, help="the lock file shared with update-hate-crime.sh (default: <db folder>/hate_crime.lock)")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    return run(a.db, a.backup, a.dry_run, a.lock)


if __name__ == "__main__":
    sys.exit(main())
