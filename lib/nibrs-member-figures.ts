/**
 * Which agency each figure in an answer belongs to.
 *
 * The check this replaces asked whether a member's name or ORI appeared anywhere in the result, which
 * is not the same question: an agency can be mentioned and contribute nothing, and a similarly named
 * agency's rows can stand in for it. Within a single state 2,930 real city names are proper substrings
 * of other real city names, so "appears somewhere" is not evidence of membership.
 *
 * It binds figures to agencies through three kinds of evidence, in order of strength:
 *
 *   0. WHAT THE PRODUCER DECLARED. A builder that composes pivoted columns already knows which member
 *      each one belongs to, and now carries that list on the query. Nothing is parsed.
 *   1. SOURCE-BACKED ORIs in the returned rows. The `ori` value comes from the data; a name column
 *      can corroborate or CONTRADICT it, but never grant membership on its own. A row whose name
 *      names a different member than its ORI belongs to neither, and an ORI must agree with the
 *      member's state.
 *
 * There is deliberately no third mechanism. A column heading or place-key string written by whoever
 * composed the query is not source evidence, and inferring membership from it grants authority to a
 * name the data never backed. An answer carrying neither a producer declaration nor source-backed
 * ORIs is reported as unestablishable -- which is a statement about the answer, not about the agency.
 *
 * A result carrying neither kind of identity is not evidence that members are absent -- it is a result
 * that cannot say who its numbers belong to, which for a multi-agency question is its own answer.
 */
import type { NibrsPlaceResolutionPlan, NibrsResolvedPlace } from "./nibrs-place-resolver";
import { analyzeSql } from "./sql-lineage";
import { aliasesJoinedOnColumn } from "./sql-restriction";

/** Columns whose VALUES name an agency. Declared, so a new column cannot silently become identity. */
export const AGENCY_IDENTITY_COLUMNS = ["ori", "place_key", "place_label", "agency", "agency_name"] as const;

export type MemberFigures = {
  member: NibrsResolvedPlace;
  /** How the binding was established, or null when nothing binds this member to a figure. */
  evidence: "producer-declared" | "identity-column" | null;
  /** Measure columns owned by this member, for the pivoted shape. */
  columns: string[];
  /** Rows owned by this member, for the identity-column shape. */
  rowCount: number;
  /** Bound to figures, but every one of them is null: present in the answer with nothing to report. */
  allValuesMissing: boolean;
};

export type AgencyFigureMapping = {
  /** True when the result carries agency identity at all, whatever it then says. */
  establishable: boolean;
  shape: "producer-declared" | "identity-column" | "none";
  members: MemberFigures[];
  /** Resolved members the result binds to no figure. */
  unmapped: NibrsResolvedPlace[];
  /** Identity evidence that cannot be true of one answer, reported rather than resolved. */
  conflicts: string[];
};

const norm = (value: unknown) => String(value ?? "")
  .toUpperCase()
  .replace(/,\s*[A-Z]{2}\s*$/, "")
  .replace(/[^A-Z0-9]+/g, " ")
  .trim();

/** Every form of a member's name the product is known to render. Equality only, never containment. */
function nameFormsOf(place: NibrsResolvedPlace): string[] {
  return [
    place.label,
    place.requestedName,
    place.requestedName.replace(/\s+(?:city\s+)?police\s+(?:department|dept\.?)$/i, ""),
  ].map(norm).filter((value) => value.length >= 3);
}

function orisOf(place: NibrsResolvedPlace): string[] {
  return [...new Set(place.oriYears.map((item) => item.ori))].map((ori) => ori.trim().toUpperCase());
}


/**
 * The name a select item gives its result column, or null when its shape names none.
 *
 * The mapping reads a named column out of each row, so the item that has to be proved is the one
 * that WRITES that name -- not any item that happens to mention the identifier somewhere.
 */
function outputNameOf(item: { alias: string | null; raw: string }): string | null {
  if (item.alias) return item.alias.toLowerCase();
  const direct = /^\s*(?:[A-Za-z_]\w*\s*\.\s*)?([A-Za-z_]\w*)\s*$/.exec(item.raw);
  return direct ? direct[1].toLowerCase() : null;
}

