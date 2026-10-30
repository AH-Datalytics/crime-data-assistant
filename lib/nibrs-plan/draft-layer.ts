/**
 * NIBRSAI's DRAFT semantic layer: just enough of the shared layer's shape (semantic.ts) to validate the plans the
 * adapter (from-spec.ts) writes, built from the codes the app uses today. It is replaced by the adapter over the
 * shared YAML (nibrs-model/semantic/) once that exists; it is also NIBRSAI's concrete input to that schema.
 *
 * Measures are generated per offense family and counting unit: the units an offense allows are the measures defined
 * for it (definitions doc, lesson 6). Their predicates are left null here: executable definitions come from the shared
 * layer; this draft checks plan structure, units, reachability, cardinality and codes, not counts.
 */
import { LOCATION_TYPES, PROPERTY_LOSS_TYPES, RACE_CODES, ETHNICITY_CODES, WEAPON_TYPES } from "../nibrs-codes";
import { GROUP_B, MEASURE_CODES, PERSON_CODES } from "../nibrs-question-types";
import type { CountingUnit, TimeBasis } from "./plan";
import type { EntityId, SemanticDimension, SemanticEntity, SemanticLayer, SemanticLink, SemanticMeasure } from "./semantic";

export const DRAFT_SEMANTIC_VERSION = "nibrsai-draft/1";
const YEARS: [number, number] = [1991, 2026];
const ALL_ADD = { acrossAgencies: true, acrossMonths: true, acrossCategories: false };

const entity = (id: string, key: string[], dates: Partial<Record<TimeBasis, string>> = { incident_date: "incident_date" }): SemanticEntity =>
  ({ id, table: id, key, dates, agencyColumn: "ori" });
const INC = ["data_year", "ori", "incident_num"];
const ENTITIES: SemanticEntity[] = [
  entity("incident", INC), entity("offense", [...INC, "offense_code"]), entity("victim", [...INC, "victim_seq"]),
  entity("offender", [...INC, "offender_seq"]), entity("arrestee", [...INC, "arrestee_seq"], { incident_date: "incident_date", arrest_date: "arrest_date" }),
  entity("group_b_arrest", ["data_year", "ori", "arrest_transaction_num", "arrestee_seq"], { arrest_date: "arrest_date" }),
  entity("property", [...INC, "loss_type", "description", "ordinal"]), entity("property_drug", [...INC, "loss_type", "description", "ordinal", "drug_ordinal"]),
  entity("victim_offense", [...INC, "victim_seq", "offense_code"]), entity("victim_offender", [...INC, "victim_seq", "offender_seq"]),
  entity("offense_weapon", [...INC, "offense_code", "ordinal"]), entity("offense_bias", [...INC, "offense_code", "ordinal"]),
];

/** Every link joins on the incident's key, plus the entity keys that make it exact. */
const INC_ON: [string, string][] = [["data_year", "data_year"], ["ori", "ori"], ["incident_num", "incident_num"]];
const L = (id: string, from: EntityId, to: EntityId, cardinality: "one" | "many", extra: [string, string][] = [], pairs?: SemanticLink["pairs"]): SemanticLink =>
  ({ id, from, to, cardinality, on: [...INC_ON, ...extra], ...(pairs ? { pairs } : {}) });
const LINKS: SemanticLink[] = [
  ...["offense", "victim", "offender", "arrestee", "property"].flatMap((e) => [L(`${e}_incident`, e, "incident", "one"), L(`incident_${e}s`, "incident", e, "many")]),
  L("property_drugs", "property", "property_drug", "many", [["loss_type", "loss_type"], ["description", "description"], ["ordinal", "ordinal"]]),
  L("drug_property", "property_drug", "property", "one", [["loss_type", "loss_type"], ["description", "description"], ["ordinal", "ordinal"]]),
  L("victim_offenses", "victim", "victim_offense", "many", [["victim_seq", "victim_seq"]]),
  L("victim_offense_offense", "victim_offense", "offense", "one", [["offense_code", "offense_code"]]),
  L("victim_offenders", "victim", "victim_offender", "many", [["victim_seq", "victim_seq"]], { entity: "offender", dimensions: ["victim_offender.offender_age", "victim_offender.offender_sex", "victim_offender.offender_race"] }),
  L("victim_offender_victim", "victim_offender", "victim", "one", [["victim_seq", "victim_seq"]]),
  L("offense_weapons", "offense", "offense_weapon", "many", [["offense_code", "offense_code"]]),
  L("offense_biases", "offense", "offense_bias", "many", [["offense_code", "offense_code"]]),
  L("arrestee_arrest_offense", "arrestee", "offense", "one", [["arrest_offense", "offense_code"]]),
];

