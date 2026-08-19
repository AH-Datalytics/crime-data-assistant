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
export type MeasureBinding =
  | { kind: "topic_columns"; columns: Record<string, string[]> }
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

/** Historical agency crime columns. Note `assault`, not `aggravated_assault`. */
const HIST_CRIME_COLUMNS: Record<string, string[]> = {
  murder: ["murder"], rape: ["rape"], robbery: ["robbery"], aggravated_assault: ["assault"],
  burglary: ["burglary"], theft: ["theft"], motor_vehicle_theft: ["motor_vehicle_theft"],
  violent_crime: ["violent", "murder", "rape", "robbery", "assault"],
  property_crime: ["property", "burglary", "theft", "motor_vehicle_theft"],
};

/** Historical state/national columns. Note `aggravated_assault` and `auto_theft`. */
const HIST_STATE_COLUMNS: Record<string, string[]> = {
  murder: ["murder", "murder_rate"], rape: ["rape", "rape_rate"], robbery: ["robbery", "robbery_rate"],
  aggravated_assault: ["aggravated_assault", "aggravated_assault_rate"],
  burglary: ["burglary", "burglary_rate"], theft: ["theft", "theft_rate"],
  motor_vehicle_theft: ["auto_theft", "auto_theft_rate"],
  violent_crime: ["murder", "rape", "robbery", "aggravated_assault", "murder_rate", "rape_rate", "robbery_rate", "aggravated_assault_rate"],
  property_crime: ["burglary", "theft", "auto_theft", "burglary_rate", "theft_rate", "auto_theft_rate"],
  crime: ["total_offenses", "total_offenses_rate"],
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
        murder: ["murder_rate"], rape: ["rape_rate"], robbery: ["robbery_rate"],
        aggravated_assault: ["assault_rate"], burglary: ["burglary_rate"], theft: ["theft_rate"],
        motor_vehicle_theft: ["auto_theft_rate"], violent_crime: ["violent_rate"],
        property_crime: ["property_rate"],
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
        murder: ["murder_clr"], rape: ["rape_clr"], robbery: ["robbery_clr"],
        aggravated_assault: ["assault_clr"], burglary: ["burglary_clr"], theft: ["theft_clr"],
        motor_vehicle_theft: ["motor_vehicle_theft_clr"], violent_crime: ["violent_clr"],
        property_crime: ["property_clr"],
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
export function topicColumns(entry: TableSemantics, topic: string): string[] | null {
  if (entry.measureBinding.kind !== "topic_columns") return null;
  return entry.measureBinding.columns[topic] ?? null;
}

/** Every column this table uses to express ANY offense topic. */
export function allTopicColumns(entry: TableSemantics): Set<string> {
  if (entry.measureBinding.kind !== "topic_columns") return new Set();
  return new Set(Object.values(entry.measureBinding.columns).flat());
}
