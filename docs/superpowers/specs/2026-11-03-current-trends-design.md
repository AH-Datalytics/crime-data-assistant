# Current Trends in the new engine: design note

**Status:** design. Decisions for Jeff are in section 8. No build yet.

**The ruling this note follows.** Jeff: "Historical data strictly comes from the Crime Index", "as does current". So Current Trends is the Crime Index's data, not the app's live RTCI tables.

**Naming (settled, contract proposal):**
- The user sees "Current Trends"; the long form is "Crime Index's Current Trends data".
- The source line is "Source: Crime Index."
- "Real-Time Crime Index" and "RTCI" are never shown.

## 1. What it compiles against

**The archived Crime Index snapshot `current_crime` 20261101** (nibrs-model `manifests/crimeindex-archive.json`, checked by SHA-256). This is crimeindex.org's public download.

| File | Rows | Span |
|---|---|---|
| current_crime_2025-2026.csv | 17,567 | 2025-01 to 2026-08 |
| 082026 - Final.csv (the Final panel the site is built from, archived with it) | 83,415 agency-months | 2017-01 to 2026-08, 719 agencies |

**Rows of current_crime.** Each row is a place, a size and a month. The places are:
- an agency (an ORI; 719 of them, the same agencies as the Final panel, where Pontiac, MI has a known ORI alias);
- a state (lowercase code; 45, DC among them);
- a region (mdw, noe, sth, wst);
- the nation (us).

Groups also come by population size (sm, md, lg, xl).

