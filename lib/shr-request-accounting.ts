/**
 * Request accounting for the Homicide Reports (SHR) tab -- stage 1 of the site-wide rule
 * (plan: docs/superpowers/plans/2026-10-07-request-accounting-stage1.md, Codex-accepted r1).
 *
 * Every part of an SHR request is recognized as a typed concept with its span, or it is residue.
 * Recognition DOES NOT decide what is answerable: a recognized concept starts `recognized` and the
 * planner that owns the request binds it (applied) or declines it (not-applied-here). Recognition
 * only decides the three things it can know on its own:
 *
 *   - `not-recorded`: a concept the served SHR source does not record, ONLY with retained evidence
 *     (audit/request-accounting-stage1/task0/facts.md section 1). Today that is immigration and
 *     citizenship status: no production-derived column (scripts/fixtures/operation-taxonomy/shr.ddl.sql)
 *     records it, and the accepted capability statement (lib/source-capabilities.ts
 *     `unsupported-court-policy-topic`) already tells readers so;
 *   - `not-interpreted`: residue, and a stated weapon or reporting agency that matches nothing SHR
 *     records ("via banana", "reported by ICE") -- worded as a parse failure, never as a source fact;
 *   - `context`: openers, politeness, a whole purpose clause, punctuation, linking words between parts.
 *
 * A KNOWN shape that some path declines today ("summer", "Q2", "excluding X", "per capita") is
 * RECOGNIZED here, so that path keeps its own, more specific wording. Only genuinely unknown words
 * are refused at recognition.
 *
 * Employment and sexual-orientation wording that maps to a recorded relationship value (Employee,
 * Employer, Homosexual Relationship) is a relationship concept, never denied (Codex plan r0 #4).
 *
 * Stage 1 keeps one answer clause (0) on SHR. SHR has no mixed-referent split today: court-process
 * and policy topics are already refused whole by the capability override.
 */
import type Database from "better-sqlite3";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { agencySearchKey } from "./shr-agency-normalization";
import { isCommonEnglishWord } from "./english-common-words";
import { COURT_POLICY_TOPIC_MESSAGE } from "./source-capabilities";
import { mayRefuseAsCourtProcess } from "./clearance-referent";
import { STATE_NAME_TO_ABBR } from "./state-population";
import type { ShrCountPlan } from "./shr-count-plan";
import {
  RequestLedger, recordContext, recordBetweenFiller, refusalSentences, type Part, type Span,
} from "./request-accounting";

export const SHR_IMMIGRATION_NOT_RECORDED =
  "Homicide Reports (SHR) don't record immigration or citizenship status, so I can't count victims or offenders by it -- and I won't give an unrestricted count in its place.";

export const SHR_WEAPON_GROUPS = [
  "firearm", "knife or cutting instrument", "blunt object", "personal weapons (hands, fists, feet)",
  "strangulation", "asphyxiation", "fire", "narcotics or drugs", "poison", "other",
];

export function shrWeaponNotInterpreted(text: string): string {
  return `I couldn't interpret "${text.trim()}" as a weapon that Homicide Reports record. They record ${SHR_WEAPON_GROUPS.join(", ")}.`;
}

export function shrAgencyNotInterpreted(text: string): string {
  return `I couldn't identify "${text.trim()}" as a reporting agency in Homicide Reports, so I can't limit a count to what it reported.`;
}

type Rule = {
  concept: string;
  pattern: RegExp;
  value?: (m: RegExpExecArray) => string | null;
  state?: "not-recorded" | "context";
  explanation?: string;
  /** For the unknown-weapon slot: the reader-facing sentence is built from the matched text. */
  notInterpreted?: (text: string) => string;
};

const R = (s: string, flags = "gi") => new RegExp(s, flags);
const lower = (m: RegExpExecArray) => m[0].toLowerCase();

/* ---- vocabulary fragments ---- */
const UNKNOWN = String.raw`(?:unknown|unspecified|undetermined|other)\s+`;
const MEASURE = String.raw`(?:murder(?:s|ed|ing)?|homicides?|killings?|killed|manslaughters?|slayings?|slain|deaths?|died|dead)`;
const NON_NEGLIGENT = String.raw`(?:non[-\s]?negligent\s+manslaughters?|negligent\s+manslaughters?|justifiable\s+homicides?|all\s+homicides?|all\s+types?\s+of\s+homicides?)`;
const FIREARM = String.raw`(?:firearms?|guns?|handguns?|rifles?|shotguns?|pistols?|revolvers?|gunfire|gunshots?|gun\s*shots?)`;
const KNIFE = String.raw`(?:knife|knives|cutting\s+instruments?|blades?|stabb?(?:ing|ings|ed)?|stabs)`;
const BLUNT = String.raw`(?:blunt\s+objects?|blunt\s+instruments?|clubs?|hammers?|bats?|baseball\s+bats?)`;
const PERSONAL = String.raw`(?:personal\s+weapons?|hands|fists?|feet|beat(?:en|ing|ings)?|bare\s+hands)`;
const STRANGLE = String.raw`(?:strangulation|strangl(?:ed|ing)|choked|choking)`;
const ASPHYX = String.raw`(?:asphyxiation|asphyxiated|suffocat(?:ion|ed)|drown(?:ing|ed))`;
const FIRE = String.raw`(?:arson|fire|burn(?:ed|ing)?)`;
const DRUGS = String.raw`(?:narcotics?|drugs?|overdoses?)`;
const POISON = String.raw`(?:poison(?:ing|ed)?)`;
const EXPLOSIVE = String.raw`(?:explosives?|bombs?)`;
const WEAPON_WORD = String.raw`(?:(?:${UNKNOWN})?(?:${FIREARM}|${KNIFE}|${BLUNT}|${PERSONAL}|${STRANGLE}|${ASPHYX}|${FIRE}|${DRUGS}|${POISON}|${EXPLOSIVE}|weapons?))`;
const SHOOT = String.raw`(?:(?:fatal\s+|non[-\s]?fatal\s+|nonfatal\s+)?shootings?|(?:people\s+)?shot(?:\s+(?:dead|and\s+killed|to\s+death))?|gun\s+violence)`;
const WEAPON_CONNECTOR = String.raw`(?:via|using|by\s+means\s+of|with|by|from|involving|involved|committed\s+with|killed\s+with|killed\s+by|caused\s+by)`;
const STOPWORD = String.raw`(?:in|for|during|from|since|of|at|on|and|or|to|by|with|the|a|an)`;

