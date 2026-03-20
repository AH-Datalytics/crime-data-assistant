import { NextRequest, NextResponse } from "next/server";
import { getNibrsDb, executeWithTimeout, logNibrsQuery } from "@/lib/nibrs-db";
import { translateToSql } from "@/lib/nibrs-claude";
import { validateAndSanitize } from "@/lib/sql-safety";
import { buildNibrsChartConfig } from "@/lib/nibrs-chart-config";
import type { QueryResponse, QueryError } from "@/lib/types";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

function jsonResp(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const question = body?.question?.trim();

    if (!question || typeof question !== "string") {
      return jsonResp(
        { success: false, error: "Please provide a question" } as QueryError,
        400
      );
    }

    if (question.length > 2000) {
      return jsonResp(
        { success: false, error: "Question too long (max 2000 characters)" } as QueryError,
        400
      );
    }

    // Step 1: Translate to SQL via Claude (with conversation history for context)
    const history = Array.isArray(body?.history) ? body.history : undefined;
    const claudeStart = Date.now();
    let claude = await translateToSql(question, history);
    const claudeMs = Date.now() - claudeStart;
    console.log(`[nibrs][timing] Claude API: ${claudeMs}ms`);

    if (!claude.sql) {
      logNibrsQuery(question, null, 0, null, claudeMs, claude.explanation);
      return jsonResp({
        success: true,
        question,
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
      } as QueryResponse);
    }

    // Step 2: Validate SQL
    const validation = validateAndSanitize(claude.sql);
    if (!validation.valid) {
      return jsonResp(
        {
          success: false,
          error: `SQL validation failed: ${validation.error}`,
          sql: claude.sql,
        } as QueryError,
        400
      );
    }

    let sql = validation.sanitized!;

    // Step 2b: Detect person crime queries hitting raw victims table → retry with summary tables
    const PERSON_CODES = ['09A','09B','09C','11A','11B','11C','11D','13A','13B','13C','100','36A','36B','64A','64B'];
    const hitsRawVictims = /\bFROM\s+VICTIMS\b/i.test(sql) && !(/\bSUMMARY_VICTIM/i.test(sql));
    const hasPersonCode = PERSON_CODES.some(code => sql.includes(`'${code}'`));
    const isCountQuery = /\bCOUNT\s*\(|\bSUM\s*\(/i.test(sql);
    const selectClause = sql.match(/SELECT\s+([\s\S]*?)\s+FROM/i)?.[1] || '';
    const needsDemographics = /\b(\.age|\.sex|\.race|\.ethnicity|\.injury_type|\.relationship)/i.test(selectClause);

    if (hitsRawVictims && hasPersonCode && isCountQuery && !needsDemographics) {
      console.log(`[nibrs][safeguard] Person crime count on raw victims detected, retrying with summary table instruction`);
      const retryResult = await translateToSql(
        question + "\n\n[SYSTEM: You MUST use summary_victim_state_monthly or summary_victim_city_monthly for this query. Do NOT use the raw victims table.]",
        history
      );
      if (retryResult.sql) {
        const retryValidation = validateAndSanitize(retryResult.sql);
        if (retryValidation.valid && /\bsummary_victim/i.test(retryValidation.sanitized!)) {
          sql = retryValidation.sanitized!;
          claude.explanation = retryResult.explanation;
          claude.chartHint = retryResult.chartHint;
          claude.xAxis = retryResult.xAxis;
          claude.yAxis = retryResult.yAxis;
          claude.title = retryResult.title;
          console.log(`[nibrs][safeguard] Retry succeeded, using summary table`);
        }
      }
    }

    // Step 2c: Detect state-level summary table used with ori filter → fix to city-level table
    const usesStateSummary = /\bsummary_victim_state_monthly\b/i.test(sql);
    const hasOriFilter = /\bori\b/i.test(sql);
    if (usesStateSummary && hasOriFilter) {
      console.log(`[nibrs][safeguard] State summary table used with ori filter, switching to city table`);
      sql = sql.replace(/\bsummary_victim_state_monthly\b/gi, 'summary_victim_city_monthly');
    }
    const usesStateSummaryProp = /\bsummary_state_monthly\b/i.test(sql) && !/\bsummary_victim/i.test(sql);
    if (usesStateSummaryProp && hasOriFilter) {
      console.log(`[nibrs][safeguard] State property summary used with ori filter, switching to city table`);
      sql = sql.replace(/\bsummary_state_monthly\b/gi, 'summary_city_monthly');
    }

    // Step 3: Execute SQL (in worker thread with 15s timeout)
    const startTime = Date.now();

    let rows: Record<string, unknown>[];
    let columns: string[];

    try {
      const result = await executeWithTimeout(sql);
      rows = result.rows;
      columns = result.columns;
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      const isTimeout = msg.includes("timed out");
      console.log(`[nibrs][error-recovery] DB error: ${msg}, retrying with Claude`);

      // For timeouts, ask Claude to use a summary table instead
      const errorInstruction = isTimeout
        ? `That SQL timed out after 30 seconds. The query is too slow — you MUST rewrite it to use a summary table (summary_state_monthly, summary_city_monthly, summary_victim_state_monthly, summary_victim_city_monthly, summary_victim_demographics, summary_offender_demographics, summary_arrestee_demographics, summary_property_offense, summary_drug_monthly, summary_carjacking_monthly, or summary_flash_mob_monthly). If no summary table fits, use a narrower WHERE clause.`
        : `That SQL failed with error: ${msg}. Please fix the query and try again.`;

      const retryHistory = [
        ...(history || []),
        { role: "user" as const, content: question },
        { role: "assistant" as const, content: JSON.stringify(claude) },
        { role: "user" as const, content: errorInstruction },
      ];
      const retry = await translateToSql(
        isTimeout ? `Rewrite using summary tables: ${question}` : `Fix this SQL error: ${msg}`,
        retryHistory
      );
      if (retry.sql) {
        const retryValidation = validateAndSanitize(retry.sql);
        if (retryValidation.valid) {
          try {
            const retryResult = await executeWithTimeout(retryValidation.sanitized!);
            rows = retryResult.rows;
            columns = retryResult.columns;
            sql = retryValidation.sanitized!;
            claude.explanation = retry.explanation;
            claude.chartHint = retry.chartHint;
            claude.xAxis = retry.xAxis;
            claude.yAxis = retry.yAxis;
            claude.title = retry.title;
            console.log(`[nibrs][error-recovery] Retry succeeded`);
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            logNibrsQuery(question, sql, 0, `DB retry failed: ${retryMsg}`, Date.now() - claudeStart);
            return jsonResp(
              { success: false, error: isTimeout ? `This query is too complex for the database. Try asking about a specific city, state, or shorter time range.` : `I had trouble with that query. Try rephrasing your question.`, sql } as QueryError,
              500
            );
          }
        } else {
          logNibrsQuery(question, sql, 0, `DB: ${msg} (retry validation failed)`, Date.now() - claudeStart);
          return jsonResp(
            { success: false, error: `I had trouble with that query. Try rephrasing your question.`, sql } as QueryError,
            500
          );
        }
      } else {
        logNibrsQuery(question, sql, 0, `DB: ${msg}`, Date.now() - claudeStart);
        return jsonResp(
          { success: false, error: isTimeout ? `This query is too complex for the database. Try asking about a specific city, state, or shorter time range.` : `Database error: ${msg}`, sql } as QueryError,
          500
        );
      }
    }

    const executionTimeMs = Date.now() - startTime;
    logNibrsQuery(question, sql, rows.length, null, claudeMs + executionTimeMs);

    const explanation = claude.explanation;

    // Step 5: Build chart config
    const chartConfig = buildNibrsChartConfig(claude, columns, rows);

    // Step 6: Truncate if needed
    const truncated = rows.length >= 1000;

    return jsonResp({
      success: true,
      question,
      sql,
      explanation,
      title: claude.title || "Results",
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      chartConfig,
      chartMeta: null,
      executionTimeMs,
    } as QueryResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[nibrs] Query API error:", msg);
    return jsonResp(
      { success: false, error: `Server error: ${msg}` } as QueryError,
      500
    );
  }
}
