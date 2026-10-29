/**
 * Runs a candidate over the labeled set and writes a readable discrepancy report (answer evaluation part 4).
 *
 *   npx tsx scripts/run-answer-eval.ts            # writes scripts/fixtures/answer-eval/runs/nibrs-reader.{json,md}
 *
 * Candidate "nibrs-reader": today's NIBRS reader (request ledger + typed matcher) -> the plan adapter -> every plan
 * validation and release resolution. It is the question -> reader level. Values need the compiler (phase 1 steps
 * 2-3) and are reported as not measured. Cases the candidate cannot take are reported as not run, with the reason:
 * another tab (no adapter yet), a follow-up (the reader takes one turn), a button (the reader returns no
 * structured options).
 *
 * Scored: only cases whose label is reviewed and whose policy rows are all decided (scorable()). Drafted labels are
 * also compared, in a separate PROVISIONAL section that is never a gate. Offline: no database, no model, no network.
 */
import fs from "node:fs";
import path from "node:path";
import { Case, scorable } from "../lib/answer-eval/case";
import { compareMeaning, planToMeaning, type Diff, type Release } from "../lib/answer-eval/compare";
import { confusion, gates, outcomeOf, pct, severity, type ActualAction, type CaseResult } from "../lib/answer-eval/gates";
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
function notRun(c: Case): string | null {
  if (c.tab !== "nibrs") return `tab ${c.tab}: no adapter for this source yet`;
  if (c.setup.length) return "a follow-up: the reader takes one turn";
  if (c.button) return "a button: the reader returns no structured options";
  return null;
}
function run(c: Case): Run {
  const ledger = accountNibrsRequest(c.question);
  const d = matchNibrsType(ledger);
  if (d.kind === "none") return { actual: "no_reading", diffs: [], notes: ["no typed reading (today's route would hand it to another path)"] };
  if (d.kind === "clarify") return { actual: "clarify", diffs: [], notes: [d.explanation] };
  if (d.kind === "decline") return { actual: "decline", diffs: [], notes: [d.explanation] };
  const a = planFromSpec(d.spec, ledger, { semanticVersion: DRAFT_SEMANTIC_VERSION, resolvePlace });
  if (a.kind === "unmapped") return { actual: "decline", diffs: [], notes: [`adapter refused: ${a.reason}`] };
  const problems = [...parsePlan(a.plan).problems, ...validatePlanShape(a.plan), ...validatePlanSemantics(a.plan, DRAFT_LAYER), ...validateBindings(a.plan, a.parts, authority)];
  const resolved = problems.length ? null : validateResolved(a.plan, release, DRAFT_LAYER, geo);
  const all = [...problems, ...(resolved?.problems ?? [])];
  if (all.length) return { actual: "decline", diffs: [], notes: [`plan refused: ${all.map((p) => p.rule).join(", ")}`] };
  const { meaning, statistics } = planToMeaning(a.plan, resolved!.period);
  const diffs = c.expected?.action === "answer" ? compareMeaning(c.expected.meaning, meaning, release, statistics) : [];
  return { actual: "answer", diffs, notes: [] };
}

function score(c: Case, r: Run): CaseResult {
  const e = c.expected!;
  const material = r.diffs.filter((d) => d.kind === "material").length;
  const notes = [...r.notes];
  // The reader returns text, not structured options or alternatives: a clarification or decline is complete only
  // when the label expects nothing structured from it.
  let complete = true;
  if (e.action === "clarify" && r.actual === "clarify") { complete = false; notes.push("options not structured: the label's options cannot be checked"); }
  if (e.action === "decline" && r.actual === "decline" && e.alternative) { complete = false; notes.push("no alternative offered; the label expects one"); }
  const actual: ActualAction = r.actual === "no_reading" && e.action === "decline" ? "decline" : r.actual;
  const period = e.action === "answer" ? e.meaning.period : e.action === "decline" && e.alternative ? e.alternative.period : null;
  const end = period && "to" in period ? Number(period.to.slice(0, 4)) : null;
  const meaning = e.action === "answer" ? e.meaning : null;
  return {
    id: c.id, split: c.split, expected: e.action, actual, outcome: outcomeOf(e.action, actual, material, complete), diffs: r.diffs, notes,
    capability: meaning ? `${meaning.source}:${meaning.statistic}` : `nibrs:${e.action}`, era: end === null ? "relative period" : end < 2021 ? "before 2021" : "2021 and later",
  };
}

