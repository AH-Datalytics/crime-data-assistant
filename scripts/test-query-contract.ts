import assert from "node:assert/strict";
import { buildQueryContract, serializeQueryContractLogMeta } from "../lib/query-contract";
import { validateQueryContractSql } from "../lib/query-contract-validator";

{
  const contract = buildQueryContract("Omaha NE auto theft clearance rate since 1960", "historical");
  assert(contract);
  assert.equal(contract.source, "historical");
  assert.equal(contract.geography.kind, "city");
  assert.equal(contract.geography.name, "Omaha");
  assert.equal(contract.geography.state, "NE");
  assert.equal(contract.geography.sourceCodes?.historical, "nb");
  assert.equal(contract.metric.unit, "clearance_rate");
  assert.equal(contract.time.startYear, 1960);
}

{
  const contract = buildQueryContract("Omaha NE burglaries from 2000 to 2026", "nibrs");
  assert(contract);
  assert.deepEqual(contract.geography.sourceCodes?.nibrs, ["NE", "NB"]);
}

{
  const contract = buildQueryContract(
    "what 12 agencies are included in this",
    "current",
    { mode: "follow_up", confidence: null, reason: "Follow-up inherited prior source context" }
  );
  assert(contract);
  assert.equal(contract.followup.isFollowup, true);
  assert.equal(contract.followup.operation, "metadata");
}

{
  const contract = buildQueryContract("Compare domestic violence and violent crime trends from 2021 to 2025", "nibrs");
  assert(contract);
  assert.equal(contract.metric.topic, "domestic_violence");
  assert.equal(contract.metric.unit, "count");
  assert.equal(contract.time.startYear, 2021);
  assert.equal(contract.time.endYear, 2025);
  assert(contract.breakdowns.includes("year"));
}

{
  const contract = buildQueryContract("intimate partner violence trend since 2021", "nibrs");
  assert(contract);
  assert.equal(contract.metric.topic, "domestic_violence");
  assert.equal(contract.time.startYear, 2021);
}

{
  const contract = buildQueryContract("homicide rates by gender and race", "shr");
  assert(contract);
  assert.equal(contract.metric.topic, "murder");
  assert.equal(contract.metric.unit, "rate_per_100k");
  assert.equal(contract.metric.unsupportedReason, "demographic_rate_denominator_unavailable");
  assert(contract.warnings.includes("demographic_rate_denominator_unavailable"));
  assert(contract.breakdowns.includes("race"));
  assert(contract.breakdowns.includes("sex"));
}

{
  const contract = buildQueryContract("University of California Berkeley vehicle burglaries per month", "nibrs");
  assert(contract);
  assert.equal(contract.geography.kind, "campus");
}

{
  const contract = buildQueryContract("show murders by offender age from continuously reporting agencies from 2018 to 2025", "nibrs");
  assert(contract);
  assert.equal(contract.comparability.continuousReporters, true);
  assert(contract.warnings.includes("continuous_reporters_required"));
  assert(contract.breakdowns.includes("age_group"));
}

{
  const contract = buildQueryContract(
    "show me murders, aggravated assaults, and robberies for albuquerque police department by year for 2020 to 2025",
    "nibrs"
  );
  assert(contract);
  assert.deepEqual(contract.breakdowns, ["year"]);
}

{
  const contract = buildQueryContract("start the Y-axis at 60%", "current", { mode: "follow_up", confidence: null, reason: null });
  assert(contract);
  assert.equal(contract.followup.operation, "chart_only");
}

{
  const contract = buildQueryContract("How bad is aggravated assaults with a firearm in America? Is it getting better?", "nibrs");
  assert(contract);
  assert.equal(contract.followup.isFollowup, false);
  assert.equal(contract.followup.operation, null);
  assert.equal(contract.metric.topic, "aggravated_assault");
  assert.deepEqual(contract.metric.offenseCodes, ["13A"]);
  assert.equal(contract.metric.unit, "count");
  assert.equal(contract.geography.kind, "national");
}

