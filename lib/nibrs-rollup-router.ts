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

export interface NibrsRollupAvailability {
  path: string | null;
  available: boolean;
  reason: string;
}

function readGeneration(filePath: string): string | null {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Fail closed when the source has changed or its generation no longer matches. */
export function inspectNibrsRollupAvailability(): NibrsRollupAvailability {
  const configured = process.env.NIBRS_ROLLUP_DB_PATH?.trim();
  if (!configured) return { path: null, available: false, reason: "rollup-unconfigured" };
  const resolved = path.resolve(configured);
  try {
    const rollupStat = fs.statSync(resolved);
    if (rollupStat.size <= 0) return { path: null, available: false, reason: "rollup-empty" };

    const sourcePath = process.env.NIBRS_DB_PATH?.trim();
    if (sourcePath) {
      const sourceStat = fs.statSync(path.resolve(sourcePath));
      if (sourceStat.mtimeMs > rollupStat.mtimeMs) {
        return { path: null, available: false, reason: "source-newer-than-rollup" };
      }
    }

    const sourceGenerationPath = process.env.NIBRS_SOURCE_GENERATION_PATH?.trim();
    if (sourceGenerationPath) {
      const sourceGeneration = readGeneration(path.resolve(sourceGenerationPath));
      const target = fs.realpathSync(resolved);
      const rollupGeneration = readGeneration(`${target}.generation`);
      if (!sourceGeneration || !rollupGeneration) {
        return { path: null, available: false, reason: "generation-missing" };
      }
      if (sourceGeneration !== rollupGeneration) {
        return { path: null, available: false, reason: "generation-mismatch" };
      }
    }
    return { path: resolved, available: true, reason: "rollup-current" };
  } catch {
    return { path: null, available: false, reason: "rollup-or-source-missing" };
  }
}

export function resolveNibrsRollupPath(): string | null {
  return inspectNibrsRollupAvailability().path;
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
