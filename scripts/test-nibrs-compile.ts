/**
 * The plan -> DuckDB compiler v0 (lib/nibrs-plan/compile.ts) compiles the agency-level forms and refuses the rest with
 * a reason. Offline: checks the SQL it emits, never runs it (scripts/nibrs-compile-gate.ts runs the correctness cases
 * against a local canonical build). No database, no model, no network.
 */
import assert from "node:assert/strict";
import { agencyPopulationSql, compilePlan } from "../lib/nibrs-plan/compile";
import * as X from "../lib/nibrs-plan/examples";

const t = { root: "/build/canonical", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] };
const year = (y: number) => ({ kind: "absolute" as const, from: `${y}-01`, to: `${y}-12` });
const ok = (r: ReturnType<typeof compilePlan>) => { assert(r.kind === "query", r.kind === "unsupported" ? r.reason : ""); return r.query; };

// H1: Memphis carjackings by month in 2025.
const h1 = ok(compilePlan(X.H1, year(2025), t));
assert.deepEqual(h1.columns, ["period", X.H1.statistics[0].as, `${X.H1.statistics[0].as}_status`]);
assert.deepEqual(h1.scanYears, [2025, 2026], "a later year's file can hold the period's incidents");
for (const s of ["offense_code = '120'", "p.loss_type = '7'", "'03', '05', '24', '28', '37'", "u.ori = 'TNMPD0000'", "agency_month_status", "BETWEEN '202501' AND '202512'", "EVIDENCE_CONFLICT"]) assert.ok(h1.sql.includes(s), s);
assert.ok(!h1.sql.includes("UNKNOWN_UNEVIDENCED_ZERO"), "P51: a month with crimes reported and none of these is a known 0");
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
for (const s of ["ELSE v.race END AS g0", "ELSE v.sex END AS g1", "cats AS (SELECT DISTINCT g0, g1 FROM scoped)", "CROSS JOIN cats", "n::DOUBLE / den", "vo.connected_offense IN ('09A')"]) assert.ok(n1.sql.includes(s), s);

// N2: 23F offenses in incidents with a stolen firearm: an incident-level existence over property, and its statement.
const n2 = ok(compilePlan(X.N2, year(2024), t));
assert.ok(n2.sql.includes("p.loss_type IN ('7') AND p.property_description IN ('13')"));
assert.deepEqual(n2.statements, ["property_not_attributed"]);

// Increment 6: N2 by clearance type (P64, P66, P67), with the incidents beside the count: the type from the incident's
// own arrestee rows and exceptional clearance, both statements, and the incidents counted over the same rows.
const n2as = X.N2.statistics[0].as, n2m = X.N2.measures[0].as;
const byType = ok(compilePlan({ ...X.N2, groupings: [{ dimension: "offense.clearance_type", unknown: "visible", absent: "show" }],
  statistics: [X.N2.statistics[0], { kind: "incidents", as: "inc", measure: n2m }] }, year(2024), t));
