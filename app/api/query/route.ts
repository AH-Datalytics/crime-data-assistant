import { NextRequest } from "next/server";
import { getDb, logQuery } from "@/lib/rtci-db";
import { validatePageToken } from "@/lib/page-token";
import { translateToSql, getHistoricalSystemPrompt } from "@/lib/claude";
import { validateAndSanitize } from "@/lib/sql-safety";
import { executeWithTimeoutSync } from "@/lib/query-timeout";
import { buildChartConfig } from "@/lib/chart-config";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkSessionLimit, maybeCleanup } from "@/lib/captcha";
import { RTCI } from "@/lib/dynamic-facts";
import { generateExplanation, sanitizeExplanation } from "@/lib/explain";
import { extractQueryContext } from "@/lib/query-context";
import { runGuardrails } from "@/lib/guardrails";
import { applyRetryMeta } from "@/lib/types";
import type { StreamEvent, ChartMeta } from "@/lib/types";
import { getCached, setCache } from "@/lib/response-cache";
import { detectAllNullData } from "@/lib/all-null-detection";
import { checkSingleRowTrend } from "@/lib/single-row-trend";
import { parseRoutingLogMeta } from "@/lib/routing-log-meta";
import { answerMetadataQuestion } from "@/lib/metadata-coverage";
import { validateTablesForTab } from "@/lib/table-allowlist";
import { applyResultDisclosures } from "@/lib/result-disclosure";
import { normalizeHistoryForTab } from "@/lib/chat-history";
import { detectFollowupTransform } from "@/lib/followup-transform";
import { getBlockingGeoClarification } from "@/lib/geo-resolver";

function sseEvent(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
import {
  containsInternalScaffold,
  stripInternalScaffold,
} from "@/lib/scaffold-helpers";

/** Try to extract agency name from SQL WHERE clause */
function extractAgencyName(sql: string): string | null {
  const match = sql.match(/agency\s*=\s*'([^']+)'/i);
  return match ? match[1] : null;
}

/** Extract chart metadata (agency count) based on the SQL query */
function getChartMeta(
  db: ReturnType<typeof getDb>,
  sql: string
): ChartMeta | null {
  try {
    const sqlLower = sql.toLowerCase();

    // Extract a year for population lookup
    const yearMatches = sql.match(/\byear\s*(?:=|>=)\s*(\d{4})/gi);
    let popYear = RTCI.maxYear - 1;
    if (yearMatches) {
      const years = yearMatches.map((m) => parseInt(m.match(/\d{4}/)![0], 10));
      popYear = Math.max(...years);
    }
    if (popYear > RTCI.popMaxYear) popYear = RTCI.popMaxYear;
    if (popYear < RTCI.popMinYear) popYear = RTCI.popMinYear;

    // National queries — use agency_count from the most recent completed month
    if (sqlLower.includes("national_monthly")) {
      const row = db
        .prepare(
          `SELECT agency_count as cnt FROM national_monthly
           WHERE offense = 'Murder'
           ORDER BY year DESC, month DESC
           LIMIT 1`
        )
        .get() as { cnt: number } | undefined;
      const popRow = db
        .prepare(
          `SELECT SUM(p.population) as pop FROM agency_population p
           JOIN sample_agencies sa ON sa.ori = p.ori
           WHERE p.year = ?`
        )
        .get(popYear) as { pop: number | null } | undefined;
      return { agencyCount: row?.cnt ?? 0, population: popRow?.pop ?? null };
    }

    // State queries — count only complete reporters (national_sample = 1)
    const stateMatch = sql.match(/(?:a\.)?state\s*=\s*'([A-Z]{2})'/i);
    const isStateLevelQuery = stateMatch && (
      sqlLower.includes("state_monthly") ||
      (sqlLower.includes("national_sample") && !sqlLower.includes("agency ="))
    );
    if (isStateLevelQuery && stateMatch) {
      const st = stateMatch[1].toUpperCase();
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT a.ori) as cnt, SUM(p.population) as pop
           FROM agencies a
           LEFT JOIN agency_population p ON p.ori = a.ori AND p.year = ?
           WHERE a.state = ? AND a.national_sample = 1`
        )
        .get(popYear, st) as { cnt: number; pop: number | null };
      return { agencyCount: row.cnt, population: row.pop };
    }

    // Specific agency queries — extract all agency='X' AND state='Y' pairs
    const agencyPairs: { agency: string; state: string }[] = [];
    const pairRe =
      /agency\s*=\s*'([^']+)'\s+AND\s+(?:\w+\.)?state\s*=\s*'([A-Z]{2})'/gi;
    let m;
    while ((m = pairRe.exec(sql)) !== null) {
      agencyPairs.push({ agency: m[1], state: m[2] });
    }
    if (agencyPairs.length > 0) {
      const placeholders = agencyPairs
        .map(() => "(a.agency = ? AND a.state = ?)")
        .join(" OR ");
      const params: (string | number)[] = [popYear];
      for (const p of agencyPairs) {
        params.push(p.agency, p.state);
      }
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT a.ori) as cnt, SUM(p.population) as pop
           FROM agencies a
           LEFT JOIN agency_population p ON p.ori = a.ori AND p.year = ?
           WHERE ${placeholders}`
        )
        .get(...params) as { cnt: number; pop: number | null };
      return { agencyCount: row.cnt, population: row.pop };
    }

    // Try to extract agency names without paired state (e.g., agency = 'Kansas City')
    if (sqlLower.includes("agency_monthly")) {
      const agencyOnlyRe = /agency\s*=\s*'([^']+)'/gi;
      const agencies: string[] = [];
      let am;
      while ((am = agencyOnlyRe.exec(sql)) !== null) {
        agencies.push(am[1]);
      }
      if (agencies.length > 0) {
        // Detect if the query filters by type (City/County) and mirror it in the meta query
        const typeMatch = sql.match(/type\s*=\s*'(City|County)'/i);
        const typeFilter = typeMatch ? `AND a.type = '${typeMatch[1]}'` : "";
        const placeholders = agencies.map(() => "a.agency = ?").join(" OR ");
        const params: (string | number)[] = [popYear, ...agencies];
        const row = db
          .prepare(
            `SELECT COUNT(DISTINCT a.ori) as cnt, SUM(p.population) as pop
             FROM agencies a
             LEFT JOIN agency_population p ON p.ori = a.ori AND p.year = ?
             WHERE (${placeholders}) ${typeFilter}`
          )
          .get(...params) as { cnt: number; pop: number | null };
        return { agencyCount: row.cnt, population: row.pop };
      }

      // State-level fallback only if no agencies found
      if (stateMatch) {
        const st = stateMatch[1].toUpperCase();
        const row = db
          .prepare(
            `SELECT COUNT(DISTINCT a.ori) as cnt, SUM(p.population) as pop
             FROM agencies a
             LEFT JOIN agency_population p ON p.ori = a.ori AND p.year = ?
             WHERE a.state = ?`
          )
          .get(popYear, st) as { cnt: number; pop: number | null };
        return { agencyCount: row.cnt, population: row.pop };
      }
    }

    return null;
  } catch {
    return null;
  }
}
/** Extract chart metadata for historical queries */
function getHistoricalChartMeta(
  db: ReturnType<typeof getDb>,
  sql: string
): ChartMeta | null {
  try {
    const sqlLower = sql.toLowerCase();

    const src = "FBI SRS";

    // National queries (state = 'United States')
    if (sqlLower.includes("'united states'")) {
      return { agencyCount: 0, population: null, source: src };
    }

    // State-level queries from historical_state_national
    if (sqlLower.includes("historical_state_national")) {
      return { agencyCount: 0, population: null, source: src };
    }

    // Staffing queries are Historical Library / FBI SRS too.
    if (sqlLower.includes("historical_staffing")) {
      return { agencyCount: 0, population: null, source: src };
    }

    // Agency-level queries — count distinct agencies
    if (sqlLower.includes("historical_agency_crime")) {
      const agencyRe = /ha\.agency\s*=\s*'([^']+)'/gi;
      const agencies: string[] = [];
      let m;
      while ((m = agencyRe.exec(sql)) !== null) {
        agencies.push(m[1]);
      }
      // If no specific agency names matched (e.g., state-wide query), show 0 (omits agency count)
      return { agencyCount: agencies.length, population: null, source: src };
    }

    return { agencyCount: 0, population: null, source: src };
  } catch {
    return null;
  }
}

