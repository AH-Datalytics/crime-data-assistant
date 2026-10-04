import { returnedCoverageNote } from "./returned-coverage";
import {
  NIBRS_UCR_PROPERTY_LABEL,
  NIBRS_UCR_VIOLENT_LABEL,
} from "./nibrs-codes";
import { rankingLimitSentence } from "./level-ranking-eligibility";
import { guardEmptyStateWording, type ResultStateDecision } from "./result-state";
import { applyAgencyDisclosure, describeMultiAgency, countyRequestFromQuestion, multiAgencyRequestFromQuestion, agencyLabelsInRows, agencyRepresented, sqlEstablishesCountyScope, asksMultipleNamedAgencies, distinctAgencyIdentities, type ResolvedAgency } from "./agency-disclosure";
import { classifyClearanceReferent, MIXED_REFERENT_NOTE } from "./clearance-referent";
import { establishIdentities, checkRequestedMembers, mayAssertAgencyFacts, type AnswerEvidence } from "./answer-evidence";
import { monthCoverageFromRows, describeMonths, monthPointsFromRows, returnedMonthRange, applyPeriodDisclosure, partialPeriodIsRelevant } from "./period-comparison";
import {
  explicitStateSubstateMismatch,
  filteredEntityLabel,
  stateNameForAbbr,
} from "./explicit-state-intent";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_ALIASES: [number, RegExp][] = [
  [1, /\bjan(?:uary)?\b/i],
  [2, /\bfeb(?:ruary)?\b/i],
  [3, /\bmar(?:ch)?\b/i],
  [4, /\bapr(?:il)?\b/i],
  [5, /\bmay\b/i],
  [6, /\bjun(?:e)?\b/i],
  [7, /\bjul(?:y)?\b/i],
  [8, /\baug(?:ust)?\b/i],
  [9, /\bsep(?:t(?:ember)?|tember)?\b/i],
  [10, /\boct(?:ober)?\b/i],
  [11, /\bnov(?:ember)?\b/i],
  [12, /\bdec(?:ember)?\b/i],
];

function hasYearMention(text: string): boolean {
  return /\b(?:19|20)\d{2}\b/.test(text);
}


function appendSentence(text: string, sentence: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return sentence;
  if (trimmed.includes(sentence)) return trimmed;
  return `${trimmed}\n\n${sentence}`;
}

function usesContinuousReportingFilter(sql: string): boolean {
  const compact = sql.replace(/\s+/g, " ");
  return /\b(?:\w+\.)?ori\s+IN\s*\(\s*SELECT\s+(?:DISTINCT\s+)?ori\s+FROM\s+nibrs_consistent_reporters\b/i.test(compact) ||
    /\b(?:\w+\.)?ori\s+IN\s*\(\s*SELECT\s+(?:DISTINCT\s+)?ori\s+FROM\s+nibrs_agency_completeness\b[\s\S]*?\bmonths_reported\s*=\s*12\b[\s\S]*?\bGROUP\s+BY\s+ori\b[\s\S]*?\bHAVING\b/i.test(compact) ||
    /\bJOIN\s+nibrs_consistent_reporters\b[\s\S]{0,200}\bON\b[\s\S]{0,160}\bori\s*=/i.test(compact);
}

/**
 * The one denominator shape recognised as actually months-adjusted.
 *
 * This is the recognised form, not a general reading of SQL arithmetic. A denominator written any
 * other way is simply not claimed to be adjusted.
 */
const MONTHS_ADJUSTED_DENOMINATOR =
  /\bSUM\s*\(\s*\w+\.population\s*\*\s*\w+\.months_reported\s*\/\s*12\.0\s*\)/i;

/*
 * Why there are two branches here.
 *
 * The caveat used to require the literal table `nibrs_agency_completeness`, and a rate written with
 * an inline monthly count only satisfied that because the NIBRS planner rewrote it into the table
 * before disclosures were computed. That rewrite is gone -- it could change a figure; see
 * lib/nibrs-sql-optimizer.ts -- so the inline form needs recognising directly or it would keep an
 * adjusted denominator while losing the sentence that admits it.
 *
 * The inline branch demands the ADJUSTMENT, not evidence that months were counted somewhere. A
 * first version accepted a month count plus a `rate_per_100k` alias, which let an UNADJUSTED rate --
 * `SUM(a.population)`, with the month count merely reported alongside -- be described as "adjusted
 * for months reported". On a one-agency fixture with six reporting months that rate is 100 while the
 * genuinely adjusted counterpart is 200, and both were being given the same sentence. A matching
 * count somewhere in the statement says nothing about the denominator.
 *
 * The completeness-table branch keeps its original, looser markers: it predates this and its
 * behaviour is accepted.
 */
function usesNibrsDvReportingPopulationRate(sql: string): boolean {
  if (!/\bsummary_domestic_violence\b/i.test(sql)) return false;
  if (!/\bagencies\b/i.test(sql)) return false;
  if (/\bnibrs_agency_completeness\b/i.test(sql)) {
    return /\breporting_population\b/i.test(sql) ||
      /\brate_per_100k\b/i.test(sql) ||
      MONTHS_ADJUSTED_DENOMINATOR.test(sql);
  }
  if (/\bCOUNT\s*\(\s*DISTINCT\s+month\s*\)\s+AS\s+months_reported\b/i.test(sql)) {
    return MONTHS_ADJUSTED_DENOMINATOR.test(sql);
  }
  return false;
}

function normalizeContinuousReportingExplanation(explanation: string): string {
  return explanation
    .replace(/\bwith incomplete coverage\b/gi, "with continuous reporting")
    .replace(/\bwith incomplete crime data coverage\b/gi, "with continuous reporting")
    .replace(/\bcities with incomplete coverage\b/gi, "agencies with continuous reporting")
    .replace(/\bcities with incomplete crime data coverage\b/gi, "agencies with continuous reporting")
    .replace(/\bacross (?:the )?cit(?:y|ies)\b/gi, "across continuously reporting agencies")
    .replace(/\bacross the requested city\b/gi, "across continuously reporting agencies")
    .replace(/\bacross the requested cities\b/gi, "across continuously reporting agencies")
    .replace(/\bfor the requested city\b/gi, "for continuously reporting agencies")
    .replace(/\bfor the requested cities\b/gi, "for continuously reporting agencies")
    .replace(/\bfrom the requested city\b/gi, "from continuously reporting agencies")
    .replace(/\bfrom the requested cities\b/gi, "from continuously reporting agencies")
    .replace(/\brequested city\b/gi, "continuously reporting agencies")
    .replace(/\bfrom cities that consistently reported(?: data)?\b/gi, "from agencies that reported continuously")
    .replace(/\bby cities that consistently reported(?: data)?\b/gi, "by agencies that reported continuously")
    .replace(/\bcities that consistently reported(?: data)?\b/gi, "agencies that reported continuously")
    .replace(/\bfrom cities that (?:reported|submitted data) continuously\b/gi, "from agencies that reported continuously")
    .replace(/\bby cities that (?:reported|submitted data) continuously\b/gi, "by agencies that reported continuously")
    .replace(/\bcities that (?:reported|submitted data) continuously\b/gi, "agencies that reported continuously")
    .replace(/\bcities that submitted data\b/gi, "agencies that submitted data")
    .replace(/\bfrom cities\b/gi, "from agencies")
    .replace(/\bby cities\b/gi, "by agencies");
}

function asksForTheftSubtype(question: string): boolean {
  return /\b(?:larceny from auto|theft from (?:motor )?vehicle|vehicle burglary|shoplifting|pickpocket(?:ing)?|pocket-picking|purse snatching|theft from building|theft of motor vehicle parts|auto parts)\b/i.test(question);
}

function groupsByOffenseAndAge(sql: string, rows: Record<string, unknown>[]): boolean {
  const sqlHasBoth = /\bucr_offense_code\b/i.test(sql) && /\bage_group\b/i.test(sql);
  const groupedTogether = /\bGROUP\s+BY\b[\s\S]{0,300}\bucr_offense_code\b[\s\S]{0,300}\bage_group\b/i.test(sql) ||
    /\bGROUP\s+BY\b[\s\S]{0,300}\bage_group\b[\s\S]{0,300}\bucr_offense_code\b/i.test(sql);
  if (sqlHasBoth && groupedTogether) return true;
  return rows.some((row) => "ucr_offense_code" in row && "age_group" in row);
}

function usesParentTheftSql(sql: string): boolean {
  return /\boffense\s*(?:=|IN)\s*(?:\([^)]*)?'Theft'\b/i.test(sql) || /\b(?:hac|hsn)?\.?theft\b/i.test(sql);
}

function asksBareViolentCrime(question: string): boolean {
  // Plural too (GC-084 correction C2): "violent crimes" is the same request and gets the same definition.
  return /\bviolent crimes?\b/i.test(question) &&
    !/\b(crimes against persons|nibrs definition|nibrs taxonomy|simple assault|intimidation|kidnapping|human trafficking|all person crimes|persons crimes)\b/i.test(question);
}

function asksBarePropertyCrime(question: string): boolean {
  return /\bproperty crime\b/i.test(question) &&
    !/\b(crimes against property|nibrs definition|nibrs taxonomy|fraud|vandalism|bribery|embezzlement|stolen property)\b/i.test(question);
}

function asksClearanceMetric(question: string): boolean {
  return /\b(?:clearance|cleared|solve[sd]?|solving|unsolved)\b/i.test(question);
}

function asksGenericCrime(question: string): boolean {
  return /\bcrimes?\b/i.test(question) &&
    !/\b(?:violent|property|murder|homicide|rape|robbery|assault|burglary|theft|larceny|motor vehicle theft|arson|domestic violence|dui|drug|weapons?|firearm|gun|shootings?)\b/i.test(question);
}

function usesViolentPersonOffenseFilter(sql: string): boolean {
  const compact = sql.replace(/\s+/g, " ");
  return /\bsummary_victim_(?:city|state)_monthly\b/i.test(compact) &&
    /\bucr_offense_code\s+IN\s*\([^)]*'09A'[^)]*'11A'[^)]*'11B'[^)]*'11C'[^)]*'13A'[^)]*\)/i.test(compact) &&
    !/\b'120'\b/.test(compact);
}

