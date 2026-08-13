/**
 * Cache validity: an entry authored under one ENFORCEMENT configuration must not be
 * replayed under another (handoff §4, §13) -- and everything short of enforcement must
 * leave the cache key exactly as the baseline release had it.
 *
 * WHAT THE CACHE HOLDS, AND WHY THAT MATTERS HERE. lib/response-cache stores the
 * model's SQL and pre-query explanation, not the answer. A hit skips the Claude call
 * and re-runs that SQL against live data, so the rows are always fresh and the result
 * travels the route's normal exit — which means cache hits already pass through proof
 * finalization. §13's "cache hits cannot bypass proof" is satisfied by the route
 * integration; what these tests cover is the second half, "enforcement/source-version
 * changes invalidate incompatible cache entries".
 *
 * THE THREE DEFECTS THESE PIN. (1) A first revision keyed on the FAMILY-LESS resolved
 * mode, so per-family enforcement — the only kind that exists — was completely
 * invisible: turning on PROOF_MODE_FAMILY_CURRENT_CLEARANCE_TYPE=enforce left the
 * signature byte-identical and every stale entry kept serving. (2) It returned a
 * signature even in `off` mode, changing every cache key while claiming to be inert.
 * (3) It then diverged as soon as a source was merely OBSERVING, which broke invariant
 * 14: a question warmed under `off` MISSED once shadow was enabled in the same process,
 * re-invoking the model, which is free to return different SQL, rows, narrative and
 * charts. Shadow must sit on the baseline key; only genuinely authorized enforcement, or
 * a known source version, may move it.
 *
 * WHY THE ENFORCING FIXTURE LOOKS OVER-SPECIFIED. resolveMode grants `enforce` only when
 * the global, source AND family levels all say so, and clamps to `shadow` otherwise. So
 * a test that means "enforcement is genuinely in force" has to set all three, and a
 * partially-authorized configuration is a shadow configuration — pinned below.
 */
import assert from "node:assert";
import { getCached, setCache } from "../lib/response-cache";
import {
  cacheValiditySignature,
  proofConfigFingerprint,
  UNKNOWN_DATA_VERSION,
} from "../lib/proof-cache-validity";
import { PROOF_SCHEMA_VERSION } from "../lib/proof-finalize";

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

const ENTRY = { sql: "SELECT 1", explanation: "Here are the results.", title: "Results" };
const SHADOW = { PROOF_MODE: "shadow", PROOF_MODE_CURRENT: "shadow" };
/** Authorized at every level, which is the only way enforcement actually exists. */
const ENFORCING = {
  PROOF_MODE: "enforce",
  PROOF_MODE_CURRENT: "enforce",
  PROOF_MODE_FAMILY_CURRENT_CLEARANCE_TYPE: "enforce",
};

