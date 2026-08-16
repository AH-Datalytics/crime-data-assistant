/**
 * What each capability actually answers, in the words of the person asking.
 *
 * HAND-AUTHORED AND REVIEWED. Everything else the workbook shows is derived from structure, and
 * structure was not enough: three different NIBRS capabilities -- the agency lookup, the state list
 * and the year-coverage check -- all read the `agencies` table, so a description paraphrased from
 * table names called all three "answered from the agencies" and a policy owner could not tell which
 * one they were deciding about. The same went for who keeps the data fresh: every crime_data
 * capability offered all three update processes, so the only way to pick was to open the technical
 * details, which is exactly what this layer exists to avoid.
 *
 * So this file says, per capability: the question it answers, a realistic example of someone asking
 * it, whether a year is a sensible thing to ask it about and WHY in ordinary words, the update
 * processes that could plausibly own it, and the failure scenarios worth asking about for THIS data
 * rather than a generic set. None of it is policy -- it decides nothing, it only makes the question
 * answerable.
 *
 * THE YEAR ADVICE IS ABOUT THE SUBJECT MATTER, NEVER ABOUT WHAT THE DATA HAPPENS TO CARRY. Homicide
 * records are dated, so someone can reasonably ask about one year of them; that stays true even
 * where the answer does not currently read a date. Recommending "no" in that case would let a
 * technical gap masquerade as a human judgment. Working out what to read is an engineering job, and
 * the workbook says so rather than handing it to the person answering.
 *
 * It must cover the registry EXACTLY. Generation fails when a capability is added or removed, so a
 * new capability cannot quietly arrive with no description and inherit a neighbour's.
 *
 * Plain browser-compatible JavaScript: inlined verbatim into the workbook and imported by the
 * regression suite, so the page and the tests read one copy.
 */
