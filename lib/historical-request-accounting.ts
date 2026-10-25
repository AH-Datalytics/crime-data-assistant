/**
 * Request accounting for the Historical tab (stage 2a; plan docs/superpowers/plans/2026-10-08-request-accounting-
 * stage2a-historical.md, r1.1 + K2/K7).
 *
 * Every non-space character of a Historical request belongs to a recorded PART (lib/request-accounting.ts). This module
 * is the Historical vocabulary: what each stretch of words means, recorded with a canonical VALUE so a later consumer
 * (a supported question type, or a fixed path's binding) can prove it used that exact value. Words this vocabulary does
 * not know become residue (`not-interpreted`); topics the Historical source does not hold are `not-recorded`, each
 * with its own wording. Nothing here answers; it only accounts.
 *
 * ORDER MATTERS: the ledger refuses overlapping claims, so specific rules are recorded before general ones
 * ("motor vehicle theft" before "theft", "sexual assault" before "assault", "clearance rate" before "rate").
 */
import { RequestLedger, recordContext, recordBetweenFiller, refusalSentences, couldNotInterpret, type Part, type Span, recordBrokenDown } from "./request-accounting";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { STATE_NAME_TO_ABBR } from "./state-population";
import { detectCompletenessQuestion } from "./completeness-intent";

export type Rule = {
  concept: string;
  pattern: RegExp;
  value?: (m: RegExpExecArray) => string;
  state?: "context" | "not-recorded" | "not-interpreted";
  explanation?: (text: string) => string;
  /** Optional guard on the match (its text and span). */
  when?: (m: RegExpExecArray, q: string) => boolean;
};

const R = (s: string, flags = "gi") => new RegExp(s, flags);
const lower = (m: RegExpExecArray) => m[0].trim().toLowerCase();
const YEAR = String.raw`(?:19|20)\d{2}`;
const NUM_WORD: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", fifteen: "15", twenty: "20", thirty: "30", fifty: "50" };
const NUMBER = String.raw`(?:\d[\d,]*|${Object.keys(NUM_WORD).join("|")})`;
const POP_WORD = String.raw`(?:people|residents|population|persons|inhabitants|pop\.?)`;
const MONTH = String.raw`(?:january|february|march|april|may|june|july|august|september|october|november|december)`;
const MONTH_ABBR = String.raw`(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?`;

/* ------------------------------------------------------------------ wording ------------------------------------- */

export const HISTORICAL_CAN_ANSWER =
  "Historical answers yearly reported-crime counts and rates, clearance percentages and police staffing for the U.S., a state, or a city or county agency.";

const notRecorded = (what: string, pointer = "") => (text: string) =>
  `Historical doesn't record ${what}, so I can't apply "${text.trim()}"${pointer ? `; ${pointer}` : ""}. I haven't answered with a number that leaves it out.`;

const WEAPONS = notRecorded("weapons", "Homicide Reports and NIBRS do");
const PEOPLE = notRecorded("victims, offenders or their age, sex or race", "Homicide Reports and NIBRS do");
const ARRESTS = notRecorded("arrests", "the NIBRS tab does");
const COURT = notRecorded("convictions, sentences, prosecutions or prison outcomes; it records crimes reported to police, clearances and staffing");
const TOPIC = notRecorded("hate crimes, domestic, gang or drug-related offenses as separate categories");
const OVERDOSE = notRecorded("overdose deaths; drug offenses are not an overdose-death count");
const IMMIGRATION = notRecorded("immigration or citizenship status");
const POLICY = notRecorded("policies, laws or legalization, or their effects; it records reported crimes");
const DOCUMENTS = notRecorded("documents, diagrams or policy material; it holds crime statistics");
const SUBCITY = notRecorded("anything below the level of a city or county agency (ZIP codes, neighborhoods, districts)");
// Historical vocabulary pass (2026-10-24, Codex ACCEPT): the pointer says what the other tab has, not that it answers.
const SUBYEAR = notRecorded("months, quarters or seasons; its figures are yearly", "Current Trends has monthly figures for its sample agencies");
const declined = (reason: string) => (text: string) => `I can't apply "${text.trim()}": ${reason} I haven't answered with a number that leaves it out.`;

/* ------------------------------------------------------------------ rules --------------------------------------- */

const STATE_NAMES = Object.keys(STATE_NAME_TO_ABBR as Record<string, string>).filter((n) => n.toLowerCase() !== "united states");

