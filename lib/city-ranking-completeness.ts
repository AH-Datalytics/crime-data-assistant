/**
 * S1 in the ranking family: ONE decision, fed by each source's own evidence, used by the SHR, Current
 * and NIBRS city rankings (Codex combined review, CL3 and the S1 scope decision).
 *
 * THE ORDER IS THE POINT. Identity first, then eligibility, then ranking, then completeness:
 *   1. The candidates statement reads the request's SCOPE only -- offense, period, state -- with no type,
 *      population or count filter, grouped so that an agency whose own records disagree (two names,
 *      types, populations or states in the period) comes back as more than one row. A filter applied
 *      first would erase exactly the records that disagree: that is how a St. Louis split at population
 *      50,000 vanished under "over 100k" while its other records still ranked.
 *   2. Eligibility (recorded type through the source's S1 authority, the population condition, the
 *      rate's denominator, the count condition) is then applied here, to the candidates, in code.
 *   3. The ranked statement excludes every disagreeing agency, and -- where its rows carry the agency's
 *      ORI and exact figures (SHR) -- must equal the ranking predicted from the candidates in ORI order
 *      AND in every figure, or it is refused.
 *   4. `rankingCompleteness` decides whether the confirmed cities are the whole answer.
 *
 * SOURCE-SPECIFIC EVIDENCE, NOT ONE STORAGE MODEL. SHR and Current carry the type on every event or
 * month row, so their records can disagree and they read scope-only candidates. NIBRS keeps it on
 * `agencies`, which declares a PRIMARY KEY (ori, year) that SQLite enforces (IDENTITY_UNIQUENESS in
 * lib/city-ranking-builder.ts), so an agency-year cannot carry two types there; NIBRS reads only its
 * unresolved candidates, and a second row for one agency is treated as a broken premise, not ranked.
 * That key is asserted of the retained schema; confirming the live table carries it remains a recorded
 * qualification requirement.
 */
import { rankingCompleteness, type CityAuthority, type CityMembership } from "./entity-authority";

export type CompletenessPlan = {
  source: "shr" | "current" | "nibrs";
  authority: CityAuthority;
  /** Where the type is recorded, for the wording. */
  typeSource: string;
  candidateScope: "scope-only" | "unresolved-only";
  candidatesSql: string;
  /** The ranked statement, excluding the given disagreeing agencies. */
  ranked: (excluded: string[]) => string;
  amountColumn: "victims" | "offenses";
  quantity: "count" | "rate_per_100k" | "share_pct";
  populationConditions: { comparison: string; value: number }[];
  countConditions: { comparison: string; value: number }[];
  limit: number;
  direction: "asc" | "desc";
  /** True when the ranked rows carry `ori` and exact figures, so they can be checked against the candidates. */
  verifiable: boolean;
  /**
   * SHR only: the candidate's type comes from evidence outside the candidates statement (the classification
   * the adapter supplies, lib/shr-agency-classification.ts), not from a `recorded_type` column.
   */
  typeOf?: (row: Record<string, unknown>) => unknown;
  /** SHR only: the ranked statement over exactly the confirmed agencies, by ORI (membership is not a column). */
  rankedConfirmed?: (oris: string[]) => string;
  /** How an unresolved agency is described in the partial wording; defaults to "no agency type recorded in <typeSource>". */
  unresolvedPhrase?: string;
  /** What a split identity disagrees on, for the wording; defaults to "name, type, population or state". */
  splitFields?: string;
};

export type Candidate = {
  ori: string; label: string; membership: CityMembership;
  population: number | null; amount: number; firearm: number | null;
};

const compare = (a: number, op: string, b: number): boolean =>
  op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : op === "<=" ? a <= b : false;

function passesPopulation(plan: CompletenessPlan, population: number | null): boolean {
  const rate = plan.quantity === "rate_per_100k";
  if (plan.populationConditions.length === 0 && !rate) return true;
  if (population == null) return false;                      // an unknown population cannot be placed
  if (rate && !(population > 0)) return false;               // a rate needs its denominator
  return plan.populationConditions.every((c) => compare(population, c.comparison, c.value));
}
const passesCount = (plan: CompletenessPlan, amount: number) =>
  plan.countConditions.every((c) => compare(amount, c.comparison, c.value));

