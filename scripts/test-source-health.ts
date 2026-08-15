import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  evaluateCapability, identityOf, resolveCapability, sourceHealthFor,
  HEALTH_CACHE_MAX_ENTRIES, HEALTH_CACHE_TTL_MS, HEALTH_TRACE_LIMIT,
  __healthTracesForTests, __resetSourceHealthCacheForTests, __setHealthClockForTests,
  type HealthContext,
} from "../lib/source-health";
import { LEGACY_PLAN_DERIVATION_VERSION, PLAN_DERIVATION_VERSION, fingerprintSql, sealPlanDerivation, verifyPlanDerivation } from "../lib/plan-derivation";
import { coverageBasisErrors } from "../lib/capability-policy";
import { envKeyForFamily, type ModeEnv } from "../lib/proof-modes";
import {
  CAPABILITY_INVENTORY, specFor,
  type CapabilitySpec, type DependencyRule, type SemanticDependency,
} from "../lib/source-health-inventory";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (error) {
    // Counted, not just flagged: the summary previously printed "N passed" with no failure count,
    // so a reader had to infer failure from the exit code. Green-looking output that omits failures
    // is the specific thing this whole workstream keeps getting caught by.
    failed++;
    console.log(`  FAIL  ${name}\n        ${(error as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
    process.exitCode = 1;
  }
}

function shrFixture(mutate?: (db: Database.Database) => void): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE incidents (ori TEXT, year INTEGER, state TEXT, homicide_type TEXT, victim_count INTEGER)");
  db.prepare("INSERT INTO incidents VALUES (?,?,?,?,?)").run("TX0001", 2022, "TX", "Murder", 1);
  mutate?.(db);
  return db;
}

const SHR_INCIDENTS_YEAR = "shr::incidents::incidents(year)";
const shr = specFor(SHR_INCIDENTS_YEAR);
assert.ok(shr, `missing fixture capability ${SHR_INCIDENTS_YEAR}`);

const ctx = (db: Database.Database | null, years: number[] | null = [2022]): HealthContext => ({
  sourceId: "shr",
  requestedYears: years,
  dbOverride: db ? { db, resolvedPath: db.name } : null,
});

function withPolicy(spec: CapabilitySpec): CapabilitySpec {
  return {
    ...spec,
    policy: {
      coverage: { kind: "column", table: "incidents", yearColumn: "year" },
      /**
       * BOUND, because the runtime gate is `capabilityAuthorizes` and unbound prose authorizes
       * nothing. A fixture carrying prose would exercise the not-yet-authorizing path on every
       * case and quietly stop testing everything downstream of the gate.
       */
      integrity: [{ rule: "required structure is readable", boundTo: "checks/shr-structure.sql" }],
      availability: { kind: "always" },
      receiptOwner: "shr-import",
      evidence: "test-only complete policy",
    },
    authorizationEligible: true,
  };
}

check("an intact structure is checked before incomplete policy stops evaluation", () => {
  const db = shrFixture();
  const { health, trace } = evaluateCapability(shr, ctx(db));
  assert.strictEqual(trace.boundary, "policy_incomplete");
  assert.deepStrictEqual(trace.tablesChecked, ["incidents"]);
  assert.notStrictEqual(trace.dbIdentity, "no-db");
  assert.strictEqual(health.state, "unknown");
  assert.match(health.reason ?? "", /policy/);
  assert.strictEqual(health.dataVersion, null);
  db.close();
});

check("no database stops at no_database, having checked nothing", () => {
  const { health, trace } = evaluateCapability(shr, ctx(null));
  assert.strictEqual(trace.boundary, "no_database");
  assert.deepStrictEqual(trace.tablesChecked, []);
  assert.strictEqual(health.state, "unknown");
});

check("a missing table stops at table_missing", () => {
  const db = shrFixture((fixture) => fixture.exec("DROP TABLE incidents"));
  const { health, trace } = evaluateCapability(shr, ctx(db));
  assert.strictEqual(trace.boundary, "table_missing");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /incidents/);
  db.close();
});

check("a missing required column stops at column_missing", () => {
  const db = shrFixture((fixture) => {
    fixture.exec("DROP TABLE incidents");
    fixture.exec("CREATE TABLE incidents (ori TEXT)");
    fixture.prepare("INSERT INTO incidents VALUES (?)").run("TX0001");
  });
  const { health, trace } = evaluateCapability(shr, ctx(db));
  assert.strictEqual(trace.boundary, "column_missing");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /year/);
  db.close();
});

check("an empty table stops at row_bounds", () => {
  const db = shrFixture((fixture) => fixture.exec("DELETE FROM incidents"));
  const { health, trace } = evaluateCapability(shr, ctx(db));
  assert.strictEqual(trace.boundary, "row_bounds");
  assert.strictEqual(health.state, "degraded");
  db.close();
});

check("preparation tables are structural dependencies too", () => {
  const db = shrFixture();
  const spec: CapabilitySpec = {
    ...shr,
    preparationTables: [{ name: "agency_alias", requiredColumns: [], minRows: 0 }],
  };
  const { trace } = evaluateCapability(spec, ctx(db));
  assert.strictEqual(trace.boundary, "table_missing");
  assert.match(trace.tablesChecked.join(","), /incidents/);
  db.close();
});

check("coverage is recorded independently of the missing receipt", () => {
  const spec = withPolicy(shr);
  const covered = shrFixture();
  const outside = shrFixture();
  const timeless = shrFixture();
  assert.strictEqual(evaluateCapability(spec, ctx(covered, [2022])).trace.coverage, "passed");
  assert.strictEqual(evaluateCapability(spec, ctx(outside, [2030])).trace.coverage, "failed");
  assert.strictEqual(evaluateCapability(spec, ctx(timeless, null)).trace.coverage, "not_applicable");
  assert.strictEqual(evaluateCapability(spec, ctx(shrFixture())).trace.boundary, "missing_receipt");
  covered.close();
  outside.close();
  timeless.close();
});

check("the trace records the source supplied by the calling route", () => {
  const db = shrFixture();
  assert.strictEqual(evaluateCapability(shr, ctx(db)).trace.sourceId, "shr");
  db.close();
});

// ---------------------------------------------------------------- truthful attribution

check("a source that does not own the capability's artifact is refused, not attributed", () => {
  /**
   * `sourceId` comes from the caller. Recording it unchecked produces a health verdict and trace
   * attributed to a source whose artifact was never read -- the record looks truthful and is not.
   * `artifact_mismatch` existed in HealthBoundary while being unreachable; this is its condition.
   */
  const db = shrFixture();
  for (const sourceId of ["current", "historical", "nibrs", "hate_crime"] as const) {
    const { health, trace } = evaluateCapability(shr, { sourceId, requestedYears: [2022], dbOverride: { db, resolvedPath: db.name } });
    assert.strictEqual(trace.boundary, "artifact_mismatch", `${sourceId} should not evaluate an shr capability`);
    assert.strictEqual(health.state, "unknown");
    assert.deepStrictEqual(trace.tablesChecked, [], "nothing may be checked once attribution is wrong");
    assert.match(health.reason ?? "", /belongs to shr/);
  }
  // The matching source still evaluates.
  assert.strictEqual(evaluateCapability(shr, ctx(db)).trace.boundary, "policy_incomplete");
  db.close();
});

check("attribution is refused BEFORE a handle is acquired", () => {
  /**
   * The guard was placed after acquisition, so it was unreachable for exactly the cases that matter:
   * a mismatched source with no handle exited at no_database, and one whose provider threw exited at
   * threw -- both attributed to a source that does not own the artifact. Whether attribution is
   * truthful cannot depend on whether a database happened to be obtainable.
   */
  const foreign = { sourceId: "nibrs" as const, requestedYears: [2022] };

  // (a) provider yields nothing
  const nullProvider: CapabilitySpec = { ...shr, database: { acquire: () => null } };
  const noHandle = evaluateCapability(nullProvider, foreign);
  assert.strictEqual(noHandle.trace.boundary, "artifact_mismatch", "a mismatched source with no handle escaped as no_database");
  assert.strictEqual(noHandle.health.state, "unknown");

  // (b) provider throws
  let acquired = 0;
  const throwingProvider: CapabilitySpec = {
    ...shr,
    database: { acquire: () => { acquired++; throw new Error("handle exploded"); } },
  };
  const threw = evaluateCapability(throwingProvider, foreign);
  assert.strictEqual(threw.trace.boundary, "artifact_mismatch", "a mismatched source with a throwing provider escaped as threw");
  assert.strictEqual(threw.health.state, "unknown");
  assert.strictEqual(acquired, 0, "no handle may be opened for a capability the caller cannot evaluate");

  // (c) explicit null override takes the same path
  assert.strictEqual(
    evaluateCapability(shr, { ...foreign, dbOverride: null }).trace.boundary, "artifact_mismatch");
  for (const result of [noHandle, threw]) {
    assert.match(result.health.reason ?? "", /belongs to shr/);
    assert.deepStrictEqual(result.trace.tablesChecked, []);
  }
});

check("current and historical share one artifact, so both may evaluate a crime_data capability", () => {
  // The mapping this guard depends on: two tabs over crime_data.db cannot have different structural
  // health for the same table, which is why capability ids are keyed on the artifact.
  const cd = CAPABILITY_INVENTORY.find((s) => s.artifact === "crime_data");
  assert.ok(cd, "expected a crime_data capability in the inventory");
  for (const sourceId of ["current", "historical"] as const) {
    const { trace } = evaluateCapability(cd!, { sourceId, requestedYears: null, dbOverride: null });
    assert.strictEqual(trace.boundary, "no_database", `${sourceId} was refused attribution it is entitled to`);
  }
});

check("the trace names the capability it evaluated", () => {
  const db = shrFixture();
  const { health, trace } = evaluateCapability(shr, ctx(db));
  assert.strictEqual(trace.capability, SHR_INCIDENTS_YEAR);
  assert.strictEqual(health.capability, SHR_INCIDENTS_YEAR);
  db.close();
});

// ---------------------------------------------------------------- acquisition and identity

check("the handle and the path it resolved from are acquired in ONE call", () => {
  /**
   * Two calls would let the recorded path describe a different handle than the one evaluated. The
   * provider must therefore be invoked exactly once, and the trace's path must be the value that
   * call returned -- not something re-derived afterwards.
   */
  const db = shrFixture();
  let calls = 0;
  const spec: CapabilitySpec = {
    ...shr,
    database: { acquire: () => { calls++; return { db, resolvedPath: "/pinned/by/the/provider.db" }; } },
  };
  const { trace } = evaluateCapability(spec, { sourceId: "shr", requestedYears: [2022] });
  assert.strictEqual(calls, 1, `the provider was acquired ${calls} times`);
  assert.strictEqual(trace.dbPath, "/pinned/by/the/provider.db", "the trace path is not the one the provider returned");
  assert.notStrictEqual(trace.dbIdentity, "no-db");
  db.close();
});

check("handle identity is per-handle, stable, and not a label", () => {
  // A caller-supplied name would only prove two LABELS differ; reusing one label across handles
  // would inherit another database's verdict through the cache Task 5 adds.
  const a = shrFixture();
  const b = shrFixture();
  const idA1 = evaluateCapability(shr, ctx(a)).trace.dbIdentity;
  const idA2 = evaluateCapability(shr, ctx(a)).trace.dbIdentity;
  const idB = evaluateCapability(shr, ctx(b)).trace.dbIdentity;
  assert.strictEqual(idA1, idA2, "the same handle must keep one identity");
  assert.notStrictEqual(idA1, idB, "two handles over identical schemas must not share an identity");
  assert.strictEqual(identityOf(null), "no-db");
  a.close();
  b.close();
});

check("a provider that throws is unknown, not degraded", () => {
  // Acquisition failing is not evidence about the data. `degraded` maps onto a FAILED check.
  const spec: CapabilitySpec = {
    ...shr,
    database: { acquire: () => { throw new Error("handle exploded"); } },
  };
  const { health, trace } = evaluateCapability(spec, { sourceId: "shr", requestedYears: [2022] });
  assert.strictEqual(trace.boundary, "threw");
  assert.strictEqual(health.state, "unknown");
  assert.match(health.reason ?? "", /handle exploded/);
  assert.strictEqual(trace.dbIdentity, "no-db");
});

check("a structural read that throws is unknown, not degraded", () => {
  /**
   * The distinction the first version collapsed: a read failure returned null and was reported as
   * `degraded`, asserting a negative finding about data nobody managed to look at. Health could not
   * be determined, which is `unknown`.
   */
  const db = shrFixture();
  const exploding = {
    prepare: () => { throw new Error("database is locked"); },
    name: db.name,
  } as unknown as Database.Database;
  const { health, trace } = evaluateCapability(shr, {
    sourceId: "shr", requestedYears: [2022], dbOverride: { db: exploding, resolvedPath: db.name },
  });
  assert.strictEqual(trace.boundary, "threw");
  assert.strictEqual(health.state, "unknown", "an unreadable database is not a degraded one");
  assert.match(health.reason ?? "", /locked/);
  db.close();
});

// ---------------------------------------------------------------- preparation tables

check("an EMPTY preparation table does not degrade the capability", () => {
  /**
   * Task 1's stated rule: a preparation table is read while DECIDING, and finding nothing there is a
   * legitimate decline -- an agency absent from a crosswalk -- not an unhealthy source. Its minRows
   * is 0 for that reason, so an empty one must pass the row bound while still being checked to
   * exist. Without this pin, raising preparation minRows to 1 would look harmless.
   */
  const db = shrFixture((fixture) => fixture.exec("CREATE TABLE agency_alias (ori TEXT)"));
  const spec: CapabilitySpec = {
    ...shr,
    preparationTables: [{ name: "agency_alias", requiredColumns: [], minRows: 0 }],
  };
  const { health, trace } = evaluateCapability(spec, ctx(db));
  assert.strictEqual(trace.boundary, "policy_incomplete", `an empty preparation table degraded the capability: ${health.reason}`);
  assert.deepStrictEqual(trace.tablesChecked, ["incidents", "agency_alias"]);
  db.close();
});

check("a preparation table's declared columns are still enforced", () => {
  const db = shrFixture((fixture) => fixture.exec("CREATE TABLE agency_alias (ori TEXT)"));
  const spec: CapabilitySpec = {
    ...shr,
    preparationTables: [{ name: "agency_alias", requiredColumns: ["alias_key"], minRows: 0 }],
  };
  const { health, trace } = evaluateCapability(spec, ctx(db));
  assert.strictEqual(trace.boundary, "column_missing");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /alias_key/);
  db.close();
});

// ---------------------------------------------------------------- coverage

check("coverage is unknown when its basis is not a table the capability reads", () => {
  /**
   * An authored basis naming an unrelated table still computes MIN/MAX successfully, producing a
   * confident verdict from data the answer never touched. Declining to judge is the honest outcome.
   */
  const db = shrFixture((fixture) => {
    fixture.exec("CREATE TABLE unrelated (year INTEGER)");
    fixture.prepare("INSERT INTO unrelated VALUES (?)").run(1999);
  });
  const spec = withPolicy(shr);
  const strayBasis: CapabilitySpec = {
    ...spec,
    policy: { ...spec.policy!, coverage: { kind: "column", table: "unrelated", yearColumn: "year" } },
  };
  const { trace } = evaluateCapability(strayBasis, ctx(db, [1999]));
  assert.strictEqual(trace.coverage, "unknown", "coverage was judged from a table outside the capability");
  /**
   * Stopped at the AUTHORIZATION gate rather than deeper in the coverage check. A basis outside the
   * contract is a policy error, and the runtime now applies the same predicate the registry was
   * pinned with -- so a capability the registry calls ineligible no longer proceeds as though it
   * were merely missing a receipt.
   */
  assert.strictEqual(trace.boundary, "policy_incomplete");
  db.close();
});

check("coverage is unknown when the basis column is not one the capability reads", () => {
  /**
   * The review's reproduction: a legitimate emitted table with an existing but UNREQUIRED column.
   * `incidents.foreign_year` exists and MIN/MAX over it succeeds, so guarding the table alone
   * returned a confident "passed" from a column the contract never names.
   */
  const db = shrFixture((fixture) => {
    fixture.exec("ALTER TABLE incidents ADD COLUMN foreign_year INTEGER");
    fixture.prepare("UPDATE incidents SET foreign_year = ?").run(2022);
  });
  const spec = withPolicy(shr);
  assert.deepStrictEqual(shr.tables.find((t) => t.name === "incidents")?.requiredColumns, ["year"],
    "this reproduction depends on the contract requiring only incidents.year");
  const strayColumn: CapabilitySpec = {
    ...spec,
    policy: { ...spec.policy!, coverage: { kind: "column", table: "incidents", yearColumn: "foreign_year" } },
  };
  const { trace } = evaluateCapability(strayColumn, ctx(db, [2022]));
  assert.strictEqual(trace.coverage, "unknown", "coverage was judged from a column outside the contract");
  assert.strictEqual(trace.boundary, "policy_incomplete", "a basis outside the contract must stop at the authorization gate");
  // The required column still yields a real verdict, so the guard is not simply refusing everything.
  assert.strictEqual(evaluateCapability(spec, ctx(db, [2022])).trace.coverage, "passed");
  db.close();
});

check("the coverage-basis rule is the shared one, table and column together", () => {
  // Same function the registry regression applies, so runtime and validation cannot drift apart.
  const declared = [{ name: "incidents", requiredColumns: ["year"] }];
  const authored = (coverage: unknown) => coverageBasisErrors({ coverage } as never, declared);
  assert.deepStrictEqual(authored({ kind: "column", table: "incidents", yearColumn: "year" }), []);
  assert.strictEqual(authored({ kind: "column", table: "incidents", yearColumn: "foreign_year" }).length, 1);
  assert.strictEqual(authored({ kind: "column", table: "unrelated", yearColumn: "year" }).length, 1);
  assert.deepStrictEqual(coverageBasisErrors(null, declared), [], "an unauthored basis is not an error");
  assert.deepStrictEqual(coverageBasisErrors({} as never, declared), [], "an absent basis is not an error");
});

check("coverage is unknown when the basis table has no year bounds", () => {
  const db = shrFixture((fixture) => fixture.exec("UPDATE incidents SET year = NULL"));
  const { trace } = evaluateCapability(withPolicy(shr), ctx(db, [2022]));
  assert.strictEqual(trace.coverage, "unknown");
  db.close();
});

// ---------------------------------------------------------------- dependency alignment
/**
 * Driven through SYNTHETIC specs. No real capability carries dependency rules: Task 1 left them
 * empty because they are hand-authored relational knowledge no observation can derive, and the
 * inventory regression asserts they stay empty. So the machinery is exercised directly rather than
 * by inventing rules for the 51 real capabilities.
 */
const withDeps = (rule: DependencyRule, tables = shr.tables): CapabilitySpec =>
  ({ ...shr, tables, dependencies: [rule] });

function depFixture(mutate?: (db: Database.Database) => void): Database.Database {
  const db = shrFixture();
  db.exec("CREATE TABLE cohort (ori TEXT, gen INTEGER); CREATE TABLE upstream (ori TEXT, gen INTEGER)");
  db.prepare("INSERT INTO upstream VALUES (?,?)").run("TX0001", 2022);
  db.prepare("INSERT INTO cohort VALUES (?,?)").run("TX0001", 2022);
  mutate?.(db);
  return db;
}

check("a cohort referencing rows absent upstream stops at dependency", () => {
  const db = depFixture((d) => d.prepare("INSERT INTO cohort VALUES (?,?)").run("CA9999", 2022));
  const { health, trace } = evaluateCapability(withDeps({ derived: "cohort", upstream: "upstream", keyColumn: "ori" }), ctx(db));
  assert.strictEqual(trace.boundary, "dependency");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /absent from upstream/);
  db.close();
});

check("an aligned dependency is recorded and evaluation continues", () => {
  const db = depFixture();
  const { trace } = evaluateCapability(withDeps({ derived: "cohort", upstream: "upstream", keyColumn: "ori" }), ctx(db));
  assert.deepStrictEqual(trace.dependenciesChecked, ["cohort->upstream"]);
  assert.strictEqual(trace.boundary, "policy_incomplete", "an aligned dependency must not stop evaluation");
  db.close();
});

check("the dependency join key is the one the rule STATES, not a positional guess", () => {
  /**
   * `cohort.a_id` has no upstream match while `cohort.ori` does. A rule keyed on `ori` is therefore
   * aligned, and an implementation that took the derived table's first required column would key on
   * `a_id` and report orphans. Sorting put `a_id` first precisely to catch that.
   */
  const db = depFixture((d) => {
    d.exec("DROP TABLE cohort; CREATE TABLE cohort (a_id TEXT, ori TEXT)");
    d.prepare("INSERT INTO cohort VALUES (?,?)").run("no-such-upstream", "TX0001");
  });
  const tables = [...shr.tables, { name: "cohort", requiredColumns: ["a_id", "ori"], minRows: 1 }];
  const { trace } = evaluateCapability(withDeps({ derived: "cohort", upstream: "upstream", keyColumn: "ori" }, tables), ctx(db));
  assert.deepStrictEqual(trace.dependenciesChecked, ["cohort->upstream"],
    "the stated key was ignored in favour of a positional one");
  db.close();
});

check("a derived generation older than its upstream is degraded", () => {
  const db = depFixture((d) => d.prepare("UPDATE cohort SET gen = ?").run(2021));
  const rule: DependencyRule = { derived: "cohort", upstream: "upstream", keyColumn: "ori", generationColumn: "gen" };
  const { health, trace } = evaluateCapability(withDeps(rule), ctx(db));
  assert.strictEqual(trace.boundary, "dependency");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /older than/);
  // Equal generations are aligned, so the check is not simply rejecting any comparison.
  const equal = depFixture();
  assert.strictEqual(evaluateCapability(withDeps(rule), ctx(equal)).trace.boundary, "policy_incomplete");
  db.close();
  equal.close();
});

check("a generation comparison missing either bound is unknown, not aligned", () => {
  /**
   * A null bound previously fell through as PASSING and the dependency was recorded as checked --
   * the strongest claim from the weakest evidence. Both directions are covered, because only one of
   * them was reachable by accident.
   */
  const rule: DependencyRule = { derived: "cohort", upstream: "upstream", keyColumn: "ori", generationColumn: "gen" };
  for (const [label, sql] of [
    ["derived", "UPDATE cohort SET gen = NULL"],
    ["upstream", "UPDATE upstream SET gen = NULL"],
  ] as const) {
    const db = depFixture((d) => d.exec(sql));
    const { health, trace } = evaluateCapability(withDeps(rule), ctx(db));
    assert.strictEqual(trace.boundary, "dependency", `${label} null bound`);
    assert.strictEqual(health.state, "unknown", `a missing ${label} bound must not read as aligned`);
    assert.deepStrictEqual(trace.dependenciesChecked, [], "nothing was compared, so nothing may be recorded as checked");
    db.close();
  }
});

check("an uncheckable dependency is unknown, not degraded", () => {
  const db = depFixture();
  const { health, trace } = evaluateCapability(withDeps({ derived: "no_such_table", upstream: "upstream", keyColumn: "ori" }), ctx(db));
  assert.strictEqual(trace.boundary, "dependency");
  assert.strictEqual(health.state, "unknown", "a dependency that cannot be evaluated is not a degraded one");
  db.close();
});

// ---------------------------------------------------------------- semantic alignment
const withSemantic = (dep: SemanticDependency): CapabilitySpec => ({ ...shr, semanticDependencies: [dep] });
/**
 * A COMPLETE ledger: every qualified row must have a qualifying row. Used for the reverse-direction
 * cases below.
 */
const RELIABILITY: SemanticDependency = {
  table: "reliability", requiredColumns: ["ori", "year", "algorithm_version"],
  qualifies: "crime", keyColumn: "ori", yearColumn: "year", versionColumn: "algorithm_version",
  coverage: "complete",
};
/**
 * A SPARSE exception table, which is what agency_year_reliability actually is: its builder inserts a
 * row only for a detected finding, so an absent agency-year normally means no anomaly was recorded.
 */
const SPARSE_RELIABILITY: SemanticDependency = { ...RELIABILITY, coverage: "sparse" };

function semanticFixture(mutate?: (db: Database.Database) => void): Database.Database {
  const db = shrFixture();
  db.exec(`
    CREATE TABLE crime (ori TEXT, year INTEGER);
    CREATE TABLE reliability (ori TEXT, year INTEGER, algorithm_version TEXT);
  `);
  db.prepare("INSERT INTO crime VALUES (?,?)").run("TX0001", 2022);
  db.prepare("INSERT INTO reliability VALUES (?,?,?)").run("TX0001", 2022, "v1");
  mutate?.(db);
  return db;
}

check("a SPARSE exception table does not degrade for unflagged rows", () => {
  /**
   * The production shape, and the one the earlier model got wrong. agency_year_reliability inserts a
   * row only for a detected finding (scripts/build-agency-year-reliability.ts, inside
   * `for (const finding of findings)`), so an absent agency-year normally means no anomaly was
   * recorded. Requiring every qualified row to have a qualifying row degraded nearly every real
   * capability holding ordinary unflagged crime data.
   *
   * The first fixture for this hid the mismatch by modelling reliability as a complete ledger.
   */
  const db = semanticFixture((d) => {
    d.prepare("INSERT INTO crime VALUES (?,?)").run("TX0001", 2023);   // ordinary, unflagged
    d.prepare("INSERT INTO crime VALUES (?,?)").run("CA9999", 2024);   // ordinary, unflagged
  });
  const flags = db.prepare("SELECT COUNT(*) AS n FROM reliability").get() as { n: number };
  const rows = db.prepare("SELECT COUNT(*) AS n FROM crime").get() as { n: number };
  assert.ok(flags.n < rows.n, "this case depends on the flag table being sparser than the data");

  const sparse = evaluateCapability(withSemantic(SPARSE_RELIABILITY), ctx(db));
  assert.strictEqual(sparse.trace.boundary, "policy_incomplete",
    `unflagged rows degraded a sparse exception table: ${sparse.health.reason}`);
  assert.deepStrictEqual(sparse.trace.semanticChecked, ["reliability~crime(sparse)"],
    "the trace must record that flags were validated, not that coverage was guaranteed");

  // The same data against a COMPLETE ledger is a defect, so the distinction is doing the work.
  const complete = evaluateCapability(withSemantic(RELIABILITY), ctx(db));
  assert.strictEqual(complete.trace.boundary, "semantic_dependency");
  assert.strictEqual(complete.health.state, "degraded");
  db.close();
});

check("an EMPTY sparse exception table is unknown, not degraded", () => {
  /**
   * Zero flags means no anomaly was recorded anywhere, which structure alone cannot distinguish from
   * a build that never ran. Under the sparse contract absence is not a defect and row presence cannot
   * establish completeness, so the verdict is unknown pending receipt or generation evidence.
   * Reporting `degraded` drew exactly the inference the contract forbids.
   *
   * A complete ledger keeps the stricter reading, so both modes are pinned here.
   */
  const empty = semanticFixture((d) => d.exec("DELETE FROM reliability"));
  const sparse = evaluateCapability(withSemantic(SPARSE_RELIABILITY), ctx(empty));
  assert.strictEqual(sparse.trace.boundary, "semantic_dependency");
  assert.strictEqual(sparse.health.state, "unknown", `an empty sparse table was called degraded: ${sparse.health.reason}`);
  assert.match(sparse.health.reason ?? "", /not a defect|receipt or generation evidence/);
  assert.deepStrictEqual(sparse.trace.semanticChecked, [], "nothing was validated, so nothing may be recorded as checked");

  // Non-empty crime: a complete ledger degrades here via the REVERSE check, not the emptiness rule.
  const complete = evaluateCapability(withSemantic(RELIABILITY), ctx(empty));
  assert.strictEqual(complete.health.state, "degraded", "a complete ledger must still enumerate what it qualifies");
  assert.match(complete.health.reason ?? "", /unqualified by reliability/);
  empty.close();

  /**
   * BOTH empty, which is the only state that reaches the emptiness rule on the complete path -- with
   * a non-empty qualified table the reverse check fires first. Without this case the complete branch
   * of that rule is unreachable, and a mutation flipping it to `unknown` survived.
   */
  const bothEmpty = semanticFixture((d) => d.exec("DELETE FROM reliability; DELETE FROM crime"));
  const sparseBoth = evaluateCapability(withSemantic(SPARSE_RELIABILITY), ctx(bothEmpty));
  assert.strictEqual(sparseBoth.health.state, "unknown");
  const completeBoth = evaluateCapability(withSemantic(RELIABILITY), ctx(bothEmpty));
  assert.strictEqual(completeBoth.health.state, "degraded",
    "an empty complete ledger must still be a defect when nothing forced the reverse check");
  assert.match(completeBoth.health.reason ?? "", /must enumerate what it qualifies/);
  bothEmpty.close();
});

check("a SPARSE table still has its existing flags validated", () => {
  // Absence is not a defect; an INVALID flag still is. A reliability row for an agency-year the
  // crime data does not contain qualifies nothing that exists.
  const db = semanticFixture((d) => d.prepare("INSERT INTO reliability VALUES (?,?,?)").run("TX0001", 2030, "v1"));
  const { health, trace } = evaluateCapability(withSemantic(SPARSE_RELIABILITY), ctx(db));
  assert.strictEqual(trace.boundary, "semantic_dependency");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /pairs absent from crime/);
  db.close();
});

check("a SPARSE table still has its version identity enforced", () => {
  const db = semanticFixture((d) => d.prepare("INSERT INTO reliability VALUES (?,?,?)").run("TX0001", 2022, "v2"));
  assert.strictEqual(evaluateCapability(withSemantic(SPARSE_RELIABILITY), ctx(db)).trace.boundary, "semantic_dependency");
  db.close();
});

check("a qualifying row for a year that does not exist is an orphan", () => {
  /**
   * The review's first counterexample. Matching on the agency alone, a reliability row for
   * TX0001/2030 finds TX0001 in the crime data and passes -- while qualifying no agency-year that
   * exists. The relationship is per agency PER YEAR.
   */
  const db = semanticFixture((d) => d.prepare("INSERT INTO reliability VALUES (?,?,?)").run("TX0001", 2030, "v1"));
  const { health, trace } = evaluateCapability(withSemantic(RELIABILITY), ctx(db));
  assert.strictEqual(trace.boundary, "semantic_dependency");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /pairs absent from crime/);
  db.close();
});

check("a per-agency gap is caught even when the global year maxima agree", () => {
  /**
   * The review's second counterexample, and the one a MAX(year) comparison cannot see: crime holds
   * TX0001/2022 and CA9999/2024, reliability holds only CA9999/2024. Global maxima are equal, so a
   * span check passes while TX0001/2022 is qualified by nothing.
   */
  const db = semanticFixture((d) => {
    d.prepare("INSERT INTO crime VALUES (?,?)").run("CA9999", 2024);
    d.exec("DELETE FROM reliability");
    d.prepare("INSERT INTO reliability VALUES (?,?,?)").run("CA9999", 2024, "v1");
  });
  const maxima = db.prepare("SELECT (SELECT MAX(year) FROM reliability) AS r, (SELECT MAX(year) FROM crime) AS c").get() as { r: number; c: number };
  assert.strictEqual(maxima.r, maxima.c, "this case depends on the global maxima being equal");
  const { health, trace } = evaluateCapability(withSemantic(RELIABILITY), ctx(db));
  assert.strictEqual(trace.boundary, "semantic_dependency");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /unqualified by reliability/);
  db.close();
});

check("a qualifying table that stops short of the data it qualifies is degraded", () => {
  /**
   * The load-bearing case, and the one a row count cannot see: reliability is NONEMPTY and still
   * leaves 2024 unqualified, so every agency-year in the gap would read as usable.
   */
  const db = semanticFixture((d) => d.prepare("INSERT INTO crime VALUES (?,?)").run("TX0001", 2024));
  const { health, trace } = evaluateCapability(withSemantic(RELIABILITY), ctx(db));
  assert.strictEqual(trace.boundary, "semantic_dependency");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /unqualified|extends to/);
  db.close();
});

check("a nonempty but misaligned qualifying table would pass a row check and fails this one", () => {
  // Named explicitly so a later simplification to COUNT(*) > 0 fails here.
  const db = semanticFixture((d) => {
    d.exec("DELETE FROM reliability");
    d.prepare("INSERT INTO reliability VALUES (?,?,?)").run("ZZ9999", 2022, "v1");
  });
  const rows = db.prepare("SELECT COUNT(*) AS n FROM reliability").get() as { n: number };
  assert.strictEqual(rows.n, 1, "this case depends on the table being nonempty");
  assert.strictEqual(evaluateCapability(withSemantic(RELIABILITY), ctx(db)).trace.boundary, "semantic_dependency");
  db.close();
});

check("a mixed algorithm_version is degraded, and a single one is not", () => {
  const mixed = semanticFixture((d) => d.prepare("INSERT INTO reliability VALUES (?,?,?)").run("TX0001", 2022, "v2"));
  assert.strictEqual(evaluateCapability(withSemantic(RELIABILITY), ctx(mixed)).trace.boundary, "semantic_dependency");
  const single = semanticFixture();
  assert.strictEqual(evaluateCapability(withSemantic(RELIABILITY), ctx(single)).trace.boundary, "policy_incomplete");
  mixed.close();
  single.close();
});

check("a qualifying table recording no version at all is degraded", () => {
  const db = semanticFixture((d) => d.prepare("UPDATE reliability SET algorithm_version = NULL").run());
  const { health } = evaluateCapability(withSemantic(RELIABILITY), ctx(db));
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /record no algorithm_version|records no algorithm_version/);
  db.close();
});

check("SOME rows missing a version is degraded, not one version", () => {
  /**
   * Counting only non-null distinct values let a table of v1 rows plus null rows read as ONE
   * version. The null rows have no algorithm identity, so part of the table is unattributable
   * evidence -- worse than a clean two-version mix, and previously invisible.
   */
  const db = semanticFixture((d) => {
    d.prepare("INSERT INTO crime VALUES (?,?)").run("TX0001", 2023);
    d.prepare("INSERT INTO reliability VALUES (?,?,?)").run("TX0001", 2023, null);
  });
  const distinct = db.prepare("SELECT COUNT(DISTINCT algorithm_version) AS n FROM reliability WHERE algorithm_version IS NOT NULL").get() as { n: number };
  assert.strictEqual(distinct.n, 1, "this case depends on the non-null versions being a single value");
  const { health, trace } = evaluateCapability(withSemantic(RELIABILITY), ctx(db));
  assert.strictEqual(trace.boundary, "semantic_dependency");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /record no algorithm_version/);
  db.close();
});

check("a blank version string counts as missing, not as a value", () => {
  const db = semanticFixture((d) => d.prepare("UPDATE reliability SET algorithm_version = ?").run("  "));
  const { health } = evaluateCapability(withSemantic(RELIABILITY), ctx(db));
  assert.strictEqual(health.state, "degraded");
  db.close();
});

check("a missing or under-specified qualifying table is degraded", () => {
  const absent = semanticFixture((d) => d.exec("DROP TABLE reliability"));
  assert.strictEqual(evaluateCapability(withSemantic(RELIABILITY), ctx(absent)).trace.boundary, "semantic_dependency");
  const thin = semanticFixture((d) => {
    d.exec("DROP TABLE reliability; CREATE TABLE reliability (ori TEXT, year INTEGER)");
    d.prepare("INSERT INTO reliability VALUES (?,?)").run("TX0001", 2022);
  });
  const { health, trace } = evaluateCapability(withSemantic(RELIABILITY), ctx(thin));
  assert.strictEqual(trace.boundary, "semantic_dependency");
  /**
   * The SPECIFIC reason, not merely one mentioning the column. `/algorithm_version/` alone also
   * matched SQLite's own "no such column: algorithm_version" thrown later by the version count, so
   * the test passed while the required-column check was disabled -- it confirmed the wrong mechanism.
   */
  assert.match(health.reason ?? "", /is missing required column\(s\): algorithm_version/);
  assert.strictEqual(health.state, "degraded", "an under-specified qualifying table is a data defect, not an unknown");
  absent.close();
  thin.close();
});

check("an aligned qualifying table is recorded and evaluation continues", () => {
  const db = semanticFixture();
  const { trace } = evaluateCapability(withSemantic(RELIABILITY), ctx(db));
  assert.deepStrictEqual(trace.semanticChecked, ["reliability~crime(complete)"]);
  assert.strictEqual(trace.boundary, "policy_incomplete");
  db.close();
});

// ---------------------------------------------------------------- rollup preflight
/**
 * Preflight is DERIVED from the contract -- a capability reading a `rollup.` table needs the rollup
 * artifact -- rather than authored per capability. The seam that matters: the inspector reads the
 * CONFIGURED path while table checks read the PROVIDER's handle, so if those are different files,
 * structure and availability are judged against different databases.
 */
const NIBRS_ROLLUP = CAPABILITY_INVENTORY.find((s) =>
  s.artifact === "nibrs" && s.tables.some((t) => t.name.startsWith("rollup.")));
assert.ok(NIBRS_ROLLUP, "expected a rollup-reading NIBRS capability in the inventory");

/**
 * The rollup table is built from the CAPABILITY'S OWN declared columns, not from a hardcoded list.
 * Hardcoding them made the fixture describe a different capability than `find` selected, and the
 * failure looked like a preflight bug rather than a fixture mismatch.
 */
function rollupFixture(attachTo: string | null): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-rollup-"));
  const db = new Database(path.join(dir, "nibrs.db"));
  if (attachTo) {
    const declared = NIBRS_ROLLUP!.tables.find((t) => t.name.startsWith("rollup."))!;
    const table = declared.name.slice("rollup.".length);
    const columns = declared.requiredColumns;
    const rollup = new Database(attachTo);
    rollup.exec(`CREATE TABLE ${table} (${columns.map((c) => `${c} TEXT`).join(", ")})`);
    rollup.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => "?").join(",")})`)
      .run(...columns.map((c) => (c.includes("year") ? 2022 : "x")));
    rollup.close();
    db.exec(`ATTACH DATABASE '${attachTo.replaceAll("\\", "/")}' AS rollup`);
  }
  return { db, dir };
}
function withRollupEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.NIBRS_ROLLUP_DB_PATH;
  if (value === undefined) delete process.env.NIBRS_ROLLUP_DB_PATH;
  else process.env.NIBRS_ROLLUP_DB_PATH = value;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.NIBRS_ROLLUP_DB_PATH;
    else process.env.NIBRS_ROLLUP_DB_PATH = previous;
  }
}
const nibrsCtx = (db: Database.Database): HealthContext =>
  ({ sourceId: "nibrs", requestedYears: [2022], dbOverride: { db, resolvedPath: db.name } });