const RULES: Rule[] = [
  // ---- typed agency codes (declined: ask by name) ----
  { concept: "ori", pattern: R(String.raw`\bORI\s*[:#]?\s*[A-Z0-9]{7,9}\b|\b[A-Z]{2}\d{5}(?:\d{2})?\b|\b[A-Z]{2}[A-Z]{3}\d{4}\b`, "g"), state: "not-interpreted",
    explanation: declined("I can't look an agency up by its ORI code here; please ask by the agency's name.") },
  // ---- preserved operations ----
  { concept: "prison-population", value: () => "prison", pattern: R(String.raw`\b(?:(?:the\s+)?(?:u\.?s\.?\s+)?prison\s+populations?|incarceration(?:\s+rates?)?|(?:people\s+)?incarcerated)\b`) },
  { concept: "scorecard", value: () => "scorecard", pattern: R(String.raw`\b(?:crime\s+)?score[ \t-]*cards?\b|\breport\s+cards?\b`) },
  { concept: "peer", value: () => "peer", pattern: R(String.raw`\b(?:the\s+)?(?:national\s+average|peer\s+city\s+average|peer\s+cities|peer\s+city|peers?|(?:other\s+)?(?:similar(?:ly)?[-\s]?(?:sized?)?|comparable)\s+(?:cities|agencies|departments)(?:\s+(?:in|by)\s+size)?)\b`) },
  { concept: "coverage-lookup", value: () => "coverage", pattern: R(String.raw`\bwhat\s+(?:years\s+of\s+)?data\s+(?:do\s+you\s+have|is\s+available|are\s+available|exists?)\b|\bwhat\s+years(?:\s+of\s+data)?(?:\s+do\s+you\s+have)?\b|\b(?:years\s+of\s+)?data\s+do\s+you\s+have\b|\bavailable\s+(?:data|years)\b|\bdata\s+coverage\b|\bcoverage\b`) },
  { concept: "completeness", value: () => "completeness", pattern: R(String.raw`\b(?:completeness|complete|up\s+to\s+date|finali[sz]ed|final)\b`),
    when: (_m, q) => detectCompletenessQuestion(q) !== null },
  { concept: "explain", value: () => "explain", pattern: R(String.raw`\bwhy\b|\bhow\s+come\b|\bwhat\s+explains?\b|\breasons?\s+(?:for|why|behind)\b|\btheor(?:y|ies)\b|\bcauses?\s+(?:of|for|behind)\b|\bexplain(?:s|ed)?\b|\bcorrelat(?:e[sd]?|ions?)(?:\s+(?:between|with))?\b|\bfactors?\s+(?:that\s+)?(?:correlate|drive|cause|contribute|explain)(?:s|d)?(?:\s+(?:with|to))?(?:\s+(?:higher|lower|more|fewer))?\b|\b(?:has|have|had)\s+affected\b|\b(?:effects?|impacts?)\s+of\b`) },
  // ---- not recorded in Historical (sexual assault is a measure, claimed before the people words) ----
  // Option 3 batch 1 (2026-10-21, carried from the reverted #36): overdose deaths and immigration/citizenship status
  // are not recorded, so they are refused by name rather than as unread words. Claimed early, before the drug and place words.
  { concept: "overdose-deaths", pattern: R(String.raw`\b(?:(?:drug|opioid|opiate|fentanyl|heroin)\s+)?overdos(?:e|es|ed|ing)(?:\s+(?:deaths?|fatalities|victims?))?\b`), state: "not-recorded", explanation: OVERDOSE },
  { concept: "immigration-status", pattern: R(String.raw`\b(?:(?:legal|illegal|undocumented|documented|unauthorized|recent|new)\s+)*(?:(?:u\.?s\.?|american|naturali[sz]ed|native[-\s]born)\s+citizens?|(?<=\b(?:by|among)\s+(?:the\s+)?)citizens\b|citizen\s+status|immigrants?|migrants?|immigration(?:[-\s]status)?|citizenship(?:[-\s]status)?|residency\s+status|non[-\s]?citizens?|noncitizens?|illegal\s+aliens?|undocumented(?:\s+(?:people|persons|individuals|residents))?|refugees?|asylum[-\s]seekers?|foreign[-\s](?:born|nationals?)|deportees?|visa\s+holders?|green[-\s]card\s+holders?)\b`), state: "not-recorded", explanation: IMMIGRATION },
  { concept: "court", pattern: R(String.raw`\bconvict(?:ions?|ed|s)?\b|\bsentenc(?:es?|ed|ing)\b|\bprosecut(?:ions?|ed|ors?|e)\b|\bcourts?\b|\bjail(?:s|ed)?\b|\bprobation\b|\bparole\b|\bcorruption(?:[-\s]related)?\b`), state: "not-recorded", explanation: COURT },
  { concept: "arrests", pattern: R(String.raw`\barrest(?:s|ed|ees?)?\b`), state: "not-recorded", explanation: ARRESTS },
  { concept: "weapon", pattern: R(String.raw`\bgun\s+(?:crimes?|violence)\b|\b(?:guns?|firearms?|handguns?|rifles?|shotguns?|knives|knife|weapons?|shootings?|shot)\b`), state: "not-recorded", explanation: WEAPONS },
  // Option 3 batch 1 (P175, P240): policies and laws, and documents or diagrams, are not what Historical holds.
  // Option 3 batch 1 (P203): "where can I find (more) data on …" asks about sources; the text path answers it.
  { concept: "meta-source", pattern: R(String.raw`^\s*where\s+(?:can|could|do|should)\s+i\s+(?:find|get|see|look\s+for)\s+(?:more\s+)?(?:data|information|info|statistics|numbers)(?:\s+(?:on|about|for)\b[^?.!,;]*?(?=\s*(?:[?.!,;]|\band\b|$)))?`) },
  // Historical vocabulary pass (2026-10-24, Codex): the whole staffing phrase is claimed before the policy detector reads
  // "law" (L9533 "sworn law enforcement officers"). "law enforcement agencies" is not staffing and is left alone.
  { concept: "staffing", value: () => "officers", pattern: R(String.raw`\b(?:total\s+)?(?:sworn\s+)?law[-\s]enforcement\s+officers?\b`) },
  { concept: "staffing", value: () => "employees", pattern: R(String.raw`\b(?:total\s+)?law[-\s]enforcement\s+(?:employees|personnel|staff)\b`) },
  { concept: "policy", pattern: R(String.raw`\b(?:(?:marijuana|cannabis)\s+)?legali[sz](?:ation|ed|ing)\b|\b(?:new\s+)?(?:laws?|policies|policy)\b(?!\s+(?:staffing|officers?|departments?|force|employees?))`), state: "not-recorded", explanation: POLICY },
  { concept: "documents", pattern: R(String.raw`\b(?:flowcharts?|(?:strategy\s+)?diagrams?|fact\s*sheets?|roadmaps?)\b[^?.!]*`), state: "not-recorded", explanation: DOCUMENTS },
  { concept: "topic", pattern: R(String.raw`\bhate\s+crimes?\b|\bbias(?:[-\s]motivated)?\b|\bdomestic(?:\s+violence)?\b|\bgangs?(?:[-\s]related)?\b|\bdrugs?(?:[-\s]related)?\b|\bnarcotics?\b`), state: "not-recorded", explanation: TOPIC },
  { concept: "sub-city", pattern: R(String.raw`\bzip\s*codes?\b|\bzip\b|\bneighbou?rhoods?\b|\bdistricts?\b|\bprecincts?\b|\bbeats?\b|\bcensus\s+tracts?\b|\bblocks?\b`), state: "not-recorded", explanation: SUBCITY },
  { concept: "sub-year", pattern: R(String.raw`\b(?:in|during|for|of|from|through|to|until)\s+(?:${MONTH})\b(?:\s+${YEAR})?|\b(?:${MONTH}|${MONTH_ABBR})\s+${YEAR}\b|\bq[1-4]\b|\bquarter(?:ly|s)?\b|\bmonth(?:ly|s)?\b|\bweek(?:ly|s)?\b|\bdaily\b|\bseasons?\b|\b(?:summer|winter|spring|autumn)s?\b|\b(?:first|second)\s+half\b|\bfiscal\s+years?\b`), state: "not-recorded", explanation: SUBYEAR },
  // Victims, offenders and demographic words. "sexual assault" is a measure (the UCR rape category), claimed first.
  { concept: "measure", value: () => "rape", pattern: R(String.raw`\bsexual\s+assaults?\b`) },
  { concept: "people", pattern: R(String.raw`\b(?:victims?|offenders?|suspects?|perpetrators?|defendants?|killers?|juveniles?|youths?|minors?|children|kids?|teen(?:ager)?s?|adults?|elderly|seniors?|males?|females?|men|women|boys?|girls?|black|white|hispanics?|latin[oa]s?|asians?|race|racial|ethnicit(?:y|ies)|gender|sex|ages?|aged)\b`), state: "not-recorded", explanation: PEOPLE },
  { concept: "safest", pattern: R(String.raw`\b(?:safest|most\s+dangerous|least\s+safe|least\s+dangerous|dangerous|safe)\b`), state: "not-interpreted",
    explanation: declined("there's no agreed definition of safest or most dangerous; ask for a specific offense and a count or rate.") },
  { concept: "size", pattern: R(String.raw`\b(?:big|bigger|biggest\s+cities|large|larger|major|small|smaller|mid[-\s]?sized?|medium[-\s]sized?|rural|urban|suburban)\b(?=\s+(?:cities|city|towns?|counties|agencies|departments|places|metros?|areas?))`), state: "not-interpreted",
    explanation: declined("no size is defined for that word; give a minimum population instead (for example \"with at least 250,000 people\").") },
  // Option 3 batch 1 (P039): an all-time ranking has two meanings; ask which, and for the years (the all-time shape is deferred).
  { concept: "period-unsupported", pattern: R(String.raw`\b(?:ever\s+recorded|of\s+all\s+time|all[-\s]time)\b`), state: "not-interpreted",
    explanation: (t: string) => `I can't rank "${t.trim()}" yet: say whether you mean the highest single years for any place or each place's highest year, and name the years to rank (one year, or a range). I haven't answered with a number that leaves it out.` },
  // Option 3 batch 1 (P305): a five-digit "year" is never corrected; ask which year was meant.
  { concept: "period-unsupported", pattern: R(String.raw`\b(?:since|from|in|after|before|through|until)\s+\d{5,}\b`), state: "not-interpreted",
    explanation: (t: string) => `"${t.trim()}" doesn't name a year I can use. Which year did you mean? I haven't answered with a number that leaves it out.` },
  { concept: "period-unsupported", pattern: R(String.raw`\b(?:early|mid|late)[-\s]?(?:(?:19|20)\d0'?s|${YEAR}s?)\b`), state: "not-interpreted",
    explanation: declined("I can't turn that into specific years; please give the years (for example \"from 2020 to 2023\").") },
  // Historical vocabulary pass (2026-10-24, Codex): an exact calendar decade is read below as its ten years; a decade
  // not yet over ("the 2020s") is still declined here, so a range is never silently cut short.
  { concept: "period-unsupported", pattern: R(String.raw`\b(?:(?:since|from|in|during)\s+)?(?:the\s+)?((?:19|20)\d0)'?s\b`), state: "not-interpreted",
    when: (m) => Number(m[1]) + 9 >= new Date().getFullYear(),
    explanation: declined("I can't turn that into specific years; please give the years (for example \"from 2020 to 2023\").") },
  // ---- periods (years only; raw values kept). Before ranking words: "the most recent year" is a period. ----
  // Historical vocabulary pass (2026-10-24, Codex): exact decades ("since the 2000s" = from 2000; "in the 1940s" =
  // 1940-1949). Early/mid/late and unfinished decades are declined above.
  { concept: "period", value: (m) => `since:${m[1]}`, pattern: R(String.raw`\b(?:since|from|starting\s+in)\s+(?:the\s+)?((?:19|20)\d0)'?s\b`) },
  // Codex consolidated review: only interval words ("through the 1990s" is an endpoint, not the decade; it stays unread).
  { concept: "period", value: (m) => `range:${m[1]}:${Number(m[1]) + 9}`, pattern: R(String.raw`\b(?:(?:in|during|for|throughout)\s+)?(?:the\s+)?((?:19|20)\d0)'?s\b`),
    when: (m, q) => !/\b(?:through|thru|until|till|to)\s+(?:the\s+)?$/i.test(q.slice(0, m.index)) },
  // Explicit requests for the full history (= every available year; any other bound in the question still applies).
  { concept: "period", value: () => "all", pattern: R(String.raw`\b(?:for\s+)?as\s+many\s+years\s+as\s+(?:possible|available|you\s+have)\b|\bas\s+far\s+back\s+as\s+(?:available|(?:the\s+)?data\s+goes)\b|\b(?:from|since)\s+(?:the\s+)?(?:beginning|start)\s+of\s+(?:the\s+)?(?:data|records)(?:\s+(?:until|to|through)\s+(?:the\s+)?(?:present|now|today))?\b|\b(?:the\s+)?(?:full|entire|whole|complete)\s+history\b`) },
  { concept: "period", value: (m) => `range:${m[1]}:${m[2]}`, pattern: R(String.raw`\bfrom[.,:]?\s+(${YEAR})\s*(?:-|–|—|to|through|thru|until|till)\s*(${YEAR})\b`) },
  { concept: "period", value: (m) => `lastinc:${numberToken(m[1])}`, pattern: R(String.raw`\b(?:over\s+|in\s+|for\s+|during\s+)?(?:the\s+)?(?:last|past)\s+(${NUMBER})\s+years\s*,?\s*including\s+(?:this|the\s+current)\s+year\b`) },
  { concept: "period", value: (m) => `between:${m[1]}:${m[2]}`, pattern: R(String.raw`\bbetween\s+(${YEAR})\s+and\s+(${YEAR})\b`) },
  { concept: "period", value: (m) => `since:${m[1]}`, pattern: R(String.raw`\b(?:since|starting(?:\s+in)?|beginning(?:\s+in)?|from)\s+(${YEAR})(?:\s*(?:-|–|to|through|until)\s*(?:the\s+)?(?:present|now|today|current(?:\s+year)?|most\s+(?:current|recent)(?:\s+(?:year|data))?)|\s+on(?:wards?)?)?\b`) },
  { concept: "period", value: (m) => `since:${m[1]}`, pattern: R(String.raw`\b(?:(?:going\s+)?back\s+to|as\s+far\s+back\s+as)\s+(${YEAR})\b`) },
  // General fix 1 (step A Historical gaps, Codex r1 item 3: direct recognition): "2000-current", "2015 to date".
  { concept: "period", value: (m) => `since:${m[1]}`, pattern: R(String.raw`\b(${YEAR})\s*(?:-|–|to|through|until)\s*(?:the\s+)?(?:present|now|today|current(?:\s+year)?|date|most\s+(?:current|recent)(?:\s+(?:year|data))?)\b`) },
  { concept: "period", value: (m) => `range:${m[1]}:${m[2]}`, pattern: R(String.raw`\b(${YEAR})\s*(?:-|–|—|to|through|thru)\s*(${YEAR})\b`) },
  { concept: "period", value: (m) => `after:${m[1]}`, pattern: R(String.raw`\bafter\s+(${YEAR})\b`) },
  { concept: "period", value: (m) => `before:${m[1]}`, pattern: R(String.raw`\bbefore\s+(${YEAR})\b`) },
  // Historical vocabulary pass (2026-10-24, Codex): "the last three (3) years" only when the word and the digits agree.
  { concept: "period", value: (m) => `last:${m[2]}`, pattern: R(String.raw`\b(?:over\s+|in\s+|for\s+|during\s+)?(?:the\s+)?(?:last|past|previous|prior)\s+(${NUMBER})\s*\((\d+)\)\s+(?:years|yrs?)\b\.?`),
    when: (m) => numberToken(m[1]) === m[2] },
  { concept: "period", value: (m) => `last:${numberToken(m[1])}`, pattern: R(String.raw`\b(?:over\s+|in\s+|for\s+|during\s+)?(?:the\s+)?(?:last|past|previous|prior)\s+(${NUMBER})\s+(?:(?:full|complete|calendar)\s+)?(?:years|yrs?)\b\.?`) },
  { concept: "period", value: () => "last:10", pattern: R(String.raw`\b(?:over\s+|in\s+|for\s+|during\s+)?(?:the\s+)?(?:last|past)\s+decade\b`) },
  { concept: "period", value: () => "lastyear", pattern: R(String.raw`\b(?:in\s+)?last\s+year\b`) },
  { concept: "period", value: () => "latest", pattern: R(String.raw`\b(?:in\s+|for\s+)?(?:the\s+)?(?:latest|most\s+recent)\s+(?:year|data)(?:\s+available)?\b`) },
  { concept: "period", value: () => "all", pattern: R(String.raw`\b(?:or\s+)?(?:as\s+far\s+(?:back\s+)?as\s+possible|all\s+(?:available\s+)?years|all\s+time)\b`) },
  { concept: "period", value: (m) => `year:${m[1]}`, pattern: R(String.raw`\b(?:in|for|during|using|of)\s+(${YEAR})(?:\s+data)?\b`) },
  { concept: "period", value: (m) => `year:${m[1]}`, pattern: R(String.raw`\b(${YEAR})\b`) },
  // ---- thresholds on population (H4); raw tokens kept ----
  { concept: "threshold", value: (m) => thresholdValue(m[0]), pattern: R(String.raw`\(?\b(?:(?:with|having)\s+)?(?:an?\s+)?(?:(?:populations?|pop\.?)\s+(?:of\s+)?)?(?:at\s+least|over|above|more\s+than|greater\s+than|exceeding|under|below|less\s+than|fewer\s+than|at\s+most|min(?:imum)?(?:\s+of)?|max(?:imum)?(?:\s+of)?)\s+\d[\d,]*(?:\.\d+)?(?:\s*(?:k\b|thousand\b|m\b|million\b))?(?:\s*\+)?(?:\s+${POP_WORD})?(?:\s+or\s+(?:more|larger|greater))?\)?`),
    when: (m) => /(?:population|pop\b|pop\.|people|residents|persons|inhabitants|\d\s*k\b|thousand|million|\bmin\b|\bmin(?:imum)?\b)/i.test(m[0]) },
  { concept: "threshold", value: (m) => thresholdValue(m[0]), pattern: R(String.raw`\b(?:of\s+)?\d[\d,]*\s*(?:k|thousand|million)?\s*(?:${POP_WORD}\s+)?(?:or\s+(?:more|larger|greater)|\+)(?:\s+${POP_WORD})?`),
    when: (m) => /(?:population|people|residents|persons|inhabitants|\d\s*k\b|thousand|million)/i.test(m[0]) },
  // ---- statistic and scale ----
  { concept: "clearance", value: () => "clearance", pattern: R(String.raw`\bclearance\s+rates?\b|\bclearances?\b|\b(?:percent(?:age)?|share|proportion|%)\s+(?:of\s+[a-z\s]{0,30}?)?cleared\b|\bcleared\b`) },
  { concept: "statistic", value: () => "per100k", pattern: R(String.raw`\bper\s+100(?:,?000|\s*k|\s+thousand)(?:\s+${POP_WORD})?\b`) },
  { concept: "statistic", value: () => "per1000", pattern: R(String.raw`\bper\s+(?:1,?000|1\s*k|thousand|one\s+thousand)(?:\s+${POP_WORD})?\b`) },
  { concept: "statistic", value: (m) => `scale:${m[1]}`, pattern: R(String.raw`\bper\s+(\d[\d,]*(?:\s*k\b)?|ten\s+thousand|million|one\s+million|hundred)(?:\s+${POP_WORD})?\b`) },
  { concept: "statistic", value: () => "percapita", pattern: R(String.raw`\bper[-\s]capita\b`) },
  { concept: "statistic", value: () => "rate", pattern: R(String.raw`\brates?\b`) },
  { concept: "statistic", value: () => "count", pattern: R(String.raw`\bhow\s+many\b|\b(?:total\s+)?(?:annual\s+)?(?:numbers?|counts?)(?:\s+of)?\b`) },
  // Historical vocabulary pass (2026-10-24, Codex): "murder totals" is the count of that measure (attached to the measure
  // word, never a combine); "cases of" only directly before an offense, with nothing between them.
  { concept: "statistic", value: () => "count", pattern: R(String.raw`(?<=\b(?:murders?|homicides?|rapes?|robber(?:y|ies)|assaults?|burglar(?:y|ies)|thefts?|larcen(?:y|ies)|violent\s+crimes?|property\s+crimes?)['’]?\s+)totals?\b`) },
  { concept: "statistic", value: () => "count", pattern: R(String.raw`\bcases\s+of(?=\s+(?:murders?|homicides?|rapes?|robber(?:y|ies)|aggravated\s+assaults?|assaults?|burglar(?:y|ies)|larcen(?:y|ies)|thefts?|motor\s+vehicle\s+thefts?|violent\s+crimes?|property\s+crimes?)\b)`) },
  // A complete request opener naming a data set ("can I see a data set of …", L8744); never a bare "set of".
  { concept: "request", state: "context", pattern: R(String.raw`\ba\s+data\s*set\s+(?:of|for|on)\b`),
    when: (m, q) => /^\s*(?:can|could|may)\s+i\s+(?:see|get|have)\s+$/i.test(q.slice(0, m.index)) },
  // ---- ranking ----
  { concept: "rank", value: (m) => `${/bottom/i.test(m[1]) ? "bottom" : "top"}:${numberToken(m[2])}`, pattern: R(String.raw`\b(top|bottom)\s+(${NUMBER})\b`) },
  // Option 3 batch 1 (P039): "the highest 20" binds the count like "top 20".
  { concept: "rank", value: (m) => `${/lowest|fewest|least|smallest/i.test(m[1]) ? "bottom" : "top"}:${numberToken(m[2])}`, pattern: R(String.raw`\b(?:the\s+)?(highest|lowest|most|fewest|largest|smallest)\s+(${NUMBER})\b`) },
  { concept: "rank", value: (m) => `${/lowest|fewest|least|smallest/i.test(m[0]) ? "bottom" : "top"}:`, pattern: R(String.raw`\b(?<!\bat\s)(?:the\s+)?(?:highest|lowest|most|fewest|least|largest|smallest)\b`) },
  { concept: "rank", value: () => "rank:", pattern: R(String.raw`\b(?:rank(?:ed|ing|ings)?|top)\b`) },
  // ---- change and comparison ----
  { concept: "change", value: (m) => `change:${changeDirection(m[0])}`, pattern: R(String.raw`\b(?:percent(?:age)?\s+change|%\s*change|change[sd]?|changing|increase[sd]?|increasing|decrease[sd]?|decreasing|rise|rose|risen|rising|fall(?:en)?|fell|falling|drop(?:ped|s)?|declin(?:e|ed|es|ing)|grew|grow(?:n|th)?|went\s+(?:up|down)|gone\s+(?:up|down)|go\s+(?:up|down))\b`) },
  { concept: "versus", value: () => "versus", pattern: R(String.raw`\b(?:vs\.?|versus|compared\s+(?:to|with)|against)(?=\s|$)`) },
  { concept: "compare", state: "context", pattern: R(String.raw`\bcompar(?:e[ds]?|ing|ison)\b|\bside\s+by\s+side\b`) },
  // ---- lists and grain ----
  { concept: "list", value: (m) => `list:${entityKey(m[1])}`, pattern: R(String.raw`\b(?:broken\s+down\s+by|by|per|for\s+each|for\s+every|each|every|across)\s+(state|count(?:y|ies)|cit(?:y|ies)|agenc(?:y|ies)|departments?)(?:\s+agenc(?:y|ies))?(?:\s+and\s+(?:by\s+)?year)?\b`) },
  { concept: "list", value: () => "list:state", pattern: R(String.raw`\bstate[-\s]by[-\s]state\b|\b(?:per|by|each)\s+year\s+and\s+(?:by\s+)?state\b`) },
  { concept: "grain", value: () => "year", pattern: R(String.raw`\b(?:by|per|each|every|for\s+each)\s+year\b|\byearly\b|\bannual(?:ly)?\b|\byear[-\s](?:by|over)[-\s]year\b|\bover\s+time\b|\bover\s+the\s+years\b|\btrends?\b|\bhistory\b|\bhistorical(?:ly)?\b`) },
  // ---- measures and staffing (before the bare "total" combine word) ----
  { concept: "presentation", state: "context", pattern: R(String.raw`\b(?:fbi\s+)?(?:ucr\s+)?crime\s+data\b`) },
  { concept: "measure", value: () => "motor_vehicle_theft", pattern: R(String.raw`\b(?:motor[-\s]vehicle|auto(?:mobile)?|car|vehicle)\s+thefts?\b`) },
  { concept: "measure", value: () => "violent", pattern: R(String.raw`\b(?:total\s+)?violent(?:\s+(?:crimes?|offenses?))?\b`) },
  { concept: "measure", value: () => "property", pattern: R(String.raw`\b(?:total\s+)?property(?:\s+(?:crimes?|offenses?))?\b`) },
  { concept: "measure", value: () => "total", pattern: R(String.raw`\b(?:total|all|overall)\s+(?:crimes?|offenses?|index\s+crimes?)\b`) },
  { concept: "measure", value: () => "murder", pattern: R(String.raw`\bmurders?(?:\s+and\s+non[-\s]?negligent\s+manslaughters?)?\b|\bhomicides?\b|\bkillings?\b`) },
  { concept: "measure", value: () => "rape", pattern: R(String.raw`\brapes?\b`) },
  { concept: "measure", value: () => "robbery", pattern: R(String.raw`\brobber(?:y|ies)\b`) },
  { concept: "measure", value: () => "aggravated_assault", pattern: R(String.raw`\b(?:aggravated\s+)?assaults?\b`) },
  { concept: "measure", value: () => "burglary", pattern: R(String.raw`\bburglar(?:y|ies)\b|\bbreak[-\s]?ins?\b`) },
  { concept: "measure", value: () => "theft", pattern: R(String.raw`\b(?:larceny[-\s]thefts?|larcen(?:y|ies)|thefts?)\b`) },
  { concept: "measure", value: () => "unspecified", pattern: R(String.raw`\bcrimes?\b|\boffenses?\b`) },
  { concept: "staffing", value: () => "civilians", pattern: R(String.raw`\bcivilian(?:s|\s+(?:employees|staff|personnel))?\b`) },
  { concept: "staffing", value: () => "employees", pattern: R(String.raw`\b(?:total\s+)?(?:employees|personnel)\b|\bstaff\b`) },
  { concept: "staffing", value: () => "officers", pattern: R(String.raw`\b(?:total\s+)?(?:(?:sworn|police)\s+)?(?:police\s+)?officers?\b|\bcops\b|\bpolice\s+force\b|\bstaffing(?:\s+levels?)?\b`) },
  // ---- combine words; a bare "total" not naming a measure, a count or staffing ----
  { concept: "combine", value: () => "combine", pattern: R(String.raw`\b(?:combined|altogether|all\s+together|in\s+total|in\s+all|summed|sum\s+of|together)\b`) },
  { concept: "combine", value: () => "combine", pattern: R(String.raw`\btotal\b`) },
  // ---- national and entity words ----
  // Option 3 batch 1 (OVER-REFUSAL-PLAN-r3.md): "the entire / whole US" names the nation; claimed before the bare "US".
  { concept: "place", value: () => "national", pattern: R(String.raw`\b(?:the\s+)?(?:entire|whole)\s+(?:(?:U\.S\.A?\.?|USA|US)(?![A-Za-z])|united\s+states\b|country\b|nation\b)`) },
  { concept: "place", value: () => "national", pattern: R(String.raw`(?<![A-Za-z.])(?:U\.S\.A?\.?|USA|US)(?![A-Za-z])`, "g") },
  { concept: "place", value: () => "national", pattern: R(String.raw`\b(?:(?:in\s+)?the\s+)?(?:national(?:ly)?|nationwide|countrywide|united\s+states|america|(?:the\s+)?(?:nation|country))\b`) },
  { concept: "entity", value: (m) => entityKey(m[0]), pattern: R(String.raw`\b(?:county\s+(?:agenc(?:y|ies)|sheriffs?(?:['’]\s*offices)?)|sheriffs?(?:['’]\s*offices)?|police\s+departments?|cities|city|towns?|counties|agencies|agency|departments|states|state)\b`) },
  // ---- presentation and other harmless words ----
  { concept: "presentation", state: "context", pattern: R(String.raw`\b(?:(?:in|as)\s+(?:a\s+)?)?(?:fbi|ucr|crime\s+data|data|stats|statistics|info(?:rmation)?|chart|graph|table|plot|figures|numbers|breakdown|summary|list|results?|series)\b`) },
  { concept: "connector", state: "context", pattern: R(String.raw`(?:^|\s)(?:and|&|,)(?=\s|$)`) },
  // "between Baltimore and Chicago": a comparison connector before a named place (a year span is a period, claimed above).
  { concept: "connector", state: "context", pattern: R(String.raw`\bbetween\b(?=\s+(?:the\s+)?(?:city\s+of\s+)?[A-Z])`, "g") },
];