const unscored: Record<string, string[]> = {};
const scored: CaseResult[] = [];
const provisional: CaseResult[] = [];
for (const c of cases) {
  const nr = notRun(c);
  const s = scorable(c, openPolicy);
  const why = nr ?? (s.scored ? null : s.why!);
  if (why) (unscored[why.replace(/ P\d.*$/, " (open rows)").replace(/^tab \w+/, "another tab")] ??= []).push(c.id);
  if (nr || !c.expected) continue;
  const r = score(c, run(c));
  (s.scored ? scored : provisional).push(r);
}

const section = (title: string, rs: CaseResult[]) => {
  const L: string[] = [`## ${title}`, ""];
  if (!rs.length) return [...L, "No cases.", ""].join("\n");
  const n = (o: string) => rs.filter((r) => r.outcome === o).length;
  L.push(`${rs.length} cases (dev ${rs.filter((r) => r.split === "dev").length}, held out ${rs.filter((r) => r.split === "heldout").length}). Correct ${n("correct")}; wrong answers ${n("wrong_answer")}; avoidable declines ${n("avoidable_decline")}; unnecessary clarifications ${n("unnecessary_clarify")}; wrong actions ${n("wrong_action")}; incomplete ${n("incomplete")}. Severity score ${severity(rs)} (trend only).`, "");
  L.push("Expected (rows) by actual (columns):", "", "| | answer | clarify | decline | no reading |", "|---|---|---|---|---|");
  for (const [e, row] of Object.entries(confusion(rs))) L.push(`| ${e} | ${row.answer} | ${row.clarify} | ${row.decline} | ${row.no_reading} |`);
  L.push("", "| Capability | Era | Cases | Wrong | Incomplete | Initial action | Direct answers | Gate |", "|---|---|---|---|---|---|---|---|");
  for (const g of gates(rs)) L.push(`| ${g.capability} | ${g.era} | ${g.cases} | ${g.wrong} | ${g.incomplete} | ${pct(g.action, g.cases)} | ${g.answerable ? pct(g.direct, g.answerable) : "n/a"} | ${g.pass ? "pass" : `fail: ${g.why.join("; ")}`} |`);
  L.push("", "Numeric fixtures: not measured (no compiler yet; values are pending the canonical build).", "", "### Discrepancies", "");
  for (const r of rs.filter((x) => x.outcome !== "correct")) {
    const c = cases.find((x) => x.id === r.id)!;
    L.push(`- **${r.id}** (${r.outcome}; expected ${r.expected}, got ${r.actual}) "${c.question.slice(0, 140)}"`);
    for (const d of r.diffs) L.push(`  - ${d.kind} ${d.field}: expected \`${d.expected}\`, got \`${d.actual}\``);
    for (const t of r.notes) L.push(`  - ${t.slice(0, 220)}`);
  }
  return [...L, ""].join("\n");
};

const md = [
  `# Answer evaluation: ${CANDIDATE}`,
  "",
  `Labeled set: ${cases.length} cases. Release for resolution: ${release.firstMonth}..${release.lastMonth}, request date ${release.asOf}. Level: question -> reader (values not measured).`,
  "",
  "## Not scored",
  "",
  ...Object.entries(unscored).sort((a, b) => b[1].length - a[1].length).map(([why, ids]) => `- ${ids.length}: ${why}`),
  "",
  section("Scored (reviewed labels, decided policy)", scored),
  section("PROVISIONAL: drafted or open-policy labels (never a gate)", provisional),
].join("\n");
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${CANDIDATE}.md`), md);
fs.writeFileSync(path.join(OUT, `${CANDIDATE}.json`), JSON.stringify({ candidate: CANDIDATE, release, unscored, scored, provisional }, null, 1) + "\n");
console.log(`${CANDIDATE}: scored ${scored.length}, provisional ${provisional.length}, not scored ${Object.values(unscored).reduce((s, x) => s + x.length, 0)}`);
