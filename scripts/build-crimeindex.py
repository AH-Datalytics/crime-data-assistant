#!/usr/bin/env python3
"""The Crime Index build: the archived Crime Index snapshots as typed tables, for the new engine's Historical source.

Historical design note (docs/superpowers/specs/2026-11-01-historical-engine-design.md, section 1; P75-P79): the engine
compiles against nibrs-model's archived Crime Index snapshots, never the app's live tables. This build reads the
snapshot files, checks each one's SHA-256 against nibrs-model's archive manifest, and writes typed Parquet tables and
a manifest of what was read, what was set aside and why. It writes only under --out; the inputs are read-only.

    python scripts/build-crimeindex.py \
        --manifest <crimeindex-archive.json, e.g. `git -C ../nibrs-model show 24d9612:manifests/crimeindex-archive.json`> \
        --snapshots <nibrs-model work/crimeindex> --out <a folder outside the repository>

Tables (one row per place and year; values exactly as published, a blank is NULL, never zero):
    agency_crime        city and county rows: ori, name, type, state, year, population, and for the nine offenses
                        (violent, murder, rape, robbery, assault, property, burglary, theft, motor) *_total, *_change
                        (percent change from the year before) and *_capita (rate per 100,000)
    state_crime         the same for states (state code upper-cased) and nation_crime for the nation
    agency_clearances   *_all_total, *_cleared_total, *_cleared_rate (a published percentage) for the nine
    nation_clearances   the nation's published percentages (its counts are blank in the file)
    agency_staffing     all_total, officer_total, civilian_total and their *_capita; rows with no name or type are
                        kept (they are ORI-keyed agencies) with type NULL and counted in the manifest
    state_staffing, nation_staffing
    current_crime       Current Trends (design note docs/superpowers/specs/2026-11-03-current-trends-design.md): the
                        current_crime snapshot's agency rows, one per ORI and month (2025-01 on): state (postal code),
                        ori, year, month, population, sample (in the Consistent Reporting Agencies), and for the nine
                        offenses *_total (the month), *_ytd, *_roll (12 months) and *_change (the year to date against
                        the same months a year earlier, as published). Group rows (states, regions, sizes, the nation)
                        are not kept: the engine sums the sample agencies (P90, P91).
    current_final       the Final panel archived with it (the site's input), one row per ORI and month from 2017-01,
                        the seven Part I offenses as *_total; rows with no ORI are set aside and counted. A cross-path
                        check for current_crime, and the source of agency months before 2025 (decision A).
"""
import argparse
import hashlib
import json
import os
import sys

import duckdb

# Which snapshot of each dataset the build reads (nibrs-model 24d9612): crime and staffing 1930-2025 (20261101),
# clearances 1960-2025 (20261030, the only clearances snapshot).
SNAPSHOTS = {"historical_crime": "20261101", "historical_clearances": "20261030", "historical_staffing": "20261101"}
OFFENSES = ["violent", "murder", "rape", "robbery", "assault", "property", "burglary", "theft", "motor"]
COLUMNS = {
    "historical_crime": [(f"{o}_total", "BIGINT") for o in OFFENSES] + [(f"{o}_change", "DOUBLE") for o in OFFENSES]
    + [(f"{o}_capita", "DOUBLE") for o in OFFENSES],
    "historical_clearances": [(f"{o}_all_total", "BIGINT") for o in OFFENSES] + [(f"{o}_cleared_total", "BIGINT") for o in OFFENSES]
    + [(f"{o}_cleared_rate", "DOUBLE") for o in OFFENSES],
    "historical_staffing": [(f"{k}_total", "BIGINT") for k in ("all", "officer", "civilian")] + [(f"{k}_capita", "DOUBLE") for k in ("all", "officer", "civilian")],
}

# Current Trends: the current_crime snapshot and its Final panel (nibrs-model 8bc9eca's manifest).
CURRENT = ("current_crime", "20261101")
CURRENT_COLUMNS = [(f"{o}_{k}", "BIGINT") for k in ("total", "ytd", "roll") for o in OFFENSES] + [(f"{o}_change", "DOUBLE") for o in OFFENSES]
FINAL_COLUMNS = {"murder": "Murder", "rape": "Rape", "robbery": "Robbery", "assault": "Aggravated Assault",
                 "burglary": "Burglary", "theft": "Theft", "motor": "Motor Vehicle Theft"}
