/**
 * The cube's measure guard (correctness work 2b): every measure the engine's vocabulary knows is either on the cube's approved list, with the questions that prove a cube statement is built
 * for it and that the runner compares against raw, or runs from the raw statements with a reason. Offline: the engine reads questions and builds statements against a stand-in cube
 * configuration (nothing is read); lib/nibrs-plan/cube-measures.json, the two question files and the router must agree. Run `npx tsx scripts/gen-cube-measure-checks.ts` to rewrite the files
 * after a change that is meant (a new measure, a new cube form), then read the diff: an approval is a decision.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import approvals from "../lib/nibrs-plan/cube-measures.json";
import { cubeServesMeasure, knownMeasureNames } from "../lib/nibrs-plan/compile";
import { MEASURE_CODES, MEASURE_LABEL } from "../lib/nibrs-question-types";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { loadNibrsRelease } from "../lib/nibrs-shadow/release";
import { FORMS, MEASURE_NOUNS, MEMPHIS, YEAR } from "./lib/cube-measure-forms";
import { routesToCube, stand_in_cube } from "./lib/cube-routing-probe";

console.log("cube measure guard: every measure is approved with its checks or runs raw");

const approved = approvals.approved as Record<string, { questions: string[] }>;
const raw = approvals.raw as Record<string, string>;
const names = knownMeasureNames();

// 1. Every known measure is classified, exactly once; nothing stale.
for (const m of names) assert.ok((m in approved) !== (m in raw), `the measure "${m}" must be in cube-measures.json as approved or raw (exactly one): classify it with scripts/gen-cube-measure-checks.ts`);
for (const m of [...Object.keys(approved), ...Object.keys(raw)]) assert.ok(names.includes(m), `cube-measures.json names "${m}", which the vocabulary no longer knows: regenerate`);
for (const [m, why] of Object.entries(raw)) assert.ok(typeof why === "string" && why.length > 10, `the raw measure "${m}" needs its reason`);

// 2. The router follows the file, for every measure id of every kind.
for (const m of names) for (const kind of ["victims", "offenders", "arrests", "offenses", "incidents"]) assert.equal(cubeServesMeasure(`${kind}.${m}`), m in approved, `${kind}.${m}`);
assert.ok(!cubeServesMeasure("victims.some_new_measure") && !cubeServesMeasure("victims") && !cubeServesMeasure(""), "an unknown measure is never read from a cube");

// 3. Each approved measure has its questions, and each reaches a cube with the guard ON (the way production routes).
const rel = loadNibrsRelease();
const places = loadPlaceIndex();
const years = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const cube = stand_in_cube(Object.values(MEASURE_CODES).flat().concat(["35A", "35B"]), years);
const sqls: string[] = [];
const deps = (guardOff: boolean): ShadowDeps => ({ places, release: { id: rel.id, firstMonth: rel.firstMonth, lastMonth: rel.lastMonth, asOf: "2026-11-04" },
  target: { root: "/stand-in/canonical", builtYears: years, cube, ...(guardOff ? { cubeAllMeasures: true } : {}) }, execute: (sql: string) => { sqls.push(sql); return []; } }) as unknown as ShadowDeps;
const routes = (q: string, guardOff = false) => routesToCube(() => shadowAnswer(q, deps(guardOff)), sqls);

const memphisFile = fs.readFileSync("scripts/fixtures/nibrs-cube-measures-questions.txt", "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
for (const [m, v] of Object.entries(approved)) {
  assert.ok(v.questions.length > 0, `the approved measure "${m}" has no question`);
  for (const q of v.questions) {
    assert.ok(memphisFile.includes(q), `the question for "${m}" is missing from nibrs-cube-measures-questions.txt: ${q}`);
    assert.ok(routes(q), `the approved measure "${m}": its question no longer reaches a cube: ${q}`);
  }
}
assert.deepEqual([...memphisFile].sort(), Object.values(approved).flatMap((v) => v.questions).sort(), "nibrs-cube-measures-questions.txt is exactly the approved questions");

// 4. A raw measure is never read from a cube whatever the question form (with the guard ON), and the shadow list holds only approved forms.
for (const m of Object.keys(raw)) {
  const nouns = [...(MEASURE_NOUNS[m] ?? []), ...(MEASURE_NOUNS[m] && MEASURE_LABEL[m] ? [MEASURE_LABEL[m]] : [])];
  for (const n of nouns) for (const f of FORMS(n, MEMPHIS, YEAR)) assert.ok(!routes(f.q), `the raw measure "${m}" reaches a cube with "${f.q}": approve it (with the runner's check) or fix the router`);
}
const shadow = fs.readFileSync("scripts/fixtures/nibrs-cube-shadow-questions.txt", "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
const memphisForms = new Set(memphisFile.map((q) => q.replace(MEMPHIS, "@")));
assert.ok(shadow.length > 0, "the shadow list is not empty");
for (const q of shadow) assert.ok([...memphisForms].some((f) => { const [a, b] = f.split("@"); return q.startsWith(a) && q.endsWith(b); }), `a shadow question that is not an approved form: ${q}`);

// 5. The stand-in probe itself works: with the guard OFF a raw measure's form would route, so step 4 is not vacuous.
assert.ok(routes("robberies by location in Memphis, Tennessee in 2024", true) && routes("robberies by location in Memphis, Tennessee in 2024"), "a plain approved form routes");
assert.ok(!routes("carjackings by location in Memphis, Tennessee in 2024"), "carjacking is not read from a cube");

console.log(`cube measure guard: ${Object.keys(approved).length} approved measures, ${Object.keys(raw).length} raw, ${memphisFile.length} checked questions, ${shadow.length} shadow questions: ok`);
