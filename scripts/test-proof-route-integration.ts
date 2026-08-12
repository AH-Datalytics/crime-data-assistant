/**
 * Behavioral regressions for the SHR/NIBRS integration review findings.
 *
 * All four were the same category of mistake as earlier rounds: the proof layer was
 * handed something that looked like evidence and was not. A raw question standing in
 * for the reconstructed one, an empty result labelled `answer`, and a derivation
 * sealed from the SQL it was supposed to be checked against — that last one is a
 * tautology, and a tautology in a verification layer is worse than an absent check,
 * because it reports success.
 *
 * The double-wrap was harmless at runtime (emitFactualPayload is idempotent) but is
 * asserted here anyway: two gate calls on one payload read as two decisions, and
 * anyone auditing that exit would have to work out which one mattered.
 */
import assert from "node:assert";
import fs from "node:fs";
import { finalizeProof } from "../lib/proof-finalize";
import { sealPlanDerivation, fingerprintSql } from "../lib/plan-derivation";

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

const SHADOW = { PROOF_MODE: "shadow" };
const NIBRS_ROUTE = "app/api/nibrs-query/route.ts";
const SHR_ROUTE = "app/api/shr-query/route.ts";

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

console.log("\n1. NIBRS early exits reason about the reconstructed question");
{
  const source = read(NIBRS_ROUTE);

  check("proofQuestion adopts capabilityQuestion before the early exits", () => {
    const adopt = source.indexOf("proofQuestion = capabilityQuestion;");
    const capabilityExit = source.indexOf("const capabilityOverride = detectNibrsCapabilityOverride(");
    assert.ok(adopt > 0, "NIBRS must adopt the capability question");
    assert.ok(adopt < capabilityExit, "adoption must precede the first exit that uses it");
  });

  check("every early exit is downstream of the adoption", () => {
    // The five exits that previously ran on the raw question.
    const adopt = source.indexOf("proofQuestion = capabilityQuestion;");
    for (const marker of [
      "const capabilityProof = finalizeExit(",
      "const completenessProof = finalizeExit(",
      "const switchProof = finalizeExit(",
      "const geoProof = finalizeExit(",
      "const countyProof = finalizeExit(",
    ]) {
      const at = source.indexOf(marker);
      assert.ok(at > 0, `${marker} must exist`);
      assert.ok(at > adopt, `${marker} runs before proofQuestion is reconstructed`);
    }
  });

  check("the later guardrail reconstruction still wins", () => {
    // capabilityQuestion is the best available early; guardrailQuestion is more
    // complete and must override it once it exists.
    const capabilityAdopt = source.indexOf("proofQuestion = capabilityQuestion;");
    const guardrailAdopt = source.indexOf("proofQuestion = guardrailQuestion;");
    assert.ok(guardrailAdopt > capabilityAdopt, "guardrailQuestion must be adopted after capabilityQuestion");
  });

  check("BEHAVIORAL: a fragment follow-up recovers its entities once reconstructed", () => {
    const fragment = finalizeProof({
      sourceId: "nibrs",
      question: "just clearances by type",
      sql: "SELECT city, cleared FROM t",
      rows: [{ city: "Austin", cleared: 1 }],
      columns: ["city", "cleared"],
      truncated: false,
      planFamily: null,
      returnedEntities: ["Austin"],
      intendedAction: "answer",
      env: SHADOW,
    });
    const reconstructed = finalizeProof({
      sourceId: "nibrs",
      question: "compare clearances by type in Austin and Dallas in 2020",
      sql: "SELECT city, cleared FROM t",
      rows: [{ city: "Austin", cleared: 1 }],
      columns: ["city", "cleared"],
      truncated: false,
      planFamily: null,
      returnedEntities: ["Austin"],
      intendedAction: "answer",
      env: SHADOW,
    });
    assert.strictEqual(fragment.decision.requested, null, "the raw fragment names nobody");
    assert.strictEqual(reconstructed.decision.requested, 2, "the reconstruction names both cities");
    assert.strictEqual(
      reconstructed.manifest.checks.entityCompleteness,
      "failed",
      "and the dropped city is caught",
    );
  });
}

console.log("\n2. an empty NIBRS model result is not an answer");
{
  const source = read(NIBRS_ROUTE);

  check("the main model path classifies on row count", () => {
    assert.match(
      source,
      /intendedAction: rows\.length > 0 \? "answer" : "decline_data",/,
      "an unconditional `answer` would label an empty result as a factual answer",
    );
  });

  check("BEHAVIORAL: zero rows yields decline_data, not answer", () => {
    const empty = finalizeProof({
      sourceId: "nibrs",
      question: "murders in Baton Rouge in 2020",
      sql: "SELECT year, n FROM t WHERE 0",
      rows: [],
      columns: ["year", "n"],
      truncated: false,
      planFamily: null,
      intendedAction: "decline_data",
      env: SHADOW,
    });
    assert.strictEqual(empty.decision.action, "decline_data");
    // A decline asserts no facts, so the contract does not demand it be withheld.
    assert.strictEqual(empty.hypotheticalAction, "decline_data");
  });

  check("BEHAVIORAL: a non-empty result is still an answer", () => {
    const full = finalizeProof({
      sourceId: "nibrs",
      question: "murders in Baton Rouge in 2020",
      sql: "SELECT year, n FROM t",
      rows: [{ year: 2020, n: 5 }],
      columns: ["year", "n"],
      truncated: false,
      planFamily: null,
      intendedAction: "answer",
      env: SHADOW,
    });
    assert.strictEqual(full.decision.action, "answer");
    // Blocked, because Stage 1 proves no source health -- but recorded as an answer.
    assert.strictEqual(full.hypotheticalAction, "decline_capability");
  });

  check("the deterministic NIBRS path already classified on row count", () => {
    assert.match(source, /intendedAction: rows\.length > 0 \? "answer" : "decline_data",[\s\S]{0,200}deterministicQuery\.sql/);
  });
}

