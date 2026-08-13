/**
 * Inventory of terminal responses: no factual exit may bypass proof finalization.
 *
 * Handoff §5 asks for exactly this — "extend the existing
 * scripts/test-route-egress-contract.ts into an inventory of terminal responses and
 * assert that factual answer exits pass through proof finalization. The inventory
 * must include the first factual SSE event, deterministic exits, retry resolutions,
 * response-cache hits, and shared-chart embeds."
 *
 * WHY A SOURCE-TEXT SUITE AND NOT ONLY THE TYPE CHECKER. The type system is the
 * primary enforcement: sseEvent() and jsonResp() accept factual content only as a
 * SealedPayload, which lib/proof-finalize's emitFactualPayload() alone produces, so
 * an unwrapped factual exit does not compile. But a future edit could widen those
 * signatures back to `Record<string, any>` and silently remove the whole guarantee
 * while every test still passed. These assertions protect the ENFORCEMENT MECHANISM
 * itself, which no amount of behavioral testing does.
 *
 * The gap this catches is real, not hypothetical. The first Stage 1 revision relied
 * on developers calling emitFactualPayload() voluntarily; the Hate Crime metadata
 * answer finalized and then handed a raw object literal to jsonResp(), discarding
 * the finalization. Nothing failed.
 */
import assert from "node:assert";
import fs from "node:fs";

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

/** Every route whose factual exits are under the proof contract. All four, as of Stage 1. */
const INTEGRATED_ROUTES = [
  "app/api/query/route.ts",
  "app/api/hc-query/route.ts",
  "app/api/shr-query/route.ts",
  "app/api/nibrs-query/route.ts",
];
/** The three JSON routes, whose chokepoint is jsonResp rather than sseEvent. */
const JSON_ROUTES = [
  "app/api/hc-query/route.ts",
  "app/api/shr-query/route.ts",
  "app/api/nibrs-query/route.ts",
];

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/**
 * Occurrences of a response constructor whose first argument is a raw object
 * literal carrying a factual marker.
 *
 * Deliberately tolerant of whitespace and newlines between the paren and the
 * marker, because the routes format these both ways.
 */
function unwrappedFactualExits(source: string, constructor: string, marker: RegExp): number {
  const pattern = new RegExp(`${constructor}\\(\\s*\\{[^}]{0,400}?${marker.source}`, "g");
  return (source.match(pattern) || []).length;
}