/* -------------------------------------------------------------------------------- helpers ----------------------- */

/** r2 §1: a change word's direction -- increase, decrease, or neutral ("change", "percent change"). */
export function changeDirection(text: string): "increase" | "decrease" | "neutral" {
  const t = text.toLowerCase();
  if (/increas|\brise\b|\brose\b|risen|rising|grew|grow|went\s+up|gone\s+up|go\s+up/.test(t)) return "increase";
  if (/decreas|declin|\bdrop|\bfall|\bfell\b|falling|went\s+down|gone\s+down|go\s+down/.test(t)) return "decrease";
  return "neutral";
}

export function numberToken(raw: string): string {
  const t = raw.trim().toLowerCase();
  return NUM_WORD[t] ?? t.replace(/,/g, "");
}

function entityKey(raw: string): string {
  const t = raw.toLowerCase();
  if (/county|sheriff/.test(t)) return "county";
  if (/cit(?:y|ies)|town/.test(t)) return "city";
  if (/agenc|department/.test(t)) return "agency";
  if (/state/.test(t)) return "state";
  return t;
}

/**
 * A population threshold as `op|token`: op is >=, > or max; token is the exact amount in digits (grouping commas
 * removed; a k/thousand/million suffix multiplied out only when the result is a safe integer, else the raw token with
 * its suffix so it can be declined by name).
 */
