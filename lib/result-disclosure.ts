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
  return /\bnibrs_consistent_reporters\b/i.test(sql) ||
    (/\bnibrs_agency_completeness\b/i.test(sql) && /\bmonths_reported\s*=\s*12\b/i.test(sql));
}

function normalizeContinuousReportingExplanation(explanation: string): string {
  return explanation
    .replace(/\bwith incomplete coverage\b/gi, "with continuous reporting")
    .replace(/\bcities with incomplete coverage\b/gi, "agencies with continuous reporting")
    .replace(/\bacross (?:the )?cit(?:y|ies)\b/gi, "across continuously reporting agencies")
    .replace(/\bacross the requested cities\b/gi, "across continuously reporting agencies")
    .replace(/\bfor the requested cities\b/gi, "for continuously reporting agencies")
    .replace(/\bfrom the requested cities\b/gi, "from continuously reporting agencies")
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

function normalizeEntity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function extractRequestedEntitiesFromSql(sql: string): string[] {
  const entities: string[] = [];
  const inRe = /\b(?:city|agency|agency_name|state)\s+IN\s*\(([^)]*)\)/gi;
  let inMatch;
  while ((inMatch = inRe.exec(sql)) !== null) {
    const quoted = inMatch[1].match(/'([^']+)'/g) || [];
    for (const q of quoted) entities.push(q.slice(1, -1));
  }

  const eqRe = /\b(?:city|agency|agency_name|state)\s*=\s*'([^']+)'/gi;
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
        values.add(normalizeEntity(String(value)));
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
  let explanation = opts.explanation;
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
    }

    if (usesContinuousReportingFilter(opts.sql)) {
      explanation = normalizeContinuousReportingExplanation(explanation);
      explanation = appendSentence(
        explanation,
        "Coverage filter: Results are restricted to agencies that reported all 12 months in every requested year. These are individual reporting agencies, not geographic totals; this improves year-to-year comparability but is not a national estimate."
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
    const missingMonthNote = currentMissingMonthNote(opts.question, opts.rows);
    if (missingMonthNote) {
      explanation = removeMissingMonthClaim(explanation, missingMonthNote);
      explanation = appendSentence(explanation, missingMonthNote);
    }
  }

  if (!hasYearMention(explanation)) {
    const period = yearRangeFromRows(opts.rows) || yearRangeFromSql(opts.sql);
    if (period) explanation = appendSentence(explanation, `Period: ${period}.`);
  }

  return explanation;
}
