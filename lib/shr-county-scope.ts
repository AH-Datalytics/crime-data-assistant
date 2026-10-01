/**
 * GC-080: a county named on the Homicide Reports (SHR) tab means the county's SHERIFF agency.
 *
 * Owner ruling (Jeff, 2026-09-26): a county name is answered by the sheriff agency, and the answer
 * says so plainly. Countywide totals remain available when the request asks for them ("countywide",
 * "all agencies in ..."). Codex design ruling (2026-09-26): the resolution is an ENFORCED identity
 * decision -- bound before the model, checked on every statement that reaches execution, and
 * disclosed by the application -- not a model instruction.
 *
 * SHERIFF IDENTITY IS READ, NEVER INFERRED. SHR's normalized `agency_type` says "County" for a
 * county police department too (St. Louis County Police Department is `County`), so county type is
 * not sheriff identity. The role is taken only from an explicit sheriff designation in the agency's
 * own recorded name -- the crosswalk's `agency_name` or SHR identity's canonical/source names --
 * together with the crosswalk's county/state association. Never from a County type, an ORI prefix,
 * population, first match or the requested county name. No sheriff established -> an owned
 * limitation, never a countywide substitute. More than one -> ask. A sheriff plus a county police
 * department -> the sheriff (Jeff's default), disclosed.
 *
 * SCOPE IS BOUND AS ORIs, NOT AS A JOIN. Both scopes hand the model, and check on the executed
 * statement, an explicit ORI list on `incidents`. The crosswalk is never joined into a counting
 * statement, so an ORI matching two crosswalk rows cannot repeat a victim.
 */
import type Database from "better-sqlite3";
import { analyzeSqlFacts, scopeAliases, type ExprFact, type RelationFact } from "./sql-facts";
import { displayPlace } from "./shr-deterministic-shooting";
import { shrCountyRequest, shrCountyKey, type ShrCountyRequest } from "./shr-county-request";
export { shrCountyRequest, shrCountyKey, type ShrCountyRequest };
import type { ResolvedAgency } from "./agency-disclosure";
import { SHR_ALL_HOMICIDE_DISCLOSURE } from "./shr-murder-licence";

export type ShrScopeBinding = {
  kind: "sheriff" | "countywide";
  countyDisplay: string;
  state: string;
  /** The agency actually queried (sheriff) or the county (countywide). */
  label: string;
  oris: string[];
  ranges: { ori: string; startYear: number; endYear: number }[];
};

export type ShrCountyScopeResolution =
  | { status: "resolved"; binding: ShrScopeBinding }
  | { status: "clarify" | "unavailable"; explanation: string; reason: string };

type CrosswalkRow = { ori: string; ori9: string | null; agency_name: string | null; state: string };
type IdentityRow = { ori: string; canonical_agency: string; source_agency_names: string; first_year: number; last_year: number };

const SHERIFF = /\bSHERIFF/i;

