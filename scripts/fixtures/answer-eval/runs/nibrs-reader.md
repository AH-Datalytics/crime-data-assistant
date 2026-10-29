# Answer evaluation: nibrs-reader

Labeled set: 218 cases. Release for resolution: 1991-01..2026-10, request date 2026-10-28. Level: question -> reader (values not measured).

## Not scored

- 118: another tab: no adapter for this source yet
- 89: label drafted
- 7: a follow-up: the reader takes one turn
- 3: label unresolved
- 1: a button: the reader returns no structured options

## Scored (reviewed labels, decided policy)

No cases.

## PROVISIONAL: drafted or open-policy labels (never a gate)

89 cases (dev 80, held out 9). Correct 25; wrong answers 17; avoidable declines 38; unnecessary clarifications 2; wrong actions 3; incomplete 4. Severity score 2489 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 27 | 2 | 30 | 8 |
| decline | 5 | 0 | 14 | 0 |
| clarify | 0 | 0 | 2 | 1 |

| Capability | Era | Cases | Wrong | Incomplete | Initial action | Direct answers | Gate |
|---|---|---|---|---|---|---|---|
| historical:count | 2021 and later | 1 | 0 | 0 | 0% | 0% | fail: initial action 0% < 95%; direct answers 0% < 95% |
| nibrs:change | 2021 and later | 2 | 1 | 0 | 50% | 0% | fail: 1 wrong answer(s); initial action 50% < 95%; direct answers 0% < 95% |
| nibrs:change | relative period | 2 | 0 | 0 | 0% | 0% | fail: initial action 0% < 95%; direct answers 0% < 95% |
| nibrs:clarify | relative period | 3 | 0 | 0 | 0% | n/a | fail: initial action 0% < 95% |
| nibrs:count | 2021 and later | 25 | 4 | 0 | 36% | 20% | fail: 4 wrong answer(s); initial action 36% < 95%; direct answers 20% < 95% |
| nibrs:count | relative period | 13 | 3 | 0 | 31% | 8% | fail: 3 wrong answer(s); initial action 31% < 95%; direct answers 8% < 95% |
| nibrs:decline | 2021 and later | 3 | 1 | 1 | 67% | n/a | fail: 1 wrong answer(s); 1 incomplete clarification(s) or decline(s); initial action 67% < 95% |
| nibrs:decline | before 2021 | 2 | 2 | 0 | 0% | n/a | fail: 2 wrong answer(s); initial action 0% < 95% |
| nibrs:decline | relative period | 14 | 2 | 3 | 86% | n/a | fail: 2 wrong answer(s); 3 incomplete clarification(s) or decline(s); initial action 86% < 95% |
| nibrs:rank | 2021 and later | 1 | 1 | 0 | 100% | 0% | fail: 1 wrong answer(s); direct answers 0% < 95% |
| nibrs:rate | 2021 and later | 5 | 2 | 0 | 100% | 60% | fail: 2 wrong answer(s); direct answers 60% < 95% |
| nibrs:rate | relative period | 5 | 0 | 0 | 80% | 80% | fail: initial action 80% < 95%; direct answers 80% < 95% |
| nibrs:share | 2021 and later | 8 | 1 | 0 | 38% | 25% | fail: 1 wrong answer(s); initial action 38% < 95%; direct answers 25% < 95% |
| nibrs:share | relative period | 5 | 0 | 0 | 0% | 0% | fail: initial action 0% < 95%; direct answers 0% < 95% |

Numeric fixtures: not measured (no compiler yet; values are pending the canonical build).

### Discrepancies

