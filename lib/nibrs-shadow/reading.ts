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
import { isCommonEnglishWord } from "../english-common-words";

export type Reading = { kind: "spelling" | "phrase" | "period"; from: string; to: string };
export type Composite = "firearm" | "knife";
export type Span = { from: string; to: string };
/** A change between two periods (the shadow attaches it as a period_comparison). `matched`: the same months each year. */
export type Comparison = { earlier: Span; later: Span; matched: boolean };
export type Flags = { readings: Reading[]; forecast: boolean; court: boolean; offenders: boolean; composite: Composite | null;
  undefinedTerm: "shooters" | "gun violence" | null; comparison: Comparison | null; last12: boolean; combined: boolean; largeCities: boolean;
  /** A Census region named ("the Northeast"): read as the nation, flagged; only Current Trends answers it (current.ts REGIONS). */
  region: "noe" | "mdw" | "sth" | "wst" | null;
  /** A circumstance named ("gang-related murders"): element 31's codes, a filter on the victims (null when none). */
  circumstance: string[] | null;
  /** "According to NIBRS": the source asked for in words is used and labelled (P01). */
  nibrsAsked: boolean;
  /** "Only agencies that reported every month": P61's consistent-reporters view. */
  consistent: boolean;
  /** Murders by a Homicide Report detail (the victim-offender relationship): Homicide Reports' (P53). */
  shrDetail: boolean;
  /** "Where a firearm was stolen": property on one segment, its description and loss type (increment 6). */
  property: { what: string; loss: string } | null;
  /** Increment 6: arrests reached through the incident ("arrests ... for incidents that included a robbery"). */
  arrestsThrough: { offense: string | null } | null;
  /**
   * Clearance wording (P64, P66): a breakdown by status (cleared / uncleared) or type (by arrest / exceptional A-E /
   * uncleared), a selection (cleared, by arrest, exceptionally, uncleared) or the share cleared. The shadow builds it.
   */
  clearance: { by: "status" | "type" | null; only: "cleared" | "arrest" | "exceptional" | "uncleared" | null; share: boolean } | null;
  /** Increment 7: people wording, read here and built by the shadow (reading the `People` type). */
  people: People | null;
  /** Increment 7b (P71): "by quarter", "quarterly": monthly counts summed into quarters by the shadow. */
  quarter: boolean;
  /** Increment 7b (P72): a supporting column beside the answer, the population a rate divides by or the agencies reporting. */
  column: "population" | "agencies" | "both" | null };
/** A person's attribute a question names. */
export type PersonAttr = "sex" | "race" | "ethnicity" | "age";
/**
 * Increment 7 (P29, P30, P44, P49, P65): a breakdown by an offender's or arrestee's attribute (`paired`: only the
 * offenders linked to each victim, named by the question); conditions on a person (an age range; for offenders, a
 * relationship to the victim); or a word policy asks about ("young adults" P30, "attackers" P44).
 */
export type People = {
  by: { who: "offender" | "arrestee"; attr: PersonAttr; paired: boolean } | null;
  where: ({ who: "victim" | "offender" | "arrestee"; attr: "age"; range: [number, number]; paired: boolean } | { who: "offender"; attr: "relationship"; values: string[]; paired: true })[];
  ask: "young adults" | "attackers" | "victims or offenders" | null;
  /** A person named for a unit that does not record them ("arrests ... by victim race"): declined, never re-read. */
  unsupported?: string;
};
export type ReadQuestion = Flags & { question: string; text: string; ledger: RequestLedger & Flags };

