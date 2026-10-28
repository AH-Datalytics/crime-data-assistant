/**
 * NIBRS plan language v1 (lib/nibrs-plan): every example plan and reader outcome parses and is valid, and each
 * validation rule refuses the plan it exists to refuse. Uses a small in-memory semantic layer standing in for the
 * shared one, and a stand-in release; no database, no model.
 */
import assert from "node:assert/strict";
import * as X from "../lib/nibrs-plan/examples";
import { parsePlan, parseReaderOutcome, type NibrsPlan, type PartRef } from "../lib/nibrs-plan/plan";
import { resolvePeriod, validateResolved, type GeographyResolver } from "../lib/nibrs-plan/resolve";
import { checkLayer, type SemanticDimension, type SemanticEntity, type SemanticLayer, type SemanticLink, type SemanticMeasure } from "../lib/nibrs-plan/semantic";
import { validateBindings, validatePlanSemantics, validatePlanShape } from "../lib/nibrs-plan/validate";

/* ---------------------------------------------------------------- a stand-in semantic layer ---------------------- */
const NIBRS: [number, number] = [1991, 2026];
const ent = (id: string, key: string[]): SemanticEntity => ({ id, table: id, key, dates: { incident_date: "incident_date" }, agencyColumn: "ori" });
const ENTITIES = ["incident", "offense", "victim", "offender", "arrestee", "group_b_arrest", "property", "victim_offense", "victim_offender", "offense_weapon"]
  .map((e) => ent(e, ["data_year", "ori", "incident_num", `${e}_seq`]));
ENTITIES.find((e) => e.id === "group_b_arrest")!.dates = { arrest_date: "arrest_date" };
const ALL_ADD = { acrossAgencies: true, acrossMonths: true, acrossCategories: false };
const m = (id: string, entity: string, unit: SemanticMeasure["unit"], timeBases: SemanticMeasure["timeBases"] = ["incident_date"]): SemanticMeasure =>
  ({ id, entity, unit, label: id, aggregation: unit === "dollars" ? { kind: "sum", column: "value" } : { kind: "count_distinct" }, predicate: null, additive: ALL_ADD, timeBases, validYears: NIBRS });
// victims.murder carries its executable definition: a victim with a connected offense 09A, through the link.
const MURDER_VICTIMS: SemanticMeasure = { ...m("victims.murder", "victim", "victim"), predicate: { kind: "exists", link: "victim_offenses", where: [{ kind: "dimension", dimension: "victim_offense.offense_code", op: "in", values: ["09A"] }] } };
// A composite (violent crime) and a derived numeric condition (flash mob: six or more offender segments).
const VIOLENT: SemanticMeasure = { ...m("violent_crime.fbi_standard", "incident", "fbi_standard"), aggregation: { kind: "composite", components: ["victims.murder", "offenses.robbery", "victims.aggravated_assault"] } };
const FLASH_MOB: SemanticMeasure = { ...m("incidents.flash_mob_shoplifting", "incident", "incident"), predicate: { kind: "numeric", dimension: "incident.offender_segment_count", op: ">=", values: [6] } };
const MEASURES = [
  MURDER_VICTIMS, VIOLENT, FLASH_MOB, m("victims.robbery", "victim", "victim"), m("victims.aggravated_assault", "victim", "victim"),
  m("offenses.murder", "offense", "offense"), m("offenses.murder_cleared", "offense", "offense"), m("offenses.robbery", "offense", "offense"),
  m("offenses.rape", "offense", "offense"), m("offenses.rape_cleared", "offense", "offense"), m("offenses.justifiable_homicide", "offense", "offense"),
  m("offenses.theft_from_motor_vehicle", "offense", "offense"), m("offenses.motor_vehicle_theft", "offense", "offense"),
  m("offenders.motor_vehicle_theft", "offender", "offender"), m("incidents.carjacking", "incident", "incident"),
  m("arrests.robbery", "arrestee", "arrest", ["incident_date", "arrest_date"]), m("group_b_arrests.dui", "group_b_arrest", "group_b_arrest", ["arrest_date"]),
  m("property.stolen_value", "property", "dollars"), m("property.stolen_segments", "property", "property_segment"),
  m("victim_offender.murder", "victim_offender", "victim_offender"),
];
const AGE = { min: 1, max: 99, special: { "00": "unknown", NN: "under 24 hours", NB: "1-6 days", BB: "7-364 days" } };
const d = (id: string, entity: string, extra: Partial<SemanticDimension> = {}): SemanticDimension =>
  ({ id, entity, column: id.split(".")[1], label: id, unknownCodes: ["U"], validYears: NIBRS, ...extra });