- **LS-003** (avoidable_decline; expected answer, got no_reading) "what crime type and where had the highest share of offenses cleared because of prosecution being declined in 2025?"
  - no typed reading (today's route would hand it to another path)
- **LS-024** (incomplete; expected decline, got decline) "Women's robbery victimization rate in Chicago"
  - I couldn't interpret "'s" in this question, so I haven't answered it with a number that ignores it.
  - no alternative offered; the label expects one
- **LS-025** (wrong_answer; expected decline, got answer) "what is the homicide victimization rate for women by year?"
- **LS-030** (wrong_answer; expected decline, got answer) "See trends for juvenile offenders for violent crimes per 100,000 population over time"
- **LS-032** (unnecessary_clarify; expected answer, got clarify) "what share of serious violent crimes in California are committed by youth under 18?"
  - Which part of the total should the share measure? Name it after "were" or "that" (for example "what share of robbery offenders were under 18").
- **LS-038** (wrong_answer; expected answer, got answer) "what is the nationwide clearance rate for sex crimes in 2025"
  - material filters: expected ``, got `clearance`
- **LS-043** (wrong_answer; expected answer, got answer) "Houston vehicle burglaries by year and clearance status, 2018 to 2026"
  - naming period: expected `{"rule":"2018-01 through the latest month in the data (requested end 2026)"}`, got `{"from":"2018-01","to":"2026-10"}`
  - material groupings: expected `clearance statu, year`, got `clearance type, year`
- **LS-063** (wrong_answer; expected answer, got answer) "which cities in Texas (min 250k) had the highest rate of carjackings in 2025?"
  - material units: expected `offense`, got `incident`
- **LS-065** (avoidable_decline; expected answer, got no_reading) "Which violent crime saw the greatest decrease in Chicago in 2025?"
  - no typed reading (today's route would hand it to another path)
- **LS-075** (avoidable_decline; expected answer, got decline) "total crime last 10 years broken down by vilont vs nonvilont"
  - I couldn't interpret "by vilont" in this question, so I haven't answered it with a number that ignores it. I can't apply "vs": comparisons are answered as named places side by side; ask for the places and the years. I ha
- **LS-083** (avoidable_decline; expected answer, got no_reading) "show me violent crimes by offender age for worcester county, md sheriff's office and pocomoke city, md police department"
  - no typed reading (today's route would hand it to another path)
- **LS-086** (wrong_answer; expected answer, got answer) "rape clearance rate nationwide in 2025"
  - material filters: expected ``, got `clearance`
- **LS-111** (avoidable_decline; expected answer, got decline) "show me nationwide violent crimes involving use of a gun by offender age by year for consistent reporters for 2018 to 2025"
  - I can't apply "for consistent reporters": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-112** (avoidable_decline; expected answer, got decline) "show me gun crimes by offender age by year for 2017 to 2025 for consistent reporters"
  - I can't apply "for consistent reporters": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-113** (avoidable_decline; expected answer, got no_reading) "How many arrests each year in the united states?"
  - no typed reading (today's route would hand it to another path)
- **LS-114** (avoidable_decline; expected answer, got decline) "Compare the rape clearance rate for the San Francisco Police Department against 3 agencies of similar size."
  - I can't apply "3 agencies of similar size": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-121** (unnecessary_clarify; expected answer, got clarify) "what share of serious violent crimes in California are committed by youth under 18?"
  - Which part of the total should the share measure? Name it after "were" or "that" (for example "what share of robbery offenders were under 18").
- **LS-122** (avoidable_decline; expected answer, got decline) "show nationwide homicides by offender age for consistent reporters by year for 2021 to 2025"
  - I can't apply "for consistent reporters": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-124** (avoidable_decline; expected answer, got decline) "Narcotics possession or distribution arrests in tolleson Arizona in 2025"
  - NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution". I haven't answered with a number that leaves it out.
- **LS-125** (avoidable_decline; expected answer, got decline) "Compare the rape clearance rate for the Denver Police Department against 3 agencies of similar size."
  - I can't apply "3 agencies of similar size": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-126** (avoidable_decline; expected answer, got decline) "show me violent crimes with a firearm by offender age by year for the state of maine"
  - I can't apply "state": I couldn't use it in a supported question type. I haven't answered with a number that leaves it out.
- **LS-127** (avoidable_decline; expected answer, got decline) "number of school aggravated assaults with a firearm"
  - I couldn't interpret "school" in this question, so I haven't answered it with a number that ignores it.
- **LS-128** (avoidable_decline; expected answer, got decline) "Show me the states wit the highest share of rapes that were cleared by exception in 2025 broken down by the type of exceptional clearance"
  - I can't apply "by exception": a ranking of only part of an offense isn't built. I haven't answered with a number that leaves it out.
- **LS-129** (avoidable_decline; expected answer, got decline) "Give me the 2025 murder clearance rate for Chicago Illinois, Los Angeles city California, Austin Texas, Columbus Ohio, Charlotte North Carol"
  - I can't apply "Los Angeles": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-130** (avoidable_decline; expected answer, got no_reading) "what was the population of NIBRS participating agencies per year?"
  - no typed reading (today's route would hand it to another path)
- **LS-131** (avoidable_decline; expected answer, got decline) "Minnesota clearance rate for murders of black victims and white victims"
  - plan refused: A4, A4
- **LS-132** (wrong_answer; expected answer, got answer) "show be violent crime victims by race"
  - material units: expected `fbi standard`, got `victim`
- **LS-133** (incomplete; expected decline, got decline) "please show the violent crime rate by race"
  - adapter refused: a breakdown of violent_crime by race: a mixed-unit composite has no single counted person
  - no alternative offered; the label expects one
- **LS-134** (avoidable_decline; expected answer, got decline) "show me violent crimes by state by year for 2019 to 2025 for consistent reporters"
  - I can't apply "for consistent reporters": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-135** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 In Tucson az. Please provide total"
  - I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted
- **LS-137** (avoidable_decline; expected answer, got decline) "dataset of Property Crime Rolling Over 12 Months Jan 2018 - Jun 2026 in texas"
  - I can't apply "2026": one period per answer. I haven't answered with a number that leaves it out.
- **LS-138** (avoidable_decline; expected answer, got decline) "show me violent crime in maryland by arrestee age by month for 2022 to 2026"
  - I couldn't interpret "age" in this question, so I haven't answered it with a number that ignores it.
- **LS-139** (avoidable_decline; expected answer, got decline) "generate graphs of crime rates for homicide, robbery, property crime, motor vehicle theft, and violent crime, for every state, with Californ"
  - I can't apply "decline": I compare one measure for one place between two named years (for example "from 2023 to 2025"). I haven't answered with a number that leaves it out.
- **LS-140** (avoidable_decline; expected answer, got decline) "St Louis carjackings per month"
  - I can't apply "St Louis": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-142** (incomplete; expected decline, got decline) "show the shoplifting rate since 2010 by race of offender"
  - plan refused: A1
  - no alternative offered; the label expects one
- **LS-143** (wrong_answer; expected answer, got answer) "Virginia murder clearances by Exception in 2025 by type"
  - material groupings: expected `exceptional clearance type`, got `clearance type`
- **LS-144** (wrong_action; expected clarify, got decline) "montgomery county maryland all crime"
  - adapter refused: a place did not resolve
- **LS-145** (avoidable_decline; expected answer, got decline) "show me gun crimes by offender age by year for 2017 to 2025 for consistent reporters"
  - I can't apply "for consistent reporters": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-146** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Yuma Az"
  - I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted
- **LS-148** (avoidable_decline; expected answer, got decline) "Share of rapes cleared by exception by type and state in 2025"
  - I can't apply "state": I couldn't use it in a supported question type. I haven't answered with a number that leaves it out.
- **LS-149** (avoidable_decline; expected answer, got decline) "homicides in fairfax county viriginia in 2025"
  - I couldn't interpret "viriginia" in this question, so I haven't answered it with a number that ignores it.
- **LS-150** (avoidable_decline; expected answer, got decline) "houston vehicle burglaries by month by clearance status"
  - I can't apply "by month": breakdowns come from yearly tables; monthly or rolling breakdowns aren't available. I haven't answered with a number that leaves it out.
- **LS-151** (avoidable_decline; expected answer, got decline) "Shoplfting in baltimore per month, 2021-2025"
  - I can't apply "baltimore": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-152** (avoidable_decline; expected answer, got no_reading) "Give me the number of clearances broken down by type for these cities in 2025: Chicago, IL New York, NY Houston, TX Los Angeles, CA Philadel"
  - no typed reading (today's route would hand it to another path)
- **LS-154** (avoidable_decline; expected answer, got decline) "What is the auto theft clearance rate in Omaha by year?"
  - adapter refused: a place did not resolve
- **LS-155** (avoidable_decline; expected answer, got decline) "show me violent crime involving use of a firearm by offender race by year for 2017 to 2025 for consistent reporters"
  - I can't apply "for consistent reporters": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-156** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Avondale Az"
  - I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted
- **LS-163** (wrong_answer; expected decline, got answer) "How many robberies were there in the US in 2015?"
- **LS-164** (wrong_answer; expected decline, got answer) "Total rapes reported in California in 2018"
- **LS-165** (wrong_answer; expected answer, got answer) "How did aggravated assaults change in Texas from 2018 to 2024?"
  - material cohort: expected `same_agencies`, got `all_reporting`
- **LS-166** (wrong_answer; expected answer, got answer) "Burglaries per year in Florida from 2019 to 2024"
  - material cohort: expected `same_agencies`, got `all_reporting`
- **LS-168** (wrong_answer; expected answer, got answer) "Which cities had the most motor vehicle thefts in 2023?"
  - material filters: expected `agencies that reported all 12 month`, got ``
- **LS-171** (wrong_answer; expected answer, got answer) "Murders in Houston over time"
  - material period: expected `2016-01..2025-12`, got `2025-01..2025-12`
- **LS-176** (avoidable_decline; expected answer, got no_reading) "How many assaults were there in Phoenix in 2024?"
  - no typed reading (today's route would hand it to another path)
- **LS-185** (avoidable_decline; expected answer, got decline) "Murders in Chicago from 1990 to 2024"
  - plan refused: S7, S7
- **LS-196** (wrong_action; expected clarify, got no_reading) "Crime in Denver in 2024"
  - no typed reading (today's route would hand it to another path)
- **LS-200** (wrong_answer; expected decline, got answer) "What is the murder rate for Black victims in Chicago in 2024?"
- **LS-201** (incomplete; expected decline, got decline) "How many robbery arrests in Georgia in 2024 led to convictions?"
  - I couldn't interpret "led to" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record court outcomes (prosecutions, convictions, sentences or defendants); it records crimes reported
  - no alternative offered; the label expects one
- **LS-204** (wrong_answer; expected answer, got answer) "Drug crimes in Kentucky in 2024"
  - material measures: expected `drug equipment violation + drug narcotic violation`, got `drug narcotic violation`
  - material units: expected `offense + offense`, got `offense`
- **LS-205** (wrong_answer; expected answer, got answer) "Domestic violence murders in Texas in 2023"
  - material measures: expected `murder`, got `domestic violence + murder`
  - material units: expected `victim`, got `victim + victim`
  - material filters: expected `relationship`, got ``
- **LS-206** (avoidable_decline; expected answer, got decline) "How many flash mob shoplifting incidents were there in California in 2024?"
  - I couldn't interpret "flash mob" in this question, so I haven't answered it with a number that ignores it.
- **LS-207** (avoidable_decline; expected answer, got no_reading) "What share of Florida's population is covered by NIBRS reporting in 2024?"
  - no typed reading (today's route would hand it to another path)
- **LS-208** (wrong_action; expected clarify, got decline) "What was the value of stolen property in New York in 2021?"
  - I can't apply "New York": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-212** (avoidable_decline; expected answer, got decline) "Which states saw the biggest increase in murders from 2022 to 2024?"
  - I can't apply "increase": I rank places by a level, not by a change, in this version. I haven't answered with a number that leaves it out.