export function thresholdValue(text: string): string {
  const t = text.toLowerCase();
  const op = /\b(?:under|below|less\s+than|fewer\s+than|at\s+most|max)/.test(t) ? "max"
    : /\b(?:over|above|more\s+than|greater\s+than|exceeding)\b/.test(t) ? ">"
      : ">=";
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(k\b|thousand|m\b|million)?/.exec(t);
  if (!m) return `${op}|?`;
  const digits = m[1].replace(/,/g, "");
  const mult = m[2] ? (/^m/.test(m[2]) ? "000000" : "000") : "";
  if (!mult) return `${op}|${digits}`;
  if (!/^\d+$/.test(digits)) return `${op}|${digits}${m[2].trim()}`;
  return `${op}|${digits.replace(/^0+(?=\d)/, "")}${mult}`;
}

export function recordAll(ledger: RequestLedger, rule: Rule): void {
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(ledger.question))) {
    if (m[0].length === 0) { pattern.lastIndex += 1; continue; }
    if (rule.when && !rule.when(m, ledger.question)) { pattern.lastIndex = m.index + 1; continue; }
    const raw = m[0];
    const lead = raw.length - raw.replace(/^\s+/, "").length;
    const text = raw.trim();
    const span: Span = [m.index + lead, m.index + lead + text.length];
    const recorded = ledger.record({
      concept: rule.concept,
      value: rule.value ? rule.value(m) : null,
      span,
      rule: `${rule.concept}${rule.state ? `:${rule.state}` : ""}`,
      state: rule.state,
      explanation: rule.explanation ? rule.explanation(text) : null,
    });
    if (!recorded) pattern.lastIndex = m.index + 1;
  }
}

