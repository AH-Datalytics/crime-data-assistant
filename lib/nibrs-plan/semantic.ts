/**
 * What NIBRSAI's plan validator and compiler need from the shared semantic layer (nibrs-model, versioned YAML).
 * This is NIBRSAI's side of the contract; the shared layer's own schema is owned by the "NIBRS model" session.
 * The adapter from that YAML to this interface lives here, so a schema change touches one file.
 */
import type { CountingUnit } from "./plan";

export type EntityId = "incident" | "offense" | "victim" | "offender" | "arrestee" | "group_b_arrest" | "property" | "agency" | string;

export type SemanticMeasure = {
  id: string;
  /** The entity whose rows are counted, and the counting unit. */
  entity: EntityId;
  unit: CountingUnit;
  /** Definition in the layer's own filter terms, for provenance ("victim connected to offense 09A"). */
  definition: string;
  label: string;
  /** Aggregations the measure permits: counts add across agencies and months; shares and rates never do. */
  additive: boolean;
  /** Data years in which the definition is valid (codes and segments change by era). */
  validYears: [number, number];
};

export type SemanticDimension = {
  id: string;
  entity: EntityId;
  label: string;
  /** Code -> label, kept as the original NIBRS codes. */
  values?: Record<string, string>;
  /** Codes meaning unknown or not reported, kept visible as categories. */
  unknownCodes: string[];
  numeric?: boolean;
  validYears: [number, number];
};

export type SemanticLayer = {
  version: string;
  measure(id: string): SemanticMeasure | undefined;
  dimension(id: string): SemanticDimension | undefined;
  /**
   * Cardinality from one row of `from` to rows of `to`, following the canonical links
   * (victim -> offense is many: up to 10 connected offenses; offense -> incident is one).
   * undefined when the two are not related.
   */
  cardinality(from: EntityId, to: EntityId): "one" | "many" | undefined;
};
