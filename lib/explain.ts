/**
 * Post-query explanation generator.
 *
 * Generates the user-facing explanation AFTER the SQL query has run,
 * so it can reference actual results instead of guessing.
 * Uses Haiku for speed (~500ms).
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const EXPLAIN_SYSTEM = `You write brief explanations of crime data query results for a general audience.

RULES:
- 1-3 sentences maximum.
- Describe WHAT the data contains (time range, geographic scope, metric). Do NOT describe what the data SHOWS (trends, comparisons, highs, lows).
- NEVER compare values between cities, states, or time periods. NEVER say one is "higher", "lower", "more", "less", "consistently", "peaked", "declined", etc.
- NEVER cite specific numbers from the results. The user can read the chart and table.
- BANNED output patterns: "X has consistently recorded higher...", "X reached Y in [year]", "ranging from X to Y", "X compared to Y", "the data shows a trend of..."
- BANNED PHRASES: "may reflect", "likely due to", "could be attributed to", "suggests that", "driven by", "as a result of", "because of".
- Do NOT mention SQL, table names, database internals, or technical details.
- Do NOT explain how the query works.
- Use the user's own words when referring to their question.
- Include any mandatory disclaimers provided in the context.
- Return ONLY the explanation text — no JSON, no markdown fences, no prefix.

GOOD examples:
- "Annual murder counts for New York City and Los Angeles from 1985 to 2024. Note: Direct comparisons between agencies should be interpreted with caution."
- "Monthly robbery counts for Chicago from 2020 to 2025."
- "National burglary trend by year from 1960 to 2023."

BAD examples (NEVER write these):
- "Since 1985, New York City has consistently recorded higher murder counts than Los Angeles."
- "Murder counts peaked at 1,905 in 1989 before declining sharply."
- "The data shows robbery in Chicago ranging from 800 to 1,200 per month."`;

/**
 * Generate a post-query explanation given the question, results summary, and disclaimers.
 * Returns the explanation string, or falls back to the pre-query explanation on error.
 */
export async function generateExplanation(opts: {
  question: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  disclaimers: string;
  preQueryExplanation: string;
  tab: "current" | "historical" | "nibrs";
}): Promise<string> {
  const { question, columns, rows, rowCount, disclaimers, preQueryExplanation, tab } = opts;

  // Build a compact results summary (first 5 + last row to capture full range)
  const sampleRows = rows.slice(0, 5);
  const lastRow = rowCount > 5 ? rows[rowCount - 1] : null;
  let resultsSummary: string;
  if (sampleRows.length > 0) {
    let summary = `Columns: ${columns.join(", ")}\nFirst ${sampleRows.length} of ${rowCount} rows:\n${sampleRows.map(r => columns.map(c => `${c}=${r[c]}`).join(", ")).join("\n")}`;
    if (lastRow) {
      summary += `\nLast row (row ${rowCount}):\n${columns.map(c => `${c}=${lastRow[c]}`).join(", ")}`;
    }
    resultsSummary = summary;
  } else {
    resultsSummary = "Query returned 0 rows.";
  }

  // Tab-specific context for disclaimers
  let tabContext = "";
  if (tab === "current") {
    tabContext = "This is RTCI (Real-Time Crime Index) data from a sample of agencies — not every U.S. city. If the query uses the national sample, note it reflects consistent reporters only.";
  } else if (tab === "historical") {
    tabContext = "This is FBI UCR historical data. If pre-1960, note limited agency coverage.";
  } else if (tab === "nibrs") {
    tabContext = "This is FBI NIBRS data. Do NOT add any disclaimers about NIBRS coverage, reporting, or data completeness — a standard disclaimer is appended automatically by the server.";
  }

  // Date range gap detection: warn if actual data starts much later than requested
  let dateGapDisclaimer = "";
  if (tab === "nibrs" && rows.length > 0) {
    const startYearMatch = question.match(/(?:since|from|starting|beginning)\s+(\d{4})/i)
      || question.match(/(\d{4})\s*(?:to|through|-)\s*\d{4}/i);
    if (startYearMatch) {
      const requestedYear = parseInt(startYearMatch[1]);
      // Find earliest year in results
      const firstRow = rows[0] as Record<string, unknown>;
      const actualYearRaw = firstRow.year ?? firstRow.data_year ?? firstRow.Year;
      const actualYear = typeof actualYearRaw === 'number' ? actualYearRaw : typeof actualYearRaw === 'string' ? parseInt(actualYearRaw) : NaN;
      if (!isNaN(actualYear) && actualYear > requestedYear + 1) {
        dateGapDisclaimer = `The user requested data from ${requestedYear} but the earliest data returned is from ${actualYear}. You MUST mention this gap.`;
      }
    }
  }

  const allDisclaimers = [disclaimers, dateGapDisclaimer].filter(Boolean).join("\n");

  const userPrompt = `User question: "${question}"

Query returned ${rowCount} row${rowCount !== 1 ? "s" : ""}.
${resultsSummary}

Tab context: ${tabContext}
${allDisclaimers ? `Mandatory disclaimers to include:\n${allDisclaimers}` : ""}

Write a brief explanation describing what these results contain (time range, geography, metric). Do not describe what the data shows.`;

  try {
    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
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
