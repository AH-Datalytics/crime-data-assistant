/**
 * City-level rankings, assembled from what the request's own clauses produce.
 *
 * WHY THIS EXISTS. Three saved answers ranked cities by a rate and silently dropped every place
 * whose count was zero. A checker cannot tell which quantity a threshold filters -- `SUM(count) >=
 * 100` and `rate_per_100k >= 100` share the column, the crime noun and the numeral -- so the
 * meaning is carried in separate typed fields and the SQL is written from them.
 *
 * THREE ROUNDS, THREE VERSIONS OF THE SAME MISTAKE, each narrower than the last:
 *
 *   1. Typed fields, but recognition put the wrong thing in the slot.
 *   2. A completeness check built from a proximity window and a list of comparison phrasings --
 *      two partial lists cannot establish completeness.
 *   3. A ledger that proved every token was CONSUMED. It did not prove any token PRODUCED the value
 *      the builder uses, so four requests were accepted with their meaning missing: `or` was inert
 *      filler and became `and`; `per 1000` was consumed and the unit stayed per 100,000; the scale
 *      in `1k murders` was inside the claim's span and the value was 1; `attempted` sat inside the
 *      count clause's three-word window and vanished.
 *
 * SO A CLAIM MUST PRODUCE. Every claim carries a typed `Production` -- the value or constraint it
 * explains, or an explicit presentation marker naming its rule -- and the request is ASSEMBLED FROM
 * THOSE PRODUCTIONS. Marking a span consumed is no longer a licence to source that field elsewhere.
 *
 * THE FALLBACK BOUNDARY IS THE POINT. A genuinely omitted field takes its declared default: no
 * stated size means 20, no stated year means the latest year with observed data, no stated place
 * means nationwide, the source is the tab. A clause that was STATED and FAILED takes nothing: it
 * declines. There is one final assembly, it reads only productions and declared defaults, and no
 * semantic value is replaced after it. That is what stops `per 1000` quietly becoming per 100,000.
 *
 * AND A CLAIM ACCOUNTS FOR ITS OWN INTERIOR. Each clause declares the sub-spans it actually
 * explained; anything else inside its span is residue, exactly as it would be outside. A broad
 * enclosing match is not evidence that its interior was understood.
 *
 * WHAT THIS DOES NOT DO. One narrow family: city rankings by a count or a rate per 100,000, on
 * Current and NIBRS, over one whole year, in one state or nationwide, with at most one population
 * condition and at most one count condition, combined conjunctively. No disjunctions, no other rate
 * bases, no scaled count shorthand, no offense qualifiers, no intervals, no fractional populations.
 * Each of those is DECLINED, which is the supported answer to them.
 *
 * OWNED FAILURE IS STILL OWNED. A request this family recognises but cannot carry returns an
 * `unsupported` description, never null. `null` means only "not this family".
 */
import { buildQueryContract } from "./query-contract";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { STATE_NAME_TO_ABBR } from "./state-population";
import { UCR_CODES } from "./nibrs-codes";
import { SHR_ALL_HOMICIDE_DISCLOSURE, SHR_MEASURE_CONFLICT_MESSAGE, shrRequestedMeasure } from "./shr-murder-licence";

export type CityRankingSource = "current" | "nibrs" | "shr";

/** How an offense is identified in a given source. They are not interchangeable. */
export type OffenseIdentity =
  | { kind: "current_offense"; value: string }
  | { kind: "nibrs_codes"; codes: string[] }
  // SHR counts VICTIM records: "homicide" is every homicide type, "murder" is homicide_type 'Murder'
  // (the owned-count definitions in lib/shr-murder-licence.ts, unchanged).
  | { kind: "shr_victims"; measure: "homicide" | "murder" };

// "share_pct": the percentage of the ranked offense's victims that meet a stated subset (SHR firearm
// share, GC-061). Only SHR builds it; it is declined elsewhere.
export type RankingQuantity = "count" | "rate_per_100k" | "share_pct";
export type PopulationComparison = ">=" | ">" | "<=" | "<";
export type CountComparison = ">=" | ">";

/** The only rate basis this family builds. An explicitly requested other basis declines. */
export const SUPPORTED_RATE_BASIS = 100000;

/**
 * A condition the REQUEST stated.
 *
 * A count condition carries the OFFENSE ITS OWN CLAUSE NAMED so the builder compares two real
 * identities rather than a field against a copy of itself.
 */
export type EligibilityCondition =
  | { kind: "population"; comparison: PopulationComparison; value: number }
  | { kind: "count"; comparison: CountComparison; value: number; offense: OffenseIdentity; offenseLabel: string };

/**
 * What the request ranks. "city"/"town" rank city agencies; "jurisdiction" ranks the source's
 * reporting agencies of any type (GC-057; Codex design ruling 2026-09-26). The level is produced by
 * the noun the request used and carried to the builder -- never recovered from a default.
 */
export type EntityLevel = "city" | "jurisdiction";

export type CityRankingRequest = {
  kind: "ranking";
  source: CityRankingSource;
  entityLevel: EntityLevel;
  scope: { kind: "nationwide" } | { kind: "state"; code: string; name: string };
  offense: OffenseIdentity;
  offenseLabel: string;
  sort: { quantity: RankingQuantity; direction: "desc" | "asc" };
  period: { kind: "explicit"; year: number } | { kind: "latest_with_data" };
  resultCount: number;
  /**
   * Conditions the REQUEST stated, combined conjunctively -- which is what the builder's eligibility
   * array means. A disjunction is declined at recognition; it never reaches here.
   */
  eligibility: EligibilityCondition[];
  caveats: string[];
  /** Every claim and what it produced, plus where each assembled field came from. Evidence. */
  accounting: Claim[];
  /** Which quantity each stated unit qualified. Evidence; nothing downstream reads it. */
  unitOwnership: UnitOwnership[];
  /** The measure and condition groups the request was collected into, by span. Evidence. */
  groups: GroupMembership[];
  /** For each semantic field, whether it came from a production or a declared default. */
  origins: FieldOrigin[];
};

/**
 * Which quantity each stated unit ended up qualifying.
 *
 * Evidence, not an input: nothing downstream reads it. It is carried on the recognition so that
 * ownership can be checked directly rather than inferred from whichever refusal reason came out.
 */
export type UnitOwnership = { text: string; span: Span; owner: UnitOwnerKind | "none"; group: string };

/** Recognised as this family, but not carryable. Owned, and never handed back to the model. */
export type CityRankingUnsupported = {
  kind: "unsupported"; reason: string; explanation: string;
  unitOwnership?: UnitOwnership[];
  groups?: GroupMembership[];
};

export type CityRankingRecognition = CityRankingRequest | CityRankingUnsupported | null;

const decline = (reason: string, explanation: string): CityRankingUnsupported =>
  ({ kind: "unsupported", reason, explanation });

/* ================================================================== *
 * 1. Productions, claims and origins
 * ================================================================== */

export type Span = [number, number];

/**
 * What a stretch of the request produced.
 *
 * `presentation` is the ONLY production that yields no value, and it has to name the rule that
 * justified it. Everything else hands the assembler a typed value; a clause that cannot hand one
 * over is a failure, not an absence.
 */
export type Production =
  | { field: "entity"; level: EntityLevel }
  | { field: "direction"; direction: "asc" | "desc"; strength: "superlative" | "position" }
  | { field: "size"; count: number }
  | { field: "crime"; token: string }
  | { field: "unit"; quantity: RankingQuantity }
  | { field: "denominator"; basis: number }
  | { field: "geography"; name: string }
  // A STATED nationwide scope ("U.S. cities", "in the United States", "nationwide"). Distinct from a
  // state name and from an omitted geography: assembly records it as a production, never a default.
  | { field: "geography"; name: string; national: true }
  | { field: "period"; year: number }
  // "currently", "right now": the request names the latest period rather than omitting one (GC-064).
  | { field: "recency"; latest: true }
  | { field: "population"; comparison: PopulationComparison; value: number }
  | { field: "count"; comparison: CountComparison; value: number; crimeToken: string | null }
  | { field: "relationship"; relation: "all" | "any" }
  | { field: "filler"; rule: string };

export type ClaimField = Production["field"];

export type Claim = {
  field: ClaimField;
  span: Span;
  text: string;
  rule: string;
  /** The value this claim handed the assembler. */
  produces: Production;
  /** The parts of its own span this claim actually explained. */
  explains: Span[];
};

/** Where an assembled field came from. A default is legitimate only for a genuine omission. */
export type FieldOrigin = {
  field: string;
  from: "production" | "declared-default" | "resolved-leaf";
  detail: string;
};

/**
 * A clause that was stated and could not produce.
 *
 * This type is the fallback boundary. An absent clause is simply not in the ledger; a FAILED clause
 * is recorded, and assembly refuses to reach a default past one.
 */
export type FailedClause = { span: Span; reason: string; explanation: string };

/**
 * A semantic field the REQUEST spoke about.
 *
 * Recorded when a clause's words are recognised, BEFORE anything tries to turn them into a value,
 * and kept somewhere the productions are not. That separation is the whole guarantee: if a stated
 * field's production goes missing, the obligation to have one does not go with it, so absence can
 * never be mistaken for the reader having said nothing.
 */
export type StatedField =
  | "direction" | "size" | "unit" | "crime" | "geography" | "period" | "population" | "count";

/**
 * ONE EXPLICIT CONTRIBUTION, recorded at the span that made it.
 *
 * The previous version recorded obligations PER FIELD, in a `Set<StatedField>`, and discharged them
 * by a pooled count -- `unitWords.size + bases.length` for the unit. Two contributions to one field
 * therefore shared a single obligation, so deleting `per 1000` was satisfied by the word `rate`
 * surviving, and a request for a rate per 1,000 was answered per 100,000 with nothing to notice.
 *
 * An obligation now belongs to the WORDS that made it. A production discharges the obligation at
 * its own span and no other.
 */
export type Obligation = { field: StatedField; span: Span; key: string; text: string };

const spanKey = (span: Span): string => `${span[0]}:${span[1]}`;

/**
 * Which quantity a unit contribution qualifies.
 *
 * `ranking` is the measure the places are ordered by; `count` and `population` are the eligibility
 * clauses. This is the decision the old design never made: it collected every unit word and every
 * denominator into one bag and handed them to the ranking, whatever they were written next to.
 */
export type UnitOwnerKind = "ranking" | "count" | "population";

type ClauseOutcome =
  | { kind: "claim"; span: Span; explains: Span[]; rule: string; produces: Production; states?: StatedField[] }
  | { kind: "failed"; span: Span; reason: string; explanation: string; states?: StatedField[] }
  /**
   * A number this family cannot read exactly. It is separate from `failed` because it is decided
   * before a clause is known, and it must decline with the number's own wording.
   */
  | { kind: "malformed"; span: Span; why: "fractional" | "grouping" };

/**
 * The accounting ledger.
 *
 * A claim that overlaps an existing one is REFUSED rather than merged: two fields reading the same
 * words is the ambiguity this design exists to remove.
 */
