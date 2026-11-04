# Current Trends in the new engine: design note

**Status:** design, revised after Codex design check 01 (REVISE; all eight findings applied; confirmation ACCEPT). Jeff decided A, B and C as recommended (2026-11-03, section 8). No build yet.

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
| 082026 - Final.csv (the Final panel the site is built from, archived with it) | 83,415 rows: 83,404 agency-months with an ORI, 11 without | 2017-01 to 2026-08, 719 agencies |

**Rows of current_crime.** Each row is a place, a size and a month. The places are:
- an agency (an ORI; 719 of them, the same agencies as the Final panel, where Pontiac, MI has a known ORI alias);
- a state (lowercase code; 45, DC among them);
- a region (mdw, noe, sth, wst);
- the nation (us).

Groups also come by population size (sm, md, lg, xl).

**Columns of current_crime.** For the nine offenses (violent, murder, rape, robbery, assault, property, burglary, theft, motor):
- `*_total`: the month's count.
- `*_ytd`: the year to date through that month.
- `*_roll`: the rolling 12 months.
- `*_change`: **the percent change of the year to date against the same months of the year before.** It is not the month's change (Codex 01.1, checked on all 44,668 comparable 2026 values). For example, MN0270600's August property count is 88 against 87, but its published change, 8.3%, is year to date 524 against 484.