const AGENCY_NOUN = /^\s*(?:police\s+department|police\s+dept\.?|pd|police|sheriff(?:['’]s)?(?:\s+(?:office|department))?)\b/i;
const CITY_OF = /(?:\bthe\s+)?\bcity\s+of\s+$/i;

const DC = /\bWashington,?\s+D\.?\s?C\b|\bD\.C\b|\bDistrict\s+of\s+Columbia\b/gi;
const US_BEFORE_ENTITY = /\b(?:the\s+)?us\b(?=\s+(?:cities|states|counties|agencies|police|towns))/gi;
// Historical vocabulary pass (2026-10-24, Codex): "the us violent crime rate" -- only with the article and directly before
// a measure word, so the pronoun ("tell us the rate") never reads as the nation.
const US_BEFORE_MEASURE = /(?<=\bthe\s+)us\b(?=\s+(?:total\s+)?(?:violent|property|murders?|homicides?|crimes?|rapes?|robber(?:y|ies)|aggravated|assaults?|burglar(?:y|ies)|larcen(?:y|ies)|thefts?|motor\s+vehicle|clearance|police)\b)/gi;
// State postal codes in a list of two or more codes joined by vs/versus/and/&/commas ("CA vs. TX vs. NY state").
// Uppercase only; codes that are also everyday words or other places (IN, OR, ME, OK, HI, LA) are never read this way,
// and a code attached to a city ("Austin, TX") is not in such a list, so the resolver keeps it.
const LIST_CODE_EXCLUDED = new Set(["IN", "OR", "ME", "OK", "HI", "LA", "US", "DC"]);

function recordStateCodeLists(ledger: RequestLedger): void {
  const codes = Object.values(STATE_NAME_TO_ABBR as Record<string, string>).filter((c) => !LIST_CODE_EXCLUDED.has(c));
  const item = String.raw`(?:${codes.join("|")})\.?(?:\s+state)?`;
  const sep = String.raw`\s*(?:,|&|\band\b|\bvs\.?|\bversus\b)\s*`;
  // Not right after a comma or a capitalized word ("Austin, TX", "Austin TX"): that code belongs to a city. Missing a
  // list there leaves it unread (refused), never misread.
  const run = new RegExp(String.raw`(?<!(?:,|\b[A-Z][a-z]+)\s?)\b${item}(?:${sep}${item})+\b`, "g");
  // Codex consolidated review: respect the resolver's city/county attachment whatever the case or spacing -- a code
  // inside a city or county mention, or right after one, leaves the whole list unread.
  const q = ledger.question;
  const lead = q.length - q.replace(/^\s+/, "").length;
  const local = resolveGeoPlaces(q).mentions
    .filter((mn) => mn.candidates.some((c) => c.kind === "city" || c.kind === "county"))
    .map((mn) => [mn.start + lead, mn.end + lead] as const);
  const attached = (s: number, e: number) => local.some(([ms, me]) => (s >= ms && e <= me && !(s === ms && e === me)) || (me <= s && /^[\s,]*$/.test(q.slice(me, s))));
  let m: RegExpExecArray | null;
  while ((m = run.exec(ledger.question))) {
    const codeSpans = [...m[0].matchAll(new RegExp(String.raw`\b(${codes.join("|")})\b`, "g"))].map((c) => [m!.index + c.index!, m!.index + c.index! + c[1].length] as const);
    if (codeSpans.some(([s, e]) => attached(s, e))) continue;
    const each = new RegExp(String.raw`\b(${codes.join("|")})\b`, "g");
    let c: RegExpExecArray | null;
    while ((c = each.exec(m[0]))) {
      const name = STATE_NAMES.find((n) => (STATE_NAME_TO_ABBR as Record<string, string>)[n] === c![1]);
      if (!name) continue;
      const s = m.index + c.index;
      ledger.record({ concept: "place", value: `state:${name}`, span: [s, s + c[1].length], rule: "place:state-code-list" });
    }
  }
}

/**
 * A list introduction before named places ("in the following states: California, …"), Codex consolidated review: its
 * kind word is a restriction, so the phrase is context only when every place named after it resolved to that kind
 * (states -> state, cities -> city, counties -> county, agencies -> a city or county agency). Otherwise it stays unread.
 */
const LIST_INTRO = /\bin\s+the\s+following(?:\s+(states|cities|counties|agencies))?\s*:?/gi;
const LIST_KIND: Record<string, RegExp> = { states: /^state:/, cities: /^city:/, counties: /^county:/, agencies: /^(?:city|county):/ };

function recordListIntro(ledger: RequestLedger): void {
  const q = ledger.question;
  LIST_INTRO.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LIST_INTRO.exec(q))) {
    const end = m.index + m[0].length;
    if (!/^\s*[A-Z]/.test(q.slice(end))) continue;
    const listed = ledger.parts.filter((p) => p.concept === "place" && p.span[0] >= end);
    if (listed.length < 2) continue;
    const kind = m[1] ? LIST_KIND[m[1].toLowerCase()] : null;
    if (kind && !listed.every((p) => kind.test(String(p.value)))) continue;
    ledger.record({ concept: "request", span: [m.index, end], rule: "list-intro", state: "context" });
  }
}

/**
 * "statewide" (Codex 2026-10-24): context only when the question's whole place scope is ONE named state and nothing
 * narrower (no city, county, agency or list words), and the word sits beside that state or directly before what is
 * counted. Otherwise it stays unread.
 */
function recordStatewide(ledger: RequestLedger): void {
  const q = ledger.question;
  const places = ledger.parts.filter((p) => p.concept === "place");
  const states = new Set(places.map((p) => p.value));
  if (places.length === 0 || states.size !== 1 || !String([...states][0]).startsWith("state:")) return;
  if (ledger.parts.some((p) => p.concept === "entity" || p.concept === "list" || p.rule === "list-intro")) return;
  const re = /\bstate[-\s]?wide\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const start = m.index;
    const end = start + m[0].length;
    // Codex consolidated review: test the gap only for correctly ordered spans (a reversed slice is "" and would pass).
    const gap = (a: number, b: number, re: RegExp) => a <= b && re.test(q.slice(a, b));
    const beside = places.some((p) => gap(p.span[1], start, /^[\s,]*$/) || gap(end, p.span[0], /^[\s,]*$/));
    const beforeMeasure = ledger.parts.some((p) => (p.concept === "measure" || p.concept === "staffing" || p.concept === "clearance") && gap(end, p.span[0], /^\s*$/));
    if (beside || beforeMeasure) ledger.record({ concept: "scope", span: [m.index, end], rule: "statewide", state: "context" });
  }
}