{
  const contract = buildQueryContract("Can I see murders rolling over 12 months nationally, 2018 to present?", "current");
  assert(contract);
  assert.equal(contract.time.startYear, 2018);
  assert.equal(contract.time.endYear, null);
}
{
  const serialized = serializeQueryContractLogMeta("New York State fatal shootings in 2026", "shr");
  assert(serialized);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.source, "shr");
  assert.equal(parsed.geography.kind, "state");
  assert.equal(parsed.geography.state, "NY");
  assert.equal(parsed.time.partialYear, true);
  assert(parsed.warnings.includes("partial_year_disclosure_required"));
}

{
  const result = validateQueryContractSql({
    question: "Omaha NE auto theft clearance rate since 1960",
    source: "historical",
    sql: "SELECT hac.year, hac.auto_theft_clearance_rate FROM historical_agency_clearance hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Omaha' AND ha.state = 'ne'",
  });
  assert(result.fired.includes("contract-state-code-alias"));
  assert.match(result.sql, /ha\.state = 'nb'/);
}

{
  const result = validateQueryContractSql({
    question: "Omaha NE burglaries from 2000 to 2026",
    source: "nibrs",
    sql: "SELECT data_year, SUM(victim_count) FROM summary_city_monthly scm JOIN agencies a ON a.ori = scm.ori WHERE a.city = 'OMAHA' AND a.state = 'NE' GROUP BY data_year",
  });
  assert(result.fired.includes("contract-state-code-alias"));
  assert.match(result.sql, /a\.state IN \('NE','NB'\)/);
}

{
  const result = validateQueryContractSql({
    question: "Omaha NE burglaries from 2000 to 2026",
    source: "nibrs",
    sql: "SELECT s.year, SUM(s.offense_count) FROM summary_city_monthly s WHERE s.city = 'OMAHA' AND s.state = 'NB' GROUP BY s.year",
  });
  assert(result.fired.includes("contract-state-code-alias"));
  assert.match(result.sql, /s\.state IN \('NE','NB'\)/);
}

{
  const result = validateQueryContractSql({
    question: "Houston TX murders since 2020",
    source: "historical",
    sql: "SELECT hac.year, hac.murder FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Houston' AND ha.state = 'TX'",
  });
  assert.deepEqual(result.fired, []);
  assert.equal(result.sql.includes("ha.state = 'TX'"), true);
}

{
  const contract = buildQueryContract("baltimore city homicides in first 6 months of each year", "shr");
  assert(contract);
  assert.equal(contract.geography.kind, "city");
  assert.equal(contract.geography.name, "Baltimore");
  assert.equal(contract.geography.state, "MD");
}

{
  const result = validateQueryContractSql({
    question: "baltimore city homicides in first 6 months of each year",
    source: "shr",
    sql: "SELECT i.year, COUNT(*) FROM incidents i WHERE i.ori IN (SELECT ori FROM shr_agency_alias WHERE state = 'MD' AND alias_key LIKE '%BALTIMORE%CITY%') GROUP BY i.year",
  });
  assert(result.fired.includes("contract-city-jurisdiction-suffix"));
  assert.match(result.sql, /alias_key = 'BALTIMORE'/);
  assert.doesNotMatch(result.sql, /BALTIMORE%CITY/i);
}

{
  const result = validateQueryContractSql({
    question: "baltimore city homicides in first 6 months of each year",
    source: "shr",
    sql: "SELECT i.year, COUNT(*) FROM incidents i WHERE i.ori IN (SELECT ori FROM shr_agency_alias WHERE state = 'MD' AND alias_key LIKE '%BALTIMORE CITY%') GROUP BY i.year",
  });
  assert(result.fired.includes("contract-city-jurisdiction-suffix"));
  assert.match(result.sql, /alias_key = 'BALTIMORE'/);
  assert.doesNotMatch(result.sql, /BALTIMORE CITY/i);
}

{
  const result = validateQueryContractSql({
    question: "Richmond city murders by year",
    source: "historical",
    sql: "SELECT year, murder FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Richmond City' AND ha.state = 'VA'",
  });
  assert(result.fired.includes("contract-city-jurisdiction-suffix"));
  assert.match(result.sql, /ha\.agency = 'Richmond'/);
  assert.doesNotMatch(result.sql, /Richmond City/);
}