const DIMENSIONS = [
  d("time.month", "time"), d("time.year", "time"), d("geo.agency", "agency"), d("geo.state", "agency"),
  d("victim.race", "victim"), d("victim.sex", "victim"), d("offender.age", "offender", { numeric: AGE }),
  d("property.loss_type", "property", { values: { 1: "none", 2: "burned", 5: "recovered", 7: "stolen" } }),
  d("property.description", "property", { values: { "03": "automobiles", 13: "firearms", 37: "trucks" } }),
  d("offense.exceptional_clearance", "offense"), d("offense_weapon.weapon", "offense_weapon"),
  d("victim_offense.offense_code", "victim_offense", { values: { "09A": "murder", "13A": "aggravated assault", "26H": "money laundering" }, valueYears: { "26H": [2015, 2026] } }),
  d("victim_offender.relationship", "victim_offender"), d("victim_offender.offender_age", "victim_offender", { numeric: AGE }),
  d("victim.ethnicity_2013", "victim", { validYears: [2013, 2026] }),
  d("incident.offender_segment_count", "incident", { numeric: { min: 0, max: 99, special: {} } }),
  d("offense.location_type", "offense", { values: { "05": "commercial office", 58: "cyberspace" }, valueYears: { 58: [2020, 2026] } }),
];
const L = (id: string, from: string, to: string, cardinality: "one" | "many"): SemanticLink => ({ id, from, to, cardinality, on: [["incident_num", "incident_num"]] });
const LINKS = [
  L("victim_incident", "victim", "incident", "one"), L("offense_incident", "offense", "incident", "one"), L("offender_incident", "offender", "incident", "one"),
  L("arrestee_incident", "arrestee", "incident", "one"), L("incident_property", "incident", "property", "many"),
  L("offense_weapons", "offense", "offense_weapon", "many"), L("victim_offenses", "victim", "victim_offense", "many"),
  L("victim_offenders", "victim", "victim_offender", "many"),
];
const layer: SemanticLayer = {
  version: X.SEMANTIC_VERSION,
  entity: (id) => ENTITIES.find((e) => e.id === id),
  measure: (id) => MEASURES.find((x) => x.id === id),
  dimension: (id) => DIMENSIONS.find((x) => x.id === id),
  link: (id) => LINKS.find((l) => l.id === id),
  measures: () => MEASURES,
  path: (from, to) => {
    const direct = LINKS.find((l) => l.from === from && l.to === to);
    if (direct) return [direct];
    const up = LINKS.find((l) => l.from === from && l.to === "incident");
    const down = LINKS.find((l) => l.from === "incident" && l.to === to);
    return up && down ? [up, down] : undefined;
  },
};

const rules = (problems: { rule: string }[]) => problems.map((p) => p.rule).sort();
/** The app's geography resolver stands behind place accounting; the plan's label never decides identity. */
const PLACES: Record<string, { oris: string[] }> = { "city:Baltimore:MD": { oris: ["MDBPD0000"] } };
const vb = (plan: NibrsPlan, parts: PartRef[]) => validateBindings(plan, parts, (v) => PLACES[v] ?? null);
const shape = (p: NibrsPlan) => rules(validatePlanShape(p));
const sem = (p: NibrsPlan) => rules(validatePlanSemantics(p, layer));
const parse = (p: unknown) => rules(parsePlan(p).problems);

/* ---------------------------------------------------------------- the layer itself -------------------------------- */
assert.deepEqual(checkLayer(layer), [], "every measure predicate resolves through link()");
const broken: SemanticLayer = { ...layer, measures: () => [{ ...MURDER_VICTIMS, predicate: { kind: "exists", link: "offense_weapons", where: [{ kind: "dimension", dimension: "victim.sex", op: "in", values: ["F"] }] } }] };
assert.equal(checkLayer(broken).length, 1, "a link that starts elsewhere is caught");
assert.equal(checkLayer({ ...layer, measures: () => [{ ...VIOLENT, aggregation: { kind: "composite", components: ["victims.nope"] } }] }).length, 1, "a composite's components must exist");
assert.equal(checkLayer({ ...layer, measures: () => [{ ...FLASH_MOB, predicate: { kind: "numeric", dimension: "victim.race", op: ">=", values: [6] } }] }).length, 1, "a numeric condition needs a dimension of its entity");
assert.equal(checkLayer({ ...layer, measures: () => [{ ...FLASH_MOB, predicate: { kind: "numeric", dimension: "incident.offender_segment_count", op: ">=", values: [6] } }, { ...m("incidents.x", "victim", "victim"), predicate: { kind: "numeric", dimension: "victim.sex", op: ">=", values: [1] } }] }).length, 1, "and a numeric one");

