"""Re-decode the location labels of an existing hate_crime.db from the FBI CDE codebook (CDE codebook fix 2026-10-13).

The old importer numbered the newer locations 26-50 where the FBI numbers them 37-58, so many rows from 2010 on carry
another place's name (a K-12 school shown as "Online/Internet", a park as "Cyberspace"). The raw code was not stored,
so it is read again from the CDE master files (a folder with a SHA256SUMS list) by the importer's own parser.

Each row from 2010 on is matched on (ori, incident_number, year). A match is CONSISTENT when the key occurs once in
that year's master file and the row's offense group exists there with the same offense code, bias code and date.
  - consistent rows: location_code = the master file's code; location = its CDE name;
  - other rows from 2010 on: location_code NULL. The label is RETAINED (reworded to the CDE name of the one code it
    came from, amendment 2) when the old mapping only ever produced it from its own correct code; otherwise it
    becomes "Location not confirmed";
  - rows before 2010 (codes 01-25 only): location = the CDE name of the code the label came from; location_code NULL.
Then state "98" -> "FS", offender_ethnicity "M" -> "Multiple", bias labels re-decoded (CDE wording), and the derived
tables rebuilt by the importer's own function.

Order (as in scripts/redecode-hate-crime-bias.py):
  1. the master files are checked against SHA256SUMS (a missing or changed file: exit, nothing touched);
  2. the exclusive lock shared with scripts/update-hate-crime.sh (busy: exit, nothing touched);
  3. an SQLite online backup to --backup, then its check; a failed check exits before any change;
  4. ONE transaction: the updates, the rebuild (commit=False), then every check, column by column; COMMIT only if
     all pass, otherwise ROLLBACK (or, after an early commit, a restore from the backup).

Usage: python3 scripts/redecode-hate-crime-locations.py --db /opt/nibrs/hate_crime.db --masters <folder>
         --backup /opt/nibrs/backups/hate_crime.<ts>.db [--report out.json] [--dry-run]
"""
import argparse
import hashlib
import importlib.util
import json
import os
import sqlite3
import sys
import zipfile
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from hate_crime_bias import decode, exclusive_lock, LockBusy  # noqa: E402

EXIT_OK = 0
EXIT_BUSY = 3
EXIT_BACKUP = 4
EXIT_FAILED = 5
EXIT_MASTERS = 7

NOT_CONFIRMED = "Location not confirmed"
STATE_FIX = {"98": "FS"}  # FBI CDE REF_STATE: federal agencies
ETHNICITY_FIX = {"M": "Multiple"}  # FBI CDE NIBRS_ETHNICITY
BIAS_REWORDED = {"28", "42", "72", "81"}  # the bias codes whose wording now follows CDE
CHANGED = {"location", "location_code", "state", "offender_ethnicity", "bias_desc"}
# Short forms of a CDE location name used by the old importers (same meaning); audit/cde-codebook-audit-2026-10-13/task0.
SHORT = {
    "02": ["Bank"], "09": ["Drug Store/Doctor/Hospital"], "13": ["Highway/Road/Street"], "14": ["Hotel/Motel"],
    "15": ["Jail/Prison"], "16": ["Lake/Waterway"], "18": ["Parking Lot/Garage"], "19": ["Rental Storage"],
    "37": ["Abandoned Structure"], "39": ["Arena/Stadium"], "40": ["ATM"], "41": ["Auto Dealership"], "45": ["Dock/Wharf"],
    "46": ["Farm"], "47": ["Gambling Facility"], "54": ["Shelter/Mission/Homeless"],
}


class _DryRun(Exception):
    pass


