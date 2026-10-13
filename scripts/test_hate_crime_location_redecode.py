"""Hate crime location re-decode (CDE codebook fix 2026-10-13): fixture checks for scripts/redecode-hate-crime-locations.py.
Preregistered in audit/cde-codebook-fixes-2026-10-13/ (section 3 and amendment 2).

  L1  consistent rows take the master file's code and its CDE name (53 "Online/Internet" -> School-Elementary/Secondary)
  L2  non-consistent rows (unmatched, ambiguous, conflicting) get location_code NULL; a label the old mapping only
      produced from its own code is retained in CDE wording; any other becomes "Location not confirmed"
  L3  pre-2010 rows get the CDE name of the code their label came from, location_code NULL
  L4  state 98 -> FS, offender ethnicity M -> Multiple, bias 28 reworded; every other column unchanged; summaries rebuilt
  L5  2014 is read from the nested file whose batch-header year is 2014, not the outer 2015 file
  L6  a second run changes nothing
  L7  master files: a missing year or a changed file stops the run before the backup or any change
  L8  no --backup is refused; a backup that fails its check stops the run before any change
  L9  an injected rebuild failure rolls back; an early commit is restored from the backup
  L10 the column checks catch a change outside the allowed ones (a fault injected after the updates): rolled back
  L11 a pre-2010 label with no known code stops the run: rolled back, nothing guessed
  L12 a held lock: "busy", nothing touched

No network, no real database. Run: python scripts/test_hate_crime_location_redecode.py
"""
import hashlib
import importlib.util
import io
import os
import sqlite3
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hate_crime_bias as hcb  # noqa: E402


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


importer = _load("import_hate_crime", "import-hate-crime.py")
redecode = _load("redecode_locations", "redecode-hate-crime-locations.py")
checks = failures = 0


def check(ok, msg):
    global checks, failures
    checks += 1
    if not ok:
        failures += 1
    print(("  PASS  " if ok else "  FAIL  ") + msg)


# ---------------------------------------------------------------- master files
def bh(year):
    return "BH" + "42" + " " * 67 + "TX" + "1A" + " " * 30 + "000100000" + " " * 111 + str(year)


def ir(num, date, groups, ori="TX0000001"):
    line = "IR" + "42" + ori.ljust(9) + num.ljust(12) + date + "F1" + "001" + "01" + "W"
    return line + "".join(off + "001" + loc + bias + "I       " for off, loc, bias in groups)


MASTER_TEXT = {
    2010: [bh(2010), ir("N10", "20100301", [("13B", "13", "12")])],
    2023: [bh(2023),
           ir("N1", "20230105", [("13B", "53", "12")]),
           ir("N2", "20230106", [("13B", "50", "12")]),
           ir("N3", "20230107", [("13B", "02", "12")]),
           ir("N4", "20230108", [("13B", "20", "28")]),
           ir("N5", "20230109", [("13B", "20", "12")]),
           ir("N5", "20230110", [("13B", "20", "12")]),   # the same key twice: ambiguous
           ir("N6", "20230111", [("13B", "50", "13")])],  # the row says bias 12: conflict
}
TEXT_2014 = [bh(2014), ir("N14", "20140401", [("13B", "04", "12")])]
TEXT_2015_IN_2014_ZIP = [bh(2015), ir("N14", "20150401", [("13B", "05", "12")])]


