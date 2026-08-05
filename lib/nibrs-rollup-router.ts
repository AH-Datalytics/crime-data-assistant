import fs from "node:fs";
import path from "node:path";
import { clearSchemaValidationCache } from "./schema-validation";

type AttachableDb = {
  // better-sqlite3 has overloaded parameter tuples; this adapter is only used
  // for ATTACH, whose runtime API accepts one path parameter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prepare: (sql: string) => { run: (...args: any[]) => unknown };
  exec: (sql: string) => unknown;
  pragma: (sql: string) => unknown;
};

export interface NibrsRollupContext {
  available: boolean;
  path: string | null;
  reason: string;
  generationKey: string | null;
}

const attachmentState = new WeakMap<object, NibrsRollupContext>();

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

function rollupGenerationKey(rollupPath: string): string {
  const target = fs.realpathSync(rollupPath);
  return `${target}\n${readGeneration(`${target}.generation`) || ""}`;
}

function detachRollup(db: AttachableDb): void {
  try {
    db.exec("DETACH DATABASE rollup");
  } catch {
    // No attachment is the normal first-call state.
  }
}

/** Keep validation and synchronous execution on the same rollup generation. */
export function ensureNibrsRollupAttached(db: AttachableDb): NibrsRollupContext {
  const availability = inspectNibrsRollupAvailability();
  const previous = attachmentState.get(db as object);

  if (!availability.available || !availability.path) {
    if (previous?.available) {
      detachRollup(db);
      clearSchemaValidationCache(db as object);
    }
    const unavailable: NibrsRollupContext = {
      available: false,
      path: null,
      reason: availability.reason,
      generationKey: null,
    };
    attachmentState.set(db as object, unavailable);
    return unavailable;
  }

  const generationKey = rollupGenerationKey(availability.path);
  if (previous?.available && previous.generationKey === generationKey) return previous;

  if (previous?.available) detachRollup(db);
  clearSchemaValidationCache(db as object);
  try {
    db.prepare("ATTACH DATABASE ? AS rollup").run(availability.path);
    db.pragma("query_only = ON");
  } catch (error) {
    detachRollup(db);
    const reason = error instanceof Error ? error.message : String(error);
    const failed: NibrsRollupContext = {
      available: false,
      path: null,
      reason: "rollup-attach-failed",
      generationKey: null,
    };
    attachmentState.set(db as object, failed);
    throw new Error(`NIBRS rollup attachment failed: ${reason}`);
  }

  const attached: NibrsRollupContext = {
    available: true,
    path: availability.path,
    reason: availability.reason,
    generationKey,
  };
  attachmentState.set(db as object, attached);
  return attached;
}

export function nibrsRollupContextForDb(db: object): NibrsRollupContext | null {
  return attachmentState.get(db) ?? null;
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
