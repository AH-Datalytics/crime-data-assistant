# Heavy national questions: declined for now, to be made answerable

Questions the new engine declines up front (policy row P122) because the national statements over several years take minutes to count
(the scorecard's time limits are 120 s, then 360 s). The speed work starts from this list.

## The decision (Jeff, 2026-11-16)
- Decline, with the approved sentence and no pointer to another tool: "We should decline and try to make it work later."
- **Offenders are not arrestees.** The answer to "annual counts of offenders by age" is offenders by age group from NIBRS, from the first
  year the release holds to the latest, not arrests.
- **Target:** answer offenders by age group from the earliest NIBRS year (2017) to the latest, once the national statements are fast
  enough. The period clamps to the release's first year (2017) and the answer says so.
- One year, one state, one agency or one named crime still answer today.

## Why they are heavy (runner profile, 2026-11-16, DuckDB 1.5.6, 4 GB, 4 threads)
- The national plan for property crime by offender age over 2017-2025 reads about 96 million offender rows and 105 million offense rows,
  keeps about 40 million units, and aggregates them (a DISTINCT, then a COUNT(DISTINCT) over the same rows): about 300 s standalone on the
  runner (55-75 s on a laptop), then a second statement of the same size for the sums.
- Tried and not the lever (identical rows, laptop): COUNT(DISTINCT hash) 59 s vs 55 s; no DISTINCT in the unit scan 48 s; a sparse
  coverage/sums formulation about 1.3x. The unit set itself is the cost. Ideas not yet tried: a precomputed per-agency-month-by-category
  summary in the release; per-year statements merged afterwards; computing coverage once and sharing it.

## The list (53 logged questions; runner, dev 183504ef, 2026-11-16)
The union of the SQL timing logs of the dev-code runs: 51 ids ran a statement over 100,000 characters, 5 a statement over 60 s, 3 both.
Baseline outcome: 35 clarify, 11 decline, 7 answer, no error. "Longest" = the longest statement by characters (chars, ms); "slowest" = the slowest
statement (ms, chars). A slow value on a small statement is probably load noise. The runner's `C:\runner\scorecard\heavy_ids_dev.txt` is the authority.

What it shows:
- **Most are national clarifies (35) and reader declines (11) that computed a national table before asking or declining**, including
  QL-shr-349398af53, the slowest (360 s). The P122 guard hits none of the logged ones: it changed 0 ids.
- **The real data answers (7)** include QL-hist-cf5a3d0bcc ("arrests per year in the United States"), QL-nibrs-25246a6b9b, QL-nibrs-fecedb1bda,
  QL-nibrs-21e388da4e, QL-shr-38c550f436 and QL-nibrs-98af404ff6 (a small statement: its slow time is probably load noise).
- **Open design question:** a broader place-less guard (ask the place BEFORE computing the national plan) would speed up most of the clarify rows.
  It conflicts with the "never a button that cannot run" rule (each ask option carries its answer, computed eagerly), so it needs a decision:
  keep eager continuations and speed up the national statements, or compute an option only when it is pressed.

| id | question | tab | outcome (baseline) | longest statement (chars, ms) | slowest (ms) |
|---|---|---|---|---|---|
| QL-shr-349398af53 | show me annual counts of offenders by age from 1986 through 2025 | shr | clarify:which place | 913,592, 125,261 | 360,377; no answer within 120 s; no answer within 360 s |
| QL-nibrs-0a3141365b | show me aggravated assault offenders by age by year from 2017 to 2025 for consistent reporters | nibrs | clarify:which place | 960,990, 68,583 | 120,220; no answer within 120 s |
| QL-nibrs-02d9044095 | A national estimate since 1991 of robbery offenders by race | nibrs | decline:reader | 943,886, 114,428 | 114,428 |
| QL-nibrs-cc6769f8d6 | show me violent crimes by offender age by year for california for 2015 to 2025 for consistent reporters | nibrs | decline:outside_release_coverage | 45,122, 2,773 | 113,321 |
| QL-nibrs-98af404ff6 | show me violent crimes by offender age by year for vermont | nibrs | answer | 10,703, 174 | 102,471 |
| QL-nibrs-4fb4a07ecf | Show me shootings per month | nibrs | clarify:We don't track non-fatal shootings | 913,629, 23,535 | 35,373 |
| QL-hist-cf5a3d0bcc | how many arrests per year in the United states? | historical | answer | 912,475, 31,820 | 31,820 |
| QL-nibrs-51feab0e24 | how has sexual assault changed in the past 10 years? | nibrs | clarify:which sex offenses | 912,417, 23,413 | 23,413 |
| QL-nibrs-04761dc302 | Please show me a national chart of aggravated assaults with a firearm used from 2021-2025 | nibrs | decline:reader | 894,167, 19,292 | 19,292 |
| QL-hist-6fdcd8a51a | national, sexual assault, 2010-2024 | historical | clarify:which sex offenses | 900,366, 17,300 | 17,300 |
| QL-nibrs-8d7044e28d | show me DUI arrests from 2017 to 2026 | nibrs | clarify:which place | 1,226,217, 12,465 | 15,948 |
| QL-nibrs-8431458c95 | Show me the national trend in DWI/DUI from 2000 to today | nibrs | decline:unsupported_capability | 1,216,077, 11,125 | 14,295 |
| QL-nibrs-0667d8c589 | show me crimes with a juvenile offender 2017 to 2025 | nibrs | clarify:which place | 912,417, 13,852 | 13,852 |
| QL-nibrs-07e309f0ce | show me juvenile arrests 2005 to 2025 | nibrs | clarify:which place | 1,217,339, 11,291 | 11,291 |
| QL-hist-423179ca6d | show me nationwide arrests for violent crimes by age by year for 2015 to 2025 for consistent reporters | historical | answer | 1,265,887, 6,384 | 11,082 |
| QL-nibrs-4e8b07e695 | assaults by victim offender relationship 2024 | nibrs | clarify:which place | 1,005,334, 6,964 | 10,410 |
| QL-nibrs-bc1d89ea45 | vehicle burglaries per year, 2019-2025 among consistent reporters | nibrs | clarify:which place | 908,626, 7,512 | 10,349 |
| QL-nibrs-714d760a97 | by age group | nibrs | clarify:victim or offender age | 1,012,144, 5,486 | 10,297 |
| QL-nibrs-05680092ca | trends in juvenile weapon possession arrests over time | nibrs | clarify:which place | 1,216,078, 9,708 | 9,708 |
| QL-nibrs-496442dbc2 | show me violent crime incidents by year for 2017 to 2025 for consistent reporters | nibrs | clarify:which place | 911,246, 4,390 | 9,013 |
| QL-nibrs-28490bc642 | Give me the carjacking trend by month and year | nibrs | clarify:which place | 912,367, 4,172 | 8,486 |
| QL-nibrs-c74cec7689 | Compare offender demographics for robbery by sex nationally | nibrs | decline:reader | 1,011,482, 4,571 | 6,714 |
| QL-hist-a6d2a61514 | Annual Drug arrests 1980-2022 | historical | clarify:which place | 1,166,851, 6,204 | 6,204 |
| QL-nibrs-89aa8c1245 | Show me offender age demographics for robberies nationwide in 2023 | nibrs | decline:reader | 861,140, 5,450 | 5,864 |
| QL-shr-4d820a7ff7 | Show me the arrests for marijuana possession from 2000 to 2025 | shr | clarify:which place | 1,217,083, 4,952 | 5,693 |
| QL-nibrs-b2f415c823 | DUI arrests by age nationally, 2023 - 2025 | nibrs | decline:unsupported_capability | 1,179,001, 3,774 | 4,585 |
| QL-nibrs-fecedb1bda | marijuana possession arrests in Texas since 2020 | nibrs | answer | 102,463, 686 | 4,566 |
| QL-nibrs-92f486a9ca | juvenile arrests by race nationally | nibrs | clarify:which period | 1,309,048, 3,030 | 3,820 |
| QL-nibrs-25246a6b9b | How many arrests were made in 2024 in the United States? | nibrs | answer | 868,171, 2,207 | 3,609 |
| QL-nibrs-6ef0da1a7d | breakdown of weapons used in assaults 2024 | nibrs | clarify:which place | 866,202, 3,490 | 3,491 |
| QL-ct-664e61f0b3 | show me intimidation offenses trends | current | clarify:which place | 911,248, 3,241 | 3,241 |
| QL-ct-8e241ed156 | Top 10 cities by total assault in 2023 | current | clarify:which place | 861,246, 2,410 | 3,229 |
| QL-shr-38c550f436 | Can you provide a chart of gun possession arrests nationally over the last 25 years? | shr | answer | 1,215,991, 2,986 | 2,986 |
| QL-nibrs-cdc9d84429 | show me intimidations | nibrs | clarify:which place | 880,117, 1,735 | 2,580 |
| QL-nibrs-a5c81c1237 | show me robberies by offender age for 2025 | nibrs | clarify:which place | 1,012,016, 1,271 | 2,462 |
| QL-hist-a0c6d553cd | Show me national arrests for violent crimes in the following age groups: under 18; 18 to 24; 25 to 39; and 40 (question cut at 110 chars) | historical | decline:reader | 1,176,333, 2,342 | 2,342 |
| QL-nibrs-0da45d83fb | How bad is aggravated assaults with a firearm in America? Is it getting better? | nibrs | decline:reader | 880,545, 1,214 | 2,331 |
| QL-ct-c80f231f81 | DUI arrests by age group nationally | current | clarify:which period | 1,308,244, 1,779 | 2,277 |
| QL-nibrs-c295e7d92a | DUI arrests nationally | nibrs | clarify:which period | 1,176,297, 2,128 | 2,154 |
| QL-nibrs-0c15fc0c7b | Give me stats on marijuana possession arrests? | nibrs | clarify:which place | 1,177,303, 1,623 | 2,047 |
| QL-nibrs-21e388da4e | how many marijuana possession arrests were there nationwide in 2020 | nibrs | answer | 1,112,511, 1,555 | 2,031 |
| QL-nibrs-267c01f92b | Can you show me the national female arrest rate for simple assault over time please | nibrs | decline:reader | 877,618, 1,949 | 1,949 |
| QL-nibrs-3c31f0f10a | marijuana arrests | nibrs | clarify:which place | 1,177,373, 1,659 | 1,799 |
| QL-nibrs-456e604d69 | arrest rates | nibrs | clarify:which place | 1,172,589, 1,659 | 1,659 |
| QL-nibrs-0f5d1f84b2 | Give me drug possession arrest statistics. | nibrs | clarify:which place | 1,176,211, 1,570 | 1,578 |
| QL-nibrs-197fc68e8f | show me juvenile arrests | nibrs | clarify:which place | 1,176,368, 1,538 | 1,560 |
| QL-nibrs-43401cd191 | robberies by time of day nationally | nibrs | clarify:which period | 1,011,666, 823 | 1,509 |
| QL-ct-74adea6bb6 | sex crime data nationally | current | clarify:which sex offenses | 880,152, 1,086 | 1,498 |
| QL-ct-4db15ef27b | how many carjackings were there in 2023 | current | clarify:which place | 861,247, 1,351 | 1,351 |
| QL-nibrs-1f3fbbaf46 | how many violent crimes nationwide in 2025 had any offenders under age 18 | nibrs | decline:reader | 877,658, 1,197 | 1,197 |
| QL-nibrs-00c7569bd1 | show carjackins per capita | nibrs | clarify:which place | 880,147, 676 | 1,050 |
| QL-nibrs-26885c10db | drug possessions | nibrs | clarify:which place | 879,793, 646 | 843 |
| QL-nibrs-72eb2ad905 | DUI arrests by race in Texas | nibrs | clarify:which period | 109,205, 348 | 410 |
