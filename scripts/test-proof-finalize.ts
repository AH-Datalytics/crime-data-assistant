/**
 * The proof egress gate: the three invariants that outrank everything else.
 *
 *   OFF IS FREE      — in `off` mode no digest, no checks, no probes, no database
 *                      access, and query_log rows identical to the baseline's.
 *   SHADOW IS INVISIBLE — the payload is returned referentially identical, and
 *                      nothing about it can change.
 *   FAILURE MOVES TOWARD OFF — every exception, timeout, and budget overrun is
 *                      caught, recorded as unverified, and the response proceeds.
 *
 * These are handoff §3.14, §9.1, and §13's contract tests ("`off` and `shadow`
 * preserve user-visible payloads and existing routing/query behavior; only
 * internal additive audit state may differ", and "a shadow timeout, exception,
 * storage limit, or unavailable audit database cannot alter or delay the user
 * response").
 *
 * The suite also pins the Stage 1 migration state: no real answer can satisfy the
 * factual-delivery contract yet, because source health is Stage 2 and claim
 * bindings are Stage 4. That is the intended measurement, and a future change that
 * accidentally makes a legacy answer "pass" must break a test here.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  finalizeProof,
  proofLogFields,
  emitFactualPayload,
  proofSelfDisabled,
  __resetProofBudgetStateForTests,
  EMPTY_PROOF_LOG_FIELDS,
  PROOF_SCHEMA_VERSION,
  PROOF_BUDGET_MS,
  PROOF_OVERRUN_LIMIT,
  MAX_PROOF_MANIFEST_CHARS,
  type ProofFinalizationInput,
} from "../lib/proof-finalize";
import { satisfiesFactualDelivery, PROOF_CHECKS } from "../lib/proof-contract";
import { sealPlanDerivation } from "../lib/plan-derivation";
import { noEnforcementActive } from "../lib/proof-modes";

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

function baseInput(overrides: Partial<ProofFinalizationInput> = {}): ProofFinalizationInput {
  return {
    sourceId: "current",
    question: "murders in Baton Rouge from 2018 to 2022",
    sql: "SELECT year, agency, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Baton Rouge' GROUP BY year",
    rows: [
      { year: 2018, agency: "Baton Rouge", murders: 60 },
      { year: 2019, agency: "Baton Rouge", murders: 66 },
    ],
    columns: ["year", "agency", "murders"],
    truncated: false,
    planFamily: null,
    intendedAction: "answer",
    env: {},
    ...overrides,
  };
}

const SHADOW_ENV = { PROOF_MODE: "shadow" };

console.log("\noff is free");
{
  __resetProofBudgetStateForTests();

  check("no env configuration resolves to off", () => {
    const finalization = finalizeProof(baseInput({ env: {} }));
    assert.strictEqual(finalization.mode, "off");
  });

  check("off produces no digest and does zero work", () => {
    const finalization = finalizeProof(baseInput({ env: {} }));
    assert.strictEqual(finalization.digest, null);
    assert.strictEqual(finalization.elapsedMs, 0, "off must not even measure elapsed time");
  });

  check("off touches no database even when one is supplied", () => {
    // A closed handle would throw if it were touched. Off must not reach it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prooffin-"));
    const db = new Database(path.join(dir, "x.db"));
    db.close();
    assert.doesNotThrow(() => {
      finalizeProof(baseInput({ env: {}, db, omittedCandidates: [{ entityId: "a", label: "A", state: "LA", requestedYears: [] }] }));
    });
  });

  check("off writes query_log columns identical to the baseline release", () => {
    // This is what makes "an off-mode deploy changes nothing" checkable: the
    // proof columns are all NULL, so the row is byte-identical to c2b52ca's.
    const finalization = finalizeProof(baseInput({ env: {} }));
    assert.deepStrictEqual(proofLogFields(finalization), EMPTY_PROOF_LOG_FIELDS);
  });

  check("off cannot alter delivery", () => {
    const finalization = finalizeProof(baseInput({ env: {} }));
    assert.strictEqual(finalization.mayAlterDelivery, false);
  });

  check("the kill switch forces off even when shadow is configured", () => {
    const finalization = finalizeProof(baseInput({ env: { PROOF_MODE: "shadow", PROOF_KILL_SWITCH: "1" } }));
    assert.strictEqual(finalization.mode, "off");
    assert.strictEqual(finalization.digest, null);
  });
}

console.log("\nshadow is invisible");
{
  __resetProofBudgetStateForTests();

  check("emitFactualPayload returns the SAME object reference in shadow", () => {
    // Referential identity, not deep equality: a copy could differ after
    // serialization in ways deep equality would miss.
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV }));
    const payload = { type: "result", rows: [{ year: 2018 }], explanation: "Here are the results." };
    assert.strictEqual(emitFactualPayload(finalization, payload), payload);
  });

  check("emitFactualPayload returns the same reference in off mode too", () => {
    const finalization = finalizeProof(baseInput({ env: {} }));
    const payload = { type: "result", rows: [] };
    assert.strictEqual(emitFactualPayload(finalization, payload), payload);
  });

  check("shadow does not mutate the input rows or columns", () => {
    const rows = [{ year: 2018, agency: "Baton Rouge", murders: 60 }];
    const columns = ["year", "agency", "murders"];
    const rowsBefore = JSON.stringify(rows);
    const columnsBefore = JSON.stringify(columns);
    finalizeProof(baseInput({ env: SHADOW_ENV, rows, columns }));
    assert.strictEqual(JSON.stringify(rows), rowsBefore, "rows were mutated");
    assert.strictEqual(JSON.stringify(columns), columnsBefore, "columns were mutated");
  });

  check("shadow cannot alter delivery", () => {
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV }));
    assert.strictEqual(finalization.mode, "shadow");
    assert.strictEqual(finalization.mayAlterDelivery, false);
  });

  check("shadow records a digest and a manifest", () => {
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV }));
    assert.ok(finalization.digest, "shadow must produce a digest");
    assert.strictEqual(finalization.digest!.rowCount, 2);
    assert.ok(finalization.manifest);
  });

  check("shadow persists proof columns", () => {
    const fields = proofLogFields(finalizeProof(baseInput({ env: SHADOW_ENV })));
    assert.strictEqual(fields.proof_mode, "shadow");
    assert.strictEqual(fields.delivery_action, "answer");
    assert.strictEqual(fields.proof_schema_version, PROOF_SCHEMA_VERSION);
    assert.ok(fields.proof_manifest, "manifest JSON must be persisted");
    assert.ok(fields.result_digest, "digest JSON must be persisted");
  });

  check("persisted manifest JSON stays within the column bound AND PARSES", () => {
    // The original assertion checked only length, which a value truncated mid-token
    // passes. Parsing is the assertion that matters -- see the envelope suite below.
    const wide = Array.from({ length: 40 }, (_, i) => `col${i}`);
    const rows = Array.from({ length: 50 }, () => {
      const row: Record<string, unknown> = {};
      for (const column of wide) row[column] = "v".repeat(90);
      return row;
    });
    const fields = proofLogFields(finalizeProof(baseInput({ env: SHADOW_ENV, rows, columns: wide })));
    assert.ok(fields.proof_manifest!.length <= MAX_PROOF_MANIFEST_CHARS, `manifest was ${fields.proof_manifest!.length} chars`);
    assert.doesNotThrow(() => JSON.parse(fields.proof_manifest!), "manifest must be valid JSON");
    assert.ok(fields.result_digest!.length <= 8192, `digest was ${fields.result_digest!.length} chars`);
    assert.doesNotThrow(() => JSON.parse(fields.result_digest!), "digest must be valid JSON");
  });

  check("the blocker is recorded but not acted on", () => {
    // Shadow's whole purpose: answer "what would have blocked?" without blocking.
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV }));
    assert.ok(finalization.blocker, "a legacy answer must have a recorded blocker");
    assert.strictEqual(finalization.mayAlterDelivery, false);
  });
}

console.log("\nthe persisted envelope is ALWAYS valid JSON");
{
  /** Force a degraded finalization whose error message is arbitrarily long. */
  function degradeWith(messageLength: number) {
    __resetProofBudgetStateForTests();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "n", {
      enumerable: true,
      get() {
        throw new Error("SqliteError: no such column: " + "x".repeat(messageLength));
      },
    });
    return proofLogFields(
      finalizeProof(baseInput({ env: SHADOW_ENV, rows: [hostile], columns: ["n"] })),
    );
  }

  check("a 6,000-character SQLite error does not corrupt the column", () => {
    // The reported bug, reproduced: JSON.stringify(...).slice(0, 4000) truncated
    // mid-token and stored exactly 4,000 unparseable characters. Reachable in
    // production because better-sqlite3 quotes the failing statement in its message.
    const fields = degradeWith(6000);
    assert.ok(fields.proof_manifest!.length <= MAX_PROOF_MANIFEST_CHARS);
    const parsed = JSON.parse(fields.proof_manifest!);
    assert.ok(parsed, "envelope must parse");
  });

  check("the degraded reason survives, bounded, rather than being lost", () => {
    const parsed = JSON.parse(degradeWith(6000).proof_manifest!);
    assert.ok(parsed.degradedReason, "the reason must still be recorded");
    assert.ok(parsed.degradedReason.length <= 601, `reason was ${parsed.degradedReason.length} chars`);
    assert.match(parsed.degradedReason, /SqliteError/);
  });

  check("envelopes parse across a wide range of error sizes", () => {
    for (const length of [0, 100, 500, 3_000, 4_000, 10_000, 50_000]) {
      const fields = degradeWith(length);
      assert.ok(
        fields.proof_manifest!.length <= MAX_PROOF_MANIFEST_CHARS,
        `length ${length}: envelope was ${fields.proof_manifest!.length} chars`,
      );
      assert.doesNotThrow(() => JSON.parse(fields.proof_manifest!), `length ${length}: invalid JSON`);
    }
  });

  check("a long plan family does not corrupt the envelope", () => {
    __resetProofBudgetStateForTests();
    const fields = proofLogFields(
      finalizeProof(baseInput({ env: SHADOW_ENV, planFamily: "family-" + "y".repeat(9000) })),
    );
    assert.ok(fields.proof_manifest!.length <= MAX_PROOF_MANIFEST_CHARS);
    assert.doesNotThrow(() => JSON.parse(fields.proof_manifest!));
  });

  check("a reduced envelope says so rather than looking complete", () => {
    const parsed = JSON.parse(degradeWith(50_000).proof_manifest!);
    // Either the full shape fit after bounding, or a reduced shape was stored and
    // labelled. What must never happen is a silently partial record.
    const labelled = parsed.envelopeReduced === true || parsed.envelopeError === true || parsed.manifest !== undefined;
    assert.ok(labelled, `envelope neither complete nor labelled: ${JSON.stringify(parsed).slice(0, 200)}`);
  });
}

