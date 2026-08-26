#!/usr/bin/env python3
"""Daily RTCI refresh CHECK: does upstream have a period the database does not?

DETECTS. NEVER IMPORTS. This program fetches and validates the upstream source, opens the production
database read-only for one short read transaction, compares periods, writes a machine-readable status
record, and exits. It never writes the database, never passes --deploy, and never invokes the
importing updater. Acting on `update_available` is a human decision.

WHY THIS EXISTS, precisely. The job it replaces (`/opt/nibrs/auto-update-rtci.sh`, untracked) ran
daily for months and did nothing, for four independent reasons, none of which surfaced anywhere:

  1. it targeted /opt/nibrs/crime_data.db -- a 0-byte file, and one of the paths the corpus registry
     already declares `forbidden_remote`. Production serves /opt/nibrs/shared/crime_data.db.
  2. its embedded Python read `r[Year]` and `r[Month]` -- bare identifiers, no quotes, and the wrong
     case besides (the columns are lowercase). Every row raised NameError.
  3. every one of those raises was swallowed by a bare `except: pass`, so the computed upstream
     maximum was 0 and the "is there new data?" comparison was never true.
  4. it downloaded data/pre_processed.csv, which now 404s. curl returned the 404 body and (3) ate it.

A database mtime cannot detect any of that -- a job that does nothing leaves the same mtime as a job
that correctly found nothing to do. Hence the status record: it distinguishes "checked successfully,
already current" from "checked successfully, update available" from "could not check", and records
what it actually observed rather than only what it concluded.

EXIT CODES ARE PART OF THE CONTRACT. Zero means, and only means, `up_to_date`.

  0   up_to_date          upstream, agency_monthly and national_monthly all agree on the newest period
  10  update_available    checked successfully; upstream is ahead. Not an error -- but not silence.
  1   check_failed        the check could not be completed, or the database is in a state the check
                          refuses to summarise. The status record says which.

`update_available` is deliberately non-zero so that cron's default mail-on-nonzero and any future
monitor treat "we are behind" as something that must be looked at, rather than as routine success.

THREE ORDERING RULES, each of which was wrong in an earlier revision of this file:

  UPSTREAM FIRST, DATABASE LAST. The network fetch is slow and unbounded; the database is production.
  Holding an open SQLite connection to the live database across a multi-megabyte download is a
  liability with no benefit, so all upstream work completes before the database is opened, and the
  connection is closed immediately after one short read transaction.

  DISCOVERY AND DOWNLOAD ARE ONE ACT. The listing entry's own `download_url`, `size` and `sha` are
  carried to the download and verified against what arrives. Selecting a file in one request and
  reconstructing a URL for it in another leaves a window in which upstream can change underneath, and
  the check would then report about a file it never saw.

  EQUALITY, NOT "NOT BEHIND". Zero requires upstream == agency_monthly == national_monthly. A
  database AHEAD of upstream, or two tables disagreeing with each other, is not "up to date"; it is a
  state this program refuses to summarise, because both are symptoms of a partial or foreign import.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import io
import json
import os
import re
import sqlite3
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
REGISTRY_PATH = os.path.join(SCRIPTS_DIR, "fixtures", "corpus-registry.json")

GITHUB_API_CONTENTS = "https://api.github.com/repos/AH-Datalytics/rtci/contents/data"
SOURCE_HOST = "raw.githubusercontent.com"

# The published file's name embeds its own coverage range -- today
# `Crime_Index_Reported_Crime_Trends_Jan17_Jun26.csv`. It therefore CHANGES when the data updates,
# which is the whole event this checker exists to notice. Hardcoding the current name would
# reproduce defect (4) above on the next upstream refresh, so the file is DISCOVERED and the match
# must be unique: two candidates or none is a failure, never a guess.
SOURCE_PATTERN = re.compile(r"^Crime_Index_.*\.csv$")

# The tracked importer reads its CSVs with encoding="utf-8-sig" (update-rtci-db.py:90,173). This
# checker decodes identically and STRICTLY: errors="replace" would let a corrupted download parse
# into plausible-looking rows, which is defect (3) in a new costume.
SOURCE_ENCODING = "utf-8-sig"

EXIT_UP_TO_DATE = 0
EXIT_UPDATE_AVAILABLE = 10
EXIT_CHECK_FAILED = 1

UP_TO_DATE = "up_to_date"
UPDATE_AVAILABLE = "update_available"
CHECK_FAILED = "check_failed"


class CheckError(Exception):
    """A failure with a category and a path, carrying no sensitive content.

    Error text is written to the status record and to stderr, so it must never contain row values,
    agency names, ORIs, or any other corpus content -- only what kind of thing went wrong, which path
    or URL it went wrong on, and aggregate counts. Counts ARE carried deliberately: "3 rows carry a
    month outside 1-12" is what makes the failure actionable, and the imported eligibility filter
    prints an aggregate row count of its own.
    """

    def __init__(self, category: str, detail: str):
        super().__init__(f"{category}: {detail}")
        self.category = category
        self.detail = detail


# ---------------------------------------------------------------------------------------------------
# Path authority: the registry decides, not this file
# ---------------------------------------------------------------------------------------------------

def load_path_authority(registry_path: str = REGISTRY_PATH):
    """The authoritative and forbidden RTCI paths, read from the committed corpus registry.

    NOT a second hardcoded list. `/opt/nibrs/crime_data.db` is already declared `forbidden_remote`
    there, with the recorded reason, and the legacy updater wrote to it anyway. A copy of that list
    here would be free to drift from the one verification uses -- so there is one list, and this is
    a reader of it.
    """
    try:
        with open(registry_path, "r", encoding="utf-8") as handle:
            registry = json.load(handle)
    except OSError as error:
        raise CheckError("registry_unreadable", f"{registry_path}: {error.strerror}") from error
    except ValueError as error:
        raise CheckError("registry_malformed", f"{registry_path}: {error}") from error

    for corpus in registry.get("corpora", []):
        if corpus.get("id") == "rtci":
            authoritative = corpus.get("authoritative_remote")
            if not authoritative:
                raise CheckError("registry_malformed", f"{registry_path}: rtci has no authoritative_remote")
            return authoritative, list(corpus.get("forbidden_remote") or [])
    raise CheckError("registry_malformed", f"{registry_path}: no rtci corpus declared")


def resolve_database_path(requested: str, authoritative: str, forbidden: list) -> str:
    """Accept the authoritative path and nothing else. Forbidden paths are named, not merely absent.

    A plain "is it the authoritative path?" test would already reject the legacy locations. The
    forbidden list is consulted FIRST anyway, so the error says *why* -- `forbidden_path` rather than
    a generic mismatch -- because the whole failure being repaired here is a legacy path used
    silently for months.
    """
    def normalise(path: str) -> str:
        return os.path.normcase(os.path.normpath(path))

    wanted = normalise(requested)
    for legacy in forbidden:
        if wanted == normalise(legacy):
            raise CheckError("forbidden_path", f"{requested} is declared forbidden_remote in the corpus registry")
    if wanted != normalise(authoritative):
        raise CheckError("unauthorised_path", f"{requested} is not the registry's authoritative_remote ({authoritative})")
    return requested


# ---------------------------------------------------------------------------------------------------
# Reuse, not reimplementation
# ---------------------------------------------------------------------------------------------------

def load_updater_module():
    """Import the TRACKED updater so its row eligibility is used, not a second copy of it.

    scripts/update-rtci-db.py is not an importable module name (hyphens), hence the loader. What is
    borrowed is `filter_ori_rows`: keep rows whose `id` starts with two uppercase letters and whose
    `size` is "all". Restating that predicate here is exactly the drift the receipt-status defect
    taught us to refuse -- the eligible set would be free to diverge from the set the importer acts
    on, and the checker would then report about a population nobody imports.
    """
    path = os.path.join(SCRIPTS_DIR, "update-rtci-db.py")
    if not os.path.exists(path):
        raise CheckError("updater_missing", path)
    if SCRIPTS_DIR not in sys.path:
        sys.path.insert(0, SCRIPTS_DIR)
    spec = importlib.util.spec_from_file_location("tracked_update_rtci_db", path)
    if spec is None or spec.loader is None:
        raise CheckError("updater_unloadable", path)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        raise CheckError("updater_unloadable", f"{path}: {type(error).__name__}") from error
    if not hasattr(module, "filter_ori_rows"):
        raise CheckError("updater_incompatible", f"{path} has no filter_ori_rows")
    return module


# ---------------------------------------------------------------------------------------------------
# Upstream: discovery and download are one act
# ---------------------------------------------------------------------------------------------------

def default_fetch_listing(url: str = GITHUB_API_CONTENTS):
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as error:
        raise CheckError("listing_unavailable", f"{url}: {type(error).__name__}") from error


def default_fetch_bytes(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=600) as response:
            return response.read()
    except Exception as error:
        raise CheckError("download_failed", f"{url}: {type(error).__name__}") from error


def discover_source(listing) -> dict:
    """Select exactly one Crime_Index_*.csv and KEEP its descriptor.

    The entry's `download_url`, `size` and `sha` travel with it to the download step. An earlier
    revision returned only the name and rebuilt a branch URL later, which meant the file verified was
    not provably the file selected: upstream could publish between the two requests and the check
    would report a period from a file whose descriptor it never saw.
    """
    if not isinstance(listing, list):
        raise CheckError("listing_malformed", f"{GITHUB_API_CONTENTS}: expected a list of entries")
    candidates = [
        entry for entry in listing
        if isinstance(entry, dict) and entry.get("type") == "file"
        and SOURCE_PATTERN.match(entry.get("name") or "")
    ]
    if len(candidates) != 1:
        raise CheckError(
            "source_not_unique",
            f"{GITHUB_API_CONTENTS}: expected exactly one Crime_Index_*.csv, found {len(candidates)}",
        )

    entry = candidates[0]
    name = entry.get("name")
    url = entry.get("download_url")
    size = entry.get("size")
    blob_sha = entry.get("sha")
    if not url or not isinstance(size, int) or not blob_sha:
        raise CheckError("source_descriptor_incomplete",
                         f"{GITHUB_API_CONTENTS}: {name} lacks download_url, size or sha")

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != SOURCE_HOST:
        raise CheckError("source_host_unexpected",
                         f"{name}: download_url host is {parsed.netloc or '(none)'}, expected {SOURCE_HOST} over https")
    return {"name": name, "download_url": url, "declared_size_bytes": size, "declared_blob_sha": blob_sha}


def git_blob_sha1(data: bytes) -> str:
    """Git's object id for this content, so the descriptor's `sha` is checkable at all.

    The contents API reports a Git BLOB sha -- sha1 over "blob <len>\\0" plus the bytes -- not a
    sha256 of the file. Comparing a raw digest against it would never match, and a check that can
    never match is worse than no check.
    """
    header = f"blob {len(data)}".encode("ascii") + b"\x00"
    return hashlib.sha1(header + data).hexdigest()


def fetch_and_validate_source(descriptor: dict, fetch_bytes) -> dict:
    """Download the descriptor's own URL and prove the bytes are the ones it described."""
    data = fetch_bytes(descriptor["download_url"])
    if not isinstance(data, (bytes, bytearray)):
        raise CheckError("download_malformed", f"{descriptor['name']}: fetch did not return bytes")
    data = bytes(data)

    if len(data) != descriptor["declared_size_bytes"]:
        raise CheckError("source_size_mismatch",
                         f"{descriptor['name']}: listing declared {descriptor['declared_size_bytes']} bytes, "
                         f"download was {len(data)}")
    observed_blob = git_blob_sha1(data)
    if observed_blob != descriptor["declared_blob_sha"]:
        raise CheckError("source_blob_sha_mismatch",
                         f"{descriptor['name']}: listing declared blob {descriptor['declared_blob_sha'][:12]}..., "
                         f"download hashed to {observed_blob[:12]}...")
    try:
        text = data.decode(SOURCE_ENCODING)
    except UnicodeDecodeError as error:
        raise CheckError("source_encoding_invalid",
                         f"{descriptor['name']}: not decodable as {SOURCE_ENCODING} ({error.reason})") from error

    return {
        "text": text,
        "sha256": hashlib.sha256(data).hexdigest(),
        "blob_sha": observed_blob,
        "size_bytes": len(data),
    }