/** The exact value a row ranks by -- the same ratio the SHR statement orders by. */
export function measureOf(plan: CompletenessPlan, c: { amount: number; population: number | null; firearm: number | null }): number {
  if (plan.quantity === "rate_per_100k") return c.amount / Number(c.population);
  if (plan.quantity === "share_pct") return Number(c.firearm) / c.amount;
  return c.amount;
}

/** The value as the answer displays it. */
export function displayOf(plan: CompletenessPlan, c: { amount: number; population: number | null; firearm: number | null }): string {
  if (plan.quantity === "rate_per_100k") return String(Math.round(c.amount * 100000 / Number(c.population) * 100) / 100);
  if (plan.quantity === "share_pct") return `${Math.round(1000 * Number(c.firearm) / c.amount) / 10}%`;
  return c.amount.toLocaleString("en-US");
}

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));

function toCandidate(plan: CompletenessPlan, row: Record<string, unknown>): Candidate {
  return {
    ori: String(row.ori), label: `${String(row.city)}, ${String(row.state)}`,
    membership: plan.authority.classify(plan.typeOf ? plan.typeOf(row) : row.recorded_type),
    population: num(row.population), amount: Number(row[plan.amountColumn]), firearm: num(row.firearm_victims),
  };
}

export type CandidateDecision =
  | {
      kind: "decided";
      /** Every agency whose records disagree; the ranked statement excludes all of them. */
      conflicted: string[];
      /** The disagreeing agencies that could enter the requested result, whatever their figures. */
      relevantSplits: { ori: string; label: string }[];
      /** Eligible confirmed cities, in ranking order (scope-only candidates only). */
      confirmed: Candidate[];
      /** Eligible agencies with no recorded type. */
      unresolved: Candidate[];
    }
  | { kind: "inconsistent"; reason: string };

export function decideCandidates(plan: CompletenessPlan, rows: Record<string, unknown>[]): CandidateDecision {
  const byOri = new Map<string, Candidate[]>();
  for (const row of rows) {
    const c = toCandidate(plan, row);
    byOri.set(c.ori, [...(byOri.get(c.ori) ?? []), c]);
  }
  const conflicted = [...byOri].filter(([, pieces]) => pieces.length > 1).map(([ori]) => ori).sort();
  if (plan.candidateScope === "unresolved-only") {
    if (conflicted.length > 0) return { kind: "inconsistent", reason: `two records for one agency-year: ${conflicted.join(", ")}` };
    const wrong = rows.map((r) => toCandidate(plan, r)).filter((c) => c.membership !== "unresolved");
    if (wrong.length > 0) return { kind: "inconsistent", reason: `unresolved candidates carried a recorded type: ${wrong.map((c) => c.ori).join(", ")}` };
  }
  const relevantSplits = conflicted
    .filter((ori) => {
      const pieces = byOri.get(ori)!;
      return pieces.some((p) => p.membership !== "ineligible" && passesPopulation(plan, p.population))
        && passesCount(plan, pieces.reduce((s, p) => s + p.amount, 0));
    })
    .map((ori) => ({ ori, label: byOri.get(ori)![0].label }));
  const eligible = [...byOri.values()].filter((pieces) => pieces.length === 1).map((pieces) => pieces[0])
    .filter((c) => c.membership !== "ineligible" && passesPopulation(plan, c.population) && passesCount(plan, c.amount));
  const order = (a: Candidate, b: Candidate) => {
    const d = plan.direction === "desc" ? measureOf(plan, b) - measureOf(plan, a) : measureOf(plan, a) - measureOf(plan, b);
    return d !== 0 ? d : a.ori < b.ori ? -1 : 1;
  };
  return {
    kind: "decided", conflicted, relevantSplits,
    confirmed: eligible.filter((c) => c.membership === "eligible").sort(order),
    unresolved: eligible.filter((c) => c.membership === "unresolved").sort(order),
  };
}

/**
 * The ranked rows must be the ranking the candidates predict: the same agencies in the same order, and
 * the same count, population and firearm figures. Only possible where the rows carry the ORI (SHR); for
 * Current and NIBRS this check is NOT made, and is not claimed.
 */
