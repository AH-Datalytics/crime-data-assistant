import { buildQueryContract, type QueryContract, type QueryContractSource } from "./query-contract";
import {
  cteReferences, escapeRegExp, flattenParens, splitCtes, stripSqlComments,
  tablesWithUnrestrictedYear, topLevelFilterRegions,
} from "./sql-restriction";
import { analyzeSql } from "./sql-lineage";
import { tableSemantics } from "./table-semantics";
import { currentCalendarYear } from "./time-conventions";
import type { RoutingLogMeta } from "./routing-log-meta";
import { validateSourceCapabilities, type SourceCapabilityFinding } from "./source-capabilities";
import { findHistoricalRankingIssues } from "./historical-ranking-request";
import { findNibrsClearanceRankingIssues } from "./nibrs-clearance-ranking-request";
import { DIMENSION_COLUMNS, evaluateStructuralSemantics } from "./structural-semantics";
import { observeHistoricalClearanceGrain, type ClearanceGrainObservation } from "./historical-clearance-grain";
import { DEMOGRAPHIC_RATE_UNSUPPORTED_MESSAGE, SUB_CITY_GEOGRAPHY_MESSAGE } from "./capability-overrides";
import { classifyCapabilityRule } from "./capability-decision";
import { OUTCOMES } from "./proof-contract";
import { measureDriftIssue, MEASURE_DRIFT_GUARDRAIL } from "./measure-preservation";
import { bindSexualAssaultMeasure } from "./historical-offense-binding";

/** The typed pair a capability block finalizes with; null when no block rule fired. */
export type CapabilityBlockOutcome = typeof OUTCOMES.query_contract_failed | null;

export interface QueryContractSqlValidation {
  sql: string;
  fired: string[];
  warnings: string[];
  capabilityFindings: SourceCapabilityFinding[];
  retryIssues: string[];
  blockReasons: string[];
  enforced: string[];
  /**
   * The typed catalog outcome a fired capability BLOCK rule carries, or null when none fired.
   *
   * Supplied by `classifyCapabilityRule()` in `lib/capability-decision.ts` - the same call the
   * P3.1a request-decision observer makes - so the block classification has exactly one author.
   */
  capabilityOutcome: CapabilityBlockOutcome;
  /**
   * The Historical clearance-grain finding, recorded on every validation so the property stays
   * measurable.
   *
   * Recording is not acting. Only a finding whose `enforceable` flag is set -- today, a state-grain
   * clearance request whose state resolved with HIGH confidence -- ALSO lands in `blockReasons` and
   * `enforced`. A medium/low-confidence state, and every `historical-clearance-measure-absent`
   * finding, appear here and nowhere else, so they can be measured without changing any user-facing
   * outcome.
   */
  clearanceGrainObservation: ClearanceGrainObservation | null;
}

const CONTRACT_SECOND_FAILURE_MESSAGE =
  "I couldn't build a reliable query that matched the requested source, geography, metric, and time period. Try narrowing the question or choosing one of the suggested alternatives.";


/**
 * The block/retry membership sets AND the classification that reads them both live in
 * `lib/capability-decision.ts`. This file used to declare the two Sets privately and test them with
 * its own `if/else if`. Sharing only the Sets was not enough: membership was then common while the
 * *consequence* was still decided in two places, so branch order or the typed outcome could change
 * for the observer without changing production. `classifyCapabilityRule()` is now the only thing
 * that decides what a fired capability finding means, and this file consumes its result.
 */

const BLOCK_MESSAGES: Record<string, string> = {
  "unsupported-sub-city-geography":
    SUB_CITY_GEOGRAPHY_MESSAGE,
  "vehicle-burglary-unsupported":
    "Thefts from vehicles are tracked separately in NIBRS as theft from a motor vehicle. This source only carries the broader burglary category, so it cannot answer that question. The NIBRS tab can.",
  "unsupported-court-policy-topic":
    "The available FBI datasets track reported crime and law-enforcement reporting, not court outcomes, incarceration, fines, immigration status, or policy registries.",
  "demographic-rate-unsupported":
    DEMOGRAPHIC_RATE_UNSUPPORTED_MESSAGE,
  "nibrs-clearance-weapon-unsupported":
    "The available NIBRS summary data cannot calculate clearance rates broken down by weapon type. I can answer overall clearance rates, or weapon-specific counts, but not weapon-specific clearance rates.",
  "nibrs-countywide-demographics-unsupported":
    "Countywide NIBRS demographic breakdowns are not reliable from the available summaries because county totals combine agencies with different reporting participation and completeness. Try a specific agency/city demographic breakdown, or a countywide total without demographics.",
  "nibrs-shooting-category-unsupported":
    "The FBI does not systemically track all shootings. You can query fatal shootings specifically or aggravated assaults with a firearm as a broader measure.",
  "shr-non-homicide-unsupported":
    "The Homicide Reports dataset contains only homicide data. For non-homicide offenses, arrests, staffing, or broad crime categories, use Current Trends, Historical, or NIBRS depending on the question.",
  "shr-clearance-unsupported":
    "The Homicide Reports dataset does not track whether cases were solved or cleared. For clearance rates, use Historical or NIBRS data.",
  "shr-demographic-rate-unsupported":
    "The FBI data does not include matching population denominators for demographic groups. Better choices: counts by gender/race, or an overall homicide rate.",
};

function countyKey(value: string | null): string | null {
  if (!value) return null;
  const key = value
    .replace(/\b(county|parish|borough)\b/ig, " ")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return key || null;
}

