/**
 * Request accounting for the NIBRS tab (stage 2b; plan docs/superpowers/plans/2026-10-09-request-accounting-stage2b-
 * nibrs.md, r1.1).
 *
 * Every non-space character of a NIBRS request belongs to a recorded PART (lib/request-accounting.ts). This module is
 * the NIBRS vocabulary: offenses and families, counting units, the dimensions NIBRS records (as a breakdown "by X" or a
 * filter value), clearance reasons, periods down to the month, rolling windows, shares, rankings and places. Each part
 * carries a canonical VALUE so a supported question type or a fixed path's binding can prove it used that exact value.
 * Words this vocabulary does not know become residue (`not-interpreted`); what NIBRS does not hold is `not-recorded`,
 * each with its own wording. Nothing here answers; it only accounts.
 *
 * Places, years, ranges, thresholds, ranks and change words reuse the accepted Historical rules (stage 2a) verbatim, so
 * the two tabs read them identically. ORDER MATTERS: the ledger refuses overlapping claims, so specific rules come first.
 */
import { RequestLedger, recordContext, recordBetweenFiller, refusalSentences, couldNotInterpret, type Part, type Span } from "./request-accounting";
import { STATE_NAME_TO_ABBR } from "./state-population";
import { recordAll, recordPlaces, numberToken, thresholdValue, changeDirection, type Rule } from "./historical-request-accounting";
import { detectCompletenessQuestion } from "./completeness-intent";

const R = (s: string, flags = "gi") => new RegExp(s, flags);
const YEAR = String.raw`(?:19|20)\d{2}`;
// A rolling window's length, in months or years ("6-month", "12m", "two-year"); its words: a total or an average.
const WINDOW_N = String.raw`(?:\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty[-\s]four|thirty[-\s]six)`;
const WINDOW_UNIT = String.raw`(?:months?|mos?|m|years?|yrs?)`;
const WINDOW_KIND = String.raw`(?:\s+(?:totals?|sums?|counts?|basis|averages?|avg|means?))?`;
export const ROLLING_WINDOW = String.raw`\bon\s+a\s+rolling\s+${WINDOW_N}[-\s]?${WINDOW_UNIT}\s+(?:average\s+)?basis\b`
  + String.raw`|\b(?:rolling|trailing|moving)\s+(?:over\s+)?(?:the\s+(?:last|past)\s+)?${WINDOW_N}[-\s]?${WINDOW_UNIT}\b${WINDOW_KIND}`
  + String.raw`|\b${WINDOW_N}[-\s]?${WINDOW_UNIT}\s+(?:rolling|moving|trailing)\b${WINDOW_KIND}`
  + String.raw`|\b(?:rolling|moving)\s+(?:averages?|avg|means?)\s+(?:over|of|for)\s+(?:the\s+(?:last|past)\s+)?${WINDOW_N}[-\s]?${WINDOW_UNIT}\b`;
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, "twenty-four": 24, "twenty four": 24, "thirty-six": 36, "thirty six": 36 };
/** "rolling12" (the 12-month total), "rolling:N" (another length in months), "rolling-avg:N"; "?" for no length named. */
export function rollingValue(text: string): string {
  const t = text.toLowerCase();
  const average = /\b(?:averages?|avg|means?)\b|\bmoving\b/.test(t);
  const m = new RegExp(String.raw`(${WINDOW_N})[-\s]?(${WINDOW_UNIT})\b`).exec(t);
  const n = m ? (NUMBER_WORDS[m[1].replace(/\s+/, m[1].includes("-") ? "-" : " ")] ?? Number(m[1])) * (/^y/.test(m[2]) ? 12 : 1) : null;
  // A length the engine can't compute (0 months, more than 10 years) is asked about like no length (Codex P94 review 01.3:
  // "rolling 0 months" had fallen back to 12).
  const ok = n !== null && n >= 1 && n <= 120 ? n : null;
  if (average) return `rolling-avg:${ok ?? "?"}`;
  return ok === 12 ? "rolling12" : `rolling:${ok ?? "?"}`;
}
const NUM_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|fifty";
const NUMBER = String.raw`(?:\d[\d,]*|${NUM_WORDS})`;
const POP_WORD = String.raw`(?:people|residents|population|persons|inhabitants|pop\.?)`;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH = String.raw`(?:${MONTHS.join("|")})`;
const monthNo = (name: string) => String(MONTHS.indexOf(name.toLowerCase()) + 1).padStart(2, "0");

/* ------------------------------------------------------------------ wording ------------------------------------- */

export const NIBRS_CAN_ANSWER =
  "NIBRS answers counts, rates, shares, breakdowns, clearances, rankings and changes of reported offenses, victims, offenders and arrests for an agency, a state or the nation.";

const notRecorded = (what: string, pointer = "") => (text: string) =>
  `NIBRS doesn't record ${what}, so I can't apply "${text.trim()}"${pointer ? `; ${pointer}` : ""}. I haven't answered with a number that leaves it out.`;
const declined = (reason: string) => (text: string) => `I can't apply "${text.trim()}": ${reason} I haven't answered with a number that leaves it out.`;

const COURT = notRecorded("court outcomes (prosecutions, convictions, sentences or defendants); it records crimes reported to police, arrests and clearances");
const SUBCITY = notRecorded("anything below the level of an agency (ZIP codes, neighborhoods, districts, wards or beats)");
const DAILY = notRecorded("daily figures in its summary tables; monthly and yearly figures are available");
// Option 3 batch 1 (P159): the established NIBRS shooting limitation and its proxy offer (lib/guardrails.ts nibrs-shooting-override);
// the proxy is offered, never substituted.
const SHOOTING = (text: string) =>
  `NIBRS does not track shootings as a category, so I can't apply "${text.trim()}". For fatal shootings, the Homicide Reports tab has firearm homicides. The closest NIBRS figure is aggravated assault with a firearm, which also includes brandishing, pistol-whipping and threats, not only people who were shot; ask for "firearm aggravated assault victims" if that is what you want. I haven't answered with a number that leaves it out.`;
// Option 3 batch 1: the established demographic-rate limitation (P078) and unrecorded statements (P341).
const DEMOGRAPHIC_RATE = (text: string) =>
  `I can't apply "${text.trim()}": a per-capita rate for a demographic group needs population denominators by race, sex or age that the FBI data does not include. I can show raw counts, or the group's share of reported victims, offenders or arrestees. I haven't answered with a number that leaves it out.`;
const DRUG_ACTIVITY = notRecorded("drug distribution or sales as its own measure (drug possession and drug offenses are counted)");
const STATEMENTS = notRecorded("what people said in interviews, or how they got a weapon");
const OVERDOSE = notRecorded("overdose deaths; drug offenses are not an overdose-death count");
const IMMIGRATION = notRecorded("immigration or citizenship status");
// Officers as victims (coordinator 2026-11-05: "murders of sheriffs in King County, Washington" had answered the county's
// total murders): no source here counts them, so they are declined by name, never answered with the total.
const OFFICER_VICTIMS = declined("law enforcement officers as victims aren't counted separately in the data here.");
/** Officers as people, never an agency ("police department", "Sheriff's Office"). */
const OFFICERS = String.raw`(?:police(?!\s+(?:departments?|dept\b|agenc|districts?|reports?|stations?))(?:\s+officers?)?|law\s+enforcement(?:\s+officers?)?|peace\s+officers?|officers?|cops?|sheriffs?(?!['’]|\s+(?:offices?|departments?|dept\b))|deput(?:y|ies)|troopers?)`;
/** No one the officers acted on after the verb: "officers shot 10 people", "officers killed a suspect" are not victims. */
const OFFICER_OBJECT = String.raw`(?!\s+(?:\d|a\b|an\b|the\b|at\b|people|persons?|men\b|women|someone|anyone|him\b|her\b|them\b|suspects?|civilians?|residents?|children|kids|teens?|black|white|unarmed|\w+\s+people))`;
/** Up to two place words before the officers ("Chicago police", "King County sheriffs"), never "women by". */
const OFFICER_PLACE = String.raw`(?:(?:(?!(?:by|with|and|or|in|from|for|at|the)\b)[A-Za-z.'’-]+\s+){1,2}(?:county\s+)?)?`;
const FENTANYL = notRecorded("fentanyl as its own drug type (it falls under broader narcotic categories)");

/* ------------------------------------------------------------------ rules --------------------------------------- */

/** Month periods: recorded before places so "May 2025" is a period, never a place. */
const MONTH_PERIODS: Rule[] = [
  { concept: "period", value: (m) => `monthrange:${m[2]}-${monthNo(m[1])}:${m[4]}-${monthNo(m[3])}`, pattern: R(String.raw`\bfrom\s+(${MONTH})\s+(${YEAR})\s+(?:to|through|until|-)\s+(${MONTH})\s+(${YEAR})\b`) },
  { concept: "period", value: (m) => `month:${m[2]}-${monthNo(m[1])}`, pattern: R(String.raw`\b(?:(?:in|for|during|of)\s+)?(${MONTH})\s+(${YEAR})\b`) },
];
const EARLY_CONCEPTS = new Set(["officer-victims", "outside-us", "ori", "phase-unsupported", "rolling", "daily", "two-way-rank", "clearance-reason", "court", "sub-city", "peer", "cohort", "overdose-deaths", "immigration-status", "shooting", "demographic-rate", "statements", "meta-codes", "drug-activity"]); // meta-codes: before "list" and the measures

