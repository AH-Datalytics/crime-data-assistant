import assert from "node:assert/strict";
import { alignTitleYearRange, applyResultDisclosures, laggedAnnualRecentYearNote, missingLowerBoundNote, trimTrailingEmptyYearRows } from "../lib/result-disclosure";
import { historicalRapeSeries, RAPE_DEFINITION_CAVEAT, returnedRapeCountColumn } from "../lib/historical-rape-series";

{
  const rows = [];
  for (let y = 2006; y <= 2026; y++) rows.push({ year: y, burglary: y <= 2025 ? 100 : null });
  const out = trimTrailingEmptyYearRows(rows, "Burglary counts for Menlo Park from 2006 to 2026.");
  assert.equal(out.rows.length, 20);
  assert.equal(out.rows[out.rows.length - 1].year, 2025);
  assert.deepEqual(out.trimmedYears, [2026]);
  assert.match(out.explanation, /from 2006 to 2025/);
  assert.match(out.explanation, /available through 2025/i);
}
{
  const rows = [{ year: 2023, agency: "X", burglary: 50 }, { year: 2024, agency: "X", burglary: null }, { year: 2025, agency: "X", burglary: 40 }];
  const out = trimTrailingEmptyYearRows(rows, "Counts from 2023 to 2025.");
  assert.equal(out.rows.length, 3);
  assert.deepEqual(out.trimmedYears, []);
}
{
  const out = trimTrailingEmptyYearRows([{ year: 2025, burglary: null }, { year: 2026, burglary: null }], "x");
  assert.equal(out.rows.length, 2);
}


{
  const explanation = applyResultDisclosures({
    explanation: "DUI arrests by age group nationally.",
    question: "DUI arrests by age group nationally",
    sql: "SELECT age_group, SUM(arrestee_count) AS arrests FROM summary_arrestee_demographics WHERE year >= 2022 GROUP BY age_group",
    rows: [{ age_group: "18-24", arrests: 10 }],
  });
  assert.match(explanation, /Period: 2022 onward\./);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Gun homicides in St. Louis County year-to-date.",
    question: "Gun homicides in St. Louis County 2026 YTD",
    sql: "SELECT year, month, COUNT(*) AS victims FROM incidents WHERE year = 2026 AND month <= 5 GROUP BY year, month",
    rows: [
      { year: 2026, month: 1, victims: 1 },
      { year: 2026, month: 5, victims: 2 },
    ],
  });
  /*
   * CORRECTED 2026-09-09. This previously asserted "January-May 2026" for rows containing ONLY
   * January and May — the endpoint smoothing that hides missing interior months, which the period
   * ruling forbids. February, March and April returned nothing, so they are not claimed. The SQL's
   * `month <= 5` shows what was REQUESTED; it does not establish that every selected month produced
   * observations.
   */
  assert.match(explanation, /Returned period: January and May 2026\./);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Murder counts in Texas from 2020 to 2024.",
    question: "murder in Texas 2020 to 2024",
    sql: "SELECT year, murder FROM x WHERE year BETWEEN 2020 AND 2024",
    rows: [{ year: 2020, murder: 1 }, { year: 2024, murder: 2 }],
  });
  assert.doesNotMatch(explanation, /Period:/, "does not duplicate period when explanation already names years");
}

