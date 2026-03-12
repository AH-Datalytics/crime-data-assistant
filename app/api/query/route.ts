import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { translateToSql } from "@/lib/claude";
import { validateAndSanitize } from "@/lib/sql-safety";
import { buildChartConfig } from "@/lib/chart-config";
import type { QueryResponse, QueryError } from "@/lib/types";

function jsonResp(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
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

    // Step 1: Translate to SQL via Claude
    const history = Array.isArray(body?.history) ? body.history : undefined;
    const claudeStart = Date.now();
    const claude = await translateToSql(question, history);
    const claudeMs = Date.now() - claudeStart;
    console.log(`[timing] Claude API: ${claudeMs}ms`);

    if (!claude.sql) {
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
      return jsonResp(
        {
          success: false,
          error: `SQL validation failed: ${validation.error}`,
          sql: claude.sql,
        } as QueryError,
        400
      );
    }

    const sql = validation.sanitized!;

    // Step 3: Execute SQL
    const db = getDb();
    const startTime = Date.now();

    let rows: Record<string, unknown>[];
    let columns: string[];

    try {
      const stmt = db.prepare(sql);
      const result = stmt.all() as Record<string, unknown>[];
      columns = stmt.columns().map((c) => c.name);
      rows = result;
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      return jsonResp(
        {
          success: false,
          error: `Database error: ${msg}`,
          sql,
        } as QueryError,
        500
      );
    }

    const executionTimeMs = Date.now() - startTime;

    // Step 4: Build chart config
    const chartConfig = buildChartConfig(claude, columns, rows);

    // Step 5: Truncate if needed
    const truncated = rows.length >= 1000;

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
    console.error("Query API error:", msg);
    return jsonResp(
      { success: false, error: `Server error: ${msg}` } as QueryError,
      500
    );
  }
}
