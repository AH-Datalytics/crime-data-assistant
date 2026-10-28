/**
 * The labeled interaction set (scripts/fixtures/answer-eval/cases.json) is well formed: every case parses, ids are
 * unique, a group never straddles the held-out split, buttons answer an earlier clarifying case, and every policy
 * row a case cites exists in docs/policy/nibrsai-answer-policy.csv. Offline: no database, no model, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Case, scorable } from "../lib/answer-eval/case";

const ROOT = path.join(__dirname, "..");
const file = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/answer-eval/cases.json"), "utf8"));
const policyCsv = fs.readFileSync(path.join(ROOT, "docs/policy/nibrsai-answer-policy.csv"), "utf8");
const policyIds = new Set([...policyCsv.matchAll(/^﻿?([PD]\d{2}),/gm)].map((m) => m[1]));
const openPolicy = new Set([...policyCsv.matchAll(/^﻿?(P\d{2}),.*Needs Jeff/gm)].map((m) => m[1]));

const cases = file.cases.map((c: unknown, i: number) => {
  const r = Case.safeParse(c);
  assert.ok(r.success, `case ${i}: ${r.success ? "" : r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
  return r.data!;
});
const ids = new Set<string>();
const splitOf = new Map<string, string>();
for (const c of cases) {
  assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
  ids.add(c.id);
  assert.equal(splitOf.get(c.group) ?? c.split, c.split, `group ${c.group} straddles the split`);
  splitOf.set(c.group, c.split);
  for (const p of c.policy) assert.ok(policyIds.has(p), `${c.id}: unknown policy row ${p}`);
  if (c.label.status !== "unlabeled") assert.ok(c.expected, `${c.id}: a ${c.label.status} label needs an expectation`);
  if (c.label.status === "reviewed") assert.ok(c.label.reviewed_by && c.label.reviewed_by !== c.label.drafted_by, `${c.id}: reviewed by someone other than its drafter`);
}
for (const c of cases.filter((x) => x.button)) {
  const target = cases.find((x) => x.id === c.button!.answers);
  assert.ok(target, `${c.id}: answers an unknown case`);
  if (target!.expected) {
    assert.equal(target!.expected.action, "clarify", `${c.id}: a button answers a clarifying case`);
    if (target!.expected.action === "clarify") assert.ok(target!.expected.options.some((o) => o.label === c.button!.option), `${c.id}: "${c.button!.option}" is not an option of ${target!.id}`);
  }
}
// scorable(): a case waits on its open policy rows and on review.
const sample = { ...cases[0], label: { ...cases[0].label, status: "reviewed" as const, drafted_by: "a", reviewed_by: "b" }, expected: { action: "decline" as const, reason: "x", alternative: null }, policy: ["P01"] };
assert.deepEqual(scorable(sample, new Set(["P01"])), { scored: false, why: "waits on policy P01" });
assert.deepEqual(scorable({ ...sample, policy: ["D05"] }, new Set(["P01"])), { scored: true });

const by = (f: (c: Case) => string) => Object.entries(cases.reduce((m: Record<string, number>, c) => ((m[f(c)] = (m[f(c)] ?? 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join(", ");
const scored = cases.filter((c) => scorable(c, openPolicy).scored).length;
console.log(`answer-eval cases: ${cases.length} well formed (${by((c) => c.origin.kind)}; labels: ${by((c) => c.label.status)}); scorable now ${scored}`);
