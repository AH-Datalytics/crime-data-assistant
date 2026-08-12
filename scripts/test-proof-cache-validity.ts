/**
 * Cache validity: an entry authored under one enforcement state must not be replayed
 * under another (handoff §4, §13).
 *
 * WHAT THE CACHE HOLDS, AND WHY THAT MATTERS HERE. lib/response-cache stores the
 * model's SQL and pre-query explanation, not the answer. A hit skips the Claude call
 * and re-runs that SQL against live data, so the rows are always fresh and the result
 * travels the route's normal exit — which means cache hits already pass through proof
 * finalization. §13's "cache hits cannot bypass proof" is satisfied by the route
 * integration; what these tests cover is the second half, "enforcement/source-version
 * changes invalidate incompatible cache entries".
 *
 * THE HONEST CAVEAT, ASSERTED BELOW. The cache is per-process and in-memory, and
 * changing a proof mode requires a PM2 reload that clears it. So today this
 * invalidation cannot be reached by accident. It exists because that safety is a
 * property of the deployment mechanism rather than of the code, and it would disappear
 * silently the moment the cache moved to Redis or grew a longer TTL.
 */
import assert from "node:assert";
import { getCached, setCache } from "../lib/response-cache";
import { cacheValiditySignature, UNKNOWN_DATA_VERSION } from "../lib/proof-cache-validity";
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

console.log("\nthe signature carries mode and data version");
{
  check("off and shadow produce different signatures", () => {
    const off = cacheValiditySignature("current", null, {});
    const shadow = cacheValiditySignature("current", null, { PROOF_MODE: "shadow" });
    assert.notStrictEqual(off, shadow);
    assert.match(off, /m:off/);
    assert.match(shadow, /m:shadow/);
  });

  check("the proof schema version is part of it", () => {
    assert.match(cacheValiditySignature("current", null, {}), new RegExp(`^p${PROOF_SCHEMA_VERSION}\\|`));
  });

  check("an absent data version is recorded as unknown, not omitted", () => {
    // Omitting it would make the Stage 2 arrival of real versions a silent no-op for
    // entries cached beforehand.
    for (const version of [null, undefined, "", "   "]) {
      assert.match(cacheValiditySignature("current", version, {}), new RegExp(`d:${UNKNOWN_DATA_VERSION}$`));
    }
  });

  check("a real data version replaces the placeholder", () => {
    assert.match(cacheValiditySignature("current", "2026-08-10", {}), /d:2026-08-10$/);
  });

  check("the kill switch shows as off", () => {
    const killed = cacheValiditySignature("current", null, { PROOF_MODE: "shadow", PROOF_KILL_SWITCH: "1" });
    assert.match(killed, /m:off/);
  });

  check("per-source modes give per-source signatures", () => {
    const env = { PROOF_MODE: "shadow", PROOF_MODE_NIBRS: "off" };
    assert.match(cacheValiditySignature("current", null, env), /m:shadow/);
    assert.match(cacheValiditySignature("nibrs", null, env), /m:off/);
  });

  check("the signature is stable for identical inputs", () => {
    assert.strictEqual(
      cacheValiditySignature("shr", "v1", { PROOF_MODE: "shadow" }),
      cacheValiditySignature("shr", "v1", { PROOF_MODE: "shadow" }),
    );
  });
}

console.log("\nthe cache honours it");
{
  check("an entry stored under one signature is not served under another", () => {
    const off = cacheValiditySignature("current", null, {});
    const shadow = cacheValiditySignature("current", null, { PROOF_MODE: "shadow" });
    setCache("murders in Austin 2020", "current", ENTRY, off);
    assert.ok(getCached("murders in Austin 2020", "current", off), "same signature must hit");
    assert.strictEqual(
      getCached("murders in Austin 2020", "current", shadow),
      null,
      "a mode change must miss, not replay SQL authored under the old state",
    );
  });

  check("a source data version change invalidates", () => {
    const v1 = cacheValiditySignature("current", "2026-08-01", {});
    const v2 = cacheValiditySignature("current", "2026-09-01", {});
    setCache("murders in Dallas 2020", "current", ENTRY, v1);
    assert.ok(getCached("murders in Dallas 2020", "current", v1));
    assert.strictEqual(getCached("murders in Dallas 2020", "current", v2), null);
  });

  check("entries remain isolated by tab as before", () => {
    const sig = cacheValiditySignature("current", null, {});
    setCache("shared question", "current", ENTRY, sig);
    assert.ok(getCached("shared question", "current", sig));
    assert.strictEqual(getCached("shared question", "historical", sig), null);
  });

  check("question normalization still applies", () => {
    const sig = cacheValiditySignature("current", null, {});
    setCache("Murders  in Austin?", "current", ENTRY, sig);
    assert.ok(getCached("murders in austin", "current", sig), "case and punctuation must still normalize");
  });

  check("omitting the signature reproduces the pre-Stage-1 key exactly", () => {
    // This is what keeps `off` mode from changing cache behavior at all: a caller with
    // no proof context behaves byte-identically to the baseline release.
    setCache("legacy question", "current", ENTRY);
    assert.ok(getCached("legacy question", "current"), "unsignatured entries still round-trip");
    const sig = cacheValiditySignature("current", null, {});
    assert.strictEqual(
      getCached("legacy question", "current", sig),
      null,
      "and a signatured lookup does not collide with them",
    );
  });
}

console.log(`\ncache validity tests: ${passed} passed`);
if (process.exitCode) {
  console.log("cache validity tests: FAILED");
} else {
  console.log("cache validity tests: passed");
}