function capabilityRetryIssue(finding: SourceCapabilityFinding, contract: ReturnType<typeof buildQueryContract>): string {
  const expected = finding.expectedTables?.length
    ? ` Use one of these table(s): ${finding.expectedTables.join(", ")}.`
    : "";
  const forbidden = finding.forbiddenTables?.length
    ? ` Do not use: ${finding.forbiddenTables.join(", ")}.`
    : "";
  const actual = finding.actualTables.length
    ? ` Current SQL used: ${finding.actualTables.join(", ")}.`
    : " Current SQL did not reference a usable data table.";
  const countywideDetail = finding.ruleId.endsWith("countywide-crosswalk") && contract
    ? ` For countywide geography, join agency_county_crosswalk on the metric table ORI (metric_alias.ori = ac.ori9 OR substr(metric_alias.ori, 1, 7) = ac.ori), filter ac.county_key = '${countyKey(contract.geography.name) ?? "[COUNTY_KEY]"}'${contract.geography.state ? ` and ac.state = '${contract.geography.state}'` : ""}, and do not filter to a single county/sheriff agency unless the user explicitly asked for that agency.`
    : "";
  return `[SYSTEM: Query contract violation (${finding.ruleId}). ${finding.message}${expected}${forbidden}${actual}${countywideDetail} Rewrite the SQL so it satisfies the user's requested source, geography, metric, and time contract. Do not execute a query that violates this contract.]`;
}

export function queryContractFailureMessage(result: QueryContractSqlValidation): string | null {
  return result.blockReasons[0] ?? (result.retryIssues.length > 0 ? CONTRACT_SECOND_FAILURE_MESSAGE : null);
}

/**
 * The typed outcome a route must finalize a contract failure with.
 *
 * WHY A HELPER AND NOT A LITERAL AT EACH ROUTE. Before this, every route looked the catalog member
 * up for itself. Both ends named the same thing, so a test could prove they were equal today - but
 * equality is not delivery. The classifier's decision never actually travelled to finalization, and
 * a later catalog or routing change could strand the carrier while each route still found a valid
 * literal. Round 3 named that exactly: the requirement is causal delivery, not present equality.
 *
 * So the classification is DELIVERED. When a capability block fired, this returns the very object
 * `classifyCapabilityRule()` produced and the validator carried on the result. The fallback covers
 * contract failures that no capability rule caused - a missing required ORI, a clearance-grain
 * block, the second-failure message - which have no capability classification to deliver and keep
 * the catalog member they always used.
 *
 * Behaviour is unchanged either way: the carrier IS `OUTCOMES.query_contract_failed`, so both
 * branches return the same object today. What changes is where the value comes from, which is the
 * thing that has to be true for the linkage to survive a refactor.
 */
export function capabilityFinalizationOutcome(result: QueryContractSqlValidation) {
  return result.capabilityOutcome ?? OUTCOMES.query_contract_failed;
}

export function queryContractGuardrails(result: QueryContractSqlValidation): string[] {
  return [...new Set([...result.fired, ...result.enforced])];
}

function hasOpenEndedOrRangeTimeIntent(question: string): boolean {
  return /\b(?:since|starting|beginning|between|through|thru|until|past|last|rolling|trends?|changed|change\s+over|over\s+time)\b/i.test(question) ||
    /\bfrom\s+(?:19|20)\d{2}\s+(?:to|through|until|and|-)\s+(?:(?:19|20)\d{2}|present|current|now|today|date)\b/i.test(question) ||
    /\b(?:19|20)\d{2}\s*(?:-|to|through)\s*(?:(?:19|20)\d{2}|present|current|now|today|date)\b/i.test(question);
}

function isSingleYearPointContract(question: string, contract: QueryContract): boolean {
  const { startYear, endYear } = contract.time;
  if (startYear === null || endYear === null || startYear !== endYear) return false;
  if (contract.followup.operation === "chart_only" || contract.followup.operation === "metadata") return false;
  // An amended request carries its own series form. Its question text is the reader's fragment, so
  // reading "rolling" from it would find nothing and demand a single-year filter that a rolling
  // 12-month series -- which needs the preceding year's months -- cannot satisfy.
  if (contract.request) {
    if (contract.request.window === "rolling_12") return false;
  } else if (hasOpenEndedOrRangeTimeIntent(question)) return false;
  return contract.metric.unit !== "unknown" || contract.metric.topic !== "unknown";
}

function yearRefPattern(): string {
  return String.raw`\b(?:\w+\.)?(?:year|data_year)\b`;
}

function hasRequestedSingleYearPredicate(sql: string, year: number): boolean {
  const yearRef = yearRefPattern();
  const y = String.raw`'?${year}'?`;
  return new RegExp(String.raw`${yearRef}\s*=\s*${y}`, "i").test(sql) ||
    new RegExp(String.raw`${yearRef}\s+BETWEEN\s+${y}\s+AND\s+${y}`, "i").test(sql) ||
    new RegExp(String.raw`${yearRef}\s+IN\s*\([^)]*\b${year}\b[^)]*\)`, "i").test(sql);
}

function hasBroadYearPredicateForSingleYear(sql: string, year: number): boolean {
  const yearRef = yearRefPattern();
  const y = String.raw`'?${year}'?`;
  if (new RegExp(String.raw`${yearRef}\s*<\s*${y}`, "i").test(sql)) return true;
  if (new RegExp(String.raw`${yearRef}\s*<=\s*${y}`, "i").test(sql)) return true;

  const geRe = new RegExp(String.raw`${yearRef}\s*>=\s*'((?:19|20)\d{2})'`, "gi");
  const geBareRe = new RegExp(String.raw`${yearRef}\s*>=\s*((?:19|20)\d{2})`, "gi");
  for (const re of [geRe, geBareRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(sql)) !== null) {
      if (Number(match[1]) < year) return true;
    }
  }

  const betweenRe = new RegExp(String.raw`${yearRef}\s+BETWEEN\s+'?((?:19|20)\d{2})'?\s+AND\s+'?((?:19|20)\d{2})'?`, "gi");
  let between: RegExpExecArray | null;
  while ((between = betweenRe.exec(sql)) !== null) {
    const start = Number(between[1]);
    const end = Number(between[2]);
    if (start !== year || end !== year) return true;
  }

  const inRe = new RegExp(String.raw`${yearRef}\s+IN\s*\(([^)]*)\)`, "gi");
  let inMatch: RegExpExecArray | null;
  while ((inMatch = inRe.exec(sql)) !== null) {
    const years = (inMatch[1].match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
    if (years.some((value) => value !== year)) return true;
  }

  return false;
}