/**
 * Routes that must not be found by breadth first: a victim reaches offense attributes only through its own connected
 * offenses (never through every offense of its incident), and an arrestee through its arrest offense.
 */
const PREFERRED: Record<string, string[]> = {
  "victim>offense": ["victim_offenses", "victim_offense_offense"],
  "victim>offense_weapon": ["victim_offenses", "victim_offense_offense", "offense_weapons"],
  "victim>offense_bias": ["victim_offenses", "victim_offense_offense", "offense_biases"],
  "arrestee>offense_weapon": ["arrestee_arrest_offense", "offense_weapons"],
};

/** The declared path between two entities: a preferred route, else the shortest (breadth first). */
function path(from: EntityId, to: EntityId): SemanticLink[] | undefined {
  if (from === to) return [];
  const preferred = PREFERRED[`${from}>${to}`];
  if (preferred) return preferred.map((id) => LINKS.find((l) => l.id === id)!);
  const seen = new Set([from]);
  let frontier: [EntityId, SemanticLink[]][] = [[from, []]];
  while (frontier.length) {
    const next: [EntityId, SemanticLink[]][] = [];
    for (const [at, route] of frontier) {
      for (const l of LINKS.filter((x) => x.from === at && !seen.has(x.to))) {
        if (l.to === to) return [...route, l];
        seen.add(l.to);
        next.push([l.to, [...route, l]]);
      }
    }
    frontier = next;
  }
  return undefined;
}

const UNIT_ENTITY: Partial<Record<CountingUnit, EntityId>> = {
  victim: "victim", offense: "offense", incident: "incident", offender: "offender", arrest: "arrestee",
  victim_offender: "victim_offender", dollars: "property", property_segment: "property", fbi_standard: "incident", group_b_arrest: "group_b_arrest",
};
const measure = (id: string, unit: CountingUnit, timeBases: TimeBasis[] = ["incident_date"]): SemanticMeasure =>
  ({ id, entity: UNIT_ENTITY[unit] ?? "offense", unit, label: id, aggregation: unit === "dollars" ? { kind: "sum", column: "value" } : { kind: "count_distinct" }, predicate: null, additive: ALL_ADD, timeBases, grain: "month", validYears: YEARS });

const MEASURES: SemanticMeasure[] = [];
for (const [name, codes] of Object.entries(MEASURE_CODES)) {
  // A Group B offense (DUI) exists only as Group B arrests, placed in time by arrest date.
  if (codes.every((c) => GROUP_B.has(c))) { MEASURES.push(measure(`group_b_arrests.${name}`, "group_b_arrest", ["arrest_date"])); continue; }
  const person = codes.some((c) => PERSON_CODES.has(c));
  const units: CountingUnit[] = ["offense", "incident", "offender", "arrest", ...(person ? ["victim" as const, "victim_offender" as const] : [])];
  for (const u of units) MEASURES.push(measure(`${{ offense: "offenses", incident: "incidents", offender: "offenders", arrest: "arrests", victim: "victims", victim_offender: "victim_offender" }[u as string]}.${name}`, u, u === "arrest" ? ["incident_date", "arrest_date"] : ["incident_date"]));
  MEASURES.push(measure(`offenses.${name}_cleared`, "offense"));
}
// D19: drug equipment violations (35B), the second part of drug crimes, which the question vocabulary does not name yet.
for (const u of ["offense", "incident", "offender", "arrest"] as CountingUnit[]) MEASURES.push(measure(`${{ offense: "offenses", incident: "incidents", offender: "offenders", arrest: "arrests" }[u as string]}.drug_equipment`, u, u === "arrest" ? ["incident_date", "arrest_date"] : ["incident_date"]));
// Property crimes also record victims (lesson 6): victims are a unit for every crime against property here.
for (const name of ["theft", "theft_from_motor_vehicle", "motor_vehicle_theft", "burglary", "shoplifting", "arson", "property_crime"]) MEASURES.push(measure(`victims.${name}`, "victim"));
for (const [name, units] of Object.entries({
  carjacking: ["incident", "victim", "offender", "arrest", "offense"], domestic_violence: ["victim", "incident", "arrest", "offense"],
  hate_crime: ["offense", "incident", "victim"],
} as Record<string, CountingUnit[]>)) {
  for (const u of units) MEASURES.push(measure(`${{ offense: "offenses", incident: "incidents", offender: "offenders", arrest: "arrests", victim: "victims" }[u as string]}.${name}`, u, u === "arrest" ? ["incident_date", "arrest_date"] : ["incident_date"]));
}
MEASURES.push({ ...measure("violent_crime.ucr", "fbi_standard"), aggregation: { kind: "composite", components: ["victims.murder", "victims.rape", "offenses.robbery", "victims.aggravated_assault"] } });
MEASURES.push(measure("property_crime.ucr", "offense"), measure("all_crime.offenses", "offense"));
MEASURES.push(measure("property.motor_vehicle_property", "dollars"), measure("property.property_value", "dollars"),
  measure("property.motor_vehicle_property_segments", "property_segment"), measure("property.property_value_segments", "property_segment"));

