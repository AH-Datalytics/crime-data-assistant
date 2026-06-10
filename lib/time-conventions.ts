const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export interface YearRange {
  start: number;
  end: number;
}

export function currentCalendarYear(now = new Date()): number {
  return now.getFullYear();
}

export function lastCompleteCalendarYear(now = new Date()): number {
  return currentCalendarYear(now) - 1;
}

export function pastCompleteCalendarYearsRange(years: number, now = new Date()): YearRange {
  const end = lastCompleteCalendarYear(now);
  return { start: end - years + 1, end };
}

export function pastYearsIncludingCurrentRange(years: number, now = new Date()): YearRange {
  const end = currentCalendarYear(now);
  return { start: end - years + 1, end };
}

export function parsePastYearsCount(question: string): number | null {
  const numeric = question.match(/\b(?:past|last)\s+(\d{1,2})\s+years?\b/i);
  if (numeric) return Number(numeric[1]);

  const word = question.match(/\b(?:past|last)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\b/i);
  if (word) return WORD_NUMBERS[word[1].toLowerCase()] ?? null;

  return null;
}

export function asksToIncludeCurrentYear(question: string): boolean {
  return /\b(?:including|include)\s+(?:this|current)\s+year\b/i.test(question) ||
    /\b(?:to|through)\s+(?:present|date|today|now)\b/i.test(question) ||
    /\b(?:this year|current year|ytd|year[-\s]?to[-\s]?date|so far)\b/i.test(question);
}

export function relativeYearRangeForQuestion(question: string, now = new Date()): YearRange | null {
  const count = parsePastYearsCount(question);
  if (!count) return null;
  return asksToIncludeCurrentYear(question)
    ? pastYearsIncludingCurrentRange(count, now)
    : pastCompleteCalendarYearsRange(count, now);
}

export function relativeYearConventionPrompt(now = new Date()): string {
  const current = currentCalendarYear(now);
  const lastComplete = lastCompleteCalendarYear(now);
  const fiveComplete = pastCompleteCalendarYearsRange(5, now);
  const fiveIncludingCurrent = pastYearsIncludingCurrentRange(5, now);

  return `**Shared relative-year convention:** "past N years" and "last N years" mean the last N complete calendar years unless the user explicitly says "including this year", "this year", "YTD", "to date", or "to present". For example, in ${current}, "past 5 years" means ${fiveComplete.start}-${fiveComplete.end}; "past 5 years including this year" means ${fiveIncludingCurrent.start}-${fiveIncludingCurrent.end} and ${current} must be described as partial/preliminary. "Last year" means ${lastComplete}.`;
}
