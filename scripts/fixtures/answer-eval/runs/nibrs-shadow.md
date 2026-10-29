# Answer evaluation: nibrs-shadow

Labeled set: 302 cases. Release for resolution: 2017-01..2026-09, request date 2026-10-29.

**Level: question -> delivered answer (shadow slice, release 20261028-test5).** Scored: the action; the interpretation of every answer, option continuation and alternative; the required statements on the delivered text; decline reasons by class; delivered values, directly and behind every button and alternative, against nibrs-model's independent values (raw master files; NOT MEASURED where none is given). Not measured: other sources (an option routed to Historical is not run), follow-up turns.

## Execution coverage (can this candidate take the case)

- 204: outside the shadow slice
- 98: run by this candidate

## Label eligibility (can the case be scored)

- 248: scorable (reviewed, decided policy)
- 54: label unresolved

## Refused as not built (not scored)

- LS-237: refused as not built: This build holds January 2017 through September 2026, so it does not cover 2012.

## Scored (reviewed labels, decided policy): designed slice cases

### Development

22 cases. Correct 11; unverified 6; wrong answers 5; avoidable declines 0; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 500 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 10 | 0 | 0 | 0 |
| clarify | 0 | 8 | 0 | 0 |
| decline | 0 | 0 | 4 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:nibrs count | 2021 and later | 10 | fail | wrong answers: fail (1, 1 answers unverified); initial action: pass (100% (10/10)); direct answers: fail (80% (1 unverified)); numeric fixtures: fail (8/10 match, 1 not measured, 1 mismatched) |
| clarify:historical count | 2021 and later | 1 | not measured | wrong answers: pass (0); clarifications: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 6 | fail | wrong answers: fail (2); clarifications: fail (2/6 verified correct, 2 unverified, 2 failing); initial action: pass (100% (6/6)); direct answers: pass (no answerable cases); numeric fixtures: fail (3/5 match, 2 mismatched) |
| clarify:nibrs count | spans 2021 | 1 | fail | wrong answers: fail (1); clarifications: fail (0/1 verified correct, 1 failing); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: fail (0/1 match, 1 mismatched) |
| decline:nibrs count | 2021 and later | 2 | fail | wrong answers: fail (1, 1 answers unverified); declines: fail (0/2 verified correct, 1 unverified, 1 failing); initial action: pass (100% (2/2)); direct answers: pass (no answerable cases); numeric fixtures: fail (0/2 match, 1 not measured, 1 mismatched) |
| decline:nibrs count | spans 2021 | 1 | not measured | wrong answers: pass (0); declines: not measured (0/1 verified correct, 1 unverified); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 1 | not measured | wrong answers: pass (0); declines: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-224** (wrong_answer; expected clarify, got clarify) "Carjackings in St. Louis by year, 2021 to 2025"
  - material option "St. Louis County, Missouri" value 2025: expected `null UNKNOWN`, got `29 VALUE`
  - asked which St. Louis: St. Louis city, Missouri | St. Louis County, Missouri
- **LS-230** (wrong_answer; expected answer, got answer) "Shoplifting in Memphis so far this year"
  - material value total: expected `4035 VALUE`, got `3916 VALUE`
  - delivered: Memphis city police, TN: 3,916 shoplifting offenses in January through September 2026. / The data runs through September 2026: this covers January through September 2026. / Source: FBI National Incident-Based 
- **LS-232** (unverified; expected clarify, got clarify) "How many shoplifting offenses were there in 2024?"
  - unverified option "The United States" : expected `answer`, got `Not in the slice yet: state and national totals come later.`
  - asked which place: The United States | A state | A city or agency
- **LS-233** (wrong_answer; expected clarify, got clarify) "Shoplifting in Memphis"
  - material option "This year so far" value total: expected `4035 VALUE`, got `3916 VALUE`
  - asked which period: The latest complete year (2025) | This year so far | Another year
- **LS-234** (wrong_answer; expected clarify, got clarify) "Carjackings in Memphis by month"
  - unverified option "The last 10 complete years" : expected `answer`, got `refused: this build does not hold the months (not built)`
  - material option "Every year available" values: expected `118 cells`, got `117 cells`
  - material option "Every year available" value 2026-10: expected `3 VALUE`, got `missing`
  - asked which range of years: The last 10 complete years | Every year available | Another range
