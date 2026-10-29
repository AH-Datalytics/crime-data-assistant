# Answer evaluation: nibrs-reader

Labeled set: 218 cases. Release for resolution: 1991-01..2026-10, request date 2026-10-28. Level: question -> reader (values not measured).

## Not scored

- 118: another tab: no adapter for this source yet
- 70: label drafted
- 18: label unresolved
- 7: a follow-up: the reader takes one turn
- 1: a button: the reader returns no structured options

## Scored (reviewed labels, decided policy)

4 cases (dev 3, held out 1). Correct 4; wrong answers 0; avoidable declines 0; unnecessary clarifications 0; wrong actions 0; incomplete 0. Severity score 0 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| decline | 0 | 0 | 4 | 0 |

| Capability | Era | Cases | Wrong | Incomplete | Initial action | Direct answers | Gate |
|---|---|---|---|---|---|---|---|
| nibrs:decline | relative period | 4 | 0 | 0 | 100% | n/a | pass |

Numeric fixtures: not measured (no compiler yet; values are pending the canonical build).

### Discrepancies


## PROVISIONAL: drafted or open-policy labels (never a gate)

70 cases (dev 64, held out 6). Correct 3; wrong answers 30; avoidable declines 18; unnecessary clarifications 0; wrong actions 14; incomplete 5. Severity score 3435 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 22 | 0 | 14 | 4 |
| clarify | 6 | 2 | 9 | 5 |
| decline | 2 | 0 | 6 | 0 |

| Capability | Era | Cases | Wrong | Incomplete | Initial action | Direct answers | Gate |
|---|---|---|---|---|---|---|---|
| historical:change | 2021 and later | 1 | 1 | 0 | 100% | 0% | fail: 1 wrong answer(s); direct answers 0% < 95% |
| historical:change | relative period | 1 | 0 | 0 | 0% | 0% | fail: initial action 0% < 95%; direct answers 0% < 95% |
| historical:count | 2021 and later | 9 | 6 | 0 | 67% | 0% | fail: 6 wrong answer(s); initial action 67% < 95%; direct answers 0% < 95% |
| historical:count | before 2021 | 2 | 2 | 0 | 100% | 0% | fail: 2 wrong answer(s); direct answers 0% < 95% |
| historical:rank | 2021 and later | 1 | 1 | 0 | 100% | 0% | fail: 1 wrong answer(s); direct answers 0% < 95% |
| historical:rate | 2021 and later | 2 | 2 | 0 | 100% | 0% | fail: 2 wrong answer(s); direct answers 0% < 95% |
| historical:share | 2021 and later | 2 | 1 | 0 | 50% | 0% | fail: 1 wrong answer(s); initial action 50% < 95%; direct answers 0% < 95% |
| nibrs:clarify | relative period | 22 | 6 | 2 | 9% | n/a | fail: 6 wrong answer(s); 2 incomplete clarification(s) or decline(s); initial action 9% < 95% |
| nibrs:count | 2021 and later | 9 | 2 | 0 | 22% | 0% | fail: 2 wrong answer(s); initial action 22% < 95%; direct answers 0% < 95% |
| nibrs:count | relative period | 2 | 1 | 0 | 50% | 0% | fail: 1 wrong answer(s); initial action 50% < 95%; direct answers 0% < 95% |
| nibrs:decline | 2021 and later | 2 | 0 | 1 | 100% | n/a | fail: 1 incomplete clarification(s) or decline(s) |
| nibrs:decline | relative period | 6 | 2 | 2 | 67% | n/a | fail: 2 wrong answer(s); 2 incomplete clarification(s) or decline(s); initial action 67% < 95% |
| nibrs:list | relative period | 1 | 0 | 0 | 0% | 0% | fail: initial action 0% < 95%; direct answers 0% < 95% |
| nibrs:rate | 2021 and later | 2 | 2 | 0 | 100% | 0% | fail: 2 wrong answer(s); direct answers 0% < 95% |
| nibrs:share | 2021 and later | 5 | 2 | 0 | 40% | 0% | fail: 2 wrong answer(s); initial action 40% < 95%; direct answers 0% < 95% |
| rtci:count | 2021 and later | 1 | 0 | 0 | 0% | 0% | fail: initial action 0% < 95%; direct answers 0% < 95% |
| rtci:rate | relative period | 1 | 1 | 0 | 100% | 0% | fail: 1 wrong answer(s); direct answers 0% < 95% |
| shr:count | 2021 and later | 1 | 1 | 0 | 100% | 0% | fail: 1 wrong answer(s); direct answers 0% < 95% |

