/**
 * P3.1a — Tier F controls for the request-decision observer.
 *
 * Proves the properties the stage-placement ruling requires BEFORE any frozen case is executed:
 * production reuse, SQL independence, mutation coupling, structural exclusion, denominator
 * integrity, and flags-off equivalence.
 *
 * Deterministic. No database, no model, no network, no production. Builds no contract from a
 * parser - every contract here is hand-specified from the schema, so the parser is never its own
 * oracle.
 */
import { SOURCE_CAPABILITY_RULES, validateSourceCapabilities } from "../lib/source-capabilities";
import { observeRequestDecision, isSqlDependent } from "../lib/request-decision-observer";
import type { QueryContract, QueryContractSource } from "../lib/query-contract";

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`); }
}
function checkTrue(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "\n          " + detail : ""}`); }
}

/**
 * A hand-specified contract, complete against the QueryContract SCHEMA.
 *
 * Complete rather than minimal because C3 exercises the FULL validator, which evaluates every rule
 * for the source - including SQL/table-dependent ones the observer excludes. Those read fields the
 * observer never touches (`comparability.continuousReporters`, `time`, `geographies`), and a
 * partial fixture made the validator throw. That was the fixture being inadequate, not a finding.
 *
 * Every value is written here by hand from the type declaration. `buildQueryContract` is never
 * called, so the parser is never its own oracle.
 */
function contractOf(over: Record<string, unknown> = {}): QueryContract {
  const base = {
    source: "current",
    geography: { kind: "city", name: "Chicago", state: "IL" },
    geographies: [{ kind: "city", name: "Chicago", state: "IL" }],
    metric: {
      topic: "murder", offenseCodes: [], offenses: [],
      unit: "count", numerator: null, denominator: null, unsupportedReason: null,
    },
    time: { startYear: 2026, endYear: 2026, partialYear: false, returnedPeriodRequired: false },
    breakdowns: [] as string[],
    comparability: { continuousReporters: false, partialYearDisclosure: false },
    followup: { isFollowup: false, operation: null },
    warnings: [] as string[],
  };
  const out: any = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(over)) {
    const parts = k.split(".");
    let cur = out;
    while (parts.length > 1) cur = cur[parts.shift() as string];
    cur[parts[0]] = v;
  }
  return out as QueryContract;
}

const SOURCES: QueryContractSource[] = ["current", "historical", "nibrs", "shr", "hate_crime"];

// ── C1 — the observer evaluates the EXACT production rule objects ───────────────────────────
console.log("C1 — production reuse");
{
  const ids = new Set<string>();
  for (const s of SOURCES) {
    for (const id of observeRequestDecision({ question: "x", source: s, contract: contractOf(), enabled: true }).denominator) {
      ids.add(id);
    }
  }
  const declared = new Set(
    SOURCE_CAPABILITY_RULES.filter((r) => !isSqlDependent(r)).map((r) => r.id),
  );
  check("C1  the observed denominator is exactly the SQL-independent production rule set",
    [...ids].sort(), [...declared].sort());
  check("C1b nine definitions", ids.size, 9);
  const pairs = SOURCES.reduce((n, s) =>
    n + observeRequestDecision({ question: "x", source: s, contract: contractOf(), enabled: true }).denominator.length, 0);
  check("C1c twenty-one applicability pairs", pairs, 21);
}

// ── C2 — SQL independence, proved two ways ──────────────────────────────────────────────────
console.log("\nC2 — SQL independence");
{
  // (a) The observer's context makes ctx.sql/ctx.tables throw. If a selected predicate read
  //     either, it would be recorded analysis_incomplete rather than returning a value.
  let incomplete = 0;
  for (const s of SOURCES) {
    const r = observeRequestDecision({ question: "how many murders in Chicago in June 2026?", source: s, contract: contractOf(), enabled: true });
    incomplete += r.records.filter((x) => x.state === "analysis_incomplete").length;
  }
  check("C2  no selected predicate reads ctx.sql or ctx.tables", incomplete, 0);

  // (b) The same rule objects, evaluated directly with two MATERIALLY DIFFERENT SQL inputs,
  //     produce identical results. This is the ruling's explicit control.
  const sqlA = "SELECT COUNT(*) FROM summary_state_monthly WHERE state='IL'";
  const sqlB = "WITH x AS (SELECT 1) SELECT murders, robberies FROM historical_agency_clearance JOIN x";
  let compared = 0, differed = 0;
  for (const s of SOURCES) {
    for (const rule of SOURCE_CAPABILITY_RULES) {
      if (rule.source !== s || isSqlDependent(rule)) continue;
      const mk = (sql: string) => ({ question: "how many murders in Chicago in June 2026?", source: s, contract: contractOf(), sql, tables: new Set<string>() });
      const a = rule.when(mk(sqlA) as any);
      const b = rule.when(mk(sqlB) as any);
      compared++;
      if (a !== b) differed++;
    }
  }
  check("C2b all 21 pairs give identical results under two materially different SQL inputs",
    [compared, differed], [21, 0]);
}

