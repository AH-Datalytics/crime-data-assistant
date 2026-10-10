import { NextRequest, NextResponse } from "next/server";
import { getNibrsDb, executeWithTimeout, executeBoundNibrsStatement, logNibrsQuery } from "@/lib/nibrs-db";
import { finalizeNibrsStatement } from "@/lib/nibrs-execution-binding";
import { isZeroResult } from "@/lib/shr-agency-probe";
import { appendNibrsAgencyProbeCaveat, runNibrsAgencyProbe } from "@/lib/nibrs-agency-probe";
import { buildNoSqlFallbackMessage, courtProcessNoSqlIsTerminal, neutralizeUnverifiedAvailabilityClaim, selectNoSqlRefusal } from "@/lib/refusal-safety";
import { validatePageToken } from "@/lib/page-token";
import { translateToSql } from "@/lib/nibrs-claude";
import { validateAndSanitize } from "@/lib/sql-safety";
import { deterministicPlanRefusal } from "@/lib/deterministic-plan-guard";
import { validateSqlSchema } from "@/lib/schema-validation";
import { buildNibrsChartConfig } from "@/lib/nibrs-chart-config";
import { generateExplanation, sanitizeExplanation } from "@/lib/explain";
import { extractQueryContext } from "@/lib/query-context";
import { runGuardrails } from "@/lib/guardrails";
import { finalizeGuardrailTags } from "@/lib/guardrail-tag-state";
import { serializeChartConfigForLog } from "@/lib/chart-config-log";
import { attachChartAuditToPayload, createChartAuditRequestId } from "@/lib/chart-audit";
import { asksForCountsInsteadOfRates } from "@/lib/rate-intent";
import { applyRetryMeta } from "@/lib/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkSessionLimit, maybeCleanup } from "@/lib/captcha";
import type { QueryResponse, QueryError } from "@/lib/types";
import { getCached, setCache } from "@/lib/response-cache";
import { detectAllNullData } from "@/lib/all-null-detection";
import { checkSingleRowTrend } from "@/lib/single-row-trend";
import { parseRoutingLogMeta } from "@/lib/routing-log-meta";
import { answerMetadataQuestion } from "@/lib/metadata-coverage";
import { validateTablesForTab } from "@/lib/table-allowlist";
import { alignTitleYearRange, applyResultDisclosures, missingLowerBoundNote, offenderShareDelivery, returnedEntityKeys } from "@/lib/result-disclosure";
import {
  emitFactualPayload,
  finalizeProof,
  proofLogFields,
  type ProofFinalization,
  type ProofFinalizationInput,
  type SealedPayload,
  outcomeLogFields,
  asOutcomeRecord,
  decisionFinalization,
  OPERATIONAL_RECORD,
  type OutcomeLogRecord,
} from "@/lib/proof-finalize";
import { sealPlanDerivation } from "@/lib/plan-derivation";
import { cacheValiditySignature } from "@/lib/proof-cache-validity";
import { OUTCOMES, type QueryLogOutcome } from "@/lib/proof-contract";
import { validateGrain } from "@/lib/requested-grain";
import { buildCompletenessAnswer, detectCompletenessQuestion, loadCompletenessRows } from "@/lib/completeness-intent";
import { normalizeHistoryForTab } from "@/lib/chat-history";
import { applyGeoCorrection, geoCorrectionHint } from "@/lib/geo-correction";
import { pastCompleteCalendarYearsRange } from "@/lib/time-conventions";
import { detectFollowupTransform } from "@/lib/followup-transform";
import { resolveClearanceRefinement } from "@/lib/clearance-refinement-followup";
import { resolvePeerCountFollowup } from "@/lib/peer-count-followup";
import { AGENCY_PERIOD_RANKING_GUARDRAIL, AGENCY_PERIOD_RANKING_FAILURE_TEXT, agencyPeriodRankingFacts, agencyPeriodRankingNote, asExplanationFollowup, resolveRankingExplanationFollowup } from "@/lib/nibrs-agency-period-ranking";
import { detectNibrsCapabilityOverride } from "@/lib/nibrs-capability-overrides";
import { getBlockingGeoClarification } from "@/lib/geo-resolver";
import { boundedModelResponseJson, shouldRetryUnexplainedNoSql, UNEXPLAINED_NO_SQL_RETRY_PROMPT } from "@/lib/no-sql-retry";
import { getCountyScopeClarification } from "@/lib/county-clarifier";
import { detectQueryBearingFollowup } from '@/lib/query-bearing-followup';
import { planFollowupSafe } from '@/lib/followup-planner';
import { buildCrossSourceFollowupTransform } from '@/lib/cross-source-followup';
import { plannerModeForSource } from '@/lib/followup-planner-mode';
import { asksCampusAgency, buildCampusAgencySummarySql, campusAgencyChartAxesFromSql, campusAgencyDisplayName, knownCampusAgencyResolution, resolveCampusAgencyOris, shouldResolveCampusAgencySql } from "@/lib/nibrs-campus-agency";
import { planNibrsQuery } from "@/lib/nibrs-query-planner";
import { NIBRS_DATA_CUTOFF } from "@/lib/dynamic-facts";
import { optimizeNibrsSql } from "@/lib/nibrs-sql-optimizer";
import { nibrsRollupContextForDb, routeNibrsRollupSql } from "@/lib/nibrs-rollup-router";
import { buildQueryContract } from "@/lib/query-contract";
import {
  queryContractFailureMessage,
  queryContractGuardrails,
  validateQueryContractSql,
  type QueryContractSqlValidation,
  capabilityFinalizationOutcome,
} from "@/lib/query-contract-validator";
import { partialCoverageRetryPrompt } from "@/lib/source-year-overlap";
import { removedDemographicPlaceToken } from "@/lib/demographic-rate-intent";
import {
  auditNibrsResolvedOriUsage,
  resolvedOriEnforcementIssue,
  omittedMemberEnforcementIssue,
  unresolvedMemberDisclosure,
  formatNibrsResolutionGuidance,
  resolveNibrsPlaces,
} from "@/lib/nibrs-place-resolver";
import { agencyFigureFailure, memberRefusalText, mapAgencyFigures } from "@/lib/nibrs-member-figures";
import {
  isOwnedMultiAgencyRequest,
  ownedMemberDeclaration,
  memberCoverage,
  coverageTitle,
  coverageNote,
  unsupportedOwnedComparisonText,
} from "@/lib/agency-answer-ownership";
import { inheritedMultiAgencyRequest } from "@/lib/followup-agency-continuation";
import { logResolverWarnings } from "@/lib/rtci-db";
import { consolidatedDisplayText, normalizeConsolidatedDisplayRows } from "@/lib/agency-consolidations";
import { genericResultState } from "@/lib/result-state-adapters";
import { governFactualNarrative } from "@/lib/result-state";
import { verifyPeerMembership } from "@/lib/peer-comparison";
import { decideDeterministicFailure, decideDatabaseFailure, buildNibrsRecoveryContext, runsAnnualClearanceFlow } from "@/lib/nibrs-recovery";
import { NIBRS_CITY_RANKING_GUARDRAIL, CITY_RANKING_FAILURE_TEXT } from "@/lib/city-ranking-nibrs";
import { rankingValidationContract } from "@/lib/city-ranking";
import { runOwnedAnnualClearance } from "@/lib/nibrs-owned-family";
import { NIBRS_CATEGORY_CHANGE_GUARDRAIL, planCategoryChange, recognizeCategoryChange, runOwnedCategoryChange } from "@/lib/nibrs-category-change";
import { accountNibrsRequest, nibrsRecognitionRefusal, nibrsRequestKind, nibrsFollowupCheck, NIBRS_CACHE_TAB, NIBRS_MODEL_SQL_DECLINE } from "@/lib/nibrs-request-accounting";
import { matchNibrsType, MEASURE_CODES } from "@/lib/nibrs-question-types";
import { compileNibrsSpec } from "@/lib/nibrs-question-compiler";
import { nibrsLegacyBound, nibrsUnboundParts, typedExplainLimitation, placesFromGeographies, type NibrsApplied } from "@/lib/nibrs-legacy-binding";
import { recognizeAgencyPeriodRanking } from "@/lib/nibrs-agency-period-ranking";
import { isFollowUp } from "@/lib/tab-suggest";
import type { Part as AccountingPart } from "@/lib/request-accounting";

/**
 * Request accounting, stage 2b (plan §6, L11): no model-written statement ever runs on the NIBRS tab. Numbers come only
 * from a fixed path that applies the whole request or from a supported question type (lib/nibrs-question-types.ts).
 */
const NIBRS_MODEL_SQL_NEVER_RUNS: boolean = true;
import { pendingWhereLevelReask, whereLevelClarification } from "@/lib/where-level-clarification";
import { completenessOf, decideCandidates } from "@/lib/city-ranking-completeness";
import { shouldAskCrimeType } from "@/lib/crime-type-clarification";
import { normalizeHistoryAllSources } from "@/lib/chat-history";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * THE CHOKEPOINT. Factual content is accepted only as a SealedPayload, which
 * lib/proof-finalize's emitFactualPayload() alone can produce; a QueryError
 * (success: false) asserts no facts and needs no proof. An unwrapped factual exit is
 * a compile error rather than a review finding.
 *
 * This route's signature was `unknown`, which accepted anything at all -- so the
 * narrowing here is what creates the gate, not merely tightens it.
 */
// `object` rather than Record<string, unknown>: this route's payloads are typed as
// QueryResponse, and an interface has no index signature. The brand is what matters
// here -- widening the shape does not weaken the gate, since only
// emitFactualPayload() can produce a SealedPayload of any shape.
function jsonResp(data: SealedPayload<object> | QueryError, status = 200) {
  const payload: Record<string, any> = { ...((data as Record<string, any>) || {}) };
  if (typeof payload.explanation === 'string' || typeof payload.title === 'string') {
    const safe = sanitizeUserFacingNarrative(payload.explanation, payload.title);
    payload.explanation = safe.explanation ? consolidatedDisplayText(safe.explanation) : safe.explanation;
    payload.title = safe.title ? consolidatedDisplayText(safe.title) : safe.title;
  }
  if (Array.isArray(payload.rows)) payload.rows = normalizeNibrsDisplayRows(payload.rows);
  // ChartPanel renders chartConfig.title, which the sanitization above never
  // touched -- a leaking title was blanked in the header while the chart still
  // showed it. Applied here so every response path is covered.
  if (payload.chartConfig) {
    payload.chartConfig = sanitizeChartConfigTitle(payload.chartConfig);
    if (typeof payload.chartConfig?.title === "string") payload.chartConfig.title = consolidatedDisplayText(payload.chartConfig.title);
  }
  const finalized = payload.requestId
    ? attachChartAuditToPayload(payload, { source: "nibrs", requestId: payload.requestId })
    : payload;
  return NextResponse.json(finalized, { status, headers: CORS_HEADERS });
}

import {
  containsInternalScaffold,
  stripInternalScaffold,
  containsInternalLeak,
  INTERNAL_LEAK_SAFE_MESSAGE,
  sanitizeUserFacingNarrative,
  sanitizeChartConfigTitle,
} from "@/lib/scaffold-helpers";
import { findNibrsSqlIssues } from "@/lib/sql-guardrails";
import { nibrsWithheldRateNote, demographicMissingYearsNote, withoutNibrsMetadata, PEER_COMPARISON_GUARDRAIL, PEER_COMPARISON_REFUSED_TEXT } from "@/lib/nibrs-deterministic-queries";

function modelLabel(modelId: string): string {
  if (modelId.includes("sonnet")) return "sonnet-4.5";
  if (modelId.includes("haiku")) return "haiku-4.5";
  return modelId;
}

function titlePlacePart(value: string): string {
  if (/^(?:DC|US|USA)$/i.test(value)) return value.toUpperCase();
  if (/^st$/i.test(value)) return "St.";
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function displayNibrsCityName(value: string): string {
  const key = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (key === "SAINT LOUIS" || key === "ST LOUIS") return "St. Louis";
  if (key === "CHARLOTTE MECKLENBURG") return "Charlotte";
  if (key === "METROPOLITAN NASHVILLE" || key === "NASHVILLE METROPOLITAN") return "Nashville";
  if (key === "LAS VEGAS METRO PD" || key === "LAS VEGAS METROPOLITAN") return "Las Vegas";
  return value
    .trim()
    .split(/(\s+|-)/)
    .map((part) => (/^\s+$|^-$/u.test(part) ? part : titlePlacePart(part)))
    .join("");
}

function normalizeNibrsDisplayRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const cityLikeColumns = new Set(["city", "agency", "agency_name", "jurisdiction"]);
  return normalizeConsolidatedDisplayRows(rows).map((row) => {
    let changed = false;
    const next: Record<string, unknown> = { ...row };
    for (const key of Object.keys(next)) {
      if (!cityLikeColumns.has(key.toLowerCase())) continue;
      if (typeof next[key] !== "string") continue;
      const normalized = displayNibrsCityName(next[key]);
      if (normalized && normalized !== next[key]) {
        next[key] = normalized;
        changed = true;
      }
    }
    return changed ? next : row;
  });
}

function asksContinuousReportingFilter(question: string): boolean {
  return /\b(?:continuous(?:ly)?|consistent(?:ly)?)\s+(?:reporting\s+)?(?:agenc(?:y|ies)|reporters?)\b/i.test(question) ||
    /\b(?:agenc(?:y|ies)|reporters?)\s+that\s+reported\s+every\s+year\b/i.test(question) ||
    /\bagenc(?:y|ies)\s+that\s+reported\s+all\s+12\s+months\b/i.test(question) ||
    /\breported\s+(?:all\s+)?(?:12\s+)?months\s+every\s+year\b/i.test(question) ||
    /\ball\s+12\s+months\s+(?:in|for)\s+every\s+year\b/i.test(question) ||
    /\badjust(?:ed)?\s+for\s+incomplete\s+coverage\b/i.test(question) ||
    /\binclude\s+(?:only\s+)?(?:continuous(?:ly)?|consistent(?:ly)?)\s+(?:reporting\s+)?(?:agenc(?:y|ies)|reporters?)\b/i.test(question);
}

function continuousReporterRouteIssue(sql: string, question: string): string | null {
  if (!asksContinuousReportingFilter(question)) return null;
  if (/\bnibrs_consistent_reporters\b/i.test(sql)) return null;
  return "[SYSTEM: The user asked for agencies that reported all 12 months in every requested year. Rewrite the query with ORI-level summary tables, not state-level summary tables, and filter the fact table with ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = [start_year] AND end_year = [end_year]). Preserve the requested offense, metric, breakdowns, and year range.]";
}

function juvenileIncidentRollupAvailable(): boolean {
  try {
    return Boolean(getNibrsDb().prepare(
      "SELECT 1 FROM nibrs_summary_freshness WHERE summary_name='summary_juvenile_offender_incidents' AND ready=1"
    ).get());
  } catch {
    return false;
  }
}

/** Resolve which model this request should use. Returns the full model ID. */
function resolveNibrsModel(sessionId: string | null, canaryFlag: boolean): string {
  const defaultModel = process.env.NIBRS_MODEL || "claude-haiku-4-5-20251001";
  const canaryModel = process.env.NIBRS_CANARY_MODEL;
  if (!canaryModel) return defaultModel;

  // Canary via explicit request flag (admin/eval use)
  if (canaryFlag) return canaryModel;

  // Canary via session allowlist
  const allowlist = process.env.NIBRS_CANARY_SESSIONS;
  if (allowlist && sessionId) {
    const allowed = new Set(allowlist.split(",").map(s => s.trim()).filter(Boolean));
    if (allowed.has(sessionId)) return canaryModel;
  }

  return defaultModel;
}

