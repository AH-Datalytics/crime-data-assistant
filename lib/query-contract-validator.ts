import { buildQueryContract, type QueryContractSource } from "./query-contract";
import type { RoutingLogMeta } from "./routing-log-meta";
import { validateSourceCapabilities, type SourceCapabilityFinding } from "./source-capabilities";

export interface QueryContractSqlValidation {
  sql: string;
  fired: string[];
  warnings: string[];
  capabilityFindings: SourceCapabilityFinding[];
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
  if (!contract) return { sql: opts.sql, fired: [], warnings: [], capabilityFindings: [] };

  let sql = opts.sql;
  const fired: string[] = [];
  const warnings: string[] = [];

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

  const capabilityFindings = validateSourceCapabilities({
    question: opts.question,
    source: opts.source,
    contract,
    sql,
  });
  for (const finding of capabilityFindings) {
    warnings.push(`capability-${finding.ruleId}`);
  }

  return { sql, fired, warnings: [...new Set(warnings)], capabilityFindings };
}
