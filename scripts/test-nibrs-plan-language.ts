/**
 * NIBRS plan language v1 (lib/nibrs-plan): every example plan is valid, and each validation rule refuses the plan it
 * exists to refuse. Uses a small in-memory semantic layer standing in for the shared one; no database, no model.
 */
import assert from "node:assert/strict";
import { EXAMPLES, N1, N2, N3, H1, R, ROLLING, TOP_N_PER_MONTH, MULTI_VALUE_GROUPING, D_WITHIN_RACE } from "../lib/nibrs-plan/examples";
import type { NibrsPlan } from "../lib/nibrs-plan/plan";
import type { SemanticDimension, SemanticLayer, SemanticMeasure } from "../lib/nibrs-plan/semantic";
import { validateBindings, validatePlanSemantics, validatePlanShape } from "../lib/nibrs-plan/validate";

const NIBRS: [number, number] = [1991, 2026];
const m = (id: string, entity: string, unit: SemanticMeasure["unit"]): SemanticMeasure =>
  ({ id, entity, unit, definition: id, label: id, additive: true, validYears: NIBRS });
const d = (id: string, entity: string, extra: Partial<SemanticDimension> = {}): SemanticDimension =>
  ({ id, entity, label: id, unknownCodes: ["U"], validYears: NIBRS, ...extra });

const MEASURES = [
  m("victims.murder", "victim", "victim"), m("victims.robbery", "victim", "victim"), m("victims.aggravated_assault", "victim", "victim"),
  m("offenses.murder", "offense", "offense"), m("offenses.robbery", "offense", "offense"), m("offenses.justifiable_homicide", "offense", "offense"),
  m("offenses.theft_from_motor_vehicle", "offense", "offense"), m("offenses.motor_vehicle_theft", "offense", "offense"),
  m("incidents.carjacking", "incident", "incident"), m("arrests.robbery", "arrest", "arrest"),
];
const DIMENSIONS = [
  d("time.month", "time"), d("time.year", "time"), d("geo.agency", "agency"),
  d("victim.race", "victim"), d("victim.sex", "victim"),
  d("property.loss_type", "property"), d("property.description", "property"),
  d("offense_weapon.weapon", "offense_weapon"), d("victim.relationship", "victim_offender"),
  d("victim.ethnicity_2013", "victim", { validYears: [2013, 2026] }),
];
const LINKS: Record<string, "one" | "many"> = {
  "victim>offense": "many", "victim>incident": "one", "victim>property": "many", "offense>incident": "one",
  "offense>property": "many", "offense>offense_weapon": "many", "victim>victim_offender": "many", "incident>property": "many",
};
const layer: SemanticLayer = {
  version: "nibrs-semantic/0-draft",
  measure: (id) => MEASURES.find((x) => x.id === id),
  dimension: (id) => DIMENSIONS.find((x) => x.id === id),
  cardinality: (from, to) => LINKS[`${from}>${to}`],
};

const rules = (problems: { rule: string }[]) => problems.map((p) => p.rule).sort();
const shape = (p: NibrsPlan) => rules(validatePlanShape(p));
const sem = (p: NibrsPlan) => rules(validatePlanSemantics(p, layer));

// ---- every example is valid, structurally and against the stand-in layer ----
for (const [name, plan] of Object.entries(EXAMPLES)) {
  assert.deepEqual(validatePlanShape(plan), [], `${name}: shape`);
  assert.deepEqual(validatePlanSemantics(plan, layer), [], `${name}: semantics`);
}

