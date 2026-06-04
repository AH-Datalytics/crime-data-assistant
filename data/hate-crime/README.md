# FBI Hate Crime Database

Source: FBI Crime Data Explorer (CDE) hate crime master files, 1991–2025.

## Schema

### hate_crime_incidents (285,190 rows)
One row per incident-offense combination. Multi-offense incidents are exploded (one row per offense within the same incident).

| Column | Type | Description |
|--------|------|-------------|
| year | INTEGER | Data year (1991–2025) |
| state | TEXT | 2-letter state abbreviation |
| state_name | TEXT | 2-letter state name from BH record |
| ori | TEXT | Agency ORI code |
| agency_name | TEXT | Agency name |
| population | INTEGER | Agency population (from BH record; NULL for 2014 CSV backfill) |
| pop_group | TEXT | Population group code |
| incident_number | TEXT | Incident identifier (unique within ORI+year) |
| incident_date | TEXT | YYYY-MM-DD |
| data_source | TEXT | F=NIBRS, S=SRS (blank for 2014 CSV backfill) |
| quarter | TEXT | 1–4 |
| total_individual_victims | INTEGER | Total individual victims in incident |
| total_offenders | INTEGER | Total offenders in incident |
| offender_race | TEXT | Decoded: White, Black, Asian, etc. |
| offender_ethnicity | TEXT | Hispanic or Latino / Not Hispanic or Latino / Unknown (2020+ only) |
| offense_group | INTEGER | 1–3 (which offense slot within the incident) |
| offense_code | TEXT | NIBRS 3-char code (blank for 2014 CSV backfill) |
| offense_name | TEXT | Decoded offense name |
| offense_victims | INTEGER | Victims for this specific offense |
| location | TEXT | Decoded location name |
| bias_code | TEXT | 2-char bias code (blank for 2014 CSV backfill) |
| bias_desc | TEXT | Decoded bias description (e.g., "Anti-Black or African American") |
| bias_category | TEXT | Grouped: Race/Ethnicity/Ancestry, Religion, Sexual Orientation, Disability, Gender, Gender Identity, Other |
| victim_types | TEXT | I=Individual, B=Business, G=Government, etc. |
| adult_victims | INTEGER | 2020+ only |
| juvenile_victims | INTEGER | 2020+ only |
| adult_offenders | INTEGER | 2020+ only |
| juvenile_offenders | INTEGER | 2020+ only |

### Count Semantics (CRITICAL for prompts)
- **incident_count** = `COUNT(DISTINCT incident_number || ori || year)` — unique hate crime incidents. Use when user says "hate crimes" or "incidents."
- **offense_count** = `COUNT(*)` — total offense records (higher than incident_count for multi-offense incidents). Use when user asks about specific offense types.
- **victim_count** = `SUM(offense_victims)` — total victims across all offenses. Use when user asks about victims.

**Default to incident_count** when the user asks for "hate crimes" without specifying offenses or victims.

### Summary Tables

| Table | Rows | Grain |
|-------|------|-------|
| summary_hate_crime_bias_trend | 826 | year × bias_category × bias_desc |
| summary_hate_crime_offense_trend | 1,194 | year × offense_code × offense_name |
| summary_hate_crime_state | 8,128 | year × state × bias_category |
| summary_hate_crime_location | 1,104 | year × location |

Summary tables use `incident_count` (distinct incidents) and `victim_count` (sum of offense_victims).

### hate_crime_participation (1,934 rows)
Agency participation tracking by state and year.

| Column | Description |
|--------|-------------|
| total_agencies | All agencies that submitted a BH record (including zero-reporters) |
| reporting_agencies | Agencies that reported at least one incident |
| total_incidents | Incident count |
| total_victims | Victim count |

### hate_crime_caveats (6 rows)
Baked-in documentation for mandatory disclaimers.

## Mandatory Caveats (every response MUST include relevant ones)

1. **Reporting is voluntary.** Zero does not mean zero hate crimes — it means the agency didn't report.
2. **Participation has grown.** ~2,700 reporting agencies in 1991 → ~15,000+ today. Trend increases partly reflect more reporting.
3. **Definition changes.** Gender/gender identity added 2013. Arab/Hindu/Sikh added 2015. Age breakdowns added 2020.
4. **Significant undercounting.** BJS estimates actual hate crime victimization is 2–4× higher than FBI data.
5. **Agency variation.** Training and classification practices vary enormously between agencies.
6. **Data source shift.** NIBRS vs SRS mix has changed over time.

## 2014 Source

The CDE online master file `hate-crime-2014.zip` contains 2015 data (FBI mislabeled it). The real 2014 data was sourced from a local copy of the encrypted master file (`HATECYR2014MASTERFXENCRYPTED.zip` → `HCRENC14.DAT`), which has correct BH year = 2014 and IR dates in 2014. This file was obtained directly from the CDE download interface before the mislabeling occurred.

All years including 2014 are parsed from the fixed-width ASCII master files with full code decoding.

## Definition Boundary Years

| Year | Change |
|------|--------|
| 2013 | Gender and gender identity bias categories added |
| 2015 | Arab, Hindu, Sikh, Mormon, Jehovah's Witness, Eastern Orthodox, Buddhist categories added |
| 2020 | Age breakdowns (adult/juvenile victim/offender counts) and offender ethnicity added |

## Rebuild

```bash
# Full rebuild from CDE master files (downloads all years, ~2 min)
python3 -u scripts/import-hate-crime.py --db data/hate-crime/hate_crime.db

# Single year update
python3 -u scripts/import-hate-crime.py --years 2025 --db data/hate-crime/hate_crime.db

# After rebuild, checkpoint and verify
sqlite3 data/hate-crime/hate_crime.db "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA integrity_check;"
```

Note: 2014 must be backfilled separately from the additional dataset CSV (not handled by the import script's master file download). Run the backfill after the main import if 2014 data is deleted.

## Verification

```bash
sqlite3 data/hate-crime/hate_crime.db "
PRAGMA integrity_check;
SELECT MIN(year), MAX(year), COUNT(DISTINCT year), COUNT(*) FROM hate_crime_incidents;
SELECT COUNT(*) FROM hate_crime_incidents WHERE bias_desc GLOB '[0-9]*';
"
# Expected: ok, 1991-2025, 35 years, ~285K rows, 0 unmapped codes
```

## Deployment

1. Copy `hate_crime.db` to VPS: `scp data/hate-crime/hate_crime.db root@178.156.243.51:/opt/nibrs/hate_crime.db`
2. Add `HATE_CRIME_DB_PATH=/opt/nibrs/hate_crime.db` to environment
3. Create `lib/hc-db.ts`, `lib/hc-claude.ts`, `app/api/hc-query/route.ts`
4. Add tab to V2 frontend