check("an unconfigured rollup surfaces the inspector's own reason", () => {
  const { db } = rollupFixture(null);
  const { health, trace } = withRollupEnv(undefined, () => evaluateCapability(NIBRS_ROLLUP!, nibrsCtx(db)));
  assert.strictEqual(trace.preflight, "failed");
  assert.strictEqual(trace.boundary, "preflight_failed");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /rollup-unconfigured/, "the inspector's finding must not be re-derived or lost");
  assert.deepStrictEqual(trace.tablesChecked, [], "nothing may be checked once preflight fails");
  db.close();
});

check("a configured rollup that is NOT the attached one is an artifact mismatch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-rollup-cfg-"));
  const attached = path.join(dir, "attached.db");
  const configured = path.join(dir, "configured.db");
  const { db } = rollupFixture(attached);
  fs.copyFileSync(attached, configured);            // a real, available file that is a DIFFERENT file
  const { health, trace } = withRollupEnv(configured, () => evaluateCapability(NIBRS_ROLLUP!, nibrsCtx(db)));
  assert.strictEqual(trace.boundary, "artifact_mismatch");
  assert.strictEqual(health.state, "degraded");
  assert.match(health.reason ?? "", /different files/);
  db.close();
});

check("a coherent rollup passes preflight and evaluation continues", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-rollup-ok-"));
  const rollupPath = path.join(dir, "rollup.db");
  const { db } = rollupFixture(rollupPath);
  const { trace } = withRollupEnv(rollupPath, () => evaluateCapability(NIBRS_ROLLUP!, nibrsCtx(db)));
  assert.strictEqual(trace.preflight, "ok");
  assert.ok(trace.tablesChecked.some((t) => t.startsWith("rollup.")), `expected a rollup table to be checked, saw ${trace.tablesChecked.join(",")}`);
  assert.strictEqual(trace.boundary, "policy_incomplete", `preflight blocked a coherent rollup: ${trace.boundary}`);
  db.close();
});

