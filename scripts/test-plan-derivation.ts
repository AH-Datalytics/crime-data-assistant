/**
 * The plan-derivation token: what it proves, and what it must refuse to prove.
 *
 * This module exists because checkSemanticPlan() previously took a
 * `deterministic: boolean` from the route and combined it with an independently
 * parsed question contract. Nothing connected the plan to the SQL, so the check
 * asserted "compiled from a validated typed plan" on a caller's word — the exact
 * shape of unfounded claim the verified-answer contract exists to remove.
 *
 * The concrete failure it catches: four separate paths in app/api/query/route.ts can
 * replace `sql` AFTER a deterministic planner produced it — the guardrail
 * auto-rewrite, the schema-column corrector, the table-allowlist retry, and the
 * rolling-12-month retry. An answer whose SQL was rewritten downstream is no longer
 * deterministically derived, and a boolean could not notice.
 */
import assert from "node:assert";
import {
  sealPlanDerivation,
  verifyPlanDerivation,
  fingerprintSql,
  PLAN_DERIVATION_VERSION,
} from "../lib/plan-derivation";

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

const SQL = "SELECT year, agency, SUM(count) AS murders FROM agency_monthly WHERE agency = 'Baton Rouge' GROUP BY year";

console.log("\nsealing and verifying");
{
  check("a sealed token verifies against its own SQL", () => {
    const verdict = verifyPlanDerivation(sealPlanDerivation("current-agency-trend", SQL), SQL);
    assert.strictEqual(verdict.ok, true);
    assert.match(verdict.reason, /matches plan family 'current-agency-trend'/);
  });

  check("the token carries the current version and family", () => {
    const derivation = sealPlanDerivation("f", SQL);
    assert.strictEqual(derivation.v, PLAN_DERIVATION_VERSION);
    assert.strictEqual(derivation.planFamily, "f");
    assert.ok(derivation.sqlFingerprint.length > 0);
  });

  check("the fingerprint is stable across calls", () => {
    assert.strictEqual(fingerprintSql(SQL), fingerprintSql(SQL));
  });

  check("the fingerprint is bounded, not the whole statement", () => {
    // Stored inside a bounded proof envelope, so it must not scale with SQL length.
    const long = "SELECT " + "x".repeat(50_000);
    assert.strictEqual(fingerprintSql(long).length, 32);
  });
}

console.log("\nrefusals: no token, no claim");
{
  check("null yields a refusal, not a pass", () => {
    const verdict = verifyPlanDerivation(null, SQL);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.reason, /no deterministic plan derivation was sealed/);
  });

  check("undefined yields a refusal", () => {
    assert.strictEqual(verifyPlanDerivation(undefined, SQL).ok, false);
  });

  check("a token with no plan family is refused", () => {
    const derivation = { ...sealPlanDerivation("f", SQL), planFamily: "" };
    const verdict = verifyPlanDerivation(derivation, SQL);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.reason, /no plan family/);
  });

  check("a whitespace-only plan family is refused", () => {
    const derivation = { ...sealPlanDerivation("f", SQL), planFamily: "   " };
    assert.strictEqual(verifyPlanDerivation(derivation, SQL).ok, false);
  });

  check("a stale token version is refused", () => {
    const derivation = { ...sealPlanDerivation("f", SQL), v: PLAN_DERIVATION_VERSION + 1 };
    const verdict = verifyPlanDerivation(derivation, SQL);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.reason, /version/);
  });

  check("no executed SQL is refused rather than assumed", () => {
    // A deterministic metadata answer with no SQL is not wrong, but it is not a SQL
    // derivation either, so it cannot satisfy this check.
    for (const sql of [null, "", "   "]) {
      const verdict = verifyPlanDerivation(sealPlanDerivation("f", SQL), sql);
      assert.strictEqual(verdict.ok, false, `sql=${JSON.stringify(sql)} should be refused`);
      assert.match(verdict.reason, /no SQL was executed/);
    }
  });
}

console.log("\nthe rewrite cases this exists to catch");
{
  const derivation = sealPlanDerivation("current-agency-trend", SQL);

  check("a changed table is caught", () => {
    // The guardrail auto-rewrite's most common action.
    const verdict = verifyPlanDerivation(derivation, SQL.replace("agency_monthly", "state_monthly"));
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.reason, /rewritten between planning and execution/);
    assert.match(verdict.reason, /plan [0-9a-f]{32}, executed [0-9a-f]{32}/);
  });

  check("a changed column is caught", () => {
    // What the schema-column corrector does.
    assert.strictEqual(verifyPlanDerivation(derivation, SQL.replace("SUM(count)", "SUM(total)")).ok, false);
  });

  check("an added filter is caught", () => {
    assert.strictEqual(verifyPlanDerivation(derivation, SQL + " HAVING SUM(count) > 0").ok, false);
  });

  check("a changed string literal is caught", () => {
    assert.strictEqual(verifyPlanDerivation(derivation, SQL.replace("Baton Rouge", "New Orleans")).ok, false);
  });

  check("LETTER CASE in a literal is caught, deliberately", () => {
    // SQLite string comparison is case-sensitive by default, so state = 'la' and
    // state = 'LA' are different queries against this data. Normalizing case here
    // would hide a real change.
    const cased = sealPlanDerivation("f", "SELECT 1 FROM t WHERE state = 'LA'");
    assert.strictEqual(verifyPlanDerivation(cased, "SELECT 1 FROM t WHERE state = 'la'").ok, false);
  });

  check("a rolling-window rewrite is caught", () => {
    // The sparse-monthly retry replaces the measure with a window function.
    const rolling = SQL.replace(
      "SUM(count) AS murders",
      "SUM(count) OVER (ORDER BY year ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS murders",
    );
    assert.strictEqual(verifyPlanDerivation(derivation, rolling).ok, false);
  });
}

console.log("\nharmless reformatting is not treated as tampering");
{
  const derivation = sealPlanDerivation("f", SQL);

  check("collapsed whitespace still verifies", () => {
    assert.strictEqual(verifyPlanDerivation(derivation, SQL.replace(/ /g, "   ")).ok, true);
  });

  check("newlines and indentation still verify", () => {
    assert.strictEqual(verifyPlanDerivation(derivation, SQL.replace(/ /g, "\n  ")).ok, true);
  });

  check("leading and trailing whitespace still verifies", () => {
    assert.strictEqual(verifyPlanDerivation(derivation, `\n  ${SQL}  \n`).ok, true);
  });

  check("tabs still verify", () => {
    assert.strictEqual(verifyPlanDerivation(derivation, SQL.replace(/ /g, "\t")).ok, true);
  });
}

console.log("\nnever throws");
{
  check("malformed tokens degrade rather than throw", () => {
    for (const bad of [{}, { v: 1 }, { planFamily: "f" }, { v: "x", planFamily: 1, sqlFingerprint: null }]) {
      assert.doesNotThrow(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const verdict = verifyPlanDerivation(bad as any, SQL);
        assert.strictEqual(verdict.ok, false);
      });
    }
  });

  check("sealing an empty family or empty SQL does not throw", () => {
    assert.doesNotThrow(() => sealPlanDerivation("", ""));
    assert.strictEqual(verifyPlanDerivation(sealPlanDerivation("", ""), "").ok, false);
  });
}

console.log(`\nplan derivation tests: ${passed} passed`);
if (process.exitCode) {
  console.log("plan derivation tests: FAILED");
} else {
  console.log("plan derivation tests: passed");
}
