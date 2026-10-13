"""CDE codebook fix (2026-10-13): fixture checks for the SHR relabel and the NIBRS lookup-table rebuild.
Preregistered in audit/cde-codebook-fixes-2026-10-13/ (section 3: "the SHR relabel on a fixture database; the NIBRS
lookup rebuild on a fixture database").

  S1 shr: "30"/"31" take CDE's names (group stays "Unknown"); "Lover's Triangle" -> "Domestic Violence" (group kept);
     every other column, row and table unchanged; the backup holds the database as it was
  S2 shr: a second run changes nothing
  S3 shr: an existing refresh lock gives "busy", nothing touched, and the lock is left in place
  S4 shr: a backup that fails its check stops the run before any change
  S5 shr: a change outside `circumstance` (a fault injected after the updates) is caught and rolled back
  N1 nibrs: the rebuild replaces every lookup table with the code lists (old shifted property rows gone)
  N2 nibrs: a failure part-way (a later table cannot be written) leaves every table as it was

No network, no real database. Run: python scripts/test_codebook_data_steps.py
"""
import importlib.util
import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


relabel = _load("relabel_shr", "relabel-shr-codebook.py")
brt = _load("build_reference_tables", "build_reference_tables.py")
checks = failures = 0
tmp = tempfile.mkdtemp(prefix="codebook-steps-")


def check(ok, msg):
    global checks, failures
    checks += 1
    if not ok:
        failures += 1
    print(("  PASS  " if ok else "  FAIL  ") + msg)


def guarded(name, fn):
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        check(False, f"{name}: crashed ({type(exc).__name__}: {str(exc)[:160]})")


# ---------------------------------------------------------------- SHR
SHR_ROWS = [  # circumstance, circumstance_group, weapon
    ("30", "Unknown", "Handgun"), ("31", "Unknown", "Knife"), ("Lover's Triangle", "Other Than Felony", "Handgun"),
    ("Robbery", "Felony Type", "Handgun"), ("Other Arguments", "Other Than Felony", None),
]


