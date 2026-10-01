import type { QueryContract } from "./query-contract";
import { requestedScope } from "./structural-semantics";
import { asksForPlaces } from "./level-ranking-eligibility";
import { stripSqlComments } from "./sql-restriction";

/**
 * The one thing a NIBRS clearance ranking must not quietly change about the request it answers.
 *
 * WHY THIS EXISTS, AND WHY NOW. Restoring the context of a clearance follow-up (see
 * `lib/clearance-refinement-followup.ts`) lets GC-004's saved statement through the contract
 * validator, which previously refused it for the wrong reason. That statement carries
 * `HAVING SUM(scd.total_offenses) >= 100` — a minimum-count cutoff the reader never asked for,
 * which decides which states can appear in a ranking of shares. Before this rule, nothing
 * objected to it: the only check of that shape is Historical's population floor, in
 * `lib/historical-ranking-request.ts`. Restoring the context without this would have turned a
 * refusal into a wrong answer, which is the trade the whole repair exists to avoid.
 *
 * WHAT IT IS NOT. It is not a general eligibility checker; `lib/structural-semantics.ts` records
 * why that was retired. It asks one question with a definite answer — did the REQUEST state a
 * minimum count — and compares it with what the SQL imposes. Where the request says nothing,
 * nothing is enforced, and the reader's own threshold is theirs to set.
 *
 * WHERE THE REQUEST IS READ FROM. The question, and only the question. An earlier assistant
 * answer that mentions a cutoff is model prose, not permission: GC-004's setup answer says
 * "restricted to states with at least 100 reported offenses", and that sentence must never make
 * the next statement's invented cutoff acceptable.
 *
 * SCOPE. NIBRS clearance rankings that read the clearance summaries. A single-place question, a
 * statement over other tables, or a request that is not a ranking is none of this function's
 * business.
 */

export type NibrsClearanceRankingIssue = {
  ruleId: "nibrs-clearance-ranking-unrequested-offense-floor";
  message: string;
  /** What the request asked for and what the SQL did, for the receipt. */
  observed: Record<string, string | number | null>;
};

/** The clearance summaries this rule governs. */
const CLEARANCE_TABLES = /\bsummary_clearance_(?:detail|type)\b/i;

/** A ranking asks which places are highest or lowest; a single-place question does not. */
function asksForRanking(question: string): boolean {
  return /\b(?:highest|lowest|top|bottom|most|fewest|worst|best|leading|rank(?:ed|ing|s)?)\b/i.test(question);
}

/**
 * A minimum offence/report count the REQUEST states, or null when it states none.
 *
 * Strict about what qualifies, for the mirror of the reason the population helper is strict: a
 * population rule must not be read as a count rule, or a request that stated nothing about counts
 * would look like one that did.
 */
export type CountComparison = { operator: ">" | ">=" | "<" | "<="; value: number };

/**
 * The lowest count a place may have and still appear, given a comparison.
 *
 * Counts are integers, so `>= 100` and `> 99` admit exactly the same places. Comparing this
 * number rather than the written one is what lets an equivalent rewrite pass while a changed
 * population does not. Upper bounds have no lower bound and are never equivalent to one.
 */
function lowerBound(comparison: CountComparison): number | null {
  if (comparison.operator === ">=") return comparison.value;
  if (comparison.operator === ">") return comparison.value + 1;
  return null;
}

export function requestedOffenseCountThreshold(question: string): CountComparison | null {
  const subject = String.raw`(?:reported\s+)?(?:offen[cs]es?|incidents?|reports?|cases?|crimes?|rapes?|murders?|homicides?|robberies|assaults?|burglaries|thefts?)`;
  const patterns: Array<{ pattern: RegExp; operator: CountComparison["operator"] }> = [
    { pattern: new RegExp(String.raw`\b(?:at\s+least|no\s+fewer\s+than|minimum\s+of)\s+([\d,]+)\s+${subject}\b`, "i"), operator: ">=" },
    { pattern: new RegExp(String.raw`\b(?:over|above|more\s+than|greater\s+than)\s+([\d,]+)\s+${subject}\b`, "i"), operator: ">" },
    { pattern: new RegExp(String.raw`\b(?:under|below|fewer\s+than|less\s+than)\s+([\d,]+)\s+${subject}\b`, "i"), operator: "<" },
    { pattern: new RegExp(String.raw`\b${subject}\s*>=\s*([\d,]+)\b`, "i"), operator: ">=" },
    { pattern: new RegExp(String.raw`\b${subject}\s*>\s*([\d,]+)\b`, "i"), operator: ">" },
    { pattern: new RegExp(String.raw`\bmin(?:imum)?\.?\s*(?:${subject}\s*)?(?:of\s+)?([\d,]+)\s*${subject}\b`, "i"), operator: ">=" },
    { pattern: new RegExp(String.raw`\bwith\s+([\d,]+)\s*\+\s*${subject}\b`, "i"), operator: ">=" },
  ];
  for (const { pattern, operator } of patterns) {
    const match = question.match(pattern);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) return { operator, value };
  }
  return null;
}

