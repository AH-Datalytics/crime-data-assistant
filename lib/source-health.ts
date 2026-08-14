import type { CheckState, SourceHealth, SourceId } from "./proof-contract";
import { policyIsComplete, type UnvalidatedPolicy } from "./capability-policy";
import type { CapabilitySpec, Db, OpenedDatabase, TableRequirement } from "./source-health-inventory";

export type HealthBoundary =
  | "no_database" | "preflight_failed" | "artifact_mismatch" | "table_missing" | "column_missing"
  | "row_bounds" | "dependency" | "policy_incomplete" | "missing_receipt" | "threw"
  | "budget_zero" | "budget_exceeded";

export type HealthTrace = {
  sourceId: SourceId;
  capability: string;
  dbIdentity: string;
  dbPath: string | null;
  preflight: "skipped" | "ok" | "failed";
  tablesChecked: string[];
  dependenciesChecked: string[];
  coverage: CheckState;
  boundary: HealthBoundary;
};

export type HealthContext = {
  sourceId: SourceId;
  requestedYears: number[] | null;
  dbOverride?: OpenedDatabase | null;
};

const handleIds = new WeakMap<object, number>();
let nextHandleId = 1;

export function identityOf(db: object | null): string {
  if (!db) return "no-db";
  let id = handleIds.get(db);
  if (id === undefined) {
    id = nextHandleId++;
    handleIds.set(db, id);
  }
  return `h${id}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(table: string): string {
  return table.split(".").map(quoteIdentifier).join(".");
}

function columnsOf(db: Db, table: string): Set<string> | null {
  try {
    const parts = table.split(".");
    const pragma = parts.length === 2
      ? `PRAGMA ${quoteIdentifier(parts[0])}.table_info(${quoteIdentifier(parts[1])})`
      : `PRAGMA table_info(${quoteIdentifier(table)})`;
    const rows = db.prepare(pragma).all() as { name: string }[];
    return rows.length === 0 ? null : new Set(rows.map((row) => row.name));
  } catch {
    return null;
  }
}

function rowCount(db: Db, table: string): number | null {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${qualifiedTable(table)}`).get() as { n: number }).n;
  } catch {
    return null;
  }
}

function structuralRequirements(spec: CapabilitySpec): TableRequirement[] {
  const byName = new Map<string, TableRequirement>();
  for (const requirement of [...spec.tables, ...spec.preparationTables]) {
    const prior = byName.get(requirement.name);
    if (!prior) {
      byName.set(requirement.name, requirement);
      continue;
    }
    byName.set(requirement.name, {
      name: requirement.name,
      requiredColumns: [...new Set([...prior.requiredColumns, ...requirement.requiredColumns])],
      minRows: Math.max(prior.minRows, requirement.minRows),
    });
  }
  return [...byName.values()];
}

function coverageFor(spec: CapabilitySpec, db: Db, requestedYears: number[] | null): CheckState {
  const coverage = spec.policy?.coverage;
  if (!coverage) return "unknown";
  if (!requestedYears || requestedYears.length === 0) return "not_applicable";
  try {
    const bounds = db.prepare(
      `SELECT MIN(${quoteIdentifier(coverage.yearColumn)}) AS lo, ` +
      `MAX(${quoteIdentifier(coverage.yearColumn)}) AS hi FROM ${qualifiedTable(coverage.table)}`,
    ).get() as { lo: number | null; hi: number | null };
    if (bounds.lo === null || bounds.hi === null) return "unknown";
    return requestedYears.every((year) => year >= bounds.lo! && year <= bounds.hi!) ? "passed" : "failed";
  } catch {
    return "unknown";
  }
}

export function evaluateCapability(
  spec: CapabilitySpec,
  context: HealthContext,
): { health: SourceHealth; trace: HealthTrace } {
  let opened: OpenedDatabase | null;
  try {
    opened = context.dbOverride !== undefined ? context.dbOverride : spec.database.acquire();
  } catch (error) {
    return terminal(spec, context.sourceId, null, "unknown", `database acquisition threw: ${(error as Error).message}`, "threw");
  }

  const db = opened?.db ?? null;
  const result = terminal(spec, context.sourceId, opened, "unknown", null, "no_database");
  const { trace } = result;
  const done = (
    state: SourceHealth["state"], reason: string | null, boundary: HealthBoundary,
  ): { health: SourceHealth; trace: HealthTrace } => {
    trace.boundary = boundary;
    result.health.state = state;
    result.health.reason = reason;
    result.health.requestedCoverage = trace.coverage;
    return result;
  };

  if (!db) return done("unknown", "no database handle available from the capability provider", "no_database");

  for (const table of structuralRequirements(spec)) {
    const columns = columnsOf(db, table.name);
    if (columns === null) return done("degraded", `required table ${table.name} is missing`, "table_missing");
    const absent = table.requiredColumns.filter((column) => !columns.has(column));
    if (absent.length > 0) {
      return done("degraded", `table ${table.name} is missing required column(s): ${absent.join(", ")}`, "column_missing");
    }
    const rows = rowCount(db, table.name);
    if (rows === null) return done("degraded", `required table ${table.name} could not be read`, "table_missing");
    if (rows < table.minRows) {
      return done("degraded", `table ${table.name} has ${rows} rows, below the required ${table.minRows}`, "row_bounds");
    }
    trace.tablesChecked.push(table.name);
  }

  if (!policyIsComplete(spec.policy as UnvalidatedPolicy | null)) {
    return done("unknown", "capability policy is absent or incomplete", "policy_incomplete");
  }

  trace.coverage = coverageFor(spec, db, context.requestedYears);
  return done("unknown", `no build receipt from ${spec.policy!.receiptOwner}; Stage 2B supplies it`, "missing_receipt");
}

function terminal(
  spec: CapabilitySpec,
  sourceId: SourceId,
  opened: OpenedDatabase | null,
  state: SourceHealth["state"],
  reason: string | null,
  boundary: HealthBoundary,
): { health: SourceHealth; trace: HealthTrace } {
  const trace: HealthTrace = {
    sourceId,
    capability: spec.capabilityId,
    dbIdentity: identityOf(opened?.db as object | null),
    dbPath: opened?.resolvedPath ?? null,
    preflight: "skipped",
    tablesChecked: [],
    dependenciesChecked: [],
    coverage: "unknown",
    boundary,
  };
  return {
    health: {
      sourceId,
      capability: spec.capabilityId,
      state,
      reason,
      dataVersion: null,
      requestedCoverage: trace.coverage,
    },
    trace,
  };
}