const RELATIONSHIP = String.raw`(?:wi(?:fe|ves)|husbands?|spouses?|ex[-\s]?(?:wi(?:fe|ves)|husbands?|spouses?|partners?)|common[-\s]law\s+(?:wi(?:fe|ves)|husbands?)|girlfriends?|boyfriends?|(?:intimate\s+|romantic\s+|dating\s+|same[-\s]sex\s+)?partners?|mothers?|fathers?|parents?|sons?|daughters?|brothers?|sisters?|siblings?|in[-\s]laws?|step(?:father|mother|son|daughter|parent|child)s?|family(?:\s+members?)?|relatives?|neighbou?rs?|acquaintances?|friends?|employees?|employers?|co[-\s]?workers?|bosse?s?|strangers?|someone\s+(?:they|he|she)\s+knew|people\s+(?:they|he|she)\s+knew|known\s+(?:to\s+(?:the\s+)?victims?|persons?|people)|homosexual\s+relationships?|lovers?)`;
const RELATIONSHIP_PREFIX = String.raw`(?:(?:killed|murdered|slain|committed|perpetrated)\s+by\s+(?:an?\s+|the\s+|their\s+|his\s+|her\s+)?|by\s+(?:an?\s+|their\s+|his\s+|her\s+)|(?:of|involving|among|between)\s+(?:their\s+|his\s+|her\s+)?|victim[-\s]offender\s+|(?:with\s+)?(?:an?\s+)?${UNKNOWN})`;
const CIRCUMSTANCE = String.raw`(?:gang(?:[-\s]related|land)?(?:\s+killings?)?|juvenile\s+gang|robber(?:y|ies)|burglar(?:y|ies)|larceny|motor\s+vehicle\s+theft|rapes?|sex(?:ual)?\s+offenses?|drug[-\s]related|drug\s+deals?|narcotics?\s+(?:law|deals?)|arguments?|brawls?|fights?|lovers?['’]?\s+triangle|felon(?:y|ies)(?:[-\s]type)?|felons?|justifiable|self[-\s]defen[cs]e|killed\s+by\s+(?:police|(?:a\s+|an\s+)?officers?|law\s+enforcement|(?:a\s+)?private\s+citizens?)|police\s+(?:killings?|shootings?)|(?:a\s+)?private\s+citizens?|domestic(?:\s+violence)?|negligen(?:t|ce)|accidental|sniper|institutional|prostitution|gambling|child\s+killed\s+by\s+babysitter|circumstances?|motives?)`;
const SEX = String.raw`(?:males?[-\s]to[-\s]females?|females?[-\s]to[-\s]males?|males?|females?|men|women|man|woman|boys?|girls?|sex|gender)`;
const RACE = String.raw`(?:black|african[-\s]american|white|asian(?:[-\s](?:american|pacific\s+islander))?|pacific\s+islanders?|american\s+indians?|native\s+americans?|alaska(?:n)?\s+natives?|hispanics?|latin[oa]s?|latinx|non[-\s]hispanic|race|racial|ethnicit(?:y|ies)|races)`;
const DEMOGRAPHIC_PREFIX = String.raw`(?:(?:of|among|for|against|involving|where)\s+(?:the\s+)?|(?:who|that)\s+(?:were|are|was|is)\s+|were\s+|(?:with\s+)?(?:an?\s+)?${UNKNOWN})`;
const AGE_WORD = String.raw`(?:child(?:ren)?|kids?|infants?|babies|baby|toddlers?|juveniles?|minors?|teen(?:ager)?s?|youths?|young\s+(?:people|adults|men|women)|adolescents?|adults?|elderly|seniors?|older\s+(?:adults|people)|ages?|aged|median\s+age|average\s+age|mean\s+age)`;
const AGE_NUMERIC = String.raw`(?:(?:under|over|above|below|younger\s+than|older\s+than|at\s+least|less\s+than|more\s+than)\s+(?:the\s+)?age\s+(?:of\s+)?\d{1,3}|(?:under|over|above|below|younger\s+than|older\s+than|at\s+least|less\s+than|more\s+than)\s+\d{1,3}\s*(?:years?(?:\s+old)?|yrs?)|(?<=\b(?:child(?:ren)?|kids?|infants?|teens?|teenagers?|juveniles?|minors?|youths?|adults?|people|persons|victims?|offenders?|suspects?|killers?)\s+)(?:under|over|above|below|younger\s+than|older\s+than|at\s+least|less\s+than|more\s+than)\s+\d{1,3}(?![\d,k])|aged?\s+\d{1,3}(?:\s*(?:-|to|through|and)\s*\d{1,3})?(?:\s*(?:years?(?:\s+old)?))?|\d{1,3}\s*(?:-|to)\s*\d{1,3}[-\s]year[-\s]olds?|\d{1,3}[-\s]year[-\s]olds?|(?:between\s+)?(?:the\s+)?ages?\s+(?:of\s+)?\d{1,3}\s*(?:-|to|and)\s*\d{1,3})`;
const ROLE_OFFENDER = String.raw`(?:offenders?|killers?|murderers?|suspects?|perpetrators?|assailants?|shooters?)`;
const ROLE_VICTIM = String.raw`(?:victims?|victimized)`;
const UNIT = String.raw`(?:incidents?|cases?|events?|people|persons?|individuals?|residents?|counts?|numbers?|totals?|figures?|tally|tallies|amount)`;
const PRESENTATION = String.raw`(?:data|stats|statistics|info(?:rmation)?|chart|graph|table|breakdown|summary|list|report|records?|map|results?)`;
// "multiple-victim incidents" is one situation phrase: its "incidents" names the situation, not a count unit.
const SITUATION = String.raw`(?:(?:multiple[-\s]victims?|single[-\s]victims?|multiple[-\s]offenders?|single[-\s]offenders?)(?:\s+(?:incidents?|cases?|killings?|homicides?))?|mass\s+(?:killings?|murders?|shootings?)|double\s+(?:homicides?|murders?)|triple\s+(?:homicides?|murders?))`;
// Numeric thresholds first, so "minimum of 30" is one part rather than "minimum" plus residue.
const STATISTIC = String.raw`(?:min(?:imum)?\s+(?:of\s+)?\d[\d,]*k?|max(?:imum)?\s+(?:of\s+)?\d[\d,]*k?|at\s+least\s+\d[\d,]*k?|at\s+most\s+\d[\d,]*k?|more\s+than\s+\d[\d,]*k?|fewer\s+than\s+\d[\d,]*k?|less\s+than\s+\d[\d,]*k?|over\s+\d[\d,]*k?|under\s+\d[\d,]*k?|above\s+\d[\d,]*k?|below\s+\d[\d,]*k?|\d[\d,]*k?\+|>\s*=?\s*\d[\d,]*k?|<\s*=?\s*\d[\d,]*k?|top\s+\d+|bottom\s+\d+|rates?|per\s+capita|per\s+100(?:,?000|k)|per\s+\d[\d,]*(?:\s+(?:people|residents|population|persons))?|percent(?:age)?s?|%|shares?|proportions?|ratios?|fractions?|averages?|mean|median|most|least|fewest|highest|lowest|largest|smallest|biggest|top|bottom|first|last|rank(?:ed|ing|ings|s)?|order(?:ed)?|sort(?:ed)?|maximum|minimum|record\s+high|record\s+low|peak|change[sd]?|changing|increase[sd]?|increasing|decrease[sd]?|decreasing|rise[ns]?|rising|rose|fall(?:s|en|ing)?|fell|drop(?:s|ped|ping)?|declin(?:e|ed|ing|es)|grew|grow(?:s|ing|th)|spikes?|surge[sd]?|higher|lower|more|less|fewer|difference|compare[ds]?|comparison|comparing|versus|vs\.?|year[-\s]?over[-\s]?year|yoy|how\s+many|how\s+much|population(?:s)?|side\s+by\s+side)`;
const BREAKDOWN = String.raw`(?:(?:broken\s+down|split|separated|seperated|grouped|disaggregated|categorized)\s+(?:out\s+)?by|by|per|for\s+each|each|every|across|among)\s+(?:the\s+)?(?:states?|count(?:y|ies)|parish(?:es)?|cit(?:y|ies)|agenc(?:y|ies)|regions?|weapons?(?:\s+types?)?|race|sex|gender|age(?:\s+groups?)?|ethnicit(?:y|ies)|relationships?|circumstances?|motives?|months?|years?|quarters?|decades?|type|types|situations?)`;
const ENTITY = String.raw`(?:states?|count(?:y|ies)|parish(?:es)?|cit(?:y|ies)|towns?|jurisdictions?|agenc(?:y|ies)|departments?|places?|areas?|regions?|metros?)`;
const POP_BAND = String.raw`(?:big|large|larger|major|small|smaller|mid[-\s]?sized?|medium[-\s]sized?|rural|urban|suburban)`;

