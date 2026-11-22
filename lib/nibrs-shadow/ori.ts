/**
 * Agency IDs (ORIs), a scatter plot and a CSV request: reader rules for P216, P217 and P218.
 *
 *   "What agency is ORI NJ0225500?"                   the agency and its place (P218)
 *   "NYPD's ORI", "new orleans ori"                    the ID
 *   "firearm murders for ORI TXHPD00 since 2018"       an ORI as the place of any question, said in a note
 *   "firearm murders for ORI ZZ00000"                  an ID no agency has: declined, naming it
 *   "pop_group starting with 1"                        declined: population groups are not defined here
 *   "give me a scatter plot of X vs Y"                 declined, X and Y offered as two questions (P216)
 *   "a csv of murder rate per 100k for every state"    the table (P217): the request words are only words
 *   "can I download this?"                             one sentence pointing to the table's CSV button
 */
import { agencyLabel, agencyName, resolvePlace, STATE_NAMES, type Agency, type PlaceIndex } from "./places";
import { readQuestion } from "./reading";
import type { CoverageAnswer } from "./coverage";
import type { ShadowDeps } from "./answer";

const BY_ORI = new WeakMap<object, Map<string, Agency>>();
function oriIndex(idx: PlaceIndex): Map<string, Agency> {
  const hit = BY_ORI.get(idx);
  if (hit) return hit;
  const m = new Map<string, Agency>();
  for (const list of idx.byName.values()) for (const a of list) m.set(a.ori.toUpperCase(), a);
  BY_ORI.set(idx, m);
  return m;
}
/** The agency an ID names: the full nine characters, or a shorter ID that begins exactly one agency's ("TXHPD00" is TXHPD0000). */
export function agencyOfOri(idx: PlaceIndex, token: string): Agency | null {
  const t = token.toUpperCase(), all = oriIndex(idx);
  const exact = all.get(t);
  if (exact) return exact;
  if (t.length < 5 || t.length >= 9) return null;
  const hits = [...all.entries()].filter(([k]) => k.startsWith(t));
  return hits.length === 1 ? hits[0][1] : null;
}
/** An agency the FBI's list names but the place index does not hold (a small agency): its ID, FBI name and state (the ID's first two letters). */
function namedOnly(idx: PlaceIndex, token: string): { ori: string; name: string; state: string } | null {
  const t = token.toUpperCase();
  const one = (ori: string) => ({ ori, name: agencyName(idx, ori), state: ori.slice(0, 2) === "NB" ? "NE" : ori.slice(0, 2) });
  if (idx.names.has(t)) return one(t);
  if (t.length < 5 || t.length >= 9) return null;
  const hits = [...idx.names.keys()].filter((k) => k.toUpperCase().startsWith(t));
  return hits.length === 1 ? one(hits[0]) : null;
}

const ORI_TOKEN = String.raw`(?:ORI|agency\s+(?:ID|code))\s*[:#]?\s*([A-Za-z]{2}[A-Za-z0-9]{3,7})\b`;
const ORI_RE = new RegExp(String.raw`\b${ORI_TOKEN}`, "i");

/** A one-sentence answer, in the shape of the data questions' pointers (coverage.ts), with the agency named in a one-row table. */
function sentence(title: string, text: string[], deps: ShadowDeps, rows: string[][] = []): CoverageAnswer {
  const span = { from: deps.release.firstMonth, to: deps.release.lastMonth };
  const txt = (dimension: string, header: string) => ({ binding: { kind: "grouping" as const, dimension }, header });
  return { kind: "coverage", shape: "definitions", period: span,
    meaning: { source: "nibrs", places: [], filters: [], measures: [{ name: title, unit: "agency" }], period: span, groupings: [], statistic: "count" },
    delivered: { table: { columns: [txt("coverage.agency_id", "Agency ID"), txt("coverage.agency", "Agency")], rows }, text },
    read: { table: "agency list", release: deps.release.id } };
}
const placeOf = (a: Agency) => agencyLabel(a);
const nameOf = (deps: ShadowDeps, a: Agency) => agencyName(deps.places, a.ori);
const the = (n: string) => (/^(?:the\s)/i.test(n) ? n : `the ${n}`);

export type OriReading =
  | { kind: "outcome"; outcome: CoverageAnswer | { kind: "decline"; explanation: string } }
  | { kind: "rewrite"; rewritten: string; note: string };

