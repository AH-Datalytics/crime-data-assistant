import type Database from "better-sqlite3";

export const CURRENT_TRENDS_COMPONENTS = [
  "current_trends_monthly",
  "current_trends_population",
  "current_trends_crosswalk",
] as const;

export type CurrentTrendsComponent = typeof CURRENT_TRENDS_COMPONENTS[number];
export type CurrentTrendsReadinessState = "ready" | "local_failure" | "unknown";

export type CurrentTrendsReadiness = {
  state: CurrentTrendsReadinessState;
  reason: string;
  components: CurrentTrendsComponent[];
  dataVersions: Record<string, string>;
};

export type CurrentTrendsAbsence =
  | { state: "present"; reason: string }
  | { state: "not_in_source_snapshot"; reason: string }
  | { state: "local_failure"; reason: string }
  | { state: "unknown"; reason: string };

export const CURRENT_TRENDS_CAPABILITIES = {
  countyDirectory: "crime_data::agencies+agency_county_crosswalk::agencies(agency,national_sample,ori)|agency_county_crosswalk(county_fips,county_key,ori,ori9,state)",
  agencyDirectory: "crime_data::agencies::agencies(agency,national_sample,ori)",
  stateDirectory: "crime_data::agencies::agencies(national_sample,state)",
  stateCountsAndRates: "crime_data::agency_monthly+agency_population+sample_agencies::agency_monthly(count,offense,ori,year)|agency_population(ori,population,year)|sample_agencies(ori,state)",
  agencyCountsAndRates: "crime_data::agency_monthly+agency_population::agency_monthly(agency,count,offense,ori,state,type,year)|agency_population(ori,year)",
  yearCoverage: "crime_data::agency_monthly::agency_monthly(year)",
  nationalSweep: "crime_data::national_monthly::sweep",
} as const;

// Mirrors COMPONENT_TABLES in scripts/current_trends_build_receipt.py. The two are asserted equal
// by scripts/test-current-trends-readiness.ts, which parses the Python rather than restating the
// list a third time -- a third copy would drift exactly the way these two can.
//
// DEPLOYMENT ORDER MATTERS. The loop below fails a component whose receipt records no count for a
// listed table. Shipping state_monthly here ahead of a database whose receipt records it turns
// Current Trends into `local_failure` ("receipt has no valid count for state_monthly"). This line
// must reach production with, or after, the database that carries the new receipt -- never before.
export const COMPONENT_TABLES: Record<CurrentTrendsComponent, readonly string[]> = {
  current_trends_monthly: ["agency_monthly", "agencies", "sample_agencies", "national_monthly", "state_monthly"],
  current_trends_population: ["agency_population"],
  current_trends_crosswalk: ["agency_county_crosswalk"],
};

const REQUIRED_COMPONENTS = new Map<string, CurrentTrendsComponent[]>([
  [CURRENT_TRENDS_CAPABILITIES.countyDirectory, ["current_trends_monthly", "current_trends_crosswalk"]],
  [CURRENT_TRENDS_CAPABILITIES.agencyDirectory, ["current_trends_monthly"]],
  [CURRENT_TRENDS_CAPABILITIES.stateDirectory, ["current_trends_monthly"]],
  [CURRENT_TRENDS_CAPABILITIES.stateCountsAndRates, ["current_trends_monthly", "current_trends_population"]],
  [CURRENT_TRENDS_CAPABILITIES.agencyCountsAndRates, ["current_trends_monthly", "current_trends_population"]],
  [CURRENT_TRENDS_CAPABILITIES.yearCoverage, ["current_trends_monthly"]],
  [CURRENT_TRENDS_CAPABILITIES.nationalSweep, ["current_trends_monthly"]],
]);

export function isCurrentTrendsCapability(capabilityId: string): boolean {
  return REQUIRED_COMPONENTS.has(capabilityId);
}