/* ---- period fragments ---- */
const MONTH = String.raw`(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?`;
const YEAR = String.raw`(?:19|20)\d{2}`;
const PERIOD_PREFIX = String.raw`(?:in|for|during|from|since|between|through|thru|to|until|till|as\s+of|before|after|on|starting(?:\s+in)?|beginning(?:\s+in)?|over|across)`;
const PERIOD_CORE = String.raw`(?:(?:the\s+)?(?:end|beginning|start|middle)\s+of\s+(?:${MONTH}|${YEAR})|fiscal\s+years?(?:\s+${YEAR})?|(?:first|second|third|fourth|last|past|previous|prior|next|recent|latest|most\s+recent|trailing|rolling|full|whole|entire|calendar)\s+(?:\d+\s+|one\s+|two\s+|three\s+|four\s+|five\s+|six\s+|seven\s+|eight\s+|nine\s+|ten\s+|twelve\s+)?(?:complete\s+|full\s+|calendar\s+)?(?:years?|months?|quarters?|decades?|half|weeks?|days?)(?:\s+of)?|(?:this|current|last|previous|prior)\s+(?:year|month|quarter)|year[-\s]?to[-\s]?date|ytd|so\s+far(?:\s+this\s+year)?|to\s+date|currently|recently|right\s+now|today|now|present|ago|q[1-4](?:\s+${YEAR})?|(?:first|second|third|fourth)\s+quarter|h[12]|summers?|winters?|springs?|falls?|autumns?|holidays?|mid[-\s]?\d{4}|early\s+\d{4}|late\s+\d{4}|(?:19|20)\d0s|${MONTH}(?:\s*(?:-|to|through|thru)\s*${MONTH})?(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+${YEAR})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}[-.]\d{2}(?:[-.]\d{2})?|${YEAR}(?:\s*(?:-|–|to|through|thru|and|until)\s*(?:${YEAR}|present|now|today))?|each\s+year|every\s+year|per\s+year|by\s+year|yearly|annual(?:ly)?|year[-\s]by[-\s]year|monthly|by\s+month|per\s+month|each\s+month|month[-\s]by[-\s]month|over\s+time|trends?|historically|history|all\s+(?:available\s+)?years|all\s+time|years?|months?)`;
const PERIOD = String.raw`(?:${PERIOD_PREFIX}\s+)?(?:the\s+)?${PERIOD_CORE}(?:\s+of\s+(?:each|every)\s+year)?`;

/** Ordered rules: earlier, longer and more specific first. Overlaps are refused by the ledger. */
const EARLY_RULES: Rule[] = [
  {
    concept: "non-restriction", state: "context",
    pattern: R(String.raw`\b(?:regardless|irrespective)\s+of\s+(?:(?:the|their|a|any)\s+)?(?:(?:victims?|offenders?)['’]?s?\s+)?(?:immigration|citizenship|legal|residency)[-\s]status\b`),
  },
  // Not recorded (retained evidence): immigration or citizenship status, with its restricting connector.
  {
    concept: "immigration-status", state: "not-recorded", explanation: SHR_IMMIGRATION_NOT_RECORDED,
    pattern: R(String.raw`\b(?:(?:limited\s+to|restricted\s+to|only(?:\s+for)?|just|among|of|for|who\s+(?:were|are|was|is)|that\s+(?:were|are|was|is)|where\s+(?:the\s+)?(?:victims?|offenders?)\s+(?:were|was|are|is)|by|involving|against)\s+)?(?:(?:the|an?)\s+)?(?:(?:legal|illegal|undocumented|documented|unauthorized|lawful(?:ly)?(?:\s+present)?|recent|new|foreign[-\s]born)\s+)*(?:immigrants?|migrants?|immigration[-\s]status|citizenship(?:[-\s]status)?|residency\s+status|legal\s+status|non[-\s]?citizens?|noncitizens?|(?:illegal\s+)?aliens?|undocumented(?:\s+(?:people|persons|individuals|residents))?|refugees?|asylum[-\s]seekers?|foreign[-\s](?:born|nationals?)|deportees?|visa\s+holders?|green[-\s]card\s+holders?|(?:u\.?s\.?\s+)?citizens?)(?:\s+(?:status|victims?|offenders?|suspects?|killers?))?\b`),
  },
  // A named non-SHR agency as the source of the count: it cannot be identified as an SHR reporter.
  {
    concept: "reporting-agency",
    pattern: R(String.raw`\b(?:(?:as\s+)?(?:reported|recorded|investigated|documented|counted|logged|tracked|committed|carried\s+out)\s+by|according\s+to|per\s+the|from\s+the|by)\s+(?:the\s+)?(?:u\.?s\.?\s+)?(?:immigration\s+and\s+customs\s+enforcement|customs\s+and\s+border\s+protection|ICE|CBP|DEA|ATF|DHS|homeland\s+security|border\s+patrol|federal\s+(?:government|agencies)|CDC|medical\s+examiners?|coroners?|hospitals?)\b`),
    notInterpreted: (text) => shrAgencyNotInterpreted(text.replace(/^(?:(?:as\s+)?(?:reported|recorded|investigated|documented|counted|logged|tracked|committed|carried\s+out)\s+by|according\s+to|per\s+the|from\s+the|by)\s+/i, "")),
  },
];

