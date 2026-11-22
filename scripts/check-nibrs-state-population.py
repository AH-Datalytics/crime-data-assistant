#!/usr/bin/env python3
"""Release fact check: no person counted twice in a state's NIBRS rate population (P184).

A NIBRS state or national rate divides by the summed NIBRS populations of the agencies in it (lib/nibrs-shadow/state-sum.ts, P184): each agency's own
NIBRS population only, a zero adding 0 people. The FBI gives zero to agencies whose people another agency already counts, so a rule that fills those
zeros from elsewhere counts people twice, and the summed population of a state's agencies runs above the state's own population.

This check sums EVERY agency of each state in the NIBRS agency file (whether or not it reported), per year, under the rule (RULE below) and compares
the sum with the Crime Index state population (state_crime). It FAILS (exit 1) when the rule pushes a state-year more than 1% over the state
population beyond what NIBRS's own populations already give. It PRINTS, without failing, the state-years where NIBRS's own populations alone run
more than 1% over (a release fact, e.g. New York 2024 109.8%), and, for comparison, the Crime Index fill merged in PR 286 and removed after this
check (any Crime Index row of the same ORI and year filling a NIBRS zero: Pennsylvania 2024 133.7%).

  python scripts/check-nibrs-state-population.py <canonical root> <Crime Index historical root> [first_year last_year]

Read-only; the canonical root holds agency/data.parquet, the historical root agency_crime.parquet and state_crime.parquet. Needs the duckdb package.
Result on canon2-20261118-host with the Crime Index historical files used 2026-11-21, 2017-2026: 441 state-years, 0 pushed over by the rule; 219 over by NIBRS's
own populations alone; 162 pushed over by the removed PR 286 fill.
"""
import sys

import duckdb

# P184: the population an agency adds to a state's rate. own = its NIBRS population (0 where none); ci = the Crime Index population of the same ORI and year.
RULE = "own"
OLD_FILL = "CASE WHEN own > 0 THEN own ELSE coalesce(ci, 0) END"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    canon, hist = (a.rstrip("/\\").replace("'", "''") for a in sys.argv[1:3])
    first = int(sys.argv[3]) if len(sys.argv) > 3 else 2017
    last = int(sys.argv[4]) if len(sys.argv) > 4 else 2026
    d = duckdb.connect()
    rows = d.execute(f"""
      WITH a AS (SELECT ori, y.state_abbr AS st, y.data_year AS yr, coalesce(y.population, 0) AS own
                 FROM read_parquet('{canon}/agency/data.parquet'), unnest(by_year) AS t(y) WHERE y.data_year BETWEEN {first} AND {last}),
      j AS (SELECT a.st, a.yr, a.own, c.population AS ci
            FROM a LEFT JOIN read_parquet('{hist}/agency_crime.parquet') c ON c.ori = a.ori AND c.year = a.yr AND c.population > 0)
      SELECT j.st, j.yr, sum({RULE}) AS now, sum({OLD_FILL}) AS old, s.population, sum(own) AS own
      FROM j JOIN read_parquet('{hist}/state_crime.parquet') s ON s.state = j.st AND s.year = j.yr AND s.population > 0
      GROUP BY j.st, j.yr, s.population ORDER BY j.st, j.yr""").fetchall()
    bad = [r for r in rows if r[2] > r[4] * 1.01 and r[2] > r[5]]
    oldbad = [r for r in rows if r[3] > r[4] * 1.01 and r[3] > r[5]]
    ownbad = [r for r in rows if r[5] > r[4] * 1.01]
    print(f"state-years checked: {len(rows)} ({first}-{last}); pushed more than 1% over the Crime Index state population by the rule: {len(bad)}; "
          f"over by NIBRS's own populations alone (printed, not a failure): {len(ownbad)}; pushed over by the removed PR 286 fill: {len(oldbad)}")
    for st, yr, now, old, pop, own in rows:
        flag = "FAIL" if (now > pop * 1.01 and now > own) else ("own over" if own > pop * 1.01 else ("PR 286 fill over" if old > pop * 1.01 else ""))
        if flag:
            print(f"  {st} {yr}: rule {now:,} = {100 * now / pop:.1f}% of state {pop:,} (own NIBRS {100 * own / pop:.1f}%, PR 286 fill {100 * old / pop:.1f}%) {flag}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
