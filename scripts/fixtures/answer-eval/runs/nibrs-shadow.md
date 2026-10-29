# Answer evaluation: nibrs-shadow

Labeled set: 245 cases. Release for resolution: 2017-01..2026-10, request date 2026-10-29.

**Level: question -> delivered answer (shadow slice, release 20261028-test5).** Scored: the action; the interpretation of every answer, option continuation and alternative; the required statements on the delivered text; decline reasons by class; delivered values, directly and behind every button and alternative, against nibrs-model's independent values (raw master files; NOT MEASURED where none is given). Not measured: other sources (an option routed to Historical is not run), follow-up turns.

## Execution coverage (can this candidate take the case)

- 204: outside the shadow slice
- 41: run by this candidate

## Label eligibility (can the case be scored)

- 162: scorable (reviewed, decided policy)
- 54: label unresolved
- 29: label drafted

## Refused as not built (not scored)

- LS-237: refused as not built: This build holds January 2017 through October 2026, so it does not cover 2012.

## Scored (reviewed labels, decided policy): designed slice cases

### Development

No cases.

### Held out

No cases.

## Scored (reviewed labels, decided policy): replay cases inside the slice

### Development

No cases.

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
  - declined (unsupported_capability): Not in the slice yet: breakdowns by category, shares and rates.
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

22 cases. Correct 9; unverified 6; wrong answers 0; avoidable declines 4; unnecessary clarifications 0; wrong actions 1; incomplete 2. Severity score 87 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 6 | 0 | 4 | 0 |
| clarify | 0 | 7 | 1 | 0 |
| decline | 0 | 0 | 4 | 0 |

| Capability | Era | Cases | Would-be gate (not a gate) | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 10 | fail | wrong answers: pass (0); initial action: fail (60% (6/10)); direct answers: fail (60% (0 unverified)); numeric fixtures: pass (6/6 match) |
| clarify:historical count | 2021 and later | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 6 | fail | wrong answers: pass (0); clarifications: fail (1/6 verified correct, 4 unverified, 1 failing); initial action: fail (83% (5/6)); direct answers: pass (no answerable cases); numeric fixtures: not measured (1/4 match, 3 not measured) |
| clarify:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: pass (1/1 match) |
| decline:nibrs count | 2021 and later | 2 | fail | wrong answers: pass (0); declines: fail (1/2 verified correct, 1 failing); initial action: pass (100% (2/2)); direct answers: pass (no answerable cases); numeric fixtures: pass (1/1 match) |
| decline:nibrs count | spans 2021 | 1 | fail | wrong answers: pass (0); declines: fail (0/1 verified correct, 1 failing); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 1 | not measured | wrong answers: pass (0); declines: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-224** (unverified; expected clarify, got clarify) "Carjackings in St. Louis by year, 2021 to 2025"
  - unverified option "St. Louis County, Missouri" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which St. Louis: St. Louis city, Missouri | St. Louis County, Missouri
- **LS-228** (avoidable_decline; expected answer, got decline) "Thefts from motor vehicles in Columbus, Ohio in 2022"
  - declined (reader): I couldn't interpret "from motor vehicles in" in this question, so I haven't answered it with a number that ignores it.
- **LS-229** (avoidable_decline; expected answer, got decline) "Drug crimes in Detroit in 2024"
  - declined (unsupported_capability): Not in the slice yet: drug crimes are drug/narcotic violations plus drug equipment violations (D19), two measures.
- **LS-230** (avoidable_decline; expected answer, got decline) "Shoplifting in Memphis so far this year"
  - declined (reader): I couldn't interpret "so far this year" in this question, so I haven't answered it with a number that ignores it.
- **LS-231** (wrong_action; expected clarify, got decline) "Thefts from motor vehicles in Kansas City in 2024"
  - declined (reader): I couldn't interpret "from motor vehicles in" in this question, so I haven't answered it with a number that ignores it.
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
- **LS-239** (incomplete; expected decline, got decline) "How many shoplifting arrests in Memphis in 2024 led to convictions?"
  - declined (court_outcome): NIBRS doesn't record court outcomes (prosecutions, convictions, sentences or defendants); it records crimes reported to police, arrests and clearances, so I can't apply "convictions". I haven't 
