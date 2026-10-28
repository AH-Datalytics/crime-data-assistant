/**
 * NIBRS structured plan language, v1 (spec: docs/superpowers/specs/2026-10-28-nibrs-plan-language.md).
 *
 * The reader fills a plan; it never writes SQL. A plan names semantic-layer objects (measures, dimensions, entities)
 * by id and knows no tables. The zod schemas below are the runtime boundary for reader JSON (parsePlan); the
 * TypeScript types are inferred from them, so the two cannot drift. Validation after parsing is in validate.ts:
 * structural rules (P), semantic-layer rules (S), request accounting (A), and release-resolved rules (R) once the
 * plan's relative periods and agency sets are resolved against a pinned release.
 */
import { z } from "zod";

export const PLAN_VERSION = "nibrs-plan/1" as const;

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "months are YYYY-MM");
const Id = z.string().min(1);
const Name = z.string().regex(/^[a-z][a-z0-9_]*$/, "names are lower_snake_case");

/* ------------------------------------------------------------------ geography ------------------------------------ */

const AgencyPredicate = z.union([
  z.strictObject({ field: z.literal("agency.population"), op: z.enum([">=", ">", "<=", "<"]), value: z.number().int().nonnegative() }),
  z.strictObject({ field: z.literal("agency.population"), op: z.literal("between"), value: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]) }),
  z.strictObject({ field: z.literal("agency.type"), op: z.literal("in"), value: z.array(Id).min(1) }),
  z.strictObject({ field: z.literal("agency.population_group"), op: z.literal("in"), value: z.array(Id).min(1) }),
]);

export const Place = z.discriminatedUnion("kind", [
  /** The nation: a sum of reported counts across agencies, never an agency. Answers say "reported NIBRS counts". */
  z.strictObject({ kind: z.literal("national") }),
  z.strictObject({ kind: z.literal("state"), code: z.string().regex(/^[A-Z]{2}$/) }),
  /** One agency by ORI. "Houston" resolves to TXHPD0000 before the plan is written. */
  z.strictObject({ kind: z.literal("agency"), ori: z.string().regex(/^[A-Z0-9]{9}$/), label: Id }),
  z.strictObject({ kind: z.literal("county"), fips: z.string().regex(/^\d{5}$/), label: Id }),
  /** Agencies chosen by attributes ("cities of 250,000 or more"), resolved per data year against the release. */
  z.strictObject({
    kind: z.literal("agency_set"),
    where: z.array(AgencyPredicate).min(1),
    within: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("national") }), z.strictObject({ kind: z.literal("state"), code: z.string().regex(/^[A-Z]{2}$/) })]),
  }),
]);

export const Geography = z.strictObject({
  places: z.array(Place).min(1),
  /**
   * "separate": one result per place; with two or more places the result has the grouping "geo.place", which the plan
   * must list in `groupings` (P3). "combined": one total over the DEDUPLICATED UNION of the places' resolved agencies,
   * so an agency inside two places counts once (resolved and checked at release resolution, R3).
   */
  combine: z.enum(["separate", "combined"]),
});

/* ------------------------------------------------------------------ time ----------------------------------------- */

export const AbsolutePeriod = z.strictObject({ kind: z.literal("absolute"), from: YearMonth, to: YearMonth });

export const Period = z.discriminatedUnion("kind", [
  /** Months inclusive. A year is "2025-01".."2025-12". */
  AbsolutePeriod,
  /** Whole calendar years that need not be contiguous ("2019 and 2024"). Grouped by time.year unless combined. */
  z.strictObject({ kind: z.literal("years"), years: z.array(z.number().int().min(1991).max(2100)).min(1) }),
  /** From `from` through the release's last month. */
  z.strictObject({ kind: z.literal("since"), from: YearMonth }),
  /** The last `count` whole calendar years, or months, the release holds. */
  z.strictObject({ kind: z.literal("last_n"), unit: z.enum(["years", "months"]), count: z.number().int().positive() }),
  /**
   * Today's reading rule for a monthly or yearly series with no period (H1): the latest calendar year whose December
   * the release holds. It says nothing about any agency's completeness; it is a release-level calendar rule.
   */
  z.strictObject({ kind: z.literal("latest_calendar_year_in_release") }),
  z.strictObject({ kind: z.literal("latest_month_in_release") }),
]);

