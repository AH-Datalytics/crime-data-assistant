# Answer evaluation: nibrs-shadow

Labeled set: 396 cases. Release for resolution: 2017-01..2026-09, request date 2026-10-29.

**Level: question -> delivered answer (shadow slice, release 20261028-test5).** Scored: the action; the interpretation of every answer, option continuation and alternative; the required statements on the delivered text; decline reasons by class; delivered values, directly and behind every button and alternative, against nibrs-model's independent values (raw master files; NOT MEASURED where none is given). Not measured: other sources (an option routed to Historical is not run), follow-up turns.

## Execution coverage (can this candidate take the case)

- 204: outside the shadow slice
- 192: run by this candidate

## Label eligibility (can the case be scored)

- 339: scorable (reviewed, decided policy)
- 54: label unresolved
- 3: label drafted

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
| clarify:nibrs count | 2021 and later | 6 | not measured | wrong answers: not measured (0, 2 answers unverified); clarifications: not measured (4/6 verified correct, 2 unverified); initial action: pass (100% (6/6)); direct answers: pass (no answerable cases); numeric fixtures: not measured (4/6 match, 2 not measured) |
| clarify:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: pass (1/1 match) |
| decline:nibrs count | 2021 and later | 2 | not measured | wrong answers: not measured (0, 1 answers unverified); declines: not measured (1/2 verified correct, 1 unverified); initial action: pass (100% (2/2)); direct answers: pass (no answerable cases); numeric fixtures: not measured (1/2 match, 1 not measured) |
| decline:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); declines: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 1 | not measured | wrong answers: pass (0); declines: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-232** (unverified; expected clarify, got clarify) "How many shoplifting offenses were there in 2024?"
  - unverified option "The United States" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "The United States" button "Show only agencies that reported every month" meaning: expected `(the label gives no meaning past this button)`, got `offenses.shoplifting 2024-01..2024-12`
  - unverified option "The United States" button "Show only agencies that reported every month" values: expected `independent expected values`, got `none given: NOT MEASURED`
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
  - delivered: Memphis, Tennessee: 2,078 shoplifting arrests in 2024. / Reported by the Memphis Police Department. / Each arrest counts once; NIBRS cannot tell when one person was arrested more than once. / Source: FBI NIBRS
- **LS-243** (unverified; expected clarify, got clarify) "Shoplifting in Washington in 2024"
  - unverified option "Washington state" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "Washington state" button "Show only agencies that reported every month" meaning: expected `(the label gives no meaning past this button)`, got `offenses.shoplifting 2024-01..2024-12`
  - unverified option "Washington state" button "Show only agencies that reported every month" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which Washington: Washington, D.C. | Washington state | Washington County, Oregon | Washington County, Maryland

### Held out