def upstream_max_period(csv_text: str, updater) -> int:
    """Newest YYYYMM among ELIGIBLE upstream rows.

    Every failure is raised. The predecessor's `except: pass` around exactly this computation is why
    a dead URL and a NameError both presented as "no new data" -- so a row whose year/month cannot be
    read is a malformed source, not a row to skip quietly.
    """
    try:
        rows = list(csv.DictReader(io.StringIO(csv_text)))
    except csv.Error as error:
        raise CheckError("source_malformed", f"CSV could not be parsed: {error}") from error
    if not rows:
        raise CheckError("source_empty", "upstream CSV contained no data rows")

    missing = [column for column in ("id", "size", "year", "month") if column not in rows[0]]
    if missing:
        raise CheckError("source_schema_changed", f"upstream CSV is missing column(s): {', '.join(missing)}")

    # filter_ori_rows indexes r["id"] and r["size"] directly, so a row that is short, or whose values
    # are not strings, raises KeyError or TypeError from inside the imported function. Letting that
    # escape would abort run_check before the status record is written -- the one outcome this whole
    # program exists to prevent -- so it is categorized here.
    try:
        eligible = updater.filter_ori_rows(rows)
    except CheckError:
        raise
    except Exception as error:
        raise CheckError("source_eligibility_failed",
                         f"the tracked updater's eligibility filter raised {type(error).__name__}") from error
    if not eligible:
        raise CheckError("source_no_eligible_rows", "no rows passed the tracked updater's eligibility filter")

    newest = 0
    for row in eligible:
        try:
            year = int(row["year"])
            month = int(row["month"])
        except (TypeError, ValueError) as error:
            raise CheckError("source_period_malformed",
                             f"a row carried an unreadable year/month: {type(error).__name__}") from error
        if not 1 <= month <= 12:
            raise CheckError("source_period_malformed", f"a row carried month={month}, outside 1-12")
        period = year * 100 + month
        if period > newest:
            newest = period
    return newest