/** Court-process and policy topics (evidence: the accepted capability statement, lib/source-capabilities.ts). */
const POLICY_TOPIC = /\b(?:GARS|GVRS|gun\s+violence\s+restraining|red\s+flag\s+laws?)\b/i;
const COURT_POLICY_RULE: Rule = {
  concept: "court-policy", state: "not-recorded", explanation: COURT_POLICY_TOPIC_MESSAGE,
  pattern: R(String.raw`\b(?:(?:the|their|a)\s+)?(?:prosecutions?|prosecuted|convictions?|convicted|sentences?|sentenced|sentencing|incarceration|incarcerated|prison\s+population|jail\s+population|prisons?|jails?|fines|fees|bail|defendants?|court\s+outcomes?|GARS|GVRS|gun\s+violence\s+restraining(?:\s+orders?)?|red\s+flag\s+laws?)\b`),
};

const RULES: Rule[] = [
  // The source itself: SHR is the FBI's dataset. Naming it is context, never a restriction.
  { concept: "source", state: "context", pattern: R(String.raw`\b(?:(?:according\s+to|from|per|in|using)\s+)?(?:the\s+)?(?:FBI(?:['’]s)?(?:\s+(?:data|SHR|UCR))?|supplementary\s+homicide\s+reports?|SHR(?:\s+data)?|homicide\s+reports?(?:\s+(?:data|tab))?|UCR)\b`) },
  // Questions about the data itself (completeness, coverage, availability): the metadata paths own them.
  { concept: "metadata", value: lower, pattern: R(String.raw`\b(?:complete(?:ness)?(?!\s+(?:years?|months?|quarters?)\b)|incomplete|coverage|cover(?:s|ed)?|available|availability|missing|gaps?|participat(?:e|es|ed|ing|ion)|how\s+far\s+back(?:\s+(?:does|do|did)\s+(?:the\s+)?(?:data|it|shr|this)\s+go)?|go(?:es)?\s+back|up\s+to\s+date|updated?|lag(?:s|ged)?|delay(?:s|ed)?|data\s+quality|quality|reliab(?:le|ility)|accura(?:te|cy)|reporting(?:\s+rates?)?|report(?:s|ed)?\s+(?:data|to\s+(?:the\s+)?fbi)|includ(?:e|es|ed)|exist(?:s)?)\b`) },
  { concept: "measure", value: lower, pattern: R(String.raw`\b${NON_NEGLIGENT}\b`) },
  { concept: "situation", value: lower, pattern: R(String.raw`\b${SITUATION}\b`) },
  // Weapon with an instrument connector: a known weapon word is a weapon; an unknown word is
  // claimed and fails as not-interpreted (murder via banana).
  { concept: "weapon", value: (m) => m[1] ?? null, pattern: R(String.raw`\b${WEAPON_CONNECTOR}\s+(?:(?:an?|the|their|his|her)\s+)?(${WEAPON_WORD}(?:\s+${WEAPON_WORD})?)\b`) },
  {
    concept: "weapon", notInterpreted: shrWeaponNotInterpreted,
    pattern: R(String.raw`\b(?:via|using|by\s+means\s+of|committed\s+with|killed\s+with)\s+(?:(?:an?|the|their|his|her)\s+)?(?!${STOPWORD}\b)[A-Za-z][\w'-]*(?:\s+(?!${STOPWORD}\b)[A-Za-z][\w'-]*)?`),
  },
  { concept: "weapon", value: lower, pattern: R(String.raw`\b${SHOOT}\b`) },
  { concept: "weapon", value: lower, pattern: R(String.raw`\b${WEAPON_WORD}(?:[-\s](?:related|involved|caused))?(?:\s+(?:types?|categor(?:y|ies)))?\b`) },
  // r5 §3: a number directly after a threshold phrase ("at most 2000 homicides") is the threshold's amount, never a year.
  { concept: "period", value: (m) => m[0], pattern: R(String.raw`(?<![\w/-])(?<!\b(?:at\s+least|at\s+most|more\s+than|fewer\s+than|less\s+than|under|above|below|min(?:imum)?(?:\s+of)?|max(?:imum)?(?:\s+of)?)\s+)${PERIOD}(?![\w/])`) },
  { concept: "breakdown", value: lower, pattern: R(String.raw`\b${BREAKDOWN}\b`) },
  { concept: "relationship", value: lower, pattern: R(String.raw`\b(?:${RELATIONSHIP_PREFIX})?(?:${RELATIONSHIP}|relationships?)(?:\s+(?:to|with)\s+(?:the\s+)?(?:victims?|offenders?|killers?))?\b`) },
  { concept: "circumstance", value: lower, pattern: R(String.raw`\b(?:(?:during|in|from|over|due\s+to|related\s+to|in\s+the\s+course\s+of|as\s+part\s+of)\s+(?:an?\s+|the\s+)?|${UNKNOWN})?${CIRCUMSTANCE}(?:[-\s]related)?\b`) },
  { concept: "age", value: lower, pattern: R(String.raw`\b(?:${DEMOGRAPHIC_PREFIX})?${AGE_NUMERIC}(?![\w])|\b(?:${DEMOGRAPHIC_PREFIX})?${AGE_WORD}\b`) },
  { concept: "sex", value: lower, pattern: R(String.raw`\b(?:${DEMOGRAPHIC_PREFIX})?${SEX}\b`) },
  { concept: "race", value: lower, pattern: R(String.raw`\b(?:${DEMOGRAPHIC_PREFIX})?${RACE}\b`) },
  { concept: "statistic", value: lower, pattern: R(String.raw`(?<![\w])${STATISTIC}(?![\w])`) },
  { concept: "role", value: () => "offender", pattern: R(String.raw`\b(?:committed\s+by|perpetrated\s+by|of\s+|by\s+)?(?:the\s+)?${ROLE_OFFENDER}\b`) },
  { concept: "role", value: () => "victim", pattern: R(String.raw`\b(?:of\s+|among\s+)?(?:the\s+)?${ROLE_VICTIM}\b`) },
  { concept: "measure", value: lower, pattern: R(String.raw`\b(?:(?:people|persons|individuals)\s+(?:were\s+|was\s+|who\s+were\s+)?)?${MEASURE}\b`) },
  { concept: "agency-type", value: lower, pattern: R(String.raw`\b(?:sheriff(?:['’]s)?(?:\s+(?:offices?|departments?))?|sheriffs|police\s+departments?|police|pd|county\s+agenc(?:y|ies)|city\s+agenc(?:y|ies)|countywide(?:\s+total)?|county[-\s]wide|unincorporated)\b`) },
  { concept: "population-band", value: lower, pattern: R(String.raw`\b${POP_BAND}\s+(?=${ENTITY}\b)`) },
  // Case-sensitive national abbreviations, then any-case national words.
  { concept: "national", value: () => "US", pattern: R(String.raw`(?<![A-Za-z.])(?:U\.S\.A?\.?|USA|US)(?![A-Za-z])`, "g") },
  { concept: "national", value: () => "US", pattern: R(String.raw`\b(?:national(?:ly)?|nationwide|countrywide|united\s+states|america|american|all\s+(?:50\s+)?states|the\s+(?:nation|country))\b`) },
  { concept: "entity", value: lower, pattern: R(String.raw`\b(?:(?:which|what)\s+(?:\d+\s+)?|across\s+(?:all\s+)?(?:the\s+)?|all\s+)?${ENTITY}\b`) },
  { concept: "unit", value: lower, pattern: R(String.raw`\b(?:the\s+)?(?:total\s+)?${UNIT}(?:\s+of)?\b`) },
  { concept: "presentation", state: "context", pattern: R(String.raw`\b(?:(?:in|as)\s+(?:a\s+)?)?${PRESENTATION}(?:\s+(?:on|for|about))?\b`) },
  { concept: "connector", value: lower, pattern: R(String.raw`\b(?:limited\s+to|restricted\s+to|confined\s+to|only\s+for|just\s+for|among|and|or|versus|vs\.?|plus|but|not|excluding|except(?:\s+for)?|other\s+than|without|apart\s+from|aside\s+from|including|only|just|exclusively|both|either|neither|nor|all|any|every|total|overall|combined|together|altogether|separately|respectively)\b`) },
];

