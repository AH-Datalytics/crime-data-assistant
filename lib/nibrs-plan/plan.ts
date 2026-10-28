/**
 * NIBRS structured plan language, v1 (spec: docs/superpowers/specs/2026-10-28-nibrs-plan-language.md).
 *
 * The reader fills a plan; it never writes SQL. A plan names semantic-layer objects (measures, dimensions, entities)
 * by id. It is validated twice: structurally here (validate.ts, no semantic layer needed) and against a pinned
 * semantic-layer version before compilation. Compilation to DuckDB over a canonical release is deterministic.
 *
 * Nothing here knows about tables. Ids such as "victim.race" or "victims.murder" are semantic-layer ids; the
 * semantic layer says which entity and grain each lives at, its cardinality to every other entity, its unknown
 * codes and the eras in which it is valid.
 */

export const PLAN_VERSION = "nibrs-plan/1" as const;

/* ------------------------------------------------------------------ outcome -------------------------------------- */

/** What the reader returns: a plan, a consequential clarification, or a stated limitation. */
export type ReaderOutcome =
  | { kind: "plan"; plan: NibrsPlan }
  /** Asked only when the readings give different answers (plan principle 6). Each option is a complete plan. */
  | { kind: "clarify"; question: string; options: { label: string; plan: NibrsPlan }[]; parts: PartRef[] }
  /** A concept NIBRS does not record, or data the release does not hold. Every unmet part is named. */
  | { kind: "limitation"; parts: PartRef[]; reason: LimitationReason; explanation: string };

export type LimitationReason =
  | "not_recorded_in_nibrs"     // e.g. immigration status, motive beyond bias, gang membership of victims
  | "outside_release_coverage"  // years or agencies the pinned release does not hold
  | "unsupported_capability"    // a plan form not yet switched on for this era (questions switch by capability)
  | "unresolved_place"
  | "explanation_requested";    // causes, policy: NIBRSAI reports what the data records, nothing more

/* ------------------------------------------------------------------ the plan ------------------------------------- */

export type NibrsPlan = {
  version: typeof PLAN_VERSION;
  /** The semantic-layer version the plan was validated against; part of provenance and every cache key. */
  semanticVersion: string;
  question: string;
  /** Places the plan covers. Several places are several rows (or a grouping), never summed unless `combine` says so. */
  geography: Geography;
  period: Period;
  /** Which date places a unit in a period. */
  timeBasis: TimeBasis;
  /** One or more measures, each its own column. Measures with different units are never added together. */
  measures: MeasureSpec[];
  /** AND-combined. Each filter names the entity it applies to; existence filters carry their own scope. */
  filters: Filter[];
  /** Any number of groupings, in display order. */
  groupings: Grouping[];
  /** How each measure is presented: count, share within a partition, rate, ratio. */
  statistics: Statistic[];
  /** Optional transforms over the grouped result. Applied in the order listed. */
  transforms: Transform[];
  coverage: CoveragePolicy;
  /** Every default the reader applied, so provenance can show the resolved interpretation. */
  defaults: AppliedDefault[];
  /** Request accounting: every part of the question bound to the plan path that applies it. */
  bindings: PartBinding[];
};

/* ------------------------------------------------------------------ geography ------------------------------------ */

export type Place =
  /** National is a sum of reported counts across agencies, never an agency (CLAUDE.md, rules in the plan doc). */
  | { kind: "national" }
  | { kind: "state"; code: string }
  /** One agency by ORI. A city's police department is an agency; "Houston" resolves to TXHPD0000. */
  | { kind: "agency"; ori: string; label: string }
  | { kind: "county"; fips: string; label: string }
  /** A set of agencies chosen by attributes (e.g. cities of 250,000 or more), resolved per data year. */
  | { kind: "agency_set"; where: AgencyPredicate[]; within: { kind: "national" } | { kind: "state"; code: string } };

export type AgencyPredicate =
  | { field: "agency.population"; op: ">=" | ">" | "<=" | "<" | "between"; value: number | [number, number] }
  | { field: "agency.type"; op: "in"; value: string[] }               // city, county, university, state police, tribal ...
  | { field: "agency.population_group"; op: "in"; value: string[] };  // FBI population group codes

export type Geography = {
  places: Place[];
  /** "separate": one result per place (default). "combined": one total over the places, only when they do not overlap. */
  combine: "separate" | "combined";
};

/* ------------------------------------------------------------------ time ----------------------------------------- */

export type YearMonth = `${number}-${number}`; // "2022-01"

export type Period =
  /** Months inclusive. A year is "2025-01".."2025-12". */
  | { kind: "absolute"; from: YearMonth; to: YearMonth }
  /** Resolved against the pinned release at compile time; the resolution is recorded in provenance. */
  | { kind: "relative"; anchor: RelativeAnchor; from?: YearMonth; count?: number };

export type RelativeAnchor =
  | "latest_complete_year"   // today's H1 default
  | "latest_complete_month"
  | "since"                  // from `from` through the release's last month
  | "last_n_years"           // `count` complete years ending at the latest complete year
  | "last_n_months";

export type TimeBasis = "incident_date" | "arrest_date" | "clearance_date";

/* ------------------------------------------------------------------ measures ------------------------------------- */

/**
 * The counting unit is part of the contract. The semantic layer defines each measure with exactly one unit; the plan
 * repeats it so a reader that meant victims cannot silently get offenses.
 */