check("a capability that reads no rollup table skips preflight entirely", () => {
  // Otherwise every SHR and crime_data capability would depend on NIBRS configuration.
  const db = shrFixture();
  const { trace } = withRollupEnv(undefined, () => evaluateCapability(shr, ctx(db)));
  assert.strictEqual(trace.preflight, "skipped");
  assert.strictEqual(trace.boundary, "policy_incomplete");
  db.close();
});

// ---------------------------------------------------------------- Task 4: capability resolution
/**
 * Resolution comes from a fully VERIFIED token and from nothing else. There is no family lookup,
 * because a family cannot identify a capability.
 */
const RESOLVE_SQL = "SELECT year, COUNT(*) AS n FROM incidents GROUP BY year";

check("a capability resolves only from a token that verifies against SQL AND family", () => {
  const sealed = sealPlanDerivation("deterministic-murder", SHR_INCIDENTS_YEAR, RESOLVE_SQL);
  const resolved = resolveCapability("shr", sealed, RESOLVE_SQL, "deterministic-murder");
  assert.ok("capability" in resolved, JSON.stringify(resolved));
  assert.strictEqual((resolved as { capability: string }).capability, SHR_INCIDENTS_YEAR);
});

check("no derivation, rewritten SQL, or a disagreeing family all resolve to nothing", () => {
  const sealed = sealPlanDerivation("deterministic-murder", SHR_INCIDENTS_YEAR, RESOLVE_SQL);
  for (const [label, result] of [
    ["no token", resolveCapability("shr", null, RESOLVE_SQL, "deterministic-murder")],
    ["rewritten SQL", resolveCapability("shr", sealed, "SELECT 1", "deterministic-murder")],
    ["family mismatch", resolveCapability("shr", sealed, RESOLVE_SQL, "deterministic-shooting")],
    ["no SQL", resolveCapability("shr", sealed, null, "deterministic-murder")],
  ] as const) {
    assert.ok("unresolved" in result, `${label} must not resolve: ${JSON.stringify(result)}`);
  }
});