const STATE_CODES = Object.values(STATE_NAME_TO_ABBR as Record<string, string>).filter((code) => code !== "US");
const CODE = String.raw`(?:${STATE_CODES.join("|")})`;
/** Upper-case codes that are also ordinary English words: a place only in a place position. */
const WORDLIKE = /^(?:IN|OR|ME|OK|HI|OH|DE|LA|MA|PA|AL|ID|MO|CO|GA|WA|MI|SC|NE|NC|ND|SD)$/;

function recordAll(ledger: RequestLedger, rule: Rule): void {
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(ledger.question))) {
    if (m[0].length === 0) { pattern.lastIndex += 1; continue; }
    const raw = m[0];
    const lead = raw.length - raw.replace(/^\s+/, "").length;
    const text = raw.trim();
    const span: Span = [m.index + lead, m.index + lead + text.length];
    const recorded = ledger.record({
      concept: rule.concept,
      value: rule.value ? rule.value(m) : null,
      span,
      rule: rule.notInterpreted ? `${rule.concept}:not-interpreted` : `${rule.concept}${rule.state ? `:${rule.state}` : ""}`,
      state: rule.notInterpreted ? "not-interpreted" : rule.state,
      explanation: rule.notInterpreted ? rule.notInterpreted(text) : rule.explanation ?? null,
    });
    // A refused (overlapping) match must not swallow the text after its start: retry one character
    // on, so "What cities" refused at the opener still lets "cities" be claimed.
    if (!recorded) pattern.lastIndex = m.index + 1;
  }
}

function recordKnownAgencies(ledger: RequestLedger, knownAgency: (text: string) => boolean): void {
  const q = ledger.question;
  const AFTER = /\b(?:in|for|from|at|by)\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = AFTER.exec(q))) {
    const start = m.index + m[0].length;
    const words = q.slice(start).split(/(?=\s)/);
    let text = "";
    let best = "";
    for (let k = 0; k < Math.min(words.length, 6); k += 1) {
      const next = (text + words[k]);
      const bare = next.trim().replace(/[,.;:?!]+$/, "");
      if (/\b(?:in|since|from|during|by|and|or)$/i.test(bare.split(/\s+/).pop() ?? "") && k > 0) break;
      if (/\d/.test(bare)) break;
      text = next;
      if (knownAgency(bare)) best = bare;
    }
    if (best && !resolveGeoPlaces(best).mentions.some((m) => m.start === 0 && m.end >= best.trim().length)) ledger.record({ concept: "place", value: `agency:${best}`, span: [start, start + best.length], rule: "place:shr-agency" });
  }
}

function recordPlaces(ledger: RequestLedger): void {
  const q = ledger.question;
  const lead = q.length - q.replace(/^\s+/, "").length; // resolveGeoPlaces trims its input
  for (const mention of resolveGeoPlaces(q).mentions) {
    const top = mention.candidates[0];
    if (top && top.kind !== "county" && /^\s+(?:county|parish|borough)\b/i.test(q.slice(mention.end + lead))) continue;
    ledger.record({
      concept: "place",
      value: top ? `${top.kind}:${top.name}${top.state ? `, ${top.state}` : ""}` : mention.text,
      span: [mention.start + lead, mention.end + lead],
      rule: mention.requiresClarification ? "place:ambiguous" : "place",
    });
  }
  recordUnresolvedCounties(ledger);
  recordAgencyAfterPlace(ledger);
  recordStateCodes(ledger);
}

