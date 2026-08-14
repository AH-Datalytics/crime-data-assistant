import assert from "node:assert";
import Database from "better-sqlite3";
import { evaluateCapability, type HealthContext } from "../lib/source-health";
import { specFor, type CapabilitySpec } from "../lib/source-health-inventory";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
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

console.log(`\nsource health tests: ${passed} passed`);
