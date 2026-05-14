/**
 * Dynamic facts loaded from the databases at server startup.
 * Replaces hardcoded agency counts, date ranges, row counts, etc. in prompts.
 * All values are cached at module load time (restart server to refresh).
 */

import { getDb } from "./rtci-db";
import { getNibrsDb } from "./nibrs-db";

// ─── RTCI (Current Trends) facts ───

function loadRtciFacts() {
  try {
    const db = getDb();
    const agencyCount = (db.prepare("SELECT COUNT(DISTINCT ori) AS n FROM agencies").get() as { n: number }).n;
    const stateCount = (db.prepare("SELECT COUNT(DISTINCT state) AS n FROM agencies").get() as { n: number }).n;
    const dateRange = db.prepare("SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM agency_monthly").get() as { min_year: number; max_year: number };
    const totalMonths = (db.prepare("SELECT MAX(total_months) AS n FROM agencies").get() as { n: number }).n;
    const popRange = db.prepare("SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM agency_population").get() as { min_year: number; max_year: number };
    const popRows = (db.prepare("SELECT COUNT(*) AS n FROM agency_population").get() as { n: number }).n;
    const popAgencies = (db.prepare("SELECT COUNT(DISTINCT ori) AS n FROM agency_population").get() as { n: number }).n;
    const popYears = popRange.max_year - popRange.min_year + 1;

    return {
      agencyCount,
      stateCount,
      minYear: dateRange.min_year,
      maxYear: dateRange.max_year,
      totalMonths,
      popMinYear: popRange.min_year,
      popMaxYear: popRange.max_year,
      popRows,
      popAgencies,
      popYears,
    };
  } catch (e) {
    console.warn("[dynamic-facts] Failed to load RTCI facts:", e);
    return {
      agencyCount: 669, stateCount: 48, minYear: 2017, maxYear: 2025,
      totalMonths: 108, popMinYear: 1991, popMaxYear: 2026,
      popRows: 7150, popAgencies: 717, popYears: 10,
    };
  }
}

// ─── Historical Library facts ───

function loadHistoricalFacts() {
  try {
    const db = getDb();
    const agencyTotal = (db.prepare("SELECT COUNT(*) AS n FROM historical_agency").get() as { n: number }).n;
    const typeBreakdown = db.prepare(
      "SELECT type, COUNT(*) AS n FROM historical_agency GROUP BY type ORDER BY n DESC"
    ).all() as { type: string; n: number }[];
    const crimeRange = db.prepare("SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM historical_agency_crime").get() as { min_year: number; max_year: number };
    const stateNatRange = db.prepare("SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM historical_state_national").get() as { min_year: number; max_year: number };
    const staffingRange = db.prepare("SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM historical_staffing").get() as { min_year: number; max_year: number };
    const popRows = (db.prepare("SELECT COUNT(*) AS n FROM historical_agency_population").get() as { n: number }).n;
    const popRange = db.prepare("SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM historical_agency_population").get() as { min_year: number; max_year: number };
    const staffingRows = (db.prepare("SELECT COUNT(*) AS n FROM historical_staffing").get() as { n: number }).n;
    const clearanceRows = (db.prepare("SELECT COUNT(*) AS n FROM national_clearance_rate").get() as { n: number }).n;
    const agencyClearanceRows = (db.prepare("SELECT COUNT(*) AS n FROM historical_agency_clearance").get() as { n: number }).n;
    const clearanceRange = db.prepare("SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM national_clearance_rate").get() as { min_year: number; max_year: number };

    return {
      agencyTotal,
      typeBreakdown: typeBreakdown.map(t => `${t.type} (${t.n.toLocaleString()})`).join(", "),
      crimeMinYear: crimeRange.min_year,
      crimeMaxYear: crimeRange.max_year,
      stateNatMinYear: stateNatRange.min_year,
      stateNatMaxYear: stateNatRange.max_year,
      staffingMinYear: staffingRange.min_year,
      staffingMaxYear: staffingRange.max_year,
      popRows,
      popMinYear: popRange.min_year,
      popMaxYear: popRange.max_year,
      staffingRows,
      clearanceRows,
      agencyClearanceRows,
      clearanceMinYear: clearanceRange.min_year,
      clearanceMaxYear: clearanceRange.max_year,
    };
  } catch (e) {
    console.warn("[dynamic-facts] Failed to load Historical facts:", e);
    return {
      agencyTotal: 24571, typeBreakdown: "city (14,080), county (3,134), other (2,675), state_police (1,660), state_agency (1,533), university (1,139), tribal (236), federal (61), state (52), nation (1)",
      crimeMinYear: 1930, crimeMaxYear: 2024, stateNatMinYear: 1958, stateNatMaxYear: 2024,
      staffingMinYear: 1930, staffingMaxYear: 2025, popRows: 927000, popMinYear: 1930, popMaxYear: 2024,
      staffingRows: 836568, clearanceRows: 65, agencyClearanceRows: 1137326,
      clearanceMinYear: 1960, clearanceMaxYear: 2024,
    };
  }
}