/** Which date places a unit in a period. Each measure declares the bases it supports (semantic layer). */
export const TimeBasis = z.enum(["incident_date", "arrest_date", "clearance_date"]);

/* ------------------------------------------------------------------ measures and filters ------------------------- */

/**
 * The counting unit is part of the contract. The semantic layer defines each measure with exactly one unit; the plan
 * repeats it so a reader that meant victims cannot silently get offenses (S2). Cleared offenses are unit "offense".
 */
export const CountingUnit = z.enum([
  "victim",           // distinct victim segments
  "victim_offense",   // victim x connected offense pairs
  "victim_offender",  // victim x offender relationship pairs
  "offense",          // offense segments (at most one per code per incident)
  "incident",
  "offender",         // offender segments with information (segment 00 means none is known)
  "arrestee",         // Group A arrestee segments
  "arrest",           // Group A arrestees plus Group B arrests
  "group_b_arrest",
  "property_segment",
  "dollars",          // a sum of property values
  "vehicles",         // stolen or recovered motor vehicle quantities
  "fbi_standard",     // a composite (violent crime): each component in the FBI's standard unit, summed and labelled
]);

/** A condition on one dimension. Which entity it applies to is the dimension's entity (semantic layer). */
export const AttributeFilter = z.strictObject({
  kind: z.literal("attribute"),
  dimension: Id,
  op: z.enum(["in", "not_in", "between", "is_unknown", "is_known"]),
  values: z.array(z.union([z.string(), z.number()])).optional(),
});

/**
 * True when at least one row of `entity`, linked to the counted unit's `scope` row, satisfies every condition in
 * `where` (each condition's dimension must belong to `entity`). The counted unit must have exactly one `scope` row
 * (scope is the unit itself or an ancestor, e.g. the incident of a victim). Required whenever the condition sits on a
 * one-to-many relation of the counted unit: a join there would count the unit once per matching row.
 */
export const ExistsFilter = z.strictObject({
  kind: z.literal("exists"),
  scope: Id,
  entity: Id,
  where: z.array(AttributeFilter).min(1),
  negate: z.boolean().optional(),
  /**
   * Required whenever the path reaches property: NIBRS links property to the incident, not to an offense. The answer
   * then states that the property is not attributed to one offense (case N2).
   */
  attribution: z.literal("incident_level_only").optional(),
});

export const Filter = z.discriminatedUnion("kind", [AttributeFilter, ExistsFilter]);

export const MeasureSpec = z.strictObject({
  /** Semantic-layer measure id, e.g. "victims.murder", "offenses.theft_from_motor_vehicle", "incidents.carjacking". */
  id: Id,
  unit: CountingUnit,
  as: Name,
  /** Filters on this measure only, in addition to the plan's filters (subset numerators, independent denominators). */
  filters: z.array(Filter).optional(),
});

/* ------------------------------------------------------------------ groupings ------------------------------------ */

export const Bin = z.strictObject({ label: Id, from: z.number().int().nonnegative(), to: z.number().int().nonnegative() });

export const Grouping = z.strictObject({
  /** Semantic dimension id, or "geo.place" (the places of a separate geography). */
  dimension: Id,
  /**
   * Inclusive integer bins, for dimensions the semantic layer decodes as numbers (age). Special and unknown codes
   * (age 00, NN, NB, BB, 99+ as coded) are decoded by the semantic layer and never fall in a bin: each is its own
   * visible category. Bins must not overlap (P5).
   */
  bins: z.array(Bin).min(1).optional(),
  /**
   * For a dimension with many values per counted unit (weapons of an offense): the unit is counted once under EACH
   * value it has, so group totals exceed the unit count, and the answer says so. Shares then use a distinct-unit
   * denominator, never the sum of cells (see Statistic share).
   */
  multiValue: z.literal("each_value").optional(),
  unknown: z.literal("visible"),
  /** How a combination with no units is shown where its denominator is known (the cell's status still applies, D6). */
  absent: z.enum(["show", "omit"]),
});

/* ------------------------------------------------------------------ statistics ----------------------------------- */

