/**
 * Increment 4 — clear disclosure of the agency used for a place (frozen Decision 10).
 *
 * A shared, pure policy core. Given what the resolver decided, it produces the sentence
 * that tells the reader which agency the figures actually came from.
 *
 * WHY THIS EXISTS. Decision 10 says a county name means the sheriff's agency — and that
 * the answer must SAY SO, so the reader can ask for the countywide figure if that is what
 * they wanted. The resolver already picks the right agency; 8 of the 9 Decision 10
 * failures were `sheriff_disclosed`, i.e. the product resolved correctly and then said
 * nothing about it. A sheriff's office does not police the whole county, so a reader who
 * assumes "Worcester County" means everyone inside the county is being misled by silence.
 *
 * This module renders a sentence; it does not choose the agency. Keeping the choice where
 * it already lives (the resolvers) and the disclosure here is what stops the two drifting.
 */

export type ResolvedAgencyKind = "county_sheriff" | "city_police" | "state" | "national" | "other";

export interface ResolvedAgency {
  /** The place the user named, in their words where possible. */
  requested: string;
  /** The agency whose rows were actually used. */
  agencyName: string;
  kind: ResolvedAgencyKind;
  state?: string | null;
}

export interface AgencyDisclosure {
  /** True when the resolution needs to be stated. */
  required: boolean;
  /** The sentence to add. Empty when not required. */
  sentence: string;
  reason: string;
}

/**
 * A county request answered by a sheriff's agency must be disclosed. A city request
 * answered by that city's police department needs no sentence — nothing was substituted.
 */
export function describeAgencyUsed(resolved: ResolvedAgency): AgencyDisclosure {
  const where = resolved.state ? `${resolved.agencyName}, ${resolved.state}` : resolved.agencyName;

  if (resolved.kind === "county_sheriff") {
    return {
      required: true,
      reason: "a county name was answered with the sheriff's agency",
      sentence:
        `These figures are for ${where} — the county sheriff's agency, which is what "${resolved.requested}" resolves to here. ` +
        `They don't include the city police departments inside the county. Ask for those by name if you want a countywide picture.`,
    };
  }
  return { required: false, sentence: "", reason: "no substitution was made" };
}

/**
 * Two or more agencies asked for by name must come back separately, each identified.
 * Decision 10's `both` stance: "show me X police and Y county sheriff" is two answers.
 */
export function describeMultiAgency(resolved: ResolvedAgency[]): AgencyDisclosure {
  if (resolved.length < 2) return { required: false, sentence: "", reason: "fewer than two agencies" };
  const named = resolved.map(r => (r.state ? `${r.agencyName}, ${r.state}` : r.agencyName));
  const anySheriff = resolved.some(r => r.kind === "county_sheriff");
  return {
    required: true,
    reason: "several agencies were named and must be reported separately",
    sentence:
      `These figures are reported separately for ${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}` +
      (anySheriff
        ? ", and the county figures are the sheriff's agency only, not every department inside the county."
        : ".") ,
  };
}

/**
 * Whether a disclosure sentence is already present, so the control never duplicates one
 * the model happened to write itself.
 */
export function alreadyDiscloses(text: string, resolved: ResolvedAgency): boolean {
  if (!text) return false;
  if (resolved.kind !== "county_sheriff") return false;
  const mentionsSheriff = /\bsheriff\b/i.test(text);
  const mentionsScope = /\bdoes(?:n't| not) include\b|\bonly\b|\bnot every\b|\bcountywide\b/i.test(text);
  return mentionsSheriff && mentionsScope;
}

/** Attach the disclosure to an explanation, without duplicating an existing one. */
export function applyAgencyDisclosure(explanation: string, resolved: ResolvedAgency): string {
  const d = describeAgencyUsed(resolved);
  if (!d.required || alreadyDiscloses(explanation, resolved)) return explanation;
  return explanation ? `${explanation.trimEnd()}\n\n${d.sentence}` : d.sentence;
}

// ── deriving the resolution from the request, for routes without a county resolver ──

/** A county named in the question, e.g. "Lewis County, Missouri" or "Cook County". */
const COUNTY_MENTION =
  /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})\s+(County|Parish|Borough)\b/;

const SCOPE_ALREADY_CHOSEN =
  /\b(county\s*-?\s*wide|all (?:law enforcement |reporting |mapped )?agencies|every agency|sheriff)\b/i;

/**
 * Decision 10 for routes that have no dedicated county resolver.
 *
 * A bare county name means the sheriff's agency; the answer must say which agency it
 * used. Returns null when the user already chose a scope (they said "sheriff" or
 * "countywide"), because then nothing was substituted on their behalf.
 */