- **LS-235** (unverified; expected clarify, got clarify) "How many crimes were there in Detroit in 2024?"
  - unverified option "Violent crime" : expected `historical answer`, got `routed to historical: not run by this NIBRS shadow`
  - unverified option "Property crime" : expected `historical answer`, got `routed to historical: not run by this NIBRS shadow`
  - unverified option "Both" : expected `historical answer`, got `routed to historical: not run by this NIBRS shadow`
  - asked which kind of crime: Violent crime | Property crime | Both
- **LS-236** (wrong_answer; expected decline, got decline) "Shoplifting in Memphis in 2027"
  - material alternative value total: expected `4035 VALUE`, got `3916 VALUE`
  - declined (outside_release_coverage): 2027 is not in the data; the latest month available is September 2026.
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

61 cases. Correct 26; unverified 7; wrong answers 21; avoidable declines 5; unnecessary clarifications 0; wrong actions 2; incomplete 0. Severity score 2210 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 42 | 0 | 5 | 0 |
| clarify | 0 | 3 | 2 | 0 |
| decline | 0 | 0 | 9 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:historical count | 2021 and later | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs change | 2021 and later | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs count | 2021 and later | 45 | fail | wrong answers: fail (21); initial action: fail (93% (42/45)); direct answers: fail (47% (0 unverified)); numeric fixtures: fail (21/42 match, 21 mismatched) |
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
- **LS-254** (wrong_answer; expected answer, got answer) "Shoplifting in Denver year to date"
  - material value total: expected `null UNKNOWN`, got `2501 VALUE`
  - delivered: Denver city police, CO: 2,501 shoplifting offenses in January through September 2026. / The data runs through September 2026: this covers January through September 2026. / Source: FBI National Incident-Based R
- **LS-255** (wrong_answer; expected answer, got answer) "How much shoplifting has Atlanta had this year?"
  - material value total: expected `1701 VALUE`, got `1650 VALUE`
  - delivered: Atlanta city police, GA: 1,650 shoplifting offenses in January through September 2026. / The data runs through September 2026: this covers January through September 2026. / Source: FBI National Incident-Based 
- **LS-256** (wrong_answer; expected answer, got answer) "Carjackings in Nashville so far in 2026"
  - material value total: expected `null UNKNOWN`, got `29 VALUE`
  - delivered: Nashville city police, TN: 29 carjacking offenses in January through September 2026. / The data runs through September 2026: this covers January through September 2026. / Source: FBI National Incident-Based Re
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
- **LS-268** (avoidable_decline; expected answer, got decline) "Is shoplifting in Denver up this year compared with last year?"
  - declined (reader): I can't apply "in 2026": one period per answer. I haven't answered with a number that leaves it out.
- **LS-269** (avoidable_decline; expected answer, got decline) "How many shoplifting offenses will Denver's 2024 numbers show?"
  - declined (reader): I couldn't interpret "will" in this question, so I haven't answered it with a number that ignores it.
- **LS-270** (wrong_action; expected clarify, got decline) "Shplftg in Nashville in 2024"
  - declined (reader): The question could not be read: no typed reading.
- **LS-271** (wrong_answer; expected answer, got answer) "Simple assault victims in Milwaukee by race in 2024"
  - material value American Indian/Alaska Native: expected `null UNKNOWN`, got `25 VALUE`
  - material value Native Hawaiian/Pacific Islander: expected `null UNKNOWN`, got `4 VALUE`
  - delivered: Milwaukee city police, WI: simple assault victims by race, 2024. / Each share is that category's part of all simple assault victims in 2024. / Source: FBI National Incident-Based Reporting System (NIBRS), as r
