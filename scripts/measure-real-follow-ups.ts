/**
 * The hybrid rewriter (P73) on real conversations: the production log's follow-up turns (same session and tab, within
 * 30 minutes), built and redacted on the server. Offline: it reads the redacted turns and the model's cached answers,
 * both kept outside the repository (they hold question text); only counts are printed.
 *
 *   npx tsx scripts/measure-real-follow-ups.ts --triples <turns.json> --cache <real-rewrites.json> --sample <out.json>
 *
 * Each turn: the deterministic rewriter first (run directly); where it asks, the model's guarded answer (a proposal, or
 * a new question the baseline's check confirms, run directly); else asked. The sample: 50 placed turns, uniformly by
 * a fixed seed, for the hand check; their verdicts, once added to that file, are counted.
 */
import fs from "node:fs";
import { deterministicRewriter, type Rewrite } from "../lib/nibrs-shadow/follow-up";
import { bindingOf, cacheKey, guarded, GUARD_VERSION, type RewriteCache } from "../lib/nibrs-shadow/model-rewriter";
import { SYSTEM_PROMPT_WITH_ANSWER } from "../lib/nibrs-shadow/model-rewriter-prompt";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
type Turn = { tab: string; previous: string; previousAnswer: string; followUp: string };
const turns = JSON.parse(fs.readFileSync(arg("--triples")!, "utf8")) as Turn[];
const cache = JSON.parse(fs.readFileSync(arg("--cache")!, "utf8")) as RewriteCache & { spent: number };
if (cache.binding !== bindingOf(SYSTEM_PROMPT_WITH_ANSWER)) throw new Error("The cache was made with another prompt, model or settings.");

let misses = 0;
const outcome = (t: Turn): { r: Rewrite; by: "rules" | "model" | "none" } => {
  const d = deterministicRewriter.rewrite(t.previous, t.followUp);
  if (d.kind !== "ask") return { r: d, by: "rules" };
  const e = cache.entries[cacheKey(JSON.stringify([t.previous, t.previousAnswer]), t.followUp)];
  if (!e) { misses++; return { r: d, by: "none" }; }
  const m = guarded(e.answer, t.previous, t.followUp);
  return m.kind === "ask" ? { r: d, by: "none" } : { r: m, by: "model" };
};
const all = turns.map((t) => ({ t, ...outcome(t) }));
const cls = (x: (typeof all)[number]) => (x.r.kind === "ask" ? "asked" : x.r.kind === "propose" ? "proposed" : "direct");
const pc = (n: number, d: number) => `${n} (${((100 * n) / d).toFixed(1)}%)`;
const line = (label: string, xs: typeof all) => {
  const n = (c: string) => xs.filter((x) => cls(x) === c).length;
  console.log(`${label}: ${xs.length} turns; run directly ${pc(n("direct"), xs.length)}; proposed for confirmation ${pc(n("proposed"), xs.length)}; asked ${pc(n("asked"), xs.length)}`);
};
console.log(`Real follow-up turns (production log, same session and tab, within 30 minutes; redacted on the server). Guards ${GUARD_VERSION}; model spend $${cache.spent.toFixed(4)}; cache misses counted below.`);
line("All tabs", all);
for (const tab of [...new Set(all.map((x) => x.t.tab))].sort()) line(`  ${tab}`, all.filter((x) => x.t.tab === tab));
console.log(`Run directly by the rules ${all.filter((x) => x.by === "rules" && cls(x) === "direct").length}; by a model "new" the rules confirm ${all.filter((x) => x.by === "model" && cls(x) === "direct").length}. Cache misses: ${misses}.`);

// The hand-check sample: 50 placed turns (run directly or proposed), uniformly by a fixed seed.
const samplePath = arg("--sample")!;
const prior = fs.existsSync(samplePath) ? (JSON.parse(fs.readFileSync(samplePath, "utf8")) as { followUp: string; previous: string; previousAnswer: string; verdict: string; note: string }[]) : [];
const judged = (t: Turn) => prior.find((p) => p.previous === t.previous && p.followUp === t.followUp && p.previousAnswer === t.previousAnswer);
let seed = 20261101;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pool = all.filter((x) => cls(x) !== "asked");
const sample: typeof pool = [];
while (sample.length < 50 && pool.length) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
fs.writeFileSync(samplePath, JSON.stringify(sample.map((x) => ({ ...x.t, outcome: cls(x), by: x.by, question: (x.r as { question: string }).question,
  verdict: judged(x.t)?.verdict ?? "unchecked", note: judged(x.t)?.note ?? "" })), null, 1));
for (const c of ["direct", "proposed"]) {
  const s = sample.filter((x) => cls(x) === c).map((x) => judged(x.t)?.verdict ?? "unchecked");
  console.log(`Hand check, ${c}: ${s.length} sampled; correct ${s.filter((v) => v === "correct").length}, meaning changed ${s.filter((v) => v === "meaning_changed").length}, unchecked ${s.filter((v) => v === "unchecked").length}.`);
}