/** "<name> County/Parish" the catalog did not resolve: a place the county-scope path must resolve. */
function recordUnresolvedCounties(ledger: RequestLedger): void {
  const q = ledger.question;
  const COUNTY = /\b(?:[A-Za-z][\w.'-]*\s+){1,2}(?:county|parish|borough)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = COUNTY.exec(q))) {
    let start = m.index;
    const words = m[0].split(/\s+/);
    if (PLACE_PREPOSITION.test(words[0]) || /^(?:the|of|and|or|homicides?|murders?|victims?|killings?|shootings?)$/i.test(words[0])) start += words[0].length + 1;
    if (ledger.record({ concept: "place", value: null, span: [start, m.index + m[0].length], rule: "place:unresolved-county" })) continue;
    COUNTY.lastIndex = m.index + 1;
  }
}

/** Postal codes: any case right after a recorded place or its agency words ("baldwin county al",
 * "Sheriff's Office, AL"); upper case after a place preposition; upper case anywhere when it is not
 * also an English word. */
function recordStateCodes(ledger: RequestLedger): void {
  const q = ledger.question;
  const afterPlace = (index: number) => ledger.parts.some((p) => (p.concept === "place" || p.concept === "agency-type") && /^,?\s+$/.test(q.slice(p.span[1], index)));
  const afterPreposition = (index: number) => /\b(?:in|for|across|within|throughout)\s+$/i.test(q.slice(0, index));
  const codes = R(String.raw`(?<![A-Za-z])${CODE}(?![A-Za-z])`, "gi");
  let m: RegExpExecArray | null;
  while ((m = codes.exec(q))) {
    const upper = m[0] === m[0].toUpperCase();
    // After a place, a lower-case code that is also an English word ("in", "or", "me") is that word.
    const ok = (afterPlace(m.index) && (upper || !WORDLIKE.test(m[0].toUpperCase()) || m[0].toLowerCase() === "al"))
      || (upper && (afterPreposition(m.index) || !WORDLIKE.test(m[0])));
    if (!ok) continue;
    ledger.record({ concept: "place", value: `state:${m[0].toUpperCase()}`, span: [m.index, m.index + m[0].length], rule: "place:state-code" });
  }
}

/** "<place> police/PD/sheriff": the agency words belong to the place. */
function recordAgencyAfterPlace(ledger: RequestLedger): void {
  const q = ledger.question;
  const AGENCY_AFTER_PLACE = /^\s+(?:police(?:\s+department)?|pd|sheriff(?:['’]s)?(?:\s+(?:office|department))?|county\s+sheriff)\b/i;
  for (const part of ledger.parts.filter((p) => p.concept === "place")) {
    const after = AGENCY_AFTER_PLACE.exec(q.slice(part.span[1]));
    if (after) {
      const start = part.span[1] + (after[0].length - after[0].replace(/^\s+/, "").length);
      ledger.record({ concept: "agency-type", value: after[0].trim().toLowerCase(), span: [start, part.span[1] + after[0].length], rule: "agency-after-place" });
    }
  }
}

/** "reported by <recorded place>" is a reporting-agency part over that place; any other agency stays unknown. */
function recordReportedBy(ledger: RequestLedger): void {
  const q = ledger.question;
  const REPORTED_BY = /\b(?:(?:as\s+)?(?:reported|recorded|investigated|documented|counted|logged|tracked)\s+by|according\s+to)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = REPORTED_BY.exec(q))) {
    const span: Span = [m.index, m.index + m[0].length];
    if (ledger.overlaps(span)) continue;
    const nextPlace = ledger.parts.find((p) => p.concept === "place" && p.span[0] >= span[1] && /^\s*(?:the\s+)?$/i.test(q.slice(span[1], p.span[0])));
    if (nextPlace) {
      ledger.record({ concept: "reporting-agency", value: nextPlace.value, span, rule: "reported-by-place" });
    }
    // Otherwise left for the vocabulary ("reported by sheriffs" = agency-type) or residue.
  }
}

/**
 * Account for an SHR request. Returns a FINALIZED ledger: every non-space character belongs to a
 * part. Recognition-time refusals are `ledger.refusedAtRecognition()`.
 */
export type ShrAccountingOptions = {
  /**
   * Earlier user turns (oldest first), passed ONLY when this turn is a follow-up that no planner
   * reconstructed. Their conditions carry forward unless this turn states the same kind of
   * condition (a new year replaces the old year; a new place replaces the old place).
   */
  earlierTurns?: string[];
  /**
   * Is this text a reporting agency SHR records? The route answers from shr_agency_alias; offline
   * callers may omit it, and an unknown name then falls to the unresolved-place rule.
   */
  knownAgency?: (text: string) => boolean;
};

const REPORTED_PREFIX = /^(?:(?:as\s+)?(?:reported|recorded|investigated|documented|counted|logged|tracked)\s+by|according\s+to)\s*/i;
const PLACE_PREPOSITION = /^(?:in|for|from|at|within|inside|around|near)$/i;

/** Maximal runs of residue words, split where a recorded part intervenes. */
function residueRuns(ledger: RequestLedger): { start: number; end: number; words: { text: string; span: Span }[] }[] {
  const q = ledger.question;
  const out: { start: number; end: number; words: { text: string; span: Span }[] }[] = [];
  for (const piece of ledger.residue()) {
    const last = out[out.length - 1];
    if (last && /^\s*$/.test(q.slice(last.end, piece.span[0]))) {
      last.words.push(piece);
      last.end = piece.span[1];
    } else {
      out.push({ start: piece.span[0], end: piece.span[1], words: [piece] });
    }
  }
  return out;
}

/**
 * Words standing where a place stands -- after a place preposition, or a capitalized name of up to
 * four words, or a run the route's agency index knows -- are a place the planners must resolve.
 * They are RECOGNIZED as `place` with rule `place:unresolved` (or `place:shr-agency`), so the path
 * that owns the request gives its own "I couldn't find X" wording; a planner that answers without
 * resolving them leaves them `not-applied-here`, which blocks the number.
 */
function recordUnresolvedPlaces(ledger: RequestLedger, opts: ShrAccountingOptions): void {
  const q = ledger.question;
  for (const piece of ledger.residue()) {
    const glued = ledger.parts.find((p) => p.concept === "place" && (p.span[1] === piece.span[0] || p.span[0] === piece.span[1]));
    if (glued && /[A-Za-z]/.test(piece.text) && !/\d/.test(piece.text)) ledger.record({ concept: "place", value: null, span: piece.span, rule: "place:unresolved-fragment" });
  }
  for (const run of residueRuns(ledger)) {
    let words = run.words;
    const preposition = PLACE_PREPOSITION.test(words[0].text) || PLACE_PREPOSITION.test((/(\S+)\s*$/.exec(q.slice(0, run.start)) ?? [])[1] ?? "");
    if (PLACE_PREPOSITION.test(words[0].text)) words = words.slice(1);
    while (words.length > 0 && /^(?:the|a|an|of|and|or)$/i.test(words[0].text)) words = words.slice(1);
    if (words.length === 0 || words.length > 4 || words.some((w) => /\d/.test(w.text))) continue;
    const text = q.slice(words[0].span[0], words[words.length - 1].span[1]);
    const agency = opts.knownAgency?.(text) ?? false;
    const capitalized = words.every((w) => /^[A-Z]/.test(w.text)) && !words.every((w) => isCommonEnglishWord(w.text.toLowerCase()));
    if (!agency && !preposition && !capitalized) continue;
    ledger.record({ concept: "place", value: null, span: [words[0].span[0], words[words.length - 1].span[1]], rule: agency ? "place:shr-agency" : "place:unresolved" });
  }
}

export function accountShrRequest(question: string, opts: ShrAccountingOptions = {}): RequestLedger {
  const ledger = new RequestLedger(question);
  recordContext(ledger);
  // Not-recorded and named-agency rules first: their connectors must not be claimed by others.
  for (const rule of EARLY_RULES) recordAll(ledger, rule);
  if (mayRefuseAsCourtProcess(question) || POLICY_TOPIC.test(question)) recordAll(ledger, COURT_POLICY_RULE);
  if (opts.knownAgency) recordKnownAgencies(ledger, opts.knownAgency);
  recordPlaces(ledger);
  recordReportedBy(ledger);
  for (const rule of RULES) recordAll(ledger, rule);
  const q = ledger.question;
  // "reported by <agency-type>" ("reported by sheriffs") is a recognized reporting agency of that type.
  const REPORTED = /\b(?:(?:as\s+)?(?:reported|recorded|investigated|documented|counted|logged|tracked)\s+by|according\s+to)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = REPORTED.exec(q))) {
    const span: Span = [m.index, m.index + m[0].length];
    if (ledger.overlaps(span)) continue;
    const next = ledger.parts.find((p) => p.concept === "agency-type" && p.span[0] >= span[1] && /^\s*(?:the\s+)?$/i.test(q.slice(span[1], p.span[0])));
    if (next) ledger.record({ concept: "reporting-agency", value: next.value, span, rule: "reported-by-agency-type" });
  }
  recordUnresolvedPlaces(ledger, opts);
  recordAgencyAfterPlace(ledger);
  recordStateCodes(ledger);
  // "reported by <words>" still unrecorded: an agency that could not be identified.
  const LEFT = /\b(?:(?:as\s+)?(?:reported|recorded|investigated|documented|counted|logged|tracked)\s+by|according\s+to)\s+(?:the\s+)?[A-Za-z][\w.'&-]*(?:\s+[A-Za-z][\w.'&-]*){0,4}/gi;
  while ((m = LEFT.exec(q))) {
    // Trim to the first already-recorded character, so only unrecorded agency words are claimed.
    let end = m.index + m[0].length;
    for (let i = m.index; i < end; i += 1) if (ledger.overlaps([i, i + 1])) { end = i; break; }
    const text = q.slice(m.index, end).replace(/\s+$/, "");
    const agencyWords = text.replace(REPORTED_PREFIX, "").replace(/^the\s+/i, "");
    if (!agencyWords) continue;
    if (ledger.record({ concept: "reporting-agency", span: [m.index, m.index + text.length], rule: "reporting-agency:not-interpreted", state: "not-interpreted", explanation: shrAgencyNotInterpreted(agencyWords) })) {
      LEFT.lastIndex = m.index + text.length;
    }
  }
  recordBetweenFiller(ledger);
  ledger.finalize();
  if (opts.earlierTurns && opts.earlierTurns.length > 0 && isFollowupFragment(ledger)) {
    const earlier = opts.earlierTurns.slice(-3);
    const prior = accountShrRequest(earlier[earlier.length - 1], { knownAgency: opts.knownAgency, earlierTurns: earlier.slice(0, -1) });
    const own = ledger.parts.filter((p) => !p.inherited && p.state !== "context");
    const restated = new Set(own.filter((p) => !isBreakdownPart(p)).map((p) => p.concept));
    const regrouped = new Set(own.filter(isBreakdownPart).map(breakdownDimension));
    ledger.inherit(prior.parts.filter((p) => p.state !== "context"
      && (isBreakdownPart(p) ? !regrouped.has(breakdownDimension(p)) : !restated.has(p.concept))));
  }
  return ledger;
}

