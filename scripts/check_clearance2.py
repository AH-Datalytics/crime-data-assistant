import sqlite3
conn = sqlite3.connect("/mnt/HC_Volume_105124811/nibrs/nibrs.db")

# Distribution of total_arrestee_segments values
rows = conn.execute("""
    SELECT total_arrestee_segments, COUNT(*)
    FROM incidents
    WHERE year = 2023 AND ori = 'TXHPD0000'
    GROUP BY total_arrestee_segments
    ORDER BY total_arrestee_segments
    LIMIT 20
""").fetchall()
print("Houston 2023 - total_arrestee_segments distribution:")
for r in rows:
    print(f"  segments={r[0]} count={r[1]:,}")

# Check if maybe we should use arrestees table instead
arrestee_count = conn.execute("""
    SELECT COUNT(DISTINCT incident_num)
    FROM arrestees
    WHERE year = 2023 AND ori = 'TXHPD0000'
""").fetchone()[0]
total_incidents = conn.execute("""
    SELECT COUNT(*)
    FROM incidents
    WHERE year = 2023 AND ori = 'TXHPD0000'
""").fetchone()[0]
print(f"\nHouston 2023:")
print(f"  Total incidents: {total_incidents:,}")
print(f"  Incidents with arrestees (from arrestees table): {arrestee_count:,}")
print(f"  Arrest rate from arrestees table: {arrestee_count/total_incidents*100:.1f}%")

# Check a sample incident with high arrestee segments
sample = conn.execute("""
    SELECT incident_num, total_offense_segments, total_victim_segments,
           total_offender_segments, total_arrestee_segments, cleared_exceptionally
    FROM incidents
    WHERE year = 2023 AND ori = 'TXHPD0000' AND total_arrestee_segments > 0
    LIMIT 5
""").fetchall()
print("\nSample incidents with total_arrestee_segments > 0:")
for r in sample:
    print(f"  inc={r[0]} offenses={r[1]} victims={r[2]} offenders={r[3]} arrestees={r[4]} cleared_exc={r[5]}")

conn.close()
