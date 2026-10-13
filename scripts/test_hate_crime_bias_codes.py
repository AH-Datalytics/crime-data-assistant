"""Hate Crime bias-code hotfix: unit and fixture checks (plan docs/superpowers/plans/2026-10-12-hate-crime-bias-code-hotfix.md,
r2 + Codex clarifications). Written BEFORE the code (preregistered in audit/hate-crime-bias-hotfix-2026-10-12/).

  T1  the reference fixture is the frozen Task 0 reference (36 modern codes; groups; beforeYear rules)
  T2  decode(code, year >= 2015) = the modern label, and the group by the FBI code range (Hispanic is Race/Ethnicity)
  T3  the year rules: 14, 43, 33 change meaning; 31 is unresolved before 2015
  T4  an unlisted code is "Other", flagged unlisted, never silently given a label
  T5  the importer's parse_year decodes by (code, data year)
  T6  the re-decode on a fixture database with the OLD labels: every row gets the reference label, summaries rebuilt,
      non-bias data unchanged, a second run changes nothing
  T7  the re-decode refuses to run without a backup path, and checks the backup it takes
  T8  an injected rebuild failure: reopened, the database is exactly as before (rows, labels, derived tables, schema)
  T8b (amendment 1) a rebuild that commits early: reported as a failure, and the database restored from the backup
  T9  a held lock: the re-decode exits "busy" and touches nothing
  T10 every bias label the Hate Crime prompt names is a reference label

No network, no real database. Run: python scripts/test_hate_crime_bias_codes.py
"""
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

failures = 0
checks = 0


def check(ok, label):
    global failures, checks
    checks += 1
    if not ok:
        failures += 1
        print(f"  FAIL  {label}")
    elif not os.environ.get("QUIET"):
        print(f"  PASS  {label}")


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


import hate_crime_bias as hcb  # noqa: E402

importer = load(os.path.join(HERE, "import-hate-crime.py"), "import_hate_crime")
redecode = load(os.path.join(HERE, "redecode-hate-crime-bias.py"), "redecode_hate_crime_bias")

# ---------------------------------------------------------------- T1 the reference
ref = json.load(open(hcb.REFERENCE_PATH, encoding="utf-8"))
check(len(ref["modern"]) == 36, f"T1: 36 modern codes ({len(ref['modern'])})")
check(ref["modern"]["15"] == "Anti-Multiple Races, Group" and ref["modern"]["41"] == "Anti-Gay (Male)" and ref["modern"]["85"] == "Anti-Sikh"
      and ref["modern"]["72"] == "Anti-Gender Non-Conforming" and ref["modern"]["88"] == "None" and ref["modern"]["99"] == "Unknown",  # 72: CDE wording (CDE codebook fix 2026-10-13)
      "T1: spot labels (15, 41, 72, 85, 88, 99)")
check(sorted(k for k in ref["beforeYear"] if not k.startswith("_")) == ["14", "31", "33", "43"], "T1: year rules for 14, 31, 33, 43 only")

# ---------------------------------------------------------------- T2 modern decode and groups
GROUP = {"Race/Ethnicity/Ancestry": ["11", "12", "13", "14", "15", "16", "31", "32", "33"],
         "Religion": ["21", "22", "23", "24", "25", "26", "27", "28", "29", "81", "82", "83", "84", "85"],
         "Sexual Orientation": ["41", "42", "43", "44", "45"], "Disability": ["51", "52"], "Gender": ["61", "62"],
         "Gender Identity": ["71", "72"], "Other": ["88", "99"]}
bad = []
for group, codes in GROUP.items():
    for c in codes:
        label, cat, unresolved, listed = hcb.decode(c, 2020)
        if label != ref["modern"][c] or cat != group or unresolved or not listed:
            bad.append((c, label, cat))
