import { NextRequest, NextResponse } from "next/server";
import { getShrDb } from "@/lib/shr-db";
import { validatePageToken } from "@/lib/page-token";
import { validateAndSanitize } from "@/lib/sql-safety";
import { logQuery } from "@/lib/rtci-db";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkSessionLimit, maybeCleanup } from "@/lib/captcha";
import { extractQueryContext } from "@/lib/query-context";
import { runGuardrails } from "@/lib/guardrails";
import type { QueryError } from "@/lib/types";
import { sanitizeExplanation, validateExplanationCount } from "@/lib/explain";
import Anthropic from "@anthropic-ai/sdk";
import { getShrSystemPrompt } from "@/lib/shr-claude";
import { getCached, setCache } from "@/lib/response-cache";
import { extractJson } from "@/lib/extract-json";
import { detectAllNullData } from "@/lib/all-null-detection";
import { checkSingleRowTrend } from "@/lib/single-row-trend";
import { detectYearSeriesChart } from "@/lib/chart-auto-detect";
import { parseRoutingLogMeta } from "@/lib/routing-log-meta";
import { answerMetadataQuestion } from "@/lib/metadata-coverage";
import { validateTablesForTab } from "@/lib/table-allowlist";
import { applyResultDisclosures } from "@/lib/result-disclosure";
import { appendShrAgencyProbeCaveat, isZeroResult, runShrAgencyProbe } from "@/lib/shr-agency-probe";
import { normalizeHistoryForTab } from "@/lib/chat-history";
import { detectFollowupTransform } from "@/lib/followup-transform";

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

    const history = normalizeHistoryForTab(body?.history, "shr");
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
      tabName: string = "shr",
      guardrails: string[] = [],
      model: string | null = null,
      sid: string | null = null
    ) => logQuery(q, sqlText, rowCount, logError, ms, logResponse, tabName, guardrails, model, sid, routingMeta);

    const metadata = answerMetadataQuestion("shr", question, getShrDb());
    if (metadata) {
      const executionMs = Date.now() - start;
      writeLog(question, metadata.sql, metadata.rowCount, null, executionMs, metadata.explanation, "shr", ["deterministic-metadata"], "deterministic", sessionId);
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

    // Deterministic nonfatal shooting refusal
    const asksShooting = /\b(shootings?|shot\b|gunshot|people\s+shot|gun\s+violence)\b/i.test(question);
    const wantsNonfatal = /\b(nonfatal|non-fatal|non fatal|shooting incidents?|people\s+shot|gunshot (wound|victim)|shot and (survived|wounded|injured))\b/i.test(question);
    if (asksShooting && wantsNonfatal) {
      const refusal = "This database does not track nonfatal shootings. The SHR (Supplementary Homicide Reports) only covers fatal outcomes - murders and manslaughters. For nonfatal shooting data, sources like the Gun Violence Archive or CDC WISQARS may be more appropriate. I can show you fatal shootings (firearm homicides) if that would be helpful.";
      writeLog(question, null, 0, "nonfatal_shooting_refusal", Date.now() - start, refusal, "shr", [], "haiku-4.5", sessionId);
      return jsonResp({
        success: true, question, sql: null, explanation: refusal,
        title: "", columns: [], rows: [], rowCount: 0, truncated: false,
        chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
      });
    }

    // Deterministic fatal shooting handling — bypass Claude entirely
    // Route bare/ambiguous shooting queries directly to firearm homicide data
    if (asksShooting && !wantsNonfatal) {
      const cityMatch = question.match(/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
      const stateMatch = question.match(/\b([A-Z]{2})\b/) || question.match(/\bin\s+(\w+)\b/i);
      const yearMatch = question.match(/\bsince\s+(\d{4})\b/i) || question.match(/\bfrom\s+(\d{4})\b/i);
      const startYear = yearMatch ? parseInt(yearMatch[1]) : 2000;

      let whereClauses = ["i.homicide_type = 'Murder'", "i.weapon_group = 'Firearm'", `i.year >= ${startYear}`];
      let titlePlace = "Nationally";

      if (cityMatch) {
        const city = cityMatch[1];
        titlePlace = city;
        whereClauses.push(`i.agency = '${city.replace(/'/g, "''")}'`);
        whereClauses.push("(i.agency_type = 'City' OR i.agency_type IS NULL OR i.agency_type = '')");
        // Add state if detected
        const stateAbbr = question.match(/\b([A-Z]{2})\b/);
        if (stateAbbr && stateAbbr[1] !== city.toUpperCase().slice(0, 2)) {
          whereClauses.push(`i.state = '${stateAbbr[1]}'`);
        }
      } else if (stateMatch && /^[A-Z]{2}$/.test(stateMatch[1])) {
        titlePlace = stateMatch[1];
        whereClauses.push(`i.state = '${stateMatch[1]}'`);
      }

      const sql = `SELECT i.year, COUNT(*) AS fatal_shootings FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE ${whereClauses.join(" AND ")} GROUP BY i.year ORDER BY i.year LIMIT 1000`;
      const title = `Fatal Shootings (Firearm Homicides), ${titlePlace}, ${startYear}-Present`;
      const explanation = `Fatal shootings (firearm homicides) by year${titlePlace !== "Nationally" ? ` in ${titlePlace}` : ""} since ${startYear}. This shows only homicides where the weapon was a firearm - nonfatal shootings are not tracked in this database.`;

      // Execute the deterministic SQL
      const db = getShrDb();
      if (!db) {
        return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
      }
      try {
        const rows = db.prepare(sql).all() as Record<string, unknown>[];
        const columns = rows.length > 0 ? Object.keys(rows[0]) : ["year", "fatal_shootings"];

        // Add caveats
        const caveats = [explanation];
        caveats.push("Not all agencies and states report SHR data every year, so these counts underrepresent total fatal shootings.");
        const totalExplanation = caveats.join("\n\n");

        writeLog(question, sql, rows.length, null, Date.now() - start, totalExplanation, "shr", ["deterministic-shooting"], "deterministic", sessionId);
        return jsonResp({
          success: true, question, sql, explanation: totalExplanation,
          title, columns, rows, rowCount: rows.length, truncated: false,
          chartConfig: { type: "line", xAxis: "year", yAxis: ["fatal_shootings"], yAxisLabel: "Fatal Shootings", title: "" },
          chartMeta: { source: "FBI SHR", agencyCount: 0, population: null },
          executionTimeMs: Date.now() - start,
        });
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        writeLog(question, sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", ["deterministic-shooting"], "deterministic", sessionId);
        return jsonResp({ success: false, error: `Database error: ${msg}` } as QueryError, 500);
      }
    }

    // Check response cache (only for standalone questions, not follow-ups)
    const cached = promptHistory.length === 0 ? getCached(question, "shr") : null;

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
    // Rewrite shooting queries to use firearm homicide language the model understands
    let queryForModel = question;
    if (asksShooting && !wantsNonfatal) {
      queryForModel = question
        .replace(/\bshootings?\b/gi, "firearm homicides")
        .replace(/\bshot and killed\b/gi, "killed with a firearm")
        .replace(/\bgun violence\b/gi, "firearm homicides")
        .replace(/\bgunshot\b/gi, "firearm homicide");
      if (queryForModel === question) {
        // Fallback: append instruction
        queryForModel = question + " [Interpret as firearm homicides: filter weapon_group = 'Firearm'. Title must say 'Fatal Shootings' or 'Firearm Homicides'.]";
      }
      console.log(`[shr][shooting-rewrite] Original: "${question}" → Rewritten: "${queryForModel}"`);
    }
    const messages: Anthropic.MessageParam[] = [
      ...promptHistory.map((h: { role: string; content: string }) => ({
        role: h.role as "user" | "assistant",
        content: h.content,
      })),
      { role: "user", content: queryForModel },
    ];

    if (cached) {
      claude = { sql: cached.sql, explanation: cached.explanation, title: cached.title, chartType: cached.chartType, xAxis: cached.xAxis, yAxis: cached.yAxis, yAxisLabel: cached.yAxisLabel };
    } else {
      // Step 1: Translate to SQL via Claude

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: [{ type: "text", text: getShrSystemPrompt(), cache_control: { type: "ephemeral" } }],
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

      // Text-only response — retry if model incorrectly claims an AGENCY isn't available
      // Do NOT retry when model correctly refuses non-homicide queries (theft, assault, etc.)
      if (!claude.sql) {
        const refusalPatterns = /not (appear|be represented)|doesn't appear|not (in|included in) (this|the|our) (dataset|data|sample|library)|no data (for|available|found)|does not (yet )?(have|include|cover)|not available|not yet (include|available|have)|latest available data|isn't (in|included)|not found in/i;
        // Skip retry if the refusal is about SHR's scope (non-homicide data) — these are correct refusals
        const scopeRefusal = /only (homicides?|murders?|manslaughter)|does(?:n't| not)\s+(?:include|contain|track|cover|have)\s+.*?\b(theft|robbery|assault|burglary|property|arrests?|drugs?|clearance|staffing|officers?|sworn|personnel|employment|auto theft|motor vehicle|violent crime|property crime|non-homicide|rape)\b|homicides only|murder and manslaughter only/i;
        const isCorrectScopeRefusal = scopeRefusal.test(claude.explanation || "");
        if (refusalPatterns.test(claude.explanation || "") && !isCorrectScopeRefusal) {
          try {
            const retryMessages: Anthropic.MessageParam[] = [
              ...messages,
              { role: "assistant", content: claude.explanation },
              { role: "user", content: "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. NEVER assume an agency is missing. Always generate a SQL query and let the database answer. Try the query now.]" },
            ];
            const retryResp = await client.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 2000,
              system: [{ type: "text", text: getShrSystemPrompt(), cache_control: { type: "ephemeral" } }],
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
        writeLog(question, null, 0, null, claudeMs, claude.explanation, "shr", [], "haiku-4.5", sessionId);
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
    }

    // Step 2: Validate SQL
    const validation = validateAndSanitize(claude.sql!);
    if (!validation.valid) {
      writeLog(question, claude.sql, 0, `Validation: ${validation.error}`, Date.now() - start, null, "shr", [], "haiku-4.5", sessionId);
      return jsonResp(
        { success: false, error: "I generated an invalid query. Please try rephrasing your question.", sql: claude.sql } as QueryError,
        400
      );
    }

    let sql = validation.sanitized!;

    {
      const tableDb = getShrDb();
      if (tableDb) {
        const tableCheck = validateTablesForTab(sql, "shr", tableDb);
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
              system: getShrSystemPrompt(),
              messages: retryMessages,
            });
            const retryText = retryResp.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("");
            const retryClaude = extractJson(retryText) as Record<string, unknown> | null;
            if (retryClaude?.sql) {
              const retryValidation = validateAndSanitize(retryClaude.sql as string);
              if (retryValidation.valid) {
                const retrySql = retryValidation.sanitized!;
                const retryTableCheck = validateTablesForTab(retrySql, "shr", tableDb);
                if (retryTableCheck.ok) {
                  sql = retrySql;
                  claude.explanation = (retryClaude.explanation as string) || claude.explanation;
                  claude.title = (retryClaude.title as string) || claude.title;
                  claude.chartType = (retryClaude.chartType as string) || claude.chartType;
                  claude.xAxis = (retryClaude.xAxis as string) || claude.xAxis;
                  claude.yAxis = (retryClaude.yAxis as string[]) || claude.yAxis;
                } else {
                  const msg = "I couldn't build a valid query for the SHR database. Try rephrasing for homicide-specific data or switching to a different tab for broader crime totals.";
                  writeLog(question, retrySql, 0, `table_allowlist_second_failure:${retryTableCheck.unknown.join(",")}`, Date.now() - start, msg, "shr", [...tableCheck.fired, ...retryTableCheck.fired], "haiku-4.5", sessionId);
                  return jsonResp({ success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start });
                }
              }
            }
          } catch { /* fall through to friendly failure */ }

          const msg = "I couldn't build a valid query for the SHR database. Try rephrasing for homicide-specific data or switching to a different tab for broader crime totals.";
          writeLog(question, sql, 0, `table_allowlist:${tableCheck.unknown.join(",")}`, Date.now() - start, msg, "shr", tableCheck.fired, "haiku-4.5", sessionId);
          return jsonResp({ success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start });
        }
      }
    }

    // Step 2b: Run guardrails
    const ctx = extractQueryContext(sql, question, "shr");
    const guardrailResult = runGuardrails(ctx);
    if (guardrailResult.sql !== sql) {
      sql = guardrailResult.sql;
    }
    // Hard override — skip retry, return deterministic response
    if (guardrailResult.overrideResponse) {
      const overrideExplanation = guardrailResult.overrideResponse;
      writeLog(question, sql, 0, `guardrail_override:${guardrailResult.overrideGuardrail}`, Date.now() - start, overrideExplanation, "shr", guardrailResult.fired, "haiku-4.5", sessionId);
      return jsonResp({
        success: true,
        question,
        sql: null,
        explanation: overrideExplanation,
        title: "",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: Date.now() - start,
      });
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
        const retryClaude = extractJson(retryText) as Record<string, unknown> | null;
        if (retryClaude?.sql) {
          const retryValidation = validateAndSanitize(retryClaude.sql as string);
          if (retryValidation.valid) {
            sql = retryValidation.sanitized!;
            claude.explanation = (retryClaude.explanation as string) || claude.explanation;
            claude.title = (retryClaude.title as string) || claude.title;
            claude.chartType = (retryClaude.chartType as string) || claude.chartType;
            claude.xAxis = (retryClaude.xAxis as string) || claude.xAxis;
            claude.yAxis = (retryClaude.yAxis as string[]) || claude.yAxis;
          }
        }
      } catch {
        // Retry failed, proceed with original (possibly rewritten) SQL
      }
    }

    // Step 2c: Post-retry guardrail re-check
    {
      const postRetryCtx = extractQueryContext(sql, question, "shr");
      const postRetryResult = runGuardrails(postRetryCtx);
      if (postRetryResult.overrideResponse) {
        const msg = postRetryResult.overrideResponse;
        writeLog(question, sql, 0, `guardrail_override:${postRetryResult.overrideGuardrail}`, Date.now() - start, msg, "shr", postRetryResult.fired, "haiku-4.5", sessionId);
        return jsonResp({ success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start });
      }
      const rateStillBad = postRetryResult.fired.some(f => f.includes("rate-no-population"));
      if (rateStillBad && /\b(rates?|per\s*capita|per\s*100)/i.test(question)) {
        const msg = "I wasn't able to calculate a valid per-capita rate for this query. For murder rates, try the [Historical Library](/test?tab=historical) tab which has FBI statewide estimates.";
        writeLog(question, sql, 0, "rate_second_failure", Date.now() - start, msg, "shr", postRetryResult.fired, "haiku-4.5", sessionId);
        return jsonResp({ success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start });
      }
      if (postRetryResult.sql !== sql) sql = postRetryResult.sql;
    }

    // Step 3: Execute
    const db = getShrDb();
    if (!db) {
      return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
    }
    let rows: Record<string, unknown>[];
    try {
      rows = db.prepare(sql).all() as Record<string, unknown>[];
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      writeLog(question, sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", [], "haiku-4.5", sessionId);
      return jsonResp(
        { success: false, error: `Database error: ${msg}`, sql } as QueryError,
        500
      );
    }

    const executionMs = Date.now() - start;

    if (rows.length === 0) {
      let explanation = claude.explanation || "The query returned no results.";
      const probeResult = runShrAgencyProbe(db, sql);
      const guardrails = [...guardrailResult.fired];
      if (probeResult && probeResult.count > 0) {
        explanation = appendShrAgencyProbeCaveat(explanation, probeResult.probe.agency);
        guardrails.push("shr-agency-zero-probe");
      }
      writeLog(question, sql, 0, "empty_result", executionMs, explanation, "shr", guardrails, "haiku-4.5", sessionId);
      return jsonResp({
        success: true,
        question,
        sql,
        explanation,
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

    let columns = Object.keys(rows[0]);
    const zeroProbeResult = isZeroResult(rows, columns) ? runShrAgencyProbe(db, sql) : null;

    // Detect all-null data columns (query returned rows but no usable values)
    {
      const { allNull } = detectAllNullData(columns, rows);
      if (allNull) {
        const emptyMsg = "I ran that query but all the values came back empty — the math likely broke somewhere (like dividing by zero). Could you try asking that a different way?";
        writeLog(question, sql, 0, "all_null_columns", executionMs, emptyMsg, "shr", guardrailResult.fired, "haiku-4.5", sessionId);
        return jsonResp({
          success: true,
          question,
          sql,
          explanation: emptyMsg,
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
    }

    // Build chart config (match QueryResponse shape)
    // Auto-pivot long-format category data for charting
    // Detects (year, category_col, value_col) and pivots to (year, cat1, cat2, ...)
    const CATEGORY_COLS = ["sex", "race", "weapon_group", "circumstance_group", "off_race", "off_sex", "relationship", "relationship_group", "ethnicity", "off_ethnicity", "weapon", "agency", "state", "state_name"];
    const categorCol = columns.find(c => CATEGORY_COLS.includes(c));
    const numericCol = columns.find(c => c !== "year" && c !== "month" && !CATEGORY_COLS.includes(c) && typeof rows[0]?.[c] === "number");
    const hasYear = columns.includes("year");

    if (categorCol && numericCol && hasYear && rows.length > 1) {
      const categories = [...new Set(rows.map(r => String(r[categorCol] ?? "Unknown")))];
      // Only pivot if 2-15 categories (not rankings with 20+ values)
      if (categories.length >= 2 && categories.length <= 15) {
        const hasMonth = columns.includes("month");
        const keyFn = (r: Record<string, unknown>) => hasMonth ? `${r.year}_${r.month}` : `${r.year}`;
        const grouped = new Map<string, Record<string, unknown>>();

        for (const r of rows) {
          const key = keyFn(r);
          if (!grouped.has(key)) {
            const base: Record<string, unknown> = { year: r.year };
            if (hasMonth) base.month = r.month;
            grouped.set(key, base);
          }
          const catName = String(r[categorCol] ?? "Unknown").replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "_");
          grouped.get(key)![catName] = r[numericCol];
        }

        const pivotedRows = [...grouped.values()];
        if (pivotedRows.length > 0) {
          rows = pivotedRows as Record<string, unknown>[];
          columns = Object.keys(pivotedRows[0]);
          // Update chart config
          const yCols = columns.filter(c => c !== "year" && c !== "month");
          claude.yAxis = yCols;
          claude.xAxis = "year";
          if (!claude.chartType || claude.chartType === "none") {
            claude.chartType = yCols.length <= 3 ? "line" : "stacked_bar";
          }
          console.log(`[shr] Auto-pivoted: ${categories.length} categories → ${pivotedRows.length} rows`);
        }
      }
    }

    // Auto-detect chart type if Claude said "none" but data is chartable
    let autoChartType = claude.chartType || "none";
    let autoXAxis = claude.xAxis || columns[0];
    let autoYAxis = claude.yAxis || (columns.length > 1 ? [columns[columns.length - 1]] : []);
    if (autoChartType === "none" && rows.length > 1) {
      const autoChart = detectYearSeriesChart(columns, rows);
      if (autoChart) {
        autoChartType = autoChart.type;
        autoXAxis = autoChart.xAxis;
        autoYAxis = autoChart.yAxis;
      }
    }

    const chartConfig = {
      type: autoChartType,
      xAxis: autoXAxis,
      yAxis: autoYAxis,
      yAxisLabel: claude.yAxisLabel || undefined,
      title: "",
    };

    const totalMs = Date.now() - start;

    // Deterministic disclaimers based on query content
    const disclaimers: string[] = [];
    const sqlLower = sql.toLowerCase();

    // National/state scope disclaimer
    if (ctx.scope === "national" || ctx.scope === "state") {
      disclaimers.push("Not all agencies and states report SHR data every year, so these counts underrepresent total homicides.");
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

    // Known SHR reporting gaps — hardcoded major agencies with documented gaps
    const KNOWN_GAPS: Record<string, { agency: string; state: string; years: number[] }> = {
      "New York_NY": { agency: "New York", state: "NY", years: [2021] },
      "Los Angeles_CA": { agency: "Los Angeles", state: "CA", years: [2021] },
    };
    const sqlLowerGap = sql.toLowerCase();
    for (const [, gap] of Object.entries(KNOWN_GAPS)) {
      const agencyInSql = sqlLowerGap.includes(gap.agency.toLowerCase()) && sqlLowerGap.includes(`'${gap.state}'`.toLowerCase());
      if (!agencyInSql) continue;
      const gapYearsInResults = gap.years.filter(y =>
        rows.some((r: Record<string, unknown>) => Number(r.year) === y)
      );
      if (gapYearsInResults.length > 0) {
        // Check if the gap year has 0 or very low count
        for (const gapYear of gapYearsInResults) {
          const yearRows = rows.filter((r: Record<string, unknown>) => Number(r.year) === gapYear);
          const valueCols = columns.filter(c => c !== "year" && c !== "month" && c !== "state" && c !== "agency");
          const allZero = yearRows.every(r => valueCols.every(c => Number(r[c]) === 0 || r[c] === null));
          if (allZero) {
            disclaimers.push(`${gap.agency} did not submit SHR data in ${gapYear} — the zero shown for that year reflects missing reporting, not an absence of homicides.`);
          }
        }
      }
    }

    // Single-row trend warning
    const singleRowWarning = checkSingleRowTrend(question, rows.length);
    if (singleRowWarning) disclaimers.push(singleRowWarning);
    if (zeroProbeResult && zeroProbeResult.count > 0) {
      disclaimers.push(`Note: SHR contains records under similar agency names for ${zeroProbeResult.probe.agency}, so a zero result may reflect an agency-name or agency-type mismatch rather than no homicides.`);
      guardrailResult.fired.push("shr-agency-zero-probe");
    }

    // Shooting caveat — if user asked about shootings, label as fatal and note nonfatal exclusion
    if (asksShooting && !wantsNonfatal) {
      const hasFirearmFilter = /\bweapon_group\s*=\s*'Firearm'|weapon\s+LIKE\s+'%Firearm%'|weapon_group.*Firearm/i.test(sql);
      if (hasFirearmFilter) {
        disclaimers.push("These results show fatal shootings only (homicides where the weapon was a firearm). Nonfatal shootings are not included in this database.");
      } else {
        // Model may not have added firearm filter for bare "shootings" — add caveat anyway
        disclaimers.push("Interpreting 'shootings' as firearm homicides. This data covers fatal outcomes only - nonfatal shootings are not tracked in the SHR database.");
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

    // Fix SHR offender wording — off_age/off_sex/off_race are per-incident (primary offender only)
    if (/\boff_age_num\b/i.test(sql) || /\boff_age\b/i.test(sql) || /\boff_sex\b/i.test(sql) || /\boff_race\b/i.test(sql)) {
      // "homicides involving a juvenile offender" → "murder victims where the recorded offender was under 18"
      explanation = explanation
        .replace(/\bhomicides (?:involving|with) (?:a |an )?(?:juvenile|young|under.?18|minor)\s*offender/gi, "murder victims where the recorded offender was under 18")
        .replace(/\bcrimes (?:involving|with) (?:a |an )?(?:juvenile|young|under.?18|minor)\s*offender/gi, "murder victims where the recorded offender was under 18")
        .replace(/\bhomicides (?:involving|with) (?:any )?offender/gi, "murder victims where the recorded offender was")
        .replace(/\bshare of (?:homicides|murders|incidents) (?:involving|with)\b/gi, "share of murder victims where the recorded offender was");
    }

    // Fix hallucinated counts using distinct entity detection
    explanation = validateExplanationCount(explanation, rows as Record<string, unknown>[], columns);
    explanation = applyResultDisclosures({ explanation, question, sql, rows, tab: "shr" });

    // Sanitize any leaked SQL/JSON
    explanation = sanitizeExplanation(explanation);

    writeLog(question, sql, rows.length, null, totalMs, explanation, "shr", guardrailResult.fired, "haiku-4.5", sessionId);

    // Cache successful responses (only standalone questions)
    if (!cached && promptHistory.length === 0) {
      setCache(question, "shr", { sql, explanation: claude.explanation || "", title: claude.title, chartType: claude.chartType, xAxis: claude.xAxis, yAxis: claude.yAxis, yAxisLabel: claude.yAxisLabel });
    }

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
      chartMeta: { source: "FBI SHR", agencyCount: 0, population: null },
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