/**
 * The metric tables this statement reads, named by the catalog rather than by column guesswork.
 *
 * These are the relations whose rows become the number. A population, identity or crosswalk table
 * may legitimately be pinned to a different period -- or to none -- without saying anything about
 * the measure, which is exactly how GC-054's `agency_population WHERE year = 2026` came to stand in
 * for a numerator that had no year predicate at all.
 */
function metricTablesOf(sql: string, source: QueryContractSource) {
  return analyzeSql(sql).baseTables
    .map((table) => ({ table, entry: tableSemantics(source, table) }))
    .filter(({ entry }) => entry?.role === "metric")
    .map(({ table, entry }) => ({ table, periodFrom: entry!.periodFrom }));
}

function singleYearTemporalScopeIssue(
  question: string, contract: QueryContract, sql: string, source: QueryContractSource
): string | null {
  if (!isSingleYearPointContract(question, contract)) return null;
  const year = contract.time.startYear;
  if (year === null) return null;

  /*
   * THE YEAR HAS TO REACH THE ROWS THAT BECOME THE NUMBER.
   *
   * Both original tests searched the WHOLE statement, and both were wrong in the same direction and
   * for the same reason. `hasRequestedSingleYearPredicate` accepted GC-054 because a population CTE
   * said `year = 2026` while the metric table had no year predicate at all. Its twin,
   * `hasBroadYearPredicateForSingleYear`, would refuse a correctly pinned numerator because some
   * unrelated support table spanned a range -- a support table's period overriding a proved metric
   * period, which the acceptance criteria forbid.
   *
   * So when the catalog knows which tables carry the measure, BOTH are replaced by one question
   * asked per alias, in each scope that reads that alias into a number: is this alias's own year
   * pinned to the requested year? A range, a broader `IN`, or nothing at all all fail it, so the
   * broad case needs no separate veto.
   *
   * When the catalog knows no metric table, the original whole-statement pair still decides, which
   * is the behaviour every non-catalogued source had before.
   */
  const metricTables = metricTablesOf(sql, source);
  const unrestrictedMetric = metricTables.length > 0
    ? tablesWithUnrestrictedYear(sql, year, metricTables, DIMENSION_COLUMNS)
    : [];
  const unprovenYear = metricTables.length > 0
    ? unrestrictedMetric.length > 0
    : hasBroadYearPredicateForSingleYear(sql, year) || !hasRequestedSingleYearPredicate(sql, year);

  if (unprovenYear) {
    const partial = contract.time.partialYear
      ? ` For Current Trends partial-year ${year} queries, use year = ${year} plus the latest available month cutoff; do not include prior years in the numerator.`
      : "";
    // Naming the open table is what makes the retry actionable: without it the instruction reads as
    // "add a year predicate" to a statement that visibly already has one, somewhere else.
    const named = unrestrictedMetric.length > 0
      ? ` No year predicate restricts ${unrestrictedMetric.join(", ")}; a year filter on a population or support table does not limit the measure.`
      : "";
    return `[SYSTEM: Query contract violation (contract-single-year-temporal-scope). The user asked for ${year} only, but the SQL does not keep the metric/count numerator limited to that single year.${named} Rewrite the SQL so fact-table year/data_year predicates use = ${year} or BETWEEN ${year} AND ${year}. Do not use year < ${year}, year <= ${year}, year >= an older year, or BETWEEN an older year AND ${year} unless the user explicitly asks for a trend, rolling window, or multi-year comparison.${partial}]`;
  }

  return null;
}
function isTrendAssessmentFollowupQuestion(question: string): boolean {
  const q = question.trim();
  if (/\btrend assessment follow-up\b/i.test(q)) return true;
  if (q.length > 140) return false;

  return (
    /^(?:is|are|was|were)\s+(?:it|that|this|they|those)\s+(?:getting\s+)?(?:better|worse|higher|lower|rising|falling|improving|declining|up|down)\??$/i.test(q) ||
    /^(?:has|have)\s+(?:it|that|this|they|those)\s+(?:gotten|become|improved|declined|risen|fallen|increased|decreased)\b.*\??$/i.test(q) ||
    /^(?:which|what)\s+(?:is|was|were)\s+(?:higher|lower|worse|better)\??$/i.test(q)
  );
}

function isKnownPartialCurrentSource(source: QueryContractSource): boolean {
  return source === "current" || source === "nibrs" || source === "shr";
}

