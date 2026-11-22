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
 *              data has no counts of non-fatal shootings), "gang" in any form (P38, Jeff 2026-11-09: gang involvement is
 *              loosely defined and inconsistently reported, so a count would mislead; for every source).
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

/** `meaning`: a loose word read as the meaning Jeff decided (P188); the answer says it ("Current is read as the latest complete year, 2025."). */
export type Reading = { kind: "spelling" | "phrase" | "period" | "meaning"; from: string; to: string };
export type Composite = "firearm" | "knife";
export type Span = { from: string; to: string };
/** What makes a question about all the cities more than a plain count or rate of one crime for one year (see the reader's all-cities rule). */
const NOT_PLAIN_SET = new RegExp(String.raw`\b(?:by\s+(?:month|year|quarter|week|day|sex|race|age|weapon|state|type)|per\s+(?:month|year|quarter)|monthly|yearly|annual\w*|quarterly|over\s+time|trend\w*|rolling|since|going\s+back|(?:each|every)\s+year|from\s+(?:19|20)\d{2}|(?:past|last|previous)\s+(?:\w+\s+)?years?|(?:19|20)\d{2}\s*(?:to|through|thru|-|–|and)\s*(?:19|20)\d{2}|sum|totals?|combined|altogether|overall|share|percent\w*|proportion|ratio|knife|sharp|firearm\w*|gun\w*|handgun\w*|weapon\w*|rifle|shotgun|officers?|staffing|staff|employees|sworn|[\d,]+\s+or\s+(?:more|fewer|less)|at\s+least|at\s+most|more\s+than|fewer\s+than|(?:over|under|above|below)\s+[\d,.]+\s*\w*|population|cleared|clearance|arrests?|teen\w*|juvenile|female|male|women|men|victims?\s+(?:aged|under|over)|compar\w*|vs|versus|against|than|others?|similar|peers?|like|beside|by\s+city|broken\s+down|breakdown|locations?|only|year[-\s]to[-\s]date|ytd|so\s+far|same\s+period|time\s+frame|same\s+time)\b`, "i");
/** The set size of "all cities": larger than any state's or the nation's count of cities of 250,000 or more. */
export const ALL_CITIES_N = 100000;
/** A change between two periods (the shadow attaches it as a period_comparison). `matched`: the same months each year. */
/** `change`: the question asks for the change in words ("percent change in ... from 2024 to 2025"), not only two periods side by side ("2022 vs 2025"). */
export type Comparison = { earlier: Span; later: Span; matched: boolean; change?: true };
export type Flags = { readings: Reading[]; forecast: boolean; court: boolean; offenders: boolean; composite: Composite | null;
  undefinedTerm: "shooters" | "gun violence" | "gang" | null; comparison: Comparison | null; last12: boolean; combined: boolean; largeCities: boolean;
  /** "The 100 largest US cities", "the 5 biggest Texas cities", "the 20 most populous cities": a set of city agencies by population (Jeff 2026-11-10, ranking decision 1). */
  largestSet: number | null;
  /** "All American cities", "every city in Texas", "major cities" with no rank word: every city agency of 250,000 or more (`largestSet` is then ALL_CITIES_N). */
  allCities: boolean;
  /** P70: an explicit county-wide request ("countywide", "the whole county", "all agencies in X County"): the words taken out. */
  countywide: boolean;
  /** The words "top N cities" when read as the N largest (no "by", no "highest"): said in the answer. */
  topAsLargest: string | null;
  /** A Census region named ("the Northeast"): read as the nation, flagged; only Current Trends answers it (current.ts REGIONS). */
  region: "noe" | "mdw" | "sth" | "wst" | null;
  /** A circumstance named ("murders during an argument"): element 31's codes, a filter on the victims (null when none). */
  circumstance: string[] | null;
  /** "According to NIBRS": the source asked for in words is used and labelled (P01). */
  nibrsAsked: boolean;
  /** "Homicide Reports" in the words: murders from the Homicide Reports series (P152). */
  shrAsked: boolean;
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
  /** "teen" or "teenage" was the word (ages 13 to 19 for a Homicide Reports ranking), not "juvenile" or "minor". */
  teen?: boolean;
  /** The age words the reader took out, with the text that followed each: put back where a question is restated to the user. */
  restore?: { word?: string; anchor?: string; article?: string; phrase?: string; swap?: { from: string; to: string } }[];
};
/**
 * The question with the age words the reader took out put back ("show me crimes with a teen offender", "crimes by juveniles ..."),
 * never a sentence without them. A word goes in front of the text that followed it; a phrase ("committed by kids") the same, or at
 * the end when nothing followed; a swap puts back the words a rewrite replaced ("murder victims" for "murders of teenagers").
 */
export function restoreAgeWords(q: string, people: People | null | undefined): string {
  let out = q;
  for (const r of people?.restore ?? []) {
    if (r.swap) {
      const at = out.toLowerCase().indexOf(r.swap.from.toLowerCase());
      if (at >= 0) out = `${out.slice(0, at)}${r.swap.to}${out.slice(at + r.swap.from.length)}`;
      continue;
    }
    if (r.phrase !== undefined && !r.anchor) {
      const end = /[?.!\s]*$/.exec(out)!;
      out = `${out.slice(0, end.index)} ${r.phrase}${out.slice(end.index)}`;
      continue;
    }
    const i = out.toLowerCase().indexOf((r.anchor ?? "").toLowerCase());
    if (i < 0) continue;
    if (r.phrase !== undefined) {
      // After a word the phrase gets a space before it; before a mark ("?") none after it.
      const before = out.slice(0, i), punct = /^[?.!,]/.test(out.slice(i));
      out = `${before}${/\s$/.test(before) || !before ? "" : " "}${r.phrase}${punct ? "" : " "}${out.slice(i)}`;
    } else out = `${out.slice(0, i)}${r.article ? `${r.article} ` : ""}${r.word} ${out.slice(i)}`;
  }
  return out;
}
export type ReadQuestion = Flags & { question: string; text: string; ledger: RequestLedger & Flags };

