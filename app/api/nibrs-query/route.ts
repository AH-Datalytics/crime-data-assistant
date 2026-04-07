import { NextRequest, NextResponse } from "next/server";
import { getNibrsDb, executeWithTimeout, logNibrsQuery } from "@/lib/nibrs-db";
import { translateToSql } from "@/lib/nibrs-claude";
import { validateAndSanitize } from "@/lib/sql-safety";
import { buildNibrsChartConfig } from "@/lib/nibrs-chart-config";
import { generateExplanation } from "@/lib/explain";
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

    // Step 2a: Fix non-standard state abbreviations in NIBRS data
    // Nebraska is stored as 'NB' (not standard 'NE'), Guam as 'GM' (not 'GU')
    sql = sql.replace(/state\s*=\s*'NE'/gi, "state = 'NB'");
    sql = sql.replace(/state\s*=\s*'GU'/gi, "state = 'GM'");

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

    // Step 2b2: Detect cross-level JOIN that multiplies rows (e.g., city-level summary JOINed with state-level summary)
    // This produces wildly inflated numbers (e.g., NYC murders × 50 states = 22x actual)
    const usesCitySummary = /\bsummary_victim_city_monthly\b/i.test(sql) || /\bsummary_city_monthly\b/i.test(sql);
    const usesStateSummaryAny = /\bsummary_victim_state_monthly\b/i.test(sql) || /\bsummary_state_monthly\b/i.test(sql);
    if (usesCitySummary && usesStateSummaryAny && /\bJOIN\b/i.test(sql)) {
      console.log(`[nibrs][safeguard] Cross-level JOIN detected (city + state summary tables). Retrying with separated queries.`);
      const retryResult = await translateToSql(
        question + "\n\n[SYSTEM: Your previous query JOINed city-level and state-level summary tables, which produces incorrect results due to row multiplication. For comparisons between a city and a state/national average, use separate subqueries or CTEs — one for the city data and one for the state/national data — then combine them. NEVER JOIN summary_victim_city_monthly with summary_victim_state_monthly directly.]",
        history
      );
      if (retryResult.sql) {
        const retryValidation = validateAndSanitize(retryResult.sql);
        if (retryValidation.valid) {
          sql = retryValidation.sanitized!;
          claude.explanation = retryResult.explanation;
          claude.chartHint = retryResult.chartHint;
          claude.xAxis = retryResult.xAxis;
          claude.yAxis = retryResult.yAxis;
          claude.title = retryResult.title;
          console.log(`[nibrs][safeguard] Cross-level JOIN retry succeeded`);
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

    // Step 2d: Detect "USA" or "United States" used as agency/city lookup for national data
    // Claude sometimes tries to look up national data as if "USA" is an agency name — retry with correct approach
    const looksUpUSA = /\b(city|agency_name)\s*=\s*'(USA|United States|US|National)'/i.test(sql) ||
      /agencies\s+WHERE.*'(USA|United States|UNITED STATES|National|NATIONAL)'/i.test(sql);
    if (looksUpUSA) {
      console.log(`[nibrs][safeguard] National data looked up as agency name, retrying with correct approach`);
      const retryResult = await translateToSql(
        question + "\n\n[SYSTEM: Do NOT look up 'USA' or 'United States' as a city or agency. For national totals, SUM across all states from the state-level summary table (summary_victim_state_monthly for person crimes, summary_state_monthly for property/society crimes). Do not filter by ori or city for national data.]",
        history
      );
      if (retryResult.sql) {
        const retryValidation = validateAndSanitize(retryResult.sql);
        if (retryValidation.valid && !/city\s*=\s*'(USA|United States)'/i.test(retryValidation.sanitized!)) {
          sql = retryValidation.sanitized!;
          claude.explanation = retryResult.explanation;
          claude.chartHint = retryResult.chartHint;
          claude.xAxis = retryResult.xAxis;
          claude.yAxis = retryResult.yAxis;
          claude.title = retryResult.title;
          console.log(`[nibrs][safeguard] USA agency lookup retry succeeded`);
        }
      }
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
    const postExplanation = await generateExplanation({
      question,
      columns,
      rows,
      rowCount: rows.length,
      disclaimers: cdeDisclaimers,
      preQueryExplanation: explanation,
      tab: "nibrs",
    });
    explanation = postExplanation;
    // Re-append CDE disclaimers if the post-query explanation didn't include them
    if (cdeDisclaimers && !explanation.includes("underreporting")) {
      explanation += "\n\n" + cdeDisclaimers;
    }
    const explainMs = Date.now() - explainStart;
    console.log(`[nibrs][timing] Post-query explanation: ${explainMs}ms`);

    // Append standard NIBRS disclaimer
    const nibrsDisclaimer = "Note: This data comes from the FBI's NIBRS program. Not all agencies report to this system, and some may have incomplete data — especially in their first year of NIBRS reporting. Always verify that reported offenses are not impacted by incomplete coverage.";
    if (!explanation.includes("FBI's NIBRS program")) {
      explanation += "\n\n" + nibrsDisclaimer;
    }

    // Log success (after CDE check so explanation includes any disclaimers)
    logNibrsQuery(question, sql, rows.length, null, claudeMs + executionTimeMs + explainMs, explanation);

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