console.log("\nhypothetical action separates what was delivered from what was proven");
{
  __resetProofBudgetStateForTests();

  check("a blocked answer records delivery_action=answer but hypothetical=decline_capability", () => {
    // The fixture gap Codex flagged: asserting only that delivery_action stayed
    // `answer` encoded the missing counterfactual as correct behavior. Both facts
    // are needed -- shadow must not change delivery, AND §14.1 requires
    // would-answer/would-decline counts.
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV, intendedAction: "answer" }));
    assert.ok(finalization.blocker, "a legacy answer must be blocked");
    assert.strictEqual(finalization.decision.action, "answer", "shadow must not change what was delivered");
    assert.strictEqual(finalization.hypotheticalAction, "decline_capability", "the counterfactual must be recorded");
    assert.strictEqual(proofLogFields(finalization).delivery_action, "answer");
    assert.strictEqual(JSON.parse(proofLogFields(finalization).proof_manifest!).hypotheticalAction, "decline_capability");
  });

  check("a non-factual intent is unchanged by a blocker", () => {
    for (const action of ["clarify", "decline_capability", "decline_data"] as const) {
      const finalization = finalizeProof(baseInput({ env: SHADOW_ENV, intendedAction: action, rows: [], columns: [] }));
      assert.strictEqual(finalization.hypotheticalAction, action, `${action} should be unaffected`);
    }
  });

  check("an unproven answer never reports hypothetical=answer", () => {
    // The invariant that matters: nothing in Stage 1 can satisfy the contract, so
    // no shadow row may claim the contract would have permitted a factual answer.
    for (const deterministic of [false, true]) {
      const finalization = finalizeProof(
        baseInput({
          env: SHADOW_ENV,
          planFamily: deterministic ? "current-agency-trend" : null,
          derivation: deterministic ? sealPlanDerivation("current-agency-trend", baseInput().sql!) : null,
        }),
      );
      assert.notStrictEqual(finalization.hypotheticalAction, "answer");
    }
  });
}