/**
 * Does this item hand back a source column's own value, or a value COMPUTED from one?
 *
 * `CASE WHEN d.ori = 'A' THEN 'B' ELSE 'A' END AS ori` references the genuine identifier and returns
 * a different agency's. Reference is therefore not the test; value preservation is. A single column
 * reference -- qualified, bare, or projected through a CTE -- carries the stored value unchanged, and
 * anything with an operator, call, literal or conditional in it does not. Deliberately narrow: the
 * alternative is an expression evaluator, which is outside this scope, so a transformation the
 * analyzer cannot rule harmless is reported unproved rather than accepted.
 */
function isValuePreservingProjection(item: { alias: string | null; raw: string; refs: unknown[] }): boolean {
  const body = item.alias
    ? item.raw.replace(/\s+(?:AS\s+)?[A-Za-z_]\w*\s*$/i, "")
    : item.raw;
  return /^\s*(?:[A-Za-z_]\w*\s*\.\s*)?[A-Za-z_]\w*\s*$/.test(body) && item.refs.length === 1;
}

/**
 * Did the agency identifier and the measures beside it come from the same records?
 *
 * Four ways a query can put a true-looking identifier next to someone else's number, all of which
 * survive every check made on the returned rows: select the identifier from a literal list, from an
 * agency directory joined on nothing, from a second alias of the measure table tied on a column
 * other than the agency, or -- the swapped_output_identity witness -- project the genuine identifier
 * under one name while returning a transformed one under the name the mapping actually reads. So
 * this reads the executed SQL and requires the RETURNED identifier column to be one source column's
 * unchanged value, and each measure to come from that same relation instance or one the statement
 * really joins to it on the agency.
 *
 * Fails closed. A statement the analyzer cannot read is not a statement whose binding is proved.
 */
function sourceBinding(sql: string, identityColumn: string): { bound: boolean; reason: string } {
  const lineage = analyzeSql(sql);
  if (!lineage.parsed) {
    return { bound: false, reason: "the query's shape could not be read well enough to say where each figure came from" };
  }
  // The item that NAMES the identifier column, not one that merely mentions the identifier. Reading
  // any matching reference let a statement certify the column it returns with a different column's
  // lineage, and the swapped agency numbers passed both production checks on that basis.
  const identityItem = lineage.items.find(
    (item) => outputNameOf(item) === identityColumn.toLowerCase()
  );
  if (!identityItem) {
    return { bound: false, reason: "the agency identifier in the result is not one the query's own projection names" };
  }
  if (!isValuePreservingProjection(identityItem)) {
    return {
      bound: false,
      reason: "the agency identifier in the result is computed rather than taken unchanged from the agency " +
        "column of a record the query read",
    };
  }
  const identityRef = identityItem.refs[0];
  if (
    !identityRef
    || !identityRef.table
    || identityRef.column.toLowerCase() !== identityColumn.toLowerCase()
    || !identityRef.sourceAlias
  ) {
    return { bound: false, reason: "the agency identifier in the result does not come from a table the query reads" };
  }
  // An UNREADABLE measure reference is not an absent one. Requiring `ref.table` here dropped every
  // reference the analyzer could not resolve, so a figure it could not trace was not checked at all
  // -- the scoped_alias_collision witness reached a countywide total that way, its only measure
  // silently discarded. Every non-identity reference is now kept and must name the relation instance
  // it came from. A literal stays subject to that too: it has no instance, and exempting it as
  // "harmless because it reads no relation" let `WITH made(n) AS (VALUES (999))` hand a fabricated
  // figure to a genuine ORI, which the previous filter had refused.
  const measureRefs = lineage.items
    .filter((item) => item.refs.some((ref) => ref.column.toLowerCase() !== identityColumn.toLowerCase()))
    .flatMap((item) => item.refs)
    .filter((ref) => ref.column.toLowerCase() !== identityColumn.toLowerCase());
  if (measureRefs.length === 0) {
    return { bound: true, reason: "" };
  }
  for (const measure of measureRefs) {
    if (!measure.table || !measure.sourceAlias) {
      return { bound: false, reason: "a figure in the result does not come from a table the query reads" };
    }
    if (measure.table !== identityRef.table) {
      return {
        bound: false,
        reason: `the agency identifier comes from ${identityRef.table} while a figure comes from ${measure.table}, ` +
          "and the query does not tie them to the same agency",
      };
    }
    if (!aliasesJoinedOnColumn(sql, identityRef.sourceAlias, measure.sourceAlias, identityColumn)) {
      return {
        bound: false,
        reason: "the agency identifier and the figures are read from different rows of the same table, " +
          "which the query does not tie together by agency",
      };
    }
  }
  return { bound: true, reason: "" };
}

