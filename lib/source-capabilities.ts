import type { QueryContract, QueryContractSource } from "./query-contract";
import { extractReferencedTables } from "./table-allowlist";

export type SourceCapabilitySeverity = "warning" | "unsupported";

export type SourceCapabilityFinding = {
  ruleId: string;
  source: QueryContractSource;
  severity: SourceCapabilitySeverity;
  message: string;
  expectedTables?: string[];
  forbiddenTables?: string[];
  actualTables: string[];
};

type RuleContext = {
  question: string;
  source: QueryContractSource;
  contract: QueryContract;
  sql: string;
  tables: Set<string>;
};

type SourceCapabilityRule = {
  id: string;
  source: QueryContractSource;
  severity: SourceCapabilitySeverity;
  message: string;
  when: (ctx: RuleContext) => boolean;
  requiresAnyTables?: string[];
  forbidsTables?: string[];
  forbiddenSql?: RegExp[];
};

function hasAnyTable(tables: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((table) => tables.has(table.toLowerCase()));
}

function hasForbiddenTable(tables: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((table) => tables.has(table.toLowerCase()));
}

function usesForbiddenSql(sql: string, patterns: readonly RegExp[] | undefined): boolean {
  return Boolean(patterns?.some((pattern) => pattern.test(sql)));
}

function asksWeaponQualifiedPersonCrime(question: string, contract: QueryContract): boolean {
  if (!/\b(?:weapons?|firearms?|guns?|handguns?|rifles?|shotguns?|knives?|stabb(?:ing|ings)?|blunt\s+objects?)\b/i.test(question)) return false;
  return (
    ["murder", "rape", "aggravated_assault", "carjacking"].includes(contract.metric.topic) ||
    /\b(?:murders?|homicides?|rapes?|assaults?|aggravated\s+assaults?|victims?)\b/i.test(question)
  );
}

function asksCampusAgency(question: string, contract: QueryContract): boolean {
  return contract.geography.kind === "campus" ||
    /\b(?:universit(?:y|ies)|college|campus|ucla|uc\s+berkeley|berkeley\s+campus)\b/i.test(question);
}

function hasDemographicBreakdown(contract: QueryContract, question: string): boolean {
  return contract.breakdowns.some((breakdown) => ["age_group", "race", "sex"].includes(breakdown)) ||
    /\b(?:demographics?|age|race|racial|ethnicit\w+|hispanic|latino\w*|sex|gender|male|female|men|women|juvenile\w*|teen\w*)\b/i.test(question);
}

function hasCircumstanceBreakdown(question: string, contract: QueryContract): boolean {
  return contract.metric.topic === "domestic_violence" ||
    /\b(?:domestic\s+violence|intimate\s+partner|gang(?:land)?|juvenile\s+gang|argument|circumstance|justifiable|police\s+shooting)\b/i.test(question);
}

function asksCountywide(question: string, contract: QueryContract): boolean {
  return contract.geography.kind === "county" ||
    /\b[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,4}\s+(?:county|parish|borough)\b/i.test(question);
}

