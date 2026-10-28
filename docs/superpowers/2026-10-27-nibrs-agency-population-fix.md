# NIBRS agency populations: all five county slots (2026-10-27)

Status: code and plan for review. Nothing has been written to production. Applying the correction needs the owner's grant.

## The defect

The NIBRS batch header (BH) carries five county slots, 24 characters apart (current population at 0-based
`[105:114]`, `[129:138]`, `[153:162]`, `[177:186]`, `[201:210]`). Each is the population of the part of the agency in
that county. `bh_population()` in `scripts/nibrs-auto-update.py` read only slot 1, so every agency spanning counties
is stored short in `nibrs.db.agencies.population`.

Found by the nibrs-model session (BUILD-RULES T2) and checked read-only against production on 2026-10-27:

| Agency | Stored 2025 | All slots | Short by |
|---|---|---|---|
| Kansas City, MO (MOKPD0000) | 317,692 | 518,039 | 39% |
| Frisco, TX (TX0430400) | 145,026 | 244,103 | 41% |
| Oklahoma City (OK0550600) | 543,998 | 720,580 | 25% |
| Austin (TX2270100) | 926,822 | 1,000,639 | 7% |
| Dallas (TXDPD0000) | 1,246,336 | 1,331,217 | 6% |
| Houston (TXHPD0000) | 2,362,928 | 2,413,559 | 2% |

2025 master file: 705 agencies have population in slots 2-5; of 56 at 100,000+, 24 are short by more than 5% and 13 by
more than 20%. Every stored year (2013-2026) is affected.

