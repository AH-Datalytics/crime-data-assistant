/**
 * GC-098: a disclosed default for bare "Baltimore" in a Historical two-place comparison.
 *
 * "Baltimore" alone names two jurisdictions, Baltimore city and Baltimore County, and the product
 * asks which one. That question stays for every other shape. The one exception (Codex design
 * ruling, 2026-09-26, option A, Historical tab only): when the request positively COMPARES bare
 * Baltimore with one other, unambiguous city -- "Baltimore and Chicago", "Baltimore vs. Chicago" --
 * Baltimore means Baltimore city, the Baltimore Police Department, and the answer says so.
 *
 * That is a declared product default, not a claim that the other city proves what the user meant,
 * which is why the disclosure is mandatory and application-owned.
 *
 * Deliberately narrow, and each limit is one a control holds:
 *  - exactly two places, joined directly by "and" / "vs" / "versus" / "with" / "to" / "&", in a
 *    request that uses a comparison word. Mentioning another city elsewhere is not a comparison.
 *  - the other place must resolve to exactly one city with no clarification of its own. An
 *    unresolved other place ("Baltimore and Portland") gets no default, so the existing clarifier
 *    still asks, and nothing is erased while resolving Baltimore.
 *  - explicit "Baltimore city" or "Baltimore County" is not ambiguous and never reaches here.
 *  - the replacement is the Baltimore rule's own "Use Baltimore city" action, applied to that one
 *    mention's span, and the result must leave no blocking geographic question at all.
 */
import { getBlockingGeoClarification, getGeoResolutionIssues } from "./geo-resolver";
import { resolveGeoPlaces } from "./geo-place-resolver";

export type BaltimoreComparisonDefault = {
  /** The request every downstream consumer uses: the original with Baltimore city-qualified. */
  effectiveQuestion: string;
  /** The application-owned sentence the delivered answer must carry. */
  disclosure: string;
};

export const BALTIMORE_COMPARISON_DISCLOSURE =
  "Baltimore here means Baltimore city, the Baltimore Police Department, not Baltimore County, which is a separate jurisdiction. " +
  "That is this product's default when Baltimore is compared with another city; ask for Baltimore County by name to see it instead.";

const BALTIMORE_CANDIDATES = ["city:MD:baltimore", "county:MD:baltimore"];
const COMPARISON_WORD = /\b(?:compare[ds]?|comparing|comparison|versus|vs\.?|between)(?=\s|$|[,.;:!?])/i;
const DIRECT_JOINER = /^\s*(?:,?\s*and|vs\.?|versus|with|to|&)\s*$/i;

export function historicalBaltimoreComparisonDefault(input: string): BaltimoreComparisonDefault | null {
  const question = input.trim();
  if (!question || !COMPARISON_WORD.test(question)) return null;

  const mentions = resolveGeoPlaces(question).mentions;
  if (mentions.length !== 2) return null;
  const baltimore = mentions.find((mention) =>
    mention.requiresClarification
    && mention.candidates.length === BALTIMORE_CANDIDATES.length
    && BALTIMORE_CANDIDATES.every((id) => mention.candidates.some((candidate) => candidate.id === id)));
  if (!baltimore) return null;
  const other = mentions.find((mention) => mention !== baltimore)!;
  if (other.requiresClarification || other.candidates.length !== 1 || other.candidates[0].kind !== "city") return null;

  const [first, second] = baltimore.start < other.start ? [baltimore, other] : [other, baltimore];
  if (!DIRECT_JOINER.test(question.slice(first.end, second.start))) return null;

  // The Baltimore rule's own replacement, not a new spelling of the city.
  const issues = getGeoResolutionIssues(question);
  if (issues.length !== 1 || issues[0].id !== "baltimore") return null;
  const action = issues[0].actions?.find((candidate) => candidate.label === "Use Baltimore city");
  if (!action?.replacement) return null;

  const effectiveQuestion = question.slice(0, baltimore.start) + action.replacement + question.slice(baltimore.end);
  if (getBlockingGeoClarification(effectiveQuestion)) return null;
  return { effectiveQuestion, disclosure: BALTIMORE_COMPARISON_DISCLOSURE };
}

/**
 * The text with the disclosure taken back out, for a step that rewrites wording. The route's
 * descriptor cleanup would otherwise edit the sentence inside the text ("Police Department" is not
 * in the rows) and the append below would then add a second, intact copy. Removed here, appended
 * once after the rewrite.
 */
export function withoutBaltimoreDisclosure(text: string, applied: BaltimoreComparisonDefault | null): string {
  if (!applied || !text) return text;
  return text.split(applied.disclosure).join("").replace(/\n{3,}/g, "\n\n").trim();
}

/** Append the disclosure once; the check keeps a re-applied or cached answer from repeating it. */
export function withBaltimoreDisclosure(text: string, applied: BaltimoreComparisonDefault | null): string {
  if (!applied) return text;
  if (text.includes(applied.disclosure)) return text;
  return text ? `${text.trimEnd()}\n\n${applied.disclosure}` : applied.disclosure;
}
