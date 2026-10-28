#!/usr/bin/env python3
"""Correct nibrs.db agency populations to the sum of all five batch-header county slots (2026-10-27).

bh_population() used to read only county slot 1 of the BH segment, so every agency that spans counties
was stored short (Kansas City, MO: 317,692 instead of 518,039). The importer is fixed; this corrects the
rows already stored, and the tables that copied agencies.population.

Two stages:

  compute  (off the server; reads the FBI master ZIPs, writes nothing to any database)
      python scripts/correct-nibrs-agency-population.py compute \
          --zip-dir <folder with nibrs-YYYY.zip> --agencies <live agencies CSV: ori,year,population> \
          --out corrections.csv [--years 2013 2014 ...]
      For each (year, ORI) in a year's BH segments: the value the old rule gives (slot 1, placeholder zeroed),
      the value the fixed bh_population() gives, and the stored value. status is:
        change     stored equals the old rule and the fixed value differs: this row is corrected;
        unchanged  the fixed value equals what is stored;
        mismatch   stored differs from the old rule: something else wrote it; NOT corrected, reported;
        not_stored the ORI-year has a BH line but no agencies row;
        conflict   the ORI-year has repeated BH lines with different population slots; NOT corrected;
        duplicate_stored  the agencies CSV has the ORI-year more than once; NOT corrected.
      It also prints the memberships an in-place correction does not add (population 0 -> some; all-year maximum
      crossing 50,000). 2017-2019 master ZIPs use Deflate64 and need the `inflate64` package.

  apply    (on the server; dry run unless --apply)
      python3 scripts/correct-nibrs-agency-population.py apply --db /opt/nibrs/nibrs.db \
          --corrections corrections.csv --row-backup <new file> [--apply]
      Takes the release lock and the NIBRS maintenance lock. Writes the before-image of every row it will
      touch (rowid, ori, year, before, after) to --row-backup (a new SQLite file) and checks it before changing
      anything. Then ONE transaction: every backed-up row must still hold its backed-up value, and every 'change'
      row and its copies must hold the value the CSV was computed from; agencies.population and the per-year
      copies (summary_clearance_city_annual, summary_carjacking_clearance) take the fixed value;
      agency_reporting_gaps, which holds each ORI's all-year maximum, takes the corrected maximum in every year of
      a corrected ORI; then checks (exact row counts, the agencies total moved by exactly the corrections, no
      population at or above 100,000,000). COMMIT only with --apply and all checks passing, otherwise ROLLBACK.
      nibrs_state_coverage is rebuilt afterwards by build-nibrs-state-coverage.py (it sums agencies.population),
      then the app workers are reloaded (the place resolver caches populations per process).

  restore  (on the server)
      python3 scripts/correct-nibrs-agency-population.py restore --db /opt/nibrs/nibrs.db --row-backup <file>
      Puts every backed-up value back, in one transaction, only if every row is still the corrected row (same
      rowid, ori, year and corrected value). Not usable after the tables were rebuilt or re-imported.

Exit codes: 0 ok, 2 refused (bad input or checks failed; nothing changed), 3 busy (a lock is held).
"""
import argparse
import csv
import importlib.util
import os
import struct
import sys
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

EXIT_OK, EXIT_REFUSED, EXIT_BUSY = 0, 2, 3
PLACEHOLDER = 100_000_000
# Tables holding a copy of agencies.population.
YEAR_COPIES = ("summary_clearance_city_annual", "summary_carjacking_clearance")  # keyed by (ori, year)
GAPS = "agency_reporting_gaps"  # holds each ORI's all-year maximum population
FIELDS = ("year", "ori", "stored", "old_rule", "fixed", "status")


