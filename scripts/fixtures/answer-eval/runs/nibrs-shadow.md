# Answer evaluation: nibrs-shadow

Labeled set: 316 cases. Release for resolution: 2017-01..2026-09, request date 2026-10-29.

**Level: question -> delivered answer (shadow slice, release 20261028-test5).** Scored: the action; the interpretation of every answer, option continuation and alternative; the required statements on the delivered text; decline reasons by class; delivered values, directly and behind every button and alternative, against nibrs-model's independent values (raw master files; NOT MEASURED where none is given). Not measured: other sources (an option routed to Historical is not run), follow-up turns.

## Execution coverage (can this candidate take the case)

- 204: outside the shadow slice
- 112: run by this candidate

## Label eligibility (can the case be scored)

- 262: scorable (reviewed, decided policy)
- 54: label unresolved

## Refused as not built (not scored)

- LS-237: refused as not built: This build holds January 2017 through September 2026, so it does not cover 2012.

## Scored (reviewed labels, decided policy): designed slice cases

### Development

22 cases. Correct 15; unverified 7; wrong answers 0; avoidable declines 0; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 0 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 10 | 0 | 0 | 0 |
| clarify | 0 | 8 | 0 | 0 |
| decline | 0 | 0 | 4 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 10 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (10/10)); direct answers: not measured (90% verified, 1 unverified); numeric fixtures: not measured (9/10 match, 1 not measured) |
| clarify:historical count | 2021 and later | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 6 | not measured | wrong answers: pass (0); clarifications: not measured (4/6 verified correct, 2 unverified); initial action: pass (100% (6/6)); direct answers: pass (no answerable cases); numeric fixtures: pass (5/5 match) |
| clarify:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: pass (1/1 match) |
| decline:nibrs count | 2021 and later | 2 | not measured | wrong answers: not measured (0, 1 answers unverified); declines: not measured (1/2 verified correct, 1 unverified); initial action: pass (100% (2/2)); direct answers: pass (no answerable cases); numeric fixtures: not measured (1/2 match, 1 not measured) |
| decline:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); declines: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 1 | not measured | wrong answers: pass (0); declines: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-232** (unverified; expected clarify, got clarify) "How many shoplifting offenses were there in 2024?"
  - unverified option "The United States" : expected `answer`, got `Not in the slice yet: state and national totals come later.`
  - asked which place: The United States | A state | A city or agency
- **LS-234** (unverified; expected clarify, got clarify) "Carjackings in Memphis by month"
  - unverified option "The last 10 complete years" : expected `answer`, got `refused: this build does not hold the months (not built)`
  - asked which range of years: The last 10 complete years | Every year available | Another range
- **LS-235** (unverified; expected clarify, got clarify) "How many crimes were there in Detroit in 2024?"
  - unverified option "Violent crime" : expected `historical answer`, got `routed to historical: not run by this NIBRS shadow`
  - unverified option "Property crime" : expected `historical answer`, got `routed to historical: not run by this NIBRS shadow`
  - unverified option "Both" : expected `historical answer`, got `routed to historical: not run by this NIBRS shadow`
  - asked which kind of crime: Violent crime | Property crime | Both
- **LS-239** (unverified; expected decline, got decline) "How many shoplifting arrests in Memphis in 2024 led to convictions?"
  - unverified alternative values: expected `independent expected values`, got `none given: NOT MEASURED`
  - declined (court_outcome): NIBRS doesn't record charges or court outcomes (prosecutions, trials, convictions, sentences or defendants); it records crimes reported to police, arrests and clearances.
- **LS-240** (unverified; expected decline, got decline) "Will carjackings go up in Memphis next year?"
  - unverified alternative : expected `answer`, got `refused: this build does not hold the months (not built)`
  - declined (forecast): The data records past crime and cannot predict the future.