console.log("\nthe chokepoint is type-enforced, not conventional");
{
  check("sseEvent accepts a factual event only as a SealedPayload", () => {
    const source = read("app/api/query/route.ts");
    assert.match(
      source,
      /function sseEvent\(\s*event:\s*NonFactualStreamEvent\s*\|\s*SealedPayload<FactualStreamEvent>\s*\)/,
      "sseEvent must narrow its factual parameter to SealedPayload; widening it removes the entire guarantee",
    );
  });

  check("every JSON route's jsonResp accepts factual content only as a SealedPayload", () => {
    for (const file of JSON_ROUTES) {
      assert.match(
        read(file),
        /function jsonResp\(data:\s*SealedPayload</,
        `${file}: jsonResp must narrow its factual parameter to SealedPayload`,
      );
    }
  });

  check("the NIBRS route no longer accepts `unknown`", () => {
    // It was `function jsonResp(data: unknown, ...)`, which accepted anything at all --
    // so narrowing there created the gate rather than merely tightening it.
    assert.doesNotMatch(read("app/api/nibrs-query/route.ts"), /function jsonResp\(data: unknown/);
  });

  check("emitFactualPayload is the only producer of a SealedPayload", () => {
    const source = read("lib/proof-finalize.ts");
    // Two `as SealedPayload<T>` casts, both inside emitFactualPayload.
    const casts = (source.match(/as SealedPayload</g) || []).length;
    assert.strictEqual(casts, 2, `expected 2 casts inside emitFactualPayload, found ${casts}`);
    const fnStart = source.indexOf("export function emitFactualPayload");
    assert.ok(fnStart > 0, "emitFactualPayload must exist");
    const firstCast = source.indexOf("as SealedPayload<");
    assert.ok(firstCast > fnStart, "no SealedPayload cast may precede emitFactualPayload");
  });

  check("both brands are purely nominal, never emitted as object properties", () => {
    // A brand used as a real object key throws ReferenceError at runtime, because
    // `declare const` has no runtime existence. That defect already happened once
    // with the ProofFinalization brand and was invisible because the throw was
    // swallowed by this module's own degradation handler.
    //
    // Comments are stripped first: this file DOCUMENTS the bad form in prose, and an
    // assertion that cannot tell code from a comment about code would fail on the
    // explanation of the very defect it guards against.
    const code = read("lib/proof-finalize.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const brand of ["proofFinalizationBrand", "sealedPayloadBrand"]) {
      const uses = [...code.matchAll(new RegExp(`(\\w+\\s+)?\\[${brand}\\]\\s*:`, "g"))];
      assert.ok(uses.length > 0, `${brand} should appear in a type position`);
      for (const use of uses) {
        assert.strictEqual(
          (use[1] ?? "").trim(),
          "readonly",
          `${brand} must appear only as a readonly type member, never as an emitted object key`,
        );
      }
    }
  });
}

console.log("\nno factual exit constructs a payload without the wrap");
{
  check("no sseEvent receives a raw result event", () => {
    const source = read("app/api/query/route.ts");
    const raw = unwrappedFactualExits(source, "sseEvent", /type:\s*"result"/);
    assert.strictEqual(raw, 0, `${raw} sseEvent call(s) build a result event without emitFactualPayload`);
  });

  check("no jsonResp in any JSON route receives a raw success payload", () => {
    for (const file of JSON_ROUTES) {
      const source = read(file);
      const raw = unwrappedFactualExits(source, "jsonResp", /success:\s*true/);
      assert.strictEqual(raw, 0, `${file}: ${raw} jsonResp call(s) build a success payload without emitFactualPayload`);
    }
  });

  check("every route tracks the reconstructed follow-up question for proof", () => {
    for (const file of INTEGRATED_ROUTES) {
      const source = read(file);
      assert.match(source, /let proofQuestion = question;/, `${file} must track an effective question`);
      assert.match(source, /question: proofQuestion,/, `${file} must pass it to finalizeProof`);
      assert.match(source, /proofQuestion = guardrailQuestion;/, `${file} must adopt the reconstruction`);
    }
  });

  check("every route's log closure carries the proof columns", () => {
    for (const file of INTEGRATED_ROUTES) {
      assert.match(
        read(file),
        /proofLogFields\(proof\)/,
        `${file}: the log closure must persist proof columns`,
      );
    }
  });

  check("every integrated route imports the gate", () => {
    for (const file of INTEGRATED_ROUTES) {
      const source = read(file);
      assert.match(source, /emitFactualPayload/, `${file} must use the egress gate`);
      assert.match(source, /finalizeProof/, `${file} must finalize`);
      assert.match(source, /proofLogFields/, `${file} must persist proof columns`);
    }
  });
}

console.log("\nthe first factual SSE event is gated");
{
  const source = read("app/api/query/route.ts");

  check("finalization precedes the step-5b result enqueue", () => {
    // The defect handoff §4 names: the initial factual event used to be delivered
    // before applyResultDisclosures ran on the later background explanation update.
    const finalize = source.indexOf("const finalization = finalizeExit({");
    const stepFiveB = source.indexOf("// Step 5b: Send result immediately");
    assert.ok(finalize > 0, "the main path must finalize");
    assert.ok(stepFiveB > 0, "the step-5b comment marks the first factual emit");
    assert.ok(
      finalize < stepFiveB,
      "proof finalization must be computed BEFORE the first factual event is enqueued",
    );
  });

  check("the main-path emit uses that finalization", () => {
    const stepFiveB = source.indexOf("// Step 5b: Send result immediately");
    const emit = source.indexOf("emitFactualPayload(finalization,", stepFiveB);
    assert.ok(emit > stepFiveB, "the step-5b emit must be sealed with the main finalization");
  });

  check("each terminal log write persists the proof of the prose IT delivered", () => {
    // THIS ASSERTION USED TO ENCODE A DEFECT. It required all three terminal writes to
    // carry the result event's finalization, which is precisely what was wrong: the
    // refined explanation and its retry replace the prose the user reads, so storing
    // the result event's proof would give the shadow review a record of text nobody
    // was shown. Each path now persists its own.
    const refined = (source.match(/serializeChartConfigForLog\(chartConfig, columns, chartMeta\), deliveredFinalization\)/g) || []).length;
    const retry = (source.match(/serializeChartConfigForLog\(chartConfig, columns, chartMeta\), deliveredRetryFinalization\)/g) || []).length;
    const fallback = (source.match(/serializeChartConfigForLog\(chartConfig, columns, chartMeta\), finalization\)/g) || []).length;
    assert.strictEqual(refined, 1, `refined path: expected 1 write, found ${refined}`);
    assert.strictEqual(retry, 1, `retry path: expected 1 write, found ${retry}`);
    // The both-attempts-failed path is the one case where the result event's proof IS
    // correct, because nothing replaced the prose.
    assert.strictEqual(fallback, 1, `fallback path: expected 1 write, found ${fallback}`);
  });

  check("delivered finalizations default to the result event's", () => {
    // So an unchanged narrative is not left unproven.
    assert.match(source, /let deliveredFinalization = finalization;/);
    assert.match(source, /let deliveredRetryFinalization = finalization;/);
  });
}