export function mapAgencyFigures(
  plan: NibrsPlaceResolutionPlan | null,
  columns: string[],
  rows: Record<string, unknown>[],
  /**
   * The producer's own column-to-member list, when the answer came from a builder that records it.
   * Preferred over every inference below, because the column name cannot be decomposed reliably:
   * `seriesKey` collapses non-alphanumeric runs, so the separator is indistinguishable from the
   * content, and on a slug tie the builder appends "_2", which carries no identity. Parsing a
   * composed slug is recovering information the producer already had; this takes it instead.
   */
  producerColumns?: { column: string; placeKey?: string; contractIndex?: number; placeLabel?: string }[] | null,
  /**
   * The SQL that actually produced these rows. Supplied for the model path, where nothing else can
   * establish that the identifier beside a number came from the same records as the number.
   */
  sql?: string | null
): AgencyFigureMapping | null {
  if (!plan || plan.places.length === 0) return null;
  const resolved = plan.places.filter((place) => place.status === "resolved");
  const conflicts: string[] = [];
  const present = new Set((columns ?? []).map((column) => String(column)));

  // ---- shape 0: the producer said so, keyed on the contract index ----
  // The DISPLAY LABEL cannot carry this: two members labelled "Mobile" share one label and would each
  // own every column bearing it. `place_N` is assigned from the contract index and is the only part a
  // label collision cannot reach, so the binding is resolved through that and never through the name.
  if (producerColumns && producerColumns.length > 0) {
    const indexOf = (entry: { placeKey?: string; contractIndex?: number }): number | null => {
      if (typeof entry.contractIndex === "number") return entry.contractIndex;
      const fromKey = /^place_(\d+)$/.exec(String(entry.placeKey ?? ""));
      return fromKey ? Number(fromKey[1]) - 1 : null;
    };
    const byIndex = new Map<number, string[]>();
    for (const entry of producerColumns) {
      const index = indexOf(entry);
      if (index === null) {
        conflicts.push(`producer column "${entry.column}" carries no usable member key`);
        continue;
      }
      if (!resolved.some((place) => place.contractIndex === index)) {
        // A member the RESOLVER could not resolve is not contradictory evidence about the members it
        // did. The builder still emits a column for it, and treating that as a conflict stopped the
        // whole answer with "the identifying details in the result don't agree" -- asserting a
        // disagreement that never happened and discarding a supported subset that was internally
        // consistent. The unresolved member is disclosed by `unresolvedMemberDisclosure` instead, so
        // it is neither hidden nor restated here as a different kind of failure.
        if (plan.places.some((place) => place.contractIndex === index)) continue;
        conflicts.push(`producer column "${entry.column}" names member ${index}, which was never requested`);
        continue;
      }
      if (!present.has(entry.column)) {
        conflicts.push(`producer declared column "${entry.column}" which the result does not contain`);
        continue;
      }
      const already = [...byIndex.entries()].find(([other, columns]) =>
        other !== index && columns.includes(entry.column));
      if (already) {
        conflicts.push(`column "${entry.column}" is declared for more than one member`);
        continue;
      }
      byIndex.set(index, [...(byIndex.get(index) ?? []), entry.column]);
    }
    const members = resolved.map((member) => {
      const owned = byIndex.get(member.contractIndex) ?? [];
      return {
        member,
        evidence: owned.length > 0 ? ("producer-declared" as const) : null,
        columns: owned,
        rowCount: owned.length > 0 ? (rows ?? []).length : 0,
        allValuesMissing: owned.length > 0
          && (rows ?? []).every((row) => owned.every((column) => row[column] === null || row[column] === undefined)),
      };
    });
    return {
      establishable: true,
      shape: "producer-declared",
      members,
      unmapped: members.filter((entry) => entry.evidence === null).map((entry) => entry.member),
      conflicts,
    };
  }

  // ---- shape 1: an ORI column, which is the only per-row identity the SOURCE backs ----
  //
  // A name or heading in a result is chosen by whoever wrote the query. A witness makes the point:
  // SQL filtering `d.ori = 'MD0240000'` while projecting a literal `'MD0240300' AS agency_name`
  // returns only the sheriff's figures under the other agency's name. So a NAME never grants
  // membership here; it can only corroborate or contradict. The ORI comes from the data rows.
  //
  // Two further rejections, both from executed witnesses: a row whose name column names a different
  // member than its ORI is CONTRADICTORY and belongs to neither; and a member's ORI must agree with
  // the member's state, so a Missouri Springfield row cannot satisfy an Illinois member.
  const identityColumns = AGENCY_IDENTITY_COLUMNS.filter((column) => present.has(column));
  const oriColumns = identityColumns.filter((column) => column === "ori");
  const nameColumns = identityColumns.filter((column) => column !== "ori");
  if (oriColumns.length > 0) {
    // Before any row is read: did the identifier and the figures beside it come from the same
    // records? A correctly spelled ORI, for the right state, can still be attached to another
    // agency's number -- by selecting it from a VALUES list, from a directory table, or from a
    // second alias of the measure table that is joined on something other than the agency. The rows
    // cannot answer this, because the rows are whatever the query chose to say. Only the query can.
    if (sql) {
      const binding = sourceBinding(sql, oriColumns[0]);
      if (!binding.bound) {
        return {
          establishable: false,
          shape: "none",
          members: resolved.map((member) => ({
            member, evidence: null, columns: [], rowCount: 0, allValuesMissing: false,
          })),
          unmapped: resolved,
          conflicts: [binding.reason],
        };
      }
    }
    const memberForOri = (value: string) => resolved.find((place) =>
      orisOf(place).includes(value) && (!place.state || value.slice(0, 2).toUpperCase() === place.state.toUpperCase()));
    const memberForName = (value: unknown) => resolved.find((place) => nameFormsOf(place).includes(norm(value)));
    const members = resolved.map((member) => {
      const owned = (rows ?? []).filter((row) => {
        const oriCell = row[oriColumns[0]];
        if (oriCell === null || oriCell === undefined) return false;
        const owner = memberForOri(String(oriCell).trim().toUpperCase());
        if (!owner || owner !== member) return false;
        // Does the name FIT the ORI's member? Asking instead which member the name picks out took
        // the first match, so two genuinely distinct agencies sharing one display name -- AL's two
        // Mobiles -- had each honest row read as contradicting itself. A shared name is not a
        // disagreement; a name that does not fit the agency the row identifies is.
        for (const column of nameColumns) {
          const cell = row[column];
          if (cell === null || cell === undefined || norm(cell) === "") continue;
          if (nameFormsOf(owner).includes(norm(cell))) continue;
          const named = memberForName(cell);
          if (named && named !== owner) {
            conflicts.push(`a row identifies ${owner.label} by ORI and ${named.label} by ${column}`);
            return false;
          }
        }
        return true;
      });
      const measures = (columns ?? []).filter((column) => !identityColumns.includes(column as never));
      return {
        member,
        evidence: owned.length > 0 ? ("identity-column" as const) : null,
        columns: owned.length > 0 ? measures : [],
        rowCount: owned.length,
        allValuesMissing: owned.length > 0
          && owned.every((row) => measures.every((column) => row[column] === null || row[column] === undefined)),
      };
    });
    return {
      establishable: true,
      shape: "identity-column",
      members,
      unmapped: members.filter((entry) => entry.evidence === null).map((entry) => entry.member),
      conflicts,
    };
  }

  // ---- no shape 2 ----
  // A pivoted column name written by the model is not evidence: the heading is chosen by whoever wrote
  // the query, and inferring membership from it grants authority to a string the source never backed.
  // The slug rule that used to live here also could not survive its own arithmetic -- `seriesKey`
  // collapses non-alphanumeric runs, so a separator is indistinguishable from content, and on a slug
  // tie the builder appends "_2", which carries no identity at all. A supported pivot answer arrives
  // with the producer's declaration and is handled above; a model-authored one has no declaration and
  // is reported as unestablishable rather than guessed at.

  // ---- neither: the result cannot say whose figures these are ----
  return {
    establishable: false,
    shape: "none",
    members: resolved.map((member) => ({
      member, evidence: null, columns: [], rowCount: 0, allValuesMissing: false,
    })),
    unmapped: resolved,
    conflicts,
  };
}

