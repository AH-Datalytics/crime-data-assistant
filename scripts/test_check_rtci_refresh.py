#!/usr/bin/env python3
"""Offline tests for the RTCI refresh checker. No network, no production, no database writes.

Every fetch is injected, so the suite runs in a clean clone with no credentials and no connectivity.

WHAT THESE PROTECT. The job this checker replaces failed four ways at once and reported none of them,
because one bare `except: pass` sat around the whole computation. So the cases below are not a
generic happy/sad pair -- each is one of the ways that job, or an earlier revision of this checker,
was silently wrong:

  malformed year/month       -> the old job read `r[Year]`, raised NameError, and called the result 0
  download failure           -> it fetched a 404 body and called the result 0
  forbidden path             -> it opened /opt/nibrs/crime_data.db, a registry-forbidden 0-byte path
  missing database           -> sqlite3 on a nonexistent file printed nothing and it carried on
  size / blob-SHA mismatch   -> revision 1 picked a file in one request and rebuilt its URL in
                                another, so the bytes verified were not provably the bytes selected
  database ahead of upstream -> revision 1 tested `upstream > agency` and called the rest up_to_date
  agency/national mismatch   -> revision 1 never compared the two tables at all
  identity change mid-check  -> revision 1 read the database across the network fetch

plus the two that make the status record trustworthy rather than decorative: a failed write must not
truncate the previous record, and a successful write must replace it atomically.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))

_spec = importlib.util.spec_from_file_location(
    "check_rtci_refresh", os.path.join(SCRIPTS_DIR, "check-rtci-refresh.py")
)
checker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(checker)

passed = 0
failures = []


def check(name, body):
    global passed
    with tempfile.TemporaryDirectory(prefix="rtci-check-") as workdir:
        try:
            body(workdir)
            passed += 1
            print(f"  ok    {name}")
        except AssertionError as error:
            failures.append(f"{name}: {error}")
            print(f"  FAIL  {name}\n        {error}")
        except Exception as error:  # a test that errors is a failure, never a skip
            failures.append(f"{name}: {type(error).__name__}: {error}")
            print(f"  FAIL  {name}\n        {type(error).__name__}: {error}")


# ---------------------------------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------------------------------

AUTHORITATIVE = "/opt/nibrs/shared/crime_data.db"
FORBIDDEN = ["/opt/nibrs/app/crime_data.db", "/opt/nibrs/crime_data.db", "/opt/nibrs/current/crime_data.db"]
SOURCE_NAME = "Crime_Index_Reported_Crime_Trends_Jan17_Jun26.csv"
SOURCE_URL = "https://raw.githubusercontent.com/AH-Datalytics/rtci/main/data/" + SOURCE_NAME
HEADER = "id,size,year,month,murder_total"


def write_registry(workdir, authoritative=AUTHORITATIVE, forbidden=None):
    path = os.path.join(workdir, "corpus-registry.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"corpora": [{
            "id": "rtci",
            "authoritative_remote": authoritative,
            "forbidden_remote": FORBIDDEN if forbidden is None else forbidden,
        }]}, handle)
    return path


def make_db(workdir, agency_periods, national_periods=None, receipts=True, name="crime_data.db",
            receipt_version=None, receipt_status="complete"):
    """agency_monthly and national_monthly can be given different periods, to exercise disagreement."""
    path = os.path.join(workdir, name)
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE agency_monthly (ori TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER)")
        conn.execute("CREATE TABLE national_monthly (year INTEGER, month INTEGER, offense TEXT, count INTEGER)")
        for year, month in agency_periods:
            conn.execute("INSERT INTO agency_monthly VALUES ('AL0010200', ?, ?, 'Murder', 1)", (year, month))
        for year, month in (agency_periods if national_periods is None else national_periods):
            conn.execute("INSERT INTO national_monthly VALUES (?, ?, 'Murder', 1)", (year, month))
        if receipts:
            conn.execute("""CREATE TABLE source_build_receipts (
                component TEXT PRIMARY KEY, source_version TEXT, source_sha256 TEXT, source_rows INTEGER,
                expected_rows INTEGER, actual_rows INTEGER, excluded_rows INTEGER, table_counts_json TEXT,
                status TEXT, built_at TEXT)""")
            # By default the receipt tracks the newest agency period, so an "up to date" fixture is
            # internally consistent. The provenance cases below override it deliberately.
            newest = max(agency_periods) if agency_periods else (2026, 5)
            version = receipt_version or f"{newest[0]:04d}-{newest[1]:02d}"
            conn.execute("INSERT INTO source_build_receipts VALUES "
                         "('current_trends_monthly',?,'0',1,1,1,0,'{}',?,'2026-08-16T17:46:17.047Z')",
                         (version, receipt_status))
        conn.commit()
    finally:
        conn.close()
    return path


def open_wal_fixture(path):
    """Put the fixture in WAL mode with committed-but-uncheckpointed rows, and HOLD the connection.

    Production is exactly this shape: PM2 is attached, so a `-shm` exists and the `-wal` is non-empty
    (measured 5.4 MiB on shr.db, 0 on crime_data.db, with a `-shm` on both). Closing the last
    connection would checkpoint the WAL away and delete it, so the handle is returned and the caller
    closes it -- otherwise the test would assert about a database that has no WAL at all.
    """
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA wal_autocheckpoint = 0")
    conn.execute("INSERT INTO agency_monthly VALUES ('AL0010200', 2026, 5, 'Robbery', 7)")
    conn.commit()
    return conn


def table_digest(path):
    """A content digest of the rows themselves, read through a separate read-only connection."""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT ori, year, month, offense, count FROM agency_monthly ORDER BY 1,2,3,4,5").fetchall()
        rows += conn.execute(
            "SELECT NULL, year, month, offense, count FROM national_monthly ORDER BY 2,3,4,5").fetchall()
        receipts = conn.execute(
            "SELECT component, source_version, status FROM source_build_receipts ORDER BY 1").fetchall()
    finally:
        conn.close()
    return hashlib.sha256(repr((rows, receipts)).encode("utf-8")).hexdigest()


def csv_bytes(periods, encoding="utf-8", bom=False):
    lines = [HEADER] + [f"AL0010200,all,{y},{m},5" for y, m in periods]
    data = ("\n".join(lines) + "\n").encode(encoding)
    return (b"\xef\xbb\xbf" + data) if bom else data


def listing_for(data, name=SOURCE_NAME, url=SOURCE_URL, size=None, sha=None, entry_type="file"):
    """A contents-API listing whose descriptor matches `data` unless deliberately overridden."""
    return [{
        "type": entry_type,
        "name": name,
        "download_url": url,
        "size": len(data) if size is None else size,
        "sha": checker.git_blob_sha1(data) if sha is None else sha,
    }]


def run(workdir, *, db=None, agency=None, national=None, data=None, listing=None,
        fetch_bytes=None, db_path=None, status_path=None, registry_path=None):
    """Drive one check. Defaults produce an internally consistent, up-to-date world."""
    if db is None:
        db = make_db(workdir, agency or [(2026, 5)], national)
    payload = csv_bytes([(2026, 5)]) if data is None else data
    entries = listing_for(payload) if listing is None else listing
    registry = registry_path or write_registry(workdir, authoritative=db_path or db)
    return checker.run_check(
        db_path or db,
        status_path or os.path.join(workdir, "status", "rtci-refresh-status.json"),
        fetch_listing=lambda: entries,
        fetch_bytes=fetch_bytes or (lambda _url: payload),
        registry_path=registry,
    )


def load_status(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256_of(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def sidecar_identities(db_path):
    """The database and every SQLite sidecar, by size, mtime and CONTENT HASH."""
    identities = {}
    for suffix in ("", "-wal", "-shm", "-journal"):
        path = db_path + suffix
        key = suffix or "db"
        if os.path.exists(path):
            stat = os.stat(path)
            identities[key] = (stat.st_size, stat.st_mtime_ns, sha256_of(path))
        else:
            identities[key] = None
    return identities


# ---------------------------------------------------------------------------------------------------
# Outcomes
# ---------------------------------------------------------------------------------------------------

def case_up_to_date(workdir):
    status_path = os.path.join(workdir, "status.json")
    code, status = run(workdir, agency=[(2026, 5), (2026, 6)], data=csv_bytes([(2026, 5), (2026, 6)]),
                       status_path=status_path)
    assert code == checker.EXIT_UP_TO_DATE, f"exit {code}, expected 0: {status.get('error')}"
    assert status["outcome"] == checker.UP_TO_DATE, status
    assert status["upstream_max_period"] == 202606 and status["database_max_period"] == 202606
    assert status["database_national_max_period"] == 202606, status
    on_disk = load_status(status_path)
    for field in ("checked_at_utc", "outcome", "upstream_max_period", "database_max_period",
                  "database_national_max_period", "resolved_database_path", "main_file_identity",
                  "receipts", "source"):
        assert field in on_disk, f"status record is missing {field}"
    for field in ("inode", "size_bytes", "mtime_ns"):
        assert field in on_disk["main_file_identity"], f"main-file identity is missing {field}"
    for field in ("declared_size_bytes", "declared_blob_sha", "observed_size_bytes",
                  "observed_blob_sha", "observed_sha256", "download_url"):
        assert field in on_disk["source"], f"source record is missing {field}"
    assert on_disk["receipts"][0]["status"] == "complete", on_disk["receipts"]


def case_update_available(workdir):
    code, status = run(workdir, agency=[(2026, 5)], data=csv_bytes([(2026, 5), (2026, 6)]))
    assert code == checker.EXIT_UPDATE_AVAILABLE, f"exit {code}: {status.get('error')}"
    assert code != 0, "update_available must NOT exit zero"
    assert status["outcome"] == checker.UPDATE_AVAILABLE, status
    assert status["upstream_max_period"] == 202606 and status["database_max_period"] == 202605


def case_database_ahead(workdir):
    # Revision 1 called this up_to_date. A database ahead of upstream is a foreign or partial import.
    code, status = run(workdir, agency=[(2026, 5), (2026, 7)], data=csv_bytes([(2026, 5), (2026, 6)]))
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "database_ahead_of_upstream", status["error"]


def case_table_period_mismatch(workdir):
    # national_monthly lagging agency_monthly is a half-applied import, not "up to date".
    code, status = run(workdir, agency=[(2026, 6)], national=[(2026, 5)], data=csv_bytes([(2026, 6)]))
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "database_table_period_mismatch", status["error"]
    assert "202606" in status["error"]["detail"] and "202605" in status["error"]["detail"], status["error"]


def case_national_empty(workdir):
    db = make_db(workdir, [(2026, 5)], national_periods=[])
    code, status = run(workdir, db=db, data=csv_bytes([(2026, 5)]))
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "database_national_missing_period", status["error"]


def case_invalid_local_month(workdir):
    db = make_db(workdir, [(2026, 5)])
    conn = sqlite3.connect(db)
    try:
        conn.execute("INSERT INTO agency_monthly VALUES ('AL0010200', 2026, 13, 'Murder', 1)")
        conn.commit()
    finally:
        conn.close()
    code, status = run(workdir, db=db, data=csv_bytes([(2026, 5)]))
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "database_period_malformed", status["error"]


# ---------------------------------------------------------------------------------------------------
# Upstream binding: discovery and download are one act
# ---------------------------------------------------------------------------------------------------

def case_size_mismatch(workdir):
    payload = csv_bytes([(2026, 6)])
    code, status = run(workdir, data=payload, listing=listing_for(payload, size=len(payload) + 1))
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "source_size_mismatch", status["error"]


def case_blob_sha_mismatch(workdir):
    payload = csv_bytes([(2026, 6)])
    code, status = run(workdir, data=payload, listing=listing_for(payload, sha="0" * 40))
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "source_blob_sha_mismatch", status["error"]


def case_descriptor_incomplete(workdir):
    payload = csv_bytes([(2026, 6)])
    entries = listing_for(payload)
    del entries[0]["sha"]
    code, status = run(workdir, data=payload, listing=entries)
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "source_descriptor_incomplete", status["error"]


def case_unexpected_host(workdir):
    payload = csv_bytes([(2026, 6)])
    entries = listing_for(payload, url="https://evil.example/data/" + SOURCE_NAME)
    code, status = run(workdir, data=payload, listing=entries)
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "source_host_unexpected", status["error"]


def case_declared_url_is_the_one_fetched(workdir):
    payload = csv_bytes([(2026, 5)])
    seen = []

    def recording_fetch(url):
        seen.append(url)
        return payload

    run(workdir, data=payload, fetch_bytes=recording_fetch)
    assert seen == [SOURCE_URL], f"the descriptor's own download_url must be fetched, got {seen}"


def case_bom_accepted(workdir):
    code, status = run(workdir, agency=[(2026, 5)], data=csv_bytes([(2026, 5)], bom=True))
    assert code == checker.EXIT_UP_TO_DATE, f"exit {code}: {status.get('error')}"
    assert status["upstream_max_period"] == 202605, status


def case_invalid_encoding_rejected(workdir):
    payload = HEADER.encode("utf-8") + b"\nAL0010200,all,2026,\xff\xfe,5\n"
    code, status = run(workdir, data=payload)
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "source_encoding_invalid", status["error"]


def case_download_failure(workdir):
    def exploding(_url):
        raise checker.CheckError("download_failed", "https://example.invalid/x.csv: URLError")

    code, status = run(workdir, fetch_bytes=exploding)
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "download_failed", status["error"]
    assert "example.invalid" in status["error"]["detail"], "the failing URL must be named"


def case_source_not_unique(workdir):
    payload = csv_bytes([(2026, 5)])
    db = make_db(workdir, [(2026, 5)])   # built once: run() would recreate it on the second pass
    for entries in ([], listing_for(payload) + listing_for(payload, name="Crime_Index_Other.csv")):
        code, status = run(workdir, db=db, data=payload, listing=entries)
        assert code == checker.EXIT_CHECK_FAILED, f"exit {code}"
        assert status["error"]["category"] == "source_not_unique", status["error"]


def case_schema_change_is_loud(workdir):
    renamed = b"ORI,Size,Year,Month,murder_total\nAL0010200,all,2026,6,5\n"
    code, status = run(workdir, data=renamed)
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "source_schema_changed", status["error"]


def case_malformed_upstream_period(workdir):
    bad = (HEADER + "\nAL0010200,all,2026,NOT_A_MONTH,5\n").encode("utf-8")
    code, status = run(workdir, data=bad)
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "source_period_malformed", status["error"]
    assert status["upstream_max_period"] is None, "a malformed source must not yield a period"


# ---------------------------------------------------------------------------------------------------
# Paths, database handling, status record
# ---------------------------------------------------------------------------------------------------

def case_missing_database(workdir):
    absent = os.path.join(workdir, "absent.db")
    code, status = run(workdir, db=absent, db_path=absent)
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "database_missing", status["error"]


def case_forbidden_path(workdir):
    registry = write_registry(workdir)
    code, status = run(workdir, db_path="/opt/nibrs/crime_data.db", registry_path=registry)
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "forbidden_path", status["error"]
    assert status["resolved_database_path"] is None, "a forbidden path must never be recorded as resolved"


def case_unauthorised_path(workdir):
    registry = write_registry(workdir)
    code, status = run(workdir, db_path="/tmp/somewhere-else.db", registry_path=registry)
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "unauthorised_path", status["error"]


def case_identity_change_during_observation(workdir):
    """A file replaced between the two identity reads must be refused, not summarised."""
    db = make_db(workdir, [(2026, 5)])
    registry = write_registry(workdir, authoritative=db)
    original = checker.database_identity
    calls = {"n": 0}

    def shifting_identity(path):
        calls["n"] += 1
        result = dict(original(path))
        if calls["n"] > 1:                       # the AFTER read sees a different file
            result["mtime_ns"] = result["mtime_ns"] + 1
        return result

    checker.database_identity = shifting_identity
    try:
        payload = csv_bytes([(2026, 5)])
        code, status = checker.run_check(
            db, os.path.join(workdir, "status.json"),
            fetch_listing=lambda: listing_for(payload),
            fetch_bytes=lambda _u: payload,
            registry_path=registry)
    finally:
        checker.database_identity = original
    assert calls["n"] >= 2, "identity must be read before AND after the observation"
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "database_changed_during_check", status["error"]


def case_status_write_failure(workdir):
    blocker = os.path.join(workdir, "blocked")
    with open(blocker, "w", encoding="utf-8") as handle:
        handle.write("not a directory")
    try:
        run(workdir, status_path=os.path.join(blocker, "status.json"))
    except checker.CheckError as error:
        assert error.category == "status_unwritable", error.category
        return
    raise AssertionError("a status write failure must raise, not pass silently")


def case_atomic_replacement(workdir):
    status_path = os.path.join(workdir, "status.json")
    db = make_db(workdir, [(2026, 5)])
    registry = write_registry(workdir, authoritative=db)

    def once(periods):
        payload = csv_bytes(periods)
        return checker.run_check(db, status_path,
                                 fetch_listing=lambda: listing_for(payload),
                                 fetch_bytes=lambda _u: payload,
                                 registry_path=registry)

    once([(2026, 5)])
    assert load_status(status_path)["outcome"] == checker.UP_TO_DATE
    once([(2026, 5), (2026, 6)])
    assert load_status(status_path)["outcome"] == checker.UPDATE_AVAILABLE

    leftovers = [n for n in os.listdir(workdir) if n.startswith(".rtci-refresh-status.")]
    assert not leftovers, f"temp files left behind: {leftovers}"


def case_never_writes_the_database(workdir):
    """A WAL-mode database with a live reader attached -- the production shape -- must not be mutated.

    WHAT IS ASSERTED, and what is only REPORTED. An earlier revision required every sidecar to stay
    byte-identical, which overclaimed: a read-only SQLite connection legitimately coordinates through
    an existing `-shm`, and production's `-shm` mtime (2026-08-26 02:26, on a database last written
    2026-08-18) already shows readers touching it. So the CONTRACT is that no SQL content and no main
    -file byte changes; sidecar behaviour is measured and printed rather than constrained.
    """
    db = make_db(workdir, [(2026, 5)])
    holder = open_wal_fixture(db)          # WAL now non-empty, -shm present, reader attached
    try:
        assert os.path.exists(db + "-wal") and os.path.getsize(db + "-wal") > 0, "fixture left no WAL"
        assert os.path.exists(db + "-shm"), "fixture left no SHM"

        registry = write_registry(workdir, authoritative=db)
        before_main = sha256_of(db)
        before_rows = table_digest(db)
        before_sidecars = sidecar_identities(db)

        payload = csv_bytes([(2026, 6)])
        checker.run_check(db, os.path.join(workdir, "s.json"),
                          fetch_listing=lambda: listing_for(payload),
                          fetch_bytes=lambda _u: payload,
                          registry_path=registry)

        after_main = sha256_of(db)
        after_rows = table_digest(db)
        after_sidecars = sidecar_identities(db)

        assert before_main == after_main, "the checker changed the MAIN database file"
        assert before_rows == after_rows, "the checker changed SQL content"

        moved = sorted(k for k in before_sidecars
                       if k != "db" and before_sidecars[k] != after_sidecars[k])
        print(f"        measured: main file unchanged, SQL content unchanged; "
              f"sidecars touched by a read-only open: {moved or 'none'}")
    finally:
        holder.close()


def case_receipt_not_complete(workdir):
    db = make_db(workdir, [(2026, 5)], receipt_status="failed")
    code, status = run(workdir, db=db, data=csv_bytes([(2026, 5)]))
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "receipt_not_complete", status["error"]


def case_receipt_period_mismatch(workdir):
    # Tables current, provenance describing a different import -- the state this check exists for.
    db = make_db(workdir, [(2026, 6)], receipt_version="2026-05")
    code, status = run(workdir, db=db, data=csv_bytes([(2026, 6)]))
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "receipt_period_mismatch", status["error"]
    assert "2026-05" in status["error"]["detail"] and "2026-06" in status["error"]["detail"], status["error"]


def case_receipt_absent(workdir):
    db = make_db(workdir, [(2026, 5)], receipts=False)
    code, status = run(workdir, db=db, data=csv_bytes([(2026, 5)]))
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] in ("receipt_not_unique", "receipts_unreadable"), status["error"]


def case_provenance_not_required_when_behind(workdir):
    """update_available is about periods, not provenance: a stale receipt must not mask it."""
    db = make_db(workdir, [(2026, 5)], receipt_version="2020-01")
    code, status = run(workdir, db=db, data=csv_bytes([(2026, 5), (2026, 6)]))
    assert code == checker.EXIT_UPDATE_AVAILABLE, f"exit {code}: {status.get('error')}"
    assert status["outcome"] == checker.UPDATE_AVAILABLE, status


def case_eligibility_failure_is_categorized(workdir):
    """A raise from inside the imported filter must still produce a status record.

    Injected rather than provoked by a CSV shape: with today's filter, `id` and `size` are the only
    keys touched and DictReader supplies None rather than raising for short rows, so no currently
    reachable CSV triggers it. The guard exists for the next change to that filter -- and without it
    the exception escapes run_check and NO status is written, which is the one failure this program
    must never have.
    """
    class Exploding:
        @staticmethod
        def filter_ori_rows(_rows):
            raise KeyError("size")

    original = checker.load_updater_module
    checker.load_updater_module = lambda: Exploding
    try:
        status_path = os.path.join(workdir, "status.json")
        code, status = run(workdir, data=csv_bytes([(2026, 6)]), status_path=status_path)
    finally:
        checker.load_updater_module = original
    assert code == checker.EXIT_CHECK_FAILED, f"exit {code}, expected 1"
    assert status["error"]["category"] == "source_eligibility_failed", status["error"]
    assert os.path.exists(status_path), "a status record must still be written"
    assert load_status(status_path)["error"]["category"] == "source_eligibility_failed"


# ---------------------------------------------------------------------------------------------------

if __name__ == "__main__":
    print("rtci refresh checker (offline; no network, no production, no database writes)")
    check("CHK-1  up to date exits zero and records identity, receipts and source", case_up_to_date)
    check("CHK-2  update available exits NON-zero", case_update_available)
    check("CHK-3  a database AHEAD of upstream fails, never up_to_date", case_database_ahead)
    check("CHK-4  agency/national period disagreement fails distinctly", case_table_period_mismatch)
    check("CHK-5  an empty national_monthly fails distinctly", case_national_empty)
    check("CHK-6  an invalid LOCAL month fails distinctly", case_invalid_local_month)
    check("CHK-7  listing size vs downloaded bytes must agree", case_size_mismatch)
    check("CHK-8  listing blob SHA vs downloaded bytes must agree", case_blob_sha_mismatch)
    check("CHK-9  a descriptor without url/size/sha is refused", case_descriptor_incomplete)
    check("CHK-10 a download_url on an unexpected host is refused", case_unexpected_host)
    check("CHK-11 the descriptor's OWN url is the one fetched", case_declared_url_is_the_one_fetched)
    check("CHK-12 a UTF-8 BOM is accepted, as the tracked importer does", case_bom_accepted)
    check("CHK-13 undecodable bytes are rejected, never replaced", case_invalid_encoding_rejected)
    check("CHK-14 download failure is reported with its URL", case_download_failure)
    check("CHK-15 zero or two candidate source files is a failure, never a guess", case_source_not_unique)
    check("CHK-16 an upstream column rename is reported as a schema change", case_schema_change_is_loud)
    check("CHK-17 a malformed upstream year/month fails, never yields a period", case_malformed_upstream_period)
    check("CHK-18 a missing database is reported, not skipped", case_missing_database)
    check("CHK-19 a registry-forbidden path is refused by name", case_forbidden_path)
    check("CHK-20 a path neither authoritative nor forbidden is refused", case_unauthorised_path)
    check("CHK-21 the database changing mid-observation is refused", case_identity_change_during_observation)
    check("CHK-22 a status write failure raises", case_status_write_failure)
    check("CHK-23 the status record is replaced atomically, leaving no temp files", case_atomic_replacement)
    check("CHK-24 a WAL-mode database with a live reader is not mutated", case_never_writes_the_database)
    check("CHK-25 an incomplete receipt blocks up_to_date", case_receipt_not_complete)
    check("CHK-26 a receipt describing a different period blocks up_to_date", case_receipt_period_mismatch)
    check("CHK-27 a missing current_trends_monthly receipt blocks up_to_date", case_receipt_absent)
    check("CHK-28 provenance does not mask update_available", case_provenance_not_required_when_behind)
    check("CHK-29 an eligibility raise is categorized and still writes a status", case_eligibility_failure_is_categorized)

    print(f"\nrtci refresh checker: {passed} passed, {len(failures)} failed")
    if failures:
        for failure in failures:
            print("  " + failure)
        sys.exit(1)
