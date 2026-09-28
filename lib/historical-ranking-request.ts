import type { QueryContract } from "./query-contract";
import { requestedScope } from "./structural-semantics";
import { stripSqlComments } from "./sql-restriction";

/**
 * Two things a Historical ranking must not quietly change about the request it answers.
 *
 * WHY THIS EXISTS. Correcting the state/national rate rule (`lib/source-capabilities.ts`) lets
 * model-written Historical city-rate rankings through to delivery. One of the two queries that
 * correction unblocks is wrong in ways nothing else checks: GC-059 asked for the **top 10** US
 * cities by homicide rate in 2021 and the model wrote `LIMIT 20` with `population > 25000` -- a
 * list twice the size asked for, and an eligibility cutoff the user never stated, which silently
 * removes every small city from a question about the highest rates. Delivering that as the answer
 * would trade one wrong outcome for another.
 *
 * WHY IT IS NOT THE OLD GENERAL CHECKER. `lib/structural-semantics.ts` records that eligibility
 * enforcement for model-written rankings was deliberately retired, because the version that
 * existed accepted a rate floor for a count request. This does not restore it. It asks two
 * questions with definite answers -- did the request state a list size, and did it state a
 * population threshold -- and compares each with what the SQL does. Where the request says
 * nothing, nothing is enforced.
 *
 * SCOPE. Historical only, which is the route this increment was authorized to correct. The same
 * defect shape is possible on other model-written routes; that is an observation here, not a
 * change, and it is unverified.
 */

export type HistoricalRankingIssue = {
  ruleId: "historical-ranking-limit-mismatch" | "historical-ranking-unrequested-population-floor";
  message: string;
  /** What the request asked for and what the SQL did, for the receipt. */
  observed: Record<string, string | number | null>;
};

const NUMBER_WORDS: Record<string, number> = {
  three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, twentyfive: 25, fifty: 50, hundred: 100,
};

/**
 * The list size the REQUEST states, or null when it states none.
 *
 * Only a size bound to a ranking word counts. A bare year ("in 2021") or a threshold ("at least
 * 100 murders") is not a list size, and reading one as a list size would invent a requirement.
 */
export function requestedListSize(question: string): number | null {
  const digits = question.match(
    /\b(?:top|bottom|first|last|highest|lowest|worst|safest|deadliest|most|fewest)\s+(\d{1,3})\b|\b(\d{1,3})\s+(?:highest|lowest|worst|safest|deadliest|most\s+dangerous)\b/i
  );
  if (digits) {
    const value = Number(digits[1] ?? digits[2]);
    if (Number.isInteger(value) && value > 0 && value <= 500) return value;
  }
  const words = question.match(
    /\b(?:top|bottom|first|last|highest|lowest|worst|safest|deadliest)\s+(three|four|five|six|seven|eight|nine|ten|fifteen|twenty|fifty)\b/i
  );
  if (words) return NUMBER_WORDS[words[1].toLowerCase()] ?? null;
  return null;
}

/**
 * A population threshold the REQUEST states, or null when it states none.
 *
 * Deliberately generous about phrasing and strict about what qualifies: the number has to be
 * attached to population words. "at least 100 murders" is a count condition and must not be read
 * as a population floor, or a request that states no population rule would look like one that did.
 */
export function requestedPopulationThreshold(question: string): number | null {
  const scale = (raw: string, suffix: string | undefined): number => {
    const value = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) return NaN;
    if (!suffix) return value;
    const unit = suffix.toLowerCase();
    if (unit === "k") return value * 1_000;
    if (unit === "m" || unit === "mm") return value * 1_000_000;
    return value;
  };
  const patterns: RegExp[] = [
    /\b(?:population|people|residents)\s+(?:of\s+)?(?:at\s+least|over|above|more\s+than|greater\s+than|exceeding|under|below|less\s+than|fewer\s+than)\s+([\d,]+(?:\.\d+)?)\s*(k|m|mm)?\b/i,
    /\b(?:at\s+least|over|above|more\s+than|greater\s+than|under|below|less\s+than|fewer\s+than)\s+([\d,]+(?:\.\d+)?)\s*(k|m|mm)?\s+(?:people|residents|population)\b/i,
    /\b(?:cities|places|agencies|towns)\s+(?:of|with)\s+([\d,]+(?:\.\d+)?)\s*(k|m|mm)?\s*(?:\+|or\s+more|people|residents)\b/i,
    /\bmin(?:imum)?\.?\s*(?:population\s*)?([\d,]+(?:\.\d+)?)\s*(k|m|mm)\b/i,
    /\b(?:large|big)(?:r|gest)?\s+cities\s+\(\s*([\d,]+(?:\.\d+)?)\s*(k|m|mm)?\s*\+?\s*\)/i,
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (!match) continue;
    const value = scale(match[1], match[2]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/** The outer LIMIT of a statement, ignoring limits inside subqueries and CTEs. */
export function outerLimit(sql: string): number | null {
  const text = stripSqlComments(sql);
  let depth = 0;
  let outer: number | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && /l/i.test(ch)) {
      const match = /^limit\s+(\d{1,6})\b/i.exec(text.slice(i));
      if (match) outer = Number(match[1]);
    }
  }
  return outer;
}

