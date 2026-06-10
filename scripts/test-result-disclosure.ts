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

console.log("result disclosure tests passed");
