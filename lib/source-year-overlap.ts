import { HISTORICAL, NIBRS, RTCI, SHR } from "./dynamic-facts";
import { explicitYears } from "./year-availability";

export type OverlapSource = "current" | "historical" | "nibrs" | "shr" | "hate_crime";

interface RequestedYearRange {
  startYear: number;
  endYear: number | null;
}

export interface SourceYearRange {
  startYear: number;
  endYear: number;
  label: string;
}

export interface SourceYearOverlap {
  requestedStartYear: number;
  requestedEndYear: number | null;
  sourceStartYear: number;
  sourceEndYear: number;
  overlapStartYear: number;
  overlapEndYear: number;
  hasOverlap: boolean;
  partial: boolean;
  label: string;
}

function requestedYearRange(question: string): RequestedYearRange | null {
  const text = question.replace(/\s+/g, " ");

  const bounded = text.match(
    /\b(?:from|between)\s+(19\d{2}|20\d{2}|2100)\s+(?:to|through|thru|and|-)\s+(19\d{2}|20\d{2}|2100)\b/i
  ) || text.match(/\b(19\d{2}|20\d{2}|2100)\s*(?:-|to|through|thru)\s*(19\d{2}|20\d{2}|2100)\b/i);
  if (bounded) {
    const a = Number(bounded[1]);
    const b = Number(bounded[2]);
    return { startYear: Math.min(a, b), endYear: Math.max(a, b) };
  }

  const fromToPresent = text.match(
    /\bfrom\s+(19\d{2}|20\d{2}|2100)\s+(?:to|through|thru|-)\s+(?:present|now|today|current|latest|date)\b/i
  );
  if (fromToPresent) {
    return { startYear: Number(fromToPresent[1]), endYear: null };
  }

  const openEnded = text.match(/\b(?:since|starting|beginning)\s+(?:in\s+)?(19\d{2}|20\d{2}|2100)\b/i);
  if (openEnded) {
    return { startYear: Number(openEnded[1]), endYear: null };
  }

  const years = explicitYears(question);
  if (years.length === 0) return null;
  return { startYear: years[0], endYear: years[years.length - 1] };
}

function historicalRangeForQuestion(question: string): SourceYearRange {
  if (/\b(?:staff(?:ing)?|officers?|sworn|police\s+force|cops?)\b/i.test(question)) {
    return {
      startYear: HISTORICAL.staffingMinYear,
      endYear: HISTORICAL.staffingMaxYear,
      label: "Historical staffing data",
    };
  }
  if (/\b(?:clearance|cleared|clear(?:ed)?\s+by\s+arrest|exceptional)\b/i.test(question)) {
    return {
      startYear: HISTORICAL.clearanceMinYear,
      endYear: HISTORICAL.clearanceMaxYear,
      label: "Historical clearance data",
    };
  }
  return {
    startYear: HISTORICAL.crimeMinYear,
    endYear: HISTORICAL.crimeMaxYear,
    label: "Historical annual crime data",
  };
}

export function sourceYearRange(source: OverlapSource, question: string): SourceYearRange {
  switch (source) {
    case "current":
      return { startYear: RTCI.minYear, endYear: RTCI.maxYear, label: "Current Trends" };
    case "historical":
      return historicalRangeForQuestion(question);
    case "nibrs":
      return { startYear: NIBRS.minYear, endYear: NIBRS.maxYear, label: "NIBRS" };
    case "shr":
      return { startYear: SHR.minYear, endYear: SHR.maxYear, label: "Homicide Reports" };
    case "hate_crime":
      return { startYear: 1991, endYear: new Date().getFullYear() - 1, label: "Hate Crime" };
  }
}

export function sourceYearOverlap(source: OverlapSource, question: string): SourceYearOverlap | null {
  const requested = requestedYearRange(question);
  if (!requested) return null;

  const available = sourceYearRange(source, question);
  const requestedEnd = requested.endYear ?? available.endYear;
  const overlapStartYear = Math.max(requested.startYear, available.startYear);
  const overlapEndYear = Math.min(requestedEnd, available.endYear);
  const hasOverlap = overlapStartYear <= overlapEndYear;
  const partial = hasOverlap && (
    requested.startYear < available.startYear ||
    (requested.endYear !== null && requested.endYear > available.endYear)
  );

  return {
    requestedStartYear: requested.startYear,
    requestedEndYear: requested.endYear,
    sourceStartYear: available.startYear,
    sourceEndYear: available.endYear,
    overlapStartYear,
    overlapEndYear,
    hasOverlap,
    partial,
    label: available.label,
  };
}

function looksLikeAvailabilityRefusal(explanation: string | null | undefined): boolean {
  if (!explanation) return false;
  const text = explanation.replace(/\s+/g, " ");
  const hasCoverageLanguage = /\b(?:data|coverage|available|availability|starts?|began|begin|before|after|through|reported|reporting|year range|years?)\b/i.test(text);
  const hasYear = /\b(?:19|20)\d{2}\b/.test(text);
  return hasCoverageLanguage && hasYear;
}

export function partialCoverageRetryPrompt(
  source: OverlapSource,
  question: string,
  explanation: string | null | undefined
): string | null {
  const overlap = sourceYearOverlap(source, question);
  if (!overlap?.hasOverlap || !overlap.partial || !looksLikeAvailabilityRefusal(explanation)) {
    return null;
  }

  const requestedEnd = overlap.requestedEndYear ?? "the latest available year";
  return `[SYSTEM: Your previous response refused because part of the requested year range is outside coverage. The requested range (${overlap.requestedStartYear}-${requestedEnd}) partially overlaps ${overlap.label} coverage (${overlap.sourceStartYear}-${overlap.sourceEndYear}). Generate SQL for the overlapping years ${overlap.overlapStartYear}-${overlap.overlapEndYear} now. Preserve the user's requested geography, offense, metric, and breakdowns. Do not refuse solely because earlier or later requested years are unavailable; run the overlap and disclose the omitted years. Only return sql:null if there is truly no overlap.]`;
}