check(not bad, f"T2: every code at 2020 gets its modern label and FBI group ({bad[:3]})")
check(hcb.decode("32", 2023)[:2] == ("Anti-Hispanic or Latino", "Race/Ethnicity/Ancestry"), "T2: 32 is Hispanic, in Race/Ethnicity/Ancestry")
check(hcb.decode("41", 2023)[:2] == ("Anti-Gay (Male)", "Sexual Orientation"), "T2: 41 is Anti-Gay (Male)")
check(hcb.decode("51", 2023)[:2] == ("Anti-Physical Disability", "Disability"), "T2: 51 is Physical Disability")
check(hcb.decode("71", 2023)[:2] == ("Anti-Transgender", "Gender Identity"), "T2: 71 is Transgender")

# ---------------------------------------------------------------- T3 year rules
check(hcb.decode("14", 2012)[0] == "Anti-Asian/Pacific Islander" and hcb.decode("14", 2013)[0] == "Anti-Asian", "T3: 14 before/from 2013")
check(hcb.decode("43", 2012)[0] == "Anti-Homosexual (Gay and Lesbian)" and hcb.decode("43", 2013)[0].startswith("Anti-Lesbian, Gay, Bisexual"), "T3: 43 before/from 2013")
check(hcb.decode("43", 2012)[1] == "Sexual Orientation", "T3: 43 before 2013 keeps its group")
check([hcb.decode("33", y)[0] for y in (2012, 2013, 2014, 2015)] == ["Anti-Other Ethnicity/National Origin", "Anti-Not Hispanic or Latino", "Anti-Not Hispanic or Latino", "Anti-Other Race/Ethnicity/Ancestry"], "T3: 33 across 2013 and 2015")
d31 = hcb.decode("31", 2001)
check(d31[1] == "Other" and d31[2] is True and "not confirmed" in d31[0], f"T3: 31 before 2015 is unresolved, group Other ({d31})")
check(hcb.decode("31", 2015)[:3] == ("Anti-Arab", "Race/Ethnicity/Ancestry", False), "T3: 31 from 2015 is Anti-Arab")
check(hcb.decode("41", None)[0] == "Anti-Gay (Male)", "T3: no year gives the modern label")

# ---------------------------------------------------------------- T4 unlisted
u = hcb.decode("77", 2020)
check(u[1] == "Other" and u[3] is False and "77" in u[0], f"T4: an unlisted code is Other and flagged ({u})")

# ---------------------------------------------------------------- T5 the importer decodes by (code, data year)
def ir_line(code, offense="13B"):
    line = "IR" + "42" + "TX0000000" + "000000000001" + "20100510" + "F1" + "001" + "01" + "W"
    group = offense + "001" + "20" + code + "I       "
    return line + group


bh = "BH" + "42" + " " * 67 + "TX" + "1A" + " " * 30 + "000100000" + " " * 111 + "2010"
incidents, _ = importer.parse_year("\n".join([bh, ir_line("41"), ir_line("43")]))
check(len(incidents) == 2 and incidents[0]["year"] == 2010, f"T5: two incidents parsed for 2010 ({[i.get('year') for i in incidents]})")
if len(incidents) == 2:
    check((incidents[0]["bias_desc"], incidents[0]["bias_category"]) == ("Anti-Gay (Male)", "Sexual Orientation"), f"T5: 41 in 2010 = Anti-Gay (Male) ({incidents[0]['bias_desc']})")
    check(incidents[1]["bias_desc"] == "Anti-Homosexual (Gay and Lesbian)", f"T5: 43 in 2010 = the pre-2013 meaning ({incidents[1]['bias_desc']})")

# ---------------------------------------------------------------- fixture database for T6-T9
OLD = {"41": ("Anti-Physical Disability", "Disability"), "32": ("Anti-Lesbian", "Sexual Orientation"), "43": ("Anti-Male", "Gender"),
       "12": ("Anti-Black or African American", "Race/Ethnicity/Ancestry"), "31": ("Anti-Gay (Male)", "Sexual Orientation"),
       "85": ("85", "Other")}
ROWS = [(2001, "31"), (2010, "41"), (2010, "43"), (2012, "32"), (2016, "32"), (2016, "12"), (2020, "31"), (2023, "41"), (2026, "85")]