# ---------------------------------------------------------------------------------------------------
# Database: observed last, briefly, read-only
# ---------------------------------------------------------------------------------------------------

def database_identity(db_path: str) -> dict:
    """Inode, size and nanosecond mtime of the MAIN database file only.

    Deliberately not "SQLite artifact identity": the `-wal` and `-shm` are coordination files that a
    read-only connection may legitimately touch, so they are not part of this comparison and must not
    be read as though they were.

    Recorded because the served database was observed changing on a day this job did not run: the
    status must attest to the file's identity, not only to the checker's own conclusion, or it stays
    blind to every other writer.
    """
    if not os.path.exists(db_path):
        raise CheckError("database_missing", db_path)
    try:
        stat = os.stat(db_path)
    except OSError as error:
        raise CheckError("database_unstattable", f"{db_path}: {error.strerror}") from error
    return {"inode": stat.st_ino, "size_bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def _max_period(conn, table: str, db_path: str):
    try:
        row = conn.execute(f"SELECT MAX(year * 100 + month) FROM {table}").fetchone()
    except sqlite3.Error as error:
        raise CheckError("database_query_failed", f"{db_path}:{table}: {type(error).__name__}") from error
    return row[0] if row and row[0] is not None else None


def _invalid_month_count(conn, table: str, db_path: str) -> int:
    try:
        row = conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE month IS NULL OR month < 1 OR month > 12"
        ).fetchone()
    except sqlite3.Error as error:
        raise CheckError("database_query_failed", f"{db_path}:{table}: {type(error).__name__}") from error
    return int(row[0]) if row else 0


