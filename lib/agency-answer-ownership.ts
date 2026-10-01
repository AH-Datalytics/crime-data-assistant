/**
 * Who owns a multi-agency answer, and does its title tell the truth about what it covers?
 *
 * THE CHANGE OF GUARANTEE. Every earlier attempt asked, after the fact, whether a model-written
 * statement had tied each number to the right agency. That question cannot be answered from query
 * text by any bounded rule: each protection was defeated by wrapping the same trick one level
 * further -- a CASE inside a CTE, one CTE joined to itself under two names. So this module stops
 * asking it. For the bounded named-multi-agency family, a factual answer is delivered only when an
 * application-owned producer BUILT it and declared which column belongs to which member, and that
 * declaration is bound to the statement actually executed.
 *
 * This deliberately withholds correct model-written comparisons along with incorrect ones. That is a
 * product cost, approved explicitly, not a free safety win: the boundary declines to trust the
 * category, because it cannot tell a good member of it from a bad one.
 *
 * The second half is coverage. An answer that covers one of two requested agencies must not carry a
 * title naming both. The title and the explanation are therefore derived from the SAME member-result
 * state, so they cannot disagree with each other or with the rows.
 */
import {
  type NibrsPlaceResolutionPlan,
  type NibrsResolvedPlace,
} from "./nibrs-place-resolver";
import { type AgencyFigureMapping } from "./nibrs-member-figures";
import { containsInternalLeak } from "./scaffold-helpers";

/**
 * What the ANSWER turned out to say about one requested member. Four causes, kept apart because
 * collapsing them is what produced "could not be matched" for an agency the resolver had matched.
 */
export type MemberCoverageState =
  /** Bound to figures, at least one of which is a value. A zero is a value. */
  | "figures"
  /** Bound to figures, every one of which is absent. Not a zero, and not the agency's absence. */
  | "no-contribution"
  /** A known agency with no rows in the requested period. */
  | "unavailable-period"
  /** Requested, and this source has no such agency to query. */
  | "unmatched"
  /** Resolved, but the result never said which figures are its own. */
  | "unresolved-ownership";

export type MemberCoverage = { member: NibrsResolvedPlace; state: MemberCoverageState };

/**
 * The bounded family, taken from the REQUEST as the resolver understood it.
 *
 * Not from two agency-shaped phrases in the question, and not from two rows in a result: the first
 * is a guess about wording and the second is decided by whoever wrote the query. A peer comparison
 * names one agency and asks the product to choose the others, so it has one requested place and is
 * not this family -- its selection policy is separate and is left alone.
 */
export function isOwnedMultiAgencyRequest(plan: NibrsPlaceResolutionPlan | null): boolean {
  return Boolean(plan && plan.places.length >= 2);
}

/** A producer declaration, as the builders emit it. */
export type MemberDeclaration = {
  column: string;
  placeKey?: string;
  contractIndex?: number;
  placeLabel?: string;
};

/**
 * The member declaration this answer is allowed to be trusted with, or null.
 *
 * Three things have to hold, and the middle one is the point. The declaration must come from an
 * application-owned producer (it carries that producer's guardrail family); it must be bound to the
 * statement that was ACTUALLY EXECUTED, so a retry, rewrite or fallback cannot carry a declaration
 * forward onto different SQL; and every entry must name a member by index rather than by a label,
 * because a label is a string and two real agencies can share one.
 *
 * `memberColumns` being present is not sufficient and is not the test. An unbound declaration is
 * treated exactly like no declaration at all.
 */
export function ownedMemberDeclaration(
  query: { sql?: string | null; guardrail?: string | null; memberColumns?: MemberDeclaration[] | null } | null,
  executedSql: string | null | undefined
): MemberDeclaration[] | null {
  if (!query || !query.guardrail) return null;
  if (!query.sql || !executedSql || query.sql !== executedSql) return null;
  const declared = query.memberColumns;
  if (!Array.isArray(declared) || declared.length === 0) return null;
  const indexed = declared.every((entry) =>
    typeof entry?.column === "string"
    && entry.column.length > 0
    && (typeof entry.contractIndex === "number" || /^place_\d+$/.test(String(entry.placeKey ?? ""))));
  return indexed ? declared : null;
}

