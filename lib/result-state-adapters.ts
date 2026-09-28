/**
 * Increment 1 — source adapters for the shared result-state core.
 *
 * The architecture review is explicit: shared policy decides what evidence MEANS, and each
 * source supplies its own evidence. Current Trends, Historical, NIBRS and SHR do not have
 * the same facts available, and a shared control must never pretend they do.
 *
 * Every field an adapter cannot establish stays `null`. That is the point: `null` becomes
 * `unknown`, and `unknown` blocks an unsafe claim rather than inventing a safe-sounding
 * one. An adapter that guesses would defeat the entire control.
 */

import type Database from "better-sqlite3";
import { explainEmptyCurrentTrendsResult } from "./current-trends-empty-reason";
import { classifyResultState, type ResultStateDecision, type ResultStateEvidence } from "./result-state";

export interface RouteResultFacts {
  sql: string | null;
  rows: Record<string, unknown>[];
  /** A product-side error, guardrail block or timeout, if one occurred. */
  productError?: string | null;
  /** False when the query did not run to completion. */
  queryCompleted?: boolean;
}

/** Evidence available to every source without extra work. */
function baseEvidence(facts: RouteResultFacts): ResultStateEvidence {
  return {
    queryCompleted: facts.productError ? false : (facts.queryCompleted ?? true),
    productError: facts.productError ?? null,
    requestResolved: null,
    periodInCoverage: null,
    entityInCoverage: null,
    reportingExpected: null,
    queryRepresentsRequest: null,
    measuredValue: null,
    rowCount: facts.rows.length,
  };
}

/**
 * Current Trends adapter.
 *
 * This tab already has a careful evidence gatherer — current-trends-empty-reason.ts — that
 * checks place, period and offence against real rows, separately, and refuses to speak
 * when it cannot read the query. We translate its finding into the shared vocabulary
 * rather than re-deriving it, so the two cannot drift apart.
 */
export function currentTrendsResultState(db: Database.Database, facts: RouteResultFacts): ResultStateDecision {
  const evidence = baseEvidence(facts);
  if (evidence.productError || evidence.queryCompleted === false) return classifyResultState(evidence);
  if (facts.rows.length > 0 || !facts.sql) return classifyResultState(evidence);

  let reason;
  try {
    reason = explainEmptyCurrentTrendsResult(db, facts.sql);
  } catch {
    // A failure of the evidence gatherer is a failure to establish anything, never a
    // licence to assert. Fall through as unknown.
    return classifyResultState(evidence);
  }

  if (!reason.establishedFromData) return classifyResultState(evidence);

  switch (reason.reason) {
    case "place_not_covered":
      return classifyResultState({ ...evidence, entityInCoverage: false });
    case "period_not_covered":
      return classifyResultState({ ...evidence, entityInCoverage: true, periodInCoverage: false });
    case "no_report_for_period":
    case "offense_not_reported":
      return classifyResultState({
        ...evidence,
        requestResolved: true, entityInCoverage: true, periodInCoverage: true,
        reportingExpected: false,
      });
    default:
      return classifyResultState(evidence);
  }
}

/**
 * The default adapter for sources that do not yet gather coverage evidence.
 *
 * It establishes only what the route genuinely knows: whether we failed, and how many rows
 * came back. Everything else stays unknown — which is the honest state, and which still
 * stops the failure-as-missing-data wording the baseline caught.
 */
export function genericResultState(facts: RouteResultFacts): ResultStateDecision {
  return classifyResultState(baseEvidence(facts));
}
