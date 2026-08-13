import { NextRequest, NextResponse } from "next/server";
import { getShrDb } from "@/lib/shr-db";
import { validatePageToken } from "@/lib/page-token";
import { validateAndSanitize } from "@/lib/sql-safety";
import { validateSqlSchema } from "@/lib/schema-validation";
import { logQuery, logResolverWarnings } from "@/lib/rtci-db";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkSessionLimit, maybeCleanup } from "@/lib/captcha";
import { extractQueryContext } from "@/lib/query-context";
import { runGuardrails } from "@/lib/guardrails";
import { finalizeGuardrailTags } from "@/lib/guardrail-tag-state";
import { serializeChartConfigForLog } from "@/lib/chart-config-log";
import { attachChartAuditToPayload, createChartAuditRequestId } from "@/lib/chart-audit";
import { asksForCountsInsteadOfRates } from "@/lib/rate-intent";
import { explicitStateIntent } from "@/lib/explicit-state-intent";
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
import { applyResultDisclosures, missingLowerBoundNote } from "@/lib/result-disclosure";
import { validateGrain } from "@/lib/requested-grain";
import { buildCompletenessAnswer, detectCompletenessQuestion, loadCompletenessRows } from "@/lib/completeness-intent";
import { appendShrAgencyProbeCaveat, isZeroResult, runShrAgencyProbe } from "@/lib/shr-agency-probe";
import { neutralizeUnverifiedAvailabilityClaim } from "@/lib/refusal-safety";
import { normalizeHistoryAllSources, normalizeHistoryForTab } from "@/lib/chat-history";
import { containsInternalLeak, INTERNAL_LEAK_SAFE_MESSAGE, sanitizeUserFacingNarrative, sanitizeChartConfigTitle} from "@/lib/scaffold-helpers";
import { buildNoSqlFallbackMessage } from "@/lib/refusal-safety";
import { detectFollowupTransform } from "@/lib/followup-transform";
import { applyGeoCorrection, geoCorrectionHint } from "@/lib/geo-correction";
import { applyChartCustomizations } from "@/lib/chart-customization";
import { getBlockingGeoClarification } from "@/lib/geo-resolver";
import { getCountyScopeClarification } from "@/lib/county-clarifier";
import { detectQueryBearingFollowup } from '@/lib/query-bearing-followup';
import { planFollowupSafe } from '@/lib/followup-planner';
import { buildCrossSourceFollowupTransform } from '@/lib/cross-source-followup';
import { plannerModeForSource } from '@/lib/followup-planner-mode';
import { detectDemographicRateDenominatorFollowup, detectShrGroupRateOverride, detectSubCityGeographyOverride } from "@/lib/capability-overrides";
import { displayShrAgencyName, normalizeShrAgencyText } from "@/lib/shr-agency-normalization";
import { asksSimpleFirearmHomicideTrend } from "@/lib/shr-firearm-trend-intent";
import { displayPlace, shootingCityIntents, shootingYearIntent, stateMention } from "@/lib/shr-deterministic-shooting";
import { classifyShootingQualifier } from "@/lib/shooting-qualifiers";
import {
  queryContractFailureMessage,
  queryContractGuardrails,
  validateQueryContractSql,
  type QueryContractSqlValidation,
} from "@/lib/query-contract-validator";
import { partialCoverageRetryPrompt, sourceYearOverlap } from "@/lib/source-year-overlap";
import { buildShrCanonicalLabelCase, formatShrResolutionGuidance, resolveShrAgency, rewriteShrResolvedAgencyPredicates } from "@/lib/shr-place-resolver";
import { buildShrMurderPlan } from "@/lib/shr-deterministic-murder";
import {
  emitFactualPayload,
  finalizeProof,
  proofLogFields,
  type ProofFinalization,
  type ProofFinalizationInput,
  type SealedPayload,
} from "@/lib/proof-finalize";
import { sealPlanDerivation } from "@/lib/plan-derivation";
import { cacheValiditySignature } from "@/lib/proof-cache-validity";
import type { DeliveryAction } from "@/lib/proof-contract";
import { returnedEntityKeys } from "@/lib/result-disclosure";
import { boundedModelResponseJson } from "@/lib/no-sql-retry";
import { consolidatedDisplayText, normalizeConsolidatedDisplayRows } from "@/lib/agency-consolidations";
import { selectShrPivotMetric } from "@/lib/shr-category-pivot";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * THE CHOKEPOINT. Factual content is accepted only as a SealedPayload, which
 * lib/proof-finalize's emitFactualPayload() alone can produce; a QueryError
 * (success: false) asserts no facts and needs no proof. An unwrapped factual exit is
 * a compile error rather than a review finding -- see app/api/query/route.ts for why
 * requiring emitFactualPayload() to be *called* was not sufficient on its own.
 */
function jsonResp(data: SealedPayload<Record<string, any>> | QueryError, status = 200) {
  const payload: Record<string, any> = { ...(data as Record<string, any>) };
  if (typeof payload.explanation === 'string' || typeof payload.title === 'string') {
    const safe = sanitizeUserFacingNarrative(payload.explanation, payload.title);
    payload.explanation = safe.explanation ? consolidatedDisplayText(safe.explanation) : safe.explanation;
    payload.title = safe.title ? consolidatedDisplayText(safe.title) : safe.title;
  }
  if (Array.isArray(payload.rows)) payload.rows = normalizeShrDisplayRows(payload.rows);
  // ChartPanel renders chartConfig.title, which the sanitization above never
  // touched -- a leaking title was blanked in the header while the chart still
  // showed it. Applied here so every response path is covered.
  if (payload.chartConfig) {
    payload.chartConfig = sanitizeChartConfigTitle(payload.chartConfig);
    if (typeof payload.chartConfig?.title === "string") payload.chartConfig.title = consolidatedDisplayText(payload.chartConfig.title);
  }
  const finalized = payload.requestId
    ? attachChartAuditToPayload(payload, { source: "shr", requestId: payload.requestId })
    : payload;
  return NextResponse.json(finalized, { status });
}

function countyKey(value: string): string {
  return value
    .replace(/\b(county|parish|borough)\b/ig, " ")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function normalizeShrDisplayRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const agencyLikeColumns = new Set(["agency", "agency_name", "canonical_agency", "city"]);
  return normalizeConsolidatedDisplayRows(rows).map((row) => {
    let changed = false;
    const next: Record<string, unknown> = { ...row };
    for (const key of Object.keys(next)) {
      if (!agencyLikeColumns.has(key.toLowerCase())) continue;
      if (typeof next[key] !== "string") continue;
      const normalized = displayShrAgencyName(next[key]);
      if (normalized && normalized !== next[key]) {
        next[key] = normalized;
        changed = true;
      }
    }
    return changed ? next : row;
  });
}

