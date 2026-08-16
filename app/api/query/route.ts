import { NextRequest } from "next/server";
import { getDb, logQuery } from "@/lib/rtci-db";
import { validatePageToken } from "@/lib/page-token";
import { translateToSql, getHistoricalSystemPrompt } from "@/lib/claude";
import { validateAndSanitize } from "@/lib/sql-safety";
import { validateSqlSchema } from "@/lib/schema-validation";
import { executeWithTimeoutSync } from "@/lib/query-timeout";
import { buildChartConfig } from "@/lib/chart-config";
import { serializeChartConfigForLog } from "@/lib/chart-config-log";
import { attachChartAuditToPayload, createChartAuditRequestId } from "@/lib/chart-audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { checkSessionLimit, maybeCleanup } from "@/lib/captcha";
import { HISTORICAL, RTCI } from "@/lib/dynamic-facts";
import { generateExplanation, sanitizeExplanation } from "@/lib/explain";
import { extractQueryContext } from "@/lib/query-context";
import { runGuardrails } from "@/lib/guardrails";
import { finalizeGuardrailTags, mergeGuardrailTags } from "@/lib/guardrail-tag-state";
import { asksForCountsInsteadOfRates } from "@/lib/rate-intent";
import { applyRetryMeta } from "@/lib/types";
import type { StreamEvent, ChartMeta } from "@/lib/types";
import { getCached, setCache } from "@/lib/response-cache";
import { detectAllNullData } from "@/lib/all-null-detection";
import { checkSingleRowTrend } from "@/lib/single-row-trend";
import { parseRoutingLogMeta } from "@/lib/routing-log-meta";
import { answerMetadataQuestion } from "@/lib/metadata-coverage";
import { validateTablesForTab } from "@/lib/table-allowlist";
import { alignTitleYearRange, applyResultDisclosures, missingLowerBoundNote, returnedEntityKeys, trimTrailingEmptyYearRows } from "@/lib/result-disclosure";
import { validateGrain } from "@/lib/requested-grain";
import { normalizeHistoryAllSources, normalizeHistoryForTab } from "@/lib/chat-history";
import { applyGeoCorrection, geoCorrectionHint } from "@/lib/geo-correction";
import { containsInternalLeak, INTERNAL_LEAK_SAFE_MESSAGE, sanitizeUserFacingNarrative, sanitizeChartConfigTitle} from "@/lib/scaffold-helpers";
import { buildNoSqlFallbackMessage } from "@/lib/refusal-safety";
import { boundedModelResponseJson } from "@/lib/no-sql-retry";
import { buildCompletenessAnswer, detectCompletenessQuestion, loadCompletenessRows } from "@/lib/completeness-intent";
import { detectFollowupTransform } from "@/lib/followup-transform";
import { getBlockingGeoClarification } from "@/lib/geo-resolver";
import { getCountyScopeClarification } from "@/lib/county-clarifier";
import { detectCurrentYearClearanceOverride, detectDemographicRateDenominatorFollowup, detectDemographicHomicideRateOverride, detectSubCityGeographyOverride } from "@/lib/capability-overrides";
import { historicalYearAvailability } from "@/lib/year-availability";
import { reliabilityDisclosureNote } from "@/lib/reliability-disclosure";
import {
  queryContractFailureMessage,
  queryContractGuardrails,
  validateQueryContractSql,
  type QueryContractSqlValidation,
} from "@/lib/query-contract-validator";
import { partialCoverageRetryPrompt } from "@/lib/source-year-overlap";
import { resolveGeoPlaces } from "@/lib/geo-place-resolver";
import { isFollowUp } from "@/lib/tab-suggest";
import { buildHistoricalCityChangeRankingPlan, buildHistoricalLocalRecentChangePlan } from "@/lib/historical-deterministic-queries";
import { buildMultiCityTrendPlan } from "@/lib/multi-city-deterministic";
import { buildCurrentIndexedStatePlan } from "@/lib/current-indexed-state-deterministic";
import { detectQueryBearingFollowup } from '@/lib/query-bearing-followup';
import { planFollowupSafe } from '@/lib/followup-planner';
import { buildCrossSourceFollowupTransform } from '@/lib/cross-source-followup';
import { plannerModeForSource } from '@/lib/followup-planner-mode';
import { findVerifiedCurrentAgency } from '@/lib/current-agency-availability';
import { explainEmptyCurrentTrendsResult } from "@/lib/current-trends-empty-reason";
import { neutralizeUnverifiedAvailabilityClaim } from "@/lib/refusal-safety";
import { implausiblePopulationDenominator } from "@/lib/rate-denominator-safety";
import { buildHistoricalScorecard } from "@/lib/historical-scorecard";
import {
  consolidatedDisplayText,
  consolidationTargetSatisfied,
  findConsolidatedAgency,
  normalizeConsolidatedDisplayRows,
} from "@/lib/agency-consolidations";
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
import type { DeliveryAction, SourceId } from "@/lib/proof-contract";

/**
 * Events that assert no facts: status pings and error notices. These need no proof.
 *
 * The background `explanation` update is NOT among them, though an earlier revision
 * classified it as non-factual. It REPLACES the narrative the user reads about the
 * numbers -- and it is not a cosmetic rewrite: applyResultDisclosures() can add scope
 * corrections, and a failed grain check discards the text entirely and substitutes its
 * own message. Text that can restate what the data means is factual content, so it
 * passes through the same gate as the result event.
 */
type NonFactualStreamEvent = Exclude<StreamEvent, { type: "result" } | { type: "explanation" }>;
/** Factual events. Only a sealed payload is accepted. */
type FactualStreamEvent = Extract<StreamEvent, { type: "result" } | { type: "explanation" }>;

/**
 * THE CHOKEPOINT. A `result` event is accepted only as a SealedPayload, which
 * lib/proof-finalize's emitFactualPayload() alone can produce. An exit that builds
 * a factual event without finalizing does not compile.
 *
 * Requiring emitFactualPayload() to be CALLED was not sufficient on its own: a
 * route could finalize and then hand a raw object literal to this function,
 * discarding the finalization. Narrowing the parameter here is what closes it.
 */
