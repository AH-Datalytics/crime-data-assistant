/**
 * SHR agency classification under Jeff's approved policy (2026-09-30; Codex SHR correction ruling):
 * evidence-backed derived classifications, bound to the agency identifier and state, with their period
 * basis retained, conflicts rejected and the origin disclosed. Name guesses and untraceable legacy labels
 * are never evidence.
 *
 * WHY THIS EXISTS. The SHR master file records no agency type, and the importer never stored one (SHR
 * identity read, 2026-09-30). Every `incidents.agency_type` value was written by the identity normalizer,
 * from the agency's own earlier values (origin unknown), a NIBRS lookup, or a name-pattern default. So the
 * SHR city ranking does not read `incidents.agency_type` at all.
 *
 * THE EVIDENCE: the NIBRS database's classification, `agencies.agency_type`, per agency-year. It is the
 * NIBRS database's own value, not a newly established raw FBI field: where the FBI file gave no type, this
 * project's NIBRS pipeline derives one from the population group (groups 1-7 City, 8-9 County;
 * scripts/nibrs-auto-update.py, scripts/finish-rebuild.py). It is written into shr.db by
 * `scripts/build-shr-agency-type-evidence.ts`, DATED AND STATE-BOUND (Codex classification review, SC-1):
 *   - SHR carries the legacy 7-character ORI; NIBRS the 9-character one, which is LOOKED UP, never
 *     constructed: every NIBRS ORI of length 9 that begins with the SHR ORI and has at least one row in the
 *     SHR agency's state is a candidate. No name matching: a guess is left unresolved, not made.
 *   - `shr_agency_type_evidence` keeps EVERY row of each candidate -- its year, its own recorded state and its
 *     type -- so nothing from another state is relabeled as this state's, and nothing from a later year is
 *     needed to decide an earlier one.
 *   - `shr_agency_type_binding` records that the SHR agency was assessed, and its candidates.
 *
 * THE RULE, for a ranking of year Y (`classifyShrAgency`), from ONE period-bound selection (`loadShrTypeEvidence`):
 * the candidates for Y are the stored identifiers with a same-state row through Y, and every row through Y of
 * each of them is assessed. The build's all-time candidate list only describes what was collected; it never
 * decides a year, so a match that appears only after Y changes nothing about Y (Codex SHR ranking result).
 *   - unresolved: the evidence was never built; the agency was not assessed; no candidate at all; no
 *     candidate with a same-state row through Y; a candidate with a row through Y recorded under ANOTHER state
 *     (inconsistent identity metadata: rejected, not borrowed); SEVERAL candidates through Y (contemporaneous
 *     ambiguity); only blank types; or more than one type in those years (a conflict: rejected, not resolved
 *     by picking the latest).
 *   - eligible (City) / ineligible (anything else): exactly one candidate, all its rows up to Y in the state,
 *     and every typed year up to Y the same type. Years with no type are not counted as evidence; when the
 *     last typed year is before Y, the type is CARRIED FORWARD from it -- an inference, stated as one. The
 *     basis (source, NIBRS ORI, typed years, blank years, carry-forward) travels with the decision.
 */
import type Database from "better-sqlite3";
import type { CityMembership } from "./entity-authority";

export const SHR_TYPE_BINDING_TABLE = "shr_agency_type_binding";
export const SHR_TYPE_EVIDENCE_TABLE = "shr_agency_type_evidence";
export const SHR_TYPE_SOURCE = "NIBRS agencies.agency_type";

/** The two evidence tables, as `scripts/build-shr-agency-type-evidence.ts` creates them (one definition). */
export const SHR_TYPE_EVIDENCE_DDL = `
  CREATE TABLE ${SHR_TYPE_BINDING_TABLE} (
    ori TEXT NOT NULL, state TEXT NOT NULL,
    candidate_oris TEXT NOT NULL, built_at TEXT NOT NULL,
    PRIMARY KEY (ori, state)
  );
  CREATE TABLE ${SHR_TYPE_EVIDENCE_TABLE} (
    ori TEXT NOT NULL, state TEXT NOT NULL, nibrs_ori TEXT NOT NULL, year INTEGER NOT NULL,
    nibrs_state TEXT NOT NULL, agency_type TEXT NOT NULL, source TEXT NOT NULL,
    PRIMARY KEY (ori, state, nibrs_ori, year)
  );
`;

