/**
 * The SHR adapter: a declared city ranking (GC-064 rate, GC-061 firearm share) built, checked and run.
 *
 * Same contract as the NIBRS adapter: a recognised ranking is built here or declined here, and never
 * handed to model-written SQL. `runShrCityRanking` takes the route's validator, so a test runs the same
 * flow the route does.
 *
 * THE ORDER IS THE POINT, and it is the shared one (lib/city-ranking-completeness.ts; Codex combined
 * review, CL3): the scope-only candidates statement runs first, so an agency whose own records disagree
 * is found before any eligibility filter could remove one of its records; membership comes from the
 * evidence-backed classification (lib/shr-agency-classification.ts; Jeff's policy, 2026-09-30), never from
 * `incidents.agency_type`; eligibility and the predicted ranking are then decided in code; the ranking of
 * exactly the confirmed cities, by ORI, must equal that prediction in ORI order and in every figure; and S1
 * decides whether the confirmed cities are the complete answer. When they are not, the answer is titled and
 * worded PARTIAL, names what could change it, and says why each named agency is not classified.
 */
import { recognizeCityRanking } from "./city-ranking";
import { buildCityRanking, type BuiltCityRanking, type SourceCutoff } from "./city-ranking-builder";
import { cityRankingUnavailable } from "./city-ranking-nibrs";
import { completenessOf, decideCandidates, rankedDisagreement, type Candidate, type CompletenessPlan } from "./city-ranking-completeness";
import { basisPhrase, classifyShrAgency, shrAgencyKey, UNRESOLVED_REASON_TEXT, type ShrClassification, type ShrTypeEvidenceSet } from "./shr-agency-classification";

/** The guardrail every SHR city ranking carries. */
export const SHR_CITY_RANKING_GUARDRAIL = "deterministic-city-ranking-shr";

type ShrBuilt = BuiltCityRanking & { completeness: CompletenessPlan };

export type ShrCityRankingPlan =
  | { kind: "deterministic"; built: ShrBuilt; yAxisLabel: string }
  | { kind: "unavailable"; title: string; explanation: string }
  | null;

export function planShrCityRanking(question: string, cutoff: SourceCutoff | null): ShrCityRankingPlan {
  const recognized = recognizeCityRanking(question, "shr");
  if (!recognized) return null;                       // not this family: the route continues unchanged
  if (recognized.kind === "unsupported") return cityRankingUnavailable(recognized.explanation);

  const built = buildCityRanking(recognized, cutoff);
  if (!built || !built.completeness) {
    return cityRankingUnavailable(
      "I couldn't establish which year to rank for that request from what this source actually " +
      "reports. Name the year — for example \"in 2025\" — and I can build the ranking."
    );
  }
  const yAxisLabel = built.sortColumn === "rate_per_100k" ? "Victims per 100,000"
    : built.sortColumn === "firearm_share_pct" ? "Firearm share (%)" : "Victims";
  return { kind: "deterministic", built: built as ShrBuilt, yAxisLabel };
}

export type ShrRankingOutcome =
  | { kind: "refused"; sql: string; reason: string }
  | { kind: "answer"; sql: string; rows: Record<string, unknown>[]; title: string; explanation: string; complete: boolean;
      relevantUnresolved: Candidate[]; splitIdentities: { ori: string; label: string }[] };

export type ValidatedStatement = { sql: string; rows: () => Record<string, unknown>[] };

/** The type the shared decision classifies, from the evidence-backed classification (not a column). */
function typeFromClassification(c: ShrClassification): string {
  return c.membership === "unresolved" ? "" : c.membership === "eligible" ? "City" : c.agencyType;
}

