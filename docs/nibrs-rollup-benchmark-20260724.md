# NIBRS compact rollup benchmark — 2026-07-24

## Artifact

- Source snapshot: `/opt/nibrs/nibrs.db`, copied while its WAL was empty and the database was quiescent
- Source size: 176,727,072,768 bytes
- Compact database size: 1,810,219,008 bytes (1.02% of source)
- Compact database SHA-256: `348d9dcf9bc6cba1e150ce152bdb3b0ba86b5c4e7fde21b0024ea3fa72a29a34`
- Build host: local workstation; the builder was not run on the production web server
- Build time: 1,003.3 seconds
- SQLite `PRAGMA integrity_check`: `ok`

The builder created state and national variants of nine high-value summary families: arrestee demographics, victim demographics, offender demographics, victim relationship, victim weapon, victim circumstance, victim weapon/circumstance demographics, clearance type, and clearance detail.

## Exact validation

All 18 state/national measure validations passed against the source snapshot. The priority national juvenile-arrests-by-race query for 2021–2025 also returned exactly the same six rows and total from both databases:

- Total arrests: 1,374,097
- Source snapshot, warm filesystem cache: 2,186.8 ms
- Compact rollup: 7.4 ms

## May–July long-query corpus

Window: 2026-05-01 through 2026-07-31. The corpus contained 262 NIBRS queries whose logged runtime was at least 10 seconds. The conservative router accepted 56 queries and rejected queries requiring agency/ORI, city/county, continuous-reporting, or unsupported joins.

| Metric | Logged baseline | Compact rollup |
| --- | ---: | ---: |
| Successful eligible queries | 56 | 56 |
| Failures | — | 0 |
| Median | 25,704.5 ms | 6.3 ms |
| P95 | 68,183 ms | 58.8 ms |
| Maximum | — | 108.8 ms |

For the eight repeated `juvenile arrests by race nationally` entries, logged runtimes ranged from 37.7 to 39.9 seconds; compact-rollup runtimes ranged from 6.7 to 20.5 ms.

The performance-audit baseline remains 45.5 seconds for overall pre-fix NIBRS P95. The 68.2-second value above is the P95 of the narrower, intentionally slow (`>=10s`) rollup-eligible corpus and should not be compared as if it were the same population.

Raw benchmark output remains outside the repository because it contains user query text.
