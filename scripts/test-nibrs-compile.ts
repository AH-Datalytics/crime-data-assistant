/**
 * The plan -> DuckDB compiler v0 (lib/nibrs-plan/compile.ts) compiles the agency-level forms and refuses the rest with
 * a reason. Offline: checks the SQL it emits, never runs it (scripts/nibrs-compile-gate.ts runs the correctness cases
 * against a local canonical build). No database, no model, no network.
 */
import assert from "node:assert/strict";
import { compilePlan } from "../lib/nibrs-plan/compile";
import * as X from "../lib/nibrs-plan/examples";

const t = { root: "/build/canonical", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] };
const year = (y: number) => ({ kind: "absolute" as const, from: `${y}-01`, to: `${y}-12` });
const ok = (r: ReturnType<typeof compilePlan>) => { assert(r.kind === "query", r.kind === "unsupported" ? r.reason : ""); return r.query; };

// H1: Memphis carjackings by month in 2025.
const h1 = ok(compilePlan(X.H1, year(2025), t));
assert.deepEqual(h1.columns, ["period", X.H1.statistics[0].as, `${X.H1.statistics[0].as}_status`]);
assert.deepEqual(h1.scanYears, [2025, 2026], "a later year's file can hold the period's incidents");
for (const s of ["offense_code = '120'", "p.loss_type = '7'", "'03', '05', '24', '28', '37'", "u.ori = 'TNMPD0000'", "agency_month_status", "UNKNOWN_UNEVIDENCED_ZERO", "BETWEEN '202501' AND '202512'", "EVIDENCE_CONFLICT"]) assert.ok(h1.sql.includes(s), s);
assert.ok(!h1.sql.includes("data_year=2024"), "no year before the period is scanned");
assert.deepEqual(h1.refuseOn, ["EVIDENCE_CONFLICT"]);
assert.deepEqual(h1.statements, []);

// H2 (a total) and H3 (by year): a year is known only when every month is.
assert.deepEqual(ok(compilePlan(X.H2, year(2025), t)).columns, [X.H2.statistics[0].as, `${X.H2.statistics[0].as}_status`]);
assert.ok(ok(compilePlan(X.H3, { kind: "absolute", from: "2020-01", to: "2025-12" }, t)).sql.includes("bool_and"));

// N3: offense segments keep their occurrence key.
const n3 = ok(compilePlan(X.N3, { kind: "absolute", from: "2022-01", to: "2026-06" }, t));
assert.ok(n3.sql.includes("o.offense_code IN ('240')") && n3.sql.includes("o.offense_code || ':' || o.key_occurrence"));

// N1: victims by race and sex, per month, with each month's share: every category in every month, shares over the
// month's own units.
const n1 = ok(compilePlan(X.N1, { kind: "absolute", from: "2018-01", to: "2026-10" }, t));
assert.deepEqual(n1.columns, ["period", "victim.race", "victim.sex", "victims", "victims_status", "share_of_month", "share_of_month_status"]);
for (const s of ["v.race AS g0", "v.sex AS g1", "cats AS (SELECT DISTINCT g0, g1 FROM scoped)", "CROSS JOIN cats", "n::DOUBLE / den", "vo.connected_offense IN ('09A')"]) assert.ok(n1.sql.includes(s), s);

// N2: 23F offenses in incidents with a stolen firearm: an incident-level existence over property, and its statement.
const n2 = ok(compilePlan(X.N2, year(2024), t));
assert.ok(n2.sql.includes("p.loss_type IN ('7') AND p.property_description IN ('13')"));
assert.deepEqual(n2.statements, ["property_not_attributed"]);

