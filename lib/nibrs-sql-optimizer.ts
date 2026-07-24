/** Apply conservative SQLite index hints and compact-rollup routing. */

import { routeNibrsRollupSql } from "./nibrs-rollup-router";

interface HintRule {
  table: string;
  oriIndex: string;
}

const ORI_SCOPED_RULES: HintRule[] = [
  { table: "summary_clearance_type", oriIndex: "idx_sct_ori_year" },
  { table: "summary_clearance_detail", oriIndex: "idx_scd_ori_year" },
  { table: "summary_city_monthly", oriIndex: "idx_scm_ori_year" },
  { table: "summary_victim_city_monthly", oriIndex: "idx_svcm_ori" },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasOriScope(sql: string, alias: string): boolean {
  const qualified = new RegExp(`\\b${escapeRegExp(alias)}\\.ori\\s*(?:=|IN\\s*\\(|IS\\s+)`, "i");
  if (qualified.test(sql)) return true;
  const oriJoin = new RegExp(
    `\\b(?:ON|AND)\\s+(?:\\w+\\.ori\\s*=\\s*${escapeRegExp(alias)}\\.ori|${escapeRegExp(alias)}\\.ori\\s*=\\s*\\w+\\.ori)`,
    "i"
  );
  const selectiveAgencyPredicate =
    /\b(?:city|agency)\s*=\s*'[^']+'/i.test(sql) ||
    /\bpop_group\s+(?:LIKE|=)\s*'[^']+'/i.test(sql);
  return oriJoin.test(sql) && selectiveAgencyPredicate;
}

function addIndexHint(sql: string, table: string, index: string): string {
  if (new RegExp(`\\b${escapeRegExp(table)}\\b[^;]*?\\bINDEXED\\s+BY\\b`, "i").test(sql)) return sql;
  const tablePattern = escapeRegExp(table);
  const withAlias = new RegExp(
    `\\b(FROM|JOIN)\\s+(${tablePattern})\\s+(AS\\s+)?(?!WHERE\\b|JOIN\\b|LEFT\\b|RIGHT\\b|INNER\\b|OUTER\\b|CROSS\\b|ON\\b|GROUP\\b|ORDER\\b|LIMIT\\b|INDEXED\\b)([A-Za-z_][A-Za-z0-9_]*)`,
    "i"
  );
  const aliasMatch = sql.match(withAlias);
  if (aliasMatch) {
    const alias = aliasMatch[4];
    if (!hasOriScope(sql, alias)) return sql;
    return sql.replace(
      withAlias,
      (_full, keyword: string, matchedTable: string, asToken: string | undefined, matchedAlias: string) =>
        `${keyword} ${matchedTable} ${asToken ?? ""}${matchedAlias} INDEXED BY ${index}`
    );
  }
  const withoutAlias = new RegExp(`\\b(FROM|JOIN)\\s+(${tablePattern})\\b`, "i");
  if (!withoutAlias.test(sql) || !/\bori\s*(?:=|IN\s*\()/i.test(sql)) return sql;
  return sql.replace(withoutAlias, `$1 $2 INDEXED BY ${index}`);
}

export function optimizeNibrsSql(sql: string): string {
  let optimized = sql;
  for (const rule of ORI_SCOPED_RULES) optimized = addIndexHint(optimized, rule.table, rule.oriIndex);
  return routeNibrsRollupSql(optimized).sql;
}
