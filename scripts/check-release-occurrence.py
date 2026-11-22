#!/usr/bin/env python3
"""Release fact check: no offense code repeats inside an incident.

The engine joins a victim to its offense's weapons by incident and connected offense CODE only (lib/nibrs-plan/compile.ts, P31): a NIBRS victim segment names its
connected offense by code, so the data has no offense-occurrence key on the victim side. That is exact only while an incident holds at most one offense segment per
code, and the canonical build gives a repeated code key_occurrence 2 or more. This check fails (exit 1) when any release year has an offense row, or an offense_weapon row,
with key_occurrence > 1, so a release that breaks the assumption is stopped before it is served.

  python scripts/check-release-occurrence.py <canonical root> [first_year last_year]

Read-only, two cheap aggregates per year (about a minute for the 2017-2026 release at Idle priority). Needs the duckdb Python package (the engine's own venv has it).
Results on release canon2-20261118-host, 2017-2026: every year 0 offense rows and 0 offense_weapon rows with key_occurrence > 1 (offense rows 6.2M to 14.6M per year).
"""
import sys

import duckdb


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = sys.argv[1].rstrip("/\\")
    first = int(sys.argv[2]) if len(sys.argv) > 2 else 2017
    last = int(sys.argv[3]) if len(sys.argv) > 3 else 2026
    try:
        import psutil  # optional: keep the check at Idle priority

        psutil.Process().nice(psutil.IDLE_PRIORITY_CLASS)
    except Exception:
        pass
    con = duckdb.connect()
    con.execute("PRAGMA threads=2")
    bad = 0
    print("year  offense_rows  offense_rows_key>1  offense_weapon_rows_key>1")
    for y in range(first, last + 1):
        o = f"read_parquet('{root}/offense/data_year={y}/data.parquet')"
        w = f"read_parquet('{root}/offense_weapon/data_year={y}/data.parquet')"
        rows, repeated = con.execute(f"SELECT count(*), coalesce(sum((key_occurrence > 1)::INT), 0) FROM {o}").fetchone()
        wrep = con.execute(f"SELECT coalesce(sum((key_occurrence > 1)::INT), 0) FROM {w}").fetchone()[0]
        print(f"{y}  {rows}  {repeated}  {wrep}")
        bad += int(repeated) + int(wrep)
    if bad:
        print(f"FAIL: {bad} repeated-code rows: a victim's weapon is no longer exact by code alone (compile.ts, P31). Do not serve this release until the victim weapon join uses an occurrence.")
        return 1
    print("OK: no offense code repeats inside an incident in any year checked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