def make_masters(folder, years=(2010, 2014, 2023), corrupt=None):
    os.makedirs(folder, exist_ok=True)
    sums = []
    for year in years:
        path = os.path.join(folder, f"hate-crime-{year}.zip")
        with zipfile.ZipFile(path, "w") as z:
            if year == 2014:  # as CDE ships it: the 2015 file outside, the real 2014 file in a nested zip
                z.writestr("HC2015.txt", "\n".join(TEXT_2015_IN_2014_ZIP))
                inner = io.BytesIO()
                with zipfile.ZipFile(inner, "w") as zi:
                    zi.writestr("HCRENC14.DAT", "\n".join(TEXT_2014))
                z.writestr("HATECYR2014MASTERFXENCRYPTED.zip", inner.getvalue())
            else:
                z.writestr(f"HC{year}.txt", "\n".join(MASTER_TEXT[year]))
        with open(path, "rb") as fh:
            sums.append(f"{hashlib.sha256(fh.read()).hexdigest()} *hate-crime-{year}.zip")
    with open(os.path.join(folder, "SHA256SUMS"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(sums) + "\n")
    if corrupt:
        with open(os.path.join(folder, f"hate-crime-{corrupt}.zip"), "ab") as fh:
            fh.write(b"x")
    return folder


# ---------------------------------------------------------------- fixture database (the production schema, no location_code)
# (key, year, incident_number, date, bias, location label, state, ethnicity, bias_desc)
ROWS = [
    ("c53", 2023, "N1", "2023-01-05", "12", "Online/Internet", "TX", "N", None),
    ("c50", 2023, "N2", "2023-01-06", "12", "Cyberspace", "TX", "N", None),
    ("c02", 2023, "N3", "2023-01-07", "12", "Bank", "98", "M", None),
    ("c20", 2023, "N4", "2023-01-08", "28", "Residence/Home", "TX", None, "Anti-Mormon"),
    ("amb", 2023, "N5", "2023-01-09", "12", "Residence/Home", "TX", " ", None),
    ("conf", 2023, "N6", "2023-01-11", "12", "Cyberspace", "TX", "N", None),
    ("unm", 2023, "N99", "2023-02-01", "12", "Bank", "TX", "N", None),
    ("c13", 2010, "N10", "2010-03-01", "12", "Highway/Road/Street", "TX", None, None),
    ("c14", 2014, "N14", "2014-04-01", "12", "Church/Synagogue/Temple/Mosque", "TX", None, None),
    ("p13", 2005, "P1", "2005-06-01", "12", "Highway/Road/Street", "TX", None, None),
    ("p02", 2005, "P2", "2005-06-02", "12", "Bank", "TX", None, None),
    ("p20", 2001, "P3", "2001-06-03", "12", "Residence/Home", "98", None, None),
]
WANT = {  # key -> (location, location_code)
    "c53": ("School-Elementary/Secondary", "53"), "c50": ("Park/Playground", "50"), "c02": ("Bank/Savings and Loan", "02"),
    "c20": ("Residence/Home", "20"), "amb": ("Residence/Home", None), "conf": ("Location not confirmed", None),
    "unm": ("Bank/Savings and Loan", None), "c13": ("Highway/Road/Alley/Street/Sidewalk", "13"),
    "c14": ("Church/Synagogue/Temple/Mosque", "04"), "p13": ("Highway/Road/Alley/Street/Sidewalk", None),
    "p02": ("Bank/Savings and Loan", None), "p20": ("Residence/Home", None),
}


def make_db(path, extra=()):
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE hate_crime_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER, state TEXT, state_name TEXT, ori TEXT,
        agency_name TEXT, population INTEGER, pop_group TEXT, incident_number TEXT, incident_date TEXT, data_source TEXT, quarter TEXT,
        total_individual_victims INTEGER, total_offenders INTEGER, offender_race TEXT, offender_ethnicity TEXT, offense_group INTEGER,
        offense_code TEXT, offense_name TEXT, offense_victims INTEGER, location TEXT, bias_code TEXT, bias_desc TEXT, bias_category TEXT,
        victim_types TEXT, adult_victims INTEGER, juvenile_victims INTEGER, adult_offenders INTEGER, juvenile_offenders INTEGER)""")
    for key, year, num, date, bias, loc, state, eth, desc in list(ROWS) + list(extra):
        label, group = hcb.decode(bias, year)[:2]
        conn.execute("INSERT INTO hate_crime_incidents (year, state, state_name, ori, agency_name, population, incident_number, incident_date, offender_ethnicity, offense_group, offense_code, offense_name, offense_victims, location, bias_code, bias_desc, bias_category, victim_types) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (year, state, key, "TX0000001", "Agency", 1000, num, date, eth, 1, "13B", "Simple Assault", 1, loc, bias, desc or label, group, "I"))
    conn.commit()
    importer.rebuild_hate_crime_derived_tables(conn)
    conn.close()


def snapshot(path):
    conn = sqlite3.connect(path)
    out = {
        "rows": conn.execute("SELECT * FROM hate_crime_incidents ORDER BY id").fetchall(),
        "schema": conn.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").fetchall(),
        "location_summary": conn.execute("SELECT * FROM summary_hate_crime_location ORDER BY 1, 2").fetchall(),
        "bias_trend": conn.execute("SELECT * FROM summary_hate_crime_bias_trend ORDER BY 1, 2, 3").fetchall(),
    }
    conn.close()
    return out


def by_key(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    out = {r["state_name"]: dict(r) for r in conn.execute("SELECT * FROM hate_crime_incidents")}
    conn.close()
    return out


tmp = tempfile.mkdtemp(prefix="hcloc-test-")
MASTERS = make_masters(os.path.join(tmp, "masters"))


def fresh(name, extra=()):
    db = os.path.join(tmp, name + ".db")
    make_db(db, extra)
    return db


def guarded(name, fn):
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        check(False, f"{name}: crashed ({type(exc).__name__}: {str(exc)[:160]})")


# ---------------------------------------------------------------- L1-L6
def l1_to_l6():
    db = fresh("main")
    before = by_key(db)
    code = redecode.run(db, MASTERS, os.path.join(tmp, "main.backup.db"), report_path=os.path.join(tmp, "main.json"))
    check(code == redecode.EXIT_OK, f"L1-L6: the re-decode succeeds (exit {code})")
    after = by_key(db)
    got = {k: (r["location"], r["location_code"]) for k, r in after.items()}
    for key in ("c53", "c50", "c02", "c20", "c13"):
        check(got[key] == WANT[key], f"L1: consistent row {key} -> {WANT[key]} ({got[key]})")
    for key in ("amb", "conf", "unm"):
        check(got[key] == WANT[key], f"L2: non-consistent row {key} -> {WANT[key]} ({got[key]})")
    for key in ("p13", "p02", "p20"):
        check(got[key] == WANT[key], f"L3: pre-2010 row {key} -> {WANT[key]} ({got[key]})")
    check(got["c14"] == WANT["c14"], f"L5: 2014 is read from the nested 2014 file ({got['c14']})")
    check(after["c02"]["state"] == "FS" and after["p20"]["state"] == "FS" and after["c53"]["state"] == "TX", "L4: state 98 -> FS, others unchanged")
    check(after["c02"]["offender_ethnicity"] == "Multiple" and after["amb"]["offender_ethnicity"] == " " and after["c13"]["offender_ethnicity"] is None,
          "L4: ethnicity M -> Multiple, others unchanged")
    check(after["c20"]["bias_desc"] == hcb.decode("28", 2023)[0] != "Anti-Mormon", f"L4: bias 28 takes the CDE wording ({after['c20']['bias_desc']})")
    same = all(after[k][c] == before[k][c] for k in before for c in before[k] if c not in ("location", "state", "offender_ethnicity", "bias_desc"))
    check(same, "L4: every other column unchanged")
    conn = sqlite3.connect(db)
    summary = dict(((y, loc), n) for y, loc, n, *_ in conn.execute("SELECT * FROM summary_hate_crime_location"))
    conn.close()
    check(summary.get((2023, "School-Elementary/Secondary")) == 1 and (2023, "Online/Internet") not in summary and (2023, "Bank") not in summary,
          "L4: the location summary is rebuilt from the new labels, with no old-wording groups")
    b2 = snapshot(db)
    code2 = redecode.run(db, MASTERS, os.path.join(tmp, "main.backup2.db"))
    check(code2 == redecode.EXIT_OK and snapshot(db) == b2, "L6: a second run changes nothing")


# ---------------------------------------------------------------- L7 master files
def l7():
    db = fresh("l7")
    b = snapshot(db)
    missing = make_masters(os.path.join(tmp, "masters-missing"), years=(2010, 2023))
    code = redecode.run(db, missing, os.path.join(tmp, "l7a.backup.db"))
    check(code == redecode.EXIT_MASTERS and snapshot(db) == b and not os.path.exists(os.path.join(tmp, "l7a.backup.db")),
          f"L7: a missing year stops the run before the backup (exit {code})")
    changed = make_masters(os.path.join(tmp, "masters-changed"), corrupt=2023)
    code = redecode.run(db, changed, os.path.join(tmp, "l7b.backup.db"))
    check(code == redecode.EXIT_MASTERS and snapshot(db) == b and not os.path.exists(os.path.join(tmp, "l7b.backup.db")),
          f"L7: a file that does not match SHA256SUMS stops the run (exit {code})")


# ---------------------------------------------------------------- L8 backup
def l8():
    db = fresh("l8")
    b = snapshot(db)
    p = subprocess.run([sys.executable, os.path.join(HERE, "redecode-hate-crime-locations.py"), "--db", db, "--masters", MASTERS], capture_output=True, text=True)
    check(p.returncode != 0 and snapshot(db) == b, f"L8: no --backup is refused (exit {p.returncode})")
    orig = redecode.verify_backup
    redecode.verify_backup = lambda src, dst: False
    try:
        code = redecode.run(db, MASTERS, os.path.join(tmp, "l8.backup.db"))
    finally:
        redecode.verify_backup = orig
    check(code == redecode.EXIT_BACKUP and snapshot(db) == b, f"L8: a backup that fails its check stops the run before any change (exit {code})")


# ---------------------------------------------------------------- L9 rollback and restore
def failing_rebuild(conn, all_bh_counts=None, commit=True):
    importer.rebuild_hate_crime_derived_tables(conn, all_bh_counts, commit=False)
    raise RuntimeError("injected rebuild failure")


def committing_rebuild(conn, all_bh_counts=None, commit=True):
    importer.rebuild_hate_crime_derived_tables(conn, all_bh_counts, commit=True)


def l9():
    db = fresh("l9a")
    b = snapshot(db)
    code = redecode.run(db, MASTERS, os.path.join(tmp, "l9a.backup.db"), rebuild=failing_rebuild)
    check(code == redecode.EXIT_FAILED and snapshot(db) == b, f"L9: a rebuild failure rolls back; rows, summaries and schema as before (exit {code})")
    db = fresh("l9b")
    b = snapshot(db)
    code = redecode.run(db, MASTERS, os.path.join(tmp, "l9b.backup.db"), rebuild=committing_rebuild)
    check(code == redecode.EXIT_FAILED and snapshot(db) == b, f"L9: an early commit is a failure, and the database is restored from the backup (exit {code})")


# ---------------------------------------------------------------- L10 the column checks
def l10():
    for name, sql in (("an offense name", "UPDATE hate_crime_incidents SET offense_name = 'Changed' WHERE id = 1"),
                      ("a state that was not 98", "UPDATE hate_crime_incidents SET state = 'FS' WHERE state = 'TX' AND id = 1"),
                      ("a bias label outside 28/42/72/81", "UPDATE hate_crime_incidents SET bias_desc = 'Changed' WHERE bias_code = '12' AND id = 1"),
                      ("a location label", "UPDATE hate_crime_incidents SET location = 'Cyberspace' WHERE id = 1")):
        db = fresh("l10")
        b = snapshot(db)
        code = redecode.run(db, MASTERS, os.path.join(tmp, f"l10-{len(name)}.backup.db"), after_updates=lambda c, s=sql: c.execute(s))
        check(code == redecode.EXIT_FAILED and snapshot(db) == b, f"L10: a change to {name} is caught and rolled back (exit {code})")
        os.remove(db)


# ---------------------------------------------------------------- L11 an unknown pre-2010 label
def l11():
    db = fresh("l11", extra=[("pX", 2004, "P9", "2004-01-01", "12", "Spaceport", "TX", None, None)])
    b = snapshot(db)
    code = redecode.run(db, MASTERS, os.path.join(tmp, "l11.backup.db"))
    check(code == redecode.EXIT_FAILED and snapshot(db) == b, f"L11: a pre-2010 label with no code stops the run, nothing changed (exit {code})")


# ---------------------------------------------------------------- L12 lock
def l12():
    db = fresh("l12")
    b = snapshot(db)
    lock_path = os.path.join(tmp, "hate_crime.lock")
    holder = subprocess.Popen([sys.executable, "-c", "import sys,time; sys.path.insert(0, sys.argv[1]); import hate_crime_bias as h\nwith h.exclusive_lock(sys.argv[2]):\n    print('held', flush=True); time.sleep(20)", HERE, lock_path], stdout=subprocess.PIPE, text=True)
    try:
        holder.stdout.readline()
        code = redecode.run(db, MASTERS, os.path.join(tmp, "l12.backup.db"), lock_path=lock_path)
    finally:
        holder.kill()
        holder.wait()
    check(code == redecode.EXIT_BUSY and snapshot(db) == b and not os.path.exists(os.path.join(tmp, "l12.backup.db")), f"L12: a held lock gives 'busy' and nothing is touched (exit {code})")


for _name, _fn in (("L1-L6", l1_to_l6), ("L7", l7), ("L8", l8), ("L9", l9), ("L10", l10), ("L11", l11), ("L12", l12)):
    guarded(_name, _fn)

print(f"\n{checks - failures}/{checks} passed")
sys.exit(1 if failures else 0)