/** Resolve the request to a bound ORI scope, or to an owned clarification/limitation. */
export function resolveShrCountyScope(db: Database.Database, request: ShrCountyRequest): ShrCountyScopeResolution {
  const place = `${request.countyDisplay} County`;
  const has = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table));
  if (!has("agency_county_crosswalk") || !has("shr_agency_identity")) {
    return { status: "unavailable", reason: "tables-unavailable",
      explanation: `I can't identify the agency for ${place} because the agency tables this needs are not available, and I won't substitute a countywide total or a guess.` };
  }
  let state = request.state;
  if (!state) {
    const states = (db.prepare("SELECT DISTINCT upper(state) AS state FROM agency_county_crosswalk WHERE county_key = ? AND county_fips IS NOT NULL AND state IS NOT NULL ORDER BY 1")
      .all(request.countyKey) as { state: string }[]).map((r) => r.state);
    if (states.length === 0) {
      return { status: "unavailable", reason: "county-not-found", explanation: `I could not find ${place} in the agency county crosswalk.` };
    }
    if (states.length > 1) {
      return { status: "clarify", reason: "county-multiple-states",
        explanation: `${place} exists in more than one state (${states.join(", ")}). Which state do you mean?` };
    }
    state = states[0];
  }
  const rows = db.prepare(
    "SELECT ori, ori9, agency_name, upper(state) AS state FROM agency_county_crosswalk WHERE county_key = ? AND upper(state) = ? AND county_fips IS NOT NULL ORDER BY ori"
  ).all(request.countyKey, state) as CrosswalkRow[];
  if (rows.length === 0) {
    return { status: "unavailable", reason: "county-not-found", explanation: `I could not find ${place}, ${state} in the agency county crosswalk.` };
  }
  const identitiesFor = (row: CrosswalkRow): IdentityRow[] => db.prepare(
    "SELECT ori, canonical_agency, source_agency_names, first_year, last_year FROM shr_agency_identity " +
    "WHERE upper(state) = ? AND (ori = ? OR ori = ? OR substr(ori, 1, 7) = ?) ORDER BY ori"
  ).all(state, row.ori, row.ori9 ?? row.ori, row.ori) as IdentityRow[];

  const toBinding = (kind: ShrScopeBinding["kind"], label: string, identities: IdentityRow[]): ShrScopeBinding => {
    const unique = [...new Map(identities.map((i) => [i.ori, i])).values()];
    return {
      kind, countyDisplay: request.countyDisplay, state: state!, label,
      oris: unique.map((i) => i.ori),
      ranges: unique.map((i) => ({ ori: i.ori, startYear: i.first_year, endYear: i.last_year })),
    };
  };

  if (request.scope === "countywide") {
    const identities = rows.flatMap(identitiesFor);
    if (identities.length === 0) {
      return { status: "unavailable", reason: "county-no-shr-agencies",
        explanation: `No agency in ${place}, ${state} has homicide reports in this database.` };
    }
    return { status: "resolved", binding: toBinding("countywide", `${place}, ${state} (all mapped agencies)`, identities) };
  }

  // Sheriff role from explicit recorded names only.
  const sheriffs = rows
    .map((row) => ({ row, identities: identitiesFor(row) }))
    .filter(({ row, identities }) =>
      SHERIFF.test(row.agency_name ?? "")
      || identities.some((i) => SHERIFF.test(i.canonical_agency) || SHERIFF.test(i.source_agency_names)));
  if (sheriffs.length === 0) {
    return { status: "unavailable", reason: "sheriff-unresolved",
      explanation: `I can't identify ${place}, ${state}'s sheriff's agency from the agency data, so I'm not going to answer with a countywide total or another agency instead. You can ask for the countywide total, or name the agency you want.` };
  }
  if (sheriffs.length > 1) {
    return { status: "clarify", reason: "sheriff-ambiguous",
      explanation: `More than one agency in ${place}, ${state} is recorded as a sheriff's agency (${sheriffs.map((s) => s.row.agency_name ?? s.row.ori).join("; ")}). Which one do you mean?` };
  }
  const [sheriff] = sheriffs;
  if (sheriff.identities.length === 0) {
    return { status: "unavailable", reason: "sheriff-no-shr-records",
      explanation: `${place}, ${state}'s sheriff's agency has no homicide reports in this database, so I can't give its figures. I won't substitute a countywide total.` };
  }
  const label = sheriffLabel(sheriff.row.agency_name, sheriff.identities[0].canonical_agency);
  return { status: "resolved", binding: toBinding("sheriff", label, sheriff.identities) };
}

