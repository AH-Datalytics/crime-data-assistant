/**
 * Level rankings must rank the places the request describes -- not a quietly narrowed subset.
 *
 * Three saved answers ranked cities by a rate and dropped every place whose offense count was zero:
 * `HAVING total_rapes > 0` (GC-039), `HAVING SUM(s.offense_count) > 0` (GC-062), and `>= 1`
 * (GC-063). None of those requests mentioned a volume threshold, and two of them asked for a
 * population floor, honoured it, and then added a second filter on top.
 *
 * The harm is not untidiness. The floor changes WHICH PLACES WERE ELIGIBLE: a city of 300,000 with
 * no recorded shoplifting is a member of "cities of 250,000 or more", and removing it changes the
 * comparison the reader asked for without saying so.
 *
 * THREE THINGS THE FIRST VERSION GOT WRONG, each of which this module now has to answer positively
 * rather than by omission:
 *
 *   1. It never established that a LEVEL RANKING was requested. An ordered, limited statement is
 *      not a level ranking: an alphabetical listing, a peer comparison and a change ranking are all
 *      ordered and limited too, and all three were being flagged. A table's role says what a column
 *      IS; it cannot say what kind of question was asked. So membership is now affirmative, and
 *      change and peer requests are excluded using the request's own declared information.
 *   2. It matched a requested threshold by NUMBER. "At least 100 murders" licensed a floor of 100 on
 *      shoplifting; a requested `>= 100` licensed a stricter `> 100`, which silently drops the
 *      agencies sitting exactly on the requested boundary; and a legitimate "at least 100 offenses"
 *      was itself flagged when "over 250000 population" happened to sit nearby. A request authorizes
 *      one MEASURE, one COMPARISON and one VALUE together, or it authorizes nothing.
 *   3. It treated any aggregate over a metric table as the measure. A metric table also carries
 *      time, identity and denominator columns, so `COUNT(DISTINCT s.month) > 0` was read as an
 *      offense floor. The floor must bind to the column the ranking's own measure is built from.
 *
 * WHAT IS DELIBERATELY NOT COVERED. Two shapes are read: a flat grouped ranking, and a ranking over
 * ONE grouped CTE or derived relation. Anything deeper yields no scopes and the rule stays silent.
 * A missed detection leaves existing behaviour; a false positive pushes a legitimate ranking into a
 * retry it does not need, and -- because an exhausted retry budget ends in a refusal -- can cost the
 * reader an answer entirely. That asymmetry is why every uncertain case here resolves to silence.
 */
import {
  analyzeSql, cteBodies, governingRowLimit, hasTopLevelKeyword, scrubSql,
  splitTopLevelAnd, topLevelClause, LIMIT_INCONCLUSIVE, type SelectItem,
} from "./sql-lineage";
import { tableSemantics } from "./table-semantics";
import { asksHistoricalPeerComparison } from "./historical-peer-comparison";
import type { QueryContract, QueryContractSource } from "./query-contract";

type RankedScope = { name: string; sql: string };

export type MeasureFloor = {
  scope: string;
  clause: "HAVING" | "WHERE";
  expression: string;
  operator: string;
  value: number;
  boundBy: string;
};