// ─── NIBRS facts ───

function loadNibrsFacts() {
  try {
    const db = getNibrsDb();

    // Date range
    const dateRange = db.prepare("SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM incidents").get() as { min_year: number; max_year: number };

    // Incident counts by year
    const incidentCounts = db.prepare(
      "SELECT year, COUNT(*) AS cnt FROM incidents GROUP BY year ORDER BY year"
    ).all() as { year: number; cnt: number }[];
    const incidentCountStr = incidentCounts
      .map(r => {
        const millions = r.cnt / 1_000_000;
        const label = millions >= 1 ? `${millions.toFixed(1)}M` : `${(r.cnt / 1000).toFixed(0)}K`;
        return `${r.year}: ${label}`;
      })
      .join(", ");
    const totalIncidents = incidentCounts.reduce((sum, r) => sum + r.cnt, 0);
    const totalLabel = totalIncidents >= 1_000_000_000 ? `${(totalIncidents / 1_000_000_000).toFixed(1)}B+` : `${(totalIncidents / 1_000_000).toFixed(0)}M+`;

    // Current/partial year detection
    const currentYear = new Date().getFullYear();
    const lastFullYear = incidentCounts.length > 0
      ? incidentCounts.filter(r => r.year < currentYear).pop()?.year || currentYear - 1
      : currentYear - 1;

    // Summary table row counts (for performance guidance)
    const summaryRowCounts: Record<string, number> = {};
    const summaryTables = [
      "summary_offender_demographics", "summary_arrestee_demographics",
      "summary_drug_monthly", "summary_property_offense",
      "nibrs_agency_completeness",
      "summary_carjacking_victim_demographics",
      "summary_carjacking_offender_demographics",
      "summary_carjacking_arrestee_demographics",
    ];
    for (const table of summaryTables) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        summaryRowCounts[table] = row.n;
      } catch { summaryRowCounts[table] = 0; }
    }

    // Raw table row counts (approximate, from sqlite_stat1 if available, else hardcode)
    const rawRowCounts: Record<string, string> = {};
    for (const table of ["victims", "offenders", "arrestees", "offenses", "property"]) {
      try {
        const stat = db.prepare(`SELECT stat FROM sqlite_stat1 WHERE tbl = ? LIMIT 1`).get(table) as { stat: string } | undefined;
        if (stat) {
          const n = parseInt(stat.stat.split(" ")[0]);
          rawRowCounts[table] = n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1000)}K`;
        }
      } catch { /* stat table might not exist */ }
    }

    // Coverage data (already loaded separately, but also grab low-coverage states)
    let lowCoverageStates = "";
    try {
      // Use lastFullYear (not current partial year) for state coverage
      const coverageYear = lastFullYear;
      // Try state-level coverage if table exists
      try {
        const states = db.prepare(
          `SELECT state, coverage_pct FROM nibrs_state_coverage WHERE year = ? AND coverage_pct < 75 AND state NOT IN ('PR','VI','GU','GM','FS') ORDER BY coverage_pct ASC LIMIT 6`
        ).all(coverageYear) as { state: string; coverage_pct: number }[];
        if (states.length > 0) {
          lowCoverageStates = `Key low-coverage states (${coverageYear}): ${states.map(s => `${s.state} (${s.coverage_pct}%)`).join(", ")}.`;
        }
      } catch { /* table might not exist */ }
    } catch { /* coverage table might not exist */ }

    // DB file size
    let dbSizeLabel = "118GB";
    try {
      const pageCount = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
      const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
      const bytes = pageCount * pageSize;
      dbSizeLabel = `${Math.round(bytes / (1024 * 1024 * 1024))}GB`;
    } catch { /* use default */ }

    return {
      minYear: dateRange.min_year,
      maxYear: dateRange.max_year,
      incidentCountStr,
      totalLabel,
      currentYear,
      lastFullYear,
      summaryRowCounts,
      rawRowCounts,
      lowCoverageStates,
      dbSizeLabel,
    };
  } catch (e) {
    console.warn("[dynamic-facts] Failed to load NIBRS facts:", e);
    return {
      minYear: 1991, maxYear: 2026, incidentCountStr: "data unavailable",
      totalLabel: "1B+", currentYear: new Date().getFullYear(),
      lastFullYear: new Date().getFullYear() - 1,
      summaryRowCounts: {} as Record<string, number>,
      rawRowCounts: {} as Record<string, string>,
      lowCoverageStates: "",
      dbSizeLabel: "118GB",
    };
  }
}

// ─── SHR facts ───

function loadShrFacts() {
  try {
    // Lazy import to avoid circular deps
    const { getShrDb } = require("./shr-db");
    const db = getShrDb();
    if (!db) throw new Error("SHR DB not available");
    const dateRange = db.prepare("SELECT MIN(year) AS min_year, MAX(year) AS max_year FROM incidents").get() as { min_year: number; max_year: number };
    const totalRows = (db.prepare("SELECT COUNT(*) AS n FROM incidents").get() as { n: number }).n;
    const recentYears = db.prepare(
      "SELECT year, COUNT(*) AS cnt FROM incidents WHERE year >= ? GROUP BY year ORDER BY year"
    ).all(dateRange.max_year - 3) as { year: number; cnt: number }[];

    return {
      minYear: dateRange.min_year,
      maxYear: dateRange.max_year,
      totalRows,
      recentYears: recentYears.map(r => `${r.year}: ${(r.cnt / 1000).toFixed(1)}K`).join(", "),
    };
  } catch (e) {
    console.warn("[dynamic-facts] Failed to load SHR facts:", e);
    return { minYear: 1976, maxYear: 2025, totalRows: 849000, recentYears: "" };
  }
}

function formatRowCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000).toLocaleString()}K`;
  return n.toLocaleString();
}

