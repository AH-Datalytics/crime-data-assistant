export interface CapabilityOverride {
  title: string;
  explanation: string;
  guardrail: string;
}

const HOMICIDE_RE = /\b(homicides?|murders?|killings?)\b/i;
const RATE_RE = /\b(rates?|per\s*capita|per\s*100\s*k|per\s*100,?000)\b/i;
const DEMOGRAPHIC_RE = /\b(gender|sex|race|racial|ethnicity|ethnic|female|male|women|men|black|white|hispanic|latino|asian|native|american\s+indian)\b/i;

const AGE_GROUP_RE = /\b(age\s+groups?|by\s+age|juveniles?|teens?|teenagers?|elderly|minors)\b/i;

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
  if (!RATE_RE.test(question)) return null;
  if (!DEMOGRAPHIC_RE.test(question) && !AGE_GROUP_RE.test(question)) return null;

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
