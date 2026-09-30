/**
 * GC-065: "Which violent crime saw the greatest decrease in Chicago in 2025?" -- an owned comparison of
 * violent-crime categories for one named place between two years (Codex closeout direction, S3).
 *
 * THE MEASURE IS THE SETTLED CONVENTION, not a new choice: the declared violent universe
 * (NIBRS_UCR_VIOLENT_CODES), counted as the product counts each category -- VICTIMS for the crimes
 * against persons (summary_victim_city_monthly), OFFENSES for robbery (summary_city_monthly). The old
 * victim-table-only comparison and its 13A winner were withdrawn; the mixed units are stated.
 *
 * THE EXCLUSION UNIVERSE IS DEFINED, THEN COMPARED (frozen decision 7): the agencies the named place
 * resolves to in the two years (the route's place resolution, unchanged). An agency is kept only when
 * the month evidence S2 names for these tables (nibrs_agency_completeness: months with at least one
 * recorded offense) shows 12 of 12 in BOTH years; the others are excluded and counted, with an observed
 * short count and a missing evidence row stated differently (CL4).
 *
 * AN ABSENT CATEGORY IS UNKNOWN (S2): a category with no rows is neither zero nor compared, and the
 * winner is named only among the categories with records in both years -- which the answer says, rather
 * than certifying a winner over categories whose evidence is missing. Why rows are missing is not
 * asserted: nothing retained links the served summary to a producer.
 *
 * Owned-family contract, as `runOwnedAnnualClearance`: a refused statement executes nothing further and
 * never falls through to model SQL; the executor is injected so a test runs this exact flow.
 */
import type { NibrsPlaceResolutionPlan } from "./nibrs-place-resolver";
import { NIBRS_UCR_VIOLENT_CODES, UCR_CODES } from "./nibrs-codes";
import { coverageOf, monthEvidence } from "./source-coverage";
import { buildQueryContract } from "./query-contract";
import { mentionsSubYearPeriod } from "./city-ranking";
import { mentionsDemographicGroup } from "./capability-overrides";
import { resolveGeoPlaces } from "./geo-place-resolver";

export const NIBRS_CATEGORY_CHANGE_GUARDRAIL = "owned-nibrs-category-change";

const PERSON_CODES = NIBRS_UCR_VIOLENT_CODES.filter((code) => code !== "120");
const PROPERTY_CODES = ["120"] as const;   // robbery: counted as offenses by the product convention
const VIOLENT_UNIVERSE = /\bviolent\s+(?:crimes?|offen[cs]es?)\b/i;
const CHANGE = /\b(?:greatest|largest|biggest|sharpest)\s+(decreases?|drops?|declines?|reductions?|increases?|rises?)\b|\b(decreased|dropped|declined|fell|increased|rose)\s+(?:the\s+)?most\b/i;

export type CategoryChangePlan = {
  kind: "plan";
  place: string;
  direction: "decrease" | "increase";
  prior: number;
  year: number;
  /** The exclusion universe: every ORI the place resolves to in either compared year. */
  universe: string[];
  statements: { completeness: string; persons: string; robbery: string };
};

export type CategoryChangeUnsupported = { kind: "unsupported"; explanation: string };
export type CategoryChangeRequest = { kind: "request"; direction: "decrease" | "increase"; prior: number; year: number };

