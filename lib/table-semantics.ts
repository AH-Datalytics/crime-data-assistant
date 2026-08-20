import type { QueryContractSource } from "./query-contract";

/**
 * What each answerable table actually is, as data.
 *
 * The defect this exists for: a question about one place or one offense was answered from a table
 * that could not represent it, and the caption named what the user asked for. Denver ran against
 * `historical_state_national WHERE state = 'Colorado'`. "top 10 us cities" returned ten states.
 * "clearance rate for rape in Florida" ran against `national_clearance_rate`, which has no state
 * column at all.
 *
 * Three fields carry the properties enforcement needs, and each is separated deliberately because
 * conflating them is how the first version of this catalog let real defects through:
 *
 *   rowKey        the PHYSICAL grain of one row. `summary_city_monthly` is keyed by `ori`, so its
 *                 rows are agencies even though its name says city.
 *   outputLevels  the levels this table may legitimately PRODUCE. That is what enforcement
 *                 compares against; `rowKey` only explains why.
 *   measureBinding  how a requested offense maps onto real columns or code predicates, so
 *                 `SELECT hac.robbery AS murders` cannot pass as a murder answer.
 *
 * `components` and `aggregation` are typed rather than inferred from prose. An earlier version ran
 * a regex over a human-readable `unknown` array to decide whether a rollup was sound, which meant
 * enforcement depended on how a comment was worded.
 */

/** The entity one row represents. */
export type EntityLevel = "national" | "state" | "county" | "city" | "agency" | "unknown";

const LEVEL_RANK: Record<Exclude<EntityLevel, "unknown">, number> = {
  national: 0, state: 1, county: 2, city: 3, agency: 4,
};

export function levelRank(level: EntityLevel): number | null {
  return level === "unknown" ? null : LEVEL_RANK[level];
}

export function isFinerThan(wanted: EntityLevel, have: EntityLevel): boolean {
  const a = levelRank(wanted);
  const b = levelRank(have);
  if (a === null || b === null) return false;
  return a > b;
}

export type TableRole = "metric" | "identity" | "population" | "crosswalk" | "support";

export type MeasureKind = "count" | "rate_per_100k" | "clearance_rate" | "population" | "staffing" | "none";

export type TimeGrain = "annual" | "monthly" | "incident" | "none";

/**
 * How a requested offense topic is expressed in this table.
 *
 * `topic_columns` — one column per offense, so the selected column IS the measure claim.
 * `code_column`   — a code predicate selects the offense (NIBRS `ucr_offense_code`).
 * `value_column`  — a text value selects it (Current Trends `offense`).
 * `fixed_topics`  — the table only ever holds these topics (SHR is homicide-only).
 */
/**
 * What a table must actually return to satisfy a requested measure.
 *
 * A flat list of "allowed columns" could only ever answer "is this column permitted", which let two
 * real defects through: a request for murders AND robberies satisfied by murder alone, and a
 * request for violent crime satisfied by one of its four components. Completeness and alternatives
 * are different questions from membership, so they get their own shapes.
 *
 *   all   every column is required -- the components of a composite, or a multi-column measure.
 *   any   one alternative suffices -- a stored `violent` total OR its four components.
 */
export type MeasureRequirement =
  | { kind: "all"; columns: string[] }
  | { kind: "any"; alternatives: MeasureRequirement[] };

export const allOf = (...columns: string[]): MeasureRequirement => ({ kind: "all", columns });
export const anyOf = (...alternatives: MeasureRequirement[]): MeasureRequirement =>
  ({ kind: "any", alternatives });

/** Every column mentioned anywhere in a requirement -- the membership question. */
export function requirementColumns(requirement: MeasureRequirement): string[] {
  return requirement.kind === "all"
    ? [...requirement.columns]
    : requirement.alternatives.flatMap(requirementColumns);
}

/** Does this set of selected columns satisfy the requirement -- the completeness question. */
export function requirementSatisfied(
  requirement: MeasureRequirement, selected: Set<string>
): boolean {
  return requirement.kind === "all"
    ? requirement.columns.every((column) => selected.has(column))
    : requirement.alternatives.some((alternative) => requirementSatisfied(alternative, selected));
}

