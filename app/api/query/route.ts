import { NextRequest, NextResponse } from "next/server";
import { getDb, logQuery } from "@/lib/db";
import { translateToSql } from "@/lib/claude";
import { validateAndSanitize } from "@/lib/sql-safety";
import { buildChartConfig } from "@/lib/chart-config";
import type { QueryResponse, QueryError } from "@/lib/types";

function jsonResp(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: NextRequest) {
  const totalStart = Date.now();
  let question = "";
  let sql: string | null = null;

  try {
    const body = await req.json();
    question = body?.question?.trim() || "";

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

    // Step 1: Translate to SQL via Claude
    const history = Array.isArray(body?.history) ? body.history : undefined;
    const claude = await translateToSql(question, history);

    if (!claude.sql) {
      const ms = Date.now() - totalStart;
      logQuery(question, null, 0, null, ms, claude.explanation);
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
        executionTimeMs: 0,
      } as QueryResponse);
    }

    // Step 2: Validate SQL
    const validation = validateAndSanitize(claude.sql);
    if (!validation.valid) {
      const ms = Date.now() - totalStart;
      logQuery(question, claude.sql, 0, `Validation: ${validation.error}`, ms);
      return jsonResp(
        {
          success: false,
          error: `SQL validation failed: ${validation.error}`,
          sql: claude.sql,
        } as QueryError,
        400
      );
    }

    sql = validation.sanitized!;

    // Step 3: Execute SQL (with one retry on DB error)
    const db = getDb();
    const dbStart = Date.now();

    let rows: Record<string, unknown>[];
    let columns: string[];

    try {
      const stmt = db.prepare(sql);
      const result = stmt.all() as Record<string, unknown>[];
      columns = stmt.columns().map((c) => c.name);
      rows = result;
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      // Retry: tell Claude about the error and ask for a corrected query
      const retryHistory = [
        ...(history || []),
        { role: "user" as const, content: question },
        { role: "assistant" as const, content: JSON.stringify(claude) },
        { role: "user" as const, content: `That SQL failed with error: ${msg}. Please fix the query and try again.` },
      ];
      const retry = await translateToSql(
        `Fix this SQL error: ${msg}`,
        retryHistory
      );
      if (retry.sql) {
        const retryValidation = validateAndSanitize(retry.sql);
        if (retryValidation.valid) {
          try {
            const retryStmt = db.prepare(retryValidation.sanitized!);
            const retryResult = retryStmt.all() as Record<string, unknown>[];
            columns = retryStmt.columns().map((c) => c.name);
            rows = retryResult;
            sql = retryValidation.sanitized!;
            // Update claude response for chart config
            claude.explanation = retry.explanation;
            claude.chartHint = retry.chartHint;
            claude.xAxis = retry.xAxis;
            claude.yAxis = retry.yAxis;
            claude.title = retry.title;
            // Fall through to success path
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            const ms = Date.now() - totalStart;
            logQuery(question, sql, 0, `DB retry failed: ${retryMsg}`, ms);
            return jsonResp(
              { success: false, error: `I had trouble with that query. Try rephrasing your question.`, sql } as QueryError,
              500
            );
          }
        } else {
          const ms = Date.now() - totalStart;
          logQuery(question, sql, 0, `DB: ${msg} (retry validation failed)`, ms);
          return jsonResp(
            { success: false, error: `I had trouble with that query. Try rephrasing your question.`, sql } as QueryError,
            500
          );
        }
      } else {
        const ms = Date.now() - totalStart;
        logQuery(question, sql, 0, `DB: ${msg}`, ms);
        return jsonResp(
          { success: false, error: `Database error: ${msg}`, sql } as QueryError,
          500
        );
      }
    }

    const executionTimeMs = Date.now() - dbStart;
    const totalMs = Date.now() - totalStart;

    // Step 4: Build chart config
    const chartConfig = buildChartConfig(claude, columns, rows);

    // Step 5: Truncate if needed
    const truncated = rows.length >= 1000;

    // Log success
    logQuery(question, sql, rows.length, null, totalMs, claude.explanation);

    return jsonResp({
      success: true,
      question,
      sql,
      explanation: claude.explanation,
      title: claude.title || "Results",
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      chartConfig,
      executionTimeMs,
    } as QueryResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ms = Date.now() - totalStart;
    logQuery(question, sql, 0, msg, ms);
    console.error("Query API error:", msg);
    return jsonResp(
      { success: false, error: `Server error: ${msg}` } as QueryError,
      500
    );
  }
}
