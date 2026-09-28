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
  // Only hint when there's an UNqualified ori predicate (a direct filter on
  // this table). A qualified `x.ori = y.ori` join elsewhere in the SQL must
  // not force the ori index onto an unrelated aggregate scan — that pins a
  // ucr/state-filtered state-ranking to the wrong index (production 7618:
  // 16.6s -> 1.2s once the mis-applied hint is removed).
  if (!withoutAlias.test(sql) || !/(?<![\w.])ori\s*(?:=|IN\s*\()/i.test(sql)) return sql;
  return sql.replace(withoutAlias, `$1 $2 INDEXED BY ${index}`);
}

/*
 * REMOVED: a reporting-table substitution that swapped the requested calculation.
 *
 * This function used to rewrite
 *   SELECT ori, COUNT(DISTINCT month) AS months_reported FROM summary_city_monthly WHERE year = Y GROUP BY ori
 * into
 *   SELECT ori, months_reported FROM nibrs_agency_completeness WHERE year = Y
 * on the grounds that the precomputed table saves a monthly rescan.
 *
 * That is only true if the two sources agree, and nothing on this path asserts that they do. The
 * rewrite ran unconditionally and AFTER contract validation, so the statement that executed was not
 * the statement that was checked -- and re-checking the executed text would not have caught it,
 * because the substituted text validates just as cleanly as the original.
 *
 * The rewrite was also not anchored to a whole statement. Its pattern matches inside a CTE or a
 * derived relation, where a reporting-completeness filter selects WHICH AGENCIES a genuine offense
 * aggregate covers. On a fixture where the two sources disagree, "murders in 2024 by agencies
 * reporting all 12 months" changed from 12 to 78 -- a different population, silently, from a
 * rewrite the producer never asked for. Both the original and the substituted form pass validation,
 * so the earlier belief that the validator blocked this shape was wrong: it refuses the bare month
 * count presented as an answer's measure, not the same text used as a filter.
 *
 * So the calculation the producer asked for is now the calculation that runs. The completeness table
 * is still available and still used -- lib/nibrs-completeness.ts and the deterministic queries read
 * it directly, and the NIBRS system prompt teaches it as the denominator form -- but it is chosen by
 * the producer rather than swapped in here. Index hints and rollup routing are unaffected: they are
 * meaning-preserving, and this was not.
 *
 * Removing a shortcut can cost time. No speed claim is made or implied by this change.
 */
export function optimizeNibrsSql(sql: string, rollupAvailable?: boolean): string {
  let optimized = sql;
  for (const rule of ORI_SCOPED_RULES) optimized = addIndexHint(optimized, rule.table, rule.oriIndex);
  return routeNibrsRollupSql(optimized, rollupAvailable ?? undefined).sql;
}
