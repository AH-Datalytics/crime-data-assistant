/**
 * v1 postconditions (handoff §9.1 Stage 1) and the §13 correctness tests.
 *
 * THE PROPERTY THIS SUITE EXISTS TO DEFEND. A check must never return `passed`
 * because it found no evidence of a problem. Detector D6 reported "0 flagged" for
 * weeks while its reference database was a 0-byte stub, and a validator that
 * cannot tell "verified" from "could not look" reproduces that failure inside the
 * proof system itself. So for every check there is a case asserting `unknown`
 * where a naive implementation would have said `passed`.
 *
 * §13 cases covered explicitly: the historical 31-of-32 multi-city completeness
 * failure, canonical alias/consolidation handling, missingness versus validated
 * zero, metric/grain confusion, derived-calculation reconciliation, and source
 * freshness evaluated against the requested period.
 */
import assert from "node:assert";
import {
  checkEntityCompleteness,
  checkCanonicalGeographies,
  checkMetric,
  checkGrain,
  checkTimeRange,
  checkMissingness,
  checkReconciliation,
  checkClaims,
  checkSemanticPlan,
  checkChartData,
  runProofChecks,
  type CheckInput,
  type NumericClaim,
} from "../lib/proof-checks";
import { buildQueryContract } from "../lib/query-contract";
import { PROOF_CHECKS } from "../lib/proof-contract";

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

function input(overrides: Partial<CheckInput> = {}): CheckInput {
  const question = overrides.question ?? "murders in Baton Rouge from 2018 to 2022";
  return {
    question,
    sql: "SELECT year, agency, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Baton Rouge' GROUP BY year",
    rows: [{ year: 2018, agency: "Baton Rouge", murders: 60 }],
    columns: ["year", "agency", "murders"],
    contract: buildQueryContract(question, "current", null),
    requestedEntities: [],
    returnedEntities: [],
    omissionsDisclosed: false,
    ...overrides,
  };
}

console.log("\nentityCompleteness — the 31-of-32 failure");
{
  const thirtyTwo = Array.from({ length: 32 }, (_, i) => `City${i}`);

  check("all requested entities present passes", () => {
    const outcome = checkEntityCompleteness(
      input({
        requestedEntities: thirtyTwo,
        returnedEntities: thirtyTwo,
        rows: thirtyTwo.map((city) => ({ city, n: 1 })),
      }),
    );
    assert.strictEqual(outcome.state, "passed");
  });

  check("31 of 32 with no disclosure FAILS", () => {
    // The production defect this project was chartered on: a comparison across 32
    // cities returned 31 and the narrative described it as complete.
    const outcome = checkEntityCompleteness(
      input({
        requestedEntities: thirtyTwo,
        returnedEntities: thirtyTwo.slice(0, 31),
        rows: thirtyTwo.slice(0, 31).map((city) => ({ city, n: 1 })),
        omissionsDisclosed: false,
      }),
    );
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /City31/);
    assert.match(outcome.reason, /not disclosed/);
  });

  check("31 of 32 WITH disclosure passes as limited scope", () => {
    // §2.3 permits answer_limited_scope: every delivered claim passes and the
    // narrower scope is stated. The check's job is to distinguish this from a
    // silent drop, not to forbid the shortfall.
    const outcome = checkEntityCompleteness(
      input({
        requestedEntities: thirtyTwo,
        returnedEntities: thirtyTwo.slice(0, 31),
        rows: thirtyTwo.slice(0, 31).map((city) => ({ city, n: 1 })),
        omissionsDisclosed: true,
      }),
    );
    assert.strictEqual(outcome.state, "passed");
    assert.match(outcome.reason, /disclosed/);
  });

  check("no requested entities is not_applicable, not passed", () => {
    const outcome = checkEntityCompleteness(input({ requestedEntities: [] }));
    assert.strictEqual(outcome.state, "not_applicable");
  });

  check("rows with no recognizable entity column is unknown, not passed", () => {
    const outcome = checkEntityCompleteness(
      input({ requestedEntities: ["Baton Rouge"], returnedEntities: [], rows: [{ n: 5 }] }),
    );
    assert.strictEqual(outcome.state, "unknown");
  });

  check("an empty result is unknown, not passed", () => {
    const outcome = checkEntityCompleteness(input({ requestedEntities: ["Baton Rouge"], rows: [] }));
    assert.strictEqual(outcome.state, "unknown");
  });

  check("alias forms match rather than reading as omissions", () => {
    // §13 canonical alias cases: St. Louis / Saint Louis must not be counted as a
    // missing entity purely because of punctuation.
    const outcome = checkEntityCompleteness(
      input({
        requestedEntities: ["St. Louis"],
        returnedEntities: ["Saint  Louis"],
        rows: [{ city: "Saint Louis", n: 1 }],
      }),
    );
    assert.strictEqual(outcome.state, "passed");
  });
}