console.log("\nnothing short of enforcement moves the key");
{
  check("no signature at all when off", () => {
    // response-cache builds the pre-Stage-1 key when no signature is supplied, so an
    // off-mode deployment uses byte-identical keys to the baseline release.
    assert.strictEqual(cacheValiditySignature("current", null, {}), undefined);
  });

  check("no signature in shadow either", () => {
    // Invariant 14: shadow cannot change routing, SQL, retries, rows, narrative or
    // charts, and a different cache key changes all of them via a re-invoked model.
    assert.strictEqual(cacheValiditySignature("current", null, SHADOW), undefined);
  });

  check("the kill switch overrides an otherwise enforcing configuration", () => {
    assert.strictEqual(
      cacheValiditySignature("current", null, { ...ENFORCING, PROOF_KILL_SWITCH: "1" }),
      undefined,
    );
  });

  check("a partially authorized enforce is a shadow configuration", () => {
    // resolveMode clamps this to shadow, so it must stay on the baseline key. Otherwise
    // a half-finished enforcement rollout would silently invalidate the cache.
    for (const env of [
      { PROOF_MODE: "enforce", PROOF_MODE_CURRENT: "enforce" }, // no family
      { PROOF_MODE: "shadow", PROOF_MODE_CURRENT: "enforce", PROOF_MODE_FAMILY_CURRENT_CLEARANCE_TYPE: "enforce" },
      { PROOF_MODE: "enforce", PROOF_MODE_CURRENT: "shadow", PROOF_MODE_FAMILY_CURRENT_CLEARANCE_TYPE: "enforce" },
    ]) {
      assert.strictEqual(cacheValiditySignature("current", null, env), undefined, JSON.stringify(env));
    }
  });

  check("shadow family-variable changes do not perturb the key", () => {
    // Adding or flipping a family variable while nothing is authorized to enforce must
    // be invisible to the cache.
    const base = { ...SHADOW };
    const added = { ...SHADOW, PROOF_MODE_FAMILY_CURRENT_AGENCY_TREND: "shadow" };
    const flipped = { ...SHADOW, PROOF_MODE_FAMILY_CURRENT_AGENCY_TREND: "enforce" };
    assert.strictEqual(cacheValiditySignature("current", null, base), undefined);
    assert.strictEqual(cacheValiditySignature("current", null, added), undefined);
    assert.strictEqual(cacheValiditySignature("current", null, flipped), undefined);
  });

  check("a source held off yields none while another source enforces", () => {
    const env = { ...ENFORCING, PROOF_MODE_NIBRS: "off" };
    assert.strictEqual(cacheValiditySignature("nibrs", null, env), undefined);
    assert.ok(cacheValiditySignature("current", null, env), "the enforcing source still gets one");
  });
}

console.log("\noff and shadow share one cache");
{
  check("an entry warmed under off is readable in shadow", () => {
    const question = "murders in Austin 2020";
    setCache(question, "current", ENTRY, cacheValiditySignature("current", null, {}));
    assert.ok(
      getCached(question, "current", cacheValiditySignature("current", null, SHADOW)),
      "enabling shadow must not invalidate what off cached",
    );
  });

  check("an entry warmed in shadow is readable once shadow is switched off", () => {
    // The other direction: otherwise turning shadow OFF would itself change behavior.
    const question = "murders in Fort Worth 2020";
    setCache(question, "current", ENTRY, cacheValiditySignature("current", null, SHADOW));
    assert.ok(getCached(question, "current", cacheValiditySignature("current", null, {})));
  });
}

console.log("\nauthorized enforcement invalidates");
{
  check("entering enforcement produces a distinct key", () => {
    // The reported defect, reproduced: enforcement only ever exists at family level, and
    // the first revision resolved the family-less mode, so this pair was identical.
    const before = cacheValiditySignature("current", null, SHADOW);
    const after = cacheValiditySignature("current", null, ENFORCING);
    assert.strictEqual(before, undefined, "shadow sits on the baseline key");
    assert.ok(after, "enforcement gets a signature");
  });

  check("an off-warmed entry is not replayed under enforcement", () => {
    const question = "murders in El Paso 2020";
    setCache(question, "current", ENTRY, cacheValiditySignature("current", null, {}));
    assert.strictEqual(
      getCached(question, "current", cacheValiditySignature("current", null, ENFORCING)),
      null,
      "SQL authored with no enforcement decision must not serve an enforced answer",
    );
  });

  check("adding another family key changes it", () => {
    const withExtra = { ...ENFORCING, PROOF_MODE_FAMILY_CURRENT_AGENCY_TREND: "shadow" };
    assert.notStrictEqual(
      cacheValiditySignature("current", null, ENFORCING),
      cacheValiditySignature("current", null, withExtra),
    );
  });

  check("changing a family's value changes it", () => {
    const a = { ...ENFORCING, PROOF_MODE_FAMILY_CURRENT_X: "shadow" };
    const b = { ...ENFORCING, PROOF_MODE_FAMILY_CURRENT_X: "enforce" };
    assert.notStrictEqual(
      cacheValiditySignature("current", null, a),
      cacheValiditySignature("current", null, b),
    );
  });

  check("another SOURCE's family keys do not disturb this one", () => {
    // Otherwise every source's cache would churn whenever any family anywhere changed.
    const otherSource = { ...ENFORCING, PROOF_MODE_FAMILY_NIBRS_CLEARANCE_TYPE: "enforce" };
    assert.strictEqual(
      cacheValiditySignature("current", null, ENFORCING),
      cacheValiditySignature("current", null, otherSource),
    );
  });

  check("the fingerprint does not depend on env iteration order", () => {
    const a = { ...ENFORCING, PROOF_MODE_FAMILY_CURRENT_A: "shadow", PROOF_MODE_FAMILY_CURRENT_B: "shadow" };
    const b = { PROOF_MODE_FAMILY_CURRENT_B: "shadow", PROOF_MODE_FAMILY_CURRENT_A: "shadow", ...ENFORCING };
    assert.strictEqual(proofConfigFingerprint("current", a), proofConfigFingerprint("current", b));
  });
}

