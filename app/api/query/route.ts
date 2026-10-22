import { NextRequest } from "next/server";
import { applySpellingCorrections, runWithSpellingContext, withSpellingNote } from "@/lib/spelling-corrections";
import { getDb, logQuery } from "@/lib/rtci-db";
import { validatePageToken } from "@/lib/page-token";
import { translateToSql, getHistoricalSystemPrompt } from "@/lib/claude";
import { validateAndSanitize } from "@/lib/sql-safety";
import { validateSqlSchema } from "@/lib/schema-validation";
import { executeWithTimeoutSync, executeManyWithTimeoutSync } from "@/lib/query-timeout";
import { buildChartConfig } from "@/lib/chart-config";
import { serializeChartConfigForLog } from "@/lib/chart-config-log";
import { attachChartAuditToPayload, createChartAuditRequestId } from "@/lib/chart-audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { isInnerRun, recordWhyNotes, recordWhyFacts, carriedOutcome } from "@/lib/why-context";
import { handleWhyTurn, innerRequest } from "@/lib/why-turn";
import { checkSessionLimit, maybeCleanup } from "@/lib/captcha";
import { HISTORICAL, RTCI } from "@/lib/dynamic-facts";
import { generateExplanation, sanitizeExplanation } from "@/lib/explain";
import { historicalRapeSeries } from "@/lib/historical-rape-series";
import { historicalViolentComposite } from "@/lib/historical-composite-measure";
import { chicagoAssaultNarrative, withChicagoAssaultComparability } from "@/lib/chicago-assault-comparability";
import { buildHistoricalNationalViolentCountPlan, nationalViolentDeclinePlan } from "@/lib/historical-national-violent";
import { buildHistoricalNationalViolentRatePlan, nationalViolentRateDeclinePlan, nationalViolentRateDisclosureQuestion, nationalViolentRateEmptyNote, nationalViolentRateLimitation, NATIONAL_VIOLENT_RATE_GUARDRAIL } from "@/lib/historical-national-violent-rate";
import { sexualAssaultRapeNarrative } from "@/lib/historical-offense-binding";
import { extractQueryContext } from "@/lib/query-context";
import { runGuardrails } from "@/lib/guardrails";
import { finalizeGuardrailTags, mergeGuardrailTags } from "@/lib/guardrail-tag-state";
import { asksForCountsInsteadOfRates } from "@/lib/rate-intent";
import { applyRetryMeta } from "@/lib/types";
import type { StreamEvent, ChartMeta, ChartConfig } from "@/lib/types";
import { getCached, setCache } from "@/lib/response-cache";
import { detectAllNullData } from "@/lib/all-null-detection";
import { checkSingleRowTrend } from "@/lib/single-row-trend";
import { parseRoutingLogMeta } from "@/lib/routing-log-meta";
import { answerMetadataQuestion } from "@/lib/metadata-coverage";
import { validateTablesForTab } from "@/lib/table-allowlist";
import { alignTitleYearRange, applyResultDisclosures, missingLowerBoundNote, returnedEntityKeys, trimTrailingEmptyYearRows, withReturnedCoverage } from "@/lib/result-disclosure";
import { withholdUnverifiedChange, appendWithheldChangeNote, applyPeriodDisclosure } from "@/lib/period-comparison";
import { validateGrain } from "@/lib/requested-grain";
import { normalizeHistoryAllSources, normalizeHistoryForTab } from "@/lib/chat-history";
import { applyGeoCorrection, geoCorrectionHint } from "@/lib/geo-correction";
import { containsInternalLeak, INTERNAL_LEAK_SAFE_MESSAGE, sanitizeUserFacingNarrative, sanitizeChartConfigTitle} from "@/lib/scaffold-helpers";
import { buildNoSqlFallbackMessage, courtProcessNoSqlIsTerminal, selectNoSqlRefusal } from "@/lib/refusal-safety";
import { boundedModelResponseJson } from "@/lib/no-sql-retry";
import { buildCompletenessAnswer, detectCompletenessQuestion, loadCompletenessRows } from "@/lib/completeness-intent";
import { CURRENT_MONTH_COVERAGE_GUARDRAIL, MONTH_COVERAGE_FAILED, monthCoverageAnswer, monthCoverageSql, ownsMonthCoverage } from "@/lib/current-month-coverage";
import { resolveCurrentFollowupAmendment } from "@/lib/current-followup-amendment";
import { getBlockingGeoClarification } from "@/lib/geo-resolver";
import { getCountyScopeClarification } from "@/lib/county-clarifier";
import { currentTrendsResultState, genericResultState } from "@/lib/result-state-adapters";
import { governFactualNarrative } from "@/lib/result-state";
import type { ResolvedAgency } from "@/lib/agency-disclosure";
import { shouldAskCrimeType } from "@/lib/crime-type-clarification";
import { detectCurrentYearClearanceOverride, detectDemographicRateDenominatorFollowup, detectDemographicHomicideRateOverride, detectSubCityGeographyOverride } from "@/lib/capability-overrides";
import { historicalYearAvailability } from "@/lib/year-availability";
import { reliabilityDisclosureNote } from "@/lib/reliability-disclosure";
import {
  queryContractFailureMessage,
  queryContractGuardrails,
  validateQueryContractSql,
  type QueryContractSqlValidation,
  capabilityFinalizationOutcome,
} from "@/lib/query-contract-validator";
import { partialCoverageRetryPrompt } from "@/lib/source-year-overlap";
import { resolveGeoPlaces } from "@/lib/geo-place-resolver";
import { isFollowUp } from "@/lib/tab-suggest";
import { buildHistoricalCityChangeRankingPlan, buildHistoricalLocalRecentChangePlan } from "@/lib/historical-deterministic-queries";
import { buildHistoricalPeerComparisonPlan } from "@/lib/historical-peer-comparison";
import { verifyPeerMembership } from "@/lib/peer-comparison";
import { fetchHistoricalPeerCandidates, resolveHistoricalSubjectPopulation } from "@/lib/peer-adapters";
import { buildMultiCityTrendPlan, relativePeriodShortfallNote } from "@/lib/multi-city-deterministic";
import { historicalBaltimoreComparisonDefault, withBaltimoreDisclosure, withoutBaltimoreDisclosure } from "@/lib/historical-baltimore-comparison";
import { buildCurrentIndexedStatePlan } from "@/lib/current-indexed-state-deterministic";
import { recognizeCityRanking, rankingValidationContract } from "@/lib/city-ranking";
import { buildCityRanking } from "@/lib/city-ranking-builder";
import { completenessOf, decideCandidates } from "@/lib/city-ranking-completeness";
import { RTCI_DATA_CUTOFF } from "@/lib/dynamic-facts";
import {
  buildCurrentYoyComparisonPlan,
  buildCurrentYoyComparisonAnswer,
  buildCurrentYoyGroup,
  answerCoversRequiredCells,
  type CurrentYoyAnswerRow,
  type CurrentYoyPeriodRow,
  type CurrentYoyMembershipRow,
  type CurrentYoySampleRow,
  type CurrentYoyGroup,
} from "@/lib/current-yoy-comparison-deterministic";
import { deterministicPlanRefusal } from "@/lib/deterministic-plan-guard";
import { detectQueryBearingFollowup } from '@/lib/query-bearing-followup';
import { planFollowupSafe } from '@/lib/followup-planner';
import { plannerModeForSource } from '@/lib/followup-planner-mode';
import { findVerifiedCurrentAgency } from '@/lib/current-agency-availability';
import { explainEmptyCurrentTrendsResult } from "@/lib/current-trends-empty-reason";
import { neutralizeUnverifiedAvailabilityClaim } from "@/lib/refusal-safety";
import { implausiblePopulationDenominator } from "@/lib/rate-denominator-safety";
import { buildHistoricalScorecard } from "@/lib/historical-scorecard";
import { accountHistoricalRequest, historicalRecognitionRefusal, historicalRequestKind, HISTORICAL_CACHE_TAB, HISTORICAL_MODEL_SQL_DECLINE, historicalFollowupCheck } from "@/lib/historical-request-accounting";
import { accountCurrentRequest, currentRecognitionRefusal, currentRequestKind, currentFollowupCheck, CURRENT_CACHE_TAB, CURRENT_MODEL_SQL_DECLINE } from "@/lib/current-request-accounting";
import { currentLegacyBound, currentUnboundParts, currentExplainLimitation, placeIs as currentPlaceIs, type CurrentApplied } from "@/lib/current-legacy-binding";
import { matchCurrentType, OFFENSES_OF as CURRENT_OFFENSES_OF } from "@/lib/current-question-types";
import { compileCurrentSpec } from "@/lib/current-question-compiler";
import { resolveFollowupRequest } from "@/lib/current-effective-request";
import { matchHistoricalType } from "@/lib/historical-question-types";
import { compileHistoricalSpec, historicalSourceBounds } from "@/lib/historical-question-compiler";
import { historicalLegacyBound, measureForOffenseColumn, placeIs, rangeKeys, type LegacyApplied } from "@/lib/historical-legacy-binding";
import { refusalSentences, type Part as AccountingPart } from "@/lib/request-accounting";
import {
  consolidatedDisplayText,
  consolidationTargetSatisfied,
  findConsolidatedAgency,
  normalizeConsolidatedDisplayRows,
} from "@/lib/agency-consolidations";
import { historicalCountyAgencyPredicate } from "@/lib/historical-county-identity";
import { getHistoricalCountyAgencyDecision } from "@/lib/historical-county-choice";
import { applyAuthoritativeIdentity, lookupAuthoritativeAgency } from "@/lib/authoritative-agency-label";
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
import { readCorrectionState, executeWithCorrectionState, withHistoricalNationalRapeNotes, historicalCacheValidity, withTypedHistoricalRapeNotes, typedCorrectionState, TYPED_STATE_CHANGED } from "@/lib/historical-national-rape";
import { OUTCOMES, type QueryLogOutcome, SourceId } from "@/lib/proof-contract";
import type { QueryContract } from "@/lib/query-contract";

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
  // Option 3 batch 1: the stated reading of a corrected misspelling, on every delivered text (lib/spelling-corrections.ts).
  if (payload.type === "result" && typeof payload.explanation === "string") payload.explanation = withSpellingNote(payload.explanation) ?? payload.explanation;
  if ((payload.type === "explanation" || payload.type === "error") && typeof payload.text === "string") payload.text = withSpellingNote(payload.text) ?? payload.text;
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

/**
 * Request accounting, stage 2a (K7): no model-written statement ever runs on the Historical tab. Numbers come only from a
 * fixed path that applies the whole request or from a supported question type (lib/historical-question-types.ts).
 */
const HISTORICAL_MODEL_SQL_NEVER_RUNS: boolean = true;

/**
 * Request accounting, stage 3a (plan 2026-10-10-request-accounting-stage3a-current.md §6): no model-written statement ever
 * runs on the Current Trends tab, and the model is never asked again for one. Numbers come only from a fixed path that
 * applies the whole request (and the owner policy) or from a supported question type (lib/current-question-types.ts).
 */
const CURRENT_MODEL_SQL_NEVER_RUNS: boolean = true;

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
        : candidate.kind === "county"
          // A county is addressed through the FIPS crosswalk, never by name. The importer
          // this replaces renamed 3,126 county agencies -- `Jefferson` to `Jefferson County`,
          // `Jacksonville Sheriff's Office` to `Jacksonville County` -- so a name predicate
          // matches one database and not the other. The ORI is the same in both.
          ? `AND ${historicalCountyAgencyPredicate(candidate.state, candidate.name)}`
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

// Option 3 batch 1: each request runs in its own spelling context (lib/spelling-corrections.ts).
export async function POST(req: NextRequest) {
  return runWithSpellingContext(() => handleQueryPost(req));
}

