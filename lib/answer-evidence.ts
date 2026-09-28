/**
 * The evidence-to-answer boundary (closure review §4).
 *
 * WHY THIS EXISTS. Three rounds of corrections left the same class of defect: final
 * rendering rediscovered identity from the QUESTION after the result had already been
 * classified, so a failed request could still assert which agency the figures were for.
 * The second-same-class-defect rule says stop patching wording and fix the component.
 *
 * The fix is a carried record. Everything a factual claim may rest on is established
 * during the request and travels with it:
 *
 *   - what was actually RESOLVED before execution;
 *   - what identities the returned rows actually ESTABLISH;
 *   - what the result STATE is;
 *   - for a peer comparison, which members were selected and which came back.
 *
 * Final rendering reads only this record. It never re-parses the question for identity,
 * and it never makes a factual agency claim once the state is a failure or unknown.
 *
 * IDENTITY IS EXACT. Substring containment and pooled column aliases are not identity:
 * "York" is not "New York", an empty label is not a match, and one row carrying both
 * `agency` and `city` is one agency, not two.
 */

import type { ResolvedAgency } from "./agency-disclosure";
import type { ResultStateDecision } from "./result-state";

/** One established identity, from a single consistent role. */
export interface EstablishedIdentity {
  /** Stable id where the source has one (ORI). Preferred for matching. */
  id?: string | null;
  /** Display label, from ONE chosen column role — never a pool of aliases. */
  label: string;
}

export interface PeerContract {
  /** Identities selected on population alone, before execution. */
  selected: EstablishedIdentity[];
  /** Identities the executed query actually returned. */
  returned: EstablishedIdentity[];
}

export interface AnswerEvidence {
  /** The classified result state. Null only where no classification was made. */
  resultState?: ResultStateDecision | null;
  /** Agencies actually resolved before execution — a resolver's output, not a guess. */
  resolvedAgencies?: ResolvedAgency[];
  /** Identities the returned rows establish, from one consistent role. */
  returnedIdentities?: EstablishedIdentity[];
  /** Agencies the user asked for, for checking each requested member individually. */
  requestedAgencies?: ResolvedAgency[];
  /** Peer selection contract, when the answer is a peer comparison. */
  peers?: PeerContract | null;
  /**
   * Did the answer actually return figures? An agency claim describes RETURNED figures,
   * so with nothing returned there is nothing to attribute — independent of coverage.
   */
  hasFigures?: boolean;
}

/**
 * The AGENCY KIND a label states, or null when the label names only a place.
 *
 * Review §2B: the old normalizer deleted "police" and "sheriff" outright, so
 * "Bernalillo County Sheriff" and "Bernalillo County Police" reduced to the same key and
 * label equality alone could not prove that two different agencies in one place were one
 * entity. The kind is kept and compared instead of discarded.
 */
function agencyKind(value: string): "police" | "sheriff" | null {
  const v = String(value ?? "").toUpperCase();
  if (/\bSHERIFF/.test(v)) return "sheriff";
  if (/\bPOLICE\b|\bPD\b/.test(v)) return "police";
  return null;
}

/**
 * Normalized PLACE key. Exact after normalization — never substring.
 *
 * Agency-kind words are stripped here so "Seattle Police Department" and "Seattle" share a
 * place; the kind they stated is compared separately by `identitiesMatch`. State qualifiers
 * are NOT stripped: "Seattle, WA" keeps its state, because dropping it globally would merge
 * same-named agencies in different states. Cross-shape matching is the job of ids.
 */
export function identityKey(value: string): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\b(POLICE DEPARTMENT|POLICE DEPT|POLICE|DEPARTMENT|DEPT|SHERIFFS OFFICE|SHERIFF S OFFICE|SHERIFFS|SHERIFF|OFFICE|PD)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Two identities match when their ids match — or, with no ids, when they name the same
 * place AND state no CONFLICTING agency kind.
 *
 * Ids are authoritative and are used whenever both sides have one, which is why selected
 * peers now carry their ORI through the executed result. Labels are the fallback, and a
 * fallback that cannot distinguish a city's police from its sheriff would assert an
 * identity it has not established.
 */
