import { buildQueryContract, type QueryContractSource } from "./query-contract";
import type { RoutingLogMeta } from "./routing-log-meta";
import { validateSourceCapabilities, type SourceCapabilityFinding } from "./source-capabilities";
import { SUB_CITY_GEOGRAPHY_MESSAGE } from "./capability-overrides";

export interface QueryContractSqlValidation {
  sql: string;
  fired: string[];
  warnings: string[];
  capabilityFindings: SourceCapabilityFinding[];
  retryIssues: string[];
  blockReasons: string[];
  enforced: string[];
}

const CONTRACT_SECOND_FAILURE_MESSAGE =
  "I couldn't build a reliable query that matched the requested source, geography, metric, and time period. Try narrowing the question or choosing one of the suggested alternatives.";

const RETRY_CAPABILITY_RULES = new Set([
  "current-countywide-crosswalk",
  "current-rate-population",
  "nibrs-weapon-person-crime-table",
  "nibrs-weapon-demographic-person-crime-table",
  "nibrs-weapon-circumstance-person-crime-table",
  "nibrs-weapon-circumstance-demographic-person-crime-table",
  "nibrs-carjacking-clearance-table",
  "nibrs-clearance-type-table",
  "nibrs-campus-agency-resolution",
  "nibrs-countywide-crosswalk",
  "nibrs-continuous-reporters-range-table",
  "nibrs-demographic-breakdown-table",
  "nibrs-specific-drug-offense-table",
  "nibrs-specific-drug-arrest-table",
  "nibrs-local-geography-state-table",
  "nibrs-agency-lookup-not-crime-data",
  "historical-countywide-crosswalk",
  "historical-clearance-table",
  "historical-state-national-rate-table",
  "historical-local-rate-population",
  "historical-rate-null-gaps",
  "historical-local-geography-state-table",
  "historical-parish-type-city",
  "historical-agency-lookup-not-crime-data",
  "shr-campus-agency-resolution",
  "shr-countywide-crosswalk",
  "shr-state-rate-population",
]);

const BLOCK_CAPABILITY_RULES = new Set([
  "unsupported-sub-city-geography",
  "unsupported-court-policy-topic",
  "nibrs-clearance-weapon-unsupported",
  "nibrs-countywide-demographics-unsupported",
  "nibrs-shooting-category-unsupported",
  "shr-non-homicide-unsupported",
  "shr-clearance-unsupported",
  "shr-demographic-rate-unsupported",
]);

const BLOCK_MESSAGES: Record<string, string> = {
  "unsupported-sub-city-geography":
    SUB_CITY_GEOGRAPHY_MESSAGE,
  "unsupported-court-policy-topic":
    "The available FBI datasets track reported crime and law-enforcement reporting, not court outcomes, incarceration, fines, immigration status, or policy registries.",
  "nibrs-clearance-weapon-unsupported":
    "The available NIBRS summary data cannot calculate clearance rates broken down by weapon type. I can answer overall clearance rates, or weapon-specific counts, but not weapon-specific clearance rates.",
  "nibrs-countywide-demographics-unsupported":
    "Countywide NIBRS demographic breakdowns are not reliable from the available summaries because county totals combine agencies with different reporting participation and completeness. Try a specific agency/city demographic breakdown, or a countywide total without demographics.",
  "nibrs-shooting-category-unsupported":
    "The FBI does not systemically track all shootings. You can query fatal shootings specifically or aggravated assaults with a firearm as a broader measure.",
  "shr-non-homicide-unsupported":
    "The Homicide Reports dataset contains only homicide data. For non-homicide offenses, arrests, staffing, or broad crime categories, use Current Trends, Historical, or NIBRS depending on the question.",
  "shr-clearance-unsupported":
    "The Homicide Reports dataset does not track whether cases were solved or cleared. For clearance rates, use Historical or NIBRS data.",
  "shr-demographic-rate-unsupported":
    "The FBI data does not include matching population denominators for demographic groups. Better choices: counts by gender/race, or an overall homicide rate.",
};

function countyKey(value: string | null): string | null {
  if (!value) return null;
  const key = value
    .replace(/\b(county|parish|borough)\b/ig, " ")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return key || null;
}

