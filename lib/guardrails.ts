/**
 * Shared guardrail pipeline.
 *
 * Each guardrail is a { name, tabs, match, message } object.
 * `match` receives the QueryContext and returns true if the guardrail fires.
 * `message` returns the fix instruction sent to Claude for retry.
 *
 * Some guardrails can auto-fix the SQL without a Claude retry (rewrite).
 * Those set `rewrite` instead of (or in addition to) `message`.
 */

import type { QueryContext, Tab } from "./query-context";
import {
  formatNibrsCodeList,
  NIBRS_UCR_PROPERTY_CODES,
  NIBRS_UCR_PROPERTY_LABEL,
  NIBRS_UCR_VIOLENT_CODES,
  NIBRS_UCR_VIOLENT_LABEL,
} from "./nibrs-codes";
import {
  asksToIncludeCurrentYear,
  currentCalendarYear,
  relativeYearRangeForQuestion,
} from "./time-conventions";
import { explicitStateSubstateMismatch } from "./explicit-state-intent";
import { stateNameToAbbr } from "./state-population";

const STATE_NAMES_RE = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|district of columbia|united states)\b/i;

const NOISE_WORDS_RE = /\b(murder|homicide|crime|crimes|rate|rates|trend|trends|data|show|what|how|many|the|in|of|for|is|are|me|since|from|over|time|last|years?|months?|per\s+capita|give|can|you|please|compare|between|and|vs|versus|by|with|to|at|on|has|have|had|been|were|was|do|does|did|tell|about|all|total|count|number|violent|property|offense|offenses?)\b/gi;

/** Extract the likely city/place name from a question when ctx.geos is empty.
 *  Strips state names, common crime/query terms, and returns the leftover. */
function extractPlaceFromQuestion(ctx: QueryContext): string {
  const sqlGeos = ctx.geos.filter(g => !STATE_NAMES_RE.test(g));
  if (sqlGeos.length > 0) return sqlGeos[0];
  const cleaned = ctx.question
    .replace(STATE_NAMES_RE, " ")
    .replace(NOISE_WORDS_RE, " ")
    .replace(/[,?.!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "the requested city";
}

function stripSqlStrings(sql: string): string {
  return sql.replace(/'([^']|'')*'/g, "''");
}

function countyKey(value: string): string {
  return value
    .replace(/\b(county|parish|borough)\b/ig, " ")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function countyScopeFromQuestion(question: string): { name: string; suffix: string; key: string } | null {
  const matches = [...question.matchAll(/\b([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,4})\s+(County|Parish|Borough)\b/gi)];
  for (const match of matches) {
    let tokens = match[1]
      .replace(/^\b(the|a|an)\b\s+/i, "")
      .split(/\s+/);
    const prepIndex = tokens.reduce((last, token, index) =>
      /^(in|for|from|within|inside|across|covering)$/i.test(token) ? index : last, -1);
    if (prepIndex >= 0) tokens = tokens.slice(prepIndex + 1);
    tokens = tokens.filter((token) => !/^(crime|crimes|violent|property|trend|trends|rate|rates|data|show|me|the|a|an)$/i.test(token));
    const name = tokens.join(" ").trim();
    const key = countyKey(name);
    if (key) return { name, suffix: match[2], key };
  }
  return null;
}

function stateAbbrFromQuestion(question: string): string | null {
  const explicitAbbr = question.match(/\b(?:in|for|within|inside|across|from|,\s*)\s*([A-Z]{2})\b/);
  if (explicitAbbr) return explicitAbbr[1].toUpperCase();

  const names = question.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) || [];
  for (const name of names) {
    const abbr = stateNameToAbbr(name);
    if (abbr && abbr !== "US") return abbr;
  }
  return null;
}

function isExplicitCountyAgencyQuestion(question: string): boolean {
  return /\b(?:sheriff|sheriff's|sheriffs|police department|police dept|pd|county police|county sheriff|county agency|county agencies|sheriff's office|sheriff office)\b/i.test(question);
}

function isCountywideGeographyQuestion(question: string): boolean {
  if (!countyScopeFromQuestion(question)) return false;
  if (isExplicitCountyAgencyQuestion(question)) return false;
  return true;
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

function asksDomesticViolence(question: string): boolean {
  return /\bdomestic\s+violence\b|\b(?<![a-z])dv(?![a-z])\b/i.test(question);
}

function asksCampusAgency(question: string): boolean {
  return /\b(?:universit(?:y|ies)|univefrsit(?:y|ies)|college|campus)\b/i.test(question);
}

function asksPerCapitaRate(question: string): boolean {
  return /\b(?:rates?|per\s*capita|per\s*100k|per\s*100,000|per\s+hundred\s+thousand)\b/i.test(question);
}

function asksDomesticViolenceRate(question: string): boolean {
  return asksDomesticViolence(question) && asksPerCapitaRate(question);
}

function literalListCount(value: string): number {
  return (value.match(/'([^']|'')*'/g) || []).length;
}

function hasUnpairedMultiCityStateFilter(sql: string): boolean {
  const compact = sql.replace(/\s+/g, " ");
  if (/\(\s*(?:\w+\.)?city\s*,\s*(?:\w+\.)?state\s*\)\s+IN\b/i.test(compact)) return false;

  const cityIn = compact.match(/\b(?:\w+\.)?city\s+IN\s*\(([^)]+)\)/i);
  if (!cityIn || literalListCount(cityIn[1]) < 2) return false;

  const stateIn = compact.match(/\b(?:\w+\.)?state\s+IN\s*\(([^)]+)\)/i);
  if (stateIn && literalListCount(stateIn[1]) > 1) return true;

  const hasSingleState = /\b(?:\w+\.)?state\s*=\s*'[^']+'/i.test(compact);
  return !hasSingleState;
}

function domesticViolenceRateMessage(): string {
  return "[SYSTEM: The user asked for domestic violence rates. Do not join summary_domestic_violence to another summary_* table to infer population; that triggers cross-summary grain errors. Use summary_domestic_violence for the numerator and agencies plus nibrs_agency_completeness for the denominator. The denominator must be the population served by reporting agencies, adjusted by months reported; it is not the full official state population. For state comparisons in 2025, use this pattern: WITH dv AS (SELECT state, COUNT(DISTINCT ori || ':' || data_year || ':' || incident_num) AS dv_incidents FROM summary_domestic_violence WHERE data_year = 2025 GROUP BY state), population AS (SELECT a.state, SUM(a.population * nac.months_reported / 12.0) AS reporting_population FROM nibrs_agency_completeness nac JOIN agencies a ON a.ori = nac.ori AND a.year = nac.year WHERE nac.year = 2025 AND nac.months_reported > 0 AND a.population > 0 GROUP BY a.state) SELECT dv.state, dv.dv_incidents, population.reporting_population, ROUND(dv.dv_incidents * 100000.0 / NULLIF(population.reporting_population, 0), 1) AS rate_per_100k FROM dv JOIN population ON population.state = dv.state WHERE population.reporting_population > 0 ORDER BY rate_per_100k DESC LIMIT 1000. Explain that the denominator is population served by agencies that reported in NIBRS, adjusted for partial-year reporting, not a complete official state population.]";
}

function hasDirectSummaryTableJoin(sql: string): boolean {
  return /\bFROM\s+summary_\w+\b(?:\s+\w+)?[\s\S]{0,800}?\bJOIN\s+summary_\w+\b/i.test(sql);
}

function usesOffenderSummaryComboCount(sql: string): boolean {
  if (!/\bsummary_offender_demographics\b/i.test(sql)) return false;
  const distinctCounts = [...sql.matchAll(/\bCOUNT\s*\(\s*DISTINCT\s+([\s\S]*?)\)/gi)];
  return distinctCounts.some((match) => {
    const expr = stripSqlStrings(match[1]);
    return /\bucr_offense_code\b/i.test(expr) && /\b(?:ori|year)\b/i.test(expr);
  });
}

function normalizeEntityForSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function requestedEntityForVsOther(ctx: QueryContext): string | null {
  const q = ctx.question;
  if (!/\b(?:vs\.?|versus|compare|compared)\b/i.test(q)) return null;
  if (!/\bother\b|\blarge\b|\bsimilar\b|\bbig\b/i.test(q)) return null;
  const candidate = ctx.geos.find((geo) => !STATE_NAMES_RE.test(geo));
  if (candidate) return candidate;
  const lead = q.match(/^\s*([A-Za-z][A-Za-z .'-]+?)\s+(?:homicide|homicides|murder|murders|crime|robbery|assault|burglary|theft|rate|rates)\b/i);
  return lead ? lead[1].trim() : null;
}

function sqlMentionsEntity(sql: string, entity: string): boolean {
  const normSql = normalizeEntityForSearch(sql);
  const normEntity = normalizeEntityForSearch(entity);
  return normEntity.length > 0 && normSql.includes(normEntity);
}

function expectedConsistentReporterEndYear(question: string): number {
  const requestedEnd = requestedEndYear(question);
  const current = currentCalendarYear();
  if (requestedEnd !== null && requestedEnd < current) return requestedEnd;
  return current - 1;
}

function hasBroadConsistentReporterStartOnly(sql: string, startYear: number): boolean {
  const stripped = stripSqlStrings(sql);
  const startOnly = new RegExp(`\\bstart_year\\s*<=\\s*${startYear}\\b[\\s\\S]{0,80}\\bend_year\\s*>=\\s*${startYear}\\b`, "i");
  return startOnly.test(stripped);
}

function hasBroadConsistentReporterContainingRange(sql: string, startYear: number, endYear: number): boolean {
  const stripped = stripSqlStrings(sql);
  const startRef = String.raw`\bstart_year\s*<=?\s*${startYear}\b`;
  const endRef = String.raw`\bend_year\s*>=?\s*${endYear}\b`;
  return new RegExp(`${startRef}[\\s\\S]{0,120}${endRef}`, "i").test(stripped) ||
    new RegExp(`${endRef}[\\s\\S]{0,120}${startRef}`, "i").test(stripped);
}

function hasImpossibleCurrentYearConsistentReporterEnd(sql: string): boolean {
  const current = currentCalendarYear();
  return new RegExp(`\\bend_year\\s*=\\s*${current}\\b`, "i").test(stripSqlStrings(sql));
}

function asksWeaponInjuryBreakdown(question: string): boolean {
  return /\binjur(?:y|ies|ed)\b/i.test(question) &&
    /\b(?:weapon|weapons|firearm|firearms|gun|guns|knife|knives|stabb(?:ing|ings)?)\b/i.test(question);
}

function usesBroadRawWeaponInjuryAggregate(sql: string): boolean {
  if (!/\bFROM\s+victims\b|\bJOIN\s+victims\b/i.test(sql)) return false;
  if (!/\binjury_type\b/i.test(sql)) return false;
  if (!/\bweapon_type\b|\btype_weapon_[123]\b|\boffense_weapons\b|\bsummary_(?:victim|offense)_weapon\b/i.test(sql)) return false;
  if (!/\bCOUNT\s*\(|\bSUM\s*\(|\bGROUP\s+BY\b/i.test(sql)) return false;

  const hasTightOri = /\b(?:\w+\.)?ori\s*=\s*'[^']+'/i.test(sql) || /\b(?:\w+\.)?ori\s+IN\s*\([^)]{1,300}\)/i.test(sql);
  const hasTightDate = /\bincident_date\s+(?:BETWEEN|>=|>|=)\b/i.test(sql);
  return !(hasTightOri && hasTightDate);
}

function asksBareAssault(question: string): boolean {
  return /\bassaults?\b/i.test(question) &&
    !/\b(?:aggravated|simple|intimidation|sexual|domestic|dv|assaults?\s+with|firearm|gun|knife|weapon|robbery)\b/i.test(question);
}

function usesPartialAssaultCodeSet(sql: string): boolean {
  const codes = sqlQuotedCodes(sql);
  const assaultCodes = ["13A", "13B", "13C"].filter((code) => codes.has(code));
  if (assaultCodes.length === 0 || assaultCodes.length === 3) return false;
  return /\bucr_(?:offense|arrest)_code\b|\boffense_code\b/i.test(sql);
}

function asksOfficersPer100k(question: string): boolean {
  return /\bofficers?\b/i.test(question) && /\bper\s*(?:100\s*k|100,?000)\b/i.test(question);
}

function asksViolentCrimePer100k(question: string): boolean {
  return /\bviolent\s+crime\s+rate\b/i.test(question) && /\bper\s*(?:100\s*k|100,?000)\b/i.test(question);
}

function countywideCrosswalkMismatch(ctx: QueryContext): boolean {
  if (!isCountywideGeographyQuestion(ctx.question)) return false;
  const sql = ctx.sql;
  const usesCrosswalk = /\bagency_county_crosswalk\b/i.test(sql);
  const narrowsToCountyAgency = /\b(?:\w+\.)?(?:type|agency_type)\s*=\s*'county'/i.test(sql);
  return !usesCrosswalk || narrowsToCountyAgency;
}

function countywideCrosswalkMessage(ctx: QueryContext): string {
  const county = countyScopeFromQuestion(ctx.question);
  const state = stateAbbrFromQuestion(ctx.question) || ctx.states[0] || "XX";
  const countyKeyText = county?.key || "COUNTY_NAME";
  const countyLabel = county ? `${county.name} ${county.suffix}` : "the requested county";
  const joinHint = ctx.tab === "shr"
    ? "For SHR incidents, join on i.ori = ac.ori OR substr(i.ori, 1, 7) = ac.ori."
    : "For 9-character ORI tables, join on table.ori = ac.ori9 OR substr(table.ori, 1, 7) = ac.ori.";
  return `[SYSTEM: The user asked for countywide geography for ${countyLabel}, not a single county/sheriff agency. Use agency_county_crosswalk to include all mapped agencies in that county. Filter with ac.county_key = '${countyKeyText}'${state !== "XX" ? ` and ac.state = '${state}'` : " and ask for/require state if the county name is ambiguous"}. ${joinHint} Do not filter agency LIKE '%${county?.name || "County"}%' or type/agency_type = 'County' unless the user explicitly asks for a sheriff, county police department, or county agency.]`;
}

function hasCampusNameLookup(sql: string): boolean {
  return /\b(?:upper\s*\(\s*(?:\w+\.)?city\s*\)|(?:\w+\.)?city)\s+LIKE\s+'%[^']*(?:UNIV|UNIVERSITY|UN OF|UN CA|COLLEGE|CAMPUS)[^']*%'/i.test(sql);
}

function hasLiteralOriFilter(sql: string): boolean {
  return /\b(?:\w+\.)?ori\s*=\s*'[A-Z0-9]{7,9}'/i.test(sql) ||
    /\b(?:\w+\.)?ori\s+IN\s*\((?!\s*SELECT)[^)]*'[A-Z0-9]{7,9}'/i.test(sql);
}

function hasCampusAgencySqlMismatch(ctx: QueryContext): boolean {
  if (!asksCampusAgency(ctx.question)) return false;
  const sql = ctx.sql;
  if (!sql) return false;
  if (hasLiteralOriFilter(sql) || hasCampusNameLookup(sql)) return false;

  if (ctx.tab === "nibrs") {
    if (!/\bagencies\b/i.test(sql)) return false;
    const hasCityOnlyLookup = /\b(?:\w+\.)?city\s*(?:=|LIKE)\s*'[^']+'/i.test(sql);
    const filtersPopulation = /\b(?:\w+\.)?population\s*>\s*0\b/i.test(sql);
    const filtersCityType = /\b(?:\w+\.)?agency_type\s*=\s*'City'/i.test(sql) || /\bpop_group\s+LIKE\s+'1%'/i.test(sql);
    const usesNonNameIndicator = /\bagency_indicator\s+LIKE\s+'%University%'/i.test(sql);
    return hasCityOnlyLookup || filtersPopulation || filtersCityType || usesNonNameIndicator;
  }

  if (ctx.tab === "shr") {
    if (/\bshr_agency_alias\b/i.test(sql)) return false;
    return /\b(?:\w+\.)?agency\s*(?:=|LIKE)\s*'[^']+'/i.test(sql) ||
      /\b(?:\w+\.)?agency_type\s*=\s*'City'/i.test(sql);
  }

  return false;
}

function campusAgencyMessage(ctx: QueryContext): string {
  if (ctx.tab === "shr") {
    return "[SYSTEM: The user asked for a university/college/campus agency. Do not answer with the surrounding city agency. Resolve the campus agency through shr_agency_alias by searching alias/canonical_agency for university/college/campus terms plus the place name, then filter incidents by the resolved ORI. Do not require agency_type = 'City' or population > 0 for campus agencies; many campus agencies are agency_type Other/blank or have zero population. If no campus ORI has incidents, say that the campus agency has no SHR homicide records in this database; do not substitute citywide data.]";
  }
  return "[SYSTEM: The user asked for a university/college/campus agency, not the surrounding city police department. Do not answer with a bare city filter, population > 0, agency_type = 'City', pop_group LIKE '1%', or agency_indicator LIKE '%University%' — those can select the city PD and exclude campus ORIs. First resolve campus ORIs from agencies across all years by searching agency city/name strings for campus terms plus the place, e.g. SELECT DISTINCT ori FROM agencies WHERE state = 'CA' AND (upper(city) LIKE '%UN%BERKELEY%' OR upper(city) LIKE '%UNIV%BERKELEY%' OR upper(city) LIKE '%UNIVERSITY%BERKELEY%' OR upper(city) LIKE '%COLLEGE%BERKELEY%' OR upper(city) LIKE '%CAMPUS%BERKELEY%'). Then filter ORI-level summary tables with fact.ori IN (resolved ORIs) for all available years. Campus agencies often have population = 0; do not require population > 0. For University of California Berkeley, the campus ORI is CA0019700. If the resolved campus ORI returns no rows, say the campus agency has no NIBRS incident data in this database; do not substitute Berkeley city data.]";
}

function findTopLevelKeyword(sql: string, keyword: string, start = 0): number {
  const lower = stripSqlStrings(sql).toLowerCase();
  const target = keyword.toLowerCase();
  let depth = 0;
  for (let i = start; i < lower.length; i++) {
    const ch = lower[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      lower.startsWith(target, i) &&
      (i === 0 || !/[a-z0-9_]/i.test(lower[i - 1])) &&
      (i + target.length >= lower.length || !/[a-z0-9_]/i.test(lower[i + target.length]))
    ) {
      return i;
    }
  }
  return -1;
}

function outerWhereClause(sql: string): string | null {
  const whereIdx = findTopLevelKeyword(sql, "where");
  if (whereIdx < 0) return null;
  const start = whereIdx + "where".length;
  const stops = ["group by", "having", "order by", "limit", "union"]
    .map((kw) => findTopLevelKeyword(sql, kw, start))
    .filter((idx) => idx >= 0);
  const end = stops.length > 0 ? Math.min(...stops) : sql.length;
  const where = sql.slice(start, end).trim();
  return where || null;
}

function outerSelectClause(sql: string): string | null {
  const selectIdx = findTopLevelKeyword(sql, "select");
  if (selectIdx < 0) return null;
  const fromIdx = findTopLevelKeyword(sql, "from", selectIdx + "select".length);
  if (fromIdx < 0) return null;
  const select = sql.slice(selectIdx + "select".length, fromIdx).trim();
  return select || null;
}

function hasHistoricalStatePivotWithoutYearGroup(sql: string): boolean {
  const stripped = stripSqlStrings(sql);
  if (!/\bhistorical_state_national\b/i.test(stripped)) return false;
  if (findTopLevelKeyword(sql, "group by") >= 0) return false;

  const select = outerSelectClause(sql);
  if (!select || !/\byear\b/i.test(select)) return false;

  const stateCaseCount = (stripped.match(/\bCASE\s+WHEN\s+(?:\w+\.)?state\s*=/gi) ?? []).length;
  if (stateCaseCount < 2) return false;

  return /\bstate\s+IN\s*\(/i.test(stripped) || /\bvs\.?|\bversus\b|\bcompare|\bcomparison/i.test(stripped);
}

function hasTopLevelBoolean(whereClause: string, op: "and" | "or"): boolean {
  const sql = stripSqlStrings(whereClause).toLowerCase();
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      sql.startsWith(op, i) &&
      (i === 0 || !/[a-z0-9_]/i.test(sql[i - 1])) &&
      (i + op.length >= sql.length || !/[a-z0-9_]/i.test(sql[i + op.length]))
    ) {
      return true;
    }
  }
  return false;
}

function hasUnparenthesizedOrAnd(sql: string): boolean {
  const where = outerWhereClause(sql);
  return !!where && hasTopLevelBoolean(where, "or") && hasTopLevelBoolean(where, "and");
}

function requestedStartYear(question: string): number | null {
  const patterns = [
    /\b(?:from|since|starting(?:\s+in)?|beginning(?:\s+in)?|after)\s+((?:19|20)\d{2})\b/i,
    /\bbetween\s+((?:19|20)\d{2})\s+(?:and|to|through|-)\s+(?:19|20)\d{2}\b/i,
    /\b((?:19|20)\d{2})\s*(?:-|to|through)\s*(?:present|now|today|date|(?:19|20)\d{2})\b/i,
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function requestedEndYear(question: string): number | null {
  const patterns = [
    /\bbetween\s+(?:19|20)\d{2}\s+(?:and|to|through|-)\s+((?:19|20)\d{2})\b/i,
    /\b(?:from\s+)?(?:19|20)\d{2}\s*(?:-|to|through)\s*((?:19|20)\d{2})\b/i,
    /\b(?:through|thru|until|to)\s+((?:19|20)\d{2})\b/i,
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function sqlHasRequestedLowerYearBound(sql: string, startYear: number): boolean {
  const stripped = stripSqlStrings(sql);
  const yearRef = String.raw`(?:\b\w+\.)?\byear\b`;
  const eqRe = new RegExp(`${yearRef}\\s*=\\s*${startYear}\\b`, "i");
  const geRe = new RegExp(`${yearRef}\\s*>=\\s*${startYear}\\b`, "i");
  const gtRe = new RegExp(`${yearRef}\\s*>\\s*${startYear - 1}\\b`, "i");
  const betweenRe = new RegExp(`${yearRef}\\s+BETWEEN\\s+${startYear}\\s+AND\\s+(?:19|20)\\d{2}\\b`, "i");
  const inRe = new RegExp(`${yearRef}\\s+IN\\s*\\([^)]*\\b${startYear}\\b[^)]*\\)`, "i");
  return eqRe.test(stripped) || geRe.test(stripped) || gtRe.test(stripped) || betweenRe.test(stripped) || inRe.test(stripped);
}

function sqlHasYearUpperBound(sql: string, endYear: number): boolean {
  const stripped = stripSqlStrings(sql);
  const yearRef = String.raw`(?:\b\w+\.)?\byear\b`;
  const leRe = new RegExp(`${yearRef}\\s*<=\\s*${endYear}\\b`, "i");
  const ltRe = new RegExp(`${yearRef}\\s*<\\s*${endYear + 1}\\b`, "i");
  const eqRe = new RegExp(`${yearRef}\\s*=\\s*${endYear}\\b`, "i");
  const betweenRe = new RegExp(`${yearRef}\\s+BETWEEN\\s+(?:19|20)\\d{2}\\s+AND\\s+${endYear}\\b`, "i");
  return leRe.test(stripped) || ltRe.test(stripped) || eqRe.test(stripped) || betweenRe.test(stripped);
}

function sqlIncludesCurrentCalendarYear(sql: string): boolean {
  const current = currentCalendarYear();
  const stripped = stripSqlStrings(sql);
  const yearRef = String.raw`(?:\b\w+\.)?\byear\b`;
  const eqRe = new RegExp(`${yearRef}\\s*=\\s*${current}\\b`, "i");
  const leCurrentRe = new RegExp(`${yearRef}\\s*<=\\s*${current}\\b`, "i");
  const geCurrentRe = new RegExp(`${yearRef}\\s*>=\\s*${current}\\b`, "i");
  const betweenRe = new RegExp(`${yearRef}\\s+BETWEEN\\s+(?:19|20)\\d{2}\\s+AND\\s+${current}\\b`, "i");
  return eqRe.test(stripped) || leCurrentRe.test(stripped) || geCurrentRe.test(stripped) || betweenRe.test(stripped);
}

function violatesPastYearsConvention(ctx: QueryContext): boolean {
  if (asksToIncludeCurrentYear(ctx.question)) return false;
  const range = relativeYearRangeForQuestion(ctx.question);
  if (!range) return false;
  return !sqlHasRequestedLowerYearBound(ctx.sql, range.start) ||
    !sqlHasYearUpperBound(ctx.sql, range.end) ||
    sqlIncludesCurrentCalendarYear(ctx.sql);
}

function asksForTheftSubtype(question: string): boolean {
  return /\b(?:larceny from auto|theft from (?:motor )?vehicle|vehicle burglary|shoplifting|pickpocket(?:ing)?|pocket-picking|purse snatching|theft from building|theft of motor vehicle parts|auto parts)\b/i.test(question);
}

function usesParentTheftSql(sql: string): boolean {
  return /\boffense\s*(?:=|IN)\s*(?:\([^)]*)?'Theft'\b/i.test(sql) || /\b(?:hac|hsn)?\.?theft\b/i.test(sql);
}

function sqlQuotedCodes(sql: string): Set<string> {
  const codes = new Set<string>();
  const re = /'([0-9A-Z]{3})'/gi;
  let match;
  while ((match = re.exec(sql)) !== null) {
    codes.add(match[1].toUpperCase());
  }
  return codes;
}

function asksBareViolentCrime(question: string): boolean {
  return /\bviolent crime\b/i.test(question) &&
    !/\b(crimes against persons|nibrs definition|nibrs taxonomy|simple assault|intimidation|kidnapping|human trafficking|all person crimes|persons crimes)\b/i.test(question);
}

function asksBarePropertyCrime(question: string): boolean {
  return /\bproperty crime\b/i.test(question) &&
    !/\b(crimes against property|nibrs definition|nibrs taxonomy|fraud|vandalism|bribery|embezzlement|stolen property)\b/i.test(question);
}

function asksUnsupportedOfficerInvolved(question: string): boolean {
  const asksOfficerInvolved =
    /\b(?:police|officer|officers|law enforcement|leo|cops?)\s*[- ]?involved\b/i.test(question) ||
    /\binvolving\s+(?:police|officers|law enforcement|leo|cops?)\b/i.test(question);
  if (!asksOfficerInvolved) return false;

  return !/\b(?:justifiable homicide|justifiable homicides|09C|criminals? killed by police|killed by police)\b/i.test(question);
}

function missingAny(codes: Set<string>, expected: readonly string[]): boolean {
  return expected.some((code) => !codes.has(code));
}

function hasAny(codes: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((code) => codes.has(code));
}

export interface Guardrail {
  name: string;
  /** Which tabs this guardrail applies to */
  tabs: Tab[];
  /** Return true if this guardrail should fire */
  match: (ctx: QueryContext) => boolean;
  /** Fix instruction for Claude retry (null = no retry needed, use rewrite instead) */
  message?: (ctx: QueryContext) => string;
  /** Direct SQL rewrite (applied before Claude retry). Return null for no change. */
  rewrite?: (sql: string, ctx: QueryContext) => string | null;
  /** Hard override — skip retry entirely, return this as user-facing explanation.
   *  Use for known-impossible requests where the model can't fix the SQL. */
  override?: (ctx: QueryContext) => string | null;
}

export interface GuardrailResult {
  /** Guardrails that fired */
  fired: string[];
  /** Combined fix instructions for Claude retry */
  issues: string[];
  /** SQL after auto-rewrites */
  sql: string;
  /** Whether any guardrail fired */
  needsFix: boolean;
  /** Hard override explanation — if set, skip retry and return this to user */
  overrideResponse: string | null;
  /** Name of the guardrail that produced the override */
  overrideGuardrail: string | null;
}

/* ------------------------------------------------------------------ */
/*  Guardrail definitions                                              */
/* ------------------------------------------------------------------ */

const GUARDRAILS: Guardrail[] = [
  {
    name: "countywide-crosswalk-required",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: countywideCrosswalkMismatch,
    message: countywideCrosswalkMessage,
  },
  // --- Current / Historical ---
  {
    name: "current-crime-count-column",
    tabs: ["current"],
    match: (ctx) => /\bcrime_count\b/i.test(ctx.sql),
    rewrite: (sql) => sql.replace(/\bcrime_count\b/gi, "count"),
  },
  {
    name: "rate-no-population",
    tabs: ["current", "historical"],
    match: (ctx) =>
      ctx.isPerCapita && !ctx.sql.toLowerCase().includes("population") && !/_rate\b/.test(ctx.sql) && !/_clr\b/.test(ctx.sql),
    message: () =>
      "The user asked for rates/per capita but the SQL does not join population data.",
  },
  {
    name: "unpivoted-comparison",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // Catch GROUP BY agency or JOINed long-format with city/agency as a column value
      const isLongFormat = (
        /group by.*agency/i.test(sql) ||
        /as\s+city\b/i.test(sql) ||
        /\.agency\s*\|\|/i.test(sql)
      );
      // Exempt dynamic top-N queries — by SQL shape OR question intent
      const isDynamicTopN = /\bWHERE\b[\s\S]*?\bori\s+IN\s*\(\s*SELECT\b/i.test(sql) ||
        /\bWITH\b[\s\S]*?\bORDER\s+BY\s+(?:SUM|total|count)\b/i.test(sql) ||
        /\btop\s+\d+/i.test(q) ||
        /\btop\s+(cities|agencies|counties|states|departments)\b/i.test(q) ||
        /\b(which|what)\s+(cities|agencies|counties|states|departments)\s+(had|have|had the|with the)\s+(most|highest|lowest|greatest|least)\b/i.test(q) ||
        (/\b(highest|most|greatest|lowest|least)\b/i.test(q) && /\b(per month|by year|over time|trend|monthly|annual)\b/i.test(q));
      return (
        isLongFormat &&
        !isDynamicTopN &&
        !/case\s+when/i.test(sql) &&
        /\byear\b/i.test(sql) && /\bmonth\b/i.test(sql) &&
        /LIMIT\s+(\d+)/i.test(sql) && parseInt(sql.match(/LIMIT\s+(\d+)/i)?.[1] || "0") > 500
      );
    },
    message: () =>
      "Multi-agency monthly comparison returns too many rows in long format. For monthly time series, limit to 5 cities max and use CASE WHEN pivoting (one column per city). Long-format with 6+ cities produces unreadable charts.",
  },
  // --- Dynamic top-N: hardcoded city names the user didn't ask for ---
  {
    name: "dynamic-topn-guessed-names",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // Fire if user asked for dynamic discovery: "top N", "highest", "most", "which cities had the most", etc.
      const isDynamicRequest = /\btop\s+\d+/i.test(q) ||
        /\btop\s+(cities|agencies|counties|states|departments)\b/i.test(q) ||
        /\b(which|what)\s+(cities|agencies|counties|states|departments)\s+(had|have|had the|with the)\s+(most|highest|lowest|greatest|least)\b/i.test(q) ||
        (/\b(highest|most|greatest|lowest|least)\b/i.test(q) && /\b(per month|by year|over time|trend|monthly|annual)\b/i.test(q));
      if (!isDynamicRequest) return false;
      // Check if SQL has CASE WHEN with hardcoded city/agency names
      const caseNames: string[] = [];
      const caseRe = /CASE\s+WHEN\s+[^)]*(?:agency|city)\s*=\s*'([^']+)'/gi;
      let m;
      while ((m = caseRe.exec(sql)) !== null) {
        caseNames.push(m[1].toLowerCase());
      }
      if (caseNames.length === 0) return false;
      // Normalize user text with common aliases before comparing
      const ALIASES: Record<string, string[]> = {
        "new york city": ["nyc", "new york", "nypd"],
        "new york": ["nyc", "new york city", "nypd"],
        "los angeles": ["la", "lapd"],
        "washington": ["dc", "washington dc", "washington d.c."],
        "chicago": ["chi", "cpd"],
        "houston": ["hpd"],
        "dallas": ["dpd"],
        "baltimore": ["bmore", "bpd"],
        "philadelphia": ["philly"],
        "new orleans": ["nola"],
        "st louis": ["stl", "saint louis", "st. louis"],
        "saint louis": ["stl", "st louis", "st. louis"],
        "st. louis": ["stl", "st louis", "saint louis"],
        "atlanta": ["atl"],
        "phoenix": ["phx"],
        "minneapolis": ["mpls"],
        "detroit": ["detroit pd"],
        "memphis": ["mpd"],
        "nashville": ["mnpd"],
        "indianapolis": ["indy"],
      };
      const qNorm = q.replace(/[^a-z\s]/g, " ");
      const guessed = caseNames.filter(name => {
        if (qNorm.includes(name)) return false;
        // Check if user used an alias for this canonical name
        const aliases = ALIASES[name] || [];
        return !aliases.some(alias => qNorm.includes(alias));
      });
      return guessed.length > 0;
    },
    message: (ctx) => {
      const caseNames: string[] = [];
      const caseRe = /CASE\s+WHEN\s+[^)]*(?:agency|city)\s*=\s*'([^']+)'/gi;
      let m;
      while ((m = caseRe.exec(ctx.sql)) !== null) {
        caseNames.push(m[1]);
      }
      return `[SYSTEM: You hardcoded city names (${caseNames.join(", ")}) in CASE WHEN branches, but the user asked for a dynamic discovery query — you cannot know which cities will qualify. Use long format instead: return the requested time columns, an entity label, and the metric value, with a CTE that discovers the top entities. Let the frontend auto-pivot. Do NOT guess city names.]`;
    },
  },
  // --- Dynamic top-N: user asked for "top N" but SQL doesn't limit to N entities ---
  {
    name: "topn-no-entity-limit",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql;
      // Does the user ask for top N?
      const topNMatch = q.match(/\btop\s+(\d+)/i);
      if (!topNMatch) return false;
      const n = parseInt(topNMatch[1]);
      if (n < 2 || n > 50) return false;
      // Does the SQL have a subquery or CTE that limits to N entities?
      // Look for: LIMIT N in a subquery, or IN (SELECT ... LIMIT N), or WITH ... LIMIT N
      const hasEntityLimit =
        /\bIN\s*\(\s*SELECT\b[\s\S]*?\bLIMIT\s+\d+/i.test(sql) ||
        /\bWITH\b[\s\S]*?\bLIMIT\s+\d+/i.test(sql) ||
        /\bORDER\s+BY\b[\s\S]*?\bLIMIT\s+\d+\b[\s\S]*?\)\s/i.test(sql);
      if (hasEntityLimit) return false;
      // Check if the outer LIMIT alone is sufficient (single-row-per-entity)
      // If SQL has no GROUP BY with entity columns, outer LIMIT is fine
      const hasEntityGroup = /GROUP\s+BY\b[\s\S]*?\b(agency|city|ori|state)\b/i.test(sql);
      if (!hasEntityGroup) return false;
      const groupByClause = sql.match(/GROUP\s+BY\s+([\s\S]*?)(?:\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i)?.[1] || "";
      const groupsByTime = /\b(?:year|month)\b/i.test(groupByClause);
      const hasOuterTopLimit = new RegExp(`\\bORDER\\s+BY\\b[\\s\\S]*?\\bLIMIT\\s+${n}\\b`, "i").test(sql);
      if (!groupsByTime && hasOuterTopLimit) return false;
      // SQL groups by entity but has no inner limit — likely returns all entities
      return true;
    },
    message: (ctx) => {
      const topNMatch = ctx.question.toLowerCase().match(/\btop\s+(\d+)/i);
      const n = topNMatch ? topNMatch[1] : "N";
      return `The user asked for the top ${n} but your SQL returns all entities without limiting to ${n}. Use a CTE or subquery to first identify the top ${n} entities (e.g., by total count), then filter the main query to only those ${n} ORIs/agencies. Example: WITH top_agencies AS (SELECT ori FROM ... GROUP BY ori ORDER BY SUM(count) DESC LIMIT ${n}) SELECT ... WHERE ori IN (SELECT ori FROM top_agencies).`;
    },
  },
  {
    name: "requested-entity-vs-other-omitted",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const requested = requestedEntityForVsOther(ctx);
      if (!requested) return false;
      if (!/\bORDER\s+BY\b[\s\S]*\bLIMIT\s+\d+\b/i.test(ctx.sql)) return false;
      return !sqlMentionsEntity(ctx.sql, requested);
    },
    message: (ctx) => {
      const requested = requestedEntityForVsOther(ctx) || "the requested city";
      return `[SYSTEM: The user asked to compare ${requested} with other peer/large cities. Your SQL ranks cities with ORDER BY/LIMIT but does not force-include ${requested}, so ${requested} can be omitted if it falls below the cutoff. Build a CTE for top comparison cities, a CTE for the requested city, UNION them, and return both the requested entity and the comparison set. Do not let LIMIT exclude the requested city.]`;
    },
  },
  {
    name: "yaxis-missing",
    tabs: ["current", "historical"],
    match: () => false, // Checked externally with yAxis from ClaudeResponse — see route.ts
  },
  {
    name: "or-and-precedence",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => hasUnparenthesizedOrAnd(ctx.sql),
    message: () =>
      "[SYSTEM: The WHERE clause mixes top-level OR and AND without parentheses. Wrap all OR alternatives in parentheses before applying shared filters. Correct shape: WHERE ((entity_a_filters) OR (entity_b_filters)) AND shared_year_or_offense_filters.]",
  },
  {
    name: "contract-year-lower-bound-missing",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const start = requestedStartYear(ctx.question);
      return start !== null && !sqlHasRequestedLowerYearBound(ctx.sql, start);
    },
    message: (ctx) => {
      const start = requestedStartYear(ctx.question) ?? "requested start year";
      return `[SYSTEM: The user requested results starting from ${start}, but the SQL does not enforce a lower year bound. Add year >= ${start} or an equivalent aliased predicate such as table_alias.year >= ${start}. Do not return earlier years.]`;
    },
  },
  {
    name: "contract-year-upper-bound-missing",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const end = requestedEndYear(ctx.question);
      return end !== null && !sqlHasYearUpperBound(ctx.sql, end);
    },
    message: (ctx) => {
      const end = requestedEndYear(ctx.question) ?? "requested end year";
      const current = currentCalendarYear();
      const partial = end === current
        ? ` Include ${current} if the source has partial-year data, and disclose that ${current} is partial.`
        : "";
      return `[SYSTEM: The user requested results through ${end}, but the SQL does not enforce that end year. Add year <= ${end}, year BETWEEN ... AND ${end}, or an equivalent aliased predicate.${partial} Do not silently stop at an earlier year.]`;
    },
  },
  {
    name: "relative-past-years-complete-calendar",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => violatesPastYearsConvention(ctx),
    message: (ctx) => {
      const range = relativeYearRangeForQuestion(ctx.question);
      return `[SYSTEM: The user asked for "past/last N years" without asking to include the current partial year. Use the last N complete calendar years only: year BETWEEN ${range?.start} AND ${range?.end}. Do not include ${currentCalendarYear()} unless the user explicitly says "including this year", "this year", "YTD", "to date", or "to present".]`;
    },
  },
  {
    name: "current-historical-theft-subtype-parent",
    tabs: ["current", "historical"],
    match: (ctx) => asksForTheftSubtype(ctx.question) && usesParentTheftSql(ctx.sql),
    message: () =>
      "[SYSTEM: This tab only has the parent Theft category, not theft subtypes such as larceny-from-auto or shoplifting. If you use the parent Theft field, label the result as total Theft and explicitly state that subtype-specific counts require the NIBRS tab.]",
  },
  {
    name: "offense-missing-filter",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      const offenseTerms: [RegExp, string[], string[]][] = [
        // [question pattern, SQL WHERE terms, SQL column names that encode this offense]
        [/\bmurder|homicide\b/i, ["'murder'", "'09a'"], ["murder", ".murder", "hsn.murder", "hac.murder", "hc.murder"]],
        [/\brape\b/i, ["'rape'", "'11a'"], ["rape", ".rape", "hsn.rape", "hac.rape"]],
        [/\brobbery|robberies\b/i, ["'robbery'", "'120'"], ["robbery", ".robbery", "hsn.robbery", "hac.robbery"]],
        [/\bassault\b/i, ["'aggravated assault'", "'13a'"], ["assault", ".assault", "aggravated_assault", "hsn.aggravated_assault", "hac.assault"]],
        [/\bburglary|burglaries\b/i, ["'burglary'", "'220'"], ["burglary", ".burglary", "hsn.burglary", "hac.burglary"]],
        [/\btheft(?!.*auto|.*motor|.*vehicle)|larceny|larcenies\b/i, ["'theft'", "'23h'", "'larceny'"], ["theft", ".theft", "hsn.theft", "hac.theft"]],
        [/\bauto theft|motor vehicle theft|car theft|vehicle theft\b/i, ["'motor vehicle theft'", "'240'"], ["motor_vehicle_theft", ".motor_vehicle_theft", "hsn.motor_vehicle_theft", "hac.motor_vehicle_theft"]],
      ];
      // Skip if SQL uses clearance columns (offense is encoded in column name)
      if (/_clr\b/.test(sqlLower)) return false;
      for (const [pattern, sqlTerms, columnNames] of offenseTerms) {
        if (!pattern.test(ctx.question)) continue;
        // Check if offense is in a WHERE filter
        const hasWhereFilter = sqlTerms.some((t) => sqlLower.includes(t)) || sqlLower.includes("offense");
        if (hasWhereFilter) continue;
        // Check if offense is encoded as a selected column (Historical tables use column-per-offense)
        const hasColumnSelect = columnNames.some((c) => sqlLower.includes(c));
        if (hasColumnSelect) continue;
        return true;
      }
      return false;
    },
    message: (ctx) => {
      const match = ctx.question.match(
        /\b(murder|homicide|rape|robbery|robberies|assault|burglary|burglaries|theft|larceny|larcenies|auto theft|motor vehicle theft|car theft|vehicle theft)\b/i
      );
      return `The user asked about "${match?.[0] || "a specific offense"}" but the SQL has no offense filter. Add a WHERE clause filtering by the appropriate offense.`;
    },
  },
  {
    name: "ambiguous-city-type",
    tabs: ["current"],
    match: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      if (!sqlLower.includes("agency_monthly") || !/case\s+when/i.test(ctx.sql) || sqlLower.includes("type")) return false;
      const ambiguous = ["los angeles", "baltimore", "el paso", "sacramento", "san diego", "san mateo", "santa cruz", "st louis", "alameda", "denton", "greenville", "hamilton", "kalamazoo", "st charles", "tulare"];
      return ambiguous.some((c) => sqlLower.includes(`'${c}'`));
    },
    message: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      const ambiguous = ["los angeles", "baltimore", "el paso", "sacramento", "san diego", "san mateo", "santa cruz", "st louis", "alameda", "denton", "greenville", "hamilton", "kalamazoo", "st charles", "tulare"];
      const mentioned = ambiguous.filter((c) => sqlLower.includes(`'${c}'`));
      return `Multi-agency query includes ${mentioned.join(", ")} which have both City and County agencies, but no type filter was found. Add AND type = 'City' (or 'County') in each CASE WHEN branch and WHERE condition to avoid mixing jurisdictions.`;
    },
  },
  {
    name: "yaxis-label-no-population",
    tabs: ["current", "historical"],
    match: () => false, // Checked externally with yAxisLabel from ClaudeResponse — see route.ts
  },
  {
    name: "national-as-agency",
    tabs: ["current", "historical"],
    match: (ctx) => {
      return /agency\s*=\s*'(USA|United States|US|National|Nationwide)'/i.test(ctx.sql) ||
        /agency\s*(?:LIKE|IN)\s*[^)]*'(USA|United States|National)'/i.test(ctx.sql);
    },
    message: (ctx) => {
      if (ctx.tab === "historical") {
        return "You looked up national data as an agency name. National data is in historical_state_national with state = 'United States'. Use that table for the national comparison instead of looking up 'USA' or 'United States' as an agency.";
      }
      return "You looked up national data as an agency name. National data is in the national_monthly table. Use national_monthly for the national comparison instead of looking up 'USA' or 'National' as an agency in agency_monthly.";
    },
  },
  {
    name: "city-to-national-fallback",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const commonNonCityWords = /\b(united states|national|nationwide|country|state|federal|annual|home|residential|commercial)\b/i;
      const looksLikeCity = ctx.question.match(/\bin\s+([A-Z][a-z]{2,}(?:[\s-][A-Z][a-z]+)*)/);
      if (!looksLikeCity || commonNonCityWords.test(looksLikeCity[1])) return false;
      const sqlLower = ctx.sql.toLowerCase();
      const usesNational = sqlLower.includes("national_monthly") || sqlLower.includes("state_monthly");
      const usesAgency = sqlLower.includes("agency_monthly") || sqlLower.includes("agency =") || sqlLower.includes("agency like");
      return usesNational && !usesAgency;
    },
    message: (ctx) => {
      const cityMatch = ctx.question.match(/\bin\s+([A-Z][a-z]{2,}(?:[\s-][A-Z][a-z]+)*)/);
      const city = cityMatch?.[1] || "that city";
      return `The user asked about "${city}" which looks like a city name, but your SQL queries national/state-level data instead. If "${city}" is a misspelling or not in the dataset, set sql to null and say you couldn't find that city — suggest the closest match or ask the user to check the spelling. Do NOT silently fall back to national data when the user asked about a specific place.`;
    },
  },

  // --- Current: single-city query on ambiguous city without type filter ---
  {
    name: "single-city-no-type",
    tabs: ["current"],
    match: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      if (!sqlLower.includes("agency_monthly")) return false;
      // Already has type filter
      if (/\btype\s*=/i.test(ctx.sql)) return false;
      // Only fire for single-city queries (no CASE WHEN = multi-city, already covered)
      if (/case\s+when/i.test(ctx.sql)) return false;
      const ambiguous = [
        "los angeles", "baltimore", "el paso", "sacramento", "san diego",
        "san mateo", "santa cruz", "st louis", "alameda", "denton",
        "greenville", "hamilton", "kalamazoo", "st charles", "tulare",
        "jacksonville", "richmond", "kansas city",
      ];
      return ambiguous.some((c) => sqlLower.includes(`agency = '${c}'`) || sqlLower.includes(`agency='${c}'`));
    },
    message: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      const ambiguous = [
        "los angeles", "baltimore", "el paso", "sacramento", "san diego",
        "san mateo", "santa cruz", "st louis", "alameda", "denton",
        "greenville", "hamilton", "kalamazoo", "st charles", "tulare",
        "jacksonville", "richmond", "kansas city",
      ];
      const mentioned = ambiguous.filter((c) => sqlLower.includes(`'${c}'`));
      return `The query filters by ${mentioned.join(", ")} without a type filter. This city has both City and County agencies with different data. Add AND type = 'City' to the WHERE clause (or set sql to null and ask the user which jurisdiction they mean).`;
    },
  },

  // --- Current: state_monthly used for state trend ---
  {
    name: "state-monthly-for-trend",
    tabs: ["current"],
    match: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      // state_monthly used with time-series grouping (year, month) = trend query
      return sqlLower.includes("state_monthly") &&
        /group\s+by.*\byear\b/i.test(ctx.sql) &&
        !sqlLower.includes("agency_monthly");
    },
    message: () =>
      "You used state_monthly for a state trend query. state_monthly includes partial reporters and produces inconsistent counts. Use agency_monthly JOIN agencies WHERE national_sample = 1 AND state = '[XX]' instead, which only includes agencies with complete reporting histories.",
  },

  // --- Current: county/parish suffix in agency name ---
  // RTCI stores county agencies as agency='Fairfax' + type='County', NOT 'Fairfax County'.
  // Claude often generates agency='Fairfax County' which matches nothing.
  {
    name: "current-county-name-suffix",
    tabs: ["current"],
    match: (ctx) => {
      if (isCountywideGeographyQuestion(ctx.question)) return false;
      // Detect agency = 'X County' or agency = 'X Parish' (with optional table alias)
      return /(?:\w+\.)?agency\s*=\s*'[^']+\s+(?:County|Parish)'/i.test(ctx.sql);
    },
    rewrite: (sql) => {
      // Replace agency = 'X County/Parish' with agency = 'X' AND type = 'County'
      // Preserve table alias if present (e.g., am.agency → am.type)
      let fixed = sql.replace(
        /(\b(\w+)\.agency\s*=\s*')([^']+?)\s+(?:County|Parish)(')/gi,
        (_, pre, alias, name, post) => {
          // Check if type='City' exists nearby and replace it
          return `${pre}${name}${post} AND ${alias}.type = 'County'`;
        }
      );
      // Handle bare agency (no alias)
      fixed = fixed.replace(
        /(\bagency\s*=\s*')([^']+?)\s+(?:County|Parish)(')/gi,
        (_, pre, name, post) => {
          return `${pre}${name}${post} AND type = 'County'`;
        }
      );
      // If type = 'City' was already in the SQL, replace it with 'County'
      // (don't create contradictory type='City' AND type='County')
      if (/type\s*=\s*'County'/i.test(fixed) && /type\s*=\s*'City'/i.test(fixed)) {
        fixed = fixed.replace(/\btype\s*=\s*'City'/gi, "type = 'County'");
      }
      return fixed !== sql ? fixed : null;
    },
    message: () =>
      "[SYSTEM: Current Trends stores county/parish agencies WITHOUT the suffix in the agency name. Use agency = 'Fairfax' AND type = 'County', NOT agency = 'Fairfax County'. Parish agencies also use type = 'County'.]",
  },

  // --- Current: city-to-national fallback (widened) ---
  // Catches abbreviations (LA, NYC, STL) and leading city patterns
  // that the existing city-to-national-fallback misses
  {
    name: "city-abbreviation-to-national",
    tabs: ["current", "historical"],
    match: (ctx) => {
      // Only fire if question mentions a city via abbreviation or leading pattern
      // but SQL uses national/state tables with no agency filter
      const sqlLower = ctx.sql.toLowerCase();
      const usesNational = sqlLower.includes("national_monthly") || sqlLower.includes("state_monthly") ||
        sqlLower.includes("historical_state_national");
      const usesAgency = /agency\s*=/i.test(ctx.sql) || sqlLower.includes("agency_monthly");
      if (!usesNational || usesAgency) return false;

      // State names/abbreviations that should NOT trigger this guardrail
      const STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|district of columbia)\b/i;

      // Check for abbreviations the existing guardrail misses
      const abbrevs = /\b(LA|NYC|STL|ATL|NOLA|PHX|PHILLY|DFW|DMV|CHI|BMORE|MPLS|MSP|OKC|SLC|NYPD|LAPD|CPD|HPD|DPD|BPD|MPD)\b/i;
      if (abbrevs.test(ctx.question)) return true;

      // Check for geos extracted from question — but exclude state names
      if (ctx.geos.length > 0 && !sqlLower.includes("agency")) {
        const nonStateGeos = ctx.geos.filter(g => !STATE_NAMES.test(g));
        if (nonStateGeos.length > 0) return true;
      }

      return false;
    },
    message: (ctx) => {
      const city = ctx.geos[0] || ctx.question.match(/\b(LA|NYC|STL|ATL|NOLA|PHX|PHILLY|CHI|BMORE|NYPD|LAPD|CPD)\b/i)?.[1] || "that city";
      return `The user asked about "${city}" but your SQL queries national/state-level data instead of agency-level data. Look up the correct agency name in agency_monthly (or historical_agency_crime for Historical). If the city is not in the dataset, set sql to null and tell the user. Do NOT silently fall back to national data.`;
    },
  },

  // --- Current/Historical: population JOIN without year (rate queries) ---
  {
    name: "population-join-no-year",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Only relevant for rate queries that join population
      if (!ctx.isPerCapita) return false;
      const hasPopJoin = /JOIN\s+agency_population\b/i.test(sql) || /JOIN\s+historical_agency_population\b/i.test(sql);
      if (!hasPopJoin) return false;
      // Check if the JOIN condition includes year matching
      // Good: ON ap.ori = am.ori AND ap.year = am.year
      // Bad:  ON ap.ori = am.ori (missing year)
      const joinClause = sql.match(/JOIN\s+(?:agency_population|historical_agency_population)\s+\w+\s+ON\s+([^)]+?)(?:\s+WHERE|\s+GROUP|\s+ORDER|\s+LIMIT|$)/i);
      if (!joinClause) return false;
      const onClause = joinClause[1];
      return !/\byear\b/i.test(onClause);
    },
    message: () =>
      "Your population JOIN is missing a year condition (e.g., AND ap.year = am.year). Without it, each row gets multiplied by every year of population data, producing wildly inflated results. Add the year match to the JOIN ON clause.",
  },

  // --- Historical: state query using agency table instead of state_national ---
  {
    name: "historical-state-via-agency",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // Detects: aggregating historical_agency_crime grouped by year with a state filter
      // but NOT selecting individual agencies (no agency column in SELECT)
      const usesAgencyTable = /\bhistorical_agency_crime\b/i.test(sql);
      const hasStateFilter = /\bha\.state\s*=\s*'[a-z]{2}'/i.test(sql);
      const groupsByYear = /GROUP\s+BY\s+(?:hac\.)?year/i.test(sql);
      const selectsAgency = /SELECT\s+[\s\S]*?\b(?:ha\.)?agency\b[\s\S]*?FROM/i.test(sql);
      // Do NOT fire for county/parish/city/agency queries — those NEED the agency table
      const asksSubState = /\b(county|parish|borough|sheriff|agency)\b/i.test(q) ||
        /\bin\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*,/i.test(ctx.question); // "in Alameda, California"
      if (asksSubState) return false;
      return usesAgencyTable && hasStateFilter && groupsByYear && !selectsAgency;
    },
    message: () =>
      "You aggregated historical_agency_crime by state, which only includes agencies that reported — it dramatically undercounts. Use historical_state_national instead, which has FBI statewide estimates. Use full state names (e.g., 'North Carolina' not 'nc'). Note the state/national column names differ from agency columns: use aggravated_assault/aggravated_assault_rate instead of assault/assault_rate, auto_theft/auto_theft_rate instead of motor_vehicle_theft/motor_vehicle_theft_rate, and calculate violent/property rates from component rate columns.",
  },

  // --- Historical: listing every agency in a state (un-chartable) ---
  {
    name: "historical-state-agency-listing",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detects: SELECT agency, year, crime FROM historical_agency_crime
      // with state filter but ordered by agency (not ranked by metric)
      // This produces hundreds/thousands of rows that can't be charted
      const usesAgencyTable = /\bhistorical_agency_crime\b/i.test(sql);
      const hasStateFilter = /\bha\.state\s*=\s*'[a-z]{2}'/i.test(sql);
      const selectsAgency = /SELECT[\s\S]*?\b(?:ha\.)?agency\b[\s\S]*?FROM/i.test(sql);
      // Not a ranking — ordered by agency name, not by a metric DESC
      const isRanking = /ORDER\s+BY\s+(?:total|sum|count|murder|robbery|assault|burglary|theft|rape|violent|property)\b/i.test(sql) ||
        /ORDER\s+BY\s+\w+\s+DESC/i.test(sql);
      return usesAgencyTable && hasStateFilter && selectsAgency && !isRanking;
    },
    message: () =>
      "Your query lists every agency in a state, which produces hundreds or thousands of rows that cannot be charted. Use historical_state_national for the state aggregate instead (e.g., SELECT year, robbery FROM historical_state_national WHERE state = 'California'). Only use the agency table when the user explicitly asks for a ranking (top 10, highest, etc.) or names specific agencies.",
  },

  // --- Contract checks: question intent vs SQL structure ---
  {
    name: "contract-geography-missing",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      // User mentions a specific city but SQL has no agency filter and no CASE WHEN
      const cityPatterns = [
        /\b(houston|dallas|phoenix|philadelphia|san antonio|san diego|austin|jacksonville|columbus|charlotte|indianapolis|san francisco|seattle|denver|nashville|oklahoma city|el paso|boston|portland|memphis|louisville|baltimore|milwaukee|albuquerque|tucson|fresno|sacramento|atlanta|kansas city|omaha|raleigh|miami|oakland|minneapolis|tampa|detroit|new orleans|cleveland|pittsburgh|cincinnati|orlando|st\.?\s*louis|baton rouge|richmond|birmingham|spokane|norfolk|durham|stockton|anchorage|honolulu|arlington|lubbock|garland|madison|reno|glendale|hialeah|chesapeake)\b/i,
        /\bin\s+(los angeles|new york|chicago)\b/i,
        /\b(la|nyc|chi|philly|nola|stl|atl|bmore|indy|mpls)\b/i,
      ];
      const mentionsCity = cityPatterns.some(p => p.test(q));
      if (!mentionsCity) return false;
      // SQL should have an agency filter or city-level CASE WHEN
      const hasAgencyFilter = /agency\s*=|agency\s+like|agency\s+in\s*\(/i.test(sql);
      const hasCaseWhen = /case\s+when.*agency/i.test(sql);
      const usesNational = sql.includes("national_monthly") || sql.includes("historical_state_national");
      return !hasAgencyFilter && !hasCaseWhen && usesNational;
    },
    message: (ctx) => {
      const cityMatch = ctx.question.match(/\b(?:in\s+)?([A-Z][a-z]+(?:[\s-][A-Z][a-z]+)*)/);
      return `The user asked about "${cityMatch?.[1] || "a specific city"}" but the SQL queries national/state-level data with no agency filter. Query the agency-level table instead, filtering by the requested city.`;
    },
  },
  {
    name: "contract-year-range-missing",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      // User specifies a year range like "since 2020" or "from 1990 to 2024"
      const yearMatch = q.match(/\b(?:since|from|starting|after)\s+(19|20)\d{2}\b/i) ||
        q.match(/\b(19|20)\d{2}\s*(?:to|through|-)\s*(19|20)\d{2}\b/i);
      if (!yearMatch) return false;
      // SQL should have a year filter
      const hasYearFilter = /\byear\s*(?:>=|>|=|BETWEEN)/i.test(sql) || /\byear\s+IN\s*\(/i.test(sql);
      return !hasYearFilter;
    },
    message: (ctx) => {
      const yearMatch = ctx.question.match(/\b(?:since|from|starting|after)\s+((19|20)\d{2})\b/i) ||
        ctx.question.match(/\b((19|20)\d{2})\s*(?:to|through|-)/i);
      return `The user specified a year range starting at ${yearMatch?.[1] || "a specific year"} but the SQL has no year filter. Add a WHERE clause filtering by the requested year range.`;
    },
  },
  {
    name: "explicit-state-not-agency",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => explicitStateSubstateMismatch(ctx.question, ctx.sql) !== null,
    message: (ctx) => {
      const intent = explicitStateSubstateMismatch(ctx.question, ctx.sql);
      const state = intent ? `${intent.stateName} (${intent.state})` : "the requested state";
      return `[SYSTEM: The user explicitly asked for statewide data for ${state}, but the SQL narrows the result to a specific city, agency, county, ORI, or agency type. Remove agency/city/ORI filters and aggregate all records for state = '${intent?.state || "XX"}'. Do not use agency = 'New York' or city = 'NEW YORK' for a "New York State" question unless the user explicitly asks for New York City/NYPD or a state agency such as State Police.]`;
    },
  },

  {
    // TODO: Rate-contract second-failure override — deferred.
    // Plan: after retry, run runGuardrails() again in the route. If this fires twice
    // on the same query, convert to hard override ("I couldn't calculate a rate").
    // Keep this as a retry guardrail for now; route-level second-failure logic is not yet implemented.
    name: "contract-rate-no-population",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      // User asks for rate/per capita but SQL doesn't join population
      // Skip if user explicitly rejected rates
      if (/\b(not rates?|raw numbers?|raw counts?|counts?\s*(?:,\s*)?not rates?)\b/i.test(q)) return false;
      const wantsRate = /\b(rates?|per\s*capita|per\s*100k|per\s*100,000|per\s*hundred\s*thousand)\b/i.test(q);
      if (!wantsRate) return false;
      // Skip if user is comparing demographic groups — "rates" is colloquial, not per-capita
      const isComparison = /\b(compare|comparison|vs|versus|breakdown|share|percent|proportion)\b/i.test(q);
      const groupsByDemographic = /GROUP\s+BY[\s\S]*?\b(age_group|race|sex|weapon|ethnicity)\b/i.test(ctx.sql);
      if (isComparison && groupsByDemographic) return false;
      const sqlLower = ctx.sql.toLowerCase();
      return !sqlLower.includes("population") && !sqlLower.includes("100000") && !/_rate\b/.test(sqlLower) && !/_clr\b/.test(sqlLower);
    },
    message: (ctx) => {
      if (ctx.tab === "shr") return "The user asked for rates but the SQL does not calculate a per-capita rate. Use ROUND(COUNT(*) * 100000.0 / NULLIF(AVG(i.population), 0), 1) for single-agency SHR rates. For state/national aggregate rates, join state_population by state/year or use state = 'US' for national denominators.";
      if (ctx.tab === "nibrs") return "The user asked for rates but the SQL does not calculate a per-capita rate. JOIN the agencies table to get population, then use ROUND(SUM(count) * 100000.0 / population, 1). For state-level rates, redirect to the Historical Library tab.";
      return "The user asked for rates/per capita but the SQL does not reference population data. JOIN agency_population (Current Trends) or use the population column (Historical) and divide by population to calculate the rate.";
    },
  },

  // --- Historical: recursive CTE without ORI deduplication ---
  {
    name: "historical-multi-ori-cte",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect recursive CTE gap-fill pattern that selects ORI without LIMIT 1
      const hasRecursiveCTE = /WITH\s+\w+\s+AS\s*\([\s\S]*?UNION\s+ALL/i.test(sql);
      const hasAgencyOri = /SELECT\s+(?:ha\.)?ori\s+FROM\s+historical_agency\b/i.test(sql);
      const hasLimit1 = /FROM\s+historical_agency\b[^)]*LIMIT\s+1/i.test(sql);
      const joinsDataTable = /FROM\s+historical_agency\s+\w+\s+JOIN\s+historical_agency_crime/i.test(sql) ||
        /FROM\s+historical_agency\s+\w+\s+JOIN\s+historical_agency_clearance/i.test(sql) ||
        /FROM\s+historical_agency\s+\w+\s+JOIN\s+historical_staffing/i.test(sql);
      // Fire if: recursive CTE + selects ORI from historical_agency + no LIMIT 1 + doesn't join data table
      return hasRecursiveCTE && hasAgencyOri && !hasLimit1 && !joinsDataTable;
    },
    message: () =>
      "Your recursive CTE selects ORI from historical_agency without deduplication. Some agencies have multiple ORI codes — this will produce duplicate rows. Add GROUP BY ha.ori ORDER BY COUNT(*) DESC LIMIT 1 to the agency CTE, and JOIN the data table (historical_agency_crime, historical_staffing, etc.) to ensure you pick the ORI with actual data.",
  },

  // --- NIBRS ---
  {
    name: "campus-agency-not-city",
    tabs: ["nibrs", "shr"],
    match: hasCampusAgencySqlMismatch,
    message: campusAgencyMessage,
  },
  {
    name: "nibrs-offense-category-drift",
    tabs: ["nibrs"],
    match: (ctx) => {
      const codes = sqlQuotedCodes(ctx.sql);
      const hasCodeFilter = /\bucr_offense_code\b/i.test(ctx.sql);
      const usesNibrsPersonsCategory = /Crimes Against Persons/i.test(ctx.sql);
      const usesNibrsPropertyCategory = /Crimes Against Property/i.test(ctx.sql);

      if (asksBareViolentCrime(ctx.question)) {
        const nibrsPersonOnlyCodes = ["09B", "09C", "11D", "13B", "13C", "100", "36A", "36B", "64A", "64B"];
        return usesNibrsPersonsCategory ||
          hasAny(codes, nibrsPersonOnlyCodes) ||
          (hasCodeFilter && missingAny(codes, NIBRS_UCR_VIOLENT_CODES));
      }

      if (asksBarePropertyCrime(ctx.question)) {
        const nibrsPropertyOnlyCodes = [
          "120", "210", "250", "26A", "26B", "26C", "26D", "26E", "26F", "26G",
          "270", "280", "290", "510",
        ];
        return usesNibrsPropertyCategory ||
          hasAny(codes, nibrsPropertyOnlyCodes) ||
          (hasCodeFilter && missingAny(codes, NIBRS_UCR_PROPERTY_CODES));
      }

      return false;
    },
    message: (ctx) => {
      if (asksBareViolentCrime(ctx.question)) {
        return `[SYSTEM: For bare "violent crime" on the NIBRS tab, use the UCR-aligned definition, not the broad NIBRS Crimes Against Persons taxonomy. Include exactly these codes: ${formatNibrsCodeList(NIBRS_UCR_VIOLENT_CODES)} (${NIBRS_UCR_VIOLENT_LABEL}). This includes robbery (120) and excludes 09B, 09C, 11D, 13B, 13C, kidnapping, statutory sex offenses, and human trafficking. If needed, combine victim-summary counts for person offenses with offense-summary counts for robbery. State the included offenses in the explanation.]`;
      }
      return `[SYSTEM: For bare "property crime" on the NIBRS tab, use the UCR-aligned definition, not the broad NIBRS Crimes Against Property taxonomy. Include exactly these codes: ${formatNibrsCodeList(NIBRS_UCR_PROPERTY_CODES)} (${NIBRS_UCR_PROPERTY_LABEL}). Exclude robbery, fraud, embezzlement, stolen property, vandalism, bribery, and other NIBRS-only property-category offenses. State the included offenses in the explanation.]`;
    },
  },
  {
    name: "nibrs-homicide-code-drift",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const asksMurder = /\b(murder|murders|homicide|homicides|killing|killings)\b/i.test(q) &&
        !/\b(manslaughter|negligent|justifiable|all homicide|all homicides|all homicide types)\b/i.test(q);
      if (!asksMurder) return false;
      const codes = sqlQuotedCodes(ctx.sql);
      return codes.has("09B") || codes.has("09C") || /Crimes Against Persons/i.test(ctx.sql);
    },
    message: () =>
      "[SYSTEM: For ordinary NIBRS murder/homicide wording, use offense code 09A only. Do not include 09B negligent manslaughter or 09C justifiable homicide unless the user explicitly asks for those categories or for all homicide types. State that the result is murder/nonnegligent manslaughter.]",
  },
  {
    name: "nibrs-officer-involved-unsupported",
    tabs: ["nibrs"],
    match: (ctx) => asksUnsupportedOfficerInvolved(ctx.question),
    override: () =>
      "NIBRS does not identify whether a police officer or law enforcement employee was involved as an offender or participant in general incidents, including domestic violence. I can show the overall incident category, but it would not be police-involved. The only narrow law-enforcement-specific homicide category available here is justifiable homicide where a criminal was killed by a police officer.",
  },
  {
    name: "nibrs-raw-victims",
    tabs: ["nibrs"],
    match: (ctx) => {
      const PERSON_CODES = ['09A','09B','09C','11A','11B','11C','11D','13A','13B','13C','100','36A','36B','64A','64B'];
      const hitsRawVictims = /\bFROM\s+VICTIMS\b/i.test(ctx.sql) && !(/\bSUMMARY_VICTIM/i.test(ctx.sql));
      const hasPersonCode = PERSON_CODES.some(code => ctx.sql.includes(`'${code}'`));
      const isCountQuery = /\bCOUNT\s*\(|\bSUM\s*\(/i.test(ctx.sql);
      const selectClause = ctx.sql.match(/SELECT\s+([\s\S]*?)\s+FROM/i)?.[1] || '';
      const needsDemographics = /\b(\.age|\.sex|\.race|\.ethnicity|\.injury_type|\.relationship)/i.test(selectClause);
      return hitsRawVictims && hasPersonCode && isCountQuery && !needsDemographics;
    },
    message: () =>
      "[SYSTEM: You MUST use summary_victim_state_monthly or summary_victim_city_monthly for this query. Do NOT use the raw victims table.]",
  },
  {
    name: "nibrs-weapon-injury-combination-unsupported",
    tabs: ["nibrs"],
    match: (ctx) => asksWeaponInjuryBreakdown(ctx.question) && usesBroadRawWeaponInjuryAggregate(ctx.sql),
    override: () =>
      "I can't reliably break NIBRS results down by both weapon type and injury type from the available summary tables. I can show a weapon breakdown, or an injury-type breakdown separately; a combined weapon-by-injury table would need to be precomputed before this can be answered safely.",
  },
  {
    name: "nibrs-raw-table-for-counts",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect raw tables used for aggregate counts/sums/trends
      const RAW_TABLES = ["offenses", "property", "arrestees", "offense_weapons"];
      const usesRawTable = RAW_TABLES.some(t =>
        new RegExp(`\\bFROM\\s+${t}\\b`, "i").test(sql) ||
        new RegExp(`\\bJOIN\\s+${t}\\b`, "i").test(sql)
      );
      if (!usesRawTable) return false;
      // Only fire if it's an aggregate query (COUNT/SUM/GROUP BY) — detail queries on raw tables are OK
      if (!/\bCOUNT\s*\(|\bSUM\s*\(|\bGROUP\s+BY\b/i.test(sql)) return false;

      // CARVEOUT: Allow raw property table for value analysis (median, percentile, distribution)
      // These queries need individual record values and can't use pre-aggregated summaries.
      // Must be tightly filtered (state + year + offense code).
      const usesPropertyTable = (
        new RegExp(`\\bFROM\\s+property\\b`, "i").test(sql) ||
        new RegExp(`\\bJOIN\\s+property\\b`, "i").test(sql)
      );
      if (usesPropertyTable) {
        const hasValueRef = /\bvalue\b/i.test(sql);
        const isValueAnalysis = hasValueRef && (
          // Statistical functions: MEDIAN, PERCENTILE, window functions
          /\bMEDIAN\b|\bPERCENTILE\b|\bNTILE\b|\bROW_NUMBER\b|\bRANK\b|\bDENSE_RANK\b/i.test(sql) ||
          // Sorting by value (for median-via-OFFSET or value ranking)
          /\bORDER\s+BY\b.*\bvalue\b/i.test(sql) ||
          // Any aggregate on value: AVG(value), AVG(CAST(value...)), SUM(value), MIN(value), MAX(value)
          /\b(AVG|SUM|MIN|MAX)\s*\([^)]*\b(?:\w+\.)?value\b/i.test(sql) ||
          // Distribution/histogram: GROUP BY value (with optional table alias)
          /\bGROUP\s+BY\b[^)]*\b(?:\w+\.)?value\b/i.test(sql)
        );
        const hasStateFilter = /\bstate\s*=\s*'/i.test(sql);
        const hasYearFilter =
          /\b(?:data_)?year\s*[=><!]/i.test(sql) ||
          /\b(?:data_)?year\s+BETWEEN\b/i.test(sql) ||
          /\b(?:data_)?year\s+IN\s*\(/i.test(sql);
        const hasOffenseFilter = /\bucr_offense_code\b/i.test(sql);
        if (isValueAnalysis && hasStateFilter && hasYearFilter && hasOffenseFilter) return false;
      }

      return true;
    },
    message: (ctx) => {
      const sql = ctx.sql;
      // Suggest the specific summary table based on which raw table was used
      let suggestion = "";
      if (/\bFROM\s+offenses\b|\bJOIN\s+offenses\b/i.test(sql)) {
        suggestion = " Use summary_state_monthly (state-level) or summary_city_monthly (city-level) for offense counts. For person crimes (murder, rape, assault), use summary_victim_state_monthly or summary_victim_city_monthly instead.";
      } else if (/\bFROM\s+property\b|\bJOIN\s+property\b/i.test(sql)) {
        suggestion = " Use summary_property_offense for property loss data.";
      } else if (/\bFROM\s+arrestees\b|\bJOIN\s+arrestees\b/i.test(sql)) {
        suggestion = " Use summary_arrestee_demographics for arrestee data.";
      } else if (/\bFROM\s+offense_weapons\b|\bJOIN\s+offense_weapons\b/i.test(sql)) {
        suggestion = " Use summary_offense_weapon for weapon data.";
      }
      return `[SYSTEM: CRITICAL — Your query uses a raw table that has 100M+ rows and WILL time out. You must rewrite it completely using a summary table.${suggestion} Generate a NEW query from scratch using the correct summary table — do not just replace the table name, as the column names and structure are different.]`;
    },
  },
  {
    name: "nibrs-person-crime-offense-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      // Person crime codes that MUST use victim tables, not offense tables
      const PERSON_CODES = ["09A","09B","09C","11A","11B","11C","11D","13A","13B","13C","100","36A","36B","64A","64B"];
      const sql = ctx.sql;
      // Using offense summary tables (not victim summary tables) with person crime codes
      const usesOffenseSummary = /\bsummary_(?:city|state)_monthly\b/i.test(sql) && !/\bsummary_victim/i.test(sql);
      if (!usesOffenseSummary) return false;
      return PERSON_CODES.some(code => sql.includes(`'${code}'`));
    },
    message: () =>
      "[SYSTEM: Person crimes (murder, rape, assault, kidnapping, sex offenses, carjacking) must be counted from VICTIM summary tables, not offense summary tables. Use summary_victim_state_monthly or summary_victim_city_monthly instead of summary_state_monthly or summary_city_monthly. Offense tables undercount person crimes by ~20%.]",
  },
  {
    name: "nibrs-property-crime-victim-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      // Property crime codes that must NOT use victim tables
      const PROPERTY_CODES = [
        "23A","23B","23C","23D","23E","23F","23G","23H",  // theft subcodes
        "220",                                             // burglary
        "240",                                             // motor vehicle theft
        "250",                                             // counterfeiting/forgery
        "26A","26B","26C","26D","26E",                     // fraud
        "270",                                             // embezzlement
        "280",                                             // stolen property
        "290",                                             // destruction/vandalism
      ];
      const sql = ctx.sql;
      const usesVictimTable = /\bsummary_victim_(?:city|state)_monthly\b/i.test(sql);
      if (!usesVictimTable) return false;
      return PROPERTY_CODES.some(code => sql.includes(`'${code}'`));
    },
    message: () =>
      "[SYSTEM: Property crimes (theft, burglary, motor vehicle theft, fraud, vandalism, etc.) must use offense summary tables, NOT victim summary tables. Use summary_state_monthly or summary_city_monthly instead of summary_victim_state_monthly or summary_victim_city_monthly. Victim tables only contain person crimes and will return 0 rows for property offenses.]",
  },
  {
    name: "nibrs-sex-filter-missing-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      // User asks about male/female/sex/gender
      const wantsSex = /\b(male|female|men|women|sex|gender|by sex|by gender)\b/i.test(q);
      if (!wantsSex) return false;
      // SQL uses summary_victim_weapon_circumstance (no sex) instead of the _demo version (has sex)
      const usesOldTable = sql.includes("summary_victim_weapon_circumstance") && !sql.includes("summary_victim_weapon_circumstance_demo");
      if (usesOldTable) return true;
      // Also catch other no-sex tables
      const noSexTables = ["summary_victim_circumstance", "summary_offense_weapon", "summary_offense_location", "summary_offense_hour"];
      const usesNoSexTable = noSexTables.some(t => sql.includes(t));
      const hasSexFilter = /\bsex\b.*=|victim_sex/i.test(sql);
      return usesNoSexTable && !hasSexFilter;
    },
    message: (ctx) => {
      const sql = ctx.sql.toLowerCase();
      if (sql.includes("summary_victim_weapon_circumstance") && !sql.includes("_demo")) {
        return "[SYSTEM: The user asked for a sex/gender breakdown but you used summary_victim_weapon_circumstance which has NO sex column. Use summary_victim_weapon_circumstance_demo instead — it has the same columns PLUS sex, race, and age_group. Add a WHERE sex = 'F' or sex = 'M' filter, or GROUP BY sex for a breakdown.]";
      }
      return "[SYSTEM: The user asked for a male/female breakdown, but the table you chose has NO sex column. The query will return identical numbers regardless of which sex was requested. For weapon+circumstance+sex queries, use summary_victim_weapon_circumstance_demo. For other demographic queries, use summary_victim_demographics. Do NOT silently drop the sex filter.]";
    },
  },
  {
    name: "nibrs-cross-level-join",
    tabs: ["nibrs"],
    match: (ctx) => {
      const citySummary = "(?:summary_victim_city_monthly|summary_city_monthly)";
      const stateSummary = "(?:summary_victim_state_monthly|summary_state_monthly)";
      const cityToState = new RegExp(`\\bFROM\\s+${citySummary}\\b(?:\\s+\\w+)?[\\s\\S]*?\\bJOIN\\s+${stateSummary}\\b`, "i");
      const stateToCity = new RegExp(`\\bFROM\\s+${stateSummary}\\b(?:\\s+\\w+)?[\\s\\S]*?\\bJOIN\\s+${citySummary}\\b`, "i");
      return cityToState.test(ctx.sql) || stateToCity.test(ctx.sql);
    },
    message: () =>
      "[SYSTEM: Your previous query JOINed city-level and state-level summary tables, which produces incorrect results due to row multiplication. For comparisons between a city and a state/national average, use separate subqueries or CTEs — one for the city data and one for the state/national data — then combine them. NEVER JOIN summary_victim_city_monthly with summary_victim_state_monthly directly.]",
  },
  // --- NIBRS: cross-summary-table join to infer missing dimensions ---
  {
    name: "nibrs-cross-summary-join",
    tabs: ["nibrs"],
    match: (ctx) => {
      if (!ctx.sql || !/\bJOIN\b/i.test(ctx.sql)) return false;
      const summaryTables = (ctx.sql.match(/\bsummary_\w+/gi) || [])
        .map(t => t.toLowerCase())
        .filter((t, i, a) => a.indexOf(t) === i);
      if (summaryTables.length < 2) return false;
      // Exempt: city + state level of same dimension (handled by cross-level-join)
      const isCityState = summaryTables.every(t => /monthly/.test(t));
      if (isCityState) return false;
      if (asksDomesticViolenceRate(ctx.question) && /\bsummary_domestic_violence\b/i.test(ctx.sql)) return true;
      return hasDirectSummaryTableJoin(ctx.sql);
    },
    message: (ctx) => asksDomesticViolenceRate(ctx.question)
      ? domesticViolenceRateMessage()
      : "[SYSTEM: Do not join different summary_* tables to infer missing dimensions; that produces incorrect results due to different aggregation grains. Use a single summary table that already contains the requested dimensions, use a pre-built combined table, or set sql to null and explain which dimensions are available separately.]",
    override: (ctx) => asksDomesticViolenceRate(ctx.question)
      ? null
      : "I can't reliably combine data from two different summary tables — joining them would produce incorrect results due to different aggregation grains. I can answer each part separately: for example, I can show victim demographics OR clearance rates, but not both in a single query unless a pre-built combined table exists. Try asking about one dimension at a time, or ask if a specific combination is available.",
  },
  {
    name: "nibrs-offender-summary-count-contract",
    tabs: ["nibrs"],
    match: (ctx) => usesOffenderSummaryComboCount(ctx.sql),
    message: () =>
      "[SYSTEM: summary_offender_demographics is already aggregated with offender_count. Do not count DISTINCT ori/year/ucr_offense_code combinations; that counts reporting agency-offense-year cells, not offenders, incidents, or crimes. Rewrite using SUM(d.offender_count) AS offenders from summary_offender_demographics d, preserving the requested year, state/city/ORI, offense, age/race/sex/ethnicity, and continuous-reporter filters. Group by only the dimensions the user requested.]",
  },
  {
    name: "nibrs-continuous-reporting-required",
    tabs: ["nibrs"],
    match: (ctx) => {
      if (!asksContinuousReportingFilter(ctx.question)) return false;
      if (/\bnibrs_consistent_reporters\b/i.test(ctx.sql)) return false;
      return true;
    },
    message: () =>
      "[SYSTEM: The user asked to restrict the result to continuously/consistently reporting NIBRS agencies, but the SQL does not use the precomputed consistent-reporter range table. Do not return agency metadata or a coverage list. Rewrite the data query using ORI-level tables so the filter is possible: summary_victim_city_monthly or summary_victim_demographics for person-crime victim/offender demographics, summary_offender_demographics for offender demographics, summary_city_monthly for property/society offense counts, and summary_arrestee_demographics for arrests. Use fact_alias.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = [start_year] AND end_year = [end_year]). Do not use nibrs_agency_completeness as the live query filter when nibrs_consistent_reporters is available. Preserve the user's offenses, breakdowns, metric, and year range.]",
  },
  {
    name: "nibrs-consistent-reporter-range-contract",
    tabs: ["nibrs"],
    match: (ctx) => {
      if (!/\bnibrs_consistent_reporters\b/i.test(ctx.sql)) return false;
      const start = requestedStartYear(ctx.question);
      const end = expectedConsistentReporterEndYear(ctx.question);
      if (start !== null && (
        hasBroadConsistentReporterStartOnly(ctx.sql, start) ||
        hasBroadConsistentReporterContainingRange(ctx.sql, start, end)
      )) return true;
      return hasImpossibleCurrentYearConsistentReporterEnd(ctx.sql);
    },
    message: (ctx) => {
      const start = requestedStartYear(ctx.question) ?? "[start_year]";
      const end = expectedConsistentReporterEndYear(ctx.question);
      return `[SYSTEM: The consistent-reporter lookup must use the exact chosen complete-year range from nibrs_consistent_reporters. Use WHERE start_year = ${start} AND end_year = ${end}. Do not use a broad containment predicate such as start_year <= ${start} AND end_year >= ${end}; that selects agencies consistent over longer ranges and changes the denominator/population. Do not require end_year = ${currentCalendarYear()} while the current year is partial; choose agencies that reported all 12 months in every complete requested year, then include current-year months only as partial data with a disclosure.]`;
    },
  },
  {
    name: "nibrs-state-table-with-ori",
    tabs: ["nibrs"],
    match: (ctx) => {
      const stateTableWithOri = /\b(?:FROM|JOIN)\s+(?:summary_victim_state_monthly|summary_state_monthly)\b(?:\s+\w+)?[\s\S]{0,300}\bori\b/i;
      return stateTableWithOri.test(ctx.sql);
    },
    rewrite: (sql) => {
      let fixed = sql.replace(/\bsummary_victim_state_monthly\b/gi, 'summary_victim_city_monthly');
      fixed = fixed.replace(/\bsummary_state_monthly\b/gi, 'summary_city_monthly');
      return fixed !== sql ? fixed : null;
    },
  },
  // --- NIBRS: city question answered with state-level data (no ORI) ---
  {
    name: "nibrs-city-got-state",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql.toLowerCase();
      // SQL uses state-level summary tables without any ORI or city filter
      const usesStateTable = /\bsummary_victim_state_monthly\b/i.test(sql) || /\bsummary_state_monthly\b/i.test(sql);
      if (!usesStateTable) return false;
      const hasOriOrCity = /\bori\b/i.test(sql) || /\bcity\b/i.test(sql);
      if (hasOriOrCity) return false; // Already has city-level filter — nibrs-state-table-with-ori handles this
      // State names that should NOT trigger this guardrail
      const STATE_NAMES_NIBRS = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|district of columbia|united states)\b/i;
      const cityGeos = ctx.geos.filter(g => !STATE_NAMES_NIBRS.test(g));
      // User asked about a specific city/agency/county (not a state)
      const q = ctx.question.toLowerCase();
      const mentionsCity = cityGeos.length > 0 ||
        /\b(police|department|pd|sheriff|agency|county|parish)\b/i.test(q);
      return mentionsCity;
    },
    message: (ctx) => {
      const city = extractPlaceFromQuestion(ctx);
      return `[SYSTEM: The user asked about "${city}" but the SQL queries a state-level summary table with no ORI or city filter — this returns statewide data, not city data. Use the city-level table instead: summary_victim_city_monthly (for person crimes) or summary_city_monthly (for property crimes), filtered by ORI: WHERE ori IN (SELECT ori FROM agencies WHERE city = '${city.toUpperCase()}' AND state = '...' AND population > 0). Do NOT return state-level data when the user asked about a specific city or agency.]`;
    },
  },
  {
    name: "nibrs-national-as-agency",
    tabs: ["nibrs"],
    match: (ctx) => {
      return /\b(city|agency_name)\s*=\s*'(USA|United States|US|National)'/i.test(ctx.sql) ||
        /agencies\s+WHERE.*'(USA|United States|UNITED STATES|National|NATIONAL)'/i.test(ctx.sql) ||
        /\bstate\s*=\s*'(US|USA)'/i.test(ctx.sql);
    },
    message: () =>
      "[SYSTEM: Do NOT look up 'USA', 'United States', or state='US' as a filter. There is no state code 'US'. For national totals, SUM across all states from the state-level summary table (summary_victim_state_monthly for person crimes, summary_state_monthly for property/society crimes) WITHOUT any state filter. Do not filter by ori, city, or state for national data.]",
  },
  {
    name: "nibrs-agencies-join-no-year",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detects JOIN agencies without year condition
      const hasAgenciesJoin = /JOIN\s+agencies\s+(\w+)\s+ON\s+/i.test(sql);
      if (!hasAgenciesJoin) return false;
      // Extract the ON clause for the agencies JOIN
      const joinMatch = sql.match(/JOIN\s+agencies\s+\w+\s+ON\s+([^)]*?)(?:\s+(?:WHERE|GROUP|ORDER|LIMIT|LEFT|RIGHT|INNER|JOIN)|\s*$)/i);
      if (!joinMatch) return false;
      return !/\byear\b/i.test(joinMatch[1]);
    },
    message: () =>
      "[SYSTEM: Your JOIN to the agencies table is missing a year condition. The agencies table has one row per (ori, year) — without matching on year, you will get row multiplication (each summary row repeated for every year the agency exists). Add AND a.year = s.year (or the appropriate year column) to the JOIN ON clause.]",
  },
  {
    name: "nibrs-ranking-by-population",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // Detect: user asks for "top N" or "highest/most" by a crime metric, but the query pre-filters by population
      const asksTopN = (/\btop\s+\d+\b/i.test(q) || /\b(highest|most|greatest|leading)\b/i.test(q)) && /\b(murder|crime|robbery|assault|theft|rape|burglary|offense|victim|homicide|shooting|carjack)\b/i.test(q);
      if (!asksTopN) return false;
      // Check for a subquery or CTE that pre-filters agencies by population instead of ranking by crime count
      // Handles: SELECT ori FROM agencies ... ORDER BY population, SELECT a.ori FROM agencies AS a ... ORDER BY a.population, etc.
      const preFiltersByPop = /SELECT\s+[\w.]*ori\s+FROM\s+agencies[\s\S]*?ORDER\s+BY\s+[\w.]*population\s+DESC\s+LIMIT/i.test(sql);
      return preFiltersByPop;
    },
    message: () =>
      "[SYSTEM: The user asked for the top agencies ranked by a crime metric, but your query pre-filters to the largest agencies by population. This gives 'crime in the N biggest cities', NOT 'cities with the most crime'. Instead, aggregate the crime count for ALL agencies, then ORDER BY the crime metric DESC LIMIT N. Use summary_clearance_city_annual (which has city name pre-joined) or summary_victim_city_monthly with JOIN agencies ON ori+year. Do NOT pre-select agencies by population.]",
  },
  {
    name: "nibrs-agencies-join-no-ori",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect: JOIN agencies on state+year without ori — creates cartesian product
      const usesCityTable = /\bsummary_(?:victim_)?city_monthly\b/i.test(sql);
      // Match: JOIN agencies a, JOIN agencies AS a, LEFT JOIN agencies a, etc.
      const hasAgenciesJoin = /JOIN\s+agencies\b/i.test(sql);
      if (!usesCityTable || !hasAgenciesJoin) return false;
      // Extract ON clause — handle aliases with/without AS, multiline SQL
      // Matches: JOIN agencies a ON ..., JOIN agencies AS a ON ..., JOIN agencies ON ...
      const joinClause = sql.match(/JOIN\s+agencies(?:\s+AS)?\s+\w*\s*ON\s+([\s\S]*?)(?=\s+(?:WHERE|GROUP|ORDER|LIMIT|LEFT|RIGHT|INNER|CROSS|JOIN|HAVING)\b|\s*$)/i);
      if (!joinClause) return false;
      return !/\bori\b/i.test(joinClause[1]);
    },
    message: () =>
      "[SYSTEM: Your JOIN between a city-level summary table and the agencies table matches on state+year but NOT ori. This creates a cartesian product — every summary row gets multiplied by every agency in that state/year, producing wildly inflated and incorrect results. You MUST match on ori: JOIN agencies a ON a.ori = s.ori AND a.year = s.year. Alternatively, for ranking cities by crime counts, you don't need the agencies JOIN at all — use summary_clearance_city_annual which already has city name and population, or use an ORI subquery to get city names.]",
  },
  {
    name: "nibrs-unpaired-city-state-in",
    tabs: ["nibrs"],
    match: (ctx) => hasUnpairedMultiCityStateFilter(ctx.sql),
    message: () =>
      "[SYSTEM: Your multi-city filter uses city IN (...) without pairing each city to its intended state. This can pull same-named cities from the wrong states. Rewrite with explicit city-state pairs: WHERE (city = 'CHICAGO' AND state = 'IL') OR (city = 'LOS ANGELES' AND state = 'CA'), or use a VALUES/CTE table with city and state columns and join on both. Do not use separate city IN (...) and state IN (...) lists for named city comparisons.]",
  },
  {
    name: "nibrs-city-case-sensitivity",
    tabs: ["nibrs"],
    match: (ctx) => {
      // NIBRS cities are ALL CAPS. Detect mixed-case city filters that would return 0 rows.
      // Match city = 'Houston' (mixed case) but NOT city = 'HOUSTON' (correct)
      const cityFilters = ctx.sql.match(/city\s*=\s*'([^']+)'/gi);
      if (!cityFilters) return false;
      return cityFilters.some(f => {
        const val = f.match(/city\s*=\s*'([^']+)'/i)?.[1];
        return val && val !== val.toUpperCase();
      });
    },
    rewrite: (sql) => {
      // Auto-fix: uppercase all city = 'xxx' values
      const fixed = sql.replace(/city\s*=\s*'([^']+)'/gi, (match, city) => {
        return match.replace(city, city.toUpperCase());
      });
      return fixed !== sql ? fixed : null;
    },
  },
  // --- NIBRS: specific drug arrest query using wrong table ---
  // Once summary_drug_arrests exists, the prompt directs Claude there and this won't fire.
  // This is the safety net: hard override blocks execution of the wrong data.
  {
    name: "nibrs-drug-arrest-wrong-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      const specificDrug = /\b(marijuana|cannabis|weed|meth|methamphetamine|cocaine|crack|heroin|fentanyl|opioid|lsd|pcp|ecstasy|mdma|opium|hashish|amphetamine)\b/i.test(q);
      const wantsArrests = /\b(arrest|arrested|arrestee)\b/i.test(q);
      const usesArresteeDemographics = sql.includes("summary_arrestee_demographics");
      const hasDrugOffense = /\b3[5][AB]\b/.test(ctx.sql);
      const usesDrugArrests = sql.includes("summary_drug_arrests");
      return specificDrug && wantsArrests && usesArresteeDemographics && hasDrugOffense && !usesDrugArrests;
    },
    override: (ctx) => {
      const drug = ctx.question.match(/\b(marijuana|cannabis|weed|meth|methamphetamine|cocaine|crack|heroin|fentanyl|opioid|lsd|pcp|ecstasy|mdma|opium|hashish|amphetamine)\b/i)?.[1] || "that drug";
      const drugCap = drug.charAt(0).toUpperCase() + drug.slice(1);
      const offenseType = /35B/.test(ctx.sql) ? "sales" : "possession";
      return `I can't isolate ${drug} arrests specifically — the arrest data groups all drug arrests under a single code (35A for possession, 35B for sales) without distinguishing the drug type. I can show you:\n\n- **Total drug ${offenseType} arrests** (all drugs combined) — ask "drug ${offenseType} arrests"\n- **${drugCap} drug offense counts** broken down by drug type (these are offenses reported to NIBRS, not arrest counts) — ask "${drug} drug offenses"\n\nWould either of those work?`;
    },
  },
  // --- Multi-city ORI subquery with global LIMIT 1 ---
  {
    name: "multi-city-global-limit-ori",
    tabs: ["nibrs", "current", "historical", "shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect: city IN ('A', 'B') inside a subquery with ORDER BY pop_group/population LIMIT 1
      // This picks one ORI total instead of one per city
      const hasMultiCityIn = /city\s+IN\s*\([^)]*,[^)]*\)/i.test(sql);
      if (!hasMultiCityIn) return false;
      // Check for LIMIT 1 in the same subquery as the multi-city IN clause
      const hasGlobalLimit = /city\s+IN\s*\([^)]*\)[\s\S]*?(?:ORDER\s+BY\s+(?:pop_group|population)[^)]*LIMIT\s+1)/i.test(sql);
      return hasGlobalLimit;
    },
    message: () =>
      "[SYSTEM: You used a single ORI subquery with city IN (...) ... LIMIT 1, which selects only one agency across all requested cities. For multi-city comparisons, select one ORI per city. Use separate ORI subqueries per city in CASE WHEN branches, or use a CTE: WITH city_oris AS (SELECT ori, city, state FROM (SELECT ori, city, state, ROW_NUMBER() OVER (PARTITION BY city, state ORDER BY pop_group) AS rn FROM agencies WHERE (city = 'X' AND state = 'XX') OR (city = 'Y' AND state = 'YY') AND year = 2025 AND population > 0) WHERE rn = 1) ... WHERE s.ori IN (SELECT ori FROM city_oris)]",
  },
  {
    name: "city-like-no-state",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect: city/agency LIKE pattern without a state filter in the SAME clause.
      // Catches prefix ('X%'), contains ('%X%'), and suffix ('%X') patterns.
      const likeMatch = sql.match(/(?:city|agency)\s+LIKE\s+'([^']+)'/gi);
      if (!likeMatch) return false;
      // Must have at least one wildcard LIKE (not just LIKE 'exact')
      const hasWildcardLike = likeMatch.some(m => {
        const val = m.match(/LIKE\s+'([^']+)'/i)?.[1];
        return val && val.includes('%');
      });
      if (!hasWildcardLike) return false;
      // Check for state filter in the SAME subquery as the LIKE, not globally
      // Extract the subquery or clause containing the LIKE
      for (const m of likeMatch) {
        const val = m.match(/LIKE\s+'([^']+)'/i)?.[1];
        if (!val || !val.includes('%')) continue;
        // Find the innermost parenthesized clause containing this LIKE
        const likeIdx = sql.indexOf(m);
        // Walk backward to find the opening paren of this subquery
        let depth = 0;
        let clauseStart = 0;
        for (let i = likeIdx; i >= 0; i--) {
          if (sql[i] === ')') depth++;
          if (sql[i] === '(') {
            if (depth === 0) { clauseStart = i; break; }
            depth--;
          }
        }
        // Walk forward to find the closing paren
        depth = 0;
        let clauseEnd = sql.length;
        for (let i = likeIdx; i < sql.length; i++) {
          if (sql[i] === '(') depth++;
          if (sql[i] === ')') {
            if (depth === 0) { clauseEnd = i; break; }
            depth--;
          }
        }
        const clause = sql.slice(clauseStart, clauseEnd);
        // Check if this clause has a state filter
        if (!/\bstate\s*=\s*'[A-Za-z]{2}'/i.test(clause)) return true;
      }
      return false;
    },
    message: (ctx) => {
      const likePattern = ctx.sql.match(/(?:city|agency)\s+LIKE\s+'([^']+)'/i)?.[1] || "the search term";
      return `[SYSTEM: Your query uses a wildcard city/agency LIKE search ('${likePattern}') without a state filter. This can match the wrong city/agency entirely (e.g., 'KINGS%' matches Kingsport, TN instead of Kings County, NY; '%BART%' can match Bartlett, TN instead of Bay Area Rapid Transit in CA). Either add AND state = '[XX]' to narrow the search, or set sql to null and ask the user which state they mean.]`;
    },
  },
  {
    name: "nibrs-offense-code-confusion",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql;

      // "theft" should use 23A-23H range, not just one code
      if (/\b(?:theft|larceny|larcenies)\b/i.test(q) && !/auto|motor|vehicle|car\b/i.test(q)) {
        // Check if only one 23x code is used when the user asked for "theft" generally
        const theftCodes = sql.match(/'23[A-H]'/gi) || [];
        const uniqueCodes = [...new Set(theftCodes.map(c => c.toUpperCase()))];
        if (uniqueCodes.length === 1 && uniqueCodes[0] !== "'23H'") return true; // single subcode, not the catch-all
        if (uniqueCodes.length === 0 && !/23/i.test(sql)) return false; // no theft codes at all (different issue)
      }

      // "carjacking" should use a summary_carjacking_* table — raw offenses+property is wrong (except daily queries)
      if (/\bcarjack/i.test(q) && !/summary_carjacking_/i.test(sql)) return true;

      // "auto theft" / "motor vehicle theft" should be 240, NOT 23F
      if (/\b(auto|motor vehicle|car)\s*theft\b/i.test(q) && sql.includes("'23F'") && !sql.includes("'240'")) return true;

      // "vehicle burglary" / "theft from vehicle" should be 23F, NOT 240
      if (/\b(vehicle burglary|theft from (motor )?vehicle|TFMV)\b/i.test(q) && sql.includes("'240'") && !sql.includes("'23F'")) return true;

      return false;
    },
    message: (ctx) => {
      const q = ctx.question.toLowerCase();
      if (/\bcarjack/i.test(q)) {
        return "[SYSTEM: Carjacking is NOT offense code 240 (that's motor vehicle theft). Use summary_carjacking_monthly for carjacking counts/trends. For demographic breakdowns (race, sex, age, weapon), use summary_carjacking_victim_demographics, summary_carjacking_offender_demographics, or summary_carjacking_arrestee_demographics.]";
      }
      if (/\b(auto|motor vehicle|car)\s*theft\b/i.test(q)) {
        return "[SYSTEM: Auto/motor vehicle theft is offense code 240, NOT 23F. Code 23F is 'Theft From Motor Vehicle' (vehicle burglary), which is different from stealing the vehicle itself.]";
      }
      if (/\b(vehicle burglary|theft from (motor )?vehicle|TFMV)\b/i.test(q)) {
        return "[SYSTEM: Vehicle burglary / theft from motor vehicle is offense code 23F, NOT 240. Code 240 is motor vehicle theft (stealing the whole vehicle).]";
      }
      return "[SYSTEM: 'Theft' or 'larceny' in NIBRS spans codes 23A through 23H. Use the full range IN ('23A','23B','23C','23D','23E','23F','23G','23H') or use '23H' as the catch-all if only shoplifting. Do not use a single subcode when the user asked about theft generally.]";
    },
  },
  {
    name: "historical-ranking-no-type",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detects: ranking/listing queries on historical_agency that don't filter by type
      // Pattern: ORDER BY ... DESC/ASC with LIMIT, using historical_agency_crime, no type filter
      const usesAgencyTable = /\bhistorical_agency(?:_crime)?\b/i.test(sql);
      const hasRanking = /ORDER\s+BY\b/i.test(sql) && /\bLIMIT\b/i.test(sql);
      const hasTypeFilter = /\bha\.type\s*=/i.test(sql) || /\btype\s*=\s*'/i.test(sql);
      // Only fire for ranking queries (ORDER BY + LIMIT) without type filter
      // and where the SELECT returns agency names (it's a listing)
      const selectsAgency = /SELECT[\s\S]*?\bagency\b[\s\S]*?FROM/i.test(sql);
      return usesAgencyTable && hasRanking && selectsAgency && !hasTypeFilter;
    },
    message: () =>
      "Your ranking query on historical_agency doesn't include a type filter. Without AND ha.type = 'city', the results may include state police, university police, and county agencies mixed in with cities. Add AND ha.type = 'city' to the WHERE clause (or 'county' if the user asked about counties).",
  },
  {
    name: "nibrs-weapon-group-by-code",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect: CASE on weapon_type with GROUP BY weapon_type (should group by alias)
      const hasCaseWeapon = /CASE[\s\S]+weapon_type[\s\S]+END\s+AS\s+(\w+)/i.test(sql);
      const groupsByRawCode = /GROUP\s+BY[\s\S]*?\bweapon_type\b/i.test(sql);
      return hasCaseWeapon && groupsByRawCode;
    },
    rewrite: (sql) => {
      // Extract the alias from CASE...END AS <alias>
      const aliasMatch = sql.match(/CASE[\s\S]+weapon_type[\s\S]+END\s+AS\s+(\w+)/i);
      if (!aliasMatch) return null;
      const alias = aliasMatch[1];
      if (/^weapon_type$/i.test(alias)) {
        const fixed = sql
          .replace(/\bEND\s+AS\s+weapon_type\b/i, "END AS weapon_group")
          .replace(/\bGROUP\s+BY\s+(?:\w+\.)?weapon_type\b/i, "GROUP BY weapon_group")
          .replace(/\bORDER\s+BY\s+(?:\w+\.)?weapon_type\b/i, "ORDER BY weapon_group");
        return fixed !== sql ? fixed : null;
      }
      // Replace GROUP BY ...weapon_type... with the alias
      const fixed = sql.replace(
        /(GROUP\s+BY\s+(?:[\s\S]*?,\s*)?)(?:\w+\.)?weapon_type\b/i,
        `$1${alias}`
      );
      return fixed !== sql ? fixed : null;
    },
  },
  {
    name: "nibrs-bare-assault-partial-code-set",
    tabs: ["nibrs"],
    match: (ctx) => asksBareAssault(ctx.question) && usesPartialAssaultCodeSet(ctx.sql),
    message: () =>
      "[SYSTEM: The user asked for assault/assaults without choosing a subtype. Do not silently return only aggravated assault or only aggravated+simple assault. Either ask for clarification, or include all three NIBRS assault codes and disclose the definition: 13A aggravated assault, 13B simple assault, and 13C intimidation. If you run the query, use ucr_offense_code IN ('13A','13B','13C').]",
  },
  // --- Historical: staffing query without zero filter or with future years ---
  {
    name: "historical-staffing-no-filter",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      const usesStaffing = /\bhistorical_staffing\b/i.test(sql);
      if (!usesStaffing) return false;
      return !/all_total\s*>\s*0/i.test(sql) && !/officer_total\s*>\s*0/i.test(sql);
    },
    message: () =>
      "Your staffing query does not filter out years with no data. In historical_staffing, a value of 0 means the agency did not report — NOT that they had zero officers. Add WHERE all_total > 0 (or AND all_total > 0) to exclude non-reporting years.",
  },
  {
    name: "historical-officers-per-100k-unit",
    tabs: ["historical"],
    match: (ctx) => {
      if (!asksOfficersPer100k(ctx.question)) return false;
      if (!/\bhistorical_staffing\b/i.test(ctx.sql)) return false;
      return /\bofficer_total\s*\*\s*1000(?:\.0)?\b/i.test(ctx.sql) ||
        /\b1000(?:\.0)?\s*\*\s*(?:\w+\.)?officer_total\b/i.test(ctx.sql) ||
        /\bofficers_per_1k\b/i.test(ctx.sql);
    },
    rewrite: (sql) => {
      let fixed = sql
        .replace(/\bofficer_total\s*\*\s*1000(?:\.0)?\b/gi, "officer_total * 100000.0")
        .replace(/\b((?:\w+\.)?officer_total)\s*\*\s*1000(?:\.0)?\b/gi, "$1 * 100000.0")
        .replace(/\b1000(?:\.0)?\s*\*\s*((?:\w+\.)?officer_total)\b/gi, "100000.0 * $1")
        .replace(/\bofficers_per_1k\b/gi, "officers_per_100k");
      return fixed !== sql ? fixed : null;
    },
  },
  {
    name: "historical-violent-rate-per-100k-alias",
    tabs: ["historical"],
    match: (ctx) => {
      if (!asksViolentCrimePer100k(ctx.question)) return false;
      if (!/\bhistorical_agency_crime\b/i.test(ctx.sql)) return false;
      return /\bAS\s+violent_rate\b/i.test(ctx.sql) || /\bviolent_rate\b/i.test(ctx.sql);
    },
    rewrite: (sql) => {
      const fixed = sql.replace(/\bviolent_rate\b/gi, "violent_crime_rate_per_100k");
      return fixed !== sql ? fixed : null;
    },
  },
  {
    name: "historical-state-national-aggregate-columns",
    tabs: ["historical"],
    match: (ctx) => {
      if (!/\bhistorical_state_national\b/i.test(ctx.sql)) return false;
      return /\bviolent_rate\b/i.test(ctx.sql) ||
        /\bproperty_rate\b/i.test(ctx.sql) ||
        /\bassault_rate\b/i.test(ctx.sql) ||
        /(?<!aggravated_)\bassault\b/i.test(ctx.sql) ||
        /\bmotor_vehicle_theft(?:_rate)?\b/i.test(ctx.sql);
    },
    rewrite: (sql) => {
      let fixed = sql
        .replace(/\bviolent_rate\b/gi, "(murder_rate + rape_rate + robbery_rate + aggravated_assault_rate)")
        .replace(/\bproperty_rate\b/gi, "(burglary_rate + theft_rate + auto_theft_rate)")
        .replace(/\bassault_rate\b/gi, "aggravated_assault_rate")
        .replace(/(?<!aggravated_)\bassault\b/gi, "aggravated_assault")
        .replace(/\bmotor_vehicle_theft_rate\b/gi, "auto_theft_rate")
        .replace(/\bmotor_vehicle_theft\b/gi, "auto_theft");
      return fixed !== sql ? fixed : null;
    },
  },
  {
    name: "historical-state-pivot-missing-group-by",
    tabs: ["historical"],
    match: (ctx) => hasHistoricalStatePivotWithoutYearGroup(ctx.sql),
    message: () =>
      "[SYSTEM: The user asked for a multi-state historical comparison, but the SQL pivots states into columns without GROUP BY year. That returns sparse state-year rows instead of one comparison row per year. Return one row per year: wrap each state CASE expression in an aggregate such as MAX(CASE WHEN state = 'California' THEN murder_rate END) AS california for rates, or SUM(CASE WHEN state = 'California' THEN murder END) AS california for counts. Add GROUP BY year and ORDER BY year. Do not return one row per state-year.]",
  },
  // Detect single-agency historical time series without gap-fill CTE
  // --- Historical: hardcoded ORI code instead of name lookup ---
  {
    name: "historical-hardcoded-ori",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect ori = 'XX...' without joining historical_agency by name
      const hasHardcodedOri = /\bori\s*=\s*'[A-Z]{2}\d+'/i.test(sql);
      const joinsAgencyByName = /historical_agency\s+\w+[\s\S]*?\.agency\s*=/i.test(sql);
      return hasHardcodedOri && !joinsAgencyByName;
    },
    message: () =>
      "[SYSTEM: You hardcoded an ORI code in the SQL. NEVER guess ORI codes — they are often wrong. Always look up agencies by name: JOIN historical_agency ha ... WHERE ha.agency = '[name]' AND ha.state = '[st]'. Then use the ORI from the join.]",
  },
  {
    name: "historical-missing-gap-fill",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Only fire for single-agency queries over a year range
      const usesAgencyData = /\bhistorical_agency_crime\b|\bhistorical_staffing\b|\bhistorical_agency_clearance\b/i.test(sql);
      const hasYearRange = /year\s*(>=|BETWEEN)/i.test(sql) || /ORDER\s+BY.*year/i.test(sql);
      const hasGapFill = /WITH\s+(years|all_years|yr)/i.test(sql) || /UNION\s+ALL\s+SELECT\s+year\s*\+\s*1/i.test(sql);
      const isSingleAgency = /agency\s*=\s*'/i.test(sql) && !/GROUP\s+BY.*agency/i.test(sql);
      return usesAgencyData && hasYearRange && isSingleAgency && !hasGapFill;
    },
    message: () =>
      "Your query retrieves historical data for a single agency over a year range but does not use a recursive CTE to fill missing years. Many agencies have gaps in reporting — without gap-fill, the chart will misleadingly connect data across missing years. Use: WITH years AS (SELECT <start> AS year UNION ALL SELECT year + 1 FROM years WHERE year < <end>) SELECT y.year, ... FROM years y LEFT JOIN ... This ensures missing years appear as NULL/gaps in the chart.",
  },
  // NOTE: historical-staffing-left-join-nulls guardrail REMOVED.
  // LEFT JOIN with a years CTE is the CORRECT pattern for staffing queries —
  // it produces NULL values for missing years, which the chart renders as gaps.
  // The old guardrail was incorrectly telling the model to use INNER JOIN,
  // which silently skips missing years instead of showing gaps.
  {
    name: "historical-ne-gu-state-codes",
    tabs: ["historical"],
    match: (ctx) => /\b(?:\w+\.)?state\s*=\s*'(NE|GU)'/i.test(ctx.sql),
    rewrite: (sql) => {
      let fixed = sql.replace(/\b((?:\w+\.)?state)\s*=\s*'NE'/gi, "$1 = 'nb'");
      fixed = fixed.replace(/\b((?:\w+\.)?state)\s*=\s*'GU'/gi, "$1 = 'gm'");
      return fixed !== sql ? fixed : null;
    },
  },
  {
    name: "nibrs-ne-gu-state-codes",
    tabs: ["nibrs"],
    match: (ctx) => /state\s*=\s*'(NE|GU)'/i.test(ctx.sql),
    rewrite: (sql) => {
      let fixed = sql.replace(/\b((?:\w+\.)?state)\s*=\s*'NE'/gi, "$1 IN ('NE','NB')");
      fixed = fixed.replace(/\b((?:\w+\.)?state)\s*=\s*'GU'/gi, "$1 IN ('GU','GM')");
      return fixed !== sql ? fixed : null;
    },
  },

  // --- Agency lookup instead of crime data ---
  {
    name: "agency-lookup-not-crime-data",
    tabs: ["current", "historical", "nibrs"],
    match: (ctx) => {
      const sql = ctx.sql.toLowerCase();
      // SQL only queries the agencies/lookup table, never actual crime data
      const onlyAgencyTable =
        (sql.includes("from agencies") || sql.includes("from historical_agency")) &&
        !sql.includes("agency_monthly") &&
        !sql.includes("agency_crime") &&
        !sql.includes("national_monthly") &&
        !sql.includes("state_national") &&
        !sql.includes("staffing") &&
        !sql.includes("clearance") &&
        // NIBRS summary/data tables
        !sql.includes("summary_") &&
        !sql.includes("incidents") &&
        !sql.includes("offenses") &&
        !sql.includes("victims") &&
        !sql.includes("offenders") &&
        !sql.includes("arrestees") &&
        !sql.includes("property");
      if (!onlyAgencyTable) return false;
      // Only fire if the user asked about crime data, not just "what agencies do you have"
      const asksCrimeData = /\b(crime|trend|murder|homicide|robbery|assault|burglary|theft|rate|stats|statistics|data|offenses?|violent|property|arrest|clearance|cleared)\b/i.test(ctx.question);
      return asksCrimeData;
    },
    message: (ctx) => {
      const geo = extractPlaceFromQuestion(ctx);
      if (ctx.tab === "nibrs") {
        return `[SYSTEM: You ran an agency lookup query but the user asked for actual crime data. Query a summary table instead — use summary_victim_city_monthly (person crimes) or summary_city_monthly (property crimes) filtered by ORI: WHERE ori IN (SELECT ori FROM agencies WHERE city = '${geo.toUpperCase()}' AND state = '...'). Do NOT return agency metadata when the user wants crime statistics.]`;
      }
      return `You ran an agency lookup query but the user asked for actual crime data. Query the crime data table directly — for Current Trends use agency_monthly WHERE agency = '${geo}'. For Historical use historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = '${geo}' AND ha.type = 'city'. Do NOT return agency metadata when the user wants crime statistics.`;
    },
  },

  // --- Bare "Washington" ambiguity — must not silently assume DC or state ---
  {
    name: "washington-ambiguity",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question;
      // Bare "Washington" without DC/state/district qualifier
      const hasWashington = /\bWashington\b/i.test(q);
      if (!hasWashington) return false;
      // Explicit DC: "Washington, DC", "Washington DC", "DC", "District of Columbia"
      const isExplicitDC = /\bWashington\s*,?\s*D\.?C\.?|Washington\s+DC\b|\bD\.?C\.?\b|District\s+of\s+Columbia/i.test(q);
      // Explicit state: "Washington state", "state of Washington", "WA" as state abbrev
      const isExplicitState =
        /\bWashington\s+[Ss]tate\b/i.test(q) ||
        /\bstate\s+of\s+Washington\b/i.test(q) ||
        /\bWA\b/.test(q); // uppercase-only WA = state abbreviation
      // If neither explicit, it's ambiguous
      return !isExplicitDC && !isExplicitState;
    },
    override: (ctx) =>
      `"Washington" is ambiguous — did you mean **Washington, D.C.** (the city) or **Washington state**? Please clarify so I can query the right geography.`,
  },

  // --- Historical: city question answered with state-level data ---
  {
    name: "historical-city-got-state",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql.toLowerCase();
      // SQL uses the state_national table (not agency-level)
      const usesStateTable = sql.includes("historical_state_national");
      if (!usesStateTable) return false;
      // State names that should NOT trigger this guardrail
      const STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|district of columbia|united states)\b/i;
      // Filter geos to exclude state names
      const cityGeos = ctx.geos.filter(g => !STATE_NAMES.test(g));
      // Explicit city name allowlist (not states)
      const q = ctx.question.toLowerCase();
      const CITY_NAMES = /\b(denver|houston|chicago|dallas|phoenix|seattle|portland|miami|atlanta|boston|detroit|memphis|nashville|austin|charlotte|columbus|cleveland|pittsburgh|cincinnati|orlando|tampa|minneapolis|milwaukee|new orleans|omaha|raleigh|oakland|sacramento|fresno|tucson|albuquerque|el paso|san antonio|san diego|san francisco|los angeles|philadelphia|baltimore|richmond|norfolk|durham|stockton|anchorage|honolulu|arlington|lubbock|garland|madison|reno|glendale|hialeah|chesapeake|south bend|springfield|jacksonville|kansas city|st\.?\s*louis|baton rouge)\b/i;
      const asksCityByName = cityGeos.length > 0 || CITY_NAMES.test(q);
      return asksCityByName;
    },
    message: (ctx) => {
      const city = extractPlaceFromQuestion(ctx);
      return `The user asked about "${city}" but the SQL queries historical_state_national which has state-level data, not city-level. Use historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = '${city}' AND ha.type = 'city' to get city-level data. Only fall back to state-level if the user explicitly asks for a state.`;
    },
  },

  // --- Historical: county/parish question answered with state-level data ---
  {
    name: "historical-county-got-state",
    tabs: ["historical"],
    match: (ctx) => {
      if (isCountywideGeographyQuestion(ctx.question)) return false;
      const sql = ctx.sql.toLowerCase();
      const q = ctx.question;
      // SQL uses the state_national table
      if (!sql.includes("historical_state_national")) return false;
      // User asked about a specific county or parish
      const countyMatch = q.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish|Borough)\b/i);
      return !!countyMatch;
    },
    message: (ctx) => {
      const countyMatch = ctx.question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish|Borough)\b/i);
      const countyName = countyMatch ? `${countyMatch[1]} ${countyMatch[2]}` : "the requested county";
      return `The user asked about "${countyName}" but the SQL queries historical_state_national which has state-level data, not county-level. Use historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = '${countyName}' AND ha.type = 'county' to get county-level data. Only fall back to state-level if the user explicitly asks for a state.`;
    },
  },

  // ── SHR Guardrails ──────────────────────────────────────────────────

  {
    // --- Historical: county/parish name stripped from agency filter ---
    name: "historical-county-name-stripped",
    tabs: ["historical"],
    match: (ctx) => {
      if (isCountywideGeographyQuestion(ctx.question)) return false;
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      // User said "X County" or "X Parish" but SQL has agency = 'X' without "County"/"Parish"
      // Match 1-3 capitalized words before County/Parish: "Alameda County", "Anne Arundel County", "East Baton Rouge Parish"
      const countyMatch = ctx.question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish)\b/);
      if (!countyMatch) return false;
      const placeName = countyMatch[1].trim();
      const suffix = countyMatch[2]; // "County" or "Parish"
      // Check if SQL has agency = 'PlaceName' without the suffix
      const hasStripped = new RegExp(`agency\\s*=\\s*'${placeName}'`, "i").test(sql) &&
        !new RegExp(`agency\\s*=\\s*'${placeName}\\s+${suffix}'`, "i").test(sql);
      return hasStripped;
    },
    rewrite: (sql, ctx) => {
      if (isCountywideGeographyQuestion(ctx.question)) return null;
      const countyMatch = ctx.question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish)\b/);
      if (!countyMatch) return null;
      const placeName = countyMatch[1].trim();
      const suffix = countyMatch[2];
      // Replace agency = 'PlaceName' with agency = 'PlaceName County/Parish'
      const pattern = new RegExp(`(agency\\s*=\\s*')${placeName}'`, "gi");
      const fixed = sql.replace(pattern, `$1${placeName} ${suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase()}'`);
      return fixed !== sql ? fixed : null;
    },
    message: (ctx) => {
      const countyMatch = ctx.question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish)\b/);
      const fullName = countyMatch ? `${countyMatch[1].trim()} ${countyMatch[2]}` : "the county/parish";
      return `[SYSTEM: The user asked about "${fullName}" but the SQL searches for the place name without "County"/"Parish". In the Historical database, county agencies are stored with the full name (e.g., 'Alameda County', 'Jefferson Parish'). Use agency = '${fullName}' AND type = 'county'.]`;
    },
  },
  {
    // --- Historical: Parish question but SQL uses type = 'city' ---
    name: "historical-parish-type-city",
    tabs: ["historical"],
    match: (ctx) => {
      if (isCountywideGeographyQuestion(ctx.question)) return false;
      return /\bparish\b/i.test(ctx.question) && /type\s*=\s*'city'/i.test(ctx.sql);
    },
    rewrite: (sql) => sql.replace(/type\s*=\s*'city'/gi, "type = 'county'"),
    message: () =>
      "[SYSTEM: The user asked about a Louisiana Parish, which is a county-type agency. Your SQL uses type = 'city' — change it to type = 'county'.]",
  },
  {
    name: "shr-victim-count-default",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Fires if counting from incidents without joining victims
      const countsIncidents = /COUNT\s*\(\s*\*\s*\)\s/i.test(sql) || /COUNT\s*\(\s*i\./i.test(sql);
      const joinsVictims = /JOIN\s+victims\b/i.test(sql);
      const asksForIncidents = /\bincident/i.test(ctx.question);
      return countsIncidents && !joinsVictims && !asksForIncidents;
    },
    message: () =>
      "[SYSTEM: SHR queries should count VICTIMS by default, not incidents. JOIN the victims table: FROM incidents i JOIN victims v ON v.incident_id = i.id, then COUNT(*) counts victims. Only count incidents if the user specifically asked for incidents.]",
  },
  {
    name: "shr-homicide-type-missing",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      const asksMurder = /\b(murder|homicide|homicides|killing|killings)\b/i.test(q) &&
        !/\b(manslaughter|negligent|justifiable|all homicides|all homicide types)\b/i.test(q);
      const touchesIncidents = /\bFROM\s+incidents\b/i.test(sql) || /\bJOIN\s+incidents\b/i.test(sql);
      const hasTypeFilter = /\b(?:\w+\.)?homicide_type\s*(?:=|IN)\s*(?:\([^)]*)?'Murder'/i.test(sql);
      return asksMurder && touchesIncidents && !hasTypeFilter;
    },
    message: () =>
      "[SYSTEM: When the user asks about murders/homicides in SHR, filter incidents with homicide_type = 'Murder' unless they explicitly ask for manslaughter or all homicide types. SHR also contains manslaughter records; without the filter the result mixes categories. The explanation should state that the count is murder/nonnegligent manslaughter only.]",
  },
  {
    name: "shr-offender-null-filter",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // If querying offender demographics without null filter
      const usesOffender = /\boff_race\b|\boff_sex\b|\boff_age/i.test(sql);
      const hasNullFilter = /off_\w+\s+IS\s+NOT\s+NULL/i.test(sql) || /off_race\s*!=\s*'Unknown'/i.test(sql);
      return usesOffender && !hasNullFilter;
    },
    message: () =>
      "[SYSTEM: You're querying offender demographics but haven't filtered out NULL/Unknown offenders. About 40% of SHR incidents have unknown offender data. Add WHERE off_race IS NOT NULL (or off_sex IS NOT NULL) to exclude cases where offender information was not recorded. IMPORTANT: Having offender demographics recorded does NOT mean the case was solved or cleared — this dataset does not measure clearances. Note that results reflect cases where offender information was recorded, not necessarily solved cases.]",
  },
  {
    name: "shr-group-column-required",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // If using detailed columns when group columns should be used
      // NOTE: relationship is EXCLUDED — relationship_group is broken (Girlfriend/Boyfriend = 'Known' not 'Family')
      // The prompt instructs the model to ALWAYS use CASE WHEN on detailed relationship column
      const usesDetailWeapon = /\bi\.weapon\b/i.test(sql) && !/weapon_group/i.test(sql) && !/specific|detail|exact/i.test(q);
      const usesDetailCirc = /\bi\.circumstance\b/i.test(sql) && !/circumstance_group/i.test(sql) && !/specific|detail|exact/i.test(q);
      return usesDetailWeapon || usesDetailCirc;
    },
    message: () =>
      "[SYSTEM: Use the _group columns (weapon_group, circumstance_group) instead of the detailed columns. The detailed columns have hundreds of values and produce messy results. Only use the detailed columns if the user explicitly asks for specific/detailed breakdowns. NOTE: For relationship, ALWAYS use CASE WHEN on the detailed relationship column to build custom groups (Intimate Partner, Other Family, etc.) — do NOT use relationship_group.]",
  },
  {
    name: "shr-relationship-group-used",
    tabs: ["shr"],
    match: (ctx) => {
      // Catch any use of relationship_group and redirect to CASE WHEN on detailed relationship
      return /relationship_group/i.test(ctx.sql);
    },
    message: () =>
      "[SYSTEM: Do NOT use relationship_group — it misclassifies Girlfriend/Boyfriend as 'Known' instead of intimate partners. Use a CASE WHEN on the detailed relationship column instead: CASE WHEN i.relationship IN ('Wife','Husband','Common-Law Wife','Common-Law Husband','Girlfriend','Boyfriend','Ex-Wife','Ex-Husband','Homosexual Relationship') THEN 'Intimate Partner' WHEN i.relationship IN ('Mother','Father','Son','Daughter','Brother','Sister','In-Law','Stepfather','Stepmother','Stepson','Stepdaughter','Other Family') THEN 'Other Family' WHEN i.relationship IN ('Acquaintance','Friend','Neighbor','Other Known','Employer','Employee') THEN 'Other Known' WHEN i.relationship = 'Stranger' THEN 'Stranger' ELSE 'Unknown' END AS relationship_category. NOTE: The relationship column stores the VICTIM's role — include BOTH gendered forms (Wife AND Husband, Girlfriend AND Boyfriend, etc.) in the Intimate Partner group.]",
  },
  {
    name: "nibrs-county-in-city-query",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // Detect city-level queries that join agencies but don't filter agency_type = 'City'
      const joinAgencies = /\bagencies\b/i.test(sql) && /\bcity\b/i.test(sql);
      const hasGroupBy = /GROUP\s+BY.*\bcity\b/i.test(sql);
      const filtersAgencyType = /agency_type\s*=\s*'City'/i.test(sql);
      const excludesCounty = filtersAgencyType ||
                              /pop_group\s+NOT\s+LIKE\s+'[89]%'/i.test(sql) ||
                              /pop_group\s+LIKE\s+'[1-7]%'/i.test(sql) ||
                              /pop_group\s+LIKE\s+'1%'/i.test(sql);
      const isCityQuery = /\bcit(y|ies)\b/i.test(q);
      return joinAgencies && hasGroupBy && !excludesCounty && isCityQuery;
    },
    message: () =>
      "[SYSTEM: County sheriff agencies share the same city name as city PDs in the agencies table (e.g., Harris County SO has city='HOUSTON'). Add: AND a.agency_type = 'City' AND a.population > 0 AND a.city != '' to exclude county agencies, sub-agencies, and agencies with blank city names from city rankings.]",
  },
  // --- NIBRS: any city filter in agencies subquery without agency_type (auto-fix) ---
  {
    name: "nibrs-city-no-agency-type",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect: any reference to agencies table with a city = 'X' filter but no agency_type or pop_group
      const hasCityOnAgencies = /\bagencies\b/i.test(sql) && /\bcity\s*=\s*'[A-Z]/i.test(sql);
      if (!hasCityOnAgencies) return false;
      if (/agency_type\s*=/i.test(sql)) return false;
      if (/pop_group\s+LIKE\s+'[1-7]%'/i.test(sql)) return false;
      if (/ORDER\s+BY\s+pop(?:ulation|_group).*LIMIT\s+1/i.test(sql)) return false;
      if (/\bcounty\b|\bsheriff\b|\bparish\b/i.test(ctx.question)) return false;
      return true;
    },
    message: (ctx) => {
      const cityMatch = ctx.sql.match(/city\s*=\s*'([A-Z][A-Z ]+)'/i);
      const city = cityMatch ? cityMatch[1] : "the city";
      const stateMatch = ctx.sql.match(/state\s*=\s*'([A-Z]{2})'/i);
      const state = stateMatch ? stateMatch[1] : "??";
      const yearMatch = ctx.sql.match(/\byear\s*(?:=|>=|BETWEEN\s+)\s*(20\d{2})\b/);
      const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());
      return `[SYSTEM: Your query filters by city = '${city}' but does not isolate the primary city police department. Multiple agencies share the same city name (city PD, county sheriff, campus police, etc.). Unless the user asked for a specific non-city agency (university police, transit, airport, sheriff), select the primary city PD: ori = (SELECT ori FROM agencies WHERE city = '${city}' AND state = '${state}' AND agency_type = 'City' AND year = ${year} AND population > 0 ORDER BY population DESC LIMIT 1). If the user named a specific agency (e.g., "Portland Community College police"), look it up by name instead.]`;
    },
  },
  {
    name: "nibrs-ambiguous-city-no-state",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect city filter in agencies subquery without state filter
      const cityMatch = sql.match(/city\s*=\s*'([A-Z][A-Z ]+)'/i);
      if (!cityMatch) return false;
      const city = cityMatch[1].toUpperCase();
      const ambiguous = [
        "SPRINGFIELD", "PORTLAND", "COLUMBIA", "JACKSON", "COLUMBUS",
        "CLEVELAND", "RICHMOND", "MEMPHIS", "ARLINGTON", "ALBANY",
        "FAYETTEVILLE", "KANSAS CITY", "GREENVILLE", "HAMILTON",
        "JACKSONVILLE", "FRANKLIN", "CLINTON", "MARION", "CHESTER",
        "BURLINGTON", "BRISTOL",
      ];
      if (!ambiguous.includes(city)) return false;
      // Check if state is already filtered nearby
      const hasState = /state\s*=\s*'[A-Z]{2}'/i.test(sql);
      return !hasState;
    },
    message: (ctx) => {
      const cityMatch = ctx.sql.match(/city\s*=\s*'([A-Z][A-Z ]+)'/i);
      const city = cityMatch ? cityMatch[1] : "this city";
      return `[SYSTEM: "${city}" exists in multiple states. You MUST set sql to null and ask the user which state they mean. Do NOT assume a state — different Richmonds, Springfields, etc. have very different crime data. Return: {"sql": null, "explanation": "Which ${city} did you mean? Please specify the state (e.g., ${city}, VA).", "chartHint": "none", "xAxis": "", "yAxis": "", "title": ""}]`;
    },
  },
  {
    name: "shr-aggregate-in-where",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect COUNT/SUM in WHERE clause (should be in HAVING)
      const whereMatch = sql.match(/WHERE[\s\S]+?(?:GROUP\s+BY|ORDER\s+BY|LIMIT|$)/i);
      if (!whereMatch) return false;
      return /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(whereMatch[0]) && !/HAVING/i.test(whereMatch[0]);
    },
    message: () =>
      "[SYSTEM: You used an aggregate function (COUNT, SUM, etc.) in a WHERE clause. Aggregate functions cannot be used in WHERE — use HAVING instead. WHERE filters rows before grouping, HAVING filters after.]",
  },
  // --- SHR: OR-precedence bug in multi-agency queries ---
  {
    name: "shr-or-precedence",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect pattern: (agency=X AND state=Y) OR (agency=X AND state=Y) AND homicide_type/year
      // without outer parentheses around the OR group
      const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:GROUP\s+BY|ORDER\s+BY|LIMIT|$)/i);
      if (!whereMatch) return false;
      const whereClause = whereMatch[1];
      // Has multiple OR branches AND a trailing AND that isn't inside the last OR branch
      const orCount = (whereClause.match(/\)\s*OR\s*\(/gi) || []).length;
      if (orCount < 1) return false;
      // Check if the last AND clause (homicide_type, year) is outside parentheses
      // Pattern: `) AND i.homicide_type` or `) AND i.year` without outer wrapping parens
      return /\)\s+AND\s+i\.(homicide_type|year)\b/i.test(whereClause) &&
        !/\(\s*\([\s\S]*\)\s*OR\s*\([\s\S]*\)\s*\)\s+AND/i.test(whereClause);
    },
    message: () =>
      "[SYSTEM: SQL has OR-precedence bug. When combining multiple agency conditions with OR, you MUST wrap ALL OR branches in outer parentheses before AND-ing with other filters. Wrong: `WHERE (a=1) OR (a=2) AND b=3` — the AND only applies to the last branch. Right: `WHERE ((a=1) OR (a=2)) AND b=3`.]",
  },
  // --- SHR: city query without agency_type filter for ambiguous names ---
  {
    name: "shr-city-no-type",
    tabs: ["shr"],
    match: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      if (sqlLower.includes("agency_type")) return false;
      const ambiguous = [
        "los angeles", "jacksonville", "nashville", "indianapolis",
        "baltimore", "houston", "san diego", "sacramento",
        "kansas city", "richmond", "el paso",
      ];
      return ambiguous.some((c) => sqlLower.includes(`'${c}'`));
    },
    message: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      const ambiguous = [
        "los angeles", "jacksonville", "nashville", "indianapolis",
        "baltimore", "houston", "san diego", "sacramento",
        "kansas city", "richmond", "el paso",
      ];
      const mentioned = ambiguous.filter((c) => sqlLower.includes(`'${c}'`));
      return `[SYSTEM: Query includes ${mentioned.join(", ")} which have both City police and County sheriff agencies with the same name. Add AND agency_type = 'City' to filter to the city police department only.]`;
    },
  },
  // --- SHR: county/parish agency exact match (inconsistent naming) ---
  {
    name: "shr-county-agency-name",
    tabs: ["shr"],
    match: (ctx) => {
      if (isCountywideGeographyQuestion(ctx.question)) return false;
      const q = ctx.question.toLowerCase();
      // User asks about a county/parish/sheriff agency
      const isCountyQuestion = /\b(county|parish|sheriff)\b/i.test(ctx.question);
      if (!isCountyQuestion) return false;
      // SQL uses exact agency match with County/Parish/Sheriff suffix
      return /agency\s*=\s*'[^']*\b(County|Parish|Sheriff)\b[^']*'/i.test(ctx.sql);
    },
    message: (ctx) => {
      const nameMatch = ctx.sql.match(/agency\s*=\s*'([^']*)\b(County|Parish|Sheriff)\b[^']*'/i);
      const place = nameMatch ? nameMatch[1].trim() : "the agency";
      return `[SYSTEM: SHR agency names are inconsistent across years — the same agency may appear as "${place}", "${place} County", "${place} County Sp", "UPPER CASE" variants, etc. Use LIKE matching instead: agency LIKE '%${place}%' AND state = '...' AND agency_type = 'County'. Note: This returns agency-level data (what that specific agency reported), not countywide geographic totals.]`;
    },
  },
  // ── Hard Override Guardrails (2026-06-02) ────────────────────────────
  // These return deterministic responses — no model retry.

  // #1: Gang → Felony Type mislabel (retry/rewrite, not override)
  {
    name: "shr-gang-felony-mislabel",
    tabs: ["shr"],
    match: (ctx) => /\bgang/i.test(ctx.question) && /circumstance_group\s*=\s*'Felony Type'/i.test(ctx.sql),
    message: () =>
      "[SYSTEM: You used circumstance_group = 'Felony Type' for a gang query. Felony Type means homicides during felonies (robbery, burglary, narcotics) — NOT gang activity. Use circumstance IN ('Gangland Killings', 'Juvenile Gang Killings') instead. Note in your explanation that these are narrowly defined FBI categories and likely undercount gang-related violence.]",
    rewrite: (sql) => {
      return sql.replace(
        /circumstance_group\s*=\s*'Felony Type'/gi,
        "i.circumstance IN ('Gangland Killings', 'Juvenile Gang Killings')"
      );
    },
  },

  // #2: SHR SUM(population) bad denominator
  {
    name: "shr-sum-population",
    tabs: ["shr"],
    match: (ctx) => {
      if (/\bstate_population\b/i.test(ctx.sql)) return false;
      return /SUM\s*\(\s*(?:COALESCE\s*\(\s*)?(?:\w+\.)?population/i.test(ctx.sql);
    },
    // Single-agency: auto-fix to AVG
    rewrite: (sql) => {
      // Single-agency = has agency = 'X' filter, GROUP BY may include year but not multiple agencies
      const hasAgencyFilter = /agency\s*=\s*'[^']+'/i.test(sql);
      const groupsByMultipleAgencies = /GROUP\s+BY\s+[^)]*\b(agency|state_name|i\.state)\b/i.test(sql) &&
        !/GROUP\s+BY\s+[^)]*\bagency\b[^,)]*$/i.test(sql); // GROUP BY agency alone is single-agency per-year
      const isSingleAgency = hasAgencyFilter && !groupsByMultipleAgencies;
      if (isSingleAgency) {
        return sql
          .replace(/SUM\s*\(\s*COALESCE\s*\(\s*((?:\w+\.)?population)\s*,\s*\d+\s*\)\s*\)/gi, "AVG($1)")
          .replace(/SUM\s*\(\s*((?:\w+\.)?population)\s*\)/gi, "AVG($1)");
      }
      return null;
    },
    // Multi-agency: hard override
    override: (ctx) => {
      const hasAgencyFilter = /agency\s*=\s*'[^']+'/i.test(ctx.sql);
      const groupsByMultipleAgencies = /GROUP\s+BY\s+[^)]*\b(agency|state_name|i\.state)\b/i.test(ctx.sql) &&
        !/GROUP\s+BY\s+[^)]*\bagency\b[^,)]*$/i.test(ctx.sql);
      const isSingleAgency = hasAgencyFilter && !groupsByMultipleAgencies;
      if (isSingleAgency) return null; // rewrite handles it
      return "SHR population data is per-agency and per-incident — summing it across multiple agencies produces unreliable rates. For aggregate murder rates, try the [Historical Library](/?tab=historical) tab which has FBI statewide estimates. I can provide raw victim counts from SHR instead.";
    },
  },
  {
    name: "shr-rate-bad-denominator",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      if (/\bstate_population\b/i.test(sql)) return false;
      const usesAvgPopulation = /AVG\s*\(\s*(?:\w+\.)?population\s*\)/i.test(sql);
      if (!usesAvgPopulation) return false;
      const calculatesRate = /\b100000(?:\.0)?\b|\brate\b|per_?100k|per\s+capita/i.test(sql);
      if (!calculatesRate) return false;
      const hasSingleAgencyFilter = /\bagency\s*=\s*'[^']+'/i.test(sql);
      if (hasSingleAgencyFilter) return false;
      const groupsByAgency = /GROUP\s+BY[\s\S]*\bagency\b/i.test(sql);
      if (groupsByAgency) return false;
      const groupsByAggregateGeo = /GROUP\s+BY[\s\S]*\b(?:state_name|division)\b/i.test(sql) ||
        /GROUP\s+BY[\s\S]*\bi\.state\b/i.test(sql);
      const asksAggregateRate = ctx.scope === "state" ||
        ctx.states.length > 0 ||
        /\b(state|statewide|national|nationwide|division|overall)\b/i.test(ctx.question);
      return groupsByAggregateGeo || asksAggregateRate;
    },
    override: () =>
      "SHR incidents.population is per-agency, not a statewide or national denominator. Averaging agency populations across incident rows produces invalid aggregate rates. Use the SHR state_population table for state or national rate denominators, or provide raw victim counts instead.",
  },

  // #3: SHR non-homicide topic substitution
  {
    name: "shr-non-homicide-topic",
    tabs: ["shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      const nonHomicide = /\b(robber(?:y|ies)|thefts?|larcen(?:y|ies)|burglar(?:y|ies)|assaults?|rapes?|sexual assault|auto theft|motor vehicle theft|drugs?|arrests?|staffing|officers?|sworn|personnel|shootings?|property crimes?|violent crimes?)\b/i.test(q);
      if (!nonHomicide) return false;
      const exempt = /\b(homicides?|murders?|kill|circumstance|felony murder|robbery-homicide|homicide during|victims of.*homicide)/i.test(q);
      if (exempt) return false;
      return sql.includes("incidents") || sql.includes("victims");
    },
    override: (ctx) => {
      const match = ctx.question.match(/\b(robber(?:y|ies)|thefts?|larcen(?:y|ies)|burglar(?:y|ies)|assaults?|rapes?|sexual assault|auto theft|motor vehicle theft|drugs?|arrests?|staffing|officers?|sworn|personnel|shootings?|property crimes?|violent crimes?)\b/i);
      const topic = match ? match[1] : "that topic";
      return `The Homicide Reports dataset contains only homicide data. For ${topic} data, try the [Current Trends](/?tab=current) or [Historical Library](/?tab=historical) tab.`;
    },
  },

  // #4: Drug type silent filter drop
  {
    name: "nibrs-drug-type-unavailable",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      const namesDrug = /\b(marijuana|cannabis|weed|cocaine|crack|heroin|meth|methamphetamine|fentanyl|opioids?|opiates?)\b/i.test(q);
      if (!namesDrug) return false;
      const usesSummary = sql.includes("summary_arrestee_demographics") || sql.includes("summary_drug_monthly");
      if (!usesSummary) return false;
      return !sql.includes("suspected_drug");
    },
    override: (ctx) => {
      const match = ctx.question.match(/\b(marijuana|cannabis|weed|cocaine|crack|heroin|meth|methamphetamine|fentanyl|opioids?|opiates?)\b/i);
      const drug = match ? match[1] : "that substance";
      return `NIBRS summary tables group all drug offenses under code 35A (Drug/Narcotic Violations) — they cannot isolate ${drug} specifically. I can provide total drug possession or drug violation counts, but not broken down by substance type.`;
    },
  },

  // #5: NIBRS shooting override
  {
    name: "nibrs-shooting-override",
    tabs: ["nibrs"],
    match: (ctx) => {
      if (!ctx.sql) return false;
      const q = ctx.question.toLowerCase();
      const asksShooting = /\b(shootings?|shot\b|gunshot|people\s+shot|gun\s+violence)\b/i.test(q);
      if (!asksShooting) return false;
      // Exempt: user explicitly asks for firearm homicide/murder, proxy, or agg assault with firearm
      const exempt = /\b(firearm (murder|homicide)|gun (murder|homicide)|(murder|homicide).{0,15}firearm|closest proxy|approximate|aggravated assault.{0,10}firearm)\b/i.test(q);
      return !exempt;
    },
    override: () =>
      "NIBRS does not track 'shootings' as a category. For fatal shootings, use the [Homicide Reports](/?tab=shr) tab which has firearm homicide data since 1976. The closest NIBRS proxy is aggravated assault with a firearm, but that includes brandishing, pistol-whipping, and threats - not just people who were shot. If you want that proxy, ask for 'aggravated assault victims involving a firearm.'",
  },

  // #7: SHR clearance hard override
  {
    name: "shr-clearance-override",
    tabs: ["shr"],
    match: (ctx) => /\b(clearance|cleared|solve[ds]?|unsolved|closure|close rate|cold case)\b/i.test(ctx.question),
    override: () =>
      "The Homicide Reports dataset does not track whether cases were solved or cleared. A **clearance** in FBI terminology means the case was resolved by arrest (suspect arrested, charged, and turned over for prosecution) or by exceptional means (offender identified but arrest prevented by circumstances outside law enforcement's control, such as the offender's death or victim's refusal to cooperate). A clearance does not necessarily mean a conviction. For clearance rate data, try the [Historical Library](/?tab=historical) (agency-level clearance rates back to the 1960s) or the [NIBRS](/?tab=nibrs) (incident-level clearance data from 1991).",
  },

  // User said "raw counts" / "no rolling" but SQL has rolling window
  {
    name: "rolling-window-user-said-raw",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const wantsRaw = /\b(raw counts?|raw numbers?|not rolling|no rolling|don'?t want rolling|not 12.?month|just monthly|just raw)\b/i.test(q);
      if (!wantsRaw) return false;
      return /ROWS\s+BETWEEN|PRECEDING\s+AND\s+CURRENT/i.test(ctx.sql);
    },
    message: () =>
      "[SYSTEM: The user explicitly asked for raw/non-rolling values, but your SQL contains a rolling window (ROWS BETWEEN ... PRECEDING). Remove the rolling window and return raw monthly or annual counts.]",
  },

  // Window LAG/LEAD filter-before-window bug
  {
    name: "window-lag-filter-before-window",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      if (!/\bLAG\s*\(|\bLEAD\s*\(/i.test(sql)) return false;
      // Check if a year filter and a LAG/LEAD appear in the same SELECT block
      // Bad: SELECT ... LAG(...) ... FROM ... WHERE year >= 2020
      // Good: WITH cte AS (SELECT ... LAG(...) FROM ...) SELECT * FROM cte WHERE year >= 2020
      // Heuristic: if the outermost query has both LAG and WHERE year, it's bad
      // Check for LAG/LEAD in the final SELECT (not inside a CTE)
      const ctePattern = /\bWITH\b[\s\S]*?\)\s*SELECT/i;
      if (ctePattern.test(sql)) {
        // Has CTEs — check if the final SELECT (after last `)` before `SELECT`) has LAG
        const lastSelect = sql.match(/\)\s*SELECT\s+([\s\S]*)$/i)?.[1] || "";
        if (/\bLAG\s*\(|\bLEAD\s*\(/i.test(lastSelect) && /\bWHERE\s+.*\byear\s*(?:>=|BETWEEN)\s*\d{4}/i.test(lastSelect)) {
          return true;
        }
        return false;
      }
      // No CTEs — simple query with LAG and WHERE year in same block
      return /\bWHERE\s+.*\byear\s*(?:>=|BETWEEN)\s*\d{4}/i.test(sql);
    },
    message: () =>
      "[SYSTEM: SQLite evaluates WHERE before window functions. Your LAG/LEAD window function is in the same SELECT block as a year filter — the prior-year rows are removed BEFORE LAG can look back, producing NULL. Use a 3-layer pattern: CTE 1 (raw data, no year filter) → CTE 2 (compute LAG/LEAD) → outer SELECT (WHERE year >= display start).]",
  },

  // #9: SQLite dialect guardrail
  {
    name: "sqlite-dialect-error",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => /\b(SUBSTRING_INDEX|DATEDIFF|DATE_TRUNC|ILIKE|DATE_FORMAT|NOW\(\)|CURDATE|INTERVAL\s+\d|CONVERT\s*\(|TOP\s+\d+\b(?!\s*\())|::\s*[A-Za-z_][A-Za-z0-9_]*/i.test(ctx.sql),
    message: () =>
      "[SYSTEM: Your SQL uses a function or syntax not supported by SQLite. SQLite does NOT support SUBSTRING_INDEX, DATEDIFF, DATE_TRUNC, ILIKE, DATE_FORMAT, NOW(), CURDATE, INTERVAL, CONVERT, TOP N, or PostgreSQL casts like value::numeric. Use SQLite equivalents: SUBSTR/INSTR for strings, strftime for dates, LIKE (case-insensitive by default) instead of ILIKE, LIMIT instead of TOP, and CAST(value AS REAL) or 1.0 * numerator / denominator for numeric division.]",
  },

  // #10: NIBRS ethnicity — guardrail REMOVED 2026-06-02, ethnicity column now live in all three
  // summary demographics tables (offender, arrestee, victim). Ethnicity values: H, N, U.

  // #11: Sub-city geography override
  {
    name: "sub-city-geography-override",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => /\b(zip\s*code|zip\s*\d|neighborhoods?|precincts?|police district|census tract|block group|ward\b|borough|communit(?:y|ies)|community area|apartment|complex)\b/i.test(ctx.question),
    override: (ctx) => {
      const match = ctx.question.match(/\b(zip\s*code|neighborhoods?|precincts?|police district|census tract|block group|ward|borough|communit(?:y|ies)|community area|apartment complex)\b/i);
      const geo = match ? match[1] : "that geographic level";
      return `This database is organized by law enforcement agency (city police departments and county sheriffs), not by ${geo}. Crime data is reported at the agency level, not broken down by sub-city geography. For neighborhood-level data, check the local police department's open data portal or CompStat reports.`;
    },
  },

  // #12: Juvenile/raw-table age query protection
  {
    name: "nibrs-age-raw-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql;
      const asksAge = /\b(juveniles?|minors?|under\s*18|teens?|youth|by age|age group|elderly|seniors?|child|children)\b/i.test(q);
      if (!asksAge) return false;
      // Check if hitting raw tables
      const RAW = ["offenders", "victims", "arrestees", "offenses"];
      return RAW.some(t => new RegExp(`\\bFROM\\s+${t}\\b`, "i").test(sql) || new RegExp(`\\bJOIN\\s+${t}\\b`, "i").test(sql));
    },
    message: () =>
      "[SYSTEM: Your query uses raw tables (100M+ rows) for an age-based query. Use summary demographic tables instead: summary_victim_demographics, summary_offender_demographics, or summary_arrestee_demographics. These have an age_group column (0-12, 13-17, 18-24, 25-34, 35-44, 45-54, 55-64, 65+, Unknown). For juveniles, filter age_group IN ('0-12', '13-17'). Generate a NEW query using the appropriate summary table.]",
  },

  // #15: ORDER BY compound-query error
  {
    name: "order-by-column-mismatch",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: () => false, // Checked externally from DB error — see route.ts
    message: () =>
      "[SYSTEM: Your SQL has an ORDER BY column that doesn't exist in the result set. In SQLite compound queries (UNION, etc.), ORDER BY must reference output column names or positions, not table-qualified names. Use the column alias from the SELECT clause.]",
  },

  // #16: Court outcomes, immigration, policy covariates — out of scope
  {
    name: "charge-severity-unavailable",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      return /\b(misdemeanou?r|felon(?:y|ies))\b/i.test(q) &&
        /\b(arrests?|arrested|arrestees?|charges?|charged|offenses?)\b/i.test(q) &&
        !/\b(felony\s+murder|felony\s+type)\b/i.test(q);
    },
    override: () =>
      "None of the available datasets classify arrests or charges as misdemeanors versus felonies. NIBRS can show arrests by reported arrest offense code and demographics, but it does not record the legal charge level or court filing classification. I can show arrest counts by offense category instead.",
  },

  {
    name: "out-of-scope-override",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => /\b(prosecution|convicted|conviction|sentence[ds]?|incarcerat|prison population|jail population|fine[ds]?\b|fee[ds]?\b|bail|immigration status|illegal immigrant|undocumented|GARS|GVRS|gun violence restraining|red flag law|defendants?)\b/i.test(ctx.question),
    override: (ctx) => {
      const match = ctx.question.match(/\b(prosecution|conviction|sentence|incarceration|prison population|jail population|fines|fees|bail|immigration status|GARS|GVRS|gun violence restraining|red flag law|defendants?)\b/i);
      const topic = match ? match[1] : "that topic";
      return `This database tracks reported crime incidents, not court outcomes or policy data. It does not contain information about ${topic}. The data covers crime reports filed by law enforcement agencies — not what happens after arrest. I can provide clearance rates (whether a case was resolved by arrest or exceptional means), but not convictions, sentences, or other court outcomes.`;
    },
  },

  // --- Clearance evidence type queries (unsupported) ---
  {
    name: "nibrs-clearance-evidence-unavailable",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const hasClearance = /\b(clearances?|cleared|solve[ds]?|unsolved)\b/i.test(q);
      const hasEvidence = /\b(evidence|video|camera|surveillance|dna|fingerprint|forensic|witness|footage|bodycam|body cam|cctv)\b/i.test(q);
      return hasClearance && hasEvidence;
    },
    override: () =>
      "NIBRS clearance data does not track what evidence was used to clear a case — video, surveillance footage, DNA, fingerprints, or witness testimony are not recorded. I can show clearance rates by offense type, or break clearances down by arrest vs. exceptional clearance, but not by evidence type.",
  },

  // --- Ranking query returned as time series ---
  {
    name: "ranking-as-time-series",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql;
      // Question asks for a ranking
      const isRanking = /\b(top\s+\d+|highest|most|greatest|lowest|least|which\s+(cities|agencies|states|departments)\s+(have|had|has))\b/i.test(q);
      if (!isRanking) return false;
      // SQL groups by time columns (year, month) — producing a time series not a ranking
      const groupsByTime = /GROUP\s+BY[\s\S]*?\b(year|month)\b/i.test(sql);
      if (!groupsByTime) return false;
      // SQL does NOT have a ranking CTE/window or a reasonable LIMIT for a ranking
      // A ranking should have a small LIMIT (<=50) and NOT group by year+month
      const groupsByYearAndMonth = /GROUP\s+BY[\s\S]*?\byear\b[\s\S]*?\bmonth\b/i.test(sql);
      // If grouping by year AND month, it's a time series, not a ranking
      if (groupsByYearAndMonth) return true;
      // If grouping by year but also by city/agency/state, it's a per-entity time series — still wrong for a ranking
      const groupsByEntity = /GROUP\s+BY[\s\S]*?\b(city|agency|ori|state_name)\b/i.test(sql);
      if (groupsByEntity && /\byear\b/i.test(sql.match(/GROUP\s+BY([\s\S]*?)(?:ORDER|LIMIT|HAVING|$)/i)?.[1] || "")) return true;
      return false;
    },
    message: () =>
      "[SYSTEM: The user asked for a ranking (top N, highest, most, etc.) but your SQL returns a time series grouped by year/month. Rankings should return ONE ROW PER ENTITY with the aggregate metric. Remove year/month from GROUP BY, aggregate across the full time range, and ORDER BY the metric DESC with an appropriate LIMIT. Do NOT return monthly breakdowns for ranking queries.]",
  },

  // --- Raw race/sex codes without CASE mapping ---
  {
    name: "nibrs-unmapped-race-codes",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // SELECT has a raw race or sex column (d.race, a.race, v.race, etc.) without CASE WHEN mapping
      const selectClause = sql.match(/SELECT\s+([\s\S]*?)\s+FROM/i)?.[1] || "";
      const hasRawRace = /\b\w+\.race\b/i.test(selectClause) && !/CASE/i.test(selectClause);
      const hasRawSex = /\b\w+\.sex\b/i.test(selectClause) && !/CASE/i.test(selectClause);
      return hasRawRace || hasRawSex;
    },
    message: () =>
      "[SYSTEM: Your SQL returns raw race codes (W, B, I, A, P, U) or sex codes (M, F, U) without mapping to readable names. ALWAYS use CASE WHEN: CASE race WHEN 'W' THEN 'White' WHEN 'B' THEN 'Black' WHEN 'I' THEN 'American Indian' WHEN 'A' THEN 'Asian' WHEN 'P' THEN 'Pacific Islander' ELSE 'Unknown' END AS race. For sex: CASE sex WHEN 'M' THEN 'Male' WHEN 'F' THEN 'Female' ELSE 'Unknown' END AS sex. Also GROUP BY the CASE expression or its alias, not the raw column.]",
  },

  // --- #1: Missing GROUP BY year on aggregate + year SELECT ---
  {
    name: "missing-group-by-year",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const sql = ctx.sql;

      // --- Depth-aware keyword finder ---
      // Scans sql and finds the position+length of `keyword` at paren depth 0.
      // Returns { pos, len } or null. Skips keywords inside subqueries.
      function findOuterKeyword(s: string, keyword: RegExp): { pos: number; len: number } | null {
        let d = 0;
        for (let i = 0; i < s.length; i++) {
          if (s[i] === "(") d++;
          else if (s[i] === ")") d--;
          else if (d === 0) {
            const slice = s.slice(i);
            const m = slice.match(keyword);
            if (m && m.index === 0) {
              // Word boundary check
              const before = i > 0 ? s[i - 1] : " ";
              const after = s[i + m[0].length] || " ";
              if (/[\s,;(]/.test(before) || i === 0) {
                if (/[\s,;(]/.test(after) || i + m[0].length >= s.length) {
                  return { pos: i, len: m[0].length };
                }
              }
            }
          }
        }
        return null;
      }

      // --- Extract outer SELECT clause up to first FROM at depth 0 ---
      const selectMatch = findOuterKeyword(sql, /^SELECT\b/i);
      if (!selectMatch) return false;
      const fromMatch = findOuterKeyword(sql.slice(selectMatch.pos + selectMatch.len), /^FROM\b/i);
      if (!fromMatch) return false;
      const selectClause = sql.slice(selectMatch.pos + selectMatch.len, selectMatch.pos + selectMatch.len + fromMatch.pos);

      // Strip parenthesized expressions so scalar subqueries don't contribute "year"
      let flat = selectClause;
      let prevLen = -1;
      while (flat.length !== prevLen) {
        prevLen = flat.length;
        flat = flat.replace(/\([^()]*\)/g, "()");
      }
      if (!/\byear\b/i.test(flat)) return false;

      // Has aggregate function
      if (!/\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(sql)) return false;

      // --- Extract outer GROUP BY clause (up to HAVING/ORDER BY/LIMIT/end) ---
      const groupByKw = findOuterKeyword(sql, /^GROUP\s+BY\b/i);
      if (groupByKw) {
        const afterGB = sql.slice(groupByKw.pos + groupByKw.len);
        const terminator = afterGB.match(/\b(HAVING|ORDER\s+BY|LIMIT)\b/i);
        const gbClause = terminator && terminator.index != null
          ? afterGB.slice(0, terminator.index)
          : afterGB;
        if (/\byear\b/i.test(gbClause)) return false; // year already grouped
      }

      // Exclude window functions (SUM(...) OVER (...))
      if (/\bOVER\s*\(/i.test(sql)) return false;
      // Skip CTEs and subquery-FROM — too risky to auto-fix
      if (/^\s*WITH\b/i.test(sql)) return false;
      if (/\bFROM\s*\(/i.test(sql.toLowerCase())) return false;
      return true;
    },
    rewrite: (sql) => {
      // Depth-aware: find the outermost GROUP BY
      let d = 0;
      let gbPos = -1;
      let gbLen = 0;
      for (let i = 0; i < sql.length; i++) {
        if (sql[i] === "(") d++;
        else if (sql[i] === ")") d--;
        else if (d === 0) {
          const m = sql.slice(i).match(/^GROUP\s+BY\b/i);
          if (m) {
            const before = i > 0 ? sql[i - 1] : " ";
            if (/[\s;]/.test(before) || i === 0) {
              gbPos = i;
              gbLen = m[0].length;
              break;
            }
          }
        }
      }

      if (gbPos >= 0) {
        // Existing GROUP BY — append ", year" before the next clause terminator
        const afterGB = sql.slice(gbPos + gbLen);
        const terminator = afterGB.match(/\b(HAVING|ORDER\s+BY|LIMIT)\b/i);
        if (terminator && terminator.index != null) {
          const insertPos = gbPos + gbLen + terminator.index;
          return sql.slice(0, insertPos).trimEnd() + ", year " + sql.slice(insertPos);
        }
        return sql.trimEnd() + ", year";
      }
      // No GROUP BY — insert before ORDER BY/LIMIT/end
      const insertPoint = sql.match(/\b(ORDER\s+BY|LIMIT)\b/i);
      if (insertPoint && insertPoint.index) {
        return sql.slice(0, insertPoint.index) + "GROUP BY year " + sql.slice(insertPoint.index);
      }
      return sql + " GROUP BY year";
    },
  },

  // --- #2: Double table-alias dot (i.i.column → i.column) ---
  {
    name: "double-alias-dot",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => /\b([a-zA-Z_]\w*)\.\1\./g.test(ctx.sql),
    rewrite: (sql) => {
      const fixed = sql.replace(/\b([a-zA-Z_]\w*)\.\1\./g, "$1.");
      return fixed !== sql ? fixed : null;
    },
  },

  // --- DV semantic guardrail: user asks about domestic violence but SQL uses assault tables ---
  {
    name: "nibrs-dv-wrong-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const isDvQuestion = /\bdomestic\s+violence\b|\b(?<![a-z])dv(?![a-z])\b/i.test(ctx.question);
      if (!isDvQuestion) return false;
      const sql = ctx.sql.toLowerCase();
      // OK if already using DV tables
      if (sql.includes("summary_domestic_violence") || sql.includes("summary_dv_arrests")) return false;
      // Fire if using non-DV summary tables (city_monthly, state_monthly, victim tables with assault codes)
      const usesNonDvTable =
        sql.includes("summary_city_monthly") ||
        sql.includes("summary_state_monthly") ||
        sql.includes("summary_victim_state_monthly") ||
        sql.includes("summary_victim_city_monthly");
      return usesNonDvTable;
    },
    message: () =>
      `[SYSTEM: CRITICAL — The user asked about domestic violence but your query uses a general offense summary table. Domestic violence is NOT the same as assault (13A/13B/13C). NIBRS has dedicated DV tables:\n- summary_domestic_violence: DV incident counts, victim demographics, relationship breakdowns (columns: data_year, state, ori, incident_num, offense_code, relationship_code, dv_category, victim_sex, victim_age, victim_race)\n- summary_dv_arrests: DV arrest counts with demographics (columns: year, state, ori, ucr_arrest_offense, dv_category, sex, race, age_group, arrest_count)\nRewrite the query using the appropriate DV table. For city-level DV queries, join summary_domestic_violence with agencies using ori.]`,
  },

  // --- DV schema guardrail: city-level DV queries using summary_domestic_violence ---
  // Checks structural issues only. agency_type='City' is handled by nibrs-county-in-city-query.
  {
    name: "nibrs-dv-city-schema",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      const sqlLower = sql.toLowerCase();
      if (!sqlLower.includes("summary_domestic_violence")) return false;
      const q = ctx.question.toLowerCase();
      if (/\bstates?\b/i.test(q) && /\bGROUP\s+BY\s+(?:\w+\.)?state\b/i.test(sql) && !/\bGROUP\s+BY\b[\s\S]*\bcity\b/i.test(sql)) return false;
      // Only fire for "by city" ranking queries
      const isCityQuery = /\bby\s+city\b|\bcit(y|ies)\b/i.test(q);
      if (!isCityQuery) return false;

      const issues: string[] = [];

      // Must join agencies to get city names
      if (!/\bagencies\b/i.test(sqlLower)) {
        issues.push("missing agencies JOIN — need JOIN agencies a ON a.ori = dv.ori AND a.year = dv.data_year to get city names");
      }
      // Must GROUP BY city, state (not just city)
      if (/\bGROUP\s+BY\b/i.test(sqlLower) && !/GROUP\s+BY[^)]*\bcity\b[^)]*\bstate\b/i.test(sqlLower)) {
        issues.push("GROUP BY must include both a.city AND a.state to distinguish same-named cities across states");
      }
      // Must have LIMIT for ranking queries
      if (/\btop\b|\bmost\b|\bhighest\b|\branking\b/i.test(q) && !/\bLIMIT\b/i.test(sqlLower)) {
        issues.push("add LIMIT 50 for ranking queries");
      }
      // Must use correct COUNT(DISTINCT) — incident_num alone is NOT unique across agencies
      if (/COUNT\s*\(\s*DISTINCT\s+(?:\w+\.)?incident_num\s*\)/i.test(sql) &&
          !/COUNT\s*\(\s*DISTINCT\s+\w+\.ori\s*\|\|\s*':'\s*\|\|/i.test(sql)) {
        issues.push("COUNT(DISTINCT incident_num) is WRONG — incident_num is only unique within an ORI. Use COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num)");
      }

      // Store issues for message
      (ctx as any)._dvCityIssues = issues;
      return issues.length > 0;
    },
    message: (ctx) => {
      const issues = (ctx as any)._dvCityIssues as string[] || [];
      return `[SYSTEM: City-level DV query issues:\n${issues.map(i => `- ${i}`).join("\n")}\nCorrect pattern: SELECT a.city, a.state, COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num) AS dv_incidents FROM summary_domestic_violence dv JOIN agencies a ON a.ori = dv.ori AND a.year = dv.data_year WHERE a.state = '...' AND a.agency_type = 'City' AND a.population > 0 AND a.city != '' GROUP BY a.city, a.state ORDER BY dv_incidents DESC LIMIT 50]`;
    },
  },
  {
    name: "nibrs-dv-victim-count-column",
    tabs: ["nibrs"],
    match: (ctx) => /\bsummary_domestic_violence\b/i.test(ctx.sql) && /\bvictim_count\b/i.test(ctx.sql),
    message: () =>
      "[SYSTEM: summary_domestic_violence has no victim_count column. For DV incident counts, use COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num). For DV victim demographics, count distinct victims with COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num || ':' || dv.victim_sequence) and group by victim_sex, victim_race, and an age bucket derived from victim_age. Do not use SUM(dv.victim_count).]",
  },
  {
    name: "nibrs-dv-subquery-incident-count",
    tabs: ["nibrs"],
    match: (ctx) => {
      if (!/\bsummary_domestic_violence\b/i.test(ctx.sql)) return false;
      if (!/\bincident_count\b/i.test(ctx.sql)) return false;
      return /\bSUM\s*\(\s*CASE\s+WHEN\s+[\s\S]{0,240}?\bdv_category\b[\s\S]{0,240}?\s+THEN\s+1\s+ELSE\s+0\s+END\s*\)/i.test(ctx.sql);
    },
    rewrite: (sql) => {
      const fixed = sql.replace(
        /\bSUM\s*\(\s*CASE\s+WHEN\s+([\s\S]{0,240}?\bdv_category\b[\s\S]{0,240}?)\s+THEN\s+1\s+ELSE\s+0\s+END\s*\)/gi,
        "SUM(CASE WHEN $1 THEN incident_count ELSE 0 END)"
      );
      return fixed !== sql ? fixed : null;
    },
  },
];