console.log("\ncanonicalGeographies");
{
  check("a resolved high-confidence city passes", () => {
    const outcome = checkCanonicalGeographies(input({ question: "murders in Chicago 2022" }));
    assert.strictEqual(outcome.state, "passed");
  });

  check("multiple resolved cities pass", () => {
    const outcome = checkCanonicalGeographies(
      input({ question: "compare violent crime in Austin and Dallas 2020" }),
    );
    assert.strictEqual(outcome.state, "passed");
    assert.match(outcome.reason, /2 geographies/);
  });

  check("no typed plan is unknown, not passed", () => {
    const outcome = checkCanonicalGeographies(input({ contract: null }));
    assert.strictEqual(outcome.state, "unknown");
  });

  check("an unresolvable geography is not_applicable rather than a false pass", () => {
    const outcome = checkCanonicalGeographies(input({ question: "what is the weather" }));
    assert.strictEqual(outcome.state, "not_applicable");
  });

  check("a geography needing clarification fails", () => {
    const contract = buildQueryContract("murders in Springfield 2020", "current", null)!;
    contract.geographies = [
      { kind: "city", name: "Springfield", state: null, canonicalName: null, confidence: "low", needsClarification: ["ambiguous_state"] },
    ];
    const outcome = checkCanonicalGeographies(input({ contract }));
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /ambiguous_state/);
  });

  check("a resolved-but-low-confidence geography is unknown, not passed", () => {
    const contract = buildQueryContract("murders in Chicago 2022", "current", null)!;
    contract.geographies = [
      { kind: "city", name: "Chicago", state: "IL", canonicalName: "Chicago, IL", confidence: "low", needsClarification: [] },
    ];
    const outcome = checkCanonicalGeographies(input({ contract }));
    assert.strictEqual(outcome.state, "unknown");
  });
}

console.log("\nmetric");
{
  check("a bound count metric passes", () => {
    const outcome = checkMetric(input({ question: "murders in Baton Rouge from 2018 to 2022" }));
    assert.strictEqual(outcome.state, "passed");
    assert.match(outcome.reason, /murder/);
  });

  check("an unrecognized metric is unknown, not passed", () => {
    const outcome = checkMetric(input({ question: "what is the weather" }));
    assert.strictEqual(outcome.state, "unknown");
  });

  check("no typed plan is unknown", () => {
    assert.strictEqual(checkMetric(input({ contract: null })).state, "unknown");
  });

  check("a rate request with no denominator in the SQL fails", () => {
    // The rate-no-population failure. Re-checked here because a response-cache hit
    // re-runs SQL that never passed through this request's guardrails.
    const outcome = checkMetric(
      input({
        question: "murder rate per 100k in Chicago 2022",
        sql: "SELECT year, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Chicago' GROUP BY year",
      }),
    );
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /denominator/);
  });

  check("a rate request with a population join passes", () => {
    const outcome = checkMetric(
      input({
        question: "murder rate per 100k in Chicago 2022",
        sql: "SELECT a.year, SUM(a.count) * 100000.0 / p.population AS rate FROM agency_monthly a JOIN agency_population p ON p.ori = a.ori GROUP BY a.year",
      }),
    );
    assert.strictEqual(outcome.state, "passed");
  });

  check("an unsupported metric fails with the plan's reason", () => {
    const contract = buildQueryContract("murders in Chicago 2022", "current", null)!;
    contract.metric.unsupportedReason = "district_level_unavailable";
    const outcome = checkMetric(input({ contract }));
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /district_level_unavailable/);
  });
}