function sseEvent(event: NonFactualStreamEvent | SealedPayload<FactualStreamEvent>): string {
  const payload = { ...event } as Record<string, unknown>;
  if (typeof payload.explanation === "string" || typeof payload.title === "string") {
    const safe = sanitizeUserFacingNarrative(payload.explanation as string | undefined, payload.title as string | undefined);
    payload.explanation = safe.explanation ? consolidatedDisplayText(safe.explanation) : safe.explanation;
    payload.title = safe.title ? consolidatedDisplayText(safe.title) : safe.title;
  }
  if (Array.isArray(payload.rows)) payload.rows = normalizeConsolidatedDisplayRows(payload.rows as Record<string, unknown>[]);
  // ChartPanel renders chartConfig.title, which the sanitization above never
  // touched -- a leaking title was blanked in the header while the chart still
  // showed it. Applied here so every response path is covered.
  if (payload.chartConfig) {
    payload.chartConfig = sanitizeChartConfigTitle(payload.chartConfig);
    const chart = payload.chartConfig as Record<string, unknown>;
    if (typeof chart.title === "string") chart.title = consolidatedDisplayText(chart.title);
  }
  if (payload.type === "explanation" && typeof payload.text === "string") {
    const safeText = sanitizeUserFacingNarrative(payload.text, undefined).explanation;
    payload.text = safeText ? consolidatedDisplayText(safeText) : safeText;
  }
  const chartAuditSource = payload.chartAuditSource;
  delete payload.chartAuditSource;
  const finalized = payload.requestId && (chartAuditSource === "current" || chartAuditSource === "historical")
    ? attachChartAuditToPayload(payload, { source: chartAuditSource, requestId: String(payload.requestId) })
    : payload;
  return `data: ${JSON.stringify(finalized)}\n\n`;
}
import {
  containsInternalScaffold,
  stripInternalScaffold,
} from "@/lib/scaffold-helpers";

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

    // National queries — use the agency count and population for the latest
    // month actually present in the source, not the query display start year.
    if (sqlLower.includes("national_monthly")) {
      const row = db
        .prepare(
          `SELECT agency_count as cnt, year, month FROM national_monthly
           WHERE offense = 'Murder'
           ORDER BY year DESC, month DESC
           LIMIT 1`
        )
        .get() as { cnt: number; year: number; month: number } | undefined;
      const latestPopulationYear = Math.min(
        Math.max(row?.year ?? RTCI.maxYear, RTCI.popMinYear),
        RTCI.popMaxYear,
      );
      const popRow = db
        .prepare(
          `SELECT SUM(population) as pop FROM (
             SELECT DISTINCT am.ori, p.population
             FROM agency_monthly am
             JOIN agency_population p ON p.ori = am.ori AND p.year = ?
             WHERE am.year = ? AND am.month = ?
           )`
        )
        .get(latestPopulationYear, row?.year ?? RTCI.maxYear, row?.month ?? 12) as { pop: number | null } | undefined;
      return { agencyCount: row?.cnt ?? 0, population: popRow?.pop ?? null };
    }

    // State queries — count only complete reporters (national_sample = 1)
    const stateMatch = sql.match(/(?:a\.)?state\s*=\s*'([A-Z]{2})'/i);
    const isStateLevelQuery = stateMatch && (
      sqlLower.includes("state_monthly") ||
      (sqlLower.includes("national_sample") && !sqlLower.includes("agency ="))
    );
    if (isStateLevelQuery && stateMatch) {
      const st = stateMatch[1].toUpperCase();
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT a.ori) as cnt, SUM(p.population) as pop
           FROM agencies a
           LEFT JOIN agency_population p ON p.ori = a.ori AND p.year = ?
           WHERE a.state = ? AND a.national_sample = 1`
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
        // Detect if the query filters by type (City/County) and mirror it in the meta query
        const typeMatch = sql.match(/type\s*=\s*'(City|County)'/i);
        const typeFilter = typeMatch ? `AND a.type = '${typeMatch[1]}'` : "";
        const placeholders = agencies.map(() => "a.agency = ?").join(" OR ");
        const params: (string | number)[] = [popYear, ...agencies];
        const row = db
          .prepare(
            `SELECT COUNT(DISTINCT a.ori) as cnt, SUM(p.population) as pop
             FROM agencies a
             LEFT JOIN agency_population p ON p.ori = a.ori AND p.year = ?
             WHERE (${placeholders}) ${typeFilter}`
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

    const src = "FBI SRS";

    // National queries (state = 'United States')
    if (sqlLower.includes("'united states'")) {
      return { agencyCount: 0, population: null, source: src };
    }

    // State-level queries from historical_state_national
    if (sqlLower.includes("historical_state_national")) {
      return { agencyCount: 0, population: null, source: src };
    }

    // Staffing queries are Historical Library / FBI SRS too.
    if (sqlLower.includes("historical_staffing")) {
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
      // If no specific agency names matched (e.g., state-wide query), show 0 (omits agency count)
      return { agencyCount: agencies.length, population: null, source: src };
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
  historical = false,
  state?: string | null
): { agency: string; state: string }[] {
  try {
    const table = historical ? "historical_agency" : "agencies";
    const stateFilter = state ? " AND UPPER(state) = ?" : "";
    const params = state ? [`%${name}%`, state.toUpperCase()] : [`%${name}%`];
    return db
      .prepare(
        `SELECT DISTINCT agency, state FROM ${table} WHERE agency LIKE ?${stateFilter} LIMIT 5`
      )
      .all(...params) as { agency: string; state: string }[];
  } catch {
    return [];
  }
}

function displayStateCode(state: string, historical = false): string {
  const upper = state.toUpperCase();
  if (historical && upper === "NB") return "NE";
  if (historical && upper === "GM") return "GU";
  return upper;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function historicalSourceState(state: string): string {
  const upper = state.toUpperCase();
  if (upper === "NE") return "nb";
  if (upper === "GU") return "gm";
  return upper;
}

function hasHistoricalMetricIntent(question: string): boolean {
  return /\b(?:crimes?|violent|property|murders?|homicides?|rapes?|robber(?:y|ies)|assaults?|burglar(?:y|ies)|thefts?|larcen(?:y|ies)|auto|motor vehicle|clearance|cleared|rates?|staffing|officers?|police force|trends?|by year|per year|monthly|compare|vs\.?|versus|population)\b/i.test(question);
}

function isSameResultFollowup(question: string, rawHistory?: unknown): boolean {
  const hasHistory = Array.isArray(rawHistory) && rawHistory.length > 0;
  if (!hasHistory) return false;
  return /\b(?:same|previous|prior|last)\b/i.test(question) &&
    /\b(?:chart|table|data|query|result|results)\b/i.test(question);
}

function shouldSkipHistoricalPlaceLookup(question: string, rawHistory?: unknown): boolean {
  const hasHistory = Array.isArray(rawHistory) && rawHistory.length > 0;
  return isSameResultFollowup(question, rawHistory) || (hasHistory && isFollowUp(question));
}

function answerHistoricalPlaceLookup(
  question: string,
  db: ReturnType<typeof getDb>
): {
  sql: string;
  rows: Record<string, unknown>[];
  columns: string[];
  explanation: string;
  title: string;
} | null {
  if (hasHistoricalMetricIntent(question)) return null;
  const resolution = resolveGeoPlaces(question);
  const first = resolution.mentions[0];
  const candidate = first?.candidates[0];
  if (!candidate?.state || first.requiresClarification) return null;
  if (candidate.kind !== "city" && candidate.kind !== "county") return null;

  const sourceState = historicalSourceState(candidate.state);
  const consolidation = findConsolidatedAgency(candidate.state, candidate.name);
  const type = consolidation?.historicalType ?? candidate.kind;
  const agency = consolidation?.historicalAgency ?? candidate.name;
  const displayName = consolidation?.alias ?? candidate.name;
  const sql = `
    SELECT
      ${sqlQuote(displayName)} AS agency,
      '${candidate.state.toUpperCase()}' AS state,
      ha.type,
      (SELECT MIN(hc.year) || '-' || MAX(hc.year) FROM historical_agency_crime hc WHERE hc.ori = ha.ori) AS crime_years,
      (SELECT MIN(hclr.year) || '-' || MAX(hclr.year) FROM historical_agency_clearance hclr WHERE hclr.ori = ha.ori) AS clearance_years,
      (SELECT MIN(hs.year) || '-' || MAX(hs.year) FROM historical_staffing hs WHERE hs.ori = ha.ori) AS staffing_years
    FROM historical_agency ha
    WHERE UPPER(ha.state) = UPPER(${sqlQuote(sourceState)})
      ${consolidation
        ? `AND ha.ori = ${sqlQuote(consolidation.historicalOri)}`
        : `AND LOWER(ha.type) = ${sqlQuote(type)}\n      AND UPPER(ha.agency) = UPPER(${sqlQuote(agency)})`}
    ORDER BY ha.agency
    LIMIT 20
  `.trim();

  try {
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    if (rows.length === 0) return null;
    return {
      sql,
      rows: normalizeConsolidatedDisplayRows(rows),
      columns: ["agency", "state", "type", "crime_years", "clearance_years", "staffing_years"],
      title: `${displayName}, ${candidate.state.toUpperCase()}`,
      explanation: `Historical Library agency coverage for ${displayName}, ${candidate.state.toUpperCase()}. Ask for a specific metric to chart counts, rates, staffing, or clearances over time.`,
    };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const totalStart = Date.now();
  const MAX_REQUEST_MS = 60000; // 60s total budget — no retries after this
  const isOverBudget = () => Date.now() - totalStart > MAX_REQUEST_MS;

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
  let sessionId: string | null = null;
  let body: Record<string, unknown>;
  const chartAuditRequestId = createChartAuditRequestId();
  let chartAuditQueryLogId: number | null = null;

  try {
    body = await req.json();
    question = (body?.question as string)?.trim() || "";
    sessionId = ((body?.sessionId as string) || "").slice(0, 64) || null;
    // Page token validation — block bots that hit the API directly
    const pageToken = body?.pageToken as string | undefined;
    if (!validatePageToken(pageToken)) {
      return new Response(
        JSON.stringify({ success: false, error: "Please refresh the page and try again." }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Session-based CAPTCHA throttle
    maybeCleanup();
    const captchaCheck = checkSessionLimit(sessionId);
    if (!captchaCheck.allowed) {
      if (captchaCheck.dailyLimitReached) {
        return new Response(
          JSON.stringify({ success: false, error: "You've reached the daily query limit. Please come back tomorrow." }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ success: false, captchaRequired: true }),
        { status: 202, headers: { "Content-Type": "application/json" } }
      );
    }
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

  const routingMeta = parseRoutingLogMeta(body);
  const writeLog = (
    q: string,
    sqlText: string | null,
    rowCount: number,
    logError: string | null,
    ms: number,
    logResponse: string | null = null,
    tabName: string = "current",
    guardrails: string[] = [],
    model: string | null = null,
    sid: string | null = null,
    /**
     * Phase 3 chart capture. Pre-serialized through the allowlist in
     * lib/chart-config-log so this logger cannot widen what gets stored, and so a
     * failure to serialize degrades to null rather than losing the whole log row.
     */
    chartConfigJson: string | null = null,
    /**
     * Proof finalization for this exit, when one ran.
     *
     * Null yields all-NULL proof columns, i.e. exactly the row the baseline
     * release writes. So an exit that has not yet been instrumented logs as it
     * always did rather than logging something misleading.
     */
    proof: ProofFinalization | null = null,
    /** Bounded raw model text on no-SQL failures; diagnostic only, never user-visible. */
    modelResponseJson: string | null = null
  ) => {
    chartAuditQueryLogId = logQuery(q, sqlText, rowCount, logError, ms, logResponse, tabName, guardrails, model, sid, routingMeta, chartConfigJson, chartAuditRequestId, modelResponseJson, proofLogFields(proof));
    return chartAuditQueryLogId;
  };

  const tab = body?.mode === "historical" ? "historical" : "current";

  /**
   * Proof finalization for one terminal exit of this route.
   *
   * Every terminal exit calls this before it emits, so the ordering requirement in
   * handoff §13 -- "the first factual Current/Historical SSE event cannot precede
   * proof finalization" -- holds structurally rather than by inspection. In `off`
   * mode (the default, and production today) this is a near-free sentinel; in
   * `shadow` it records what would have happened and returns the payload unchanged.
   *
   * Defaults describe a factless exit: no SQL, no rows, model-authored. A factual
   * exit overrides what it actually has.
   */
  const proofSourceId: SourceId = tab === "historical" ? "historical" : "current";

  /**
   * Validity signature for cached entries: enforcement state plus source data
   * version. A change to either produces a cache miss rather than replaying SQL
   * authored under conditions no longer in force (handoff §4, §13). dataVersion is
   * null until Stage 2 builds the source-health registry.
   */
  const cacheValidity = cacheValiditySignature(proofSourceId, null);

  /**
   * The question the proof layer reasons about: the RECONSTRUCTED one for follow-ups.
   *
   * A bare follow-up fragment ("just clearances by type") names no cities, so deriving
   * requested entities from it yields none and a 32-city comparison silently loses its
   * completeness check. SQL generation already uses the reconstructed question; proof
   * must see the same thing or it is auditing a different request than the one that
   * ran. Updated in place as the reconstruction becomes available, so every exit picks
   * it up without each one having to remember.
   *
   * query_log keeps the RAW question -- writeLog is passed `question` directly -- so
   * the reviewer still sees what the user actually typed.
   */
  let proofQuestion = question;
  const finalizeExit = (
    opts: Partial<ProofFinalizationInput> & { intendedAction: DeliveryAction },
  ): ProofFinalization =>
    finalizeProof({
      sourceId: proofSourceId,
      question: proofQuestion,
      sql: null,
      rows: [],
      columns: [],
      truncated: false,
      planFamily: null,
      ...opts,
    });
  const demographicRateFollowup = detectDemographicRateDenominatorFollowup(
    question,
    normalizeHistoryAllSources(body?.history),
  );
  // Query-bearing follow-ups (prior SQL + a change request) must reach the
  // model path with history — never the standalone metadata/county/place shortcuts.
  const queryBearingFollowup = detectQueryBearingFollowup(question, body?.history);
    const plannerMode = plannerModeForSource(tab);
    const followupPlan = plannerMode === 'off' ? null : planFollowupSafe(question, body?.history, tab);
    if (followupPlan && plannerMode === 'compare') {
      console.log('[followup-planner][compare] ' + JSON.stringify({ source: tab, kind: followupPlan.kind, changeKinds: followupPlan.changeKinds, plannedSource: followupPlan.source, sourceChanged: followupPlan.sourceChanged, legacyBearing: Boolean(queryBearingFollowup), q: question.slice(0, 160), reconstructed: followupPlan.reconstructedQuestion.slice(0, 200) }));
    }
  if (plannerMode === "authoritative" && followupPlan?.sourceChanged && !demographicRateFollowup) {
    const ms = Date.now() - totalStart;
    const explanation = "This follow-up is a better fit for the " + followupPlan.source + " source. Rerunning it there as: " + followupPlan.reconstructedQuestion;
    // Redirecting to another source asserts no facts, so this is a clarify.
    const proof = finalizeExit({ intendedAction: "clarify", planFamily: "followup-source-switch" });
    writeLog(question, null, 0, null, ms, explanation, tab, ["followup-source-switch"], "followup-planner", sessionId, null, proof);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, {
          type: "result", sql: null as unknown as string, explanation, title: "Source switch", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: ms,
          sourceSwitch: { source: followupPlan.source, question: followupPlan.reconstructedQuestion },
        }))));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  }
    const planSaysQueryBearing = (plannerMode === 'authoritative' && followupPlan) ? followupPlan.kind === 'query_bearing' : Boolean(queryBearingFollowup);
  const capabilityQuestion = followupPlan?.kind === "query_bearing"
    ? followupPlan.reconstructedQuestion
    : question;
  // Follow-up reconstruction is known by this point; every exit below inherits it.
  proofQuestion = capabilityQuestion;
  const capabilityOverride =
    demographicRateFollowup ??
    detectCurrentYearClearanceOverride(capabilityQuestion) ??
    detectSubCityGeographyOverride(question) ??
    detectDemographicHomicideRateOverride(question);
  if (capabilityOverride) {
    const ms = Date.now() - totalStart;
    // A capability override is the product saying it has no supported path. §2.4
    // requires that framing rather than a claim that the source lacks the data.
    const proof = finalizeExit({
      intendedAction: "decline_capability",
      planFamily: capabilityOverride.guardrail,
    });
    writeLog(question, null, 0, null, ms, capabilityOverride.explanation, tab, [capabilityOverride.guardrail], "deterministic", sessionId, null, proof);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent(emitFactualPayload(proof, {
              type: "result",
              sql: null as unknown as string,
              explanation: capabilityOverride.explanation,
              title: capabilityOverride.title,
              columns: [],
              rows: [],
              rowCount: 0,
              truncated: false,
              chartConfig: null,
              chartMeta: null,
              executionTimeMs: ms,
            }))
          )
        );
        controller.close();
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

  const agencyScorecard = tab === "historical" ? buildHistoricalScorecard(getDb(), capabilityQuestion) : null;
  if (agencyScorecard) {
    const ms = Date.now() - totalStart;
    // Scope-prefixed so agency cards keep their historical tag strings ("agency-scorecard-…")
    // and log analyses over them stay valid; state/national get their own partitions.
    const scorecardTag = agencyScorecard.rows.length > 0
      ? `${agencyScorecard.scope}-scorecard-deterministic`
      : `${agencyScorecard.scope}-scorecard-unavailable`;
    // Factual deterministic exit: finalized BEFORE the event is constructed.
    const proof = finalizeExit({
      intendedAction: agencyScorecard.rows.length > 0 ? "answer" : "decline_data",
      sql: agencyScorecard.sql ?? null,
      rows: agencyScorecard.rows,
      columns: agencyScorecard.columns,
      derivation: agencyScorecard.sql
        ? sealPlanDerivation(`${agencyScorecard.scope}-scorecard`, agencyScorecard.sql)
        : null,
      planFamily: `${agencyScorecard.scope}-scorecard`,
      guardrails: [scorecardTag],
      db: getDb(),
    });
    writeLog(question, agencyScorecard.sql ?? "", agencyScorecard.rows.length, null, ms, agencyScorecard.explanation, tab, [scorecardTag], "deterministic", sessionId, null, proof);
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, { type: "result", sql: agencyScorecard.sql ?? "", explanation: agencyScorecard.explanation, title: agencyScorecard.title, columns: agencyScorecard.columns, rows: agencyScorecard.rows, rowCount: agencyScorecard.rows.length, truncated: false, chartConfig: null, chartMeta: { source: "FBI SRS", agencyCount: 1, population: null }, executionTimeMs: ms,
              scorecard: true,
              agencyLabel: agencyScorecard.agencyLabel,
              year: agencyScorecard.year,
              scope: agencyScorecard.scope,
              yearStatus: agencyScorecard.yearStatus,
              statusText: agencyScorecard.statusText,
              newerExcludedYear: agencyScorecard.newerExcludedYear,
              showClearance: agencyScorecard.showClearance,
      }))));
      controller.close();
    }});
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
  }

  const completenessIntent = detectCompletenessQuestion(capabilityQuestion);
  if (completenessIntent && (tab === "current" || tab === "historical")) {
    const source = tab === "historical" ? "historical" : "current";
    const completenessAnswer = buildCompletenessAnswer(source, loadCompletenessRows(source, getDb()), new Date().getFullYear(), completenessIntent.year);
    const ms = Date.now() - totalStart;
    // Factual: it states coverage facts about the source, deterministically derived
    // from the completeness tables even though it returns no result rows.
    const proof = finalizeExit({
      intendedAction: "answer",
      planFamily: "completeness-deterministic",
      guardrails: ["completeness-deterministic"],
    });
    writeLog(question, null, 0, null, ms, completenessAnswer, tab, ["completeness-deterministic"], "deterministic", sessionId, null, proof);
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, { type: "result", sql: null as unknown as string, explanation: completenessAnswer, title: "Data completeness", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: ms }))));
      controller.close();
    }});
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
  }

  const countyScope = (getBlockingGeoClarification(question) || queryBearingFollowup)
    ? null
    : getCountyScopeClarification(question, body?.history);
  if (countyScope) {
    const ms = Date.now() - totalStart;
    const proof = finalizeExit({ intendedAction: "clarify", planFamily: `geo:${countyScope.id}` });
    writeLog(question, null, 0, null, ms, countyScope.explanation, tab, [`geo:${countyScope.id}`], "deterministic", sessionId, null, proof);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent(emitFactualPayload(proof, {
              type: "result",
              sql: null as unknown as string,
              explanation: countyScope.explanation,
              title: "",
              columns: [],
              rows: [],
              rowCount: 0,
              truncated: false,
              chartConfig: null,
              chartMeta: null,
              executionTimeMs: ms,
            }))
          )
        );
        controller.close();
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

  const geoClarification = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? (followupPlan.chartOnly ? null : getBlockingGeoClarification(followupPlan.reconstructedQuestion)) : getBlockingGeoClarification(question);
  if (geoClarification) {
    const ms = Date.now() - totalStart;
    const proof = finalizeExit({ intendedAction: "clarify", planFamily: `geo:${geoClarification.issue.id}` });
    writeLog(question, null, 0, null, ms, geoClarification.explanation, tab, [`geo:${geoClarification.issue.id}`], "deterministic", sessionId, null, proof);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent(emitFactualPayload(proof, {
              type: "result",
              sql: null as unknown as string,
              explanation: geoClarification.explanation,
              title: "",
              columns: [],
              rows: [],
              rowCount: 0,
              truncated: false,
              chartConfig: null,
              chartMeta: null,
              executionTimeMs: ms,
            }))
          )
        );
        controller.close();
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

  const historicalAvailability = tab === "historical" ? historicalYearAvailability(question) : null;
  if (historicalAvailability) {
    const ms = Date.now() - totalStart;
    // decline_data, not decline_capability: historicalYearAvailability() establishes
    // deterministically that the source does not cover the requested year, which is
    // the evidence §2.4 requires before stating a source limitation.
    const proof = finalizeExit({
      intendedAction: "decline_data",
      planFamily: "historical-year-unavailable",
    });
    writeLog(question, null, 0, null, ms, historicalAvailability.explanation, tab, ["historical-year-unavailable"], "deterministic", sessionId, null, proof);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent(emitFactualPayload(proof, {
              type: "result",
              sql: null as unknown as string,
              explanation: historicalAvailability.explanation,
              title: "Year not available in Historical",
              columns: [],
              rows: [],
              rowCount: 0,
              truncated: false,
              chartConfig: null,
              chartMeta: null,
              executionTimeMs: ms,
            }))
          )
        );
        controller.close();
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

  const indexedStatePlan = tab === "current"
    ? buildCurrentIndexedStatePlan(question, body?.history)
    : null;
  if (indexedStatePlan) {
    try {
      const db = getDb();
      const rows = executeWithTimeoutSync<Record<string, unknown>>(db, db.prepare(indexedStatePlan.sql), 30000);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : indexedStatePlan.columns;
      const ms = Date.now() - totalStart;
      const proof = finalizeExit({
        intendedAction: rows.length > 0 ? "answer" : "decline_data",
        sql: indexedStatePlan.sql,
        rows,
        columns,
        derivation: sealPlanDerivation(indexedStatePlan.guardrail, indexedStatePlan.sql),
        planFamily: indexedStatePlan.guardrail,
        guardrails: [indexedStatePlan.guardrail],
        hasChart: rows.length > 0 && Boolean(indexedStatePlan.chartConfig),
        db,
      });
      // Deterministic answers render charts too; same capture as the model path.
      writeLog(question, indexedStatePlan.sql, rows.length, null, ms, indexedStatePlan.explanation, tab, [indexedStatePlan.guardrail], "deterministic", sessionId, serializeChartConfigForLog(rows.length > 0 ? indexedStatePlan.chartConfig : null, columns, indexedStatePlan.chartMeta), proof);
      attachChartAuditToPayload({ chartConfig: rows.length > 0 ? indexedStatePlan.chartConfig : null, columns, rows }, { source: tab, requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, {
            type: "result",
            requestId: chartAuditRequestId,
            chartAuditSource: tab,
            sql: indexedStatePlan.sql,
            explanation: indexedStatePlan.explanation,
            title: indexedStatePlan.title,
            columns,
            rows,
            rowCount: rows.length,
            truncated: false,
            chartConfig: rows.length > 0 ? indexedStatePlan.chartConfig : null,
            chartMeta: indexedStatePlan.chartMeta,
            executionTimeMs: ms,
          }))));
          controller.close();
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
    } catch (err) {
      console.warn("[current-indexed-state] deterministic query failed; falling back to Claude", err);
    }
  }

  const multiCityTrend = !planSaysQueryBearing && (tab === "current" || tab === "historical")
    ? buildMultiCityTrendPlan(question, tab)
    : null;
  if (multiCityTrend) {
    try {
      const db = getDb();
      const rows = executeWithTimeoutSync<Record<string, unknown>>(db, db.prepare(multiCityTrend.sql), 30000);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : multiCityTrend.columns;
      const ms = Date.now() - totalStart;
      // Multi-city comparison is the family that produced the 31-of-32 failure, so
      // it supplies requested/returned entity sets to the completeness check. The
      // plan pivots cities into columns, so a city "came back" only if its column
      // exists AND carries at least one non-null value -- an all-null column is the
      // exact shape of the silent drop.
      const proof = finalizeExit({
        intendedAction: rows.length > 0 ? "answer" : "decline_data",
        sql: multiCityTrend.sql,
        rows,
        columns,
        derivation: sealPlanDerivation(multiCityTrend.guardrail, multiCityTrend.sql),
        planFamily: multiCityTrend.guardrail,
        guardrails: [multiCityTrend.guardrail],
        requestedEntities: multiCityTrend.requestedCities.map((city) => city.label),
        returnedEntities: multiCityTrend.requestedCities
          .filter((city) => rows.some((row) => row[city.alias] !== null && row[city.alias] !== undefined))
          .map((city) => city.label),
        hasChart: rows.length > 0 && Boolean(multiCityTrend.chartConfig),
        db,
      });
      writeLog(
        question,
        multiCityTrend.sql,
        rows.length,
        null,
        ms,
        multiCityTrend.explanation,
        tab,
        [multiCityTrend.guardrail],
        "deterministic",
        sessionId,
        // Deterministic answers render charts too; same capture as the model path.
        serializeChartConfigForLog(rows.length > 0 ? multiCityTrend.chartConfig : null, columns, multiCityTrend.chartMeta),
        proof
      );
      attachChartAuditToPayload({ chartConfig: rows.length > 0 ? multiCityTrend.chartConfig : null, columns, rows }, { source: tab, requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              sseEvent(emitFactualPayload(proof, {
                type: "result",
                requestId: chartAuditRequestId,
                chartAuditSource: tab,
                sql: multiCityTrend.sql,
                explanation: multiCityTrend.explanation,
                title: multiCityTrend.title,
                columns,
                rows,
                rowCount: rows.length,
                truncated: false,
                chartConfig: rows.length > 0 ? multiCityTrend.chartConfig : null,
                chartMeta: multiCityTrend.chartMeta,
                executionTimeMs: ms,
              }))
            )
          );
          controller.close();
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
    } catch (err) {
      console.warn("[multi-city-trend] deterministic query failed; falling back to Claude", err);
    }
  }

  const historicalCityChange = tab === "historical"
    ? buildHistoricalLocalRecentChangePlan(question, HISTORICAL.crimeMaxYear) ?? buildHistoricalCityChangeRankingPlan(question, body?.history)
    : null;
  if (historicalCityChange) {
    const ms = Date.now() - totalStart;
    if (!historicalCityChange.sql) {
      // The planner produced no query, so there is no supported path for this
      // request -- a capability limitation, not a statement about the data.
      const proof = finalizeExit({
        intendedAction: "decline_capability",
        planFamily: historicalCityChange.guardrail,
        guardrails: [historicalCityChange.guardrail],
      });
      writeLog(question, null, 0, null, ms, historicalCityChange.explanation, tab, [historicalCityChange.guardrail], "deterministic", sessionId, null, proof);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              sseEvent(emitFactualPayload(proof, {
                type: "result",
                sql: null as unknown as string,
                explanation: historicalCityChange.explanation,
                title: historicalCityChange.title,
                columns: historicalCityChange.columns,
                rows: [],
                rowCount: 0,
                truncated: false,
                chartConfig: historicalCityChange.chartConfig,
                chartMeta: historicalCityChange.chartMeta,
                executionTimeMs: ms,
              }))
            )
          );
          controller.close();
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

    try {
      const db = getDb();
      const rows = executeWithTimeoutSync<Record<string, unknown>>(db, db.prepare(historicalCityChange.sql), 30000);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : historicalCityChange.columns;
      const proof = finalizeExit({
        intendedAction: rows.length > 0 ? "answer" : "decline_data",
        sql: historicalCityChange.sql,
        rows,
        columns,
        derivation: historicalCityChange.sql
          ? sealPlanDerivation(historicalCityChange.guardrail, historicalCityChange.sql)
          : null,
        planFamily: historicalCityChange.guardrail,
        guardrails: [historicalCityChange.guardrail],
        hasChart: rows.length > 0 && Boolean(historicalCityChange.chartConfig),
        db,
      });
      // Deterministic answers render charts too; same capture as the model path.
      writeLog(question, historicalCityChange.sql, rows.length, null, ms, historicalCityChange.explanation, tab, [historicalCityChange.guardrail], "deterministic", sessionId, serializeChartConfigForLog(rows.length > 0 ? historicalCityChange.chartConfig : null, columns, historicalCityChange.chartMeta), proof);
      attachChartAuditToPayload({ chartConfig: rows.length > 0 ? historicalCityChange.chartConfig : null, columns, rows }, { source: tab, requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              sseEvent(emitFactualPayload(proof, {
                type: "result",
                requestId: chartAuditRequestId,
                chartAuditSource: tab,
                sql: historicalCityChange.sql!,
                explanation: historicalCityChange.explanation,
                title: historicalCityChange.title,
                columns,
                rows,
                rowCount: rows.length,
                truncated: false,
                chartConfig: rows.length > 0 ? historicalCityChange.chartConfig : null,
                chartMeta: historicalCityChange.chartMeta,
                executionTimeMs: Date.now() - totalStart,
              }))
            )
          );
          controller.close();
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
    } catch (err) {
      console.warn("[historical-city-change-ranking] deterministic query failed; falling back to Claude", err);
    }
  }
  const historicalPlace = tab === "historical" && !queryBearingFollowup && !shouldSkipHistoricalPlaceLookup(question, body?.history)
    ? answerHistoricalPlaceLookup(question, getDb())
    : null;
  if (historicalPlace) {
    const ms = Date.now() - totalStart;
    const proof = finalizeExit({
      intendedAction: "answer",
      sql: historicalPlace.sql,
      rows: historicalPlace.rows,
      columns: historicalPlace.columns,
      derivation: sealPlanDerivation("deterministic-place-lookup", historicalPlace.sql),
      planFamily: "deterministic-place-lookup",
      guardrails: ["deterministic-place-lookup"],
      db: getDb(),
    });
    writeLog(question, historicalPlace.sql, historicalPlace.rows.length, null, ms, historicalPlace.explanation, tab, ["deterministic-place-lookup"], "deterministic", sessionId, null, proof);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent(emitFactualPayload(proof, {
              type: "result",
              sql: historicalPlace.sql,
              explanation: historicalPlace.explanation,
              title: historicalPlace.title,
              columns: historicalPlace.columns,
              rows: historicalPlace.rows,
              rowCount: historicalPlace.rows.length,
              truncated: false,
              chartConfig: null,
              chartMeta: null,
              executionTimeMs: ms,
            }))
          )
        );
        controller.close();
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

  const metadata = planSaysQueryBearing ? null : answerMetadataQuestion(tab, question, getDb());
  if (metadata) {
    const ms = Date.now() - totalStart;
    const proof = finalizeExit({
      intendedAction: "answer",
      sql: metadata.sql,
      rows: metadata.rows ?? [],
      columns: metadata.columns ?? [],
      truncated: Boolean(metadata.truncated),
      derivation: metadata.sql ? sealPlanDerivation("metadata-coverage-answer", metadata.sql) : null,
      planFamily: "metadata-coverage-answer",
      guardrails: ["deterministic-metadata", "metadata-coverage-answer"],
      hasChart: Boolean(metadata.chartConfig),
      db: getDb(),
    });
    // Deterministic answers render charts too; same capture as the model path.
    writeLog(question, metadata.sql, metadata.rowCount, null, ms, metadata.explanation, tab, ["deterministic-metadata", "metadata-coverage-answer"], "deterministic", sessionId, serializeChartConfigForLog(metadata.chartConfig, metadata.columns ?? [], metadata.chartMeta), proof);
    attachChartAuditToPayload({ chartConfig: metadata.chartConfig, columns: metadata.columns ?? [], rows: metadata.rows ?? [] }, { source: tab, requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId });

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent(emitFactualPayload(proof, {
              type: "result",
              requestId: chartAuditRequestId,
              chartAuditSource: tab,
              sql: metadata.sql,
              explanation: metadata.explanation,
              title: metadata.title,
              columns: metadata.columns,
              rows: metadata.rows,
              rowCount: metadata.rowCount,
              truncated: metadata.truncated,
              chartConfig: metadata.chartConfig,
              chartMeta: metadata.chartMeta,
              executionTimeMs: ms,
            }))
          )
        );
        controller.close();
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

  const stream = new ReadableStream({
    async start(controller) {
      let sql: string | null = null;
      let firedGuardrails: string[] = [];
      let contractQuestion = question;
      let closed = false;
      /**
       * Model calls made for this request. Every call goes through translate(), so
       * retries = calls - 1 without instrumenting each of the seven retry sites
       * individually (and without a counter that drifts when one is added).
       * Handoff 6.2 requires the digest to carry a retry count; 2.3 keeps retry a
       * transitional action that is separately accounted rather than terminal.
       */
      let modelCalls = 0;
      const translate: typeof translateToSql = (...args) => {
        modelCalls += 1;
        return translateToSql(...args);
      };
      const proofRetries = () => Math.max(0, modelCalls - 1);
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      const recordContractValidation = (contractResult: QueryContractSqlValidation) => {
        const contractGuardrails = queryContractGuardrails(contractResult);
        if (contractGuardrails.length > 0) {
          firedGuardrails = [...new Set([...firedGuardrails, ...contractGuardrails])];
        }
        if (contractResult.warnings.length > 0) {
          console.log(`[query][contract] Warnings: ${contractResult.warnings.join(", ")}`);
        }
      };
      const runContractValidation = (inputSql: string): QueryContractSqlValidation => {
        const contractResult = validateQueryContractSql({
          question: contractQuestion,
          source: tab === "historical" ? "historical" : "current",
          sql: inputSql,
          routingMeta,
        });
        recordContractValidation(contractResult);
        return contractResult;
      };
      const emitContractFailure = (contractResult: QueryContractSqlValidation, logError: string): boolean => {
        const msg = queryContractFailureMessage(contractResult);
        if (!msg) return false;
        const proof = finalizeExit({
          intendedAction: "decline_capability",
          sql: contractResult.sql,
          guardrails: firedGuardrails,
        });
        writeLog(question, contractResult.sql, 0, logError, Date.now() - totalStart, msg, tab, firedGuardrails, "haiku-4.5", sessionId, null, proof);
        controller.enqueue(
          encoder.encode(
            sseEvent(emitFactualPayload(proof, {
              type: "result",
              sql: null as unknown as string,
              explanation: msg,
              title: "",
              columns: [],
              rows: [],
              rowCount: 0,
              truncated: false,
              chartConfig: null,
              chartMeta: null,
              executionTimeMs: Date.now() - totalStart,
            }))
          )
        );
        close();
        return true;
      };

      try {
        // Step 1: Translate to SQL via Claude
        controller.enqueue(
          encoder.encode(
            sseEvent({ type: "status", text: "Analyzing your question..." })
          )
        );

        const isHistorical = body?.mode === "historical";
        const history = normalizeHistoryForTab(body?.history, isHistorical ? "historical" : "current");
        const followupTransform = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? followupPlan.transform : (detectFollowupTransform(question, history) ?? buildCrossSourceFollowupTransform(question, body?.history, isHistorical ? "historical" : "current"));
        // Bare clarifier answers ("Countywide total") carry no county name — use
        // the transform's reconstructed question so guardrails see the geography
        const guardrailQuestion = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? followupPlan.reconstructedQuestion : (followupTransform?.contextQuestion ?? question);
        contractQuestion = guardrailQuestion;
        // The guardrail question is the most complete reconstruction available -- it
        // is what extractQueryContext and the contract validator see -- so proof uses
        // it for every exit from here on.
        proofQuestion = guardrailQuestion;
        const consolidationTargets = isHistorical
          ? [...new Map(resolveGeoPlaces(guardrailQuestion).mentions
              .flatMap((mention) => mention.candidates)
              .map((candidate) => findConsolidatedAgency(candidate.state, candidate.name))
              .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
              .map((entry) => [entry.historicalOri, entry])).values()]
          : [];
        const consolidationInstruction = consolidationTargets.length > 0
          ? `Verified consolidated-agency targets: ${consolidationTargets.map((entry) =>
              `${entry.alias}, ${entry.state} MUST query historical_agency ORI ${entry.historicalOri} (${entry.historicalAgency}) and MUST display only ${entry.alias}`,
            ).join("; ")}. Do not query a predecessor ORI or use a source-specific agency name in output.`
          : undefined;
        const promptHistory = followupTransform
          ? [...history, { role: "user" as const, content: followupTransform.instruction }]
          : history;
        if (consolidationInstruction) promptHistory.push({ role: "user" as const, content: consolidationInstruction });
        const systemPrompt = isHistorical ? getHistoricalSystemPrompt() : undefined;

        // Check response cache (only standalone questions)
        const cached = promptHistory.length === 0 ? getCached(question, tab, cacheValidity) : null;
        let fromCache = false;

        let claude: Awaited<ReturnType<typeof translateToSql>>;

        if (cached) {
          claude = { sql: cached.sql, explanation: cached.explanation, title: cached.title || "", chartHint: (cached.chartType as "bar" | "line" | "pie" | "stacked_bar" | "scatter" | "none") || "none", xAxis: cached.xAxis || "", yAxis: cached.yAxis?.join(",") || "", colors: cached.colors as string[] | undefined, yAxisLabel: cached.yAxisLabel, xAxisLabel: cached.xAxisLabel, annotations: cached.annotations as typeof claude.annotations };
          fromCache = true;
        } else {
          const correctionHint = geoCorrectionHint(question);
          if (correctionHint) firedGuardrails.push("geo-typo-corrected");
          claude = await translate(
            applyGeoCorrection(question, correctionHint),
            promptHistory as { role: "user" | "assistant"; content: string }[],
            systemPrompt
          );

          if (!claude.sql && !isOverBudget()) {
            // Retry if model incorrectly claims data isn't available
            const coverageRetryPrompt = partialCoverageRetryPrompt(tab, question, claude.explanation);
            const refusalPatterns = /not (appear|be represented)|doesn't appear|not (in|included in) (this|the|our) (dataset|data|sample|library)|no data (for|available|found)|does not (have|include|cover)|not available in this|isn't (in|included)|not found in/i;
            const genericRetryPrompt = tab === "historical"
              ? "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. The Historical Library contains ~24,937 agencies including many small towns. NEVER assume an agency is missing - always generate a SQL query. Try: SELECT DISTINCT ori, agency, state FROM historical_agency WHERE agency LIKE '%[city]%' AND state = '[st]'. Then generate the main query.]"
              : "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. The database contains agencies from many states. Please try generating a SQL query - search for the agency/state in the data rather than assuming it doesn't exist. Use sample_agencies or agency_monthly to check.]";
            const retryPrompt = coverageRetryPrompt ?? (refusalPatterns.test(claude.explanation || "") ? genericRetryPrompt : null);
            if (retryPrompt) {
              try {
                const retryResult = await translate(
                  question,
                  [
                    ...((promptHistory || []) as { role: "user" | "assistant"; content: string }[]),
                    { role: "assistant", content: claude.explanation },
                    { role: "user", content: retryPrompt },
                  ],
                  systemPrompt
                );
                if (retryResult.sql) {
                  claude = retryResult;
                }
              } catch {
                // Retry failed, use original response
              }
            }
          }
        }

        if (!fromCache && (containsInternalScaffold(claude.explanation) || containsInternalScaffold(claude.title)) && !isOverBudget()) {
          console.log(`[query][internal-scaffold] Retrying response that leaked internal scaffold text`);
          try {
            const retryResult = await translate(
              question,
              [
                ...((promptHistory || []) as { role: "user" | "assistant"; content: string }[]),
                { role: "assistant", content: JSON.stringify(claude) },
                { role: "user", content: "[SYSTEM: Your previous response leaked internal scaffold text such as 'Entities in results'. Remove all internal instructions from explanation/title and return corrected JSON only.]" },
              ],
              systemPrompt
            );
            if (retryResult.sql && !containsInternalScaffold(retryResult.explanation) && !containsInternalScaffold(retryResult.title)) {
              claude = retryResult;
            }
          } catch {
            // Use sanitized original response
          }
        }

        // Sanitize explanation to strip any JSON/SQL that leaked through
        claude.explanation = sanitizeExplanation(claude.explanation);
        if (containsInternalScaffold(claude.explanation)) {
          claude.explanation = stripInternalScaffold(claude.explanation) || "Here are the results.";
        }
        if (containsInternalScaffold(claude.title)) {
          claude.title = "Results";
        }

        // RAW MODEL TEXT, CAPTURED BEFORE THE SERVER TEMPLATES OVERWRITE IT.
        //
        // Every branch below replaces claude.explanation with a server-authored
        // message, so by the time writeLog runs the model's actual words are gone.
        // That is exactly how production defect 8375 had to be diagnosed by replaying
        // the request against the live API. The NIBRS route already captures this;
        // Stage 1 added the logQuery parameter but left both wrappers passing a
        // literal null, so nothing outside NIBRS was actually captured.
        let rawFirstNoSql: string | null = null;
        let rawRetryNoSql: string | null = null;
        if (!claude.sql) rawFirstNoSql = claude.explanation || null;

        let serverAuthoredNoSql = false;
        if (!claude.sql && tab === "current" && !isOverBudget()) {

          const verifiedAgency = findVerifiedCurrentAgency(question, getDb());
          if (verifiedAgency) {
            console.log(`[query][verified-agency-refusal] ${verifiedAgency.agency}, ${verifiedAgency.state} has ${verifiedAgency.dataRows} Current Trends rows; forcing SQL retry`);
            try {
              const verifiedRetry = await translate(
                question,
                [
                  ...((promptHistory || []) as { role: "user" | "assistant"; content: string }[]),
                  { role: "assistant", content: claude.explanation },
                  { role: "user", content: "[SYSTEM: Database preflight verified that " + verifiedAgency.agency + ", " + verifiedAgency.state + " is a Current Trends city agency with " + verifiedAgency.dataRows + " monthly rows. Do not return sql null and do not claim this agency is unavailable. Generate the requested query for this exact agency, preserving the user's offense and date range.]" },
                ],
                systemPrompt
              );
              rawRetryNoSql = verifiedRetry.explanation || null;
              if (verifiedRetry.sql) claude = verifiedRetry;
            } catch {
              // Fall through to the truthful verified-availability response below.
            }
          }
          if (!claude.sql && verifiedAgency) {
            serverAuthoredNoSql = true;
            claude.explanation = "I couldn't generate the requested query, but " + verifiedAgency.agency + ", " + verifiedAgency.state + " is in Current Trends. Please try the same question again or specify the offense and date range.";
          }
        }
        if (!claude.sql && tab === "current" && /not (?:in|included in)|not found|doesn\'t appear|no data|not available|does not (?:have|include|cover)/i.test(claude.explanation || "")) {
          claude.explanation = "I couldn\'t generate a database query for that request, so I can\'t determine whether the requested agency or data is available. Please try the same question again or specify the offense and date range.";
        }

        if (!claude.sql) {
        if (containsInternalLeak(claude.explanation) || containsInternalLeak(claude.title)) { claude.explanation = INTERNAL_LEAK_SAFE_MESSAGE; claude.title = "Results"; firedGuardrails.push("internal-leak-firewall"); }
          const ms = Date.now() - totalStart;
          if (!serverAuthoredNoSql && !containsInternalLeak(claude.explanation) && !containsInternalLeak(claude.title)) { claude.explanation = buildNoSqlFallbackMessage(tab === "historical" ? "historical" : "current"); firedGuardrails.push("no-sql-server-template"); }
        claude.explanation = neutralizeUnverifiedAvailabilityClaim(claude.explanation, tab === "historical" ? "Historical" : "Current Trends");
          // No SQL was produced, so nothing factual is being asserted. Capability
          // framing, never a claim that the source lacks the data (handoff 2.4).
          const noSqlProof = finalizeExit({ intendedAction: "decline_capability", guardrails: firedGuardrails });
          writeLog(question, null, 0, null, ms, claude.explanation, tab, firedGuardrails, "haiku-4.5", sessionId, null, noSqlProof, boundedModelResponseJson(rawFirstNoSql, rawRetryNoSql));
          controller.enqueue(
            encoder.encode(
              sseEvent(emitFactualPayload(noSqlProof, {
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
              }))
            )
          );
          close();
          return;
        }

        // Step 1b: Extract context and run guardrails
        const ctx = extractQueryContext(claude.sql, guardrailQuestion, tab as "current" | "historical");
        const guardrailResult = runGuardrails(ctx);

        // Also check yAxis/yAxisLabel issues that need ClaudeResponse fields
        const sqlLower = claude.sql.toLowerCase();
        const issues = [...guardrailResult.issues];
        // Satisfied by the successor ORI literal OR by the successor's own name scoped to
        // its state -- see consolidationTargetSatisfied. Requiring the ORI literal alone
        // refused correct SQL against the successor.
        const missingConsolidationTargets = (candidateSql: string) => consolidationTargets.filter(
          (entry) => !consolidationTargetSatisfied(candidateSql, entry),
        );
        const missingInitialTargets = missingConsolidationTargets(claude.sql);
        if (missingInitialTargets.length > 0) {
          issues.push(`The SQL must target the verified successor ORI(s): ${missingInitialTargets.map((entry) => `${entry.alias}=${entry.historicalOri}`).join(", ")}. Never select the predecessor by agency name.`);
        }
        if (claude.yAxis) {
          const yCols = claude.yAxis.split(",").map(c => c.trim().toLowerCase());
          for (const col of yCols) {
            if (col && !sqlLower.includes(col) && !sqlLower.includes(`as ${col}`)) {
              issues.push(`yAxis column "${col}" not found in SQL SELECT.`);
              break;
            }
          }
        }
        if (claude.yAxisLabel && /per (1,000|capita|100k|100,000)/i.test(claude.yAxisLabel) && !sqlLower.includes("population")) {
          issues.push("The yAxisLabel mentions per-capita rates but the SQL does not join population data. Either add a population JOIN for rate calculation, or remove the per-capita label.");
        }

        // Apply auto-rewrites from guardrails
        if (guardrailResult.sql !== claude.sql) {
          claude.sql = guardrailResult.sql;
        }

        firedGuardrails = mergeGuardrailTags(firedGuardrails, guardrailResult.fired);
        if (firedGuardrails.length > 0) {
          console.log(`[guardrails] Fired: ${firedGuardrails.join(", ")}`);
        }

        const initialContractResult = runContractValidation(claude.sql);
        claude.sql = initialContractResult.sql;
        if (initialContractResult.blockReasons.length > 0) {
          if (emitContractFailure(initialContractResult, `contract_block:${initialContractResult.enforced.join(",")}`)) return;
        }
        issues.push(...initialContractResult.retryIssues);

        // Hard override — skip retry, return deterministic response
        if (guardrailResult.overrideResponse) {
          const overrideExplanation = guardrailResult.overrideResponse;
          const overrideProof = finalizeExit({ intendedAction: "decline_capability", sql, guardrails: firedGuardrails, planFamily: guardrailResult.overrideGuardrail ?? null });
          writeLog(question, sql, 0, `guardrail_override:${guardrailResult.overrideGuardrail}`, Date.now() - totalStart, overrideExplanation, tab, firedGuardrails, "haiku-4.5", sessionId, null, overrideProof);
          controller.enqueue(
            encoder.encode(
              sseEvent(emitFactualPayload(overrideProof, {
                type: "result",
                sql: null as unknown as string,
                explanation: overrideExplanation,
                title: "",
                columns: [],
                rows: [],
                rowCount: 0,
                truncated: false,
                chartConfig: null,
                chartMeta: null,
                executionTimeMs: Date.now() - totalStart,
              }))
            )
          );
          close();
          return;
        }

        // If issues found, ask Claude to fix (if budget allows)
        if (issues.length > 0 && !isOverBudget()) {
          controller.enqueue(
            encoder.encode(
              sseEvent({ type: "status", text: "Refining query..." })
            )
          );
          const fixPrompt = `Your SQL has these issues:\n${issues.map(i => `- ${i}`).join("\n")}\n\nPlease fix the SQL and return corrected JSON.`;
          const fixHistory = [
            ...(promptHistory || []),
            { role: "user" as const, content: question },
            { role: "assistant" as const, content: JSON.stringify(claude) },
            { role: "user" as const, content: fixPrompt },
          ];
          const fixed = await translate(fixPrompt, fixHistory, systemPrompt);
          if (fixed.sql) {
            claude.sql = fixed.sql;
            applyRetryMeta(claude, fixed);
          }
        }

        // Post-retry guardrail re-check
        {
          const postRetryCtx = extractQueryContext(claude.sql, guardrailQuestion, tab as "current" | "historical");
          const postRetryResult = runGuardrails(postRetryCtx);
          if (postRetryResult.overrideResponse) {
            const postRetryOverrideProof = finalizeExit({ intendedAction: "decline_capability", sql: claude.sql, guardrails: postRetryResult.fired, planFamily: postRetryResult.overrideGuardrail ?? null });
            writeLog(question, claude.sql, 0, `guardrail_override:${postRetryResult.overrideGuardrail}`, Date.now() - totalStart, postRetryResult.overrideResponse, tab, postRetryResult.fired, "haiku-4.5", sessionId, null, postRetryOverrideProof);
            controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(postRetryOverrideProof, { type: "result", sql: null as unknown as string, explanation: postRetryResult.overrideResponse, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart }))));
            close(); return;
          }
          const rateStillBad = postRetryResult.fired.some(f => f.includes("rate-no-population"));
          if (rateStillBad && /\b(rates?|per\s*capita|per\s*100)/i.test(question) && !asksForCountsInsteadOfRates(question) && !/\b(not rates?|raw|counts?\s+not\s+rates?)\b/i.test(question)) {
            const msg = "I wasn't able to calculate a valid per-capita rate for this query. Try asking for raw counts, or use the [Historical Library](/test?tab=historical) tab for state/national rates.";
            const rateFailureProof = finalizeExit({ intendedAction: "decline_capability", sql: claude.sql, guardrails: postRetryResult.fired, planFamily: "rate-no-population" });
            writeLog(question, claude.sql, 0, "rate_second_failure", Date.now() - totalStart, msg, tab, postRetryResult.fired, "haiku-4.5", sessionId, null, rateFailureProof);
            controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(rateFailureProof, { type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart }))));
            close(); return;
          }
          const orPrecedenceStillBad = postRetryResult.fired.includes("or-and-precedence");
          if (orPrecedenceStillBad) {
            const msg = "I couldn't build a reliable multi-place query after correcting the SQL structure. Try asking for fewer places or restating the comparison.";
            const orPrecedenceProof = finalizeExit({ intendedAction: "decline_capability", sql: claude.sql, guardrails: postRetryResult.fired, planFamily: "or-and-precedence" });
            writeLog(question, claude.sql, 0, "or_precedence_second_failure", Date.now() - totalStart, msg, tab, postRetryResult.fired, "haiku-4.5", sessionId, null, orPrecedenceProof);
            controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(orPrecedenceProof, { type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart }))));
            close(); return;
          }
          // Geography contract: block if city/county-got-state or geography-missing still fires after retry
          const geoContractViolation = postRetryResult.fired.some(f =>
            f === "historical-city-got-state" || f === "historical-county-got-state" || f === "contract-geography-missing"
          );
          if (geoContractViolation) {
            const msg = "I couldn't build a reliable query for that specific geography. The data may be available under a different agency name — try searching for the county sheriff or a specific city within the county.";
            const geographyFailureProof = finalizeExit({ intendedAction: "decline_capability", sql: claude.sql, guardrails: postRetryResult.fired, planFamily: "contract-geography" });
            writeLog(question, claude.sql, 0, "geography_second_failure", Date.now() - totalStart, msg, tab, postRetryResult.fired, "haiku-4.5", sessionId, null, geographyFailureProof);
            controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(geographyFailureProof, { type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart }))));
            close(); return;
          }
          if (postRetryResult.sql !== claude.sql) claude.sql = postRetryResult.sql;

          const postRetryContract = runContractValidation(claude.sql);
          claude.sql = postRetryContract.sql;
          if (emitContractFailure(postRetryContract, `contract_second_failure:${postRetryContract.enforced.join(",")}`)) return;
        }

        const preValidationContract = runContractValidation(claude.sql);
        claude.sql = preValidationContract.sql;
        if (emitContractFailure(preValidationContract, `contract_final_failure:${preValidationContract.enforced.join(",")}`)) return;
        const missingFinalTargets = missingConsolidationTargets(claude.sql);
        if (missingFinalTargets.length > 0) {
          const msg = `I couldn't safely resolve ${missingFinalTargets.map((entry) => `${entry.alias}, ${entry.state}`).join("; ")} to the verified post-consolidation agency. Please retry.`;
          const consolidationProof = finalizeExit({ intendedAction: "decline_capability", sql: claude.sql, guardrails: firedGuardrails, planFamily: "consolidation-mapping" });
          writeLog(question, claude.sql, 0, "consolidation_target_missing", Date.now() - totalStart, msg, tab, firedGuardrails, "haiku-4.5", sessionId, null, consolidationProof);
          controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(consolidationProof, { type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart }))));
          close();
          return;
        }

        controller.enqueue(
          encoder.encode(
            sseEvent({ type: "status", text: "Running query..." })
          )
        );

        // Step 2: Validate SQL
        const maxLimit = 5000;
        const validation = validateAndSanitize(claude.sql, { maxLimit });
        if (!validation.valid) {
          const ms = Date.now() - totalStart;
          writeLog(
            question,
            claude.sql,
            0,
            `Validation: ${validation.error}`,
            ms,
            null,
            tab,
            firedGuardrails,
            "haiku-4.5",
            sessionId,
            null,
            finalizeExit({ intendedAction: "decline_capability", sql: claude.sql, guardrails: firedGuardrails, retries: proofRetries() })
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

        {
          const tableCheck = validateTablesForTab(sql, tab, getDb());
          if (!tableCheck.ok) {
            firedGuardrails = [...firedGuardrails, ...tableCheck.fired];
            if (!isOverBudget()) {
              controller.enqueue(
                encoder.encode(
                  sseEvent({ type: "status", text: "Switching to the right tables..." })
                )
              );
              const retryHistory = [
                ...(promptHistory || []),
                { role: "user" as const, content: question },
                { role: "assistant" as const, content: JSON.stringify({ ...claude, sql }) },
                { role: "user" as const, content: `[SYSTEM: ${tableCheck.message}]` },
              ];
              const retry = await translate(tableCheck.message, retryHistory, systemPrompt);
              if (retry.sql) {
                const retryValidation = validateAndSanitize(retry.sql, { maxLimit });
                if (retryValidation.valid) {
                  const retryContract = runContractValidation(retryValidation.sanitized!);
                  let retrySql = retryContract.sql;
                  if (emitContractFailure(retryContract, `contract_table_retry_failure:${retryContract.enforced.join(",")}`)) return;
                  const retryTableCheck = validateTablesForTab(retrySql, tab, getDb());
                  if (retryTableCheck.ok) {
                    sql = retrySql;
                    applyRetryMeta(claude, retry);
                  } else {
                    const msg = "I couldn't build a valid query for this data source. Try switching tabs or rephrasing the question for the active dataset.";
                    const retryAllowlistProof = finalizeExit({ intendedAction: "decline_capability", sql: retrySql, guardrails: [...firedGuardrails, ...retryTableCheck.fired], planFamily: "table-allowlist", retries: 1 });
                    writeLog(question, retrySql, 0, `table_allowlist_second_failure:${retryTableCheck.unknown.join(",")}`, Date.now() - totalStart, msg, tab, [...firedGuardrails, ...retryTableCheck.fired], "haiku-4.5", sessionId, null, retryAllowlistProof);
                    controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(retryAllowlistProof, { type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart }))));
                    close();
                    return;
                  }
                }
              }
            }

            const msg = "I couldn't build a valid query for this data source. Try switching tabs or rephrasing the question for the active dataset.";
            const allowlistProof = finalizeExit({ intendedAction: "decline_capability", sql, guardrails: firedGuardrails, planFamily: "table-allowlist" });
            writeLog(question, sql, 0, `table_allowlist:${tableCheck.unknown.join(",")}`, Date.now() - totalStart, msg, tab, firedGuardrails, "haiku-4.5", sessionId, null, allowlistProof);
            controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(allowlistProof, { type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart }))));
            close();
            return;
          }
        }

        // Step 3: Execute SQL (with one retry on DB error)
        const db = getDb();
        const dbStart = Date.now();

        let rows: Record<string, unknown>[];
        let columns: string[];

        try {
          const executionContract = runContractValidation(sql);
          sql = executionContract.sql;
          if (emitContractFailure(executionContract, `contract_execution_failure:${executionContract.enforced.join(",")}`)) return;
          const schemaCheck = validateSqlSchema(db, sql);
          if (!schemaCheck.ok) {
        firedGuardrails.push("schema-column-invalid");
        throw new Error("Schema validation failed: " + schemaCheck.error);
      }
          if (schemaCheck.corrected) {
            sql = schemaCheck.sql;
            firedGuardrails.push("schema-column-corrected");
          }
          const stmt = db.prepare(sql);
          const result = executeWithTimeoutSync<Record<string, unknown>>(db, stmt, 30000);
          columns = stmt.columns().map((c) => c.name);
          rows = result;
        } catch (dbErr) {
          const msg =
            dbErr instanceof Error ? dbErr.message : String(dbErr);
          // Retry: tell Claude about the error and ask for a corrected query (if budget allows)
          if (isOverBudget()) {
            const ms = Date.now() - totalStart;
            writeLog(question, sql, 0, `DB: ${msg} (over budget)`, ms, null, tab, firedGuardrails, "haiku-4.5", sessionId, null, finalizeExit({ intendedAction: "decline_capability", sql, guardrails: firedGuardrails, retries: proofRetries() }));
            controller.enqueue(encoder.encode(sseEvent({ type: "error", text: "That query took too long. Try simplifying your question." })));
            close();
            return;
          }
          controller.enqueue(
            encoder.encode(
              sseEvent({ type: "status", text: "Retrying with corrected query..." })
            )
          );
          const countywideRetryReminder = /\b(countywide|county|parish|borough)\b/i.test(guardrailQuestion)
            ? " If this is a countywide geography query, the corrected SQL must use agency_county_crosswalk joined on the metric table ORI (metric_alias.ori = ac.ori9 OR substr(metric_alias.ori, 1, 7) = ac.ori). Do not replace countywide geography with a single county/sheriff agency or ha.type = 'county' unless the user explicitly asked for that agency."
            : "";
          const retryInstruction = `That SQL failed with error: ${msg}. Please fix the query and try again.${countywideRetryReminder}`;
          const retryHistory = [
            ...(promptHistory || []),
            { role: "user" as const, content: question },
            {
              role: "assistant" as const,
              content: JSON.stringify(claude),
            },
            {
              role: "user" as const,
              content: retryInstruction,
            },
          ];
          const retry = await translate(
            retryInstruction,
            retryHistory,
            systemPrompt
          );
          if (retry.sql) {
            const retryValidation = validateAndSanitize(retry.sql, { maxLimit });
            if (retryValidation.valid) {
              const retryContract = runContractValidation(retryValidation.sanitized!);
              let retrySql = retryContract.sql;
              if (emitContractFailure(retryContract, `contract_db_retry_failure:${retryContract.enforced.join(",")}`)) return;
              try {
                const retrySchemaCheck = validateSqlSchema(db, retrySql);
                if (!retrySchemaCheck.ok) {
                  firedGuardrails.push("schema-column-invalid");
                  throw new Error("Schema validation failed: " + retrySchemaCheck.error);
                }
                if (retrySchemaCheck.corrected) {
                  retrySql = retrySchemaCheck.sql;
                  firedGuardrails.push("schema-column-corrected");
                }
                const retryStmt = db.prepare(retrySql);
                const retryResult = executeWithTimeoutSync<Record<string, unknown>>(db, retryStmt, 30000);
                columns = retryStmt.columns().map((c) => c.name);
                rows = retryResult;
                sql = retrySql;
                applyRetryMeta(claude, retry);
              } catch (retryErr) {
                const retryMsg =
                  retryErr instanceof Error
                    ? retryErr.message
                    : String(retryErr);
                const ms = Date.now() - totalStart;
                writeLog(
                  question,
                  sql,
                  0,
                  `DB retry failed: ${retryMsg}`,
                  ms,
                  null,
                  tab,
                  firedGuardrails,
                  "haiku-4.5",
                  sessionId,
                  null,
                  finalizeExit({ intendedAction: "decline_capability", sql, guardrails: firedGuardrails, retries: proofRetries() })
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
              writeLog(
                question,
                sql,
                0,
                `DB: ${msg} (retry validation failed)`,
                ms,
                null,
                tab,
                firedGuardrails,
                "haiku-4.5",
                sessionId,
                null,
                finalizeExit({ intendedAction: "decline_capability", sql, guardrails: firedGuardrails, retries: proofRetries() })
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
            writeLog(question, sql, 0, `DB: ${msg}`, ms, null, tab, firedGuardrails, "haiku-4.5", sessionId, null, finalizeExit({ intendedAction: "decline_capability", sql, guardrails: firedGuardrails, retries: proofRetries() }));
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

        const totalMs = Date.now() - totalStart;
        const executionTimeMs = totalMs;  // show total wall time (includes Claude API + DB)

        // Step 4: Handle empty results
        if (rows.length === 0) {
          const agencyName = extractAgencyName(sql);
          const requestedState = sql.match(/\b(?:\w+\.)?state\s*=\s*'([^']+)'/i)?.[1] ?? null;
          let emptyMsg: string;
          // Current Trends explains an empty result from its own tables: a place we do not
          // carry, a period nobody has filed, a place that filed nothing for that period, an
          // offense with no figure in a period it did file, or -- when none of those can be
          // shown -- a plain decline. Historical keeps the probes below unchanged.
          const currentEmpty = isHistorical ? null : explainEmptyCurrentTrendsResult(db, sql);

          if (currentEmpty) {
            emptyMsg = currentEmpty.message;
            // A near-miss on the name is a suggestion, not a claim about the data, so it can
            // ride along with the one reason that is about the name.
            if (currentEmpty.reason === "place_not_covered" && agencyName) {
              const similar = findSimilarAgencies(db, agencyName, false, requestedState);
              if (similar.length > 0) {
                const suggestions = similar
                  .map((s) => `${s.agency}, ${displayStateCode(s.state, false)}`)
                  .join("; ");
                emptyMsg += ` Did you mean: ${suggestions}?`;
              }
            }
          } else if (agencyName) {
            const similar = findSimilarAgencies(db, agencyName, isHistorical, requestedState);
            if (similar.length === 0) {
              emptyMsg = `"${agencyName}" is not in our dataset. Try the [NIBRS](/test?tab=nibrs) tab, which has incident-level data from agencies nationwide, or the [Current Trends](/test?tab=current) tab for monthly data from ~${RTCI.agencyCount} major agencies.`;
            } else {
              const exactMatch = similar.find(
                (s) =>
                  s.agency.toLowerCase() === agencyName.toLowerCase()
              );
              if (exactMatch) {
                // Query which offenses this agency actually reports
                try {
                  let offenseList = "";
                  {
                    // Only Historical reaches here now, so there is no longer a branch on the
                    // tab; the block scopes the row. Historical uses separate columns per
                    // offense in historical_agency_crime
                    const row = db
                      .prepare(
                        `SELECT
                           MAX(CASE WHEN murder > 0 THEN 1 ELSE 0 END) as has_murder,
                           MAX(CASE WHEN rape > 0 THEN 1 ELSE 0 END) as has_rape,
                           MAX(CASE WHEN robbery > 0 THEN 1 ELSE 0 END) as has_robbery,
                           MAX(CASE WHEN assault > 0 THEN 1 ELSE 0 END) as has_assault,
                           MAX(CASE WHEN burglary > 0 THEN 1 ELSE 0 END) as has_burglary,
                           MAX(CASE WHEN theft > 0 THEN 1 ELSE 0 END) as has_theft,
                           MAX(CASE WHEN motor_vehicle_theft > 0 THEN 1 ELSE 0 END) as has_mvt
                         FROM historical_agency_crime hac
                         JOIN historical_agency ha ON ha.ori = hac.ori
                         WHERE ha.agency = ? AND ha.state = ?`
                      )
                      .get(exactMatch.agency, exactMatch.state.toLowerCase()) as Record<string, number> | undefined;
                    if (row) {
                      const names: string[] = [];
                      if (row.has_murder) names.push("Murder");
                      if (row.has_rape) names.push("Rape");
                      if (row.has_robbery) names.push("Robbery");
                      if (row.has_assault) names.push("Aggravated Assault");
                      if (row.has_burglary) names.push("Burglary");
                      if (row.has_theft) names.push("Theft");
                      if (row.has_mvt) names.push("Motor Vehicle Theft");
                      if (names.length > 0) offenseList = names.join(", ");
                    }
                  }
                  if (offenseList) {
                    emptyMsg = `${exactMatch.agency}, ${displayStateCode(exactMatch.state, isHistorical)} is in our dataset, but no data was found for that specific query. This agency reports the following offenses: ${offenseList}. Try one of those instead, or adjust the date range.`;
                  } else {
                    emptyMsg = `${exactMatch.agency}, ${displayStateCode(exactMatch.state, isHistorical)} is in our dataset, but no data was found for that specific query. The agency may not report this offense, or the date range may not have data. Try a different offense or broader date range.`;
                  }
                } catch {
                  emptyMsg = `${exactMatch.agency}, ${displayStateCode(exactMatch.state, isHistorical)} is in our dataset, but no data was found for that specific query. The agency may not report this offense, or the date range may not have data. Try a different offense or broader date range.`;
                }
              } else {
                const suggestions = similar
                  .map((s) => `${s.agency}, ${displayStateCode(s.state, isHistorical)}`)
                  .join("; ");
                emptyMsg = `"${agencyName}" wasn't found in our dataset. Did you mean: ${suggestions}? Our data covers ~${RTCI.agencyCount} major agencies across ${RTCI.stateCount} states.`;
              }
            }
          } else {
            emptyMsg =
              "This query returned no results. The data may not be available for the specified criteria. Try broadening your search or asking about a different topic.";
          }

          // Current Trends may say something about the published data only when the check
          // above established which of the five situations this is. When it could not, the
          // reply declines instead. Historical keeps its existing probes.
          const emptyIsSourceAbsence = isHistorical || (currentEmpty?.establishedFromData ?? false);
          const emptyProof = finalizeExit({
            intendedAction: emptyIsSourceAbsence ? "decline_data" : "decline_capability",
            sql, columns, guardrails: firedGuardrails, db,
          });
          writeLog(
            question, sql, 0, emptyIsSourceAbsence ? "empty_result" : "empty_result_unverified",
            totalMs, emptyMsg, tab, firedGuardrails, "haiku-4.5", sessionId, null, emptyProof,
          );
          controller.enqueue(
            encoder.encode(
              sseEvent(emitFactualPayload(emptyProof, {
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
              }))
            )
          );
          close();
          return;
        }

        // Step 4b: Auto-pivot long-format multi-agency data for charting
        // Detects rows like (year, [month,] agency, total) and pivots to (year, [month,] city1, city2, ...)
        const agencyCol = columns.find(
          (c) => c === "agency" || c === "agency_name" || c === "city"
        );
        const valueCol = columns.find(
          (c) =>
            c !== "agency" &&
            c !== "agency_name" &&
            c !== "city" &&
            c !== "year" &&
            c !== "month" &&
            typeof rows[0]?.[c] === "number"
        );
        const hasYear = columns.includes("year");

        // Skip auto-pivot for ranking queries (ORDER BY ... DESC LIMIT)
        // Those are intentionally long-format listings, not comparisons
        // Only check the LAST ORDER BY to avoid matching inside CTEs/subqueries
        const lastOrderBy = sql.lastIndexOf("ORDER BY") !== -1
          ? sql.slice(sql.lastIndexOf("ORDER BY"))
          : "";
        const isRankingQuery = /ORDER\s+BY\s+\S+\s+DESC[\s\S]*?LIMIT/i.test(lastOrderBy);

        if (agencyCol && valueCol && hasYear && rows.length > 1 && !isRankingQuery) {
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

        // Step 4c: Detect columns that are ALL null in pivoted comparison data
        // Catches agencies that don't exist in the dataset but appear as null columns
        {
          const { allNull: everyColNull, dataCols } = detectAllNullData(columns, rows);
          if (everyColNull) {
            // Rows came back but carried no value, which is the same situation as no rows at
            // all: nothing can be reported. Current Trends explains it the same deterministic
            // way rather than assuming the published data is what is missing.
            const currentAllNull = isHistorical ? null : explainEmptyCurrentTrendsResult(db, sql);
            // Detect if the issue is a failed agency/CTE lookup vs bad math
            const hasAgencyCte = /WITH\s+agency\s+AS/i.test(sql) || /historical_agency\s+ha/i.test(sql);
            const hasCountyOrCity = /\b(county|parish|agency\s*=)\b/i.test(question);
            const emptyMsg = currentAllNull
              ? currentAllNull.message
              : hasAgencyCte && hasCountyOrCity
              ? "I couldn't find a matching agency or county record for that query. The name may be stored differently in the database — try the exact agency name (e.g., 'Alameda County' not just 'Alameda'), or check the Historical Library tab which has county-level records."
              : "I ran that query but all the values came back empty — the math likely broke somewhere (like dividing by zero). Could you try asking that a different way?";
            const allNullIsSourceAbsence = isHistorical || (currentAllNull?.establishedFromData ?? false);
            const allNullProof = finalizeExit({
              intendedAction: allNullIsSourceAbsence ? "decline_data" : "decline_capability",
              sql, columns, guardrails: firedGuardrails, db,
            });
            writeLog(question, sql, 0, "all_null_columns", totalMs, emptyMsg, tab, firedGuardrails, "haiku-4.5", sessionId, null, allNullProof);
            controller.enqueue(
              encoder.encode(
                sseEvent(emitFactualPayload(allNullProof, {
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
                }))
              )
            );
            close();
            return;
          }
          // Check for partial null columns (some null, some not)
          if (dataCols.length > 0 && rows.length > 0) {
            const nullCols = dataCols.filter(col => rows.every(r => r[col] === null || r[col] === undefined));
            if (nullCols.length > 0 && nullCols.length < dataCols.length) {
              const names = nullCols.map(c => c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())).join(', ');
              claude.explanation += `\n\nNote: ${names} returned no data for this query. This agency may not be in our dataset, may not report this offense, or may not have data for the requested time period.`;
              rows = rows.map(r => {
                const cleaned = { ...r };
                for (const col of nullCols) delete cleaned[col];
                return cleaned;
              });
              columns = columns.filter(c => !nullCols.includes(c));
              if (claude.yAxis) {
                claude.yAxis = claude.yAxis.split(',').map(y => y.trim()).filter(y => !nullCols.includes(y)).join(',');
              }
            }
          }
        }

        // Step 4d: Detect sparse monthly city data (sawtooth pattern)
        // If monthly data for a specific city/agency has many zeros, retry with rolling 12-month
        // SKIP if user explicitly asked for raw/non-rolling values
        const userWantsRaw = /\b(raw counts?|raw numbers?|not rolling|no rolling|don'?t want rolling|just monthly|just raw)\b/i.test(question);
        const hasMonth = columns.includes("month");
        const isAgencyQuery = sql.toLowerCase().includes("agency_monthly") && /agency\s*=\s*'/i.test(sql);
        if (hasMonth && isAgencyQuery && rows.length > 12 && !userWantsRaw) {
          const dataCols = columns.filter(c => c !== "year" && c !== "month");
          for (const col of dataCols) {
            const vals = rows.map(r => Number(r[col] ?? 0));
            const zeroCount = vals.filter(v => v === 0).length;
            const zeroPct = zeroCount / vals.length;
            if (zeroPct > 0.15) {
              // Retry with rolling 12-month (skip if over budget)
              if (isOverBudget()) break;
              console.log(`[sparse-monthly] ${col}: ${zeroCount}/${vals.length} zeros (${(zeroPct*100).toFixed(0)}%), retrying with rolling 12-month`);
              controller.enqueue(
                encoder.encode(
                  sseEvent({ type: "status", text: "Switching to rolling 12-month view..." })
                )
              );
              const rollingPrompt = `Rewrite this query to use a rolling 12-month sum instead of raw monthly counts. The raw monthly data has many zero-count months which creates a misleading chart. Use SUM(...) OVER (ORDER BY year, month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) as the rolling window. Keep all other filters the same.`;
              const rollingHistory = [
                ...(promptHistory || []),
                { role: "user" as const, content: question },
                { role: "assistant" as const, content: JSON.stringify(claude) },
                { role: "user" as const, content: rollingPrompt },
              ];
              const rollingFixed = await translate(rollingPrompt, rollingHistory, systemPrompt);
              if (rollingFixed.sql) {
                const rv = validateAndSanitize(rollingFixed.sql, { maxLimit });
                if (rv.valid) {
                  const rollingContract = runContractValidation(rv.sanitized!);
                  const rollingSql = rollingContract.sql;
                  if (emitContractFailure(rollingContract, `contract_rolling_retry_failure:${rollingContract.enforced.join(",")}`)) return;
                  try {
                    const stmt2 = db.prepare(rollingSql);
                    const result2 = stmt2.all() as Record<string, unknown>[];
                    rows = result2;
                    columns = stmt2.columns().map(c => c.name);
                    sql = rollingSql;
                    applyRetryMeta(claude, rollingFixed);
                    claude.explanation = (claude.explanation || "") + "\n\nNote: Raw monthly data had many zero-count months, so results were converted to a rolling 12-month sum for a clearer trend.";
                    console.log(`[sparse-monthly] Rolling 12-month retry succeeded, ${rows.length} rows`);
                  } catch (e) {
                    console.log(`[sparse-monthly] Rolling retry SQL failed:`, e);
                  }
                }
              }
              break; // Only retry once
            }
          }
        }

        const yearTrim = (tab === "current" || tab === "historical") ? trimTrailingEmptyYearRows(rows, claude.explanation || "") : { rows, explanation: claude.explanation || "", trimmedYears: [] as number[] };
        if (yearTrim.trimmedYears.length > 0) { rows = yearTrim.rows; claude.explanation = yearTrim.explanation; columns = rows.length > 0 ? Object.keys(rows[0]) : columns; firedGuardrails.push("trailing-empty-years-trimmed"); console.log("[query][trailing-empty-years] trimmed " + JSON.stringify(yearTrim.trimmedYears)); }

        claude.title = alignTitleYearRange(claude.title, rows);

        // Step 5: Build chart config + metadata
        const chartConfig = buildChartConfig(claude, columns, rows, question);
        const chartMeta = isHistorical ? getHistoricalChartMeta(db, sql) : getChartMeta(db, sql);
        if (tab === "current" && implausiblePopulationDenominator(rows, chartMeta?.population, RTCI.latestSamplePopulation)) {
          firedGuardrails.push("implausible-population-denominator");
          console.warn("[query][population-denominator] Implausible population denominator detected");
        }
        const truncated = rows.length >= maxLimit;
        attachChartAuditToPayload({ chartConfig, columns, rows }, { source: tab, requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId });

        // Step 5b2: Single-row trend warning
        const singleRowWarning = checkSingleRowTrend(question, rows.length);
        if (singleRowWarning) {
          claude.explanation = (claude.explanation || "") + "\n\n" + singleRowWarning;
        }

        // Step 5c: Append deterministic RTCI sample disclaimer (server-enforced, model can't skip)
        if (!isHistorical && claude.explanation) {
          const sampleNote = "Note: Current Trends data comes from a sample of agencies with consistent reporting — it does not represent complete state or national totals. For comprehensive state-level estimates, try the Historical Library tab.";
          if (!claude.explanation.includes("sample")) {
            claude.explanation = claude.explanation + "\n\n" + sampleNote;
          }
        }

        // Step 5b3: Deterministic reliability caveat. Computed ONCE, BEFORE the
        // initial result event, so the primary answer is caveated, the cache stores
        // the caveated version, and a failure of both background explanation attempts
        // still leaves the caveat in place. The helper is reused after each refined
        // explanation (and after any grain override, which REPLACES the text) without
        // duplicating the sentence.
        const reliabilityNote = reliabilityDisclosureNote(getDb(), question, sql, rows, tab);
        const withReliabilityNote = (text: string): string => {
          if (!reliabilityNote) return text;
          if (text.includes(reliabilityNote)) return text;
          return text ? `${text} ${reliabilityNote}` : reliabilityNote;
        };
        if (reliabilityNote) {
          claude.explanation = withReliabilityNote(claude.explanation || "");
          if (!firedGuardrails.includes("reliability-disclosed")) firedGuardrails.push("reliability-disclosed");
        }

        // Step 5a2: PROOF FINALIZATION FOR THE FIRST FACTUAL EVENT.
        //
        // This is the defect handoff §4 and §9.1 Stage 1 name explicitly: the
        // initial factual `result` event used to be delivered here, with
        // applyResultDisclosures() running only later on the background explanation
        // update. A validation that runs after the bytes are gone cannot
        // retroactively validate them -- the user has already read the number.
        //
        // So finalization happens BEFORE the enqueue below, and its result is
        // carried forward to whichever writeLog call ends up running (the refined
        // explanation, its retry, or the both-failed fallback). The log still writes
        // exactly one row per request, as it always did.
        // requestedEntities is deliberately NOT supplied: finalizeProof derives it
        // from the parsed request. Deriving it from `sql` -- as this line did -- means
        // the SQL that dropped a city also defines what was "requested", so
        // entityCompleteness passes on a silent omission. See lib/requested-entities.
        const finalization = finalizeExit({
          intendedAction: "answer",
          sql,
          rows,
          columns,
          truncated,
          planFamily: null,
          guardrails: firedGuardrails,
          returnedEntities: returnedEntityKeys(rows),
          // The exact text going out with this event, so omission disclosure is
          // derived from what the user will actually read.
          narrative: claude.explanation,
          hasChart: Boolean(chartConfig),
          chartFromBindings: false,
          retries: proofRetries(),
          db,
        });

        // Step 5b: Send result immediately with pre-query explanation (no waiting)
        controller.enqueue(
          encoder.encode(
            sseEvent(emitFactualPayload(finalization, {
              type: "result",
              requestId: chartAuditRequestId,
              chartAuditSource: tab,
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
            }))
          )
        );

        // Step 6: Generate refined explanation in background, send as update
        // Re-extract context from final SQL (may have been fixed by guardrails/retry)
        const finalCtx = extractQueryContext(sql, guardrailQuestion, tab as "current" | "historical");
        try {
          let postExplanation = await generateExplanation({
            ctx: finalCtx,
            columns,
            rows,
            rowCount: rows.length,
            disclaimers: "",  // let buildDisclaimers handle all disclaimers deterministically
            preQueryExplanation: claude.explanation,
          });
          // Fix national vs cities wording mismatch (e.g., national_clearance_rate described as "across cities")
          if (/\bnational_/i.test(sql) && !/\bagency\s*=/i.test(sql)) {
            postExplanation = postExplanation
              .replace(/\bacross cities\b/gi, "nationally")
              .replace(/\bfor cities\b/gi, "nationally")
              .replace(/\bin cities\b/gi, "nationally");
          }
          // Append RTCI sample disclaimer to post-query explanation too
          if (!isHistorical && postExplanation && !postExplanation.includes("sample")) {
            postExplanation += "\n\nNote: Current Trends data comes from a sample of agencies with consistent reporting — it does not represent complete state or national totals. For comprehensive state-level estimates, try the Historical Library tab.";
          }
          postExplanation = applyResultDisclosures({ explanation: postExplanation, question, sql, rows, tab });
          if (missingLowerBoundNote(question, sql, rows) && !firedGuardrails.includes("lower-bound-disclosed")) firedGuardrails.push("lower-bound-disclosed");
          const grainCheck = validateGrain(question, rows, sql);
          if (!grainCheck.ok && grainCheck.message) {
            postExplanation = grainCheck.message;
            if (!firedGuardrails.includes("grain-mismatch")) firedGuardrails.push("grain-mismatch");
          }
          // The grain override REPLACES the text, so the caveat is reapplied (dedup-guarded).
          postExplanation = withReliabilityNote(postExplanation);
          const safePost = sanitizeUserFacingNarrative(postExplanation, claude.title || "Results");
          postExplanation = safePost.explanation || "";
          if (containsInternalScaffold(postExplanation)) {
            console.log(`[query][internal-scaffold] Stripping scaffold text from post-query explanation`);
            postExplanation = stripInternalScaffold(postExplanation) || claude.explanation;
          }
          // The proof that describes what the user actually ended up reading. Starts as
          // the result event's finalization and is replaced when the narrative is.
          let deliveredFinalization = finalization;
          if (postExplanation !== claude.explanation) {
            // Re-finalized against the REFINED text, not reusing the finalization that
            // gated the result event: this narrative is different, and the difference
            // is exactly what needs proving. A grain override replaces it wholesale.
            const postFinalization = finalizeExit({
              intendedAction: "answer",
              question: guardrailQuestion,
              sql,
              rows,
              columns,
              truncated,
              guardrails: firedGuardrails,
              returnedEntities: returnedEntityKeys(rows),
              narrative: postExplanation,
              hasChart: Boolean(chartConfig),
              retries: proofRetries(),
              db,
            });
            deliveredFinalization = postFinalization;
            controller.enqueue(
              encoder.encode(
                sseEvent(emitFactualPayload(postFinalization, { type: "explanation", text: postExplanation, title: claude.title || "Results" }))
              )
            );
          }
          const totalMs2 = Date.now() - totalStart;
          // postFinalization, not finalization: the refined explanation is the prose the
          // user ends up reading, and persisting the result event's proof instead would
          // give the shadow review a record of text nobody was shown. Falls back to the
          // result finalization when the narrative was not replaced.
          writeLog(question, sql, rows.length, null, totalMs2, postExplanation, tab, finalizeGuardrailTags(firedGuardrails, queryContractGuardrails(runContractValidation(sql || ""))), "haiku-4.5", sessionId, serializeChartConfigForLog(chartConfig, columns, chartMeta), deliveredFinalization);
          // Cache successful responses (only standalone questions)
          if (!fromCache && promptHistory.length === 0 && sql) {
            setCache(question, tab, { sql, explanation: claude.explanation, title: claude.title, chartType: claude.chartHint, xAxis: claude.xAxis, yAxis: claude.yAxis ? claude.yAxis.split(",").map(s => s.trim()) : undefined, yAxisLabel: claude.yAxisLabel, xAxisLabel: claude.xAxisLabel, colors: claude.colors, annotations: claude.annotations }, cacheValidity);
          }
        } catch {
          // Retry post-query explanation once before falling back
          try {
            let retryExplanation = await generateExplanation({
              ctx: finalCtx,
              columns,
              rows,
              rowCount: rows.length,
              disclaimers: "",
              preQueryExplanation: claude.explanation,
            });
            // Fix national vs cities wording mismatch
            if (/\bnational_/i.test(sql) && !/\bagency\s*=/i.test(sql)) {
              retryExplanation = retryExplanation
                .replace(/\bacross cities\b/gi, "nationally")
                .replace(/\bfor cities\b/gi, "nationally")
                .replace(/\bin cities\b/gi, "nationally");
            }
            if (!isHistorical && retryExplanation && !retryExplanation.includes("sample")) {
              retryExplanation += "\n\nNote: Current Trends data comes from a sample of agencies with consistent reporting — it does not represent complete state or national totals. For comprehensive state-level estimates, try the Historical Library tab.";
            }
            retryExplanation = applyResultDisclosures({ explanation: retryExplanation, question, sql, rows, tab });
            if (missingLowerBoundNote(question, sql, rows) && !firedGuardrails.includes("lower-bound-disclosed")) firedGuardrails.push("lower-bound-disclosed");
            const retryGrainCheck = validateGrain(question, rows, sql);
            if (!retryGrainCheck.ok && retryGrainCheck.message) {
              retryExplanation = retryGrainCheck.message;
              if (!firedGuardrails.includes("grain-mismatch")) firedGuardrails.push("grain-mismatch");
            }
            retryExplanation = withReliabilityNote(retryExplanation);
            const safeRetry = sanitizeUserFacingNarrative(retryExplanation, claude.title || "Results");
            retryExplanation = safeRetry.explanation || "";
            if (containsInternalScaffold(retryExplanation)) {
              console.log(`[query][internal-scaffold] Stripping scaffold text from retry explanation`);
              retryExplanation = stripInternalScaffold(retryExplanation) || claude.explanation;
            }
            let deliveredRetryFinalization = finalization;
            if (retryExplanation !== claude.explanation) {
              const retryFinalization = finalizeExit({
                intendedAction: "answer",
                question: guardrailQuestion,
                sql,
                rows,
                columns,
                truncated,
                guardrails: firedGuardrails,
                returnedEntities: returnedEntityKeys(rows),
                narrative: retryExplanation,
                hasChart: Boolean(chartConfig),
                retries: proofRetries(),
                db,
              });
              deliveredRetryFinalization = retryFinalization;
              controller.enqueue(
                encoder.encode(
                  sseEvent(emitFactualPayload(retryFinalization, { type: "explanation", text: retryExplanation, title: claude.title || "Results" }))
                )
              );
            }
            const totalMs2 = Date.now() - totalStart;
            writeLog(question, sql, rows.length, null, totalMs2, retryExplanation, tab, finalizeGuardrailTags(firedGuardrails, queryContractGuardrails(runContractValidation(sql || ""))), "haiku-4.5", sessionId, serializeChartConfigForLog(chartConfig, columns, chartMeta), deliveredRetryFinalization);
          } catch {
            // Both attempts failed — pre-query explanation stays
            const totalMs2 = Date.now() - totalStart;
            writeLog(question, sql, rows.length, null, totalMs2, claude.explanation, tab, finalizeGuardrailTags(firedGuardrails, queryContractGuardrails(runContractValidation(sql || ""))), "haiku-4.5", sessionId, serializeChartConfigForLog(chartConfig, columns, chartMeta), finalization);
          }
          if (!fromCache && promptHistory.length === 0 && sql) {
            setCache(question, tab, { sql, explanation: claude.explanation, title: claude.title, chartType: claude.chartHint, xAxis: claude.xAxis, yAxis: claude.yAxis ? claude.yAxis.split(",").map(s => s.trim()) : undefined, yAxisLabel: claude.yAxisLabel, xAxisLabel: claude.xAxisLabel, colors: claude.colors, annotations: claude.annotations }, cacheValidity);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const ms = Date.now() - totalStart;
        writeLog(question, sql, 0, msg, ms, null, tab, finalizeGuardrailTags(firedGuardrails, queryContractGuardrails(runContractValidation(sql || ""))), "haiku-4.5", sessionId, null, finalizeExit({ intendedAction: "decline_capability", sql, guardrails: firedGuardrails, retries: proofRetries() }));
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