def observe_database(db_path: str) -> dict:
    """One short read transaction, then close. Identity is taken before and after.

    A production SQLite connection is never held across the network fetch -- the caller has already
    finished all upstream work. Identity is compared across the observation so that a file swapped or
    rewritten mid-check is refused rather than summarised: the periods and the receipts would then
    describe two different files.
    """
    identity_before = database_identity(db_path)
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, isolation_level=None)
    except sqlite3.Error as error:
        raise CheckError("database_unopenable", f"{db_path}: {type(error).__name__}") from error

    try:
        # One deferred read transaction, so both maxima and the receipts describe a single snapshot
        # rather than three independent reads a writer could interleave with.
        conn.execute("BEGIN DEFERRED")
        agency_period = _max_period(conn, "agency_monthly", db_path)
        national_period = _max_period(conn, "national_monthly", db_path)
        agency_invalid = _invalid_month_count(conn, "agency_monthly", db_path)
        national_invalid = _invalid_month_count(conn, "national_monthly", db_path)
        try:
            receipts = conn.execute(
                "SELECT component, source_version, status, built_at FROM source_build_receipts "
                "ORDER BY component"
            ).fetchall()
        except sqlite3.Error as error:
            raise CheckError("receipts_unreadable", f"{db_path}: {type(error).__name__}") from error
    finally:
        try:
            conn.rollback()
        finally:
            conn.close()

    identity_after = database_identity(db_path)
    if identity_before != identity_after:
        raise CheckError("database_changed_during_check",
                         f"{db_path}: identity changed while it was being read")

    return {
        "identity": identity_before,
        "agency_period": agency_period,
        "national_period": national_period,
        "agency_invalid_months": agency_invalid,
        "national_invalid_months": national_invalid,
        "receipts": [
            {"component": r[0], "source_version": r[1], "status": r[2], "built_at": r[3]}
            for r in receipts
        ],
    }


