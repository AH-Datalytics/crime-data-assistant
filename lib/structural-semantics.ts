import type { QueryContract, QueryContractSource } from "./query-contract";
import { extractReferencedTables } from "./table-allowlist";
import {
  catalogedTables,
  isFinerThan,
  metricTables,
  tableSemantics,
  type EntityLevel,
  type TableSemantics,
} from "./table-semantics";

/**
 * Compare what was asked for against what the chosen tables can actually represent, before the SQL
 * runs.
 *
 * `source-capabilities.ts` already pairs specific question shapes with forbidden tables, and those
 * rules do catch Denver, New York City, Alameda County and the Los Angeles measure substitution --
 * verified against HEAD before any of this was written. What they cannot catch is a shape nobody
 * wrote a rule for, and two such shapes are confirmed in production:
 *
 *   "What is the clearance rate for rape in Florida by year?"
 *       -> national_clearance_rate, which has no state column. No rule fires. Asked three times,
 *          wrong three times.
 *
 *   "top 10 us cities by homicide rate in 2021"
 *       -> ten *states* from historical_state_national, captioned as such and still presented as
 *          the answer. No rule fires, because the contract reads "us" as a national geography and
 *          finds no breakdown, so nothing knows the user asked for a list of cities.
 *
 * Both are the same defect at a level the old rules do not model: the entity a returned ROW
 * represents. This module derives that from the request, reads it from the catalog for the tables
 * the SQL actually touches, and compares them.
 */

export type StructuralSeverity = "block" | "retry";

export type StructuralFinding = {
  ruleId: string;
  severity: StructuralSeverity;
  message: string;
  /** What the user asked for, and what the chosen tables can give -- for the retry directive. */
  requestedLevel: EntityLevel;
  tableLevels: { table: string; rowLevel: EntityLevel }[];
};

export type RequestedScope = {
  /** The entity one row of a correct answer would represent. */
  rowLevel: EntityLevel;
  /** Why -- so a retry directive can quote it and a test can assert on it. */
  evidence: string;
  unit: QueryContract["metric"]["unit"];
  grain: "monthly" | "annual" | null;
};

/**
 * A request can name a place to filter by and a different level to break out by. "Top 10 US cities"
 * filters nationally and returns cities. The place is `contract.geography`; this finds the breakout.
 *
 * Ordered finest-first so "cities in California" reads as city, not state.
 */