def _importer():
    spec = importlib.util.spec_from_file_location("import_hate_crime", os.path.join(HERE, "import-hate-crime.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _tables(conn):
    return [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def verify_backup(src_path, dst_path):
    """The backup is sound and holds the same rows: integrity_check ok, equal row counts for every table."""
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
    """Copy the verified backup back over the database (SQLite backup API), the whole database in one step."""
    src = sqlite3.connect(backup_path)
    dst = sqlite3.connect(db_path)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


def verify_masters(folder, years):
    """{year: zip path} for every year asked, each listed in SHA256SUMS with a matching hash; else ValueError."""
    sums = {}
    with open(os.path.join(folder, "SHA256SUMS"), encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                digest, name = line.split(None, 1)
                sums[name.strip().lstrip("*")] = digest.lower()
    out = {}
    for year in sorted(years):
        name = f"hate-crime-{year}.zip"
        path = os.path.join(folder, name)
        if name not in sums or not os.path.exists(path):
            raise ValueError(f"master file for {year} is missing ({name})")
        with open(path, "rb") as fh:
            if hashlib.sha256(fh.read()).hexdigest() != sums[name]:
                raise ValueError(f"master file for {year} does not match SHA256SUMS ({name})")
        out[year] = path
    return out


def master_records(imp, path, year):
    """{(ori, incident_number): {"n": IR records, "date": date, "groups": {group: (offense, location, bias)}}}."""
    with zipfile.ZipFile(path) as z:
        text = imp.master_text_for_year(z, year)
    incidents, _ = imp.parse_year(text)
    recs = defaultdict(lambda: {"n": 0, "date": None, "groups": {}})
    for i in incidents:
        r = recs[(i["ori"], i["incident_number"])]
        if i["offense_group"] == 1:
            r["n"] += 1
            r["date"] = i["incident_date"]
        r["groups"][i["offense_group"]] = (i["offense_code"], i["location_code"], i["bias_code"])
    return recs


def _era(year):
    return "2026" if year == 2026 else "2010-2025"


def plan_locations(rows, records, cde):
    """The new (location, location_code, kind) for every row id, plus the match statistics. Pure: no database access.

    rows: dicts with id, year, ori, incident_number, offense_group, offense_code, bias_code, incident_date, location.
    records: {year: master_records(...)} for every year from 2010 on. cde: {code: CDE name}.
    """
    def same(code, label):
        name = cde.get(code, "")
        return label == name or label.lower() == name.lower() or label in SHORT.get(code, [])

    match = defaultdict(Counter)
    code_of = {}
    for r in rows:
        if r["year"] is None or r["year"] < 2010:
            continue
        hit = records[r["year"]].get((r["ori"], r["incident_number"]))
        if not hit:
            match[r["year"]]["unmatched"] += 1
        elif hit["n"] != 1:
            match[r["year"]]["ambiguous"] += 1
        else:
            g = hit["groups"].get(r["offense_group"])
            if not g or g[0] != r["offense_code"] or g[2] != r["bias_code"] or hit["date"] != r["incident_date"]:
                match[r["year"]]["conflict"] += 1
            else:
                match[r["year"]]["consistent"] += 1
                code_of[r["id"]] = g[1]

    # The mapping the old importers actually used, measured on the consistent rows (their current labels).
    produced = defaultdict(Counter)   # (era, code) -> label counts
    label_codes = defaultdict(set)    # (era, label) -> codes
    for r in rows:
        if r["id"] in code_of:
            produced[(_era(r["year"]), code_of[r["id"]])][r["location"]] += 1
            label_codes[(_era(r["year"]), r["location"])].add(code_of[r["id"]])
    dominant = defaultdict(set)       # (era, label) -> codes whose most common label it is
    for (era, code), labels in produced.items():
        dominant[(era, labels.most_common(1)[0][0])].add(code)

    def retained_code(era, label):
        """(retained?, the one code it came from or None)."""
        strict = label_codes.get((era, label), set())
        if len(strict) == 1 and same(next(iter(strict)), label):
            return True, next(iter(strict))
        dom = dominant.get((era, label), set())
        if dom and all(same(c, label) for c in dom):
            return True, next(iter(dom)) if len(dom) == 1 else None
        return False, None

    old_label_code = {}  # pre-2010 labels -> code, from the 2010-2025 consistent rows
    for (era, label), codes in dominant.items():
        good = [c for c in codes if same(c, label)]
        if era == "2010-2025" and len(good) == 1:
            old_label_code[label] = good[0]
    by_name = {name: code for code, name in cde.items()}

    out, kinds, kept_text, unconfirmed = {}, Counter(), Counter(), Counter()
    for r in rows:
        if r["id"] in code_of:
            code = code_of[r["id"]]
            out[r["id"]] = (cde.get(code, code), code, "consistent")
        elif r["year"] is not None and r["year"] >= 2010:
            ok, code = retained_code(_era(r["year"]), r["location"])
            if ok and code:
                out[r["id"]] = (cde[code], None, "retained")
            elif ok:
                out[r["id"]] = (r["location"], None, "retained")
                kept_text[r["location"]] += 1
            else:
                out[r["id"]] = (NOT_CONFIRMED, None, "not confirmed")
                unconfirmed[r["location"]] += 1
        else:
            code = old_label_code.get(r["location"]) or by_name.get(r["location"])
            if code is None:
                raise ValueError(f"a pre-2010 label has no code: {r['location']!r} (row {r['id']})")
            out[r["id"]] = (cde[code], None, "pre-2010")
        kinds[out[r["id"]][2]] += 1
    stats = {"match_by_year": {y: dict(c) for y, c in sorted(match.items())}, "kinds": dict(kinds),
             "retained_text_kept": dict(kept_text), "not_confirmed_by_old_label": dict(unconfirmed.most_common())}
    return out, stats


def _snapshot(conn):
    cols = [r[1] for r in conn.execute("PRAGMA table_info(hate_crime_incidents)")]
    return cols, {r[0]: dict(zip(cols, r)) for r in conn.execute(f"SELECT {', '.join(cols)} FROM hate_crime_incidents")}


def check_columns(before, after, expected):
    """Every column, row by row (preregistration section 3). Returns a list of problems (empty = all pass)."""
    bad = []
    if set(before) != set(after):
        return [f"row ids differ: {len(before)} before, {len(after)} after"]
    for rid, b in before.items():
        a = after[rid]
        loc, code, _kind = expected[rid]
        if a["location"] != loc or a["location_code"] != code:
            bad.append(f"row {rid}: location {a['location']!r}/{a['location_code']!r}, expected {loc!r}/{code!r}")
        if a["state"] != STATE_FIX.get(b["state"], b["state"]):
            bad.append(f"row {rid}: state {b['state']!r} -> {a['state']!r}")
        if a["offender_ethnicity"] != ETHNICITY_FIX.get(b["offender_ethnicity"], b["offender_ethnicity"]):
            bad.append(f"row {rid}: offender_ethnicity {b['offender_ethnicity']!r} -> {a['offender_ethnicity']!r}")
        label, group = decode(a["bias_code"], a["year"])[:2]
        if a["bias_desc"] != label or (a["bias_desc"] != b["bias_desc"] and a["bias_code"] not in BIAS_REWORDED):
            bad.append(f"row {rid}: bias_desc {b['bias_desc']!r} -> {a['bias_desc']!r} (code {a['bias_code']})")
        if a["bias_category"] != group or a["bias_category"] != b["bias_category"]:
            bad.append(f"row {rid}: bias_category {b['bias_category']!r} -> {a['bias_category']!r}")
        for col, val in b.items():
            if col not in CHANGED and a.get(col) != val:
                bad.append(f"row {rid}: {col} changed")
        if len(bad) > 20:
            break
    return bad


def _location_table(snapshot):
    t = Counter((r["year"], r["location"]) for r in snapshot.values())
    return [[y, loc, n] for (y, loc), n in sorted(t.items(), key=lambda kv: (kv[0][0] or 0, kv[0][1] or ""))]


def run(db_path, masters, backup_path, dry_run=False, lock_path=None, report_path=None, rebuild=None, after_updates=None):
    imp = _importer()
    probe = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        years = {y for (y,) in probe.execute("SELECT DISTINCT year FROM hate_crime_incidents WHERE year >= 2010")}
    finally:
        probe.close()
    try:
        paths = verify_masters(masters, years)
    except (OSError, ValueError) as exc:
        print(f"master files not usable: {exc}; nothing was changed")
        return EXIT_MASTERS
    lock_path = lock_path or os.path.join(os.path.dirname(os.path.abspath(db_path)), "hate_crime.lock")
    try:
        with exclusive_lock(lock_path):
            return _run_locked(imp, db_path, paths, backup_path, dry_run, report_path, rebuild, after_updates)
    except LockBusy:
        print(f"busy: {lock_path} is held (an import is running); nothing was changed")
        return EXIT_BUSY


def _run_locked(imp, db_path, paths, backup_path, dry_run, report_path, rebuild, after_updates):
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

    records = {y: master_records(imp, p, y) for y, p in paths.items()}
    rebuild = rebuild or imp.rebuild_hate_crime_derived_tables
    conn = sqlite3.connect(db_path, isolation_level=None)
    report = {}
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            cols, before = _snapshot(conn)
            if "location_code" not in cols:
                conn.execute("ALTER TABLE hate_crime_incidents ADD COLUMN location_code TEXT")
                for r in before.values():
                    r["location_code"] = None
            expected, stats = plan_locations(list(before.values()), records, dict(imp.LOCATION_CODES))
            conn.executemany("UPDATE hate_crime_incidents SET location = ?, location_code = ? WHERE id = ?",
                             [(loc, code, rid) for rid, (loc, code, _k) in expected.items()])
            for old, new in STATE_FIX.items():
                conn.execute("UPDATE hate_crime_incidents SET state = ? WHERE state = ?", (new, old))
            for old, new in ETHNICITY_FIX.items():
                conn.execute("UPDATE hate_crime_incidents SET offender_ethnicity = ? WHERE offender_ethnicity = ?", (new, old))
            for code, year in conn.execute("SELECT DISTINCT bias_code, year FROM hate_crime_incidents").fetchall():
                label, group = decode(code, year)[:2]
                conn.execute("UPDATE hate_crime_incidents SET bias_desc = ?, bias_category = ? WHERE bias_code IS ? AND year IS ?", (label, group, code, year))
            if after_updates:
                after_updates(conn)  # test hook: a fault injected between the updates and the checks
            rebuild(conn, None, commit=False)
            if not conn.in_transaction:
                raise RuntimeError("the transaction was committed before validation")
            _cols, after = _snapshot(conn)
            problems = check_columns(before, after, expected)
            if problems:
                raise RuntimeError("column checks failed: " + "; ".join(problems[:5]))
            report = dict(stats, rows=len(after),
                          changed={c: sum(1 for i in before if before[i].get(c) != after[i].get(c)) for c in sorted(CHANGED)},
                          locations_before=_location_table(before), locations_after=_location_table(after))
            if dry_run:
                raise _DryRun()
            conn.execute("COMMIT")
        except _DryRun:
            conn.execute("ROLLBACK")
            print("dry run: every check passed; rolled back")
        except Exception as exc:  # noqa: BLE001 - any failure rolls back, or restores the backup
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
    if report_path:
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=1)
    print(json.dumps({k: report[k] for k in ("rows", "kinds", "changed", "retained_text_kept")}, indent=1))
    print("match by year: " + "; ".join(f"{y} {c}" for y, c in report["match_by_year"].items()))
    print("not confirmed, by old label: " + json.dumps(report["not_confirmed_by_old_label"]))
    return EXIT_OK


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--db", required=True)
    p.add_argument("--masters", required=True, help="folder of CDE hate-crime-YYYY.zip master files with a SHA256SUMS list")
    p.add_argument("--backup", required=True, help="where to write the fresh backup taken before any change (must not exist)")
    p.add_argument("--lock", default=None, help="the lock file shared with update-hate-crime.sh (default: <db folder>/hate_crime.lock)")
    p.add_argument("--report", default=None, help="write the match statistics and the before/after location table here (JSON)")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args(argv)
    return run(a.db, a.masters, a.backup, a.dry_run, a.lock, a.report)


if __name__ == "__main__":
    sys.exit(main())