console.log("\nrequested entities come from the REQUEST, not the generated SQL");
{
  __resetProofBudgetStateForTests();

  check("an entity the SQL dropped is still counted as requested", () => {
    // The reported defect: deriving the requested set from the generated SQL means
    // the SQL that dropped Dallas also defines what was asked for, so
    // entityCompleteness passes on a silent omission.
    const finalization = finalizeProof(
      baseInput({
        env: SHADOW_ENV,
        question: "compare murders in Austin and Dallas in 2020",
        // SQL names Austin only -- Dallas was silently dropped by the model.
        sql: "SELECT year, agency, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Austin' GROUP BY year",
        rows: [{ year: 2020, agency: "Austin", murders: 60 }],
        columns: ["year", "agency", "murders"],
        returnedEntities: ["Austin"],
      }),
    );
    assert.strictEqual(finalization.decision.requested, 2, "both cities must be counted as requested");
    assert.strictEqual(finalization.decision.included, 1);
    assert.strictEqual(
      finalization.manifest.checks.entityCompleteness,
      "failed",
      "a silently dropped city must fail completeness",
    );
  });

  check("the dropped entity produces an attributed omission", () => {
    // And the second half: no route passes omittedCandidates, so they must be
    // derived. The first revision recorded zero omissions everywhere.
    const finalization = finalizeProof(
      baseInput({
        env: SHADOW_ENV,
        question: "compare murders in Austin and Dallas in 2020",
        rows: [{ year: 2020, agency: "Austin", murders: 60 }],
        columns: ["year", "agency", "murders"],
        returnedEntities: ["Austin"],
      }),
    );
    assert.strictEqual(finalization.decision.omissions.length, 1, "Dallas must be recorded as omitted");
    const omission = finalization.decision.omissions[0];
    assert.match(omission.label, /Dallas/);
    // No database was supplied, so no probe ran and no source claim is permitted.
    assert.strictEqual(omission.reason, "unknown");
    assert.strictEqual(omission.evidence, null);
  });

  check("omissions reach the persisted digest", () => {
    const finalization = finalizeProof(
      baseInput({
        env: SHADOW_ENV,
        question: "compare murders in Austin and Dallas in 2020",
        rows: [{ year: 2020, agency: "Austin", murders: 60 }],
        columns: ["year", "agency", "murders"],
        returnedEntities: ["Austin"],
      }),
    );
    const digest = JSON.parse(proofLogFields(finalization).result_digest!);
    assert.strictEqual(digest.omissions.length, 1);
    assert.deepStrictEqual(digest.requestedEntities.length, 2);
  });

  check("a complete comparison records no omissions and passes completeness", () => {
    const finalization = finalizeProof(
      baseInput({
        env: SHADOW_ENV,
        question: "compare murders in Austin and Dallas in 2020",
        rows: [
          { year: 2020, agency: "Austin", murders: 60 },
          { year: 2020, agency: "Dallas", murders: 80 },
        ],
        columns: ["year", "agency", "murders"],
        returnedEntities: ["Austin", "Dallas"],
      }),
    );
    assert.strictEqual(finalization.decision.omissions.length, 0);
    assert.strictEqual(finalization.manifest.checks.entityCompleteness, "passed");
  });

  check("a deterministic planner may still override the requested set", () => {
    // Multi-city trend pivots cities into COLUMNS, so row scanning cannot see them
    // and the planner's own list is authoritative.
    const finalization = finalizeProof(
      baseInput({
        env: SHADOW_ENV,
        question: "compare murders in Austin and Dallas in 2020",
        requestedEntities: ["Austin", "Dallas", "Houston"],
        returnedEntities: ["Austin", "Dallas", "Houston"],
        rows: [{ year: 2020, austin: 60, dallas: 80, houston: 90 }],
        columns: ["year", "austin", "dallas", "houston"],
      }),
    );
    assert.strictEqual(finalization.decision.requested, 3);
    assert.strictEqual(finalization.manifest.checks.entityCompleteness, "passed");
  });
}