- **LS-274** (wrong_answer; expected answer, got answer) "Shoplifting in Tucson by location type in 2024"
  - material value Air/Bus/Train Terminal: expected `null UNKNOWN`, got `4 VALUE`
  - material value Bank/Savings and Loan: expected `null UNKNOWN`, got `4 VALUE`
  - material value Bar/Nightclub: expected `null UNKNOWN`, got `1 VALUE`
  - material value Construction Site: expected `null UNKNOWN`, got `2 VALUE`
  - material value Government/Public Building: expected `null UNKNOWN`, got `21 VALUE`
  - material value Highway/Road/Alley/Street: expected `null UNKNOWN`, got `15 VALUE`
  - material value Hotel/Motel: expected `null UNKNOWN`, got `6 VALUE`
  - material value Liquor Store: expected `null UNKNOWN`, got `14 VALUE`
  - material value Parking Lot/Garage: expected `null UNKNOWN`, got `10 VALUE`
  - material value Rental Storage: expected `null UNKNOWN`, got `3 VALUE`
  - material value Residence/Home: expected `null UNKNOWN`, got `20 VALUE`
  - material value Restaurant: expected `null UNKNOWN`, got `15 VALUE`
  - material value Amusement Park: expected `null UNKNOWN`, got `1 VALUE`
  - material value Arena/Stadium/Fairgrounds: expected `null UNKNOWN`, got `1 VALUE`
  - material value Military Installation: expected `null UNKNOWN`, got `3 VALUE`
  - delivered: Tucson city police, AZ: shoplifting offenses by location type, 2024. / Each share is that category's part of all shoplifting offenses in 2024. / Source: FBI National Incident-Based Reporting System (NIBRS), as
- **LS-275** (wrong_answer; expected answer, got answer) "Theft from motor vehicle offenses in Austin by location in 2023"
  - material value Air/Bus/Train Terminal: expected `null UNKNOWN`, got `6 VALUE`
  - material value Bank/Savings and Loan: expected `null UNKNOWN`, got `11 VALUE`
  - material value Church/Synagogue/Temple: expected `null UNKNOWN`, got `15 VALUE`
  - material value Construction Site: expected `null UNKNOWN`, got `31 VALUE`
  - material value Convenience Store: expected `null UNKNOWN`, got `28 VALUE`
  - material value Department/Discount Store: expected `null UNKNOWN`, got `45 VALUE`
  - material value Field/Woods: expected `null UNKNOWN`, got `30 VALUE`
  - material value Government/Public Building: expected `null UNKNOWN`, got `58 VALUE`
  - material value Jail/Prison/Corrections: expected `null UNKNOWN`, got `1 VALUE`
  - material value Lake/Waterway/Beach: expected `null UNKNOWN`, got `41 VALUE`
  - material value Rental Storage: expected `null UNKNOWN`, got `14 VALUE`
  - material value Service/Gas Station: expected `null UNKNOWN`, got `29 VALUE`
  - material value Specialty Store: expected `null UNKNOWN`, got `35 VALUE`
  - material value Abandoned/Condemned Structure: expected `null UNKNOWN`, got `2 VALUE`
  - material value Amusement Park: expected `null UNKNOWN`, got `13 VALUE`
  - material value Arena/Stadium/Fairgrounds: expected `null UNKNOWN`, got `10 VALUE`
  - material value ATM Separate from Bank: expected `null UNKNOWN`, got `2 VALUE`
  - material value Auto Dealership: expected `null UNKNOWN`, got `21 VALUE`
  - material value Camp/Campground: expected `null UNKNOWN`, got `11 VALUE`
  - material value Daycare Facility: expected `null UNKNOWN`, got `6 VALUE`
  - material value Dock/Wharf/Terminal: expected `null UNKNOWN`, got `20 VALUE`
  - material value Farm Facility: expected `null UNKNOWN`, got `2 VALUE`
  - material value Gambling Facility/Casino: expected `null UNKNOWN`, got `1 VALUE`
  - material value Industrial Site: expected `null UNKNOWN`, got `2 VALUE`
  - material value School — College/University: expected `null UNKNOWN`, got `2 VALUE`
  - material value School — Elementary/Secondary: expected `null UNKNOWN`, got `15 VALUE`
  - delivered: Austin city police, TX: theft from motor vehicle offenses by location type, 2023. / Each share is that category's part of all theft from motor vehicle offenses in 2023. / Source: FBI National Incident-Based Re