/**
 * What each requested member actually got, read from the mapping and the resolver together.
 *
 * The mapping knows which members the RESULT bound to figures; the plan knows why a member is not
 * there at all. Neither alone can distinguish a known agency without rows for these years from one
 * this source has never heard of, and that distinction is the whole difference between "try another
 * period" and "this agency is not here".
 */
export function memberCoverage(
  plan: NibrsPlaceResolutionPlan | null,
  mapping: AgencyFigureMapping | null
): MemberCoverage[] {
  if (!plan) return [];
  const byLabel = new Map<number, AgencyFigureMapping["members"][number]>();
  for (const entry of mapping?.members ?? []) byLabel.set(entry.member.contractIndex, entry);
  return plan.places.map((member) => {
    if (member.status !== "resolved") {
      return { member, state: member.status === "covered" ? "unavailable-period" as const : "unmatched" as const };
    }
    const mapped = byLabel.get(member.contractIndex);
    if (!mapped || mapped.evidence === null) return { member, state: "unresolved-ownership" as const };
    // `allValuesMissing` counts null and undefined only, so a genuine zero stays a figure. An answer
    // that reports 0 murders is an answer; one whose cells are empty is not, and reporting the second
    // as the first is the oldest failure in this area.
    return { member, state: mapped.allValuesMissing ? "no-contribution" as const : "figures" as const };
  });
}

/** Members whose figures the answer actually carries. */
export function coveredMembers(coverage: MemberCoverage[]): MemberCoverage[] {
  return coverage.filter((entry) => entry.state === "figures");
}

const renderable = (label: string) => !containsInternalLeak(label);