function asksCountywideGeography(question: string, contract: QueryContract): boolean {
  if (!asksCountywide(question, contract)) return false;
  if (/\b(?:sheriff'?s?\s+office|sheriff|county\s+police|county\s+agency|police\s+department)\b/i.test(question)) return false;
  return /\b(?:countywide|county-wide|all\s+(?:agencies|cities)|cities\s+(?:in|within)|agencies\s+(?:in|within)|crime\s+(?:in|within|for)|murders?\s+(?:in|within|for)|homicides?\s+(?:in|within|for)|shootings?\s+(?:in|within|for)|rates?\s+(?:in|within|for))\b/i.test(question) ||
    contract.geography.kind === "county";
}

function asksClearanceType(question: string): boolean {
  return /\b(?:cleared?\s+by\s+arrest|exceptional(?:ly)?|arrest\s+vs\.?\s+exceptional|by\s+clearance\s+type|clearance\s+type)\b/i.test(question);
}

function asksClearanceMetric(question: string, contract: QueryContract): boolean {
  return contract.metric.unit === "clearance_rate" ||
    /\b(?:clearance|clearances?|cleared|solve[ds]?|unsolved|exceptional(?:ly)?|cleared\s+by\s+arrest)\b/i.test(question);
}

function asksHistoricalRate(contract: QueryContract, question: string): boolean {
  return contract.metric.unit === "rate_per_100k" ||
    /\brates?\b|\bper\s*(?:100\s*k|100,?000|capita)\b/i.test(question);
}

function isHistoricalStateOrNational(contract: QueryContract): boolean {
  return contract.geography.kind === "state" || contract.geography.kind === "national";
}

function isHistoricalLocalRate(contract: QueryContract): boolean {
  return contract.geography.kind === "city" || contract.geography.kind === "agency" || contract.geography.kind === "county";
}

export const SOURCE_CAPABILITY_RULES: SourceCapabilityRule[] = [
  {
    id: "current-countywide-crosswalk",
    source: "current",
    severity: "warning",
    requiresAnyTables: ["agency_county_crosswalk"],
    when: ({ question, contract }) => asksCountywideGeography(question, contract),
    message: "Current countywide geography should use agency_county_crosswalk; a county agency row is not a countywide rollup.",
  },
  {
    id: "nibrs-weapon-person-crime-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_victim_weapon"],
    forbidsTables: ["summary_victim_city_monthly", "summary_victim_state_monthly", "summary_victim_demographics"],
    when: ({ question, contract }) =>
      asksWeaponQualifiedPersonCrime(question, contract) &&
      !hasDemographicBreakdown(contract, question) &&
      !hasCircumstanceBreakdown(question, contract),
    message: "Weapon-only NIBRS person-crime victim counts and trends must use summary_victim_weapon; demographics summaries are only for race/sex/age/ethnicity breakdowns.",
  },
  {
    id: "nibrs-weapon-demographic-person-crime-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_victim_demographics"],
    forbidsTables: ["summary_victim_city_monthly", "summary_victim_state_monthly", "summary_victim_weapon"],
    when: ({ question, contract }) =>
      asksWeaponQualifiedPersonCrime(question, contract) &&
      hasDemographicBreakdown(contract, question) &&
      !hasCircumstanceBreakdown(question, contract),
    message: "NIBRS weapon-qualified victim demographic breakdowns should use summary_victim_demographics.",
  },
  {
    id: "nibrs-weapon-circumstance-person-crime-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_victim_weapon_circumstance", "summary_victim_weapon_circumstance_demo"],
    forbidsTables: ["summary_victim_city_monthly", "summary_victim_state_monthly", "summary_victim_demographics", "summary_victim_weapon"],
    when: ({ question, contract }) =>
      asksWeaponQualifiedPersonCrime(question, contract) &&
      hasCircumstanceBreakdown(question, contract) &&
      !hasDemographicBreakdown(contract, question),
    message: "NIBRS queries combining weapon and circumstance should use summary_victim_weapon_circumstance.",
  },
  {
    id: "nibrs-weapon-circumstance-demographic-person-crime-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_victim_weapon_circumstance_demo"],
    forbidsTables: ["summary_victim_city_monthly", "summary_victim_state_monthly", "summary_victim_demographics", "summary_victim_weapon", "summary_victim_weapon_circumstance"],
    when: ({ question, contract }) =>
      asksWeaponQualifiedPersonCrime(question, contract) &&
      hasCircumstanceBreakdown(question, contract) &&
      hasDemographicBreakdown(contract, question),
    message: "NIBRS queries combining weapon, circumstance, and demographic breakdowns should use summary_victim_weapon_circumstance_demo.",
  },
  {
    id: "nibrs-clearance-weapon-unsupported",
    source: "nibrs",
    severity: "unsupported",
    when: ({ question, contract }) => asksClearanceMetric(question, contract) && asksWeaponQualifiedPersonCrime(question, contract),
    message: "NIBRS cannot calculate clearance rates broken down by weapon type from the available summaries. Offer overall clearance rates or weapon-specific counts instead.",
  },
  {
    id: "nibrs-carjacking-clearance-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_carjacking_clearance"],
    when: ({ question, contract }) => asksClearanceMetric(question, contract) && contract.metric.topic === "carjacking",
    message: "NIBRS carjacking clearance queries should use summary_carjacking_clearance.",
  },
  {
    id: "nibrs-clearance-type-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_clearance_type", "summary_clearance_detail", "summary_victim_clearance_demographics", "summary_victim_circumstance_clearance_demo"],
    forbidsTables: ["summary_city_monthly", "summary_state_monthly", "summary_victim_city_monthly", "summary_victim_state_monthly"],
    when: ({ question, contract }) => asksClearanceMetric(question, contract) && asksClearanceType(question),
    message: "NIBRS arrest-vs-exceptional or exceptional-clearance questions should use a clearance-detail summary table, not ordinary offense-count summaries.",
  },
  {
    id: "nibrs-campus-agency-resolution",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["agencies"],
    when: ({ question, contract }) => asksCampusAgency(question, contract),
    message: "NIBRS campus/university questions should resolve campus agency ORIs through agencies rather than using the surrounding citywide agency.",
  },
  {
    id: "nibrs-countywide-crosswalk",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["agency_county_crosswalk"],
    forbidsTables: ["county_lookup"],
    when: ({ question, contract }) => asksCountywideGeography(question, contract) && !hasDemographicBreakdown(contract, question),
    message: "NIBRS countywide geography should use agency_county_crosswalk, not county_lookup or a single county agency.",
  },
  {
    id: "nibrs-countywide-demographics-unsupported",
    source: "nibrs",
    severity: "unsupported",
    when: ({ question, contract }) => asksCountywide(question, contract) && hasDemographicBreakdown(contract, question),
    message: "Countywide NIBRS demographic breakdowns are unsupported because county totals combine agencies with varying participation and completeness.",
  },
  {
    id: "nibrs-continuous-reporters-range-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["nibrs_consistent_reporters"],
    when: ({ contract }) => contract.comparability.continuousReporters,
    message: "Continuous-reporter NIBRS queries should use nibrs_consistent_reporters for the requested year range.",
  },
  {
    id: "nibrs-demographic-breakdown-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: [
      "summary_victim_demographics",
      "summary_offender_demographics",
      "summary_arrestee_demographics",
      "summary_carjacking_victim_demographics",
      "summary_carjacking_offender_demographics",
      "summary_carjacking_arrestee_demographics",
      "summary_domestic_violence",
      "summary_dv_arrests",
    ],
    when: ({ question, contract }) => !asksCountywide(question, contract) && hasDemographicBreakdown(contract, question),
    message: "NIBRS demographic breakdowns should use a demographic-capable summary table.",
  },
  {
    id: "historical-countywide-crosswalk",
    source: "historical",
    severity: "warning",
    requiresAnyTables: ["agency_county_crosswalk"],
    when: ({ question, contract }) => asksCountywideGeography(question, contract),
    message: "Historical countywide geography should use agency_county_crosswalk; a county agency row is not a countywide rollup.",
  },
  {
    id: "historical-clearance-table",
    source: "historical",
    severity: "warning",
    requiresAnyTables: ["national_clearance_rate", "historical_agency_clearance"],
    when: ({ contract }) => contract.metric.unit === "clearance_rate",
    message: "Historical clearance-rate questions should use national_clearance_rate or historical_agency_clearance.",
  },
  {
    id: "historical-state-national-rate-table",
    source: "historical",
    severity: "warning",
    requiresAnyTables: ["historical_state_national"],
    when: ({ contract, question }) => asksHistoricalRate(contract, question) && isHistoricalStateOrNational(contract),
    message: "Historical state or national rate questions should use historical_state_national, not agency aggregation.",
  },
  {
    id: "historical-local-rate-population",
    source: "historical",
    severity: "warning",
    requiresAnyTables: ["historical_agency_population"],
    when: ({ contract, question, tables }) =>
      asksHistoricalRate(contract, question) &&
      isHistoricalLocalRate(contract) &&
      hasAnyTable(tables, ["historical_agency_crime", "historical_staffing"]),
    message: "Historical local rate questions need historical_agency_population for the denominator.",
  },
  {
    id: "historical-rate-null-gaps",
    source: "historical",
    severity: "warning",
    forbiddenSql: [/\b(?:COALESCE|IFNULL)\s*\(\s*(?:\w+\.)?(?:murder|rape|robbery|assault|violent|property|burglary|theft|motor_vehicle_theft|population|all_total|officer_total|civilian_total)\s*,\s*(?:0|0\.0|1|1\.0)\s*\)/i],
    when: ({ contract, question }) => asksHistoricalRate(contract, question),
    message: "Historical rate time series should preserve missing values as NULL rather than zero-filling numerator or denominator fields.",
  },
  {
    id: "shr-campus-agency-resolution",
    source: "shr",
    severity: "warning",
    requiresAnyTables: ["shr_agency_alias"],
    when: ({ question, contract }) => asksCampusAgency(question, contract),
    message: "SHR campus/university questions should resolve the campus agency through shr_agency_alias rather than using the surrounding citywide agency.",
  },
  {
    id: "shr-countywide-crosswalk",
    source: "shr",
    severity: "warning",
    requiresAnyTables: ["agency_county_crosswalk"],
    when: ({ question, contract }) => asksCountywideGeography(question, contract),
    message: "SHR countywide geography should use agency_county_crosswalk; a county sheriff agency is not a countywide rollup.",
  },
  {
    id: "shr-homicide-only",
    source: "shr",
    severity: "warning",
    requiresAnyTables: ["incidents", "victims"],
    when: ({ contract }) => contract.metric.topic === "murder" || contract.metric.topic === "unknown",
    message: "SHR answers should be homicide-specific and count victims through incidents joined to victims.",
  },
  {
    id: "shr-demographic-rate-unsupported",
    source: "shr",
    severity: "unsupported",
    when: ({ contract }) => contract.metric.unsupportedReason === "demographic_rate_denominator_unavailable",
    message: "SHR demographic rates are unsupported because matching demographic population denominators are not available.",
  },
  {
    id: "shr-state-rate-population",
    source: "shr",
    severity: "warning",
    requiresAnyTables: ["state_population"],
    when: ({ contract }) => contract.metric.unit === "rate_per_100k" && (contract.geography.kind === "state" || contract.geography.kind === "national"),
    message: "SHR state or national rates should use state_population for the denominator.",
  },
  {
    id: "current-rate-population",
    source: "current",
    severity: "warning",
    requiresAnyTables: ["agency_population"],
    when: ({ contract }) => contract.metric.unit === "rate_per_100k",
    message: "Current Trends rate questions should use agency_population for the denominator.",
  },
];