// ─── Export cached facts ───

export const RTCI = loadRtciFacts();
export const HISTORICAL = loadHistoricalFacts();
export const NIBRS = loadNibrsFacts();
export const SHR = loadShrFacts();
export { formatRowCount };

// Log loaded facts for debugging
console.log(`[dynamic-facts] RTCI: ${RTCI.agencyCount} agencies, ${RTCI.stateCount} states, ${RTCI.minYear}-${RTCI.maxYear} (${RTCI.totalMonths} months)`);
console.log(`[dynamic-facts] Historical: ${HISTORICAL.agencyTotal} agencies, crime ${HISTORICAL.crimeMinYear}-${HISTORICAL.crimeMaxYear}, state/nat ${HISTORICAL.stateNatMinYear}-${HISTORICAL.stateNatMaxYear}`);
console.log(`[dynamic-facts] NIBRS: ${NIBRS.minYear}-${NIBRS.maxYear}, ${NIBRS.totalLabel} incidents, DB ${NIBRS.dbSizeLabel}${NIBRS.lowCoverageStates ? `, coverage: ${NIBRS.lowCoverageStates}` : ""}`);
console.log(`[dynamic-facts] SHR: ${SHR.minYear}-${SHR.maxYear}, ${Math.round(SHR.totalRows / 1000)}K incidents${SHR.recentYears ? `, recent: ${SHR.recentYears}` : ""}`);