- **LS-240** (incomplete; expected decline, got decline) "Will carjackings go up in Memphis next year?"
  - material reason: expected `forecast: The data records past crime and cannot predict next year.`, got `reader: I couldn't interpret "Will" in this question, so I haven't answered it with a number that ignores it. I couldn't interpret "go up in" in this question, so I hav`
  - declined (reader): I couldn't interpret "Will" in this question, so I haven't answered it with a number that ignores it. I couldn't interpret "go up in" in this question, so I haven't answered it with a number that igno
- **LS-241** (avoidable_decline; expected answer, got decline) "Shoplifting arrests in Memphis in 2024"
  - declined (unsupported_capability): Not in the slice yet: measure "arrests.shoplifting" has no executable definition in v0
- **LS-242** (unverified; expected clarify, got clarify) "Shoplifting in Baltimore in 2024"
  - unverified option "Baltimore city, Maryland" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "Baltimore County, Maryland" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which Baltimore: Baltimore city, Maryland | Baltimore County, Maryland
- **LS-243** (unverified; expected clarify, got clarify) "Shoplifting in Washington in 2024"
  - unverified option "Washington, D.C." values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "Washington state" : expected `answer`, got `Not in the slice yet: state and national totals come later.`
  - unverified option "Washington County, Oregon" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "Washington County, Maryland" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which Washington: Washington, D.C. | Washington state | Washington County, Oregon | Washington County, Maryland

### Held out

4 cases. Correct 1; unverified 3; wrong answers 0; avoidable declines 0; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 0 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 1 | 0 | 0 | 0 |
| clarify | 0 | 3 | 0 | 0 |

| Capability | Era | Cases | Would-be gate (not a gate) | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 1 | pass | wrong answers: pass (0); initial action: pass (100% (1/1)); direct answers: pass (100%); numeric fixtures: pass (1/1 match) |
| clarify:nibrs count | 2021 and later | 3 | not measured | wrong answers: pass (0); clarifications: not measured (0/3 verified correct, 3 unverified); initial action: pass (100% (3/3)); direct answers: pass (no answerable cases); numeric fixtures: not measured (0/3 match, 3 not measured) |

Discrepancies and unverified cases:

- **LS-223** (unverified; expected clarify, got clarify) "Shoplifting in Baltimore by month from 2022 to 2025"
  - unverified option "Baltimore County, Maryland" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which Baltimore: Baltimore city, Maryland | Baltimore County, Maryland
- **LS-244** (unverified; expected clarify, got clarify) "Shoplifting in Columbus in 2024"
  - unverified option "Columbus, Ohio" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "Columbus, Georgia" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - asked which Columbus: Columbus, Ohio | Columbus, Georgia
- **LS-245** (unverified; expected clarify, got clarify) "Shoplifting in New York in 2024"
  - unverified option "New York City" values: expected `independent expected values`, got `none given: NOT MEASURED`
  - unverified option "New York state" : expected `answer`, got `Not in the slice yet: state and national totals come later.`
  - asked which New York: New York City | New York state

## PROVISIONAL: drafted labels (never a gate): replay cases inside the slice

### Development

2 cases. Correct 1; unverified 0; wrong answers 0; avoidable declines 0; unnecessary clarifications 0; wrong actions 1; incomplete 0. Severity score 5 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| clarify | 0 | 1 | 1 | 0 |

| Capability | Era | Cases | Would-be gate (not a gate) | Categories |
|---|---|---|---|---|
| clarify:nibrs count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:no meaning | no period | 1 | not measured | wrong answers: pass (0); clarifications: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-151** (wrong_action; expected clarify, got decline) "Shoplfting in baltimore per month, 2021-2025"
  - declined (reader): The question could not be read: no typed reading.

### Held out

No cases.

## PROVISIONAL: drafted labels (never a gate): replay cases next to the slice (action and reason)

### Development

No cases.

### Held out

No cases.