// Everything outside v0 is refused, with its reason.
const refuse = (p: Parameters<typeof compilePlan>[0], period: Parameters<typeof compilePlan>[1] = year(2025)) => { const r = compilePlan(p, period, t); assert.equal(r.kind, "unsupported"); return r.kind === "unsupported" ? r.reason : ""; };
assert.match(refuse(X.SEPARATE_YEARS, { kind: "years", years: [2019, 2024] }), /absolute periods/);
assert.match(refuse(X.ROLLING), /transforms|one place|agency/);
assert.match(refuse(X.SAME_AGENCIES_CHANGE), /transforms|cohort|agency/);
assert.match(refuse({ ...X.H2, measures: [{ id: "incidents.nope", unit: "incident", as: "x" }], statistics: [{ kind: "count", as: "c", measure: "x" }] }), /no executable definition/);
assert.match(refuse(X.H2, year(2027)), /no built data year/);
assert.match(refuse({ ...X.H2, geography: { places: [{ kind: "state", code: "TX" }], combine: "separate" } }), /status evidence/);
assert.match(refuse({ ...X.H2, timeBasis: "arrest_date" }), /incident date/);
assert.match(refuse({ ...X.H1, groupings: [{ ...X.H1.groupings[0], absent: "omit" }] }), /every category/);
const withMeasure = (id: string, unit: "offense" | "incident" | "victim") => ({ ...X.H2, measures: [{ id, unit, as: "x" }], statistics: [{ kind: "count" as const, as: "c", measure: "x" }] });
assert.match(refuse(withMeasure("offenses.motor_vehicle_theft.typo", "offense")), /no executable definition/);
assert.match(refuse(withMeasure("offenses.dui", "offense")), /Group B/);
assert.match(refuse(withMeasure("victims.burglary", "victim")), /not crimes against persons/);
// D18: carjacking by offense keeps each 120 segment's occurrence key; by incident it stays distinct incidents.
const cjOff = ok(compilePlan({ ...X.H2, measures: [{ ...X.H2.measures[0], id: "offenses.carjacking", unit: "offense" }] }, year(2025), t));
assert.ok(cjOff.sql.includes("o.offense_code || ':' || o.key_occurrence AS sub") && cjOff.sql.includes("o.offense_code = '120'") && cjOff.sql.includes("'03', '05', '24', '28', '37'"));
assert.match(refuse({ ...X.H2, measures: [{ ...X.H2.measures[0], id: "offenses.carjacking", unit: "incident" }] }), /counted by offense/);
// New forms' limits: an attribute the counted entity does not hold; a share without categories; a negated or
// non-property existence; a property condition v0 cannot apply.
assert.match(refuse({ ...X.N1, groupings: [X.N1.groupings[0], { ...X.N1.groupings[1], dimension: "offender.race" }] }), /cannot group victim by offender.race/);
assert.match(refuse({ ...X.N1, groupings: [X.N1.groupings[0]] }), /share only/);
assert.match(refuse({ ...X.N2, filters: [{ ...X.N2.filters[0], negate: true } as never] }), /existences over incident property/);
assert.match(refuse({ ...X.N2, filters: [{ ...X.N2.filters[0], where: [{ kind: "attribute", dimension: "property.value", op: "in", values: [1] }] } as never] }), /property condition/);

// Increment 2. A plan of one measure, grouped as given, with the filters given.
type Plan = Parameters<typeof compilePlan>[0];
type G = Plan["groupings"][number];
const by = (dimension: string, more: Partial<G> = {}): G => ({ dimension, absent: "show", ...more } as G);
const plan = (id: string, unit: string, groupings: G[] = [], filters: unknown[] = [], timeBasis = "incident_date") =>
  ({ ...X.H2, timeBasis, measures: [{ id, unit, as: "x" }], statistics: [{ kind: "count", as: "c", measure: "x" }], groupings, filters } as Plan);
const firearm = ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"];
const weapon = (scope: string, values: string[]) => ({ kind: "exists", scope, entity: "offense_weapon", where: [{ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values }] });