def make_shr(path):
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE incidents (id INTEGER PRIMARY KEY, year INTEGER, state TEXT, ori TEXT, weapon TEXT,
        circumstance TEXT, circumstance_group TEXT, sub_circumstance TEXT)""")
    conn.execute("CREATE TABLE victims (id INTEGER PRIMARY KEY, incident_id INTEGER, age TEXT)")
    for i, (c, g, w) in enumerate(SHR_ROWS, 1):
        conn.execute("INSERT INTO incidents VALUES (?,?,?,?,?,?,?,?)", (i, 2023, "WY", f"ORI{i}", w, c, g, None))
        conn.execute("INSERT INTO victims (incident_id, age) VALUES (?, ?)", (i, "30"))
    conn.commit()
    conn.close()


def shr_snapshot(path):
    conn = sqlite3.connect(path)
    out = (conn.execute("SELECT * FROM incidents ORDER BY id").fetchall(), conn.execute("SELECT * FROM victims ORDER BY id").fetchall(),
           conn.execute("SELECT type, name, sql FROM sqlite_master ORDER BY 1, 2").fetchall())
    conn.close()
    return out


def s1_s2():
    db = os.path.join(tmp, "shr.db")
    make_shr(db)
    before = shr_snapshot(db)
    lock = os.path.join(tmp, "shr-refresh.lock")
    code = relabel.run(db, lock, os.path.join(tmp, "shr.backup.db"))
    after = shr_snapshot(db)
    got = [(r[5], r[6]) for r in after[0]]
    want = [("Human Trafficking/Commercial Sex Acts", "Unknown"), ("Human Trafficking/Involuntary Servitude", "Unknown"),
            ("Domestic Violence", "Other Than Felony"), ("Robbery", "Felony Type"), ("Other Arguments", "Other Than Felony")]
    check(code == relabel.EXIT_OK and got == want, f"S1: circumstances relabeled, groups kept ({got})")
    check([r[:5] + r[6:] for r in after[0]] == [r[:5] + r[6:] for r in before[0]] and after[1] == before[1] and after[2] == before[2],
          "S1: every other column, the victims table and the schema unchanged")
    check(shr_snapshot(os.path.join(tmp, "shr.backup.db")) == before and not os.path.exists(lock), "S1: the backup holds the database as it was; the lock is released")
    code2 = relabel.run(db, lock, os.path.join(tmp, "shr.backup2.db"))
    check(code2 == relabel.EXIT_OK and shr_snapshot(db) == after, "S2: a second run changes nothing")


def s3():
    db = os.path.join(tmp, "shr3.db")
    make_shr(db)
    b = shr_snapshot(db)
    lock = os.path.join(tmp, "held.lock")
    open(lock, "w").close()
    code = relabel.run(db, lock, os.path.join(tmp, "shr3.backup.db"))
    check(code == relabel.EXIT_BUSY and shr_snapshot(db) == b and os.path.exists(lock) and not os.path.exists(os.path.join(tmp, "shr3.backup.db")),
          f"S3: an existing refresh lock gives 'busy'; nothing touched; the lock is left (exit {code})")


def s4():
    db = os.path.join(tmp, "shr4.db")
    make_shr(db)
    b = shr_snapshot(db)
    orig = relabel.verify_backup
    relabel.verify_backup = lambda s, d: False
    try:
        code = relabel.run(db, os.path.join(tmp, "s4.lock"), os.path.join(tmp, "shr4.backup.db"))
    finally:
        relabel.verify_backup = orig
    check(code == relabel.EXIT_BACKUP and shr_snapshot(db) == b, f"S4: a failed backup check stops the run before any change (exit {code})")


def s5():
    for name, sql in (("a weapon", "UPDATE incidents SET weapon = 'Rifle' WHERE id = 1"),
                      ("a circumstance group", "UPDATE incidents SET circumstance_group = 'Felony Type' WHERE id = 1"),
                      ("an unlisted circumstance", "UPDATE incidents SET circumstance = 'Changed' WHERE id = 4"),
                      ("another table", "UPDATE victims SET age = '31' WHERE id = 1")):
        db = os.path.join(tmp, f"shr5-{len(name)}.db")
        make_shr(db)
        b = shr_snapshot(db)
        code = relabel.run(db, os.path.join(tmp, "s5.lock"), os.path.join(tmp, f"shr5-{len(name)}.backup.db"), after_updates=lambda c, s=sql: c.execute(s))
        check(code == relabel.EXIT_FAILED and shr_snapshot(db) == b, f"S5: a change to {name} is caught and rolled back (exit {code})")


# ---------------------------------------------------------------- NIBRS lookup tables
TABLES = {"nibrs_property_descriptions": brt.PROPERTY_DESCRIPTIONS, "nibrs_weapon_codes": brt.WEAPON_CODES, "nibrs_race_codes": brt.RACE_CODES,
          "nibrs_ethnicity_codes": brt.ETHNICITY_CODES, "nibrs_location_types": brt.LOCATION_TYPES}


def make_nibrs(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE nibrs_property_descriptions (code TEXT PRIMARY KEY, description TEXT)")
    conn.executemany("INSERT INTO nibrs_property_descriptions VALUES (?, ?)", [("74", "Pharmaceuticals"), ("99", "Old Row")])
    conn.execute("CREATE TABLE incidents (id INTEGER PRIMARY KEY, property TEXT)")
    conn.execute("INSERT INTO incidents VALUES (1, '74')")
    conn.commit()
    conn.close()


def nibrs_snapshot(path):
    conn = sqlite3.connect(path)
    out = {t: conn.execute(f'SELECT * FROM "{t}" ORDER BY 1').fetchall() for (t,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY 1").fetchall()}
    conn.close()
    return out


def run_brt(db):
    argv = sys.argv
    sys.argv = ["build_reference_tables.py", "--db", db]
    try:
        brt.main()
    finally:
        sys.argv = argv


def n1():
    db = os.path.join(tmp, "nibrs.db")
    make_nibrs(db)
    run_brt(db)
    snap = nibrs_snapshot(db)
    ok = all(sorted(snap[t]) == sorted(tuple(r) for r in rows) for t, rows in TABLES.items())
    check(ok and ("74", "Pharmaceuticals") not in snap["nibrs_property_descriptions"] and snap["incidents"] == [(1, "74")],
          "N1: every lookup table equals the code list; the old shifted rows are gone; other tables untouched")


def n2():
    db = os.path.join(tmp, "nibrs2.db")
    make_nibrs(db)
    b = nibrs_snapshot(db)
    orig = brt.RACE_CODES[:]
    brt.RACE_CODES.append(brt.RACE_CODES[0])  # a duplicate key: the race table, written after property, cannot be written
    try:
        try:
            run_brt(db)
            raised = False
        except sqlite3.IntegrityError:
            raised = True
    finally:
        brt.RACE_CODES[:] = orig
    check(raised and nibrs_snapshot(db) == b, "N2: a failure part-way leaves every table as it was (property included)")


for _name, _fn in (("S1-S2", s1_s2), ("S3", s3), ("S4", s4), ("S5", s5), ("N1", n1), ("N2", n2)):
    guarded(_name, _fn)

print(f"\n{checks - failures}/{checks} passed")
sys.exit(1 if failures else 0)
