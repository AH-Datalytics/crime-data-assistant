"""
Update crime_data.db from the AH-Datalytics/crime-sample GitHub repo.

Downloads crime_YYYYMM.csv, inserts new month into agency_monthly,
then re-aggregates national_monthly. Optionally deploys to VPS and rebuilds.

Usage:
    # Add a new month (e.g. March 2026):
    python scripts/update-rtci-db.py --month 202603

    # Full rebuild from latest file (replaces all agency_monthly data):
    python scripts/update-rtci-db.py --month 202603 --full-rebuild

    # Deploy to VPS and rebuild after updating:
    python scripts/update-rtci-db.py --month 202603 --deploy

    # Use a local CSV instead of downloading:
    python scripts/update-rtci-db.py --month 202603 --csv /path/to/crime_202603.csv
"""

import argparse
import csv
import io
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile

from current_trends_build_receipt import sha256_file, sha256_text, write_complete_receipt

GITHUB_REPO = "AH-Datalytics/crime-sample"
VPS_HOST = "root@178.156.243.51"
# Canonical production DB path (see CLAUDE.md Runtime Paths) — the old
# /opt/nibrs/app/ location is no longer read by the release-based deploys.
VPS_DB = "/opt/nibrs/shared/crime_data.db"
VPS_REPO = "/opt/nibrs/repo"
DEPLOY_BRANCH = "dev"

# Derived-table sources: agency_county_crosswalk must be rebuilt after any
# update because deploys wholesale-replace crime_data.db on the VPS.
CROSSWALK_BUILDER = os.path.join(os.path.dirname(__file__), "build-agency-county-crosswalk.py")
CROSSWALK_SOURCE_DEFAULT = r"C:\Users\jeffm\OneDrive\Documents\Participation Crosswalk.xlsx"
CROSSWALK_CDE_DEFAULT = r"C:\Users\jeffm\OneDrive\Documents\CDE Participation 2000-2023.csv"

# Population source — latest FBI agency populations
POP_CSV_DEFAULT = os.path.join(
    "C:/OneDrive/OneDrive - ahdatalytics.com/Clients/Real Time Crime Index",
    "Open Source Data/Historical Data/outputs/populations.csv"
)

OFFENSE_MAP = {
    "murder_total": "Murder",
    "rape_total": "Rape",
    "robbery_total": "Robbery",
    "assault_total": "Aggravated Assault",
    "burglary_total": "Burglary",
    "theft_total": "Theft",
    "motor_total": "Motor Vehicle Theft",
}