/**
 * A measure is a topic AND a unit, and conflating them let two substitutions through:
 * `murder_rate AS murders` answering a count, and `murder AS murder_rate` answering a rate. The
 * state/national catalog listed them as interchangeable alternatives of one topic, which they are
 * not -- they are different measures that happen to share a name stem.
 *
 * `direct` columns express the measure themselves. `derivedFrom` columns can produce it only when
 * something else supplies the missing part: a per-capita rate derived from counts is valid exactly
 * when the division binds an approved denominator, which `structural-rate-denominator-unbound`
 * already proves separately.
 */
export type UnitKey = "count" | "rate_per_100k" | "clearance_rate";

export type UnitRequirement = {
  direct?: MeasureRequirement;
  derivedFrom?: MeasureRequirement;
};

export type UnitRequirements = Partial<Record<UnitKey, UnitRequirement>>;

/**
 * The contract's unit vocabulary is wider than the catalog's, and the difference matters.
 *
 * Folding everything unrecognised into `count` meant "What share of Chicago murders occurred in
 * 2020?" -- classified `ratio` -- was satisfied by a raw murder count. A share needs a numerator AND
 * a denominator, neither of which this catalog models, so the honest answer is that the request is
 * not expressible here, not that a count will do.
 *
 *   modeled      the catalog states what this unit requires
 *   unmodeled    a real unit the catalog cannot yet express -- fail closed
 *   unspecified  no measure claim to check
 */
export type UnitResolution =
  | { kind: "modeled"; unit: UnitKey }
  | { kind: "unmodeled"; unit: string }
  | { kind: "unspecified" };

export function resolveUnit(unit: string): UnitResolution {
  if (unit === "count" || unit === "rate_per_100k" || unit === "clearance_rate") {
    return { kind: "modeled", unit };
  }
  if (unit === "unknown" || unit === "") return { kind: "unspecified" };
  return { kind: "unmodeled", unit };
}

export type MeasureBinding =
  | { kind: "topic_columns"; columns: Record<string, UnitRequirements> }
  | { kind: "code_column"; column: string }
  | { kind: "value_column"; column: string; values: Record<string, string> }
  | { kind: "fixed_topics"; topics: string[] }
  | { kind: "none" };

export type TableSemantics = {
  source: QueryContractSource;
  table: string;
  role: TableRole;
  /** The physical grain of one row. Documentary: enforcement uses `outputLevels`. */
  rowKey: EntityLevel;
  /** The levels this table may legitimately produce. */
  outputLevels: EntityLevel[];
  timeGrains: TimeGrain[];
  measures: MeasureKind[];
  measureBinding: MeasureBinding;
  /** Are the components needed to re-derive the measure at another level present? */
  components: "present" | "absent";
  /** How rows combine across the key. */
  aggregation: "additive" | "not-aggregatable";
  /** For anything usable as a rate denominator: the levels its population is valid for. */
  denominatorLevels?: EntityLevel[];
  note?: string;
};

const T = (entry: TableSemantics): TableSemantics => entry;

const ALL_LOCAL: EntityLevel[] = ["agency", "city", "county", "state", "national"];

/** A table holding counts only: a rate must be derived from them, with a bound denominator. */
function countsOnly(requirement: MeasureRequirement): UnitRequirements {
  return { count: { direct: requirement }, rate_per_100k: { derivedFrom: requirement } };
}

/** A table holding both counts and stored rates: each unit has its own direct columns. */
function countsAndRates(counts: MeasureRequirement, rates: MeasureRequirement): UnitRequirements {
  return {
    count: { direct: counts },
    rate_per_100k: { direct: rates, derivedFrom: counts },
  };
}

const clearanceOnly = (requirement: MeasureRequirement): UnitRequirements =>
  ({ clearance_rate: { direct: requirement } });

