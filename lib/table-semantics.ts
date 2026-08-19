import type { QueryContractSource } from "./query-contract";

/**
 * What each answerable table actually is, as data.
 *
 * The defect this exists for: a question naming one place was answered from a table whose rows are
 * a different place, and the caption named the place the user asked about. "Denver crime rates over
 * time" ran against `historical_state_national WHERE state = 'Colorado'` and was captioned "rates
 * for Denver". "top 10 us cities by homicide rate in 2021" returned ten *states*. "clearance rate
 * for rape in Florida" ran against `national_clearance_rate`, which has no state column at all.
 *
 * The existing capability rules in `source-capabilities.ts` catch several of these, but each is a
 * hand-written pairing of one question shape with one forbidden table, so a shape nobody wrote a
 * rule for passes. The two cases above pass today. The missing fact is structural and belongs to
 * the table, not the question:
 *
 *     ROW LEVEL -- what entity does one row of this table represent?
 *
 * Declare that once per table and a request for city rows can never be satisfied by a table whose
 * rows are states, whatever the question looked like.
 *
 * This is a catalog, not a rule list. It says what tables are. `structural-semantics.ts` decides
 * what that implies for a given request.
 */

/** The entity one row represents. Ordered coarse to fine by `LEVEL_RANK` below. */
export type EntityLevel = "national" | "state" | "county" | "city" | "agency" | "unknown";

/** Coarser levels sort lower. `unknown` deliberately has no rank and never compares. */
const LEVEL_RANK: Record<Exclude<EntityLevel, "unknown">, number> = {
  national: 0,
  state: 1,
  county: 2,
  city: 3,
  agency: 4,
};

export function levelRank(level: EntityLevel): number | null {
  return level === "unknown" ? null : LEVEL_RANK[level];
}

/**
 * Is `wanted` finer-grained than `have`? A state table cannot produce city rows; the reverse is
 * fine, because agency rows can be summed into a state total.
 */
export function isFinerThan(wanted: EntityLevel, have: EntityLevel): boolean {
  const a = levelRank(wanted);
  const b = levelRank(have);
  if (a === null || b === null) return false;
  return a > b;
}

export type TableRole =
  /** Carries the numbers an answer is made of. */
  | "metric"
  /** Names and describes agencies. Counting rows here answers "how many agencies", never "how many crimes". */
  | "identity"
  /** A denominator. */
  | "population"
  /** Maps one identity to another. */
  | "crosswalk"
  /** Reference codes, coverage flags, build receipts. */
  | "support";

export type MeasureKind =
  | "count"
  | "rate_per_100k"
  | "clearance_rate"
  | "population"
  | "staffing"
  | "none";

export type TimeGrain = "annual" | "monthly" | "incident" | "none";

export type TableSemantics = {
  source: QueryContractSource;
  table: string;
  role: TableRole;
  /** What one row is. The property whose absence allowed every case above. */
  rowLevel: EntityLevel;
  /**
   * Levels this table can be *restricted* to, which is not the same as what its rows are.
   * `historical_state_national` has rows per state and can be filtered to one state or to the
   * 'United States' row, so it serves state and national requests -- and nothing finer.
   */
  filterLevels: EntityLevel[];
  timeGrains: TimeGrain[];
  measures: MeasureKind[];
  /** Can a per-capita rate be computed from this table alone, without joining a population table? */
  carriesRateDenominator: boolean;
  /**
   * Properties deliberately not asserted. A catalog that guesses is worse than one that admits a
   * gap: anything listed here must fail safe rather than authorize an answer.
   */
  unknown?: string[];
  note?: string;
};

const T = (entry: TableSemantics): TableSemantics => entry;

