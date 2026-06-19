export interface CapabilityOverride {
  title: string;
  explanation: string;
  guardrail: string;
}

const HOMICIDE_RE = /\b(homicides?|murders?|killings?)\b/i;
const RATE_RE = /\b(rates?|per\s*capita|per\s*100\s*k|per\s*100,?000)\b/i;
const DEMOGRAPHIC_RE = /\b(gender|sex|race|racial|ethnicity|ethnic|female|male|women|men|black|white|hispanic|latino|asian|native|american\s+indian)\b/i;

export function isDemographicHomicideRateQuestion(question: string): boolean {
  return HOMICIDE_RE.test(question) && RATE_RE.test(question) && DEMOGRAPHIC_RE.test(question);
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
