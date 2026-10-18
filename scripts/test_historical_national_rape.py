"""Historical national rape fix: Python checks, written BEFORE the code (preregistered in
audit/historical-national-rape-fix-2026-10-13/, with amendment 1).

  P1 the correction: 2017-2024 US rape = CIUS Table 1 (scripts/fixtures/cius-table1-2017-2024.json); rape_rate by the formula;
     total_offenses moved by exactly the delta (the 2024 residual of 640 preserved); 2016 and state rows untouched; the marker
     table and its provenance row
  P2 guards: a missing US year, two US rows, a population mismatch, an offense more than 6% off -> no change, an error
  P3 a US year after 2024 is refused by refuse_unreviewed_national_years
  P4 the importer's own step (load_state_national) applies the correction and does not commit; main() calls it before its commit
  P5 a second run changes nothing
  P6 the one-off script: backup required and checked; injected rebuild failure rolls back; early commit restored; held lock refused
  P7 the one-off script's column checks catch an injected change outside the four columns

No network, no real database. Run: python scripts/test_historical_national_rape.py
"""
import ast
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
checks = failures = 0


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
        check(False, f"{name}: crashed ({type(exc).__name__}: {str(exc)[:200]})")


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


T1 = json.load(open(os.path.join(HERE, "fixtures", "cius-table1-2017-2024.json"), encoding="utf-8"))["years"]
# The production national row (2026-10-13, audit/historical-national-rape-fix-2026-10-13/prod-national-totals.txt and
# ../cde-codebook-audit-2026-10-13/historical-rape-source/app-national-2013-2024.txt):
# year: (population, murder, rape, robbery, aggravated_assault, burglary, theft, auto_theft, total_offenses)
PROD = {
    2016: (323127513, 17352, 91428, 332381, 804409, 1514261, 5635919, 766731, 9162481),
    2017: (325719178, 18139, 94630, 310757, 800857, 1390925, 5501168, 766576, 8883052),
    2018: (327167434, 16664, 103321, 277793, 803748, 1241510, 5265427, 755663, 8464126),
    2019: (328239355, 16862, 101876, 261575, 809253, 1107937, 5129103, 721335, 8147941),
    2020: (329484123, 21984, 92940, 235923, 902084, 1018738, 4585935, 808391, 7665995),
    2021: (331894354, 21463, 107082, 186327, 877648, 876906, 4255330, 803104, 7127860),
    2022: (333287557, 21939, 103003, 224091, 910014, 910312, 4729171, 949518, 7848048),
    2023: (334914895, 19907, 96504, 225969, 897908, 852963, 4579322, 1082010, 7754583),
    2024: (340110988, 16935, 91865, 205952, 870931, 779542, 4326531, 880327, 7172723),
}
COLS = ["state", "year", "population", "murder", "rape", "robbery", "aggravated_assault", "burglary", "theft", "auto_theft",
        "total_offenses", "murder_rate", "rape_rate", "robbery_rate", "aggravated_assault_rate", "burglary_rate", "theft_rate",
        "auto_theft_rate", "total_offenses_rate"]
SCHEMA = """CREATE TABLE historical_state_national (state TEXT, year INTEGER, population INTEGER, murder INTEGER, rape INTEGER,
    robbery INTEGER, aggravated_assault INTEGER, burglary INTEGER, theft INTEGER, auto_theft INTEGER, total_offenses INTEGER,
    murder_rate REAL, rape_rate REAL, robbery_rate REAL, aggravated_assault_rate REAL, burglary_rate REAL, theft_rate REAL,
    auto_theft_rate REAL, total_offenses_rate REAL, PRIMARY KEY (state, year))"""


def row(state, year, vals):
    pop, m, r, rb, a, b, t, v, tot = vals
    rate = lambda x: x * 100000.0 / pop
    return (state, year, pop, m, r, rb, a, b, t, v, tot, rate(m), rate(r), rate(rb), rate(a), rate(b), rate(t), rate(v), rate(tot))


def make_db(path, mutate=None):
    rows = [row("United States", y, v) for y, v in PROD.items()]
    rows.append(row("Texas", 2018, (28701845, 1322, 15098, 29599, 74151, 117931, 525287, 69185, 832573)))
    rows.append(row("Texas", 2016, (27862596, 1478, 9905, 34032, 75034, 139874, 576893, 66819, 904035)))
    if mutate:
        rows = mutate(rows)
    conn = sqlite3.connect(path)
    conn.execute(SCHEMA)
    conn.executemany(f"INSERT INTO historical_state_national VALUES ({','.join('?' * 19)})", rows)
    conn.commit()
    conn.close()


def table(path):
    conn = sqlite3.connect(path)
    out = {(r[0], r[1]): dict(zip(COLS, r)) for r in conn.execute("SELECT * FROM historical_state_national")}
    marker = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'historical_national_rape_correction'").fetchone()
    prov = conn.execute("SELECT * FROM historical_national_rape_correction").fetchall() if marker else None
    conn.close()
    return out, prov