// Weapons of an offense: multi-valued, by LEFT JOIN on the offense's own keys, and the overlap statement.
const byWeapon = ok(compilePlan(plan("offenses.robbery", "offense", [by("offense_weapon.weapon", { multiValue: "each_value" })]), year(2023), t));
for (const s of ["LEFT JOIN read_parquet", "w.offense_code = o.offense_code", "w.key_occurrence = o.key_occurrence", "w.weapon AS g0", "COUNT(DISTINCT (u.data_year, u.ori, u.incident_num, u.sub))"]) assert.ok(byWeapon.sql.includes(s), s);
assert.deepEqual(byWeapon.statements, ["categories_overlap"]);
assert.match(refuse(plan("offenses.robbery", "offense", [by("offense_weapon.weapon")])), /multi-valued/);
assert.match(refuse(plan("offenses.robbery", "offense", [by("offense.location_type", { multiValue: "each_value" })])), /one value per unit/);
// Relationships of a victim; the incident's offender sexes for a crime (P49), offender 00 its own category.
assert.ok(ok(compilePlan(plan("victims.murder", "victim", [by("victim_offender.relationship", { multiValue: "each_value" })]), year(2023), t)).sql.includes("r.victim_seq = v.victim_seq"));
const p49 = ok(compilePlan(plan("victims.simple_assault", "victim", [by("offender.sex", { multiValue: "each_value" })]), year(2024), t));
assert.ok(p49.sql.includes("WHEN f2.offender_seq = '00' THEN 'unknown_offender'") && p49.sql.includes("f2.incident_num = v.incident_num"));
// key_occurrence joins a parent segment to its own children only, never one segment family to another (Codex review 02).
assert.ok(!p49.sql.includes("f2.key_occurrence") && !ok(compilePlan(plan("offenders.robbery", "offender"), year(2024), t)).sql.includes("o.key_occurrence = f.key_occurrence"));
// Age in bins (P30): infants under 18, 00 Unknown, blank not recorded; bins required, and never overlapping.
const bins = [{ label: "Under 18", from: 1, to: 17 }, { label: "18-24", from: 18, to: 24 }, { label: "65+", from: 65, to: 99 }];
const byAge = ok(compilePlan(plan("victims.aggravated_assault", "victim", [by("victim.age", { bins })]), year(2024), t));
for (const s of ["WHEN v.age IN ('NN', 'NB', 'BB') THEN 'Under 18'", "WHEN v.age = '00' THEN 'Unknown'", "trim(v.age) = '' THEN NULL", "BETWEEN 65 AND 99 THEN '65+'"]) assert.ok(byAge.sql.includes(s), s);
assert.match(refuse(plan("victims.aggravated_assault", "victim", [by("victim.age")])), /in bins/);
assert.match(refuse(plan("victims.aggravated_assault", "victim", [by("victim.age", { bins: [...bins, { label: "x", from: 20, to: 30 }] })])), /overlap/);
assert.match(refuse(plan("victims.aggravated_assault", "victim", [by("victim.sex", { bins })])), /bins ages only/);
// Offenders (P44): offender segments of incidents with the codes, by their own sex.
const offenders = ok(compilePlan(plan("offenders.robbery", "offender", [by("offender.sex")]), year(2024), t));
assert.ok(offenders.sql.includes("f.offender_seq || ':' || f.key_occurrence AS sub") && offenders.sql.includes("o.offense_code IN ('120')") && offenders.sql.includes("f.sex AS g0"));
// Arrests (P46, P50): by arrest date only, every built year scanned, and the once-each statement.
const arrests = ok(compilePlan(plan("arrests.shoplifting", "arrest", [], [], "arrest_date"), year(2024), t));
assert.ok(arrests.sql.includes("substr(a.arrest_date, 1, 6) AS ym") && arrests.sql.includes("a.arrest_offense IN ('23C')"));
assert.deepEqual(arrests.scanYears, t.builtYears);
assert.deepEqual(arrests.statements, ["arrests_counted_once"]);
assert.match(refuse(plan("arrests.shoplifting", "arrest")), /arrest date/);
assert.match(refuse(plan("arrests.dui", "arrest", [], [], "arrest_date")), /Group B/);
// Filters: a firearm on the offense (robbery), on the offense connecting a victim (P31), a stranger (P36).
const gunRobbery = ok(compilePlan(plan("offenses.robbery", "offense", [], [weapon("offense", firearm)]), year(2023), t));
assert.ok(gunRobbery.sql.includes("w2.weapon IN ('11', '12', '13', '14', '15') OR w2.weapon || w2.weapon_automatic IN ('11A', '12A', '13A', '14A', '15A')"));
assert.deepEqual(gunRobbery.statements, []);
const knifeVictims = ok(compilePlan(plan("victims.murder", "victim", [], [weapon("victim", ["20"])]), year(2024), t));
assert.ok(knifeVictims.sql.includes("w2.offense_code = vo.connected_offense AND (w2.weapon IN ('20'))"));
const strangers = ok(compilePlan(plan("victims.murder", "victim", [], [{ kind: "exists", scope: "victim", entity: "victim_offender", where: [{ kind: "attribute", dimension: "victim_offender.relationship", op: "in", values: ["ST"] }] }]), year(2024), t));
assert.ok(strangers.sql.includes("r2.offender_relationship IN ('ST')"));
assert.match(refuse(plan("offenses.robbery", "offense", [], [weapon("victim", firearm)])), /cannot apply an existence over offense_weapon at victim scope to offense/);
// 35B (D19's second drug part) has a definition.
assert.ok(ok(compilePlan(plan("offenses.drug_equipment", "offense"), year(2023), t)).sql.includes("o.offense_code IN ('35B')"));

console.log("nibrs compile v0: agency-level forms compile; the rest refuse with a reason");
