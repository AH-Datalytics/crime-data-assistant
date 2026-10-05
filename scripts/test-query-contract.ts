import assert from "node:assert/strict";
import { buildQueryContract, serializeQueryContractLogMeta } from "../lib/query-contract";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import { returnsRapeMeasure, sexualAssaultRapeNarrative } from "../lib/historical-offense-binding";

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

// ---- Measure preservation (Codex :34106): a statement may not deliver a different measure than requested ----
{
  // GC-050 (saved October capture): a share request, then a year-only follow-up answered with a population rate.
  const gc050History = [
    { role: "user", content: "Show me which big cities had the highest share of firearm murders in 2024" },
    { role: "assistant", content: "I can rank cities by a count or by a rate per 100,000, but not by that measure." },
  ];
  const gc050Sql = "SELECT i.state, i.agency, COUNT(*) as firearm_murders, ROUND(COUNT(*) * 100000.0 / NULLIF(AVG(i.population), 0), 1) as rate_per_100k FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.year = 2026 AND i.month <= 9 AND i.homicide_type = 'Murder' AND i.weapon_group = 'Firearm' AND i.population >= 250000 GROUP BY i.state, i.agency ORDER BY rate_per_100k DESC LIMIT 20";
  const drift = validateQueryContractSql({ question: "now give me 2026 so far", source: "shr", sql: gc050Sql, history: gc050History });
  assert(drift.enforced.includes("contract-measure-drift"), "GC-050: the inherited share blocks the delivered rate");
  assert(/You asked earlier for a share/.test(drift.blockReasons.join(" ")) && /rate per 100,000/.test(drift.blockReasons.join(" ")));
  assert(!/population denominator/.test(drift.blockReasons.join(" ")), "the message is about the measure, not a missing population");
  const noHistory = validateQueryContractSql({ question: "now give me 2026 so far", source: "shr", sql: gc050Sql });
  assert(!noHistory.enforced.includes("contract-measure-drift"), "with no conversation, nothing is inherited");
  const explicit = validateQueryContractSql({ question: "now give me the firearm murder rate per 100,000 for big cities in 2026", source: "shr", sql: gc050Sql, history: gc050History });
  assert(!explicit.enforced.includes("contract-measure-drift"), "an explicit change to a rate is honored");
  const standalone = validateQueryContractSql({ question: "which big cities had the highest share of firearm murders in 2024", source: "shr", sql: gc050Sql });
  assert(standalone.enforced.includes("contract-measure-drift"), "a standalone share answered with a rate is blocked too");

  // GC-001/004 (NIBRS clearance shares): the share keeps the denominator the user named.
  const ofClearances = "SELECT CAST(scd.state AS TEXT) AS state, SUM(scd.cleared_B) AS prosecution_declined, ROUND(100.0 * SUM(scd.cleared_B) / NULLIF(SUM(scd.cleared_by_arrest + scd.cleared_A + scd.cleared_B + scd.cleared_C + scd.cleared_D + scd.cleared_E), 0), 1) AS pct FROM rollup.state_summary_clearance_detail scd WHERE scd.ucr_offense_code IN ('11A','11B','11C') AND scd.year = 2025 GROUP BY scd.state";
  const ofOffenses = "SELECT state, SUM(cleared_B) AS prosecution_declined, SUM(total_offenses) AS total_rape_offenses, ROUND(100.0 * SUM(cleared_B) / SUM(total_offenses), 1) AS pct_prosecution_declined FROM rollup.state_summary_clearance_detail WHERE ucr_offense_code IN ('11A','11B','11C') AND year = 2025 GROUP BY state";
  const gc001 = "give me the share of all rape clearances that were prosecution declined in 2025 by state";
  assert(!validateQueryContractSql({ question: gc001, source: "nibrs", sql: ofClearances }).enforced.includes("contract-measure-drift"), "GC-001: a share of clearances over clearances passes");
  assert(validateQueryContractSql({ question: gc001, source: "nibrs", sql: ofOffenses }).enforced.includes("contract-measure-drift"), "GC-001: a share of clearances divided by offenses is blocked");
  const gc004History = [{ role: "user", content: "Which states have the highest share of rapes cleared by exception in 2025?" }, { role: "assistant", content: "I couldn't build a reliable query." }];
  const gc004 = "Now what about just the share that's prosecution declined";
  assert(!validateQueryContractSql({ question: gc004, source: "nibrs", sql: ofOffenses, history: gc004History }).enforced.includes("contract-measure-drift"), "GC-004: keeps the setup's share of rapes (offenses) -- the saved answer passes");
  assert(validateQueryContractSql({ question: gc004, source: "nibrs", sql: ofClearances, history: gc004History }).enforced.includes("contract-measure-drift"), "GC-004: switching to a share of clearances is blocked");

  // Historical/Current: a stored population-rate column is a rate; a share computed from counts is a share.
  const histHistory = [{ role: "user", content: "what share of violent crime in the United States was murder in 2010" }];
  const histRate = "SELECT year, murder_rate FROM historical_state_national WHERE state = 'United States' AND year = 2020";
  const histShare = "SELECT year, ROUND(100.0 * murder / (murder + rape + robbery + aggravated_assault), 2) AS murder_share FROM historical_state_national WHERE state = 'United States' AND year = 2020";
  assert(validateQueryContractSql({ question: "now 2020", source: "historical", sql: histRate, history: histHistory }).enforced.includes("contract-measure-drift"), "Historical: a share follow-up answered with a stored rate is blocked");
  assert(!validateQueryContractSql({ question: "now 2020", source: "historical", sql: histShare, history: histHistory }).enforced.includes("contract-measure-drift"), "Historical: the share follow-up answered with the share passes");
  assert(!validateQueryContractSql({ question: "what was the murder rate in the United States in 2020", source: "historical", sql: histRate }).enforced.includes("contract-measure-drift"), "Historical: a requested rate with a stored rate passes");
  const clr = "SELECT year, murder_clr FROM historical_agency_clearance WHERE ori = 'X'";
  assert(!validateQueryContractSql({ question: "what share of murders were cleared in 2020", source: "historical", sql: clr }).enforced.includes("contract-measure-drift"), "a clearance percentage column is not a population rate");

  // Codex R1 (:34305): an explicit replacement overrides the older measure; naming the replaced measure is not a request
  // for it. Year-only inheritance is unchanged.
  const shareHistory = [{ role: "user", content: "what share of violent crime in the United States was murder in 2010" }];
  const rateHistory = [{ role: "user", content: "what was the murder rate per 100,000 in the United States in 2010" }];
  const drifted = (question: string, sql: string, history: { role: string; content: string }[]) =>
    validateQueryContractSql({ question, source: "historical", sql, history }).enforced.includes("contract-measure-drift");
  for (const q of [
    "Instead of the share, show the murder rate per 100,000 in 2020",            // Codex's witness
    "show the murder rate per 100,000 in 2020 instead of the share",
    "rather than a percentage, give me the murder rate for 2020",
    "not the share -- the murder rate per capita in 2020",
    "now show the rate instead",
  ]) assert(!drifted(q, histRate, shareHistory), `R1 share->rate replacement is honored: "${q}"`);
  for (const q of [
    "Instead of the rate, show murder's share of violent crime in 2020",
    "give me murder's percentage of violent crime in 2020 rather than the rate",
  ]) assert(!drifted(q, histShare, rateHistory), `R1 rate->share replacement is honored: "${q}"`);
  assert(drifted("now 2020", histShare, rateHistory), "R1: a year-only follow-up still keeps the rate (a share is blocked)");
  assert(drifted("now 2020", histRate, shareHistory), "R1: a year-only follow-up still keeps the share (a rate is blocked)");
  const both = "SELECT year, ROUND(100.0 * murder / (murder + rape + robbery + aggravated_assault), 2) AS murder_share, murder_rate FROM historical_state_national WHERE state = 'United States' AND year = 2020";
  assert(!drifted("show murder's share of violent crime and the murder rate in 2020", both, shareHistory), "R1: asking for both measures invents no contradiction");
  assert(!drifted("show murder's share of violent crime and the murder rate in 2020", histRate, shareHistory), "R1: asking for both measures is not this module's call (no block)");
  assert(!drifted("not the share, just the numbers for 2020", "SELECT year, murder FROM historical_state_national WHERE state = 'United States' AND year = 2020", shareHistory), "R1: rejecting the share without naming a new measure does not inherit the share");
  assert(!drifted("not the share, just the numbers for 2020", histRate, shareHistory), "R1: ...and nothing inherited means nothing to contradict");
  // The standalone checks still hold: an unreplaced share answered with a rate is blocked.
  assert(validateQueryContractSql({ question: "what share of violent crime was murder in 2020, not counting manslaughter", source: "historical", sql: histRate }).enforced.includes("contract-measure-drift"), "R1: 'not counting' is not a measure replacement");

  // Hate Crime: incidents, offenses and victims are different recorded units.
  const hcIncidents = "SELECT year, COUNT(DISTINCT incident_number || '|' || ori || '|' || year) AS incident_count FROM hate_crime_incidents WHERE year = 2022 GROUP BY year";
  const hcVictims = "SELECT year, SUM(offense_victims) AS victim_count FROM hate_crime_incidents WHERE year = 2022 GROUP BY year";
  assert(validateQueryContractSql({ question: "how many hate crime victims were there in 2022", source: "hate_crime", sql: hcIncidents }).enforced.includes("contract-measure-drift"), "HC: victims asked, incidents counted -> blocked");
  assert(!validateQueryContractSql({ question: "how many hate crime victims were there in 2022", source: "hate_crime", sql: hcVictims }).enforced.includes("contract-measure-drift"), "HC: victims asked, victims counted -> passes");
  const hcHistory = [{ role: "user", content: "how many hate crime victims were there in 2021" }];
  assert(validateQueryContractSql({ question: "and 2022?", source: "hate_crime", sql: hcIncidents, history: hcHistory }).enforced.includes("contract-measure-drift"), "HC: a follow-up keeps the victim unit");
  assert(!validateQueryContractSql({ question: "how many hate crimes were there in 2022", source: "hate_crime", sql: hcIncidents }).enforced.includes("contract-measure-drift"), "HC: no unit named -> the source default is not second-guessed");
  assert(!validateQueryContractSql({ question: "how many hate crime incidents were there in 2022", source: "nibrs", sql: hcVictims }).enforced.includes("contract-measure-drift"), "the unit rule is Hate Crime only");
  // p3-1a corpus row 204: a COUNT(*) over a non-hate-crime table is not read as hate-crime offenses (other rules own it).
  assert(!validateQueryContractSql({ question: "What were the demographics of victims in Jefferson Parish, LA in 2022?", source: "hate_crime", sql: "SELECT COUNT(*) FROM summary_state_monthly WHERE state='IL'" }).enforced.includes("contract-measure-drift"), "HC units are read only from the hate-crime tables");
  assert(validateQueryContractSql({ question: "how many hate crime victims were there in 2022", source: "hate_crime", sql: "SELECT COUNT(*) AS offenses FROM hate_crime_incidents WHERE year = 2022" }).enforced.includes("contract-measure-drift"), "a raw COUNT(*) over hate_crime_incidents is offenses, not victims");
}

