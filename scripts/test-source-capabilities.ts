import assert from "node:assert/strict";
import { buildQueryContract, type QueryContractSource } from "../lib/query-contract";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import { validateSourceCapabilities } from "../lib/source-capabilities";

function findingIds(question: string, source: QueryContractSource, sql: string): string[] {
  const contract = buildQueryContract(question, source);
  assert(contract, `expected contract for ${question}`);
  return validateSourceCapabilities({ question, source, contract, sql }).map((finding) => finding.ruleId);
}

function assertFinds(name: string, ids: string[], expected: string) {
  assert(ids.includes(expected), `${name}: expected ${expected}, got ${JSON.stringify(ids)}`);
}

function assertDoesNotFind(name: string, ids: string[], unexpected: string) {
  assert(!ids.includes(unexpected), `${name}: did not expect ${unexpected}, got ${JSON.stringify(ids)}`);
}

{
  const ids = findingIds(
    "monthly aggravated assaults with a firearm in new york city",
    "nibrs",
    `SELECT s.year, s.month, SUM(s.victim_count) AS firearm_assaults
     FROM summary_victim_city_monthly s
     WHERE s.ucr_offense_code = '13A'
     GROUP BY s.year, s.month`
  );
  assertFinds("#6333 plain victim monthly table violates weapon contract", ids, "nibrs-weapon-person-crime-table");
}

{
  const ids = findingIds(
    "aggravated assaults with a firearm in new york city by year",
    "nibrs",
    `SELECT s.year, SUM(s.victim_count) AS firearm_assaults
     FROM summary_victim_weapon s
     WHERE s.ucr_offense_code = '13A'
       AND s.weapon_type IN ('11','11A','12','12A','13','13A','14','14A','15')
     GROUP BY s.year`
  );
  assertDoesNotFind("weapon-capable victim table satisfies weapon contract", ids, "nibrs-weapon-person-crime-table");
}

{
  const ids = findingIds(
    "How bad is aggravated assaults with a firearm in America? Is it getting better?",
    "nibrs",
    `SELECT year, SUM(victim_count) AS firearm_agg_assaults
     FROM summary_victim_demographics
     WHERE ucr_offense_code = '13A'
       AND weapon_category = 'Firearm'
       AND year BETWEEN 2021 AND 2025
     GROUP BY year`
  );
  assertFinds("#6369 weapon-only trend cannot use victim demographics", ids, "nibrs-weapon-person-crime-table");
}

{
  const ids = findingIds(
    "firearm aggravated assault victims by race in America since 2021",
    "nibrs",
    `SELECT year, race, SUM(victim_count) AS firearm_agg_assaults
     FROM summary_victim_demographics
     WHERE ucr_offense_code = '13A'
       AND weapon_category = 'Firearm'
       AND year BETWEEN 2021 AND 2025
     GROUP BY year, race`
  );
  assertDoesNotFind("weapon + demographic breakdown can use victim demographics", ids, "nibrs-weapon-person-crime-table");
  assertDoesNotFind("weapon + demographic breakdown satisfies demographic table contract", ids, "nibrs-weapon-demographic-person-crime-table");
}

{
  const ids = findingIds(
    "firearm aggravated assault victims by race in America since 2021",
    "nibrs",
    `SELECT year, race, SUM(victim_count) AS firearm_agg_assaults
     FROM summary_victim_weapon
     WHERE ucr_offense_code = '13A'
       AND weapon_type IN ('11','11A','12','12A','13','13A','14','14A','15','15A')
       AND year BETWEEN 2021 AND 2025
     GROUP BY year, race`
  );
  assertFinds("weapon + demographic breakdown cannot use weapon-only table", ids, "nibrs-weapon-demographic-person-crime-table");
}

{
  const ids = findingIds(
    "show me violent crime offenders by age for Tarrant County, Texas",
    "nibrs",
    `SELECT d.year, d.age_group, SUM(d.offender_count)
     FROM summary_offender_demographics d
     GROUP BY d.year, d.age_group`
  );
  assertFinds("countywide demographics are unsupported", ids, "nibrs-countywide-demographics-unsupported");
}

{
  const ids = findingIds(
    "show me violent crimes by offender age by year for 2021 to 2025 for continuously reporting agencies",
    "nibrs",
    `SELECT d.year, d.age_group, SUM(d.offender_count)
     FROM summary_offender_demographics d
     WHERE d.year BETWEEN 2021 AND 2025
     GROUP BY d.year, d.age_group`
  );
  assertFinds("continuous reporters require range table", ids, "nibrs-continuous-reporters-range-table");
}