class Ledger {
  readonly claims: Claim[] = [];
  readonly failures: FailedClause[] = [];
  /**
   * What the request EXPLICITLY contributed, one entry per contributing SPAN.
   * Deliberately not derived from `claims`: deleting a claim must not delete its obligation, and a
   * second contribution to the same field must not be able to discharge the first one's.
   */
  readonly obligations: Obligation[] = [];
  /**
   * The measure and condition groups this request was collected into.
   *
   * A group, not a per-word verdict, is what owns a unit: the parts of one measure stay together,
   * and assembly reads the group rather than searching the request again.
   */
  private measureGroups: MeasureGroup[] = [];
  private groupBySpan = new Map<string, MeasureGroup>();
  private readonly taken: boolean[];
  constructor(private readonly question: string) {
    this.taken = new Array(question.length).fill(false);
  }
  overlaps([start, end]: Span): boolean {
    for (let i = start; i < end; i += 1) if (this.taken[i]) return true;
    return false;
  }
  private take(span: Span): void {
    for (let i = span[0]; i < span[1]; i += 1) this.taken[i] = true;
  }
  record(outcome: Exclude<ClauseOutcome, { kind: "malformed" }>): boolean {
    if (outcome.span[1] <= outcome.span[0]) return false;
    if (this.overlaps(outcome.span)) return false;
    this.take(outcome.span);
    // Recorded BEFORE produced, and for a failed clause too: a clause that could not produce still
    // establishes that the reader asked for that field, at these words.
    for (const field of outcome.states ?? []) {
      this.obligations.push({
        field, span: outcome.span, key: spanKey(outcome.span),
        text: this.question.slice(outcome.span[0], outcome.span[1]),
      });
    }
    if (outcome.kind === "failed") {
      this.failures.push({ span: outcome.span, reason: outcome.reason, explanation: outcome.explanation });
      return true;
    }
    this.claims.push({
      field: outcome.produces.field,
      span: outcome.span,
      text: this.question.slice(outcome.span[0], outcome.span[1]),
      rule: outcome.rule,
      produces: outcome.produces,
      explains: outcome.explains,
    });
    return true;
  }
  claimWord(field: ClaimField, span: Span, rule: string, produces: Production, states?: StatedField[]): boolean {
    return this.record({ kind: "claim", span, explains: [span], rule, produces, states });
  }
  producing<F extends ClaimField>(field: F): Extract<Production, { field: F }>[] {
    return this.claims
      .filter((claim) => claim.produces.field === field)
      .map((claim) => claim.produces as Extract<Production, { field: F }>);
  }
  of(field: ClaimField): Claim[] {
    return this.claims.filter((claim) => claim.field === field);
  }
  /**
   * Every explicit contribution whose own span produced nothing.
   *
   * In ordinary operation this is always empty -- an obligation and its claim are written in the
   * same call -- so this changes no answer. It is the invariant that makes losing one impossible.
   */
  undischarged(): Obligation[] {
    const discharged = new Set(this.claims.map((claim) => spanKey(claim.span)));
    return this.obligations.filter((obligation) => !discharged.has(obligation.key));
  }
  /** Unit contributions -- a measure word, `per capita`, or a numeric `per N` -- in written order. */
  unitContributions(): Claim[] {
    return this.claims
      .filter((claim) => claim.produces.field === "unit" || claim.produces.field === "denominator")
      .sort((a, b) => a.span[0] - b.span[0]);
  }
  setGroups(groups: MeasureGroup[]): void {
    this.measureGroups = groups;
    this.groupBySpan = new Map();
    for (const group of groups) {
      for (const member of group.members) this.groupBySpan.set(spanKey(member.span), group);
    }
  }
  groups(): MeasureGroup[] { return this.measureGroups; }
  groupAt(span: Span): MeasureGroup | null { return this.groupBySpan.get(spanKey(span)) ?? null; }
  /** The one group the ranking measure's own parts belong to. */
  rankingGroup(): MeasureGroup | null {
    return this.measureGroups.find((group) => group.kind === "ranking") ?? null;
  }
  ownerOf(span: Span): UnitOwnerKind | null {
    return this.groupAt(span)?.kind ?? null;
  }
  /**
   * Group membership, keyed by each member's OWN SPAN.
   *
   * Evidence; nothing downstream reads it. Spans rather than text, so the same word appearing in
   * two clauses is two distinct memberships rather than one collapsed entry.
   */
  membershipEvidence(): GroupMembership[] {
    const out: GroupMembership[] = [];
    for (const group of this.measureGroups) {
      for (const member of group.members) {
        out.push({ group: group.id, kind: group.kind, field: member.field, text: member.text, span: member.span });
      }
    }
    return out.sort((a, b) => a.span[0] - b.span[0]);
  }
  /** Which quantity each stated unit qualified. Evidence; nothing downstream reads it. */
  ownershipEvidence(): UnitOwnership[] {
    return this.unitContributions().map((claim) => ({
      text: claim.text, span: claim.span,
      owner: this.ownerOf(claim.span) ?? "none",
      group: this.groupAt(claim.span)?.id ?? "none",
    }));
  }
  /** Every stretch of non-space text NO claim covers. */
  residue(): { text: string; span: Span }[] {
    return gaps(this.question, (i) => this.taken[i]);
  }
  /**
   * Every stretch of non-space text inside a claim that the claim did not explain.
   *
   * The same rule as outer residue, applied to a claim's interior: a match wide enough to swallow
   * `attempted` is not evidence that `attempted` was understood.
   */
  interiorResidue(): { text: string; span: Span; claim: Claim }[] {
    const out: { text: string; span: Span; claim: Claim }[] = [];
    for (const claim of this.claims) {
      const explained = new Array(this.question.length).fill(false);
      for (const [start, end] of claim.explains) {
        for (let i = start; i < end; i += 1) explained[i] = true;
      }
      for (const piece of gaps(this.question, (i) => explained[i], claim.span)) {
        out.push({ ...piece, claim });
      }
    }
    return out;
  }
}

/** Runs of non-space text in `[from, to)` for which `covered` is false. */
function gaps(
  text: string, covered: (index: number) => boolean, within?: Span
): { text: string; span: Span }[] {
  const [from, to] = within ?? [0, text.length];
  const out: { text: string; span: Span }[] = [];
  let start = -1;
  for (let i = from; i <= to; i += 1) {
    const open = i < to && !covered(i) && !/\s/.test(text[i]);
    if (open && start < 0) start = i;
    if (!open && start >= 0) { out.push({ text: text.slice(start, i), span: [start, i] }); start = -1; }
  }
  return out;
}

/* ================================================================== *
 * 2. Numbers, read atomically
 * ================================================================== */

export type NumericToken = {
  span: Span;
  text: string;
  value: number;
  /** `1234` or `1,234`. A grouping like `1,00,000` is not. */
  wellFormed: boolean;
  fractional: boolean;
  suffix: "k" | "m" | null;
  /** The scale word's own span, when there is one. */
  suffixSpan: Span | null;
  /** Where the number AND its scale word end. */
  end: number;
};

const SUFFIX_AFTER = /^\s*(k|thousand|m|mm|million)\b/i;

/**
 * Every numeric token in the request, read whole.
 *
 * THE DEFECT THIS REPLACES: the old matcher searched for `(\d[\d,]*)` anywhere, so in "at least 1.5
 * million people" it began at the `5` and produced five million. A number is read from its own
 * first digit or not at all.
 */
export function scanNumbers(question: string): NumericToken[] {
  const out: NumericToken[] = [];
  const run = /\d[\d.,]*/g;
  for (let m = run.exec(question); m; m = run.exec(question)) {
    const start = m.index;
    // A run that begins immediately after a digit, a decimal point or a group separator is not a
    // number of its own.
    if (start > 0 && /[\d.,]/.test(question[start - 1])) continue;
    const text = m[0].replace(/[.,]+$/, "");        // a trailing comma or full stop is punctuation
    if (text.length === 0) continue;
    const end = start + text.length;
    const suffixMatch = SUFFIX_AFTER.exec(question.slice(end));
    const suffixWord = suffixMatch ? suffixMatch[1].toLowerCase() : null;
    out.push({
      span: [start, end],
      text,
      value: Number(text.replace(/,/g, "")),
      wellFormed: /^\d+$/.test(text) || /^\d{1,3}(?:,\d{3})+$/.test(text)
        || /^\d+\.\d+$/.test(text) || /^\d{1,3}(?:,\d{3})+\.\d+$/.test(text),
      fractional: text.includes("."),
      suffix: suffixWord === null ? null : (suffixWord === "k" || suffixWord === "thousand" ? "k" : "m"),
      suffixSpan: suffixMatch ? [end + suffixMatch[0].length - suffixMatch[1].length, end + suffixMatch[0].length] : null,
      end: suffixMatch ? end + suffixMatch[0].length : end,
    });
  }
  return out;
}

/** The scale an explicit suffix applies. A bare number is NEVER multiplied. */
function scaled(token: NumericToken): number {
  if (token.suffix === "k") return token.value * 1000;
  if (token.suffix === "m") return token.value * 1_000_000;
  return token.value;
}

/* ================================================================== *
 * 3. Clause vocabularies
 * ================================================================== */

const LEADING_COMPARISON: [RegExp, PopulationComparison][] = [
  [/\b(?:at\s+least|no\s+fewer\s+than|no\s+less\s+than|minimum\s+of)\s*$/i, ">="],
  [/\b(?:more\s+than|greater\s+than|larger\s+than|over|above|exceeding)\s*$/i, ">"],
  [/\b(?:at\s+most|no\s+more\s+than|no\s+greater\s+than|maximum\s+of)\s*$/i, "<="],
  [/\b(?:fewer\s+than|less\s+than|smaller\s+than|under|below)\s*$/i, "<"],
];

const TRAILING_QUALIFIER: [RegExp, PopulationComparison][] = [
  [/^(?:\+|or\s+(?:more|greater|above|higher|larger))$/i, ">="],
  [/^(?:or\s+(?:fewer|less|below|lower|smaller))$/i, "<="],
];

/** ">=" and ">" both mean "bigger"; "<=" and "<" both mean "smaller". */
const sense = (comparison: PopulationComparison): "up" | "down" =>
  comparison === ">=" || comparison === ">" ? "up" : "down";

const POPULATION_AFTER =
  /^\s*(\+|or\s+(?:more|greater|above|higher|larger|fewer|less|below|lower|smaller))?\s*(people|residents?|inhabitants?|population)\b(\s*or\s+(?:more|greater|above|higher|larger|fewer|less|below|lower|smaller))?/i;

const POPULATION_NOUN_BEFORE =
  /\b(populations?|pop\.?|min\.?|minimum|max\.?|maximum)\s*(?:of\s+)?(at\s+least|at\s+most|no\s+fewer\s+than|no\s+less\s+than|no\s+more\s+than|greater\s+than|larger\s+than|less\s+than|fewer\s+than|smaller\s+than|more\s+than|over|above|under|below|>=|>|<=|<|,|:)?\s*$/i;

const COUNT_COMPARISON: [RegExp, CountComparison][] = [
  [/\b(?:at\s+least|no\s+fewer\s+than|no\s+less\s+than|minimum\s+of|minimum|min\.?)\s*$/i, ">="],
  [/\b(?:more\s+than|over)\s*$/i, ">"],
];

const OFFENSE_TOKENS: [RegExp, string][] = [
  [/\bshoplift\w*/i, "shoplifting"],
  [/\bcarjack\w*/i, "carjacking"],
  [/\bmurders?\b|\bhomicides?\b|\bkillings?\b/i, "murder"],
  [/\bsexual\s+assaults?\b|\brapes?\b/i, "rape"],
  [/\brobber(?:y|ies)\b/i, "robbery"],
  [/\bburglar(?:y|ies)\b/i, "burglary"],
  [/\bmotor\s+vehicle\s+thefts?\b|\bauto\s+thefts?\b|\bvehicle\s+thefts?\b/i, "motor_vehicle_theft"],
  [/\baggravated\s+assaults?\b|\bassaults?\b/i, "assault"],
  [/\blarcen(?:y|ies)\b|\bthefts?\b/i, "larceny"],
  [/\bviolent\s+crimes?\b/i, "violent_crime"],
  [/\bproperty\s+crimes?\b/i, "property_crime"],
  [/\barsons?\b/i, "arson"],
];

