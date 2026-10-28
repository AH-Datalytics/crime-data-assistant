# NIBRS property value outliers: report for the owner's C4 decision

**Owner, 2026-10-28 (relayed by the NIBRSAI session):** "There are property value outliers that are $10,000,000 or
$999,999,999 that shouldn't be included. I'd like to find those and discuss whether to exclude them."

This report gives the facts for that discussion. It sets no rule. Semantic v1 keeps every value
(`property.value@1`), and a chosen rule becomes `property.value@2` with its own shadow difference.

## Source and method

- **Source:** every property segment (03) in the FBI's archived NIBRS master files for data years 2017-2026 (the
  FBI's re-upload of 2026-08-14), read from nibrs-model's ZIP archive by SHA-256 (listed in the scan's
  `scan_info.json`). The scan read the files only. It did not use production, nibrs.db or the server.
- **Scope:** 2017-2026 only, the years that share the E2017 record layout with a verified field map. That is
  103,371,263 segments. Earlier years use other layouts and are not covered here.
- **Field:** value is positions 37-45, nine digits, so **$999,999,999 is the field's maximum**. A blank value is
  "not reported", which is not $0. Segments with loss type None (1) or Unknown (8) have no description and no value.
  Lines whose last two blank positions were trimmed (100 characters instead of 102) were padded back; every 03 line
  was read.
- **Not removed:** repeated identical incidents (nibrs-model build rule T1). They remain in these counts; their effect
  on dollars was not measured.
- **State:** the ORI's first two letters. Federal agencies (for example `DCFBIWA01`) fall under their ORI's prefix.
- **Code:** `scripts/nibrs-property-value-scan.py` (the scan) and `scripts/nibrs-property-value-report.py` (the
  tables). Output is in `nibrs-property-value-outliers/`:
  - `tables.md`: every table cited here;
  - `by_year_description.csv`: segments, blanks, zeros, dollars, maximum and power-of-ten bands per year, loss type
    and description;
  - `sentinel_agencies.csv`: every agency-year holding a candidate sentinel, another repeated value of rule A+ or $10,000,000;
  - `stolen_by_state_year.csv`: stolen dollars by state and year, as reported and under each candidate rule.

## Findings

1. **A few repeated values account for most reported property dollars.**
   - In 2020 and 2021, segments of $1M or more hold 99.4% of all property dollars ($2.48 trillion and $3.54 trillion).
   - Stolen dollars as reported: $1,218.68B in 2020 and $1,770.68B in 2021. In 2017 they were $5.61B.
2. **$999,999,999 (the field maximum)** appears in 5,619 segments ($5.62 trillion).
   - It comes from 90 agencies. 5,575 of the segments are in New York, from 62 agencies, nearly all in 2020 (2,432)
     and 2021 (3,031).
   - The largest agency-years are `NY0320100` 2021 (764), `NY0320100` 2020 (399) and `NY0270000` 2020 (378).
   - It appears under 52 property descriptions, led by Other (77: 2,021), Vehicle parts (38: 593) and Automobile
     (03: 445).
3. **$999,999,998** appears in 1,416 segments from 6 agencies, 2018-2024. 1,414 are in New York, from 4 agencies
   (`NY0015300` leads), nearly all in 2021-2023.
4. **$9,999,999** appears in 618 segments: 593 in New York, mostly `NY0303000` in 2023-2026 (583 of them).
5. **$99,999,999** appears in 26 segments from 12 agencies in NY, WA, IN and others.
6. **Other repeated values** come mostly from a handful of New York agencies, mainly `NY0320100` and `NY0303000`:
   - $7,777,777: 47 segments, all in New York;
   - $1,111,111: 28 segments, 24 in New York and 4 from `GA0660000` (2), `WA0060000` and `LA0530100`;
   - $19,999,998: 24 segments, all from `NY0303000`.
7. **$10,000,000** (named by the owner) is spread differently from the values above:
   - 112 segments from 75 agencies in many states (CA 16, MI 12, DC 11);
   - mostly Money (20) and Other (77);
   - no agency has more than 5 in a year.

   $100,000,000 is similar: 74 segments from 50 agencies. Round values from $1M to $5M are also spread widely ($1M:
   1,729 segments from 876 agencies). The file cannot tell an estimate from a placeholder: that any of these values,
   the candidate sentinels included, was entered as a placeholder is a reading of the pattern, not something the file
   records.
8. **Large values that are not sentinels remain.** After the exact sentinels are removed, the largest stolen segments
   include:
   - `MI8121800` 2022, Money, $998,000,000;
   - `KY0568000` 2021, Lawn/yard/garden equipment, $967,657,321;
   - `TX2080000` 2026, Trucks, $900,000,000;
   - `NY0320100` 2025, Other, $599,999,999.

   25 such stolen segments are $500M or more (the "largest stolen segments" table).
9. **Some agencies routinely report values of $1M or more, beyond the sentinels.** There are 77 agency-years with 10 or
   more such segments, led by:
   - `NY0303000`: 195 in 2023, then 167, 139 and 118;
   - `DCFBIWA01`: 79 in 2022;
   - `VAPO0087Y`: 66 in 2025;
   - `AL0020100`: 58 in 2022;
   - `CA0194200`: 57 in 2025.

   The file cannot say whether these are genuine large losses.

