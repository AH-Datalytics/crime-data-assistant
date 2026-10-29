# Answer evaluation: nibrs-shadow

Labeled set: 241 cases. Release for resolution: 2017-01..2026-10, request date 2026-10-29.

**Level: question -> delivered answer (shadow slice, release 20261028-test5).** Scored: the action; the interpretation of every answer, option continuation and alternative; the required statements on the delivered text; decline reasons by class; delivered values against independent expected values (NOT MEASURED until they are given). Not measured: other sources (an option routed to Historical is not run), follow-up turns.

## Execution coverage (can this candidate take the case)

- 204: outside the shadow slice
- 37: run by this candidate

## Label eligibility (can the case be scored)

- 164: scorable (reviewed, decided policy)
- 54: label unresolved
- 23: label drafted

## Refused as not built (not scored)

- LS-237: refused as not built: This build holds January 2017 through October 2026; 2012 is not in it.

## Scored (reviewed labels, decided policy): designed slice cases

### Development

No cases.

### Held out

No cases.

## Scored (reviewed labels, decided policy): replay cases inside the slice

### Development

2 cases. Correct 0; unverified 1; wrong answers 0; avoidable declines 1; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 20 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| clarify | 0 | 1 | 0 | 0 |
| answer | 0 | 0 | 1 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-140** (unverified; expected clarify, got clarify) "St Louis carjackings per month"
  - unverified option "Last 10 complete years" : expected `answer`, got `refused: this build does not hold the months (not built)`
  - asked which range of years: The last 10 complete years | Every year available | Another range
- **LS-151** (avoidable_decline; expected answer, got decline) "Shoplfting in baltimore per month, 2021-2025"
  - declined (reader): The question could not be read: no typed reading.

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
  - declined (unsupported_capability): Not in the slice yet: v0 cannot group offense by offense.clearance_type
- **LS-124** (avoidable_decline; expected answer, got decline) "Narcotics possession or distribution arrests in tolleson Arizona in 2025"
  - declined (reader): NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution". I haven't answered with a number that leaves it 
- **LS-135** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 In Tucson az. Please provide total"
  - declined (reader): I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug 
- **LS-146** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Yuma Az"
  - declined (reader): I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug 
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
  - declined (reader): I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug 

## PROVISIONAL: drafted labels (never a gate): designed slice cases

### Development

20 cases. Correct 3; unverified 10; wrong answers 0; avoidable declines 4; unnecessary clarifications 0; wrong actions 0; incomplete 3. Severity score 83 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 7 | 0 | 4 | 0 |
| clarify | 0 | 5 | 0 | 0 |
| decline | 0 | 0 | 4 | 0 |

