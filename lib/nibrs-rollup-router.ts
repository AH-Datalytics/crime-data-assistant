import fs from "node:fs";
import path from "node:path";

const ROLLUP_SOURCES = [
  "summary_arrestee_demographics", "summary_victim_demographics",
  "summary_offender_demographics", "summary_victim_relationship",
  "summary_victim_weapon", "summary_victim_circumstance",
  "summary_victim_weapon_circumstance_demo", "summary_clearance_type",
  "summary_clearance_detail",
] as const;

export interface NibrsRollupRoute {
  sql: string;
  routed: boolean;
  level: "state" | "national" | null;
  sourceTable: string | null;
  reason: string;
}

export function resolveNibrsRollupPath(): string | null {
  const configured = process.env.NIBRS_ROLLUP_DB_PATH?.trim();
  if (!configured) return null;
  const resolved = path.resolve(configured);
  try { return fs.statSync(resolved).size > 0 ? resolved : null; } catch { return null; }
}

function stripSqlStrings(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

/** Route only aggregation-safe state/national shapes. */
export function routeNibrsRollupSql(sql: string, rollupAvailable = resolveNibrsRollupPath() !== null): NibrsRollupRoute {
  if (!rollupAvailable) return { sql, routed: false, level: null, sourceTable: null, reason: "rollup-unavailable" };
  if (/\brollup\./i.test(sql)) return { sql, routed: false, level: null, sourceTable: null, reason: "already-routed" };
  const sources = ROLLUP_SOURCES.filter((table) => new RegExp(`\\b(?:FROM|JOIN)\\s+(?:main\\.)?${table}\\b`, "i").test(sql));
  if (sources.length !== 1) {
    return { sql, routed: false, level: null, sourceTable: null, reason: sources.length ? "multiple-rollup-sources" : "unsupported-table" };
  }
  const cleaned = stripSqlStrings(sql);
  if (/\b(?:ori|agencies|agency_county_crosswalk|nibrs_(?:consistent_reporters|agency_completeness)|city|county)\b/i.test(cleaned)) {
    return { sql, routed: false, level: null, sourceTable: sources[0], reason: "agency-or-continuous-scope" };
  }
  const level = /\bstate\b/i.test(cleaned) ? "state" : "national";
  const source = sources[0];
  return {
    sql: sql.replace(new RegExp(`(\\b(?:FROM|JOIN)\\s+)(?:main\\.)?${source}\\b`, "gi"), `$1rollup.${level}_${source}`),
    routed: true, level, sourceTable: source, reason: `${level}-rollup`,
  };
}
