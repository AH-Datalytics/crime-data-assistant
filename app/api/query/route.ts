import { NextRequest } from "next/server";
import { getDb, logQuery } from "@/lib/rtci-db";
import { translateToSql, getHistoricalSystemPrompt } from "@/lib/claude";
import { validateAndSanitize } from "@/lib/sql-safety";
import { buildChartConfig } from "@/lib/chart-config";
import { checkRateLimit } from "@/lib/rate-limit";
import { RTCI } from "@/lib/dynamic-facts";
import { generateExplanation } from "@/lib/explain";
import type { StreamEvent, ChartMeta } from "@/lib/types";

function sseEvent(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

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
           JOIN agencies a ON a.ori = p.ori AND a.national_sample = 1
           WHERE p.year = ?`
        )
        .get(popYear) as { pop: number | null } | undefined;
      return { agencyCount: row?.cnt ?? 0, population: popRow?.pop ?? null };
    }

    // State queries (state_monthly table)
    const stateMatch = sql.match(/state\s*=\s*'([A-Z]{2})'/i);
    if (sqlLower.includes("state_monthly") && stateMatch) {
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
        const placeholders = agencies.map(() => "a.agency = ?").join(" OR ");
        const params: (string | number)[] = [popYear, ...agencies];
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

    const src = "FBI UCR";

    // National queries (state = 'United States')
    if (sqlLower.includes("'united states'")) {
      return { agencyCount: 0, population: null, source: src };
    }

    // State-level queries from historical_state_national
    if (sqlLower.includes("historical_state_national")) {
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
      return { agencyCount: agencies.length || 1, population: null, source: src };
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
  let body: Record<string, unknown>;

  try {
    body = await req.json();
    question = (body?.question as string)?.trim() || "";
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

  const stream = new ReadableStream({
    async start(controller) {
      let sql: string | null = null;
      const tab = body?.mode === "historical" ? "historical" : "current";
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

        const history = Array.isArray(body?.history) ? body.history : undefined;
        const isHistorical = body?.mode === "historical";
        const systemPrompt = isHistorical ? getHistoricalSystemPrompt() : undefined;
        const claude = await translateToSql(
          question,
          history as { role: "user" | "assistant"; content: string }[],
          systemPrompt
        );

        if (!claude.sql) {
          const ms = Date.now() - totalStart;
          logQuery(question, null, 0, null, ms, claude.explanation, tab);
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

        // Step 1b: Sanity-check Claude's response against the question
        const qLower = question.toLowerCase();
        const sqlLower = claude.sql.toLowerCase();
        const issues: string[] = [];

        // Check: user asked for rates but SQL has no population join
        if (/\b(rate|per capita|per 100k|per 100,000)\b/i.test(question) && !sqlLower.includes("population")) {
          issues.push("The user asked for rates/per capita but the SQL does not join population data.");
        }
        // Check: multi-agency comparison not pivoted (has GROUP BY ... agency but no CASE WHEN)
        if (/group by.*agency/i.test(claude.sql) && !/case\s+when/i.test(claude.sql) && (qLower.includes(" and ") || qLower.includes(" vs ") || qLower.includes(","))) {
          issues.push("Multi-agency comparison appears unpivoted (no CASE WHEN). The frontend requires pivoted columns.");
        }
        // Check: yAxis columns missing from SELECT
        if (claude.yAxis) {
          const yCols = claude.yAxis.split(",").map(c => c.trim().toLowerCase());
          for (const col of yCols) {
            if (col && !sqlLower.includes(col) && !sqlLower.includes(`as ${col}`)) {
              issues.push(`yAxis column "${col}" not found in SQL SELECT.`);
              break;
            }
          }
        }
        // Check: offense mentioned in question but no offense filter in SQL
        // Maps common crime terms to their expected SQL filter strings
        const offenseMap: [RegExp, string[]][] = [
          [/\bmurder|homicide\b/i, ["'murder'", "'09a'"]],
          [/\brape\b/i, ["'rape'", "'11a'"]],
          [/\brobbery|robberies\b/i, ["'robbery'", "'120'"]],
          [/\bassault\b/i, ["'aggravated assault'", "'13a'"]],
          [/\bburglary|burglaries\b/i, ["'burglary'", "'220'"]],
          [/\btheft(?!.*auto|.*motor|.*vehicle)|larceny|larcenies\b/i, ["'theft'", "'23h'", "'larceny'"]],
          [/\bauto theft|motor vehicle theft|car theft|vehicle theft\b/i, ["'motor vehicle theft'", "'240'"]],
        ];
        for (const [pattern, sqlTerms] of offenseMap) {
          if (pattern.test(question) && !sqlTerms.some(t => sqlLower.includes(t)) && !sqlLower.includes("offense")) {
            issues.push(`The user asked about "${question.match(pattern)?.[0]}" but the SQL has no offense filter. Add a WHERE clause filtering by the appropriate offense.`);
            break;
          }
        }
        // Check: multi-agency query on agency_monthly missing type filter
        // Cities like Los Angeles, Baltimore, El Paso, etc. have both City and County entries
        if (sqlLower.includes("agency_monthly") && /case\s+when/i.test(claude.sql) && !sqlLower.includes("type")) {
          const ambiguousCities = ["los angeles", "baltimore", "el paso", "sacramento", "san diego", "san mateo", "santa cruz", "st louis", "alameda", "denton", "greenville", "hamilton", "kalamazoo", "st charles", "tulare"];
          const mentionedAmbiguous = ambiguousCities.filter(c => sqlLower.includes(`'${c}'`));
          if (mentionedAmbiguous.length > 0) {
            issues.push(`Multi-agency query includes ${mentionedAmbiguous.join(", ")} which have both City and County agencies, but no type filter was found. Add AND type = 'City' (or 'County') in each CASE WHEN branch and WHERE condition to avoid mixing jurisdictions.`);
          }
        }

        // If issues found, ask Claude to fix
        if (issues.length > 0) {
          controller.enqueue(
            encoder.encode(
              sseEvent({ type: "status", text: "Refining query..." })
            )
          );
          const fixPrompt = `Your SQL has these issues:\n${issues.map(i => `- ${i}`).join("\n")}\n\nPlease fix the SQL and return corrected JSON.`;
          const fixHistory = [
            ...(history || []),
            { role: "user" as const, content: question },
            { role: "assistant" as const, content: JSON.stringify(claude) },
            { role: "user" as const, content: fixPrompt },
          ];
          const fixed = await translateToSql(fixPrompt, fixHistory, systemPrompt);
          if (fixed.sql) {
            claude.sql = fixed.sql;
            claude.explanation = fixed.explanation;
            claude.chartHint = fixed.chartHint;
            claude.xAxis = fixed.xAxis;
            claude.yAxis = fixed.yAxis;
            claude.title = fixed.title;
            claude.colors = fixed.colors;
            claude.yAxisLabel = fixed.yAxisLabel;
            claude.xAxisLabel = fixed.xAxisLabel;
            claude.annotations = fixed.annotations;
          }
        }

        controller.enqueue(
          encoder.encode(
            sseEvent({ type: "status", text: "Running query..." })
          )
        );

        // Step 2: Validate SQL
        const validation = validateAndSanitize(claude.sql);
        if (!validation.valid) {
          const ms = Date.now() - totalStart;
          logQuery(
            question,
            claude.sql,
            0,
            `Validation: ${validation.error}`,
            ms,
            null,
            tab
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
          const msg =
            dbErr instanceof Error ? dbErr.message : String(dbErr);
          // Retry: tell Claude about the error and ask for a corrected query
          controller.enqueue(
            encoder.encode(
              sseEvent({ type: "status", text: "Retrying with corrected query..." })
            )
          );
          const retryHistory = [
            ...(history || []),
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
            const retryValidation = validateAndSanitize(retry.sql);
            if (retryValidation.valid) {
              try {
                const retryStmt = db.prepare(retryValidation.sanitized!);
                const retryResult = retryStmt.all() as Record<
                  string,
                  unknown
                >[];
                columns = retryStmt.columns().map((c) => c.name);
                rows = retryResult;
                sql = retryValidation.sanitized!;
                claude.explanation = retry.explanation;
                claude.chartHint = retry.chartHint;
                claude.xAxis = retry.xAxis;
                claude.yAxis = retry.yAxis;
                claude.title = retry.title;
                claude.colors = retry.colors;
                claude.yAxisLabel = retry.yAxisLabel;
                claude.xAxisLabel = retry.xAxisLabel;
                claude.annotations = retry.annotations;
              } catch (retryErr) {
                const retryMsg =
                  retryErr instanceof Error
                    ? retryErr.message
                    : String(retryErr);
                const ms = Date.now() - totalStart;
                logQuery(
                  question,
                  sql,
                  0,
                  `DB retry failed: ${retryMsg}`,
                  ms,
                  null,
                  tab
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
              logQuery(
                question,
                sql,
                0,
                `DB: ${msg} (retry validation failed)`,
                ms,
                null,
                tab
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
            logQuery(question, sql, 0, `DB: ${msg}`, ms, null, tab);
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

        const executionTimeMs = Date.now() - dbStart;
        const totalMs = Date.now() - totalStart;

        // Step 4: Handle empty results
        if (rows.length === 0) {
          const agencyName = extractAgencyName(sql);
          let emptyMsg: string;

          if (agencyName) {
            const similar = findSimilarAgencies(db, agencyName, isHistorical);
            if (similar.length === 0) {
              emptyMsg = `"${agencyName}" is not in our dataset of ~${RTCI.agencyCount} agencies. Our data covers major U.S. cities and counties — not every jurisdiction is included. Try asking about a larger city or browsing national/state-level trends.`;
            } else {
              const exactMatch = similar.find(
                (s) =>
                  s.agency.toLowerCase() === agencyName.toLowerCase()
              );
              if (exactMatch) {
                emptyMsg = `${exactMatch.agency}, ${exactMatch.state} is in our dataset, but no data was found for that specific query. The agency may not report this offense, or the date range may not have data. Try a different offense or broader date range.`;
              } else {
                const suggestions = similar
                  .map((s) => `${s.agency}, ${s.state}`)
                  .join("; ");
                emptyMsg = `"${agencyName}" wasn't found in our dataset. Did you mean: ${suggestions}? Our data covers ~${RTCI.agencyCount} major agencies across ${RTCI.stateCount} states.`;
              }
            }
          } else {
            emptyMsg =
              "This query returned no results. The data may not be available for the specified criteria. Try broadening your search or asking about a different topic.";
          }

          logQuery(question, sql, 0, "empty_result", totalMs, emptyMsg, tab);
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
          (c) => c === "agency" || c === "agency_name"
        );
        const valueCol = columns.find(
          (c) =>
            c !== "agency" &&
            c !== "agency_name" &&
            c !== "year" &&
            c !== "month" &&
            typeof rows[0]?.[c] === "number"
        );
        const hasYear = columns.includes("year");

        if (agencyCol && valueCol && hasYear && rows.length > 1) {
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

        // Step 5: Build chart config + metadata
        const chartConfig = buildChartConfig(claude, columns, rows);
        const chartMeta = isHistorical ? getHistoricalChartMeta(db, sql) : getChartMeta(db, sql);
        const truncated = rows.length >= 1000;

        // Step 5b: Generate post-query explanation with actual results
        controller.enqueue(
          encoder.encode(
            sseEvent({ type: "status", text: "Preparing results..." })
          )
        );
        // Extract any "Note:" disclaimers from the pre-query explanation to preserve them
        const disclaimerMatches = claude.explanation.match(/Note:.*$/gm) || [];
        const postExplanation = await generateExplanation({
          question,
          columns,
          rows,
          rowCount: rows.length,
          disclaimers: disclaimerMatches.join("\n"),
          preQueryExplanation: claude.explanation,
          tab: tab as "current" | "historical",
        });
        claude.explanation = postExplanation;

        // Log success
        const totalMs2 = Date.now() - totalStart;
        logQuery(
          question,
          sql,
          rows.length,
          null,
          totalMs2,
          claude.explanation,
          tab
        );

        // Step 6: Send full result
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
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const ms = Date.now() - totalStart;
        logQuery(question, sql, 0, msg, ms, null, tab);
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