/* ---------------------------------------------------------------- every example is valid ------------------------- */
for (const [name, plan] of Object.entries(X.EXAMPLES)) {
  assert.deepEqual(parsePlan(plan).problems, [], `${name}: parse`);
  assert.deepEqual(validatePlanShape(plan), [], `${name}: shape`);
  assert.deepEqual(validatePlanSemantics(plan, layer), [], `${name}: semantics`);
}
for (const [name, o] of Object.entries(X.OUTCOMES)) assert(parseReaderOutcome(o).success, `${name}: outcome parses`);
assert.deepEqual(vb(X.N3, X.N3_PARTS), [], "N3: every part bound by path and value");

/* ---------------------------------------------------------------- P0: the runtime boundary ----------------------- */
assert.deepEqual([...new Set(parse({}))], ["P0"], "an empty object is refused, not a crash");
assert.deepEqual(parse({ ...X.ROLLING, period: { kind: "last_n", unit: "years", count: -2 } }), ["P0"]);
assert.deepEqual(parse({ ...X.TOP_N_PER_MONTH, transforms: [{ kind: "rank", by: "count", direction: "top", per: ["time.month"], limit: 2.5 }] }), ["P0"]);
assert.deepEqual(parse({ ...X.N3, period: { kind: "absolute", from: "2022-13", to: "2026-06" } }), ["P0"]);
assert.deepEqual(parse({ ...X.N3, version: "nibrs-plan/0" }), ["P0"]);
assert.deepEqual(parse({ ...X.TOP_N_PER_MONTH, geography: { places: [{ kind: "agency_set", where: [{ field: "agency.population", op: "in", value: 5 }], within: { kind: "national" } }], combine: "separate" } }), ["P0"]);

assert.deepEqual(parse({ ...X.N3, filters: [{ kind: "attribute", dimension: "victim.sex", op: "in", values: ["F"], negate: true }] }), ["P0"], "an unsupported field is refused, not stripped");
assert.deepEqual(parse({ ...X.N3, extra: 1 }), ["P0"]);

