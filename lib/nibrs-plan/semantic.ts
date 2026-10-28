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
import type { CountingUnit, Source, TimeBasis } from "./plan";

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
  /** A numeric condition on a numerically decoded or derived dimension (flash mob: offender segments >= 6). */
  | { kind: "numeric"; dimension: string; op: ">=" | "<=" | "between"; values: number[] }
  /** True when a row reached through link `link` (resolved with SemanticLayer.link) satisfies `where`, whose
   * dimensions belong to that link's `to` entity. Links chain: a nested exists starts from the outer link's `to`. */
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
  aggregation:
    | { kind: "count_distinct" }
    | { kind: "sum"; column: string }
    /**
     * A sum of component measures, each in its own (FBI standard) unit, with unit "fbi_standard" (violent crime:
     * murder, rape and aggravated assault victims plus robbery offenses). Not additive across categories. A rate
     * over it is allowed (as the FBI publishes); a share needs the same composite as its denominator (S12).
     */
    | { kind: "composite"; components: string[] };
  predicate: SemanticPredicate | null;
  /**
   * Where the measure may be added. Agencies and months: yes for counts. Categories: no when a unit can belong to two
   * of them (violent crime is not the sum of its offenses' victims when one victim has two offenses).
   */
  additive: { acrossAgencies: boolean; acrossMonths: boolean; acrossCategories: boolean };
  timeBases: TimeBasis[];
  /** The finest period the source records it in (G5): every NIBRS measure is monthly; annual sources are "year" (R6). */
  grain: "month" | "year";
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
  /** The source this layer describes (G1); a plan must name the same one (S1). */
  source: Source;
  version: string;
  entity(id: EntityId): SemanticEntity | undefined;
  measure(id: string): SemanticMeasure | undefined;
  dimension(id: string): SemanticDimension | undefined;
  /** The single link path from one entity to another (undefined when not related). Multi-step paths compose links. */
  path(from: EntityId, to: EntityId): SemanticLink[] | undefined;
  /** A link by id, as named in measure predicates. */
  link(id: string): SemanticLink | undefined;
  /** Every measure, so a layer can be checked as a whole (checkLayer). */
  measures(): SemanticMeasure[];
};

/** Cardinality of a path: many if any step is many. */
export function pathCardinality(path: SemanticLink[]): "one" | "many" {
  return path.some((l) => l.cardinality === "many") ? "many" : "one";
}

/**
 * The layer's own consistency, run when a semantic version is loaded: every measure's entity exists, and every
 * predicate resolves (each exists names a link that starts where the predicate stands, and each dimension condition
 * belongs to the entity it is evaluated on). A layer that fails is not used.
 */
export function checkLayer(layer: SemanticLayer): string[] {
  const out: string[] = [];
  const walk = (p: SemanticPredicate, at: EntityId, where: string) => {
    if (p.kind === "numeric") {
      const d = layer.dimension(p.dimension);
      if (!d) out.push(`${where}: unknown dimension ${p.dimension}`);
      else if (d.entity !== at) out.push(`${where}: ${p.dimension} belongs to ${d.entity}, evaluated on ${at}`);
      else if (!d.numeric) out.push(`${where}: ${p.dimension} is not numeric`);
      else {
        const n = p.op === "between" ? 2 : 1;
        if (p.values.length !== n || !p.values.every(Number.isFinite)) out.push(`${where}: ${p.op} takes ${n} finite value(s)`);
        else if (p.op === "between" && p.values[0] > p.values[1]) out.push(`${where}: between bounds are reversed`);
        else if (p.values.some((v) => v < d.numeric!.min || v > d.numeric!.max)) out.push(`${where}: a bound is outside ${d.numeric.min}-${d.numeric.max}`);
      }
    } else if (p.kind === "dimension") {
      const d = layer.dimension(p.dimension);
      if (!d) out.push(`${where}: unknown dimension ${p.dimension}`);
      else if (d.entity !== at) out.push(`${where}: ${p.dimension} belongs to ${d.entity}, evaluated on ${at}`);
      else if (d.values) for (const v of p.values) if (!(v in d.values) && !d.unknownCodes.includes(v)) out.push(`${where}: ${v} is not a code of ${p.dimension}`);
    } else if (p.kind === "exists") {
      const l = layer.link(p.link);
      if (!l) out.push(`${where}: unknown link ${p.link}`);
      else if (l.from !== at) out.push(`${where}: link ${p.link} starts at ${l.from}, not ${at}`);
      else p.where.forEach((w) => walk(w, l.to, `${where} > ${p.link}`));
    } else p.of.forEach((w) => walk(w, at, where));
  };
  for (const m of layer.measures()) {
    if (!layer.entity(m.entity)) out.push(`${m.id}: unknown entity ${m.entity}`);
    if (m.predicate) walk(m.predicate, m.entity, m.id);
    if (m.aggregation.kind === "composite") {
      if (m.unit !== "fbi_standard") out.push(`${m.id}: a composite counts unit fbi_standard`);
      for (const c of m.aggregation.components) {
        const cm = layer.measures().find((x) => x.id === c);
        if (!cm) out.push(`${m.id}: unknown component ${c}`);
        else if (cm.aggregation.kind === "composite") out.push(`${m.id}: component ${c} is itself a composite`);
      }
    }
  }
  return out;
}