function listOf(labels: string[]): string {
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * A title that claims exactly the coverage the answer has.
 *
 * A complete answer keeps the title its producer wrote, unchanged -- there is nothing to qualify, and
 * rewriting it would churn every working comparison. A partial answer names the members it does
 * cover and says how many of how many were asked for, so the claim is bounded on the face of it.
 * The subject, measure and period stay in the producer's own words; only the coverage clause is ours.
 *
 * A label the internal-leak firewall would refuse is never inserted. The count is stated either way,
 * so an unrenderable name cannot turn a partial answer back into an unqualified claim.
 */
export function coverageTitle(producerTitle: string, coverage: MemberCoverage[]): string {
  const requested = coverage.length;
  if (requested < 2) return producerTitle;
  const covered = coveredMembers(coverage);
  if (covered.length === requested) return producerTitle;

  // Appending a coverage clause is not enough on its own: the producer writes its title from the
  // REQUESTED members ("...trends for A and B"), so the uncovered name is already inside the string
  // and a qualifier after it would leave the answer naming an agency it does not carry.
  //
  // THE LIST MUST BE COMPOSED THE WAY THE PRODUCER COMPOSED IT. An earlier version rebuilt it with
  // this file's own prose joiner ("A, B and C") while the supported builder joins every member with
  // " and " ("A and B and C"). At two members those agree, so the mistake was invisible; at three --
  // a size the existing builder already supports -- the suffix matched nothing, the original list
  // survived, and the coverage clause was appended after it. The delivered title then named the
  // uncovered agency AND repeated the covered ones, in the response and in the real chart.
  //
  // Candidates are all compositions of OUR OWN member labels, tried longest first. This removes a
  // list we know how to build; it does not parse a title.
  const base = (() => {
    const text = String(producerTitle ?? "").trim();
    const labels = coverage.map((entry) => entry.member.label);
    const lists = [...new Set([labels.join(" and "), listOf(labels)])];
    for (const list of lists.sort((a, b) => b.length - a.length)) {
      for (const suffix of [` for ${list}`, ` in ${list}`, ` ${list}`]) {
        if (text.toLowerCase().endsWith(suffix.toLowerCase())) return text.slice(0, text.length - suffix.length).trim();
      }
    }
    return text;
  })();

  if (covered.length === 0) return base ? `${base} — no agency figures returned` : "No agency figures returned";
  const names = covered.map((entry) => entry.member.label).filter(renderable);
  // Composed the producer's way too, so the replacement reads as the same kind of title.
  const who = names.length === covered.length ? ` for ${names.join(" and ")}` : "";
  return `${base}${who} (${covered.length} of ${requested} agencies requested)`;
}

/**
 * The explanation of what the answer does not cover, from the same state the title came from.
 *
 * Silent when every requested member has figures, and on a single-member request, where the whole
 * answer is already about that one place.
 */
export function coverageNote(
  plan: NibrsPlaceResolutionPlan | null,
  coverage: MemberCoverage[]
): { note: string; labels: string[]; unsafeLabel: boolean } | null {
  if (!plan || coverage.length < 2) return null;
  const covered = coveredMembers(coverage);
  const shortfall = coverage.filter((entry) => entry.state !== "figures");
  if (shortfall.length === 0) return null;

  const coveredNames = covered.map((entry) => entry.member.label).filter(renderable);
  const coveredText = coveredNames.length === covered.length && covered.length > 0
    ? listOf(coveredNames)
    : `${covered.length} of the agencies you named`;

  const phrase = (state: MemberCoverageState, verbSingular: string, verbPlural: string) => {
    const group = shortfall.filter((entry) => entry.state === state);
    if (group.length === 0) return null;
    const names = group.map((entry) => entry.member.label);
    const safe = names.filter(renderable);
    const listed = safe.length === names.length
      ? listOf(names)
      : (names.length === 1 ? "another agency you named" : `${names.length} other agencies you named`);
    return `${listed} ${names.length === 1 ? verbSingular : verbPlural}`;
  };

  const clauses = [
    phrase("unmatched", "was also asked about but could not be matched to an agency in this data",
      "were also asked about but could not be matched to an agency in this data"),
    phrase("unavailable-period", `is a known agency that has no data in this source for ${plan.startYear}-${plan.endYear}`,
      `are known agencies that have no data in this source for ${plan.startYear}-${plan.endYear}`),
    phrase("no-contribution", "was included but returned no figures for this request",
      "were included but returned no figures for this request"),
    phrase("unresolved-ownership", "could not be tied to any figures in this result",
      "could not be tied to any figures in this result"),
  ].filter(Boolean) as string[];

  const labels = shortfall.map((entry) => entry.member.label);
  const allSafe = labels.every(renderable) && covered.every((entry) => renderable(entry.member.label));
  const opening = covered.length > 0
    ? `This answer covers ${coveredText} only. `
    : "This answer covers none of the agencies you named. ";
  return {
    labels,
    unsafeLabel: !allSafe,
    note: `${opening}${clauses.join("; ")}, so ${labels.length === 1 ? "it is" : "they are"} not included in these figures.`,
  };
}

/**
 * What to say when a multi-agency request has no trusted way to be answered.
 *
 * It describes OUR limitation, never the source's contents. Saying "this agency is not in the data"
 * would be an assertion about the source that nothing here established, and the request may well be
 * answerable once a supported producer covers it.
 *
 * It also does not promise that asking one agency at a time will work. For the request that started
 * this work, it would not have: its subject was not recognised either, so a confident instruction to
 * split the question would have been a second false claim on top of the first.
 */
export function unsupportedOwnedComparisonText(): string {
  return "You asked about more than one agency. I can only give figures for several agencies at once "
    + "when I can build that comparison myself and confirm which agency each number belongs to, and I "
    + "can't do that for this request — so rather than show figures I can't attribute, I've stopped. "
    + "This is a limit of what I can put together, not a statement about what the data contains. You "
    + "could try asking about one agency at a time, or rephrasing what you're after.";
}