/** Filter values: `dimension:value`. Specific weapons before the generic gun words; values are NIBRS codes. */
const FILTERS: Rule[] = [
  // clearance reasons (exceptional means A-E) and methods
  { concept: "filter", value: () => "clearance:A", pattern: R(String.raw`\bdeath\s+of\s+(?:the\s+)?offenders?\b`) },
  { concept: "filter", value: () => "clearance:C", pattern: R(String.raw`\bin\s+custody\s+(?:of\s+another\s+jurisdiction|elsewhere)\b`) },
  { concept: "filter", value: () => "clearance:D", pattern: R(String.raw`\bvictims?\s+refused(?:\s+to\s+cooperate)?\b`) },
  { concept: "filter", value: () => "clearance:E", pattern: R(String.raw`\bjuvenile,?\s+no\s+custody\b`) },
  { concept: "filter", value: () => "clearance:exceptional", pattern: R(String.raw`\b(?:cleared\s+)?(?:by\s+exception(?:al\s+means)?|exceptionally(?:\s+cleared)?)\b`) },
  // weapons
  { concept: "filter", value: () => "weapon:12", pattern: R(String.raw`\b(?:killed\s+)?(?:with\s+(?:a\s+)?)?handguns?\b`) },
  { concept: "filter", value: () => "weapon:13", pattern: R(String.raw`\b(?:with\s+(?:a\s+)?)?rifles?\b`) },
  { concept: "filter", value: () => "weapon:14", pattern: R(String.raw`\b(?:with\s+(?:a\s+)?)?shotguns?\b`) },
  { concept: "filter", value: () => "weapon:20", pattern: R(String.raw`\b(?:with\s+(?:a\s+)?)?(?:knives|knife)\b`) },
  { concept: "filter", value: () => "weapon:firearm", pattern: R(String.raw`\b(?:(?:that|which)\s+)?(?:involv(?:e|es|ing)\s+(?:the\s+)?use\s+of\s+a\s+)?(?:guns?|firearms?)\b`) },
  // drugs
  { concept: "filter", value: () => "drug:E", pattern: R(String.raw`\bmarijuana\b|\bcannabis\b`) },
  { concept: "filter", value: () => "drug:L", pattern: R(String.raw`\bmeth(?:amphetamines?)?\b|\bamphetamines?\b`) },
  { concept: "filter", value: () => "drug:A", pattern: R(String.raw`\bcrack(?:\s+cocaine)?\b`) },
  { concept: "filter", value: () => "drug:B", pattern: R(String.raw`\bcocaine\b`) },
  { concept: "filter", value: () => "drug:D", pattern: R(String.raw`\bheroin\b`) },
  { concept: "fentanyl", pattern: R(String.raw`\bfentanyl\b`), state: "not-recorded", explanation: FENTANYL },
  // domestic violence categories
  { concept: "filter", value: () => "dv:intimate_partner", pattern: R(String.raw`\bintimate[-\s]partners?(?:\s+violence)?\b|\bipv\b`) },
  { concept: "filter", value: () => "dv:family", pattern: R(String.raw`\bfamily\s+violence\b`) },
  // bias motivations
  { concept: "filter", value: () => "bias:21", pattern: R(String.raw`\banti[-\s]?(?:jewish|semitic)\b|\bantisemitic\b`) },
  { concept: "filter", value: () => "bias:12", pattern: R(String.raw`\banti[-\s]?black\b`) },
  { concept: "filter", value: () => "bias:11", pattern: R(String.raw`\banti[-\s]?white\b`) },
  { concept: "filter", value: () => "bias:32", pattern: R(String.raw`\banti[-\s]?(?:hispanic|latino)\b`) },
  { concept: "filter", value: () => "bias:14", pattern: R(String.raw`\banti[-\s]?asian\b`) },
  { concept: "filter", value: () => "bias:24", pattern: R(String.raw`\banti[-\s]?(?:islamic|muslim)\b`) },
  { concept: "filter", value: () => "bias:41", pattern: R(String.raw`\banti[-\s]?gay\b`) },
  // property loss
  { concept: "filter", value: () => "loss:7", pattern: R(String.raw`\bstolen\b`) },
  { concept: "filter", value: () => "loss:5", pattern: R(String.raw`\brecovered\b`) },
  { concept: "filter", value: () => "loss:4", pattern: R(String.raw`\b(?:damaged|destroyed|vandali[sz]ed)\b`) },
  { concept: "filter", value: () => "loss:6", pattern: R(String.raw`\bseized\b`) },
  // people
  { concept: "filter", value: () => "sex:F", pattern: R(String.raw`\b(?:females?|wom[ae]n|girls?)\b`) },
  { concept: "filter", value: () => "sex:M", pattern: R(String.raw`\b(?:males?|m[ae]n|boys?)\b`) },
  { concept: "filter", value: () => "age:Under 18", pattern: R(String.raw`\b(?:(?:who\s+were\s+|aged\s+)?(?:under|younger\s+than|below)\s+(?:the\s+age\s+of\s+|age\s+)?18|juveniles?|youths?|minors?)\b`) },
  { concept: "filter", value: () => "race:B", pattern: R(String.raw`\bblack\b`) },
  { concept: "filter", value: () => "race:W", pattern: R(String.raw`\bwhite\b`) },
  { concept: "filter", value: () => "race:A", pattern: R(String.raw`\basian\b`) },
  { concept: "filter", value: () => "ethnicity:H", pattern: R(String.raw`\bhispanic\b|\blatin[oa]s?\b`) },
  // locations and relationships (values)
  { concept: "filter", value: () => "location:20", pattern: R(String.raw`\bat\s+(?:residences?|homes?)\b`) },
  { concept: "filter", value: () => "location:13", pattern: R(String.raw`\bon\s+(?:the\s+)?streets?\b`) },
  { concept: "filter", value: () => "location:22", pattern: R(String.raw`\bat\s+schools?\b`) },
  { concept: "filter", value: () => "location:18", pattern: R(String.raw`\bin\s+parking\s+lots?\b`) },
  // Option 3 batch 1 (OVER-REFUSAL-PLAN-r3.md): location codes 07 (convenience store) and 14 (hotel/motel), lib/nibrs-codes.ts.
  { concept: "filter", value: () => "location:07", pattern: R(String.raw`\b(?:at|in)\s+(?:a\s+|the\s+)?convenience\s+stores?\b`) },
  { concept: "filter", value: () => "location:14", pattern: R(String.raw`\b(?:at|in)\s+(?:a\s+|the\s+)?(?:hotels?|motels?)(?:\s*(?:\/|or|and)\s*motels?)?\b`) },
  // Stage 3b owner decision (plan r1.3): "commercial" = the business location types (lib/nibrs-codes.ts).
  { concept: "filter", value: () => "location:commercial", pattern: R(String.raw`\bcommercial\b`) },
  { concept: "filter", value: () => "relationship:ST", pattern: R(String.raw`\bby\s+strangers\b|\bstrangers\b`) },
];

/** Breakdown dimensions ("by X"). Two-dimension forms the source holds as one declared dimension come first. */
const BREAKDOWNS: Rule[] = [
  { concept: "breakdown", value: () => "victim-offender-race", pattern: R(String.raw`\bby\s+(?:the\s+)?race\s+of\s+(?:the\s+)?victims?\s+and\s+(?:the\s+)?race\s+of\s+(?:the\s+)?offenders?\b|\bby\s+victim[-\s]offender\s+race\b`) },
  { concept: "breakdown", value: () => "clearance-method", pattern: R(String.raw`\bby\s+arrest\s+and\s+exceptional\s+means\b|\b(?:by\s+)?arrest\s+vs\.?\s+exceptional\b|\b(?:by\s+)?arrest\s+(?:vs\.?|versus|or)\s+(?:by\s+)?exception(?:al(?:ly)?)?(?:\s+means)?\b`) },
  { concept: "breakdown", value: () => "clearance-type", pattern: R(String.raw`\bby\s+(?:the\s+)?type\s+of\s+exceptional\b|\bby\s+(?:clearance\s+)?(?:type|status|category)\b|\band\s+clearance\s+status\b`) },
  // r2: whose age is kept ("by offender age" on a victims request is not a victim-age breakdown, Codex review-13).
  { concept: "breakdown", value: (m) => (m[1] ? `${m[1].toLowerCase()}-age` : "age"), pattern: R(String.raw`\bby\s+(?:(offender|victim)\s+)?age(?:\s+groups?)?\b`) },
  // "<dimension> breakdown" ("offender age breakdown for robberies"): the unit word before it stays its own part.
  { concept: "breakdown", value: (m) => ({ gender: "sex", "age group": "age" } as Record<string, string>)[m[1].toLowerCase()] ?? m[1].toLowerCase(), pattern: R(String.raw`\b(age group|age|sex|gender|race|ethnicity)\s+breakdown\b`) },
  // Option 3 batch 1 (P139): "into different categories" asks for the offenses within the family.
  { concept: "breakdown", value: () => "offense", pattern: R(String.raw`\b(?:in\s*to|into)\s+(?:(?:its|the|different|separate)\s+)?(?:categories|types|offenses|offense\s+types|crimes)\b|\bby\s+(?:offense|crime)(?:\s+type)?\b`) },
  { concept: "breakdown", value: () => "sex", pattern: R(String.raw`\bby\s+(?:sex|gender)\b`) },
  { concept: "breakdown", value: () => "race", pattern: R(String.raw`\bby\s+race\b`) },
  { concept: "breakdown", value: () => "ethnicity", pattern: R(String.raw`\bby\s+ethnicity\b`) },
  { concept: "breakdown", value: () => "weapon", pattern: R(String.raw`\bby\s+weapon(?:\s+types?)?\b`) },
  { concept: "breakdown", value: () => "location", pattern: R(String.raw`\bby\s+location(?:\s+types?)?\b`) },
  { concept: "breakdown", value: () => "hour", pattern: R(String.raw`\bby\s+(?:hour(?:\s+of\s+(?:the\s+)?day)?|time\s+of\s+day)\b`) },
  { concept: "breakdown", value: () => "relationship", pattern: R(String.raw`\bby\s+relationship(?:\s+to\s+(?:the\s+)?offenders?)?\b`) },
  { concept: "breakdown", value: () => "circumstance", pattern: R(String.raw`\bby\s+circumstances?\b`) },
  { concept: "breakdown", value: () => "drug", pattern: R(String.raw`\bby\s+drug\s+(?:type|category)\b`) },
  { concept: "breakdown", value: () => "bias", pattern: R(String.raw`\bby\s+bias(?:\s+motivation)?\b`) },
  // "and sex" right after another breakdown is a second breakdown (declined by the types: one breakdown only).
  { concept: "breakdown", value: () => "sex", pattern: R(String.raw`\band\s+(?:sex|gender)\b`), when: (m, q) => /\bby\s+\w+(?:\s+\w+)?\s*$/i.test(q.slice(0, m.index)) },
];

