/**
 * Request accounting for the Current Trends tab (stage 3a; plan docs/superpowers/plans/2026-10-10-request-accounting-
 * stage3a-current.md, r1.2).
 *
 * Every non-space character of a Current Trends request belongs to a recorded PART (lib/request-accounting.ts). This
 * module is the Current vocabulary: the seven offenses and their categories, counts and rates per 100,000, periods down
 * to the month, rolling 12-month totals, changes between two periods, similar-sized cities (the FBI population group),
 * rankings (owned by the city-ranking path) and places. Each part carries a canonical VALUE so a supported question type
 * or a fixed path's binding can prove it used that exact value. Words this vocabulary does not know become residue
 * (`not-interpreted`); what Current Trends does not track is `not-recorded`, each with its own wording and pointer.
 *
 * Places, years, ranges, thresholds, ranks and change words reuse the accepted Historical rules (stage 2a); months and
 * rolling windows the accepted NIBRS ones (stage 2b). ORDER MATTERS: the ledger refuses overlapping claims.
 */
import { RequestLedger, recordContext, recordBetweenFiller, refusalSentences, couldNotInterpret, type Part, type Span, recordBrokenDown } from "./request-accounting";
import { recordAll, recordPlaces, numberToken, thresholdValue, changeDirection, type Rule } from "./historical-request-accounting";
import { detectCompletenessQuestion } from "./completeness-intent";

const R = (s: string, flags = "gi") => new RegExp(s, flags);
const YEAR = String.raw`(?:19|20)\d{2}`;
const NUM_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty";
const NUMBER = String.raw`(?:\d[\d,]*|${NUM_WORDS})`;
const POP_WORD = String.raw`(?:people|residents|population|persons|inhabitants|pop\.?)`;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = String.raw`(?:${MONTHS.join("|")}|(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?)`;
const monthNo = (name: string) => {
  const t = name.toLowerCase().replace(/\.$/, "");
  const i = MONTHS.indexOf(t);
  return String((i >= 0 ? i : MONTH_ABBR.indexOf(t.slice(0, 3))) + 1).padStart(2, "0");
};

/* ------------------------------------------------------------------ wording ------------------------------------- */

export const CURRENT_CAN_ANSWER =
  "Current Trends answers monthly and yearly counts of seven reported offenses (murder, rape, robbery, aggravated assault, burglary, theft and motor vehicle theft), per-100,000 rates for an agency, 12-month rolling totals, changes between two periods and comparisons with similar-sized cities, for a city or county agency, a state's sample agencies or the national sample.";

const notTracked = (what: string, pointer = "") => (text: string) =>
  `Current Trends doesn't track ${what}, so I can't apply "${text.trim()}"${pointer ? `; ${pointer}` : ""}. I haven't answered with a number that leaves it out.`;
const declined = (reason: string) => (text: string) => `I can't apply "${text.trim()}": ${reason} I haven't answered with a number that leaves it out.`;

const PEOPLE = notTracked("victims, offenders, juveniles or their age, sex or race", "the NIBRS tab records them");
const WEAPONS = notTracked("weapons", "the NIBRS and Homicide Reports tabs record them");
const ARRESTS = notTracked("arrests", "the NIBRS tab records them");
const CLEARANCE = notTracked("clearances", "the Historical tab has yearly clearance rates");
const COURT = notTracked("court outcomes (prosecutions, convictions or sentences); it counts offenses reported to police");
const SUBCITY = notTracked("anything below a city or county agency (ZIP codes, neighborhoods, districts, wards or beats)");
const OTHER_OFFENSE = notTracked("that offense; it counts only murder, rape, robbery, aggravated assault, burglary, theft and motor vehicle theft", "the NIBRS tab covers more offenses");
const DAILY = notTracked("daily figures; it has monthly counts");
const OVERDOSE = notTracked("overdose deaths; drug offenses are not an overdose-death count");
const IMMIGRATION = notTracked("immigration or citizenship status");

/* ------------------------------------------------------------------ rules --------------------------------------- */

/** Month periods, recorded before places so "May 2025" is a period, never a place. */
const MONTH_PERIODS: Rule[] = [
  { concept: "period", value: (m) => `monthrange:${m[2]}-${monthNo(m[1])}:${m[4]}-${monthNo(m[3])}`, pattern: R(String.raw`\b(?:from\s+)?(${MONTH})\s+(${YEAR})\s*(?:-|–|to|through|thru|until)\s*(${MONTH})\s+(${YEAR})\b`) },
  { concept: "period", value: (m) => `monthrange:${m[3]}-${monthNo(m[1])}:${m[3]}-${monthNo(m[2])}`, pattern: R(String.raw`\b(?:(?:from|in|for|during)\s+)?(${MONTH})\s*(?:-|–|to|through|thru|until)\s*(${MONTH}),?\s+(${YEAR})\b`) },
  { concept: "period", value: (m) => `month:${m[2]}-${monthNo(m[1])}`, pattern: R(String.raw`\b(?:(?:in|for|during|of)\s+)?(${MONTH})\s+(${YEAR})\b`) },
];

