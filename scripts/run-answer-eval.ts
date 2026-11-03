/**
 * Runs a candidate over the labeled set and writes a readable discrepancy report (answer evaluation part 4).
 *
 *   npx tsx scripts/run-answer-eval.ts            # writes scripts/fixtures/answer-eval/runs/nibrs-reader.{json,md}
 *   npx tsx scripts/run-answer-eval.ts --candidate nibrs-shadow [--root <canonical dir>] [--python <python with duckdb>]
 *       [--values-repo <nibrs-model checkout>]  # writes runs/nibrs-shadow.{json,md}; local only (reads the canonical build,
 *                                               # and the independent values from that repo's main branch with git show)
 *
 * Candidate "nibrs-shadow": the shadow slice (lib/nibrs-shadow), question to delivered answer for single-agency NIBRS
 * counts on the canonical release (test6-20261031-host by default; --root and --release name another), scored at every level by lib/answer-eval/shadow.ts on the slice's cases:
 * its designed group, the replay cases inside it, and replay cases next to it. Everything else is listed as outside
 * the slice. A refusal because the build lacks the months is listed apart, never scored.
 *
 * Candidate "nibrs-reader": today's NIBRS reader (request ledger + typed matcher) -> the plan adapter -> every plan
 * validation and release resolution. This is the question -> reader level ONLY. Not executed, and reported as not
 * measured: known plan -> compiled result (no compiler yet), numeric values, routing between sources, the delivered
 * answer and its statements, follow-up turns and button continuations. An "answer" here is a plan-level semantic
 * assessment, not a delivered number.
 *
 * Scored: cases whose label is reviewed and whose policy rows are all decided (scorable()). Drafted labels are also
 * compared, in a separate PROVISIONAL section that is never a gate. Development and held-out cases are reported
 * separately. Offline: no database, no model, no network.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Case, scorable } from "../lib/answer-eval/case";
import { compareMeaning, labelPeriod, planToMeaning, type Diff, type Release } from "../lib/answer-eval/compare";
import { confusion, gates, outcomeOf, severity, type ActualAction, type CaseResult } from "../lib/answer-eval/gates";
import { planFromSpec } from "../lib/nibrs-plan/from-spec";
import { DRAFT_LAYER, DRAFT_SEMANTIC_VERSION } from "../lib/nibrs-plan/draft-layer";
import { parsePlan, type Place } from "../lib/nibrs-plan/plan";
import { validateResolved } from "../lib/nibrs-plan/resolve";
import { validateBindings, validatePlanSemantics, validatePlanShape } from "../lib/nibrs-plan/validate";
import { accountNibrsRequest } from "../lib/nibrs-request-accounting";
import { matchNibrsType } from "../lib/nibrs-question-types";
import { quarterCells, scoreShadow, sliceGroup, sliceValues, sameRewrite, withRewrite, type ExpectedValues } from "../lib/answer-eval/shadow";
import { shadowAnswer, shadowFollowUp, type FollowUpOutcome, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { bindingOf, cachedModelRewriter, GUARD_VERSION, hybridRewriter, MODEL_ID, type RewriteCache } from "../lib/nibrs-shadow/model-rewriter";
import { SYSTEM_PROMPT } from "../lib/nibrs-shadow/model-rewriter-prompt";
import { loadNibrsRelease } from "../lib/nibrs-shadow/release";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { historicalBuildAt } from "../lib/nibrs-shadow/historical";

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "scripts/fixtures/answer-eval/runs");
const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const CANDIDATE = arg("--candidate", "nibrs-reader")!;
if (!["nibrs-reader", "nibrs-shadow"].includes(CANDIDATE)) throw new Error(`unknown candidate ${CANDIDATE}`);
const SHADOW = CANDIDATE === "nibrs-shadow";
// The model rewriter test (shadow only): follow-ups rewritten from the cached model answers; its own run files.
const MODEL = SHADOW && arg("--rewriter") === "model" ? (() => {
  const cache = JSON.parse(fs.readFileSync(path.join(ROOT, `scripts/fixtures/answer-eval/model-rewrites/${MODEL_ID}.json`), "utf8")) as RewriteCache;
  const binding = bindingOf(SYSTEM_PROMPT);
  const model = cachedModelRewriter(cache, binding);
  return { binding, model, rewriter: hybridRewriter(model) };
})() : null;
const RUN_NAME = MODEL ? `${CANDIDATE}-model-rewriter` : CANDIDATE;
const release: Release & { id: string; asOf: string } = SHADOW
  // The build's months run through the month before its CDE release's month (Jeff 2026-11-03), from the release recorded
  // with it (release.json; --release-file names another build's, given with --root).
  ? (() => { const r = loadNibrsRelease(arg("--release-file")); return { id: r.id, firstMonth: r.firstMonth, lastMonth: r.lastMonth, asOf: "2026-10-29" }; })()
  : { id: "eval", firstMonth: "1991-01", lastMonth: "2026-10", asOf: "2026-10-28" };
const shadowDeps = (): ShadowDeps => ({
  places: loadPlaceIndex(), release,
  target: { root: arg("--root", "C:/Users/jeffm/nibrs-model/work/buildhost/test6-20261031/release/canonical")!, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  execute: duckdbExecutor(arg("--python", "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe")!),
  // Historical (P75-P79): the Crime Index build (scripts/build-crimeindex.py), when present.
  historical: historicalBuildAt(arg("--historical", "C:/Users/jeffm/crimeindex-build/crimeindex-20261101")),
});
/** Independent expected values: nibrs-model's correctness/slice/V*.json on its main branch, read with git show (read-only). */
function readSliceValues(repo: string): ExpectedValues {
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const names = git("ls-tree", "--name-only", "main", "correctness/slice/").split(/\r?\n/).filter((n) => /\/V\d+\.json$/.test(n));
  return sliceValues(names.map((name) => ({ name, json: git("show", `main:${name}`) })));
}
const VALUES_REPO = arg("--values-repo", "C:/Users/jeffm/nibrs-model")!;
const expectedValues: ExpectedValues | undefined = SHADOW ? readSliceValues(VALUES_REPO) : undefined;
const PLACES: Record<string, { ori: string; label: string }> = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/nibrs-replay/reachability/places.json"), "utf8"));
const resolvePlace = (v: string): Place | null => (PLACES[v] ? { kind: "agency", ori: PLACES[v].ori, label: PLACES[v].label } : null);
const authority = (v: string) => (PLACES[v] ? { oris: [PLACES[v].ori] } : null);
const geo = { members: (p: Place) => (p.kind === "agency" ? [p.ori] : ["(any)"]) };