/**
 * The delivery decision for the bounded multi-agency family, expressed over the mapping.
 *
 * Silent on a single-agency question and on an empty result, which makes no completeness claim. A
 * member the source never had is disclosed elsewhere: no query could have included it.
 */
export function agencyFigureFailure(
  plan: NibrsPlaceResolutionPlan | null,
  columns: string[],
  rows: Record<string, unknown>[],
  producerColumns?: { column: string; placeKey?: string; contractIndex?: number; placeLabel?: string }[] | null,
  /** The SQL that produced these rows, for the model path's source-binding proof. */
  sql?: string | null
): { reason: string; missing: string[]; present: string[]; establishable: boolean } | null {
  const mapping = mapAgencyFigures(plan, columns, rows, producerColumns, sql);
  if (!mapping) return null;
  if (plan!.places.length < 2) return null;
  const resolved = mapping.members.map((entry) => entry.member);
  if (resolved.length === 0) return null;
  if (!rows || rows.length === 0) return null;
  if (mapping.conflicts.length > 0) {
    return {
      reason: mapping.conflicts.join("; "),
      missing: mapping.unmapped.map((place) => place.label),
      present: [],
      establishable: mapping.establishable,
    };
  }
  if (mapping.establishable && mapping.unmapped.length === 0) return null;

  const present = mapping.members.filter((entry) => entry.evidence !== null).map((entry) => entry.member.label);
  const missing = mapping.unmapped.map((place) => place.label);
  return {
    reason: mapping.establishable
      ? `the figures belong to ${present.join(", ")}; nothing in the result belongs to ${missing.join(", ")}`
      : `the result does not say which of ${resolved.map((place) => place.label).join(", ")} its figures belong to`,
    missing,
    present,
    establishable: mapping.establishable,
  };
}

/**
 * What to tell someone when a multi-agency answer cannot be delivered as a complete one.
 *
 * Three different facts, said differently, because collapsing them produced sentences like
 * "only cover  - nothing came back for Mobile": conflicting identity evidence is not a proven
 * subset, and an answer that cannot say whose figures it holds is not an agency's absence. The
 * answer must never assert that a source lacks data it was never asked for.
 */
export function memberRefusalText(failure: {
  reason: string; missing: string[]; present: string[]; establishable: boolean;
}): string {
  if (!failure.establishable) {
    return "You asked about more than one agency, and the figures that came back don't identify which agency they belong to, so I can't tell you they cover all of them. Ask for them one at a time and I can answer each separately.";
  }
  if (failure.present.length === 0) {
    return "You asked about more than one agency, and I couldn't establish which of them the figures belong to — the identifying details in the result don't agree. Rather than attribute numbers to an agency on that basis, I stopped. Ask for them one at a time and I can answer each.";
  }
  return `You asked about more than one agency, and the figures that came back only cover ${failure.present.join(", ")} — nothing in the result belongs to ${failure.missing.join(", ")}. Reporting that as the answer would present one agency's numbers as if they covered all of them, so I stopped. Ask for them one at a time and I can answer each.`;
}
