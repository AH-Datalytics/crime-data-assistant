/**
 * P3.1a — Tier F controls for the request-decision observer.
 *
 * Proves, BEFORE any evidence run, the properties the stage-placement ruling and candidate review
 * round 1 require: production reuse, ONE shared typed decision authority, BASE parity for the
 * extracted classification, SQL independence exercised on the FROZEN triggering and negative
 * boundaries of every pair, mutation coupling across ALL 21 applicability pairs, structural
 * exclusion, denominator integrity, and flags-off equivalence.
 *
 * THIS IS NOT THE EVIDENCE RUN, AND THE DISTINCTION IS THE POINT.
 * It never calls `buildQueryContract`, never writes an observation to any artifact, and never
 * compares expected-versus-observed applicability. It reads the frozen questions and the frozen
 * EXPECTED contract projections purely as control INPUTS, because a single generic question cannot
 * reach a conditional branch only a triggering input reaches — an independence proof run solely on
 * inputs that never trigger anything proves nothing. Executing the case set as evidence is
 * `scripts/run-p3-1a-frozen-cases.ts`, which is authorized separately.
 *
 * Deterministic. No database, no model, no network, no production.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SOURCE_CAPABILITY_RULES, validateSourceCapabilities } from "../lib/source-capabilities";
import { observeRequestDecision, isSqlDependent } from "../lib/request-decision-observer";
import {
  BLOCK_CAPABILITY_RULES, RETRY_CAPABILITY_RULES, classifyCapabilityRule,
} from "../lib/capability-decision";
import { OUTCOMES } from "../lib/proof-contract";
import { CONTRACT_SHELL, projectFrozenContract } from "./run-p3-1a-frozen-cases";
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
 * The contract shell and its dotted-path projection come from the RUNNER, not from a second copy
 * here. Two hand-written shells that are supposed to be the same shell are the same drift class
 * this candidate exists to remove: they would agree today and diverge the first time one is edited,
 * and every control below would still pass while measuring a different fixture than the run does.
 *
 * The shell is complete against the QueryContract type declaration rather than minimal, because the
 * mutation control exercises the FULL validator, which evaluates SQL/table-dependent rules reading
 * fields the observer never touches. `buildQueryContract` is never called, so the parser is never
 * its own oracle.
 */
function contractOf(over: Record<string, unknown> = {}): QueryContract {
  const { source, ...rest } = over as { source?: string };
  return projectFrozenContract(
    CONTRACT_SHELL,
    (source as string) ?? "current",
    Object.keys(rest).length ? (rest as Record<string, unknown>) : null,
  );
}

const SOURCES: QueryContractSource[] = ["current", "historical", "nibrs", "shr", "hate_crime"];

// ── the frozen oracle, read only ────────────────────────────────────────────────────────────
const P31A = path.join(__dirname, "..", "docs", "superpowers", "p3-1a");
const V3_PATH = path.join(P31A, "frozen-cases-v3.json");
const V3_SHA = "2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91";
const v3Bytes = fs.readFileSync(V3_PATH);
const v3: any = JSON.parse(v3Bytes.toString("utf8"));

/** The control contract for a frozen case, from that case's OWN frozen expected projection. */
function contractForCase(c: any): QueryContract {
  // Exactly what the runner will project for this case - the same function, the same shell.
  return projectFrozenContract(CONTRACT_SHELL, c.source, c.expected_contract ?? null);
}
const ruleFor = (id: string, source: string) =>
  SOURCE_CAPABILITY_RULES.find((r) => r.id === id && r.source === source)!;

const sqlIndependentIds = [...new Set(
  SOURCE_CAPABILITY_RULES.filter((r) => !isSqlDependent(r)).map((r) => r.id),
)].sort();

// ── C1 — the observer evaluates the EXACT production rule objects ───────────────────────────
console.log("C1 — production reuse");
{
  const ids = new Set<string>();
  let pairs = 0;
  for (const s of SOURCES) {
    const d = observeRequestDecision({ question: "x", source: s, contract: contractOf(), enabled: true }).denominator;
    d.forEach((id) => ids.add(id));
    pairs += d.length;
  }
  check("C1  the denominator is exactly the SQL-independent production rule set",
    [...ids].sort(), sqlIndependentIds);
  check("C1b nine definitions across twenty-one applicability pairs", [ids.size, pairs], [9, 21]);
}

