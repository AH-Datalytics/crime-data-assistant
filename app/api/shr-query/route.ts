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
import { buildNoSqlFallbackMessage, limitationReply, selectNoSqlRefusal } from "@/lib/refusal-safety";
import { detectFollowupTransform } from "@/lib/followup-transform";
import { applyGeoCorrection, geoCorrectionHint } from "@/lib/geo-correction";
import { applyChartCustomizations } from "@/lib/chart-customization";
import { planShrCityRanking, runShrCityRanking, SHR_CITY_RANKING_GUARDRAIL, type ValidatedStatement } from "@/lib/city-ranking-shr";
import { rankingValidationContract } from "@/lib/city-ranking";
import type { QueryContract } from "@/lib/query-contract";
import { loadShrTypeEvidence } from "@/lib/shr-agency-classification";
import { cachedYearClassAvailability, unresolvedInScopes, unresolvedDisclosure, unresolvedLimitation, SHR_YEAR_CLASS_TABLE, type ClassScope } from "@/lib/shr-agency-year-class";
import { SHR_AGENCY_TYPE_GUARDRAIL, requestedAgencyCategories } from "@/lib/shr-agency-type-authority";
import { CITY_RANKING_FAILURE_TEXT } from "@/lib/city-ranking-nibrs";
import { SHR_DATA_CUTOFF } from "@/lib/dynamic-facts";
import { getBlockingGeoClarification } from "@/lib/geo-resolver";
import { getCountyScopeClarification } from "@/lib/county-clarifier";
import { detectQueryBearingFollowup } from '@/lib/query-bearing-followup';
import { planFollowupSafe } from '@/lib/followup-planner';
import { buildCrossSourceFollowupTransform } from '@/lib/cross-source-followup';
import { plannerModeForSource } from '@/lib/followup-planner-mode';
import { detectDemographicRateDenominatorFollowup, detectShrGroupRateOverride, detectSubCityGeographyOverride } from "@/lib/capability-overrides";
import { displayShrAgencyName, normalizeShrAgencyText } from "@/lib/shr-agency-normalization";
import { asksSimpleFirearmHomicideTrend } from "@/lib/shr-firearm-trend-intent";
import { MONTH_NAMES, displayPlace, shootingCityIntents, shootingMeasure, shootingMonthWindow, shootingYearIntent, stateMention } from "@/lib/shr-deterministic-shooting";
import { classifyShootingQualifier } from "@/lib/shooting-qualifiers";
import {
  ASKS_SHOOTING_WORDING,
  STATES_NONFATAL,
  resolveShootingScopeFollowup,
  shouldAskShootingScope,
} from "@/lib/shooting-scope-clarification";
import {
  queryContractFailureMessage,
  queryContractGuardrails,
  type QueryContractSqlValidation,
  capabilityFinalizationOutcome,
} from "@/lib/query-contract-validator";
import { partialCoverageRetryPrompt, sourceYearOverlap } from "@/lib/source-year-overlap";
import { buildShrCanonicalLabelCase, formatShrResolutionGuidance, resolveShrAgency, rewriteShrResolvedAgencyPredicates } from "@/lib/shr-place-resolver";
import { shrCountyRequest, resolveShrCountyScope, withShrScopeAndMeasureDisclosures, allHomicideTitle, type ShrScopeBinding, type ShrCountyScopeResolution } from "@/lib/shr-county-scope";
import { shrRequestedMeasure, SHR_MEASURE_CONFLICT_MESSAGE } from "@/lib/shr-murder-licence";
import { buildShrMurderPlan } from "@/lib/shr-deterministic-murder";
import {
  validateDeterministicShrPlanSql, validateModelAuthoredShrSql, validateCompiledShrCount,
  type DeterministicShrPlanValidation, type ModelAuthoredShrValidation, type CompiledShrCountValidation,
} from "@/lib/shr-authority";
import { shrOwnedCountFamily, planShrOwnedCount, compileShrCountPlan, executeCompiledShrCount, shrCountNarrative, type CompiledShrCount } from "@/lib/shr-count-plan";
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
import { returnedEntityKeys } from "@/lib/result-disclosure";
import { boundedModelResponseJson } from "@/lib/no-sql-retry";
import { consolidatedDisplayText, normalizeConsolidatedDisplayRows } from "@/lib/agency-consolidations";
import { selectShrPivotMetric } from "@/lib/shr-category-pivot";
import { genericResultState } from "@/lib/result-state-adapters";
import { governFactualNarrative } from "@/lib/result-state";
import { shouldAskCrimeType } from "@/lib/crime-type-clarification";
import { accountShrRequest, shrRecognitionRefusal, shrKnownAgencyIndex, bindShrPath, shrPart, anyOf, shrCountPlanPlaceLabels, ledgerSatisfies, shrHasRowRestriction, shrNumericIntent } from "@/lib/shr-request-accounting";
import { planShrQuestion, compileShrQuestion, executeCompiledShrQuestion, shrQuestionOutcome, observeShrCutoff, type ShrQuestionDecision } from "@/lib/shr-question-types";
import type { Part } from "@/lib/request-accounting";
import { periodsApplied } from "@/lib/shr-period-proof";

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

/** Request accounting (plan r2.1): no model-written statement is executed on SHR. A constant, not a toggle. */
const SHR_MODEL_SQL_NEVER_RUNS: boolean = true;

