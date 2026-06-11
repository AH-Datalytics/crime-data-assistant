import { NextRequest, NextResponse } from "next/server";
import { getHateCrimeDb } from "@/lib/hc-db";
import { validatePageToken } from "@/lib/page-token";
import { validateAndSanitize } from "@/lib/sql-safety";
import { logQuery } from "@/lib/rtci-db";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkSessionLimit, maybeCleanup } from "@/lib/captcha";
import type { QueryError } from "@/lib/types";
import { sanitizeExplanation } from "@/lib/explain";
import Anthropic from "@anthropic-ai/sdk";
import { getHateCrimeSystemPrompt } from "@/lib/hc-claude";
import { getCached, setCache } from "@/lib/response-cache";
import { extractJson } from "@/lib/extract-json";
import { detectAllNullData } from "@/lib/all-null-detection";
import { isSourceEnabled } from "@/lib/sources";
import { parseRoutingLogMeta } from "@/lib/routing-log-meta";
import { answerMetadataQuestion } from "@/lib/metadata-coverage";
import { validateTablesForTab } from "@/lib/table-allowlist";
import { applyResultDisclosures } from "@/lib/result-disclosure";
import { normalizeHistoryForTab } from "@/lib/chat-history";
import { detectFollowupTransform } from "@/lib/followup-transform";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonResp(data: Record<string, any> | QueryError, status = 200) {
  return NextResponse.json(data, { status });
}

/** Mandatory caveats appended to every hate crime response */
function hateCrimeCaveats(sql: string, explanation: string): string {
  const caveats: string[] = [];

  // Always add the voluntary reporting caveat
  caveats.push(
    "Hate crime reporting is voluntary. An agency reporting zero hate crimes may simply not have participated - it does not mean zero hate crimes occurred."
  );

  // Participation growth caveat for trend queries
  const yearMatches = sql.match(/\b(19|20)\d{2}\b/g);
  if (yearMatches) {
    const years = [...new Set(yearMatches.map(Number))];
    if (years.length >= 2 && Math.max(...years) - Math.min(...years) > 3) {
      caveats.push(
        "The number of agencies reporting hate crimes has grown significantly over time (~2,700 in 1991 to ~15,000+ today). Increases in hate crime counts partly reflect more agencies reporting, not solely more hate crimes."
      );
    }
  }

  // Undercount caveat
  caveats.push(
    "The Bureau of Justice Statistics estimates actual hate crime victimization is significantly higher than what agencies report to the FBI."
  );

  // Definition boundary caveats
  if (yearMatches) {
    const minYear = Math.min(...yearMatches.map(Number));
    if (/gender.identity|transgender|non.conforming/i.test(sql) && minYear < 2013) {
      caveats.push("Gender and gender identity bias categories were added in 2013. Data before that year does not include these categories.");
    }
    if (/anti.arab|anti.hindu|anti.sikh|anti.mormon|anti.buddhist/i.test(sql) && minYear < 2015) {
      caveats.push("Arab, Hindu, Sikh, and other specific religion categories were added in 2015.");
    }
    if (/adult_victims|juvenile_victims|offender_ethnicity/i.test(sql) && minYear < 2020) {
      caveats.push("Age breakdowns and offender ethnicity data are available from 2020 onward only.");
    }
  }

  // Partial year warning
  const currentYear = new Date().getFullYear();
  if (yearMatches && yearMatches.map(Number).some(y => y >= currentYear - 1)) {
    caveats.push(`Data for ${currentYear - 1} may be incomplete as not all agencies have submitted reports.`);
  }

  // Always append caveats — filter out any the model already stated
  const fresh = caveats.filter(c => {
    // Skip if explanation already contains the key phrase from this caveat
    if (c.includes("voluntary") && /\bvoluntary\b/i.test(explanation)) return false;
    if (c.includes("Bureau of Justice") && /Bureau of Justice|BJS|undercount|2.4x|higher than/i.test(explanation)) return false;
    return true;
  });
  if (fresh.length > 0) {
    return explanation + "\n\n" + fresh.join(" ");
  }
  return explanation;
}