for (const aliasSql of [
  "SELECT * FROM incidents i WHERE i.ori IN (SELECT ori FROM shr_agency_alias WHERE state = 'MO' AND alias_key LIKE '%ST. LOUIS CITY%')",
  "SELECT * FROM incidents i WHERE i.ori IN (SELECT ori FROM shr_agency_alias WHERE state = 'MO' AND alias_key LIKE '%ST LOUIS CITY%')",
  "SELECT * FROM incidents i WHERE i.ori IN (SELECT ori FROM shr_agency_alias WHERE state = 'MO' AND alias_key LIKE '%SAINT LOUIS CITY%')",
  "SELECT * FROM incidents i WHERE i.ori IN (SELECT ori FROM shr_agency_alias WHERE state = 'MO' AND alias_key = 'SAINT LOUIS CITY')",
]) {
  const result = validateQueryContractSql({
    question: "st louis city murders",
    source: "shr",
    sql: aliasSql,
  });
  assert(result.fired.includes("contract-city-jurisdiction-suffix"));
  assert.match(result.sql, /alias_key = 'ST LOUIS'/);
  assert.doesNotMatch(result.sql, /LOUIS CITY/i);
}

{
  const result = validateQueryContractSql({
    question: "Fairfax city assaults",
    source: "nibrs",
    sql: "SELECT data_year, SUM(offense_count) FROM summary_city_monthly scm JOIN agencies a ON a.ori = scm.ori WHERE a.city = 'FAIRFAX CITY' AND a.state = 'VA' GROUP BY data_year",
  });
  assert(result.fired.includes("contract-city-jurisdiction-suffix"));
  assert.match(result.sql, /a\.city = 'FAIRFAX'/);
  assert.doesNotMatch(result.sql, /FAIRFAX CITY/);
}

{
  const result = validateQueryContractSql({
    question: "Kansas City Missouri murders",
    source: "current",
    sql: "SELECT year, SUM(murders) FROM agency_monthly WHERE agency = 'Kansas City' AND state = 'MO' GROUP BY year",
  });
  assert.deepEqual(result.fired, []);
  assert.match(result.sql, /Kansas City/);
}

{
  const result = validateQueryContractSql({
    question: "gun violence in New York State since 2022",
    source: "shr",
    sql: "SELECT i.year, COUNT(*) FROM incidents i WHERE i.agency = 'New York' AND i.state = 'NY' GROUP BY i.year",
  });
  assert(result.warnings.includes("contract-state-scope-local-filter"));
  assert(result.retryIssues.some((issue) => issue.includes("contract-state-scope-local-filter")));
  assert(result.enforced.includes("contract-state-scope-local-filter"));
}

{
  const result = validateQueryContractSql({
    question: "aggravated assaults with a firearm in 2025",
    source: "nibrs",
    sql: "SELECT year, SUM(victim_count) FROM summary_victim_city_monthly WHERE ucr_offense_code = '13A' AND year = 2025 GROUP BY year",
  });
  assert(result.capabilityFindings.some((finding) => finding.ruleId === "nibrs-weapon-person-crime-table"));
  assert(result.retryIssues.some((issue) => issue.includes("nibrs-weapon-person-crime-table")));
  assert(result.enforced.includes("nibrs-weapon-person-crime-table"));
}

{
  const result = validateQueryContractSql({
    question: "firearm murder clearance rate in Chicago",
    source: "nibrs",
    sql: "SELECT year, SUM(cleared_count) * 100.0 / SUM(victim_count) AS clearance_rate FROM summary_victim_weapon WHERE ucr_offense_code = '09A' AND weapon_category = 'Firearm' GROUP BY year",
  });
  assert(result.capabilityFindings.some((finding) => finding.ruleId === "nibrs-clearance-weapon-unsupported"));
  assert.equal(result.retryIssues.length, 0);
  assert(result.blockReasons[0].includes("cannot calculate clearance rates broken down by weapon type"));
  assert(result.enforced.includes("nibrs-clearance-weapon-unsupported"));
}

