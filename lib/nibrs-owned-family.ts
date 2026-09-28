/**
 * The NIBRS route's terminal behaviour for a family that calculates its own answer.
 *
 * WHY THIS IS A FUNCTION AND NOT A BRANCH IN THE HANDLER. The first version of this work put the
 * owned family's exits inline in `route.ts`, and the only proof available was a test that sliced the
 * handler's source and matched regexes against it. That establishes what the file says, not what it
 * does: it cannot show that nothing executes after a refused plan, and it cannot show that a failure
 * does not retry through the model. Both are the properties that matter.
 *
 * So the whole flow lives here, taking the executor as an argument. The route passes its real
 * bounded executor; a test passes a counting one and gets the same code path, including the counts.
 * Nothing is mirrored.
 *
 * THE SAFETY CONTRACT, stated precisely because the earlier claim was not:
 *   - a refused plan executes NOTHING and returns no SQL to the reader;
 *   - an execution failure does NOT retry through the model path;
 *   - when no year is supportable the query DID execute, so its SQL is retained honestly, but no
 *     rows, no figure and no title are returned;
 *   - an answer carries its withholding reasons alongside, so the route can put the figures through
 *     its ordinary disclosure chokepoint and still deliver the specific reason.
 */

import { annualClearanceDelivery, type AnnualClearanceRow, type DeterministicNibrsQuery } from "./nibrs-deterministic-queries";
import { decideDeterministicFailure } from "./nibrs-recovery";

export type OwnedFamilyOutcome =
  | {
      kind: "decline";
      reason: "plan-refused" | "execution-failed" | "no-supportable-year";
      /** Null where nothing ran; the executed statement where something did. */
      sql: string | null;
      explanation: string;
      title: "";
    }
  | {
      kind: "answer";
      sql: string;
      rows: Record<string, unknown>[];
      columns: string[];
      /** The figures' own wording, for the route's ordinary disclosure chokepoint. */
      explanation: string;
      /** The per-year withholding reasons, appended AFTER disclosures. */
      withheldNote: string;
      title: string;
    };

export async function runOwnedAnnualClearance(opts: {
  question: string;
  place: string;
  query: DeterministicNibrsQuery;
  /** The structural guard's verdict on this plan, or null when it accepted it. */
  refusal: { ruleIds: string[] } | null;
  execute: (sql: string) => Promise<{ rows: unknown[]; columns: string[] }>;
}): Promise<OwnedFamilyOutcome> {
  const { question, place, query, refusal, execute } = opts;

  if (refusal) {
    // Nothing has run and nothing will. Every other deterministic plan falls through to the model
    // path here; this family must not, because what would come back is the calculation ownership
    // replaced.
    return {
      kind: "decline",
      reason: "plan-refused",
      sql: null,
      title: "",
      explanation:
        "I couldn't produce a yearly clearance answer I can account for here, and I'm not going " +
        "to substitute one I can't.",
    };
  }

  let executed: { rows: unknown[]; columns: string[] };
  try {
    executed = await execute(query.sql);
  } catch (error) {
    // `decideDeterministicFailure` owns this decision and this wording, and for a self-calculating
    // family it stops. Reading its outcome rather than assuming it keeps one place in charge.
    const decision = decideDeterministicFailure(
      { sql: query.sql, guardrail: query.guardrail },
      error instanceof Error ? error.message : String(error),
      null,
    );
    return {
      kind: "decline",
      reason: "execution-failed",
      sql: query.sql,
      title: "",
      explanation: decision.outcome === "stop"
        ? decision.error
        : "I couldn't complete that yearly clearance query, and I'm not going to substitute a " +
          "figure I can't account for.",
    };
  }

  const delivery = annualClearanceDelivery(question, place, executed.rows as AnnualClearanceRow[]);
  if ("decline" in delivery) {
    // The query ran, so its SQL is retained -- saying otherwise would misdescribe what happened.
    // What is withheld is the figure, the rows and the title.
    return {
      kind: "decline",
      reason: "no-supportable-year",
      sql: query.sql,
      title: "",
      explanation: delivery.decline,
    };
  }

  return {
    kind: "answer",
    sql: query.sql,
    rows: delivery.rows,
    columns: delivery.columns,
    explanation: delivery.explanation,
    withheldNote: delivery.withheldNote,
    title: delivery.title,
  };
}