export function identitiesMatch(a: EstablishedIdentity, b: EstablishedIdentity): boolean {
  if (a.id && b.id) return String(a.id).toUpperCase() === String(b.id).toUpperCase();
  const ka = identityKey(a.label);
  const kb = identityKey(b.label);
  if (!ka || !kb) return false;          // an empty label establishes nothing
  if (ka !== kb) return false;
  const ja = agencyKind(a.label);
  const jb = agencyKind(b.label);
  return ja === null || jb === null || ja === jb;
}

/**
 * Distinct identities from returned rows, using ONE column role.
 *
 * The role is chosen once for the whole result, in priority order, so a row carrying both
 * `agency` and `city` yields one identity rather than two alleged agencies. An `ori`
 * column, where present, supplies the stable id.
 */
const IDENTITY_ROLE_PRIORITY = ["agency", "agency_label", "place_label", "agency_name", "place", "city", "county"];

export function establishIdentities(rows: Record<string, unknown>[]): EstablishedIdentity[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const present = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) present.add(k.toLowerCase());
  const role = IDENTITY_ROLE_PRIORITY.find(c => present.has(c));
  if (!role) return [];
  const idCol = present.has("ori") ? "ori" : null;

  const seen = new Set<string>();
  const out: EstablishedIdentity[] = [];
  for (const r of rows) {
    let label: string | null = null;
    let id: string | null = null;
    for (const k of Object.keys(r)) {
      if (k.toLowerCase() === role) {
        const v = r[k];
        if (v !== null && v !== undefined && String(v).trim() !== "") label = String(v).trim();
      }
      if (idCol && k.toLowerCase() === idCol) {
        const v = r[k];
        if (v !== null && v !== undefined && String(v).trim() !== "") id = String(v).trim();
      }
    }
    if (!label) continue;
    const key = id ? `#${id.toUpperCase()}` : identityKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id, label });
  }
  return out;
}

/**
 * May this answer make a factual claim about which agency the figures represent?
 *
 * THE UNCERTAINTY IS SPECIFIC TO THE CLAIM (review §2A). Two different things were being
 * conflated: uncertainty about COVERAGE/REPORTING, and uncertainty about AGENCY IDENTITY.
 *
 * `genericResultState({sql, rows})` returns `unknown` for ordinary successful results,
 * because it cannot establish the empty/zero classifier's coverage and reporting
 * conditions — and every successful route caller supplies exactly that state. Banning
 * agency disclosure on `unknown` therefore removed the approved sheriff and
 * separate-agency disclosures from real successful answers.
 *
 * The rule that actually holds:
 *   - a PRODUCT FAILURE returned no figures, so nothing may be attributed to an agency;
 *   - an answer with NO RETURNED ROWS has no figures to attribute either, whatever the
 *     coverage state;
 *   - otherwise identity established independently — from the returned rows, or from a
 *     resolver's carried decision — stands on its own, and unknown coverage does not
 *     suppress it.
 *
 * Unresolved identity still authorizes nothing: that is enforced separately, by requiring
 * an established identity before any claim is rendered.
 */
export function mayAssertAgencyFacts(evidence: AnswerEvidence): boolean {
  if (evidence.resultState?.state === "product_failure") return false;
  return evidence.hasFigures === true;
}

export interface MemberCheck {
  /** Requested members positively established in the returned identities. */
  present: ResolvedAgency[];
  /** Requested members NOT established. */
  absent: ResolvedAgency[];
  /** True only when every requested member was individually established. */
  allPresent: boolean;
}

/** Check EACH requested member individually, never a count of labels. */
export function checkRequestedMembers(
  requested: ResolvedAgency[],
  returned: EstablishedIdentity[],
): MemberCheck {
  const present: ResolvedAgency[] = [];
  const absent: ResolvedAgency[] = [];
  for (const req of requested) {
    const want: EstablishedIdentity = { label: req.agencyName || req.requested };
    if (returned.some(r => identitiesMatch(want, r))) present.push(req);
    else absent.push(req);
  }
  return { present, absent, allPresent: absent.length === 0 && requested.length > 0 };
}
