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
    // Every line of the message: a multi-line diagnostic (for example the list of unrecognised
    // assignments) must show the offending line, not only its first line.
    console.log(`        ${(error as Error).message.split("\n").join("\n        ")}`);
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

/*
 * Every helper that can run SQL from a route.
 *
 * `executeManyWithTimeoutSync` had to be added here: the name does not contain
 * `executeWithTimeout`, so when the paired snapshot read was introduced this scan stopped seeing
 * that execution site altogether — an execution helper invisible to the accounting is worse than
 * an unaccounted call, because it reports success. A new helper must be listed.
 */
/*
 * A GENERIC TYPE ARGUMENT used to hide the call. `\s*\(` cannot match
 * `executeWithTimeoutSync<Record<string, unknown>>(`, so those lines were only ever matched by the
 * `db.prepare(` inside them. A paired call has no `prepare` at all, so it matched nothing and this
 * scan reported success over an execution it could not see. The type argument is skipped now.
 */
const EXECUTION_HELPER =
  /(?:executeManyWithTimeoutSync|executeWithTimeoutSync|executeWithTimeout|(?:\w+\.)?prepare)\s*(?:<[^(\n]*>)?\s*\(\s*([^)]*)/;

/** Helpers that take an ARRAY of statements rather than one prepared statement. */
const MULTI_STATEMENT_HELPER = /executeManyWithTimeoutSync\s*(?:<[^(\n]*>)?\s*\(/;

/**
 * Strip `//` line comments so comment prose is never parsed as an argument.
 *
 * No `$` anchor: these lines can still carry a trailing `\r`, and `$` without the `m` flag matches
 * only at the end of the whole string, so an anchored pattern silently stripped nothing. `.*` stops
 * at the line terminator by itself.
 */
function stripLineComments(text: string): string {
  return text.split("\n").map((l) => l.replace(/\/\/.*/, "")).join("\n");
}

/**
 * The full text of a call starting on `startIndex`, read to its balanced closing parenthesis.
 *
 * A fixed line window silently truncated a multi-line call and made the accounting report a missing
 * statement array. Bounded to 40 lines so a malformed file cannot make this run away.
 */
function callText(lines: string[], startIndex: number): string {
  const collected: string[] = [];
  let depth = 0;
  let started = false;
  for (let i = startIndex; i < Math.min(lines.length, startIndex + 40); i += 1) {
    const line = stripLineComments(lines[i]);
    collected.push(lines[i]);
    for (const ch of line) {
      if (ch === "(") { depth += 1; started = true; }
      else if (ch === ")") depth -= 1;
    }
    if (started && depth <= 0) break;
  }
  return collected.join("\n");
}

/** Deterministic plans: each must be refused-checked before its execution line. */
const GUARDED_PLANS: Record<string, string> = {
  indexedStatePlan: "indexedStateRefusal",
  multiCityTrend: "multiCityRefusal",
  historicalCityChange: "historicalCityChangeRefusal",
  deterministicQuery: "nibrsPlanRefusal",
  // The owned yearly-clearance family plans into its own variable and hands the same refusal to
  // `runOwnedAnnualClearance`; its executor runs only when that refusal is absent.
  ownedQuery: "nibrsPlanRefusal",
  yoyComparisonPlan: "yoyComparisonRefusal",
  // City rankings are constructed from a declared request (lib/city-ranking.ts) and refused-
  // checked like every other deterministic plan before they execute.
  cityRankingPlan: "cityRankingRefusal",
  // The NIBRS owned-statement executor: GC-065's category comparison and the city ranking's S1
  // candidates read (lib/nibrs-category-change.ts, lib/city-ranking-completeness.ts). It re-proves each
  // application-built statement immediately before running it.
  ownedStatement: "ownedStatementRefusal",
  // The Current city ranking's S1 candidates read, refused-checked like the ranked statement it precedes.
  cityRankingEvidence: "cityRankingEvidenceRefusal",
};

/**
 * Paired evidence reads: a `<plan>.<field>` execution that is NOT the answer-bearing statement.
 *
 * `yoyComparisonPlan.periodSql` returns the required year/month periods and
 * `yoyComparisonPlan.membershipSql` the selected agency identifiers and starting sample size.
 * Neither projects a measure and neither result is delivered as a figure: they establish which
 * periods are required and which agencies form the comparison group. Both share their `WITH` prefix
 * verbatim with the guarded `.sql` — the plan builds all three from one `withClause` string, and
 * `test-period-correctness` asserts that identity. They carry no model input.
 *
 * Listed individually, and only for a plan that is already in GUARDED_PLANS, so a new evidence read
 * cannot join this exception silently.
 */
const PLAN_EVIDENCE_READS = new Set([
  "yoyComparisonPlan.periodSql",
  "yoyComparisonPlan.sampleSql",
  "yoyComparisonPlan.membershipSql",
]);

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

/**
 * Already-prepared statements passed to an execution helper by variable.
 *
 * `executeWithTimeoutSync(db, stmt, 30000)` was invisible to this scan until the generic-type fix
 * above, because the line carries no `prepare(` of its own. Both are prepared one line earlier from
 * a MODEL_SQL_VARIABLE, so the model-SQL validation checks below govern them; they are named here
 * so a new prepared-statement variable cannot appear unnoticed. The map records what each is
 * prepared from, and that pairing is asserted against the source rather than trusted.
 */
const PREPARED_STATEMENT_VARIABLES: Record<string, string> = {
  stmt: "sql",
  retryStmt: "retrySql",
};

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

      /*
       * A multi-statement call takes an ARRAY of SQL strings, so its statements are not the first
       * argument and can sit on their own lines. Every entry of that array must be accountable in
       * exactly the same way a single execution is: a guarded plan's `.sql`, or a named paired
       * evidence read of a guarded plan. Anything else is unaccounted.
       */
      if (MULTI_STATEMENT_HELPER.test(line)) {
        /*
         * Read to the END of the call rather than a fixed number of lines. A four-statement call
         * with an explanatory comment inside its array overran an 8-line window, and the scan then
         * reported "no statement array found" — a false negative in the accounting, which is worse
         * than a false positive. Line comments are stripped before splitting so comment text cannot
         * be mistaken for a statement.
         */
        const call = callText(lines, index);
        const body = stripLineComments(call.slice(call.indexOf("(")));
        const arrayMatch = body.match(/\[([^\]]*)\]/);
        if (!arrayMatch) {
          unaccounted.push(`${route}:${index + 1} multi-statement call with no statement array found`);
          return;
        }
        const entries = arrayMatch[1].split(",").map((entry) => entry.trim()).filter(Boolean);
        if (entries.length === 0) {
          unaccounted.push(`${route}:${index + 1} multi-statement call with an empty statement array`);
          return;
        }
        for (const entry of entries) {
          if (/^[`'"]/.test(entry)) continue;                       // a literal carries no model input
          const owner = entry.match(/^(\w+)\.(\w+)$/);
          if (!owner) {
            unaccounted.push(`${route}:${index + 1} executes unrecognised statement ${entry.slice(0, 60)}`);
            continue;
          }
          const accountedAsAnswer = owner[2] === "sql" &&
            (owner[1] in GUARDED_PLANS || VALIDATED_CONTRACTS.has(owner[1]));
          const accountedAsEvidence = owner[1] in GUARDED_PLANS && PLAN_EVIDENCE_READS.has(entry);
          if (!accountedAsAnswer && !accountedAsEvidence) {
            unaccounted.push(`${route}:${index + 1} executes ${entry} (unknown plan/contract)`);
          }
        }
        return;
      }

      let arg = (m[1] ?? "").trim();

      // `db.prepare(\n  unguardedSql\n)` puts the argument on the NEXT line. Treating an empty
      // same-line argument as a literal continuation accepted exactly the injection this test
      // exists to catch, so look ahead instead.
      if (arg === "") {
        const next = lines.slice(index + 1, index + 3).find((l) => l.trim().length > 0) ?? "";
        arg = next.trim().replace(/[,)].*$/, "").trim();
      }

      // A literal or a template carries no model input.
      if (arg === "" || /^[`'"]/.test(arg)) return;

      // `executeWithTimeoutSync(db, <preparedStatement>, 30000)`: the statement arrives by name.
      const byVariable = arg.match(/^db\s*,\s*(\w+)\s*,/);
      if (byVariable) {
        if (byVariable[1] in PREPARED_STATEMENT_VARIABLES) return;
        unaccounted.push(`${route}:${index + 1} executes prepared statement ${byVariable[1]} (unlisted)`);
        return;
      }

      const inner = arg.replace(/^db\s*,\s*db\.prepare\(\s*/, "").replace(/\).*$/, "").trim();
      if (inner === "" || /^[`'"]/.test(inner)) return;

      const dotted = inner.match(/^(\w+)\.sql$/);
      if (dotted) {
        if (dotted[1] in GUARDED_PLANS || VALIDATED_CONTRACTS.has(dotted[1])) return;
        unaccounted.push(`${route}:${index + 1} executes ${inner} (unknown plan/contract)`);
        return;
      }
      // A named evidence read belonging to an already-guarded plan. Nothing else may take this
      // route: the plan must be in GUARDED_PLANS and the exact field must be listed above.
      const evidence = inner.match(/^(\w+)\.(\w+)$/);
      if (evidence && evidence[1] in GUARDED_PLANS && PLAN_EVIDENCE_READS.has(inner)) return;
      const bare = inner.match(/^(\w+)$/);
      if (bare) {
        if (MODEL_SQL_VARIABLES.has(bare[1]) || APPLICATION_BUILT_LOOKUPS.has(bare[1])) return;
        unaccounted.push(`${route}:${index + 1} executes bare identifier ${inner}`);
        return;
      }
      unaccounted.push(`${route}:${index + 1} executes unrecognised expression ${inner.slice(0, 60)}`);
    });

    // One line: `check` prints only the first line of a failure, so a multi-line list was invisible.
    assert.deepStrictEqual(unaccounted, [],
      `unaccounted executions: ${unaccounted.join(" | ")}`);
  });
}

console.log("\n-- prepared-statement variables are prepared from validated model SQL --");

for (const [variable, source] of Object.entries(PREPARED_STATEMENT_VARIABLES)) {
  check(`${variable} is prepared from ${source}`, () => {
    const found = ROUTES.map((route) => {
      const { lines } = handlerLines(route);
      return lines.some((line) =>
        new RegExp(`\\b(?:const|let)\\s+${variable}\\s*=\\s*db\\.prepare\\(\\s*${source}\\s*\\)`).test(line));
    });
    assert.ok(found.some(Boolean),
      `${variable}: no \`db.prepare(${source})\` assignment found in any route`);
    assert.ok(MODEL_SQL_VARIABLES.has(source),
      `${variable}: ${source} is not a listed model-SQL variable, so validation is not established`);
  });
}

console.log("\n-- each deterministic plan is refused-checked before it executes --");

for (const [plan, refusal] of Object.entries(GUARDED_PLANS)) {
  check(`${plan} is guarded before execution`, () => {
    /*
     * Find the route that actually declares this plan rather than mapping names by hand. The
     * hand-written ternary said "deterministicQuery means nibrs-query, everything else means
     * query", so a second NIBRS plan was checked against the wrong file and reported as unguarded
     * while its real guard sat in the other route.
     */
    const route = ["nibrs-query", "query"].find((candidate) =>
      new RegExp(`(?:const|let|var)\\s+${plan}\\b`).test(routeSource(candidate))) ?? "query";
    const { lines } = handlerLines(route);
    const refusalLine = lines.findIndex((line) => line.includes(`${refusal} =`)) + 1;
    const guardLine = lines.findIndex((line) => new RegExp(`!\\s*${refusal}\\b`).test(line)) + 1;
    /*
     * The execution site is the line that INVOKES an execution helper with this plan's SQL. A
     * multi-statement call puts its statement array on a following line, so the helper line and
     * the `<plan>.sql` mention can differ — look within the call, not only on one line, or a
     * guarded plan appears unprotected merely for being formatted across lines.
     */
    const executeLine = lines.findIndex((line, i) => {
      if (!EXECUTION_HELPER.test(line)) return false;
      const call = callText(lines, i);
      const callBody = stripLineComments(call.slice(call.indexOf("(")));
      return new RegExp(`\\b${plan}\\.sql\\b`).test(
        MULTI_STATEMENT_HELPER.test(line) ? callBody : line);
    }) + 1;
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

/**
 * The accepted P4.1 final-statement authority (lib/nibrs-execution-binding.ts). `sql = finalCheck.authority.sql`
 * is recognised ONLY where the same handler also (1) builds `finalCheck` with `finalizeNibrsStatement(`,
 * (2) refuses on `!finalCheck.ok`, and (3) executes exactly `executeBoundNibrsStatement(finalCheck.authority)`.
 * The binding module registers and freezes that authority, and its own behavioural tests reject forged or
 * altered authorities; this source-reading test only admits the assignment inside that shape. It is not a
 * general `.sql` allowance: any other right-hand side, including an altered expression of the authority, stays
 * unrecognised.
 */
const FINAL_AUTHORITY_ASSIGNMENT = /^finalCheck\.authority\.sql$/;
function finalAuthorityShapeHolds(handler: string): boolean {
  return /\bconst finalCheck = finalizeNibrsStatement\(/.test(handler)
    && /\bif \(!finalCheck\.ok\)/.test(handler)
    && /\bexecuteBoundNibrsStatement\(finalCheck\.authority\)/.test(handler);
}
function unrecognisedAssignments(route: string, lines: string[], start: number): string[] {
  const handler = lines.slice(Math.max(0, start - 1)).join("\n");
  const authorityAdmitted = finalAuthorityShapeHolds(handler);
  const unrecognised: string[] = [];
  lines.forEach((line, i) => {
    if (i + 1 < start) return;
    const m = line.match(/\b(?:sql|claude\.sql)\s*=\s*([^;]+);/);
    if (!m) return;
    const rhs = m[1].trim();
    if (RECOGNISED_SQL_SOURCES.some((pattern) => pattern.test(rhs))) return;
    if (authorityAdmitted && FINAL_AUTHORITY_ASSIGNMENT.test(rhs)) return;
    unrecognised.push(`${route}:${i + 1} assigns ${rhs.slice(0, 60)}`);
  });
  return unrecognised;
}

for (const route of ROUTES) {
  check(`${route}: every assignment to the executed SQL has a recognised source`, () => {
    const { lines, start } = handlerLines(route);
    const unrecognised = unrecognisedAssignments(route, lines, start);
    assert.deepStrictEqual(unrecognised, [],
      `unrecognised SQL sources:\n        ${unrecognised.join("\n        ")}`);
  });
}

check("negative control: a raw or altered replacement is still unrecognised, and the authority needs its whole shape", () => {
  const shaped = [
    "      const finalCheck = finalizeNibrsStatement({ sql });",
    "      if (!finalCheck.ok) { throw new Error(\"refused\"); }",
    "      sql = finalCheck.authority.sql;",
    "      const result = await executeBoundNibrsStatement(finalCheck.authority);",
  ];
  assert.deepStrictEqual(unrecognisedAssignments("fixture", shaped, 1), [], "the accepted shape is admitted");
  const altered = [...shaped.slice(0, 2), "      sql = finalCheck.authority.sql + \" OR 1=1\";", shaped[3]];
  assert.strictEqual(unrecognisedAssignments("fixture", altered, 1).length, 1, "an altered authority expression is refused");
  const raw = [...shaped, "      sql = userSuppliedStatement;"];
  assert.strictEqual(unrecognisedAssignments("fixture", raw, 1).length, 1, "a raw replacement is refused");
  const unbound = [shaped[0], shaped[1], shaped[2], "      const result = db.prepare(sql).all();"];
  assert.strictEqual(unrecognisedAssignments("fixture", unbound, 1).length, 1, "without executeBoundNibrsStatement(finalCheck.authority) it is refused");
  const unrefused = [shaped[0], shaped[2], shaped[3]];
  assert.strictEqual(unrecognisedAssignments("fixture", unrefused, 1).length, 1, "without the !finalCheck.ok refusal it is refused");
});

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
