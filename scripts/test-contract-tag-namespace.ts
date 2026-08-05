/**
 * Regression tests for contract-tag resolution and year-range parsing.
 *
 * These exist because of a 2026-08-05 audit finding: 102 delivered answers
 * carried a bare `contract-year-lower-bound-missing` / `-upper-bound-missing`
 * tag, which reads as "this answer shipped violating its contract". They were
 * all pre-Fix-3 (0a88cc5) rows -- nothing suffixed those tags before that commit
 * -- and the SQL satisfied the contract in every case.
 *
 * The property that makes Fix 3 correct is subtle and was untested: the two
 * contract-tag namespaces are DISJOINT. `queryContractGuardrails` (which feeds
 * finalizeGuardrailTags' `finalContractTags`) emits only validator-side tags,
 * while the year-bound tags come from guardrails.ts. If a year-bound tag ever
 * appeared on the validator side, finalizeGuardrailTags would start leaving it
 * bare again and the old defect would silently return.
 */
import assert from "node:assert";
import { buildQueryContract } from "../lib/query-contract";
import { validateQueryContractSql, queryContractGuardrails } from "../lib/query-contract-validator";
import { finalizeGuardrailTags } from "../lib/guardrail-tag-state";
import { extractQueryContext } from "../lib/query-context";
import { runGuardrails } from "../lib/guardrails";

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

const YEAR_BOUND_TAGS = ["contract-year-lower-bound-missing", "contract-year-upper-bound-missing"];

console.log("\n1. Stale-tag resolution: year-bound tags always finalize as resolved");
{
  // The validator cannot emit year-bound tags, so a year-bound tag carried over
  // from an earlier attempt must always come out suffixed.
  check("a carried-over lower-bound tag is suffixed -resolved-on-retry", () => {
    const out = finalizeGuardrailTags(["contract-year-lower-bound-missing"], []);
    assert.deepStrictEqual(out, ["contract-year-lower-bound-missing-resolved-on-retry"]);
  });

  check("a validator-side tag still present stays bare", () => {
    const out = finalizeGuardrailTags(["contract-state-code-alias"], ["contract-state-code-alias"]);
    assert.deepStrictEqual(out, ["contract-state-code-alias"]);
  });

  check("non-contract tags pass through untouched", () => {
    const out = finalizeGuardrailTags(["geo-typo-corrected", "contract-year-range-missing"], []);
    assert.ok(out.includes("geo-typo-corrected"), `got ${out.join(",")}`);
    assert.ok(out.includes("contract-year-range-missing-resolved-on-retry"), `got ${out.join(",")}`);
  });

  check("an already-suffixed tag is not double-suffixed", () => {
    const out = finalizeGuardrailTags(["contract-year-lower-bound-missing-resolved-on-retry"], []);
    assert.deepStrictEqual(out, ["contract-year-lower-bound-missing-resolved-on-retry"]);
  });

  // THE load-bearing invariant. If this fails, Fix 3 stops working.
  check("namespaces are disjoint: validator never emits a year-bound tag", () => {
    const probes: Array<{ question: string; source: string; sql: string }> = [
      { question: "murders in Houston since 2010", source: "historical", sql: "SELECT year FROM historical_agency_crime WHERE year >= 2010" },
      { question: "murders in Houston since 2010", source: "historical", sql: "SELECT year FROM historical_agency_crime" },
      { question: "violent crime from 2015 to 2020", source: "current", sql: "SELECT year FROM agency_monthly" },
      { question: "Go back to 1976", source: "shr", sql: "SELECT year FROM incidents WHERE year >= 1976" },
    ];
    for (const probe of probes) {
      const result = validateQueryContractSql({ question: probe.question, source: probe.source as never, sql: probe.sql });
      const emitted = queryContractGuardrails(result);
      for (const tag of YEAR_BOUND_TAGS) {
        assert.ok(
          !emitted.includes(tag),
          `validator emitted ${tag} for "${probe.question}" -- namespaces are no longer disjoint, so finalizeGuardrailTags will leave it bare`
        );
      }
    }
  });
}

