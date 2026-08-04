import { NextRequest, NextResponse } from "next/server";
import { getHateCrimeDb } from "@/lib/hc-db";
import { neutralizeUnverifiedAvailabilityClaim } from "@/lib/refusal-safety";
import { validatePageToken } from "@/lib/page-token";
import { validateAndSanitize } from "@/lib/sql-safety";
import { validateSqlSchema } from "@/lib/schema-validation";
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
import { alignTitleYearRange, applyResultDisclosures, missingLowerBoundNote } from "@/lib/result-disclosure";
import { validateGrain } from "@/lib/requested-grain";
import { buildCompletenessAnswer, detectCompletenessQuestion, loadCompletenessRows } from "@/lib/completeness-intent";
import { normalizeHistoryForTab } from "@/lib/chat-history";
import { containsInternalLeak, INTERNAL_LEAK_SAFE_MESSAGE, sanitizeUserFacingNarrative } from "@/lib/scaffold-helpers";
import { buildNoSqlFallbackMessage } from "@/lib/refusal-safety";
import { applyGeoCorrection, geoCorrectionHint } from "@/lib/geo-correction";
import { detectFollowupTransform } from "@/lib/followup-transform";
import { applyChartCustomizations } from "@/lib/chart-customization";
import { getBlockingGeoClarification } from "@/lib/geo-resolver";
import { getCountyScopeClarification } from "@/lib/county-clarifier";
import { detectQueryBearingFollowup } from '@/lib/query-bearing-followup';
import { planFollowupSafe } from '@/lib/followup-planner';
import { buildCrossSourceFollowupTransform } from '@/lib/cross-source-followup';
import { plannerModeForSource } from '@/lib/followup-planner-mode';
import { detectSubCityGeographyOverride } from "@/lib/capability-overrides";
import {
  queryContractFailureMessage,
  queryContractGuardrails,
  validateQueryContractSql,
  type QueryContractSqlValidation,
} from "@/lib/query-contract-validator";
import { partialCoverageRetryPrompt } from "@/lib/source-year-overlap";
import { extractQueryContext } from "@/lib/query-context";
import { runGuardrails } from "@/lib/guardrails";
import { finalizeGuardrailTags } from "@/lib/guardrail-tag-state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonResp(data: Record<string, any> | QueryError, status = 200) {
  const payload: Record<string, any> = { ...(data as Record<string, any>) };
  if (typeof payload.explanation === 'string' || typeof payload.title === 'string') {
    const safe = sanitizeUserFacingNarrative(payload.explanation, payload.title);
    payload.explanation = safe.explanation;
    payload.title = safe.title;
  }
  return NextResponse.json(payload, { status });
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
    // Query-bearing follow-ups (prior SQL + a change request) must reach the
    // model path with history — never the standalone metadata/county shortcuts.
    const queryBearingFollowup = detectQueryBearingFollowup(question, body?.history);
    const plannerMode = plannerModeForSource('hate_crime');
    const followupPlan = plannerMode === 'off' ? null : planFollowupSafe(question, body?.history, 'hate_crime');
    if (followupPlan && plannerMode === 'compare') {
      console.log('[followup-planner][compare] ' + JSON.stringify({ source: 'hate_crime', kind: followupPlan.kind, changeKinds: followupPlan.changeKinds, plannedSource: followupPlan.source, sourceChanged: followupPlan.sourceChanged, legacyBearing: Boolean(queryBearingFollowup), q: question.slice(0, 160), reconstructed: followupPlan.reconstructedQuestion.slice(0, 200) }));
    }
    if (plannerMode === "authoritative" && followupPlan?.sourceChanged) {
      const explanation = "This follow-up is a better fit for the " + followupPlan.source + " source. Rerunning it there as: " + followupPlan.reconstructedQuestion;
      logQuery(question, null, 0, null, 0, explanation, "hate_crime", ["followup-source-switch"], "followup-planner", sessionId);
      return jsonResp({ success: true, question, sql: null, explanation, title: "Source switch", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: 0, sourceSwitch: { source: followupPlan.source, question: followupPlan.reconstructedQuestion } });
    }
    const followupTransform = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? followupPlan.transform : (detectFollowupTransform(question, history) ?? buildCrossSourceFollowupTransform(question, body?.history, "hate_crime"));
    const guardrailQuestion = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? followupPlan.reconstructedQuestion : (followupTransform?.contextQuestion ?? question);
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
    const routeGuardrailsFired: string[] = [];
    const recordContractValidation = (contractResult: QueryContractSqlValidation) => {
      const contractGuardrails = queryContractGuardrails(contractResult);
      if (contractGuardrails.length > 0) {
        for (const fired of contractGuardrails) {
          if (!routeGuardrailsFired.includes(fired)) routeGuardrailsFired.push(fired);
        }
      }
      if (contractResult.warnings.length > 0) {
        console.log(`[hate_crime][contract] Warnings: ${contractResult.warnings.join(", ")}`);
      }
    };
    const runContractValidation = (inputSql: string): QueryContractSqlValidation => {
      const contractResult = validateQueryContractSql({
        question: guardrailQuestion,
        source: "hate_crime",
        sql: inputSql,
        routingMeta,
      });
      recordContractValidation(contractResult);
      return contractResult;
    };
    const contractFailureResponse = (contractResult: QueryContractSqlValidation, logError: string, guardrails: string[] = []) => {
      const msg = queryContractFailureMessage(contractResult);
      if (!msg) return null;
      writeLog(question, contractResult.sql, 0, logError, Date.now() - start, msg, "hate_crime", [...new Set([...guardrails, ...routeGuardrailsFired])], "haiku-4.5", sessionId);
      return jsonResp({
        success: true,
        question,
        sql: null,
        explanation: msg,
        title: "",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: Date.now() - start,
      });
    };

      const planSaysQueryBearing = (plannerMode === 'authoritative' && followupPlan) ? followupPlan.kind === 'query_bearing' : Boolean(queryBearingFollowup);
  const capabilityOverride = detectSubCityGeographyOverride(question);
    if (capabilityOverride) {
      const executionMs = Date.now() - start;
      writeLog(question, null, 0, null, executionMs, capabilityOverride.explanation, "hate_crime", [capabilityOverride.guardrail], "deterministic", sessionId);
      return jsonResp({
        success: true,
        question,
        sql: null,
        explanation: capabilityOverride.explanation,
        title: capabilityOverride.title,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: executionMs,
      });
    }

    const completenessIntent = detectCompletenessQuestion(question);
    if (completenessIntent) {
      const completenessAnswer = buildCompletenessAnswer("hate_crime", loadCompletenessRows("hate_crime", getHateCrimeDb()), new Date().getFullYear(), completenessIntent.year);
      const executionMs = Date.now() - start;
      writeLog(question, null, 0, null, executionMs, completenessAnswer, "hate_crime", ["completeness-deterministic"], "deterministic", sessionId);
      return jsonResp({ success: true, question, sql: null, explanation: completenessAnswer, title: "Data completeness", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: executionMs });
    }

    const geoClarification = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? (followupPlan.chartOnly ? null : getBlockingGeoClarification(followupPlan.reconstructedQuestion)) : getBlockingGeoClarification(question);
    if (geoClarification) {
      const executionMs = Date.now() - start;
      writeLog(question, null, 0, null, executionMs, geoClarification.explanation, "hate_crime", [`geo:${geoClarification.issue.id}`], "deterministic", sessionId);
      return jsonResp({
        success: true,
        question,
        sql: null,
        explanation: geoClarification.explanation,
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

    const countyScope = planSaysQueryBearing ? null : getCountyScopeClarification(question, body?.history);
    if (countyScope) {
      const executionMs = Date.now() - start;
      writeLog(question, null, 0, null, executionMs, countyScope.explanation, "hate_crime", [`geo:${countyScope.id}`], "deterministic", sessionId);
      return jsonResp({
        success: true,
        question,
        sql: null,
        explanation: countyScope.explanation,
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

    const metadata = planSaysQueryBearing ? null : answerMetadataQuestion("hate_crime", question, getHateCrimeDb());
    if (metadata) {
      const executionMs = Date.now() - start;
      writeLog(question, metadata.sql, metadata.rowCount, null, executionMs, metadata.explanation, "hate_crime", ["deterministic-metadata", "metadata-coverage-answer"], "deterministic", sessionId);
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
      { role: "user", content: (() => {
        const correctionHint = geoCorrectionHint(question);
        if (correctionHint) routeGuardrailsFired.push("geo-typo-corrected");
        return applyGeoCorrection(question, correctionHint);
      })() },
    ];

    if (cached) {
      claude = { sql: cached.sql, explanation: cached.explanation, title: cached.title, chartType: cached.chartType, xAxis: cached.xAxis, yAxis: cached.yAxis, yAxisLabel: cached.yAxisLabel };
    } else {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: [{ type: "text", text: getHateCrimeSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
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
        const coverageRetryPrompt = partialCoverageRetryPrompt("hate_crime", question, claude.explanation);
        const refusalPatterns = /not (appear|be represented)|doesn't appear|not (in|included in) (this|the|our) (dataset|data|sample|library)|no data (for|available|found)|does not (have|include|cover)|not available|isn't (in|included)|not found in/i;
        const genericRetryPrompt = "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. Always generate a SQL query and let the database answer. Try the query now.]";
        const retryPrompt = coverageRetryPrompt ?? (refusalPatterns.test(claude.explanation || "") ? genericRetryPrompt : null);
        if (retryPrompt) {
          try {
            const retryMessages: Anthropic.MessageParam[] = [
              ...messages,
              { role: "assistant", content: claude.explanation },
              { role: "user", content: retryPrompt },
            ];
            const retryResp = await client.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 2000,
              system: [{ type: "text", text: getHateCrimeSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
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
        const serverAuthoredNoSql = false;
        if (containsInternalLeak(claude.explanation) || containsInternalLeak(claude.title)) { claude.explanation = INTERNAL_LEAK_SAFE_MESSAGE; claude.title = "Results"; routeGuardrailsFired.push("internal-leak-firewall"); }
        if (!serverAuthoredNoSql && !containsInternalLeak(claude.explanation) && !containsInternalLeak(claude.title)) { claude.explanation = buildNoSqlFallbackMessage("hate_crime"); routeGuardrailsFired.push("no-sql-server-template"); }
        claude.explanation = neutralizeUnverifiedAvailabilityClaim(claude.explanation, "Hate Crime");
        const textExplanation = hateCrimeCaveats("", claude.explanation);
        writeLog(question, null, 0, null, claudeMs, textExplanation, "hate_crime", routeGuardrailsFired, "haiku-4.5", sessionId);
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

    let initialContract = runContractValidation(validation.sanitized!);
    let sql = initialContract.sql;
    const initialContractBlock = initialContract.blockReasons.length > 0
      ? contractFailureResponse(initialContract, `contract_block:${initialContract.enforced.join(",")}`)
      : null;
    if (initialContractBlock) return initialContractBlock;

    if (initialContract.retryIssues.length > 0) {
      try {
        const retryMessages: Anthropic.MessageParam[] = [
          ...messages,
          { role: "assistant", content: text || JSON.stringify(claude) },
          { role: "user", content: initialContract.retryIssues.join("\n") },
        ];
        const retryResp = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2000,
          system: [{ type: "text", text: getHateCrimeSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages: retryMessages,
        });
        const retryText = retryResp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
        const retryClaude = extractJson(retryText) as Record<string, unknown> | null;
        if (retryClaude?.sql) {
          const retryValidation = validateAndSanitize(retryClaude.sql as string);
          if (retryValidation.valid) {
            initialContract = runContractValidation(retryValidation.sanitized!);
            sql = initialContract.sql;
            claude.explanation = (retryClaude.explanation as string) || claude.explanation;
            claude.title = (retryClaude.title as string) || claude.title;
            claude.chartType = (retryClaude.chartType as string) || claude.chartType;
            claude.xAxis = (retryClaude.xAxis as string) || claude.xAxis;
            claude.yAxis = (retryClaude.yAxis as string[]) || claude.yAxis;
          }
        }
      } catch { /* fall through to final contract block */ }

      const retryContractFailure = contractFailureResponse(initialContract, `contract_second_failure:${initialContract.enforced.join(",")}`);
      if (retryContractFailure) return retryContractFailure;
    }

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
              system: [{ type: "text", text: getHateCrimeSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
              messages: retryMessages,
            });
            const retryText = retryResp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
            const retryClaude = extractJson(retryText) as Record<string, unknown> | null;
            if (retryClaude?.sql) {
              const retryValidation = validateAndSanitize(retryClaude.sql as string);
              if (retryValidation.valid) {
                const retryContract = runContractValidation(retryValidation.sanitized!);
                let retrySql = retryContract.sql;
                const retryContractFailure = contractFailureResponse(retryContract, `contract_table_retry_failure:${retryContract.enforced.join(",")}`, tableCheck.fired);
                if (retryContractFailure) return retryContractFailure;
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

    // Shared SQL guardrails also apply to the dedicated Hate Crime route.
    // This prevents rolling queries from executing after collapsing monthly
    // windows into annual rows.
    {
      const guardrailResult = runGuardrails(extractQueryContext(sql, question, "hate_crime"));
      for (const fired of guardrailResult.fired) {
        if (!routeGuardrailsFired.includes(fired)) routeGuardrailsFired.push(fired);
      }
      sql = guardrailResult.sql;
      if (guardrailResult.overrideResponse) {
        const msg = guardrailResult.overrideResponse;
        writeLog(question, sql, 0, `guardrail_override:${guardrailResult.overrideGuardrail}`, Date.now() - start, msg, "hate_crime", routeGuardrailsFired, "haiku-4.5", sessionId);
        return jsonResp({ success: true, question, sql: null, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start });
      }
      if (guardrailResult.needsFix) {
        const msg = "I generated a rolling query at the wrong time grain. Please try the request again.";
        writeLog(question, sql, 0, `guardrail_block:${guardrailResult.fired.join(",")}`, Date.now() - start, msg, "hate_crime", routeGuardrailsFired, "haiku-4.5", sessionId);
        return jsonResp({ success: true, question, sql: null, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start });
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
      const executionContract = runContractValidation(sql);
      sql = executionContract.sql;
      const executionContractFailure = contractFailureResponse(executionContract, `contract_execution_failure:${executionContract.enforced.join(",")}`);
      if (executionContractFailure) return executionContractFailure;
      const schemaCheck = validateSqlSchema(db, sql);
      if (!schemaCheck.ok) {
        routeGuardrailsFired.push("schema-column-invalid");
        throw new Error("Schema validation failed: " + schemaCheck.error);
      }
      if (schemaCheck.corrected) {
        sql = schemaCheck.sql;
        routeGuardrailsFired.push("schema-column-corrected");
      }
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
          system: [{ type: "text", text: getHateCrimeSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages: retryMessages,
        });
        const retryText = retryResp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("");
        const retryClaude = extractJson(retryText) as Record<string, unknown> | null;
        if (retryClaude?.sql) {
          const retryValidation = validateAndSanitize(retryClaude.sql as string);
          if (retryValidation.valid) {
            const retryContract = runContractValidation(retryValidation.sanitized!);
            let retrySql = retryContract.sql;
            const retryContractFailure = contractFailureResponse(retryContract, `contract_db_retry_failure:${retryContract.enforced.join(",")}`);
            if (retryContractFailure) return retryContractFailure;
            const retrySchemaCheck = validateSqlSchema(db, retrySql);
            if (!retrySchemaCheck.ok) {
                  routeGuardrailsFired.push("schema-column-invalid");
                  throw new Error("Schema validation failed: " + retrySchemaCheck.error);
                }
            if (retrySchemaCheck.corrected) {
              retrySql = retrySchemaCheck.sql;
              routeGuardrailsFired.push("schema-column-corrected");
            }
            const retryRows = db.prepare(retrySql).all() as Record<string, unknown>[];
            rows = retryRows;
            sql = retrySql;
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
    // Align the title's year range to the returned data BEFORE building the
    // chart, so the rendered chart title (config.title) is corrected too.
    claude.title = alignTitleYearRange(claude.title, rows);
    // Build chart config
    const chartConfig = applyChartCustomizations({
      type: (claude.chartType || "none") as "bar" | "line" | "pie" | "stacked_bar" | "none",
      xAxis: claude.xAxis || columns[0],
      yAxis: claude.yAxis || (columns.length > 1 ? [columns[columns.length - 1]] : []),
      yAxisLabel: claude.yAxisLabel || undefined,
      // ChartPanel renders config.title — matches chart-config.ts / nibrs-chart-config.ts.
      title: claude.title || "Results",
    }, question);

    const totalMs = Date.now() - start;

    // Apply mandatory caveats
    let explanation = sanitizeExplanation(claude.explanation || "");
    explanation = hateCrimeCaveats(sql, explanation);
    explanation = applyResultDisclosures({ explanation, question, sql, rows, tab: "hate_crime" });
    if (missingLowerBoundNote(question, sql, rows)) routeGuardrailsFired.push("lower-bound-disclosed");
    const grainCheck = validateGrain(question, rows, sql);
    if (!grainCheck.ok && grainCheck.message) {
      explanation = grainCheck.message;
      routeGuardrailsFired.push("grain-mismatch");
    }

    const finalNarrative = sanitizeUserFacingNarrative(explanation, claude.title);
    if (finalNarrative.blocked) {
      routeGuardrailsFired.push("internal-leak-firewall-result");
      console.warn(`[hate_crime][internal-leak-firewall] Replaced result narrative: ${explanation}`);
    }
    explanation = finalNarrative.explanation || "";
    claude.title = finalNarrative.title || claude.title || "Results";
    claude.title = alignTitleYearRange(claude.title, rows);
    writeLog(question, sql, rows.length, null, totalMs, explanation, "hate_crime", finalizeGuardrailTags(routeGuardrailsFired, queryContractGuardrails(runContractValidation(sql))), "haiku-4.5", sessionId);

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
