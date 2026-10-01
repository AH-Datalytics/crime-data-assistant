/**
 * Increment 5 — deterministic Historical peer comparison (frozen Decision 16).
 *
 * The two Historical Decision 16 shapes both ask how one city compares to BOTH the
 * national picture AND its peers:
 *   GC-118 "How does Philadelphia's homicide decline compare to the national average and
 *           peer cities?"
 *   GC-119 "how does the clearance rate for violent crime in Albuquerque compare to the
 *           national average and similar cities?"
 *
 * Two rules from the architecture review §4 shape this module:
 *
 *   1. The model does not invent peer membership. Candidates come from the population
 *      table, the pure peer core selects them, and the query reads the selected ORIs.
 *   2. The national comparison and the peer average stay SEPARATELY LABELLED. Folding a
 *      national figure into a peer average would answer neither question asked.
 *
 * If the subject or the population evidence cannot be resolved, this returns an honest
 * specific limitation rather than silently choosing peers.
 */

import { resolveGeoPlaces } from "./geo-place-resolver";
import type { EstablishedIdentity } from "./answer-evidence";
import { selectPopulationPeers, requestedPeerCount, type PeerCandidate } from "./peer-comparison";
import { peerEvidenceUnavailable, type PeerCandidateSource } from "./peer-adapters";

export interface HistoricalPeerPlan {
  sql: string | null;
  title: string;
  explanation: string;
  columns: string[];
  /** Present so this plan is drop-in compatible with HistoricalCityChangePlan. */
  chartConfig: null;
  chartMeta: null;
  guardrail: string;
  /** The selected set, so a caller can verify what came back against what was chosen. */
  selectedOris: string[];
  /** Subject plus peers — the entity count Decision 16 expects. */
  expectedEntityCount: number;
  /** Agency labels of the selected set, for comparing selection with returned evidence. */
  selectedLabels: string[];
  /**
   * Review 2B: the selected entities as identities (ORI + display label). The Historical
   * result labels places with `historical_agency.agency`, which is the same column the
   * candidate source read, so label matching is already exact here; carrying the id keeps
   * membership on the same contract as NIBRS rather than on that coincidence.
   */
  selectedPeers: EstablishedIdentity[];
}

const sq = (v: string) => `'${String(v).replace(/'/g, "''")}'`;

/** Asks to compare a place with peers, and (in these shapes) the nation too. */
export function asksHistoricalPeerComparison(question: string): boolean {
  const q = question ?? "";
  const peers = /\b(peer|similar|comparable|like[-\s]sized|similarly sized)\s+(cit(?:y|ies)|agenc(?:y|ies)|department|places)\b/i.test(q)
    || /\b(cit(?:y|ies)|agenc(?:y|ies))\s+of\s+(?:similar|comparable)\s+size\b/i.test(q);
  return peers && /\bcompare[sd]?\b|\bhow does\b|\bversus\b|\bvs\.?\b/i.test(q);
}

/** Which metric the two frozen shapes ask about. */
function metricOf(question: string): { kind: "homicide" | "violent_clearance"; label: string } | null {
  const q = question ?? "";
  // The clearance branch supports ONE measure: the violent-crime clearance rate, which is
  // what historical_agency_clearance.violent_clr holds. A murder- or robbery-clearance
  // request must NOT be silently answered with the violent figure, so this branch declines
  // and the question falls through rather than answering a different measure.
  if (/\bclearance\b/i.test(q)) {
    const namesOtherOffence = /\b(murder|homicide|rape|robbery|burglar|theft|auto|vehicle)\b/i.test(q);
    if (namesOtherOffence) return null;
    if (/\bviolent\b/i.test(q)) return { kind: "violent_clearance", label: "violent-crime clearance rate" };
    return null;   // bare "clearance" is ambiguous; do not guess a measure
  }
  if (/\bhomicides?\b|\bmurders?\b/i.test(q)) return { kind: "homicide", label: "homicides" };
  return null;
}

/**
 * An explicitly requested year range. R1 carry-over: the generated SQL previously carried
 * NO year predicate while the explanation described a period, so the answer claimed a
 * scope it had not applied. Either the period is applied, or the shape declines.
 */
export function explicitPeriod(question: string): { start: number; end: number } | null {
  const q = question ?? "";
  const between = /\b(?:from|between)\s+((?:19|20)\d{2})\s*(?:to|and|-|through)\s*((?:19|20)\d{2})\b/i.exec(q);
  if (between) return { start: Number(between[1]), end: Number(between[2]) };
  const since = /\b(?:since|after|from)\s+((?:19|20)\d{2})\b/i.exec(q);
  if (since) return { start: Number(since[1]), end: new Date().getFullYear() };
  const inYear = /\bin\s+((?:19|20)\d{2})\b/i.exec(q);
  if (inYear) return { start: Number(inYear[1]), end: Number(inYear[1]) };
  return null;
}

export interface HistoricalPeerDeps {
  /** Population candidates for the reference year. Injected in tests. */
  candidateSource: PeerCandidateSource;
  /** The subject's ORI, population and label, resolved by the caller. */
  resolveSubject: (name: string, state: string) => { ori: string; population: number; year: number } | null;
}

