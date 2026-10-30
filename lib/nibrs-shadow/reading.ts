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
 *              "car jackings". Only onto existing measures. A victim breakdown asked as its categories ("victims ...
 *              were male or female") or with "and" before a time grain ("by race and year") -> the reader's "by sex",
 *              "by race by year".
 *   period     "year to date", "so far this year", "this year (so far)", "so far in <year>" -> that year, which the
 *              release clips to its latest month; the answer names the months covered (D06). "next year" -> the year
 *              after this one, a period after the data (P24), when nothing in the question predicts.
 *   forecast   predictive wording: "forecast", "predict", "projection", "expected to", "going to rise", "will ... rise /
 *              go up / fall / be" (P20). "Will" about a year the data already holds is not a forecast; nor is a future
 *              year alone.
 *   court      trials, sentences, prosecutions, acquittals, pleas, charges: court outcomes and charging decisions the data
 *              does not record (D01, P46). The accounting already reads convictions, defendants and prosecutions.
 *   composite  P31's named composites, read as the crimes they count, each with the weapon: "gun crime" -> murders,
 *              robberies and aggravated assaults with a firearm; "stabbings" -> murders and aggravated assaults with a
 *              knife or cutting instrument. The weapon is the composite's (`composite`), applied by the shadow.
 *   arrested   P48: "people (were) arrested for <crime>" -> "<crime> arrests".
 *   undefined  terms the data does not define, declined by decided policy: "shooters" (P45), "gun violence" (P31: the
 *              data has no counts of non-fatal shootings).
 *   comparison a change between two periods, asked in any of these forms, is recorded as `comparison` (its earlier and
 *              later periods), and the question is passed on as the same count over the whole span; the shadow
 *              attaches the comparison:
 *                "(percent) change in X from 2022 to 2024";
 *                "X in 2024 compared with (to, vs) 2023";
 *                "X January through June 2024 compared with January through June 2023" (the same months each year);
 *                "did X go up (rise, fall ...) ... in 2025" -> 2024 against 2025 (P54: the year before);
 *                "is X up this year compared with last year" -> last year against this year, `matched` (the same
 *                months, D06/D17, through the latest reported month).
 *   last 12    "over (in, during) the last (past) 12 months" -> the 12 months ending at the release's latest month (P56),
 *              `last12`: one total.
 *   places     "combined", "together", "altogether" with several places -> `combined` (one total of the agencies).
 *              "large" or "big" before "cities" -> `largeCities` (P08: 250,000 residents or more), the word removed.
 */
import type { RequestLedger } from "../request-accounting";
import { accountNibrsRequest } from "../nibrs-request-accounting";
import { MEASURE_LABEL, STATE_NAME_BY_CODE } from "../nibrs-question-types";

export type Reading = { kind: "spelling" | "phrase" | "period"; from: string; to: string };
export type Composite = "firearm" | "knife";
export type Span = { from: string; to: string };
/** A change between two periods (the shadow attaches it as a period_comparison). `matched`: the same months each year. */
export type Comparison = { earlier: Span; later: Span; matched: boolean };
export type Flags = { readings: Reading[]; forecast: boolean; court: boolean; offenders: boolean; composite: Composite | null;
  undefinedTerm: "shooters" | "gun violence" | null; comparison: Comparison | null; last12: boolean; combined: boolean; largeCities: boolean;
  /** "According to NIBRS": the source asked for in words is used and labelled (P01). */
  nibrsAsked: boolean;
  /** "Only agencies that reported every month": P61's consistent-reporters view. */
  consistent: boolean;
  /** Murders by a Homicide Report detail (the victim-offender relationship): Homicide Reports' (P53). */
  shrDetail: boolean;
  /** "Where a firearm was stolen": property on one segment, its description and loss type (increment 6). */
  property: { what: string; loss: string } | null };
export type ReadQuestion = Flags & { question: string; text: string; ledger: RequestLedger & Flags };

const PHRASES: [RegExp, string][] = [
  [/\bthefts?\s+from\s+(?:a\s+|the\s+|their\s+)?(?:motor\s+vehicles?|vehicles?|cars?|automobiles?|autos?|trucks?)\b/gi, "theft from motor vehicle"],
  [/\b(?:vehicle|auto|automobile|truck)\s+break[-\s]?ins?\b/gi, "car break-ins"],
  [/\bcar\s+jack(?:ing|ings|ed)\b/gi, "carjackings"],
  // A victim breakdown asked as its categories: "victims ... were male or female" -> "victims ... by sex". Only victims,
  // and only "were": "committed by men and women" is about offenders and is left alone (Codex increment-1 review).
  [/\b(victims?\b[^?.!]*?\s)were\s+(?:(?:males?|men)\s+(?:or|and|vs\.?|versus)\s+(?:females?|women)|(?:females?|women)\s+(?:or|and|vs\.?|versus)\s+(?:males?|men))\b/gi, "$1by sex"],
  // P29: "against men and women" names the victims -> by (victim) sex.
  [/\bagainst\s+(?:(?:males?|men)\s+(?:or|and|vs\.?|versus)\s+(?:females?|women)|(?:females?|women)\s+(?:or|and|vs\.?|versus)\s+(?:males?|men))\b/gi, "by sex"],
  // A category and a time grain joined by "and": "by race and year" -> "by race by year".
  [/\bby\s+(race|sex|gender|ethnicity|location(?:\s+type)?)\s+and\s+(year|month)\b/gi, "by $1 by $2"],
  // P48: people arrested for a crime are its arrests.
  [/\bpeople\s+(?:were\s+|got\s+|have\s+been\s+)?arrested\s+for\s+([a-z][a-z ]*?)(?=\s+(?:in|during|from|since)\b|\s*[?.!]|\s*$)/gi, "$1 arrests"],
];
/** P31's composites: the crimes each counts, and its weapon. */
const COMPOSITES: [RegExp, string, Composite][] = [
  [/\bgun\s+crimes?\b/gi, "murders, robberies and aggravated assaults", "firearm"],
  [/\bstabbings?\b/gi, "murders and aggravated assaults", "knife"],
];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON = `(${MONTH_NAMES.join("|")})`;
const VS = String.raw`(?:compared\s+(?:with|to)|vs\.?|versus|against)`;
const RISE = String.raw`(?:go(?:ne)?\s+up|go(?:ne)?\s+down|rise|risen|increase|increased|decrease|decreased|fall|fallen|drop|dropped|climb|climbed|decline|declined)`;
const two = (n: number) => String(n).padStart(2, "0");
const yearSpan = (y: number): Span => ({ from: `${y}-01`, to: `${y}-12` });
/** "Theft ..." from "theft ..." after a removed lead. */
const lead = (t: string) => t.replace(/^\s*([a-z])/, (_, c: string) => c.toUpperCase());
const SHOOTERS = /\bshooters?\b/i;
const GUN_VIOLENCE = /\bgun\s+violence\b/i;
const YTD = /\b(?:so\s+far\s+this\s+year|this\s+year\s+so\s+far|year\s+to\s+date|ytd|this\s+year)\b|\bso\s+far\s+in\s+(\d{4})\b/gi;
const NEXT_YEAR = /\bnext\s+year\b/gi;
const FORECAST_WORDS = /\b(?:forecast\w*|predict\w*|projection\w*|projected|expected\s+to)\b|\bgoing\s+to\s+(?:go\s+up|go\s+down|rise|increase|fall|drop|decrease|decline)\b/i;
const WILL = /\bwill\b[^?.!]*\b(?:go\s+up|go\s+down|rise|increase|fall|drop|decrease|decline|be|happen|look)\b/i;
/** P29: "by <group>" names the offenders ("assaults by men and women", "committed by juveniles"). */
const BY_GROUP = /\b(?:committed\s+|perpetrated\s+)?by\s+(?:(?:males?|men|females?|women)(?:\s+(?:or|and|vs\.?|versus)\s+(?:males?|men|females?|women))?|juveniles?|adults?|minors?|teens?|teenagers?|youths?)\b/i;
const COURT = /\b(?:(?:went|go|goes|going|gone|sent)\s+to\s+trial|trials?|sentenc(?:ed|es|ing)|acquit(?:ted|tals?)|plea(?:ded|d)?\s+guilty|guilty\s+pleas?|charged|charges?\s+(?:filed|brought))\b/i;

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

/** A comparison asked in one of the forms above: its periods, and the question as a count over the whole span. */
function readComparison(text: string, currentYear: number): { comparison: Comparison; text: string; from: string } | null {
  let m: RegExpExecArray | null;
  // "(percent) change in X from 2022 to 2024"
  if ((m = new RegExp(String.raw`\b(?:percent(?:age)?\s+)?change\s+in\s+(.+?)\s+from\s+(\d{4})\s+(?:to|through)\s+(\d{4})\b`, "i").exec(text)) && Number(m[2]) < Number(m[3]))
    return { comparison: { earlier: yearSpan(Number(m[2])), later: yearSpan(Number(m[3])), matched: false }, from: m[0], text: text.replace(m[0], lead(`${m[1]} from ${m[2]} to ${m[3]}`)) };
  // "X January through June 2024 compared with January through June 2023"
  if ((m = new RegExp(String.raw`\b(?:in\s+|from\s+)?${MON}\s+(?:through|to|-)\s+${MON}\s+(\d{4})\s+${VS}\s+(?:the\s+same\s+months\s+(?:of|in)\s+|${MON}\s+(?:through|to|-)\s+${MON}\s+)?(\d{4})\b`, "i").exec(text))) {
    const [a, b] = [MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1, MONTH_NAMES.indexOf(m[2].toLowerCase()) + 1];
    const same = !m[4] || (m[4].toLowerCase() === m[1].toLowerCase() && m[5].toLowerCase() === m[2].toLowerCase());
    const [later, earlier] = [Number(m[3]), Number(m[6])];
    if (!same || a > b || earlier >= later) return null;
    return { comparison: { earlier: { from: `${earlier}-${two(a)}`, to: `${earlier}-${two(b)}` }, later: { from: `${later}-${two(a)}`, to: `${later}-${two(b)}` }, matched: true },
      from: m[0], text: text.replace(m[0], `from ${earlier} to ${later}`) };
  }
  // "X in 2024 compared with 2023"
  if ((m = new RegExp(String.raw`\bin\s+(\d{4})\s+${VS}\s+(?:in\s+)?(\d{4})\b`, "i").exec(text)) && Number(m[2]) < Number(m[1]))
    return { comparison: { earlier: yearSpan(Number(m[2])), later: yearSpan(Number(m[1])), matched: false }, from: m[0], text: text.replace(m[0], `from ${m[2]} to ${m[1]}`) };
  // "is X up this year compared with last year" (P54/D06: the same months, through the latest reported month)
  if ((m = new RegExp(String.raw`^\s*(?:is|are|has|have)\s+(.+?)\s+(?:been\s+)?(?:up|down|higher|lower|rising|falling)\s+this\s+year\s+(?:${VS}|than)\s+last\s+year\s*\??\s*$`, "i").exec(text)))
    return { comparison: { earlier: yearSpan(currentYear - 1), later: yearSpan(currentYear), matched: true }, from: m[0], text: lead(`${m[1]} from ${currentYear - 1} to ${currentYear}`) };
  // "did X go up ... in 2025" (P54: against the year before)
  if ((m = new RegExp(String.raw`^\s*(?:did|has|have)\s+(.+?)\s+${RISE}\b\s*(.*?)\s*\bin\s+(\d{4})\s*\??\s*$`, "i").exec(text))) {
    const y = Number(m[3]);
    return { comparison: { earlier: yearSpan(y - 1), later: yearSpan(y), matched: false }, from: m[0], text: lead(`${m[1]}${m[2] ? ` ${m[2]}` : ""} from ${y - 1} to ${y}`) };
  }
  return null;
}

/**
 * `lastMonth`: the release's latest reported month (P52), for "the last 12 months" (P56); without it that wording is
 * left to the accounting.
 */
export function readQuestion(question: string, currentYear: number, lastMonth?: string): ReadQuestion {
  const readings: Reading[] = [];
  let text = question;
  const cmp = readComparison(text, currentYear);
  if (cmp) { readings.push({ kind: "period", from: cmp.from, to: cmp.text }); text = cmp.text; }
  // P08: "large Texas cities" -> Texas cities of 250,000+, flagged; the reader reads the rest.
  let largeCities = false;
  text = text.replace(/\b(?:large|big)\s+(?=(?:[A-Z][a-zA-Z]+\s+){0,2}cit(?:y|ies)\b)/i, (m) => { largeCities = true; readings.push({ kind: "phrase", from: m.trim(), to: "(250,000 residents or more)" }); return ""; });
  let last12 = false;
  const L12 = /\b(?:over|in|during|for)\s+the\s+(?:last|past|previous)\s+(?:12|twelve)\s+months\b/i;
  if (lastMonth && L12.test(text)) {
    const k = Number(lastMonth.slice(0, 4)) * 12 + Number(lastMonth.slice(5, 7)) - 1 - 11;
    const first = `${MONTH_NAMES[k % 12][0].toUpperCase()}${MONTH_NAMES[k % 12].slice(1)} ${Math.floor(k / 12)}`;
    const lastName = `${MONTH_NAMES[Number(lastMonth.slice(5, 7)) - 1][0].toUpperCase()}${MONTH_NAMES[Number(lastMonth.slice(5, 7)) - 1].slice(1)} ${lastMonth.slice(0, 4)}`;
    text = text.replace(L12, (m) => { const to = `from ${first} to ${lastName}`; readings.push({ kind: "period", from: m, to }); return to; });
    last12 = true;
  }
  for (const [re, to] of PHRASES) text = text.replace(re, (m) => {
    const t = m.replace(new RegExp(re.source, "i"), to);   // capture groups ("by $1 by $2") filled in
    readings.push({ kind: "phrase", from: m, to: t });
    return t;
  });
  let composite: Composite | null = null;
  for (const [re, to, weapon] of COMPOSITES) text = text.replace(re, (m) => {
    readings.push({ kind: "phrase", from: m, to });
    composite = weapon;
    return to;
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
  const offenders = BY_GROUP.test(own);
  const undefinedTerm = SHOOTERS.test(own) ? "shooters" : GUN_VIOLENCE.test(own) ? "gun violence" : null;
  // A future year with nothing predicting is a period after the data (P24), read as that year.
  if (!forecast) text = text.replace(NEXT_YEAR, (m) => (readings.push({ kind: "period", from: m, to: `in ${currentYear + 1}` }), `in ${currentYear + 1}`));
  // "Combined" is the flag's (one total of the named agencies); the reader is not asked to apply it.
  const combined = /\b(?:combined|together|altogether)\b/i.test(own);
  if (combined) text = text.replace(/\s*\b(?:combined|together|altogether)\b/gi, "");
  // Increment 5: words that choose a source or a cohort are flags, and the reader is not asked to apply them.
  const NIBRS_ASKED = /,?\s*\b(?:according\s+to|from|in|per)\s+(?:the\s+)?(?:NIBRS|National\s+Incident[-\s]Based\s+Reporting\s+System)\b/i;
  const nibrsAsked = NIBRS_ASKED.test(own);
  if (nibrsAsked) text = text.replace(NIBRS_ASKED, "");
  const CONSISTENT = /,?\s*\b(?:(?:counting\s+)?only\s+(?:the\s+)?agencies\s+that\s+reported\s+(?:every|all|each)\s+(?:\d+\s+)?months?(?:\s+of\s+the\s+(?:year|period))?|consistent(?:ly)?\s+reporting\s+agencies|only\s+consistent\s+reporters)\b/i;
  const consistent = CONSISTENT.test(own);
  if (consistent) text = text.replace(CONSISTENT, "");
  const shrDetail = /\b(?:murders?|homicides?)\b/i.test(own) && /\bvictim[-\s]offender\s+relationships?\b/i.test(own);
  // Increment 6: "where a firearm was stolen", "where the vehicle was recovered": one property segment's description
  // and loss type. The reader is not asked to apply them.
  const PROPERTY = /,?\s*\b(?:where|in\s+which|with)\s+(?:a|an|the)?\s*(firearms?|guns?|vehicles?|cars?)\s+(?:was|were|being)\s+(stolen|recovered|seized|damaged)\b/i;
  const pm = PROPERTY.exec(own);
  const property = pm ? { what: /fire|gun/i.test(pm[1]) ? "firearm" : "vehicle", loss: pm[2].toLowerCase() } : null;
  if (property) text = text.replace(PROPERTY, "");
  const flags: Flags = { readings, forecast, court, offenders, composite, undefinedTerm, comparison: cmp?.comparison ?? null, last12, combined, largeCities, nibrsAsked, consistent, shrDetail, property };
  const ledger = Object.assign(readings.length || combined || nibrsAsked || consistent || property ? accountNibrsRequest(text) : first, flags);
  return { question, text, ...flags, ledger };
}

/** Words of the question that only carry a forecast or a court outcome: an alternative drops these and nothing else. */
export const FORECAST_TEXT = /^(?:\s|\b(?:will|would|can|could|you|please|what|be|is|are|it|the|in|for|of|to|forecast\w*|predict\w*|projection\w*|projected|expected|going|go|up|down|rise|rising|increase|increasing|fall|falling|drop|decrease|decline|happen|look|next|year)\b)+$/i;
export const COURT_TEXT = /^(?:\s|\b(?:led|lead|leads|resulted|result|results|went|go|goes|going|gone|sent|were|was|to|in|a|an|the|trial|trials|sentenc\w*|acquit\w*|plea\w*|guilty|conviction\w*|convicted|charged|charges|filed|brought|people|for)\b)+$/i;

/** How a rewrite is disclosed in an answer: only spellings change what the user typed into another word. */
export const readingSentence = (r: Reading) => `Read "${r.from}" as ${r.to}.`;