export function countyRequestFromQuestion(question: string, resolvedName?: string | null): ResolvedAgency | null {
  const q = question ?? "";
  if (SCOPE_ALREADY_CHOSEN.test(q)) return null;
  const m = COUNTY_MENTION.exec(q);
  if (!m) return null;
  const county = `${m[1]} ${m[2]}`;
  const state = /,\s*([A-Z]{2})\b/.exec(q)?.[1] ?? null;
  return {
    requested: county,
    agencyName: resolvedName ?? `${county} Sheriff`,
    kind: "county_sheriff",
    state,
  };
}

/**
 * Two agencies named in one request, e.g. "Albuquerque police department and Bernalillo
 * county sheriff". Decision 10 requires both back, separately identified.
 */
export function multiAgencyRequestFromQuestion(question: string): ResolvedAgency[] {
  const q = question ?? "";
  const found: ResolvedAgency[] = [];
  // NOT case-insensitive: the `i` flag made [A-Z] match lowercase, so the name group ran
  // across whole phrases ("murders for Albuquerque", "Department and Bernalillo County").
  // Agency names are capitalised in these requests; the keyword alternatives spell out the
  // casings we accept instead of relying on a flag that breaks the name pattern.
  const cityDept = /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,2})\s+(?:Police Department|police department|Police|police|PD)\b/g;
  const countySheriff = /\b([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,1}?)\s+(?:County|county)\s+(?:Sheriff|sheriff)(?:'s)?(?:\s+(?:Office|office))?\b/g;
  const state = /,\s*([A-Z]{2})\b/.exec(q)?.[1] ?? null;
  for (const m of q.matchAll(countySheriff)) {
    found.push({ requested: `${m[1]} County`, agencyName: `${m[1]} County Sheriff`, kind: "county_sheriff", state });
  }
  for (const m of q.matchAll(cityDept)) {
    found.push({ requested: m[1], agencyName: `${m[1]} Police Department`, kind: "city_police", state });
  }
  return found.length >= 2 ? found : [];
}

// ── establishing what the ANSWER contains, not what the question asked ──

/**
 * Agency-identity labels present in the returned rows.
 *
 * R2: question parsing identifies intent; it cannot establish what the figures represent.
 * A separation or sheriff-scope claim must be checked against evidence, and these are the
 * only columns that carry an agency identity in this product's results.
 */
export function agencyLabelsInRows(rows: Record<string, unknown>[]): string[] {
  const keys = ["agency", "agency_label", "place_label", "place", "agency_name", "city"];
  const out: string[] = [];
  for (const r of rows ?? []) {
    for (const k of Object.keys(r)) {
      if (!keys.includes(k.toLowerCase())) continue;
      const v = r[k];
      if (v !== null && v !== undefined && String(v).trim() !== "") out.push(String(v));
    }
  }
  return out;
}

const norm = (s: string) => String(s).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Is this requested agency represented in the returned identities? */
export function agencyRepresented(requested: ResolvedAgency, labels: string[]): boolean {
  const want = norm(requested.requested.replace(/\s+County$/i, ""));
  return labels.some(l => {
    const have = norm(l);
    return have.includes(want) || want.includes(have);
  });
}

/**
 * Did the executed query actually scope to a county agency?
 *
 * Accepts either an explicit county agency-type predicate or a county-named agency
 * predicate. Anything else is not evidence, and the caller must not claim sheriff scope.
 */
/**
 * Does the question name more than one agency? INTENT ONLY — case-insensitive and loose,
 * because it decides whether to look at the evidence, never what to claim. The frozen
 * GC-084 question is entirely lower-case, so a capitalisation-dependent detector would
 * miss it; what the answer asserts still comes from the returned identities.
 */
export function asksMultipleNamedAgencies(question: string): boolean {
  const q = question ?? "";
  const mentions = (q.match(/\b(?:police department|police|pd|sheriff(?:'s)?(?:\s+office)?|county sheriff)\b/gi) ?? []).length;
  return mentions >= 2 && /\band\b/i.test(q);
}

/** Distinct agency identities present in the returned rows, in first-seen order. */
export function distinctAgencyIdentities(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of agencyLabelsInRows(rows)) {
    const key = norm(label);
    if (key && !seen.has(key)) { seen.add(key); out.push(label); }
  }
  return out;
}

/**
 * REMOVED as evidence (closure review §3B).
 *
 * This previously accepted any sheriff string anywhere in the statement, so
 * `SELECT 'sheriff' AS note, 1 AS value` "established" county scope. An output literal is
 * not a filter and not a resolved agency. Scope is now established only by a resolver
 * whose decision is carried in AnswerEvidence.resolvedAgencies.
 *
 * Kept as a deliberately always-false stub so any remaining caller fails closed rather
 * than silently regaining the shortcut.
 */
export function sqlEstablishesCountyScope(_sql: string): boolean {
  return false;
}