def classify(upstream_period: int, observation: dict, db_path: str) -> str:
    """Zero requires exact agreement. Everything else is named and non-zero.

    An earlier revision compared `upstream > agency` and called the remainder `up_to_date`, which
    quietly accepted two different broken states: a database AHEAD of upstream (a foreign or partial
    import), and `national_monthly` lagging `agency_monthly` (a half-applied import). Both are
    reasons to look, not reasons to exit zero.
    """
    if observation["agency_invalid_months"] or observation["national_invalid_months"]:
        raise CheckError(
            "database_period_malformed",
            f"{db_path}: {observation['agency_invalid_months']} agency_monthly and "
            f"{observation['national_invalid_months']} national_monthly row(s) carry a month outside 1-12",
        )
    agency = observation["agency_period"]
    national = observation["national_period"]
    if agency is None:
        raise CheckError("database_has_no_periods", f"{db_path}: agency_monthly is empty")
    if national is None:
        raise CheckError("database_national_missing_period", f"{db_path}: national_monthly is empty")
    if agency != national:
        raise CheckError("database_table_period_mismatch",
                         f"{db_path}: agency_monthly is at {agency} but national_monthly is at {national}")
    if upstream_period > agency:
        return UPDATE_AVAILABLE
    if upstream_period < agency:
        raise CheckError("database_ahead_of_upstream",
                         f"{db_path}: database is at {agency} but upstream is at {upstream_period}")

    # The tables agree with upstream. Provenance must agree with the tables, or "current" describes a
    # different import than the one the receipts record -- current data with a stale or foreign
    # provenance trail is exactly the state a build receipt exists to make visible.
    assert_receipt_matches(observation["receipts"], agency, db_path)
    return UP_TO_DATE


def expected_source_version(period: int) -> str:
    """The `source_version` a current_trends_monthly receipt should carry for this period."""
    return f"{period // 100:04d}-{period % 100:02d}"


def assert_receipt_matches(receipts, agency_period: int, db_path: str) -> None:
    monthly = [r for r in receipts if r.get("component") == "current_trends_monthly"]
    if len(monthly) != 1:
        raise CheckError("receipt_not_unique",
                         f"{db_path}: expected exactly one current_trends_monthly receipt, found {len(monthly)}")
    receipt = monthly[0]
    if receipt.get("status") != "complete":
        raise CheckError("receipt_not_complete",
                         f"{db_path}: current_trends_monthly receipt status is "
                         f"{receipt.get('status')!r}, expected 'complete'")
    expected = expected_source_version(agency_period)
    if receipt.get("source_version") != expected:
        raise CheckError("receipt_period_mismatch",
                         f"{db_path}: agency_monthly is at {agency_period} but the "
                         f"current_trends_monthly receipt records source_version "
                         f"{receipt.get('source_version')!r}, expected {expected!r}")


# ---------------------------------------------------------------------------------------------------
# Status record
# ---------------------------------------------------------------------------------------------------

