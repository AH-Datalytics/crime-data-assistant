/**
 * GC-080 owned count: the application, not the model, builds every county-bound or all-homicide
 * victim count on the Homicide Reports tab (Codex reassessment ruling, 2026-09-27).
 *
 * One typed plan -- geography, period, series, measure, unit -- compiles the SQL, the result
 * columns, the title and every scope/measure/coverage sentence together. The model never authors,
 * amends or retries SQL for this family, so there is no model arithmetic, extra filter or exclusion
 * to prove after the fact.
 *
 * Execution authority is the compiler's own output. `compileShrCountPlan` returns a frozen object it
 * registers as issued; `executeCompiledShrCount` runs only an issued object whose SQL is still exactly
 * what the same plan compiles to. A copy with changed SQL, or a changed plan, is refused -- the
 * original loophole cannot move downstream.
 *
 * Coverage (the ruling's zero rule): a period with no SHR victim records is UNKNOWN, never zero.
 * Record presence in another month, year or agency does not establish completeness, and a Return A
 * murder zero is not evidence about all homicides. The accepted city-murder builder
 * (`shr-deterministic-murder.ts`) keeps its own Return A policy and is not routed here.
 */
import type Database from "better-sqlite3";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { resolveShrAgency } from "./shr-place-resolver";
import { buildQueryContract } from "./query-contract";
import { explicitStateIntent, asksForSubstateEntities } from "./explicit-state-intent";
import { shrRequestedMeasure } from "./shr-murder-licence";
import {
  shrCountyRequest, resolveShrCountyScope, withShrScopeAndMeasureDisclosures,
  type ShrScopeBinding, type ShrCountyScopeResolution,
} from "./shr-county-scope";

type OriRange = { ori: string; startYear: number; endYear: number };

export type ShrCountGeography =
  | { kind: "cities"; places: { display: string; ranges: OriRange[] }[] }
  | { kind: "county"; binding: ShrScopeBinding }
  | { kind: "state"; state: string; stateName: string }
  | { kind: "national" };

export type ShrCountPeriod =
  | { kind: "year"; year: number; throughMonth: number }
  | { kind: "range"; startYear: number; endYear: number };

export type ShrCountPlan = {
  geography: ShrCountGeography;
  period: ShrCountPeriod;
  series: "total" | "monthly" | "annual";
  measure: "murder" | "homicide";
  unit: "victims";
};

export type ShrOwnedCountDecision =
  | { kind: "plan"; plan: ShrCountPlan }
  | { kind: "county-exit"; resolution: Exclude<ShrCountyScopeResolution, { status: "resolved" }> }
  | { kind: "limitation"; status: "clarify" | "unavailable"; reason: string; explanation: string };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_WORD = new RegExp(`\\b(?:${MONTHS.join("|")}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\b`, "i");
