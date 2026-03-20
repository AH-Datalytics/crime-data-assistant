"""
Look up agency names for blank-city agencies via CDE API and update the agencies table.
"""
import sqlite3
import requests
import time
import re

DB = "/mnt/HC_Volume_105124811/nibrs/nibrs.db"

conn = sqlite3.connect(DB, timeout=30)
conn.execute("PRAGMA busy_timeout=30000")

# Get all blank-city ORIs (non-federal, with population)
rows = conn.execute("""
    SELECT DISTINCT ori, state
    FROM agencies
    WHERE city = '' AND state != 'FS' AND population > 0
    ORDER BY ori
""").fetchall()
print(f"Found {len(rows)} blank-city ORIs to look up")

updated = 0
errors = 0
for i, (ori, state) in enumerate(rows):
    try:
        url = f"https://cde.ucr.cjis.gov/LATEST/nibrs/agency/{ori}/09A?from=01-2024&to=12-2024&type=counts"
        r = requests.get(url, timeout=10)
        if r.status_code == 200:
            data = r.json()
            actuals = data.get("offenses", {}).get("actuals", {})
            keys = list(actuals.keys())
            if keys:
                # Key format: "Agency Name Offenses"
                name = keys[0].replace(" Offenses", "").strip()
                # Convert to UPPER CASE to match existing city format
                city_name = name.upper()
                conn.execute("UPDATE agencies SET city = ? WHERE ori = ? AND city = ''", (city_name, ori))
                print(f"  [{i+1}/{len(rows)}] {ori} → {city_name}")
                updated += 1
            else:
                # Try a different offense code
                url2 = f"https://cde.ucr.cjis.gov/LATEST/nibrs/agency/{ori}/13A?from=01-2024&to=12-2024&type=counts"
                r2 = requests.get(url2, timeout=10)
                if r2.status_code == 200:
                    data2 = r2.json()
                    actuals2 = data2.get("offenses", {}).get("actuals", {})
                    keys2 = list(actuals2.keys())
                    if keys2:
                        name = keys2[0].replace(" Offenses", "").strip()
                        city_name = name.upper()
                        conn.execute("UPDATE agencies SET city = ? WHERE ori = ? AND city = ''", (city_name, ori))
                        print(f"  [{i+1}/{len(rows)}] {ori} → {city_name} (via 13A)")
                        updated += 1
                    else:
                        print(f"  [{i+1}/{len(rows)}] {ori} → NO DATA")
                        errors += 1
                time.sleep(0.25)
        else:
            print(f"  [{i+1}/{len(rows)}] {ori} → HTTP {r.status_code}")
            errors += 1
        time.sleep(0.25)
    except Exception as e:
        print(f"  [{i+1}/{len(rows)}] {ori} → ERROR: {e}")
        errors += 1
        time.sleep(0.5)

    if (i + 1) % 50 == 0:
        conn.commit()
        print(f"  ... committed at {i+1}")

conn.commit()
print(f"\nDone: {updated} updated, {errors} errors out of {len(rows)} total")
conn.close()
