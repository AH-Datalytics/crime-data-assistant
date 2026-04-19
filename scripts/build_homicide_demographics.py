"""
Build pre-aggregated homicide demographic summary tables in NIBRS.
Creates 3 tables:
  - summary_homicide_victim: victim demographics by year
  - summary_homicide_offender: offender demographics by year
  - summary_homicide_victim_offender: victim race x offender race cross-tab by year
"""
import sqlite3
import time

DB_PATH = "/opt/nibrs/nibrs.db"

def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA cache_size=-256000")
    conn.execute("PRAGMA temp_store=MEMORY")
    return conn

def main():
    conn = connect()
    cur = conn.cursor()

    # Step 1: Build temp table of homicide incidents (offense = '09A')
    print("Building temp homicide incidents table...")
    t0 = time.time()
    cur.execute("DROP TABLE IF EXISTS _tmp_homicide_incidents")
    cur.execute("""
        CREATE TABLE _tmp_homicide_incidents AS
        SELECT DISTINCT o.year, o.state, o.ori, o.incident_num, o.incident_date,
            MIN(o.type_weapon_1) as weapon
        FROM offenses o
        WHERE o.ucr_offense_code = '09A'
        GROUP BY o.year, o.state, o.ori, o.incident_num, o.incident_date
    """)
    cur.execute("CREATE INDEX idx_tmp_hom ON _tmp_homicide_incidents(year, ori, incident_num)")
    count = cur.execute("SELECT COUNT(*) FROM _tmp_homicide_incidents").fetchone()[0]
    print(f"  {count:,} homicide incidents in {time.time()-t0:.1f}s")

    # Step 2: summary_homicide_victim
    print("Building summary_homicide_victim...")
    t0 = time.time()
    cur.execute("DROP TABLE IF EXISTS summary_homicide_victim")
    cur.execute("""
        CREATE TABLE summary_homicide_victim AS
        SELECT
            h.year,
            CASE v.race
                WHEN 'W' THEN 'White'
                WHEN 'B' THEN 'Black'
                WHEN 'A' THEN 'Asian'
                WHEN 'I' THEN 'American Indian'
                WHEN 'P' THEN 'Pacific Islander'
                ELSE 'Unknown'
            END as victim_race,
            CASE v.sex
                WHEN 'M' THEN 'Male'
                WHEN 'F' THEN 'Female'
                ELSE 'Unknown'
            END as victim_sex,
            CASE
                WHEN v.age < 18 THEN 'Under 18'
                WHEN v.age BETWEEN 18 AND 24 THEN '18-24'
                WHEN v.age BETWEEN 25 AND 34 THEN '25-34'
                WHEN v.age BETWEEN 35 AND 44 THEN '35-44'
                WHEN v.age BETWEEN 45 AND 54 THEN '45-54'
                WHEN v.age BETWEEN 55 AND 64 THEN '55-64'
                WHEN v.age >= 65 THEN '65+'
                ELSE 'Unknown'
            END as victim_age_group,
            COUNT(*) as victim_count
        FROM _tmp_homicide_incidents h
        JOIN victims v ON v.year = h.year AND v.ori = h.ori AND v.incident_num = h.incident_num
        WHERE v.victim_type = 'I'
        GROUP BY h.year, victim_race, victim_sex, victim_age_group
    """)
    count = cur.execute("SELECT COUNT(*) FROM summary_homicide_victim").fetchone()[0]
    print(f"  {count:,} rows in {time.time()-t0:.1f}s")

    # Step 3: summary_homicide_offender
    print("Building summary_homicide_offender...")
    t0 = time.time()
    cur.execute("DROP TABLE IF EXISTS summary_homicide_offender")
    cur.execute("""
        CREATE TABLE summary_homicide_offender AS
        SELECT
            h.year,
            CASE off.race
                WHEN 'W' THEN 'White'
                WHEN 'B' THEN 'Black'
                WHEN 'A' THEN 'Asian'
                WHEN 'I' THEN 'American Indian'
                WHEN 'P' THEN 'Pacific Islander'
                ELSE 'Unknown'
            END as offender_race,
            CASE off.sex
                WHEN 'M' THEN 'Male'
                WHEN 'F' THEN 'Female'
                ELSE 'Unknown'
            END as offender_sex,
            CASE
                WHEN off.age < 18 THEN 'Under 18'
                WHEN off.age BETWEEN 18 AND 24 THEN '18-24'
                WHEN off.age BETWEEN 25 AND 34 THEN '25-34'
                WHEN off.age BETWEEN 35 AND 44 THEN '35-44'
                WHEN off.age BETWEEN 45 AND 54 THEN '45-54'
                WHEN off.age BETWEEN 55 AND 64 THEN '55-64'
                WHEN off.age >= 65 THEN '65+'
                ELSE 'Unknown'
            END as offender_age_group,
            CASE
                WHEN h.weapon IN ('11','11A','12','12A','13','13A','14','14A','15','15A') THEN 'Firearm'
                WHEN h.weapon IN ('20','20A') THEN 'Knife/Cutting'
                WHEN h.weapon IN ('30','30A') THEN 'Blunt Object'
                WHEN h.weapon IN ('40','40A') THEN 'Personal Weapons'
                WHEN h.weapon IN ('95','99','') OR h.weapon IS NULL THEN 'Unknown'
                ELSE 'Other'
            END as weapon_category,
            COUNT(*) as offender_count
        FROM _tmp_homicide_incidents h
        JOIN offenders off ON off.year = h.year AND off.ori = h.ori AND off.incident_num = h.incident_num
        GROUP BY h.year, offender_race, offender_sex, offender_age_group, weapon_category
    """)
    count = cur.execute("SELECT COUNT(*) FROM summary_homicide_offender").fetchone()[0]
    print(f"  {count:,} rows in {time.time()-t0:.1f}s")

    # Step 4: summary_homicide_victim_offender (cross-tab)
    print("Building summary_homicide_victim_offender...")
    t0 = time.time()
    cur.execute("DROP TABLE IF EXISTS summary_homicide_victim_offender")
    cur.execute("""
        CREATE TABLE summary_homicide_victim_offender AS
        SELECT
            h.year,
            CASE v.race
                WHEN 'W' THEN 'White'
                WHEN 'B' THEN 'Black'
                WHEN 'A' THEN 'Asian'
                WHEN 'I' THEN 'American Indian'
                WHEN 'P' THEN 'Pacific Islander'
                ELSE 'Unknown'
            END as victim_race,
            CASE off.race
                WHEN 'W' THEN 'White'
                WHEN 'B' THEN 'Black'
                WHEN 'A' THEN 'Asian'
                WHEN 'I' THEN 'American Indian'
                WHEN 'P' THEN 'Pacific Islander'
                ELSE 'Unknown'
            END as offender_race,
            COUNT(*) as pair_count
        FROM _tmp_homicide_incidents h
        JOIN victims v ON v.year = h.year AND v.ori = h.ori AND v.incident_num = h.incident_num AND v.victim_type = 'I'
        JOIN offenders off ON off.year = h.year AND off.ori = h.ori AND off.incident_num = h.incident_num
        GROUP BY h.year, victim_race, offender_race
    """)
    count = cur.execute("SELECT COUNT(*) FROM summary_homicide_victim_offender").fetchone()[0]
    print(f"  {count:,} rows in {time.time()-t0:.1f}s")

    # Indexes
    print("Creating indexes...")
    cur.execute("CREATE INDEX idx_hv_year ON summary_homicide_victim(year)")
    cur.execute("CREATE INDEX idx_ho_year ON summary_homicide_offender(year)")
    cur.execute("CREATE INDEX idx_hvo_year ON summary_homicide_victim_offender(year)")

    # Cleanup temp
    cur.execute("DROP TABLE _tmp_homicide_incidents")

    conn.commit()
    conn.close()

    # Verification
    print("\nVerification:")
    conn = sqlite3.connect(DB_PATH)
    for table in ['summary_homicide_victim', 'summary_homicide_offender', 'summary_homicide_victim_offender']:
        count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        years = conn.execute(f"SELECT MIN(year), MAX(year) FROM {table}").fetchone()
        print(f"  {table}: {count:,} rows, {years[0]}-{years[1]}")

    # Sample: victim race x offender race for 2024
    print("\n2024 victim race x offender race:")
    rows = conn.execute("""
        SELECT victim_race, offender_race, SUM(pair_count) as total
        FROM summary_homicide_victim_offender
        WHERE year = 2024
        GROUP BY victim_race, offender_race
        ORDER BY total DESC
        LIMIT 10
    """).fetchall()
    for r in rows:
        print(f"  {r[0]} victim / {r[1]} offender: {r[2]:,}")

    # Intraracial %
    print("\nIntraracial homicide % (2024):")
    row = conn.execute("""
        SELECT
            SUM(CASE WHEN victim_race = offender_race THEN pair_count ELSE 0 END) as intra,
            SUM(pair_count) as total
        FROM summary_homicide_victim_offender
        WHERE year = 2024 AND victim_race != 'Unknown' AND offender_race != 'Unknown'
    """).fetchone()
    if row and row[1]:
        print(f"  {row[0]:,} / {row[1]:,} = {100*row[0]/row[1]:.1f}%")

    conn.close()
    print("\nDone!")

if __name__ == "__main__":
    main()
