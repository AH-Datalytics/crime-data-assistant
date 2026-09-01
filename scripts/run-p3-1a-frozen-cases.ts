/**
 * P3.1a — the frozen-case RUNNER. Authored and frozen here; the evidence run is authorized
 * separately and has not occurred.
 *
 * WHAT IT DOES. Executes a declared case set against the request-decision observer and records, per
 * case, what was observed versus what the set expects. In `--run` mode the case set is the governing
 * `docs/superpowers/p3-1a/frozen-cases-v3.json` and the result is evidence. In `--smoke` mode the
 * case set is a small synthetic file and the result is explicitly NOT evidence. Both modes run the
 * SAME orchestration; only the input path, its expected hash, the output directory and the run kind
 * are parameterized. A second smoke-only implementation would prove the smoke path works and say
 * nothing about the path that produces evidence.
 *
 * ── FOUR SEPARATE QUESTIONS, FOUR SEPARATE ANSWERS ──────────────────────────────────────────
 *
 * Round 2 found these collapsed into one another. They are now distinct, per case and per run:
 *
 *   1. PARSER AGREEMENT — did the real `buildQueryContract` reproduce the case's independently
 *      frozen contract projection? Recorded on its own axis, and a divergence STOPS the run: the
 *      frozen projections are what the observation is made against, so if production's parser no
 *      longer agrees with them, the premise of the measurement is gone and continuing would produce
 *      a confident number about a stale assumption.
 *   2. PREDICATE AGREEMENT — did the observed applicability/action/reason match what the case
 *      expects? `agreed | disagreed | analysis_incomplete | harness_error | not_run`, never
 *      collapsed: an unmeasurable case is not a clean negative, and a runner defect is not a
 *      finding about the system.
 *   3. CASE VERDICT — the two above combined into one unambiguous per-case answer:
 *      `conformant | nonconformant | not_established`. A case cannot be conformant while its parser
 *      axis disagrees.
 *   4. RUN VERDICTS — `accountingVerdict` says whether the RUN is trustworthy (every case
 *      accounted for exactly once); `evidenceVerdict` says whether the SYSTEM conformed. A complete
 *      run of a nonconforming system is a successful run reporting a failure, and the exit code
 *      says so rather than reporting zero.
 *
 * ── EXIT CODES ──────────────────────────────────────────────────────────────────────────────
 *
 *   0  accounting complete AND evidence conformant
 *   1  the run is trustworthy but the evidence is not conformant or not established
 *      (parser divergence, any disagreement, any incomplete analysis, any harness error)
 *   2  refused before running, or the accounting itself is incomplete - a defect in the RUN
 *
 * ── IMMUTABILITY ────────────────────────────────────────────────────────────────────────────
 *
 * The case set is verified by sha256 before the run and again after, and is never opened for
 * writing. Results go to a separate artifact written with the `wx` flag, so no run can overwrite an
 * earlier run's evidence. `--smoke` refuses any input that resolves to v1/v2/v3 by path or by hash,
 * and refuses to write inside the evidence directory. `--run` refuses unless the governing v3
 * identity is exact.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { observeRequestDecision } from "../lib/request-decision-observer";
import type { QueryContract, QueryContractSource } from "../lib/query-contract";

export const ROOT = path.join(__dirname, "..");
export const P31A_DIR = path.join(ROOT, "docs", "superpowers", "p3-1a");
export const EVIDENCE_RUNS_DIR = path.join(P31A_DIR, "runs");
export const FROZEN_V3 = path.join(P31A_DIR, "frozen-cases-v3.json");

/** Every frozen set, pinned. All three are verified before and after every run, in both modes. */
export const FROZEN_SETS: Record<string, string> = {
  "frozen-cases-v1.json": "2a2739cc9dcab7872537d6c22880d70ee5ec0e012362d2c6fb47f8346d69cc78",
  "frozen-cases-v2.json": "7114d95c6c3a84c7da1f8e786915825436994085dfcc924477e26924203f391f",
  "frozen-cases-v3.json": "2535cbd934a4766a7f9ff8570f5b0e60d04b7c37430283b48e52b206c75a0b91",
};
export const FROZEN_V3_SHA256 = FROZEN_SETS["frozen-cases-v3.json"];

export type PredicateAgreement =
  | "not_run"
  | "agreed"
  | "disagreed"
  | "analysis_incomplete"
  | "harness_error";

export type ParserAgreement = "agreed" | "disagreed" | "not_applicable" | "parser_error";