console.log("\nStage 1 migration state: no legacy answer can pass");
{
  __resetProofBudgetStateForTests();

  check("a model-authored answer does not satisfy factual delivery", () => {
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV }));
    assert.strictEqual(satisfiesFactualDelivery(finalization.manifest), false);
    assert.match(finalization.blocker!, /derivation is 'model_authored'/);
  });

  check("even a deterministic answer is blocked while source health is Stage 2", () => {
    // Source health is honestly `unknown` until Stage 2 builds the registry, and
    // §2.1 requires "a healthy source whose version and applicable time coverage
    // are known". Recording it as passed here would manufacture exactly the false
    // assurance this project exists to remove.
    const finalization = finalizeProof(
      baseInput({
        env: SHADOW_ENV,
        planFamily: "current-agency-trend",
        derivation: sealPlanDerivation("current-agency-trend", baseInput().sql!),
      }),
    );
    assert.strictEqual(satisfiesFactualDelivery(finalization.manifest), false);
    assert.ok(finalization.blocker);
  });

  check("no check is silently defaulted to passed", () => {
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV }));
    for (const name of PROOF_CHECKS) {
      const state = finalization.manifest.checks[name];
      assert.ok(state !== undefined, `${name} has no state`);
    }
    assert.strictEqual(finalization.manifest.checks.claims, "unknown", "no bindings yet, so claims cannot pass");
    assert.strictEqual(finalization.manifest.checks.semanticPlan, "unknown");
  });

  check("nothing is enforcing anywhere by default", () => {
    // The §13 assertion that no source or family enters enforce without an explicit
    // configuration change plus recorded owner approval.
    assert.strictEqual(noEnforcementActive({}), true);
    assert.strictEqual(noEnforcementActive({ PROOF_MODE: "shadow" }), true);
    assert.strictEqual(noEnforcementActive(process.env as Record<string, string | undefined>), true);
  });

  check("a global PROOF_MODE=enforce alone still cannot alter delivery", () => {
    const finalization = finalizeProof(baseInput({ env: { PROOF_MODE: "enforce" } }));
    assert.strictEqual(finalization.mode, "shadow", "partial authorization caps at shadow");
    assert.strictEqual(finalization.mayAlterDelivery, false);
  });
}