export function offenseToken(text: string): string | null {
  for (const [pattern, token] of OFFENSE_TOKENS) if (pattern.test(text)) return token;
  return null;
}

const ENTITY_NOUN = /\b(?:cit(?:y|ies)|jurisdictions?|towns?)\b/gi;
/*
 * A STATED NATIONWIDE SCOPE, claimed only in its geographic role (Codex national-ranking ruling,
 * 2026-10-01). Each form is context-bound so that it cannot swallow a different meaning:
 *  - as a modifier of the ranked noun: "U.S. cities", "US jurisdictions", "United States towns",
 *    "American cities". "US" must be upper case, so the pronoun in "show us the cities" is never read
 *    as the country; "US Marshals", "U.S. Virgin Islands" and "American Samoa" do not precede a
 *    ranked noun and are not claimed.
 *  - as a place phrase: "in/across/throughout the U.S. / US / United States", but not when another
 *    capitalised word follows ("in the U.S. Virgin Islands") and never after other prepositions
 *    ("outside the US" stays unclaimed and declines).
 *  - the adverb "nationwide".
 * The request contract's national shortcut is not the authority: it also reads "show us" and
 * "U.S. Virgin Islands" as national, and does not read "American". These words are claimed here.
 */
const ENTITY_FOLLOWS = String.raw`(?=\s+(?:cit(?:y|ies)|jurisdictions?|towns?)\b)`;
const NATIONAL_MODIFIER_CASED = new RegExp(String.raw`(?<![A-Za-z.])(?:U\.S\.|US)` + ENTITY_FOLLOWS, "g");
const NATIONAL_MODIFIER_WORDS = new RegExp(String.raw`\b(?:United\s+States|American)` + ENTITY_FOLLOWS, "gi");
// Case-sensitive on purpose: the "no capitalised word follows" guard must not be case-folded.
const NATIONAL_PLACE_CASED = /\b(?:[Ii]n|[Aa]cross|[Tt]hroughout)\s+the\s+(?:U\.S\.|US|United\s+States|united\s+states)(?![A-Za-z.])(?!\s+[A-Z])/g;
const NATIONAL_ADVERB = /\bnationwide\b/gi;
// An upper-case postal code after a place preposition ("in IN", "across TX"). Case-sensitive on purpose:
// the lower-case preposition itself ("in") must never read as Indiana.
const STATED_STATE_CODE = new RegExp(
  String.raw`(?<=\b(?:[Ii]n|[Aa]cross|[Tt]hroughout|[Ww]ithin)\s+)(?:${Object.values(STATE_NAME_TO_ABBR).join("|")})(?![A-Za-z])`, "g");
/*
 * `largest` and `smallest` are deliberately NOT direction words. They describe the cities, not the
 * measure: in "top 10 largest cities by murder rate" the superlative orders population and the
 * ranking orders murder. They are declined by name below instead.
 */
const DIRECTION_ASC = /\b(?:lowest|fewest|safest|least)\b/gi;
const DIRECTION_DESC = /\b(?:highest|worst|greatest|most)\b/gi;
const RANK_ASC_WORD = /\bbottom\b/gi;
const RANK_DESC_WORD = /\btop\b/gi;
const RANK_VERB = /\brank(?:ed|ing|s)?\b/gi;
const RATE_WORD = /\brates?\b|\bper\s+capita\b/gi;
/*
 * "Currently" names the most recent period. It PRODUCES the same latest-with-observed-data period the
 * omitted-year default uses, so the answer still names the year it used and marks a partial year; it
 * is not filler, and it cannot be combined with an explicit year.
 */
const RECENCY_WORD = /\b(?:currently|right\s+now|at\s+present|presently|these\s+days)\b/gi;
/*
 * A SHARE BY WEAPON is one measure, claimed whole: "share via firearm", "percentage of murders with a
 * gun", "firearm share". It is the ranked measure (a crime-field claim), so no separate unit word has
 * to find an owner; the offense it is a share OF comes from the words inside it or, when they name
 * none, from the stated count condition ("min 30 murders"). SHR only (GC-061).
 */
const FIREARM_SHARE = /\b(?:shares?|percent(?:ages?)?|proportions?)\s+(?:of\s+(?:(?:murder|homicide)\s+victims|murders?|homicides?)\s+)?(?:(?:via|by|with|using|committed\s+with)\s+(?:a\s+)?)(?:firearms?|guns?)\b|\b(?:firearm|gun)\s+(?:shares?|percent(?:ages?)?|proportions?)(?:\s+of\s+(?:(?:murder|homicide)\s+victims|murders?|homicides?))?\b/gi;
const COUNT_WORD = /\bcounts?\b|\bnumbers?\b|\btotals?\b/gi;

/* ================================================================== *
 * 4. Presentation filler -- each rule paired in the suite
 * ================================================================== */

/**
 * Filler rules.
 *
 * `leading`/`trailing` apply only at the ends of the request. `between` applies ONLY to a token
 * between two claimed spans, so a connector joining two accounted-for clauses is filler while the
 * same word trailing something unaccounted-for is not.
 *
 * NOTE WHAT IS NO LONGER HERE. `and`/`or` used to be a filler rule, and that is how a disjunction
 * became a conjunction: a word standing between two CONDITION claims names their relationship, so
 * it now produces one. Negations, comparison operators, numerals and period words are likewise
 * absent and must stay absent. `scripts/test-city-ranking.ts` derives its coverage from this array,
 * so a rule added here cannot escape its pair.
 */
