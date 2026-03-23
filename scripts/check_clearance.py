import sqlite3
conn = sqlite3.connect("/mnt/HC_Volume_105124811/nibrs/nibrs.db")

# Check Houston 2023
rows = conn.execute("""
    SELECT cleared_exceptionally,
           CASE WHEN total_arrestee_segments > 0 THEN 'has_arrest' ELSE 'no_arrest' END as arrest_flag,
           COUNT(*)
    FROM incidents
    WHERE year = 2023 AND ori = 'TXHPD0000'
    GROUP BY cleared_exceptionally, arrest_flag
    ORDER BY COUNT(*) DESC
""").fetchall()
print("Houston 2023 - cleared_exceptionally x has_arrestees:")
for r in rows:
    print(f"  cleared_exc=[{r[0]}] {r[1]} count={r[2]:,}")

# Check: are there uncleared incidents?
rows2 = conn.execute("""
    SELECT COUNT(*) as total,
           SUM(CASE WHEN total_arrestee_segments > 0 THEN 1 ELSE 0 END) as has_arrest,
           SUM(CASE WHEN cleared_exceptionally IN ('A','B','C','D','E') THEN 1 ELSE 0 END) as has_excep,
           SUM(CASE WHEN total_arrestee_segments = 0 AND cleared_exceptionally NOT IN ('A','B','C','D','E') THEN 1 ELSE 0 END) as uncleared
    FROM incidents
    WHERE year = 2023 AND ori = 'TXHPD0000'
""").fetchall()
print(f"\nHouston 2023 totals:")
for r in rows2:
    print(f"  total={r[0]:,} has_arrest={r[1]:,} has_excep={r[2]:,} uncleared={r[3]:,}")

conn.close()