function groupedAnnuallyByYear(sql: string): boolean {
  const groupMatch = sql.match(/\bGROUP\s+BY\s+([\s\S]*?)(?:\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i);
  if (!groupMatch) return false;
  const groupExpr = groupMatch[1];
  return /\b(?:\w+\.)?(?:year|data_year)\b/i.test(groupExpr) && !/\b(?:\w+\.)?month\b/i.test(groupExpr);
}

function hasCompleteYearUpperCap(sql: string, currentYear: number): boolean {
  const lastComplete = currentYear - 1;
  const yearRef = yearRefPattern();
  if (new RegExp(String.raw`${yearRef}\s*<\s*'?${currentYear}'?`, "i").test(sql)) return true;
  if (new RegExp(String.raw`${yearRef}\s*<=\s*'?${lastComplete}'?`, "i").test(sql)) return true;

  const betweenRe = new RegExp(String.raw`${yearRef}\s+BETWEEN\s+'?((?:19|20)\d{2})'?\s+AND\s+'?((?:19|20)\d{2})'?`, "gi");
  let between: RegExpExecArray | null;
  while ((between = betweenRe.exec(sql)) !== null) {
    if (Number(between[2]) <= lastComplete) return true;
  }

  return false;
}

function annualTrendMayIncludeCurrentPartialYear(sql: string, currentYear: number): boolean {
  if (!groupedAnnuallyByYear(sql)) return false;
  if (hasCompleteYearUpperCap(sql, currentYear)) return false;

  const yearRef = yearRefPattern();
  if (new RegExp(String.raw`${yearRef}\s*=\s*'?${currentYear}'?`, "i").test(sql)) return true;
  if (new RegExp(String.raw`${yearRef}\s*<=\s*'?${currentYear}'?`, "i").test(sql)) return true;
  if (new RegExp(String.raw`${yearRef}\s+BETWEEN\s+'?(?:19|20)\d{2}'?\s+AND\s+'?${currentYear}'?`, "i").test(sql)) return true;
  if (new RegExp(String.raw`${yearRef}\s+IN\s*\([^)]*\b${currentYear}\b[^)]*\)`, "i").test(sql)) return true;

  // A lower-bound-only annual trend on a partial-current source will include
  // the current partial year if rows have already been loaded.
  if (new RegExp(String.raw`${yearRef}\s*>=\s*'?(?:19|20)\d{2}'?`, "i").test(sql)) return true;

  return !new RegExp(String.raw`${yearRef}\s*(?:<|<=|=|BETWEEN|IN\s*\()`, "i").test(sql);
}

function finalSelectIncludesMonth(sql: string): boolean {
  const matches = Array.from(sql.matchAll(/\bSELECT\b([\s\S]*?)\bFROM\b/gi));
  if (matches.length === 0) return false;
  const finalSelect = matches[matches.length - 1]?.[1] || "";
  return /\b(?:\w+\.)?month\b/i.test(finalSelect);
}

function trendAssessmentAnnualizedOutputIssue(question: string, source: QueryContractSource, sql: string): string | null {
  if (!isTrendAssessmentFollowupQuestion(question)) return null;
  if (!finalSelectIncludesMonth(sql)) return null;

  const current = currentCalendarYear();
  const lastComplete = current - 1;
  const completeYearClause = isKnownPartialCurrentSource(source)
    ? ` Also cap partial-current data out of the full-year comparison with year < ${current}, year <= ${lastComplete}, data_year < ${current}, or an equivalent fact-table year predicate.`
    : "";

  return `[SYSTEM: Query contract violation (contract-trend-followup-annualized-output). This is a trend-assessment follow-up, but the final SELECT returns monthly rows. Rewrite the SQL to return one row per complete year, aggregating the prior monthly count/rate/share metric to annual totals or annual rates. Monthly CTEs are allowed internally, but the final SELECT should not include month.${completeYearClause} The explanation must give a direct better/worse/rising/falling conclusion from the first and latest complete years.]`;
}
function trendAssessmentCompleteYearIssue(question: string, source: QueryContractSource, sql: string): string | null {
  if (!isTrendAssessmentFollowupQuestion(question)) return null;
  if (!isKnownPartialCurrentSource(source)) return null;
  if (!annualTrendMayIncludeCurrentPartialYear(sql, currentCalendarYear())) return null;

  const current = currentCalendarYear();
  const lastComplete = current - 1;
  return `[SYSTEM: Query contract violation (contract-trend-followup-complete-years). This is a trend-assessment follow-up, and the SQL returns annual rows that may include incomplete ${current} data. Rewrite the SQL to cap the annual comparison at complete years only: add year < ${current}, year <= ${lastComplete}, data_year < ${current}, or an equivalent upper-bound predicate on the fact-table year. Do not include ${current} as an annual trend point unless the user explicitly asked for YTD/current-year data.]`;
}
function rewriteStateEquals(sql: string, requestedState: string, sourceState: string | string[]): string {
  const sourceStates = Array.isArray(sourceState) ? sourceState : [sourceState];
  if (sourceStates.length === 1 && requestedState.toUpperCase() === sourceStates[0].toUpperCase()) return sql;

  const candidates = [...new Set([requestedState, ...sourceStates].map((state) => state.toUpperCase()))];
  const pattern = new RegExp(`\\b((?:\\w+\\.)?state)\\s*=\\s*'(${candidates.join("|")})'`, "gi");
  if (sourceStates.length === 1) return sql.replace(pattern, `$1 = '${sourceStates[0]}'`);
  return sql.replace(pattern, `$1 IN (${sourceStates.map((state) => `'${state}'`).join(",")})`);
}

function hasStateFilter(sql: string): boolean {
  const stateRef = String.raw`(?:UPPER\s*\(\s*)?(?:\w+\.)?state\s*\)?`;
  const stateLiteral = String.raw`(?:UPPER\s*\(\s*)?'[^']+'\s*\)?`;
  return new RegExp(String.raw`\b${stateRef}\s*=\s*${stateLiteral}`, "i").test(sql) ||
    new RegExp(String.raw`\b${stateRef}\s+IN\s*\(\s*'[^']+'`, "i").test(sql);
}
function hasLocalPlaceFilter(sql: string): boolean {
  return /\b(?:\w+\.)?(?:agency|agency_name|canonical_agency|city|county|alias_key)\s*(?:=|LIKE|IN\s*\()\s*'[^']+'/i.test(sql);
}

function hasSpecificOriFilter(sql: string): boolean {
  return /\bori\s*=\s*'[^']+'/i.test(sql) ||
    /\bori\s+IN\s*\(\s*(?:'[^']+'|SELECT\b)/i.test(sql) ||
    hasLiteralOriTargetJoin(sql);
}

export function hasLiteralOriTargetJoin(sql: string): boolean {
  const cte = /\b([A-Za-z_]\w*)\s*\(([^)]*\bori\b[^)]*)\)\s+AS\s*\(\s*VALUES\b/i.exec(sql);
  if (!cte) return false;
  const cteName = cte[1];
  const valuesStart = cte.index + cte[0].length;
  const valuesSample = sql.slice(valuesStart, valuesStart + 4000);
  if (!/'(?=[A-Z0-9]*\d)[A-Z]{2}[A-Z0-9]{3,10}'/i.test(valuesSample)) return false;

  const escapedName = escapeRegExp(cteName);
  const aliasMatch = new RegExp(`\\b(?:FROM|JOIN)\\s+${escapedName}\\s+(?:AS\\s+)?([A-Za-z_]\\w*)`, "i").exec(sql);
  if (!aliasMatch) return false;
  const alias = escapeRegExp(aliasMatch[1]);
  return new RegExp(`\\b(?:[A-Za-z_]\\w*\\.)?ori\\s*=\\s*${alias}\\.ori\\b|${alias}\\.ori\\s*=\\s*(?:[A-Za-z_]\\w*\\.)?ori\\b`, "i").test(sql);
}