const cases: Case[] = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/answer-eval/cases.json"), "utf8")).cases.map((c: unknown) => Case.parse(c));
const policyCsv = fs.readFileSync(path.join(ROOT, "docs/policy/nibrsai-answer-policy.csv"), "utf8");
const openPolicy = new Set([...policyCsv.matchAll(/^﻿?(P\d{2}),.*Needs Jeff/gm)].map((m) => m[1]));

type Run = { actual: ActualAction; diffs: Diff[]; notes: string[] };
/** Why the candidate cannot take a case at all (execution coverage, separate from label eligibility). */
function notRun(c: Case): string | null {
  if (c.tab !== "nibrs") return "another source: no adapter for it yet";
  if (c.setup.length) return "a follow-up: the reader takes one turn";
  if (c.button) return "a button continuation: the reader returns no structured options";
  return null;
}
function run(c: Case): Run {
  const ledger = accountNibrsRequest(c.question);
  const d = matchNibrsType(ledger);
  if (d.kind === "none") return { actual: "no_reading", diffs: [], notes: ["no typed reading: no answer, no reason"] };
  if (d.kind === "clarify") return { actual: "clarify", diffs: [], notes: [`asked (text only, no structured options): ${d.explanation}`] };
  if (d.kind === "decline") return { actual: "decline", diffs: [], notes: [`declined (reason not judged): ${d.explanation}`] };
  const a = planFromSpec(d.spec, ledger, { semanticVersion: DRAFT_SEMANTIC_VERSION, resolvePlace });
  if (a.kind === "unmapped") return { actual: "decline", diffs: [], notes: [`adapter refused (reason not judged): ${a.reason}`] };
  const problems = [...parsePlan(a.plan).problems, ...validatePlanShape(a.plan), ...validatePlanSemantics(a.plan, DRAFT_LAYER), ...validateBindings(a.plan, a.parts, authority)];
  const resolved = problems.length ? null : validateResolved(a.plan, release, DRAFT_LAYER, geo);
  const all = [...problems, ...(resolved?.problems ?? [])];
  if (all.length) return { actual: "decline", diffs: [], notes: [`plan refused (reason not judged): ${all.map((p) => p.rule).join(", ")}`] };
  const view = planToMeaning(a.plan, resolved!.period);
  return { actual: "answer", diffs: c.expected?.action === "answer" ? compareMeaning(c.expected.meaning, view, release) : [], notes: [] };
}