export function runShrCityRanking(
  plan: Extract<ShrCityRankingPlan, { kind: "deterministic" }>,
  deps: {
    /**
     * The route's validation of a statement. It returns the validated statement bound to its own
     * execution, or null when validation refused it: nothing runs that was not validated.
     */
    validate: (statement: string) => ValidatedStatement | null;
    /** The application's read of the agency-type evidence for the ranking year (`loadShrTypeEvidence`). */
    typeEvidence: (year: number) => ShrTypeEvidenceSet;
  },
): ShrRankingOutcome {
  const { built } = plan;
  const c = built.completeness;
  if (!c.rankedConfirmed) throw new Error("city-ranking-shr: the SHR plan must rank confirmed agencies by ORI");

  // 1. Every agency in scope, before any filter.
  const candidates = deps.validate(c.candidatesSql);
  if (candidates === null) return { kind: "refused", sql: c.candidatesSql, reason: "candidates statement refused" };
  const candidateRows = candidates.rows();

  // 2. Membership from the evidence-backed classification (Jeff's policy, 2026-09-30), per agency and state.
  const evidence = deps.typeEvidence(built.period.year);
  const classes = new Map<string, ShrClassification>();
  for (const row of candidateRows) {
    const key = shrAgencyKey(String(row.ori), String(row.state));
    if (!classes.has(key)) classes.set(key, classifyShrAgency(evidence.byAgency.get(key) ?? null, evidence.built, built.period.year));
  }
  const classOf = (row: Record<string, unknown>) => classes.get(shrAgencyKey(String(row.ori), String(row.state)))!;
  const planWithEvidence = { ...c, typeOf: (row: Record<string, unknown>) => typeFromClassification(classOf(row)) };
  const decision = decideCandidates(planWithEvidence, candidateRows);
  if (decision.kind === "inconsistent") return { kind: "refused", sql: c.candidatesSql, reason: decision.reason };

  // 3. The ranking of exactly the confirmed cities, which must be the predicted one.
  const rankedSql = c.rankedConfirmed(decision.confirmed.map((x) => x.ori));
  const rankedStatement = deps.validate(rankedSql);
  if (rankedStatement === null) return { kind: "refused", sql: rankedSql, reason: "ranked statement refused" };
  const rows = rankedStatement.rows();
  const disagreement = rankedDisagreement(planWithEvidence, decision, rows);
  if (disagreement) return { kind: "refused", sql: rankedStatement.sql, reason: `ranked result differs from the candidates: ${disagreement}` };

  // 4. Complete, or partial and saying why -- and where each city's membership came from.
  const result = completenessOf(planWithEvidence, decision, rows, built.title);
  return {
    kind: "answer", sql: rankedStatement.sql, rows, title: result.title,
    explanation: [`${result.title}.`, ...result.sentences, ...basisSentences(evidence.built, rows, result.relevantUnresolved, candidateRows, classOf), ...built.caveats].join(" "),
    complete: result.complete, relevantUnresolved: result.relevantUnresolved, splitIdentities: result.splitIdentities,
  };
}

/** The disclosure of what the membership rests on (the approved policy requires the origin be stated). */
function basisSentences(
  built: boolean, rows: Record<string, unknown>[], relevant: Candidate[],
  candidateRows: Record<string, unknown>[], classOf: (row: Record<string, unknown>) => ShrClassification,
): string[] {
  if (!built) {
    return ["No evidence-backed agency types have been built for SHR yet, so no agency is confirmed as a city here."];
  }
  const out: string[] = [];
  const byOri = new Map(candidateRows.map((r) => [String(r.ori), r]));
  // Each ranked agency's OWN basis (Codex SC-2): its typed years, any blank years (not counted) and any
  // carry-forward, stated per agency; agencies sharing exactly the same basis are grouped. No combined range.
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const cls = classOf(r);
    if (cls.membership !== "eligible") continue;
    const phrase = basisPhrase(cls.agencyType, cls.basis);
    groups.set(phrase, [...(groups.get(phrase) ?? []), `${String(r.city)}, ${String(r.state)}`]);
  }
  if (groups.size > 0) {
    out.push(`Where each ranked city's classification comes from (the NIBRS database's type for the one NIBRS agency its identifier matches): ${[...groups]
      .map(([phrase, labels]) => `${labels.join(" and ")} — ${phrase}`).join("; ")}.`);
  }
  const reasons = new Map<string, string[]>();
  for (const u of relevant) {
    const cls = classOf(byOri.get(u.ori) ?? { ori: u.ori });
    if (cls?.membership !== "unresolved") continue;
    reasons.set(cls.reason, [...(reasons.get(cls.reason) ?? []), u.label]);
  }
  if (reasons.size > 0) {
    out.push(`Why they are not classified: ${[...reasons].map(([reason, labels]) =>
      `${labels.join(" and ")} — ${UNRESOLVED_REASON_TEXT[reason as keyof typeof UNRESOLVED_REASON_TEXT]}`).join("; ")}.`);
  }
  return out;
}