/* ---------------------------------------------------------------- P: structural rules ----------------------------- */
assert.deepEqual(shape({ ...X.N3, statistics: [{ kind: "count", as: "motor_vehicle_thefts", measure: "motor_vehicle_thefts" }] }), ["P2"]);
assert.deepEqual(shape({ ...X.NAMED_PLACES, geography: { places: [X.N3.geography.places[0], X.N3.geography.places[0]], combine: "separate" } }), ["P3"]);
assert.deepEqual(shape({ ...X.NAMED_PLACES, groupings: [] }), ["P3"], "two separate places need geo.place");
assert.deepEqual(shape({ ...X.COMBINED_PLACES, geography: { places: [{ kind: "national" }, X.N3.geography.places[0]], combine: "combined" } }), ["P3"]);
assert.deepEqual(shape({ ...X.N3, period: { kind: "absolute", from: "2026-06", to: "2022-01" } }), ["P4"]);
assert.deepEqual(shape({ ...X.SEPARATE_YEARS, period: { kind: "years", years: [2024, 2019] } }), ["P4"]);
assert.deepEqual(shape({ ...X.N1, groupings: [...X.N1.groupings, X.N1.groupings[0]] }), ["P5"]);
const ageG = X.AGE_BREAKDOWN.groupings[1];
assert.deepEqual(shape({ ...X.AGE_BREAKDOWN, groupings: [X.AGE_BREAKDOWN.groupings[0], { ...ageG, bins: [{ label: "a", from: 1, to: 20 }, { label: "b", from: 18, to: 30 }] }] }), ["P5"], "overlapping bins");
assert.deepEqual(shape({ ...X.AGE_BREAKDOWN, groupings: [X.AGE_BREAKDOWN.groupings[0], { ...ageG, bins: [{ label: "a", from: 30, to: 20 }] }] }), ["P5"]);
// A share within a non-grouping, and the same dimension three times (Codex probe: not misread as "every grouping").
assert.deepEqual(shape({ ...X.N1, statistics: [{ kind: "share", as: "s", measure: "murder_victims", within: ["victim.age"] }] }), ["P6"]);
assert.deepEqual(shape({ ...X.N1, statistics: [{ kind: "share", as: "s", measure: "murder_victims", within: ["time.month", "time.month", "time.month"] }] }), ["P6", "P6"]);
// A requested 100% share (within every grouping) is allowed.
assert.deepEqual(shape({ ...X.N1, statistics: [{ kind: "share", as: "s", measure: "murder_victims", within: ["time.month", "victim.race", "victim.sex"] }] }), []);
assert.deepEqual(shape({ ...X.N3, filters: [{ kind: "attribute", dimension: "victim.sex", op: "in", values: [] }] }), ["P7"]);
assert.deepEqual(shape({ ...X.N3, filters: [{ kind: "attribute", dimension: "victim.sex", op: "is_unknown", values: ["U"] }] }), ["P7"]);
const sf = X.N2.filters[0];
assert(sf.kind === "exists");
assert.deepEqual(shape({ ...X.N2, filters: [{ ...sf, attribution: undefined }] }), ["P9"]);
assert.deepEqual(shape({ ...X.S3, transforms: [] }), ["P10"], "same agencies needs periods to compare");
assert.deepEqual(shape({ ...X.ROLLING, groupings: [] }), ["P11"]);
assert.deepEqual(shape({ ...X.ROLLING, transforms: [{ kind: "rolling", of: ["murder_victims"], months: 12 }] }), ["P11"], "a transform names a statistic, not a measure");
assert.deepEqual(shape({ ...X.RANKED_RATES, transforms: [X.RANKED_RATES.transforms[0], { kind: "rolling", of: ["count"], months: 3 }], groupings: [...X.RANKED_RATES.groupings, { dimension: "time.month", unknown: "visible", absent: "show" }] }), ["P11"], "order rolling -> comparison -> rank");
assert.deepEqual(shape({ ...X.TOP_N_PER_MONTH, transforms: [{ kind: "rank", by: "count", direction: "top", per: ["time.month", "geo.agency"], limit: 5 }] }), ["P12"]);
assert.deepEqual(shape({ ...X.RANKED_RATES, transforms: [{ kind: "rank", by: "rate", direction: "top", per: ["time.week"], limit: null }] }), ["P12"]);
assert.deepEqual(shape({ ...X.SAME_AGENCIES_CHANGE, transforms: [{ kind: "period_comparison", of: ["count"], earlier: { kind: "absolute", from: "2023-01", to: "2025-06" }, later: { kind: "absolute", from: "2025-01", to: "2025-12" }, outputs: ["change"] }] }), ["P13"]);
assert.deepEqual(shape({ ...X.SAME_AGENCIES_CHANGE, transforms: [{ kind: "period_comparison", of: ["count"], earlier: { kind: "absolute", from: "2021-01", to: "2021-12" }, later: { kind: "absolute", from: "2025-01", to: "2025-12" }, outputs: ["change"] }] }), ["P13"], "comparison outside the plan's period");