# A place's state is its postal code, never its ORI prefix (lib/nibrs-plan/state-codes.ts): Nebraska's ORIs are NB.
POSTAL = "CASE upper(substr(id, 1, 2)) WHEN 'NB' THEN 'NE' WHEN 'GM' THEN 'GU' ELSE upper(substr(id, 1, 2)) END"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_file(snapshots_dir, snapshot, dataset, name):
    """The snapshot's file, in either layout nibrs-model uses (<snapshot>/<dataset>/<file> or <snapshot>/<file>)."""
    for p in (os.path.join(snapshots_dir, snapshot, dataset, name), os.path.join(snapshots_dir, snapshot, name)):
        if os.path.isfile(p):
            return p
    raise SystemExit(f"missing: {snapshot}/{dataset}/{name} under {snapshots_dir}")


def verified_files(manifest, snapshots_dir):
    """Each dataset's agency file and states/nation file, hashed and checked against the archive manifest."""
    out = {}
    for dataset, snapshot in SNAPSHOTS.items():
        entry = next((s for s in manifest["snapshots"] if s.get("dataset") == dataset and s["snapshot"] == snapshot), None)
        if entry is None:
            raise SystemExit(f"the manifest has no {dataset} snapshot {snapshot}")
        files = {}
        for f in entry["files"]:
            if not f["file_name"].endswith(".csv"):
                continue
            path = find_file(snapshots_dir, snapshot, dataset, f["file_name"])
            got = sha256(path)
            if got != f["sha256"]:
                raise SystemExit(f"SHA-256 mismatch for {f['file_name']}: manifest {f['sha256']}, file {got}")
            files["states_nation" if "_states_nation_" in f["file_name"] else "agencies"] = {"path": path, "file_name": f["file_name"], "sha256": got}
        if set(files) != {"agencies", "states_nation"}:
            raise SystemExit(f"{dataset} {snapshot}: expected an agency file and a states/nation file, found {sorted(files)}")
        out[dataset] = {"snapshot": snapshot, "years": entry.get("years"), **files}
    return out


def current_files(manifest, snapshots_dir):
    """current_crime's file and its Final panel, hashed against the manifest; None when the manifest has no entry."""
    dataset, snapshot = CURRENT
    entry = next((s for s in manifest["snapshots"] if s.get("dataset") == dataset and s["snapshot"] == snapshot), None)
    if entry is None:
        return None
    [rec] = [f for f in entry["files"] if f["file_name"].endswith(".csv")]
    out = {"snapshot": snapshot, "years": entry.get("years")}
    for key, name, sha, path in (("current", rec["file_name"], rec["sha256"], find_file(snapshots_dir, snapshot, dataset, rec["file_name"])),
                                 ("final", entry["final_file"]["source_name"], entry["final_file"]["sha256"],
                                  os.path.join(snapshots_dir, snapshot, dataset, "final", entry["final_file"]["source_name"]))):
        if not os.path.isfile(path):
            raise SystemExit(f"missing: {path}")
        got = sha256(path)
        if got != sha:
            raise SystemExit(f"SHA-256 mismatch for {name}: manifest {sha}, file {got}")
        out[key] = {"path": path, "file_name": name, "sha256": got}
    return out