// ── C2 — ONE shared typed decision authority ────────────────────────────────────────────────
console.log("\nC2 — shared typed decision authority");
{
  check("C2  the block set is exactly the nine question-only definitions",
    [...BLOCK_CAPABILITY_RULES].sort(), sqlIndependentIds);
  checkTrue("C2b block and retry sets are disjoint",
    [...BLOCK_CAPABILITY_RULES].every((id) => !RETRY_CAPABILITY_RULES.has(id)));

  const fired = observeRequestDecision({
    question: "How many robberies were reported in Los Angeles, CA in 2021?",
    source: "shr", contract: contractOf({ source: "shr" }), enabled: true,
  }).records.find((x) => x.ruleId === "shr-non-homicide-unsupported")!;
  check("C2c a fired block rule carries the shared catalog outcome",
    [fired.state, fired.classification, fired.outcome],
    ["fired", "block", OUTCOMES.query_contract_failed]);
  checkTrue("C2d it is the catalog OBJECT, not a locally re-authored pair",
    (fired.outcome as unknown) === (OUTCOMES.query_contract_failed as unknown));

  const notFired = observeRequestDecision({
    question: "How many homicides were reported in Los Angeles, CA in 2021?",
    source: "shr", contract: contractOf({ source: "shr" }), enabled: true,
  }).records.find((x) => x.ruleId === "shr-non-homicide-unsupported")!;
  check("C2e a rule that does not fire carries NO action/reason pair",
    [notFired.state, notFired.outcome], ["did_not_fire", null]);
}

// ── C3 — BASE parity for the extracted classification ───────────────────────────────────────
console.log("\nC3 — BASE parity of the extracted authority");
{
  // Membership captured from the BASE tree before the extraction. If the file is absent the sizes
  // are still pinned, so this control can never silently degrade to asserting nothing.
  const basePath = path.join(__dirname, "..", "docs", "superpowers", "p3-1a", "base-capability-sets.json");
  if (fs.existsSync(basePath)) {
    const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
    check("C3  block membership identical to BASE", [...BLOCK_CAPABILITY_RULES], base.block);
    check("C3b retry membership identical to BASE", [...RETRY_CAPABILITY_RULES], base.retry);
  } else {
    fail++; console.log("  FAIL  C3  BASE membership snapshot missing; parity cannot be asserted");
  }
  check("C3c sizes unchanged from BASE",
    [BLOCK_CAPABILITY_RULES.size, RETRY_CAPABILITY_RULES.size], [9, 28]);
  check("C3d branch order: block wins",
    classifyCapabilityRule("shr-non-homicide-unsupported").kind, "block");
  check("C3e a retry rule classifies as retry",
    classifyCapabilityRule("historical-clearance-table").kind, "retry");
  check("C3f an unknown rule is observe_only, never a block by default",
    classifyCapabilityRule("no-such-rule").kind, "observe_only");
}

// ── C4 — SQL independence on the FROZEN triggering and negative boundaries ──────────────────
console.log("\nC4 — SQL independence on frozen boundaries");
{
  checkTrue("C4  the frozen v3 oracle is present and byte-identical",
    crypto.createHash("sha256").update(v3Bytes).digest("hex") === V3_SHA);

  const sqlA = "SELECT COUNT(*) FROM summary_state_monthly WHERE state='IL'";
  const sqlB = "WITH x AS (SELECT 1) SELECT murders, robberies FROM historical_agency_clearance JOIN x";
  let evaluated = 0, differed = 0, incomplete = 0, projected = 0;
  const pairsSeen = new Set<string>(), rolesSeen = new Set<string>();
  const diffs: string[] = [];

  for (const c of v3.cases) {
    const rule = ruleFor(c.rule_id, c.source);
    const contract = contractForCase(c);
    pairsSeen.add(c.pair); rolesSeen.add(c.role);
    if (c.expected_contract) projected++;

    // (a) throwing context — a hidden ctx.sql / ctx.tables read becomes analysis_incomplete
    const rec = observeRequestDecision({ question: c.question, source: c.source, contract, enabled: true })
      .records.find((x) => x.ruleId === c.rule_id);
    if (rec?.state === "analysis_incomplete") incomplete++;

    // (b) the same production rule object under two materially different SQL inputs
    const withSql = (sql: string) =>
      ({ question: c.question, source: c.source, contract, sql, tables: new Set<string>() });
    if (rule.when(withSql(sqlA) as any) !== rule.when(withSql(sqlB) as any)) {
      differed++; diffs.push(c.id + " " + c.pair);
    }
    evaluated++;
  }

  check("C4b every frozen case exercised across both SQL inputs", evaluated, v3.cases.length);
  check("C4c all 21 pairs and all three roles covered",
    [pairsSeen.size, [...rolesSeen].sort()],
    [21, ["false_acceptance", "false_refusal", "positive"]]);
  check("C4d the 27 contract-dependent cases used their frozen projections", projected, 27);
  checkTrue("C4e no SQL-dependent difference on any frozen input", differed === 0, diffs.slice(0, 3).join(" | "));
  check("C4f no analysis_incomplete on any frozen input", incomplete, 0);
}

