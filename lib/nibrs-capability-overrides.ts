import { resolveGeoPlaces } from "./geo-place-resolver";
import {
  DEMOGRAPHIC_RATE_UNSUPPORTED_MESSAGE,
  detectDemographicHomicideRateOverride,
  detectNibrsCountywideDemographicsOverride,
  detectSubCityGeographyOverride,
  hasGroupRateIntent,
  mentionsDemographicGroup,
  type CapabilityOverride,
} from "./capability-overrides";

function mentionsNibrsDemographicRateGroup(question: string): boolean {
  const mentions = resolveGeoPlaces(question).mentions;
  let normalized = question;
  for (const mention of [...mentions].sort((a, b) => b.start - a.start)) {
    normalized = normalized.slice(0, mention.start) + " " + normalized.slice(mention.end);
  }
  normalized = normalized.replace(/\bsex\s+(?:offenses?|crimes?)\b/gi, " ");
  if (!mentionsDemographicGroup(normalized)) return false;

  return /\bby\s+(?:race|racial\s+group|sex|gender|ethnicity|ethnic\s+group|age(?:\s+group)?)\b/i.test(normalized) ||
    /\b(?:among|for|of)\s+(?:female|male|women|men|black|white|hispanic|latino|asian|native|american\s+indian|juvenile|teen|minor)(?:\s+(?:people|persons|residents|victims|offenders|arrestees))?\b/i.test(normalized) ||
    /\b(?:juvenile|female|male|women|men|black|white|hispanic|latino|asian|native)\s+(?:crime|offense|victim|offender|arrest|homicide|murder)\s+rates?\b/i.test(normalized);
}

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
    mentionsNibrsDemographicRateGroup(question)
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
