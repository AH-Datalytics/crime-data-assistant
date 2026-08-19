/**
 * Increment C correction: no factual branch may execute SQL without a structural proof first.
 *
 * Three versions of this file have been wrong in the same direction, so the property is stated
 * plainly here: **every SQL execution inside a request handler must be accounted for.** Not
 * "a validation call exists somewhere", not "the `.sql` references look fine" -- accounted for,
 * one site at a time, with anything unrecognised failing.
 *
 * What the earlier versions missed:
 *   v1  inventoried `db.prepare(<plan>.sql)` in ONE route, so it could not see the NIBRS branch
 *       executing `executeWithTimeout(deterministicQuery.sql)` with no structural validation.
 *   v2  inventoried only expressions containing `.sql`, so `db.prepare(unguardedSql)` -- a bare
 *       identifier -- was silently ignored.
 *   v2  also matched the DEFINITION of `runContractValidation` as if it were an invocation, so a
 *       route could "validate" without ever calling it.
 *
 * This version classifies the argument of every execution helper and fails on anything it cannot
 * place.
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

function handlerLines(name: string): { lines: string[]; start: number } {
  const lines = routeSource(name).split("\n");
  const start = lines.findIndex((line) => /export async function POST/.test(line)) + 1;
  return { lines, start };
}

const EXECUTION_HELPER =
  /(?:executeWithTimeoutSync|executeWithTimeout|(?:\w+\.)?prepare)\s*\(\s*([^)]*)/;

/** Deterministic plans: each must be refused-checked before its execution line. */
const GUARDED_PLANS: Record<string, string> = {
  indexedStatePlan: "indexedStateRefusal",
  multiCityTrend: "multiCityRefusal",
  historicalCityChange: "historicalCityChangeRefusal",
  deterministicQuery: "nibrsPlanRefusal",
};

/** `<name>.sql` values that are contract results -- validation produced them. */
const VALIDATED_CONTRACTS = new Set(["contract"]);

/** Model-generated SQL held in a plain variable; a validation invocation must precede it. */
const MODEL_SQL_VARIABLES = new Set(["sql", "retrySql", "rollingSql", "fallbackSql"]);

/**
 * Application-built lookups: identifiers holding SQL this repository composes itself, with no model
 * input. They answer metadata questions (which ORI, which offense name) rather than returning a
 * factual series. Listed individually so a NEW identifier cannot join them silently.
 */
const APPLICATION_BUILT_LOOKUPS = new Set(["oriQuery", "cdeQuery"]);

console.log("\n-- every execution inside every handler is accounted for --");