assert.deepEqual(byType.columns, ["offense.clearance_type", n2as, `${n2as}_status`, "inc", "inc_status"]);
for (const s of ["cleared_exceptionally", "COUNT(DISTINCT (u.data_year, u.ori, u.incident_num)) AS ni", 'sum(ni) END AS "inc"']) assert.ok(byType.sql.includes(s), s);
assert.deepEqual(byType.statements, ["property_not_attributed", "clearance_as_of_file", "clearance_arrest_first"]);
// A selection by status says P64 only; by arrest, P67 too.
const sel = (dimension: string, v: string) => ok(compilePlan({ ...X.N2, filters: [...X.N2.filters, { kind: "attribute", dimension, op: "in", values: [v] }] }, year(2024), t)).statements;
assert.deepEqual(sel("offense.clearance_status", "cleared"), ["property_not_attributed", "clearance_as_of_file"]);
assert.deepEqual(sel("offense.clearance_method", "arrest"), ["property_not_attributed", "clearance_as_of_file", "clearance_arrest_first"]);
// The incidents come right after the count of the counted measure.
assert.equal(compilePlan({ ...X.N2, statistics: [{ kind: "incidents", as: "inc", measure: n2m }, X.N2.statistics[0]] }, year(2024), t).kind, "unsupported");
// Increment 6: every arrest on an incident with a condition (P50, P68): any arrest offense, M left out, by arrest date,
// with its statement; an incident's offense as the condition; never every arrest.
const allArrests = { ...X.N2, timeBasis: "arrest_date" as const, measures: [{ id: "arrests.all_crime", unit: "arrest" as const, as: "arrests" }], statistics: [{ kind: "count" as const, as: "n", measure: "arrests" }] };
const onStolen = ok(compilePlan(allArrests, year(2024), t));
for (const s of ["FROM read_parquet", "multiple_arrestee_indicator, '') <> 'M'", "p.loss_type IN ('7')"]) assert.ok(onStolen.sql.includes(s), s);
assert.ok(!onStolen.sql.includes("a.arrest_offense IN"), "any arrest offense");
assert.deepEqual(onStolen.statements, ["property_not_attributed", "arrests_counted_once", "arrests_through_incident"]);
const onRobbery = ok(compilePlan({ ...allArrests, filters: [{ kind: "exists", scope: "incident", entity: "offense", where: [{ kind: "attribute", dimension: "offense.offense", op: "in", values: ["120"] }] }] }, year(2024), t));
assert.ok(onRobbery.sql.includes("o2.offense_code IN ('120')"));
// Increment 7: every arrest with no incident condition: Group A (M left out) and standalone Group B, by the arrestee's
// own columns only.
const every = ok(compilePlan({ ...allArrests, filters: [] }, year(2024), t));
for (const s of ["group_b_arrest", "UNION ALL", "identical_to_line_no IS NULL", "<> 'M'"]) assert.ok(every.sql.includes(s), s);
assert.deepEqual(every.statements, ["arrests_counted_once", "arrests_include_group_b"]);
const byArrestee = ok(compilePlan({ ...allArrests, filters: [], groupings: [{ dimension: "arrestee.race", unknown: "visible", absent: "show" }] }, year(2024), t));
assert.ok(byArrestee.sql.includes("ELSE a.race END AS g0"));
// Codex increment-7 review 04.1: a condition only on the arrestee ("juvenile arrests") still counts every arrest, with
// the condition on the Group A and the Group B branch alike.
const juvAll = ok(compilePlan({ ...allArrests, filters: [{ kind: "attribute", dimension: "arrestee.age", op: "between", values: [1, 17] }] }, year(2024), t));
assert.ok(juvAll.sql.includes("group_b_arrest") && juvAll.sql.split("TRY_CAST(a.age AS INTEGER) BETWEEN 1 AND 17").length === 3, "both branches");
assert.deepEqual(juvAll.statements, ["arrests_counted_once", "arrests_include_group_b", "unknown_not_counted"]);

