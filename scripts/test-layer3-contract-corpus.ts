import assert from "node:assert/strict";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import type { QueryContractSource } from "../lib/query-contract";

type CorpusCase = {
  id: string;
  family: string;
  question: string;
  source: QueryContractSource;
  sql: string;
  expectFindings?: string[];
  expectWarnings?: string[];
  expectNoFindings?: string[];
  expectRetry?: string[];
  expectBlock?: string[];
};

const cases: CorpusCase[] = [
  {
    id: "L3-NIBRS-WEAPON-01",
    family: "nibrs weapon-qualified person crime",
    question: "aggravated assaults with a firearm in 2025",
    source: "nibrs",
    sql: `
      SELECT year, SUM(victim_count) AS assaults
      FROM summary_victim_city_monthly
      WHERE ucr_offense_code = '13A' AND year = 2025
      GROUP BY year
    `,
    expectFindings: ["nibrs-weapon-person-crime-table"],
    expectRetry: ["nibrs-weapon-person-crime-table"],
  },
  {
    id: "L3-NIBRS-WEAPON-02",
    family: "nibrs weapon-qualified person crime",
    question: "aggravated assaults with a firearm in 2025",
    source: "nibrs",
    sql: `
      SELECT year, SUM(victim_count) AS assaults
      FROM summary_victim_weapon
      WHERE ucr_offense_code = '13A' AND weapon_category = 'Firearm' AND year = 2025
      GROUP BY year
    `,
    expectNoFindings: ["nibrs-weapon-person-crime-table"],
  },
  {
    id: "L3-NIBRS-CLEARANCE-01",
    family: "nibrs clearance",
    question: "cleared by arrest vs exceptional means for robbery in Chicago",
    source: "nibrs",
    sql: `
      SELECT year, SUM(cleared_count) AS cleared
      FROM summary_city_monthly
      WHERE ucr_offense_code = '120'
      GROUP BY year
    `,
    expectFindings: ["nibrs-clearance-type-table"],
    expectRetry: ["nibrs-clearance-type-table"],
  },
  {
    id: "L3-NIBRS-CLEARANCE-02",
    family: "nibrs unsupported metric combination",
    question: "firearm murder clearance rate in Chicago",
    source: "nibrs",
    sql: `
      SELECT year, SUM(cleared_count) * 100.0 / SUM(victim_count) AS clearance_rate
      FROM summary_victim_weapon
      WHERE ucr_offense_code = '09A' AND weapon_category = 'Firearm'
      GROUP BY year
    `,
    expectFindings: ["nibrs-clearance-weapon-unsupported"],
    expectBlock: ["nibrs-clearance-weapon-unsupported"],
  },
  {
    id: "L3-NIBRS-CARJACKING-01",
    family: "nibrs carjacking clearance",
    question: "carjacking clearance rates in Chicago",
    source: "nibrs",
    sql: `
      SELECT year, SUM(total_cleared) * 100.0 / SUM(total_offenses) AS clearance_rate
      FROM summary_clearance_city_annual
      WHERE city = 'CHICAGO'
      GROUP BY year
    `,
    expectFindings: ["nibrs-carjacking-clearance-table"],
    expectRetry: ["nibrs-carjacking-clearance-table"],
  },
  {
    id: "L3-NIBRS-CAMPUS-01",
    family: "campus agency resolution",
    question: "University of California Berkeley vehicle burglaries per month",
    source: "nibrs",
    sql: `
      SELECT year, month, SUM(offense_count)
      FROM summary_city_monthly
      WHERE city = 'BERKELEY' AND ucr_offense_code = '220'
      GROUP BY year, month
    `,
    expectFindings: ["nibrs-campus-agency-resolution"],
    expectRetry: ["nibrs-campus-agency-resolution"],
  },
  {
    id: "L3-SHR-CAMPUS-01",
    family: "campus agency resolution",
    question: "UCLA murders since 2000",
    source: "shr",
    sql: `
      SELECT i.year, COUNT(*)
      FROM incidents i
      WHERE i.agency = 'Los Angeles'
      GROUP BY i.year
    `,
    expectFindings: ["shr-campus-agency-resolution"],
    expectRetry: ["shr-campus-agency-resolution"],
  },
  {
    id: "L3-GEO-COUNTY-01",
    family: "countywide crosswalk",
    question: "murders in Cook County Illinois by year",
    source: "historical",
    sql: `
      SELECT hac.year, SUM(hac.murder)
      FROM historical_agency_crime hac
      JOIN historical_agency ha ON ha.ori = hac.ori
      WHERE ha.agency = 'Cook County' AND ha.type = 'county' AND ha.state = 'il'
      GROUP BY hac.year
    `,
    expectFindings: ["historical-countywide-crosswalk"],
    expectRetry: ["historical-countywide-crosswalk"],
  },
  {
    id: "L3-GEO-COUNTY-02",
    family: "countywide crosswalk",
    question: "murders in Cook County Illinois by year",
    source: "nibrs",
    sql: `
      SELECT s.year, SUM(s.victim_count)
      FROM summary_victim_city_monthly s
      JOIN agency_county_crosswalk ac ON s.ori = ac.ori9 OR substr(s.ori, 1, 7) = ac.ori
      WHERE ac.county_key = 'COOK' AND ac.state = 'IL'
      GROUP BY s.year
    `,
    expectNoFindings: ["nibrs-countywide-crosswalk"],
  },
  {
    id: "L3-GEO-STATE-01",
    family: "state-vs-local scope",
    question: "gun violence in New York State since 2022",
    source: "shr",
    sql: `
      SELECT i.year, COUNT(*)
      FROM incidents i
      WHERE i.agency = 'New York' AND i.state = 'NY'
      GROUP BY i.year
    `,
    expectWarnings: ["contract-state-scope-local-filter"],
    expectRetry: ["contract-state-scope-local-filter"],
  },
  {
    id: "L3-RATE-01",
    family: "rate denominators",
    question: "violent crime rate in New York City since 1930",
    source: "historical",
    sql: `
      SELECT hac.year, hac.violent_rate
      FROM historical_agency_crime hac
      JOIN historical_agency ha ON ha.ori = hac.ori
      WHERE ha.agency = 'New York' AND ha.state = 'ny'
    `,
    expectFindings: ["historical-local-rate-population"],
    expectRetry: ["historical-local-rate-population"],
  },
  {
    id: "L3-SHR-RATE-01",
    family: "rate denominators",
    question: "firearm homicide rate in Pennsylvania since 2020",
    source: "shr",
    sql: `
      SELECT i.year, COUNT(*) * 100000.0 / AVG(i.population) AS rate
      FROM incidents i JOIN victims v ON v.incident_id = i.id
      WHERE i.state = 'PA'
      GROUP BY i.year
    `,
    expectFindings: ["shr-state-rate-population"],
    expectRetry: ["shr-state-rate-population"],
  },
  {
    id: "L3-UNSUPPORTED-01",
    family: "unsupported demographic rates",
    question: "homicide rates by gender and race",
    source: "shr",
    sql: `
      SELECT v.sex, v.race, COUNT(*) * 100000.0 / 1 AS rate
      FROM incidents i JOIN victims v ON v.incident_id = i.id
      GROUP BY v.sex, v.race
    `,
    expectFindings: ["shr-demographic-rate-unsupported"],
    expectBlock: ["shr-demographic-rate-unsupported"],
  },
];