/** Historical agency crime columns. Note `assault`, not `aggravated_assault`. */
const HIST_CRIME_COLUMNS: Record<string, UnitRequirements> = {
  murder: countsOnly(allOf("murder")),
  rape: countsOnly(allOf("rape")),
  robbery: countsOnly(allOf("robbery")),
  aggravated_assault: countsOnly(allOf("assault")),
  burglary: countsOnly(allOf("burglary")),
  theft: countsOnly(allOf("theft")),
  motor_vehicle_theft: countsOnly(allOf("motor_vehicle_theft")),
  // The stored total, or every component -- never one component standing in for the whole.
  violent_crime: countsOnly(anyOf(allOf("violent"), allOf("murder", "rape", "robbery", "assault"))),
  property_crime: countsOnly(anyOf(allOf("property"), allOf("burglary", "theft", "motor_vehicle_theft"))),
};

/** Historical state/national columns. Note `aggravated_assault` and `auto_theft`. */
const HIST_STATE_COLUMNS: Record<string, UnitRequirements> = {
  murder: countsAndRates(allOf("murder"), allOf("murder_rate")),
  rape: countsAndRates(allOf("rape"), allOf("rape_rate")),
  robbery: countsAndRates(allOf("robbery"), allOf("robbery_rate")),
  aggravated_assault: countsAndRates(allOf("aggravated_assault"), allOf("aggravated_assault_rate")),
  burglary: countsAndRates(allOf("burglary"), allOf("burglary_rate")),
  theft: countsAndRates(allOf("theft"), allOf("theft_rate")),
  motor_vehicle_theft: countsAndRates(allOf("auto_theft"), allOf("auto_theft_rate")),
  violent_crime: countsAndRates(
    allOf("murder", "rape", "robbery", "aggravated_assault"),
    allOf("murder_rate", "rape_rate", "robbery_rate", "aggravated_assault_rate")),
  property_crime: countsAndRates(
    allOf("burglary", "theft", "auto_theft"),
    allOf("burglary_rate", "theft_rate", "auto_theft_rate")),
  crime: countsAndRates(allOf("total_offenses"), allOf("total_offenses_rate")),
};

const CURRENT_OFFENSE_VALUES: Record<string, string> = {
  murder: "Murder", rape: "Rape", robbery: "Robbery", aggravated_assault: "Aggravated Assault",
  burglary: "Burglary", theft: "Theft", motor_vehicle_theft: "Motor Vehicle Theft",
};

