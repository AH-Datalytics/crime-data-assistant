"""Relabel SHR circumstances in an existing shr.db from the FBI CDE codebook (CDE codebook fix 2026-10-13).

The importer (scripts/ops/shr-auto-update.js) had no names for circumstances 30 and 31, so their rows hold the bare
code, and it named 40 "Lover's Triangle" where CDE names it "Domestic Violence". This brings stored rows in line with
the corrected importer:
  - circumstance "30" -> "Human Trafficking/Commercial Sex Acts", "31" -> "Human Trafficking/Involuntary Servitude"
    (circumstance_group stays "Unknown": CDE gives these codes no group);
  - circumstance "Lover's Triangle" -> "Domestic Violence" (circumstance_group unchanged).
Order:
  1. the SHR refresh lock (<backups>/shr-refresh.lock, created exclusively; it exists: exit, nothing touched);
  2. an SQLite online backup to --backup, then its check (integrity_check, equal row counts); failure: exit;
  3. ONE transaction: the updates, then the checks, column by column (only `circumstance` changes, only on the
     listed values, every other column and every other table byte-equal); COMMIT only if all pass, else ROLLBACK.

Usage: python3 scripts/relabel-shr-codebook.py --db /opt/nibrs/shr.db --lock <backups>/shr-refresh.lock
         --backup <backups>/shr.<ts>.db [--dry-run]
"""
import argparse
import os
import sqlite3
import sys
from collections import Counter

EXIT_OK = 0
EXIT_BUSY = 3
EXIT_BACKUP = 4
EXIT_FAILED = 5

RELABEL = {
    "30": "Human Trafficking/Commercial Sex Acts",
    "31": "Human Trafficking/Involuntary Servitude",
    "Lover's Triangle": "Domestic Violence",
}


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


def _incidents(conn):
    cols = [r[1] for r in conn.execute("PRAGMA table_info(incidents)")]
    return cols, {r[0]: r for r in conn.execute(f"SELECT {', '.join(cols)} FROM incidents")}


def _other_tables(conn):
    """A digest of every table except incidents (row count and an order-independent hash of the rows)."""
    out = {}
    for t in _tables(conn):
        if t != "incidents":
            rows = conn.execute(f'SELECT * FROM "{t}"').fetchall()
            out[t] = (len(rows), sum(hash(r) for r in rows))
    return out


def check_columns(cols, before, after):
    bad = []
    if set(before) != set(after):
        return [f"incident ids differ: {len(before)} before, {len(after)} after"]
    ci = cols.index("circumstance")
    for rid, b in before.items():
        a = after[rid]
        if a[ci] != RELABEL.get(b[ci], b[ci]):
            bad.append(f"incident {rid}: circumstance {b[ci]!r} -> {a[ci]!r}")
        for i, col in enumerate(cols):
            if i != ci and a[i] != b[i]:
                bad.append(f"incident {rid}: {col} changed")
        if len(bad) > 20:
            break
    return bad


def run(db_path, lock_path, backup_path, dry_run=False, after_updates=None):
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        print(f"busy: {lock_path} exists (an SHR refresh is running, or one stopped without releasing it); nothing was changed")
        return EXIT_BUSY
    try:
        return _run_locked(db_path, backup_path, dry_run, after_updates)
    finally:
        os.close(fd)
        os.remove(lock_path)


def _run_locked(db_path, backup_path, dry_run, after_updates):
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

    conn = sqlite3.connect(db_path, isolation_level=None)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            cols, before = _incidents(conn)
            others = _other_tables(conn)
            ci, gi = cols.index("circumstance"), cols.index("circumstance_group")
            counts_before = Counter((r[ci], r[gi]) for r in before.values() if r[ci] in RELABEL)
            for old, new in RELABEL.items():
                conn.execute("UPDATE incidents SET circumstance = ? WHERE circumstance = ?", (new, old))
            if after_updates:
                after_updates(conn)  # test hook: a fault injected between the updates and the checks
            if not conn.in_transaction:
                raise RuntimeError("the transaction was committed before validation")
            _c, after = _incidents(conn)
            problems = check_columns(cols, before, after)
            if _other_tables(conn) != others:
                problems.append("another table changed")
            if problems:
                raise RuntimeError("column checks failed: " + "; ".join(problems[:5]))
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
    for (old, group), n in sorted(counts_before.items()):
        print(f"{old!r} [{group}] -> {RELABEL[old]!r}: {n:,} incidents")
    if not counts_before:
        print("no incident held a listed value; nothing to relabel")
    return EXIT_OK


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--db", required=True)
    p.add_argument("--lock", required=True, help="the SHR refresh lock file (<backups>/shr-refresh.lock)")
    p.add_argument("--backup", required=True, help="where to write the fresh backup taken before any change (must not exist)")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    return run(a.db, a.lock, a.backup, a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
