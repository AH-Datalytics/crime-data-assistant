import type Database from "better-sqlite3";
import type { ChartMeta } from "./types";
import { STATE_NAME_TO_ABBR } from "./state-population";

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
  | "available_cities"
  | "county_membership_unavailable";

interface CountyScope {
  key: string;
  display: string;
}

function norm(question: string): string {
  return question.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
}

function asksContinuousReportingFilter(q: string): boolean {
  return /\b(?:continuous(?:ly)?|consistent(?:ly)?)\s+(?:reporting\s+)?(?:agenc(?:y|ies)|reporters?)\b/i.test(q) ||
    /\b(?:agenc(?:y|ies)|reporters?)\s+that\s+reported\s+every\s+year\b/i.test(q) ||
    /\bagenc(?:y|ies)\s+that\s+reported\s+all\s+12\s+months\b/i.test(q) ||
    /\breported\s+(?:all\s+)?(?:12\s+)?months\s+every\s+year\b/i.test(q) ||
    /\ball\s+12\s+months\s+(?:in|for)\s+every\s+year\b/i.test(q) ||
    /\badjust(?:ed)?\s+for\s+incomplete\s+coverage\b/i.test(q) ||
    /\binclude\s+(?:only\s+)?(?:continuous(?:ly)?|consistent(?:ly)?)\s+(?:reporting\s+)?(?:agenc(?:y|ies)|reporters?)\b/i.test(q);
}

function asksAnalyticResult(q: string): boolean {
  return /\b(rate|rates|per\s*(?:100\s*k|100,?000|capita)|highest|lowest|top|bottom|most|least|rank(?:ed|ing)?|trend|trends|compare|comparison)\b/.test(q) ||
    /\b(crime|crimes|offense|offenses|homicide|homicides|murder|murders|shooting|shootings|gun violence|robbery|robberies|assault|assaults|burglary|burglaries|theft|thefts|rape|rapes|carjacking|carjackings|arrest|arrests|clearance|clearances|victim|victims)\b/.test(q);
}