tmp = tempfile.mkdtemp(prefix="hnr-test-")
core = load("historical_core", "historical_core.py")


def p1_p3_p5():
    db = os.path.join(tmp, "p1.db")
    make_db(db)
    before, _ = table(db)
    conn = sqlite3.connect(db, isolation_level=None)
    conn.execute("BEGIN")
    core.refuse_unreviewed_national_years(conn)
    core.correct_national_rape(conn)
    conn.execute("COMMIT")
    conn.close()
    after, prov = table(db)
    for y in range(2017, 2025):
        a, b = after[("United States", y)], before[("United States", y)]
        delta = T1[str(y)]["rape"] - b["rape"]
        check(a["rape"] == T1[str(y)]["rape"], f"P1: {y} rape = Table 1 ({a['rape']})")
        check(abs(a["rape_rate"] - a["rape"] * 100000.0 / a["population"]) < 1e-9, f"P1: {y} rape_rate by the formula")
        check(a["total_offenses"] == b["total_offenses"] + delta, f"P1: {y} total_offenses moved by exactly the delta {delta}")
        check(abs(a["total_offenses_rate"] - a["total_offenses"] * 100000.0 / a["population"]) < 1e-9, f"P1: {y} total_offenses_rate by the formula")
        others = [c for c in COLS if c not in ("rape", "rape_rate", "total_offenses", "total_offenses_rate")]
        check(all(a[c] == b[c] for c in others), f"P1: {y} every other column unchanged")
    a24 = after[("United States", 2024)]
    parts = sum(a24[c] for c in ("murder", "rape", "robbery", "aggravated_assault", "burglary", "theft", "auto_theft"))
    check(a24["total_offenses"] - parts == 640, f"P1: the 2024 residual of 640 is preserved ({a24['total_offenses'] - parts})")
    check(after[("United States", 2016)] == before[("United States", 2016)], "P1: 2016 untouched")
    check(after[("Texas", 2018)] == before[("Texas", 2018)] and after[("Texas", 2016)] == before[("Texas", 2016)], "P1: state rows untouched")
    check(prov is not None and len(prov) == 1 and "551f29bd" in json.dumps(prov), f"P1: the marker table holds one provenance row with the source sha256 ({prov})")
    # P5
    conn = sqlite3.connect(db, isolation_level=None)
    conn.execute("BEGIN")
    core.correct_national_rape(conn)
    conn.execute("COMMIT")
    conn.close()
    again, prov2 = table(db)
    check(again == after and len(prov2) == 1, "P5: a second run changes nothing")
    # P3
    db3 = os.path.join(tmp, "p3.db")
    make_db(db3, lambda rows: rows + [row("United States", 2025, (341784857, 14085, 123332, 168927, 813424, 661800, 3910502, 673466, 6366536))])
    conn = sqlite3.connect(db3)
    try:
        core.refuse_unreviewed_national_years(conn)
        refused = False
    except core.NationalRapeCorrectionError as exc:
        refused = "2025" in str(exc)
    conn.close()
    check(refused, "P3: a US year after 2024 is refused, naming the year")


def p2():
    def drop(year):
        return lambda rows: [r for r in rows if not (r[0] == "United States" and r[1] == year)]

    def pop_off(rows):
        return [row("United States", 2019, (PROD[2019][0] + 1,) + PROD[2019][1:]) if (r[0] == "United States" and r[1] == 2019) else r for r in rows]

    def offense_off(rows):
        v = list(PROD[2020])
        v[5] = int(v[5] * 1.07)  # burglary 7% above Table 1's
        return [row("United States", 2020, tuple(v)) if (r[0] == "United States" and r[1] == 2020) else r for r in rows]

    cases = [("a missing US year (2022)", drop(2022), None), ("a population mismatch (2019)", pop_off, None),
             ("an offense 7% off Table 1 (2020 burglary)", offense_off, None), ("two US rows for one year", None, "dup")]
    for i, (name, mutate, kind) in enumerate(cases):
        db = os.path.join(tmp, f"p2-{i}.db")
        if kind == "dup":
            # PRIMARY KEY (state, year) forbids a duplicate, so the duplicate comes from a case-variant name.
            make_db(db, lambda rows: rows + [row("UNITED STATES", 2018, PROD[2018])])
        else:
            make_db(db, mutate)
        before, _ = table(db)
        conn = sqlite3.connect(db, isolation_level=None)
        conn.execute("BEGIN")
        try:
            core.correct_national_rape(conn)
            raised = False
        except core.NationalRapeCorrectionError:
            raised = True
        conn.execute("ROLLBACK")
        conn.close()
        after, prov = table(db)
        check(raised and after == before and prov is None, f"P2: {name} -> refused, no change")


