import {
  NIBRS_UCR_PROPERTY_LABEL,
  NIBRS_UCR_VIOLENT_LABEL,
} from "./nibrs-codes";
import {
  explicitStateSubstateMismatch,
  filteredEntityLabel,
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

function usesNibrsDvReportingPopulationRate(sql: string): boolean {
  return /\bsummary_domestic_violence\b/i.test(sql) &&
    /\bnibrs_agency_completeness\b/i.test(sql) &&
    /\bagencies\b/i.test(sql) &&
    (/\breporting_population\b/i.test(sql) ||
      /\brate_per_100k\b/i.test(sql) ||
      /\bSUM\s*\(\s*\w+\.population\s*\*\s*\w+\.months_reported\s*\/\s*12\.0\s*\)/i.test(sql));
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
  return /\bviolent crime\b/i.test(question) &&
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

function normalizeEntity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
        const normalized = normalizeEntity(String(value));
        values.add(normalized);
        if (normalized === "st louis") values.add("saint louis");
        if (normalized === "saint louis") values.add("st louis");
        if (normalized === "charlotte") values.add("charlotte mecklenburg");
        if (normalized === "nashville") values.add("metropolitan nashville");
        if (normalized === "las vegas") {
          values.add("las vegas metro pd");
          values.add("las vegas metropolitan");
        }
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

function comparisonColumnLabels(rows: Record<string, unknown>[]): string[] {
  if (rows.length === 0) return [];
  const columns = Object.keys(rows[0]);
  return columns
    .filter((column) => !COMPARISON_EXCLUDED_COLUMNS.has(column.toLowerCase()))
    .filter((column) => !isGenericMetricColumn(column))
    .filter((column) => rows.some((row) => isNumericLike(row[column])))
    .map(labelFromComparisonColumn);
}

function comparisonDisclosure(explanation: string, rows: Record<string, unknown>[]): string | null {
  const labels = comparisonColumnLabels(rows);
  if (labels.length < 2) return null;

  const normalizedExplanation = explanation.toLowerCase();
  if (labels.every((label) => normalizedExplanation.includes(label.toLowerCase()))) return null;

  return `Comparison includes: ${labels.join(", ")}.`;
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

function monthPointsFromRows(rows: Record<string, unknown>[]): { year: number; month: number }[] {
  const yearCol = ["year", "data_year", "Year"].find((c) => rows[0]?.[c] !== undefined);
  const monthCol = ["month", "Month"].find((c) => rows[0]?.[c] !== undefined);
  if (!yearCol || !monthCol) return [];
  return rows
    .map((r) => ({ year: Number(r[yearCol]), month: Number(r[monthCol]) }))
    .filter((p) => Number.isFinite(p.year) && Number.isFinite(p.month) && p.month >= 1 && p.month <= 12)
    .sort((a, b) => a.year - b.year || a.month - b.month);
}

function returnedMonthRange(rows: Record<string, unknown>[]): string | null {
  const points = monthPointsFromRows(rows);
  if (points.length === 0) return null;
  const lo = points[0];
  const hi = points[points.length - 1];
  if (lo.year === hi.year) return `${MONTH_NAMES[lo.month - 1]}-${MONTH_NAMES[hi.month - 1]} ${hi.year}`;
  return `${MONTH_NAMES[lo.month - 1]} ${lo.year}-${MONTH_NAMES[hi.month - 1]} ${hi.year}`;
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

function currentPartialYearNote(
  question: string,
  sql: string,
  rows: Record<string, unknown>[],
  returnedPeriod: string | null,
): string | null {
  const currentYear = new Date().getFullYear();
  if (!hasCurrentYearSignal(question, sql, rows, currentYear)) return null;

  const rateish = /\b(?:rates?|per\s+capita|per\s*100k|per\s*100,000)\b/i.test(question) ||
    /\b(?:rate|per_100k|per_capita)\b/i.test(sql);
  const metric = rateish ? "rate" : "total";
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

export function applyResultDisclosures(opts: {
  explanation: string;
  question: string;
  sql: string;
  rows: Record<string, unknown>[];
  tab?: string;
}): string {
  let explanation = normalizeClearanceRateExplanation(opts.explanation, opts.sql);
  const agencyDescriptor = stripUngroundedAgencyDescriptors(explanation, opts.question, opts.rows);
  explanation = agencyDescriptor.explanation;
  if (agencyDescriptor.changed) {
    explanation = appendSentence(
      explanation,
      "Descriptor correction: Ungrounded agency-type labels were removed because they were not present in the question or returned rows."
    );
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

  const comparison = comparisonDisclosure(explanation, opts.rows);
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
  const currentReturnedPeriod = opts.tab === "current" ? returnedMonthRange(opts.rows) : null;
  const returnedPeriod = ytd || currentReturnedPeriod;
  if (returnedPeriod && !new RegExp(returnedPeriod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(explanation)) {
    explanation = appendSentence(explanation, `Returned period: ${returnedPeriod}.`);
  }

  if (opts.tab === "current") {
    const partialYearNote = currentPartialYearNote(opts.question, opts.sql, opts.rows, returnedPeriod);
    if (partialYearNote && !hasCurrentPartialDisclosure(explanation, new Date().getFullYear())) {
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

  const period = yearRangeFromRows(opts.rows) || yearRangeFromSql(opts.sql);
  if (period) {
    explanation = explanation.replace(/\bfor an unknown time period\b/gi, `for ${period}`);
  }

  if (!hasYearMention(explanation)) {
    if (period) explanation = appendSentence(explanation, `Period: ${period}.`);
  }

  return explanation;
}