def build_current(con, cur, write, record):
    """current_crime and current_final (see the module docstring). A cell that is not exactly a number stops the build."""
    path, final = cur["current"]["path"], cur["final"]["path"]
    read = f"read_csv('{path}', all_varchar=true, header=true, delim=',', strict_mode=true)"
    cols = [("year", "INTEGER"), ("month", "INTEGER"), ("population", "BIGINT")] + CURRENT_COLUMNS
    sums = ", ".join(f"sum(CASE WHEN NULLIF(trim(\"{c}\"), '') IS NOT NULL AND NOT regexp_full_match(trim(\"{c}\"), '{PATTERN[t]}') THEN 1 ELSE 0 END)" for c, t in cols)
    bad = {c: n for (c, _), n in zip(cols, con.execute(f"SELECT {sums} FROM {read}").fetchone()) if n}
    if bad:
        raise SystemExit(f"current_crime: cells that are not exactly a number of their column's type: {bad}")
    casts = ", ".join(f"TRY_CAST(NULLIF(trim(\"{c}\"), '') AS {t}) AS \"{c}\"" for c, t in CURRENT_COLUMNS)
    write("current_crime", f"SELECT {POSTAL} AS state, id AS ori, TRY_CAST(year AS INTEGER) AS year, TRY_CAST(month AS INTEGER) AS month, "
          f"TRY_CAST(NULLIF(trim(population), '') AS BIGINT) AS population, sample = 'true' AS sample, {casts} "
          f"FROM {read} WHERE size = 'all' AND regexp_full_match(id, '[A-Z]{{2}}[A-Z0-9]{{7}}')")
    # The Final panel prints counts with thousands separators; a blank stays NULL. A negative month (a correction an
    # agency reported, -1 to -7 in 2017-2026) is kept as published, as nibrs-model's reader keeps it.
    fread = f"read_csv('{final}', all_varchar=true, header=true, delim=',', strict_mode=true)"
    fbad = con.execute("SELECT " + ", ".join(f"sum(CASE WHEN NULLIF(trim(\"{c}\"), '') IS NOT NULL AND NOT regexp_full_match(replace(trim(\"{c}\"), ',', ''), '^-?[0-9]+$') THEN 1 ELSE 0 END)" for c in FINAL_COLUMNS.values()) + f" FROM {fread}").fetchone()
    if any(fbad):
        raise SystemExit(f"current_final: cells that are not counts: {dict(zip(FINAL_COLUMNS, fbad))}")
    fcasts = ", ".join(f"TRY_CAST(NULLIF(replace(trim(\"{c}\"), ',', ''), '') AS BIGINT) AS {o}_total" for o, c in FINAL_COLUMNS.items())
    write("current_final", f"SELECT {POSTAL.replace('id', 'trim(ori)')} AS state, trim(ori) AS ori, CAST(\"Year\" AS INTEGER) AS year, "
          f"CAST(\"Month\" AS INTEGER) AS month, {fcasts} FROM {fread} WHERE NULLIF(trim(ori), '') IS NOT NULL")
    no_ori = con.execute(f"SELECT count(*) FROM {fread} WHERE NULLIF(trim(ori), '') IS NULL").fetchone()[0]
    if no_ori:
        record["set_aside"]["current_final"] = {"reason": "no ORI", "count": no_ori, "rows": []}
    for table in ("current_crime", "current_final"):
        dup = con.execute(f"SELECT count(*) FROM (SELECT ori, year, month FROM {table} GROUP BY ALL HAVING count(*) > 1)").fetchone()[0]
        if dup:
            raise SystemExit(f"{table}: {dup} agency-months appear more than once")


def typed(con, dataset, path, where):
    """SELECT of the file's rows as typed columns. A blank stays NULL; a non-blank value that does not parse is counted."""
    cols = COLUMNS[dataset]
    casts = ", ".join(f"TRY_CAST(NULLIF(trim(\"{c}\"), '') AS {t}) AS \"{c}\"" for c, t in cols)
    return (f"SELECT NULLIF(trim(name), '') AS name, NULLIF(trim(type), '') AS type, uid, id, "
            f"TRY_CAST(year AS INTEGER) AS year, TRY_CAST(NULLIF(trim(population), '') AS BIGINT) AS population, {casts} "
            f"FROM read_csv('{path}', all_varchar=true, header=true, delim=',', strict_mode=true) WHERE {where}")


# The text a typed column accepts, exactly (Codex review 01.4): a cast would round "0.4" into a count or null "1,234".
PATTERN = {"INTEGER": r"^-?[0-9]+$", "BIGINT": r"^-?[0-9]+$", "DOUBLE": r"^-?[0-9]+(\.[0-9]+)?$"}


def unparsed(con, dataset, path):
    """Non-blank cells whose text is not exactly their type's form, by column: any stops the build."""
    cols = [("year", "INTEGER"), ("population", "BIGINT")] + COLUMNS[dataset]
    sums = ", ".join(f"sum(CASE WHEN NULLIF(trim(\"{c}\"), '') IS NOT NULL AND NOT regexp_full_match(trim(\"{c}\"), '{PATTERN[t]}') THEN 1 ELSE 0 END) AS \"{c}\"" for c, t in cols)
    row = con.execute(f"SELECT {sums} FROM read_csv('{path}', all_varchar=true, header=true, delim=',', strict_mode=true)").fetchone()
    return {c: n for (c, _), n in zip(cols, row) if n}


