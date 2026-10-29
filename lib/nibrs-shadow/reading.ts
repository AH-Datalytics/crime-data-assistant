/**
 * The shadow reader's pre-pass: a thin layer in front of today's request accounting (lib/nibrs-request-accounting.ts,
 * unchanged). It rewrites a few general forms of wording into words the accounting already reads, records every rewrite
 * as a reading on the ledger, and flags two question kinds the accounting has no concept for. It holds no copy of the
 * reader's logic: promoting it is moving these rules into the accounting, not rewriting them.
 *
 *   spelling   a word the accounting could not read, within a small edit distance of exactly one vocabulary word (the
 *              reader's own crime words and state names), is read as that word; two near words, or none, leave it
 *              unread. Short words are never corrected.
 *   phrase     inflected or reordered names of crimes the reader knows: "thefts from cars", "vehicle break-ins",
 *              "car jackings". Only onto existing measures.
 *   period     "year to date", "so far this year", "this year (so far)", "so far in <year>" -> that year, which the
 *              release clips to its latest month; the answer names the months covered (D06).
 *   forecast   "will ... rise / go up / fall / be", "next year", "forecast", "predict" (a question about the future; P20).
 *              "Will" about a year the data already holds is not a forecast.
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
];
const YTD = /\b(?:so\s+far\s+this\s+year|this\s+year\s+so\s+far|year\s+to\s+date|ytd|this\s+year)\b|\bso\s+far\s+in\s+(\d{4})\b/gi;
const FORECAST_WORDS = /\b(?:forecasts?|predict(?:ion|ions|ed)?|project(?:ion|ions|ed)?)\b|\bnext\s+year\b|\bgoing\s+to\s+(?:go\s+up|rise|increase|fall|drop|decrease|decline)\b/i;
const WILL = /\bwill\b[^?.!]*\b(?:go\s+up|go\s+down|rise|increase|fall|drop|decrease|decline|be|happen|look)\b/i;
const COURT = /\b(?:(?:went|go|goes|going|gone|sent)\s+to\s+trial|trials?|sentenc(?:ed|es|ing)|acquit(?:ted|tals?)|plea(?:ded|d)?\s+guilty|guilty\s+pleas?)\b/i;

/** The words a misspelling may be read as: the reader's crime words and state names. */
const VOCAB = [...new Set([
  ...Object.values(MEASURE_LABEL).flatMap((l) => l.toLowerCase().split(/\s+/)),
  "shoplifting", "carjacking", "carjackings", "assault", "assaults", "robbery", "robberies", "burglary", "burglaries", "theft", "thefts",
  "murders", "homicides", "rapes", "arsons", "larceny", "narcotics", "possession", "offenses", "victims", "arrests", "incidents",
  ...Object.values(STATE_NAME_BY_CODE).flatMap((n) => n.toLowerCase().split(/\s+/)),
])].filter((w) => w.length >= 5);

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);   // a swap
  }
  return d[a.length][b.length];
}
/** The one vocabulary word a misspelled word is near, or null (none near, or two equally near). */
export function nearestWord(word: string): string | null {
  const w = word.toLowerCase();
  if (w.length < 5 || VOCAB.includes(w)) return null;
  const reach = w.length >= 8 ? 2 : 1;
  const near = VOCAB.map((v) => [v, distance(w, v)] as const).filter(([, d]) => d <= reach);
  const best = Math.min(...near.map(([, d]) => d));
  const at = near.filter(([, d]) => d === best);
  return at.length === 1 ? at[0][0] : null;
}

export function readQuestion(question: string, currentYear: number): ReadQuestion {
  const readings: Reading[] = [];
  let text = question;
  for (const [re, to] of PHRASES) text = text.replace(re, (m) => (readings.push({ kind: "phrase", from: m, to }), to));
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
  const years = [...question.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const futureYear = years.some((y) => y > currentYear);
  const forecast = FORECAST_WORDS.test(question) || (WILL.test(question) && (!years.length || futureYear));
  const court = COURT.test(question);
  const ledger = Object.assign(readings.length ? accountNibrsRequest(text) : first, { readings, forecast, court });
  return { question, text, readings, forecast, court, ledger };
}

/** How a rewrite is disclosed in an answer: only spellings change what the user typed into another word. */
export const readingSentence = (r: Reading) => `Read "${r.from}" as ${r.to}.`;
