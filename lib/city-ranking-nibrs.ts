/**
 * The NIBRS adapter: a declared city ranking as a deterministic query the existing route can run.
 *
 * This deliberately produces a `DeterministicNibrsQuery` rather than a new payload shape, so the
 * ranking travels the route's proven deterministic branch — validation, execution and emission all
 * happen where they already happen for the other thirteen builders. A new delivery path would be a
 * second place for delivery to be wrong.
 *
 * AN UNSUPPORTED RECOGNITION BECOMES AN `unavailable` PLAN, NEVER A FALL-THROUGH TO THE MODEL.
 * That is what it means for the family to own its failures. It is also not, on its own, enough:
 * this adapter covers only the first of the route's exits. Three more -- a follow-up dispatched
 * before recognition, a structurally refused plan, and an ordinary execution error -- sat outside
 * it and each handed a recognised ranking back to model-written SQL. They are closed at the
 * planner, at the route's refusal branch, and in `decideDeterministicFailure` respectively; the
 * guardrail name below is what ties those three decisions to this family.
 */
import { recognizeCityRanking } from "./city-ranking";
import { buildCityRanking, type SourceCutoff } from "./city-ranking-builder";
import type { DeterministicNibrsQuery } from "./nibrs-deterministic-queries";
import type { CityRankingRequest } from "./city-ranking";
import { placeIs, type NibrsApplied } from "./nibrs-legacy-binding";

/**
 * Stage 2b (plan §5, L3): what the recognized ranking applied, by value -- its scope, offense codes, the quantity it sorts
 * on, its direction and the number of places it shows, its year, and its population floors. A count condition or a
 * population ceiling has no applied threshold value, so a request carrying one is never bound here.
 */
function cityRankingApplied(r: CityRankingRequest): NibrsApplied {
  const floors = r.eligibility.flatMap((e) => (e.kind === "population" && (e.comparison === ">=" || e.comparison === ">") ? [{ op: e.comparison, amount: e.value }] : []));
  return {
    places: r.scope.kind === "nationwide" ? placeIs.national : placeIs.state(r.scope.name),
    codeGroups: r.offense.kind === "nibrs_codes" ? [r.offense.codes] : [],
    // Carjacking is bound by its family value, never as robbery or all offenses (GC-063).
    ...(r.offense.kind === "nibrs_carjacking" ? { families: ["carjacking"] } : {}),
    statistic: r.sort.quantity === "rate_per_100k" ? "rate" : r.sort.quantity === "count" ? "count" : null,
    rank: { dir: r.sort.direction === "desc" ? "top" : "bottom", n: r.resultCount },
    years: r.period.kind === "explicit" ? { start: r.period.year, end: r.period.year } : null,
    thresholds: floors,
    entities: r.entityLevel === "city" ? ["city"] : ["agency"],
  };
}

/** The guardrail every NIBRS city ranking carries. The route's owned-failure decisions key on it. */
export const NIBRS_CITY_RANKING_GUARDRAIL = "deterministic-city-ranking-nibrs";

export type CityRankingPlan =
  | { kind: "deterministic"; query: DeterministicNibrsQuery }
  | { kind: "unavailable"; title: string; explanation: string; reason?: string }
  | null;

/** The honest limitation for a recognised ranking this family could not deliver. */
export function cityRankingUnavailable(explanation: string, reason?: string): { kind: "unavailable"; title: string; explanation: string; reason?: string } {
  return { kind: "unavailable", title: "Ranking Not Available", explanation, ...(reason ? { reason } : {}) };
}

/**
 * A recognised city ranking arriving as a FOLLOW-UP.
 *
 * `planNibrsQuery` returns `{kind:"model",reason:"followup"}` before any source-capable builder
 * runs when `allowDeterministic` is false, so an owned ranking regained model-written SQL simply by
 * arriving as a follow-up. It is declined here instead. This resolves nothing about the follow-up
 * itself -- it does not carry prior context forward, and is not a general follow-up capability.
 */
export function cityRankingFollowupUnavailable(question: string): { kind: "unavailable"; title: string; explanation: string; reason?: string } | null {
  const recognized = recognizeCityRanking(question, "nibrs");
  if (!recognized) return null;
  if (recognized.kind === "unsupported") return cityRankingUnavailable(recognized.explanation, recognized.reason);
  return cityRankingUnavailable(
    "I build city rankings myself rather than generating a query for them, and I can't do that as a " +
    "follow-up to the previous answer. Ask the ranking as a standalone question — naming the " +
    "crime, the year and any limits — and I'll build it."
  );
}

/** What to say when a built ranking cannot be delivered. Never a claim about the data. */
export const CITY_RANKING_FAILURE_TEXT =
  "I couldn't complete that city ranking, and I'm not going to answer it with a query I can't stand " +
  "behind instead. That's a failure on our side, not a statement about what the data contains. Try " +
  "naming the year, or ask for a single city's figures.";

export function planNibrsCityRanking(question: string, cutoff: SourceCutoff | null): CityRankingPlan {
  const recognized = recognizeCityRanking(question, "nibrs");
  if (!recognized) return null;                       // not this family: existing route, untouched
  if (recognized.kind === "unsupported") return cityRankingUnavailable(recognized.explanation, recognized.reason);

  const built = buildCityRanking(recognized, cutoff);
  if (!built) {
    // Recognised and still unplannable — most often no period could be established from observed
    // evidence. Owned.
    return cityRankingUnavailable(
      "I couldn't establish which year to rank for that request from what this source actually " +
      "reports. Name the year — for example \"in 2025\" — and I can build the ranking."
    );
  }

  const explanation = [
    `${built.title}.`,
    ...built.caveats,
  ].join(" ");

  return {
    kind: "deterministic",
    query: {
      sql: built.sql,
      title: built.title,
      explanation,
      chartHint: "bar",
      xAxis: "city",
      yAxis: built.sortColumn,
      xAxisLabel: "City",
      yAxisLabel: built.sortColumn === "rate_per_100k" ? "Rate per 100,000" : "Offenses",
      guardrail: built.guardrail,
      completeness: built.completeness,
      applied: cityRankingApplied(recognized),
    },
  };
}