def diagnostics(con):
    """
    Internal consistency of the snapshot (design note, section 4(b)): diagnostics about the source, not independent
    truth. Each check counts the rows it could test and those outside the file's rounding, with up to ten examples.
    A published value is never recomputed or replaced because of a check.
    """
    out = {}

    def check(name, table, testable, wrong, key):
        n, bad = con.execute(f"SELECT count(*) FILTER (WHERE {testable}), count(*) FILTER (WHERE ({testable}) AND ({wrong})) FROM {table}").fetchone()
        ex = con.execute(f"SELECT {key}, year FROM {table} WHERE ({testable}) AND ({wrong}) ORDER BY 1, 2 LIMIT 10").fetchall()
        out[name] = {"checked": n, "outside_rounding": bad, "examples": [list(r) for r in ex]}

    for table, key in (("agency_crime", "ori"), ("state_crime", "state"), ("nation_crime", None)):
        k = key or "'US'"
        for o in OFFENSES:
            # The rate is published to one decimal.
            check(f"{table}.{o}_capita = total / population x 100,000", table, f"{o}_capita IS NOT NULL AND {o}_total IS NOT NULL AND population > 0",
                  f"abs({o}_capita - {o}_total * 1e5 / population) > 0.051", k)
        check(f"{table}.violent = murder + rape + robbery + assault", table,
              "violent_total IS NOT NULL AND murder_total IS NOT NULL AND rape_total IS NOT NULL AND robbery_total IS NOT NULL AND assault_total IS NOT NULL",
              "violent_total <> murder_total + rape_total + robbery_total + assault_total", k)
        check(f"{table}.property = burglary + theft + motor", table,
              "property_total IS NOT NULL AND burglary_total IS NOT NULL AND theft_total IS NOT NULL AND motor_total IS NOT NULL",
              "property_total <> burglary_total + theft_total + motor_total", k)
        # The change is published to two decimals, against the year before, with a base above zero.
        same_place = f"p.{key} = t.{key} AND " if key else ""
        con.execute(f"CREATE OR REPLACE TEMP VIEW change_{table} AS SELECT t.*, p.violent_total AS before FROM {table} t "
                    f"JOIN {table} p ON {same_place}p.year = t.year - 1")
        check(f"{table}.violent_change = change from the year before", f"change_{table}", "violent_change IS NOT NULL AND violent_total IS NOT NULL AND before > 0",
              "abs(violent_change - 100.0 * (violent_total - before) / before) > 0.0051", k)
    for o in OFFENSES:
        # A published clearance percentage, checked only where both counts are present; it is never recomputed.
        check(f"agency_clearances.{o}_cleared_rate = cleared / all", "agency_clearances",
              f"{o}_cleared_rate IS NOT NULL AND {o}_cleared_total IS NOT NULL AND {o}_all_total > 0",
              f"abs({o}_cleared_rate - 100.0 * {o}_cleared_total / {o}_all_total) > 0.051", "ori")
    return out


