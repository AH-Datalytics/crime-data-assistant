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
 *
 * S5c IS AN EQUALITY, NOT AN ABSENCE. It once asserted the evidence directory did not exist,
 * which stopped being true the moment the first legitimate artifact was committed. It now
 * compares a deterministic content-addressed snapshot of that directory before and after the
 * whole suite, so it is valid in every state and detects modification of an artifact that was
 * already there.
 *
 * NOTHING IS FOLLOWED, INCLUDING THE ROOT. `snapshotDir` classifies the root with `lstat` before
 * any following operation, records a root link/junction without reading through it, keeps a
 * dangling root link distinct from `absent`, and proves canonical containment before every
 * `readdir` so a reparse point surfaced as an ordinary directory cannot be walked. S6 exercises
 * each of those, and a platform that cannot build a real link fixture FAILS the suite rather than
 * crediting assertions it never ran.
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

/**
 * The state of the evidence directory, as a value that can be compared.
 *
 * Every variant is distinct on purpose. `absent` and a DANGLING ROOT LINK are different facts, and
 * an earlier version conflated them because `existsSync` follows the link and reports false when
 * its target is missing.
 */
type DirSnapshot =
  | { state: "absent" }
  | { state: "root_link"; target: string }
  | { state: "root_unsupported"; kind: string }
  | { state: "present"; entries: string[] };

/** Compare canonical paths the way the platform does: case-insensitively on Windows. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  return norm(a) === norm(b);
}

/**
 * Does `candidateReal` fall outside `rootReal`?
 *
 * Pure, and exported to the controls, because the redirect it defends against cannot be constructed
 * portably: a Windows name-surrogate reparse point that Node surfaces as a directory rather than a
 * symlink would enter the directory branch and be walked. The boundary decision is therefore tested
 * directly with injected canonical identities, alongside real link fixtures for the platform's
 * actual `lstat` behaviour.
 *
 * The trailing separator is load-bearing. A bare `startsWith(rootReal)` would accept `/runs-evil`
 * as inside `/runs`.
 */
function escapesRoot(rootReal: string, candidateReal: string): boolean {
  if (samePath(rootReal, candidateReal)) return false;
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  return !norm(candidateReal).startsWith(norm(prefix));
}

/**
 * A deterministic, content-addressed snapshot of the evidence directory.
 *
 * WHY THIS REPLACED AN ABSENCE CHECK. S5c used to assert `fs.existsSync(EVIDENCE_RUNS_DIR) ===
 * false`. That baked in a premise — "no evidence run has ever happened" — which was true when it
 * was written and which the first legitimate evidence artifact falsifies. The assertion then failed
 * for the one reason that is not a defect: the system had progressed exactly as intended.
 *
 * A filename listing would not have been enough either: it cannot see a BYTE MODIFICATION of an
 * artifact that was already present, which is the worst thing this suite could do and the thing an
 * absence check could never have detected once absence stopped holding.
 *
 * So the invariant is the strongest form true in every state: the complete evidence directory is
 * byte-for-byte identical before and after the whole suite. It distinguishes absent from
 * present-but-empty, records every recursively contained relative path with its entry type, size
 * and sha256 for regular files, and a link's TARGET without following it. Paths are relative and
 * slash-normalised and the list is sorted, so the comparison carries no timestamp and no
 * platform-dependent absolute path.
 *
 * ── NOTHING IS FOLLOWED, INCLUDING THE ROOT ────────────────────────────────────────────────
 *
 * Three guards, because the first two each leave a gap the next one closes:
 *
 *   1. THE ROOT IS CLASSIFIED BY `lstat` FIRST. An earlier version called `existsSync` and then
 *      `readdirSync` on the root, so a root that was itself a junction was walked through before
 *      the child-link guard could ever run, and a dangling root link was reported as `absent`.
 *   2. CHILD LINKS ARE RECORDED, NEVER TRAVERSED. `lstat` classifies, the injected reader records
 *      the target, and an unconditional `continue` stops recursion — including when the reader
 *      throws, which is recorded as `<unreadable>` rather than swallowed.
 *   3. CANONICAL CONTAINMENT IS PROVED BEFORE EVERY `readdir`. Guards 1 and 2 only cover what Node
 *      reports as a symbolic link. A Windows reparse point surfaced as an ordinary directory would
 *      pass both. So every directory's canonical path — the root's included — must resolve beneath
 *      the root's own canonical path, checked BEFORE it is read. A directory that escapes is
 *      recorded as refused and is not descended into.
 *
 * This is deliberate beyond determinism: a recursive walk that followed a link out of its tree is
 * exactly how an earlier version of the P3.1a inventory suite deleted `node_modules/.bin` and 22
 * packages out of the shared checkout. Fail-closed refusal is the correct direction here even
 * though it can reject unusual but harmless configurations.
 */
