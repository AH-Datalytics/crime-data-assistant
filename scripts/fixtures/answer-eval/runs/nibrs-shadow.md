# Answer evaluation: nibrs-shadow

Labeled set: 283 cases. Release for resolution: 2017-01..2026-10, request date 2026-10-29.

**Level: question -> delivered answer (shadow slice, release 20261028-test5).** Scored: the action; the interpretation of every answer, option continuation and alternative; the required statements on the delivered text; decline reasons by class; delivered values, directly and behind every button and alternative, against nibrs-model's independent values (raw master files; NOT MEASURED where none is given). Not measured: other sources (an option routed to Historical is not run), follow-up turns.

## Execution coverage (can this candidate take the case)

- 204: outside the shadow slice
- 79: run by this candidate

## Label eligibility (can the case be scored)

- 229: scorable (reviewed, decided policy)
- 54: label unresolved

## Refused as not built (not scored)

- LS-237: refused as not built: This build holds January 2017 through October 2026, so it does not cover 2012.

## Scored (reviewed labels, decided policy): designed slice cases

### Development

22 cases. Correct 14; unverified 6; wrong answers 0; avoidable declines 2; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 40 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 8 | 0 | 2 | 0 |
| clarify | 0 | 8 | 0 | 0 |
| decline | 0 | 0 | 4 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 10 | fail | wrong answers: pass (0); initial action: fail (80% (8/10)); direct answers: fail (80% (0 unverified)); numeric fixtures: pass (8/8 match) |
| clarify:historical count | 2021 and later | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 6 | not measured | wrong answers: pass (0); clarifications: not measured (4/6 verified correct, 2 unverified); initial action: pass (100% (6/6)); direct answers: pass (no answerable cases); numeric fixtures: pass (5/5 match) |
| clarify:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: pass (1/1 match) |
| decline:nibrs count | 2021 and later | 2 | not measured | wrong answers: pass (0); declines: not measured (1/2 verified correct, 1 unverified); initial action: pass (100% (2/2)); direct answers: pass (no answerable cases); numeric fixtures: pass (1/1 match) |
| decline:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); declines: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 1 | not measured | wrong answers: pass (0); declines: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-229** (avoidable_decline; expected answer, got decline) "Drug crimes in Detroit in 2024"
  - declined (unsupported_capability): Not in the slice yet: drug crimes are drug/narcotic violations plus drug equipment violations (D19), two measures.
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
  - unverified alternative : expected `answer`, got `Not in the slice yet: measure "arrests.shoplifting" has no executable definition in v0`
  - declined (court_outcome): NIBRS doesn't record court outcomes (prosecutions, trials, convictions, sentences or defendants); it records crimes reported to police, arrests and clearances.
- **LS-240** (unverified; expected decline, got decline) "Will carjackings go up in Memphis next year?"
  - unverified alternative : expected `answer`, got `refused: this build does not hold the months (not built)`
  - declined (forecast): The data records past crime and cannot predict the future.
- **LS-241** (avoidable_decline; expected answer, got decline) "Shoplifting arrests in Memphis in 2024"
  - declined (unsupported_capability): Not in the slice yet: measure "arrests.shoplifting" has no executable definition in v0
- **LS-243** (unverified; expected clarify, got clarify) "Shoplifting in Washington in 2024"
  - unverified option "Washington state" : expected `answer`, got `Not in the slice yet: state and national totals come later.`
  - asked which Washington: Washington, D.C. | Washington state | Washington County, Oregon | Washington County, Maryland

### Held out