{
  const explanation = applyResultDisclosures({
    explanation: "Larceny from auto in Edmond over the available years.",
    question: "larceny from auto in Edmond",
    sql: "SELECT year, SUM(count) AS thefts FROM agency_monthly WHERE agency = 'Edmond' AND offense = 'Theft' GROUP BY year",
    rows: [{ year: 2024, thefts: 10 }],
    tab: "current",
  });
  assert.match(explanation, /reports only total Theft, not the requested theft subtype/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Larceny from auto in Edmond over the available years.",
    question: "larceny from auto in Edmond",
    sql: "SELECT year, SUM(offense_count) AS thefts FROM summary_city_monthly WHERE ucr_offense_code = '23F' GROUP BY year",
    rows: [{ year: 2024, thefts: 10 }],
    tab: "nibrs",
  });
  assert.doesNotMatch(explanation, /reports only total Theft/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Violent crime in Texas over the available years.",
    question: "violent crime in Texas",
    sql: "SELECT year, SUM(total) AS violent_crime FROM x WHERE ucr_offense_code IN ('09A','11A','11B','11C','120','13A') GROUP BY year",
    rows: [{ year: 2024, violent_crime: 10 }],
    tab: "nibrs",
  });
  assert.match(explanation, /Definition: NIBRS violent crime is reported here using the UCR-aligned set/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Property crime in Texas over the available years.",
    question: "property crime in Texas",
    sql: "SELECT year, SUM(offense_count) AS property_crime FROM summary_state_monthly WHERE ucr_offense_code IN ('200','220','23A','23B','23C','23D','23E','23F','23G','23H','240') GROUP BY year",
    rows: [{ year: 2024, property_crime: 10 }],
    tab: "nibrs",
  });
  assert.match(explanation, /Definition: NIBRS property crime is reported here using the UCR-aligned set/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Domestic violence incident rates by state in 2025.",
    question: "domestic violence incident counts per 100,000 population across states in 2025",
    sql: "WITH dv AS (SELECT state, COUNT(DISTINCT ori || ':' || data_year || ':' || incident_num) AS dv_incidents FROM summary_domestic_violence WHERE data_year = 2025 GROUP BY state), population AS (SELECT a.state, SUM(a.population * nac.months_reported / 12.0) AS reporting_population FROM nibrs_agency_completeness nac JOIN agencies a ON a.ori = nac.ori AND a.year = nac.year WHERE nac.year = 2025 AND nac.months_reported > 0 AND a.population > 0 GROUP BY a.state) SELECT dv.state, population.reporting_population, ROUND(dv.dv_incidents * 100000.0 / population.reporting_population, 1) AS rate_per_100k FROM dv JOIN population ON population.state = dv.state",
    rows: [{ state: "TX", reporting_population: 100000, rate_per_100k: 2.5 }],
    tab: "nibrs",
  });
  assert.match(explanation, /population served by NIBRS-reporting agencies/);
  assert.match(explanation, /adjusted for months reported/);
  assert.match(explanation, /not a complete official state population rate/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Domestic violence arrests in Washington statewide from 2021 to 2026.",
    question: "how many charges of domestic violence in Washington, DC",
    sql: "SELECT data_year, SUM(arrest_count) AS arrests FROM summary_dv_arrests WHERE state = 'DC' GROUP BY data_year",
    rows: [{ data_year: 2025, arrests: 10 }],
    tab: "nibrs",
  });
  assert.match(explanation, /Washington, DC/);
  assert.doesNotMatch(explanation, /Washington statewide|Washington state/i);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Motor vehicle theft counts for the requested cities.",
    question: "motor vehicle theft in six Texas cities",
    sql: "SELECT city, SUM(offense_count) AS thefts FROM summary_city_monthly WHERE city IN ('HOUSTON','DALLAS','JERSEY VILLAGE','WEST UNIVERSITY PLACE') GROUP BY city",
    rows: [
      { city: "HOUSTON", thefts: 10 },
      { city: "DALLAS", thefts: 8 },
    ],
    tab: "nibrs",
  });
  assert.match(explanation, /No data found for: JERSEY VILLAGE, WEST UNIVERSITY PLACE/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "DUI arrests by age group at the national level.",
    question: "DUI arrests by age group nationally split by state",
    sql: "SELECT state, age_group, SUM(arrestee_count) AS arrests FROM summary_arrestee_demographics GROUP BY state, age_group",
    rows: [
      { state: "TX", age_group: "18-24", arrests: 10 },
      { state: "CA", age_group: "18-24", arrests: 8 },
    ],
  });
  assert.match(explanation, /Scope correction: Results are grouped by state, not a single national total\./);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Murder counts nationally.",
    question: "murder nationally",
    sql: "SELECT year, SUM(count) AS murders FROM national_monthly GROUP BY year",
    rows: [
      { year: 2024, murders: 100 },
      { year: 2025, murders: 90 },
    ],
  });
  assert.doesNotMatch(explanation, /Scope correction:/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "The St. Louis County Sheriff's Office reported 3 firearm homicides.",
    question: "Gun homicides in St. Louis County",
    sql: "SELECT agency, state, COUNT(*) AS homicides FROM incidents WHERE agency = 'St. Louis County Police' GROUP BY agency, state",
    rows: [{ agency: "St. Louis County Police", state: "MO", homicides: 3 }],
  });
  assert.doesNotMatch(explanation, /Sheriff'?s Office/i);
  assert.match(explanation, /Descriptor correction:/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "These states are represented in the source.",
    question: "Which states are missing from this data?",
    sql: "WITH all_states AS (SELECT 'AK' AS state UNION ALL SELECT 'TX') SELECT state FROM all_states EXCEPT SELECT state FROM agencies",
    rows: [{ state: "AK" }, { state: "TX" }],
  });
  assert.match(explanation, /Set interpretation: These rows are missing from the compared set/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Fatal firearm homicides in New York since 2022.",
    question: "how has gun violence changed in New York State since 2022?",
    sql: "SELECT year, COUNT(*) AS fatal_shootings FROM incidents WHERE agency = 'New York' AND state = 'NY' AND weapon_group = 'Firearm' GROUP BY year",
    rows: [{ year: 2022, fatal_shootings: 273 }],
    tab: "shr",
  });
  assert.match(explanation, /Geography warning: This result filters agency New York; it is not statewide data for New York\./);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Maryland statewide murder counts by month.",
    question: "murders in the State of Maryland in 2026",
    sql: "SELECT am.year, am.month, SUM(am.count) AS murders FROM agency_monthly am JOIN agencies a ON a.ori = am.ori WHERE a.state = 'MD' AND am.year = 2026 GROUP BY am.year, am.month",
    rows: [{ year: 2026, month: 1, murders: 10 }],
    tab: "current",
  });
  assert.doesNotMatch(explanation, /not statewide data/i);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Victim counts by age group across the requested cities for each year from 2015 to 2025.",
    question: "disaggregate by year",
    sql: "SELECT d.year, d.age_group, SUM(d.victim_count) AS victims FROM summary_victim_demographics d WHERE d.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = 2015 AND end_year = 2025) GROUP BY d.year, d.age_group",
    rows: [{ year: 2015, age_group: "18-24", victims: 10 }],
    tab: "nibrs",
  });
  assert.doesNotMatch(explanation, /\brequested cities\b/i);
  assert.match(explanation, /across continuously reporting agencies/);
  assert.match(explanation, /reported all 12 months in every requested year/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Juvenile offender counts by year, with reporting coverage shown for context.",
    question: "juvenile offenders by year with reporting coverage",
    sql: "WITH reporting_coverage AS (SELECT year, SUM(CASE WHEN months_reported = 12 THEN 1 ELSE 0 END) AS complete_agencies FROM nibrs_agency_completeness GROUP BY year) SELECT d.year, SUM(d.offender_count) AS offenders, rc.complete_agencies FROM summary_offender_demographics d LEFT JOIN reporting_coverage rc ON rc.year = d.year WHERE d.age_group = 'Under 18' GROUP BY d.year, rc.complete_agencies",
    rows: [{ year: 2024, offenders: 10, complete_agencies: 8000 }],
    tab: "nibrs",
  });
  assert.doesNotMatch(explanation, /Coverage filter:/, "coverage metric join is not a continuous-reporter fact filter");
}