export const TABLE_SEMANTICS: TableSemantics[] = [
  // ---------------------------------------------------------------- Historical (crime_data.db)
  T({
    source: "historical", table: "historical_state_national", role: "metric",
    rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["annual"],
    measures: ["count", "rate_per_100k"],
    measureBinding: { kind: "topic_columns", columns: HIST_STATE_COLUMNS },
    components: "present", aggregation: "additive",
    denominatorLevels: ["state", "national"],
    note: "One row per state per year plus a 'United States' row. It cannot produce a city, county or agency row.",
  }),
  T({
    source: "historical", table: "national_clearance_rate", role: "metric",
    rowKey: "national", outputLevels: ["national"], timeGrains: ["annual"],
    measures: ["clearance_rate"],
    measureBinding: {
      kind: "topic_columns",
      columns: {
        murder: clearanceOnly(allOf("murder_rate")), rape: clearanceOnly(allOf("rape_rate")),
        robbery: clearanceOnly(allOf("robbery_rate")),
        aggravated_assault: clearanceOnly(allOf("assault_rate")),
        burglary: clearanceOnly(allOf("burglary_rate")), theft: clearanceOnly(allOf("theft_rate")),
        motor_vehicle_theft: clearanceOnly(allOf("auto_theft_rate")),
        violent_crime: clearanceOnly(allOf("violent_rate")),
        property_crime: clearanceOnly(allOf("property_rate")),
      },
    },
    components: "absent", aggregation: "not-aggregatable",
    note: "No state column exists. A clearance question about any named place cannot be served from here.",
  }),
  T({
    source: "historical", table: "historical_agency_crime", role: "metric",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["annual"], measures: ["count"],
    measureBinding: { kind: "topic_columns", columns: HIST_CRIME_COLUMNS },
    components: "present", aggregation: "additive",
    denominatorLevels: ["agency", "city"],
    note: "Counts per agency-year, with that agency's population column. Rolling population above one agency should use historical_agency_population.",
  }),
  T({
    source: "historical", table: "historical_agency_clearance", role: "metric",
    rowKey: "agency", outputLevels: ["agency", "city"], timeGrains: ["annual"],
    measures: ["clearance_rate"],
    measureBinding: {
      kind: "topic_columns",
      columns: {
        murder: clearanceOnly(allOf("murder_clr")), rape: clearanceOnly(allOf("rape_clr")),
        robbery: clearanceOnly(allOf("robbery_clr")),
        aggravated_assault: clearanceOnly(allOf("assault_clr")),
        burglary: clearanceOnly(allOf("burglary_clr")), theft: clearanceOnly(allOf("theft_clr")),
        motor_vehicle_theft: clearanceOnly(allOf("motor_vehicle_theft_clr")),
        violent_crime: clearanceOnly(allOf("violent_clr")),
        property_crime: clearanceOnly(allOf("property_clr")),
      },
    },
    components: "absent", aggregation: "not-aggregatable",
    note:
      "Percentages only. There are no cleared counts and no offense denominators anywhere in the " +
      "database, and observed values run from -125.0 to 12250.0 because prior-year clearances and " +
      "corrections fall outside 0-100. Filtering to one city selects that department, which is fine; " +
      "combining agencies into a county or state average is not, so those levels are excluded.",
  }),
  T({
    source: "historical", table: "historical_agency_population", role: "population",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["annual"], measures: ["population"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
    denominatorLevels: ALL_LOCAL,
  }),
  T({
    source: "historical", table: "historical_staffing", role: "metric",
    rowKey: "agency", outputLevels: ["agency", "city", "county", "state"], timeGrains: ["annual"],
    measures: ["staffing"], measureBinding: { kind: "fixed_topics", topics: ["staffing", "crime", "unknown"] },
    components: "present", aggregation: "additive",
  }),
  T({
    source: "historical", table: "historical_agency", role: "identity",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["none"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
    note: "A directory. Counting rows answers how many agencies exist, never how many offenses.",
  }),
  T({
    source: "historical", table: "agency_county_crosswalk", role: "crosswalk",
    rowKey: "agency", outputLevels: ["agency", "county", "state"], timeGrains: ["none"],
    measures: ["none"], measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),

  // ------------------------------------------------------------- Current Trends (crime_data.db)
  T({
    source: "current", table: "agency_monthly", role: "metric",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["monthly", "annual"], measures: ["count"],
    measureBinding: { kind: "value_column", column: "offense", values: CURRENT_OFFENSE_VALUES },
    components: "present", aggregation: "additive",
    note: "Reported zero and missing row are distinct; a zero count is a value, not an absence.",
  }),
  T({
    source: "current", table: "agency_population", role: "population",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["annual"], measures: ["population"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
    denominatorLevels: ALL_LOCAL,
  }),
  T({
    source: "current", table: "state_monthly", role: "metric",
    rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["monthly", "annual"],
    measures: ["count"],
    measureBinding: { kind: "value_column", column: "offense", values: CURRENT_OFFENSE_VALUES },
    components: "present", aggregation: "additive",
  }),
  T({
    source: "current", table: "national_monthly", role: "metric",
    rowKey: "national", outputLevels: ["national"], timeGrains: ["monthly", "annual"],
    measures: ["count"],
    measureBinding: { kind: "value_column", column: "offense", values: CURRENT_OFFENSE_VALUES },
    components: "present", aggregation: "additive",
    note: "A sample of reporting agencies, not a national total.",
  }),
  T({
    source: "current", table: "agencies", role: "identity",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["none"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
    denominatorLevels: ["agency", "city"],
  }),
  T({
    source: "current", table: "agency_county_crosswalk", role: "crosswalk",
    rowKey: "agency", outputLevels: ["agency", "county", "state"], timeGrains: ["none"],
    measures: ["none"], measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),
  T({
    source: "current", table: "agency_year_reliability", role: "support",
    rowKey: "agency", outputLevels: ["agency"], timeGrains: ["annual"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),
  T({
    source: "current", table: "sample_agencies", role: "support",
    rowKey: "agency", outputLevels: ["agency"], timeGrains: ["none"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),
  T({
    source: "current", table: "source_build_receipts", role: "support",
    rowKey: "unknown", outputLevels: [], timeGrains: ["none"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
    note: "Build provenance. It holds no offense counts and can never be a factual source.",
  }),

  // ------------------------------------------------------------------------- NIBRS (nibrs.db)
  // Every summary keyed by `ori` has rowKey "agency" even where its name says city.
  ...([
    ["summary_city_monthly", ["monthly", "annual"], "agency", ALL_LOCAL],
    ["summary_victim_city_monthly", ["monthly", "annual"], "agency", ALL_LOCAL],
    ["summary_carjacking_monthly", ["monthly", "annual"], "agency", ALL_LOCAL],
    ["summary_offender_demographics", ["annual"], "agency", ALL_LOCAL],
    ["summary_arrestee_demographics", ["annual"], "agency", ALL_LOCAL],
    ["summary_victim_demographics", ["annual"], "agency", ALL_LOCAL],
    ["summary_victim_weapon", ["annual"], "agency", ALL_LOCAL],
    ["summary_offense_weapon", ["annual"], "agency", ALL_LOCAL],
    ["summary_victim_circumstance", ["annual"], "agency", ALL_LOCAL],
    ["summary_victim_weapon_circumstance", ["annual"], "agency", ALL_LOCAL],
    ["summary_victim_weapon_circumstance_demo", ["annual"], "agency", ALL_LOCAL],
    ["summary_offense_location", ["annual"], "agency", ALL_LOCAL],
    ["summary_hate_crime", ["annual"], "agency", ALL_LOCAL],
    ["summary_drug_monthly", ["monthly", "annual"], "agency", ALL_LOCAL],
    ["summary_drug_arrests", ["annual"], "agency", ALL_LOCAL],
    ["summary_property_offense", ["annual"], "agency", ALL_LOCAL],
    ["summary_carjacking_offender_demographics", ["annual"], "agency", ALL_LOCAL],
    ["summary_carjacking_victim_demographics", ["annual"], "agency", ALL_LOCAL],
    ["summary_carjacking_arrestee_demographics", ["annual"], "agency", ALL_LOCAL],
    ["summary_homicide_victim", ["annual"], "agency", ALL_LOCAL],
    ["summary_homicide_offender", ["annual"], "agency", ALL_LOCAL],
    ["summary_homicide_victim_offender", ["annual"], "agency", ALL_LOCAL],
    ["summary_juvenile_offender_incidents", ["annual"], "agency", ALL_LOCAL],
    ["summary_victims_per_incident", ["annual"], "agency", ALL_LOCAL],
  ] as const).map(([table, grains, key, out]) =>
    T({
      source: "nibrs", table, role: "metric",
      rowKey: key as EntityLevel, outputLevels: out as EntityLevel[],
      timeGrains: [...grains] as TimeGrain[], measures: ["count"],
      measureBinding: { kind: "code_column", column: "ucr_offense_code" },
      components: "present", aggregation: "additive",
    })
  ),
  T({
    source: "nibrs", table: "summary_state_monthly", role: "metric",
    rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["monthly", "annual"],
    measures: ["count"], measureBinding: { kind: "code_column", column: "ucr_offense_code" },
    components: "present", aggregation: "additive",
    note: "No ori column. Rows are states.",
  }),
  T({
    source: "nibrs", table: "summary_victim_state_monthly", role: "metric",
    rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["monthly", "annual"],
    measures: ["count"], measureBinding: { kind: "code_column", column: "ucr_offense_code" },
    components: "present", aggregation: "additive",
  }),
  T({
    source: "nibrs", table: "summary_offense_hour", role: "metric",
    rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["annual"],
    measures: ["count"], measureBinding: { kind: "code_column", column: "ucr_offense_code" },
    components: "present", aggregation: "additive",
  }),
  T({
    source: "nibrs", table: "summary_property_value_state", role: "metric",
    rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["annual"],
    measures: ["count"], measureBinding: { kind: "code_column", column: "ucr_offense_code" },
    components: "present", aggregation: "additive",
  }),
  T({
    source: "nibrs", table: "summary_clearance_city_annual", role: "metric",
    rowKey: "agency", outputLevels: ["agency", "city", "county", "state"], timeGrains: ["annual"],
    measures: ["clearance_rate", "count"],
    measureBinding: { kind: "code_column", column: "ucr_offense_code" },
    components: "present", aggregation: "additive",
    denominatorLevels: ["agency", "city"],
    note: "Carries total_offenses and total_cleared, so a clearance rate can be recomputed at any level it supports.",
  }),
  T({
    source: "nibrs", table: "summary_clearance_type", role: "metric",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["monthly", "annual"],
    measures: ["clearance_rate", "count"],
    measureBinding: { kind: "code_column", column: "ucr_offense_code" },
    components: "present", aggregation: "additive",
    note: "total_offenses, cleared_by_arrest and cleared_exceptional are counts, so rollups are sound.",
  }),
  T({
    source: "nibrs", table: "summary_clearance_detail", role: "metric",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["annual"],
    measures: ["clearance_rate", "count"],
    measureBinding: { kind: "code_column", column: "ucr_offense_code" },
    components: "present", aggregation: "additive",
  }),
  T({
    source: "nibrs", table: "summary_carjacking_clearance", role: "metric",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["monthly", "annual"],
    measures: ["clearance_rate", "count"], measureBinding: { kind: "fixed_topics", topics: ["carjacking"] },
    components: "present", aggregation: "additive", denominatorLevels: ["agency", "city"],
  }),
  T({
    source: "nibrs", table: "summary_domestic_violence", role: "metric",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["incident", "annual"],
    measures: ["count"], measureBinding: { kind: "fixed_topics", topics: ["domestic_violence"] },
    components: "present", aggregation: "additive",
  }),
  // The ATTACHed rollup database (`NIBRS_ROLLUP_DB_PATH`), referenced in SQL as `rollup.<table>`.
  // Columns confirmed against the live schema: national tables carry `state` but are pre-aggregated
  // nationally, so they produce national rows only.
  ...([
    "national_summary_arrestee_demographics", "national_summary_clearance_detail",
    "national_summary_clearance_type", "national_summary_offender_demographics",
    "national_summary_victim_circumstance", "national_summary_victim_demographics",
    "national_summary_victim_relationship", "national_summary_victim_weapon",
    "national_summary_victim_weapon_circumstance_demo",
  ] as const).map((table) =>
    T({
      source: "nibrs", table, role: "metric",
      rowKey: "national", outputLevels: ["national"], timeGrains: ["annual"], measures: ["count"],
      measureBinding: { kind: "code_column", column: "ucr_offense_code" },
      components: "present", aggregation: "additive",
    })
  ),
  ...([
    "state_summary_arrestee_demographics", "state_summary_clearance_detail",
    "state_summary_clearance_type", "state_summary_offender_demographics",
    "state_summary_victim_circumstance", "state_summary_victim_demographics",
    "state_summary_victim_relationship", "state_summary_victim_weapon",
    "state_summary_victim_weapon_circumstance_demo",
  ] as const).map((table) =>
    T({
      source: "nibrs", table, role: "metric",
      rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["annual"], measures: ["count"],
      measureBinding: { kind: "code_column", column: "ucr_offense_code" },
      components: "present", aggregation: "additive",
    })
  ),
  T({
    source: "nibrs", table: "rollup_metadata", role: "support",
    rowKey: "unknown", outputLevels: [], timeGrains: ["none"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),
  T({
    source: "nibrs", table: "state_population", role: "population",
    rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["annual"],
    measures: ["population"], measureBinding: { kind: "none" },
    components: "present", aggregation: "additive",
    denominatorLevels: ["state", "national"],
  }),
  T({
    source: "nibrs", table: "agencies", role: "identity",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["annual", "none"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
    // It carries a per-agency population column, and real city-rate queries divide by it.
    denominatorLevels: ["agency", "city"],
  }),
  T({
    source: "nibrs", table: "agency_county_crosswalk", role: "crosswalk",
    rowKey: "agency", outputLevels: ["agency", "county", "state"], timeGrains: ["none"],
    measures: ["none"], measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),
  T({
    source: "nibrs", table: "county_lookup", role: "crosswalk",
    rowKey: "county", outputLevels: ["county", "state"], timeGrains: ["none"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),
  ...([
    "nibrs_agency_completeness", "nibrs_consistent_reporters", "nibrs_offense_codes",
    "nibrs_national_coverage", "nibrs_state_coverage", "nibrs_summary_freshness",
    "nibrs_clearance_codes", "nibrs_ethnicity_codes", "nibrs_race_codes", "nibrs_weapon_codes",
    "nibrs_location_types", "nibrs_property_descriptions", "nibrs_pop_groups",
  ] as const).map((table) =>
    T({
      source: "nibrs", table, role: "support",
      rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["annual", "none"], measures: ["none"],
      measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
      note: "Coverage, reference codes or participation. Not a source of offense counts.",
    })
  ),

  // ----------------------------------------------------------------------------- SHR (shr.db)
  T({
    source: "shr", table: "incidents", role: "metric",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["incident", "monthly", "annual"],
    measures: ["count"], measureBinding: { kind: "fixed_topics", topics: ["murder", "crime", "unknown"] },
    components: "present", aggregation: "additive",
    denominatorLevels: ["agency", "city"],
    note:
      "Homicide incidents. Its `population` column is the reporting AGENCY's population, repeated " +
      "per row, so it is never a statewide or national denominator -- state_population is.",
  }),
  T({
    source: "shr", table: "victims", role: "metric",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["incident", "annual"],
    measures: ["count"], measureBinding: { kind: "fixed_topics", topics: ["murder", "crime", "unknown"] },
    components: "present", aggregation: "additive",
  }),
  T({
    source: "shr", table: "state_population", role: "population",
    rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["annual"],
    measures: ["population"], measureBinding: { kind: "none" },
    components: "present", aggregation: "additive", denominatorLevels: ["state", "national"],
  }),
  T({
    source: "shr", table: "shr_agency_alias", role: "identity",
    rowKey: "agency", outputLevels: ["agency", "city"], timeGrains: ["none"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),
  T({
    source: "shr", table: "shr_agency_identity", role: "identity",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["none"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),
  T({
    source: "shr", table: "agency_county_crosswalk", role: "crosswalk",
    rowKey: "agency", outputLevels: ["agency", "county", "state"], timeGrains: ["none"],
    measures: ["none"], measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),
  T({
    source: "shr", table: "shr_return_a_comparison", role: "support",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["annual"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),

  // ------------------------------------------------------------------ Hate Crime (hate_crime.db)
  T({
    source: "hate_crime", table: "hate_crime_incidents", role: "metric",
    rowKey: "agency", outputLevels: ALL_LOCAL, timeGrains: ["incident", "annual"], measures: ["count"],
    measureBinding: { kind: "fixed_topics", topics: ["hate_crime", "crime", "unknown"] },
    components: "present", aggregation: "additive", denominatorLevels: ["agency", "city"],
  }),
  T({
    source: "hate_crime", table: "summary_hate_crime_state", role: "metric",
    rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["annual"], measures: ["count"],
    measureBinding: { kind: "fixed_topics", topics: ["hate_crime", "crime", "unknown"] },
    components: "present", aggregation: "additive",
  }),
  T({
    source: "hate_crime", table: "hate_crime_participation", role: "support",
    rowKey: "state", outputLevels: ["state", "national"], timeGrains: ["annual"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
    note: "Reporting participation, not offense counts.",
  }),
  ...([
    "summary_hate_crime_bias_trend", "summary_hate_crime_offense_trend", "summary_hate_crime_location",
  ] as const).map((table) =>
    T({
      source: "hate_crime", table, role: "metric",
      rowKey: "national", outputLevels: ["national"], timeGrains: ["annual"], measures: ["count"],
      measureBinding: { kind: "fixed_topics", topics: ["hate_crime", "crime", "unknown"] },
      components: "present", aggregation: "additive",
      note: "No geography column exists in this table.",
    })
  ),
  T({
    source: "hate_crime", table: "hate_crime_caveats", role: "support",
    rowKey: "unknown", outputLevels: [], timeGrains: ["none"], measures: ["none"],
    measureBinding: { kind: "none" }, components: "present", aggregation: "additive",
  }),
];

const BY_SOURCE_TABLE = new Map<string, TableSemantics>();
for (const entry of TABLE_SEMANTICS) {
  BY_SOURCE_TABLE.set(`${entry.source}:${entry.table.toLowerCase()}`, entry);
}

export function tableSemantics(source: QueryContractSource, table: string): TableSemantics | null {
  return BY_SOURCE_TABLE.get(`${source}:${table.toLowerCase()}`) ?? null;
}

export function catalogedTables(source: QueryContractSource): TableSemantics[] {
  return TABLE_SEMANTICS.filter((entry) => entry.source === source);
}

export function metricTables(entries: TableSemantics[]): TableSemantics[] {
  return entries.filter((entry) => entry.role === "metric");
}

/** Can this table legitimately produce rows at `level`? */
export function producesLevel(entry: TableSemantics, level: EntityLevel): boolean {
  if (level === "unknown") return true;
  return entry.outputLevels.includes(level);
}

/**
 * Columns in this table that legitimately express `topic`, or null when the binding does not work
 * by column name (a code or value predicate, or a table that only ever holds one topic).
 */
/** What this table needs returned for `topic` measured in `unit`. */
export function topicUnitRequirement(
  entry: TableSemantics, topic: string, unit: string
): UnitRequirement | null {
  if (entry.measureBinding.kind !== "topic_columns") return null;
  const resolved = resolveUnit(unit);
  // An unmodeled unit has no requirement to satisfy -- and must never fall back to another unit's.
  if (resolved.kind !== "modeled") return null;
  const forTopic = entry.measureBinding.columns[topic];
  if (!forTopic) return null;
  return forTopic[resolved.unit] ?? null;
}

/** Is this topic expressible at all here, in any unit? */
export function topicIsKnown(entry: TableSemantics, topic: string): boolean {
  return entry.measureBinding.kind === "topic_columns" &&
    entry.measureBinding.columns[topic] !== undefined;
}

/** Columns acceptable for `topic` in `unit` -- the membership question, unit included. */
export function topicColumns(entry: TableSemantics, topic: string, unit: string): string[] | null {
  const requirement = topicUnitRequirement(entry, topic, unit);
  if (!requirement) return null;
  return [
    ...(requirement.direct ? requirementColumns(requirement.direct) : []),
    ...(requirement.derivedFrom ? requirementColumns(requirement.derivedFrom) : []),
  ];
}

/** Every column this table uses to express ANY offense topic. */
/** Every column this table uses to express ANY topic in ANY unit. */
export function allTopicColumns(entry: TableSemantics): Set<string> {
  if (entry.measureBinding.kind !== "topic_columns") return new Set();
  const columns = new Set<string>();
  for (const units of Object.values(entry.measureBinding.columns)) {
    for (const requirement of Object.values(units)) {
      if (requirement.direct) requirementColumns(requirement.direct).forEach((c) => columns.add(c));
      if (requirement.derivedFrom) requirementColumns(requirement.derivedFrom).forEach((c) => columns.add(c));
    }
  }
  return columns;
}
