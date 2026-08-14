import assert from "node:assert";
import Database from "better-sqlite3";
import { evaluateCapability, identityOf, type HealthContext } from "../lib/source-health";
import { coverageBasisErrors } from "../lib/capability-policy";
import { CAPABILITY_INVENTORY, specFor, type CapabilitySpec } from "../lib/source-health-inventory";

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
      coverage: { table: "incidents", yearColumn: "year" },
      integrity: ["required structure is readable"],
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
    policy: { ...spec.policy!, coverage: { table: "unrelated", yearColumn: "year" } },
  };
  const { trace } = evaluateCapability(strayBasis, ctx(db, [1999]));
  assert.strictEqual(trace.coverage, "unknown", "coverage was judged from a table outside the capability");
  assert.strictEqual(trace.boundary, "missing_receipt");
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
    policy: { ...spec.policy!, coverage: { table: "incidents", yearColumn: "foreign_year" } },
  };
  const { trace } = evaluateCapability(strayColumn, ctx(db, [2022]));
  assert.strictEqual(trace.coverage, "unknown", "coverage was judged from a column outside the contract");
  assert.strictEqual(trace.boundary, "missing_receipt");
  // The required column still yields a real verdict, so the guard is not simply refusing everything.
  assert.strictEqual(evaluateCapability(spec, ctx(db, [2022])).trace.coverage, "passed");
  db.close();
});

check("the coverage-basis rule is the shared one, table and column together", () => {
  // Same function the registry regression applies, so runtime and validation cannot drift apart.
  const declared = [{ name: "incidents", requiredColumns: ["year"] }];
  const authored = (coverage: unknown) => coverageBasisErrors({ coverage } as never, declared);
  assert.deepStrictEqual(authored({ table: "incidents", yearColumn: "year" }), []);
  assert.strictEqual(authored({ table: "incidents", yearColumn: "foreign_year" }).length, 1);
  assert.strictEqual(authored({ table: "unrelated", yearColumn: "year" }).length, 1);
  assert.deepStrictEqual(coverageBasisErrors(null, declared), [], "an unauthored basis is not an error");
  assert.deepStrictEqual(coverageBasisErrors({} as never, declared), [], "an absent basis is not an error");
});

check("coverage is unknown when the basis table has no year bounds", () => {
  const db = shrFixture((fixture) => fixture.exec("UPDATE incidents SET year = NULL"));
  const { trace } = evaluateCapability(withPolicy(shr), ctx(db, [2022]));
  assert.strictEqual(trace.coverage, "unknown");
  db.close();
});

console.log(`\nsource health tests: ${passed} passed, ${failed} failed`);
