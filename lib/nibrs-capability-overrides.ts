import {
  DEMOGRAPHIC_RATE_UNSUPPORTED_MESSAGE,
  detectDemographicHomicideRateOverride,
  detectNibrsCountywideDemographicsOverride,
  detectSubCityGeographyOverride,
  hasGroupRateIntent,
  mentionsDemographicGroup,
  type CapabilityOverride,
} from "./capability-overrides";

export function detectNibrsCapabilityOverride(question: string): CapabilityOverride | null {
  const subCityOverride = detectSubCityGeographyOverride(question);
  if (subCityOverride) return subCityOverride;

  const countywideDemographicsOverride = detectNibrsCountywideDemographicsOverride(question);
  if (countywideDemographicsOverride) return countywideDemographicsOverride;

  const demographicRateOverride = detectDemographicHomicideRateOverride(question);
  if (demographicRateOverride) return demographicRateOverride;
  if (
    !/\b(?:clearance|cleared|solve[ds]?|unsolved)\b/i.test(question) &&
    hasGroupRateIntent(question) &&
    mentionsDemographicGroup(question)
  ) {
    return {
      title: "Demographic Rate Not Available",
      guardrail: "demographic-rate-unsupported",
      explanation: DEMOGRAPHIC_RATE_UNSUPPORTED_MESSAGE,
    };
  }

  const q = question.toLowerCase();
  const asksUseOfForce =
    /\buse\s+of\s+force\b/i.test(q) ||
    /\bofficer\s+force\b/i.test(q) ||
    /\bpolice\s+force\b/i.test(q) ||
    /\bforce\s+used\s+by\s+(police|officers|law enforcement)\b/i.test(q);

  if (asksUseOfForce) {
    return {
      title: "NIBRS Use-of-Force Coverage",
      guardrail: "nibrs-use-of-force-unsupported",
      explanation:
        "No. NIBRS does not contain a general use-of-force field or officer use-of-force incident data. It can show reported offenses, victims, weapons, some circumstances, LEOKA victim records, and the narrow justifiable-homicide category where a criminal was killed by a police officer, but it cannot answer general police use-of-force questions.",
    };
  }

  return null;
}
