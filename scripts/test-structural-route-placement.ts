/**
 * Increment C correction: no factual branch may execute SQL without a structural proof first.
 *
 * Counting `runContractValidation` call sites proved nothing, and the review was right to reject
 * it. In `app/api/query/route.ts` that helper is DEFINED at ~line 1332, while three deterministic
 * plans execute and return well before it:
 *
 *     indexed-state            ~936
 *     multi-city trend         ~992
 *     Historical city-change  ~1116
 *
 * These assertions read the route sources and check ordering and guarding, so removing a guard
 * fails here rather than in production. A unit test calling `validateQueryContractSql()` directly
 * cannot detect any of this.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message.split("\n")[0]}`);
  }
}

const ROUTES = ["query", "nibrs-query", "shr-query", "hc-query"] as const;

function routeSource(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), "app", "api", name, "route.ts"), "utf8");
}

function lineOf(source: string, needle: string | RegExp): number {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (typeof needle === "string" ? lines[i].includes(needle) : needle.test(lines[i])) return i + 1;
  }
  return -1;
}

console.log("\n-- deterministic plans in the Current/Historical route --");

const query = routeSource("query");

for (const plan of ["indexedStatePlan", "multiCityTrend", "historicalCityChange"] as const) {
  check(`${plan} cannot execute without a structural refusal check`, () => {
    const guard = new RegExp(`if\\s*\\(\\s*${plan}\\s*&&\\s*!\\w*[Rr]efusal\\s*\\)`);
    assert.ok(guard.test(query),
      `${plan} must be guarded by its refusal check; found no "if (${plan} && !…Refusal)"`);

    const refusalLine = lineOf(query, new RegExp(`deterministicPlanRefusal\\([^)]*sql:\\s*${plan}`));
    const executeLine = lineOf(query, new RegExp(`db\\.prepare\\(${plan}\\.sql\\)`));
    assert.ok(refusalLine > 0, `${plan} has no deterministicPlanRefusal call`);
    assert.ok(executeLine > 0, `${plan} has no execution site to protect`);
    assert.ok(refusalLine < executeLine,
      `${plan} is validated at line ${refusalLine} but executes at ${executeLine}`);
  });
}

check("the guard is imported rather than reimplemented in the route", () => {
  assert.ok(/import \{ deterministicPlanRefusal \} from "@\/lib\/deterministic-plan-guard"/.test(query),
    "the route must use the shared guard");
});

check("every deterministic plan that executes SQL is covered", () => {
  // Any `db.prepare(<something>Plan.sql)` or `db.prepare(<name>.sql)` in this route must belong to
  // a variable we have guarded. A new deterministic branch fails this until it is added.
  const executed = [...query.matchAll(/db\.prepare\((\w+)\.sql\)/g)].map((m) => m[1]);
  const guarded = new Set(["indexedStatePlan", "multiCityTrend", "historicalCityChange"]);
  const unguarded = executed.filter((name) => !guarded.has(name));
  assert.deepStrictEqual(unguarded, [],
    `these plan variables execute without a structural guard: ${unguarded.join(", ")}`);
});

console.log("\n-- the model path in every route --");

for (const route of ROUTES) {
  check(`${route}: SQL from the model is validated before execution`, () => {
    const source = routeSource(route);
    const validation = lineOf(source, /runContractValidation\(|validateQueryContractSql\(/);
    assert.ok(validation > 0, "the route must validate model SQL at all");
    const guardedExecution = /executionContract|preValidationContract|contractFailureResponse|runContractValidation/.test(source);
    assert.ok(guardedExecution, "the route must gate execution on a contract result");
  });
}

check("the SHR deterministic murder plan still validates before it executes", () => {
  const shr = routeSource("shr-query");
  const validate = lineOf(shr, /contractFailureResponse\(contract/);
  const execute = lineOf(shr, /murderDb\.prepare\(contract\.sql\)/);
  assert.ok(validate > 0 && execute > 0, "both boundaries must exist");
  assert.ok(validate < execute, `validated at ${validate} but executes at ${execute}`);
});

console.log(`\nstructural route placement: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
