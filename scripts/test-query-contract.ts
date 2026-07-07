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
  const contract = buildQueryContract("show murders by offender age from continuously reporting agencies from 2018 to 2025", "nibrs");
  assert(contract);
  assert.equal(contract.comparability.continuousReporters, true);
  assert(contract.warnings.includes("continuous_reporters_required"));
  assert(contract.breakdowns.includes("age_group"));
}

{
  const contract = buildQueryContract("start the Y-axis at 60%", "current", { mode: "follow_up", confidence: null, reason: null });
  assert(contract);
  assert.equal(contract.followup.operation, "chart_only");
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
    question: "Richmond city murders by year",
    source: "historical",
    sql: "SELECT year, murder FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Richmond City' AND ha.state = 'VA'",
  });
  assert(result.fired.includes("contract-city-jurisdiction-suffix"));
  assert.match(result.sql, /ha\.agency = 'Richmond'/);
  assert.doesNotMatch(result.sql, /Richmond City/);
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

console.log("query contract tests passed");
