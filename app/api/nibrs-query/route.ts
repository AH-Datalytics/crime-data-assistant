import { NextRequest, NextResponse } from "next/server";
import { getNibrsDb, executeWithTimeout, logNibrsQuery } from "@/lib/nibrs-db";
import { validatePageToken } from "@/lib/page-token";
import { translateToSql } from "@/lib/nibrs-claude";
import { validateAndSanitize } from "@/lib/sql-safety";
import { buildNibrsChartConfig } from "@/lib/nibrs-chart-config";
import { generateExplanation } from "@/lib/explain";
import { extractQueryContext } from "@/lib/query-context";
import { runGuardrails } from "@/lib/guardrails";
import { applyRetryMeta } from "@/lib/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkSessionLimit, maybeCleanup } from "@/lib/captcha";
import type { QueryResponse, QueryError } from "@/lib/types";
import { getCached, setCache } from "@/lib/response-cache";

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
  // Rate limiting
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
        { success: false, error: "Question too long (max 2000 characters)" } as QueryError,
        400
      );
    }

    // Step 1: Translate to SQL via Claude (with conversation history for context)
    const history = Array.isArray(body?.history) ? body.history.slice(-6) : undefined;
    const claudeStart = Date.now();

    // Check response cache (only standalone questions)
    const cached = (!history || history.length === 0) ? getCached(question, "nibrs") : null;

    let claude: Awaited<ReturnType<typeof translateToSql>>;

    if (cached) {
      claude = { sql: cached.sql, explanation: cached.explanation, title: cached.title || "", chartHint: (cached.chartType as "bar" | "line" | "pie" | "stacked_bar" | "none") || "none", xAxis: cached.xAxis || "", yAxis: cached.yAxis?.[0] || "", colors: cached.colors as string[] | undefined, yAxisLabel: cached.yAxisLabel, xAxisLabel: cached.xAxisLabel, annotations: cached.annotations as typeof claude.annotations };
    } else {
      claude = await translateToSql(question, history);
      const claudeMs = Date.now() - claudeStart;
      console.log(`[nibrs][timing] Claude API: ${claudeMs}ms`);

      if (!claude.sql) {
        // Retry if model incorrectly claims data isn't available
        const refusalPatterns = /not (appear to be |be )?represented|not (in|included in) (this|the|our) (dataset|data|sample)|no data (for|available|found)|does not (have|include|cover)|not available in this/i;
        if (refusalPatterns.test(claude.explanation || "")) {
          try {
            const retryResult = await translateToSql(question, [
              ...(history || []),
              { role: "assistant", content: claude.explanation },
              { role: "user", content: "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. Please try generating a SQL query — search for the data rather than assuming it doesn't exist.]" },
            ]);
            if (retryResult.sql) {
              Object.assign(claude, retryResult);
            }
          } catch { /* use original */ }
        }
      }

      if (!claude.sql) {
        logNibrsQuery(question, null, 0, null, Date.now() - claudeStart, claude.explanation, [], "haiku-4.5", sessionId);
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
    }

    // Step 2: Validate SQL
    const validation = validateAndSanitize(claude.sql!);
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

    // Step 2a: Run shared guardrail pipeline
    const ctx = extractQueryContext(sql, question, "nibrs");
    const guardrailResult = runGuardrails(ctx);

    // Apply auto-rewrites (e.g., NE→NB state codes, state→city table fixes)
    if (guardrailResult.sql !== sql) {
      sql = guardrailResult.sql;
    }

    if (guardrailResult.fired.length > 0) {
      console.log(`[nibrs][guardrails] Fired: ${guardrailResult.fired.join(", ")}`);
    }

    // For NIBRS guardrails that need Claude retry, send all issues at once
    // so a single retry fixes everything (avoids cascading retries)
    if (guardrailResult.issues.length > 0) {
      const combinedIssues = guardrailResult.issues.join("\n\n");
      console.log(`[nibrs][guardrail-retry] Retrying with ${guardrailResult.issues.length} issue(s)`);
      const retryResult = await translateToSql(
        question + "\n\n" + combinedIssues,
        history
      );
      if (retryResult.sql) {
        const retryValidation = validateAndSanitize(retryResult.sql);
        if (retryValidation.valid) {
          sql = retryValidation.sanitized!;
          applyRetryMeta(claude, retryResult);
          console.log(`[nibrs][guardrail-retry] Succeeded`);
        }
      }
    }

    // Step 3: Execute SQL (in worker thread with 15s timeout)
    const startTime = Date.now();

    let rows: Record<string, unknown>[] = undefined!;
    let columns: string[] = undefined!;

    try {
      const result = await executeWithTimeout(sql);
      rows = result.rows;
      columns = result.columns;
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      const isTimeout = msg.includes("timed out");

      // Timeouts are often transient (contention, cold cache) — retry same SQL once before asking Claude to rewrite
      if (isTimeout) {
        console.log(`[nibrs][timeout-retry] First attempt timed out, retrying same SQL`);
        try {
          const retryResult = await executeWithTimeout(sql);
          rows = retryResult.rows;
          columns = retryResult.columns;
          console.log(`[nibrs][timeout-retry] Second attempt succeeded`);
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.log(`[nibrs][timeout-retry] Second attempt also failed: ${retryMsg}`);
        }
      }

      // If the same-SQL retry succeeded, skip Claude rewrite and continue to response
      if (!rows!) {
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
              applyRetryMeta(claude, retry);
              console.log(`[nibrs][error-recovery] Retry succeeded`);
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              logNibrsQuery(question, sql, 0, `DB retry failed: ${retryMsg}`, Date.now() - claudeStart, null, guardrailResult.fired, "haiku-4.5", sessionId);
              const userError = isTimeout
                ? `This query is too complex for the database. Try narrowing your request — for example, ask about a specific city, state, or shorter time range instead of a broad national query.`
                : msg.includes("no such column") || msg.includes("ambiguous")
                  ? `I had trouble building that query — the data may not support that exact breakdown. Try simplifying your question or asking about a broader category.`
                  : `I had trouble with that query. Try rephrasing your question or asking about a different aspect of the data.`;
              return jsonResp(
                { success: false, error: userError, sql } as QueryError,
                500
              );
            }
          } else {
            logNibrsQuery(question, sql, 0, `DB: ${msg} (retry validation failed)`, Date.now() - claudeStart, null, guardrailResult.fired, "haiku-4.5", sessionId);
            return jsonResp(
              { success: false, error: `I had trouble with that query. Try rephrasing your question.`, sql } as QueryError,
              500
            );
          }
        } else {
          logNibrsQuery(question, sql, 0, `DB: ${msg}`, Date.now() - claudeStart, null, guardrailResult.fired, "haiku-4.5", sessionId);
          return jsonResp(
            { success: false, error: isTimeout ? `This query is too complex for the database. Try asking about a specific city, state, or shorter time range.` : `Database error: ${msg}`, sql } as QueryError,
            500
          );
        }
      }
    }

    const executionTimeMs = Date.now() - startTime;

    // Step 4: Server-side CDE audit check — append disclaimer if anomalous underreporting detected
    let explanation = claude.explanation;
    const oris = new Set<string>();
    try {
      // Extract ORI(s) from SQL — look for ori = 'XX...' or ori IN ('XX...', ...)
      // but NOT ori IN (SELECT ...) which is a subquery, not literal values
      const oriMatches = sql.match(/ori\s*=\s*'([A-Z0-9]+)'/gi) || [];
      const oriInMatches = sql.match(/ori\s+IN\s*\((?!SELECT)([^)]+)\)/gi) || [];
      for (const m of oriMatches) {
        const val = m.match(/'([A-Z0-9]+)'/)?.[1];
        if (val) oris.add(val);
      }
      for (const m of oriInMatches) {
        const vals = m.match(/'([A-Z0-9]+)'/g) || [];
        for (const v of vals) {
          const val = v.replace(/'/g, '');
          if (val) oris.add(val);
        }
      }

      // Resolve ORI from subqueries or city name JOINs when no direct ORI found
      if (oris.size === 0) {
        try {
          const db = getNibrsDb();
          // Pattern 1: ori = (SELECT ori ...) or ori IN (SELECT ori ...)
          const subqueryMatch = sql.match(/ori\s*(?:=|IN)\s*\(\s*SELECT\s+ori\s+FROM\s+agencies\s+WHERE\s+city\s*=\s*'([^']+)'/i);
          // Pattern 2: city = 'X' (in a JOIN or WHERE on agencies table)
          const cityMatch = sql.match(/city\s*=\s*'([A-Z][A-Z ]+)'/i);
          const cityName = subqueryMatch?.[1] || cityMatch?.[1];

          if (cityName) {
            const stateMatch = sql.match(/state\s*=\s*'([A-Z]{2})'/i);
            let oriQuery = `SELECT ori FROM agencies WHERE city = ? ORDER BY year DESC, pop_group LIMIT 1`;
            const params: string[] = [cityName];
            if (stateMatch) {
              oriQuery = `SELECT ori FROM agencies WHERE city = ? AND state = ? ORDER BY year DESC, pop_group LIMIT 1`;
              params.push(stateMatch[1]);
            }
            const oriRow = db.prepare(oriQuery).get(...params) as { ori: string } | undefined;
            if (oriRow) oris.add(oriRow.ori);
          }
        } catch (e) {
          console.log(`[nibrs][cde-check] ORI resolution failed:`, e);
        }
      }

      // Extract offense codes from SQL
      const offenseCodes = new Set<string>();
      const codeMatches = sql.match(/ucr_offense_code\s*=\s*'([A-Z0-9]+)'/gi) || [];
      for (const m of codeMatches) {
        const val = m.match(/'([A-Z0-9]+)'/)?.[1];
        if (val) offenseCodes.add(val);
      }
      const codeInMatches = sql.match(/ucr_offense_code\s+IN\s*\(([^)]+)\)/gi) || [];
      for (const m of codeInMatches) {
        const vals = m.match(/'([A-Z0-9]+)'/g) || [];
        for (const v of vals) {
          const val = v.replace(/'/g, '');
          if (val) offenseCodes.add(val);
        }
      }

      if (oris.size > 0 && oris.size <= 3 && offenseCodes.size > 0) {
        const db = getNibrsDb();
        for (const ori of oris) {
          // Build WHERE clause for offense filter
          let cdeQuery = `SELECT year, offense_abbrev, cde_count, master_count, ratio, flagged FROM cde_agency_totals WHERE ori = ?`;
          const cdeParams: (string | number)[] = [ori];
          if (offenseCodes.size > 0) {
            const placeholders = Array.from(offenseCodes).map(() => '?').join(',');
            cdeQuery += ` AND offense_abbrev IN (${placeholders})`;
            cdeParams.push(...offenseCodes);
          }
          cdeQuery += ` ORDER BY year, offense_abbrev`;

          const cdeRows = db.prepare(cdeQuery).all(...cdeParams) as {
            year: number; offense_abbrev: string; cde_count: number;
            master_count: number; ratio: number; flagged: number;
          }[];

          if (cdeRows.length === 0) continue;

          const flaggedRows = cdeRows.filter(r => r.flagged === 1);
          if (flaggedRows.length === 0) continue;

          // Get city name
          const agencyRow = db.prepare(`SELECT city, state FROM agencies WHERE ori = ? AND year = 2024 LIMIT 1`).get(ori) as { city: string; state: string } | undefined;
          const cityName = agencyRow ? agencyRow.city.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ') : ori;

          // Group by offense to check anomalous vs structural per-offense
          const byOffense = new Map<string, { flaggedYears: number[]; totalYears: number }>();
          for (const r of cdeRows) {
            if (!byOffense.has(r.offense_abbrev)) byOffense.set(r.offense_abbrev, { flaggedYears: [], totalYears: 0 });
            byOffense.get(r.offense_abbrev)!.totalYears++;
          }
          for (const r of flaggedRows) {
            byOffense.get(r.offense_abbrev)?.flaggedYears.push(r.year);
          }

          // Look up offense names
          const offenseNames = new Map<string, string>();
          try {
            for (const code of byOffense.keys()) {
              const nameRow = db.prepare(`SELECT offense_name FROM nibrs_offense_codes WHERE code = ?`).get(code) as { offense_name: string } | undefined;
              if (nameRow) offenseNames.set(code, nameRow.offense_name.toLowerCase());
            }
          } catch { /* table might not exist */ }

          for (const [code, info] of byOffense) {
            if (info.flaggedYears.length === 0) continue;

            // If flagged in most years (>60%), it's structural — skip this offense
            if (info.flaggedYears.length / info.totalYears > 0.6) {
              console.log(`[nibrs][cde-check] ${ori} ${code}: structural (${info.flaggedYears.length}/${info.totalYears} years flagged), skipping`);
              continue;
            }

            const offenseName = offenseNames.get(code) || code;
            const yearStr = info.flaggedYears.join(', ');
            const disclaimer = `\n\n**Note: ${cityName} has been flagged as potentially underreporting ${offenseName} data to the NIBRS master files for ${yearStr}. See the Crime Data Explorer for more complete aggregated counts (where possible).**`;
            explanation += disclaimer;
            console.log(`[nibrs][cde-check] Added disclaimer for ${ori} ${code} years ${yearStr}`);
          }
        }
      }
    } catch (cdeErr) {
      console.log(`[nibrs][cde-check] Error:`, cdeErr);
    }

    // Step 4a2: Check agency_reporting_gaps for NIBRS transition years
    try {
      if (oris.size > 0 && oris.size <= 10) {
        const db = getNibrsDb();

        // Extract year range from SQL
        const yearMatches = sql.match(/\b(20\d{2}|19\d{2})\b/g) || [];
        const sqlYears = yearMatches.map(Number);
        // Also extract years from result rows
        const rowYears = rows
          .map((r: Record<string, unknown>) => {
            const y = r.year ?? r.data_year ?? r.Year;
            return typeof y === 'number' ? y : typeof y === 'string' ? parseInt(y) : NaN;
          })
          .filter((y: number) => !isNaN(y));
        const allYears = new Set([...sqlYears, ...rowYears]);

        for (const ori of oris) {
          const gapRows = db.prepare(
            `SELECT year, gap_type, severity, months_reported, expected_months
             FROM agency_reporting_gaps
             WHERE ori = ? AND (gap_type IN ('ramp_up', 'transition') OR severity = 'transition')
             ORDER BY year`
          ).all(ori) as { year: number; gap_type: string; severity: string; months_reported: number; expected_months: number }[];

          if (gapRows.length === 0) continue;

          // Check overlap with query years
          const overlappingYears = gapRows
            .filter(r => allYears.size === 0 || allYears.has(r.year))
            .map(r => r.year);

          if (overlappingYears.length === 0) continue;

          // Get city name
          const agencyRow = db.prepare(`SELECT city, state FROM agencies WHERE ori = ? AND year = 2024 LIMIT 1`).get(ori) as { city: string; state: string } | undefined;
          const cityName = agencyRow ? agencyRow.city.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ') : ori;

          const yearStr = overlappingYears.join(', ');
          explanation += `\n\n**Note: ${cityName} was transitioning to NIBRS reporting in ${yearStr} and data for those years is incomplete. Counts are significantly lower than actual crime levels.**`;
          console.log(`[nibrs][transition-check] Added transition warning for ${ori} years ${yearStr}`);
        }
      }
    } catch (transErr) {
      console.log(`[nibrs][transition-check] Error:`, transErr);
    }

    // Step 4b: Generate post-query explanation (with actual results + CDE disclaimers)
    // Extract any CDE disclaimers that were appended after the original explanation
    const cdeDisclaimers = explanation.slice(claude.explanation.length).trim();
    const explainStart = Date.now();
    // Re-extract context from final SQL (may have been fixed by guardrails/retry)
    const finalCtx = extractQueryContext(sql, question, "nibrs");
    const postExplanation = await generateExplanation({
      ctx: finalCtx,
      columns,
      rows,
      rowCount: rows.length,
      disclaimers: cdeDisclaimers,
      preQueryExplanation: explanation,
    });
    explanation = postExplanation;
    // Re-append CDE disclaimers if the post-query explanation didn't include them
    if (cdeDisclaimers && !explanation.includes("transitioning") && !explanation.includes("underreporting") && !explanation.includes("incomplete")) {
      explanation += "\n\n" + cdeDisclaimers;
    }
    const explainMs = Date.now() - explainStart;
    console.log(`[nibrs][timing] Post-query explanation: ${explainMs}ms`);

    // Append standard NIBRS disclaimer — skip if explanation already has a coverage/completeness note
    const nibrsDisclaimer = "Note: This data comes from the FBI's NIBRS program. Not all agencies report to this system, and some may have incomplete data — especially in their first year of NIBRS reporting. Always verify that reported offenses are not impacted by incomplete coverage.";
    const alreadyHasCoverageNote = /transitioning|underreporting|incomplete|not all agencies|coverage|did not report/i.test(explanation);
    if (!explanation.includes("FBI's NIBRS program") && !alreadyHasCoverageNote) {
      explanation += "\n\n" + nibrsDisclaimer;
    }

    // Log success (after CDE check so explanation includes any disclaimers)
    const totalMs = Date.now() - claudeStart;
    logNibrsQuery(question, sql, rows.length, null, totalMs, explanation, guardrailResult.fired, "haiku-4.5", sessionId);

    // Cache successful responses (only standalone questions)
    if (!cached && (!history || history.length === 0)) {
      setCache(question, "nibrs", { sql, explanation: claude.explanation, title: claude.title, chartType: claude.chartHint, xAxis: claude.xAxis, yAxis: claude.yAxis ? [claude.yAxis] : undefined, yAxisLabel: claude.yAxisLabel, xAxisLabel: claude.xAxisLabel, colors: claude.colors, annotations: claude.annotations });
    }

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