export const FILLER_RULES: { rule: string; pattern: RegExp; where: "leading" | "trailing" | "between" }[] = [
  { rule: "request-opener", where: "leading", pattern: /^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:show|list|give|tell|display|find|get)\s+(?:me\s+)?(?:the\s+)?/i },
  { rule: "question-opener", where: "leading", pattern: /^\s*(?:what|which|who)\s+(?:are\s+|is\s+|were\s+|was\s+)?(?:the\s+)?/i },
  { rule: "trailing-punctuation", where: "trailing", pattern: /[\s?.!]+$/ },
  { rule: "determiner", where: "between", pattern: /^(?:the|a|an)$/i },
  { rule: "preposition", where: "between", pattern: /^(?:in|of|by|for|with|at|to|from|on)$/i },
  { rule: "auxiliary", where: "between", pattern: /^(?:had|have|has|was|were|is|are|did|do|that|there)$/i },
  { rule: "punctuation", where: "between", pattern: /^[(),:;'"’-]+$/ },
];

/** Words that join two conditions. Between CONDITION claims these produce a relationship. */
const CONNECTOR: [RegExp, "all" | "any"][] = [
  [/^(?:and)$/i, "all"],
  [/^(?:or)$/i, "any"],
];

/* ================================================================== *
 * 5. Family gate and shapes declined by name
 * ================================================================== */

const RANK_PHRASE = /\b(?:top|bottom)\s+\d+\b|\b(?:highest|lowest|most|fewest|worst|greatest)\b|\brank(?:ed|ing|s)?\b/i;
const CITY_NOUN = /\b(?:cit(?:y|ies)|jurisdictions?|towns?)\b/i;
const CHANGE_PHRASE =
  /\b(?:increase[ds]?|increasing|decrease[ds]?|decreasing|decline[ds]?|declining|drop(?:ped|ping)?|rose|risen|rising|fell|fallen|falling|grew|growth|change[ds]?|changing|trend(?:s|ing)?|year[- ]over[- ]year|yoy|since\s+\d{4}|compared\s+to\s+\d{4})\b/i;
const PEER_PHRASE =
  /\b(?:peer|comparable|like[- ]for[- ]like|same\s+size)\b|\bsimilar(?:ly)?\s+(?:sized?|size|population)\b|\bof\s+similar\b/i;
const CHRONOLOGICAL =
  /\b(?:by\s+year|per\s+year|each\s+year|by\s+month|per\s+month|each\s+month|annual\s+totals?|over\s+time|by\s+quarter)\b/i;
const BREAKDOWN_PHRASE = /\bby\s+(?:race|sex|gender|age|weapon|location|offense\s+type)\b/i;

/**
 * A threshold on a RATE. This family has no rate eligibility and must not retype one into a count
 * floor and a population floor, which an earlier version did.
 */
const RATE_THRESHOLD: RegExp[] = [
  /\brates?\s+(?:of|at|above|below|over|under|exceeding)\s+(?:at\s+least\s+|at\s+most\s+|more\s+than\s+|less\s+than\s+|fewer\s+than\s+|greater\s+than\s+)?\d/i,
  /\b(?:at\s+least|at\s+most|more\s+than|less\s+than|fewer\s+than|greater\s+than|over|under|above|below)\s+\d[\d,.]*\s*(?:offen[cs]es?|crimes?|incidents?)?\s*per\s+[\d,]+/i,
  /\bper[-\s]capita\s+(?:rate\s+)?(?:of|above|below|over|under|at\s+least)\s+\d/i,
];

const UNAMBIGUOUS_MONTH =
  /\b(?:january|february|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)\b/i;
/** "may" and "march" are ordinary words; only a neighbouring year makes them a month here. */
const AMBIGUOUS_MONTH = /\b(?:in|during|for|through|since)\s+(?:may|march)\b|\b(?:may|march)\s+\d{4}\b/i;
const SUB_YEAR_PERIOD =
  /\bq[1-4]\b|\b(?:first|second|third|fourth)\s+quarter\b|\bmonth\s+of\b|\byear[-\s]to[-\s]date\b|\bytd\b|\bhalf\s+of\s+\d{4}\b/i;

export function mentionsSubYearPeriod(question: string): boolean {
  return UNAMBIGUOUS_MONTH.test(question) || AMBIGUOUS_MONTH.test(question) || SUB_YEAR_PERIOD.test(question);
}

/**
 * A size word describing the cities themselves.
 *
 * Answering "rank LARGE cities" with every city is true to the letter and useless: the reader asked
 * for large cities and got all of them. There is no field for a vague size, so it declines.
 */
const VAGUE_SIZE =
  /\b(large[rst]?|big(?:ger|gest)?|small(?:er|est)?|major|medium(?:[-\s]sized?)?|mid[-\s]?sized?|sizable|sizeable|tiny)\s+(?:cit(?:y|ies)|towns?|jurisdictions?)\b/i;

/* ================================================================== *
 * 6. Source-specific offense mapping, resolved from the CLAIM
 * ================================================================== */

/**
 * Resolve an offense from the words that claimed it, not from the whole question.
 *
 * The established 23C shoplifting mapping is preserved: the contract resolves no code for it, and
 * an unavailable resolver field is not a contradiction when an explicit source mapping supports the
 * clause. That allowance is exactly this one mapping; it adds none.
 */
function nibrsOffense(claimText: string, codes: string[]): { offense: OffenseIdentity; label: string; caveats: string[] } | null {
  if (codes.length > 0) {
    return { offense: { kind: "nibrs_codes", codes }, label: codes.map((code) => UCR_CODES[code] ?? code).join(", "), caveats: [] };
  }
  if (/\bshoplift(?:ing)?\b/i.test(claimText)) {
    return { offense: { kind: "nibrs_codes", codes: ["23C"] }, label: UCR_CODES["23C"] ?? "Shoplifting", caveats: [] };
  }
  return null;
}

const SEXUAL_ASSAULT_CAVEAT =
  "This database uses the FBI's UCR category \"Rape\" (forcible rape, sodomy, and sexual assault " +
  "with an object), not the broader legal definition of sexual assault, which varies by jurisdiction.";

function currentOffense(claimText: string): { offense: OffenseIdentity; label: string; caveats: string[] } | null {
  if (/\bsexual\s+assaults?\b/i.test(claimText)) {
    // The existing Current policy maps this to Rape AND requires the category caveat with it.
    return { offense: { kind: "current_offense", value: "Rape" }, label: "Sexual assault", caveats: [SEXUAL_ASSAULT_CAVEAT] };
  }
  if (/\brapes?\b/i.test(claimText)) return { offense: { kind: "current_offense", value: "Rape" }, label: "Rape", caveats: [] };
  if (/\bmurders?\b|\bhomicides?\b/i.test(claimText)) {
    return { offense: { kind: "current_offense", value: "Murder" }, label: "Murder", caveats: [] };
  }
  return null;
}

/**
 * SHR: the owned-count measure words, unchanged. "homicide(s)" is every homicide victim and carries the
 * application's all-homicide sentence; "murder(s)" is murder and nonnegligent manslaughter victims.
 * "killings" names neither measure, so it is not resolved here.
 */
function shrOffense(claimText: string): { offense: OffenseIdentity; label: string; caveats: string[] } | null {
  if (/\bhomicides?\b/i.test(claimText)) {
    return { offense: { kind: "shr_victims", measure: "homicide" }, label: "Homicide", caveats: [SHR_ALL_HOMICIDE_DISCLOSURE] };
  }
  if (/\bmurders?\b/i.test(claimText)) {
    return { offense: { kind: "shr_victims", measure: "murder" }, label: "Murder", caveats: [] };
  }
  return null;
}

function resolveOffense(
  claimText: string, source: CityRankingSource
): { offense: OffenseIdentity; label: string; caveats: string[] } | null {
  if (source === "nibrs") {
    return nibrsOffense(claimText, buildQueryContract(claimText, source)?.metric.offenseCodes ?? []);
  }
  if (source === "shr") return shrOffense(claimText);
  return currentOffense(claimText);
}

const sameIdentity = (a: OffenseIdentity, b: OffenseIdentity): boolean => {
  if (a.kind === "shr_victims" && b.kind === "shr_victims") return a.measure === b.measure;
  if (a.kind === "current_offense" && b.kind === "current_offense") return a.value === b.value;
  if (a.kind === "nibrs_codes" && b.kind === "nibrs_codes") {
    return a.codes.length === b.codes.length && a.codes.every((code, i) => code === b.codes[i]);
  }
  return false;
};

/* ================================================================== *
 * 7. Declared defaults, for genuinely omitted fields only
 * ================================================================== */

/** The existing ranking policy's default when the request names no count. */
export const DEFAULT_RESULT_COUNT = 20;
/** The largest ranking this family will build. Above it the request is declined, never shrunk. */
export const MAX_RESULT_COUNT = 100;

const SIZE_BEFORE = /\b(top|bottom|first|highest|lowest|worst|safest)\s+$/i;

/* ================================================================== *
 * 8. Clause parsing: each number becomes a production, or a failure
 * ================================================================== */

/**
 * The supported count-clause forms, parsed whole.
 *
 * Three forms and no others, each of which accounts for every word it covers:
 *
 *   direct          `100 murders`                    a crime noun on its own
 *   phrase          `100 shoplifting offenses`       an offense phrase matched IN FULL, then a
 *                                                    generic count noun
 *   generic         `100 offenses`                   a generic count noun, referring to the crime
 *                                                    already being ranked
 *
 * `unsupported-form` is returned when the words look like a threshold but are not one of those --
 * `100 attempted murders`, `100 attempted shoplifting offenses`, `100 per capita shoplifting
 * offenses`. The caller turns that into an owned limitation; it is never treated as a plain count.
 *
 * WHY "IN FULL" IS THE WHOLE POINT. The previous version asked `offenseToken(phrase)`, which finds
 * an offense ANYWHERE inside the phrase, and then declared the whole phrase explained. A match on
 * `shoplifting` was taken as understanding `attempted shoplifting`.
 */
const GENERIC_COUNT_NOUN = /^(?:offen[cs]es?|crimes?|incidents?|reports?)$/i;
const DIRECT_CRIME_NOUN =
  /^(?:murders?|homicides?|killings?|rapes?|robberies|burglaries|assaults?|thefts?|larcenies|carjackings?|arsons?)$/i;
/** How far past the number a count noun may sit before this stops being a count clause at all. */
const COUNT_NOUN_WINDOW = 4;

type CountTail =
  | { kind: "direct" | "phrase" | "generic"; start: number; length: number; token: string | null }
  | { kind: "unsupported-form"; start: number; length: number; token: null };

/** Does an offense pattern match this phrase COMPLETELY, rather than somewhere inside it? */
function fullyMatchedOffense(phrase: string): string | null {
  const trimmed = phrase.trim();
  if (!trimmed) return null;
  for (const [pattern, token] of OFFENSE_TOKENS) {
    const m = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(trimmed);
    if (m && m.index === 0 && m[0].length === trimmed.length) return token;
  }
  return null;
}

function parseCountTail(after: string): CountTail | null {
  const words: { text: string; start: number; end: number }[] = [];
  const scan = /[A-Za-z][A-Za-z'-]*/g;
  for (let m = scan.exec(after); m && words.length <= COUNT_NOUN_WINDOW; m = scan.exec(after)) {
    // Only words that follow the number contiguously; a digit in between ends the clause.
    if (/\d/.test(after.slice(words.length === 0 ? 0 : words[words.length - 1].end, m.index))) break;
    words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (words.length === 0) return null;

  const anchor = words.findIndex((w) => GENERIC_COUNT_NOUN.test(w.text) || DIRECT_CRIME_NOUN.test(w.text));
  if (anchor < 0 || anchor >= COUNT_NOUN_WINDOW) return null;   // not a count clause at all
  const start = words[0].start;
  const length = words[anchor].end;
  const isGeneric = GENERIC_COUNT_NOUN.test(words[anchor].text);

  if (isGeneric) {
    if (anchor === 0) return { kind: "generic", start, length, token: null };
    const phrase = after.slice(words[0].start, words[anchor - 1].end);
    const token = fullyMatchedOffense(phrase);
    return token
      ? { kind: "phrase", start, length, token }
      : { kind: "unsupported-form", start, length, token: null };
  }
  // A direct crime noun: the phrase INCLUDING it must match an offense in full, so "motor vehicle
  // thefts" works and "attempted murders" does not.
  const phrase = after.slice(words[0].start, words[anchor].end);
  const token = fullyMatchedOffense(phrase);
  return token
    ? { kind: "direct", start, length, token }
    : { kind: "unsupported-form", start, length, token: null };
}

function classifyNumber(question: string, token: NumericToken): ClauseOutcome | null {
  const before = question.slice(0, token.span[0]);
  const after = question.slice(token.end);

  // (a) a rate's denominator: "rate per 100,000". It produces a BASIS; whether that basis is one
  // this family builds is the assembler's decision, not a silent one made here.
  const perMatch = /\bper\s*$/i.exec(before);
  if (perMatch) {
    const span: Span = [perMatch.index, token.end];
    if (token.fractional || !token.wellFormed) {
      return { kind: "failed", span, states: ["unit"], reason: "denominator-unreadable",
        explanation: `I couldn't read the "${token.text}" in that rate as a single number, and guessing at it ` +
          "would change every figure. Ask for the rate per 100,000 and I can build the ranking." };
    }
    /*
     * A DENOMINATOR STATES THE UNIT. "per 100000" says the answer is a rate as plainly as the word
     * "rate" does, and recording only a denominator production left the unit looking omitted -- so
     * assembly took it from the resolver instead of from the request.
     */
    return { kind: "claim", span, explains: [span], rule: "rate-basis", states: ["unit"],
      produces: { field: "denominator", basis: scaled(token) } };
  }

  // (b) a population condition: the number sits with a population noun, either side.
  const popAfter = POPULATION_AFTER.exec(after);
  let popBefore = POPULATION_NOUN_BEFORE.exec(before);
  /*
   * "min"/"minimum"/"max" are population nouns only when nothing else owns the number. "minimum of
   * 30 murders" names a COUNT: read as a population condition it set population >= 30 and left the
   * offense word stranded (GC-061). When the words after the number complete a count form, the count
   * branch below reads it instead.
   */
  if (popBefore && !popAfter && /^(?:min\.?|minimum|max\.?|maximum)$/i.test(popBefore[1]) && parseCountTail(after)) {
    popBefore = null;
  }
  if (popAfter || popBefore) {
    if (token.fractional) return { kind: "malformed", span: token.span, why: "fractional" };
    if (!token.wellFormed) return { kind: "malformed", span: token.span, why: "grouping" };
    let start = token.span[0];
    let end = token.end;
    const explains: Span[] = [[token.span[0], token.end]];   // the number and its scale word
    let leading: PopulationComparison | null = null;
    let trailing: PopulationComparison | null = null;
    if (popAfter) {
      const nounStart = token.end + popAfter[0].indexOf(popAfter[2]);
      end = token.end + popAfter[0].length;
      explains.push([nounStart, nounStart + popAfter[2].length]);
      const qualifier = (popAfter[1] || popAfter[3] || "").trim();
      if (qualifier) {
        const qStart = token.end + popAfter[0].indexOf(qualifier);
        explains.push([qStart, qStart + qualifier.length]);
        for (const [pattern, comparison] of TRAILING_QUALIFIER) {
          if (pattern.test(qualifier)) { trailing = comparison; break; }
        }
      }
      for (const [pattern, comparison] of LEADING_COMPARISON) {
        const m = pattern.exec(before);
        if (m) { leading = comparison; start = m.index; explains.push([m.index, m.index + m[0].trimEnd().length]); break; }
      }
    } else if (popBefore) {
      start = popBefore.index;
      explains.push([popBefore.index, popBefore.index + popBefore[0].trimEnd().length]);
      const word = (popBefore[2] || "").trim().toLowerCase();
      const noun = popBefore[1].toLowerCase();
      leading = noun.startsWith("max") ? "<=" : ">=";
      const mapped = ([
        [/^(?:at\s+least|no\s+fewer\s+than|no\s+less\s+than|>=)$/, ">="],
        [/^(?:more\s+than|greater\s+than|larger\s+than|over|above|>)$/, ">"],
        [/^(?:at\s+most|no\s+more\s+than|<=)$/, "<="],
        [/^(?:fewer\s+than|less\s+than|smaller\s+than|under|below|<)$/, "<"],
      ] as [RegExp, PopulationComparison][]).find(([pattern]) => pattern.test(word));
      if (mapped) leading = mapped[1];
    }
    const span: Span = [start, end];
    if (leading && trailing && sense(leading) !== sense(trailing)) {
      return { kind: "failed", span, states: ["population"], reason: "population-ambiguous",
        explanation: "That population condition reads two ways to me, and applying the wrong one would change " +
          "which cities appear. State it once — for example \"cities with at least 250,000 people\"." };
    }
    return { kind: "claim", span, explains, rule: "population-condition", states: ["population"],
      produces: { field: "population", comparison: trailing ?? leading ?? ">=", value: scaled(token) } };
  }

  // (c) a count threshold, which must parse as a COMPLETE supported form.
  const countForm = parseCountTail(after);
  if (countForm) {
    for (const [pattern, comparison] of COUNT_COMPARISON) {
      const m = pattern.exec(before);
      if (!m) continue;
      const states: StatedField[] = ["count"];
      const span: Span = [m.index, token.end + countForm.length];
      if (token.fractional || !token.wellFormed) {
        return { kind: "failed", span, states, reason: "count-unreadable",
          explanation: `I couldn't read "${token.text}" as a whole number of offenses, and rounding it myself ` +
            "would change which cities you get. Give a whole number and I can build the ranking." };
      }
      /*
       * SCALED COUNT SHORTHAND IS DECLINED, NOT SILENTLY DROPPED. The span used to swallow the `k`
       * while eligibility read the unscaled 1. Population suffixes remain supported; this is the
       * deliberate asymmetry of the approved scope, not an oversight.
       */
      if (token.suffix !== null) {
        return { kind: "failed", span, states, reason: "count-scale-unsupported",
          explanation: `I can't read "${question.slice(token.span[0], token.end)}" as a number of offenses. ` +
            "Write the number out — for example \"at least 1000 murders\" — and I can build the ranking." };
      }
      if (countForm.kind === "unsupported-form") {
        /*
         * THE WHOLE PHRASE CONTRIBUTES, OR THE CLAUSE FAILS. The previous version asked whether an
         * offense word appeared ANYWHERE in the words before the noun and, if one did, declared the
         * entire phrase explained -- so "at least 100 attempted shoplifting offenses" delivered the
         * plain shoplifting threshold, with "attempted" gone. A substring match cannot certify the
         * words around it.
         */
        return { kind: "failed", span, states, reason: "count-clause-unsupported",
          explanation: `I couldn't take "${question.slice(token.end, token.end + countForm.length).trim()}" as a ` +
            "plain number of offenses, and treating it as one would apply a limit you didn't ask for. I can " +
            "keep only cities with at least a given number of offenses of the crime I'm ranking — for " +
            "example \"at least 100 murders\" — and I can build that." };
      }
      // Every word of the form contributed, so the whole of it is explained.
      const explains: Span[] = [
        token.span,
        [m.index, m.index + m[0].trimEnd().length],
        [token.end + countForm.start, token.end + countForm.length],
      ];
      return { kind: "claim", span, explains, rule: `count-condition-${countForm.kind}`, states,
        produces: { field: "count", comparison, value: token.value, crimeToken: countForm.token } };
    }
  }

  // (d) a year.
  if (!token.suffix && !token.fractional && token.wellFormed
      && /^\d{4}$/.test(token.text) && token.value >= 1960 && token.value <= 2100) {
    return { kind: "claim", span: token.span, explains: [token.span], rule: "explicit-year",
      states: ["period"], produces: { field: "period", year: token.value } };
  }

  // (e) the requested result size: "Top 10", "Bottom 2", and "Which 10 cities" (GC-061).
  const whichSize = /\b(?:which|what)\s+$/i.test(before) && /^\s*(?:cit(?:y|ies)|towns?)\b/i.test(after);
  if ((SIZE_BEFORE.test(before) || whichSize) && !token.suffix && !token.fractional && token.wellFormed) {
    return { kind: "claim", span: token.span, explains: [token.span], rule: "result-size",
      states: ["size"], produces: { field: "size", count: token.value } };
  }

  return null;   // unclassified: left as residue
}

/* ================================================================== *
 * 9. Word claims and filler
 * ================================================================== */

function claimWords(
  ledger: Ledger, question: string, pattern: RegExp, rule: string,
  produce: (text: string) => Production | null,
  states?: StatedField[],
): void {
  pattern.lastIndex = 0;
  for (let m = pattern.exec(question); m; m = pattern.exec(question)) {
    const production = produce(m[0]);
    if (!production) continue;
    ledger.claimWord(production.field, [m.index, m.index + m[0].length], rule, production, states);
  }
}

/**
 * Filler and connectors, applied last.
 *
 * A word between two CONDITION claims is a connector and produces a relationship. Everywhere else
 * the ordinary filler rules apply, and only between two accounted-for claims.
 */
function applyFillerAndConnectors(ledger: Ledger, question: string): void {
  for (const { rule, pattern, where } of FILLER_RULES) {
    if (where === "leading") {
      const m = pattern.exec(question);
      if (m && m.index === 0 && m[0].length > 0) {
        ledger.claimWord("filler", [0, m[0].length], rule, { field: "filler", rule });
      }
    } else if (where === "trailing") {
      const m = pattern.exec(question);
      if (m && m.index + m[0].length === question.length && m[0].trim().length > 0) {
        ledger.claimWord("filler", [m.index, question.length], rule, { field: "filler", rule });
      }
    }
  }
  const between = FILLER_RULES.filter((r) => r.where === "between");
  const isCondition = (claim: Claim) => claim.field === "population" || claim.field === "count";
  for (const piece of ledger.residue()) {
    /*
     * Ordered by POSITION, not by the order claims happened to be made. Reading `claims` in
     * insertion order put the number claims first, so "the claim before this word" was whichever
     * number had been parsed first -- and a connector sitting between two conditions was not
     * recognised as one.
     */
    const inOrder = ledger.claims.filter((c) => c.field !== "filler").sort((a, b) => a.span[0] - b.span[0]);
    const before = inOrder.filter((c) => c.span[1] <= piece.span[0]);
    const after = inOrder.filter((c) => c.span[0] >= piece.span[1]);
    if (before.length === 0 || after.length === 0) continue;
    // A connector standing between two conditions names their relationship; it is not inert.
    const connector = CONNECTOR.find(([pattern]) => pattern.test(piece.text));
    if (connector && isCondition(before[before.length - 1]) && isCondition(after[0])) {
      ledger.claimWord("relationship", piece.span, "condition-connector",
        { field: "relationship", relation: connector[1] });
      continue;
    }
    if (connector) continue;   // a connector elsewhere is left to the ordinary rules below
    const rule = between.find((r) => r.pattern.test(piece.text));
    if (rule) ledger.claimWord("filler", piece.span, rule.rule, { field: "filler", rule: rule.rule });
  }
}

/* ================================================================== *
 * 9b. Measure groups: a whole measure owns its parts
 * ================================================================== */

/**
 * WHY A GROUP, AND NOT A SEARCH FROM EACH WORD.
 *
 * Two rules have now failed here, and they failed the same way. The first chose a unit's quantity
 * by counting characters, so an article decided the answer. The second read the request's structure
 * but still searched outward FROM EACH CONTRIBUTION ALONE -- and a measure written across several
 * words has no identity under that scheme, so its parts were assigned separately:
 *
 *   `by the rate per 100000 of murder`   the `by` claimed `rate` for the ranking, and `per 100000`
 *                                        then walked past it into an earlier condition
 *   `per 100000 by highest murder rate`  the direction word stood between the unit and its measure,
 *                                        and the unit reached nothing at all
 *
 * So the measure is now a THING. Its head, its direction, its measure words and its denominator are
 * collected into one group, the group is what owns them, and assembly reads the group. A part can
 * no longer be assigned somewhere its own measure is not.
 */
export type MeasureGroupKind = "ranking" | "count" | "population";

export type MeasureGroup = {
  id: string;
  kind: MeasureGroupKind;
  /** The claim the group is built around: the ranked offense, or the condition itself. */
  head: Claim;
  /** Head, direction and every unit contribution the group owns, in written order. */
  members: Claim[];
};

/** Group membership as evidence: which group each member belongs to, by its own span. */
export type GroupMembership = { group: string; kind: MeasureGroupKind; field: ClaimField; text: string; span: Span };

/**
 * How a claim behaves when a unit contribution looks past it for the measure it belongs to.
 *
 * Two asymmetries carry real meaning and are not tidiness:
 *
 *   An ASIDE -- a period or a place -- interrupts a clause without ending it, so it is see-through
 *   looking BACK (a trailing unit still belongs to the condition it follows) and opaque looking
 *   FORWARD (an aside cannot hand a condition's unit to a later measure).
 *
 *   A DIRECTION opens the ranking instruction, so everything after it is part of that instruction
 *   (see-through looking forward) while everything before it belongs to what came earlier (opaque
 *   looking back). That is what lets `per 100000 by highest murder rate` reach its measure while
 *   `(min 250k) had the highest rate of carjackings` keeps its population limit to itself.
 */
type ClaimRole = "ranking" | "count" | "population" | "transparent" | "aside" | "direction" | "boundary";

function roleOfClaim(claim: Claim): ClaimRole {
  switch (claim.produces.field) {
    case "crime": return "ranking";
    case "count": return "count";
    case "population": return "population";
    case "filler": case "relationship": case "unit": case "denominator": return "transparent";
    case "period": case "geography": return "aside";
    case "direction": return "direction";
    default: return "boundary";   // size, entity
  }
}

/** `by` -- optionally with an article -- introduces the measure the ranking is ordered by. */
const RANKING_MEASURE_MARKER = /\bby\s+(?:the\s+|a\s+|an\s+)?$/i;

const isRateContribution = (claim: Claim): boolean =>
  claim.produces.field === "denominator"
  || (claim.produces.field === "unit" && claim.produces.quantity === "rate_per_100k");

const GROUP_ROLES: ClaimRole[] = ["ranking", "count", "population"];

/**
 * Collect the request into measure and condition groups, or decline.
 *
 * Groups are formed first -- one ranking group around the offense being ranked, one condition group
 * around each stated threshold or population limit -- and then every unit contribution joins one of
 * them:
 *
 *   1. `by` introduces the WHOLE ranking measure, so a unit it introduces joins the ranking group.
 *   2. A unit adjacent to a member of some group JOINS THAT GROUP. Looking back, presentation words
 *      and asides are see-through, and an already-placed unit hands over its own group rather than
 *      being stepped over -- which is what keeps `rate per 100000` together.
 *   3. Otherwise, looking forward through presentation words and the ranking's own direction.
 *
 * A unit that joins no group is unaccounted meaning and declines; a rate contribution inside a
 * condition group is the refusal this family already owns.
 */
function formMeasureGroups(ledger: Ledger, question: string): CityRankingUnsupported | null {
  const ordered = ledger.claims.slice().sort((a, b) => a.span[0] - b.span[0]);
  const groups: MeasureGroup[] = [];

  const rankedOffense = ordered.find((claim) => claim.produces.field === "crime") ?? null;
  if (rankedOffense) {
    /*
     * THE DIRECTION IS PART OF THE MEASURE. "Top 10 cities per 100000 by highest murder rate" is one
     * ranking instruction; treating `highest` as something outside it stranded the unit before it.
     */
    const directions = ordered.filter((claim) => claim.produces.field === "direction");
    groups.push({ id: "ranking", kind: "ranking", head: rankedOffense, members: [rankedOffense, ...directions] });
  }
  let conditionIndex = 0;
  for (const claim of ordered) {
    if (claim.produces.field !== "count" && claim.produces.field !== "population") continue;
    conditionIndex += 1;
    groups.push({
      id: `${claim.produces.field}:${conditionIndex}`,
      kind: claim.produces.field,
      head: claim,
      members: [claim],
    });
  }

  const groupOf = new Map<string, MeasureGroup>();
  for (const group of groups) for (const member of group.members) groupOf.set(spanKey(member.span), group);

  const ranking = groups.find((group) => group.kind === "ranking") ?? null;

  for (const contribution of ledger.unitContributions()) {
    let joined: MeasureGroup | null = null;

    // 1. `by` introduces the whole measure.
    if (ranking && RANKING_MEASURE_MARKER.test(question.slice(0, contribution.span[0]))) joined = ranking;

    // 2. What it follows. An already-placed unit hands over its group instead of being stepped past.
    if (!joined) {
      for (const claim of ordered.filter((c) => c.span[1] <= contribution.span[0]).reverse()) {
        const role = roleOfClaim(claim);
        const placed = groupOf.get(spanKey(claim.span)) ?? null;
        if (placed && (GROUP_ROLES.includes(role) || role === "transparent")) { joined = placed; break; }
        if (role === "transparent" || role === "aside") continue;
        break;   // a direction, a size or the entity noun ends the clause
      }
    }

    // 3. What it precedes, through presentation words and the ranking's own direction.
    if (!joined) {
      for (const claim of ordered.filter((c) => c.span[0] >= contribution.span[1])) {
        const role = roleOfClaim(claim);
        const placed = groupOf.get(spanKey(claim.span)) ?? null;
        if (placed && GROUP_ROLES.includes(role)) { joined = placed; break; }
        if (role === "transparent" || role === "direction") continue;
        break;
      }
    }

    if (!joined) {
      return decline("unit-unowned",
        `I couldn't tell what "${contribution.text.trim()}" is measuring in that request, and applying ` +
        "it to the wrong quantity would change every figure. Name the crime you want ranked — for " +
        "example \"rank cities by murder rate per 100,000\" — and I can build the ranking.");
    }
    joined.members.push(contribution);
    groupOf.set(spanKey(contribution.span), joined);
  }

  for (const group of groups) group.members.sort((a, b) => a.span[0] - b.span[0]);
  ledger.setGroups(groups);

  /*
   * A GROUP BEING PRESENT MUST NOT CONCEAL A LOST PART. Assembly reads the ranking group's members,
   * so a contribution that is recognised but never joins a group would simply not be asked about --
   * and a rate per 1,000 would come back as a rate per 100,000 with nothing to notice. Membership is
   * therefore audited against the contributions themselves rather than assumed from the walk above.
   */
  for (const contribution of ledger.unitContributions()) {
    const holding = groups.filter((group) => group.members.some((member) => member.span === contribution.span));
    if (holding.length === 1) continue;
    return decline("unit-unowned",
      `I couldn't tell what "${contribution.text.trim()}" is measuring in that request, and applying ` +
      "it to the wrong quantity would change every figure. Name the crime you want ranked — for " +
      "example \"rank cities by murder rate per 100,000\" — and I can build the ranking.");
  }

  /* ---- conflicts resolved inside the owning group ---- */
  for (const group of groups) {
    if (group.kind === "ranking") continue;
    const rate = group.members.find((member) => member !== group.head && isRateContribution(member));
    if (!rate) continue;
    if (group.kind === "count") {
      return decline("rate-eligibility",
        "That asks me to keep only cities whose RATE clears a threshold, and I can rank by a rate but " +
        "I can't filter on one. I can rank cities by that rate with no threshold, or keep only cities " +
        "with at least a given NUMBER of offenses — say which and I'll build it.");
    }
    return decline("population-rate-unsupported",
      `I read "${rate.text.trim()}" as qualifying the population limit, and a population is a ` +
      "number of people rather than a rate. State the two separately — for example \"rank cities by " +
      "murder rate per 100,000 with at least 500 people\" — and I can build the ranking.");
  }
  return null;
}

/* ================================================================== *
 * 10. Recognition and assembly
 * ================================================================== */

/**
 * Recognise a city ranking, or decline to.
 *
 * `null` means "not this family" and the request keeps its existing route. An `unsupported`
 * description means "this family, and we cannot carry it faithfully".
 */
export function recognizeCityRanking(question: string, source: CityRankingSource): CityRankingRecognition {
  if (!RANK_PHRASE.test(question) || !CITY_NOUN.test(question)) return null;
  if (CHANGE_PHRASE.test(question)) return null;
  if (PEER_PHRASE.test(question)) return null;
  if (CHRONOLOGICAL.test(question)) return null;
  if (BREAKDOWN_PHRASE.test(question)) return null;

  const contract = buildQueryContract(question, source);
  if (!contract) return null;
  /*
   * A RESOLVED period comparison is a change question and belongs to that family. The bare
   * `comparison.requested` flag is not usable alone: it reads "more than 100 offenses" as a
   * comparison, which silently dropped a supported threshold ranking.
   */
  if (contract.comparability.comparison.requested && contract.comparability.comparison.years) return null;
  if ((contract.breakdowns ?? []).some((b) => b === "year" || b === "month")) return null;
  // A named city is a request about that city, not a ranking of cities.
  if (contract.geographies.some((geo) => ["city", "county", "campus", "agency"].includes(geo.kind))) return null;

  /* ---- shapes declined by name, for a better message than "leftover words" ---- */

  if (RATE_THRESHOLD.some((pattern) => pattern.test(question))) {
    return decline("rate-eligibility",
      "That asks me to keep only cities whose RATE clears a threshold, and I can rank by a rate but " +
      "I can't filter on one. I can rank cities by that rate with no threshold, or keep only cities " +
      "with at least a given NUMBER of offenses — say which and I'll build it.");
  }
  if (mentionsSubYearPeriod(question)) {
    return decline("sub-year-period",
      "I can only rank cities over a whole year, and that request names a shorter period. Ask for the " +
      "full year and I can build the ranking.");
  }
  /*
   * Two gates that only ever DECLINE. They read the contract to give a specific reason instead of
   * "I couldn't place the word clearance", and they supply no value to the request -- the unit and
   * the scope are still assembled from productions below. A gate that can only refuse is not a
   * second source for a field.
   */
  // An SHR firearm share (GC-061) is the one ratio this family builds; its meaning is still assembled
  // from its own claim below, not from this gate.
  const shrShareRequest = source === "shr" && contract.metric.unit === "ratio" && new RegExp(FIREARM_SHARE.source, "i").test(question);
  if (!["count", "rate_per_100k", "unknown"].includes(contract.metric.unit) && !shrShareRequest) {
    return decline(`unit-${contract.metric.unit}`,
      "I can rank cities by a count or by a rate per 100,000, but not by that measure. Ask for the " +
      "number of offenses or the rate per 100,000 and I can build the ranking.");
  }
  if (stateCount(contract) > 1) {
    const named = contract.geographies.filter((geo) => geo.kind === "state")
      .map((geo) => geo.canonicalName ?? geo.name ?? geo.state ?? "a state");
    return decline("multi-state",
      `I can rank cities nationwide or within one state, and that request names ${named.join(" and ")}. ` +
      "Ask for one of them, or for the ranking nationwide, and I can build it.");
  }

  const vague = VAGUE_SIZE.exec(question);
  if (vague) {
    return decline("vague-size",
      `"${vague[0]}" doesn't tell me a size I can measure, and ranking every city instead would ignore ` +
      "the limit you asked for. Give a number — for example \"cities with at least 250,000 people\" " +
      "— and I can build the ranking.");
  }

  /* ---- claim every token, and record every clause that failed ---- */

  const ledger = new Ledger(question);
  for (const token of scanNumbers(question)) {
    const outcome = classifyNumber(question, token);
    if (!outcome) continue;
    if (outcome.kind === "malformed") {
      return outcome.why === "fractional"
        ? decline("fractional-value",
            `I can't apply a limit of "${token.text}" here — I work in whole numbers of people and ` +
            "offenses, and rounding it myself would change which cities you get. Give a whole number " +
            "and I can build the ranking.")
        : decline("malformed-number",
            `I couldn't read "${token.text}" as a single number, and guessing at it would change which ` +
            "cities appear. Write it plainly — for example 250000 or 250,000 — and I can build the ranking.");
    }
    if (!ledger.record(outcome)) {
      return decline("overlapping-conditions",
        "Two parts of that request want to read the same words, and I won't guess which one you meant. " +
        "State each limit once and I can build the ranking.");
    }
  }

  /*
   * A STATED CLAUSE THAT FAILED ENDS RECOGNITION HERE, before any default can be reached and before
   * the ordinary residue wording could bury it. This is the fallback boundary in one statement.
   */
  if (ledger.failures.length > 0) {
    return decline(ledger.failures[0].reason, ledger.failures[0].explanation);
  }

  claimWords(ledger, question, ENTITY_NOUN, "entity-noun", (text) => ({ field: "entity", level: /^jurisdiction/i.test(text) ? "jurisdiction" : "city" }));
  claimWords(ledger, question, DIRECTION_ASC, "superlative-asc", () => ({ field: "direction", direction: "asc", strength: "superlative" }), ["direction"]);
  claimWords(ledger, question, DIRECTION_DESC, "superlative-desc", () => ({ field: "direction", direction: "desc", strength: "superlative" }), ["direction"]);
  claimWords(ledger, question, RANK_ASC_WORD, "rank-bottom", () => ({ field: "direction", direction: "asc", strength: "position" }), ["direction"]);
  claimWords(ledger, question, RANK_DESC_WORD, "rank-top", () => ({ field: "direction", direction: "desc", strength: "position" }), ["direction"]);
  claimWords(ledger, question, RANK_VERB, "rank-verb", () => ({ field: "direction", direction: "desc", strength: "position" }), ["direction"]);
  // Claimed before the offense nouns, so "share of murders via firearm" is one measure, not two.
  claimWords(ledger, question, FIREARM_SHARE, "firearm-share", () => ({ field: "crime", token: "firearm_share" }), ["crime", "unit"]);
  for (const [pattern, token] of OFFENSE_TOKENS) {
    claimWords(ledger, question, new RegExp(pattern.source, "gi"), "offense-noun", () => ({ field: "crime", token }), ["crime"]);
  }
  claimWords(ledger, question, RATE_WORD, "unit-rate", () => ({ field: "unit", quantity: "rate_per_100k" }), ["unit"]);
  claimWords(ledger, question, COUNT_WORD, "unit-count", () => ({ field: "unit", quantity: "count" }), ["unit"]);
  claimWords(ledger, question, RECENCY_WORD, "latest-period", () => ({ field: "recency", latest: true }), ["period"]);

  // A stated nationwide scope: its own production, carried to assembly (see NATIONAL_* above).
  for (const pattern of [NATIONAL_MODIFIER_CASED, NATIONAL_MODIFIER_WORDS, NATIONAL_PLACE_CASED, NATIONAL_ADVERB]) {
    claimWords(ledger, question, pattern, "national-scope",
      (text) => ({ field: "geography", name: text.trim(), national: true }), ["geography"]);
  }

  const stateGeos = contract.geographies.filter((geo) => geo.kind === "state");
  for (const geo of stateGeos) {
    for (const name of [geo.canonicalName, geo.name, geo.state]) {
      if (!name) continue;
      claimWords(ledger, question, new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
        "state-name", (text) => ({ field: "geography", name: text }), ["geography"]);
    }
  }

  // A state stated by its postal code must survive to assembly even when the contract did not resolve
  // it: with a national qualifier the contract reports only "national", and the case-insensitive
  // preposition filler would otherwise consume "IN" in "US cities in IN" (Codex NR-1, 2026-10-01).
  // Claimed as a geography, so assembly declines national-plus-state, or state-unresolved without a
  // national word; a code the contract did resolve is already claimed above and is untouched.
  claimWords(ledger, question, STATED_STATE_CODE, "stated-state-code", (text) => ({ field: "geography", name: text }), ["geography"]);

  applyFillerAndConnectors(ledger, question);

  /* ---- nothing may be left over, inside a claim or outside one ---- */

  const residue = ledger.residue();
  if (residue.length > 0) {
    return decline("unaccounted-request",
      `I couldn't place "${residue.map((piece) => piece.text).join(" ")}" in that request, and answering ` +
      "without it would give you a ranking that isn't what you asked for. I can rank cities by a count " +
      "or a rate for one year, in one state or nationwide, limited by population or by a minimum number " +
      "of offenses of the crime being ranked.");
  }
  const interior = ledger.interiorResidue();
  if (interior.length > 0) {
    return decline("unaccounted-condition",
      `In "${interior[0].claim.text.trim()}" I couldn't account for "${interior.map((piece) => piece.text).join(" ")}", ` +
      "and applying the rest as if that word weren't there would answer a different question. I can limit " +
      "a ranking by a plain number of offenses of the crime being ranked, or by population.");
  }

  /*
   * ---- every unit contribution binds to the quantity it qualifies, or the request declines ----
   *
   * AFTER the residue checks on purpose. An unrecognised word is a better thing to quote back than
   * an ownership failure it caused: "Rank cities by the highest flimflam rate" should name
   * `flimflam`, not report that `rate` measures nothing.
   */
  const ungrouped = formMeasureGroups(ledger, question);
  if (ungrouped) {
    return { ...ungrouped, unitOwnership: ledger.ownershipEvidence(), groups: ledger.membershipEvidence() };
  }

  return assemble(question, source, contract, ledger);
}

/**
 * The one final assembly.
 *
 * It reads productions and declared defaults, and nothing else. There is no later assignment, no
 * spread over a resolver's object and no null-coalescing onto a resolver's value: if a field has no
 * production and no declared default, the request declines here.
 */
function assemble(
  question: string,
  source: CityRankingSource,
  contract: NonNullable<ReturnType<typeof buildQueryContract>>,
  ledger: Ledger,
): CityRankingRecognition {
  const origins: FieldOrigin[] = [];
  /*
   * Binding has already run, so every decline from here can say which quantity each stated unit
   * qualified. Shadowing the module-level helper keeps that true of all of them without threading
   * the evidence through each call.
   */
  const decline = (reason: string, explanation: string): CityRankingUnsupported =>
    ({ kind: "unsupported", reason, explanation,
      unitOwnership: ledger.ownershipEvidence(), groups: ledger.membershipEvidence() });

  /**
   * EVERY EXPLICIT CONTRIBUTION MUST HAVE PRODUCED, and this runs before anything else.
   *
   * This is the guarantee the previous version did not have. Absence of a production was read as
   * "the reader said nothing", so deleting one silently handed the field to a resolver default; and
   * because the obligation was pooled per FIELD, a surviving `rate` discharged a deleted `per 1000`.
   * The obligations live outside the claims and are keyed by the words that made them, so losing a
   * claim loses the value and keeps the obligation -- and no default can be reached past one.
   */
  const missing = ledger.undischarged();
  if (missing.length > 0) {
    return decline("production-missing",
      `That request says something about the ${STATED_FIELD_LABEL[missing[0].field]} that I recognised ` +
      "but couldn't turn into anything I can use, and answering as though you hadn't mentioned it would " +
      "give you a different ranking. Try stating it more plainly and I can build it.");
  }

  /* ---- entity ---- */
  if (ledger.producing("entity").length === 0) return null;   // not a ranking of cities after all
  const entityLevels = new Set(ledger.producing("entity").map((entity) => entity.level));
  if (entityLevels.size > 1) {
    return decline("entity-level-conflict",
      "That request asks about both cities and reporting jurisdictions, and those are different " +
      "comparisons — a jurisdiction can be a county or other agency, not only a city. Say which you " +
      "want and I can build the ranking.");
  }
  const entityLevel: EntityLevel = entityLevels.has("jurisdiction") ? "jurisdiction" : "city";
  if (entityLevel === "jurisdiction" && source === "nibrs") {
    // Codex ruling option B: NIBRS's agency table carries a place label, not an agency name, so this
    // family cannot label a ranking of all reporting agencies. A city ranking would answer a
    // narrower question than the one asked, so it is offered, not substituted.
    return decline("jurisdiction-unavailable-nibrs",
      "I can't currently build a reliably labelled ranking of all reporting jurisdictions in NIBRS. " +
      "I can rank city agencies if you ask for that narrower comparison — for example \"which cities " +
      "had the highest murder rates in 2024\".");
  }
  if (entityLevel === "jurisdiction" && source === "shr") {
    // GC-064 builds SHR CITY rankings only; a ranking of all reporting agencies is not substituted.
    return decline("jurisdiction-unavailable-shr",
      "I can rank cities by homicide or murder victims in SHR, but not every reporting jurisdiction. Ask " +
      "which cities had the highest homicide rates and I can build it.");
  }
  origins.push({ field: "entityLevel", from: "production", detail: entityLevel });

  /* ---- direction: superlatives govern; position words decide only without one ---- */
  const directions = ledger.producing("direction");
  const superlatives = new Set(directions.filter((d) => d.strength === "superlative").map((d) => d.direction));
  const positions = new Set(directions.filter((d) => d.strength === "position").map((d) => d.direction));
  if (superlatives.size > 1 || (superlatives.size === 0 && positions.size > 1)) {
    return decline("direction-ambiguous",
      "That request reads as asking for both the highest and the lowest cities, and I won't guess " +
      "which. Say \"highest\" or \"lowest\" and I can build the ranking.");
  }
  const direction: "asc" | "desc" =
    superlatives.size === 1 ? [...superlatives][0] : positions.size === 1 ? [...positions][0] : "desc";
  origins.push({
    field: "sort.direction",
    from: directions.length > 0 ? "production" : "declared-default",
    detail: direction,
  });

  /* ---- size: one production, or the declared default for a genuine omission ---- */
  const sizes = ledger.producing("size");
  if (sizes.length > 1) {
    return decline("multiple-sizes",
      "That request asks for two different numbers of cities. Name one and I can build the ranking.");
  }
  if (sizes.length === 1 && (sizes[0].count < 1 || sizes[0].count > MAX_RESULT_COUNT)) {
    return decline("result-count-unsupported",
      `I can return up to ${MAX_RESULT_COUNT} cities in one ranking, and that asks for ` +
      `${sizes[0].count.toLocaleString("en-US")}. Ask for ${MAX_RESULT_COUNT} or fewer and I can build ` +
      "it — I'd rather say that than quietly hand you a shorter list than you asked for.");
  }
  const resultCount = sizes.length === 1 ? sizes[0].count : DEFAULT_RESULT_COUNT;
  origins.push({ field: "resultCount", from: sizes.length === 1 ? "production" : "declared-default", detail: String(resultCount) });

  /* ---- unit: only the contributions that qualify the RANKING ---- */
  /*
   * Read from the ranking's OWN contributions, not from every unit word and denominator in the
   * request. A contribution that qualifies an eligibility clause never reaches here -- it declined
   * at binding -- and one that qualifies nothing declined there too.
   */
  const rankingUnits = (ledger.rankingGroup()?.members ?? [])
    .filter((claim) => claim.produces.field === "unit" || claim.produces.field === "denominator");
  const unitWords = new Set(
    rankingUnits
      .filter((claim) => claim.produces.field === "unit")
      .map((claim) => (claim.produces as Extract<Production, { field: "unit" }>).quantity),
  );
  const bases = rankingUnits
    .filter((claim) => claim.produces.field === "denominator")
    .map((claim) => (claim.produces as Extract<Production, { field: "denominator" }>).basis);
  if (unitWords.size > 1) {
    return decline("unit-ambiguous",
      "That request asks for a count and a rate at once, and I can only rank by one of them. Say which " +
      "and I can build the ranking.");
  }
  if (bases.some((basis) => basis !== SUPPORTED_RATE_BASIS)) {
    const asked = bases.find((basis) => basis !== SUPPORTED_RATE_BASIS)!;
    return decline("rate-basis-unsupported",
      `I can only work out rates per ${SUPPORTED_RATE_BASIS.toLocaleString("en-US")} residents, and that asks ` +
      `for a rate per ${asked.toLocaleString("en-US")}. Ask for the rate per ` +
      `${SUPPORTED_RATE_BASIS.toLocaleString("en-US")}, or for the number of offenses, and I can build the ranking.`);
  }
  /*
   * A DENOMINATOR SUPPLIES THE UNIT. "per 100000" states a rate as plainly as the word "rate", so a
   * request carrying only a denominator takes its quantity FROM THE REQUEST, not from the resolver.
   */
  const statedUnit: RankingQuantity | null =
    unitWords.size === 1 ? [...unitWords][0] : bases.length > 0 ? "rate_per_100k" : null;
  if (statedUnit === "count" && bases.length > 0) {
    return decline("unit-ambiguous",
      "That request asks for counts and a rate basis at once. Say whether you want the number of " +
      "offenses or the rate per 100,000 and I can build the ranking.");
  }
  /*
   * An OMITTED unit takes the contract's determination, which is the existing policy for a request
   * that names no measure ("which cities had the most murders?"). A STATED unit governs and is
   * cross-checked; a stated-and-failed basis never reaches here, because it declined above.
   */
  const contractUnit = contract.metric.unit;
  const shareRanked = ledger.producing("crime").some((c) => c.token === "firearm_share");
  let unit: RankingQuantity;
  if (shareRanked) {
    if (source !== "shr") {
      return decline("share-source-unsupported",
        "I can rank cities by the share of murders committed with a firearm in the Homicide Reports tab, " +
        "but not in this source. Ask there, or ask for a count or a rate here.");
    }
    if (statedUnit !== null || bases.length > 0) {
      return decline("unit-contradiction",
        "I read that request as asking for a share and another measure at once, and I won't pick one for " +
        "you. Ask for the firearm share, or for a count or rate, and I can build the ranking.");
    }
    unit = "share_pct";
    origins.push({ field: "sort.quantity", from: "production", detail: "firearm-share" });
  } else if (statedUnit === null) {
    if (contractUnit !== "count" && contractUnit !== "rate_per_100k") {
      return decline(`unit-${contractUnit}`,
        "I can rank cities by a count or by a rate per 100,000, but not by that measure. Ask for the " +
        "number of offenses or the rate per 100,000 and I can build the ranking.");
    }
    unit = contractUnit;
    origins.push({ field: "sort.quantity", from: "declared-default", detail: `contract:${unit}` });
  } else {
    if ((contractUnit === "count" || contractUnit === "rate_per_100k") && contractUnit !== statedUnit) {
      return decline("unit-contradiction",
        "I read that request as asking for two different measures, and I won't pick one for you. Say " +
        "whether you want the number of offenses or the rate per 100,000 and I can build the ranking.");
    }
    if (contractUnit !== "count" && contractUnit !== "rate_per_100k" && contractUnit !== "unknown") {
      return decline(`unit-${contractUnit}`,
        "I can rank cities by a count or by a rate per 100,000, but not by that measure. Ask for the " +
        "number of offenses or the rate per 100,000 and I can build the ranking.");
    }
    unit = statedUnit;
    origins.push({ field: "sort.quantity", from: "production", detail: unit });
  }

  /* ---- offense: resolved from the claim that named it, then cross-checked ---- */
  const crimeClaims = ledger.of("crime");
  const crimeTokens = new Set(ledger.producing("crime").map((c) => c.token));
  if (crimeClaims.length === 0) {
    return decline("offense-unresolved",
      "I couldn't identify which offense to rank cities by from that wording. Name the offense — " +
      "for example murder, rape, or shoplifting — and I can build the ranking.");
  }
  if (crimeTokens.size > 1) {
    return decline("offense-ambiguous",
      "That request names more than one crime, and I can rank by one at a time. Name the crime you want " +
      "ranked and I can build it.");
  }
  const rankedCrimeClaim = crimeClaims[0];
  /*
   * A firearm share is a share OF an offense. When its own words name none ("share via firearm"), the
   * one stated count condition does ("min 30 murders"); with no such condition the request is declined
   * rather than defaulted to murders.
   */
  let offenseText = rankedCrimeClaim.text;
  if (shareRanked && !/\b(?:murders?|homicides?)\b/i.test(offenseText)) {
    const countClaims = ledger.of("count");
    if (countClaims.length !== 1) {
      return decline("share-base-unstated",
        "A firearm share needs the offense it is a share of. Ask, for example, for \"the share of murders " +
        "committed with a firearm\" and I can build the ranking.");
    }
    offenseText = countClaims[0].text;
  }
  const offense = resolveOffense(offenseText, source);
  if (!offense) {
    return decline("offense-unresolved",
      `I couldn't work out which offense "${rankedCrimeClaim.text}" means in this source. Name the offense — ` +
      "for example murder, rape, or shoplifting — and I can build the ranking.");
  }
  /*
   * SHR: the whole question's measure must agree with the ranked word. "murders" and "homicides" are
   * different counts here and share one crime token, so the owned conflict reply decides; a request
   * about homicide INCIDENTS asks for a unit this ranking does not count.
   */
  if (source === "shr" && offense.offense.kind === "shr_victims") {
    const measure = shrRequestedMeasure(question);
    if (measure === "conflict") return decline("shr-measure-conflict", SHR_MEASURE_CONFLICT_MESSAGE);
    if (measure === "homicide_incident") {
      return decline("shr-incident-unit",
        "I rank cities by homicide victims recorded in SHR, not by incidents. Ask for homicide victims — " +
        "or just homicide rates — and I can build the ranking.");
    }
    if (measure !== offense.offense.measure) return decline("shr-measure-conflict", SHR_MEASURE_CONFLICT_MESSAGE);
    /*
     * The all-homicide victim licence proves a victim count and refuses any other aggregate over the
     * counted rows, so the firearm numerator of an all-homicide share cannot be proved. Declined here, in
     * words that say so, rather than built and then refused as an unverified count.
     */
    if (shareRanked && offense.offense.measure === "homicide") {
      return decline("share-homicide-unsupported",
        "I can rank cities by the share of MURDER victims killed with a firearm, but I can't yet check that " +
        "share for all homicides (which also include negligent manslaughter). Ask for the firearm share of " +
        "murders and I can build the ranking.");
    }
  }
  /*
   * Cross-check, not substitution. The claim supplies the meaning; the whole-question contract may
   * contradict it, and a contradiction declines. An UNAVAILABLE contract identity is not a
   * contradiction -- that is what keeps the established shoplifting mapping working.
   */
  if (source === "nibrs" && contract.metric.offenseCodes.length > 0) {
    const fromContract: OffenseIdentity = { kind: "nibrs_codes", codes: contract.metric.offenseCodes };
    if (!sameIdentity(offense.offense, fromContract)) {
      return decline("offense-contradiction",
        "I read two different crimes in that request and I won't choose between them. Name the one you " +
        "want ranked and I can build it.");
    }
  }
  origins.push({ field: "offense", from: "production", detail: JSON.stringify(offense.offense) });

  /* ---- geography: a claim, or nationwide for a genuine omission ---- */
  if (stateCount(contract) > 1) {
    const named = contract.geographies.filter((geo) => geo.kind === "state")
      .map((geo) => geo.canonicalName ?? geo.name ?? geo.state ?? "a state");
    return decline("multi-state",
      `I can rank cities nationwide or within one state, and that request names ${named.join(" and ")}. ` +
      "Ask for one of them, or for the ranking nationwide, and I can build it.");
  }
  const geographyClaims = ledger.of("geography");
  const isNational = (claim: Claim) => claim.produces.field === "geography" && "national" in claim.produces;
  const nationalClaims = geographyClaims.filter(isNational);
  const stateClaims = geographyClaims.filter((claim) => !isNational(claim));
  let scope: CityRankingRequest["scope"];
  if (nationalClaims.length > 0) {
    // STATED nationwide: a production, never the omission default. A competing state or any other
    // place in the same request is a different scope, so it declines rather than being broadened.
    if (stateClaims.length > 0) {
      return decline("national-and-state",
        "That request asks for cities nationwide and within a state at once. I can rank cities " +
        "nationwide or within one state; ask for one of them and I can build the ranking.");
    }
    const places = resolveGeoPlaces(question);
    if (places.requiresClarification || places.mentions.length > 0) {
      return decline("national-and-place",
        "That request names the whole country and another place, and I won't choose between them. Ask " +
        "for the ranking nationwide or within one state and I can build it.");
    }
    scope = { kind: "nationwide" };
    origins.push({ field: "scope", from: "production", detail: `nationwide (stated: ${nationalClaims.map((c) => c.text.trim()).join(", ")})` });
  } else if (stateClaims.length > 0) {
    const geo = contract.geographies.find((g) => g.kind === "state");
    const code = geo?.state ?? null;
    if (!code) {
      return decline("state-unresolved",
        "I recognised a state in that request but couldn't resolve it well enough to rank its " +
        "cities. Name the state directly and I can build the ranking.");
    }
    scope = { kind: "state", code, name: geo?.canonicalName ?? geo?.name ?? code };
    origins.push({ field: "scope", from: "resolved-leaf", detail: code });
  } else {
    const places = resolveGeoPlaces(question);
    // An unparsed place is not the same as no place. Only the second is a nationwide ranking.
    if (places.requiresClarification || places.mentions.length > 0) return null;
    scope = { kind: "nationwide" };
    origins.push({ field: "scope", from: "declared-default", detail: "nationwide" });
  }

  /* ---- period: one production, or the declared latest-with-observed-data policy ---- */
  const years = ledger.producing("period").map((p) => p.year);
  if (years.length > 1) {
    const sorted = [...years].sort((a, b) => a - b);
    return decline("multi-year-range",
      `I can only rank cities over a single year, and that request covers ${sorted[0]} to ${sorted[sorted.length - 1]}. ` +
      "Name one year and I can build the ranking.");
  }
  const recency = ledger.producing("recency").length > 0;
  if (recency && years.length > 0) {
    return decline("period-conflict",
      `That asks for the current period and for ${years[0]}, and I can rank one year. Name the year, or ask ` +
      "for the latest, and I can build the ranking.");
  }
  const period: CityRankingRequest["period"] = years.length === 1
    ? { kind: "explicit", year: years[0] }
    : { kind: "latest_with_data" };
  origins.push({ field: "period", from: years.length === 1 || recency ? "production" : "declared-default", detail: recency ? "latest-stated" : period.kind });

  /* ---- eligibility, and the relationship between conditions ---- */
  const populations = ledger.producing("population");
  const counts = ledger.producing("count");
  if (populations.length > 1 || counts.length > 1) {
    return decline("multiple-conditions",
      "That request states more than one limit of the same kind, and I can only apply one. Ask for a " +
      "single minimum — or a single maximum — and I can build the ranking.");
  }
  /*
   * THE BUILDER'S ELIGIBILITY ARRAY MEANS AND. A disjunction is a different question, so it is
   * declined here rather than emitted as a conjunction or carried as a field the builder ignores.
   */
  const relationships = ledger.producing("relationship");
  if (relationships.some((r) => r.relation === "any")) {
    return decline("disjunction-unsupported",
      "That asks for cities meeting EITHER limit, and I can only apply limits together — cities " +
      "meeting both. Ask for them together, or drop one, and I can build the ranking.");
  }
  const eligibility: EligibilityCondition[] = [];
  for (const population of populations) {
    eligibility.push({ kind: "population", comparison: population.comparison, value: population.value });
  }
  const rankedToken = (rankedCrimeClaim.produces as Extract<Production, { field: "crime" }>).token;
  for (const count of counts) {
    // A firearm share's count condition is stated about the offense it is a share of ("min 30 murders").
    const sameBase = rankedToken === "firearm_share" && count.crimeToken === "murder";
    if (count.crimeToken && count.crimeToken !== rankedToken && !sameBase) {
      return decline("cross-offense-eligibility",
        "That asks me to rank cities by one crime while keeping only cities that clear a threshold on " +
        "a different crime, and I can't build that condition. I can apply the threshold to the same " +
        "crime I'm ranking by, or rank with no threshold at all.");
    }
    eligibility.push({
      kind: "count", comparison: count.comparison, value: count.value,
      offense: offense.offense, offenseLabel: offense.label,
    });
  }
  origins.push({ field: "eligibility", from: "production", detail: String(eligibility.length) });

  return {
    kind: "ranking",
    source,
    entityLevel,
    scope,
    offense: offense.offense,
    offenseLabel: offense.label,
    sort: { quantity: unit, direction },
    period,
    resultCount,
    eligibility,
    caveats: offense.caveats,
    accounting: ledger.claims.slice().sort((a, b) => a.span[0] - b.span[0]),
    unitOwnership: ledger.ownershipEvidence(),
    groups: ledger.membershipEvidence(),
    origins,
  };
}

/** Plain-English names for the stated fields, used only in the owned limitation above. */
const STATED_FIELD_LABEL: Record<StatedField, string> = {
  direction: "order to rank in",
  size: "number of cities",
  unit: "measure to rank by",
  crime: "crime",
  geography: "place",
  period: "year",
  population: "population limit",
  count: "minimum number of offenses",
};

/**
 * The contract an owned ranking's statements are VALIDATED against, when that differs from the raw
 * question's (Codex national-ranking ruling, 2026-10-01).
 *
 * The validators infer the requested row level from the contract's geography. For "U.S. cities ..."
 * the contract reads the geography as national, so they judge the ranking's city rows as a national
 * (or state-population) rate and refuse them -- although the recognizer has assembled a nationwide
 * ranking of CITY rows whose statement is identical to the unqualified request's. So, for a STATED
 * nationwide scope only, the statements are validated against the contract of the same request with
 * just the claimed national words removed: exactly the contract the unqualified ranking already
 * validates under. Every check still runs. The stated scope itself stays recorded in the ranking's
 * accounting and origins; it is not turned into an omission there. Any other request returns null and
 * validation is unchanged.
 */
export function rankingValidationContract(question: string, source: CityRankingSource): ReturnType<typeof buildQueryContract> | null {
  const recognized = recognizeCityRanking(question, source);
  if (!recognized || recognized.kind !== "ranking" || recognized.scope.kind !== "nationwide") return null;
  const national = recognized.accounting
    .filter((claim) => claim.produces.field === "geography" && "national" in claim.produces)
    .sort((a, b) => b.span[0] - a.span[0]);
  if (national.length === 0) return null;
  let text = question;
  for (const claim of national) text = text.slice(0, claim.span[0]) + " " + text.slice(claim.span[1]);
  return buildQueryContract(text.replace(/\s+/g, " ").trim(), source);
}

const stateCount = (contract: NonNullable<ReturnType<typeof buildQueryContract>>): number =>
  contract.geographies.filter((geo) => geo.kind === "state").length;

/* ================================================================== *
 * 11. Narrow helpers, kept for callers and tests
 * ================================================================== */

/** The population condition a request states, or null. Reads through the same clause parser. */
export function statedPopulationCondition(
  question: string
): { comparison: PopulationComparison; value: number; span: Span } | null {
  for (const token of scanNumbers(question)) {
    const outcome = classifyNumber(question, token);
    if (outcome && outcome.kind === "claim" && outcome.produces.field === "population") {
      return { comparison: outcome.produces.comparison, value: outcome.produces.value, span: outcome.span };
    }
  }
  return null;
}

/** The count threshold a request states, or null. */
export function statedCountThreshold(
  question: string
): { comparison: CountComparison; value: number; token: string | null; span: Span } | null {
  for (const numeric of scanNumbers(question)) {
    const outcome = classifyNumber(question, numeric);
    if (outcome && outcome.kind === "claim" && outcome.produces.field === "count") {
      return {
        comparison: outcome.produces.comparison, value: outcome.produces.value,
        token: outcome.produces.crimeToken, span: outcome.span,
      };
    }
  }
  return null;
}