check("a missing or blank family claim is unresolved, never authorized", () => {
  /**
   * verifyPlanDerivation SKIPS the family comparison when expectedFamily is null or blank -- by
   * design, for callers with genuinely no independent claim. Resolution is not such a caller:
   * a capability feeds authorization, so an answer that cannot say which family it is being
   * recorded under has no business resolving one. Both skip paths previously returned a valid
   * SHR capability.
   */
  const sealed = sealPlanDerivation("deterministic-murder", SHR_INCIDENTS_YEAR, RESOLVE_SQL);
  for (const claim of [null, "", "   "]) {
    const resolved = resolveCapability("shr", sealed, RESOLVE_SQL, claim);
    assert.ok("unresolved" in resolved, `claimedFamily=${JSON.stringify(claim)} must not resolve`);
    assert.match((resolved as { unresolved: string }).unresolved, /family claim/,
      "the reason must name the missing claim, not a downstream symptom");
  }
});

check("a token naming NO capability is unresolved, which is every token sealed today", () => {
  /**
   * The fail-closed state, and the reason this task changes no production behaviour: none of the 12
   * production seal sites declares a capability yet, because no builder computes a structural id.
   * Inventing one at a route would be a claim about work the route did not do.
   */
  const legacy = sealPlanDerivation("deterministic-murder", RESOLVE_SQL);
  assert.strictEqual(legacy.capability, null, "an undeclared capability must be null, not absent-and-guessed");
  const resolved = resolveCapability("shr", legacy, RESOLVE_SQL, "deterministic-murder");
  assert.ok("unresolved" in resolved);
  assert.match((resolved as { unresolved: string }).unresolved, /sealed no capability/);
});