/** Era from the whole period the label expects: before 2021, from 2021 on, or spanning both. */
function era(c: Case): string {
  const e = c.expected!;
  const m = e.action === "answer" ? e.meaning : e.action === "decline" ? e.alternative : e.options.find((o) => o.meaning)?.meaning ?? null;
  if (!m) return "no period";
  const p = labelPeriod(m.period, release);
  if (!p) return "period not mapped";
  const [a, b] = [Number(p.from.slice(0, 4)), Number(p.to.slice(0, 4))];
  return b < 2021 ? "before 2021" : a >= 2021 ? "2021 and later" : "spans 2021";
}
function capability(c: Case): string {
  const e = c.expected!;
  const m = e.action === "answer" ? e.meaning : e.action === "decline" ? e.alternative : e.options.find((o) => o.meaning)?.meaning ?? null;
  return `${e.action}:${m ? `${m.source} ${m.statistic}` : "no meaning"}`;
}

function score(c: Case, r: Run): CaseResult {
  const e = c.expected!;
  const material = r.diffs.filter((d) => d.kind === "material").length;
  const unverified = r.diffs.filter((d) => d.kind === "unverified").length;
  const notes = [...r.notes];
  // Today's reader gives text: a decline's reason is not judged, a clarification's options are not structured.
  const structured = false;
  const alternativeMissing = e.action === "decline" && !!e.alternative && r.actual === "decline";
  if (alternativeMissing) notes.push("no alternative offered; the label expects one");
  return { id: c.id, split: c.split, expected: e.action, actual: r.actual, outcome: outcomeOf(e.action, r.actual, { material, unverified, structured, alternativeMissing }), diffs: r.diffs, notes, capability: capability(c), era: era(c) };
}