// ---- P: structural rules ----
assert.deepEqual(shape({ ...N3, version: "nibrs-plan/0" as never }), ["P1"]);
assert.deepEqual(shape({ ...N3, measures: [] }), ["P2", "P6"]);
assert.deepEqual(shape({ ...N3, geography: { places: [{ kind: "national" }, N3.geography.places[0]], combine: "combined" } }), ["P3"]);
assert.deepEqual(shape({ ...N3, period: { kind: "absolute", from: "2026-06", to: "2022-01" } }), ["P4"]);
assert.deepEqual(shape({ ...N3, period: { kind: "absolute", from: "2022-13", to: "2026-06" } }), ["P4"]);
assert.deepEqual(shape({ ...N1, period: { kind: "relative", anchor: "since" } }), ["P4"]);
assert.deepEqual(shape({ ...N1, groupings: [...N1.groupings, N1.groupings[0]] }), ["P5"]);
// A share partitioned on a dimension that is not a grouping, and one partitioned on every grouping (always 100%).
assert.deepEqual(shape({ ...N1, statistics: [{ kind: "share", measure: "murder_victims", partition: ["victim.age"] }] }), ["P6"]);
assert.deepEqual(shape({ ...N1, statistics: [{ kind: "share", measure: "murder_victims", partition: ["time.month", "victim.race", "victim.sex"] }] }), ["P6"]);
assert.deepEqual(shape({ ...N1, statistics: [{ kind: "count", measure: "victims" }] }), ["P6"]);
// P7-P9: filters; the incident-scoped property filter must say property is not attributed to an offense.
assert.deepEqual(shape({ ...N3, filters: [{ kind: "attribute", dimension: "victim.sex", op: "in", values: [] }] }), ["P7"]);
const n2f = N2.filters[0];
assert(n2f.kind === "exists");
assert.deepEqual(shape({ ...N2, filters: [{ ...n2f, attribution: undefined }] }), ["P9"]);
assert.deepEqual(shape({ ...N2, filters: [{ ...n2f, where: [] }] }), ["P8"]);
// P10: a rate over all reporting agency-months is refused (rates need complete agency-periods).
assert.deepEqual(shape({ ...R, coverage: { ...R.coverage, cohort: "all_reporting" } }), ["P10"]);
// P11-P13: transforms.
assert.deepEqual(shape({ ...ROLLING, groupings: [] }), ["P11"]);
assert.deepEqual(shape({ ...TOP_N_PER_MONTH, transforms: [{ kind: "top_n", n: 5, by: "motor_vehicle_thefts", direction: "top", per: ["time.month", "geo.agency"] }] }), ["P12"]);
assert.deepEqual(shape({ ...TOP_N_PER_MONTH, transforms: [{ kind: "top_n", n: 0, by: "thefts", direction: "top", per: ["time.week"] }] }), ["P12", "P12", "P12"]);
assert.deepEqual(shape({ ...N3, transforms: [{ kind: "period_comparison", earlier: { kind: "absolute", from: "2025-01", to: "2025-12" }, later: { kind: "absolute", from: "2025-06", to: "2025-12" }, outputs: ["change"] }] }), ["P13"]);
// P14: unknown months and filtered zeros are fixed rules.
assert.deepEqual(shape({ ...N3, coverage: { ...N3.coverage, filteredZero: "zero" as never } }), ["P14"]);

// ---- S: against the semantic layer ----
assert.deepEqual(sem({ ...N3, semanticVersion: "nibrs-semantic/9" }), ["S1"]);
assert.deepEqual(sem({ ...N3, measures: [{ id: "offenses.car_theft", unit: "offense", as: "x" }] }), ["S2"]);
// The unit is part of the contract: murders counted by offense are not murder victims.
assert.deepEqual(sem({ ...N1, measures: [{ id: "victims.murder", unit: "offense", as: "murder_victims" }] }), ["S2"]);
assert.deepEqual(sem({ ...N1, groupings: [...N1.groupings, { dimension: "victim.hair", unknown: "visible", absent: "zero" }] }), ["S3"]);
// A victim attribute filter on an offense measure: offense -> victim is not a declared link in the stand-in.
assert.deepEqual(sem({ ...N3, filters: [{ kind: "attribute", dimension: "victim.sex", op: "in", values: ["F"] }] }), ["S4"]);
// A property attribute used as a plain filter on an offense: many per offense, so an existence filter is required.
assert.deepEqual(sem({ ...N3, filters: [{ kind: "attribute", dimension: "property.description", op: "in", values: ["03"] }] }), ["S5"]);
// A 1:n grouping without the each-value declaration.
assert.deepEqual(sem({ ...MULTI_VALUE_GROUPING, groupings: [{ dimension: "offense_weapon.weapon", unknown: "visible", absent: "zero" }] }), ["S6"]);
// Era validity: a dimension recorded from 2013 cannot group a 2010 question.
assert.deepEqual(sem({ ...D_WITHIN_RACE, period: { kind: "absolute", from: "2010-01", to: "2010-12" }, groupings: [{ dimension: "victim.ethnicity_2013", unknown: "visible", absent: "zero" }], statistics: [{ kind: "count", measure: "murder_victims" }] }), ["S7"]);

// ---- A1: request accounting ----
const parts = [
  { concept: "measure", value: "motor_vehicle_theft", text: "Car thefts", span: [0, 10] as [number, number] },
  { concept: "place", value: "city:Baltimore:MD", text: "Baltimore", span: [14, 23] as [number, number] },
  { concept: "period", value: "monthrange:2022-01:2026-06", text: "January 2022 to June 2026", span: [33, 58] as [number, number] },
];
assert.deepEqual(rules(validateBindings({ ...N3, bindings: parts.slice(0, 2).map((part, i) => ({ part, path: ["measures[0]", "geography.places[0]"][i] })) }, parts)), ["A1"]);
assert.deepEqual(validateBindings({ ...N3, bindings: parts.map((part, i) => ({ part, path: ["measures[0]", "geography.places[0]", "period"][i] })) }, parts), []);

// ---- the frozen H1 default is recorded as a default ----
assert.equal(H1.defaults[0]?.path, "period");

console.log(`nibrs plan language: ${Object.keys(EXAMPLES).length} example plans valid; every rule refuses its case`);