export function recordPlaces(ledger: RequestLedger): void {
  const q0 = ledger.question;
  // Washington, D.C. is the city agency (as the accepted change paths read it); "District of Columbia" alone is the state row.
  let m: RegExpExecArray | null;
  DC.lastIndex = 0;
  while ((m = DC.exec(q0))) {
    const text = m[0];
    ledger.record({ concept: "place", value: /^district/i.test(text) ? "state:District of Columbia" : "city:Washington:DC", span: [m.index, m.index + text.length], rule: "place:dc" });
  }
  US_BEFORE_ENTITY.lastIndex = 0;
  while ((m = US_BEFORE_ENTITY.exec(q0))) ledger.record({ concept: "place", value: "national", span: [m.index, m.index + m[0].length], rule: "place:us-lowercase" });
  US_BEFORE_MEASURE.lastIndex = 0;
  while ((m = US_BEFORE_MEASURE.exec(q0))) ledger.record({ concept: "place", value: "national", span: [m.index, m.index + m[0].length], rule: "place:us-before-measure" });
  recordStateCodeLists(ledger);
  // Possessives ("seattle's", "Philadelphia'homicide") are blanked to spaces of the same length so the resolver sees the
  // name and every span still points into the original question.
  const q = q0.replace(/['’]s\b/g, "  ").replace(/(?<=[A-Za-z])['’](?=[A-Za-z])/g, " ");
  const lead = q.length - q.replace(/^\s+/, "").length;
  for (const mention of resolveGeoPlaces(q).mentions) {
    const top = mention.candidates[0];
    let start = mention.start + lead;
    let end = mention.end + lead;
    const before = CITY_OF.exec(q.slice(0, start));
    if (before) start = before.index;
    const after = AGENCY_NOUN.exec(q.slice(end));
    if (after) end += after[0].length;
    // Complete-turn fix (2026-10-23): a city-or-county name followed by the agency's own noun names that agency: "San
    // Diego Police Department" is the city's, "Sacramento Sheriff" the county's. Only when exactly one candidate has that
    // kind; anything else stays ambiguous and is clarified.
    const agencyKind = after ? (/sheriff/i.test(after[0]) ? "county" : "city") : null;
    const byAgency = mention.requiresClarification && agencyKind ? mention.candidates.filter((c) => c.kind === agencyKind) : [];
    const chosen = byAgency.length === 1 ? byAgency[0] : null;
    const resolved = chosen ?? (mention.requiresClarification ? null : top);
    const kind = resolved?.kind ?? "unknown";
    const value = !resolved
      ? `ambiguous:${mention.text}`
      : kind === "state" ? `state:${resolved.name}`
        : `${kind}:${resolved.name}:${resolved.state ?? ""}`;
    ledger.record({ concept: "place", value, span: [start, end], explains: [[start, end]], rule: !resolved ? "place:ambiguous" : chosen ? `place:${kind}:agency-noun` : `place:${kind}` });
  }
  // Bare state codes in a place position ("in TX").
  const CODES = Object.values(STATE_NAME_TO_ABBR as Record<string, string>).filter((c) => c !== "US");
  const codeRe = new RegExp(String.raw`\b(?:in|for|of)\s+(${CODES.join("|")})\b`, "g");
  while ((m = codeRe.exec(q))) {
    const code = m[1];
    const name = STATE_NAMES.find((n) => (STATE_NAME_TO_ABBR as Record<string, string>)[n] === code);
    if (!name) continue;
    const s = m.index + m[0].length - code.length;
    ledger.record({ concept: "place", value: `state:${name}`, span: [s, s + code.length], rule: "place:state-code" });
  }
}

