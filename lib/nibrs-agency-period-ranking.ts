/**
 * GC-091 batch (Codex next-batch selection, handoff :37339; correction r1 per Codex :37374): the NIBRS "top N police
 * agencies by murders over a period of years" ranking, and the explanation follow-up asked about it.
 *
 * WHY THIS EXISTS. "Murders for top 10 police agencies from 2010 to present" reached model-written SQL, which grouped
 * by agency AND population. Every agency-year with a different population became its own row, so Chicago,
 * Philadelphia and Houston each appeared several times and no agency's total for the period was shown. The reader's
 * next question, "Why are murders the same for all of these cities?", got another ranking instead of an answer.
 *
 * WHAT THIS OWNS, AND NOTHING ELSE. One narrow family, recognized POSITIVELY from the whole turn:
 *   - NIBRS; murder (09A) victims; counts only (a rate over several years is not built -- see below);
 *   - the agencies the request names, kept as asked (r1, F1):
 *       "police agencies" / "police departments" / "law enforcement agencies" -> EVERY agency NIBRS records murder
 *         victims for, of any type (city police, sheriffs' offices, county, state and other agencies);
 *       "municipal" / "city" police agencies or departments -> the agencies NIBRS records as City only.
 *     The broad request is not narrowed to cities: Codex's GC-057 ruling (option B, lib/city-ranking.ts) is that the
 *     narrower city comparison is offered, not substituted;
 *   - a stated period of whole years: "from 2010 to present", "since 2010", "2010-2020", "between 2010 and 2020";
 *   - "top N" with N from 1 to 50.
 * Any other wording is not this family (null) and is left exactly as before. The planner runs this family BEFORE the
 * single-year city ranking (lib/city-ranking.ts), whose gate would also see "city" in "city police agencies"; a turn
 * this family recognizes is therefore claimed here, and every other turn reaches the city ranking unchanged.
 *
 * ONE ROW PER AGENCY. The statement groups by the agency's ORI alone and sums its murder victims over the period (for
 * the municipal cohort, over the agency-years `agencies` records as City; that join is on its declared primary key
 * (ori, year), so it cannot multiply the measure). Ordering is by the total, then ORI, BEFORE the limit. Every agency
 * with records in the period is eligible, including a genuine zero.
 *
 * HONEST LABELS (r1). NIBRS's `agencies` table names a PLACE, not an agency, which is why rankings of every agency type
 * were declined before. Each row therefore carries its source identity (ORI) and two labelled facts, never an invented
 * name: the agency's name from `agency_county_crosswalk` where that table holds exactly ONE name for the ORI, and the
 * NIBRS place, state and agency type from the agency's latest recorded year in the period. `agency_label` uses the
 * crosswalk name when there is one, and otherwise says plainly that it is a place and type ("CHICAGO, IL, City
 * agency"), so a sheriff's office is never presented as the city it sits in. Without a crosswalk name, an ORI whose
 * `agencies` record lacks a place (r2), or that has no `agencies` record at all, is shown by its ORI and says which.
 *
 * NO MULTI-YEAR RATE. A rate needs one denominator, and an agency's population changes from year to year. Using one
 * year's population for a many-year total would manufacture a figure nobody asked for, so this family ranks counts and
 * says so; a request that asks for a rate is not this family.
 */
import type { DeterministicNibrsQuery } from "./nibrs-deterministic-queries";
import type { SourceCutoff } from "./city-ranking-builder";

/** The guardrail every plan of this family carries. The route's owned-failure decisions key on it. */
export const AGENCY_PERIOD_RANKING_GUARDRAIL = "deterministic-nibrs-agency-period-ranking";

export const AGENCY_PERIOD_RANKING_FAILURE_TEXT =
  "I couldn't complete that agency ranking, and I'm not going to answer it with a query I can't stand behind " +
  "instead. That's a failure on our side, not a statement about what the data contains.";

