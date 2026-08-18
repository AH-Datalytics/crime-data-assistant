"""Ordered-content digest of every table in a crime_data.db, for comparing two copies.

Read-only. Used to prove that a replacement database differs from production in exactly the
five Historical tables and nowhere else.
"""
import hashlib
import json
import sqlite3
import sys

path = sys.argv[1]
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
out = {}
for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
    columns = [row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')]
    if not columns:
        continue
    order = ", ".join(f'"{c}"' for c in columns)
    digest = hashlib.sha256()
    digest.update(("|".join(columns) + "\n").encode("utf-8"))
    rows = 0
    for row in conn.execute(f'SELECT {order} FROM "{table}" ORDER BY {order}'):
        rows += 1
        digest.update(("\x1f".join("" if v is None else str(v) for v in row) + "\n").encode("utf-8"))
    out[table] = {"rows": rows, "sha256": digest.hexdigest()}
print(json.dumps(out, indent=2, sort_keys=True))