const coverage: Record<string, string[]> = {};
const eligibility: Record<string, string[]> = {};
const scored: CaseResult[] = [];
const provisional: CaseResult[] = [];
const notBuilt: string[] = [];
const proposals: string[] = [];
const groupOf = new Map<string, string>();
const deps = SHADOW ? shadowDeps() : null;
for (const c of cases) {
  const s = scorable(c, openPolicy);
  (eligibility[s.scored ? "scorable (reviewed, decided policy)" : s.why!.replace(/ P\d.*$/, " (open rows)")] ??= []).push(c.id);
  const group = SHADOW ? sliceGroup(c) : null;
  // Increment 7b (P69): a follow-up with an expected rewrite runs as one, from its last setup turn.
  const followUp = c.setup.length > 0 && c.rewrite !== undefined;
  const nr = SHADOW ? (!group ? "outside the shadow slice" : (c.setup.length && !followUp) || c.button ? "a follow-up or button case: options are scored on their parent" : null) : notRun(c);
  (coverage[nr ?? "run by this candidate"] ??= []).push(c.id);
  if (nr || !c.expected) continue;
  let res: CaseResult | null;
  if (deps) {
    const first = followUp ? shadowFollowUp(c.setup[c.setup.length - 1].question, c.question, deps, MODEL?.rewriter) : shadowAnswer(c.question, deps);
    // P69 amendment: a proposal is judged before any simulated confirmation (Codex amendment check 2). Where the label
    // asks, or the proposal is not the label's rewrite, it is a wrong action: the user saw the wrong question before
    // anything ran. A matching proposal is confirmed (simulated) and that answer is scored as usual.
    if (first.kind === "proposal") {
      proposals.push(c.id);
      const wrong = c.rewrite === null ? "(ask: the rewrite is uncertain)" : c.rewrite && !sameRewrite(c.rewrite, first.proposed) ? c.rewrite : null;
      if (wrong !== null || !c.rewrite) {
        const r: CaseResult = { id: c.id, split: c.split, expected: c.expected.action, actual: "clarify", outcome: "wrong_action", capability: capability(c), era: era(c),
          diffs: [{ field: "proposal", expected: wrong ?? "(no rewrite)", actual: first.proposed, kind: "material" }], notes: [`proposed (nothing ran): ${first.proposed}`] };
        (s.scored ? scored : provisional).push(r); groupOf.set(c.id, group!);
        continue;
      }
    }
    const outcome = first.kind === "proposal" ? { ...shadowAnswer(first.proposed, deps), rewrite: first.proposed, rewriteKind: "rewrite" as const } : first;
    // A follow-up whose rewrite is another case's question reuses that case's independent values.
    // P71: a quarterly rewrite of a monthly case sums that case's months.
    const src = c.expected.action === "answer" ? c.expected.values.source ?? "" : "";
    // A rate case's count: its file's total ("<case>|count").
    const reuse = /^the same (?:rate )?cells as (LS-\d{3})\b/.exec(src)?.[1], quarters = /^the sums of (LS-\d{3})'s months by quarter/.exec(src)?.[1];
    const countOf = /^the count in (LS-\d{3})'s values\b/.exec(src)?.[1];
    const ref = reuse ?? quarters ?? (countOf ? `${countOf}|count` : undefined);
    const values: ExpectedValues | undefined = ref && expectedValues?.has(ref) && !expectedValues.has(c.id)
      ? new Map([...expectedValues, [c.id, quarters ? quarterCells(expectedValues.get(ref)!) : expectedValues.get(ref)!]]) : expectedValues;
    const sc = scoreShadow(c, outcome, release, { capability: capability(c), era: era(c) }, values);
    if (sc.excluded) notBuilt.push(`${c.id}: ${sc.excluded}`);
    res = sc.result && followUp ? withRewrite(sc.result, c, outcome as FollowUpOutcome) : sc.result;
    if (res && first.kind === "proposal") res = { ...res, notes: [`proposed, then confirmed (simulated): ${first.proposed}`, ...res.notes] };
    if (res) groupOf.set(c.id, group!);
  } else res = score(c, run(c));
  if (res) (s.scored ? scored : provisional).push(res);
}

const list = (m: Record<string, string[]>) => Object.entries(m).sort((a, b) => b[1].length - a[1].length).map(([why, ids]) => `- ${ids.length}: ${why}`);
const section = (title: string, rs: CaseResult[], gate: boolean) => {
  const L: string[] = [`### ${title}`, ""];
  if (!rs.length) return [...L, "No cases.", ""].join("\n");
  const n = (o: string) => rs.filter((r) => r.outcome === o).length;
  L.push(`${rs.length} cases. Correct ${n("correct")}; unverified ${n("unverified")}; wrong answers ${n("wrong_answer")}; avoidable declines ${n("avoidable_decline")}; unnecessary clarifications ${n("unnecessary_clarify")}; wrong actions ${n("wrong_action")}; incomplete ${n("incomplete")}. Severity score ${severity(rs)} (trend only).`, "");
  L.push("Expected (rows) by actual (columns):", "", "| | answer | clarify | decline | no reading |", "|---|---|---|---|---|");
  for (const [e, row] of Object.entries(confusion(rs))) L.push(`| ${e} | ${row.answer} | ${row.clarify} | ${row.decline} | ${row.no_reading} |`);
  L.push("", `| Capability | Era | Cases | ${gate ? "Gate" : "Would-be gate (not a gate)"} | Categories |`, "|---|---|---|---|---|");
  for (const g of gates(rs)) L.push(`| ${g.capability} | ${g.era} | ${g.cases} | ${g.status} | ${g.categories.filter((x) => x.detail !== "no cases").map((x) => `${x.name}: ${x.status} (${x.detail})`).join("; ")} |`);
  L.push("", "Discrepancies and unverified cases:", "");
  for (const r of rs.filter((x) => x.outcome !== "correct")) {
    const c = cases.find((x) => x.id === r.id)!;
    L.push(`- **${r.id}** (${r.outcome}; expected ${r.expected}, got ${r.actual}) "${c.question.slice(0, 140)}"`);
    for (const d of r.diffs) L.push(`  - ${d.kind} ${d.field}: expected \`${d.expected}\`, got \`${d.actual}\``);
    for (const t of r.notes) L.push(`  - ${t.slice(0, 220)}`);
  }
  return [...L, ""].join("\n");
};
const bySplit = (title: string, rs: CaseResult[], gate: boolean) =>
  [`## ${title}`, "", section("Development", rs.filter((r) => r.split === "dev"), gate), section("Held out", rs.filter((r) => r.split === "heldout"), gate)].join("\n");