// Transform composition.
const cmp = X.SAME_AGENCIES_CHANGE.transforms[0];
assert(cmp.kind === "period_comparison");
const geoState = { dimension: "geo.state", unknown: "visible" as const, absent: "show" as const };
assert.deepEqual(shape({ ...X.SAME_AGENCIES_CHANGE, groupings: [geoState], transforms: [cmp, { kind: "rank", by: "count", direction: "top", per: [], limit: 5 }] }), ["P12"], "rank after a comparison names an output");
assert.deepEqual(shape({ ...X.SAME_AGENCIES_CHANGE, groupings: [geoState], transforms: [cmp, { kind: "rank", by: "count.pct_change", direction: "top", per: [], limit: 5 }] }), []);
assert.deepEqual(shape({ ...X.N3, transforms: [{ kind: "rank", by: "count.change", direction: "top", per: [], limit: 5 }] }), ["P12"], "no comparison, no change output");
assert.deepEqual(shape({ ...X.ROLLING, period: { kind: "absolute", from: "2021-01", to: "2025-12" }, transforms: [X.ROLLING.transforms[0], { kind: "period_comparison", of: ["count"], earlier: { kind: "absolute", from: "2021-01", to: "2021-12" }, later: { kind: "absolute", from: "2025-01", to: "2025-12" }, outputs: ["change"] }] }), ["P11"], "rolling and comparison not combined");
assert.deepEqual(shape({ ...X.ROLLING, statistics: [{ kind: "rate", as: "count", measure: "murder_victims", per: 100000 }] }), ["P11"], "no rate in a rolling window");
assert.deepEqual(shape({ ...X.R, groupings: [] }), ["P14"], "a 2018-2019 rate with no year grouping");
// r3 probes: an ungrouped rate is not excused by a comparison of something else; a statistic compared twice.
assert.deepEqual(shape({ ...X.SAME_AGENCIES_CHANGE, statistics: [...X.SAME_AGENCIES_CHANGE.statistics, { kind: "rate", as: "rate", measure: "victims", per: 100000 }] }), ["P14"]);
assert.deepEqual(shape({ ...X.SAME_AGENCIES_CHANGE, transforms: [cmp, { ...cmp, earlier: { kind: "absolute", from: "2024-01", to: "2024-12" } }] }), ["P13"], "count compared twice");
// A relative ungrouped rate is decided on its resolved period (R5), not refused early.
const ytdRate: NibrsPlan = { ...X.R, groupings: [], statistics: [{ kind: "rate", as: "rate", measure: "murder_victims", per: 100000 }], period: { kind: "since", from: "2026-01" } };
assert.deepEqual(shape(ytdRate), []);
assert.deepEqual(shape({ ...X.SAME_AGENCIES_CHANGE, statistics: [{ kind: "rate", as: "count", measure: "victims", per: 100000 }], transforms: [{ ...cmp, earlier: { kind: "absolute", from: "2023-01", to: "2024-06" }, later: { kind: "absolute", from: "2025-01", to: "2025-12" } }] }), ["P13"], "a compared rate period inside one data year");

