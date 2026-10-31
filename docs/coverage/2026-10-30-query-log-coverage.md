# Query-log coverage review (NIBRS engine session, 2026-10-30, r2)

How real users have asked for the data, against what the engine has built, what is planned and what nothing covers yet.
Asked by the NIBRSAI coordinator after PR #78. Jeff approved the production read on 2026-10-30.

r2 applies Codex review 01 (REVISE). Its changes:
- personal details are redacted;
- source is the one policy requires, not the tab;
- D31 is applied to place and crime as well as period, with grain words no longer counted as a period;
- D03 is applied;
- status is judged by place level;
- the gaps are re-sized;
- the policy questions are cut to the one that is new;
- the held-out readings are separated into policy reading, first action and today's status.

## Source and method

- **Read:** one read-only pass over production `/opt/nibrs/shared/query_log.db` (`sqlite3 -readonly`, `nice -n 19 ionice -c3`), on 2026-10-30.
  - `maintenance.lock` and `release.lock` were checked first and again right before the read: no process held either.
  - Copied: the question text and its metadata (id, timestamp, tab, routing mode, record kind, reason code, delivery action, row count, an error flag).
  - Not copied: session ids, visitor data, SQL, responses.
  - The copy stays local, outside the repo. No other production action was taken.
- **Span:** 2026-03-12 to 2026-10-30. 10,667 logged questions; 4,609 distinct after normalizing case, spacing and final punctuation.
- **Synthetic traffic:** 76 distinct questions match a string in the repo's own scripts and are left out, leaving **4,533 distinct real questions**.
  - The owner's and the team's own testing are still included; the log cannot separate them without session data.
  - Counts are of distinct questions; `times_asked` gives how often each was asked.
- **Privacy:**
  - Free text can identify people even without session data. One question gave a street address tied to a business; two told personal stories.
  - These are redacted in the committed file (`[address redacted]`, `[personal detail redacted]`), keeping the question's shape.
  - A scan found no email addresses, phone numbers or other addresses.
  - Area zip codes asked about ("crimes in zip code 07040") are kept: they identify no one, and they are the evidence for the gap of areas below the agency.
