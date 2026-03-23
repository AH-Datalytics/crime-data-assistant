import sqlite3, time
conn = sqlite3.connect("/mnt/HC_Volume_105124811/nibrs/nibrs.db")

start = time.time()
rows = conn.execute("""
    SELECT i.year, i.cleared_exceptionally, COUNT(*) as cnt
    FROM incidents i
    JOIN offenses o ON o.ori = i.ori AND o.incident_num = i.incident_num AND o.year = i.year
    WHERE i.ori IN (SELECT ori FROM agencies WHERE city = 'HOUSTON' AND state = 'TX' AND pop_group LIKE '1%' AND year = 2024)
      AND o.ucr_offense_code = '11A'
      AND i.year BETWEEN 2022 AND 2025
      AND i.cleared_exceptionally IN ('A','B','C','D','E')
    GROUP BY i.year, i.cleared_exceptionally
    ORDER BY i.year, i.cleared_exceptionally
""").fetchall()
elapsed = time.time() - start

print(f"Query took {elapsed:.2f}s")
print("Houston rape exceptional clearance breakdown:")
for r in rows:
    codes = {'A': 'Death of offender', 'B': 'Prosecution declined', 'C': 'In custody elsewhere', 'D': 'Victim refused', 'E': 'Juvenile/no custody'}
    print(f"  {r[0]} {r[1]}={codes.get(r[1],'?')}: {r[2]}")

conn.close()
