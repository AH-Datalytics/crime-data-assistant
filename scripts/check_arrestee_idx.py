import sqlite3
conn = sqlite3.connect("/mnt/HC_Volume_105124811/nibrs/nibrs.db")

# Check indexes on arrestees table
rows = conn.execute("SELECT * FROM sqlite_master WHERE type='index' AND tbl_name='arrestees'").fetchall()
print("Indexes on arrestees:")
for r in rows:
    print(f"  {r[1]}: {r[4]}")

# Count arrestees
cnt = conn.execute("SELECT COUNT(*) FROM arrestees").fetchone()[0]
print(f"\nTotal arrestee records: {cnt:,}")

# Count distinct incidents with arrestees
cnt2 = conn.execute("SELECT COUNT(*) FROM (SELECT DISTINCT ori, incident_num, year FROM arrestees)").fetchone()[0]
print(f"Distinct incidents with arrestees: {cnt2:,}")

conn.close()
