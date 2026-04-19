"""
Build carjacking demographic summary tables:
  - summary_carjacking_victim_demographics
  - summary_carjacking_offender_demographics
  - summary_carjacking_arrestee_demographics

Strategy: first materialize a temp table of carjacking incidents with one weapon
per incident (avoids cartesian product from multiple code-120 offenses per incident),
then JOIN victims/offenders/arrestees to that temp table.

Run on VPS:
  cd /opt/nibrs/app && python3 scripts/build_carjacking_demographics.py
"""
import sqlite3
import time

DB_PATH = "/opt/nibrs/nibrs.db"

WEAPON_CATEGORY_SQL = """
CASE
    WHEN {col} IN ('11','12','13','14','15') THEN 'Firearm'
    WHEN {col} = '20' THEN 'Knife'
    WHEN {col} = '30' THEN 'Blunt Object'
    WHEN {col} IN ('95','99','') OR {col} IS NULL THEN 'Unknown'
    ELSE 'Other'
END
"""

AGE_GROUP_SQL = """
CASE
    WHEN CAST({col} AS INTEGER) < 18 THEN 'Under 18'
    WHEN CAST({col} AS INTEGER) BETWEEN 18 AND 24 THEN '18-24'
    WHEN CAST({col} AS INTEGER) BETWEEN 25 AND 34 THEN '25-34'
    WHEN CAST({col} AS INTEGER) BETWEEN 35 AND 44 THEN '35-44'
    WHEN CAST({col} AS INTEGER) BETWEEN 45 AND 54 THEN '45-54'
    WHEN CAST({col} AS INTEGER) BETWEEN 55 AND 64 THEN '55-64'
    WHEN CAST({col} AS INTEGER) >= 65 THEN '65+'
    ELSE 'Unknown'
END
"""


def build_carjacking_temp(conn):
    """Materialize carjacking incidents with one weapon per incident into a temp table."""
    print("=== Building temp carjacking incidents table ===")
    t0 = time.time()
    cur = conn.cursor()

    cur.execute("DROP TABLE IF EXISTS _tmp_carjacking_incidents")
    conn.commit()

    # One row per carjacking incident with the weapon from the first code-120 offense.
    # GROUP BY ensures one row even if multiple 120 offenses exist per incident.
    cur.execute("""
        CREATE TABLE _tmp_carjacking_incidents AS
        SELECT o.ori, o.incident_num, o.year, MIN(o.type_weapon_1) AS weapon
        FROM offenses o
        WHERE o.ucr_offense_code = '120'
          AND EXISTS (
            SELECT 1 FROM property p
            WHERE p.ori = o.ori AND p.incident_num = o.incident_num AND p.year = o.year
              AND p.type_property_loss = '7'
              AND p.property_description IN ('03','05','24','28','37')
          )
        GROUP BY o.ori, o.incident_num, o.year
    """)
    rows = cur.rowcount
    conn.commit()

    cur.execute("CREATE UNIQUE INDEX idx_tmp_cj ON _tmp_carjacking_incidents(ori, incident_num, year)")
    conn.commit()

    elapsed = time.time() - t0
    print(f"  {rows:,} carjacking incidents in {elapsed:.1f}s")
    return rows


def build_victim_table(conn):
    print("\n=== Building summary_carjacking_victim_demographics ===")
    t0 = time.time()
    cur = conn.cursor()

    cur.execute("DROP TABLE IF EXISTS summary_carjacking_victim_demographics")
    conn.commit()

    weapon_cat = WEAPON_CATEGORY_SQL.format(col="cj.weapon")
    age_grp = AGE_GROUP_SQL.format(col="v.age")

    cur.execute(f"""
        CREATE TABLE summary_carjacking_victim_demographics AS
        SELECT
            v.ori, v.year,
            {weapon_cat} AS weapon_category,
            COALESCE(NULLIF(v.race, ''), 'U') AS race,
            COALESCE(NULLIF(v.sex, ''), 'U') AS sex,
            {age_grp} AS age_group,
            COUNT(*) AS victim_count,
            v.state
        FROM victims v
        INNER JOIN _tmp_carjacking_incidents cj
            ON v.ori = cj.ori AND v.incident_num = cj.incident_num AND v.year = cj.year
        WHERE v.victim_type = 'I'
        GROUP BY v.ori, v.year, weapon_category, race, sex, age_group, v.state
    """)
    rows = cur.rowcount
    conn.commit()

    cur.execute("CREATE INDEX idx_scvd_ori_year ON summary_carjacking_victim_demographics(ori, year)")
    cur.execute("CREATE INDEX idx_scvd_state_year ON summary_carjacking_victim_demographics(state, year)")
    cur.execute("CREATE INDEX idx_scvd_year ON summary_carjacking_victim_demographics(year)")
    conn.commit()

    elapsed = time.time() - t0
    print(f"  {rows:,} rows in {elapsed:.1f}s")