const EARLY_CONCEPTS = new Set(["source-name", "index", "ori", "phase-unsupported", "rolling", "daily", "court", "sub-city", "peer", "sort", "overview", "other-offense", "overdose-deaths", "immigration-status"]);

const RULES: Rule[] = [
  // The tab's own name is context, claimed first ("Current Trends" is not a "trends" grain).
  { concept: "source-name", state: "context", pattern: R(String.raw`\b(?:the\s+)?current\s+trends(?:\s+(?:tab|data|source))?\b|\brtci\b`) },
  { concept: "ori", pattern: R(String.raw`\bORI\s*[:#]?\s*[A-Z0-9]{7,9}\b|\b[A-Z]{2}\d{7}\b`, "g"), state: "not-interpreted",
    explanation: declined("I can't look an agency up by its ORI code here; please ask by the agency's name.") },
  // ---- preserved operations ----
  { concept: "coverage-lookup", value: () => "coverage", pattern: R(String.raw`\bwhat\s+months\s+does\b|\bmonths\s+does\b|\bwhat\s+(?:years\s+of\s+)?data\s+(?:do\s+you\s+have|is\s+available|are\s+available|exists?)\b|\bwhat\s+years(?:\s+of\s+data)?(?:\s+do\s+you\s+have)?\b|\bavailable\s+(?:data|years|months)\b|\bdata\s+coverage\b|\bcoverage\b|\binclude\b|\b(?:are\s+)?covered\b|\bdo\s+you\s+have\s+data\s+for\b|\b(?:are\s+)?included\b`),
    when: (_m, q) => /\bwhat\s+months\s+does\b|\bwhat\s+(?:years|data)\b|\bavailable\b|\bcoverage\b|\bcovered\b|\bdo\s+you\s+have\s+data\b|\bincluded\b/i.test(q) },
  { concept: "completeness", value: () => "completeness", pattern: R(String.raw`\b(?:completeness|complete|up\s+to\s+date|finali[sz]ed|final)\b`),
    when: (_m, q) => detectCompletenessQuestion(q) !== null },
  { concept: "explain", value: () => "explain", pattern: R(String.raw`\bwhy\b|\bhow\s+come\b|\bwhat\s+explains?\b|\breasons?\s+(?:for|why|behind)\b|\bcauses?\s+(?:of|for|behind)\b|\bexplain(?:s|ed)?\b|\bevidence\s+for\b`) },
  // ---- similar-sized cities (C6), before the size and entity words; value peer:<n>:<kind> ----
  { concept: "peer", value: (m) => `peer:${numberToken((/(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\b/i.exec(m[0]) ?? ["", ""])[1] || "")}:${/count/i.test(m[0]) ? "county" : "city"}`,
    pattern: R(String.raw`\b(?:against\s+|to\s+|with\s+)?(?:${NUMBER}\s+)?(?:other\s+)?(?:cities|counties|agencies|departments|places)\s+of\s+(?:similar|comparable|the\s+same)\s+size\b|\b(?:against\s+|to\s+|with\s+)?(?:${NUMBER}\s+)?(?:other\s+)?(?:similar(?:ly)?[-\s]?(?:sized?)|comparable|peer)\s+(?:cities|city|counties|agencies|departments|places)\b`) },
  // ---- "most common crime" (C3 sorted) and "overview" (all seven), before the rank and measure words ----
  { concept: "sort", value: () => "most-common", pattern: R(String.raw`\b(?:the\s+)?(?:most\s+(?:common|prevalent|frequent|reported)|top)\s+(?:crimes?|offen[cs]es?|type\s+of\s+crime)\b|\bwhich\s+(?:crime|offen[cs]e)\s+(?:is|was)\s+(?:the\s+)?(?:highest|most\s+common)\b`) },
  { concept: "overview", value: () => "all7", pattern: R(String.raw`\b(?:an?\s+)?overview(?:\s+(?:of|for)\s+(?:crime|crimes|trends?|crime\s+trends?))?\b`) },
  // ---- not tracked ----
  // Option 2 stopgap (2026-10-21): overdose deaths and immigration status are not recorded, rather than unread words, so
  // they are refused instead of falling through to the model path. Claimed early, before the drug and place words.
  { concept: "overdose-deaths", pattern: R(String.raw`\b(?:(?:drug|opioid|opiate|fentanyl|heroin)\s+)?overdos(?:e|es|ed|ing)(?:\s+(?:deaths?|fatalities|victims?))?\b`), state: "not-recorded", explanation: OVERDOSE },
  { concept: "immigration-status", pattern: R(String.raw`\b(?:(?:legal|illegal|undocumented|documented|unauthorized|recent|new)\s+)*(?:(?:u\.?s\.?|american|naturali[sz]ed|native[-\s]born)\s+citizens?|(?<=\b(?:by|among)\s+(?:the\s+)?)citizens\b|citizen\s+status|immigrants?|migrants?|immigration(?:[-\s]status)?|citizenship(?:[-\s]status)?|residency\s+status|non[-\s]?citizens?|noncitizens?|illegal\s+aliens?|undocumented(?:\s+(?:people|persons|individuals|residents))?|refugees?|asylum[-\s]seekers?|foreign[-\s](?:born|nationals?)|deportees?|visa\s+holders?|green[-\s]card\s+holders?)\b`), state: "not-recorded", explanation: IMMIGRATION },
  { concept: "court", pattern: R(String.raw`\bconvict(?:ions?|ed|s)?\b|\bsentenc(?:es?|ed|ing)\b|\bprosecut(?:ions?|ed|ors?|e)\b|\bcourts?\b|\bjail(?:s|ed)?\b|\bprobation\b|\bparole\b`), state: "not-recorded", explanation: COURT },
  { concept: "sub-city", pattern: R(String.raw`\bzip\s*codes?\b|\bzip\b|\bneighbou?rhoods?\b|\bdistricts?\b|\bprecincts?\b|\bwards?\s+\d+\b|\bbeats?\b|\bcensus\s+tracts?\b|\bareas?\s+in\b`), state: "not-recorded", explanation: SUBCITY },
  { concept: "daily", pattern: R(String.raw`\bby\s+(?:the\s+)?day\b|\bper\s+day\b|\beach\s+day\b|\bdaily\b`), state: "not-recorded", explanation: DAILY },
  { concept: "other-offense", pattern: R(String.raw`\bcyber[-\s]?crimes?\b|\bshoplifting\b|\bcarjack(?:ing|ings|ed)?\b|\bdomestic(?:\s+violence)?\b|\bhate\s+crimes?\b|\bdui\b|\bdwi\b|\bdrunk\s+driving\b|\bdrugs?(?:[-\s]related)?(?:\s+(?:crimes?|offenses?))?\b|\bnarcotics?\b|\bfraud\b|\bidentity\s+theft\b|\barsons?\b|\bsimple\s+assaults?\b|\bhuman\s+trafficking\b|\bvandalism\b|\bgangs?(?:[-\s]related)?\b`), state: "not-recorded", explanation: OTHER_OFFENSE },
  // An index to a base year (the retired state-index path): not a supported type; state rates are on Historical.
  { concept: "index", pattern: R(String.raw`\b(?:indexed?|indexing)\s+(?:to|on)\s+(?:a\s+)?(?:baseline\s+(?:of\s+)?)?${YEAR}\b|\bindexed\b|\bbaseline(?:\s+year)?\b`), state: "not-interpreted",
    explanation: declined("an index to a base year isn't one of the question types here; ask for the counts directly. National and state rates are on the Historical tab.") },
  { concept: "phase-unsupported", pattern: R(String.raw`\b(?:early|mid|late)[-\s]?(?:(?:19|20)\d0'?s|${YEAR}s?)\b|\b(?:the\s+)?(?:19|20)\d0'?s\b`), state: "not-interpreted",
    explanation: declined("I can't turn that into specific years; please give the years (for example \"from 2024 to 2025\").") },
  // ---- rolling windows and months (before the year rules) ----
  { concept: "rolling", value: () => "rolling12", pattern: R(String.raw`\btotals\b`), when: (m, q) => /\b(?:rolling|trailing)\s+(?:12|twelve)[-\s]?months?\b/i.test(q.slice(0, m.index)) },
  { concept: "rolling", value: () => "rolling12", pattern: R(String.raw`\b(?:rolling|trailing)\s+(?:over\s+)?(?:12|twelve)[-\s]?months?(?:\s+totals?)?\b|\b(?:12|twelve)\s*[-\s]?\s*months?\s+rolling(?:\s+totals?)?\b|\btrailing\s+(?:12|twelve)\s+months\b`) },
  ...MONTH_PERIODS,
  // ---- periods ----
  { concept: "period", value: () => "ytd", pattern: R(String.raw`\b(?:year[-\s]to[-\s]date|ytd|so\s+far\s+this\s+year|this\s+year\s+so\s+far|so\s+far)\b`) },
  { concept: "period", value: (m) => `range:${m[1]}:${m[2]}`, pattern: R(String.raw`\bfrom[.,:]?\s+(${YEAR})\s*(?:-|–|—|to|through|thru|until|till)\s*(${YEAR})\b`) },
  { concept: "period", value: (m) => `between:${m[1]}:${m[2]}`, pattern: R(String.raw`\bbetween\s+(${YEAR})\s+and\s+(${YEAR})\b`) },
  { concept: "period", value: (m) => `since:${m[1]}`, pattern: R(String.raw`\b(?:since|starting(?:\s+in)?|beginning(?:\s+in)?|from)\s+(${YEAR})(?:\s*(?:-|–|to|through|until)\s*(?:the\s+)?(?:present|now|today|current(?:\s+year)?)|\s+on(?:wards?)?)?\b`) },
  { concept: "period", value: (m) => `since:${m[1]}`, pattern: R(String.raw`\b(${YEAR})\s*(?:-|–|to|through|until)\s*(?:the\s+)?(?:present|now|today)\b`) },
  { concept: "period", value: (m) => `range:${m[1]}:${m[2]}`, pattern: R(String.raw`,?\s*\b(${YEAR})\s*(?:-|–|—|to|through|thru)\s*(${YEAR})\b`) },
  { concept: "period", value: (m) => `last:${numberToken(m[1])}`, pattern: R(String.raw`\b(?:over\s+|in\s+|for\s+|during\s+)?(?:the\s+)?(?:last|past|previous|prior)\s+(${NUMBER})\s+(?:(?:full|complete|calendar)\s+)?years\b`) },
  { concept: "period", value: () => "lastyear", pattern: R(String.raw`\b(?:in\s+)?last\s+year\b`) },
  // r2 F1: "the latest month" is the cutoff month and "the latest year" the latest full year -- never the same value.
  { concept: "period", value: () => "latestmonth", pattern: R(String.raw`\b(?:in\s+|for\s+)?(?:the\s+)?(?:latest|most\s+recent)\s+month(?:\s+(?:available|of\s+data))?\b`) },
  { concept: "period", value: () => "latest", pattern: R(String.raw`\b(?:in\s+|for\s+)?(?:the\s+)?(?:latest|most\s+recent)\s+(?:full\s+)?(?:year|data)(?:\s+available)?\b`) },
  // "Last month" names a calendar month relative to today, which the data can't certify: declined, asking for the month.
  { concept: "period-relative-month", pattern: R(String.raw`\b(?:in\s+|for\s+|during\s+)?(?:the\s+)?(?:last|past|previous|prior)\s+month\b`), state: "not-interpreted",
    explanation: declined("\"last month\" depends on today's date, which the data can't confirm; name the month (for example \"in May 2026\") or ask for \"the latest month\".") },
  { concept: "period", value: (m) => `year:${m[1]}`, pattern: R(String.raw`\b(?:in|for|during|using|of)\s+(${YEAR})(?:\s+data)?\b`) },
  { concept: "period", value: (m) => `year:${m[1]}`, pattern: R(String.raw`\b(${YEAR})\b`) },
  // ---- count conditions on a ranking ("with at least 10 murders"): the offense word stays its own measure part ----
  { concept: "count-threshold", value: (m) => `${/over|more\s+than/i.test(m[1]) ? ">" : ">="}|${m[2].replace(/,/g, "")}`,
    pattern: R(String.raw`\b(?:with\s+)?(at\s+least|over|more\s+than)\s+(\d[\d,]*)(?=\s+(?:murders?|homicides?|killings?|rapes?|robber(?:y|ies)|aggravated\s+assaults?|assaults?|burglar(?:y|ies)|thefts?|larcen(?:y|ies)|motor\s+vehicle\s+thefts?|car\s+thefts?|offen[cs]es|crimes)\b)`) },
  // ---- "which 2 cities": the number of places a ranking shows ----
  { concept: "rank", value: (m) => `top:${numberToken(m[1])}`, pattern: R(String.raw`(?<=\bwhich\s+)(${NUMBER})(?=\s+(?:cities|agencies|jurisdictions|places|counties)\b)`) },
  // ---- population thresholds (rankings) ----
  { concept: "threshold", value: (m) => thresholdValue(m[0]), pattern: R(String.raw`\(?\b(?:(?:with|having)\s+)?(?:an?\s+)?(?:(?:populations?|pop\.?)\s+(?:of\s+)?)?(?:at\s+least|over|above|more\s+than|greater\s+than|exceeding|under|below|less\s+than|fewer\s+than|at\s+most|min(?:imum)?(?:\s+of)?|max(?:imum)?(?:\s+of)?)\s+\d[\d,]*(?:\.\d+)?(?:\s*(?:k\b|thousand\b|m\b|million\b))?(?:\s*\+)?(?:\s+${POP_WORD})?(?:\s+or\s+(?:more|larger|greater))?\)?`),
    when: (m) => /(?:population|pop\b|pop\.|people|residents|persons|inhabitants|\d\s*k\b|thousand|million|\bmin\b|\bmin(?:imum)?\b)/i.test(m[0]) },
  { concept: "threshold", value: (m) => thresholdValue(m[0]), pattern: R(String.raw`\b(?:of\s+)?\d[\d,]*\s*(?:k|thousand|million)?\s*(?:${POP_WORD}\s+)?(?:or\s+(?:more|larger|greater)|\+)(?:\s+${POP_WORD})?`),
    when: (m) => /(?:population|people|residents|persons|inhabitants|\d\s*k\b|thousand|million)/i.test(m[0]) },
  // ---- not tracked: clearance, arrests, people, weapons ----
  { concept: "clearance", pattern: R(String.raw`\bclearance(?:\s+rates?)?\b|\bclearances\b|\bcleared\b|\bsolved\b`), state: "not-recorded", explanation: CLEARANCE },
  { concept: "arrests", pattern: R(String.raw`\barrest(?:s|ed|ees?)?\b`), state: "not-recorded", explanation: ARRESTS },
  { concept: "weapon", pattern: R(String.raw`\bgun\s+(?:crimes?|violence)\b|\b(?:guns?|firearms?|handguns?|rifles?|shotguns?|knives|knife|weapons?|shootings?|armed)\b`), state: "not-recorded", explanation: WEAPONS },
  // "sexual assault" is the UCR rape category, claimed before the people words.
  { concept: "measure", value: () => "rape", pattern: R(String.raw`\bsexual\s+assaults?\b`) },
  { concept: "people", pattern: R(String.raw`\b(?:victims?|offenders?|suspects?|perpetrators?|juveniles?|youths?|minors?|children|kids?|teen(?:ager)?s?|adults?|elderly|seniors?|males?|females?|men|women|boys?|girls?|black|white|hispanics?|latin[oa]s?|asians?|race|racial|ethnicit(?:y|ies)|gender|ages?|aged)\b`), state: "not-recorded", explanation: PEOPLE },
  { concept: "safest", pattern: R(String.raw`\b(?:safest|most\s+dangerous|least\s+safe|least\s+dangerous|dangerous)\b`), state: "not-interpreted",
    explanation: declined("there's no agreed definition of safest or most dangerous; ask for a specific offense and a count or rate.") },
  // ---- statistic and scale ----
  { concept: "statistic", value: () => "per100k", pattern: R(String.raw`\bper\s+100(?:,?000|\s*k|\s+thousand)(?:\s+${POP_WORD})?\b`) },
  { concept: "statistic", value: (m) => `scale:${m[1]}`, pattern: R(String.raw`\bper\s+(\d[\d,]*(?:\s*k\b)?|ten\s+thousand|million|one\s+million|thousand)(?:\s+${POP_WORD})?\b`) },
  { concept: "statistic", value: () => "percapita", pattern: R(String.raw`\bper[-\s]capita\b`) },
  { concept: "statistic", value: () => "rate", pattern: R(String.raw`\brates?\b`) },
  { concept: "statistic", value: () => "count", pattern: R(String.raw`\bhow\s+many\b|\b(?:total\s+)?(?:numbers?|counts?)(?:\s+of)?\b|\btotals\b`) },
  // ---- ranking (the city-ranking path owns rankings) ----
  { concept: "rank", value: (m) => `${/bottom/i.test(m[1]) ? "bottom" : "top"}:${numberToken(m[2])}`, pattern: R(String.raw`\b(top|bottom)\s+(${NUMBER})\b`) },
  { concept: "rank", value: (m) => `${/lowest|fewest|least|smallest/i.test(m[0]) ? "bottom" : "top"}:`, pattern: R(String.raw`\b(?<!\bat\s)(?:the\s+)?(?:highest|lowest|most|fewest|least|largest|smallest|greatest|biggest)\b`) },
  { concept: "rank", value: () => "rank:", pattern: R(String.raw`\b(?:rank(?:ed|ing|ings)?|top)\b`) },
  // ---- change and comparison ----
  { concept: "change", value: (m) => `change:${changeDirection(m[0])}`, pattern: R(String.raw`\b(?:percent(?:age)?\s+change|%\s*change|change[sd]?|changing|increase[sd]?|increasing|decrease[sd]?|decreasing|rise|rose|risen|rising|fall(?:en)?|fell|falling|drop(?:ped|s)?|declin(?:e|ed|es|ing)|grew|grow(?:n|th)?|went\s+(?:up|down))\b`) },
  { concept: "versus", value: () => "versus", pattern: R(String.raw`\b(?:vs\.?|versus|compared\s+(?:to|with)|against)(?=\s|$)`) },
  { concept: "compare", state: "context", pattern: R(String.raw`\bcompar(?:e[ds]?|ing|ison)\b|\bside\s+by\s+side\b`) },
  // ---- lists and grain ----
  { concept: "list", value: (m) => `list:${listKey(m[1])}`, pattern: R(String.raw`\b(?:broken\s+down\s+by|by|per|for\s+each|for\s+every|each|every|across)\s+(state|count(?:y|ies)|cit(?:y|ies)|agenc(?:y|ies)|departments?)\b`) },
  { concept: "grain", value: () => "month", pattern: R(String.raw`\b(?:by|per|each|every|for\s+each)\s+month\b|\bmonthly\b|\bmonth[-\s]by[-\s]month\b`) },
  { concept: "grain", value: () => "year", pattern: R(String.raw`\b(?:by|per|each|every|for\s+each)\s+year\b|\byearly\b|\bannual(?:ly)?\b|\byear[-\s](?:by|over)[-\s]year\b`) },
  { concept: "grain", value: () => "trend", pattern: R(String.raw`\bover\s+time\b|\btrends?\b`) },
  // ---- measures: the seven offenses and their categories ----
  { concept: "measure", value: () => "motor_vehicle_theft", pattern: R(String.raw`\b(?:motor[-\s]vehicle|auto(?:mobile)?|car|vehicle)\s+thefts?\b|\bmvt\b`) },
  { concept: "measure", value: () => "violent_crime", pattern: R(String.raw`\b(?:total\s+)?violent(?:\s+(?:crimes?|offen[cs]es?))?\b`) },
  { concept: "measure", value: () => "property_crime", pattern: R(String.raw`\b(?:total\s+)?property(?:\s+(?:crimes?|offen[cs]es?))?\b`) },
  { concept: "measure", value: () => "all7", pattern: R(String.raw`\b(?:all\s+(?:seven|7)\s+(?:offen[cs]es|crimes)|part\s+(?:i|1|one)\s+(?:crimes?|offen[cs]es?))\b`) },
  { concept: "measure", value: () => "murder", pattern: R(String.raw`\bmurders?\b|\bhomicides?\b|\bkillings?\b`) },
  { concept: "measure", value: () => "rape", pattern: R(String.raw`\brapes?\b`) },
  { concept: "measure", value: () => "robbery", pattern: R(String.raw`\brobber(?:y|ies)\b`) },
  { concept: "measure", value: () => "aggravated_assault", pattern: R(String.raw`\b(?:aggravated\s+|agg\.?\s+)?assaults?\b`) },
  { concept: "measure", value: () => "burglary", pattern: R(String.raw`\bburglar(?:y|ies)\b|\bbreak[-\s]?ins?\b`) },
  { concept: "measure", value: () => "theft", pattern: R(String.raw`\blarcen(?:y|ies)\b|\bthefts?\b`) },
  { concept: "measure", value: () => "unspecified", pattern: R(String.raw`\bcrimes?\b|\boffen[cs]es?\b`) },
  // ---- combine ----
  { concept: "combine", value: () => "combine", pattern: R(String.raw`\b(?:combined|altogether|all\s+together|in\s+total|in\s+all|summed|sum\s+of|together)\b`) },
  { concept: "combine", value: () => "combine", pattern: R(String.raw`\btotal\b`) },
  // ---- national and entity words ----
  { concept: "place", value: () => "national", pattern: R(String.raw`(?<![A-Za-z.])(?:U\.S\.A?\.?|USA|US)(?![A-Za-z])`, "g") },
  { concept: "place", value: () => "national", pattern: R(String.raw`\b(?:(?:in\s+)?the\s+)?(?:national(?:ly)?|nationwide|countrywide|united\s+states|america|(?:the\s+)?(?:nation|country))\b`) },
  { concept: "statewide", state: "context", pattern: R(String.raw`\bstate[-\s]?wide\b|\bthe\s+whole\s+state\b`) },
  { concept: "entity", value: (m) => listKey(m[0]), pattern: R(String.raw`\b(?:county\s+(?:agenc(?:y|ies)|sheriffs?(?:['’]\s*offices)?)|sheriffs?(?:['’]\s*offices)?|police\s+(?:departments?|agencies)|cities|city|towns?|counties|agencies|agency|departments|jurisdictions?|states|state)\b`) },
  // ---- presentation and connectors ----
  { concept: "presentation", state: "context", pattern: R(String.raw`\b(?:(?:in|as)\s+(?:a\s+)?)?(?:rtci|current\s+trends|fbi|crime\s+data|data|stats|statistics|info(?:rmation)?|chart|graph|table|plot|figures|numbers|breakdown|summary|list|results?|series)\b`) },
  { concept: "connector", state: "context", pattern: R(String.raw`(?:^|\s)(?:and|&|,)(?=\s|$)`) },
  { concept: "connector", state: "context", pattern: R(String.raw`\bbetween\b(?=\s+(?:the\s+)?(?:city\s+of\s+)?[A-Z])`, "g") },
  { concept: "connector", state: "context", pattern: R(String.raw`\b(?:now\s+)?what\s+about\b|\b(?:only|just)\s+(?:those|the\s+ones|the)\b|\bsame\s+for\b|\bshow\s+me\s+that\b|\bthat\b(?=\s+(?:per|as|by))|\bnow\b`) },
];

