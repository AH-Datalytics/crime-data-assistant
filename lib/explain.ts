/**
 * Post-query explanation generator.
 *
 * Generates the user-facing explanation AFTER the SQL query has run,
 * so it can reference actual results instead of guessing.
 * Uses Haiku for speed (~500ms).
 *
 * Now consumes QueryContext for geography/scope/offense info instead
 * of re-deriving from result rows. Result rows are only used for
 * year range (actual data) and metric column names.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { QueryContext } from "./query-context";
import { removeCodeFences, removeJsonWithSqlKey } from "./text-sanitize";

const client = new Anthropic();

const EXPLAIN_SYSTEM = `You write one-sentence (max two) descriptions of crime data query results.

Your job: describe WHAT the data contains (metric, geography, time range). Nothing else.

RULES:
- NEVER cite numbers, trends, comparisons, highs, lows, or changes.
- NEVER use: "higher", "lower", "peaked", "declined", "ranging from", "compared to", "shows", "suggests", "may reflect", "driven by".
- Do NOT mention SQL, table names, or technical details.
- Use the user's own words for their question.
- When an offense/topic is provided, explicitly name it; never replace a specific offense with generic "crime data."
- Use the Results metadata year range, which reflects returned rows; a short follow-up may mention only newly added years.
- NEVER mention a city, agency, or entity name unless it appears in the "Entities in results" list. If no entities are listed, describe the data generically (e.g., "cities ranked by..."). Making up entity names is the worst possible error.
- Geography accuracy is critical:
  - If Scope says "state" or "statewide", say "statewide" — NEVER say "cities in [state]" or "[state] cities".
  - If Scope says "county", say "the [County Name] county agency record" — NEVER say "cities in [county]" or "cities within [county]".
  - If Scope says "city", use the city name.
- Append any disclaimer provided VERBATIM — do not rephrase it.
- Return ONLY the explanation text.`;

/* ------------------------------------------------------------------ */
/*  Helpers — only for result-row metadata that QueryContext can't     */
/*  know (actual year range from returned data, metric column names)   */
/* ------------------------------------------------------------------ */

function extractYearRange(rows: Record<string, unknown>[]): string | null {
  const yearCol = ["year", "data_year", "Year"].find(
    (c) => rows[0]?.[c] !== undefined
  );
  if (!yearCol) return null;
  const years = rows
    .map((r) => Number(r[yearCol]))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
  if (years.length === 0) return null;
  const lo = years[0];
  const hi = years[years.length - 1];
  return lo === hi ? String(lo) : `${lo} to ${hi}`;
}

export function earliestReturnedYear(rows: Record<string, unknown>[]): number | null {
  const yearCol = ["year", "data_year", "Year"].find(
    (c) => rows[0]?.[c] !== undefined
  );
  if (!yearCol) return null;
  const years = rows
    .map((r) => Number(r[yearCol]))
    .filter((n) => Number.isFinite(n));
  if (years.length === 0) return null;
  return Math.min(...years);
}

function extractMetrics(columns: string[]): string[] {
  const skip = new Set([
    "year", "data_year", "month", "city", "state", "agency_name",
    "agency", "state_name", "population", "Year", "Month",
    "ucr_offense_code", "ucr_arrest_offense", "offense_code",
  ]);
  return columns.filter((c) => !skip.has(c));
}

const OFFENSE_MENTION: Record<string, RegExp> = {
  murder: /\b(?:murder|murders|homicide|homicides)\b/i,
  rape: /\b(?:rape|rapes)\b/i,
  robbery: /\b(?:robbery|robberies)\b/i,
  "aggravated assault": /\baggravated assaults?\b/i,
  burglary: /\b(?:burglary|burglaries)\b/i,
  theft: /\b(?:theft|thefts|larceny|larcenies)\b/i,
  "motor vehicle theft": /\b(?:motor vehicle|auto|vehicle) thefts?\b/i,
  carjacking: /\bcarjackings?\b/i,
  arson: /\barsons?\b/i,
};

/** Ensure a known single-offense query is never described as generic crime data. */
export function ensureExplanationOffenseLabel(explanation: string, offenses: string[]): string {
  if (offenses.length !== 1 || !explanation) return explanation;
  const offense = offenses[0].toLowerCase();
  if (OFFENSE_MENTION[offense]?.test(explanation)) return explanation;

  const label = offense.replace(/\b\w/g, (letter) => letter.toUpperCase());
  const repaired = explanation
    .replace(/\bcrime data\b/i, `${label} data`)
    .replace(/\bcrime counts?\b/i, `${label} counts`)
    .replace(/\bcrime incidents?\b/i, `${label} incidents`);
  return repaired !== explanation ? repaired : `${label} — ${explanation}`;
}