/** A part that groups the answer rather than restricting it ("by year", "by weapon", "monthly"). */
export function isBreakdownPart(p: Part): boolean {
  if (p.concept === "breakdown") return true;
  const t = p.text.toLowerCase();
  if (p.concept === "period") return /\b(?:by|per|each|every)\s+(?:year|month|quarter)\b|monthly|yearly|annual(?:ly)?|year[-\s]by[-\s]year|month[-\s]by[-\s]month|over\s+time|trends?/.test(t) && !/\b(?:19|20)\d{2}\b/.test(t) && !/of\s+(?:each|every)\s+year/.test(t);
  return /\b(?:by|per|each|every|across|broken\s+down|split|separated|seperated|grouped)\b/.test(t) && /(?:weapons?|types?|race|races|sex|gender|ages?|age\s+groups?|relationships?|circumstances?|motives?|ethnicit(?:y|ies))$/.test(t);
}

/** What a breakdown groups by, so a new grouping replaces an old one of the same dimension only. */
function breakdownDimension(p: Part): string {
  const t = p.text.toLowerCase();
  // Time groupings (by month, by year, by quarter) are one dimension: a new one replaces the old one.
  return p.concept === "period" || /month|year|annual|yearly|over time|trend|quarter/.test(t) ? "time" : p.concept;
}

/** A turn that states no measure of its own ("what about 2024?", "and for women?") leans on the turn before it. */
function isFollowupFragment(ledger: RequestLedger): boolean {
  const own = ledger.parts.filter((p) => !p.inherited && p.state !== "context");
  return !own.some((p) => p.concept === "measure" || p.concept === "weapon" || p.concept === "metadata")
    || ledger.parts.some((p) => p.rule === "followup-opener");
}

/* ================================================================== *
 * Planner binding (task 4): what an OWNING path's plan actually applies
 * ================================================================== */