function normalizeClearanceRateExplanation(explanation: string, sql: string): string {
  if (!/\bnational_clearance_rate\b/i.test(sql)) return explanation;
  return explanation
    .replace(/\bNational murder rate data\b/gi, "National murder clearance rate data")
    .replace(/\bmurder rate data\b/gi, "murder clearance rate data")
    .replace(/\bMurder rate data\b/g, "Murder clearance rate data");
}

function normalizeDcExplanation(explanation: string, sql: string): string {
  if (!/\bstate\s*=\s*['"]DC['"]|\bstate\s+IN\s*\([^)]*['"]DC['"]/i.test(sql)) return explanation;
  return explanation
    .replace(/\bWashington\s+statewide\b/gi, "Washington, DC")
    .replace(/\bWashington\s+State\b/g, "Washington, DC")
    .replace(/\bWashington\s+state\b/gi, "Washington, DC");
}

function hasSqlStateFilter(sql: string): boolean {
  return /\b(?:\w+\.)?state\s*(?:=|IN\s*\()\s*['"]/i.test(sql);
}

function rowsExposeStateScope(rows: Record<string, unknown>[]): boolean {
  return rows.some((row) => row.state !== undefined || row.State !== undefined || row.state_name !== undefined);
}

function normalizeUngroundedNibrsStatewideExplanation(
  explanation: string,
  sql: string,
  rows: Record<string, unknown>[],
): string {
  if (!/\bstatewide\b/i.test(explanation)) return explanation;
  if (hasSqlStateFilter(sql) || rowsExposeStateScope(rows)) return explanation;
  return explanation.replace(/\bstatewide\b/gi, "nationally across reporting NIBRS agencies");
}
function normalizeEntity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Every key one entity name may legitimately match under.
 *
 * Exported for lib/proof-checks.ts. Entity comparison already lives here, and a
 * second normalizer in the proof layer would eventually disagree with this one --
 * at which point the proof system would report an omission the disclosure layer
 * did not, or the reverse. Handoff §9.1 says to extend this module rather than
 * create a competing narrative-finalization layer; the same argument applies to
 * its entity matching.
 *
 * The alias pairs exist because source spellings differ from the user's: "St. Louis"
 * vs "Saint Louis", "Charlotte" vs "Charlotte-Mecklenburg", "Las Vegas" vs "Las Vegas
 * Metropolitan". Matching on the bare normalized string alone reports those as missing
 * entities and produces a false omission claim.
 *
 * The rules compare the WHOLE normalized name, so they fire on "Charlotte-Mecklenburg"
 * and not on "Charlotte-Mecklenburg PD". That is narrower than it looks and it is the
 * baseline behavior; widening it would change which disclosure notes appear, which is
 * a Stage 2 question, not a refactor.
 *
 * THESE ARE EXACTLY THE PAIRS THIS MODULE ALREADY HAD, IN EXACTLY THE SAME
 * DIRECTIONS. Moving them out of returnedEntities() is a refactor and must stay one.
 * An earlier revision of this extraction "tidied" the one-way rules into two-way ones,
 * which reads like a cleanup and is not: returnedEntities() expands only the RETURNED
 * side, so adding "charlotte mecklenburg" -> "charlotte" would have made a returned
 * Charlotte-Mecklenburg row satisfy a requested "Charlotte" and silently deleted a
 * missing-entity disclosure the baseline release shows a user today. Stage 1 changes
 * no user-visible behavior, and a note that stops being written is a change.
 *
 * The proof layer does not need the reverse rules: lib/proof-checks and
 * lib/requested-entities expand BOTH sides and match on any shared key, so
 * requested "Charlotte" reaches returned "Charlotte-Mecklenburg" through the forward
 * rule alone. Symmetric comparison belongs at the call site; it does not belong here,
 * where only one side is expanded.
 */
export function entityAliasKeys(value: string): string[] {
  const normalized = normalizeEntity(value);
  const keys = new Set<string>([normalized]);
  if (normalized === "st louis") keys.add("saint louis");
  if (normalized === "saint louis") keys.add("st louis");
  if (normalized === "charlotte") keys.add("charlotte mecklenburg");
  if (normalized === "nashville") keys.add("metropolitan nashville");
  if (normalized === "las vegas") {
    keys.add("las vegas metro pd");
    keys.add("las vegas metropolitan");
  }
  return [...keys];
}

/**
 * The alias-expanded entity keys a result actually returned.
 *
 * Exported for the proof layer so entityCompleteness compares exactly what
 * missingRequestedEntities() below compares. Same argument as entityAliasKeys: two
 * implementations of "did this entity come back?" would eventually disagree, and
 * then the proof record and the disclosure text would contradict each other.
 *
 * NOTE THAT THE REQUESTED SIDE IS NOT EXPORTED. extractRequestedEntitiesFromSql()
 * below stays private on purpose. It is correct for the disclosure note it feeds --
 * "the SQL named these entities and the rows are missing some" -- but it is the wrong
 * input for the proof layer's completeness check, because the SQL that silently drops
 * a requested city also defines what that check believes was requested. A revision of
 * this project exported it, both model paths used it, and the 31-of-32 check became
 * unable to detect the failure it was built for. The proof layer derives requested
 * entities from the parsed request instead: see lib/requested-entities.ts.
 */
export function returnedEntityKeys(rows: Record<string, unknown>[]): string[] {
  return [...returnedEntities(rows)];
}

function extractRequestedEntitiesFromSql(sql: string): string[] {
  const entities: string[] = [];
  const inRe = /\b(?:city|agency|agency_name)\s+IN\s*\(([^)]*)\)/gi;
  let inMatch;
  while ((inMatch = inRe.exec(sql)) !== null) {
    const quoted = inMatch[1].match(/'([^']+)'/g) || [];
    for (const q of quoted) entities.push(q.slice(1, -1));
  }

  const eqRe = /\b(?:city|agency|agency_name)\s*=\s*'([^']+)'/gi;
  let eqMatch;
  while ((eqMatch = eqRe.exec(sql)) !== null) entities.push(eqMatch[1]);

  return [...new Set(entities.map((e) => e.trim()).filter(Boolean))];
}