function listKey(raw: string): string {
  const t = raw.toLowerCase();
  if (/county|sheriff/.test(t)) return "county";
  if (/cit(?:y|ies)|town|jurisdiction/.test(t)) return "city";
  if (/agenc|department|police/.test(t)) return "agency";
  if (/state/.test(t)) return "state";
  return t;
}

/** Which-words opening a ranking or list ("which cities had the most"). Context only beside an entity. */
function recordWhich(ledger: RequestLedger): void {
  const re = /\b(?:which|what)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ledger.question))) {
    const rest = ledger.question.slice(m.index + m[0].length);
    if (/^\s+(?:\d+\s+)?(?:cities|city|states?|counties|county|agencies|agency|departments?|towns?|jurisdictions?|police)\b/i.test(rest) || /^\s+(?:is|was)\s+the\s+most\b/i.test(rest)) {
      ledger.record({ concept: "which", span: [m.index, m.index + m[0].length], rule: "which", state: "context" });
    }
  }
}

/** Current filler beyond the shared between-filler words: verbs and articles that never restrict. */
const CURRENT_FILLER = /^(?:had|have|has|were|was|is|are|there|been|the|a|an|in|of|for|with|by|from|at|on|to|me|do|does|did|i|you|see|can|could|show|give|find|get|list|what|which|many|much|data|people|reported|recorded|occurred|it|its|their|lot|all|any|each|per|year|years|over|about|use|using|please|just|also|then|those|these|this|that|same|other|than|level|levels|numbers?|crime|police|happened|provide|one|where|when|occur|committed|report|how|did|my|our|tell|know|current|recent|trends?|so|far|month|months|bv|now|but|only|show|like)$/i;