function stage2bCapabilityCatalog() {
  /**
   * The update processes a policy owner would recognise. Labels, not filenames: "who should be
   * contacted" is answered by naming a process, and the candidate filenames remain visible as
   * evidence under technical details, where they are what they actually are -- a filename search.
   */
  const PROCESSES = {
    trends: "The monthly crime-trends update",
    historical: "The historical FBI series load",
    population: "The agency population refresh",
    nibrs_rebuild: "The annual NIBRS rebuild",
    nibrs_rollup: "The NIBRS summary and rollup build",
    shr: "The homicide (SHR) import",
    hate_crime: "The hate crime import",
  };

  /**
   * Failure scenarios, phrased as things a person would notice rather than as rules. Each becomes a
   * sentence in the record if chosen; none becomes an executable check, and none is ever ticked for
   * the person.
   */
  const SCENARIOS = {
    stale: {
      label: "It quietly stops being updated, but still looks current",
      prose: "This must not keep serving old figures as though they were current: when the source has newer data, this must have it too.",
    },
    missing_agencies: {
      label: "Agencies or places drop out without anyone noticing",
      prose: "The set of agencies or places covered here must not shrink silently; a smaller answer needs an explanation.",
    },
    double: {
      label: "The same thing gets counted twice",
      prose: "Nothing here may be counted more than once.",
    },
    disagree: {
      label: "Two parts of this disagree when they should match",
      prose: "The parts of this data that overlap must agree with each other.",
    },
    crosswalk: {
      label: "An agency cannot be matched to its county, so places quietly go missing",
      prose: "Every agency here must be matchable to its place; unmatched agencies must not simply vanish from the answer.",
    },
    coverage_gap: {
      label: "A year or a month goes missing in the middle of the range",
      prose: "There must be no unexplained gap in the years or months this covers.",
    },
    population: {
      label: "The population figures behind the rates are out of date",
      prose: "Rates must be worked out from population figures that match the year being reported.",
    },
    clearance: {
      label: "More cases are marked solved than there were cases",
      prose: "Cases marked as cleared must never outnumber the offences they belong to.",
    },
    consistent_set: {
      label: "The set of reporting agencies changes between years, so a trend compares different places",
      prose: "A trend here must compare the same agencies across years, not a changing set of them.",
    },
    categories: {
      label: "Race, age or offence categories change meaning between years",
      prose: "Category codes must mean the same thing across the years being compared.",
    },
    rollup: {
      label: "The national or state totals disagree with the detail they were built from",
      prose: "Totals here must reconcile with the detailed rows they summarise.",
    },
  };

  const CATALOG = {
  "crime_data::agencies+agency_county_crosswalk::agencies(agency,national_sample,ori)|agency_county_crosswalk(county_fips,county_key,ori,ori9,state)": {
    question: "Which recent-trends agencies police a given county — the question behind \"crime in X County\".",
    example: "Which police departments cover Orleans Parish?",
    year: { recommend: "no", why: "This names which departments cover a county. It is a list of places, not a figure that is reported year by year." },
    processes: ["trends"],
    integrity: ["crosswalk","missing_agencies","stale"],
  },
  "crime_data::agencies+agency_monthly+historical_agency+historical_agency_clearance+historical_agency_crime+historical_agency_population::historical_agency(agency,ori,state,type)|historical_agency_clearance(assault_clr,burglary_clr,motor_vehicle_theft_clr,murder_clr,ori,property_clr,rape_clr,robbery_clr,theft_clr,violent_clr,year)|historical_agency_crime(assault,burglary,motor_vehicle_theft,murder,ori,property,rape,robbery,theft,violent,year)|historical_agency_population(ori,population,year)": {
    question: "One agency's whole record in the long FBI series: offences, how many were solved, and the population behind the rates, year by year.",
    example: "Show me New Orleans PD's crime, how much of it was solved, and its population, for every year on record.",
    year: { recommend: "yes", why: "Every figure here belongs to a particular year, so someone can reasonably ask for a year we do not have." },
    processes: ["historical","population"],
    integrity: ["stale","disagree","population","clearance"],
  },
  "crime_data::agencies::agencies(agency,national_sample,ori)": {
    question: "Which agencies are in the recent-trends sample, looked up by name — how \"Chicago\" becomes a specific police department.",
    example: "Is Chicago in the recent crime trends data?",
    year: { recommend: "no", why: "This turns a place name into a specific department. The answer is the same whichever year someone is interested in." },
    processes: ["trends"],
    integrity: ["missing_agencies","stale"],
  },
  "crime_data::agencies::agencies(national_sample,state)": {
    question: "Which states have agencies in the recent-trends sample, and how many.",
    example: "Which states are represented in the recent crime trends data?",
    year: { recommend: "no", why: "This lists which states appear at all. It is a roster, not a yearly statistic." },
    processes: ["trends"],
    integrity: ["missing_agencies","stale"],
  },
  "crime_data::agency_county_crosswalk+historical_agency::agency_county_crosswalk(county_fips,county_key,ori,ori9,state)|historical_agency(agency,ori)": {
    question: "Which agencies in the long FBI series police a given county.",
    example: "Which departments in the long-running FBI series cover Cook County?",
    year: { recommend: "no", why: "This names which departments cover a county. It is a list of places, not a figure reported per year." },
    processes: ["historical"],
    integrity: ["crosswalk","missing_agencies"],
  },
  "crime_data::agency_monthly+agency_population+sample_agencies::agency_monthly(count,offense,ori,year)|agency_population(ori,population,year)|sample_agencies(ori,state)": {
    question: "Recent monthly crime counts and per-population rates across the sample, grouped by state.",
    example: "How have robbery rates changed by state over the last three years?",
    year: { recommend: "yes", why: "These counts and rates are reported month by month within particular years, so a request can fall outside what we hold." },
    processes: ["trends","population"],
    integrity: ["stale","population","coverage_gap"],
  },
  "crime_data::agency_monthly+agency_population::agency_monthly(agency,count,offense,ori,state,type,year)|agency_population(ori,year)": {
    question: "Recent monthly crime counts and rates for one named agency.",
    example: "How many burglaries did Baltimore PD report in 2023?",
    year: { recommend: "yes", why: "This reports figures for a named year, so someone can ask for a year that is not in the data." },
    processes: ["trends","population"],
    integrity: ["stale","population","coverage_gap"],
  },
  "crime_data::agency_monthly::agency_monthly(year)": {
    question: "Which years the recent-trends data actually covers — what to say when someone asks for a year we may not have.",
    example: "What years of recent crime data do you have?",
    year: { recommend: "no", why: "This is itself the answer about which years exist. Asking it about one particular year would go in a circle." },
    processes: ["trends"],
    integrity: ["stale","coverage_gap"],
  },
  "crime_data::historical_agency+historical_agency_clearance+historical_agency_crime+historical_staffing::historical_agency(agency,ori,state,type)|historical_agency_clearance(ori,year)|historical_agency_crime(ori,year)|historical_staffing(ori,year)": {
    question: "Police staffing for an agency alongside its crime and clearance figures, year by year.",
    example: "How many sworn officers did Detroit PD have in 2015, and what was its crime that year?",
    year: { recommend: "yes", why: "Staffing and crime are both reported for a particular year, so a request can fall outside the years we hold." },
    processes: ["historical"],
    integrity: ["stale","disagree","missing_agencies"],
  },
  "crime_data::historical_agency+historical_agency_crime+historical_agency_population::historical_agency(agency,ori,state,type)|historical_agency_crime(murder,ori,year)|historical_agency_population(ori,year)": {
    question: "Murder counts and murder rates for one agency across the long FBI series.",
    example: "What was Philadelphia's murder rate in 1995?",
    year: { recommend: "yes", why: "Murder counts and rates belong to a particular year, so someone can ask for one we do not have." },
    processes: ["historical","population"],
    integrity: ["stale","population","disagree"],
  },
  "crime_data::historical_agency+historical_agency_crime::historical_agency(agency,ori,state,type)|historical_agency_crime(ori,violent,year)": {
    question: "Violent crime for one agency across the long FBI series.",
    example: "What was violent crime in Houston in 1988?",
    year: { recommend: "yes", why: "Violent crime is reported here one year at a time, so a request can fall outside the range we hold." },
    processes: ["historical"],
    integrity: ["stale","disagree"],
  },
  "crime_data::historical_agency::historical_agency(agency,ori)": {
    question: "Which agencies exist in the long FBI series, looked up by name.",
    example: "Is Tulsa PD in the long-running FBI series?",
    year: { recommend: "no", why: "This answer lists which departments exist; it does not provide a yearly statistic." },
    processes: ["historical"],
    integrity: ["missing_agencies","stale"],
  },
  "crime_data::historical_agency_crime+historical_state_national::historical_agency_crime(year)|historical_state_national(year)": {
    question: "Which years the long FBI series covers, for both agency-level and state/national figures.",
    example: "How far back does the FBI series go?",
    year: { recommend: "no", why: "This is itself the answer about which years exist, so it is not asked about one year at a time." },
    processes: ["historical"],
    integrity: ["stale","disagree","coverage_gap"],
  },
  "crime_data::historical_state_national::historical_state_national(aggravated_assault,aggravated_assault_rate,auto_theft,auto_theft_rate,burglary,burglary_rate,murder,murder_rate,population,rape,rape_rate,robbery,robbery_rate,state,theft,theft_rate,year)": {
    question: "State and national crime counts and rates going back decades — the headline long-run series.",
    example: "What was the national murder rate in 1991?",
    year: { recommend: "yes", why: "These are yearly figures, so someone can reasonably ask for a year we do not have." },
    processes: ["historical"],
    integrity: ["stale","population","disagree"],
  },
  "crime_data::historical_state_national::historical_state_national(state)": {
    question: "Which states, plus the national total, exist in the long FBI series.",
    example: "Which states are in the long-running FBI series?",
    year: { recommend: "no", why: "This lists which states appear. It is a roster, not a yearly figure." },
    processes: ["historical"],
    integrity: ["missing_agencies","stale"],
  },
  "crime_data::national_monthly::sweep": {
    question: "National monthly crime totals, used to check the recent-trends sample against the national picture.",
    example: "What were the national monthly crime totals last year?",
    year: { recommend: "yes", why: "These totals are reported month by month within particular years." },
    processes: ["trends"],
    integrity: ["stale","disagree","coverage_gap"],
  },
  "hate_crime::agency_county_crosswalk+hate_crime_incidents::agency_county_crosswalk(county_fips,county_key,ori,ori9,state)|hate_crime_incidents(ori)": {
    question: "Hate crime incidents for a given county.",
    example: "How many hate crimes were reported in Maricopa County in 2022?",
    year: { recommend: "yes", why: "Hate crime incidents happen on a date, so someone can reasonably ask about one year of them." },
    processes: ["hate_crime"],
    integrity: ["crosswalk","missing_agencies","stale"],
  },
  "hate_crime::hate_crime_incidents::hate_crime_incidents(ori)": {
    question: "Which agencies reported hate crime incidents at all.",
    example: "Which departments report hate crimes?",
    year: { recommend: "no", why: "This lists which departments report at all; it is not a yearly count." },
    processes: ["hate_crime"],
    integrity: ["missing_agencies","stale"],
  },
  "hate_crime::hate_crime_participation::hate_crime_participation(reporting_agencies,state)": {
    question: "How many agencies in each state take part in hate crime reporting — the context for \"only N agencies reported\".",
    example: "How many departments in Texas take part in hate crime reporting?",
    year: { recommend: "no", why: "This is the standing count of who takes part, not a figure broken out year by year." },
    processes: ["hate_crime"],
    integrity: ["missing_agencies","stale"],
  },
  "hate_crime::hate_crime_participation::hate_crime_participation(year)": {
    question: "Which years the hate crime participation figures cover.",
    example: "What years of hate crime participation do you have?",
    year: { recommend: "no", why: "This is itself the answer about which years exist." },
    processes: ["hate_crime"],
    integrity: ["stale","coverage_gap"],
  },
  "nibrs::agencies+agency_county_crosswalk+summary_arrestee_demographics::agencies(ori,year)|agency_county_crosswalk(county_key,ori,ori9,state)|summary_arrestee_demographics(arrestee_count,ori,race,ucr_arrest_offense,year)": {
    question: "Arrests by race and offence for the agencies in a given county.",
    example: "How many arrests by race were there in Fulton County in 2022?",
    year: { recommend: "yes", why: "Arrests are counted for a particular year, so a request can fall outside what we hold." },
    processes: ["nibrs_rebuild"],
    integrity: ["crosswalk","categories","missing_agencies"],
  },
  "nibrs::agencies+agency_county_crosswalk+summary_offender_demographics::agencies(ori,year)|agency_county_crosswalk(county_key,ori,ori9,state)|summary_offender_demographics(offender_count,ori,race,ucr_offense_code,year)": {
    question: "Offenders by race and offence for the agencies in a given county.",
    example: "Who were the offenders, by race, in Wayne County in 2021?",
    year: { recommend: "yes", why: "These counts belong to a particular year, so someone can ask for one we do not have." },
    processes: ["nibrs_rebuild"],
    integrity: ["crosswalk","categories","missing_agencies"],
  },
  "nibrs::agencies+agency_county_crosswalk+summary_victim_city_monthly::agencies(ori,year)|agency_county_crosswalk(county_key,ori,ori9,state)|summary_victim_city_monthly(ori,ucr_offense_code,victim_count,year)": {
    question: "Victim counts by offence for the agencies in a given county.",
    example: "How many robbery victims were there in DeKalb County in 2022?",
    year: { recommend: "yes", why: "Victim counts are reported for a particular year, so a request can fall outside the range we hold." },
    processes: ["nibrs_rebuild"],
    integrity: ["crosswalk","missing_agencies","double"],
  },
  "nibrs::agencies+agency_county_crosswalk+summary_victim_demographics::agencies(ori,year)|agency_county_crosswalk(county_key,ori,ori9,state)|summary_victim_demographics(ori,race,ucr_offense_code,victim_count,year)": {
    question: "Victims by race and offence for the agencies in a given county.",
    example: "How many assault victims by race were there in Bexar County in 2020?",
    year: { recommend: "yes", why: "These counts belong to a particular year, so someone can ask for one we do not have." },
    processes: ["nibrs_rebuild"],
    integrity: ["crosswalk","categories","missing_agencies"],
  },
  "nibrs::agencies+agency_county_crosswalk::agencies(ori)|agency_county_crosswalk(county_fips,county_key,ori,ori9,state)": {
    question: "Which NIBRS agencies police a given county.",
    example: "Which departments in Hennepin County report to NIBRS?",
    year: { recommend: "no", why: "This names which departments cover a county. It is a list of places, not a yearly figure." },
    processes: ["nibrs_rebuild"],
    integrity: ["crosswalk","missing_agencies"],
  },
  "nibrs::agencies+nibrs_agency_completeness+summary_city_monthly+summary_victim_city_monthly::agencies(ori,population,year)|nibrs_agency_completeness(months_reported,ori,year)|summary_city_monthly(month,offense_count,ori,ucr_offense_code,year)|summary_victim_city_monthly(ori,ucr_offense_code,victim_count,year)": {
    question: "Offence and victim counts for a city with per-population rates, counting only agencies that reported the whole year.",
    example: "What was Denver's aggravated assault rate in 2022?",
    year: { recommend: "yes", why: "These are yearly figures, and the whole-year reporting rule is itself about one year at a time." },
    processes: ["nibrs_rebuild","nibrs_rollup"],
    integrity: ["consistent_set","population","coverage_gap"],
  },
  "nibrs::agencies+nibrs_agency_completeness+summary_city_monthly+summary_victim_city_monthly::agencies(ori,population,year)|nibrs_agency_completeness(months_reported,ori,year)|summary_city_monthly(month,ori,year)|summary_victim_city_monthly(ori,ucr_offense_code,victim_count,year)": {
    question: "Victim counts for a city with per-population rates, alongside which months each agency actually reported.",
    example: "How many victims did Portland report in 2021, and which months did its departments actually report?",
    year: { recommend: "yes", why: "Both the counts and the months-reported picture belong to a particular year." },
    processes: ["nibrs_rebuild","nibrs_rollup"],
    integrity: ["consistent_set","population","coverage_gap"],
  },
  "nibrs::agencies+nibrs_agency_completeness+summary_city_monthly::nibrs_agency_completeness(months_reported,ori,year)|summary_city_monthly(month,offense_count,ori,ucr_offense_code,year)": {
    question: "Offence counts for a city, counting only agencies that reported all twelve months.",
    example: "How many burglaries were reported in Mesa in 2023?",
    year: { recommend: "yes", why: "These counts are for one year at a time, so a request can fall outside the years we hold." },
    processes: ["nibrs_rebuild","nibrs_rollup"],
    integrity: ["consistent_set","coverage_gap","double"],
  },
  "nibrs::agencies+summary_clearance_type::agencies(agency_type,city,ori,population,state,year)|summary_clearance_type(cleared_by_arrest,cleared_exceptional,ori,total_offenses,ucr_offense_code,year)": {
    question: "How often an agency's offences ended in an arrest or were closed another way.",
    example: "What share of Cleveland's robberies ended in an arrest in 2022?",
    year: { recommend: "yes", why: "This compares offences and outcomes within a particular year." },
    processes: ["nibrs_rebuild"],
    integrity: ["clearance","stale","missing_agencies"],
  },
  "nibrs::agencies::agencies(ori)": {
    question: "Which agencies exist in NIBRS at all — the question behind naming a department.",
    example: "Does Fresno PD report to NIBRS?",
    year: { recommend: "no", why: "This answer lists which departments exist; it does not provide a yearly statistic." },
    processes: ["nibrs_rebuild"],
    integrity: ["missing_agencies","stale"],
  },
  "nibrs::agencies::agencies(state)": {
    question: "Which states have NIBRS agencies.",
    example: "Which states have departments reporting to NIBRS?",
    year: { recommend: "no", why: "This lists which states appear. It is a roster, not a yearly figure." },
    processes: ["nibrs_rebuild"],
    integrity: ["missing_agencies","stale"],
  },
  "nibrs::agencies::agencies(year)": {
    question: "Which years NIBRS agency data covers — what to say when someone asks for a year we may not have.",
    example: "What years of NIBRS data do you have?",
    year: { recommend: "no", why: "This is itself the answer about which years exist. Asking it about one particular year would go in a circle." },
    processes: ["nibrs_rebuild"],
    integrity: ["stale","coverage_gap"],
  },
  "nibrs::nibrs_agency_completeness+summary_arrestee_demographics::nibrs_agency_completeness(months_reported,ori,year)|summary_arrestee_demographics(arrestee_count,ori,race,ucr_arrest_offense,year)": {
    question: "Arrests by race, counting only agencies that reported the whole year.",
    example: "How many people were arrested by race in 2022, counting only departments that reported all year?",
    year: { recommend: "yes", why: "The counts are yearly, and \"reported the whole year\" is a statement about one year at a time." },
    processes: ["nibrs_rebuild"],
    integrity: ["consistent_set","categories","coverage_gap"],
  },
  "nibrs::nibrs_agency_completeness+summary_offender_demographics::nibrs_agency_completeness(months_reported,ori,year)|summary_offender_demographics(offender_count,ori,race,ucr_offense_code,year)": {
    question: "Offenders by race, counting only agencies that reported the whole year.",
    example: "Who were the offenders by race in 2022, counting only departments that reported all year?",
    year: { recommend: "yes", why: "The counts are yearly, and \"reported the whole year\" is a statement about one year at a time." },
    processes: ["nibrs_rebuild"],
    integrity: ["consistent_set","categories","coverage_gap"],
  },
  "nibrs::nibrs_agency_completeness+summary_victim_city_monthly::nibrs_agency_completeness(months_reported,ori,year)|summary_victim_city_monthly(month,ori,ucr_offense_code,victim_count,year)": {
    question: "Month-by-month victim counts for a city, counting only agencies that reported the whole year.",
    example: "Show me month-by-month victim counts for Tucson in 2022.",
    year: { recommend: "yes", why: "The months being counted sit inside a particular year, so a request can fall outside what we hold." },
    processes: ["nibrs_rebuild"],
    integrity: ["consistent_set","coverage_gap","double"],
  },
  "nibrs::nibrs_agency_completeness+summary_victim_demographics::nibrs_agency_completeness(months_reported,ori,year)|summary_victim_demographics(ori,race,ucr_offense_code,victim_count,year)": {
    question: "Victims by race, counting only agencies that reported the whole year.",
    example: "How many victims by race were there in 2021, counting only departments that reported all year?",
    year: { recommend: "yes", why: "The counts are yearly, and \"reported the whole year\" is a statement about one year at a time." },
    processes: ["nibrs_rebuild"],
    integrity: ["consistent_set","categories","coverage_gap"],
  },
  "nibrs::nibrs_consistent_reporters+summary_arrestee_demographics::nibrs_consistent_reporters(end_year,ori,start_year)|summary_arrestee_demographics(arrestee_count,ori,race,ucr_arrest_offense,year)": {
    question: "Arrests by race over several years, counting only agencies that reported consistently across the whole span.",
    example: "How have arrests by race changed from 2018 to 2023 among departments that reported throughout?",
    year: { recommend: "yes", why: "The whole point is a span of years, so a request can reach past either end of what we hold." },
    processes: ["nibrs_rebuild"],
    integrity: ["consistent_set","categories","disagree"],
  },
  "nibrs::nibrs_consistent_reporters+summary_offender_demographics::nibrs_consistent_reporters(end_year,ori,start_year)|summary_offender_demographics(offender_count,ori,race,ucr_offense_code,year)": {
    question: "Offenders by race over several years, counting only agencies that reported consistently across the whole span.",
    example: "How have offender demographics changed from 2019 to 2023 among departments that reported throughout?",
    year: { recommend: "yes", why: "The whole point is a span of years, so a request can reach past either end of what we hold." },
    processes: ["nibrs_rebuild"],
    integrity: ["consistent_set","categories","disagree"],
  },
  "nibrs::nibrs_consistent_reporters+summary_victim_city_monthly::nibrs_consistent_reporters(end_year,ori,start_year)|summary_victim_city_monthly(ori,ucr_offense_code,victim_count,year)": {
    question: "Victim counts over several years, counting only agencies that reported consistently across the whole span.",
    example: "How have victim counts changed from 2018 to 2023 among departments that reported throughout?",
    year: { recommend: "yes", why: "The whole point is a span of years, so a request can reach past either end of what we hold." },
    processes: ["nibrs_rebuild"],
    integrity: ["consistent_set","disagree","double"],
  },
  "nibrs::nibrs_consistent_reporters+summary_victim_demographics::nibrs_consistent_reporters(end_year,ori,start_year)|summary_victim_demographics(ori,race,ucr_offense_code,victim_count,year)": {
    question: "Victims by race over several years, counting only agencies that reported consistently across the whole span.",
    example: "How have victims by race changed from 2018 to 2023 among departments that reported throughout?",
    year: { recommend: "yes", why: "The whole point is a span of years, so a request can reach past either end of what we hold." },
    processes: ["nibrs_rebuild"],
    integrity: ["consistent_set","categories","disagree"],
  },
  "nibrs::rollup.national_summary_arrestee_demographics::rollup.national_summary_arrestee_demographics(age_group,arrestee_count,race,year)": {
    question: "National arrest totals broken down by age group and race.",
    example: "Nationally, how many people under 18 were arrested in 2022, and of what race?",
    year: { recommend: "yes", why: "These national totals are published one year at a time." },
    processes: ["nibrs_rollup"],
    integrity: ["rollup","categories","stale"],
  },
  "nibrs::rollup.national_summary_arrestee_demographics::rollup.national_summary_arrestee_demographics(arrestee_count,ucr_arrest_offense,year)": {
    question: "National arrest totals broken down by offence.",
    example: "How many drug arrests were there nationally in 2022?",
    year: { recommend: "yes", why: "These national totals are published one year at a time." },
    processes: ["nibrs_rollup"],
    integrity: ["rollup","categories","stale"],
  },
  "nibrs::rollup.state_summary_arrestee_demographics::rollup.state_summary_arrestee_demographics(age_group,arrestee_count,race,state,year)": {
    question: "State-level arrest totals broken down by age group and race.",
    example: "How many people were arrested in Ohio in 2022, by age and race?",
    year: { recommend: "yes", why: "These state totals are published one year at a time." },
    processes: ["nibrs_rollup"],
    integrity: ["rollup","categories","stale"],
  },
  "nibrs::summary_clearance_detail::summary_clearance_detail(cleared_A,cleared_B,cleared_C,cleared_D,cleared_E,cleared_by_arrest,state,total_offenses,ucr_offense_code,year)": {
    question: "How offences were closed in each state, split by the different ways a case can be cleared.",
    example: "In Georgia in 2022, how many offences were closed by an arrest rather than some other way?",
    year: { recommend: "yes", why: "Offences and how they were closed are counted within a particular year." },
    processes: ["nibrs_rebuild"],
    integrity: ["clearance","categories","stale"],
  },
  "nibrs::summary_clearance_type::summary_clearance_type(cleared_by_arrest,cleared_exceptional,ori,total_offenses,ucr_offense_code,year)": {
    question: "Whether an agency's offences were cleared by arrest or closed for another reason.",
    example: "Were Wichita PD's 2022 offences closed by an arrest or some other way?",
    year: { recommend: "yes", why: "Offences and how they were closed are counted within a particular year." },
    processes: ["nibrs_rebuild"],
    integrity: ["clearance","stale","double"],
  },
  "nibrs::summary_juvenile_offender_incidents::summary_juvenile_offender_incidents(incident_count,offense_scope,state,year)": {
    question: "Incidents involving juvenile offenders, by state.",
    example: "How many incidents in Missouri in 2022 involved a juvenile offender?",
    year: { recommend: "yes", why: "Incidents are counted for a particular year, so a request can fall outside what we hold." },
    processes: ["nibrs_rebuild"],
    integrity: ["categories","stale","double"],
  },
  "nibrs::summary_victim_circumstance+summary_victim_state_monthly::summary_victim_circumstance(circumstance_code,state,ucr_offense_code,victim_count,year)|summary_victim_state_monthly(state,ucr_offense_code,victim_count,year)": {
    question: "Victim counts by the circumstances of the offence, by state — for example how many homicides were domestic.",
    example: "How many homicides in Louisiana in 2022 were domestic?",
    year: { recommend: "yes", why: "These counts belong to a particular year, so someone can ask for one we do not have." },
    processes: ["nibrs_rebuild"],
    integrity: ["categories","disagree","double"],
  },
  "shr::agency_county_crosswalk+incidents::agency_county_crosswalk(county_fips,county_key,ori,state)|incidents(ori)": {
    question: "Homicide records for a given county.",
    example: "How many homicides were there in Jefferson Parish in 2019?",
    year: { recommend: "yes", why: "Homicides happen on a date, so someone can reasonably ask about a single year of them." },
    processes: ["shr"],
    integrity: ["crosswalk","missing_agencies","stale"],
  },
  "shr::incidents+shr_agency_alias+shr_agency_identity+victims::incidents(homicide_type,id,ori,weapon_group,year)|victims(incident_id)": {
    question: "Homicides for an agency broken down by weapon and type, with how many victims each incident had.",
    example: "How many firearm homicides did Memphis PD report in 2021, and how many victims were involved?",
    year: { recommend: "yes", why: "Homicides are recorded with the year they happened, so a request can fall outside the years we hold." },
    processes: ["shr"],
    integrity: ["double","categories","stale"],
  },
  "shr::incidents::incidents(ori)": {
    question: "Which agencies reported homicides.",
    example: "Which departments report homicide records?",
    year: { recommend: "no", why: "This lists which departments report at all; it is not a yearly count." },
    processes: ["shr"],
    integrity: ["missing_agencies","stale"],
  },
  "shr::incidents::incidents(state)": {
    question: "Which states have homicide records.",
    example: "Which states have homicide records?",
    year: { recommend: "no", why: "This lists which states appear. It is a roster, not a yearly figure." },
    processes: ["shr"],
    integrity: ["missing_agencies","stale"],
  },
  "shr::incidents::incidents(year)": {
    question: "Which years the homicide records cover.",
    example: "What years of homicide data do you have?",
    year: { recommend: "no", why: "This is itself the answer about which years exist." },
    processes: ["shr"],
    integrity: ["stale","coverage_gap"],
  },
  };

  /**
   * A digest of everything a person would have READ when answering.
   *
   * The registry fingerprint covers database structure only, so a reworded question, a changed
   * scenario or a different set of process choices left it untouched -- an old session still
   * loaded, and a restored answer still showed as confirmed under wording nobody had seen. What a
   * confirmation attaches to is the question as it was asked, so the question has to be in the
   * identity. The example and the year advice are read before answering too, so they are in it.
   *
   * FNV-1a over canonical JSON: deterministic, dependency-free, and identical in the page and at
   * the boundary.
   */
  function fingerprint() {
    const canonical = Object.keys(CATALOG).sort().map((id) => {
      const e = CATALOG[id];
      return [id, e.question, e.example, [e.year.recommend, e.year.why],
        e.processes.map((k) => PROCESSES[k] || k),
        e.integrity.map((k) => [k, SCENARIOS[k] ? SCENARIOS[k].label : "", SCENARIOS[k] ? SCENARIOS[k].prose : ""])];
    });
    const text = JSON.stringify(canonical);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return ("0000000" + hash.toString(16)).slice(-8);
  }

  return {
    PROCESSES: PROCESSES,
    SCENARIOS: SCENARIOS,
    fingerprint: fingerprint,
    ids: () => Object.keys(CATALOG),
    entry: (id) => CATALOG[id] || null,
    /** The question this capability answers, or null when it has none -- never a fallback. */
    question: (id) => (CATALOG[id] ? CATALOG[id].question : null),
    /** One realistic asking of it, so the reader recognises the question rather than parsing it. */
    example: (id) => (CATALOG[id] ? CATALOG[id].example : null),
    /**
     * Whether a year is a sensible thing to ask this about, and why in ordinary words.
     *
     * A RECOMMENDATION, never a selection. It is about the subject matter, so it stays honest even
     * where the answer does not currently read a date -- that gap is engineering's to close.
     */
    yearAdvice: (id) => (CATALOG[id] ? CATALOG[id].year : null),
    /** Only the processes that could plausibly own THIS capability. */
    processLabels: (id) => (CATALOG[id] ? CATALOG[id].processes.map((k) => PROCESSES[k]).filter(Boolean) : []),
    /** Scenarios worth asking about for THIS data. */
    scenarios: (id) => (CATALOG[id]
      ? CATALOG[id].integrity.map((k) => (SCENARIOS[k] ? { value: k, label: SCENARIOS[k].label, prose: SCENARIOS[k].prose } : null)).filter(Boolean)
      : []),
    /**
     * Which capabilities the catalog and the registry disagree about.
     *
     * Generation fails on any disagreement rather than filling a gap with something generic: a
     * capability that arrives without a description would otherwise be handed a paraphrase of its
     * table names, which is the defect this file was written to remove.
     */
    coverageAgainst: (registryIds) => ({
      missing: registryIds.filter((id) => !CATALOG[id]),
      extra: Object.keys(CATALOG).filter((id) => registryIds.indexOf(id) < 0),
    }),
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { stage2bCapabilityCatalog: stage2bCapabilityCatalog };
}