export const Statistic = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("count"), as: Name, measure: Name }),
  /**
   * The share of `measure` in each cell, over a denominator evaluated INDEPENDENTLY at the grain of `within` (a
   * subset of the groupings; [] is the whole result). The denominator is `denominator` if given, else `measure`,
   * with its own filters, evaluated with that measure's OWN aggregation over deduplicated entity rows at that grain:
   * a count-distinct measure counts each unit once (a victim in two weapon cells counts once in the denominator), a
   * sum measure (dollars, vehicles) sums each row once. Never a sum of displayed cells.
   */
  z.strictObject({ kind: z.literal("share"), as: Name, measure: Name, within: z.array(Id), denominator: Name.optional() }),
  /**
   * Per `per` of covered population (shared spec D8). Eligibility is fixed, not configurable: for each output cell,
   * an agency enters only if every month of that cell's period is evidenced complete (REPORTED_ZERO or a submission
   * evidenced complete), and numerator and population use the same eligible agencies. Periods are never annualized;
   * a partial period is labelled as such. The result cell carries the observed count, the eligible count, the covered
   * population, and a reason whenever the rate is unavailable (no eligible agency; covered population cannot be
   * established, e.g. a secondary agency in the cohort without its primary).
   * A filtered numerator over all residents is labelled "per N residents (all residents)", never as a group rate.
   * The population is the covered population of the cell's data year, so a cell's period must lie within one data
   * year: a rate grouped by time.year or time.month, or over a period inside one year. A rate over a multi-year span
   * without a time grouping is refused (P14); a rate inside a rolling window is refused in v1 (P11).
   */
  z.strictObject({ kind: z.literal("rate"), as: Name, measure: Name, per: z.number().int().positive() }),
  /**
   * numerator / denominator, each evaluated independently at the full grain of the groupings (clearance rate:
   * cleared offenses / offenses; average property value: dollars / property segments). Cells where the denominator
   * is 0 or unknown are null with a reason.
   */
  z.strictObject({ kind: z.literal("ratio"), as: Name, numerator: Name, denominator: Name }),
]);

/* ------------------------------------------------------------------ transforms ----------------------------------- */

/**
 * Applied in this order only: rolling, then period_comparison, then rank (P11); rolling and period_comparison are not
 * combined in v1. Each names the statistics it acts on. Counts are summed; shares and ratios are RECOMPUTED from their
 * transformed numerators and denominators, never summed or averaged. A rate in a comparison is computed for each
 * period on its own (its own eligibility and population), and each comparison period lies within one data year when
 * a rate is compared (P13).
 */
export const Transform = z.discriminatedUnion("kind", [
  /** Trailing window over time.month. A window is reported only when every month in it is known. */
  z.strictObject({ kind: z.literal("rolling"), of: z.array(Name).min(1), months: z.number().int().min(2).max(120) }),
  /** The later period against the earlier, per remaining group; both must lie inside the plan's period (R2). */
  z.strictObject({
    kind: z.literal("period_comparison"), of: z.array(Name).min(1), earlier: AbsolutePeriod, later: AbsolutePeriod,
    outputs: z.array(z.enum(["earlier", "later", "change", "pct_change"])).min(1),
  }),
  /**
   * Order by a statistic within each combination of `per`; keep the first `limit` (ties at the cut kept), or all
   * when `limit` is null (today's ranking with no number). After a period_comparison, `by` names one of its outputs:
   * "<statistic>.earlier", ".later", ".change" or ".pct_change" (P12).
   */
  z.strictObject({ kind: z.literal("rank"), by: z.string().regex(/^[a-z][a-z0-9_]*(?:\.(?:earlier|later|change|pct_change))?$/), direction: z.enum(["top", "bottom"]), per: z.array(Id), limit: z.number().int().positive().nullable() }),
]);

/* ------------------------------------------------------------------ coverage ------------------------------------- */

export const Coverage = z.strictObject({
  /**
   * Which agencies count. "all_reporting": every agency-month with a known value. "same_agencies": only agencies with
   * a known value in every compared period (S3), so participation change is not read as crime change.
   */
  cohort: z.enum(["all_reporting", "same_agencies"]),
  /** Unknown months are never 0, and a filtered zero needs submission evidence (D6). Fixed. */
  unknownMonths: z.literal("show_unknown"),
  filteredZero: z.literal("requires_evidence"),
});