/** Measures: offense codes or families. Specific before general. */
const MEASURES: Rule[] = [
  { concept: "measure", value: () => "motor_vehicle_theft", pattern: R(String.raw`\b(?:motor[-\s]vehicle|auto(?:mobile)?|car|vehicle)\s+thefts?\b`) },
  { concept: "measure", value: () => "theft_from_motor_vehicle", pattern: R(String.raw`\b(?:(?:motor\s+)?vehicle|car|auto)\s+burglar(?:y|ies)\b|\btheft\s+from\s+(?:a\s+)?(?:motor\s+)?vehicles?\b|\bcar\s+break[-\s]?ins?\b`) },
  { concept: "measure", value: () => "motor_vehicle_property", pattern: R(String.raw`\bmotor\s+vehicles?(?:\s+property)?\b|\bcars\b`), when: (_m, q) => /\bvalue\b|\bworth\b|\bdollars?\b/i.test(q) },
  { concept: "measure", value: () => "property_value", pattern: R(String.raw`\bproperty\b`), when: (_m, q) => /\bvalue\b|\bworth\b|\bdollars?\b/i.test(q) },
  { concept: "measure", value: () => "carjacking", pattern: R(String.raw`\bcarjack(?:ing|ings|ed)?\b`) },
  { concept: "measure", value: () => "domestic_violence", pattern: R(String.raw`\bdomestic\s+violence\b|\b(?<![a-z])dv(?![a-z])\b|\bdomestic\b`) },
  { concept: "measure", value: () => "hate_crime", pattern: R(String.raw`\bhate\s+crimes?\b|\bbias[-\s]motivated(?:\s+crimes?)?\b`) },
  { concept: "measure", value: () => "dui", pattern: R(String.raw`\bdui\b|\bdwi\b|\bdrunk\s+driving\b|\bdriving\s+under\s+the\s+influence\b`) },
  { concept: "measure", value: () => "drug_possession", pattern: R(String.raw`\bdrug\s+possession\b|\bpossession\b|\bdrug(?:\/narcotic)?\s+(?:offenses?|violations?)\b|\bdrugs?\b|\bnarcotics?\b`) },
  // P32: "sexual assaults" is asked about like "sex offenses" (which sex offenses), never read as aggravated assault.
  // Not "sexual assault kits" or "sex offender registrations" (Codex P32 review 01.2): those aren't offenses.
  { concept: "measure", value: () => "sex_offense", pattern: R(String.raw`\b(?:all\s+)?(?:forcible\s+)?sex(?:ual)?\s+(?:offenses?|crimes?|assaults?)\b(?!\s+(?:kits?|evidence|exams?|nurses?|forensic|registr\w*|backlogs?))`) },
  { concept: "measure", value: () => "violent_crime", pattern: R(String.raw`\b(?:total\s+)?violent(?:\s+(?:crimes?|offenses?))?\b`) },
  { concept: "measure", value: () => "property_crime", pattern: R(String.raw`\b(?:total\s+)?property(?:\s+(?:crimes?|offenses?))\b`) },
  { concept: "measure", value: () => "all_crime", pattern: R(String.raw`\b(?:total|all|overall)\s+(?:crimes?|offenses?)\b`) },
  { concept: "measure", value: () => "homicide", pattern: R(String.raw`\bhomicides?\b`) },
  { concept: "measure", value: () => "murder", pattern: R(String.raw`\bmurders?\b|\bkillings?\b`) },
  { concept: "measure", value: () => "rape", pattern: R(String.raw`\brapes?\b`) },
  { concept: "measure", value: () => "robbery", pattern: R(String.raw`\brobber(?:y|ies)\b`) },
  { concept: "measure", value: () => "aggravated_assault", pattern: R(String.raw`\baggravated\s+assaults?\b`) },
  { concept: "measure", value: () => "simple_assault", pattern: R(String.raw`\bsimple\s+assaults?\b`) },
  { concept: "measure", value: () => "shoplifting", pattern: R(String.raw`\bshoplifting\b`) },
  { concept: "measure", value: () => "burglary", pattern: R(String.raw`\bburglar(?:y|ies)\b|\bbreak[-\s]?ins?\b`) },
  { concept: "measure", value: () => "theft", pattern: R(String.raw`\blarcen(?:y|ies)\b|\bthefts?\b`) },
  { concept: "measure", value: () => "arson", pattern: R(String.raw`\barsons?\b`) },
];