// Increment 7: people. Victims by the incident's offenders' races (P49, multi-valued, 00 its own category); by the
// linked offenders' races (P65, "no_relationship"); a victim's own age; an offender of the incident; a linked offender;
// offenders linked as strangers to a victim of the crime.
const vic = { ...X.N2, filters: [], groupings: [], measures: [{ id: "victims.aggravated_assault", unit: "victim" as const, as: "v" }], statistics: [{ kind: "count" as const, as: "n", measure: "v" }] };
const byOffRace = ok(compilePlan({ ...vic, groupings: [{ dimension: "offender.race", unknown: "visible", absent: "show", multiValue: "each_value" }] }, year(2024), t));
assert.ok(byOffRace.sql.includes("CASE WHEN f2.offender_seq = '00' THEN 'U' ELSE CASE WHEN f2.race IS NULL OR trim(f2.race) = '' THEN 'U' ELSE f2.race END END"));
assert.deepEqual(byOffRace.statements, ["categories_overlap"]);
const byPair = ok(compilePlan({ ...vic, groupings: [{ dimension: "victim_offender.offender_race", unknown: "visible", absent: "show", multiValue: "each_value" }] }, year(2024), t));
for (const s of ["'no_relationship'", "f3.offender_seq = r.offender_number"]) assert.ok(byPair.sql.includes(s), s);
assert.deepEqual(byPair.statements, ["categories_overlap", "pair_linked"]);
const pairAge = ok(compilePlan({ ...vic, groupings: [{ dimension: "victim_offender.offender_age", unknown: "visible", absent: "show", multiValue: "each_value", bins: [{ label: "Under 18", from: 1, to: 17 }, { label: "18+", from: 18, to: 99 }] }] }, year(2024), t));
assert.ok(pairAge.sql.includes("CASE WHEN r.data_year IS NULL THEN 'no_relationship' ELSE CASE WHEN f3.age IS NULL"));
const juvVic = ok(compilePlan({ ...vic, filters: [{ kind: "attribute", dimension: "victim.age", op: "between", values: [1, 17] }] }, year(2024), t));
assert.ok(juvVic.sql.includes("(v.age IN ('NN', 'NB', 'BB') OR TRY_CAST(v.age AS INTEGER) BETWEEN 1 AND 17)"));
assert.deepEqual(juvVic.statements, ["unknown_not_counted"]);
const byJuv = ok(compilePlan({ ...vic, filters: [{ kind: "exists", scope: "incident", entity: "offender", where: [{ kind: "attribute", dimension: "offender.age", op: "between", values: [1, 17] }] }] }, year(2024), t));
assert.ok(byJuv.sql.includes("f4.offender_seq <> '00'") && byJuv.sql.includes("TRY_CAST(f4.age AS INTEGER) BETWEEN 1 AND 17"));
const ofJuv = ok(compilePlan({ ...vic, filters: [{ kind: "exists", scope: "victim", entity: "victim_offender", where: [{ kind: "attribute", dimension: "victim_offender.offender_age", op: "between", values: [1, 17] }] }] }, year(2024), t));
assert.ok(ofJuv.sql.includes("f4.offender_seq = r4.offender_number") && ofJuv.sql.includes("r4.victim_seq = v.victim_seq"));
assert.deepEqual(ofJuv.statements, ["pair_condition", "unknown_not_counted"]);
const off = { ...vic, measures: [{ id: "offenders.aggravated_assault", unit: "offender" as const, as: "v" }] };
const offStrangers = ok(compilePlan({ ...off, filters: [{ kind: "exists", scope: "offender", entity: "victim_offender", where: [{ kind: "attribute", dimension: "victim_offender.relationship", op: "in", values: ["ST"] }] }] }, year(2024), t));
for (const s of ["r4.offender_number = f.offender_seq", "r4.offender_relationship IN ('ST')", "vo4.connected_offense IN ('13A')"]) assert.ok(offStrangers.sql.includes(s), s);
assert.deepEqual(offStrangers.statements, ["offender_records"]);
// A victim's age condition on offense counts, or an unsupported operator, is refused.
assert.equal(compilePlan({ ...vic, filters: [{ kind: "attribute", dimension: "victim.age", op: "in", values: ["17"] }] }, year(2024), t).kind, "unsupported");