async function handleQueryPost(req: NextRequest) {
  const encoder = new TextEncoder();
  const totalStart = Date.now();
  const MAX_REQUEST_MS = 60000; // 60s total budget — no retries after this
  const isOverBudget = () => Date.now() - totalStart > MAX_REQUEST_MS;

  // Rate limiting
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  // Stage 3b (r1.4 R4.2): an inner run of a "why" turn was admitted by its outer request; never charged twice.
  const rateCheck: ReturnType<typeof checkRateLimit> = isInnerRun() ? ({ allowed: true, remaining: 0 } as ReturnType<typeof checkRateLimit>) : checkRateLimit(ip);
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
    // Option 3 batch 1: the closed misspelling list, corrected before anything reads the question.
    if (question) question = applySpellingCorrections(question);
    sessionId = ((body?.sessionId as string) || "").slice(0, 64) || null;
    // Page token validation — block bots that hit the API directly
    const pageToken = body?.pageToken as string | undefined;
    if (!isInnerRun() && !validatePageToken(pageToken)) {
      return new Response(
        JSON.stringify({ success: false, error: "Please refresh the page and try again." }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // Session-based CAPTCHA throttle
    maybeCleanup();
    const captchaCheck: ReturnType<typeof checkSessionLimit> = isInnerRun() ? ({ allowed: true } as ReturnType<typeof checkSessionLimit>) : checkSessionLimit(sessionId);
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
  // What the user typed. The Baltimore comparison default below replaces `question` for every
  // consumer; the query log keeps this.
  const recordedQuestion = question;
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
    proof: ProofFinalization | OutcomeLogRecord | null = null,
    /** Bounded raw model text on no-SQL failures; diagnostic only, never user-visible. */
    modelResponseJson: string | null = null
  ) => {
    chartAuditQueryLogId = logQuery(q === question ? recordedQuestion : q, sqlText, rowCount, logError, ms, logResponse, tabName, guardrails, model, sid, routingMeta, chartConfigJson, chartAuditRequestId, modelResponseJson, proofLogFields(decisionFinalization(proof)), outcomeLogFields(asOutcomeRecord(proof)));
    return chartAuditQueryLogId;
  };

  const tab = body?.mode === "historical" ? "historical" : "current";

  // GC-098 (Codex design ruling 2026-09-26, option A, Historical only): bare "Baltimore" compared
  // with one other unambiguous city means Baltimore city. The city-qualified request replaces
  // `question` here, before any consumer reads it -- the geographic gate, deterministic builders,
  // model instruction, contract validation and proof all see the same request -- and every exit
  // that can answer it carries the application-owned disclosure. Standalone "Baltimore" still asks.
  const baltimoreDefault = tab === "historical" ? historicalBaltimoreComparisonDefault(question) : null;
  if (baltimoreDefault) question = baltimoreDefault.effectiveQuestion;

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
  const baseCacheValidity = cacheValiditySignature(proofSourceId, null);
  // Historical national rape fix (amendment 3): on the Historical model path this becomes
  // historicalCacheValidity(base, state) -- base unchanged while uncorrected, a mode-independent `|hnr=1` suffix once
  // corrected -- set from a pre-read before the cache lookup, then from the answer's own snapshot before the store.
  let cacheValidity = baseCacheValidity;

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
  // The effective request, when a Current follow-up was built by amendment. Set beside
  // proofQuestion so every later exit reasons about the same request the validator checked.
  let proofContract: QueryContract | null = null;
  const finalizeExit = (
    opts: Partial<ProofFinalizationInput> & { outcome: QueryLogOutcome },
  ): ProofFinalization =>
    finalizeProof({
      sourceId: proofSourceId,
      question: proofQuestion,
      contract: proofContract,
      sql: null,
      rows: [],
      columns: [],
      truncated: false,
      planFamily: null,
      ...opts,
    });
  // Stage 3b (plan §4, r1.4, amendment A1): ONE early branch for a "why" turn. Its data part -- the masked question of a
  // mixed turn, or the rebuilt earlier question of a why-only turn -- runs as an inner re-entry of this route, whose
  // emissions are captured at the proof chokepoints and never delivered. The outer turn composes the text, finalizes it
  // as the narrative, logs once and emits once, outside the inner run.
  if (!isInnerRun()) {
    const why = await handleWhyTurn(recordedQuestion, body?.history, {
      tab: tab === "historical" ? "historical" : "current",
      reenter: async (q, h) => { const res = await POST(innerRequest(req, body, q, h) as NextRequest); await res.text(); },
    });
    if (why) {
      const ms = Date.now() - totalStart;
      // R2.6': a captured inner answer (with its matched input) keeps ITS OWN disposition -- an answer stays an answer, a
      // clarification a clarification, a decline a decline; composition only appends sentences. Anything else (no capture,
      // or no matched input) goes to the text exit and is never a carried success.
      if (why.kind === "data" && why.capture.input) {
        const cap = why.capture;
        const whyRows = Array.isArray(cap.payload.rows) ? (cap.payload.rows as unknown[]) : [];
        const whyProof = finalizeExit({ ...(cap.input as Partial<ProofFinalizationInput>), outcome: carriedOutcome<QueryLogOutcome>(cap.input), narrative: why.text });
        writeLog(recordedQuestion, (cap.payload.sql as string | null) ?? null, whyRows.length, null, ms, why.text, tab, why.tags, "deterministic", sessionId, null, whyProof);
        const whyPayload = { ...cap.payload, type: "result" as const, explanation: why.text } as unknown as FactualStreamEvent;
        const whyStream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(whyProof, whyPayload))));
            controller.close();
          },
        });
        return new Response(whyStream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
      }
      const answered = why.kind === "text" && why.answered;
      const whyTextProof = finalizeExit({ planFamily: "why-turn", guardrails: why.tags, outcome: answered ? OUTCOMES.deterministic_plan : OUTCOMES.capability_path_unavailable, narrative: why.text });
      writeLog(recordedQuestion, null, 0, null, ms, why.text, tab, why.tags, "deterministic", sessionId, null, whyTextProof);
      const whyTextPayload = { type: "result" as const, sql: null as unknown as string, explanation: why.text, title: answered ? "Explanation" : "Not answered", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: ms } as unknown as FactualStreamEvent;
      const whyTextStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(whyTextProof, whyTextPayload))));
          controller.close();
        },
      });
      return new Response(whyTextStream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
    }
  }
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
    const proof = finalizeExit({ outcome: OUTCOMES.source_switch, planFamily: "followup-source-switch" });
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
      outcome: OUTCOMES.capability_path_unavailable,
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

  // ── Request accounting, stage 2a (Historical; plan 2026-10-08-request-accounting-stage2a-historical.md r1.1) ──────
  // ONE ledger, on the effective question, before any exit that can deliver a number (C1). Every non-context part must
  // be applied by value by whichever path answers: a fixed path whose own plan used it, or a supported type (H1-H6).
  // Recognition refusals (topics Historical does not record, words it could not interpret) stop a NUMERIC request here.
  // The two U.S. violent-crime series own their whole turn by their own accepted grammar, so they keep their path.
  const historicalLedger = tab === "historical" ? accountHistoricalRequest(capabilityQuestion) : null;
  const historicalWholeTurn = tab === "historical" && !queryBearingFollowup
    && Boolean(buildHistoricalNationalViolentCountPlan(question) ?? buildHistoricalNationalViolentRatePlan(question));
  const historicalNumeric = Boolean(historicalLedger && historicalRequestKind(historicalLedger) === "numeric" && !historicalWholeTurn);
  /** The one sealed exit for every Historical accounting decline or clarification (recognition, follow-up, types). */
  // Option 3 batch 1 (codex build ruling item 3): a question about causes, effects or correlation gets the causal limitation
  // beside whatever else declines it (a lookup, a combination, a policy topic), never instead of it.
  const HISTORICAL_CAUSAL_LIMIT = "I also can't say what causes crime or what it is correlated with: Historical records reported crimes, not their causes.";
  const historicalAsksCause = Boolean(historicalLedger?.parts.some((p) => p.concept === "explain"));
  const historicalAccountingExit = (refusalIn: { parts: AccountingPart[]; explanation: string }, owner: string, clarify = false) => {
    const refusal = historicalAsksCause && !refusalIn.explanation.includes(HISTORICAL_CAUSAL_LIMIT)
      ? { ...refusalIn, explanation: `${refusalIn.explanation} ${HISTORICAL_CAUSAL_LIMIT}` }
      : refusalIn;
    const ms = Date.now() - totalStart;
    const tags = ["request-accounting", `request-accounting-owner:${owner}`, ...refusal.parts.map((p) => `request-accounting:${p.state}:${p.concept}`)];
    const accountingProof = finalizeExit({ outcome: clarify ? OUTCOMES.measure_ambiguous : OUTCOMES.capability_path_unavailable, planFamily: "request-accounting", guardrails: tags });
    writeLog(question, null, 0, null, ms, refusal.explanation, tab, tags, "deterministic", sessionId, null, accountingProof);
    const accountingStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(accountingProof, {
          type: "result", sql: null as unknown as string, explanation: refusal.explanation, title: clarify ? "Clarification needed" : "Not answered",
          columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: ms,
        }))));
        controller.close();
      },
    });
    return new Response(accountingStream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
  };
  if (historicalNumeric && historicalLedger) {
    const priorHistoricalTurns = normalizeHistoryForTab(body?.history, "historical", 50).filter((m) => m.role === "user").map((m) => m.content);
    const isHistoricalFollowup = priorHistoricalTurns.length > 0 && (isFollowUp(question) || Boolean(queryBearingFollowup) || followupPlan?.kind === "query_bearing");
    if (isHistoricalFollowup) {
      const carried = historicalFollowupCheck({ question, reconstructed: followupPlan?.kind === "query_bearing" ? followupPlan.reconstructedQuestion : null, previousUserTurns: priorHistoricalTurns, isFollowUp });
      if (carried) return historicalAccountingExit({ parts: [], explanation: carried.explanation }, "followup");
    }
    const recognitionRefusal = historicalRecognitionRefusal(historicalLedger);
    if (recognitionRefusal) return historicalAccountingExit(recognitionRefusal, "recognition");
  }

  // ── Request accounting, stage 3a (Current Trends; plan 2026-10-10-request-accounting-stage3a-current.md r1.2) ─────────
  // ONE ledger, on the EFFECTIVE request (r1.1 F5: the same resolution the model-path guardrails read), before any exit
  // that can deliver a number. A follow-up is checked against a complete earlier question (K2). Fixed paths own a request
  // only when their applied values account for every part AND the owner policy allows them (r1.1 F1). Recognition refusals
  // are applied at the typed stage, after the fixed paths' own declines (a refused part can never be applied, so no
  // fixed path can deliver a number for it).
  const currentAmendment = resolveCurrentFollowupAmendment(question, body?.history, tab === "historical" ? "historical" : "current");
  const followupResolution = resolveFollowupRequest({
    question, rawHistory: body?.history, source: tab === "historical" ? "historical" : "current",
    authoritative: plannerMode === "authoritative" && followupPlan?.kind === "query_bearing" ? followupPlan : null,
    amendment: currentAmendment,
  });
  const currentLedger = tab === "current" ? accountCurrentRequest(followupResolution.question) : null;
  const currentNumeric = Boolean(currentLedger && currentRequestKind(currentLedger) === "numeric");
  /** The sealed exit for every Current accounting decline or clarification (the Historical exit's shape). */
  const currentAccountingExit = historicalAccountingExit;
  if (currentLedger) {
    // A continuation of a question asked on another tab is rebuilt as a context summary, not a complete question, so it
    // can't be answered here by value: it is declined by name (the 2a rule for a follow-up nothing rebuilt).
    if (followupResolution.resolver === "cross-source" && currentNumeric) {
      return currentAccountingExit({ parts: [], explanation: "This continues a question from another tab, and I can't rebuild it here as a complete Current Trends question. Please ask it here as a complete question (the place, what to count and the period)." }, "followup");
    }
    const priorCurrentTurns = normalizeHistoryForTab(body?.history, "current", 50).filter((m) => m.role === "user").map((m) => m.content);
    const rebuilt = followupResolution.resolver !== null;
    const isCurrentFollowup = priorCurrentTurns.length > 0 && (isFollowUp(question) || Boolean(queryBearingFollowup) || followupPlan?.kind === "query_bearing" || rebuilt);
    if (isCurrentFollowup && (currentNumeric || rebuilt)) {
      const carried = currentFollowupCheck({ question, effective: rebuilt ? followupResolution.question : null, previousUserTurns: priorCurrentTurns, isFollowUp, earlierOnly: !currentNumeric });
      if (carried) {
        // A follow-up nothing rebuilt that also names what Current Trends doesn't track says so too.
        const turnRefusal = rebuilt ? null : currentRecognitionRefusal(accountCurrentRequest(question));
        return currentAccountingExit({ parts: turnRefusal?.parts ?? [], explanation: turnRefusal ? `${turnRefusal.explanation} ${carried.explanation}` : carried.explanation }, "followup");
      }
    }
    // What Current Trends doesn't track is declined here, before any clarifying question (the 2a/2b order): asking
    // "violent, property or both?" about juvenile crime asks the wrong question. Words it couldn't interpret are declined
    // at the typed stage instead, after the fixed paths' own declines (the city ranking names them in its own words).
    if (currentNumeric) {
      const notTracked = currentLedger.refusedAtRecognition().filter((p) => p.state === "not-recorded");
      if (notTracked.length) return currentAccountingExit({ parts: notTracked, explanation: refusalSentences(notTracked).join(" ") }, "recognition");
    }
  }
  /** A fixed path keeps a Current request only when its applied values account for every part and the policy allows them. */
  const currentOwns = <T,>(plan: T | null, applied: (p: T) => CurrentApplied | "decline"): T | null => {
    if (!plan || !currentLedger) return plan;
    const a = applied(plan);
    if (a === "decline") return plan;
    if (currentLegacyBound(currentLedger, a)) return plan;
    console.log(`[request-accounting][current] fixed path not owning; unbound: ${currentUnboundParts(currentLedger, a).map((p) => `${p.concept}=${p.value ?? p.text}`).join(", ") || "(owner policy)"}`);
    return null;
  };
  const currentMeasureOf = (offenses: string[]): string | null => Object.entries(CURRENT_OFFENSES_OF).find(([, o]) => o.length === offenses.length && o.every((x) => offenses.includes(x)))?.[0] ?? null;
  /**
   * A fixed path keeps a Historical request only when its applied values account for every part (C1); else null.
   * Plan r3 §1: for EVERY Historical request, whatever its TEXT/NUMERIC classification -- a request carrying "why" is never
   * owned by a fixed path (no path applies an explanation request), so it reaches the types (NUMERIC) or text only (TEXT).
   */
  const historicalOwns = <T,>(plan: T | null, applied: (p: T) => LegacyApplied | "decline"): T | null => {
    if (!plan || !historicalLedger) return plan;
    const a = applied(plan);
    return a === "decline" || historicalLegacyBound(historicalLedger, a) ? plan : null;
  };

  const agencyScorecard = historicalOwns(tab === "historical" ? buildHistoricalScorecard(getDb(), capabilityQuestion) : null, (card) => {
    if (card.rows.length === 0) return "decline";
    const [name, st] = card.agencyLabel.split(/,\s*/);
    return { operations: ["scorecard"], places: card.scope === "national" ? placeIs.national : card.scope === "state" ? placeIs.state(card.agencyLabel) : placeIs.agency(name ?? "", st ?? "") };
  });
  const agencyScorecardRefusal = deterministicPlanRefusal({
    question: capabilityQuestion, source: tab, sql: agencyScorecard?.sql,
  });
  if (agencyScorecardRefusal) {
    console.log(`[structural] agency scorecard refused: ${agencyScorecardRefusal.ruleIds.join(", ")}`);
  }
  if (agencyScorecard && !agencyScorecardRefusal) {
    const ms = Date.now() - totalStart;
    // Scope-prefixed so agency cards keep their historical tag strings ("agency-scorecard-…")
    // and log analyses over them stay valid; state/national get their own partitions.
    const scorecardTag = agencyScorecard.rows.length > 0
      ? `${agencyScorecard.scope}-scorecard-deterministic`
      : `${agencyScorecard.scope}-scorecard-unavailable`;
    // Factual deterministic exit: finalized BEFORE the event is constructed.
    const proof = finalizeExit({
      outcome: agencyScorecard.rows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
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

  // GC-051 batch (lib/current-month-coverage.ts): a standalone Current Trends "what months does YEAR include?" is answered
  // from the year-bound months present in national_monthly -- proved before it runs, and with "no months" and "the check
  // failed" kept apart. Owned only with no conversation history; every other turn continues exactly as before.
  // Stage 3a: bound by value (the coverage operation and the year it reads).
  const monthCoverage = tab === "current" ? currentOwns(ownsMonthCoverage(question, body?.history), (mc) => ({ operations: ["coverage-lookup"], periodValues: [`year:${mc.year}`] })) : null;
  if (monthCoverage) {
    const monthCoveragePlan = { sql: monthCoverageSql(monthCoverage.year) };
    const monthCoverageRefusal = deterministicPlanRefusal({ question, source: tab, sql: monthCoveragePlan.sql });
    let coverageRows: Record<string, unknown>[] | null = null;
    if (!monthCoverageRefusal) {
      try {
        const db = getDb();
        coverageRows = executeWithTimeoutSync<Record<string, unknown>>(db, db.prepare(monthCoveragePlan.sql), 30000);
      } catch (err) {
        console.warn("[current-month-coverage] owned coverage read failed", err);
      }
    }
    const ms = Date.now() - totalStart;
    const coverageTitle = `Current Trends months, ${monthCoverage.year}`;
    // Exit 1: a refused or failed read -- the check failed. Never "no months", never model SQL.
    if (coverageRows === null) {
      const failedGuardrails = [CURRENT_MONTH_COVERAGE_GUARDRAIL, monthCoverageRefusal ? "month-coverage-structural-refusal" : "month-coverage-read-failed"];
      const failedAnswer = MONTH_COVERAGE_FAILED(monthCoverage.year);
      const failedProof = finalizeExit({ outcome: monthCoverageRefusal ? OUTCOMES.sql_shape_rejected : OUTCOMES.capability_path_unavailable, sql: monthCoveragePlan.sql, planFamily: CURRENT_MONTH_COVERAGE_GUARDRAIL, guardrails: failedGuardrails, narrative: failedAnswer });
      writeLog(question, null, 0, "month_coverage_unavailable", ms, failedAnswer, tab, failedGuardrails, "deterministic", sessionId, null, failedProof);
      const failedStream = new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(failedProof, {
          type: "result", sql: null as unknown as string, explanation: failedAnswer, title: coverageTitle,
          columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: ms,
        }))));
        controller.close();
      }});
      return new Response(failedStream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
    }
    // Exit 2: the read's result -- the requested year's months, or none for that year.
    const coverageAnswer = monthCoverageAnswer(monthCoverage.year, coverageRows);
    const coverageProof = finalizeExit({
      outcome: coverageRows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
      sql: monthCoveragePlan.sql, rows: coverageRows, columns: ["month"], truncated: false,
      derivation: sealPlanDerivation(CURRENT_MONTH_COVERAGE_GUARDRAIL, monthCoveragePlan.sql),
      planFamily: CURRENT_MONTH_COVERAGE_GUARDRAIL, guardrails: [CURRENT_MONTH_COVERAGE_GUARDRAIL], narrative: coverageAnswer, hasChart: false,
    });
    writeLog(question, monthCoveragePlan.sql, coverageRows.length, null, ms, coverageAnswer, tab, [CURRENT_MONTH_COVERAGE_GUARDRAIL], "deterministic", sessionId, null, coverageProof);
    const coverageStream = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(coverageProof, {
        type: "result", sql: monthCoveragePlan.sql, explanation: coverageAnswer, title: coverageTitle,
        columns: ["month"], rows: coverageRows, rowCount: coverageRows.length, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: ms,
      }))));
      controller.close();
    }});
    return new Response(coverageStream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
  }

  const completenessIntent = detectCompletenessQuestion(capabilityQuestion);
  // Plan r3 §1: bound for every Historical request, not only NUMERIC ones.
  const completenessOwned = (!(tab === "historical" && historicalLedger)
    || historicalLegacyBound(historicalLedger, { operations: ["completeness"], periodKeys: completenessIntent?.year ? [`year:${completenessIntent.year}`] : [] }))
    // Stage 3a: bound the same way on Current.
    && Boolean(currentOwns(completenessIntent, (ci) => ({ operations: ["completeness"], periodValues: ci.year ? [`year:${ci.year}`] : [] })));
  if (completenessIntent && (tab === "current" || tab === "historical") && completenessOwned) {
    const source = tab === "historical" ? "historical" : "current";
    const completenessAnswer = buildCompletenessAnswer(source, loadCompletenessRows(source, getDb()), new Date().getFullYear(), completenessIntent.year);
    const ms = Date.now() - totalStart;
    // Factual: it states coverage facts about the source, deterministically derived
    // from the completeness tables even though it returns no result rows.
    const proof = finalizeExit({
      outcome: OUTCOMES.deterministic_plan,
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

  // Which agency, once the scope question is settled. About seventy counties are policed by
  // both a sheriff's office and a county police department, under separate ORIs; running SQL
  // that matches both and taking the first is how one of them gets published as "the" county
  // agency. Detected here rather than left to the prompt, and before any factual SQL.
  const countyAgency = tab === "historical" && !getBlockingGeoClarification(question)
    ? getHistoricalCountyAgencyDecision(getDb(), question, body?.history)
    : { kind: "none" as const };
  // A resolved choice is not a clarification -- it is the ORI every later query must use.
  const requiredCountyOri = countyAgency.kind === "resolved" ? countyAgency.ori : null;
  // And the name that goes with it comes from the database, not from what anyone called it.
  const requiredAgencyRecord = requiredCountyOri ? lookupAuthoritativeAgency(getDb(), requiredCountyOri) : null;
  // A resolved ORI the Historical agency table does not hold has no authoritative name. Rather
  // than answer and let the narrative call it whatever the conversation last called it, decline.
  // Unreachable while resolution reads that same table -- kept because the alternative to an
  // authoritative label must never be a plausible one.
  const missingAuthoritativeIdentity = Boolean(requiredCountyOri) && !requiredAgencyRecord
    ? {
        kind: "unresolved" as const,
        id: `county-agency-${String(requiredCountyOri).toLowerCase()}-unidentified`,
        explanation:
          `I resolved this question to one specific agency (ORI ${requiredCountyOri}), but the `
          + `Historical agency file has no record for it, so I cannot say which agency the figures `
          + `would belong to. I did not answer rather than label them from the conversation.`,
      }
    : null;
  const countyAgencyStop = missingAuthoritativeIdentity
    ?? (countyAgency.kind === "clarify" || countyAgency.kind === "unresolved" ? countyAgency : null);
  const countyScope = (getBlockingGeoClarification(question) || queryBearingFollowup || countyAgencyStop)
    ? null
    : getCountyScopeClarification(question, body?.history);
  if (countyAgencyStop) {
    const ms = Date.now() - totalStart;
    // `clarify` asks a question; `unresolved` reports that the data cannot answer the one
    // already asked. Neither runs SQL, and they are logged apart so the difference is visible.
    const outcome = countyAgencyStop.kind === "clarify" ? OUTCOMES.place_unresolved : OUTCOMES.agency_identity_unavailable;
    const proof = finalizeExit({ outcome, planFamily: `geo:${countyAgencyStop.id}` });
    writeLog(question, null, 0, null, ms, countyAgencyStop.explanation, tab, [`geo:${countyAgencyStop.id}`], "deterministic", sessionId, null, proof);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, {
          type: "result",
          sql: null as unknown as string,
          explanation: countyAgencyStop.explanation,
          title: "",
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          chartConfig: null,
          chartMeta: null,
          executionTimeMs: ms,
        }))));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
  }
  if (countyScope) {
    const ms = Date.now() - totalStart;
    const proof = finalizeExit({ outcome: OUTCOMES.geography_scope_ambiguous, planFamily: `geo:${countyScope.id}` });
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

  // ── Increment 3 (Decision 9): violent / property / both ──────────────────────
  // A bare "crime" question is answered by silently choosing a definition, and violent
  // and property crime move in different directions. Ask once, then proceed. Geographic
  // ambiguity is resolved first (above), so we never stack two questions on one turn.
  // A query-bearing follow-up must NOT skip the gate. If the first turn resolved a place
  // ambiguity ("which Kansas City?"), the crime type is still unchosen, and skipping here
  // let the next turn proceed without ever asking. Evaluate the RECONSTRUCTED question so
  // the follow-up is judged with its inherited context. Geography still asks first, so
  // only one question is ever put to the user in a turn.
  const crimeTypeQuestion = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing" && !followupPlan.chartOnly)
    ? followupPlan.reconstructedQuestion
    : question;
  const crimeTypeAsk = getBlockingGeoClarification(crimeTypeQuestion)
    ? null
    : shouldAskCrimeType(crimeTypeQuestion, normalizeHistoryAllSources(body?.history));
  // Stage 3a (owner list, C3): an "overview" names all seven offenses, so it doesn't ask violent, property or both.
  // Option 3 batch 1 (P175): a causal question, or one naming something Historical doesn't record, is not a measure choice;
  // its refusal (with the causal limitation) answers it rather than "violent, property, or both?".
  const historicalNotAMeasureChoice = Boolean(historicalLedger?.parts.some((p) => p.concept === "explain" || p.state === "not-recorded"));
  if (crimeTypeAsk?.needsClarification && !currentLedger?.parts.some((p) => p.concept === "overview") && !historicalNotAMeasureChoice) {
    const ms = Date.now() - totalStart;
    const proof = finalizeExit({ outcome: OUTCOMES.measure_ambiguous, planFamily: "crime-type:violent-property-both" });
    writeLog(question, null, 0, null, ms, crimeTypeAsk.clarificationQuestion, tab, ["crime-type:violent-property-both"], "deterministic", sessionId, null, proof);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, {
          type: "result",
          sql: null as unknown as string,
          explanation: crimeTypeAsk.clarificationQuestion,
          title: "",
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          chartConfig: null,
          chartMeta: null,
          executionTimeMs: ms,
        }))));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
  }

  const geoClarification = (plannerMode === "authoritative" && followupPlan?.kind === "query_bearing") ? (followupPlan.chartOnly ? null : getBlockingGeoClarification(followupPlan.reconstructedQuestion)) : getBlockingGeoClarification(question);
  if (geoClarification) {
    const ms = Date.now() - totalStart;
    const proof = finalizeExit({ outcome: OUTCOMES.geography_ambiguous, planFamily: `geo:${geoClarification.issue.id}` });
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

  // ── GC-070: an amendment this turn cannot safely be composed onto ──────────────────────
  //
  // The composition below carries the reader's established request forward. When one of the turns
  // between the anchor and now cannot be resolved — a year the parser cannot read, or a word with
  // more than one plausible meaning — it is NOT stepped over to reach the older topic. Asking
  // costs a turn; guessing changes the question. Placed after the geographic and crime-type gates,
  // so a turn still puts at most one question to the reader. (Stage 3a r1.1 F5: `currentAmendment` is resolved early, beside
  // the request-accounting boundary; this clarification is still delivered here.)
  if (currentAmendment.kind === "clarify") {
    const ms = Date.now() - totalStart;
    const planFamily = `current-amendment:${currentAmendment.reason}`;
    const proof = finalizeExit({ outcome: OUTCOMES.followup_ambiguous, planFamily });
    writeLog(question, null, 0, null, ms, currentAmendment.question, tab, [planFamily], "deterministic", sessionId, null, proof);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, {
          type: "result", sql: null as unknown as string, explanation: currentAmendment.question,
          title: "", columns: [], rows: [], rowCount: 0, truncated: false,
          chartConfig: null, chartMeta: null, executionTimeMs: ms,
        }))));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
  }

  const historicalAvailability = tab === "historical" ? historicalYearAvailability(question) : null;
  if (historicalAvailability) {
    const ms = Date.now() - totalStart;
    // decline_data, not decline_capability: historicalYearAvailability() establishes
    // deterministically that the source does not cover the requested year, which is
    // the evidence §2.4 requires before stating a source limitation.
    const proof = finalizeExit({
      outcome: OUTCOMES.outside_source_years,
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

  /*
   * City rankings on Current are CONSTRUCTED from a declared request (lib/city-ranking.ts), for the
   * same reason as on NIBRS: the eligibility quantity and the sort quantity are separate fields, so
   * an unrequested floor has nothing to originate from.
   *
   * THIS FAMILY OWNS ITS FAILURES. Unlike the deterministic branches below it, a recognised request
   * that cannot be planned or executed does NOT fall through to the model path. Falling through is
   * how a request with these guarantees quietly becomes generated SQL that has none of them.
   */
  // Stage 3a (r1.1 F1): a recognized ranking delivers only when it applies every part by value; its own declines stand.
  // C4 keeps its accepted coverage disclosure (first and last month per city), the one stated exception to §4.2.
  const cityRanking = tab === "current" ? currentOwns(recognizeCityRanking(question, "current"), (r) => {
    if (r.kind !== "ranking") return "decline";
    const offenseId = r.offense.kind === "current_offense" ? currentMeasureOf([r.offense.value]) : null;
    const floors = r.eligibility.flatMap((e) => (e.kind === "population" && (e.comparison === ">=" || e.comparison === ">") ? [{ op: e.comparison, amount: e.value }] : []));
    return {
      places: r.scope.kind === "nationwide" ? currentPlaceIs.national : currentPlaceIs.state(r.scope.name),
      measures: offenseId ? [offenseId] : [],
      statistic: r.sort.quantity === "rate_per_100k" ? "rate" : r.sort.quantity === "count" ? "count" : null,
      rank: { dir: r.sort.direction === "desc" ? "top" : "bottom", n: r.resultCount },
      periodValues: r.period.kind === "explicit" ? [`year:${r.period.year}`] : [],
      thresholds: floors,
      countThresholds: r.eligibility.flatMap((e) => (e.kind === "count" ? [{ op: e.comparison, amount: e.value }] : [])),
      entities: r.entityLevel === "city" ? ["city"] : ["agency", "city"],
    };
  }) : null;
  if (cityRanking) {
    const built = cityRanking.kind === "ranking"
      ? buildCityRanking(cityRanking, {
          year: RTCI_DATA_CUTOFF.year,
          month: RTCI_DATA_CUTOFF.month,
          // Carried, not dropped: a heuristic cutoff must not become a claim about the data.
          observed: RTCI_DATA_CUTOFF.observed,
        })
      : null;
    const limitation = cityRanking.kind === "unsupported"
      ? cityRanking.explanation
      : built
        ? null
        : "I couldn't establish which year to rank for that request. Name the year and I can build the ranking.";

    const ms0 = Date.now() - totalStart;
    // `!built` is carried in the condition as well as `limitation` so the narrowing below is real
    // rather than implied: after this block the plan is non-null by the type system, not by reading.
    if (limitation || !built) {
      const proof = finalizeExit({ outcome: OUTCOMES.capability_path_unavailable, sql: null, guardrails: ["city-ranking-unavailable"] });
      writeLog(question, null, 0, "city_ranking_unavailable", ms0, limitation ?? "I couldn't build that ranking.", tab, ["city-ranking-unavailable"], "deterministic", sessionId, null, proof);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, {
            type: "result", sql: null as unknown as string, explanation: limitation ?? "I couldn't build that ranking.",
            title: "Ranking Not Available", columns: [], rows: [], rowCount: 0,
            truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: ms0,
          }))));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
          Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining),
        },
      });
    }

    /*
     * S1 FIRST (lib/city-ranking-completeness.ts; Codex combined review, CL3). A city ranking reads its
     * scope-only candidates before the ranked statement: Current carries the type and name on every
     * month row, so an agency recorded as City in some months and as nothing in others would otherwise
     * lose those months to the ranked statement's filter. Disagreeing agencies are excluded from the
     * ranked statement and named; the shared decision says whether the confirmed cities are complete.
     * A reporting-jurisdiction ranking (GC-057) has no completeness plan and is unchanged.
     */
    const cityRankingEvidence = built.completeness ? { sql: built.completeness.candidatesSql } : null;
    // A stated nationwide scope validates against its assembled scope, not the raw national reading.
    const cityRankingContract = rankingValidationContract(question, "current");
    const cityRankingEvidenceRefusal = cityRankingEvidence
      ? deterministicPlanRefusal({ question, source: tab, sql: cityRankingEvidence.sql, contract: cityRankingContract })
      : null;
    let cityRankingDecision: ReturnType<typeof decideCandidates> | null = null;
    let failure: string | null = cityRankingEvidenceRefusal ? "structural-refusal" : null;
    if (cityRankingEvidence && !cityRankingEvidenceRefusal) {
      try {
        const db = getDb();
        cityRankingDecision = decideCandidates(built.completeness!,
          executeWithTimeoutSync<Record<string, unknown>>(db, db.prepare(cityRankingEvidence.sql), 30000));
        if (cityRankingDecision.kind === "inconsistent") failure = "candidates-inconsistent";
      } catch (err) {
        console.warn("[city-ranking] candidates read failed", err);
        failure = "execution-failed";
      }
    }
    const excludedAgencies = cityRankingDecision?.kind === "decided" ? cityRankingDecision.conflicted : [];

    // Named so the execution site reads `cityRankingPlan.sql`: the route-placement accounting
    // classifies executions by that shape, and a `cityRankingPlan.sql` written inline is unrecognisable to it.
    const cityRankingPlan: NonNullable<typeof built> = excludedAgencies.length > 0 && built.completeness
      ? { ...built, sql: built.completeness.ranked(excludedAgencies) }
      : built;
    const cityRankingRefusal = deterministicPlanRefusal({ question, source: tab, sql: cityRankingPlan.sql, contract: cityRankingContract });
    let rows: Record<string, unknown>[] = [];
    let columns: string[] = cityRankingPlan.columns;
    if (!failure && cityRankingRefusal) failure = "structural-refusal";
    if (!failure && !cityRankingRefusal) {
      try {
        const db = getDb();
        rows = executeWithTimeoutSync<Record<string, unknown>>(db, db.prepare(cityRankingPlan.sql), 30000);
        columns = rows.length > 0 ? Object.keys(rows[0]) : cityRankingPlan.columns;
      } catch (err) {
        console.warn("[city-ranking] execution failed", err);
        failure = "execution-failed";
      }
    }
    const cityRankingCompleteness = !failure && cityRankingDecision?.kind === "decided" && cityRankingPlan.completeness
      ? completenessOf(cityRankingPlan.completeness, cityRankingDecision, rows, cityRankingPlan.title)
      : null;
    const cityRankingTitle = cityRankingCompleteness?.title ?? cityRankingPlan.title;
    const cityRankingLead = cityRankingCompleteness && !cityRankingCompleteness.complete
      ? [`${cityRankingTitle}.`, ...cityRankingCompleteness.sentences]
      : [`${cityRankingPlan.title}.`];
    const ms = Date.now() - totalStart;
    if (failure) {
      // Owned failure: an honest limitation about OUR failure, never a claim about the data.
      const explanation =
        "I couldn't complete that ranking. That's a failure on our side, not a statement about what " +
        "the data contains. Try naming the year, or ask for a single city's figures instead.";
      const proof = finalizeExit({ outcome: OUTCOMES.capability_path_unavailable, sql: cityRankingPlan.sql, guardrails: [`city-ranking-${failure}`] });
      writeLog(question, cityRankingPlan.sql, 0, `city_ranking_${failure}`, ms, explanation, tab, [`city-ranking-${failure}`], "deterministic", sessionId, null, proof);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, {
            type: "result", sql: null as unknown as string, explanation,
            title: "Ranking Not Available", columns: [], rows: [], rowCount: 0,
            truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: ms,
          }))));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
          Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining),
        },
      });
    }

    /*
     * DELIVERY MEETS THE SAME OBLIGATIONS AS EVERY OTHER DETERMINISTIC BRANCH.
     *
     * This exit returns long before the model path's disclosure and charting run, and the first
     * version simply emitted its own title and sentences with `chartConfig: null` -- so a ranking
     * that came back empty said only what the builder had composed before it ran, and a ranking
     * that came back full was the one deterministic answer on this tab with no chart. Being
     * hand-built is not an exemption; it just means the obligations have to be met here.
     */
    const cityRankingState = currentTrendsResultState(getDb(), { sql: cityRankingPlan.sql, rows });
    const explanation = applyResultDisclosures({
      explanation: [...cityRankingLead, ...cityRankingPlan.caveats].join(" "),
      question, sql: cityRankingPlan.sql, rows, tab, resultState: cityRankingState,
    });
    const cityRankingChart: ChartConfig | null = rows.length > 0
      ? {
          type: "bar",
          // From the plan: a reporting-jurisdiction ranking charts its distinct label (GC-057).
          xAxis: cityRankingPlan.entityColumn,
          yAxis: [cityRankingPlan.sortColumn],
          title: cityRankingTitle,
          xAxisLabel: cityRankingPlan.entityLabel,
          yAxisLabel: cityRankingPlan.sortColumn === "rate_per_100k" ? "Rate per 100,000" : "Offenses",
        }
      : null;
    const cityRankingChartMeta = { source: "RTCI", agencyCount: rows.length, population: null };
    const proof = finalizeExit({
      outcome: rows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
      sql: cityRankingPlan.sql, rows, columns,
      derivation: sealPlanDerivation(cityRankingPlan.guardrail, cityRankingPlan.sql),
      planFamily: cityRankingPlan.guardrail, guardrails: [cityRankingPlan.guardrail],
      narrative: explanation,
      hasChart: Boolean(cityRankingChart), db: getDb(),
    });
    writeLog(question, cityRankingPlan.sql, rows.length, null, ms, explanation, tab, [cityRankingPlan.guardrail], "deterministic", sessionId, serializeChartConfigForLog(cityRankingChart, columns, cityRankingChartMeta), proof);
    attachChartAuditToPayload({ chartConfig: cityRankingChart, columns, rows }, { source: tab, requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, {
          type: "result", requestId: chartAuditRequestId, chartAuditSource: tab,
          sql: cityRankingPlan.sql, explanation, title: cityRankingTitle,
          columns, rows, rowCount: rows.length, truncated: false,
          chartConfig: cityRankingChart,
          chartMeta: cityRankingChartMeta,
          executionTimeMs: ms,
        }))));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
        Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining),
      },
    });
  }

  // Stage 3a (r1.1 F1): this plan computes state and national RATES (lib/current-indexed-state-deterministic.ts), which the
  // owner policy forbids on Current (ruling 3), so it no longer owns a request: the policy check refuses what it applies,
  // and the request reaches the supported types, which decline a state or national rate with the Historical pointer.
  const indexedStatePlan = tab === "current"
    ? currentOwns(buildCurrentIndexedStatePlan(question, body?.history), () => ({ statistic: "rate", places: currentPlaceIs.national }))
    : null;
  // Structural proof BEFORE execution. This branch returns long before runContractValidation is
  // defined, so without this it executed with no proof at all. A refused plan is simply not used;
  // the request falls through to the model path, which validates in full.
  const indexedStateRefusal = deterministicPlanRefusal({ question, source: tab, sql: indexedStatePlan?.sql });
  if (indexedStateRefusal) console.log(`[structural] indexed-state plan refused: ${indexedStateRefusal.ruleIds.join(", ")}`);
  if (indexedStatePlan && !indexedStateRefusal) {
    try {
      const db = getDb();
      const rows = executeWithTimeoutSync<Record<string, unknown>>(db, db.prepare(indexedStatePlan.sql), 30000);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : indexedStatePlan.columns;
      const ms = Date.now() - totalStart;
      const proof = finalizeExit({
        outcome: rows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
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

  /*
   * Decision 17, owned by the request rather than by the answer's column names.
   *
   * GC-055 asked "did violent crime decrease every year from 2023 to 2026?" and was delivered
   * `decreased: "Yes"` for a five-month 2026 against a full-year 2025 — the run before, the same
   * question produced `pct_change: -61.9`. The presentation control caught the numeric shape and
   * not the categorical one, because it had to guess the operation from what came back. Here the
   * contract declares the comparison, and this plan owns the periods, the coverage evidence, the
   * arithmetic and the delivered text.
   *
   * The plan's own SQL is gated below like its siblings. Its paired coverage read is deliberately
   * NOT presented as an answer: it projects a contributor count rather than a measure, it exists
   * only to decide matched/unequal/unestablished, and it shares its scope clause verbatim with the
   * gated statement.
   */
  // Stage 3a: bound by value -- the national sample, the topic's offenses, counts, each requested year, by year.
  const yoyComparisonPlan = !planSaysQueryBearing && tab === "current"
    ? currentOwns(buildCurrentYoyComparisonPlan(question), (p) => {
      const first = p.years[0]; const last = p.years[p.years.length - 1];
      const measure = currentMeasureOf(p.offenses);
      return {
        places: currentPlaceIs.national, measures: measure ? [measure] : [], statistic: "count",
        change: ["increase", "decrease", "neutral"], grains: ["year", "trend"], versus: "periods",
        periodValues: [`range:${first}:${last}`, `between:${first}:${last}`, ...p.years.map((y) => `year:${y}`)],
      };
    })
    : null;
  const yoyComparisonRefusal = deterministicPlanRefusal({ question, source: tab, sql: yoyComparisonPlan?.sql });
  if (yoyComparisonRefusal) console.log(`[structural] current yoy comparison plan refused: ${yoyComparisonRefusal.ruleIds.join(", ")}`);
  if (yoyComparisonPlan && !yoyComparisonRefusal) {
    /*
     * A failure in here is an INTERNAL failure, and must not be reported as unknown coverage or
     * handed to the model path as an ordinary question. Falling through would put the comparison
     * back in front of the model with nothing owning it, which is the defect this branch exists to
     * remove.
     */
    let comparisonFailed = false;
    let answerRows: CurrentYoyAnswerRow[] = [];
    let comparisonGroup: CurrentYoyGroup | null = null;
    let db: ReturnType<typeof getDb> | null = null;
    try {
      db = getDb();
      /*
       * ONE snapshot, not three calls. Each `executeWithTimeoutSync` spawns its own worker process
       * with its own connection, so reading the periods, the membership and the totals separately
       * would let them describe the database at three different moments — and a group selected in
       * one snapshot cannot license totals read from another.
       * `executeManyWithTimeoutSync` runs all three statements in one worker inside one read
       * transaction, and refuses outright when bounded execution is unavailable. Membership is
       * decided by the SQL itself, so no round trip is needed between the reads.
       */
      const [periodResult, sampleResult, membershipResult, answerResult] = executeManyWithTimeoutSync<Record<string, unknown>>(
        db,
        [
          yoyComparisonPlan.periodSql,
          // The starting sample size is its own statement so it survives an empty group; reading it
          // off the membership rows made a nonempty sample look empty when nobody qualified.
          yoyComparisonPlan.sampleSql,
          yoyComparisonPlan.membershipSql,
          yoyComparisonPlan.sql,
        ],
        30000,
      );
      comparisonGroup = buildCurrentYoyGroup(
        yoyComparisonPlan.years,
        periodResult as unknown as CurrentYoyPeriodRow[],
        membershipResult as unknown as CurrentYoyMembershipRow[],
        sampleResult as unknown as CurrentYoySampleRow[],
        yoyComparisonPlan.offenses.length,
      );
      // Stage 3b r2 (R2.4'): the fixed comparison group as this year-over-year path formed it (no-op outside an inner run).
      recordWhyFacts({ kind: "group", place: "United States (sample)", members: comparisonGroup.includedCount, sample: comparisonGroup.startingSampleSize });
      answerRows = answerResult as unknown as CurrentYoyAnswerRow[];
      /*
       * The delivered totals must describe exactly the required cells for exactly the selected
       * group. Selection is supposed to guarantee it, so a mismatch is an internal fault rather
       * than a coverage result — an empty group legitimately returns no cells.
       */
      if (!answerCoversRequiredCells(answerRows, comparisonGroup, yoyComparisonPlan.offenses)) {
        console.error("[current-yoy] the answer read does not cover exactly the required group cells");
        comparisonFailed = true;
      }
    } catch (err) {
      console.error("[current-yoy] comparison read failed", err);
      comparisonFailed = true;
    }

    if (comparisonFailed) {
      const ms = Date.now() - totalStart;
      const message = "I could not read the reporting coverage needed to compare those years, so I am not showing a comparison. This is a problem on my side, not a statement about the data.";
      // Logged as an ERROR with a null proof. No proof is finalized because no factual payload is
      // delivered, and recording this as a data decline would misfile an internal fault as an
      // absence of coverage.
      writeLog(question, yoyComparisonPlan.sql, 0, "current-yoy comparison read failed", ms, message, tab, [`${yoyComparisonPlan.guardrail}-internal-failure`], "deterministic", sessionId, null, null);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseEvent({ type: "error", text: message })));
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

    const answer = buildCurrentYoyComparisonAnswer(yoyComparisonPlan, answerRows, comparisonGroup!);
    const executedColumns = answerRows.length > 0 ? Object.keys(answerRows[0]) : yoyComparisonPlan.columns;
    const ms = Date.now() - totalStart;
    if (answer.withheld.length > 0) {
      console.log(`[current-yoy] withheld ${JSON.stringify(answer.withheld)}`);
    }
    // Group size and exclusions are logged; the identifiers stay out of the log and the answer.
    console.log(`[current-yoy] group ${answer.group.includedCount}/${answer.group.startingSampleSize}` +
      ` excluded=${answer.group.excludedCount} requiredCells=${answer.group.requiredCellsPerAgency}`);
    const proof = finalizeExit({
      outcome: answerRows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
      sql: yoyComparisonPlan.sql,
      // The executed evidence, exactly as returned. The delivered rows are the presentation below.
      rows: answerRows as unknown as Record<string, unknown>[],
      columns: executedColumns,
      derivation: sealPlanDerivation(yoyComparisonPlan.guardrail, yoyComparisonPlan.sql),
      planFamily: yoyComparisonPlan.guardrail,
      guardrails: [yoyComparisonPlan.guardrail],
      narrative: answer.explanation,
      hasChart: false,
      db: db ?? undefined,
    });
    writeLog(
      question,
      yoyComparisonPlan.sql,
      answerRows.length,
      null,
      ms,
      answer.explanation,
      tab,
      [yoyComparisonPlan.guardrail, ...(answer.withheld.length > 0 ? ["unverified-change-withheld"] : [])],
      "deterministic",
      sessionId,
      // No chart: a withheld change must not survive as a plotted series, and the delivered table
      // is the whole answer.
      serializeChartConfigForLog(null, executedColumns, yoyComparisonPlan.chartMeta),
      proof
    );
    attachChartAuditToPayload({ chartConfig: null, columns: executedColumns, rows: answerRows as unknown as Record<string, unknown>[] }, { source: tab, requestId: chartAuditRequestId, queryLogId: chartAuditQueryLogId });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent(emitFactualPayload(proof, {
              type: "result",
              requestId: chartAuditRequestId,
              chartAuditSource: tab,
              sql: yoyComparisonPlan.sql,
              explanation: answer.explanation,
              title: answer.title,
              columns: answer.columns,
              rows: answer.rows,
              rowCount: answer.rows.length,
              truncated: false,
              chartConfig: null,
              chartMeta: yoyComparisonPlan.chartMeta,
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

  // Stage 3a (task 0 finding): the Current branch of this plan counts an unreported month as 0 (`ELSE 0`), so it no longer
  // owns a Current request; named places side by side are the supported type C2, which keeps absence apart from zero.
  const multiCityTrend = historicalOwns(!planSaysQueryBearing && tab === "historical"
    ? buildMultiCityTrendPlan(question, tab)
    : null, (plan) => {
      const a = plan.applied;
      if (!a) return { };
      const measure = measureForOffenseColumn(a.offense);
      return {
        places: placeIs.any(...plan.requestedCities.map((c) => { const [n, st] = c.label.split(/,\s*/); return placeIs.agency(n ?? "", st ?? ""); })),
        measures: measure ? [measure] : [],
        statistic: a.rate ? "rate" : "count",
        periodKeys: a.startYear !== null && a.endYear !== null && !a.relative ? rangeKeys(a.startYear, a.endYear) : a.startYear === null ? ["all"] : [],
        relativeYears: a.relative && a.startYear !== null && a.endYear !== null ? { start: a.startYear, end: a.endYear } : null,
        grain: true,
        versus: "places",
      };
    });
  const multiCityRefusal = deterministicPlanRefusal({ question, source: tab, sql: multiCityTrend?.sql });
  if (multiCityRefusal) console.log(`[structural] multi-city plan refused: ${multiCityRefusal.ruleIds.join(", ")}`);
  if (multiCityTrend && !multiCityRefusal) {
    try {
      const db = getDb();
      const rows = executeWithTimeoutSync<Record<string, unknown>>(db, db.prepare(multiCityTrend.sql), 30000);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : multiCityTrend.columns;
      /*
       * This deterministic exit emits its own payload and never reaches applyResultDisclosures, so
       * the presentation result has to be built here too — otherwise an unverified change would be
       * delivered on the very path that produces GC-042's `period`-shaped rows.
       */
      const presentation = withholdUnverifiedChange({
        rows, columns, sql: multiCityTrend.sql,
        explanation: multiCityTrend.explanation, title: multiCityTrend.title,
        question,
      });
      const deliveredRows = presentation.rows;
      const deliveredColumns = presentation.columns;
      // This exit never reaches applyResultDisclosures, so the prepared narrative is used here.
      // GC-098 correction C1: a relative Historical period is never silently shortened to the years
      // the source holds; the rows are checked against the resolved period and any gap is stated.
      const periodShortfall = relativePeriodShortfallNote(multiCityTrend, rows);
      const periodExplanation = periodShortfall ? `${presentation.explanation.trimEnd()} ${periodShortfall}` : presentation.explanation;
      multiCityTrend.explanation = withBaltimoreDisclosure(periodExplanation, baltimoreDefault);
      multiCityTrend.explanation = withChicagoAssaultComparability(multiCityTrend.explanation, multiCityTrend.sql, rows);
      const ms = Date.now() - totalStart;
      // Multi-city comparison is the family that produced the 31-of-32 failure, so
      // it supplies requested/returned entity sets to the completeness check. The
      // plan pivots cities into columns, so a city "came back" only if its column
      // exists AND carries at least one non-null value -- an all-null column is the
      // exact shape of the silent drop.
      const proof = finalizeExit({
        outcome: rows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
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
                // From the presentation result: this exit never reaches applyResultDisclosures, so
                // the period sentences and any withholding must already be in what it sends. The
                // fallback is the deterministic plan's own text, if the presentation produced none.
                explanation: multiCityTrend.explanation || presentation.explanation,
                title: multiCityTrend.title,
                // Presentation result, not the executed rows.
                columns: deliveredColumns,
                rows: deliveredRows,
                rowCount: deliveredRows.length,
                truncated: false,
                chartConfig: deliveredRows.length > 0 ? multiCityTrend.chartConfig : null,
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

  // Increment 5 (Decision 16): the deterministic Historical peer path. Peers are chosen
  // by the shared population core from real candidates, and the national series stays a
  // separately labelled series rather than being folded into the peer average.
  const historicalPeer = historicalOwns(tab === "historical"
    ? buildHistoricalPeerComparisonPlan(question, {
        candidateSource: (q) => fetchHistoricalPeerCandidates(getDb() as unknown as Parameters<typeof fetchHistoricalPeerCandidates>[0], q),
        resolveSubject: (name, state) => resolveHistoricalSubjectPopulation(getDb(), name, state),
      })
    : null, (plan) => {
      if (!plan.sql || !plan.applied) return "decline";
      const a = plan.applied;
      return {
        operations: ["peer"],
        places: placeIs.any(placeIs.agency(a.subject.name, a.subject.state), placeIs.national),
        measures: a.metric === "homicide" ? ["murder"] : ["violent"],
        clearance: a.metric === "violent_clearance",
        statistic: a.metric === "violent_clearance" ? "rate" : null,
        change: a.metric === "homicide" ? ["increase", "decrease", "neutral"] : undefined,
        periodKeys: a.period ? rangeKeys(a.period.start, a.period.end) : [],
        versus: "any",
      };
    });
  // National violent-crime batch (Codex :36558): the U.S. annual violent-crime COUNT series is owned here, BEFORE model
  // SQL, so the model never chooses its table (release-f D1 delivered an agency sum labelled as a U.S. count).
  // The owned national plan is answered or declined here; it never falls through to model SQL. It is proved and read
  // first; a refused or unreadable plan is replaced by its no-query decline, which the existing no-query branch below
  // delivers with the owned sentence (no new exit).
  // GC-010 batch (lib/historical-national-violent-rate.ts): the U.S. annual violent-crime RATE series, alone or with the
  // unavailable U.S. prison population, is owned the same way -- the rate is delivered and the prison half gets its own
  // limitation in the same answer, instead of the whole request being refused as a court topic.
  const nationalPlan = tab === "historical" && !historicalPeer && !queryBearingFollowup
    ? buildHistoricalNationalViolentCountPlan(question) ?? buildHistoricalNationalViolentRatePlan(question)
    : null;
  let nationalRows: Record<string, unknown>[] | null = null;
  let nationalCorrected: boolean | undefined;
  const nationalRefusal = nationalPlan ? deterministicPlanRefusal({ question, source: tab, sql: nationalPlan.sql }) : null;
  if (nationalRefusal) console.log(`[structural] historical national violent plan refused: ${nationalRefusal.ruleIds.join(", ")}`);
  if (nationalPlan?.sql && !nationalRefusal) {
    try {
      const db = getDb();
      const nationalRead = executeWithCorrectionState(db, nationalPlan.sql, 30000);
      nationalRows = nationalRead.rows;
      nationalCorrected = nationalRead.corrected;
    } catch (err) {
      console.warn("[historical-national-violent] owned national query failed; declining", err);
    }
  }
  const historicalNational = nationalPlan && nationalRows === null
    ? (nationalPlan.guardrail === NATIONAL_VIOLENT_RATE_GUARDRAIL ? nationalViolentRateDeclinePlan(nationalPlan, question) : nationalViolentDeclinePlan(nationalPlan))
    : nationalPlan;
  const historicalCityChange = tab === "historical"
    ? historicalPeer ?? historicalNational
      ?? historicalOwns(buildHistoricalLocalRecentChangePlan(question, HISTORICAL.crimeMaxYear), (plan) => {
        const a = plan.applied;
        if (!plan.sql || !a || a.kind !== "local-change") return plan.sql ? {} : "decline";
        return { places: placeIs.agency(a.place.name, a.place.state), measures: ["violent"], change: ["increase", "decrease", "neutral"], periodKeys: ["lastyear"] };
      })
      ?? historicalOwns(buildHistoricalCityChangeRankingPlan(question, body?.history), (plan) => {
        const a = plan.applied;
        if (!plan.sql) return "decline";
        if (!a || a.kind !== "change-ranking" || a.inherited || a.floor !== null) return {};
        // r2 §1: bound by VALUE -- the direction the plan ranks and the 20 places it shows (its LIMIT).
        return { places: placeIs.national, entities: ["city"], measures: ["violent"], change: [a.direction === "increase" ? "increase" : "decrease"], rank: { dir: "top", n: a.limit }, periodKeys: rangeKeys(a.startYear, a.endYear) };
      })
    : null;
  if (historicalCityChange && baltimoreDefault) historicalCityChange.explanation = withBaltimoreDisclosure(historicalCityChange.explanation, baltimoreDefault);
  const historicalCityChangeRefusal = deterministicPlanRefusal({ question, source: tab, sql: historicalCityChange?.sql });
  if (historicalCityChangeRefusal) console.log(`[structural] historical city-change plan refused: ${historicalCityChangeRefusal.ruleIds.join(", ")}`);
  if (historicalCityChange && !historicalCityChangeRefusal) {
    const ms = Date.now() - totalStart;
    if (!historicalCityChange.sql) {
      // The planner produced no query, so there is no supported path for this
      // request -- a capability limitation, not a statement about the data.
      const proof = finalizeExit({
        outcome: OUTCOMES.consolidation_mapping,
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
      const rows = nationalRows ?? executeWithTimeoutSync<Record<string, unknown>>(db, db.prepare(historicalCityChange.sql), 30000);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : historicalCityChange.columns;
      // The owned national series: the accepted composite description from its SQL binding, then the ordinary disclosure
      // chokepoint for the row-derived coverage, period and lag notes. Rows and SQL are the plan's own.
      if (historicalCityChange === historicalNational) {
        const composite = historicalViolentComposite(tab, historicalCityChange.sql, rows);
        historicalCityChange.explanation = applyResultDisclosures({
          explanation: composite?.narrative ?? historicalCityChange.explanation,
          // GC-010 r1: the rate series' disclosures read the crime clause that produced the statement, never the prison
          // clause's period; every other national plan reads the question as before.
          question: (historicalCityChange.guardrail === NATIONAL_VIOLENT_RATE_GUARDRAIL ? nationalViolentRateDisclosureQuestion(question) : null) ?? question,
          sql: historicalCityChange.sql, rows, tab,
          resultState: genericResultState({ sql: historicalCityChange.sql, rows }),
          historicalNationalRapeCorrected: nationalCorrected,
        });
        historicalCityChange.title = alignTitleYearRange(historicalCityChange.title, rows);
        // GC-010: the prison half's limitation, appended after the chokepoint (it is established by the request, which the
        // row-based chokepoint cannot see), so the compound answer keeps it in every delivery.
        // No rows for the requested years: say so, from the plan's own period (an absence, never a zero).
        const emptyNote = historicalCityChange.guardrail === NATIONAL_VIOLENT_RATE_GUARDRAIL && rows.length === 0 ? nationalViolentRateEmptyNote(question) : null;
        if (emptyNote) historicalCityChange.explanation = emptyNote;
        const prisonLimitation = historicalCityChange.guardrail === NATIONAL_VIOLENT_RATE_GUARDRAIL ? nationalViolentRateLimitation(question) : null;
        if (prisonLimitation && !historicalCityChange.explanation.includes(prisonLimitation)) {
          historicalCityChange.explanation = [historicalCityChange.explanation, prisonLimitation].filter(Boolean).join("\n\n");
        }
      }
      // R1 (Decision 16): compare the SELECTED peer membership with the evidence that came
      // back. A named peer that returned no rows must be disclosed, not silently dropped —
      // and never replaced, because selection is on population alone.
      if (historicalPeer && historicalPeer === historicalCityChange && historicalPeer.selectedPeers.length > 0) {
        // Review 2B: identities, not bare labels. The Historical result carries no id
        // column, so this degrades to exact place-and-kind label matching — which is
        // correct here because both sides read `historical_agency.agency`.
        const returned = rows
          .filter((r) => String(r.series) !== "National")
          .map((r) => ({ id: r.ori == null ? null : String(r.ori), label: String(r.place) }));
        const membership = verifyPeerMembership(historicalPeer.selectedPeers, returned);
        if (!membership.complete) {
          historicalCityChange.explanation = `${historicalCityChange.explanation} ${membership.disclosure}`;
        }
      }
      historicalCityChange.explanation = withChicagoAssaultComparability(historicalCityChange.explanation, historicalCityChange.sql, rows);
      const proof = finalizeExit({
        outcome: rows.length > 0 ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
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
  const historicalPlace = historicalOwns(tab === "historical" && !queryBearingFollowup && !shouldSkipHistoricalPlaceLookup(question, body?.history)
    ? answerHistoricalPlaceLookup(question, getDb())
    : null, (plan) => ({
      operations: ["coverage-lookup"],
      places: placeIs.any(...plan.rows.map((r) => placeIs.agency(String(r.agency ?? ""), String(r.state ?? "")))),
    }));
  const historicalPlaceRefusal = deterministicPlanRefusal({
    question, source: tab, sql: historicalPlace?.sql,
  });
  if (historicalPlaceRefusal) {
    console.log(`[structural] historical place lookup refused: ${historicalPlaceRefusal.ruleIds.join(", ")}`);
  }
  if (historicalPlace && !historicalPlaceRefusal) {
    const ms = Date.now() - totalStart;
    const proof = finalizeExit({
      outcome: OUTCOMES.deterministic_plan,
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

  const metadata = currentOwns(historicalOwns(planSaysQueryBearing ? null : answerMetadataQuestion(tab, question, getDb()), () => ({ operations: ["coverage-lookup", "completeness", "meta-source"] })), (m) => ({
    operations: ["coverage-lookup", "completeness", "meta-source"],
    // Stage 3a: a count of agencies, cities or states is what these columns hold ("how many agencies are covered?").
    ...(m.columns.some((c) => /_count$/.test(c)) ? { statistic: "count" as const } : {}),
    entities: m.columns.some((c) => /^agency/.test(c)) ? ["agency"] : m.columns.some((c) => /^city/.test(c)) ? ["city"] : m.columns.some((c) => /^state/.test(c)) ? ["state"] : [],
  }));
  if (metadata) {
    const ms = Date.now() - totalStart;
    const proof = finalizeExit({
      outcome: OUTCOMES.deterministic_plan,
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

  // ── Request accounting, stage 2a: a NUMERIC Historical request no fixed path owned is answered by one of the supported
  // question types (H1-H6) with application-built statements, or declined/clarified by name. It never reaches model SQL.
  if (historicalNumeric && historicalLedger) {
    const typeDb = getDb();
    const decision = matchHistoricalType(historicalLedger, { bounds: (source) => historicalSourceBounds(typeDb, source) });
    if (decision.kind === "decline") return historicalAccountingExit({ parts: decision.parts, explanation: decision.explanation }, "question-type");
    if (decision.kind === "clarify") return historicalAccountingExit({ parts: [], explanation: decision.explanation }, "question-type", true);
    if (decision.kind === "spec") {
      const typeFamily = `historical-question-type:${decision.spec.type}`;
      // The rape-correction state of each typed statement, read in that statement's own snapshot (plan 2026-10-18 r2 §1).
      const statementStates: boolean[] = [];
      const compiled = compileHistoricalSpec(decision.spec, {
        db: typeDb,
        // A typed statement is built from the issued spec, whose every part was checked by value. The structural guard
        // (deterministicPlanRefusal) is NOT applied to it: that guard checks a statement against a contract parsed from
        // the question text, and that contract cannot describe a typed spec (it expects total_offenses for "total crime",
        // which task 0 found disagrees with its components; it reads a city-vs-state comparison as one row level; it has
        // no unit for a percent change). The fixed paths keep the guard unchanged. The table allowlist still applies.
        execute: (typedStatement) => {
          const tables = validateTablesForTab(typedStatement, "historical", typeDb);
          if (!tables.ok) throw new Error(`an owned Historical statement read a table outside the Historical allowlist (${tables.unknown.join(", ")})`);
          const db = typeDb;
          const read = executeWithCorrectionState(db, typedStatement, 30000);
          statementStates.push(read.corrected);
          return read.rows;
        },
      });
      if (compiled.kind === "decline") return historicalAccountingExit({ parts: [], explanation: compiled.explanation }, "question-type-compile");
      const typedState = typedCorrectionState(statementStates);
      if (typedState === "changed") return historicalAccountingExit({ parts: [], explanation: TYPED_STATE_CHANGED }, "question-type-compile");
      const typedExplanation = withTypedHistoricalRapeNotes(decision.explainLimitation ? `${compiled.explanation} ${decision.explainLimitation}` : compiled.explanation, compiled.deliveredSeries, typedState);
      const ms = Date.now() - totalStart;
      const hasValue = compiled.rows.some((row) => ["value", "change", "percent_change"].some((c) => row[c] !== null && row[c] !== undefined));
      const typedProof = finalizeExit({
        outcome: hasValue ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
        sql: compiled.sql,
        rows: compiled.rows,
        columns: compiled.columns,
        derivation: sealPlanDerivation(typeFamily, compiled.sql),
        planFamily: typeFamily,
        guardrails: ["request-accounting", typeFamily],
        requestedEntities: compiled.requestedEntities,
        returnedEntities: compiled.returnedEntities,
        hasChart: Boolean(compiled.chartConfig),
        narrative: typedExplanation,
        db: typeDb,
      });
      // One object for the log and the response, so an exported chart's metadata binds to what was logged.
      const typedChartMeta = { source: "FBI SRS", agencyCount: 0, population: null };
      writeLog(question, compiled.sql, compiled.rows.length, null, ms, typedExplanation, tab, ["request-accounting", typeFamily], "deterministic", sessionId,
        serializeChartConfigForLog(compiled.chartConfig, compiled.columns, typedChartMeta), typedProof);
      const typedStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(typedProof, {
            type: "result", requestId: chartAuditRequestId, chartAuditSource: tab, sql: compiled.sql, explanation: typedExplanation, title: compiled.title,
            columns: compiled.columns, rows: compiled.rows, rowCount: compiled.rows.length, truncated: false, chartConfig: compiled.chartConfig,
            chartMeta: typedChartMeta,
            executionTimeMs: ms,
          }))));
          controller.close();
        },
      });
      return new Response(typedStream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
    }
    // `none`: no measure to answer with; the model may reply in text below, and its SQL never runs (K7).
  }

  // ── Request accounting, stage 3a: a NUMERIC Current request no fixed path owned or declined is answered by one of the
  // supported question types (C1-C3, C5, C6) with application-built statements, or declined/clarified by name. Its model
  // SQL never runs. Recognition refusals (what Current Trends doesn't track, words it couldn't interpret) come first.
  if (currentNumeric && currentLedger) {
    const recognition = currentRecognitionRefusal(currentLedger);
    if (recognition) return currentAccountingExit(recognition, "recognition");
    const decision = matchCurrentType(currentLedger);
    if (decision.kind === "decline") return currentAccountingExit({ parts: decision.parts, explanation: decision.explanation }, "question-type");
    if (decision.kind === "clarify") return currentAccountingExit({ parts: [], explanation: decision.explanation }, "question-type", true);
    if (decision.kind === "spec") {
      const typeFamily = `current-question-type:${decision.spec.type}`;
      const typeDb = getDb();
      // Typed statements are built from the issued spec and skip the structural guard (the 2a D1 ruling); the table
      // allowlist still applies to every statement.
      // Plan §4.5: a compile or execution failure is a named decline, never a thrown error and never a model fallback.
      let compiled: ReturnType<typeof compileCurrentSpec>;
      try {
        compiled = compileCurrentSpec(decision.spec, {
          run: (typedStatement) => {
            const tables = validateTablesForTab(typedStatement, "current", typeDb);
            if (!tables.ok) throw new Error(`an owned Current statement read a table outside the Current allowlist (${tables.unknown.join(", ")})`);
            const db = typeDb;
            return executeWithTimeoutSync<Record<string, unknown>>(db, db.prepare(typedStatement), 30000);
          },
          // r2 F2: statements that must describe one moment (the fixed comparison group) run in ONE worker and one read
          // transaction, exactly as the accepted year-over-year path runs the same four statements.
          runMany: (typedStatements) => {
            for (const s of typedStatements) {
              const tables = validateTablesForTab(s, "current", typeDb);
              if (!tables.ok) throw new Error(`an owned Current statement read a table outside the Current allowlist (${tables.unknown.join(", ")})`);
            }
            return executeManyWithTimeoutSync<Record<string, unknown>>(typeDb, typedStatements, 30000);
          },
        });
      } catch (err) {
        console.warn("[request-accounting][current] typed answer failed; declining", err);
        compiled = { kind: "decline", explanation: "I couldn't build this Current Trends answer from the data just now, so I haven't answered with a number. Please try again." };
      }
      if (compiled.kind === "decline") return currentAccountingExit({ parts: [], explanation: compiled.explanation }, "question-type-compile");
      recordWhyNotes(compiled.notes); // Stage 3b: the notes as data for an outer "why" turn (no-op outside an inner run)
      // L12/L13: the answer is delivered only when what its statements applied accounts for every part, by value.
      if (!currentLegacyBound(currentLedger, compiled.applied, currentExplainLimitation)) {
        const unbound = currentUnboundParts(currentLedger, compiled.applied, currentExplainLimitation);
        const named = unbound.map((p) => `"${p.text.trim()}"`).join(" and ") || "every part of the question";
        return currentAccountingExit({ parts: unbound, explanation: `I couldn't apply ${named} to this answer, so I haven't answered with a number that leaves it out. ${CURRENT_MODEL_SQL_DECLINE}` }, "question-type-binding");
      }
      const typedExplanation = decision.explainLimitation ? `${compiled.explanation} ${decision.explainLimitation}` : compiled.explanation;
      const ms = Date.now() - totalStart;
      const hasValue = compiled.rows.some((row) => row.value !== null && row.value !== undefined);
      const typedProof = finalizeExit({
        outcome: hasValue ? OUTCOMES.deterministic_plan : OUTCOMES.no_rows_in_source,
        sql: compiled.sql,
        rows: compiled.rows,
        columns: compiled.columns,
        derivation: sealPlanDerivation(typeFamily, compiled.sql),
        planFamily: typeFamily,
        guardrails: ["request-accounting", typeFamily],
        requestedEntities: compiled.requestedEntities,
        returnedEntities: compiled.returnedEntities,
        hasChart: Boolean(compiled.chartConfig),
        narrative: typedExplanation,
        db: typeDb,
      });
      const typedChartMeta = { source: "RTCI", agencyCount: 0, population: null };
      writeLog(question, compiled.sql, compiled.rows.length, null, ms, typedExplanation, tab, ["request-accounting", typeFamily], "deterministic", sessionId,
        serializeChartConfigForLog(compiled.chartConfig, compiled.columns, typedChartMeta), typedProof);
      const typedStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(typedProof, {
            type: "result", requestId: chartAuditRequestId, chartAuditSource: tab, sql: compiled.sql, explanation: typedExplanation, title: compiled.title,
            columns: compiled.columns, rows: compiled.rows, rowCount: compiled.rows.length, truncated: false, chartConfig: compiled.chartConfig,
            chartMeta: typedChartMeta,
            executionTimeMs: ms,
          }))));
          controller.close();
        },
      });
      return new Response(typedStream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-RateLimit-Remaining": String(rateCheck.remaining) } });
    }
    // `none`: no measure to answer with; the model may reply in text below, and its SQL never runs (§6).
  }

  const stream = new ReadableStream({
    async start(controller) {
      let sql: string | null = null;
      let firedGuardrails: string[] = [];

      // One place that makes a narrative agree with the resolved agency record, used at every
      // factual boundary. It returns the corrected text rather than mutating, so each call site
      // has to correct BEFORE the finalization that seals what the user reads -- the first
      // version of this ran only where no SQL was produced, which is the one path the Baltimore
      // regression never takes.
      const authoritativeIdentity = (
        text: string | null | undefined,
        title?: string | null,
      ): { explanation: string; title: string } => {
        if (!requiredAgencyRecord) return { explanation: text ?? "", title: title ?? "" };
        const fixed = applyAuthoritativeIdentity(text, title, requiredAgencyRecord);
        if (fixed.changed) {
          if (!firedGuardrails.includes("authoritative-agency-label")) {
            firedGuardrails.push("authoritative-agency-label");
          }
          console.log("[query][authoritative-label] " + requiredAgencyRecord.ori + ": "
            + fixed.corrections.join("; "));
        }
        return { explanation: fixed.explanation, title: fixed.title };
      };
      // Narrative-only sites (the refined and retry explanations carry their own title already).
      const authoritativeNarrative = (text: string | null | undefined): string =>
        authoritativeIdentity(text, null).explanation;
      let contractQuestion = question;
      // The effective request for an amended Current follow-up; null on every other path.
      let contractOverride: QueryContract | null = null;
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
          requiredOri: requiredCountyOri,
          contract: contractOverride,
          history: normalizeHistoryForTab(body?.history, tab === "historical" ? "historical" : "current"),
        });
        recordContractValidation(contractResult);
        return contractResult;
      };
      const emitContractFailure = (contractResult: QueryContractSqlValidation, logError: string): boolean => {
        const msg = queryContractFailureMessage(contractResult);
        if (!msg) return false;
        const proof = finalizeExit({
          outcome: capabilityFinalizationOutcome(contractResult),
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
        // ── GC-070: an explicit amendment, carried as the effective request ─────────────────────
        //
        // "now detroit" settled nothing on its own, so every consumer below saw a fragment and the
        // rolling-12 per-capita series the reader had built was lost. `currentAmendment` builds the
        // effective request as a contract, field by field, from a full user anchor plus the explicit
        // amendments that followed it, reading only the bounded history the client already sends.
        // It sits AFTER the transforms the product already recognizes, so "what about Detroit" keeps
        // its existing behavior, and no planner mode is changed to make it fire.
        // Stage 3a (r1.1 F5): the one resolution the request-accounting ledger read, with the same precedence as before.
        const followupTransform = followupResolution.transform;
        // The contract travels only when the amendment's own transform is the one in force.
        const amendedContract = (currentAmendment.kind === "composed" && followupTransform === currentAmendment.transform) ? currentAmendment.contract : null;
        // Bare clarifier answers ("Countywide total") carry no county name — use
        // the transform's reconstructed question so guardrails see the geography.
        // For an amendment this is the contract's rendering, which the amendment has already
        // verified reads back to the same request; the text-only guardrails below read it.
        const guardrailQuestion = followupResolution.question;
        // The validator checks the SQL against the contract itself. Its question stays the reader's
        // own words, for the rules about meaning an amendment does not carry.
        contractQuestion = amendedContract ? question : guardrailQuestion;
        contractOverride = amendedContract;
        // The guardrail question is the most complete reconstruction available -- it
        // is what extractQueryContext sees -- so proof uses it, and the amended contract,
        // for every exit from here on.
        proofQuestion = guardrailQuestion;
        proofContract = amendedContract;
        // The post-execution grain and disclosure checks read a sentence. For an amendment the
        // reader's fragment says nothing about grain or period, so they read the rendering too.
        const deliveryQuestion = amendedContract ? guardrailQuestion : question;
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
        // A NEW array in both branches, so the instructions pushed below never become turns of `history` itself.
        const promptHistory = followupTransform
          ? [...history, { role: "user" as const, content: followupTransform.instruction }]
          : [...history];
        if (consolidationInstruction) promptHistory.push({ role: "user" as const, content: consolidationInstruction });
        // The user chose one of a county's two law enforcement agencies. Tell the model which
        // ORI that is -- and note that the contract validator checks the SQL actually uses it,
        // so this is guidance in front of enforcement rather than instead of it.
        if (requiredCountyOri) {
          promptHistory.push({
            role: "user" as const,
            content: `[SYSTEM: The user selected one specific county law enforcement agency${requiredAgencyRecord ? `, which the database records as "${requiredAgencyRecord.agency}" -- call it that in your explanation and title, whatever the user called it` : ""}. Restrict the query to ORI '${requiredCountyOri}' by putting the equality directly in the top-level WHERE clause, exactly like: WHERE ha.ori = '${requiredCountyOri}' AND ... . Do not match the agency by name, do not use OR, and do not hide the ORI in a CTE, a subquery, a CASE expression or a SELECT label — the query is checked for that filter before it runs and will be refused without it. Do not include the other agency in that county.]`,
          });
        }
        const systemPrompt = isHistorical ? getHistoricalSystemPrompt() : undefined;

        // Check response cache (only standalone questions)
        if (isHistorical) cacheValidity = historicalCacheValidity(baseCacheValidity, readCorrectionState(getDb()));
        const cached = promptHistory.length === 0 ? getCached(question, tab === "historical" ? HISTORICAL_CACHE_TAB : CURRENT_CACHE_TAB, cacheValidity) : null;
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

          // Stage 3a (§6): on Current the model is never asked again for a statement.
          if (!claude.sql && !isOverBudget() && !(tab === "current" && CURRENT_MODEL_SQL_NEVER_RUNS)) {
            // Cause A: a court-process request is settled by the REQUEST policy, not by whatever the
            // model wrote. No second call can turn a police record into a court record, so this
            // request goes straight to the terminal exit and its policy explanation.
            const courtProcessTerminal = courtProcessNoSqlIsTerminal(guardrailQuestion);
            // Retry if model incorrectly claims data isn't available
            const coverageRetryPrompt = partialCoverageRetryPrompt(tab, question, claude.explanation);
            const refusalPatterns = /not (appear|be represented)|doesn't appear|not (in|included in) (this|the|our) (dataset|data|sample|library)|no data (for|available|found)|does not (have|include|cover)|not available in this|isn't (in|included)|not found in/i;
            const genericRetryPrompt = tab === "historical"
              ? "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. The Historical Library contains ~24,937 agencies including many small towns. NEVER assume an agency is missing - always generate a SQL query. Try: SELECT DISTINCT ori, agency, state FROM historical_agency WHERE agency LIKE '%[city]%' AND state = '[st]'. Then generate the main query.]"
              : "[SYSTEM: Your previous response claimed the data was not available, but this may be incorrect. The database contains agencies from many states. Please try generating a SQL query - search for the agency/state in the data rather than assuming it doesn't exist. Use sample_agencies or agency_monthly to check.]";
            const retryPrompt = courtProcessTerminal
              ? null
              : coverageRetryPrompt ?? (refusalPatterns.test(claude.explanation || "") ? genericRetryPrompt : null);
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

        // Request accounting, stage 3a (§6): no model-written or cached statement produces a Current number. This is the FIRST
        // point a statement exists (the cache read or the first model reply), before any retry, validation, prepare or
        // execution; a reply with no statement continues to the text-only exit below.
        if (tab === "current" && CURRENT_MODEL_SQL_NEVER_RUNS && claude.sql) {
          const gateMs = Date.now() - totalStart;
          const gateTags = ["request-accounting", "request-accounting-owner:model-sql", ...(fromCache ? ["request-accounting:cached-statement"] : [])];
          const gateProof = finalizeExit({ outcome: OUTCOMES.capability_path_unavailable, planFamily: "request-accounting", guardrails: gateTags });
          writeLog(question, null, 0, null, gateMs, CURRENT_MODEL_SQL_DECLINE, tab, gateTags, "haiku-4.5", sessionId, null, gateProof);
          controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(gateProof, {
            type: "result", sql: null as unknown as string, explanation: CURRENT_MODEL_SQL_DECLINE, title: "Not answered",
            columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: gateMs,
          }))));
          close();
          return;
        }

        if (!fromCache && (containsInternalScaffold(claude.explanation) || containsInternalScaffold(claude.title)) && !isOverBudget() && !(tab === "current" && CURRENT_MODEL_SQL_NEVER_RUNS)) {
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
        // Cause A: the verified-agency forcing retry answers "is this agency present?", which is the
        // wrong question for a court-process request. Confirming that Houston is in Current Trends
        // does not make a conviction rate available, so this second call is skipped for the same
        // established family rather than pressing the model to produce a statement it should not.
        // Stage 3a (§6): this retry asks the model for a statement, so it does not run on Current.
        if (!claude.sql && tab === "current" && !CURRENT_MODEL_SQL_NEVER_RUNS && !isOverBudget() && !courtProcessNoSqlIsTerminal(guardrailQuestion)) {

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
          // Decision 1: this branch RETURNS before `runGuardrails`, so `out-of-scope-override`
          // never ran and a court-process request was told to restate itself with a place,
          // offense and date range - advice that can never succeed. Ask the referent policy here.
          if (!serverAuthoredNoSql && !containsInternalLeak(claude.explanation) && !containsInternalLeak(claude.title)) { const noSqlRefusal = selectNoSqlRefusal(guardrailQuestion, tab === "historical" ? "historical" : "current"); claude.explanation = noSqlRefusal.explanation; firedGuardrails.push(noSqlRefusal.reason); }
        claude.explanation = neutralizeUnverifiedAvailabilityClaim(claude.explanation, tab === "historical" ? "Historical" : "Current Trends");
        // The figures were restricted to one agency by the server; the name attached to them is
        // corrected here for the same reason. A user may say what they want and be wrong about
        // what it is called -- "sheriff's office only" reached the Baltimore County Police
        // Department -- and the answer must still say which agency the numbers belong to.
        ({ explanation: claude.explanation, title: claude.title } =
          authoritativeIdentity(claude.explanation, claude.title));
          // No SQL was produced, so nothing factual is being asserted. Capability
          // framing, never a claim that the source lacks the data (handoff 2.4).
          const noSqlProof = finalizeExit({ outcome: OUTCOMES.model_produced_no_sql, guardrails: firedGuardrails });
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

        // Request accounting, stage 2a (K7): no model-written statement produces a Historical number. This is the FIRST
        // point a statement exists (from the model or from the response cache), before any validation, schema check,
        // prepare or retry, so neither a schema failure nor a cached entry can reach an execution.
        // Request accounting stage 3a (defensive): unreachable while the Current gate above stands.
        if (tab === "current" && CURRENT_MODEL_SQL_NEVER_RUNS && claude.sql) throw new Error("request accounting: a Current model statement may not reach validation (3a §6)");
        if (isHistorical && HISTORICAL_MODEL_SQL_NEVER_RUNS) {
          const gateMs = Date.now() - totalStart;
          const gateTags = ["request-accounting", "request-accounting-owner:model-sql", ...(fromCache ? ["request-accounting:cached-statement"] : [])];
          const gateProof = finalizeExit({ outcome: OUTCOMES.capability_path_unavailable, planFamily: "request-accounting", guardrails: gateTags });
          writeLog(question, null, 0, null, gateMs, HISTORICAL_MODEL_SQL_DECLINE, tab, gateTags, "haiku-4.5", sessionId, null, gateProof);
          controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(gateProof, {
            type: "result", sql: null as unknown as string, explanation: HISTORICAL_MODEL_SQL_DECLINE, title: "Not answered",
            columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: gateMs,
          }))));
          close();
          return;
        }

        // Step 1b: Extract context and run guardrails
        const ctx = { ...extractQueryContext(claude.sql, guardrailQuestion, tab as "current" | "historical"), requiredOri: requiredCountyOri };
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
          const overrideProof = finalizeExit({ outcome: OUTCOMES.guardrail_block, sql, guardrails: firedGuardrails, planFamily: guardrailResult.overrideGuardrail ?? null });
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
          const postRetryCtx = { ...extractQueryContext(claude.sql, guardrailQuestion, tab as "current" | "historical"), requiredOri: requiredCountyOri };
          const postRetryResult = runGuardrails(postRetryCtx);
          if (postRetryResult.overrideResponse) {
            const postRetryOverrideProof = finalizeExit({ outcome: OUTCOMES.guardrail_block, sql: claude.sql, guardrails: postRetryResult.fired, planFamily: postRetryResult.overrideGuardrail ?? null });
            writeLog(question, claude.sql, 0, `guardrail_override:${postRetryResult.overrideGuardrail}`, Date.now() - totalStart, postRetryResult.overrideResponse, tab, postRetryResult.fired, "haiku-4.5", sessionId, null, postRetryOverrideProof);
            controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(postRetryOverrideProof, { type: "result", sql: null as unknown as string, explanation: postRetryResult.overrideResponse, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart }))));
            close(); return;
          }
          const rateStillBad = postRetryResult.fired.some(f => f.includes("rate-no-population"));
          if (rateStillBad && /\b(rates?|per\s*capita|per\s*100)/i.test(question) && !asksForCountsInsteadOfRates(question) && !/\b(not rates?|raw|counts?\s+not\s+rates?)\b/i.test(question)) {
            const msg = "I wasn't able to calculate a valid per-capita rate for this query. Try asking for raw counts, or use the [Historical Library](/test?tab=historical) tab for state/national rates.";
            const rateFailureProof = finalizeExit({ outcome: OUTCOMES.rate_denominator_unavailable, sql: claude.sql, guardrails: postRetryResult.fired, planFamily: "rate-no-population" });
            writeLog(question, claude.sql, 0, "rate_second_failure", Date.now() - totalStart, msg, tab, postRetryResult.fired, "haiku-4.5", sessionId, null, rateFailureProof);
            controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(rateFailureProof, { type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart }))));
            close(); return;
          }
          const orPrecedenceStillBad = postRetryResult.fired.includes("or-and-precedence");
          if (orPrecedenceStillBad) {
            const msg = "I couldn't build a reliable multi-place query after correcting the SQL structure. Try asking for fewer places or restating the comparison.";
            const orPrecedenceProof = finalizeExit({ outcome: OUTCOMES.sql_shape_rejected, sql: claude.sql, guardrails: postRetryResult.fired, planFamily: "or-and-precedence" });
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
            const geographyFailureProof = finalizeExit({ outcome: OUTCOMES.geography_contract_violation, sql: claude.sql, guardrails: postRetryResult.fired, planFamily: "contract-geography" });
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
          const consolidationProof = finalizeExit({ outcome: OUTCOMES.consolidation_mapping, sql: claude.sql, guardrails: firedGuardrails, planFamily: "consolidation-mapping" });
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
            OPERATIONAL_RECORD
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
              // Request accounting stage 2a (K7, defensive): unreachable while the gate above stands; if it were removed, a Historical
              // model statement still fails closed here instead of being retried into an execution.
              if (isHistorical && HISTORICAL_MODEL_SQL_NEVER_RUNS) throw new Error("request accounting: a Historical model statement may not be retried (K7)");
              if (tab === "current" && CURRENT_MODEL_SQL_NEVER_RUNS) throw new Error("request accounting: a Current model statement may not be retried (3a §6)");
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
                    const retryAllowlistProof = finalizeExit({ outcome: OUTCOMES.table_not_allowlisted, sql: retrySql, guardrails: [...firedGuardrails, ...retryTableCheck.fired], planFamily: "table-allowlist", retries: 1 });
                    writeLog(question, retrySql, 0, `table_allowlist_second_failure:${retryTableCheck.unknown.join(",")}`, Date.now() - totalStart, msg, tab, [...firedGuardrails, ...retryTableCheck.fired], "haiku-4.5", sessionId, null, retryAllowlistProof);
                    controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(retryAllowlistProof, { type: "result", sql: null as unknown as string, explanation: msg, title: "", columns: [], rows: [], rowCount: 0, truncated: false, chartConfig: null, chartMeta: null, executionTimeMs: Date.now() - totalStart }))));
                    close();
                    return;
                  }
                }
              }
            }

            const msg = "I couldn't build a valid query for this data source. Try switching tabs or rephrasing the question for the active dataset.";
            const allowlistProof = finalizeExit({ outcome: OUTCOMES.table_not_allowlisted, sql, guardrails: firedGuardrails, planFamily: "table-allowlist" });
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
        // Historical national rape fix: the correction state read in the same snapshot as `rows` (Historical only).
        let historicalCorrected: boolean | undefined;
        // COVER batch: an entirely null series dropped from the table below, stated as returned values in every answer version.
        let allNullSeriesNote = "";

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
          let result: Record<string, unknown>[];
          if (isHistorical) {
            const read = executeWithCorrectionState(db, sql, 30000);
            result = read.rows;
            historicalCorrected = read.corrected;
            cacheValidity = historicalCacheValidity(baseCacheValidity, read.corrected);
          } else {
            result = executeWithTimeoutSync<Record<string, unknown>>(db, stmt, 30000);
          }
          columns = stmt.columns().map((c) => c.name);
          rows = result;
        } catch (dbErr) {
          const msg =
            dbErr instanceof Error ? dbErr.message : String(dbErr);
          // Retry: tell Claude about the error and ask for a corrected query (if budget allows)
          if (isOverBudget()) {
            const ms = Date.now() - totalStart;
            writeLog(question, sql, 0, `DB: ${msg} (over budget)`, ms, null, tab, firedGuardrails, "haiku-4.5", sessionId, null, OPERATIONAL_RECORD);
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
          // Request accounting stage 2a (K7, defensive): unreachable while the gate above stands; if it were removed, a Historical
          // model statement still fails closed here instead of being retried into an execution.
          if (isHistorical && HISTORICAL_MODEL_SQL_NEVER_RUNS) throw new Error("request accounting: a Historical model statement may not be retried (K7)");
              if (tab === "current" && CURRENT_MODEL_SQL_NEVER_RUNS) throw new Error("request accounting: a Current model statement may not be retried (3a §6)");
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
                let retryResult: Record<string, unknown>[];
                if (isHistorical) {
                  const read = executeWithCorrectionState(db, retrySql, 30000);
                  retryResult = read.rows;
                  historicalCorrected = read.corrected;
                  cacheValidity = historicalCacheValidity(baseCacheValidity, read.corrected);
                } else {
                  retryResult = executeWithTimeoutSync<Record<string, unknown>>(db, retryStmt, 30000);
                }
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
                  OPERATIONAL_RECORD
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
                OPERATIONAL_RECORD
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
            writeLog(question, sql, 0, `DB: ${msg}`, ms, null, tab, firedGuardrails, "haiku-4.5", sessionId, null, OPERATIONAL_RECORD);
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

        // Before any factual emission on the answering path: the empty-result reply, the
        // all-null reply and the initial result all read from these.
        ({ explanation: claude.explanation, title: claude.title } =
          authoritativeIdentity(claude.explanation, claude.title));

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
          // F3 (Decision 13): the empty-result exit is one of the paths Decision 13
          // governs, and it returns long before applyResultDisclosures. Classify here and
          // let the shared guard replace any claim the evidence does not support.
          const emptyState = isHistorical
            ? genericResultState({ sql, rows })
            : currentTrendsResultState(db, { sql, rows });
          emptyMsg = governFactualNarrative(emptyMsg, emptyState);
          const emptyProof = finalizeExit({
            outcome: emptyIsSourceAbsence ? OUTCOMES.no_rows_in_source : OUTCOMES.empty_reason_not_established,
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
            // F3 (Decision 13): the all-null exit is likewise a Decision 13 path.
            const allNullState = isHistorical
              ? genericResultState({ sql, rows })
              : currentTrendsResultState(db, { sql, rows });
            const governedAllNullMsg = governFactualNarrative(emptyMsg, allNullState);
            const allNullProof = finalizeExit({
              outcome: allNullIsSourceAbsence ? OUTCOMES.all_values_null : OUTCOMES.empty_reason_not_established,
              sql, columns, guardrails: firedGuardrails, db,
            });
            writeLog(question, sql, 0, "all_null_columns", totalMs, governedAllNullMsg, tab, firedGuardrails, "haiku-4.5", sessionId, null, allNullProof);
            controller.enqueue(
              encoder.encode(
                sseEvent(emitFactualPayload(allNullProof, {
                  type: "result",
                  sql,
                  explanation: governedAllNullMsg,
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
              // COVER batch (Codex :34982): an entirely null series is "no value returned", never a claim that the
              // source lacks data or the agency did not report.
              const names = nullCols.map(c => c.replace(/_/g, ' ')).join(', ');
              allNullSeriesNote = `No value returned for any requested year: ${names} (left out of the table).`;
              claude.explanation += `\n\n${allNullSeriesNote}`;
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

        // GC-085: an annual Historical rape-COUNT series crossing the 2013 definition change gets the application's own
        // neutral description and caveat, replacing the model's prose BEFORE every required disclosure below is added.
        // It is the narrative of the first event, the cache entry and the both-failed fallback; the refined and retry
        // explanations below reuse it instead of asking the model, so no later event can contradict the rows or drop it.
        const rapeSeries = historicalRapeSeries(tab, sql, rows);
        if (rapeSeries) {
          claude.explanation = rapeSeries.narrative;
          firedGuardrails.push("rape-definition-series-owned");
        }
        // Composite measure (Codex :35465): the U.S. national violent-crime sum of the four UCR components gets the
        // application's own description from its SQL binding, delivered the same way, so no later explanation can name
        // only some of the components.
        // Offense binding (Codex :35871): a sexual-assault request answered with the UCR rape measure (bound by the contract
        // validator) carries the category limitation in every version; GC-085's own description keeps precedence when it applies.
        const sexualAssaultNarrative = rapeSeries ? null : sexualAssaultRapeNarrative(tab, deliveryQuestion, sql, rows);
        if (sexualAssaultNarrative) {
          claude.explanation = sexualAssaultNarrative;
          firedGuardrails.push("sexual-assault-rape-owned");
        }
        const compositeSeries = rapeSeries || sexualAssaultNarrative ? null : historicalViolentComposite(tab, sql, rows);
        if (compositeSeries) {
          claude.explanation = compositeSeries.narrative;
          firedGuardrails.push("violent-composite-owned");
        }
        // AGENCY+RANK correction F2 (Codex :36392): across Chicago's 2024/2025 assault boundary the model's interpretation
        // (e.g. an "84.4% reduction") is replaced by the application's neutral description and limitation, in every version.
        const chicagoNarrative = rapeSeries || sexualAssaultNarrative || compositeSeries ? null : chicagoAssaultNarrative(tab, sql, rows);
        if (chicagoNarrative) {
          claude.explanation = chicagoNarrative;
          firedGuardrails.push("chicago-assault-comparability-owned");
        }
        const ownedNarrative = rapeSeries?.narrative ?? sexualAssaultNarrative ?? compositeSeries?.narrative ?? chicagoNarrative ?? null;

        /*
         * Decision 17: withhold an unverified year-over-year change BEFORE anything is delivered.
         *
         * GC-055 returned `pct_change: -61.9` for partial 2026 against complete 2025 — a value the
         * query's own LAG() computed, so no wording change removes it. The presentation result is
         * built here, ahead of the chart and the first emit, and `rows` (the executed evidence) is
         * left exactly as the query returned it.
         */
        const presentation = withholdUnverifiedChange({
          rows, columns, sql,
          explanation: claude.explanation || "", title: claude.title || "",
          // `question` is already in scope here (it is passed to buildChartConfig below), so the
          // relevance signal reaches the FIRST answer rather than only the later explanation.
          question,
        });
        const deliveredRows = presentation.rows;
        const deliveredColumns = presentation.columns;
        // ONE presentation decision. `presentation.explanation` already has the offending claim
        // removed, the withholding stated and the period sentences applied, so the first answer
        // carries them -- the later explanation cannot un-send what has gone out.
        claude.explanation = presentation.explanation;
        claude.title = presentation.title || claude.title;
        if (presentation.note) firedGuardrails.push("unverified-change-withheld");

        // Step 5: Build chart config + metadata — from the presentation result, so a withheld
        // change cannot survive as a charted series.
        const chartConfig = presentation.cleanChart(buildChartConfig(claude, deliveredColumns, deliveredRows, question));
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
        // GC-098: the Baltimore default is disclosed by the application, before the first factual
        // event, and reapplied after each rewrite below, so a model omission or retry cannot drop it.
        if (baltimoreDefault) claude.explanation = withBaltimoreDisclosure(claude.explanation || "", baltimoreDefault);

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
        // F3 (Decision 13): the STREAMING route sends this factual narrative before
        // applyResultDisclosures ever runs, and a later corrected explanation cannot
        // un-send unsafe wording. Govern it here, so the proof narrative and the bytes
        // the user receives are the same governed text.
        const initialState = isHistorical
          ? genericResultState({ sql, rows })
          : currentTrendsResultState(db, { sql, rows });
        // Row presence is forwarded so a populated streamed answer is not discarded here —
        // this call sends before applyResultDisclosures runs, and a later correction cannot
        // un-send it. Argument plumbing only; the branch and stream protocol are unchanged.
        // COVER batch (Codex :34982): the coverage these rows actually returned is stated in the FIRST answer too, not
        // only in the refined explanation. The same idempotent statement is reapplied by applyResultDisclosures on the
        // refined text and its retry, and this text is the both-failed fallback and the cache entry, so every version
        // carries it exactly once. Disclosure only: rows, SQL and values are unchanged.
        claude.explanation = withReturnedCoverage(claude.explanation || "", deliveryQuestion, sql, rows);
        claude.explanation = governFactualNarrative(
          claude.explanation || "", initialState, null, { hasFigures: rows.length > 0 });
        // AGENCY+RANK batch: the scoped Chicago assault comparability limitation (lib/chicago-assault-comparability.ts),
        // in this first text (also the fallback and cache entry) and again, idempotently, in applyResultDisclosures.
        claude.explanation = withChicagoAssaultComparability(claude.explanation || "", sql, rows);
        if (isHistorical && typeof historicalCorrected === "boolean") {
          claude.explanation = withHistoricalNationalRapeNotes(claude.explanation || "", sql, rows, historicalCorrected);
        }

        const finalization = finalizeExit({
          outcome: OUTCOMES.model_sql_validated,
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
              /*
               * The FINAL checked narrative, not the earlier presentation snapshot.
               * `claude.explanation` already carries the presentation decision AND the single-row,
               * sample and reliability caveats and the governor that runs after it — sending the
               * snapshot dropped those caveats and restored a claim the safeguard had removed.
               * This is also the text handed to finalizeExit, so proof and payload agree.
               */
              explanation: claude.explanation,
              title: claude.title || "Results",
              columns: deliveredColumns,
              rows: deliveredRows,
              rowCount: deliveredRows.length,
              truncated,
              chartConfig,
              chartMeta,
              executionTimeMs,
            }))
          )
        );

        // Step 6: Generate refined explanation in background, send as update
        // Re-extract context from final SQL (may have been fixed by guardrails/retry)
        const finalCtx = { ...extractQueryContext(sql, guardrailQuestion, tab as "current" | "historical"), requiredOri: requiredCountyOri };
        try {
          let postExplanation = ownedNarrative ? ownedNarrative : await generateExplanation({
            ctx: finalCtx,
            columns,
            rows,
            rowCount: rows.length,
            disclaimers: "",  // let buildDisclaimers handle all disclaimers deterministically
            preQueryExplanation: withoutBaltimoreDisclosure(claude.explanation, baltimoreDefault),
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
          // Increment 1 (Decision 13): classify the result state from this source's own
          // evidence, then let the shared chokepoint refuse any empty-state claim the
          // evidence does not support. Unknown stays unknown.
          const resultState = isHistorical
            ? genericResultState({ sql, rows })
            : currentTrendsResultState(getDb(), { sql, rows });
          // Increment 4 (Decision 10): when a county name was answered with a sheriff's
          // agency, say so. The resolver above already made the choice; this only
          // discloses it, so the two cannot drift apart.
          const resolvedAgency: ResolvedAgency | undefined = countyAgency.kind === "resolved"
            ? {
                requested: `${countyAgency.county} County, ${countyAgency.state}`,
                agencyName: countyAgency.agency,
                state: countyAgency.state,
                kind: /sheriff/i.test(countyAgency.agency) ? "county_sheriff" : "other",
              }
            : undefined;
          postExplanation = applyResultDisclosures({ explanation: postExplanation, question: deliveryQuestion, sql, rows, tab, historicalNationalRapeCorrected: historicalCorrected, resultState, resolvedAgency });
          if (allNullSeriesNote && !postExplanation.includes(allNullSeriesNote)) postExplanation += `\n\n${allNullSeriesNote}`;
          // A later explanation must not quietly drop the withholding the first answer carried.
          postExplanation = appendWithheldChangeNote(presentation.strip(postExplanation), presentation.note);
          if (missingLowerBoundNote(deliveryQuestion, sql, rows) && !firedGuardrails.includes("lower-bound-disclosed")) firedGuardrails.push("lower-bound-disclosed");
          const grainCheck = validateGrain(deliveryQuestion, rows, sql);
          if (!grainCheck.ok && grainCheck.message) {
            postExplanation = grainCheck.message;
            if (!firedGuardrails.includes("grain-mismatch")) firedGuardrails.push("grain-mismatch");
            // This replacement discards everything above it. The change cells are still unavailable,
            // so the explanation for that has to be restated here rather than lost.
            postExplanation = appendWithheldChangeNote(presentation.strip(postExplanation), presentation.note);
          }
          // The grain override REPLACES the text, so the caveat is reapplied (dedup-guarded).
          postExplanation = withReliabilityNote(postExplanation);
          postExplanation = withBaltimoreDisclosure(postExplanation, baltimoreDefault);
          const safePost = sanitizeUserFacingNarrative(postExplanation, claude.title || "Results");
          postExplanation = safePost.explanation || "";
          if (containsInternalScaffold(postExplanation)) {
            console.log(`[query][internal-scaffold] Stripping scaffold text from post-query explanation`);
            postExplanation = stripInternalScaffold(postExplanation) || claude.explanation;
          }
          postExplanation = authoritativeNarrative(postExplanation);
          // The proof that describes what the user actually ended up reading. Starts as
          // the result event's finalization and is replaced when the narrative is.
          let deliveredFinalization = finalization;
          if (postExplanation !== claude.explanation) {
            // Re-finalized against the REFINED text, not reusing the finalization that
            // gated the result event: this narrative is different, and the difference
            // is exactly what needs proving. A grain override replaces it wholesale.
            const postFinalization = finalizeExit({
              outcome: OUTCOMES.model_sql_validated,
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
            setCache(question, tab === "historical" ? HISTORICAL_CACHE_TAB : CURRENT_CACHE_TAB, { sql, explanation: claude.explanation, title: claude.title, chartType: claude.chartHint, xAxis: claude.xAxis, yAxis: claude.yAxis ? claude.yAxis.split(",").map(s => s.trim()) : undefined, yAxisLabel: claude.yAxisLabel, xAxisLabel: claude.xAxisLabel, colors: claude.colors, annotations: claude.annotations }, cacheValidity);
          }
        } catch {
          // Retry post-query explanation once before falling back
          try {
            let retryExplanation = ownedNarrative ? ownedNarrative : await generateExplanation({
              ctx: finalCtx,
              columns,
              rows,
              rowCount: rows.length,
              disclaimers: "",
              preQueryExplanation: withoutBaltimoreDisclosure(claude.explanation, baltimoreDefault),
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
            // F3: the retry narrative is a factual narrative too and must be governed.
            const retryState = isHistorical
              ? genericResultState({ sql, rows })
              : currentTrendsResultState(db, { sql, rows });
            retryExplanation = applyResultDisclosures({ explanation: retryExplanation, question: deliveryQuestion, sql, rows, tab, historicalNationalRapeCorrected: historicalCorrected, resultState: retryState });
            if (allNullSeriesNote && !retryExplanation.includes(allNullSeriesNote)) retryExplanation += `\n\n${allNullSeriesNote}`;
            retryExplanation = appendWithheldChangeNote(presentation.strip(retryExplanation), presentation.note);
            if (missingLowerBoundNote(deliveryQuestion, sql, rows) && !firedGuardrails.includes("lower-bound-disclosed")) firedGuardrails.push("lower-bound-disclosed");
            const retryGrainCheck = validateGrain(deliveryQuestion, rows, sql);
            if (!retryGrainCheck.ok && retryGrainCheck.message) {
              retryExplanation = retryGrainCheck.message;
              if (!firedGuardrails.includes("grain-mismatch")) firedGuardrails.push("grain-mismatch");
              // Same as the post path: the replacement discards the withholding, so restate it.
              retryExplanation = appendWithheldChangeNote(presentation.strip(retryExplanation), presentation.note);
            }
            retryExplanation = withReliabilityNote(retryExplanation);
            retryExplanation = withBaltimoreDisclosure(retryExplanation, baltimoreDefault);
            const safeRetry = sanitizeUserFacingNarrative(retryExplanation, claude.title || "Results");
            retryExplanation = safeRetry.explanation || "";
            if (containsInternalScaffold(retryExplanation)) {
              console.log(`[query][internal-scaffold] Stripping scaffold text from retry explanation`);
              retryExplanation = stripInternalScaffold(retryExplanation) || claude.explanation;
            }
            retryExplanation = authoritativeNarrative(retryExplanation);
            let deliveredRetryFinalization = finalization;
            if (retryExplanation !== claude.explanation) {
              const retryFinalization = finalizeExit({
                outcome: OUTCOMES.model_sql_validated,
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
            setCache(question, tab === "historical" ? HISTORICAL_CACHE_TAB : CURRENT_CACHE_TAB, { sql, explanation: claude.explanation, title: claude.title, chartType: claude.chartHint, xAxis: claude.xAxis, yAxis: claude.yAxis ? claude.yAxis.split(",").map(s => s.trim()) : undefined, yAxisLabel: claude.yAxisLabel, xAxisLabel: claude.xAxisLabel, colors: claude.colors, annotations: claude.annotations }, cacheValidity);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const ms = Date.now() - totalStart;
        writeLog(question, sql, 0, msg, ms, null, tab, finalizeGuardrailTags(firedGuardrails, queryContractGuardrails(runContractValidation(sql || ""))), "haiku-4.5", sessionId, null, OPERATIONAL_RECORD);
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