const dim = (id: string, ent: EntityId, extra: Partial<SemanticDimension> = {}): SemanticDimension =>
  ({ id, entity: ent, column: id.split(".")[1], label: id, unknownCodes: ["U", "99", ""], validYears: YEARS, ...extra });
const AGE = { min: 1, max: 99, special: { "00": "Unknown", NN: "Under 24 hours", NB: "1-6 days", BB: "7-364 days" } };
const SEX = { F: "Female", M: "Male", U: "Unknown" };
const DIMENSIONS: SemanticDimension[] = [
  dim("time.month", "time"), dim("time.year", "time"), dim("geo.agency", "agency"), dim("geo.state", "agency"),
  ...["victim", "offender", "arrestee", "group_b_arrest"].flatMap((e) => [dim(`${e}.sex`, e, { values: SEX }), dim(`${e}.race`, e, { values: RACE_CODES }), dim(`${e}.ethnicity`, e, { values: ETHNICITY_CODES }), dim(`${e}.age`, e, { numeric: AGE })]),
  dim("offense.location_type", "offense", { values: LOCATION_TYPES }), dim("offense.offense", "offense"),
  dim("offense.clearance_type", "incident", { values: { arrest: "Cleared by arrest", A: "Death of offender", B: "Prosecution declined", C: "In custody of other jurisdiction", D: "Victim refused to cooperate", E: "Juvenile, no custody", none: "Not cleared" } }),
  dim("offense.clearance_method", "incident", { values: { arrest: "By arrest", exceptional: "By exceptional means", none: "Not cleared" } }),
  // P66's STATUS level (Jeff 2026-10-30): cleared or uncleared, the incident's status as of the file (P64).
  dim("offense.clearance_status", "incident", { values: { cleared: "Cleared", none: "Uncleared" } }),
  dim("offense_weapon.weapon", "offense_weapon", { values: { ...WEAPON_TYPES, ...Object.fromEntries(["11", "12", "13", "14", "15"].map((c) => [`${c}A`, `${WEAPON_TYPES[c]}, automatic`])) } }), dim("offense_bias.bias", "offense_bias"),
  dim("property.loss_type", "property", { values: PROPERTY_LOSS_TYPES }), dim("property.description", "property"),
  dim("property_drug.drug_type", "property_drug"), dim("property_drug.drug", "property_drug"),
  dim("victim_offender.relationship", "victim_offender"), dim("victim_offender.victim_offender_race", "victim_offender"),
  dim("victim_offense.offense", "victim_offense"), dim("incident.hour", "incident"),
];

export const DRAFT_LAYER: SemanticLayer = {
  source: "nibrs",
  version: DRAFT_SEMANTIC_VERSION,
  entity: (id) => ENTITIES.find((e) => e.id === id),
  measure: (id) => MEASURES.find((m) => m.id === id),
  dimension: (id) => DIMENSIONS.find((d) => d.id === id),
  path,
  link: (id) => LINKS.find((l) => l.id === id),
  measures: () => MEASURES,
};
