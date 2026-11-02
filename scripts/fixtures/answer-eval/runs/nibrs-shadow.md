# Answer evaluation: nibrs-shadow

Labeled set: 432 cases. Release for resolution: 2017-01..2026-09, request date 2026-10-29.

**Level: question -> delivered answer (shadow slice, release 20261028-test5).** Scored: the action; the interpretation of every answer, option continuation and alternative; the required statements on the delivered text; decline reasons by class; delivered values, directly and behind every button and alternative, against nibrs-model's independent values (raw master files; NOT MEASURED where none is given). Not measured: other sources (an option routed to Historical is not run), follow-up turns.

## Execution coverage (can this candidate take the case)

- 222: run by this candidate
- 210: outside the shadow slice

## Label eligibility (can the case be scored)

- 371: scorable (reviewed, decided policy)
- 54: label unresolved
- 7: label drafted

## Refused as not built (not scored)

- LS-237: refused as not built: The data here covers January 2017 through September 2026, so it doesn't include 2012.

## Scored (reviewed labels, decided policy): designed slice cases

### Development

22 cases. Correct 15; unverified 6; wrong answers 0; avoidable declines 0; unnecessary clarifications 0; wrong actions 0; incomplete 1. Severity score 1 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 10 | 0 | 0 | 0 |
| clarify | 0 | 8 | 0 | 0 |
| decline | 0 | 0 | 4 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 10 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (10/10)); direct answers: not measured (90% verified, 1 unverified); numeric fixtures: not measured (9/10 match, 1 not measured) |
| clarify:historical count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 6 | not measured | wrong answers: not measured (0, 2 answers unverified); clarifications: not measured (4/6 verified correct, 2 unverified); initial action: pass (100% (6/6)); direct answers: pass (no answerable cases); numeric fixtures: not measured (4/6 match, 2 not measured) |
| clarify:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: pass (1/1 match) |
| decline:nibrs count | 2021 and later | 2 | not measured | wrong answers: not measured (0, 1 answers unverified); declines: not measured (1/2 verified correct, 1 unverified); initial action: pass (100% (2/2)); direct answers: pass (no answerable cases); numeric fixtures: not measured (1/2 match, 1 not measured) |
| decline:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); declines: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 1 | not measured | wrong answers: pass (0); declines: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-232** (unverified; expected clarify, got clarify) "How many shoplifting offenses were there in 2024?"
  - unverified option "The United States" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "The United States" button "Consistent Reporting Agencies" meaning: expected `(the label gives no meaning past this button)`, got `offenses.shoplifting 2024-01..2024-12`
  - unverified option "The United States" button "Consistent Reporting Agencies" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which place: The United States | A state | A city or agency
- **LS-234** (unverified; expected clarify, got clarify) "Carjackings in Memphis by month"
  - unverified option "The last 10 complete years" : expected `answer`, got `refused: this build does not hold the months (not built)`
  - asked which range of years: The last 10 complete years | Every year available | Another range
- **LS-235** (incomplete; expected clarify, got clarify) "How many crimes were there in Detroit in 2024?"
  - unverified option "Violent crime" : expected `answer`, got `a historical-file answer`
  - unverified option "Property crime" : expected `answer`, got `a historical-file answer`
  - material option "Both": expected `offered`, got `missing`
  - asked which kind of crime: Violent crime | Property crime
- **LS-239** (unverified; expected decline, got decline) "How many shoplifting arrests in Memphis in 2024 led to convictions?"
  - unverified alternative values: expected `independent expected values`, got `none given: NOT MEASURED`
  - declined (court_outcome): NIBRS covers crimes reported to police, arrests and clearances. It doesn't include charges or court outcomes (prosecutions, trials, convictions, sentences or defendants).
- **LS-240** (unverified; expected decline, got decline) "Will carjackings go up in Memphis next year?"
  - unverified alternative : expected `answer`, got `refused: this build does not hold the months (not built)`
  - declined (forecast): The data records past crime and cannot predict the future.
