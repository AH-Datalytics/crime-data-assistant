/**
 * The model rewriter against the deterministic baseline on the 693 logged follow-ups, each tried against the same three
 * synthetic previous questions as scripts/report-follow-up-coverage.ts (a follow-up counts as placed when a rewriter
 * places it after any of them). Offline: it reads the model's cached answers.
 *
 *   npx tsx scripts/measure-model-rewriter.ts --pairs-out <file>   # writes the pairs to fetch (log x 3, and LS-403..LS-426)
 *   npx tsx scripts/measure-model-rewriter.ts                      # the comparison (run directly, proposed, asked) and the outputs the guard exceptions admit
 *
 * Like the baseline's report, this measures recognition, not real-session correctness: the previous questions are
 * synthetic. The hand-checked sample is what judges the model's rewrites.
 */
import fs from "node:fs";
import path from "node:path";
import { deterministicRewriter, type Rewrite } from "../lib/nibrs-shadow/follow-up";
import { bindingOf, cachedModelRewriter, GUARD_VERSION, hybridRewriter, meaningProblem, type RewriteCache } from "../lib/nibrs-shadow/model-rewriter";
import { SYSTEM_PROMPT } from "../lib/nibrs-shadow/model-rewriter-prompt";
import { createHash } from "node:crypto";
import { CACHE_PATH } from "./fetch-model-rewrites";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const csv = fs.readFileSync(path.join(__dirname, "../docs/coverage/2026-10-30-query-log-classification.csv"), "utf8");
/** RFC 4180 rows, as in report-follow-up-coverage.ts. */
function rows(text: string): string[][] {
  const out: string[][] = []; let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\n") { row.push(cell); out.push(row); row = []; cell = ""; } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}
const [head, ...data] = rows(csv);
const qi = head.indexOf("question"), si = head.indexOf("status");
const follow = data.filter((r) => r[si] === "P inc 7b").map((r) => r[qi]);
export const PREVIOUS = ["Shoplifting in Memphis by year from 2021 to 2024", "Female aggravated assault victims in Memphis in 2024 by offender race", "simple assault victims in Detroit by month in 2023"];
const casesFile = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/answer-eval/cases.json"), "utf8"));
const cases = (casesFile.cases ?? casesFile) as { id: string; setup: { question: string }[]; question: string; rewrite?: string | null }[];
const followCases = cases.filter((c) => c.rewrite !== undefined && c.setup.length);

const out = arg("--pairs-out");
if (out) {
  const pairs = [...follow.flatMap((f) => PREVIOUS.map((p) => ({ previous: p, followUp: f }))),
    ...followCases.map((c) => ({ previous: c.setup[c.setup.length - 1].question, followUp: c.question }))];
  fs.writeFileSync(out, JSON.stringify(pairs, null, 1));
  console.log(`${pairs.length} pairs written (${follow.length} logged follow-ups x ${PREVIOUS.length}, ${followCases.length} cases)`);
  process.exit(0);
}


const cacheText = fs.readFileSync(CACHE_PATH, "utf8");
const cache = JSON.parse(cacheText) as RewriteCache & { spent: number };
const model = cachedModelRewriter(cache, bindingOf(SYSTEM_PROMPT));
const hybrid = hybridRewriter(model);
// Provenance: which cache and guards these results come from.
console.log(`Cache ${path.basename(CACHE_PATH)} sha256 ${createHash("sha256").update(cacheText).digest("hex").slice(0, 16)}; binding ${cache.binding.slice(0, 16)}; guards ${GUARD_VERSION}; ${Object.keys(cache.entries).length} entries; spent $${cache.spent.toFixed(4)}`);
console.log(`Logged follow-up turns: ${follow.length}; each tried against ${PREVIOUS.length} synthetic previous questions, in this order; recognition, not correctness.`);

// Per row, as the baseline's report: the first context (in order) that places it; a direct rewrite before a proposal.
const rowOutcome = (rw: (p: string, f: string) => Rewrite) => follow.map((f) => {
  const rs = PREVIOUS.map((p) => rw(p, f));
  return rs.find((r) => r.kind !== "ask" && r.kind !== "propose") ?? rs.find((r) => r.kind === "propose") ?? rs[0];
});
const report = (label: string, list: Rewrite[]) => {
  const direct = list.filter((r) => r.kind !== "ask" && r.kind !== "propose").length, proposed = list.filter((r) => r.kind === "propose").length;
  const pc = (n: number) => `${n} (${((100 * n) / list.length).toFixed(1)}%)`;
  console.log(`${label}: run directly ${pc(direct)}; proposed for confirmation ${pc(proposed)}; asked ${pc(list.length - direct - proposed)}.`);
};
report("Deterministic", rowOutcome((p, f) => deterministicRewriter.rewrite(p, f)));
report("Hybrid (deterministic first, then model proposals)", rowOutcome((p, f) => hybrid.rewrite(p, f)));
console.log(`Cache misses: ${model.misses.length}`);

// Codex amendment check 6: the original 50 judgments (guards g-1) are kept as they were; the new guards' accepted
// outputs are drawn afresh, and those the exceptions newly admit are listed for inspection.
const g1 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/answer-eval/model-rewrites/hand-check-sample-g1.json"), "utf8")) as { verdict: string }[];
console.log(`Original hand check (guards g-1): ${g1.filter((x) => x.verdict === "correct").length} correct, ${g1.filter((x) => x.verdict === "meaning_changed").length} meaning changed, of ${g1.length}.`);
const pairs = follow.flatMap((f) => PREVIOUS.map((p) => ({ previous: p, followUp: f })));
const accepted = pairs.map((x) => ({ ...x, r: model.rewrite(x.previous, x.followUp) })).filter((x) => x.r.kind !== "ask");
const admitted = accepted.filter((x) => x.r.kind === "propose" && meaningProblem(x.previous, x.followUp, (x.r as { question: string }).question, { exceptions: false }) !== null);
console.log(`Model outputs accepted under ${GUARD_VERSION}: ${accepted.length} pairs; admitted only by the exceptions: ${admitted.length}.`);
const admittedPath = path.join(__dirname, `fixtures/answer-eval/model-rewrites/admitted-by-exceptions-${GUARD_VERSION}.json`);
const priorAdmitted = fs.existsSync(admittedPath) ? (JSON.parse(fs.readFileSync(admittedPath, "utf8")) as { previous: string; followUp: string; verdict: string; note: string }[]) : [];
const judged = (x: { previous: string; followUp: string }) => priorAdmitted.find((p) => p.previous === x.previous && p.followUp === x.followUp);
fs.writeFileSync(admittedPath, JSON.stringify(admitted.map((x) => ({ previous: x.previous, followUp: x.followUp, question: (x.r as { question: string }).question,
  verdict: judged(x)?.verdict ?? "unchecked", note: judged(x)?.note ?? "" })), null, 1));
const av = admitted.map((x) => judged(x)?.verdict ?? "unchecked");
console.log(`Admitted by the exceptions, hand-checked: correct ${av.filter((x) => x === "correct").length}, meaning changed ${av.filter((x) => x === "meaning_changed").length}, unchecked ${av.filter((x) => x === "unchecked").length}.`);