const AGGREGATE = /\b(?:SUM|COUNT|TOTAL|AVG|MIN|MAX)\s*\(/i;

/* ------------------------------------------------------------------ *
 * R1. Is a LEVEL RANKING what was asked for?
 * ------------------------------------------------------------------ */

const RANK_PHRASE =
  /\b(?:top|bottom)\s+\d+\b|\b(?:highest|lowest|most|fewest|worst|greatest|largest|smallest)\b|\brank(?:ed|ing|s)?\b|\bleast\s+\w+\b/i;
const PLACE_NOUN =
  /\b(?:cit(?:y|ies)|agenc(?:y|ies)|states?|jurisdictions?|places?|departments?|counties|county|towns?|metros?)\b/i;
/**
 * "Where" asked as a question about location: "what crime type and WHERE had the highest share…"
 * (GC-003). It names no level, but it asks for places as plainly as "which states" does.
 *
 * Only the interrogative counts - "where" opening the question or a clause ("…and where…"), or
 * followed directly by a verb ("where had", "where is"). A relative "where" ("offenses where the
 * offender was a juvenile") qualifies a measure and asks for no place.
 */
const WHERE_PLACE =
  /(?:^|[,;]\s*|\b(?:and|or)\s+)where\b|\bwhere\s+(?:is|are|was|were|had|has|have|did|do|does)\b/i;

/**
 * "Prosecution declined" names an exceptional clearance TYPE (NIBRS code B), not a fall in crime.
 * Without removing it, "declined" matched the change wording and GC-003's ranking - "…the highest
 * share of offenses cleared because of prosecution being declined…" - was treated as a trend
 * question and lost its limit sentence.
 */
function withoutClearanceTypePhrases(text: string): string {
  return text.replace(/\bprosecution\s+(?:(?:being|was|were|is|has\s+been)\s+)?declined\b|\bdeclined\s+(?:to\s+)?prosecut\w*/gi, " ");
}

/** Does the request ask "where" as a question about location (not a relative "where")? */
export function asksWhere(question: string): boolean {
  return WHERE_PLACE.test((question ?? "").trim());
}

/** Does the request ask for places - by naming a kind of place, or by asking where? */
export function asksForPlaces(question: string): boolean {
  const text = (question ?? "").trim();
  return PLACE_NOUN.test(text) || WHERE_PLACE.test(text);
}
/** Wording that makes a request a CHANGE question, which is a different contract (D7). */
const CHANGE_PHRASE =
  /\b(?:increase[ds]?|increasing|decrease[ds]?|decreasing|decline[ds]?|declining|drop(?:ped|ping)?|rose|risen|rising|fell|fallen|falling|grew|growth|change[ds]?|changing|trend(?:s|ing)?|year[- ]over[- ]year|yoy|since\s+\d{4}|compared\s+to\s+\d{4})\b/i;
/**
 * Wording that makes a request a PEER comparison, which is a different contract (D16).
 *
 * NOT `requestedPeerCount`, which is a count extractor rather than a request-type recognizer: it
 * reads the 10 in "Top 10 cities…" as ten peers, and using it here silently stopped the rule from
 * firing on GC-062, one of the three cases this milestone exists for. A helper's name is not its
 * contract.
 */
const PEER_PHRASE =
  /\b(?:peer|comparable|like[- ]for[- ]like|same\s+size)\b|\bsimilar(?:ly)?\s+(?:sized?|size|population)\b|\bof\s+similar\b/i;
/** A chronological or per-period listing is not a ranking of places, however it is ordered. */
const CHRONOLOGICAL =
  /\b(?:by\s+year|per\s+year|each\s+year|by\s+month|per\s+month|each\s+month|annual\s+totals?|over\s+time|by\s+quarter)\b/i;

/**
 * Affirmative membership in the supported level-ranking family.
 *
 * Narrow on purpose, and declared as narrow: this recognises a request to rank PLACES by a level or
 * rate. It is not an intent parser, and anything it does not positively recognise is left alone.
 * `contract` only ever tightens the answer -- a declared comparison request is a change question
 * whatever the wording suggests.
 */
export function isLevelRankingRequest(
  question: string, contract?: Pick<QueryContract, "comparability" | "breakdowns"> | null
): boolean {
  const text = question ?? "";
  if (!RANK_PHRASE.test(text)) return false;
  if (!asksForPlaces(text)) return false;
  if (CHANGE_PHRASE.test(withoutClearanceTypePhrases(text))) return false;
  if (PEER_PHRASE.test(text)) return false;
  if (CHRONOLOGICAL.test(text)) return false;
  if (asksHistoricalPeerComparison(text)) return false;
  if (contract?.comparability?.comparison?.requested) return false;
  // A per-year or per-month breakdown is a series, not a single ranked list of places.
  if ((contract?.breakdowns ?? []).some((b) => b === "year" || b === "month")) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Ranked-row scopes
 * ------------------------------------------------------------------ */

function rankedRowScopes(sql: string): { scopes: RankedScope[]; supported: boolean } {
  const clean = scrubSql(sql);
  const { bodies, rest } = cteBodies(clean);
  const scopes: RankedScope[] = [{ name: "(outer)", sql: rest }];
  if (hasTopLevelKeyword(rest, /\bGROUP\s+BY\b/gi)) return { scopes, supported: true };

  const fromClause = topLevelClause(rest, /\bFROM\b/gi);
  if (!fromClause) return { scopes, supported: true };

  const cteRef = /^\s*([A-Za-z_]\w*)\s*(?:AS\s+)?(?:[A-Za-z_]\w*)?\s*$/i.exec(fromClause);
  if (cteRef && bodies.has(cteRef[1].toLowerCase())) {
    const body = bodies.get(cteRef[1].toLowerCase()) as string;
    if (hasTopLevelKeyword(body, /\bGROUP\s+BY\b/gi)) scopes.push({ name: cteRef[1].toLowerCase(), sql: body });
    return { scopes, supported: true };
  }
  const derived = /^\s*\(([\s\S]*)\)\s*(?:AS\s+)?(?:[A-Za-z_]\w*)?\s*$/i.exec(fromClause);
  if (derived && hasTopLevelKeyword(derived[1], /\bGROUP\s+BY\b/gi)) {
    scopes.push({ name: "(derived)", sql: derived[1] });
    return { scopes, supported: true };
  }
  if (/\bJOIN\b/i.test(fromClause) || fromClause.includes("(")) return { scopes, supported: false };
  return { scopes, supported: true };
}

const selectItemsOf = (scope: RankedScope): SelectItem[] => {
  if (!/^\s*SELECT/i.test(scope.sql)) return [];
  const lineage = analyzeSql(scope.sql);
  return lineage.parsed ? lineage.items : [];
};

const metricRefColumns = (item: SelectItem, source: QueryContractSource): string[] =>
  (item.refs ?? [])
    .filter((ref) => {
      const entry = ref.table ? tableSemantics(source, ref.table) : null;
      return Boolean(entry && entry.role === "metric");
    })
    .map((ref) => (ref.column ?? "").toLowerCase())
    .filter(Boolean);

/**
 * R2/R3. The column(s) the ranking's own measure is built from.
 *
 * Taken from what the statement RANKS BY -- the ORDER BY target resolved through the select list --
 * falling back to the measure columns the ranking returns. This is what makes
 * `COUNT(DISTINCT s.month) > 0` not a measure floor: `month` is a time column on a metric table, and
 * the ranking's measure is built from `offense_count`.
 */
function contributingMeasureColumns(scopes: RankedScope[], source: QueryContractSource): Set<string> {
  const columns = new Set<string>();
  const outer = scopes[0];
  const allItems = scopes.flatMap(selectItemsOf);
  const orderBy = topLevelClause(outer.sql, /\bORDER\s+BY\b/gi) ?? "";
  const orderTargets = orderBy
    .split(",")
    .map((part) => part.trim().replace(/\s+(?:ASC|DESC)\b.*$/i, "").replace(/^.*\./, "").toLowerCase())
    .filter(Boolean);

  for (const target of orderTargets) {
    const item = allItems.find((candidate) => (candidate.alias ?? "").toLowerCase() === target);
    if (item) for (const column of metricRefColumns(item, source)) columns.add(column);
    else if (/^[a-z_]\w*$/.test(target)) {
      // A bare ordered column that is itself a measure column of a metric table.
      for (const scope of scopes) {
        const probe = analyzeSql(scope.sql.replace(/^\s*SELECT/i, `SELECT ${target} AS __order_probe,`));
        const found = (probe.items ?? []).find((candidate) => candidate.alias === "__order_probe");
        if (found) for (const column of metricRefColumns(found, source)) columns.add(column);
      }
    }
  }
  if (columns.size === 0) {
    // Nothing resolvable to rank by: fall back to the aggregated measures the ranking returns.
    for (const item of allItems) {
      if (!AGGREGATE.test(item.raw ?? "")) continue;
      for (const column of metricRefColumns(item, source)) columns.add(column);
    }
  }
  return columns;
}

/**
 * R2. Resolve a threshold expression against ITS OWN scope, and report which column it filters.
 *
 * The earlier version probed every scope in turn and flattened all aliases into one index, so a
 * definition from an unrelated level could satisfy a predicate. A predicate is resolved here in the
 * scope it was written in; for the wrapping form, where the alias is necessarily defined one level
 * down, exactly that one relation is consulted and no other.
 */
function filteredColumns(
  expression: string, scope: RankedScope, scopes: RankedScope[], source: QueryContractSource
): { columns: string[]; via: string } | null {
  const expr = expression.trim();
  const ownScopes = scope.name === "(outer)" && scopes.length > 1 ? [scope, scopes[1]] : [scope];

  if (AGGREGATE.test(expr)) {
    for (const candidate of ownScopes) {
      if (!/^\s*SELECT/i.test(candidate.sql)) continue;
      const probed = analyzeSql(candidate.sql.replace(/^\s*SELECT/i, `SELECT ${expr} AS __floor_probe,`));
      const item = (probed.items ?? []).find((entry) => entry.alias === "__floor_probe");
      const columns = item ? metricRefColumns(item, source) : [];
      if (columns.length > 0) return { columns, via: "aggregate in its own scope" };
    }
    return null;
  }

  const bare = expr.replace(/^.*\./, "").toLowerCase();
  for (const candidate of ownScopes) {
    const item = selectItemsOf(candidate).find((entry) => (entry.alias ?? "").toLowerCase() === bare);
    if (!item) continue;
    if (!AGGREGATE.test(item.raw ?? "")) return null;
    const columns = metricRefColumns(item, source);
    if (columns.length > 0) return { columns, via: `alias of ${(item.raw ?? "").trim().slice(0, 40)}` };
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * R2. Requested thresholds: measure, comparison and value together
 * ------------------------------------------------------------------ */

const POPULATION_NOUN = /\b(?:people|residents?|population|pop\.?|inhabitants?)\b/i;
const ENTITY_NOUN = /\b(?:cit(?:y|ies)|agenc(?:y|ies)|states?|jurisdictions?|places?|departments?)\b/i;
const GENERIC_COUNT_NOUN = /\b(?:offen[cs]es?|crimes?|incidents?|cases?|reports?|counts?)\b/i;
const SPECIFIC_CRIME_NOUN =
  /\b(murders?|homicides?|rapes?|robberies|robbery|assaults?|burglaries|burglary|thefts?|larcenies|larceny|carjackings?|shootings?|shopliftings?|arsons?|arrests?)\b/i;
const TOP_N_LEAD = /\b(?:top|first|highest|lowest|bottom)\s+$/i;

export type RequestedThreshold = {
  value: number;
  /** The inclusive lower bound the request authorizes. */
  lowerBound: number;
  /** The crime noun it was attached to, or null when it used a generic count noun. */
  measureNoun: string | null;
};

/** The inclusive lower bound a comparison admits, for integer-valued counts. */
function inclusiveLowerBound(operator: string, value: number): number {
  if (operator === ">=") return value;
  if (operator === ">") return Number.isInteger(value) ? value + 1 : value;
  // `<>`/`!=` against a number excludes exactly that value; for a zero floor that is the same
  // narrowing shape, so treat it as excluding everything at or below it.
  return Number.isInteger(value) ? value + 1 : value;
}

/**
 * Thresholds the REQUEST placed on the measure, each with the value and noun it was attached to.
 *
 * Read noun-led and bound locally. "Top 10 cities of 250,000 people or more with at least 100
 * shoplifting offenses" has to yield exactly one threshold -- 100 -- without the nearby population
 * phrase erasing it, and without 10 or 250,000 becoming thresholds of their own.
 */
export function requestedMeasureThresholds(question: string): RequestedThreshold[] {
  const found: RequestedThreshold[] = [];
  const text = question ?? "";
  // Each number is judged on the words immediately around it, not a wide window that can span two
  // separate conditions. That wide window is what erased a legitimate offense floor when a
  // population phrase happened to sit nearby.
  const re = /(?:\b(at\s+least|more\s+than|minimum\s+of|min\.?|over|above|no\s+fewer\s+than)\s+)?(\d[\d,]*)\s*(\+|k\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lead = (m[1] ?? "").toLowerCase();
    const raw = m[2];
    if (/^(?:19|20)\d{2}$/.test(raw)) continue;
    let value = Number(raw.replace(/,/g, ""));
    if ((m[3] ?? "").toLowerCase() === "k") value *= 1000;
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (TOP_N_LEAD.test(before)) continue;
    const trailing = /^\s*(?:or\s+more|or\s+greater|and\s+(?:up|above))\b/i.test(after);
    if (!lead && !trailing) continue;
    // The noun the number is attached to: whichever comes first after it.
    const populationAt = after.search(POPULATION_NOUN);
    const specificAt = after.search(SPECIFIC_CRIME_NOUN);
    const genericAt = after.search(GENERIC_COUNT_NOUN);
    const candidates = [
      { kind: "population", at: populationAt },
      { kind: "specific", at: specificAt },
      { kind: "generic", at: genericAt },
    ].filter((candidate) => candidate.at >= 0).sort((a, b) => a.at - b.at);
    const nearest = candidates[0];
    if (!nearest || nearest.kind === "population") continue;
    if (nearest.kind === "generic" && ENTITY_NOUN.test(after.slice(0, genericAt)) ) continue;
    const operator = lead === "more than" || lead === "over" || lead === "above" ? ">" : ">=";
    const noun = nearest.kind === "specific"
      ? (SPECIFIC_CRIME_NOUN.exec(after) ?? [])[1]?.toLowerCase() ?? null
      : null;
    found.push({ value, lowerBound: inclusiveLowerBound(operator, value), measureNoun: noun });
  }
  return found;
}

/** Singular stem, so "murders" and "murder" compare equal without a stemmer. */
const stem = (word: string): string => word.toLowerCase().replace(/(?:ies)$/, "y").replace(/e?s$/, "");

/**
 * Does a requested threshold authorize this SQL floor?
 *
 * All three must agree. The VALUE has to admit at least as much as the request did -- a requested
 * "at least 100" does not authorize `> 100`, which drops the agencies sitting exactly on the
 * requested boundary. The MEASURE has to be the one the request named: "at least 100 murders"
 * authorizes nothing about shoplifting, and a generic "100 offenses" refers to whatever the ranking
 * itself measures.
 */
function authorizes(
  threshold: RequestedThreshold, floorOperator: string, floorValue: number, question: string
): boolean {
  if (inclusiveLowerBound(floorOperator, floorValue) > threshold.lowerBound) return false;
  if (!threshold.measureNoun) return true;
  const asked = stem(threshold.measureNoun);
  // A specific crime noun must be the one the ranking is about. The question's own offense wording
  // is the reference: it is what the ranking's measure was chosen from.
  const rankedPhrase = question.replace(new RegExp(`\\b${asked}\\w*\\b`, "ig"), " ");
  const stillMentionsAnotherCrime = SPECIFIC_CRIME_NOUN.test(rankedPhrase);
  return !stillMentionsAnotherCrime;
}

/* ------------------------------------------------------------------ *
 * Numeric lower bounds in a clause
 * ------------------------------------------------------------------ */

function lowerBounds(clause: string | null): Array<{ expression: string; operator: string; value: number }> {
  if (!clause) return [];
  const bounds: Array<{ expression: string; operator: string; value: number }> = [];
  for (const part of splitTopLevelAnd(clause)) {
    const m = /^([\s\S]+?)(>=|<=|<>|!=|>|<|=)\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!m) continue;
    const operator = m[2];
    if (operator !== ">" && operator !== ">=" && operator !== "<>" && operator !== "!=") continue;
    bounds.push({ expression: m[1].trim(), operator, value: Number(m[3]) });
  }
  return bounds;
}

/* ------------------------------------------------------------------ *
 * The rule
 * ------------------------------------------------------------------ */

export function unrequestedMeasureFloors(opts: {
  question: string;
  sql: string;
  source: QueryContractSource;
  contract?: Pick<QueryContract, "comparability" | "breakdowns"> | null;
}): MeasureFloor[] {
  if (!isLevelRankingRequest(opts.question, opts.contract)) return [];

  const clean = scrubSql(opts.sql);
  if (!hasTopLevelKeyword(clean, /\bORDER\s+BY\b/gi)) return [];
  const limit = governingRowLimit(opts.sql);
  if (limit === null || limit === LIMIT_INCONCLUSIVE) return [];

  const { scopes, supported } = rankedRowScopes(opts.sql);
  if (!supported) return [];

  const measureColumns = contributingMeasureColumns(scopes, opts.source);
  if (measureColumns.size === 0) return [];

  const requested = requestedMeasureThresholds(opts.question);
  const floors: MeasureFloor[] = [];
  for (const scope of scopes) {
    const clauses: Array<{ clause: "HAVING" | "WHERE"; text: string | null }> = [
      { clause: "HAVING", text: topLevelClause(scope.sql, /\bHAVING\b/gi) },
    ];
    if (scope.name === "(outer)" && scopes.length > 1) {
      clauses.push({ clause: "WHERE", text: topLevelClause(scope.sql, /\bWHERE\b/gi) });
    }
    for (const { clause, text } of clauses) {
      for (const bound of lowerBounds(text)) {
        const filtered = filteredColumns(bound.expression, scope, scopes, opts.source);
        if (!filtered) continue;
        // The floor must filter the column the ranking's own measure is built from.
        if (!filtered.columns.some((column) => measureColumns.has(column))) continue;
        if (requested.some((threshold) => authorizes(threshold, bound.operator, bound.value, opts.question))) continue;
        floors.push({ scope: scope.name, clause, boundBy: filtered.via, ...bound });
      }
    }
  }
  return floors;
}

export function measureFloorMessage(floors: MeasureFloor[]): string {
  const listed = floors
    .map((floor) => `\`${floor.clause} ${floor.expression} ${floor.operator} ${floor.value}\``)
    .join(" and ");
  return (
    `This ranking excludes places using ${listed}, which the request did not ask for. A place with a ` +
    "low or zero count is still one of the places the request describes, so removing it changes " +
    `which places were ranked. Remove ${floors.length > 1 ? "those conditions" : "that condition"} ` +
    "and change nothing else: keep the same tables, geography, offense, period, any threshold the " +
    "request did state, the row limit, and a population > 0 guard where a rate needs it."
  );
}

/* ------------------------------------------------------------------ *
 * R3. The limit sentence
 * ------------------------------------------------------------------ */

/**
 * The sentence stating a ranking's governing row limit.
 *
 * Two corrections over the first version, both about telling the truth rather than reading a LIMIT:
 *
 *   - It is gated on the SAME level-ranking family as the rule. An annual total ordered by year is
 *     not a ranking, and was being handed "Ranking limited to the top 20 results".
 *   - The wording is NEUTRAL. "Top" asserts a direction the statement may not have: a lowest-first
 *     ranking and a page after `OFFSET 20` were both being described as "top". The cap is stated;
 *     direction and page position are not claimed, and neither is the existence of further rows --
 *     that is truncation, a separate fact the result digest already tracks.
 */
export function rankingLimitSentence(
  sql: string | null | undefined,
  question?: string | null,
  contract?: Pick<QueryContract, "comparability" | "breakdowns"> | null
): string | null {
  if (!sql || !sql.trim()) return null;
  if (!isLevelRankingRequest(question ?? "", contract)) return null;
  const clean = scrubSql(sql);
  if (!hasTopLevelKeyword(clean, /\bORDER\s+BY\b/gi)) return null;
  const limit = governingRowLimit(sql);
  if (limit === null || limit === LIMIT_INCONCLUSIVE) return null;
  if (!Number.isFinite(limit) || (limit as number) <= 0) return null;
  return `Ranking result limit: ${limit} rows.`;
}