function snapshotDir(
  dir: string,
  opts: { readLink?: (p: string) => string; realPath?: (p: string) => string } = {},
): DirSnapshot {
  const readLink = opts.readLink ?? ((p: string) => fs.readlinkSync(p));
  const realPath = opts.realPath ?? ((p: string) => fs.realpathSync.native(p));

  // ── guard 1: classify the root without following it ──────────────────────────────────────
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(dir); // lstat, never stat or existsSync: neither follows a link
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "root_unsupported", kind: "lstat_failed" };
  }
  if (rootStat.isSymbolicLink()) {
    // Recorded, never read through — and a DANGLING root link lands here too, rather than
    // masquerading as `absent`.
    let target = "<unreadable>";
    try { target = readLink(dir).replace(/\\/g, "/"); } catch { /* recorded as unreadable */ }
    return { state: "root_link", target };
  }
  if (!rootStat.isDirectory()) return { state: "root_unsupported", kind: "not_a_directory" };

  // ── guard 3, for the root: its canonical identity must be its own lexical identity ────────
  let rootReal: string;
  try {
    rootReal = realPath(dir);
  } catch {
    return { state: "root_unsupported", kind: "realpath_failed" };
  }
  if (!samePath(rootReal, path.resolve(dir))) {
    return { state: "root_unsupported", kind: "root_redirects" };
  }

  const entries: string[] = [];

  const walk = (abs: string, rel: string) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, d.name);
      const childRel = (rel ? rel + "/" : "") + d.name;
      // lstat, never stat: a link must be classified as a link, not as whatever it points at.
      const st = fs.lstatSync(childAbs);

      // ── guard 2 ──
      if (st.isSymbolicLink()) {
        let target = "<unreadable>";
        try { target = readLink(childAbs).replace(/\\/g, "/"); } catch { /* recorded above */ }
        entries.push(`${childRel}\tlink\t${target}`);
        continue; // NOT traversed
      }

      if (st.isDirectory()) {
        // ── guard 3, before the readdir that would descend ──
        let childReal: string | null = null;
        try { childReal = realPath(childAbs); } catch { childReal = null; }
        if (childReal === null || escapesRoot(rootReal, childReal)) {
          entries.push(`${childRel}\tdir_containment_refused`);
          continue; // NOT descended into
        }
        entries.push(`${childRel}\tdir`);
        walk(childAbs, childRel);
        continue;
      }

      if (st.isFile()) {
        const bytes = fs.readFileSync(childAbs);
        entries.push(
          `${childRel}\tfile\t${st.size}\t${crypto.createHash("sha256").update(bytes).digest("hex")}`);
        continue;
      }
      entries.push(`${childRel}\tother`);
    }
  };

  walk(dir, "");
  entries.sort();
  return { state: "present", entries };
}

/** Captured BEFORE any smoke subprocess is started. */
const frozenBefore = digestFrozen();
const evidenceDirBefore = snapshotDir(EVIDENCE_RUNS_DIR);
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
    // Execution is recorded separately from conclusion, and the ledger proves each case was
    // visited exactly once - the property that closes the round-3 skipped-parser-case escape.
    check("S1g2 parser EXECUTION is recorded separately, and every case was visited once",
      [art.parserExecutionCounts, art.parserVisits],
      [{ not_run: 0, completed: 3, error: 0 }, { "SMOKE-1": 1, "SMOKE-2": 1, "SMOKE-3": 1 }]);
    check("S1h provenance carries the runner, input and candidate identities",
      [art.provenance.runnerSha256 === RUNNER_SHA, art.provenance.inputSha256 === sha,
       typeof art.provenance.candidateCommit === "string", art.provenance.node === process.version],
      [true, true, true, true]);
    check("S1i it verified all three frozen sets before and after",
      [art.provenance.frozenSetsBefore, art.provenance.frozenSetsAfter], [FROZEN_SETS, FROZEN_SETS]);
  } else { fail += 8; console.log("  FAIL  S1c-S1i  no artifact to inspect"); }
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
  // The whole-suite aftercondition. Not a replacement for S3i, which is the direct gate proving
  // `--smoke` REFUSES an output path inside the evidence directory; this proves that across every
  // scenario, refusals included, the directory came out exactly as it went in.
  const evidenceDirAfter = snapshotDir(EVIDENCE_RUNS_DIR);
  check("S5c the evidence directory is byte-for-byte unchanged by the whole suite",
    evidenceDirAfter, evidenceDirBefore);
  checkTrue("S5d and the snapshot recorded a real state, not an unreadable one",
    evidenceDirBefore.state === "absent" ||
    (evidenceDirBefore.state === "present" &&
     evidenceDirBefore.entries.every((e) => !e.endsWith("<unreadable>"))),
    JSON.stringify(evidenceDirBefore).slice(0, 200));
}

