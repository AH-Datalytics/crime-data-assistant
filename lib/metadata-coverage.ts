import type Database from "better-sqlite3";
import type { ChartMeta } from "./types";

export type MetadataSource = "current" | "historical" | "nibrs" | "shr" | "hate_crime";

export interface MetadataCoverageResult {
  sql: string;
  explanation: string;
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  chartConfig: null;
  chartMeta: ChartMeta;
}

const US_STATES_DC = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DC", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DE",
];

const US_STATE_NAMES_DC = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "District of Columbia", "Florida", "Georgia",
  "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
  "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire",
  "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota",
  "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
  "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
  "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
];

type Intent =
  | "download_help"
  | "available_states"
  | "missing_states"
  | "state_count"
  | "year_range"
  | "agency_count"
  | "available_agencies"
  | "city_count"
  | "available_cities";

function norm(question: string): string {
  return question.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
}

function detectMetadataIntent(question: string): Intent | null {
  const q = norm(question);
  if (/\b(download|export|csv)\b/.test(q) && /\b(this|these|result|results|table|data|chart|it)\b/.test(q)) {
    return "download_help";
  }

  const mentionsAgency = /\bagenc(?:y|ies)\b|\bdepartments?\b|\bpolice departments?\b/.test(q);
  const mentionsCity = /\bcit(?:y|ies)\b/.test(q);
  const asksCount = /\b(how many|number of|count)\b/.test(q);
  const asksAvailable = /\b(which|what|list|available|represented|covered|coverage|have data|data for|reporting|included)\b/.test(q);

  if (mentionsAgency) {
    if (asksCount) return "agency_count";
    if (asksAvailable) return "available_agencies";
  }

  if (mentionsCity) {
    if (asksCount) return "city_count";
    if (asksAvailable) return "available_cities";
  }

  const mentionsState = /\bstates?\b/.test(q);
  if (mentionsState) {
    if (/\b(missing|not represented|not available|not covered|not included|not in|without data|no data|don't have|do not have|cant tell|can't tell)\b/.test(q) ||
        /\b(?:aren't|are not|isn't|is not)\s+(?:represented|available|covered|included|in)\b/.test(q)) {
      return "missing_states";
    }
    if (/\b(how many|number of|count)\b/.test(q)) {
      return "state_count";
    }
    if (/\b(which|what|list|available|represented|covered|coverage|have data|data for|reporting|included)\b/.test(q)) {
      return "available_states";
    }
  }

  const mentionsYear = /\byears?\b|\byear range\b|\bhow far back\b|\bgoing back\b|\bearliest\b|\blatest\b/.test(q);
  if (mentionsYear && /\b(available|cover|coverage|range|start|begin|earliest|latest|through|present|have data|data for|how far back|going back)\b/.test(q)) {
    return "year_range";
  }

  return null;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function valuesCte(values: string[], column = "state"): string {
  return values.map((value) => `SELECT ${quote(value)} AS ${column}`).join(" UNION ALL ");
}

function runRows(db: Database.Database, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
  return Boolean(row);
}

function columnsFor(intent: Intent): string[] {
  if (intent === "download_help") return ["answer"];
  if (intent === "state_count") return ["state_count"];
  if (intent === "year_range") return ["source", "first_year", "latest_year"];
  if (intent === "agency_count") return ["agency_count"];
  if (intent === "city_count") return ["city_count"];
  if (intent === "available_agencies") return ["agency", "state"];
  if (intent === "available_cities") return ["city", "state"];
  return ["state"];
}

function sourceLabel(source: MetadataSource): string {
  switch (source) {
    case "current": return "Current Trends";
    case "historical": return "Historical";
    case "nibrs": return "NIBRS";
    case "shr": return "Supplementary Homicide Reports";
    case "hate_crime": return "Hate Crime";
  }
}

function chartSource(source: MetadataSource): string {
  switch (source) {
    case "current": return "RTCI";
    case "historical": return "FBI SRS";
    case "nibrs": return "FBI NIBRS";
    case "shr": return "FBI SHR";
    case "hate_crime": return "FBI Hate Crime Statistics";
  }
}

function result(
  source: MetadataSource,
  intent: Intent,
  sql: string,
  rows: Record<string, unknown>[],
  explanation: string,
  truncated = false,
): MetadataCoverageResult {
  return {
    sql,
    explanation,
    title: `${sourceLabel(source)} Coverage`,
    columns: columnsFor(intent),
    rows,
    rowCount: rows.length,
    truncated,
    chartConfig: null,
    chartMeta: { source: chartSource(source), agencyCount: 0, population: null },
  };
}

function summarizeStates(rows: Record<string, unknown>[]): string {
  return rows.map((r) => String(r.state)).join(", ");
}

function downloadResult(source: MetadataSource): MetadataCoverageResult {
  const explanation = "Yes. Use the Download CSV button above the result table to export the returned rows. If a chart is shown, use the chart toolbar to download the chart image.";
  return result(
    source,
    "download_help",
    "SELECT 'Download CSV is available from the results toolbar' AS answer",
    [{ answer: explanation }],
    explanation,
  );
}

function stateSql(source: MetadataSource, intent: Intent): string | null {
  const statesCte = valuesCte(US_STATES_DC);
  switch (source) {
    case "current": {
      const available = "SELECT DISTINCT state FROM agencies WHERE national_sample = 1 AND state IS NOT NULL";
      if (intent === "available_states") return `${available} ORDER BY state`;
      if (intent === "state_count") return `SELECT COUNT(DISTINCT state) AS state_count FROM agencies WHERE national_sample = 1 AND state IS NOT NULL`;
      if (intent === "missing_states") return `WITH all_states AS (${statesCte}) SELECT state FROM all_states EXCEPT ${available} ORDER BY state`;
      return null;
    }
    case "historical": {
      const namesCte = valuesCte(US_STATE_NAMES_DC);
      const available = "SELECT DISTINCT state FROM historical_state_national WHERE state IS NOT NULL AND state <> 'United States'";
      if (intent === "available_states") return `${available} ORDER BY state`;
      if (intent === "state_count") return `SELECT COUNT(DISTINCT state) AS state_count FROM historical_state_national WHERE state IS NOT NULL AND state <> 'United States'`;
      if (intent === "missing_states") return `WITH all_states AS (${namesCte}) SELECT state FROM all_states EXCEPT ${available} ORDER BY state`;
      return null;
    }
    case "nibrs": {
      const available = "SELECT DISTINCT CASE WHEN state = 'NB' THEN 'NE' WHEN state = 'GM' THEN 'GU' ELSE state END AS state FROM agencies WHERE state IS NOT NULL AND state NOT IN ('PR', 'VI', 'GU', 'GM', 'AS', 'MP')";
      if (intent === "available_states") return `${available} ORDER BY state`;
      if (intent === "state_count") return `SELECT COUNT(DISTINCT state) AS state_count FROM (${available})`;
      if (intent === "missing_states") return `WITH all_states AS (${statesCte}) SELECT state FROM all_states EXCEPT ${available} ORDER BY state`;
      return null;
    }
    case "shr": {
      const available = "SELECT DISTINCT state FROM incidents WHERE state IS NOT NULL";
      if (intent === "available_states") return `${available} ORDER BY state`;
      if (intent === "state_count") return `SELECT COUNT(DISTINCT state) AS state_count FROM incidents WHERE state IS NOT NULL`;
      if (intent === "missing_states") return `WITH all_states AS (${statesCte}) SELECT state FROM all_states EXCEPT ${available} ORDER BY state`;
      return null;
    }
    case "hate_crime": {
      const available = "SELECT DISTINCT state FROM hate_crime_participation WHERE state IS NOT NULL AND reporting_agencies > 0";
      if (intent === "available_states") return `${available} ORDER BY state`;
      if (intent === "state_count") return `SELECT COUNT(DISTINCT state) AS state_count FROM hate_crime_participation WHERE state IS NOT NULL AND reporting_agencies > 0`;
      if (intent === "missing_states") return `WITH all_states AS (${statesCte}) SELECT state FROM all_states EXCEPT ${available} ORDER BY state`;
      return null;
    }
  }
}

function entitySql(source: MetadataSource, intent: Intent, db: Database.Database): string | null {
  const isCity = intent === "city_count" || intent === "available_cities";
  const isCount = intent === "agency_count" || intent === "city_count";

  switch (source) {
    case "current": {
      if (!tableExists(db, "agencies")) return null;
      if (isCity) {
        return isCount
          ? "SELECT COUNT(DISTINCT agency || '|' || state) AS city_count FROM agencies WHERE national_sample = 1 AND type = 'City' AND agency IS NOT NULL"
          : "SELECT agency AS city, state FROM agencies WHERE national_sample = 1 AND type = 'City' AND agency IS NOT NULL ORDER BY state, agency LIMIT 50";
      }
      return isCount
        ? "SELECT COUNT(DISTINCT ori) AS agency_count FROM agencies WHERE national_sample = 1 AND agency IS NOT NULL"
        : "SELECT agency, state FROM agencies WHERE national_sample = 1 AND agency IS NOT NULL ORDER BY state, agency LIMIT 50";
    }
    case "historical": {
      if (!tableExists(db, "historical_agency")) return null;
      if (isCity) {
        return isCount
          ? "SELECT COUNT(DISTINCT ori) AS city_count FROM historical_agency WHERE type = 'city' AND agency IS NOT NULL"
          : "SELECT agency AS city, UPPER(state) AS state FROM historical_agency WHERE type = 'city' AND agency IS NOT NULL ORDER BY state, agency LIMIT 50";
      }
      return isCount
        ? "SELECT COUNT(DISTINCT ori) AS agency_count FROM historical_agency WHERE agency IS NOT NULL"
        : "SELECT agency, UPPER(state) AS state FROM historical_agency WHERE agency IS NOT NULL ORDER BY state, agency LIMIT 50";
    }
    case "nibrs": {
      if (!tableExists(db, "agencies")) return null;
      if (isCity) {
        return isCount
          ? "SELECT COUNT(DISTINCT city || '|' || state) AS city_count FROM agencies WHERE city IS NOT NULL AND city <> '' AND state IS NOT NULL"
          : "SELECT DISTINCT city, state FROM agencies WHERE city IS NOT NULL AND city <> '' AND state IS NOT NULL ORDER BY state, city LIMIT 50";
      }
      return isCount
        ? "SELECT COUNT(DISTINCT ori) AS agency_count FROM agencies WHERE ori IS NOT NULL"
        : "SELECT DISTINCT ori AS agency, state FROM agencies WHERE ori IS NOT NULL ORDER BY state, ori LIMIT 50";
    }
    case "shr": {
      if (!tableExists(db, "incidents")) return null;
      if (isCity) {
        return isCount
          ? "SELECT COUNT(DISTINCT agency || '|' || state) AS city_count FROM incidents WHERE agency_type = 'City' AND agency IS NOT NULL"
          : "SELECT DISTINCT agency AS city, state FROM incidents WHERE agency_type = 'City' AND agency IS NOT NULL ORDER BY state, agency LIMIT 50";
      }
      return isCount
        ? "SELECT COUNT(DISTINCT ori) AS agency_count FROM incidents WHERE ori IS NOT NULL"
        : "SELECT DISTINCT agency, state FROM incidents WHERE agency IS NOT NULL ORDER BY state, agency LIMIT 50";
    }
    case "hate_crime": {
      if (!tableExists(db, "hate_crime_incidents")) return null;
      if (isCity) return null;
      return isCount
        ? "SELECT COUNT(DISTINCT ori) AS agency_count FROM hate_crime_incidents WHERE ori IS NOT NULL"
        : "SELECT DISTINCT agency_name AS agency, state FROM hate_crime_incidents WHERE agency_name IS NOT NULL ORDER BY state, agency_name LIMIT 50";
    }
  }
}

function yearSql(source: MetadataSource): string {
  switch (source) {
    case "current":
      return "SELECT 'monthly agency trends' AS source, MIN(year) AS first_year, MAX(year) AS latest_year FROM agency_monthly";
    case "historical":
      return [
        "SELECT 'agency crime' AS source, MIN(year) AS first_year, MAX(year) AS latest_year FROM historical_agency_crime",
        "SELECT 'state and national' AS source, MIN(year) AS first_year, MAX(year) AS latest_year FROM historical_state_national",
      ].join(" UNION ALL ");
    case "nibrs":
      return "SELECT 'NIBRS agencies' AS source, MIN(year) AS first_year, MAX(year) AS latest_year FROM agencies";
    case "shr":
      return "SELECT 'SHR incidents' AS source, MIN(year) AS first_year, MAX(year) AS latest_year FROM incidents";
    case "hate_crime":
      return "SELECT 'hate crime participation' AS source, MIN(year) AS first_year, MAX(year) AS latest_year FROM hate_crime_participation";
  }
}

function entityExplanation(source: MetadataSource, intent: Intent, rows: Record<string, unknown>[], truncated: boolean): string {
  const label = sourceLabel(source);
  const noun = intent === "city_count" || intent === "available_cities" ? "cities" : "agencies";
  const countColumn = intent === "city_count" ? "city_count" : "agency_count";
  if (intent === "city_count" || intent === "agency_count") {
    const count = rows[0]?.[countColumn] ?? 0;
    return `${label} has ${count} ${noun} represented in this source.`;
  }

  const listed = rows
    .map((r) => String(r[noun === "cities" ? "city" : "agency"] || "").trim() + (r.state ? `, ${r.state}` : ""))
    .filter(Boolean)
    .join("; ");
  const prefix = truncated ? `Showing the first ${rows.length} ${noun} alphabetically` : `${label} has these ${noun}`;
  return `${prefix}: ${listed}.`;
}

function stateExplanation(source: MetadataSource, intent: Intent, rows: Record<string, unknown>[]): string {
  const label = sourceLabel(source);
  const basis =
    source === "current"
      ? "complete-reporting agencies in the current sample"
      : source === "hate_crime"
      ? "agencies with hate crime participation records"
      : source === "shr"
      ? "states appearing in SHR incident records"
      : source === "nibrs"
      ? "states appearing in NIBRS agency records"
      : "states in the historical state/national table";

  if (intent === "state_count") {
    const count = rows[0]?.state_count ?? 0;
    return `${label} currently has ${count} states/DC represented based on ${basis}.`;
  }

  if (intent === "missing_states") {
    if (rows.length === 0) {
      return `${label} has all 50 states plus DC represented based on ${basis}.`;
    }
    return `${label} is missing ${rows.length} states/DC based on ${basis}: ${summarizeStates(rows)}.`;
  }

  return `${label} has ${rows.length} states/DC represented based on ${basis}: ${summarizeStates(rows)}.`;
}

function yearExplanation(source: MetadataSource, rows: Record<string, unknown>[]): string {
  const label = sourceLabel(source);
  const ranges = rows
    .map((r) => `${r.source}: ${r.first_year}-${r.latest_year}`)
    .join("; ");
  return `${label} year coverage: ${ranges}.`;
}

export function answerMetadataQuestion(
  source: MetadataSource,
  question: string,
  db: Database.Database | null,
): MetadataCoverageResult | null {
  const intent = detectMetadataIntent(question);
  if (!intent) return null;
  if (intent === "download_help") return downloadResult(source);
  if (!db) return null;

  try {
    if (intent === "year_range") {
      const sql = yearSql(source);
      const rows = runRows(db, sql);
      return result(source, intent, sql, rows, yearExplanation(source, rows));
    }

    if (
      intent === "agency_count" ||
      intent === "available_agencies" ||
      intent === "city_count" ||
      intent === "available_cities"
    ) {
      const sql = entitySql(source, intent, db);
      if (!sql) return null;
      const rows = runRows(db, sql);
      const truncated = intent === "available_agencies" || intent === "available_cities";
      return result(source, intent, sql, rows, entityExplanation(source, intent, rows, truncated), truncated);
    }

    const sql = stateSql(source, intent);
    if (!sql) return null;

    const rows = runRows(db, sql);
    return result(source, intent, sql, rows, stateExplanation(source, intent, rows));
  } catch {
    return null;
  }
}
