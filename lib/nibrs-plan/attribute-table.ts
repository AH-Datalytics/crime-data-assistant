/**
 * The attribute table (general query model, step 1): for each counting unit, the dimensions it can be grouped by, as DATA. compile.ts builds its grouping table (GROUPABLE) from
 * these rows with a builder per `kind`; nothing here is SQL. Every row's dimension must exist in the semantic layer (draft-layer.ts) and be of an entity the layer links to the unit
 * (scripts/test-groupable-table.ts), and the table built from the rows is held byte-identical to the one the hand-written code produced (scripts/fixtures/nibrs-groupable-golden.json).
 *
 * kinds (alias = the units query's alias: o offense, v victim, f offender, a arrestee):
 *   own        a column of the unit itself; `unknown`: a blank is the recorded-unknown code (P86); `age`: read in bins
 *   hour       the incident's hour, read in time-of-day bins (Jeff 2026-11-15)
 *   offenders  an attribute of the incident's offenders (P49), several per unit
 *   paired     an attribute of the offenders a victim's relationship segments link to it (P65), several per unit
 *   linked     a child segment's column (relationship, circumstance, weapon), several per unit
 *   clearance  the incident's clearance as of the file (P64-P67): type, method, status
 *   self       an offender's own attribute (sequence 00 = Unknown, P44)
 */
export type AttributeKind = "own" | "hour" | "offenders" | "paired" | "linked" | "clearance" | "self";
export type AttributeRow = {
  unit: "victim" | "offense" | "incident" | "offender" | "arrestee" | "group_b_arrest";
  dimension: string;
  kind: AttributeKind;
  alias: string;
  /** own, self, offenders, paired: the person attribute or the column; linked: the column of the child table. */
  column?: string;
  unknown?: true;
  age?: true;
  /** linked: the child segment, its alias, and the keys it shares with the unit (victim: incident + victim + occurrence; offense: incident + code + occurrence). */
  table?: string; childAlias?: string; keys?: "victim" | "offense";
};

const PERSON = ["sex", "race", "ethnicity", "age"] as const;
const CLEAR = ["offense.clearance_type", "offense.clearance_method", "offense.clearance_status"];
const clear = (unit: AttributeRow["unit"], alias: string): AttributeRow[] => CLEAR.map((dimension) => ({ unit, dimension, kind: "clearance" as const, alias }));
const offenders = (unit: AttributeRow["unit"], alias: string): AttributeRow[] => PERSON.map((c) => ({ unit, dimension: `offender.${c}`, kind: "offenders" as const, alias, column: c }));
const people = (unit: "arrestee" | "group_b_arrest"): AttributeRow[] => [
  { unit, dimension: `${unit}.race`, kind: "own", alias: "a", column: "race", unknown: true }, { unit, dimension: `${unit}.sex`, kind: "own", alias: "a", column: "sex", unknown: true },
  { unit, dimension: `${unit}.ethnicity`, kind: "own", alias: "a", column: "ethnicity", unknown: true }, { unit, dimension: `${unit}.age`, kind: "own", alias: "a", column: "age", age: true },
];

export const ATTRIBUTE_TABLE: AttributeRow[] = [
  { unit: "victim", dimension: "victim.race", kind: "own", alias: "v", column: "race", unknown: true }, { unit: "victim", dimension: "victim.sex", kind: "own", alias: "v", column: "sex", unknown: true },
  { unit: "victim", dimension: "victim.ethnicity", kind: "own", alias: "v", column: "ethnicity", unknown: true }, { unit: "victim", dimension: "victim.age", kind: "own", alias: "v", column: "age", age: true },
  { unit: "victim", dimension: "victim_offender.relationship", kind: "linked", alias: "v", table: "victim_offender", childAlias: "r", column: "offender_relationship", keys: "victim" },
  // Element 31 (coordinator 2026-11-04): up to two per victim, each counted once under each (categories_overlap).
  { unit: "victim", dimension: "victim_circumstance.circumstance", kind: "linked", alias: "v", table: "victim_circumstance", childAlias: "vc", column: "circumstance", keys: "victim" },
  // Element 33 (Coordinator 2026-11-22): up to five types of injury per victim, each counted once under each (categories_overlap).
  { unit: "victim", dimension: "victim_injury.injury", kind: "linked", alias: "v", table: "victim_injury", childAlias: "vi", column: "injury", keys: "victim" },
  { unit: "victim", dimension: "incident.hour", kind: "hour", alias: "v" },
  ...offenders("victim", "v"),
  ...PERSON.map((c): AttributeRow => ({ unit: "victim", dimension: `victim_offender.offender_${c}`, kind: "paired", alias: "v", column: c })),
  ...clear("victim", "v"),
  { unit: "offense", dimension: "offense.location_type", kind: "own", alias: "o", column: "location_type" },
  { unit: "offense", dimension: "offense_weapon.weapon", kind: "linked", alias: "o", table: "offense_weapon", childAlias: "w", column: "weapon", keys: "offense" },
  { unit: "offense", dimension: "incident.hour", kind: "hour", alias: "o" },
  ...offenders("offense", "o"),
  ...clear("offense", "o"),
  { unit: "incident", dimension: "incident.hour", kind: "hour", alias: "o" },
  ...clear("incident", "o"),
  ...PERSON.map((c): AttributeRow => ({ unit: "offender", dimension: `offender.${c}`, kind: "self", alias: "f", column: c, ...(c === "age" ? { age: true as const } : {}) })),
  ...people("arrestee"),
  ...people("group_b_arrest"),
];
