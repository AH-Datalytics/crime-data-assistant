/**
 * The shadow reader's pre-pass: a thin layer in front of today's request accounting (lib/nibrs-request-accounting.ts,
 * unchanged). It rewrites a few general forms of wording into words the accounting already reads, records every rewrite
 * as a reading on the ledger, and flags two question kinds the accounting has no concept for. It holds no copy of the
 * reader's logic: promoting it is moving these rules into the accounting, not rewriting them.
 *
 *   spelling   a word the accounting could not read, of 7 letters or more, that is exactly one dropped, added or swapped
 *              letter away from exactly one vocabulary word (the reader's own crime words and state names), is read as
 *              that word. A changed letter is never corrected: "sample" is a word, not a misspelled "simple" (Codex
 *              review 2). Two near words, none, or a short word leave it unread.
 *   phrase     inflected or reordered names of crimes the reader knows: "thefts from cars", "vehicle break-ins",
 *              "car jackings". Only onto existing measures. A breakdown asked as its categories ("were male or
 *              female") or with "and" before a time grain ("by race and year") -> the reader's "by sex", "by race by year".
 *   period     "year to date", "so far this year", "this year (so far)", "so far in <year>" -> that year, which the
 *              release clips to its latest month; the answer names the months covered (D06). "next year" -> the year
 *              after this one, a period after the data (P24), when nothing in the question predicts.
 *   forecast   predictive wording: "forecast", "predict", "projection", "expected to", "going to rise", "will ... rise /
 *              go up / fall / be" (P20). "Will" about a year the data already holds is not a forecast; nor is a future
 *              year alone.
 *   court      trials, sentences, prosecutions, acquittals, pleas: court outcomes the data does not record (D01). The
 *              accounting already reads convictions, defendants and prosecutions.
 */
import type { RequestLedger } from "../request-accounting";
import { accountNibrsRequest } from "../nibrs-request-accounting";
import { MEASURE_LABEL, STATE_NAME_BY_CODE } from "../nibrs-question-types";

export type Reading = { kind: "spelling" | "phrase" | "period"; from: string; to: string };
export type ReadQuestion = { question: string; text: string; readings: Reading[]; forecast: boolean; court: boolean; ledger: RequestLedger & { readings: Reading[]; forecast: boolean; court: boolean } };

const PHRASES: [RegExp, string][] = [
  [/\bthefts?\s+from\s+(?:a\s+|the\s+|their\s+)?(?:motor\s+vehicles?|vehicles?|cars?|automobiles?|autos?|trucks?)\b/gi, "theft from motor vehicle"],
  [/\b(?:vehicle|auto|automobile|truck)\s+break[-\s]?ins?\b/gi, "car break-ins"],
  [/\bcar\s+jack(?:ing|ings|ed)\b/gi, "carjackings"],
  // A breakdown asked as its categories: "were male or female", "men or women" -> by sex.
  [/\b(?:were\s+)?(?:males?|men)\s+(?:or|and|vs\.?|versus)\s+(?:females?|women)\b|\b(?:were\s+)?(?:females?|women)\s+(?:or|and|vs\.?|versus)\s+(?:males?|men)\b/gi, "by sex"],
  // A category and a time grain joined by "and": "by race and year" -> "by race by year".
  [/\bby\s+(race|sex|gender|ethnicity|location(?:\s+type)?)\s+and\s+(year|month)\b/gi, "by $1 by $2"],
];
const YTD = /\b(?:so\s+far\s+this\s+year|this\s+year\s+so\s+far|year\s+to\s+date|ytd|this\s+year)\b|\bso\s+far\s+in\s+(\d{4})\b/gi;
const NEXT_YEAR = /\bnext\s+year\b/gi;
const FORECAST_WORDS = /\b(?:forecast\w*|predict\w*|projection\w*|projected|expected\s+to)\b|\bgoing\s+to\s+(?:go\s+up|go\s+down|rise|increase|fall|drop|decrease|decline)\b/i;
const WILL = /\bwill\b[^?.!]*\b(?:go\s+up|go\s+down|rise|increase|fall|drop|decrease|decline|be|happen|look)\b/i;
const COURT = /\b(?:(?:went|go|goes|going|gone|sent)\s+to\s+trial|trials?|sentenc(?:ed|es|ing)|acquit(?:ted|tals?)|plea(?:ded|d)?\s+guilty|guilty\s+pleas?)\b/i;

