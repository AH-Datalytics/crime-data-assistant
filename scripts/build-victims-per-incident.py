#!/usr/bin/env python3
"""
Build summary_victims_per_incident — incidents bucketed by how many individual
victims were connected to each offense code (N06, ruling 2026-07-05).

  year INT, state TEXT, ucr_offense_code TEXT,
  victims_in_incident INT (exact count, uncapped),
  incident_count INT

Answers "how many aggravated assault incidents involve multiple victims?" as
  SELECT SUM(incident_count) FROM summary_victims_per_incident
  WHERE ucr_offense_code = '13A' AND victims_in_incident > 1;

Counts INDIVIDUAL victims (victim_type = 'I') via connected_offense_1..3 on the
victims table. State-level only (no ori) to keep the table tiny.

Runs year-by-year with DELETE-before-INSERT (idempotent — safe to re-run after
a crash) and periodic WAL checkpoints. Use nice/ionice on the VPS:
  SQLITE_TMPDIR=/opt/nibrs/tmp nice -n 19 ionice -c3 python3 scripts/build-victims-per-incident.py /opt/nibrs/db/nibrs.db
"""
import sqlite3
import sys
import time

DB = sys.argv[1] if len(sys.argv) > 1 else "/opt/nibrs/db/nibrs.db"

conn = sqlite3.connect(DB, timeout=120)
conn.execute("PRAGMA journal_mode=WAL")
conn.execute("PRAGMA synchronous=NORMAL")

conn.execute("""
    CREATE TABLE IF NOT EXISTS summary_victims_per_incident (
        year INT,
        state TEXT,
        ucr_offense_code TEXT,
        victims_in_incident INT,
        incident_count INT
    )
""")
conn.execute("""
    CREATE INDEX IF NOT EXISTS idx_svpi_code_year
    ON summary_victims_per_incident(ucr_offense_code, year)
""")
conn.commit()

years = [r[0] for r in conn.execute("SELECT DISTINCT year FROM victims ORDER BY year")]
print(f"Building summary_victims_per_incident for {len(years)} years ({years[0]}-{years[-1]})", flush=True)

total_start = time.time()
for i, yr in enumerate(years):
    t = time.time()
    conn.execute("DELETE FROM summary_victims_per_incident WHERE year = ?", (yr,))
    conn.execute(f"""
        INSERT INTO summary_victims_per_incident
        SELECT year, state, code, vc AS victims_in_incident, COUNT(*) AS incident_count
        FROM (
            SELECT year, state, ori, incident_num, code, COUNT(*) AS vc
            FROM (
                SELECT year, state, ori, incident_num, connected_offense_1 AS code FROM victims
                  WHERE year = {yr} AND victim_type = 'I'
                  AND connected_offense_1 IS NOT NULL AND connected_offense_1 != ''
                UNION ALL
                SELECT year, state, ori, incident_num, connected_offense_2 FROM victims
                  WHERE year = {yr} AND victim_type = 'I'
                  AND connected_offense_2 IS NOT NULL AND connected_offense_2 != ''
                UNION ALL
                SELECT year, state, ori, incident_num, connected_offense_3 FROM victims
                  WHERE year = {yr} AND victim_type = 'I'
                  AND connected_offense_3 IS NOT NULL AND connected_offense_3 != ''
            )
            GROUP BY year, state, ori, incident_num, code
        )
        GROUP BY year, state, code, vc
    """)
    conn.commit()
    rows, incidents = conn.execute(
        "SELECT COUNT(*), SUM(incident_count) FROM summary_victims_per_incident WHERE year = ?", (yr,)
    ).fetchone()
    print(f"  {yr}: {rows:,} rows, {incidents:,} incident-offense groups ({time.time()-t:.0f}s)", flush=True)
    if (i + 1) % 5 == 0:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

conn.execute("ANALYZE summary_victims_per_incident")
conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
conn.commit()
total_rows = conn.execute("SELECT COUNT(*) FROM summary_victims_per_incident").fetchone()[0]
print(f"Done: {total_rows:,} total rows in {(time.time()-total_start)/60:.1f} min", flush=True)
conn.close()