function recordCurrentFiller(ledger: RequestLedger): void {
  recordBetweenFiller(ledger);
  const q = ledger.question;
  const recorded = [...ledger.parts].sort((a, b) => a.span[0] - b.span[0]);
  for (const piece of ledger.residue()) {
    if (!CURRENT_FILLER.test(piece.text)) continue;
    const before = /^\s*$/.test(q.slice(0, piece.span[0])) || recorded.some((p) => p.span[1] <= piece.span[0] && /^[\s,]*$/.test(q.slice(p.span[1], piece.span[0])));
    const after = recorded.some((p) => p.span[0] >= piece.span[1] && /^[\s,]*$/.test(q.slice(piece.span[1], p.span[0]))) || /^[\s?.!]*$/.test(q.slice(piece.span[1]));
    if (before && after) ledger.record({ concept: "filler", span: piece.span, rule: "current-filler", state: "context" });
  }
}

/* ------------------------------------------------------------------------------ entry point --------------------- */

/**
 * The Current Trends ledger for one request (the EFFECTIVE question). Finalized: every character is a part. Clause 1 holds
 * an explanation request when the same turn also asks for a number, so the number is answered and the explanation named.
 */
export function accountCurrentRequest(question: string): RequestLedger {
  const ledger = new RequestLedger(question);
  recordBrokenDown(ledger); // Stage 3b r2 (R2.7)
  recordContext(ledger);
  const early = RULES.filter((r) => EARLY_CONCEPTS.has(r.concept) || MONTH_PERIODS.includes(r));
  for (const rule of early) recordAll(ledger, rule);
  recordPlaces(ledger);
  recordAll(ledger, { concept: "possessive", state: "context", pattern: /['’]s\b/g, when: (pm) => ledger.parts.some((p) => p.concept === "place" && p.span[1] >= pm.index - 1 && p.span[1] <= pm.index) });
  for (const rule of RULES.filter((r) => !early.includes(r))) recordAll(ledger, rule);
  recordWhich(ledger);
  recordCurrentFiller(ledger);
  recordCurrentFiller(ledger);
  const explainParts = ledger.parts.filter((p) => p.concept === "explain");
  const numericAsk = hasExplicitNumericAsk(ledger.parts);
  for (const p of explainParts) p.clause = explainParts.length > 0 && numericAsk ? 1 : 0;
  const pieces = ledger.residue().filter((piece) => !/^[\p{P}\p{S}]+$/u.test(piece.text));
  for (let i = 0; i < pieces.length;) {
    let j = i;
    while (j + 1 < pieces.length && /^\s+$/.test(question.slice(pieces[j].span[1], pieces[j + 1].span[0]))) j += 1;
    if (j > i) {
      const span: Span = [pieces[i].span[0], pieces[j].span[1]];
      ledger.record({ concept: "unrecognized", span, rule: "residue-run", state: "not-interpreted", explanation: couldNotInterpret(question.slice(span[0], span[1])) });
    }
    i = j + 1;
  }
  ledger.finalize(() => 0);
  return ledger;
}

/** Recognition-time refusals: not-tracked topics and not-interpreted words, in written order. */
export function currentRecognitionRefusal(ledger: RequestLedger): { parts: Part[]; explanation: string } | null {
  const parts = ledger.refusedAtRecognition();
  if (parts.length === 0) return null;
  return { parts, explanation: refusalSentences(parts).join(" ") };
}

/** The Current response-cache namespace (plan §6): no entry cached before 3a -- a model statement -- can be served. */
export const CURRENT_CACHE_TAB = "current:request-accounting-3a";

/** The reply when the model wrote a statement on the Current Trends tab: it never runs (plan §6). */
export const CURRENT_MODEL_SQL_DECLINE =
  `${CURRENT_CAN_ANSWER} I build Current Trends answers from the supported question types and couldn't match this one, so I haven't run a query for it.`;

/**
 * An EXPLICIT numeric ask: a statistic, a rank, a threshold, a rolling window, or an explicit year, month or range. The
 * same definition decides text vs numeric and the clause of an explanation request.
 */
export function hasExplicitNumericAsk(parts: Part[]): boolean {
  return parts.some((p) => p.state !== "context" && (
    p.concept === "statistic" || p.concept === "rank" || p.concept === "threshold" || p.concept === "rolling"
    || (p.concept === "period" && /^(?:year|range|between|since|month|monthrange|ytd)/.test(p.value ?? ""))));
}

const NUMERIC_CONCEPTS = new Set(["measure", "statistic", "rank", "threshold", "change", "combine", "list", "grain", "period", "versus", "rolling", "peer", "sort", "overview"]);
const REFUSED_CONCEPTS = new Set(["ori", "court", "sub-city", "daily", "other-offense", "phase-unsupported", "clearance", "arrests", "weapon", "people", "safest"]);
const OPERATIONS = ["coverage-lookup", "completeness"];

/**
 * How the request is handled, decided from the ledger:
 *   - `text`: an explanation request with no explicit numeric ask, or a turn with no numeric wording at all;
 *   - `numeric`: everything else. Recognition refusals apply; only a fixed path or a supported type may answer.
 */
export function currentRequestKind(ledger: RequestLedger): "text" | "numeric" {
  const explain = ledger.parts.some((p) => p.concept === "explain");
  if (explain && !hasExplicitNumericAsk(ledger.parts)) return "text";
  const anyNumeric = ledger.parts.some((p) => NUMERIC_CONCEPTS.has(p.concept) || REFUSED_CONCEPTS.has(p.concept));
  const operation = ledger.parts.some((p) => OPERATIONS.includes(p.concept));
  if (!anyNumeric && !operation && !explain) return "text";
  return "numeric";
}

/**
 * K2 for Current (the 2b check): a follow-up is answered only when the effective question (from ANY resolver) carries
 * every restriction of a COMPLETE earlier question, or replaces it with a value this turn states, value by value per
 * concept.
 */
export function currentFollowupCheck(opts: {
  question: string;
  effective: string | null;
  previousUserTurns: string[];
  isFollowUp: (q: string) => boolean;
  /** TEXT turns rebuilt by a resolver: only the earlier question's restrictions are required. */
  earlierOnly?: boolean;
}): { explanation: string } | null {
  const COMPLETE = "Please ask it as a complete question (the place, what to count and the period).";
  const previous = opts.previousUserTurns[opts.previousUserTurns.length - 1];
  if (!previous) return null;
  if (opts.isFollowUp(previous)) return { explanation: `This builds on an earlier follow-up, so I can't be sure which conditions from before still apply. ${COMPLETE}` };
  if (!opts.effective) return { explanation: `I couldn't rebuild this follow-up together with your earlier question here. ${COMPLETE}` };
  const prev = accountCurrentRequest(previous);
  const turn = accountCurrentRequest(opts.question);
  const rec = accountCurrentRequest(opts.effective);
  const meaningful = (l: RequestLedger) => l.parts.filter((p) => p.state !== "context" && p.concept !== "explain");
  const key = (p: Part) => (p.concept === "statistic" ? "statistic" : p.concept);
  const val = (p: Part) => {
    if (p.concept === "statistic" && ["rate", "per100k", "percapita"].includes(p.value ?? "")) return "rate";
    return p.value ?? p.text.toLowerCase().replace(/\s+/g, " ").trim();
  };
  const values = (l: RequestLedger, k: string) => new Set(meaningful(l).filter((p) => key(p) === k).map(val));
  const keys = new Set([...meaningful(prev), ...(opts.earlierOnly ? [] : meaningful(turn))].map(key));
  for (const k of keys) {
    const fromPrev = values(prev, k);
    const fromTurn = opts.earlierOnly ? new Set<string>() : values(turn, k);
    const inRec = values(rec, k);
    const required = fromTurn.size ? fromTurn : fromPrev;
    const missing = [...required].filter((v) => !inRec.has(v));
    if (missing.length) {
      const source = fromTurn.size ? turn : prev;
      const texts = meaningful(source).filter((p) => key(p) === k && missing.includes(val(p))).map((p) => `"${p.text.trim()}"`);
      return { explanation: `I couldn't carry ${texts.join(" and ")} from your ${fromTurn.size ? "follow-up" : "earlier question"} into this answer, so I haven't answered with a number that leaves it out. ${COMPLETE}` };
    }
  }
  return null;
}
