import type { CheckState, SourceHealth, SourceId } from "./proof-contract";
import { capabilityAuthorizes, coverageBasisErrors, type UnvalidatedPolicy } from "./capability-policy";
import path from "node:path";
import { artifactOf } from "./source-artifact";
import { verifyPlanDerivation, type PlanDerivation } from "./plan-derivation";
import { inspectNibrsRollupAvailability } from "./nibrs-rollup-router";
import { isObserving, resolveMode, type ModeEnv } from "./proof-modes";
import { specFor, type CapabilitySpec, type Db, type OpenedDatabase, type TableRequirement } from "./source-health-inventory";

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

/**
 * What a caller of sourceHealthFor supplies: everything EXCEPT the source.
 *
 * The source is sourceHealthFor's authoritative first argument, and it appears nowhere else on
 * purpose. When the request also carried one, they were two copies of a single fact: the gates and
 * the cache key read the argument while evaluation read the request, so a call whose copies
 * disagreed produced a verdict attributed to the wrong source, cached it under the right source's
 * key, and served it to later correct calls. The invalid state is now unrepresentable rather than
 * checked for.
 */
export type HealthRequest = Omit<HealthContext, "sourceId">;

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

/**
 * Exported so it can be tested DIRECTLY.
 *
 * The authorization gate above it now refuses everything, because no integrity rule is executable
 * yet -- which is correct, and would otherwise have made this function unreachable through
 * `evaluateCapability` and quietly untested. Testing it through a gate that currently blocks
 * everything would have asserted only that the gate blocks.
 */