const RULES: Rule[] = [
  // ---- typed agency codes: ask by name ----
  { concept: "ori", pattern: R(String.raw`\bORI\s*[:#]?\s*[A-Z0-9]{7,9}\b|\b[A-Z]{2}\d{7}\b`, "g"), state: "not-interpreted",
    explanation: declined("I can't look an agency up by its ORI code here; please ask by the agency's name.") },
  // ---- preserved operations ----
  { concept: "peer", value: (m) => `peer:${(/(\d+)/.exec(m[0]) ?? ["", ""])[1]}`, pattern: R(String.raw`\b(?:increase|raise|change|go)\s+(?:it\s+)?to\s+\d+\s+(?:comparable|similar(?:ly)?[-\s]?(?:sized?)?|peer)\s+(?:agencies|departments|cities)\b`) },
  { concept: "peer", value: (m) => `peer:${(/(\d+)/.exec(m[0]) ?? ["", ""])[1]}`, pattern: R(String.raw`\b(?:\d+\s+)?(?:other\s+)?(?:agencies|departments|cities)\s+of\s+(?:similar|comparable)\s+size\b|\b(?:\d+\s+)?(?:(?:similar(?:ly)?[-\s]?(?:sized?)?|comparable)\s+(?:agencies|departments|cities)|peers?)\b`) },
  { concept: "coverage-lookup", value: () => "coverage", pattern: R(String.raw`\bwhat\s+(?:years\s+of\s+)?data\s+(?:do\s+you\s+have|is\s+available|are\s+available|exists?)\b|\bwhat\s+years(?:\s+of\s+data)?(?:\s+do\s+you\s+have)?\b|(?<!\ball\s)\bavailable\s+(?:data|years)\b|\bdata\s+coverage\b|\bcoverage\b`) },  // "all available years" is every year (Codex reader-period review 01)
  { concept: "completeness", value: () => "completeness", pattern: R(String.raw`\b(?:completeness|complete|up\s+to\s+date|finali[sz]ed|final)\b`),
    when: (_m, q) => detectCompletenessQuestion(q) !== null },
  { concept: "cohort", value: () => "consistent-reporters", pattern: R(String.raw`\b(?:for\s+)?(?:consistent(?:ly)?|continuous(?:ly)?)\s+report(?:ers|ing(?:\s+agencies)?)\b|\bagencies\s+that\s+reported\s+every\s+year\b`) },
  { concept: "explain", value: () => "explain", pattern: R(String.raw`\bwhy\b|\bhow\s+come\b|\bwhat\s+explains?\b|\breasons?\s+(?:for|why|behind)\b|\bcauses?\s+(?:of|for|behind)\b|\bexplain(?:s|ed)?\b`) },
  // ---- a clearance reason that contains a court word: claimed before the court words ----
  { concept: "clearance-reason", value: () => "clearance:B", pattern: R(String.raw`\b(?:the\s+)?prosecution\s+(?:was\s+|were\s+|being\s+)?declined\b|\bprosecution[-\s]declined\b`) },
  // Option 3 batch 1 (P202): "offense codes", "list of … codes": a question about the codes themselves.
  { concept: "meta-codes", pattern: R(String.raw`\blist\s+of\s+(?:[a-z]+\s+){0,3}codes\b|(?<=\blist\s)of\s+(?:[a-z]+\s+){0,3}codes\b|\b(?:offen[cs]e|ucr|nibrs|crime)\s+codes?\b|\bcodes?\s+(?:list|definitions?)\b`) },
  // ---- not recorded in NIBRS ----
  // Option 3 batch 1 (P078): a per-group crime rate needs population denominators the source does not hold (the established
  // demographic-rate limitation, lib/capability-overrides.ts).
  { concept: "demographic-rate", pattern: R(String.raw`\b(?:people\s+)?commit\s+more\s+crimes?\b|\bproportion(?:al(?:ly)?)?[-\s]?wise\b|\bproportionally\b|\bdisproportionate(?:ly)?\b`), state: "not-recorded", explanation: DEMOGRAPHIC_RATE },
  // Option 3 batch 1 (P367): "or distribution of", "sales of drugs": not a separate NIBRS measure.
  { concept: "drug-activity", pattern: R(String.raw`\b(?:or|and)\s+(?:distribution|distributing|dealing|sales?|selling|trafficking)(?:\s+of)?\b|\b(?:distribution|dealing|sales?|selling|trafficking)\s+of\s+(?:drugs?|narcotics?)\b`), state: "not-recorded", explanation: DRUG_ACTIVITY },
  // Option 3 batch 1 (P341): what people said, or how they got a weapon, is not recorded.
  { concept: "statements", pattern: R(String.raw`\bclaim(?:s|ed)?\s+(?:in\s+(?:an\s+)?interviews?\s+)?(?:to\s+have|that\s+they\s+had)\s+(?:unrestricted\s+)?access\s+to\s+(?:the\s+|a\s+)?(?:guns?|firearms?|weapons?)\b`), state: "not-recorded", explanation: STATEMENTS },
  // Option 3 batch 1 (P159): shootings, longest phrase first so "shooting victimizations" is one part.
  { concept: "shooting", pattern: R(String.raw`\b(?:shooting\s+(?:victims?|victimizations?|incidents?)|people\s+(?:who\s+(?:were|got)\s+)?shot|gunshot\s+(?:victims?|wounds?)|shootings?)\b`), state: "not-recorded", explanation: SHOOTING },
  // Option 3 batch 1 (2026-10-21, carried from the reverted #36): overdose deaths and immigration/citizenship status
  // are not recorded, so they are refused by name rather than as unread words. Claimed early, before the drug and place words.
  { concept: "overdose-deaths", pattern: R(String.raw`\b(?:(?:drug|opioid|opiate|fentanyl|heroin)\s+)?overdos(?:e|es|ed|ing)(?:\s+(?:deaths?|fatalities|victims?))?\b`), state: "not-recorded", explanation: OVERDOSE },
  // A country outside the United States (redesign test 2026-11-04: "robberies in Paris, France in 2025" had been "I
  // didn't understand 'France'"): declined plainly. Never a U.S. place (Codex follow-up-rewrites re-check 01): not after
  // "New" ("New Mexico", any spacing), and not when the next word continues a place name ("Mexico Missouri", "Brazil,
  // Indiana", "China Grove, Texas"); only a country standing alone, followed by the end, punctuation or a plain word
  // ("in 2024", "since", "and"). City names shared with U.S. cities (Toronto, Vancouver) are not listed.
  { concept: "outside-us", pattern: R(String.raw`\b(?:canada|mexico|france|england|britain|united\s+kingdom|scotland|ireland|germany|italy|spain|portugal|netherlands|sweden|norway|japan|china|india|pakistan|brazil|argentina|australia|new\s+zealand|russia|ukraine|israel|nigeria|south\s+africa|haiti|philippines|el\s+salvador|honduras|guatemala|colombia|venezuela|london,?\s+(?:england|uk)|paris,?\s+france)\b`), state: "not-recorded",
    when: (m, q) => !/\bnew\s*$/i.test(q.slice(0, m.index))
      && !/^\s*,?\s*(?!(?:in|during|from|since|for|by|and|or|vs\.?|versus|compared|between|over|per|to|through|of|with|at|on|the|last|this|over|before|after|between|year|years|month|months)\b)[a-z]/i.test(q.slice(m.index + m[0].length)),
    explanation: declined("the data covers U.S. law enforcement agencies only.") },
  // Officers as victims: "murders of police", "assaults on King County sheriffs", "officers killed", "police deaths",
  // "killed in the line of duty". Not "killed by police" (people killed by officers) nor an agency's name.
  { concept: "officer-victims", pattern: R([
    String.raw`\b(?:murders?|homicides?|killings?|deaths?|fatalities|(?:aggravated\s+)?assaults?|shootings?|attacks?|ambush(?:es)?)\s+(?:of|on|against)\s+(?:the\s+)?${OFFICER_PLACE}${OFFICERS}\b`,
    String.raw`\b(?:police|officer|cop|deputy|trooper|sheriff)s?\s+(?:deaths|fatalities|victims?)\b`,
    // "with sheriffs as victims", "victims who were officers" (Codex officer review 01).
    String.raw`\b${OFFICERS}\s+as\s+(?:the\s+)?victims?\b|\bvictims?\s+(?:who\s+)?(?:were|are|was|is)\s+(?:a\s+|an\s+)?${OFFICERS}\b`,
    // Officers who were killed, not officers who killed someone ("officers killed 10 people").
    String.raw`\b${OFFICERS}\s+(?:who\s+)?(?:were\s+|was\s+|being\s+|got\s+)?(?:killed|murdered|assaulted|injured|ambushed|attacked)\b(?!\s+(?:by|with)\b)${OFFICER_OBJECT}`,
    String.raw`\b(?:officers?|police|cops?|deput(?:y|ies)|troopers?)\s+(?:(?:were|was|being|got)\s+)?shot\b(?:\s+(?:dead|and\s+killed))?${OFFICER_OBJECT}`,
    String.raw`\bkilled\s+in\s+(?:the\s+)?(?:line\s+of\s+duty|action)\b|\bleoka\b`,
  ].join("|")), state: "not-recorded", explanation: OFFICER_VICTIMS },
  { concept: "immigration-status", pattern: R(String.raw`\b(?:(?:legal|illegal|undocumented|documented|unauthorized|recent|new)\s+)*(?:(?:u\.?s\.?|american|naturali[sz]ed|native[-\s]born)\s+citizens?|(?<=\b(?:by|among)\s+(?:the\s+)?)citizens\b|citizen\s+status|immigrants?|migrants?|immigration(?:[-\s]status)?|citizenship(?:[-\s]status)?|residency\s+status|non[-\s]?citizens?|noncitizens?|illegal\s+aliens?|undocumented(?:\s+(?:people|persons|individuals|residents))?|refugees?|asylum[-\s]seekers?|foreign[-\s](?:born|nationals?)|deportees?|visa\s+holders?|green[-\s]card\s+holders?)\b`), state: "not-recorded", explanation: IMMIGRATION },
  { concept: "court", pattern: R(String.raw`\bconvict(?:ions?|ed|s)?\b|\bsentenc(?:es?|ed|ing)\b|\bprosecutions?\b|\bprosecutors?\b|\bprosecuted\b|\bdefendants?\b|\bcourts?\b|\bprobation\b|\bparole\b`), state: "not-recorded", explanation: COURT },
  { concept: "sub-city", pattern: R(String.raw`\bzip\s*codes?\b|\bzip\b|\bneighbou?rhoods?\b|\bdistricts?\b|\bprecincts?\b|\bwards?\b|\bbeats?\b|\bcensus\s+tracts?\b`), state: "not-recorded", explanation: SUBCITY },
  { concept: "daily", pattern: R(String.raw`\bby\s+(?:the\s+)?day\b|\bper\s+day\b|\beach\s+day\b|\bdaily\b|\bday[-\s]by[-\s]day\b`), state: "not-recorded", explanation: DAILY },
  { concept: "two-way-rank", pattern: R(String.raw`\b(?:(?:what|which)\s+)?(?:crime|offen[cs]e)(?:\s+type)?\s+and\s+(?:where|which\s+(?:state|city|agency))\b`), state: "not-interpreted",
    explanation: declined("that asks for two rankings at once (which offense and which place); ask for one ranking at a time.") },
  { concept: "phase-unsupported", pattern: R(String.raw`\b(?:early|mid|late)[-\s]?(?:(?:19|20)\d0'?s|${YEAR}s?)\b|\b(?:the\s+)?(?:19|20)\d0'?s\b`), state: "not-interpreted",
    explanation: declined("I can't turn that into specific years; please give the years (for example \"from 2020 to 2023\").") },
  // ---- rolling windows and months (before the year rules) ----
  // r2: "rolling 12-month violent crime totals" -- "totals" after the measure is the rolling sum (Codex extra-5/6).
  { concept: "rolling", value: () => "rolling12", pattern: R(String.raw`\btotals\b`), when: (m, q) => /\b(?:rolling|trailing)\s+(?:12|twelve)[-\s]?months?\b/i.test(q.slice(0, m.index)) },
  // Rolling windows of any length the question names (Jeff 2026-11-05: "rolling shouldn't just be 12 months"), as a
  // total or, named so, an average (Jeff: "Answer the average"): "rolling over 6 months", "12 months rolling", "rolling
  // 12m", "12m rolling", "on a rolling 3 month basis", "3-month rolling average", "rolling 2-year". A window in days or
  // weeks is not read. No length named ("rolling average", "rolling sum"): asked (Jeff: "Ask which length"). The value
  // stays "rolling12" for the 12-month total (the live tab's binding reads it); "rolling:N", "rolling-avg:N" otherwise,
  // with "?" for no length.
  { concept: "rolling", value: (m) => rollingValue(m[0]), pattern: R(String.raw`${ROLLING_WINDOW}`) },
  { concept: "rolling", value: (m) => rollingValue(m[0]), pattern: R(String.raw`\b(?:rolling|moving|trailing)\s+(?:averages?|avg|means?|sums?|totals?|counts?|basis)\b|\brolling\b(?!\s+(?:back|out|stone|thunder|in\b))`),
    when: (m, q) => !new RegExp(ROLLING_WINDOW, "i").test(q) },
  ...MONTH_PERIODS,
  // ---- periods (the accepted Historical forms) ----
  { concept: "period", value: (m) => `range:${m[1]}:${m[2]}`, pattern: R(String.raw`\bfrom[.,:]?\s+(${YEAR})\s*(?:-|–|—|to|through|thru|until|till)\s*(${YEAR})\b`) },
  { concept: "period", value: (m) => `years:${m[1]}:${m[2]}`, pattern: R(String.raw`\b(?:for|in)\s+(${YEAR})\s+and\s+(${YEAR})\b`) },
  { concept: "period", value: (m) => `between:${m[1]}:${m[2]}`, pattern: R(String.raw`\bbetween\s+(${YEAR})\s+and\s+(${YEAR})\b`) },
  // Reader cluster 3 (2026-11-05): a year to the latest the source has, in the query log's words ("2018 to present",
  // "from 2014 to today", "to the most recent data", "through the most recent month", "to most current"): since that year.
  { concept: "period", value: (m) => `since:${m[1]}`, pattern: R(String.raw`\b(?:(?:since|starting(?:\s+in)?|beginning(?:\s+in)?|from)\s+)?(${YEAR})\s*(?:-|–|—|to|through|thru|until|till)\s*(?:the\s+)?(?:present(?:\s+day)?|now|today|date|current(?:\s+(?:year|data))?|most\s+(?:recent|current)(?:\s+(?:data|year|month|available(?:\s+data)?))?|latest(?:\s+(?:data|year|month))?)\b`) },
  { concept: "period", value: (m) => `since:${m[1]}`, pattern: R(String.raw`\b(?:since|starting(?:\s+in)?|beginning(?:\s+in)?|from)\s+(${YEAR})(?:\s*(?:-|–|to|through|until)\s*(?:the\s+)?(?:present|now|today|current(?:\s+year)?)|\s+on(?:wards?)?)?\b`) },
  // "a 5-year history": the last 5 years.
  { concept: "period", value: (m) => `last:${m[1]}`, pattern: R(String.raw`\b(?:an?\s+)?(\d{1,2})[-\s]year\s+history\b`) },
  // Every year the source has (D5, Jeff 2026-11-04: "show every year we have"): "as far back as you can", "for as many
  // years as possible", "all available years", "the full history of", "historical(ly)", "from the beginning of the data".
  { concept: "grain", value: () => "year", pattern: R(String.raw`\b(?:from\s+)?as\s+far\s+back\s+as\s+(?:you\s+can|possible|available|(?:there\s+is|we\s+have)\s+data|(?:the\s+)?data\s+(?:goes|exists|allows)|it\s+goes)\b|\bfor\s+as\s+many\s+years\s+as\s+(?:possible|available|you\s+(?:can|have))\b|\b(?:for\s+)?all\s+(?:available\s+)?years\b|\bevery\s+year\s+available\b|\b(?:from\s+)?(?:the\s+)?beginning\s+of\s+(?:the\s+)?(?:data|records)(?:\s+(?:until|to|through)\s+(?:the\s+)?present)?\b|\b(?:the\s+)?full\s+history(?:\s+of)?\b|\bhistorical(?:ly)?\b|\bsince\s+(?:records|data)\s+(?:began|start(?:ed)?)\b`) },
  { concept: "period", value: (m) => `range:${m[1]}:${m[2]}`, pattern: R(String.raw`\b(${YEAR})\s*(?:-|–|—|to|through|thru)\s*(${YEAR})\b`) },
  { concept: "period", value: (m) => `last:${numberToken(m[1])}`, pattern: R(String.raw`\b(?:over\s+|in\s+|for\s+|during\s+)?(?:the\s+)?(?:last|past|previous|prior)\s+(${NUMBER})\s+(?:(?:full|complete|calendar)\s+)?years\b`) },
  { concept: "period", value: () => "lastyear", pattern: R(String.raw`\b(?:in\s+)?last\s+year\b`) },
  // "the current murder trend": Current Trends' recent months (Jeff 2026-11-05: "current trends" is Current Trends').
  // Read as its own part; the answer fills the months from the release (lib/nibrs-shadow/answer.ts).
  { concept: "recent", value: () => "recent", pattern: R(String.raw`\bcurrent(?:ly)?\b(?=\s+(?:[a-z]+\s+){0,2}trends?\b)|\bcurrent(?:ly)?\b(?=\s+trending\b)`) },
  { concept: "period", value: () => "latest", pattern: R(String.raw`\b(?:in\s+|for\s+)?(?:the\s+)?(?:latest|most\s+recent)\s+(?:year|data)(?:\s+available)?\b`) },
  { concept: "period", value: (m) => `year:${m[1]}`, pattern: R(String.raw`\b(?:in|for|during|using|of)\s+(${YEAR})(?:\s+data)?\b`) },
  { concept: "period", value: (m) => `year:${m[1]}`, pattern: R(String.raw`\b(${YEAR})\b`) },
  // ---- population thresholds (accepted Historical forms) ----
  { concept: "threshold", value: (m) => thresholdValue(m[0]), pattern: R(String.raw`\(?\b(?:(?:with|having)\s+)?(?:an?\s+)?(?:(?:populations?|pop\.?)\s+(?:of\s+)?)?(?:at\s+least|over|above|more\s+than|greater\s+than|exceeding|under|below|less\s+than|fewer\s+than|at\s+most|min(?:imum)?(?:\s+of)?|max(?:imum)?(?:\s+of)?)\s+\d[\d,]*(?:\.\d+)?(?:\s*(?:k\b|thousand\b|m\b|million\b))?(?:\s*\+)?(?:\s+${POP_WORD})?(?:\s+or\s+(?:more|larger|greater))?\)?`),
    when: (m) => /(?:population|pop\b|pop\.|people|residents|persons|inhabitants|\d\s*k\b|thousand|million|\bmin\b|\bmin(?:imum)?\b)/i.test(m[0]) },
  { concept: "threshold", value: (m) => thresholdValue(m[0]), pattern: R(String.raw`\b(?:of\s+)?\d[\d,]*\s*(?:k|thousand|million)?\s*(?:${POP_WORD}\s+)?(?:or\s+(?:more|larger|greater)|\+)(?:\s+${POP_WORD})?`),
    when: (m) => /(?:population|people|residents|persons|inhabitants|\d\s*k\b|thousand|million)/i.test(m[0]) },
  // ---- shares (the structure is read by the types from where the words sit) ----
  { concept: "share", value: () => "share", pattern: R(String.raw`\b(?:what|which)\s+(?:share|percent(?:age)?|proportion|portion)\s+of\b|\b(?:the\s+)?(?:share|percent(?:age)?|proportion|portion)\s+of\b|\bas\s+a\s+(?:share|percent(?:age)?|proportion)\s+of\b|\bshares?\b|\bpercent(?:age)?\b|\bproportion\b`) },
  // ---- clearance words ----
  { concept: "clearance", value: () => "rate", pattern: R(String.raw`\bclearance\s+rates?\b`) },
  { concept: "clearance", value: () => "clearances", pattern: R(String.raw`\bclearances?\b(?!\s+(?:type|status|category)\b)`) },
  { concept: "clearance", value: () => "cleared", pattern: R(String.raw`\b(?:were\s+|was\s+)?cleared(?:\s+because)?\b`) },
  ...BREAKDOWNS,
  { concept: "filter", value: () => "clearance:arrest", pattern: R(String.raw`\bby\s+arrest\b`), when: (_m, q) => /\bclear/i.test(q) },
  ...FILTERS,
  // ---- value statistics (property families) ----
  { concept: "statistic", value: () => "average_value", pattern: R(String.raw`\baverage\s+(?:dollar\s+)?value(?:\s+of)?\b`) },
  { concept: "statistic", value: () => "total_value", pattern: R(String.raw`\b(?:total\s+)?(?:dollar\s+)?value(?:\s+of)?\b|\bworth\b`) },
  // ---- rate and count statistics ----
  { concept: "statistic", value: () => "per100k", pattern: R(String.raw`\bper\s+100(?:,?000|\s*k|\s+thousand)(?:\s+${POP_WORD})?\b`) },
  { concept: "statistic", value: (m) => `scale:${m[1]}`, pattern: R(String.raw`\bper\s+(\d[\d,]*(?:\s*k\b)?|ten\s+thousand|million|one\s+million|thousand)(?:\s+${POP_WORD})?\b`) },
  { concept: "statistic", value: () => "percapita", pattern: R(String.raw`\bper[-\s]capita\b`) },
  { concept: "statistic", value: () => "rate", pattern: R(String.raw`\b(?:incident\s+)?rates?\b`) },
  { concept: "statistic", value: () => "count", pattern: R(String.raw`\bhow\s+many\b|\b(?:total\s+)?(?:annual\s+)?(?:numbers?|counts?)(?:\s+of)?\b`) },
  // ---- ranking ----
  { concept: "rank", value: (m) => `${/bottom/i.test(m[1]) ? "bottom" : "top"}:${numberToken(m[2])}`, pattern: R(String.raw`\b(top|bottom)\s+(${NUMBER})\b`) },
  { concept: "rank", value: (m) => `${/lowest|fewest|least|smallest/i.test(m[0]) ? "bottom" : "top"}:`, pattern: R(String.raw`\b(?<!\bat\s)(?:the\s+)?(?:highest|lowest|most|fewest|least|largest|smallest|greatest|biggest)\b`) },
  { concept: "rank", value: () => "rank:", pattern: R(String.raw`\b(?:rank(?:ed|ing|ings)?|top)\b`) },
  // ---- change and comparison ----
  { concept: "change", value: (m) => `change:${changeDirection(m[0])}`, pattern: R(String.raw`\b(?:percent(?:age)?\s+change|%\s*change|difference(?=\s+between\b)|change[sd]?|changing|increase[sd]?|increasing|decrease[sd]?|decreasing|rise|rose|risen|rising|fall(?:en)?|fell|falling|drop(?:ped|s)?|declin(?:e|ed|es|ing)|grew|grow(?:n|th)?|went\s+(?:up|down))\b`) },
  { concept: "versus", value: () => "versus", pattern: R(String.raw`\b(?:vs\.?|versus|compared\s+(?:to|with)|against)(?=\s|$)`) },
  { concept: "compare", state: "context", pattern: R(String.raw`\bcompar(?:e[ds]?|ing|ison)\b|\bside\s+by\s+side\b`) },
  // ---- lists and grain ----
  { concept: "list", value: (m) => `list:${listKey(m[1])}`, pattern: R(String.raw`\b(?:broken\s+down\s+by|by|per|for\s+each|for\s+every|each|every|across)\s+(state|count(?:y|ies)|cit(?:y|ies)|agenc(?:y|ies)|departments?)(?:\s+and\s+(?:by\s+)?year)?\b`) },
  { concept: "grain", value: () => "month", pattern: R(String.raw`\b(?:by|per|each|every|for\s+each)\s+month\b|\bmonthly\b|\bmonth[-\s]by[-\s]month\b`) },
  { concept: "grain", value: () => "year", pattern: R(String.raw`\b(?:by|per|each|every|for\s+each)\s+year\b|\byearly\b|\bannual(?:ly)?\b|\byear[-\s](?:by|over)[-\s]year\b|\bover\s+time\b|\btrend(?:s|ed|ing)?(?:\s+(?:up|down|upwards?|downwards?|higher|lower))?\b`) },
  // ---- counting units (after the families so "DV arrests" keeps both parts) ----
  { concept: "unit", value: () => "victims", pattern: R(String.raw`\bvictims?\b|\bvictimi[sz]ations?\b`) },
  { concept: "unit", value: () => "offenders", pattern: R(String.raw`\boffenders?\b|\bsuspects?\b|\bperpetrators?\b`) },
  { concept: "unit", value: () => "arrests", pattern: R(String.raw`\barrest(?:s|ees?)?\b|\barrested\b`) },
  { concept: "unit", value: () => "incidents", pattern: R(String.raw`\bincidents?\b`) },
  // "Sex offenses" is a crime, not the counting unit (Codex P32 review 01.4: "forcible sex offenses" was unread).
  { concept: "unit", value: () => "offenses", pattern: R(String.raw`(?<!\bsex(?:ual)?\s)\boffen[cs]es\b`) },
  ...MEASURES,
  { concept: "measure", value: () => "unspecified", pattern: R(String.raw`\bcrimes?\b|\boffen[cs]es?\b|\bcases\b`) },
  // ---- combine ----
  { concept: "combine", value: () => "combine", pattern: R(String.raw`\b(?:combined|altogether|all\s+together|in\s+total|in\s+all|summed|sum\s+of|together)\b`) },
  { concept: "combine", value: () => "combine", pattern: R(String.raw`\btotal\b`) },
  // ---- national and entity words ----
  { concept: "place", value: () => "national", pattern: R(String.raw`(?<![A-Za-z.])(?:U\.S\.A?\.?|USA|US)(?![A-Za-z])`, "g") },
  { concept: "place", value: () => "national", pattern: R(String.raw`\b(?:(?:in\s+)?the\s+)?(?:national(?:ly)?|nationwide|countrywide|united\s+states|america|(?:the\s+)?(?:nation|country))\b`) },
  { concept: "entity", value: (m) => listKey(m[0]), pattern: R(String.raw`\b(?:county\s+(?:agenc(?:y|ies)|sheriffs?(?:['’]\s*offices)?)|sheriffs?(?:['’]\s*offices)?|police\s+(?:departments?|agencies)|cities|city|towns?|counties|agencies|agency|departments|states|state)\b`) },
  // ---- presentation, connectors and share/filter linking words ----
  { concept: "presentation", state: "context", pattern: R(String.raw`\b(?:(?:in|as)\s+(?:a\s+)?)?(?:nibrs|fbi|crime\s+data|data|stats|statistics|info(?:rmation)?|chart|graph|table|plot|figures|numbers|breakdown|summary|list|results?|series|bars?)\b`) },
  { concept: "connector", state: "context", pattern: R(String.raw`(?:^|\s)(?:and|&|,)(?=\s|$)`) },
  { concept: "connector", state: "context", pattern: R(String.raw`\b(?:that|who|which)\s+(?:were|was|involved)\b|\binvolv(?:ed|ing)\b|\bkilled\s+with\b|\bcommitted\s+by\b|\breported\s+by\b|\bwith\b(?=\s+(?:a\s+)?(?:handgun|rifle|shotgun|knife|gun|firearm))`) },
  { concept: "connector", state: "context", pattern: R(String.raw`\bbetween\b(?=\s+(?:the\s+)?(?:city\s+of\s+)?[A-Z])`, "g") },
  { concept: "connector", state: "context", pattern: R(String.raw`\b(?:now\s+)?what\s+about\b|\b(?:only|just)\s+(?:those|the\s+ones|the)\b|\bthat['’]s\b|\bthat\s+is\b|\bsaw\s+the\b`) },
];

