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
  expectFired?: string[];
  expectSqlIncludes?: string[];
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
    id: "L3-NIBRS-CAMPUS-02",
    family: "campus agency resolution",
    question: "University of California Berkeley vehicle burglaries per month",
    source: "nibrs",
    sql: `
      SELECT s.year, s.month, SUM(s.offense_count)
      FROM summary_city_monthly s
      WHERE s.ori IN ('CA0019700') AND s.ucr_offense_code = '220'
      GROUP BY s.year, s.month
    `,
    expectNoFindings: ["nibrs-campus-agency-resolution"],
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
    id: "L3-GEO-STATE-CODE-01",
    family: "source-specific state codes",
    question: "auto theft clearance rate in Omaha, NE by year",
    source: "historical",
    sql: `
      SELECT hac.year, SUM(hac.cleared_motor_vehicle_theft)
      FROM historical_agency_clearance hac
      JOIN historical_agency ha ON ha.ori = hac.ori
      WHERE ha.city = 'Omaha' AND ha.state = 'NE'
      GROUP BY hac.year
    `,
    expectFired: ["contract-state-code-alias"],
    expectSqlIncludes: ["ha.state = 'nb'"],
  },
  {
    id: "L3-GEO-STATE-CODE-02",
    family: "source-specific state codes",
    question: "Nebraska violent crime trend from 2010 to 2024",
    source: "nibrs",
    sql: `
      SELECT s.year, SUM(s.victim_count)
      FROM summary_victim_state_monthly s
      WHERE s.state = 'NE'
      GROUP BY s.year
    `,
    expectFired: ["contract-state-code-alias"],
    expectSqlIncludes: ["s.state IN ('NE','NB')"],
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
    source: "current",
    sql: `
      SELECT year, SUM(count)
      FROM agency_monthly
      WHERE agency = 'Cook County' AND type = 'County' AND state = 'IL'
      GROUP BY year
    `,
    expectFindings: ["current-countywide-crosswalk"],
    expectRetry: ["current-countywide-crosswalk"],
  },
  {
    id: "L3-GEO-COUNTY-03",
    family: "countywide crosswalk",
    question: "murders in Cook County Illinois by year",
    source: "nibrs",
    sql: `
      SELECT s.year, SUM(s.victim_count)
      FROM summary_victim_city_monthly s
      JOIN county_lookup cl ON cl.ori = s.ori
      WHERE cl.county_name = 'Cook County'
      GROUP BY s.year
    `,
    expectFindings: ["nibrs-countywide-crosswalk"],
    expectRetry: ["nibrs-countywide-crosswalk"],
  },
  {
    id: "L3-GEO-COUNTY-04",
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
    id: "L3-GEO-COUNTY-05",
    family: "countywide crosswalk",
    question: "fatal shootings in Cook County Illinois by year",
    source: "shr",
    sql: `
      SELECT i.year, COUNT(*)
      FROM incidents i
      WHERE i.agency = 'Cook County'
      GROUP BY i.year
    `,
    expectFindings: ["shr-countywide-crosswalk"],
    expectRetry: ["shr-countywide-crosswalk"],
  },
  {
    id: "L3-GEO-COUNTY-06",
    family: "unsupported countywide demographics",
    question: "show me violent crime offenders by age for Tarrant County, Texas",
    source: "nibrs",
    sql: `
      SELECT d.year, d.age_group, SUM(d.offender_count)
      FROM summary_offender_demographics d
      GROUP BY d.year, d.age_group
    `,
    expectFindings: ["nibrs-countywide-demographics-unsupported"],
    expectBlock: ["nibrs-countywide-demographics-unsupported"],
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
    id: "L3-GEO-LOCAL-STATE-TABLE-01",
    family: "local geography answered with state table",
    question: "Denver murder trend since 2000",
    source: "historical",
    sql: `
      SELECT year, murder
      FROM historical_state_national
      WHERE state = 'Colorado'
      ORDER BY year
    `,
    expectFindings: ["historical-local-geography-state-table"],
    expectRetry: ["historical-local-geography-state-table"],
  },
  {
    id: "L3-GEO-LOCAL-STATE-TABLE-02",
    family: "local geography answered with state table",
    question: "Maplewood New Jersey robberies since 2021",
    source: "nibrs",
    sql: `
      SELECT year, SUM(victim_count)
      FROM summary_victim_state_monthly
      WHERE state = 'NJ' AND ucr_offense_code = '120'
      GROUP BY year
    `,
    expectFindings: ["nibrs-local-geography-state-table"],
    expectRetry: ["nibrs-local-geography-state-table"],
  },
  {
    id: "L3-GEO-LOCAL-STATE-TABLE-03",
    family: "local geography answered with state table",
    question: "New Jersey robberies since 2021",
    source: "nibrs",
    sql: `
      SELECT year, SUM(victim_count)
      FROM summary_victim_state_monthly
      WHERE state = 'NJ' AND ucr_offense_code = '120'
      GROUP BY year
    `,
    expectNoFindings: ["nibrs-local-geography-state-table"],
  },
  {
    id: "L3-GEO-LOCAL-STATE-TABLE-04",
    family: "local geography answered with state table",
    question: "compare Denver murders to Colorado murders since 2000",
    source: "historical",
    sql: `
      SELECT local.year, local.murders AS denver_murders, state.murder AS colorado_murders
      FROM (
        SELECT hac.year, SUM(hac.murder) AS murders
        FROM historical_agency_crime hac
        JOIN historical_agency ha ON ha.ori = hac.ori
        WHERE ha.agency = 'Denver' AND ha.state = 'co'
        GROUP BY hac.year
      ) local
      JOIN historical_state_national state ON state.year = local.year AND state.state = 'Colorado'
    `,
    expectNoFindings: ["historical-local-geography-state-table"],
  },
  {
    id: "L3-GEO-LOCAL-STATE-TABLE-05",
    family: "local geography answered with state table",
    question: "compare Maplewood robberies to New Jersey robberies since 2021",
    source: "nibrs",
    sql: `
      SELECT city.year, city.robberies AS maplewood_robberies, state.robberies AS new_jersey_robberies
      FROM (
        SELECT s.year, SUM(s.victim_count) AS robberies
        FROM summary_victim_city_monthly s
        JOIN agencies a ON a.ori = s.ori AND a.year = s.year
        WHERE a.city = 'MAPLEWOOD' AND a.state = 'NJ' AND s.ucr_offense_code = '120'
        GROUP BY s.year
      ) city
      JOIN (
        SELECT year, SUM(victim_count) AS robberies
        FROM summary_victim_state_monthly
        WHERE state = 'NJ' AND ucr_offense_code = '120'
        GROUP BY year
      ) state ON state.year = city.year
    `,
    expectNoFindings: ["nibrs-local-geography-state-table"],
  },
  {
    id: "L3-GEO-PARISH-01",
    family: "parish type",
    question: "murders in Jefferson Parish Louisiana by year",
    source: "historical",
    sql: `
      SELECT hac.year, SUM(hac.murder)
      FROM historical_agency_crime hac
      JOIN historical_agency ha ON ha.ori = hac.ori
      WHERE ha.agency = 'Jefferson Parish' AND ha.type = 'city' AND ha.state = 'la'
      GROUP BY hac.year
    `,
    expectFindings: ["historical-parish-type-city"],
    expectRetry: ["historical-parish-type-city"],
  },
  {
    id: "L3-GEO-PARISH-02",
    family: "parish type",
    question: "compare New Orleans city and Jefferson Parish murders by year",
    source: "historical",
    sql: `
      SELECT hac.year, ha.agency, SUM(hac.murder)
      FROM historical_agency_crime hac
      JOIN historical_agency ha ON ha.ori = hac.ori
      WHERE (ha.agency = 'New Orleans' AND ha.type = 'city' AND ha.state = 'la')
         OR (ha.agency = 'Jefferson Parish' AND ha.type = 'county' AND ha.state = 'la')
      GROUP BY hac.year, ha.agency
    `,
    expectNoFindings: ["historical-parish-type-city"],
  },
  {
    id: "L3-AGENCY-LOOKUP-01",
    family: "agency lookup instead of crime data",
    question: "robberies in Maplewood New Jersey since 2020",
    source: "nibrs",
    sql: `
      SELECT agency_name, state, ori
      FROM agencies
      WHERE city = 'MAPLEWOOD' AND state = 'NJ'
    `,
    expectFindings: ["nibrs-agency-lookup-not-crime-data"],
    expectRetry: ["nibrs-agency-lookup-not-crime-data"],
  },
  {
    id: "L3-AGENCY-LOOKUP-02",
    family: "agency lookup instead of crime data",
    question: "murders in Denver since 2000",
    source: "historical",
    sql: `
      SELECT agency, state, ori
      FROM historical_agency
      WHERE agency = 'Denver' AND state = 'co'
    `,
    expectFindings: ["historical-agency-lookup-not-crime-data"],
    expectRetry: ["historical-agency-lookup-not-crime-data"],
  },
  {
    id: "L3-AGENCY-LOOKUP-03",
    family: "agency lookup instead of crime data",
    question: "which agencies are included in Maplewood New Jersey?",
    source: "nibrs",
    sql: `
      SELECT agency_name, state, ori
      FROM agencies
      WHERE city = 'MAPLEWOOD' AND state = 'NJ'
    `,
    expectNoFindings: ["nibrs-agency-lookup-not-crime-data"],
  },
  {
    id: "L3-NIBRS-COMPARABILITY-01",
    family: "continuous reporters",
    question: "show me violent crimes by offender age by year for 2021 to 2025 for continuously reporting agencies",
    source: "nibrs",
    sql: `
      SELECT d.year, d.age_group, SUM(d.offender_count)
      FROM summary_offender_demographics d
      WHERE d.year BETWEEN 2021 AND 2025
      GROUP BY d.year, d.age_group
    `,
    expectFindings: ["nibrs-continuous-reporters-range-table"],
    expectRetry: ["nibrs-continuous-reporters-range-table"],
  },
  {
    id: "L3-NIBRS-COMPARABILITY-02",
    family: "continuous reporters",
    question: "show me violent crimes by offender age by year for 2021 to 2025 for continuously reporting agencies",
    source: "nibrs",
    sql: `
      SELECT d.year, d.age_group, SUM(d.offender_count)
      FROM summary_offender_demographics d
      WHERE d.year BETWEEN 2021 AND 2025
        AND d.ori IN (
          SELECT ori FROM nibrs_consistent_reporters
          WHERE start_year = 2021 AND end_year = 2025
        )
      GROUP BY d.year, d.age_group
    `,
    expectNoFindings: ["nibrs-continuous-reporters-range-table"],
  },
  {
    id: "L3-NIBRS-DEMOGRAPHICS-01",
    family: "demographic breakdown table",
    question: "offender age breakdown for robberies since 2020",
    source: "nibrs",
    sql: `
      SELECT year, SUM(offense_count) AS robberies
      FROM summary_city_monthly
      WHERE ucr_offense_code = '120'
      GROUP BY year
    `,
    expectFindings: ["nibrs-demographic-breakdown-table"],
    expectRetry: ["nibrs-demographic-breakdown-table"],
  },
  {
    id: "L3-NIBRS-DEMOGRAPHICS-02",
    family: "weapon demographic breakdown table",
    question: "firearm aggravated assault victims by race in America since 2021",
    source: "nibrs",
    sql: `
      SELECT year, race, SUM(victim_count) AS firearm_agg_assaults
      FROM summary_victim_weapon
      WHERE ucr_offense_code = '13A'
        AND weapon_category = 'Firearm'
      GROUP BY year, race
    `,
    expectFindings: ["nibrs-weapon-demographic-person-crime-table"],
    expectRetry: ["nibrs-weapon-demographic-person-crime-table"],
  },
  {
    id: "L3-NIBRS-CIRCUMSTANCE-01",
    family: "weapon circumstance table",
    question: "domestic violence aggravated assaults with a firearm since 2020",
    source: "nibrs",
    sql: `
      SELECT year, SUM(victim_count) AS firearm_agg_assaults
      FROM summary_victim_weapon
      WHERE ucr_offense_code = '13A'
        AND weapon_category = 'Firearm'
      GROUP BY year
    `,
    expectFindings: ["nibrs-weapon-circumstance-person-crime-table"],
    expectRetry: ["nibrs-weapon-circumstance-person-crime-table"],
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
    id: "L3-RATE-02",
    family: "rate denominators",
    question: "violent crime rate in California since 2008",
    source: "historical",
    sql: `
      SELECT ha.state, SUM(hac.violent) * 100000.0 / SUM(hap.population) AS rate
      FROM historical_agency_crime hac
      JOIN historical_agency ha ON ha.ori = hac.ori
      JOIN historical_agency_population hap ON hap.ori = hac.ori AND hap.year = hac.year
      WHERE ha.state = 'ca'
    `,
    expectFindings: ["historical-state-national-rate-table"],
    expectRetry: ["historical-state-national-rate-table"],
  },
  {
    id: "L3-RATE-03",
    family: "rate denominators",
    question: "violent crime rate in New York City since 1930",
    source: "historical",
    sql: `
      SELECT hac.year, hac.violent * 100000.0 / hap.population AS rate
      FROM historical_agency_crime hac
      JOIN historical_agency_population hap ON hap.ori = hac.ori AND hap.year = hac.year
      WHERE hac.year >= 1930
    `,
    expectNoFindings: ["historical-local-rate-population"],
  },
  {
    id: "L3-RATE-04",
    family: "rate denominators",
    question: "violent crime rate in New York City since 1930",
    source: "historical",
    sql: `
      SELECT y.year,
        ROUND((COALESCE(hac.murder, 0) + COALESCE(hac.rape, 0)) * 100000.0 / COALESCE(hap.population, 1), 1) AS rate
      FROM years y
      LEFT JOIN historical_agency_crime hac ON hac.year = y.year
      LEFT JOIN historical_agency_population hap ON hap.ori = hac.ori AND hap.year = y.year
    `,
    expectFindings: ["historical-rate-null-gaps"],
    expectRetry: ["historical-rate-null-gaps"],
  },
  {
    id: "L3-RATE-05",
    family: "rate denominators",
    question: "murder rate in Houston in 2026",
    source: "current",
    sql: `
      SELECT year, month, SUM(count) AS murders
      FROM agency_monthly
      WHERE offense = 'Murder'
      GROUP BY year, month
    `,
    expectFindings: ["current-rate-population"],
    expectRetry: ["current-rate-population"],
  },
  {
    id: "L3-HISTORICAL-CLEARANCE-01",
    family: "historical clearance table",
    question: "auto theft clearance rate in Omaha, NE by year",
    source: "historical",
    sql: `
      SELECT hac.year, SUM(hac.motor_vehicle_theft) AS auto_thefts
      FROM historical_agency_crime hac
      JOIN historical_agency ha ON ha.ori = hac.ori
      WHERE ha.city = 'Omaha' AND ha.state = 'NE'
      GROUP BY hac.year
    `,
    expectFindings: ["historical-clearance-table"],
    expectRetry: ["historical-clearance-table"],
    expectFired: ["contract-state-code-alias"],
    expectSqlIncludes: ["ha.state = 'nb'"],
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
  {
    id: "L3-UNSUPPORTED-02",
    family: "unsupported SHR topic",
    question: "robbery numbers in Houston since 2018",
    source: "shr",
    sql: `
      SELECT i.year, COUNT(*)
      FROM incidents i JOIN victims v ON v.incident_id = i.id
      WHERE i.agency = 'Houston'
      GROUP BY i.year
    `,
    expectFindings: ["shr-non-homicide-unsupported"],
    expectBlock: ["shr-non-homicide-unsupported"],
  },
  {
    id: "L3-UNSUPPORTED-03",
    family: "unsupported SHR topic",
    question: "robbery-related homicides in Houston since 2018",
    source: "shr",
    sql: `
      SELECT i.year, COUNT(*)
      FROM incidents i JOIN victims v ON v.incident_id = i.id
      WHERE i.agency = 'Houston'
      GROUP BY i.year
    `,
    expectNoFindings: ["shr-non-homicide-unsupported"],
  },
  {
    id: "L3-UNSUPPORTED-04",
    family: "unsupported SHR clearance",
    question: "murder clearance rate in Detroit since 2010",
    source: "shr",
    sql: `
      SELECT i.year, COUNT(*)
      FROM incidents i JOIN victims v ON v.incident_id = i.id
      WHERE i.agency = 'Detroit'
      GROUP BY i.year
    `,
    expectFindings: ["shr-clearance-unsupported"],
    expectBlock: ["shr-clearance-unsupported"],
  },
  {
    id: "L3-UNSUPPORTED-05",
    family: "unsupported NIBRS drug type",
    question: "marijuana possession arrests in Texas since 2020",
    source: "nibrs",
    sql: `
      SELECT year, SUM(arrestee_count)
      FROM summary_arrestee_demographics
      WHERE ucr_arrest_offense_code = '35A'
      GROUP BY year
    `,
    expectFindings: ["nibrs-specific-drug-unsupported"],
    expectBlock: ["nibrs-specific-drug-unsupported"],
  },
  {
    id: "L3-UNSUPPORTED-06",
    family: "unsupported NIBRS drug type",
    question: "drug arrests in Texas since 2020",
    source: "nibrs",
    sql: `
      SELECT year, SUM(arrestee_count)
      FROM summary_arrestee_demographics
      WHERE ucr_arrest_offense_code = '35A'
      GROUP BY year
    `,
    expectNoFindings: ["nibrs-specific-drug-unsupported"],
  },
  {
    id: "L3-UNSUPPORTED-07",
    family: "unsupported NIBRS shooting category",
    question: "show me shooting data over the last 10 years",
    source: "nibrs",
    sql: `
      SELECT year, SUM(victim_count)
      FROM summary_victim_state_monthly
      WHERE ucr_offense_code = '13A'
      GROUP BY year
    `,
    expectFindings: ["nibrs-shooting-category-unsupported"],
    expectBlock: ["nibrs-shooting-category-unsupported"],
  },
  {
    id: "L3-UNSUPPORTED-08",
    family: "unsupported NIBRS shooting category",
    question: "aggravated assaults with a firearm over the last 10 years",
    source: "nibrs",
    sql: `
      SELECT year, SUM(victim_count)
      FROM summary_victim_weapon
      WHERE ucr_offense_code = '13A' AND weapon_category = 'Firearm'
      GROUP BY year
    `,
    expectNoFindings: ["nibrs-shooting-category-unsupported"],
  },
  {
    id: "L3-UNSUPPORTED-09",
    family: "unsupported geography",
    question: "murders by zip code in Chicago",
    source: "historical",
    sql: `
      SELECT hac.year, SUM(hac.murder)
      FROM historical_agency_crime hac
      GROUP BY hac.year
    `,
    expectFindings: ["unsupported-sub-city-geography"],
    expectBlock: ["unsupported-sub-city-geography"],
  },
  {
    id: "L3-UNSUPPORTED-10",
    family: "unsupported court or policy topic",
    question: "how many robbery defendants were convicted in Chicago",
    source: "historical",
    sql: `
      SELECT hac.year, SUM(hac.robbery)
      FROM historical_agency_crime hac
      GROUP BY hac.year
    `,
    expectFindings: ["unsupported-court-policy-topic"],
    expectBlock: ["unsupported-court-policy-topic"],
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

  for (const expected of testCase.expectFired ?? []) {
    assert(
      result.fired.includes(expected),
      `${testCase.id}: expected fired contract action ${expected}, got ${JSON.stringify(result.fired)}`
    );
  }

  for (const expected of testCase.expectSqlIncludes ?? []) {
    assert(
      result.sql.includes(expected),
      `${testCase.id}: expected rewritten SQL to include ${expected}, got ${result.sql}`
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