{
  const explanation = applyResultDisclosures({
    explanation: "Murder data for Detroit in 2026.",
    question: "how mnay murders in detroit in 2026",
    sql: "SELECT year, month, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Detroit' AND year = 2026 GROUP BY year, month",
    rows: [
      { year: 2026, month: 1, murders: 16 },
      { year: 2026, month: 2, murders: 14 },
      { year: 2026, month: 3, murders: 18 },
    ],
    tab: "current",
  });
  assert.match(explanation, /Returned period: January-March 2026\./);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Seattle's 2026 per-capita murder rate is shown by month.",
    question: "what is seattle's 2026 per capita murder rate",
    sql: "SELECT year, month, SUM(count) * 100000.0 / AVG(population) AS murder_rate_per_100k FROM agency_monthly WHERE agency = 'Seattle' AND year = 2026 GROUP BY year, month",
    rows: [
      { year: 2026, month: 1, murder_rate_per_100k: 1.2 },
      { year: 2026, month: 2, murder_rate_per_100k: 1.3 },
      { year: 2026, month: 3, murder_rate_per_100k: 1.4 },
    ],
    tab: "current",
  });
  assert.match(explanation, /Returned period: January-March 2026\./);
  assert.match(explanation, /2026 is incomplete/);
  assert.match(explanation, /not a full-year 2026 rate/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Murder data for Detroit in April and May 2026.\n\nNote: Current Trends data comes from a sample.",
    question: "where is april and may",
    sql: "SELECT year, month, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Detroit' AND year = 2026 GROUP BY year, month",
    rows: [
      { year: 2026, month: 1, murders: 16 },
      { year: 2026, month: 2, murders: 14 },
      { year: 2026, month: 3, murders: 18 },
    ],
    tab: "current",
  });
  assert.doesNotMatch(explanation, /Murder data for Detroit in April and May 2026/i);
  assert.match(explanation, /April and May 2026 are not available in Current Trends yet/);
  assert.match(explanation, /latest returned month is March 2026/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Rolling homicide counts for the requested cities.",
    question: "show rolling homicide index for NYC, Baltimore, Philadelphia, and Washington DC",
    sql: "SELECT agency AS city, year, month, SUM(count) AS murders FROM agency_monthly WHERE state IN ('NY','MD','PA','DC') AND agency IN ('New York','Baltimore','Philadelphia','Washington') GROUP BY city, year, month",
    rows: [
      { city: "New York", year: 2025, month: 1, murders: 10 },
      { city: "Baltimore", year: 2025, month: 1, murders: 5 },
      { city: "Philadelphia", year: 2025, month: 1, murders: 6 },
      { city: "Washington", year: 2025, month: 1, murders: 4 },
    ],
    tab: "current",
  });
  assert.doesNotMatch(explanation, /No data found for: NY|No data found for: MD|No data found for: PA|No data found for: DC/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Murder clearance rates for Chicago, Austin, Columbus, Charlotte, Nashville, and St. Louis.",
    question: "murder clearance rates for Chicago Illinois, Austin Texas, Columbus Ohio, Charlotte North Carolina, Nashville Tennessee, and St. Louis city",
    sql: "SELECT city, state, SUM(total_offenses) AS murders FROM summary_clearance_city_annual WHERE (city = 'CHICAGO' AND state = 'IL') OR (city = 'AUSTIN' AND state = 'TX') OR (city = 'COLUMBUS' AND state = 'OH') OR (city = 'CHARLOTTE' AND state = 'NC') OR (city = 'NASHVILLE' AND state = 'TN') OR (city = 'SAINT LOUIS' AND state = 'MO') GROUP BY city, state",
    rows: [
      { city: "Chicago", state: "IL", murders: 1 },
      { city: "Austin", state: "TX", murders: 1 },
      { city: "Columbus", state: "OH", murders: 1 },
      { city: "Charlotte", state: "NC", murders: 1 },
      { city: "Nashville", state: "TN", murders: 1 },
      { city: "St. Louis", state: "MO", murders: 1 },
    ],
    tab: "nibrs",
  });
  assert.doesNotMatch(explanation, /No data found for: SAINT LOUIS/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Victim counts for cities that consistently reported data for each year.",
    question: "show assaults by year for consistent reporting agencies",
    sql: "SELECT year, SUM(victim_count) AS victims FROM summary_victim_city_monthly WHERE ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = 2017 AND end_year = 2025) GROUP BY year",
    rows: [{ year: 2017, victims: 10 }, { year: 2025, victims: 15 }],
    tab: "nibrs",
  });
  assert.doesNotMatch(explanation, /cities that consistently reported/i);
  assert.match(explanation, /agencies that reported continuously/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Weapon breakdown for assaults for an unknown time period.",
    question: "breakdown of weapons used in assaults 2024",
    sql: "SELECT weapon_group, SUM(offense_count) AS assaults FROM summary_offense_weapon WHERE year = 2024 GROUP BY weapon_group",
    rows: [{ weapon_group: "Firearm", assaults: 10 }],
    tab: "nibrs",
  });
  assert.doesNotMatch(explanation, /unknown time period/i);
  assert.match(explanation, /for 2024/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "California murder rates by year.",
    question: "CA vs. TX vs. GA vs NY vs IL murder rate per year",
    sql: "SELECT year, MAX(CASE WHEN state = 'California' THEN murder_rate END) AS california, MAX(CASE WHEN state = 'Texas' THEN murder_rate END) AS texas, MAX(CASE WHEN state = 'Georgia' THEN murder_rate END) AS georgia, MAX(CASE WHEN state = 'New York' THEN murder_rate END) AS new_york, MAX(CASE WHEN state = 'Illinois' THEN murder_rate END) AS illinois FROM historical_state_national WHERE state IN ('California','Texas','Georgia','New York','Illinois') GROUP BY year ORDER BY year",
    rows: [
      { year: 2020, california: 5.6, texas: 6.6, georgia: 8.4, new_york: 4.2, illinois: 9.1 },
      { year: 2021, california: 6.0, texas: 7.0, georgia: 8.9, new_york: 4.5, illinois: 9.4 },
    ],
    tab: "historical",
  });
  assert.match(explanation, /Comparison includes: California, Texas, Georgia, New York, Illinois\./);
}