console.log("\n2. Genuine missing bounds still fire (guardrails.ts side, unchanged)");
{
  // Guarding against a fix that silences real violations. The recursive-year
  // protection in guardrails.ts is deliberately NOT touched by this work.
  check("recursive year seed is accepted as a lower bound", () => {
    const contract = buildQueryContract("murders in Houston since 2010", "historical" as never);
    assert.ok(contract, "contract should build");
    assert.strictEqual(contract!.time.startYear, 2010);
  });

  check("open-ended phrasing does not collapse to a single-year contract", () => {
    for (const question of ["murders in Houston since 2010", "crime trends from 2010", "violent crime over time since 2010"]) {
      const contract = buildQueryContract(question, "historical" as never);
      assert.ok(contract, `contract should build for "${question}"`);
      const sql = "SELECT year, murder FROM historical_agency_crime WHERE year >= 2010 AND year <= 2025";
      const result = validateQueryContractSql({ question, source: "historical" as never, sql });
      assert.ok(
        !queryContractGuardrails(result).includes("contract-single-year-temporal-scope"),
        `"${question}" was treated as a single-year request`
      );
    }
  });
}

console.log("\n3. Malformed / degenerate contract ranges");
{
  check("'back to YYYY' is open-ended, not a single-year request", () => {
    // Production row 5493: "Go back to 1976" produced startYear=endYear=1976 and
    // was treated as a point-in-time request, so a multi-year SQL answer looked
    // like a contract violation. "back to" means extend the range backwards.
    const question = "Go back to 1976";
    const sql = "SELECT i.year, COUNT(*) FROM incidents i WHERE i.year >= 1976 AND i.year <= 2025 GROUP BY i.year";
    const result = validateQueryContractSql({ question, source: "shr" as never, sql });
    const emitted = queryContractGuardrails(result);
    assert.ok(
      !emitted.includes("contract-single-year-temporal-scope"),
      `"${question}" treated as single-year; emitted: ${emitted.join(", ") || "(none)"}`
    );
  });

  check("a true single-year request is still treated as single-year", () => {
    const question = "murders in Houston in 2022";
    const sql = "SELECT year, murder FROM historical_agency_crime WHERE year >= 2010 AND year <= 2025";
    const result = validateQueryContractSql({ question, source: "historical" as never, sql });
    assert.ok(
      queryContractGuardrails(result).includes("contract-single-year-temporal-scope"),
      `broad SQL for a single-year question should still be flagged; emitted: ${queryContractGuardrails(result).join(", ") || "(none)"}`
    );
  });

  check("'back to YYYY' is not parsed as an END year (guardrails.ts side)", () => {
    // This is where row 5493 actually went wrong. requestedEndYear's pattern
    // /(?:through|thru|until|to)\s+(YYYY)/ matches the "to 1976" inside "Go back
    // to 1976" and treats it as an upper bound. The SQL correctly covered
    // 1976-2025, so contract-year-upper-bound-missing fired and triggered a
    // retry whose [SYSTEM:] message would have told the model to add
    // `year <= 1976` -- i.e. to answer with 1976 alone.
    const ctx = extractQueryContext(
      "SELECT i.year, COUNT(*) FROM incidents i WHERE i.year >= 1976 AND i.year <= 2025 GROUP BY i.year",
      "Go back to 1976",
      "shr" as never
    );
    const fired: string[] = (runGuardrails(ctx) as { fired?: string[] }).fired ?? [];
    assert.ok(
      !fired.includes("contract-year-upper-bound-missing"),
      `"Go back to 1976" parsed as ending in 1976; fired: ${fired.filter((t) => t.startsWith("contract-")).join(", ") || "(none)"}`
    );
  });

  check("a real 'through YYYY' end year is still enforced", () => {
    const ctx = extractQueryContext(
      "SELECT i.year, COUNT(*) FROM incidents i WHERE i.year >= 1990 GROUP BY i.year",
      "murders from 1990 through 2000",
      "shr" as never
    );
    const fired: string[] = (runGuardrails(ctx) as { fired?: string[] }).fired ?? [];
    assert.ok(
      fired.includes("contract-year-upper-bound-missing"),
      `SQL with no upper bound for "through 2000" should still flag; fired: ${fired.filter((t) => t.startsWith("contract-")).join(", ") || "(none)"}`
    );
  });

  check("endYear before startYear does not crash the validator", () => {
    const result = validateQueryContractSql({
      question: "crime from 2020 to 2010",
      source: "historical" as never,
      sql: "SELECT year FROM historical_agency_crime WHERE year BETWEEN 2010 AND 2020",
    });
    assert.ok(Array.isArray(queryContractGuardrails(result)));
  });
}

console.log(`\n${process.exitCode ? "FAILURES present." : `All ${passed} contract-tag namespace checks passed.`}`);