- **LS-276** (wrong_answer; expected answer, got answer) "Murder victims in Kansas City, Missouri by race in 2023"
  - material value American Indian/Alaska Native: expected `null UNKNOWN`, got `1 VALUE`
  - material value Native Hawaiian/Pacific Islander: expected `null UNKNOWN`, got `1 VALUE`
  - delivered: Kansas City city police, MO: murder victims by race, 2023. / Each share is that category's part of all murder victims in 2023. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the
- **LS-277** (wrong_answer; expected answer, got answer) "simple assault victims by race in Albuquerque from 2021 to 2023"
  - material value Asian: expected `null UNKNOWN`, got `127 VALUE`
  - material value Native Hawaiian/Pacific Islander: expected `null UNKNOWN`, got `66 VALUE`
  - delivered: Albuquerque city police, NM: simple assault victims by race, 2021 to 2023. / Each share is that category's part of all simple assault victims in 2021 to 2023. / Source: FBI National Incident-Based Reporting Sy
- **LS-278** (wrong_answer; expected answer, got answer) "How many murder victims in Austin were male or female in 2023?"
  - material value Female: expected `null UNKNOWN`, got `16 VALUE`
  - delivered: Austin city police, TX: murder victims by sex, 2023. / Each share is that category's part of all murder victims in 2023. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agenc
- **LS-279** (wrong_answer; expected answer, got answer) "Aggravated assault victims in Albuquerque by race and year, 2021 to 2023"
  - material value 2021|Asian: expected `null UNKNOWN`, got `36 VALUE`
  - material value 2021|Native Hawaiian/Pacific Islander: expected `null UNKNOWN`, got `13 VALUE`
  - material value 2022|Asian: expected `null UNKNOWN`, got `23 VALUE`
  - material value 2022|Native Hawaiian/Pacific Islander: expected `null UNKNOWN`, got `11 VALUE`
  - material value 2023|Native Hawaiian/Pacific Islander: expected `null UNKNOWN`, got `6 VALUE`
  - delivered: Albuquerque city police, NM: aggravated assault victims by year and race, 2021 to 2023. / Each share is that category's part of all aggravated assault victims in the same year. / Source: FBI National Incident-
- **LS-281** (wrong_answer; expected answer, got answer) "Robberies in Albuquerque by weapon in 2023"
  - material value Rifle: expected `null UNKNOWN`, got `7 VALUE`
  - material value Shotgun: expected `null UNKNOWN`, got `8 VALUE`
  - material value Other Firearm: expected `null UNKNOWN`, got `11 VALUE`
  - material value Blunt Object: expected `null UNKNOWN`, got `47 VALUE`
  - material value Motor Vehicle: expected `null UNKNOWN`, got `1 VALUE`
  - material value Poison: expected `null UNKNOWN`, got `7 VALUE`
  - material value Explosives: expected `null UNKNOWN`, got `1 VALUE`
  - material value Fire/Incendiary Device: expected `null UNKNOWN`, got `1 VALUE`
  - material value Asphyxiation: expected `null UNKNOWN`, got `1 VALUE`
  - material value Unknown: expected `null UNKNOWN`, got `18 VALUE`
  - material value None: expected `null UNKNOWN`, got `37 VALUE`
  - delivered: Albuquerque city police, NM: robbery offenses by weapon, 2023. / Each share is that category's part of all robbery offenses in 2023. / A crime with several of these categories counts once under each, so the ca
- **LS-282** (avoidable_decline; expected answer, got decline) "Simple assault victims in Louisville by race and sex in 2024"
  - declined (reader): I can't apply "and sex": I give one breakdown per answer; ask for one breakdown at a time. I haven't answered with a number that leaves it out.