def _updater():
    spec = importlib.util.spec_from_file_location("nibrs_auto_update_for_population", os.path.join(HERE, "nibrs-auto-update.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def old_rule(line, sint):
    """The pre-fix bh_population(): slot 1 only, placeholder zeroed."""
    v = sint(line, 105, 114)
    if v is not None and v >= PLACEHOLDER:
        return 0
    return v


# ---- reading the master ZIPs -------------------------------------------------------------------------

def _member_lines(path):
    """Yield the text lines of the largest member of a master ZIP. Deflate64 (method 9) goes through inflate64,
    with the member's CRC-32 and size checked at the end, as zipfile does for the other methods."""
    with zipfile.ZipFile(path) as zf:
        info = max(zf.infolist(), key=lambda i: i.file_size)
        if info.compress_type != 9:
            with zf.open(info) as f:
                for raw in f:
                    yield raw.decode("ascii", errors="replace").rstrip("\n")
            return
    import inflate64  # only the 2017-2019 ZIPs need it

    def chunks():
        with open(path, "rb") as f:
            f.seek(info.header_offset)
            header = f.read(30)
            name_len, extra_len = struct.unpack("<HH", header[26:30])
            f.seek(info.header_offset + 30 + name_len + extra_len)
            inflater, remaining, crc, size = inflate64.Inflater(), info.compress_size, 0, 0
            while remaining:
                data = f.read(min(1 << 20, remaining))
                if not data:
                    raise RuntimeError(f"{path}: truncated")
                remaining -= len(data)
                out = inflater.inflate(data)
                crc, size = zlib.crc32(out, crc), size + len(out)
                yield out
        if crc != info.CRC or size != info.file_size:
            raise RuntimeError(f"{path}: CRC/size mismatch")

    pending = b""
    for chunk in chunks():
        pending += chunk
        *lines, pending = pending.split(b"\n")
        for raw in lines:
            yield raw.decode("ascii", errors="replace")
    if pending:
        yield pending.decode("ascii", errors="replace")


def compute(zip_dir, agencies_csv, out_path, years=None):
    U = _updater()
    stored, dup_stored = {}, set()
    with open(agencies_csv, newline="") as f:
        for ori, year, pop in csv.reader(f):
            key = (int(year), ori)
            if key in stored:
                dup_stored.add(key)
            stored[key] = None if pop == "" else int(pop)
    years = sorted(years or {y for y, _ in stored})
    # The importer stores every BH line, so a repeated header is only safe to collapse when its five population
    # slots are identical; otherwise the ORI-year is a conflict and is not corrected.
    headers = {}
    for year in years:
        for line in _member_lines(os.path.join(zip_dir, f"nibrs-{year}.zip")):
            if not line.startswith("BH"):
                continue
            key = (year, U.s(line, 4, 13))
            slots = tuple(line[105 + 24 * k:114 + 24 * k] for k in range(5))
            prev = headers.get(key)
            if prev is None:
                headers[key] = (slots, old_rule(line, U.sint), U.bh_population(line))
            elif prev[0] != slots:
                headers[key] = ("conflict", None, None)
    counts, rows = {}, []
    for (year, ori), (slots, old, fixed) in sorted(headers.items()):
        cur = stored.get((year, ori), "")
        if (year, ori) in dup_stored:
            status = "duplicate_stored"
        elif slots == "conflict":
            status = "conflict"
        elif (year, ori) not in stored:
            status = "not_stored"
        elif cur == fixed:
            status = "unchanged"
        elif cur == old:
            status = "change"
        else:
            status = "mismatch"
        counts[(year, status)] = counts.get((year, status), 0) + 1
        rows.append((year, ori, cur, old, fixed, status))
    with open(out_path, "w", newline="") as out:
        w = csv.writer(out, lineterminator="\n")  # LF: the repository's checkouts are LF-only
        w.writerow(FIELDS)
        for r in rows:
            if r[5] != "unchanged":
                w.writerow(tuple("" if v is None else v for v in r))
    statuses = ("change", "unchanged", "mismatch", "not_stored", "conflict", "duplicate_stored")
    for year in years:
        print(f"{year}: " + ", ".join(f"{s} {counts.get((year, s), 0)}" for s in statuses))
    report_thresholds(stored, [r for r in rows if r[5] == "change"])
    return EXIT_OK


def report_thresholds(stored, changes, floor=50_000):
    """Memberships the in-place correction does not add: ORI-years going from no population to some
    (summary_clearance_city_annual keeps population > 0), and ORIs whose all-year maximum crosses 50,000
    (agency_reporting_gaps, build_cde_agency_totals.py and update_cde_totals.py select on it)."""
    new = dict(stored)
    for year, ori, cur, old, fixed, _ in changes:
        new[(year, ori)] = fixed
    zero_to_some = [(y, o) for y, o, cur, _, fixed, _ in changes if not cur and fixed]
    oris = {o for _, o, *_ in changes}

    def maxima(values):
        out = {}
        for (y, o), v in values.items():
            if o in oris and v is not None:
                out[o] = max(out.get(o, 0), v)
        return out

    before, after = maxima(stored), maxima(new)
    crossing = sorted(o for o in oris if before.get(o, 0) < floor <= after.get(o, 0))
    print(f"thresholds: {len(zero_to_some)} ORI-years go from 0 to a population (not added to "
          f"summary_clearance_city_annual); {len(crossing)} ORIs cross {floor:,} at their all-year maximum "
          f"(not added to agency_reporting_gaps or the CDE totals): {', '.join(crossing[:20])}")
    return zero_to_some, crossing


# ---- applying on the server --------------------------------------------------------------------------

def _num(v):
    return None if v == "" else int(v)


def read_changes(path):
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    if not rows or tuple(rows[0].keys()) != FIELDS:
        raise ValueError(f"{path}: expected columns {','.join(FIELDS)}")
    changes = [(int(r["year"]), r["ori"], _num(r["stored"]), _num(r["fixed"])) for r in rows if r["status"] == "change"]
    keys = [(y, o) for y, o, _, _ in changes]
    if len(keys) != len(set(keys)):
        raise ValueError(f"{path}: an ORI-year appears twice")
    for y, o, old, new in changes:
        if new is None or new >= PLACEHOLDER or new == old:
            raise ValueError(f"{path}: bad fixed value for {o} {y}: {new}")
    return changes


def _release_lock():
    """The server's release lock (release.sh, deploy and rollback hold it). None off the server; False if held."""
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


def _locked(fn):
    release_fd = _release_lock()
    if release_fd is False:
        print("busy: a release holds the release lock; nothing was changed")
        return EXIT_BUSY
    try:
        import nibrs_maintenance_lock
        try:
            with nibrs_maintenance_lock.held("correct-nibrs-agency-population"):
                return fn()
        except nibrs_maintenance_lock.LockError as exc:
            print(f"busy: {exc}; nothing was changed")
            return EXIT_BUSY
    finally:
        if release_fd:
            os.close(release_fd)


def write_backup(conn, changes, backup_path):
    """The before- and after-image of every row apply will touch, in a new SQLite file attached as 'bk'.

    agencies and the per-year copies take the ORI-year's corrected value. agency_reporting_gaps holds each ORI's
    all-year maximum population (build_reporting_gaps.py), so its rows for a corrected ORI, in every year, take the
    corrected all-year maximum. Each row is recorded with its rowid AND its identity (ori, year), so restore can
    refuse a row that is no longer the one backed up."""
    if os.path.exists(backup_path):
        raise ValueError(f"row backup already exists: {backup_path}; refusing to overwrite")
    conn.execute("ATTACH DATABASE ? AS bk", (backup_path,))
    conn.execute("CREATE TABLE bk.changes (year INTEGER, ori TEXT, old INTEGER, new INTEGER, PRIMARY KEY (year, ori))")
    conn.executemany("INSERT INTO bk.changes VALUES (?, ?, ?, ?)", changes)
    dup = conn.execute("""SELECT COUNT(*) FROM bk.changes c WHERE (SELECT COUNT(*) FROM main.agencies a
                          WHERE a.ori = c.ori AND a.year = c.year) != 1""").fetchone()[0]
    if dup:
        raise ValueError(f"{dup} corrected ORI-years do not have exactly one agencies row")
    conn.execute("""CREATE TABLE bk.gap_max AS
        SELECT a.ori, MAX(a.population) AS old_max,
               MAX(COALESCE((SELECT c.new FROM bk.changes c WHERE c.ori = a.ori AND c.year = a.year), a.population)) AS new_max
        FROM main.agencies a WHERE a.ori IN (SELECT ori FROM bk.changes) GROUP BY a.ori""")
    conn.execute("""CREATE TABLE bk.rows (tbl TEXT, row_id INTEGER, ori TEXT, year INTEGER, before INTEGER, after INTEGER,
                    PRIMARY KEY (tbl, row_id))""")
    for table in ("agencies",) + YEAR_COPIES:
        conn.execute(f"""INSERT INTO bk.rows SELECT '{table}', t.rowid, t.ori, t.year, t.population, c.new
                         FROM main."{table}" t JOIN bk.changes c ON t.ori = c.ori AND t.year = c.year""")
    conn.execute(f"""INSERT INTO bk.rows SELECT '{GAPS}', t.rowid, t.ori, t.year, t.population, g.new_max
                     FROM main."{GAPS}" t JOIN bk.gap_max g ON t.ori = g.ori""")
    conn.commit()
    n = conn.execute("SELECT COUNT(*) FROM bk.rows WHERE tbl = 'agencies'").fetchone()[0]
    ok = conn.execute("PRAGMA bk.integrity_check").fetchone()[0] == "ok"
    if not ok or n != len(changes):
        raise ValueError(f"row backup check failed: integrity {ok}, agencies rows {n} of {len(changes)}")


def _moved(conn, column):
    """Backed-up rows that are no longer the same row (rowid, ori, year) holding the given image's value."""
    moved = 0
    for table in ("agencies",) + YEAR_COPIES + (GAPS,):
        moved += conn.execute(f"""SELECT COUNT(*) FROM bk.rows b WHERE b.tbl = '{table}' AND NOT EXISTS (
                                  SELECT 1 FROM main."{table}" t WHERE t.rowid = b.row_id AND t.ori = b.ori
                                  AND t.year = b.year AND t.population IS b.{column})""").fetchone()[0]
    return moved


def _check_still_current(conn):
    """Inside the write transaction: every backed-up row still holds its backed-up value, and every copy held the
    value its source had (a copy out of step means something else wrote it, so nothing is changed)."""
    moved = _moved(conn, "before")
    if moved:
        raise ValueError(f"{moved} backed-up rows changed between the backup and the write transaction")
    stale = conn.execute("""SELECT COUNT(*) FROM bk.rows b JOIN bk.changes c ON c.ori = b.ori AND c.year = b.year
                            WHERE b.tbl != ? AND b.before IS NOT c.old""", (GAPS,)).fetchone()[0]
    if stale:
        raise ValueError(f"{stale} agencies or copy rows do not hold the value the corrections were computed from")
    gaps = conn.execute("""SELECT COUNT(*) FROM bk.rows b JOIN bk.gap_max g ON g.ori = b.ori
                           WHERE b.tbl = ? AND b.before IS NOT g.old_max""", (GAPS,)).fetchone()[0]
    if gaps:
        raise ValueError(f"{gaps} agency_reporting_gaps rows do not hold their ORI's all-year maximum population")


def _write(conn, column):
    """Set every backed-up row to its 'after' (apply) or 'before' (restore) value; returns rows per table."""
    report = {}
    for table in ("agencies",) + YEAR_COPIES + (GAPS,):
        cur = conn.execute(f"""UPDATE main."{table}" SET population =
                (SELECT b.{column} FROM bk.rows b WHERE b.tbl = ? AND b.row_id = "{table}".rowid)
                WHERE rowid IN (SELECT row_id FROM bk.rows WHERE tbl = ?)""", (table, table))
        expected = conn.execute("SELECT COUNT(*) FROM bk.rows WHERE tbl = ?", (table,)).fetchone()[0]
        if cur.rowcount != expected:
            raise ValueError(f"{table}: wrote {cur.rowcount} rows, expected {expected}")
        report[table] = cur.rowcount
    return report


def apply(db_path, corrections, backup_path, commit):
    import sqlite3
    try:
        changes = read_changes(corrections)
    except ValueError as exc:
        print(f"refused: {exc}")
        return EXIT_REFUSED

    def run():
        conn = sqlite3.connect(db_path, isolation_level=None)
        try:
            write_backup(conn, changes, backup_path)
            print(f"row backup written and checked: {backup_path} ({len(changes)} agencies rows)")
            conn.execute("BEGIN IMMEDIATE")
            before_total = conn.execute("SELECT COUNT(*), TOTAL(population) FROM agencies").fetchone()
            _check_still_current(conn)
            report = _write(conn, "after")
            after_total = conn.execute("SELECT COUNT(*), TOTAL(population) FROM agencies").fetchone()
            delta = conn.execute("SELECT TOTAL(new - COALESCE(old, 0)) FROM bk.changes").fetchone()[0]
            if after_total[0] != before_total[0] or after_total[1] != before_total[1] + delta:
                raise ValueError(f"agencies totals moved unexpectedly: {before_total} -> {after_total}, delta {delta}")
            if conn.execute("SELECT COUNT(*) FROM agencies WHERE population >= ?", (PLACEHOLDER,)).fetchone()[0]:
                raise ValueError("a population at or above the 100,000,000 placeholder remains")
            for table, n in report.items():
                print(f"  {table}: {n} rows")
            print(f"  agencies population total {before_total[1]:,.0f} -> {after_total[1]:,.0f}")
            if commit:
                conn.execute("COMMIT")
                print("COMMITTED. Next: python3 scripts/build-nibrs-state-coverage.py --db-path " + db_path
                      + "; then reload the app workers before any live check.")
            else:
                conn.execute("ROLLBACK")
                print("dry run: all checks passed; ROLLED BACK. Re-run with --apply and a new --row-backup to commit.")
            return EXIT_OK
        except ValueError as exc:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            print(f"refused: {exc}; the database was not changed")
            return EXIT_REFUSED
        finally:
            conn.close()

    return _locked(run)


def restore(db_path, backup_path):
    """Put every backed-up value back. Refuses unless every row is still the row that was corrected (same rowid,
    ori and year) and still holds the corrected value; a backup cannot be used after the tables were rebuilt or
    re-imported, because then rowids and values no longer identify the corrected rows."""
    import sqlite3

    def run():
        conn = sqlite3.connect(db_path, isolation_level=None)
        try:
            conn.execute("ATTACH DATABASE ? AS bk", (backup_path,))
            conn.execute("BEGIN IMMEDIATE")
            moved = _moved(conn, "after")
            if moved:
                raise ValueError(f"{moved} rows are no longer the corrected rows (rowid, ori, year or value differ)")
            n = sum(_write(conn, "before").values())
            conn.execute("COMMIT")
            print(f"restored {n} rows. Next: python3 scripts/build-nibrs-state-coverage.py --db-path {db_path}; "
                  "then reload the app workers.")
            return EXIT_OK
        except ValueError as exc:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            print(f"refused: {exc}; the database was not changed")
            return EXIT_REFUSED
        finally:
            conn.close()

    return _locked(run)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("compute")
    c.add_argument("--zip-dir", required=True)
    c.add_argument("--agencies", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--years", nargs="+", type=int)
    a = sub.add_parser("apply")
    a.add_argument("--db", required=True)
    a.add_argument("--corrections", required=True)
    a.add_argument("--row-backup", required=True)
    a.add_argument("--apply", action="store_true")
    r = sub.add_parser("restore")
    r.add_argument("--db", required=True)
    r.add_argument("--row-backup", required=True)
    args = p.parse_args(argv)
    if args.cmd == "compute":
        return compute(args.zip_dir, args.agencies, args.out, args.years)
    if args.cmd == "apply":
        return apply(args.db, args.corrections, args.row_backup, args.apply)
    return restore(args.db, args.row_backup)


if __name__ == "__main__":
    sys.exit(main())