/** Check if an agency exists in the dataset, return suggestions */
function findSimilarAgencies(
  db: ReturnType<typeof getDb>,
  name: string,
  historical = false
): { agency: string; state: string }[] {
  try {
    const table = historical ? "historical_agency" : "agencies";
    return db
      .prepare(
        `SELECT DISTINCT agency, state FROM ${table} WHERE agency LIKE ? LIMIT 5`
      )
      .all(`%${name}%`) as { agency: string; state: string }[];
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const totalStart = Date.now();
  const MAX_REQUEST_MS = 60000; // 60s total budget — no retries after this
  const isOverBudget = () => Date.now() - totalStart > MAX_REQUEST_MS;

  // Rate limiting
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    const retryAfter = Math.ceil((rateCheck.retryAfterMs || 60000) / 1000);
    return new Response(
      JSON.stringify({
        success: false,
        error: `Too many requests. Please wait ${retryAfter} seconds and try again.`,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
        },
      }
    );
  }

  let question = "";
  let sessionId: string | null = null;
  let body: Record<string, unknown>;

  try {
    body = await req.json();
    question = (body?.question as string)?.trim() || "";
    sessionId = ((body?.sessionId as string) || "").slice(0, 64) || null;
    // Page token validation — block bots that hit the API directly
    const pageToken = body?.pageToken as string | undefined;
    if (!validatePageToken(pageToken)) {
      return new Response(
        JSON.stringify({ success: false, error: "Please refresh the page and try again." }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Session-based CAPTCHA throttle
    maybeCleanup();
    const captchaCheck = checkSessionLimit(sessionId);
    if (!captchaCheck.allowed) {
      if (captchaCheck.dailyLimitReached) {
        return new Response(
          JSON.stringify({ success: false, error: "You've reached the daily query limit. Please come back tomorrow." }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ success: false, captchaRequired: true }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      );
    }
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid request" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!question || typeof question !== "string") {
    return new Response(
      JSON.stringify({ success: false, error: "Please provide a question" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (question.length > 2000) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Question too long (max 2,000 characters)",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const routingMeta = parseRoutingLogMeta(body);
  const writeLog = (
    q: string,
    sqlText: string | null,
    rowCount: number,
    logError: string | null,
    ms: number,
    logResponse: string | null = null,
    tabName: string = "current",
    guardrails: string[] = [],
    model: string | null = null,
    sid: string | null = null
  ) => logQuery(q, sqlText, rowCount, logError, ms, logResponse, tabName, guardrails, model, sid, routingMeta);

  const tab = body?.mode === "historical" ? "historical" : "current";
  const geoClarification = getBlockingGeoClarification(question);
  if (geoClarification) {
    const ms = Date.now() - totalStart;
    writeLog(question, null, 0, null, ms, geoClarification.explanation, tab, [`geo:${geoClarification.issue.id}`], "deterministic", sessionId);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent({
              type: "result",
              sql: null as unknown as string,
              explanation: geoClarification.explanation,
              title: "",
              columns: [],
              rows: [],
              rowCount: 0,
              truncated: false,
              chartConfig: null,
              chartMeta: null,
              executionTimeMs: ms,
            })
          )
        );
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-RateLimit-Remaining": String(rateCheck.remaining),
      },
    });
  }

  const metadata = answerMetadataQuestion(tab, question, getDb());
  if (metadata) {
    const ms = Date.now() - totalStart;
    writeLog(question, metadata.sql, metadata.rowCount, null, ms, metadata.explanation, tab, ["deterministic-metadata"], "deterministic", sessionId);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent({
              type: "result",
              sql: metadata.sql,
              explanation: metadata.explanation,
              title: metadata.title,
              columns: metadata.columns,
              rows: metadata.rows,
              rowCount: metadata.rowCount,
              truncated: metadata.truncated,
              chartConfig: metadata.chartConfig,
              chartMeta: metadata.chartMeta,
              executionTimeMs: ms,
            })
          )
        );
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-RateLimit-Remaining": String(rateCheck.remaining),
      },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      let sql: string | null = null;
      let firedGuardrails: string[] = [];
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      try {
        // Step 1: Translate to SQL via Claude
        controller.enqueue(
          encoder.encode(
            sseEvent({ type: "status", text: "Analyzing your question..." })
          )
        );

        const isHistorical = body?.mode === "historical";
        const history = normalizeHistoryForTab(body?.history, isHistorical ? "historical" : "current");
        const followupTransform = detectFollowupTransform(question, history);
        const promptHistory = followupTransform
          ? [...history, { role: "user" as const, content: followupTransform.instruction }]
          : history;
        const systemPrompt = isHistorical ? getHistoricalSystemPrompt() : undefined;

        // Check response cache (only standalone questions)
        const cached = promptHistory.length === 0 ? getCached(question, tab) : null;
        let fromCache = false;

        let claude: Awaited<ReturnType<typeof translateToSql>>;

        if (cached) {
          claude = { sql: cached.sql, explanation: cached.explanation, title: cached.title || "", chartHint: (cached.chartType as "bar" | "line" | "pie" | "stacked_bar" | "scatter" | "none") || "none", xAxis: cached.xAxis || "", yAxis: cached.yAxis?.join(",") || "", colors: cached.colors as string[] | undefined, yAxisLabel: cached.yAxisLabel, xAxisLabel: cached.xAxisLabel, annotations: cached.annotations as typeof claude.annotations };
          fromCache = true;
        } else {
          claude = await translateToSql(
            question,
            promptHistory as { role: "user" | "assistant"; content: string }[],
            systemPrompt
          );

          if (!claude.sql && !isOverBudget()) {
            // Retry if model incorrectly claims data isn't available
            const refusalPatterns = /not (appear|be represented)|doesn't appear|not (in|included in) (this|the|our) (dataset|data|sample|library)|no data (for|available|found)|does not (have|include|cover)|not available in this|isn't (in|included)|not found in/i;
            if (refusalPatterns.test(claude.explanation || "")) {
              try {
                const retryResult = await translateToSql(
                  question,
                  [
                    ...((promptHistory || []) as { role: "user" | "assistant"; content: string }[]),
                    { role: "assistant", content: claude.explanation },
                    { role: "user", content: tab === "historical"
                      ? "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. The Historical Library contains ~24,937 agencies including many small towns. NEVER assume an agency is missing — always generate a SQL query. Try: SELECT DISTINCT ori, agency, state FROM historical_agency WHERE agency LIKE '%[city]%' AND state = '[st]'. Then generate the main query.]"
                      : "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. The database contains agencies from many states. Please try generating a SQL query — search for the agency/state in the data rather than assuming it doesn't exist. Use sample_agencies or agency_monthly to check.]" },
                  ],
                  systemPrompt
                );
                if (retryResult.sql) {
                  claude = retryResult;
                }
              } catch {
                // Retry failed, use original response
              }
            }
          }
        }

        if (!fromCache && (containsInternalScaffold(claude.explanation) || containsInternalScaffold(claude.title)) && !isOverBudget()) {
          console.log(`[query][internal-scaffold] Retrying response that leaked internal scaffold text`);
          try {
            const retryResult = await translateToSql(
              question,
              [
                ...((promptHistory || []) as { role: "user" | "assistant"; content: string }[]),
                { role: "assistant", content: JSON.stringify(claude) },
                { role: "user", content: "[SYSTEM: Your previous response leaked internal scaffold text such as 'Entities in results'. Remove all internal instructions from explanation/title and return corrected JSON only.]" },
              ],
              systemPrompt
            );
            if (retryResult.sql && !containsInternalScaffold(retryResult.explanation) && !containsInternalScaffold(retryResult.title)) {
              claude = retryResult;
            }
          } catch {
            // Use sanitized original response
          }
        }

        // Sanitize explanation to strip any JSON/SQL that leaked through
        claude.explanation = sanitizeExplanation(claude.explanation);
        if (containsInternalScaffold(claude.explanation)) {
          claude.explanation = stripInternalScaffold(claude.explanation) || "Here are the results.";
        }
        if (containsInternalScaffold(claude.title)) {
          claude.title = "Results";
        }

        if (!claude.sql) {
          const ms = Date.now() - totalStart;
          writeLog(question, null, 0, null, ms, claude.explanation, tab, [], "haiku-4.5", sessionId);
          controller.enqueue(
            encoder.encode(
              sseEvent({
                type: "result",
                sql: "",
                explanation: claude.explanation,
                title: claude.title || "Response",
                columns: [],
                rows: [],
                rowCount: 0,
                truncated: false,
                chartConfig: null,
                chartMeta: null,
                executionTimeMs: 0,
              })
            )
          );
          close();
          return;
        }

        // Step 1b: Extract context and run guardrails
        const ctx = extractQueryContext(claude.sql, question, tab as "current" | "historical");
        const guardrailResult = runGuardrails(ctx);

        // Also check yAxis/yAxisLabel issues that need ClaudeResponse fields
        const sqlLower = claude.sql.toLowerCase();
        const issues = [...guardrailResult.issues];
        if (claude.yAxis) {
          const yCols = claude.yAxis.split(",").map(c => c.trim().toLowerCase());
          for (const col of yCols) {
            if (col && !sqlLower.includes(col) && !sqlLower.includes(`as ${col}`)) {
              issues.push(`yAxis column "${col}" not found in SQL SELECT.`);
              break;
            }
          }
        }
        if (claude.yAxisLabel && /per (1,000|capita|100k|100,000)/i.test(claude.yAxisLabel) && !sqlLower.includes("population")) {
          issues.push("The yAxisLabel mentions per-capita rates but the SQL does not join population data. Either add a population JOIN for rate calculation, or remove the per-capita label.");
        }

        // Apply auto-rewrites from guardrails
        if (guardrailResult.sql !== claude.sql) {
          claude.sql = guardrailResult.sql;
        }

        firedGuardrails = guardrailResult.fired;
        if (firedGuardrails.length > 0) {
          console.log(`[guardrails] Fired: ${firedGuardrails.join(", ")}`);
        }

        // Hard override — skip retry, return deterministic response
        if (guardrailResult.overrideResponse) {
          const overrideExplanation = guardrailResult.overrideResponse;
          writeLog(question, sql, 0, `guardrail_override:${guardrailResult.overrideGuardrail}`, Date.now() - totalStart, overrideExplanation, tab, firedGuardrails, "haiku-4.5", sessionId);
          controller.enqueue(
            encoder.encode(
              sseEvent({
                type: "result",
                sql: null as unknown as string,
                explanation: overrideExplanation,
                title: "",
                columns: [],
                rows: [],
                rowCount: 0,
                truncated: false,
                chartConfig: null,
                chartMeta: null,
                executionTimeMs: Date.now() - totalStart,
              })
            )
          );
          close();
          return;
        }

        // If issues found, ask Claude to fix (if budget allows)
        if (issues.length > 0 && !isOverBudget()) {
          controller.enqueue(
            encoder.encode(
              sseEvent({ type: "status", text: "Refining query..." })
            )
          );
          const fixPrompt = `Your SQL has these issues:\n${issues.map(i => `- ${i}`).join("\n")}\n\nPlease fix the SQL and return corrected JSON.`;
          const fixHistory = [
            ...(promptHistory || []),
            { role: "user" as const, content: question },
            { role: "assistant" as const, content: JSON.stringify(claude) },
            { role: "user" as const, content: fixPrompt },
          ];
          const fixed = await translateToSql(fixPrompt, fixHistory, systemPrompt);
          if (fixed.sql) {
            claude.sql = fixed.sql;
            applyRetryMeta(claude, fixed);
          }
        }

        // Post-retry guardrail re-check
        {
          const postRetryCtx = extractQueryContext(claude.sql, question, tab as "current" | "historical");
          const postRetryResult = runGuardrails(postRetryCtx);
          if (postRetryResult.overrideResponse) {
            writeLog(question, claude.sql, 0, `guardrail_override:${postRetryResult.overrideGuardrail}`, Date.now() - totalStart, postRetryResult.overrideResponse, tab, postRetryResult.fired, "haiku-4.5", sessionId);
            controller.enqueue(encoder.encode(sseEvent({ type: "result", sql: null as unknown as string, explanation: postRetryResult.overrideResponse, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart })));
            close(); return;
          }
          const rateStillBad = postRetryResult.fired.some(f => f.includes("rate-no-population"));
          if (rateStillBad && /\b(rates?|per\s*capita|per\s*100)/i.test(question) && !/\b(not rates?|raw|counts?\s+not\s+rates?)\b/i.test(question)) {
            const msg = "I wasn't able to calculate a valid per-capita rate for this query. Try asking for raw counts, or use the [Historical Library](/test?tab=historical) tab for state/national rates.";
            writeLog(question, claude.sql, 0, "rate_second_failure", Date.now() - totalStart, msg, tab, postRetryResult.fired, "haiku-4.5", sessionId);
            controller.enqueue(encoder.encode(sseEvent({ type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart })));
            close(); return;
          }
          // Geography contract: block if city/county-got-state or geography-missing still fires after retry
          const geoContractViolation = postRetryResult.fired.some(f =>
            f === "historical-city-got-state" || f === "historical-county-got-state" || f === "contract-geography-missing"
          );
          if (geoContractViolation) {
            const msg = "I couldn't build a reliable query for that specific geography. The data may be available under a different agency name — try searching for the county sheriff or a specific city within the county.";
            writeLog(question, claude.sql, 0, "geography_second_failure", Date.now() - totalStart, msg, tab, postRetryResult.fired, "haiku-4.5", sessionId);
            controller.enqueue(encoder.encode(sseEvent({ type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart })));
            close(); return;
          }
          if (postRetryResult.sql !== claude.sql) claude.sql = postRetryResult.sql;
        }

        controller.enqueue(
          encoder.encode(
            sseEvent({ type: "status", text: "Running query..." })
          )
        );

        // Step 2: Validate SQL
        const maxLimit = 5000;
        const validation = validateAndSanitize(claude.sql, { maxLimit });
        if (!validation.valid) {
          const ms = Date.now() - totalStart;
          writeLog(
            question,
            claude.sql,
            0,
            `Validation: ${validation.error}`,
            ms,
            null,
            tab,
            firedGuardrails,
            "haiku-4.5",
            sessionId
          );
          controller.enqueue(
            encoder.encode(
              sseEvent({
                type: "error",
                text: "I had trouble generating a valid query for that question. Try rephrasing it.",
                sql: claude.sql,
              })
            )
          );
          close();
          return;
        }

        sql = validation.sanitized!;

        {
          const tableCheck = validateTablesForTab(sql, tab, getDb());
          if (!tableCheck.ok) {
            firedGuardrails = [...firedGuardrails, ...tableCheck.fired];
            if (!isOverBudget()) {
              controller.enqueue(
                encoder.encode(
                  sseEvent({ type: "status", text: "Switching to the right tables..." })
                )
              );
              const retryHistory = [
                ...(promptHistory || []),
                { role: "user" as const, content: question },
                { role: "assistant" as const, content: JSON.stringify({ ...claude, sql }) },
                { role: "user" as const, content: `[SYSTEM: ${tableCheck.message}]` },
              ];
              const retry = await translateToSql(tableCheck.message, retryHistory, systemPrompt);
              if (retry.sql) {
                const retryValidation = validateAndSanitize(retry.sql, { maxLimit });
                if (retryValidation.valid) {
                  const retrySql = retryValidation.sanitized!;
                  const retryTableCheck = validateTablesForTab(retrySql, tab, getDb());
                  if (retryTableCheck.ok) {
                    sql = retrySql;
                    applyRetryMeta(claude, retry);
                  } else {
                    const msg = "I couldn't build a valid query for this data source. Try switching tabs or rephrasing the question for the active dataset.";
                    writeLog(question, retrySql, 0, `table_allowlist_second_failure:${retryTableCheck.unknown.join(",")}`, Date.now() - totalStart, msg, tab, [...firedGuardrails, ...retryTableCheck.fired], "haiku-4.5", sessionId);
                    controller.enqueue(encoder.encode(sseEvent({ type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart })));
                    close();
                    return;
                  }
                }
              }
            }

            const msg = "I couldn't build a valid query for this data source. Try switching tabs or rephrasing the question for the active dataset.";
            writeLog(question, sql, 0, `table_allowlist:${tableCheck.unknown.join(",")}`, Date.now() - totalStart, msg, tab, firedGuardrails, "haiku-4.5", sessionId);
            controller.enqueue(encoder.encode(sseEvent({ type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart })));
            close();
            return;
          }
        }

        // Step 3: Execute SQL (with one retry on DB error)
        const db = getDb();
        const dbStart = Date.now();

        let rows: Record<string, unknown>[];
        let columns: string[];

        try {
          const stmt = db.prepare(sql);
          const result = executeWithTimeoutSync<Record<string, unknown>>(db, stmt, 30000);
          columns = stmt.columns().map((c) => c.name);
          rows = result;
        } catch (dbErr) {
          const msg =
            dbErr instanceof Error ? dbErr.message : String(dbErr);
          // Retry: tell Claude about the error and ask for a corrected query (if budget allows)
          if (isOverBudget()) {
            const ms = Date.now() - totalStart;
            writeLog(question, sql, 0, `DB: ${msg} (over budget)`, ms, null, tab, firedGuardrails, "haiku-4.5", sessionId);
            controller.enqueue(encoder.encode(sseEvent({ type: "error", text: "That query took too long. Try simplifying your question." })));
            close();
            return;
          }
          controller.enqueue(
            encoder.encode(
              sseEvent({ type: "status", text: "Retrying with corrected query..." })
            )
          );
          const retryHistory = [
            ...(promptHistory || []),
            { role: "user" as const, content: question },
            {
              role: "assistant" as const,
              content: JSON.stringify(claude),
            },
            {
              role: "user" as const,
              content: `That SQL failed with error: ${msg}. Please fix the query and try again.`,
            },
          ];
          const retry = await translateToSql(
            `Fix this SQL error: ${msg}`,
            retryHistory,
            systemPrompt
          );
          if (retry.sql) {
            const retryValidation = validateAndSanitize(retry.sql, { maxLimit });
            if (retryValidation.valid) {
              try {
                const retryStmt = db.prepare(retryValidation.sanitized!);
                const retryResult = executeWithTimeoutSync<Record<string, unknown>>(db, retryStmt, 30000);
                columns = retryStmt.columns().map((c) => c.name);
                rows = retryResult;
                sql = retryValidation.sanitized!;
                applyRetryMeta(claude, retry);
              } catch (retryErr) {
                const retryMsg =
                  retryErr instanceof Error
                    ? retryErr.message
                    : String(retryErr);
                const ms = Date.now() - totalStart;
                writeLog(
                  question,
                  sql,
                  0,
                  `DB retry failed: ${retryMsg}`,
                  ms,
                  null,
                  tab,
                  firedGuardrails,
                  "haiku-4.5",
                  sessionId
                );
                controller.enqueue(
                  encoder.encode(
                    sseEvent({
                      type: "error",
                      text: "I had trouble running that query. Try rephrasing your question or asking about a different topic.",
                    })
                  )
                );
                close();
                return;
              }
            } else {
              const ms = Date.now() - totalStart;
              writeLog(
                question,
                sql,
                0,
                `DB: ${msg} (retry validation failed)`,
                ms,
                null,
                tab,
                firedGuardrails,
                "haiku-4.5",
                sessionId
              );
              controller.enqueue(
                encoder.encode(
                  sseEvent({
                    type: "error",
                    text: "I had trouble running that query. Try rephrasing your question or asking about a different topic.",
                  })
                )
              );
              close();
              return;
            }
          } else {
            const ms = Date.now() - totalStart;
            writeLog(question, sql, 0, `DB: ${msg}`, ms, null, tab, firedGuardrails, "haiku-4.5", sessionId);
            controller.enqueue(
              encoder.encode(
                sseEvent({
                  type: "error",
                  text: "I had trouble running that query. Try rephrasing your question or asking about a different topic.",
                })
              )
            );
            close();
            return;
          }
        }

        const totalMs = Date.now() - totalStart;
        const executionTimeMs = totalMs;  // show total wall time (includes Claude API + DB)

        // Step 4: Handle empty results
        if (rows.length === 0) {
          const agencyName = extractAgencyName(sql);
          let emptyMsg: string;

          if (agencyName) {
            const similar = findSimilarAgencies(db, agencyName, isHistorical);
            if (similar.length === 0) {
              emptyMsg = isHistorical
                ? `"${agencyName}" is not in our dataset. Try the [NIBRS](/test?tab=nibrs) tab, which has incident-level data from agencies nationwide, or the [Current Trends](/test?tab=current) tab for monthly data from ~${RTCI.agencyCount} major agencies.`
                : `"${agencyName}" is not in our dataset of ~${RTCI.agencyCount} agencies. Try the [Historical Library](/test?tab=historical) tab for annual data covering more agencies back to the 1930s, or the [NIBRS](/test?tab=nibrs) tab for incident-level data from agencies nationwide.`;
            } else {
              const exactMatch = similar.find(
                (s) =>
                  s.agency.toLowerCase() === agencyName.toLowerCase()
              );
              if (exactMatch) {
                // Query which offenses this agency actually reports
                try {
                  let offenseList = "";
                  if (isHistorical) {
                    // Historical uses separate columns per offense in historical_agency_crime
                    const row = db
                      .prepare(
                        `SELECT
                           MAX(CASE WHEN murder > 0 THEN 1 ELSE 0 END) as has_murder,
                           MAX(CASE WHEN rape > 0 THEN 1 ELSE 0 END) as has_rape,
                           MAX(CASE WHEN robbery > 0 THEN 1 ELSE 0 END) as has_robbery,
                           MAX(CASE WHEN assault > 0 THEN 1 ELSE 0 END) as has_assault,
                           MAX(CASE WHEN burglary > 0 THEN 1 ELSE 0 END) as has_burglary,
                           MAX(CASE WHEN theft > 0 THEN 1 ELSE 0 END) as has_theft,
                           MAX(CASE WHEN motor_vehicle_theft > 0 THEN 1 ELSE 0 END) as has_mvt
                         FROM historical_agency_crime hac
                         JOIN historical_agency ha ON ha.ori = hac.ori
                         WHERE ha.agency = ? AND ha.state = ?`
                      )
                      .get(exactMatch.agency, exactMatch.state.toLowerCase()) as Record<string, number> | undefined;
                    if (row) {
                      const names: string[] = [];
                      if (row.has_murder) names.push("Murder");
                      if (row.has_rape) names.push("Rape");
                      if (row.has_robbery) names.push("Robbery");
                      if (row.has_assault) names.push("Aggravated Assault");
                      if (row.has_burglary) names.push("Burglary");
                      if (row.has_theft) names.push("Theft");
                      if (row.has_mvt) names.push("Motor Vehicle Theft");
                      if (names.length > 0) offenseList = names.join(", ");
                    }
                  } else {
                    const availableOffenses = db
                      .prepare(
                        `SELECT DISTINCT offense FROM agency_monthly
                         WHERE agency = ? AND state = ? AND count > 0
                         ORDER BY offense`
                      )
                      .all(exactMatch.agency, exactMatch.state) as { offense: string }[];
                    if (availableOffenses.length > 0) {
                      offenseList = availableOffenses.map((o) => o.offense).join(", ");
                    }
                  }
                  if (offenseList) {
                    emptyMsg = `${exactMatch.agency}, ${exactMatch.state.toUpperCase()} is in our dataset, but no data was found for that specific query. This agency reports the following offenses: ${offenseList}. Try one of those instead, or adjust the date range.`;
                  } else {
                    emptyMsg = `${exactMatch.agency}, ${exactMatch.state.toUpperCase()} is in our dataset, but no data was found for that specific query. The agency may not report this offense, or the date range may not have data. Try a different offense or broader date range.`;
                  }
                } catch {
                  emptyMsg = `${exactMatch.agency}, ${exactMatch.state.toUpperCase()} is in our dataset, but no data was found for that specific query. The agency may not report this offense, or the date range may not have data. Try a different offense or broader date range.`;
                }
              } else {
                const suggestions = similar
                  .map((s) => `${s.agency}, ${s.state.toUpperCase()}`)
                  .join("; ");
                emptyMsg = `"${agencyName}" wasn't found in our dataset. Did you mean: ${suggestions}? Our data covers ~${RTCI.agencyCount} major agencies across ${RTCI.stateCount} states.`;
              }
            }
          } else {
            emptyMsg =
              "This query returned no results. The data may not be available for the specified criteria. Try broadening your search or asking about a different topic.";
          }

          writeLog(question, sql, 0, "empty_result", totalMs, emptyMsg, tab, firedGuardrails, "haiku-4.5", sessionId);
          controller.enqueue(
            encoder.encode(
              sseEvent({
                type: "result",
                sql,
                explanation: emptyMsg,
                title: claude.title || "No Results",
                columns,
                rows: [],
                rowCount: 0,
                truncated: false,
                chartConfig: null,
                chartMeta: null,
                executionTimeMs,
              })
            )
          );
          close();
          return;
        }

        // Step 4b: Auto-pivot long-format multi-agency data for charting
        // Detects rows like (year, [month,] agency, total) and pivots to (year, [month,] city1, city2, ...)
        const agencyCol = columns.find(
          (c) => c === "agency" || c === "agency_name" || c === "city"
        );
        const valueCol = columns.find(
          (c) =>
            c !== "agency" &&
            c !== "agency_name" &&
            c !== "city" &&
            c !== "year" &&
            c !== "month" &&
            typeof rows[0]?.[c] === "number"
        );
        const hasYear = columns.includes("year");

        // Skip auto-pivot for ranking queries (ORDER BY ... DESC LIMIT)
        // Those are intentionally long-format listings, not comparisons
        // Only check the LAST ORDER BY to avoid matching inside CTEs/subqueries
        const lastOrderBy = sql.lastIndexOf("ORDER BY") !== -1
          ? sql.slice(sql.lastIndexOf("ORDER BY"))
          : "";
        const isRankingQuery = /ORDER\s+BY\s+\S+\s+DESC[\s\S]*?LIMIT/i.test(lastOrderBy);

        if (agencyCol && valueCol && hasYear && rows.length > 1 && !isRankingQuery) {
          const agencies = [
            ...new Set(rows.map((r) => String(r[agencyCol] ?? ""))),
          ];
          if (agencies.length >= 2 && agencies.length <= 10) {
            // Pivot the data
            const hasMonth = columns.includes("month");
            const keyFn = (r: Record<string, unknown>) =>
              hasMonth ? `${r.year}_${r.month}` : `${r.year}`;
            const grouped = new Map<string, Record<string, unknown>>();

            for (const r of rows) {
              const key = keyFn(r);
              if (!grouped.has(key)) {
                const base: Record<string, unknown> = { year: r.year };
                if (hasMonth) base.month = r.month;
                grouped.set(key, base);
              }
              const entry = grouped.get(key)!;
              const colName = String(r[agencyCol] ?? "")
                .toLowerCase()
                .replace(/,\s*[a-z]{2}$/i, "")
                .replace(/\s+/g, "_");
              entry[colName] = r[valueCol];
            }

            rows = Array.from(grouped.values()).sort((a, b) => {
              const yd = Number(a.year) - Number(b.year);
              if (yd !== 0) return yd;
              return Number(a.month ?? 0) - Number(b.month ?? 0);
            });

            const pivotedCols = Object.keys(rows[0] || {});
            columns = pivotedCols;

            // Update Claude's chart hints
            const yCols = pivotedCols.filter(
              (c) => c !== "year" && c !== "month"
            );
            claude.yAxis = yCols.join(",");
            claude.xAxis = "year";
            claude.chartHint = "line";
          }
        }

        // Step 4c: Detect columns that are ALL null in pivoted comparison data
        // Catches agencies that don't exist in the dataset but appear as null columns
        {
          const { allNull: everyColNull, dataCols } = detectAllNullData(columns, rows);
          if (everyColNull) {
            // Detect if the issue is a failed agency/CTE lookup vs bad math
            const hasAgencyCte = /WITH\s+agency\s+AS/i.test(sql) || /historical_agency\s+ha/i.test(sql);
            const hasCountyOrCity = /\b(county|parish|agency\s*=)\b/i.test(question);
            const emptyMsg = hasAgencyCte && hasCountyOrCity
              ? "I couldn't find a matching agency or county record for that query. The name may be stored differently in the database — try the exact agency name (e.g., 'Alameda County' not just 'Alameda'), or check the Historical Library tab which has county-level records."
              : "I ran that query but all the values came back empty — the math likely broke somewhere (like dividing by zero). Could you try asking that a different way?";
            writeLog(question, sql, 0, "all_null_columns", totalMs, emptyMsg, tab, firedGuardrails, "haiku-4.5", sessionId);
            controller.enqueue(
              encoder.encode(
                sseEvent({
                  type: "result",
                  sql,
                  explanation: emptyMsg,
                  title: claude.title || "No Results",
                  columns,
                  rows: [],
                  rowCount: 0,
                  truncated: false,
                  chartConfig: null,
                  chartMeta: null,
                  executionTimeMs,
                })
              )
            );
            close();
            return;
          }
          // Check for partial null columns (some null, some not)
          if (dataCols.length > 0 && rows.length > 0) {
            const nullCols = dataCols.filter(col => rows.every(r => r[col] === null || r[col] === undefined));
            if (nullCols.length > 0 && nullCols.length < dataCols.length) {
              const names = nullCols.map(c => c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())).join(', ');
              claude.explanation += `\n\nNote: ${names} returned no data for this query. This agency may not be in our dataset, may not report this offense, or may not have data for the requested time period.`;
              rows = rows.map(r => {
                const cleaned = { ...r };
                for (const col of nullCols) delete cleaned[col];
                return cleaned;
              });
              columns = columns.filter(c => !nullCols.includes(c));
              if (claude.yAxis) {
                claude.yAxis = claude.yAxis.split(',').map(y => y.trim()).filter(y => !nullCols.includes(y)).join(',');
              }
            }
          }
        }

        // Step 4d: Detect sparse monthly city data (sawtooth pattern)
        // If monthly data for a specific city/agency has many zeros, retry with rolling 12-month
        // SKIP if user explicitly asked for raw/non-rolling values
        const userWantsRaw = /\b(raw counts?|raw numbers?|not rolling|no rolling|don'?t want rolling|just monthly|just raw)\b/i.test(question);
        const hasMonth = columns.includes("month");
        const isAgencyQuery = sql.toLowerCase().includes("agency_monthly") && /agency\s*=\s*'/i.test(sql);
        if (hasMonth && isAgencyQuery && rows.length > 12 && !userWantsRaw) {
          const dataCols = columns.filter(c => c !== "year" && c !== "month");
          for (const col of dataCols) {
            const vals = rows.map(r => Number(r[col] ?? 0));
            const zeroCount = vals.filter(v => v === 0).length;
            const zeroPct = zeroCount / vals.length;
            if (zeroPct > 0.15) {
              // Retry with rolling 12-month (skip if over budget)
              if (isOverBudget()) break;
              console.log(`[sparse-monthly] ${col}: ${zeroCount}/${vals.length} zeros (${(zeroPct*100).toFixed(0)}%), retrying with rolling 12-month`);
              controller.enqueue(
                encoder.encode(
                  sseEvent({ type: "status", text: "Switching to rolling 12-month view..." })
                )
              );
              const rollingPrompt = `Rewrite this query to use a rolling 12-month sum instead of raw monthly counts. The raw monthly data has many zero-count months which creates a misleading chart. Use SUM(...) OVER (ORDER BY year, month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) as the rolling window. Keep all other filters the same.`;
              const rollingHistory = [
                ...(promptHistory || []),
                { role: "user" as const, content: question },
                { role: "assistant" as const, content: JSON.stringify(claude) },
                { role: "user" as const, content: rollingPrompt },
              ];
              const rollingFixed = await translateToSql(rollingPrompt, rollingHistory, systemPrompt);
              if (rollingFixed.sql) {
                const rv = validateAndSanitize(rollingFixed.sql, { maxLimit });
                if (rv.valid) {
                  try {
                    const stmt2 = db.prepare(rv.sanitized!);
                    const result2 = stmt2.all() as Record<string, unknown>[];
                    rows = result2;
                    columns = stmt2.columns().map(c => c.name);
                    sql = rv.sanitized!;
                    applyRetryMeta(claude, rollingFixed);
                    claude.explanation = (claude.explanation || "") + "\n\nNote: Raw monthly data had many zero-count months, so results were converted to a rolling 12-month sum for a clearer trend.";
                    console.log(`[sparse-monthly] Rolling 12-month retry succeeded, ${rows.length} rows`);
                  } catch (e) {
                    console.log(`[sparse-monthly] Rolling retry SQL failed:`, e);
                  }
                }
              }
              break; // Only retry once
            }
          }
        }

        // Step 5: Build chart config + metadata
        const chartConfig = buildChartConfig(claude, columns, rows, question);
        const chartMeta = isHistorical ? getHistoricalChartMeta(db, sql) : getChartMeta(db, sql);
        const truncated = rows.length >= maxLimit;

        // Step 5b2: Single-row trend warning
        const singleRowWarning = checkSingleRowTrend(question, rows.length);
        if (singleRowWarning) {
          claude.explanation = (claude.explanation || "") + "\n\n" + singleRowWarning;
        }

        // Step 5c: Append deterministic RTCI sample disclaimer (server-enforced, model can't skip)
        if (!isHistorical && claude.explanation) {
          const sampleNote = "Note: Current Trends data comes from a sample of agencies with consistent reporting — it does not represent complete state or national totals. For comprehensive state-level estimates, try the Historical Library tab.";
          if (!claude.explanation.includes("sample")) {
            claude.explanation = claude.explanation + "\n\n" + sampleNote;
          }
        }

        // Step 5b: Send result immediately with pre-query explanation (no waiting)
        controller.enqueue(
          encoder.encode(
            sseEvent({
              type: "result",
              sql,
              explanation: claude.explanation,
              title: claude.title || "Results",
              columns,
              rows,
              rowCount: rows.length,
              truncated,
              chartConfig,
              chartMeta,
              executionTimeMs,
            })
          )
        );

        // Step 6: Generate refined explanation in background, send as update
        // Re-extract context from final SQL (may have been fixed by guardrails/retry)
        const finalCtx = extractQueryContext(sql, question, tab as "current" | "historical");
        try {
          let postExplanation = await generateExplanation({
            ctx: finalCtx,
            columns,
            rows,
            rowCount: rows.length,
            disclaimers: "",  // let buildDisclaimers handle all disclaimers deterministically
            preQueryExplanation: claude.explanation,
          });
          // Fix national vs cities wording mismatch (e.g., national_clearance_rate described as "across cities")
          if (/\bnational_/i.test(sql) && !/\bagency\s*=/i.test(sql)) {
            postExplanation = postExplanation
              .replace(/\bacross cities\b/gi, "nationally")
              .replace(/\bfor cities\b/gi, "nationally")
              .replace(/\bin cities\b/gi, "nationally");
          }
          // Append RTCI sample disclaimer to post-query explanation too
          if (!isHistorical && postExplanation && !postExplanation.includes("sample")) {
            postExplanation += "\n\nNote: Current Trends data comes from a sample of agencies with consistent reporting — it does not represent complete state or national totals. For comprehensive state-level estimates, try the Historical Library tab.";
          }
          postExplanation = applyResultDisclosures({ explanation: postExplanation, question, sql, rows, tab });
          if (containsInternalScaffold(postExplanation)) {
            console.log(`[query][internal-scaffold] Stripping scaffold text from post-query explanation`);
            postExplanation = stripInternalScaffold(postExplanation) || claude.explanation;
          }
          if (postExplanation !== claude.explanation) {
            controller.enqueue(
              encoder.encode(
                sseEvent({ type: "explanation", text: postExplanation, title: claude.title || "Results" })
              )
            );
          }
          const totalMs2 = Date.now() - totalStart;
          writeLog(question, sql, rows.length, null, totalMs2, postExplanation, tab, firedGuardrails, "haiku-4.5", sessionId);
          // Cache successful responses (only standalone questions)
          if (!fromCache && promptHistory.length === 0 && sql) {
            setCache(question, tab, { sql, explanation: claude.explanation, title: claude.title, chartType: claude.chartHint, xAxis: claude.xAxis, yAxis: claude.yAxis ? claude.yAxis.split(",").map(s => s.trim()) : undefined, yAxisLabel: claude.yAxisLabel, xAxisLabel: claude.xAxisLabel, colors: claude.colors, annotations: claude.annotations });
          }
        } catch {
          // Retry post-query explanation once before falling back
          try {
            let retryExplanation = await generateExplanation({
              ctx: finalCtx,
              columns,
              rows,
              rowCount: rows.length,
              disclaimers: "",
              preQueryExplanation: claude.explanation,
            });
            // Fix national vs cities wording mismatch
            if (/\bnational_/i.test(sql) && !/\bagency\s*=/i.test(sql)) {
              retryExplanation = retryExplanation
                .replace(/\bacross cities\b/gi, "nationally")
                .replace(/\bfor cities\b/gi, "nationally")
                .replace(/\bin cities\b/gi, "nationally");
            }
            if (!isHistorical && retryExplanation && !retryExplanation.includes("sample")) {
              retryExplanation += "\n\nNote: Current Trends data comes from a sample of agencies with consistent reporting — it does not represent complete state or national totals. For comprehensive state-level estimates, try the Historical Library tab.";
            }
            retryExplanation = applyResultDisclosures({ explanation: retryExplanation, question, sql, rows, tab });
            if (containsInternalScaffold(retryExplanation)) {
              console.log(`[query][internal-scaffold] Stripping scaffold text from retry explanation`);
              retryExplanation = stripInternalScaffold(retryExplanation) || claude.explanation;
            }
            if (retryExplanation !== claude.explanation) {
              controller.enqueue(
                encoder.encode(
                  sseEvent({ type: "explanation", text: retryExplanation, title: claude.title || "Results" })
                )
              );
            }
            const totalMs2 = Date.now() - totalStart;
            writeLog(question, sql, rows.length, null, totalMs2, retryExplanation, tab, firedGuardrails, "haiku-4.5", sessionId);
          } catch {
            // Both attempts failed — pre-query explanation stays
            const totalMs2 = Date.now() - totalStart;
            writeLog(question, sql, rows.length, null, totalMs2, claude.explanation, tab, firedGuardrails, "haiku-4.5", sessionId);
          }
          if (!fromCache && promptHistory.length === 0 && sql) {
            setCache(question, tab, { sql, explanation: claude.explanation, title: claude.title, chartType: claude.chartHint, xAxis: claude.xAxis, yAxis: claude.yAxis ? claude.yAxis.split(",").map(s => s.trim()) : undefined, yAxisLabel: claude.yAxisLabel, xAxisLabel: claude.xAxisLabel, colors: claude.colors, annotations: claude.annotations });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const ms = Date.now() - totalStart;
        writeLog(question, sql, 0, msg, ms, null, tab, firedGuardrails, "haiku-4.5", sessionId);
        console.error("Query API error:", msg);
        controller.enqueue(
          encoder.encode(
            sseEvent({
              type: "error",
              text: "Something went wrong processing your question. Please try again.",
            })
          )
        );
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-RateLimit-Remaining": String(rateCheck.remaining),
    },
  });
}