/**
 * Does this SQL actually restrict to one agency's ORI?
 *
 * Mentioning the code is not targeting it. The first version of this test asked only whether
 * the quoted literal appeared anywhere, which a two-agency query passes by putting the ORI in
 * a comment, selecting it as a label, or naming it in an unrelated expression -- and then the
 * answer still comes from both departments. What has to be true is that a restrictive
 * predicate on an `ori` column names it, and that no other agency is admitted alongside.
 */
const ORI_COLUMN = "(?:[A-Za-z_]\\w*\\.)?ori";



/**
 * Does this SQL actually restrict returned rows to one agency's ORI?
 *
 * Requiring an ORI comparison was not enough: a comparison is not a restriction. These all
 * contained the code and returned other agencies' data anyway --
 * `SELECT ha.ori = 'X' AS is_selected` (a column, not a filter),
 * `WHERE hac.ori = 'X' OR 1 = 1` (a tautology reopens everything), and
 * `WHERE 'X' = hac.ori OR 'Y' = hac.ori` (the other-agency scan only knew column-first form).
 *
 * The rule is deliberately conservative, because these are queries the application itself
 * caused by resolving a specific agency: one unambiguous equality, or a single-value `IN`, in
 * a top-level `WHERE` or join `ON`, with no `OR` anywhere in that filter. Refusing a safe but
 * convoluted query costs a retry. Admitting an unsafe one reports the wrong department's
 * figures under the right department's name.
 */