// ── C3 — mutation coupling: one predicate, both paths ───────────────────────────────────────
console.log("\nC3 — mutation coupling");
{
  const rule = SOURCE_CAPABILITY_RULES.find((r) => r.id === "nibrs-shooting-category-unsupported")!;
  const original = rule.when;
  const q = "how many shootings were there in Phoenix, AZ in 2022?";
  const contract = contractOf({ "metric.topic": "aggravated_assault" });

  const observeFired = () =>
    observeRequestDecision({ question: q, source: "nibrs", contract, enabled: true })
      .records.find((r) => r.ruleId === rule.id)!.state === "fired";
  const validatorFired = () =>
    validateSourceCapabilities({ question: q, source: "nibrs", contract, sql: "SELECT 1 FROM summary_state_monthly" })
      .some((f: any) => f.id === rule.id || f.ruleId === rule.id);

  const beforeObs = observeFired(), beforeVal = validatorFired();
  check("C3  before mutation both paths agree the rule fires", [beforeObs, beforeVal], [true, true]);

  try {
    // Mutate the UNDERLYING production predicate that both paths share.
    (rule as any).when = () => false;
    const afterObs = observeFired(), afterVal = validatorFired();
    check("C3b mutating the shared predicate flips BOTH paths", [afterObs, afterVal], [false, false]);
    checkTrue("C3c so the observer cannot be a private copy of the predicate",
      beforeObs !== afterObs && beforeVal !== afterVal);
  } finally {
    (rule as any).when = original;
  }
  check("C3d the predicate is restored", observeFired(), true);
}

// ── C4 — structural exclusion of SQL/table-dependent rules ──────────────────────────────────
console.log("\nC4 — structural exclusion");
{
  const excludedIds = new Set<string>();
  for (const s of SOURCES) {
    for (const e of observeRequestDecision({ question: "x", source: s, contract: contractOf(), enabled: true }).excluded) {
      excludedIds.add(e.ruleId);
    }
  }
  const declaredDependent = SOURCE_CAPABILITY_RULES.filter((r) => isSqlDependent(r));
  check("C4  every SQL/table-dependent rule is excluded, none evaluated",
    excludedIds.size, new Set(declaredDependent.map((r) => r.id)).size);
  check("C4b thirty dependent definitions excluded", excludedIds.size, 30);

  // A rule that gains a SQL/table declaration must leave the denominator.
  const victim = SOURCE_CAPABILITY_RULES.find((r) => r.id === "shr-non-homicide-unsupported")!;
  const before = observeRequestDecision({ question: "x", source: "shr", contract: contractOf(), enabled: true }).denominator.includes(victim.id);
  (victim as any).requiresAnyTables = ["shr_incidents"];
  const after = observeRequestDecision({ question: "x", source: "shr", contract: contractOf(), enabled: true }).denominator.includes(victim.id);
  delete (victim as any).requiresAnyTables;
  const restored = observeRequestDecision({ question: "x", source: "shr", contract: contractOf(), enabled: true }).denominator.includes(victim.id);
  check("C4c adding a table dependency removes a rule from the pre-answer denominator",
    [before, after, restored], [true, false, true]);
}

// ── C5 — denominator integrity: nothing enters silently ─────────────────────────────────────
console.log("\nC5 — denominator integrity");
{
  const FROZEN_NINE = [
    "demographic-rate-unsupported", "nibrs-clearance-weapon-unsupported",
    "nibrs-countywide-demographics-unsupported", "nibrs-shooting-category-unsupported",
    "shr-clearance-unsupported", "shr-demographic-rate-unsupported",
    "shr-non-homicide-unsupported", "unsupported-court-policy-topic",
    "unsupported-sub-city-geography",
  ];
  const seen = new Set<string>();
  for (const s of SOURCES) {
    for (const id of observeRequestDecision({ question: "x", source: s, contract: contractOf(), enabled: true }).denominator) seen.add(id);
  }
  check("C5  the denominator is exactly the frozen nine", [...seen].sort(), FROZEN_NINE);

  // Source filtering must precede evaluation, in production order.
  const shrOnly = observeRequestDecision({ question: "how many robberies in Los Angeles, CA in 2021?", source: "current", contract: contractOf(), enabled: true });
  checkTrue("C5b a shr-only rule is never evaluated for a current request",
    !shrOnly.denominator.includes("shr-non-homicide-unsupported") &&
    !shrOnly.records.some((r) => r.ruleId === "shr-non-homicide-unsupported"));
}

// ── C6 — flags-off equivalence ──────────────────────────────────────────────────────────────
console.log("\nC6 — flags-off equivalence");
{
  const off = observeRequestDecision({ question: "how many shootings in Phoenix?", source: "nibrs", contract: contractOf() });
  check("C6  disabled by default: no records, no denominator, no exclusions",
    [off.enabled, off.records.length, off.denominator.length, off.excluded.length], [false, 0, 0, 0]);
  const explicitOff = observeRequestDecision({ question: "x", source: "nibrs", contract: contractOf(), enabled: false });
  check("C6b explicitly disabled behaves identically", explicitOff, off);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
