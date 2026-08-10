import { HISTORICAL, NIBRS } from "./dynamic-facts";

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
  // Plurals matter: "clearances by type" is the common phrasing, and without the
  // optional s it fell through to the annual-crime branch, which reports the wrong
  // cutoff year and the wrong label.
  if (/\b(?:clearances?|cleared|clear(?:ed)?\s+by\s+arrest|exceptional)\b/i.test(question)) {
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

  // A clearance question this tab cannot answer is usually answerable next door,
  // and breaking clearances down by type is only possible there. Gated on NIBRS
  // actually covering the year rather than assuming every future year exists.
  const nibrsSuggestion = label === "clearance data" && requestedYear <= NIBRS.maxYear
    ? ` The NIBRS Explorer tab has clearance data through ${NIBRS.maxYear}, and is the only source that can break clearances down by type — try this question there.`
    : "";

  return {
    requestedYear,
    maxYear,
    label,
    explanation: `Historical Library currently has ${label} through ${maxYear}, so it cannot answer ${requestedYear}.${currentSuggestion}${nibrsSuggestion} If you want the latest complete Historical result, ask for ${maxYear} or earlier.`,
  };
}
