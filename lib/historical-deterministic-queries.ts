import type { ChartConfig, ChartMeta } from "./types";

export interface HistoricalCityChangePlan {
  sql: string | null;
  title: string;
  explanation: string;
  columns: string[];
  chartConfig: ChartConfig | null;
  chartMeta: ChartMeta | null;
  guardrail: string;
}

function historyText(rawHistory: unknown): string {
  if (!Array.isArray(rawHistory)) return "";
  return rawHistory
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const content = (entry as { content?: unknown }).content;
      return typeof content === "string" ? content : "";
    })
    .filter(Boolean)
    .join("\n");
}

function hasRankingContext(text: string): boolean {
  return /\bcit(?:y|ies)\b/i.test(text) &&
    /\b(?:steepest|largest|biggest|fastest|most|top|rank)\b/i.test(text) &&
    /\b(?:decline|decrease|drop|increase|rise|change|changed)\b/i.test(text) &&
    /\bviolent\s+crime\b/i.test(text);
}

function isRankingFollowup(question: string): boolean {
  return /\b(?:percentage|percent|pct)\s+(?:decline|decrease|drop|increase|rise|change)\b/i.test(question) ||
    /\bfrom\s+(?:19|20)\d{2}\s+(?:to|through|and|-)\s+(?:19|20)\d{2}\b/i.test(question) ||
    /\b(?:these|those)\s+cities\b/i.test(question) ||
    /\b(?:too\s+small|large(?:r)?\s+cities|big(?:ger)?\s+cities|population)\b/i.test(question);
}