/** The words a misspelling may be read as: the reader's crime words and state names. */
const VOCAB = [...new Set([
  ...Object.values(MEASURE_LABEL).flatMap((l) => l.toLowerCase().split(/\s+/)),
  "shoplifting", "carjacking", "carjackings", "assault", "assaults", "robbery", "robberies", "burglary", "burglaries", "theft", "thefts",
  "murders", "homicides", "rapes", "arsons", "larceny", "narcotics", "possession", "offenses", "victims", "arrests", "incidents",
  ...Object.values(STATE_NAME_BY_CODE).flatMap((n) => n.toLowerCase().split(/\s+/)),
])].filter((w) => w.length >= 5);

/** One dropped, added or swapped letter (never a changed letter). */
function oneSlip(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) === 1) {
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    for (let i = 0; i < l.length; i++) if (s === l.slice(0, i) + l.slice(i + 1)) return true;
    return false;
  }
  if (a.length !== b.length || a === b) return false;
  const diff = [...a].map((c, i) => (c === b[i] ? -1 : i)).filter((i) => i >= 0);
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
}
/** The one vocabulary word a misspelled word is a single slip from, or null (none, two, or a short word). */
export function nearestWord(word: string): string | null {
  const w = word.toLowerCase();
  if (w.length < 7 || VOCAB.includes(w)) return null;
  const at = VOCAB.filter((v) => oneSlip(w, v));
  return at.length === 1 ? at[0] : null;
}

export function readQuestion(question: string, currentYear: number): ReadQuestion {
  const readings: Reading[] = [];
  let text = question;
  for (const [re, to] of PHRASES) text = text.replace(re, (m) => {
    const t = m.replace(new RegExp(re.source, "i"), to);   // capture groups ("by $1 by $2") filled in
    readings.push({ kind: "phrase", from: m, to: t });
    return t;
  });
  text = text.replace(YTD, (m, y) => {
    const to = `in ${y ?? currentYear}`;
    readings.push({ kind: "period", from: m, to });
    return to;
  });
  // Misspellings: only words the accounting could not read.
  const first = accountNibrsRequest(text);
  const unread = first.parts.filter((p) => p.state === "not-interpreted").flatMap((p) => p.text.match(/[A-Za-z]+/g) ?? []);
  for (const w of unread) {
    const to = nearestWord(w);
    if (!to) continue;
    readings.push({ kind: "spelling", from: w, to });
    text = text.replace(new RegExp(`\\b${w}\\b`), w[0] === w[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);
  }
  // Flags read only the question's own clause (a trailing "explain" clause is the accounting's clause 1).
  const own = first.parts.filter((p) => p.clause > 0).reduce((q, p) => q.replace(p.text, " "), question);
  const years = [...own.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const futureYear = years.some((y) => y > currentYear) || /\bnext\s+year\b/i.test(own);
  const forecast = FORECAST_WORDS.test(own) || (WILL.test(own) && (!years.length || futureYear));
  const court = COURT.test(own);
  // A future year with nothing predicting is a period after the data (P24), read as that year.
  if (!forecast) text = text.replace(NEXT_YEAR, (m) => (readings.push({ kind: "period", from: m, to: `in ${currentYear + 1}` }), `in ${currentYear + 1}`));
  const ledger = Object.assign(readings.length ? accountNibrsRequest(text) : first, { readings, forecast, court });
  return { question, text, readings, forecast, court, ledger };
}

/** Words of the question that only carry a forecast or a court outcome: an alternative drops these and nothing else. */
export const FORECAST_TEXT = /^(?:\s|\b(?:will|would|can|could|you|please|what|be|is|are|it|the|in|for|of|to|forecast\w*|predict\w*|projection\w*|projected|expected|going|go|up|down|rise|rising|increase|increasing|fall|falling|drop|decrease|decline|happen|look|next|year)\b)+$/i;
export const COURT_TEXT = /^(?:\s|\b(?:led|lead|leads|resulted|result|results|went|go|goes|going|gone|sent|to|in|a|an|the|trial|trials|sentenc\w*|acquit\w*|plea\w*|guilty|conviction\w*|convicted)\b)+$/i;

/** How a rewrite is disclosed in an answer: only spellings change what the user typed into another word. */
export const readingSentence = (r: Reading) => `Read "${r.from}" as ${r.to}.`;