/** A state's name, one word (the set regexes take one word between "top N" and "cities": "the 5 biggest Texas cities"). */
const STATE_WORD = new RegExp(`^(?:${'Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|Ohio|Oklahoma|Oregon|Pennsylvania|Tennessee|Texas|Utah|Vermont|Virginia|Washington|Wisconsin|Wyoming'})$`, "i");
const PHRASES: [RegExp, string][] = [
  // Comparison and change wording (Jeff 2026-11-11: "a lot of the issues seem to be a lack of understanding of the word
  // 'how'"). "How has X changed / trended / fared ..." is X by year over the period asked; "how does X compare to Y" is
  // X and Y side by side; "Y statewide" is the state; "the national rate" is the United States.
  [/^\s*(?:by\s+year,\s*)?how\s+(?:does|do|did)\s+(.+?)\s+(?:compare|stack\s+up)\s+(?:to|with|against)\s+/gi, "$1 and "],
  // "Compare Houston's murder rate to the Texas state average": the two places side by side (never a year: "compare
  // 2024 to 2023" is a period comparison).
  // Never a time ("year to date", "to the most recent data", "to present": job CW2).
  [/^\s*compare\s+((?:(?!\b(?:from|between|through)\b).)+?)\s+(?:to|with|against)\s+(?:the\s+)?(?!\d|(?:the\s+)?(?:date|most|present|today|now|current|latest|recent|end|last|this|next|previous|early|mid|late|spring|summer|fall|autumn|winter|first|second|third|fourth|beginning|start|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b)/gi, "$1 and "],
  [/\b(in|for)\s+the\s+state\s+of\s+/gi, "$1 "],
  // Jeff 2026-11-11: "cases" is the source's normal count for the crime (victims for crimes against people, offenses
  // otherwise), so the word itself adds nothing.
  [/\b(?:number\s+of\s+)?cases\s+of\s+/gi, ""],
  [/\s+cases\b/gi, ""],
  [/\barrests\s+(?:were\s+|have\s+been\s+)?made\b/gi, "arrests"],
  [/\b(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)(?:\s+state)?\s+(?:statewide|state\s+average|as\s+a\s+whole)\b/gi, "$1"],
  // Time words read, never dropped: "by months", "year-to-date", "over 5 years", "going back to 1980".
  [/\b(by|per)\s+months\b/gi, "$1 month"],
  [/\byear[-\s]to[-\s]date\b/gi, "year to date"],
  [/\bover\s+(?:the\s+)?(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+years\b/gi, "over the past $1 years"],
  [/\bgoing\s+back\s+to\s+((?:19|20)\d{2})\b/gi, "since $1"],
  // Fatal shootings are firearm murders (Homicide Reports' firearm homicides, Jeff S1; NIBRS's murders with a firearm).
  [/(?<!\b(?:police|officer[-\s]involved|officer|law\s+enforcement)\s+)\b(?:fatal\s+shootings?|shooting\s+deaths?|people\s+(?:shot\s+and\s+)?killed\s+(?:by|with)\s+(?:guns?|firearms?))\b(?!\s+(?:by|of|involving)\s+(?:the\s+)?(?:police|officers?|law\s+enforcement))/gi, "firearm murders"],
  // "Make a list of the 20 most populous cities and sort them by 2026 homicide rate" (job S2): a set ranked by it.
  [/\bmake\s+(?:me\s+)?a\s+list\s+of\s+/gi, ""],
  // "Homicide totals in top 15 cities", "tell me about murder rates in the largest cities" (job S5).
  [/\b(murders?|homicides?|robberies|robbery|burglar(?:y|ies)|rapes?|assaults?|thefts?|crimes?)\s+totals\b/gi, "$1 count"],
  // Not "sort by year" or by name, which order rows, not rank by a crime (Codex rankings review 09.1).
  [/\b(?:and\s+)?sort(?:ed)?\s+(?:them\s+|it\s+)?by\b(?!\s+(?:the\s+)?(?:years?|months?|dates?|names?|city|cities|states?|population|size|alphabet\w*))/gi, "ranked by"],
  // "Rank Virginia counties in terms of murder rate": "by", only after a rank word (rankings PR B).
  [/(\brank\w*\b[^.?!]*?)\bin\s+terms\s+of\b/gi, "$1by"],
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
  // Reader class (census 2026-11-21, real asks): small words and slips the log shows. "how many murders occurred in Colorado" (spelled
  // "ocurred", "occured", "occurredin") is "murders in Colorado"; "how mnay" is "how many"; "sincce" is "since"; "for year 2026" is "in 2026";
  // "retail theft" is shoplifting; "larceny from auto" is theft from a motor vehicle; "violent crime and property trends" is violent crime and property crime.
  [/\b(?:have\s+|has\s+|had\s+)?(?:occurred|occured|ocurred|occurrd|occurrred)\s*in\b/gi, "in"],
  [/\bhow\s+(?:mnay|mny|manny|mamy)\b/gi, "how many"],
  [/\bs(?:incce|icne|inec|ince(?=e))\b/gi, "since"],
  [/\bfor\s+year\s+((?:19|20)\d{2})\b/gi, "in $1"],
  [/\bmassachuss?ett?s\b|\bmassachusetes\b|\bmassachussetts\b|\bmasachusetts\b/gi, "Massachusetts"],
  [/\bretail\s+thefts?\b/gi, "shoplifting"],
  [/\blarcen(?:y|ies)\s+(?:from|of)\s+(?:an?\s+)?(?:auto|autos|motor\s+vehicles?|vehicles?|cars?)\b/gi, "theft from motor vehicle"],
  [/\b(violent\s+crimes?)(\s*(?:,|and|&)\s*)property(?!\s+(?:crimes?|offenses?|damage|value|thefts?))\b/gi, "$1$2property crime"],
  // P193 (census 2026-11-21, real asks): "by year and clearance type" is the clearance type by year (the shape that is built), with "per" for "by".
  [/\b(?:per|by)\s+(year|month)\s+(?:and|&)\s+(?:by\s+)?clearance\s+type\b/gi, "by type by $1"],
  // "Murders cleared by clearance type" is the murder clearances by type.
  [/\bcleared\s+by\s+(?:the\s+)?(?:clearance\s+)?type\b/gi, "clearances by type"],
  // Places' nicknames, read once for every source (coordinator 2026-11-02); the crosswalk's place names ("New York City")
  // are aliases in the shared place index (lib/nibrs-shadow/places.ts), not here.
  [/\bphilly\b/gi, "Philadelphia"],
  [/\bnola\b/gi, "New Orleans"],
  // San Francisco's initials and short name (scorecard 2026-11-16: "SF aggravated assault per month", "What is SFPD rape clearance rate?").
  // "The annual number of murders" is "annual murders": a series by year (P06), not a question with no period.
  [/\b(annual)\s+number\s+of\b/gi, "$1"],
  [/\bsfpd\b/gi, "San Francisco Police Department"],
  [/\bsan\s+fran\b/gi, "San Francisco"],
  [/(?<![A-Za-z.])sf(?![A-Za-z.\d])/gi, "San Francisco"],
  // The nation, written "the us" or "American": the capitals-only "US" is the accounting's place word, so lower case "us" is read only
  // after "in/of/across/for the" or leading a crime phrase, never as the pronoun ("show us murders").
  [/\b(?:in|of|across|throughout|for)\s+the\s+us(?![A-Za-z.\-'])/gi, (m: string) => m.replace(/us$/i, "U.S.")] as unknown as [RegExp, string],
  [/\bdispaly\b/gi, (m: string) => (m[0] === "D" ? "Display" : "display")] as unknown as [RegExp, string],
  // The states as a list, said in other words ("broken down by all 50 states", "in all 50 states", "per state", "state by state"): "by state".
  [/\b(?:broken\s+down\s+by|broken\s+out\s+by|by|in|for|across)\s+(?:(?:all|every|each)\s+(?:the\s+)?(?:50\s+|fifty\s+)?|(?:all\s+)?(?:the\s+)?(?:50|fifty)\s+)states?\b/gi, "by state"],
  [/\bstate\s+by\s+state\b/gi, "by state"],
  [/\bper\s+state\b/gi, "by state"],
  // "NY" for a place (not after a place it qualifies, "Suffern (NY)", "Rochester NY"): New York, which asks between the
  // city and the state (P26); "NY city" is the city.
  [/\bny\s+city\b/gi, "New York City"],
  [/(?<![A-Z][a-z]+,?\s)(?<![(,]\s?)\b(?:NY|ny|Ny)\b(?!\s*\))/g, "New York"],
  // P173 (Jeff 2026-11-21): "murder clearance rates by state" is every state ranked by its clearance rate.
  [/\b((?:[a-z]+\s+){0,2}?)clearance\s+rates?\s+(?:by|per|for\s+(?:each|every)|in\s+each)\s+state\b/gi, "rank states by $1clearance rate"],
  // P163 (Jeff 2026-11-19): justifiable homicides "by police vs civilians" are the two kinds of justifiable homicide side by side (the
  // circumstance breakdown); "by police" alone (or "by civilians" alone) is read from the question text where the answer is made.
  [/\b(justifiable\s+(?:homicides?|killings?))\s+(?:committed\s+)?by\s+(?:the\s+)?(?:police|officers|law\s+enforcement)\s+(?:vs\.?|versus|and|or|compared\s+(?:to|with)|against)\s+(?:by\s+)?(?:private\s+)?(?:civilians?|citizens?)\b/gi, "$1 by circumstance"],
  [/\b(justifiable\s+(?:homicides?|killings?))\s+(?:committed\s+)?by\s+(?:private\s+)?(?:civilians?|citizens?)\s+(?:vs\.?|versus|and|or|compared\s+(?:to|with)|against)\s+(?:by\s+)?(?:the\s+)?(?:police|officers|law\s+enforcement)\b/gi, "$1 by circumstance"],
  [/\b(justifiable\s+(?:homicides?|killings?))\s+(?:committed\s+)?by\s+(?:the\s+)?(?:police|officers|law\s+enforcement|(?:private\s+)?(?:civilians?|citizens?))\b/gi, "$1"],
  // P165 (Jeff 2026-11-19): "what share of murders in Houston involved a firearm" is the murders by weapon, each weapon's share shown, with one
  // sentence for the firearms together. "What weapons were used in X" is X by weapon; "with a firearm used" is "with a firearm".
  [/\b(?:what\s+)?(?:share|percentage|percent|proportion)\s+of\s+([^?.]+?)\s+(?:involved|involve|involving|were\s+committed\s+(?:with|using)|were\s+done\s+with|used)\s+(?:a\s+)?(?:firearms?|guns?|handguns?)\b([^?.]*)/gi, "share of $1 by weapon$2"],
  [/\bwhat\s+(?:types?\s+of\s+)?weapons?(?:\s+types?)?\s+(?:were|was|are|is)\s+(?:used|reported|involved)\s+(?:in|for|during)\s+([^?.]+)/gi, "$1 by weapon"],
  [/\b(with|involving)\s+(a|an)\s+(firearm|gun|knife|handgun|weapon)\s+used\b/gi, "$1 $2 $3"],
  [/\s+analysis\s+for\s+/gi, " in "],
  // P191: "for the entire US", "across the whole country" are the nation ("nationwide").
  [/\b(?:for|in|across|throughout|of)\s+(?:the\s+)?(?:entire|whole|full)\s+(?:u\.?s\.?a?\.?|united\s+states(?:\s+of\s+america)?|country|nation)(?=[\s,.?!]|$)/gi, "nationwide"],
  // P191 (Jeff 2026-11-21, reader class): "cleared by arrest versus exceptional means" is the clearance types (arrest, each exceptional type,
  // uncleared); "exceptional clearances by type" is the exceptional types; "exceptional means" alone is the exception.
  [/,?\s*\b(?:were\s+|was\s+)?cleared\s+by\s+arrest\s+(?:versus|vs\.?|and|compared\s+(?:to|with)|against)\s+(?:by\s+)?(?:exceptional\s+means|exception|exceptional\s+clearance)\b/gi, " by clearance type"],
  [/\bexceptional\s+((?:[a-z]+\s+){0,1}?)clearances?\b/gi, "$1cleared by exception"],
  [/(\bcleared\s+by\s+exception\b[^?.]*?)\b(?:per|by)\s+year\s+and\s+type\b/gi, "$1by type by year"],
  // P170 (Jeff 2026-11-19): intimate partner violence and family violence are domestic violence by that kind of relationship.
  [/\b(?:intimate[-\s]partner\s+violence|ipv)\b/gi, "domestic violence by intimate partners"],
  [/\bfamily\s+violence\b/gi, "domestic violence by family members"],
  // P160 (Jeff 2026-11-19): a person's detail written as a noun phrase is that breakdown: "murder victim race in Houston" is
  // "murder victims by race in Houston", "homicide offender race" is "homicide offenders by race"; "victim demographics by
  // race" is "victims by race"; "the racial breakdown of murder victims" is "murder victims by race"; "homicide circumstances"
  // is "homicides by circumstance". Never after "by" ("by victim race" is read by the people reader below).
  [/(?<!\bby\s+(?:the\s+)?)\b(victim|offender)s?(?:'s|s')?\s+(race|sex|gender|ethnicity|age)\b(?!\s+(?:and|or|\/)\s+(?:race|sex|gender|ethnicity|age)\b)/gi, "$1s by $2"],
  [/\b(victim|offender)s?\s+(?:demographics|demographic\s+breakdown)\s+by\s+(race|sex|gender|ethnicity|age)\b/gi, "$1s by $2"],
  [/\b(?:the\s+)?racial\s+(?:breakdown|makeup|composition|distribution)\s+of\s+((?:[a-z]+\s+){0,3}?(?:victims|offenders))\b/gi, "$1 by race"],
  [/\b(murder|homicide|killing)s?\s+circumstances?\b/gi, "$1s by circumstance"],
  // P162 (Jeff 2026-11-19): "what percentage of murder victims were female" is the victims by sex with each sex's share; the table
  // carries the asked share and the other. "...are in each race" is the same by race.
  [/\b(?:what\s+|how\s+much\s+)?(?:percentage|percent|share|proportion)\s+of\s+((?:[a-z]+\s+){0,2}?(?:murder|homicide)\s+(?:victims|offenders))\s+in\s+((?:[a-z.'-]+\s+){1,3}?)(?:were|are|was|is|have\s+been)\s+(?:male|female|men|women|males|females)\b/gi, "share of $1 by sex in $2"],
  [/\b(?:what\s+|how\s+much\s+)?(?:percentage|percent|share|proportion)\s+of\s+((?:[a-z]+\s+){0,2}?(?:murder|homicide)\s+(?:victims|offenders))\s+(?:were|are|was|is|have\s+been)\s+(?:male|female|men|women|males|females)\b/gi, "share of $1 by sex"],
  [/\b(?:what\s+)?(?:percentage|percent|share|proportion)\s+of\s+((?:[a-z]+\s+){0,2}?(?:murder|homicide)\s+(?:victims|offenders))\s+(?:are|were)\s+in\s+each\s+(race|sex|age\s+group|ethnicity)\b/gi, "share of $1 by $2"],
  // "What race are offenders in NYC murders in 2024?": the offenders' race for the murders.
  [/\bwhat\s+(race|sex|gender|ethnicity|age)\s+(?:are|were)\s+(?:the\s+)?(offenders|victims)\s+(?:in|of|for)\s+(.+?)\s+(murder|homicide)s\b/gi, "$4 $2 by $1 in $3"],
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
/** P38 (Jeff 2026-11-09): any gang wording ("gang-related", "gangland", "gang members", "gangs"), declined for every source. */
export const GANG = /\bgang(?:s|land|sters?|related|involved|motivated)?\b/i;
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

/** The words of a county-wide request ("countywide", "the whole county", "all agencies in X County"): read as a flag, declined with an offer (P70). */
export const COUNTYWIDE_RE = /\b(?:county[-\s]?wide|(?:for\s+|in\s+)?(?:the\s+)?(?:whole|entire)\s+county|(?:(?:across|for|from|in|of)\s+)?all\s+(?:the\s+)?(?:law\s+enforcement\s+)?(?:agencies|police\s+departments|departments)\s+(?=in\s+(?:[\w.'-]+\s+){1,3}county\b))/i;

/** A comparison asked in one of the forms above: its periods, and the question as a count over the whole span. */
function readComparison(text: string, currentYear: number, lastMonth?: string): { comparison: Comparison; text: string; from: string } | null {
  let m: RegExpExecArray | null;
  // The year to date against another year (Jeff 2026-11-16): "YTD 2026 compared to 2025", "year to date 2026 vs 2025", "2026 YTD versus
  // 2025 YTD", "so far this year compared to the same period last year", "this year to date compared with 2024". Both years count the
  // same months: January through the release's latest month. A to-date word is required: "this year compared with last year" has its own form below.
  if (lastMonth) {
    const YW = String.raw`(?:year[-\s]to[-\s]date|ytd)`;
    const TYD = String.raw`(?:this\s+year(?:'s)?\s+(?:so\s+far|to\s+date|${YW})|so\s+far\s+this\s+year|(?:the\s+)?${YW}(?:\s+(?:for\s+)?this\s+year)?)`;
    const SAME = String.raw`(?:the\s+)?same\s+(?:period|months?)\s+(?:in\s+|of\s+)?`;
    const upto = Number(lastMonth.slice(5, 7)), ytdSpan = (y: number): Span => ({ from: `${y}-01`, to: `${y}-${two(upto)}` });
    const asYtd = (a: number, b: number, from: string) => {
      const [e, l] = a < b ? [a, b] : [b, a];
      return { comparison: { earlier: ytdSpan(e), later: ytdSpan(l), matched: true }, from, text: "" };
    };
    // Two years named, a to-date word beside either: "YTD 2026 compared to 2025", "2026 YTD versus 2025 YTD".
    if ((m = new RegExp(String.raw`\b(?:(?:the\s+)?${YW}\s+(?:for\s+|in\s+)?)?(\d{4})(?:\s+${YW})?\s+${VS}\s+(?:${SAME})?(?:(?:the\s+)?${YW}\s+(?:for\s+|in\s+)?)?(\d{4})(?:\s+${YW})?`, "i").exec(text))
      && new RegExp(YW, "i").test(m[0]) && Number(m[1]) !== Number(m[2]) && Math.max(Number(m[1]), Number(m[2])) <= currentYear) {
      const r = asYtd(Number(m[1]), Number(m[2]), m[0]);
      return { ...r, text: text.replace(m[0], `from ${r.comparison.earlier.from.slice(0, 4)} to ${r.comparison.later.from.slice(0, 4)}`) };
    }
    // This year to date against last year or a named year: "so far this year compared to the same period last year".
    if ((m = new RegExp(String.raw`\b${TYD}\s+${VS}\s+(?:${SAME})?(?:(last\s+year)|(\d{4}))(?:\s+${YW})?`, "i").exec(text))) {
      const other = m[1] ? currentYear - 1 : Number(m[2]);
      if (other < currentYear) {
        const r = asYtd(other, currentYear, m[0]);
        return { ...r, text: text.replace(m[0], `from ${other} to ${currentYear}`) };
      }
    }
  }
  // "(percent) change in X from 2022 to 2024", also "from 2024-2025" and "X for Chicago, 2024-2025" (a dash between the years, "from" optional)
  if ((m = new RegExp(String.raw`\b(?:percent(?:age)?\s+)?change\s+in\s+(.+?)\s+(?:from\s+)?(\d{4})\s*(?:to|through|-|–|—)\s*(\d{4})\b`, "i").exec(text)) && Number(m[2]) < Number(m[3]))
    return { comparison: { earlier: yearSpan(Number(m[2])), later: yearSpan(Number(m[3])), matched: false, change: true }, from: m[0], text: text.replace(m[0], lead(`${m[1]} from ${m[2]} to ${m[3]}`)) };
  // "X January through June 2024 compared with January through June 2023"
  if ((m = new RegExp(String.raw`\b(?:in\s+|from\s+)?${MON}\s+(?:through|to|-)\s+${MON}\s+(\d{4})\s+${VS}\s+(?:the\s+same\s+months\s+(?:of|in)\s+|${MON}\s+(?:through|to|-)\s+${MON}\s+)?(\d{4})\b`, "i").exec(text))) {
    const [a, b] = [MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1, MONTH_NAMES.indexOf(m[2].toLowerCase()) + 1];
    const same = !m[4] || (m[4].toLowerCase() === m[1].toLowerCase() && m[5].toLowerCase() === m[2].toLowerCase());
    const [later, earlier] = [Number(m[3]), Number(m[6])];
    if (!same || a > b || earlier >= later) return null;
    return { comparison: { earlier: { from: `${earlier}-${two(a)}`, to: `${earlier}-${two(b)}` }, later: { from: `${later}-${two(a)}`, to: `${later}-${two(b)}` }, matched: true },
      from: m[0], text: text.replace(m[0], `from ${earlier} to ${later}`) };
  }
  // "X in 2024 compared with 2023", and the earlier year first: "in 2022 vs 2025", "in 1960 vs 2020" (comparison
  // wording, Jeff 2026-11-11).
  if ((m = new RegExp(String.raw`\bin\s+(\d{4})\s+${VS}\s+(?:in\s+)?(\d{4})\b`, "i").exec(text)) && Number(m[2]) !== Number(m[1])) {
    const [e, l] = Number(m[2]) < Number(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    return { comparison: { earlier: yearSpan(Number(e)), later: yearSpan(Number(l)), matched: false }, from: m[0], text: text.replace(m[0], `from ${e} to ${l}`) };
  }
  // "How has violent crime changed in the last year in Washington D.C.?": the last complete year against the one before.
  if ((m = /^\s*(?:show\s+me\s+)?how\s+(?:has|have)\s+(.+?)\s+changed\s+(?:in|over)\s+the\s+(?:last|past)\s+year\b\s*(.*?)\s*\??\s*$/i.exec(text)))
    return { comparison: { earlier: yearSpan(currentYear - 2), later: yearSpan(currentYear - 1), matched: false }, from: m[0],
      text: lead(`${m[1]}${m[2] ? ` ${m[2]}` : ""} from ${currentYear - 2} to ${currentYear - 1}`) };
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
export const SHR_WORDS = /,?\s*\b(?:(?:according\s+to|from|in|per|using|with)\s+)?(?:the\s+)?(?:FBI\s+)?(?:Supplementary\s+)?(?:Homicide\s+Reports?|SHR)\b/i;
export const CONSISTENT_WORDS =/,?\s*\b(?:(?:counting\s+)?only\s+(?:the\s+)?agencies\s+that\s+reported\s+(?:every|all|each)\s+(?:\d+\s+)?months?(?:\s+of\s+the\s+(?:year|period))?|consistent(?:ly)?\s+reporting\s+agencies|only\s+consistent\s+reporters|(?:for|among|with)\s+(?:the\s+)?(?:consistent|continuous)(?:ly)?\s+(?:reporters|reporting\s+agencies))\b/i;

export function readQuestion(question: string, currentYear: number, lastMonth?: string): ReadQuestion {
  const readings: Reading[] = [];
  let text = question;
  const cmp = readComparison(text, currentYear, lastMonth);
  if (cmp) { readings.push({ kind: "period", from: cmp.from, to: cmp.text }); text = cmp.text; }
  // "Memphis vs Nashville": places compared are places side by side, as with "and" (coordinator, 2026-11-01). A period
  // comparison ("2024 vs 2023") was read just above; a "vs" next to a year is left to it.
  text = text.replace(/(?<!\b(?:19|20)\d{2})\s+(?:vs\.?|versus|compared (?:to|with))\s+(?!(?:19|20)\d{2}\b)/gi, " and ");
  // P08: "large Texas cities" -> Texas cities of 250,000+, flagged; the reader reads the rest. Jeff 2026-11-10 (ranking
  // decision 2): "Major/big/large cities should assume 250k+", and "larger", "largest" with no number too; "the 10
  // largest cities" is a set by population, read elsewhere.
  // Jeff 2026-11-10 (ranking decision 1): "the N largest cities" is the N city agencies with the most residents; the
  // words are taken out and the place (a state named, or the nation) is read as usual.
  let largestSet: number | null = null;
  const NUM: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, fifty: 50, hundred: 100 };
  text = text.replace(/\b(?:the\s+)?(?:top\s+)?(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|fifty|hundred)\s+(?:largest|biggest|most\s+populous)\s+((?:u\.?s\.?|american|[A-Z][a-zA-Z]+)\s+)?cities\b(?:\s+(?:in\s+the\s+(?:country|nation|dataset|usa?|united\s+states)|in\s+the\s+u\.s\.?|by\s+(?:size|population)))?/i,
    (m, n: string, qual: string | undefined) => {
      const k = /^\d+$/.test(n) ? Number(n) : NUM[n.toLowerCase()];
      if (!k || k < 2 || k > 300 || (qual && !/^(?:u\.?s\.?|american)\s*$/i.test(qual.trim()) && !STATE_WORD.test(qual.trim()))) return m;
      largestSet = k;
      readings.push({ kind: "phrase", from: m.trim(), to: `(the ${k} city agencies with the largest populations)` });
      // A state's name before "cities" stays to be read as the place ("the 5 biggest Texas cities").
      return qual && !/^(?:u\.?s\.?|american)\s*$/i.test(qual.trim()) ? ` in ${qual.trim()} ` : " ";
    });
  text = text.replace(/\b(?:the\s+)?(?:top\s+)?(\d{1,3})\s+cities\s+by\s+population\b/i, (m, n: string) => {
    const k = Number(n);
    if (k < 2 || k > 300) return m;
    largestSet = k;
    readings.push({ kind: "phrase", from: m.trim(), to: `(the ${k} city agencies with the largest populations)` });
    return " ";
  });
  // Jeff 2026-11-10: a bare "top N cities" (no "by ...", no "highest", "most"...) is the N largest cities by population.
  let topAsLargest: string | null = null;
  // "By" a crime anywhere ("top 10 cities in Texas by murder in 2024") ranks by it (Codex rankings review 03.1); "by
  // population", "by size", "by year" or "by month" don't.
  // Nor when the cities are picked by anything else ("with the slowest decline", "sorted by"): job S, QL-ct-20af00a1f6.
  // Ranking words anywhere pick the cities by a figure; the words right after "cities" are checked below (Codex job-S
  // review 01: "the homicide change ... in the top 100 cities" is still the 100 largest).
  if (largestSet === null && !/\b(?:highest|lowest|most|fewest|least|safest|dangerous|worst|best|rank\w*|slowest|fastest|steepest)\b/i.test(text)
    && !/\bby\s+(?!(?:population|size|year|month|years|months)\b)/i.test(text)) {
    text = text.replace(/\b(?:the\s+)?top\s+(\d{1,3})\s+((?:u\.?s\.?|american|[A-Z][a-zA-Z]+)\s+)?cities\b(?!\s+(?:by|for|with|ranked|in\s+terms|sorted|ordered|over|under|above|below|that|where|having|whose|of\s+[\d,]+))/i,
      (m, n: string, qual: string | undefined) => {
        const k = Number(n);
        // Only a state's name (capitalized as written), "US" or "American" between "top N" and "cities": "top 5 murder
        // cities" picks by murder (job S4, QL-nibrs-f8b0bd256e).
        if (k < 2 || k > 300 || (qual && !/^(?:u\.?s\.?|american)\s*$/i.test(qual.trim()) && !STATE_WORD.test(qual.trim()))) return m;
        largestSet = k;
        topAsLargest = m.trim();
        readings.push({ kind: "phrase", from: m.trim(), to: `(the ${k} city agencies with the largest populations)` });
        return qual && !/^(?:u\.?s\.?|american)\s*$/i.test(qual.trim()) ? ` in ${qual.trim()} ` : " ";
      });
  }
  // P70 (decided 2026-10-30): "countywide", "the whole county", "across all agencies in X County" asks for the sum of
  // every agency in the county; flagged and the words taken out, so the county is read as usual.
  let countywide = false;
  // "All agencies" only before a county ("all agencies in Kern County"), never a state (Codex rankings-B review 01.1).
  text = text.replace(COUNTYWIDE_RE,
    (m) => { countywide = true; readings.push({ kind: "phrase", from: m.trim(), to: "(every agency in the county, summed)" }); return " "; });
  // All the cities (Jeff 2026-11-16): "all American cities", "every city in Texas", "all cities in the US", and "major/large/big cities" with no
  // rank word are the cities of 250,000 or more, said. Read as a set of ALL_CITIES_N, so the set's own rules (one crime, a count or a rate, one
  // year, Crime Index) apply; the place is the state named, else the nation.
  // Only a plain count or rate of one crime for one year (runner gate 2026-11-17): no time series (by month, several years, "since", "going
  // back"), no total across the cities, and no condition of its own (a weapon or detail, a share, officers or staffing, another size
  // condition): those keep their old readings.
  let allCities = false;
  const plainSet = !NOT_PLAIN_SET.test(text) && new Set(text.match(/\b(?:19|20)\d{2}\b/g) ?? []).size <= 1;
  if (largestSet === null && plainSet && !/\b(?:highest|lowest|most|fewest|least|safest|dangerous|worst|best|rank\w*|top|bottom|which|slowest|fastest|steepest)\b/i.test(text)) {
    text = text.replace(/\b(?:(?:in|across|among|for|of)\s+)?(?:(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?|(?:the\s+)?(?:large|larger|largest|big|bigger|biggest|major)\s+)((?:u\.?s\.?|american|[a-z]+(?:\s+[a-z]+)?)\s+)?cit(?:y|ies)\b(?:\s+(?:in|of|across|throughout)\s+(?:the\s+)?(country|nation|usa?|u\.s\.?|united\s+states|america)\b)?/i,
      (m, qual: string | undefined, whole: string | undefined) => {
        const q = qual?.trim();
        const nation = !!q && /^(?:u\.?s\.?|american)$/i.test(q);
        const state = !!q && !nation && STATE_WORD.test(q);
        if (q && !nation && !state) return m;
        allCities = true;
        readings.push({ kind: "phrase", from: m.trim(), to: "(the cities with a population of 250,000 or more)" });
        return state ? ` in ${q} ` : nation || whole ? " in the United States " : " ";
      });
  }
  if (allCities) largestSet = ALL_CITIES_N;
  let largeCities = false;
  text = text.replace(/(?<!\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|fifty|hundred|top)\s+)\b(?:the\s+)?(?:large|larger|largest|big|bigger|biggest|major)\s+(?=(?:u\.?s\.?\s+|[A-Z][a-zA-Z]+\s+){0,2}cit(?:y|ies)\b)/i, (m) => { largeCities = true; readings.push({ kind: "phrase", from: m.trim(), to: "(a population of 250,000 or more)" }); return ""; });
  // A Census region (Current Trends' groups; coordinator 2026-11-03): "the Northeast", "the midwest US", "southern
  // states". Read as the nation and flagged, so the shadow answers it from Current Trends or says it can't; never "the
  // South Side", "South Carolina" or "West Memphis".
  // Circumstances (NIBRS data element 31, coordinator 2026-11-04): a victim's murder or aggravated assault circumstance,
  // read as a filter and taken out of the words. Domestic violence is a relationship, not read here (blocked until the
  // DV gap note); "drug-related" is left to the drug crimes.
  let circumstance: string[] | null = null;
  for (const [re, codes, name] of [
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
  // "Tell me about murder rates in the largest cities" (job S5): filler before a crime named; applied here, not in PHRASES,
  // whose replacement re-reads only the matched words (its look-ahead would fail: Codex review 13.2).
  text = text.replace(/^\s*(?:can\s+you\s+)?tell\s+me\s+(?:more\s+)?about\s+(?=[a-z\s]*\b(?:murders?|homicides?|robber\w*|burglar\w*|rapes?|assaults?|thefts?|violent|property)\b)/i,
    (m) => { readings.push({ kind: "phrase", from: m.trim(), to: "" }); return ""; });
  // Filler (Jeff 2026-11-22): "highlight" opening a question and "major" before a crime word add nothing ("show me" and "give me" are
  // already request words elsewhere, and the age rule reads "show me" itself)
  // ("Highlight major crime trends in the city of Philadelphia since 2022"). Not "major cities" (the large-city rule above).
  text = text.replace(/^\s*(?:(?:can|could|would)\s+you\s+|please\s+)?highlight\s+(?:the\s+)?(?=[a-z])/i,
    (m) => { readings.push({ kind: "phrase", from: m.trim(), to: "" }); return ""; });
  text = text.replace(/\bmajor\s+(?=(?:crimes?|violent|property|offenses?)\b)/gi,
    (m) => { readings.push({ kind: "phrase", from: m.trim(), to: "" }); return ""; });
  // "Cases closed", "cases solved", "cases cleared" (Jeff 2026-11-22, audit B22, P35/P47): clearances, the offenses cleared, said in a note; a bare "cases" is
  // not read here (it still declines).
  text = text.replace(/\b(?:the\s+)?(?:number\s+of\s+)?cases\s+(?:that\s+)?(?:(?:were|was|are|is|have\s+been|has\s+been|been|get|got|being)\s+)?(?:closed|solved|cleared)\b/gi,
    (m) => { readings.push({ kind: "meaning", from: `cases ${/(closed|solved|cleared)$/i.exec(m)![1].toLowerCase()}`, to: "offenses cleared" }); return "that were cleared"; });
  {
    const before = text;
    text = text.replace(/\b(?:the\s+)?(closed|solved|cleared)\s+((?:[a-z]+\s+){0,3}?)cases\b/gi, (_m, v: string, crime: string) => { readings.push({ kind: "meaning", from: `${v.toLowerCase()} cases`, to: "offenses cleared" }); return crime.trim(); });
    if (text !== before) text = text.replace(/\s*([?.!]*)\s*$/, ` that were cleared$1`);
  }
  // Filler (Jeff 2026-11-22, QL-ct-d20e00174a): "are we seeing" after what is asked about ("What crime trends are we seeing in Baltimore") adds nothing.
  text = text.replace(/(?<=\b(?:trends?|crimes?|changes?|patterns?|numbers|figures))\s+(?:are|do)\s+we\s+(?:seeing|see)\b(?=\s+(?:in|for|across)\b)/gi,
    (m) => { readings.push({ kind: "phrase", from: m.trim(), to: "" }); return ""; });
  // The nation as "us" leading a crime phrase ("us homicide trend") or "American" before cities or a crime ("all American cities"): applied
  // here, not in PHRASES, whose replacement re-reads only the matched words (its look-ahead would fail).
  text = text.replace(/^\s*us\s+(?=(?:murder|homicide|crime|violent|property|robber|burglar|theft|assault|rape|arson|clearance)\w*)/i,
    (m) => { readings.push({ kind: "phrase", from: m.trim(), to: "U.S." }); return "U.S. "; });
  text = text.replace(/\bamerican(?=\s+(?:cities|city|violent|crime|murder|homicide|property|robber|burglar|theft|assault|police))/gi,
    (m) => { readings.push({ kind: "phrase", from: m, to: "U.S." }); return "U.S."; });
  // Vocabulary that adds nothing, applied here, not in PHRASES, whose replacement re-reads only the matched words (look-around would fail):
  // "the statewide violent crime rate in Colorado" (no state named: the place is asked anyway); "the homicide levels for Dallas" ("levels"
  // is the figure itself, a count; never "at the state level" or "the level of"); "Louisville metro murders" (Louisville Metro is the
  // city's own police department, named by the city).
  const dropWord = (re: RegExp, to: string) => { text = text.replace(re, (m, ...g) => { const t = to.replace(/\$(\d)/g, (_x, n) => String(g[Number(n) - 1] ?? "")); readings.push({ kind: "phrase", from: m.trim(), to: t.trim() }); return t; }); };
  dropWord(/\b(?:the\s+)?statewide\s+(?=[a-z])/gi, "");
  dropWord(/(?<!\b(?:state|city|county|national|local|agency|federal|neighborhood|district|ward|police)\s)\blevels?\b\s*(?=(?:in|for|since|from|between|by|per|during|over|across)\b|[?.]?\s*$)/gi, "");
  dropWord(/\b(louisville|nashville)\s+metro\b(?!\s+(?:area|region))/gi, "$1");
  // P193: "in these cities: Chicago, IL, Houston, TX" names the places in the list, so the words before the list say nothing more (applied here,
  // since the look-ahead would fail in PHRASES).
  dropWord(/\b(?:in|for|among|across|of)\s+(?:these|the\s+following)\s+(?:cities|city\s+agencies|agencies|places|departments)\s*:?\s*(?=[A-Z])/g, "in ");
  // Loose words (Jeff 2026-11-21), each said in a note with what it was taken to mean: "current" is the latest complete year; "up", "down",
  // "going up or down", "dropping" with no timeframe is the crime's trend by year over the past five years (with a timeframe, that one);
  // "overall" is violent plus property crime; "the rest of the nation" is the nation. ("Most prevalent" is the seven offenses ranked: an
  // answer, not a rewrite, so not here.)
  const loose = (re: RegExp, repl: string, to: string, kind: Reading["kind"] = "meaning") => { text = text.replace(re, (m) => { readings.push({ kind, from: m.trim(), to }); return repl; }); };
  const endWith = (add: string) => { text = text.replace(/\s*([?.!]*)\s*$/, ` ${add}$1`); };
  const CRIME_WORD = /\b(?:crimes?|homicides?|murders?|robber\w*|burglar\w*|assaults?|rapes?|thefts?|larcen\w*|shootings?|violent|property|arsons?|shoplift\w*|carjack\w*|vandal\w*|fraud\w*|drug\w*|kidnap\w*|stolen|offen[cs]es?|incidents?|arrests?|victims?|firearm\w*|gun\w*|weapon\w*|trafficking|stalking|extortion|embezzl\w*|counterfeit\w*|trespass\w*)\b/i;
  const TIMEFRAME = /\b(?:19|20)\d{2}\b|\b(?:since|from|between|through|during|until|ytd|today|now|present|last|past|previous|this|so\s+far|to\s+date|recent\w*|over\s+time)\b/i;
  const GRAIN = /\b(?:by|per|each|every)\s+(?:year|month|quarter|week|day)s?\b|\b(?:annual\w*|monthly|quarterly|yearly|weekly|daily)\b/i;
  loose(/\bthe\s+rest\s+of\s+the\s+(?:nation|country|U\.?S\.?A?|United\s+States)\b/gi, "the nation", "the nation");
  loose(/\boverall\s+(?=(?:violent|property)\b)/gi, "", "left out, since the crime is named", "phrase");
  loose(/\boverall\b(?=\s+(?:and|&)\s+violent\b)/gi, "violent crime and property crime", "violent crime plus property crime");
  // Not a clearance question (P57's current year) and not a trend ("current murder trends" is a series, never one year).
  // "Right now" and "these days" are "current" (Jeff 2026-11-21).
  const NOW_WORDS = /\bcurrent(?:ly)?\b|\bright\s+now\b|\bthese\s+days\b/gi;
  if (!/\bclearance|cleared|trend\w*\b/i.test(text) && !TIMEFRAME.test(text.replace(NOW_WORDS, ""))) {
    const before = text;
    text = text.replace(/\b(?:the\s+)?(?:current(?:ly)?|right\s+now|these\s+days)\b(?!\s*[-\s]?(?:year|month|date|day|week|population|trends?|data|situation|status|events?|officers?|staffing|rolling))\s*/gi, (m) => {
      readings.push({ kind: "meaning", from: m.trim(), to: `the latest complete year, ${currentYear - 1}` });
      return "";
    });
    if (text !== before) endWith(`in ${currentYear - 1}`);
  }
  {
    const TREND = String.raw`(?:going\s+up\s+or\s+down|going\s+up|going\s+down|gone\s+up|gone\s+down|up\s+or\s+down|dropping|rising|falling|increasing|getting\s+worse|getting\s+better|up|down)`;
    // "Is it getting worse?" after a question about a crime (Jeff 2026-11-22, audit B34): the same as "up", no verdict; the question before it
    // keeps its own period, or has the past five years by year.
    const follow = new RegExp(String.raw`^(.*\S[?.!])\s+(?:is|are|has|have)\s+(?:it|this|that|they)\s+(?:been\s+)?(${TREND})\s*[?.!]*\s*$`, "i").exec(text);
    if (follow && CRIME_WORD.test(follow[1]) && !/\b(?:similar|peers?|comparable)\b/i.test(follow[1])) {
      const own = TIMEFRAME.test(follow[1].replace(NOW_WORDS, ""));
      readings.push({ kind: "meaning", from: follow[2], to: own ? "its trend by year over the period asked" : "its trend by year over the past five years" });
      text = follow[1].replace(/[?.!]+$/, "").replace(/\s+/g, " ").trim() + "?";
      if (!GRAIN.test(text)) endWith("by year");
      if (!TIMEFRAME.test(text)) endWith("over the past 5 years");
    }
    const t1 = new RegExp(String.raw`^(\s*)(?:is|are|has|have|was|were)\s+(.+?)\s+(?:been\s+)?(${TREND})\b(?!\s+(?:to|from|by|\d))(.*)$`, "i").exec(text);
    const t2 = t1 ? null : new RegExp(String.raw`^(.*?\S)\s+(?:are|is|have|has)\s+(?:been\s+)?(${TREND})\b(?!\s+(?:to|from|by|\d))(.*)$`, "i").exec(text);
    const [lead, x, w, rest]: string[] = t1 ? [t1[1], t1[2], t1[3], t1[4] ?? ""] : t2 ? [t2[1], "", t2[2], t2[3] ?? ""] : ["", "", "", ""];
    // Not with peers ("similar cities" stays the ask from PR 295).
    if (w && !/\bhow\b/i.test(`${lead}${x}`) && CRIME_WORD.test(`${lead}${x}`) && !/\b(?:similar|peers?|comparable)\b/i.test(rest)) {
      readings.push({ kind: "meaning", from: w, to: TIMEFRAME.test(rest) ? "its trend by year over the period asked" : "its trend by year over the past five years" });
      text = `${lead}${x}${rest}`.replace(/\s+/g, " ").trim();
      if (!GRAIN.test(text)) endWith("by year");
      if (!TIMEFRAME.test(text)) endWith("over the past 5 years");
    }
  }
  for (const [re, to] of PHRASES) text = text.replace(re, (m) => {
    const t = m.replace(new RegExp(re.source, "i"), to);   // capture groups ("by $1 by $2") filled in
    readings.push({ kind: "phrase", from: m, to: t });
    return t;
  });
  // All years by default (Jeff 2026-11-11): "going back as far as possible", "for every year available", "all years" mean
  // every year the source has. With no grain and no range named they read as "by year"; with either (by month for all
  // years since 2020) they are only dropped. Codex all-years review 01.2.
  text = text.replace(/(?<![A-Za-z])\s*(?:,\s*)?(?:going\s+back\s+as\s+far\s+as\s+(?:possible|you\s+can|the\s+data\s+goes)|as\s+far\s+back\s+as\s+(?:possible|you\s+can|the\s+data\s+goes)|for\s+every\s+year\s+(?:available|you\s+have)|(?:for\s+)?all\s+(?:available\s+)?years(?:\s+available)?)\b/i, (m, offset: number, whole: string) => {
    const rest = (whole.slice(0, offset) + whole.slice(offset + m.length));
    const own = /\b(?:by|per|each|every)\s+(?:year|month|quarter|week|day)s?\b|\b(?:annual(?:ly)?|monthly|quarterly|yearly)\b|\b(?:since|from|between|through|during|over\s+(?:the\s+)?(?:past|last)|(?:past|last)\s+(?:\d+|few|two|three|four|five|ten))\b|\b(?:19|20)\d{2}\b/i.test(rest);
    const t = own ? "" : `${/\s$|^$/.test(whole.slice(0, offset)) ? "" : " "}by year`;
    readings.push({ kind: "phrase", from: m.trim(), to: t.trim() });
    return t;
  });
  // "How has X changed / trended / fared ..." (Jeff 2026-11-11, "the word 'how'"): X by year over the period named; with
  // no period, X over time, whose period is asked; a change between two years ("changed from 2024 to 2025") is left to
  // the change reading (job CW1). Applied here, not in PHRASES, so the rest of the question is seen.
  const CHANGED = String.raw`(?:changed|trended|fared|moved|evolved)`;
  for (const re of [new RegExp(String.raw`^(\s*(?:(?:can\s+you\s+)?show\s+me\s+)?)how\s+(?:has|have)\s+(.+?)\s+${CHANGED}(?:\s+over\s+time)?\b(.*)$`, "i"),
    new RegExp(String.raw`^(\s*(?:(?:can\s+you\s+)?show\s+me\s+)?)how\s+(.+?)\s+(?:has|have)\s+${CHANGED}(?:\s+over\s+time)?\b(.*)$`, "i")]) {
    const m = re.exec(text);
    if (!m) continue;
    const [, , x, rest] = m;
    if (/^\s*(?:from|between)\s+(?:19|20)\d{2}\s+(?:to|and|through)\s+(?:19|20)\d{2}\b/i.test(rest)) break;
    const period = /\b(?:since|from|between|through|during|in\s+(?:19|20)\d{2}|over\s+the\s+(?:past|last)|(?:past|last)\s+(?:\d+|few|two|three|four|five|ten)|(?:19|20)\d{2})\b/i.test(rest);
    // No period named: left as asked until Jeff's all-years rule (a Crime Index place "over time" would be answered
    // for every year, where the label asks the period: job CW2).
    if (!period) break;
    const t = `${x} by year${rest}`;
    readings.push({ kind: "phrase", from: m[0], to: t });
    text = t;
    break;
  }
  // "... and the national rate / average / total": the United States, only where a rate, if asked, is named before it
  // ("the national rate" may be the question's only rate word, and then it is left as written: Codex comparison review
  // 01.1). Applied here, not in PHRASES, whose replacement sees only the matched words.
  text = text.replace(/\band\s+(?:to\s+)?(?:the\s+)?(?:national(?:\s+(?:rate|average|total|level|figures?|trend))?|nation(?:\s+as\s+a\s+whole)?|U\.?S\.?\s+(?:rate|average|total)|nationally)\b/gi,
    (m: string, offset: number, whole: string) => {
      const rateBefore = /\b(?:rates?|per\s+capita|per\s+100,?000)\b/i.test(whole.slice(0, offset));
      // "The national average" is the nation's figures beside the place's (Jeff 2026-11-21), a rate named or not.
      if (/\brate\b/i.test(m) && !rateBefore) return m;
      // A national total against a rate asked mixes units: left as written (Codex comparison confirmation 01).
      if (/\b(?:total|figures?)\b/i.test(m) && rateBefore) return m;
      // "The national average" is the nation's figures beside the place's (Jeff 2026-11-21): said in a note.
      readings.push(/\baverage\b/i.test(m) ? { kind: "meaning", from: m.replace(/^and\s+(?:to\s+)?/i, ""), to: "the United States, the place's figures beside the nation's" } : { kind: "phrase", from: m, to: "and the United States" });
      return "and the United States";
    });
  let composite: Composite | null = null;
  for (const [re, to, weapon] of COMPOSITES) text = text.replace(re, (m) => {
    readings.push({ kind: "phrase", from: m, to });
    composite = weapon;
    return to;
  });
  // A year named beside the to-date word is that one period ("Memphis ... 2026 year-to-date", "YTD 2026", "year to date for 2026"): read once, never as
  // the named year plus the current year ("I can answer for one period at a time").
  text = text.replace(/\b(?:((?:19|20)\d{2})\s+(?:year[-\s]to[-\s]date|ytd)|(?:year[-\s]to[-\s]date|ytd)\s+(?:(?:of|for|in)\s+)?((?:19|20)\d{2}))\b/gi, (m, a, b) => {
    const to = `in ${a ?? b}`;
    readings.push({ kind: "period", from: m, to });
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
  const undefinedTerm = GANG.test(own) ? "gang" : SHOOTERS.test(own) ? "shooters" : GUN_VIOLENCE.test(own) ? "gun violence" : null;
  // A future year with nothing predicting is a period after the data (P24), read as that year.
  if (!forecast) text = text.replace(NEXT_YEAR, (m) => (readings.push({ kind: "period", from: m, to: `in ${currentYear + 1}` }), `in ${currentYear + 1}`));
  // "Combined" is the flag's (one total of the named agencies); the reader is not asked to apply it.
  const combined = /\b(?:combined|together|altogether)\b/i.test(own);
  if (combined) text = text.replace(/\s*\b(?:combined|together|altogether)\b/gi, "");
  // Increment 5: words that choose a source or a cohort are flags, and the reader is not asked to apply them.
  const NIBRS_ASKED = NIBRS_WORDS;
  const nibrsAsked = NIBRS_ASKED.test(own);
  if (nibrsAsked) text = text.replace(NIBRS_ASKED, "");
  // P152 (Jeff 2026-11-19): "Homicide Reports" in words is a source word like "according to NIBRS": murders from the Homicide Reports series.
  const shrAsked = SHR_WORDS.test(own) && !nibrsAsked;
  if (shrAsked) text = text.replace(SHR_WORDS, "");
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
  // (Not "that were cleared by exception" / "because ...": a clearance type named is the share's own part, read by the question types.)
  text = text.replace(/,?\s*\b(?:that\s+were|which\s+were)\s+cleared\b(?!\s+(?:by\s+(?:exception|an\s+exception)|because|due\s+to))/i, () => (set({ only: "cleared" }), ""));
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
  const flags: Flags = { readings, forecast, court, offenders: offendersLeft, composite, undefinedTerm, comparison: cmp?.comparison ?? null, last12, combined, largeCities, allCities, largestSet, topAsLargest, countywide, region, circumstance, nibrsAsked, shrAsked, consistent, shrDetail, property, clearance, arrestsThrough, people, quarter, column };
  const ledger = Object.assign(readings.length || combined || nibrsAsked || shrAsked || consistent || property || clearance || arrestsThrough || people || peopleRewrote || quarter || column ? accountNibrsRequest(text) : first, flags);
  return { question, text, ...flags, ledger };
}

const JUV = String.raw`(?:juveniles?|minors?|teens?|teenagers?|youths?|kids|children)`;
const UNDER18: [number, number] = [1, 17];
const TEEN: [number, number] = [13, 19];
/** P120: teen and teenage are 13 to 19 on every side (victims, offenders, arrestees); juvenile, minor, child, kid and youth are under 18. */
const ageOf = (word: string): [number, number] => (/^teen/i.test(word) ? TEEN : UNDER18);
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
  // Offenders counted by a victim's attribute ("murder offenders ... by victim race") isn't available yet: declined,
  // never answered with the offenders' own attribute (Codex gap-2 review 04: a bare "by race" is the counted person's).
  // What is counted is the first person the question names ("victims of offenders ..." counts victims; Codex gap-2 review 05).
  else if (vm && /^offenders?$/i.test(/\b(victims?|offenders?|arrests?|arrestees?)\b/i.exec(text.replace(vm[0], " "))?.[1] ?? "")) cut(new RegExp(vm[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), () => { p.unsupported = `a victim's ${vm[1].toLowerCase()} for offenders`; });
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
    && cut(/,?\s*\b(?:(?:comm?itt?ed|perpetrated|broken\s+down)\s+)?by\s+(?:the\s+)?(race|sex|gender|ethnicity|age)(?:\s+groups?)?(?:\s+(?:comm?itt?ed|perpetrated)(?:\s+by)?(?=\s*$|\s*[?.!,]))?/i,
      (m) => { p.by = { who: "offender", attr: ATTR(m[1]), paired: false }; }))
    text = text.replace(/\s+(?:comm?itt?ed|perpetrated)\s+by\s*(?=[?.!]?\s*$)/i, "").trim();
  // A bare "by race (sex, ethnicity, age)" naming no person ("murders in D.C. in 2025 by race"): victims' or offenders'
  // is asked, never assumed (coordinator 2026-11-08, scoring gap 1; the labels' "victim or offender race").
  // "Committed by ..." (as typed: "comited by blacks asians hispanics ...") names the offenders (runner job G,
  // QL-shr-34ce1c60e0). "Race breakdown of murders ..." is the same bare breakdown (phrasing probe, 2026-11-08: it
  // answered with the victims' race).
  if (!p.by && !p.ask && !vm && !/\b(?:victims?|offenders?|arrest(?:s|ed|ee|ees)?|suspects?|perpetrators?)\b|\b(?:comm?itt?ed|perpetrated)\s+by\b/i.test(text)
    && /\bby\s+(?:the\s+)?(?:race|sex|gender|ethnicity|age)\b|\b(?:race|sex|gender|ethnicity|age)\s+breakdown\b/i.test(text)) p.ask = "victims or offenders";
  // Only when offenders are what is counted ("offenders in aggravated assaults ..."); for victims the reader's own
  // "by strangers" applies.
  if (/^\s*(?:[a-z]+\s+){0,2}?offenders\b/i.test(text))
    cut(/,?\s*\bwhere\s+the\s+victim\s+was\s+a\s+stranger\b/i, () => { p.where.push({ who: "offender", attr: "relationship", values: ["ST"], paired: true }); });
  cut(/\bof\s+offenders?\s+who\s+(?:was|were)\s+(?:under|younger\s+than)\s+18\b/i, () => { p.where.push({ who: "offender", attr: "age", range: UNDER18, paired: true }); });
  // "by juveniles", "committed by kids", "against teens": taken out for reading, put back where a question is restated to the user.
  const takeOut = (re: RegExp, who: "offender" | "victim") => {
    let at = 0, phrase = "";
    if (!cut(re, (m) => { at = m.index; phrase = m[0].replace(/^[,\s]+/, ""); p.where.push({ who, attr: "age", range: ageOf(m[1]), paired: false }); })) return;
    (p.restore ??= []).push({ phrase, anchor: text.slice(at).trimStart().slice(0, 24).replace(/\s+$/, "") });
  };
  takeOut(new RegExp(String.raw`,?\s*\b(?:committed\s+)?by\s+(${JUV})\b`, "i"), "offender");
  takeOut(new RegExp(String.raw`,?\s*\bagainst\s+(${JUV})\b`, "i"), "victim");
  // The age word before a person word, one to three words away. "juvenile", "minor" and "youth" keep their old reading only (the
  // singular word before victims, arrests or offenders): their other forms ("juveniles arrested", "a juvenile offender", "juvenile
  // arrest rates") are read elsewhere and must keep the user's word in what is restated. "teen", "kid" and "child" in every form
  // are read here: "teenagers arrested for robbery", "kids arrested", "a teen victim", "children victims".
  const OLD_PERSON = String.raw`(victims|arrests|offenders)`;
  const NEW_PERSON = String.raw`(victims?|arrests|arrestees?|offenders?|arrested)`;
  const OLD_AGE = String.raw`(?:juvenile|youth|teen(?:age)?|minor|child|kid)`;
  const NEW_AGE = String.raw`(?:teen(?:age)?(?:rs?)?s?|child(?:ren)?|kids?)`;
  // "murders of teenagers", "children murdered": the victims (Coordinator 2026-11-16).
  const MURDER_AGE = String.raw`(teen\w*|children|kids)`;
  const murderOf = new RegExp(String.raw`\bmurders?\s+of\s+(?:the\s+)?${MURDER_AGE}\b`, "i"), murdered = new RegExp(String.raw`\b${MURDER_AGE}\s+murdered\b`, "i");
  const mo = murderOf.exec(text) ?? murdered.exec(text);
  if (mo) {
    (p.restore ??= []).push({ swap: { from: "murder victims", to: mo[0] } });
    text = text.replace(murderOf, "murder victims").replace(murdered, "murder victims");
    p.where.push({ who: "victim", attr: "age", range: ageOf(mo[1]), paired: false });
    if (/^teen/i.test(mo[1])) p.teen = true;
  }
  let singular = false, ageAt = 0, ageWord = "";
  for (const [age, person] of [[OLD_AGE, OLD_PERSON], [NEW_AGE, NEW_PERSON]]) {
    if (cut(new RegExp(String.raw`\b${age}\s+(?=(?:[a-z]+\s+){0,3}?${person}\b)`, "i"), (m) => {
      const noun = new RegExp(String.raw`^\s*\S+\s+(?:[a-z]+\s+){0,3}?${person}\b`, "i").exec(text.slice(m.index))?.[1].toLowerCase();
      // "kids arrested for robbery" is arrests for robbery.
      if (noun === "arrested") text = text.replace(/\barrested\b/i, "arrests");
      if (/^teen/i.test(m[0])) p.teen = true;
      // P120 (Jeff 2026-11-16, then every side): teen is aged 13 to 19; juvenile, minor, child and kid are under 18.
      const who = /^arrest/.test(noun ?? "") ? "arrestee" : /^offender/.test(noun ?? "") ? "offender" : "victim";
      p.where.push({ who, attr: "age", range: ageOf(m[0]), paired: false });
      // "with a teen victim" leaves "a victim": the article goes, the person stays ("with victim" never reads "a offender").
      singular = /^(?:victim|offender|arrestee)\b/i.test(noun ?? "");
      ageAt = m.index; ageWord = m[0].trim();
    })) {
      // The text after the word is the anchor a restatement puts the word back in front of.
      const anchor = text.slice(ageAt, ageAt + 24).replace(/\s+$/, "");
      const article = singular ? /\b(a|an)\s+$/i.exec(text.slice(0, ageAt))?.[1] : undefined;
      if (singular) text = text.replace(/\b(?:a|an)\s+(?=(?:victim|offender|arrestee)\b)/i, "");
      (p.restore ??= []).push({ word: ageWord, anchor, ...(article ? { article } : {}) });
      break;
    }
  }
  // Arrests (2026-11-11): "arrests of people ..." are arrests; an age range ("aged 18 to 21", "ages 18-24", "between the
  // ages of 18 and 24") is the counted person's own, the arrestee's for arrests, the victim's or offender's otherwise.
  text = text.replace(/\b(arrests?|arrestees|victims|offenders)\s+of\s+(?:people|persons|individuals)\b/gi, "$1");
  const counted = /\b(arrest(?:s|ees?)?)\b/i.test(text) ? "arrestee" : /\boffenders?\b/i.test(text) ? "offender" : /\bvictims?\b/i.test(text) ? "victim" : null;
  if (counted) cut(/,?\s*\b(?:who\s+(?:were|are)\s+)?(?:aged?|ages|between\s+(?:the\s+)?ages?\s+(?:of\s+)?)\s*(\d{1,2})\s*(?:to|-|–|through|and)\s*(\d{1,2})\b(?:\s+years?\s+old)?/i, (m) => {
    const lo = Number(m[1]), hi = Number(m[2]);
    if (lo <= hi) p.where.push({ who: counted, attr: "age", range: [lo, hi], paired: false });
  });
  // Every arrest, with no crime named.
  // A crime the reader finds anywhere is never every arrest ("arrests in Ohio in 2024 for robbery": Codex arrests review).
  const crimeNamed = accountNibrsRequest(text).parts.some((x) => x.concept === "measure" && x.state === "recognized");
  if (!crimeNamed && (/^\s*arrests\s+(?:in|for)\s+(?=[A-Z])/.test(text) || /^\s*arrests\s+in\b/i.test(text))) text = text.replace(/^\s*arrests\b/i, "All crime arrests");
  // Arrests (2026-11-11): "how many arrests ...", "show me all arrestees ...", "the total number of arrests ..." with no
  // crime named are every arrest too.
  else {
    const all = /^\s*(?:please\s+)?(?:how\s+many\s+|(?:can\s+you\s+)?show\s+(?:me\s+)?|give\s+me\s+|what\s+(?:is|was|were)\s+)?(?:the\s+)?(?:total\s+)?(?:number\s+of\s+)?(?:all\s+)?(?:(?:total|overall)\s+)?(?:(nationwide|national|statewide)\s+)?(?:arrests|arrestees)\s+(?=(?:in|for|by|nationally|nationwide|statewide|across|under|over|aged?|ages|from|since|between|per|each)\b|(?:19|20)\d{2}\b)/i.exec(text);
    // Never when the reader finds a crime named anywhere ("how many arrests in 2024 for robbery", "peeping tom"): the
    // reader's own measures decide, never a word list (Codex arrests review 01: "Guntersville", "by sex").
    // A place word before "arrests" ("nationwide arrests") is kept (job AR1).
    if (all && !crimeNamed) text = `All crime arrests ${all[1] ? (/^state/i.test(all[1]) ? "statewide " : "nationally ") : ""}${text.slice(all[0].length)}`;
  }
  const any = p.by || p.where.length || p.ask || p.unsupported;
  return { text, people: any ? p : null };
}

/** Words of the question that only carry a forecast or a court outcome: an alternative drops these and nothing else. */
export const FORECAST_TEXT = /^(?:\s|\b(?:will|would|can|could|you|please|what|be|is|are|it|the|in|for|of|to|forecast\w*|predict\w*|projection\w*|projected|expected|going|go|up|down|rise|rising|increase|increasing|fall|falling|drop|decrease|decline|happen|look|next|year)\b)+$/i;
export const COURT_TEXT = /^(?:\s|\b(?:led|lead|leads|resulted|result|results|went|go|goes|going|gone|sent|were|was|to|in|a|an|the|trial|trials|sentenc\w*|acquit\w*|plea\w*|guilty|conviction\w*|convicted|charged|charges|filed|brought|people|for|with)\b)+$/i;

/** How a rewrite is disclosed in an answer: only spellings change what the user typed into another word. */
export const readingSentence = (r: Reading) => {
  if (r.kind !== "meaning") return `Read "${r.from}" as ${r.to}.`;
  const from = r.from.replace(/^(?:and\s+(?:to\s+)?)?(?:the\s+)?/i, "");
  return `${from[0].toUpperCase()}${from.slice(1)} is read as ${r.to}.`;
};
