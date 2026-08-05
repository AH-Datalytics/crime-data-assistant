#!/usr/bin/env python3
"""
Audit and (with --apply) repair shr.db incidents.population.

Default is AUDIT ONLY -- never writes without --apply. Partitions shr.db incidents.population against the
authoritative populations.csv so the safe correctable subset is known before any
mass update is contemplated.

WHY AN AUDIT FIRST
------------------
incidents.population is DENORMALIZED: 19,114 rows across 3,903 agencies for
2025-2026, one population per incident rather than one per agency-year. Kansas
City's 161 rows carry RETA's 317,692 against an authoritative 518,039, so SHR
homicide rates for multi-county agencies are inflated the same way the
crime_data.db rates were.

But 3,903 agencies is far beyond populations.csv's coverage, and incidents.ori is
the 7-character RETA form. Mass-updating on a guessed ORI mapping would replace
imprecise numbers with wrong ones attached to the wrong agencies. So this script
only classifies.

ORI RESOLUTION
--------------
resolve_ori() is a faithful port of scripts/import_reta_2025.py -- the same
ORI_MAP, the same tier order. Tier 4 (bare padding with no matching
historical_agency row) is treated as UNRESOLVED here, because a padded ORI that
does not exist cannot verify an agency/year mapping. import_reta_2025.py uses it
to create new agency rows; that is not a licence to attribute a population.

Usage:
  python scripts/audit_shr_incident_populations.py --shr-db <path>
                                                   --crime-db <path>
                                                   --pop-csv <path>
                                                   [--years 2025,2026]
"""

import argparse
import csv
import os
import sqlite3
import sys
from collections import defaultdict

# Ported verbatim from scripts/import_reta_2025.py. Do NOT re-derive.
ORI_MAP = {
    "INIPD00": "IN0494900",   # Indianapolis (Unigov ORI)
    "MI63190": "MI6367300",   # Pontiac
    "MI63185": "MI6331400",   # Independence Township
    "CA03349": "CA0337800",   # Menifee
    "CA00740": "CA0072400",   # San Ramon
}

ORI_LENGTH = 9
AUTHORITATIVE_SIZE = "all"


def resolve_ori(ori7, cur, prefix_cache):
    """Faithful port of import_reta_2025.py resolve_ori, plus a verification flag.

    Returns (ori9, tier) where tier is 1-3 for a VERIFIED mapping (the resolved
    ORI exists in historical_agency) and 4 for the bare-padding fallback, which
    is NOT verified.
    """
    if ori7 in ORI_MAP:
        return ORI_MAP[ori7], 1

    padded = ori7 + "00"
    if cur.execute("SELECT 1 FROM historical_agency WHERE ori = ?", (padded,)).fetchone():
        return padded, 2

    if ori7 not in prefix_cache:
        match = cur.execute(
            "SELECT ori FROM historical_agency WHERE SUBSTR(ori, 1, 7) = ? LIMIT 1", (ori7,)
        ).fetchone()
        prefix_cache[ori7] = match[0] if match else None
    if prefix_cache[ori7]:
        return prefix_cache[ori7], 3

    return padded, 4