function explicitYearRange(text: string): { startYear: number; endYear: number } | null {
  const bounded = text.match(
    /\b(?:from|between)\s+(19\d{2}|20\d{2}|2100)\s+(?:to|through|thru|and|-)\s+(19\d{2}|20\d{2}|2100)\b/i
  ) || text.match(/\b(19\d{2}|20\d{2}|2100)\s*(?:-|to|through|thru)\s*(19\d{2}|20\d{2}|2100)\b/i);
  if (bounded) {
    const a = Number(bounded[1]);
    const b = Number(bounded[2]);
    return { startYear: Math.min(a, b), endYear: Math.max(a, b) };
  }

  const years = [...text.matchAll(/\b(19\d{2}|20\d{2}|2100)\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 1900 && year <= 2100);
  if (years.length >= 2) {
    return { startYear: Math.min(...years), endYear: Math.max(...years) };
  }
  return null;
}

function populationFloor(question: string, context: string): number | null {
  const text = `${question}\n${context}`;
  const explicit = text.match(/\b(?:population|cities)\s+(?:of|over|above|at least|>=?)\s+(\d{2,3})(?:,\d{3})?\s*(k|thousand|m|million)?\b/i);
  if (explicit) {
    const base = Number(explicit[1].replace(/,/g, ""));
    const suffix = (explicit[2] || "").toLowerCase();
    if (suffix === "m" || suffix === "million") return base * 1_000_000;
    if (suffix === "k" || suffix === "thousand" || base < 1000) return base * 1000;
    return base;
  }
  if (/\b(?:too\s+small|large(?:r)?\s+cities|big(?:ger)?\s+cities)\b/i.test(text)) return 250_000;
  return null;
}

function direction(text: string): "decline" | "increase" {
  if (/\b(?:increase|rise|growth|grew|growing|largest gain|biggest gain)\b/i.test(text)) return "increase";
  return "decline";
}

function cityLabelSql(): string {
  const stateDisplay = "CASE WHEN UPPER(ha.state) = 'NB' THEN 'NE' WHEN UPPER(ha.state) = 'GM' THEN 'GU' ELSE UPPER(ha.state) END";
  return `CASE
        WHEN ha.agency = 'Metropolitan Police Department' AND UPPER(ha.state) = 'DC' THEN 'Washington'
        WHEN ha.agency = 'Metropolitan Nashville Police Department' AND UPPER(ha.state) = 'TN' THEN 'Nashville'
        WHEN ha.agency = 'Las Vegas Metropolitan Police Department' AND UPPER(ha.state) = 'NV' THEN 'Las Vegas'
        WHEN ha.agency = 'Charlotte-Mecklenburg' AND UPPER(ha.state) = 'NC' THEN 'Charlotte'
        ELSE ha.agency
      END || ', ' || ${stateDisplay}`;
}

export function buildHistoricalCityChangeRankingPlan(
  question: string,
  rawHistory?: unknown
): HistoricalCityChangePlan | null {
  const history = historyText(rawHistory);
  const context = `${history}\n${question}`;
  const currentMatches = hasRankingContext(question);
  const inheritedMatches = hasRankingContext(history) && isRankingFollowup(question);
  if (!currentMatches && !inheritedMatches) return null;

  const range = explicitYearRange(question) ?? explicitYearRange(history);
  const dir = direction(context);
  const noun = dir === "increase" ? "increase" : "decline";
  if (!range) {
    return {
      sql: null,
      title: "Choose a Comparison Period",
      explanation: `I can rank cities by percentage ${noun} in total violent crime, but I need a comparison period. Try "from 2015 to 2024" or another start and end year.`,
      columns: [],
      chartConfig: null,
      chartMeta: { source: "FBI SRS", agencyCount: 0, population: null },
      guardrail: "deterministic-historical-city-change-ranking",
    };
  }

  const floor = populationFloor(question, context);
  const floorJoin = floor
    ? `LEFT JOIN historical_agency_population hap ON hap.ori = ha.ori AND hap.year = ${range.endYear}`
    : "";
  const floorColumn = floor ? ", MAX(hap.population) AS population_end" : "";
  const floorPivotSelect = floor ? ", MAX(population_end) AS population_end" : "";
  const floorSelect = floor ? ", population_end" : "";
  const floorFilter = floor ? ` AND population_end >= ${floor}` : "";
  const order = dir === "increase" ? "pct_change DESC" : "pct_change ASC";
  const directionFilter = dir === "increase" ? "pct_change > 0" : "pct_change < 0";
  const startCol = `violent_${range.startYear}`;
  const endCol = `violent_${range.endYear}`;
  const columns = floor
    ? ["city", startCol, endCol, "pct_change", "population_end"]
    : ["city", startCol, endCol, "pct_change"];

  const sql = `
    WITH city_years AS (
      SELECT
        ${cityLabelSql()} AS city,
        hac.year,
        SUM(hac.violent) AS violent${floorColumn}
      FROM historical_agency ha
      JOIN historical_agency_crime hac ON hac.ori = ha.ori
      ${floorJoin}
      WHERE LOWER(ha.type) = 'city'
        AND hac.year IN (${range.startYear}, ${range.endYear})
        AND hac.violent IS NOT NULL
      GROUP BY city, hac.year
    ),
    pivoted AS (
      SELECT
        city,
        SUM(CASE WHEN year = ${range.startYear} THEN violent END) AS ${startCol},
        SUM(CASE WHEN year = ${range.endYear} THEN violent END) AS ${endCol}${floorPivotSelect}
      FROM city_years
      GROUP BY city
      HAVING ${startCol} IS NOT NULL AND ${endCol} IS NOT NULL AND ${startCol} > 0
    ),
    changes AS (
      SELECT
        city,
        ${startCol},
        ${endCol},
        ROUND(100.0 * (${endCol} - ${startCol}) / ${startCol}, 1) AS pct_change${floorSelect}
      FROM pivoted
    )
    SELECT ${columns.join(", ")}
    FROM changes
    WHERE ${directionFilter}${floorFilter}
    ORDER BY ${order}
    LIMIT 20
  `.trim();

  const floorText = floor
    ? ` Restricted to cities with Historical agency population of at least ${floor.toLocaleString()} in ${range.endYear}.`
    : "";
  return {
    sql,
    title: `Cities With the Steepest Violent Crime ${noun[0].toUpperCase()}${noun.slice(1)}, ${range.startYear}-${range.endYear}`,
    explanation: `Cities with the steepest percentage ${noun} in total violent crime from ${range.startYear} to ${range.endYear} among Historical city agencies. Each row compares reported violent-crime counts in the start and end years; cities missing either year are excluded.${floorText}`,
    columns,
    chartConfig: {
      type: "bar",
      xAxis: "city",
      yAxis: ["pct_change"],
      title: `Percent ${noun} in violent crime, ${range.startYear}-${range.endYear}`,
      yAxisLabel: "Percent change",
    },
    chartMeta: { source: "FBI SRS", agencyCount: 0, population: null },
    guardrail: "deterministic-historical-city-change-ranking",
  };
}
