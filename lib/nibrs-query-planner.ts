import {
  buildNibrsClearanceMethodQuery,
  buildNibrsClearanceTypeBreakdownQuery,
  buildNibrsComparableAgencyClearanceQuery,
  buildNibrsDomesticViolenceAggravatedAssaultShareQuery,
  buildNibrsLocalCityOffenseCountQuery,
  buildNibrsLocalDemographicQuery,
  buildNibrsJuvenileOffenderIncidentQuery,
  buildNibrsStructuredLocalTrendQuery,
  asksForIncidentsWithJuvenileOffender,
  type DeterministicNibrsQuery,
} from "./nibrs-deterministic-queries";
import type { NibrsPlaceResolutionPlan, NibrsResolvedPlace } from "./nibrs-place-resolver";
import { buildNibrsJuvenileArrestsByRaceQuery, buildNibrsNationalArrestQuery } from "./nibrs-rollup-deterministic";
import { buildNibrsContinuousReporterQuery, buildNibrsCountywideDemographicQuery } from "./nibrs-scope-deterministic";
import { resolveNibrsRollupPath } from "./nibrs-rollup-router";

export type NibrsQueryPlan =
  | { kind: "blocked"; place: NibrsResolvedPlace; explanation: string }
  | { kind: "unavailable"; title: string; explanation: string }
  | { kind: "deterministic"; query: DeterministicNibrsQuery }
  | { kind: "model"; reason: "no-deterministic-builder" | "followup" };

function resolutionBlock(
  place: NibrsResolvedPlace,
  plan: NibrsPlaceResolutionPlan
): string {
  const comparisonSuffix = plan.places.length > 1 ? " in this comparison" : "";
  if (place.status === "covered") {
    return place.label + " has no active city-agency ORI for " + plan.startYear + "-" + plan.endYear + ". It may be inactive or served under a contract/coverage arrangement, but this database does not identify a covering agency that can be safely attributed to the city. I won't substitute countywide data or another agency" + comparisonSuffix + ".";
  }
  return "I found multiple possible NIBRS agencies for " + place.label + ". Please name the specific department or jurisdiction so I do not combine unrelated agencies" + comparisonSuffix + ".";
}

export function planNibrsQuery(
  question: string,
  resolutionPlan: NibrsPlaceResolutionPlan | null,
  options: { allowDeterministic: boolean; juvenileIncidentRollupAvailable?: boolean } = { allowDeterministic: true }
): NibrsQueryPlan {
  const blockingPlace = resolutionPlan?.places.find((place) =>
    place.status === "ambiguous" || place.status === "covered"
  );
  if (blockingPlace && resolutionPlan) {
    return {
      kind: "blocked",
      place: blockingPlace,
      explanation: resolutionBlock(blockingPlace, resolutionPlan),
    };
  }
  if (!options.allowDeterministic) return { kind: "model", reason: "followup" };

  if (asksForIncidentsWithJuvenileOffender(question) && !options.juvenileIncidentRollupAvailable) {
    return {
      kind: "unavailable",
      title: "Incident-Level Offender Age Is Not Yet Summarized",
      explanation: "NIBRS contains offender ages, but the live summary tables count offenders rather than distinct incidents. I cannot safely report how many violent-crime incidents had at least one offender under 18 without risking double-counting incidents with multiple offenses or offenders. I can report the number of offenders under 18 involved in violent offenses, or the number of violent-crime incidents without the offender-age condition.",
    };
  }

  const query =
    buildNibrsJuvenileOffenderIncidentQuery(question, resolutionPlan) ??
    buildNibrsJuvenileArrestsByRaceQuery(question, resolveNibrsRollupPath() !== null) ??
    buildNibrsNationalArrestQuery(question, resolveNibrsRollupPath() !== null) ??
    buildNibrsContinuousReporterQuery(question) ??
    buildNibrsCountywideDemographicQuery(question) ??
    buildNibrsComparableAgencyClearanceQuery(question, resolutionPlan) ??
    buildNibrsClearanceMethodQuery(question, resolutionPlan) ??
    buildNibrsClearanceTypeBreakdownQuery(question, resolutionPlan) ??
    buildNibrsLocalDemographicQuery(question, resolutionPlan) ??
    buildNibrsStructuredLocalTrendQuery(question, resolutionPlan) ??
    buildNibrsLocalCityOffenseCountQuery(question, resolutionPlan) ??
    buildNibrsDomesticViolenceAggravatedAssaultShareQuery(question);
  return query
    ? { kind: "deterministic", query }
    : { kind: "model", reason: "no-deterministic-builder" };
}
