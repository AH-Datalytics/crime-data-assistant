/**
 * Behavioral regressions for the five round-3 review findings.
 *
 * Each case here failed before its fix. They are grouped in one suite because they
 * share a theme worth naming: every one was a place where the proof layer accepted a
 * caller's framing instead of checking it — a route said which text was factual,
 * which question was being asked, which entities counted as included, which family a
 * token belonged to, and which string was the model's own words. Five different
 * symptoms, one mistake.
 *
 * The suites next door test the modules in isolation. This one asserts the behavior
 * a reviewer would actually observe.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  finalizeProof,
  proofLogFields,
  __resetProofBudgetStateForTests,
} from "../lib/proof-finalize";
import {
  sealPlanDerivation,
  sealCompilerPlanDerivation,
  verifyPlanDerivation,
} from "../lib/plan-derivation";
import { omissionsAreDisclosed } from "../lib/proof-checks";
import { buildQueryLogInsert } from "../lib/query-log-columns";

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
const SQL = "SELECT year, agency, SUM(count) AS murders FROM agency_monthly GROUP BY year, agency";

function base(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: "current" as const,
    question: "murders in Baton Rouge from 2018 to 2022",
    sql: SQL,
    rows: [{ year: 2020, agency: "Baton Rouge", murders: 60 }],
    columns: ["year", "agency", "murders"],
    truncated: false,
    planFamily: null as string | null,
    intendedAction: "answer" as const,
    env: SHADOW,
    ...overrides,
  };
}

console.log("\n1. factual background explanations pass through the gate");
{
  const source = fs.readFileSync("app/api/query/route.ts", "utf8");

  check("the explanation event is classified as factual", () => {
    // It replaces the narrative the user reads about the numbers, and a failed grain
    // check discards the text entirely and substitutes its own message.
    assert.match(
      source,
      /type NonFactualStreamEvent = Exclude<StreamEvent, \{ type: "result" \} \| \{ type: "explanation" \}>/,
      "explanation must be excluded from the non-factual union",
    );
    assert.match(
      source,
      /type FactualStreamEvent = Extract<StreamEvent, \{ type: "result" \} \| \{ type: "explanation" \}>/,
      "explanation must be in the factual union",
    );
  });

  check("neither explanation emission is raw", () => {
    const raw = (source.match(/sseEvent\(\{ type: "explanation"/g) || []).length;
    assert.strictEqual(raw, 0, `${raw} explanation event(s) emitted without a seal`);
  });

  check("both explanation emissions are sealed with their own finalization", () => {
    const sealed = (source.match(/emitFactualPayload\((?:post|retry)Finalization, \{ type: "explanation"/g) || []).length;
    assert.strictEqual(sealed, 2, `expected 2 sealed explanation emissions, found ${sealed}`);
  });

  check("the refined narrative is re-finalized, not reusing the result's proof", () => {
    // The text differs from what gated the result event, and the difference is what
    // needs proving. Reusing `finalization` would certify text nobody evaluated.
    assert.match(source, /const postFinalization = finalizeExit\(\{[\s\S]{0,400}narrative: postExplanation/);
    assert.match(source, /const retryFinalization = finalizeExit\(\{[\s\S]{0,400}narrative: retryExplanation/);
  });

  check("a changed narrative is evaluated against the new text", () => {
    // Behavioral: disclosure is derived from the narrative, so the same rows with a
    // disclosing vs silent narrative reach different completeness verdicts.
    const silent = finalizeProof(base({
      question: "compare murders in Austin and Dallas in 2020",
      rows: [{ year: 2020, agency: "Austin", murders: 60 }],
      returnedEntities: ["Austin"],
      narrative: "Murders in Austin rose in 2020.",
    }));
    const disclosing = finalizeProof(base({
      question: "compare murders in Austin and Dallas in 2020",
      rows: [{ year: 2020, agency: "Austin", murders: 60 }],
      returnedEntities: ["Austin"],
      narrative: "Results cover Austin. Dallas could not be included through this path.",
    }));
    assert.strictEqual(silent.manifest.checks.entityCompleteness, "failed");
    assert.strictEqual(disclosing.manifest.checks.entityCompleteness, "passed");
  });

  check("partial disclosure is not disclosure", () => {
    // Naming three of eight omissions leaves five silent drops.
    assert.strictEqual(omissionsAreDisclosed("We excluded Dallas and Houston.", ["Dallas", "Houston"]), true);
    assert.strictEqual(omissionsAreDisclosed("We excluded Dallas.", ["Dallas", "Houston"]), false);
    assert.strictEqual(omissionsAreDisclosed(null, ["Dallas"]), false);
    assert.strictEqual(omissionsAreDisclosed(undefined, []), true);
  });
}

console.log("\n2. a follow-up fragment keeps its 32-city completeness check");
{
  // REAL cities: the requested set comes from lib/geo-place-resolver, which cannot
  // canonicalize a fabricated name, so a synthetic "City0" fixture would resolve to
  // nothing and quietly pass for the wrong reason.
  const CITIES = [
    "Austin", "Dallas", "Houston", "Phoenix", "Chicago", "Denver", "Seattle", "Portland",
    "Atlanta", "Boston", "Baltimore", "Detroit", "Memphis", "Nashville", "Louisville",
    "Milwaukee", "Cleveland", "Columbus", "Charlotte", "Raleigh", "Tampa", "Orlando",
    "Sacramento", "Fresno", "Tucson", "Omaha", "Wichita", "Tulsa", "Albuquerque",
    "Minneapolis", "Pittsburgh", "Cincinnati",
  ];
  const reconstructed =
    "compare clearances by type in " + CITIES.join(", ") + " in 2020";

  check("the bare fragment alone yields no requested entities", () => {
    // This is the failure: proof was handed "just clearances by type", which names no
    // city, so a 32-city comparison had nothing to check completeness against.
    const fragment = finalizeProof(base({
      question: "just clearances by type",
      rows: CITIES.slice(0, 31).map((city) => ({ city, cleared: 1 })),
      columns: ["city", "cleared"],
      returnedEntities: CITIES.slice(0, 31),
    }));
    assert.strictEqual(fragment.decision.requested, null, "the fragment names nobody");
    assert.strictEqual(
      fragment.manifest.checks.entityCompleteness,
      "not_applicable",
      "with no requested entities the check cannot fire",
    );
  });

  check("the reconstructed question restores a large requested set", () => {
    // Not exactly 32: names needing clarification (Portland OR/ME, Columbus OH/GA)
    // are correctly excluded, because an unresolved mention has no canonical identity
    // to compare a row against and counting it would fabricate an omission. The point
    // is the contrast with the fragment's zero.
    const full = finalizeProof(base({
      question: reconstructed,
      rows: CITIES.map((city) => ({ city, cleared: 1 })),
      columns: ["city", "cleared"],
      returnedEntities: CITIES,
      narrative: "Clearances by type for the requested cities.",
    }));
    assert.ok((full.decision.requested ?? 0) >= 20, `requested=${full.decision.requested}, expected many`);
    assert.strictEqual(full.manifest.checks.entityCompleteness, "passed", "a complete result must pass");
  });

  check("dropping ONE resolvable city from the fragment follow-up is caught", () => {
    // Chicago resolves unambiguously, so its absence is a real, detectable omission --
    // this is the 31-of-32 failure arriving through a follow-up fragment.
    const withoutChicago = CITIES.filter((city) => city !== "Chicago");
    const full = finalizeProof(base({
      question: reconstructed,
      rows: withoutChicago.map((city) => ({ city, cleared: 1 })),
      columns: ["city", "cleared"],
      returnedEntities: withoutChicago,
      narrative: "Clearances by type for the requested cities.",
    }));
    assert.strictEqual(full.manifest.checks.entityCompleteness, "failed", "the missing city must be caught");
    assert.match(full.checkReasons!.entityCompleteness, /Chicago/);
    assert.ok(
      full.decision.omissions.some((omission) => /Chicago/i.test(omission.label)),
      "Chicago must be recorded as an omission",
    );
  });

  check("both routes feed proof the reconstructed question", () => {
    for (const file of ["app/api/query/route.ts", "app/api/hc-query/route.ts"]) {
      const source = fs.readFileSync(file, "utf8");
      assert.match(source, /let proofQuestion = question;/, `${file} must track an effective question`);
      assert.match(source, /question: proofQuestion,/, `${file} must pass it to finalizeProof`);
      assert.match(source, /proofQuestion = guardrailQuestion;/, `${file} must adopt the reconstruction`);
    }
  });

  check("the RAW question is still what gets logged", () => {
    // The reviewer must see what the user typed, not our reconstruction.
    const source = fs.readFileSync("app/api/query/route.ts", "utf8");
    assert.match(
      source,
      /writeLog\(question, sql, rows\.length, null, totalMs2/,
      "the terminal log write must pass the raw question",
    );
  });
}

console.log("\n3. `included` counts matched requests, not returned row keys");
{
  check("one city/state row counts as ONE included entity", () => {
    // returnedEntities is alias-expanded across city, agency, and state columns, so a
    // single Chicago row contributes "chicago" AND "il". Counting those keys reported
    // two included entities for one city.
    const finalization = finalizeProof(base({
      question: "murders in Chicago in 2020",
      rows: [{ city: "Chicago", state: "IL", murders: 500 }],
      columns: ["city", "state", "murders"],
      returnedEntities: ["Chicago", "IL"],
      narrative: "Murders in Chicago in 2020.",
    }));
    assert.strictEqual(finalization.decision.requested, 1, "one city was requested");
    assert.strictEqual(finalization.decision.included, 1, "one city came back, not two keys");
  });

  check("included never exceeds requested", () => {
    const finalization = finalizeProof(base({
      question: "murders in Chicago in 2020",
      rows: [{ city: "Chicago", state: "IL", agency: "Chicago PD", murders: 500 }],
      columns: ["city", "state", "agency", "murders"],
      returnedEntities: ["Chicago", "IL", "Chicago PD", "cook"],
      narrative: "Murders in Chicago in 2020.",
    }));
    assert.ok(
      (finalization.decision.included ?? 0) <= (finalization.decision.requested ?? 0),
      `included=${finalization.decision.included} exceeded requested=${finalization.decision.requested}`,
    );
  });

  check("a partial comparison reports the real shortfall", () => {
    const finalization = finalizeProof(base({
      question: "compare murders in Austin, Dallas and Houston in 2020",
      rows: [
        { city: "Austin", state: "TX", murders: 60 },
        { city: "Dallas", state: "TX", murders: 80 },
      ],
      columns: ["city", "state", "murders"],
      returnedEntities: ["Austin", "Dallas", "TX"],
      narrative: "Austin and Dallas only.",
    }));
    assert.strictEqual(finalization.decision.requested, 3);
    assert.strictEqual(finalization.decision.included, 2, "TX must not inflate the count");
  });

  check("included is null when nothing identifiable was requested", () => {
    const finalization = finalizeProof(base({ question: "how many agencies report data" }));
    assert.strictEqual(finalization.decision.requested, null);
    assert.strictEqual(finalization.decision.included, null);
  });

  check("a planner override drives requested, included AND omissions from one list", () => {
    // Found while fixing #3: `requested` came from the caller's override while
    // omissions were derived from the parsed request, so a planner declaring three
    // cities against a one-city question reported requested=3, included=3,
    // omissions=0 -- three numbers that cannot all be true.
    const finalization = finalizeProof(base({
      question: "murders in Baton Rouge from 2018 to 2022",
      requestedEntities: ["Baton Rouge", "New Orleans", "Shreveport"],
      returnedEntities: ["Baton Rouge", "New Orleans"],
      narrative: "Baton Rouge and New Orleans.",
    }));
    assert.strictEqual(finalization.decision.requested, 3);
    assert.strictEqual(finalization.decision.included, 2, "Shreveport did not come back");
    assert.strictEqual(finalization.decision.omissions.length, 1, "and must be recorded as omitted");
    assert.match(finalization.decision.omissions[0].label, /Shreveport/);
  });

  check("requested = included + omissions, always", () => {
    // The reconciliation identity. Same discipline as lib/audit-health's
    // expected = executed + skipped + failed: numbers that cannot be reconciled
    // cannot be trusted, whichever one happens to be wrong.
    for (const returned of [[], ["Austin"], ["Austin", "Dallas"], ["Austin", "Dallas", "Houston"]]) {
      const finalization = finalizeProof(base({
        question: "compare murders in Austin, Dallas and Houston in 2020",
        rows: returned.map((city) => ({ city, murders: 1 })),
        columns: ["city", "murders"],
        returnedEntities: returned,
      }));
      const requested = finalization.decision.requested ?? 0;
      const included = finalization.decision.included ?? 0;
      assert.strictEqual(
        included + finalization.decision.omissions.length,
        requested,
        `returned=${JSON.stringify(returned)}: ${included} + ${finalization.decision.omissions.length} !== ${requested}`,
      );
    }
  });
}

console.log("\n4. plan-family identity is verified, and route tokens cannot enforce");
{
  check("a token sealed for another family fails verification", () => {
    const verdict = verifyPlanDerivation(sealPlanDerivation("family-a", SQL), SQL, "family-b");
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.reason, /plan family mismatch/);
    assert.match(verdict.reason, /'family-a'.*'family-b'/);
  });

  check("a matching family verifies", () => {
    assert.strictEqual(verifyPlanDerivation(sealPlanDerivation("family-a", SQL), SQL, "family-a").ok, true);
  });

  check("a mismatched family is recorded as model_authored, not relabelled", () => {
    const finalization = finalizeProof(base({
      planFamily: "family-b",
      derivation: sealPlanDerivation("family-a", SQL),
    }));
    assert.strictEqual(finalization.manifest.derivation, "model_authored");
    assert.strictEqual(finalization.manifest.checks.semanticPlan, "unknown");
    assert.match(finalization.checkReasons!.semanticPlan, /plan family mismatch/);
  });

  check("an UNVERIFIED token cannot supply the recorded family", () => {
    // Otherwise a bad token would still get its family into the log and, later, into
    // per-family enforcement accounting.
    const finalization = finalizeProof(base({
      planFamily: null,
      sql: SQL.replace("agency_monthly", "state_monthly"),
      derivation: sealPlanDerivation("family-a", SQL),
    }));
    assert.strictEqual(finalization.manifest.planFamily, null, "a failed token must not name the family");
  });

  check("enforcement is withheld from a route-issued token", () => {
    // The design boundary: a route token proves SQL identity, not that a deterministic
    // compiler produced the query. It is shadow instrumentation only.
    const env = {
      PROOF_MODE: "enforce",
      PROOF_MODE_CURRENT: "enforce",
      PROOF_MODE_FAMILY_CURRENT_FAMILY_A: "enforce",
    };
    const finalization = finalizeProof(base({
      env,
      planFamily: "family-a",
      derivation: sealPlanDerivation("family-a", SQL),
    }));
    assert.strictEqual(finalization.mayAlterDelivery, false, "a route token must not alter delivery");
    assert.strictEqual(finalization.mode, "shadow");
    assert.match(finalization.enforcementWithheldReason!, /route-issued/);
  });

  check("a compiler-issued token is the positive case", () => {
    const env = {
      PROOF_MODE: "enforce",
      PROOF_MODE_CURRENT: "enforce",
      PROOF_MODE_FAMILY_CURRENT_FAMILY_A: "enforce",
    };
    const finalization = finalizeProof(base({
      env,
      planFamily: "family-a",
      derivation: sealCompilerPlanDerivation("family-a", SQL),
    }));
    assert.strictEqual(finalization.mode, "enforce");
    assert.strictEqual(finalization.enforcementWithheldReason, null);
  });

  check("enforcement authorized for one family cannot be borrowed by another", () => {
    const env = {
      PROOF_MODE: "enforce",
      PROOF_MODE_CURRENT: "enforce",
      PROOF_MODE_FAMILY_CURRENT_FAMILY_A: "enforce",
    };
    // family-b is NOT authorized. A compiler token for family-b must not enforce.
    const finalization = finalizeProof(base({
      env,
      planFamily: "family-b",
      derivation: sealCompilerPlanDerivation("family-b", SQL),
    }));
    assert.strictEqual(finalization.mayAlterDelivery, false);
    assert.strictEqual(finalization.mode, "shadow");
    // Capped in phase 1 by resolveMode's three-way authorization, which names the env
    // variable that was never set for this family.
    assert.match(finalization.enforcementWithheldReason!, /PROOF_MODE_FAMILY_CURRENT_FAMILY_B/);
  });

  check("the withhold reason is persisted, and separately from degradation", () => {
    const env = {
      PROOF_MODE: "enforce",
      PROOF_MODE_CURRENT: "enforce",
      PROOF_MODE_FAMILY_CURRENT_FAMILY_A: "enforce",
    };
    const finalization = finalizeProof(base({
      env,
      planFamily: "family-a",
      derivation: sealPlanDerivation("family-a", SQL),
    }));
    assert.strictEqual(finalization.degradedReason, null, "a withhold is not a malfunction");
    const envelope = JSON.parse(proofLogFields(finalization).proof_manifest!);
    assert.match(envelope.enforcementWithheldReason, /route-issued/);
  });
}

console.log("\n5. the Hate Crime raw response survives the server template");
{
  const source = fs.readFileSync("app/api/hc-query/route.ts", "utf8");

  check("capture precedes all three overwrites", () => {
    const capture = source.indexOf("const rawNoSqlText = claude.explanation || null;");
    const leakFallback = source.indexOf("claude.explanation = INTERNAL_LEAK_SAFE_MESSAGE");
    const template = source.indexOf('buildNoSqlFallbackMessage("hate_crime")');
    const neutralize = source.indexOf('neutralizeUnverifiedAvailabilityClaim(claude.explanation, "Hate Crime")');
    assert.ok(capture > 0, "the capture must exist");
    for (const [name, idx] of [["leak fallback", leakFallback], ["server template", template], ["neutralizer", neutralize]] as const) {
      assert.ok(idx > 0, `${name} must exist`);
      assert.ok(capture < idx, `capture must precede the ${name}`);
    }
  });

  check("only one capture site exists", () => {
    const captures = (source.match(/const rawNoSqlText = /g) || []).length;
    assert.strictEqual(captures, 1, `found ${captures} capture sites; the late one must be gone`);
  });

  check("BEHAVIORAL: the persisted value is the model's words, not the template", () => {
    // Replays the route's overwrite sequence against a real query_log and asserts what
    // lands in model_response. A source-order assertion alone would not have caught
    // the original defect if the capture had been moved but the value rebound.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcraw-"));
    const db = new Database(path.join(dir, "query_log.db"));
    db.exec(`CREATE TABLE query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT, rows INTEGER,
      error TEXT, ms INTEGER, response TEXT, guardrails TEXT, model TEXT, session_id TEXT,
      routing_confidence TEXT, routing_mode TEXT, routing_reason TEXT, query_guidance TEXT,
      query_contract TEXT, model_response TEXT)`);

    const MODEL_WORDS = "Hate crime data for that county is not in the FBI extract I can reach.";
    const SERVER_TEMPLATE = "I could not generate a database query for that request.";

    // The route's sequence, in order.
    const claude = { explanation: MODEL_WORDS };
    const rawNoSqlText: string | null = claude.explanation || null; // capture FIRST
    claude.explanation = SERVER_TEMPLATE; // the template overwrites

    const insert = buildQueryLogInsert(db, {
      ts: 1,
      tab: "hate_crime",
      question: "hate crimes in Orleans Parish",
      response: claude.explanation,
      model_response: JSON.stringify({ first: rawNoSqlText, retry: null }),
    })!;
    db.prepare(insert.sql).run(...insert.values);

    const stored = db.prepare("SELECT response, model_response FROM query_log").get() as {
      response: string;
      model_response: string;
    };
    db.close();

    assert.strictEqual(stored.response, SERVER_TEMPLATE, "the user still sees the safe template");
    const captured = JSON.parse(stored.model_response).first;
    assert.strictEqual(captured, MODEL_WORDS, "model_response must hold the MODEL's words");
    assert.notStrictEqual(captured, SERVER_TEMPLATE, "capturing the template defeats the column's purpose");
  });
}

console.log(`\nround-3 regression tests: ${passed} passed`);
if (process.exitCode) {
  console.log("round-3 regression tests: FAILED");
} else {
  console.log("round-3 regression tests: passed");
}