console.log("\nversion and schema participate");
{
  check("the proof schema version is part of the signature", () => {
    assert.match(cacheValiditySignature("current", null, ENFORCING)!, new RegExp(`^p${PROOF_SCHEMA_VERSION}\\|`));
  });

  check("an absent data version is recorded as unknown, not omitted", () => {
    // Omitting it would make the Stage 2 arrival of real versions a silent no-op for
    // entries cached beforehand.
    for (const version of [null, undefined, "", "   "]) {
      assert.match(
        cacheValiditySignature("current", version, ENFORCING)!,
        new RegExp(`d:${UNKNOWN_DATA_VERSION}$`),
      );
    }
  });

  check("a known source version alone justifies a signature", () => {
    // Source-version compatibility is the second reason validity may diverge, and it is
    // independent of enforcement. Stage 2 supplies these; today the routes pass null, so
    // this path is unreached in production and pinned here only so Stage 2 inherits it.
    assert.ok(cacheValiditySignature("current", "2026-08-01", SHADOW));
  });

  check("a source data version change invalidates", () => {
    const v1 = cacheValiditySignature("current", "2026-08-01", ENFORCING);
    const v2 = cacheValiditySignature("current", "2026-09-01", ENFORCING);
    setCache("murders in Dallas 2020", "current", ENTRY, v1);
    assert.ok(getCached("murders in Dallas 2020", "current", v1));
    assert.strictEqual(getCached("murders in Dallas 2020", "current", v2), null);
  });

  check("the signature is stable for identical inputs", () => {
    const env = {
      PROOF_MODE: "enforce",
      PROOF_MODE_SHR: "enforce",
      PROOF_MODE_FAMILY_SHR_MURDER_TREND: "enforce",
    };
    assert.strictEqual(
      cacheValiditySignature("shr", "v1", env),
      cacheValiditySignature("shr", "v1", env),
    );
  });
}

console.log("\nordinary cache behavior is unchanged");
{
  const sig = cacheValiditySignature("current", null, ENFORCING);

  check("entries remain isolated by tab", () => {
    setCache("shared question", "current", ENTRY, sig);
    assert.ok(getCached("shared question", "current", sig));
    assert.strictEqual(getCached("shared question", "historical", sig), null);
  });

  check("question normalization still applies", () => {
    setCache("Murders  in Austin?", "current", ENTRY, sig);
    assert.ok(getCached("murders in austin", "current", sig), "case and punctuation must still normalize");
  });

  check("an unsignatured entry round-trips under the baseline key", () => {
    setCache("legacy question", "current", ENTRY);
    assert.ok(getCached("legacy question", "current"));
    assert.strictEqual(getCached("legacy question", "current", sig), null, "and does not collide");
  });
}

console.log(`\ncache validity tests: ${passed} passed`);
if (process.exitCode) {
  console.log("cache validity tests: FAILED");
} else {
  console.log("cache validity tests: passed");
}
