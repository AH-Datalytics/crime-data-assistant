import { NextRequest, NextResponse } from "next/server";
import { getShrDb } from "@/lib/shr-db";
import { validatePageToken } from "@/lib/page-token";
import { validateAndSanitize } from "@/lib/sql-safety";
import { logQuery } from "@/lib/rtci-db";
import { checkRateLimit } from "@/lib/rate-limit";
import { extractQueryContext } from "@/lib/query-context";
import { runGuardrails } from "@/lib/guardrails";
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

    // Text-only response — retry if model incorrectly claims data isn't available
    if (!claude.sql) {
      const refusalPatterns = /not (appear to be |be )?represented|not (in|included in) (this|the|our) (dataset|data|sample)|no data (for|available|found)|does not (have|include|cover)|not available in this/i;
      if (refusalPatterns.test(claude.explanation || "")) {
        try {
          const retryMessages: Anthropic.MessageParam[] = [
            ...messages,
            { role: "assistant", content: claude.explanation },
            { role: "user", content: "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. Please try generating a SQL query — search for the data rather than assuming it doesn't exist.]" },
          ];
          const retryResp = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 2000,
            system: getShrSystemPrompt(),
            messages: retryMessages,
          });
          const retryText = retryResp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
          const retryJson = retryText.match(/\{[\s\S]*\}/);
          if (retryJson) {
            const retryClaude = JSON.parse(retryJson[0]);
            if (retryClaude.sql) Object.assign(claude, retryClaude);
          }
        } catch { /* use original */ }
      }
    }

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

    let sql = validation.sanitized!;

    // Step 2b: Run guardrails
    const ctx = extractQueryContext(sql, question, "shr");
    const guardrailResult = runGuardrails(ctx);
    if (guardrailResult.sql !== sql) {
      sql = guardrailResult.sql;
    }
    if (guardrailResult.needsFix && guardrailResult.issues.length > 0) {
      // Retry with Claude — send guardrail fix instructions
      try {
        const retryMessages: Anthropic.MessageParam[] = [
          ...messages,
          { role: "assistant", content: text },
          { role: "user", content: guardrailResult.issues.join("\n") },
        ];
        const retryResp = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2000,
          system: getShrSystemPrompt(),
          messages: retryMessages,
        });
        const retryText = retryResp.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        const retryJson = retryText.match(/\{[\s\S]*\}/);
        if (retryJson) {
          const retryClaude = JSON.parse(retryJson[0]);
          if (retryClaude.sql) {
            const retryValidation = validateAndSanitize(retryClaude.sql);
            if (retryValidation.valid) {
              sql = retryValidation.sanitized!;
              claude.explanation = retryClaude.explanation || claude.explanation;
              claude.title = retryClaude.title || claude.title;
              claude.chartType = retryClaude.chartType || claude.chartType;
              claude.xAxis = retryClaude.xAxis || claude.xAxis;
              claude.yAxis = retryClaude.yAxis || claude.yAxis;
            }
          }
        }
      } catch {
        // Retry failed, proceed with original (possibly rewritten) SQL
      }
    }

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

    // Deterministic disclaimers based on query content
    const disclaimers: string[] = [];
    const sqlLower = sql.toLowerCase();

    // National/state scope disclaimer
    if (ctx.scope === "national" || ctx.scope === "state") {
      disclaimers.push("Note: This data comes from the FBI's Supplementary Homicide Reports. Not all agencies report SHR data every year, so these counts underrepresent total homicides.");
    }

    // Florida gap
    if (/state\s*=\s*'FL'/i.test(sql) || (ctx.scope === "national" && !sqlLower.includes("state !="))) {
      disclaimers.push("Florida did not submit SHR data for most years between 1997 and 2020.");
    }

    // Offender demographics warning
    if (/\boff_race\b|\boff_sex\b|\boff_age/i.test(sql)) {
      disclaimers.push("Approximately 40% of homicide incidents have no recorded offender information. These results reflect only cases where offender demographics were recorded at the time of reporting.");
    }

    // Multi-year comparison
    const yearMatches = sql.match(/\b(19|20)\d{2}\b/g);
    if (yearMatches) {
      const years = [...new Set(yearMatches.map(Number))];
      if (years.length >= 2 && Math.max(...years) - Math.min(...years) > 5) {
        disclaimers.push("SHR reporting has changed over time. Changes in counts across years may partly reflect changes in agency reporting, not just changes in homicides.");
      }
    }

    // Partial year warning
    const currentYear = new Date().getFullYear();
    if (rows.some((r: Record<string, unknown>) => Number(r.year) >= currentYear - 1)) {
      disclaimers.push(`Data for ${currentYear - 1} and ${currentYear} may be incomplete as not all agencies have submitted their reports.`);
    }

    let explanation = claude.explanation || "";
    if (disclaimers.length > 0) {
      explanation = explanation + "\n\n" + disclaimers.join(" ");
    }

    logQuery(question, sql, rows.length, null, totalMs, explanation, "shr", guardrailResult.fired, "haiku-4.5", sessionId);

    return jsonResp({
      success: true,
      question,
      sql,
      explanation,
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
