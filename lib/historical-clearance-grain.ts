// Historical clearance grain: what the source can and cannot say about clearance.
//
// WHY THIS EXISTS. Historical publishes clearance at two grains and nothing in between:
//
//   national_clearance_rate      national percentages, 1960-2024, and it has NO `state` column
//   historical_agency_clearance  agency-year PERCENTAGES in nine `*_clr` columns
//
// There is no cleared-offense COUNT anywhere in Historical, so a state has neither a numerator nor a
// denominator, and agency percentages cannot be averaged or summed into a state rate under any
// weighting. A question like "what is the rape clearance rate in Florida by year?" therefore has no
// correct answer here, and the two things that look like answers are both wrong: the national table
// silently drops the state filter it cannot apply, and an aggregate over reporting agencies is not a
// statement about the state.
//
// The reason this ships a plausible answer rather than an obvious error is a name collision plus a
// coincidence. `national_clearance_rate.rape_rate` is "percent of rapes cleared";
// `historical_state_national.rape_rate` is "rapes per 100,000". For 2024 those are 27.2 and 27.93.
// Same column name, unrelated quantities, indistinguishable at a glance.
//
// Verified against C:\tmp\hist9\crime_data.replacement.db,
// sha256 a890fa1f5f6e01185534770ef5efe5b2532f3729378570f02ae8665cf34f3444.
//
// OBSERVATION ONLY in this increment. This module decides nothing; it reports. Nothing here reaches
// blockReasons, retryIssues, enforced, warnings or fired, and no user-facing behaviour changes.

import type { QueryContract, QueryContractGeography } from "./query-contract";

/** Two different facts. Both decline, but they are not the same finding and never share a code. */
export type ClearanceGrainReason =
  /** The measure exists, but not at the requested grain. */
  | "historical-state-clearance-no-aggregate"
  /** The measure does not exist in this source at any grain. */
  | "historical-clearance-measure-absent";

export type ClearanceGrainObservation = {
  reason: ClearanceGrainReason;
  /** Server-authored user-facing text. Contains no clearance number, by construction. */
  message: string;
  topic: string;
  /** The state that cannot be served, when that is the finding. */
  stateName: string | null;
};

/**
 * The clearance measures Historical actually carries, keyed by contract topic.
 *
 * Derived from the `*_clr` columns of `historical_agency_clearance`, not from prose: murder_clr,
 * rape_clr, robbery_clr, assault_clr, burglary_clr, theft_clr, motor_vehicle_theft_clr, violent_clr,
 * property_clr. A topic absent from this map has no clearance measure here at all -- which is a
 * different finding from having one at the wrong grain.
 */
const CLEARANCE_MEASURES: Record<string, { column: string; phrase: string }> = {
  murder: { column: "murder_clr", phrase: "murder" },
  rape: { column: "rape_clr", phrase: "rape" },
  robbery: { column: "robbery_clr", phrase: "robbery" },
  aggravated_assault: { column: "assault_clr", phrase: "aggravated assault" },
  burglary: { column: "burglary_clr", phrase: "burglary" },
  theft: { column: "theft_clr", phrase: "theft" },
  motor_vehicle_theft: { column: "motor_vehicle_theft_clr", phrase: "motor vehicle theft" },
  violent_crime: { column: "violent_clr", phrase: "violent crime" },
  property_crime: { column: "property_clr", phrase: "property crime" },
};

/** Named once, so the "what we do carry" sentence cannot drift from CLEARANCE_MEASURES. */
const SUPPORTED_PHRASES = Object.values(CLEARANCE_MEASURES).map((m) => m.phrase).join(", ");

export function clearanceMeasureColumn(topic: string): string | null {
  return CLEARANCE_MEASURES[topic]?.column ?? null;
}

/**
 * Every geography the contract resolved, so a two-state comparison is caught as readily as a single
 * state. `geographies` is the full list; `geography` is the primary and may be the only one.
 */