export const TABLE_SEMANTICS: TableSemantics[] = [
  // ---------------------------------------------------------------- Historical (crime_data.db)
  T({
    source: "historical", table: "historical_state_national", role: "metric",
    rowLevel: "state", filterLevels: ["state", "national"], timeGrains: ["annual"],
    measures: ["count", "rate_per_100k"], carriesRateDenominator: true,
    note: "One row per state per year, plus a 'United States' row. It cannot produce a city, county or agency row.",
  }),
  T({
    source: "historical", table: "national_clearance_rate", role: "metric",
    rowLevel: "national", filterLevels: ["national"], timeGrains: ["annual"],
    measures: ["clearance_rate"], carriesRateDenominator: false,
    note: "No state column exists. A clearance question about any named place cannot be served from here.",
  }),
  T({
    source: "historical", table: "historical_agency_crime", role: "metric",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state", "national"],
    timeGrains: ["annual"], measures: ["count"], carriesRateDenominator: false,
    note: "Offense counts per agency-year. A rate needs historical_agency_population.",
  }),
  T({
    source: "historical", table: "historical_agency_clearance", role: "metric",
    // Deliberately NOT "county" or "state": filtering to one city selects that city's department,
    // which is selection. Rolling several agencies into a county or state is averaging percentages,
    // which is the unsound operation.
    rowLevel: "agency", filterLevels: ["agency", "city"],
    timeGrains: ["annual"], measures: ["clearance_rate"], carriesRateDenominator: false,
    unknown: ["cleared counts", "offense denominators"],
    note:
      "Percentages only -- murder_clr, rape_clr and so on. There are no cleared counts and no offense " +
      "denominators anywhere in the database, and observed values run from -125.0 to 12250.0 because " +
      "prior-year clearances and later corrections fall outside 0-100. These CANNOT be averaged into a " +
      "state or national clearance rate. Aggregating above agency level must decline.",
  }),
  T({
    source: "historical", table: "historical_agency_population", role: "population",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state"],
    timeGrains: ["annual"], measures: ["population"], carriesRateDenominator: true,
  }),
  T({
    source: "historical", table: "historical_staffing", role: "metric",
    rowLevel: "agency", filterLevels: ["agency", "city", "county"],
    timeGrains: ["annual"], measures: ["staffing"], carriesRateDenominator: false,
    note: "Officer and civilian counts. Per-capita staffing needs historical_agency_population.",
  }),
  T({
    source: "historical", table: "historical_agency", role: "identity",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state"],
    timeGrains: ["none"], measures: ["none"], carriesRateDenominator: false,
    note: "A directory. Counting rows answers 'how many agencies', never 'how many crimes'.",
  }),
  T({
    source: "historical", table: "agency_county_crosswalk", role: "crosswalk",
    rowLevel: "agency", filterLevels: ["agency", "county", "state"],
    timeGrains: ["none"], measures: ["none"], carriesRateDenominator: false,
  }),

  // ------------------------------------------------------------- Current Trends (crime_data.db)
  T({
    source: "current", table: "agency_monthly", role: "metric",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state", "national"],
    timeGrains: ["monthly", "annual"], measures: ["count"], carriesRateDenominator: false,
    note: "Reported zero and missing row are distinct here; a zero count is a value, not an absence.",
  }),
  T({
    source: "current", table: "agency_population", role: "population",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state"],
    timeGrains: ["annual"], measures: ["population"], carriesRateDenominator: true,
  }),
  T({
    source: "current", table: "state_monthly", role: "metric",
    rowLevel: "state", filterLevels: ["state"], timeGrains: ["monthly", "annual"],
    measures: ["count"], carriesRateDenominator: false,
  }),
  T({
    source: "current", table: "national_monthly", role: "metric",
    rowLevel: "national", filterLevels: ["national"], timeGrains: ["monthly", "annual"],
    measures: ["count"], carriesRateDenominator: false,
    note: "A sample of reporting agencies, not a national total.",
  }),
  T({
    source: "current", table: "agencies", role: "identity",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state"],
    timeGrains: ["none"], measures: ["none"], carriesRateDenominator: false,
  }),
  T({
    source: "current", table: "agency_county_crosswalk", role: "crosswalk",
    rowLevel: "agency", filterLevels: ["agency", "county", "state"],
    timeGrains: ["none"], measures: ["none"], carriesRateDenominator: false,
  }),
  T({
    source: "current", table: "agency_year_reliability", role: "support",
    rowLevel: "agency", filterLevels: ["agency"], timeGrains: ["annual"],
    measures: ["none"], carriesRateDenominator: false,
  }),
  T({
    source: "current", table: "sample_agencies", role: "support",
    rowLevel: "agency", filterLevels: ["agency"], timeGrains: ["none"],
    measures: ["none"], carriesRateDenominator: false,
  }),

  // ------------------------------------------------------------------------- NIBRS (nibrs.db)
  T({
    source: "nibrs", table: "summary_city_monthly", role: "metric",
    rowLevel: "city", filterLevels: ["city", "agency", "county", "state", "national"],
    timeGrains: ["monthly", "annual"], measures: ["count"], carriesRateDenominator: false,
  }),
  T({
    source: "nibrs", table: "summary_victim_city_monthly", role: "metric",
    rowLevel: "city", filterLevels: ["city", "agency", "county", "state", "national"],
    timeGrains: ["monthly", "annual"], measures: ["count"], carriesRateDenominator: false,
    note: "Person crimes are counted per victim; offense tables undercount them.",
  }),
  T({
    source: "nibrs", table: "summary_state_monthly", role: "metric",
    rowLevel: "state", filterLevels: ["state", "national"], timeGrains: ["monthly", "annual"],
    measures: ["count"], carriesRateDenominator: false,
    note: "Rows are states. It cannot produce a city, county or agency row.",
  }),
  T({
    source: "nibrs", table: "summary_victim_state_monthly", role: "metric",
    rowLevel: "state", filterLevels: ["state", "national"], timeGrains: ["monthly", "annual"],
    measures: ["count"], carriesRateDenominator: false,
  }),
  T({
    source: "nibrs", table: "summary_clearance_city_annual", role: "metric",
    rowLevel: "city", filterLevels: ["city", "agency", "state"], timeGrains: ["annual"],
    measures: ["clearance_rate", "count"], carriesRateDenominator: false,
  }),
  T({
    source: "nibrs", table: "state_population", role: "population",
    rowLevel: "state", filterLevels: ["state", "national"], timeGrains: ["annual"],
    measures: ["population"], carriesRateDenominator: true,
    note: "A statewide denominator. It cannot supply a city or agency denominator.",
  }),
  T({
    source: "nibrs", table: "agencies", role: "identity",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state"],
    timeGrains: ["none"], measures: ["none"], carriesRateDenominator: false,
  }),
  T({
    source: "nibrs", table: "agency_county_crosswalk", role: "crosswalk",
    rowLevel: "agency", filterLevels: ["agency", "county", "state"],
    timeGrains: ["none"], measures: ["none"], carriesRateDenominator: false,
  }),

  // ----------------------------------------------------------------------------- SHR (shr.db)
  T({
    source: "shr", table: "incidents", role: "metric",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state", "national"],
    timeGrains: ["incident", "monthly", "annual"], measures: ["count"], carriesRateDenominator: false,
    note:
      "Homicide incidents reported by an agency. Its `population` column is that AGENCY's population, " +
      "not a statewide or national one, so it can never be a statewide denominator; state_population is.",
  }),
  T({
    source: "shr", table: "victims", role: "metric",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state", "national"],
    timeGrains: ["incident", "annual"], measures: ["count"], carriesRateDenominator: false,
  }),
  T({
    source: "shr", table: "state_population", role: "population",
    rowLevel: "state", filterLevels: ["state", "national"], timeGrains: ["annual"],
    measures: ["population"], carriesRateDenominator: true,
  }),
  T({
    source: "shr", table: "shr_agency_alias", role: "identity",
    rowLevel: "agency", filterLevels: ["agency", "city"], timeGrains: ["none"],
    measures: ["none"], carriesRateDenominator: false,
  }),
  T({
    source: "shr", table: "shr_agency_identity", role: "identity",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state"],
    timeGrains: ["none"], measures: ["none"], carriesRateDenominator: false,
  }),

  // ------------------------------------------------------------------ Hate Crime (hate_crime.db)
  T({
    source: "hate_crime", table: "hate_crime_incidents", role: "metric",
    rowLevel: "agency", filterLevels: ["agency", "city", "county", "state", "national"],
    timeGrains: ["incident", "annual"], measures: ["count"], carriesRateDenominator: false,
    note: "Carries ori, agency_name, state and a per-agency population column.",
  }),
  T({
    source: "hate_crime", table: "summary_hate_crime_state", role: "metric",
    rowLevel: "state", filterLevels: ["state", "national"], timeGrains: ["annual"],
    measures: ["count"], carriesRateDenominator: false,
  }),
  T({
    source: "hate_crime", table: "hate_crime_participation", role: "support",
    rowLevel: "state", filterLevels: ["state", "national"], timeGrains: ["annual"],
    measures: ["none"], carriesRateDenominator: false,
    note: "Reporting participation, not offense counts.",
  }),
  T({
    source: "hate_crime", table: "summary_hate_crime_bias_trend", role: "metric",
    rowLevel: "national", filterLevels: ["national"], timeGrains: ["annual"],
    measures: ["count"], carriesRateDenominator: false,
    note: "Columns are year, bias_category, bias_desc, incident_count, victim_count. There is NO geography column.",
  }),
  T({
    source: "hate_crime", table: "summary_hate_crime_offense_trend", role: "metric",
    rowLevel: "national", filterLevels: ["national"], timeGrains: ["annual"],
    measures: ["count"], carriesRateDenominator: false,
    note: "No geography column.",
  }),
  T({
    source: "hate_crime", table: "summary_hate_crime_location", role: "metric",
    rowLevel: "national", filterLevels: ["national"], timeGrains: ["annual"],
    measures: ["count"], carriesRateDenominator: false,
    note: "No geography column.",
  }),
  T({
    source: "hate_crime", table: "hate_crime_caveats", role: "support",
    rowLevel: "unknown", filterLevels: [], timeGrains: ["none"],
    measures: ["none"], carriesRateDenominator: false,
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

/** Tables an answer's numbers can legitimately come from. */
export function metricTables(entries: TableSemantics[]): TableSemantics[] {
  return entries.filter((entry) => entry.role === "metric");
}