function listKey(raw: string): string {
  const t = raw.toLowerCase();
  if (/county|sheriff/.test(t)) return "county";
  if (/cit(?:y|ies)|town/.test(t)) return "city";
  if (/agenc|department|police/.test(t)) return "agency";
  if (/state/.test(t)) return "state";
  return t;
}

const STATE_CODES: Record<string, string> = { texas: "TX", ohio: "OH", illinois: "IL", california: "CA", maryland: "MD", "new mexico": "NM", louisiana: "LA", mississippi: "MS", minnesota: "MN", "new york": "NY", pennsylvania: "PA" };
/** "<Name> County Sheriff's Office[, <State>]": one county agency place (the geo resolver reads "<Name>" as a city). */
function recordCountySheriffs(ledger: RequestLedger): void {
  const re = /\b((?:[A-Z][a-z]+\s+){1,3})County\s+Sheriff(?:['’]s)?(?:\s+(?:Office|Department))?(?:,\s*(Texas|Ohio|Illinois|California|Maryland|New Mexico|Louisiana|Mississippi|Minnesota|New York|Pennsylvania|[A-Z]{2})\b)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ledger.question))) {
    const name = m[1].trim();
    const st = m[2] ? (m[2].length === 2 ? m[2] : STATE_CODES[m[2].toLowerCase()]) : "";
    ledger.record({ concept: "place", value: `county:${name}:${st}`, span: [m.index, m.index + m[0].length], rule: "place:county-sheriff" });
  }
}

/**
 * "<Name> County[, <State>]" and "<Name> Parish" after a place word ("in tarrant county, texas"): one county place. The
 * shared geo resolver knows few counties and reads "Tarrant" as Tarrant, Alabama (coordinator 2026-11-05). The name is
 * the one to three words between the place word and "County"; the shadow engine finds it in its own place index, and a
 * county it doesn't have is declined by name there.
 */
const COUNTY_STATES = Object.keys(STATE_NAME_TO_ABBR as Record<string, string>).filter((n) => n.toLowerCase() !== "united states").sort((a, b) => b.length - a.length);
const COUNTY_CODES = Object.values(STATE_NAME_TO_ABBR as Record<string, string>).filter((c) => c !== "US");
const NOT_A_COUNTY_NAME = /^(?:the|each|every|which|what|any|all|a|an|one|per|my|our|your|their|its|this|that|same|other|another|by|and|or|of|in|for|at|from|to|with|largest|biggest|smallest|most|least|top|home|whole|entire|neighboring|surrounding|adjacent|nearby|rural|urban|suburban|local|large|small)$/i;
function recordCounties(ledger: RequestLedger): void {
  // Groups: the name's words, County or Parish, "Sheriff's Office", "in <State>", ", <State or code>", "Sheriff's Office".
  // "Sheriffs" only before "Office": "murders of King County sheriffs" are people (Codex place review 04).
  const SHERIFF = String.raw`(\s+sheriff(?:s\s+(?:office|department)|['’]s(?:\s+(?:office|department))?|\s+(?:office|department))?(?![A-Za-z]))?`;
  const re = new RegExp(String.raw`(?:^|\b(?:in|for|of|at|from|and|vs\.?|versus|between|across|within|to)\s+)(?:the\s+)?((?:[A-Za-z][A-Za-z.'’-]*\s+){1,3}?)(County|Parish)\b${SHERIFF}(?:\s+in\s+(?:the\s+state\s+of\s+)?(${COUNTY_STATES.join("|")})\b|\s*,?\s*(${COUNTY_STATES.join("|")}|${COUNTY_CODES.join("|")})\b)?${SHERIFF}`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(ledger.question))) {
    // The name is the words after the last that can't be one ("in Ohio and Tarrant County": Tarrant; "in each county": none).
    const all = m[1].trim().split(/\s+/);
    const words = all.slice(all.reduce((k, w, i) => (NOT_A_COUNTY_NAME.test(w) ? i + 1 : k), 0));
    if (!words.length) { re.lastIndex = m.index + m[0].length; continue; }
    const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    const kind = /^parish$/i.test(m[2]) ? "Parish" : "County";
    const stWord = m[4] ?? m[5] ?? "";
    // A two-letter code that is also a word ("in", "or", "me", "hi", "ok") only in capitals: "in Orange County in 2024"
    // and "Montgomery County, in 2024" are not Indiana (Codex place review 01); "harris county tx" is Texas, "Mecklenburg
    // county in North Carolina" North Carolina.
    const code = stWord.length === 2 ? ((stWord === stWord.toUpperCase() || !/^(?:in|or|me|hi|ok)$/i.test(stWord)) ? stWord.toUpperCase() : "") : stWord ? (STATE_NAME_TO_ABBR as Record<string, string>)[COUNTY_STATES.find((n) => n.toLowerCase() === stWord.toLowerCase())!] : "";
    const m1 = m.index + m[0].indexOf(m[1]);
    const start = m1 + [...m[1].matchAll(/\S+/g)][all.length - words.length].index!;
    const end = code ? m.index + m[0].length : m1 + m[1].length + m[2].length + (m[3]?.length ?? 0);
    ledger.record({ concept: "place", value: `county:${name} ${kind}:${code}`, span: [start, end], rule: "place:county" });
    re.lastIndex = end;
  }
}