42 cases. Correct 17; unverified 16; wrong answers 0; avoidable declines 7; unnecessary clarifications 0; wrong actions 2; incomplete 0. Severity score 150 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 24 | 0 | 7 | 0 |
| clarify | 0 | 3 | 2 | 0 |
| decline | 0 | 0 | 6 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:historical count | 2021 and later | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs change | 2021 and later | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs count | 2021 and later | 29 | fail | wrong answers: not measured (0, 9 answers unverified); initial action: fail (83% (24/29)); direct answers: fail (52% (9 unverified)); numeric fixtures: not measured (15/24 match, 9 not measured) |
| clarify:historical count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 3 | not measured | wrong answers: pass (0); clarifications: not measured (2/3 verified correct, 1 unverified); initial action: pass (100% (3/3)); direct answers: pass (no answerable cases); numeric fixtures: pass (3/3 match) |
| clarify:shr count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | 2021 and later | 2 | not measured | wrong answers: pass (0); declines: not measured (0/2 verified correct, 2 unverified); initial action: pass (100% (2/2)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | spans 2021 | 4 | not measured | wrong answers: pass (0); declines: not measured (0/4 verified correct, 4 unverified); initial action: pass (100% (4/4)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

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
  - unverified alternative : expected `answer`, got `Not in the slice yet: measure "arrests.simple_assault" has no executable definition in v0`
  - declined (court_outcome): NIBRS doesn't record court outcomes (prosecutions, trials, convictions, sentences or defendants); it records crimes reported to police, arrests and clearances.
- **LS-265** (unverified; expected decline, got decline) "How many shoplifting cases in Nashville went to trial in 2024?"
  - unverified alternative : expected `answer`, got `Not in the slice yet: measure "arrests.shoplifting" has no executable definition in v0`
  - declined (court_outcome): NIBRS doesn't record court outcomes (prosecutions, trials, convictions, sentences or defendants); it records crimes reported to police, arrests and clearances.
- **LS-266** (avoidable_decline; expected answer, got decline) "Motor vehicle thefts in Denver in 2023"
  - declined (unsupported_capability): Not in the slice yet: counts of this crime come from Historical or Current Trends (P01), which this NIBRS shadow does not run.
- **LS-267** (wrong_action; expected clarify, got decline) "Shootings in Nashville in 2024"
  - declined (reader): NIBRS does not track shootings as a category, so I can't apply "Shootings". For fatal shootings, the Homicide Reports tab has firearm homicides. The closest NIBRS figure is aggravated assault with a f
- **LS-268** (avoidable_decline; expected answer, got decline) "Is shoplifting in Denver up this year compared with last year?"
  - declined (reader): I can't apply "in 2026": one period per answer. I haven't answered with a number that leaves it out.
- **LS-269** (avoidable_decline; expected answer, got decline) "How many shoplifting offenses will Denver's 2024 numbers show?"
  - declined (reader): I couldn't interpret "will" in this question, so I haven't answered it with a number that ignores it.
- **LS-270** (wrong_action; expected clarify, got decline) "Shplftg in Nashville in 2024"
  - declined (reader): The question could not be read: no typed reading.
- **LS-271** (unverified; expected answer, got answer) "Simple assault victims in Milwaukee by race in 2024"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Milwaukee city police, WI: simple assault victims by race, 2024. / Each share is that category's part of all simple assault victims in 2024. / No total is established for American Indian/Alaska Native; Native 
- **LS-272** (unverified; expected answer, got answer) "Breakdown of aggravated assault victims by sex in Albuquerque for 2022"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Albuquerque city police, NM: aggravated assault victims by sex, 2022. / Each share is that category's part of all aggravated assault victims in 2022. / Source: FBI National Incident-Based Reporting System (NIB
- **LS-273** (unverified; expected answer, got answer) "Simple assault victims in Louisville by ethnicity, 2024"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Louisville city police, KY: simple assault victims by ethnicity, 2024. / Each share is that category's part of all simple assault victims in 2024. / Source: FBI National Incident-Based Reporting System (NIBRS)
- **LS-274** (unverified; expected answer, got answer) "Shoplifting in Tucson by location type in 2024"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Tucson city police, AZ: shoplifting offenses by location type, 2024. / Each share is that category's part of all shoplifting offenses in 2024. / No total is established for Air/Bus/Train Terminal; Amusement Pa
- **LS-275** (unverified; expected answer, got answer) "Theft from motor vehicle offenses in Austin by location in 2023"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Austin city police, TX: theft from motor vehicle offenses by location type, 2023. / Each share is that category's part of all theft from motor vehicle offenses in 2023. / No total is established for Abandoned/
- **LS-276** (unverified; expected answer, got answer) "Murder victims in Kansas City, Missouri by race in 2023"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Kansas City city police, MO: murder victims by race, 2023. / Each share is that category's part of all murder victims in 2023. / No total is established for American Indian/Alaska Native; Native Hawaiian/Pacif
- **LS-277** (unverified; expected answer, got answer) "simple assault victims by race in Albuquerque from 2021 to 2023"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Albuquerque city police, NM: simple assault victims by race, 2021 to 2023. / Each share is that category's part of all simple assault victims in 2021 to 2023. / No total is established for Asian; Native Hawaii
- **LS-278** (unverified; expected answer, got answer) "How many murder victims in Austin were male or female in 2023?"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Austin city police, TX: murder victims by sex, 2023. / Each share is that category's part of all murder victims in 2023. / No total is established for Female: some month had none recorded without a zero report
- **LS-279** (unverified; expected answer, got answer) "Aggravated assault victims in Albuquerque by race and year, 2021 to 2023"
  - unverified values: expected `independent expected values`, got `none given: NOT MEASURED`
  - delivered: Albuquerque city police, NM: aggravated assault victims by year and race, 2021 to 2023. / Each share is that category's part of all aggravated assault victims in the same year. / No total is established for As
- **LS-280** (avoidable_decline; expected answer, got decline) "Simple assault victims in Milwaukee by age in 2024"
  - declined (unsupported_capability): Not in the slice yet: this breakdown (age groups, weapons and other multi-valued categories, two-way breakdowns), rates and other shares.
- **LS-281** (avoidable_decline; expected answer, got decline) "Robberies in Albuquerque by weapon in 2023"
  - declined (unsupported_capability): Not in the slice yet: this breakdown (age groups, weapons and other multi-valued categories, two-way breakdowns), rates and other shares.
- **LS-282** (avoidable_decline; expected answer, got decline) "Simple assault victims in Louisville by race and sex in 2024"
  - declined (reader): I can't apply "and sex": I give one breakdown per answer; ask for one breakdown at a time. I haven't answered with a number that leaves it out.
- **LS-283** (avoidable_decline; expected answer, got decline) "Carjackings in Kansas City, Missouri by location type in 2024"
  - declined (unsupported_capability): Not in the slice yet: this breakdown (age groups, weapons and other multi-valued categories, two-way breakdowns), rates and other shares.

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
  - unverified option "St. Louis city, Missouri" option "Every year available" meaning: expected `(the label gives no meaning past this button)`, got `offenses.carjacking 2017-01..2026-10`
  - unverified option "St. Louis County, Missouri" option "Every year available" meaning: expected `(the label gives no meaning past this button)`, got `offenses.carjacking 2017-01..2026-10`
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
  - declined (unsupported_capability): Not in the slice yet: this breakdown (age groups, weapons and other multi-valued categories, two-way breakdowns), rates and other shares.
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
