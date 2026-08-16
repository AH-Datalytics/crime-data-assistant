import type Database from "better-sqlite3";
import {
  CURRENT_TRENDS_CAPABILITIES,
  currentTrendsReadiness,
  type CurrentTrendsAbsence,
} from "./current-trends-readiness";

/**
 * Classify an empty Current Trends SQL result without treating the local database as the source.
 * Every referenced derived input must have a reconciled receipt before absence can be asserted.
 */
export function classifyCurrentTrendsSqlAbsence(
  db: Database.Database,
  sql: string,
  observedRows: number,
): CurrentTrendsAbsence {
  if (!Number.isSafeInteger(observedRows) || observedRows < 0) {
    return { state: "unknown", reason: "the observed row count is invalid" };
  }
  if (observedRows > 0) return { state: "present", reason: `${observedRows} matching row(s) were observed` };

  const lower = sql.toLowerCase();
  if (!/\b(?:agency_monthly|agencies|sample_agencies|national_monthly|agency_population|agency_county_crosswalk)\b/.test(lower)) {
    return { state: "unknown", reason: "the query does not identify a Current Trends data component" };
  }

  const capabilities: string[] = [CURRENT_TRENDS_CAPABILITIES.yearCoverage];
  if (/\bagency_population\b/.test(lower)) capabilities.push(CURRENT_TRENDS_CAPABILITIES.agencyCountsAndRates);
  if (/\bagency_county_crosswalk\b/.test(lower)) capabilities.push(CURRENT_TRENDS_CAPABILITIES.countyDirectory);

  for (const capability of capabilities) {
    const readiness = currentTrendsReadiness(db, capability);
    if (readiness.state !== "ready") return { state: readiness.state, reason: readiness.reason };
  }
  return {
    state: "not_in_source_snapshot",
    reason: "every Current Trends component used by the query has a reconciled source receipt",
  };
}