{
  const result = validateQueryContractSql({
    question: "carjacking clearance rates in Chicago",
    source: "nibrs",
    sql: "SELECT year, SUM(total_cleared) * 100.0 / SUM(total_offenses) AS clearance_rate FROM summary_clearance_city_annual WHERE city = 'CHICAGO' GROUP BY year",
  });
  assert(result.capabilityFindings.some((finding) => finding.ruleId === "nibrs-carjacking-clearance-table"));
  assert(result.retryIssues.some((issue) => issue.includes("nibrs-carjacking-clearance-table")));
  assert(result.enforced.includes("nibrs-carjacking-clearance-table"));
}

{
  const result = validateQueryContractSql({
    question: "murders in Cook County Illinois by year",
    source: "historical",
    sql: "SELECT hac.year, SUM(hac.murder) FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Cook County' AND ha.state = 'il' GROUP BY hac.year",
  });
  assert(result.capabilityFindings.some((finding) => finding.ruleId === "historical-countywide-crosswalk"));
  assert(result.retryIssues.some((issue) => issue.includes("historical-countywide-crosswalk")));
  assert(result.enforced.includes("historical-countywide-crosswalk"));
}

const compoundStandaloneContracts: Array<{ question: string; source: Parameters<typeof buildQueryContract>[1]; topic: string; geographyKind?: string; unit?: string }> = [
  { question: "How bad is robbery in Chicago? Is it getting worse?", source: "historical", topic: "robbery", geographyKind: "city" },
  { question: "Show carjackings in DC. Are they rising?", source: "nibrs", topic: "carjacking", geographyKind: "city" },
  { question: "What is the murder clearance rate in Omaha? Is it improving?", source: "historical", topic: "murder", geographyKind: "city", unit: "clearance_rate" },
  { question: "Compare Atlanta and Dallas murders. Which is higher?", source: "current", topic: "murder", geographyKind: "city" },
  { question: "Aggravated assaults with a firearm in California. Is it getting better?", source: "nibrs", topic: "aggravated_assault", geographyKind: "state" },
  { question: "What is the hate crime trend in Texas? Is it getting worse?", source: "hate_crime", topic: "hate_crime", geographyKind: "state" },
  { question: "Fatal shootings in New York State. Are they rising?", source: "shr", topic: "murder", geographyKind: "state" },
];
for (const tc of compoundStandaloneContracts) {
  const contract = buildQueryContract(tc.question, tc.source);
  assert(contract, tc.question);
  assert.equal(contract.followup.isFollowup, false, tc.question);
  assert.equal(contract.followup.operation, null, tc.question);
  assert.equal(contract.metric.topic, tc.topic, tc.question);
  if (tc.geographyKind) assert.equal(contract.geography.kind, tc.geographyKind, tc.question);
  if (tc.unit) assert.equal(contract.metric.unit, tc.unit, tc.question);
}

const trueFollowupContracts = [
  "Is it getting better?",
  "What about Dallas?",
  "Make it per capita",
  "Show the same for 2024",
  "Which is higher?",
];
for (const question of trueFollowupContracts) {
  const contract = buildQueryContract(question, "historical", { mode: "follow_up", confidence: null, reason: "Follow-up inherited prior source context" });
  assert(contract, question);
  assert.equal(contract.followup.isFollowup, true, question);
}

{
  const currentYear = new Date().getFullYear();
  const result = validateQueryContractSql({
    question: "Is it getting better?",
    source: "current",
    sql: "SELECT year, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Houston' AND year >= 2021 GROUP BY year ORDER BY year",
  });
  assert(result.enforced.includes("contract-trend-followup-complete-years"));
  assert(result.retryIssues.some((issue) => issue.includes(`year < ${currentYear}`)));
}
{
  const currentYear = new Date().getFullYear();
  const result = validateQueryContractSql({
    question: "monthly murders in Houston since 2021 (Is it getting better? trend assessment follow-up)",
    source: "current",
    sql: "SELECT year, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Houston' AND year >= 2021 GROUP BY year ORDER BY year",
  });
  assert(result.enforced.includes("contract-trend-followup-complete-years"));
  assert(result.retryIssues.some((issue) => issue.includes(`year < ${currentYear}`)));
}

{
  const currentYear = new Date().getFullYear();
  const result = validateQueryContractSql({
    question: "monthly murders in Houston since 2021 (Is it getting better? trend assessment follow-up)",
    source: "current",
    sql: `SELECT year, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Houston' AND year >= 2021 AND year < ${currentYear} GROUP BY year ORDER BY year`,
  });
  assert(!result.enforced.includes("contract-trend-followup-complete-years"));
}