Numeric fixtures: not measured (no compiler yet; values are pending the canonical build).

### Discrepancies

- **LS-001** (wrong_answer; expected answer, got answer) "give me the share of all rape clearances that were prosecution declined in 2025 by state"
  - material filters: expected `cleared by exceptional mean`, got `clearance`
- **LS-002** (wrong_answer; expected clarify, got answer) "give me the share of all rape clearances that were prosecution declined in 2025"
- **LS-003** (wrong_action; expected clarify, got no_reading) "what crime type and where had the highest share of offenses cleared because of prosecution being declined in 2025?"
  - no typed reading (today's route would hand it to another path)
- **LS-022** (avoidable_decline; expected answer, got no_reading) "Is there national crime data that includes the ZIP code where the crime occurred?"
  - no typed reading (today's route would hand it to another path)
- **LS-025** (wrong_answer; expected decline, got answer) "what is the homicide victimization rate for women by year?"
- **LS-030** (wrong_answer; expected decline, got answer) "See trends for juvenile offenders for violent crimes per 100,000 population over time"
- **LS-032** (incomplete; expected clarify, got clarify) "what share of serious violent crimes in California are committed by youth under 18?"
  - Which part of the total should the share measure? Name it after "were" or "that" (for example "what share of robbery offenders were under 18").
  - options not structured: the label's options cannot be checked
- **LS-036** (wrong_answer; expected answer, got answer) "Aggravated assault rate in White Plains, NY from 2021 to 2025"
  - material source: expected `historical`, got `nibrs`
- **LS-038** (wrong_answer; expected answer, got answer) "what is the nationwide clearance rate for sex crimes in 2025"
  - material measures: expected `sex offenses rape sodomy sexual assault with an object fondling incest statutory rape`, got `sex offense`
  - material filters: expected `cleared by arrest or exceptional mean`, got `clearance`
- **LS-043** (wrong_answer; expected answer, got answer) "Houston vehicle burglaries by year and clearance status, 2018 to 2026"
  - naming period: expected `{"rule":"2018-01 through the latest month in the data (requested end 2026)"}`, got `{"from":"2018-01","to":"2026-10"}`
  - material groupings: expected `clearance statu, year`, got `clearance type, year`
- **LS-060** (wrong_answer; expected answer, got answer) "Homicide rate for top 100 U.S. cities in 2026"
  - material source: expected `rtci`, got `nibrs`
  - material filters: expected `city agencies in the current trends sample`, got ``
  - material cohort: expected `source_sample`, got `all_reporting`
- **LS-062** (wrong_answer; expected answer, got answer) "Top 10 cities of 250,000 people or more by shoplifting rate in 2025"
  - material filters: expected `agencies that reported all 12 months of 2025, population`, got `population`
- **LS-063** (wrong_answer; expected answer, got answer) "which cities in Texas (min 250k) had the highest rate of carjackings in 2025?"
  - material units: expected `offense`, got `incident`
  - material filters: expected `agencies that reported all 12 months of 2025, population`, got `population`
- **LS-065** (avoidable_decline; expected answer, got no_reading) "Which violent crime saw the greatest decrease in Chicago in 2025?"
  - no typed reading (today's route would hand it to another path)
- **LS-075** (wrong_action; expected clarify, got decline) "total crime last 10 years broken down by vilont vs nonvilont"
  - I couldn't interpret "by vilont" in this question, so I haven't answered it with a number that ignores it. I can't apply "vs": comparisons are answered as named places side by side; ask for the places and the years. I ha
- **LS-082** (wrong_answer; expected answer, got answer) "show me murders, robberies, and aggravated assaults for albuquerque police department and bernalillo county sheriff by year for 2020 to 2025"
  - material source: expected `historical`, got `nibrs`
- **LS-083** (wrong_action; expected clarify, got no_reading) "show me violent crimes by offender age for worcester county, md sheriff's office and pocomoke city, md police department"
  - no typed reading (today's route would hand it to another path)
- **LS-086** (wrong_answer; expected answer, got answer) "rape clearance rate nationwide in 2025"
  - material source: expected `historical`, got `nibrs`
  - material filters: expected `cleared by arrest or exceptional mean`, got `clearance`
- **LS-096** (wrong_answer; expected clarify, got answer) "Which state has the highest murder rate?"
- **LS-111** (avoidable_decline; expected answer, got decline) "show me nationwide violent crimes involving use of a gun by offender age by year for consistent reporters for 2018 to 2025"
  - I can't apply "for consistent reporters": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-113** (wrong_action; expected clarify, got no_reading) "How many arrests each year in the united states?"
  - no typed reading (today's route would hand it to another path)
- **LS-114** (wrong_action; expected clarify, got decline) "Compare the rape clearance rate for the San Francisco Police Department against 3 agencies of similar size."
  - I can't apply "3 agencies of similar size": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-121** (incomplete; expected clarify, got clarify) "what share of serious violent crimes in California are committed by youth under 18?"
  - Which part of the total should the share measure? Name it after "were" or "that" (for example "what share of robbery offenders were under 18").
  - options not structured: the label's options cannot be checked
- **LS-124** (avoidable_decline; expected answer, got decline) "Narcotics possession or distribution arrests in tolleson Arizona in 2025"
  - NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution". I haven't answered with a number that leaves it out.
- **LS-125** (wrong_action; expected clarify, got decline) "Compare the rape clearance rate for the Denver Police Department against 3 agencies of similar size."
  - I can't apply "3 agencies of similar size": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-126** (wrong_action; expected clarify, got decline) "show me violent crimes with a firearm by offender age by year for the state of maine"
  - I can't apply "state": I couldn't use it in a supported question type. I haven't answered with a number that leaves it out.
- **LS-128** (avoidable_decline; expected answer, got decline) "Show me the states wit the highest share of rapes that were cleared by exception in 2025 broken down by the type of exceptional clearance"
  - I can't apply "by exception": a ranking of only part of an offense isn't built. I haven't answered with a number that leaves it out.
- **LS-129** (avoidable_decline; expected answer, got decline) "Give me the 2025 murder clearance rate for Chicago Illinois, Los Angeles city California, Austin Texas, Columbus Ohio, Charlotte North Carol"
  - I can't apply "Los Angeles": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-133** (incomplete; expected decline, got decline) "please show the violent crime rate by race"
  - adapter refused: a breakdown of violent_crime by race: a mixed-unit composite has no single counted person
  - no alternative offered; the label expects one
- **LS-135** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 In Tucson az. Please provide total"
  - I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted
- **LS-137** (avoidable_decline; expected answer, got decline) "dataset of Property Crime Rolling Over 12 Months Jan 2018 - Jun 2026 in texas"
  - I can't apply "2026": one period per answer. I haven't answered with a number that leaves it out.
- **LS-138** (avoidable_decline; expected answer, got decline) "show me violent crime in maryland by arrestee age by month for 2022 to 2026"
  - I couldn't interpret "age" in this question, so I haven't answered it with a number that ignores it.
- **LS-140** (wrong_action; expected clarify, got decline) "St Louis carjackings per month"
  - I can't apply "St Louis": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-142** (incomplete; expected decline, got decline) "show the shoplifting rate since 2010 by race of offender"
  - plan refused: A1
  - no alternative offered; the label expects one
- **LS-143** (wrong_answer; expected answer, got answer) "Virginia murder clearances by Exception in 2025 by type"
  - material filters: expected `cleared by exceptional mean`, got `clearance`
  - material groupings: expected `exceptional clearance type`, got `clearance type`
- **LS-146** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Yuma Az"
  - I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted
- **LS-148** (avoidable_decline; expected answer, got decline) "Share of rapes cleared by exception by type and state in 2025"
  - I can't apply "state": I couldn't use it in a supported question type. I haven't answered with a number that leaves it out.
- **LS-149** (avoidable_decline; expected answer, got decline) "homicides in fairfax county viriginia in 2025"
  - I couldn't interpret "viriginia" in this question, so I haven't answered it with a number that ignores it.
- **LS-150** (wrong_action; expected clarify, got decline) "houston vehicle burglaries by month by clearance status"
  - I can't apply "by month": breakdowns come from yearly tables; monthly or rolling breakdowns aren't available. I haven't answered with a number that leaves it out.
- **LS-151** (avoidable_decline; expected answer, got decline) "Shoplfting in baltimore per month, 2021-2025"
  - I can't apply "baltimore": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-152** (wrong_action; expected clarify, got no_reading) "Give me the number of clearances broken down by type for these cities in 2025: Chicago, IL New York, NY Houston, TX Los Angeles, CA Philadel"
  - no typed reading (today's route would hand it to another path)
- **LS-153** (wrong_answer; expected clarify, got answer) "2025 burglaries by location"
- **LS-154** (wrong_action; expected clarify, got decline) "What is the auto theft clearance rate in Omaha by year?"
  - adapter refused: a place did not resolve
- **LS-155** (wrong_action; expected clarify, got decline) "show me violent crime involving use of a firearm by offender race by year for 2017 to 2025 for consistent reporters"
  - I can't apply "for consistent reporters": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-156** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Avondale Az"
  - I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted
- **LS-163** (wrong_answer; expected answer, got answer) "How many robberies were there in the US in 2015?"
  - material source: expected `historical`, got `nibrs`
- **LS-164** (wrong_answer; expected answer, got answer) "Total rapes reported in California in 2018"
  - material source: expected `historical`, got `nibrs`
- **LS-165** (wrong_answer; expected answer, got answer) "How did aggravated assaults change in Texas from 2018 to 2024?"
  - material source: expected `historical`, got `nibrs`
  - material groupings: expected `year`, got ``
- **LS-166** (wrong_answer; expected answer, got answer) "Burglaries per year in Florida from 2019 to 2024"
  - material source: expected `historical`, got `nibrs`
- **LS-168** (wrong_answer; expected answer, got answer) "Which cities had the most motor vehicle thefts in 2023?"
  - material source: expected `historical`, got `nibrs`
  - material filters: expected `agencies that reported all 12 month`, got ``
- **LS-170** (wrong_answer; expected clarify, got answer) "Murders in Houston"
- **LS-171** (wrong_answer; expected clarify, got answer) "Murders in Houston over time"
- **LS-174** (wrong_answer; expected answer, got answer) "Burglaries in Texas last year"
  - material source: expected `historical`, got `nibrs`
- **LS-176** (avoidable_decline; expected answer, got no_reading) "How many assaults were there in Phoenix in 2024?"
  - no typed reading (today's route would hand it to another path)
- **LS-179** (wrong_answer; expected answer, got answer) "How many homicides were there in Memphis in 2023?"
  - material source: expected `historical`, got `nibrs`
- **LS-180** (wrong_answer; expected answer, got answer) "How many theft victims were there in Ohio in 2024?"
  - material source: expected `historical`, got `nibrs`
  - material measures: expected `larceny theft`, got `theft`
  - material units: expected `offense`, got `victim`
- **LS-181** (wrong_answer; expected answer, got answer) "How many thefts were there in Ohio in 2024?"
  - material source: expected `historical`, got `nibrs`
  - material measures: expected `larceny theft`, got `theft`
- **LS-182** (wrong_answer; expected clarify, got answer) "How many murders were there in 2024?"
- **LS-185** (avoidable_decline; expected answer, got decline) "Murders in Chicago from 1990 to 2024"
  - plan refused: S7, S7
- **LS-186** (wrong_answer; expected answer, got answer) "What was the robbery rate in Georgia in 2024?"
  - material source: expected `historical`, got `nibrs`
- **LS-196** (wrong_action; expected clarify, got no_reading) "Crime in Denver in 2024"
  - no typed reading (today's route would hand it to another path)
- **LS-201** (incomplete; expected decline, got decline) "How many robbery arrests in Georgia in 2024 led to convictions?"
  - I couldn't interpret "led to" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record court outcomes (prosecutions, convictions, sentences or defendants); it records crimes reported
  - no alternative offered; the label expects one
- **LS-204** (wrong_answer; expected answer, got answer) "Drug crimes in Kentucky in 2024"
  - material measures: expected `drug equipment violation + drug narcotic violation`, got `drug narcotic violation`
  - material units: expected `offense + offense`, got `offense`
- **LS-205** (wrong_answer; expected answer, got answer) "Domestic violence murders in Texas in 2023"
  - material source: expected `shr`, got `nibrs`
  - material measures: expected `murder`, got `domestic violence + murder`
  - material units: expected `victim`, got `victim + victim`
  - material filters: expected `relationship`, got ``
- **LS-206** (avoidable_decline; expected answer, got decline) "How many flash mob shoplifting incidents were there in California in 2024?"
  - I couldn't interpret "flash mob" in this question, so I haven't answered it with a number that ignores it.
- **LS-207** (avoidable_decline; expected answer, got no_reading) "What share of Florida's population is covered by NIBRS reporting in 2024?"
  - no typed reading (today's route would hand it to another path)
- **LS-212** (wrong_action; expected clarify, got decline) "Which states saw the biggest increase in murders from 2022 to 2024?"
  - I can't apply "increase": I rank places by a level, not by a change, in this version. I haven't answered with a number that leaves it out.