export function sqlTargetsOri(sql: string, ori: string): boolean {
  if (!ori) return true;
  const stripped = stripSqlComments(sql || "");
  const target = escapeRegExp(ori);
  const wanted = ori.toUpperCase();

  // Any ORI compared against a literal that is not the required one defeats the pin, wherever
  // it sits and whichever way round it is written.
  const columnFirst = new RegExp(`\\b${ORI_COLUMN}\\s*(?:=|IN)\\s*\\(?\\s*((?:'[A-Za-z0-9]{4,12}'\\s*,?\\s*)+)\\)?`, "gi");
  for (const match of stripped.matchAll(columnFirst)) {
    const literals = (match[1].match(/'[^']*'/g) || []).map((value) => value.slice(1, -1).toUpperCase());
    if (literals.some((value) => value !== wanted)) return false;
  }
  const literalFirst = new RegExp(`'([A-Za-z0-9]{4,12})'\\s*=\\s*\\b${ORI_COLUMN}\\b`, "gi");
  for (const match of stripped.matchAll(literalFirst)) {
    if (match[1].toUpperCase() !== wanted) return false;
  }

  const equals = new RegExp(`\\b${ORI_COLUMN}\\s*=\\s*'${target}'`, "i");
  const reversed = new RegExp(`'${target}'\\s*=\\s*\\b${ORI_COLUMN}\\b`, "i");
  const singletonIn = new RegExp(`\\b${ORI_COLUMN}\\s+IN\\s*\\(\\s*'${target}'\\s*\\)`, "i");

  if (statementPinsOri(stripped, ori, equals, reversed, singletonIn)) return true;

  // The Historical house style pins the agency in a CTE and joins it, which is genuinely
  // restrictive and which `lib/claude.ts` teaches by example. Refusing it made the whole
  // county-selection path decline: query log 8595 is a correct query that this rule rejected.
  return cteTargetsOri(stripped, ori, equals, reversed, singletonIn);
}

/** Is the required ORI pinned by a filter belonging to this statement itself? */
function statementPinsOri(
  text: string, ori: string, equals: RegExp, reversed: RegExp, singletonIn: RegExp,
): boolean {
  for (const region of topLevelFilterRegions(text)) {
    // Any disjunction can widen what the equality restricted, and proving otherwise needs a
    // parser. Refuse instead.
    if (/\bor\b/i.test(region)) continue;
    // A single-value `IN` is an equality written differently. Normalise it before flattening
    // so its parentheses are not mistaken for a subquery.
    const normalised = region.replace(singletonIn, `ori = '${ori}'`);
    // Then drop everything nested. A `WHERE` inside a subquery restricts that subquery, not
    // the rows this statement returns: `WHERE hac.year IN (SELECT year FROM … WHERE ori = 'X')`
    // filters years, and every agency comes back.
    const flat = flattenParens(normalised);
    if (equals.test(flat) || reversed.test(flat)) return true;
  }
  return false;
}

/** One `name AS ( body )` entry from a leading `WITH` clause. */


/**
 * Is the required ORI pinned inside a CTE that the outer query actually joins on?
 *
 * Both halves are needed. A CTE restricted to one agency proves nothing if the query that
 * follows never uses it, or uses it decoratively -- selecting a label from it, or cross-joining
 * without ever tying its `ori` to the table the figures come from. What makes query log 8595
 * safe is the second join: `LEFT JOIN historical_agency_crime hac ON hac.ori = a.ori`, where
 * `a` is the pinned CTE. Every row of crime data is reached through that equality.
 */
function cteTargetsOri(
  sql: string, ori: string, equals: RegExp, reversed: RegExp, singletonIn: RegExp,
): boolean {
  const split = splitCtes(sql);
  if (!split) return false;
  for (const cte of split.ctes) {
    if (!statementPinsOri(cte.body, ori, equals, reversed, singletonIn)) continue;
    // The CTE must expose the ORI for the outer query to join on; one that pins internally and
    // returns only, say, a year range restricts nothing downstream.
    if (!new RegExp(`\\b${ORI_COLUMN}\\b`, "i").test(cte.body)) continue;
    for (const alias of cteReferences(split.outer, cte.name)) {
      const escaped = escapeRegExp(alias);
      const joined = new RegExp(
        `\\b${ORI_COLUMN}\\s*=\\s*${escaped}\\.ori\\b|\\b${escaped}\\.ori\\s*=\\s*${ORI_COLUMN}\\b`,
        "i",
      );
      if (joined.test(split.outer)) return true;
    }
  }
  return false;
}



function requiredOriBlockMessage(ori: string): string {
  return `This question was resolved to one specific county law enforcement agency (ORI ${ori}), `
    + `but the query did not target it. I did not run it, because a query matching more than one `
    + `agency would report the wrong department's figures.`;
}


function normalizeSqlLiteral(value: string, template: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return /^[A-Z0-9 .'-]+$/.test(template) ? compact.toUpperCase() : compact;
}

function normalizeAliasKeyLiteral(value: string): string {
  return value.replace(/\./g, "").replace(/\s+/g, " ").trim().toUpperCase();
}

function cityNameRegexSource(cityName: string): string {
  const canonical = cityName.replace(/\s+/g, " ").trim();
  const saintMatch = canonical.match(/^St\.?\s+(.+)$/i);
  if (saintMatch) {
    return `(?:St\\.?|Saint)\\s+${escapeRegExp(saintMatch[1]).replace(/\s+/g, "\\s+")}`;
  }
  return escapeRegExp(canonical).replace(/\s+/g, "\\s+");
}

function rewriteCityJurisdictionSuffix(sql: string, cityName: string): string {
  if (!cityName || /\bCity$/i.test(cityName)) return sql;

  const canonical = cityName.replace(/\s+/g, " ").trim();
  const canonicalRe = cityNameRegexSource(canonical);
  let rewritten = sql;

  rewritten = rewritten.replace(
    new RegExp(`(\\balias_key\\s+)LIKE\\s+'%${canonicalRe}(?:%|\\s+)CITY%'`, "gi"),
    (_match, prefix) => `${prefix}= '${normalizeAliasKeyLiteral(canonical)}'`
  );

  rewritten = rewritten.replace(
    new RegExp(`(\\balias_key\\s*=\\s*)'(${canonicalRe}\\s+City)'`, "gi"),
    (_match, prefix) => `${prefix}'${normalizeAliasKeyLiteral(canonical)}'`
  );

  rewritten = rewritten.replace(
    new RegExp(`(\\b(?:\\w+\\.)?(?:city|agency|agency_name|canonical_agency)\\s*=\\s*)'(${canonicalRe}\\s+City)'`, "gi"),
    (_match, prefix, literal) => `${prefix}'${normalizeSqlLiteral(canonical, literal)}'`
  );

  rewritten = rewritten.replace(
    new RegExp(`(\\b(?:\\w+\\.)?(?:city|agency|agency_name|canonical_agency)\\s+LIKE\\s+')%(${canonicalRe})%CITY%(')`, "gi"),
    (_match, prefix, literal, suffix) => `${prefix}%${normalizeSqlLiteral(canonical, literal)}%${suffix}`
  );

  return rewritten;
}

export function validateQueryContractSql(opts: {
  question: string;
  source: QueryContractSource;
  sql: string;
  routingMeta?: RoutingLogMeta | null;
  /**
   * An agency the route has already resolved, which the SQL must actually target.
   *
   * Set when a county turns out to be policed by two departments and the user has named
   * one. Telling the model which ORI to use is a hint; this is the check. Without it the
   * model stays free to emit a query matching both agencies, and the answer would be
   * attributed to whichever one the database happened to return.
   */
  requiredOri?: string | null;
  /**
   * The effective request, when the route has already built it by amendment
   * (lib/current-followup-amendment.ts). Every check below still runs, against this contract
   * instead of one rebuilt from `question` -- which, for an amendment, is the reader's fragment
   * ("now detroit") and says nothing about the measure they established earlier. A contract for a
   * different source is ignored rather than trusted.
   */
  contract?: QueryContract | null;
  /**
   * The conversation so far (user and assistant turns). Measure preservation reads the measure the user last
   * stated when this question states none (lib/measure-preservation.ts). Absent = no inheritance; the
   * question's own stated measure is still held.
   */
  history?: { role: string; content: string }[] | null;
}): QueryContractSqlValidation {
  const requiredOri = (opts.requiredOri || "").trim();
  const missingRequiredOri = Boolean(requiredOri) && !sqlTargetsOri(opts.sql, requiredOri);
  // Historical offense binding (Codex :35871): a sexual-assault request is answered with the UCR rape measure on EVERY
  // validation pass -- rebound in the simple supported form, otherwise retried and, if still wrong, stopped. Computed
  // before the contract so it also holds when no contract can be built.
  const offenseBinding = opts.source === "historical" ? bindSexualAssaultMeasure(opts.question, opts.sql) : { kind: "none" as const };
  const contract = opts.contract && opts.contract.source === opts.source
    ? opts.contract
    : buildQueryContract(opts.question, opts.source, opts.routingMeta);
  if (!contract) {
    return {
      sql: offenseBinding.kind === "rebound" ? offenseBinding.sql : opts.sql,
      fired: offenseBinding.kind === "rebound" ? ["contract-sexual-assault-rape-binding"] : [],
      warnings: offenseBinding.kind === "retry" ? ["contract-sexual-assault-rape-measure"] : [],
      capabilityFindings: [],
      retryIssues: offenseBinding.kind === "retry" ? [offenseBinding.issue] : [],
      blockReasons: missingRequiredOri ? [requiredOriBlockMessage(requiredOri)] : [],
      enforced: [...(missingRequiredOri ? ["contract-required-county-ori"] : []), ...(offenseBinding.kind === "retry" ? ["contract-sexual-assault-rape-measure"] : [])],
      // No contract was built, so no capability rule was classified. A missing-ORI block is a
      // different finding with its own message and is not a capability outcome.
      capabilityOutcome: null,
      // No contract was built, so there is no typed measure or geography to observe.
      clearanceGrainObservation: null,
    };
  }

  let sql = opts.sql;
  const fired: string[] = [];
  const warnings: string[] = [];
  const retryIssues: string[] = [];
  const blockReasons: string[] = [];
  /**
   * The typed catalog outcome a capability block finalizes with, taken from the shared classifier.
   *
   * Exposed rather than kept local so the linkage from "a question-only rule fired" to "the route
   * finalizes `decline_capability / query_contract_failed`" is testable at runtime instead of only
   * by reading four route files. The routes still pass `OUTCOMES.query_contract_failed` directly;
   * `scripts/test-p3-1a-route-finalization.ts` asserts the two are the same object.
   */
  let capabilityOutcome: CapabilityBlockOutcome = null;
  const enforced: string[] = [];

  if (offenseBinding.kind === "rebound") {
    sql = offenseBinding.sql;
    fired.push("contract-sexual-assault-rape-binding");
  } else if (offenseBinding.kind === "retry") {
    warnings.push("contract-sexual-assault-rape-measure");
    retryIssues.push(offenseBinding.issue);
    enforced.push("contract-sexual-assault-rape-measure");
  }

  const requestedState = contract.geography.state;
  const sourceState = requestedState ? contract.geography.sourceCodes?.[opts.source] : null;
  if (requestedState && sourceState) {
    const rewritten = rewriteStateEquals(sql, requestedState, sourceState);
    if (rewritten !== sql) {
      sql = rewritten;
      fired.push("contract-state-code-alias");
    }
  }

  if (contract.geography.kind === "city" && contract.geography.name) {
    const rewritten = rewriteCityJurisdictionSuffix(sql, contract.geography.name);
    if (rewritten !== sql) {
      sql = rewritten;
      fired.push("contract-city-jurisdiction-suffix");
    }
  }

  if (
    requestedState &&
    (contract.geography.kind === "city" || contract.geography.kind === "county" || contract.geography.kind === "campus" || contract.geography.kind === "agency") &&
    /\b(?:agency_monthly|historical_agency|historical_agency_crime|summary_\w+|incidents)\b/i.test(sql) &&
    !hasStateFilter(sql) &&
    !hasSpecificOriFilter(sql)
  ) {
    const sourceStateHint = Array.isArray(sourceState)
      ? `state IN (${sourceState.map((state) => `'${state}'`).join(",")})`
      : `state = '${sourceState ?? requestedState}'`;
    warnings.push("contract-geography-state-missing");
    retryIssues.push(`[SYSTEM: Query contract violation (contract-geography-state-missing). The user asked for ${contract.geography.canonicalName ?? contract.geography.name ?? "a local geography"}${contract.geography.state ? `, ${contract.geography.state}` : ""}, but the SQL filters a local city/agency/county without a state predicate. Add the source-appropriate state predicate (${sourceStateHint}) or use a unique ORI filter. Do not let same-named places in other states enter the result.]`);
    enforced.push("contract-geography-state-missing");
  }

  if (contract.geography.kind === "state" && hasLocalPlaceFilter(sql)) {
    warnings.push("contract-state-scope-local-filter");
    retryIssues.push("[SYSTEM: Query contract violation (contract-state-scope-local-filter). The user asked for a state-level result, but the SQL filters to a local city/agency/county value. Rewrite the SQL so the filter is statewide, using the state field or the appropriate state/national summary table. Do not filter to a single agency or city unless the user explicitly asked for that local place.]");
    enforced.push("contract-state-scope-local-filter");
  }

  const temporalIssue = singleYearTemporalScopeIssue(opts.question, contract, sql, opts.source);
  if (temporalIssue) {
    warnings.push("contract-single-year-temporal-scope");
    retryIssues.push(temporalIssue);
    enforced.push("contract-single-year-temporal-scope");
  }
  if (opts.source === "nibrs" && contract.metric.offenses.length > 1 && /\bucr_offense_code\b/i.test(sql)) {
    const requiredCodes = contract.metric.offenseCodes.filter((code) => /^[0-9A-Z]{3}$/.test(code));
    const missingCodes = requiredCodes.filter((code) => !new RegExp("\\b" + escapeRegExp(code) + "\\b", "i").test(sql));
    if (missingCodes.length > 0) {
      warnings.push("contract-offense-codes-missing");
      retryIssues.push(
        "[SYSTEM: Query contract violation (contract-offense-codes-missing). " +
        "The user requested multiple offenses, but the SQL omitted NIBRS offense code(s): " + missingCodes.join(", ") + ". " +
        "Include every requested offense code. If the request mixes person and non-person offenses, aggregate person crimes from victim summaries and non-person offenses from offense summaries, then combine the annual results without dropping a requested offense.]"
      );
      enforced.push("contract-offense-codes-missing");
    }
  }

  const trendAnnualizedIssue = trendAssessmentAnnualizedOutputIssue(opts.question, opts.source, sql);
  if (trendAnnualizedIssue) {
    warnings.push("contract-trend-followup-annualized-output");
    retryIssues.push(trendAnnualizedIssue);
    enforced.push("contract-trend-followup-annualized-output");
  }
  const trendFollowupIssue = trendAssessmentCompleteYearIssue(opts.question, opts.source, sql);
  if (trendFollowupIssue) {
    warnings.push("contract-trend-followup-complete-years");
    retryIssues.push(trendFollowupIssue);
    enforced.push("contract-trend-followup-complete-years");
  }
  // Structural semantics: does the chosen table's row level, measure and time grain actually match
  // what was requested? This runs alongside the capability rules rather than replacing them --
  // several of those rules already catch cases this would, and they carry source-specific wording
  // worth keeping. What this adds is the property none of them model: the entity a returned ROW
  // represents. Its severity is decided by the rule itself, not by a name in a set, so a new table
  // in the catalog is enforced the day it is added.
  // Integration 2026-09-30: a structural block's message is generic ("... comes from `table`, which
  // produces national-level rows"), so it is delivered only when no source-specific block fired. It is
  // collected here and appended after every other block reason below -- the capability messages, the
  // required-ORI message and the authored clearance-grain decline keep the order they have on dev, and
  // the structural finding is still recorded in `enforced` either way.
  const structuralBlockReasons: string[] = [];
  for (const finding of evaluateStructuralSemantics({
    question: opts.question,
    source: opts.source,
    contract,
    sql,
  })) {
    warnings.push(finding.ruleId);   // ruleIds already begin with `structural-`
    if (finding.severity === "block") {
      structuralBlockReasons.push(finding.message);
    } else {
      // A finding may carry its whole instruction. The row-level advice below is right for a
      // wrong-table finding and wrong for one about a single added filter on the correct table --
      // there it would ask the model for an unrelated source change.
      retryIssues.push(finding.selfContainedInstruction
        ? `[SYSTEM: Query contract violation (${finding.ruleId}). ${finding.message}]`
        : `[SYSTEM: Query contract violation (${finding.ruleId}). ${finding.message} ` +
          `Rewrite the SQL against a table whose rows are ${finding.requestedLevel}-level, or say plainly ` +
          "that this source cannot answer the question. Do not substitute a different geography or measure.]");
    }
    enforced.push(finding.ruleId);
  }

  const capabilityFindings = validateSourceCapabilities({
    question: opts.question,
    source: opts.source,
    contract,
    sql,
  });
  for (const finding of capabilityFindings) {
    warnings.push(`capability-${finding.ruleId}`);
    // ONE classification authority. Membership tests used to live here as a second `if/else if`
    // beside the observer's; sharing the two Sets made the membership common but left the
    // *consequence* decided in two places, so a change to branch order or to the typed outcome
    // could move the observer without moving production. The switch is exhaustive on purpose: a
    // new classification kind becomes a compile error here rather than silently falling through
    // to "neither blocks nor retries".
    const decision = classifyCapabilityRule(finding.ruleId);
    switch (decision.kind) {
      case "block":
        // The typed pair the route will finalize with, taken from the shared catalog rather than
        // re-decided here. The human-facing message is a separate mapping applied AFTER the
        // classification, never a substitute for it.
        capabilityOutcome = decision.outcome;
        blockReasons.push(BLOCK_MESSAGES[finding.ruleId] ?? finding.message);
        enforced.push(finding.ruleId);
        break;
      case "retry":
        retryIssues.push(capabilityRetryIssue(finding, contract));
        enforced.push(finding.ruleId);
        break;
      case "observe_only":
        // Recorded as a warning above and nowhere else: observed, not acted on.
        break;
      default: {
        const unreachable: never = decision;
        throw new Error(`unhandled capability classification: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /*
   * A Historical ranking must answer the request it was given.
   *
   * These run here rather than as capability rules because they compare the REQUEST with the SQL
   * rather than checking which tables it reads, which is what a capability rule is for. They are
   * retry issues, not blocks: the list size and the population filter are both things the model
   * can correct in a rewrite. See lib/historical-ranking-request.ts for why only these two.
   */
  if (opts.source === "historical") {
    for (const issue of findHistoricalRankingIssues({ question: opts.question, contract, sql })) {
      warnings.push(`capability-${issue.ruleId}`);
      retryIssues.push(issue.message);
      enforced.push(issue.ruleId);
    }
  }
  /*
   * The same question, asked of a NIBRS clearance ranking: did the request state a minimum count?
   * It ships with the clearance-refinement context repair because that repair is what lets
   * GC-004's saved statement reach this point at all, and that statement invents a cutoff of 100
   * offenses. See lib/nibrs-clearance-ranking-request.ts for why it is one question and not a
   * revived eligibility checker.
   */
  if (opts.source === "nibrs") {
    for (const issue of findNibrsClearanceRankingIssues({ question: opts.question, contract, sql })) {
      warnings.push(`capability-${issue.ruleId}`);
      retryIssues.push(issue.message);
      enforced.push(issue.ruleId);
    }
  }

  if (missingRequiredOri) {
    blockReasons.push(requiredOriBlockMessage(requiredOri));
    enforced.push("contract-required-county-ori");
  }

  // Computed here, at the same pre-execution point every other contract finding is decided.
  //
  // Observation is recorded in full. Only an `enforceable` finding -- today, a state-grain clearance
  // request whose state resolved with HIGH confidence -- becomes a block. A medium/low-confidence
  // state and every measure-absent finding are still returned for measurement and still act on
  // nothing, which is what keeps a decline from ever resting on a guess about what was meant.
  const clearanceGrainObservation = observeHistoricalClearanceGrain(contract);
  if (clearanceGrainObservation?.enforceable) {
    // The message is server-authored and carries no clearance number, so the offer of the national
    // and individual-agency alternatives cannot become an answer. Neither alternative is queried:
    // blocking here returns before any factual SQL runs.
    blockReasons.push(clearanceGrainObservation.message);
    enforced.push(clearanceGrainObservation.reason);
  }
  blockReasons.push(...structuralBlockReasons);
  // Measure preservation (Codex :34106): a statement that would deliver a different measure than the request asked
  // for -- on the question itself or inherited by a follow-up -- is blocked with the truthful limitation.
  const measureDrift = measureDriftIssue({ question: opts.question, history: opts.history ?? null, source: opts.source, sql });
  if (measureDrift) {
    blockReasons.push(measureDrift);
    enforced.push(MEASURE_DRIFT_GUARDRAIL);
  }

  const uniqueBlockReasons = [...new Set(blockReasons)];
  return {
    sql,
    fired,
    warnings: [...new Set(warnings)],
    capabilityFindings,
    retryIssues: uniqueBlockReasons.length > 0 ? [] : [...new Set(retryIssues)],
    blockReasons: uniqueBlockReasons,
    enforced: [...new Set(enforced)],
    capabilityOutcome,
    clearanceGrainObservation,
  };
}