export type ShrTypeUnresolvedReason =
  | "evidence-not-built" | "not-assessed" | "no-nibrs-match" | "no-nibrs-year" | "state-conflict"
  | "several-nibrs-matches" | "blank-type" | "type-changed";

export const UNRESOLVED_REASON_TEXT: Record<ShrTypeUnresolvedReason, string> = {
  "evidence-not-built": "no agency-type evidence has been built for SHR",
  "not-assessed": "the agency was not in the evidence build",
  "no-nibrs-match": "its identifier matches no NIBRS agency in its state",
  "no-nibrs-year": "no NIBRS agency matching its identifier has a year in its state up to the ranking year",
  "state-conflict": "its matching NIBRS agency is recorded under another state in those years",
  "several-nibrs-matches": "its identifier matches several NIBRS agencies in those years",
  "blank-type": "NIBRS records no type for it in those years",
  "type-changed": "NIBRS recorded more than one type for it in those years",
};

/** One candidate NIBRS agency's rows for the years up to the ranking year. */
export type ShrTypeCandidate = {
  nibrsOri: string; otherStateRows: number; distinctTypes: number; agencyType: string | null;
  typedYears: number[]; blankYears: number[];
};
/** One SHR agency's evidence, as read for a ranking year (`loadShrTypeEvidence`). */
export type ShrTypeEvidence = { assessed: boolean; candidateOris: string[]; candidates: ShrTypeCandidate[] };

export type ShrTypeBasis = {
  source: string; nibrsOri: string;
  /** Years whose NIBRS row carries the type, ascending. */
  typedYears: number[];
  /** Years up to the ranking year whose NIBRS row carries no type (not counted as evidence), ascending. */
  blankYears: number[];
  /** The last typed year, when it is before the ranking year: the type is carried forward from it. */
  carriedForwardFrom: number | null;
};

export type ShrClassification =
  | { membership: Exclude<CityMembership, "unresolved">; agencyType: string; basis: ShrTypeBasis }
  | { membership: "unresolved"; reason: ShrTypeUnresolvedReason };

export function classifyShrAgency(evidence: ShrTypeEvidence | null, built: boolean, year: number): ShrClassification {
  if (!built) return { membership: "unresolved", reason: "evidence-not-built" };
  if (!evidence || !evidence.assessed) return { membership: "unresolved", reason: "not-assessed" };
  if (evidence.candidates.length === 0) {
    return { membership: "unresolved", reason: evidence.candidateOris.length === 0 ? "no-nibrs-match" : "no-nibrs-year" };
  }
  if (evidence.candidates.some((c) => c.otherStateRows > 0)) return { membership: "unresolved", reason: "state-conflict" };
  if (evidence.candidates.length > 1) return { membership: "unresolved", reason: "several-nibrs-matches" };
  const c = evidence.candidates[0];
  if (c.distinctTypes === 0 || !c.agencyType || c.typedYears.length === 0) return { membership: "unresolved", reason: "blank-type" };
  if (c.distinctTypes > 1) return { membership: "unresolved", reason: "type-changed" };
  const last = c.typedYears[c.typedYears.length - 1];
  return {
    membership: c.agencyType === "City" ? "eligible" : "ineligible",
    agencyType: c.agencyType,
    basis: { source: SHR_TYPE_SOURCE, nibrsOri: c.nibrsOri, typedYears: c.typedYears, blankYears: c.blankYears, carriedForwardFrom: last < year ? last : null },
  };
}

export const shrAgencyKey = (ori: string, state: string) => `${ori}|${state}`;

export type ShrTypeEvidenceSet = { built: boolean; year: number; byAgency: Map<string, ShrTypeEvidence> };

