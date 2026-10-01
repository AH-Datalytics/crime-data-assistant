/**
 * FAIL-CLOSED identity gate for the fixed-group offline verification.
 *
 * Extracted so the gate itself is exercised by tests rather than described in prose. A review found
 * the previous verification's gate could be skipped: each expected hash defaulted to an empty
 * string and the comparison was `if (expected && expected !== actual)`, so a missing expectation
 * silently passed, and `candidate_identities_gated` used `.some(...)` — one supplied expectation
 * reported a five-file gate as complete.
 *
 * The rule here is the opposite: EVERY required identity must have a well-formed expectation and
 * must match, or the run refuses before any query. Missing, malformed and mismatching are all
 * refusals, and each is distinguishable in the reason.
 */

/** A 64-character lowercase hex SHA-256. Anything else is malformed, not merely unequal. */
const SHA256 = /^[0-9a-f]{64}$/;

export type GateOutcome =
  | { ok: true; compared: { path: string; sha256: string }[] }
  | { ok: false; reason: string; kind: "missing" | "malformed" | "mismatch" | "empty_expectations"; path?: string };

/**
 * Compare every required path against its expectation.
 *
 * `expected` is the immutable expected-identity input; `actual` reads the file on disk. Both are
 * injected so a test can exercise this without touching the repository or a database.
 */
export function gateIdentities(
  requiredPaths: string[],
  expected: Record<string, unknown>,
  actual: (path: string) => string,
): GateOutcome {
  if (requiredPaths.length === 0) {
    return { ok: false, kind: "empty_expectations", reason: "no required identities were declared" };
  }

  const compared: { path: string; sha256: string }[] = [];
  for (const path of requiredPaths) {
    const want = expected[path];
    if (want === undefined || want === null || want === "") {
      return { ok: false, kind: "missing", path, reason: `no expected identity declared for ${path}` };
    }
    if (typeof want !== "string" || !SHA256.test(want)) {
      return {
        ok: false, kind: "malformed", path,
        reason: `the expected identity for ${path} is not a 64-character lowercase hex sha256`,
      };
    }
    const got = actual(path);
    if (!SHA256.test(got)) {
      return { ok: false, kind: "malformed", path, reason: `the computed identity for ${path} is not a sha256` };
    }
    if (got !== want) {
      return { ok: false, kind: "mismatch", path, reason: `${path} is ${got}, expected ${want}` };
    }
    compared.push({ path, sha256: got });
  }
  return { ok: true, compared };
}

/** Every identity this verification requires. Extra expectations are ignored; none of these may be. */
export const REQUIRED_IDENTITIES = [
  "crime_data.db",
  "docs/superpowers/2026-09-06-correctness-gold-set-v7.json",
  "lib/current-yoy-comparison-deterministic.ts",
  "lib/period-comparison.ts",
  "lib/query-timeout.ts",
  "lib/query-worker.js",
  "app/api/query/route.ts",
];