export async function POST(req: NextRequest) {
  // Measured before the outer try so the operational row in its catch can record an
  // elapsed time; everything declared inside the try is out of scope there.
  const outerStart = Date.now();
  const routeStart = Date.now();
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
    const chartAuditRequestId = createChartAuditRequestId();
    let chartAuditQueryLogId: number | null = null;
    const sessionId: string | null = ((body?.sessionId as string) || "").slice(0, 64) || null;
    const canaryFlag = body?._canary === true;

    // Resolve model for this request
    const activeModel = resolveNibrsModel(sessionId, canaryFlag);
    const activeModelLabel = modelLabel(activeModel);
    let retryCount = 0;
    let scaffoldStripped = false;
    const routingMeta = parseRoutingLogMeta(body);

    /**
     * The question the proof layer reasons about: the RECONSTRUCTED one for follow-ups.
     * query_log keeps the RAW question so the reviewer sees what the user typed.
     */
    let proofQuestion = question;

    /**
     * Validity signature for cached entries: enforcement state plus source data
     * version. A change to either produces a cache miss rather than replaying SQL
     * authored under conditions no longer in force (handoff §4, §13). dataVersion is
     * null until Stage 2 builds the source-health registry.
     */
    const cacheValidity = cacheValiditySignature("nibrs", null);


    /**
     * Proof finalization for one terminal exit of this route.
     *
     * This response is atomic, so there is no first-event ordering hazard --
     * applyResultDisclosures() already runs before delivery here (handoff §4).
     */
    const finalizeExit = (
      opts: Partial<ProofFinalizationInput> & { outcome: QueryLogOutcome },
    ): ProofFinalization =>
      finalizeProof({
        sourceId: "nibrs",
        question: proofQuestion,
        sql: null,
        rows: [],
        columns: [],
        truncated: false,
        planFamily: null,
        ...opts,
      });

    const writeNibrsLog = (
      q: string,
      sqlText: string | null,
      rowCount: number,
      logError: string | null,
      ms: number,
      logResponse: string | null = null,
      guardrails: string[] = [],
      model: string | null = null,
      sid: string | null = null,
      /** Phase 3 chart capture; pre-serialized via the allowlist in lib/chart-config-log. */
      chartConfigJson: string | null = null,
      /** Bounded raw model text on no-SQL failures; diagnostic only, never user-visible. */
      modelResponseJson: string | null = null,
      /** Proof finalization for this exit; null yields baseline-identical columns. */
      proof: ProofFinalization | OutcomeLogRecord | null = null
    ) => {
      chartAuditQueryLogId = logNibrsQuery(q, sqlText, rowCount, logError, ms, logResponse, guardrails, model, sid, routingMeta, chartConfigJson, modelResponseJson, chartAuditRequestId, proofLogFields(decisionFinalization(proof)), outcomeLogFields(asOutcomeRecord(proof)));
      return chartAuditQueryLogId;
    };

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

    // Query-bearing follow-ups (prior SQL + a change request) must reach the
    // model path with history — never the standalone metadata/county shortcuts.
    const queryBearingFollowup = detectQueryBearingFollowup(question, body?.history);
    const plannerMode = plannerModeForSource('nibrs');
    const followupPlan = plannerMode === 'off' ? null : planFollowupSafe(question, body?.history, 'nibrs');
    if (followupPlan && plannerMode === 'compare') {
      console.log('[followup-planner][compare] ' + JSON.stringify({ source: 'nibrs', kind: followupPlan.kind, changeKinds: followupPlan.changeKinds, plannedSource: followupPlan.source, sourceChanged: followupPlan.sourceChanged, legacyBearing: Boolean(queryBearingFollowup), q: question.slice(0, 160), reconstructed: followupPlan.reconstructedQuestion.slice(0, 200) }));
    }
    const planSaysQueryBearing = (plannerMode === 'authoritative' && followupPlan)
      ? followupPlan.kind === 'query_bearing'
      : Boolean(queryBearingFollowup);
    const capabilityQuestion = followupPlan?.kind === "query_bearing"
      ? followupPlan.reconstructedQuestion
      : question;
    const capabilityStart = Date.now();
    // Every exit from here to the guardrail reconstruction below -- capability
    // override, completeness, source switch, geo clarification, county scope -- runs
    // BEFORE guardrailQuestion exists. They were therefore reasoning about the raw
    // question, so a follow-up fragment ("just clearances by type") gave the proof
    // layer no entities and silently lost its completeness check on those paths.
    // capabilityQuestion is the reconstruction available at this point.
    proofQuestion = capabilityQuestion;
    const capabilityOverride = detectNibrsCapabilityOverride(capabilityQuestion);
    if (capabilityOverride) {
      const executionMs = Date.now() - capabilityStart;
      const capabilityProof = finalizeExit({ outcome: OUTCOMES.capability_path_unavailable, planFamily: capabilityOverride.guardrail, narrative: capabilityOverride.explanation });
      writeNibrsLog(question, null, 0, null, executionMs, capabilityOverride.explanation, [capabilityOverride.guardrail], "deterministic", sessionId, null, null, capabilityProof);
      return jsonResp(emitFactualPayload(capabilityProof, {
        success: true,
        question,
        sql: null as unknown as string,
        explanation: capabilityOverride.explanation,
        title: capabilityOverride.title,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: { source: "FBI NIBRS", agencyCount: 0, population: null },
        executionTimeMs: executionMs,
      } as QueryResponse));
    }
    // Stage 2b: the follow-up resolvers run here, unchanged, so the one ledger boundary below sees the effective question
    // before any exit that can deliver a number (plan §3).
    const history = normalizeHistoryForTab(body?.history, "nibrs");
    const followupTransform = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing")
      ? followupPlan.transform
      : (detectFollowupTransform(question, history) ?? buildCrossSourceFollowupTransform(question, body?.history, "nibrs"));
    // ── Cause C/D: an explicit police-clearance refinement carries its request forward ──────
    //
    // "Now what about just the share that's prosecution declined" settles nothing on its own, so
    // every consumer below — the contract, the place resolver, the query context and the proof —
    // was reasoning about a fragment, and GC-004's statement was refused for computing a share
    // the contract had no way to recognize. This restores the PRIOR request's offense, geography
    // and period with the newly asked reason in place of the old one, and only when the turn
    // names a clearance reason and settles nothing of its own. An explicit new request is left
    // exactly as the reader wrote it.
    const clearanceRefinement = resolveClearanceRefinement(question, body?.history, "nibrs");
    // AGENCY+RANK batch (GC-116): a turn that only changes the population-peer count carries the prior peer request
    // forward with the new count, so the owned plan answers it. Only where the turn would otherwise reach the planner.
    const peerFollowup = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") || followupTransform || clearanceRefinement
      ? null
      : resolvePeerCountFollowup(question, body?.history, "nibrs");
    // GC-091 batch: a question about the previous agency-period ranking itself ("why are murders the same for all of these
    // cities?") carries that ranking request forward unchanged, so the owned plan runs again and the answer explains what its
    // rows establish. Only where the turn would otherwise reach the planner, exactly like the peer-count follow-up.
    const rankingExplanation = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") || followupTransform || clearanceRefinement || peerFollowup
      ? null
      : resolveRankingExplanationFollowup(question, body?.history);
    const plannerQuestion = peerFollowup?.refinedQuestion ?? rankingExplanation?.refinedQuestion ?? question;
    const guardrailQuestion = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing")
      ? followupPlan.reconstructedQuestion
      : (clearanceRefinement?.refinedQuestion ?? peerFollowup?.refinedQuestion ?? rankingExplanation?.refinedQuestion ?? followupTransform?.contextQuestion ?? question);

    // ── Request accounting, stage 2b (NIBRS; plan docs/superpowers/plans/2026-10-09-request-accounting-stage2b-nibrs.md) ──
    // ONE ledger, on the effective question (an authoritative reconstruction, else a resolver's refined question, else the
    // follow-up transform's context question, else the turn as typed), before any exit that can deliver a number (§3).
    // The request kind and every explanation request come from the turn AS TYPED (r1.1 R1). Every non-context part must be
    // applied by value by whichever path answers: a fixed path whose own plan used it, or a supported type (N1-N7).
    const nibrsTurnLedger = accountNibrsRequest(question);
    const nibrsLedger = guardrailQuestion === question ? nibrsTurnLedger : accountNibrsRequest(guardrailQuestion);
    const nibrsTurnExplains = nibrsTurnLedger.parts.some((p) => p.concept === "explain");
    // The owned agency-period ranking matches the WHOLE turn by its own closed grammar (GC-091), and its explanation
    // follow-up carries that request forward unchanged: as for 2a's whole-turn families, it keeps its own path.
    const nibrsWholeTurn = recognizeAgencyPeriodRanking(plannerQuestion)?.kind === "request";
    const nibrsNumeric = nibrsRequestKind(nibrsTurnLedger) === "numeric" && !nibrsWholeTurn;
    /** The one sealed exit for every NIBRS accounting decline or clarification (follow-up, recognition, types, gate). */
    const nibrsAccountingExit = (refusal: { parts: AccountingPart[]; explanation: string }, owner: string, clarify = false) => {
      const ms = Date.now() - routeStart;
      const tags = ["request-accounting", `request-accounting-owner:${owner}`, ...refusal.parts.map((p) => `request-accounting:${p.state}:${p.concept}`)];
      const accountingProof = finalizeExit({ outcome: clarify ? OUTCOMES.measure_ambiguous : OUTCOMES.capability_path_unavailable, planFamily: "request-accounting", guardrails: tags, narrative: refusal.explanation });
      writeNibrsLog(question, null, 0, null, ms, refusal.explanation, tags, "deterministic", sessionId, null, null, accountingProof);
      return jsonResp(emitFactualPayload(accountingProof, {
        success: true, question, sql: null as unknown as string, explanation: refusal.explanation, title: clarify ? "Clarification needed" : "Not answered",
        columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: ms,
      } as QueryResponse));
    };
    // K2 for every replacement (r1.1 R1): the authoritative reconstruction, the clearance refinement, the peer-count and
    // ranking-explanation follow-ups, and the follow-up transform's context question.
    const priorNibrsTurns = normalizeHistoryForTab(body?.history, "nibrs", 50).filter((m) => m.role === "user").map((m) => m.content);
    const nibrsResolverQuestion = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing")
      ? followupPlan.reconstructedQuestion
      : (clearanceRefinement?.refinedQuestion ?? peerFollowup?.refinedQuestion ?? rankingExplanation?.refinedQuestion ?? followupTransform?.contextQuestion ?? null);
    // r2 (task 0): a TEXT turn that a resolver rebuilt (the ranking-explanation follow-up is always a "why" turn) is
    // checked too; a TEXT follow-up nobody rebuilt keeps the model's text reply.
    if (!nibrsNumeric && nibrsResolverQuestion !== null && priorNibrsTurns.length > 0) {
      const carried = nibrsFollowupCheck({ question, effective: nibrsResolverQuestion, previousUserTurns: priorNibrsTurns, isFollowUp, earlierOnly: true });
      if (carried) return nibrsAccountingExit({ parts: [], explanation: carried.explanation }, "followup");
    }
    if (nibrsNumeric) {
      const isNibrsFollowup = priorNibrsTurns.length > 0
        && (isFollowUp(question) || Boolean(queryBearingFollowup) || followupPlan?.kind === "query_bearing" || nibrsResolverQuestion !== null);
      if (isNibrsFollowup) {
        const carried = nibrsFollowupCheck({ question, effective: nibrsResolverQuestion, previousUserTurns: priorNibrsTurns, isFollowUp });
        if (carried) return nibrsAccountingExit({ parts: [], explanation: carried.explanation }, "followup");
      }
      const recognitionRefusal = nibrsRecognitionRefusal(nibrsLedger);
      if (recognitionRefusal) return nibrsAccountingExit(recognitionRefusal, "recognition");
    }
    /**
     * A fixed path keeps a NIBRS request only when its applied values account for every part (plan §5, L1-L3), for EVERY
     * request whatever its kind. "Why" in the turn as typed is applied only by the ranking-explanation path (r1.1 R1).
     */
    const nibrsOwns = (applied: NibrsApplied | undefined | null): boolean => {
      if (!applied) return false;
      if (nibrsTurnExplains && !applied.explain) return false;
      return nibrsLegacyBound(nibrsLedger, applied);
    };

    const completenessIntent = detectCompletenessQuestion(question);
    const completenessOwned = Boolean(completenessIntent) && nibrsOwns({
      operations: ["completeness"], years: completenessIntent?.year ? { start: completenessIntent.year, end: completenessIntent.year } : null,
    });
    if (completenessIntent && completenessOwned) {
      const completenessAnswer = buildCompletenessAnswer("nibrs", loadCompletenessRows("nibrs", getNibrsDb()), new Date().getFullYear(), completenessIntent.year);
      const executionMs = Date.now() - routeStart;
      const completenessProof = finalizeExit({ outcome: OUTCOMES.deterministic_plan, planFamily: "completeness-deterministic", guardrails: ["completeness-deterministic"], narrative: completenessAnswer });
      writeNibrsLog(question, null, 0, null, executionMs, completenessAnswer, ["completeness-deterministic"], "deterministic", sessionId, null, null, completenessProof);
      return jsonResp(emitFactualPayload(completenessProof, { success: true, question, sql: null as unknown as string, explanation: completenessAnswer, title: "Data completeness", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: executionMs } as QueryResponse));
    }
    if (plannerMode === "authoritative" && followupPlan?.sourceChanged) {
      const executionMs = Date.now() - routeStart;
      const explanation = "This follow-up is a better fit for the " + followupPlan.source + " source. Rerunning it there as: " + followupPlan.reconstructedQuestion;
      const switchProof = finalizeExit({ outcome: OUTCOMES.source_switch, planFamily: "followup-source-switch", narrative: explanation });
      writeNibrsLog(question, null, 0, null, executionMs, explanation, ["followup-source-switch"], "followup-planner", sessionId, null, null, switchProof);
      return jsonResp(emitFactualPayload(switchProof, {
        success: true, question, sql: null, explanation, title: "Source switch", columns: [], rows: [],
        rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: executionMs,
        sourceSwitch: { source: followupPlan.source, question: followupPlan.reconstructedQuestion },
      }));
    }
    // ── Increment 3 (Decision 9): violent / property / both ──────────────────
    // The shared gate, on the reconstructed question for follow-ups. The frozen NIBRS
    // case ("total crime ... broken down by vilont vs nonvilont") asks for a breakdown BY
    // type, so the core returns answer-direct and this gate stays silent for it.
    const crimeTypeQuestion = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing" && !followupPlan.chartOnly)
      ? followupPlan.reconstructedQuestion
      : question;
    const crimeTypeAsk = getBlockingGeoClarification(crimeTypeQuestion)
      ? null
      : shouldAskCrimeType(crimeTypeQuestion, normalizeHistoryAllSources(body?.history));
    if (crimeTypeAsk?.needsClarification) {
      const executionMs = Date.now() - routeStart;
      const ctProof = finalizeExit({ outcome: OUTCOMES.measure_ambiguous, planFamily: "crime-type:violent-property-both", narrative: crimeTypeAsk.clarificationQuestion });
      writeNibrsLog(question, null, 0, null, executionMs, crimeTypeAsk.clarificationQuestion, ["crime-type:violent-property-both"], "deterministic", sessionId, null, null, ctProof);
      return jsonResp(emitFactualPayload(ctProof, {
        success: true,
        question,
        sql: null as unknown as string,
        explanation: crimeTypeAsk.clarificationQuestion,
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

    const geoClarification = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing")
      ? (followupPlan.chartOnly ? null : getBlockingGeoClarification(followupPlan.reconstructedQuestion))
      : getBlockingGeoClarification(question);
    if (geoClarification) {
      const executionMs = Date.now() - routeStart;
      const geoProof = finalizeExit({ outcome: OUTCOMES.geography_ambiguous, planFamily: `geo:${geoClarification.issue.id}`, narrative: geoClarification.explanation });
      writeNibrsLog(question, null, 0, null, executionMs, geoClarification.explanation, [`geo:${geoClarification.issue.id}`], "deterministic", sessionId, null, null, geoProof);
      return jsonResp(emitFactualPayload(geoProof, {
        success: true,
        question,
        sql: null as unknown as string,
        explanation: geoClarification.explanation,
        title: "",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: executionMs,
      } as QueryResponse));
    }

    const countyScope = planSaysQueryBearing ? null : getCountyScopeClarification(question, body?.history);
    if (countyScope) {
      const executionMs = Date.now() - routeStart;
      const countyProof = finalizeExit({ outcome: OUTCOMES.geography_scope_ambiguous, planFamily: `geo:${countyScope.id}`, narrative: countyScope.explanation });
      writeNibrsLog(question, null, 0, null, executionMs, countyScope.explanation, [`geo:${countyScope.id}`], "deterministic", sessionId, null, null, countyProof);
      return jsonResp(emitFactualPayload(countyProof, {
        success: true,
        question,
        sql: null as unknown as string,
        explanation: countyScope.explanation,
        title: "",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: executionMs,
      } as QueryResponse));
    }

    // Proof reasons about the reconstructed question from here on; a bare follow-up
    // fragment names no entities and would silently lose its completeness check.
    proofQuestion = guardrailQuestion;
    const basePromptHistory = followupTransform
      ? [...history, { role: "user" as const, content: followupTransform.instruction }]
      : history;
    const promptContract = buildQueryContract(guardrailQuestion, "nibrs");
    const resolutionPlan = resolveNibrsPlaces(getNibrsDb(), guardrailQuestion, promptContract);
    const deterministicResolution = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? null : (followupTransform ? null : resolutionPlan);
    if (resolutionPlan) {
      console.log(
        `[nibrs][resolver] ${resolutionPlan.elapsedMs}ms ` +
        resolutionPlan.places.map((place) => `${place.kind}:${place.status}`).join(",")
      );
    }
    const deterministicGuardrails = (guardrail: string) => [
      guardrail,
      ...(deterministicResolution?.places.some((place) => place.status === "resolved")
        ? ["nibrs-place-resolved"]
        : []),
    ];

    /*
     * GC-065: an owned violent-category comparison for one named place (lib/nibrs-category-change.ts).
     * The place is resolved again over BOTH compared years -- the contract's window is only the year
     * asked about -- so the exclusion universe is defined before anything is compared. Every statement
     * it runs is refused or accepted by the same structural proof as the other deterministic plans, and
     * a refused one ends here: it never falls through to model-written SQL.
     */
    // GC-003: "where" that names no level (state, city or agency) is asked about, in owned wording
    // (lib/where-level-clarification.ts), for as long as it stays unanswered. Read from the
    // reconstructed request, so a level carried in from valid context -- including the reply to this
    // question, resolved by lib/followup-transform.ts -- counts as stated.
    // CR-2: while the question is pending, a turn that neither chooses a level nor makes a new request
    // ("Not by state", "I don't know") asks it again instead of reaching a path that could guess.
    const whereLevel = pendingWhereLevelReask({ question, contract: buildQueryContract(question, "nibrs"), history: body?.history })
      ?? whereLevelClarification({ question: guardrailQuestion, contract: promptContract });
    if (whereLevel) {
      const executionMs = Date.now() - routeStart;
      const whereProof = finalizeExit({ outcome: OUTCOMES.geography_scope_ambiguous, planFamily: whereLevel.id, narrative: whereLevel.explanation });
      writeNibrsLog(question, null, 0, null, executionMs, whereLevel.explanation, [whereLevel.id], "deterministic", sessionId, null, null, whereProof);
      return jsonResp(emitFactualPayload(whereProof, {
        success: true, question, sql: null as unknown as string, explanation: whereLevel.explanation, title: "",
        columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: executionMs,
      } as QueryResponse));
    }

    /*
     * The executor for the application-built statements an owned family runs beside (or instead of) a
     * plan: GC-065's comparison and the NIBRS city ranking's S1 candidates read. The structural proof
     * is repeated at the execution itself, so nothing reaches the database on a family's word that it
     * checked: a refused statement throws here and runs nothing.
     */
    const runOwnedStatement = async (statement: string, contract: ReturnType<typeof rankingValidationContract> = null): Promise<Record<string, unknown>[]> => {
      const ownedStatement = { sql: statement };
      const ownedStatementRefusal = deterministicPlanRefusal({ question, source: "nibrs", sql: ownedStatement.sql, contract });
      if (!ownedStatementRefusal) {
        return normalizeNibrsDisplayRows((await executeWithTimeout(ownedStatement.sql)).rows) as Record<string, unknown>[];
      }
      throw new Error("an owned family attempted to execute a refused statement");
    };

    const recognizedCategoryChange = deterministicResolution ? recognizeCategoryChange(question) : null;
    // Stage 2b (plan §5): kept only when it applies every part -- the place it resolves, the UCR violent category, the
    // direction it ranks ("greatest increase/decrease" is its top-1), and the two years it compares. Its own decline
    // (an unsupported form) delivers no number and is kept.
    const categoryChange = recognizedCategoryChange?.kind === "request" && promptContract && !nibrsOwns({
      places: placesFromGeographies(promptContract.geographies.length ? promptContract.geographies : [promptContract.geography]),
      codeGroups: [MEASURE_CODES.violent_crime], rank: { dir: "top", n: 1 }, change: [recognizedCategoryChange.direction],
      periodValues: [`year:${recognizedCategoryChange.year}`, `year:${recognizedCategoryChange.prior}`, `range:${recognizedCategoryChange.prior}:${recognizedCategoryChange.year}`, `between:${recognizedCategoryChange.prior}:${recognizedCategoryChange.year}`],
      versus: "years",
    }) ? null : recognizedCategoryChange;
    if (categoryChange && promptContract) {
      const changeStart = Date.now();
      const changeGuardrails = deterministicGuardrails(NIBRS_CATEGORY_CHANGE_GUARDRAIL);
      const changePlan = categoryChange.kind === "request"
        ? planCategoryChange(categoryChange, resolveNibrsPlaces(getNibrsDb(), guardrailQuestion, {
            ...promptContract,
            time: { ...promptContract.time, startYear: categoryChange.prior, endYear: categoryChange.year },
          }))
        : categoryChange;
      const outcome = changePlan.kind === "plan"
        ? await runOwnedCategoryChange({
            plan: changePlan,
            refusal: (statement) => deterministicPlanRefusal({ question, source: "nibrs", sql: statement }),
            execute: runOwnedStatement,
          })
        : { kind: "decline" as const, reason: "unsupported" as const, sql: null, explanation: changePlan.explanation };
      const changeMs = Date.now() - changeStart;
      if (outcome.kind === "decline") {
        const changeProof = finalizeExit({
          outcome: outcome.reason === "no-complete-reporter" ? OUTCOMES.reporting_coverage_insufficient : OUTCOMES.capability_path_unavailable,
          sql: outcome.sql, planFamily: NIBRS_CATEGORY_CHANGE_GUARDRAIL, guardrails: changeGuardrails,
          narrative: outcome.explanation,
        });
        writeNibrsLog(question, outcome.sql, 0, `category_change_${outcome.reason}`, changeMs, outcome.explanation,
          changeGuardrails, "deterministic", sessionId, null, null, changeProof);
        return jsonResp(emitFactualPayload(changeProof, {
          success: true, question, sql: outcome.sql as unknown as string,
          explanation: outcome.explanation, title: "Comparison Not Available",
          columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null,
          executionTimeMs: changeMs,
        } as QueryResponse));
      }
      const changeProof = finalizeExit({
        outcome: OUTCOMES.deterministic_plan, sql: outcome.sql, rows: outcome.rows, columns: outcome.columns,
        truncated: false, derivation: sealPlanDerivation(NIBRS_CATEGORY_CHANGE_GUARDRAIL, outcome.sql),
        planFamily: NIBRS_CATEGORY_CHANGE_GUARDRAIL, guardrails: changeGuardrails,
        returnedEntities: returnedEntityKeys(outcome.rows), narrative: outcome.explanation,
        hasChart: false,
      });
      writeNibrsLog(question, outcome.sql, outcome.rows.length, null, changeMs, outcome.explanation,
        changeGuardrails, "deterministic", sessionId, null, null, changeProof);
      return jsonResp(emitFactualPayload(changeProof, {
        success: true, question, sql: outcome.sql, explanation: outcome.explanation, title: outcome.title,
        columns: outcome.columns, rows: outcome.rows, rowCount: outcome.rows.length,
        truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: changeMs,
      } as QueryResponse));
    }

    const nibrsPlan = planNibrsQuery(plannerQuestion, deterministicResolution, {
      allowDeterministic: (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? false : !followupTransform,
      juvenileIncidentRollupAvailable: juvenileIncidentRollupAvailable(),
      // Injected so the city-ranking builder can resolve "latest year with data" without the
      // planner importing a module that probes the databases at load time.
      // `observed` travels with the date. Dropping it let a clock-based fallback be delivered as
      // "the latest year with data" when the startup probe of the NIBRS database had failed.
      dataCutoff: {
        year: NIBRS_DATA_CUTOFF.year,
        month: NIBRS_DATA_CUTOFF.month,
        observed: NIBRS_DATA_CUTOFF.observed,
      },
    });
    // GC-091 batch: the explanation follow-up runs the same owned statement with an answer addressed to the question asked.
    if (rankingExplanation && nibrsPlan.kind === "deterministic" && nibrsPlan.query.guardrail === AGENCY_PERIOD_RANKING_GUARDRAIL) {
      nibrsPlan.query = asExplanationFollowup(nibrsPlan.query, rankingExplanation.priorQuestion);
    }
    // Stage 2b (plan §5): a deterministic plan is kept only when its applied values account for every part of the request.
    // The owned agency-period ranking keeps its whole-turn path. An unowned plan never runs: a NUMERIC request goes to the
    // supported types below, a TEXT request to the model's text reply, whose SQL never runs (§6).
    const nibrsPlanOwned = nibrsPlan.kind !== "deterministic"
      || (nibrsPlan.query.guardrail === AGENCY_PERIOD_RANKING_GUARDRAIL && nibrsWholeTurn)
      || nibrsOwns(nibrsPlan.query.applied);
    if (nibrsPlan.kind === "deterministic" && !nibrsPlanOwned) {
      console.log(`[request-accounting] NIBRS fixed plan ${nibrsPlan.query.guardrail} does not apply every part; not run`);
    }
    // Jeff's ruling 4 (2b prereg fact 4): the city ranking's "not by that measure" decline does not own a clearance-rate
    // ranking; the request reaches N6. Every other city-ranking decline stays owned.
    const nibrsPlanDeclineYields = nibrsPlan.kind === "unavailable" && nibrsPlan.reason === "unit-clearance_rate" && nibrsNumeric;
    if (nibrsPlan.kind === "blocked" && deterministicResolution) {
      const executionMs = Date.now() - routeStart;
      const explanation = nibrsPlan.explanation;
      const placeBlockProof = finalizeExit({ outcome: OUTCOMES.place_unresolved, planFamily: "nibrs-place-resolution-block", narrative: explanation });
      writeNibrsLog(question, null, 0, null, executionMs, explanation, ["nibrs-place-resolution-block"], "deterministic", sessionId, null, null, placeBlockProof);
      return jsonResp(emitFactualPayload(placeBlockProof, {
        success: true,
        question,
        sql: null as unknown as string,
        explanation,
        title: "Agency Resolution Needed",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: executionMs,
      } as QueryResponse));
    }

    if (nibrsPlan.kind === "unavailable" && !nibrsPlanDeclineYields) {
      const executionMs = Date.now() - routeStart;
      const juvenileProof = finalizeExit({ outcome: OUTCOMES.required_component_unavailable, planFamily: "nibrs-juvenile-offender-incident-summary-unavailable", narrative: nibrsPlan.explanation });
      writeNibrsLog(question, null, 0, null, executionMs, nibrsPlan.explanation, ["nibrs-juvenile-offender-incident-summary-unavailable"], "deterministic", sessionId, null, null, juvenileProof);
      return jsonResp(emitFactualPayload(juvenileProof, {
        success: true,
        question,
        sql: null as unknown as string,
        explanation: nibrsPlan.explanation,
        title: nibrsPlan.title,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: executionMs,
      } as QueryResponse));
    }

    // Structural proof BEFORE execution. This branch runs and returns long before the model path's
    // contract validation, so without it the plan executed with no proof at all. A refused plan is
    // not used: the request falls through to the model path, which validates in full.
    // The owned city ranking validates a stated nationwide scope against its assembled scope; every
    // other deterministic plan validates against the question exactly as before.
    const nibrsPlanContract = nibrsPlan.kind === "deterministic" && nibrsPlan.query.guardrail === NIBRS_CITY_RANKING_GUARDRAIL
      ? rankingValidationContract(question, "nibrs")
      : null;
    const nibrsPlanRefusal = nibrsPlan.kind === "deterministic" && nibrsPlanOwned
      ? deterministicPlanRefusal({ question: plannerQuestion, source: "nibrs", sql: nibrsPlan.query.sql, contract: nibrsPlanContract })
      : null;
    if (nibrsPlanRefusal) {
      console.log(`[structural] NIBRS deterministic plan refused: ${nibrsPlanRefusal.ruleIds.join(", ")}`);
    }

    /*
     * A REFUSED PLAN FROM AN OWNED FAMILY IS THAT FAMILY'S FAILURE, NOT A REASON TO GENERATE SQL.
     *
     * The branch below deliberately skips a refused plan and lets the request continue to the model
     * path, which validates in full -- correct for the general builders. It was wrong for the city
     * ranking: the request that reached the model was the SAME one, and answering it with generated
     * SQL restores exactly the eligibility-versus-measure confusion the constructed family removed.
     * The comment on that branch described the fall-through plainly, and it applied here too.
     */
    // AGENCY+RANK batch: the population-peer comparison follows the same rule (Decision 16). Its refused plan used to
    // fall through to model-written SQL, which chose "peers" by clearance rate and repeated one agency per year (GC-115).
    // One exit serves both owned families; only the family, tags and owned sentence differ.
    const refusedOwnedFamily = nibrsPlan.kind === "deterministic" && nibrsPlanRefusal
      ? nibrsPlan.query.guardrail === NIBRS_CITY_RANKING_GUARDRAIL
        ? { family: NIBRS_CITY_RANKING_GUARDRAIL, tag: "city-ranking-structural-refusal", log: "city_ranking_structural_refusal", text: CITY_RANKING_FAILURE_TEXT, title: "Ranking Not Available" }
        : nibrsPlan.query.guardrail === PEER_COMPARISON_GUARDRAIL
          ? { family: PEER_COMPARISON_GUARDRAIL, tag: "peer-comparison-structural-refusal", log: "peer_comparison_structural_refusal", text: PEER_COMPARISON_REFUSED_TEXT, title: "Peer comparison unavailable" }
          // GC-091 batch: the owned agency-period ranking follows the same rule.
          : nibrsPlan.query.guardrail === AGENCY_PERIOD_RANKING_GUARDRAIL
            ? { family: AGENCY_PERIOD_RANKING_GUARDRAIL, tag: "agency-period-ranking-structural-refusal", log: "agency_period_ranking_structural_refusal", text: AGENCY_PERIOD_RANKING_FAILURE_TEXT, title: "Ranking Not Available" }
            : null
      : null;
    if (nibrsPlan.kind === "deterministic" && refusedOwnedFamily) {
      const refusedMs = Date.now() - routeStart;
      const refusedGuardrails = [refusedOwnedFamily.family, refusedOwnedFamily.tag];
      const refusedProof = finalizeExit({
        outcome: OUTCOMES.sql_shape_rejected, sql: nibrsPlan.query.sql,
        planFamily: refusedOwnedFamily.family, guardrails: refusedGuardrails,
        narrative: refusedOwnedFamily.text,
      });
      writeNibrsLog(question, nibrsPlan.query.sql, 0, refusedOwnedFamily.log, refusedMs,
        refusedOwnedFamily.text, refusedGuardrails, "deterministic", sessionId, null, null, refusedProof);
      return jsonResp(emitFactualPayload(refusedProof, {
        success: true, question, sql: null as unknown as string,
        explanation: refusedOwnedFamily.text, title: refusedOwnedFamily.title,
        columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null,
        executionTimeMs: refusedMs,
      } as QueryResponse));
    }

    /*
     * THE OWNED FAMILY'S WHOLE FLOW IS ONE PRODUCTION FUNCTION.
     *
     * `runOwnedAnnualClearance` decides refusal, execution, per-year evidence and wording, and the
     * route hands it the same bounded executor every other plan uses. Keeping it out of the handler
     * is what lets a test run these exact branches with a counting executor, instead of matching
     * regexes against this file.
     */
    // Stage 2b (exit audit 858): a refused plan from a non-owned family used to fall through to model SQL. There is no
    // model fallback now, so it is declined with its reason.
    // A NUMERIC request goes on to the supported types (the deterministic branch below skips a refused plan); anything else
    // is declined with the reason.
    if (nibrsPlan.kind === "deterministic" && nibrsPlanOwned && nibrsPlanRefusal && !refusedOwnedFamily && !runsAnnualClearanceFlow(nibrsPlan.query.guardrail) && !nibrsNumeric) {
      return nibrsAccountingExit({ parts: [], explanation: "I built a fixed statement for this question, but it didn't pass this site's structural check, so I haven't answered with a number." }, "fixed-path-refused");
    }

    if (nibrsPlan.kind === "deterministic" && nibrsPlanOwned && runsAnnualClearanceFlow(nibrsPlan.query.guardrail)) {
      const ownedQuery = nibrsPlan.query;
      const ownedStart = Date.now();
      const outcome = await runOwnedAnnualClearance({
        question,
        place: deterministicResolution?.places[0]?.label ?? "the requested agency",
        query: ownedQuery,
        refusal: nibrsPlanRefusal,
        // The parameter is deliberately NOT called `sql`: that name means model-generated SQL in
        // this handler, and an execution site holding it is exactly what the placement scan hunts
        // for. Refusing anything but the planned statement makes the distinction a guarantee rather
        // than a naming convention.
        execute: async (plannedSql) => {
          if (!nibrsPlanRefusal && plannedSql === ownedQuery.sql) {
            const result = await executeWithTimeout(ownedQuery.sql);
            return { rows: normalizeNibrsDisplayRows(result.rows) as unknown[], columns: result.columns };
          }
          throw new Error("owned family attempted to execute a refused or unplanned statement");
        },
      });
      const ownedGuardrails = deterministicGuardrails(ownedQuery.guardrail);
      const ownedMs = Date.now() - ownedStart;

      if (outcome.kind === "decline") {
        const ownedProof = finalizeExit({
          outcome: outcome.reason === "no-supportable-year" ? OUTCOMES.annual_result_not_supported : OUTCOMES.capability_path_unavailable,
          sql: outcome.sql ?? ownedQuery.sql,
          planFamily: ownedQuery.guardrail,
          guardrails: ownedGuardrails,
          narrative: outcome.explanation,
        });
        writeNibrsLog(question, outcome.sql ?? ownedQuery.sql, 0, `owned_family_${outcome.reason}`,
          ownedMs, outcome.explanation, ownedGuardrails, "deterministic", sessionId, null, null, ownedProof);
        return jsonResp(emitFactualPayload(ownedProof, {
          success: true, question, sql: outcome.sql as unknown as string,
          explanation: outcome.explanation, title: outcome.title,
          columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null,
          executionTimeMs: ownedMs,
        } as QueryResponse));
      }

      /*
       * The figures go through the ordinary disclosure chokepoint; the withholding reasons are
       * appended AFTER it. They are established by evidence this query fetched and checked, not by
       * the rows being returned, so the chokepoint cannot see what supports them and replaced them
       * with a generic omission notice -- losing exactly the sentence that tells the reader why a
       * year is missing. Appending narrows to this family's own established decision and exempts no
       * other narrative.
       */
      const ownedExplanation = [
        applyResultDisclosures({
          explanation: outcome.explanation, question, sql: outcome.sql, rows: outcome.rows,
          tab: "nibrs", resultState: genericResultState({ sql: outcome.sql, rows: outcome.rows }),
        }),
        outcome.withheldNote,
      ].filter(Boolean).join("\n\n");
      const ownedTitle = alignTitleYearRange(outcome.title, outcome.rows);
      const ownedChart = buildNibrsChartConfig(
        { ...ownedQuery, title: ownedTitle }, outcome.columns, outcome.rows, question);
      const ownedProof = finalizeExit({
        outcome: OUTCOMES.deterministic_plan, sql: outcome.sql, rows: outcome.rows, columns: outcome.columns,
        truncated: false, derivation: sealPlanDerivation(ownedQuery.guardrail, outcome.sql),
        planFamily: ownedQuery.guardrail, guardrails: ownedGuardrails,
        returnedEntities: returnedEntityKeys(outcome.rows), narrative: ownedExplanation,
        hasChart: Boolean(ownedChart),
      });
      writeNibrsLog(question, outcome.sql, outcome.rows.length, null, ownedMs, ownedExplanation,
        ownedGuardrails, "deterministic", sessionId,
        serializeChartConfigForLog(ownedChart, outcome.columns, { source: "FBI NIBRS", agencyCount: 0, population: null }),
        null, ownedProof);
      return jsonResp(emitFactualPayload(ownedProof, attachChartAuditToPayload({
        success: true, question, sql: outcome.sql, explanation: ownedExplanation, title: ownedTitle,
        columns: outcome.columns, rows: outcome.rows, rowCount: outcome.rows.length,
        truncated: false, chartConfig: ownedChart,
        chartMeta: { source: "FBI NIBRS", agencyCount: 0, population: null },
        executionTimeMs: ownedMs,
      } as QueryResponse, { source: "nibrs", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
    }

    if (nibrsPlan.kind === "deterministic" && nibrsPlanOwned && !nibrsPlanRefusal) {
      const deterministicQuery = nibrsPlan.query;
      const deterministicStart = Date.now();
      try {
        const result = await executeWithTimeout(deterministicQuery.sql);
        const executedRows = normalizeNibrsDisplayRows(result.rows);
        // COVER batch (Codex :34982): a blank rate's established reason and activity months come from metadata the
        // same statement returned; the metadata is then removed, so delivered rows, columns and values are unchanged.
        const withheldRateNote = nibrsWithheldRateNote(deterministicQuery, executedRows);
        const delivered = withoutNibrsMetadata(deterministicQuery, result.columns, executedRows);
        const rows = delivered.rows;
        const columns = delivered.columns;

        /*
         * S1 for the NIBRS city ranking (lib/city-ranking-completeness.ts; Codex combined review): the
         * agencies with no recorded type under the same eligibility are read through the owned-statement
         * executor, and the shared decision says whether the confirmed cities are the whole answer. An
         * answer that is complete is delivered exactly as before; a failed or inconsistent read throws
         * into the owned-failure path below, never into model SQL.
         */
        let rankingPartialLead: string | null = null;
        if (deterministicQuery.guardrail === NIBRS_CITY_RANKING_GUARDRAIL && deterministicQuery.completeness) {
          const rankingPlan = deterministicQuery.completeness;
          const rankingDecision = decideCandidates(rankingPlan, await runOwnedStatement(rankingPlan.candidatesSql, nibrsPlanContract));
          if (rankingDecision.kind === "inconsistent") throw new Error(`city ranking candidates inconsistent: ${rankingDecision.reason}`);
          const rankingResult = completenessOf(rankingPlan, rankingDecision, rows, deterministicQuery.title);
          if (!rankingResult.complete) {
            const plainLead = `${deterministicQuery.title}. `;
            if (!deterministicQuery.explanation.startsWith(plainLead)) throw new Error("city ranking explanation does not begin with its title");
            rankingPartialLead = [`${rankingResult.title}.`, ...rankingResult.sentences, deterministicQuery.explanation.slice(plainLead.length)].join(" ");
            deterministicQuery.title = rankingResult.title;
          }
        }

        const executionMs = Date.now() - deterministicStart;
        const deterministicExplanation = rows.length === 0 && deterministicQuery.guardrail === PEER_COMPARISON_GUARDRAIL
          ? `No NIBRS clearance data was found for ${deterministicResolution?.places[0]?.label ?? "the named target agency"} in the requested period. A peer comparison was not returned because showing peer agencies without the requested target would be misleading.`
          : rankingPartialLead ?? deterministicQuery.explanation;
        // R1 (Decision 16): compare the SELECTED peer membership with the evidence that
        // came back. The query inner-joins clearance rows, so a selected peer with no data
        // silently disappears while the explanation still names it. Disclose that; never
        // substitute another agency, because selection is on population alone.
        let membershipNote = "";
        if (deterministicQuery.selectedPeers?.length) {
          // Review 2B: membership is decided on the SOURCE ID the selection carried and the
          // executed result returned, not on the display label. The result labels agencies
          // "SEATTLE, WA" while selection recorded "SEATTLE"; matching those as strings
          // reported peers missing that were present in the comparison all along.
          const membership = verifyPeerMembership(
            deterministicQuery.selectedPeers,
            rows.map((r) => {
              const row = r as Record<string, unknown>;
              return { id: row.ori == null ? null : String(row.ori), label: String(row.place_label ?? "") };
            }),
          );
          if (!membership.complete) membershipNote = ` ${membership.disclosure}`;
        }
        let explanation = applyResultDisclosures({
          // Peer subject-check batch (Codex :37148, truthful exclusions): the membership note is established by THIS
          // statement's rows, which the generic chokepoint cannot see, so it stripped the "returned no data" sentence and
          // left a dangling fragment. It is appended after the chokepoint below, like the withheld-rate note.
          explanation: deterministicExplanation,
          // AGENCY+RANK batch: a carried-forward peer follow-up keeps the request's own caveats (GC-116); otherwise
          // plannerQuestion is the question itself.
          question: plannerQuestion,
          sql: deterministicQuery.sql,
          rows,
          tab: "nibrs",
          resultState: genericResultState({ sql: deterministicQuery.sql, rows }),
        });
        const deterministicFiredGuardrails = deterministicGuardrails(deterministicQuery.guardrail);
        const deterministicGrainCheck = validateGrain(plannerQuestion, rows, deterministicQuery.sql);
        if (missingLowerBoundNote(plannerQuestion, deterministicQuery.sql, rows)) deterministicFiredGuardrails.push("lower-bound-disclosed");
        if (!deterministicGrainCheck.ok && deterministicGrainCheck.message) {
          explanation = deterministicGrainCheck.message;
          deterministicFiredGuardrails.push("grain-mismatch");
        }
        // The same membership gate as the model path. It was previously only on the model side, so a
        // supported builder that dropped a requested agency returned without ever being asked. The
        // mapping reads the pivoted comparison columns as identity, so GC-083-shaped answers pass on
        // their own evidence rather than being exempted.
        // The declaration is trusted only where it is BOUND to the statement that ran. Reading
        // `memberColumns` directly would let a declaration survive a rewrite of the query it
        // describes, which is the same mistake as trusting query text: a property that was true when
        // it was written, asserted about something else.
        //
        // Stated honestly: on THIS path the executed statement is `deterministicQuery.sql` itself, so
        // the two arguments coincide here and the comparison cannot fail at this call site. Its force
        // is that every site must now present the SQL it actually ran, and that
        // `test-structural-route-placement` independently pins this branch to executing that same
        // expression. The refusal of an altered or forged declaration is proved against the function
        // directly in `test-agency-answer-ownership`, not inferred from this line.
        const ownedDeclaration = ownedMemberDeclaration(deterministicQuery, deterministicQuery.sql);
        const deterministicMembers = agencyFigureFailure(resolutionPlan, columns, rows, ownedDeclaration);
        if (deterministicMembers) {
          const msg = memberRefusalText(deterministicMembers);
          const detMemberProof = finalizeExit({ outcome: OUTCOMES.geography_contract_violation, sql: deterministicQuery.sql, rows: [], columns: [], guardrails: [...deterministicFiredGuardrails, "nibrs-agency-figures-incomplete"], planFamily: "delivered-member", narrative: msg });
          writeNibrsLog(question, deterministicQuery.sql, 0, "delivered_member_incomplete", Date.now() - deterministicStart, msg, [...deterministicFiredGuardrails, "nibrs-agency-figures-incomplete"], "deterministic", sessionId, null, null, detMemberProof);
          return jsonResp(emitFactualPayload(detMemberProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - deterministicStart } as QueryResponse));
        }
        // A named agency the source has no record of cannot be queried, so the supported answer has to
        // say which one is missing rather than describe itself as covering both. This branch returns
        // without reaching the model path, so the disclosure has to be made here too -- it was only on
        // the model side, and a supported comparison that silently dropped a member said nothing.
        // Composed after every replacement above, so a grain rewrite cannot remove it, and the tag is
        // recorded only if the note is in the text that will be sent.
        //
        // The coverage state is computed ONCE, and both the note and the title are derived from it,
        // so the two cannot disagree. Previously the note was read from the resolution plan while the
        // title was the producer's requested-member list, which is how an answer covering one of two
        // agencies shipped under a title naming both.
        const deterministicCoverage = memberCoverage(
          resolutionPlan,
          mapAgencyFigures(resolutionPlan, columns, rows, ownedDeclaration)
        );
        const deterministicMissing = coverageNote(resolutionPlan, deterministicCoverage)
          ?? unresolvedMemberDisclosure(resolutionPlan);
        if (deterministicMissing && !explanation.includes(deterministicMissing.note)) {
          explanation = [explanation, deterministicMissing.note].filter(Boolean).join("\n\n");
        }
        if (deterministicMissing && explanation.includes(deterministicMissing.note)) {
          deterministicFiredGuardrails.push("nibrs-unresolved-member-disclosed");
        }
        // Appended after the chokepoint and any grain replacement (as the owned clearance family does): its reasons
        // are established by evidence this statement fetched, which the generic chokepoint cannot see.
        const peerMembershipNote = membershipNote.trim();
        if (peerMembershipNote && !explanation.includes(peerMembershipNote)) {
          explanation = [explanation, peerMembershipNote].filter(Boolean).join("\n\n");
          deterministicFiredGuardrails.push("peer-membership-disclosed");
        }
        // Stage 2b r2.2: a by-year demographic answer names requested years with no rows (derived from these rows).
        const missingYearsNote = demographicMissingYearsNote(deterministicQuery, rows as Record<string, unknown>[]);
        if (missingYearsNote && !explanation.includes(missingYearsNote)) {
          explanation = [explanation, missingYearsNote].join("\n\n");
          deterministicFiredGuardrails.push("demographic-missing-years-disclosed");
        }
        // GC-091 batch: the agency-period ranking's row-derived statements (coverage; for the explanation follow-up, equal
        // totals versus repeated rows), appended after the chokepoint for the same reason as the notes above.
        const agencyRankingFacts = deterministicQuery.guardrail === AGENCY_PERIOD_RANKING_GUARDRAIL
          ? agencyPeriodRankingFacts(plannerQuestion, { year: NIBRS_DATA_CUTOFF.year, month: NIBRS_DATA_CUTOFF.month, observed: NIBRS_DATA_CUTOFF.observed })
          : null;
        if (deterministicQuery.guardrail === AGENCY_PERIOD_RANKING_GUARDRAIL && !agencyRankingFacts) throw new Error("agency-period ranking: the resolved request could not be re-established");
        const agencyRankingNote = agencyRankingFacts
          ? agencyPeriodRankingNote(deterministicQuery, rows as Record<string, unknown>[], { ...agencyRankingFacts, explanation: Boolean(rankingExplanation) })
          : null;
        if (agencyRankingNote?.tail && !explanation.includes(agencyRankingNote.tail)) {
          explanation = [explanation, agencyRankingNote.tail].filter(Boolean).join("\n\n");
          deterministicFiredGuardrails.push("agency-ranking-coverage-disclosed");
        }
        // The explanation follow-up's direct answer LEADS, so the question asked is answered before the ranking is described.
        if (agencyRankingNote?.lead && !explanation.includes(agencyRankingNote.lead)) {
          explanation = [agencyRankingNote.lead, explanation].filter(Boolean).join("\n\n");
          deterministicFiredGuardrails.push("agency-ranking-explanation-followup");
        }
        if (withheldRateNote && !explanation.includes(withheldRateNote)) {
          explanation = [explanation, withheldRateNote].filter(Boolean).join("\n\n");
          deterministicFiredGuardrails.push("nibrs-withheld-rate-explained");
        }
        // Coverage first, then the year alignment, so the year range is applied to the title that
        // will actually ship rather than to one the coverage clause then replaces.
        deterministicQuery.title = alignTitleYearRange(
          coverageTitle(deterministicQuery.title, deterministicCoverage),
          rows
        );
        if (deterministicCoverage.length >= 2
          && deterministicCoverage.some((entry) => entry.state !== "figures")) {
          deterministicFiredGuardrails.push("nibrs-partial-coverage-title");
        }
        const chartConfig = buildNibrsChartConfig(deterministicQuery, columns, rows, question);

        const deterministicProof = finalizeExit({
          outcome: rows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
          sql: deterministicQuery.sql,
          rows,
          columns,
          truncated: rows.length >= 1000,
          derivation: sealPlanDerivation(deterministicQuery.guardrail, deterministicQuery.sql),
          planFamily: deterministicQuery.guardrail,
          guardrails: deterministicFiredGuardrails,
          returnedEntities: returnedEntityKeys(rows),
          narrative: explanation,
          hasChart: Boolean(chartConfig),
        });
        writeNibrsLog(
          question,
          deterministicQuery.sql,
          rows.length,
          null,
          executionMs,
          explanation,
          deterministicFiredGuardrails,
          "deterministic",
          sessionId,
          // Deterministic answers render charts too, so they need the same capture
          // as the model path -- otherwise chart auditing has a blind spot exactly
          // where the answers are most confidently presented.
          serializeChartConfigForLog(chartConfig, columns, { source: "FBI NIBRS", agencyCount: 0, population: null }),
          null,
          deterministicProof
        );

        return jsonResp(emitFactualPayload(deterministicProof, attachChartAuditToPayload({
          success: true,
          question,
          sql: deterministicQuery.sql,
          explanation,
          title: deterministicQuery.title,
          columns,
          rows,
          rowCount: rows.length,
          truncated: rows.length >= 1000,
          chartConfig,
          chartMeta: { source: "FBI NIBRS", agencyCount: 0, population: null },
          executionTimeMs: executionMs,
        } as QueryResponse, { source: "nibrs", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeNibrsLog(
          question,
          deterministicQuery.sql,
          0,
          `deterministic_nibrs_query_failed:${msg}`,
          Date.now() - deterministicStart,
          null,
          deterministicGuardrails(deterministicQuery.guardrail),
          "deterministic",
          sessionId,
          null,
          null,
          OPERATIONAL_RECORD
        );
        // Review 2C: the recovery decision is `decideDeterministicFailure` in
        // lib/nibrs-recovery.ts, not a branch written out here. A timeout stops; a peer
        // comparison stops rather than abandoning a population-chosen selection to the
        // model; anything else recovers through the guarded model path.
        // G1: the context comes from what the RESOLVER and the CONTRACT actually
        // established -- never re-parsed from the question at failure time. This was an
        // inline expression here, which is exactly how two defects hid: it dropped
        // `metric.unit` (so a clearance-rate request suggested a plain count) and it
        // pre-filtered places to the resolved ones (which cannot show that EVERY requested
        // place resolved). It now calls the same production function the tests exercise.
        const recoveryContext = buildNibrsRecoveryContext({
          resolutionPlan,
          contract: promptContract,
          query: deterministicQuery,
        });
        const recovery = decideDeterministicFailure(deterministicQuery, msg, recoveryContext);
        if (recovery.outcome === "stop") {
          return jsonResp({ success: false, error: recovery.error, sql: deterministicQuery.sql } as QueryError, 500);
        }
        // Stage 2b (plan §3): the "continue through the guarded model path" recovery is removed. With no model path, a
        // failed fixed plan ends in a decline that names the failure.
        console.warn("[nibrs] Deterministic query failed; declined (no model path under request accounting):", msg, recovery.reason);
        return nibrsAccountingExit({ parts: [], explanation: `I couldn't complete "${deterministicQuery.title}" for this question, so I haven't answered with a number. That's a failure on our side, not a statement about what the data contains.` }, "fixed-path-failed");
      }
    }

    const metadataStart = Date.now();
    const metadataCandidate = planSaysQueryBearing ? null : answerMetadataQuestion("nibrs", question, getNibrsDb());
    // Stage 2b (plan §5): bound like 2a's metadata (the coverage or completeness operation it answers).
    const metadata = metadataCandidate && nibrsOwns({ operations: ["coverage-lookup", "completeness"] }) ? metadataCandidate : null;
    if (metadata) {
      const executionMs = Date.now() - metadataStart;
      const metadataProof = finalizeExit({ outcome: OUTCOMES.deterministic_plan, sql: metadata.sql, rows: metadata.rows ?? [], columns: metadata.columns ?? [], truncated: Boolean(metadata.truncated), derivation: metadata.sql ? sealPlanDerivation("metadata-coverage-answer", metadata.sql) : null, planFamily: "metadata-coverage-answer", guardrails: ["deterministic-metadata", "metadata-coverage-answer"], hasChart: Boolean(metadata.chartConfig), narrative: metadata.explanation });
      writeNibrsLog(question, metadata.sql, metadata.rowCount, null, executionMs, metadata.explanation, ["deterministic-metadata", "metadata-coverage-answer"], "deterministic", sessionId, serializeChartConfigForLog(metadata.chartConfig, metadata.columns, metadata.chartMeta), null, metadataProof);
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
      } as QueryResponse, { source: "nibrs", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
    }

    // OWNERSHIP RESTRICTION for the bounded named-multi-agency family.
    //
    // Reaching this line means no application-owned producer answered the request. For a
    // single-agency question that is ordinary and the model path continues untouched. For a request
    // naming several agencies it is the case this milestone exists for: the answer would be a
    // comparison whose agency attribution nothing can establish. Three successive attempts to prove
    // that attribution from generated SQL were each defeated by wrapping the same substitution one
    // level further, so the request stops HERE -- before a comparison is generated or executed --
    // rather than being judged after the fact.
    //
    // This withholds correct model-written comparisons as well as wrong ones. That cost is the
    // approved trade, and the message says it is our limitation rather than a claim about the source.
    // ...and the same restriction when this turn CONTINUES such a request without restating it.
    //
    // The gate above reads the plan resolved for this turn. "now do it for 2024" names no place, so
    // the resolver returns nothing and the restriction cannot fire — while the model still answers
    // from the conversation it can see. That is how GC-073's correctly refused 36-city comparison
    // came back one turn later with 35 agencies and no attribution. The preceding refusal carried no
    // SQL, so the query-bearing follow-up detector does not see it either.
    //
    // Narrow on purpose: only a bare change of period, only when this turn establishes no scope of
    // its own, and only while the chain back to that request is unbroken. A new scope — another
    // city, a nationwide request, a different topic — stops it, so single-agency follow-ups and
    // genuinely new questions are untouched.
    // ── Request accounting, stage 2b: a NUMERIC NIBRS request no fixed path owned is answered by one of the supported
    // question types (N1-N7) with application-built statements, or declined/clarified by name. It never reaches model SQL.
    // `none` (no measure to answer with): as on Historical, the model may reply in text below, and its SQL never runs (§6).
    const nibrsTypeDecision = nibrsNumeric ? matchNibrsType(nibrsLedger) : null;
    if (nibrsNumeric && nibrsTypeDecision) {
      const decision = nibrsTypeDecision;
      if (decision.kind === "decline") return nibrsAccountingExit({ parts: decision.parts, explanation: decision.explanation }, "question-type");
      if (decision.kind === "clarify") return nibrsAccountingExit({ parts: [], explanation: decision.explanation }, "question-type", true);
    }
    if (nibrsNumeric && nibrsTypeDecision?.kind === "spec") {
      const typeDb = getNibrsDb();
      const decision = nibrsTypeDecision;
      const typeFamily = `nibrs-question-type:${decision.spec.type}`;
      const typedStart = Date.now();
      const compiled = await compileNibrsSpec(decision.spec, {
        db: typeDb,
        now: new Date(),
        cutoff: { year: NIBRS_DATA_CUTOFF.year, month: NIBRS_DATA_CUTOFF.month },
        // A typed statement is built from the issued spec, whose every part was checked by value. The structural guard
        // (deterministicPlanRefusal) is not applied to it (2a D1, Codex-accepted); the NIBRS table allowlist still is.
        run: async (typedStatement) => {
          const tables = validateTablesForTab(typedStatement, "nibrs", typeDb);
          if (!tables.ok) throw new Error(`an owned NIBRS statement read a table outside the NIBRS allowlist (${tables.unknown.join(", ")})`);
          return normalizeNibrsDisplayRows((await executeWithTimeout(typedStatement)).rows) as Record<string, unknown>[];
        },
      });
      if (compiled.kind === "decline") return nibrsAccountingExit({ parts: [], explanation: compiled.explanation }, "question-type-compile");
      if (compiled.kind === "clarify") return nibrsAccountingExit({ parts: [], explanation: compiled.explanation }, "question-type-compile", true);
      // r2 §1 (L12): a typed answer is held to the fixed paths' rule. Every part must be a value its statements or
      // post-query operations actually used (compiled.applied); only the turn's clause-1 "why" is left to the stated
      // limitation. Otherwise nothing is delivered and each unapplied part is named.
      if (!nibrsLegacyBound(nibrsLedger, compiled.applied, new Date(), typedExplainLimitation)) {
        const unbound = nibrsUnboundParts(nibrsLedger, compiled.applied, new Date(), typedExplainLimitation);
        console.log(`[request-accounting] NIBRS typed answer ${typeFamily} does not apply: ${unbound.map((p) => `${p.concept}=${p.value ?? p.text}`).join(", ")}`);
        return nibrsAccountingExit({ parts: unbound, explanation: unbound.map((p) => `I can't apply "${p.text.trim()}" in this answer, so I haven't answered with a number that leaves it out.`).join(" ") }, "question-type-binding");
      }
      const typedExplanation = decision.explainLimitation ? `${compiled.explanation} ${decision.explainLimitation}` : compiled.explanation;
      const typedMs = Date.now() - typedStart;
      const typedSql = compiled.statements.join(";\n");
      const typedRows = compiled.rows as Record<string, unknown>[];
      const hasValue = typedRows.some((row) => ["value", "count", "share", "numerator", "change", "earlier_value", "later_value"].some((c) => row[c] !== null && row[c] !== undefined));
      const typedProof = finalizeExit({
        outcome: hasValue ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
        sql: typedSql, rows: typedRows, columns: compiled.columns, truncated: false,
        derivation: sealPlanDerivation(typeFamily, typedSql),
        planFamily: typeFamily, guardrails: ["request-accounting", typeFamily],
        returnedEntities: returnedEntityKeys(typedRows), narrative: typedExplanation, hasChart: false,
      });
      writeNibrsLog(question, typedSql, typedRows.length, null, typedMs, typedExplanation, ["request-accounting", typeFamily], "deterministic", sessionId, null, null, typedProof);
      return jsonResp(emitFactualPayload(typedProof, {
        success: true, question, sql: typedSql, explanation: typedExplanation, title: compiled.title,
        columns: compiled.columns, rows: typedRows, rowCount: typedRows.length, truncated: false, chartConfig: null,
        chartMeta: { source: "FBI NIBRS", agencyCount: 0, population: null }, executionTimeMs: typedMs,
      } as QueryResponse));
    }

    const inheritedOwnedRequest = isOwnedMultiAgencyRequest(resolutionPlan)
      ? null
      : inheritedMultiAgencyRequest(question, body?.history, "nibrs");
    if (isOwnedMultiAgencyRequest(resolutionPlan) || inheritedOwnedRequest) {
      const ownedMs = Date.now() - routeStart;
      const ownedMsg = unsupportedOwnedComparisonText();
      const ownedGuardrails = inheritedOwnedRequest
        ? ["nibrs-unowned-multi-agency-stopped", "nibrs-unowned-multi-agency-continuation"]
        : ["nibrs-unowned-multi-agency-stopped"];
      const ownedProof = finalizeExit({ outcome: OUTCOMES.capability_path_unavailable, sql: null, rows: [], columns: [], guardrails: ownedGuardrails, planFamily: "owned-member", narrative: ownedMsg });
      writeNibrsLog(question, null, 0, "unowned_multi_agency", ownedMs, ownedMsg, ownedGuardrails, "deterministic", sessionId, null, null, ownedProof);
      return jsonResp(emitFactualPayload(ownedProof, {
        success: true, question, sql: null as unknown as string, explanation: ownedMsg, title: "",
        columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null,
        executionTimeMs: ownedMs,
      } as QueryResponse));
    }

    // Step 1: Translate to SQL via Claude (with conversation history for context)
    // Bare clarifier answers ("Countywide total") carry no county name — use
    // the transform's reconstructed question so guardrails see the geography
    const isOverallRate = promptContract?.metric.unit === "rate_per_100k" &&
      promptContract.metric.unsupportedReason === null;
    const hasDemographicPlaceDisambiguation = isOverallRate &&
      removedDemographicPlaceToken(guardrailQuestion);
    const demographicPromptHistory = hasDemographicPlaceDisambiguation
      ? [...basePromptHistory, {
          role: "user" as const,
          content: "[SYSTEM: The query contract classifies this as an overall jurisdiction rate, not a demographic-group rate. Any demographic-looking word is part of a resolved place or offense name. Do not apply the demographic-rate prohibition; generate SQL using total jurisdiction population.]",
        }]
      : basePromptHistory;
    const resolutionGuidance = formatNibrsResolutionGuidance(resolutionPlan);
    const promptHistory = resolutionGuidance
      ? [...demographicPromptHistory, { role: "user" as const, content: resolutionGuidance }]
      : demographicPromptHistory;
    const claudeStart = Date.now();

    // Check response cache (only standalone questions). Continuous-reporter
    // requests are contract-sensitive and must not reuse stale broad-summary SQL.
    const cacheableStandalone = basePromptHistory.length === 0 && !asksContinuousReportingFilter(question);
    // Stage 2b (plan §6): the cache namespace changed, so no statement cached before request accounting can be served.
    const cached = cacheableStandalone ? getCached(question, NIBRS_CACHE_TAB, cacheValidity) : null;
    /** Stage 2b gate (L11): the first point a model or cached statement exists. It never runs; the request is declined. */
    const nibrsModelSqlGate = (fromCache: boolean) => {
      const gateMs = Date.now() - routeStart;
      const gateTags = ["request-accounting", "request-accounting-owner:model-sql", ...(fromCache ? ["request-accounting:cached-statement"] : [])];
      const gateProof = finalizeExit({ outcome: OUTCOMES.capability_path_unavailable, planFamily: "request-accounting", guardrails: gateTags, narrative: NIBRS_MODEL_SQL_DECLINE });
      writeNibrsLog(question, null, 0, null, gateMs, NIBRS_MODEL_SQL_DECLINE, gateTags, activeModelLabel, sessionId, null, null, gateProof);
      return jsonResp(emitFactualPayload(gateProof, {
        success: true, question, sql: null as unknown as string, explanation: NIBRS_MODEL_SQL_DECLINE, title: "Not answered",
        columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: gateMs,
      } as QueryResponse));
    };

    let geoCorrectionApplied = false;
    // Captured before the server template overwrites claude.explanation, so a
    // no-SQL failure can be diagnosed from the log instead of by replaying it.
    let rawFirstNoSql: string | null = null;
    let rawRetryNoSql: string | null = null;
    let claude: Awaited<ReturnType<typeof translateToSql>>;

    if (cached) {
      claude = { sql: cached.sql, explanation: cached.explanation, title: cached.title || "", chartHint: (cached.chartType as "bar" | "line" | "pie" | "stacked_bar" | "scatter" | "none") || "none", xAxis: cached.xAxis || "", yAxis: cached.yAxis?.[0] || "", colors: cached.colors as string[] | undefined, yAxisLabel: cached.yAxisLabel, xAxisLabel: cached.xAxisLabel, annotations: cached.annotations as typeof claude.annotations };
      // Gate G1 (plan §6): a cached statement is a model statement; it never runs, before any validation.
      if (NIBRS_MODEL_SQL_NEVER_RUNS && claude.sql) return nibrsModelSqlGate(true);
    } else {
      console.log(`[nibrs][model=${activeModelLabel}] Processing: ${question.slice(0, 100)}`);
      const correctionHint = geoCorrectionHint(question);
      geoCorrectionApplied = Boolean(correctionHint);
      claude = await translateToSql(applyGeoCorrection(question, correctionHint), promptHistory, activeModel);
      const claudeMs = Date.now() - claudeStart;
      console.log(`[nibrs][timing] Claude API: ${claudeMs}ms`);
      // Gate G2 (plan §6): the first model statement never runs -- before any validation, schema check, prepare or retry.
      if (NIBRS_MODEL_SQL_NEVER_RUNS && claude.sql) return nibrsModelSqlGate(false);

      // Stage 2b (plan §6): no retry asks the model for SQL on NIBRS -- a text reply is the first answer.
      if (!claude.sql) rawFirstNoSql = claude.explanation || null;
      if (!claude.sql && !NIBRS_MODEL_SQL_NEVER_RUNS) {
        rawFirstNoSql = claude.explanation || null;
        // Cause A: a court-process request is settled by the REQUEST policy, not by whatever the
        // model wrote. No second call can turn a police record into a court record, and on GC-009
        // the second call answered with arrestees instead of defendants. Terminate here and let the
        // terminal exit below deliver the policy explanation.
        const courtProcessTerminal = courtProcessNoSqlIsTerminal(question);
        // Retry if model incorrectly claims data isn't available
        const refusalPatterns = /not (appear|be represented)|doesn't appear|not (in|included in) (this|the|our) (dataset|data|sample|library)|no data (for|available|found)|does not (have|include|cover)|not available in this|isn't (in|included)|not found in/i;
        // Retry if model asks for year range instead of defaulting
        const yearAskPattern = /\b(time (range|period)|year range|which year|what year|how many year|specify.*year|interested in)\b/i;
        const falseDemographicRefusal = hasDemographicPlaceDisambiguation &&
          /population.*(?:race|ethnicity|sex|age)|group-specific per-capita|demographic group/i.test(claude.explanation || "");
        const coverageRetryPrompt = partialCoverageRetryPrompt("nibrs", question, claude.explanation);
        const retryPrompt = courtProcessTerminal
          ? null
          : falseDemographicRefusal
          ? "[SYSTEM: Incorrect refusal. The query contract confirms this is an overall rate for a resolved place and offense, not a demographic-group rate. Generate the SQL now using total jurisdiction population.]"
          : coverageRetryPrompt
          ? coverageRetryPrompt
          : refusalPatterns.test(claude.explanation || "")
          ? "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. NEVER assume an agency is missing. Always generate a SQL query and let the database answer. Try the query now.]"
          : yearAskPattern.test(claude.explanation || "")
          ? (() => {
              const range = pastCompleteCalendarYearsRange(5);
              return `[SYSTEM: The user did not specify a year range. NIBRS policy is to default to the last 5 complete calendar years, not ask for clarification. Generate SQL using year BETWEEN ${range.start} AND ${range.end}. Do not ask which years — just run the query.]`;
            })()
          // Nothing above explains the missing SQL. If the request is
          // demonstrably answerable, spend one more call before giving up —
          // production 8375 was a one-off that replayed correctly first try.
          : shouldRetryUnexplainedNoSql(promptContract, resolutionPlan)
          ? UNEXPLAINED_NO_SQL_RETRY_PROMPT
          : null;
        if (retryPrompt) {
          retryCount++;
          try {
            const retryResult = await translateToSql(question, [
              ...(promptHistory || []),
              { role: "assistant", content: claude.explanation },
              { role: "user", content: retryPrompt },
            ], activeModel);
            if (retryResult.sql) {
              Object.assign(claude, retryResult);
            } else {
              rawRetryNoSql = retryResult.explanation || null;
            }
          } catch { /* use original */ }
        }
      }

      // Stage 2b: this retry may return SQL, so it does not run on NIBRS; the scaffold text is stripped just below instead.
      if (!NIBRS_MODEL_SQL_NEVER_RUNS && (containsInternalScaffold(claude.explanation) || containsInternalScaffold(claude.title))) {
        scaffoldStripped = true;
        retryCount++;
        console.log(`[nibrs][internal-scaffold] Retrying response that leaked internal scaffold text`);
        try {
          const retryResult = await translateToSql(question, [
            ...(promptHistory || []),
            { role: "assistant", content: JSON.stringify(claude) },
            { role: "user", content: "[SYSTEM: Your previous response leaked internal scaffold text such as 'Entities in results'. Remove all internal instructions from explanation/title and return corrected JSON only.]" },
          ], activeModel);
          if (retryResult.sql && !containsInternalScaffold(retryResult.explanation) && !containsInternalScaffold(retryResult.title)) {
            Object.assign(claude, retryResult);
          }
        } catch { /* use sanitized original */ }
      }

      // Sanitize explanation to strip any JSON/SQL that leaked through
      claude.explanation = sanitizeExplanation(claude.explanation);
      if (containsInternalScaffold(claude.explanation)) {
        scaffoldStripped = true;
        claude.explanation = stripInternalScaffold(claude.explanation) || "Here are the results.";
      }
      if (containsInternalScaffold(claude.title)) {
        scaffoldStripped = true;
        claude.title = "Results";
      }

      if (!claude.sql) {
        const serverAuthoredNoSql = false;
        const internalLeak = containsInternalLeak(claude.explanation) || containsInternalLeak(claude.title);
        if (internalLeak) { claude.explanation = INTERNAL_LEAK_SAFE_MESSAGE; claude.title = "Results"; }
        // Decision 1: same terminal-exit defect as the Current/Historical route - this returns
        // before `runGuardrails`, so the court-process explanation is selected here instead.
        const noSqlRefusal = selectNoSqlRefusal(question, "nibrs");
        if (!serverAuthoredNoSql && !internalLeak) claude.explanation = noSqlRefusal.explanation;
        // The recorded reason names the branch actually taken, not the generic template.
        const noSqlReason = internalLeak ? "internal-leak-firewall" : (serverAuthoredNoSql ? "no-sql-server-template" : noSqlRefusal.reason);
        claude.explanation = neutralizeUnverifiedAvailabilityClaim(claude.explanation, "NIBRS");
        const noSqlProof = finalizeExit({ outcome: OUTCOMES.model_produced_no_sql, guardrails: [noSqlReason], narrative: claude.explanation });
        writeNibrsLog(question, null, 0, null, Date.now() - claudeStart, claude.explanation, [noSqlReason], activeModelLabel, sessionId, null, boundedModelResponseJson(rawFirstNoSql, rawRetryNoSql), noSqlProof);
        return jsonResp(emitFactualPayload(noSqlProof, {
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
        } as QueryResponse));
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
    const resolvedOriWarnings = auditNibrsResolvedOriUsage(resolutionPlan, sql);
    // Enforced for the city-name bypass; other shapes stay warn-only unless the omitted-member rule
    // below promotes one of them.
    const oriEnforcement = resolvedOriEnforcementIssue(resolutionPlan, sql);
    // A second, narrower enforcement over the SAME detection. `auditNibrsResolvedOriUsage` already
    // finds every resolved member missing from the SQL -- it has no city_police filter -- and that
    // finding was printed as "[warn-only]" whenever the city-name bypass could not reach it. Where
    // several agencies were named and only some are answered for, warn-only is not enough: the result
    // is not a visibly poor answer but a confident one about a subset, reported as the whole. So this
    // promotes an already-detected warning to enforcement rather than adding a new detection.
    const memberEnforcement = omittedMemberEnforcementIssue(resolutionPlan, sql);
    const oriFindingEnforced = Boolean(oriEnforcement || memberEnforcement);
    if (resolvedOriWarnings.length > 0) {
      console.warn(`[nibrs][resolved-ori]${oriFindingEnforced ? "[enforced]" : "[warn-only]"} ${resolvedOriWarnings.join("; ")}`);
      logResolverWarnings({
        source: "nibrs", question, sql, warnings: resolvedOriWarnings, sessionId,
      });
    }

    // Step 2a: Run shared guardrail pipeline
    const ctx = extractQueryContext(sql, guardrailQuestion, "nibrs");
    const guardrailResult = runGuardrails(ctx);

    // Apply auto-rewrites (e.g., NE→NB state codes, state→city table fixes)
    if (guardrailResult.sql !== sql) {
      sql = guardrailResult.sql;
    }

    if (guardrailResult.fired.length > 0) {
      console.log(`[nibrs][guardrails] Fired: ${guardrailResult.fired.join(", ")}`);
    }

    const routeGuardrailIssues: string[] = [];
    // The label must not contradict itself: the same finding cannot be reported as warn-only while it
    // is being enforced, which is what happened when the omitted-member rule fired on ORIs the
    // city-name rule could not reach.
    const routeGuardrailsFired: string[] = oriEnforcement
      ? ["nibrs-resolved-ori-enforced"]
      : resolvedOriWarnings.length > 0 && !memberEnforcement
      ? ["nibrs-resolved-ori-warn-only"]
      : [];
    if (oriEnforcement) routeGuardrailIssues.push(oriEnforcement.issue);
    if (memberEnforcement) {
      routeGuardrailsFired.push("nibrs-omitted-member-enforced");
      routeGuardrailIssues.push(memberEnforcement.issue);
    }
    if (geoCorrectionApplied) routeGuardrailsFired.push("geo-typo-corrected");
    const recordContractValidation = (contractResult: QueryContractSqlValidation, collectRetryIssues = false) => {
      const contractGuardrails = queryContractGuardrails(contractResult);
      if (contractGuardrails.length > 0) {
        for (const fired of contractGuardrails) {
          if (!routeGuardrailsFired.includes(fired)) routeGuardrailsFired.push(fired);
        }
      }
      if (contractResult.warnings.length > 0) {
        console.log(`[nibrs][contract] Warnings: ${contractResult.warnings.join(", ")}`);
      }
      if (collectRetryIssues) {
        for (const issue of contractResult.retryIssues) {
          if (!routeGuardrailIssues.includes(issue)) routeGuardrailIssues.push(issue);
        }
      }
    };
    const runContractValidation = (inputSql: string, collectRetryIssues = false): QueryContractSqlValidation => {
      const contractResult = validateQueryContractSql({
        question: guardrailQuestion,
        source: "nibrs",
        sql: inputSql,
        routingMeta,
        history: normalizeHistoryForTab(body?.history, "nibrs"),
      });
      recordContractValidation(contractResult, collectRetryIssues);
      return contractResult;
    };
    const applyContractValidation = (inputSql: string, collectRetryIssues = false): string => {
      return runContractValidation(inputSql, collectRetryIssues).sql;
    };
    const contractFailureResponse = (contractResult: QueryContractSqlValidation, logError: string) => {
      const msg = queryContractFailureMessage(contractResult);
      if (!msg) return null;
      const contractProof = finalizeExit({ outcome: capabilityFinalizationOutcome(contractResult), sql: contractResult.sql, guardrails: [...guardrailResult.fired, ...routeGuardrailsFired] });
      writeNibrsLog(question, contractResult.sql, 0, logError, Date.now() - claudeStart, msg, [...guardrailResult.fired, ...routeGuardrailsFired], activeModelLabel, sessionId, null, null, contractProof);
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
        executionTimeMs: Date.now() - claudeStart,
      } as QueryResponse));
    };

    const initialContractResult = runContractValidation(sql, true);
    sql = initialContractResult.sql;
    const initialContractBlock = initialContractResult.blockReasons.length > 0
      ? contractFailureResponse(initialContractResult, `contract_block:${initialContractResult.enforced.join(",")}`)
      : null;
    if (initialContractBlock) return initialContractBlock;

    const continuousReporterIssue = continuousReporterRouteIssue(sql, question);
    if (continuousReporterIssue) {
      routeGuardrailIssues.push(continuousReporterIssue);
      routeGuardrailsFired.push("nibrs-continuous-reporting-required-route");
      console.log("[nibrs][route-guardrails] Fired: nibrs-continuous-reporting-required-route");
    }

    const localSqlGuardrails = findNibrsSqlIssues(sql);
    if (localSqlGuardrails.fired.length > 0) {
      console.log(`[nibrs][sql-guardrails] Fired: ${localSqlGuardrails.fired.join(", ")}`);
    }

    // Hard override — skip retry, return deterministic response
    if (guardrailResult.overrideResponse) {
      const overrideExplanation = guardrailResult.overrideResponse;
      const overrideProof = finalizeExit({ outcome: OUTCOMES.guardrail_block, sql, guardrails: guardrailResult.fired, planFamily: guardrailResult.overrideGuardrail ?? null, narrative: overrideExplanation });
      writeNibrsLog(question, sql, 0, `guardrail_override:${guardrailResult.overrideGuardrail}`, Date.now() - claudeStart, overrideExplanation, guardrailResult.fired, activeModelLabel, sessionId, null, null, overrideProof);
      return jsonResp(emitFactualPayload(overrideProof, {
        success: true,
        question,
        sql: null as unknown as string,
        explanation: overrideExplanation,
        title: "",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        chartConfig: null,
        chartMeta: null,
        executionTimeMs: Date.now() - claudeStart,
      } as QueryResponse));
    }

    // For NIBRS guardrails that need Claude retry, send all issues at once
    // so a single retry fixes everything (avoids cascading retries)
    const combinedGuardrailIssues = [...guardrailResult.issues, ...routeGuardrailIssues, ...localSqlGuardrails.issues];
    if (combinedGuardrailIssues.length > 0) {
      const combinedIssues = combinedGuardrailIssues.join("\n\n");
      console.log(`[nibrs][guardrail-retry] Retrying with ${combinedGuardrailIssues.length} issue(s)`);
      retryCount++;
      // Stage 2b (L11, defensive): unreachable while the gate stands; fails closed if the gate is ever removed.
      if (NIBRS_MODEL_SQL_NEVER_RUNS) throw new Error("request accounting: a NIBRS model statement may not be retried (2b L11)");
      const retryResult = await translateToSql(
        question + "\n\n" + combinedIssues,
        promptHistory,
        activeModel
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

    // Step 2b: Post-retry guardrail re-check — block if critical guardrails still fire
    {
      const postRetryCtx = extractQueryContext(sql, guardrailQuestion, "nibrs");
      const postRetryResult = runGuardrails(postRetryCtx);
      // Hard override on second failure
      if (postRetryResult.overrideResponse) {
        const msg = postRetryResult.overrideResponse;
        const postRetryOverrideProof = finalizeExit({ outcome: OUTCOMES.guardrail_block, sql, guardrails: postRetryResult.fired, planFamily: postRetryResult.overrideGuardrail ?? null, narrative: msg });
        writeNibrsLog(question, sql, 0, `guardrail_override:${postRetryResult.overrideGuardrail}`, Date.now() - claudeStart, msg, postRetryResult.fired, activeModelLabel, sessionId, null, null, postRetryOverrideProof);
        return jsonResp(emitFactualPayload(postRetryOverrideProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
      }
      // Rate second-failure block
      const rateStillBad = postRetryResult.fired.some(f => f.includes("rate-no-population"));
      if (rateStillBad && /\b(rates?|per\s*capita|per\s*100)/i.test(question) && !asksForCountsInsteadOfRates(question)) {
        const msg = "I wasn't able to calculate a valid per-capita rate for this query. Try asking for raw counts instead, or use the [Historical Library](/test?tab=historical) tab for state/national rates.";
        const rateFailureProof = finalizeExit({ outcome: OUTCOMES.rate_denominator_unavailable, sql, guardrails: postRetryResult.fired, planFamily: "rate-no-population", narrative: msg });
        writeNibrsLog(question, sql, 0, "rate_second_failure", Date.now() - claudeStart, msg, postRetryResult.fired, activeModelLabel, sessionId, null, null, rateFailureProof);
        return jsonResp(emitFactualPayload(rateFailureProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
      }
      // Raw table second-failure block — if retry still uses raw tables, block execution
      const rawStillBad = postRetryResult.fired.some(f => f === "nibrs-raw-table-for-counts" || f === "nibrs-raw-victims");
      if (rawStillBad) {
        const msg = "I wasn't able to build a valid query for this question using the available summary tables. The data needed may not be available in a pre-aggregated form. Try rephrasing your question or asking about a specific offense type, city, or time period.";
        const rawTableProof = finalizeExit({ outcome: OUTCOMES.sql_shape_rejected, sql, guardrails: postRetryResult.fired, planFamily: "raw-table", narrative: msg });
        writeNibrsLog(question, sql, 0, "raw_table_second_failure", Date.now() - claudeStart, msg, postRetryResult.fired, activeModelLabel, sessionId, null, null, rawTableProof);
        return jsonResp(emitFactualPayload(rawTableProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
      }
      // Resolved-ORI second-failure block — the retried SQL still selects by city
      // name. Running it would return the broadened, wrong-agency result silently.
      // Omitted-member second failure: the retry still answers for a subset of the agencies the
      // question named. Delivering it would report one agency's figures as all of them, so stop and
      // say which agencies were asked for -- a named refusal, not a silent narrowing.
      const memberStillBad = omittedMemberEnforcementIssue(resolutionPlan, sql);
      if (memberStillBad) {
        const msg = `That question asks about ${memberStillBad.requested} agencies, but I could only build a query covering ${memberStillBad.covered} of them — ${memberStillBad.labels.join(", ")} would have been left out. Rather than report a partial figure as though it covered every agency you named, I stopped. Ask for them one at a time and I can answer each.`;
        const omittedMemberProof = finalizeExit({ outcome: OUTCOMES.geography_contract_violation, sql, guardrails: [...postRetryResult.fired, "nibrs-omitted-member-enforced"], planFamily: "omitted-member", narrative: msg });
        writeNibrsLog(question, sql, 0, "omitted_member_second_failure", Date.now() - claudeStart, msg, [...postRetryResult.fired, "nibrs-omitted-member-enforced"], activeModelLabel, sessionId, null, null, omittedMemberProof);
        return jsonResp(emitFactualPayload(omittedMemberProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
      }
      const oriStillBad = resolvedOriEnforcementIssue(resolutionPlan, sql);
      if (oriStillBad) {
        const msg = `I matched ${oriStillBad.labels.join(", ")} to specific law-enforcement agencies, but I couldn't build a query that uses them. Rather than fall back to matching agencies by city name — which mixes in unrelated departments that share a mailing city — I stopped. Try asking for fewer cities at once, or one city at a time.`;
        const resolvedOriProof = finalizeExit({ outcome: OUTCOMES.sql_shape_rejected, sql, guardrails: [...postRetryResult.fired, "nibrs-resolved-ori-enforced"], planFamily: "resolved-ori", narrative: msg });
        writeNibrsLog(question, sql, 0, "resolved_ori_second_failure", Date.now() - claudeStart, msg, [...postRetryResult.fired, "nibrs-resolved-ori-enforced"], activeModelLabel, sessionId, null, null, resolvedOriProof);
        return jsonResp(emitFactualPayload(resolvedOriProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
      }
      const orPrecedenceStillBad = postRetryResult.fired.includes("or-and-precedence");
      if (orPrecedenceStillBad) {
        const msg = "I couldn't build a reliable multi-place query after correcting the SQL structure. Try asking for fewer places or restating the comparison.";
        const orPrecedenceProof = finalizeExit({ outcome: OUTCOMES.sql_shape_rejected, sql, guardrails: postRetryResult.fired, planFamily: "or-and-precedence", narrative: msg });
        writeNibrsLog(question, sql, 0, "or_precedence_second_failure", Date.now() - claudeStart, msg, postRetryResult.fired, activeModelLabel, sessionId, null, null, orPrecedenceProof);
        return jsonResp(emitFactualPayload(orPrecedenceProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
      }
      // Geography contract block — city/county-got-state still fires after retry
      const geoContractBad = postRetryResult.fired.some(f =>
        f === "nibrs-city-got-state" || f === "contract-geography-missing"
      );
      if (geoContractBad) {
        const msg = "I couldn't build a reliable query for that specific geography. Try asking for a specific city or state instead.";
        const geographyFailureProof = finalizeExit({ outcome: OUTCOMES.geography_contract_violation, sql, guardrails: postRetryResult.fired, planFamily: "contract-geography", narrative: msg });
        writeNibrsLog(question, sql, 0, "geography_second_failure", Date.now() - claudeStart, msg, postRetryResult.fired, activeModelLabel, sessionId, null, null, geographyFailureProof);
        return jsonResp(emitFactualPayload(geographyFailureProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
      }
      if (continuousReporterRouteIssue(sql, question)) {
        const msg = "I couldn't build a reliable continuous-reporter query for that request. Try asking for the same offense and year range without the continuous-reporting filter, or narrow it to a specific city or state.";
        const continuousReporterProof = finalizeExit({ outcome: OUTCOMES.continuous_reporting_required, sql, guardrails: [...postRetryResult.fired, "nibrs-continuous-reporting-required-route"], planFamily: "continuous-reporting", narrative: msg });
        writeNibrsLog(question, sql, 0, "continuous_reporter_second_failure", Date.now() - claudeStart, msg, [...postRetryResult.fired, "nibrs-continuous-reporting-required-route"], activeModelLabel, sessionId, null, null, continuousReporterProof);
        return jsonResp(emitFactualPayload(continuousReporterProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
      }
      // Apply any post-retry rewrites
      if (postRetryResult.sql !== sql) sql = postRetryResult.sql;

      const postRetryLocalIssues = findNibrsSqlIssues(sql);
      if (postRetryLocalIssues.issues.length > 0) {
        const msg = "I couldn't build a valid query after correcting the SQL structure. Try rephrasing your question or asking for a simpler breakdown.";
        console.log(`[nibrs][sql-guardrails] Still failing after retry: ${postRetryLocalIssues.fired.join(", ")}`);
        const sqlGuardrailProof = finalizeExit({ outcome: OUTCOMES.sql_shape_rejected, sql, guardrails: [...postRetryResult.fired, ...postRetryLocalIssues.fired], planFamily: "sql-guardrail", narrative: msg });
        writeNibrsLog(question, sql, 0, `sql_guardrail_second_failure:${postRetryLocalIssues.fired.join(",")}`, Date.now() - claudeStart, msg, [...postRetryResult.fired, ...postRetryLocalIssues.fired], activeModelLabel, sessionId, null, null, sqlGuardrailProof);
        return jsonResp(emitFactualPayload(sqlGuardrailProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
      }

      const postRetryContract = runContractValidation(sql);
      sql = postRetryContract.sql;
      const contractSecondFailure = contractFailureResponse(postRetryContract, `contract_second_failure:${postRetryContract.enforced.join(",")}`);
      if (contractSecondFailure) return contractSecondFailure;
    }

    const preTableContract = runContractValidation(sql);
    sql = preTableContract.sql;
    const preTableContractFailure = contractFailureResponse(preTableContract, `contract_final_failure:${preTableContract.enforced.join(",")}`);
    if (preTableContractFailure) return preTableContractFailure;

    {
      const tableCheck = validateTablesForTab(sql, "nibrs", getNibrsDb());
      if (!tableCheck.ok) {
        console.log(`[nibrs][table-allowlist] Unknown table(s): ${tableCheck.unknown.join(", ")}`);
        retryCount++;
        const retryHistory = [
          ...(promptHistory || []),
          { role: "user" as const, content: question },
          { role: "assistant" as const, content: JSON.stringify({ ...claude, sql }) },
          { role: "user" as const, content: `[SYSTEM: ${tableCheck.message}]` },
        ];
        // Stage 2b (L11, defensive): unreachable while the gate stands; fails closed if the gate is ever removed.
        if (NIBRS_MODEL_SQL_NEVER_RUNS) throw new Error("request accounting: a NIBRS model statement may not be retried (2b L11)");
        const retry = await translateToSql(tableCheck.message, retryHistory, activeModel);
        if (retry.sql) {
          const retryValidation = validateAndSanitize(retry.sql);
          if (retryValidation.valid) {
            let retrySql = applyContractValidation(retryValidation.sanitized!);
            const retryTableCheck = validateTablesForTab(retrySql, "nibrs", getNibrsDb());
            if (retryTableCheck.ok) {
              sql = retrySql;
              applyRetryMeta(claude, retry);
            } else {
              const msg = "I couldn't build a valid query for the NIBRS database. Try the Historical or Current Trends tab for broad state-level crime totals, or rephrase for NIBRS incident-level details.";
              const retryAllowlistProof = finalizeExit({ outcome: OUTCOMES.table_not_allowlisted, sql: retrySql, guardrails: [...guardrailResult.fired, ...tableCheck.fired, ...retryTableCheck.fired], planFamily: "table-allowlist", retries: 1, narrative: msg });
              writeNibrsLog(question, retrySql, 0, `table_allowlist_second_failure:${retryTableCheck.unknown.join(",")}`, Date.now() - claudeStart, msg, [...guardrailResult.fired, ...tableCheck.fired, ...retryTableCheck.fired], activeModelLabel, sessionId, null, null, retryAllowlistProof);
              return jsonResp(emitFactualPayload(retryAllowlistProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
            }
          }
        }

        const msg = "I couldn't build a valid query for the NIBRS database. Try the Historical or Current Trends tab for broad state-level crime totals, or rephrase for NIBRS incident-level details.";
        const allowlistProof = finalizeExit({ outcome: OUTCOMES.table_not_allowlisted, sql, guardrails: [...guardrailResult.fired, ...tableCheck.fired], planFamily: "table-allowlist", narrative: msg });
        writeNibrsLog(question, sql, 0, `table_allowlist:${tableCheck.unknown.join(",")}`, Date.now() - claudeStart, msg, [...guardrailResult.fired, ...tableCheck.fired], activeModelLabel, sessionId, null, null, allowlistProof);
        return jsonResp(emitFactualPayload(allowlistProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
      }
    }

    let campusAgencyScopeNote: string | null = null;

    const knownCampusResolution = knownCampusAgencyResolution(question);
    if (knownCampusResolution || shouldResolveCampusAgencySql(question, sql)) {
      try {
        const resolution = knownCampusResolution || resolveCampusAgencyOris(getNibrsDb(), question);
        if (resolution && resolution.oris.length > 0) {
          const campusChartAxes = campusAgencyChartAxesFromSql(sql, question);
          sql = buildCampusAgencySummarySql(resolution.oris, question, sql);
          if (campusChartAxes) {
            claude.chartHint = "line";
            claude.xAxis = campusChartAxes.xAxis;
            claude.yAxis = campusChartAxes.yAxis;
          }
          routeGuardrailsFired.push("nibrs-campus-agency-ori-resolve");
          const resolvedLabel = resolution.rows
            .map((row) => `${campusAgencyDisplayName(row)} (${row.ori})`)
            .join(", ");
          campusAgencyScopeNote = `Results use the FBI NIBRS campus-agency record for ${resolvedLabel}, rather than the surrounding city police department.`;
        }
      } catch (campusErr) {
        console.log("[nibrs][campus-agency-resolve] Error:", campusErr);
      }
    }

    // Step 3: Execute SQL in a killable worker process. Apply conservative
    // index hints after validation so agency-scoped summary queries do not use
    // an offense-first plan against the large NIBRS database.
    const startTime = Date.now();

    let rows: Record<string, unknown>[] = undefined!;
    let columns: string[] = undefined!;

    try {
      const executionContract = runContractValidation(sql);
      sql = executionContract.sql;
      const executionContractFailure = contractFailureResponse(executionContract, `contract_execution_failure:${executionContract.enforced.join(",")}`);
      if (executionContractFailure) return executionContractFailure;
      const validationDb = getNibrsDb();
      const rollupContext = nibrsRollupContextForDb(validationDb);
      const plannedSql = optimizeNibrsSql(sql, rollupContext?.available ?? false);
      if (plannedSql !== sql) {
        sql = plannedSql;
        routeGuardrailsFired.push("nibrs-query-plan");
        console.log(`[nibrs][query-plan] Applied safe index/rollup plan`);
      }
      const rollupRequired = routeNibrsRollupSql(sql, true).routed;
      if (rollupRequired && !rollupContext?.available) {
        throw new Error("NIBRS rollup is unavailable");
      }
      const schemaCheck = validateSqlSchema(validationDb, sql);
      if (!schemaCheck.ok) {
        routeGuardrailsFired.push("schema-column-invalid");
        throw new Error("Schema validation failed: " + schemaCheck.error);
      }
      if (schemaCheck.corrected) {
        sql = schemaCheck.sql;
        routeGuardrailsFired.push("schema-column-corrected");
      }
      // P4.1: the final checks run on the statement that will execute (after planning and schema
      // correction), and only that statement -- bound by identity -- reaches the worker.
      const finalCheck = finalizeNibrsStatement({
        sql, path: "model-initial",
        schema: (candidate) => validateSqlSchema(validationDb, candidate),
        contract: (candidate) => runContractValidation(candidate),
      });
      if (!finalCheck.ok) {
        routeGuardrailsFired.push("nibrs-final-statement-refused");
        if (finalCheck.stage === "contract" && finalCheck.contract) {
          const finalContractFailure = contractFailureResponse(finalCheck.contract, `contract_final_statement_failure:${finalCheck.contract.enforced.join(",")}`);
          if (finalContractFailure) return finalContractFailure;
        }
        throw new Error(`Final statement check failed (${finalCheck.stage}): ${finalCheck.reason}`);
      }
      sql = finalCheck.authority.sql;
      // Stage 2b (L11, defensive): unreachable while the gate stands; fails closed if the gate is ever removed.
      if (NIBRS_MODEL_SQL_NEVER_RUNS) throw new Error("request accounting: a NIBRS model statement may not be executed (2b L11)");
      const result = await executeBoundNibrsStatement(finalCheck.authority);
      rows = result.rows;
      columns = result.columns;
      rows = normalizeNibrsDisplayRows(rows);
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      const isTimeout = msg.includes("timed out");

      // Do not retry identical timed-out SQL. The old behavior guaranteed at
      // least 30 seconds of extra latency and depended on the first scan warming
      // the OS page cache. Rewrite to a safer summary-table plan instead.
      if (!rows!) {
        console.log(`[nibrs][error-recovery] DB error: ${msg}, retrying with Claude`);

        // For timeouts, ask Claude to use a summary table instead
        const errorInstruction = isTimeout
          ? `That SQL timed out after 30 seconds. The query is too slow — you MUST rewrite it to use a summary table (summary_state_monthly, summary_city_monthly, summary_victim_state_monthly, summary_victim_city_monthly, summary_victim_demographics, summary_offender_demographics, summary_arrestee_demographics, summary_property_offense, summary_drug_monthly, summary_carjacking_monthly, or summary_flash_mob_monthly). If no summary table fits, use a narrower WHERE clause.`
          : `That SQL failed with error: ${msg}. Please fix the query and try again.`;

        const retryHistory = [
          ...(promptHistory || []),
          { role: "user" as const, content: question },
          { role: "assistant" as const, content: JSON.stringify(claude) },
          { role: "user" as const, content: errorInstruction },
        ];
        retryCount++;
        // Stage 2b (L11, defensive): unreachable while the gate stands; fails closed if the gate is ever removed.
        if (NIBRS_MODEL_SQL_NEVER_RUNS) throw new Error("request accounting: a NIBRS model statement may not be retried (2b L11)");
        const retry = await translateToSql(
          isTimeout ? `Rewrite using summary tables: ${question}` : `Fix this SQL error: ${msg}`,
          retryHistory,
          activeModel
        );
        if (retry.sql) {
          const retryValidation = validateAndSanitize(retry.sql);
          if (retryValidation.valid) {
            const retryContract = runContractValidation(retryValidation.sanitized!);
            const retryValidationDb = getNibrsDb();
            const retryRollupContext = nibrsRollupContextForDb(retryValidationDb);
            let retrySql = optimizeNibrsSql(retryContract.sql, retryRollupContext?.available ?? false);
            const retryContractFailure = contractFailureResponse(retryContract, `contract_db_retry_failure:${retryContract.enforced.join(",")}`);
            if (retryContractFailure) return retryContractFailure;
            try {
              const retryRollupRequired = routeNibrsRollupSql(retryContract.sql, true).routed;
              if (retryRollupRequired && !retryRollupContext?.available) {
                throw new Error("NIBRS rollup is unavailable");
              }
              const retrySchemaCheck = validateSqlSchema(retryValidationDb, retrySql);
              if (!retrySchemaCheck.ok) {
                  routeGuardrailsFired.push("schema-column-invalid");
                  throw new Error("Schema validation failed: " + retrySchemaCheck.error);
                }
              if (retrySchemaCheck.corrected) {
                retrySql = retrySchemaCheck.sql;
                routeGuardrailsFired.push("schema-column-corrected");
              }
              // P4.1: the same final-statement binding as the initial path.
              const retryFinalCheck = finalizeNibrsStatement({
                sql: retrySql, path: "model-retry",
                schema: (candidate) => validateSqlSchema(retryValidationDb, candidate),
                contract: (candidate) => runContractValidation(candidate),
              });
              if (!retryFinalCheck.ok) {
                routeGuardrailsFired.push("nibrs-final-statement-refused");
                if (retryFinalCheck.stage === "contract" && retryFinalCheck.contract) {
                  const retryFinalContractFailure = contractFailureResponse(retryFinalCheck.contract, `contract_final_statement_retry_failure:${retryFinalCheck.contract.enforced.join(",")}`);
                  if (retryFinalContractFailure) return retryFinalContractFailure;
                }
                throw new Error(`Final statement check failed (${retryFinalCheck.stage}): ${retryFinalCheck.reason}`);
              }
              retrySql = retryFinalCheck.authority.sql;
              if (routeNibrsRollupSql(retrySql, true).routed && !retryRollupContext?.available) {
                throw new Error("NIBRS rollup is unavailable");
              }
              // Stage 2b (L11, defensive): unreachable while the gate stands; fails closed if the gate is ever removed.
              if (NIBRS_MODEL_SQL_NEVER_RUNS) throw new Error("request accounting: a NIBRS model statement may not be executed (2b L11)");
              const retryResult = await executeBoundNibrsStatement(retryFinalCheck.authority);
              rows = retryResult.rows;
              columns = retryResult.columns;
              rows = normalizeNibrsDisplayRows(rows);
              sql = retrySql;
              applyRetryMeta(claude, retry);
              console.log(`[nibrs][error-recovery] Retry succeeded`);
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              const dbRetryProof = OPERATIONAL_RECORD;
              writeNibrsLog(question, sql, 0, `DB retry failed: ${retryMsg}`, Date.now() - claudeStart, null, [...guardrailResult.fired, ...routeGuardrailsFired], activeModelLabel, sessionId, null, null, dbRetryProof);
              const retryFailed = decideDatabaseFailure({ stage: "retry_failed", sql, originalMessage: msg });
              return jsonResp({ success: false, error: retryFailed.outcome === "stop" ? retryFailed.error : "", sql } as QueryError, 500);
            }
          } else {
            const dbRetryValidationProof = OPERATIONAL_RECORD;
            writeNibrsLog(question, sql, 0, `DB: ${msg} (retry validation failed)`, Date.now() - claudeStart, null, [...guardrailResult.fired, ...routeGuardrailsFired], activeModelLabel, sessionId, null, null, dbRetryValidationProof);
            const validationFailed = decideDatabaseFailure({ stage: "retry_validation_failed", sql, originalMessage: msg });
            return jsonResp({ success: false, error: validationFailed.outcome === "stop" ? validationFailed.error : "", sql } as QueryError, 500);
          }
        } else {
          const dbErrorProof = OPERATIONAL_RECORD;
          writeNibrsLog(question, sql, 0, `DB: ${msg}`, Date.now() - claudeStart, null, [...guardrailResult.fired, ...routeGuardrailsFired], activeModelLabel, sessionId, null, null, dbErrorProof);
          const dbFailed = decideDatabaseFailure({ stage: "no_retry", sql, originalMessage: msg });
          return jsonResp({ success: false, error: dbFailed.outcome === "stop" ? dbFailed.error : "", sql } as QueryError, 500);
        }
      }
    }

    const executionTimeMs = Date.now() - startTime;

    // Campus agencies can have zero population and non-city naming conventions
    // such as "UN OF CA: BERKELEY". If the model's campus lookup returns no
    // rows, resolve the campus ORI from agencies.city and rerun a safe ORI query.
    if (rows.length === 0 && asksCampusAgency(question)) {
      try {
        const resolution = resolveCampusAgencyOris(getNibrsDb(), question);
        if (resolution && resolution.oris.length > 0) {
          const campusChartAxes = campusAgencyChartAxesFromSql(sql, question);
          const fallbackContract = runContractValidation(buildCampusAgencySummarySql(resolution.oris, question, sql));
          const fallbackSql = fallbackContract.sql;
          const fallbackContractFailure = contractFailureResponse(fallbackContract, `contract_campus_rescue_failure:${fallbackContract.enforced.join(",")}`);
          if (fallbackContractFailure) return fallbackContractFailure;
          // Stage 2b (L11, defensive): unreachable while the gate stands; fails closed if the gate is ever removed.
          if (NIBRS_MODEL_SQL_NEVER_RUNS) throw new Error("request accounting: a NIBRS model statement may not be executed (2b L11)");
          const fallbackResult = await executeWithTimeout(fallbackSql);
          if (fallbackResult.rows.length > 0) {
            sql = fallbackSql;
            rows = normalizeNibrsDisplayRows(fallbackResult.rows);
            columns = fallbackResult.columns;
            if (campusChartAxes) {
              claude.chartHint = "line";
              claude.xAxis = campusChartAxes.xAxis;
              claude.yAxis = campusChartAxes.yAxis;
            }
            routeGuardrailsFired.push("nibrs-campus-agency-zero-result-rescue");
            claude.title = claude.title || "Campus Agency NIBRS Offenses";
            claude.explanation = `This query resolves the campus agency ORI rather than using the surrounding city police department.`;
            const resolvedLabel = resolution.rows
              .map((row) => `${campusAgencyDisplayName(row)} (${row.ori})`)
              .join(", ");
            campusAgencyScopeNote = `Results use the FBI NIBRS campus-agency record for ${resolvedLabel}, rather than the surrounding city police department.`;
          }
        }
      } catch (campusErr) {
        console.log("[nibrs][campus-agency-rescue] Error:", campusErr);
      }
    }

    // Step 3b: Detect all-null data columns (query returned rows but no usable values)
    {
      const { allNull } = detectAllNullData(columns, rows);
      if (allNull) {
        const emptyMsg = "I ran that query but all the values came back empty — the math likely broke somewhere (like dividing by zero). Could you try asking that a different way?";
        const allNullProof = finalizeExit({ outcome: OUTCOMES.all_values_null, sql, guardrails: [...guardrailResult.fired, ...routeGuardrailsFired], narrative: emptyMsg });
        writeNibrsLog(question, sql, 0, "all_null_columns", Date.now() - claudeStart, emptyMsg, [...guardrailResult.fired, ...routeGuardrailsFired], activeModelLabel, sessionId, null, null, allNullProof);
        return jsonResp(emitFactualPayload(allNullProof, {
          success: true,
          question,
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
        } as QueryResponse));
      }
    }

    // Delivery gate for the bounded multi-agency family, placed here because this is where the rows
    // are final: after the model query, after any error-recovery retry, after any fallback and after
    // display normalization. Checking the ROWS rather than the SQL is what makes one gate cover every
    // execution path -- an identifier in query text can be removed by a HAVING, a LIMIT, an unused
    // CTE or plain omission, and none of those reach the answer.
    const deliveredMembers = agencyFigureFailure(resolutionPlan, columns, rows, null, sql);
    if (deliveredMembers) {
      const msg = memberRefusalText(deliveredMembers);
      const membershipProof = finalizeExit({ outcome: OUTCOMES.geography_contract_violation, sql, rows: [], columns: [], guardrails: [...routeGuardrailsFired, "nibrs-agency-figures-incomplete"], planFamily: "delivered-member", narrative: msg });
      writeNibrsLog(question, sql, 0, "delivered_member_incomplete", Date.now() - claudeStart, msg, [...routeGuardrailsFired, "nibrs-agency-figures-incomplete"], activeModelLabel, sessionId, null, null, membershipProof);
      return jsonResp(emitFactualPayload(membershipProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - claudeStart } as QueryResponse));
    }

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

    // Single-row trend warning
    const singleRowWarning = checkSingleRowTrend(question, rows.length);
    if (singleRowWarning) {
      explanation = (explanation || "") + "\n\n" + singleRowWarning;
    }

    // Step 4b: Generate post-query explanation (with actual results + CDE disclaimers)
    // Extract any CDE disclaimers that were appended after the original explanation
    const cdeDisclaimers = explanation.slice(claude.explanation.length).trim();
    const explainStart = Date.now();
    // Re-extract context from final SQL (may have been fixed by guardrails/retry)
    const finalCtx = extractQueryContext(sql, guardrailQuestion, "nibrs");
    const postExplanation = await generateExplanation({
      ctx: finalCtx,
      columns,
      rows,
      rowCount: rows.length,
      disclaimers: cdeDisclaimers,
      preQueryExplanation: explanation,
    });
    explanation = containsInternalScaffold(postExplanation)
      ? (stripInternalScaffold(postExplanation) || explanation)
      : postExplanation;
    explanation = applyResultDisclosures({ explanation, question, sql, rows, tab: "nibrs", resultState: genericResultState({ sql, rows }) });
    // A named agency that never resolved has no SQL fix -- there is nothing in the source to query,
    // so the answer must say which agency is missing rather than quietly narrowing to the ones that
    // worked. Computed here but deliberately NOT appended here: `validateGrain` below can replace the
    // whole explanation, which silently removed this note while the route went on recording the
    // disclosure tag. Delivered text and recorded account disagreeing is a corrupted measurement on
    // this project, not a cosmetic bug. It is appended at the end of the pipeline instead, and the
    // tag is recorded only if it survives into what is actually delivered.
    const missingMembers = unresolvedMemberDisclosure(resolutionPlan);
    const grainCheck = validateGrain(question, rows, sql);
    if (missingLowerBoundNote(question, sql, rows) && !routeGuardrailsFired.includes("lower-bound-disclosed")) routeGuardrailsFired.push("lower-bound-disclosed");
    if (!grainCheck.ok && grainCheck.message) {
      explanation = grainCheck.message;
      routeGuardrailsFired.push("grain-mismatch");
    }
    // Zero-result agency probe (query-audit-2026-07-03 F25): when an agency-scoped
    // query returns nothing, explain the agency's actual reporting span instead of
    // leaving a bare "no results" — e.g. Jackson PD reports NIBRS only since 2025.
    if (isZeroResult(rows, columns)) {
      try {
        const agencyProbe = runNibrsAgencyProbe(getNibrsDb(), sql);
        if (agencyProbe) {
          explanation = appendNibrsAgencyProbeCaveat(explanation, agencyProbe);
          routeGuardrailsFired.push("nibrs-agency-zero-probe");
        }
      } catch (probeErr) {
        console.log(`[nibrs][agency-probe] Error:`, probeErr);
      }
    }
    if (campusAgencyScopeNote && !explanation.includes(campusAgencyScopeNote)) {
      explanation += `\n\n${campusAgencyScopeNote}`;
    }
    if (containsInternalScaffold(postExplanation)) {
      console.log(`[nibrs][internal-scaffold] Stripped scaffold text from post-query explanation`);
    }
    // Re-append CDE disclaimers if the post-query explanation didn't include them
    if (cdeDisclaimers && !explanation.includes("transitioning") && !explanation.includes("underreporting") && !explanation.includes("incomplete")) {
      explanation += "\n\n" + cdeDisclaimers;
    }
    const explainMs = Date.now() - explainStart;
    console.log(`[nibrs][timing] Post-query explanation: ${explainMs}ms`);

    // Step 4c: Fix offender/arrestee demographics wording
    // summary_offender_demographics counts offenders, not crimes/incidents.
    // If the explanation says "share of crimes/offenses" but the SQL uses offender tables, fix it.
    if (/summary_offender_demographics/i.test(sql)) {
      explanation = explanation
        .replace(/\bshare of (?:crimes|offenses|incidents)\b/gi, "share of known/suspected offenders")
        .replace(/\bpercent(?:age)? of (?:crimes|offenses|incidents)\b/gi, "percentage of known/suspected offenders")
        .replace(/\bproportion of (?:crimes|offenses|incidents)\b/gi, "proportion of known/suspected offenders")
        .replace(/\b(?:crimes|offenses) involving\b/gi, "offenders who were");
    }
    if (/summary_arrestee_demographics/i.test(sql)) {
      explanation = explanation
        .replace(/\bshare of (?:crimes|offenses|incidents)\b/gi, "share of arrestees")
        .replace(/\bpercent(?:age)? of (?:crimes|offenses|incidents)\b/gi, "percentage of arrestees")
        .replace(/\bproportion of (?:crimes|offenses|incidents)\b/gi, "proportion of arrestees");
    }

    // Step 4c2: Drug-specific arrest mislabeling (safety net — guardrail should catch this first)
    // If SQL uses summary_arrestee_demographics with 35A/35B but user asked about a specific drug,
    // the guardrail should have redirected to summary_drug_arrests. If it didn't, fix the explanation.
    if (/summary_arrestee_demographics/i.test(sql) && /\b3[5][AB]\b/.test(sql) && !/summary_drug_arrests/i.test(sql)) {
      const specificDrug = question.match(/\b(marijuana|cannabis|weed|meth|methamphetamine|cocaine|crack|heroin|fentanyl|opioid|lsd|pcp|ecstasy|mdma)\b/i);
      if (specificDrug) {
        const drug = specificDrug[1];
        explanation = explanation.replace(
          new RegExp(`\\b${drug}\\b`, 'gi'),
          'drug'
        );
        explanation += `\n\nNote: These results show ALL drug ${/35A/.test(sql) ? 'possession' : 'sales'} arrests, not ${drug} specifically. Try asking "${drug} drug offenses" for drug-type-specific data.`;
      }
    }

    // Step 4d: Fix national vs cities wording mismatch
    // If SQL uses national-level tables (no city/ori filter), explanation should not say "across cities"
    if (/summary_(?:victim_)?state_monthly/i.test(sql) && !/\bori\b/i.test(sql) && !/\bcity\b/i.test(sql)) {
      explanation = explanation
        .replace(/\bacross cities\b/gi, "nationally")
        .replace(/\bfor cities\b/gi, "nationally")
        .replace(/\bin cities\b/gi, "nationally");
    }
    if (/\bnational_clearance_rate\b/i.test(sql) || /\bnational_/i.test(sql)) {
      explanation = explanation
        .replace(/\bacross cities\b/gi, "nationally")
        .replace(/\bfor cities\b/gi, "nationally")
        .replace(/\bin cities across\b/gi, "nationally across");
    }

    // Append standard NIBRS disclaimer — skip if explanation already has a coverage/completeness note
    const nibrsDisclaimer = "Note: This data comes from the FBI's NIBRS program. Not all agencies report to this system, and some may have incomplete data — especially in their first year of NIBRS reporting or for recent months of data. Always verify that reported offenses are not impacted by incomplete coverage.";
    // COVER batch: the returned-values coverage statement is not a source completeness caveat, so it must not suppress this one.
    const alreadyHasCoverageNote = /transitioning|underreporting|incomplete|not all agencies|coverage|did not report/i.test(explanation.replace(/Returned coverage[^\n]*/g, ""));
    if (!explanation.includes("FBI's NIBRS program") && !alreadyHasCoverageNote) {
      explanation += "\n\n" + nibrsDisclaimer;
    }

    // Log success (after CDE check so explanation includes any disclaimers)
    const finalNarrative = sanitizeUserFacingNarrative(explanation, claude.title);
    if (finalNarrative.blocked) {
      routeGuardrailsFired.push("internal-leak-firewall-result");
      console.warn(`[nibrs][internal-leak-firewall] Replaced result narrative: ${explanation}`);
    }
    explanation = finalNarrative.explanation || "";
    claude.title = finalNarrative.title || claude.title || "Results";
    claude.title = alignTitleYearRange(claude.title, rows);
    // The missing-member note is composed AFTER the internal-leak firewall, not before it. Appending
    // earlier was not enough: a model title mentioning a table name makes the firewall replace the
    // whole explanation with its safe message, which removed the note while the route went on
    // recording the disclosure. The firewall is preserved, not bypassed -- the note is re-applied to
    // whatever text it produced, and the tag is recorded from the text that will actually be sent.
    if (missingMembers && !explanation.includes(missingMembers.note)) {
      explanation = [explanation, missingMembers.note].filter(Boolean).join("\n\n");
    }
    if (missingMembers && explanation.includes(missingMembers.note)
        && !routeGuardrailsFired.includes("nibrs-unresolved-member-disclosed")) {
      routeGuardrailsFired.push("nibrs-unresolved-member-disclosed");
    }
    // Same reason: an offender share's owned statement and unit must survive a replaced narrative (GC-032).
    const shareDelivery = rows.length > 0 ? offenderShareDelivery(question, sql, rows) : null;
    for (const part of shareDelivery ?? []) {
      if (!explanation.includes(part)) explanation = [explanation, part].filter(Boolean).join("\n\n");
    }
    const totalMs = Date.now() - claudeStart;
    const firedGuardrails = finalizeGuardrailTags([...guardrailResult.fired, ...routeGuardrailsFired], queryContractGuardrails(runContractValidation(sql)));
    console.log(`[nibrs][result] model=${activeModelLabel} rows=${rows.length} retries=${retryCount} scaffold_stripped=${scaffoldStripped} guardrails=[${firedGuardrails.join(",")}] total_ms=${totalMs} db_ms=${executionTimeMs}${canaryFlag ? " CANARY" : ""}`);
    // Built before logging so the captured configuration is the one actually
    // returned to the client. buildNibrsChartConfig is pure, so moving it up is safe.
    const chartConfig = buildNibrsChartConfig(claude, columns, rows, question);
    // Model-authored: no derivation is sealed, so this cannot satisfy the contract.
    // Recorded honestly -- that asymmetry is the migration measurement (§10).
    const finalization = finalizeExit({
      // An empty result asserts no facts, so it is not an `answer`. decline_data
      // rather than decline_capability: the query ran and the source returned
      // nothing, which is a statement about the data, not about our path.
      outcome: rows.length > 0 ? OUTCOMES.model_sql_validated : OUTCOMES.no_rows_in_source,
      sql,
      rows,
      columns,
      truncated: rows.length >= 1000,
      guardrails: firedGuardrails,
      returnedEntities: returnedEntityKeys(rows),
      narrative: explanation,
      hasChart: Boolean(chartConfig),
      chartFromBindings: false,
      retries: retryCount,
    });
    writeNibrsLog(question, sql, rows.length, null, totalMs, explanation, firedGuardrails, activeModelLabel, sessionId, serializeChartConfigForLog(chartConfig, columns, { source: "FBI NIBRS", agencyCount: 0, population: null }), null, finalization);

    // Cache successful responses (only standalone questions)
    if (!cached && cacheableStandalone) {
      setCache(question, NIBRS_CACHE_TAB, { sql, explanation: claude.explanation, title: claude.title, chartType: claude.chartHint, xAxis: claude.xAxis, yAxis: claude.yAxis ? [claude.yAxis] : undefined, yAxisLabel: claude.yAxisLabel, xAxisLabel: claude.xAxisLabel, colors: claude.colors, annotations: claude.annotations }, cacheValidity);
    }

    // Step 6: Truncate if needed
    const truncated = rows.length >= 1000;

    return jsonResp(emitFactualPayload(finalization, attachChartAuditToPayload({
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
      chartMeta: { source: "FBI NIBRS", agencyCount: 0, population: null },
      executionTimeMs: totalMs,
    } as QueryResponse, { source: "nibrs", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[nibrs] Query API error:", msg);
    // OPERATIONAL ROW (P2.1 §4.3.2 X10 condition 2). Before P2.2 this catch logged nothing, so the
    // four routes recorded the same class of event three different ways and the operational
    // failure rate was unmeasurable. It writes `record_kind='operational'` and no decision: an
    // error before a decision exists is not a product decision, and fabricating one here is
    // exactly what the 16 sites that used to claim `decline_capability` were doing.
    //
    // The route-local closures are declared inside this try, so the module logger is called
    // directly — the same shape the source-switch exits already use. The write is inside the
    // logger's own swallow-on-failure boundary, so it cannot turn a 500 into anything worse.
    logNibrsQuery("", null, 0, msg.slice(0, 500), Date.now() - outerStart, null, [], null, null,
      null, null, null, null, proofLogFields(null), outcomeLogFields(OPERATIONAL_RECORD));
    return jsonResp(
      { success: false, error: governFactualNarrative(`Server error: ${msg}`, genericResultState({ sql: null, rows: [], productError: msg })) } as QueryError,
      500
    );
  }
}
