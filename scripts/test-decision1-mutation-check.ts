/**
 * Does the terminal proof actually CATCH the repair being undone — in BOTH routes?
 *
 * WHY. The original Decision 1 defect was correct helper logic that a terminal route exit never
 * consulted. A proof that cannot detect the exit reverting to its old unconditional template is not
 * a proof of the repair.
 *
 * WHY THIS REPLACED THE PREVIOUS VERSION. That one wrote the mutation into the shared
 * `app/api/query/route.ts` on disk and re-ran a child process, restoring in a `finally`. Two things
 * were wrong with it (review 2026-09-09, R3). It mutated the shared source, so an interrupted run
 * could leave the product file modified. And it inferred the kill from the child's exit status, so a
 * setup error, a missing database or a timeout counted as a kill just as loudly as the assertion it
 * was supposed to be testing. The NIBRS site was not mutated at all.
 *
 * HOW IT WORKS NOW. The route source is read into a string, the call site is reverted IN THAT STRING
 * ONLY, and the branch is extracted from the modified copy and executed in-process. Nothing is
 * written: the routes are never opened for writing, and their sha256 values are printed before and
 * after as evidence. A KILL requires the NAMED assertions below to fail. Any exception, missing
 * mutation target or absent output is an INVALID RUN and is reported as a failure of this check —
 * never counted as a kill.
 *
 * No model call, no network, no database.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import {
  extractNoSqlBranch,
  runBranch,
  assertTargetIntact,
  COURT_EXPLANATION,
  REPHRASE_INVITATION,
  type BranchOutcome,
  type RouteKey,
} from "./decision1-terminal-harness";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL  ${message}`); }
}

type Site = {
  route: RouteKey;
  file: string;
  /** A court-process question routed through this route's own source. */
  question: string;
  mode: "historical" | "current";
  /** The exact selector call to neutralise, and the old unconditional template it becomes. */
  find: string;
  replace: string;
};

const SITES: Site[] = [
  {
    route: "query",
    file: "app/api/query/route.ts",
    question: "how many offenders were sentenced to prison",
    mode: "historical",
    find: 'selectNoSqlRefusal(guardrailQuestion, tab === "historical" ? "historical" : "current")',
    replace: '{ explanation: buildNoSqlFallbackMessage(tab === "historical" ? "historical" : "current"), reason: "no-sql-server-template" }',
  },
  {
    route: "nibrs",
    file: "app/api/nibrs-query/route.ts",
    question: "Can you provide one bar per city with the race of defendants reflected in each bar?",
    mode: "current",
    find: 'const noSqlRefusal = selectNoSqlRefusal(question, "nibrs")',
    replace: 'const noSqlRefusal = { explanation: buildNoSqlFallbackMessage("nibrs"), reason: "no-sql-server-template" }',
  },
];

/**
 * THE NAMED ASSERTIONS. These, and only these, decide a kill. They are the Group A properties the
 * repair exists to deliver — deliberately the same properties `test-decision1-route-terminal.ts`
 * asserts, so this check measures that proof and not some weaker stand-in.
 */
function namedAssertionFailures(out: BranchOutcome): string[] {
  const problems: string[] = [];
  const explanation = out.explanation || "";
  if (!COURT_EXPLANATION.test(explanation)) problems.push("court explanation not delivered");
  if (REPHRASE_INVITATION.test(explanation)) problems.push("rephrase invitation delivered");
  if (!(out.loggedGuardrails || []).includes("court-data-out-of-scope")) {
    problems.push(`recorded reason is ${JSON.stringify(out.loggedGuardrails)}`);
  }
  if (!COURT_EXPLANATION.test(String(out.emitted?.explanation ?? ""))) {
    problems.push("emitted payload does not carry the court explanation");
  }
  return problems;
}

const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const hashesBefore = Object.fromEntries(SITES.map((s) => [s.file, sha(s.file)]));
for (const s of SITES) console.log(`${s.file} sha256 before: ${hashesBefore[s.file].slice(0, 16)}`);

for (const site of SITES) {
  console.log("");
  console.log(`${site.route} - ${site.file}`);
  const source = fs.readFileSync(site.file, "utf8");

  /* Baseline: the real source must satisfy the named assertions. */
  let baseline: BranchOutcome | null = null;
  try {
    baseline = runBranch(extractNoSqlBranch(site.route, source), {
      sql: "", question: site.question, mode: site.mode, modelExplanation: "model prose",
    });
  } catch (e) {
    check(false, `${site.route}: INVALID RUN - baseline threw: ${(e as Error).message}`);
  }
  if (baseline) {
    const problems = namedAssertionFailures(baseline);
    check(problems.length === 0,
      `${site.route}: the unmodified source must satisfy the named assertions (${problems.join("; ")})`);
    console.log(`  baseline: named assertions ${problems.length === 0 ? "hold" : "FAIL"}`);
  }

  /* Mutation, in memory only. */
  const occurrences = source.split(site.find).length - 1;
  check(occurrences === 1,
    `${site.route}: INVALID RUN - the mutation target must appear exactly once (found ${occurrences})`);
  if (occurrences !== 1) continue;

  const mutated = source.replace(site.find, site.replace);
  check(mutated !== source, `${site.route}: INVALID RUN - the mutation changed nothing`);

  let mutatedOut: BranchOutcome | null = null;
  try {
    const branch = extractNoSqlBranch(site.route, mutated);
    // The tripwire in the real proof must notice the selector is gone.
    const intactProblems = assertTargetIntact(branch);
    check(intactProblems.some((p) => /no longer consults selectNoSqlRefusal/.test(p)),
      `${site.route}: assertTargetIntact must report the missing selector (got ${JSON.stringify(intactProblems)})`);
    mutatedOut = runBranch(branch, {
      sql: "", question: site.question, mode: site.mode, modelExplanation: "model prose",
    });
  } catch (e) {
    // An exception is NOT a kill. The reverted branch is valid code and must still run.
    check(false, `${site.route}: INVALID RUN - the mutated branch threw: ${(e as Error).message}`);
  }

  if (mutatedOut) {
    // Non-vacuous: the reverted branch must still produce a real answer to judge.
    check((mutatedOut.explanation || "").length > 0,
      `${site.route}: INVALID RUN - the mutated branch produced no explanation`);
    check(mutatedOut.emitted !== null,
      `${site.route}: INVALID RUN - the mutated branch emitted no payload`);
    const problems = namedAssertionFailures(mutatedOut);
    console.log(`  mutated:  ${JSON.stringify((mutatedOut.explanation || "").slice(0, 60))}`);
    console.log(`  mutated:  named assertions failing -> ${problems.length ? problems.join("; ") : "NONE"}`);
    check(problems.length > 0,
      `${site.route}: reverting the call site MUST fail the named assertions`);
  }
}

/* Nothing was written. Proved, not asserted. */
console.log("");
for (const s of SITES) {
  const after = sha(s.file);
  check(after === hashesBefore[s.file],
    `${s.file} must be untouched (before ${hashesBefore[s.file].slice(0, 16)}, after ${after.slice(0, 16)})`);
  console.log(`${s.file} sha256 after:  ${after.slice(0, 16)}`);
}

console.log("");
console.log(`checks: ${checks}   failures: ${failures}`);
if (failures > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS");