// Historical offense binding (Codex :35871): sexual-assault intent is answered with the UCR rape measure on every pass.
{
  const D3_SAVED = "SELECT year, aggravated_assault FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2010 AND 2024 ORDER BY year LIMIT 5000";
  const v = (question: string, sql: string, source: "historical" | "current" = "historical") => validateQueryContractSql({ question, source, sql });
  // The saved 10-05 D3: rebound to rape, nothing else changed.
  const d3 = v("national, sexual assault, 2010-2024", D3_SAVED);
  assert.equal(d3.sql, "SELECT year, rape FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2010 AND 2024 ORDER BY year LIMIT 5000");
  assert(d3.fired.includes("contract-sexual-assault-rape-binding") && d3.retryIssues.length === 0 && d3.blockReasons.length === 0);
  // Wording, geography, period and unit variations.
  assert.equal(v("sexual assaults in Ohio since 2000", "SELECT year, aggravated_assault FROM historical_state_national WHERE state = 'Ohio' AND year >= 2000 ORDER BY year").sql, "SELECT year, rape FROM historical_state_national WHERE state = 'Ohio' AND year >= 2000 ORDER BY year");
  assert.equal(v("U.S. sexual assault rate per 100,000 from 2015 to 2020", "SELECT year, aggravated_assault_rate FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2015 AND 2020").sql, "SELECT year, rape_rate FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2015 AND 2020", "a rate stays a rate");
  assert.equal(v("How many sexual assaults were reported in Chicago by year since 1990?", "SELECT hac.year, hac.aggravated_assault FROM historical_agency_crime hac JOIN historical_agency ha ON hac.ori = ha.ori WHERE ha.agency = 'Chicago' AND ha.state = 'il' AND hac.year >= 1990 ORDER BY hac.year").sql, "SELECT hac.year, hac.rape FROM historical_agency_crime hac JOIN historical_agency ha ON hac.ori = ha.ori WHERE ha.agency = 'Chicago' AND ha.state = 'il' AND hac.year >= 1990 ORDER BY hac.year", "agency join, table prefix kept");
  assert.equal(v("sexual assault nationally 2010-2024", "SELECT year, aggravated_assault AS sexual_assaults FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2010 AND 2024").sql, "SELECT year, rape FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2010 AND 2024", "a misleading alias is not kept");
  // Already the rape measure: untouched.
  const ok = v("national, sexual assault, 2010-2024", "SELECT year, rape FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2010 AND 2024");
  assert(!ok.fired.includes("contract-sexual-assault-rape-binding") && !ok.enforced.includes("contract-sexual-assault-rape-measure"));
  // A shape it cannot rebind: retried with the precise instruction (and stopped by the existing second-failure rule), never relabelled.
  const complex = v("national sexual assault 2010-2024", "SELECT year, SUM(aggravated_assault) AS n FROM historical_state_national WHERE state = 'United States' GROUP BY year");
  assert(complex.enforced.includes("contract-sexual-assault-rape-measure") && complex.retryIssues.some((i) => /contract-sexual-assault-rape-measure/.test(i)) && /aggravated_assault/.test(complex.sql));
  // Controls: explicit aggravated assault, mixed and negated requests, and other sources are never converted.
  for (const q of ["aggravated assault nationally 2010-2024", "rape and aggravated assault nationally 2010 to 2024", "sexual and aggravated assaults nationally 2010-2024", "compare sexual assault and aggravated assault nationally 2010-2024", "violent crime excluding sexual assault 2010-2024", "assaults other than sexual assault nationally since 2010", "aggravated sexual assault nationally 2010-2024"]) {
    const r = v(q, D3_SAVED);
    assert(r.sql === D3_SAVED && !r.fired.includes("contract-sexual-assault-rape-binding") && !r.enforced.includes("contract-sexual-assault-rape-measure"), q);
  }
  assert.equal(v("sexual assault in Detroit 2024", "SELECT year, SUM(count) AS n FROM agency_monthly WHERE offense = 'Aggravated Assault' GROUP BY year", "current").fired.includes("contract-sexual-assault-rape-binding"), false, "Historical only");

  // OB-R1a (Codex :35951): bound only when the RETURNED measure is the rape column; a token elsewhere is not proof.
  const retried = (sql: string, q = "national sexual assault each year 2015-2020") => { const r = v(q, sql); return r.enforced.includes("contract-sexual-assault-rape-measure") && r.sql === sql; };
  assert(retried("SELECT year, population AS rape FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2015 AND 2020 ORDER BY year"), "Codex alias decoy: population AS rape");
  assert(retried("SELECT year, rape * 2 AS rape FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2015 AND 2020"), "an expression aliased as rape");
  assert(retried("SELECT year, (SELECT rape FROM historical_state_national WHERE state = 'Alabama' AND year = 2020) AS x FROM historical_state_national WHERE state = 'United States'"), "an inner reference");
  assert(retried("SELECT year, robbery AS rape, rape AS robbery FROM historical_state_national WHERE state = 'United States'"), "swapped aliases");
  assert(retried("WITH t AS (SELECT year, rape FROM historical_state_national WHERE state = 'United States') SELECT year, rape FROM t"), "a CTE (uncertain shape) is retried, not trusted");
  for (const good of ["SELECT year, rape FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2015 AND 2020", "SELECT h.year, h.rape FROM historical_state_national h WHERE h.state = 'Ohio'", "SELECT year, rape_rate FROM historical_state_national WHERE state = 'United States'", "SELECT year, rape AS rape FROM historical_state_national WHERE state = 'United States'"]) {
    const r = v("national sexual assault each year 2015-2020", good);
    assert(r.sql === good && !r.enforced.includes("contract-sexual-assault-rape-measure") && !r.fired.includes("contract-sexual-assault-rape-binding"), `bound as is: ${good}`);
  }
  assert.equal(v("sexual assault nationally 2015-2020", "SELECT year, rape AS assaults FROM historical_state_national WHERE state = 'United States'").sql, "SELECT year, rape FROM historical_state_national WHERE state = 'United States'", "a rape column under another alias is returned under its own name");
  assert.equal(returnsRapeMeasure("SELECT year, population AS rape FROM historical_state_national WHERE state = 'United States'"), null);
  assert.equal(returnsRapeMeasure("SELECT year, rape FROM historical_state_national WHERE state = 'United States'"), "rape");

  // OB-R1b: the new narrative names a place only when proven (national-only WHERE); otherwise none.
  const rows = [2015, 2016].map((year) => ({ year, rape: 1500 }));
  const narr = (sql: string) => sexualAssaultRapeNarrative("historical", "sexual assault each year 2015-2016", sql, rows);
  assert.equal(narr("SELECT year, rape FROM historical_state_national WHERE NOT (state = 'United States') AND state = 'Alabama' AND year BETWEEN 2015 AND 2016 ORDER BY year"), "FBI UCR rape offenses by year, 2015–2016, for the sexual assault request. These are the FBI's Uniform Crime Reporting rape category, not all sexual assaults.", "Codex NOT example: no national claim");
  assert.doesNotMatch(narr("SELECT year, rape FROM historical_state_national WHERE (state = 'United States' OR state = 'Alabama') AND year BETWEEN 2015 AND 2016")!, /nationally|Alabama/, "OR/mixed: no place named");
  assert.doesNotMatch(narr("SELECT year, rape FROM historical_state_national WHERE state = 'Alabama' AND year BETWEEN 2015 AND 2016")!, /nationally/, "a state is never called national");
  assert.match(narr("SELECT year, rape FROM historical_state_national WHERE state = 'United States' AND year BETWEEN 2015 AND 2016 ORDER BY year")!, /^FBI UCR rape offenses nationally by year, 2015–2016/, "proven national keeps 'nationally'");
  assert.equal(narr("SELECT year, population AS rape FROM historical_state_national WHERE state = 'United States'"), null, "no owned description on an unproven measure");
}

console.log("query contract tests passed");
