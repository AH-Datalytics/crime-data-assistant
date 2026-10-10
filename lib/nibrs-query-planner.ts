import {
  buildNibrsClearanceMethodQuery,
  annualClearanceDeclineReason,
  asksAnnualClearanceFamily,
  buildNibrsAnnualClearanceQuery,
  buildNibrsClearanceTypeBreakdownQuery,
  buildNibrsComparableAgencyClearanceQuery,
  comparableAgencySubjectCheck,
  type SubjectRowCount,
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
import { planNibrsCityRanking, cityRankingFollowupUnavailable } from "./city-ranking-nibrs";
import { planNibrsAgencyPeriodRanking, recognizeAgencyPeriodRanking } from "./nibrs-agency-period-ranking";
import type { SourceCutoff } from "./city-ranking-builder";

export type NibrsQueryPlan =
  | { kind: "blocked"; place: NibrsResolvedPlace; explanation: string }
  | { kind: "unavailable"; title: string; explanation: string; reason?: string }
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

/** The peer-comparison shapes Decision 16 governs. */
function asksComparableAgencyComparison(question: string): boolean {
  const q = question ?? "";
  return /\b(?:similar(?:[-\s]+siz(?:e|ed)|ly[-\s]+sized)?|comparable|peer)\s+(?:agencies|departments|cities)\b/i.test(q)
    || /\b(?:agencies|cities|departments)\s+of\s+(?:similar|comparable)\s+size\b/i.test(q);
}

export function planNibrsQuery(
  question: string,
  resolutionPlan: NibrsPlaceResolutionPlan | null,
  options: {
    allowDeterministic: boolean;
    juvenileIncidentRollupAvailable?: boolean;
    /** Injected rather than imported: the facts module probes the databases at import time. */
    dataCutoff?: SourceCutoff | null;
    /** Injected in tests; production reads the clearance summary (comparableAgencySubjectCheck). */
    subjectRowCount?: SubjectRowCount;
  } = { allowDeterministic: true }
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
  /*
   * OWNERSHIP IS DECIDED BEFORE THE FOLLOW-UP SWITCH, NOT AFTER IT.
   *
   * `allowDeterministic: false` is a real route option -- an authoritative query-bearing follow-up,
   * or a follow-up transform -- and returning `model` on it first meant an owned yearly-clearance
   * request regained model-generated calculation simply by arriving as a follow-up. The family gate
   * below was unreachable for exactly the requests it exists to hold.
   *
   * Ordinary follow-ups are untouched: only an owned request is diverted here, and it is diverted
   * into an honest decline rather than into an answer this path cannot stand behind.
   */
  if (!options.allowDeterministic) {
    if (asksAnnualClearanceFamily(question)) return annualClearanceUnavailable(question, resolutionPlan);
    /*
     * The same rule for city rankings, and it was missing. A recognised ranking arriving as a
     * follow-up returned `model` from here, BEFORE the city-ranking builder below ever ran -- so
     * the family that exists to stop model-written rankings lost the request at the first branch.
     * Declined honestly instead; nothing here resolves the follow-up or answers it.
     */
    const ranking = cityRankingFollowupUnavailable(question);
    if (ranking) return ranking;
    // GC-091 batch: the same rule for the owned agency-period ranking -- declined, never handed to model SQL.
    if (recognizeAgencyPeriodRanking(question)) {
      return { kind: "unavailable", title: "Ranking Not Available", explanation: "I build this agency ranking myself rather than generating a query for it, and I can't do that as a follow-up to the previous answer. Ask the ranking as a standalone question — naming the period and how many agencies — and I'll build it." };
    }
    return { kind: "model", reason: "followup" };
  }

  if (asksForIncidentsWithJuvenileOffender(question) && !options.juvenileIncidentRollupAvailable) {
    return {
      kind: "unavailable",
      title: "Incident-Level Offender Age Is Not Yet Summarized",
      explanation: "NIBRS contains offender ages, but the live summary tables count offenders rather than distinct incidents. I cannot safely report how many violent-crime incidents had at least one offender under 18 without risking double-counting incidents with multiple offenses or offenders. I can report the number of offenders under 18 involved in violent offenses, or the number of violent-crime incidents without the offender-age condition.",
    };
  }

  /*
   * City rankings are CONSTRUCTED, not generated. This sits ahead of the other builders because it
   * owns its failures too: an unsupported recognition returns an `unavailable` plan rather than
   * falling through to model-written SQL, which is the silent fallback this family must not have.
   */
  // GC-091 batch (lib/nibrs-agency-period-ranking.ts): "top N police agencies by murders" over a period of years, one
  // row per agency. Positively recognized whole-turn forms only; it never claims a city-ranking request (no city noun).
  const agencyRanking = planNibrsAgencyPeriodRanking(question, options.dataCutoff ?? null);
  if (agencyRanking) {
    return agencyRanking.kind === "deterministic"
      ? { kind: "deterministic", query: agencyRanking.query }
      : { kind: "unavailable", title: agencyRanking.title, explanation: agencyRanking.explanation };
  }

  const cityRanking = planNibrsCityRanking(question, options.dataCutoff ?? null);
  if (cityRanking) {
    return cityRanking.kind === "deterministic"
      ? { kind: "deterministic", query: cityRanking.query }
      : { kind: "unavailable", title: cityRanking.title, explanation: cityRanking.explanation, ...(cityRanking.reason ? { reason: cityRanking.reason } : {}) };
  }

  // Subject-data check BEFORE peer selection (lib/nibrs-deterministic-queries.ts comparableAgencySubjectCheck): a named
  // agency with no clearance rows, or an unreadable check, is declined here with its own specific reason, delivered
  // verbatim by the route's existing unavailable exit. Present data falls through to the peer builder unchanged.
  const subjectCheck = comparableAgencySubjectCheck(question, resolutionPlan, options.subjectRowCount);
  if (subjectCheck && subjectCheck.kind !== "present") {
    return { kind: "unavailable", title: subjectCheck.title, explanation: subjectCheck.explanation };
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
    buildNibrsAnnualClearanceQuery(question, resolutionPlan) ??
    buildNibrsLocalDemographicQuery(question, resolutionPlan) ??
    buildNibrsStructuredLocalTrendQuery(question, resolutionPlan) ??
    buildNibrsLocalCityOffenseCountQuery(question, resolutionPlan) ??
    buildNibrsDomesticViolenceAggravatedAssaultShareQuery(question);
  if (query) return { kind: "deterministic", query };

  // Increment 5 (Decision 16). A peer comparison the deterministic path could not build
  // must NOT fall through to the model: that is precisely how the baseline produced peer
  // groups nobody could check. Say what is missing instead.
  if (asksComparableAgencyComparison(question)) {
    return {
      kind: "unavailable",
      title: "Peer comparison unavailable",
      explanation:
        "I can't build a like-for-like comparison here: I couldn't get the population " +
        "evidence needed to choose agencies of similar size. Naming peers without it would " +
        "give you a group you can't check. Ask for specific agencies by name and I'll compare those.",
    };
  }
  /*
   * FAMILY OWNERSHIP, DECIDED BEFORE THE PLAN SUCCEEDED OR FAILED.
   *
   * Same rule as the peer comparison above, for the same reason. A yearly offence-and-clearance
   * request is a shape this product now calculates itself, binding the offence, the contributing
   * rows, the period and the arithmetic together. If that path cannot serve a particular request,
   * handing the SAME question to model-generated SQL would put back exactly the calculation the
   * controlled path exists to replace -- and the general checker has twice been shown unable to
   * catch it. So an owned request is answered here or declined here.
   *
   * Recognition is of the CONTRACT, not of a remembered sentence, so a different agency, offence or
   * span is owned on the same terms. Anything outside the family keeps its existing route.
   */
  if (asksAnnualClearanceFamily(question)) return annualClearanceUnavailable(question, resolutionPlan);
  return { kind: "model", reason: "no-deterministic-builder" };
}

/**
 * The honest decline for an owned request this path cannot serve, saying WHICH reason.
 *
 * A single generic sentence blamed agency resolution for everything, including a request whose only
 * problem is that it asks for something this family does not calculate. The reader is told what is
 * actually in the way.
 */
function annualClearanceUnavailable(
  question: string, resolutionPlan: NibrsPlaceResolutionPlan | null
): NibrsQueryPlan {
  return {
    kind: "unavailable",
    title: "Yearly clearance figures unavailable",
    explanation: annualClearanceDeclineReason(question, resolutionPlan),
  };
}