const PHRASES: [RegExp, string][] = [
  [/\bthefts?\s+from\s+(?:a\s+|the\s+|their\s+)?(?:motor\s+vehicles?|vehicles?|cars?|automobiles?|autos?|trucks?)\b/gi, "theft from motor vehicle"],
  [/\b(?:vehicle|auto|automobile|truck)\s+break[-\s]?ins?\b/gi, "car break-ins"],
  [/\bcar\s+jack(?:ing|ings|ed)\b/gi, "carjackings"],
  // A victim breakdown asked as its categories: "victims ... were male or female" -> "victims ... by sex". Only victims,
  // and only "were": "committed by men and women" is about offenders and is left alone (Codex increment-1 review).
  [/\b(victims?\b[^?.!]*?\s)were\s+(?:(?:males?|men)\s+(?:or|and|vs\.?|versus)\s+(?:females?|women)|(?:females?|women)\s+(?:or|and|vs\.?|versus)\s+(?:males?|men))\b/gi, "$1by sex"],
  // P29: "against men and women" names the victims -> by victim sex (named, so a bare "by sex" is not asked about).
  [/\bagainst\s+(?:(?:males?|men)\s+(?:or|and|vs\.?|versus)\s+(?:females?|women)|(?:females?|women)\s+(?:or|and|vs\.?|versus)\s+(?:males?|men))\b/gi, "by victim sex"],
  // A category and a time grain joined by "and", in either order: "by race and year", "by year and age" -> "by race by
  // year", "by age by year" (coordinator 2026-11-02: "by age and year" had dropped the year).
  [/\bby\s+(race|sex|gender|ethnicity|age(?:\s+groups?)?|weapons?|relationships?|location(?:\s+type)?)\s+(?:and|&)\s+(?:by\s+)?(year|month|quarter)\b/gi, "by $1 by $2"],
  [/\bby\s+(year|month|quarter)\s+(?:and|&)\s+(?:by\s+)?(race|sex|gender|ethnicity|age(?:\s+groups?)?|weapons?|relationships?|location(?:\s+type)?)\b/gi, "by $2 by $1"],
  // Periods in everyday words, read once for every source (coordinator 2026-11-02): a decade ("in the 1990s", "the 90s",
  // "the 2010s") is its ten years; "the last decade" is the past 10 years; "after 2010" starts with 2011.
  [/\b(?:in\s+|during\s+)?the\s+(19[0-9]|20[0-2])0'?s\b/gi, "from $10 to $19"],
  [/\b(?:in\s+|during\s+)?the\s+'?([5-9])0'?s\b/gi, "from 19$10 to 19$19"],
  [/\b(?:in|over|during)\s+the\s+(?:last|past)\s+decade\b/gi, "over the past 10 years"],
  [/\bafter\s+((?:19|20)\d{2})\b/gi, (_m: string, y: string) => `since ${Number(y) + 1}`] as unknown as [RegExp, string],
  // Everyday names of a crime (the sources' vocabulary, lib/answer-contract PROFILES): "stolen cars" are motor vehicle thefts.
  [/\bstolen\s+(?:cars|vehicles|autos)\b/gi, "motor vehicle thefts"],
  // Misspellings seen in the Historical tab's real questions (query-log step one, 2026-11-02).
  [/\bhomo?cides?\b/gi, (m: string) => (m.toLowerCase().endsWith("s") ? "homicides" : "homicide")] as unknown as [RegExp, string],
  [/\bauto\s*thefts?\b/gi, "auto theft"],
  [/\bagg\.?\s+ass(?:au|ua)lt(s?)\b|\baggravated\s+assualt(s?)\b/gi, (_m: string, a: string, b: string) => `aggravated assault${a || b || ""}`] as unknown as [RegExp, string],
  // Misspellings in the whole query log (coordinator 2026-11-05) that the slip rule doesn't read: changed letters, and
  // short words with a dropped letter. Not "aggravates", a verb ("What aggravates assault ...": Codex spelling review 01).
  [/\bmuder(s?)\b/gi, (m: string, s: string) => `${m[0] === "M" ? "Murder" : "murder"}${s}`] as unknown as [RegExp, string],
  [/\brobery\b/gi, (m: string) => (m[0] === "R" ? "Robbery" : "robbery")] as unknown as [RegExp, string],
  // "aggrevated" only: "aggrevates" is the verb, misspelled (Codex spelling review 04).
  [/\baggrevated\b/gi, (m: string) => (m[0] === "A" ? "Aggravated" : "aggravated")] as unknown as [RegExp, string],
  [/\bv(?:lolent|ilont|iolant|ilolent)\b/gi, (m: string) => (m[0] === "V" ? "Violent" : "violent")] as unknown as [RegExp, string],
  [/\bckearance\b/gi, (m: string) => (m[0] === "C" ? "Clearance" : "clearance")] as unknown as [RegExp, string],
  [/\bmoter(\s+vehicle)/gi, (m: string, v: string) => `${m[0] === "M" ? "Motor" : "motor"}${v}`] as unknown as [RegExp, string],
  // Places' nicknames, read once for every source (coordinator 2026-11-02); the crosswalk's place names ("New York City")
  // are aliases in the shared place index (lib/nibrs-shadow/places.ts), not here.
  [/\bphilly\b/gi, "Philadelphia"],
  [/\bnola\b/gi, "New Orleans"],
  // "NY" for a place (not after a place it qualifies, "Suffern (NY)", "Rochester NY"): New York, which asks between the
  // city and the state (P26); "NY city" is the city.
  [/\bny\s+city\b/gi, "New York City"],
  [/(?<![A-Z][a-z]+,?\s)(?<![(,]\s?)\b(?:NY|ny|Ny)\b(?!\s*\))/g, "New York"],
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
  // The words the query log's typos aimed at (coordinator 2026-11-05, misspelling cluster): "cirme", "muders", "citites".
  "crime", "crimes", "murder", "violent", "cities", "county", "offender", "offenders", "clearance", "weapons", "percentages",
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
/** The words of the state names, which a short misspelling is never read as. */
const STATE_WORDS = new Set(Object.values(STATE_NAME_BY_CODE).flatMap((n) => n.toLowerCase().split(/\s+/)));
/** English words one slip from a crime word that the common-word list lacks. */
const REAL_WORDS = new Set(["violet", "sates", "cites", "crimp", "crimps", "counts", "country", "assets"]);
/** The one vocabulary word a misspelled word is a single slip from, or null (none, two, or a short word). */
export function nearestWord(word: string): string | null {
  const w = word.toLowerCase();
  // Five letters or more when the word isn't English ("cirme", "muders"); an English word one slip from a crime word
  // stays as written ("sates", "violet").
  if (w.length < 5 || VOCAB.includes(w) || (w.length < 7 && (isCommonEnglishWord(w) || REAL_WORDS.has(w)))) return null;
  // Under seven letters, only a swapped pair ("cirme", "cirmes"): an added or dropped letter makes other words
  // ("grapes" is not "rapes", "cries" is not "crimes": Codex spelling reviews 01-02). The dropped-letter typos the log
  // has ("muders", "robery") are read by name above. And only onto a crime word, never a state ("amine" is not Maine:
  // Codex spelling review 05).
  const at = VOCAB.filter((v) => oneSlip(w, v) && (w.length >= 7 || (w.length === v.length && !STATE_WORDS.has(v))));
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
/** P61's consistent-reporters wording ("only agencies that reported every month"): read here, and removed by the
 * answer contract to give the all-agencies question. */
/** "according to NIBRS": the source asked for in words (P01). */
export const NIBRS_WORDS = /,?\s*\b(?:according\s+to|from|in|per)\s+(?:the\s+)?(?:NIBRS|National\s+Incident[-\s]Based\s+Reporting\s+System)\b/i;
export const CONSISTENT_WORDS = /,?\s*\b(?:(?:counting\s+)?only\s+(?:the\s+)?agencies\s+that\s+reported\s+(?:every|all|each)\s+(?:\d+\s+)?months?(?:\s+of\s+the\s+(?:year|period))?|consistent(?:ly)?\s+reporting\s+agencies|only\s+consistent\s+reporters|(?:for|among|with)\s+(?:the\s+)?(?:consistent|continuous)(?:ly)?\s+(?:reporters|reporting\s+agencies))\b/i;

export function readQuestion(question: string, currentYear: number, lastMonth?: string): ReadQuestion {
  const readings: Reading[] = [];
  let text = question;
  const cmp = readComparison(text, currentYear);
  if (cmp) { readings.push({ kind: "period", from: cmp.from, to: cmp.text }); text = cmp.text; }
  // "Memphis vs Nashville": places compared are places side by side, as with "and" (coordinator, 2026-11-01). A period
  // comparison ("2024 vs 2023") was read just above; a "vs" next to a year is left to it.
  text = text.replace(/(?<!\b(?:19|20)\d{2})\s+(?:vs\.?|versus|compared (?:to|with))\s+(?!(?:19|20)\d{2}\b)/gi, " and ");
  // P08: "large Texas cities" -> Texas cities of 250,000+, flagged; the reader reads the rest.
  let largeCities = false;
  text = text.replace(/\b(?:large|big)\s+(?=(?:[A-Z][a-zA-Z]+\s+){0,2}cit(?:y|ies)\b)/i, (m) => { largeCities = true; readings.push({ kind: "phrase", from: m.trim(), to: "(a population of 250,000 or more)" }); return ""; });
  // A Census region (Current Trends' groups; coordinator 2026-11-03): "the Northeast", "the midwest US", "southern
  // states". Read as the nation and flagged, so the shadow answers it from Current Trends or says it can't; never "the
  // South Side", "South Carolina" or "West Memphis".
  // Circumstances (NIBRS data element 31, coordinator 2026-11-04): a victim's murder or aggravated assault circumstance,
  // read as a filter and taken out of the words. Domestic violence is a relationship, not read here (blocked until the
  // DV gap note); "drug-related" is left to the drug crimes.
  let circumstance: string[] | null = null;
  for (const [re, codes, name] of [
    [/\b(?:gang[-\s]?(?:related|involved|motivated)|gangland)\s*/gi, ["04", "05"], "gang-related"],
    [/\bdrug[-\s]?deal(?:ing|er)[-\s]?related\s*|\bdrug[-\s]?dealing[-\s]related\s*|\bin\s+drug\s+deals?\b|\bover\s+drug\s+deals?\b/gi, ["03"], "drug dealing"],
    // Whole words, and only "from", "during" or "over" an argument (Codex circumstance review 01.2: "arrests in arguments",
    // "argumentative").
    [/\b(?:argument[-\s]related|(?:from|during|over)\s+(?:an\s+)?arguments?)\b\s*/gi, ["01"], "an argument"],
    [/\b(?:during|in\s+the\s+course\s+of)\s+(?:another|other)\s+felon(?:y|ies)\s*|\bfelony[-\s]related\s*/gi, ["08"], "another felony"],
  ] as [RegExp, string[], string][]) {
    text = text.replace(re, (m) => { circumstance = [...(circumstance ?? []), ...codes]; readings.push({ kind: "phrase", from: m.trim(), to: `(circumstance: ${name})` }); return ""; });
  }
  let region: Flags["region"] = null;
  const REGION_CODE: Record<string, NonNullable<Flags["region"]>> = { northeast: "noe", midwest: "mdw", south: "sth", west: "wst" };
  text = text.replace(/\b(?:in\s+)?(?:the\s+)?(north[\s-]?east|mid[\s-]?west|south|west)(?:ern)?\s+(?:region|u\.?s\.?|united\s+states|states)\b|\b(?:in\s+)?the\s+(north[\s-]?east|mid[\s-]?west|south|west)\b(?=\s*$|\s*[?.,!]|\s+(?:by|in|since|from|during|over|for|between|this|last|so|per|year|month)\b)|\b(?:in\s+)?(?:the\s+)?(north[\s-]?east|mid[\s-]?west)(?:ern)?\b(?!\s+(?:city|county|township|village|town|heights|park|borough)\b|\s*,)/i,
    (m, a?: string, b?: string, c?: string) => {
      region = REGION_CODE[(a ?? b ?? c ?? "").toLowerCase().replace(/[\s-]/g, "")];
      readings.push({ kind: "phrase", from: m.trim(), to: "a Census region" });
      return " in the United States";
    });
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
  const NIBRS_ASKED = NIBRS_WORDS;
  const nibrsAsked = NIBRS_ASKED.test(own);
  if (nibrsAsked) text = text.replace(NIBRS_ASKED, "");
  const CONSISTENT = CONSISTENT_WORDS;
  const consistent = CONSISTENT.test(own);
  if (consistent) text = text.replace(CONSISTENT, "");
  const shrDetail = /\b(?:murders?|homicides?)\b/i.test(own) && /\bvictim[-\s]offender\s+relationships?\b/i.test(own);
  // Increment 6: "where a firearm was stolen", "where the vehicle was recovered": one property segment's description
  // and loss type. The reader is not asked to apply them.
  const PROPERTY = /,?\s*\b(?:where|in\s+which|with)\s+(?:a|an|the)?\s*(firearms?|guns?|vehicles?|cars?)\s+(?:was|were|being)\s+(stolen|recovered|seized|damaged)\b/i;
  const pm = PROPERTY.exec(own);
  // A car is an automobile (03); a vehicle is any motor vehicle description (Codex increment-6 review 02.2).
  const property = pm ? { what: /fire|gun/i.test(pm[1]) ? "firearm" : /car/i.test(pm[1]) ? "car" : "vehicle", loss: pm[2].toLowerCase() } : null;
  if (property) text = text.replace(PROPERTY, "");
  // Increment 6: arrests reached through the incident (P50, P68): every arrest on an incident with the condition,
  // whatever its arrest offense; read as all-crime arrests, the condition applied by the shadow.
  const THROUGH = /^\s*arrests\s+(.+?)\s+for\s+incidents(?:\s+(?:that|which)\s+(?:included|involved|had)\s+(?:a|an)\s+([a-z][a-z ]*?))?\s*\??\s*$/i;
  const tm = THROUGH.exec(text);
  const arrestsThrough = tm ? { offense: tm[2] ? tm[2].trim().toLowerCase().replace(/\s+/g, "_") : null } : null;
  if (tm) text = `All crime arrests ${tm[1]}`;
  // Increment 6: clearance wording (P64, P66) is read here, never by the reader (whose clearance tables are the live
  // app's). "Clearance rate" stays the reader's (P57 routes a Part I rate to the historical figures).
  let clearance: Flags["clearance"] = null;
  const set = (c: Partial<NonNullable<Flags["clearance"]>>) => { clearance = { by: null, only: null, share: false, ...clearance, ...c }; };
  let cm: RegExpExecArray | null;
  if ((cm = /^\s*what\s+(?:share|percent(?:age)?|proportion|fraction)\s+of\s+(.+?)\s+(?:were|was)\s+cleared\b\s*\??\s*$/i.exec(text))) { text = cm[1]; set({ share: true, only: "cleared" }); }
  if ((cm = /^\s*how\s+many\s+(.+?)\s+(?:were|was)\s+cleared(?:\s+by\s+(arrest|exceptional\s+means))?\s*\??\s*$/i.exec(text))) {
    text = `how many ${cm[1]}`; set({ only: !cm[2] ? "cleared" : /arrest/i.test(cm[2]) ? "arrest" : "exceptional" });
  }
  text = text.replace(/,?\s*\b(?:that\s+were\s+|which\s+were\s+)?cleared\s+by\s+(arrest|exceptional\s+means)\b/i, (_m, how: string) => (set({ only: /arrest/i.test(how) ? "arrest" : "exceptional" }), ""));
  text = text.replace(/\b(?:uncleared|unsolved|not\s+cleared)\s+/i, () => (set({ only: "uncleared" }), ""));
  text = text.replace(/,?\s*\b(?:that\s+were|which\s+were)\s+not\s+cleared\b/i, () => (set({ only: "uncleared" }), ""));
  // In a list with another breakdown: "by year and clearance status", "by clearance type and month".
  const kind = (w: string) => (/type/i.test(w) ? "type" : "status");
  text = text.replace(/(\bby\s+(?:year|month))\s+and\s+(?:by\s+)?clearance(\s+(?:status|type))?\b(?!\s+rate)/i, (_m, by: string, w = "") => (set({ by: kind(w) }), by));
  text = text.replace(/\bby\s+clearance(\s+(?:status|type))?\s+and\s+(?:by\s+)?(year|month)\b/i, (_m, w = "", t: string) => (set({ by: kind(w) }), `by ${t}`));
  text = text.replace(/,?\s*\bby\s+(?:clearance\s+type|type\s+of\s+clearance|how\s+(?:they\s+were|it\s+was)\s+cleared)\b/i, () => (set({ by: "type" }), ""));
  text = text.replace(/,?\s*\bby\s+clearance(?:\s+status)?\b(?!\s+rate)/i, () => (set({ by: "status" }), ""));
  text = text.replace(/,?\s*\b(?:that\s+were|which\s+were)\s+cleared\b/i, () => (set({ only: "cleared" }), ""));
  // Increment 7: people wording (P29, P30, P44, P49, P65). Read here, built by the shadow; the reader reads the rest.
  const pr = readPeople(text);
  // Any rewrite here ("by victim race" -> "by race") is read again by the accounting, flag or not (Codex 05).
  const peopleRewrote = pr.text !== text;
  text = pr.text;
  const people = pr.people;
  // "By juveniles" is now read (an offender age condition), so it is no longer an unread offender group.
  const offendersLeft = offenders && !(people && people.where.some((w) => w.who === "offender"));
  // Increment 7b (P71): quarters are sums of months: read as "by month", the quarters built by the shadow.
  let quarter = false;
  text = text.replace(/\b(?:by|per|each)\s+quarter\b|\bquarterly\b/i, () => { quarter = true; return "by month"; });
  // Increment 7b (P72): the rewriter's column wording, built by the shadow beside the answer.
  // Both columns together are not built: "both" is declined, never one of them dropped (Codex 7b-04.4).
  let column: Flags["column"] = null;
  const col = (c: "population" | "agencies") => { column = column && column !== c ? "both" : c; return ""; };
  text = text.replace(/,?\s*with a column showing the population used to calculate the rate\b/gi, () => col("population"))
    .replace(/,?\s*with the number of agencies reporting\b/gi, () => col("agencies"))
    // The same request in other words (coordinator 2026-11-02): "how many agencies reported carjackings in ...",
    // "agencies reporting carjackings in ...", "..., with coverage": the agencies reporting and the population covered.
    .replace(/^\s*how many (?:law enforcement )?agencies (?:reported|report|submitted)\s+/i, () => col("agencies"))
    .replace(/^\s*(?:the )?(?:number of )?(?:law enforcement )?agencies reporting\s+/i, () => col("agencies"))
    .replace(/,?\s*with (?:its |the |their )?(?:coverage|population covered|agencies reporting(?: and (?:the )?population covered)?)\b/gi, () => col("agencies"));
  const flags: Flags = { readings, forecast, court, offenders: offendersLeft, composite, undefinedTerm, comparison: cmp?.comparison ?? null, last12, combined, largeCities, region, circumstance, nibrsAsked, consistent, shrDetail, property, clearance, arrestsThrough, people, quarter, column };
  const ledger = Object.assign(readings.length || combined || nibrsAsked || consistent || property || clearance || arrestsThrough || people || peopleRewrote || quarter || column ? accountNibrsRequest(text) : first, flags);
  return { question, text, ...flags, ledger };
}

const JUV = String.raw`(?:juveniles?|minors?|teens?|teenagers?|youths?|kids|children)`;
const UNDER18: [number, number] = [1, 17];
const ATTR = (w: string): PersonAttr => (/^(?:sex|gender)$/i.test(w) ? "sex" : /^race$/i.test(w) ? "race" : /^ethnicity$/i.test(w) ? "ethnicity" : "age");
/**
 * Increment 7: the question's people wording, removed from the text the reader reads:
 *   "by the race of the offender(s) who killed (attacked, robbed ...) them"  -> by linked offender race (P65: named pairing);
 *   "by offender (arrestee) race / sex / ethnicity / age (group)"            -> by that attribute (P29, P49);
 *   "<crime> offenders ... by sex (age ...)" and "arrests ... by race"         -> the counted person's own attribute;
 *   "by juveniles" / "against juveniles"                                     -> an offender (any of the incident, P49) or
 *                                                                               victim under 18 (P29, P30);
 *   "juvenile victims / arrests / offenders"                                 -> that person under 18;
 *   "victims of offenders who were under 18"                                 -> a linked offender under 18 (P65);
 *   "offenders ... where the victim was a stranger"                          -> offenders linked as a stranger;
 *   "young adults" (P30) and "attackers" (P44)                               -> asked about;
 *   "arrests in <place>" with no crime                                       -> every arrest ("all crime arrests").
 */
function readPeople(text0: string): { text: string; people: People | null } {
  let text = text0;
  const p: People = { by: null, where: [], ask: null };
  const cut = (re: RegExp, f: (m: RegExpExecArray) => void) => { const m = re.exec(text); if (!m) return false; f(m); text = text.replace(m[0], " ").replace(/\s+([,?.!])/g, "$1").replace(/\s{2,}/g, " ").trim(); return true; };
  cut(/,?\s*\b(?:committed\s+)?by\s+young\s+adults?\b/i, () => { p.ask = "young adults"; });
  if (/\battackers?\b/i.test(text)) p.ask = "attackers";
  cut(/,?\s*\bby\s+the\s+(race|sex|gender|ethnicity|age)\s+of\s+(?:the\s+)?offenders?\s+who\s+(?:killed|murdered|attacked|assaulted|robbed|raped|shot|stabbed|victimized)\s+(?:them|him|her)\b/i,
    (m) => { p.by = { who: "offender", attr: ATTR(m[1]), paired: true }; });
  if (!p.by) cut(/,?\s*\bby\s+(?:the\s+)?(offenders?|arrestees?)(?:'s|s')?\s+(race|sex|gender|ethnicity|age)(?:\s+groups?)?\b/i,
    (m) => { p.by = { who: /^arrestee/i.test(m[1]) ? "arrestee" : "offender", attr: ATTR(m[2]), paired: false }; });
  // "By race of the offender(s)" is "by offender race" (Jeff 2026-11-08: the two wordings match, "by offender race"
  // the reading): what is counted stays the question's own (murder victims, or offenders when it counts offenders).
  // Offenders only: "by age of arrestee" stays the arrests' own breakdown, as before.
  if (!p.by) cut(/,?\s*\bby\s+(?:the\s+)?(race|sex|gender|ethnicity|age)(?:\s+groups?)?\s+of\s+(?:the\s+|their\s+)?offenders?\b(?!\s+who\b)/i,
    (m) => { p.by = { who: "offender", attr: ATTR(m[1]), paired: false }; });
  // "By victim race": the victims' own breakdown, as the reader writes it ("by race"); for arrests the victim is not
  // recorded, so it is declined, never read as the arrestee's (Codex 04.2).
  const vm = /,?\s*\bby\s+(?:the\s+)?victims?(?:'s|s')?\s+(race|sex|gender|ethnicity|age)\b/i.exec(text);
  if (vm && /\barrest(?:s|ed|ee|ees)?\b/i.test(text)) cut(new RegExp(vm[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), () => { p.unsupported = `a victim's ${vm[1].toLowerCase()} for arrests`; });
  else if (vm) text = text.replace(vm[0], ` by ${vm[1]}`);
  // The counted person's own attribute: offenders by sex or age (the reader's own breakdown, left to it), arrests by race.
  if (!p.by && /^\s*(?:all\s+crime\s+)?arrests\b|\barrests\s+in\b/i.test(text))
    cut(/,?\s*\bby\s+(race|sex|gender|ethnicity|age)(?:\s+groups?)?\b/i, (m) => { p.by = { who: "arrestee", attr: ATTR(m[1]), paired: false }; });
  // "Committed by" names the offenders: "murders in D.C. in 2025 committed by race", "... by race committed by", "murder
  // comited by blacks ... seperated by sex" break down by the offenders' attribute, never the victims' (coordinator
  // 2026-11-09, found live on /redesign). The "committed (by)" words go with it.
  // Only "committed by" names who committed it: "by race committed against women" names the victims, not the
  // offenders (Codex gap-2 review 01.1).
  const COMMITTED = /\b(?:comm?itt?ed|perpetrated)\s+by\b/i;
  if (!p.by && !vm && COMMITTED.test(text)
    && cut(/,?\s*\b(?:(?:comm?itt?ed|perpetrated)\s+)?by\s+(?:the\s+)?(race|sex|gender|ethnicity|age)(?:\s+groups?)?(?:\s+(?:comm?itt?ed|perpetrated)(?:\s+by)?(?=\s*$|\s*[?.!,]))?/i,
      (m) => { p.by = { who: "offender", attr: ATTR(m[1]), paired: false }; }))
    text = text.replace(/\s+(?:comm?itt?ed|perpetrated)\s+by\s*(?=[?.!]?\s*$)/i, "").trim();
  // A bare "by race (sex, ethnicity, age)" naming no person ("murders in D.C. in 2025 by race"): victims' or offenders'
  // is asked, never assumed (coordinator 2026-11-08, scoring gap 1; the labels' "victim or offender race").
  // "Committed by ..." (as typed: "comited by blacks asians hispanics ...") names the offenders (runner job G,
  // QL-shr-34ce1c60e0).
  if (!p.by && !p.ask && !vm && !/\b(?:victims?|offenders?|arrest(?:s|ed|ee|ees)?|suspects?|perpetrators?)\b|\b(?:comm?itt?ed|perpetrated)\s+by\b/i.test(text)
    && /\bby\s+(?:the\s+)?(?:race|sex|gender|ethnicity|age)\b/i.test(text)) p.ask = "victims or offenders";
  // Only when offenders are what is counted ("offenders in aggravated assaults ..."); for victims the reader's own
  // "by strangers" applies.
  if (/^\s*(?:[a-z]+\s+){0,2}?offenders\b/i.test(text))
    cut(/,?\s*\bwhere\s+the\s+victim\s+was\s+a\s+stranger\b/i, () => { p.where.push({ who: "offender", attr: "relationship", values: ["ST"], paired: true }); });
  cut(/\bof\s+offenders?\s+who\s+(?:was|were)\s+(?:under|younger\s+than)\s+18\b/i, () => { p.where.push({ who: "offender", attr: "age", range: UNDER18, paired: true }); });
  cut(new RegExp(String.raw`,?\s*\b(?:committed\s+)?by\s+${JUV}\b`, "i"), () => { p.where.push({ who: "offender", attr: "age", range: UNDER18, paired: false }); });
  cut(new RegExp(String.raw`,?\s*\bagainst\s+${JUV}\b`, "i"), () => { p.where.push({ who: "victim", attr: "age", range: UNDER18, paired: false }); });
  cut(/\b(?:juvenile|youth|teen(?:age)?|minor)\s+(?=(?:[a-z]+\s+){0,3}?(victims|arrests|offenders)\b)/i, (m) => {
    const noun = /^\s*\S+\s+(?:[a-z]+\s+){0,3}?(victims|arrests|offenders)\b/i.exec(text.slice(m.index))?.[1].toLowerCase();
    p.where.push({ who: noun === "arrests" ? "arrestee" : noun === "offenders" ? "offender" : "victim", attr: "age", range: UNDER18, paired: false });
  });
  // Every arrest, with no crime named.
  if (/^\s*arrests\s+(?:in|for)\s+(?=[A-Z])/.test(text) || /^\s*arrests\s+in\b/i.test(text)) text = text.replace(/^\s*arrests\b/i, "All crime arrests");
  const any = p.by || p.where.length || p.ask || p.unsupported;
  return { text, people: any ? p : null };
}

/** Words of the question that only carry a forecast or a court outcome: an alternative drops these and nothing else. */
export const FORECAST_TEXT = /^(?:\s|\b(?:will|would|can|could|you|please|what|be|is|are|it|the|in|for|of|to|forecast\w*|predict\w*|projection\w*|projected|expected|going|go|up|down|rise|rising|increase|increasing|fall|falling|drop|decrease|decline|happen|look|next|year)\b)+$/i;
export const COURT_TEXT = /^(?:\s|\b(?:led|lead|leads|resulted|result|results|went|go|goes|going|gone|sent|were|was|to|in|a|an|the|trial|trials|sentenc\w*|acquit\w*|plea\w*|guilty|conviction\w*|convicted|charged|charges|filed|brought|people|for|with)\b)+$/i;

/** How a rewrite is disclosed in an answer: only spellings change what the user typed into another word. */
export const readingSentence = (r: Reading) => `Read "${r.from}" as ${r.to}.`;