const tableExists = (db: Database.Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

const years = (list: string | null) => (list ? list.split(",").map(Number).filter(Number.isInteger).sort((a, b) => a - b) : []);

/**
 * The application's own read of the evidence for a ranking year (like `lib/shr-county-scope.ts`'s identity
 * read, not an answer statement), aggregated per candidate over the years up to that year only. Missing
 * tables mean the evidence was never built: every agency is then unresolved, and the answer says so.
 */
export function loadShrTypeEvidence(db: Database.Database, year: number): ShrTypeEvidenceSet {
  if (!Number.isInteger(year)) throw new Error(`shr-agency-classification: invalid year ${year}`);
  if (!tableExists(db, SHR_TYPE_BINDING_TABLE) || !tableExists(db, SHR_TYPE_EVIDENCE_TABLE)) return { built: false, year, byAgency: new Map() };
  const byAgency = new Map<string, ShrTypeEvidence>();
  for (const b of db.prepare(`SELECT ori, state, candidate_oris FROM ${SHR_TYPE_BINDING_TABLE}`).all() as { ori: string; state: string; candidate_oris: string }[]) {
    byAgency.set(shrAgencyKey(b.ori, b.state), { assessed: true, candidateOris: JSON.parse(b.candidate_oris), candidates: [] });
  }
  // ONE period-bound decision (Codex SHR ranking result; SC-1): a stored identifier is a candidate for year Y only
  // if it has a same-state row through Y, and then EVERY one of its rows through Y -- other-state ones included, so
  // conflicts are refused, not hidden -- is assessed. An identifier admitted to the build only by a same-state row
  // after Y is not a candidate for Y, and its older rows cannot touch Y's decision.
  for (const r of db.prepare(
    "SELECT e.ori, e.state, e.nibrs_ori, SUM(CASE WHEN e.nibrs_state <> e.state THEN 1 ELSE 0 END) AS other_state_rows," +
    " COUNT(DISTINCT NULLIF(e.agency_type, '')) AS distinct_types, MIN(NULLIF(e.agency_type, '')) AS agency_type," +
    " GROUP_CONCAT(CASE WHEN e.agency_type <> '' THEN e.year END) AS typed_years, GROUP_CONCAT(CASE WHEN e.agency_type = '' THEN e.year END) AS blank_years" +
    ` FROM ${SHR_TYPE_EVIDENCE_TABLE} e WHERE e.year <= ?` +
    ` AND EXISTS (SELECT 1 FROM ${SHR_TYPE_EVIDENCE_TABLE} s WHERE s.ori = e.ori AND s.state = e.state AND s.nibrs_ori = e.nibrs_ori AND s.year <= ? AND s.nibrs_state = s.state)` +
    " GROUP BY e.ori, e.state, e.nibrs_ori ORDER BY e.ori, e.state, e.nibrs_ori",
  ).all(year, year) as { ori: string; state: string; nibrs_ori: string; other_state_rows: number; distinct_types: number; agency_type: string | null; typed_years: string | null; blank_years: string | null }[]) {
    const e = byAgency.get(shrAgencyKey(r.ori, r.state));
    if (!e) continue;                                    // evidence without an assessment row is not trusted
    e.candidates.push({ nibrsOri: r.nibrs_ori, otherStateRows: r.other_state_rows, distinctTypes: r.distinct_types, agencyType: r.agency_type,
      typedYears: years(r.typed_years), blankYears: years(r.blank_years) });
  }
  return { built: true, year, byAgency };
}

/** Years as words: every year when there are few, otherwise how many and between which -- never implying the gaps are filled. */
export function yearsPhrase(ys: number[]): string {
  if (ys.length === 0) return "no year";
  if (ys.length <= 4) return ys.length === 1 ? String(ys[0]) : `${ys.slice(0, -1).join(", ")} and ${ys[ys.length - 1]}`;
  return `${ys.length} years between ${ys[0]} and ${ys[ys.length - 1]}`;
}

/** The disclosed basis of one classification, e.g. "City in 2023; no type in 2025; carried forward from 2023". */
export function basisPhrase(agencyType: string, b: ShrTypeBasis): string {
  const parts = [`${agencyType} in ${yearsPhrase(b.typedYears)}`];
  if (b.blankYears.length > 0) parts.push(`no type in ${yearsPhrase(b.blankYears)}`);
  if (b.carriedForwardFrom !== null) parts.push(`carried forward from ${b.carriedForwardFrom}`);
  return parts.join("; ");
}
