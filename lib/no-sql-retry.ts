import type { QueryContract } from "./query-contract";
import type { NibrsPlaceResolutionPlan } from "./nibrs-place-resolver";

/**
 * Sent when the model returned no SQL and none of the recognized patterns
 * (false unavailability claim, year-range question, partial-coverage hedge,
 * demographic-rate refusal) explain why.
 *
 * Production 8375: a 32-city murder-clearance question came back as a short
 * non-SQL reply after the resolver had already resolved 31 of the cities and
 * injected their ORIs. Replaying the identical prompt produced correct SQL on
 * the first attempt, so the failure was stochastic and one retry recovers it.
 */
export const UNEXPLAINED_NO_SQL_RETRY_PROMPT =
  "[SYSTEM: Your previous response did not contain SQL, and gave no reason the request could not be answered. This request is supported by the current source and deterministic resolution succeeded. Generate the SQL now and return the standard JSON with a populated sql field. Do not ask for clarification.]";

/**
 * Guard for the retry above. Spending a second model call is worth it only when
 * the request is demonstrably answerable: a query contract parsed out of it, or
 * the resolver matched at least one place to a real agency. Purely
 * conversational turns and genuinely unsupported asks fall through to the
 * server-authored no-SQL template as before.
 */
export function shouldRetryUnexplainedNoSql(
  contract: QueryContract | null,
  plan: NibrsPlaceResolutionPlan | null
): boolean {
  if (contract) return true;
  return Boolean(plan?.places.some((place) => place.status === "resolved"));
}

/**
 * Bounded diagnostic payload for query_log.model_response.
 *
 * The route overwrites claude.explanation with the server template before
 * logging, so the model's actual words were unrecoverable after the fact --
 * which is why 8375 could only be diagnosed by replaying it. Capped so a
 * runaway response cannot bloat the log, and never user-visible.
 */
export function boundedModelResponseJson(
  first: string | null,
  retry: string | null
): string {
  return JSON.stringify({
    first: first ? first.slice(0, 1500) : null,
    retry: retry ? retry.slice(0, 1500) : null,
  });
}