## Candidate rules and what each removes (2017-2026)

Each rule removes segment values from the dollars; segment counts (`property.segments`) stay unchanged.

| Rule | Definition | Segments | Dollars | Stolen segments | Stolen dollars | Agencies | Agency-years |
|---|---|---|---|---|---|---|---|
| A | exact sentinels: 999,999,999; 999,999,998; 99,999,999; 9,999,999 | 7,679 | $7,043.78B | 3,654 | $3,410.64B | 116 | 217 |
| A+ | A plus the other repeated values 7,777,777; 1,111,111; 19,999,998 | 7,778 | $7,044.66B | 3,687 | $3,410.93B | 122 | 225 |
| B | A plus a cap per description (the description table's "Rule B cap" column is the definition): over $1M for everyday goods (clothes, household goods, tools, vehicle parts, phones ...); over $100M for money, instruments, structures, merchandise, aircraft, buses, trucks, watercraft, farm, industrial and logging equipment, crops, non-precious metals; over $10M for every other description (automobiles, other motor vehicles, jewelry, Other ...) | 8,673 | $7,116.81B | 4,393 | $3,464.57B | 524 | 773 |
| C | A plus an agency-year flag: in an agency-year with 10 or more non-sentinel segments of $1M or more, every value of $1M or more is excluded | 9,851 | $7,079.33B | 5,467 | $3,437.58B | 138 | 283 |

The cap for each description is in the description table. The caps are a starting proposal for discussion. They are
not derived from the data.

Beyond rule A:
- rule B removes mostly Money ($24.08B), Other ($12.94B) and Automobile ($9.66B), from 427 agencies (524 with rule A's);
- rule C removes mostly Money ($14.52B), Other ($7.28B) and Automobile ($4.79B), from the 77 flagged agency-years.

**Stolen dollars, all states:**

| Year | Reported | Rule A | Rule A+ | Rule B | Rule C |
|---|---|---|---|---|---|
| 2017 | $5.61B | $5.60B (-0.2%) | $5.60B (-0.2%) | $5.23B (-6.9%) | $5.60B (-0.2%) |
| 2018 | $8.65B | $7.64B (-11.7%) | $7.64B (-11.7%) | $6.48B (-25.1%) | $7.64B (-11.7%) |
| 2019 | $59.23B | $9.20B (-84.5%) | $9.20B (-84.5%) | $8.40B (-85.8%) | $9.18B (-84.5%) |
| 2020 | $1,218.68B | $12.48B (-99.0%) | $12.47B (-99.0%) | $10.45B (-99.1%) | $12.44B (-99.0%) |
| 2021 | $1,770.68B | $23.13B (-98.7%) | $23.05B (-98.7%) | $18.08B (-99.0%) | $21.56B (-98.8%) |
| 2022 | $165.46B | $36.28B (-78.1%) | $36.27B (-78.1%) | $25.14B (-84.8%) | $31.99B (-80.7%) |
| 2023 | $293.74B | $36.34B (-87.6%) | $36.26B (-87.7%) | $30.01B (-89.8%) | $32.49B (-88.9%) |
| 2024 | $46.76B | $36.62B (-21.7%) | $36.56B (-21.8%) | $30.18B (-35.5%) | $32.42B (-30.7%) |
| 2025 | $43.85B | $41.08B (-6.3%) | $41.05B (-6.4%) | $28.04B (-36.1%) | $30.30B (-30.9%) |
| 2026 | $32.52B | $26.17B (-19.5%) | $26.16B (-19.6%) | $18.62B (-42.7%) | $23.98B (-26.3%) |

The stolen dollars of 36 state-years fall by 10% or more under rule A. Under rule B it is 111, and under rule C 57, out
of 506 state-years. New York in 2019-2023 falls by 99-100% under every rule: 2021 goes from $1,742.72B to $587.3M under
rule A. Other large moves under rule A:
- Indiana 2021: -87%;
- Ohio 2023: -74%;
- Nevada 2024: -66%;
- Indiana 2023: -66%;
- Texas 2026: -39%;
- Alabama 2021: -31%.

Every state-year is in `stolen_by_state_year.csv`.

## Today's rule, for comparison

Today's C4 rule sets the dollars to zero on a summary row whose average value is $1M or more, and keeps the row's
count. A summary row is one agency, year, offense, loss type and description. That rule is not compared here: it needs
today's summary tables, which come from production. Its shadow difference against v1 is declared in the semantic v1
definitions (C4, test T8). A per-segment rule differs from it in two ways:
- a single $999,999,999 segment in a row of many ordinary segments can leave the row's average under $1M, so today's
  rule keeps it;
- a genuine $1.2M loss in a row of its own is zeroed by today's rule and kept by rule A.

## For the discussion

1. Which rule, if any, becomes `property.value@2`: A, A+, B or C?
2. Is $10,000,000 a sentinel? Here it looks like a rounded entry spread across many agencies, unlike the New York
   repeated values. The same question applies to $100,000,000.
3. For rule B: the caps per description.
4. For rule C: the threshold (10 segments) and whether flagged agency-years are excluded or only flagged.
5. Whether answers about property value say that values were excluded. Under the result-column rule that would be one
   of the fixed answer statements, never a column.
