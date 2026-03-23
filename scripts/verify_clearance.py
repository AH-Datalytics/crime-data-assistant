import sqlite3
conn = sqlite3.connect("/mnt/HC_Volume_105124811/nibrs/nibrs.db")

# Houston murder clearance rates
rows = conn.execute("""
    SELECT year, SUM(total_offenses) as total, SUM(cleared_by_arrest) as arrest,
           SUM(cleared_exceptional) as excep
    FROM summary_clearance_type
    WHERE ori = 'TXHPD0000' AND ucr_offense_code = '09A' AND year BETWEEN 2022 AND 2025
    GROUP BY year ORDER BY year
""").fetchall()
print("Houston murder clearances:")
for r in rows:
    rate = (r[2]+r[3])/r[1]*100 if r[1] > 0 else 0
    print(f"  {r[0]}: total={r[1]}, arrest={r[2]}, exceptional={r[3]}, rate={rate:.1f}%")

# National murder clearance rates
rows2 = conn.execute("""
    SELECT year, SUM(total_offenses) as total, SUM(cleared_by_arrest) as arrest,
           SUM(cleared_exceptional) as excep
    FROM summary_clearance_type
    WHERE ucr_offense_code = '09A' AND year BETWEEN 2022 AND 2025
    GROUP BY year ORDER BY year
""").fetchall()
print("\nNational murder clearances:")
for r in rows2:
    rate = (r[2]+r[3])/r[1]*100 if r[1] > 0 else 0
    print(f"  {r[0]}: total={r[1]}, arrest={r[2]}, exceptional={r[3]}, rate={rate:.1f}%")

# Chicago robbery
rows3 = conn.execute("""
    SELECT year, SUM(total_offenses) as total, SUM(cleared_by_arrest) as arrest,
           SUM(cleared_exceptional) as excep
    FROM summary_clearance_type
    WHERE ori = 'ILCPD0000' AND ucr_offense_code = '120' AND year BETWEEN 2022 AND 2025
    GROUP BY year ORDER BY year
""").fetchall()
print("\nChicago robbery clearances:")
for r in rows3:
    rate = (r[2]+r[3])/r[1]*100 if r[1] > 0 else 0
    print(f"  {r[0]}: total={r[1]}, arrest={r[2]}, exceptional={r[3]}, rate={rate:.1f}%")

conn.close()