console.log("\n3. the SHR shooting derivation is sealed from PRE-validation SQL");
{
  const source = read(SHR_ROUTE);

  check("the planner's SQL is held before the contract validator runs", () => {
    const planned = source.indexOf("const plannedShootingSql = `");
    const validate = source.indexOf("runContractValidation(plannedShootingSql)");
    assert.ok(planned > 0, "the pre-validation SQL must be held in a variable");
    assert.ok(validate > planned, "validation must consume that variable");
  });

  check("the seal uses the planned SQL, never the executed string", () => {
    assert.match(source, /sealPlanDerivation\("deterministic-shooting", plannedShootingSql\)/);
    assert.doesNotMatch(
      source,
      /sealPlanDerivation\("deterministic-shooting", sql\)/,
      "sealing from the executed SQL fingerprints it against itself and proves nothing",
    );
  });

  check("SHR's murder path was already sealed correctly", () => {
    // murderPlan.sql is the planner's output; contract.sql is what executes.
    assert.match(source, /sealPlanDerivation\("deterministic-murder", murderPlan\.sql\)/);
  });

  check("BEHAVIORAL: sealing from executed SQL is a tautology that always passes", () => {
    // Demonstrates why the bug was invisible: the check reported success on a
    // rewritten query, because it compared the rewrite to itself.
    const planned = "SELECT COUNT(*) AS fatal_shootings FROM incidents WHERE year = 2020";
    const rewritten = planned.replace("incidents", "incidents_consistent");
    const tautological = finalizeProof({
      sourceId: "shr",
      question: "fatal shootings in Austin in 2020",
      sql: rewritten,
      rows: [{ fatal_shootings: 5 }],
      columns: ["fatal_shootings"],
      truncated: false,
      planFamily: "deterministic-shooting",
      derivation: sealPlanDerivation("deterministic-shooting", rewritten),
      intendedAction: "answer",
      env: SHADOW,
    });
    assert.strictEqual(
      tautological.manifest.checks.semanticPlan,
      "passed",
      "sealing from the executed SQL always passes — that is the defect",
    );
  });

  check("BEHAVIORAL: sealing from the planned SQL catches the rewrite", () => {
    const planned = "SELECT COUNT(*) AS fatal_shootings FROM incidents WHERE year = 2020";
    const rewritten = planned.replace("incidents", "incidents_consistent");
    const honest = finalizeProof({
      sourceId: "shr",
      question: "fatal shootings in Austin in 2020",
      sql: rewritten,
      rows: [{ fatal_shootings: 5 }],
      columns: ["fatal_shootings"],
      truncated: false,
      planFamily: "deterministic-shooting",
      derivation: sealPlanDerivation("deterministic-shooting", planned),
      intendedAction: "answer",
      env: SHADOW,
    });
    assert.strictEqual(honest.manifest.checks.semanticPlan, "unknown");
    assert.match(honest.checkReasons!.semanticPlan, /rewritten between planning and execution/);
    assert.strictEqual(honest.manifest.derivation, "model_authored");
  });

  check("an unmodified query still verifies", () => {
    const planned = "SELECT COUNT(*) AS fatal_shootings FROM incidents WHERE year = 2020";
    const unchanged = finalizeProof({
      sourceId: "shr",
      question: "fatal shootings in Austin in 2020",
      sql: planned,
      rows: [{ fatal_shootings: 5 }],
      columns: ["fatal_shootings"],
      truncated: false,
      planFamily: "deterministic-shooting",
      derivation: sealPlanDerivation("deterministic-shooting", planned),
      intendedAction: "answer",
      env: SHADOW,
    });
    assert.strictEqual(unchanged.manifest.checks.semanticPlan, "passed");
    assert.strictEqual(unchanged.manifest.derivation, "deterministic");
    assert.strictEqual(fingerprintSql(planned), fingerprintSql(planned));
  });
}

console.log("\n4. no factual payload is wrapped twice");
{
  check("no route double-wraps a payload", () => {
    // Idempotent, so harmless at runtime -- but two gate calls on one payload read as
    // two decisions, and an auditor would have to work out which one counted.
    for (const file of [
      "app/api/query/route.ts",
      "app/api/hc-query/route.ts",
      SHR_ROUTE,
      NIBRS_ROUTE,
    ]) {
      const source = read(file);
      assert.doesNotMatch(
        source,
        /emitFactualPayload\((\w+),\s*emitFactualPayload\(/,
        `${file} wraps a payload twice`,
      );
    }
  });

  check("the NIBRS deterministic exit wraps exactly once", () => {
    const source = read(NIBRS_ROUTE);
    const wraps = (source.match(/emitFactualPayload\(deterministicProof,/g) || []).length;
    assert.strictEqual(wraps, 1, `expected 1 wrap for the deterministic exit, found ${wraps}`);
  });
}

console.log(`\nroute integration tests: ${passed} passed`);
if (process.exitCode) {
  console.log("route integration tests: FAILED");
} else {
  console.log("route integration tests: passed");
}