export function buildHistoricalPeerComparisonPlan(
  question: string,
  deps: HistoricalPeerDeps,
  peerCountDefault = 5,
): HistoricalPeerPlan | null {
  if (!asksHistoricalPeerComparison(question)) return null;
  const metric = metricOf(question);
  if (!metric) return null;

  const resolution = resolveGeoPlaces(question);
  if (resolution.requiresClarification || resolution.mentions.length !== 1) return null;
  const candidate = resolution.mentions[0]?.candidates[0];
  if (!candidate || candidate.kind !== "city" || !candidate.state) return null;

  const subjectFacts = deps.resolveSubject(candidate.name, candidate.state);
  if (!subjectFacts) {
    return limitation(question, `I couldn't resolve a population for ${candidate.name} to size a peer group`);
  }

  let candidates: PeerCandidate[];
  try {
    candidates = deps.candidateSource({
      year: subjectFacts.year,
      excludeOri: subjectFacts.ori,
      population: subjectFacts.population,
    });
  } catch {
    candidates = [];
  }
  if (candidates.length === 0) {
    return limitation(question, "no comparable-population evidence was available for that year");
  }

  const subject: PeerCandidate = {
    ori: subjectFacts.ori, agency: candidate.name, state: candidate.state.toUpperCase(),
    population: subjectFacts.population,
  };
  const peerCount = requestedPeerCount(question) ?? peerCountDefault;
  const selection = selectPopulationPeers(subject, candidates, peerCount);
  if (selection.peers.length === 0) {
    return limitation(question, "no agency of comparable size could be found");
  }

  const oris = [subject.ori!, ...selection.peers.map(p => p.ori!)];
  const oriList = oris.map(sq).join(", ");

  // Apply an explicitly requested period to BOTH series, so the national comparison covers
  // the same years as the peers. Never describe a period that was not applied.
  const period = explicitPeriod(question);
  const agencyYearPredicate = period ? ` AND ${metric.kind === "homicide" ? "hac" : "hc"}.year BETWEEN ${period.start} AND ${period.end}` : "";
  const nationalYearPredicate = period ? ` AND ${metric.kind === "homicide" ? "hsn" : "ncr"}.year BETWEEN ${period.start} AND ${period.end}` : "";
  const periodText = period ? ` Covering ${period.start}–${period.end}, as requested.` : "";

  // The national series is selected separately and labelled separately — never averaged
  // into the peer group.
  const sql = metric.kind === "homicide"
    ? `SELECT 'Subject or peer' AS series, ha.agency AS place, hac.year, hac.murder AS value
FROM historical_agency ha
JOIN historical_agency_crime hac ON hac.ori = ha.ori
WHERE ha.ori IN (${oriList})${agencyYearPredicate}
UNION ALL
SELECT 'National' AS series, 'United States' AS place, hsn.year, hsn.murder AS value
FROM historical_state_national hsn
WHERE hsn.state = 'United States'${nationalYearPredicate}
ORDER BY series, place, year
LIMIT 5000`
    // historical_agency_clearance.violent_clr is ALREADY a percentage, and the national
    // clearance source is national_clearance_rate.violent_rate, also already a percentage.
    // Neither is multiplied by 100 again. historical_state_national carries no clearance
    // column at all, which is why the earlier version could not execute.
    : `SELECT 'Subject or peer' AS series, ha.agency AS place, hc.year, hc.violent_clr AS value
FROM historical_agency ha
JOIN historical_agency_clearance hc ON hc.ori = ha.ori
WHERE ha.ori IN (${oriList})${agencyYearPredicate}
UNION ALL
SELECT 'National' AS series, 'United States' AS place, ncr.year, ncr.violent_rate AS value
FROM national_clearance_rate ncr${period ? ` WHERE ncr.year BETWEEN ${period.start} AND ${period.end}` : ""}
ORDER BY series, place, year
LIMIT 5000`;

  return {
    sql,
    title: `${candidate.name} ${metric.label} vs peers and the national picture`,
    explanation:
      `This compares ${metric.label} for ${candidate.name} with its population peers, and shows the national ` +
      `figure as a separate series rather than folding it into the peer group.${periodText} ${selection.disclosure}`,
    columns: ["series", "place", "year", "value"],
    chartConfig: null,
    chartMeta: null,
    guardrail: "historical-peer-comparison",
    selectedOris: oris,
    expectedEntityCount: selection.entities.length,
    selectedLabels: selection.entities.map((e) => e.agency),
    selectedPeers: selection.entities.map((e) => ({ id: e.ori ?? null, label: e.agency })),
  };
}

function limitation(question: string, reason: string): HistoricalPeerPlan {
  const subject = /\bin\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)?)/.exec(question ?? "")?.[1] ?? "that place";
  return {
    sql: null,
    title: "Peer comparison unavailable",
    explanation: peerEvidenceUnavailable(subject, reason),
    columns: [],
    chartConfig: null,
    chartMeta: null,
    guardrail: "historical-peer-comparison-unavailable",
    selectedOris: [],
    expectedEntityCount: 0,
    selectedLabels: [],
    selectedPeers: [],
  };
}