console.log("\ngrain — metric/grain confusion");
{
  check("a monthly request returning monthly rows passes", () => {
    const outcome = checkGrain(
      input({
        question: "monthly murders in New Orleans 2023",
        rows: [{ year: 2023, month: 1, murders: 5 }, { year: 2023, month: 2, murders: 7 }],
        columns: ["year", "month", "murders"],
      }),
    );
    assert.strictEqual(outcome.state, "passed");
  });

  check("a monthly request returning annual rows fails", () => {
    const outcome = checkGrain(
      input({
        question: "monthly murders in New Orleans 2023",
        rows: [{ year: 2023, murders: 60 }],
        columns: ["year", "murders"],
        sql: "SELECT year, SUM(count) AS murders FROM agency_monthly GROUP BY year",
      }),
    );
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /annual/);
  });

  check("a request with no stated grain is not_applicable", () => {
    const outcome = checkGrain(input({ question: "murders in Baton Rouge 2020" }));
    assert.strictEqual(outcome.state, "not_applicable");
  });

  check("an empty result is unknown, not passed", () => {
    const outcome = checkGrain(input({ question: "monthly murders in New Orleans 2023", rows: [] }));
    assert.strictEqual(outcome.state, "unknown");
  });
}

console.log("\ntimeRange — freshness against the REQUESTED period");
{
  check("returned period covering the request passes", () => {
    const outcome = checkTimeRange(
      input({
        question: "murders in Baton Rouge from 2018 to 2022",
        rows: [2018, 2019, 2020, 2021, 2022].map((year) => ({ year, murders: 1 })),
      }),
    );
    assert.strictEqual(outcome.state, "passed");
  });

  check("a missing requested end year fails", () => {
    // §8: "A stale source cannot answer a request that depends on newer data."
    // Evaluated against the requested period, not the wall clock.
    const outcome = checkTimeRange(
      input({
        question: "murders in Baton Rouge from 2018 to 2022",
        rows: [2018, 2019, 2020].map((year) => ({ year, murders: 1 })),
      }),
    );
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /through 2022, returned through 2020/);
  });

  check("a missing requested start year fails", () => {
    const outcome = checkTimeRange(
      input({
        question: "murders in Baton Rouge from 2018 to 2022",
        rows: [2020, 2021, 2022].map((year) => ({ year, murders: 1 })),
      }),
    );
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /from 2018, returned from 2020/);
  });

  check("no year in the request is not_applicable", () => {
    const outcome = checkTimeRange(input({ question: "murders in Baton Rouge" }));
    assert.strictEqual(outcome.state, "not_applicable");
  });

  check("rows with no year column is unknown, not passed", () => {
    const outcome = checkTimeRange(
      input({ question: "murders in Baton Rouge from 2018 to 2022", rows: [{ murders: 5 }], columns: ["murders"] }),
    );
    assert.strictEqual(outcome.state, "unknown");
  });
}

console.log("\nmissingness versus validated zero");
{
  check("fully-populated measures pass", () => {
    const outcome = checkMissingness(
      input({ rows: [{ year: 2020, murders: 0 }, { year: 2021, murders: 4 }], columns: ["year", "murders"] }),
    );
    assert.strictEqual(outcome.state, "passed");
  });

  check("an entirely-null measure column fails", () => {
    // §2.4: never represent missing data as zero. An all-null column narrated as a
    // real zero is the exact failure.
    const outcome = checkMissingness(
      input({ rows: [{ year: 2020, murders: null }, { year: 2021, murders: null }], columns: ["year", "murders"] }),
    );
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /murders/);
  });

  check("mixed nulls and values is unknown without a declared semantic", () => {
    const outcome = checkMissingness(
      input({ rows: [{ year: 2020, murders: 3 }, { year: 2021, murders: null }], columns: ["year", "murders"] }),
    );
    assert.strictEqual(outcome.state, "unknown");
  });

  check("a validated zero is not treated as missing", () => {
    const outcome = checkMissingness(input({ rows: [{ year: 2020, murders: 0 }], columns: ["year", "murders"] }));
    assert.strictEqual(outcome.state, "passed");
  });

  check("an empty result is not_applicable", () => {
    assert.strictEqual(checkMissingness(input({ rows: [] })).state, "not_applicable");
  });

  check("no numeric measure column is unknown, not passed", () => {
    const outcome = checkMissingness(input({ rows: [{ agency: "X" }], columns: ["agency"] }));
    assert.strictEqual(outcome.state, "unknown");
  });
}