function returnedEntities(rows: Record<string, unknown>[]): Set<string> {
  const cols = ["city", "agency", "agency_name", "state"];
  const values = new Set<string>();
  for (const row of rows) {
    for (const col of cols) {
      const value = row[col];
      if (value !== undefined && value !== null && String(value).trim()) {
        // Alias expansion moved to entityAliasKeys() so lib/proof-checks compares
        // entities the same way this does. Same pairs, same directions, so the
        // disclosure note this feeds is byte-identical to the baseline release --
        // see the direction warning on entityAliasKeys().
        for (const key of entityAliasKeys(String(value))) values.add(key);
      }
    }
  }
  return values;
}

function missingRequestedEntities(sql: string, rows: Record<string, unknown>[]): string[] {
  const requested = extractRequestedEntitiesFromSql(sql);
  if (requested.length < 2 || rows.length === 0) return [];
  const returned = returnedEntities(rows);
  if (returned.size === 0) return [];
  return requested.filter((entity) => !returned.has(normalizeEntity(entity)));
}

function scopeCorrection(explanation: string, rows: Record<string, unknown>[]): string | null {
  if (!/\b(?:national|nationwide|nationally|at the national level)\b/i.test(explanation)) return null;
  if (rows.length === 0) return null;

  const scopeCols: [string, string][] = [
    ["state", "state"],
    ["city", "city"],
    ["agency", "agency"],
    ["agency_name", "agency"],
  ];

  for (const [col, label] of scopeCols) {
    const distinct = new Set(
      rows
        .map((row) => row[col])
        .filter((value) => value !== undefined && value !== null && String(value).trim())
        .map((value) => normalizeEntity(String(value)))
    );
    if (distinct.size > 1) {
      return `Scope correction: Results are grouped by ${label}, not a single national total.`;
    }
  }

  return null;
}

function textFromRows(rows: Record<string, unknown>[]): string {
  return rows
    .flatMap((row) => Object.values(row))
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join(" ");
}