/**
 * Population comparisons the SQL imposes, excluding the `> 0` a rate needs to avoid dividing by
 * zero. That guard is arithmetic, not an eligibility choice, and flagging it would punish correct
 * queries -- GC-058's SQL carries exactly that and nothing else.
 */
export function sqlPopulationFloors(sql: string): number[] {
  const text = stripSqlComments(sql);
  const floors: number[] = [];
  const pattern = /\b(?:\w+\.)?population\s*(>=?|<=?)\s*([\d_]+)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const operator = match[1];
    const value = Number(match[2].replace(/_/g, ""));
    if (!Number.isFinite(value)) continue;
    if ((operator === ">" || operator === ">=") && value <= 1) continue;
    floors.push(value);
  }
  return floors;
}

/**
 * Judge a model-written Historical ranking against the request it answers.
 *
 * Applies only when the request asks for a list of places (row level city, agency or county) and
 * the SQL reads the agency tables. A single-place question, a state-level answer, or the
 * deterministic ranking family's own SQL is none of this function's business.
 */
export function findHistoricalRankingIssues(opts: {
  question: string;
  contract: QueryContract;
  sql: string;
}): HistoricalRankingIssue[] {
  const level = requestedScope(opts.question, opts.contract).rowLevel;
  if (level !== "city" && level !== "agency" && level !== "county") return [];
  if (!/\bhistorical_agency(?:_crime|_population)?\b/i.test(opts.sql)) return [];

  const issues: HistoricalRankingIssue[] = [];

  const asked = requestedListSize(opts.question);
  const limit = outerLimit(opts.sql);
  if (asked !== null && limit !== null && limit !== asked) {
    issues.push({
      ruleId: "historical-ranking-limit-mismatch",
      message:
        `[SYSTEM: Query contract violation (historical-ranking-limit-mismatch). The request asks for ` +
        `${asked} ${level === "city" ? "cities" : level === "county" ? "counties" : "agencies"}, and the SQL ends with ` +
        `LIMIT ${limit}. Return exactly the number asked for: use LIMIT ${asked}. Do not widen or narrow the list.]`,
      observed: { requestedListSize: asked, sqlOuterLimit: limit, rowLevel: level },
    });
  }

  const requestedFloor = requestedPopulationThreshold(opts.question);
  const floors = sqlPopulationFloors(opts.sql);
  const unrequested = requestedFloor === null ? floors : floors.filter((floor) => floor !== requestedFloor);
  if (unrequested.length > 0) {
    issues.push({
      ruleId: "historical-ranking-unrequested-population-floor",
      message:
        `[SYSTEM: Query contract violation (historical-ranking-unrequested-population-floor). The SQL restricts ` +
        `population to ${unrequested.map((floor) => floor.toLocaleString("en-US")).join(", ")}, which the request ` +
        `never asked for. A population cutoff decides which places can appear in a rate ranking, so it cannot be ` +
        `added silently. Remove it, keeping only \`population > 0\` where a rate needs a non-zero denominator` +
        `${requestedFloor !== null ? `, and the requested threshold of ${requestedFloor.toLocaleString("en-US")}` : ""}.]`,
      observed: {
        requestedPopulationThreshold: requestedFloor,
        sqlPopulationFloors: floors.join(", ") || null,
        unrequested: unrequested.join(", "),
      },
    });
  }

  return issues;
}