const familyCounts = new Map<string, number>();

for (const testCase of cases) {
  const result = validateQueryContractSql({
    question: testCase.question,
    source: testCase.source,
    sql: testCase.sql,
  });
  const findingIds = result.capabilityFindings.map((finding) => finding.ruleId);

  for (const expected of testCase.expectFindings ?? []) {
    assert(
      findingIds.includes(expected),
      `${testCase.id}: expected finding ${expected}, got ${JSON.stringify(findingIds)}`
    );
  }

  for (const expected of testCase.expectNoFindings ?? []) {
    assert(
      !findingIds.includes(expected),
      `${testCase.id}: did not expect finding ${expected}, got ${JSON.stringify(findingIds)}`
    );
  }

  for (const expected of testCase.expectWarnings ?? []) {
    assert(
      result.warnings.includes(expected),
      `${testCase.id}: expected warning ${expected}, got ${JSON.stringify(result.warnings)}`
    );
  }

  for (const expected of testCase.expectRetry ?? []) {
    assert(
      result.enforced.includes(expected) && result.retryIssues.some((issue) => issue.includes(expected)),
      `${testCase.id}: expected retry enforcement ${expected}, got enforced=${JSON.stringify(result.enforced)} retryIssues=${JSON.stringify(result.retryIssues)}`
    );
  }

  for (const expected of testCase.expectBlock ?? []) {
    assert(
      result.enforced.includes(expected) && result.blockReasons.length > 0,
      `${testCase.id}: expected block enforcement ${expected}, got enforced=${JSON.stringify(result.enforced)} blockReasons=${JSON.stringify(result.blockReasons)}`
    );
  }

  familyCounts.set(testCase.family, (familyCounts.get(testCase.family) ?? 0) + 1);
}

console.log(`layer 3 contract corpus passed: ${cases.length} cases across ${familyCounts.size} families`);