export const NIBRS_FIRST_YEAR = 1991;
const MAX_COUNT = 50;

/** Which agencies the request named: every type ("police agencies"), or only city agencies ("municipal police agencies"). */
export type AgencyCohort = "all" | "city";

export type AgencyPeriodRankingRequest = {
  kind: "request";
  count: number;
  startYear: number;
  /** A stated end year, or the latest year the source holds. */
  end: { kind: "year"; year: number } | { kind: "present" };
  cohort: AgencyCohort;
};
export type AgencyPeriodRankingRecognition =
  | AgencyPeriodRankingRequest
  | { kind: "unsupported"; explanation: string }
  | null;

const MURDERS = String.raw`(?:murders?|murder\s+victims|murder\s+counts?|number\s+of\s+murders)`;
// The cohort is read from the agency words: a "municipal"/"city" modifier names city agencies; without one, all agencies.
const ENTITY = String.raw`((?:municipal|city)\s+)?(?:police\s+(?:agencies|departments|depts)|law\s+enforcement\s+agencies)`;
const TOP = String.raw`(?:the\s+)?top\s+(\d{1,3})`;
const YEAR = String.raw`(\d{4})`;
const PRESENT = String.raw`(?:present|now|today|date|the\s+present)`;
const PERIODS: { re: string; end: "present" | "year" }[] = [
  { re: String.raw`from\s+${YEAR}\s+(?:to|through|thru|until|till|-|–)\s+${PRESENT}`, end: "present" },
  { re: String.raw`since\s+${YEAR}`, end: "present" },
  { re: String.raw`${YEAR}\s+(?:to|through|thru|until|till)\s+${PRESENT}`, end: "present" },
  { re: String.raw`(?:from\s+|in\s+|for\s+)?${YEAR}\s*(?:-|–|to|through|thru)\s*${YEAR}`, end: "year" },
  { re: String.raw`between\s+${YEAR}\s+and\s+${YEAR}`, end: "year" },
];
const LEAD = String.raw`(?:(?:please\s+)?(?:show|list|give|rank)(?:\s+me)?\s+)?`;

/** The turn as one of the whole-turn forms, or null. */
function matchForm(turn: string): { count: number; startYear: number; endYear: number | null; cohort: AgencyCohort } | null {
  for (const p of PERIODS) {
    const forms = [
      // "Murders for top 10 police agencies from 2010 to present"
      new RegExp(String.raw`^${LEAD}(?:the\s+)?${MURDERS}\s+(?:for|of|among|in|by)\s+${TOP}\s+${ENTITY}\s*,?\s+${p.re}$`, "i"),
      // "Top 10 police agencies by murders from 2010 to present"
      new RegExp(String.raw`^${LEAD}${TOP}\s+${ENTITY}\s+(?:by|for|in)\s+(?:the\s+)?(?:most\s+)?${MURDERS}\s*,?\s+${p.re}$`, "i"),
      // "From 2010 to present, murders for the top 10 police agencies"
      new RegExp(String.raw`^${p.re}\s*,?\s+(?:the\s+)?${MURDERS}\s+(?:for|of|among|in|by)\s+${TOP}\s+${ENTITY}$`, "i"),
    ];
    for (const re of forms) {
      const m = re.exec(turn);
      if (!m) continue;
      const groups = m.slice(1);
      const count = Number(groups.find((x) => x !== undefined && /^\d{1,3}$/.test(x)));
      const years = groups.filter((x) => x !== undefined && /^\d{4}$/.test(x)).map(Number);
      const cohort: AgencyCohort = groups.some((x) => x !== undefined && /^(?:municipal|city)\s+$/i.test(x)) ? "city" : "all";
      if (!Number.isInteger(count) || years.length !== (p.end === "present" ? 1 : 2)) return null;
      return { count, startYear: years[0], endYear: p.end === "present" ? null : years[1], cohort };
    }
  }
  return null;
}

