#!/usr/bin/env python3
"""
Refresh agency_population from the authoritative populations.csv.

WHY THIS IS A STANDALONE SCRIPT
-------------------------------
update-rtci-db.py has a refresh_populations() step, but it only runs under
--full-rebuild. Routine monthly updates skipped it, so agency_population was
never corrected from the CSV. That left 235 agencies with wrong 2025 populations
(and 235 for 2026, inherited by carry-forward), including Kansas City, MO at
317,692 against an authoritative 518,039 -- a 38.7% undercount that inflated
every 2025 per-capita rate for a third of RTCI agencies. Houston (-2.1%),
Dallas (-6.4%) and San Antonio (-7.4%) were wrong too, small enough to escape
any "large drop" filter.

It also only covered ORIs in sample_agencies (558) while agency_population holds
720, so ~159 agencies could never be corrected by it at all.

AUTHORITY MODEL
---------------
populations.csv is AUTHORITATIVE for agency_population. It was verified against
the FBI CDE API independently: for Kansas City both report 518,039.

RETA must never populate or overwrite agency_population. RETA's 2025 file reports
Kansas City at 317,692 because its populations undercount multi-county agencies
(Kansas City spans Cass, Clay, Jackson and Platte). RETA legitimately feeds the
historical_* tables via import_reta_2025.py; this table is not its business.
This script reads ONLY populations.csv and never consults RETA or the historical
tables.

KNOWN LIMITATION -- DO NOT "FIX" BY GUESSING
--------------------------------------------
historical_agency_crime holds ~16,200 rows for 2025 while populations.csv covers
the RTCI-relevant agencies only. 3,409 of those rows have NO authoritative value
in the CSV, and this script leaves them exactly as they are.

That is deliberate. Those rows keep RETA's populations, which for multi-county
agencies are undercounts -- so any per-capita rate computed from them for an
agency outside the CSV's coverage may be overstated. Filling them from a
different or derived source would replace a known-imprecise number with an
invented one, which is worse: the error would no longer be traceable to a
source. They are reported as "no authoritative source at all" on every run so
the gap stays visible rather than becoming folklore.

Closing that gap needs an authoritative population source with wider agency
coverage, not a transformation of this CSV.

Routine updates (update-rtci-db.py) intentionally keep their narrower
sample_agencies coverage. This standalone script is the tool for full
authoritative-table reconciliation.

Usage:
  python scripts/refresh_agency_populations.py --db <path> [--pop-csv <path>]
                                               [--dry-run] [--years 2025,2026]
                                               [--tables agency_population,...]
"""

import argparse
import csv
import os
import sqlite3
import sys

DEFAULT_POP_CSV = os.path.join(
    os.path.expanduser("~"),
    "OneDrive - ahdatalytics.com", "Clients", "Real Time Crime Index",
    "Open Source Data", "Historical Data", "outputs", "populations.csv",
)

# populations.csv carries breakdowns by size bucket; only "all" is the agency total.
AUTHORITATIVE_SIZE = "all"
# Agency ORIs are 9 characters. Shorter ids in the CSV are state/national
# aggregates, and the DB has one junk "NA" row -- neither is a real agency.
ORI_LENGTH = 9
MIN_YEAR = 2017

# Every table whose population column is authoritative-from-CSV.
#
# historical_agency_crime.population is included because import_reta_2025.py wrote
# RETA populations there too -- it agrees with historical_agency_population on
# 12,626 of 12,649 rows for 2025, so leaving it would keep a second corrupted
# denominator alive for anything reading it (cde-discrepancy-check.py COALESCEs
# over both).
#
# default_years scopes each table to the years actually corrupted. The historical
# tables reach back to 1930 across ~17k agencies; rewriting all of that from a CSV
# with far narrower coverage would be a far larger and riskier operation than the
# defect requires. import_reta_2025.py only ever wrote 2025.
POPULATION_TABLES = {
    "agency_population": {"default_years": [2025, 2026]},
    "historical_agency_population": {"default_years": [2025]},
    "historical_agency_crime": {"default_years": [2025]},
}


class PreflightError(RuntimeError):
    pass