function capabilityRetryIssue(finding: SourceCapabilityFinding, contract: ReturnType<typeof buildQueryContract>): string {
  const expected = finding.expectedTables?.length
    ? ` Use one of these table(s): ${finding.expectedTables.join(", ")}.`
    : "";
  const forbidden = finding.forbiddenTables?.length
    ? ` Do not use: ${finding.forbiddenTables.join(", ")}.`
    : "";
  const actual = finding.actualTables.length
    ? ` Current SQL used: ${finding.actualTables.join(", ")}.`
    : " Current SQL did not reference a usable data table.";
  const countywideDetail = finding.ruleId.endsWith("countywide-crosswalk") && contract
    ? ` For countywide geography, join agency_county_crosswalk on the metric table ORI (metric_alias.ori = ac.ori9 OR substr(metric_alias.ori, 1, 7) = ac.ori), filter ac.county_key = '${countyKey(contract.geography.name) ?? "[COUNTY_KEY]"}'${contract.geography.state ? ` and ac.state = '${contract.geography.state}'` : ""}, and do not filter to a single county/sheriff agency unless the user explicitly asked for that agency.`
    : "";
  return `[SYSTEM: Query contract violation (${finding.ruleId}). ${finding.message}${expected}${forbidden}${actual}${countywideDetail} Rewrite the SQL so it satisfies the user's requested source, geography, metric, and time contract. Do not execute a query that violates this contract.]`;
}

export function queryContractFailureMessage(result: QueryContractSqlValidation): string | null {
  return result.blockReasons[0] ?? (result.retryIssues.length > 0 ? CONTRACT_SECOND_FAILURE_MESSAGE : null);
}

export function queryContractGuardrails(result: QueryContractSqlValidation): string[] {
  return [...new Set([...result.fired, ...result.enforced])];
}

function rewriteStateEquals(sql: string, requestedState: string, sourceState: string | string[]): string {
  const sourceStates = Array.isArray(sourceState) ? sourceState : [sourceState];
  if (sourceStates.length === 1 && requestedState.toUpperCase() === sourceStates[0].toUpperCase()) return sql;

  const candidates = [...new Set([requestedState, ...sourceStates].map((state) => state.toUpperCase()))];
  const pattern = new RegExp(`\\b((?:\\w+\\.)?state)\\s*=\\s*'(${candidates.join("|")})'`, "gi");
  if (sourceStates.length === 1) return sql.replace(pattern, `$1 = '${sourceStates[0]}'`);
  return sql.replace(pattern, `$1 IN (${sourceStates.map((state) => `'${state}'`).join(",")})`);
}

function hasStateFilter(sql: string): boolean {
  return /\b(?:\w+\.)?state\s*(?:=|IN\s*\()\s*'[^']+'/i.test(sql);
}

function hasLocalPlaceFilter(sql: string): boolean {
  return /\b(?:\w+\.)?(?:agency|agency_name|canonical_agency|city|county|alias_key)\s*(?:=|LIKE|IN\s*\()\s*'[^']+'/i.test(sql);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSqlLiteral(value: string, template: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return /^[A-Z0-9 .'-]+$/.test(template) ? compact.toUpperCase() : compact;
}

function normalizeAliasKeyLiteral(value: string): string {
  return value.replace(/\./g, "").replace(/\s+/g, " ").trim().toUpperCase();
}

function cityNameRegexSource(cityName: string): string {
  const canonical = cityName.replace(/\s+/g, " ").trim();
  const saintMatch = canonical.match(/^St\.?\s+(.+)$/i);
  if (saintMatch) {
    return `(?:St\\.?|Saint)\\s+${escapeRegExp(saintMatch[1]).replace(/\s+/g, "\\s+")}`;
  }
  return escapeRegExp(canonical).replace(/\s+/g, "\\s+");
}

