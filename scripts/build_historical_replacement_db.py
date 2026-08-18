"""
Assemble the complete replacement `crime_data.db`: production's database with the five
Historical tables swapped for the verified rebuild, and nothing else touched.

Offline by construction. Every path is an argument, the destination must be new, and the
destination is refused if it is a canonical or production name -- this script builds a
candidate file for review, it never installs one.

The five Historical tables are dropped and rebuilt from the offline build's own schema, then
their indexes are recreated from the definitions the source database carried, so the
replacement is not slower than what it replaces.

Usage:

    python scripts/build_historical_replacement_db.py \
        --base   <a copy of production crime_data.db> \
        --rebuild <the five-table build from build_historical_core.py> \
        --out    <a new file> \
        --report <a new .json file>
"""

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys

import historical_core as core

HISTORICAL_TABLES = (
    "historical_agency",
    "historical_agency_crime",
    "historical_agency_population",
    "historical_agency_clearance",
    "historical_staffing",
)


def table_fingerprint(conn, table):
    columns = [row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')]
    order = ", ".join(f'"{c}"' for c in columns)
    digest = hashlib.sha256()
    digest.update(("|".join(columns) + "\n").encode("utf-8"))
    rows = 0
    for row in conn.execute(f'SELECT {order} FROM "{table}" ORDER BY {order}'):
        rows += 1
        digest.update(("\x1f".join("" if v is None else str(v) for v in row) + "\n").encode("utf-8"))
    return {"rows": rows, "sha256": digest.hexdigest()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", required=True, help="a copy of the production database")
    parser.add_argument("--rebuild", required=True, help="the verified five-table build")
    parser.add_argument("--out", required=True, help="destination; must not exist")
    parser.add_argument("--report", required=True, help="where to write the validation report")
    args = parser.parse_args(argv)

    core.assert_safe_destination(args.out)
    core.assert_safe_destination(args.report)
    for path in (args.base, args.rebuild):
        if not os.path.exists(path):
            print(f"missing input: {path}", file=sys.stderr)
            return 2

    report = {"inputs": {}, "before": {}, "after": {}, "indexes": {}, "checks": {}}
    report["inputs"]["base_sha256"] = core.sha256_file(args.base)
    report["inputs"]["rebuild_sha256"] = core.sha256_file(args.rebuild)
    report["inputs"]["base_bytes"] = os.path.getsize(args.base)

    # Fingerprint every table of the base first, so "unrelated tables are unchanged" is a
    # measurement rather than an assurance.
    base = sqlite3.connect(f"file:{args.base}?mode=ro", uri=True)
    base_tables = [n for (n,) in base.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    for table in base_tables:
        report["before"][table] = table_fingerprint(base, table)
    # The index definitions to restore, captured from the base rather than assumed.
    index_sql = {}
    for table in HISTORICAL_TABLES:
        index_sql[table] = [
            sql for (sql,) in base.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name",
                (table,),
            )
        ]
    report["indexes"] = {t: len(v) for t, v in index_sql.items()}
    base.close()

    shutil.copyfile(args.base, args.out)
    # URI mode so the rebuild can be ATTACHed read-only rather than opened for writing.
    out = sqlite3.connect(f"file:{args.out}", uri=True)
    out.execute("PRAGMA foreign_keys=OFF")
    out.execute(f"ATTACH DATABASE 'file:{args.rebuild}?mode=ro' AS rebuild")

    for table in HISTORICAL_TABLES:
        create = out.execute(
            "SELECT sql FROM rebuild.sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if not create:
            print(f"rebuild is missing {table}", file=sys.stderr)
            return 2
        out.execute(f'DROP TABLE "{table}"')
        out.execute(create[0])
        out.execute(f'INSERT INTO main."{table}" SELECT * FROM rebuild."{table}"')
        for statement in index_sql[table]:
            out.execute(statement)
    out.commit()
    out.execute("DETACH DATABASE rebuild")
    # Dropping a table drops its query-planner statistics with it. Without this the
    # replacement would ship with no stats for the five Historical tables at all, while the
    # database it replaces has them -- a silent performance regression on the live site.
    for table in HISTORICAL_TABLES:
        out.execute(f'ANALYZE "{table}"')
    out.commit()
    out.execute("VACUUM")
    out.commit()
    out.close()

    check = sqlite3.connect(f"file:{args.out}?mode=ro", uri=True)
    for table in base_tables:
        report["after"][table] = table_fingerprint(check, table)

    changed = sorted(t for t in base_tables if report["before"][t] != report["after"][t])
    unchanged = sorted(t for t in base_tables if report["before"][t] == report["after"][t])
    report["checks"]["tables_changed"] = changed
    report["checks"]["tables_unchanged"] = unchanged
    # `sqlite_stat1` must change: it holds the planner's statistics, and the five tables it
    # describes were rebuilt. What must NOT change is any entry belonging to another table.
    expected = sorted(set(HISTORICAL_TABLES) | {"sqlite_stat1"})
    report["checks"]["only_historical_changed"] = changed in (sorted(HISTORICAL_TABLES), expected)

    def stat_entries(conn):
        try:
            return {(t, i): v for t, i, v in conn.execute("SELECT tbl, idx, stat FROM sqlite_stat1")}
        except sqlite3.Error:
            return {}

    before_stats = stat_entries(sqlite3.connect(f"file:{args.base}?mode=ro", uri=True))
    after_stats = stat_entries(check)
    foreign_stat_changes = sorted(
        f"{t}/{i}" for (t, i) in set(before_stats) | set(after_stats)
        if t not in HISTORICAL_TABLES and before_stats.get((t, i)) != after_stats.get((t, i))
    )
    missing_stats = sorted(t for t in HISTORICAL_TABLES if not any(k[0] == t for k in after_stats))
    report["checks"]["stat1_foreign_changes"] = foreign_stat_changes
    report["checks"]["stat1_historical_missing"] = missing_stats
    report["checks"]["stat1_clean"] = not foreign_stat_changes and not missing_stats

    # The rebuild must have arrived intact.
    rebuild = sqlite3.connect(f"file:{args.rebuild}?mode=ro", uri=True)
    matches = {}
    for table in HISTORICAL_TABLES:
        matches[table] = table_fingerprint(rebuild, table) == report["after"][table]
    rebuild.close()
    report["checks"]["historical_matches_rebuild"] = matches
    report["checks"]["all_historical_match"] = all(matches.values())

    # No row in any child table may join to nothing.
    orphans = {}
    for table in HISTORICAL_TABLES:
        if table == "historical_agency":
            continue
        orphans[table] = check.execute(
            f'SELECT COUNT(*) FROM "{table}" t WHERE NOT EXISTS '
            "(SELECT 1 FROM historical_agency a WHERE a.ori = t.ori)"
        ).fetchone()[0]
    report["checks"]["orphan_rows"] = orphans
    report["checks"]["zero_orphans"] = all(v == 0 for v in orphans.values())

    # Indexes came back.
    restored = {
        table: check.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
            (table,),
        ).fetchone()[0]
        for table in HISTORICAL_TABLES
    }
    report["checks"]["indexes_restored"] = restored
    report["checks"]["indexes_match"] = restored == report["indexes"]

    # The named cases, read from the finished file.
    named = {}
    for label, sql in (
        ("huntsville_2025_murder", "SELECT murder FROM historical_agency_crime WHERE ori='AL0470100' AND year=2025"),
        ("huntsville_2025_officers", "SELECT officer_total FROM historical_staffing WHERE ori='AL0470100' AND year=2025"),
        ("knoxville_2025_murder", "SELECT murder FROM historical_agency_crime WHERE ori='TN0470100' AND year=2025"),
        ("las_vegas_2025_murder", "SELECT murder FROM historical_agency_crime WHERE ori='NV0020100' AND year=2025"),
        ("aurora_il_2025_murder", "SELECT murder FROM historical_agency_crime WHERE ori='IL0450100' AND year=2025"),
        ("metlakatla_2024_murder", "SELECT murder FROM historical_agency_crime WHERE ori='AK0012500' AND year=2024"),
        ("cook_county_2020_murder_clr", "SELECT murder_clr FROM historical_agency_clearance WHERE ori='IL0160000' AND year=2020"),
        ("allegheny_1961_murder", "SELECT murder FROM historical_agency_crime WHERE ori='PA0020000' AND year=1961"),
        ("indianapolis_staffing_years", "SELECT COUNT(*) FROM historical_staffing WHERE ori='IN0494900'"),
        ("ca0349950_staffing_rows", "SELECT COUNT(*) FROM historical_staffing WHERE ori='CA0349950'"),
        ("pseudo_agency_rows", "SELECT COUNT(*) FROM historical_agency WHERE LENGTH(ori)<9"),
        ("null_ori_clearance_rows", "SELECT COUNT(*) FROM historical_agency_clearance WHERE ori IS NULL"),
        ("agencies_with_crime_no_population",
         "SELECT COUNT(*) FROM (SELECT DISTINCT ori FROM historical_agency_crime) k "
         "WHERE NOT EXISTS (SELECT 1 FROM historical_agency_population p WHERE p.ori = k.ori)"),
    ):
        row = check.execute(sql).fetchone()
        named[label] = None if row is None else row[0]
    report["checks"]["named_examples"] = named
    report["out_bytes"] = os.path.getsize(args.out)
    check.close()

    report["checks"]["passed"] = bool(
        report["checks"]["only_historical_changed"]
        and report["checks"]["all_historical_match"]
        and report["checks"]["zero_orphans"]
        and report["checks"]["indexes_match"]
        and report["checks"]["stat1_clean"]
    )

    with open(args.report, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps(report["checks"], indent=2, sort_keys=True))
    return 0 if report["checks"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