def load_csv_populations(pop_csv, min_year):
    """Return {(ori, year): population} for authoritative agency rows only."""
    if not os.path.exists(pop_csv):
        raise PreflightError(f"populations.csv not found at {pop_csv}")
    if os.path.getsize(pop_csv) == 0:
        raise PreflightError(f"populations.csv is empty: {pop_csv}")

    populations = {}
    all_oris = set()
    duplicates = []
    malformed = 0
    non_agency = 0
    with open(pop_csv, encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {"id", "size", "year", "population"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise PreflightError(f"populations.csv missing columns: {sorted(missing)}")

        for row in reader:
            if row.get("size") != AUTHORITATIVE_SIZE:
                continue
            ori = (row.get("id") or "").strip()
            if len(ori) != ORI_LENGTH:
                non_agency += 1
                continue
            try:
                year = int(row["year"])
                population = int(row["population"])
            except (TypeError, ValueError):
                malformed += 1
                continue
            # Recorded before the year filter: an ORI whose coverage stops in
            # 2015 (contract cities) is a carry-forward case, not a missing agency.
            all_oris.add(ori)
            if year < min_year:
                continue
            key = (ori, year)
            # A duplicate with a DIFFERENT value means the source is ambiguous and
            # we must not guess which one is authoritative.
            if key in populations and populations[key] != population:
                duplicates.append((ori, year, populations[key], population))
            populations[key] = population

    if duplicates:
        sample = "; ".join(f"{o} {y}: {a} vs {b}" for o, y, a, b in duplicates[:5])
        raise PreflightError(
            f"{len(duplicates)} conflicting duplicate (ori, year) rows in populations.csv: {sample}"
        )
    if not populations:
        raise PreflightError("populations.csv yielded no usable agency rows")
    return populations, {"non_agency_rows": non_agency, "malformed_rows": malformed, "all_oris": all_oris}


def preflight(conn, table, csv_pops, csv_all_oris, years):
    """Fail loudly on anything that would make a silent partial refresh."""
    findings = {}

    db_rows = conn.execute(f"SELECT ori, year, population FROM {table}").fetchall()
    if not db_rows:
        raise PreflightError(f"{table} is empty; refusing to populate it from scratch here")

    db_oris = {r[0] for r in db_rows}
    db_years = {r[1] for r in db_rows}

    # ORIs that are not real agencies cannot be refreshed and should be visible.
    bad_ori = sorted(o for o in db_oris if len(o) != ORI_LENGTH)
    findings["invalid_ori_in_db"] = bad_ori

    # Agencies present in the DB but absent from the authoritative source.
    findings["db_oris_absent_from_csv"] = sorted(
        o for o in db_oris if len(o) == ORI_LENGTH and o not in csv_all_oris
    )

    # Year coverage: every DB year we intend to refresh must exist in the CSV.
    csv_years = {y for _, y in csv_pops}
    target_years = sorted(years) if years else sorted(POPULATION_TABLES[table]["default_years"])
    findings["target_years"] = target_years
    uncovered = [y for y in target_years if y not in csv_years]
    if uncovered:
        raise PreflightError(
            f"populations.csv has no rows for target year(s) {uncovered}; refusing to refresh a year it cannot source"
        )

    # Unexpected year coverage in the DB is worth surfacing, not failing on.
    findings["db_years_before_min"] = sorted(y for y in db_years if y < MIN_YEAR)

    return findings


def refresh_table(conn, table, csv_pops, csv_stats, years, dry_run):
    findings = preflight(conn, table, csv_pops, csv_stats["all_oris"], years)
    target_years = set(findings["target_years"])

    print(f"\n=== {table} ===")
    print(f"  target years: {sorted(target_years)}")
    if findings["invalid_ori_in_db"]:
        print(f"  WARNING invalid ORIs (not refreshable): {findings['invalid_ori_in_db'][:8]}"
              f"{' ...' if len(findings['invalid_ori_in_db']) > 8 else ''}")
    if findings["db_oris_absent_from_csv"]:
        print(f"  WARNING {len(findings['db_oris_absent_from_csv'])} agency ORIs appear nowhere in populations.csv "
              f"(not refreshable): {findings['db_oris_absent_from_csv'][:10]}")
    if findings["db_years_before_min"]:
        print(f"  note: DB years below {MIN_YEAR} left untouched: {findings['db_years_before_min']}")

    # Every ORI in agency_population, NOT only the national sample.
    rows = conn.execute(
        f"SELECT ori, year, population FROM {table} WHERE year IN (%s)"
        % ",".join("?" * len(target_years)),
        sorted(target_years),
    ).fetchall()

    # Three distinct outcomes, kept apart on purpose. Collapsing them is how a
    # real error hides among benign ones:
    #   correct        - CSV has this (ori, year) and the DB disagrees -> fix it
    #   carry_forward  - ORI is in the CSV but not for this year, so the DB's
    #                    value is fetch_population.py's intended
    #                    previous-year fallback. Benign. Contract cities such as
    #                    CA030350X (Mission Viejo) sit here: they are policed by
    #                    a county sheriff, have no real FBI ORI, and the CSV's
    #                    coverage for their synthetic ...X id stops in 2015.
    #   no_source      - ORI appears nowhere in the CSV, or is not a valid ORI
    #                    (the junk "NA" row). A genuine gap worth reporting.
    csv_oris = csv_stats["all_oris"]
    updates = []
    carry_forward = []
    no_source = []
    for ori, year, current in rows:
        if len(ori) != ORI_LENGTH or ori not in csv_oris:
            no_source.append((ori, year))
            continue
        authoritative = csv_pops.get((ori, year))
        if authoritative is None:
            carry_forward.append((ori, year))
            continue
        if authoritative != current:
            updates.append((authoritative, ori, year))

    print(f"\nRows examined: {len(rows):,}")
    print(f"  needing correction:                       {len(updates):,}")
    print(f"  carry-forward (no CSV row for that year): {len(carry_forward):,}")
    print(f"  no authoritative source at all:           {len(no_source):,}")
    if carry_forward:
        print(f"    carry-forward ORIs: {sorted({o for o, _ in carry_forward})[:8]}")
    if no_source:
        print(f"    no-source ORIs:     {sorted({o for o, _ in no_source})[:8]}")

    current_by_key = {(ori, year): current for ori, year, current in rows}
    if updates:
        print("  largest corrections:")
        worst = sorted(updates, key=lambda u: -abs(u[0] - current_by_key[(u[1], u[2])]))[:8]
        for new, ori, year in worst:
            old = current_by_key[(ori, year)]
            pct = f"{100.0 * (new - old) / old:+.1f}%" if old else "n/a"
            print(f"    {year} {ori}: {old:,} -> {new:,} ({pct})")

    if dry_run:
        print("  --dry-run: no changes written.")
        return {"updated": 0, "planned": len(updates), "verified": False}

    with conn:
        conn.executemany(
            f"UPDATE {table} SET population = ? WHERE ori = ? AND year = ?", updates
        )

    # Post-write validation: every refreshable row must now equal the CSV.
    remaining = []
    for ori, year, current in conn.execute(
        f"SELECT ori, year, population FROM {table} WHERE year IN (%s)"
        % ",".join("?" * len(target_years)),
        sorted(target_years),
    ).fetchall():
        if len(ori) != ORI_LENGTH:
            continue
        authoritative = csv_pops.get((ori, year))
        if authoritative is not None and authoritative != current:
            remaining.append((ori, year, current, authoritative))

    print(f"  applied {len(updates):,} corrections.")
    if remaining:
        raise RuntimeError(
            f"validation FAILED for {table}: {len(remaining)} refreshable rows still disagree "
            f"with populations.csv, e.g. {remaining[:3]}"
        )
    print(f"  validation passed: every refreshable row in {table} matches populations.csv.")
    return {"updated": len(updates), "planned": len(updates), "verified": True}




def refresh(db_path, pop_csv, years, dry_run, tables):
    """Refresh every requested table from the one authoritative source."""
    csv_pops, csv_stats = load_csv_populations(pop_csv, MIN_YEAR)
    print(f"Source: {pop_csv}")
    print(f"  authoritative agency rows loaded: {len(csv_pops):,}")
    print(f"  skipped non-agency ids: {csv_stats['non_agency_rows']:,}, malformed: {csv_stats['malformed_rows']:,}")

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout = 10000")
    results = {}
    try:
        for table in tables:
            results[table] = refresh_table(conn, table, csv_pops, csv_stats, years, dry_run)
    finally:
        conn.close()

    total = sum(r["planned"] for r in results.values())
    print(f"\nTotal corrections {'planned' if dry_run else 'applied'} across {len(tables)} table(s): {total:,}")
    return results

def main():
    parser = argparse.ArgumentParser(description="Refresh agency_population from populations.csv")
    parser.add_argument("--db", required=True, help="Path to crime_data.db")
    parser.add_argument("--pop-csv", default=DEFAULT_POP_CSV)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--years", help="Comma-separated years to refresh (default: per-table corrupted years)")
    parser.add_argument("--tables", help="Comma-separated tables (default: all three population tables)")
    args = parser.parse_args()

    years = None
    if args.years:
        years = {int(y.strip()) for y in args.years.split(",") if y.strip()}

    tables = list(POPULATION_TABLES)
    if args.tables:
        tables = [t.strip() for t in args.tables.split(",") if t.strip()]
        unknown = [t for t in tables if t not in POPULATION_TABLES]
        if unknown:
            print(f"Unknown table(s): {unknown}. Known: {list(POPULATION_TABLES)}", file=sys.stderr)
            sys.exit(2)

    try:
        refresh(args.db, args.pop_csv, years, args.dry_run, tables)
    except (PreflightError, RuntimeError) as error:
        print(f"\nFAILED: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