/** The shadow's report keeps its designed cases apart from the replay-derived ones. */
const GROUPS: [string, string][] = [["designed", "designed slice cases"], ["replay", "replay cases inside the slice"], ["near", "replay cases next to the slice (action and reason)"]];
const byGroup = (title: string, rs: CaseResult[], gate: boolean) =>
  GROUPS.map(([g, name]) => bySplit(`${title}: ${name}`, rs.filter((r) => groupOf.get(r.id) === g), gate)).join("\n");
const LEVEL = SHADOW
  ? "**Level: question -> delivered answer (shadow slice, release " + release.id + ").** Scored: the action; the interpretation of every answer, option continuation and alternative; the required statements on the delivered text; decline reasons by class; delivered values, directly and behind every button and alternative, against nibrs-model's independent values (raw master files; NOT MEASURED where none is given). Not measured: other sources (an option routed to Historical is not run), follow-up turns."
  : "**Level: question -> reader only.** An \"answer\" is a plan-level semantic assessment. Not measured: compiled results and numeric values (no compiler yet), routing between sources, the delivered answer and its statements, follow-ups and button continuations, the truthfulness of decline reasons (not judged), clarification options (the reader returns text).";

const md = [
  `# Answer evaluation: ${CANDIDATE}`,
  "",
  `Labeled set: ${cases.length} cases. Release for resolution: ${release.firstMonth}..${release.lastMonth}, request date ${release.asOf}.`,
  "",
  LEVEL,
  "",
  "## Execution coverage (can this candidate take the case)",
  "",
  ...list(coverage),
  "",
  "## Label eligibility (can the case be scored)",
  "",
  ...list(eligibility),
  "",
  ...(SHADOW ? ["## Refused as not built (not scored)", "", ...(notBuilt.length ? notBuilt.map((x) => `- ${x}`) : ["None."]), ""] : []),
  (SHADOW ? byGroup : bySplit)("Scored (reviewed labels, decided policy)", scored, true),
  (SHADOW ? byGroup : bySplit)("PROVISIONAL: drafted labels (never a gate)", provisional, false),
  ...(MODEL ? ["## Model rewriter", "", `Follow-ups rewritten by the hybrid rewriter: deterministic first, then the cached ${MODEL_ID} model's proposals (binding ${MODEL.binding.slice(0, 16)}, guards ${GUARD_VERSION}). Proposed (nothing ran before a simulated confirmation): ${proposals.length} (${proposals.join(", ") || "none"}). Cache misses (asked, never guessed): ${MODEL.model.misses.length}.`,
    ...MODEL.model.misses.map((m) => `- ${m}`), ""] : []),
].join("\n");
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${RUN_NAME}.md`), md);
fs.writeFileSync(path.join(OUT, `${RUN_NAME}.json`), JSON.stringify({ candidate: CANDIDATE, ...(MODEL ? { rewriter: `hybrid: deterministic, then ${MODEL_ID} proposals`, proposals, cacheMisses: MODEL.model.misses } : {}), release, coverage, eligibility, ...(SHADOW ? { notBuilt, groups: Object.fromEntries(groupOf) } : {}), scored, provisional }, null, 1) + "\n");
console.log(`${CANDIDATE}: scored ${scored.length}, provisional ${provisional.length}; run ${coverage["run by this candidate"]?.length ?? 0} of ${cases.length}`);