export function coverageFor(spec: CapabilitySpec, db: Db, requestedYears: number[] | null): CheckState {
  const coverage = spec.policy?.coverage as
    { kind?: string; table?: string; yearColumn?: string } | null | undefined;
  if (!coverage) return "unknown";
  /**
   * An authored "no year dimension" is an ANSWER, and its answer is that a year check does not
   * apply here -- not that coverage is unknown. Collapsing it to unknown threw away the decision and
   * reported the capability as un-assessed forever.
   */
  if (coverage.kind === "none") return "not_applicable";
  if (coverage.kind !== "column") return "unknown";
  /**
   * The basis must be a table AND column this capability actually reads -- checked as a pair.
   *
   * Guarding the table alone still let an existing but unrequired column on a legitimate emitted
   * table produce a confident verdict from data the capability never reads. A basis outside the
   * emitted contract is a policy-authoring error for Stage 2B review, not something to tolerate at
   * runtime, so the same rule is applied by the registry regression via coverageBasisErrors.
   */
  if (coverageBasisErrors(spec.policy as UnvalidatedPolicy | null, spec.tables).length > 0) return "unknown";
  const { table, yearColumn } = coverage;
  if (!table || !yearColumn) return "unknown";
  if (!requestedYears || requestedYears.length === 0) return "not_applicable";
  /**
   * BOUNDS ONLY. This compares the requested years against MIN and MAX, so it catches a request
   * outside the span and cannot see a year missing INSIDE it: with rows for 2020 and 2022 and none
   * for 2021, a request for 2021 passes. The workbook asks the correspondingly narrow question --
   * "does this data record an earliest and latest year" -- because the question a policy owner is
   * asked must not promise evidence the check does not produce. Per-year presence checking would
   * widen this, and would be a deliberate change to what `passed` means.
   */
  try {
    const bounds = db.prepare(
      `SELECT MIN(${quoteIdentifier(yearColumn)}) AS lo, ` +
      `MAX(${quoteIdentifier(yearColumn)}) AS hi FROM ${qualifiedTable(table)}`,
    ).get() as { lo: number | null; hi: number | null };
    if (bounds.lo === null || bounds.hi === null) return "unknown";
    return requestedYears.every((year) => year >= bounds.lo! && year <= bounds.hi!) ? "passed" : "failed";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------- flag gate, cache, traces

export const HEALTH_CACHE_TTL_MS = 30_000;
/**
 * Both retention structures are BOUNDED, because Task 7 puts this on the request path and a
 * process-lifetime Map keyed by capability/handle/period grows with traffic. TTL is freshness, not
 * eviction: an expired entry answered nothing and still occupied memory forever.
 */
export const HEALTH_CACHE_MAX_ENTRIES = 256;
export const HEALTH_TRACE_LIMIT = 500;
const cache = new Map<string, { at: number; health: SourceHealth }>();
const traces: HealthTrace[] = [];
/** Injectable for the TTL regression only; everything else reads real time. */
let healthNow: () => number = Date.now;

/** The trace log is a ring: the oldest entry is dropped, never the newest. */
function pushTrace(trace: HealthTrace): void {
  traces.push(trace);
  while (traces.length > HEALTH_TRACE_LIMIT) traces.shift();
}

/** Purge expired entries first; if the cap is still hit, evict oldest-inserted (Map order). */
function storeVerdict(key: string, health: SourceHealth): void {
  const now = healthNow();
  if (cache.size >= HEALTH_CACHE_MAX_ENTRIES) {
    for (const [candidate, entry] of cache) {
      if (now - entry.at >= HEALTH_CACHE_TTL_MS) cache.delete(candidate);
    }
    while (cache.size >= HEALTH_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  cache.set(key, { at: now, health });
}

function unresolvedVerdict(sourceId: SourceId, capability: string, reason: string): SourceHealth {
  return { sourceId, capability, state: "unknown", reason, dataVersion: null, requestedCoverage: "unknown" };
}

/**
 * The flag-gated entry point a route will eventually call. Order is load-bearing:
 *
 *   1. Global proof mode. Off does no request-path work at all, and a capability flag cannot
 *      override it (invariant 14); the kill switch beats both.
 *   2. Capability resolution from the verified token. Unresolved answers stop here -- before any
 *      flag is read and before any database is acquired.
 *   3. The capability's own flag, read from the PIN (`spec.flagKey`), never re-derived: generation
 *      owns the derivation and the uniqueness check, and a second implementation on the request
 *      path is a drift the pin cannot prevent. Default-OFF: only an explicit "on", "shadow" or
 *      "enforce" enables probing, because an unset variable is not a decision anyone made (§13).
 *   4. A cache keyed by NON-FORGEABLE handle identity plus the requested period. A caller-supplied
 *      identity string would only prove two labels differ; reusing one label across handles would
 *      inherit another database's verdict. The identity comes from a WeakMap on the handle itself.
 *   5. Evaluation, with the trace recorded. Nothing here may take down a response (invariant 15),
 *      which includes ACQUISITION: the plan's draft acquired the handle for the cache key outside
 *      its try/catch, so the throwing provider its own comment warned about would have propagated.
 *
 * The budget switch is Task 6's and is deliberately absent here.
 */
export function sourceHealthFor(
  sourceId: SourceId,
  derivation: PlanDerivation | null,
  executedSql: string | null,
  claimedFamily: string | null,
  request: HealthRequest,
  env: ModeEnv = process.env,
): SourceHealth {
  if (!isObserving(resolveMode(sourceId, null, env).mode)) {
    return unresolvedVerdict(sourceId, "unresolved", "proof system is off for this source");
  }

  const resolved = resolveCapability(sourceId, derivation, executedSql, claimedFamily);
  if ("unresolved" in resolved) return unresolvedVerdict(sourceId, "unresolved", resolved.unresolved);
  const capability = resolved.capability;

  /**
   * The mode recheck with the VERIFIED family. The broad gate above passes null -- it has no
   * verified family yet, and consulting one an unverified token merely claims would be
   * input-driven configuration (the W8 property). But null permanently excluded the per-family
   * override, so global shadow + family OFF + capability flag on still probed. The narrower
   * override must win, and it is consulted only now that resolution has verified the family, and
   * before the capability flag is read.
   */
  if (!isObserving(resolveMode(sourceId, claimedFamily, env).mode)) {
    return unresolvedVerdict(sourceId, capability,
      `proof mode is off for plan family '${claimedFamily}'`);
  }

  // resolveCapability only returns registry members, so the spec exists; the lookup is kept rather
  // than assumed so a future resolver change cannot silently hand an unregistered id through.
  const spec = specFor(capability);
  if (!spec) return unresolvedVerdict(sourceId, capability, `no inventory entry for ${capability}`);

  const flagKey = spec.flagKey;
  const flag = (env[flagKey] ?? "").trim().toLowerCase();
  if (flag !== "on" && flag !== "shadow" && flag !== "enforce") {
    return unresolvedVerdict(sourceId, capability, `capability not enabled (${flagKey} is '${flag || "unset"}')`);
  }

  let opened: OpenedDatabase | null = null;
  try {
    opened = request.dbOverride !== undefined ? request.dbOverride : spec.database.acquire();
  } catch (error) {
    // Containment alone is not accounting: without a trace, an enabled capability whose provider
    // always throws leaves no record of ever having been tried.
    pushTrace({
      sourceId, capability, dbIdentity: "no-db", dbPath: null,
      preflight: "skipped", tablesChecked: [], dependenciesChecked: [], semanticChecked: [],
      coverage: "unknown", boundary: "threw",
    });
    return unresolvedVerdict(sourceId, capability, `database acquisition threw: ${(error as Error).message}`);
  }

  const period = [...(request.requestedYears ?? [])].sort((a, b) => a - b).join(",");
  const key = `${sourceId}:${capability}:${identityOf(opened?.db ?? null)}:${period}`;
  const hit = cache.get(key);
  if (hit && healthNow() - hit.at < HEALTH_CACHE_TTL_MS) return hit.health;

  let health: SourceHealth;
  try {
    // Spread FIRST, authoritative fields LAST: a sourceId smuggled past the types (a cast) is
    // overridden by construction order rather than detected by a check.
    const evaluated = evaluateCapability(spec, { ...request, sourceId, dbOverride: opened });
    health = evaluated.health;
    pushTrace(evaluated.trace);
  } catch (error) {
    // Defect containment, mandated by invariant 15. evaluateCapability guards its own reads, so this
    // fires only on a defect in it -- and a defect in the prober must degrade to `unknown`, never
    // take the answer down with it.
    health = unresolvedVerdict(sourceId, capability, `probe threw: ${(error as Error).message}`);
    pushTrace({
      sourceId, capability, dbIdentity: identityOf(opened?.db ?? null),
      dbPath: opened?.resolvedPath ?? null,
      preflight: "skipped", tablesChecked: [], dependenciesChecked: [], semanticChecked: [],
      coverage: "unknown", boundary: "threw",
    });
  }
  storeVerdict(key, health);
  return health;
}

export function __resetSourceHealthCacheForTests(): void {
  cache.clear();
  traces.length = 0;
}
export function __healthTracesForTests(): HealthTrace[] {
  return [...traces];
}
export function __setHealthClockForTests(clock: (() => number) | null): void {
  healthNow = clock ?? Date.now;
}

/**
 * The capability an answer is entitled to be evaluated under, or why it has none.
 *
 * Resolved ONLY from a fully verified plan derivation. There is deliberately no family lookup: a
 * family cannot identify a capability, because `deterministic-nibrs-continuous-reporters` spans four
 * distinct contracts over four summary tables and each metadata family spans five, one per source. A
 * function from family to capability would return the wrong contract three times out of four, and
 * `sourceId` cannot disambiguate the NIBRS cases because all four live on the same source.
 *
 * Every token sealed today names no capability, so this returns `unresolved` for all of them. That is
 * the fail-closed direction and it is the intended state: nothing can authorize on a token that never
 * declared a contract.
 */
export function resolveCapability(
  sourceId: SourceId,
  derivation: PlanDerivation | null,
  executedSql: string | null,
  claimedFamily: string | null,
): { capability: string } | { unresolved: string } {
  if (!derivation) return { unresolved: "no verified plan derivation was sealed for this answer" };

  /**
   * A missing family claim is refused HERE, because the verifier will not refuse it there.
   *
   * verifyPlanDerivation deliberately skips the family comparison for a null or blank
   * expectedFamily -- some callers genuinely have no independent claim to check. Resolution is not
   * such a caller: a capability feeds authorization, so an answer that cannot say which family it is
   * being recorded under has no business resolving one. Without this gate, both skip paths resolved
   * a valid capability with the family entirely unverified.
   */
  if (!claimedFamily || claimedFamily.trim() === "") {
    return { unresolved: "no family claim was provided, so the token's family cannot be independently verified" };
  }

  // All three arguments, always. The family is VERIFIED here, not trusted: without it a token sealed
  // for family A could be presented alongside family B and be recorded -- and later authorized -- as B.
  const verified = verifyPlanDerivation(derivation, executedSql, claimedFamily);
  if (!verified.ok) return { unresolved: `plan derivation not verified: ${verified.reason}` };

  // The builder's own declaration, read off the VERIFIED verdict rather than the raw token, so a
  // capability named by a derivation that failed verification can never be picked up.
  if (!verified.capability) {
    return { unresolved: `plan family '${derivation.planFamily}' sealed no capability` };
  }
  const spec = specFor(verified.capability);
  if (!spec) return { unresolved: `sealed capability '${verified.capability}' is not in the registry` };

  // The claimed source must own the capability's artifact. evaluateCapability applies the same rule,
  // because it is reachable independently; agreeing here means a mismatch is refused before any
  // database is touched at all.
  if (spec.artifact !== artifactOf(sourceId)) {
    return { unresolved: `capability '${verified.capability}' belongs to ${spec.artifact}, not ${sourceId}` };
  }
  return { capability: verified.capability };
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
      /**
       * A comparison missing either bound is UNKNOWN, not aligned.
       *
       * Treating a null bound as passing recorded the dependency as CHECKED when nothing had been
       * compared -- the strongest possible claim from the weakest possible evidence.
       */
      if (derived === null || upstream === null) {
        return done("unknown",
          `${rule.derived} or ${rule.upstream} has no ${rule.generationColumn} bound to compare`, "dependency");
      }
      if (derived < upstream) {
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
    /**
     * Matched on the AGENCY-YEAR, both ways. The relationship is per agency per year, so neither
     * half of it can be judged on the agency alone or on a global bound:
     *
     *   - keyColumn only: a reliability row for TX0001/2030 finds TX0001 in the crime data and
     *     passes, while qualifying no agency-year that exists.
     *   - MAX(year) comparison: crime holding TX0001/2022 and CA9999/2024 against reliability
     *     holding only CA9999/2024 has equal global maxima, so TX0001/2022 reads as qualified when
     *     nothing qualifies it. That is exactly the silent gap this dependency exists to prevent,
     *     and a global bound cannot see it.
     *
     * The reverse direction subsumes the span comparison, so the span check is gone rather than kept
     * as a weaker duplicate that can no longer fail.
     */
    const key = quoteIdentifier(dep.keyColumn);
    const yearColumn = quoteIdentifier(dep.yearColumn);
    const pairKey = `q.${key} = d.${key} AND q.${yearColumn} = d.${yearColumn}`;

    const orphans = scalar(db, `SELECT COUNT(*) AS n FROM ${qualifiedTable(dep.table)} d ` +
      `WHERE NOT EXISTS (SELECT 1 FROM ${qualifiedTable(dep.qualifies)} q WHERE ${pairKey})`);
    if (orphans.kind === "threw") {
      return done("unknown", `semantic dependency ${dep.table} could not be checked: ${orphans.error}`, "semantic_dependency");
    }
    if (orphans.value > 0) {
      return done("degraded",
        `${orphans.value} row(s) in ${dep.table} qualify ${dep.keyColumn}/${dep.yearColumn} pairs absent from ${dep.qualifies}`,
        "semantic_dependency");
    }

    /**
     * The reverse direction applies ONLY to a complete ledger.
     *
     * `agency_year_reliability` is a sparse EXCEPTION table -- its builder inserts a row only for a
     * detected finding, so an absent agency-year normally means no anomaly was recorded. Requiring
     * every qualified row to have a qualifying row would degrade nearly every real capability
     * holding ordinary unflagged crime data. The synthetic fixture that first covered this modelled
     * reliability as a complete ledger, which is precisely why the mismatch passed.
     *
     * For a sparse table, build completeness cannot be established structurally at all: row presence
     * says nothing, and MAX(year) says nothing either, because a recent year may legitimately
     * produce zero flags. It needs generation/receipt evidence, which is Stage 2B. The trace records
     * which claim was actually made so a sparse check cannot be read as a coverage guarantee.
     */
    if (dep.coverage === "complete") {
      const unqualified = scalar(db, `SELECT COUNT(*) AS n FROM ${qualifiedTable(dep.qualifies)} d ` +
        `WHERE NOT EXISTS (SELECT 1 FROM ${qualifiedTable(dep.table)} q WHERE ${pairKey})`);
      if (unqualified.kind === "threw") {
        return done("unknown", `coverage of ${dep.qualifies} by ${dep.table} could not be checked: ${unqualified.error}`, "semantic_dependency");
      }
      if (unqualified.value > 0) {
        return done("degraded",
          `${unqualified.value} ${dep.keyColumn}/${dep.yearColumn} row(s) in ${dep.qualifies} are unqualified by ${dep.table}`,
          "semantic_dependency");
      }
    }
    /**
     * An EMPTY qualifying table is judged by the coverage mode, before any version reasoning.
     *
     * A sparse exception table with zero rows means no anomaly was recorded anywhere -- which is
     * indistinguishable, from structure alone, from a build that never ran. Absence is not a defect
     * under the sparse contract and row presence cannot establish completeness, so the honest verdict
     * is `unknown` pending receipt/generation evidence. Reporting `degraded` claimed a negative
     * finding that the contract explicitly says cannot be drawn this way.
     *
     * A complete ledger keeps the stricter reading: it is supposed to enumerate what it qualifies.
     *
     * If a particular sparse table must be nonempty, that belongs in an explicit rule of its own, not
     * inferred from a version count.
     */
    const total = scalar(db, `SELECT COUNT(*) AS n FROM ${qualifiedTable(dep.table)}`);
    if (total.kind === "threw") {
      return done("unknown", `${dep.table} could not be counted: ${total.error}`, "semantic_dependency");
    }
    if (total.value === 0) {
      return dep.coverage === "sparse"
        ? done("unknown",
          `${dep.table} holds no rows; for a sparse exception table that is not a defect, and completeness needs receipt or generation evidence`,
          "semantic_dependency")
        : done("degraded",
          `${dep.table} holds no rows, and a complete ledger must enumerate what it qualifies`,
          "semantic_dependency");
    }

    if (dep.versionColumn) {
      // A mixed-version table is a half-finished rebuild, and rows from two algorithms are not
      // comparable evidence.
      const version = quoteIdentifier(dep.versionColumn);
      // `distinct` is a SQL keyword: aliasing a column to it makes the whole statement throw, which
      // reported every version case as `unknown` instead of the verdict it had actually computed.
      /**
       * Reached only for a NONEMPTY table, because the emptiness rule above returns first. That
       * ordering is load-bearing: SUM over zero rows returns NULL, so `missing > 0` would be false
       * and an empty table would fall through to the distinct count and be called degraded -- the
       * verdict the sparse contract forbids. The empty-table tests pin the ordering, so no
       * COALESCE is added here to paper over a state that cannot arrive.
       */
      const counts = row<{ version_count: number; missing_count: number }>(db,
        `SELECT COUNT(DISTINCT ${version}) AS version_count, ` +
        `SUM(CASE WHEN ${version} IS NULL OR TRIM(${version}) = '' THEN 1 ELSE 0 END) AS missing_count ` +
        `FROM ${qualifiedTable(dep.table)}`);
      if (counts.kind === "threw") {
        return done("unknown", `${dep.versionColumn} could not be counted: ${counts.error}`, "semantic_dependency");
      }
      const { version_count: distinct, missing_count: missing } = counts.value;
      /**
       * Nulls counted, not filtered out. Restricting the DISTINCT to non-null values let a table of
       * v1 rows plus null rows read as ONE version -- the null rows have no algorithm identity at
       * all, so part of the table is unattributable evidence, which is worse than two versions.
       */
      if (missing > 0) {
        return done("degraded",
          `${missing} row(s) in ${dep.table} record no ${dep.versionColumn}, so their algorithm is unidentified`,
          "semantic_dependency");
      }
      if (distinct === 0) return done("degraded", `${dep.table} records no ${dep.versionColumn}`, "semantic_dependency");
      if (distinct > 1) {
        return done("degraded", `${dep.table} mixes ${distinct} ${dep.versionColumn} values; a rebuild is incomplete`, "semantic_dependency");
      }
    }
    // The mode is recorded, because "flags validated" and "coverage guaranteed" are different claims
    // and an undifferentiated entry would let the weaker one be read as the stronger.
    trace.semanticChecked.push(`${dep.table}~${dep.qualifies}(${dep.coverage})`);
  }

  /**
   * The SAME predicate the registry was pinned with. Gating on `policyIsComplete` was a weaker test
   * than the one that decided eligibility: a policy whose integrity rules are unbound prose is a
   * finished draft, not an authorization, and the runtime must not treat it as one.
   */
  if (!capabilityAuthorizes(spec.policy as UnvalidatedPolicy | null, spec.tables)) {
    return done("unknown", "capability policy is absent, incomplete, or not yet authorizing", "policy_incomplete");
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