def build(manifest_path, snapshots_dir, out_dir):
    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)
    files = verified_files(manifest, snapshots_dir)
    os.makedirs(out_dir, exist_ok=True)
    con = duckdb.connect()
    record = {"release": f"crimeindex-{max(SNAPSHOTS.values())}", "inputs": files, "tables": {}, "set_aside": {}, "unparsed_cells": {}, "flags": {}}
    agency_types = "type IN ('city', 'county')"
    staffing_where = agency_types + " OR type IS NULL OR trim(type) = ''"
    state_where = "type = 'state'"

    def write(table, sql):
        con.execute(f"CREATE OR REPLACE TABLE {table} AS {sql}")
        con.execute(f"COPY {table} TO '{os.path.join(out_dir, table + '.parquet')}' (FORMAT parquet)")
        record["tables"][table] = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]

    for dataset, stem in (("historical_crime", "crime"), ("historical_clearances", "clearances"), ("historical_staffing", "staffing")):
        agencies, sn = files[dataset]["agencies"]["path"], files[dataset]["states_nation"]["path"]
        for which, path in (("agencies", agencies), ("states_nation", sn)):
            bad = unparsed(con, dataset, path)
            if bad:
                raise SystemExit(f"{dataset} {which}: cells that are not exactly a number of their column's type: {bad}")
        record["unparsed_cells"][dataset] = {}
        if dataset == "historical_staffing":
            # Rows with no name or type are agencies (ORI-keyed) all the same: kept, type NULL, and counted.
            write("agency_staffing", f"SELECT upper(substr(id, 1, 2)) AS state, id AS ori, * EXCLUDE (id) FROM ({typed(con, dataset, agencies, staffing_where)})")
            record["flags"]["agency_staffing_no_name_or_type"] = con.execute("SELECT count(*) FROM agency_staffing WHERE type IS NULL").fetchone()[0]
        else:
            write(f"agency_{stem}", f"SELECT upper(substr(id, 1, 2)) AS state, id AS ori, * EXCLUDE (id) FROM ({typed(con, dataset, agencies, agency_types)})")
            # Rows that are neither an agency, a state nor the nation (a blank type): set aside, listed, never placed.
            blank = con.execute(f"SELECT uid, id, year FROM read_csv('{agencies}', all_varchar=true, header=true, delim=',', strict_mode=true) WHERE type IS NULL OR trim(type) NOT IN ('city', 'county', 'state', 'nation')").fetchall()
            if blank:
                record["set_aside"][f"agency_{stem}"] = {"reason": "type is blank or not city, county, state or nation", "rows": [list(r) for r in blank]}
        has_state = con.execute(f"SELECT count(*) FROM read_csv('{sn}', all_varchar=true, header=true, delim=',', strict_mode=true) WHERE type = 'state'").fetchone()[0]
        if has_state:
            write(f"state_{stem}", f"SELECT upper(id) AS state, * EXCLUDE (id) FROM ({typed(con, dataset, sn, state_where)})")
        write(f"nation_{stem}", typed(con, dataset, sn, "type = 'nation'"))
        # One row per place and year: the engine's lookups assume it, so a duplicate stops the build.
        for table in [t for t in (f"agency_{stem}", f"state_{stem}") if t in record["tables"]]:
            key = "ori" if table.startswith("agency") else "state"
            dup = con.execute(f"SELECT count(*) FROM (SELECT {key}, year FROM {table} GROUP BY ALL HAVING count(*) > 1)").fetchone()[0]
            if dup:
                raise SystemExit(f"{table}: {dup} place-years appear more than once")
    cur = current_files(manifest, snapshots_dir)
    if cur:
        record["inputs"]["current_crime"] = cur
        build_current(con, cur, write, record)
    record["diagnostics"] = diagnostics(con)
    record["notes"] = [
        "Crime Index publishes no state or national staffing: its staffing states/nation file has only a header, so "
        "state_staffing is absent and nation_staffing is empty.",
        "Clearances start in 1960 (the only clearances snapshot is 20261030); crime and staffing start in 1930, states "
        "and the nation in 1958."]
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(record, f, indent=1)
        f.write("\n")
    return record


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--manifest", required=True, help="nibrs-model's manifests/crimeindex-archive.json")
    ap.add_argument("--snapshots", required=True, help="the folder holding the snapshots (<snapshot>/<dataset>/<file>)")
    ap.add_argument("--out", required=True, help="the output folder (outside the repository)")
    a = ap.parse_args(argv)
    # Component-wise and case-folded on Windows (Codex review 01.5): "c:\\users\\..." is the same folder as "C:\\Users\\...".
    repo = os.path.normcase(os.path.realpath(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    out = os.path.normcase(os.path.realpath(a.out))
    if os.path.splitdrive(repo)[0] == os.path.splitdrive(out)[0] and os.path.commonpath([repo, out]) == repo:
        raise SystemExit("--out must be outside the repository")
    rec = build(a.manifest, a.snapshots, a.out)
    print(json.dumps({"release": rec["release"], "tables": rec["tables"], "set_aside": {k: v.get("count", len(v["rows"])) for k, v in rec["set_aside"].items()},
                      "unparsed_cells": rec["unparsed_cells"], "flags": rec["flags"],
                      "diagnostics_outside_rounding": {k: v["outside_rounding"] for k, v in rec["diagnostics"].items() if v["outside_rounding"]}}, indent=1))


if __name__ == "__main__":
    sys.exit(main())