/** Which-words: "which"/"what" opening a ranking or list ("which cities had the most"). Context only beside an entity. */
function recordWhich(ledger: RequestLedger): void {
  const re = /\b(?:which|what)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ledger.question))) {
    const rest = ledger.question.slice(m.index + m[0].length);
    if (/^\s+(?:\d+\s+)?(?:cities|city|states?|counties|county|agencies|agency|departments?|towns?)\b/i.test(rest)) {
      ledger.record({ concept: "which", span: [m.index, m.index + m[0].length], rule: "which", state: "context" });
    }
  }
}

/** Historical filler beyond the shared between-filler words: verbs and articles that never restrict. */
const HISTORICAL_FILLER = /^(?:had|have|has|were|was|is|are|there|been|the|a|an|in|of|for|with|by|from|at|on|to|me|do|does|did|i|you|see|can|could|show|give|find|get|list|what|which|many|much|data|people|residents|reported|recorded|it|its|their|did|lot|all|any|each|per|year|years|over|about|use|using|please|just|also|now|then|those|these|this|that|same|other|than|level|levels|total|numbers?|crime|police)$/i;

function recordHistoricalFiller(ledger: RequestLedger): void {
  // Only words that sit between two recorded parts (never at an edge next to residue), as the shared rule does.
  recordBetweenFiller(ledger);
  const q = ledger.question;
  const residue = ledger.residue();
  const recorded = [...ledger.parts].sort((a, b) => a.span[0] - b.span[0]);
  for (const piece of residue) {
    if (!HISTORICAL_FILLER.test(piece.text)) continue;
    const before = /^\s*$/.test(q.slice(0, piece.span[0])) || recorded.some((p) => p.span[1] <= piece.span[0] && /^[\s,]*$/.test(q.slice(p.span[1], piece.span[0])));
    const after = recorded.some((p) => p.span[0] >= piece.span[1] && /^[\s,]*$/.test(q.slice(piece.span[1], p.span[0]))) || /^[\s?.!]*$/.test(q.slice(piece.span[1]));
    if (before && after) ledger.record({ concept: "filler", span: piece.span, rule: "historical-filler", state: "context" });
  }
}

/* ------------------------------------------------------------------------------ entry point --------------------- */

/**
 * The Historical ledger for one request (the EFFECTIVE question: the reconstruction for a follow-up). Finalized:
 * every character is a part. Clause 1 holds an explanation request when the same turn also asks for a number
 * ("how many murders ... and why?"), so the number can be answered and the explanation named.
 */