- **LS-283** (wrong_answer; expected answer, got answer) "Carjackings in Kansas City, Missouri by location type in 2024"
  - material value Bar/Nightclub: expected `null UNKNOWN`, got `2 VALUE`
  - material value Church/Synagogue/Temple: expected `null UNKNOWN`, got `1 VALUE`
  - material value Commercial/Office Building: expected `null UNKNOWN`, got `1 VALUE`
  - material value Construction Site: expected `null UNKNOWN`, got `1 VALUE`
  - material value Convenience Store: expected `null UNKNOWN`, got `7 VALUE`
  - material value Department/Discount Store: expected `null UNKNOWN`, got `1 VALUE`
  - material value Drug Store/Doctor/Hospital: expected `null UNKNOWN`, got `3 VALUE`
  - material value Grocery/Supermarket: expected `null UNKNOWN`, got `3 VALUE`
  - material value Hotel/Motel: expected `null UNKNOWN`, got `1 VALUE`
  - material value Liquor Store: expected `null UNKNOWN`, got `2 VALUE`
  - material value Restaurant: expected `null UNKNOWN`, got `3 VALUE`
  - material value Service/Gas Station: expected `null UNKNOWN`, got `8 VALUE`
  - material value Specialty Store: expected `null UNKNOWN`, got `1 VALUE`
  - material value Other/Unknown: expected `null UNKNOWN`, got `7 VALUE`
  - material value Camp/Campground: expected `null UNKNOWN`, got `1 VALUE`
  - material value Industrial Site: expected `null UNKNOWN`, got `3 VALUE`
  - material value Park/Playground: expected `null UNKNOWN`, got `4 VALUE`
  - delivered: Kansas City city police, MO: carjacking offenses by location type, 2024. / Each share is that category's part of all carjacking offenses in 2024. / Source: FBI National Incident-Based Reporting System (NIBRS),
- **LS-286** (wrong_answer; expected answer, got answer) "Carjackings and shoplifting in Raleigh by month in 2024"
  - material value offenses.carjacking 2024-04: expected `null UNKNOWN_UNEVIDENCED_ZERO`, got `0 VALUE`
  - material value offenses.carjacking 2024-11: expected `null UNKNOWN_UNEVIDENCED_ZERO`, got `0 VALUE`
  - delivered: Raleigh city police, NC: carjacking offenses and shoplifting offenses by month, 2024. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5
- **LS-287** (wrong_answer; expected answer, got answer) "Robberies in Fort Worth by weapon in 2023"
  - material value Rifle: expected `null UNKNOWN`, got `23 VALUE`
  - material value Shotgun: expected `null UNKNOWN`, got `1 VALUE`
  - material value Other Firearm: expected `null UNKNOWN`, got `4 VALUE`
  - material value Motor Vehicle: expected `null UNKNOWN`, got `9 VALUE`
  - material value Unknown: expected `null UNKNOWN`, got `8 VALUE`
  - delivered: Fort Worth city police, TX: robbery offenses by weapon, 2023. / Each share is that category's part of all robbery offenses in 2023. / A crime with several of these categories counts once under each, so the cat
- **LS-288** (wrong_answer; expected answer, got answer) "Aggravated assault victims in Mesa by age in 2024"
  - material value Unknown: expected `null UNKNOWN`, got `38 VALUE`
  - material value 65+: expected `null UNKNOWN`, got `61 VALUE`
  - delivered: Mesa city police, AZ: aggravated assault victims by age group, 2024. / Each share is that category's part of all aggravated assault victims in 2024. / Age groups: Under 18 (ages 1-17 and infants under one year
- **LS-289** (wrong_answer; expected answer, got answer) "Murder victims in Colorado Springs by relationship to the offender in 2023"
  - material value Acquaintance: expected `null UNKNOWN`, got `3 VALUE`
  - material value Boyfriend/Girlfriend: expected `null UNKNOWN`, got `2 VALUE`
  - material value Child: expected `null UNKNOWN`, got `1 VALUE`
  - material value Otherwise Known: expected `null UNKNOWN`, got `1 VALUE`
  - material value Relationship Unknown: expected `null UNKNOWN`, got `16 VALUE`
  - material value Stranger: expected `null UNKNOWN`, got `1 VALUE`
  - delivered: Colorado Springs city police, CO: murder victims by relationship to the offender, 2023. / Each share is that category's part of all murder victims in 2023. / A crime with several of these categories counts onc
- **LS-290** (wrong_answer; expected answer, got answer) "Murders by strangers in Virginia Beach in 2024"
  - material value total: expected `null UNKNOWN`, got `4 VALUE`
  - delivered: Virginia Beach city police, VA: 4 murder victims by a stranger in 2024. / Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release 20261028-test5.
