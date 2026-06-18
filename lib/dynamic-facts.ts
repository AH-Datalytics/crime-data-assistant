/**
 * Dynamic facts loaded from the databases at server startup.
 * Replaces hardcoded agency counts, date ranges, row counts, etc. in prompts.
 * All values are cached at module load time (restart server to refresh).
 */

import { getDb } from "./rtci-db";
import { getNibrsDb } from "./nibrs-db";

export type DataCutoff = { year: number; month: number; label: string };

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(year: number, month: number): DataCutoff {
  const safeMonth = Math.min(12, Math.max(1, month || 1));
  return { year, month: safeMonth, label: `${MONTH_NAMES[safeMonth - 1]} ${year}` };
}

/** Fallback data cutoff: 2 months before current date. Used only if DB probing fails. */
function heuristicDataCutoff(): DataCutoff {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1 - 2;
  if (m <= 0) { m += 12; y -= 1; }
  return monthLabel(y, m);
}

function queryLatestMonth(
  db: { prepare: (sql: string) => { get: () => unknown } },
  table: string,
  yearCol = "year",
  monthCol = "month"
): DataCutoff {
  const ident = /^[A-Za-z_][\w]*$/;
  if (!ident.test(table) || !ident.test(yearCol) || !ident.test(monthCol)) {
    throw new Error("Invalid identifier for cutoff query");
  }
  const row = db.prepare(`
    SELECT ${yearCol} AS year, MAX(${monthCol}) AS month
    FROM ${table}
    WHERE ${yearCol} = (SELECT MAX(${yearCol}) FROM ${table})
    GROUP BY ${yearCol}
  `).get() as { year?: number | null; month?: number | null } | undefined;
  if (!row?.year || !row?.month) throw new Error(`No monthly cutoff rows in ${table}`);
  return monthLabel(Number(row.year), Number(row.month));
}

function validYearExpr(yearCol: string) {
  return `CAST(${yearCol} AS INTEGER) BETWEEN 1900 AND 2100`;
}

function validMonthExpr(monthCol: string) {
  return `CAST(${monthCol} AS INTEGER) BETWEEN 1 AND 12`;
}

function queryYearRangeFromTables(
  db: { prepare: (sql: string) => { get: () => unknown } },
  tables: { table: string; yearCol?: string; monthCol?: string }[]
): { min_year: number; max_year: number } {
  const ident = /^[A-Za-z_][\w]*$/;
  const selects = tables.map(({ table, yearCol = "year", monthCol }) => {
    if (!ident.test(table) || !ident.test(yearCol) || (monthCol && !ident.test(monthCol))) {
      throw new Error("Invalid identifier for year range query");
    }
    const predicates = [validYearExpr(yearCol)];
    if (monthCol) predicates.push(validMonthExpr(monthCol));
    return `SELECT CAST(${yearCol} AS INTEGER) AS year FROM ${table} WHERE ${predicates.join(" AND ")}`;
  });

  const row = db.prepare(`
    SELECT MIN(year) AS min_year, MAX(year) AS max_year
    FROM (
      ${selects.join("\nUNION ALL\n")}
    )
  `).get() as { min_year?: number | null; max_year?: number | null } | undefined;
  if (!row?.min_year || !row?.max_year) throw new Error("No valid numeric year rows");
  return { min_year: Number(row.min_year), max_year: Number(row.max_year) };
}

function queryLatestNumericMonth(
  db: { prepare: (sql: string) => { get: () => unknown } },
  table: string,
  yearCol = "year",
  monthCol = "month"
): DataCutoff {
  const ident = /^[A-Za-z_][\w]*$/;
  if (!ident.test(table) || !ident.test(yearCol) || !ident.test(monthCol)) {
    throw new Error("Invalid identifier for cutoff query");
  }
  const valid = `${validYearExpr(yearCol)} AND ${validMonthExpr(monthCol)}`;
  const row = db.prepare(`
    WITH valid_months AS (
      SELECT CAST(${yearCol} AS INTEGER) AS year, CAST(${monthCol} AS INTEGER) AS month
      FROM ${table}
      WHERE ${valid}
    )
    SELECT year, MAX(month) AS month
    FROM valid_months
    WHERE year = (SELECT MAX(year) FROM valid_months)
    GROUP BY year
  `).get() as { year?: number | null; month?: number | null } | undefined;
  if (!row?.year || !row?.month) throw new Error(`No numeric monthly cutoff rows in ${table}`);
  return monthLabel(Number(row.year), Number(row.month));
}