check("a blank capability reads as DECLARED NOTHING, not as an unknown contract", () => {
  /**
   * Why the capability is read off the verified verdict rather than the raw token: the verdict
   * normalizes blank to null, so an empty declaration is diagnosed as "sealed no capability".
   * Reading the raw field instead treats "   " as a declaration and reports "not in the registry" --
   * both refuse, but only one of them describes what actually happened, and the wrong one sends a
   * reader looking for a missing registry entry that was never named.
   */
  for (const blank of ["", "   "]) {
    const sealed = sealPlanDerivation("deterministic-murder", blank, RESOLVE_SQL);
    const resolved = resolveCapability("shr", sealed, RESOLVE_SQL, "deterministic-murder");
    assert.ok("unresolved" in resolved);
    assert.match((resolved as { unresolved: string }).unresolved, /sealed no capability/,
      `a blank capability (${JSON.stringify(blank)}) must be diagnosed as undeclared`);
  }
});

check("a capability that is not in the registry is unresolved", () => {
  const sealed = sealPlanDerivation("deterministic-murder", "shr::invented::nothing(x)", RESOLVE_SQL);
  const resolved = resolveCapability("shr", sealed, RESOLVE_SQL, "deterministic-murder");
  assert.ok("unresolved" in resolved);
  assert.match((resolved as { unresolved: string }).unresolved, /not in the registry/);
});