{
  const result = validateQueryContractSql({
    question: "monthly murders in Houston since 2021 (Is it getting better? trend assessment follow-up)",
    source: "current",
    sql: "SELECT year, month, count FROM agency_monthly WHERE agency = 'Houston' AND year >= 2021 GROUP BY year, month ORDER BY year, month",
  });
  assert(result.enforced.includes("contract-trend-followup-annualized-output"));
  assert(result.retryIssues.some((issue) => issue.includes("final SELECT should not include month")));
}

{
  const currentYear = new Date().getFullYear();
  const result = validateQueryContractSql({
    question: "monthly murders in Houston since 2021 (Is it getting better? trend assessment follow-up)",
    source: "current",
    sql: `WITH monthly AS (SELECT year, month, count FROM agency_monthly WHERE agency = 'Houston' AND year >= 2021 GROUP BY year, month), annual AS (SELECT year, SUM(count) AS murders FROM monthly GROUP BY year) SELECT year, murders FROM annual WHERE year < ${currentYear} ORDER BY year`,
  });
  assert(!result.enforced.includes("contract-trend-followup-annualized-output"));
  assert(!result.enforced.includes("contract-trend-followup-complete-years"));
}

{
  const result = validateQueryContractSql({
    question: "murder rate in Houston since 2021 (Is it getting better? trend assessment follow-up)",
    source: "historical",
    sql: "SELECT year, murder_rate FROM historical_agency_crime WHERE year >= 2021 GROUP BY year ORDER BY year",
  });
  assert(!result.enforced.includes("contract-trend-followup-complete-years"));
}

{
  const result = validateQueryContractSql({
    question: "What about Dallas?",
    source: "historical",
    sql: `SELECT ha.agency, 'TX' AS state, ha.type
      FROM historical_agency ha
      WHERE UPPER(ha.state) = UPPER('TX')
        AND LOWER(ha.type) = 'city'
        AND UPPER(ha.agency) = UPPER('Dallas')`,
    routingMeta: { mode: "follow_up", confidence: null, reason: "Follow-up inherited prior source context" },
  });
  assert(!result.enforced.includes("contract-geography-state-missing"));
}
{
  const question = "show me murders, robberies, and aggravated assaults for albuquerque police department and bernalillo county sheriff by year for 2020 to 2025";
  const contract = buildQueryContract(question, "nibrs");
  assert(contract);
  assert.deepEqual(contract.metric.offenseCodes, ["09A", "120", "13A"]);
  assert.deepEqual(contract.metric.offenses.map((offense) => offense.topic), ["murder", "robbery", "aggravated_assault"]);
  assert.deepEqual(contract.geographies.map((geography) => geography.kind), ["agency", "agency"]);
  assert.deepEqual(contract.geographies.map((geography) => geography.state), ["NM", "NM"]);
  assert.match(contract.geographies[0].name || "", /Albuquerque police department/i);
  assert.match(contract.geographies[1].name || "", /Bernalillo county sheriff/i);

  const incomplete = validateQueryContractSql({
    question,
    source: "nibrs",
    sql: "SELECT year, SUM(victim_count) FROM summary_victim_city_monthly WHERE ucr_offense_code = '09A' GROUP BY year",
  });
  assert(incomplete.enforced.includes("contract-offense-codes-missing"));
  assert(incomplete.retryIssues.some((issue) => issue.includes("120") && issue.includes("13A")));

  const complete = validateQueryContractSql({
    question,
    source: "nibrs",
    sql: "SELECT year, SUM(reported_count) FROM (SELECT year, victim_count AS reported_count FROM summary_victim_city_monthly WHERE ucr_offense_code IN ('09A','13A') UNION ALL SELECT year, offense_count FROM summary_city_monthly WHERE ucr_offense_code = '120') GROUP BY year",
  });
  assert(!complete.enforced.includes("contract-offense-codes-missing"));
}

{
  const result = validateQueryContractSql({
    question: "murders reported by Houston Police Department since 2021",
    source: "nibrs",
    sql: "SELECT year, SUM(victim_count) FROM summary_victim_city_monthly WHERE agency_name = 'Houston Police Department' GROUP BY year",
  });
  assert(result.enforced.includes("contract-geography-state-missing"));
  assert(result.warnings.includes("contract-geography-state-missing"));
}