- **LS-241** (unverified; expected answer, got answer) "Shoplifting arrests in Memphis in 2024"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Memphis city police, TN: 2,087 shoplifting arrests in 2024. / Each arrest counts once; NIBRS cannot tell when one person was arrested more than once. / Source: FBI National Incident-Based Reporting System (NIB
- **LS-243** (unverified; expected clarify, got clarify) "Shoplifting in Washington in 2024"
  - unverified option "Washington state" : expected `answer`, got `Not in the slice yet: state and national totals come later.`
  - asked which Washington: Washington, D.C. | Washington state | Washington County, Oregon | Washington County, Maryland

### Held out

75 cases. Correct 47; unverified 22; wrong answers 0; avoidable declines 4; unnecessary clarifications 0; wrong actions 2; incomplete 0. Severity score 90 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 57 | 0 | 4 | 0 |
| clarify | 0 | 3 | 2 | 0 |
| decline | 0 | 0 | 9 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:historical count | 2021 and later | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs change | 2021 and later | 10 | not measured | wrong answers: not measured (0, 10 answers unverified); initial action: pass (100% (10/10)); direct answers: not measured (0% verified, 10 unverified); numeric fixtures: not measured (0/10 match, 10 not measured) |
| answer:nibrs count | 2021 and later | 49 | fail | wrong answers: not measured (0, 4 answers unverified); initial action: fail (94% (46/49)); direct answers: fail (86% (4 unverified)); numeric fixtures: not measured (42/46 match, 4 not measured) |
| answer:nibrs count | spans 2021 | 1 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (1/1)); direct answers: not measured (0% verified, 1 unverified); numeric fixtures: not measured (0/1 match, 1 not measured) |
| clarify:historical count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 3 | not measured | wrong answers: pass (0); clarifications: not measured (2/3 verified correct, 1 unverified); initial action: pass (100% (3/3)); direct answers: pass (no answerable cases); numeric fixtures: pass (3/3 match) |
| clarify:shr count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | 2021 and later | 3 | not measured | wrong answers: not measured (0, 2 answers unverified); declines: not measured (1/3 verified correct, 2 unverified); initial action: pass (100% (3/3)); direct answers: pass (no answerable cases); numeric fixtures: not measured (1/3 match, 2 not measured) |
| decline:nibrs count | spans 2021 | 4 | not measured | wrong answers: pass (0); declines: not measured (0/4 verified correct, 4 unverified); initial action: pass (100% (4/4)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 2 | not measured | wrong answers: pass (0); declines: pass (2/2 verified correct); initial action: pass (100% (2/2)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-245** (unverified; expected clarify, got clarify) "Shoplifting in New York in 2024"
  - unverified option "New York state" : expected `answer`, got `Not in the slice yet: state and national totals come later.`
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
  - declined (court_outcome): NIBRS doesn't record charges or court outcomes (prosecutions, trials, convictions, sentences or defendants); it records crimes reported to police, arrests and clearances.
- **LS-265** (unverified; expected decline, got decline) "How many shoplifting cases in Nashville went to trial in 2024?"
  - unverified alternative values: expected `independent expected values`, got `none given: NOT MEASURED`
  - declined (court_outcome): NIBRS doesn't record charges or court outcomes (prosecutions, trials, convictions, sentences or defendants); it records crimes reported to police, arrests and clearances.
- **LS-266** (avoidable_decline; expected answer, got decline) "Motor vehicle thefts in Denver in 2023"
  - declined (unsupported_capability): Not in the slice yet: counts of this crime come from Historical or Current Trends (P01), which this NIBRS shadow does not run.
- **LS-267** (wrong_action; expected clarify, got decline) "Shootings in Nashville in 2024"
  - declined (reader): NIBRS does not track shootings as a category, so I can't apply "Shootings". For fatal shootings, the Homicide Reports tab has firearm homicides. The closest NIBRS figure is aggravated assault with a f
- **LS-268** (unverified; expected answer, got answer) "Is shoplifting in Denver up this year compared with last year?"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Denver city police, CO: shoplifting offenses, January through September 2025 against January through September 2026. / Compares the same months of each year: January through September. / 2,696 in January throu
- **LS-269** (avoidable_decline; expected answer, got decline) "How many shoplifting offenses will Denver's 2024 numbers show?"
  - declined (reader): I couldn't interpret "will" in this question, so I haven't answered it with a number that ignores it.
- **LS-270** (wrong_action; expected clarify, got decline) "Shplftg in Nashville in 2024"
  - declined (reader): The question could not be read: no typed reading.
- **LS-282** (avoidable_decline; expected answer, got decline) "Simple assault victims in Louisville by race and sex in 2024"
  - declined (reader): I can't apply "and sex": I give one breakdown per answer; ask for one breakdown at a time. I haven't answered with a number that leaves it out.
- **LS-294** (avoidable_decline; expected answer, got decline) "Aggravated assault victims in Mesa by race and sex in 2024"
  - declined (reader): I can't apply "and sex": I give one breakdown per answer; ask for one breakdown at a time. I haven't answered with a number that leaves it out.
- **LS-303** (unverified; expected answer, got answer) "Shoplifting in Columbus, Ohio in 2019 and 2024"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Columbus city police, OH: shoplifting offenses by year, 2019 and 2024. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5.
- **LS-304** (unverified; expected answer, got answer) "Change in simple assaults in Austin from 2022 to 2024"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Austin city police, TX: simple assault victims, 2022 against 2024. / 10,045 in 2022 and 9,688 in 2024: a change of -357 (-3.6%). / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by t
- **LS-305** (unverified; expected answer, got answer) "Theft from motor vehicle in Minneapolis in 2024 compared with 2023"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Minneapolis city police, MN: theft from motor vehicle offenses, 2023 against 2024. / 3,755 in 2023 and 4,240 in 2024: a change of +485 (+12.9%). / Source: FBI National Incident-Based Reporting System (NIBRS), 
- **LS-306** (unverified; expected answer, got answer) "Did drug possession offenses go up in Aurora, Colorado in 2025?"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Aurora city police, CO: drug/narcotic violation offenses, 2024 against 2025. / 578 in 2024 and 718 in 2025: a change of +140 (+24.2%). / Source: FBI National Incident-Based Reporting System (NIBRS), as reporte
- **LS-307** (unverified; expected answer, got answer) "Are carjackings in Dallas up this year compared with last year?"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Dallas city police, TX: carjacking offenses, January through September 2025 against January through September 2026. / Compares the same months of each year: January through September. / 207 in January through 
- **LS-308** (unverified; expected answer, got answer) "Percent change in robberies with a firearm in Charlotte, North Carolina from 2021 to 2025"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Charlotte-Mecklenburg city police, NC: robbery offenses with a firearm, 2021 against 2025. / 739 in 2021 and 440 in 2025: a change of -299 (-40.5%). / Source: FBI National Incident-Based Reporting System (NIBR
- **LS-309** (unverified; expected answer, got answer) "Shoplifting in Austin January through June 2024 compared with January through June 2023"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Austin city police, TX: shoplifting offenses, January through June 2023 against January through June 2024. / Compares the same months of each year: January through June. / 819 in January through June 2023 and 
- **LS-310** (unverified; expected answer, got answer) "Change in carjackings in Frisco, Texas from 2022 to 2023"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Frisco city police, TX: carjacking offenses, 2022 against 2023. / 0 in 2022 and 6 in 2023: a change of +6. / The percent change cannot be computed from a zero base. / Source: FBI National Incident-Based Report
- **LS-311** (unverified; expected answer, got answer) "Did shoplifting go up in Greensboro in 2025?"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Greensboro city police, NC: shoplifting offenses, 2024 against 2025. / 2,559 in 2024. / No report is known for November 2025 to December 2025, so the 2025 total is not established and no change is given. / Sou
- **LS-312** (unverified; expected answer, got answer) "Is shoplifting in Seattle up this year compared with last year?"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Seattle city police, WA: shoplifting offenses, January through September 2025 against January through September 2026. / Compares the same months of each year: January through September. / 2,254 in January thro
- **LS-313** (unverified; expected answer, got answer) "Rolling 12-month carjackings in Arlington, Texas since 2023"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Arlington city police, TX: carjacking offenses, rolling 12-month totals by month, January 2023 through September 2026. / Each month's figure is the total of that month and the 11 months before it. / Source: FB
- **LS-314** (unverified; expected answer, got answer) "Carjackings in Arlington, Texas over the last 12 months"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Arlington city police, TX: 11 carjacking offenses in October 2025 through September 2026. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-t
- **LS-315** (unverified; expected answer, got answer) "Rolling 12-month shoplifting in Greensboro since 2025"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Greensboro city police, NC: shoplifting offenses, rolling 12-month totals by month, January 2025 through September 2026. / Each month's figure is the total of that month and the 11 months before it. / No repor
- **LS-316** (unverified; expected answer, got answer) "Rolling 12-month shoplifting in Greensboro since 2026"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Greensboro city police, NC: shoplifting offenses, rolling 12-month totals by month, January through September 2026. / Each month's figure is the total of that month and the 11 months before it. / No report is 

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

10 cases. Correct 4; unverified 0; wrong answers 0; avoidable declines 5; unnecessary clarifications 0; wrong actions 1; incomplete 0. Severity score 105 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| decline | 0 | 0 | 4 | 0 |
| answer | 0 | 0 | 5 | 0 |
| clarify | 0 | 0 | 1 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 4 | fail | wrong answers: pass (0); initial action: fail (0% (0/4)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs count | period not mapped | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | spans 2021 | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 4 | not measured | wrong answers: pass (0); declines: pass (4/4 verified correct); initial action: pass (100% (4/4)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-043** (avoidable_decline; expected answer, got decline) "Houston vehicle burglaries by year and clearance status, 2018 to 2026"
  - declined (unsupported_capability): Not in the slice yet: this breakdown (two-way breakdowns, several measures broken down, a combined total by period), rates and other shares.
- **LS-124** (avoidable_decline; expected answer, got decline) "Narcotics possession or distribution arrests in tolleson Arizona in 2025"
  - declined (reader): NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution". I haven't answered with a number that leaves it 
- **LS-135** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 In Tucson az. Please provide total"
  - declined (reader): NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution of". I haven't answered with a number that leaves 
- **LS-146** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Yuma Az"
  - declined (reader): NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution of". I haven't answered with a number that leaves 
- **LS-150** (wrong_action; expected clarify, got decline) "houston vehicle burglaries by month by clearance status"
  - declined (reader): I can't apply "by month": breakdowns come from yearly tables; monthly or rolling breakdowns aren't available. I haven't answered with a number that leaves it out.
- **LS-160** (avoidable_decline; expected answer, got decline) "What weapons were used in robberies in Atlanta in 2024?"
  - declined (reader): I couldn't interpret "weapons were used in" in this question, so I haven't answered it with a number that ignores it.

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
  - declined (reader): NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution of". I haven't answered with a number that leaves 

## PROVISIONAL: drafted labels (never a gate): designed slice cases

### Development

No cases.

### Held out

No cases.

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