const THROUGH_MONTH = new RegExp(`\\b(?:through|thru|to|as\\s+of)\\s+(${MONTHS.join("|")})\\b`, "i");
const RANGE = /\b(?:between|from)\s+((?:19|20)\d{2})\s+(?:and|to|through|thru|-)\s+((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\s*(?:-|to|through|thru)\s*((?:19|20)\d{2})\b/i;
const RELATIVE = /\b(?:last|past|previous|prior|recent(?:ly)?|this|current|rolling|trailing|ytd|year[-\s]?to[-\s]?date|so\s+far|to\s+date|since|starting|beginning|present|now|today|yesterday|ago|decade)\b/i;
const MONTHLY = /\b(?:monthly|per\s+month|by\s+month|each\s+month|every\s+month|month[-\s]by[-\s]month)\b/i;
const ANNUAL = /\b(?:by\s+year|per\s+year|each\s+year|every\s+year|annual(?:ly)?|yearly|year[-\s]by[-\s]year|trends?|over\s+time)\b/i;
const RATE = /\b(?:rates?|per\s+capita|per\s+100(?:,?000|k)|per\s+\d[\d,]*\s+(?:people|residents|population))\b/i;
const CHANGE = /\b(?:year[-\s]?over[-\s]?year|yoy|change[sd]?|changing|increase[sd]?|increasing|decrease[sd]?|decreasing|rise[ns]?|rising|rose|fall(?:s|en|ing)?|fell|drop(?:s|ped|ping)?|declin(?:e|ed|ing|es)|grew|grow(?:s|ing|th)|higher|lower|more\s+than|less\s+than|fewer\s+than|difference)\b/i;
const SIDE_BY_SIDE = /\b(?:compare[ds]?|comparison|versus|vs\.?)\b/i;
const EXCLUSION = /\b(?:excluding|exclude[sd]?|except(?:\s+for)?|other\s+than|not\s+counting|minus|apart\s+from|aside\s+from|without)\b/i;
const STATISTIC = /\b(?:average|mean|median|percent(?:age)?|share|proportion|ratio|per\s+(?:day|week)|highest|lowest|most|least|fewest|top|rank\w*|maximum|minimum|record\s+high)\b/i;
const BREAKDOWN_GEO = /\bby\s+(?:county|counties|parish(?:es)?|agenc(?:y|ies)|cit(?:y|ies)|states?|region)\b|\beach\s+(?:county|parish|agency|city|state)\b|\bper\s+(?:county|agency|city|state)\b/i;
const SUBGROUP = /\b(?:weapons?|firearms?|guns?|handguns?|rifles?|shotguns?|knife|knives|stab\w*|shoot\w*|shot|strangl\w*|blunt|poison\w*|arson|relationships?|circumstances?|motives?|offenders?|suspects?|killers?|perpetrators?|clear(?:ed|ance)|arrests?|solved|justifiable|felons?|police|officers?|domestic|intimate|spous\w*|wife|husband|girlfriend|boyfriend|partner|gang\w*|robber\w*|drugs?|child(?:ren)?|kids?|infants?|juveniles?|teen\w*|youth|minors?|elderly|seniors?|adults?|black|white|asian|native|hispanic|latin[oa]\w*|males?|females?|men|women|boys?|girls?|race|racial|ethnicit\w*|sex|gender|ages?|aged|under\s+\d+|over\s+\d+|older|younger|multiple\s+victims|single\s+victim)\b/i;
const NATIONAL = /\b(?:national(?:ly)?|nationwide|united\s+states|america|countrywide|all\s+(?:50\s+)?states|in\s+the\s+(?:us|u\.s\.?|usa|nation|country))\b/i;
const NATIONAL_ABBR = /\b(?:US|USA|U\.S\.A?\.?)(?=\W|$)/;
const INCIDENT_UNIT = /\bincidents?\b/i;
const NOT_INCIDENTS = /\b(?:not|rather\s+than|instead\s+of)\s+(?:\w+\s+)?incidents?\b/i;
const COUNTY_WORD = /\b(?:county|parish|borough)\b/gi;

const LIMITATION_SUPPORTED =
  "I can count homicide victims recorded in SHR -- all homicides, or murders only -- for the nation, a state, " +
  "a county (its sheriff's agency, or the countywide total when you ask for it), or named cities, for one " +
  "calendar year (as a total or by month) or an explicit range of years (as a total or year by year).";

/** Is this request in the owned family? A county name, or an all-homicide (or homicide-incident) measure. */
export function shrOwnedCountFamily(question: string): boolean {
  const measure = shrRequestedMeasure(question);
  return measure === "homicide" || measure === "homicide_incident" || shrCountyRequest(question) !== null;
}

function limitation(reason: string, what: string, status: "clarify" | "unavailable" = "unavailable"): ShrOwnedCountDecision {
  return { kind: "limitation", status, reason, explanation: `${what} ${LIMITATION_SUPPORTED}` };
}

/** Everything the request asks for beyond a plain count, which a total must not silently discard. */
function unsupportedMeaning(question: string, cityCount: number): ShrOwnedCountDecision | null {
  const contract = buildQueryContract(question, "shr");
  if (RATE.test(question) || (contract && contract.metric.unit !== "count" && contract.metric.unit !== "unknown")) {
    return limitation("owned-count-rate", "I can't give homicide rates from this count yet; it counts victim records, with no population denominator.");
  }
  if (CHANGE.test(question)) {
    return limitation("owned-count-change", "I can't calculate a change or difference between periods here yet.");
  }
  if (SIDE_BY_SIDE.test(question) && cityCount < 2) {
    return limitation("owned-count-comparison", "I can put named cities side by side, but I can't answer that comparison yet.");
  }
  if (EXCLUSION.test(question)) {
    return limitation("owned-count-exclusion", "I can't leave part of a place or period out of this count yet.");
  }
  const breakdowns = (contract?.breakdowns ?? []).filter((b) => b !== "year" && b !== "month");
  if (breakdowns.length > 0 || BREAKDOWN_GEO.test(question) || SUBGROUP.test(question)) {
    return limitation("owned-count-breakdown", "I can't break this count down, or limit it to a weapon, a group of victims or offenders, a relationship or a circumstance, yet.");
  }
  if (STATISTIC.test(question) || asksForSubstateEntities(question)) {
    return limitation("owned-count-statistic", "I can't give rankings, averages or shares from this count yet.");
  }
  if (contract?.comparability.continuousReporters) {
    return limitation("owned-count-reporters", "I can't limit this count to agencies that reported every month yet.");
  }
  return null;
}

/*
 * Complete-period admission (Codex OC1). A year found in the question is not the period unless the
 * question's time wording is fully accounted for. The supported forms are removed first; any time
 * wording left over ("the first six months of", "the second quarter of", "summer", "before", "mid-")
 * means the question asked for a period the plan cannot represent, so it is asked about, never
 * answered as the whole year.
 *
 * Numbers are held to the same rule as a whole: every digit must belong to a supported form. A year
 * inside a longer date ("2025-03-01", "03/01/2025", "June 30") leaves its other digits behind, so the
 * request is asked about rather than read as its year. Other numbers in a count question (rankings,
 * ages, victim counts) are already owned limitations before this point.
 */
const SUPPORTED_YEAR = /\b(?:(?:in|during|for|of|over|across)\s+)?(?:the\s+)?(?:(?:calendar\s+)?years?\s+)?(?:19|20)\d{2}\b/gi;
const OPEN_FROM = /\bfrom\s+(?:the\s+)?(?:year\s+)?(?:19|20)\d{2}\b(?!\s*(?:-|to|through|thru|and)\s*(?:19|20)\d{2})/i;
const LEFTOVER_TIME = /\b(?:months?|quarters?|quarterly|q[1-4]|h[12]|halves|half|semesters?|weeks?|weekly|weekends?|days?|daily|nights?|hours?|seasons?|seasonal|(?:spring|summer|fall|autumn|winter)s?|holidays?|christmas|thanksgiving|fiscal|fy\d*|periods?|dates?|through|thru|until|till|before|after|early|mid|middle|late|beginning|start|end|ending|first|second|third|fourth|final|next|following|preceding|as\s+of|up\s+to|prior\s+to)\b/i;
const PERIOD_UNSUPPORTED =
  "I can count a whole calendar year, a year through a named month (for example 2025 through June), a year " +
  "month by month, or a range of whole years (for example 2020 to 2024), but not part of a year given another " +
  "way, such as a specific date, a quarter, a half, a season or a number of months. Which of those do you want?";

/** Time wording left once every supported form is removed, or null when the period is fully read. */
function unrepresentedTime(question: string, through: RegExpExecArray | null, range: RegExpExecArray | null): string | null {
  if (OPEN_FROM.test(question)) return "from";
  let rest = question;
  if (range) rest = rest.replace(range[0], " ");
  if (through) rest = rest.replace(through[0], " ");
  rest = rest.replace(SUPPORTED_YEAR, " ").replace(new RegExp(MONTHLY.source, "gi"), " ").replace(new RegExp(ANNUAL.source, "gi"), " ");
  const left = LEFTOVER_TIME.exec(rest) ?? MONTH_WORD.exec(rest) ?? /\d+/.exec(rest);
  return left ? left[0] : null;
}

/** The explicit calendar period, or why it is not one. Rolling, relative and open periods are not guessed. */
function readPeriod(question: string): { period: ShrCountPeriod } | { limit: ShrOwnedCountDecision } {
  if (RELATIVE.test(question)) {
    return { limit: limitation("owned-count-period-relative", "I only count explicit calendar years here; say the year or the range of years you want (for example 2025, or 2020 to 2024).", "clarify") };
  }
  const range = RANGE.exec(question);
  const years = (question.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
  if (range) {
    const a = Number(range[1] ?? range[3]);
    const b = Number(range[2] ?? range[4]);
    if (years.length !== 2) {
      return { limit: limitation("owned-count-period-ambiguous", "That names more years than one explicit range; say one year or one range of years.", "clarify") };
    }
    if (THROUGH_MONTH.test(question) || MONTH_WORD.test(question)) {
      return { limit: limitation("owned-count-period-month-range", "I can't cut a range of years at a month yet; ask for whole years, or for one year through a month.") };
    }
    if (unrepresentedTime(question, null, range)) return { limit: periodUnsupported() };
    return { period: { kind: "range", startYear: Math.min(a, b), endYear: Math.max(a, b) } };
  }
  if (years.length === 0) {
    return { limit: limitation("owned-count-period-missing", "Which year, or range of years, do you want?", "clarify") };
  }
  if (years.length > 1) {
    return { limit: limitation("owned-count-period-ambiguous", "That names more than one year without a range; say one year, or a range such as 2020 to 2024.", "clarify") };
  }
  const through = THROUGH_MONTH.exec(question);
  const withoutThrough = through ? question.replace(through[0], " ") : question;
  if (MONTH_WORD.test(withoutThrough)) {
    return { limit: limitation("owned-count-period-month", "I can't count a single month or a span of months within a year yet; ask for the whole year, the year through a month, or the year by month.") };
  }
  if (unrepresentedTime(question, through, null)) return { limit: periodUnsupported() };
  const throughMonth = through ? MONTHS.indexOf(through[1].toLowerCase()) + 1 : 12;
  return { period: { kind: "year", year: years[0], throughMonth } };
}

function periodUnsupported(): ShrOwnedCountDecision {
  return { kind: "limitation", status: "clarify", reason: "owned-count-period-unsupported", explanation: PERIOD_UNSUPPORTED };
}

/**
 * Decide the owned count for a request already known to be in the family. Resolves geography with
 * the credited county resolver or the existing city resolver; never guesses a place.
 */
export function planShrOwnedCount(question: string, db: Database.Database): ShrOwnedCountDecision {
  const measure = shrRequestedMeasure(question);
  if (measure === "conflict") {
    // The route asks this before any builder; kept here so the planner can never guess one.
    return limitation("owned-count-measure-conflict", "That asks for both murders and all homicides, which are different counts here.", "clarify");
  }
  const unitIsIncidents = measure === "homicide_incident" || (INCIDENT_UNIT.test(question) && !NOT_INCIDENTS.test(question));
  if (unitIsIncidents) {
    return {
      kind: "limitation", status: "unavailable", reason: "owned-count-incident-unit",
      explanation: "SHR counts victims here, and I can't give a count of homicide incidents for this yet. " +
        "I can give the number of homicide victims for the same place and period instead.",
    };
  }

  const requested = shrCountyRequest(question);
  const geo = resolveGeoPlaces(question);
  // The county phrase itself ("baldwin county al") is the county, not another place mentioned beside it.
  const countySpan = requested ? countyPhraseSpan(question, requested.countyDisplay) : null;
  const mentions = geo.mentions.filter((m) => !countySpan || m.end <= countySpan.start || m.start >= countySpan.end);
  const firsts = mentions.map((m) => m.candidates[0]).filter(Boolean);
  const cities = firsts.filter((c) => c.kind === "city" && c.state);
  // Qualifier words are read with the named places removed, so "White Plains" is not a race filter.
  let residual = question;
  // Blanked in place (same length), so overlapping spans -- the county phrase is also a geo mention --
  // never shift one another.
  for (const span of [...geo.mentions.map((m) => ({ start: m.start, end: m.end })), ...(countySpan ? [countySpan] : [])]) {
    residual = `${residual.slice(0, span.start)}${" ".repeat(Math.max(0, span.end - span.start))}${residual.slice(span.end)}`;
  }
  const unsupported = unsupportedMeaning(residual, cities.length);
  if (unsupported) return unsupported;
  const read = readPeriod(residual);
  if ("limit" in read) return read.limit;
  const period = read.period;

  const monthly = MONTHLY.test(residual);
  const annual = ANNUAL.test(residual);
  if (monthly && period.kind === "range") {
    return limitation("owned-count-series", "I can give a range of years as a total or year by year, but not month by month yet.");
  }
  const series: ShrCountPlan["series"] = monthly ? "monthly" : annual && period.kind === "range" ? "annual" : "total";
  const plan = (geography: ShrCountGeography): ShrOwnedCountDecision =>
    ({ kind: "plan", plan: { geography, period, series, measure: measure === "murder" ? "murder" : "homicide", unit: "victims" } });

  if (requested) {
    const namedStates = [...new Set(firsts.filter((c) => c.kind === "state" && c.state).map((c) => c.state!.toUpperCase()))];
    const county = !requested.state && namedStates.length === 1 ? { ...requested, state: namedStates[0] } : requested;
    const others = firsts.filter((c) => !(c.kind === "state" && c.state?.toUpperCase() === county.state?.toUpperCase()));
    if ((question.match(COUNTY_WORD) || []).length > 1 || others.length > 0 || NATIONAL.test(residual)) {
      return limitation("owned-count-mixed-geography", "I can't combine a county with another county, a city, a state or the nation in one count yet.");
    }
    const resolution = resolveShrCountyScope(db, county);
    if (resolution.status !== "resolved") return { kind: "county-exit", resolution };
    return plan({ kind: "county", binding: resolution.binding });
  }

  if (geo.requiresClarification) {
    return limitation("owned-count-geography-ambiguous", "Which place do you mean?", "clarify");
  }
  const cityStates = new Set(cities.map((c) => c.state));
  const rest = firsts.filter((c) => !(c.kind === "city" && c.state) && !(c.kind === "state" && cityStates.has(c.state)));
  if (cities.length > 0) {
    if (rest.length > 0 || NATIONAL.test(residual)) {
      return limitation("owned-count-mixed-geography", "I can't combine cities with a county, a state or the nation in one count yet.");
    }
    const startYear = period.kind === "year" ? period.year : period.startYear;
    const endYear = period.kind === "year" ? period.year : period.endYear;
    const unique = cities.filter((c, i, all) => all.findIndex((o) => o.id === c.id) === i);
    const places = [];
    for (const c of unique) {
      const requestedName = c.name === "New York City" ? "New York" : c.name;
      const display = `${c.name}, ${c.state!.toUpperCase()}`;
      const resolved = resolveShrAgency(db, requestedName, c.state!, { kind: "city", startYear, endYear });
      if (resolved.status !== "resolved" || resolved.ranges.length === 0) {
        return { kind: "limitation", status: "unavailable", reason: "owned-count-place-unresolved",
          explanation: `I cannot safely identify ${display} in the SHR agency identity data for that period. I will not substitute or silently omit another agency.` };
      }
      places.push({ display, ranges: resolved.ranges.map((r) => ({ ori: r.ori, startYear: r.startYear, endYear: r.endYear })) });
    }
    return plan({ kind: "cities", places });
  }

  const statewide = explicitStateIntent(question);
  const states = [...new Set(firsts.filter((c) => c.kind === "state" && c.state).map((c) => c.state!))];
  const nonState = firsts.filter((c) => c.kind !== "state");
  if (nonState.length > 0) {
    return limitation("owned-count-geography", "I can't identify that place as a city, county or state for this count.");
  }
  if (states.length > 1 || (statewide && states.length === 1 && states[0] !== statewide.state)) {
    return limitation("owned-count-mixed-geography", "I can count one state at a time here, not several together.");
  }
  if (states.length === 1 || statewide) {
    if (NATIONAL.test(residual)) {
      return limitation("owned-count-mixed-geography", "I can't combine a state with the national total in one count.");
    }
    const code = statewide?.state ?? states[0];
    const name = statewide?.stateName ?? firsts.find((c) => c.kind === "state")!.name;
    return plan({ kind: "state", state: code.toUpperCase(), stateName: name });
  }
  if (NATIONAL.test(residual) || NATIONAL_ABBR.test(residual)) return plan({ kind: "national" });
  return limitation("owned-count-geography-missing", "Which place do you want: the nation, a state, a county or a city?", "clarify");
}

/** Where "<name> County[, ST]" sits in the question, so mentions inside it are not other places. */
function countyPhraseSpan(question: string, countyDisplay: string): { start: number; end: number } | null {
  const name = countyDisplay.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const match = new RegExp(`${name}\\s+(?:county|parish|borough)(?:,?\\s+[a-z]{2}\\b)?`, "i").exec(question);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/* ------------------------------------------------------------------ compiler */

export type CompiledShrCount = Readonly<{
  plan: ShrCountPlan;
  sql: string;
  columns: readonly string[];
  valueColumn: string;
  periodColumn: string | null;
  title: string;
  /** The compiled narrative before the post-execution gap summary. */
  explanation: string;
  chartType: "bar" | "line";
  xAxis: string;
  yAxisLabel: string;
}>;

const ISSUED = new WeakSet<object>();

const q = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * An agency's ORI ranges as OR predicates, clipped to the requested period: an ORI active for the
 * whole period is `i.ori = X`; one active for part of it keeps its clipped years; one not active in it
 * is dropped. OR predicates (never a join to a range table) mean an overlapping range cannot count a
 * victim twice. No active ORI at all compiles to `1 = 0`, an honest "no records" (unknown), not a
 * widened scope.
 */
function orPredicate(ranges: OriRange[], period: ShrCountPeriod): string {
  const [from, to] = period.kind === "range" ? [period.startYear, period.endYear] : [period.year, period.year];
  const parts = ranges
    .map((r) => ({ ori: r.ori, a: Math.max(Math.trunc(r.startYear), from), b: Math.min(Math.trunc(r.endYear), to) }))
    .filter((r) => r.a <= r.b)
    .map((r) => (r.a === from && r.b === to ? `i.ori = ${q(r.ori)}` : `(i.ori = ${q(r.ori)} AND i.year BETWEEN ${r.a} AND ${r.b})`));
  return parts.length ? parts.join(" OR ") : "1 = 0";
}

function placeLabels(g: ShrCountGeography): string[] {
  switch (g.kind) {
    case "cities": return g.places.map((p) => p.display);
    case "county": return [g.binding.kind === "sheriff" ? `${g.binding.label}, ${g.binding.state}` : g.binding.label];
    case "state": return [g.stateName];
    case "national": return ["United States"];
  }
}

function periodText(p: ShrCountPeriod): { title: string; prose: string } {
  if (p.kind === "range") return { title: `${p.startYear}-${p.endYear}`, prose: `${p.startYear} through ${p.endYear}` };
  if (p.throughMonth < 12) {
    const m = MONTHS[p.throughMonth - 1];
    const month = m[0].toUpperCase() + m.slice(1);
    return { title: `January-${month} ${p.year}`, prose: `January through ${month} ${p.year}` };
  }
  return { title: String(p.year), prose: `calendar year ${p.year}` };
}

/** The one SQL statement a plan compiles to. Deterministic: the same plan always yields the same text. */
function compileSql(plan: ShrCountPlan): string {
  const g = plan.geography;
  const labels = placeLabels(g);
  let geoWhere: string;
  let placeExpr: string;
  if (g.kind === "cities") {
    if (g.places.length === 0 || g.places.some((p) => p.ranges.length === 0)) throw new Error("owned count: a city with no ORI range");
    geoWhere = g.places.map((p) => orPredicate(p.ranges, plan.period)).join(" OR ");
    placeExpr = g.places.length === 1 ? q(labels[0])
      : `CASE ${g.places.map((p, n) => `WHEN ${orPredicate(p.ranges, plan.period)} THEN ${q(labels[n])}`).join(" ")} END`;
  } else if (g.kind === "county") {
    if (g.binding.ranges.length === 0) throw new Error("owned count: a county binding with no ORI range");
    geoWhere = orPredicate(g.binding.ranges, plan.period);
    placeExpr = q(labels[0]);
  } else if (g.kind === "state") {
    if (!/^[A-Z]{2}$/.test(g.state)) throw new Error("owned count: not a state code");
    geoWhere = `i.state = ${q(g.state)}`;
    placeExpr = q(labels[0]);
  } else {
    geoWhere = "1 = 1";
    placeExpr = q(labels[0]);
  }
  const p = plan.period;
  const monthly = plan.series === "monthly";
  const periodWhere = p.kind === "range"
    ? `i.year BETWEEN ${p.startYear} AND ${p.endYear}`
    : `i.year = ${p.year}${p.throughMonth < 12 ? ` AND i.month BETWEEN 1 AND ${p.throughMonth}` : ""}`;
  const [first, last] = monthly && p.kind === "year" ? [1, p.throughMonth]
    : p.kind === "range" ? [p.startYear, p.endYear] : [p.year, p.year];
  const measureWhere = plan.measure === "murder" ? " AND i.homicide_type = 'Murder'" : "";
  const value = plan.measure === "murder" ? "murder_victims" : "homicide_victims";
  const periodExpr = monthly ? "i.month" : "i.year";
  const places = labels.map((label, n) => `(${q(label)}, ${n + 1})`).join(", ");
  const head = `WITH RECURSIVE periods(period) AS (SELECT ${first} UNION ALL SELECT period + 1 FROM periods WHERE period < ${last}), ` +
    `places(place, ord) AS (VALUES ${places}), ` +
    `counts AS (SELECT ${placeExpr} AS place, ${periodExpr} AS period, COUNT(v.id) AS victims FROM incidents i JOIN victims v ON v.incident_id = i.id ` +
    `WHERE (${geoWhere}) AND ${periodWhere}${measureWhere} GROUP BY 1, 2)`;
  if (plan.series === "total") {
    return `${head} SELECT p.place AS place, SUM(c.victims) AS ${value}, ` +
      `GROUP_CONCAT(CASE WHEN c.victims IS NULL THEN pr.period END, ', ') AS years_without_records ` +
      `FROM places p CROSS JOIN periods pr LEFT JOIN counts c ON c.place = p.place AND c.period = pr.period GROUP BY p.place, p.ord ORDER BY p.ord LIMIT 1000`;
  }
  const periodColumn = monthly ? "month" : "year";
  const label = monthly && p.kind === "year" ? `printf('%04d-%02d', ${p.year}, pr.period)` : "pr.period";
  return `${head} SELECT p.place AS place, ${label} AS ${periodColumn}, c.victims AS ${value}, ` +
    `CASE WHEN c.victims IS NULL THEN 'no SHR records (unknown)' ELSE 'recorded' END AS shr_records ` +
    `FROM places p CROSS JOIN periods pr LEFT JOIN counts c ON c.place = p.place AND c.period = pr.period ORDER BY p.ord, pr.period LIMIT 1000`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

/** Compile a plan into its statement, columns, title and disclosures, and register it as issued. */
export function compileShrCountPlan(input: ShrCountPlan): CompiledShrCount {
  const plan = deepFreeze(JSON.parse(JSON.stringify(input)) as ShrCountPlan);
  const sql = compileSql(plan);
  const labels = placeLabels(plan.geography);
  const homicide = plan.measure === "homicide";
  const value = homicide ? "homicide_victims" : "murder_victims";
  const periodColumn = plan.series === "monthly" ? "month" : plan.series === "annual" ? "year" : null;
  const columns = periodColumn ? ["place", periodColumn, value, "shr_records"] : ["place", value, "years_without_records"];
  const when = periodText(plan.period);
  const placeList = labels.join(", ");
  const placeProse = plan.geography.kind === "national" ? "the United States" : placeList;
  const measureTitle = homicide ? "Homicide Victims (All Homicides)" : "Murder Victims";
  const seriesTitle = plan.series === "monthly" ? "Monthly " : plan.series === "annual" ? "Annual " : "";
  const sentences = [
    `${homicide ? "All homicide" : "Murder"} victim records reported in SHR for ${placeProse}, ${when.prose}.`,
    "One incident can have multiple victims, so this counts victim records rather than incidents.",
    plan.series === "total"
      ? "A year with no SHR victim records is not counted as zero: it is unknown, and any such years are listed in the years_without_records column."
      : `A ${plan.series === "monthly" ? "month" : "year"} with no SHR victim records is shown blank, as unknown, not as zero.`,
  ];
  if (plan.geography.kind === "state" || plan.geography.kind === "national") {
    sentences.push(`This totals the victim records agencies reported to SHR. Agencies that did not report are not included, so it is not an estimate of every ${homicide ? "homicide" : "murder"} in ${placeProse}.`);
  }
  const binding = plan.geography.kind === "county" ? plan.geography.binding : null;
  const explanation = withShrScopeAndMeasureDisclosures(sentences.join(" "), binding, homicide);
  const compiled: CompiledShrCount = Object.freeze({
    plan, sql, columns: Object.freeze(columns), valueColumn: value, periodColumn,
    title: `${seriesTitle}${measureTitle}, ${placeList}, ${when.title}`,
    explanation,
    chartType: periodColumn ? "line" : "bar",
    xAxis: periodColumn ?? "place",
    yAxisLabel: homicide ? "Homicide Victims" : "Murder Victims",
  });
  ISSUED.add(compiled);
  return compiled;
}

/** Null when this is an issued, unaltered compilation; otherwise why it must not execute. */
export function compiledShrCountIssue(compiled: CompiledShrCount): string | null {
  if (!compiled || typeof compiled !== "object" || !ISSUED.has(compiled)) return "the statement was not issued by the owned count compiler";
  if (!Object.isFrozen(compiled) || !Object.isFrozen(compiled.plan)) return "the compiled count was unfrozen after compilation";
  let expected: string;
  try { expected = compileSql(compiled.plan); } catch (err) { return `the plan no longer compiles: ${(err as Error).message}`; }
  if (compiled.sql !== expected) return "the statement differs from what its plan compiles to";
  return null;
}

/** Execute exactly the compiler's statement. Anything else is refused, never reclassified. */
export function executeCompiledShrCount(db: Database.Database, compiled: CompiledShrCount): Record<string, unknown>[] {
  const issue = compiledShrCountIssue(compiled);
  if (issue) throw new Error(`owned SHR count refused: ${issue}`);
  return db.prepare(compiled.sql).all() as Record<string, unknown>[];
}

/** The compiled narrative plus the unknown periods the executed rows show. */
export function shrCountNarrative(compiled: CompiledShrCount, rows: Record<string, unknown>[]): string {
  const notes: string[] = [];
  const value = compiled.valueColumn;
  if (compiled.periodColumn) {
    const byPlace = new Map<string, string[]>();
    for (const row of rows) {
      if (row[value] == null) {
        const place = String(row.place);
        byPlace.set(place, [...(byPlace.get(place) ?? []), String(row[compiled.periodColumn])]);
      }
    }
    for (const [place, periods] of byPlace) {
      notes.push(`No SHR victim records for ${place} in ${periods.join(", ")}; ${periods.length === 1 ? "that period is" : "those periods are"} unknown, not zero.`);
    }
  } else {
    for (const row of rows) {
      if (row[value] == null) notes.push(`No SHR victim records were found for ${String(row.place)} in this period; that is unknown, not zero.`);
      else if (row.years_without_records) notes.push(`${String(row.place)} has no SHR victim records in ${String(row.years_without_records)}; the total covers only the years with records, and the missing years are unknown.`);
    }
  }
  return notes.length ? `${compiled.explanation}\n\n${notes.join(" ")}` : compiled.explanation;
}
