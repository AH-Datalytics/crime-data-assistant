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
  truncated: false;
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

type Intent = "available_states" | "missing_states" | "state_count" | "year_range";

function norm(question: string): string {
  return question.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
}

function detectMetadataIntent(question: string): Intent | null {
  const q = norm(question);
  const mentionsState = /\bstates?\b/.test(q);
  if (mentionsState) {
    if (/\b(missing|not represented|not available|not covered|without data|no data|don't have|do not have|cant tell|can't tell)\b/.test(q)) {
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

function columnsFor(intent: Intent): string[] {
  if (intent === "state_count") return ["state_count"];
  if (intent === "year_range") return ["source", "first_year", "latest_year"];
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
): MetadataCoverageResult {
  return {
    sql,
    explanation,
    title: `${sourceLabel(source)} Coverage`,
    columns: columnsFor(intent),
    rows,
    rowCount: rows.length,
    truncated: false,
    chartConfig: null,
    chartMeta: { source: chartSource(source), agencyCount: 0, population: null },
  };
}

function summarizeStates(rows: Record<string, unknown>[]): string {
  return rows.map((r) => String(r.state)).join(", ");
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
  if (!db) return null;

  const intent = detectMetadataIntent(question);
  if (!intent) return null;

  try {
    if (intent === "year_range") {
      const sql = yearSql(source);
      const rows = runRows(db, sql);
      return result(source, intent, sql, rows, yearExplanation(source, rows));
    }

    const sql = stateSql(source, intent);
    if (!sql) return null;

    const rows = runRows(db, sql);
    return result(source, intent, sql, rows, stateExplanation(source, intent, rows));
  } catch {
    return null;
  }
}