export function validateSourceCapabilities(opts: {
  question: string;
  source: QueryContractSource;
  contract: QueryContract;
  sql: string;
}): SourceCapabilityFinding[] {
  const actualTables = extractReferencedTables(opts.sql).map((table) => table.toLowerCase());
  const tables = new Set(actualTables);
  const findings: SourceCapabilityFinding[] = [];

  for (const rule of SOURCE_CAPABILITY_RULES) {
    if (rule.source !== opts.source) continue;
    const ctx: RuleContext = {
      question: opts.question,
      source: opts.source,
      contract: opts.contract,
      sql: opts.sql,
      tables,
    };
    if (!rule.when(ctx)) continue;

    const missingRequired = rule.requiresAnyTables && !hasAnyTable(tables, rule.requiresAnyTables);
    const hasForbidden = rule.forbidsTables && hasForbiddenTable(tables, rule.forbidsTables);
    const forbiddenSql = usesForbiddenSql(opts.sql, rule.forbiddenSql);
    const unsupported = rule.severity === "unsupported";

    if (unsupported || missingRequired || hasForbidden || forbiddenSql) {
      findings.push({
        ruleId: rule.id,
        source: rule.source,
        severity: rule.severity,
        message: rule.message,
        expectedTables: rule.requiresAnyTables,
        forbiddenTables: rule.forbidsTables,
        actualTables,
      });
    }
  }

  return findings;
}