/* ---------------------------------------------------------------- S: against the semantic layer ------------------- */
assert.deepEqual(sem({ ...X.N3, semanticVersion: "nibrs-semantic/9" }), ["S1"]);
assert.deepEqual(sem({ ...X.N3, measures: [{ id: "offenses.car_theft", unit: "offense", as: "motor_vehicle_thefts" }] }), ["S2"]);
assert.deepEqual(sem({ ...X.N1, measures: [{ id: "victims.murder", unit: "offense", as: "murder_victims" }] }), ["S2"], "murders by offense are not murder victims");
assert.deepEqual(sem({ ...X.GROUP_B_ARRESTS, timeBasis: "incident_date" }), ["S2"], "Group B arrests have no incident date");
assert.deepEqual(sem({ ...X.N1, groupings: [...X.N1.groupings, { dimension: "victim.hair", unknown: "visible", absent: "show" }] }), ["S3"]);
// Codex probe: an existence filter over an entity that does not exist, with a condition from the wrong entity and era.
assert.deepEqual(sem({ ...X.N2, period: { kind: "absolute", from: "2010-01", to: "2010-12" }, filters: [{ kind: "exists", scope: "incident", entity: "nonexistent_entity", attribution: "incident_level_only", where: [{ kind: "attribute", dimension: "victim.ethnicity_2013", op: "in", values: ["H"] }] }] }), ["S4", "S4", "S7"]);
assert.deepEqual(sem({ ...X.N2, filters: [{ ...sf, where: [{ kind: "attribute", dimension: "victim.sex", op: "in", values: ["F"] }] }] }), ["S4"], "a condition must belong to the existence target");
assert.deepEqual(sem({ ...X.N1, filters: [{ kind: "exists", scope: "victim_offense", entity: "victim_offense", where: [{ kind: "attribute", dimension: "victim_offense.offense_code", op: "in", values: ["13A"] }] }] }), ["S8"], "scope must be one row per counted unit");
assert.deepEqual(sem({ ...X.N3, filters: [{ kind: "attribute", dimension: "property.description", op: "in", values: ["03"] }] }), ["S5", "S9"], "property as a plain filter");
assert.deepEqual(sem({ ...X.N2, filters: [{ ...sf, scope: "offense" }] }), ["S9"], "property scoped to an offense");
assert.deepEqual(sem({ ...X.MULTI_VALUE_GROUPING, groupings: [{ dimension: "offense_weapon.weapon", unknown: "visible", absent: "show" }] }), ["S6"]);
assert.deepEqual(sem({ ...X.N3, groupings: [...X.N3.groupings, { dimension: "time.year", unknown: "visible", absent: "show", multiValue: "each_value" }] }), ["S6"]);
assert.deepEqual(sem({ ...X.D_WITHIN_RACE, period: { kind: "absolute", from: "2010-01", to: "2010-12" }, groupings: [{ dimension: "victim.ethnicity_2013", unknown: "visible", absent: "show" }], statistics: [{ kind: "count", as: "c", measure: "murder_victims" }] }), ["S7"]);
// Two one-to-many links at once would cross-multiply: victim offenses x victim-offender pairs.
assert.deepEqual(sem({ ...X.N1, groupings: [{ dimension: "victim_offense.offense_code", unknown: "visible", absent: "show", multiValue: "each_value" }, { dimension: "victim_offender.relationship", unknown: "visible", absent: "show", multiValue: "each_value" }], statistics: [{ kind: "count", as: "c", measure: "murder_victims" }] }), ["S8"]);
assert.deepEqual(sem({ ...X.N1, groupings: [{ dimension: "victim.race", unknown: "visible", absent: "show", bins: [{ label: "x", from: 1, to: 2 }] }], statistics: [{ kind: "count", as: "c", measure: "murder_victims" }] }), ["S10"]);
assert.deepEqual(sem({ ...X.N2, filters: [{ ...sf, where: [{ kind: "attribute", dimension: "property.description", op: "in", values: ["99"] }] }] }), ["S11"]);
// The same value checks on plain filters (Codex probes).
assert.deepEqual(sem({ ...X.N3, filters: [{ kind: "attribute", dimension: "offense.location_type", op: "in", values: ["99"] }] }), ["S11"]);
assert.deepEqual(sem({ ...X.N3, period: { kind: "absolute", from: "2018-01", to: "2019-12" }, filters: [{ kind: "attribute", dimension: "offense.location_type", op: "in", values: ["58"] }] }), ["S7"], "cyberspace before 2020");
assert.deepEqual(sem({ ...X.N1, filters: [{ kind: "attribute", dimension: "victim.race", op: "between", values: [1, 5] }] }), ["S11"], "between on a coded dimension");
assert.deepEqual(sem({ ...X.AGE_BREAKDOWN, measures: [{ ...X.AGE_BREAKDOWN.measures[0], filters: [{ kind: "attribute", dimension: "offender.age", op: "between", values: [30, 18] }] }] }), ["S11"], "reversed bounds");
assert.deepEqual(sem({ ...X.N1, groupings: [], measures: [...X.N1.measures, { id: "offenses.murder", unit: "offense", as: "murders" }], statistics: [{ kind: "share", as: "s", measure: "murder_victims", within: [], denominator: "murders" }] }), ["S12"]);