def download_csv(month_str):
    """Download crime_YYYYMM.csv from private GitHub repo using gh CLI."""
    filename = f"crime_{month_str}.csv"
    print(f"Downloading {filename} from {GITHUB_REPO}...")
    result = subprocess.run(
        ["gh", "api", f"repos/{GITHUB_REPO}/contents/outputs/{filename}", "--jq", ".download_url"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"ERROR: {result.stderr.strip()}")
        sys.exit(1)
    url = result.stdout.strip()
    dl = subprocess.run(["curl", "-s", url], capture_output=True, text=True)
    if dl.returncode != 0 or not dl.stdout.strip():
        print(f"ERROR: source download failed: {dl.stderr.strip() or 'empty response'}")
        sys.exit(1)
    rows = list(csv.DictReader(io.StringIO(dl.stdout)))
    if not rows:
        print("ERROR: source download contained no data rows")
        sys.exit(1)
    print(f"  {len(rows):,} rows downloaded")
    return rows


def load_local_csv(path):
    print(f"Loading {path}...")
    with open(path, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        print("ERROR: local source CSV contained no data rows")
        sys.exit(1)
    print(f"  {len(rows):,} rows")
    return rows


def filter_ori_rows(rows, year=None, month=None):
    """Keep only ORI rows (size=all, id starts with 2 uppercase letters)."""
    filtered = [
        r for r in rows
        if re.match(r"^[A-Z]{2}", r["id"]) and r["size"] == "all"
        and (year is None or int(r["year"]) == year)
        and (month is None or int(r["month"]) == month)
    ]
    print(f"  {len(filtered):,} ORI rows" + (f" for {year}-{month:02d}" if year else ""))
    return filtered


def rows_to_records(ori_rows, agency_info=None):
    """Convert every source ORI row to monthly records.

    sample_agencies is an aggregation cohort, not an import allowlist. Agency-level Current
    Trends must retain source agencies outside that cohort; otherwise each incremental update makes
    those places silently disappear. Directory metadata improves labels when available, while an
    unknown ORI is retained under its source identifier rather than dropped.
    """
    records = []
    for r in ori_rows:
        ori = r["id"]
        if agency_info is not None and ori in agency_info:
            agency, state, typ = agency_info[ori]
        else:
            agency = ori
            state = ori[:2]
            typ = ""
        year = int(r["year"])
        month = int(r["month"])
        for col, offense in OFFENSE_MAP.items():
            val = r.get(col, "").strip().replace(",", "")
            if not val:
                continue
            try:
                count = int(float(val))
            except ValueError:
                continue
            records.append((ori, agency, state, typ, year, month, offense, count))
    print(f"  {len(records):,} records")
    return records


def get_agency_info(db_path):
    """Load display metadata without using the national sample as an import filter."""
    conn = sqlite3.connect(db_path)
    rows = conn.execute("SELECT ori, agency, state, type FROM agencies").fetchall()
    historical_rows = conn.execute(
        "SELECT ori, agency, state, type FROM historical_agency"
    ).fetchall()
    conn.close()
    agency_info = {
        ori: (agency, (state or ori[:2]).upper(), typ)
        for ori, agency, state, typ in historical_rows
    }
    agency_info.update({ori: (agency, state, typ) for ori, agency, state, typ in rows})
    return agency_info


def hex_digest_argument(value):
    """An expected-digest flag takes a SHA-256 and nothing else.

    There is deliberately no value meaning "whatever is there". A boolean bypass records that
    somebody wanted to proceed; a named digest records what they believed they were adopting, and
    is wrong out loud when they were mistaken.
    """
    digest = value.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise argparse.ArgumentTypeError(f"expected a 64-character SHA-256 digest, got {value!r}")
    return digest


def authorize_input_digest(conn, component, path, flag_name, expect_sha256=None):
    """Refuse to change a reviewed build input unless the operator names its new digest.

    A monthly update is supposed to add a month. It is not supposed to quietly re-import the
    population denominators or rebuild the crosswalk from a different workbook because a file on
    disk moved underneath a default path -- which is exactly what was live: the updater's default
    populations.csv had been replaced four days after the database it was about to update was
    built, and nothing would have said so. Population is a denominator, so a changed one produces
    confidently wrong rates rather than a visible failure.

    Returns the observed digest. Exits non-zero rather than writing anything it cannot justify.
    """
    observed = sha256_file(path)
    has_receipts = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_build_receipts'"
    ).fetchone()
    row = conn.execute(
        "SELECT source_sha256 FROM source_build_receipts WHERE component=?", (component,)
    ).fetchone() if has_receipts else None
    stored = row[0].lower() if row and row[0] else None

    if stored is None:
        print(f"  no existing {component} receipt to protect; recording {observed[:16]}...")
        return observed
    if observed.lower() == stored:
        return observed

    if expect_sha256 is None:
        print(f"ERROR: {os.path.basename(path)} is not the input the {component} receipt records.")
        print(f"  receipt records : {stored}")
        print(f"  supplied input  : {observed}")
        print(f"  Refusing to change reviewed data as a side effect of a monthly update.")
        print(f"  To adopt this input deliberately, pass: {flag_name} {observed}")
        sys.exit(1)
    if expect_sha256.lower() != observed.lower():
        print(f"ERROR: {flag_name} does not describe the supplied {os.path.basename(path)}.")
        print(f"  receipt records : {stored}")
        print(f"  supplied input  : {observed}")
        print(f"  you named       : {expect_sha256.lower()}")
        sys.exit(1)
    print(f"  {component}: authorized input change to {observed[:16]}... (was {stored[:16]}...)")
    return observed


def make_staging_dir():
    """A run-owned directory for verified input copies."""
    return tempfile.mkdtemp(prefix="rtci-inputs-")


def remove_staging_dir(path):
    """Remove a staging directory whose files were deliberately made read-only.

    Restoring write permission first rather than relying on an rmtree error callback, whose keyword
    changed name across Python versions -- the cleanup of a verification step is a poor place to
    depend on that.
    """
    for entry in os.scandir(path) if os.path.isdir(path) else ():
        if entry.is_file():
            os.chmod(entry.path, stat.S_IWRITE | stat.S_IREAD)
    shutil.rmtree(path, ignore_errors=True)


def verified_input_copy(path, expected_digest, staging_dir):
    """Copy an authorized input into a run-owned read-only file and prove the copy's bytes.

    THE GAP THIS CLOSES. Authorization hashes a path. The parser then opens that path again, and
    the crosswalk builder opens it in a *separate process*. Between those opens the bytes can
    change -- a OneDrive sync lands, an export is regenerated -- so "the file I authorized" and
    "the file I parsed" were never provably the same object, and the digest written into the
    receipt was a third independent read. A receipt that records bytes nobody parsed is worse than
    no receipt, because it looks like provenance.

    Everything downstream consumes the returned copy, and the receipt records the returned digest,
    so the digest in the receipt is the digest of the bytes actually consumed.
    """
    destination = os.path.join(staging_dir, os.path.basename(path))
    shutil.copyfile(path, destination)
    observed = sha256_file(destination)
    if observed != expected_digest:
        print(f"ERROR: {os.path.basename(path)} changed while it was being staged.")
        print(f"  authorized digest : {expected_digest}")
        print(f"  staged copy       : {observed}")
        sys.exit(1)
    # Read-only so nothing in this process can rewrite what the receipt is about to describe.
    os.chmod(destination, stat.S_IREAD)
    return destination, observed


def refresh_populations(db_path, pop_csv, expect_sha256=None, staging_dir=None):
    """Refresh agency_population from the FBI populations CSV for sample agencies."""
    if not os.path.exists(pop_csv):
        # This used to warn and return, so a wrong path degraded to a skipped refresh and a stale
        # receipt instead of an error -- the quietest possible way to ship stale denominators.
        print(f"ERROR: populations CSV not found at {pop_csv}")
        sys.exit(1)

    # Gate on a short-lived connection: authorize_input_digest exits on refusal, and an exit while
    # the working connection is open leaves the file locked on Windows as well as unwritten.
    gate = sqlite3.connect(db_path)
    try:
        authorized = authorize_input_digest(gate, "current_trends_population", pop_csv,
                                            "--expect-population-sha256", expect_sha256)
    finally:
        gate.close()

    owns_staging = staging_dir is None
    staging_dir = staging_dir or make_staging_dir()
    try:
        verified, consumed_digest = verified_input_copy(pop_csv, authorized, staging_dir)
        _refresh_populations_from_verified(db_path, verified, consumed_digest)
    finally:
        if owns_staging:
            remove_staging_dir(staging_dir)


def _refresh_populations_from_verified(db_path, pop_csv, consumed_digest):
    """The write itself, against a copy whose bytes are already proven."""
    print(f"\nRefreshing agency_population from {os.path.basename(pop_csv)}"
          f" (consumed {consumed_digest[:16]}...)...")
    conn = sqlite3.connect(db_path)
    sample_oris = set(r[0] for r in conn.execute("SELECT ori FROM sample_agencies"))

    updated = 0
    inserted = 0
    source_rows = 0
    expected = {}
    with open(pop_csv, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            source_rows += 1
            if r["size"] != "all" or len(r["id"]) != 9:
                continue
            ori = r["id"]
            if ori not in sample_oris:
                continue
            yr = int(r["year"])
            if yr < 2017:
                continue
            pop = int(r["population"])
            expected[(ori, yr)] = pop
            existing = conn.execute(
                "SELECT population FROM agency_population WHERE ori=? AND year=?",
                (ori, yr)
            ).fetchone()
            if existing:
                if existing[0] != pop:
                    conn.execute(
                        "UPDATE agency_population SET population=? WHERE ori=? AND year=?",
                        (pop, ori, yr)
                    )
                    updated += 1
            else:
                conn.execute(
                    "INSERT INTO agency_population (ori, year, population) VALUES (?,?,?)",
                    (ori, yr, pop)
                )
                inserted += 1

    matched = sum(
        1 for (ori, yr), pop in expected.items()
        if conn.execute(
            "SELECT population FROM agency_population WHERE ori=? AND year=?", (ori, yr)
        ).fetchone() == (pop,)
    )
    write_complete_receipt(
        conn,
        component="current_trends_population",
        source_version=os.path.basename(pop_csv),
        source_sha256=consumed_digest,
        source_rows=source_rows,
        expected_rows=len(expected),
        actual_rows=matched,
        excluded_rows=source_rows - len(expected),
    )
    conn.commit()
    total_pop = conn.execute(
        "SELECT SUM(p.population) FROM agency_population p "
        "JOIN sample_agencies sa ON sa.ori = p.ori "
        "WHERE p.year = (SELECT MAX(year) FROM agency_population)"
    ).fetchone()[0]
    conn.close()
    print(f"  Updated: {updated}, Inserted: {inserted}")
    print(f"  Sample population (latest year): {total_pop:,}")


MONTHLY_PROJECTIONS = ("agency_monthly", "national_monthly", "state_monthly")


def assert_monthly_projections_aligned(conn, year, month):
    """All three monthly projections must agree before a receipt may claim completeness.

    Row counts are not alignment: every table can be non-empty while one of them still ends a
    month behind, which is exactly the defect that shipped unnoticed. This raises instead of
    returning a flag, and it is called before ``write_complete_receipt`` and before the single
    ``commit()``, so a misaligned write leaves no partial state to clean up.

    Two properties, not one:

      1. the imported period exists in ALL three tables -- catches "the month I asked for did
         not land in one of them";
      2. the three maxima are EQUAL -- catches "one projection lags the others".

    Deliberately NOT "every maximum equals the imported month": re-importing an older month into
    a database that already holds later ones is legitimate, and that stricter rule would reject
    it while catching nothing extra.
    """
    period = year * 100 + month
    maxima = {}
    absent = []
    for table in MONTHLY_PROJECTIONS:
        maxima[table] = conn.execute(f"SELECT MAX(year*100+month) FROM {table}").fetchone()[0]
        found = conn.execute(
            f"SELECT 1 FROM {table} WHERE year=? AND month=? LIMIT 1", (year, month)
        ).fetchone()
        if found is None:
            absent.append(table)
    if absent:
        raise RuntimeError(
            f"cannot receipt {period}: imported period missing from {', '.join(absent)}"
        )
    if len(set(maxima.values())) != 1:
        detail = ", ".join(f"{table}={maxima[table]}" for table in MONTHLY_PROJECTIONS)
        raise RuntimeError(f"monthly projections disagree on their newest period: {detail}")
    return maxima


def update_local_db(db_path, records, full_rebuild, year, month,
                    source_rows, excluded_rows, source_sha256):
    """Insert records into local crime_data.db."""
    print(f"\nUpdating local DB: {db_path}")
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")

    if full_rebuild:
        conn.execute("DELETE FROM agency_monthly")
        print("  Cleared agency_monthly (full rebuild)")
    else:
        conn.execute(
            "DELETE FROM agency_monthly WHERE year=? AND month=?", (year, month)
        )
        print(f"  Removed existing {year}-{month:02d} rows")

    conn.executemany(
        "INSERT INTO agency_monthly (ori,agency,state,type,year,month,offense,count) VALUES (?,?,?,?,?,?,?,?)",
        records
    )
    print(f"  Inserted {len(records):,} rows into agency_monthly")

    # On full rebuild, recalculate sample_agencies from agencies with complete data
    if full_rebuild:
        total_months = conn.execute(
            "SELECT COUNT(DISTINCT year * 100 + month) FROM agency_monthly"
        ).fetchone()[0]
        print(f"\n  Rebuilding sample_agencies (agencies with all {total_months} months)...")
        conn.execute("DELETE FROM sample_agencies")
        conn.execute("""
            INSERT INTO sample_agencies (ori, agency, state, type)
            SELECT am.ori,
                   COALESCE(a.agency, am.ori) as agency,
                   COALESCE(a.state, am.state) as state,
                   COALESCE(a.type, '') as type
            FROM agency_monthly am
            LEFT JOIN agencies a ON a.ori = am.ori
            GROUP BY am.ori
            HAVING COUNT(DISTINCT am.year * 100 + am.month) = ?
        """, (total_months,))
        sample_count = conn.execute("SELECT COUNT(*) FROM sample_agencies").fetchone()[0]
        print(f"  sample_agencies rebuilt: {sample_count} agencies with {total_months} complete months")

    # Rebuild national_monthly
    if full_rebuild:
        conn.execute("DELETE FROM national_monthly")
    else:
        conn.execute("DELETE FROM national_monthly WHERE year=? AND month=?", (year, month))

    conn.execute("""
        INSERT INTO national_monthly (year, month, offense, count, agency_count)
        SELECT am.year, am.month, am.offense, SUM(am.count), COUNT(DISTINCT am.ori)
        FROM agency_monthly am
        JOIN sample_agencies sa ON sa.ori = am.ori
        """ + ("" if full_rebuild else f"WHERE am.year={year} AND am.month={month}") + """
        GROUP BY am.year, am.month, am.offense
    """)

    # Rebuild state_monthly -- the THIRD monthly projection, in this same transaction.
    #
    # This used to be left out entirely, so a monthly update advanced agency_monthly and
    # national_monthly to the new month and left state_monthly on the previous one. A
    # state-scoped question then answered through May while an agency or national question
    # answered through June, with nothing disclosing the gap. Measured 2026-08-27 against a
    # backup of production: baseline aligned at 202605, candidate agency/national 202606 with
    # state_monthly still 202605.
    #
    # The cohort is EVERY agency, not the national sample and not "complete reporters".
    # scripts/build_db.py aggregates state_monthly from complete reporters only; that rule
    # reproduces just 13,338 of production's 36,725 rows. This rule reproduces all 36,725
    # exactly, so it -- not build_db.py's -- is the series production actually serves.
    # Changing it would silently rewrite nine years of state history.
    if full_rebuild:
        conn.execute("DELETE FROM state_monthly")
    else:
        conn.execute("DELETE FROM state_monthly WHERE year=? AND month=?", (year, month))

    conn.execute("""
        INSERT INTO state_monthly (state, year, month, offense, count, agency_count)
        SELECT am.state, am.year, am.month, am.offense, SUM(am.count), COUNT(DISTINCT am.ori)
        FROM agency_monthly am
        """ + ("" if full_rebuild else f"WHERE am.year={year} AND am.month={month}") + """
        GROUP BY am.state, am.year, am.month, am.offense
    """)

    latest = conn.execute("SELECT MAX(year*100+month) FROM national_monthly").fetchone()[0]
    nm_rows = conn.execute("SELECT COUNT(*) FROM national_monthly").fetchone()[0]
    sm_rows = conn.execute("SELECT COUNT(*) FROM state_monthly").fetchone()[0]
    sa_count = conn.execute("SELECT COUNT(*) FROM sample_agencies").fetchone()[0]
    actual_rows = conn.execute(
        "SELECT COUNT(*) FROM agency_monthly" if full_rebuild else
        "SELECT COUNT(*) FROM agency_monthly WHERE year=? AND month=?",
        () if full_rebuild else (year, month),
    ).fetchone()[0]
    # Both calls below raise on a refused import, and neither had been closing the connection.
    # On Windows an open handle also keeps the file locked, so a refusal used to leave the
    # database un-deletable as well as uncommitted. The refusal itself is the correct behaviour;
    # leaking the handle while refusing is not.
    try:
        assert_monthly_projections_aligned(conn, year, month)
        write_complete_receipt(
            conn,
            component="current_trends_monthly",
            source_version=f"{year:04d}-{month:02d}",
            source_sha256=source_sha256,
            source_rows=source_rows,
            expected_rows=len(records),
            actual_rows=actual_rows,
            excluded_rows=excluded_rows,
        )
        conn.commit()
    finally:
        conn.close()
    print(f"  national_monthly: {nm_rows:,} rows, latest {latest // 100}-{latest % 100:02d}")
    print(f"  state_monthly: {sm_rows:,} rows")
    print(f"  sample: {sa_count} agencies")


def ensure_crosswalk(db_path, source_path, cde_path, expect_sha256=None,
                     expect_cde_sha256=None, staging_dir=None):
    """Rebuild agency_county_crosswalk in the local DB and verify it.

    crime_data.db is wholesale-replaced on the VPS at deploy time, so any
    derived table must exist in the LOCAL file before scp or it regresses
    Current/Historical county support (see docs/query-audit-2026-06-09-proposals.md).
    Aborts (sys.exit) on failure so a bad DB is never deployed.

    Both inputs reach a SEPARATE PROCESS, so both are staged as verified read-only copies first and
    the builder is given the copies. Hashing a path and then handing that path to a subprocess
    proves nothing about the bytes the subprocess read.
    """
    print("\nRebuilding agency_county_crosswalk (derived table)...")
    if not os.path.exists(source_path):
        print(f"  ERROR: crosswalk source not found: {source_path}")
        sys.exit(1)
    if not os.path.exists(cde_path):
        print(f"  ERROR: crosswalk CDE input not found: {cde_path}")
        sys.exit(1)

    # The CDE input is bound by NO receipt -- there is no reviewed digest for it anywhere in the
    # repository -- so it cannot be checked against stored provenance the way the workbook can.
    # For this update it must therefore be named explicitly: the operator states the digest, and
    # the observed bytes must equal it exactly. Extending the receipt schema to carry it is
    # deliberately a separate piece of work; the digest is recorded in the run's evidence instead.
    observed_cde = sha256_file(cde_path)
    if expect_cde_sha256 is None:
        print(f"ERROR: the CDE crosswalk input is not bound by any receipt, so its digest must be named.")
        print(f"  observed: {observed_cde}")
        print(f"  pass: --expect-cde-sha256 {observed_cde}")
        sys.exit(1)
    if expect_cde_sha256.lower() != observed_cde.lower():
        print(f"ERROR: --expect-cde-sha256 does not describe {os.path.basename(cde_path)}.")
        print(f"  observed  : {observed_cde}")
        print(f"  you named : {expect_cde_sha256.lower()}")
        sys.exit(1)

    # Gate BEFORE the builder runs: it rewrites agency_county_crosswalk wholesale with --apply,
    # so checking afterwards would be checking a table that had already been replaced.
    gate = sqlite3.connect(db_path)
    try:
        authorized = authorize_input_digest(gate, "current_trends_crosswalk", source_path,
                                            "--expect-crosswalk-sha256", expect_sha256)
    finally:
        gate.close()

    owns_staging = staging_dir is None
    staging_dir = staging_dir or make_staging_dir()
    try:
        _ensure_crosswalk_from_verified(db_path, source_path, cde_path, authorized,
                                        observed_cde, staging_dir)
    finally:
        if owns_staging:
            remove_staging_dir(staging_dir)


def _ensure_crosswalk_from_verified(db_path, source_path, cde_path, authorized_source,
                                    authorized_cde, staging_dir):
    source_path, consumed_source = verified_input_copy(source_path, authorized_source, staging_dir)
    cde_path, consumed_cde = verified_input_copy(cde_path, authorized_cde, staging_dir)
    print(f"  consumed workbook {consumed_source[:16]}...  CDE {consumed_cde[:16]}...")
    result = subprocess.run(
        [sys.executable, CROSSWALK_BUILDER,
         "--source", source_path, "--cde", cde_path,
         "--target", db_path, "--apply"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  ERROR: crosswalk build failed: {result.stderr.strip()[:500]}")
        sys.exit(1)

    try:
        build_summary = json.loads(result.stdout)
    except (TypeError, ValueError) as error:
        print(f"  ERROR: crosswalk builder returned no readable receipt evidence: {error}")
        sys.exit(1)

    db = sqlite3.connect(db_path)
    try:
        count = db.execute("SELECT COUNT(*) FROM agency_county_crosswalk").fetchone()[0]
        inipd = db.execute(
            "SELECT ori9, county_fips FROM agency_county_crosswalk WHERE ori = 'INIPD00'"
        ).fetchone()
        santa_clara = db.execute(
            "SELECT COUNT(*) FROM agency_county_crosswalk WHERE state='CA' AND county_key='SANTA CLARA'"
        ).fetchone()[0]
    finally:
        db.close()

    failures = []
    if count < 25000:
        failures.append(f"row count {count} < 25000 (expected ~25,764)")
    if not inipd or inipd[0] != "IN0494900" or inipd[1] != "18097":
        failures.append(f"INIPD00 mapping wrong: {inipd} (expected IN0494900 / 18097)")
    if santa_clara < 20:
        failures.append(f"Santa Clara CA agencies {santa_clara} < 20")
    if failures:
        print("  ERROR: crosswalk verification failed:")
        for f in failures:
            print(f"    - {f}")
        sys.exit(1)
    db = sqlite3.connect(db_path)
    try:
        with db:
            write_complete_receipt(
                db,
                component="current_trends_crosswalk",
                source_version=os.path.basename(source_path),
                # The digest of the bytes the BUILDER read, not a later read of the original path.
                source_sha256=consumed_source,
                source_rows=int(build_summary["rows"]),
                expected_rows=int(build_summary["rows"]),
                actual_rows=count,
                excluded_rows=0,
            )
    except (KeyError, TypeError, ValueError) as error:
        print(f"  ERROR: crosswalk receipt could not be completed: {error}")
        sys.exit(1)
    finally:
        db.close()
    print(f"  Crosswalk OK: {count:,} rows; INIPD00 -> {inipd[0]}/{inipd[1]}; Santa Clara CA agencies: {santa_clara}")


def deploy_to_vps(db_path, year, month, full_rebuild):
    """SCP updated DB to the canonical shared path, then zero-downtime rebuild."""
    print(f"\nDeploying to VPS ({VPS_HOST})...")

    print("  Copying DB to VPS (shared path)...")
    result = subprocess.run(
        ["scp", db_path, f"{VPS_HOST}:{VPS_DB}"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  ERROR: scp failed: {result.stderr.strip()}")
        sys.exit(1)
    print("  DB copied.")

    print("  Zero-downtime rebuild (regenerates static pages; ~2-4 min)...")
    result = subprocess.run(
        ["ssh", VPS_HOST, f"cd {VPS_REPO} && bash scripts/deploy-zero-downtime.sh {DEPLOY_BRANCH}"],
        capture_output=False
    )
    if result.returncode != 0:
        print("  ERROR: zero-downtime deploy failed (live app untouched; see rollback.sh)")
        sys.exit(1)
    print("  Deploy complete.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--month", required=True, help="YYYYMM, e.g. 202603")
    parser.add_argument("--csv", help="Local CSV path instead of GitHub download")
    parser.add_argument("--full-rebuild", action="store_true",
                        help="Replace all agency_monthly data (not just new month)")
    parser.add_argument("--deploy", action="store_true",
                        help="SCP DB to VPS and rebuild app after update")
    parser.add_argument("--db", default=None, help="Local DB path (default: crime_data.db next to scripts/)")
    parser.add_argument("--pop-csv", default=POP_CSV_DEFAULT,
                        help="Path to populations.csv for agency population refresh")
    parser.add_argument("--crosswalk-source", default=CROSSWALK_SOURCE_DEFAULT,
                        help="Participation Crosswalk.xlsx for agency_county_crosswalk rebuild")
    parser.add_argument("--crosswalk-cde", default=CROSSWALK_CDE_DEFAULT,
                        help="CDE Participation CSV for agency_county_crosswalk rebuild")
    parser.add_argument("--expect-population-sha256", type=hex_digest_argument, default=None,
                        help="SHA-256 of a population CSV that deliberately differs from the "
                             "one the current receipt records. Must equal the supplied file.")
    parser.add_argument("--expect-crosswalk-sha256", type=hex_digest_argument, default=None,
                        help="SHA-256 of a crosswalk workbook that deliberately differs from the "
                             "one the current receipt records. Must equal the supplied file.")
    parser.add_argument("--expect-cde-sha256", type=hex_digest_argument, default=None,
                        help="REQUIRED SHA-256 of the CDE participation CSV. No receipt binds this "
                             "input, so it must be named explicitly and must equal the file.")
    args = parser.parse_args()

    if not re.match(r"^\d{6}$", args.month):
        print("ERROR: --month must be YYYYMM, e.g. 202603")
        sys.exit(1)

    year = int(args.month[:4])
    month = int(args.month[4:])

    db_path = args.db or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "crime_data.db")
    )
    if not os.path.exists(db_path):
        print(f"ERROR: DB not found at {db_path}")
        sys.exit(1)

    # Load CSV
    if args.csv:
        all_rows = load_local_csv(args.csv)
    else:
        all_rows = download_csv(args.month)
    source_digest = sha256_text(json.dumps(all_rows, sort_keys=True, separators=(",", ":")))

    # Filter rows
    if args.full_rebuild:
        ori_rows = filter_ori_rows(all_rows)
        year_filter, month_filter = None, None
    else:
        ori_rows = filter_ori_rows(all_rows, year=year, month=month)
        year_filter, month_filter = year, month
    if not ori_rows:
        print("ERROR: source contains no Current Trends agency rows for the requested scope")
        sys.exit(1)

    # Convert every source agency. sample_agencies remains the national aggregation cohort only.
    print("\nLoading agency directory from DB...")
    agency_info = get_agency_info(db_path)
    print(f"  {len(agency_info)} agencies")
    print("\nBuilding records...")
    records = rows_to_records(ori_rows, agency_info)
    excluded_rows = 0
    if not records:
        print("ERROR: source conversion produced no importable Current Trends records")
        sys.exit(1)

    # Update local DB
    update_local_db(
        db_path, records, args.full_rebuild, year, month,
        len(ori_rows), excluded_rows, source_digest,
    )

    # Refresh agency populations from the authoritative populations.csv.
    #
    # This used to run ONLY under --full-rebuild, so routine monthly updates
    # never applied the CSV. The result was 470 wrong values in
    # agency_population (235 agencies x 2025 and 2026), including Kansas City,
    # MO at 317,692 against an authoritative 518,039 -- inflating every 2025
    # per-capita rate for a third of RTCI agencies. Houston, Dallas and San
    # Antonio were wrong by 2-7%, small enough that no "large drop" check would
    # have caught them.
    #
    # It is now unconditional. Population is a denominator: a stale one produces
    # confidently wrong rates rather than a visible failure, so it must never
    # depend on remembering to pass a flag.
    #
    # The standalone scripts/refresh_agency_populations.py covers every ORI in
    # agency_population (this in-line step only covers sample_agencies) and adds
    # preflight plus post-write validation. Prefer it for repairs; this call
    # keeps routine updates from drifting between runs.
    # One run-owned staging directory holds every verified input copy, so the digests recorded in
    # the receipts and printed as evidence all describe files this run created and nothing else
    # could touch.
    staging_dir = make_staging_dir()
    print(f"\nVerified-input staging: {staging_dir}")
    try:
        refresh_populations(db_path, args.pop_csv, args.expect_population_sha256, staging_dir)

        # Rebuild + verify derived tables BEFORE any deploy — the scp wholesale-
        # replaces the VPS file, so missing derived tables would regress
        # Current/Historical county support.
        ensure_crosswalk(db_path, args.crosswalk_source, args.crosswalk_cde,
                         args.expect_crosswalk_sha256, args.expect_cde_sha256, staging_dir)
    finally:
        remove_staging_dir(staging_dir)

    # Refresh query-planner statistics BEFORE deploy — the scp wholesale-replaces
    # the VPS file, and a statistics-less database makes SQLite pick
    # catastrophically bad plans (2026-07-03 diagnosis: 34s vs 0.1s for the same
    # query). Sampled ANALYZE costs well under a second.
    print("Refreshing query-planner statistics (ANALYZE)...")
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA analysis_limit=1000")
    conn.execute("ANALYZE")
    conn.commit()
    stat_rows = conn.execute("SELECT COUNT(*) FROM sqlite_stat1").fetchone()[0]
    conn.close()
    print(f"  ANALYZE done: {stat_rows} statistics rows")

    # Deploy if requested
    if args.deploy:
        deploy_to_vps(db_path, year, month, args.full_rebuild)

    print("\nDone!")
    if not args.deploy:
        print(f"  Run with --deploy to push to VPS and rebuild.")


if __name__ == "__main__":
    main()
