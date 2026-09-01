/**
 * P3.1a — the frozen-case RUNNER. Authored and frozen here; execution is authorized separately.
 *
 * WHAT IT DOES. Executes the 63 frozen cases of `docs/superpowers/p3-1a/frozen-cases-v3.json`
 * against the request-decision observer and records, per case, what was observed versus what the
 * frozen set expects. It is the evidence run. The Tier F controls in
 * `scripts/test-request-decision-observer.ts` are NOT the evidence run and never write here.
 *
 * ── THE FIVE PROPERTIES IT IS BUILT AROUND ──────────────────────────────────────────────────
 *
 * 1. THE ORACLE IS IMMUTABLE. `frozen-cases-v3.json` is verified by sha256 before the run and
 *    again after it, and this file never opens it for writing. Observations go to a SEPARATE
 *    run artifact under `docs/superpowers/p3-1a/runs/`, named by run id, written once with a
 *    wx flag so a second run can never overwrite a first. An oracle a run can edit is not an
 *    oracle, and a result file that overwrites its predecessor destroys the disagreement it was
 *    meant to record.
 *
 * 2. EVERY CASE IS ACCOUNTED FOR EXACTLY ONCE. Each case begins as `not_run` and leaves that
 *    state only by being processed. The dispositions are disjoint and the run refuses to report a
 *    verdict unless they sum to the case count with zero `not_run`. A case that was never executed
 *    is never a passing case — the failure mode this rule exists to prevent is a silently skipped
 *    case reported as agreement.
 *
 * 3. THE PARSER IS RECORDED, NEVER TRUSTED AS THE ORACLE. The real `buildQueryContract` runs for
 *    every case, and its projection is compared against the case's independently frozen
 *    `expected_contract`. A disagreement is recorded in its OWN field and never rewrites the
 *    applicability comparison: the observation is always made against the frozen expected
 *    contract, so a parser regression shows up as a parser disagreement rather than silently
 *    moving the measured result.
 *
 * 4. FAILURE KINDS DO NOT COLLAPSE INTO EACH OTHER. `analysis_incomplete` (a predicate read
 *    ctx.sql/ctx.tables), `harness_error` (the runner itself threw) and `disagreed` (the system
 *    decided differently from the frozen expectation) are three different facts. Collapsing
 *    incomplete into `did_not_fire` would convert an unmeasurable case into a clean negative,
 *    which is the specific way a coverage claim becomes false.
 *
 * 5. THE ENGINE IS INJECTABLE, SO IT CAN BE MUTATION-TESTED. `executeFrozenCases` is pure and
 *    takes its observer and contract builder as arguments. `scripts/test-p3-1a-case-runner.ts`
 *    drives it with deliberately broken inputs to prove the accounting actually catches skipped
 *    cases, duplicate ids, substituted expectations, missing parser disagreements, and collapsed
 *    incompletes. Without that, the accounting would be an assertion about itself.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { observeRequestDecision } from "../lib/request-decision-observer";
import type { QueryContract, QueryContractSource } from "../lib/query-contract";

export const P31A_DIR = path.join(__dirname, "..", "docs", "superpowers", "p3-1a");
export const FROZEN_V3 = path.join(P31A_DIR, "frozen-cases-v3.json");
export const FROZEN_V3_SHA256 =
  "2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91";

export type Disposition =
  | "not_run"            // never processed - never a pass
  | "agreed"             // observation matched the frozen expectation in full
  | "disagreed"          // the system decided differently from the frozen expectation
  | "analysis_incomplete" // a predicate could not be evaluated pre-answer
  | "harness_error";     // the runner threw; a defect in the run, not a finding about the system

export type CaseResult = {
  id: string;
  pair: string;
  role: string;
  disposition: Disposition;
  /** What the observer produced. `null` only when the case never produced an observation. */
  observed: {
    inDenominator: boolean;
    state: string | null;
    action: string | null;
    reason: string | null;
  } | null;
  /** What the frozen set expects, echoed so the artifact is readable without the oracle. */
  expected: {
    applies: boolean;
    action: string | null;
    reason: string | null;
  };
  /** Recorded independently of `disposition`; NEVER allowed to rewrite it. */
  parserAgreement: "agreed" | "disagreed" | "not_applicable" | "parser_error";
  parserDetail: string | null;
  detail: string | null;
};

export type RunReport = {
  runId: string;
  frozenSetSha256: string;
  caseCount: number;
  counts: Record<Disposition, number>;
  parserCounts: Record<string, number>;
  /** `complete` only when every case was processed exactly once. Never a pass on its own. */
  accounting: "complete" | "incomplete";
  accountingDetail: string | null;
  results: CaseResult[];
};

const DISPOSITIONS: Disposition[] = [
  "not_run", "agreed", "disagreed", "analysis_incomplete", "harness_error",
];