const ROW_LEVEL_CUES: { level: EntityLevel; pattern: RegExp; label: string }[] = [
  {
    level: "agency",
    label: "asks for a list of agencies or departments",
    pattern: /\b(?:top|bottom|best|worst|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all)\b[^.?!]{0,40}\b(?:agenc(?:y|ies)|police\s+departments?|sheriff'?s?\s+offices?)\b|\bby\s+agenc(?:y|ies)\b|\bagenc(?:y|ies)\s+(?:with|that|ranked)\b/i,
  },
  {
    level: "city",
    label: "asks for a list of cities",
    pattern: /\b(?:top|bottom|best|worst|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all|safest|deadliest)\b[^.?!]{0,40}\bcit(?:y|ies)\b|\bby\s+cit(?:y|ies)\b|\bcit(?:y|ies)\s+(?:with|that|ranked|had|have)\b/i,
  },
  {
    level: "county",
    label: "asks for a list of counties",
    pattern: /\b(?:top|bottom|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all)\b[^.?!]{0,40}\b(?:count(?:y|ies)|parish(?:es)?)\b|\bby\s+count(?:y|ies)\b|\bcount(?:y|ies)\s+(?:with|that|ranked)\b/i,
  },
  {
    level: "state",
    label: "asks for a list of states",
    pattern: /\b(?:top|bottom|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all)\b[^.?!]{0,40}\bstates?\b|\bby\s+state\b|\bstates?\s+(?:with|that|ranked)\b/i,
  },
];

const GEOGRAPHY_TO_LEVEL: Record<QueryContract["geography"]["kind"], EntityLevel> = {
  city: "city",
  county: "county",
  state: "state",
  agency: "agency",
  campus: "agency",
  national: "national",
  unknown: "unknown",
};

export function requestedScope(question: string, contract: QueryContract): RequestedScope {
  const grain = /\b(?:by|per|each)\s+month\b|\bmonthly\b/i.test(question)
    ? "monthly"
    : /\b(?:by|per|each)\s+year\b|\bannual(?:ly)?\b|\byearly\b/i.test(question)
      ? "annual"
      : null;

  // An explicit breakout beats the filtering geography. This is the "top 10 us cities" case:
  // geography reads national, but every returned row must be a city.
  for (const cue of ROW_LEVEL_CUES) {
    if (cue.pattern.test(question)) {
      return { rowLevel: cue.level, evidence: cue.label, unit: contract.metric.unit, grain };
    }
  }
  for (const breakdown of contract.breakdowns) {
    if (breakdown === "city" || breakdown === "state" || breakdown === "agency") {
      return {
        rowLevel: breakdown as EntityLevel,
        evidence: `contract breakdown "${breakdown}"`,
        unit: contract.metric.unit,
        grain,
      };
    }
  }
  return {
    rowLevel: GEOGRAPHY_TO_LEVEL[contract.geography.kind],
    evidence: `requested geography is ${contract.geography.kind}`,
    unit: contract.metric.unit,
    grain,
  };
}

function describe(entries: TableSemantics[]): { table: string; rowLevel: EntityLevel }[] {
  return entries.map((entry) => ({ table: entry.table, rowLevel: entry.rowLevel }));
}

/** Can this table be restricted to, or broken out at, the requested level? */
function serves(entry: TableSemantics, level: EntityLevel): boolean {
  if (level === "unknown") return true;
  if (entry.filterLevels.includes(level)) return true;
  return !isFinerThan(level, entry.rowLevel);
}

/**
 * Can this table carry the requested measure at the requested level?
 *
 * Level alone is not enough. `historical_agency_clearance` has agency rows, so by level it could be
 * rolled up to a state -- but it stores percentages with no components, so rolling it up is exactly
 * the invalid operation. And a count table can serve a rate as long as the source has a population
 * table, which is how Denver's rate is legitimately built.
 */
function canServe(entry: TableSemantics, scope: RequestedScope, source: QueryContractSource): boolean {
  if (entry.role !== "metric") return false;
  if (!serves(entry, scope.rowLevel)) return false;

  const lacksComponents = (entry.unknown ?? []).some((item) => /denominator|cleared count/i.test(item));
  if (lacksComponents && !entry.filterLevels.includes(scope.rowLevel)) return false;

  switch (scope.unit) {
    case "clearance_rate":
      return entry.measures.includes("clearance_rate");
    case "rate_per_100k":
      if (entry.measures.includes("rate_per_100k")) return true;
      if (!entry.measures.includes("count")) return false;
      return catalogedTables(source).some(
        (other) => other.role === "population" && serves(other, scope.rowLevel)
      );
    default:
      return entry.measures.includes("count") || entry.measures.includes("rate_per_100k");
  }
}

/**
 * Is the mismatch repairable -- does this source hold ANY table that could answer the request?
 *
 * This decides retry versus block, and the distinction matters. Denver asked for city rates and got
 * state rows, but `historical_agency_crime` joined to `historical_agency_population` answers it, so
 * the model deserves one chance to rewrite. Florida asked for a statewide clearance rate and no
 * table in the source can produce one at any level, so retrying only wastes a turn before the same
 * decline. Blocking a repairable case would cut answer coverage for no correctness gain.
 */
function repairable(scope: RequestedScope, source: QueryContractSource): boolean {
  return catalogedTables(source).some((entry) => canServe(entry, scope, source));
}

export function evaluateStructuralSemantics(opts: {
  question: string;
  source: QueryContractSource;
  contract: QueryContract;
  sql: string;
}): StructuralFinding[] {
  const scope = requestedScope(opts.question, opts.contract);
  const referenced = extractReferencedTables(opts.sql);
  const known = referenced
    .map((table) => tableSemantics(opts.source, table))
    .filter((entry): entry is TableSemantics => entry !== null);

  // An uncatalogued table is not evidence of a mismatch. Silence beats a guess.
  if (known.length === 0) return [];

  const metrics = metricTables(known);
  const findings: StructuralFinding[] = [];

  // ---- 1. The returned rows are a coarser entity than the request ------------------------------
  // Guarded to metric tables: a state population table joined as a denominator is not the answer's
  // grain. And if ANY metric table serves the level, a legitimate multi-level comparison passes.
  if (metrics.length > 0 && scope.rowLevel !== "unknown") {
    const serving = metrics.filter((entry) => serves(entry, scope.rowLevel));
    if (serving.length === 0) {
      const canBeFixed = repairable(scope, opts.source);
      findings.push({
        ruleId: "structural-row-level-substitution",
        severity: canBeFixed ? "retry" : "block",
        requestedLevel: scope.rowLevel,
        tableLevels: describe(metrics),
        message:
          `The request is for ${scope.rowLevel}-level results (${scope.evidence}), but ` +
          `${metrics.map((entry) => `${entry.table} has ${entry.rowLevel}-level rows`).join(" and ")}. ` +
          "A coarser table cannot produce a finer result, and presenting its rows as the requested " +
          "place would name the wrong geography." +
          (canBeFixed
            ? ""
            : ` No table in this source carries ${scope.unit === "unknown" ? "that measure" : scope.unit} ` +
              `at ${scope.rowLevel} level, so this cannot be rewritten -- say so plainly instead.`),
      });
    }
  }

  // ---- 2. A clearance percentage cannot be averaged upward --------------------------------------
  // Historical clearance is stored as per-agency percentages with no cleared counts and no offense
  // denominators anywhere, and observed values run from -125.0 to 12250.0. There is no sound way to
  // roll them into a state or national rate, so the honest outcome is a decline, not an aggregate.
  if (scope.unit === "clearance_rate") {
    for (const entry of metrics) {
      const lacksComponents = (entry.unknown ?? []).some((item) => /denominator|cleared count/i.test(item));
      // Filtering to a level the table supports is selection, not a rollup. Only a level it cannot
      // be filtered to requires combining agencies, which is the invalid step.
      if (lacksComponents && isFinerThan(entry.rowLevel, scope.rowLevel) &&
          !entry.filterLevels.includes(scope.rowLevel)) {
        findings.push({
          ruleId: "structural-clearance-not-aggregatable",
          severity: "block",
          requestedLevel: scope.rowLevel,
          tableLevels: describe([entry]),
          message:
            `${entry.table} stores ${entry.rowLevel}-level clearance percentages with no cleared counts ` +
            `and no offense denominators, so they cannot be combined into a ${scope.rowLevel}-level ` +
            "clearance rate. Report agency-level clearance, or decline.",
        });
      }
    }
  }

  // ---- 3. A directory is not crime data ---------------------------------------------------------
  if (metrics.length === 0 && scope.unit !== "unknown") {
    const identities = known.filter((entry) => entry.role === "identity" || entry.role === "crosswalk");
    if (identities.length > 0) {
      findings.push({
        ruleId: "structural-identity-table-as-metric",
        severity: "retry",
        requestedLevel: scope.rowLevel,
        tableLevels: describe(identities),
        message:
          `The request asks for a ${scope.unit} figure, but the SQL only reads ` +
          `${identities.map((entry) => entry.table).join(", ")}, which ${identities.length > 1 ? "are directories" : "is a directory"}. ` +
          "Counting rows there answers how many agencies exist, not how many offenses occurred.",
      });
    }
  }

  // ---- 4. A rate needs a denominator that is actually present ------------------------------------
  if (scope.unit === "rate_per_100k" && metrics.length > 0) {
    const hasDenominator = known.some((entry) => entry.carriesRateDenominator);
    if (!hasDenominator) {
      findings.push({
        ruleId: "structural-rate-denominator-missing",
        severity: "retry",
        requestedLevel: scope.rowLevel,
        tableLevels: describe(metrics),
        message:
          "A per-capita rate was requested, but none of the referenced tables carries a population " +
          "denominator. Join the population table for this source at the requested level.",
      });
    }
  }

  // ---- 5. The requested time grain has to exist --------------------------------------------------
  if (scope.grain && metrics.length > 0) {
    const supported = metrics.some((entry) => entry.timeGrains.includes(scope.grain as "monthly" | "annual"));
    if (!supported) {
      findings.push({
        ruleId: "structural-time-grain-unavailable",
        severity: "block",
        requestedLevel: scope.rowLevel,
        tableLevels: describe(metrics),
        message:
          `${scope.grain} figures were requested, but ` +
          `${metrics.map((entry) => `${entry.table} carries ${entry.timeGrains.join("/")} data`).join(" and ")}. ` +
          "Say plainly that this source does not hold that period, rather than presenting a different one.",
      });
    }
  }

  return findings;
}

/** Coverage reporting for the catalog, used by the tests and the response document. */
export function catalogCoverage(source: QueryContractSource): {
  tables: number;
  metric: number;
  withUnknowns: number;
} {
  const entries = catalogedTables(source);
  return {
    tables: entries.length,
    metric: entries.filter((entry) => entry.role === "metric").length,
    withUnknowns: entries.filter((entry) => (entry.unknown ?? []).length > 0).length,
  };
}