export type CountingUnit =
  | "victim"            // distinct victim segments
  | "victim_offense"    // victim x connected offense pairs (one victim of 09A and 13A counts twice)
  | "offense"           // offense segments (at most one per code per incident)
  | "incident"
  | "offender"          // offender segments with information (segment 00 means none is known)
  | "arrestee"          // Group A arrestee segments
  | "arrest"            // Group A + Group B arrests
  | "property_segment"
  | "dollars"
  | "vehicles";         // stolen or recovered motor vehicle counts

export type MeasureSpec = {
  /** Semantic-layer measure id, e.g. "victims.murder", "offenses.theft_from_motor_vehicle", "incidents.carjacking". */
  id: string;
  unit: CountingUnit;
  /** Column name in the result. */
  as: string;
  /** Filters that apply to this measure only (on top of the plan's filters). */
  filters?: Filter[];
};

/* ------------------------------------------------------------------ filters -------------------------------------- */

export type Filter = AttributeFilter | ExistsFilter;

/** A condition on an attribute reachable 1:1 from the measure's counted entity. */
export type AttributeFilter = {
  kind: "attribute";
  /** Semantic dimension id, e.g. "victim.sex", "offense.location_type", "agency.state". */
  dimension: string;
  op: "in" | "not_in" | "between" | "is_unknown" | "is_known";
  values?: (string | number)[];
};

/**
 * "Incidents containing a stolen firearm": true when at least one row of `entity`, related to the counted unit at
 * `scope`, satisfies every condition in `where`. Required whenever the condition sits on a 1:n relation of the counted
 * entity; a join there would count a unit once per matching row (M5: two firearm segments, one theft).
 */
export type ExistsFilter = {
  kind: "exists";
  /** The level at which the relation is checked: same incident, same victim, same offense. */
  scope: "incident" | "victim" | "offense" | "offender" | "arrestee";
  /** The related entity: property, offense, victim, offender, arrestee, weapon, injury, relationship ... */
  entity: string;
  where: AttributeFilter[];
  negate?: boolean;
  /**
   * Required for property at incident scope: NIBRS links property to the incident, not to an offense. The answer then
   * says the property is not attributed to one offense (case N2). The validator refuses an incident-scoped property
   * filter without it.
   */
  attribution?: "incident_level_only";
};

/* ------------------------------------------------------------------ groupings ------------------------------------ */

export type Grouping = {
  /** Semantic dimension id: "time.month", "time.year", "victim.race", "geo.agency", "offense.code", "property.description". */
  dimension: string;
  /** For numeric dimensions (age): explicit bins. Unknown age stays its own bin. */
  bins?: { label: string; from?: number; to?: number }[];
  /**
   * For a dimension that is 1:n from the counted unit (weapon of an offense, relationship of a victim): count the unit
   * once under EACH value (totals exceed the unit count; the answer says so), or require the caller to pick one value
   * with a filter. The validator refuses a 1:n grouping without this.
   */
  multiValue?: "each_value";
  /** Unknown codes are a visible category unless the question excluded them by a filter. */
  unknown: "visible";
  /** How a combination absent from the data is shown in a group with a nonzero denominator. */
  absent: "zero" | "omit";
};

/* ------------------------------------------------------------------ statistics ----------------------------------- */

export type Statistic =
  | { kind: "count"; measure: string }
  /**
   * A share of `measure` within each combination of `partition` (grouping dimensions). [] is the share of the whole
   * result. The denominator is the same measure, under the same filters, summed over the groupings NOT in the
   * partition. Shares are never recomputed over displayed cells only.
   */
  | { kind: "share"; measure: string; partition: string[]; denominatorMeasure?: string }
  /** Per 100,000 (or `per`) of the cohort's covered population (shared spec D8). */
  | { kind: "rate"; measure: string; per: number; population: "covered_population" | "census_resident" }
  /** numerator / denominator, e.g. a clearance rate (offenses cleared / offenses). */
  | { kind: "ratio"; numerator: string; denominator: string; as: string };

/* ------------------------------------------------------------------ transforms ----------------------------------- */

export type Transform =
  /** Compare a later period to an earlier one, per remaining group. */
  | { kind: "period_comparison"; earlier: Period; later: Period; outputs: ("earlier" | "later" | "change" | "pct_change")[] }
  /** Trailing window over time.month; a window is reported only when every month in it is known (else UNKNOWN). */
  | { kind: "rolling"; months: number; aggregate: "sum" | "mean" }
  /** Top or bottom N of `by` within each combination of `per` (e.g. per time.month). Ties at the cut are kept. */
  | { kind: "top_n"; n: number; by: string; direction: "top" | "bottom"; per: string[] };

/* ------------------------------------------------------------------ coverage ------------------------------------- */

export type CoveragePolicy = {
  /**
   * "all_reporting": every agency-month with data (national answers say "reported NIBRS counts").
   * "same_agencies": only agencies whose months are known in EVERY compared period (participation change removed).
   * "complete_periods": an agency-period enters only if every month in it is known (rates require this).
   */
  cohort: "all_reporting" | "same_agencies" | "complete_periods";
  /** Unknown months are shown as unknown, never as 0 (shared spec D6). Not configurable. */
  unknownMonths: "show_unknown";
  /** A filtered measure is 0 only with submission evidence for the month; otherwise UNKNOWN (D6). Not configurable. */
  filteredZero: "requires_evidence";
};

/* ------------------------------------------------------------------ accounting ----------------------------------- */

/** A part of the question, as the request ledger records it (lib/request-accounting.ts). */
export type PartRef = { concept: string; value: string | null; text: string; span: [number, number] };

/** Where each part landed. Unbound parts make the plan invalid (the request-accounting rule: nothing is dropped). */
export type PartBinding = { part: PartRef; path: string };

export type AppliedDefault = { path: string; value: string; reason: string };