/**
 * Decide whether a set of results may be reported at all.
 *
 * Exported and separate from the loop so the mutation suite can drive it with a result set that
 * contains a `not_run` case. Inside the current loop every non-duplicate case is processed, so a
 * `not_run` guard tested only through the loop would pass without ever being able to fail — which
 * is the "guard never observed failing" trap. Testing it directly keeps it honest.
 */
export function accountFor(
  list: CaseResult[], entryCount: number, duplicates: string[],
): { accounting: "complete" | "incomplete"; accountingDetail: string | null } {
  const counts = Object.fromEntries(DISPOSITIONS.map((d) => [d, 0])) as Record<Disposition, number>;
  for (const r of list) counts[r.disposition]++;

  const problems: string[] = [];
  if (duplicates.length) problems.push(`duplicate case ids: ${[...new Set(duplicates)].join(", ")}`);
  if (list.length !== entryCount) {
    problems.push(`processed ${list.length} distinct cases from ${entryCount} entries`);
  }
  if (counts.not_run > 0) problems.push(`${counts.not_run} case(s) were never executed`);
  const summed = DISPOSITIONS.reduce((n, d) => n + counts[d], 0);
  if (summed !== list.length) problems.push(`dispositions sum to ${summed}, not ${list.length}`);

  return {
    accounting: problems.length === 0 ? "complete" : "incomplete",
    accountingDetail: problems.length ? problems.join("; ") : null,
  };
}

/** Apply a case's frozen dotted-path projection onto a complete hand-specified contract shell. */
export function projectFrozenContract(
  shell: QueryContract, source: string, projection: Record<string, unknown> | null,
): QueryContract {
  const out: any = JSON.parse(JSON.stringify(shell));
  out.source = source;
  if (projection) {
    for (const [k, v] of Object.entries(projection)) {
      const parts = k.split(".");
      let cur = out;
      while (parts.length > 1) cur = cur[parts.shift() as string];
      cur[parts[0]] = v;
    }
  }
  return out as QueryContract;
}

/**
 * Execute the frozen cases. Pure: no file IO, no clock, no production. Everything it touches
 * arrives as an argument, which is what lets the mutation suite break it on purpose.
 */
export function executeFrozenCases(opts: {
  cases: any[];
  /** Returns the observation for one case. Injected so the mutation suite can misbehave. */
  observe: (c: any) => {
    inDenominator: boolean;
    state: string | null;
    action: string | null;
    reason: string | null;
  };
  /** The REAL parser in a live run. Returns its own contract projection, or throws. */
  buildContract: (c: any) => Record<string, unknown> | null;
}): Omit<RunReport, "runId" | "frozenSetSha256"> {
  const { cases, observe, buildContract } = opts;

  // Every case starts unaccounted for. Nothing may reach a verdict without leaving this map.
  const results = new Map<string, CaseResult>();
  const duplicates: string[] = [];

  for (const c of cases) {
    if (results.has(c.id)) { duplicates.push(c.id); continue; }
    results.set(c.id, {
      id: c.id, pair: c.pair, role: c.role,
      disposition: "not_run",
      observed: null,
      expected: {
        applies: c.expected_outcome?.applies === true,
        action: c.expected_outcome?.action ?? null,
        reason: c.expected_outcome?.reason ?? null,
      },
      parserAgreement: "not_applicable",
      parserDetail: null,
      detail: null,
    });
  }

  for (const c of cases) {
    const r = results.get(c.id);
    if (!r || r.disposition !== "not_run") continue; // a duplicate never overwrites a result

    // (a) the parser runs for every case, and is recorded on its own axis
    try {
      const parsed = buildContract(c);
      if (!c.expected_contract) {
        r.parserAgreement = "not_applicable";
      } else if (parsed === null) {
        r.parserAgreement = "disagreed";
        r.parserDetail = "parser produced no contract for a case with a frozen projection";
      } else {
        const disagreements: string[] = [];
        for (const [k, v] of Object.entries(c.expected_contract)) {
          let cur: any = parsed;
          for (const part of k.split(".")) cur = cur?.[part];
          if (JSON.stringify(cur) !== JSON.stringify(v)) {
            disagreements.push(`${k}: parser=${JSON.stringify(cur)} frozen=${JSON.stringify(v)}`);
          }
        }
        r.parserAgreement = disagreements.length === 0 ? "agreed" : "disagreed";
        r.parserDetail = disagreements.length ? disagreements.join("; ") : null;
      }
    } catch (err) {
      r.parserAgreement = "parser_error";
      r.parserDetail = err instanceof Error ? err.message : String(err);
    }

    // (b) the observation is ALWAYS made against the frozen expected contract, never the parser's
    try {
      const obs = observe(c);
      r.observed = obs;

      if (obs.state === "analysis_incomplete") {
        // Never folded into did_not_fire: an unmeasurable case is not a clean negative.
        r.disposition = "analysis_incomplete";
        r.detail = "predicate could not be evaluated before SQL exists";
        continue;
      }

      const observedApplies = obs.inDenominator && obs.state === "fired";
      const mismatches: string[] = [];
      if (observedApplies !== r.expected.applies) {
        mismatches.push(`applicability: observed=${observedApplies} expected=${r.expected.applies}`);
      }
      if (r.expected.applies) {
        if (obs.action !== r.expected.action) {
          mismatches.push(`action: observed=${obs.action} expected=${r.expected.action}`);
        }
        if (obs.reason !== r.expected.reason) {
          mismatches.push(`reason: observed=${obs.reason} expected=${r.expected.reason}`);
        }
      } else if (obs.action !== null || obs.reason !== null) {
        mismatches.push(`a non-applying case carried a typed pair: ${obs.action}/${obs.reason}`);
      }

      r.disposition = mismatches.length === 0 ? "agreed" : "disagreed";
      r.detail = mismatches.length ? mismatches.join("; ") : null;
    } catch (err) {
      r.disposition = "harness_error";
      r.detail = err instanceof Error ? err.message : String(err);
    }
  }

  const list = [...results.values()];
  const counts = Object.fromEntries(DISPOSITIONS.map((d) => [d, 0])) as Record<Disposition, number>;
  for (const r of list) counts[r.disposition]++;
  const parserCounts: Record<string, number> = {};
  for (const r of list) parserCounts[r.parserAgreement] = (parserCounts[r.parserAgreement] ?? 0) + 1;

  const acct = accountFor(list, cases.length, duplicates);

  return {
    caseCount: cases.length,
    counts,
    parserCounts,
    accounting: acct.accounting,
    accountingDetail: acct.accountingDetail,
    results: list,
  };
}