export async function POST(req: NextRequest) {
  // Measured before the outer try so the operational row in its catch can record an
  // elapsed time; everything declared inside the try is out of scope there.
  const outerStart = Date.now();
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
      opts: Partial<ProofFinalizationInput> & { outcome: QueryLogOutcome },
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
      const switchProof = finalizeExit({ outcome: OUTCOMES.source_switch, planFamily: "followup-source-switch", narrative: explanation });
      // Both projectors, from the SAME finalization. This exit bypasses the route-local closure,
      // so the outcome projector has to be supplied explicitly; omitting it left this decision row
      // unclassified after activation while every route-level test still passed.
      logQuery(question, null, 0, null, 0, explanation, "shr", ["followup-source-switch"], "followup-planner", sessionId, null, null, null, null, proofLogFields(decisionFinalization(switchProof)), outcomeLogFields(asOutcomeRecord(switchProof)));
      return jsonResp(emitFactualPayload(switchProof, { success: true, question, sql: null, explanation, title: "Source switch", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: 0, sourceSwitch: { source: followupPlan.source, question: followupPlan.reconstructedQuestion } }));
    }
    const followupTransform = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? followupPlan.transform : (detectFollowupTransform(question, history) ?? buildCrossSourceFollowupTransform(question, body?.history, "shr"));
    // Bare clarifier answers ("Countywide total") carry no county name — use
    // the transform's reconstructed question so guardrails see the geography
    const guardrailQuestion = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? followupPlan.reconstructedQuestion : (followupTransform?.contextQuestion ?? question);
    proofQuestion = guardrailQuestion;
    // ── Request accounting (stage 1): ONE reconstruction boundary ──────────────────────────
    // Every reconstruction of this turn's request is resolved here, before any answer planner, so
    // the accounted request is the one actually answered: the follow-up planner's reconstruction
    // (`guardrailQuestion`) and the shooting-scope answer ("fatal") rebuilt into its question.
    const shootingScopeFollowup = resolveShootingScopeFollowup(question, normalizeHistoryAllSources(body?.history));
    const shootingRequest = shootingScopeFollowup?.reconstructedQuestion ?? question;
    const accountedQuestion = shootingScopeFollowup?.reconstructedQuestion ?? guardrailQuestion;
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
      proof: ProofFinalization | OutcomeLogRecord | null = null,
      /** Bounded raw model text on no-SQL failures; diagnostic only, never user-visible. */
      modelResponseJson: string | null = null
    ) => {
      chartAuditQueryLogId = logQuery(q, sqlText, rowCount, logError, ms, logResponse, tabName, guardrails, model, sid, routingMeta, chartConfigJson, chartAuditRequestId, modelResponseJson, proofLogFields(decisionFinalization(proof)), outcomeLogFields(asOutcomeRecord(proof)));
      return chartAuditQueryLogId;
    };
    // GC-080: the county scope bound for this request (sheriff by default, countywide only when asked).
    // Every validation below -- including the final pre-execution re-proof -- enforces it.
    let shrCountyScope: ShrScopeBinding | null = null;
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
    /**
     * SQL the MODEL wrote. The AST/fact prover owns the murder-victim licence here and there is no
     * fallback: if it cannot prove the licence the query is refused, because falling back to the
     * legacy text prover on failure would make the stronger authority optional.
     */
    // City/County membership authority (lib/shr-agency-type-authority.ts): the classification's availability is
    // read only for a statement that touches agency type; the coverage check is cached per process.
    const yearClassFor = (inputSql: string) => {
      if (!/\bagency_type\b|\bshr_agency_year_class\b/i.test(inputSql) && requestedAgencyCategories(guardrailQuestion).length === 0) return null;
      const classDb = getShrDb();
      return classDb ? cachedYearClassAvailability(classDb) : null;
    };
    const runModelAuthoredValidation = (inputSql: string): ModelAuthoredShrValidation => {
      const contractResult = validateModelAuthoredShrSql({
        question: guardrailQuestion,
        sql: inputSql,
        routingMeta,
        scope: shrCountyScope,
        yearClass: yearClassFor(inputSql),
        history,
      });
      recordContractValidation(contractResult);
      if (contractResult.licenceRefusal) {
        console.log(`[shr][licence] unproved: ${contractResult.licenceRefusal}`);
      }
      return contractResult;
    };
    /**
     * SQL a DETERMINISTIC compiler assembled from a template. Legacy validation, unchanged: neither
     * evaluated parser accepts the column-listed VALUES CTE these plans use.
     */
    const runDeterministicPlanValidation = (inputSql: string, contract: QueryContract | null = null): DeterministicShrPlanValidation => {
      const contractResult = validateDeterministicShrPlanSql({
        question: guardrailQuestion,
        sql: inputSql,
        routingMeta,
        scope: shrCountyScope,
        contract,
        yearClass: yearClassFor(inputSql),
      });
      recordContractValidation(contractResult);
      return contractResult;
    };
    /** GC-080: an OWNED COUNT the application compiled. Takes the compilation, never loose SQL. */
    const runCompiledCountValidation = (compiled: CompiledShrCount): CompiledShrCountValidation => {
      const contractResult = validateCompiledShrCount({ question: guardrailQuestion, compiled, routingMeta });
      recordContractValidation(contractResult);
      return contractResult;
    };
    const countyScopeExit =(resolution: Exclude<ShrCountyScopeResolution, { status: "resolved" }>, planFamily: string | null) => {
      const tags = [...(planFamily ? [planFamily] : []), `shr-county-${resolution.reason}`];
      const scopeProof = finalizeExit({ outcome: resolution.status === "clarify" ? OUTCOMES.geography_scope_ambiguous : OUTCOMES.capability_path_unavailable, planFamily, guardrails: tags, narrative: resolution.explanation });
      writeLog(question, null, 0, `shr_county_${resolution.reason}`, Date.now() - start, resolution.explanation, "shr", tags, planFamily ? "deterministic" : null, sessionId, null, scopeProof);
      return jsonResp(emitFactualPayload(scopeProof, {
        success: true, question, sql: null as unknown as string, explanation: resolution.explanation,
        title: "", columns: [], rows: [], rowCount: 0, truncated: false,
        chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
      }));
    };
    const contractFailureResponse = (contractResult: QueryContractSqlValidation, logError: string, guardrails: string[] = []) => {
      const msg = queryContractFailureMessage(contractResult);
      if (!msg) return null;
      const contractProof = finalizeExit({ outcome: capabilityFinalizationOutcome(contractResult), sql: contractResult.sql, guardrails: [...new Set([...guardrails, ...routeGuardrailsFired])] });
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
      const capabilityProof = finalizeExit({ outcome: OUTCOMES.capability_path_unavailable, planFamily: capabilityOverride.guardrail });
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

    // ── Request accounting gate (stage 1) ─────────────────────────────────────────────────
    // No answer may quietly drop part of the question. A part the source does not record (immigration
    // status) or that could not be interpreted ("via banana", "reported by ICE") stops the request
    // here, naming it, before any planner can answer a broader question in its place.
    const accountingDb = getShrDb();
    // A follow-up no planner reconstructed carries the earlier turns' conditions (cross-turn accounting).
    const earlierTurns = accountedQuestion === question
      ? history.filter((m) => m.role === "user").map((m) => String(m.content ?? "")).filter((t) => t.trim() && t.trim() !== question.trim())
      : [];
    const requestLedger = accountShrRequest(accountedQuestion, { ...(accountingDb ? { knownAgency: shrKnownAgencyIndex(accountingDb) } : {}), earlierTurns });
    // ONE sealed exit for every accounting decline: the recognition gate here, and each owning path's
    // binding below (a part its plan cannot apply is a terminal limitation, never a fall-through).
    const accountingExit = (refusal: { parts: Part[]; explanation: string }, owner: string) => {
      const executionMs = Date.now() - start;
      const tags = ["request-accounting", `request-accounting-owner:${owner}`, ...refusal.parts.map((p) => `request-accounting:${p.state}:${p.concept}`)];
      const accountingProof = finalizeExit({ outcome: OUTCOMES.capability_path_unavailable, planFamily: "request-accounting", guardrails: tags, narrative: refusal.explanation });
      writeLog(question, null, 0, null, executionMs, refusal.explanation, "shr", tags, "deterministic", sessionId, null, accountingProof);
      return jsonResp(emitFactualPayload(accountingProof, {
        success: true, question, sql: null, explanation: refusal.explanation,
        title: "", columns: [], rows: [], rowCount: 0, truncated: false,
        chartConfig: null, chartMeta: null, executionTimeMs: executionMs,
      }));
    };
    const accountingRefusal = shrRecognitionRefusal(requestLedger);
    if (accountingRefusal) return accountingExit(accountingRefusal, "recognition");
    // Parts every owning path may carry: context is already terminal; these never restrict.
    const carried = anyOf(shrPart.countStatistic, shrPart.victimRole, shrPart.victimUnit, shrPart.concept("presentation"));

    const completenessIntent = detectCompletenessQuestion(question);
    if (completenessIntent) {
      const completenessUnbound = bindShrPath(requestLedger, "data-completeness answer", anyOf(carried, shrPart.concept("metadata", "measure", "entity"), shrPart.anyPeriod));
      if (completenessUnbound) return accountingExit(completenessUnbound, "completeness-deterministic");
      const completenessAnswer = buildCompletenessAnswer("shr", loadCompletenessRows("shr", getShrDb()), new Date().getFullYear(), completenessIntent.year);
      const executionMs = Date.now() - start;
      const completenessProof = finalizeExit({ outcome: OUTCOMES.deterministic_plan, planFamily: "completeness-deterministic", guardrails: ["completeness-deterministic"] });
      writeLog(question, null, 0, null, executionMs, completenessAnswer, "shr", ["completeness-deterministic"], "deterministic", sessionId, null, completenessProof);
      return jsonResp(emitFactualPayload(completenessProof, { success: true, question, sql: null, explanation: completenessAnswer, title: "Data completeness", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: executionMs }));
    }

        // ── Increment 3 (Decision 9): violent / property / both ──────────────────
    // Same gate as the Current/Historical route. Geography is resolved first, so we
    // never stack two questions on one turn.
    // See the Current/Historical route: a query-bearing follow-up is judged on its
    // RECONSTRUCTED question rather than skipped, so a resolved place ambiguity cannot
    // carry an unchosen crime type past the gate.
    const crimeTypeQuestion = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing" && !followupPlan.chartOnly)
      ? followupPlan.reconstructedQuestion
      : question;
    const crimeTypeAsk = getBlockingGeoClarification(crimeTypeQuestion)
      ? null
      : shouldAskCrimeType(crimeTypeQuestion, normalizeHistoryAllSources(body?.history));
    if (crimeTypeAsk?.needsClarification) {
      const executionMs = Date.now() - start;
      const ctProof = finalizeExit({ outcome: OUTCOMES.measure_ambiguous, planFamily: "crime-type:violent-property-both" });
      writeLog(question, null, 0, null, executionMs, crimeTypeAsk.clarificationQuestion, "shr", ["crime-type:violent-property-both"], "deterministic", sessionId, null, ctProof);
      return jsonResp(emitFactualPayload(ctProof, { success: true, question, sql: null, explanation: crimeTypeAsk.clarificationQuestion, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: executionMs }));
    }

const geoClarification = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? (followupPlan.chartOnly ? null : getBlockingGeoClarification(followupPlan.reconstructedQuestion)) : getBlockingGeoClarification(question);
    if (geoClarification) {
      const executionMs = Date.now() - start;
      const geoProof = finalizeExit({ outcome: OUTCOMES.geography_ambiguous, planFamily: `geo:${geoClarification.issue.id}` });
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
      const countyProof = finalizeExit({ outcome: OUTCOMES.geography_scope_ambiguous, planFamily: `geo:${countyScope.id}` });
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
      const metadataUnbound = bindShrPath(requestLedger, "coverage answer", anyOf(carried, shrPart.concept("metadata", "measure", "entity", "agency-type", "national"), shrPart.resolvedPlace, shrPart.anyPeriod, shrPart.connector(/^(?:and|all|any|every)$/i)));
      if (metadataUnbound) return accountingExit(metadataUnbound, "metadata-coverage-answer");
      const executionMs = Date.now() - start;
      const metadataProof = finalizeExit({ outcome: OUTCOMES.deterministic_plan, sql: metadata.sql, rows: metadata.rows ?? [], columns: metadata.columns ?? [], truncated: Boolean(metadata.truncated), derivation: metadata.sql ? sealPlanDerivation("metadata-coverage-answer", metadata.sql) : null, planFamily: "metadata-coverage-answer", guardrails: ["deterministic-metadata", "metadata-coverage-answer"], hasChart: Boolean(metadata.chartConfig), narrative: metadata.explanation });
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

    // GC-080 G80-3: competing measures (murders AND all homicides, or an excluded type) get an owned
    // question before ANY builder or model call -- deliberately ahead of the city murder plan, the
    // shooting section and the owned count, so none of them can answer a guessed measure.
    if (shrRequestedMeasure(guardrailQuestion) === "conflict") {
      return countyScopeExit({ status: "clarify", reason: "measure-conflict", explanation: SHR_MEASURE_CONFLICT_MESSAGE }, null);
    }

    // Exact-year city murder totals and monthly series use canonical SHR ORIs,
    // victim rows, and explicit zeroes instead of model-generated alias LIKEs.
    // GC-080: only for a murder request; "all homicides including murders" is the owned count's.
    const murderDb = planSaysQueryBearing || shrRequestedMeasure(guardrailQuestion) !== "murder" ? null : getShrDb();
    const murderPlan = murderDb ? buildShrMurderPlan(question, murderDb) : null;
    if (murderPlan?.kind === "blocked") {
      const executionMs = Date.now() - start;
      const placeBlockProof = finalizeExit({ outcome: OUTCOMES.place_unresolved, planFamily: "deterministic-murder", guardrails: ["deterministic-murder", "shr-place-resolution-block"], narrative: murderPlan.explanation });
      writeLog(question, null, 0, "shr_place_not_resolved", executionMs, murderPlan.explanation, "shr", ["deterministic-murder", "shr-place-resolution-block"], "deterministic", sessionId, null, placeBlockProof);
      return jsonResp(emitFactualPayload(placeBlockProof, {
        success: true, question, sql: null, explanation: murderPlan.explanation,
        title: "", columns: [], rows: [], rowCount: 0, truncated: false,
        chartConfig: null, chartMeta: null, executionTimeMs: executionMs,
      }));
    }
    const murderPeriodProved = murderPlan?.kind === "query" ? periodsApplied(requestLedger.parts, murderPlan.sql) : false;
    const murderApplies = anyOf(carried, shrPart.measure(/murder/i), shrPart.resolvedPlace, (p) => p.concept === "period" && murderPeriodProved, shrPart.connector(/^and$/i));
    if (murderPlan?.kind === "query" && murderDb && ledgerSatisfies(requestLedger, murderApplies)) {
      const murderUnbound = bindShrPath(requestLedger, "murder count", murderApplies);
      if (murderUnbound) return accountingExit(murderUnbound, "deterministic-murder");
      const contract = runDeterministicPlanValidation(murderPlan.sql);
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
        const murderProof = finalizeExit({ outcome: rows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source, sql: contract.sql, rows, columns: murderPlan.columns, derivation: sealPlanDerivation("deterministic-murder", murderPlan.sql), planFamily: "deterministic-murder", guardrails: ["deterministic-murder", ...coverageTags, ...routeGuardrailsFired], returnedEntities: returnedEntityKeys(rows), narrative: explanation, hasChart: true, db: murderDb });
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
        const murderDbProof = OPERATIONAL_RECORD;
        writeLog(question, contract.sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", ["deterministic-murder"], "deterministic", sessionId, null, murderDbProof);
        return jsonResp({ success: false, error: `Database error: ${msg}` } as QueryError, 500);
      }
    }

    // ── Cause B (Decision 14): the request this shooting section is actually about ──────────
    //
    // A bare "fatal" or "nonfatal" is the ANSWER to the question asked below, not a new request.
    // Read on its own it carries no place, no years and no subject, so every predicate in this
    // section would see a different question from the one the reader asked. `shootingRequest` is
    // the original request with the chosen word in it; it differs from `question` ONLY on that
    // one turn, and `question` is still what gets logged and echoed, because that is what the
    // user typed. Nothing is inherited from the mere existence of history: the assistant's last
    // turn has to have been the question.
    // `shootingScopeFollowup` / `shootingRequest` are resolved at the reconstruction boundary above
    // (request accounting, stage 1), unchanged.

    // Deterministic nonfatal shooting refusal
    const asksCityFirearmHomicideTrend =
      asksSimpleFirearmHomicideTrend(shootingRequest) && shootingCityIntents(shootingRequest).length > 0;
    /*
     * The nonfatal wording and its reply now live in `lib/refusal-safety.ts`, so this branch and
     * the model no-SQL exit below cannot drift apart. The old reply was right that the data is not
     * collected and then sent the reader to two outside websites, offering fatal homicides as the
     * in-product alternative -- a different measure of a different thing.
     *
     * `asksCityFirearmHomicideTrend` stays in the test because it is this route's own intent
     * signal: a city firearm-homicide trend phrased as nonfatal still belongs here.
     */
    // Both literals now live in `lib/shooting-scope-clarification.ts`, so the gate that ASKS
    // which of the two the reader meant and the branch that ANSWERS the nonfatal one read the
    // same definition of a nonfatal request.
    const asksShooting =
      ASKS_SHOOTING_WORDING.test(shootingRequest) ||
      asksCityFirearmHomicideTrend;
    const wantsNonfatal = STATES_NONFATAL.test(shootingRequest);
    if (asksShooting && wantsNonfatal) {
      // One shared reply, one shared shape. The wording, the logged reason and the empty-answer
      // state all come from `limitationReply`, so this exit and the model no-SQL exit below cannot
      // tell the reader different things about the same limitation.
      const reply = limitationReply(shootingRequest, "shr");
      const nonfatalProof = finalizeExit({ outcome: OUTCOMES.capability_path_unavailable, planFamily: "nonfatal-shooting-capability-limit", narrative: reply.explanation });
      writeLog(question, null, 0, null, Date.now() - start, reply.explanation, "shr", ["nonfatal-shooting-capability-limit", reply.reason], "deterministic", sessionId, null, nonfatalProof);
      return jsonResp(emitFactualPayload(nonfatalProof, {
        success: true, question, sql: reply.sql, explanation: reply.explanation,
        title: reply.title, columns: reply.columns, rows: reply.rows, rowCount: reply.rowCount,
        truncated: reply.truncated, chartConfig: reply.chartConfig, chartMeta: reply.chartMeta,
        executionTimeMs: Date.now() - start,
      }));
    }

    // ── Cause B (Decision 14): ask which shootings, before answering with either ────────────
    //
    // THE DEFECT. "shootings in Chicago since 2015" (GC-110) fell straight through to the
    // deterministic path below, which returned twelve years of firearm homicides and appended
    // "nonfatal shootings are not tracked in this database". A note under a number is not a
    // resolution — the reader has the number by then. Decision 14 requires the ambiguity to be
    // resolved BEFORE an answer, and the product had already classified this exact request as a
    // blocking `shooting-scope` ambiguity in `lib/query-guidance.ts`; nothing acted on it.
    //
    // ORDERING. Geography and crime type have already asked above if they needed to, so this is
    // still one question per turn. Query-bearing follow-ups keep their existing model path
    // untouched: this gate is not a place to redesign follow-up routing.
    //
    // WHAT IT DELIVERS. A question. No SQL, no rows, no model call — the point is that nothing
    // has been decided yet.
    const shootingScopeAsk = shouldAskShootingScope(shootingRequest, normalizeHistoryAllSources(body?.history));
    if (asksShooting && !wantsNonfatal && shootingScopeAsk.needsClarification
        && !(plannerMode === "authoritative" && followupPlan?.kind === "query_bearing")) {
      const scopeMs = Date.now() - start;
      const scopeProof = finalizeExit({
        outcome: OUTCOMES.measure_ambiguous,
        planFamily: "shooting-scope-clarification",
        narrative: shootingScopeAsk.clarificationQuestion,
      });
      writeLog(question, null, 0, null, scopeMs, shootingScopeAsk.clarificationQuestion, "shr",
        ["shooting-scope-clarification"], "deterministic", sessionId, null, scopeProof);
      return jsonResp(emitFactualPayload(scopeProof, {
        success: true, question, sql: null,
        explanation: shootingScopeAsk.clarificationQuestion, title: "",
        columns: [], rows: [], rowCount: 0, truncated: false,
        chartConfig: null, chartMeta: null, executionTimeMs: scopeMs,
      }));
    }

    // Deterministic fatal shooting handling — bypass Claude entirely
    // Route bare/ambiguous shooting queries directly to firearm homicide data
    // Qualifier awareness (production 7881). "police fatal shootings" used to
    // return ALL firearm homicides — 14,777 vs a correct 349 for 2023 — because
    // this path fires on any mention of "shooting" and has no notion of
    // qualifiers. Police is now expressible; anything else it cannot express
    // must fall through to the model rather than answer a different question.
    const shootingQualifier = classifyShootingQualifier(shootingRequest);
    if (asksShooting && !wantsNonfatal && shootingQualifier.kind === "unsupported") {
      console.log(`[shr][deterministic-shooting] declining: unsupported qualifier(s) ${shootingQualifier.ids.join(",")} — routing to model`);
    }
    // GC-108/109: the requested month window and measure must reach the delivered answer. A form this path cannot
    // build (a month tied to one year, an offender or non-median age statistic) declines, as an unsupported
    // qualifier does, instead of answering whole-year victim counts.
    const shootingMonths = shootingMonthWindow(shootingRequest);
    const shootingMeasured = shootingMeasure(shootingRequest);
    const shootingFormSupported = shootingMonths.kind !== "unsupported" && shootingMeasured.kind !== "unsupported";
    if (asksShooting && !wantsNonfatal && !shootingFormSupported) {
      const why = shootingMonths.kind === "unsupported" ? shootingMonths.reason : shootingMeasured.kind === "unsupported" ? shootingMeasured.reason : "";
      console.log(`[shr][deterministic-shooting] declining: ${why} — routing to model`);
    }
    if (asksShooting && !wantsNonfatal && shootingQualifier.kind !== "unsupported" && shootingFormSupported && !(plannerMode === "authoritative" && followupPlan?.kind === "query_bearing")) {
      const stateMatch = shootingRequest.match(/\b([A-Z]{2})\b/) || shootingRequest.match(/\bin\s+(\w+)\b/i);
      const yearIntent = shootingYearIntent(shootingRequest);
      const wantsMonthly = /\b(?:monthly|per\s+month|by\s+month)\b/i.test(shootingRequest);
      const yearOverlap = sourceYearOverlap("shr", shootingRequest);
      if (yearOverlap && !yearOverlap.hasOverlap) {
        const explanation = `SHR homicide data covers ${yearOverlap.sourceStartYear}-${yearOverlap.sourceEndYear}, so it cannot answer the requested year range. Ask for fatal shootings from ${yearOverlap.sourceStartYear} onward.`;
        const yearOverlapProof = finalizeExit({ outcome: OUTCOMES.outside_source_years, planFamily: "deterministic-shooting", guardrails: ["deterministic-shooting", "shr-year-no-overlap"], narrative: explanation });
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

      // GC-080: an explicit all-homicide request drops the Murder restriction; "shootings" keeps it.
      const shootingAllHomicides = shrRequestedMeasure(guardrailQuestion) === "homicide";
      const whereClauses = [...(shootingAllHomicides ? [] : ["i.homicide_type = 'Murder'"]), "i.weapon_group = 'Firearm'", effectiveYearClause];
      // All 18,697 'Felon Killed by Police' incidents are homicide_type='Murder',
      // so the Murder filter above stays valid alongside this predicate.
      if (shootingQualifier.kind === "supported" && shootingQualifier.qualifier.clause) {
        whereClauses.push(shootingQualifier.qualifier.clause);
      }
      let joinClauses = "JOIN victims v ON v.incident_id = i.id";
      // The name-match fallback's City membership comes from the agency/year classification only.
      const CITY_CLASS_FILTER = "cls.agency_type = 'City'";
      let fallbackClassUsed = false;
      let withClause = "";
      let titlePlace = "Nationally";
      let cityCount = 0;
      let cityLabelExpression = "i.agency";
      const explicitOri = shootingRequest.match(/\bORI\s*(?:[:#=]|is)?\s*((?=[A-Z0-9]*\d)[A-Z]{2}[A-Z0-9]{3,7})\b/i)?.[1]?.toUpperCase() || null;
      // GC-080: a county name means the sheriff agency; the crosswalk total only when asked for.
      const countyRequest = shrCountyRequest(shootingRequest);
      const county = countyRequest?.scope === "countywide" ? { key: countyRequest.countyKey, display: countyRequest.countyDisplay } : null;
      const mentionedState = stateMention(shootingRequest);

      // Explicit state-level wording ("New York State", "statewide in Washington")
      // must resolve to a state filter, never a same-named city agency (F18 / #4155).
      const stateIntent = explicitStateIntent(shootingRequest);
      if (countyRequest?.scope === "sheriff") {
        const db = getShrDb();
        if (!db) {
          return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
        }
        const resolution = resolveShrCountyScope(db, countyRequest);
        if (resolution.status !== "resolved") return countyScopeExit(resolution, "deterministic-shooting");
        shrCountyScope = resolution.binding;
        whereClauses.push(`i.ori IN (${resolution.binding.oris.map((ori) => `'${ori.replace(/'/g, "''")}'`).join(", ")})`);
        titlePlace = resolution.binding.label;
      } else if (county) {
        const db = getShrDb();
        if (!db) {
          return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
        }
        const hasCrosswalk = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'agency_county_crosswalk'").get());
        if (!hasCrosswalk) {
          const explanation = "I do not currently have the agency-by-county crosswalk needed to answer countywide SHR geography questions. I should not infer county membership from agency names.";
          const crosswalkProof = finalizeExit({ outcome: OUTCOMES.required_component_unavailable, planFamily: "deterministic-shooting", narrative: explanation });
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
          const countyNotFoundProof = finalizeExit({ outcome: OUTCOMES.not_in_source, planFamily: "deterministic-shooting", narrative: explanation });
          writeLog(question, null, 0, "county_not_found", Date.now() - start, explanation, "shr", ["deterministic-shooting"], "deterministic", sessionId, null, countyNotFoundProof);
          return jsonResp(emitFactualPayload(countyNotFoundProof, {
            success: true, question, sql: null, explanation,
            title: "", columns: [], rows: [], rowCount: 0, truncated: false,
            chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
          }));
        }

        if (!mentionedState && countyStates.length > 1) {
          const explanation = `${county.display} County matches multiple states in the agency county crosswalk: ${countyStates.map((row) => row.state).join(", ")}. Please specify a state.`;
          const ambiguousCountyProof = finalizeExit({ outcome: OUTCOMES.geography_ambiguous, planFamily: "deterministic-shooting", narrative: explanation });
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
          const oriNotInSourceProof = finalizeExit({ outcome: OUTCOMES.not_in_source, planFamily: "deterministic-shooting", guardrails: ["deterministic-shooting", "shr-place-resolution-block", "shr-ori-not-in-source"], narrative: explanation });
          writeLog(question, null, 0, "shr_ori_not_in_source", Date.now() - start, explanation, "shr", ["deterministic-shooting", "shr-place-resolution-block", "shr-ori-not-in-source"], "deterministic", sessionId, null, oriNotInSourceProof);
          return jsonResp(emitFactualPayload(oriNotInSourceProof, { success: true, question, sql: null, explanation, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
        }
        titlePlace = `ORI ${explicitOri} - ${identity.canonical_agency || "identified agency"}`;
        whereClauses.push(`i.ori = '${explicitOri.replace(/'/g, "''")}'`);
      } else if (ambiguousKansasCityIntent(shootingRequest)) {
        const explanation = "Please specify Kansas City, Missouri (KCMO) or Kansas City, Kansas (KCK). Both exist in the SHR data, and I should not combine or choose between them without that state.";
        const ambiguousCityProof = finalizeExit({ outcome: OUTCOMES.geography_ambiguous, planFamily: "deterministic-shooting", narrative: explanation });
        writeLog(question, null, 0, "ambiguous_city", Date.now() - start, explanation, "shr", ["deterministic-shooting"], "deterministic", sessionId, null, ambiguousCityProof);
        return jsonResp(emitFactualPayload(ambiguousCityProof, {
          success: true, question, sql: null, explanation,
          title: "", columns: [], rows: [], rowCount: 0, truncated: false,
          chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
        }));
      } else {
        const cities = shootingCityIntents(shootingRequest);
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
              const blockedCityProof = finalizeExit({ outcome: OUTCOMES.place_unresolved, planFamily: "deterministic-shooting", guardrails: ["deterministic-shooting", "shr-place-resolution-block"], narrative: explanation });
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
            // Never "blank means City" (Codex combined ruling, 2026-10-02): the agency/year classification decides,
            // keyed on all three of ori, state and year so it restricts the counted rows without multiplying them.
            joinClauses += ` JOIN ${SHR_YEAR_CLASS_TABLE} cls ON cls.ori = i.ori AND cls.state = i.state AND cls.year = i.year`;
            whereClauses.push(CITY_CLASS_FILTER);
            fallbackClassUsed = true;
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
      // The where clauses BEFORE any month restriction, for the unknown-month disclosure below.
      const whereWithoutMonth = [...whereClauses];
      if (wantsMonthly) whereClauses.push("i.month IS NOT NULL");
      // GC-108: the requested months within each year. An incident without a recorded month cannot be placed in
      // the window, so it is excluded (and disclosed below), never counted as if it fell inside it.
      if (shootingMonths.kind === "supported") whereClauses.push(`i.month BETWEEN ${shootingMonths.startMonth} AND ${shootingMonths.endMonth}`);
      const medianAge = shootingMeasured.kind === "median_age";
      const measureColumn = medianAge ? "median_victim_age" : "fatal_shootings";
      // GC-109: the median recorded victim age per period (and place), from the SAME rows the count would use.
      // SQLite has no MEDIAN: rank known ages within each group; the median is the middle rank (odd n) or the mean
      // of the two middle ranks (even n). Victims with no recorded age are excluded from the median and counted.
      const medianKeys = [wantsMonthly ? "month" : "year", ...(isMultiCity ? ["agency", "state"] : [])];
      const medianSql = () => {
        const ctePrefix = withClause ? `${withClause.trimEnd()}, ` : "WITH ";
        const keys = medianKeys.join(", ");
        return `${ctePrefix}shooting_victims AS (SELECT ${periodSelect}, ${selectPlace}v.age_num AS age FROM incidents i ${joinClauses} WHERE ${whereClauses.join(" AND ")}), `
          + `ranked AS (SELECT ${keys}, age, ROW_NUMBER() OVER (PARTITION BY ${keys} ORDER BY age) AS rn, COUNT(*) OVER (PARTITION BY ${keys}) AS n FROM shooting_victims WHERE age IS NOT NULL), `
          + `medians AS (SELECT ${keys}, AVG(age) AS median_victim_age, MAX(n) AS victims_with_known_age FROM ranked WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY ${keys}), `
          + `totals AS (SELECT ${keys}, COUNT(*) AS fatal_shooting_victims, SUM(CASE WHEN age IS NULL THEN 1 ELSE 0 END) AS victims_age_unknown FROM shooting_victims GROUP BY ${keys}) `
          + `SELECT ${medianKeys.map((k) => `t.${k}`).join(", ")}, m.median_victim_age, COALESCE(m.victims_with_known_age, 0) AS victims_with_known_age, t.victims_age_unknown FROM totals t LEFT JOIN medians m ON ${medianKeys.map((k) => `m.${k} = t.${k}`).join(" AND ")} ORDER BY ${medianKeys.map((k) => `t.${k}`).join(", ")} LIMIT 1000`;
      };
      // Held in a variable so the derivation can be sealed from what the PLANNER
      // emitted. Sealing from shootingContract.sql -- the post-validation string --
      // would fingerprint the executed SQL against itself and prove nothing, which is
      // exactly the tautology the token exists to avoid. The contract validator can
      // rewrite this query, and that rewrite is what must remain detectable.
      const countShootingSql = `${withClause}SELECT ${periodSelect}, ${selectPlace}COUNT(*) AS fatal_shootings FROM incidents i ${joinClauses} WHERE ${whereClauses.join(" AND ")} GROUP BY ${periodGroup}${groupPlace} ORDER BY ${periodOrder}${orderPlace} LIMIT 1000`;
      const plannedShootingSql = `${medianAge ? medianSql() : countShootingSql}`;
      const shootingPeriodProved = periodsApplied(requestLedger.parts, plannedShootingSql);
      const shootingIsNational = !/\b(?:[a-z_]+\.)?(?:state|ori|county_key|county_fips)\s*(?:=|IN\b)/i.test(plannedShootingSql);
      const shootingUnbound = bindShrPath(requestLedger, "fatal-shooting answer", anyOf(
        carried, shrPart.measure(/./), (p) => p.concept === "period" && shootingPeriodProved, shrPart.resolvedPlace, shrPart.connector(/^and$/i),
        (p) => p.concept === "national" && shootingIsNational,
        (p) => p.concept === "weapon" && /shoot|shot|firearm|gun/i.test(p.text),
        (p) => p.concept === "place" && (p.rule === "place:unresolved-county" || p.rule === "place:shr-agency"),
        shrPart.concept("agency-type"),
        (p) => shootingQualifier.kind === "supported" && (p.concept === "circumstance" || p.concept === "agency-type"),
        (p) => medianAge && (p.concept === "age" || (p.concept === "statistic" && /median/i.test(p.text))),
      ));
      if (shootingUnbound) return accountingExit(shootingUnbound, "deterministic-shooting");
      const shootingContract = runDeterministicPlanValidation(plannedShootingSql);
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
      const monthWindowLabel = shootingMonths.kind === "supported" ? ` (${shootingMonths.label})` : "";
      const monthWindowText = shootingMonths.kind === "supported" ? `, ${shootingMonths.explanation}` : "";
      const title = medianAge
        ? `Median Age of Victims: ${qualifierTitle}, ${titlePlace}, ${effectiveYearLabel}${monthWindowLabel}`
        : `${qualifierTitle}, ${titlePlace}, ${effectiveYearLabel}${monthWindowLabel}`;
      const explanationLead = medianAge
        ? `Median age of victims of ${qualifierNarrative} by ${wantsMonthly ? "month" : "year"}`
        : `${qualifierNarrative.charAt(0).toUpperCase()}${qualifierNarrative.slice(1)} by ${wantsMonthly ? "month" : "year"}`;
      const explanation = `${explanationLead}${titlePlace !== "Nationally" ? ` in ${titlePlace}` : ""} ${effectiveYearExplanation}${monthWindowText}. This shows only homicides where the weapon was a firearm - nonfatal shootings are not tracked in this database.${qualifierCaveat ? ` ${qualifierCaveat}` : ""}`;
      // Execute the deterministic SQL
      const db = getShrDb();
      if (!db) {
        return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
      }
      try {
        let rows = db.prepare(sql).all() as Record<string, unknown>[];
        rows = normalizeShrDisplayRows(rows);
        const columns = rows.length > 0 ? Object.keys(rows[0])
          : medianAge ? [...medianKeys, "median_victim_age", "victims_with_known_age", "victims_age_unknown"] : [wantsMonthly ? "month" : "year", "fatal_shootings"];

        // Add caveats
        // Named-agency rows the classification could not type, within this statement's own filters.
        let fallbackUnresolved: { agencies: number; incidents: number } | null = null;
        const fallbackScopes: ClassScope[] | null = shootingContract.agencyTypeScopes ?? null;
        if (fallbackClassUsed) {
          const baseWhere = whereClauses.filter((c) => c !== CITY_CLASS_FILTER);
          const u = db.prepare(
            `SELECT COUNT(DISTINCT i.ori || '|' || i.state) AS agencies, COUNT(*) AS incidents FROM incidents i JOIN victims v ON v.incident_id = i.id` +
            ` LEFT JOIN ${SHR_YEAR_CLASS_TABLE} u ON u.ori = i.ori AND u.state = i.state AND u.year = i.year` +
            ` WHERE ${baseWhere.join(" AND ")} AND (u.ori IS NULL OR u.membership = 'unresolved')`,
          ).get() as { agencies: number; incidents: number };
          fallbackUnresolved = u;
          if (u.agencies > 0 && isZeroResult(rows, columns)) {
            const limitation = unresolvedLimitation(u, fallbackScopes ?? []);
            const limitationProof = finalizeExit({ outcome: OUTCOMES.reporting_coverage_insufficient, sql, guardrails: ["deterministic-shooting", SHR_AGENCY_TYPE_GUARDRAIL], narrative: limitation, db });
            writeLog(question, sql, 0, "shr_agency_type_unresolved", Date.now() - start, limitation, "shr", ["deterministic-shooting", SHR_AGENCY_TYPE_GUARDRAIL], "deterministic", sessionId, null, limitationProof);
            return jsonResp(emitFactualPayload(limitationProof, {
              success: true, question, sql, explanation: limitation, title: "", columns: [], rows: [], rowCount: 0, truncated: false,
              chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start,
            }));
          }
        }
        const caveats = [normalizeShrAgencyText(explanation)];
        if (fallbackUnresolved && fallbackScopes && fallbackUnresolved.agencies > 0) caveats.push(unresolvedDisclosure(fallbackUnresolved, fallbackScopes));
        if (overlapDisclosure) caveats.push(overlapDisclosure);
        // GC-108: what the month window could not place, and a latest year the source does not yet cover to the end
        // of the window.
        if (shootingMonths.kind === "supported") {
          const unknownMonth = db.prepare(
            `${withClause}SELECT COUNT(*) AS n FROM incidents i ${joinClauses} WHERE ${whereWithoutMonth.join(" AND ")} AND i.month IS NULL`,
          ).get() as { n: number };
          if (unknownMonth.n > 0) {
            caveats.push(`${unknownMonth.n.toLocaleString("en-US")} victim record${unknownMonth.n === 1 ? "" : "s"} in this scope ${unknownMonth.n === 1 ? "has" : "have"} no recorded month, so ${unknownMonth.n === 1 ? "it is" : "they are"} not included in the ${shootingMonths.label} window.`);
          }
          const cutoffYear = Number(SHR_DATA_CUTOFF.year), cutoffMonth = Number(SHR_DATA_CUTOFF.month);
          const latestRowYear = rows.reduce((max, r) => Math.max(max, Number(r.year ?? String(r.month ?? "").slice(0, 4)) || 0), 0);
          if (latestRowYear === cutoffYear && cutoffMonth >= 1 && cutoffMonth < shootingMonths.endMonth) {
            caveats.push(`SHR data for ${cutoffYear} runs through ${MONTH_NAMES[cutoffMonth - 1]}, so ${cutoffYear} covers ${MONTH_NAMES[shootingMonths.startMonth - 1]}–${MONTH_NAMES[cutoffMonth - 1]} only, not the full ${shootingMonths.label} window.`);
          }
        }
        // GC-109: the median is over victims with a recorded age; the unknown-age victims are counted, not guessed.
        if (medianAge) {
          const unknownAge = rows.reduce((sum, r) => sum + (Number(r.victims_age_unknown) || 0), 0);
          caveats.push(`The median is computed from victims with a recorded age (victims_with_known_age); ${unknownAge > 0 ? `${unknownAge.toLocaleString("en-US")} victim${unknownAge === 1 ? "" : "s"} with no recorded age ${unknownAge === 1 ? "is" : "are"} excluded and shown as victims_age_unknown` : "no victim in these rows lacks a recorded age"}. A period with no recorded ages has no median.`);
        }
        caveats.push(medianAge
          ? "Not all agencies and states report SHR data every year, so these figures describe the reported victims only."
          : "Not all agencies and states report SHR data every year, so these counts underrepresent total fatal shootings.");
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

        // GC-080: which agency was queried, and which victims counted, stated by the application.
        totalExplanation = withShrScopeAndMeasureDisclosures(totalExplanation, shrCountyScope, shootingAllHomicides);
        const displayTitle = normalizeShrAgencyText(title);
        const chartConfig = applyChartCustomizations({ type: "line", xAxis: wantsMonthly ? "month" : "year", yAxis: [measureColumn], yAxisLabel: medianAge ? "Median Victim Age" : "Fatal Shootings", title: displayTitle }, question);
        const shootingProof = finalizeExit({ outcome: rows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source, sql, rows, columns, derivation: sealPlanDerivation("deterministic-shooting", plannedShootingSql), planFamily: "deterministic-shooting", guardrails: detGuardrails, returnedEntities: returnedEntityKeys(rows), narrative: totalExplanation, hasChart: true, db });
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
        const shootingDbProof = OPERATIONAL_RECORD;
        writeLog(question, sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", ["deterministic-shooting"], "deterministic", sessionId, null, shootingDbProof);
        return jsonResp({ success: false, error: `Database error: ${msg}` } as QueryError, 500);
      }
    }

    // ── Supported question types (request accounting stage 1, plan r3.1) ─────────────────────────
    // Every SHR request that asks for a number and that no unchanged path answers WHOLE is answered only by
    // one of the closed list of question types (lib/shr-question-types.ts), compiled and described by the
    // application, or declined by name. A legacy path's refusal never ends a request a type can answer
    // (Codex r2 #7). The decision is pure and computed once.
    let shrTypeDecisionMemo: ShrQuestionDecision | null | undefined;
    const shrTypeDb = getShrDb();
    const shrTypeDecision = (): ShrQuestionDecision | null => {
      if (shrTypeDecisionMemo !== undefined) return shrTypeDecisionMemo;
      shrTypeDecisionMemo = shrNumericIntent(requestLedger) && shrTypeDb ? planShrQuestion(requestLedger, shrTypeDb, accountedQuestion, observeShrCutoff(shrTypeDb)) : null;
      return shrTypeDecisionMemo;
    };
    const shrTypeAnswers = () => shrTypeDecision()?.kind === "spec";
    const answerShrType = (decision: ShrQuestionDecision) => {
      if (decision.kind === "county-exit") return countyScopeExit(decision.resolution, "owned-shr-request-plan");
      if (decision.kind === "decline") return accountingExit({ parts: decision.parts, explanation: decision.explanation }, "question-type");
      const planDb = shrTypeDb!;
      const compiledType = compileShrQuestion(decision.spec);
      try {
        const executed = executeCompiledShrQuestion(planDb, compiledType);
        const rows = normalizeShrDisplayRows(executed.rows);
        const outcome = shrQuestionOutcome(planDb, compiledType, executed.rows, executed.coverage);
        if (outcome.withhold) return accountingExit({ parts: [], explanation: outcome.withhold }, "question-type");
        const explanation = [compiledType.explanation, ...outcome.disclosures].join("\n\n");
        const executionMs = Date.now() - start;
        const recorded = rows.some((row) => row[compiledType.valueColumn] != null);
        const columns = [...compiledType.columns];
        const chartConfig = compiledType.chartType === "none" ? null : applyChartCustomizations({
          type: compiledType.chartType, xAxis: compiledType.xAxis ?? "place", yAxis: [compiledType.valueColumn],
          yAxisLabel: compiledType.yAxisLabel, title: compiledType.title,
        }, question);
        const planTags = ["owned-shr-request-plan", `shr-question-type:${compiledType.spec.type}`, ...routeGuardrailsFired];
        const planProof = finalizeExit({ outcome: recorded ? OUTCOMES.deterministic_plan : OUTCOMES.all_values_null, sql: compiledType.sql, rows, columns, derivation: sealPlanDerivation("owned-shr-request-plan", compiledType.sql), planFamily: "owned-shr-request-plan", guardrails: planTags, returnedEntities: returnedEntityKeys(rows), narrative: explanation, hasChart: Boolean(chartConfig), db: planDb });
        writeLog(question, compiledType.sql, rows.length, null, executionMs, explanation, "shr", planTags, "deterministic", sessionId, chartConfig ? serializeChartConfigForLog(chartConfig, columns, { source: "FBI SHR", agencyCount: 0, population: null }) : null, planProof);
        return jsonResp(emitFactualPayload(planProof, attachChartAuditToPayload({
          success: true, question, sql: compiledType.sql, explanation,
          title: compiledType.title, columns, rows,
          rowCount: rows.length, truncated: false,
          chartConfig,
          chartMeta: { source: "FBI SHR", agencyCount: 0, population: null },
          executionTimeMs: executionMs,
        }, { source: "shr", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        const planDbProof = OPERATIONAL_RECORD;
        writeLog(question, compiledType.sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", ["owned-shr-request-plan"], "deterministic", sessionId, null, planDbProof);
        return jsonResp({ success: false, error: `Database error: ${msg}` } as QueryError, 500);
      }
    };

    // GC-064 city ranking. A recognised ranking of cities is built by the application, validated as a
    // deterministic plan and run here -- before the owned count, whose limitation would otherwise
    // refuse a rate ranking -- and a recognised ranking it cannot build is an owned limitation, never
    // model-written SQL.
    const shrRanking = planShrCityRanking(guardrailQuestion, {
      year: SHR_DATA_CUTOFF.year, month: SHR_DATA_CUTOFF.month, observed: SHR_DATA_CUTOFF.observed,
    });
    if (shrRanking?.kind === "unavailable") {
      if (shrTypeAnswers()) return answerShrType(shrTypeDecision()!);
      return countyScopeExit({ status: "unavailable", reason: "city-ranking-unavailable", explanation: shrRanking.explanation }, SHR_CITY_RANKING_GUARDRAIL);
    }
    if (shrRanking?.kind === "deterministic") {
      const rankingDb = getShrDb();
      if (!rankingDb) {
        return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
      }
      // Every answer statement the flow runs is validated here first; a refusal ends the flow with the
      // route's ordinary contract-failure reply, never the model path.
      let refusedContract: DeterministicShrPlanValidation | null = null;
      // A stated nationwide scope validates against its assembled scope, not the raw national reading.
      const rankingContract = rankingValidationContract(guardrailQuestion, "shr");
      const validateRankingStatement = (statement: string): ValidatedStatement | null => {
        const contract = runDeterministicPlanValidation(statement, rankingContract);
        if (queryContractFailureMessage(contract)) { refusedContract = contract; return null; }
        return { sql: contract.sql, rows: () => normalizeShrDisplayRows(rankingDb.prepare(contract.sql).all() as Record<string, unknown>[]) };
      };
      let outcome: ReturnType<typeof runShrCityRanking>;
      try {
        outcome = runShrCityRanking(shrRanking, { validate: validateRankingStatement, typeEvidence: (year) => loadShrTypeEvidence(rankingDb, year) });
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        const rankingDbProof = OPERATIONAL_RECORD;
        writeLog(question, shrRanking.built.sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", [SHR_CITY_RANKING_GUARDRAIL], "deterministic", sessionId, null, rankingDbProof);
        return jsonResp({ success: false, error: `Database error: ${msg}` } as QueryError, 500);
      }
      if (outcome.kind === "refused" && refusedContract) {
        const contractFailure = contractFailureResponse(refusedContract, `contract_city_ranking_failure:${(refusedContract as DeterministicShrPlanValidation).enforced.join(",")}`, [SHR_CITY_RANKING_GUARDRAIL]);
        if (contractFailure) return contractFailure;
      }
      if (outcome.kind !== "answer") {
        return countyScopeExit({ status: "unavailable", reason: "city-ranking-refused", explanation: CITY_RANKING_FAILURE_TEXT }, SHR_CITY_RANKING_GUARDRAIL);
      }
      const rows = outcome.rows;
      const executionMs = Date.now() - start;
      const explanation = outcome.explanation;
      const rankingTags = [SHR_CITY_RANKING_GUARDRAIL, ...(outcome.complete ? [] : ["city-ranking-partial"]), ...routeGuardrailsFired];
      const chartConfig = applyChartCustomizations({
        type: "bar", xAxis: "city", yAxis: [shrRanking.built.sortColumn], yAxisLabel: shrRanking.yAxisLabel, title: outcome.title,
      }, question);
      const columns = [...shrRanking.built.columns];
      const rankingProof = finalizeExit({ outcome: rows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source, sql: outcome.sql, rows, columns, derivation: sealPlanDerivation(SHR_CITY_RANKING_GUARDRAIL, outcome.sql), planFamily: SHR_CITY_RANKING_GUARDRAIL, guardrails: rankingTags, returnedEntities: returnedEntityKeys(rows), narrative: explanation, hasChart: true, db: rankingDb });
      writeLog(question, outcome.sql, rows.length, null, executionMs, explanation, "shr", rankingTags, "deterministic", sessionId, serializeChartConfigForLog(chartConfig, columns, { source: "FBI SHR", agencyCount: rows.length, population: null }), rankingProof);
      return jsonResp(emitFactualPayload(rankingProof, attachChartAuditToPayload({
        success: true, question, sql: outcome.sql, explanation,
        title: outcome.title, columns, rows,
        rowCount: rows.length, truncated: false,
        chartConfig,
        chartMeta: { source: "FBI SHR", agencyCount: rows.length, population: null },
        executionTimeMs: executionMs,
      }, { source: "shr", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
    }

    // Rates belong to the agency-rate type (T6): one agency's rate by year, or the approved decline that points state,
    // county and national rates to Historical and Current Trends (plan r3.1 R1). City rate RANKINGS stay above.
    if (requestLedger.parts.some((p) => p.state !== "context" && p.concept === "statistic" && /^rates?$|per\s+capita|per\s+100|^per\s+\d/i.test(p.text.trim())) && shrTypeDecision()) {
      return answerShrType(shrTypeDecision()!);
    }

    // GC-080 owned count (Codex reassessment ruling). A county-bound or all-homicide request is
    // answered ONLY by the count the application compiles here, before the response cache and before
    // any model call. The model never authors SQL for this family, and there is no murder fallback:
    // what the plan cannot express gets an owned limitation or clarification. The conflict question
    // above and the deterministic shooting section run first, deliberately.
    if (shrOwnedCountFamily(guardrailQuestion) && !shrHasRowRestriction(requestLedger)) {
      const countDb = getShrDb();
      if (!countDb) {
        return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
      }
      const owned = planShrOwnedCount(guardrailQuestion, countDb);
      // A legacy refusal never ends a request a supported question type answers (Codex r2 #7).
      if (owned.kind !== "plan" && shrTypeAnswers()) return answerShrType(shrTypeDecision()!);
      // r5: when both refuse, the question-type decline names the PART (a second threshold, a reversed span); the owned
      // count's generic refusal does not, so the named decline is delivered.
      if (owned.kind === "limitation" && shrTypeDecision()?.kind === "decline") return answerShrType(shrTypeDecision()!);
      if (owned.kind === "county-exit") return countyScopeExit(owned.resolution, "owned-shr-count");
      if (owned.kind === "limitation") {
        return countyScopeExit({ status: owned.status, reason: owned.reason, explanation: owned.explanation }, "owned-shr-count");
      }
      const ownedPlan = owned.plan;
      // Its period was admitted by the accepted complete-period check (OC1, readPeriod) when the plan was made.
      const ownedApplies = anyOf(
        carried, shrPart.measure(/murder|homicide|killing|slaying|death|manslaughter/i), shrPart.anyPeriod,
        shrPart.placeIn(shrCountPlanPlaceLabels(ownedPlan)), shrPart.resolvedPlace,
        (p) => ownedPlan.geography.kind === "national" && p.concept === "national",
        (p) => ownedPlan.geography.kind === "county" && (p.concept === "agency-type" || (p.concept === "place" && p.rule === "place:unresolved-county")),
        (p) => Boolean(ownedPlan.ratio) && (p.concept === "sex" || (p.concept === "statistic" && /ratio/i.test(p.text))),
        shrPart.connector(/^and$/i),
      );
      // The owned count owns the request only when it applies EVERY part (a pure check; binding happens only in the owner).
      if (!ledgerSatisfies(requestLedger, ownedApplies) && shrTypeAnswers()) return answerShrType(shrTypeDecision()!);
      shrCountyScope = ownedPlan.geography.kind === "county" ? ownedPlan.geography.binding : null;
      const countUnbound = bindShrPath(requestLedger, "homicide count", ownedApplies);
      if (countUnbound) return accountingExit(countUnbound, "owned-shr-count");
      const compiled = compileShrCountPlan(owned.plan);
      const contract = runCompiledCountValidation(compiled);
      const contractFailure = contractFailureResponse(contract, `contract_owned_count_failure:${contract.enforced.join(",")}`, ["owned-shr-count"]);
      if (contractFailure) return contractFailure;
      try {
        const rows = normalizeShrDisplayRows(executeCompiledShrCount(countDb, contract.compiled));
        const explanation = shrCountNarrative(contract.compiled, rows);
        const executionMs = Date.now() - start;
        // A ratio's blank can mean "undefined" (no denominator victims), not "unknown": records are judged by the counts.
        const hasRecords = (row: Record<string, unknown>) => contract.compiled.plan.ratio
          ? row.male_victims != null || row.female_victims != null
          : row[contract.compiled.valueColumn] != null;
        const recorded = rows.some(hasRecords);
        const countTags = ["owned-shr-count", ...(contract.compiled.plan.ratio ? ["owned-shr-sex-ratio"] : []), ...(rows.some((row) => !hasRecords(row)) ? ["shr-owned-count-unknown-periods"] : [])];
        const chartConfig = applyChartCustomizations({
          type: contract.compiled.chartType, xAxis: contract.compiled.xAxis, yAxis: [contract.compiled.valueColumn],
          yAxisLabel: contract.compiled.yAxisLabel, title: contract.compiled.title,
        }, question);
        const columns = [...contract.compiled.columns];
        const countProof = finalizeExit({ outcome: recorded ? OUTCOMES.deterministic_plan : OUTCOMES.all_values_null, sql: contract.compiled.sql, rows, columns, derivation: sealPlanDerivation("owned-shr-count", contract.compiled.sql), planFamily: "owned-shr-count", guardrails: [...countTags, ...routeGuardrailsFired], returnedEntities: returnedEntityKeys(rows), narrative: explanation, hasChart: true, db: countDb });
        writeLog(question, contract.compiled.sql, rows.length, null, executionMs, explanation, "shr", [...countTags, ...routeGuardrailsFired], "deterministic", sessionId, serializeChartConfigForLog(chartConfig, columns, { source: "FBI SHR", agencyCount: 0, population: null }), countProof);
        return jsonResp(emitFactualPayload(countProof, attachChartAuditToPayload({
          success: true, question, sql: contract.compiled.sql, explanation,
          title: contract.compiled.title, columns, rows,
          rowCount: rows.length, truncated: false,
          chartConfig,
          chartMeta: { source: "FBI SHR", agencyCount: 0, population: null },
          executionTimeMs: executionMs,
        }, { source: "shr", requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId })));
      } catch (dbErr) {
        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
        const countDbProof = OPERATIONAL_RECORD;
        writeLog(question, contract.compiled.sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", ["owned-shr-count"], "deterministic", sessionId, null, countDbProof);
        return jsonResp({ success: false, error: `Database error: ${msg}` } as QueryError, 500);
      }
    }

    // ── Supported question types: everything else that asks for a number (plan r3.1) ───────────────
    // No model-written statement produces an SHR number; a request that fits no type is declined by name.
    if (shrNumericIntent(requestLedger)) {
      const decision = shrTypeDecision();
      if (!shrTypeDb || !decision) return jsonResp({ success: false, error: "SHR database not available." } as QueryError, 500);
      return answerShrType(decision);
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
        if (!serverAuthoredNoSql && !containsInternalLeak(claude.explanation) && !containsInternalLeak(claude.title)) { const noSqlRefusal = selectNoSqlRefusal(question, "shr"); claude.explanation = noSqlRefusal.explanation; routeGuardrailsFired.push(noSqlRefusal.reason); }
        claude.explanation = neutralizeUnverifiedAvailabilityClaim(claude.explanation, "SHR");
        const noSqlProof = finalizeExit({ outcome: OUTCOMES.model_produced_no_sql, guardrails: routeGuardrailsFired });
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
      const validationProof = OPERATIONAL_RECORD;
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
    let initialContract = runModelAuthoredValidation(shrRewrite.sql);
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
            initialContract = runModelAuthoredValidation(retryValidation.sanitized!);
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
                const retryContract = runModelAuthoredValidation(retryValidation.sanitized!);
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
                  const retryAllowlistProof = finalizeExit({ outcome: OUTCOMES.table_not_allowlisted, sql: retrySql, guardrails: [...tableCheck.fired, ...retryTableCheck.fired], planFamily: "table-allowlist", retries: 1, narrative: msg });
                  writeLog(question, retrySql, 0, `table_allowlist_second_failure:${retryTableCheck.unknown.join(",")}`, Date.now() - start, msg, "shr", [...tableCheck.fired, ...retryTableCheck.fired], "haiku-4.5", sessionId, null, retryAllowlistProof);
                  return jsonResp(emitFactualPayload(retryAllowlistProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
                }
              }
            }
          } catch { /* fall through to friendly failure */ }

          const msg = "I couldn't build a valid query for the SHR database. Try rephrasing for homicide-specific data or switching to a different tab for broader crime totals.";
          const allowlistProof = finalizeExit({ outcome: OUTCOMES.table_not_allowlisted, sql, guardrails: tableCheck.fired, planFamily: "table-allowlist", narrative: msg });
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
      const overrideProof = finalizeExit({ outcome: OUTCOMES.guardrail_block, sql, guardrails: guardrailResult.fired, planFamily: guardrailResult.overrideGuardrail ?? null, narrative: overrideExplanation });
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
            const retryContract = runModelAuthoredValidation(retryValidation.sanitized!);
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
        const postRetryOverrideProof = finalizeExit({ outcome: OUTCOMES.guardrail_block, sql, guardrails: postRetryResult.fired, planFamily: postRetryResult.overrideGuardrail ?? null, narrative: msg });
        writeLog(question, sql, 0, `guardrail_override:${postRetryResult.overrideGuardrail}`, Date.now() - start, msg, "shr", postRetryResult.fired, "haiku-4.5", sessionId, null, postRetryOverrideProof);
        return jsonResp(emitFactualPayload(postRetryOverrideProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
      }
      const rateStillBad = postRetryResult.fired.some(f => f.includes("rate-no-population"));
      if (rateStillBad && /\b(rates?|per\s*capita|per\s*100)/i.test(question) && !asksForCountsInsteadOfRates(question)) {
        const msg = "I wasn't able to calculate a valid per-capita rate for this query. For murder rates, try the [Historical Library](/test?tab=historical) tab which has FBI statewide estimates.";
        const rateFailureProof = finalizeExit({ outcome: OUTCOMES.rate_denominator_unavailable, sql, guardrails: postRetryResult.fired, planFamily: "rate-no-population", narrative: msg });
        writeLog(question, sql, 0, "rate_second_failure", Date.now() - start, msg, "shr", postRetryResult.fired, "haiku-4.5", sessionId, null, rateFailureProof);
        return jsonResp(emitFactualPayload(rateFailureProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
      }
      const orPrecedenceStillBad = postRetryResult.fired.includes("or-and-precedence");
      if (orPrecedenceStillBad) {
        const msg = "I couldn't build a reliable multi-place query after correcting the SQL structure. Try asking for fewer places or restating the comparison.";
        const orPrecedenceProof = finalizeExit({ outcome: OUTCOMES.sql_shape_rejected, sql, guardrails: postRetryResult.fired, planFamily: "or-and-precedence", narrative: msg });
        writeLog(question, sql, 0, "or_precedence_second_failure", Date.now() - start, msg, "shr", postRetryResult.fired, "haiku-4.5", sessionId, null, orPrecedenceProof);
        return jsonResp(emitFactualPayload(orPrecedenceProof, { success: true, question, sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - start }));
      }
      if (postRetryResult.sql !== sql) sql = postRetryResult.sql;
      const postRetryContract = runModelAuthoredValidation(sql);
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
    let classScopes: ClassScope[] | null = null;
    try {
      const executionContract = runModelAuthoredValidation(sql);
      sql = executionContract.sql;
      classScopes = executionContract.agencyTypeScopes ?? null;
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
        // The schema check REWRITES the statement, so everything proved a moment ago was proved
        // about a different statement. Re-prove the corrected SQL before it runs: a licence
        // established on text that is not the text executed is not a licence.
        const correctedContract = runModelAuthoredValidation(sql);
        const correctedFailure = contractFailureResponse(
          correctedContract,
          `contract_schema_corrected_failure:${correctedContract.enforced.join(",")}`,
        );
        if (correctedFailure) return correctedFailure;
        sql = correctedContract.sql;
        classScopes = correctedContract.agencyTypeScopes ?? null;
      }
      // Request accounting (stage 1, task 5): the FINAL statement -- after the cache, every retry and the
      // schema correction have settled `sql` -- must apply each recognized part of the request, on
      // AST evidence from the rowset it returns. Otherwise it does not run (no retry).
      // Request accounting (plan r2.1): no model-written statement produces an SHR number. A request that reaches
      // here asked for no number the request plan recognizes, so the model's statement is not run.
      if (SHR_MODEL_SQL_NEVER_RUNS) return accountingExit({ parts: [], explanation: "I can answer Homicide Reports questions with counts, shares, rankings or victim ages for a place and period. I couldn't find a number like that in this question, so I haven't run one." }, "model-sql");
      rows = db.prepare(sql).all() as Record<string, unknown>[];
      rows = normalizeShrDisplayRows(rows);
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      const dbErrorProof = OPERATIONAL_RECORD;
      writeLog(question, sql, 0, `DB: ${msg}`, Date.now() - start, null, "shr", [], "haiku-4.5", sessionId, null, dbErrorProof);
      return jsonResp(
        { success: false, error: `Database error: ${msg}`, sql } as QueryError,
        500
      );
    }

    const executionMs = Date.now() - start;
    // Agencies the City/County-dependent statement could not classify, within its own year/state scope.
    const classUnresolved = classScopes ? unresolvedInScopes(db, classScopes) : null;
    if (classScopes && classUnresolved && classUnresolved.agencies > 0 && isZeroResult(rows, rows.length > 0 ? Object.keys(rows[0]) : [])) {
      const limitation = unresolvedLimitation(classUnresolved, classScopes);
      const limitationGuardrails = [...new Set([...guardrailResult.fired, ...routeGuardrailsFired, SHR_AGENCY_TYPE_GUARDRAIL])];
      const limitationProof = finalizeExit({ outcome: OUTCOMES.reporting_coverage_insufficient, sql, guardrails: limitationGuardrails, narrative: limitation, db });
      writeLog(question, sql, 0, "shr_agency_type_unresolved", executionMs, limitation, "shr", limitationGuardrails, "haiku-4.5", sessionId, null, limitationProof);
      return jsonResp(emitFactualPayload(limitationProof, {
        success: true, question, sql, explanation: limitation, title: "", columns: [], rows: [], rowCount: 0, truncated: false,
        chartConfig: null, chartMeta: null, executionTimeMs: executionMs,
      }));
    }
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
      // F3 (Decision 13): govern the empty narrative before it is finalized or sent.
      explanation = governFactualNarrative(explanation, genericResultState({ sql, rows }));
      explanation = withShrScopeAndMeasureDisclosures(explanation, shrCountyScope, shrRequestedMeasure(guardrailQuestion) === "homicide");
      const emptyProof = finalizeExit({ outcome: OUTCOMES.no_rows_in_source, sql, guardrails, narrative: explanation, db });
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
        const emptyMsg = governFactualNarrative(
          "I ran that query but all the values came back empty — the math likely broke somewhere (like dividing by zero). Could you try asking that a different way?",
          genericResultState({ sql, rows }));
        const allNullProof = finalizeExit({ outcome: OUTCOMES.all_values_null, sql, guardrails: guardrailResult.fired, narrative: emptyMsg, db });
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
    const claudeExplanationAsWritten = claude.explanation || "";
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
    explanation = applyResultDisclosures({ explanation, question, sql, rows, tab: "shr", comparisonLabels, resultState: genericResultState({ sql, rows }) });
    if (missingLowerBoundNote(question, sql, rows)) routeGuardrailsFired.push("lower-bound-disclosed");
    const grainCheck = validateGrain(question, rows, sql);
    if (!grainCheck.ok && grainCheck.message) {
      explanation = grainCheck.message;
      routeGuardrailsFired.push("grain-mismatch");
    }
    explanation = normalizeShrAgencyText(explanation);

    // Sanitize any leaked SQL/JSON
    explanation = sanitizeExplanation(explanation);
    // GC-080: the application states which agency was queried and which victims counted, last,
    // after the agency-name tidying above could shorten "Sheriff's Office" away.
    const allHomicides = shrRequestedMeasure(guardrailQuestion) === "homicide";
    explanation = withShrScopeAndMeasureDisclosures(explanation, shrCountyScope, allHomicides);
    if (classScopes && classUnresolved && classUnresolved.agencies > 0) {
      explanation = `${explanation}\n\n${unresolvedDisclosure(classUnresolved, classScopes)}`;
      routeGuardrailsFired.push(SHR_AGENCY_TYPE_GUARDRAIL);
    }
    if (allHomicides) claude.title = allHomicideTitle(claude.title);

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
    // Request accounting (stage 1, task 6): the model's own title and explanation must not name a year
    // or a state the executed statement did not use -- the description has to match the number.
    // The main model path. Model-authored, so no derivation is sealed and the answer
    // cannot satisfy the contract -- recorded honestly rather than softened.
    const finalization = finalizeExit({
      outcome: OUTCOMES.model_sql_validated,
      sql,
      rows,
      columns,
      truncated: rows.length >= 1000,
      guardrails: finalizeGuardrailTags([...guardrailResult.fired, ...routeGuardrailsFired], queryContractGuardrails(runModelAuthoredValidation(sql))),
      returnedEntities: returnedEntityKeys(rows),
      narrative: explanation,
      hasChart: Boolean(chartConfig),
      chartFromBindings: false,
      db,
    });
    writeLog(question, sql, rows.length, null, totalMs, explanation, "shr", finalizeGuardrailTags([...guardrailResult.fired, ...routeGuardrailsFired], queryContractGuardrails(runModelAuthoredValidation(sql))), "haiku-4.5", sessionId, serializeChartConfigForLog(chartConfig, columns, { source: "FBI SHR", agencyCount: 0, population: null }), finalization);

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
    // OPERATIONAL ROW (P2.1 §4.3.2 X10 condition 2). Before P2.2 this catch logged nothing, so the
    // four routes recorded the same class of event three different ways and the operational
    // failure rate was unmeasurable. It writes `record_kind='operational'` and no decision: an
    // error before a decision exists is not a product decision, and fabricating one here is
    // exactly what the 16 sites that used to claim `decline_capability` were doing.
    //
    // The route-local closures are declared inside this try, so the module logger is called
    // directly — the same shape the source-switch exits already use. The write is inside the
    // logger's own swallow-on-failure boundary, so it cannot turn a 500 into anything worse.
    logQuery("", null, 0, msg.slice(0, 500), Date.now() - outerStart, null, "shr", [], null, null,
      null, null, null, null, proofLogFields(null), outcomeLogFields(OPERATIONAL_RECORD));
    return jsonResp(
      { success: false, error: "An error occurred. Please try again." } as QueryError,
      500
    );
  }
}