console.log("\nreconciliation — derived calculations");
{
  check("in-range values pass", () => {
    const outcome = checkReconciliation(
      input({ rows: [{ year: 2020, murder_count: 5, clearance_pct: 62.5 }], columns: ["year", "murder_count", "clearance_pct"] }),
    );
    assert.strictEqual(outcome.state, "passed");
  });

  check("a negative count fails", () => {
    const outcome = checkReconciliation(
      input({ rows: [{ murder_count: -3 }], columns: ["murder_count"] }),
    );
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /negative count/);
  });

  check("a percentage above 100 fails", () => {
    const outcome = checkReconciliation(
      input({ rows: [{ clearance_pct: 142 }], columns: ["clearance_pct"] }),
    );
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /outside 0-100/);
  });

  check("an empty result is not_applicable", () => {
    assert.strictEqual(checkReconciliation(input({ rows: [] })).state, "not_applicable");
  });
}

console.log("\nclaims — bindings, never prose parsing");
{
  check("no bindings is unknown, not passed", () => {
    // The migration measurement: a model-authored answer produces no bindings, so
    // it cannot satisfy the contract. §3.1/§6.4 make that the intended outcome.
    assert.strictEqual(checkClaims(null).state, "unknown");
  });

  check("reconciling claims pass", () => {
    const claims: NumericClaim[] = [
      { label: "endValue", claimed: 5171, derived: 5171 },
      { label: "percentChange", claimed: -20.47, derived: -20.4706 },
    ];
    assert.strictEqual(checkClaims(claims).state, "passed");
  });

  check("a mismatched claim fails and names itself", () => {
    const claims: NumericClaim[] = [{ label: "endValue", claimed: 5171, derived: 6502 }];
    const outcome = checkClaims(claims);
    assert.strictEqual(outcome.state, "failed");
    assert.match(outcome.reason, /endValue asserted 5171, derived 6502/);
  });

  check("an empty binding list is not_applicable", () => {
    assert.strictEqual(checkClaims([]).state, "not_applicable");
  });
}

console.log("\nsemanticPlan and chartData");
{
  check("model-authored SQL is unknown even with a parsed plan", () => {
    const outcome = checkSemanticPlan(input(), false);
    assert.strictEqual(outcome.state, "unknown");
    assert.match(outcome.reason, /model-authored/);
  });

  check("a deterministic plan with no warnings passes", () => {
    const outcome = checkSemanticPlan(input(), true);
    assert.strictEqual(outcome.state, "passed");
  });

  check("a deterministic plan with unresolved warnings is unknown", () => {
    const contract = buildQueryContract("murders in Chicago 2022", "current", null)!;
    contract.warnings = ["partial_year_disclosure_required"];
    const outcome = checkSemanticPlan(input({ contract }), true);
    assert.strictEqual(outcome.state, "unknown");
  });

  check("no chart is not_applicable", () => {
    assert.strictEqual(checkChartData(false, false).state, "not_applicable");
  });

  check("a chart not provably from bindings is unknown, not passed", () => {
    assert.strictEqual(checkChartData(true, false).state, "unknown");
  });

  check("a chart from shared bindings passes", () => {
    assert.strictEqual(checkChartData(true, true).state, "passed");
  });
}

console.log("\nrunProofChecks assigns every frozen category");
{
  const result = runProofChecks({
    ...input(),
    deterministic: false,
    hasChart: false,
    chartFromBindings: false,
    claims: null,
  });

  check("all ten frozen check categories receive a state", () => {
    for (const name of PROOF_CHECKS) {
      assert.ok(result.states[name] !== undefined, `${name} has no state`);
      assert.ok(result.reasons[name], `${name} has no reason`);
    }
    assert.strictEqual(Object.keys(result.states).length, PROOF_CHECKS.length);
  });

  check("every not_applicable carries a justification", () => {
    // lib/proof-contract's factualDeliveryBlocker rejects an unjustified
    // not_applicable, so an unjustified one here would be an unfalsifiable pass.
    for (const [name, state] of Object.entries(result.states)) {
      if (state === "not_applicable") {
        assert.ok(result.notApplicableReasons[name as keyof typeof result.notApplicableReasons], `${name} lacks a reason`);
      }
    }
  });

  check("a legacy model-authored answer does not pass the plan check", () => {
    assert.strictEqual(result.states.semanticPlan, "unknown");
    assert.strictEqual(result.states.claims, "unknown");
  });
}

console.log(`\nproof checks tests: ${passed} passed`);
if (process.exitCode) {
  console.log("proof checks tests: FAILED");
} else {
  console.log("proof checks tests: passed");
}
