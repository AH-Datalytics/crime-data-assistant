/**
 * Cache validity: an entry authored under one enforcement configuration must not be
 * replayed under another (handoff §4, §13).
 *
 * WHAT THE CACHE HOLDS, AND WHY THAT MATTERS HERE. lib/response-cache stores the
 * model's SQL and pre-query explanation, not the answer. A hit skips the Claude call
 * and re-runs that SQL against live data, so the rows are always fresh and the result
 * travels the route's normal exit — which means cache hits already pass through proof
 * finalization. §13's "cache hits cannot bypass proof" is satisfied by the route
 * integration; what these tests cover is the second half, "enforcement/source-version
 * changes invalidate incompatible cache entries".
 *
 * THE TWO DEFECTS THESE PIN. A first revision keyed on the FAMILY-LESS resolved mode,
 * so per-family enforcement — the only kind that exists — was completely invisible:
 * turning on PROOF_MODE_FAMILY_CURRENT_CLEARANCE_TYPE=enforce left the signature
 * byte-identical and every stale entry kept serving. And it returned a signature even
 * in `off` mode, changing every cache key while the module claimed to be inert.
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

console.log("\noff mode is inert");
{
  check("no signature at all when off", () => {
    // §9.1: `off` "performs no request-path work and has no effect". response-cache
    // builds the pre-Stage-1 key when no signature is supplied, so an off-mode
    // deployment uses byte-identical keys to the baseline release.
    assert.strictEqual(cacheValiditySignature("current", null, {}), undefined);
  });

  check("the kill switch also yields no signature", () => {
    assert.strictEqual(
      cacheValiditySignature("current", null, { PROOF_MODE: "shadow", PROOF_KILL_SWITCH: "1" }),
      undefined,
    );
  });

  check("a source held off yields none while another observes", () => {
    const env = { PROOF_MODE: "shadow", PROOF_MODE_NIBRS: "off" };
    assert.strictEqual(cacheValiditySignature("nibrs", null, env), undefined);
    assert.ok(cacheValiditySignature("current", null, env), "an observing source still gets one");
  });

  check("off and shadow do not share a cache entry", () => {
    // The off -> shadow transition invalidates once, which is correct: entries
    // authored with no proof observation should not be replayed once it is watching.
    setCache("murders in Austin 2020", "current", ENTRY, cacheValiditySignature("current", null, {}));
    assert.ok(getCached("murders in Austin 2020", "current"), "off stores under the baseline key");
    assert.strictEqual(
      getCached("murders in Austin 2020", "current", cacheValiditySignature("current", null, SHADOW)),
      null,
      "and shadow must not read it",
    );
  });
}

console.log("\nper-family enforcement invalidates");
{
  check("enabling one family changes the signature", () => {
    // The reported defect, reproduced: this pair was byte-identical before the fix,
    // because enforcement only ever exists at family level and the signature resolved
    // the family-less mode.
    const before = cacheValiditySignature("current", null, {
      PROOF_MODE: "shadow",
      PROOF_MODE_CURRENT: "shadow",
    });
    const after = cacheValiditySignature("current", null, {
      PROOF_MODE: "enforce",
      PROOF_MODE_CURRENT: "enforce",
      PROOF_MODE_FAMILY_CURRENT_CLEARANCE_TYPE: "enforce",
    });
    assert.ok(before && after);
    assert.notStrictEqual(before, after);
  });

  check("adding a family key alone changes it", () => {
    const base = { PROOF_MODE: "shadow", PROOF_MODE_CURRENT: "shadow" };
    const withFamily = { ...base, PROOF_MODE_FAMILY_CURRENT_AGENCY_TREND: "enforce" };
    assert.notStrictEqual(
      cacheValiditySignature("current", null, base),
      cacheValiditySignature("current", null, withFamily),
    );
  });

  check("changing a family's value changes it", () => {
    const a = { ...SHADOW, PROOF_MODE_FAMILY_CURRENT_X: "shadow" };
    const b = { ...SHADOW, PROOF_MODE_FAMILY_CURRENT_X: "enforce" };
    assert.notStrictEqual(cacheValiditySignature("current", null, a), cacheValiditySignature("current", null, b));
  });

  check("another SOURCE's family keys do not disturb this one", () => {
    // Otherwise every source's cache would churn whenever any family anywhere changed.
    const base = { ...SHADOW };
    const otherSource = { ...SHADOW, PROOF_MODE_FAMILY_NIBRS_CLEARANCE_TYPE: "enforce" };
    assert.strictEqual(
      cacheValiditySignature("current", null, base),
      cacheValiditySignature("current", null, otherSource),
    );
  });

  check("the fingerprint does not depend on env iteration order", () => {
    const a = { ...SHADOW, PROOF_MODE_FAMILY_CURRENT_A: "shadow", PROOF_MODE_FAMILY_CURRENT_B: "shadow" };
    const b = { PROOF_MODE_FAMILY_CURRENT_B: "shadow", PROOF_MODE_FAMILY_CURRENT_A: "shadow", ...SHADOW };
    assert.strictEqual(proofConfigFingerprint("current", a), proofConfigFingerprint("current", b));
  });
}

console.log("\nversion and schema participate");
{
  check("the proof schema version is part of the signature", () => {
    assert.match(cacheValiditySignature("current", null, SHADOW)!, new RegExp(`^p${PROOF_SCHEMA_VERSION}\\|`));
  });

  check("an absent data version is recorded as unknown, not omitted", () => {
    // Omitting it would make the Stage 2 arrival of real versions a silent no-op for
    // entries cached beforehand.
    for (const version of [null, undefined, "", "   "]) {
      assert.match(cacheValiditySignature("current", version, SHADOW)!, new RegExp(`d:${UNKNOWN_DATA_VERSION}$`));
    }
  });

  check("a source data version change invalidates", () => {
    const v1 = cacheValiditySignature("current", "2026-08-01", SHADOW);
    const v2 = cacheValiditySignature("current", "2026-09-01", SHADOW);
    setCache("murders in Dallas 2020", "current", ENTRY, v1);
    assert.ok(getCached("murders in Dallas 2020", "current", v1));
    assert.strictEqual(getCached("murders in Dallas 2020", "current", v2), null);
  });

  check("the signature is stable for identical inputs", () => {
    assert.strictEqual(
      cacheValiditySignature("shr", "v1", { PROOF_MODE: "shadow", PROOF_MODE_SHR: "shadow" }),
      cacheValiditySignature("shr", "v1", { PROOF_MODE: "shadow", PROOF_MODE_SHR: "shadow" }),
    );
  });
}

console.log("\nordinary cache behavior is unchanged");
{
  const sig = cacheValiditySignature("current", null, SHADOW);

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
