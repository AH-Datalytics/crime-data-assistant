import type { CheckState, SourceHealth, SourceId } from "./proof-contract";
import { coverageBasisErrors, policyIsComplete, type UnvalidatedPolicy } from "./capability-policy";
import path from "node:path";
import { artifactOf } from "./source-artifact";
import { inspectNibrsRollupAvailability } from "./nibrs-rollup-router";
import type { CapabilitySpec, Db, OpenedDatabase, TableRequirement } from "./source-health-inventory";

export type HealthBoundary =
  | "no_database" | "preflight_failed" | "artifact_mismatch" | "table_missing" | "column_missing"
  | "row_bounds" | "dependency" | "semantic_dependency" | "policy_incomplete" | "missing_receipt"
  | "threw" | "budget_zero" | "budget_exceeded";

export type HealthTrace = {
  sourceId: SourceId;
  capability: string;
  dbIdentity: string;
  dbPath: string | null;
  preflight: "skipped" | "ok" | "failed";
  tablesChecked: string[];
  dependenciesChecked: string[];
  semanticChecked: string[];
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

/**
 * A structural read, distinguishing "the table is not there" from "we could not look".
 *
 * Collapsing both into null made every read failure -- a locked database, an unreadable file, an
 * attached schema that is not attached -- report `degraded`, which Task 7 maps onto a FAILED check.
 * That asserts a negative finding about the data when what actually happened is that health could
 * not be determined. `unknown` is the honest state for that, and it is a different verdict: §8
 * treats unknown as degraded at the GATE without rewriting the evidence.
 */
type Read<T> = { kind: "ok"; value: T } | { kind: "threw"; error: string };
/** Only a table lookup can come back "missing"; a row count over a table already found cannot. */
type TableRead<T> = Read<T> | { kind: "missing" };

function columnsOf(db: Db, table: string): TableRead<Set<string>> {
  try {
    const parts = table.split(".");
    const pragma = parts.length === 2
      ? `PRAGMA ${quoteIdentifier(parts[0])}.table_info(${quoteIdentifier(parts[1])})`
      : `PRAGMA table_info(${quoteIdentifier(table)})`;
    const rows = db.prepare(pragma).all() as { name: string }[];
    // table_info returns zero rows for a name that is not a table: absent, not unreadable.
    return rows.length === 0 ? { kind: "missing" } : { kind: "ok", value: new Set(rows.map((row) => row.name)) };
  } catch (error) {
    return { kind: "threw", error: (error as Error).message };
  }
}

/** The file an attached schema actually resolves to, or null when it is not attached. */
function attachedPath(db: Db, schema: string): Read<string | null> {
  try {
    const rows = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
    const entry = rows.find((candidate) => candidate.name === schema);
    return { kind: "ok", value: entry && entry.file ? entry.file : null };
  } catch (error) {
    return { kind: "threw", error: (error as Error).message };
  }
}

/** One row of a query, or the error it threw. Every structural read goes through these two. */
function row<T>(db: Db, sql: string): Read<T> {
  try {
    return { kind: "ok", value: db.prepare(sql).get() as T };
  } catch (error) {
    return { kind: "threw", error: (error as Error).message };
  }
}
function scalar(db: Db, sql: string): Read<number> {
  const result = row<{ n: number }>(db, sql);
  return result.kind === "ok" ? { kind: "ok", value: result.value.n } : result;
}

function rowCount(db: Db, table: string): Read<number> {
  try {
    return { kind: "ok", value: (db.prepare(`SELECT COUNT(*) AS n FROM ${qualifiedTable(table)}`).get() as { n: number }).n };
  } catch (error) {
    return { kind: "threw", error: (error as Error).message };
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
  /**
   * The basis must be a table AND column this capability actually reads -- checked as a pair.
   *
   * Guarding the table alone still let an existing but unrequired column on a legitimate emitted
   * table produce a confident verdict from data the capability never reads. A basis outside the
   * emitted contract is a policy-authoring error for Stage 2B review, not something to tolerate at
   * runtime, so the same rule is applied by the registry regression via coverageBasisErrors.
   */
  if (coverageBasisErrors(spec.policy as UnvalidatedPolicy | null, spec.tables).length > 0) return "unknown";
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
  /**
   * Ownership is settled BEFORE a handle is acquired.
   *
   * Placed after acquisition, this guard was unreachable for exactly the cases that matter: a
   * mismatched source whose provider returned nothing exited at `no_database`, and one whose
   * provider threw exited at `threw` -- both traces attributed to a caller source that does not own
   * the artifact. Whether attribution is truthful cannot depend on whether a database happened to be
   * obtainable. Checking first also means no handle is opened for a capability the caller was never
   * entitled to evaluate.
   */
  if (artifactOf(context.sourceId) !== spec.artifact) {
    return terminal(spec, context.sourceId, null, "unknown",
      `capability ${spec.capabilityId} belongs to ${spec.artifact}, not to ${context.sourceId}`,
      "artifact_mismatch");
  }

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

  /**
   * Preflight, DERIVED from the contract rather than authored: a capability that reads a `rollup.`
   * table needs the rollup artifact configured and coherent with the handle being evaluated.
   *
   * Two distinct failures, and the seam between them matters. The inspector reads the CONFIGURED
   * path while the table checks read the PROVIDER's handle; if those are different files the verdict
   * is incoherent -- structure would be judged against one database and availability against
   * another. The inspector's own reason is surfaced verbatim rather than re-derived, so a finding it
   * already made is not restated in weaker words.
   */
  if (spec.tables.some((table) => table.name.startsWith("rollup."))) {
    const availability = inspectNibrsRollupAvailability();
    if (!availability.available) {
      trace.preflight = "failed";
      return done("degraded", `rollup preflight failed: ${availability.reason}`, "preflight_failed");
    }
    const attached = attachedPath(db, "rollup");
    if (attached.kind === "threw") {
      return done("unknown", `attached rollup path could not be read: ${attached.error}`, "threw");
    }
    if (attached.value === null) {
      trace.preflight = "failed";
      return done("degraded", "the handle has no rollup schema attached, so rollup tables cannot be checked", "preflight_failed");
    }
    if (path.resolve(attached.value) !== path.resolve(availability.path!)) {
      trace.preflight = "failed";
      return done("degraded",
        `the handle's rollup schema is ${attached.value} but the configured rollup is ${availability.path}; ` +
        "structure and availability would be judged against different files",
        "artifact_mismatch");
    }
    trace.preflight = "ok";
  }

  for (const table of structuralRequirements(spec)) {
    const columns = columnsOf(db, table.name);
    if (columns.kind === "threw") {
      return done("unknown", `table ${table.name} could not be read: ${columns.error}`, "threw");
    }
    if (columns.kind === "missing") return done("degraded", `required table ${table.name} is missing`, "table_missing");
    const absent = table.requiredColumns.filter((column) => !columns.value.has(column));
    if (absent.length > 0) {
      return done("degraded", `table ${table.name} is missing required column(s): ${absent.join(", ")}`, "column_missing");
    }
    const rows = rowCount(db, table.name);
    if (rows.kind === "threw") {
      return done("unknown", `row count for ${table.name} could not be read: ${rows.error}`, "threw");
    }
    if (rows.value < table.minRows) {
      return done("degraded", `table ${table.name} has ${rows.value} rows, below the required ${table.minRows}`, "row_bounds");
    }
    trace.tablesChecked.push(table.name);
  }

  /**
   * Derived tables must agree with the upstream they were built from.
   *
   * `keyColumn` is read off the rule, not inferred from the first required column: taking a
   * positional column as a semantic join key makes the relationship depend on alphabetical ordering.
   */
  for (const rule of spec.dependencies) {
    const key = quoteIdentifier(rule.keyColumn);
    const orphans = scalar(db, `SELECT COUNT(*) AS n FROM ${qualifiedTable(rule.derived)} d ` +
      `WHERE NOT EXISTS (SELECT 1 FROM ${qualifiedTable(rule.upstream)} u WHERE u.${key} = d.${key})`);
    if (orphans.kind === "threw") {
      return done("unknown", `dependency ${rule.derived}->${rule.upstream} could not be checked: ${orphans.error}`, "dependency");
    }
    if (orphans.value > 0) {
      return done("degraded",
        `${orphans.value} row(s) in ${rule.derived} reference ${rule.keyColumn} values absent from ${rule.upstream}`,
        "dependency");
    }
    if (rule.generationColumn) {
      const column = quoteIdentifier(rule.generationColumn);
      const pair = row<{ derived: number | null; upstream: number | null }>(db,
        `SELECT (SELECT MAX(${column}) FROM ${qualifiedTable(rule.derived)}) AS derived, ` +
        `(SELECT MAX(${column}) FROM ${qualifiedTable(rule.upstream)}) AS upstream`);
      if (pair.kind === "threw") {
        return done("unknown", `generation alignment for ${rule.derived} could not be checked: ${pair.error}`, "dependency");
      }
      const { derived, upstream } = pair.value;
      if (derived !== null && upstream !== null && derived < upstream) {
        return done("degraded",
          `${rule.derived} generation ${derived} is older than ${rule.upstream} generation ${upstream}`, "dependency");
      }
    }
    trace.dependenciesChecked.push(`${rule.derived}->${rule.upstream}`);
  }

  /**
   * A qualifying table must actually COVER what it qualifies. A row count cannot say that:
   * `agency_year_reliability` is nonempty in every database ever built, and a build that stopped
   * short leaves recent agency-years silently unqualified -- every one of them reading as usable,
   * which is the failure this check exists to prevent.
   */
  for (const dep of spec.semanticDependencies) {
    const columns = columnsOf(db, dep.table);
    if (columns.kind === "threw") {
      return done("unknown", `semantic dependency ${dep.table} could not be read: ${columns.error}`, "threw");
    }
    if (columns.kind === "missing") {
      return done("degraded", `semantic dependency ${dep.table} is missing`, "semantic_dependency");
    }
    const absent = dep.requiredColumns.filter((column) => !columns.value.has(column));
    if (absent.length > 0) {
      return done("degraded", `${dep.table} is missing required column(s): ${absent.join(", ")}`, "semantic_dependency");
    }
    const key = quoteIdentifier(dep.keyColumn);
    const orphans = scalar(db, `SELECT COUNT(*) AS n FROM ${qualifiedTable(dep.table)} d ` +
      `WHERE NOT EXISTS (SELECT 1 FROM ${qualifiedTable(dep.qualifies)} q WHERE q.${key} = d.${key})`);
    if (orphans.kind === "threw") {
      return done("unknown", `semantic dependency ${dep.table} could not be checked: ${orphans.error}`, "semantic_dependency");
    }
    if (orphans.value > 0) {
      return done("degraded",
        `${orphans.value} row(s) in ${dep.table} qualify ${dep.keyColumn} values absent from ${dep.qualifies}`,
        "semantic_dependency");
    }
    const yearColumn = quoteIdentifier(dep.yearColumn);
    const span = row<{ depMax: number | null; qualMax: number | null }>(db,
      `SELECT (SELECT MAX(${yearColumn}) FROM ${qualifiedTable(dep.table)}) AS depMax, ` +
      `(SELECT MAX(${yearColumn}) FROM ${qualifiedTable(dep.qualifies)}) AS qualMax`);
    if (span.kind === "threw") {
      return done("unknown", `year span for ${dep.table} could not be checked: ${span.error}`, "semantic_dependency");
    }
    if (span.value.depMax === null || span.value.qualMax === null) {
      return done("unknown", `${dep.table} or ${dep.qualifies} has no year bound to compare`, "semantic_dependency");
    }
    if (span.value.depMax < span.value.qualMax) {
      return done("degraded",
        `${dep.table} covers through ${span.value.depMax} but ${dep.qualifies} extends to ${span.value.qualMax}; those years are unqualified`,
        "semantic_dependency");
    }
    if (dep.versionColumn) {
      // A mixed-version table is a half-finished rebuild, and rows from two algorithms are not
      // comparable evidence.
      const version = quoteIdentifier(dep.versionColumn);
      const versions = scalar(db, `SELECT COUNT(DISTINCT ${version}) AS n FROM ${qualifiedTable(dep.table)} WHERE ${version} IS NOT NULL`);
      if (versions.kind === "threw") {
        return done("unknown", `${dep.versionColumn} could not be counted: ${versions.error}`, "semantic_dependency");
      }
      if (versions.value === 0) return done("degraded", `${dep.table} records no ${dep.versionColumn}`, "semantic_dependency");
      if (versions.value > 1) {
        return done("degraded", `${dep.table} mixes ${versions.value} ${dep.versionColumn} values; a rebuild is incomplete`, "semantic_dependency");
      }
    }
    trace.semanticChecked.push(`${dep.table}~${dep.qualifies}`);
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
    semanticChecked: [],
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
