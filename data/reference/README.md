# Agency reference tables

Two small tables the engine reads. They replace if-statements and name matching with data. Written for the second operator: everything needed to rebuild or check them is in this repository and in `crime_data.db`.

## agency_county.csv

One row per law-enforcement agency of a county: a Historical agency of type `county` that `agency_county_crosswalk` maps to a county by FIPS code. County agency only. There is no countywide rollup here (P25/P70: a countywide request is declined).

| column | meaning |
|---|---|
| state, county_fips, county_key, county_name | the county. `county_key` is the crosswalk's key: upper case, letters and digits, `ST` for Saint, no county word. Resolve a county question by `state` + `county_key`, never by agency name |
| ori9 | the agency |
| agency_name, crosswalk_agency_name | the two names the sources give it; descriptive, never a key |
| first_year, last_year | first and last year with a violent-crime figure in `historical_agency_crime` |
| source | where the crosswalk row came from |

How to use it: select the rows of the county. One row: that agency answers only if the period asked lies within `first_year` to `last_year`; a row whose `last_year` is far behind the latest data year is not an answer for a recent period (Clark County NV has only NV0020000, last 1973; its successor NV0020100 is not a county-type agency and is not in this file). More than one (66 counties): drop the agencies whose `last_year` is far behind the latest data year only when exactly one remains; otherwise ask which agency is meant. Baltimore County MD has two rows, MD0030000 (last 2000) and MD0030100 (last 2025), so it resolves to MD0030100.

Known source defect, copied and not repaired: VA0020000 (Albemarle County, last data 1984) carries FIPS 51540 (Charlottesville) under the county name Albemarle. The test names it as the only allowed case.

Regenerate: `python scripts/export_agency_county_reference.py <crime_data.db>`.

## agency_succession.csv

One row per merged agency (`rule` = `merge`) and one per deliberate exclusion (`rule` = `exclude`: Jacksonville FL and Kankakee IL look like mergers and are not). A merge row names the successor (`successor_ori9`), the predecessor (name, last year with real data, SHR predecessor ORI when SHR needs one), the display names the sources print, and the evidence. After `predecessor_last_year` the predecessor's rows are ignored and the alias resolves to the successor.

Until the engine reads this file the source is `lib/agency-consolidations.ts` and the file is its export: `tsx scripts/export-agency-succession.ts`. `scripts/test-agency-reference-agrees.ts` fails when they differ.

## Checks

- `python scripts/test_agency_reference.py` checks both files on their own (columns, ORI shape and state, unique keys, one FIPS per county key, sorted rows, the expected counts: 3,124 rows, 3,058 counties, 66 with more than one county agency, 15 merges, 2 exclusions, Baltimore County).
- `--db <crime_data.db>` also requires `agency_county.csv` to equal a fresh export of the database.
- `--release <canonical dir>` also requires every successor ORI to have a header in the latest data year of the release (needs duckdb).

The monthly refresh runs the checks with `--db` and `--release` (docs/runbooks/nibrs-engine-monthly-release.md, step 8).
