"""
Fixture tests for build_vccd.py and build_vcd.py.

Validates:
1. Duplicated connected slots do not double-count
2. Arrest clearance only applies when ucr_arrest_offense matches the offense code
3. VCCD excludes person crimes without circumstance
4. VCD includes all 15 person crimes without requiring circumstance
"""

import sqlite3
import os
import sys
import tempfile
import importlib.util

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def load_builder(name):
    """Import a builder module by filename."""
    path = os.path.join(SCRIPT_DIR, name)
    spec = importlib.util.spec_from_file_location(name.replace('.py', ''), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def create_fixture_db(path):
    """Create a small NIBRS fixture DB with controlled test data."""
    conn = sqlite3.connect(path)

    # -- victims --
    conn.execute("""
        CREATE TABLE victims (
            state TEXT, ori TEXT, year INT, incident_num TEXT,
            connected_offense_1 TEXT, connected_offense_2 TEXT, connected_offense_3 TEXT,
            aggravated_assault_homicide_1 TEXT,
            sex TEXT, race TEXT, age TEXT, ethnicity TEXT, victim_type TEXT
        )
    """)

    # -- offenses --
    conn.execute("""
        CREATE TABLE offenses (
            state TEXT, ori TEXT, year INT, incident_num TEXT,
            ucr_offense_code TEXT, type_weapon_1 TEXT
        )
    """)

    # -- incidents --
    conn.execute("""
        CREATE TABLE incidents (
            state TEXT, ori TEXT, year INT, incident_num TEXT,
            cleared_exceptionally TEXT, incident_date TEXT
        )
    """)

    # -- arrestees --
    conn.execute("""
        CREATE TABLE arrestees (
            state TEXT, ori TEXT, year INT, incident_num TEXT,
            ucr_arrest_offense TEXT, sex TEXT, race TEXT, age TEXT,
            ethnicity TEXT, arrestee_weapon_1 TEXT
        )
    """)

    # ================================================================
    # TEST CASE 1: Duplicate connected slots
    # Victim V1 has 13A in both connected_offense_1 AND connected_offense_2.
    # Should count as ONE victim/offense pair, not two.
    # ================================================================
    conn.execute("""
        INSERT INTO victims VALUES
        ('TX','TX001',2023,'INC001','13A','13A',NULL,'01','M','W','30',NULL,'I')
    """)
    conn.execute("""
        INSERT INTO offenses VALUES
        ('TX','TX001',2023,'INC001','13A','11')
    """)
    conn.execute("""
        INSERT INTO incidents VALUES
        ('TX','TX001',2023,'INC001','N','20230115')
    """)
    # No arrestee for INC001 -> not_cleared

    # ================================================================
    # TEST CASE 2: Arrest clearance per-offense matching
    # Incident INC002 has both 09A and 13A offenses.
    # Arrestee is for 09A only. 09A victim should be 'arrest', 13A should be 'not_cleared'.
    # ================================================================
    # Victim V2: connected to 09A
    conn.execute("""
        INSERT INTO victims VALUES
        ('TX','TX001',2023,'INC002','09A',NULL,NULL,'02','F','B','25',NULL,'I')
    """)
    # Victim V3: connected to 13A
    conn.execute("""
        INSERT INTO victims VALUES
        ('TX','TX001',2023,'INC002','13A',NULL,NULL,'01','M','W','35',NULL,'I')
    """)
    conn.execute("""
        INSERT INTO offenses VALUES
        ('TX','TX001',2023,'INC002','09A','12')
    """)
    conn.execute("""
        INSERT INTO offenses VALUES
        ('TX','TX001',2023,'INC002','13A','20')
    """)
    conn.execute("""
        INSERT INTO incidents VALUES
        ('TX','TX001',2023,'INC002','N','20230220')
    """)
    # Arrestee for 09A ONLY
    conn.execute("""
        INSERT INTO arrestees VALUES
        ('TX','TX001',2023,'INC002','09A','M','W','28',NULL,'11')
    """)

    # ================================================================
    # TEST CASE 3: VCCD excludes person crimes without circumstance
    # Victim V4: connected to 11A (rape) — has no valid circumstance.
    # Should appear in VCD but NOT in VCCD.
    # ================================================================
    conn.execute("""
        INSERT INTO victims VALUES
        ('TX','TX001',2023,'INC003','11A',NULL,NULL,NULL,'F','W','22',NULL,'I')
    """)
    conn.execute("""
        INSERT INTO offenses VALUES
        ('TX','TX001',2023,'INC003','11A','40')
    """)
    conn.execute("""
        INSERT INTO incidents VALUES
        ('TX','TX001',2023,'INC003','N','20230310')
    """)

    # ================================================================
    # TEST CASE 4: VCD includes all person crimes
    # Add victims for several non-assault/homicide person crimes.
    # ================================================================
    # 11B sodomy
    conn.execute("INSERT INTO victims VALUES ('TX','TX001',2023,'INC004','11B',NULL,NULL,NULL,'F','W','19',NULL,'I')")
    conn.execute("INSERT INTO offenses VALUES ('TX','TX001',2023,'INC004','11B','40')")
    conn.execute("INSERT INTO incidents VALUES ('TX','TX001',2023,'INC004','N','20230401')")

    # 13B simple assault
    conn.execute("INSERT INTO victims VALUES ('TX','TX001',2023,'INC005','13B',NULL,NULL,NULL,'M','B','40',NULL,'I')")
    conn.execute("INSERT INTO offenses VALUES ('TX','TX001',2023,'INC005','13B','40')")
    conn.execute("INSERT INTO incidents VALUES ('TX','TX001',2023,'INC005','N','20230501')")

    # 100 kidnapping
    conn.execute("INSERT INTO victims VALUES ('TX','TX001',2023,'INC006','100',NULL,NULL,NULL,'F','A','15',NULL,'I')")
    conn.execute("INSERT INTO offenses VALUES ('TX','TX001',2023,'INC006','100','40')")
    conn.execute("INSERT INTO incidents VALUES ('TX','TX001',2023,'INC006','N','20230601')")

    # 36A incest
    conn.execute("INSERT INTO victims VALUES ('TX','TX001',2023,'INC007','36A',NULL,NULL,NULL,'F','W','14',NULL,'I')")
    conn.execute("INSERT INTO offenses VALUES ('TX','TX001',2023,'INC007','36A','99')")
    conn.execute("INSERT INTO incidents VALUES ('TX','TX001',2023,'INC007','N','20230701')")

    # ================================================================
    # TEST CASE 5: Exceptional clearance
    # Victim V8: 09A murder, cleared exceptionally (code B = prosecution declined).
    # ================================================================
    conn.execute("""
        INSERT INTO victims VALUES
        ('TX','TX001',2023,'INC008','09A',NULL,NULL,'03','M','H','55',NULL,'I')
    """)
    conn.execute("""
        INSERT INTO offenses VALUES
        ('TX','TX001',2023,'INC008','09A','11')
    """)
    conn.execute("""
        INSERT INTO incidents VALUES
        ('TX','TX001',2023,'INC008','B','20230815')
    """)

    conn.commit()
    conn.close()


def run_builder(builder_mod, input_db, output_db, connected_slots='1-3'):
    """Run a builder against the fixture, capturing its main() with patched sys.argv."""
    old_argv = sys.argv
    sys.argv = [
        'test',
        '--input', input_db,
        '--output', output_db,
        '--years', '2023',
        '--per-offense',
        '--connected-slots', connected_slots,
    ]
    # Suppress stdout
    old_stdout = sys.stdout
    sys.stdout = open(os.devnull, 'w')
    try:
        builder_mod.main()
    finally:
        sys.stdout.close()
        sys.stdout = old_stdout
        sys.argv = old_argv


def test_vccd():
    """Test build_vccd.py against fixture."""
    vccd = load_builder('build_vccd.py')

    with tempfile.TemporaryDirectory() as tmpdir:
        input_db = os.path.join(tmpdir, 'nibrs.db')
        output_db = os.path.join(tmpdir, 'vccd.db')
        create_fixture_db(input_db)
        run_builder(vccd, input_db, output_db)

        conn = sqlite3.connect(output_db)
        conn.execute(f"ATTACH DATABASE ? AS nibrs", (input_db,))

        # -- Test 1: Duplicate connected slots do not double-count --
        row = conn.execute("""
            SELECT SUM(victim_count) FROM summary_victim_circumstance_clearance_demo
            WHERE year=2023 AND ucr_offense_code='13A' AND ori='TX001'
            AND circumstance_code='01'
        """).fetchone()
        v1_count = row[0] or 0
        # INC001 victim + INC002 13A victim = 2 victims with circumstance 01
        # But INC001 has 13A in slots 1 AND 2 — must not double-count
        assert v1_count == 2, f"TEST 1 FAIL (VCCD): duplicate slots double-counted. Expected 2, got {v1_count}"
        print("  VCCD Test 1 PASS: duplicate connected slots not double-counted")

        # -- Test 2: Arrest clearance per-offense --
        rows = conn.execute("""
            SELECT ucr_offense_code, clearance_status, SUM(victim_count)
            FROM summary_victim_circumstance_clearance_demo
            WHERE year=2023 AND ori='TX001'
            AND ucr_offense_code IN ('09A','13A')
            GROUP BY ucr_offense_code, clearance_status
            ORDER BY ucr_offense_code, clearance_status
        """).fetchall()
        clearance_map = {(r[0], r[1]): r[2] for r in rows}
        # 09A victim in INC002 should be 'arrest' (arrestee matches 09A)
        assert clearance_map.get(('09A', 'arrest'), 0) >= 1, \
            f"TEST 2 FAIL (VCCD): 09A should have arrest clearance. Got: {clearance_map}"
        # 13A victim in INC002 should be 'not_cleared' (arrestee is for 09A, not 13A)
        assert clearance_map.get(('13A', 'arrest'), 0) == 0, \
            f"TEST 2 FAIL (VCCD): 13A should NOT have arrest clearance. Got: {clearance_map}"
        print("  VCCD Test 2 PASS: arrest clearance matched per-offense")

        # -- Test 3: VCCD excludes person crimes without circumstance --
        rape_count = conn.execute("""
            SELECT COUNT(*) FROM summary_victim_circumstance_clearance_demo
            WHERE ucr_offense_code='11A'
        """).fetchone()[0]
        assert rape_count == 0, f"TEST 3 FAIL (VCCD): 11A should be excluded. Got {rape_count} rows"
        print("  VCCD Test 3 PASS: 11A (no circumstance) excluded from VCCD")

        # -- Test 4: Only 09A/09B/09C/13A in VCCD --
        codes = conn.execute("""
            SELECT DISTINCT ucr_offense_code FROM summary_victim_circumstance_clearance_demo
            ORDER BY ucr_offense_code
        """).fetchall()
        code_set = {r[0] for r in codes}
        allowed = {'09A', '09B', '09C', '13A'}
        assert code_set <= allowed, f"TEST 4 FAIL (VCCD): unexpected codes {code_set - allowed}"
        print(f"  VCCD Test 4 PASS: only {sorted(code_set)} in VCCD")

        # -- Test 5: Exceptional clearance --
        exc = conn.execute("""
            SELECT clearance_status FROM summary_victim_circumstance_clearance_demo
            WHERE year=2023 AND ucr_offense_code='09A' AND circumstance_code='03'
        """).fetchone()
        assert exc and exc[0] == 'exceptional', \
            f"TEST 5 FAIL (VCCD): expected exceptional clearance, got {exc}"
        print("  VCCD Test 5 PASS: exceptional clearance detected")

        conn.close()


def test_vcd():
    """Test build_vcd.py against fixture."""
    vcd = load_builder('build_vcd.py')

    with tempfile.TemporaryDirectory() as tmpdir:
        input_db = os.path.join(tmpdir, 'nibrs.db')
        output_db = os.path.join(tmpdir, 'vcd.db')
        create_fixture_db(input_db)
        run_builder(vcd, input_db, output_db)

        conn = sqlite3.connect(output_db)

        # -- Test 1: Duplicate connected slots do not double-count --
        row = conn.execute("""
            SELECT SUM(victim_count) FROM summary_victim_clearance_demographics
            WHERE year=2023 AND ucr_offense_code='13A' AND ori='TX001'
        """).fetchone()
        v_13a = row[0] or 0
        # INC001 (13A in slots 1+2, should be 1 victim) + INC002 (13A victim) = 2
        assert v_13a == 2, f"TEST 1 FAIL (VCD): duplicate slots double-counted. Expected 2, got {v_13a}"
        print("  VCD  Test 1 PASS: duplicate connected slots not double-counted")

        # -- Test 2: Arrest clearance per-offense --
        rows = conn.execute("""
            SELECT ucr_offense_code, clearance_status, SUM(victim_count)
            FROM summary_victim_clearance_demographics
            WHERE year=2023 AND ori='TX001'
            AND ucr_offense_code IN ('09A','13A')
            GROUP BY ucr_offense_code, clearance_status
            ORDER BY ucr_offense_code, clearance_status
        """).fetchall()
        clearance_map = {(r[0], r[1]): r[2] for r in rows}
        assert clearance_map.get(('09A', 'arrest'), 0) >= 1, \
            f"TEST 2 FAIL (VCD): 09A should have arrest clearance. Got: {clearance_map}"
        assert clearance_map.get(('13A', 'arrest'), 0) == 0, \
            f"TEST 2 FAIL (VCD): 13A should NOT have arrest clearance. Got: {clearance_map}"
        print("  VCD  Test 2 PASS: arrest clearance matched per-offense")

        # -- Test 3: VCD includes 11A (no circumstance required) --
        rape_count = conn.execute("""
            SELECT SUM(victim_count) FROM summary_victim_clearance_demographics
            WHERE ucr_offense_code='11A'
        """).fetchone()[0] or 0
        assert rape_count >= 1, f"TEST 3 FAIL (VCD): 11A should be included. Got {rape_count}"
        print("  VCD  Test 3 PASS: 11A included (no circumstance required)")

        # -- Test 4: VCD includes all person crimes from fixture --
        codes = conn.execute("""
            SELECT DISTINCT ucr_offense_code FROM summary_victim_clearance_demographics
            ORDER BY ucr_offense_code
        """).fetchall()
        code_set = {r[0] for r in codes}
        expected = {'09A', '11A', '11B', '13A', '13B', '100', '36A'}
        assert expected <= code_set, \
            f"TEST 4 FAIL (VCD): missing codes {expected - code_set}. Got {code_set}"
        print(f"  VCD  Test 4 PASS: all fixture person crimes present: {sorted(code_set)}")

        # -- Test 5: No circumstance_code column in VCD --
        cols = [row[1] for row in conn.execute(
            "PRAGMA table_info(summary_victim_clearance_demographics)"
        ).fetchall()]
        assert 'circumstance_code' not in cols, \
            f"TEST 5 FAIL (VCD): circumstance_code should not be in schema. Got: {cols}"
        print("  VCD  Test 5 PASS: no circumstance_code in schema")

        # -- Test 6: Exceptional clearance --
        exc = conn.execute("""
            SELECT clearance_status FROM summary_victim_clearance_demographics
            WHERE year=2023 AND ucr_offense_code='09A' AND sex='M' AND race='H'
        """).fetchone()
        assert exc and exc[0] == 'exceptional', \
            f"TEST 6 FAIL (VCD): expected exceptional clearance, got {exc}"
        print("  VCD  Test 6 PASS: exceptional clearance detected")

        conn.close()


if __name__ == '__main__':
    print("=== VCCD Tests (summary_victim_circumstance_clearance_demo) ===")
    test_vccd()
    print("\n=== VCD Tests (summary_victim_clearance_demographics) ===")
    test_vcd()
    print("\nAll tests passed.")
