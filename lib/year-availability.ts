import { HISTORICAL } from "./dynamic-facts";

export interface HistoricalYearAvailability {
  requestedYear: number;
  maxYear: number;
  label: string;
  explanation: string;
}

export function explicitYears(question: string): number[] {
  const years = new Set<number>();
  for (const match of question.matchAll(/\b(19\d{2}|20\d{2}|2100)\b/g)) {
    const year = Number(match[1]);
    if (year >= 1900 && year <= 2100) years.add(year);
  }
  return [...years].sort((a, b) => a - b);
}

export function historicalMaxYearForQuestion(question: string): { maxYear: number; label: string; canUseCurrent: boolean } {
  if (/\b(?:staff(?:ing)?|officers?|sworn|police\s+force|cops?)\b/i.test(question)) {
    return { maxYear: HISTORICAL.staffingMaxYear, label: "staffing data", canUseCurrent: false };
  }
  if (/\b(?:clearance|cleared|clear(?:ed)?\s+by\s+arrest|exceptional)\b/i.test(question)) {
    return { maxYear: HISTORICAL.clearanceMaxYear, label: "clearance data", canUseCurrent: false };
  }
  return { maxYear: HISTORICAL.crimeMaxYear, label: "annual crime data", canUseCurrent: true };
}

export function historicalYearAvailability(question: string): HistoricalYearAvailability | null {
  const years = explicitYears(question);
  if (years.length === 0) return null;

  const requestedYear = Math.max(...years);
  const { maxYear, label, canUseCurrent } = historicalMaxYearForQuestion(question);
  if (requestedYear <= maxYear) return null;
  const spansAvailableHistoricalYears = years.length >= 2 && Math.min(...years) <= maxYear;
  if (label === "annual crime data" && spansAvailableHistoricalYears) return null;

  const currentSuggestion = canUseCurrent
    ? ` For ${requestedYear} partial-year monthly data, use Current Trends.`
    : "";

  return {
    requestedYear,
    maxYear,
    label,
    explanation: `Historical Library currently has ${label} through ${maxYear}, so it cannot answer ${requestedYear}.${currentSuggestion} If you want the latest complete Historical result, ask for ${maxYear} or earlier.`,
  };
}
