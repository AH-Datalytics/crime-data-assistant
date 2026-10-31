/**
 * The model rewriter against the deterministic baseline on the 693 logged follow-ups, each tried against the same three
 * synthetic previous questions as scripts/report-follow-up-coverage.ts (a follow-up counts as placed when a rewriter
 * places it after any of them). Offline: it reads the model's cached answers.
 *
 *   npx tsx scripts/measure-model-rewriter.ts --pairs-out <file>   # writes the pairs to fetch (log x 3, and LS-403..LS-426)
 *   npx tsx scripts/measure-model-rewriter.ts                      # the comparison, and the hand-check sample of 50
 *
 * Like the baseline's report, this measures recognition, not real-session correctness: the previous questions are
 * synthetic. The hand-checked sample is what judges the model's rewrites.
 */
import fs from "node:fs";
import path from "node:path";
import { deterministicRewriter, type Rewrite } from "../lib/nibrs-shadow/follow-up";
import { bindingOf, cachedModelRewriter, GUARD_VERSION, type RewriteCache } from "../lib/nibrs-shadow/model-rewriter";
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
// Provenance: which cache and guards these results come from.
console.log(`Cache ${path.basename(CACHE_PATH)} sha256 ${createHash("sha256").update(cacheText).digest("hex").slice(0, 16)}; binding ${cache.binding.slice(0, 16)}; guards ${GUARD_VERSION}; ${Object.keys(cache.entries).length} entries; spent $${cache.spent.toFixed(4)}`);
const best = (rs: Rewrite[]) => rs.find((r) => r.kind !== "ask") ?? rs[0];
const kinds = (label: string, list: Rewrite[]) => {
  const k = new Map<string, number>();
  for (const r of list) k.set(r.kind, (k.get(r.kind) ?? 0) + 1);
  const placed = list.filter((r) => r.kind !== "ask").length;
  console.log(`${label}: placed ${placed} (${((100 * placed) / list.length).toFixed(1)}%), asked ${list.length - placed}; ${[...k].sort().map(([a, n]) => `${a} ${n}`).join(", ")}`);
};
const det = follow.map((f) => best(PREVIOUS.map((p) => deterministicRewriter.rewrite(p, f))));
const mod = follow.map((f) => best(PREVIOUS.map((p) => model.rewrite(p, f))));
console.log(`Logged follow-up turns: ${follow.length}; each tried against ${PREVIOUS.length} synthetic previous questions; recognition, not correctness.`);
kinds("Deterministic", det);
kinds("Model", mod);
const both = follow.filter((_, i) => det[i].kind !== "ask" && mod[i].kind !== "ask").length;
const detOnly = follow.filter((_, i) => det[i].kind !== "ask" && mod[i].kind === "ask").length;
const modOnly = follow.filter((_, i) => det[i].kind === "ask" && mod[i].kind !== "ask").length;
console.log(`Placed by both ${both}; deterministic only ${detOnly}; model only ${modOnly}; neither ${follow.length - both - detOnly - modOnly}.`);
console.log(`Cache misses: ${model.misses.length}`);

// The hand-check sample: 50 drawn uniformly, by a fixed seed, from every accepted (placed) model output over all
// (previous, follow-up) pairs, of every kind (rewrite, new, presentation), not only each row's best context.
const placedPairs = follow.flatMap((f) => PREVIOUS.map((p) => ({ previous: p, followUp: f, r: model.rewrite(p, f) }))).filter((x) => x.r.kind !== "ask");
let seed = 20261031;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pool = [...placedPairs];
const sample: typeof pool = [];
while (sample.length < 50 && pool.length) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
const samplePath = path.join(__dirname, "fixtures/answer-eval/model-rewrites/hand-check-sample.json");
const prior = fs.existsSync(samplePath) ? (JSON.parse(fs.readFileSync(samplePath, "utf8")) as { followUp: string; previous: string; verdict?: string; note?: string }[]) : [];
const verdictOf = (x: { previous: string; followUp: string }) => prior.find((p) => p.previous === x.previous && p.followUp === x.followUp);
fs.writeFileSync(samplePath, JSON.stringify(sample.map((x) => ({ previous: x.previous, followUp: x.followUp, kind: x.r.kind,
  question: (x.r as { question: string }).question, verdict: verdictOf(x)?.verdict ?? "unchecked", note: verdictOf(x)?.note ?? "" })), null, 1));
const v = sample.map((x) => verdictOf(x)?.verdict ?? "unchecked");
console.log(`Hand-check sample: ${sample.length} of ${placedPairs.length} placed model rewrites; correct ${v.filter((x) => x === "correct").length}, meaning changed ${v.filter((x) => x === "meaning_changed").length}, unchecked ${v.filter((x) => x === "unchecked").length}.`);
