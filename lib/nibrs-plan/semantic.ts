/**
 * What NIBRSAI's plan validator and compiler need from the shared semantic layer (nibrs-model, versioned YAML).
 * NIBRSAI's side of the contract; the shared layer's schema is owned by the "NIBRS model" session. An adapter from
 * that YAML to this interface lives here, so a schema change touches one file.
 *
 * Everything the compiler needs is typed here, so it invents no semantics: each entity's identity key, each measure's
 * executable definition (aggregation, distinct key, predicate, supported time bases), each dimension's column and
 * decoding, and each link's path and cardinality. The compiler counts DISTINCT entity keys, so a join used to reach
 * a dimension can never multiply a count; one-to-many dimensions are reached through one link row (pairing).
 */
import type { CountingUnit, TimeBasis } from "./plan";

export type EntityId = string;

export type SemanticEntity = {
  id: EntityId;                 // incident, offense, victim, offender, arrestee, group_b_arrest, property, victim_offense, victim_offender, offense_weapon ...
  table: string;                // canonical table
  key: string[];                // identity columns, e.g. victim: [data_year, ori, incident_num, victim_seq]
  /** The entity this one belongs to one-to-one (victim -> incident), with the key columns that join them. */
  parent?: { entity: EntityId; on: [string, string][] };
  /** Date columns available as time bases, by basis. */
  dates: Partial<Record<TimeBasis, string>>;
  /** Columns that place a row in an agency (ori) and data year. */
  agencyColumn: string;
};

/** A predicate in the layer's own terms: a dimension condition on the measure's entity, or an existence over a link. */
export type SemanticPredicate =
  | { kind: "dimension"; dimension: string; op: "in" | "not_in"; values: string[] }
  | { kind: "exists"; link: string; where: SemanticPredicate[] }
  | { kind: "all"; of: SemanticPredicate[] }
  | { kind: "any"; of: SemanticPredicate[] };

export type SemanticMeasure = {
  id: string;
  entity: EntityId;
  unit: CountingUnit;
  label: string;
  /**
   * count_distinct counts distinct `entity` keys satisfying `predicate` (victims.murder: victims with an exists over
   * victim_offense where offense_code = 09A). sum adds `column` over distinct entity rows (property dollars, vehicles).
   */
  aggregation: { kind: "count_distinct" } | { kind: "sum"; column: string };
  predicate: SemanticPredicate | null;
  /**
   * Where the measure may be added. Agencies and months: yes for counts. Categories: no when a unit can belong to two
   * of them (violent crime is not the sum of its offenses' victims when one victim has two offenses).
   */
  additive: { acrossAgencies: boolean; acrossMonths: boolean; acrossCategories: boolean };
  timeBases: TimeBasis[];
  validYears: [number, number];
};

export type SemanticDimension = {
  id: string;
  entity: EntityId;
  column: string;
  label: string;
  /** Original NIBRS codes -> labels. */
  values?: Record<string, string>;
  /** Codes meaning unknown or not reported; always visible categories. */
  unknownCodes: string[];
  /**
   * For numeric codes (age): how to decode. `special` codes (00 unknown, NN/NB/BB infants, 99 meaning "99 or over")
   * map to a category label and never fall in a numeric bin; others parse as integers in [min, max].
   */
  numeric?: { min: number; max: number; special: Record<string, string> };
  /** Values valid for some eras only (a code added in 2021) are listed with their years. */
  valueYears?: Record<string, [number, number]>;
  validYears: [number, number];
};

export type SemanticLink = {
  id: string;
  from: EntityId;
  to: EntityId;
  /** Rows of `to` per row of `from`. */
  cardinality: "one" | "many";
  /** Key columns joining from -> to. */
  on: [string, string][];
  /**
   * For a link entity that pairs two ends (victim_offender pairs a victim with one offender): dimensions of the far
   * end that are read THROUGH the pair row, so a grouping by relationship and offender age uses the same pair and
   * never a cross product of independent joins.
   */
  pairs?: { entity: EntityId; dimensions: string[] };
};

export type SemanticLayer = {
  version: string;
  entity(id: EntityId): SemanticEntity | undefined;
  measure(id: string): SemanticMeasure | undefined;
  dimension(id: string): SemanticDimension | undefined;
  /** The single link path from one entity to another (undefined when not related). Multi-step paths compose links. */
  path(from: EntityId, to: EntityId): SemanticLink[] | undefined;
};

/** Cardinality of a path: many if any step is many. */
export function pathCardinality(path: SemanticLink[]): "one" | "many" {
  return path.some((l) => l.cardinality === "many") ? "many" : "one";
}