{
  const result = validateQueryContractSql({
    question: "murders in Oakland in 2021",
    source: "shr",
    sql: `WITH targets(city, ori, start_year, end_year) AS (
      VALUES ('Oakland, CA', 'CA00109', 2021, 2021)
    )
    SELECT i.year, COUNT(v.id) AS murder_victims
    FROM targets t
    JOIN incidents i ON i.ori = t.ori AND i.year BETWEEN t.start_year AND t.end_year
    JOIN victims v ON v.incident_id = i.id
    WHERE i.homicide_type = 'Murder'
    GROUP BY i.year`,
  });
  assert(!result.enforced.includes("contract-geography-state-missing"));
}

{
  const result = validateQueryContractSql({
    question: "murders in Oakland in 2021",
    source: "shr",
    sql: `WITH targets(city, ori) AS (SELECT city, ori FROM arbitrary_agency_map)
    SELECT i.year, COUNT(v.id) AS murder_victims
    FROM targets t JOIN incidents i ON i.ori = t.ori
    JOIN victims v ON v.incident_id = i.id
    WHERE i.homicide_type = 'Murder'
    GROUP BY i.year`,
  });
  assert(result.enforced.includes("contract-geography-state-missing"));
}


{
  for (const question of [
    "What is the aggravated assault rate in White Plains, NY?",
    "Sex offense rates in Denver since 2019",
  ]) {
    const contract = buildQueryContract(question, "nibrs");
    assert(contract);
    assert.equal(contract.metric.unit, "rate_per_100k");
    assert.equal(contract.metric.unsupportedReason, null);
    assert.deepEqual(contract.breakdowns, []);
    if (/sex offense/i.test(question)) {
      assert.deepEqual(contract.metric.offenseCodes, ["11A", "11B", "11C", "11D", "36A", "36B"]);
    }
  }

  const demographicRate = buildQueryContract("juvenile crime rate in Minneapolis", "nibrs");
  assert(demographicRate);
  assert.equal(demographicRate.metric.unsupportedReason, "demographic_rate_denominator_unavailable");
}

{
  const result = validateQueryContractSql({
    question: "murders per month in 2021 in Oakland",
    source: "shr",
    sql: "WITH RECURSIVE months(month) AS (SELECT 1 UNION ALL SELECT month + 1 FROM months WHERE month < 12), targets(city, ori, start_year, end_year) AS (VALUES ('Oakland, CA', 'CA00109', 2021, 2021)), places(city) AS (SELECT DISTINCT city FROM targets), coverage AS (SELECT t.city, COUNT(i.id) AS shr_records, COUNT(DISTINCT i.month) AS recorded_months FROM targets t LEFT JOIN incidents i ON i.ori = t.ori AND i.year BETWEEN t.start_year AND t.end_year AND i.year = 2021 AND i.month BETWEEN 1 AND 12 GROUP BY t.city), counts AS (SELECT t.city, i.month, COUNT(v.id) AS murder_victims FROM targets t JOIN incidents i ON i.ori = t.ori AND i.year BETWEEN t.start_year AND t.end_year JOIN victims v ON v.incident_id = i.id WHERE i.homicide_type = 'Murder' AND i.year = 2021 AND i.month BETWEEN 1 AND 12 GROUP BY t.city, i.month) SELECT printf('%04d-%02d', 2021, m.month) AS month, p.city, CASE WHEN cv.shr_records = 0 THEN NULL ELSE COALESCE(c.murder_victims, 0) END AS murder_victims, cv.recorded_months AS shr_recorded_months, CASE WHEN cv.shr_records = 0 THEN 'No SHR homicide records in period' ELSE 'SHR records present' END AS shr_status FROM places p CROSS JOIN months m JOIN coverage cv ON cv.city = p.city LEFT JOIN counts c ON c.city = p.city AND c.month = m.month ORDER BY p.city, m.month LIMIT 1000",
  });
  assert(!result.warnings.includes("contract-geography-state-missing"));
}

console.log("query contract tests passed");
