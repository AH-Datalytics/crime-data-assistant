import { NextRequest, NextResponse } from "next/server";
import { getShrDb } from "@/lib/shr-db";
import { validatePageToken } from "@/lib/page-token";
import { validateAndSanitize } from "@/lib/sql-safety";
import { logQuery } from "@/lib/rtci-db";
import { checkRateLimit } from "@/lib/rate-limit";
import type { QueryError } from "@/lib/types";
import Anthropic from "@anthropic-ai/sdk";
import { getShrSystemPrompt } from "@/lib/shr-claude";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonResp(data: Record<string, any> | QueryError, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: NextRequest) {
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

    if (!question || typeof question !== "string") {
      return jsonResp(
        { success: false, error: "Please provide a question" } as QueryError,
        400
      );
    }

    if (question.length > 2000) {
      return jsonResp(
        { success: false, error: "Question is too long (max 2000 characters)" } as QueryError,
        400
      );
    }

    const history = Array.isArray(body?.history) ? body.history.slice(-10) : [];
    const start = Date.now();

    // Step 1: Translate to SQL via Claude
    const client = new Anthropic();
    const messages: Anthropic.MessageParam[] = [
      ...history.map((h: { role: string; content: string }) => ({
        role: h.role as "user" | "assistant",
        content: h.content,
      })),
      { role: "user", content: question },
    ];

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system: getShrSystemPrompt(),
      messages,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Parse JSON response
    let claude: {
      sql: string | null;
      explanation: string;
      title?: string;
      chartType?: string;
      xAxis?: string;
      yAxis?: string[];
      yAxisLabel?: string;
    };
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      claude = jsonMatch ? JSON.parse(jsonMatch[0]) : { sql: null, explanation: text };
    } catch {
      claude = { sql: null, explanation: text };
    }

    const claudeMs = Date.now() - start;

    // Text-only response
    if (!claude.sql) {
      logQuery(question, null, 0, null, claudeMs, claude.explanation, "shr", [], "haiku-4.5", sessionId);
      return jsonResp({
        success: true,
        question,
        sql: null,
        explanation: claude.explanation,
        title: "",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: claudeMs,
      });
    }

    // Step 2: Validate SQL
    const validation = validateAndSanitize(claude.sql);
    if (!validation.valid) {
      logQuery(question, claude.sql, 0, `Validation: ${validation.error}`, claudeMs, null, "shr", [], "haiku-4.5", sessionId);
      return jsonResp(
        { success: false, error: "I generated an invalid query. Please try rephrasing your question.", sql: claude.sql } as QueryError,
        400
      );
    }

    const sql = validation.sanitized!;

    // Step 3: Execute
    const db = getShrDb();
    let rows: Record<string, unknown>[];
    try {
      rows = db.prepare(sql).all() as Record<string, unknown>[];
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      logQuery(question, sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", [], "haiku-4.5", sessionId);
      return jsonResp(
        { success: false, error: `Database error: ${msg}`, sql } as QueryError,
        500
      );
    }

    const executionMs = Date.now() - start;

    if (rows.length === 0) {
      logQuery(question, sql, 0, "empty_result", executionMs, claude.explanation, "shr", [], "haiku-4.5", sessionId);
      return jsonResp({
        success: true,
        question,
        sql,
        explanation: claude.explanation || "The query returned no results.",
        title: "",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: executionMs,
      });
    }

    const columns = Object.keys(rows[0]);

    // Build chart config (match QueryResponse shape)
    const chartConfig = {
      type: claude.chartType || "none",
      xAxis: claude.xAxis || columns[0],
      yAxis: claude.yAxis || (columns.length > 1 ? [columns[columns.length - 1]] : []),
      yAxisLabel: claude.yAxisLabel || undefined,
      title: "",
    };

    const totalMs = Date.now() - start;
    logQuery(question, sql, rows.length, null, totalMs, claude.explanation, "shr", [], "haiku-4.5", sessionId);

    return jsonResp({
      success: true,
      question,
      sql,
      explanation: claude.explanation,
      title: claude.title || "",
      columns,
      rows,
      rowCount: rows.length,
      truncated: false,
      chartConfig,
      chartMeta: { source: "FBI Supplementary Homicide Reports", agencyCount: 0, population: null },
      executionTimeMs: totalMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("SHR query error:", msg);
    return jsonResp(
      { success: false, error: "An error occurred. Please try again." } as QueryError,
      500
    );
  }
}
