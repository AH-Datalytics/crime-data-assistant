import { buildQueryContract, type QueryContract, type QueryContractSource } from "./query-contract";
import { currentCalendarYear } from "./time-conventions";
import type { RoutingLogMeta } from "./routing-log-meta";
import { validateSourceCapabilities, type SourceCapabilityFinding } from "./source-capabilities";
import { evaluateStructuralSemantics } from "./structural-semantics";
import { DEMOGRAPHIC_RATE_UNSUPPORTED_MESSAGE, SUB_CITY_GEOGRAPHY_MESSAGE } from "./capability-overrides";

export interface QueryContractSqlValidation {
  sql: string;
  fired: string[];
  warnings: string[];
  capabilityFindings: SourceCapabilityFinding[];
  retryIssues: string[];
  blockReasons: string[];
  enforced: string[];
}

const CONTRACT_SECOND_FAILURE_MESSAGE =
  "I couldn't build a reliable query that matched the requested source, geography, metric, and time period. Try narrowing the question or choosing one of the suggested alternatives.";

const RETRY_CAPABILITY_RULES = new Set([
  "current-countywide-crosswalk",
  "current-rate-population",
  "nibrs-weapon-person-crime-table",
  "nibrs-weapon-demographic-person-crime-table",
  "nibrs-weapon-circumstance-person-crime-table",
  "nibrs-weapon-circumstance-demographic-person-crime-table",
  "nibrs-carjacking-clearance-table",
  "nibrs-clearance-type-table",
  "nibrs-dv-assault-share-table",
  "nibrs-campus-agency-resolution",
  "nibrs-countywide-crosswalk",
  "nibrs-continuous-reporters-range-table",
  "nibrs-demographic-breakdown-table",
  "nibrs-specific-drug-offense-table",
  "nibrs-specific-drug-arrest-table",
  "nibrs-local-geography-state-table",
  "nibrs-agency-lookup-not-crime-data",
  "historical-countywide-crosswalk",
  "historical-clearance-table",
  "historical-state-national-rate-table",
  "historical-local-rate-population",
  "historical-rate-null-gaps",
  "historical-local-geography-state-table",
  "historical-parish-type-city",
  "historical-agency-lookup-not-crime-data",
  "shr-campus-agency-resolution",
  "shr-countywide-crosswalk",
  "shr-state-rate-population",
]);

const BLOCK_CAPABILITY_RULES = new Set([
  "unsupported-sub-city-geography",
  "unsupported-court-policy-topic",
  "demographic-rate-unsupported",
  "nibrs-clearance-weapon-unsupported",
  "nibrs-countywide-demographics-unsupported",
  "nibrs-shooting-category-unsupported",
  "shr-non-homicide-unsupported",
  "shr-clearance-unsupported",
  "shr-demographic-rate-unsupported",
]);