export async function POST(req: NextRequest) {
  if (!isSourceEnabled("hate_crime")) {
    return NextResponse.json(
      { success: false, error: "Hate Crime source is not available." },
      { status: 404 },
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    const retryAfter = Math.ceil((rateCheck.retryAfterMs || 60000) / 1000);
    return jsonResp(
      { success: false, error: `Too many requests. Please wait ${retryAfter} seconds and try again.` } as QueryError,
      429
    );
  }

  try {
    const body = await req.json();
    const question = body?.question?.trim();
    const sessionId: string | null = ((body?.sessionId as string) || "").slice(0, 64) || null;

    // Page token validation
    const pageToken = body?.pageToken as string | undefined;
    if (!validatePageToken(pageToken)) {
      return jsonResp(
        { success: false, error: "Please refresh the page and try again." } as QueryError,
        403
      );
    }

    // Session-based CAPTCHA throttle
    maybeCleanup();
    const captchaCheck = checkSessionLimit(sessionId);
    if (!captchaCheck.allowed) {
      if (captchaCheck.dailyLimitReached) {
        return jsonResp({ success: false, error: "You've reached the daily query limit. Please come back tomorrow." } as QueryError, 429);
      }
      return NextResponse.json({ success: false, captchaRequired: true }, { status: 202 });
    }

    if (!question || typeof question !== "string") {
      return jsonResp({ success: false, error: "Please provide a question" } as QueryError, 400);
    }
    if (question.length > 2000) {
      return jsonResp({ success: false, error: "Question too long (max 2000 characters)" } as QueryError, 400);
    }

    const history = normalizeHistoryForTab(body?.history, "hate_crime");
    const followupTransform = detectFollowupTransform(question, history);
    const promptHistory = followupTransform
      ? [...history, { role: "user" as const, content: followupTransform.instruction }]
      : history;
    const start = Date.now();
    const routingMeta = parseRoutingLogMeta(body);
    const writeLog = (
      q: string,
      sqlText: string | null,
      rowCount: number,
      logError: string | null,
      ms: number,
      logResponse: string | null = null,
      tabName: string = "hate_crime",
      guardrails: string[] = [],
      model: string | null = null,
      sid: string | null = null
    ) => logQuery(q, sqlText, rowCount, logError, ms, logResponse, tabName, guardrails, model, sid, routingMeta);

    const metadata = answerMetadataQuestion("hate_crime", question, getHateCrimeDb());
    if (metadata) {
      const executionMs = Date.now() - start;
      writeLog(question, metadata.sql, metadata.rowCount, null, executionMs, metadata.explanation, "hate_crime", ["deterministic-metadata"], "deterministic", sessionId);
      return jsonResp({
        success: true,
        question,
        sql: metadata.sql,
        explanation: metadata.explanation,
        title: metadata.title,
        columns: metadata.columns,
        rows: metadata.rows,
        rowCount: metadata.rowCount,
        truncated: metadata.truncated,
        chartConfig: metadata.chartConfig,
        chartMeta: metadata.chartMeta,
        executionTimeMs: executionMs,
      });
    }

    // Check response cache (only for standalone questions)
    const cached = promptHistory.length === 0 ? getCached(question, "hate_crime") : null;

    let claude: {
      sql: string | null;
      explanation: string;
      title?: string;
      chartType?: string;
      xAxis?: string;
      yAxis?: string[];
      yAxisLabel?: string;
    };
    let text = "";

    const client = new Anthropic();
    const messages: Anthropic.MessageParam[] = [
      ...promptHistory.map((h: { role: string; content: string }) => ({
        role: h.role as "user" | "assistant",
        content: h.content,
      })),
      { role: "user", content: question },
    ];

    if (cached) {
      claude = { sql: cached.sql, explanation: cached.explanation, title: cached.title, chartType: cached.chartType, xAxis: cached.xAxis, yAxis: cached.yAxis, yAxisLabel: cached.yAxisLabel };
    } else {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: [{ type: "text", text: getHateCrimeSystemPrompt(), cache_control: { type: "ephemeral" } }],
        messages,
      });

      text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const jsonRaw = extractJson(text);
      claude = (jsonRaw && typeof jsonRaw === "object" && "sql" in (jsonRaw as object))
        ? jsonRaw as typeof claude
        : { sql: null, explanation: text };

      const claudeMs = Date.now() - start;

      // Retry if model incorrectly claims data isn't available
      if (!claude.sql) {
        const refusalPatterns = /not (appear|be represented)|doesn't appear|not (in|included in) (this|the|our) (dataset|data|sample|library)|no data (for|available|found)|does not (have|include|cover)|not available|isn't (in|included)|not found in/i;
        if (refusalPatterns.test(claude.explanation || "")) {
          try {
            const retryMessages: Anthropic.MessageParam[] = [
              ...messages,
              { role: "assistant", content: claude.explanation },
              { role: "user", content: "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. Always generate a SQL query and let the database answer. Try the query now.]" },
            ];
            const retryResp = await client.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 2000,
              system: [{ type: "text", text: getHateCrimeSystemPrompt(), cache_control: { type: "ephemeral" } }],
              messages: retryMessages,
            });
            const retryText = retryResp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
            const retryClaude = extractJson(retryText);
            if (retryClaude && typeof retryClaude === "object" && (retryClaude as Record<string, unknown>).sql) {
              Object.assign(claude, retryClaude);
            }
          } catch { /* use original */ }
        }
      }

      if (!claude.sql) {
        const textExplanation = hateCrimeCaveats("", claude.explanation);
        writeLog(question, null, 0, null, claudeMs, textExplanation, "hate_crime", [], "haiku-4.5", sessionId);
        return jsonResp({
          success: true, question, sql: null, explanation: textExplanation,
          title: "", columns: [], rows: [], rowCount: 0, truncated: false,
          chartConfig: null, chartMeta: null, executionTimeMs: claudeMs,
        });
      }
    }

    // Step 2: Validate SQL
    const validation = validateAndSanitize(claude.sql!);
    if (!validation.valid) {
      writeLog(question, claude.sql, 0, `Validation: ${validation.error}`, Date.now() - start, null, "hate_crime", [], "haiku-4.5", sessionId);
      return jsonResp(
        { success: false, error: "I generated an invalid query. Please try rephrasing your question.", sql: claude.sql } as QueryError,
        400
      );
    }

    let sql = validation.sanitized!;

    {
      const tableDb = getHateCrimeDb();
      if (tableDb) {
        const tableCheck = validateTablesForTab(sql, "hate_crime", tableDb);
        if (!tableCheck.ok) {
          try {
            const retryMessages: Anthropic.MessageParam[] = [
              ...messages,
              { role: "assistant", content: text || JSON.stringify(claude) },
              { role: "user", content: `[SYSTEM: ${tableCheck.message}]` },
            ];
            const retryResp = await client.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 2000,
              system: [{ type: "text", text: getHateCrimeSystemPrompt(), cache_control: { type: "ephemeral" } }],
              messages: retryMessages,
            });
            const retryText = retryResp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
            const retryClaude = extractJson(retryText) as Record<string, unknown> | null;
            if (retryClaude?.sql) {
              const retryValidation = validateAndSanitize(retryClaude.sql as string);
              if (retryValidation.valid) {
                const retrySql = retryValidation.sanitized!;
                const retryTableCheck = validateTablesForTab(retrySql, "hate_crime", tableDb);
                if (retryTableCheck.ok) {
                  sql = retrySql;
                  claude.explanation = (retryClaude.explanation as string) || claude.explanation;
                  claude.title = (retryClaude.title as string) || claude.title;
                  claude.chartType = (retryClaude.chartType as string) || claude.chartType;
                  claude.xAxis = (retryClaude.xAxis as string) || claude.xAxis;
                  claude.yAxis = (retryClaude.yAxis as string[]) || claude.yAxis;
                } else {
                  const msg = "I couldn't build a valid query for the Hate Crime database. Try rephrasing for hate-crime-specific data or switching tabs for general crime totals.";
                  writeLog(question, retrySql, 0, `table_allowlist_second_failure:${retryTableCheck.unknown.join(",")}`, Date.now() - start, msg, "hate_crime", [...tableCheck.fired, ...retryTableCheck.fired], "haiku-4.5", sessionId);
                  return jsonResp({ success: true, question, sql: null, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start });
                }
              }
            }
          } catch { /* fall through to friendly failure */ }

          const msg = "I couldn't build a valid query for the Hate Crime database. Try rephrasing for hate-crime-specific data or switching tabs for general crime totals.";
          writeLog(question, sql, 0, `table_allowlist:${tableCheck.unknown.join(",")}`, Date.now() - start, msg, "hate_crime", tableCheck.fired, "haiku-4.5", sessionId);
          return jsonResp({ success: true, question, sql: null, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start });
        }
      }
    }

    // Step 2b: Incident count guardrail
    // If question asks for "hate crimes" / "incidents" and SQL uses COUNT(*) on raw
    // hate_crime_incidents without COUNT(DISTINCT ...), rewrite only the primary
    // count expression (aliased as incidents/count/hate_crimes/total). Leaves window
    // functions and subquery counts untouched.
    {
      const qLower = question.toLowerCase();
      const wantsIncidents = /\bhate\s*crimes?\b|\bincidents?\b/i.test(qLower) && !/\boffenses?\b/i.test(qLower) && !/\bvictims?\b/i.test(qLower);
      const usesRawTable = /\bhate_crime_incidents\b/i.test(sql);
      const usesCountStar = /\bCOUNT\s*\(\s*\*\s*\)/i.test(sql);
      const usesCountDistinct = /COUNT\s*\(\s*DISTINCT/i.test(sql);

      if (wantsIncidents && usesRawTable && usesCountStar && !usesCountDistinct) {
        // Only rewrite COUNT(*) that is aliased as an incident-like column
        const rewritten = sql.replace(
          /\bCOUNT\s*\(\s*\*\s*\)(\s+AS\s+\w*(?:incident|count|total|hate_crime|crimes?)\w*)/gi,
          "COUNT(DISTINCT incident_number || '|' || ori || '|' || year)$1"
        );
        if (rewritten !== sql) {
          console.log("[hate_crime][guardrail] Rewrote aliased COUNT(*) to COUNT(DISTINCT ...)");
          sql = rewritten;
        } else {
          // Fallback: if there's exactly one COUNT(*) in the SELECT clause, rewrite it
          const selectClause = sql.match(/^(SELECT\s+(?:[\s\S]*?))(?=\s+FROM\b)/i)?.[1] || "";
          const countStarMatches = selectClause.match(/COUNT\s*\(\s*\*\s*\)/gi);
          if (countStarMatches && countStarMatches.length === 1) {
            sql = sql.replace(
              /^(SELECT\s+(?:[\s\S]*?))COUNT\s*\(\s*\*\s*\)/i,
              "$1COUNT(DISTINCT incident_number || '|' || ori || '|' || year)"
            );
            console.log("[hate_crime][guardrail] Rewrote single COUNT(*) in SELECT to COUNT(DISTINCT ...)");
          }
        }
      }
    }

    // Step 3: Execute
    const db = getHateCrimeDb();
    if (!db) {
      return jsonResp({ success: false, error: "Hate crime database not available." } as QueryError, 500);
    }

    let rows: Record<string, unknown>[];
    try {
      rows = db.prepare(sql).all() as Record<string, unknown>[];
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);

      // Retry with Claude on DB error
      console.log(`[hate_crime][error-recovery] DB error: ${msg}, retrying with Claude`);
      try {
        const retryMessages: Anthropic.MessageParam[] = [
          ...messages,
          { role: "assistant", content: text },
          { role: "user", content: `That SQL failed with error: ${msg}. Please fix the query and try again.` },
        ];
        const retryResp = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2000,
          system: [{ type: "text", text: getHateCrimeSystemPrompt(), cache_control: { type: "ephemeral" } }],
          messages: retryMessages,
        });
        const retryText = retryResp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
        const retryClaude = extractJson(retryText) as Record<string, unknown> | null;
        if (retryClaude?.sql) {
          const retryValidation = validateAndSanitize(retryClaude.sql as string);
          if (retryValidation.valid) {
            const retryRows = db.prepare(retryValidation.sanitized!).all() as Record<string, unknown>[];
            rows = retryRows;
            claude.explanation = (retryClaude.explanation as string) || claude.explanation;
            claude.title = (retryClaude.title as string) || claude.title;
            claude.chartType = (retryClaude.chartType as string) || claude.chartType;
            claude.xAxis = (retryClaude.xAxis as string) || claude.xAxis;
            claude.yAxis = (retryClaude.yAxis as string[]) || claude.yAxis;
          }
        }
      } catch { /* retry also failed */ }

      if (!rows!) {
        writeLog(question, sql, 0, `DB: ${msg}`, Date.now() - start, null, "hate_crime", [], "haiku-4.5", sessionId);
        return jsonResp(
          { success: false, error: `Database error: ${msg}`, sql } as QueryError, 500
        );
      }
    }

    const executionMs = Date.now() - start;

    if (rows.length === 0) {
      const emptyExplanation = hateCrimeCaveats(sql, claude.explanation || "The query returned no results.");
      writeLog(question, sql, 0, "empty_result", executionMs, emptyExplanation, "hate_crime", [], "haiku-4.5", sessionId);
      return jsonResp({
        success: true, question, sql, explanation: emptyExplanation,
        title: "", columns: [], rows: [], rowCount: 0, truncated: false,
        chartConfig: null, chartMeta: null, executionTimeMs: executionMs,
      });
    }

    const columns = Object.keys(rows[0]);

    // Detect all-null data columns
    {
      const { allNull } = detectAllNullData(columns, rows);
      if (allNull) {
        const emptyMsg = "I ran that query but all the values came back empty - the math likely broke somewhere. Could you try asking that a different way?";
        writeLog(question, sql, 0, "all_null_columns", executionMs, emptyMsg, "hate_crime", [], "haiku-4.5", sessionId);
        return jsonResp({
          success: true, question, sql, explanation: emptyMsg, title: "",
          columns: [], rows: [], rowCount: 0, truncated: false,
          chartConfig: null, chartMeta: null, executionTimeMs: executionMs,
        });
      }
    }

    // Build chart config
    const chartConfig = {
      type: claude.chartType || "none",
      xAxis: claude.xAxis || columns[0],
      yAxis: claude.yAxis || (columns.length > 1 ? [columns[columns.length - 1]] : []),
      yAxisLabel: claude.yAxisLabel || undefined,
      // ChartPanel renders config.title — matches chart-config.ts / nibrs-chart-config.ts.
      title: claude.title || "Results",
    };

    const totalMs = Date.now() - start;

    // Apply mandatory caveats
    let explanation = sanitizeExplanation(claude.explanation || "");
    explanation = hateCrimeCaveats(sql, explanation);
    explanation = applyResultDisclosures({ explanation, question, sql, rows, tab: "hate_crime" });

    writeLog(question, sql, rows.length, null, totalMs, explanation, "hate_crime", [], "haiku-4.5", sessionId);

    // Cache successful responses (only standalone questions)
    if (!cached && promptHistory.length === 0) {
      setCache(question, "hate_crime", { sql, explanation: claude.explanation || "", title: claude.title, chartType: claude.chartType, xAxis: claude.xAxis, yAxis: claude.yAxis, yAxisLabel: claude.yAxisLabel });
    }

    return jsonResp({
      success: true, question, sql, explanation,
      title: claude.title || "", columns, rows,
      rowCount: rows.length, truncated: rows.length >= 1000,
      chartConfig, chartMeta: { source: "FBI Hate Crime Statistics", agencyCount: 0, population: null },
      executionTimeMs: totalMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[hate_crime] Query API error:", msg);
    return jsonResp(
      { success: false, error: "An error occurred. Please try again." } as QueryError, 500
    );
  }
}