{
  const ids = findingIds(
    "show me violent crimes by offender age by year for 2021 to 2025 for continuously reporting agencies",
    "nibrs",
    `SELECT d.year, d.age_group, SUM(d.offender_count)
     FROM summary_offender_demographics d
     WHERE d.year BETWEEN 2021 AND 2025
       AND d.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = 2021 AND end_year = 2025)
     GROUP BY d.year, d.age_group`
  );
  assertDoesNotFind("continuous reporter range table satisfies contract", ids, "nibrs-continuous-reporters-range-table");
}

{
  const ids = findingIds(
    "national murder clearance rate since 1960",
    "historical",
    `SELECT year, murder FROM historical_state_national WHERE state = 'United States'`
  );
  assertFinds("Historical clearance requires clearance table", ids, "historical-clearance-table");
}

{
  const ids = findingIds(
    "violent crime rate in California since 2008",
    "historical",
    `SELECT ha.state, SUM(hac.violent) * 100000.0 / SUM(hap.population)
     FROM historical_agency_crime hac
     JOIN historical_agency ha ON ha.ori = hac.ori
     JOIN historical_agency_population hap ON hap.ori = hac.ori AND hap.year = hac.year
     WHERE ha.state = 'ca'`
  );
  assertFinds("Historical state rates should use state/national table", ids, "historical-state-national-rate-table");
}

{
  const ids = findingIds(
    "violent crime rate in New York City since 1930",
    "historical",
    `SELECT hac.year, hac.violent_rate
     FROM historical_agency_crime hac
     JOIN historical_agency ha ON ha.ori = hac.ori
     WHERE ha.agency = 'New York' AND ha.state = 'ny'`
  );
  assertFinds("Historical local rates need population denominator", ids, "historical-local-rate-population");
}

{
  const ids = findingIds(
    "violent crime rate in New York City since 1930",
    "historical",
    `SELECT hac.year, hac.violent * 100000.0 / hap.population AS rate
     FROM historical_agency_crime hac
     JOIN historical_agency_population hap ON hap.ori = hac.ori AND hap.year = hac.year`
  );
  assertDoesNotFind("Historical local rate with population satisfies denominator contract", ids, "historical-local-rate-population");
}

{
  const ids = findingIds(
    "violent crime rate in New York City since 1930",
    "historical",
    `SELECT y.year,
       ROUND((COALESCE(hac.murder, 0) + COALESCE(hac.rape, 0)) * 100000.0 / COALESCE(hap.population, 1), 1) AS rate
     FROM years y
     LEFT JOIN historical_agency_crime hac ON hac.year = y.year
     LEFT JOIN historical_agency_population hap ON hap.ori = hac.ori AND hap.year = y.year`
  );
  assertFinds("Historical rate zero-fill violates null-gap contract", ids, "historical-rate-null-gaps");
}

{
  const ids = findingIds(
    "homicide rates by gender and race",
    "shr",
    `SELECT v.race, COUNT(*) * 100000.0 / 1 AS rate
     FROM incidents i JOIN victims v ON v.incident_id = i.id
     GROUP BY v.race`
  );
  assertFinds("SHR demographic rates are unsupported", ids, "shr-demographic-rate-unsupported");
}

{
  const ids = findingIds(
    "firearm homicide rate in Pennsylvania since 2020",
    "shr",
    `SELECT i.year, COUNT(*) * 100000.0 / AVG(i.population) AS rate
     FROM incidents i JOIN victims v ON v.incident_id = i.id
     WHERE i.state = 'PA'
     GROUP BY i.year`
  );
  assertFinds("SHR state rates need state_population", ids, "shr-state-rate-population");
}

{
  const ids = findingIds(
    "firearm homicide rate in Pennsylvania since 2020",
    "shr",
    `SELECT i.year, COUNT(*) * 100000.0 / sp.population AS rate
     FROM incidents i JOIN victims v ON v.incident_id = i.id
     JOIN state_population sp ON sp.state = i.state AND sp.year = i.year
     WHERE i.state = 'PA'
     GROUP BY i.year, sp.population`
  );
  assertDoesNotFind("SHR state rate with state_population satisfies contract", ids, "shr-state-rate-population");
}

{
  const ids = findingIds(
    "murder rate in Houston in 2026",
    "current",
    `SELECT year, month, SUM(count) AS murders
     FROM agency_monthly
     WHERE offense = 'Murder'
     GROUP BY year, month`
  );
  assertFinds("Current rates need agency_population", ids, "current-rate-population");
}

{
  const result = validateQueryContractSql({
    question: "monthly aggravated assaults with a firearm in new york city",
    source: "nibrs",
    sql: `SELECT year, month, SUM(victim_count) FROM summary_victim_city_monthly WHERE ucr_offense_code = '13A' GROUP BY year, month`,
  });
  assert(result.warnings.includes("capability-nibrs-weapon-person-crime-table"));
  assert.equal(result.capabilityFindings[0]?.ruleId, "nibrs-weapon-person-crime-table");
}

console.log("source capability tests passed");