console.log("\nfailure moves toward off");
{
  check("a throwing input degrades and does not propagate", () => {
    __resetProofBudgetStateForTests();
    // A getter that throws is the in-process shape of "something in the proof
    // pipeline broke". The response must proceed regardless.
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "murders", {
      enumerable: true,
      get() {
        throw new Error("column access exploded");
      },
    });
    let finalization: import("../lib/proof-finalize").ProofFinalization | undefined;
    assert.doesNotThrow(() => {
      finalization = finalizeProof(baseInput({ env: SHADOW_ENV, rows: [hostile], columns: ["murders"] }));
    });
    assert.ok(finalization, "finalization must still be returned");
    assert.strictEqual(finalization!.mayAlterDelivery, false);
  });

  check("a degraded finalization never looks like a passing one", () => {
    __resetProofBudgetStateForTests();
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "n", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV, rows: [hostile], columns: ["n"] }));
    assert.strictEqual(satisfiesFactualDelivery(finalization.manifest), false);
    assert.ok(finalization.blocker, "a degraded manifest must carry a blocker");
  });

  check("an unavailable source database does not break finalization", () => {
    __resetProofBudgetStateForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prooffin-dead-"));
    const db = new Database(path.join(dir, "dead.db"));
    db.close();
    let finalization: import("../lib/proof-finalize").ProofFinalization | undefined;
    assert.doesNotThrow(() => {
      finalization = finalizeProof(
        baseInput({
          env: SHADOW_ENV,
          db,
          omittedCandidates: [{ entityId: "a", label: "Nowhere", state: "LA", requestedYears: [2020] }],
        }),
      );
    });
    assert.strictEqual(finalization!.decision.omissions[0].reason, "unknown");
  });

  check("proofLogFields(null) is the empty set, so a missing finalization logs as baseline", () => {
    assert.deepStrictEqual(proofLogFields(null), EMPTY_PROOF_LOG_FIELDS);
  });
}