**Columns of current_crime.**
- For the nine offenses (violent, murder, rape, robbery, assault, property, burglary, theft, motor): the month's count `*_total`, the year to date `*_ytd`, the rolling 12 months `*_roll`, and the published change `*_change`.
- Also: `population`, `agencies` (the group's agency count) and `sample` (on agency rows: whether the agency is in the Consistent Reporting Agencies).

**The build.** The Crime Index build (scripts/build-crimeindex.py) gains:
- `current_crime` (agency rows; NULL stays NULL);
- `current_final` (the Final panel's agency-months, as the independent second check).

A month the site doesn't publish has no row, and it is read as unknown, never zero. This is nibrs-model's reader rule (correctness/current_trends.py).

**Group totals (P90, P91, settled).** A state, region, size group or the nation is the sum of its agencies with `sample = true`, computed by the engine.
- Blank cells are left out and counted.
- A cell is null when every agency's value is blank.
- The population is the summed current population, and the sentence is P90's.

The published group rows are never shown. They print 0 where every agency in the group is blank, and an unknown period is never 0.

nibrs-model's V173–V176 are the expected values for 2026-08 under exactly this rule: the nation, regions, states and size groups, with 547 agencies nationally.

## 2. The tab's real first questions (step one)

There are 1,701 first questions from the old Current Trends tab. The questions stay in the engine session's scratchpad; only counts are here.

**What period they ask about:**

| Period | Questions |
|---|---|
| no year named | 939 |
| no year, relative words ("this year", "since") | 34 |
| only 2025–2026 | 175 |
| reaches back into 2017–2024 | 511 |
| before 2017 | 42 |

**Shapes:**
- 350 ask by month. Of those, 151 name no year and 80 run from 2018.
- 143 ask for rolling or trailing 12 months.
- 183 ask for a ranking ("most", "highest", "top 10").
- 270 ask about the nation.
- 798 are about murder or homicide.
- 193 ask for a rate.
- 53 ask for a change from last year.
- 18 ask for the year to date.

**Today's engine on them (no Current Trends route; NIBRS and Historical answering):**
- answers 386;
- asks 747;
- declines well 296;
- declines badly 272.

The asks are mostly "which period" and "which place". The bad declines are mostly reader slips:
- "rolling over 12 months";
- "to present";
- ordinary words read as places;
- "LA" and "NY".

**What this says.**
- (a) The archived current_crime covers only 2025–2026, but nearly a third of the questions reach 2017–2024 by month. The Final panel has those months for its 719 agencies (decision A).
- (b) Murder is almost half the tab, so homicide routing (section 4) matters most.
- (c) Rolling 12 and "to present" are reader work, shared with every source.

## 3. What is in, and what is out (first increment)

**In:**
- **Offenses.** Violent and property crime, plus the seven Part I offenses, as published.
- **Places:**
  - an agency in Current Trends (through the shared place index; its `sources` gains `current_trends`);
  - a state;
  - a region ("the Northeast"; reader work);
  - the nation;
  - several named agencies side by side.
- **Periods:**
  - one month;
  - a range of months, by month;
  - the year to date, through the latest month (named by months, D06);
  - the rolling 12 months;
  - the same months a year earlier, compared.

  Months from 2025-01 through 2026-08. Earlier months depend on decision A.
- **Statistics:**
  - counts;
  - the published change for an agency;
  - for a group, the change computed from two consistent sums, never mixed with the published group change.
  - Rates: decision C.

**Out (declined plainly, with the nearest question):**
- clearances (current_clearances: a later increment);
- any offense outside Part I (that's NIBRS, routed);
- details such as weapon, demographics or relationship (NIBRS or SHR, routed);
- rankings: decision D.

## 4. Routing between sources

Routing is decided by what's asked, never by which tab it was asked in. Each rule is a scored routing case, with real questions where the log has them.

| Asked | Goes to | Why |
|---|---|---|
| A Part I offense, by month, 2025-01 or later, at a Current Trends agency, state, region or the nation | Current Trends | its grain and its period |
| The same, for an agency not in Current Trends | NIBRS monthly, with its own source line | the only monthly source for that agency |
| A completed year, a Part I offense | Historical (Crime Index annual) | P01, P75 |
| This year so far, or the latest months | Current Trends (NIBRS when it's asked by name) | Current Trends has the latest month, NIBRS lags |
| Homicide count, recent months | Current Trends | same |
| Homicide count, completed years | Historical | P01 |
| Homicide with victim or offender details (age, sex, race, relationship, weapon, circumstance) | decision B | |
| Victim demographics for other crimes | NIBRS | only NIBRS has them |
| A month before 2025 | decision A | |

**The measure.** Report routing accuracy (the share of routing cases sent to the labeled source) beside each source's answered / declines well / declines badly on its own query log.

## 5. Shared reading folded in, measured on this log

- **Rolling or trailing 12 months, "over 12 months", "to present", "so far this year".** These are period words in the shared reader.
- **Regions** ("the Northeast", "the South") as Current Trends places. Today "northeast" is read as a place name and not found.
- **"LA", "NY" and the like.** A two-letter state code alone is the state, and "LA" asks between Los Angeles and Louisiana (P28 style). "NYC" stays the city.
- **A place with no crime** asks which crime (D31), on Current Trends' own measures.
- **Misspelled places** ("phialdelphia", "batlimore"): the shared reader's spelling pass, extended to the place index's names.

Each of these is a class. A fix that helps only one question is said so in the PR.

## 6. Profile (contract)

- `units`: offenses by agency by month.
- `grain`: monthly, with the latest month of the build (2026-08) named.
- `coverage.published`: true for agencies.
- `coverage.cohortView`: groups are Consistent Reporting Agencies only (P91), with P90's sentence. There is no all-agencies view.
- `rateBasis`: decision C.
- `breakdowns`: none.
- `caveats`: the group sentence (which agencies a total covers). A blank month is shown blank, never zero.
- `vocabulary`: the Historical terms, plus "homicides" and "killings".

## 7. Checks

- **Expected values.** nibrs-model's V173–V176 (group sums for 2026-08). An agency's values are the snapshot's own row, checked against the Final panel (current_trends.py --check-final).
- **Scored cases.** LS-441 onward:
  - groups (nation, region, state, size) against V173–V176;
  - agency months;
  - year to date and rolling 12;
  - a blank month;
  - the routing rows above.
- **Conformance.** The Current Trends profile joins the fixtures, so every shared check runs on it.
- **The milestone report** gains a Current Trends table.

## 8. Decisions for Jeff

**A. Should months before 2025 for Current Trends agencies come from the archived Final panel?**
- Yes: 2017-01 to 2024-12 for its 719 agencies. These are the agency counts the site was built from, archived and hashed, so 511 questions reaching 2017–2024 can be answered from Crime Index data. Group sums for those years would use each year's consistent agencies.
- No: months before 2025 go to NIBRS (agencies that report to it) or to Historical by year.

**B. Should a homicide question with victim or offender details go to Homicide Reports (SHR) first?**
- Yes: SHR, routed until it's built, and NIBRS only when NIBRS is asked by name.
- No: NIBRS, which has the same details for the agencies that report to it.

**C. Should a Current Trends rate be computed as count ÷ current population × 100,000 (P75's rule)?**
- Yes: computed for the year to date and the rolling 12 months only, never for one month.
- No: Current Trends gives counts and changes only.

**D. Should rankings of Current Trends agencies wait for a later increment?**
- Yes: declined plainly with the nearest question until then.
- No: they're in the first increment (by count or rate, for the latest year to date).
