/**
 * The answer contract (docs/superpowers/specs/2026-10-28-answer-columns-and-chart-labels.md): an answer's columns are
 * groupings and measures; the listed annotation columns never reach the user. The list is explicit, so a substantive
 * category (clearance_status, *_label) is never dropped by a name match.
 *   npx tsx scripts/test-answer-columns.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { annotationDropTagsFor, finalizeProof, emitFactualPayload, payloadDropTags, type ProofFinalizationInput } from "../lib/proof-finalize";
import { serializeChartConfigForLog } from "../lib/chart-config-log";
import { detectAndPivotChartData } from "../lib/chart-layout";
import { tableDisplay } from "../lib/table-display";
import { OUTCOMES } from "../lib/proof-contract";
import { runInner } from "../lib/why-scope";
import {
  ANSWER_ANNOTATIONS, LABEL_COLUMNS, STAFFING_LABEL_COLUMN, annotationDropTags, isAnswerAnnotation, projectAnswer,
  projectPayload, reconcileChartConfig,
} from "../lib/answer-columns";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}

check("the listed annotations are dropped from columns and rows, in order", () => {
  const out = projectAnswer(["place", "year", "victims", "shr_records"], [
    { place: "Houston, TX", year: 2024, victims: 12, shr_records: "recorded" },
    { place: "Houston, TX", year: 2025, victims: null, shr_records: "no SHR records (unknown)" },
  ]);
  assert.deepEqual(out.columns, ["place", "year", "victims"]);
  assert.deepEqual(out.rows, [{ place: "Houston, TX", year: 2024, victims: 12 }, { place: "Houston, TX", year: 2025, victims: null }]);
  assert.deepEqual(out.dropped, ["shr_records"]);
});

check("unknown stays a blank measure; a requested all-blank measure is kept", () => {
  const out = projectAnswer(["year", "rate_per_100k", "note"], [{ year: 2024, rate_per_100k: null, note: "no population" }]);
  assert.deepEqual(out.columns, ["year", "rate_per_100k"]);
  assert.deepEqual(out.rows, [{ year: 2024, rate_per_100k: null }]);
});

check("substantive categories and labels are never dropped", () => {
  const cols = ["race", "clearance_status", "victims", "jurisdiction_label", "agency_label", "place_label", "status_code"];
  const row = Object.fromEntries(cols.map((c) => [c, c === "victims" ? 3 : "x"]));
  const out = projectAnswer(cols, [row]);
  assert.deepEqual(out.columns, cols);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.rows[0], row, "nothing to drop: the same row object");
});

check("the staffing label column is not an annotation and is a label column", () => {
  assert.equal(isAnswerAnnotation(STAFFING_LABEL_COLUMN), false);
  assert.ok(LABEL_COLUMNS.has(STAFFING_LABEL_COLUMN));
  assert.deepEqual([...LABEL_COLUMNS], [STAFFING_LABEL_COLUMN], "the label allowlist has exactly one entry");
});

check("the list is explicit names, matched case-insensitively", () => {
  for (const name of ANSWER_ANNOTATIONS) assert.match(name, /^[a-z_]+$/, `${name} is a plain name`);
  assert.equal(isAnswerAnnotation("NOTE"), true);
  assert.equal(isAnswerAnnotation("victim_note_count"), false);
  assert.equal(isAnswerAnnotation("population"), false);
});

check("an annotation only in row keys (not in columns) is dropped too", () => {
  const out = projectAnswer(["month", "murder_victims"], [{ month: "2025-01", murder_victims: 4, shr_status: "complete" }]);
  assert.deepEqual(out.rows, [{ month: "2025-01", murder_victims: 4 }]);
  assert.deepEqual(out.dropped, ["shr_status"]);
});

check("legacy staffing: data_type 'Officers'/'Employees*' becomes reported, not dropped (phase 2)", () => {
  const out = projectAnswer(["year", "staffing", "data_type"], [
    { year: 2018, staffing: 1500, data_type: "Officers" },
    { year: 2019, staffing: 2000, data_type: "Employees*" },
  ]);
  assert.deepEqual(out.columns, ["year", "staffing", "reported"]);
  assert.deepEqual(out.rows.map((r) => r.reported), ["Officers", "Employees"]);
  assert.deepEqual(out.dropped, []);
  const payload = { columns: ["year", "staffing", "data_type"], rows: [{ year: 2019, staffing: 2000, data_type: "Employees*" }] };
  assert.deepEqual(projectPayload(payload).columns, ["year", "staffing", "reported"], "the payload is renamed too");
});

check("a data_type that is not the staffing marker is an annotation and is dropped", () => {
  const out = projectAnswer(["year", "value", "data_type"], [{ year: 2018, value: 1, data_type: "estimate" }]);
  assert.deepEqual(out.columns, ["year", "value"]);
  assert.deepEqual(out.dropped, ["data_type"]);
});

check("chart pivot by agency keeps each agency's reported label and never splits on it", () => {
  const rows = [
    { year: 2019, place: "Fort Worth", value: 2000, reported: "Employees" },
    { year: 2019, place: "Arlington", value: 600, reported: "Officers" },
    { year: 2020, place: "Fort Worth", value: 1502, reported: "Officers" },
    { year: 2020, place: "Arlington", value: 610, reported: "Officers" },
  ];
  const p = detectAndPivotChartData(rows, "year", ["value"]);
  assert.deepEqual(p.effectiveYKeys, ["Fort Worth", "Arlington"]);
  assert.deepEqual(p.data[0], { year: 2019, "Fort Worth": 2000, "Fort Worth::reported": "Employees", Arlington: 600, "Arlington::reported": "Officers" });
  const single = detectAndPivotChartData(rows.filter((r) => r.place === "Fort Worth"), "year", ["value"]);
  assert.deepEqual(single.effectiveYKeys, ["value"], "one agency: reported is not a series");
});

check("staffing value headers name the measure and keep a rate's denominator", () => {
  const rows = [{ year: 2018, place: "Fort Worth, TX", measure: "officers_or_employees", statistic: "per_1000", value: 1.7, reported: "Officers" },
    { year: 2019, place: "Fort Worth, TX", measure: "officers_or_employees", statistic: "per_1000", value: 2.2, reported: "Employees" }];
  const d = tableDisplay(["year", "place", "measure", "statistic", "value", "reported"], rows, "Fort Worth");
  assert.equal(d.labels.value, "Sworn officers (total employees where marked) per 1,000 residents");
  assert.ok(d.shown.includes("reported"), "the reported column is shown");
  const counts = tableDisplay(["year", "measure", "statistic", "value"], [{ year: 2018, measure: "officers", statistic: "count", value: 1500 }], "");
  assert.equal(counts.labels.value, "Sworn officers", "not 'officers offenses'");
});

check("drop tags", () => {
  assert.deepEqual(annotationDropTags(["note", "data_type"]), ["answer-annotation-dropped:note", "answer-annotation-dropped:data_type"]);
});

check("pure: the same input gives equal output twice, and the input is not mutated", () => {
  const cols = ["year", "value", "note"];
  const rows = [{ year: 2020, value: 1, note: "x" }];
  const a = projectAnswer(cols, rows);
  const b = projectAnswer(cols, rows);
  assert.deepEqual(a, b);
  assert.deepEqual(cols, ["year", "value", "note"]);
  assert.deepEqual(rows, [{ year: 2020, value: 1, note: "x" }]);
});

check("chart config: a series on a dropped column is removed", () => {
  const cfg = { type: "line", xAxis: "year", yAxis: ["value", "note"], title: "T" };
  assert.deepEqual(reconcileChartConfig(cfg, ["note"]), { type: "line", xAxis: "year", yAxis: ["value"], title: "T" });
});

check("chart config: no series left, or an x axis on a dropped column, means no chart", () => {
  assert.equal(reconcileChartConfig({ xAxis: "year", yAxis: ["note"] }, ["note"]), null);
  assert.equal(reconcileChartConfig({ xAxis: "data_type", yAxis: ["value"] }, ["data_type"]), null);
});

check("chart config: untouched when nothing it uses was dropped", () => {
  const cfg = { xAxis: "year", yAxis: ["value"] };
  assert.equal(reconcileChartConfig(cfg, ["note"]), cfg);
  assert.equal(reconcileChartConfig(null, ["note"]), null);
});

check("payload: columns, rows and chart projected; everything else kept", () => {
  const payload = {
    success: true, explanation: "E", columns: ["year", "value", "note"], rows: [{ year: 2020, value: 1, note: "x" }],
    chartConfig: { xAxis: "year", yAxis: ["value"] }, chartMeta: { source: "RTCI" },
  };
  const out = projectPayload(payload);
  assert.deepEqual(out.columns, ["year", "value"]);
  assert.deepEqual(out.rows, [{ year: 2020, value: 1 }]);
  assert.equal(out.explanation, "E");
  assert.equal(out.chartMeta, payload.chartMeta);
  assert.deepEqual(payload.columns, ["year", "value", "note"], "input payload not mutated");
});

check("payload: one without an answer, or with nothing to drop, is returned as is", () => {
  const plain = { success: false, error: "x" };
  assert.equal(projectPayload(plain), plain);
  const clean = { columns: ["year"], rows: [{ year: 1 }] };
  assert.equal(projectPayload(clean), clean);
});

// The two choke points every answer route passes through (lib/proof-finalize.ts).
const withNote = {
  columns: ["year", "agency", "murders", "note"],
  rows: [{ year: 2018, agency: "Baton Rouge", murders: 60, note: null }, { year: 2019, agency: "Baton Rouge", murders: null, note: "no report" }],
};
function input(env: Record<string, string>): ProofFinalizationInput {
  return {
    sourceId: "current", question: "murders in Baton Rouge from 2018 to 2019",
    sql: "SELECT year, agency, murders, note FROM t", rows: withNote.rows, columns: withNote.columns, truncated: false,
    planFamily: null, outcome: OUTCOMES.deterministic_plan, env,
  } as ProofFinalizationInput;
}

const pending: Promise<void>[] = [];
for (const env of [{}, { PROOF_MODE: "shadow" }] as Record<string, string>[]) {
  const mode = Object.keys(env).length ? "shadow" : "off";
  pending.push((async () => {
    try {
      let emitted: Record<string, unknown> | null = null;
      const store = await runInner("data", async () => {
        const fin = finalizeProof(input(env));
        emitted = emitFactualPayload(fin, { success: true, ...withNote, chartConfig: { xAxis: "year", yAxis: ["murders"] } }) as unknown as Record<string, unknown>;
      });
      const cap = store.captures[0];
      const finalized = cap.input as ProofFinalizationInput;
      assert.ok(emitted);
      const out = emitted as Record<string, unknown>;
      assert.deepEqual(out.columns, ["year", "agency", "murders"], `${mode}: emitted columns`);
      assert.deepEqual(finalized.columns, out.columns, `${mode}: finalized columns = emitted columns`);
      assert.deepEqual(finalized.rows, out.rows, `${mode}: finalized rows = emitted rows`);
      assert.equal((out.rows as Record<string, unknown>[])[1].murders, null, `${mode}: unknown stays blank`);
      assert.deepEqual(cap.payload.columns, withNote.columns, `${mode}: the internal capture keeps its notes for "why"`);
      passed += 1; console.log(`  PASS  choke points agree (${mode}): finalized = emitted, notes kept internal only`);
    } catch (e) { failed += 1; console.log(`  FAIL  choke points agree (${mode})\n        ${(e as Error).message}`); }
  })());
}

check("the request log gets a drop tag per removed annotation (Codex implementation review #4)", () => {
  const fin = finalizeProof(input({}));
  assert.deepEqual(annotationDropTagsFor(fin), ["answer-annotation-dropped:note"]);
  const clean = finalizeProof({ ...input({}), columns: ["year"], rows: [{ year: 1 }] });
  assert.deepEqual(annotationDropTagsFor(clean), []);
  assert.deepEqual(annotationDropTagsFor(null), []);
});

check("the chart log records the delivered chart: annotation columns and series removed", () => {
  const logged = JSON.parse(serializeChartConfigForLog({ type: "line", xAxis: "year", yAxis: ["value", "note"], title: "T" } as never, ["year", "value", "note"]) as string);
  assert.deepEqual(logged.yAxis, ["value"]);
  assert.equal(logged.seriesCount, 1);
  assert.ok(!logged.columns.includes("note"), `columns ${JSON.stringify(logged.columns)}`);
  assert.equal(serializeChartConfigForLog({ type: "line", xAxis: "year", yAxis: ["note"], title: "T" } as never, ["year", "note"]), null, "no series left: no chart logged");
});

// Codex implementation review r2: a "why" turn's outer finalization re-uses the capture's projected input, so its own
// finalization records no drops; the log tags come from the captured payload instead, and the delivered answer is
// still projected.
pending.push((async () => {
  try {
    const store = await runInner("data", async () => {
      const fin = finalizeProof(input({}));
      emitFactualPayload(fin, { success: true, ...withNote });
    });
    const cap = store.captures[0];
    const outer = finalizeProof({ ...(cap.input as ProofFinalizationInput), env: {} });
    assert.deepEqual(annotationDropTagsFor(outer), [], "the outer finalization saw an already-projected input");
    assert.deepEqual(payloadDropTags(cap.payload), ["answer-annotation-dropped:note"], "the captured payload still carries the note");
    const delivered = emitFactualPayload(outer, { ...cap.payload }) as unknown as Record<string, unknown>;
    assert.deepEqual(delivered.columns, ["year", "agency", "murders"]);
    for (const f of ["app/api/query/route.ts", "app/api/nibrs-query/route.ts", "app/api/shr-query/route.ts"]) {
      assert.match(fs.readFileSync(f, "utf8"), /why\.tags, \.\.\.payloadDropTags\(cap\.payload\)\]/, `${f} logs the why turn's drop tags`);
    }
    passed += 1; console.log("  PASS  why turn: capture -> outer finalization -> log tags from the captured payload");
  } catch (e) { failed += 1; console.log(`  FAIL  why turn drop tags\n        ${(e as Error).message}`); }
})());

check("emission with nothing to drop is referentially identical (off mode)", () => {
  const fin = finalizeProof({ ...input({}), columns: ["year"], rows: [{ year: 1 }] });
  const payload = { columns: ["year"], rows: [{ year: 1 }] };
  assert.equal(emitFactualPayload(fin, payload), payload);
});

void Promise.all(pending).then(() => {
  console.log(`\nanswer columns: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