// ── S6 — the snapshot helper itself, proved able to detect each kind of change ───────────────
//
// S5c is only as good as `snapshotDir`. A helper that returned a constant would make S5c pass
// forever, so each difference it must catch is exercised against a disposable fixture. Nothing here
// touches the real evidence directory.
//
// PLATFORM CAPABILITY IS A PRECONDITION, NOT AN EXCUSE. An earlier version credited two passes when
// link creation threw. That reported success for properties the environment never exercised — and
// these controls exist because a previous P3.1a test followed a junction and destroyed part of a
// shared dependency directory. A fixture that cannot be built is a failure here.
console.log("\nS6 — the snapshot helper detects every kind of change");
{
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), "p31a-snap-"));
  const dir = path.join(fx, "runs");
  try {
    check("S6  absent is distinguished from present-but-empty",
      [snapshotDir(dir).state, (fs.mkdirSync(dir), snapshotDir(dir))],
      ["absent", { state: "present", entries: [] }]);

    fs.writeFileSync(path.join(dir, "run-a.json"), "{\"a\":1}\n");
    const one = snapshotDir(dir);
    checkTrue("S6b a new file changes the snapshot",
      JSON.stringify(one) !== JSON.stringify({ state: "present", entries: [] }));

    // Same name, same length, different bytes: the case a filename listing cannot see.
    fs.writeFileSync(path.join(dir, "run-a.json"), "{\"a\":2}\n");
    const modified = snapshotDir(dir);
    checkTrue("S6c a same-name, same-size byte modification changes the snapshot",
      JSON.stringify(modified) !== JSON.stringify(one));
    check("S6d and the size is unchanged, so only the hash could have caught it",
      (one as { entries: string[] }).entries[0].split("\t")[2],
      (modified as { entries: string[] }).entries[0].split("\t")[2]);

    fs.writeFileSync(path.join(dir, "run-b.json"), "{}\n");
    const two = snapshotDir(dir);
    fs.rmSync(path.join(dir, "run-b.json"));
    check("S6e a deletion returns the snapshot to its earlier value",
      snapshotDir(dir), modified);
    checkTrue("S6f and the addition had been visible", JSON.stringify(two) !== JSON.stringify(modified));

    // Nesting, so the recursion and the sort are both exercised.
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "deep.json"), "{}\n");
    const nested = snapshotDir(dir) as { entries: string[] };
    checkTrue("S6g nested paths are recorded relative, slash-normalised and sorted",
      nested.entries.some((e) => e.startsWith("nested\tdir")) &&
      nested.entries.some((e) => e.startsWith("nested/deep.json\tfile")) &&
      JSON.stringify(nested.entries) === JSON.stringify([...nested.entries].sort()));

    // ── a real CHILD link: recorded, never followed ──────────────────────────────────────────
    // The target is a throwaway directory inside this same fixture, so even a mistaken traversal
    // could not reach anything that matters.
    const outside = path.join(fx, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "must-not-appear.json"), "{}\n");
    const link = path.join(dir, "linked");
    let linkError: string | null = null;
    try { fs.symlinkSync(outside, link, "junction"); } catch (e) { linkError = String(e); }
    checkTrue("S6h a real link/junction fixture can be created on this platform",
      linkError === null, linkError ?? "");
    if (linkError === null) {
      const withLink = snapshotDir(dir) as { entries: string[] };
      checkTrue("S6i a child link is recorded as a link, with its target",
        withLink.entries.some((e) => e.includes("\tlink\t")));
      checkTrue("S6j and the snapshot does NOT traverse it",
        !withLink.entries.some((e) => e.includes("must-not-appear.json")));
      // Unlink explicitly: never let a recursive delete near a link.
      fs.unlinkSync(link);
    }
    checkTrue("S6k the fixture holds no link before it is deleted", !fs.existsSync(link));

    // ── the ROOT itself is a link: recorded, never walked ────────────────────────────────────
    const rootLink = path.join(fx, "runs-as-link");
    let rootLinkError: string | null = null;
    try { fs.symlinkSync(outside, rootLink, "junction"); } catch (e) { rootLinkError = String(e); }
    checkTrue("S6l a root link/junction fixture can be created on this platform",
      rootLinkError === null, rootLinkError ?? "");
    if (rootLinkError === null) {
      const rootSnap = snapshotDir(rootLink);
      check("S6m a root link is recorded as root_link, not walked and not 'present'",
        rootSnap.state, "root_link");
      checkTrue("S6n and the sentinel behind it never appears",
        !JSON.stringify(rootSnap).includes("must-not-appear.json"));
      fs.unlinkSync(rootLink);
    }

    // ── a DANGLING root link is not 'absent' ─────────────────────────────────────────────────
    const gone = path.join(fx, "gone");
    fs.mkdirSync(gone);
    const dangling = path.join(fx, "runs-dangling");
    let danglingError: string | null = null;
    try { fs.symlinkSync(gone, dangling, "junction"); } catch (e) { danglingError = String(e); }
    checkTrue("S6o a dangling-root fixture can be created on this platform",
      danglingError === null, danglingError ?? "");
    if (danglingError === null) {
      fs.rmSync(gone, { recursive: true, force: true }); // target removed; the link remains
      const danglingSnap = snapshotDir(dangling);
      check("S6p a DANGLING root link is root_link, never 'absent'", danglingSnap.state, "root_link");
      fs.unlinkSync(dangling);
    }

    // ── the containment boundary, decided on injected canonical identities ───────────────────
    // The redirect this defends against — a reparse point Node surfaces as an ordinary directory —
    // cannot be constructed portably, so the pure decision is tested directly. The real link
    // fixtures above cover the platform's actual lstat behaviour.
    const root = path.join("C:", "runs");
    check("S6q the boundary: same path is inside",
      escapesRoot(root, root), false);
    check("S6r a child is inside",
      escapesRoot(root, path.join(root, "nested")), false);
    check("S6s an unrelated path is outside",
      escapesRoot(root, path.join("C:", "elsewhere")), true);
    check("S6t a SIBLING-PREFIX path is outside, which a bare startsWith would have accepted",
      escapesRoot(root, root + "-evil"), true);

    // ── the refusal actually reaches the snapshot, via an injected realPath ──────────────────
    const escaping = path.join(dir, "escaping");
    fs.mkdirSync(escaping);
    fs.writeFileSync(path.join(escaping, "must-not-be-read.json"), "{}\n");
    const refused = snapshotDir(dir, {
      realPath: (p) => (p.endsWith("escaping") ? path.join("C:", "somewhere-else") : fs.realpathSync.native(p)),
    }) as { entries: string[] };
    checkTrue("S6u a directory whose canonical identity escapes is REFUSED, not descended into",
      refused.entries.some((e) => e === "escaping\tdir_containment_refused") &&
      !refused.entries.some((e) => e.includes("must-not-be-read.json")));
    fs.rmSync(escaping, { recursive: true, force: true });

    // ── the readlink-throws branch, deterministically ────────────────────────────────────────
    const link2 = path.join(dir, "linked2");
    let link2Error: string | null = null;
    try { fs.symlinkSync(outside, link2, "junction"); } catch (e) { link2Error = String(e); }
    checkTrue("S6v the unreadable-link fixture can be created on this platform",
      link2Error === null, link2Error ?? "");
    if (link2Error === null) {
      const unreadable = snapshotDir(dir, {
        readLink: () => { throw new Error("simulated readlink failure"); },
      }) as { entries: string[] };
      checkTrue("S6w an unreadable link target is recorded as <unreadable>",
        unreadable.entries.some((e) => e.endsWith("\tlink\t<unreadable>")));
      checkTrue("S6x and it is still not traversed",
        !unreadable.entries.some((e) => e.includes("must-not-appear.json")));
      fs.unlinkSync(link2);
    }
  } finally {
    fs.rmSync(fx, { recursive: true, force: true });
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