| Capability | Era | Cases | Would-be gate (not a gate) | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 11 | fail | wrong answers: not measured (0, 7 answers unverified); initial action: fail (64% (7/11)); direct answers: fail (0% (7 unverified)); numeric fixtures: not measured (0/7 match, 7 not measured) |
| clarify:historical count | 2021 and later | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 3 | fail | wrong answers: pass (0); clarifications: fail (1/3 verified correct, 1 unverified, 1 failing); initial action: pass (100% (3/3)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | 2021 and later | 2 | fail | wrong answers: pass (0); declines: fail (1/2 verified correct, 1 failing); initial action: pass (100% (2/2)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | spans 2021 | 1 | fail | wrong answers: pass (0); declines: fail (0/1 verified correct, 1 failing); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 1 | not measured | wrong answers: pass (0); declines: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-219** (unverified; expected answer, got answer) "How many shoplifting offenses were there in Memphis in 2024?"
  - unverified values: expected `independent expected values`, got `none given yet: NOT MEASURED`
  - delivered: Memphis city police, TN: 10,149 shoplifting offenses in 2024. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5.
- **LS-220** (unverified; expected answer, got answer) "Memphis shoplifting 2024"
  - unverified values: expected `independent expected values`, got `none given yet: NOT MEASURED`
  - delivered: Memphis city police, TN: 10,149 shoplifting offenses in 2024. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5.
- **LS-221** (unverified; expected answer, got answer) "shoplifting in Memphis, TN in 2024"
  - unverified values: expected `independent expected values`, got `none given yet: NOT MEASURED`
  - delivered: Memphis city police, TN: 10,149 shoplifting offenses in 2024. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5.
- **LS-224** (unverified; expected answer, got answer) "Carjackings in St. Louis by year, 2021 to 2025"
  - unverified values: expected `independent expected values`, got `none given yet: NOT MEASURED`
  - delivered: St. Louis city police, MO: carjacking offenses by year, 2021 to 2025. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5.
- **LS-225** (unverified; expected answer, got answer) "carjackings in Memphis TN by month in 2025"
  - unverified values: expected `independent expected values`, got `none given yet: NOT MEASURED`
  - delivered: Memphis city police, TN: carjacking offenses by month, 2025. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5.
- **LS-226** (unverified; expected answer, got answer) "How many simple assaults were there in Detroit in 2023?"
  - unverified values: expected `independent expected values`, got `none given yet: NOT MEASURED`
  - delivered: Detroit city police, MI: 16,163 simple assault victims in 2023. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5.
- **LS-227** (unverified; expected answer, got answer) "simple assault victims in Detroit by month in 2023"
  - unverified values: expected `independent expected values`, got `none given yet: NOT MEASURED`
  - delivered: Detroit city police, MI: simple assault victims by month, 2023. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5.
- **LS-228** (avoidable_decline; expected answer, got decline) "Thefts from motor vehicles in Columbus, Ohio in 2022"
  - declined (reader): I couldn't interpret "from motor vehicles in" in this question, so I haven't answered it with a number that ignores it.
- **LS-229** (avoidable_decline; expected answer, got decline) "Drug crimes in Detroit in 2024"
  - declined (unsupported_capability): Not in the slice yet: drug crimes are drug/narcotic violations plus drug equipment violations (D19), two measures.
- **LS-230** (avoidable_decline; expected answer, got decline) "Shoplifting in Memphis so far this year"
  - declined (reader): I couldn't interpret "so far this year" in this question, so I haven't answered it with a number that ignores it.
- **LS-231** (incomplete; expected clarify, got clarify) "Thefts from motor vehicles in Kansas City in 2024"
  - material option "Kansas City, Missouri" : expected `answer`, got `decline: I couldn't interpret "from motor vehicles in" in this question, so I haven't answered it with a number that ignores it.`
  - material option "Kansas City, Kansas" : expected `answer`, got `decline: I couldn't interpret "from motor vehicles in" in this question, so I haven't answered it with a number that ignores it.`
  - asked which Kansas City: Kansas City, Missouri | Kansas City, Kansas
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
  - declined (court_outcome): I couldn't interpret "led to" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record court outcomes (prosecutions, convictions, sentences or defendants); 
- **LS-240** (incomplete; expected decline, got decline) "Will carjackings go up in Memphis next year?"
  - material reason: expected `forecast: The data records past crime and cannot predict next year.`, got `reader: I couldn't interpret "Will" in this question, so I haven't answered it with a number that ignores it. I couldn't interpret "go up in" in this question, so I hav`
  - declined (reader): I couldn't interpret "Will" in this question, so I haven't answered it with a number that ignores it. I couldn't interpret "go up in" in this question, so I haven't answered it with a number that igno
- **LS-241** (avoidable_decline; expected answer, got decline) "Shoplifting arrests in Memphis in 2024"
  - declined (unsupported_capability): Not in the slice yet: measure "arrests.shoplifting" has no executable definition in v0

### Held out

2 cases. Correct 0; unverified 2; wrong answers 0; avoidable declines 0; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 0 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 2 | 0 | 0 | 0 |

| Capability | Era | Cases | Would-be gate (not a gate) | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 2 | not measured | wrong answers: not measured (0, 2 answers unverified); initial action: pass (100% (2/2)); direct answers: not measured (0% verified, 2 unverified); numeric fixtures: not measured (0/2 match, 2 not measured) |

Discrepancies and unverified cases:

- **LS-222** (unverified; expected answer, got answer) "How many shoplifting victims were there in Memphis in 2024?"
  - unverified values: expected `independent expected values`, got `none given yet: NOT MEASURED`
  - delivered: Memphis city police, TN: 10,149 shoplifting offenses in 2024. / Property crimes are counted by offense, not by victim. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency;
- **LS-223** (unverified; expected answer, got answer) "Shoplifting in Baltimore by month from 2022 to 2025"
  - unverified values: expected `independent expected values`, got `none given yet: NOT MEASURED`
  - delivered: Baltimore city police, MD: shoplifting offenses by month, 2022 to 2025. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5.

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
