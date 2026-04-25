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

const client = new Anthropic();

const EXPLAIN_SYSTEM = `You write one-sentence (max two) descriptions of crime data query results.

Your job: describe WHAT the data contains (metric, geography, time range). Nothing else.

RULES:
- NEVER cite numbers, trends, comparisons, highs, lows, or changes.
- NEVER use: "higher", "lower", "peaked", "declined", "ranging from", "compared to", "shows", "suggests", "may reflect", "driven by".
- Do NOT mention SQL, table names, or technical details.
- Use the user's own words for their question.
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

function extractMetrics(columns: string[]): string[] {
  const skip = new Set([
    "year", "data_year", "month", "city", "state", "agency_name",
    "agency", "state_name", "population", "Year", "Month",
  ]);
  return columns.filter((c) => !skip.has(c));
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
        const actual = Number(rows[0][yearCol]);
        if (!isNaN(actual) && actual > requested + 1) {
          parts.push(
            `Data begins in ${actual} although ${requested} was requested — earlier years are not available in this dataset.`
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
  if (geos.length > 0) {
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

  const userPrompt = `User question: "${ctx.question}"

Results metadata:
- Rows: ${rowCount}
- Metrics: ${metrics.join(", ") || "various"}
- Year range: ${yearRange || "unknown"}
- Geographies: ${geoDisplay}
- Scope: ${ctx.scope}

Describe what these results contain in one sentence (metric, geography, time range).${disclaimerBlock}`;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: EXPLAIN_SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = message.content[0].type === "text" ? message.content[0].text.trim() : "";
    if (text.length > 10) return text;
  } catch (e) {
    console.warn(`[explain] Post-query explanation failed, using pre-query:`, e);
  }

  // Fallback to pre-query explanation
  return preQueryExplanation;
}