function sheriffLabel(crosswalkName: string | null, canonical: string): string {
  const source = SHERIFF.test(canonical) ? canonical : (crosswalkName ?? canonical);
  return displayPlace(source.replace(/\bSHERIFFS\b/i, "Sheriff's").replace(/\bSHERIFF'S\b/i, "Sheriff's"));
}

/** The hard-constraint guidance the model receives. The executed statement is checked regardless. */
export function shrScopeGuidance(binding: ShrScopeBinding): string {
  const list = binding.oris.map((o) => `'${o}'`).join(", ");
  const who = binding.kind === "sheriff"
    ? `The user named ${binding.countyDisplay} County, ${binding.state}. On this tab a county name means the county sheriff's agency: ${binding.label}.`
    : `The user asked for a countywide total for ${binding.countyDisplay} County, ${binding.state}: all mapped agencies in the county.`;
  return `[SYSTEM: Deterministic SHR county scope. ${who} Restrict incidents with i.ori IN (${list}) as a hard constraint. ` +
    "Do not join agency_county_crosswalk and do not add or substitute other agencies. The application states the scope in the answer.]";
}

/** The application-owned disclosure for a sheriff answer (the shared Decision 10 sentence). */
export function shrScopeResolvedAgency(binding: ShrScopeBinding): ResolvedAgency | undefined {
  if (binding.kind !== "sheriff") return undefined;
  return { requested: `${binding.countyDisplay} County, ${binding.state}`, agencyName: binding.label, state: binding.state, kind: "county_sheriff" };
}

/**
 * The application-owned scope and measure sentences for a delivered SHR answer.
 *
 * Applied LAST -- after the route's agency-name tidying and narrative cleanup, which could otherwise
 * shorten "Sheriff's Office" away -- and deduplicated by exact text, so a model sentence that merely
 * mentions a sheriff never stands in for the plain statement.
 */
export function withShrScopeAndMeasureDisclosures(text: string, binding: ShrScopeBinding | null, allHomicides: boolean): string {
  const sentences: string[] = [];
  if (binding?.kind === "sheriff") {
    sentences.push(
      `These figures are for ${binding.label}, ${binding.state} — the county sheriff's agency, which is what ` +
      `"${binding.countyDisplay} County, ${binding.state}" means here. They don't include the city police departments ` +
      "or other agencies in the county; ask for the countywide total if you want every agency.");
  } else if (binding?.kind === "countywide") {
    sentences.push(
      `These figures are a countywide total across the agencies mapped to ${binding.countyDisplay} County, ${binding.state}; ` +
      "agencies that did not report are not included.");
  }
  if (allHomicides) sentences.push(SHR_ALL_HOMICIDE_DISCLOSURE);
  let out = text;
  for (const sentence of sentences) {
    if (!out.includes(sentence)) out = out ? `${out.trimEnd()}\n\n${sentence}` : sentence;
  }
  return out;
}

/** An all-homicide answer's title must not say "murder". */
export function allHomicideTitle(title: string | undefined): string | undefined {
  return title?.replace(/\bMurders\b/g, "Homicides").replace(/\bMurder\b/g, "Homicide")
    .replace(/\bmurders\b/g, "homicides").replace(/\bmurder\b/g, "homicide");
}

export const SHR_SCOPE_GUARDRAIL = "shr-county-scope-violation";

/**
 * Does the statement that is about to execute stay inside the bound scope? Null when it does.
 *
 * Every scope that reads `incidents` as a base table must carry a top-level restriction of
 * `incidents.ori` to ORIs in the binding (`=` or an all-literal IN list), outside any OUTER join's
 * ON; the crosswalk must not appear at all; and no ORI outside the binding may be named.
 */
export function shrScopeViolation(sql: string, binding: ShrScopeBinding): string | null {
  const facts = analyzeSqlFacts(sql);
  if (!facts.parsed) return `the statement could not be checked against the resolved ${binding.kind === "sheriff" ? "sheriff" : "county"} scope (${facts.reason})`;
  const allowed = new Set(binding.oris.map((o) => o.toUpperCase()));
  for (const relation of facts.relations.values()) {
    const scopes = relation.armScopes.length > 0 ? relation.armScopes : [relation];
    for (const scope of scopes) {
      if (scope.sources.some((s) => (s.table ?? "").toLowerCase() === "agency_county_crosswalk")) {
        return "the statement joins the county crosswalk instead of using the resolved agency scope";
      }
      // G80-2: the restriction is bound to the INSTANCE that is read, not to the table name. A second
      // incidents instance in the same scope is refused outright: restricting one copy does not scope
      // the other, and an extra copy multiplies whatever is counted beside it.
      const instances = scope.sources.filter((s) => !s.isRelation && (s.table ?? "").toLowerCase() === "incidents");
      if (instances.length > 1) return "the statement reads incidents more than once, so a restriction on one copy does not scope the others";
      const instanceName = instances.length === 1 ? (instances[0].alias ?? "incidents").toLowerCase() : null;
      const onlyVictimsBeside = scope.sources.every((s) => s === instances[0] || (s.table ?? "").toLowerCase() === "victims");
      let complete = false;
      for (const p of scope.predicates) {
        const leftOri = isInstanceOri(p.left, instanceName, onlyVictimsBeside);
        const rightOri = isInstanceOri(p.right, instanceName, onlyVictimsBeside);
        const anyOri = leftOri || rightOri || namesIncidentsOri(p.left, scope) || namesIncidentsOri(p.right, scope);
        if (!anyOri) continue;
        const values = p.op === "IN" ? p.inValues
          : p.op === "=" ? [literalOf(leftOri || namesIncidentsOri(p.left, scope) ? p.right : p.left)] : undefined;
        if (values && values.every((v) => typeof v === "string") && values.some((v) => !allowed.has(String(v).toUpperCase()))) {
          return `the statement names an agency outside the resolved scope (${values.find((v) => !allowed.has(String(v).toUpperCase()))})`;
        }
        if (!leftOri && !rightOri) continue;
        const outer = p.position === "on" && p.joinKind != null && /\b(LEFT|RIGHT|FULL)\b/i.test(p.joinKind);
        if (outer || !values || values.some((v) => typeof v !== "string")) continue;
        // The COMPLETE bound set: a countywide answer that keeps only the sheriff is a narrowed county.
        const named = new Set(values.map((v) => String(v).toUpperCase()));
        if (named.size === allowed.size && [...allowed].every((o) => named.has(o))) complete = true;
        else if (named.size < allowed.size) {
          return binding.kind === "countywide"
            ? `the statement keeps ${named.size} of the ${allowed.size} agencies mapped to ${binding.countyDisplay} County, so it is not the countywide total`
            : `the statement keeps ${named.size} of ${binding.label}'s ${allowed.size} ORIs`;
        }
      }
      if (instanceName && !complete) {
        return binding.kind === "sheriff"
          ? `incidents are not restricted to ${binding.label}'s ORIs`
          : `incidents are not restricted to the ORIs of the agencies in ${binding.countyDisplay} County`;
      }
    }
  }
  return null;
}

function literalOf(fact: ExprFact | null): unknown {
  return fact && fact.kind === "literal" ? fact.value : undefined;
}

/**
 * Is this `<instance>.ori` for the one incidents instance in scope? An unqualified `ori` counts only
 * when nothing but victims (which has no ori) sits beside it, so it cannot belong to another table.
 */
function isInstanceOri(fact: ExprFact | null, instanceName: string | null, onlyVictimsBeside: boolean): boolean {
  if (!instanceName || !fact || fact.kind !== "column") return false;
  const ref = fact.refs[0];
  if (!ref || ref.column.toLowerCase() !== "ori") return false;
  return ref.source ? ref.source.toLowerCase() === instanceName : onlyVictimsBeside;
}

/** Any column reference to an incidents instance's ori in this scope, for the outside-the-scope check. */
function namesIncidentsOri(fact: ExprFact | null, scope: RelationFact): boolean {
  if (!fact || fact.kind !== "column") return false;
  const ref = fact.refs[0];
  if (!ref || ref.column.toLowerCase() !== "ori") return false;
  const aliases = scopeAliases(scope);
  return ref.source ? aliases.get(ref.source.toLowerCase()) === "incidents" : false;
}
