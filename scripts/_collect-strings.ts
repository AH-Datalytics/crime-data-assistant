// Probe (deleted before the PR): every user-facing string the shadow produces for the case questions, follow-ups and
// their buttons, on the local build. Writes the distinct strings with where they came from and their engine words.
import fs from "node:fs";
import { shadowAnswer, shadowFollowUp, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { jargon } from "../lib/nibrs-shadow/wording";
const deps: ShadowDeps = { places: loadPlaceIndex(), release: { id: "20261028-test5", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" } as ShadowDeps["release"],
  target: { root: "C:/Users/jeffm/nibrs-model/work/build/20261028-test5/canonical", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  execute: duckdbExecutor("C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe") };
const cf = JSON.parse(fs.readFileSync("scripts/fixtures/answer-eval/cases.json", "utf8")); const cases = (cf.cases ?? cf) as any[];
const seen = new Map<string, { kind: string; from: string[] }>();
const add = (text: string | undefined, kind: string, from: string) => { if (!text) return; const e = seen.get(text) ?? { kind, from: [] }; if (e.from.length < 3) e.from.push(from); seen.set(text, e); };
function walk(o: ShadowOutcome | any, from: string, depth: number) {
  if (!o) return;
  if (o.kind === "decline") { add(o.explanation, "decline", from); if (o.alternative) { add(o.alternative.label, "button", from); if (depth < 2) walk(o.alternative.continuation, from + " >alt", depth + 1); } }
  if (o.kind === "route") add(o.explanation, "route", from);
  if (o.kind === "clarify") { add(o.about, "clarify", from); for (const op of o.options ?? []) { add(op.label, "button", from); if (op.entry) add(op.entry, "entry", from); if (depth < 2) walk(op.continuation, `${from} >${op.label}`, depth + 1); } }
  if (o.kind === "answer") { for (const t of o.delivered?.text ?? []) add(t, "answer text", from); for (const c of o.delivered?.table?.columns ?? []) add(c.header, "column", from);
    for (const b of o.buttons ?? []) { add(b.label, "button", from); if (depth < 2) walk(b.continuation, `${from} >${b.label}`, depth + 1); } }
  if (o.kind === "srs") for (const t of o.text ?? o.delivered?.text ?? []) add(t, "answer text", from);
  if (o.kind === "proposal") add(o.proposed, "proposal", from);
}
for (const c of cases) {
  try {
    for (const s of c.setup ?? []) walk(shadowAnswer(s.question, deps), `${c.id} setup`, 0);
    walk(c.setup?.length && c.rewrite !== undefined ? shadowFollowUp(c.setup[c.setup.length - 1].question, c.question, deps) : shadowAnswer(c.question, deps), c.id, 0);
  } catch (e) { add(`ERROR ${String(e).slice(0, 120)}`, "error", c.id); }
}
const out = [...seen].map(([text, v]) => ({ text, kind: v.kind, from: v.from, jargon: jargon(text) }));
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log(`distinct strings ${out.length}; with engine words ${out.filter((x) => x.jargon.length).length}`);