/** The complete hand-specified contract shell. Never produced by the parser. */
export const CONTRACT_SHELL = {
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
} as unknown as QueryContract;

/** The live observation used by a real run: the production observer, one case at a time. */
export function liveObserve(c: any) {
  const contract = projectFrozenContract(CONTRACT_SHELL, c.source, c.expected_contract ?? null);
  const result = observeRequestDecision({
    question: c.question,
    source: c.source as QueryContractSource,
    contract,
    enabled: true,
  });
  const rec = result.records.find((x) => x.ruleId === c.rule_id);
  return {
    inDenominator: result.denominator.includes(c.rule_id),
    state: rec?.state ?? null,
    action: rec?.outcome?.action ?? null,
    reason: rec?.outcome?.reason ?? null,
  };
}

const sha256Of = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/**
 * CLI entry. Verifies the oracle before and after, runs, then writes ONE immutable artifact.
 * Requires --run to execute, so importing this module can never start an evidence run.
 */
async function main() {
  if (!process.argv.includes("--run")) {
    console.log("p3-1a frozen-case runner. Execution requires --run and its own authorization.");
    console.log(`  oracle: ${FROZEN_V3}`);
    console.log(`  pinned: ${FROZEN_V3_SHA256}`);
    process.exit(0);
  }

  const before = sha256Of(FROZEN_V3);
  if (before !== FROZEN_V3_SHA256) {
    console.error(`REFUSING: frozen set sha256 is ${before}, expected ${FROZEN_V3_SHA256}`);
    process.exit(2);
  }
  const frozen = JSON.parse(fs.readFileSync(FROZEN_V3, "utf8"));

  const { buildQueryContract } = await import("../lib/query-contract");
  const report = executeFrozenCases({
    cases: frozen.cases,
    observe: liveObserve,
    // Positional (question, source), matching the production declaration at
    // lib/query-contract.ts:280. It returns QueryContract | null; null is recorded as a parser
    // disagreement for any case carrying a frozen projection, never as silence.
    buildContract: (c) =>
      buildQueryContract(c.question, c.source as QueryContractSource) as Record<string, unknown> | null,
  });

  const after = sha256Of(FROZEN_V3);
  if (after !== before) {
    console.error(`REFUSING TO REPORT: the frozen set changed during the run (${before} -> ${after})`);
    process.exit(2);
  }

  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  const full: RunReport = { runId, frozenSetSha256: after, ...report };
  const runsDir = path.join(P31A_DIR, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const out = path.join(runsDir, `run-${runId}.json`);
  // wx: a run never overwrites an earlier run's evidence.
  fs.writeFileSync(out, JSON.stringify(full, null, 2) + "\n", { flag: "wx" });

  console.log(`run ${runId} -> ${out}`);
  console.log(`  frozen set: ${after} (unchanged before and after)`);
  console.log(`  accounting: ${full.accounting}${full.accountingDetail ? " - " + full.accountingDetail : ""}`);
  for (const d of DISPOSITIONS) console.log(`  ${d.padEnd(20)} ${full.counts[d]}`);
  console.log(`  parser: ${JSON.stringify(full.parserCounts)}`);
  process.exit(full.accounting === "complete" ? 0 : 1);
}

if (require.main === module) void main();