type ReceiptRow = {
  component: string;
  source_version: string;
  source_sha256: string;
  source_rows: number;
  expected_rows: number;
  actual_rows: number;
  excluded_rows: number;
  table_counts_json: string;
  status: string;
};

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableCount(db: Database.Database, table: string): number {
  // Table names never come from a receipt. They are selected from COMPONENT_TABLES above.
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function receiptFailure(row: ReceiptRow, component: CurrentTrendsComponent): string | null {
  if (row.status !== "complete") return `${component} receipt status is ${JSON.stringify(row.status)}`;
  if (!row.source_version.trim()) return `${component} receipt has no source version`;
  if (!/^[a-f0-9]{64}$/i.test(row.source_sha256)) return `${component} receipt has no valid source digest`;
  for (const field of ["source_rows", "expected_rows", "actual_rows", "excluded_rows"] as const) {
    if (!Number.isSafeInteger(row[field]) || row[field] < 0) return `${component} receipt has an invalid ${field}`;
  }
  if (row.expected_rows !== row.actual_rows) {
    return `${component} expected ${row.expected_rows} imported rows but recorded ${row.actual_rows}`;
  }
  return null;
}

/**
 * Establish whether a Current Trends capability has a loss-detecting build receipt.
 *
 * A missing receipt is unknown, never healthy. A receipt or live table mismatch is our local
 * failure. Only a reconciled receipt makes an observed zero eligible to mean that the imported
 * source snapshot itself contained no matching row.
 */
export function currentTrendsReadiness(
  db: Database.Database,
  capabilityId: string,
): CurrentTrendsReadiness {
  const components = REQUIRED_COMPONENTS.get(capabilityId);
  if (!components) {
    return { state: "unknown", reason: "this is not one of the seven Current Trends capabilities", components: [], dataVersions: {} };
  }
  if (!tableExists(db, "source_build_receipts")) {
    return { state: "unknown", reason: "this database predates loss-detecting build receipts", components, dataVersions: {} };
  }

  const versions: Record<string, string> = {};
  for (const component of components) {
    const row = db.prepare(`
      SELECT component, source_version, source_sha256, source_rows, expected_rows,
             actual_rows, excluded_rows, table_counts_json, status
      FROM source_build_receipts WHERE component = ?
    `).get(component) as ReceiptRow | undefined;
    if (!row) {
      return { state: "unknown", reason: `no build receipt exists for ${component}`, components, dataVersions: versions };
    }
    const failure = receiptFailure(row, component);
    if (failure) return { state: "local_failure", reason: failure, components, dataVersions: versions };

    let recordedCounts: Record<string, unknown>;
    try {
      recordedCounts = JSON.parse(row.table_counts_json) as Record<string, unknown>;
    } catch {
      return { state: "local_failure", reason: `${component} receipt has invalid table counts`, components, dataVersions: versions };
    }
    for (const table of COMPONENT_TABLES[component]) {
      if (!tableExists(db, table)) {
        return { state: "local_failure", reason: `${component} requires missing table ${table}`, components, dataVersions: versions };
      }
      const recorded = recordedCounts[table];
      if (!Number.isSafeInteger(recorded) || Number(recorded) < 0) {
        return { state: "local_failure", reason: `${component} receipt has no valid count for ${table}`, components, dataVersions: versions };
      }
      const live = tableCount(db, table);
      if (live !== recorded) {
        return { state: "local_failure", reason: `${table} now has ${live} rows; its receipt recorded ${recorded}`, components, dataVersions: versions };
      }
    }
    versions[component] = row.source_version;
  }

  return { state: "ready", reason: "all required source build receipts reconcile with the live database", components, dataVersions: versions };
}

export function classifyCurrentTrendsAbsence(
  db: Database.Database,
  capabilityId: string,
  observedRows: number,
): CurrentTrendsAbsence {
  if (!Number.isSafeInteger(observedRows) || observedRows < 0) {
    return { state: "unknown", reason: "the observed row count is invalid" };
  }
  if (observedRows > 0) return { state: "present", reason: `${observedRows} matching row(s) were observed` };

  const readiness = currentTrendsReadiness(db, capabilityId);
  if (readiness.state === "ready") {
    return { state: "not_in_source_snapshot", reason: "the lossless imported source snapshot contains no matching row" };
  }
  return { state: readiness.state, reason: readiness.reason };
}