check("a source that does not own the capability's artifact is unresolved", () => {
  const sealed = sealPlanDerivation("deterministic-murder", SHR_INCIDENTS_YEAR, RESOLVE_SQL);
  for (const sourceId of ["current", "historical", "nibrs", "hate_crime"] as const) {
    const resolved = resolveCapability(sourceId, sealed, RESOLVE_SQL, "deterministic-murder");
    assert.ok("unresolved" in resolved, `${sourceId} must not resolve an shr capability`);
    assert.match((resolved as { unresolved: string }).unresolved, /belongs to shr/);
  }
});

check("two role branches of ONE family resolve to their own contracts", () => {
  /**
   * The case a family lookup answers wrongly whichever of the four it returns.
   * `deterministic-nibrs-continuous-reporters` spans four capabilities over four summary tables, and
   * sourceId cannot disambiguate them because all four are nibrs.
   */
  const family = "deterministic-nibrs-continuous-reporters";
  const branches = CAPABILITY_INVENTORY
    .filter((s) => s.artifact === "nibrs" && s.tables.some((t) => /summary_(victim|offender)_demographics/.test(t.name)))
    .slice(0, 2)
    .map((s) => s.capabilityId);
  assert.strictEqual(branches.length, 2, "expected two distinct NIBRS role-branch capabilities");
  assert.notStrictEqual(branches[0], branches[1]);
  for (const capability of branches) {
    const sealed = sealPlanDerivation(family, capability, RESOLVE_SQL);
    const resolved = resolveCapability("nibrs", sealed, RESOLVE_SQL, family);
    assert.strictEqual((resolved as { capability: string }).capability, capability,
      "one family must resolve to whichever contract the builder declared");
  }
});

check("only a verified verdict HAS a capability slot; a failed one cannot represent it", () => {
  /**
   * A structural invariant, not a runtime convention. DerivationVerdict is a discriminated union
   * whose ok:false branch has no capability member -- so `{ok: false, capability}` is unrepresentable
   * and the compiler, not a regression, is what excludes it. The first version asserted
   * `bad.capability === undefined` at runtime, which polices the convention while the type still
   * permitted the invalid state.
   */
  const sealed = sealPlanDerivation("deterministic-murder", SHR_INCIDENTS_YEAR, RESOLVE_SQL);
  const good = verifyPlanDerivation(sealed, RESOLVE_SQL, "deterministic-murder");
  assert.ok(good.ok && good.capability === SHR_INCIDENTS_YEAR);
  const bad = verifyPlanDerivation(sealed, "SELECT 1", "deterministic-murder");
  assert.strictEqual(bad.ok, false);
  if (!bad.ok) {
    // @ts-expect-error -- the failed branch has no capability member; if this line ever compiles,
    // the union has been widened back into the shape that could carry a capability on failure.
    void bad.capability;
  }
  assert.ok(!("capability" in bad), "a failed verdict must not carry a capability at runtime either");
});

check("a v1 token verifies as legacy with capability null, so no stored envelope was invalidated", () => {
  /**
   * The versioning the plan required, implemented in the verifier rather than refused: new tokens are
   * v2 and may carry a capability; v1 is accepted as legacy and always reads as capability null.
   * "Bump while reading older envelopes as null" needs both halves, and the first version of this
   * task wrongly declared them incompatible because it treated the strict version check as immutable.
   */
  const legacy = { v: LEGACY_PLAN_DERIVATION_VERSION, planFamily: "deterministic-murder", sqlFingerprint: fingerprintSql(RESOLVE_SQL), issuer: "route" as const };
  const verdict = verifyPlanDerivation(legacy, RESOLVE_SQL, "deterministic-murder");
  assert.strictEqual(verdict.ok, true, "a stored v1 envelope must still verify");
  assert.ok(verdict.ok && verdict.capability === null);
});

check("a capability is honored only from the version that defines it", () => {
  // A v1 token has no business naming a capability -- nothing sealed v1 tokens with one -- so a
  // capability smuggled onto a legacy shape reads as null, not as a declaration.
  const smuggled = {
    v: LEGACY_PLAN_DERIVATION_VERSION, planFamily: "deterministic-murder",
    sqlFingerprint: fingerprintSql(RESOLVE_SQL), issuer: "route" as const, capability: SHR_INCIDENTS_YEAR,
  };
  const verdict = verifyPlanDerivation(smuggled, RESOLVE_SQL, "deterministic-murder");
  assert.ok(verdict.ok && verdict.capability === null, "a v1 token must not carry a capability into a verdict");
  const resolved = resolveCapability("shr", smuggled, RESOLVE_SQL, "deterministic-murder");
  assert.ok("unresolved" in resolved, "a smuggled capability must not resolve");
});