function resolvedGeographies(contract: QueryContract): QueryContractGeography[] {
  const list = contract.geographies?.length ? contract.geographies : [contract.geography];
  return list.filter(Boolean);
}

/**
 * The first state-grain geography, or null.
 *
 * Keyed on `kind`, never on `state` being populated: "murder clearance in Miami" carries
 * `state: "Florida"` with `kind: "city"`, and that is an allowed agency-grain question. Confusing the
 * two would turn every city question in a state into a false decline. `kind: "national"` -- which is
 * what "United States" resolves to -- is not subnational and is allowed.
 */
function stateGrainGeography(contract: QueryContract): QueryContractGeography | null {
  return resolvedGeographies(contract).find((g) => g.kind === "state") ?? null;
}

function stateDeclineMessage(phrase: string | null, stateName: string): string {
  // The alternatives are OFFERS, not answers, and no availability probe runs to produce them: the
  // agency option is always phrased "where available" precisely so that deciding it needs no query.
  //
  // `phrase` is null when the question named no specific offense ("what is the clearance rate in
  // Florida?"). The grain is still wrong, so it still declines -- the sentence just does not invent
  // an offense it was never given.
  const subject = phrase ? `a statewide ${phrase} clearance rate` : "statewide clearance rates";
  return (
    `Historical does not provide ${subject} for ${stateName}, and individual agency percentages ` +
    `cannot be combined into one reliably. I can show the national clearance rate, or individual ` +
    `${stateName} agencies' reported rates where available.`
  );
}

function measureAbsentMessage(topic: string): string {
  const subject = topic === "unknown" ? "that" : topic.replace(/_/g, " ");
  return (
    `Historical does not carry a ${subject} clearance measure at any level. Its clearance data covers ` +
    `${SUPPORTED_PHRASES}.`
  );
}

/**
 * Observe -- do not enforce -- whether this Historical request asks for clearance at a grain or for a
 * measure the source cannot support.
 *
 * Returns null for everything Historical can legitimately answer: national clearance, agency and
 * city/county/campus clearance, state crime rates, state crime counts, and any non-clearance request.
 */
export function observeHistoricalClearanceGrain(contract: QueryContract): ClearanceGrainObservation | null {
  if (contract.source !== "historical") return null;
  // The typed measure does the work. No question-text matching happens in this module.
  if (contract.metric.unit !== "clearance_rate") return null;

  const topic = contract.metric.topic;

  // Was a SPECIFIC offense resolved? `metric.offenses` is the typed list; `topic` falls back to
  // "crime" or "unknown" when nothing matched.
  //
  // This distinction is load-bearing and the shadow measurement is what forced it. An earlier version
  // treated "no offense resolved" as "the measure does not exist", which turned ten legitimate
  // questions in the replay corpus into refusals -- "National clearance rates 1960 to 2024",
  // "Atlanta clearance rate", "how has clearance of violent crimes changed over time?". Not knowing
  // which measure was asked for is not the same as knowing the measure is absent.
  const resolvedOffense = contract.metric.offenses.length > 0 ? topic : null;

  // Measure existence is the more fundamental fact, so it is reported first: if Historical has no
  // such clearance column at all, the grain question never arises. It can only be asserted about an
  // offense that was actually resolved.
  if (resolvedOffense && !clearanceMeasureColumn(resolvedOffense)) {
    return { reason: "historical-clearance-measure-absent", message: measureAbsentMessage(resolvedOffense), topic, stateName: null };
  }

  // Grain is independent of measure: a statewide clearance rate does not exist for ANY offense, so
  // this holds even when no specific offense was named.
  const state = stateGrainGeography(contract);
  if (!state) return null;

  const stateName = state.canonicalName ?? state.name;
  if (!stateName) return null;

  return {
    reason: "historical-state-clearance-no-aggregate",
    message: stateDeclineMessage(resolvedOffense ? CLEARANCE_MEASURES[resolvedOffense].phrase : null, stateName),
    topic,
    stateName,
  };
}