def make_fixture(path):
    conn = sqlite3.connect(path)
    conn.execute("""CREATE TABLE hate_crime_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, year INTEGER, state TEXT, state_name TEXT, ori TEXT,
        agency_name TEXT, population INTEGER, pop_group TEXT, incident_number TEXT, incident_date TEXT, data_source TEXT, quarter TEXT,
        total_individual_victims INTEGER, total_offenders INTEGER, offender_race TEXT, offender_ethnicity TEXT, offense_group INTEGER,
        offense_code TEXT, offense_name TEXT, offense_victims INTEGER, location TEXT, bias_code TEXT, bias_desc TEXT, bias_category TEXT,
        victim_types TEXT, adult_victims INTEGER, juvenile_victims INTEGER, adult_offenders INTEGER, juvenile_offenders INTEGER)""")
    for i, (year, code) in enumerate(ROWS):
        desc, cat = OLD[code]
        conn.execute("INSERT INTO hate_crime_incidents (year, state, ori, agency_name, population, incident_number, incident_date, offense_code, offense_name, offense_victims, location, bias_code, bias_desc, bias_category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (year, "TX" if i % 2 else "CA", f"ORI{i % 3}", "Agency", 1000, f"N{i}", f"{year}-05-01", "13B", "Simple Assault", 1, "Residence/Home", code, desc, cat))
    conn.execute("CREATE TABLE hate_crime_participation (year INTEGER, state TEXT, total_agencies INTEGER, reporting_agencies INTEGER, total_incidents INTEGER, total_victims INTEGER)")
    conn.execute("INSERT INTO hate_crime_participation VALUES (2016, 'TX', 77, 0, 0, 0)")
    conn.commit()
    importer.rebuild_hate_crime_derived_tables(conn)
    conn.close()


def snapshot(path):
    conn = sqlite3.connect(path)
    out = {
        "rows": conn.execute("SELECT id, year, state, ori, incident_number, offense_code, offense_victims, location, bias_code, bias_desc, bias_category FROM hate_crime_incidents ORDER BY id").fetchall(),
        "schema": conn.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").fetchall(),
        "bias_trend": conn.execute("SELECT * FROM summary_hate_crime_bias_trend ORDER BY 1, 2, 3").fetchall(),
        "state": conn.execute("SELECT * FROM summary_hate_crime_state ORDER BY 1, 2, 3").fetchall(),
        "participation": conn.execute("SELECT * FROM hate_crime_participation ORDER BY 1, 2").fetchall(),
    }
    conn.close()
    return out


tmp = tempfile.mkdtemp(prefix="hcbias-test-")


def guarded(name, fn):
    """Amendment 1: a crash inside a check group is a FAIL on that group's name, and the later groups still run."""
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        check(False, f"{name}: crashed ({type(exc).__name__}: {str(exc)[:160]})")


# ---------------------------------------------------------------- T6 re-decode
def t6():
    db = os.path.join(tmp, "t6.db")
    make_fixture(db)
    before = snapshot(db)
    code = redecode.run(db, os.path.join(tmp, "t6.backup.db"))
    after = snapshot(db)
    check(code == 0, f"T6: the re-decode succeeds (exit {code})")
    want = [hcb.decode(c, y)[:2] for (y, c) in ROWS]
    got = [(r[9], r[10]) for r in after["rows"]]
    check(got == want, f"T6: every row gets the reference label for its (code, year) ({got[:3]})")
    check([r[:9] for r in before["rows"]] == [r[:9] for r in after["rows"]], "T6: non-bias columns unchanged")
    check(any(r[1] == "Sexual Orientation" and r[0] == 2023 for r in after["bias_trend"]) and not any(r[2] == "Anti-Physical Disability" and r[0] == 2023 for r in after["bias_trend"]), "T6: the summaries are rebuilt from the new labels")
    check([r for r in after["participation"] if r[0] == 2016 and r[1] == "TX"][0][2] == 77, "T6: participation keeps its recorded agency totals")
    check(os.path.exists(os.path.join(tmp, "t6.backup.db")) and snapshot(os.path.join(tmp, "t6.backup.db"))["rows"] == before["rows"], "T6: the backup holds the database as it was")
    code2 = redecode.run(db, os.path.join(tmp, "t6.backup2.db"))
    check(code2 == 0 and snapshot(db) == after, "T6: a second run changes nothing")


# ---------------------------------------------------------------- T7 backup required and checked
def t7():
    db7 = os.path.join(tmp, "t7.db")
    make_fixture(db7)
    p = subprocess.run([sys.executable, os.path.join(HERE, "redecode-hate-crime-bias.py"), "--db", db7], capture_output=True, text=True)
    check(p.returncode != 0 and snapshot(db7) == snapshot(db7), f"T7: no --backup is refused (exit {p.returncode})")
    orig_verify = redecode.verify_backup
    redecode.verify_backup = lambda src, dst: False
    b7 = snapshot(db7)
    try:
        code7 = redecode.run(db7, os.path.join(tmp, "t7.backup.db"))
    finally:
        redecode.verify_backup = orig_verify
    check(code7 == redecode.EXIT_BACKUP and snapshot(db7) == b7, f"T7: a backup that fails its check stops the run before any change (exit {code7})")


# ---------------------------------------------------------------- T8 rollback on an injected rebuild failure
def failing_rebuild(conn, all_bh_counts=None, commit=True):
    importer.rebuild_hate_crime_derived_tables(conn, all_bh_counts, commit=False)
    raise RuntimeError("injected rebuild failure")


def t8():
    db8 = os.path.join(tmp, "t8.db")
    make_fixture(db8)
    b8 = snapshot(db8)
    code8 = redecode.run(db8, os.path.join(tmp, "t8.backup.db"), rebuild=failing_rebuild)
    check(code8 == redecode.EXIT_FAILED, f"T8: the failure is reported (exit {code8})")
    check(snapshot(db8) == b8, "T8: reopened, rows, labels, derived tables and schema are exactly as before")


# ---------------------------------------------------------------- T8b (amendment 1) a rebuild that commits early
def committing_rebuild(conn, all_bh_counts=None, commit=True):
    importer.rebuild_hate_crime_derived_tables(conn, all_bh_counts, commit=True)


def t8b():
    db = os.path.join(tmp, "t8b.db")
    make_fixture(db)
    b = snapshot(db)
    code = redecode.run(db, os.path.join(tmp, "t8b.backup.db"), rebuild=committing_rebuild)
    check(code == redecode.EXIT_FAILED, f"T8b: an early commit is reported as a failure (exit {code})")
    check(snapshot(db) == b, "T8b: reopened, equal to before (restored from the verified backup)")


# ---------------------------------------------------------------- T9 lock contention
def t9():
    db9 = os.path.join(tmp, "t9.db")
    make_fixture(db9)
    b9 = snapshot(db9)
    lock_path = os.path.join(tmp, "hate_crime.lock")
    holder = subprocess.Popen([sys.executable, "-c", "import sys,time; sys.path.insert(0, sys.argv[1]); import hate_crime_bias as h\nwith h.exclusive_lock(sys.argv[2]):\n    print('held', flush=True); time.sleep(20)", HERE, lock_path], stdout=subprocess.PIPE, text=True)
    try:
        holder.stdout.readline()
        code9 = redecode.run(db9, os.path.join(tmp, "t9.backup.db"), lock_path=lock_path)
    finally:
        holder.kill()
        holder.wait()
    check(code9 == redecode.EXIT_BUSY and snapshot(db9) == b9 and not os.path.exists(os.path.join(tmp, "t9.backup.db")), f"T9: a held lock gives 'busy' and nothing is touched (exit {code9})")


for _name, _fn in (("T6", t6), ("T7", t7), ("T8", t8), ("T8b", t8b), ("T9", t9)):
    guarded(_name, _fn)

# ---------------------------------------------------------------- T10 prompt labels
import re  # noqa: E402

labels = set(ref["modern"].values()) | {e["label"] for k, v in ref["beforeYear"].items() if not k.startswith("_") for e in v}
prompt = open(os.path.join(ROOT, "lib", "hc-claude.ts"), encoding="utf-8").read()
named = sorted(set(re.findall(r'"(Anti-[^"]+)"', prompt)))
missing = [n for n in named if n not in labels]
check(not missing, f"T10: every bias label the Hate Crime prompt names is a reference label ({missing})")

print(f"\n{checks - failures}/{checks} passed")
sys.exit(1 if failures else 0)
