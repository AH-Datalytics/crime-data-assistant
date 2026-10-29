/**
 * Runs a candidate over the labeled set and writes a readable discrepancy report (answer evaluation part 4).
 *
 *   npx tsx scripts/run-answer-eval.ts            # writes scripts/fixtures/answer-eval/runs/nibrs-reader.{json,md}
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

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "scripts/fixtures/answer-eval/runs");
const CANDIDATE = "nibrs-reader";
const release: Release & { id: string } = { id: "eval", firstMonth: "1991-01", lastMonth: "2026-10", asOf: "2026-10-28" };
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
for (const c of cases) {
  const s = scorable(c, openPolicy);
  (eligibility[s.scored ? "scorable (reviewed, decided policy)" : s.why!.replace(/ P\d.*$/, " (open rows)")] ??= []).push(c.id);
  const nr = notRun(c);
  (coverage[nr ?? "run by this candidate"] ??= []).push(c.id);
  if (nr || !c.expected) continue;
  const res = score(c, run(c));
  (s.scored ? scored : provisional).push(res);
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

const md = [
  `# Answer evaluation: ${CANDIDATE}`,
  "",
  `Labeled set: ${cases.length} cases. Release for resolution: ${release.firstMonth}..${release.lastMonth}, request date ${release.asOf}.`,
  "",
  "**Level: question -> reader only.** An \"answer\" is a plan-level semantic assessment. Not measured: compiled results and numeric values (no compiler yet), routing between sources, the delivered answer and its statements, follow-ups and button continuations, the truthfulness of decline reasons (not judged), clarification options (the reader returns text).",
  "",
  "## Execution coverage (can this candidate take the case)",
  "",
  ...list(coverage),
  "",
  "## Label eligibility (can the case be scored)",
  "",
  ...list(eligibility),
  "",
  bySplit("Scored (reviewed labels, decided policy)", scored, true),
  bySplit("PROVISIONAL: drafted labels (never a gate)", provisional, false),
].join("\n");
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${CANDIDATE}.md`), md);
fs.writeFileSync(path.join(OUT, `${CANDIDATE}.json`), JSON.stringify({ candidate: CANDIDATE, release, coverage, eligibility, scored, provisional }, null, 1) + "\n");
console.log(`${CANDIDATE}: scored ${scored.length}, provisional ${provisional.length}; run ${coverage["run by this candidate"]?.length ?? 0} of ${cases.length}`);