// Everything outside v0 is refused, with its reason.
const refuse = (p: Parameters<typeof compilePlan>[0], period: Parameters<typeof compilePlan>[1] = year(2025)) => { const r = compilePlan(p, period, t); assert.equal(r.kind, "unsupported"); return r.kind === "unsupported" ? r.reason : ""; };
// Increment 3: a set of years, each year's months only (the last clipped to `through`), grouped by year.
const sep = ok(compilePlan(X.SEPARATE_YEARS, { kind: "years", years: [2024, 2019] }, t));
assert.ok(sep.sql.includes("substr(ym, 1, 4) IN ('2019', '2024')") && sep.sql.includes("BETWEEN '201901' AND '202412' AND substr(u.ym, 1, 4) IN ('2019', '2024')"));
assert.ok(ok(compilePlan(X.SEPARATE_YEARS, { kind: "years", years: [2019, 2026], through: "2026-09" }, t)).sql.includes("BETWEEN '201901' AND '202609'"));
assert.match(refuse({ ...X.SEPARATE_YEARS, groupings: [] }, { kind: "years", years: [2019, 2024] }), /grouped by year/);
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
assert.match(refuse({ ...X.N1, groupings: [X.N1.groupings[0], { ...X.N1.groupings[1], dimension: "victim.resident_status" }] }), /cannot group victim by victim.resident_status/);
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
assert.ok(p49.sql.includes("WHEN f2.offender_seq = '00' THEN 'U'") && p49.sql.includes("f2.incident_num = v.incident_num"));
// key_occurrence joins a parent segment to its own children only, never one segment family to another (Codex review 02).
assert.ok(!p49.sql.includes("f2.key_occurrence") && !ok(compilePlan(plan("offenders.robbery", "offender"), year(2024), t)).sql.includes("o.key_occurrence = f.key_occurrence"));
// Age in bins (P30): infants under 18; 00 and blank one Unknown (P86); bins required, and never overlapping.
const bins = [{ label: "Under 18", from: 1, to: 17 }, { label: "18-24", from: 18, to: 24 }, { label: "65+", from: 65, to: 99 }];
const byAge = ok(compilePlan(plan("victims.aggravated_assault", "victim", [by("victim.age", { bins })]), year(2024), t));
for (const s of ["WHEN v.age IN ('NN', 'NB', 'BB') THEN 'Under 18'", "trim(v.age) = '' OR v.age = '00' THEN 'Unknown'", "BETWEEN 65 AND 99 THEN '65+'"]) assert.ok(byAge.sql.includes(s), s);
assert.match(refuse(plan("victims.aggravated_assault", "victim", [by("victim.age")])), /in bins/);
assert.match(refuse(plan("victims.aggravated_assault", "victim", [by("victim.age", { bins: [...bins, { label: "x", from: 20, to: 30 }] })])), /overlap/);
assert.match(refuse(plan("victims.aggravated_assault", "victim", [by("victim.sex", { bins })])), /bins ages only/);
// Offenders (P44): offender segments of incidents with the codes, by their own sex.
const offenders = ok(compilePlan(plan("offenders.robbery", "offender", [by("offender.sex")]), year(2024), t));
assert.ok(offenders.sql.includes("f.offender_seq || ':' || f.key_occurrence AS sub") && offenders.sql.includes("o.offense_code IN ('120')") && offenders.sql.includes("CASE WHEN f.offender_seq = '00' THEN 'U' ELSE CASE WHEN f.sex IS NULL OR trim(f.sex) = '' THEN 'U' ELSE f.sex END END AS g0"));
// Arrests (P46, P50): by arrest date only, every built year scanned, and the once-each statement.
const arrests = ok(compilePlan(plan("arrests.shoplifting", "arrest", [], [], "arrest_date"), year(2024), t));
assert.ok(arrests.sql.includes("substr(a.arrest_date, 1, 6) AS ym") && arrests.sql.includes("a.arrest_offense IN ('23C')"));
assert.ok(arrests.sql.includes("coalesce(a.multiple_arrestee_indicator, '') <> 'M'"), "P68: an M segment (the same apprehension on another incident) is not counted");
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

// Increment 4. Several agencies as a monthly grid: one cell per agency-month, each with its own status (D6); the
// ORIs deduplicated and sorted; anything else refused.
const monthly = plan("offenses.shoplifting", "offense", [by("time.month")]);
const grid = ok(compilePlan(monthly, year(2024), { ...t, agencies: ["OK0720600", "OK0550900", "OK0720600"] }));
assert.deepEqual(grid.columns, ["ori", "period", "c", "c_status"]);
for (const s of ["u.ori IN ('OK0550900', 'OK0720600')", "CROSS JOIN (SELECT unnest(['OK0550900', 'OK0720600']) AS ori) a", "GROUP BY u.ori, u.ym"]) assert.ok(grid.sql.includes(s), s);
assert.match(ok(compilePlan(plan("offenses.shoplifting", "offense"), year(2024), t)).sql, /u.ori = 'TNMPD0000'|ori = /, "without agencies the plan's own place is read");
assert.match(String((() => { const r = compilePlan({ ...monthly, groupings: [] } as Plan, year(2024), { ...t, agencies: ["OK0550900"] }); return r.kind === "unsupported" ? r.reason : ""; })()), /monthly grid of one count/);
// Populations: the canonical agency file, per data year, by ORI or a state's city agencies.
const pops = agencyPopulationSql(t.root, { oris: ["OK0550900"] }, [2024]);
for (const s of ["/build/canonical/agency/data.parquet", "unnest(by_year)", "ori IN ('OK0550900')", "u.data_year IN (2024)"]) assert.ok(pops.includes(s), s);
assert.ok(agencyPopulationSql(t.root, { state: "TX", city: true }, [2023, 2024]).includes("u.state_abbr = 'TX' AND u.agency_indicator = '1'"));

console.log("nibrs compile v0: agency-level forms compile; the rest refuse with a reason");