check("new tokens are v2, and an unrecognized version still fails", () => {
  const sealed = sealPlanDerivation("deterministic-murder", SHR_INCIDENTS_YEAR, RESOLVE_SQL);
  assert.strictEqual(sealed.v, PLAN_DERIVATION_VERSION);
  assert.strictEqual(PLAN_DERIVATION_VERSION, 2);
  const future = { ...sealed, v: 3 };
  const verdict = verifyPlanDerivation(future, RESOLVE_SQL, "deterministic-murder");
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /version/);
});

check("the three-argument seal is (family, capability, sql), fingerprinting the SQL", () => {
  /**
   * The approved contract, which the taxonomy harness enforces on the plan's code. The first
   * implementation put the capability third; every argument is a string, so a caller following the
   * plan compiled cleanly while fingerprinting the CAPABILITY and storing the SQL as the capability.
   * This pins which argument is which by behaviour, not by name.
   */
  const sealed = sealPlanDerivation("deterministic-murder", SHR_INCIDENTS_YEAR, RESOLVE_SQL);
  assert.strictEqual(sealed.capability, SHR_INCIDENTS_YEAR, "the middle argument is the capability");
  assert.strictEqual(sealed.sqlFingerprint, fingerprintSql(RESOLVE_SQL), "the last argument is the SQL");
  assert.notStrictEqual(sealed.sqlFingerprint, fingerprintSql(SHR_INCIDENTS_YEAR),
    "the capability must never be what gets fingerprinted");
  // And the two-argument form still seals SQL with no capability, for the 12 existing sites.
  const twoArg = sealPlanDerivation("deterministic-murder", RESOLVE_SQL);
  assert.strictEqual(twoArg.capability, null);
  assert.strictEqual(twoArg.sqlFingerprint, fingerprintSql(RESOLVE_SQL));
});

// ---------------------------------------------------------------- Task 5: flag gate, cache, traces
/**
 * sourceHealthFor is the flag-gated entry point: global proof mode first (a capability flag cannot
 * override it -- invariant 14), then capability resolution, then the capability's own default-off
 * flag, then a cache keyed by non-forgeable handle identity, then evaluation with a trace.
 */
const SHR_FLAG = shr.flagKey;   // the PIN. Never derived here: the runtime reads what generation pinned.
const enabledEnv = { PROOF_MODE: "shadow", [SHR_FLAG]: "on" };
const shrSealed = sealPlanDerivation("deterministic-murder", SHR_INCIDENTS_YEAR, RESOLVE_SQL);
const callHealth = (c: HealthContext, env: ModeEnv) =>
  sourceHealthFor("shr", shrSealed, RESOLVE_SQL, "deterministic-murder", c, env);

check("an UNSET capability flag does not enable probing, and neither does garbage", () => {
  __resetSourceHealthCacheForTests();
  for (const env of [
    { PROOF_MODE: "shadow" },
    { PROOF_MODE: "shadow", [SHR_FLAG]: "off" },
    { PROOF_MODE: "shadow", [SHR_FLAG]: "1" },
    { PROOF_MODE: "shadow", [SHR_FLAG]: "true" },
    { PROOF_MODE: "shadow", [SHR_FLAG]: "yes" },
  ]) {
    const db = shrFixture();
    const health = callHealth(ctx(db), env);
    assert.strictEqual(health.state, "unknown", JSON.stringify(env));
    assert.match(health.reason ?? "", /not enabled/);
    db.close();
  }
  // Default-OFF means an explicit enabling value, not "anything truthy". An unset variable is not
  // a decision anyone made (§13).
  assert.deepStrictEqual(__healthTracesForTests(), []);
});

check("an enabled capability evaluates once and traces once", () => {
  __resetSourceHealthCacheForTests();
  const db = shrFixture();
  const health = callHealth(ctx(db), enabledEnv);
  const traces = __healthTracesForTests();
  assert.strictEqual(traces.length, 1);
  assert.strictEqual(traces[0].capability, SHR_INCIDENTS_YEAR);
  // The raw spec's policy is unauthored, so evaluation stops at policy_incomplete -- NOT
  // missing_receipt as the plan's draft expected; that boundary needs a complete policy.
  assert.strictEqual(traces[0].boundary, "policy_incomplete");
  assert.deepStrictEqual(traces[0].tablesChecked, ["incidents"]);
  assert.strictEqual(health.capability, SHR_INCIDENTS_YEAR);
  db.close();
});

check("global OFF does no source-health work at all, whatever the capability flag says", () => {
  // Invariant 14: a capability flag cannot override the global mode. And the kill switch beats both.
  __resetSourceHealthCacheForTests();
  for (const env of [
    { [SHR_FLAG]: "on" },                                        // no global mode set
    { PROOF_MODE: "off", [SHR_FLAG]: "on" },
    { PROOF_MODE: "shadow", PROOF_KILL_SWITCH: "on", [SHR_FLAG]: "on" },
  ]) {
    const db = shrFixture();
    const health = callHealth(ctx(db), env);
    assert.strictEqual(health.state, "unknown", JSON.stringify(env));
    db.close();
  }
  assert.deepStrictEqual(__healthTracesForTests(), [], "off must do no work, not merely report none");
});

/**
 * Swap the registry spec's provider for the duration of fn, restoring it whatever happens.
 * A const arrow, not a function declaration: a declaration hoists above the module-level
 * assert that narrows `shr`, so TypeScript rightly refuses the unnarrowed access inside it.
 */
const withPatchedProvider = <T,>(acquire: () => { db: Database.Database; resolvedPath: string } | null, fn: () => T): T => {
  const original = shr.database.acquire;
  (shr.database as { acquire: typeof original }).acquire = acquire;
  try { return fn(); }
  finally { (shr.database as { acquire: typeof original }).acquire = original; }
};

check("an unresolved answer never reaches the flag gate or the provider", () => {
  __resetSourceHealthCacheForTests();
  let acquired = 0;
  withPatchedProvider(() => { acquired++; return null; }, () => {
    const noCapability = sealPlanDerivation("deterministic-murder", RESOLVE_SQL);
    const health = sourceHealthFor("shr", noCapability, RESOLVE_SQL, "deterministic-murder",
      { requestedYears: [2022] }, enabledEnv);
    assert.strictEqual(health.state, "unknown");
    assert.strictEqual(health.capability, "unresolved");
    assert.match(health.reason ?? "", /sealed no capability/);
  });
  assert.strictEqual(acquired, 0, "an unresolved answer must not acquire a database");
  assert.deepStrictEqual(__healthTracesForTests(), []);
});

check("a disabled flag never acquires a database either", () => {
  __resetSourceHealthCacheForTests();
  let acquired = 0;
  withPatchedProvider(() => { acquired++; return null; }, () => {
    const health = sourceHealthFor("shr", shrSealed, RESOLVE_SQL, "deterministic-murder",
      { requestedYears: [2022] }, { PROOF_MODE: "shadow" });
    assert.match(health.reason ?? "", /not enabled/);
  });
  assert.strictEqual(acquired, 0, "the flag gate must precede acquisition");
});

check("a verdict for one database is never replayed for another", () => {
  __resetSourceHealthCacheForTests();
  const good = shrFixture();
  const broken = shrFixture((d) => d.exec("DELETE FROM incidents"));
  assert.match(callHealth(ctx(good), enabledEnv).reason ?? "", /policy/);
  assert.strictEqual(callHealth(ctx(broken), enabledEnv).state, "degraded");
  const traces = __healthTracesForTests();
  assert.strictEqual(traces.length, 2);
  assert.notStrictEqual(traces[0].dbIdentity, traces[1].dbIdentity, "identity must distinguish the handles");
  good.close();
  broken.close();
});

check("the same handle and period is served from cache", () => {
  __resetSourceHealthCacheForTests();
  const db = shrFixture();
  const first = callHealth(ctx(db), enabledEnv);
  const second = callHealth(ctx(db), enabledEnv);
  assert.strictEqual(__healthTracesForTests().length, 1, "the second call must be a cache hit");
  assert.deepStrictEqual(second, first);
  db.close();
});

check("a different requested period re-probes the same handle", () => {
  __resetSourceHealthCacheForTests();
  const db = shrFixture();
  callHealth(ctx(db, [2022]), enabledEnv);
  callHealth(ctx(db, [2019]), enabledEnv);
  assert.strictEqual(__healthTracesForTests().length, 2);
  db.close();
});

check("a stale cache entry re-probes after the TTL", () => {
  __resetSourceHealthCacheForTests();
  const db = shrFixture();
  let now = 1_000_000;
  __setHealthClockForTests(() => now);
  try {
    callHealth(ctx(db), enabledEnv);
    now += HEALTH_CACHE_TTL_MS - 1;
    callHealth(ctx(db), enabledEnv);
    assert.strictEqual(__healthTracesForTests().length, 1, "inside the TTL is a hit");
    now += 2;
    callHealth(ctx(db), enabledEnv);
    assert.strictEqual(__healthTracesForTests().length, 2, "past the TTL must re-probe");
  } finally {
    __setHealthClockForTests(null);
    db.close();
  }
});