function rewriteCityJurisdictionSuffix(sql: string, cityName: string): string {
  if (!cityName || /\bCity$/i.test(cityName)) return sql;

  const canonical = cityName.replace(/\s+/g, " ").trim();
  const canonicalRe = cityNameRegexSource(canonical);
  let rewritten = sql;

  rewritten = rewritten.replace(
    new RegExp(`(\\balias_key\\s+)LIKE\\s+'%${canonicalRe}(?:%|\\s+)CITY%'`, "gi"),
    (_match, prefix) => `${prefix}= '${normalizeAliasKeyLiteral(canonical)}'`
  );

  rewritten = rewritten.replace(
    new RegExp(`(\\balias_key\\s*=\\s*)'(${canonicalRe}\\s+City)'`, "gi"),
    (_match, prefix) => `${prefix}'${normalizeAliasKeyLiteral(canonical)}'`
  );

  rewritten = rewritten.replace(
    new RegExp(`(\\b(?:\\w+\\.)?(?:city|agency|agency_name|canonical_agency)\\s*=\\s*)'(${canonicalRe}\\s+City)'`, "gi"),
    (_match, prefix, literal) => `${prefix}'${normalizeSqlLiteral(canonical, literal)}'`
  );

  rewritten = rewritten.replace(
    new RegExp(`(\\b(?:\\w+\\.)?(?:city|agency|agency_name|canonical_agency)\\s+LIKE\\s+')%(${canonicalRe})%CITY%(')`, "gi"),
    (_match, prefix, literal, suffix) => `${prefix}%${normalizeSqlLiteral(canonical, literal)}%${suffix}`
  );

  return rewritten;
}

export function validateQueryContractSql(opts: {
  question: string;
  source: QueryContractSource;
  sql: string;
  routingMeta?: RoutingLogMeta | null;
}): QueryContractSqlValidation {
  const contract = buildQueryContract(opts.question, opts.source, opts.routingMeta);
  if (!contract) {
    return {
      sql: opts.sql,
      fired: [],
      warnings: [],
      capabilityFindings: [],
      retryIssues: [],
      blockReasons: [],
      enforced: [],
    };
  }

  let sql = opts.sql;
  const fired: string[] = [];
  const warnings: string[] = [];
  const retryIssues: string[] = [];
  const blockReasons: string[] = [];
  const enforced: string[] = [];

  const requestedState = contract.geography.state;
  const sourceState = requestedState ? contract.geography.sourceCodes?.[opts.source] : null;
  if (requestedState && sourceState) {
    const rewritten = rewriteStateEquals(sql, requestedState, sourceState);
    if (rewritten !== sql) {
      sql = rewritten;
      fired.push("contract-state-code-alias");
    }
  }

  if (contract.geography.kind === "city" && contract.geography.name) {
    const rewritten = rewriteCityJurisdictionSuffix(sql, contract.geography.name);
    if (rewritten !== sql) {
      sql = rewritten;
      fired.push("contract-city-jurisdiction-suffix");
    }
  }

  if (
    requestedState &&
    (contract.geography.kind === "city" || contract.geography.kind === "county" || contract.geography.kind === "campus") &&
    /\b(?:agency_monthly|historical_agency|historical_agency_crime|summary_\w+|incidents)\b/i.test(sql) &&
    !hasStateFilter(sql)
  ) {
    warnings.push("contract-geography-state-missing");
  }

  if (contract.geography.kind === "state" && hasLocalPlaceFilter(sql)) {
    warnings.push("contract-state-scope-local-filter");
    retryIssues.push("[SYSTEM: Query contract violation (contract-state-scope-local-filter). The user asked for a state-level result, but the SQL filters to a local city/agency/county value. Rewrite the SQL so the filter is statewide, using the state field or the appropriate state/national summary table. Do not filter to a single agency or city unless the user explicitly asked for that local place.]");
    enforced.push("contract-state-scope-local-filter");
  }

  const capabilityFindings = validateSourceCapabilities({
    question: opts.question,
    source: opts.source,
    contract,
    sql,
  });
  for (const finding of capabilityFindings) {
    warnings.push(`capability-${finding.ruleId}`);
    if (BLOCK_CAPABILITY_RULES.has(finding.ruleId)) {
      blockReasons.push(BLOCK_MESSAGES[finding.ruleId] ?? finding.message);
      enforced.push(finding.ruleId);
    } else if (RETRY_CAPABILITY_RULES.has(finding.ruleId)) {
      retryIssues.push(capabilityRetryIssue(finding, contract));
      enforced.push(finding.ruleId);
    }
  }

  return {
    sql,
    fired,
    warnings: [...new Set(warnings)],
    capabilityFindings,
    retryIssues: [...new Set(retryIssues)],
    blockReasons: [...new Set(blockReasons)],
    enforced: [...new Set(enforced)],
  };
}