{
  const explanation = applyResultDisclosures({
    explanation: "National murder rate data from 1960 to 2024.",
    question: "National murder clearance rate since 1960",
    sql: "SELECT year, murder_rate FROM national_clearance_rate WHERE year >= 1960 ORDER BY year",
    rows: [{ year: 1960, murder_rate: 91.0 }, { year: 2024, murder_rate: 58.0 }],
    tab: "historical",
  });
  assert.match(explanation, /National murder clearance rate data/);
  assert.doesNotMatch(explanation, /National murder rate data/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Murder clearance rates for Chicago.",
    question: "murder solve rate in Chicago since 2020",
    sql: "SELECT year, clearance_rate FROM summary_clearance_city_annual WHERE city = 'CHICAGO'",
    rows: [{ year: 2024, clearance_rate: 54.2 }],
    tab: "nibrs",
  });
  assert.match(explanation, /FBI clearance means cleared by arrest or exceptional means/);
  assert.match(explanation, /not the same as conviction or prosecution/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Crime trends for Durham and Fort Myers.",
    question: "compare durham nc crime to fort myers fl",
    sql: "SELECT data_year, city, SUM(victim_count) AS victims FROM summary_victim_city_monthly WHERE ucr_offense_code IN ('09A','11A','11B','11C','13A') GROUP BY data_year, city",
    rows: [{ data_year: 2024, city: "DURHAM", victims: 10 }],
    tab: "nibrs",
  });
  assert.match(explanation, /person-offense filter/);
  assert.doesNotMatch(explanation, /robbery/);
  assert.match(explanation, /not all crime/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "Rolling homicide counts for the requested cities.",
    question: "show rolling homicide index for Chicago, NYC, and Houston",
    sql: "SELECT year, chicago, nyc, houston FROM x",
    rows: [
      { year: 2024, chicago: 100, nyc: 90, houston: 80 },
    ],
    tab: "current",
  });
  assert.match(explanation, /Comparison includes: Chicago, NYC, Houston\./);
}

{
  const explanation = applyResultDisclosures({
    explanation: "The chart shows incidents by age group for agencies with incomplete crime data coverage.",
    question: "show murders, robberies, and aggravated assaults by offender age and year from continuously reporting agencies",
    sql: "SELECT d.year, d.ucr_offense_code, d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = 2018 AND end_year = 2025) GROUP BY d.year, d.ucr_offense_code, d.age_group",
    rows: [{ year: 2025, ucr_offense_code: "09A", age_group: "25-34", offenders: 10 }],
    tab: "nibrs",
  });
  assert.match(explanation, /agencies with continuous reporting/);
  assert.match(explanation, /Coverage filter:/);
  assert.match(explanation, /grouped by offense code and age group/);
}