check("the evaluation source is the authoritative first argument, and nothing can smuggle another", () => {
  /**
   * sourceHealthFor's first argument and a sourceId riding on the request object were two copies of
   * one fact. The gates and the cache key used the first; evaluation used the second. A first call
   * with a smuggled foreign source produced an artifact_mismatch verdict ATTRIBUTED TO THAT SOURCE,
   * cached under the outer key -- and a later, entirely correct call with the same handle and period
   * received it from cache. The request type now carries no sourceId, and a smuggled one (only
   * constructible by defeating the types) is overridden by construction order, not by a check.
   */
  __resetSourceHealthCacheForTests();
  const db = shrFixture();
  const smuggled = { sourceId: "current", requestedYears: [2022], dbOverride: { db, resolvedPath: db.name } };
  const first = sourceHealthFor("shr", shrSealed, RESOLVE_SQL, "deterministic-murder",
    smuggled as never, enabledEnv);
  assert.strictEqual(first.sourceId, "shr", "the verdict must be attributed to the authoritative source");
  const second = callHealth(ctx(db), enabledEnv);
  assert.strictEqual(second.sourceId, "shr");
  const traces = __healthTracesForTests();
  assert.strictEqual(traces.length, 1, "same source, handle and period: the second call is a cache hit");
  assert.strictEqual(traces[0].sourceId, "shr", "the trace must not carry the smuggled source");
  assert.notStrictEqual(traces[0].boundary, "artifact_mismatch",
    "a smuggled foreign source must not make the capability's own source look mismatched");
  db.close();
});

check("a per-family OFF override stops work after resolution, before the flag", () => {
  /**
   * resolveMode supports per-source AND per-family overrides, and the broad gate passed `null` for
   * the family permanently -- so global shadow + family OFF + capability flag on still acquired the
   * database and evaluated. The narrower override must win. The recheck runs AFTER resolution so the
   * family consulted is the VERIFIED one (preserving the W8 property), and BEFORE the capability
   * flag, so a disabled family never reads it.
   */
  __resetSourceHealthCacheForTests();
  const familyOff = { ...enabledEnv, [envKeyForFamily("shr", "deterministic-murder")]: "off" };
  let acquired = 0;
  withPatchedProvider(() => { acquired++; return null; }, () => {
    const health = sourceHealthFor("shr", shrSealed, RESOLVE_SQL, "deterministic-murder",
      { requestedYears: [2022] }, familyOff);
    assert.strictEqual(health.state, "unknown");
    assert.match(health.reason ?? "", /family/, "the reason must name the family override");
  });
  assert.strictEqual(acquired, 0, "a family-off answer must not acquire a database");
  assert.deepStrictEqual(__healthTracesForTests(), []);

  // An explicit family shadow (or on) still probes, so the recheck is an override, not a lockout.
  const db = shrFixture();
  const familyShadow = { ...enabledEnv, [envKeyForFamily("shr", "deterministic-murder")]: "shadow" };
  sourceHealthFor("shr", shrSealed, RESOLVE_SQL, "deterministic-murder",
    { requestedYears: [2022], dbOverride: { db, resolvedPath: db.name } }, familyShadow);
  assert.strictEqual(__healthTracesForTests().length, 1);
  db.close();
});

check("the cache is bounded: the oldest entry is evicted, not accumulated forever", () => {
  /**
   * TTL was freshness only -- expired and inactive keys were never removed, so every distinct
   * capability/handle/period key lived for the process lifetime. Proven behaviourally rather than by
   * size introspection: fill the cache to its cap with distinct periods, overflow it by one, and the
   * FIRST period must re-evaluate (it was evicted) while a late period is still served from cache.
   */
  __resetSourceHealthCacheForTests();
  assert.strictEqual(HEALTH_CACHE_MAX_ENTRIES, 256, "test arithmetic depends on the cap");
  const db = shrFixture();
  const at = (year: number) => callHealth(ctx(db, [year]), enabledEnv);
  for (let year = 0; year < HEALTH_CACHE_MAX_ENTRIES; year++) at(year);
  assert.strictEqual(__healthTracesForTests().length, HEALTH_CACHE_MAX_ENTRIES);
  at(HEALTH_CACHE_MAX_ENTRIES);                     // overflow by one
  at(0);                                            // the oldest key must have been evicted
  assert.strictEqual(__healthTracesForTests().length, HEALTH_CACHE_MAX_ENTRIES + 2,
    "the evicted oldest period must re-evaluate");
  at(HEALTH_CACHE_MAX_ENTRIES);                     // a late key is still cached
  assert.strictEqual(__healthTracesForTests().length, HEALTH_CACHE_MAX_ENTRIES + 2,
    "a recent key must still be served from cache");
  db.close();
});

check("the trace log is a bounded ring that drops the oldest entry", () => {
  // Every evaluation appended a full trace forever, cleared only by the test reset -- unbounded
  // growth for the lifetime of the process once Task 7 wires this into traffic.
  __resetSourceHealthCacheForTests();
  const db = shrFixture();
  callHealth(ctx(db, [900_000]), enabledEnv);
  const first = __healthTracesForTests()[0];
  for (let year = 0; year < HEALTH_TRACE_LIMIT; year++) callHealth(ctx(db, [year]), enabledEnv);
  const traces = __healthTracesForTests();
  assert.strictEqual(traces.length, HEALTH_TRACE_LIMIT, "the ring must hold exactly its limit");
  assert.ok(!traces.includes(first), "the OLDEST trace is the one dropped");
  db.close();
});

check("an unverified token is diagnosed as unverified, even when the flag is also off", () => {
  /**
   * Pins the gate ORDER: resolution before the capability flag. The two orders refuse identically
   * everywhere except when BOTH fail -- an invalid token whose claimed capability's flag is off --
   * where flag-first reports "not enabled" for a capability nothing verified. The flag consulted
   * must belong to a VERIFIED capability: an env-var lookup selected by an unverified declaration is
   * input-driven configuration, and the diagnosis should name the deeper defect.
   */
  __resetSourceHealthCacheForTests();
  const tampered = sealPlanDerivation("deterministic-murder", SHR_INCIDENTS_YEAR, RESOLVE_SQL);
  const health = sourceHealthFor("shr", tampered, "SELECT 1 /* rewritten */", "deterministic-murder",
    { requestedYears: [2022] }, { PROOF_MODE: "shadow" });   // flag ALSO off
  assert.strictEqual(health.state, "unknown");
  assert.match(health.reason ?? "", /not verified|does not match/, "the unverified token is the diagnosis");
  assert.doesNotMatch(health.reason ?? "", /not enabled/, "a flag named by an unverified token must not be the diagnosis");
});

check("a provider that throws during acquisition never takes down the response", () => {
  /**
   * Invariant 15: a probe must never take down a response. The plan's own draft acquired the handle
   * for the cache key OUTSIDE its try/catch, so a throwing provider -- the very case its comment
   * cites three lines later -- would have propagated to the route. Acquisition is guarded.
   */
  __resetSourceHealthCacheForTests();
  let acquired = 0;
  const health = withPatchedProvider(() => { acquired++; throw new Error("acquisition exploded"); }, () =>
    sourceHealthFor("shr", shrSealed, RESOLVE_SQL, "deterministic-murder",
      { requestedYears: [2022] }, enabledEnv));
  assert.strictEqual(acquired, 1, "the gate passed, so the provider must have been reached");
  assert.strictEqual(health.state, "unknown", "an unobtainable database is not evidence about the data");
  assert.match(health.reason ?? "", /acquisition exploded/);
  /**
   * Containment alone is not accounting. The verdict survived, but the enabled capability's failed
   * attempt vanished from the traces -- an operator diagnosing "why is this capability always
   * unknown" would find no record that it was ever tried. One truthful `threw` trace is required.
   */
  const traces = __healthTracesForTests();
  assert.strictEqual(traces.length, 1, "a failed acquisition of an ENABLED capability must be traced");
  assert.strictEqual(traces[0].boundary, "threw");
  assert.strictEqual(traces[0].dbIdentity, "no-db");
  assert.strictEqual(traces[0].capability, SHR_INCIDENTS_YEAR);
});

console.log(`\nsource health tests: ${passed} passed, ${failed} failed`);