export function accountHistoricalRequest(question: string): RequestLedger {
  const ledger = new RequestLedger(question);
  recordBrokenDown(ledger); // Stage 3b r2 (R2.7)
  recordContext(ledger);
  // Typed agency codes first, then places (a place name is the most specific claim: "White Plains" is a place before
  // "white" is a demographic word), then every other rule in its written order.
  // Year-like period words that resemble places ("early 2020's" is not Early, TX) and sub-year words go before places.
  const early = RULES.filter((r) => r.concept === "ori" || r.concept === "period-unsupported" || r.concept === "sub-year" || r.concept === "overdose-deaths" || r.concept === "immigration-status" || r.concept === "meta-source");
  for (const rule of early) recordAll(ledger, rule);
  recordPlaces(ledger);
  recordListIntro(ledger);
  recordAll(ledger, { concept: "possessive", state: "context", pattern: /['’]s\b/g, when: (pm, q) => ledger.parts.some((p) => p.concept === "place" && p.span[1] === pm.index) || /[A-Za-z]$/.test(q.slice(0, pm.index)) && ledger.parts.some((p) => p.concept === "place" && p.span[1] >= pm.index - 1 && p.span[1] <= pm.index) });
  for (const rule of RULES.filter((r) => !early.includes(r))) recordAll(ledger, rule);
  recordWhich(ledger);
  recordStatewide(ledger);
  // Repeat filler passes: a filler run can sit between parts only once its neighbours are recorded.
  recordHistoricalFiller(ledger);
  recordHistoricalFiller(ledger);
  const explainParts = ledger.parts.filter((p) => p.concept === "explain");
  const numericAsk = hasExplicitNumericAsk(ledger.parts);
  const explainClause = explainParts.length > 0 && numericAsk ? 1 : 0;
  for (const p of explainParts) p.clause = explainClause;
  // Adjacent unknown words are ONE phrase the reader typed ("via banana in"), named once rather than word by word.
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
  // Only the explanation request itself is clause 1; residue stays clause 0, so it still blocks the number.
  ledger.finalize(() => 0);
  return ledger;
}

/** Recognition-time refusals: not-recorded topics and not-interpreted words, in written order. */
export function historicalRecognitionRefusal(ledger: RequestLedger): { parts: Part[]; explanation: string } | null {
  const parts = ledger.refusedAtRecognition();
  if (parts.length === 0) return null;
  return { parts, explanation: refusalSentences(parts).join(" ") };
}

/**
 * The Historical response-cache namespace (plan r1.1 §3.7). Changed with this stage so no entry cached before it -- a
 * model-written statement -- can be served; the witness reads it from here to seed the old and new keys.
 */
export const HISTORICAL_CACHE_TAB = "historical:request-accounting-2a";

/** The reply when the model wrote a statement on the Historical tab: it never runs (K7). */
export const HISTORICAL_MODEL_SQL_DECLINE =
  `${HISTORICAL_CAN_ANSWER} I couldn't match this question to one of the question types I answer, so I haven't run a query for it.`;


/**
 * K2 (plan r1.1 clarification): a follow-up is answered only when its reconstruction carries every restriction of a
 * COMPLETE earlier question, or replaces it with a value this turn states. The reconstructor is not trusted: the check
 * compares three ledgers (earlier question, this turn alone, reconstruction) value by value.
 *   - no reconstruction, or an earlier turn that was itself a follow-up: decline (ask a complete question);
 *   - a restriction of the earlier question that this turn does not replace and the reconstruction does not carry:
 *     decline naming it.
 */
export function historicalFollowupCheck(opts: {
  question: string;
  reconstructed: string | null;
  previousUserTurns: string[];
  isFollowUp: (q: string) => boolean;
}): { explanation: string } | null {
  const COMPLETE = "Please ask it as a complete question (the place, what to count and the years).";
  const previous = opts.previousUserTurns[opts.previousUserTurns.length - 1];
  if (!previous) return null;
  if (opts.isFollowUp(previous)) return { explanation: `This builds on an earlier follow-up, so I can't be sure which conditions from before still apply. ${COMPLETE}` };
  if (!opts.reconstructed) return { explanation: `I couldn't rebuild this follow-up together with your earlier question here. ${COMPLETE}` };
  const prev = accountHistoricalRequest(previous);
  const turn = accountHistoricalRequest(opts.question);
  const rec = accountHistoricalRequest(opts.reconstructed);
  const key = (p: Part) => p.value ?? p.text.toLowerCase().replace(/\s+/g, " ").trim();
  const values = (l: RequestLedger, concept: string) => new Set(l.parts.filter((p) => p.concept === concept && p.state !== "context").map(key));
  // Plan r2 §2 + Q1: every concept of the earlier question OR of this turn, with no whitelist -- a restriction this turn
  // ADDS (a rate, a threshold, a weapon) must reach the reconstruction too, or the request is declined naming it.
  const concepts = new Set([...prev.parts, ...turn.parts].filter((p) => p.state !== "context").map((p) => p.concept));
  for (const concept of concepts) {
    const fromPrev = values(prev, concept);
    const fromTurn = values(turn, concept);
    const inRec = values(rec, concept);
    const required = fromTurn.size ? fromTurn : fromPrev;
    const missing = [...required].filter((v) => !inRec.has(v));
    if (missing.length) {
      const source = fromTurn.size ? turn : prev;
      const texts = source.parts.filter((p) => p.concept === concept && missing.includes(key(p))).map((p) => `"${p.text.trim()}"`);
      return { explanation: `I couldn't carry ${texts.join(" and ")} from your ${fromTurn.size ? "follow-up" : "earlier question"} into this answer, so I haven't answered with a number that leaves it out. ${COMPLETE}` };
    }
  }
  return null;
}

/**
 * Plan r2 §5 + Q2: an EXPLICIT numeric ask -- "how many" / a count, a stated statistic (rate, per capita, per 100,000,
 * per 1,000), an explicit year or year range, a rank word (with or without a count), or a population threshold. The same
 * definition decides text vs numeric and the clause of an explanation request.
 */
export function hasExplicitNumericAsk(parts: Part[]): boolean {
  return parts.some((p) => p.state !== "context" && (
    p.concept === "statistic" || p.concept === "rank" || p.concept === "threshold"
    || (p.concept === "period" && /^(?:year|range|between|since|after|before):/.test(p.value ?? ""))));
}

const NUMERIC_CONCEPTS = new Set(["measure", "statistic", "rank", "threshold", "staffing", "clearance", "change", "combine", "list", "grain", "period", "versus"]);
// Option 3 batch 1: the not-recorded topics added on 10-21 make a request numeric, like the others.
const REFUSED_CONCEPTS = new Set(["ori", "court", "arrests", "weapon", "topic", "sub-city", "sub-year", "people", "safest", "size", "period-unsupported", "overdose-deaths", "immigration-status", "policy", "documents"]);

/**
 * How the request is handled before any planner:
 *   - `text`: an explanation request with no explicit numeric ask ("why the increase?"), or a turn with no numeric
 *     wording at all. It may reach the model for a TEXT reply; the model's SQL never runs (K7).
 *   - `numeric`: everything else. Recognition refusals apply, and only a fixed path or a supported type may answer.
 */
export function historicalRequestKind(ledger: RequestLedger): "text" | "numeric" {
  // Option 3 batch 1 (P175): a request naming something Historical does not record is refused by name (with the causal
  // limitation when it also asks why), never handed to the text path.
  if (ledger.parts.some((p) => p.state === "not-recorded")) return "numeric";
  const explain = ledger.parts.some((p) => p.concept === "explain");
  // r2 §5: text ONLY when there is an explanation request and no explicit numeric ask, wherever the "why" sits.
  if (explain && !hasExplicitNumericAsk(ledger.parts)) return "text";
  const anyNumeric = ledger.parts.some((p) => NUMERIC_CONCEPTS.has(p.concept) || REFUSED_CONCEPTS.has(p.concept));
  const operation = ledger.parts.some((p) => ["scorecard", "peer", "coverage-lookup", "completeness", "prison-population", "meta-source"].includes(p.concept));
  if (!anyNumeric && !operation && !explain) {
    // No numeric wording: a bare place ("Fort Worth, Texas") is a coverage lookup's request, anything else is text.
    return ledger.parts.some((p) => p.concept === "place") ? "numeric" : "text";
  }
  return "numeric";
}