function tableCountEstimate(
  db: { prepare: (sql: string) => unknown },
  table: string
): number | null {
  try {
    const stmt = db.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = ? LIMIT 1") as { get: (param: string) => unknown };
    const stat = stmt.get(table) as { stat?: string } | undefined;
    const n = stat?.stat ? Number.parseInt(stat.stat.split(" ")[0], 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

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
      crimeMinYear: 1930, crimeMaxYear: 2025, stateNatMinYear: 1958, stateNatMaxYear: 2024,
      staffingMinYear: 1930, staffingMaxYear: 2025, popRows: 940000, popMinYear: 1930, popMaxYear: 2025,
      staffingRows: 851000, clearanceRows: 65, agencyClearanceRows: 1151000,
      clearanceMinYear: 1960, clearanceMaxYear: 2025,
    };
  }
}

// ─── NIBRS facts ───

function loadNibrsFacts() {
  try {
    const db = getNibrsDb();

    // Use summary/coverage tables for startup facts. Scanning raw incidents
    // here can read the full 100GB+ NIBRS DB during the first request.
    const dateRange = queryYearRangeFromTables(db, [
      { table: "nibrs_state_coverage" },
      { table: "summary_state_monthly", monthCol: "month" },
      { table: "summary_victim_state_monthly", monthCol: "month" },
      { table: "nibrs_agency_completeness" },
    ]);
    const totalIncidents = tableCountEstimate(db, "incidents") || 0;
    const totalLabel = totalIncidents
      ? totalIncidents >= 1_000_000_000
        ? `${(totalIncidents / 1_000_000_000).toFixed(1)}B+`
        : `${Math.max(1, Math.round(totalIncidents / 1_000_000))}M+`
      : "count unavailable";

    // Current/partial year detection
    const currentYear = new Date().getFullYear();
    const lastFullYear = Math.min(dateRange.max_year, currentYear - 1);

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
      incidentCountStr: "see NIBRS summary tables",
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

function loadRtciCutoff(): DataCutoff {
  try {
    return queryLatestMonth(getDb(), "agency_monthly");
  } catch (e) {
    console.warn("[dynamic-facts] Failed to load RTCI cutoff:", e);
    return heuristicDataCutoff();
  }
}

function loadNibrsCutoff(): DataCutoff {
  try {
    const db = getNibrsDb();
    for (const table of ["summary_state_monthly", "summary_victim_state_monthly"]) {
      try {
        return queryLatestNumericMonth(db, table);
      } catch { /* try next table */ }
    }
    throw new Error("No NIBRS monthly tables available for cutoff");
  } catch (e) {
    console.warn("[dynamic-facts] Failed to load NIBRS cutoff:", e);
    return heuristicDataCutoff();
  }
}

function loadShrCutoff(): DataCutoff {
  try {
    // Lazy import to avoid circular deps
    const { getShrDb } = require("./shr-db");
    const db = getShrDb();
    if (!db) throw new Error("SHR DB not available");
    return queryLatestMonth(db, "incidents");
  } catch (e) {
    console.warn("[dynamic-facts] Failed to load SHR cutoff:", e);
    return heuristicDataCutoff();
  }
}

export const RTCI_DATA_CUTOFF = loadRtciCutoff();
export const NIBRS_DATA_CUTOFF = loadNibrsCutoff();
export const SHR_DATA_CUTOFF = loadShrCutoff();
export const DATA_CUTOFF = RTCI_DATA_CUTOFF;

// Log loaded facts for debugging
console.log(`[dynamic-facts] RTCI: ${RTCI.agencyCount} agencies, ${RTCI.stateCount} states, ${RTCI.minYear}-${RTCI.maxYear} (${RTCI.totalMonths} months)`);
console.log(`[dynamic-facts] Historical: ${HISTORICAL.agencyTotal} agencies, crime ${HISTORICAL.crimeMinYear}-${HISTORICAL.crimeMaxYear}, state/nat ${HISTORICAL.stateNatMinYear}-${HISTORICAL.stateNatMaxYear}`);
console.log(`[dynamic-facts] NIBRS: ${NIBRS.minYear}-${NIBRS.maxYear}, ${NIBRS.totalLabel} incidents, DB ${NIBRS.dbSizeLabel}${NIBRS.lowCoverageStates ? `, coverage: ${NIBRS.lowCoverageStates}` : ""}`);
console.log(`[dynamic-facts] SHR: ${SHR.minYear}-${SHR.maxYear}, ${Math.round(SHR.totalRows / 1000)}K incidents${SHR.recentYears ? `, recent: ${SHR.recentYears}` : ""}`);
console.log(`[dynamic-facts] Cutoffs: RTCI ${RTCI_DATA_CUTOFF.label}, NIBRS ${NIBRS_DATA_CUTOFF.label}, SHR ${SHR_DATA_CUTOFF.label}`);
