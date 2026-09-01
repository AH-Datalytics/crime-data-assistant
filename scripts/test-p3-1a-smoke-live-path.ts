/**
 * P3.1a — the bounded synthetic live-path smoke test.
 *
 * WHY IT EXISTS. Round 1 left the runner's CLI verified by reading rather than running: the sha256
 * gates, the real parser call, the immutable write and the exit/verdict logic had never executed.
 * One defect of exactly that class was already found by inspection (a parser called with an object
 * argument against a positional signature), and inspection cannot promise it was the last.
 *
 * Round 2 §7 authorized this, bounded. Every bound is enforced here AND by the runner itself:
 *
 *   1. 2-3 newly written synthetic cases, containing none of v1/v2/v3's questions or expected
 *      records. The questions below are authored here and appear in no frozen set.
 *   2. The SAME CLI orchestration as the real run - input hash gate, real local
 *      `buildQueryContract`, the production observer, accounting, immutable write, exit/verdict
 *      logic. It spawns the actual runner as a subprocess; nothing is re-implemented.
 *   3. Only the input path, its expected hash, the output directory and the run kind are
 *      parameterized.
 *   4. Every artifact is labelled `synthetic_smoke_not_evidence` and written to an OS temp
 *      directory, never `docs/superpowers/p3-1a/runs/`.
 *   5. `--smoke` refusing a frozen set by path AND by content, and `--run` refusing a candidate
 *      mismatch, are exercised as negative controls.
 *   6. All three frozen sets are digested before and after the whole suite. No network, model,
 *      database, corpus, or production call is made.
 *   7. Success plus wrong input hash, existing output, parser disagreement, parser error, harness
 *      error, and the nonconforming exit path are each exercised.
 *
 * IT EXECUTES NO FROZEN CASE. The governing set is opened only to hash it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { FROZEN_SETS, P31A_DIR, EVIDENCE_RUNS_DIR, ROOT } from "./run-p3-1a-frozen-cases";

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

const RUNNER = path.join(__dirname, "run-p3-1a-frozen-cases.ts");
const RUNNER_SHA = crypto.createHash("sha256").update(fs.readFileSync(RUNNER)).digest("hex");
const sha256Of = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const digestFrozen = () =>
  Object.fromEntries(Object.keys(FROZEN_SETS).map((n) => [n, sha256Of(path.join(P31A_DIR, n))]));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "p31a-smoke-"));

/** Run the real runner as a subprocess and capture exit code plus output. */
function runCli(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", RUNNER, ...args], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: typeof e.status === "number" ? e.status : -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * The synthetic cases. Authored here, present in no frozen set.
 *
 * `expected_outcome` values were confirmed by probing the production observer directly, not
 * guessed; a smoke test whose expectations are wrong would report a false nonconformance and teach
 * nothing about the live path.
 */
const Q_SUBCITY = "How many burglaries happened in the Uptown precinct of Denver, CO last year?";
const Q_PLAIN = "How many murders were reported in Denver, CO in 2019?";
const Q_DEMORATE = "What is the robbery rate per capita for white residents of Denver, CO in 2019?";

const BLOCK = { store: "query_log", action: "decline_capability", reason: "query_contract_failed", applies: true };
const NOBLOCK = { store: "query_log", action: null, reason: null, applies: false };

const CONFORMANT_CASES = {
  version: "synthetic-smoke-1",
  note: "Synthetic. Not evidence. Contains no frozen-case question or expected record.",
  cases: [
    { id: "SMOKE-1", rule_id: "unsupported-sub-city-geography", source: "current",
      pair: "unsupported-sub-city-geography x current", role: "positive",
      question: Q_SUBCITY, expected_outcome: BLOCK, expected_contract: null },
    { id: "SMOKE-2", rule_id: "unsupported-sub-city-geography", source: "current",
      pair: "unsupported-sub-city-geography x current", role: "false_acceptance",
      question: Q_PLAIN, expected_outcome: NOBLOCK, expected_contract: null },
    { id: "SMOKE-3", rule_id: "demographic-rate-unsupported", source: "current",
      pair: "demographic-rate-unsupported x current", role: "positive",
      question: Q_DEMORATE, expected_outcome: BLOCK,
      expected_contract: { "metric.unsupportedReason": "demographic_rate_denominator_unavailable" } },
  ],
};

function writeCases(name: string, mutate?: (o: any) => void): { file: string; sha: string } {
  const o = JSON.parse(JSON.stringify(CONFORMANT_CASES));
  mutate?.(o);
  const file = path.join(TMP, name);
  fs.writeFileSync(file, JSON.stringify(o, null, 2) + "\n");
  return { file, sha: sha256Of(file) };
}

const frozenBefore = digestFrozen();
console.log(`P3.1a synthetic live-path smoke test  (temp: ${TMP})`);

// ── S0 — the input really is synthetic ──────────────────────────────────────────────────────
console.log("\nS0 — the input is synthetic");
{
  const frozenText = Object.keys(FROZEN_SETS)
    .map((n) => fs.readFileSync(path.join(P31A_DIR, n), "utf8")).join("\n");
  const questions = [Q_SUBCITY, Q_PLAIN, Q_DEMORATE];
  check("S0  no synthetic question appears in any frozen set",
    questions.filter((q) => frozenText.includes(q)), []);
  checkTrue("S0b the smoke input hashes to none of the frozen sets",
    !Object.values(FROZEN_SETS).includes(writeCases("probe.json").sha));
}

// ── S1 — the success path ───────────────────────────────────────────────────────────────────
console.log("\nS1 — success: the whole live path, end to end");
{
  const { file, sha } = writeCases("conformant.json");
  const out = path.join(TMP, "out-success");
  const r = runCli(["--smoke", file, "--expect-hash", sha, "--out", out, "--runner-sha", RUNNER_SHA]);

  check("S1  a conformant synthetic run exits 0", r.code, 0);
  const written = fs.existsSync(out) ? fs.readdirSync(out) : [];
  check("S1b it wrote exactly one artifact", written.length, 1);
  if (written.length === 1) {
    const art = JSON.parse(fs.readFileSync(path.join(out, written[0]), "utf8"));
    check("S1c the artifact is labelled as not evidence", art.runKind, "synthetic_smoke_not_evidence");
    checkTrue("S1d its filename says so too", written[0].startsWith("smoke_not_evidence-"), written[0]);
    check("S1e it completed, accounted fully, and conformed",
      [art.runState, art.accountingVerdict, art.evidenceVerdict],
      ["completed", "complete", "conformant"]);
    check("S1f all three cases conformed", art.verdictCounts, { conformant: 3, nonconformant: 0, not_established: 0 });
    check("S1g the real parser ran and agreed where a projection existed",
      art.parserCounts, { not_applicable: 2, agreed: 1 });
    check("S1h provenance carries the runner, input and candidate identities",
      [art.provenance.runnerSha256 === RUNNER_SHA, art.provenance.inputSha256 === sha,
       typeof art.provenance.candidateCommit === "string", art.provenance.node === process.version],
      [true, true, true, true]);
    check("S1i it verified all three frozen sets before and after",
      [art.provenance.frozenSetsBefore, art.provenance.frozenSetsAfter], [FROZEN_SETS, FROZEN_SETS]);
  } else { fail += 7; console.log("  FAIL  S1c-S1i  no artifact to inspect"); }
}

// ── S2 — the immutable write refuses to overwrite ───────────────────────────────────────────
console.log("\nS2 — an existing artifact is never overwritten");
{
  const { file, sha } = writeCases("conformant2.json");
  const out = path.join(TMP, "out-collision");
  fs.mkdirSync(out, { recursive: true });
  // Pre-create every filename the next run could choose. runId is the UTC start time to the
  // second, so seeding the current second plus the next few makes the collision deterministic
  // rather than a race the test would sometimes lose.
  const now = Date.now();
  for (let i = 0; i < 8; i++) {
    const id = new Date(now + i * 1000).toISOString()
      .replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
    fs.writeFileSync(path.join(out, `smoke_not_evidence-${id}.json`), "{\"pre-existing\":true}\n");
  }
  const seeded = fs.readdirSync(out).length;
  const r = runCli(["--smoke", file, "--expect-hash", sha, "--out", out, "--runner-sha", RUNNER_SHA]);

  check("S2  a collision is a run defect, exit 2", r.code, 2);
  check("S2b nothing new was written", fs.readdirSync(out).length, seeded);
  checkTrue("S2c and no pre-existing artifact was modified",
    fs.readdirSync(out).every((f) =>
      fs.readFileSync(path.join(out, f), "utf8").includes("pre-existing")));
}

// ── S3 — refusals: the gates that protect the oracle ────────────────────────────────────────
console.log("\nS3 — refusals");
{
  const { file, sha } = writeCases("conformant3.json");
  const out = path.join(TMP, "out-refusals");

  const wrongHash = runCli(["--smoke", file, "--expect-hash", "0".repeat(64), "--out", out, "--runner-sha", RUNNER_SHA]);
  check("S3  a wrong input hash refuses, exit 2", wrongHash.code, 2);
  checkTrue("S3b and says so", /REFUSED.*sha256/.test(wrongHash.out), wrongHash.out.slice(0, 120));

  const wrongRunner = runCli(["--smoke", file, "--expect-hash", sha, "--out", out, "--runner-sha", "1".repeat(64)]);
  check("S3c a wrong runner hash refuses, exit 2", wrongRunner.code, 2);

  const noRunner = runCli(["--smoke", file, "--expect-hash", sha, "--out", out]);
  check("S3d a missing runner pin refuses, exit 2", noRunner.code, 2);

  const frozenByPath = runCli([
    "--smoke", path.join(P31A_DIR, "frozen-cases-v3.json"),
    "--expect-hash", FROZEN_SETS["frozen-cases-v3.json"], "--out", out, "--runner-sha", RUNNER_SHA]);
  check("S3e --smoke refuses a frozen set by path, exit 2", frozenByPath.code, 2);
  checkTrue("S3f and names the reason", /refuses a frozen case set/.test(frozenByPath.out),
    frozenByPath.out.slice(0, 160));

  // The same content under a different name: refusal must be by CONTENT, not just by filename.
  const copy = path.join(TMP, "innocent-name.json");
  fs.copyFileSync(path.join(P31A_DIR, "frozen-cases-v3.json"), copy);
  const frozenByContent = runCli([
    "--smoke", copy, "--expect-hash", sha256Of(copy), "--out", out, "--runner-sha", RUNNER_SHA]);
  check("S3g --smoke refuses frozen CONTENT under any filename, exit 2", frozenByContent.code, 2);
  checkTrue("S3h and says it was the content", /content is a frozen case set/.test(frozenByContent.out),
    frozenByContent.out.slice(0, 160));

  const intoEvidence = runCli([
    "--smoke", file, "--expect-hash", sha, "--out", EVIDENCE_RUNS_DIR, "--runner-sha", RUNNER_SHA]);
  check("S3i --smoke refuses to write into the evidence directory, exit 2", intoEvidence.code, 2);

  // The evidence-mode identity gate, exercised without touching the oracle: a wrong candidate is
  // refused before the governing set is read.
  const wrongCandidate = runCli([
    "--run", "--candidate", "0".repeat(40), "--tree", "0".repeat(40), "--runner-sha", RUNNER_SHA]);
  check("S3j --run refuses a candidate mismatch, exit 2", wrongCandidate.code, 2);
  checkTrue("S3k and names the mismatch", /candidate mismatch|tree mismatch|clean worktree/.test(wrongCandidate.out),
    wrongCandidate.out.slice(0, 160));

  check("S3l no refusal wrote anything", fs.existsSync(out) ? fs.readdirSync(out).length : 0, 0);
}

// ── S4 — the failure verdicts, each through the live path ───────────────────────────────────
console.log("\nS4 — failure paths produce honest verdicts and non-zero exits");
{
  const scenarios: {
    name: string; file: string; mutate: (o: any) => void;
    expect: { code: number; runState: string; evidenceVerdict: string; probe: (a: any) => boolean };
  }[] = [
    {
      name: "a nonconforming expectation",
      file: "nonconformant.json",
      mutate: (o) => { o.cases[1].expected_outcome = { ...BLOCK }; },
      expect: {
        code: 1, runState: "completed", evidenceVerdict: "nonconformant",
        probe: (a) => a.verdictCounts.nonconformant === 1 && a.predicateCounts.disagreed === 1,
      },
    },
    {
      name: "a parser disagreement",
      file: "parser-disagree.json",
      mutate: (o) => { o.cases[2].expected_contract = { "metric.unsupportedReason": "something_else" }; },
      expect: {
        code: 1, runState: "stopped_parser_divergence", evidenceVerdict: "nonconformant",
        probe: (a) => a.parserCounts.disagreed === 1 && a.predicateCounts.not_run === 3 &&
                      a.verdictCounts.conformant === 0,
      },
    },
    {
      name: "a parser error",
      file: "parser-error.json",
      // A non-string question makes the real parser throw inside the runner.
      mutate: (o) => { o.cases[0].question = 42; },
      expect: {
        code: 1, runState: "stopped_parser_divergence", evidenceVerdict: "nonconformant",
        probe: (a) => a.parserCounts.parser_error === undefined ? false : a.parserCounts.parser_error >= 1,
      },
    },
    {
      name: "a harness error",
      file: "harness-error.json",
      // A deliberately malformed projection the parser happens to AGREE with: `metric.topic.length`
      // is 6 for a murder question, so phase 1 passes, and phase 2 throws assigning to a string's
      // read-only property. That is the only shape that reaches harness_error through the CLI -
      // any projection the parser disagrees with stops the run first.
      mutate: (o) => {
        o.cases = [{ ...o.cases[1], id: "SMOKE-H", expected_contract: { "metric.topic.length": 6 } }];
      },
      expect: {
        code: 1, runState: "completed", evidenceVerdict: "not_established",
        probe: (a) => a.predicateCounts.harness_error === 1 && a.verdictCounts.conformant === 0,
      },
    },
  ];

  for (const s of scenarios) {
    const { file, sha } = writeCases(s.file, s.mutate);
    const out = path.join(TMP, "out-" + s.file.replace(".json", ""));
    const r = runCli(["--smoke", file, "--expect-hash", sha, "--out", out, "--runner-sha", RUNNER_SHA]);
    const files = fs.existsSync(out) ? fs.readdirSync(out) : [];
    const art = files.length === 1 ? JSON.parse(fs.readFileSync(path.join(out, files[0]), "utf8")) : null;

    check(`S4  ${s.name}: exit ${s.expect.code}`, r.code, s.expect.code);
    checkTrue(`S4  ${s.name}: an artifact was still written`, art !== null,
      `${files.length} file(s); ${r.out.slice(0, 200)}`);
    if (!art) { fail += 2; continue; }
    check(`S4  ${s.name}: run state and evidence verdict`,
      [art.runState, art.evidenceVerdict], [s.expect.runState, s.expect.evidenceVerdict]);
    checkTrue(`S4  ${s.name}: the counts say exactly what happened`, s.expect.probe(art),
      JSON.stringify({ predicate: art.predicateCounts, parser: art.parserCounts, verdicts: art.verdictCounts }));
  }
}

// ── S5 — nothing governing was touched ──────────────────────────────────────────────────────
console.log("\nS5 — the oracle is untouched");
{
  check("S5  all three frozen sets are byte-identical after the whole suite",
    digestFrozen(), frozenBefore);
  check("S5b the frozen sets still match their pins", digestFrozen(), FROZEN_SETS);
  check("S5c the evidence run directory still does not exist",
    fs.existsSync(EVIDENCE_RUNS_DIR), false);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