/* ------------------------------------------------------------------ accounting ----------------------------------- */

/** A part of the question as the request ledger records it (lib/request-accounting.ts Part), with its identity. */
export const PartRef = z.strictObject({
  concept: Id,
  value: z.string().nullable(),
  text: z.string(),
  span: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  clause: z.number().int().nonnegative(),
  /** Carried from an earlier turn of the conversation (ledger `inherited`). */
  inherited: z.boolean(),
});

/** Where a part landed: a path into the plan whose value applies it (A1 checks the path and the value). */
export const PartBinding = z.strictObject({ part: PartRef, path: z.string().min(1) });

export const AppliedDefault = z.strictObject({ path: z.string().min(1), value: z.string(), reason: z.string().min(1) });

/* ------------------------------------------------------------------ the plan ------------------------------------- */

export const NibrsPlan = z.strictObject({
  version: z.literal(PLAN_VERSION),
  semanticVersion: Id,
  question: z.string().min(1),
  geography: Geography,
  period: Period,
  timeBasis: TimeBasis,
  measures: z.array(MeasureSpec).min(1),
  filters: z.array(Filter),
  groupings: z.array(Grouping),
  statistics: z.array(Statistic).min(1),
  transforms: z.array(Transform),
  coverage: Coverage,
  defaults: z.array(AppliedDefault),
  bindings: z.array(PartBinding),
});

/* ------------------------------------------------------------------ reader outcome --------------------------------- */

export const LimitationReason = z.enum([
  "not_recorded_in_nibrs",    // immigration status, convictions, officer conduct ...
  "outside_release_coverage", // years or agencies the pinned release does not hold
  "unsupported_capability",   // a plan form not yet switched on for this era (questions switch by capability)
  "unresolved_place",
  "explanation_requested",    // causes, policy: NIBRSAI reports what the data records, nothing more
]);

export const ReaderOutcome = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan"), plan: NibrsPlan }),
  /** Asked only when the readings give different answers. Each option is a complete plan. */
  z.strictObject({ kind: z.literal("clarify"), question: z.string().min(1), options: z.array(z.strictObject({ label: z.string().min(1), plan: NibrsPlan })).min(2), parts: z.array(PartRef).min(1) }),
  /** Every unmet part is named; no number that drops a part is given. */
  z.strictObject({ kind: z.literal("limitation"), parts: z.array(PartRef).min(1), reason: LimitationReason, explanation: z.string().min(1) }),
]);

export type NibrsPlan = z.infer<typeof NibrsPlan>;
export type ReaderOutcome = z.infer<typeof ReaderOutcome>;
export type Place = z.infer<typeof Place>;
export type Period = z.infer<typeof Period>;
export type AbsolutePeriod = z.infer<typeof AbsolutePeriod>;
export type TimeBasis = z.infer<typeof TimeBasis>;
export type CountingUnit = z.infer<typeof CountingUnit>;
export type Filter = z.infer<typeof Filter>;
export type AttributeFilter = z.infer<typeof AttributeFilter>;
export type ExistsFilter = z.infer<typeof ExistsFilter>;
export type MeasureSpec = z.infer<typeof MeasureSpec>;
export type Grouping = z.infer<typeof Grouping>;
export type Statistic = z.infer<typeof Statistic>;
export type Transform = z.infer<typeof Transform>;
export type Coverage = z.infer<typeof Coverage>;
export type PartRef = z.infer<typeof PartRef>;
export type PartBinding = z.infer<typeof PartBinding>;
export type LimitationReason = z.infer<typeof LimitationReason>;

/** The runtime boundary: reader JSON in, a typed plan or the schema problems out. */
export function parsePlan(json: unknown): { plan: NibrsPlan; problems: [] } | { plan: null; problems: { rule: "P0"; path: string; message: string }[] } {
  const r = NibrsPlan.safeParse(json);
  if (r.success) return { plan: r.data, problems: [] };
  return { plan: null, problems: r.error.issues.map((i) => ({ rule: "P0" as const, path: i.path.join("."), message: i.message })) };
}

export function parseReaderOutcome(json: unknown) {
  return ReaderOutcome.safeParse(json);
}