const normalize = (question: string) => question.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();

export function recognizeAgencyPeriodRanking(question: string): AgencyPeriodRankingRecognition {
  const turn = normalize(question);
  // A rate is never this family (a multi-year rate has no single denominator); nor is any other wording.
  if (/\brates?\b|\bper\s+(?:capita|\d)/i.test(turn)) return null;
  const form = matchForm(turn);
  if (!form) return null;
  if (form.count < 1 || form.count > MAX_COUNT) {
    return { kind: "unsupported", explanation: `I can rank between 1 and ${MAX_COUNT} agencies here, and that asks for ${form.count}. Ask for a number in that range and I can build the ranking.` };
  }
  if (form.startYear < NIBRS_FIRST_YEAR) {
    return { kind: "unsupported", explanation: `NIBRS figures start in ${NIBRS_FIRST_YEAR}, and that period starts in ${form.startYear}. Ask for a period from ${NIBRS_FIRST_YEAR} on and I can build the ranking.` };
  }
  if (form.endYear !== null && form.endYear < form.startYear) {
    return { kind: "unsupported", explanation: `That period ends (${form.endYear}) before it starts (${form.startYear}). Give the years in order and I can build the ranking.` };
  }
  return { kind: "request", count: form.count, startYear: form.startYear, end: form.endYear === null ? { kind: "present" } : { kind: "year", year: form.endYear }, cohort: form.cohort };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type AgencyPeriodRankingPlan =
  | { kind: "deterministic"; query: DeterministicNibrsQuery }
  | { kind: "unavailable"; title: string; explanation: string }
  | null;

const unavailable = (explanation: string) => ({ kind: "unavailable" as const, title: "Ranking Not Available", explanation });

export type ResolvedAgencyPeriod = { startYear: number; endYear: number; throughMonth: number | null };

/** The resolved period: whole years, with the last year's month cap when the source stops part-way through it. */
function resolvePeriod(request: AgencyPeriodRankingRequest, cutoff: SourceCutoff | null): ResolvedAgencyPeriod | { error: string } {
  if (!cutoff || !cutoff.observed || !Number.isInteger(cutoff.year)) {
    return { error: "I couldn't establish the latest year this source holds, so I can't say which years that period covers. Name the end year — for example \"from 2010 to 2024\" — and I can build the ranking." };
  }
  const endYear = request.end.kind === "year" ? request.end.year : cutoff.year;
  if (endYear > cutoff.year) {
    return { error: `The NIBRS figures here run through ${cutoff.year}, and that period ends in ${endYear}. Ask for a period ending in ${cutoff.year} or earlier and I can build the ranking.` };
  }
  if (request.startYear > cutoff.year) {
    return { error: `The NIBRS figures here run through ${cutoff.year}, and that period starts in ${request.startYear}.` };
  }
  const partial = endYear === cutoff.year && Number.isInteger(cutoff.month) && cutoff.month >= 1 && cutoff.month < 12;
  return { startYear: request.startYear, endYear, throughMonth: partial ? cutoff.month : null };
}

export function periodLabel(p: ResolvedAgencyPeriod): string {
  const end = p.throughMonth === null ? String(p.endYear) : `${MONTHS[p.throughMonth - 1]} ${p.endYear}`;
  return p.startYear === p.endYear && p.throughMonth === null ? String(p.startYear) : `${p.startYear}–${end}`;
}

/** The SQL for a resolved request. One row per agency (ORI), summed over the period, ordered before the limit. */
export function agencyPeriodRankingSql(count: number, p: ResolvedAgencyPeriod, cohort: AgencyCohort): string {
  const monthCap = p.throughMonth === null ? "" : ` AND (s.year < ${p.endYear} OR s.month <= ${p.throughMonth})`;
  const totals = cohort === "city"
    ? "SELECT s.ori AS ori, SUM(s.victim_count) AS murders, MIN(s.year) AS first_year, MAX(s.year) AS last_year, COUNT(DISTINCT s.year) AS years_with_records" +
      " FROM summary_victim_city_monthly s JOIN agencies a ON a.ori = s.ori AND a.year = s.year" +
      ` WHERE s.ucr_offense_code = '09A' AND s.year BETWEEN ${p.startYear} AND ${p.endYear}${monthCap} AND a.agency_type = 'City'` +
      " GROUP BY s.ori"
    : "SELECT s.ori AS ori, SUM(s.victim_count) AS murders, MIN(s.year) AS first_year, MAX(s.year) AS last_year, COUNT(DISTINCT s.year) AS years_with_records" +
      " FROM summary_victim_city_monthly s" +
      ` WHERE s.ucr_offense_code = '09A' AND s.year BETWEEN ${p.startYear} AND ${p.endYear}${monthCap}` +
      " GROUP BY s.ori";
  return (
    `WITH totals AS (${totals}), ` +
    // The agency's place, state and type from its latest recorded year in the period (one row per ORI: a single MAX).
    "places AS (" +
    "SELECT a.ori AS ori, a.city AS city, a.state AS state, a.agency_type AS agency_type, MAX(a.year) AS label_year" +
    ` FROM agencies a JOIN totals t ON t.ori = a.ori WHERE a.year BETWEEN ${p.startYear} AND ${p.endYear}` +
    (cohort === "city" ? " AND a.agency_type = 'City'" : "") +
    " GROUP BY a.ori), " +
    // The agency's name, only where the crosswalk holds exactly one for this ORI.
    "names AS (" +
    "SELECT c.ori9 AS ori, CASE WHEN COUNT(DISTINCT c.agency_name) = 1 THEN MAX(c.agency_name) END AS agency_name" +
    " FROM agency_county_crosswalk c JOIN totals t ON t.ori = c.ori9 GROUP BY c.ori9)" +
    " SELECT n.agency_name AS agency_name, pl.city AS city, pl.state AS state, pl.agency_type AS agency_type, t.ori AS ori," +
    " CASE" +
    " WHEN n.agency_name IS NOT NULL AND pl.state IS NOT NULL THEN n.agency_name || ', ' || pl.state || ' (' || t.ori || ')'" +
    " WHEN n.agency_name IS NOT NULL THEN n.agency_name || ' (' || t.ori || ')'" +
    // r2 (Codex :37402 R3): the place branch needs BOTH place fields, so a NULL never empties the label.
    " WHEN pl.city IS NOT NULL AND pl.city <> '' AND pl.state IS NOT NULL AND pl.state <> '' THEN pl.city || ', ' || pl.state || ', ' || COALESCE(NULLIF(pl.agency_type, ''), 'unrecorded type') || ' agency (' || t.ori || ')'" +
    " WHEN pl.ori IS NOT NULL THEN 'ORI ' || t.ori || ' (no place recorded)'" +
    " ELSE 'ORI ' || t.ori || ' (no NIBRS agency record)'" +
    " END AS agency_label," +
    " t.murders AS murders, t.first_year AS first_year, t.last_year AS last_year, t.years_with_records AS years_with_records" +
    " FROM totals t LEFT JOIN places pl ON pl.ori = t.ori LEFT JOIN names n ON n.ori = t.ori" +
    ` ORDER BY t.murders DESC, t.ori ASC LIMIT ${count}`
  );
}

const SCOPE_SENTENCE: Record<AgencyCohort, string> = {
  all:
    "Police agencies here are every agency NIBRS records murder victims for, of any type — city police, sheriffs' offices, " +
    "county, state and other agencies (agency_type shows which). Each agency is named from the agency-county crosswalk where " +
    "it holds exactly one name for the agency's ORI; otherwise it is shown by its NIBRS place, state and agency type, which " +
    "describe where it is, not what it is called.",
  city:
    "These are the agencies NIBRS records as city (municipal) agencies, as asked. Each agency is named from the agency-county " +
    "crosswalk where it holds exactly one name for the agency's ORI; otherwise it is shown by its NIBRS place and state.",
};
const METHOD_SENTENCE =
  "Each agency appears once, with its murder victims summed over every year of the period for which the source holds " +
  "its records; the ranking is by that total. No rate is shown, because an agency's population changes from year to year " +
  "and one year's population cannot serve as the denominator for a total over many years.";

const titleOf = (count: number, cohort: AgencyCohort, label: string) =>
  `Top ${count} ${cohort === "city" ? "municipal police agencies" : "police agencies"} by murder victims, ${label}`;

export function planNibrsAgencyPeriodRanking(question: string, cutoff: SourceCutoff | null): AgencyPeriodRankingPlan {
  const recognized = recognizeAgencyPeriodRanking(question);
  if (!recognized) return null;
  if (recognized.kind === "unsupported") return unavailable(recognized.explanation);
  const period = resolvePeriod(recognized, cutoff);
  if ("error" in period) return unavailable(period.error);
  const title = titleOf(recognized.count, recognized.cohort, periodLabel(period));
  return {
    kind: "deterministic",
    query: {
      sql: agencyPeriodRankingSql(recognized.count, period, recognized.cohort),
      title,
      explanation: [`${title}.`, METHOD_SENTENCE, SCOPE_SENTENCE[recognized.cohort]].join(" "),
      chartHint: "bar",
      xAxis: "agency_label",
      yAxis: "murders",
      xAxisLabel: "Agency",
      yAxisLabel: "Murder victims",
      guardrail: AGENCY_PERIOD_RANKING_GUARDRAIL,
    },
  };
}

/* ------------------------------------------------------------------------------------------------------------------ *
 * The explanation follow-up
 * ------------------------------------------------------------------------------------------------------------------ */

type HistoryTurn = { role?: unknown; content?: unknown };

const WHY_FORMS: RegExp[] = [
  // "Why are murders the same for all of these cities?"
  /^why\s+(?:are|is|were|was|do|does|did)\s+(?:the\s+|all\s+the\s+)?(?:murders?|murder\s+(?:counts?|totals?|numbers?|figures?)|numbers?|counts?|totals?|values?|figures?|results?)\s+(?:all\s+)?(?:the\s+same|identical|equal|repeated|duplicated)(?:\s+(?:for|across|in|between))?\s+(?:all\s+)?(?:of\s+)?(?:these|those|the)\s+(?:cities|agencies|departments|police\s+agencies|police\s+departments|rows)$/i,
  // "Why do these cities appear more than once?"
  /^why\s+(?:do|does|did|are|is)\s+(?:these|those|the|some)\s+(?:cities|agencies|departments|police\s+agencies|police\s+departments)\s+(?:appear|show\s+up|repeat|listed|appear\s+to\s+repeat)(?:\s+(?:more\s+than\s+once|twice|multiple\s+times|several\s+times))?$/i,
];

export type RankingExplanationFollowup = { priorQuestion: string; refinedQuestion: string };

/**
 * A question about the previous ranking itself ("why are the numbers the same?"), asked right after a request this
 * family recognizes. The previous request is carried forward unchanged so the same owned ranking is run again.
 *
 * r2 (Codex :37402, owner decision): NOTHING is inferred about what the earlier answer showed. History carries that
 * answer's prose, never its rows or SQL, and reading prose for whether a table existed was shown to be wrong (a rates
 * limitation followed by a counts table was taken for "no table"). So every such follow-up gets the same statement --
 * the earlier table is not kept and cannot be confirmed -- and then, separately, the facts of the ranking run now.
 * Anything else -- another prior request, or a turn that adds or changes anything -- is left exactly as written.
 */
export function resolveRankingExplanationFollowup(question: string, history: unknown): RankingExplanationFollowup | null {
  const turn = normalize(question);
  if (!WHY_FORMS.some((re) => re.test(turn))) return null;
  if (!Array.isArray(history)) return null;
  const turns = history as HistoryTurn[];
  // The immediately preceding USER turn.
  let prior: string | null = null;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.role === "user" && typeof turns[i]?.content === "string") { prior = String(turns[i].content); break; }
  }
  if (!prior) return null;
  const recognized = recognizeAgencyPeriodRanking(prior);
  if (!recognized || recognized.kind !== "request") return null;
  return { priorQuestion: prior, refinedQuestion: prior };
}