console.log("\ndeterministic exits are covered");
{
  const source = read("app/api/query/route.ts");
  // Each deterministic short-circuit must seal a derivation from its planner's own
  // SQL, so a rewrite between planning and execution is detectable.
  const SEALED_FAMILIES = [
    "scorecard",
    "indexedStatePlan.guardrail",
    "multiCityTrend.guardrail",
    "historicalCityChange.guardrail",
    "deterministic-place-lookup",
    "metadata-coverage-answer",
  ];

  for (const family of SEALED_FAMILIES) {
    check(`${family} seals a plan derivation`, () => {
      assert.ok(
        source.includes(`sealPlanDerivation(${family}`) ||
          source.includes(`sealPlanDerivation(\`${family}`) ||
          source.includes(`sealPlanDerivation("${family}"`) ||
          new RegExp(`sealPlanDerivation\\([^)]*${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(source),
        `${family} must seal a derivation rather than assert determinism`,
      );
    });
  }

  check("no route passes a bare deterministic boolean any more", () => {
    for (const file of INTEGRATED_ROUTES) {
      assert.doesNotMatch(
        read(file),
        /deterministic:\s*(?:true|false)/,
        `${file} must supply a sealed derivation, not a boolean claim`,
      );
    }
  });
}

console.log("\nmodel_response is captured outside NIBRS");
{
  check("the query route captures raw no-SQL model text", () => {
    const source = read("app/api/query/route.ts");
    assert.match(source, /rawFirstNoSql/, "must capture the first no-SQL model response");
    assert.match(source, /boundedModelResponseJson\(rawFirstNoSql, rawRetryNoSql\)/, "must pass it to the logger");
  });

  check("the hate-crime route captures raw no-SQL model text", () => {
    const source = read("app/api/hc-query/route.ts");
    assert.match(source, /boundedModelResponseJson\(rawNoSqlText, null\)/, "must pass raw text to the logger");
  });

  check("capture happens BEFORE the server template overwrites it", () => {
    const source = read("app/api/query/route.ts");
    const capture = source.indexOf("if (!claude.sql) rawFirstNoSql = claude.explanation");
    const overwrite = source.indexOf("buildNoSqlFallbackMessage(tab ===");
    assert.ok(capture > 0 && overwrite > 0, "both sites must exist");
    assert.ok(capture < overwrite, "the raw text must be captured before it is replaced");
  });

  check("logQuery no longer receives a literal null for model_response", () => {
    for (const file of INTEGRATED_ROUTES) {
      const source = read(file);
      assert.doesNotMatch(
        source,
        /chartAuditRequestId, null, proofLogFields\(proof\)/,
        `${file} still hardcodes null for model_response`,
      );
    }
  });
}

console.log("\nshared charts and the response cache are inside the contract");
{
  check("the embed route gates its factual payload", () => {
    // §5 names shared-chart embeds in the terminal-response inventory explicitly. A
    // saved chart re-executes stored SQL forever, so it is the longest-lived factual
    // surface in the product.
    const source = read("app/api/embed/route.ts");
    assert.match(
      source,
      /function embedResp\(data: SealedPayload<object> \| EmbedError/,
      "embed's response constructor must require a sealed payload",
    );
    assert.match(source, /emitFactualPayload\(finalization,/, "the read must be sealed");
    assert.match(source, /finalizeProof\(\{/, "the read must finalize");
  });

  check("embed VERIFIES the origin rather than looking it up", () => {
    const source = read("app/api/embed/route.ts");
    assert.match(source, /verifyEmbedOrigin\(/, "creation must verify, not merely read, the claimed origin");
    assert.match(source, /origin_state/, "and record the verdict");
    // The route must not go back to reading delivery_action as if it were proof: in
    // shadow that value is `answer` for every legacy answer regardless of its blocker.
    assert.doesNotMatch(
      source,
      /SELECT delivery_action, proof_mode FROM query_log/,
      "reading delivery_action as proof is the defect this replaced",
    );
  });

  check("the origin verdict reaches the read's recorded evidence", () => {
    const source = read("app/api/embed/route.ts");
    assert.match(source, /planFamily: embedPlanFamily\(originVerdict\)/, "the plan family must reflect the verdict");
    assert.match(source, /embed-origin-\$\{originVerdict\.state\}/, "and the digest must carry it");
    assert.doesNotMatch(
      source,
      /"embed-replay"/,
      "a single family for every non-null request id cannot distinguish a forged origin",
    );
  });

  check("the binding compares the artifact, not just the id", () => {
    const source = read("lib/embed-origin.ts");
    assert.match(source, /does not match the chart's/, "tab must be compared");
    assert.match(source, /not the SQL of the claimed originating answer/, "SQL must be compared");
    assert.match(source, /chart configuration does not match/, "chart config must be compared");
    assert.match(source, /hypotheticalAction/, "proof must come from the envelope, not delivery_action");
  });

  check("the embed read summary is gated on observation, not just on schema", () => {
    // `off` has no effect, which includes not writing a bookkeeping row.
    const source = read("app/api/embed/route.ts");
    assert.match(
      source,
      /if \(withProof && isObserving\(finalization\.mode\)\)/,
      "an off-mode read must leave shared_charts untouched",
    );
  });

  check("every route still MENTIONS the cache validity signature (structural only)", () => {
    /**
     * A CHEAP BACKSTOP, NOT A BEHAVIORAL CLAIM. This asserts only that the wiring is
     * present in the source text -- that someone has not deleted the signature from a
     * route wholesale. It says nothing about what the route does with it.
     *
     * That distinction is not pedantic. These three greps passed unchanged while shadow
     * mode took a DIFFERENT cache key from off, which meant enabling shadow silently
     * re-invoked the model and was free to return different SQL, rows, narrative and
     * charts -- a direct violation of invariant 14 that a text search cannot see. The
     * behavioral proof lives in scripts/test-shadow-route-equivalence.ts, which drives
     * each handler in both modes over a cold and a warm cache and compares the response
     * and the model-call sequence. If these two ever disagree, believe that one.
     */
    for (const file of INTEGRATED_ROUTES) {
      const source = read(file);
      assert.match(source, /cacheValiditySignature\(/, `${file} must compute a cache validity signature`);
      assert.match(source, /getCached\([^)]*cacheValidity\)/, `${file} must read the cache with it`);
      assert.match(source, /setCache\([^;]*cacheValidity\)/, `${file} must write the cache with it`);
    }
  });
}

console.log("\nall four sources are integrated");
{
  check("no route is left outside the contract", () => {
    // Replaces the pending-route tracker that guarded SHR and NIBRS while they were
    // un-integrated. Every route directory with a POST handler must now be listed
    // above, so a NEW source cannot be added without its exits being asserted here.
    const routeFiles = fs
      .readdirSync("app/api", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `app/api/${entry.name}/route.ts`)
      .filter((file) => fs.existsSync(file))
      .filter((file) => /sanitizeUserFacingNarrative/.test(read(file)));
    for (const file of routeFiles) {
      assert.ok(
        INTEGRATED_ROUTES.includes(file),
        `${file} answers questions but is not in INTEGRATED_ROUTES; add it and assert its exits`,
      );
    }
    assert.strictEqual(routeFiles.length, INTEGRATED_ROUTES.length);
  });

  check("SHR and NIBRS seal derivations for their deterministic planners", () => {
    // Both routes run their planner's SQL through the contract validator, which may
    // rewrite it before execution -- exactly the case the token exists to detect.
    assert.match(read("app/api/shr-query/route.ts"), /sealPlanDerivation\("deterministic-murder"/);
    assert.match(read("app/api/shr-query/route.ts"), /sealPlanDerivation\("deterministic-shooting"/);
    assert.match(read("app/api/nibrs-query/route.ts"), /sealPlanDerivation\(deterministicQuery\.guardrail/);
  });

  check("SHR captures raw no-SQL model text before the server template", () => {
    const source = read("app/api/shr-query/route.ts");
    const capture = source.indexOf("const rawNoSqlText = claude.explanation || null;");
    const template = source.indexOf('buildNoSqlFallbackMessage("shr")');
    assert.ok(capture > 0 && template > 0, "both sites must exist");
    assert.ok(capture < template, "the raw text must be captured before it is replaced");
    assert.match(source, /boundedModelResponseJson\(rawNoSqlText, null\)/);
  });
}

console.log(`\nproof egress inventory tests: ${passed} passed`);
if (process.exitCode) {
  console.log("proof egress inventory tests: FAILED");
} else {
  console.log("proof egress inventory tests: passed");
}