/** Replace a follow-up's partial year wording with the range actually returned. */
export function ensureExplanationYearRange(explanation: string, yearRange: string | null): string {
  if (!yearRange || !explanation) return explanation;
  const expectedYears: string[] = yearRange.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  const mentionedYears: string[] = explanation.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  if (expectedYears.length > 0 && expectedYears.every((year) => mentionedYears.includes(year))) {
    return explanation;
  }

  const replacement = expectedYears.length === 1 ? `in ${yearRange}` : `from ${yearRange}`;
  const repaired = explanation.replace(
    /\b(?:from|for|in)\s+(?:19|20)\d{2}\s+(?:to|through|and|[-–—])\s+(?:19|20)\d{2}\b/i,
    replacement,
  );
  if (repaired !== explanation) return repaired;
  return `${explanation.replace(/[.]$/, "")} ${replacement}.`;
}

/**
 * Extract actual entity names (cities, agencies, states) from result rows.
 * This grounds the explanation in real data, preventing hallucination.
 */
function extractEntitiesFromResults(
  rows: Record<string, unknown>[],
  columns: string[]
): string[] {
  // Look for entity columns in priority order
  const entityCols = ["city", "agency", "agency_name", "state_name", "state"];
  const entityCol = entityCols.find((c) => columns.includes(c));
  if (entityCol) {
    const entities = rows
      .map((r) => String(r[entityCol] ?? ""))
      .filter((v) => v.length > 0);
    // Deduplicate while preserving order
    return [...new Set(entities)].slice(0, 15);
  }
  // Check for formatted columns like "city || ', ' || state" aliased as something custom
  // These show up as non-metric, non-year columns with string values
  const metricCols = new Set([
    "year", "data_year", "month", "population", "Year", "Month",
    "count", "total", "rate", "rate_per_100k", "pct_change",
    "count_2020", "count_2024", "count_2024_plus", "y2020", "y2024",
    "ucr_offense_code", "ucr_arrest_offense", "offense_code",
    "offense", "offense_name", "arrest_offense", "crime_type",
    "age_group", "race", "sex", "ethnicity", "weapon", "weapon_category",
  ]);
  for (const col of columns) {
    if (metricCols.has(col)) continue;
    const firstVal = rows[0]?.[col];
    if (typeof firstVal === "string" && firstVal.length > 1 && isNaN(Number(firstVal))) {
      const entities = rows
        .map((r) => String(r[col] ?? ""))
        .filter((v) => v.length > 0);
      return [...new Set(entities)].slice(0, 15);
    }
  }
  return [];
}

/* ------------------------------------------------------------------ */
/*  Deterministic disclaimer builder                                   */
/* ------------------------------------------------------------------ */

function buildDisclaimers(
  ctx: QueryContext,
  rows: Record<string, unknown>[],
  yearRange: string | null
): string[] {
  const parts: string[] = [];

  // Tab-specific standing disclaimers
  if (ctx.tab === "current") {
    // Only show sample-of-agencies disclaimer for national/state scope, not city
    if (ctx.scope === "national" || ctx.scope === "state") {
      parts.push(
        "This data comes from a sample of agencies reporting to The Crime Index and does not represent a national total."
      );
    }
  } else if (ctx.tab === "historical") {
    const lo = yearRange ? parseInt(yearRange) : (ctx.timeRange.start || 9999);
    if (lo < 1960) {
      parts.push(
        "FBI agency coverage before 1960 was limited; interpret early years with caution."
      );
    }
    // County agency record caveat
    const sqlLower = ctx.sql.toLowerCase();
    if (sqlLower.includes("type = 'county'") || sqlLower.includes("type='county'")) {
      parts.push(
        "This is the county agency record (typically the sheriff's office), not a rollup of every municipal agency within the county."
      );
    }
  }
  // NIBRS: no disclaimer here — the server appends a standard one automatically

  // Date-gap detection (NIBRS only)
  if (ctx.tab === "nibrs" && rows.length > 0) {
    const startMatch =
      ctx.question.match(/(?:since|from|starting|beginning)\s+(\d{4})/i) ||
      ctx.question.match(/(\d{4})\s*(?:to|through|-)\s*\d{4}/i);
    if (startMatch) {
      const requested = parseInt(startMatch[1]);
      const yearCol = ["year", "data_year", "Year"].find(
        (c) => rows[0]?.[c] !== undefined
      );
      if (yearCol) {
        const actual = earliestReturnedYear(rows);
        if (actual !== null && actual > requested + 1) {
          parts.push(
            `Data begins in ${actual} although ${requested} was requested — earlier years are not available in this dataset. For data going back further, try the [Historical Library](/?tab=historical) tab (annual data from the 1930s) or the [Current Trends](/?tab=current) tab.`
          );
        }
      }
    }
  }

  return parts;
}

