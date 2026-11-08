/**
 * The blind verification request for a scorecard run's new answers (docs/runbooks/verify-new-answers.md):
 *
 *   npx tsx scripts/make-verify-requests.ts --labels <labels> --progress <run.jsonl> [--baseline <dev run.jsonl>]
 *     --out <requests.jsonl> [--ids <id,id,...>] [--root <canonical>] [--historical <crime index build>] [--python <python>]
 *
 * Picks every label the run answered whose table digest isn't verified (qlog-verified.json) and wasn't the same answer
 * in the baseline run (new or changed answers), or the --ids given; reruns each question on the same builds; keeps it
 * only when the rerun's digest equals the run's (the request is then exactly the answer scored); and writes one request
 * per answer: the question, source, places, period and every number with where it sits, never the engine's SQL.
 * Two files: --out (full: values, digest, reading; for the compare and apply steps) and <out>.blind.jsonl (what the
 * checker sees: each cell's column and place in the table, never the engine's value).
 * --labels takes the repo's qlog-labels.json ({labels: [...]}) or a local array. Run it at Idle priority; it reruns only
 * the questions picked.
 */
import fs from "node:fs";
import path from "node:path";
import { shadowAnswer, shadowFollowUp, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { historicalBuildAt } from "../lib/nibrs-shadow/historical";
import { currentBuildAt } from "../lib/nibrs-shadow/current";
import { loadNibrsRelease } from "../lib/nibrs-shadow/release";
import { blindOf, requestOf, type VerifyLabel } from "../lib/answer-eval/verify-request";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const LABELS = arg("--labels"), PROGRESS = arg("--progress"), OUT = arg("--out");
if (!LABELS || !PROGRESS || !OUT) throw new Error("--labels, --progress and --out are required");
const root = arg("--root", "C:/Users/jeffm/nibrs-model/work/buildhost/test6-20261031/release/canonical")!;
const crimeIndex = arg("--historical", "C:/Users/jeffm/crimeindex-build/crimeindex-20261101-ct")!;
const python = arg("--python", "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe")!;

type Got = { kind: string; digest?: string } | null;
const outcomes = (file: string) => {
  const m = new Map<string, Got>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) if (line.trim()) { try { const r = JSON.parse(line); m.set(r.id, r.got); } catch { /* a line cut short */ } }
  return m;
};
const run = outcomes(PROGRESS);
const baseline = arg("--baseline") ? outcomes(arg("--baseline")!) : new Map<string, Got>();
const verified = (JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "answer-eval", "qlog-verified.json"), "utf8")) as { verified: Record<string, { digest: string }> }).verified;
const labelFile = JSON.parse(fs.readFileSync(LABELS, "utf8")) as VerifyLabel[] | { labels: VerifyLabel[] };
const labels = Array.isArray(labelFile) ? labelFile : labelFile.labels;
const byId = new Map(labels.map((l) => [l.id, l]));

const ids = arg("--ids") ? arg("--ids")!.split(",").map((s) => s.trim()).filter(Boolean)
  : [...run.entries()].filter(([id, g]) => g?.kind === "answer" && g.digest && verified[id]?.digest !== g.digest
    && !(baseline.get(id)?.kind === "answer" && baseline.get(id)?.digest === g.digest)).map(([id]) => id);

const { released: _r, ...release } = loadNibrsRelease(arg("--release-file"), root);
const execute = duckdbExecutor(python, { timeoutMs: 300_000 });
const deps = { places: loadPlaceIndex(), release: { ...release, asOf: "2026-11-04" },
  target: { root, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  execute, historical: historicalBuildAt(crimeIndex), current: currentBuildAt(crimeIndex, execute) } as ShadowDeps;

const lines: string[] = [];
const blind: string[] = [];
const skipped: string[] = [];
for (const id of ids) {
  const l = byId.get(id);
  if (!l) { skipped.push(`${id}: no such label`); continue; }
  const o = (l.kind === "follow-up" && l.previous ? shadowFollowUp(l.previous, l.question, deps) : shadowAnswer(l.question, deps)) as Parameters<typeof requestOf>[1];
  const q = requestOf(l, o);
  if (!q) { skipped.push(`${id}: the rerun is a ${o.kind}, not an answer`); continue; }
  // The request must be exactly the answer the run scored: an answered entry with a digest, equal to the rerun's. (Also for
  // --ids: a label the run didn't answer, or has no digest for, is never turned into a request.)
  const scored = run.get(id);
  if (scored?.kind !== "answer" || !scored.digest) { skipped.push(`${id}: the run has no scored answer (with a digest) for it`); continue; }
  if (scored.digest !== q.digest) { skipped.push(`${id}: the rerun's table (${q.digest}) differs from the run's (${scored.digest})`); continue; }
  if (!q.verifiable) { skipped.push(`${id}: ${q.note}`); continue; }
  lines.push(JSON.stringify(q));
  blind.push(JSON.stringify(blindOf(q)));
}
fs.writeFileSync(OUT, lines.join("\n") + (lines.length ? "\n" : ""));
fs.writeFileSync(OUT.replace(/\.jsonl$/, "") + ".blind.jsonl", blind.join("\n") + (blind.length ? "\n" : ""));
console.log(`${ids.length} picked, ${lines.length} requests written to ${OUT}`);
for (const s of skipped) console.log(`skipped ${s}`);
execute.close();
process.exit(skipped.some((s) => /differs|no scored answer/.test(s)) ? 1 : 0);
