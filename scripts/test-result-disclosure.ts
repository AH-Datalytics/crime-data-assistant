import assert from "node:assert/strict";
import { applyResultDisclosures } from "../lib/result-disclosure";

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
  assert.match(explanation, /Returned period: January-May 2026\./);
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

console.log("result disclosure tests passed");