/* ------------------------------------------------------------------ */
/*  Runner                                                             */
/* ------------------------------------------------------------------ */

/**
 * Run all guardrails for the given tab and return results.
 * Auto-rewrites are applied first; then issues are collected for Claude retry.
 */
export function runGuardrails(ctx: QueryContext): GuardrailResult {
  let sql = ctx.sql;
  const fired: string[] = [];
  const issues: string[] = [];
  let overrideResponse: string | null = null;
  let overrideGuardrail: string | null = null;

  // Pass 1: rewrites — update sql, build effective context
  for (const g of GUARDRAILS) {
    if (!g.tabs.includes(ctx.tab)) continue;
    const effectiveCtx = { ...ctx, sql };
    if (!g.match(effectiveCtx)) continue;

    fired.push(g.name);

    if (g.rewrite) {
      const rewritten = g.rewrite(sql, effectiveCtx);
      if (rewritten) {
        sql = rewritten;
        console.log(`[guardrail][${g.name}] Auto-rewrote SQL`);
      }
    }

    if (g.message) {
      issues.push(g.message(effectiveCtx));
    }
  }

  // Pass 2: overrides — evaluated against post-rewrite SQL
  const postRewriteCtx = { ...ctx, sql };
  for (const g of GUARDRAILS) {
    if (!g.tabs.includes(ctx.tab)) continue;
    if (!g.override) continue;
    if (!g.match(postRewriteCtx)) continue;

    const resp = g.override(postRewriteCtx);
    if (resp) {
      overrideResponse = resp;
      overrideGuardrail = g.name;
      if (!fired.includes(g.name)) fired.push(g.name);
      console.log(`[guardrail][${g.name}] Hard override — skipping retry`);
      break; // first override wins
    }
  }

  return {
    fired,
    issues,
    sql,
    needsFix: issues.length > 0,
    overrideResponse,
    overrideGuardrail,
  };
}