/**
 * Count conditions the SQL imposes on the offence total, WITH their comparators.
 *
 * WHY THE COMPARATOR (Codex review CD1/CD2). The first version returned bare numbers, so for a
 * request that said "at least 100", the statements `>= 100`, `> 100`, `< 100` and `<= 100` all
 * looked like "the 100 the reader asked for" — four different ranking populations, none of them
 * flagged. A threshold is a comparison, not a number.
 *
 * THE ARITHMETIC EXEMPTION IS EXACTLY TWO PREDICATES. A share needs a non-zero denominator, which
 * is `total_offenses > 0` or `>= 1`; those exclude only places with no offences at all and are not
 * an eligibility choice. The first version exempted every `>`/`>=` at one or less, which quietly
 * covered `> 1` — a predicate that removes legitimate places with a single offence. `>= 0` and
 * any lower bound at or below zero exclude nothing at all and are likewise not filters.
 * `NULLIF(SUM(total_offenses), 0)` carries no comparison and is not matched here.
 */
export function sqlOffenseCountFloors(sql: string): CountComparison[] {
  const text = stripSqlComments(sql);
  const found: CountComparison[] = [];
  const pattern = /(?:sum\s*\(\s*)?(?:\w+\.)?total_offenses\s*\)?\s*(>=|<=|>|<)\s*([\d_]+)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const operator = match[1] as CountComparison["operator"];
    const value = Number(match[2].replace(/_/g, ""));
    if (!Number.isFinite(value)) continue;
    const comparison: CountComparison = { operator, value };
    const bound = lowerBound(comparison);
    // A lower bound of 1 or less admits every place that has any offence at all.
    if (bound !== null && bound <= 1) continue;
    found.push(comparison);
  }
  return found;
}

/** Two comparisons admit exactly the same integer counts. */
function sameEligibility(a: CountComparison, b: CountComparison): boolean {
  const boundA = lowerBound(a);
  const boundB = lowerBound(b);
  if (boundA !== null && boundB !== null) return boundA === boundB;
  return a.operator === b.operator && a.value === b.value;
}

/** How a comparison reads in a message. */
const describe = (c: CountComparison) => `${c.operator} ${c.value.toLocaleString("en-US")}`;

/**
 * Judge a model-written NIBRS clearance ranking against the request it answers.
 *
 * Applies only when the request asks which places rank highest or lowest, the contract's measure
 * is a clearance share, and the SQL reads a clearance summary.
 */
export function findNibrsClearanceRankingIssues(opts: {
  question: string;
  contract: QueryContract;
  sql: string;
}): NibrsClearanceRankingIssue[] {
  if (opts.contract.metric.unit !== "clearance_rate") return [];
  if (!asksForRanking(opts.question)) return [];
  const level = requestedScope(opts.question, opts.contract).rowLevel;
  // "…and where had the highest share…" (GC-003) names no level, so the level reads as unknown - but
  // it asks for places as plainly as "which states" does, and a count floor decides which places
  // appear. A national or single-place request stays out of scope.
  const placeRanking = level === "state" || level === "city" || level === "agency" || level === "county"
    || (level === "unknown" && asksForPlaces(opts.question));
  if (!placeRanking) return [];
  if (!CLEARANCE_TABLES.test(opts.sql)) return [];

  const requested = requestedOffenseCountThreshold(opts.question);
  const floors = sqlOffenseCountFloors(opts.sql);
  const unrequested = requested === null
    ? floors
    : floors.filter((floor) => !sameEligibility(floor, requested));
  if (unrequested.length === 0) return [];

  return [{
    ruleId: "nibrs-clearance-ranking-unrequested-offense-floor",
    message:
      `[SYSTEM: Query contract violation (nibrs-clearance-ranking-unrequested-offense-floor). The SQL `
      + `restricts the offense total to ${unrequested.map(describe).join(", ")}, which is not what the `
      + `request asked for. A count condition decides which places can appear in a ranking of shares, `
      + `so it cannot be added or changed silently. Remove it, keeping only the non-zero denominator a `
      + `share needs`
      + `${requested !== null ? `, and the requested condition of ${describe(requested)}` : ""}.]`,
    observed: {
      requestedOffenseCountThreshold: requested ? describe(requested) : null,
      sqlOffenseCountFloors: floors.map(describe).join(", ") || null,
      unrequested: unrequested.map(describe).join(", "),
      rowLevel: level,
    },
  }];
}