/** The follow-up's plan: the same statement, described as the previous ranking run again now. Its direct answer leads. */
export function asExplanationFollowup(query: DeterministicNibrsQuery, priorQuestion: string): DeterministicNibrsQuery {
  const lead = `${query.title}. `;
  if (!query.explanation.startsWith(lead)) throw new Error("agency-period ranking: the explanation does not begin with its title");
  return {
    ...query,
    explanation: `This is the ranking for "${normalize(priorQuestion)}" run again now: ${query.title.charAt(0).toLowerCase()}${query.title.slice(1)}. ${query.explanation.slice(lead.length)}`,
  };
}

/** The one statement about the EARLIER display: what it showed is not kept, so nothing about it is claimed. */
export const EARLIER_TABLE_STATEMENT =
  "The earlier table isn't kept in this conversation, so I can't confirm what it showed or why its numbers looked the " +
  "same. One common reason a table repeats an agency is that it has a row for each year or each population figure; that " +
  "can't be confirmed for the earlier table. The figures below come from the ranking run again now, with one row per agency.";

const fmt = (n: number) => n.toLocaleString("en-US");
const listAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** How a row is named in a sentence: its crosswalk name, else its place and type, else its ORI. */
function sentenceLabel(r: Record<string, unknown>): string {
  const name = typeof r.agency_name === "string" && r.agency_name.trim() ? r.agency_name.trim() : null;
  const state = typeof r.state === "string" && r.state.trim() ? r.state.trim() : null;
  const city = typeof r.city === "string" && r.city.trim() ? r.city.trim() : null;
  const type = typeof r.agency_type === "string" && r.agency_type.trim() ? r.agency_type.trim() : "unrecorded type";
  if (name) return state ? `${name}, ${state}` : name;
  if (city && state) return `${city}, ${state} (${type} agency)`;
  return `ORI ${String(r.ori ?? "")}`;
}