/**
 * Whether the parser phase actually VISITED this case - independent of what it concluded.
 *
 * Round 3 found the escape this closes. `parserAgreement: "not_applicable"` is both a legitimate
 * final state (a case with no frozen projection) and the initial value before parsing. So a skipped
 * parser iteration was indistinguishable from a case that was parsed and had nothing to compare -
 * and if some other case diverged, the run entered `stopped_parser_divergence`, where the only
 * accounting rule was "every predicate is not_run". A skipped case sailed through.
 *
 * Execution and conclusion are therefore separate axes. This one answers "was it processed", which
 * is the question accounting needs and the one `parserAgreement` cannot answer.
 */
export type ParserExecution = "not_run" | "completed" | "error";

export type CaseVerdict = "conformant" | "nonconformant" | "not_established";

export type RunState = "completed" | "stopped_parser_divergence";

export type CaseResult = {
  id: string;
  pair: string;
  role: string;
  /** Did the observed decision match the frozen expectation? Never mixed with the parser axis. */
  predicateAgreement: PredicateAgreement;
  /** Did the real parser reproduce the frozen projection? Never mixed with the predicate axis. */
  parserAgreement: ParserAgreement;
  /** Was this case visited by the parser phase at all? Not the same question as the line above. */
  parserExecution: ParserExecution;
  /** The single unambiguous answer for this case, derived from both axes. */
  caseVerdict: CaseVerdict;
  observed: {
    inDenominator: boolean;
    state: string | null;
    action: string | null;
    reason: string | null;
  } | null;
  expected: { applies: boolean; action: string | null; reason: string | null };
  parserDetail: string | null;
  predicateDetail: string | null;
};

export type RunReport = {
  runKind: "evidence" | "synthetic_smoke_not_evidence";
  runId: string;
  runState: RunState;
  provenance: {
    candidateCommit: string | null;
    candidateTree: string | null;
    worktreeClean: boolean | null;
    runnerPath: string;
    runnerSha256: string;
    inputPath: string;
    inputSha256: string;
    frozenSetsBefore: Record<string, string>;
    frozenSetsAfter: Record<string, string> | null;
    node: string;
    startedAt: string;
  };
  caseCount: number;
  predicateCounts: Record<PredicateAgreement, number>;
  parserCounts: Record<string, number>;
  parserExecutionCounts: Record<ParserExecution, number>;
  /** How many times the parser phase visited each case id. Every value must be exactly 1. */
  parserVisits: Record<string, number>;
  verdictCounts: Record<CaseVerdict, number>;
  accountingVerdict: "complete" | "incomplete";
  accountingDetail: string | null;
  evidenceVerdict: CaseVerdict;
  evidenceDetail: string | null;
  results: CaseResult[];
};

const PREDICATE_STATES: PredicateAgreement[] = [
  "not_run", "agreed", "disagreed", "analysis_incomplete", "harness_error",
];
const VERDICTS: CaseVerdict[] = ["conformant", "nonconformant", "not_established"];
const PARSER_EXECUTIONS: ParserExecution[] = ["not_run", "completed", "error"];

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
 * The single unambiguous per-case answer.
 *
 * A parser divergence can never leave a case conformant — that was the round-2 finding. An
 * unmeasurable or un-run case is `not_established`, which is neither a pass nor a system failure.
 */
export function deriveCaseVerdict(
  predicate: PredicateAgreement, parser: ParserAgreement,
): CaseVerdict {
  if (parser === "disagreed" || parser === "parser_error") return "nonconformant";
  if (predicate === "disagreed") return "nonconformant";
  if (predicate === "agreed") return "conformant";
  return "not_established"; // not_run, analysis_incomplete, harness_error
}

/**
 * Decide whether a set of results may be reported at all.
 *
 * Exported and separate from the loop so the mutation suite can drive it with a result set that
 * contains a `not_run` case. Inside the loop every non-duplicate case is processed, so a `not_run`
 * guard tested only through the loop would pass without ever being able to fail.
 *
 * A deliberate stop is not a defect: when the run stopped on parser divergence, the requirement
 * inverts — EVERY case must be `not_run`, because a half-processed set would mean the stop did not
 * actually stop anything.
 */