- **Classification:** rule-based (`classify_query_log.py`, first matching rule wins).
  - **Shape:** the coordinator's list, plus *follow-up (needs context)* for turns that only make sense after an earlier answer.
  - **Place level:** from the repo's own place resolver (`lib/geo-place-resolver.ts`), with national wording and unnamed lists of cities or agencies read as national.
  - **Source:** the one P01, P53 and P57 require, kept apart from the tab. The tab stays in the file as provenance.
    - homicide victim and offender details: SHR;
    - hate crimes: the Hate Crime file;
    - police staffing: Historical;
    - details only NIBRS records, and NIBRS-only crimes: NIBRS;
    - Part I crimes and clearance: Current Trends for this year or monthly series, otherwise Historical;
    - no crime named: *unresolved*.
  - **Correct action:**
    - decline when out of scope;
    - for a rate for a population group, decline the rate and offer counts or shares (D03);
    - clarify when the crime, the place or the period is missing (D31/P06). "Per month", "by year", "over time" and "trend" are grain, not a period;
    - *needs context* for follow-ups;
    - otherwise answer.
  - **Status, judged at the question's place level:**
    - **B:** built (a numeric answer, a named route or a decline);
    - **P:** planned (the increment, or that source's step in `docs/superpowers/specs/2026-10-28-engine-other-sources.md`, in the order SHR, Historical, Current Trends, Hate Crime);
    - **G:** gap;
    - **C:** clarify first (no crime named; asking is the policy action).
- **Accuracy (hand audits):**
  - **r1's rules:** Codex audited 50 rows and found shape 88%, source (then the tab) 86%, action 76%, shape-or-action 66%.
  - **r2's rules:** a fresh 60-row audit found shape about 93%, source about 97%, action about 93%, shape-or-action about 88%.
    - The audit was taken before a final fix that reads unnamed lists of cities as national, which removed two of its action errors.
    - Counts are a size guide, not a score, and are not bounded per cell. Codex's re-check gives a second audit.
- **Files:**
  - `2026-10-30-query-log-classification.csv`: every distinct real question, redacted, with times asked, tab, shape, place level, source, correct action, status and the actions logged for it.
  - `classify_query_log.py`: the rules.

## Coverage: shape by source (the source policy requires)

Each cell gives the number of distinct questions, then its split by status:
- **B** built;
- **P** planned;
- **G** gap;
- **C** clarify first.

A built cell means built *for that place level*. The CSV's status column names the increment or the missing piece for each question.

| Shape | NIBRS | Crime Index historical | Crime Index current | SHR | Hate Crime | unresolved | All |
|---|---|---|---|---|---|---|---|
| count | 113 (B 97, P 16) | 519 (B 87, P 432) | 27 (B 5, P 22) | 45 (P 45) | 12 (P 12) | 231 (C 231) | 947 |
| rate | 7 (B 7) | 228 (B 55, P 173) | 16 (B 5, P 11) | 5 (P 5) | 0 | 7 (C 7) | 263 |
| trend | 180 (B 170, P 5, G 5) | 797 (B 185, P 612) | 195 (B 39, P 156) | 96 (B 2, P 94) | 32 (P 32) | 109 (C 109) | 1,409 |
| period comparison | 4 (B 4) | 67 (B 7, P 60) | 19 (B 1, P 18) | 11 (P 11) | 0 | 16 (C 16) | 117 |
| place comparison | 20 (B 15, P 1, G 4) | 182 (P 182) | 13 (B 1, P 12) | 16 (P 16) | 4 (P 4) | 22 (C 22) | 257 |
| ranking | 23 (B 8, P 1, G 14) | 166 (P 166) | 22 (B 16, P 6) | 18 (P 18) | 7 (P 7) | 39 (C 39) | 275 |
| share/breakdown | 134 (B 16, P 92, G 26) | 81 (P 81) | 1 (P 1) | 153 (B 12, P 141) | 4 (P 4) | 34 (C 34) | 407 |
| cross-segment | 28 (P 28) | 3 (P 3) | 0 | 22 (B 5, P 17) | 0 | 1 (C 1) | 54 |
| lookup/list | 17 (G 17) | 14 (G 14) | 0 | 1 (G 1) | 3 (G 3) | 14 (G 14) | 49 |
| method/definition | 6 (G 6) | 7 (G 7) | 0 | 0 | 0 | 7 (G 7) | 20 |
| follow-up (needs context) | 40 (G 40) | 38 (G 38) | 1 (G 1) | 2 (G 2) | 2 (G 2) | 596 (G 596) | 679 |
| out of scope | 3 (B 3) | 22 (B 22) | 2 (B 2) | 1 (B 1) | 1 (B 1) | 27 (B 27) | 56 |
| All | 575 | 2,124 | 296 | 370 | 65 | 1,103 | 4,533 |

Totals: built 793, planned 2,484, gap 797, clarify first 459.

What the status means at each level:
- **NIBRS:**
  - Built for an agency: counts, rates, trends, comparisons, a state's agencies ranked, one-way breakdowns, clearances and property selections (increments 1-6).
  - Built for a state or the nation: a count, counts by year, and a rate for one year (increment 5).
  - Not built for states and the nation: monthly series, rates by year, breakdowns, comparisons, rankings.
  - Person attributes are planned in increment 7, two-way breakdowns in 8, new fields in 9.
- **Historical:**
  - Built for states and the nation: counts, rates and trends (increment 5). The national clearance rate is built for one year only; a clearance series, or a state's clearance, is planned.
  - Planned (the Historical source step): every agency question, rankings, place comparisons and staffing.
  - Clearance by type (arrest or exceptional) is NIBRS's, not Historical's: the historical file holds published percentages.
- **Current Trends:** built for states and the nation as a named route; planned (the Current Trends source step) for numbers.
- **SHR:** built as a named route for victim-offender relationship; planned (the SHR source step) for everything else.
- **Hate Crime:** planned.

**Where the planned demand is:**
- **Historical, about 1,570 agency questions, the largest:** counts, trends, rates, rankings and comparisons of Part I crimes for one agency. Another 123 are about staffing.
- **SHR, about 350.**
- **Current Trends, about 230.**

## Gaps (for the coordinator)

1. **Follow-ups, 679 (15% of questions), the largest gap.**
   - Examples: "percent change", "make this a rate", "only show homicide now", "show this by year for 2023 to 2025", "stop counting in April 2026", chart edits.
   - The shadow reads one question, and the scorer does not measure follow-up turns.
   - No increment carries the conversation state these need: the previous plan, edited.
2. **NIBRS for states and the nation, beyond plain sums, 49:**
   - breakdowns, 26 ("juvenile arrests by race nationally");
   - rankings of states or of cities nationally, 14;
   - monthly or rate series, 5;
   - comparisons, 4.
   - The coverage note's plan says state and national breakdowns follow each increment's gate, but no increment names them.
3. **Lookups and lists, 49:**
   - coverage and participation ("how many agencies reported NIBRS data in 2023", "which agencies are in Cook County");
   - code lists;
   - agency directories.
   - Nothing in the plan language answers these.
4. **Methods and definitions, 20 (likely undercounted: the rules catch only definitional wording):**
   - examples: "what counts as personal weapons", "how is domestic defined", "where does this data come from";
   - text answers outside the plan language.
5. **Areas that are not one agency:**
   - **Explicit county-wide totals: 23.** "Calculate the countywide percent change in violent crimes in Cook County". A plain county name already has a rule (P25: the county police department, else the sheriff), so only an explicit request for every agency in the county is new.
   - **Metro areas and regions: 17.**
   - **Areas below the agency (zip code, neighborhood, district, beat, tract): 16.** No source has them: decline, with the reason.
6. **Analysis across measures or sources, 18:** correlations, indexing to a base year, crime set against staffing. P31 composites cover only named crime totals.
7. **National estimates, 3:**
   - "US murder rate per year with 2025 estimated" is Historical's published national figures (increment 5 for the years the file has);
   - "A national estimate since 1991 of robbery offenders by race" has no source (NIBRS has no estimates).
   - Small.

Group rates ("murder rate for teenagers") are not a gap. D03 already decides them: rates only for places; offer counts or shares by group (23 questions).

## Policy question for Jeff

Should the engine answer a total across several agencies for an area, when the question asks for the whole area ("countywide", "all agencies in X County", a metro area)? It would sum every agency in the area, with a coverage note. The alternative is to decline. A plain county name keeps P25.

## Proposed held-out cases (labels drafted and frozen before any scoring)

Thirty real NIBRS-tab questions not in the labeled set. Each row gives three things:
- **Policy reading:** what the right answer is under decided policy.
- **First action:** what the engine should do with the question as asked.
- **Today:** whether the shadow can do it.

Labels are drafted from the policy reading and first action, reviewed by Codex and frozen before the shadow runs. They join the labeled set at the next label pass, with increment 7's.

| # | Question (as asked) | Policy reading | First action | Today |
|---|---|---|---|---|
| 1 | murders by state in 2024 | Part I, every state, a completed year: Historical (P53) | answer | built for one state; every state at once is not built |
| 2 | how many murders and violent crimes in chicago in 2024 | Part I for an agency, a completed year: Historical (P01) | answer | planned (Historical source) |
| 3 | What are the top drugs seized nationally in 2024? | drug type: NIBRS | answer | planned (increment 9) |
| 4 | How many cannabis cultivation arrests are there in major us cities annually | NIBRS arrests by arrest offense | clarify the period | then planned (rankings of cities nationally: gap 2) |
| 5 | New Orleans murder clearance rate | Part I clearance: Historical (P57) | clarify the period | then planned (Historical source) |
| 6 | Houston murder clearance rate in 2025 | Historical (P57) | answer | built as a named route |
| 7 | Larceny from motor vehicle rate per 100k for Durham | NIBRS-only offense (23F) | clarify the period | then built (increment 4) |
| 8 | i would like the rate of domestic violence incidents per 100,000 people ... for 2024 ... by state | NIBRS state sums, every state (P61, P62) | answer | built for one state; every state at once is not built |
| 9 | Murder rate for teenagers in Chicago since 2019 | D03: no rate for a group | decline the rate; offer counts or shares by age (SHR) | decided (D03); the shadow's decline and offer not checked |
| 10 | houston vehicle burglaries rolling over 12 months since 2019 | NIBRS (23F) | answer | built (increment 3) |
| 11 | 2022 to 2025 murder clearance rate in cities of 250k or more | Historical (P57), several agencies | answer | planned (Historical source) |
| 12 | carjackings per year in Memphis from 2020 to 2025 | NIBRS | answer | built |
| 13 | Houston carjackings per month since 2020 | NIBRS | answer | built |
| 14 | give me a YTD aggravated assaults with a firearm analysis for Philadlephia | NIBRS detail (weapon), this year so far | answer: this year through the latest month | built (no comparison is asked for) |
| 15 | Compare New York City murders to the national total | Part I: Historical (agency and nation) | clarify the period | then planned (Historical source) |
| 16 | Compare domestic violence murders vs gang-related murders nationally by year | homicide circumstance: SHR | clarify the period ("by year" is grain) | then planned (SHR source) |
| 17 | Compare murders for Jackson County Sheriff's Office in Missouri and Kansas City Police Department since 2020 | Part I for agencies: Historical (P01) | answer | planned (Historical source) |
| 18 | what big cities had the highest rate of rapes that were expectionally cleared in 2025? | NIBRS clearance type (P66) | clarify the denominator (the share of rapes, or exceptional clearances per resident) | then a gap (ranking a clearance share nationally) |
| 19 | Which state has the highest motor vehicle theft rate? | Part I, states: Historical | clarify the period | then planned (Historical rankings) |
| 20 | Philadelphia murder victims by race in 2022 | homicide victim detail: SHR (P01) | answer | planned (SHR source) |
| 21 | Adult vs Juvenile arrests for violent crimes in Durham NC | NIBRS arrestee age | clarify the period | then planned (increment 7) |
| 22 | Aggravated assault victims in Texas in 2024 by age group | NIBRS victims by age, a state | answer | gap 2 (state breakdowns) |
| 23 | What percentage of murder victims are female nationally in 2022? | homicide victim detail: SHR | answer | planned (SHR source) |
| 24 | show violent crimes involving firearms by offender age by year for Baltimore city for 2024 to 2026 | NIBRS, a filter on one segment and a breakdown on another | answer | planned (increments 7-8) |
| 25 | share of auto thefts where a firearm was stolen per year | NIBRS property on one segment | clarify the place and the period | then built (increment 6) for an agency |
| 26 | what share of robbery, murder, and aggravated assault incidents involving an offender under age 18 also involve a firearm | NIBRS, a person filter and a weapon share | clarify the place and the period | then planned (increments 7-8) |
| 27 | How many agencies reported NIBRS data in 2023? | coverage | answer | gap 3 (lookups) |
| 28 | what counts as "personal weapons" in weapon type | definition | answer in words | gap 4 (definitions) |
| 29 | how many cases used DNA evidence | not recorded | decline | built |
| 30 | in chesterfield mo what percentage of gun cases recieve convictions | court outcomes, not recorded | decline | built |

## Limits of this review

- The rules still miss roughly one question in eight. Testing traffic is included.
- The log can't show questions people didn't ask because the site visibly couldn't answer them.
- The log can't show whether a logged answer was right; that is the shadow scorer's job.