152 cases. Correct 132; unverified 14; wrong answers 0; avoidable declines 4; unnecessary clarifications 0; wrong actions 2; incomplete 0. Severity score 90 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 126 | 0 | 4 | 0 |
| clarify | 0 | 5 | 2 | 0 |
| decline | 0 | 0 | 15 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:historical change | 2021 and later | 1 | pass | wrong answers: pass (0); initial action: pass (100% (1/1)); direct answers: pass (100%); numeric fixtures: pass (1/1 match) |
| answer:historical count | 2021 and later | 5 | fail | wrong answers: pass (0); initial action: fail (80% (4/5)); direct answers: fail (80% (0 unverified)); numeric fixtures: pass (4/4 match) |
| answer:historical count | before 2021 | 1 | pass | wrong answers: pass (0); initial action: pass (100% (1/1)); direct answers: pass (100%); numeric fixtures: pass (1/1 match) |
| answer:historical count | spans 2021 | 1 | pass | wrong answers: pass (0); initial action: pass (100% (1/1)); direct answers: pass (100%); numeric fixtures: pass (1/1 match) |
| answer:historical rate | 2021 and later | 3 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (3/3)); direct answers: not measured (67% verified, 1 unverified); numeric fixtures: pass (2/2 match) |
| answer:nibrs change | 2021 and later | 10 | pass | wrong answers: pass (0); initial action: pass (100% (10/10)); direct answers: pass (100%); numeric fixtures: pass (10/10 match) |
| answer:nibrs count | 2021 and later | 94 | pass | wrong answers: pass (0); initial action: pass (97% (91/94)); direct answers: pass (97%); numeric fixtures: pass (91/91 match) |
| answer:nibrs count | spans 2021 | 2 | pass | wrong answers: pass (0); initial action: pass (100% (2/2)); direct answers: pass (100%); numeric fixtures: pass (2/2 match) |
| answer:nibrs rate | 2021 and later | 10 | pass | wrong answers: pass (0); initial action: pass (100% (10/10)); direct answers: pass (100%); numeric fixtures: pass (10/10 match) |
| answer:nibrs share | 2021 and later | 1 | pass | wrong answers: pass (0); initial action: pass (100% (1/1)); direct answers: pass (100%); numeric fixtures: pass (1/1 match) |
| answer:rtci count | period not mapped | 1 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (1/1)); direct answers: not measured (0% verified, 1 unverified); numeric fixtures: not measured (no delivered values) |
| answer:shr count | 2021 and later | 1 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (1/1)); direct answers: not measured (0% verified, 1 unverified); numeric fixtures: not measured (no delivered values) |
| clarify:historical count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 5 | not measured | wrong answers: not measured (0, 3 answers unverified); clarifications: not measured (2/5 verified correct, 3 unverified); initial action: pass (100% (5/5)); direct answers: pass (no answerable cases); numeric fixtures: not measured (2/5 match, 3 not measured) |
| clarify:shr count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | 2021 and later | 4 | not measured | wrong answers: not measured (0, 3 answers unverified); declines: not measured (1/4 verified correct, 3 unverified); initial action: pass (100% (4/4)); direct answers: pass (no answerable cases); numeric fixtures: not measured (1/4 match, 3 not measured) |
| decline:nibrs count | spans 2021 | 4 | not measured | wrong answers: pass (0); declines: not measured (0/4 verified correct, 4 unverified); initial action: pass (100% (4/4)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 7 | not measured | wrong answers: pass (0); declines: not measured (6/7 verified correct, 1 unverified); initial action: pass (100% (7/7)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-245** (unverified; expected clarify, got clarify) "Shoplifting in New York in 2024"
  - unverified option "New York state" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "New York state" button "Show only agencies that reported every month" meaning: expected `(the label gives no meaning past this button)`, got `offenses.shoplifting 2024-01..2024-12`
  - unverified option "New York state" button "Show only agencies that reported every month" values: expected `independent expected values`, got `none given: NOT MEASURED`
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
- **LS-269** (avoidable_decline; expected answer, got decline) "How many shoplifting offenses will Denver's 2024 numbers show?"
  - declined (reader): I couldn't interpret "will" in this question, so I haven't answered it with a number that ignores it.
- **LS-270** (wrong_action; expected clarify, got decline) "Shplftg in Nashville in 2024"
  - declined (reader): The question could not be read: no typed reading.
- **LS-282** (avoidable_decline; expected answer, got decline) "Simple assault victims in Louisville by race and sex in 2024"
  - declined (reader): I can't apply "and sex": I give one breakdown per answer; ask for one breakdown at a time. I haven't answered with a number that leaves it out.
- **LS-294** (avoidable_decline; expected answer, got decline) "Aggravated assault victims in Mesa by race and sex in 2024"
  - declined (reader): I can't apply "and sex": I give one breakdown per answer; ask for one breakdown at a time. I haven't answered with a number that leaves it out.
- **LS-348** (unverified; expected answer, got answer) "Robberies in Texas this year"
  - unverified route: expected `rtci answer`, got `routed to rtci: not run by this NIBRS shadow`
  - routed to rtci: This year's robbery figures come from Current Trends (Crime Index), through the latest reported month, for the agencies it covers. This NIBRS shadow does not run Current Trends.
- **LS-349** (unverified; expected answer, got answer) "Murders in the US by victim-offender relationship in 2023"
  - unverified route: expected `shr answer`, got `routed to shr: not run by this NIBRS shadow`
  - routed to shr: Murders by victim-offender relationship come from Homicide Reports (FBI SHR), which count the homicides agencies reported to the SHR, not a complete national estimate. This NIBRS shadow does not run H
- **LS-363** (unverified; expected answer, got answer) "Robbery clearance rate in Atlanta in 2023"
  - unverified route: expected `historical answer`, got `routed to historical: not run by this NIBRS shadow`
  - routed to historical: The robbery clearance rate of an agency for a completed year comes from Historical (the FBI's SRS clearances, as the agency reported them), not computed from NIBRS. This NIBRS shadow does not run Hi
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
  - declined (court_outcome): NIBRS doesn't record charges or court outcomes (prosecutions, trials, convictions, sentences or defendants); it records crimes reported to police, arrests and clearances.
- **LS-392** (unverified; expected decline, got decline) "Aggravated assaults in Tennessee in 2024 by offender sex"
  - unverified reason: expected `Offender breakdowns for a whole state are not built yet; they are for one agency or several named agencies.`, got `unsupported_capability`
  - declined (unsupported_capability): Offender breakdowns for a whole state or the nation are not built yet; they are for one agency or several named agencies.

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
  - delivered: Houston, Texas: theft from motor vehicle offenses by year and clearance status, January 2018 through September 2026. / Reported by the Houston Police Department. / No total is established for Cleared (2018); U
- **LS-124** (avoidable_decline; expected answer, got decline) "Narcotics possession or distribution arrests in tolleson Arizona in 2025"
  - declined (reader): NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution". I haven't answered with a number that leaves it 
- **LS-135** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 In Tucson az. Please provide total"
  - declined (reader): NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution of". I haven't answered with a number that leaves 
- **LS-146** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Yuma Az"
  - declined (reader): NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution of". I haven't answered with a number that leaves 
- **LS-150** (unverified; expected clarify, got clarify) "houston vehicle burglaries by month by clearance status"
  - unverified option "Last 10 complete years" : expected `answer`, got `refused: this build does not hold the months (not built)`
  - unverified option "Every year available" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which range of years: The last 10 complete years | Every year available | Another range
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

3 cases. Correct 3; unverified 0; wrong answers 0; avoidable declines 0; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 0 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 3 | 0 | 0 | 0 |

| Capability | Era | Cases | Would-be gate (not a gate) | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 3 | pass | wrong answers: pass (0); initial action: pass (100% (3/3)); direct answers: pass (100%); numeric fixtures: pass (3/3 match) |

Discrepancies and unverified cases:


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
