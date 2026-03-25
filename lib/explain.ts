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
- State what the data shows factually. You may reference specific numbers from the results provided.
- NEVER be analytical. No trend descriptions, no interpretive commentary, no "this suggests...", no causal language.
- BANNED PHRASES: "may reflect", "likely due to", "could be attributed to", "suggests that", "driven by", "as a result of", "because of".
- Do NOT mention SQL, table names, database internals, or technical details.
- Do NOT explain how the query works.
- Use the user's own words when referring to their question.
- Include any mandatory disclaimers provided in the context.
- Return ONLY the explanation text — no JSON, no markdown fences, no prefix.`;

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

  // Build a compact results summary (first 5 rows max)
  const sampleRows = rows.slice(0, 5);
  const resultsSummary = sampleRows.length > 0
    ? `Columns: ${columns.join(", ")}\nFirst ${sampleRows.length} of ${rowCount} rows:\n${sampleRows.map(r => columns.map(c => `${c}=${r[c]}`).join(", ")).join("\n")}`
    : "Query returned 0 rows.";

  // Tab-specific context for disclaimers
  let tabContext = "";
  if (tab === "current") {
    tabContext = "This is RTCI (Real-Time Crime Index) data from a sample of agencies — not every U.S. city. If the query uses the national sample, note it reflects consistent reporters only.";
  } else if (tab === "historical") {
    tabContext = "This is FBI UCR historical data. If pre-1960, note limited agency coverage.";
  } else if (tab === "nibrs") {
    tabContext = "This is FBI NIBRS data. Not all agencies report to NIBRS. If national/state level, note that NIBRS coverage varies by year.";
  }

  const userPrompt = `User question: "${question}"

Query returned ${rowCount} row${rowCount !== 1 ? "s" : ""}.
${resultsSummary}

Tab context: ${tabContext}
${disclaimers ? `Mandatory disclaimers to include:\n${disclaimers}` : ""}

Write a brief explanation of these results.`;

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