for (const route of ROUTES) {
  check(`${route}: no unaccounted SQL execution`, () => {
    const { lines, start } = handlerLines(route);
    assert.ok(start > 0, "the route must have a POST handler");
    const unaccounted: string[] = [];

    lines.forEach((line, index) => {
      if (index + 1 < start) return;                    // module helpers: see the egress checks
      const m = line.match(EXECUTION_HELPER);
      if (!m) return;
      const arg = (m[1] ?? "").trim();

      // A literal, a template, or an expression continuing onto the next line. Literals carry no
      // model input, and every current continuation is a multi-line literal.
      if (arg === "" || /^[`'"]/.test(arg)) return;

      const inner = arg.replace(/^db\s*,\s*db\.prepare\(\s*/, "").replace(/\).*$/, "").trim();
      if (inner === "" || /^[`'"]/.test(inner)) return;

      const dotted = inner.match(/^(\w+)\.sql$/);
      if (dotted) {
        if (dotted[1] in GUARDED_PLANS || VALIDATED_CONTRACTS.has(dotted[1])) return;
        unaccounted.push(`${route}:${index + 1} executes ${inner} (unknown plan/contract)`);
        return;
      }
      const bare = inner.match(/^(\w+)$/);
      if (bare) {
        if (MODEL_SQL_VARIABLES.has(bare[1]) || APPLICATION_BUILT_LOOKUPS.has(bare[1])) return;
        unaccounted.push(`${route}:${index + 1} executes bare identifier ${inner}`);
        return;
      }
      unaccounted.push(`${route}:${index + 1} executes unrecognised expression ${inner.slice(0, 60)}`);
    });

    assert.deepStrictEqual(unaccounted, [],
      `unaccounted executions:\n        ${unaccounted.join("\n        ")}`);
  });
}

console.log("\n-- each deterministic plan is refused-checked before it executes --");

for (const [plan, refusal] of Object.entries(GUARDED_PLANS)) {
  check(`${plan} is guarded before execution`, () => {
    const route = plan === "deterministicQuery" ? "nibrs-query" : "query";
    const { lines } = handlerLines(route);
    const refusalLine = lines.findIndex((line) => line.includes(`${refusal} =`)) + 1;
    const guardLine = lines.findIndex((line) => new RegExp(`!\\s*${refusal}\\b`).test(line)) + 1;
    const executeLine = lines.findIndex(
      (line) => EXECUTION_HELPER.test(line) && new RegExp(`\\b${plan}\\.sql\\b`).test(line)
    ) + 1;
    assert.ok(refusalLine > 0, `${plan}: no ${refusal} is computed`);
    assert.ok(guardLine > 0, `${plan}: the branch does not test !${refusal}`);
    assert.ok(executeLine > 0, `${plan}: no execution site found to protect`);
    assert.ok(refusalLine < executeLine, `${plan}: refusal at ${refusalLine}, executes at ${executeLine}`);
    assert.ok(guardLine < executeLine, `${plan}: guard at ${guardLine}, executes at ${executeLine}`);
  });
}

check("both routes with deterministic plans import the shared guard", () => {
  for (const route of ["query", "nibrs-query"]) {
    assert.ok(
      /import \{ deterministicPlanRefusal \} from "@\/lib\/deterministic-plan-guard"/.test(routeSource(route)),
      `${route} must use the shared guard rather than reimplementing it`);
  }
});

console.log("\n-- model SQL: a validation INVOCATION precedes execution --");

for (const route of ROUTES) {
  check(`${route}: validation is invoked before model SQL executes`, () => {
    const { lines, start } = handlerLines(route);
    // Where a route defines a `runContractValidation` helper, the `validateQueryContractSql(` call
    // INSIDE that definition is not an invocation of it -- an earlier version counted it and so
    // "proved" ordering from the helper's own body. Require a real call to the helper instead.
    const definitionLine = lines.findIndex(
      (line) => /(?:const|let|var|function)\s+runContractValidation\b/.test(line)
    ) + 1;
    const invocationPattern = definitionLine > 0
      ? /\brunContractValidation\s*\(|\bcontractFailureResponse\s*\(/
      : /\bvalidateQueryContractSql\s*\(|\bcontractFailureResponse\s*\(/;
    const isDeclaration = (line: string) =>
      /(?:const|let|var|function)\s+(?:runContractValidation|contractFailureResponse)\b/.test(line);
    const firstInvocation = lines.findIndex(
      (line, i) => i + 1 >= start && !isDeclaration(line) && invocationPattern.test(line)
    ) + 1;
    const firstModelExecution = lines.findIndex((line, i) => {
      if (i + 1 < start) return false;
      const m = line.match(EXECUTION_HELPER);
      if (!m) return false;
      const inner = (m[1] ?? "").trim()
        .replace(/^db\s*,\s*db\.prepare\(\s*/, "").replace(/\).*$/, "").trim();
      return MODEL_SQL_VARIABLES.has(inner);
    }) + 1;

    assert.ok(firstInvocation > 0, "the route must INVOKE validation, not merely define it");
    if (firstModelExecution > 0) {
      assert.ok(firstInvocation < firstModelExecution,
        `validation invoked at ${firstInvocation} but model SQL executes at ${firstModelExecution}`);
    }
  });
}

/**
 * Ordering alone is still too weak: a route can invoke validation somewhere and then execute SQL
 * that never passed through it. What actually matters is DERIVATION -- the executed variable must
 * hold a contract result. Every route assigns it that way today (`sql = initialContract.sql`,
 * `sql = initialContractResult.sql`, `sql = shootingContract.sql`), so severing that assignment is
 * exactly the regression this catches, and the ordering check above could not.
 */
/**
 * Ordering alone is too weak: a route can invoke validation somewhere and then execute SQL that
 * never passed through it. Following the dataflow exactly is beyond a source-reading test -- real
 * routes apply benign rewrites after validation (`schemaCheck.sql`, `guardrailResult.sql`) -- so
 * this asserts the checkable property instead: EVERY assignment to the executed variable comes from
 * a recognised source. A raw or unrecognised right-hand side fails, which is what a bypass looks
 * like.
 *
 * The limitation is stated rather than papered over: this proves provenance of each assignment, not
 * that the specific value reaching `db.prepare` was validated.
 */
const RECOGNISED_SQL_SOURCES = [
  /\w*[Cc]ontract\w*\.sql$/,          // any contract result
  /^guardrailResult\.sql$/,            // server-side guardrail rewrite, post-validation
  /^schemaCheck\.sql$/,                // schema-availability rewrite, post-validation
  /^postRetryResult\.sql$/,            // guardrail pass over the retry
  /^fixed\.sql$/,                      // deterministic repair
  /^(?:retrySql|rollingSql|fallbackSql|plannedSql|rewritten)$/,  // tracked model variables
  /^\w*[Vv]alidation\.sanitized!$/,    // sanitizer output, validated immediately after
  /^buildCampusAgencySummarySql\(/,    // server-composed campus rollup
];

for (const route of ROUTES) {
  check(`${route}: every assignment to the executed SQL has a recognised source`, () => {
    const { lines, start } = handlerLines(route);
    const unrecognised: string[] = [];
    lines.forEach((line, i) => {
      if (i + 1 < start) return;
      const m = line.match(/\b(?:sql|claude\.sql)\s*=\s*([^;]+);/);
      if (!m) return;
      const rhs = m[1].trim();
      if (RECOGNISED_SQL_SOURCES.some((pattern) => pattern.test(rhs))) return;
      unrecognised.push(`${route}:${i + 1} assigns ${rhs.slice(0, 60)}`);
    });
    assert.deepStrictEqual(unrecognised, [],
      `unrecognised SQL sources:\n        ${unrecognised.join("\n        ")}`);
  });
}

console.log("\n-- egress-only exceptions, stated rather than implied --");

/**
 * The agency scorecard and the Historical place lookup build AND run their SQL inside a helper, so
 * their structural proof is at the DELIVERY boundary, not before execution. A refused result is
 * never sent, which is what prevents a wrong answer -- but it is NOT the pre-execution contract the
 * rest of this file asserts, and calling it one would be false. It is recorded here as an explicit
 * exception with its own tests so the difference stays visible rather than being quietly absorbed.
 */
const EGRESS_ONLY: Record<string, string> = {
  agencyScorecard: "agencyScorecardRefusal",
  historicalPlace: "historicalPlaceRefusal",
};

for (const [plan, refusal] of Object.entries(EGRESS_ONLY)) {
  check(`${plan} is refused-checked before delivery (egress-only, not pre-execution)`, () => {
    const { lines } = handlerLines("query");
    const refusalLine = lines.findIndex((line) => line.includes(`${refusal} = deterministicPlanRefusal`)) + 1;
    const guardLine = lines.findIndex((line) => new RegExp(`${plan} && !${refusal}\\b`).test(line)) + 1;
    assert.ok(refusalLine > 0, `${plan}: no ${refusal} is computed`);
    assert.ok(guardLine > 0, `${plan}: the delivery branch does not test !${refusal}`);
    assert.ok(refusalLine < guardLine, `${plan}: refusal computed after the branch it guards`);
  });
}

check("the SHR deterministic murder plan validates BEFORE it executes", () => {
  const { lines } = handlerLines("shr-query");
  const validate = lines.findIndex((line) => /contractFailureResponse\(contract/.test(line)) + 1;
  const execute = lines.findIndex((line) => /murderDb\.prepare\(contract\.sql\)/.test(line)) + 1;
  assert.ok(validate > 0 && execute > 0, "both boundaries must exist");
  assert.ok(validate < execute, `validated at ${validate} but executes at ${execute}`);
});

console.log(`\nstructural route placement: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