/* ------------------------------------------------------------------ */
/*  Main export                                                        */
/* ------------------------------------------------------------------ */

/**
 * Generate a post-query explanation.
 *
 * Accepts QueryContext for geography/scope (single source of truth)
 * plus result rows for year range and metric detection.
 */
export async function generateExplanation(opts: {
  ctx: QueryContext;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  disclaimers: string;
  preQueryExplanation: string;
}): Promise<string> {
  const { ctx, columns, rows, rowCount, disclaimers, preQueryExplanation } = opts;

  if (rowCount === 0) {
    return "The query returned no results. Try broadening your search or adjusting the time range.";
  }

  // Year range from actual result rows (more accurate than SQL filter years)
  const yearRange = extractYearRange(rows);
  // Metric columns from results
  const metrics = extractMetrics(columns);
  // Geography from QueryContext (single source of truth)
  const geos = ctx.geos;

  // Build disclaimers deterministically
  const autoDisclaimers = buildDisclaimers(ctx, rows, yearRange);
  // Merge any caller-supplied disclaimers (e.g., CDE underreporting from NIBRS route)
  if (disclaimers) autoDisclaimers.unshift(disclaimers);
  const disclaimerBlock =
    autoDisclaimers.length > 0
      ? `\nAppend these disclaimers verbatim:\n${autoDisclaimers.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
      : "";

  // Geography display — detect regions from state lists
  const REGIONS: Record<string, string[]> = {
    "the Northeast": ["CT","ME","MA","NH","RI","VT","NJ","NY","PA"],
    "the South": ["AL","AR","DE","DC","FL","GA","KY","LA","MD","MS","NC","OK","SC","TN","TX","VA","WV"],
    "the Midwest": ["IL","IN","IA","KS","MI","MN","MO","NE","ND","OH","SD","WI"],
    "the West": ["AK","AZ","CA","CO","HI","ID","MT","NV","NM","OR","UT","WA","WY"],
  };
  let geoDisplay: string;
  if (ctx.scope === "county" && geos.length > 0) {
    geoDisplay = `${geos[0]} (county agency record)`;
  } else if (ctx.scope === "state" && ctx.tables.includes("historical_state_national")) {
    // Explicit statewide label — prevents Haiku from saying "cities in [state]"
    const stateName = ctx.question.match(/\b(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New\s+Hampshire|New\s+Jersey|New\s+Mexico|New\s+York|North\s+Carolina|North\s+Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode\s+Island|South\s+Carolina|South\s+Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West\s+Virginia|Wisconsin|Wyoming|District\s+of\s+Columbia)\b/i);
    geoDisplay = stateName ? `${stateName[1]} (statewide)` : "statewide";
  } else if (geos.length > 0) {
    geoDisplay = geos.join(", ");
  } else if (ctx.states.length >= 5) {
    // Check if states match a region
    const sortedStates = [...ctx.states].sort();
    const regionMatch = Object.entries(REGIONS).find(([, states]) =>
      sortedStates.length === states.length && sortedStates.every(s => states.includes(s))
    );
    geoDisplay = regionMatch ? regionMatch[0] : `${ctx.states.length} states (${ctx.states.slice(0, 5).join(", ")}...)`;
  } else if (ctx.scope === "state" && ctx.states.length > 0) {
    geoDisplay = ctx.states.join(", ");
  } else if (ctx.scope === "national" && !ctx.question.match(/\b(?:in|for)\s+[A-Z]/i)) {
    geoDisplay = "national level";
  } else {
    // Extract place name from user's question rather than defaulting to "national"
    const placeMatch = ctx.question.match(/\b(?:in|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
    geoDisplay = placeMatch ? placeMatch[1] : "as requested";
  }

  // Extract actual entity names from result rows to ground the explanation
  const resultEntities = extractEntitiesFromResults(rows, columns);
  const entitiesLine = resultEntities.length > 0
    ? `\n- Entities in results: ${resultEntities.join(", ")}`
    : "";

  const userPrompt = `User question: "${ctx.question}"

Results metadata:
- Rows: ${rowCount}
- Metrics: ${metrics.join(", ") || "various"}
- Offense/topic: ${ctx.offenses.join(", ") || "not offense-specific"}
- Year range: ${yearRange || "unknown"}
- Geographies: ${geoDisplay}
- Scope: ${ctx.scope}${entitiesLine}

Describe what these results contain in one sentence (metric, geography, time range). ONLY mention cities/agencies/entities that appear in the "Entities in results" list above. Do NOT mention any entity not in the results.${disclaimerBlock}`;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: EXPLAIN_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text.trim() : "";
    if (text.length > 10) {
      // Validate: check for hallucinated entity names
      let validated = validateExplanationEntities(text, resultEntities, ctx.geos);
      // Validate: fix hallucinated row/entity counts
      validated = validateExplanationCount(validated, rows, columns);
      validated = ensureExplanationYearRange(validated, yearRange);
      return ensureExplanationOffenseLabel(validated, ctx.offenses);
    }
  } catch (e) {
    console.warn(`[explain] Post-query explanation failed, using pre-query:`, e);
  }

  // Fallback to pre-query explanation (sanitized)
  const fallback = ensureExplanationYearRange(sanitizeExplanation(preQueryExplanation), yearRange);
  return ensureExplanationOffenseLabel(fallback, ctx.offenses);
}

/**
 * Validate that entity names in the explanation actually appear in the results.
 * If a hallucinated entity is detected, strip it or replace with generic text.
 */
function validateExplanationEntities(
  explanation: string,
  resultEntities: string[],
  sqlGeos: string[]
): string {
  // Build a set of known-valid entity names (from results + SQL WHERE clauses)
  const validNames = new Set<string>();
  for (const e of resultEntities) {
    validNames.add(e.toLowerCase());
    // Also add the city part if format is "City, ST"
    const commaIdx = e.indexOf(",");
    if (commaIdx > 0) validNames.add(e.slice(0, commaIdx).trim().toLowerCase());
    // Also add parts of hyphenated names (e.g., "Charlotte-Mecklenburg" → "Charlotte", "Mecklenburg")
    if (e.includes("-")) {
      for (const part of e.split("-")) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed.length > 2) validNames.add(trimmed);
      }
    }
  }
  for (const g of sqlGeos) validNames.add(g.toLowerCase());

  // Common US city names that might be hallucinated
  const CITY_NAMES = [
    "Los Angeles", "New York City", "New York", "Chicago", "Houston", "Phoenix", "Philadelphia",
    "San Antonio", "San Diego", "Dallas", "San Jose", "Austin", "Jacksonville",
    "Fort Worth", "Columbus", "Charlotte", "Indianapolis", "San Francisco",
    "Seattle", "Denver", "Washington", "Nashville", "Oklahoma City", "El Paso",
    "Boston", "Portland", "Las Vegas", "Memphis", "Louisville", "Baltimore",
    "Milwaukee", "Albuquerque", "Tucson", "Fresno", "Mesa", "Sacramento",
    "Atlanta", "Kansas City", "Omaha", "Colorado Springs", "Raleigh", "Long Beach",
    "Virginia Beach", "Miami", "Oakland", "Minneapolis", "Tampa", "Tulsa",
    "Arlington", "New Orleans", "Detroit", "St Louis", "St. Louis",
  ];

  let cleaned = explanation;
  let hadHallucination = false;

  for (const city of [...CITY_NAMES].sort((a, b) => b.length - a.length)) {
    // Check if city is mentioned in explanation but NOT in valid names
    const cityRegex = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    const cityLower = city.toLowerCase();
    const isValidName = [...validNames].some((name) => name.includes(cityLower) || cityLower.includes(name));
    if (cityRegex.test(cleaned) && !isValidName) {
      hadHallucination = true;
      // Replace the hallucinated city name with generic text
      cleaned = cleaned.replace(cityRegex, "cities in the dataset");
      console.warn(`[explain] Hallucination detected: "${city}" not in results, stripped from explanation`);
    }
  }

  // Deduplicate "cities in the dataset" if it was inserted multiple times
  if (hadHallucination) {
    cleaned = cleaned.replace(/cities in the dataset(?:,?\s*(?:and\s+)?cities in the dataset)+/gi, "cities in the dataset");
  }

  return cleaned;
}

/**
 * Compute the actual count for a noun like "agencies", "cities", "years" from result data.
 * Returns null if we can't determine the count.
 */
function getActualCountForNoun(
  noun: string,
  rows: Record<string, unknown>[],
  columns: string[]
): number | null {
  if (rows.length === 0) return null;
  const nounLower = noun.toLowerCase();

  if (/agencies|departments|police departments/.test(nounLower)) {
    // Distinct ORI if present, else distinct agency+state, else distinct agency
    if (columns.includes("ori")) {
      return new Set(rows.map(r => r.ori)).size;
    }
    const agencyCol = columns.find(c => /^(agency|city|department|agency_name)$/i.test(c));
    const stateCol = columns.find(c => /^state$/i.test(c));
    if (agencyCol && stateCol) {
      return new Set(rows.map(r => `${r[agencyCol]}|${r[stateCol]}`)).size;
    }
    if (agencyCol) {
      return new Set(rows.map(r => r[agencyCol])).size;
    }
    return null;
  }

  if (/cities|jurisdictions/.test(nounLower)) {
    const cityCol = columns.find(c => /^(city|agency|agency_name)$/i.test(c));
    const stateCol = columns.find(c => /^state$/i.test(c));
    if (cityCol && stateCol) {
      return new Set(rows.map(r => `${r[cityCol]}|${r[stateCol]}`)).size;
    }
    if (cityCol) {
      return new Set(rows.map(r => r[cityCol])).size;
    }
    return null;
  }

  if (/rows|results|records/.test(nounLower)) {
    return rows.length;
  }

  if (/years/.test(nounLower)) {
    const yearCol = columns.find(c => /^(year|data_year)$/i.test(c));
    if (yearCol) {
      return new Set(rows.map(r => r[yearCol])).size;
    }
    return null;
  }

  if (/months/.test(nounLower)) {
    const yearCol = columns.find(c => /^(year|data_year)$/i.test(c));
    const monthCol = columns.find(c => /^month$/i.test(c));
    if (yearCol && monthCol) {
      return new Set(rows.map(r => `${r[yearCol]}-${r[monthCol]}`)).size;
    }
    if (monthCol) {
      return new Set(rows.map(r => r[monthCol])).size;
    }
    return null;
  }

  return null;
}

/**
 * Fix hallucinated counts in the explanation by checking against actual result data.
 * Uses distinct entity counts, not raw row count.
 */
export function validateExplanationCount(
  explanation: string,
  rows: Record<string, unknown>[],
  columns: string[]
): string {
  return explanation.replace(
    /\b(\d{1,4})\s+(agencies|departments|police departments|cities|jurisdictions|rows|results|records|years|months)\b/gi,
    (match, rawNum, noun) => {
      const stated = Number(rawNum);
      const actual = getActualCountForNoun(noun, rows, columns);

      if (actual == null) {
        // Can't determine actual count — use soft phrasing for entity nouns
        if (/agencies|departments|cities|jurisdictions/.test(noun.toLowerCase())) {
          return `the returned ${noun}`;
        }
        return match;
      }

      if (stated === actual) return match;

      console.warn(`[explain] Count fix: "${stated} ${noun}" → "${actual} ${noun}" (actual from data)`);
      return `${actual} ${noun}`;
    }
  );
}

/**
 * Strip JSON, SQL, code blocks, and technical syntax from explanation text.
 * Defense-in-depth: even if the model ignores prompt instructions, the user
 * never sees raw SQL/JSON.
 */
export function sanitizeExplanation(text: string): string {
  if (!text) return text;

  // If the entire text is a JSON object (model returned its response as explanation), extract just the explanation field
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.includes('"sql"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.explanation && typeof parsed.explanation === "string") {
        return sanitizeExplanation(parsed.explanation);
      }
    } catch {
      // Not valid JSON, continue with other cleanup
    }
  }

  let cleaned = text;

  // Remove markdown code fences and their contents (linear scan, no backtracking)
  cleaned = removeCodeFences(cleaned);

  // Remove inline code containing SQL keywords
  cleaned = cleaned.replace(/`[^`]*(?:SELECT|FROM|WHERE|JOIN|GROUP|ORDER|INSERT|UPDATE|DELETE)[^`]*`/gi, "");

  // Remove any JSON-like blocks with sql field (bounded char class, no backtracking)
  cleaned = removeJsonWithSqlKey(cleaned);

  // Remove standalone SQL statements (SELECT ... FROM ... up to semicolon or double newline)
  cleaned = cleaned.replace(/\bSELECT\b[^;]*?\bFROM\s+\w+[^;]*?(?:;|\n\n|$)/gi, "");

  // Remove table/column name references (e.g., "agency_monthly.count", "am.year")
  cleaned = cleaned.replace(/\b\w+_(?:monthly|daily|annual|state|city|national)\b/gi, "");

  // Clean up excess whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  // If nothing meaningful remains after cleanup, return a generic message
  if (cleaned.length < 10) {
    return "I wasn't able to generate a clear explanation for this query. The data is shown in the chart and table below.";
  }

  return cleaned;
}