**The sum is the right value.** Against CDE's published agency populations (`crime_data.db.agency_population`), the
slot sum is closer than slot 1 for 85 of 85 multi-county agencies in 2024 and 82 of 86 in 2025 (the four exceptions
differ by under 1,300 and reflect CDE's later population vintage). The RTCI side found the same undercount earlier
and fixed it from populations.csv: Kansas City "sat at RETA's 317,692 against an authoritative 518,039"
(`scripts/test_refresh_agency_populations.py`), exactly the slot sum.

## What it affects

`agencies.population` is the denominator for NIBRS per-capita rates and the filter for population floors
("cities over 100,000"). Copies of it:

| Table | How it gets population | Correction |
|---|---|---|
| `summary_clearance_city_annual` | `JOIN agencies`, `WHERE a.population > 0` (`/opt/nibrs/build_cross_tables.py`, not in this repo) | updated in place |
| `summary_carjacking_clearance` | `UPDATE ... FROM agencies` (`/opt/nibrs/scripts/build-carjacking-clearance.sql`) | updated in place |
| `agency_reporting_gaps` | each ORI's **all-year** `MAX(a.population)`, written into every gap year, for ORIs with a maximum `>= 50000` (`build_reporting_gaps.py`) | every gap row of a corrected ORI takes the corrected all-year maximum, after checking it held the old maximum |
| `nibrs_state_coverage` | `SUM(a.population)` (`build-nibrs-state-coverage.py`) | rebuilt by its builder |
| place resolver cache (`lib/nibrs-place-resolver.ts`) | caches resolved places, including population, per process with no data-version check | app workers reloaded after the correction |

Not affected: `nibrs_national_coverage` (CDE API populations), `state_population`, the rollup database (no population
columns), Current Trends and Historical (other sources).

Known limit of updating in place: memberships chosen by a population filter are not added.
- An ORI-year whose stored value was 0 but whose other slots are not is absent from `summary_clearance_city_annual`
  (`population > 0`) until that table is rebuilt.
- An ORI whose all-year maximum newly reaches 50,000 is absent from `agency_reporting_gaps` and from the CDE
  totals built by `build_cde_agency_totals.py` and `update_cde_totals.py` (both select `population >= 50000`).

`compute` prints both counts and lists the ORIs. Before applying, review them and record whether rebuilding those
tables can wait; if not, the builders are rerun off the server as a separate step.

## Compute result (2026-10-28, off the server)

Inputs: production `agencies` dumped read-only on 2026-10-27 (307,628 rows, 2013-2026); the master ZIPs archived
by nibrs-model on 2026-10-27 (current FBI vintages).

| Year | change | unchanged | mismatch | not_stored |
|---|---|---|---|---|
| 2013-2020 | 664-679 a year | all others | 0 | 0 |
| 2021 | 680 | 20,928 | 9 | 268 |
| 2022 | 691 | 21,032 | 15 | 113 |
| 2023 | 677 | 20,372 | 160 | 196 |
| 2024 | 702 | 21,330 | 48 | 136 |
| 2025 | 705 | 21,753 | 27 | 7 |
| 2026 | 705 | 21,885 | 0 | 0 |

No `conflict` or `duplicate_stored` rows. 9,517 ORI-years are corrected.

- **mismatch (259):** the stored value differs from slot 1 of today's file. Production imported 2021-2025 from
  earlier FBI vintages, which the FBI has since revised (median difference 3.9%). 257 of the 259 are single-county
  agencies, so this defect does not apply to them. Two are multi-county and stay short: NY0152000 2023 (stored 932,
  slots 1,640) and SC0040800 2023 (3,629; 5,664). They are left for the re-import or the rebuild.
- **not_stored (720):** ORI-years in today's files that production does not have, from the same FBI revisions. Out of
  scope here; recorded for the rebuild.
- **Thresholds:** no ORI-year goes from 0 to a population. 13 ORIs newly reach 50,000 at their all-year maximum
  (IL0165M00, MI3336400, MO0490700, NC0330100, OH0090300, OH0250300, OR0220100, SC0180200, TN0600300, TX0430200,
  TX1260200, UT0181200, WA0170300). They are absent from `agency_reporting_gaps` and the CDE totals until those are
  rebuilt; that rebuild can follow as a separate step and does not block this correction.

**Rehearsal on production data (2026-10-28, laptop):** the four affected tables were copied read-only from
production into a separate file and the script was run against the copy with the corrections CSV
(`2026-10-28-nibrs-agency-population-corrections.csv`, sha256 f1c72dbe…a2dd58d as written with CRLF line endings and rehearsed; committed with LF endings, sha256 2f0d1d9a…683ca7b58, same rows):
- dry run: all checks passed; it would write agencies 9,517, summary_clearance_city_annual 120,155,
  summary_carjacking_clearance 4,328 and agency_reporting_gaps 107 rows; the agencies total goes from 4,700,790,729
  to 4,732,325,545;
- apply: Kansas City, MO 2025 reads 518,039 in agencies, summary_clearance_city_annual and agency_reporting_gaps;
- restore: 134,107 rows back; a hash of all four tables equals the hash taken before apply.

## The change

1. `scripts/nibrs-auto-update.py` `bh_population()` sums the five slots, zeroing the 100,000,000 placeholder per slot;
   `None` only when every slot is blank. Future monthly imports (the current year, on the 16th) store the full value.
   Test: `scripts/test_nibrs_bh_population.py` (7 cases; 3 fail on the old code).
2. `scripts/correct-nibrs-agency-population.py` corrects the stored rows. Test:
   `scripts/test_correct_nibrs_agency_population.py` (18 cases: dry run, commit, stale value, out-of-step copy,
   existing backup, bad inputs, status filtering, gap maximum kept from another year, gap not at maximum, duplicate
   agency row, NULL old value, restore, restore refusing a changed identity or value, compute statuses, identical
   and conflicting repeated headers, duplicate stored rows, threshold crossings).

Codex review r1 (2026-10-27): ACCEPT WITH CHANGES, four findings, all applied: gap-table semantics (all-year
maximum), duplicate headers and rows, restore identity checks, and the cache reload and threshold memberships in the
procedure.

Codex review r2 (2026-10-28): ACCEPT, no further changes (`2026-10-28-nibrs-agency-population-codex-r2.md`).

## Production procedure (after Codex acceptance and the owner's grant)

1. **Compute, off the server.** Dump `agencies (ori, year, population)` read-only from production; run `compute`
   against the archived master ZIPs for 2013-2026 (nibrs-model's B2 source archive; 2017-2019 need `inflate64`).
   Review the counts per year: `change`, `mismatch`, `not_stored`, `conflict`, `duplicate_stored`, and the threshold
   lists. Only `change` rows are ever applied; any other non-zero status is explained before applying.
2. **Writers idle.** The maintenance lock excludes only programs that take it. For steps 3-5, no other writer of
   nibrs.db runs: no monthly refresh (the 16th), no summary or rollup builder, no CDE totals update, no release.
3. **Dry run on the server**: copy the CSV and script up; run `apply` without `--apply`. It takes the release lock
   and the NIBRS maintenance lock (it waits for the maintenance lock rather than failing at once), writes the row
   backup, runs every check and rolls back.
4. **Apply**: the same with `--apply` and a new `--row-backup` path. One transaction of a few thousand row updates;
   the app opens nibrs.db read-only and the database is in WAL mode, so readers continue. Not a heavy builder.
5. **Rebuild `nibrs_state_coverage`**: `python3 scripts/build-nibrs-state-coverage.py --db-path /opt/nibrs/nibrs.db`
   (takes the maintenance lock).
6. **Reload the app workers** (`pm2 reload nibrs`), so the place resolver drops its cached populations. This can be
   the restart of step 8's deploy if that deploy is done here.
7. **Check live**: Kansas City, MO 2025 reads 518,039 in `agencies` and in `summary_clearance_city_annual`; a
   per-capita question for Kansas City on nibrsai.com uses it.
8. **Deploy the importer fix** with `scripts/release.sh`, completed before the next monthly refresh (Nov 16), or that
   run rewrites the current year's rows from slot 1.
9. **Rollback**: `restore --row-backup <file>`, then steps 5 and 6 again. Restore refuses unless every row is still
   the corrected row (same rowid, ori, year and corrected value), so it cannot be used after the tables have been
   rebuilt or re-imported. After a refresh has rewritten the current year, compute a new correction instead.

## Related

- The nibrs-model canonical build keeps all five slots (BUILD-RULES T2), so the rebuild does not inherit this.
- The PA coverage gap (48.07% vs CDE 53.4%, memory `cda-nibrs-coverage-pct-discrepancy`) uses
  `nibrs_state_coverage`; this correction changes its inputs, so the gap should be re-measured after step 4.
