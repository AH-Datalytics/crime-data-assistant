# Answer evaluation: nibrs-reader

Labeled set: 283 cases. Release for resolution: 1991-01..2026-10, request date 2026-10-28.

**Level: question -> reader only.** An "answer" is a plan-level semantic assessment. Not measured: compiled results and numeric values (no compiler yet), routing between sources, the delivered answer and its statements, follow-ups and button continuations, the truthfulness of decline reasons (not judged), clarification options (the reader returns text).

## Execution coverage (can this candidate take the case)

- 157: run by this candidate
- 118: another source: no adapter for it yet
- 7: a follow-up: the reader takes one turn
- 1: a button continuation: the reader returns no structured options

## Label eligibility (can the case be scored)

- 229: scorable (reviewed, decided policy)
- 54: label unresolved

## Scored (reviewed labels, decided policy)

### Development

83 cases. Correct 4; unverified 8; wrong answers 28; avoidable declines 17; unnecessary clarifications 0; wrong actions 17; incomplete 9. Severity score 3234 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| answer | 24 | 0 | 13 | 4 |
| clarify | 10 | 0 | 12 | 5 |
| decline | 2 | 0 | 9 | 4 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:historical change | period not mapped | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:historical change | spans 2021 | 1 | fail | wrong answers: fail (1); initial action: pass (100% (1/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:historical count | 2021 and later | 4 | fail | wrong answers: fail (2); initial action: fail (50% (2/4)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:historical count | before 2021 | 2 | fail | wrong answers: fail (2); initial action: pass (100% (2/2)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:historical count | spans 2021 | 2 | fail | wrong answers: fail (2); initial action: pass (100% (2/2)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:historical rank | 2021 and later | 1 | fail | wrong answers: fail (1); initial action: pass (100% (1/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:historical rate | 2021 and later | 2 | fail | wrong answers: fail (2); initial action: pass (100% (2/2)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:historical share | 2021 and later | 2 | fail | wrong answers: fail (1); initial action: fail (50% (1/2)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs count | 2021 and later | 17 | fail | wrong answers: fail (4); initial action: fail (47% (8/17)); direct answers: fail (24% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs count | period not mapped | 1 | not measured | wrong answers: not measured (0, 1 answers unverified); initial action: pass (100% (1/1)); direct answers: not measured (0% verified, 1 unverified); numeric fixtures: not measured (no delivered values) |
| answer:nibrs count | spans 2021 | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs list | period not mapped | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs rate | 2021 and later | 2 | fail | wrong answers: fail (1, 1 answers unverified); initial action: pass (100% (2/2)); direct answers: fail (0% (1 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs share | 2021 and later | 3 | fail | wrong answers: not measured (0, 2 answers unverified); initial action: fail (67% (2/3)); direct answers: fail (0% (2 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:rtci count | spans 2021 | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| clarify:historical change | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:historical count | 2021 and later | 4 | fail | wrong answers: fail (2); clarifications: fail (0/4 verified correct, 4 failing); initial action: fail (0% (0/4)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:historical count | spans 2021 | 1 | fail | wrong answers: fail (1); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:historical rate | 2021 and later | 1 | fail | wrong answers: fail (1); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:historical share | spans 2021 | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 9 | fail | wrong answers: fail (3); clarifications: fail (0/9 verified correct, 9 failing); initial action: fail (0% (0/9)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | spans 2021 | 6 | fail | wrong answers: fail (1); clarifications: fail (0/6 verified correct, 6 failing); initial action: fail (0% (0/6)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs share | 2021 and later | 2 | fail | wrong answers: fail (1); clarifications: fail (0/2 verified correct, 2 failing); initial action: fail (0% (0/2)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:no meaning | no period | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:rtci rate | 2021 and later | 1 | fail | wrong answers: fail (1); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | 2021 and later | 3 | fail | wrong answers: pass (0); declines: fail (0/3 verified correct, 3 failing); initial action: pass (100% (3/3)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | spans 2021 | 2 | fail | wrong answers: fail (1); declines: fail (0/2 verified correct, 2 failing); initial action: fail (50% (1/2)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs share | 2021 and later | 1 | fail | wrong answers: pass (0); declines: fail (0/1 verified correct, 1 failing); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 8 | fail | wrong answers: pass (0); declines: fail (0/8 verified correct, 4 unverified, 4 failing); initial action: fail (50% (4/8)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:shr count | spans 2021 | 1 | fail | wrong answers: fail (1); declines: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-001** (unverified; expected answer, got answer) "give me the share of all rape clearances that were prosecution declined in 2025 by state"
  - unverified share roles: expected `all cleared rape offenses (by arrest or exceptional means), same state and year`, got `denominator:offenses.rape_cleared, numerator:offenses.rape_cleared`
  - unverified filters: expected `?`, got `clearance:cleared + clearance:cleared + clearance:prosecution declined`
  - unverified statistic: expected `share`, got `ratio`
- **LS-002** (wrong_answer; expected clarify, got answer) "give me the share of all rape clearances that were prosecution declined in 2025"
- **LS-003** (wrong_action; expected clarify, got no_reading) "what crime type and where had the highest share of offenses cleared because of prosecution being declined in 2025?"
  - no typed reading: no answer, no reason
- **LS-005** (incomplete; expected decline, got no_reading) "Can you provide the number or percentage of gun prosecutions per year over the last 20 years?"
  - no typed reading: no answer, no reason
- **LS-009** (incomplete; expected decline, got no_reading) "Can you provide one bar per city with the race of defendants reflected in each bar?"
  - no typed reading: no answer, no reason
- **LS-020** (incomplete; expected decline, got no_reading) "Show me crimes in zip code 07040 from 1991 to the present"
  - no typed reading: no answer, no reason
- **LS-022** (avoidable_decline; expected answer, got no_reading) "Is there national crime data that includes the ZIP code where the crime occurred?"
  - no typed reading: no answer, no reason
- **LS-025** (wrong_answer; expected decline, got answer) "what is the homicide victimization rate for women by year?"
- **LS-030** (wrong_answer; expected decline, got answer) "See trends for juvenile offenders for violent crimes per 100,000 population over time"
- **LS-036** (wrong_answer; expected answer, got answer) "Aggravated assault rate in White Plains, NY from 2021 to 2025"
  - material source: expected `historical`, got `nibrs`
  - unverified denominator: expected `residents of the White Plains Police Department's jurisdiction, per 100,000`, got `(not represented in the plan's meaning)`
- **LS-038** (unverified; expected answer, got answer) "what is the nationwide clearance rate for sex crimes in 2025"
  - unverified measures: expected `?`, got `sex offense|offense`
  - unverified share roles: expected `all reported sex offenses of the same six types, same agencies and year`, got `denominator:offenses.sex_offense, numerator:offenses.sex_offense_cleared`
  - unverified filters: expected `?`, got `clearance:cleared`
  - unverified statistic: expected `share`, got `ratio`
- **LS-043** (unverified; expected answer, got answer) "Houston vehicle burglaries by year and clearance status, 2018 to 2026"
  - unverified period: expected `{"rule":"2018-01 through the latest month in the data (requested end 2026)"}`, got `2018-01..2026-10`
  - unverified groupings: expected `? + year`, got `clearance type + year`
- **LS-060** (wrong_answer; expected clarify, got answer) "Homicide rate for top 100 U.S. cities in 2026"
- **LS-062** (unverified; expected answer, got answer) "Top 10 cities of 250,000 people or more by shoplifting rate in 2025"
  - unverified filters: expected `? + ?`, got `? + population:250000+`
  - unverified rank by: expected `shoplifting rate`, got `(the ranked statistic is not mapped)`
  - unverified denominator: expected `agency resident population, per 100,000`, got `(not represented in the plan's meaning)`
- **LS-063** (wrong_answer; expected answer, got answer) "which cities in Texas (min 250k) had the highest rate of carjackings in 2025?"
  - material measures: expected `carjacking|offense`, got `carjacking|incident`
  - unverified filters: expected `? + ?`, got `? + population:250000+`
  - material rank limit: expected `20`, got `null`
  - unverified rank by: expected `carjacking rate`, got `(the ranked statistic is not mapped)`
  - unverified denominator: expected `agency resident population, per 100,000`, got `(not represented in the plan's meaning)`
- **LS-065** (avoidable_decline; expected answer, got no_reading) "Which violent crime saw the greatest decrease in Chicago in 2025?"
  - no typed reading: no answer, no reason
- **LS-075** (wrong_action; expected clarify, got decline) "total crime last 10 years broken down by vilont vs nonvilont"
  - declined (reason not judged): I couldn't interpret "by vilont" in this question, so I haven't answered it with a number that ignores it. I can't apply "vs": comparisons are answered as named places side by side; ask for 
- **LS-082** (wrong_answer; expected answer, got answer) "show me murders, robberies, and aggravated assaults for albuquerque police department and bernalillo county sheriff by year for 2020 to 2025"
  - material source: expected `historical`, got `nibrs`
  - unverified places: expected `local:NM:albuquerque + local:NM:bernalillo county`, got `local:NM:albuquerque + local:NM:bernalillo`
- **LS-086** (wrong_answer; expected answer, got answer) "rape clearance rate nationwide in 2025"
  - material source: expected `historical`, got `nibrs`
  - unverified share roles: expected `all reported rapes, United States, 2025`, got `denominator:offenses.rape, numerator:offenses.rape_cleared`
  - unverified filters: expected `?`, got `clearance:cleared`
  - unverified statistic: expected `share`, got `ratio`
- **LS-096** (wrong_answer; expected clarify, got answer) "Which state has the highest murder rate?"
- **LS-111** (avoidable_decline; expected answer, got decline) "show me nationwide violent crimes involving use of a gun by offender age by year for consistent reporters for 2018 to 2025"
  - declined (reason not judged): I can't apply "for consistent reporters": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-113** (wrong_action; expected clarify, got no_reading) "How many arrests each year in the united states?"
  - no typed reading: no answer, no reason
- **LS-124** (avoidable_decline; expected answer, got decline) "Narcotics possession or distribution arrests in tolleson Arizona in 2025"
  - declined (reason not judged): NIBRS doesn't record drug distribution or sales as its own measure (drug possession and drug offenses are counted), so I can't apply "or distribution". I haven't answered with a number that 
- **LS-126** (wrong_action; expected clarify, got decline) "show me violent crimes with a firearm by offender age by year for the state of maine"
  - declined (reason not judged): I can't apply "state": I couldn't use it in a supported question type. I haven't answered with a number that leaves it out.
- **LS-128** (unverified; expected decline, got decline) "Show me the states wit the highest share of rapes that were cleared by exception in 2025 broken down by the type of exceptional clearance"
  - declined (reason not judged): I can't apply "by exception": a ranking of only part of an offense isn't built. I haven't answered with a number that leaves it out.
- **LS-129** (avoidable_decline; expected answer, got decline) "Give me the 2025 murder clearance rate for Chicago Illinois, Los Angeles city California, Austin Texas, Columbus Ohio, Charlotte North Carol"
  - declined (reason not judged): I can't apply "Los Angeles": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-131** (unverified; expected decline, got decline) "Minnesota clearance rate for murders of black victims and white victims"
  - plan refused (reason not judged): A4, A4
- **LS-133** (incomplete; expected decline, got decline) "please show the violent crime rate by race"
  - adapter refused (reason not judged): a breakdown of violent_crime by race: a mixed-unit composite has no single counted person
  - no alternative offered; the label expects one
- **LS-135** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 In Tucson az. Please provide total"
  - declined (reason not judged): I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession
- **LS-137** (avoidable_decline; expected answer, got decline) "dataset of Property Crime Rolling Over 12 Months Jan 2018 - Jun 2026 in texas"
  - declined (reason not judged): I can't apply "2026": one period per answer. I haven't answered with a number that leaves it out.
- **LS-140** (wrong_action; expected clarify, got decline) "St Louis carjackings per month"
  - declined (reason not judged): I can't apply "St Louis": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-141** (incomplete; expected decline, got no_reading) "crime by ZIP code in Chicago"
  - no typed reading: no answer, no reason
- **LS-143** (wrong_answer; expected answer, got answer) "Virginia murder clearances by Exception in 2025 by type"
  - material measures: expected `murder|victim`, got `murder|offense`
  - unverified filters: expected `?`, got `clearance:exceptional`
  - unverified groupings: expected `?`, got `clearance type`
- **LS-146** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Yuma Az"
  - declined (reason not judged): I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession
- **LS-148** (unverified; expected decline, got decline) "Share of rapes cleared by exception by type and state in 2025"
  - declined (reason not judged): I can't apply "state": I couldn't use it in a supported question type. I haven't answered with a number that leaves it out.
- **LS-149** (avoidable_decline; expected answer, got decline) "homicides in fairfax county viriginia in 2025"
  - declined (reason not judged): I couldn't interpret "viriginia" in this question, so I haven't answered it with a number that ignores it.
- **LS-150** (wrong_action; expected clarify, got decline) "houston vehicle burglaries by month by clearance status"
  - declined (reason not judged): I can't apply "by month": breakdowns come from yearly tables; monthly or rolling breakdowns aren't available. I haven't answered with a number that leaves it out.
- **LS-151** (wrong_action; expected clarify, got decline) "Shoplfting in baltimore per month, 2021-2025"
  - declined (reason not judged): I can't apply "baltimore": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-152** (wrong_action; expected clarify, got no_reading) "Give me the number of clearances broken down by type for these cities in 2025: Chicago, IL New York, NY Houston, TX Los Angeles, CA Philadel"
  - no typed reading: no answer, no reason
- **LS-153** (wrong_answer; expected clarify, got answer) "2025 burglaries by location"
- **LS-154** (wrong_action; expected clarify, got decline) "What is the auto theft clearance rate in Omaha by year?"
  - adapter refused (reason not judged): a place did not resolve
- **LS-155** (wrong_action; expected clarify, got decline) "show me violent crime involving use of a firearm by offender race by year for 2017 to 2025 for consistent reporters"
  - declined (reason not judged): I can't apply "for consistent reporters": that is answered only by its own fixed path, which couldn't answer this request. I haven't answered with a number that leaves it out.
- **LS-163** (wrong_answer; expected answer, got answer) "How many robberies were there in the US in 2015?"
  - material source: expected `historical`, got `nibrs`
- **LS-164** (wrong_answer; expected answer, got answer) "Total rapes reported in California in 2018"
  - material source: expected `historical`, got `nibrs`
- **LS-165** (wrong_answer; expected answer, got answer) "How did aggravated assaults change in Texas from 2018 to 2024?"
  - material source: expected `historical`, got `nibrs`
  - material groupings: expected `year`, got ``
  - unverified untracked: expected `(not in the label schema)`, got `comparison 2018-01..2018-12 vs 2024-01..2024-12`
- **LS-166** (wrong_answer; expected answer, got answer) "Burglaries per year in Florida from 2019 to 2024"
  - material source: expected `historical`, got `nibrs`
- **LS-168** (wrong_answer; expected answer, got answer) "Which cities had the most motor vehicle thefts in 2023?"
  - material source: expected `historical`, got `nibrs`
  - unverified filters: expected `?`, got `?`
  - material rank limit: expected `20`, got `null`
  - unverified rank by: expected `motor vehicle theft count`, got `(the ranked statistic is not mapped)`
- **LS-170** (wrong_answer; expected clarify, got answer) "Murders in Houston"
- **LS-171** (wrong_answer; expected clarify, got answer) "Murders in Houston over time"
- **LS-174** (wrong_answer; expected answer, got answer) "Burglaries in Texas last year"
  - material source: expected `historical`, got `nibrs`
- **LS-176** (avoidable_decline; expected answer, got no_reading) "How many assaults were there in Phoenix in 2024?"
  - no typed reading: no answer, no reason
- **LS-181** (wrong_answer; expected answer, got answer) "How many thefts were there in Ohio in 2024?"
  - material source: expected `historical`, got `nibrs`
- **LS-182** (wrong_answer; expected clarify, got answer) "How many murders were there in 2024?"
- **LS-186** (wrong_answer; expected answer, got answer) "What was the robbery rate in Georgia in 2024?"
  - material source: expected `historical`, got `nibrs`
  - unverified denominator: expected `state population, per 100,000`, got `(not represented in the plan's meaning)`
- **LS-196** (wrong_action; expected clarify, got no_reading) "Crime in Denver in 2024"
  - no typed reading: no answer, no reason
- **LS-201** (incomplete; expected decline, got decline) "How many robbery arrests in Georgia in 2024 led to convictions?"
  - declined (reason not judged): I couldn't interpret "led to" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record court outcomes (prosecutions, convictions, sentences or defendant
  - no alternative offered; the label expects one
- **LS-204** (wrong_answer; expected answer, got answer) "Drug crimes in Kentucky in 2024"
  - material measures: expected `drug equipment violation|offense + drug narcotic violation|offense`, got `drug narcotic violation|offense`
- **LS-205** (wrong_answer; expected answer, got answer) "Domestic violence murders in Texas in 2023"
  - material measures: expected `murder|victim`, got `domestic violence|victim + murder|victim`
  - unverified filters: expected `?`, got ``
- **LS-206** (avoidable_decline; expected answer, got decline) "How many flash mob shoplifting incidents were there in California in 2024?"
  - declined (reason not judged): I couldn't interpret "flash mob" in this question, so I haven't answered it with a number that ignores it.
- **LS-207** (avoidable_decline; expected answer, got no_reading) "What share of Florida's population is covered by NIBRS reporting in 2024?"
  - no typed reading: no answer, no reason
- **LS-212** (wrong_action; expected clarify, got decline) "Which states saw the biggest increase in murders from 2022 to 2024?"
  - declined (reason not judged): I can't apply "increase": I rank places by a level, not by a change, in this version. I haven't answered with a number that leaves it out.
- **LS-224** (wrong_action; expected clarify, got decline) "Carjackings in St. Louis by year, 2021 to 2025"
  - declined (reason not judged): I can't apply "St. Louis": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-225** (wrong_answer; expected answer, got answer) "carjackings in Memphis TN by month in 2025"
  - material measures: expected `carjacking|offense`, got `carjacking|incident`
- **LS-226** (avoidable_decline; expected answer, got decline) "How many simple assaults were there in Detroit in 2023?"
  - adapter refused (reason not judged): a place did not resolve
- **LS-227** (avoidable_decline; expected answer, got decline) "simple assault victims in Detroit by month in 2023"
  - adapter refused (reason not judged): a place did not resolve
- **LS-228** (avoidable_decline; expected answer, got decline) "Thefts from motor vehicles in Columbus, Ohio in 2022"
  - declined (reason not judged): I couldn't interpret "from motor vehicles in" in this question, so I haven't answered it with a number that ignores it.
- **LS-229** (avoidable_decline; expected answer, got decline) "Drug crimes in Detroit in 2024"
  - adapter refused (reason not judged): a place did not resolve
- **LS-230** (avoidable_decline; expected answer, got decline) "Shoplifting in Memphis so far this year"
  - declined (reason not judged): I couldn't interpret "so far this year" in this question, so I haven't answered it with a number that ignores it.
- **LS-231** (wrong_action; expected clarify, got decline) "Thefts from motor vehicles in Kansas City in 2024"
  - declined (reason not judged): I can't apply "Kansas City": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-232** (wrong_answer; expected clarify, got answer) "How many shoplifting offenses were there in 2024?"
- **LS-233** (wrong_answer; expected clarify, got answer) "Shoplifting in Memphis"
- **LS-234** (wrong_answer; expected clarify, got answer) "Carjackings in Memphis by month"
- **LS-235** (wrong_action; expected clarify, got no_reading) "How many crimes were there in Detroit in 2024?"
  - no typed reading: no answer, no reason
- **LS-236** (incomplete; expected decline, got decline) "Shoplifting in Memphis in 2027"
  - plan refused (reason not judged): S7
  - no alternative offered; the label expects one
- **LS-238** (unverified; expected decline, got decline) "Shoplifting in Memphis by ZIP code in 2024"
  - declined (reason not judged): NIBRS doesn't record anything below the level of an agency (ZIP codes, neighborhoods, districts, wards or beats), so I can't apply "ZIP code". I haven't answered with a number that leaves it
- **LS-239** (incomplete; expected decline, got decline) "How many shoplifting arrests in Memphis in 2024 led to convictions?"
  - declined (reason not judged): I couldn't interpret "led to" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record court outcomes (prosecutions, convictions, sentences or defendant
  - no alternative offered; the label expects one
- **LS-240** (incomplete; expected decline, got decline) "Will carjackings go up in Memphis next year?"
  - declined (reason not judged): I couldn't interpret "Will" in this question, so I haven't answered it with a number that ignores it. I couldn't interpret "go up in" in this question, so I haven't answered it with a number
  - no alternative offered; the label expects one
- **LS-242** (wrong_action; expected clarify, got decline) "Shoplifting in Baltimore in 2024"
  - declined (reason not judged): I can't apply "Baltimore": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-243** (wrong_action; expected clarify, got decline) "Shoplifting in Washington in 2024"
  - declined (reason not judged): I can't apply "Washington": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.

### Held out

50 cases. Correct 5; unverified 0; wrong answers 4; avoidable declines 28; unnecessary clarifications 0; wrong actions 5; incomplete 8. Severity score 993 (trend only).

Expected (rows) by actual (columns):

| | answer | clarify | decline | no reading |
|---|---|---|---|---|
| decline | 0 | 0 | 7 | 1 |
| answer | 9 | 0 | 25 | 3 |
| clarify | 0 | 0 | 3 | 2 |

| Capability | Era | Cases | Gate | Categories |
|---|---|---|---|---|
| answer:historical count | 2021 and later | 3 | fail | wrong answers: fail (3); initial action: pass (100% (3/3)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:historical count | spans 2021 | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs change | 2021 and later | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs count | 2021 and later | 30 | fail | wrong answers: fail (1); initial action: fail (17% (5/30)); direct answers: fail (13% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| answer:nibrs count | before 2021 | 1 | not measured | wrong answers: pass (0); initial action: pass (100% (1/1)); direct answers: pass (100%); numeric fixtures: not measured (no delivered values) |
| answer:nibrs count | period not mapped | 1 | fail | wrong answers: pass (0); initial action: fail (0% (0/1)); direct answers: fail (0% (0 unverified)); numeric fixtures: not measured (no delivered values) |
| clarify:historical count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:nibrs count | 2021 and later | 3 | fail | wrong answers: pass (0); clarifications: fail (0/3 verified correct, 3 failing); initial action: fail (0% (0/3)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| clarify:shr count | 2021 and later | 1 | fail | wrong answers: pass (0); clarifications: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | 2021 and later | 2 | fail | wrong answers: pass (0); declines: fail (0/2 verified correct, 2 failing); initial action: pass (100% (2/2)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | period not mapped | 1 | fail | wrong answers: pass (0); declines: fail (0/1 verified correct, 1 failing); initial action: pass (100% (1/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:nibrs count | spans 2021 | 4 | fail | wrong answers: pass (0); declines: fail (0/4 verified correct, 4 failing); initial action: pass (100% (4/4)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |
| decline:no meaning | no period | 1 | fail | wrong answers: pass (0); declines: fail (0/1 verified correct, 1 failing); initial action: fail (0% (0/1)); direct answers: pass (no answerable cases); numeric fixtures: not measured (no delivered values) |

Discrepancies and unverified cases:

- **LS-012** (incomplete; expected decline, got no_reading) "crime by ZIP code in Chicago"
  - no typed reading: no answer, no reason
- **LS-138** (avoidable_decline; expected answer, got decline) "show me violent crime in maryland by arrestee age by month for 2022 to 2026"
  - declined (reason not judged): I couldn't interpret "age" in this question, so I haven't answered it with a number that ignores it.
- **LS-142** (incomplete; expected decline, got decline) "show the shoplifting rate since 2010 by race of offender"
  - plan refused (reason not judged): A1
  - no alternative offered; the label expects one
- **LS-156** (avoidable_decline; expected answer, got decline) "Posession or distribution of narcotics arrests in 2025 in Avondale Az"
  - declined (reason not judged): I couldn't interpret "Posession" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record drug distribution or sales as its own measure (drug possession
- **LS-179** (wrong_answer; expected answer, got answer) "How many homicides were there in Memphis in 2023?"
  - material source: expected `historical`, got `nibrs`
- **LS-180** (wrong_answer; expected answer, got answer) "How many theft victims were there in Ohio in 2024?"
  - material source: expected `historical`, got `nibrs`
  - material measures: expected `theft|offense`, got `theft|victim`
- **LS-185** (avoidable_decline; expected answer, got decline) "Murders in Chicago from 1990 to 2024"
  - plan refused (reason not judged): S7, S7
- **LS-222** (wrong_answer; expected answer, got answer) "How many shoplifting victims were there in Memphis in 2024?"
  - material measures: expected `shoplifting|offense`, got `shoplifting|victim`
- **LS-223** (wrong_action; expected clarify, got decline) "Shoplifting in Baltimore by month from 2022 to 2025"
  - declined (reason not judged): I can't apply "Baltimore": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-244** (wrong_action; expected clarify, got decline) "Shoplifting in Columbus in 2024"
  - adapter refused (reason not judged): a place did not resolve
- **LS-245** (wrong_action; expected clarify, got decline) "Shoplifting in New York in 2024"
  - declined (reason not judged): I can't apply "New York": I couldn't resolve that place to one NIBRS agency, a state or the nation. I haven't answered with a number that leaves it out.
- **LS-246** (avoidable_decline; expected answer, got no_reading) "Shopliftng in Nashville in 2024"
  - no typed reading: no answer, no reason
- **LS-247** (avoidable_decline; expected answer, got no_reading) "How many simple asaults were there in Denver in 2023?"
  - no typed reading: no answer, no reason
- **LS-248** (avoidable_decline; expected answer, got no_reading) "carjackngs in Atlanta by month in 2024"
  - no typed reading: no answer, no reason
- **LS-249** (avoidable_decline; expected answer, got decline) "Shoplifting in Nashville, Tennesee in 2024"
  - declined (reason not judged): I couldn't interpret "Tennesee" in this question, so I haven't answered it with a number that ignores it.
- **LS-250** (avoidable_decline; expected answer, got decline) "Thefts from cars in Portland, Oregon in 2023"
  - declined (reason not judged): I couldn't interpret "from cars in" in this question, so I haven't answered it with a number that ignores it.
- **LS-251** (avoidable_decline; expected answer, got decline) "How many thefts from automobiles were there in Atlanta in 2023?"
  - declined (reason not judged): I couldn't interpret "from automobiles were there in" in this question, so I haven't answered it with a number that ignores it.
- **LS-252** (avoidable_decline; expected answer, got decline) "Vehicle break-ins in Nashville in 2022"
  - declined (reason not judged): I couldn't interpret "Vehicle" in this question, so I haven't answered it with a number that ignores it.
- **LS-254** (avoidable_decline; expected answer, got decline) "Shoplifting in Denver year to date"
  - declined (reason not judged): I couldn't interpret "year to date" in this question, so I haven't answered it with a number that ignores it.
- **LS-255** (avoidable_decline; expected answer, got decline) "How much shoplifting has Atlanta had this year?"
  - declined (reason not judged): I couldn't interpret "had this year" in this question, so I haven't answered it with a number that ignores it.
- **LS-256** (avoidable_decline; expected answer, got decline) "Carjackings in Nashville so far in 2026"
  - declined (reason not judged): I couldn't interpret "so far" in this question, so I haven't answered it with a number that ignores it.
- **LS-257** (avoidable_decline; expected answer, got decline) "Simple assaults in Portland, Oregon this year so far"
  - declined (reason not judged): I couldn't interpret "this year so far" in this question, so I haven't answered it with a number that ignores it.
- **LS-258** (avoidable_decline; expected answer, got decline) "Monthly simple assault victims in Portland, Oregon for 2022"
  - adapter refused (reason not judged): a place did not resolve
- **LS-259** (avoidable_decline; expected answer, got decline) "carjacking victims in Nashville in 2023"
  - adapter refused (reason not judged): a place did not resolve
- **LS-260** (incomplete; expected decline, got decline) "Will shoplifting rise in Denver next year?"
  - declined (reason not judged): I can't apply "rise": I compare one measure for one place between two named years (for example "from 2023 to 2025"). I haven't answered with a number that leaves it out.
  - no alternative offered; the label expects one
- **LS-261** (incomplete; expected decline, got decline) "Can you forecast carjackings in Atlanta for 2027?"
  - declined (reason not judged): I couldn't interpret "forecast" in this question, so I haven't answered it with a number that ignores it.
  - no alternative offered; the label expects one
- **LS-262** (incomplete; expected decline, got decline) "Predict simple assaults in Portland, Oregon next year"
  - declined (reason not judged): I couldn't interpret "Predict" in this question, so I haven't answered it with a number that ignores it. I couldn't interpret "next year" in this question, so I haven't answered it with a nu
  - no alternative offered; the label expects one
- **LS-263** (incomplete; expected decline, got decline) "What will carjackings be in Nashville in 2027?"
  - declined (reason not judged): I couldn't interpret "will" in this question, so I haven't answered it with a number that ignores it.
  - no alternative offered; the label expects one
- **LS-264** (incomplete; expected decline, got decline) "How many simple assault arrests in Denver in 2023 resulted in a conviction?"
  - declined (reason not judged): I couldn't interpret "resulted in a" in this question, so I haven't answered it with a number that ignores it. NIBRS doesn't record court outcomes (prosecutions, convictions, sentences or de
  - no alternative offered; the label expects one
- **LS-265** (incomplete; expected decline, got decline) "How many shoplifting cases in Nashville went to trial in 2024?"
  - declined (reason not judged): I couldn't interpret "went to trial" in this question, so I haven't answered it with a number that ignores it.
  - no alternative offered; the label expects one
- **LS-266** (wrong_answer; expected answer, got answer) "Motor vehicle thefts in Denver in 2023"
  - material source: expected `historical`, got `nibrs`
- **LS-267** (wrong_action; expected clarify, got no_reading) "Shootings in Nashville in 2024"
  - no typed reading: no answer, no reason
- **LS-268** (avoidable_decline; expected answer, got decline) "Is shoplifting in Denver up this year compared with last year?"
  - declined (reason not judged): I couldn't interpret "up this year" in this question, so I haven't answered it with a number that ignores it. I can't apply "compared with": comparisons are answered as named places side by 
- **LS-269** (avoidable_decline; expected answer, got decline) "How many shoplifting offenses will Denver's 2024 numbers show?"
  - declined (reason not judged): I couldn't interpret "will" in this question, so I haven't answered it with a number that ignores it.
- **LS-270** (wrong_action; expected clarify, got no_reading) "Shplftg in Nashville in 2024"
  - no typed reading: no answer, no reason
- **LS-271** (avoidable_decline; expected answer, got decline) "Simple assault victims in Milwaukee by race in 2024"
  - adapter refused (reason not judged): the place did not resolve
- **LS-273** (avoidable_decline; expected answer, got decline) "Simple assault victims in Louisville by ethnicity, 2024"
  - adapter refused (reason not judged): the place did not resolve
- **LS-274** (avoidable_decline; expected answer, got decline) "Shoplifting in Tucson by location type in 2024"
  - adapter refused (reason not judged): the place did not resolve
- **LS-275** (avoidable_decline; expected answer, got decline) "Theft from motor vehicle offenses in Austin by location in 2023"
  - adapter refused (reason not judged): the place did not resolve
- **LS-276** (avoidable_decline; expected answer, got decline) "Murder victims in Kansas City, Missouri by race in 2023"
  - adapter refused (reason not judged): the place did not resolve
- **LS-278** (avoidable_decline; expected answer, got decline) "How many murder victims in Austin were male or female in 2023?"
  - declined (reason not judged): I couldn't interpret "or" in this question, so I haven't answered it with a number that ignores it.
- **LS-279** (avoidable_decline; expected answer, got decline) "Aggravated assault victims in Albuquerque by race and year, 2021 to 2023"
  - declined (reason not judged): I couldn't interpret "year," in this question, so I haven't answered it with a number that ignores it.
- **LS-280** (avoidable_decline; expected answer, got decline) "Simple assault victims in Milwaukee by age in 2024"
  - adapter refused (reason not judged): the place did not resolve
- **LS-282** (avoidable_decline; expected answer, got decline) "Simple assault victims in Louisville by race and sex in 2024"
  - declined (reason not judged): I can't apply "and sex": I give one breakdown per answer; ask for one breakdown at a time. I haven't answered with a number that leaves it out.
- **LS-283** (avoidable_decline; expected answer, got decline) "Carjackings in Kansas City, Missouri by location type in 2024"
  - adapter refused (reason not judged): the place did not resolve

## PROVISIONAL: drafted labels (never a gate)

### Development

No cases.

### Held out

No cases.