/** "pop_group" is a column of the FBI's agency list, not something defined here. */
export const POP_GROUP = /\bpop(?:ulation)?[_\s]?group\b/i;
export const POP_GROUP_SENTENCE = "This isn't available: population groups (pop_group) aren't defined here.";

export function readOri(question: string, deps: ShadowDeps): OriReading | null {
  const q = question.replace(/\s+/g, " ").trim();
  // "Is it not ORI AL00118?": "it" has no antecedent and no figure is named, so it stays the question asked back (Engine 2.0 and Model).
  if (/^\W*(?:is|are|was|were)\s+(?:it|that|this)\b/i.test(q) && !POP_GROUP.test(q)) return null;
  if (POP_GROUP.test(q)) return { kind: "outcome", outcome: { kind: "decline", explanation: POP_GROUP_SENTENCE } };
  const m = ORI_RE.exec(q);
  if (m) {
    const token = m[1].toUpperCase(), a = agencyOfOri(deps.places, token);
    if (!a) {
      const small = namedOnly(deps.places, token);
      if (!small) return { kind: "outcome", outcome: { kind: "decline", explanation: `No agency has the ID ${token}.` } };
      const state = STATE_NAMES[small.state] ?? small.state;
      if (/^(?:what|which)\s+agency\s+(?:is|has|uses)\s+(?:the\s+)?(?:ORI|agency\s+(?:ID|code))\s*[:#]?\s*[A-Za-z0-9]+\s*\??$/i.test(q) || /^(?:ORI|agency\s+(?:ID|code))\s*[:#]?\s*[A-Za-z0-9]+\s*\??$/i.test(q))
        return { kind: "outcome", outcome: sentence("Agency ID", [`ORI ${small.ori} is ${the(small.name)}, in ${state}.`, "Source: FBI NIBRS."], deps, [[small.ori, small.name]]) };
      return { kind: "outcome", outcome: { kind: "decline", explanation: `ORI ${small.ori} is ${the(small.name)}, in ${state}, but figures for that agency by its ID aren't available; ask for it by name.` } };
    }
    // "What agency is ORI X?": the agency and its place.
    if (/^(?:what|which)\s+agency\s+(?:is|has|uses)\s+(?:the\s+)?(?:ORI|agency\s+(?:ID|code))\s*[:#]?\s*[A-Za-z0-9]+\s*\??$/i.test(q) || /^(?:ORI|agency\s+(?:ID|code))\s*[:#]?\s*[A-Za-z0-9]+\s*\??$/i.test(q)) {
      const name = nameOf(deps, a);
      return { kind: "outcome", outcome: sentence("Agency ID", [`ORI ${a.ori} is ${the(name)}, in ${placeOf(a)}.`, "Source: FBI NIBRS."], deps, [[a.ori, name]]) };
    }
    // An ORI written as the place of any other question: that agency, said in a note.
    const place = placeOf(a);
    return { kind: "rewrite", rewritten: q.replace(ORI_RE, place), note: `ORI ${token} is ${the(nameOf(deps, a))}.` };
  }
  // "NYPD's ORI", "new orleans ori", "what is the ORI for Houston PD?": the ID.
  if (/\b(?:ORI|agency\s+(?:ID|code))\b/i.test(q) && !/\b\d{4}\b/.test(q)) {
    const stripped = q.replace(/\b(?:what(?:'s|\s+is)|give\s+me|show\s+me|tell\s+me)\s+/gi, "").replace(/\b(?:the\s+)?(?:ORI|agency\s+(?:ID|code))(?:\s+(?:code|number|id))?(?:\s+(?:for|of))?\b/gi, "")
      .replace(/(?:'s|s')\s*(?=\?|$)/i, "").replace(/\b(?:the|for|of|is)\s*$/i, "").replace(/\s+/g, " ").replace(/[?.!]+$/, "").trim();
    if (!stripped) return null;
    const r = readQuestion(stripped, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth);
    const parts = r.ledger.parts.filter((p) => p.clause === 0 && p.concept === "place");
    if (parts.length !== 1) return null;
    const res = resolvePlace(deps.places, String(parts[0].value), parts[0].text);
    if (res.kind !== "agency") return null;
    const name = nameOf(deps, res.agency);
    return { kind: "outcome", outcome: sentence("Agency ID", [`The ORI (agency ID) of ${the(name)} is ${res.agency.ori}.`, "Source: FBI NIBRS."], deps, [[res.agency.ori, name]]) };
  }
  return null;
}

/** "Give me a scatter plot of A vs B": declined in one sentence; A and B offered as two questions (P216), never a chart (P157). */
export const SCATTER = /\bscatter\s*(?:-|\s)?(?:plots?|charts?|graphs?|diagrams?)?\b/i;
export const SCATTER_SENTENCE = "This isn't available: a scatter plot, and a crime rate beside staffing in one table.";
export function scatterQuestions(question: string): string[] {
  const m = /\bscatter\s*(?:-|\s)?(?:plots?|charts?|graphs?|diagrams?)?\s+(?:of|for|showing|with|comparing)\s+(.+?)\s+(?:vs\.?|versus|against|and|compared\s+(?:to|with))\s+(.+?)[?.!]*$/i.exec(question.replace(/\s+/g, " "));
  if (!m) return [];
  // The scope after the second part ("in cities of 250k or more") and a year beside the first apply to both.
  const scope = /\s+(in\s+(?:cities|the\s+cities|all\s+cities|texas|[a-z]+\s+cities)\b.*)$/i.exec(m[2]);
  const a0 = m[1].trim(), b0 = (scope ? m[2].slice(0, scope.index) : m[2]).trim();
  const year = /\b((?:in|for)\s+(?:19|20)\d{2})\b/i.exec(a0)?.[1] ?? /\b((?:in|for)\s+(?:19|20)\d{2})\b/i.exec(b0)?.[1];
  const withYear = (s: string) => (year && !/\b(?:19|20)\d{2}\b/.test(s) ? `${s} ${year}` : s);
  const withScope = (s: string) => (scope && !/\bcities\b/i.test(s) ? `${s} ${scope[1]}` : s);
  return [withScope(withYear(a0)), withScope(withYear(b0))].map((s) => s.replace(/\s+/g, " ").trim());
}

/** "Can I download this?" with no figure named: one sentence (P217). */
export const DOWNLOAD_ASK = /^\W*(?:(?:hi|hey|ok|okay|and|so|please)\W+)*(?:can|could|may|is\s+it\s+possible\s+to|how\s+(?:can|do)\s+i)\s+(?:i|we|you)?\s*(?:please\s+)?(?:download|export|save|get)\s+(?:this|that|it|the\s+(?:table|data|results?|numbers))(?:\s+(?:as\s+(?:an?\s+)?(?:csv|excel|spreadsheet)(?:\s+file)?|to\s+(?:csv|excel)|by\s+state))?\s*\??\W*$/i;
export const DOWNLOAD_SENTENCE = "This table can be downloaded as a CSV.";
export const downloadAnswer = (deps: ShadowDeps): CoverageAnswer => ({ ...sentence("Download", [DOWNLOAD_SENTENCE], deps), delivered: { table: { columns: [], rows: [] }, text: [DOWNLOAD_SENTENCE] } });

/** A request for a CSV, a spreadsheet or an export of a figure: the figure's question without the request words (the table is the answer), or null. */
export function withoutCsvWords(question: string): string | null {
  let s = question.replace(/\s+/g, " ");
  const before = s;
  s = s.replace(/^\W*(?:(?:can|could|would|will)\s+(?:you|i|we)\s+(?:please\s+)?(?:give|get|send|show|provide|make|create|pull|export|download)\s+(?:me\s+)?|(?:i\s+(?:want|need|would\s+like)|please|give\s+me|get\s+me|show\s+me|send\s+me|make\s+me)\s+)?(?:an?\s+|the\s+)?(?:csv|spreadsheet|excel(?:\s+file)?|export)(?:\s+file)?\s+(?:of|for|with)\s+/i, "");
  s = s.replace(/\s*,?\s*\b(?:as|in|to)\s+(?:an?\s+)?(?:csv|excel|spreadsheet)(?:\s+(?:file|format))?\b/gi, "");
  s = s.replace(/\s+/g, " ").replace(/\s+([?.!,])/g, "$1").trim();
  return s !== before && /[a-z]{3}/i.test(s) ? s : null;
}