export function accountFor(opts: {
  list: CaseResult[];
  entryCount: number;
  duplicates: string[];
  runState: RunState;
  /** Visits per case id recorded by the parser phase. Every entry must be exactly 1. */
  parserVisits: Record<string, number>;
}): { accountingVerdict: "complete" | "incomplete"; accountingDetail: string | null } {
  const { list, entryCount, duplicates, runState, parserVisits } = opts;
  const counts = Object.fromEntries(PREDICATE_STATES.map((d) => [d, 0])) as Record<PredicateAgreement, number>;
  for (const r of list) counts[r.predicateAgreement]++;
  const execCounts = Object.fromEntries(PARSER_EXECUTIONS.map((d) => [d, 0])) as Record<ParserExecution, number>;
  for (const r of list) execCounts[r.parserExecution]++;

  const problems: string[] = [];
  if (duplicates.length) problems.push(`duplicate case ids: ${[...new Set(duplicates)].join(", ")}`);
  if (list.length !== entryCount) {
    problems.push(`processed ${list.length} distinct cases from ${entryCount} entries`);
  }

  // ── the parser phase is accounted for on its own, in EVERY run state ─────────────────────
  // A skipped parser case is a defect whether the run finished or stopped. Checking it only in the
  // stopped branch would leave a completed run able to hide one.
  if (execCounts.not_run > 0) {
    problems.push(`${execCounts.not_run} case(s) were never parser-processed`);
  }
  const execSummed = PARSER_EXECUTIONS.reduce((n, d) => n + execCounts[d], 0);
  if (execSummed !== list.length) {
    problems.push(`parser execution states sum to ${execSummed}, not ${list.length}`);
  }
  const ids = new Set(list.map((r) => r.id));
  const badVisits = Object.entries(parserVisits).filter(([, n]) => n !== 1);
  if (badVisits.length) {
    problems.push(
      `parser visited ${badVisits.map(([id, n]) => `${id} x${n}`).join(", ")}; ` +
      "each case must be visited exactly once");
  }
  const unledgered = [...ids].filter((id) => !(id in parserVisits));
  if (unledgered.length) problems.push(`no parser visit recorded for: ${unledgered.join(", ")}`);
  const strayLedger = Object.keys(parserVisits).filter((id) => !ids.has(id));
  if (strayLedger.length) {
    problems.push(`parser visits recorded for unknown case(s): ${strayLedger.join(", ")}`);
  }

  // ── the predicate phase, whose rule inverts after a deliberate stop ───────────────────────
  if (runState === "completed") {
    if (counts.not_run > 0) problems.push(`${counts.not_run} case(s) were never executed`);
  } else {
    if (counts.not_run !== list.length) {
      problems.push(
        `run stopped on parser divergence but ${list.length - counts.not_run} case(s) were executed anyway`);
    }
    // A stop must be EXPLAINED. Without this, a fabricated `stopped_parser_divergence` with no
    // divergence anywhere would satisfy "every predicate is not_run" and account as complete -
    // reporting a clean stop over a run that simply never did its work.
    const diverged = list.filter(
      (r) => r.parserAgreement === "disagreed" || r.parserAgreement === "parser_error").length;
    if (diverged === 0) {
      problems.push("run state is stopped_parser_divergence but no parser divergence was recorded");
    }
  }
  const summed = PREDICATE_STATES.reduce((n, d) => n + counts[d], 0);
  if (summed !== list.length) problems.push(`predicate states sum to ${summed}, not ${list.length}`);

  return {
    accountingVerdict: problems.length === 0 ? "complete" : "incomplete",
    accountingDetail: problems.length ? problems.join("; ") : null,
  };
}

/**
 * Execute a case set. Pure: no file IO, no clock, no git, no production. Everything it touches
 * arrives as an argument, which is what lets the mutation suite break it on purpose.
 *
 * Two phases, deliberately. The parser runs for EVERY case first; only if none diverged are
 * predicates evaluated. Stopping at the first divergence would hide how widespread the divergence
 * is, and continuing past one would report conformance against projections production no longer
 * produces.
 */