/** Parts every answering path carries without restricting anything. */
const TRANSPARENT = new Set(["source"]);
const COUNT_STATISTIC = /^(?:how\s+many|how\s+much|numbers?|totals?|counts?)$/i;
const SINGLE_YEAR = /^(?:(?:in|for|during)\s+)?(?:the\s+)?(?:year\s+)?(?:19|20)\d{2}$/i;
const THROUGH_MONTH = /^(?:through|thru|to|until)\s+(?:the\s+end\s+of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?(?:\s+of\s+(?:each|every)\s+year)?$/i;
const MONTHLY = /^(?:monthly|by\s+month|per\s+month|each\s+month|month[-\s]by[-\s]month)$/i;

export const shrPart = {
  /** A victim (or neutral) unit -- never "incidents", which is a plan field. */
  victimUnit: (p: Part) => p.concept === "unit" && !/incidents?|cases?|events?/i.test(p.text),
  countStatistic: (p: Part) => p.concept === "statistic" && COUNT_STATISTIC.test(p.value ?? p.text),
  victimRole: (p: Part) => p.concept === "role" && p.value === "victim",
  /** A place the catalog, a postal code or the SHR agency index resolved. */
  resolvedPlace: (p: Part) => p.concept === "place" && (p.rule === "place" || p.rule === "place:state-code" || p.rule === "place:shr-agency"),
  /** Any place part whose words appear in one of the plan's own resolved labels. */
  placeIn: (labels: string[]) => {
    const keys = labels.map((l) => agencySearchKey(l));
    return (p: Part) => p.concept === "place" && keys.some((k) => {
      const t = agencySearchKey(p.text);
      return t.length > 0 && (k.includes(t) || t.split(" ").every((w) => k.split(" ").includes(w)));
    });
  },
  national: (p: Part) => p.concept === "national",
  singleYear: (p: Part) => p.concept === "period" && SINGLE_YEAR.test(p.text.trim()),
  throughMonth: (p: Part) => p.concept === "period" && THROUGH_MONTH.test(p.text.trim()),
  monthly: (p: Part) => p.concept === "period" && MONTHLY.test(p.text.trim()),
  anyPeriod: (p: Part) => p.concept === "period",
  measure: (re: RegExp) => (p: Part) => p.concept === "measure" && re.test(p.value ?? p.text),
  concept: (...names: string[]) => (p: Part) => names.includes(p.concept),
  connector: (re: RegExp) => (p: Part) => p.concept === "connector" && re.test(p.value ?? p.text),
};

/** The places an owned-count plan resolved, as labels a place part can be matched against. */
export function shrCountPlanPlaceLabels(plan: ShrCountPlan): string[] {
  const g = plan.geography;
  switch (g.kind) {
    case "cities": return g.places.map((p) => p.display);
    case "county": return [g.binding.label, `${g.binding.label}, ${g.binding.state}`];
    case "state": return [g.stateName, g.state];
    case "national": return ["United States"];
  }
}

/**
 * Would an owner whose plan applies `applies` cover EVERY non-context part? Pure: it never binds, so a
 * dispatcher can ask several owners in turn (Codex r2 #2 -- `bind` makes parts terminal).
 */
export function ledgerSatisfies(ledger: RequestLedger, applies: (part: Part) => boolean): boolean {
  return ledger.parts.every((p) => p.state === "context" || TRANSPARENT.has(p.concept) || (p.state === "recognized" && applies(p)));
}

/** Does the request restrict which records are counted (a victim, offender or incident condition, months, incidents)? */
export function shrHasRowRestriction(ledger: RequestLedger): boolean {
  return ledger.parts.some((p) => p.state !== "context" && (
    ["race", "relationship", "circumstance", "situation"].includes(p.concept)
    || (p.concept === "sex" && !/to[-\s]/i.test(p.text))
    || (p.concept === "age" && !/median|average|mean/i.test(p.text))
    || (p.concept === "weapon" && !/shoot|shot\b|gun violence/i.test(p.text))
    || (p.concept === "role" && p.value === "offender")
    || (p.concept === "unit" && /incidents?|cases?|events?/i.test(p.text))
    || (p.concept === "statistic" && /percent|share|proportion|fraction|%|median|average|mean/i.test(p.text))
    || (p.concept === "period" && /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\bq[1-4]\b|quarter/i.test(p.text))));
}

/** Does the request ask for a number at all (so it belongs to an owner that produces numbers)? */
export function shrNumericIntent(ledger: RequestLedger): boolean {
  return ledger.parts.some((p) => p.state !== "context" && ["measure", "weapon", "unit", "statistic", "role", "sex", "race", "age", "relationship", "circumstance", "situation"].includes(p.concept));
}

/** True when any of the predicates holds. */
export const anyOf = (...tests: ((p: Part) => boolean)[]) => (p: Part) => tests.some((t) => t(p));

/**
 * Bind the OWNING path's plan against the ledger (outcome 2 of the plan's three): every non-context
 * part of the clause it answers must be one the plan applies. Returns the terminal limitation
 * (outcome 3) naming each part it cannot apply, or null when the plan may answer.
 * Clause 0 only in stage 1 (one answer clause on SHR).
 */
export function bindShrPath(
  ledger: RequestLedger, pathLabel: string, applies: (part: Part) => boolean,
): { parts: Part[]; explanation: string } | null {
  ledger.bind(0, (p) => TRANSPARENT.has(p.concept) || applies(p), (p) =>
    `I can't apply "${p.text.trim()}"${p.inherited ? " (from your earlier question)" : ""} to this ${pathLabel}, so I haven't answered with a number that leaves it out.`);
  const blocking = ledger.blocking(0);
  if (blocking.length === 0) return null;
  return { parts: blocking, explanation: refusalSentences(blocking).join(" ") };
}

/**
 * The route's agency index: is this text an SHR reporting agency name (any state)? Read-only, one
 * indexed lookup per candidate; a missing table or any error answers false (unknown stays unknown).
 */
export function shrKnownAgencyIndex(db: Database.Database): (text: string) => boolean {
  let statement: Database.Statement | null = null;
  try {
    statement = db.prepare("SELECT 1 FROM shr_agency_alias WHERE alias_key = ? LIMIT 1");
  } catch {
    return () => false;
  }
  return (text: string) => {
    const key = agencySearchKey(text);
    if (key.length < 4) return false;
    try { return Boolean(statement!.get(key)); } catch { return false; }
  };
}

/** The recognition-time refusal for an SHR request, or null when nothing is refused before planning. */
export function shrRecognitionRefusal(ledger: RequestLedger): { parts: Part[]; explanation: string } | null {
  const parts = ledger.refusedAtRecognition();
  if (parts.length === 0) return null;
  const notRecorded = parts.filter((p) => p.state === "not-recorded");
  const notInterpreted = parts.filter((p) => p.state === "not-interpreted");
  const sentences = refusalSentences([...notRecorded, ...notInterpreted]);
  return { parts, explanation: sentences.join(" ") };
}