{
  const explanation = applyResultDisclosures({
    explanation: "The share of aggravated assaults that involved domestic violence victims, statewide, from 2021 to 2025.",
    question: "what share of aggravated assaults are domestic violence?",
    sql: "SELECT dv.year, SUM(dv.victim_count) AS dv_victims, SUM(total.victim_count) AS total_assaults FROM (SELECT year, SUM(victim_count) AS victim_count FROM summary_victim_circumstance WHERE ucr_offense_code = '13A' AND circumstance_code = '06' GROUP BY year) dv JOIN (SELECT year, SUM(victim_count) AS victim_count FROM summary_victim_state_monthly WHERE ucr_offense_code = '13A' GROUP BY year) total ON total.year = dv.year GROUP BY dv.year",
    rows: [{ year: 2021, dv_victims: 10, total_assaults: 100 }],
    tab: "nibrs",
  });
  assert.doesNotMatch(explanation, /statewide/);
  assert.match(explanation, /nationally across reporting NIBRS agencies/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "This query shows the annual count of murder victims overall and those killed with a firearm, from 1990 through 2025.",
    question: "What share of murders involved a firearm since 1990?",
    sql: "SELECT i.year, COUNT(*) AS total_murders FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.homicide_type = 'Murder' AND i.year >= 1990 GROUP BY i.year ORDER BY i.year",
    rows: [{ year: 1990, total_murders: 100 }, { year: 2026, total_murders: 50 }],
    tab: "shr",
  });
  assert.match(explanation, /through 2026/);
  assert.doesNotMatch(explanation, /through 2025/);
}


{
  const explanation = applyResultDisclosures({
    explanation: "The 20 most populous cities ranked by their 2026 murder rate. 2026 is incomplete; this is a partial-year total based on the returned data, not a full-year 2026 total.",
    question: "the 20 most populous cities in the dataset ranked by their 2026 murder rate",
    sql: "SELECT agency, ROUND(SUM(count) * 100000.0 / population, 1) AS rate_per_100k FROM agency_monthly WHERE year = 2026 GROUP BY agency",
    rows: [{ agency: "Philadelphia", year: 2026, rate_per_100k: 3.5 }],
    tab: "current",
  });
  assert.match(explanation, /partial-year rate/);
  assert.match(explanation, /full-year 2026 rate/);
  assert.doesNotMatch(explanation, /partial-year total/);
}
{
  const explanation = applyResultDisclosures({
    explanation: "This data contains murder rates for cities in DC, NM, CO.",
    question: "rank states by stolen car rate 2024",
    sql: "SELECT state, rate_per_100k FROM summary_state_monthly",
    rows: [{ state: "DC", rate_per_100k: 10 }, { state: "NM", rate_per_100k: 9 }, { state: "CO", rate_per_100k: 8 }],
    tab: "nibrs",
  });
  assert.match(explanation, /for states in DC, NM, CO/);
}

{
  const explanation = applyResultDisclosures({
    explanation: "This data contains murder counts for Montgomery County, Maryland.",
    question: "What is the current countywide homicide rate?",
    sql: "SELECT year, month, murders FROM agency_monthly",
    rows: [{ year: 2026, month: 5, murders: 10 }],
    tab: "current",
  });
  assert.match(explanation, /Returned period: May 2026\./);
  assert.doesNotMatch(explanation, /May-May/);
}

{
  // 7708 shape: annual hate-crime trend running into the in-progress year.
  const rows = [{ year: 2023, incident_count: 12067 }, { year: 2024, incident_count: 11689 }, { year: 2025, incident_count: 10647 }, { year: 2026, incident_count: 4806 }];
  const note = laggedAnnualRecentYearNote(rows, "National hate crime incidents by year.", 2026);
  assert.ok(note && /incomplete|preliminary|partial|lag/i.test(note), "must disclose recent-year incompleteness");
  assert.ok(note && /2026/.test(note), "must name the in-progress year");
}

{
  // No recent-year rows -> no note (a trend ending at a fully-published year).
  const rows = [{ year: 2020, incident_count: 9973 }, { year: 2021, incident_count: 11072 }];
  assert.equal(laggedAnnualRecentYearNote(rows, "x", 2026), null);
}

{
  // Idempotent: if the explanation already discloses, return null so we do not double-append.
  const rows = [{ year: 2026, incident_count: 4806 }];
  assert.equal(laggedAnnualRecentYearNote(rows, "2026 is incomplete and preliminary.", 2026), null);
}

{
  // End-to-end through applyResultDisclosures on the hate_crime tab.
  const out = applyResultDisclosures({
    explanation: "National hate crime incidents by year from 2015 onward.",
    question: "how have reported hate crimes trended since 2015?",
    sql: "SELECT year, SUM(incident_count) FROM summary_hate_crime_bias_trend WHERE year >= 2015 GROUP BY year",
    rows: [{ year: 2022, incident_count: 12000 }, { year: 2023, incident_count: 11800 }, { year: 2024, incident_count: 11689 }, { year: 2025, incident_count: 10647 }, { year: 2026, incident_count: 4806 }],
    tab: "hate_crime",
  });
  assert.match(out, /incomplete|preliminary|partial|lag/i);
}