const BLOCK_MESSAGES: Record<string, string> = {
  "unsupported-sub-city-geography":
    SUB_CITY_GEOGRAPHY_MESSAGE,
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
  if (hasOpenEndedOrRangeTimeIntent(question)) return false;
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

function singleYearTemporalScopeIssue(question: string, contract: QueryContract, sql: string): string | null {
  if (!isSingleYearPointContract(question, contract)) return null;
  const year = contract.time.startYear;
  if (year === null) return null;

  if (hasBroadYearPredicateForSingleYear(sql, year) || !hasRequestedSingleYearPredicate(sql, year)) {
    const partial = contract.time.partialYear
      ? ` For Current Trends partial-year ${year} queries, use year = ${year} plus the latest available month cutoff; do not include prior years in the numerator.`
      : "";
    return `[SYSTEM: Query contract violation (contract-single-year-temporal-scope). The user asked for ${year} only, but the SQL does not keep the metric/count numerator limited to that single year. Rewrite the SQL so fact-table year/data_year predicates use = ${year} or BETWEEN ${year} AND ${year}. Do not use year < ${year}, year <= ${year}, year >= an older year, or BETWEEN an older year AND ${year} unless the user explicitly asks for a trend, rolling window, or multi-year comparison.${partial}]`;
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

/** Comments cannot restrict anything, so they are not evidence of anything either. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * The stretches of a statement that actually filter rows: each `WHERE` and each join `ON`,
 * taken at the top level only.
 *
 * Top level matters. A `WHERE` inside a subquery restricts that subquery, not the rows the
 * statement returns, and a comparison in `SELECT`, `CASE`, `GROUP BY` or `ORDER BY` restricts
 * nothing at all -- `SELECT ha.ori = 'MD0030100' AS is_selected` is a boolean column, and it
 * was passing as though it were a filter.
 */
function topLevelFilterRegions(sql: string): string[] {
  const terminator = /^(?:group\s+by|order\s+by|having|limit|window|union|intersect|except|join|inner|left|right|full|cross|on|where)\b/i;
  const regions: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'") {
      const end = sql.indexOf("'", i + 1);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === "(") { depth += 1; i += 1; continue; }
    if (char === ")") { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (depth === 0) {
      const rest = sql.slice(i);
      const opener = /^(where|on)\b/i.exec(rest);
      if (opener) {
        let j = i + opener[0].length;
        let innerDepth = 0;
        const start = j;
        while (j < sql.length) {
          const c = sql[j];
          if (c === "'") {
            const end = sql.indexOf("'", j + 1);
            j = end === -1 ? sql.length : end + 1;
            continue;
          }
          if (c === "(") { innerDepth += 1; j += 1; continue; }
          if (c === ")") {
            if (innerDepth === 0) break;
            innerDepth -= 1; j += 1; continue;
          }
          if (innerDepth === 0 && terminator.test(sql.slice(j))) break;
          j += 1;
        }
        regions.push(sql.slice(start, j));
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return regions;
}

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
type CommonTableExpression = { name: string; body: string };

/**
 * The CTEs a statement defines, and the query that follows them.
 *
 * Returns nothing when the statement does not open with `WITH`, so ordinary queries take the
 * direct path and pay nothing for this.
 */
function splitCtes(sql: string): { ctes: CommonTableExpression[]; outer: string } | null {
  const head = /^\s*WITH\s+(RECURSIVE\s+)?/i.exec(sql);
  if (!head) return null;
  const ctes: CommonTableExpression[] = [];
  let i = head[0].length;
  while (i < sql.length) {
    const entry = /^\s*("?)([A-Za-z_]\w*)\1\s+AS\s*(?:MATERIALIZED\s+|NOT\s+MATERIALIZED\s+)?\(/i.exec(sql.slice(i));
    if (!entry) break;
    let depth = 1;
    let j = i + entry[0].length;
    const bodyStart = j;
    while (j < sql.length && depth > 0) {
      const char = sql[j];
      if (char === "'") {
        const end = sql.indexOf("'", j + 1);
        j = end === -1 ? sql.length : end + 1;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      j += 1;
    }
    ctes.push({ name: entry[2], body: sql.slice(bodyStart, j - 1) });
    i = j;
    const comma = /^\s*,/.exec(sql.slice(i));
    if (!comma) break;
    i += comma[0].length;
  }
  return ctes.length > 0 ? { ctes, outer: sql.slice(i) } : null;
}

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

/** Every name the outer query refers to this CTE by -- its own name, and any alias. */
function cteReferences(outer: string, name: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(`\\b(?:FROM|JOIN)\\s+${escapeRegExp(name)}\\b(?:\\s+AS)?(?:\\s+([A-Za-z_]\\w*))?`, "gi");
  const RESERVED = /^(on|where|group|order|limit|left|right|inner|full|cross|join|union|having|window|using)$/i;
  for (const match of outer.matchAll(pattern)) {
    found.add(name);
    if (match[1] && !RESERVED.test(match[1])) found.add(match[1]);
  }
  return [...found];
}

/** The text outside every parenthesised group, which is where a top-level filter lives. */
function flattenParens(text: string): string {
  let depth = 0;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      const literal = text.slice(i, end === -1 ? text.length : end + 1);
      if (depth === 0) out += literal;
      i = (end === -1 ? text.length : end);
      continue;
    }
    if (char === "(") { depth += 1; out += " "; continue; }
    if (char === ")") { depth = Math.max(0, depth - 1); out += " "; continue; }
    if (depth === 0) out += char;
  }
  return out;
}

function requiredOriBlockMessage(ori: string): string {
  return `This question was resolved to one specific county law enforcement agency (ORI ${ori}), `
    + `but the query did not target it. I did not run it, because a query matching more than one `
    + `agency would report the wrong department's figures.`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
}): QueryContractSqlValidation {
  const requiredOri = (opts.requiredOri || "").trim();
  const missingRequiredOri = Boolean(requiredOri) && !sqlTargetsOri(opts.sql, requiredOri);
  const contract = buildQueryContract(opts.question, opts.source, opts.routingMeta);
  if (!contract) {
    return {
      sql: opts.sql,
      fired: [],
      warnings: [],
      capabilityFindings: [],
      retryIssues: [],
      blockReasons: missingRequiredOri ? [requiredOriBlockMessage(requiredOri)] : [],
      enforced: missingRequiredOri ? ["contract-required-county-ori"] : [],
    };
  }

  let sql = opts.sql;
  const fired: string[] = [];
  const warnings: string[] = [];
  const retryIssues: string[] = [];
  const blockReasons: string[] = [];
  const enforced: string[] = [];

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

  const temporalIssue = singleYearTemporalScopeIssue(opts.question, contract, sql);
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
  for (const finding of evaluateStructuralSemantics({
    question: opts.question,
    source: opts.source,
    contract,
    sql,
  })) {
    warnings.push(finding.ruleId);   // ruleIds already begin with `structural-`
    if (finding.severity === "block") {
      blockReasons.push(finding.message);
    } else {
      retryIssues.push(
        `[SYSTEM: Query contract violation (${finding.ruleId}). ${finding.message} ` +
        `Rewrite the SQL against a table whose rows are ${finding.requestedLevel}-level, or say plainly ` +
        "that this source cannot answer the question. Do not substitute a different geography or measure.]"
      );
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
    if (BLOCK_CAPABILITY_RULES.has(finding.ruleId)) {
      blockReasons.push(BLOCK_MESSAGES[finding.ruleId] ?? finding.message);
      enforced.push(finding.ruleId);
    } else if (RETRY_CAPABILITY_RULES.has(finding.ruleId)) {
      retryIssues.push(capabilityRetryIssue(finding, contract));
      enforced.push(finding.ruleId);
    }
  }

  if (missingRequiredOri) {
    blockReasons.push(requiredOriBlockMessage(requiredOri));
    enforced.push("contract-required-county-ori");
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
  };
}