def load_csv_populations(pop_csv):
    populations = {}
    conflicts = set()
    with open(pop_csv, encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("size") != AUTHORITATIVE_SIZE:
                continue
            ori = (row.get("id") or "").strip()
            if len(ori) != ORI_LENGTH:
                continue
            try:
                year = int(row["year"])
                population = int(row["population"])
            except (TypeError, ValueError):
                continue
            key = (ori, year)
            if key in populations and populations[key] != population:
                conflicts.add(key)
            populations[key] = population
    return populations, conflicts


def main():
    parser = argparse.ArgumentParser(description="Audit shr.db incidents.population (read-only)")
    parser.add_argument("--shr-db", required=True)
    parser.add_argument("--crime-db", required=True)
    parser.add_argument("--pop-csv", required=True)
    parser.add_argument("--years", default="2025,2026")
    parser.add_argument("--apply", action="store_true",
                        help="Write bucket B corrections only. Without this the script never writes.")
    args = parser.parse_args()

    years = sorted({int(y.strip()) for y in args.years.split(",") if y.strip()})
    for path in (args.shr_db, args.crime_db, args.pop_csv):
        if not os.path.exists(path):
            print(f"FAILED: not found: {path}", file=sys.stderr)
            sys.exit(1)

    csv_pops, csv_conflicts = load_csv_populations(args.pop_csv)
    print(f"populations.csv: {len(csv_pops):,} authoritative (ori, year) values")
    if csv_conflicts:
        print(f"  WARNING {len(csv_conflicts)} conflicting (ori, year) pairs in the source")

    shr = sqlite3.connect(args.shr_db)
    crime = sqlite3.connect(args.crime_db)
    crime_cur = crime.cursor()
    prefix_cache = {}

    placeholders = ",".join("?" * len(years))
    # agency MUST be in the GROUP BY. Without it SQLite returns an arbitrary
    # agency name per (ori, year, population) group, so two different agencies
    # sharing one 7-char ORI *and* one population collapse into a single row and
    # the collision becomes invisible. That hid 6 of 14 colliding ORIs -- mostly
    # California Highway Patrol area offices sharing an ORI such as CA01999,
    # which covers six distinct Los Angeles-area offices.
    rows = shr.execute(
        f"SELECT ori, agency, state, year, population, COUNT(*) FROM incidents "
        f"WHERE year IN ({placeholders}) GROUP BY ori, agency, year, population",
        years,
    ).fetchall()

    # ORI COLLISIONS -- scoped to the ORI across ALL years, not (ori, year).
    #
    # Scoping this per-year was a real bug that wrote wrong data. OK05502 hosts
    # BOTH "Del City" and "Oklahoma Department of Corrections" under one 7-char
    # ORI. In 2025 both appear, so the year showed two distinct populations and
    # was correctly excluded. In 2026 only the Department of Corrections rows
    # exist, so that year looked unambiguous -- and 4 of its incidents were given
    # Del City's population of 21,141 before the check against the backup caught
    # it.
    #
    # A colliding ORI cannot verify an agency/year mapping in ANY year, because
    # the authoritative CSV is keyed on the resolved 9-char ORI and cannot
    # distinguish the two agencies sharing it. Detection is therefore based on
    # distinct AGENCY NAMES per ORI, which is the actual collision signal, rather
    # than on distinct populations, which is only a symptom and only visible in
    # years where both agencies happen to report.
    #
    # Multiple distinct populations within one (ori, year) is still a conflict in
    # its own right, so both conditions are unioned.
    agencies_per_ori = defaultdict(set)
    populations_per_ori_year = defaultdict(set)
    for ori7, agency, _state, year, population, _n in rows:
        agencies_per_ori[ori7].add((agency or "").strip().upper())
        populations_per_ori_year[(ori7, year)].add(population)

    colliding_oris = {o for o, names in agencies_per_ori.items() if len(names) > 1}
    internal_conflicts = {
        (o, y) for (o, y) in populations_per_ori_year if o in colliding_oris
    } | {
        k for k, v in populations_per_ori_year.items() if len(v) > 1
    }

    buckets = defaultdict(lambda: {"rows": 0, "agencies": set()})
    correctable_examples = []
    correctable = []
    tier_counts = defaultdict(int)

    for ori7, agency, state, year, population, n in rows:
        ori9, tier = resolve_ori(ori7, crime_cur, prefix_cache)
        tier_counts[tier] += n

        if (ori7, year) in internal_conflicts:
            bucket = "E. conflicting values within SHR"
        elif tier == 4:
            bucket = "D. unresolved ORI (no verified agency)"
        else:
            authoritative = csv_pops.get((ori9, year))
            if authoritative is None:
                bucket = "C. resolvable but no authoritative source"
            elif authoritative == population:
                bucket = "A. exact CSV match (no action)"
            else:
                bucket = "B. CORRECTABLE (authoritative value differs)"
                correctable.append((ori7, year, population, authoritative, tier))
                if len(correctable_examples) < 10:
                    correctable_examples.append(
                        (year, ori7, ori9, agency, state, population, authoritative, n, tier)
                    )

        buckets[bucket]["rows"] += n
        buckets[bucket]["agencies"].add(ori7)

    shr.close()
    crime.close()

    total_rows = sum(b["rows"] for b in buckets.values())
    print(f"\nincidents rows in {years}: {total_rows:,}")
    print("\n  partition:")
    for name in sorted(buckets):
        b = buckets[name]
        share = 100.0 * b["rows"] / total_rows if total_rows else 0
        print(f"    {name:48s} rows={b['rows']:>6,}  agencies={len(b['agencies']):>5,}  ({share:4.1f}%)")

    print("\n  ORI resolution tiers (by rows):")
    labels = {1: "manual ORI_MAP", 2: "padded + exists", 3: "7-char prefix match", 4: "bare padding (UNVERIFIED)"}
    for tier in sorted(tier_counts):
        print(f"    tier {tier} {labels[tier]:28s} {tier_counts[tier]:>6,}")

    if correctable_examples:
        print("\n  correctable examples (largest first):")
        for year, ori7, ori9, agency, state, current, authoritative, n, tier in sorted(
            correctable_examples, key=lambda e: -abs(e[6] - e[5])
        ):
            pct = f"{100.0 * (authoritative - current) / current:+.1f}%" if current else "n/a"
            print(f"    {year} {ori7}->{ori9} (t{tier}) {agency}, {state}: "
                  f"{current:,} -> {authoritative:,} ({pct}) across {n} incidents")

    if not args.apply:
        print("\nAUDIT ONLY -- no rows were modified. Pass --apply to write bucket B.")
        return

    # Bucket B only. Every entry already passed: verified ORI mapping (tier 1-3),
    # an authoritative CSV value, and no SHR-internal conflict.
    #
    # The (ori, year, population) triple in the WHERE clause is load-bearing. It
    # is what stops a bucket-E collision or a bucket-C row from being caught by a
    # broader update: AR06301 holds both HOT SPRINGS VILLAGE and Benton under one
    # 7-char ORI, so an update keyed on (ori, year) alone would give one agency
    # the other's population.
    unverified = [c for c in correctable if c[4] not in (1, 2, 3)]
    if unverified:
        raise RuntimeError(f"refusing to write: {len(unverified)} correctable rows have an unverified ORI mapping")

    shr_write = sqlite3.connect(args.shr_db)
    shr_write.execute("PRAGMA busy_timeout = 10000")
    changed = 0
    with shr_write:
        for ori7, year, current, authoritative, _tier in correctable:
            cursor = shr_write.execute(
                "UPDATE incidents SET population = ? WHERE ori = ? AND year = ? AND population = ?",
                (authoritative, ori7, year, current),
            )
            changed += cursor.rowcount
    integrity = shr_write.execute("PRAGMA integrity_check").fetchone()[0]
    shr_write.close()

    print(f"\nApplied bucket B: {changed:,} incident rows updated across "
          f"{len({c[0] for c in correctable})} agencies.")
    print(f"  integrity_check: {integrity}")
    if integrity != "ok":
        raise RuntimeError(f"integrity_check returned {integrity!r}")


if __name__ == "__main__":
    main()
