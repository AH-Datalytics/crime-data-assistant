import { createHash } from "node:crypto";
import { hasLiteralOriTargetJoin } from "./query-contract-validator";

export type ResolverWarningReview = "unclassified" | "true_positive" | "false_positive" | "whitelisted_safe";

// Hard boundary: observation and classification only. No route may use this
// audit to reject until every warning is reviewed and the false-positive rate
// is below five percent.
export const RESOLVER_WARNING_REJECTION_ENABLED = false;

export const RESOLVER_WARNING_SAFE_SQL_WHITELIST = [
  { id: "literal_ori_target_cte", matches: (sql: string) => hasLiteralOriTargetJoin(sql) },
  {
    id: "literal_ori_predicate",
    matches: (sql: string) => /\b(?:\w+\.)?ori\s*(?:=|IN\s*\()\s*'(?=[A-Z0-9]*\d)[A-Z]{2}[A-Z0-9]{3,10}'/i.test(sql),
  },
] as const;

export function resolverWarningCode(warning: string): string {
  if (/resolved ORI missing/i.test(warning)) return "resolved_ori_missing";
  if (/outside a simple predicate/i.test(warning)) return "agency_predicate_not_rewriteable";
  if (/unresolved agency-name predicate/i.test(warning)) return "unresolved_agency_predicate";
  return "resolver_warning_other";
}

export function normalizedSqlShape(sql: string): string {
  return (sql || "")
    .replace(/'[^']*'/g, "'?'")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

export function warningWhitelistMatch(sql: string): string | null {
  return RESOLVER_WARNING_SAFE_SQL_WHITELIST.find((rule) => rule.matches(sql))?.id ?? null;
}

export function resolverWarningFingerprint(source: string, warning: string, sql: string): string {
  const input = [source.toLowerCase(), resolverWarningCode(warning), normalizedSqlShape(sql)].join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

export function resolverWarningGate(rows: Array<{ classification: ResolverWarningReview }>) {
  const total = rows.length;
  const unclassified = rows.filter((row) => row.classification === "unclassified").length;
  const classifiedRows = rows.filter((row) => row.classification !== "unclassified");
  const falsePositives = classifiedRows.filter((row) =>
    row.classification === "false_positive" || row.classification === "whitelisted_safe"
  ).length;
  const falsePositiveRate = classifiedRows.length > 0 ? falsePositives / classifiedRows.length : null;
  return {
    total, classified: classifiedRows.length, unclassified, falsePositives, falsePositiveRate,
    ready: total > 0 && unclassified === 0 && falsePositiveRate != null && falsePositiveRate < 0.05,
  };
}