def p4():
    imp = load("import_historical", "import_historical.py")
    import pandas as pd
    wb = os.path.join(tmp, "State_National_Historical.xlsx")
    recs = []
    for (state, year, *vals) in [row("United States", y, v) for y, v in PROD.items()] + [row("Texas", 2018, (28701845, 1322, 15098, 29599, 74151, 117931, 525287, 69185, 832573))]:
        d = dict(zip(COLS, [state, year] + vals))
        d["murder_and_nonnegligent_manslaughter"] = d.pop("murder")
        d["murder_and_nonnegligent_manslaughter_rate"] = d.pop("murder_rate")
        d["table"] = None
        d["file"] = None
        recs.append(d)
    pd.DataFrame(recs).to_excel(wb, index=False)
    db = os.path.join(tmp, "p4.db")
    conn = sqlite3.connect(db)
    imp.load_state_national(conn, wb)
    in_txn = conn.in_transaction
    conn.commit()
    conn.close()
    after, prov = table(db)
    check(in_txn, "P4: load_state_national leaves its work uncommitted (the caller commits)")
    check(after[("United States", 2018)]["rape"] == 144505 and after[("United States", 2016)]["rape"] == 91428 and prov,
          f"P4: the importer's own step applies the correction ({after[('United States', 2018)]['rape']})")
    src = open(os.path.join(HERE, "import_historical.py"), encoding="utf-8").read()
    tree = ast.parse(src)
    main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
    calls = [(n.lineno, n.func.attr if isinstance(n.func, ast.Attribute) else getattr(n.func, "id", "")) for n in ast.walk(main) if isinstance(n, ast.Call)]
    load_line = min((ln for ln, name in calls if name == "load_state_national"), default=None)
    commit_line = max((ln for ln, name in calls if name == "commit"), default=None)
    check(load_line is not None and commit_line is not None and load_line < commit_line, f"P4: main() calls load_state_national before its final commit ({load_line} < {commit_line})")
    check("--state-workbook" in src and "DATA_DIR" not in src, "P4 (amendment 1): --state-workbook replaces the undefined DATA_DIR")


def p6_p7():
    script = os.path.join(HERE, "correct-historical-national-rape.py")
    fix = load("correct_hnr", "correct-historical-national-rape.py")
    db = os.path.join(tmp, "p6.db")
    make_db(db)
    before = table(db)
    p = subprocess.run([sys.executable, script, "--db", db], capture_output=True, text=True)
    check(p.returncode != 0 and table(db) == before, f"P6: no --backup is refused (exit {p.returncode})")
    orig = fix.verify_backup
    fix.verify_backup = lambda s, d: False
    try:
        code = fix.run(db, os.path.join(tmp, "p6a.bak"))
    finally:
        fix.verify_backup = orig
    check(code == fix.EXIT_BACKUP and table(db) == before, f"P6: a backup that fails its check stops the run (exit {code})")

    def failing(conn):
        core.correct_national_rape(conn)
        raise RuntimeError("injected failure")
    code = fix.run(db, os.path.join(tmp, "p6b.bak"), correct=failing)
    check(code == fix.EXIT_FAILED and table(db) == before, f"P6: an injected failure rolls back (exit {code})")

    def committing(conn):
        core.correct_national_rape(conn)
        conn.execute("COMMIT")
    code = fix.run(db, os.path.join(tmp, "p6c.bak"), correct=committing)
    check(code == fix.EXIT_FAILED and table(db) == before, f"P6: an early commit is a failure and is restored from the backup (exit {code})")

    lock = os.path.join(tmp, "held.lock")
    open(lock, "w").close()
    code = fix.run(db, os.path.join(tmp, "p6d.bak"), lock_path=lock)
    check(code == fix.EXIT_BUSY and table(db) == before and os.path.exists(lock) and not os.path.exists(os.path.join(tmp, "p6d.bak")),
          f"P6: a held lock gives busy, nothing touched (exit {code})")

    for name, sql in (("a murder value", "UPDATE historical_state_national SET murder = murder + 1 WHERE state = 'United States' AND year = 2018"),
                      ("a state row", "UPDATE historical_state_national SET rape = rape + 1 WHERE state = 'Texas' AND year = 2018"),
                      ("a pre-2017 national row", "UPDATE historical_state_national SET rape = 1 WHERE state = 'United States' AND year = 2016")):
        code = fix.run(db, os.path.join(tmp, f"p7-{len(name)}.bak"), after_updates=lambda c, s=sql: c.execute(s))
        check(code == fix.EXIT_FAILED and table(db) == before, f"P7: a change to {name} is caught and rolled back (exit {code})")

    code = fix.run(db, os.path.join(tmp, "p6e.bak"))
    check(code == fix.EXIT_OK and table(db)[0][("United States", 2018)]["rape"] == 144505, f"P6: the real run commits (exit {code})")


for _n, _f in (("P1/P3/P5", p1_p3_p5), ("P2", p2), ("P4", p4), ("P6/P7", p6_p7)):
    guarded(_n, _f)

print(f"\n{checks - failures}/{checks} passed")
sys.exit(1 if failures else 0)
