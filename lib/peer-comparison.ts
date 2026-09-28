/**
 * Increment 5 — population-based peer comparison (frozen Decision 16).
 *
 * A shared, pure policy core. Given a subject agency, a requested number of peers, and a
 * candidate list the adapter supplied, it selects peers and describes the selection.
 *
 * WHY THIS EXISTS. All eight Decision 16 expectations failed: the product either returned
 * the wrong number of agencies or never said how the peers were chosen. Decision 16 is
 * specific — peers are selected by POPULATION ALONE, and the answer must name the band
 * used and every peer included. "Similar agencies" chosen by an unstated rule is not a
 * comparison a reader can check.
 *
 * The subject agency counts toward the returned set: "compare X against 3 similar
 * agencies" returns FOUR entities, and "add X and increase to 8 comparable agencies"
 * returns NINE. That reading is the frozen one (GC-115 expects 4, GC-116 expects 9).
 */

import { identityKey, identitiesMatch, type EstablishedIdentity } from "./answer-evidence";

export interface PeerCandidate {
  agency: string;
  state: string;
  population: number;
  /** Stable identifier, used so two same-named agencies never collapse. */
  ori?: string;
}

export interface PeerSubject extends PeerCandidate {}

export interface PeerSelection {
  /** The subject plus its peers, subject first. */
  entities: PeerCandidate[];
  /** Peers only, in selection order. */
  peers: PeerCandidate[];
  /** Inclusive population band actually spanned by the returned set. */
  band: { min: number; max: number };
  /** The sentence naming the band and every peer. */
  disclosure: string;
  /** Set when the request could not be met as asked. */
  shortfall: string | null;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const label = (c: PeerCandidate) => `${c.agency}, ${c.state}`;

/**
 * Select `peerCount` peers nearest the subject by population.
 *
 * Selection is on population and nothing else — not region, not crime volume, not
 * reporting quality. Ties break on the absolute population gap, then on name, so the
 * result is deterministic and reproducible.
 */
export function selectPopulationPeers(
  subject: PeerSubject,
  candidates: PeerCandidate[],
  peerCount: number,
): PeerSelection {
  const sameAgency = (a: PeerCandidate, b: PeerCandidate) =>
    a.ori && b.ori ? a.ori === b.ori : a.agency === b.agency && a.state === b.state;

  const pool = candidates
    .filter(c => !sameAgency(c, subject))
    .filter(c => Number.isFinite(c.population) && c.population > 0);

  const ranked = [...pool].sort((a, b) => {
    const da = Math.abs(a.population - subject.population);
    const db = Math.abs(b.population - subject.population);
    if (da !== db) return da - db;
    return label(a).localeCompare(label(b));
  });

  const peers = ranked.slice(0, Math.max(0, peerCount));
  const entities = [subject, ...peers];
  const pops = entities.map(e => e.population);
  const band = { min: Math.min(...pops), max: Math.max(...pops) };

  const shortfall = peers.length < peerCount
    ? `Only ${peers.length} comparable ${peers.length === 1 ? "agency" : "agencies"} were available, not the ${peerCount} requested.`
    : null;

  return { entities, peers, band, disclosure: describePeerSelection(subject, peers, band, shortfall), shortfall };
}

/**
 * The required sentence: how peers were chosen, the band, and every peer by name.
 *
 * Decision 16 needs all three. A band without names cannot be checked, and names without
 * the rule leave the reader guessing why these agencies and not others.
 */
export function describePeerSelection(
  subject: PeerSubject,
  peers: PeerCandidate[],
  band: { min: number; max: number },
  shortfall: string | null = null,
): string {
  if (peers.length === 0) {
    return `No comparable agencies were available for ${label(subject)}, so no peer comparison is shown.`;
  }
  const names = peers.map(label);
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return (
    `Peers were selected on population alone — the ${peers.length} agencies closest in size to ${label(subject)} ` +
    `(${fmt(subject.population)}). The comparison covers populations from ${fmt(band.min)} to ${fmt(band.max)}, ` +
    `and includes ${list}.` + (shortfall ? ` ${shortfall}` : "")
  );
}

/**
 * How many entities a peer request should return, including the subject.
 * "against 3 agencies of similar size" -> 4.  "increase to 8 comparable agencies" -> 9.
 */
export function expectedEntityCount(peerCount: number): number {
  return Math.max(0, peerCount) + 1;
}

/** Extract the requested peer count from a question. Returns null when unstated. */
export function requestedPeerCount(question: string): number | null {
  const q = question ?? "";
  const m = /\b(\d{1,2})\s+(?:other\s+|more\s+)?(?:agenc|cit|department|peer|comparable|similar)/i.exec(q)
    ?? /\b(?:to|against|with)\s+(\d{1,2})\b/i.exec(q);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 && n <= 50 ? n : null;
}

// ── membership verification: what was selected vs what came back ──

export interface MembershipCheck {
  /** Selected identities that produced no rows. */
  missing: string[];
  /** True when every selected identity is represented in the result. */
  complete: boolean;
  /** Sentence to append when something is missing. Empty when complete. */
  disclosure: string;
}

/**
 * Compare the selected peer membership with the evidence that actually came back.
 *
 * Decision 16 names every peer in the explanation. If a named peer produced no rows, the
 * reader is being told the comparison includes an agency it does not. The fix is NOT to
 * swap in another agency — that would make selection depend on data availability rather
 * than population, which Decision 16 forbids. The fix is to say so.
 *
 * IDENTITY IS THE SOURCE ID, NOT THE DISPLAY LABEL (review §2B). Selection happens before
 * execution and holds each peer's ORI; the executed result now carries that same ORI back.
 * Membership is decided on those ids, so a result that labels Seattle "SEATTLE, WA" while
 * selection recorded "SEATTLE" is still the same agency — without stripping state
 * qualifiers globally, and without restoring substring matching. Labels remain the display
 * form and are what the disclosure names.
 *
 * Strings are still accepted for callers with no id to carry; those fall back to exact
 * place-and-kind label matching.
 */
type MembershipInput = string | EstablishedIdentity;

const asIdentity = (v: MembershipInput): EstablishedIdentity =>
  typeof v === "string" ? { label: v } : { id: v.id ?? null, label: v.label };

export function verifyPeerMembership(
  selected: MembershipInput[],
  returned: MembershipInput[],
): MembershipCheck {
  // EXACT identity, never substring containment. "York" is not "New York", and an empty
  // returned label establishes nothing at all — both previously reported a complete
  // comparison (closure review §3B). Each selected member is checked individually; a count
  // of labels is not a membership check.
  const have = returned.map(asIdentity).filter(r => (r.id && String(r.id).trim()) || identityKey(r.label));
  const missingIdentities = selected.map(asIdentity).filter(sel => {
    if (!(sel.id && String(sel.id).trim()) && !identityKey(sel.label)) return true;   // unnameable -> unconfirmable
    return !have.some(r => identitiesMatch(sel, r));
  });
  const missing = missingIdentities.map(m => m.label || String(m.id));
  if (missing.length === 0) return { missing: [], complete: true, disclosure: "" };
  const list = missing.length === 1
    ? missing[0]
    : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return {
    missing,
    complete: false,
    disclosure:
      `${list} ${missing.length === 1 ? "was" : "were"} selected as a population peer but returned no data for this ` +
      `measure and period, so ${missing.length === 1 ? "it is" : "they are"} not in the comparison. ` +
      `Peers are chosen on population alone, so no substitute was put in ${missing.length === 1 ? "its" : "their"} place.`,
  };
}
