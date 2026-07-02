import { buildQueryContract, type QueryContractSource } from "./query-contract";
import type { RoutingLogMeta } from "./routing-log-meta";

export interface QueryContractSqlValidation {
  sql: string;
  fired: string[];
  warnings: string[];
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

export function validateQueryContractSql(opts: {
  question: string;
  source: QueryContractSource;
  sql: string;
  routingMeta?: RoutingLogMeta | null;
}): QueryContractSqlValidation {
  const contract = buildQueryContract(opts.question, opts.source, opts.routingMeta);
  if (!contract) return { sql: opts.sql, fired: [], warnings: [] };

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

  if (
    requestedState &&
    (contract.geography.kind === "city" || contract.geography.kind === "county" || contract.geography.kind === "campus") &&
    /\b(?:agency_monthly|historical_agency|historical_agency_crime|summary_\w+|incidents)\b/i.test(sql) &&
    !hasStateFilter(sql)
  ) {
    warnings.push("contract-geography-state-missing");
  }

  return { sql, fired, warnings };
}