function detectMetadataIntent(question: string): Intent | null {
  const q = norm(question);
  if (/\b(download|export|csv)\b/.test(q) && /\b(this|these|result|results|table|data|chart|it)\b/.test(q)) {
    return "download_help";
  }

  if (asksContinuousReportingFilter(q) || asksAnalyticResult(q)) {
    return null;
  }

  const mentionsAgency = /\bagenc(?:y|ies)\b|\bdepartments?\b|\bpolice departments?\b/.test(q);
  const mentionsCity = /\bcit(?:y|ies)\b/.test(q);
  const asksCount = /\b(how many|number of|count)\b/.test(q);
  const asksAvailable = /\b(which|what|list|available|represented|covered|coverage|have data|data for|reporting|included)\b/.test(q);
  if (/\bpopulation\b/.test(q) && mentionsAgency) {
    return null;
  }
  const asksCountyMembership = /\b(county|counties|parish|parishes|borough)\b/.test(q) &&
    (mentionsAgency || mentionsCity) &&
    (asksCount || asksAvailable || /\b(?:in|within|inside|cover(?:ing)?)\b/.test(q));

  if (asksCountyMembership && mentionsCity) {
    return asksCount ? "city_count" : "available_cities";
  }
  if (asksCountyMembership && mentionsAgency) {
    return asksCount ? "agency_count" : "available_agencies";
  }

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

function countyKey(value: string): string {
  return value
    .replace(/\b(county|parish|borough)\b/ig, " ")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
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
  if (intent === "download_help" || intent === "county_membership_unavailable") return ["answer"];
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

function countyMembershipUnavailableResult(source: MetadataSource): MetadataCoverageResult {
  const explanation = source === "nibrs"
    ? "I do not currently have a complete city/agency-to-county membership crosswalk for NIBRS. The county_lookup table identifies county/parish agencies by ORI, but it does not list every city agency located inside each county."
    : `I do not currently have a complete city/agency-to-county membership crosswalk for ${sourceLabel(source)}. I should not infer county membership from city-name searches.`;
  return result(
    source,
    "county_membership_unavailable",
    "SELECT 'Complete agency-by-county membership crosswalk is not available in this source' AS answer",
    [{ answer: explanation }],
    explanation,
  );
}

function countyAmbiguousResult(source: MetadataSource, county: CountyScope, states: string[]): MetadataCoverageResult {
  const explanation = `${county.display} County matches multiple states in the agency county crosswalk: ${states.join(", ")}. Please specify a state.`;
  return result(
    source,
    "county_membership_unavailable",
    "SELECT 'County name is ambiguous; specify a state' AS answer",
    [{ answer: explanation }],
    explanation,
  );
}

function countyNotFoundResult(source: MetadataSource, county: CountyScope): MetadataCoverageResult {
  const explanation = `I could not find ${county.display} County in the agency county crosswalk for ${sourceLabel(source)}.`;
  return result(
    source,
    "county_membership_unavailable",
    "SELECT 'County not found in agency county crosswalk' AS answer",
    [{ answer: explanation }],
    explanation,
  );
}

function stateScope(question: string): string | null {
  const q = question.replace(/\bwhich\s+states?\b/ig, "");

  if (/\bWashington,\s*D\.?C\.?\b|\bWashington DC\b|\bD\.?C\.?\b/i.test(q)) return "DC";

  for (const [name, abbr] of Object.entries(STATE_NAME_TO_ABBR)) {
    if (abbr === "US") continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const countyNamePattern = new RegExp(`\\b(?:County|Parish|Borough)\\s*,?\\s+${escaped}\\b`, "i");
    const countyAbbrPattern = new RegExp(
      abbr === "IN" || abbr === "OR"
        ? `\\b(?:County|Parish|Borough)\\s*,\\s*${abbr}\\b`
        : `\\b(?:County|Parish|Borough)\\s*,?\\s+${abbr}\\b`
    );
    if (countyNamePattern.test(q) || countyAbbrPattern.test(q)) return abbr;
    if (abbr === "WA" && /\bWashington\b/i.test(q) && !/\bWashington\s+State\b|\bState\s+of\s+Washington\b/i.test(q)) {
      continue;
    }
    const namePattern = new RegExp(`\\b(?:in|for|within|inside|across|from)\\s+${escaped}\\b|\\b${escaped}\\s+State\\b|\\bState\\s+of\\s+${escaped}\\b`, "i");
    const abbrPattern = new RegExp(`\\b(?:in|for|within|inside|across|from)\\s+${abbr}\\b|\\b${abbr}\\s+State\\b`);
    if (namePattern.test(q) || abbrPattern.test(q)) return abbr;
  }

  return null;
}

function countyScope(question: string): CountyScope | null {
  const prepositionPattern = /\b(?:in|within|inside|for|from|across|covering)\s+([A-Za-z][A-Za-z.' -]{1,80}?)\s+(County|Parish|Borough)\b/i;
  const fallbackPattern = /\b([A-Za-z][A-Za-z.' -]{1,80}?)\s+(County|Parish|Borough)\b/i;
  const match = prepositionPattern.exec(question) || fallbackPattern.exec(question);
  if (!match) return null;
  const name = match[1].replace(/^\b(the|a|an)\b\s+/i, "").trim();
  const key = countyKey(name);
  if (!key) return null;
  const display = name
    .split(/\s+/)
    .map((part) => /^(of|and|the)$/i.test(part) ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
  return { key, display };
}

function countyStates(db: Database.Database, county: CountyScope, stateFilter: string | null): string[] {
  const stateWhere = stateFilter ? " AND state = ?" : "";
  const params = stateFilter ? [county.key, stateFilter] : [county.key];
  const rows = db.prepare(`
    SELECT DISTINCT state
    FROM agency_county_crosswalk
    WHERE county_key = ? AND county_fips IS NOT NULL AND state IS NOT NULL${stateWhere}
    ORDER BY state
  `).all(...params) as { state: string }[];
  return rows.map((row) => row.state);
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

function countyTargetCte(county: CountyScope, stateFilter: string | null): string {
  const stateWhere = stateFilter ? ` AND state = ${quote(stateFilter)}` : "";
  return `WITH target_counties AS (
    SELECT DISTINCT state, county_fips
    FROM agency_county_crosswalk
    WHERE county_key = ${quote(county.key)} AND county_fips IS NOT NULL${stateWhere}
  ),
  county_crosswalk AS (
    SELECT x.*
    FROM agency_county_crosswalk x
    JOIN target_counties tc ON tc.state = x.state AND tc.county_fips = x.county_fips
  )`;
}

function countyEntitySql(source: MetadataSource, intent: Intent, county: CountyScope, stateFilter: string | null): string | null {
  const isCity = intent === "city_count" || intent === "available_cities";
  const isCount = intent === "agency_count" || intent === "city_count";
  const cte = countyTargetCte(county, stateFilter);
  const currentJoin = "JOIN county_crosswalk x ON a.ori = x.ori9 OR substr(a.ori, 1, 7) = x.ori";
  const shrJoin = "JOIN county_crosswalk x ON i.ori = x.ori OR substr(i.ori, 1, 7) = x.ori";

  switch (source) {
    case "current": {
      if (isCity) {
        return isCount
          ? `${cte} SELECT COUNT(DISTINCT a.ori) AS city_count FROM agencies a ${currentJoin} WHERE a.national_sample = 1 AND a.type = 'City' AND a.agency IS NOT NULL`
          : `${cte} SELECT DISTINCT a.agency AS city, a.state FROM agencies a ${currentJoin} WHERE a.national_sample = 1 AND a.type = 'City' AND a.agency IS NOT NULL ORDER BY a.state, a.agency LIMIT 50`;
      }
      return isCount
        ? `${cte} SELECT COUNT(DISTINCT a.ori) AS agency_count FROM agencies a ${currentJoin} WHERE a.national_sample = 1 AND a.agency IS NOT NULL`
        : `${cte} SELECT DISTINCT a.agency, a.state FROM agencies a ${currentJoin} WHERE a.national_sample = 1 AND a.agency IS NOT NULL ORDER BY a.state, a.agency LIMIT 50`;
    }
    case "historical": {
      const historicalJoin = "JOIN county_crosswalk x ON h.ori = x.ori9 OR substr(h.ori, 1, 7) = x.ori";
      if (isCity) {
        return isCount
          ? `${cte} SELECT COUNT(DISTINCT h.ori) AS city_count FROM historical_agency h ${historicalJoin} WHERE h.type = 'city' AND h.agency IS NOT NULL`
          : `${cte} SELECT DISTINCT h.agency AS city, UPPER(h.state) AS state FROM historical_agency h ${historicalJoin} WHERE h.type = 'city' AND h.agency IS NOT NULL ORDER BY state, h.agency LIMIT 50`;
      }
      return isCount
        ? `${cte} SELECT COUNT(DISTINCT h.ori) AS agency_count FROM historical_agency h ${historicalJoin} WHERE h.agency IS NOT NULL`
        : `${cte} SELECT DISTINCT h.agency, UPPER(h.state) AS state FROM historical_agency h ${historicalJoin} WHERE h.agency IS NOT NULL ORDER BY state, h.agency LIMIT 50`;
    }
    case "nibrs": {
      if (isCity) {
        return isCount
          ? `${cte} SELECT COUNT(DISTINCT a.city || '|' || a.state) AS city_count FROM agencies a ${currentJoin} WHERE a.city IS NOT NULL AND a.city <> '' AND a.state IS NOT NULL`
          : `${cte} SELECT DISTINCT a.city, a.state FROM agencies a ${currentJoin} WHERE a.city IS NOT NULL AND a.city <> '' AND a.state IS NOT NULL ORDER BY a.state, a.city LIMIT 50`;
      }
      return isCount
        ? `${cte} SELECT COUNT(DISTINCT a.ori) AS agency_count FROM agencies a ${currentJoin} WHERE a.ori IS NOT NULL`
        : `${cte} SELECT DISTINCT COALESCE(x.agency_name, a.ori) AS agency, a.state FROM agencies a ${currentJoin} WHERE a.ori IS NOT NULL ORDER BY a.state, agency LIMIT 50`;
    }
    case "shr": {
      if (isCity) {
        return isCount
          ? `${cte} SELECT COUNT(DISTINCT i.ori) AS city_count FROM incidents i ${shrJoin} WHERE i.agency_type = 'City' AND i.agency IS NOT NULL`
          : `${cte} SELECT DISTINCT i.agency AS city, i.state FROM incidents i ${shrJoin} WHERE i.agency_type = 'City' AND i.agency IS NOT NULL ORDER BY i.state, i.agency LIMIT 50`;
      }
      return isCount
        ? `${cte} SELECT COUNT(DISTINCT i.ori) AS agency_count FROM incidents i ${shrJoin} WHERE i.ori IS NOT NULL`
        : `${cte} SELECT DISTINCT i.agency, i.state FROM incidents i ${shrJoin} WHERE i.agency IS NOT NULL ORDER BY i.state, i.agency LIMIT 50`;
    }
    case "hate_crime": {
      const hateJoin = "JOIN county_crosswalk x ON h.ori = x.ori9 OR substr(h.ori, 1, 7) = x.ori";
      if (isCity) return null;
      return isCount
        ? `${cte} SELECT COUNT(DISTINCT h.ori) AS agency_count FROM hate_crime_incidents h ${hateJoin} WHERE h.ori IS NOT NULL`
        : `${cte} SELECT DISTINCT h.agency_name AS agency, h.state FROM hate_crime_incidents h ${hateJoin} WHERE h.agency_name IS NOT NULL ORDER BY h.state, h.agency_name LIMIT 50`;
    }
  }
}

function entitySql(source: MetadataSource, intent: Intent, db: Database.Database, stateFilter: string | null, county: CountyScope | null): string | null {
  const isCity = intent === "city_count" || intent === "available_cities";
  const isCount = intent === "agency_count" || intent === "city_count";
  const stateWhere = stateFilter ? ` AND state = ${quote(stateFilter)}` : "";
  const historicalStateWhere = stateFilter ? ` AND UPPER(state) = ${quote(stateFilter)}` : "";

  if (county) {
    if (!tableExists(db, "agency_county_crosswalk")) return null;
    return countyEntitySql(source, intent, county, stateFilter);
  }

  switch (source) {
    case "current": {
      if (!tableExists(db, "agencies")) return null;
      if (isCity) {
        return isCount
          ? `SELECT COUNT(DISTINCT agency || '|' || state) AS city_count FROM agencies WHERE national_sample = 1 AND type = 'City' AND agency IS NOT NULL${stateWhere}`
          : `SELECT agency AS city, state FROM agencies WHERE national_sample = 1 AND type = 'City' AND agency IS NOT NULL${stateWhere} ORDER BY state, agency LIMIT 50`;
      }
      return isCount
        ? `SELECT COUNT(DISTINCT ori) AS agency_count FROM agencies WHERE national_sample = 1 AND agency IS NOT NULL${stateWhere}`
        : `SELECT agency, state FROM agencies WHERE national_sample = 1 AND agency IS NOT NULL${stateWhere} ORDER BY state, agency LIMIT 50`;
    }
    case "historical": {
      if (!tableExists(db, "historical_agency")) return null;
      if (isCity) {
        return isCount
          ? `SELECT COUNT(DISTINCT ori) AS city_count FROM historical_agency WHERE type = 'city' AND agency IS NOT NULL${historicalStateWhere}`
          : `SELECT agency AS city, UPPER(state) AS state FROM historical_agency WHERE type = 'city' AND agency IS NOT NULL${historicalStateWhere} ORDER BY state, agency LIMIT 50`;
      }
      return isCount
        ? `SELECT COUNT(DISTINCT ori) AS agency_count FROM historical_agency WHERE agency IS NOT NULL${historicalStateWhere}`
        : `SELECT agency, UPPER(state) AS state FROM historical_agency WHERE agency IS NOT NULL${historicalStateWhere} ORDER BY state, agency LIMIT 50`;
    }
    case "nibrs": {
      if (!tableExists(db, "agencies")) return null;
      if (isCity) {
        return isCount
          ? `SELECT COUNT(DISTINCT city || '|' || state) AS city_count FROM agencies WHERE city IS NOT NULL AND city <> '' AND state IS NOT NULL${stateWhere}`
          : `SELECT DISTINCT city, state FROM agencies WHERE city IS NOT NULL AND city <> '' AND state IS NOT NULL${stateWhere} ORDER BY state, city LIMIT 50`;
      }
      return isCount
        ? `SELECT COUNT(DISTINCT ori) AS agency_count FROM agencies WHERE ori IS NOT NULL${stateWhere}`
        : `SELECT DISTINCT ori AS agency, state FROM agencies WHERE ori IS NOT NULL${stateWhere} ORDER BY state, ori LIMIT 50`;
    }
    case "shr": {
      if (!tableExists(db, "incidents")) return null;
      if (isCity) {
        return isCount
          ? `SELECT COUNT(DISTINCT agency || '|' || state) AS city_count FROM incidents WHERE agency_type = 'City' AND agency IS NOT NULL${stateWhere}`
          : `SELECT DISTINCT agency AS city, state FROM incidents WHERE agency_type = 'City' AND agency IS NOT NULL${stateWhere} ORDER BY state, agency LIMIT 50`;
      }
      return isCount
        ? `SELECT COUNT(DISTINCT ori) AS agency_count FROM incidents WHERE ori IS NOT NULL${stateWhere}`
        : `SELECT DISTINCT agency, state FROM incidents WHERE agency IS NOT NULL${stateWhere} ORDER BY state, agency LIMIT 50`;
    }
    case "hate_crime": {
      if (!tableExists(db, "hate_crime_incidents")) return null;
      if (isCity) return null;
      return isCount
        ? `SELECT COUNT(DISTINCT ori) AS agency_count FROM hate_crime_incidents WHERE ori IS NOT NULL${stateWhere}`
        : `SELECT DISTINCT agency_name AS agency, state FROM hate_crime_incidents WHERE agency_name IS NOT NULL${stateWhere} ORDER BY state, agency_name LIMIT 50`;
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

function countyEntityExplanation(
  source: MetadataSource,
  intent: Intent,
  rows: Record<string, unknown>[],
  truncated: boolean,
  county: CountyScope,
  stateFilter: string | null,
): string {
  const label = sourceLabel(source);
  const noun = intent === "city_count" || intent === "available_cities" ? "cities" : "agencies";
  const place = stateFilter ? `${county.display} County, ${stateFilter}` : `${county.display} County`;
  const countColumn = intent === "city_count" ? "city_count" : "agency_count";
  if (intent === "city_count" || intent === "agency_count") {
    const count = rows[0]?.[countColumn] ?? 0;
    return `${label} has ${count} ${noun} represented in ${place} based on agency_county_crosswalk.`;
  }

  const listed = rows
    .map((r) => String(r[noun === "cities" ? "city" : "agency"] || "").trim() + (r.state ? `, ${r.state}` : ""))
    .filter(Boolean)
    .join("; ");
  const prefix = truncated ? `Showing the first ${rows.length} ${noun} alphabetically in ${place}` : `${label} has these ${noun} represented in ${place}`;
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
  if (intent === "county_membership_unavailable") return countyMembershipUnavailableResult(source);
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
      const state = stateScope(question);
      const county = countyScope(question);
      if (county) {
        if (!tableExists(db, "agency_county_crosswalk")) return countyMembershipUnavailableResult(source);
        const states = countyStates(db, county, state);
        if (states.length === 0) return countyNotFoundResult(source, county);
        if (!state && states.length > 1) return countyAmbiguousResult(source, county, states);
      }
      const sql = entitySql(source, intent, db, state, county);
      if (!sql) return null;
      const rows = runRows(db, sql);
      const truncated = intent === "available_agencies" || intent === "available_cities";
      return result(source, intent, sql, rows, county ? countyEntityExplanation(source, intent, rows, truncated, county, state) : entityExplanation(source, intent, rows, truncated), truncated);
    }

    const sql = stateSql(source, intent);
    if (!sql) return null;

    const rows = runRows(db, sql);
    return result(source, intent, sql, rows, stateExplanation(source, intent, rows));
  } catch {
    return null;
  }
}