function hasGrounding(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function stripUngroundedAgencyDescriptors(
  explanation: string,
  question: string,
  rows: Record<string, unknown>[],
): { explanation: string; changed: boolean } {
  const grounded = `${question} ${textFromRows(rows)}`;
  let cleaned = explanation;
  let changed = false;

  const replacements: { pattern: RegExp; groundedBy: RegExp[] }[] = [
    {
      pattern: /\bSheriff'?s Office\b|\bSheriff Office\b|\bSheriff'?s Department\b|\bSheriff Dept\.?\b/gi,
      groundedBy: [/\bsheriff\b/i],
    },
    {
      pattern: /\bPolice Department\b|\bPolice Dept\.?\b|\bCounty Police Department\b|\bCounty PD\b|\bPD\b/gi,
      groundedBy: [/\bpolice\b/i, /\bpol\b/i, /\bpd\b/i],
    },
  ];

  for (const replacement of replacements) {
    if (replacement.pattern.test(cleaned) && !hasGrounding(grounded, replacement.groundedBy)) {
      cleaned = cleaned.replace(replacement.pattern, "agency");
      changed = true;
    }
    replacement.pattern.lastIndex = 0;
  }

  return { explanation: cleaned, changed };
}

function isAntiSetSql(sql: string): boolean {
  return /\bEXCEPT\b/i.test(sql) ||
    /\bNOT\s+IN\s*\(\s*SELECT\b/i.test(sql) ||
    /\bNOT\s+EXISTS\s*\(/i.test(sql) ||
    /\bLEFT\s+JOIN\b[\s\S]+\bIS\s+NULL\b/i.test(sql);
}

function setOperationCorrection(sql: string, rows: Record<string, unknown>[]): string | null {
  if (!isAntiSetSql(sql) || rows.length === 0) return null;
  const entityColumns = ["state", "city", "agency", "agency_name", "ori", "name"];
  if (!rows.some((row) => entityColumns.some((col) => row[col] !== undefined))) return null;
  return "Set interpretation: These rows are missing from the compared set, not records present in it.";
}

const COMPARISON_EXCLUDED_COLUMNS = new Set([
  "year", "data_year", "month", "state", "city", "agency", "agency_name", "ori",
  "name", "county", "offense", "ucr_offense_code", "offense_code", "source",
  "count", "counts", "total", "value", "rate", "population", "rank",
]);

function isNumericLike(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "bigint") return true;
  return false;
}

function isGenericMetricColumn(column: string): boolean {
  return /(?:^|_)(?:rate|count|counts|total|totals|population|offenses?|victims?|murders?|homicides?|incidents?|arrests?|agencies|months|officers?|percent|pct|100k|100000)(?:_|$)/i.test(column);
}

function labelFromComparisonColumn(column: string): string {
  const label = column
    .split(/_+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
  return label
    .replace(/\bNyc\b/g, "NYC")
    .replace(/\bDc\b/g, "DC")
    .replace(/\bLa\b/g, "LA");
}

function comparisonColumnLabels(
  rows: Record<string, unknown>[],
  comparisonLabels?: Record<string, string>,
): string[] {
  if (rows.length === 0) return [];
  const columns = Object.keys(rows[0]);
  return columns
    .filter((column) => !COMPARISON_EXCLUDED_COLUMNS.has(column.toLowerCase()))
    .filter((column) => !isGenericMetricColumn(column))
    .filter((column) => rows.some((row) => isNumericLike(row[column])))
    .map((column) => comparisonLabels?.[column] ?? labelFromComparisonColumn(column));
}

function comparisonDisclosure(
  explanation: string,
  rows: Record<string, unknown>[],
  comparisonLabels?: Record<string, string>,
): string | null {
  const labels = comparisonColumnLabels(rows, comparisonLabels);
  if (labels.length < 2) return null;

  const normalizedExplanation = explanation.toLowerCase();
  if (labels.every((label) => normalizedExplanation.includes(label.toLowerCase()))) return null;

  return `Comparison includes: ${labels.join(", ")}.`;
}

function normalizeStateRankingScope(explanation: string, rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return explanation;
  const columns = Object.keys(rows[0]).map((column) => column.toLowerCase());
  const hasState = columns.includes("state");
  const hasLocalEntity = columns.some((column) => /^(?:city|agency|agency_name|department|ori)$/.test(column));
  if (!hasState || hasLocalEntity) return explanation;
  const firstSentenceMatch = explanation.match(/^[\s\S]*?(?=[.!?](?:\s|$)|$)/);
  if (!firstSentenceMatch) return explanation;
  const firstSentence = firstSentenceMatch[0];
  const corrected = firstSentence.replace(/\bfor\s+(?:the\s+)?cities\s+in\b/i, (match) => match.replace(/cities/i, "states"));
  return corrected === firstSentence ? explanation : corrected + explanation.slice(firstSentence.length);
}

/** Trim only trailing annual rows with no numeric metric data. */
export function trimTrailingEmptyYearRows(rows: Record<string, unknown>[], explanation: string): { rows: Record<string, unknown>[]; explanation: string; trimmedYears: number[] } {
  const yearCol = ["year", "data_year", "Year"].find((c) => rows[0]?.[c] !== undefined);
  if (!yearCol || rows.length < 2) return { rows, explanation, trimmedYears: [] };
  const excluded = new Set([yearCol.toLowerCase(), "month", "data_month", "month_num", "rank", "id", "ori", "fips", "code"]);
  const metricCols = Object.keys(rows[0]).filter((c) => !excluded.has(c.toLowerCase()) && rows.some((r) => typeof r[c] === "number" || (typeof r[c] === "string" && r[c].trim() !== "" && Number.isFinite(Number(r[c])))));
  if (metricCols.length === 0) return { rows, explanation, trimmedYears: [] };
  const hasData = (row: Record<string, unknown>) => metricCols.some((c) => row[c] !== null && row[c] !== undefined && row[c] !== "" && Number.isFinite(Number(row[c])));
  const sorted = [...rows].sort((a, b) => Number(a[yearCol]) - Number(b[yearCol]));
  let lastData = -1;
  for (let i = sorted.length - 1; i >= 0; i--) { if (hasData(sorted[i])) { lastData = i; break; } }
  if (lastData < 0 || lastData === sorted.length - 1) return { rows, explanation, trimmedYears: [] };
  const maxDataYear = Number(sorted[lastData][yearCol]);
  const trimmedYears = sorted.slice(lastData + 1).map((r) => Number(r[yearCol]));
  const kept = rows.filter((r) => !trimmedYears.includes(Number(r[yearCol])));
  let updated = explanation.replace(/\b(from\s+(?:19|20)\d{2}\s+(?:to|through|thru|until|[\-\u2013\u2014])\s+)(?:19|20)\d{2}\b/i, "$1" + maxDataYear).replace(/\b(between\s+(?:19|20)\d{2}\s+and\s+)(?:19|20)\d{2}\b/i, "$1" + maxDataYear);
  if (!new RegExp("Data is available through " + maxDataYear + "\\b", "i").test(updated)) updated = updated.trim() + (updated.trim().endsWith(".") ? "" : ".") + " Data is available through " + maxDataYear + ".";
  return { rows: kept, explanation: updated, trimmedYears };
}
function yearBoundsFromRows(rows: Record<string, unknown>[]): { min: number; max: number } | null {
  const yearCol = ["year", "data_year", "Year"].find((c) => rows[0]?.[c] !== undefined);
  if (!yearCol) return null;
  const years = rows
    .map((r) => Number(r[yearCol]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (years.length === 0) return null;
  return { min: years[0], max: years[years.length - 1] };
}

function requestedLowerBoundYear(question: string, sql: string): number | null {
  const questionPatterns = [
    /\b(?:since|from|starting(?:\s+in)?|beginning(?:\s+in)?)\s+(?:the\s+year\s+)?((?:19|20)\d{2})\b/i,
    /\b((?:19|20)\d{2})\s*(?:-|\u2013|\u2014|to|through|thru)\s*(?:19|20)\d{2}\b/i,
    /\bbetween\s+((?:19|20)\d{2})\s+and\s+(?:19|20)\d{2}\b/i,
  ];
  for (const pattern of questionPatterns) {
    const match = question.match(pattern);
    if (match) return Number(match[1]);
  }
  const between = sql.match(/\b(?:year|data_year)\s+BETWEEN\s+((?:19|20)\d{2})\s+AND\s+(?:19|20)\d{2}/i);
  if (between) return Number(between[1]);
  const lower = sql.match(/\b(?:year|data_year)\s*>=\s*((?:19|20)\d{2})\b/i);
  if (lower) return Number(lower[1]);
  const exclusiveLower = sql.match(/\b(?:year|data_year)\s*>\s*((?:19|20)\d{2})\b/i);
  if (exclusiveLower) return Number(exclusiveLower[1]) + 1;
  return null;
}

export function missingLowerBoundNote(
  question: string,
  sql: string,
  rows: Record<string, unknown>[],
): string | null {
  const requestedStart = requestedLowerBoundYear(question, sql);
  const returnedBounds = yearBoundsFromRows(rows);
  if (requestedStart === null || returnedBounds === null || returnedBounds.min <= requestedStart) return null;
  return "Although the query covered " + requestedStart + " onward, this source returned data beginning in " + returnedBounds.min + ".";
}

/**
 * COVER batch (Codex :34982): the coverage the answer actually returned -- the existing whole-result start-year
 * sentence, or, when there is more to say (per-series spans, the end side, interior years with no value), the
 * per-series returned-value statement (lib/returned-coverage.ts). The statement is derived from the rows first;
 * idempotence matches only that exact owned statement (COVER-R1a), never a phrase such as "Returned coverage" in
 * model prose, so every answer version (first, refined, retry, fallback) gets the row facts exactly once.
 */
export function withReturnedCoverage(explanation: string, question: string, sql: string, rows: Record<string, unknown>[]): string {
  const lower = missingLowerBoundNote(question, sql, rows);
  const lowerYear = lower ? yearBoundsFromRows(rows)?.min ?? null : null;
  const coverage = returnedCoverageNote({ question, sql, rows, lowerBoundOnlyStatedFor: lowerYear });
  if (coverage) {
    if (explanation.includes(coverage)) return explanation;
    return appendSentence(explanation.replace(/\s*Although the query covered (?:19|20)\d{2} onward, this source returned data beginning in (?:19|20)\d{2}\.?/, ""), coverage);
  }
  if (lower && !explanation.includes(lower)) return appendSentence(explanation, lower);
  return explanation;
}

export function alignTitleYearRange<T extends string | null | undefined>(title: T, rows: Record<string, unknown>[]): T {
  if (title == null) return title;
  const bounds = yearBoundsFromRows(rows);
  if (!bounds) return title;
  const rangePattern = /\b((?:19|20)\d{2})(\s*(?:\u2013|-|to)\s*)((?:19|20)\d{2})\b/;
  const range = title.match(rangePattern);
  if (range) {
    if (Number(range[1]) === bounds.min && Number(range[3]) === bounds.max) return title;
    return title.replace(rangePattern, String(bounds.min) + range[2] + String(bounds.max)) as T;
  }
  const trailingYearPattern = /\b((?:19|20)\d{2})\s*$/;
  const trailingYear = title.match(trailingYearPattern);
  if (!trailingYear || Number(trailingYear[1]) === bounds.max) return title;
  return title.replace(trailingYearPattern, String(bounds.max)) as T;
}

function hasExplicitEndYear(question: string, year: number): boolean {
  return new RegExp(`\\b(?:to|through|thru|until|and|-)\\s*${year}\\b`, "i").test(question) ||
    new RegExp(`\\b(?:between|from)\\s+(?:19|20)\\d{2}\\s+(?:and|to|through|thru|until|-)\\s+${year}\\b`, "i").test(question);
}

function alignThroughYearWithRows(
  explanation: string,
  question: string,
  rows: Record<string, unknown>[],
): string {
  const bounds = yearBoundsFromRows(rows);
  if (!bounds) return explanation;
  return explanation.replace(/\b(through|thru|to)\s+((?:19|20)\d{2})\b/gi, (match, prefix: string, yearText: string) => {
    const stated = Number(yearText);
    if (!Number.isFinite(stated) || stated >= bounds.max || hasExplicitEndYear(question, stated)) return match;
    return `${prefix} ${bounds.max}`;
  });
}
function yearRangeFromRows(rows: Record<string, unknown>[]): string | null {
  const yearCol = ["year", "data_year", "Year"].find((c) => rows[0]?.[c] !== undefined);
  if (!yearCol) return null;
  const years = rows
    .map((r) => Number(r[yearCol]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (years.length === 0) return null;
  const lo = years[0];
  const hi = years[years.length - 1];
  return lo === hi ? String(lo) : `${lo}-${hi}`;
}

function yearRangeFromSql(sql: string): string | null {
  const between = sql.match(/\byear\s+BETWEEN\s+((?:19|20)\d{2})\s+AND\s+((?:19|20)\d{2})/i);
  if (between) return between[1] === between[2] ? between[1] : `${between[1]}-${between[2]}`;

  const eq = sql.match(/\byear\s*=\s*((?:19|20)\d{2})/i);
  const ge = sql.match(/\byear\s*>=\s*((?:19|20)\d{2})/i);
  const le = sql.match(/\byear\s*<=\s*((?:19|20)\d{2})/i);
  if (eq) return eq[1];
  if (ge && le) return `${ge[1]}-${le[1]}`;
  if (ge) return `${ge[1]} onward`;
  if (le) return `through ${le[1]}`;
  return null;
}


function rowsIncludeYear(rows: Record<string, unknown>[], year: number): boolean {
  const yearCols = ["year", "data_year", "Year"];
  return rows.some((row) =>
    yearCols.some((col) => Number(row[col]) === year)
  );
}

function hasCurrentYearSignal(question: string, sql: string, rows: Record<string, unknown>[], year: number): boolean {
  if (rowsIncludeYear(rows, year)) return true;
  const escapedYear = String(year);
  return new RegExp(`\\b${escapedYear}\\b`).test(question) ||
    new RegExp(`\\byear\\s*(?:=|<=|BETWEEN[^\\n;]+AND)\\s*${escapedYear}\\b`, "i").test(sql) ||
    /\b(?:this year|current year|ytd|year[-\s]?to[-\s]?date|so far|to date)\b/i.test(question);
}

function hasCurrentPartialDisclosure(explanation: string, year: number): boolean {
  return new RegExp(`\\b${year}\\b[\\s\\S]{0,140}\\b(?:partial|incomplete|year[-\\s]?to[-\\s]?date|YTD|not\\s+a\\s+full[-\\s]?year|preliminary)\\b`, "i").test(explanation);
}

function currentPartialYearMetric(question: string, sql: string): "rate" | "total" {
  return /\b(?:rates?|per\s+capita|per\s*100k|per\s*100,000)\b/i.test(question) ||
    /\b(?:rate|per_100k|per_capita)\b/i.test(sql)
    ? "rate"
    : "total";
}

function normalizeCurrentPartialYearMetric(explanation: string, question: string, sql: string, year: number): string {
  if (currentPartialYearMetric(question, sql) !== "rate") return explanation;
  return explanation
    .replace(new RegExp(`(\\b${year}\\b[\\s\\S]{0,140}\\bpartial[-\\s]?year\\s+)total`, "gi"), "$1rate")
    .replace(new RegExp(`(\\bnot\\s+a\\s+full[-\\s]?year\\s+${year}\\s+)total`, "gi"), "$1rate");
}

function currentPartialYearNote(
  question: string,
  sql: string,
  rows: Record<string, unknown>[],
  returnedPeriod: string | null,
): string | null {
  const currentYear = new Date().getFullYear();
  if (!hasCurrentYearSignal(question, sql, rows, currentYear)) return null;

  const metric = currentPartialYearMetric(question, sql);
  const basis = returnedPeriod ? ` based on returned data (${returnedPeriod})` : " based on the returned data";
  return `${currentYear} is incomplete; this is a partial-year ${metric}${basis}, not a full-year ${currentYear} ${metric}.`;
}

function requestedMonths(question: string): number[] {
  const months: number[] = [];
  for (const [month, pattern] of MONTH_ALIASES) {
    if (pattern.test(question)) months.push(month);
  }
  return months;
}

function yearFromQuestionOrRows(question: string, rows: Record<string, unknown>[]): number | null {
  const mentioned = question.match(/\b((?:19|20)\d{2})\b/);
  if (mentioned) return Number(mentioned[1]);
  const points = monthPointsFromRows(rows);
  return points.length > 0 ? points[points.length - 1].year : null;
}

function currentMissingMonthNote(question: string, rows: Record<string, unknown>[]): string | null {
  const asked = requestedMonths(question);
  if (asked.length === 0) return null;
  const points = monthPointsFromRows(rows);
  if (points.length === 0) return null;
  const returned = new Set(points.map((p) => p.month));
  const missing = asked.filter((month) => !returned.has(month));
  if (missing.length === 0) return null;
  const latest = points[points.length - 1];
  const year = yearFromQuestionOrRows(question, rows) ?? latest.year;
  const missingNames = missing.map((month) => MONTH_NAMES[month - 1]).join(" and ");
  return `${missingNames} ${year} ${missing.length === 1 ? "is" : "are"} not available in Current Trends yet. The latest returned month is ${MONTH_NAMES[latest.month - 1]} ${latest.year}.`;
}

function removeMissingMonthClaim(explanation: string, missingNote: string): string {
  const missingNames = MONTH_NAMES.filter((name) => missingNote.includes(name));
  if (missingNames.length === 0) return explanation;
  const monthPattern = new RegExp(`\\b(?:${missingNames.join("|")})\\b`, "i");
  const sentences = explanation.split(/(?<=[.!?])\s+/);
  if (sentences.length === 0) return explanation;
  const first = sentences[0];
  if (
    monthPattern.test(first) &&
    /\b(?:data|counts?|results?|shows?|contains?|includes?|for)\b/i.test(first)
  ) {
    return sentences.slice(1).join(" ").trim();
  }
  return explanation;
}

function ytdRange(question: string, sql: string, rows: Record<string, unknown>[]): string | null {
  if (!/\b(ytd|year[-\s]?to[-\s]?date|so far|this year|to date)\b/i.test(question)) return null;

  const returned = returnedMonthRange(rows);
  if (returned) return returned;

  const sqlYear = sql.match(/\byear\s*=\s*((?:19|20)\d{2})/i)?.[1] || sql.match(/\byear\s*<=?\s*((?:19|20)\d{2})/i)?.[1];
  const sqlMonth = sql.match(/\bmonth\s*<=\s*(1[0-2]|[1-9])\b/i)?.[1];
  if (sqlYear && sqlMonth) return `January-${MONTH_NAMES[Number(sqlMonth) - 1]} ${sqlYear}`;
  return null;
}

/**
 * Disclosure for annual sources that publish on a lag: recent rows may be
 * partial or preliminary and should be explained rather than removed.
 */
export function laggedAnnualRecentYearNote(
  rows: Record<string, unknown>[],
  explanation: string,
  currentYear: number,
  opts?: { sourceLabel?: string },
): string | null {
  const yearCol = ["year", "data_year", "Year"].find((c) => rows[0]?.[c] !== undefined);
  if (!yearCol || /\b(?:incomplete|preliminary|partial|still\s+maturing|published?\s+on\s+a\s+lag)\b/i.test(explanation)) return null;
  const metricNames = ["incident_count", "incidents", "victim_count", "victims", "offense_count", "offenses", "crime_count", "count", "total", "murder", "murders"];
  const metricKey = metricNames.find((key) => rows.some((row) => Number.isFinite(Number(row[key])))) || Object.keys(rows[0] || {}).find((key) => key !== yearCol && rows.some((row) => Number.isFinite(Number(row[key]))));
  if (!metricKey) return null;
  const totals = new Map<number, number>();
  for (const row of rows) {
    const year = Number(row[yearCol]); const value = Number(row[metricKey]);
    if (Number.isFinite(year) && Number.isFinite(value)) totals.set(year, (totals.get(year) || 0) + value);
  }
  const priorYears = [...totals.keys()].filter((year) => year < currentYear - 1).sort((a, b) => a - b).slice(-3);
  if (priorYears.length < 2) return null;
  const baseline = priorYears.map((year) => totals.get(year)!).sort((a, b) => a - b);
  const middle = Math.floor(baseline.length / 2);
  const median = baseline.length % 2 ? baseline[middle] : (baseline[middle - 1] + baseline[middle]) / 2;
  if (!Number.isFinite(median) || median <= 0) return null;
  const flaggedYears = [...totals.entries()].filter(([year, value]) => year >= currentYear - 1 && year <= currentYear && value < median * 0.6).map(([year]) => year).sort((a, b) => a - b);
  if (flaggedYears.length === 0) return null;
  const label = flaggedYears.length === 1 ? String(flaggedYears[0]) : String(flaggedYears[0]) + "\u2013" + String(flaggedYears[flaggedYears.length - 1]);
  const source = opts?.sourceLabel ? opts.sourceLabel + " data" : "These data";
  return "Recent year" + (flaggedYears.length === 1 ? "" : "s") + " (" + label + ") may be incomplete or preliminary \u2014 " + source + " are published on a lag, so counts can rise as more agencies report and the recent drop should not be read as a true decline.";
}


/**
 * A share computed from `summary_offender_demographics.offender_count` (or its planner rollup) is a
 * share of RECORDED OFFENDERS, not of crimes: GC-032 asks "what share of serious violent crimes ...
 * are committed by youth", and the only answer the data supports counts offender records. A model
 * writing "8.0% of serious violent crimes" silently changes the unit, so that phrase is re-labelled
 * and the unit is stated once. "Share of crimes" is deliberately not used in the sentence: the
 * route's later offender-wording step rewrites that phrase. Offenders of unknown age are named as
 * part of the total only when the statement does not filter them.
 */
function offenderShareUnit(explanation: string, question: string, sql: string, rows: Record<string, unknown>[]): string {
  const delivery = offenderShareDelivery(question, sql, rows);
  if (!delivery) return explanation;
  // The model's sentence is NOT kept (Codex G32-2): "8.4% of all reported serious violent crimes were
  // committed by youth" asserts a share the database did not measure, and no rewrite of its wording
  // can be shown complete. The product states what the verified row and the SQL's scope establish.
  return delivery.join("\n\n");
}

/**
 * The owned answer for a proved offender share: [statement, unit note], or null when the statement is
 * not one. Every part is read from the returned row or the statement's own filters, and a part that
 * cannot be read unambiguously is left out rather than guessed:
 *   - the share is the ONE returned column computed by a division, scaled as the SQL scales it;
 *   - a count pair is quoted only when it reproduces that share to the SQL's rounding;
 *   - the group, place and period come from single, unambiguous equality/BETWEEN filters.
 * Exported so the route can re-apply it after the internal-leak firewall.
 */
export function offenderShareDelivery(question: string, sql: string, rows: Record<string, unknown>[]): [string, string] | null {
  const note = offenderShareUnitNote(question, sql);
  if (!note) return null;
  const text = sql.replace(/\s+LIMIT\s+\d+\s*;?\s*$/i, "");
  const plain = text.replace(/'(?:''|[^'])*'/g, "''");

  // The share column: the outer select item holding a top-level division, with an alias.
  const outer = plain.slice(plain.search(/\bSELECT\b(?![\s\S]*\bSELECT\b[\s\S]*\bFROM\b[\s\S]*$)/i));
  const selectList = outer.replace(/^\s*SELECT\s+/i, "").replace(/\s+FROM\s[\s\S]*$/i, "");
  const items: string[] = [];
  let depth = 0; let start = 0;
  for (let i = 0; i < selectList.length; i++) {
    const c = selectList[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { items.push(selectList.slice(start, i)); start = i + 1; }
  }
  items.push(selectList.slice(start));
  const shares = items.map((item) => item.trim()).map((item) => ({ item, alias: item.match(/\s+AS\s+([A-Za-z_]\w*)\s*$/i)?.[1] ?? null }))
    .filter(({ item, alias }) => alias && /\//.test(item));
  const row = rows.length === 1 ? rows[0] : null;
  // Only an actual finite number is a share. SQL NULL (a zero denominator, or no rows summed) is an
  // UNAVAILABLE share, and `Number(null)` is 0 -- coercing it stated 0.0% (Codex, G32 review). A real
  // numeric 0 stays 0%.
  const raw = shares.length === 1 && row ? row[shares[0].alias!] : undefined;
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : NaN;
  const unavailable = shares.length === 1 && row !== null && !Number.isFinite(value);

  let figure: string | null = null;
  let counts = "";
  if (Number.isFinite(value)) {
    const item = shares[0].item;
    const percentScaled = /(?:^|[^\w.])100(?:\.0*)?\s*\*|\*\s*100(?:\.0*)?(?![\w.])/.test(item);
    const round = item.match(/ROUND\s*\([\s\S]*,\s*(\d+)\s*\)\s+AS\s/i);
    const digits = round ? Math.max(0, Number(round[1]) - (percentScaled ? 0 : 2)) : 1;
    const percent = percentScaled ? value : value * 100;
    figure = `${percent.toFixed(digits)}%`;
    const numbers = Object.entries(row!).filter(([key, v]) => key !== shares[0].alias && typeof v === "number" && Number.isInteger(v)) as [string, number][];
    const tolerance = 0.5 * 10 ** -digits + 1e-9;
    const pairs = numbers.flatMap(([, a]) => numbers.map(([, b]) => [a, b] as const))
      .filter(([a, b]) => b > 0 && a >= 0 && a <= b && Math.abs((100 * a) / b - percent) <= tolerance);
    if (pairs.length === 1) counts = ` (${pairs[0][0].toLocaleString("en-US")} of ${pairs[0][1].toLocaleString("en-US")})`;
  }

  const distinct = <T,>(values: T[]) => [...new Set(values.map((v) => JSON.stringify(v)))].map((v) => JSON.parse(v) as T);
  const LABELS: Record<string, string> = { age_group: "age group", sex: "sex", race: "race", ethnicity: "ethnicity" };
  const groups = distinct([...text.matchAll(/\b(?:\w+\.)?(age_group|sex|race|ethnicity)\s*=\s*'([^']+)'/gi)].map((m) => [m[1].toLowerCase(), m[2]]));
  const states = distinct([...text.matchAll(/\b(?:\w+\.)?state\s*=\s*'([A-Za-z]{2})'/gi)].map((m) => m[1].toUpperCase()));
  const ranges = distinct([...text.matchAll(/\b(?:\w+\.)?(?:data_)?year\s+BETWEEN\s+(\d{4})\s+AND\s+(\d{4})/gi)].map((m) => `${m[1]}–${m[2]}`));
  const singles = distinct([...text.matchAll(/\b(?:\w+\.)?(?:data_)?year\s*=\s*(\d{4})\b/gi)].map((m) => m[1]));
  const place = states.length === 1 ? stateNameForAbbr(states[0]) : null;
  const period = ranges.length + singles.length === 1 ? (ranges[0] ?? singles[0]) : null;
  const scope = `Of the offenders recorded in NIBRS reports for the requested offenses${place ? ` in ${place}` : ""}${period ? `, ${period}` : ""}`;
  const group = groups.length === 1 ? `had a recorded ${LABELS[groups[0][0]]} of ${groups[0][1]}` : "were in the requested group";
  // The cause is named only when the returned row establishes it: every returned count is zero.
  const otherValues = row && shares.length === 1 ? Object.entries(row).filter(([key]) => key !== shares[0].alias).map(([, v]) => v) : [];
  const noOffenders = otherValues.length > 0 && otherValues.every((v) => v === 0);
  const statement = figure
    ? `${scope}, ${figure}${counts} ${group}.`
    : unavailable
      ? `${scope}, the share that ${group} is unavailable: ${noOffenders
        ? "the result contains no recorded offenders in this scope, so no percentage can be computed."
        : "the query returned no value for it, so no percentage is stated."}`
      : `${scope}, the share that ${group} is shown in the results above.`;
  return [statement, note];
}

/**
 * The unit sentence for an offender share, or null when the statement is not one. Exported so the
 * route can re-apply it after the internal-leak firewall, which replaces a leaking narrative whole
 * (the same reason the missing-member note is composed after it).
 */
export function offenderShareUnitNote(question: string, sql: string): string | null {
  if (!/\bsummary_offender_demographics\b|\b(?:state|national)_summary_offender_demographics\b/i.test(sql)) return null;
  if (!/\boffender_count\b/i.test(sql) || !/\//.test(sql)) return null;
  if (!/\b(?:share|percent(?:age)?|proportion|fraction|what\s+part)\b|%/i.test(question)) return null;
  const unknown = /'unknown'/i.test(sql) ? "" : " (including offenders recorded with an unknown age)";
  return `Unit: this percentage is of offenders recorded in NIBRS reports${unknown}, not of crimes or incidents; ` +
    "one incident can list several offenders, and not every offender is identified or recorded.";
}

export function applyResultDisclosures(opts: {
  explanation: string;
  question: string;
  sql: string;
  rows: Record<string, unknown>[];
  tab?: string;
  comparisonLabels?: Record<string, string>;
  /**
   * Increment 1 (Decision 13). The result-state decision the route's source adapter
   * reached. When present, an empty-state claim in the wording is checked against it and
   * replaced if it is not supported. The adapters classify; this chokepoint enforces.
   */
  resultState?: ResultStateDecision;
  /**
   * Increment 4 (Decision 10). The agency actually used for the place the user named.
   * A county answered by a sheriff's agency must say so.
   */
  resolvedAgency?: ResolvedAgency;
}): string {
  let explanation = normalizeDcExplanation(normalizeClearanceRateExplanation(opts.explanation, opts.sql), opts.sql);
  explanation = normalizeStateRankingScope(explanation, opts.rows);
  const agencyDescriptor = stripUngroundedAgencyDescriptors(explanation, opts.question, opts.rows);
  explanation = agencyDescriptor.explanation;
  if (agencyDescriptor.changed) {
    explanation = appendSentence(
      explanation,
      "Descriptor correction: Ungrounded agency-type labels were removed because they were not present in the question or returned rows."
    );
  }

  // Recent-year rate denominators come from the FBI CDE's current population
  // estimate, applied flat across in-progress years until official estimates
  // publish (state_population rows with source 'FBI CDE API...'); disclose so
  // recent-year rates aren't read as using year-specific denominators
  // (CODEX_REVIEW_9577edc finding 5)
  if (/\bstate_population\b/i.test(opts.sql)) {
    const currentYear = new Date().getFullYear();
    const cdeYears = [currentYear - 1, currentYear];
    const textToScan = `${opts.sql} ${opts.rows.slice(0, 50).map((r) => Object.values(r).join(" ")).join(" ")}`;
    if (cdeYears.some((y) => new RegExp(`\\b${y}\\b`).test(textToScan))) {
      explanation = appendSentence(
        explanation,
        `Note: Population denominators for ${cdeYears[0]}–${cdeYears[1]} use the FBI CDE's current population estimate, which the FBI applies to in-progress years; rates for these years may be revised when official estimates are published.`
      );
    }
  }

  if (
    (opts.tab === "current" || opts.tab === "historical") &&
    asksForTheftSubtype(opts.question) &&
    usesParentTheftSql(opts.sql)
  ) {
    explanation = appendSentence(
      explanation,
      "Note: This data source reports only total Theft, not the requested theft subtype. For subtype-specific counts, use the NIBRS tab."
    );
  }

  if (opts.tab === "nibrs") {
    explanation = normalizeUngroundedNibrsStatewideExplanation(explanation, opts.sql, opts.rows);
    explanation = offenderShareUnit(explanation, opts.question, opts.sql, opts.rows);

    if (asksBareViolentCrime(opts.question)) {
      explanation = appendSentence(
        explanation,
        `Definition: NIBRS violent crime is reported here using the UCR-aligned set: ${NIBRS_UCR_VIOLENT_LABEL}.`
      );
    } else if (asksBarePropertyCrime(opts.question)) {
      explanation = appendSentence(
        explanation,
        `Definition: NIBRS property crime is reported here using the UCR-aligned set: ${NIBRS_UCR_PROPERTY_LABEL}.`
      );
    } else if (asksGenericCrime(opts.question) && usesViolentPersonOffenseFilter(opts.sql)) {
      explanation = appendSentence(
        explanation,
        "Definition: This result uses a person-offense filter: murder/nonnegligent manslaughter, sex offenses, and aggravated assault. It is not all crime."
      );
    }

    if (usesContinuousReportingFilter(opts.sql)) {
      explanation = normalizeContinuousReportingExplanation(explanation);
      explanation = appendSentence(
        explanation,
        "Coverage filter: Results are restricted to agencies that reported all 12 months in every requested year. These are individual reporting agencies, not geographic totals; this improves year-to-year comparability but is not a national estimate."
      );
    }

    if (usesNibrsDvReportingPopulationRate(opts.sql)) {
      explanation = appendSentence(
        explanation,
        "Rate denominator: population served by NIBRS-reporting agencies, adjusted for months reported; this is not a complete official state population rate."
      );
    }

    if (groupsByOffenseAndAge(opts.sql, opts.rows) && !/\boffense\b/i.test(explanation)) {
      explanation = appendSentence(
        explanation,
        "Breakdown note: Results are grouped by offense code and age group."
      );
    }
  }

  const missing = missingRequestedEntities(opts.sql, opts.rows);
  if (missing.length > 0) {
    explanation = appendSentence(
      explanation,
      `No data found for: ${missing.join(", ")}. These agencies may not report to this data source or may be recorded under a different name.`
    );
  }

  const scope = scopeCorrection(explanation, opts.rows);
  if (scope) {
    explanation = appendSentence(explanation, scope);
  }

  const setCorrection = setOperationCorrection(opts.sql, opts.rows);
  if (setCorrection) {
    explanation = appendSentence(explanation, setCorrection);
  }

  if (asksClearanceMetric(opts.question)) {
    explanation = appendSentence(
      explanation,
      "Clearance note: FBI clearance means cleared by arrest or exceptional means; it is not the same as conviction or prosecution."
    );
  }

  const comparison = comparisonDisclosure(explanation, opts.rows, opts.comparisonLabels);
  if (comparison) {
    explanation = appendSentence(explanation, comparison);
  }

  const stateMismatch = explicitStateSubstateMismatch(opts.question, opts.sql);
  if (stateMismatch) {
    const entity = filteredEntityLabel(opts.sql) || "a specific agency or city";
    explanation = appendSentence(
      explanation,
      `Geography warning: This result filters ${entity}; it is not statewide data for ${stateMismatch.stateName}.`
    );
  }

  const ytd = ytdRange(opts.question, opts.sql, opts.rows);
  /*
   * Row-derived month identities are not Current-specific: `returnedMonthRange` reads columns, not a
   * tab. The old `tab === "current"` restriction is why GC-049's NIBRS monthly rows described no
   * period at all while GC-041's identical shape did.
   */
  const returnedPeriod = ytd || returnedMonthRange(opts.rows);

  if (opts.tab === "hate_crime") {
    const note = laggedAnnualRecentYearNote(opts.rows, explanation, new Date().getFullYear(), { sourceLabel: "Hate crime" });
    if (note) explanation = appendSentence(explanation, note);
  }
  if (opts.tab === "nibrs" || opts.tab === "historical") {
    const note = laggedAnnualRecentYearNote(opts.rows, explanation, new Date().getFullYear(), { sourceLabel: opts.tab === "nibrs" ? "NIBRS" : "Historical" });
    if (note) explanation = appendSentence(explanation, note);
  }
  if (returnedPeriod && !new RegExp(returnedPeriod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(explanation)) {
    explanation = appendSentence(explanation, `Returned period: ${returnedPeriod}.`);
  }
  // The partial year's own basis, or the honest limitation. Shared with the first-delivery callers
  // so the two can never disagree; idempotent, so applying it twice adds nothing.
  // Relevance from the caller's own context: a partial-period or year-to-date request, or a range
  // reaching the current year. Not merely "a row carries this year".
  // The same bounded rule the first-answer caller uses. A bare year mention is not enough.
  const partialPeriodRelevant = partialPeriodIsRelevant(opts.question, opts.rows);
  explanation = applyPeriodDisclosure(explanation, opts.rows, { partialPeriodRelevant });

  /*
   * Decision 6, the partial year's own basis.
   *
   * The overall envelope ("January 2020-May 2026") is not the basis for the partial year, so when
   * the results carry the current year its own months are named exactly. Where the rows carry no
   * month identities at all, the limitation is stated rather than a range guessed — and only where a
   * partial period is actually in play, never on an ordinary complete-year answer, a refusal or a
   * failure.
   */


  if (opts.tab === "current") {
    const currentYear = new Date().getFullYear();
    explanation = normalizeCurrentPartialYearMetric(explanation, opts.question, opts.sql, currentYear);
    const partialYearNote = currentPartialYearNote(opts.question, opts.sql, opts.rows, returnedPeriod);
    if (partialYearNote && !hasCurrentPartialDisclosure(explanation, currentYear)) {
      explanation = appendSentence(explanation, partialYearNote);
    }
  }

  if (opts.tab === "current") {
    const missingMonthNote = currentMissingMonthNote(opts.question, opts.rows);
    if (missingMonthNote) {
      explanation = removeMissingMonthClaim(explanation, missingMonthNote);
      explanation = appendSentence(explanation, missingMonthNote);
    }
  }

  explanation = alignThroughYearWithRows(explanation, opts.question, opts.rows);

  explanation = withReturnedCoverage(explanation, opts.question, opts.sql, opts.rows);

  const period = yearRangeFromRows(opts.rows) || yearRangeFromSql(opts.sql);
  if (period) {
    explanation = explanation.replace(/\bfor an unknown time period\b/gi, `for ${period}`);
  }

  if (!hasYearMention(explanation)) {
    if (period) explanation = appendSentence(explanation, `Period: ${period}.`);
  }

  // ── Increment 2 (Decision 10 sibling): a mixed police/court request ──
  // The referent core lets a mixed request through so the police half is answered. The
  // reader still needs to be told the court half was left out rather than overlooked.
  if (classifyClearanceReferent(opts.question).referent === "mixed"
      && !/court and corrections part/i.test(explanation)) {
    explanation = appendSentence(explanation, MIXED_REFERENT_NOTE);
  }

  // ── Increment 4 (Decision 10): say which agency the figures came from ──
  // Placed before the empty-state guard so that a replaced empty-state message still
  // carries the resolution note — the reader needs it either way.
  // ── The evidence-to-answer boundary (closure review §4) ──────────────────────
  //
  // Everything below reads the CARRIED RECORD only. It never re-parses the question for
  // identity, and it makes no factual agency claim once the state is a failure or unknown.
  // That ordering is the point: the previous version governed the failure wording and then
  // appended a sheriff claim underneath it.
  const evidence: AnswerEvidence = {
    resultState: opts.resultState ?? null,
    resolvedAgencies: opts.resolvedAgency ? [opts.resolvedAgency] : [],
    returnedIdentities: establishIdentities(opts.rows),
    requestedAgencies: multiAgencyRequestFromQuestion(opts.question),
    hasFigures: Array.isArray(opts.rows) && opts.rows.length > 0,
  };

  // 1. Govern the state first. A failure replaces the narrative outright; for a populated
  // result an unsupported unit is removed and the rest of the answer survives.
  //
  // `hasFigures` is the row-presence fact this function already computes two lines above for
  // `mayAssertAgencyFacts`. Not passing it was the GC-073 defect: a 35-row answer was
  // discarded because `genericResultState` reports `unknown` for every successful result.
  if (opts.resultState) {
    const guarded = guardEmptyStateWording(explanation, opts.resultState, { hasFigures: evidence.hasFigures });
    if (guarded.blocked) explanation = guarded.safeText;
  }

  // 2. Factual agency claims, only when the state permits one.
  if (mayAssertAgencyFacts(evidence)) {
    const requested = evidence.requestedAgencies ?? [];
    const returned = evidence.returnedIdentities ?? [];

    if (requested.length >= 2) {
      // Check EACH requested member individually against established identities.
      const check = checkRequestedMembers(requested, returned);
      if (check.allPresent && returned.length >= 2) {
        const d = describeMultiAgency(check.present);
        if (d.required && !/reported separately/i.test(explanation)) {
          explanation = appendSentence(explanation, d.sentence);
        }
      } else if (check.absent.length > 0) {
        const names = check.absent.map(a => a.agencyName);
        explanation = appendSentence(explanation,
          `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} not represented separately in these results, ` +
          `so this is not a side-by-side comparison of every agency you named.`);
      }
    } else if (evidence.resolvedAgencies && evidence.resolvedAgencies.length > 0) {
      // A resolver established this. Question text never substitutes for it.
      explanation = applyAgencyDisclosure(explanation, evidence.resolvedAgencies[0]);
    } else if (countyRequestFromQuestion(opts.question)) {
      // A county was asked for and nothing resolved it: state the limitation, claim nothing.
      const county = countyRequestFromQuestion(opts.question)!;
      explanation = appendSentence(explanation,
        `I can't confirm from these results which agency was used for ${county.requested}, so I'm not going to ` +
        `state the scope. Name the agency you want and I'll use it.`);
    }
  }

  /*
   * A ranking should say how many results it was limited to, so the reader knows the list is a top
   * slice rather than everything. The limit comes from the EXECUTED statement's single outer LIMIT
   * -- never a CTE's own limit, never a default inferred from the question, and never the number of
   * rows that came back. When there is no single outer limit to report, nothing is claimed.
   *
   * Placed after the empty-state guard on purpose: a refusal or blocked answer has no ranking to
   * describe, and `hasFigures` being false means there is no top slice to announce.
   */
  if (evidence.hasFigures) {
    // The question is passed so the same level-ranking family boundary applies here: a chronological
    // or per-period result is ordered and limited too, and must not be described as a ranking.
    const limitSentence = rankingLimitSentence(opts.sql, opts.question);
    if (limitSentence) explanation = appendSentence(explanation, limitSentence);
  }

  return explanation;
}