export function rankedDisagreement(plan: CompletenessPlan, decision: Extract<CandidateDecision, { kind: "decided" }>, rows: Record<string, unknown>[]): string | null {
  if (!plan.verifiable) return null;
  const expected = decision.confirmed.slice(0, plan.limit);
  if (rows.length !== expected.length) return `row count ${rows.length}, predicted ${expected.length}`;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const e = expected[i];
    if (String(r.ori) !== e.ori) return `place ${i + 1}: ${String(r.ori)}, predicted ${e.ori}`;
    if (Number(r[plan.amountColumn]) !== e.amount) return `${e.ori}: ${plan.amountColumn} ${String(r[plan.amountColumn])}, predicted ${e.amount}`;
    if (plan.quantity === "rate_per_100k" && Number(r.population) !== e.population) return `${e.ori}: population ${String(r.population)}, predicted ${e.population}`;
    if (plan.quantity === "share_pct" && Number(r.firearm_victims) !== e.firearm) return `${e.ori}: firearm ${String(r.firearm_victims)}, predicted ${e.firearm}`;
  }
  return null;
}

const ORDINAL = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

export type CompletenessResult = {
  complete: boolean;
  /** The partial title, or the given title unchanged when complete. */
  title: string;
  /** Sentences to deliver ahead of the caveats; empty when complete. */
  sentences: string[];
  relevantUnresolved: Candidate[];
  splitIdentities: { ori: string; label: string }[];
};

/** Whether the confirmed cities are the whole answer, and the owned wording when they are not. */
export function completenessOf(
  plan: CompletenessPlan, decision: Extract<CandidateDecision, { kind: "decided" }>, rows: Record<string, unknown>[], title: string,
): CompletenessResult {
  const ranked = rows.map((r, i) => ({
    ori: r.ori == null ? `#${i}` : String(r.ori), label: `${String(r.city)}, ${String(r.state)}`,
    measure: measureOf(plan, { amount: Number(r[plan.amountColumn]), population: num(r.population), firearm: num(r.firearm_victims) }),
  }));
  const unresolved = decision.unresolved.map((c) => ({ ...c, measure: measureOf(plan, c) }));
  const d = rankingCompleteness({ ranked, limit: plan.limit, direction: plan.direction, unresolved, splitIdentities: decision.relevantSplits });
  if (d.complete) return { complete: true, title, sentences: [], relevantUnresolved: [], splitIdentities: [] };
  // The place it would take if every agency named here were a city: the confirmed cities AND the
  // other named agencies ahead of it count, so two named agencies never claim the same place.
  const ahead = (a: number, b: number) => (plan.direction === "desc" ? a > b : a < b);
  const place = (m: number) => 1 + ranked.filter((r) => ahead(r.measure, m)).length + d.relevant.filter((u) => ahead(u.measure, m)).length;
  const sentences: string[] = [];
  if (d.relevant.length > 0) {
    const named = d.relevant.map((u) => `${u.label} (${displayOf(plan, u)}, would rank ${ORDINAL(place(u.measure))})`);
    sentences.push(
      `This ranking is incomplete: ${named.length === 1 ? "one agency" : `${named.length} agencies`} with ` +
      `${plan.unresolvedPhrase ?? `no agency type recorded in ${plan.typeSource}`} would place within it — ${named.join("; ")}. They are not ranked as cities until ` +
      "their type is established, so the rows below are the confirmed cities only.");
  }
  if (d.split.length > 0) {
    sentences.push(
      `${d.split.map((x) => `${x.label} (${x.ori})`).join("; ")} ${d.split.length === 1 ? "has" : "have"} conflicting records ` +
      `in ${plan.typeSource} for this period (more than one ${plan.splitFields ?? "name, type, population or state"}), so ` +
      `${d.split.length === 1 ? "it is" : "they are"} not ranked and could change the result.`);
  }
  return {
    complete: false, title: `Partial ranking: ${title} (confirmed cities only)`, sentences,
    relevantUnresolved: d.relevant, splitIdentities: d.split,
  };
}