def write_status_atomically(status: dict, status_path: str) -> None:
    """Write to a temp file in the SAME directory, fsync, then rename over the target.

    A reader must never observe a half-written record, and a failed write must leave the previous
    record intact rather than truncating it -- a monitor that reads a truncated status and concludes
    "unknown" on a healthy day is the same false signal in a new place. Same directory because
    os.replace is only atomic within a filesystem.
    """
    directory = os.path.dirname(os.path.abspath(status_path)) or "."
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError as error:
        raise CheckError("status_unwritable", f"{directory}: {error.strerror}") from error

    handle = None
    temp_path = None
    try:
        fd, temp_path = tempfile.mkstemp(prefix=".rtci-refresh-status.", suffix=".tmp", dir=directory)
        handle = os.fdopen(fd, "w", encoding="utf-8")
        json.dump(status, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        handle = None
        os.replace(temp_path, status_path)
        temp_path = None
    except OSError as error:
        raise CheckError("status_unwritable", f"{status_path}: {error.strerror}") from error
    finally:
        if handle is not None:
            handle.close()
        if temp_path is not None and os.path.exists(temp_path):
            os.unlink(temp_path)


# ---------------------------------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------------------------------

def run_check(db_path_requested, status_path, *, fetch_listing, fetch_bytes, now=None,
              registry_path=REGISTRY_PATH):
    """Perform the check and write the status record. Returns (exit_code, status).

    The status record is written on EVERY outcome, including failure: a check that cannot report its
    own failure is the predecessor's defect wearing a different coat.
    """
    checked_at = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    status = {
        "checked_at_utc": checked_at,
        "outcome": CHECK_FAILED,
        "upstream_max_period": None,
        "database_max_period": None,
        "database_national_max_period": None,
        "resolved_database_path": None,
        "main_file_identity": None,
        "receipts": None,
        "source": None,
        "error": None,
    }

    try:
        authoritative, forbidden = load_path_authority(registry_path)
        db_path = resolve_database_path(db_path_requested, authoritative, forbidden)
        status["resolved_database_path"] = db_path

        updater = load_updater_module()

        # UPSTREAM FIRST: everything slow and remote finishes before production is touched.
        descriptor = discover_source(fetch_listing())
        fetched = fetch_and_validate_source(descriptor, fetch_bytes)
        status["source"] = {
            "name": descriptor["name"],
            "download_url": descriptor["download_url"],
            "declared_size_bytes": descriptor["declared_size_bytes"],
            "declared_blob_sha": descriptor["declared_blob_sha"],
            "observed_size_bytes": fetched["size_bytes"],
            "observed_blob_sha": fetched["blob_sha"],
            "observed_sha256": fetched["sha256"],
        }
        upstream_period = upstream_max_period(fetched["text"], updater)
        status["upstream_max_period"] = upstream_period

        # DATABASE LAST, briefly, with no connection held across anything remote.
        observation = observe_database(db_path)
        status["main_file_identity"] = observation["identity"]
        status["database_max_period"] = observation["agency_period"]
        status["database_national_max_period"] = observation["national_period"]
        status["receipts"] = observation["receipts"]

        status["outcome"] = classify(upstream_period, observation, db_path)
        exit_code = EXIT_UPDATE_AVAILABLE if status["outcome"] == UPDATE_AVAILABLE else EXIT_UP_TO_DATE
    except CheckError as error:
        status["outcome"] = CHECK_FAILED
        status["error"] = {"category": error.category, "detail": error.detail}
        exit_code = EXIT_CHECK_FAILED

    write_status_atomically(status, status_path)
    return exit_code, status


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Check whether upstream RTCI has a period the database lacks. Never imports.")
    parser.add_argument("--db", default=None, help="Database to check (default: the registry's authoritative_remote)")
    parser.add_argument("--status", required=True, help="Path of the JSON status record to write atomically")
    args = parser.parse_args(argv)

    try:
        db_path = args.db or load_path_authority()[0]
    except CheckError as error:
        print(f"ERROR {error.category}: {error.detail}", file=sys.stderr)
        return EXIT_CHECK_FAILED

    exit_code, status = run_check(
        db_path, args.status,
        fetch_listing=default_fetch_listing,
        fetch_bytes=default_fetch_bytes,
    )
    if status["outcome"] == CHECK_FAILED:
        error = status.get("error") or {}
        print(f"ERROR {error.get('category')}: {error.get('detail')}", file=sys.stderr)
    else:
        print(f"{status['outcome']}  upstream={status['upstream_max_period']}  "
              f"agency={status['database_max_period']}  national={status['database_national_max_period']}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