- **LS-291** (wrong_answer; expected answer, got answer) "Carjackings in Wichita by location type in 2024"
  - material value Bar/Nightclub: expected `null UNKNOWN`, got `1 VALUE`
  - material value Convenience Store: expected `null UNKNOWN`, got `2 VALUE`
  - material value Department/Discount Store: expected `null UNKNOWN`, got `1 VALUE`
  - material value Drug Store/Doctor/Hospital: expected `null UNKNOWN`, got `1 VALUE`
  - material value Highway/Road/Alley/Street: expected `null UNKNOWN`, got `10 VALUE`
  - material value Hotel/Motel: expected `null UNKNOWN`, got `3 VALUE`
  - material value Parking Lot/Garage: expected `null UNKNOWN`, got `3 VALUE`
  - material value Residence/Home: expected `null UNKNOWN`, got `15 VALUE`
  - material value Restaurant: expected `null UNKNOWN`, got `1 VALUE`
  - material value Specialty Store: expected `null UNKNOWN`, got `1 VALUE`
  - material value Camp/Campground: expected `null UNKNOWN`, got `2 VALUE`
  - delivered: Wichita city police, KS: carjacking offenses by location type, 2024. / Each share is that category's part of all carjacking offenses in 2024. / Source: FBI National Incident-Based Reporting System (NIBRS), as 
- **LS-292** (wrong_answer; expected answer, got answer) "Simple assaults by men and women in Oklahoma City in 2024"
  - material value Unknown: expected `null UNKNOWN`, got `33 VALUE`
  - delivered: Oklahoma City city police, OK: simple assault victims by offender sex, 2024. / Each share is that category's part of all simple assault victims in 2024. / A crime with several of these categories counts once u
- **LS-293** (wrong_answer; expected answer, got answer) "Robbery offenders in Raleigh by sex in 2024"
  - material value Unknown: expected `null UNKNOWN`, got `32 VALUE`
  - delivered: Raleigh city police, NC: robbery offenders by offender sex, 2024. / Each share is that category's part of all robbery offenders in 2024. / Source: FBI National Incident-Based Reporting System (NIBRS), as repor
- **LS-294** (avoidable_decline; expected answer, got decline) "Aggravated assault victims in Mesa by race and sex in 2024"
  - declined (reader): I can't apply "and sex": I give one breakdown per answer; ask for one breakdown at a time. I haven't answered with a number that leaves it out.
- **LS-296** (wrong_answer; expected answer, got answer) "Stabbings in Oklahoma City in 2024"
  - material value victims.murder total: expected `null UNKNOWN`, got `9 VALUE`
  - delivered: Stabbings here are murder victims and aggravated assault victims with a knife or cutting instrument. / Oklahoma City city police, OK, 2024: 9 murder victims with a knife or cutting instrument; 606 aggravated a

## Scored (reviewed labels, decided policy): replay cases inside the slice

### Development

2 cases. Correct 1; unverified 0; wrong answers 1; avoidable declines 0; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 100 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| clarify | 0 | 2 | 0 | 0 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| clarify:nibrs count | 2021 and later | 1 | pass | wrong answers: pass (0); clarifications: pass (1/1 verified correct); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: pass (1/1 match) |
| clarify:no meaning | no period | 1 | fail | wrong answers: fail (1); clarifications: fail (0/1 verified correct, 1 failing); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: fail (0/1 match, 1 mismatched) |

Discrepancies and unverified cases:

- **LS-140** (wrong_answer; expected clarify, got clarify) "St Louis carjackings per month"
  - unverified option "St. Louis city, Missouri" option "Every year available" meaning: expected `(the label gives no meaning past this button)`, got `offenses.carjacking 2017-01..2026-09`
  - material option "St. Louis city, Missouri" option "Every year available" values: expected `118 cells`, got `117 cells`
  - material option "St. Louis city, Missouri" option "Every year available" value 2026-01: expected `null UNKNOWN_UNEVIDENCED_ZERO`, got `0 VALUE`
  - material option "St. Louis city, Missouri" option "Every year available" value 2026-09: expected `null UNKNOWN_UNEVIDENCED_ZERO`, got `0 VALUE`
  - material option "St. Louis city, Missouri" option "Every year available" value 2026-10: expected `null UNKNOWN`, got `missing`
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