/**
 * Statements established by THIS statement's rows, placed outside the disclosure chokepoint (which cannot see what
 * supports them). `tail` (both turns): how many agencies came back, which agency types, and their year coverage.
 * `lead` (the explanation follow-up only): the one statement about the earlier display (EARLIER_TABLE_STATEMENT), then --
 * separately -- the facts of the ranking run now: whether the totals differ, which are equal (different agencies, not
 * repeated rows), and one row per agency. Placed FIRST so the question asked is answered before the ranking is described.
 */
export function agencyPeriodRankingNote(
  query: Pick<DeterministicNibrsQuery, "guardrail" | "sql">,
  rows: Record<string, unknown>[],
  opts: { requestedCount: number; startYear: number; endYear: number; cohort: AgencyCohort; explanation: boolean },
): { lead: string | null; tail: string | null } | null {
  if (query.guardrail !== AGENCY_PERIOD_RANKING_GUARDRAIL) return null;
  const labels = rows.map(sentenceLabel);
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const agencies = rows.map((r, i) => ({
    label: (counts.get(labels[i]) ?? 0) > 1 ? `${labels[i]} [${String(r.ori ?? "")}]` : labels[i],
    ori: String(r.ori ?? ""), murders: Number(r.murders), years: Number(r.years_with_records),
    type: typeof r.agency_type === "string" && r.agency_type.trim() ? r.agency_type.trim() : null,
  }));
  if (new Set(agencies.map((a) => a.ori)).size !== agencies.length) throw new Error("agency-period ranking: an agency appears more than once");
  const who = opts.cohort === "city" ? "No city police agency" : "No agency";
  if (agencies.length === 0) {
    const tail = `${who} has murder victim records in the NIBRS source for ${opts.startYear}–${opts.endYear}.`;
    return { lead: opts.explanation ? `${EARLIER_TABLE_STATEMENT} The ranking run now has no rows.` : null, tail };
  }

  const tail: string[] = [];
  if (agencies.length < opts.requestedCount) {
    tail.push(`Only ${agencies.length} ${agencies.length === 1 ? "agency has" : "agencies have"} murder victim records in this period, so ${agencies.length === 1 ? "it is" : "all are"} shown.`);
  }
  if (opts.cohort === "all") {
    const byType = new Map<string, number>();
    for (const a of agencies) byType.set(a.type ?? "no recorded type", (byType.get(a.type ?? "no recorded type") ?? 0) + 1);
    tail.push(`By NIBRS agency type, the agencies shown are ${listAnd([...byType.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([t, n]) => `${n} ${t}`))}.`);
  }
  const span = opts.endYear - opts.startYear + 1;
  const full = agencies.filter((a) => a.years === span).length;
  const partial = agencies.filter((a) => a.years < span).length;
  if (partial === 0) {
    tail.push(`Every agency shown has murder victim records in each year ${opts.startYear}–${opts.endYear}.`);
  } else {
    tail.push(
      `${full} of the ${agencies.length} agencies shown ${full === 1 ? "has" : "have"} murder victim records in every year ${opts.startYear}–${opts.endYear}; ` +
      `the other ${partial} ${partial === 1 ? "covers" : "cover"} fewer years (years_with_records), so ${partial === 1 ? "its total covers" : "their totals cover"} only those years. ` +
      "A year without records means the source holds no murder victim records for that agency that year; it does not say why.",
    );
  }

  if (!opts.explanation) return { lead: null, tail: tail.join(" ") };
  const now: string[] = [];
  const byValue = new Map<number, typeof agencies>();
  for (const a of agencies) byValue.set(a.murders, [...(byValue.get(a.murders) ?? []), a]);
  if (byValue.size === 1 && agencies.length > 1) {
    now.push(`In the ranking run now, all ${agencies.length} agencies have the same total, ${fmt(agencies[0].murders)}; they are ${agencies.length} different agencies (different ORIs), not one agency repeated.`);
  } else if (agencies.length > 1) {
    const top = agencies[0];
    const bottom = agencies[agencies.length - 1];
    now.push(`In the ranking run now, the totals are not all the same: they range from ${fmt(top.murders)} (${top.label}) to ${fmt(bottom.murders)} (${bottom.label}).`);
    for (const [value, group] of byValue.entries()) {
      if (group.length > 1) now.push(`${listAnd(group.map((a) => a.label))} each have ${fmt(value)}: these are different agencies whose totals are equal, not repeated rows.`);
    }
  } else {
    now.push(`In the ranking run now, one agency is shown: ${agencies[0].label}, ${fmt(agencies[0].murders)}.`);
  }
  now.push("Each row is a different agency (one row per ORI).");
  return { lead: [EARLIER_TABLE_STATEMENT, ...now].join(" "), tail: tail.join(" ") };
}

/** The resolved request a plan of this family was built from, for the row-derived note. */
export function agencyPeriodRankingFacts(question: string, cutoff: SourceCutoff | null): { requestedCount: number; startYear: number; endYear: number; cohort: AgencyCohort } | null {
  const recognized = recognizeAgencyPeriodRanking(question);
  if (!recognized || recognized.kind !== "request") return null;
  const period = resolvePeriod(recognized, cutoff);
  if ("error" in period) return null;
  return { requestedCount: recognized.count, startYear: period.startYear, endYear: period.endYear, cohort: recognized.cohort };
}