const q = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Step 1, question only: is this the family, and which two years does it compare? The route then
 * resolves the named place over BOTH years (the contract's own window is only the year asked about),
 * so the exclusion universe includes an agency that reported under a different ORI the year before.
 *
 * THE WHOLE REQUESTED PERIOD AND UNIT ARE CARRIED OR DECLINED, never stripped (Codex combined review,
 * CL1). The years come from the effective request's contract (`buildQueryContract`), not from year
 * substrings. This family compares complete calendar years as counts, so anything else the request
 * states -- part of a year (the city-ranking family's own `mentionsSubYearPeriod`), a year still in
 * progress (the contract's `partialYear`), an open-ended span, a percentage or rate (the contract's
 * unit), or a demographic scope (`mentionsDemographicGroup`) -- is an owned decline that names what
 * could not be answered. Answering the annual count instead would answer a different question.
 */
const NAME_THE_YEAR =
  "I compare violent crime categories between two complete years for one place. Name the year — for " +
  "example \"in 2025\", compared with 2024 — or two years, and I can build it.";

export function recognizeCategoryChange(question: string): CategoryChangeRequest | CategoryChangeUnsupported | null {
  const change = CHANGE.exec(question);
  if (!change || !VIOLENT_UNIVERSE.test(question) || !/\b(?:which|what)\b/i.test(question)) return null;
  const word = (change[1] ?? change[2]).toLowerCase();
  const direction: "decrease" | "increase" = /^(?:increase|rise|rose)/.test(word) ? "increase" : "decrease";
  const contract = buildQueryContract(question, "nibrs");
  if (!contract) return { kind: "unsupported", explanation: NAME_THE_YEAR };

  if (mentionsSubYearPeriod(question)) {
    return { kind: "unsupported", explanation:
      "That asks about part of a year. I can compare violent crime categories only between complete " +
      "calendar years, so I won't answer it with full-year totals. Ask for whole years — for example " +
      "\"in 2025\", compared with 2024." };
  }
  if (contract.time.partialYear) {
    return { kind: "unsupported", explanation:
      `That includes a year still in progress (${new Date().getFullYear()}), and I compare complete calendar ` +
      "years only. Ask about the last complete year — for example \"in 2025\", compared with 2024." };
  }
  if (contract.metric.unit !== "count" && contract.metric.unit !== "unknown") {
    const asked = contract.metric.unit === "rate_per_100k" ? "a rate" : "a percentage or share";
    return { kind: "unsupported", explanation:
      `That asks for ${asked}. I compare violent crime categories by their counts only, so I won't answer ` +
      "it as a count change. Ask which category decreased or increased the most and I can build it." };
  }
  if (contract.breakdowns.length > 0 || mentionsDemographicGroup(question)) {
    return { kind: "unsupported", explanation:
      "That limits or breaks down the comparison by a group or dimension. I compare each violent crime " +
      "category as a whole for one place, so I won't answer it with the totals. Ask without the group and I " +
      "can build it." };
  }
  const mentioned = new Set([...question.matchAll(/\b(19[6-9]\d|20\d\d)\b/g)].map((m) => Number(m[1])));
  const { startYear, endYear } = contract.time;
  if (startYear === null || endYear === null || mentioned.size === 0 || mentioned.size > 2) {
    return { kind: "unsupported", explanation: NAME_THE_YEAR };
  }
  const year = endYear;
  const prior = startYear === endYear ? endYear - 1 : startYear;
  if (prior === year) return { kind: "unsupported", explanation: "Those are the same year; name two different years, or one year to compare with the year before." };
  // CR-1: the WHOLE request must belong to this operation, place, period and unit. Any meaningful word
  // left over (a weapon, a location type, a time of day...) is a restriction this family does not apply,
  // so it is named and not answered with unrestricted totals. Checked last, so the period declines above
  // keep their more specific wording.
  const unowned = unownedPart(question);
  if (unowned.words.length > 0) {
    return { kind: "unsupported", explanation:
      `That asks about "${unowned.phrase}", which this comparison can't apply: it compares each violent ` +
      "crime category as a whole for one place and two complete years. I won't answer it with the totals for " +
      "every case. Ask without that condition and I can build it." };
  }
  return { kind: "request", direction, prior, year };
}

/**
 * POSITIVE WHOLE-FORM ADMISSION (Codex correction ruling, CR-1). Rather than listing constraints to
 * reject, every part of the request must be CLAIMED by something this family implements: the question
 * word, the violent-crime subject, the change phrase, the place (the geography resolver's own span), the
 * years, and connective words that carry no meaning of their own. Whatever is left is unowned, and an
 * unowned word means the request asks for something the comparison does not do.
 */
const CLAIMED: RegExp[] = [
  /^\s*(?:which|what)\b/i,
  /\bviolent\s+(?:crimes?|offen[cs]es?)(?:\s+(?:categor(?:y|ies)|types?|kinds?))?\b/i,
  /\b(?:saw|had|showed|has|have|did|experienced|recorded)?\s*(?:the\s+)?(?:greatest|largest|biggest|sharpest)\s+(?:decreases?|drops?|declines?|reductions?|increases?|rises?)\b/i,
  /\b(?:decreased|dropped|declined|fell|increased|rose)\s+(?:the\s+)?most\b/i,
  /\b(?:between|from)\s+(?:19|20)\d\d\s+(?:and|to|through)\s+(?:19|20)\d\d\b/i,
  /\b(?:compared\s+(?:with|to)|versus|vs\.?)\s+(?:19|20)\d\d\b/i,
  /\b(?:in|during|for)\s+(?:19|20)\d\d\b/i,
  /\b(?:19|20)\d\d\b/i,
];
const CONNECTIVE = new Set(["the", "a", "an", "in", "of", "for", "at", "during", "from", "to", "and", "year", "years", "saw", "had", "was", "were", "is", "did", "has", "have", "most"]);

/** The unowned words, and the phrase of the original request they span (quoted in the decline). */
export function unownedPart(question: string): { words: string[]; phrase: string } {
  const original = question.trim();
  let text = original;
  // The place span as the resolver found it: that span is owned by the place.
  const mentions = [...resolveGeoPlaces(text).mentions].sort((a, b) => b.start - a.start);
  for (const m of mentions) text = text.slice(0, m.start) + " ".repeat(m.end - m.start) + text.slice(m.end);
  // Every claim is replaced by blanks of the same length, so positions still index the original.
  for (const pattern of CLAIMED) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    text = text.replace(global, (s) => " ".repeat(s.length));
  }
  const tokens = [...text.matchAll(/[A-Za-z0-9'-]+/g)].filter((m) => !CONNECTIVE.has(m[0].toLowerCase()));
  if (tokens.length === 0) return { words: [], phrase: "" };
  let first = tokens[0].index ?? 0;
  // Quote a preposition that introduces the phrase ("at night", "in schools") with it.
  const lead = /\b(?:at|in|on|during|for|of)\s+$/i.exec(original.slice(0, first));
  if (lead) first = lead.index;
  const last = tokens[tokens.length - 1];
  return { words: tokens.map((m) => m[0].toLowerCase()), phrase: original.slice(first, (last.index ?? 0) + last[0].length) };
}
export const unownedWords = (question: string): string[] => unownedPart(question).words;

/** Step 2: the plan, from a resolution made over prior..year. */
export function planCategoryChange(request: CategoryChangeRequest, resolution: NibrsPlaceResolutionPlan | null): CategoryChangePlan | CategoryChangeUnsupported {
  const { direction, prior, year } = request;
  if (resolution && (resolution.startYear > prior || resolution.endYear < year)) {
    throw new Error("category-change: the place was resolved over a window that does not cover both compared years");
  }
  const places = resolution?.places ?? [];
  if (places.length !== 1 || places[0].status !== "resolved") {
    return { kind: "unsupported", explanation:
      "I compare violent crime categories for one named place. Name a single city or agency and I can build it." };
  }
  const place = places[0];
  const universe = [...new Set(place.oriYears.filter((oy) => oy.year === prior || oy.year === year).map((oy) => oy.ori))].sort();
  if (universe.length === 0) {
    return { kind: "unsupported", explanation:
      `I couldn't find an agency for ${place.label} in ${prior} or ${year} in NIBRS, so there is nothing to compare.` };
  }
  const oris = universe.map(q).join(", ");
  const years2 = `${prior}, ${year}`;
  const evidence = coverageOf("nibrs.summary_victim_city_monthly").reportingEvidence;
  if (evidence !== "nibrs_agency_completeness" || coverageOf("nibrs.summary_city_monthly").reportingEvidence !== evidence) {
    throw new Error("category-change: the declared reporting evidence changed; this plan reads nibrs_agency_completeness");
  }
  return {
    kind: "plan", place: place.label, direction, prior, year, universe,
    statements: {
      completeness: `SELECT c.ori AS ori, c.year AS year, c.months_reported AS months_reported FROM ${evidence} c ` +
        `WHERE c.ori IN (${oris}) AND c.year IN (${years2}) LIMIT 1000`,
      persons: "SELECT s.ucr_offense_code AS code, s.year AS year, SUM(s.victim_count) AS victims FROM summary_victim_city_monthly s " +
        `WHERE s.ori IN (${oris}) AND s.year IN (${years2}) AND s.ucr_offense_code IN (${PERSON_CODES.map(q).join(", ")}) ` +
        "GROUP BY s.ucr_offense_code, s.year ORDER BY s.ucr_offense_code, s.year LIMIT 1000",
      robbery: "SELECT s.ucr_offense_code AS code, s.year AS year, SUM(s.offense_count) AS offenses FROM summary_city_monthly s " +
        `WHERE s.ori IN (${oris}) AND s.year IN (${years2}) AND s.ucr_offense_code IN (${PROPERTY_CODES.map(q).join(", ")}) ` +
        "GROUP BY s.ucr_offense_code, s.year ORDER BY s.ucr_offense_code, s.year LIMIT 1000",
    },
  };
}

/** The complete-reporter subset, then the same statements restricted to it. */
function restrictTo(statement: string, universe: string[], kept: string[]): string {
  const from = `IN (${universe.map(q).join(", ")})`;
  return statement.replace(`s.ori ${from}`, `s.ori IN (${kept.map(q).join(", ")})`);
}

export type CategoryChangeOutcome =
  | { kind: "decline"; reason: "plan-refused" | "execution-failed" | "no-complete-reporter"; sql: string | null; explanation: string }
  | { kind: "answer"; sql: string; rows: Record<string, unknown>[]; columns: string[]; title: string; explanation: string;
      excluded: string[]; kept: string[]; absent: string[] };

const fmt = (n: number) => n.toLocaleString("en-US");
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : "0");
const LABEL = (code: string) => `${(UCR_CODES[code] ?? code)} (${code})`;

export async function runOwnedCategoryChange(opts: {
  plan: CategoryChangePlan;
  /** The route's structural verdict on a statement, or null when it accepts it. */
  refusal: (statement: string) => { ruleIds: string[] } | null;
  execute: (statement: string) => Promise<Record<string, unknown>[]>;
}): Promise<CategoryChangeOutcome> {
  const { plan, refusal, execute } = opts;
  const guarded = async (statement: string): Promise<Record<string, unknown>[] | CategoryChangeOutcome> => {
    const refused = refusal(statement);
    if (refused) return { kind: "decline", reason: "plan-refused", sql: null,
      explanation: "I couldn't complete that comparison with a query I can stand behind, so I stopped rather than guess. " +
        "That's a failure on our side, not a statement about the data." };
    try { return await execute(statement); }
    catch { return { kind: "decline", reason: "execution-failed", sql: statement,
      explanation: "I couldn't complete that comparison because the data query failed. That's a failure on our side, not a statement about the data." }; }
  };

  // 1. The exclusion comparison over the defined universe.
  const reporting = await guarded(plan.statements.completeness);
  if (!Array.isArray(reporting)) return reporting;
  /*
   * CL4: three evidence states per agency-year, never collapsed. Only "twelve" in BOTH years is kept.
   * An agency with FEWER months is excluded and its observed count stated. An agency with NO evidence
   * row is excluded because 12 months cannot be confirmed -- which says nothing about whether it
   * reported, and the wording says so. What the evidence counts is taken from S2, not asserted here.
   */
  const measures = coverageOf("nibrs.summary_victim_city_monthly").evidenceMeasures ?? "months with records";
  const evidenceOf = (ori: string) => ({ prior: monthEvidence(reporting, ori, plan.prior), year: monthEvidence(reporting, ori, plan.year) });
  const kept = plan.universe.filter((ori) => { const e = evidenceOf(ori); return e.prior.state === "twelve" && e.year.state === "twelve"; });
  const excluded = plan.universe.filter((ori) => !kept.includes(ori));
  const reason = (ori: string) => {
    const e = evidenceOf(ori);
    const parts: string[] = [];
    for (const [y, ev] of [[plan.prior, e.prior], [plan.year, e.year]] as const) {
      if (ev.state === "fewer") parts.push(`${ev.months} of 12 ${measures} in ${y}`);
      if (ev.state === "not-established") parts.push(`no recorded month count for ${y}, so 12 months cannot be confirmed (this is not evidence that it failed to report)`);
    }
    return `${ori}: ${parts.join("; ")}`;
  };
  const exclusionSentence =
    `Excluded from the comparison: ${excluded.length} of ${plan.universe.length} ${plan.universe.length === 1 ? "agency" : "agencies"} ` +
    `for ${plan.place}` + (excluded.length ? ` (${excluded.map(reason).join("; ")})` : "") +
    (kept.length ? `. Compared: ${kept.join(", ")}, with 12 of 12 ${measures} in both years.` : ".");
  if (kept.length === 0) {
    const anyUnknown = excluded.some((ori) => { const e = evidenceOf(ori); return e.prior.state === "not-established" || e.year.state === "not-established"; });
    return { kind: "decline", reason: "no-complete-reporter", sql: plan.statements.completeness,
      explanation: `I can't compare ${plan.prior} with ${plan.year} for ${plan.place}: for no agency could 12 ${measures} be ` +
        `confirmed in both years${anyUnknown ? " (for some, the month evidence is missing rather than short)" : ""}. ${exclusionSentence}` };
  }

  // 2. The measures, over the kept agencies only.
  const personsSql = restrictTo(plan.statements.persons, plan.universe, kept);
  const robberySql = restrictTo(plan.statements.robbery, plan.universe, kept);
  const persons = await guarded(personsSql);
  if (!Array.isArray(persons)) return persons;
  const robbery = await guarded(robberySql);
  if (!Array.isArray(robbery)) return robbery;

  const value = (rows: Record<string, unknown>[], code: string, y: number, column: string) => {
    const r = rows.find((x) => x.code === code && Number(x.year) === y);
    return r && r[column] != null ? Number(r[column]) : null;
  };
  const rows = NIBRS_UCR_VIOLENT_CODES.map((code) => {
    const isPerson = code !== "120";
    const src = isPerson ? persons : robbery;
    const column = isPerson ? "victims" : "offenses";
    const before = value(src, code, plan.prior, column);
    const after = value(src, code, plan.year, column);
    return {
      code, offense: UCR_CODES[code] ?? code, unit: column,
      [`count_${plan.prior}`]: before, [`count_${plan.year}`]: after,
      change: before !== null && after !== null ? after - before : null,
      status: before !== null && after !== null ? "compared" : before === null && after === null ? "no records (unknown)" : "recorded in one year only",
    } as Record<string, unknown>;
  });
  const compared = rows.filter((r) => r.status === "compared");
  const absent = rows.filter((r) => r.status !== "compared").map((r) => String(r.code));

  const pick = compared.slice().sort((a, b) => plan.direction === "decrease"
    ? Number(a.change) - Number(b.change) : Number(b.change) - Number(a.change))[0];
  const moved = pick && (plan.direction === "decrease" ? Number(pick.change) < 0 : Number(pick.change) > 0);
  const lead = !pick
    ? `none of the violent crime categories has records in both ${plan.prior} and ${plan.year}, so no category can be compared.`
    : moved
      ? `among the violent crime categories with records in both years, ${(UCR_CODES[String(pick.code)] ?? String(pick.code)).toLowerCase()} (${String(pick.code)}) ${plan.direction === "decrease" ? "decreased" : "increased"} the most, ` +
        `from ${fmt(Number(pick[`count_${plan.prior}`]))} to ${fmt(Number(pick[`count_${plan.year}`]))} ${pick.unit} (${signed(Number(pick.change))}).`
      : `none of the violent crime categories with records in both years ${plan.direction === "decrease" ? "decreased" : "increased"}.`;
  const others = compared.filter((r) => r !== pick || !moved).map((r) =>
    `${LABEL(String(r.code))}: ${fmt(Number(r[`count_${plan.prior}`]))} → ${fmt(Number(r[`count_${plan.year}`]))} ${r.unit} (${signed(Number(r.change))})`);
  const list = (codes: string[]) => codes.map(LABEL).join(" and ");
  const neither = rows.filter((r) => r.status === "no records (unknown)").map((r) => String(r.code));
  const oneYear = rows.filter((r) => r.status === "recorded in one year only").map((r) => String(r.code));
  const absentSentence = absent.length === 0 ? "" : [
    neither.length ? `${list(neither)} ${neither.length === 1 ? "has" : "have"} no records in either year for the agencies compared.` : "",
    oneYear.length ? `${list(oneYear)} ${oneYear.length === 1 ? "has" : "have"} records in only one of the two years.` : "",
    `For ${absent.length === 1 ? "that category" : "those categories"}, ${coverageOf("nibrs.summary_victim_city_monthly").absentMeaning}. ` +
      `${absent.length === 1 ? "That category is" : "Those categories are"} not compared, and the result above does not rule out a larger change there.`,
  ].filter(Boolean).join(" ");
  const explanation = [
    `${plan.place}, ${plan.prior} to ${plan.year}: ${lead}`,
    others.length ? `${others.join("; ")}.` : "",
    absentSentence,
    "Units differ by category, as this product counts them: victims for the crimes against persons, offenses for robbery.",
    exclusionSentence,
  ].filter(Boolean).join(" ");
  const columns = ["code", "offense", "unit", `count_${plan.prior}`, `count_${plan.year}`, "change", "status"];
  return {
    kind: "answer", sql: `${personsSql};\n${robberySql}`, rows, columns,
    title: `${plan.place}: Violent Crime by Category, ${plan.prior} to ${plan.year}`,
    explanation, excluded, kept, absent,
  };
}