/**
 * A season before a year ("Spring 2024", "summer of 2023") is never a place: "Spring" had answered Spring Township,
 * Pennsylvania (coordinator 2026-11-05). The reader has no season periods, so the word is named as not understood.
 */
function recordSeasons(ledger: RequestLedger): void {
  // Only after a time word or at the start: "Big Spring 2024" is the city (Codex place review 01).
  const re = /(?<=^|\b(?:in|during|for|of|the|from|to|through|until|since|between|and|vs|versus|this|last|next|each|every|over)\s+|,\s*)(?:spring|summer|fall|autumn|winter)(?=\s+(?:of\s+)?(?:19|20)\d\d\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ledger.question))) {
    const span: Span = [m.index, m.index + m[0].length];
    ledger.record({ concept: "unrecognized", span, rule: "season", state: "not-interpreted", explanation: couldNotInterpret(m[0]) });
  }
}

/** Which-words opening a ranking or list ("which cities had the most"). Context only beside an entity. */
function recordWhich(ledger: RequestLedger): void {
  const re = /\b(?:which|what)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ledger.question))) {
    const rest = ledger.question.slice(m.index + m[0].length);
    if (/^\s+(?:\d+\s+)?(?:cities|city|states?|counties|county|agencies|agency|departments?|towns?|police)\b/i.test(rest) || /^\s+(?:violent\s+|property\s+)?(?:crimes?|offen[cs]es?)\b/i.test(rest)) {
      ledger.record({ concept: "which", span: [m.index, m.index + m[0].length], rule: "which", state: "context" });
    }
  }
}

