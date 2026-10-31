# Query-log coverage review (NIBRS engine session, 2026-10-30, r3)

How real users have asked for the data, against what the engine has built, what is planned and what nothing covers yet.
Asked by the NIBRSAI coordinator after PR #78. Jeff approved the production read on 2026-10-30.

r2 applies Codex review 01 (REVISE). Its changes:
- personal details are redacted;
- source is the one policy requires, not the tab;
- D31 is applied to place and crime as well as period, with grain words no longer counted as a period;
- D03 is applied;
- status is judged by place level;
- the gaps are re-sized;
- the area question is decided by the coordinator's ruling (below), and follow-ups are planned as increment 7b;
- the held-out readings are separated into policy reading, first action and today's status.

r3 applies Codex review 02 (REVISE, eight P2/P3). Its changes:
- edits to a previous table or chart ("add a column", "remove 2026", "the y-axis") are follow-ups; causal questions ("did X work", "the effect of Y on crime") are out of scope;
- a detail only NIBRS records (property value, victims by age) wins over the period default; a monthly series is Current Trends' whatever its years; a yearly series that reaches into this year is Historical, with the current year from Current Trends;
- a list of places ("the 15 largest cities", "big cities") is a set of agencies, not a national total;
- decided declines come before the generic status rules: group rates (D03), a state's or every state's clearance rate (P18), areas below the agency;
- an agency's Part I clearance rate for a year is marked as the named Historical route (P57);
- the Current Trends route counts as built only for state and national totals, the shapes it handles;
- metro geography is told apart from agency names ("LAS VEGAS METRO PD"), and a metro request's action is the interim decline;
- the planned demand and gap sizes are reconciled with their member rows;
- held-out cases 4 and 25 are corrected.

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
    - Part I crimes and clearance: Current Trends for this year or any monthly series; otherwise Historical, with the current year of a series that reaches it from Current Trends;
    - no crime named: *unresolved*.
  - **Correct action:**
    - decline when out of scope, below the agency (ZIP code, neighborhood, beat), a metro area (until after increment 8) or a state clearance rate (P18);
    - for a rate for a population group, decline the rate and offer counts or shares (D03);
    - clarify when the crime, the place or the period is missing (D31/P06). "Per month", "by year", "over time" and "trend" are grain, not a period;
    - *needs context* for follow-ups;
    - otherwise answer.
  - **Status, judged at the question's place level:**
    - **B:** built (a numeric answer, a named route or a decline);
    - **P:** planned (the increment, or that source's step in `docs/superpowers/specs/2026-10-28-engine-other-sources.md`, in the order SHR, Historical, Current Trends, Hate Crime);
    - **G:** gap (follow-ups are planned as increment 7b; area totals per the ruling below);
    - **C:** clarify first (no crime named; asking is the policy action).
- **Accuracy (hand audits, 50 rows each, drawn at random without replacement):**
  - **r1's rules (Codex 01):** shape 88%, source (then the tab) 86%, action 76%, shape-and-action 66%.
  - **r2's rules (Codex 02, a fresh draw):** shape 86%, source 94%, action 86%, status bucket 80%, full status 74%. r2's own claims (about 93% on shape, source and action) were 5 to 7 points too high.
  - **r3's rules (a fresh draw, seed 20261030):** shape 45/50, source 48/50, action 46/50, status bucket 44/50.
    - The misses: short standalone requests with no crime ("Edina Minnesota scorecard") read as follow-ups; "let's do murders then" read as a new question; "how many agencies report" read as a count; a mixed SHR and Historical request; a firearm robbery ranking left on Historical.
    - Drawn before two last fixes (metro and estimate wording; breakdowns with no place), which did not touch these rows.
  - Read the counts as a size guide to within about a tenth, not as a score; they are not bounded per cell. Codex's re-check gives another draw.
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
| count | 148 (B 115, P 30, G 3) | 500 (B 81, P 419) | 32 (B 4, P 28) | 45 (P 45) | 10 (B 1, P 9) | 200 (B 1, P 3, C 196) | 935 |
| rate | 9 (B 9) | 224 (B 59, P 165) | 17 (P 17) | 5 (B 1, P 4) | 0 | 6 (C 6) | 261 |
| trend | 196 (B 178, P 8, G 10) | 797 (B 182, P 615) | 196 (B 31, P 165) | 96 (B 4, P 92) | 32 (P 32) | 94 (P 2, C 92) | 1,411 |
| period comparison | 6 (B 4, P 2) | 70 (B 8, P 62) | 15 (P 15) | 11 (P 11) | 0 | 15 (C 15) | 117 |
| place comparison | 21 (B 16, P 1, G 4) | 181 (P 181) | 14 (P 14) | 16 (P 16) | 4 (P 4) | 22 (C 22) | 258 |
| ranking | 32 (B 14, P 1, G 17) | 158 (B 1, P 157) | 20 (P 20) | 18 (B 1, P 17) | 7 (P 7) | 34 (P 1, C 33) | 269 |
| share/breakdown | 167 (B 45, P 93, G 29) | 58 (B 3, P 55) | 0 | 153 (B 12, P 141) | 4 (P 4) | 24 (C 24) | 406 |
| cross-segment | 29 (P 29) | 2 (P 2) | 0 | 22 (B 5, P 17) | 0 | 1 (C 1) | 54 |
| lookup/list | 18 (G 18) | 13 (B 7, G 6) | 0 | 1 (G 1) | 3 (G 3) | 14 (B 2, G 12) | 49 |
| method/definition | 6 (G 6) | 7 (B 1, G 6) | 0 | 0 | 0 | 7 (G 7) | 20 |
| follow-up (needs context) | 43 (P 43) | 42 (P 42) | 2 (P 2) | 2 (P 2) | 2 (P 2) | 602 (P 602) | 693 |
| out of scope | 9 (B 9) | 23 (B 23) | 1 (B 1) | 1 (B 1) | 3 (B 3) | 23 (B 23) | 60 |
| All | 684 | 2,075 | 297 | 370 | 65 | 1,042 | 4,533 |

Totals: built 845, planned 3,177 (693 of them follow-ups, increment 7b; 22 county-wide and 9 metro area totals), gap 122, clarify first 389.

What the status means at each level:
- **NIBRS:**
  - Built for an agency: counts, rates, trends, comparisons, a state's agencies ranked (P60), one-way breakdowns, clearances and property selections (increments 1-6). A question with no place is judged as for an agency, once the place is given.
  - Built for a state or the nation: a count, counts by year, and a rate for one year (increment 5).
  - Not built: breakdowns, comparisons, monthly or rate series and rankings for states and the nation, and sets of cities across states ("the 15 largest cities", "big cities").
  - Person attributes are planned in increment 7, two-way breakdowns in 8, new fields (drug type, value, circumstance) in 9.
- **Historical:**
  - Built for states and the nation: counts, rates and trends (increment 5); the national clearance rate for a year (P57). A national clearance series is planned.
  - Built as a named route: an agency's Part I clearance rate for a year (P57).
  - Declined, as decided: a state's clearance rate, or every state's (P18).
  - Planned (the Historical source step): every other agency question, sets of agencies, rankings, place comparisons and staffing.
  - Clearance by type (arrest or exceptional) is NIBRS's, not Historical's: the historical file holds published percentages.
- **Current Trends:** built as a named route for state and national totals (count, rate, trend, comparison); planned (the Current Trends source step) for agencies, sets of agencies and rankings.
- **SHR:** built as a named route for victim-offender relationship; planned (the SHR source step) for everything else.
- **Hate Crime:** planned.

**Where the planned demand is (each group sums its member rows in the CSV):**
- **Follow-ups, 693 (15%): increment 7b**, right after 7 and ahead of 8 (coordinator, 2026-10-30).
  - Continuations of the previous answer: "percent change", "make this a rate", "only show homicide now", "same for 2023", "add a column for population", "remove 2026", chart edits.
  - Each needs the previous plan, edited. The scorer will need follow-up turns too.
- **Historical, 1,642:**
  - one agency, 630;
  - a set of agencies, 306;
  - place not named or ambiguous, 524 (the first action is to ask where);
  - staffing, 123;
  - states or the nation beyond what increment 5 built, 50;
  - a national clearance series, 9.
- **SHR, 361.** **Current Trends, 290.** **Hate Crime, 56.**
- **NIBRS:** person attributes (increment 7) 88; two-way (increments 7-8) 29; new fields (increment 9) 41.

## Gaps (for the coordinator)

Every row with status G, 122 in all:

1. **NIBRS beyond what is built for states, the nation and sets of cities, 63:**
   - breakdowns for a state, the nation or a set of cities, 28 ("assaults by location type in Florida", "what percentage of murders are cleared by arrest vs exceptional nationally");
   - sets of cities across states, 28 (counts, rankings, series: "what cities have the highest carjacking");
   - rankings of states, 2; comparisons for states or the nation, 2; monthly or rate series for states, 2;
   - a national estimate, 1 ("a national estimate since 1991 of robbery offenders by race"): NIBRS has no estimates, so this has no source.
   - The coverage note's plan says state and national breakdowns follow each increment's gate, but no increment names them.
2. **Lookups and lists, 40:**
   - coverage and participation ("how many agencies reported NIBRS data in 2023", "which agencies are in Cook County");
   - code lists;
   - agency directories.
   - Nothing in the plan language answers these.
3. **Methods and definitions, 19 (likely undercounted: the rules catch only definitional wording):**
   - examples: "what counts as personal weapons", "how is domestic defined", "where does this data come from";
   - text answers outside the plan language.

Not gaps, because policy already decides them (status B decline):
- **Areas below the agency (ZIP code, neighborhood, beat, tract), 16:** no source has them; the shadow declines with the reason.
- **Group rates, 23** ("murder rate for teenagers"): D03, rates only for places; offer counts or shares by group.
- **State clearance rates, 12** (P18).

Areas that are not one agency are decided (below) and planned: **explicit county-wide totals, 22** ("calculate the countywide percent change in violent crimes in Cook County"); **metro areas, 9**, declined until after increment 8.

Analysis across measures or sources (correlations, indexing to a base year, crime set against staffing) has no label of its own; such rows sit under the source of their first measure. P31 composites cover only named crime totals.

## Areas: decided (no question for Jeff)

Jeff, in the coordinator's session: "We could add up all the agencies in a county or metro area, just makes me nervous
since it isn't formal. Still, we should have that data." The coordinator's ruling, which Jeff has seen, is to be
recorded as a policy row the next time the policy file is touched:

- **A plain county name:** the sheriff or county police (P25 stands), with a note that cities in the county are not included.
- **An explicit county-wide request** ("countywide", "whole county", "all agencies in X County"):
  - the answer is the sum of every agency whose primary county is X, labeled as a sum of reporting agencies;
  - it lists the agencies and gives the reporting share as in P61;
  - non-reporters are never estimated.
  - Where no county agency exists (87 county equivalents in 2024, mostly Virginia's independent cities, Alaska's boroughs, Connecticut and Rhode Island), the engine asks whether all agencies or one is meant.
- **Metro areas:** the same summed-agencies method over the Census CBSA counties, built after increment 8. Declined until then.

Group rates stay declined (D03), which Jeff agreed.

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
| 4 | How many cannabis cultivation arrests are there in major us cities annually | NIBRS arrests, with the drug and the activity (cultivation), for a set of cities | clarify the period and which cities | then partly planned (drug type and activity, increment 9); a set of cities across states is a gap (gap 1) |
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
| 22 | Aggravated assault victims in Texas in 2024 by age group | NIBRS victims by age, a state | answer | gap 1 (state breakdowns) |
| 23 | What percentage of murder victims are female nationally in 2022? | homicide victim detail: SHR | answer | planned (SHR source) |
| 24 | show violent crimes involving firearms by offender age by year for Baltimore city for 2024 to 2026 | NIBRS, a filter on one segment and a breakdown on another | answer | planned (increments 7-8) |
| 25 | share of auto thefts where a firearm was stolen per year | NIBRS: the share of motor vehicle thefts with a firearm among the stolen property | clarify the place and the period | then not built: increment 6 selects property but does not give a share of incidents by a property condition (planned with increment 8's filter on one segment by another) |
| 26 | what share of robbery, murder, and aggravated assault incidents involving an offender under age 18 also involve a firearm | NIBRS, a person filter and a weapon share | clarify the place and the period | then planned (increments 7-8) |
| 27 | How many agencies reported NIBRS data in 2023? | coverage | answer | gap 2 (lookups) |
| 28 | what counts as "personal weapons" in weapon type | definition | answer in words | gap 3 (definitions) |
| 29 | how many cases used DNA evidence | not recorded | decline | built |
| 30 | in chesterfield mo what percentage of gun cases recieve convictions | court outcomes, not recorded | decline | built |

## Limits of this review

- The rules miss about one question in ten on each dimension (shape, source, action, status). Testing traffic is included.
- The log can't show questions people didn't ask because the site visibly couldn't answer them.
- The log can't show whether a logged answer was right; that is the shadow scorer's job.
