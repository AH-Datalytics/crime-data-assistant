export interface CapabilityOverride {
  title: string;
  explanation: string;
  guardrail: string;
}

const HOMICIDE_RE = /\b(homicides?|murders?|killings?)\b/i;
const RATE_RE = /\b(rates?|per\s*capita|per\s*100\s*k|per\s*100,?000)\b/i;
const DEMOGRAPHIC_RE = /\b(gender|sex|race|racial|ethnicity|ethnic|female|male|women|men|black|white|hispanic|latino|asian|native|american\s+indian)\b/i;

const AGE_GROUP_RE = /\b(age\s+groups?|by\s+age|juveniles?|teens?|teenagers?|elderly|minors)\b/i;

/**
 * Per-capita/rate intent, shared by the SHR front door and the
 * group-rate-denominator-unavailable guardrail so the two nets can't drift
 * apart (CODEX_REVIEW_9577edc finding 1). Covers denominator variants
 * (per 1,000 / 10,000 / million), likelihood phrasings ("murder risk by
 * race", "how likely"), and population-relative phrasings.
 */
export const GROUP_RATE_INTENT_RE = new RegExp(
  [
    String.raw`per\s*capita`,
    String.raw`per\s*cap\b`,
    String.raw`per\s*1[0,.\s]*0{2,}\s*(?:k\b|people|persons|residents|population|men|women|males|females)?`,
    String.raw`per\s*(?:hundred|thousand|million)(?:\s+(?:thousand|people|persons|residents))?`,
    String.raw`\brates?\b`,
    String.raw`\brisk\b`,
    String.raw`\blikelihood\b`,
    String.raw`how\s+likely`,
    String.raw`\bodds\b`,
    String.raw`relative\s+to\s+(?:the\s+)?population`,
    String.raw`adjusted\s+for\s+population`,
    String.raw`population[-\s]adjusted`,
  ].join("|"),
  "i"
);

export function hasGroupRateIntent(question: string): boolean {
  return GROUP_RATE_INTENT_RE.test(question);
}

export function mentionsDemographicGroup(question: string): boolean {
  return DEMOGRAPHIC_RE.test(question) || AGE_GROUP_RE.test(question);
}

export function isDemographicHomicideRateQuestion(question: string): boolean {
  return HOMICIDE_RE.test(question) && RATE_RE.test(question) && DEMOGRAPHIC_RE.test(question);
}

/**
 * SHR-tab variant: every SHR question is about homicide, so requiring a
 * homicide word makes the check blind to follow-ups that drop it
 * ("i want ir in per capita seperated by race and sex", #4704-#4705,
 * query-audit-2026-07-03 F27). Rate + demographic-group language is enough.
 */
export function detectShrGroupRateOverride(question: string): CapabilityOverride | null {
  // Clearance-rate questions are about case outcomes, not population denominators —
  // let the shr-clearance-override give its redirect to Historical/NIBRS instead.
  if (/\b(clearance|cleared|solve[ds]?|unsolved|closure|close rate|cold case)\b/i.test(question)) return null;
  // Clearly non-SHR concepts (arrests, non-homicide offenses, staffing) should get
  // the accurate scope refusal from the existing SHR overrides, not a misleading
  // denominator explanation (CODEX_REVIEW_9577edc finding 2).
  if (/\b(arrests?|arrested|arrestees?|robber(?:y|ies)|burglar(?:y|ies)|thefts?|larcen(?:y|ies)|assaults?|rapes?|carjackings?|drugs?|narcotics?|dui|staffing|officers?\s+employed)\b/i.test(question)) return null;
  if (!hasGroupRateIntent(question)) return null;
  if (!mentionsDemographicGroup(question)) return null;

  return {
    title: "Demographic Homicide Rates",
    guardrail: "demographic-homicide-rate-denominator-unavailable",
    explanation:
      "I can't calculate per-capita homicide rates by race, sex/gender, or age from these datasets because they do not include matching population denominators for those groups. I can show homicide counts, shares, or breakdowns by victim or offender race, sex/gender, and age, or an overall per-capita rate using total population.",
  };
}

export function detectDemographicHomicideRateOverride(question: string): CapabilityOverride | null {
  if (!isDemographicHomicideRateQuestion(question)) return null;

  return {
    title: "Demographic Homicide Rates",
    guardrail: "demographic-homicide-rate-denominator-unavailable",
    explanation:
      "I can't calculate per-capita homicide rates by race or sex/gender from these datasets because they do not include matching population denominators by race and sex/gender for each requested geography and year. I can show homicide counts, shares, or breakdowns by victim race and sex/gender in the Homicide Reports data, and NIBRS can show victim or offender demographic counts where available.",
  };
}