// ── C5 — mutation coupling across ALL 21 applicability pairs ────────────────────────────────
console.log("\nC5 — mutation coupling, all 21 pairs");
{
  const positives = v3.cases.filter((c: any) => c.role === "positive");
  let coupled = 0, outcomeMoved = 0, restored = 0, sourcePinned = 0, isolated = 0;
  const failures: string[] = [];
  const otherFor = (s: string) => SOURCES.find((x) => x !== s)!;

  for (const c of positives) {
    const rule = ruleFor(c.rule_id, c.source);
    const contract = contractForCase(c);
    const original = rule.when;
    if (rule.source === c.source) sourcePinned++;

    const observe = () => {
      const r = observeRequestDecision({ question: c.question, source: c.source, contract, enabled: true })
        .records.find((x) => x.ruleId === c.rule_id);
      return { fired: r?.state === "fired", outcome: r?.outcome ?? null };
    };
    const validated = () =>
      validateSourceCapabilities({
        question: c.question, source: c.source, contract,
        sql: "SELECT 1 FROM summary_state_monthly",
      }).some((f: any) => f.id === c.rule_id || f.ruleId === c.rule_id);

    // An unrelated source's full observation, to prove the mutation is not global.
    const other = otherFor(c.source);
    const otherBefore = JSON.stringify(observeRequestDecision({
      question: c.question, source: other, contract: contractOf({ source: other }), enabled: true,
    }));

    const beforeObs = observe(), beforeVal = validated();
    let afterObs = { fired: true, outcome: null as unknown }, afterVal = true, otherAfter = "";
    try {
      (rule as any).when = () => false;   // mutate the SHARED production predicate
      afterObs = observe(); afterVal = validated();
      otherAfter = JSON.stringify(observeRequestDecision({
        question: c.question, source: other, contract: contractOf({ source: other }), enabled: true,
      }));
    } finally {
      (rule as any).when = original;
    }

    if (beforeObs.fired && beforeVal && !afterObs.fired && !afterVal) coupled++;
    else failures.push(`${c.id} ${c.pair}: before(obs=${beforeObs.fired},val=${beforeVal}) after(obs=${afterObs.fired},val=${afterVal})`);
    if (beforeObs.outcome !== null && afterObs.outcome === null) outcomeMoved++;
    if (otherBefore === otherAfter) isolated++;
    // reference identity, stronger than a source-text comparison, plus behavioural restoration
    if (rule.when === original && observe().fired === beforeObs.fired) restored++;
  }

  check("C5  twenty-one distinct pairs mutated", new Set(positives.map((c: any) => c.pair)).size, 21);
  checkTrue("C5b every positive fires through BOTH paths before mutation and both flip after",
    coupled === positives.length, failures.slice(0, 3).join(" | "));
  check("C5c the typed outcome moves with the decision on every pair", outcomeMoved, positives.length);
  check("C5d each mutated rule carried its frozen source identity", sourcePinned, positives.length);
  check("C5e mutating one rule changes nothing for an inapplicable source", isolated, positives.length);
  check("C5f every predicate restored by reference identity and behaviour", restored, positives.length);
}

// ── C6 — structural exclusion ───────────────────────────────────────────────────────────────
console.log("\nC6 — structural exclusion");
{
  const excluded = new Set<string>();
  for (const s of SOURCES) {
    observeRequestDecision({ question: "x", source: s, contract: contractOf(), enabled: true })
      .excluded.forEach((e) => excluded.add(e.ruleId));
  }
  check("C6  every SQL/table-dependent definition is excluded, none evaluated",
    excluded.size, new Set(SOURCE_CAPABILITY_RULES.filter((r) => isSqlDependent(r)).map((r) => r.id)).size);
  check("C6b thirty dependent definitions", excluded.size, 30);

  const victim = ruleFor("shr-non-homicide-unsupported", "shr");
  const inDenom = () => observeRequestDecision({
    question: "x", source: "shr", contract: contractOf({ source: "shr" }), enabled: true,
  }).denominator.includes(victim.id);
  const before = inDenom();
  (victim as any).requiresAnyTables = ["shr_incidents"];
  const after = inDenom();
  delete (victim as any).requiresAnyTables;
  check("C6c gaining a table dependency removes a rule from the pre-answer denominator",
    [before, after, inDenom()], [true, false, true]);
}

// ── C7 — denominator integrity and production source order ──────────────────────────────────
console.log("\nC7 — denominator integrity");
{
  const seen = new Set<string>();
  for (const s of SOURCES) {
    observeRequestDecision({ question: "x", source: s, contract: contractOf(), enabled: true })
      .denominator.forEach((id) => seen.add(id));
  }
  check("C7  the denominator is exactly the shared block set",
    [...seen].sort(), [...BLOCK_CAPABILITY_RULES].sort());
  const cur = observeRequestDecision({
    question: "How many robberies were reported in Los Angeles, CA in 2021?",
    source: "current", contract: contractOf(), enabled: true,
  });
  checkTrue("C7b a shr-only rule is never evaluated for a current request",
    !cur.denominator.includes("shr-non-homicide-unsupported") &&
    !cur.records.some((r) => r.ruleId === "shr-non-homicide-unsupported"));
}

// ── C8 — flags-off equivalence ──────────────────────────────────────────────────────────────
console.log("\nC8 — flags-off equivalence");
{
  const off = observeRequestDecision({
    question: "how many shootings in Phoenix?", source: "nibrs", contract: contractOf({ source: "nibrs" }),
  });
  check("C8  disabled by default: nothing observed",
    [off.enabled, off.records.length, off.denominator.length, off.excluded.length], [false, 0, 0, 0]);
  check("C8b explicit disable is identical",
    observeRequestDecision({ question: "x", source: "nibrs", contract: contractOf({ source: "nibrs" }), enabled: false }),
    off);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