/* ---------------------------------------------------------------- A: request accounting by path and value ---------- */
const part = (concept: string, value: string | null, text: string): PartRef => ({ concept, value, text, span: [90, 99], clause: 0, inherited: false });
const withPart = (plan: NibrsPlan, pr: PartRef, path: string) => rules(vb({ ...plan, bindings: [...plan.bindings, { part: pr, path }] }, [...plan.bindings.map((b) => b.part), pr]));
// Codex probes: each contradiction is refused.
assert.deepEqual(withPart({ ...X.N3, geography: { places: [{ kind: "state", code: "MD" }], combine: "separate" } }, part("place", "state:Texas", "Texas"), "geography.places[0]"), ["A4", "A4"], "Texas bound to Maryland (and Baltimore no longer applied)");
assert.deepEqual(withPart({ ...X.N3, filters: [{ kind: "attribute", dimension: "victim.sex", op: "not_in", values: ["F"] }] }, part("filter", "sex:F", "female"), "filters[0]"), ["A4"], "female bound to not-female");
assert.deepEqual(rules(vb({ ...X.N3, groupings: [{ dimension: "time.year", unknown: "visible", absent: "show" }] }, X.N3_PARTS)), ["A4"], "by month bound to a year grouping");
assert.deepEqual(withPart(X.N3, part("immigration-status", "undocumented", "undocumented"), "question"), ["A3"], "a concept no plan can apply");
assert.deepEqual(withPart(X.PROPERTY_VALUE, part("unit", "dollars", "dollars"), "measures[0].unit"), [], "dollars maps to the dollars unit");
assert.deepEqual(withPart(X.TOP_N_PER_MONTH, part("threshold", ">=|250000", "250,000 or more"), "geography.places[0]"), []);
assert.deepEqual(withPart(X.TOP_N_PER_MONTH, part("rank", "top:5", "5"), "transforms[0]"), []);
assert.deepEqual(withPart(X.TOP_N_PER_MONTH, part("rank", "top:10", "10"), "transforms[0]"), ["A4"]);
assert.deepEqual(withPart(X.SEPARATE_YEARS, part("period", "years:2024:2019", "2019 and 2024"), "period"), []);
// r3 probes: a broader population, a wrong rate scale, another city's ORI under a borrowed label.
assert.deepEqual(withPart({ ...X.N3, filters: [{ kind: "attribute", dimension: "victim.sex", op: "in", values: ["F", "M"] }] }, part("filter", "sex:F", "female"), "filters[0]"), ["A4"], "female bound to female-or-male");
assert.deepEqual(withPart({ ...X.N3, filters: [{ kind: "exists", scope: "offense", entity: "offense_weapon", where: [{ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values: ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"] }] }] }, part("filter", "weapon:firearm", "firearm"), "filters[0]"), [], "a named family maps to its exact codes");
assert.deepEqual(withPart({ ...X.R, statistics: [X.R.statistics[0], { kind: "rate", as: "rate", measure: "murder_victims", per: 10 }] }, part("statistic", "per100k", "per 100,000"), "statistics[1]"), ["A4"], "a rate per 10 is not per 100,000");
assert.deepEqual(withPart(X.R, part("statistic", "per100k", "per 100,000"), "statistics[1]"), []);
assert.deepEqual(rules(vb({ ...X.N3, geography: { places: [{ kind: "agency", ori: "TXHPD0000", label: "Baltimore Police Department, MD" }], combine: "separate" } }, X.N3_PARTS)), ["A4"], "Houston's ORI under a Baltimore label");
const bind = (path: string, i: number) => ({ ...X.N3, bindings: X.N3.bindings.map((b, j) => (j === i ? { ...b, path } : b)) });
assert.deepEqual(rules(vb({ ...X.N3, bindings: X.N3.bindings.slice(1) }, X.N3_PARTS)), ["A1"]);
assert.deepEqual(rules(vb(bind("no.such.path", 0), X.N3_PARTS)), ["A2"]);
assert.deepEqual(rules(vb(bind("geography.places[0]", 0), X.N3_PARTS)), ["A3"]);
assert.deepEqual(rules(vb({ ...X.N3, measures: [{ id: "offenses.robbery", unit: "offense", as: "motor_vehicle_thefts" }] }, X.N3_PARTS)), ["A4"], "bound, but the plan applies another measure");
assert.deepEqual(rules(vb({ ...X.N3, period: { kind: "absolute", from: "2022-01", to: "2025-12" } }, X.N3_PARTS)), ["A4"], "bound, but the plan clips the period");
// A filter part bound to a filter that does not carry its value is not applied.
const femaleN3: NibrsPlan = { ...X.N3, filters: [{ kind: "attribute", dimension: "victim.sex", op: "in", values: ["M"] }] };
const femalePart: PartRef = { concept: "filter", value: "sex:F", text: "female", span: [60, 66], clause: 0, inherited: false };
assert.deepEqual(rules(vb({ ...femaleN3, bindings: [...X.N3.bindings, { part: femalePart, path: "filters[0]" }] }, [...X.N3_PARTS, femalePart])), ["A4"]);
// An inherited part from an earlier turn is accounted for like any other.
const inherited: PartRef = { ...X.N3_PARTS[1], inherited: true };
assert.deepEqual(rules(vb(X.N3, [...X.N3_PARTS, inherited])), ["A1"]);

/* ---------------------------------------------------------------- R: release resolution ---------------------------- */
const release = { id: "test", firstMonth: "1991-01", lastMonth: "2026-10" };
assert.deepEqual(resolvePeriod(X.H1.period, release), { kind: "absolute", from: "2025-01", to: "2025-12" }, "H1's 2025");
assert.deepEqual(resolvePeriod(X.H1.period, { ...release, lastMonth: "2026-12" }), { kind: "absolute", from: "2026-01", to: "2026-12" });
assert.deepEqual(resolvePeriod({ kind: "last_n", unit: "months", count: 3 }, release), { kind: "absolute", from: "2026-08", to: "2026-10" });
assert.deepEqual(resolvePeriod({ kind: "last_n", unit: "years", count: 2 }, release), { kind: "absolute", from: "2024-01", to: "2025-12" });
assert.deepEqual(resolvePeriod(X.N1.period, release), { kind: "absolute", from: "2018-01", to: "2026-10" });
const MEMBERS: Record<string, string[]> = { MD: ["MDBPD0000", "MD0030000"], MDBPD0000: ["MDBPD0000"], TNMPD0000: ["TNMPD0000"], TXHPD0000: ["TXHPD0000"], national: ["MDBPD0000", "TNMPD0000", "TXHPD0000"] };
const geo: GeographyResolver = { members: (pl) => MEMBERS[pl.kind === "state" ? pl.code : pl.kind === "agency" ? pl.ori : pl.kind] ?? [] };
const ok = validateResolved(X.N1, release, layer, geo);
assert.deepEqual(ok.problems, []);
assert.deepEqual(rules(validateResolved({ ...X.N3, period: { kind: "absolute", from: "1985-01", to: "1986-12" } }, release, layer, geo).problems), ["R1", "R1", "R1"], "outside the release, the measure's era and the month dimension's era");
assert.deepEqual(rules(validateResolved({ ...X.D_WITHIN_RACE, period: { kind: "since", from: "2010-01" }, groupings: [{ dimension: "victim.ethnicity_2013", unknown: "visible", absent: "show" }] }, release, layer, geo).problems), ["R1"], "era checked on the resolved period");
assert.deepEqual(rules(validateResolved({ ...X.ROLLING, transforms: [{ kind: "period_comparison", of: ["count"], earlier: { kind: "absolute", from: "2019-01", to: "2019-12" }, later: { kind: "absolute", from: "2025-01", to: "2025-12" }, outputs: ["change"] }] }, release, layer, geo).problems), ["R2"]);
const comb = validateResolved(X.COMBINED_PLACES, release, layer, geo);
assert.deepEqual(comb.combined, { total: 3, deduplicated: 2 }, "Baltimore inside Maryland counts once");
assert.deepEqual(rules(validateResolved({ ...X.N3, geography: { places: [{ kind: "agency", ori: "ZZ9999999", label: "nowhere" }], combine: "separate" } }, release, layer, geo).problems), ["R4"]);
// Codex probes: code eras on a relative plan, and comparisons inside a noncontiguous selection.
assert.deepEqual(rules(validateResolved({ ...X.Z, period: { kind: "since", from: "2010-01" }, filters: [{ kind: "attribute", dimension: "offense.location_type", op: "in", values: ["58"] }] }, release, layer, geo).problems), ["R1"]);
assert.deepEqual(rules(validateResolved({ ...X.SEPARATE_YEARS, transforms: [{ kind: "period_comparison", of: ["count"], earlier: { kind: "absolute", from: "2020-01", to: "2020-12" }, later: { kind: "absolute", from: "2024-01", to: "2024-12" }, outputs: ["change"] }] }, release, layer, geo).problems), ["R2"], "2020 is not selected");
assert.deepEqual(rules(validateResolved({ ...X.SEPARATE_YEARS, transforms: [{ kind: "period_comparison", of: ["count"], earlier: { kind: "absolute", from: "2019-01", to: "2019-12" }, later: { kind: "absolute", from: "2024-01", to: "2024-12" }, outputs: ["change"] }] }, release, layer, geo).problems), []);
assert.deepEqual(validateResolved(ytdRate, release, layer, geo).problems, [], "since 2026-01 resolves to January-October 2026: one data year");
assert.deepEqual(rules(validateResolved({ ...ytdRate, period: { kind: "since", from: "2024-01" } }, release, layer, geo).problems), ["R5"]);

console.log(`nibrs plan language: ${Object.keys(X.EXAMPLES).length} plans and ${Object.keys(X.OUTCOMES).length} reader outcomes valid; every rule refuses its case`);
