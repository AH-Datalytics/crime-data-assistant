"""Correct the national rape row of an existing crime_data.db to CIUS Table 1 (historical national rape fix, 2026-10-13).

The same correction the importer applies (historical_core.correct_national_rape), for a database already built:
historical_state_national 'United States' rape for 2017-2024 becomes CIUS Table 1's revised-definition estimate, with
rape_rate and total_offenses_rate recomputed and total_offenses moved by exactly the delta; a provenance row is written
to historical_national_rape_correction, which the application reads (with a 2018 sentinel) before it adds the matching
definition notes.

Order:
  1. a lock file created exclusively (--lock, default <db folder>/historical-national-rape.lock); it exists: exit 3;
  2. an SQLite online backup to --backup, then its check (integrity_check, equal row counts); failure: exit 4;
  3. ONE transaction: refuse an unreviewed national year, the correction, then the checks (only the eight national rows
     change, only the four columns, the values equal Table 1, the rates follow the formula, each total moved by exactly
     its delta, the marker row present, every other row and column byte-equal); COMMIT only if all pass, otherwise
     ROLLBACK (or, after an early commit, a restore from the backup); exit 5.

Usage: python3 scripts/correct-historical-national-rape.py --db /opt/nibrs/shared/crime_data.db --backup <new file> [--dry-run]
"""
import argparse
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import historical_core  # noqa: E402

EXIT_OK = 0
EXIT_BUSY = 3
EXIT_BACKUP = 4
EXIT_FAILED = 5
CHANGED = ("rape", "rape_rate", "total_offenses", "total_offenses_rate")


class _DryRun(Exception):
    pass


def _tables(conn):
    return [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def verify_backup(src_path, dst_path):
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


def _restore(backup_path, db_path):
    src = sqlite3.connect(backup_path)
    dst = sqlite3.connect(db_path)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


def _snapshot(conn):
    cols = [r[1] for r in conn.execute("PRAGMA table_info(historical_state_national)")]
    return cols, {(r[0], r[1]): dict(zip(cols, r)) for r in conn.execute(f"SELECT {', '.join(cols)} FROM historical_state_national")}


def check_columns(before, after, table1):
    bad = []
    if set(before) != set(after):
        return [f"row keys differ: {len(before)} before, {len(after)} after"]
    for key, b in before.items():
        a = after[key]
        corrected = key[0] == "United States" and key[1] in table1
        for col, val in b.items():
            if corrected and col in CHANGED:
                continue
            if a[col] != val:
                bad.append(f"{key}: {col} changed")
        if corrected:
            ref = table1[key[1]]
            delta = a["rape"] - b["rape"]
            if a["rape"] != ref["rape"]:
                bad.append(f"{key}: rape {a['rape']} is not Table 1's {ref['rape']}")
            if a["total_offenses"] != b["total_offenses"] + delta:
                bad.append(f"{key}: total_offenses moved by {a['total_offenses'] - b['total_offenses']}, not {delta}")
            for col, num in (("rape_rate", "rape"), ("total_offenses_rate", "total_offenses")):
                if abs(a[col] - a[num] * 100000.0 / a["population"]) > 1e-9:
                    bad.append(f"{key}: {col} does not follow the formula")
        if len(bad) > 20:
            break
    return bad


def _release_lock():
    """The server's release lock (scripts/release.sh, deploy and rollback hold it), so this write never lands while a
    release is comparing answers (release design 2026-10-27, Codex review r1 finding 6). Returns an open, locked
    descriptor; None where there is no such lock (a developer machine); False when a release holds it."""
    path = os.environ.get("CDA_RELEASE_LOCK", "/opt/nibrs/release.lock")
    if not os.path.isdir(os.path.dirname(path)):
        return None
    try:
        import fcntl
    except ImportError:
        return None
    fd = os.open(path, os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return False
    return fd


def run(db_path, backup_path, dry_run=False, lock_path=None, after_updates=None, correct=None):
    lock_path = lock_path or os.path.join(os.path.dirname(os.path.abspath(db_path)), "historical-national-rape.lock")
    release_fd = _release_lock()
    if release_fd is False:
        print("busy: a release holds /opt/nibrs/release.lock; nothing was changed")
        return EXIT_BUSY
    try:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            print(f"busy: {lock_path} exists; nothing was changed")
            return EXIT_BUSY
        try:
            return _run_locked(db_path, backup_path, dry_run, after_updates, correct or historical_core.correct_national_rape)
        finally:
            os.close(fd)
            os.remove(lock_path)
    finally:
        if release_fd:
            os.close(release_fd)


def _run_locked(db_path, backup_path, dry_run, after_updates, correct):
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

    _doc, table1 = historical_core.load_cius_table1()
    conn = sqlite3.connect(db_path, isolation_level=None)
    report = None
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            _cols, before = _snapshot(conn)
            historical_core.refuse_unreviewed_national_years(conn)
            report = correct(conn)
            if after_updates:
                after_updates(conn)  # test hook: a fault injected between the updates and the checks
            if not conn.in_transaction:
                raise RuntimeError("the transaction was committed before validation")
            _cols, after = _snapshot(conn)
            problems = check_columns(before, after, table1)
            marker = conn.execute(f"SELECT COUNT(*) FROM {historical_core.NATIONAL_RAPE_CORRECTION_TABLE} WHERE name = ?",
                                  (historical_core.NATIONAL_RAPE_CORRECTION_NAME,)).fetchone()[0]
            if marker != 1:
                problems.append("the marker row is missing")
            if problems:
                raise RuntimeError("checks failed: " + "; ".join(problems[:5]))
            if dry_run:
                raise _DryRun()
            conn.execute("COMMIT")
        except _DryRun:
            conn.execute("ROLLBACK")
            print("dry run: every check passed; rolled back")
        except Exception as exc:  # noqa: BLE001
            if conn.in_transaction:
                conn.execute("ROLLBACK")
                print(f"FAILED, rolled back: {exc}")
            else:
                conn.close()
                _restore(backup_path, db_path)
                print(f"FAILED after an early commit; restored from the backup {backup_path}: {exc}")
            return EXIT_FAILED
    finally:
        try:
            conn.close()
        except sqlite3.Error:
            pass
    for year, r in sorted((report or {}).items()):
        print(f"{year}: rape {r['old']:,} -> {r['new']:,} (delta {r['delta']:+,})")
    return EXIT_OK


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--db", required=True)
    p.add_argument("--backup", required=True, help="where to write the fresh backup taken before any change (must not exist)")
    p.add_argument("--lock", default=None)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    return run(a.db, a.backup, a.dry_run, a.lock)


if __name__ == "__main__":
    sys.exit(main())