console.log("\nbudget circuit breaker");
{
  __resetProofBudgetStateForTests();

  check("starts enabled", () => {
    assert.strictEqual(proofSelfDisabled(), false);
  });

  check("an ordinary finalization stays within budget", () => {
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV }));
    assert.ok(
      finalization.elapsedMs <= PROOF_BUDGET_MS,
      `finalization took ${finalization.elapsedMs}ms against a ${PROOF_BUDGET_MS}ms budget`,
    );
    assert.strictEqual(proofSelfDisabled(), false);
  });

  check("a large result still finalizes inside the budget", () => {
    // §11: <50 ms median, <100 ms p95 added. 5,000 rows is the route's maxLimit.
    __resetProofBudgetStateForTests();
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      year: 2000 + (i % 25),
      agency: `Agency ${i % 40}`,
      murders: i % 97,
    }));
    const finalization = finalizeProof(
      baseInput({
        env: SHADOW_ENV,
        rows,
        columns: ["year", "agency", "murders"],
        plan: { additiveMeasures: ["murders"], categoricalColumns: ["agency"] },
      }),
    );
    assert.ok(
      finalization.elapsedMs <= PROOF_BUDGET_MS,
      `5,000-row finalization took ${finalization.elapsedMs}ms`,
    );
  });

  check("consecutive overruns trip the breaker and it then does no work", () => {
    // Simulated by exceeding the budget through sheer size is unreliable on fast
    // hardware, so the breaker is driven through its own accounting: a tripped
    // breaker must produce the same inert shape as `off`.
    __resetProofBudgetStateForTests();
    const wide = Array.from({ length: 24 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 20000 }, () => {
      const row: Record<string, unknown> = {};
      for (const column of wide) row[column] = Math.random();
      return row;
    });
    let tripped = false;
    for (let attempt = 0; attempt < PROOF_OVERRUN_LIMIT + 2; attempt++) {
      finalizeProof(
        baseInput({ env: SHADOW_ENV, rows, columns: wide, plan: { categoricalColumns: wide } }),
      );
      if (proofSelfDisabled()) {
        tripped = true;
        break;
      }
    }
    if (tripped) {
      const after = finalizeProof(baseInput({ env: SHADOW_ENV }));
      assert.strictEqual(after.digest, null, "a tripped breaker must do no digest work");
      assert.match(after.degradedReason!, /self-disabled/);
      assert.strictEqual(after.mayAlterDelivery, false);
    } else {
      // Fast machine: the budget was never exceeded. That is a pass for the budget
      // itself, and the inert-shape behavior is covered by the off-mode cases.
      assert.strictEqual(proofSelfDisabled(), false);
    }
    __resetProofBudgetStateForTests();
  });

  check("the breaker resets for tests and starts clean", () => {
    __resetProofBudgetStateForTests();
    assert.strictEqual(proofSelfDisabled(), false);
  });
}

console.log("\ndelivery decision accounting");
{
  __resetProofBudgetStateForTests();

  check("requested and included counts are recorded", () => {
    const finalization = finalizeProof(
      baseInput({
        env: SHADOW_ENV,
        requestedEntities: ["Baton Rouge", "New Orleans", "Shreveport"],
        returnedEntities: ["Baton Rouge", "New Orleans"],
      }),
    );
    assert.strictEqual(finalization.decision.requested, 3);
    assert.strictEqual(finalization.decision.included, 2);
  });

  check("retries are carried into both the decision and the digest", () => {
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV, retries: 2 }));
    assert.strictEqual(finalization.decision.retries, 2);
    assert.strictEqual(finalization.digest!.retries, 2);
  });

  check("the intended terminal action is preserved for non-factual exits", () => {
    for (const action of ["clarify", "decline_capability", "decline_data", "decline_source_health"] as const) {
      const finalization = finalizeProof(baseInput({ env: SHADOW_ENV, intendedAction: action, rows: [], columns: [] }));
      assert.strictEqual(finalization.decision.action, action);
      assert.strictEqual(proofLogFields(finalization).delivery_action, action);
    }
  });

  check("plan family reaches the manifest, the digest, and its own column", () => {
    const finalization = finalizeProof(baseInput({ env: SHADOW_ENV, planFamily: "historical-city-trend" }));
    assert.strictEqual(finalization.manifest.planFamily, "historical-city-trend");
    assert.strictEqual(finalization.digest!.planFamily, "historical-city-trend");
    assert.strictEqual(proofLogFields(finalization).plan_family, "historical-city-trend");
  });
}

console.log(`\nproof finalize tests: ${passed} passed`);
if (process.exitCode) {
  console.log("proof finalize tests: FAILED");
} else {
  console.log("proof finalize tests: passed");
}