Also: `population`, `agencies` (the group's agency count) and `sample` (on agency rows: whether the agency is in the Consistent Reporting Agencies).

**The Final panel** has agency-month counts for the seven Part I offenses, with no population and no sample flag. 80 of its rows before 2025 are entirely blank.

**The build.** The Crime Index build (scripts/build-crimeindex.py) gains:
- `current_crime` (agency rows; NULL stays NULL);
- `current_final` (the Final panel's agency-months with an ORI).

The Final panel is a **cross-path check**, not an independent one (Codex 01.8). It is the panel the site is built from, so matching it shows the snapshot was read faithfully; it doesn't confirm the underlying counts. A month the site doesn't publish has no row, and it is unknown, never zero (nibrs-model's reader rule, correctness/current_trends.py).

**Group totals (P90, P91, settled).** A state, region or the nation is the sum of its agencies with `sample = true`, computed by the engine.
- Blank cells are left out and counted.
- A cell is null when every agency's value is blank.
- The population is the summed current population, and the sentence is P90's.

The published group rows are never shown. They print 0 where every agency in the group is blank, and an unknown period is never 0. nibrs-model's V173–V176 are the expected values for 2026-08 under exactly this rule (547 agencies nationally); Codex 01 reproduced them.

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
- (a) The archived current_crime covers only 2025–2026, while 511 questions reach into 2017–2024. Some of them could use the Final panel's agency months (decision A). How many would then be answered isn't established until it's built and measured.
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
- **Periods**, 2025-01 through 2026-08 from current_crime; for an agency, also 2017-01 through 2024-12 from the Final panel (decision A). A group before 2025 is declined, with the nearest question, until a cohort rule is decided:
  - one month;
  - a range of months, by month;
  - the year to date, through the latest month (named by months, D06);
  - the rolling 12 months;
  - the same months a year earlier, compared.

**Missing months (Codex 01.2): a total is never shown as complete when its months aren't.**
- **An agency's one month:** the snapshot's cell, blank when unknown.
- **An agency's year to date or rolling 12 months:** the published value only when every month in its span is known for that offense. Otherwise it's blank, with a note naming the unknown months.

  The published cumulative values can span unknown months. MO0922400's property counts for January–March 2025 are 37, blank, 16, yet its March year to date is 53. MA0110400 has no May 2025, yet its December rolling property total is 449.
- **A group:** the consistent sum, with each offense's left-out agencies named in a note. V173's national rape total for August 2026 leaves out 14 of the 547 agencies, and the coverage sentence alone doesn't say so.

**Statistics:**
- Counts.
- **Change:**
  - the published change, only for the year to date against the same months a year earlier;
  - any other comparison (one month or the rolling 12 against a year earlier, or a group) is computed from two complete values;
  - it is blank when either side is unknown, and when the earlier value is 0 (P55's zero base).

  The published change is never shown for a month.
- **Rates** (decision B): count ÷ current population × 100,000, by P58 and P59 (section 8).

**Out (declined plainly, with the nearest question):**
- clearances (current_clearances: a later increment);
- size groups (sm, md, lg, xl): a later increment, since the reader has no words for them yet;
- any offense outside Part I (that's NIBRS, routed);
- details such as weapon, demographics or relationship (routed; section 4);
- rankings (decision C): a later increment, done once for every source with the agency-set work.

## 4. Routing between sources

Routing is decided by what's asked, never by which tab it was asked in. **Precedence (Codex 01.5):**
1. a source named in the question (P01's override, on every row below);
2. the measure and its details;
3. the grain asked;
4. which sources actually hold that place and period.

An offered alternative (Historical by year for a monthly question it can't answer) is a button, never the answer to the question asked.

| Asked | Goes to | Policy |
|---|---|---|
| Homicide with victim or offender details (age, sex, race, relationship, weapon, circumstance) | Homicide Reports (routed until built; P92's all-reporting-agencies default) | P01, P53: settled |
| Victim or offender details for other crimes | NIBRS | P01 |
| Clearance, an agency, a completed year | Historical (Crime Index clearances) | P57 |
| A Part I offense by month, 2025-01 to 2026-08, at a Current Trends agency, a state, a region or the nation | Current Trends | its grain and period |
| The same at an agency Current Trends doesn't have | NIBRS monthly, with its own source line | P01's fallback |
| A Part I offense, a completed year (no month asked) | Historical | P01, P75 |
| The same at an agency Historical doesn't have | NIBRS | P01's fallback |
| A Part I offense, months before 2025, at a Current Trends agency | Current Trends (Final panel) | decision A |
| The same for a state, region or the nation | declined until a cohort rule; the nearest question offered | decision A |
| A Part I offense, months after 2026-08 (NIBRS's build runs to 2026-09) | NIBRS when it has the agency; otherwise the period is outside the data | availability |

The details rows come before the count rows (precedence 2). A monthly question keeps its monthly grain (precedence 3): it is never answered by a year's total.

**The measure.** Report routing accuracy (the share of routing cases sent to the labeled source) beside each source's answered / declines well / declines badly on its own query log.

## 5. Shared reading folded in, measured on this log

- **Rolling or trailing 12 months, "over 12 months", "to present", "so far this year".** These are period words in the shared reader.
- **Regions** ("the Northeast", "the South") as Current Trends places. Today "northeast" is read as a place name and not found.
- **"LA", "NY" and the like.** A two-letter state code alone is the state, and "LA" asks between Los Angeles and Louisiana (P28 style). "NYC" stays the city.
- **A place with no crime** asks which crime (D31), on Current Trends' own measures.
- **Misspelled places** ("phialdelphia", "batlimore"): the shared reader's spelling pass, extended to the place index's names.

Each of these is a class. A fix that helps only one question is said so in the PR.

## 6. Profile and contract changes

- `units`: offenses by agency by month.
- `grain`: monthly, with the latest month of the build (2026-08) named.
- `coverage.published`: true for agencies.
- `coverage.cohortView`: groups are Consistent Reporting Agencies only (P91), with P90's sentence. There is no all-agencies view.
- `rateBasis`: count ÷ current population × 100,000 (decision B).
- `breakdowns`: none.
- `caveats`:
  - the group sentence (which agencies a total covers);
  - each offense's left-out agencies;
  - a cumulative total left blank for its unknown months.
- `vocabulary`: the Historical terms, plus "homicides" and "killings".

**Contract changes (Codex 01.7)**, declared in the same PR so conformance can't silently misstate the scope:
- the cohort's place levels gain region;
- (`rateBasis` "none" isn't needed: decision B is yes.)

## 7. Checks

- **Expected values.** nibrs-model's V173–V176 (group sums for 2026-08). An agency's values are the snapshot's own row, checked against the Final panel (current_trends.py --check-final; August 2026: 558 rows equal, 161 blank rows in the Final panel only, no differences).
- **Scored cases.** LS-441 onward:
  - groups (nation, region, state) against V173–V176, including the rape total that leaves out 14 agencies;
  - agency months;
  - year to date and rolling 12, complete and incomplete (MO0922400, MA0110400);
  - a change: the published year to date, a computed month, and a zero base;
  - a blank month;
  - the routing rows above.
- **Conformance.** The Current Trends profile joins the fixtures, so every shared check runs on it.
- **The milestone report** gains a Current Trends table.

## 8. Decisions for Jeff (decided 2026-11-03: A, B and C yes, as recommended)

**A. Should earlier months for Current Trends agencies come from the archived Final panel?** Jeff: yes.
- Yes: the agency months it has for 2017-01 to 2024-12, as published input to the site (unknown months stay blank). Group totals for those years wait for a later decision on which agencies count. The Final panel has no sample flag or population, so a group's cohort would have to be derived; until then, a group before 2025 is declined with the nearest question.
- No: months before 2025 go to NIBRS (agencies that report to it), with Historical by year offered as a button.

**B. Should a Current Trends rate follow P58 and P59?** Jeff: yes.

P75 covers Historical's published rates, not this, so this is a new rule (Codex 01.3).
- Yes: count ÷ the agency's current population × 100,000, and for a group, ÷ the summed population of the agencies with a value for that offense. The rate is:
  - only for a period whose every month is known (P58);
  - named by its months and never annualized (P59);
  - never given for a single month (a scope choice);
  - never given when the population is missing or zero.
- No: Current Trends gives counts and changes only, and `rateBasis` is "none".

**C. Should rankings of Current Trends agencies wait for a later increment?** Jeff: yes, done once for every source with the agency-set work.
- Yes: declined plainly with the nearest question until then.
- No: in the first increment, by count, or by rate if B is yes: the latest year to date, among agencies whose every month is known, with the others named as left out.

Homicide details are not a decision: P01 and P53 already send them to Homicide Reports (section 4). An amendment would be Jeff's call.