- **LS-241** (unverified; expected answer, got answer) "Shoplifting arrests in Memphis in 2024"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Memphis, Tennessee: 2,078 shoplifting arrests in 2024. / Reported by the Memphis Police Department. / Source: FBI NIBRS.
- **LS-243** (unverified; expected clarify, got clarify) "Shoplifting in Washington in 2024"
  - unverified option "Washington state" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "Washington state" button "Consistent Reporting Agencies" meaning: expected `(the label gives no meaning past this button)`, got `offenses.shoplifting 2024-01..2024-12`
  - unverified option "Washington state" button "Consistent Reporting Agencies" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which Washington: Washington, D.C. | Washington state | Washington County, Oregon | Washington County, Maryland

### Held out

184 cases. Correct 154; unverified 25; wrong answers 0; avoidable declines 3; unnecessary clarifications 0; wrong actions 2; incomplete 0. Severity score 70 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 157 | 0 | 3 | 0 |
| clarify | 0 | 6 | 2 | 0 |
| decline | 0 | 0 | 16 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:historical change | 2021 and later | 1 | pass | wrong answers: pass (0); initial action: pass (100% (1/1)); direct answers: pass (100%); numeric fixtures: pass (1/1 match) |
| answer:historical count | 2021 and later | 5 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (5/5)); direct answers: not measured (80% verified, 1 unverified); numeric fixtures: not measured (4/5 match, 1 not measured) |
| answer:historical count | before 2021 | 1 | pass | wrong answers: pass (0); initial action: pass (100% (1/1)); direct answers: pass (100%); numeric fixtures: pass (1/1 match) |
| answer:historical count | spans 2021 | 1 | pass | wrong answers: pass (0); initial action: pass (100% (1/1)); direct answers: pass (100%); numeric fixtures: pass (1/1 match) |
| answer:historical rate | 2021 and later | 3 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (3/3)); direct answers: not measured (67% verified, 1 unverified); numeric fixtures: not measured (2/3 match, 1 not measured) |
| answer:nibrs change | 2021 and later | 12 | pass | wrong answers: pass (0); initial action: pass (100% (12/12)); direct answers: pass (100%); numeric fixtures: pass (12/12 match) |
| answer:nibrs count | 2021 and later | 118 | not measured | wrong answers: not measured (0, 8 answers unverified); initial action: pass (97% (115/118)); direct answers: not measured (91% verified, 8 unverified); numeric fixtures: not measured (107/115 match, 8 not measured) |
| answer:nibrs count | spans 2021 | 2 | pass | wrong answers: pass (0); initial action: pass (100% (2/2)); direct answers: pass (100%); numeric fixtures: pass (2/2 match) |
| answer:nibrs rate | 2021 and later | 14 | pass | wrong answers: pass (0); initial action: pass (100% (14/14)); direct answers: pass (100%); numeric fixtures: pass (14/14 match) |
| answer:nibrs share | 2021 and later | 1 | pass | wrong answers: pass (0); initial action: pass (100% (1/1)); direct answers: pass (100%); numeric fixtures: pass (1/1 match) |
| answer:rtci count | period not mapped | 1 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (1/1)); direct answers: not measured (0% verified, 1 unverified); numeric fixtures: not measured (no delivered values) |
| answer:shr count | 2021 and later | 1 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (1/1)); direct answers: not measured (0% verified, 1 unverified); numeric fixtures: not measured (no delivered values) |
| clarify:historical count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 6 | not measured | wrong answers: not measured (0, 4 answers unverified); clarifications: not measured (2/6 verified correct, 4 unverified); initial action: pass (100% (6/6)); direct answers: pass (no answerable cases); numeric fixtures: not measured (2/6 match, 4 not measured) |
| clarify:shr count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | 2021 and later | 5 | not measured | wrong answers: not measured (0, 4 answers unverified); declines: not measured (1/5 verified correct, 4 unverified); initial action: pass (100% (5/5)); direct answers: pass (no answerable cases); numeric fixtures: not measured (1/5 match, 4 not measured) |
| decline:nibrs count | spans 2021 | 4 | not measured | wrong answers: pass (0); declines: not measured (0/4 verified correct, 4 unverified); initial action: pass (100% (4/4)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 7 | not measured | wrong answers: pass (0); declines: not measured (6/7 verified correct, 1 unverified); initial action: pass (100% (7/7)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-245** (unverified; expected clarify, got clarify) "Shoplifting in New York in 2024"
  - unverified option "New York state" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "New York state" button "Consistent Reporting Agencies" meaning: expected `(the label gives no meaning past this button)`, got `offenses.shoplifting 2024-01..2024-12`
  - unverified option "New York state" button "Consistent Reporting Agencies" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which New York: New York City | New York state
- **LS-260** (unverified; expected decline, got decline) "Will shoplifting rise in Denver next year?"
  - unverified alternative : expected `answer`, got `refused: this build does not hold the months (not built)`
  - declined (forecast): The data records past crime and cannot predict the future.
- **LS-261** (unverified; expected decline, got decline) "Can you forecast carjackings in Atlanta for 2027?"
  - unverified alternative : expected `answer`, got `refused: this build does not hold the months (not built)`
  - declined (forecast): The data records past crime and cannot predict the future.
- **LS-262** (unverified; expected decline, got decline) "Predict simple assaults in Portland, Oregon next year"
  - unverified alternative : expected `answer`, got `refused: this build does not hold the months (not built)`
  - declined (forecast): The data records past crime and cannot predict the future.
- **LS-263** (unverified; expected decline, got decline) "What will carjackings be in Nashville in 2027?"
  - unverified alternative : expected `answer`, got `refused: this build does not hold the months (not built)`
  - declined (forecast): The data records past crime and cannot predict the future.
- **LS-264** (unverified; expected decline, got decline) "How many simple assault arrests in Denver in 2023 resulted in a conviction?"
  - unverified alternative values: expected `independent expected values`, got `none given: NOT MEASURED`
  - declined (court_outcome): NIBRS covers crimes reported to police, arrests and clearances. It doesn't include charges or court outcomes (prosecutions, trials, convictions, sentences or defendants).
- **LS-265** (unverified; expected decline, got decline) "How many shoplifting cases in Nashville went to trial in 2024?"
  - unverified alternative values: expected `independent expected values`, got `none given: NOT MEASURED`
  - declined (court_outcome): NIBRS covers crimes reported to police, arrests and clearances. It doesn't include charges or court outcomes (prosecutions, trials, convictions, sentences or defendants).
- **LS-266** (unverified; expected answer, got answer) "Motor vehicle thefts in Denver in 2023"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Denver, Colorado: 12,457 motor vehicle thefts in 2023. / Figures for the Denver Police Department. / Source: Crime Index.
- **LS-267** (wrong_action; expected clarify, got decline) "Shootings in Nashville in 2024"
  - declined (reader): NIBRS doesn't count shootings as a category, so "Shootings" can't be counted. For fatal shootings, the Homicide Reports tab has firearm homicides. The closest NIBRS figure is aggravated assault with a
- **LS-269** (avoidable_decline; expected answer, got decline) "How many shoplifting offenses will Denver's 2024 numbers show?"
  - declined (reader): I didn't understand "will". Try asking it another way.
- **LS-270** (wrong_action; expected clarify, got decline) "Shplftg in Nashville in 2024"
  - declined (reader): I couldn't tell what this question asks for. Try naming a crime, a place and a year, for example "robberies in Denver in 2024".
- **LS-282** (avoidable_decline; expected answer, got decline) "Simple assault victims in Louisville by race and sex in 2024"
  - declined (reader): I can break the numbers down one way at a time; "and sex" would be a second breakdown.
- **LS-292** (unverified; expected answer, got answer) "Simple assaults by men and women in Oklahoma City in 2024"
  - unverified value Unknown: expected `(merged from overlapping categories: no independent value)`, got `174 VALUE`
  - delivered: Oklahoma City, Oklahoma: simple assault victims by offender sex, 2024. / Reported by the Oklahoma City Police Department. / A crime that falls in several of these categories is counted once in each, so the cat
- **LS-294** (avoidable_decline; expected answer, got decline) "Aggravated assault victims in Mesa by race and sex in 2024"
  - declined (reader): I can break the numbers down one way at a time; "and sex" would be a second breakdown.
- **LS-348** (unverified; expected answer, got answer) "Robberies in Texas this year"
  - unverified route: expected `rtci answer`, got `routed to rtci: not run by this NIBRS shadow`
  - routed to rtci: This year's robbery figures come from Current Trends (Crime Index), through the latest reported month, for the agencies it covers. Current Trends isn't available here yet.
- **LS-349** (unverified; expected answer, got answer) "Murders in the US by victim-offender relationship in 2023"
  - unverified route: expected `shr answer`, got `routed to shr: not run by this NIBRS shadow`
  - routed to shr: Murders by victim-offender relationship come from Homicide Reports (FBI SHR), which count the homicides agencies reported to the SHR, not a complete national estimate. Homicide Reports aren't availabl
- **LS-363** (unverified; expected answer, got answer) "Robbery clearance rate in Atlanta in 2023"
  - unverified measures: expected `?`, got `?`
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Atlanta, Georgia: 26.7% of robberies were cleared in 2023 (161 of 602). / Figures for the Atlanta Police Department. / Source: Crime Index.
- **LS-377** (unverified; expected answer, got answer) "Aggravated assaults in Memphis in 2024 by offender race"
  - unverified value Unknown: expected `(merged from overlapping categories: no independent value)`, got `5379 VALUE`
  - delivered: Memphis, Tennessee: aggravated assault victims by offender race, 2024. / Reported by the Memphis Police Department. / A crime that falls in several of these categories is counted once in each, so the categorie
- **LS-378** (unverified; expected answer, got answer) "Robberies in Detroit in 2024 by offender age"
  - unverified value Unknown: expected `(merged from overlapping categories: no independent value)`, got `738 VALUE`
  - delivered: Detroit, Michigan: robbery offenses by offender age group, 2024. / Reported by the Detroit Police Department. / A crime that falls in several of these categories is counted once in each, so the categories can 
- **LS-382** (unverified; expected answer, got answer) "According to NIBRS, murder victims in Memphis in 2024 by offender race"
  - unverified value Unknown: expected `(merged from overlapping categories: no independent value)`, got `107 VALUE`
  - delivered: Memphis, Tennessee: murder victims by offender race, 2024. / Reported by the Memphis Police Department. / A crime that falls in several of these categories is counted once in each, so the categories can add up
- **LS-387** (unverified; expected answer, got answer) "Simple assaults in Milwaukee in 2024 by offender ethnicity"
  - unverified value Unknown: expected `(merged from overlapping categories: no independent value)`, got `569 VALUE`
  - delivered: Milwaukee, Wisconsin: simple assault victims by offender ethnicity, 2024. / Reported by the Milwaukee Police Department. / A crime that falls in several of these categories is counted once in each, so the cate
- **LS-388** (unverified; expected answer, got answer) "Robbery offenders in Albuquerque in 2023 by age"
  - unverified value Unknown: expected `(merged from overlapping categories: no independent value)`, got `709 VALUE`
  - delivered: Albuquerque, New Mexico: robbery offenders by offender age group, 2023. / Reported by the Albuquerque Police Department. / Source: FBI NIBRS.
- **LS-389** (unverified; expected clarify, got clarify) "According to NIBRS, murders by young adults in Memphis in 2024"
  - unverified option "18 to 24" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "18 to 29" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which ages "young adults" means: 18 to 24 | 18 to 29
- **LS-390** (unverified; expected clarify, got clarify) "How many attackers were there in aggravated assaults in Detroit in 2024?"
  - unverified option "Offenders" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "People arrested" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked what "attackers" means: Offenders | People arrested
- **LS-391** (unverified; expected decline, got decline) "People charged with robbery in Memphis in 2024"
  - unverified alternative values: expected `independent expected values`, got `none given: NOT MEASURED`
  - declined (court_outcome): NIBRS covers crimes reported to police, arrests and clearances. It doesn't include charges or court outcomes (prosecutions, trials, convictions, sentences or defendants).
- **LS-392** (unverified; expected decline, got decline) "Aggravated assaults in Tennessee in 2024 by offender sex"
  - unverified reason: expected `Offender breakdowns for a whole state are not built yet; they are for one agency or several named agencies.`, got `unsupported_capability`
  - declined (unsupported_capability): Offender breakdowns for a whole state or the nation aren't available yet; they are for one agency or several named agencies.
- **LS-397** (unverified; expected answer, got answer) "Aggravated assaults in Denver in 2023 by offender race"
  - unverified value Unknown: expected `(merged from overlapping categories: no independent value)`, got `1041 VALUE`
  - delivered: Denver, Colorado: aggravated assault victims by offender race, 2023. / Reported by the Denver Police Department. / A crime that falls in several of these categories is counted once in each, so the categories c
- **LS-411** (unverified; expected answer, got answer) "by offender race"
  - unverified value Unknown: expected `(merged from overlapping categories: no independent value)`, got `5379 VALUE`
  - delivered: Memphis, Tennessee: aggravated assault victims by offender race, 2024. / Reported by the Memphis Police Department. / A crime that falls in several of these categories is counted once in each, so the categorie
- **LS-422** (unverified; expected clarify, got clarify) "what about Wichita?"
  - unverified option "Wichita only" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "Add Wichita; show all three separately" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked Whether Wichita replaces Tulsa and Oklahoma City or is added to them.: Wichita only | Add Wichita; show all three separately
- **LS-426** (unverified; expected decline, got decline) "what about Detroit?"
  - unverified alternative values: expected `independent expected values`, got `none given: NOT MEASURED`
  - declined (court_outcome): NIBRS covers crimes reported to police, arrests and clearances. It doesn't include charges or court outcomes (prosecutions, trials, convictions, sentences or defendants).

## Scored (reviewed labels, decided policy): replay cases inside the slice

### Development

2 cases. Correct 1; unverified 1; wrong answers 0; avoidable declines 0; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 0 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| clarify | 0 | 2 | 0 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| clarify:nibrs count | 2021 and later | 1 | pass | wrong answers: pass (0); clarifications: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: pass (1/1 match) |
| clarify:no meaning | no period | 1 | not measured | wrong answers: not measured (0, 1 answers unverified); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (0/1 match, 1 not measured) |

Discrepancies and unverified cases:

- **LS-140** (unverified; expected clarify, got clarify) "St Louis carjackings per month"
  - unverified option "St. Louis city, Missouri" option "Every year available" meaning: expected `(the label gives no meaning past this button)`, got `offenses.carjacking 2017-01..2026-09`
  - unverified option "St. Louis County, Missouri" option "Every year available" meaning: expected `(the label gives no meaning past this button)`, got `offenses.carjacking 2017-01..2026-09`
  - unverified option "St. Louis County, Missouri" option "Every year available" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which St. Louis: St. Louis city, Missouri | St. Louis County, Missouri

### Held out

No cases.

## Scored (reviewed labels, decided policy): replay cases next to the slice (action and reason)

### Development

10 cases. Correct 4; unverified 2; wrong answers 0; avoidable declines 4; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 80 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| decline | 0 | 0 | 4 | 0 |
| answer | 1 | 0 | 4 | 0 |
| clarify | 0 | 1 | 0 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 4 | fail | wrong answers: pass (0); initial action: fail (0% (0/4)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs count | period not mapped | 1 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (1/1)); direct answers: not measured (0% verified, 1 unverified); numeric fixtures: not measured (0/1 match, 1 not measured) |
| clarify:nibrs count | spans 2021 | 1 | not measured | wrong answers: not measured (0, 1 answers unverified); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (0/1 match, 1 not measured) |
| decline:no meaning | no period | 4 | not measured | wrong answers: pass (0); declines: pass (4/4 verified correct); initial action: pass (100% (4/4)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-043** (unverified; expected answer, got answer) "Houston vehicle burglaries by year and clearance status, 2018 to 2026"
  - unverified period: expected `{"rule":"2018-01 through the latest month in the data (requested end 2026)"}`, got `2018-01..2026-09`
  - unverified statement: expected `If the requested start or end falls outside the data, states where the data starts or ends for that place`, got `(no check defined)`
  - unverified statement: expected `Names any missing years or months inside the span as missing, not zero`, got `(no check defined)`
  - unverified statement: expected `Names the months the partial 2026 figure covers`, got `(no check defined)`
  - unverified statement: expected `Does not annualize or project the partial year, and does not re-cut earlier years to match`, got `(no check defined)`
  - unverified statement: expected `Names the Houston Police Department as the agency counted`, got `(no check defined)`
  - unverified statement: expected `Names its source at the end`, got `(no check defined)`
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Houston, Texas: theft from motor vehicle offenses by year and clearance status, January 2018 through September 2026. / Reported by the Houston Police Department. / 2018, 2026 are shown blank, not zero: reporti
- **LS-124** (avoidable_decline; expected answer, got decline) "Narcotics possession or distribution arrests in tolleson Arizona in 2025"
  - declined (reader): NIBRS doesn't include drug distribution or sales as its own measure (drug possession and drug offenses are counted), so "or distribution" can't be counted.
- **LS-135** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 In Tucson az. Please provide total"
  - declined (reader): NIBRS doesn't include drug distribution or sales as its own measure (drug possession and drug offenses are counted), so "or distribution of" can't be counted.
- **LS-146** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Yuma Az"
  - declined (reader): NIBRS doesn't include drug distribution or sales as its own measure (drug possession and drug offenses are counted), so "or distribution of" can't be counted.
- **LS-150** (unverified; expected clarify, got clarify) "houston vehicle burglaries by month by clearance status"
  - unverified option "Last 10 complete years" : expected `answer`, got `refused: this build does not hold the months (not built)`
  - unverified option "Every year available" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which range of years: The last 10 complete years | Every year available | Another range
- **LS-160** (avoidable_decline; expected answer, got decline) "What weapons were used in robberies in Atlanta in 2024?"
  - declined (reader): I didn't understand "weapons were used in". Try asking it another way.

### Held out

2 cases. Correct 1; unverified 0; wrong answers 0; avoidable declines 1; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 20 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| decline | 0 | 0 | 1 | 0 |
| answer | 0 | 0 | 1 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 1 | not measured | wrong answers: pass (0); declines: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-156** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Avondale Az"
  - declined (reader): NIBRS doesn't include drug distribution or sales as its own measure (drug possession and drug offenses are counted), so "or distribution of" can't be counted.

## PROVISIONAL: drafted labels (never a gate): designed slice cases

### Development

No cases.

### Held out

1 cases. Correct 0; unverified 0; wrong answers 1; avoidable declines 0; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 100 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 1 | 0 | 0 | 0 |

| Capability | Era | Cases | Would-be gate (not a gate) | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 1 | fail | wrong answers: fail (1); initial action: pass (100% (1/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: pass (1/1 match) |

Discrepancies and unverified cases:

- **LS-419** (wrong_answer; expected answer, got answer) "make it a bar chart"
  - unverified statement: expected `gives the same numbers as the previous answer: the chart form is the page's, not a new question (P69)`, got `(no check defined)`
  - material statement: expected `Changes the existing chart to bars using the existing result; makes no data-engine request.`, got `Detroit, Michigan: simple assault victims by month, 2023. / Reported by the Detroit Police Department. / Source: FBI NIBRS.`
  - delivered: Detroit, Michigan: simple assault victims by month, 2023. / Reported by the Detroit Police Department. / Source: FBI NIBRS.

## PROVISIONAL: drafted labels (never a gate): replay cases inside the slice

### Development

No cases.

### Held out

No cases.

## PROVISIONAL: drafted labels (never a gate): replay cases next to the slice (action and reason)

### Development

No cases.

### Held out

No cases.