export function executeFrozenCases(opts: {
  cases: any[];
  observe: (c: any) => {
    inDenominator: boolean;
    state: string | null;
    action: string | null;
    reason: string | null;
  };
  buildContract: (c: any) => Record<string, unknown> | null;
}): Omit<RunReport, "runKind" | "runId" | "provenance"> {
  const { cases, observe, buildContract } = opts;

  const results = new Map<string, CaseResult>();
  const duplicates: string[] = [];
  for (const c of cases) {
    if (results.has(c.id)) { duplicates.push(c.id); continue; }
    results.set(c.id, {
      id: c.id, pair: c.pair, role: c.role,
      predicateAgreement: "not_run",
      parserAgreement: "not_applicable",
      parserExecution: "not_run",
      caseVerdict: "not_established",
      observed: null,
      expected: {
        applies: c.expected_outcome?.applies === true,
        action: c.expected_outcome?.action ?? null,
        reason: c.expected_outcome?.reason ?? null,
      },
      parserDetail: null,
      predicateDetail: null,
    });
  }

  // ── phase 1: the parser, for every case, recorded on its own axis ──────────────────────────
  //
  // The visit ledger is kept separately from the conclusion. `parserAgreement` cannot tell a
  // skipped case from a legitimately not-applicable one, because "not_applicable" is both the
  // initial value and a valid result; the ledger and `parserExecution` can.
  const parserVisits: Record<string, number> = {};
  for (const c of cases) {
    const r = results.get(c.id);
    // A duplicate entry is already a defect via `duplicates`; it must not be parsed twice.
    if (!r || r.parserExecution !== "not_run") continue;
    parserVisits[c.id] = (parserVisits[c.id] ?? 0) + 1;
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
      r.parserExecution = "error";
      r.parserDetail = err instanceof Error ? err.message : String(err);
      continue;
    }
    r.parserExecution = "completed";
  }

  const diverged = [...results.values()].filter(
    (r) => r.parserAgreement === "disagreed" || r.parserAgreement === "parser_error");
  const runState: RunState = diverged.length ? "stopped_parser_divergence" : "completed";

  // ── phase 2: the predicates - only if the parser premise still holds ───────────────────────
  if (runState === "completed") {
    for (const c of cases) {
      const r = results.get(c.id);
      if (!r || r.predicateAgreement !== "not_run") continue;
      try {
        const obs = observe(c);
        r.observed = obs;

        if (obs.state === "analysis_incomplete") {
          r.predicateAgreement = "analysis_incomplete";
          r.predicateDetail = "predicate could not be evaluated before SQL exists";
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

        r.predicateAgreement = mismatches.length === 0 ? "agreed" : "disagreed";
        r.predicateDetail = mismatches.length ? mismatches.join("; ") : null;
      } catch (err) {
        r.predicateAgreement = "harness_error";
        r.predicateDetail = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const list = [...results.values()];
  for (const r of list) r.caseVerdict = deriveCaseVerdict(r.predicateAgreement, r.parserAgreement);

  const predicateCounts = Object.fromEntries(PREDICATE_STATES.map((d) => [d, 0])) as Record<PredicateAgreement, number>;
  for (const r of list) predicateCounts[r.predicateAgreement]++;
  const parserCounts: Record<string, number> = {};
  for (const r of list) parserCounts[r.parserAgreement] = (parserCounts[r.parserAgreement] ?? 0) + 1;
  const verdictCounts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<CaseVerdict, number>;
  for (const r of list) verdictCounts[r.caseVerdict]++;

  const execCounts = Object.fromEntries(PARSER_EXECUTIONS.map((d) => [d, 0])) as Record<ParserExecution, number>;
  for (const r of list) execCounts[r.parserExecution]++;

  const acct = accountFor({ list, entryCount: cases.length, duplicates, runState, parserVisits });

  let evidenceVerdict: CaseVerdict;
  let evidenceDetail: string | null = null;
  if (verdictCounts.nonconformant > 0) {
    evidenceVerdict = "nonconformant";
    evidenceDetail = runState === "stopped_parser_divergence"
      ? `run stopped: ${diverged.length} case(s) diverged from their frozen contract projection`
      : `${verdictCounts.nonconformant} case(s) did not conform`;
  } else if (verdictCounts.not_established > 0 || acct.accountingVerdict === "incomplete") {
    evidenceVerdict = "not_established";
    evidenceDetail = `${verdictCounts.not_established} case(s) could not be established`;
  } else {
    evidenceVerdict = "conformant";
  }

  return {
    runState,
    caseCount: cases.length,
    predicateCounts,
    parserCounts,
    parserExecutionCounts: execCounts,
    parserVisits,
    verdictCounts,
    accountingVerdict: acct.accountingVerdict,
    accountingDetail: acct.accountingDetail,
    evidenceVerdict,
    evidenceDetail,
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

export const sha256Of = (p: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** All three frozen sets, digested. Used before and after every run in both modes. */
export function digestFrozenSets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(FROZEN_SETS)) out[name] = sha256Of(path.join(P31A_DIR, name));
  return out;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

class Refusal extends Error {}
const refuse = (msg: string): never => { throw new Refusal(msg); };

/**
 * CLI. One orchestration, two kinds.
 *
 * `--run` produces evidence from the governing v3 set. `--smoke` produces a labelled non-evidence
 * artifact from a synthetic set, to exercise this exact code path before the real run happens.
 */
async function main() {
  const wantsRun = process.argv.includes("--run");
  const smokeInput = arg("--smoke");

  if (!wantsRun && !smokeInput) {
    console.log("p3-1a case runner. Nothing runs without --run or --smoke.");
    console.log(`  evidence oracle : ${FROZEN_V3}`);
    console.log(`  pinned          : ${FROZEN_V3_SHA256}`);
    console.log("  --run    --candidate <sha> --tree <sha> --runner-sha <sha>");
    console.log("  --smoke <input.json> --expect-hash <sha> --out <dir> --runner-sha <sha>");
    process.exit(0);
  }
  if (wantsRun && smokeInput) refuse("--run and --smoke are mutually exclusive");

  const runKind = wantsRun ? "evidence" : "synthetic_smoke_not_evidence";
  const startedAt = new Date().toISOString();

  // ── identity gate: the runner itself ──────────────────────────────────────────────────────
  const runnerPath = path.join(__dirname, path.basename(__filename));
  const runnerSha = sha256Of(runnerPath);
  const expectedRunnerSha = arg("--runner-sha");
  if (!expectedRunnerSha) refuse("--runner-sha is required: the runner must be pinned by whoever authorized the run");
  if (expectedRunnerSha !== runnerSha) {
    refuse(`runner identity mismatch: file is ${runnerSha}, authorization named ${expectedRunnerSha}`);
  }

  // ── identity gate: the candidate ──────────────────────────────────────────────────────────
  let candidateCommit: string | null = null;
  let candidateTree: string | null = null;
  let worktreeClean: boolean | null = null;
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  try {
    candidateCommit = git(["rev-parse", "HEAD"]);
    candidateTree = git(["rev-parse", "HEAD^{tree}"]);
    worktreeClean = git(["status", "--porcelain"]).length === 0;
  } catch {
    candidateCommit = candidateTree = null;
    worktreeClean = null;
  }

  if (wantsRun) {
    // Evidence must be attributable to an exact, clean, authorized tree. A smoke run is not
    // evidence, so it records what it saw instead of refusing on a dirty development checkout -
    // and the refusal path itself is exercised by a negative control.
    const expectedCommit = arg("--candidate");
    const expectedTree = arg("--tree");
    if (!expectedCommit || !expectedTree) {
      refuse("--run requires --candidate <sha> and --tree <sha>; evidence must name the tree that produced it");
    }
    if (candidateCommit === null) refuse("--run requires a git checkout to attribute the evidence to");
    if (candidateCommit !== expectedCommit) {
      refuse(`candidate mismatch: HEAD is ${candidateCommit}, authorization named ${expectedCommit}`);
    }
    if (candidateTree !== expectedTree) {
      refuse(`tree mismatch: HEAD tree is ${candidateTree}, authorization named ${expectedTree}`);
    }
    if (!worktreeClean) refuse("--run requires a clean worktree; evidence from a dirty checkout is unattributable");
  }

  // ── identity gate: the input ──────────────────────────────────────────────────────────────
  const inputPath = wantsRun ? FROZEN_V3 : path.resolve(smokeInput!);
  if (!fs.existsSync(inputPath)) refuse(`input not found: ${inputPath}`);
  const inputSha = sha256Of(inputPath);

  if (wantsRun) {
    if (inputSha !== FROZEN_V3_SHA256) {
      refuse(`governing set sha256 is ${inputSha}, expected ${FROZEN_V3_SHA256}`);
    }
  } else {
    const expectHash = arg("--expect-hash");
    if (!expectHash) refuse("--smoke requires --expect-hash");
    if (expectHash !== inputSha) {
      refuse(`smoke input sha256 is ${inputSha}, authorization named ${expectHash}`);
    }
    // A smoke run must never read a frozen set, by path or by content.
    if (path.resolve(inputPath).startsWith(path.resolve(P31A_DIR) + path.sep) &&
        Object.keys(FROZEN_SETS).includes(path.basename(inputPath))) {
      refuse("--smoke refuses a frozen case set as input");
    }
    if (Object.values(FROZEN_SETS).includes(inputSha)) {
      refuse("--smoke refuses input whose content is a frozen case set");
    }
  }

  const outDir = wantsRun ? EVIDENCE_RUNS_DIR : (arg("--out") ?? refuse("--smoke requires --out <dir>"));
  if (!wantsRun) {
    const resolvedOut = path.resolve(outDir as string);
    if (resolvedOut === path.resolve(EVIDENCE_RUNS_DIR) ||
        resolvedOut.startsWith(path.resolve(EVIDENCE_RUNS_DIR) + path.sep)) {
      refuse("--smoke refuses to write into the evidence run directory");
    }
  }

  const frozenSetsBefore = digestFrozenSets();
  for (const [name, expected] of Object.entries(FROZEN_SETS)) {
    if (frozenSetsBefore[name] !== expected) {
      refuse(`frozen set ${name} is ${frozenSetsBefore[name]}, expected ${expected}`);
    }
  }

  // ── run ───────────────────────────────────────────────────────────────────────────────────
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const cases = input.cases;
  if (!Array.isArray(cases)) refuse("input has no `cases` array");

  const { buildQueryContract } = await import("../lib/query-contract");
  const report = executeFrozenCases({
    cases,
    observe: liveObserve,
    // Positional (question, source), matching the production declaration at
    // lib/query-contract.ts:280. It returns QueryContract | null; null is recorded as a parser
    // disagreement for any case carrying a frozen projection, never as silence.
    buildContract: (c) =>
      buildQueryContract(c.question, c.source as QueryContractSource) as Record<string, unknown> | null,
  });

  const frozenSetsAfter = digestFrozenSets();
  for (const [name, expected] of Object.entries(FROZEN_SETS)) {
    if (frozenSetsAfter[name] !== expected) {
      refuse(`REFUSING TO REPORT: frozen set ${name} changed during the run ` +
             `(${frozenSetsBefore[name]} -> ${frozenSetsAfter[name]})`);
    }
  }

  const runId = startedAt.replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  const full: RunReport = {
    runKind,
    runId,
    provenance: {
      candidateCommit, candidateTree, worktreeClean,
      runnerPath: path.relative(ROOT, runnerPath).replace(/\\/g, "/"),
      runnerSha256: runnerSha,
      inputPath: path.relative(ROOT, inputPath).replace(/\\/g, "/"),
      inputSha256: inputSha,
      frozenSetsBefore,
      frozenSetsAfter,
      node: process.version,
      startedAt,
    },
    ...report,
  };

  fs.mkdirSync(outDir as string, { recursive: true });
  const prefix = wantsRun ? "run" : "smoke_not_evidence";
  const out = path.join(outDir as string, `${prefix}-${runId}.json`);
  // wx: a run never overwrites an earlier run's artifact.
  fs.writeFileSync(out, JSON.stringify(full, null, 2) + "\n", { flag: "wx" });

  console.log(`${runKind} run ${runId} -> ${out}`);
  console.log(`  runner            ${runnerSha}`);
  console.log(`  candidate         ${candidateCommit ?? "n/a"} (clean=${worktreeClean})`);
  console.log(`  input             ${path.basename(inputPath)} ${inputSha}`);
  console.log(`  frozen sets       unchanged before and after`);
  console.log(`  run state         ${full.runState}`);
  console.log(`  accounting        ${full.accountingVerdict}${full.accountingDetail ? " - " + full.accountingDetail : ""}`);
  console.log(`  EVIDENCE          ${full.evidenceVerdict}${full.evidenceDetail ? " - " + full.evidenceDetail : ""}`);
  for (const s of PREDICATE_STATES) console.log(`    predicate ${s.padEnd(20)} ${full.predicateCounts[s]}`);
  console.log(`    parser    ${JSON.stringify(full.parserCounts)}`);
  console.log(`    parser run ${JSON.stringify(full.parserExecutionCounts)}`);
  console.log(`    verdicts  ${JSON.stringify(full.verdictCounts)}`);

  if (full.accountingVerdict === "incomplete") process.exit(2);
  process.exit(full.evidenceVerdict === "conformant" ? 0 : 1);
}

if (require.main === module) {
  void main().catch((err) => {
    if (err instanceof Refusal) {
      console.error(`REFUSED: ${err.message}`);
      process.exit(2);
    }
    console.error(`RUNNER ERROR: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(2);
  });
}