/** NIBRS filler beyond the shared between-filler words: verbs and articles that never restrict. */
const NIBRS_FILLER = /^(?:had|have|has|were|was|is|are|there|been|the|a|an|in|of|for|with|by|from|at|on|to|me|do|does|did|i|you|see|can|could|show|give|find|get|list|what|which|many|much|data|people|reported|recorded|occurred|it|its|their|lot|all|any|each|per|year|years|over|about|use|using|please|just|also|now|then|those|these|this|that|same|other|than|level|levels|numbers?|crime|police|nationally|happened|provide|one|bar|reflected|where|when|did|occur|committed|by|use)$/i;

/**
 * Stage 3b (GC-089, plan r1.3): conversational phrases that never restrict, recorded as context before the word filler:
 * a leading "OK", "(just) do it" (a follow-up's verb), a complaint about the last answer ("this is not even close"),
 * and "broken down" right before "by" (read as "by").
 */
const NIBRS_PHRASE_FILLER = [/^\s*ok(?:ay)?\b[,.]?/i, /\b(?:just\s+)?do\s+it\b/i, /\b(?:this|that)\s+is\s+(?:not|n't)\s+(?:even\s+)?(?:close|right)\b[,.]?/i, /\bbroken\s+down(?=\s+by\b)/i];
function recordNibrsPhraseFiller(ledger: RequestLedger): void {
  for (const re of NIBRS_PHRASE_FILLER) {
    const m = re.exec(ledger.question);
    if (!m) continue;
    const span: Span = [m.index, m.index + m[0].length];
    if (ledger.parts.some((p) => p.span[0] < span[1] && span[0] < p.span[1])) continue;
    ledger.record({ concept: "filler", span, rule: "nibrs-phrase-filler", state: "context" });
  }
}

function recordNibrsFiller(ledger: RequestLedger): void {
  recordNibrsPhraseFiller(ledger);
  recordBetweenFiller(ledger);
  const q = ledger.question;
  const recorded = [...ledger.parts].sort((a, b) => a.span[0] - b.span[0]);
  for (const piece of ledger.residue()) {
    if (!NIBRS_FILLER.test(piece.text)) continue;
    const before = /^\s*$/.test(q.slice(0, piece.span[0])) || recorded.some((p) => p.span[1] <= piece.span[0] && /^[\s,]*$/.test(q.slice(p.span[1], piece.span[0])));
    const after = recorded.some((p) => p.span[0] >= piece.span[1] && /^[\s,]*$/.test(q.slice(piece.span[1], p.span[0]))) || /^[\s?.!]*$/.test(q.slice(piece.span[1]));
    if (before && after) ledger.record({ concept: "filler", span: piece.span, rule: "nibrs-filler", state: "context" });
  }
}

/* ------------------------------------------------------------------------------ entry point --------------------- */

/**
 * The NIBRS ledger for one request. Finalized: every character is a part. Clause 1 holds an explanation request when the
 * same turn also asks for a number ("how many robberies ... and why?"), so the number is answered and the explanation
 * named (L7).
 */
export function accountNibrsRequest(question: string): RequestLedger {
  const ledger = new RequestLedger(question);
  recordContext(ledger);
  // Before places: codes, decade words, rolling windows, months ("May 2025" is not a place), refused topics and the
  // peer/cohort operations (whose words contain place-like nouns).
  const early = RULES.filter((r) => EARLY_CONCEPTS.has(r.concept) || MONTH_PERIODS.includes(r));
  for (const rule of early) recordAll(ledger, rule);
  // The county rule first: it reads any state after "Sheriff's Office" (Codex place review 02).
  recordSeasons(ledger);
  recordCounties(ledger);
  recordCountySheriffs(ledger);
  recordPlaces(ledger);
  recordAll(ledger, { concept: "possessive", state: "context", pattern: /['’]s\b/g, when: (pm) => ledger.parts.some((p) => p.concept === "place" && p.span[1] >= pm.index - 1 && p.span[1] <= pm.index) });
  for (const rule of RULES.filter((r) => !early.includes(r))) recordAll(ledger, rule);
  recordWhich(ledger);
  recordNibrsFiller(ledger);
  recordNibrsFiller(ledger);
  const explainParts = ledger.parts.filter((p) => p.concept === "explain");
  const numericAsk = hasExplicitNumericAsk(ledger.parts);
  for (const p of explainParts) p.clause = explainParts.length > 0 && numericAsk ? 1 : 0;
  // Adjacent unknown words are ONE phrase the reader typed, named once.
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

/** Recognition-time refusals: not-recorded topics and not-interpreted words, in written order. */
export function nibrsRecognitionRefusal(ledger: RequestLedger): { parts: Part[]; explanation: string } | null {
  const parts = ledger.refusedAtRecognition();
  if (parts.length === 0) return null;
  return { parts, explanation: refusalSentences(parts).join(" ") };
}

/** The NIBRS response-cache namespace (plan §6): no entry cached before 2b -- a model statement -- can be served. */
export const NIBRS_CACHE_TAB = "nibrs:request-accounting-2b";

/** The reply when the model wrote a statement on the NIBRS tab: it never runs (plan §6). */
export const NIBRS_MODEL_SQL_DECLINE =
  `${NIBRS_CAN_ANSWER} I couldn't match this question to one of the question types I answer, so I haven't run a query for it.`;

/**
 * An EXPLICIT numeric ask: a statistic, a share, a rank, a threshold, a clearance word, a rolling window, or an explicit
 * year, month or range. The same definition decides text vs numeric and the clause of an explanation request.
 */
export function hasExplicitNumericAsk(parts: Part[]): boolean {
  return parts.some((p) => p.state !== "context" && (
    p.concept === "statistic" || p.concept === "rank" || p.concept === "threshold" || p.concept === "share" || p.concept === "rolling"
    || (p.concept === "clearance" && p.value === "rate")
    || (p.concept === "period" && /^(?:year|range|between|since|month|monthrange|years):/.test(p.value ?? ""))));
}

const NUMERIC_CONCEPTS = new Set(["measure", "statistic", "rank", "threshold", "share", "clearance", "change", "combine", "list", "grain", "period", "versus", "unit", "filter", "breakdown", "rolling"]);
// Option 3 batch 1: the not-recorded topics added on 10-21 (shooting, overdose deaths, immigration status) make a request numeric, like the others.
const REFUSED_CONCEPTS = new Set(["ori", "court", "sub-city", "daily", "two-way-rank", "phase-unsupported", "fentanyl", "shooting", "overdose-deaths", "immigration-status", "demographic-rate", "statements", "drug-activity"]);
const OPERATIONS = ["peer", "coverage-lookup", "completeness", "cohort", "meta-codes"];

/**
 * How the request is handled, decided from the turn AS TYPED (r1.1 R1), before any resolver replaces it:
 *   - `text`: an explanation request with no explicit numeric ask, or a turn with no numeric wording at all;
 *   - `numeric`: everything else. Recognition refusals apply; only a fixed path or a supported type may answer.
 */
export function nibrsRequestKind(ledger: RequestLedger): "text" | "numeric" {
  const explain = ledger.parts.some((p) => p.concept === "explain");
  if (explain && !hasExplicitNumericAsk(ledger.parts)) return "text";
  const anyNumeric = ledger.parts.some((p) => NUMERIC_CONCEPTS.has(p.concept) || REFUSED_CONCEPTS.has(p.concept));
  const operation = ledger.parts.some((p) => OPERATIONS.includes(p.concept));
  if (!anyNumeric && !operation && !explain) return ledger.parts.some((p) => p.concept === "place") ? "numeric" : "text";
  return "numeric";
}

/** The K2 key of a part: a filter is keyed by its DIMENSION (r1.1 R1), so a new age filter replaces only an age filter. */
export function followupKey(p: Part): string {
  // A clearance reason is a value of the clearance dimension, whichever rule recorded it ("by exception" is a filter,
  // "prosecution declined" a clearance-reason), so the two replace each other.
  if (p.concept === "filter" || p.concept === "clearance-reason") return `filter:${(p.value ?? "").split(":")[0]}`;
  return p.concept;
}

/**
 * K2 for NIBRS (r1.1 R1): a follow-up is answered only when the effective question (from ANY resolver) carries every
 * restriction of a COMPLETE earlier question, or replaces it with a value this turn states, compared value by value per
 * key. Filters are keyed per dimension.
 */
/**
 * Stage 3b (plan r1.3, GC-089): a turn that names a measure and is fully recognized stands on its own when the earlier
 * question was refused at recognition -- there is no complete earlier question to carry from, so nothing is carried and
 * K2 does not apply to it. K2 is unchanged for every real follow-up.
 */
export function nibrsStandaloneTurn(turn: string, priorUserTurns: string[]): boolean {
  const prev = priorUserTurns[priorUserTurns.length - 1];
  if (!prev) return false;
  if (nibrsRecognitionRefusal(accountNibrsRequest(prev)) === null) return false;
  const ledger = accountNibrsRequest(turn);
  return nibrsRecognitionRefusal(ledger) === null && ledger.parts.some((p) => p.concept === "measure" && p.state !== "context");
}

/**
 * Stage 3b (plan r1.3, GC-089): "(OK,) (just) do it for <year>" rebuilt from the previous USER question with its single
 * year replaced (or added). Any other period form in the previous question is not this resolver's (null). K2 then checks
 * the rebuilt question exactly as for every resolver.
 */
export function resolveNibrsPeriodReplacement(question: string, priorUserTurns: string[]): { refinedQuestion: string } | null {
  // Round 1 W21: also a year range ("show it from 2020 to 2024") and "since <year>". The earlier question's own single
  // period is replaced; an earlier question with any other year wording is left alone (null), and K2 still checks the rest.
  const lead = String.raw`^(?:ok(?:ay)?[,\s]+)?(?:(?:now|then)\s+)?(?:just\s+)?(?:do|run|show|make)\s+(?:it|this|that|them|the\s+same)\s+`;
  const Y = String.raw`((?:19|20)\d{2})`;
  const one = new RegExp(`${lead}for\\s+${Y}[\\s,.?!]*$`, "i").exec(question.trim());
  const range = new RegExp(`${lead}(?:from|for)\\s+${Y}\\s*(?:-|–|to|through|thru)\\s*${Y}[\\s,.?!]*$`, "i").exec(question.trim());
  const since = new RegExp(`${lead}(?:since|starting\\s+in|from)\\s+${Y}[\\s,.?!]*$`, "i").exec(question.trim());
  const period = one ? `in ${one[1]}` : range ? `from ${range[1]} to ${range[2]}` : since ? `since ${since[1]}` : null;
  if (!period) return null;
  const prev = priorUserTurns[priorUserTurns.length - 1];
  if (!prev) return null;
  const stripped = prev
    .replace(/\s+(?:from|between)\s+(?:19|20)\d{2}\s*(?:-|–|to|through|thru|and)\s*(?:19|20)\d{2}\b/gi, "")
    .replace(/\s+(?:in|for|during|since)\s+(?:19|20)\d{2}\b/gi, "");
  if (/\b(?:19|20)\d{2}\b/.test(stripped)) return null;
  return { refinedQuestion: `${stripped.replace(/[\s?.!]+$/, "")} ${period}` };
}

export function nibrsFollowupCheck(opts: {
  question: string;
  effective: string | null;
  previousUserTurns: string[];
  isFollowUp: (q: string) => boolean;
  /** r2: TEXT turns rebuilt by a resolver: only the earlier question's restrictions are required. */
  earlierOnly?: boolean;
}): { explanation: string } | null {
  const COMPLETE = "Please ask it as a complete question (the place, what to count and the period).";
  const previous = opts.previousUserTurns[opts.previousUserTurns.length - 1];
  if (!previous) return null;
  // Stage 3b (r1.3): a previous turn that stood on its own (nibrsStandaloneTurn) is a complete question, not a follow-up.
  if (opts.isFollowUp(previous) && !nibrsStandaloneTurn(previous, opts.previousUserTurns.slice(0, -1))) return { explanation: `This builds on an earlier follow-up, so I can't be sure which conditions from before still apply. ${COMPLETE}` };
  if (!opts.effective) return { explanation: `I couldn't rebuild this follow-up together with your earlier question here. ${COMPLETE}` };
  const prev = accountNibrsRequest(previous);
  const turn = accountNibrsRequest(opts.question);
  const rec = accountNibrsRequest(opts.effective);
  const meaningful = (l: RequestLedger) => l.parts.filter((p) => p.state !== "context" && p.concept !== "explain");
  const val = (p: Part) => p.value ?? p.text.toLowerCase().replace(/\s+/g, " ").trim();
  const values = (l: RequestLedger, key: string) => new Set(meaningful(l).filter((p) => followupKey(p) === key).map(val));
  const keys = new Set([...meaningful(prev), ...(opts.earlierOnly ? [] : meaningful(turn))].map(followupKey));
  for (const key of keys) {
    const fromPrev = values(prev, key);
    const fromTurn = opts.earlierOnly ? new Set<string>() : values(turn, key);
    const inRec = values(rec, key);
    const required = fromTurn.size ? fromTurn : fromPrev;
    const missing = [...required].filter((v) => !inRec.has(v));
    if (missing.length) {
      const source = fromTurn.size ? turn : prev;
      const texts = meaningful(source).filter((p) => followupKey(p) === key && missing.includes(val(p))).map((p) => `"${p.text.trim()}"`);
      return { explanation: `I couldn't carry ${texts.join(" and ")} from your ${fromTurn.size ? "follow-up" : "earlier question"} into this answer, so I haven't answered with a number that leaves it out. ${COMPLETE}` };
    }
  }
  return null;
}