{
  const nibrsRows = [{ year: 2023, incident_count: 3900 }, { year: 2024, incident_count: 3970 }, { year: 2025, incident_count: 3890 }, { year: 2026, incident_count: 1646 }];
  const note = laggedAnnualRecentYearNote(nibrsRows, "Annual NIBRS trend.", 2026, { sourceLabel: "NIBRS" });
  assert.ok(note && /2026/.test(note), "NIBRS sharp recent drop is disclosed");
  assert.doesNotMatch(note || "", /hate-crime/i, "NIBRS disclosure is source-neutral");
  const historicalRows = [{ year: 2022, count: 50000 }, { year: 2023, count: 52000 }, { year: 2024, count: 50000 }, { year: 2025, count: 13000 }];
  assert.ok(laggedAnnualRecentYearNote(historicalRows, "Historical annual trend.", 2026, { sourceLabel: "Historical" }), "Historical sharp recent drop is disclosed");
}
{
  const completeLower = [{ year: 2023, count: 100 }, { year: 2024, count: 100 }, { year: 2025, count: 90 }];
  assert.equal(laggedAnnualRecentYearNote(completeLower, "Complete annual trend.", 2026), null, "complete-but-lower latest year is not flagged");
}
{
  const rows = [
    { year: 2020, AsianPacific_Islander: 12, White: 20, Black: 18, American_Indian: 4 },
    { year: 2021, AsianPacific_Islander: 14, White: 22, Black: 19, American_Indian: 5 },
  ];
  const beforeRows = JSON.parse(JSON.stringify(rows));
  const comparisonLabels = {
    AsianPacific_Islander: "Asian/Pacific Islander",
    White: "White",
    Black: "Black",
    American_Indian: "American Indian",
  };
  const out = applyResultDisclosures({
    explanation: "Murder victims in Houston by race.",
    question: "murder victim race in Houston since 2020",
    sql: "SELECT year, race, victims FROM incidents",
    rows,
    tab: "shr",
    comparisonLabels,
  });
  assert.match(out, /Comparison includes: Asian\/Pacific Islander, White, Black, American Indian\./);
  assert.doesNotMatch(out, /Asianpacific Islander/);
  assert.deepEqual(rows, beforeRows, "disclosure labels must not mutate rows");
}

{
  const out = applyResultDisclosures({
    explanation: "A comparison of New Orleans and Houston.",
    question: "compare New Orleans and Houston",
    sql: "SELECT year, new_orleans, houston FROM incidents",
    rows: [{ year: 2020, new_orleans: 10, houston: 20 }, { year: 2021, new_orleans: 11, houston: 21 }],
    tab: "shr",
  });
  assert.match(out, /New Orleans/);
  assert.doesNotMatch(out, /New_Orleans/);
}

{
  const text = "Comparison includes: White, Black.";
  const out = applyResultDisclosures({
    explanation: text,
    question: "show White and Black victims",
    sql: "SELECT race, victims FROM incidents",
    rows: [{ White: 20, Black: 18 }, { White: 22, Black: 19 }],
    tab: "shr",
    comparisonLabels: { White: "White", Black: "Black" },
  });
  assert.equal(out, text, "already-complete comparison text stays unchanged");
}
{
  const rows = [{ year: 2015, count: 1 }, { year: 2025, count: 2 }, { year: 2026, count: 3 }];
  assert.equal(alignTitleYearRange("U.S. Hate Crime Incidents, 2015\u20132025", rows), "U.S. Hate Crime Incidents, 2015\u20132026");
  assert.equal(alignTitleYearRange("Murders in Houston, 2015 to 2030", [{ data_year: 2018, count: 1 }, { data_year: 2024, count: 2 }]), "Murders in Houston, 2018 to 2024");
  assert.equal(alignTitleYearRange("Murders in Houston", rows), "Murders in Houston", "title without a year is unchanged");
  assert.equal(alignTitleYearRange("Murders in Houston, 2015\u20132025", [{ city: "Houston", count: 1 }]), "Murders in Houston, 2015\u20132025", "rows without a year are unchanged");
  assert.equal(alignTitleYearRange("Murders in Houston, 2015\u20132026", rows), "Murders in Houston, 2015\u20132026", "matching title is unchanged");
  assert.equal(alignTitleYearRange("NIBRS clearance methods in Chicago", rows), "NIBRS clearance methods in Chicago", "deterministic year-less title is unchanged");
}

{
  // sourceLabel wording: hate crime disclosure names its source, not the generic phrasing.
  const rows = [{ year: 2022, incident_count: 12000 }, { year: 2023, incident_count: 11800 }, { year: 2024, incident_count: 11689 }, { year: 2026, incident_count: 4806 }];
  const note = laggedAnnualRecentYearNote(rows, "Hate crime incidents by year.", 2026, { sourceLabel: "Hate crime" });
  assert.ok(note && /Hate crime data/i.test(note), "hate-crime disclosure names its source");
  // victim_count is a recognized metric column (NIBRS victim trends).
  const vrows = [{ year: 2023, victim_count: 3900 }, { year: 2024, victim_count: 3970 }, { year: 2025, victim_count: 3890 }, { year: 2026, victim_count: 1646 }];
  assert.ok(laggedAnnualRecentYearNote(vrows, "NIBRS victim trend.", 2026, { sourceLabel: "NIBRS" }), "victim_count drives the sharp-drop gate");
}