function countyIntent(question: string): { key: string; display: string } | null {
  const match = /\b(?:in|within|inside|for|from|across|covering)\s+([A-Za-z][A-Za-z.' -]{1,80}?)\s+(County|Parish|Borough)\b/i.exec(question) ||
    /\b([A-Za-z][A-Za-z.' -]{1,80}?)\s+(County|Parish|Borough)\b/i.exec(question);
  if (!match) return null;
  const name = match[1].replace(/^\b(the|a|an)\b\s+/i, "").trim();
  const key = countyKey(name);
  return key ? { key, display: displayPlace(name) } : null;
}

function ambiguousKansasCityIntent(question: string): boolean {
  return /\bKansas City\b/i.test(question) &&
    !/\b(?:KCMO|KCK|Kansas City,\s*(?:MO|KS)|Kansas City,?\s+Missouri|Kansas City,?\s+Kansas)\b/i.test(question);
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
    const chartAuditRequestId = createChartAuditRequestId();
    let chartAuditQueryLogId: number | null = null;
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


    /**
     * The question the proof layer reasons about: the RECONSTRUCTED one for follow-ups.
     *
     * A bare fragment names no cities, so deriving requested entities from it would
     * lose the completeness check on a multi-city comparison. query_log still records
     * the RAW question, so the reviewer sees what the user typed.
     */
    let proofQuestion = question;

    /**
     * Validity signature for cached entries: enforcement state plus source data
     * version. A change to either produces a cache miss rather than replaying SQL
     * authored under conditions no longer in force (handoff §4, §13). dataVersion is
     * null until Stage 2 builds the source-health registry.
     */
    const cacheValidity = cacheValiditySignature("shr", null);


    /**
     * Proof finalization for one terminal exit of this route.
     *
     * This response is atomic, so there is no first-event ordering hazard --
     * applyResultDisclosures() already runs before delivery here (handoff §4). In
     * `off` mode this is a near-free sentinel.
     */
    const finalizeExit = (
      opts: Partial<ProofFinalizationInput> & { intendedAction: DeliveryAction },
    ): ProofFinalization =>
      finalizeProof({
        sourceId: "shr",
        question: proofQuestion,
        sql: null,
        rows: [],
        columns: [],
        truncated: false,
        planFamily: null,
        ...opts,
      });

    const history = normalizeHistoryForTab(body?.history, "shr");
    const demographicRateFollowup = detectDemographicRateDenominatorFollowup(question, normalizeHistoryAllSources(body?.history));
    // Query-bearing follow-ups (prior SQL + a change request) must reach the
    // model path with history — never the standalone metadata/county shortcuts.
    const queryBearingFollowup = detectQueryBearingFollowup(question, body?.history);
    const plannerMode = plannerModeForSource('shr');
    const followupPlan = plannerMode === 'off' ? null : planFollowupSafe(question, body?.history, 'shr');
    if (followupPlan && plannerMode === 'compare') {
      console.log('[followup-planner][compare] ' + JSON.stringify({ source: 'shr', kind: followupPlan.kind, changeKinds: followupPlan.changeKinds, plannedSource: followupPlan.source, sourceChanged: followupPlan.sourceChanged, legacyBearing: Boolean(queryBearingFollowup), q: question.slice(0, 160), reconstructed: followupPlan.reconstructedQuestion.slice(0, 200) }));
    }
    if (plannerMode === "authoritative" && followupPlan?.sourceChanged && !demographicRateFollowup) {
      const explanation = "This follow-up is a better fit for the " + followupPlan.source + " source. Rerunning it there as: " + followupPlan.reconstructedQuestion;
      const switchProof = finalizeExit({ intendedAction: "clarify", planFamily: "followup-source-switch", narrative: explanation });
      logQuery(question, null, 0, null, 0, explanation, "shr", ["followup-source-switch"], "followup-planner", sessionId, null, null, null, null, proofLogFields(switchProof));
      return jsonResp(emitFactualPayload(switchProof, { success: true, question, sql: null, explanation, title: "Source switch", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: 0, sourceSwitch: { source: followupPlan.source, question: followupPlan.reconstructedQuestion } }));
    }
    const followupTransform = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? followupPlan.transform : (detectFollowupTransform(question, history) ?? buildCrossSourceFollowupTransform(question, body?.history, "shr"));
    // Bare clarifier answers ("Countywide total") carry no county name — use
    // the transform's reconstructed question so guardrails see the geography
    const guardrailQuestion = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? followupPlan.reconstructedQuestion : (followupTransform?.contextQuestion ?? question);
    proofQuestion = guardrailQuestion;
    // Resolve named cities for initial questions as well as follow-ups. Restricting
    // this to follow-ups let ordinary multi-year questions keep model-authored
    // agency-name predicates and bypass verified consolidation ORIs.
    const followupCities = shootingCityIntents(guardrailQuestion);
    const followupDb = followupCities.length > 0 ? getShrDb() : null;
    const followupShrPlaces = followupDb && followupCities.length > 0 && followupCities.every((city) => city.state)
      ? followupCities.map((city) => resolveShrAgency(
        followupDb,
        city.agencyLike ? city.display : city.agency,
        city.state!,
        { kind: "city" },
      ))
      : [];
    const followupShrGuidance = formatShrResolutionGuidance(followupShrPlaces);
    const promptHistory = followupTransform
      ? [...history, { role: "user" as const, content: followupTransform.instruction }]
      : history;
    if (followupShrGuidance) promptHistory.push({ role: "user" as const, content: followupShrGuidance });
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
      sid: string | null = null,
      /** Phase 3 chart capture; pre-serialized via the allowlist in lib/chart-config-log. */
      chartConfigJson: string | null = null,
      /** Proof finalization for this exit; null yields baseline-identical columns. */
      proof: ProofFinalization | null = null,
      /** Bounded raw model text on no-SQL failures; diagnostic only, never user-visible. */
      modelResponseJson: string | null = null
    ) => {
      chartAuditQueryLogId = logQuery(q, sqlText, rowCount, logError, ms, logResponse, tabName, guardrails, model, sid, routingMeta, chartConfigJson, chartAuditRequestId, modelResponseJson, proofLogFields(proof));
      return chartAuditQueryLogId;
    };
    const routeGuardrailsFired: string[] = [];
    const recordContractValidation = (contractResult: QueryContractSqlValidation) => {
      const contractGuardrails = queryContractGuardrails(contractResult);
      if (contractGuardrails.length > 0) {
        for (const fired of contractGuardrails) {
          if (!routeGuardrailsFired.includes(fired)) routeGuardrailsFired.push(fired);
        }
      }
      if (contractResult.warnings.length > 0) {
        console.log(`[shr][contract] Warnings: ${contractResult.warnings.join(", ")}`);
      }
    };
    const runContractValidation = (inputSql: string): QueryContractSqlValidation => {
      const contractResult = validateQueryContractSql({
        question: guardrailQuestion,
        source: "shr",
        sql: inputSql,
        routingMeta,
      });
      recordContractValidation(contractResult);
      return contractResult;
    };
    const contractFailureResponse = (contractResult: QueryContractSqlValidation, logError: string, guardrails: string[] = []) => {
      const msg = queryContractFailureMessage(contractResult);
      if (!msg) return null;
      const contractProof = finalizeExit({ intendedAction: "decline_capability", sql: contractResult.sql, guardrails: [...new Set([...guardrails, ...routeGuardrailsFired])] });
      writeLog(question, contractResult.sql, 0, logError, Date.now() - start, msg, "shr", [...new Set([...guardrails, ...routeGuardrailsFired])], "haiku-4.5", sessionId, null, contractProof);
      return jsonResp(emitFactualPayload(contractProof, {
        success: true,
        question,
        sql: null as unknown as string,
        explanation: msg,
        title: "",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: Date.now() - start,
      }));
    };

      const planSaysQueryBearing = (plannerMode === 'authoritative' && followupPlan) ? followupPlan.kind === 'query_bearing' : Boolean(queryBearingFollowup);
    const capabilityOverride =
      demographicRateFollowup ??
      detectSubCityGeographyOverride(question) ??
      detectShrGroupRateOverride(question);
    if (capabilityOverride) {
      const executionMs = Date.now() - start;
      const capabilityProof = finalizeExit({ intendedAction: "decline_capability", planFamily: capabilityOverride.guardrail });
      writeLog(question, null, 0, null, executionMs, capabilityOverride.explanation, "shr", [capabilityOverride.guardrail], "deterministic", sessionId, null, capabilityProof);
      return jsonResp(emitFactualPayload(capabilityProof, {
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
        chartMeta: { source: "FBI SHR", agencyCount: 0, population: null },
        executionTimeMs: executionMs,
      }));
    }

    const completenessIntent = detectCompletenessQuestion(question);
    if (completenessIntent) {
      const completenessAnswer = buildCompletenessAnswer("shr", loadCompletenessRows("shr", getShrDb()), new Date().getFullYear(), completenessIntent.year);
      const executionMs = Date.now() - start;
      const completenessProof = finalizeExit({ intendedAction: "answer", planFamily: "completeness-deterministic", guardrails: ["completeness-deterministic"] });
      writeLog(question, null, 0, null, executionMs, completenessAnswer, "shr", ["completeness-deterministic"], "deterministic", sessionId, null, completenessProof);
      return jsonResp(emitFactualPayload(completenessProof, { success: true, question, sql: null, explanation: completenessAnswer, title: "Data completeness", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: executionMs }));
    }

    const geoClarification = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? (followupPlan.chartOnly ? null : getBlockingGeoClarification(followupPlan.reconstructedQuestion)) : getBlockingGeoClarification(question);
    if (geoClarification) {
      const executionMs = Date.now() - start;
      const geoProof = finalizeExit({ intendedAction: "clarify", planFamily: `geo:${geoClarification.issue.id}` });
      writeLog(question, null, 0, null, executionMs, geoClarification.explanation, "shr", [`geo:${geoClarification.issue.id}`], "deterministic", sessionId, null, geoProof);
      return jsonResp(emitFactualPayload(geoProof, {
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
      }));
    }

    const countyScope = planSaysQueryBearing ? null : getCountyScopeClarification(question, body?.history);
    if (countyScope) {
      const executionMs = Date.now() - start;
      const countyProof = finalizeExit({ intendedAction: "clarify", planFamily: `geo:${countyScope.id}` });
      writeLog(question, null, 0, null, executionMs, countyScope.explanation, "shr", [`geo:${countyScope.id}`], "deterministic", sessionId, null, countyProof);
      return jsonResp(emitFactualPayload(countyProof, {
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
      }));
    }

    const metadata = planSaysQueryBearing ? null : answerMetadataQuestion("shr", question, getShrDb());
    if (metadata) {
      const executionMs = Date.now() - start;
      const metadataProof = finalizeExit({ intendedAction: "answer", sql: metadata.sql, rows: metadata.rows ?? [], columns: metadata.columns ?? [], truncated: Boolean(metadata.truncated), derivation: metadata.sql ? sealPlanDerivation("metadata-coverage-answer", metadata.sql) : null, planFamily: "metadata-coverage-answer", guardrails: ["deterministic-metadata", "metadata-coverage-answer"], hasChart: Boolean(metadata.chartConfig), narrative: metadata.explanation });
      writeLog(question, metadata.sql, metadata.rowCount, null, executionMs, metadata.explanation, "shr", ["deterministic-metadata", "metadata-coverage-answer"], "deterministic", sessionId, serializeChartConfigForLog(metadata.chartConfig, metadata.columns, metadata.chartMeta), metadataProof);
      return jsonResp(emitFactualPayload(metadataProof, attachChartAuditToPayload({
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
      }, { source: "shr", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
    }

    // Exact-year city murder totals and monthly series use canonical SHR ORIs,
    // victim rows, and explicit zeroes instead of model-generated alias LIKEs.
    const murderDb = planSaysQueryBearing ? null : getShrDb();
    const murderPlan = murderDb ? buildShrMurderPlan(question, murderDb) : null;
    if (murderPlan?.kind === "blocked") {
      const executionMs = Date.now() - start;
      const placeBlockProof = finalizeExit({ intendedAction: "clarify", planFamily: "deterministic-murder", guardrails: ["deterministic-murder", "shr-place-resolution-block"], narrative: murderPlan.explanation });
      writeLog(question, null, 0, "shr_place_not_resolved", executionMs, murderPlan.explanation, "shr", ["deterministic-murder", "shr-place-resolution-block"], "deterministic", sessionId, null, placeBlockProof);
      return jsonResp(emitFactualPayload(placeBlockProof, {
        success: true, question, sql: null, explanation: murderPlan.explanation,
        title: "", columns: [], rows: [], rowCount: 0, truncated: false,
        chartConfig: null, chartMeta: null, executionTimeMs: executionMs,
      }));
    }
    if (murderPlan?.kind === "query" && murderDb) {
      const contract = runContractValidation(murderPlan.sql);
      const contractFailure = contractFailureResponse(contract, `contract_deterministic_murder_failure:${contract.enforced.join(",")}`, ["deterministic-murder"]);
      if (contractFailure) return contractFailure;
      try {
        const rows = normalizeShrDisplayRows(murderDb.prepare(contract.sql).all() as Record<string, unknown>[]);
        const explanation = `${murderPlan.explanation}\n\nNot all agencies report SHR data every month or year, so reported counts can understate actual murders.`;
        const executionMs = Date.now() - start;
        const coverageStatuses = [...new Set(rows.map((row) => String(row.shr_status || "")).filter(Boolean))];
        const coverageTags = coverageStatuses.map((status) => `shr-coverage-${status.replace(/_/g, "-")}`);
        if (rows.some((row) => row.murder_victims == null)) coverageTags.push("shr-coverage-presentation-changed");
        const chartConfig = applyChartCustomizations({
          type: murderPlan.chartType, xAxis: murderPlan.xAxis, yAxis: murderPlan.yAxis,
          yAxisLabel: "Murder Victims", title: murderPlan.title,
        }, question);
        const murderProof = finalizeExit({ intendedAction: rows.length > 0 ? "answer" : "decline_data", sql: contract.sql, rows, columns: murderPlan.columns, derivation: sealPlanDerivation("deterministic-murder", murderPlan.sql), planFamily: "deterministic-murder", guardrails: ["deterministic-murder", ...coverageTags, ...routeGuardrailsFired], returnedEntities: returnedEntityKeys(rows), narrative: explanation, hasChart: true, db: murderDb });
        writeLog(question, contract.sql, rows.length, null, executionMs, explanation, "shr", ["deterministic-murder", ...coverageTags, ...routeGuardrailsFired], "deterministic", sessionId, serializeChartConfigForLog(chartConfig, murderPlan.columns, { source: "FBI SHR", agencyCount: 0, population: null }), murderProof);
        return jsonResp(emitFactualPayload(murderProof, attachChartAuditToPayload({
          success: true, question, sql: contract.sql, explanation,
          title: murderPlan.title, columns: murderPlan.columns, rows,
          rowCount: rows.length, truncated: false,
          chartConfig,
          chartMeta: { source: "FBI SHR", agencyCount: 0, population: null },
          executionTimeMs: executionMs,
        }, { source: "shr", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        const murderDbProof = finalizeExit({ intendedAction: "decline_capability", sql: contract.sql, planFamily: "deterministic-murder" });
        writeLog(question, contract.sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", ["deterministic-murder"], "deterministic", sessionId, null, murderDbProof);
        return jsonResp({ success: false, error: `Database error: ${msg}` } as QueryError, 500);
      }
    }

    // Deterministic nonfatal shooting refusal
    const asksCityFirearmHomicideTrend =
      asksSimpleFirearmHomicideTrend(question) && shootingCityIntents(question).length > 0;
    const asksShooting =
      /\b(shootings?|shot\b|gunshot|people\s+shot|gun\s+violence)\b/i.test(question) ||
      asksCityFirearmHomicideTrend;
    const wantsNonfatal = /\b(nonfatal|non-fatal|non fatal|shooting incidents?|people\s+shot|gunshot (wound|victim)|shot and (survived|wounded|injured))\b/i.test(question);
    if (asksShooting && wantsNonfatal) {
      const refusal = "This database does not track nonfatal shootings. The SHR (Supplementary Homicide Reports) only covers fatal outcomes - murders and manslaughters. For nonfatal shooting data, sources like the Gun Violence Archive or CDC WISQARS may be more appropriate. I can show you fatal shootings (firearm homicides) if that would be helpful.";
      const nonfatalProof = finalizeExit({ intendedAction: "decline_capability", planFamily: "nonfatal-shooting-capability-limit", narrative: refusal });
      writeLog(question, null, 0, null, Date.now() - start, refusal, "shr", ["nonfatal-shooting-capability-limit"], "deterministic", sessionId, null, nonfatalProof);
      return jsonResp(emitFactualPayload(nonfatalProof, {
        success: true, question, sql: null, explanation: refusal,
        title: "", columns: [], rows: [], rowCount: 0, truncated: false,
        chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
      }));
    }

    // Deterministic fatal shooting handling — bypass Claude entirely
    // Route bare/ambiguous shooting queries directly to firearm homicide data
    // Qualifier awareness (production 7881). "police fatal shootings" used to
    // return ALL firearm homicides — 14,777 vs a correct 349 for 2023 — because
    // this path fires on any mention of "shooting" and has no notion of
    // qualifiers. Police is now expressible; anything else it cannot express
    // must fall through to the model rather than answer a different question.
    const shootingQualifier = classifyShootingQualifier(question);
    if (asksShooting && !wantsNonfatal && shootingQualifier.kind === "unsupported") {
      console.log(`[shr][deterministic-shooting] declining: unsupported qualifier(s) ${shootingQualifier.ids.join(",")} — routing to model`);
    }
    if (asksShooting && !wantsNonfatal && shootingQualifier.kind !== "unsupported" && !(plannerMode === "authoritative" && followupPlan?.kind === "query_bearing")) {
      const stateMatch = question.match(/\b([A-Z]{2})\b/) || question.match(/\bin\s+(\w+)\b/i);
      const yearIntent = shootingYearIntent(question);
      const wantsMonthly = /\b(?:monthly|per\s+month|by\s+month)\b/i.test(question);
      const yearOverlap = sourceYearOverlap("shr", question);
      if (yearOverlap && !yearOverlap.hasOverlap) {
        const explanation = `SHR homicide data covers ${yearOverlap.sourceStartYear}-${yearOverlap.sourceEndYear}, so it cannot answer the requested year range. Ask for fatal shootings from ${yearOverlap.sourceStartYear} onward.`;
        const yearOverlapProof = finalizeExit({ intendedAction: "decline_data", planFamily: "deterministic-shooting", guardrails: ["deterministic-shooting", "shr-year-no-overlap"], narrative: explanation });
        writeLog(question, null, 0, "year_range_no_overlap", Date.now() - start, explanation, "shr", ["deterministic-shooting", "shr-year-no-overlap"], "deterministic", sessionId, null, yearOverlapProof);
        return jsonResp(emitFactualPayload(yearOverlapProof, {
          success: true, question, sql: null, explanation,
          title: "Year range not available in SHR", columns: [], rows: [], rowCount: 0, truncated: false,
          chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
        }));
      }
      const effectiveYearClause = yearOverlap?.partial
        ? `i.year BETWEEN ${yearOverlap.overlapStartYear} AND ${yearOverlap.overlapEndYear}`
        : yearIntent.clause;
      const effectiveYearLabel = yearOverlap?.partial
        ? `${yearOverlap.overlapStartYear}-${yearOverlap.overlapEndYear}`
        : yearIntent.label;
      const effectiveYearExplanation = yearOverlap?.partial
        ? `from ${yearOverlap.overlapStartYear} to ${yearOverlap.overlapEndYear}`
        : yearIntent.explanation;
      const overlapDisclosure = yearOverlap?.partial
        ? `Requested years outside SHR coverage (${yearOverlap.sourceStartYear}-${yearOverlap.sourceEndYear}) were omitted; returned years ${yearOverlap.overlapStartYear}-${yearOverlap.overlapEndYear}.`
        : "";

      const whereClauses = ["i.homicide_type = 'Murder'", "i.weapon_group = 'Firearm'", effectiveYearClause];
      // All 18,697 'Felon Killed by Police' incidents are homicide_type='Murder',
      // so the Murder filter above stays valid alongside this predicate.
      if (shootingQualifier.kind === "supported" && shootingQualifier.qualifier.clause) {
        whereClauses.push(shootingQualifier.qualifier.clause);
      }
      let joinClauses = "JOIN victims v ON v.incident_id = i.id";
      let withClause = "";
      let titlePlace = "Nationally";
      let cityCount = 0;
      let cityLabelExpression = "i.agency";
      const explicitOri = question.match(/\bORI\s*(?:[:#=]|is)?\s*((?=[A-Z0-9]*\d)[A-Z]{2}[A-Z0-9]{3,7})\b/i)?.[1]?.toUpperCase() || null;
      const county = countyIntent(question);
      const mentionedState = stateMention(question);

      // Explicit state-level wording ("New York State", "statewide in Washington")
      // must resolve to a state filter, never a same-named city agency (F18 / #4155).
      const stateIntent = explicitStateIntent(question);
      if (county) {
        const db = getShrDb();
        if (!db) {
          return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
        }
        const hasCrosswalk = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'agency_county_crosswalk'").get());
        if (!hasCrosswalk) {
          const explanation = "I do not currently have the agency-by-county crosswalk needed to answer countywide SHR geography questions. I should not infer county membership from agency names.";
          const crosswalkProof = finalizeExit({ intendedAction: "decline_capability", planFamily: "deterministic-shooting", narrative: explanation });
          writeLog(question, null, 0, "missing_agency_county_crosswalk", Date.now() - start, explanation, "shr", ["deterministic-shooting"], "deterministic", sessionId, null, crosswalkProof);
          return jsonResp(emitFactualPayload(crosswalkProof, {
            success: true, question, sql: null, explanation,
            title: "", columns: [], rows: [], rowCount: 0, truncated: false,
            chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
          }));
        }

        const stateWhere = mentionedState ? " AND state = ?" : "";
        const params = mentionedState ? [county.key, mentionedState] : [county.key];
        const countyStates = db.prepare(`
          SELECT DISTINCT state
          FROM agency_county_crosswalk
          WHERE county_key = ? AND county_fips IS NOT NULL AND state IS NOT NULL${stateWhere}
          ORDER BY state
        `).all(...params) as { state: string }[];

        if (countyStates.length === 0) {
          const explanation = `I could not find ${county.display} County in the SHR agency county crosswalk${mentionedState ? ` for ${mentionedState}` : ""}.`;
          const countyNotFoundProof = finalizeExit({ intendedAction: "decline_data", planFamily: "deterministic-shooting", narrative: explanation });
          writeLog(question, null, 0, "county_not_found", Date.now() - start, explanation, "shr", ["deterministic-shooting"], "deterministic", sessionId, null, countyNotFoundProof);
          return jsonResp(emitFactualPayload(countyNotFoundProof, {
            success: true, question, sql: null, explanation,
            title: "", columns: [], rows: [], rowCount: 0, truncated: false,
            chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
          }));
        }

        if (!mentionedState && countyStates.length > 1) {
          const explanation = `${county.display} County matches multiple states in the agency county crosswalk: ${countyStates.map((row) => row.state).join(", ")}. Please specify a state.`;
          const ambiguousCountyProof = finalizeExit({ intendedAction: "clarify", planFamily: "deterministic-shooting", narrative: explanation });
          writeLog(question, null, 0, "ambiguous_county", Date.now() - start, explanation, "shr", ["deterministic-shooting"], "deterministic", sessionId, null, ambiguousCountyProof);
          return jsonResp(emitFactualPayload(ambiguousCountyProof, {
            success: true, question, sql: null, explanation,
            title: "", columns: [], rows: [], rowCount: 0, truncated: false,
            chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
          }));
        }

        const countyStateWhere = mentionedState ? ` AND state = '${mentionedState.replace(/'/g, "''")}'` : "";
        withClause = `WITH target_counties AS (SELECT DISTINCT state, county_fips FROM agency_county_crosswalk WHERE county_key = '${county.key.replace(/'/g, "''")}' AND county_fips IS NOT NULL${countyStateWhere}), county_oris AS (SELECT DISTINCT ac.ori FROM agency_county_crosswalk ac JOIN target_counties tc ON tc.state = ac.state AND tc.county_fips = ac.county_fips) `;
        joinClauses += " JOIN county_oris co ON i.ori = co.ori OR substr(i.ori, 1, 7) = co.ori";
        titlePlace = `${county.display} County${mentionedState ? `, ${mentionedState}` : ""}`;
      } else if (stateIntent) {
        titlePlace = `${stateIntent.stateName} (statewide)`;
        whereClauses.push(`i.state = '${stateIntent.state}'`);
      } else if (explicitOri) {
        const db = getShrDb();
        if (!db) {
          return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
        }
        const identity = db.prepare(
          "SELECT canonical_agency FROM shr_agency_identity WHERE upper(ori) = ? LIMIT 1"
        ).get(explicitOri) as { canonical_agency?: string } | undefined;
        if (!identity) {
          const explanation = `I could not find ORI ${explicitOri} in the SHR agency identity data, so I cannot return a reliable result.`;
          const oriNotInSourceProof = finalizeExit({ intendedAction: "decline_data", planFamily: "deterministic-shooting", guardrails: ["deterministic-shooting", "shr-place-resolution-block", "shr-ori-not-in-source"], narrative: explanation });
          writeLog(question, null, 0, "shr_ori_not_in_source", Date.now() - start, explanation, "shr", ["deterministic-shooting", "shr-place-resolution-block", "shr-ori-not-in-source"], "deterministic", sessionId, null, oriNotInSourceProof);
          return jsonResp(emitFactualPayload(oriNotInSourceProof, { success: true, question, sql: null, explanation, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
        }
        titlePlace = `ORI ${explicitOri} - ${identity.canonical_agency || "identified agency"}`;
        whereClauses.push(`i.ori = '${explicitOri.replace(/'/g, "''")}'`);
      } else if (ambiguousKansasCityIntent(question)) {
        const explanation = "Please specify Kansas City, Missouri (KCMO) or Kansas City, Kansas (KCK). Both exist in the SHR data, and I should not combine or choose between them without that state.";
        const ambiguousCityProof = finalizeExit({ intendedAction: "clarify", planFamily: "deterministic-shooting", narrative: explanation });
        writeLog(question, null, 0, "ambiguous_city", Date.now() - start, explanation, "shr", ["deterministic-shooting"], "deterministic", sessionId, null, ambiguousCityProof);
        return jsonResp(emitFactualPayload(ambiguousCityProof, {
          success: true, question, sql: null, explanation,
          title: "", columns: [], rows: [], rowCount: 0, truncated: false,
          chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
        }));
      } else {
        const cities = shootingCityIntents(question);
        cityCount = cities.length;
        if (cities.length > 0) {
          titlePlace = cities.map((city) => city.display).join(" and ");
          if (cities.every((city) => city.state)) {
            const db = getShrDb();
            if (!db) {
              return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
            }
            const resolvedCities = cities.map((city) => {
              const resolutionName = city.agencyLike ? city.display : city.agency;
              return resolveShrAgency(db, resolutionName, city.state!, { kind: "city" });
            });
            const blockedCity = resolvedCities.find((place) => place.status !== "resolved");
            if (blockedCity) {
              const comparisonNote = cities.length > 1 ? " in this comparison" : "";
              const explanation = blockedCity.status === "ambiguous"
                ? `I cannot safely identify ${blockedCity.requestedName}, ${blockedCity.state}${comparisonNote} in the SHR agency identity data. Please specify a more precise agency.`
                : `I cannot provide a reliable SHR result for ${blockedCity.requestedName}, ${blockedCity.state}${comparisonNote} because that agency is not represented for the requested source. I will not substitute another agency.`;
              const blockedCityProof = finalizeExit({ intendedAction: "clarify", planFamily: "deterministic-shooting", guardrails: ["deterministic-shooting", "shr-place-resolution-block"], narrative: explanation });
              writeLog(question, null, 0, `shr_place_${blockedCity.status}`, Date.now() - start, explanation, "shr", ["deterministic-shooting", "shr-place-resolution-block"], "deterministic", sessionId, null, blockedCityProof);
              return jsonResp(emitFactualPayload(blockedCityProof, {
                success: true, question, sql: null, explanation,
                title: "", columns: [], rows: [], rowCount: 0, truncated: false,
                chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
              }));
            }
            const cityClauses = resolvedCities.map((place) => {
              const ranges = place.ranges.map((range) =>
                `(i.ori = '${range.ori.replace(/'/g, "''")}' AND i.year BETWEEN ${range.startYear} AND ${range.endYear})`
              );
              return `(${ranges.join(" OR ")})`;
            });
            whereClauses.push(`(${cityClauses.join(" OR ")})`);
            cityLabelExpression = buildShrCanonicalLabelCase(resolvedCities);
          } else {
            const cityClauses = cities.map((city) => {
              const agency = city.agencyLike
                ? `i.agency LIKE '${city.agencyLike.replace(/'/g, "''")}'`
                : `i.agency = '${city.agency.replace(/'/g, "''")}'`;
              const state = city.state ? ` AND i.state = '${city.state}'` : "";
              return `(${agency}${state})`;
            });
            whereClauses.push(`(${cityClauses.join(" OR ")})`);
            whereClauses.push("(i.agency_type = 'City' OR i.agency_type IS NULL OR i.agency_type = '')");
          }
        }
      }
      if (titlePlace === "Nationally" && stateMatch && /^[A-Z]{2}$/.test(stateMatch[1])) {
        titlePlace = stateMatch[1];
        whereClauses.push(`i.state = '${stateMatch[1]}'`);
      }

      const isMultiCity = cityCount > 1 && /\bi\.(?:agency|ori)\s*=/.test(whereClauses.join(" ")) && /\sOR\s/.test(whereClauses.join(" "));
      const selectPlace = isMultiCity ? `${cityLabelExpression} AS agency, i.state, ` : "";
      const groupPlace = isMultiCity ? `, ${cityLabelExpression}, i.state` : "";
      const orderPlace = isMultiCity ? `, ${cityLabelExpression}, i.state` : "";
      const periodSelect = wantsMonthly ? "printf('%04d-%02d', i.year, i.month) AS month" : "i.year";
      const periodGroup = wantsMonthly ? "i.year, i.month" : "i.year";
      const periodOrder = wantsMonthly ? "i.year, i.month" : "i.year";
      if (wantsMonthly) whereClauses.push("i.month IS NOT NULL");
      // Held in a variable so the derivation can be sealed from what the PLANNER
      // emitted. Sealing from shootingContract.sql -- the post-validation string --
      // would fingerprint the executed SQL against itself and prove nothing, which is
      // exactly the tautology the token exists to avoid. The contract validator can
      // rewrite this query, and that rewrite is what must remain detectable.
      const plannedShootingSql = `${withClause}SELECT ${periodSelect}, ${selectPlace}COUNT(*) AS fatal_shootings FROM incidents i ${joinClauses} WHERE ${whereClauses.join(" AND ")} GROUP BY ${periodGroup}${groupPlace} ORDER BY ${periodOrder}${orderPlace} LIMIT 1000`;
      const shootingContract = runContractValidation(plannedShootingSql);
      const shootingContractFailure = contractFailureResponse(shootingContract, `contract_deterministic_shooting_failure:${shootingContract.enforced.join(",")}`, ["deterministic-shooting"]);
      if (shootingContractFailure) return shootingContractFailure;
      const sql = shootingContract.sql;
      // The narrative must name the qualifier it actually applied. 7881 said
      // "Fatal shootings (firearm homicides)" for a police question, which read
      // as a confident answer to a question nobody asked.
      const qualifierTitle =
        shootingQualifier.kind === "supported" ? shootingQualifier.qualifier.titleLabel : "Fatal Shootings (Firearm Homicides)";
      const qualifierNarrative =
        shootingQualifier.kind === "supported" ? shootingQualifier.qualifier.narrativeLabel : "fatal shootings (firearm homicides)";
      const qualifierCaveat = shootingQualifier.kind === "supported" ? shootingQualifier.qualifier.caveat : null;
      const title = `${qualifierTitle}, ${titlePlace}, ${effectiveYearLabel}`;
      const explanation = `${qualifierNarrative.charAt(0).toUpperCase()}${qualifierNarrative.slice(1)} by ${wantsMonthly ? "month" : "year"}${titlePlace !== "Nationally" ? ` in ${titlePlace}` : ""} ${effectiveYearExplanation}. This shows only homicides where the weapon was a firearm - nonfatal shootings are not tracked in this database.${qualifierCaveat ? ` ${qualifierCaveat}` : ""}`;
      // Execute the deterministic SQL
      const db = getShrDb();
      if (!db) {
        return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
      }
      try {
        let rows = db.prepare(sql).all() as Record<string, unknown>[];
        rows = normalizeShrDisplayRows(rows);
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [wantsMonthly ? "month" : "year", "fatal_shootings"];

        // Add caveats
        const caveats = [normalizeShrAgencyText(explanation)];
        if (overlapDisclosure) caveats.push(overlapDisclosure);
        caveats.push("Not all agencies and states report SHR data every year, so these counts underrepresent total fatal shootings.");
        let totalExplanation = caveats.join("\n\n");

        // Deterministic paths bypass runGuardrails, so the zero-result agency
        // probe must be applied here too (same blind spot as F18 / #4155).
        const detGuardrails = ["deterministic-shooting"];
        // Tag the applied qualifier so the digest can distinguish a police
        // shooting answer from a plain firearm-homicide answer.
        if (shootingQualifier.kind === "supported") detGuardrails.push(`shooting-qualifier-${shootingQualifier.qualifier.id}`);
        if (isZeroResult(rows, columns)) {
          const probeResult = runShrAgencyProbe(db, sql);
          if (probeResult && probeResult.count > 0) {
            totalExplanation = appendShrAgencyProbeCaveat(totalExplanation, probeResult.probe.agency);
            detGuardrails.push("shr-agency-zero-probe");
          }
        }

        const displayTitle = normalizeShrAgencyText(title);
        const chartConfig = applyChartCustomizations({ type: "line", xAxis: wantsMonthly ? "month" : "year", yAxis: ["fatal_shootings"], yAxisLabel: "Fatal Shootings", title: displayTitle }, question);
        const shootingProof = finalizeExit({ intendedAction: rows.length > 0 ? "answer" : "decline_data", sql, rows, columns, derivation: sealPlanDerivation("deterministic-shooting", plannedShootingSql), planFamily: "deterministic-shooting", guardrails: detGuardrails, returnedEntities: returnedEntityKeys(rows), narrative: totalExplanation, hasChart: true, db });
        writeLog(question, sql, rows.length, null, Date.now() - start, totalExplanation, "shr", detGuardrails, "deterministic", sessionId, serializeChartConfigForLog(chartConfig, columns.slice(), { source: "FBI SHR", agencyCount: 0, population: null }), shootingProof);
        return jsonResp(emitFactualPayload(shootingProof, attachChartAuditToPayload({
          success: true, question, sql, explanation: totalExplanation,
          title: displayTitle, columns, rows, rowCount: rows.length, truncated: false,
        chartConfig,
          chartMeta: { source: "FBI SHR", agencyCount: 0, population: null },
          executionTimeMs: Date.now() - start,
        }, { source: "shr", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        const shootingDbProof = finalizeExit({ intendedAction: "decline_capability", sql, planFamily: "deterministic-shooting" });
        writeLog(question, sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", ["deterministic-shooting"], "deterministic", sessionId, null, shootingDbProof);
        return jsonResp({ success: false, error: `Database error: ${msg}` } as QueryError, 500);
      }
    }

    // Check response cache (only for standalone questions, not follow-ups)
    const cached = promptHistory.length === 0 ? getCached(question, "shr", cacheValidity) : null;

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
    if (asksShooting && !wantsNonfatal && !(plannerMode === "authoritative" && followupPlan?.kind === "query_bearing")) {
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
      { role: "user", content: (() => {
        const correctionHint = geoCorrectionHint(queryForModel);
        if (correctionHint) routeGuardrailsFired.push("geo-typo-corrected");
        return applyGeoCorrection(queryForModel, correctionHint);
      })() },
    ];

    if (cached) {
      claude = { sql: cached.sql, explanation: cached.explanation, title: cached.title, chartType: cached.chartType, xAxis: cached.xAxis, yAxis: cached.yAxis, yAxisLabel: cached.yAxisLabel };
    } else {
      // Step 1: Translate to SQL via Claude

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: [{ type: "text", text: getShrSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
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

      if (!claude.sql && followupTransform?.name === "assess_trend") {
        try {
          const retryMessages: Anthropic.MessageParam[] = [
            ...messages,
            { role: "assistant", content: claude.explanation || "No SQL was generated." },
            { role: "user", content: "[SYSTEM: This is a follow-up to a prior SQL result. Preserve the prior dataset, geography, topic, filters, metric, and requested time range. Generate SQL for the trend assessment instead of refusing. If the prior topic was fatal shootings or firearm homicides, use SHR firearm homicides with homicide_type = 'Murder' and weapon_group = 'Firearm'; do not treat it as a broad/nonfatal shooting request. Return one row per complete year and exclude incomplete current-year rows unless the user explicitly asked for YTD.]" },
          ];
          const retryResp = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 2000,
            system: [{ type: "text", text: getShrSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
            messages: retryMessages,
          });
          const retryText = retryResp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
          const retryClaude = extractJson(retryText);
          if (retryClaude && typeof retryClaude === "object" && (retryClaude as Record<string, unknown>).sql) {
            Object.assign(claude, retryClaude);
          }
        } catch { /* use original */ }
      }

      // Text-only response — retry if model incorrectly claims an AGENCY isn't available
      // Do NOT retry when model correctly refuses non-homicide queries (theft, assault, etc.)
      if (!claude.sql) {
        const refusalPatterns = /not (appear|be represented)|doesn't appear|not (in|included in) (this|the|our) (dataset|data|sample|library)|no data (for|available|found)|does not (yet )?(have|include|cover)|not available|not yet (include|available|have)|latest available data|isn't (in|included)|not found in/i;
        // Skip retry if the refusal is about SHR's scope (non-homicide data) — these are correct refusals
        const scopeRefusal = /only (homicides?|murders?|manslaughter)|does(?:n't| not)\s+(?:include|contain|track|cover|have)\s+.*?\b(theft|robbery|assault|burglary|property|arrests?|drugs?|clearance|staffing|officers?|sworn|personnel|employment|auto theft|motor vehicle|violent crime|property crime|non-homicide|rape)\b|homicides only|murder and manslaughter only/i;
        const isCorrectScopeRefusal = scopeRefusal.test(claude.explanation || "");
        const coverageRetryPrompt = partialCoverageRetryPrompt("shr", question, claude.explanation);
        const genericRetryPrompt = "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. NEVER assume an agency is missing. Always generate a SQL query and let the database answer. Try the query now.]";
        const retryPrompt = coverageRetryPrompt ?? (refusalPatterns.test(claude.explanation || "") && !isCorrectScopeRefusal ? genericRetryPrompt : null);
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
              system: [{ type: "text", text: getShrSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
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
        // RAW MODEL TEXT, CAPTURED FIRST -- the three statements below each overwrite
        // claude.explanation, so capturing later stores our own template and loses the
        // model's actual words. That is the diagnostic gap model_response exists to close.
        const rawNoSqlText = claude.explanation || null;
        const serverAuthoredNoSql = false;
        if (containsInternalLeak(claude.explanation) || containsInternalLeak(claude.title)) { claude.explanation = INTERNAL_LEAK_SAFE_MESSAGE; claude.title = "Results"; routeGuardrailsFired.push("internal-leak-firewall"); }
        if (!serverAuthoredNoSql && !containsInternalLeak(claude.explanation) && !containsInternalLeak(claude.title)) { claude.explanation = buildNoSqlFallbackMessage("shr"); routeGuardrailsFired.push("no-sql-server-template"); }
        claude.explanation = neutralizeUnverifiedAvailabilityClaim(claude.explanation, "SHR");
        const noSqlProof = finalizeExit({ intendedAction: "decline_capability", guardrails: routeGuardrailsFired });
        writeLog(question, null, 0, null, claudeMs, claude.explanation, "shr", routeGuardrailsFired, "haiku-4.5", sessionId, null, noSqlProof, boundedModelResponseJson(rawNoSqlText, null));
        return jsonResp(emitFactualPayload(noSqlProof, {
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
        }));
      }
    }

    // Step 2: Validate SQL
    const validation = validateAndSanitize(claude.sql!);
    if (!validation.valid) {
      const validationProof = finalizeExit({ intendedAction: "decline_capability", sql: claude.sql, guardrails: routeGuardrailsFired });
      writeLog(question, claude.sql, 0, `Validation: ${validation.error}`, Date.now() - start, null, "shr", [], "haiku-4.5", sessionId, null, validationProof);
      return jsonResp(
        { success: false, error: "I generated an invalid query. Please try rephrasing your question.", sql: claude.sql } as QueryError,
        400
      );
    }

    const shrRewrite = followupShrPlaces.length > 0
      ? rewriteShrResolvedAgencyPredicates(validation.sanitized!, followupShrPlaces)
      : { sql: validation.sanitized!, rewritten: false };
    if (shrRewrite.warning) {
      routeGuardrailsFired.push("shr-resolved-ori-warn-only");
      console.warn(`[shr][resolver-warning] ${shrRewrite.warning}`);
      logResolverWarnings({
        source: "shr", question, sql: validation.sanitized!, warnings: [shrRewrite.warning], sessionId,
      });
    }
    if (shrRewrite.rewritten) routeGuardrailsFired.push("shr-resolved-ori-rewritten");
    let initialContract = runContractValidation(shrRewrite.sql);
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
          system: [{ type: "text", text: getShrSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
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
              system: [{ type: "text", text: getShrSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
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
                const retryContract = runContractValidation(retryValidation.sanitized!);
                let retrySql = retryContract.sql;
                const retryContractFailure = contractFailureResponse(retryContract, `contract_table_retry_failure:${retryContract.enforced.join(",")}`, tableCheck.fired);
                if (retryContractFailure) return retryContractFailure;
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
                  const retryAllowlistProof = finalizeExit({ intendedAction: "decline_capability", sql: retrySql, guardrails: [...tableCheck.fired, ...retryTableCheck.fired], planFamily: "table-allowlist", retries: 1, narrative: msg });
                  writeLog(question, retrySql, 0, `table_allowlist_second_failure:${retryTableCheck.unknown.join(",")}`, Date.now() - start, msg, "shr", [...tableCheck.fired, ...retryTableCheck.fired], "haiku-4.5", sessionId, null, retryAllowlistProof);
                  return jsonResp(emitFactualPayload(retryAllowlistProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
                }
              }
            }
          } catch { /* fall through to friendly failure */ }

          const msg = "I couldn't build a valid query for the SHR database. Try rephrasing for homicide-specific data or switching to a different tab for broader crime totals.";
          const allowlistProof = finalizeExit({ intendedAction: "decline_capability", sql, guardrails: tableCheck.fired, planFamily: "table-allowlist", narrative: msg });
          writeLog(question, sql, 0, `table_allowlist:${tableCheck.unknown.join(",")}`, Date.now() - start, msg, "shr", tableCheck.fired, "haiku-4.5", sessionId, null, allowlistProof);
          return jsonResp(emitFactualPayload(allowlistProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
        }
      }
    }

    // Step 2b: Run guardrails
    const ctx = extractQueryContext(sql, guardrailQuestion, "shr");
    const guardrailResult = runGuardrails(ctx);
    if (guardrailResult.sql !== sql) {
      sql = guardrailResult.sql;
    }
    // Hard override — skip retry, return deterministic response
    if (guardrailResult.overrideResponse) {
      const overrideExplanation = guardrailResult.overrideResponse;
      const overrideProof = finalizeExit({ intendedAction: "decline_capability", sql, guardrails: guardrailResult.fired, planFamily: guardrailResult.overrideGuardrail ?? null, narrative: overrideExplanation });
      writeLog(question, sql, 0, `guardrail_override:${guardrailResult.overrideGuardrail}`, Date.now() - start, overrideExplanation, "shr", guardrailResult.fired, "haiku-4.5", sessionId, null, overrideProof);
      return jsonResp(emitFactualPayload(overrideProof, {
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
      }));
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
          system: [{ type: "text", text: getShrSystemPrompt(), cache_control: { type: "ephemeral", ttl: "1h" } }],
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
            const retryContract = runContractValidation(retryValidation.sanitized!);
            sql = retryContract.sql;
            const retryContractFailure = contractFailureResponse(retryContract, `contract_guardrail_retry_failure:${retryContract.enforced.join(",")}`, guardrailResult.fired);
            if (retryContractFailure) return retryContractFailure;
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
      const postRetryCtx = extractQueryContext(sql, guardrailQuestion, "shr");
      const postRetryResult = runGuardrails(postRetryCtx);
      if (postRetryResult.overrideResponse) {
        const msg = postRetryResult.overrideResponse;
        const postRetryOverrideProof = finalizeExit({ intendedAction: "decline_capability", sql, guardrails: postRetryResult.fired, planFamily: postRetryResult.overrideGuardrail ?? null, narrative: msg });
        writeLog(question, sql, 0, `guardrail_override:${postRetryResult.overrideGuardrail}`, Date.now() - start, msg, "shr", postRetryResult.fired, "haiku-4.5", sessionId, null, postRetryOverrideProof);
        return jsonResp(emitFactualPayload(postRetryOverrideProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
      }
      const rateStillBad = postRetryResult.fired.some(f => f.includes("rate-no-population"));
      if (rateStillBad && /\b(rates?|per\s*capita|per\s*100)/i.test(question) && !asksForCountsInsteadOfRates(question)) {
        const msg = "I wasn't able to calculate a valid per-capita rate for this query. For murder rates, try the [Historical Library](/test?tab=historical) tab which has FBI statewide estimates.";
        const rateFailureProof = finalizeExit({ intendedAction: "decline_capability", sql, guardrails: postRetryResult.fired, planFamily: "rate-no-population", narrative: msg });
        writeLog(question, sql, 0, "rate_second_failure", Date.now() - start, msg, "shr", postRetryResult.fired, "haiku-4.5", sessionId, null, rateFailureProof);
        return jsonResp(emitFactualPayload(rateFailureProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
      }
      const orPrecedenceStillBad = postRetryResult.fired.includes("or-and-precedence");
      if (orPrecedenceStillBad) {
        const msg = "I couldn't build a reliable multi-place query after correcting the SQL structure. Try asking for fewer places or restating the comparison.";
        const orPrecedenceProof = finalizeExit({ intendedAction: "decline_capability", sql, guardrails: postRetryResult.fired, planFamily: "or-and-precedence", narrative: msg });
        writeLog(question, sql, 0, "or_precedence_second_failure", Date.now() - start, msg, "shr", postRetryResult.fired, "haiku-4.5", sessionId, null, orPrecedenceProof);
        return jsonResp(emitFactualPayload(orPrecedenceProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
      }
      if (postRetryResult.sql !== sql) sql = postRetryResult.sql;
      const postRetryContract = runContractValidation(sql);
      sql = postRetryContract.sql;
      const postRetryContractFailure = contractFailureResponse(postRetryContract, `contract_final_failure:${postRetryContract.enforced.join(",")}`, postRetryResult.fired);
      if (postRetryContractFailure) return postRetryContractFailure;
    }

    // Step 3: Execute
    const db = getShrDb();
    if (!db) {
      return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
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
      rows = normalizeShrDisplayRows(rows);
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      const dbErrorProof = finalizeExit({ intendedAction: "decline_capability", sql, guardrails: routeGuardrailsFired });
      writeLog(question, sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", [], "haiku-4.5", sessionId, null, dbErrorProof);
      return jsonResp(
        { success: false, error: `Database error: ${msg}`, sql } as QueryError,
        500
      );
    }

    const executionMs = Date.now() - start;
    claude.title = claude.title ? normalizeShrAgencyText(claude.title) : claude.title;
    claude.explanation = normalizeShrAgencyText(claude.explanation || "");

    if (rows.length === 0) {
      let explanation = claude.explanation || "The query returned no results.";
      const probeResult = runShrAgencyProbe(db, sql);
      const guardrails = [...guardrailResult.fired];
      if (probeResult && probeResult.count > 0) {
        explanation = appendShrAgencyProbeCaveat(explanation, probeResult.probe.agency);
        guardrails.push("shr-agency-zero-probe");
      }
      const emptyProof = finalizeExit({ intendedAction: "decline_data", sql, guardrails, narrative: explanation, db });
      writeLog(question, sql, 0, "empty_result", executionMs, explanation, "shr", guardrails, "haiku-4.5", sessionId, null, emptyProof);
      return jsonResp(emitFactualPayload(emptyProof, {
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
      }));
    }

    let columns = Object.keys(rows[0]);
    const zeroProbeResult = isZeroResult(rows, columns) ? runShrAgencyProbe(db, sql) : null;

    // Detect all-null data columns (query returned rows but no usable values)
    {
      const { allNull } = detectAllNullData(columns, rows);
      if (allNull) {
        const emptyMsg = "I ran that query but all the values came back empty — the math likely broke somewhere (like dividing by zero). Could you try asking that a different way?";
        const allNullProof = finalizeExit({ intendedAction: "decline_data", sql, guardrails: guardrailResult.fired, narrative: emptyMsg, db });
        writeLog(question, sql, 0, "all_null_columns", executionMs, emptyMsg, "shr", guardrailResult.fired, "haiku-4.5", sessionId, null, allNullProof);
        return jsonResp(emitFactualPayload(allNullProof, {
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
        }));
      }
    }

    // Build chart config (match QueryResponse shape)
    // Auto-pivot long-format category data for charting
    // Detects (year, category_col, value_col) and pivots to (year, cat1, cat2, ...)
    const CATEGORY_COLS = ["sex", "race", "weapon_group", "circumstance_group", "off_race", "off_sex", "relationship", "relationship_group", "ethnicity", "off_ethnicity", "weapon", "agency", "state", "state_name"];
    const comparisonLabels: Record<string, string> = {};
    const categorCol = columns.find(c => CATEGORY_COLS.includes(c));
    const numericCol = selectShrPivotMetric({
      question,
      columns,
      rows,
      categoryColumns: CATEGORY_COLS,
      requestedYAxis: claude.yAxis,
    });
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
          comparisonLabels[catName] = String(r[categorCol] ?? "Unknown");
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

    let chartConfig = applyChartCustomizations({
      type: autoChartType as "bar" | "line" | "pie" | "stacked_bar" | "none",
      xAxis: autoXAxis,
      yAxis: autoYAxis,
      yAxisLabel: claude.yAxisLabel || undefined,
      // ChartPanel renders config.title (not the top-level response title) —
      // matches buildChartConfig in chart-config.ts / nibrs-chart-config.ts.
      title: claude.title || "Results",
    }, question);

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
    if (asksShooting && !wantsNonfatal && !(plannerMode === "authoritative" && followupPlan?.kind === "query_bearing")) {
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
    explanation = applyResultDisclosures({ explanation, question, sql, rows, tab: "shr", comparisonLabels });
    if (missingLowerBoundNote(question, sql, rows)) routeGuardrailsFired.push("lower-bound-disclosed");
    const grainCheck = validateGrain(question, rows, sql);
    if (!grainCheck.ok && grainCheck.message) {
      explanation = grainCheck.message;
      routeGuardrailsFired.push("grain-mismatch");
    }
    explanation = normalizeShrAgencyText(explanation);

    // Sanitize any leaked SQL/JSON
    explanation = sanitizeExplanation(explanation);

    const finalNarrative = sanitizeUserFacingNarrative(explanation, claude.title);
    if (finalNarrative.blocked) {
      routeGuardrailsFired.push("internal-leak-firewall-result");
      console.warn(`[shr][internal-leak-firewall] Replaced result narrative: ${explanation}`);
    }
    explanation = finalNarrative.explanation || "";
    claude.title = finalNarrative.title || claude.title || "Results";
    // The chart config was built before the narrative firewall and the final
    // title alignment ran, so its title is a snapshot of an earlier value.
    // ChartPanel renders config.title, so bring it in step with the finalized
    // title before the response and the log capture it.
    if (chartConfig && claude.title && chartConfig.title !== claude.title) {
      chartConfig = { ...chartConfig, title: claude.title };
    }
    // The main model path. Model-authored, so no derivation is sealed and the answer
    // cannot satisfy the contract -- recorded honestly rather than softened.
    const finalization = finalizeExit({
      intendedAction: "answer",
      sql,
      rows,
      columns,
      truncated: rows.length >= 1000,
      guardrails: finalizeGuardrailTags([...guardrailResult.fired, ...routeGuardrailsFired], queryContractGuardrails(runContractValidation(sql))),
      returnedEntities: returnedEntityKeys(rows),
      narrative: explanation,
      hasChart: Boolean(chartConfig),
      chartFromBindings: false,
      db,
    });
    writeLog(question, sql, rows.length, null, totalMs, explanation, "shr", finalizeGuardrailTags([...guardrailResult.fired, ...routeGuardrailsFired], queryContractGuardrails(runContractValidation(sql))), "haiku-4.5", sessionId, serializeChartConfigForLog(chartConfig, columns, { source: "FBI SHR", agencyCount: 0, population: null }), finalization);

    // Cache successful responses (only standalone questions)
    if (!cached && promptHistory.length === 0) {
      setCache(question, "shr", { sql, explanation: claude.explanation || "", title: claude.title, chartType: claude.chartType, xAxis: claude.xAxis, yAxis: claude.yAxis, yAxisLabel: claude.yAxisLabel }, cacheValidity);
    }

    return jsonResp(emitFactualPayload(finalization, attachChartAuditToPayload({
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
    }, { source: "shr", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("SHR query error:", msg);
    return jsonResp(
      { success: false, error: "An error occurred. Please try again." } as QueryError,
      500
    );
  }
}
