/**
 * Increment C correction: no factual branch may execute SQL without a structural proof first.
 *
 * Counting `runContractValidation` call sites proved nothing. In `app/api/query/route.ts` that
 * helper is DEFINED at ~1332 while three deterministic plans execute and return at ~942, ~1000 and
 * ~1126; the NIBRS route executed `executeWithTimeout(deterministicQuery.sql)` with no structural
 * validation at all.
 *
 * The first version of this file also inventoried only `db.prepare(<plan>.sql)` in one route, so it
 * could not have seen the NIBRS gap. This version enumerates every factual execution helper across
 * all four routes and classifies what each one executes: either a contract result (already
 * validated), or a deterministic plan that must be guarded before its execution line. Anything else
 * fails, which is what makes a NEW unguarded branch fail here rather than in production.
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

/** Every helper that can run answer-bearing SQL. */
const EXECUTION_HELPERS = /(?:executeWithTimeoutSync|executeWithTimeout|(?:\w+\.)?prepare)\s*\(/;

/**
 * Identifiers whose `.sql` is a CONTRACT RESULT -- validation already happened to produce them.
 * These are the model path's own variables.
 */
const VALIDATED_CONTRACTS = new Set([
  "contract", "contractResult", "executionContract", "preValidationContract", "postRetryContract",
  "retryContract", "rollingContract", "initialContractResult",
]);

/** Deterministic plans, each of which must be refused-checked before it executes. */
const GUARDED_PLANS: Record<string, string> = {
  indexedStatePlan: "indexedStateRefusal",
  multiCityTrend: "multiCityRefusal",
  historicalCityChange: "historicalCityChangeRefusal",
  deterministicQuery: "nibrsPlanRefusal",
};

/**
 * Two deterministic answers build and run their SQL inside a helper, so the execution line sits in
 * the builder rather than the branch. Their proof is at the DELIVERY boundary instead: a refused
 * result is never sent. That is the property worth asserting, and it is what these check.
 */
const GUARDED_AT_DELIVERY: Record<string, string> = {
  agencyScorecard: "agencyScorecardRefusal",
  historicalPlace: "historicalPlaceRefusal",
};

console.log("\n-- every factual execution helper, in every route --");

for (const route of ROUTES) {
  check(`${route}: every executed .sql is a contract result or a guarded plan`, () => {
    const source = routeSource(route);
    const lines = source.split("\n");
    const unaccounted: string[] = [];

    const handlerStart = lines.findIndex((line) => /export async function POST/.test(line)) + 1;
    lines.forEach((line, index) => {
      if (index + 1 < handlerStart) return;   // module-level helpers are proved at delivery
      if (!EXECUTION_HELPERS.test(line)) return;
      for (const m of line.matchAll(/\b(\w+)\.sql\b/g)) {
        const name = m[1];
        if (VALIDATED_CONTRACTS.has(name)) continue;
        if (name in GUARDED_PLANS) continue;
        unaccounted.push(`${route}:${index + 1} executes ${name}.sql`);
      }
    });

    assert.deepStrictEqual(unaccounted, [],
      `unaccounted factual executions:\n        ${unaccounted.join("\n        ")}`);
  });
}

console.log("\n-- each deterministic plan is refused-checked before it executes --");

for (const [plan, refusal] of Object.entries(GUARDED_PLANS)) {
  check(`${plan} is guarded before execution`, () => {
    const route = plan === "deterministicQuery" ? "nibrs-query" : "query";
    const lines = routeSource(route).split("\n");

    const refusalLine = lines.findIndex((line) => line.includes(`${refusal} =`)) + 1;
    const executeLine = lines.findIndex(
      (line) => EXECUTION_HELPERS.test(line) && new RegExp(`\\b${plan}\\.sql\\b`).test(line)
    ) + 1;
    const guardLine = lines.findIndex((line) => new RegExp(`!\\s*${refusal}\\b`).test(line)) + 1;

    assert.ok(refusalLine > 0, `${plan}: no ${refusal} is computed`);
    assert.ok(executeLine > 0, `${plan}: no execution site found to protect`);
    assert.ok(guardLine > 0, `${plan}: the branch does not test !${refusal}`);
    assert.ok(refusalLine < executeLine,
      `${plan}: refusal computed at ${refusalLine} but executes at ${executeLine}`);
    assert.ok(guardLine < executeLine,
      `${plan}: guard at ${guardLine} but executes at ${executeLine}`);
  });
}

check("both routes with deterministic plans import the shared guard", () => {
  for (const route of ["query", "nibrs-query"]) {
    assert.ok(
      /import \{ deterministicPlanRefusal \} from "@\/lib\/deterministic-plan-guard"/.test(routeSource(route)),
      `${route} must use the shared guard rather than reimplementing it`);
  }
});

console.log("\n-- deterministic answers built inside a helper are guarded at delivery --");

for (const [plan, refusal] of Object.entries(GUARDED_AT_DELIVERY)) {
  check(`${plan} is refused-checked before it is delivered`, () => {
    const lines = routeSource("query").split("\n");
    const refusalLine = lines.findIndex((line) => line.includes(`${refusal} = deterministicPlanRefusal`)) + 1;
    const guardLine = lines.findIndex((line) => new RegExp(`${plan} && !${refusal}\\b`).test(line)) + 1;
    assert.ok(refusalLine > 0, `${plan}: no ${refusal} is computed`);
    assert.ok(guardLine > 0, `${plan}: the delivery branch does not test !${refusal}`);
    assert.ok(refusalLine < guardLine, `${plan}: refusal computed after the branch it guards`);
  });
}

console.log("\n-- the model path validates before executing, in every route --");

for (const route of ROUTES) {
  check(`${route}: model SQL is validated before the first execution`, () => {
    const lines = routeSource(route).split("\n");
    const firstValidation = lines.findIndex(
      (line) => /runContractValidation\(|validateQueryContractSql\(|contractFailureResponse\(/.test(line)
    ) + 1;
    // Only executions INSIDE the request handler are the model path. Helpers defined above it --
    // `answerHistoricalPlaceLookup` is the one that matters -- build their own SQL from server-side
    // predicates and are proved at their delivery boundary instead, which the checks above assert.
    const handlerStart = lines.findIndex((line) => /export async function POST/.test(line)) + 1;
    assert.ok(handlerStart > 0, "the route must have a POST handler");
    const firstModelExecution = lines.findIndex(
      (line, i) => i + 1 > handlerStart
        && EXECUTION_HELPERS.test(line)
        && /\((?:\s*db\s*,\s*db\.prepare\()?\s*sql\s*\)/.test(line)
    ) + 1;
    assert.ok(firstValidation > 0, "the route must validate model SQL at all");
    if (firstModelExecution > 0) {
      assert.ok(firstValidation < firstModelExecution,
        `validation first appears at ${firstValidation} but model SQL executes at ${firstModelExecution}`);
    }
  });
}

check("the SHR deterministic murder plan still validates before it executes", () => {
  const lines = routeSource("shr-query").split("\n");
  const validate = lines.findIndex((line) => /contractFailureResponse\(contract/.test(line)) + 1;
  const execute = lines.findIndex((line) => /murderDb\.prepare\(contract\.sql\)/.test(line)) + 1;
  assert.ok(validate > 0 && execute > 0, "both boundaries must exist");
  assert.ok(validate < execute, `validated at ${validate} but executes at ${execute}`);
});

console.log(`\nstructural route placement: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