def build_offender_table(conn):
    print("\n=== Building summary_carjacking_offender_demographics ===")
    t0 = time.time()
    cur = conn.cursor()

    cur.execute("DROP TABLE IF EXISTS summary_carjacking_offender_demographics")
    conn.commit()

    weapon_cat = WEAPON_CATEGORY_SQL.format(col="cj.weapon")
    age_grp = AGE_GROUP_SQL.format(col="off.age")

    cur.execute(f"""
        CREATE TABLE summary_carjacking_offender_demographics AS
        SELECT
            off.ori, off.year,
            {weapon_cat} AS weapon_category,
            COALESCE(NULLIF(off.race, ''), 'U') AS race,
            COALESCE(NULLIF(off.sex, ''), 'U') AS sex,
            {age_grp} AS age_group,
            COUNT(*) AS offender_count,
            off.state
        FROM offenders off
        INNER JOIN _tmp_carjacking_incidents cj
            ON off.ori = cj.ori AND off.incident_num = cj.incident_num AND off.year = cj.year
        GROUP BY off.ori, off.year, weapon_category, race, sex, age_group, off.state
    """)
    rows = cur.rowcount
    conn.commit()

    cur.execute("CREATE INDEX idx_scod_ori_year ON summary_carjacking_offender_demographics(ori, year)")
    cur.execute("CREATE INDEX idx_scod_state_year ON summary_carjacking_offender_demographics(state, year)")
    cur.execute("CREATE INDEX idx_scod_year ON summary_carjacking_offender_demographics(year)")
    conn.commit()

    elapsed = time.time() - t0
    print(f"  {rows:,} rows in {elapsed:.1f}s")


def build_arrestee_table(conn):
    print("\n=== Building summary_carjacking_arrestee_demographics ===")
    t0 = time.time()
    cur = conn.cursor()

    cur.execute("DROP TABLE IF EXISTS summary_carjacking_arrestee_demographics")
    conn.commit()

    # Arrestees have their own weapon field
    weapon_cat = WEAPON_CATEGORY_SQL.format(col="a.arrestee_weapon_1")
    age_grp = AGE_GROUP_SQL.format(col="a.age")

    cur.execute(f"""
        CREATE TABLE summary_carjacking_arrestee_demographics AS
        SELECT
            a.ori, a.year,
            {weapon_cat} AS weapon_category,
            COALESCE(NULLIF(a.race, ''), 'U') AS race,
            COALESCE(NULLIF(a.sex, ''), 'U') AS sex,
            {age_grp} AS age_group,
            COUNT(*) AS arrestee_count,
            a.state
        FROM arrestees a
        INNER JOIN _tmp_carjacking_incidents cj
            ON a.ori = cj.ori AND a.incident_num = cj.incident_num AND a.year = cj.year
        GROUP BY a.ori, a.year, weapon_category, race, sex, age_group, a.state
    """)
    rows = cur.rowcount
    conn.commit()

    cur.execute("CREATE INDEX idx_scad_ori_year ON summary_carjacking_arrestee_demographics(ori, year)")
    cur.execute("CREATE INDEX idx_scad_state_year ON summary_carjacking_arrestee_demographics(state, year)")
    cur.execute("CREATE INDEX idx_scad_year ON summary_carjacking_arrestee_demographics(year)")
    conn.commit()

    elapsed = time.time() - t0
    print(f"  {rows:,} rows in {elapsed:.1f}s")


def verify(conn):
    print("\n=== Verification ===")
    cur = conn.cursor()

    for tbl, col in [
        ("summary_carjacking_victim_demographics", "victim_count"),
        ("summary_carjacking_offender_demographics", "offender_count"),
        ("summary_carjacking_arrestee_demographics", "arrestee_count"),
    ]:
        cur.execute(f"SELECT COUNT(*) FROM {tbl}")
        rows = cur.fetchone()[0]
        cur.execute(f"SELECT SUM({col}) FROM {tbl}")
        total = cur.fetchone()[0]
        cur.execute(f"SELECT MIN(year), MAX(year) FROM {tbl}")
        min_yr, max_yr = cur.fetchone()
        print(f"  {tbl}: {rows:,} rows, {total:,} total, years {min_yr}-{max_yr}")

    cur.execute("SELECT SUM(offense_count) FROM summary_carjacking_monthly")
    total_offenses = cur.fetchone()[0]
    print(f"\n  Total carjacking offenses (monthly table): {total_offenses:,}")

    # Houston sanity check: offenders vs offenses per year
    cur.execute("""
        SELECT d.year, SUM(d.offender_count) AS offenders
        FROM summary_carjacking_offender_demographics d
        WHERE d.ori IN (
            SELECT ori FROM agencies WHERE city = 'HOUSTON' AND state = 'TX'
            AND pop_group LIKE '1%' AND year = 2024
        ) AND d.year BETWEEN 2020 AND 2025
        GROUP BY d.year ORDER BY d.year
    """)
    print("\n  Houston carjacking offenders per year:")
    for row in cur.fetchall():
        print(f"    {row[0]}: {row[1]:,}")

    cur.execute("""
        SELECT year, SUM(offense_count) AS offenses
        FROM summary_carjacking_monthly
        WHERE ori IN (
            SELECT ori FROM agencies WHERE city = 'HOUSTON' AND state = 'TX'
            AND pop_group LIKE '1%' AND year = 2024
        ) AND year BETWEEN 2020 AND 2025
        GROUP BY year ORDER BY year
    """)
    print("\n  Houston carjacking offenses per year (comparison):")
    for row in cur.fetchall():
        print(f"    {row[0]}: {row[1]:,}")

    # Cleanup temp table
    cur.execute("DROP TABLE IF EXISTS _tmp_carjacking_incidents")
    conn.commit()
    print("\n  Temp table cleaned up.")


def main():
    print("Connecting to", DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=60000")
    conn.execute("PRAGMA cache_size=-2000000")

    build_carjacking_temp(conn)
    build_victim_table(conn)
    build_offender_table(conn)
    build_arrestee_table(conn)
    verify(conn)

    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