{
  const note = missingLowerBoundNote("violent crime from 2016 to present", "SELECT year FROM crime WHERE year >= 2016", [{ year: 2017, count: 10 }, { year: 2025, count: 20 }]);
  assert.equal(note, "Although the query covered 2016 onward, this source returned data beginning in 2017.");
  const out = applyResultDisclosures({
    explanation: "Violent crime trends.",
    question: "violent crime from 2016 to present",
    sql: "SELECT year, count FROM crime WHERE year >= 2016",
    rows: [{ year: 2017, count: 10 }, { year: 2025, count: 20 }],
    tab: "historical",
  });
  assert.match(out, /Although the query covered 2016 onward, this source returned data beginning in 2017\./);
  assert.equal(missingLowerBoundNote("violent crime from 2017 onward", "SELECT year FROM crime WHERE year >= 2017", [{ year: 2017, count: 10 }]), null);
  assert.equal(missingLowerBoundNote("show violent crime trends", "SELECT year FROM crime", [{ year: 2017, count: 10 }]), null);
}


// ---- GC-085: Historical annual rape-COUNT series across the 2013 definition change ----
{
  const NAT = "SELECT year, rape FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2010 AND 2024 ORDER BY year";
  const years = (from: number, to: number, value: (y: number) => number | null = () => 100) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ year: from + i, rape: value(from + i) }));
  const DIRECTION_OR_CAUSE = /\b(increas\w*|decreas\w*|rose|fell|declin\w*|due to|because|substantial\w*)\b/i;

  // GC-085: the national count series across 2013 gets the owned narrative.
  {
    const r = historicalRapeSeries("historical", NAT, years(2010, 2024));
    assert.ok(r);
    assert.equal(r.narrative, `FBI UCR rape offenses nationally by year, 2010–2024. These are the FBI's Uniform Crime Reporting rape category, not all sexual assaults. ${RAPE_DEFINITION_CAVEAT}`);
    assert.equal(DIRECTION_OR_CAUSE.test(r.narrative), false);
  }

  // Decided by the resolved source/measure/period, never the question: there is no question parameter, and the
  // same rows answer the same way whether they fall, rise or stay flat.
  for (const shape of [(y: number) => 3000 - y, (y: number) => y, () => 7]) {
    const r = historicalRapeSeries("historical", NAT, years(2011, 2014, shape));
    assert.ok(r);
    assert.ok(r.narrative.endsWith(RAPE_DEFINITION_CAVEAT));
  }

  // Period boundaries: a period wholly after (or wholly before) 2013 gets nothing; 2012-2013 crosses.
  assert.equal(historicalRapeSeries("historical", NAT, years(2013, 2024)), null);
  assert.equal(historicalRapeSeries("historical", NAT, years(2014, 2024)), null);
  assert.equal(historicalRapeSeries("historical", NAT, years(2000, 2012)), null);
  assert.ok(historicalRapeSeries("historical", NAT, years(2012, 2013)));

  // Other tabs, measures and totals are untouched.
  assert.equal(historicalRapeSeries("current", NAT, years(2010, 2024)), null);
  assert.equal(historicalRapeSeries("historical", NAT.replace("rape", "murder"), years(2010, 2024).map((r) => ({ year: r.year, murder: r.rape }))), null);
  assert.equal(historicalRapeSeries("historical", NAT.replace("rape", "rape_rate"), years(2010, 2024).map((r) => ({ year: r.year, rape_rate: r.rape }))), null);
  assert.equal(historicalRapeSeries("historical", "SELECT year, COALESCE(murder,0) + COALESCE(rape,0) + COALESCE(robbery,0) + COALESCE(aggravated_assault,0) AS violent_crime FROM historical_state_national WHERE state = 'United States' ORDER BY year", years(2010, 2024).map((r) => ({ year: r.year, violent_crime: r.rape }))), null);
  assert.equal(historicalRapeSeries("historical", "SELECT year, murder, rape FROM historical_state_national WHERE state = 'United States'", years(2010, 2024).map((r) => ({ year: r.year, murder: 1, rape: r.rape }))), null);
  assert.equal(historicalRapeSeries("historical", "SELECT year, rape_clr FROM historical_agency_clearance WHERE ori = 'X'", years(2010, 2024).map((r) => ({ year: r.year, rape_clr: 1 }))), null);
  assert.equal(historicalRapeSeries("historical", NAT, []), null);
  assert.equal(historicalRapeSeries("historical", null, years(2010, 2024)), null);

  // Missing values are named, never zero: a NULL cell and an absent year.
  {
    const rows = [{ year: 2010, agency: "Witness City", rape: 40 }, { year: 2011, agency: "Witness City", rape: null }, { year: 2013, agency: "Witness City", rape: 44 }];
    const r = historicalRapeSeries("historical", "SELECT hac.year, ha.agency, hac.rape FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE hac.ori = 'ZZ0000001'", rows);
    assert.ok(r);
    assert.deepEqual(r.missingYears, [2011, 2012]);
    assert.ok(r.narrative.startsWith("FBI UCR rape offenses for Witness City by year, 2010–2013."));
    assert.ok(r.narrative.includes("The returned results include no value for 2011 and 2012."));
    assert.equal(/\bzero\b|\b0\b/.test(r.narrative), false);
  }

  // A single named state.
  {
    const rows = years(2012, 2013).map((r) => ({ ...r, state: "Louisiana" }));
    const r = historicalRapeSeries("historical", "SELECT year, state, rape FROM historical_state_national WHERE state = 'Louisiana'", rows);
    assert.ok(r?.narrative.startsWith("FBI UCR rape offenses in Louisiana by year, 2012–2013."));
  }

  // Codex correction (:33700): the RETURNED measure must be established as the stored rape count. A rape mention in a
  // CTE, subquery, expression, alias or literal never relabels another returned measure.
  {
    const accept: [string, string[], string][] = [
      [NAT, ["year", "rape"], "rape"],
      [NAT + ";", ["year", "rape"], "rape"],
      ["SELECT n.year, n.rape FROM historical_state_national n WHERE n.state = 'United States'", ["year", "rape"], "rape"],
      ["SELECT year, rape AS rape_count FROM historical_state_national AS h WHERE state = 'United States'", ["year", "rape_count"], "rape_count"],
      [`SELECT "year", "rape" FROM historical_state_national WHERE state = 'Ohio'`, ["year", "rape"], "rape"],
      ["SELECT hac.year, ha.agency, hac.rape FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE hac.ori = 'X' ORDER BY hac.year LIMIT 100", ["year", "agency", "rape"], "rape"],
      ["SELECT year, rape FROM historical_state_national WHERE state = 'United States' -- select murder\n ORDER BY year",["year", "rape"], "rape"],
    ];
    for (const [sql, cols, want] of accept) assert.equal(returnedRapeCountColumn(sql, cols), want, sql);

    const reject: [string, string[]][] = [
      // The two Codex route regressions: an inner rape selection, an outer rate or murder result.
      ["WITH series AS (SELECT year, rape FROM historical_state_national WHERE state = 'United States') SELECT s.year, n.rape_rate FROM series s JOIN historical_state_national n ON n.year = s.year AND n.state = 'United States' WHERE s.year BETWEEN 2010 AND 2024 ORDER BY s.year", ["year", "rape_rate"]],
      ["WITH years AS (SELECT year, rape FROM historical_state_national WHERE state = 'United States') SELECT y.year, n.murder FROM years y JOIN historical_state_national n ON n.year = y.year AND n.state = 'United States' WHERE y.year BETWEEN 2010 AND 2024 ORDER BY y.year", ["year", "murder"]],
      // Transformed or aliased non-count output that still SAYS rape.
      ["SELECT year, rape * 100000.0 / population AS rape FROM historical_state_national WHERE state = 'United States'", ["year", "rape"]],
      ["SELECT year, ROUND(rape * 100000.0 / population, 1) AS rape_per_100k FROM historical_state_national", ["year", "rape_per_100k"]],
      ["SELECT year, rape_rate AS rape FROM historical_state_national WHERE state = 'United States'", ["year", "rape"]],
      ["SELECT year, murder AS rape FROM historical_state_national WHERE state = 'United States'", ["year", "rape"]],
      ["SELECT year, rape AS rape_rate FROM historical_state_national WHERE state = 'United States'", ["year", "rape_rate"]],
      ["SELECT year, rape AS pct_change FROM historical_state_national", ["year", "pct_change"]],
      ["SELECT year, SUM(rape) AS rape FROM historical_state_national WHERE state != 'United States' GROUP BY year", ["year", "rape"]],
      ["SELECT year, rape - LAG(rape) OVER (ORDER BY year) AS rape FROM historical_state_national", ["year", "rape"]],
      ["SELECT year, rape_clr AS rape FROM historical_agency_clearance WHERE ori = 'X'", ["year", "rape"]],
      ["SELECT year, rape FROM rtci_annual WHERE ori = 'X'", ["year", "rape"]],
      ["SELECT year, rape FROM historical_state_national WHERE year IN (SELECT year FROM historical_state_national WHERE murder > 0)", ["year", "rape"]],
      ["SELECT year, rape FROM historical_state_national UNION ALL SELECT year, murder FROM historical_state_national", ["year", "rape"]],
      ["SELECT DISTINCT year, rape FROM historical_state_national", ["year", "rape"]],
      ["SELECT * FROM historical_state_national WHERE state = 'United States'", ["year", "rape"]],
      ["SELECT year, 'rape' AS offense, murder FROM historical_state_national", ["year", "offense", "murder"]],
      ["SELECT year, rape, murder FROM historical_state_national", ["year", "rape", "murder"]],
      ["SELECT year, population, rape FROM historical_state_national", ["year", "population", "rape"]],
      ["SELECT rape FROM historical_state_national WHERE state = 'United States'", ["rape"]],
      ["SELECT n.year, n.rape FROM historical_state_national n JOIN historical_state_national m ON m.year = n.year", ["year", "rape"]],
      // The returned columns must be exactly the select list's output.
      [NAT, ["year", "rape_rate"]],
      [NAT, ["year", "rape", "extra"]],
    ];
    for (const [sql, cols] of reject) assert.equal(returnedRapeCountColumn(sql, cols), null, sql);

    // Through the public entry point: the two Codex shapes with rows that cross 2013 get nothing.
    assert.equal(historicalRapeSeries("historical", reject[0][0], years(2010, 2024).map((r) => ({ year: r.year, rape_rate: 26.1 }))), null);
    assert.equal(historicalRapeSeries("historical", reject[1][0], years(2010, 2024).map((r) => ({ year: r.year, murder: 15000 }))), null);
  }
}

console.log("result disclosure tests passed");
