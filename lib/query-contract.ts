import { resolveGeoPlaces } from "./geo-place-resolver";
import { demographicIntentText, mentionsDemographicRateGroup } from "./demographic-rate-intent";
import type { RoutingLogMeta } from "./routing-log-meta";
import { isChartTypeOnlyRequest, isYAxisDomainOnlyRequest } from "./chart-customization";

export type QueryContractSource = "current" | "historical" | "nibrs" | "shr" | "hate_crime";
export type ContractConfidence = "high" | "medium" | "low";

export type QueryContractGeography = {
  kind: "city" | "county" | "state" | "agency" | "campus" | "national" | "unknown";
  name: string | null;
  state: string | null;
  canonicalName: string | null;
  sourceCodes?: Record<string, string | string[]>;
  confidence: ContractConfidence;
  needsClarification: string[];
};

export type QueryContractOffense = {
  topic: string;
  codes: string[];
  label: string;
};

export type QueryContract = {
  source: QueryContractSource;
  geography: QueryContractGeography;
  geographies: QueryContractGeography[];
  metric: {
    topic: string;
    offenseCodes: string[];
    offenses: QueryContractOffense[];
    unit: "count" | "rate_per_100k" | "clearance_rate" | "ratio" | "unknown";
    numerator: string | null;
    denominator: string | null;
    unsupportedReason: string | null;
  };
  time: {
    startYear: number | null;
    endYear: number | null;
    partialYear: boolean;
    returnedPeriodRequired: boolean;
  };
  breakdowns: string[];
  comparability: {
    continuousReporters: boolean;
    partialYearDisclosure: boolean;
    /**
     * Does the REQUEST ask whether one period differs from another?
     *
     * The comparison operation, owned by the request rather than rediscovered from a returned
     * column name. GC-055 delivered `pct_change: -61.9` in one run and `decreased: "Yes"` in the
     * next; both are the same operation, and no property of the answer distinguishes them
     * reliably. So the operation is declared here, before any model call.
     *
     * `requested` is recorded INDEPENDENTLY of whether `years` resolves. An unresolved comparison
     * request ("how has murder changed since last year?") is still a comparison request, and
     * collapsing the two would let an unresolved one be treated as an ordinary count.
     *
     * Deliberately NOT derived from `time.partialYear`: that flag is a disclosure signal and is
     * true for "what is the population estimate for 2026?", which asks for no comparison at all.
     */
    comparison: {
      requested: boolean;
      /** The compared endpoints, when the question resolves them. Null when it does not. */
      years: { startYear: number; endYear: number } | null;
    };
  };
  followup: {
    isFollowup: boolean;
    operation: "replace" | "refine" | "metadata" | "chart_only" | null;
  };
  warnings: string[];
  /**
   * Present ONLY on a contract built by amending an earlier request (lib/current-followup-amendment.ts).
   * `buildQueryContract` never sets it, so every existing caller is unaffected.
   *
   * When it is present, the fields above were not parsed from the current turn's text: they were
   * carried from the reader's own earlier turns, one field at a time. A consumer that would
   * otherwise re-read an owned meaning from the question text — "is this a rolling request?",
   * "which grain was asked for?" — reads it from here instead, because the current turn is often a
   * fragment ("now detroit") that says nothing about either.
   */
  request?: AmendedRequestState;
};

/** The series form a Current request states. Display grain is not a separate field in this slice. */
export type RequestWindow = "rolling_12" | "monthly" | "annual";
export type RequestField = "offense" | "unit" | "window" | "geography" | "period";

export type RequestFieldOrigin = {
  /**
   * stated: the reader's own words established it. defaulted: the parser supplied it (the unit is
   * `count` whenever an offense is named). absent: nothing established it.
   */
  origin: "stated" | "defaulted" | "absent";
  /** The user turn that established it, verbatim. Null when absent. */
  turn: string | null;
  /** True when that turn is an earlier one, carried forward rather than stated in this turn. */
  inherited: boolean;
};

export type AmendedRequestState = {
  kind: "current_amendment";
  window: RequestWindow | null;
  provenance: Record<RequestField, RequestFieldOrigin>;
  /** The full user request the amendments were applied to, verbatim. */
  anchor: string;
};

/**
 * The grain a series form implies, in the vocabulary `lib/requested-grain.ts` uses. A rolling
 * 12-month series is reported month by month, which is also what that module's own detector reads
 * from the words "rolling over 12 months".
 */
export function requestWindowGrain(window: RequestWindow | null): "monthly" | "annual" | null {
  if (window === "rolling_12" || window === "monthly") return "monthly";
  if (window === "annual") return "annual";
  return null;
}
const STATE_CODE_ALIASES: Record<string, Record<QueryContractSource, string | string[]>> = {
  NE: { current: "NE", historical: "nb", nibrs: ["NE", "NB"], shr: "NE", hate_crime: "NE" },
  GU: { current: "GU", historical: "gm", nibrs: ["GU", "GM"], shr: "GU", hate_crime: "GU" },
};

const OFFENSE_PATTERNS: { topic: string; codes: string[]; label: string; pattern: RegExp }[] = [
  { topic: "murder", codes: ["09A"], label: "Murders", pattern: /\b(murders?|homicides?|killings?|fatal\s+shootings?)\b/i },
  { topic: "hate_crime", codes: [], label: "Hate crimes", pattern: /\bhate\s+crimes?\b|\bbias[-\s]+motivated\b/i },
  { topic: "sex_offense", codes: ["11A", "11B", "11C", "11D", "36A", "36B"], label: "Sex offenses", pattern: /\bsex(?:ual)?\s+offenses?\b|\bsex\s+crimes?\b/i },
  { topic: "rape", codes: ["11A", "11B", "11C"], label: "Rapes", pattern: /\brapes?\b/i },
  { topic: "robbery", codes: ["120"], label: "Robberies", pattern: /\brobber(?:y|ies)\b/i },
  { topic: "aggravated_assault", codes: ["13A"], label: "Aggravated assaults", pattern: /\baggravated\s+assaults?\b/i },
  /*
   * A THEFT FROM A VEHICLE IS NOT A BURGLARY OF A BUILDING.
   *
   * "Houston vehicle burglaries" produced a contract for `220`, breaking and entering, because
   * `/\bburglar(y|ies)\b/` is the only thing that matched. The answer that shipped counted `23F`,
   * Theft From Motor Vehicle -- so the contract and the delivered figure were about different
   * crimes, and a controlled path driven by the contract would have answered the wrong one
   * correctly. NIBRS separates theft of articles from a vehicle (`23F`) from theft of the vehicle
   * itself (`240`) and from its parts and accessories (`23G`); several police departments, Houston
   * among them, call the first "burglary of a motor vehicle", which is where the wording comes from.
   *
   * DELIBERATELY NARROW. The vehicle word must be ADJACENT to the burglary word, either side. A
   * question that merely contains both somewhere -- "were burglaries higher in neighbourhoods with
   * more vehicle traffic" -- keeps ordinary burglary, and genuinely ambiguous wording is left to
   * clarification rather than silently reassigned. `detectOffenses` rejects overlapping matches and
   * takes the earlier one, so this entry supersedes the plain burglary match on the same phrase
   * without needing to be ordered ahead of it.
   */
  {
    topic: "vehicle_burglary", codes: ["23F"], label: "Thefts from vehicles",
    pattern: /\b(?:(?:motor\s+)?vehicles?|cars?|autos?|automobiles?|trucks?)\s+burglar(?:y|ies)\b|\bburglar(?:y|ies)\s+(?:of|from|to)\s+(?:a\s+|an\s+|the\s+)?(?:motor\s+)?(?:vehicles?|cars?|autos?|automobiles?|trucks?)\b/i,
  },
  { topic: "burglary", codes: ["220"], label: "Burglaries", pattern: /\bburglar(?:y|ies)\b/i },
  { topic: "theft", codes: ["23A-23H"], label: "Thefts", pattern: /\b(?:theft|larceny|larcenies)\b/i },
  { topic: "motor_vehicle_theft", codes: ["240"], label: "Motor vehicle thefts", pattern: /\b(?:motor\s+vehicle|auto)\s+thefts?\b/i },
  // Carjacking has NO offense code: it is robbery (120) with a stolen vehicle, counted in the summary_carjacking_* tables.
  // 64A/64B are human trafficking (carjacking hotfix, 2026-10-10). Like domestic violence, it is a code-less family.
  { topic: "carjacking", codes: [], label: "Carjackings", pattern: /\bcarjack(?:ing|ings)?\b/i },
  { topic: "domestic_violence", codes: [], label: "Domestic violence", pattern: /\bdomestic\s+violence\b|\bintimate\s+partner\s+violence\b|\b(?<![a-z])dv(?![a-z])\b/i },
  { topic: "violent_crime", codes: ["09A", "11A", "11B", "11C", "120", "13A"], label: "Violent crime", pattern: /\bviolent\s+crimes?\b/i },
  { topic: "property_crime", codes: ["200", "220", "23A-23H", "240"], label: "Property crime", pattern: /\bproperty\s+crime\b/i },
];

function yearsFromQuestion(question: string): { startYear: number | null; endYear: number | null } {
  const explicitRange = question.match(/\b(?:between|from)\s+((?:19|20)\d{2})\s+(?:and|to|through|thru|-)\s+((?:19|20)\d{2})\b/i) ||
    question.match(/\b((?:19|20)\d{2})\s*(?:-|to|through|thru)\s*((?:19|20)\d{2})\b/i);
  if (explicitRange) {
    const first = Number(explicitRange[1]);
    const second = Number(explicitRange[2]);
    return { startYear: Math.min(first, second), endYear: Math.max(first, second) };
  }

  const openEnded = question.match(/\b(?:since|starting|beginning)\s+((?:19|20)\d{2})\b/i) ||
    question.match(/\b(?:from\s+)?((?:19|20)\d{2})\s*(?:to|through|thru|-)\s*(?:present|current|now|today|date)\b/i);
  if (openEnded) return { startYear: Number(openEnded[1]), endYear: null };

  const years = (question.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
  if (years.length === 0) return { startYear: null, endYear: null };
  return { startYear: Math.min(...years), endYear: Math.max(...years) };
}

/**
 * Does the question ask whether one period differs from another?
 *
 * A fixed phrase list, not a classifier, and it never reads the answer. "Compare"/"versus" alone is
 * not enough: GC-055 asks "did violent crime decrease every year", which names no comparison word
 * at all in the tab-suggest sense, and GC-068 asks "how much did murders increase". Both are
 * comparisons and both must be recognised here.
 *
 * A bare year mention is deliberately excluded, so "what is the population estimate for 2026?" and
 * "how complete is 2026 data?" are not comparisons.
 */
const COMPARISON_REQUEST =
  /\b(?:compare[ds]?|comparison|versus|vs\.?|year[-\s]?over[-\s]?year|yoy|change[sd]?|changing|increase[sd]?|increasing|decrease[sd]?|decreasing|rise[ns]?|rising|rose|fall(?:s|en|ing)?|fell|drop(?:s|ped|ping)?|declin(?:e|ed|ing|es)|grew|grow(?:s|ing|th)|higher|lower|more\s+than|less\s+than|fewer\s+than)\b/i;

function detectComparison(question: string, time: { startYear: number | null; endYear: number | null }): QueryContract["comparability"]["comparison"] {
  const requested = COMPARISON_REQUEST.test(question);
  if (!requested) return { requested: false, years: null };
  const resolved = time.startYear !== null && time.endYear !== null && time.startYear !== time.endYear
    ? { startYear: time.startYear, endYear: time.endYear }
    : null;
  return { requested: true, years: resolved };
}

function isPartialYearQuestion(question: string): boolean {
  const currentYear = new Date().getFullYear();
  return new RegExp(`\\b${currentYear}\\b`).test(question) ||
    /\b(ytd|year[-\s]?to[-\s]?date|this year|so far|to date)\b/i.test(question);
}

function detectBreakdowns(question: string): string[] {
  const breakdowns: string[] = [];
  const demographicQuestion = demographicIntentText(question);
  const checks: [string, RegExp][] = [
    ["year", /\b(?:by|per|each)\s+year\b|\btrends?\b/i],
    ["month", /\b(?:by|per|each)\s+month\b|\bmonthly\b/i],
    ["state", /\bby\s+state\b|\bstates?\s+breakdown\b/i],
    ["city", /\bby\s+cit(?:y|ies)\b|\bcit(?:y|ies)\s+breakdown\b/i],
    ["agency", /\bby\s+agenc(?:y|ies)\b|\bagenc(?:y|ies)\s+breakdown\b/i],
    ["age_group", /\bage\b|\bage\s+group\b/i],
    ["race", /\brace|racial\b/i],
    ["ethnicity", /\bethnicit\w+|\bhispanic\b|\blatino\w*\b/i],
    ["sex", /\b(?:sex|gender|male|female|men|women)\b/i],
    ["offense_code", /\bby\s+offense\b|\boffense\s+(?:code|type|breakdown)\b/i],
  ];
  for (const [name, pattern] of checks) {
    const input = ["age_group", "race", "ethnicity", "sex"].includes(name) ? demographicQuestion : question;
    if (pattern.test(input)) breakdowns.push(name);
  }
  return [...new Set(breakdowns)];
}

function detectOffenses(question: string): QueryContractOffense[] {
  const matches = OFFENSE_PATTERNS
    .map((entry) => {
      const match = entry.pattern.exec(question);
      return match ? { entry, index: match.index, end: match.index + match[0].length } : null;
    })
    .filter((match): match is { entry: (typeof OFFENSE_PATTERNS)[number]; index: number; end: number } => match !== null)
    .sort((a, b) => a.index - b.index || (b.end - b.index) - (a.end - a.index));

  const accepted: typeof matches = [];
  for (const match of matches) {
    if (accepted.some((existing) => match.index < existing.end && existing.index < match.end)) continue;
    accepted.push(match);
  }

  return accepted
    .sort((a, b) => a.index - b.index)
    .map(({ entry }) => ({ topic: entry.topic, codes: entry.codes, label: entry.label }));
}
/**
 * True when ANY requested offense is a code-less family (carjacking, domestic violence). Code-only builders must not
 * claim such a request, even beside coded offenses: the flattened code list would silently drop the family
 * (carjacking hotfix, 2026-10-10).
 */
export function hasCodelessFamily(contract: QueryContract): boolean {
  return contract.metric.offenses.some((offense) => offense.codes.length === 0);
}

function detectMetric(question: string): QueryContract["metric"] {
  const offenses = detectOffenses(question);
  const topic = offenses[0]?.topic ?? (/\bcrimes?\b/i.test(question) ? "crime" : "unknown");
  const offenseCodes = [...new Set(offenses.flatMap((offense) => offense.codes))];
  const asksRate = /\b(?:rates?|per\s*(?:capita|100k|100,?000|10k|10,?000|1k|1,?000|million|1m)|relative\s+to\s+population|population[-\s]+adjusted)\b/i.test(question);
  const asksClearance = /\b(?:clearance|clearances?|cleared|solve[ds]?|unsolved|exceptional(?:ly)?|cleared\s+by\s+arrest)\b/i.test(question);
  const asksRatio = /\b(?:ratio|share|percent|percentage)\b/i.test(question);
  const asksDemographic = mentionsDemographicRateGroup(question);

  let unit: QueryContract["metric"]["unit"] = "count";
  if (asksClearance) unit = "clearance_rate";
  else if (asksRate) unit = "rate_per_100k";
  else if (asksRatio) unit = "ratio";
  else if (topic === "unknown") unit = "unknown";

  const unsupportedReason = asksRate && !asksClearance && asksDemographic
    ? "demographic_rate_denominator_unavailable"
    : null;

  return {
    topic,
    offenseCodes,
    offenses,
    unit,
    numerator: topic === "domestic_violence" ? "summary_domestic_violence distinct incidents" : null,
    denominator: unit === "rate_per_100k"
      ? topic === "domestic_violence"
        ? "population served by NIBRS-reporting agencies adjusted by months reported"
        : "population"
      : null,
    unsupportedReason,
  };
}
function hasStandaloneQueryAnchor(question: string): boolean {
  const metric = detectMetric(question);
  if (metric.topic !== "unknown" || metric.unit !== "unknown") return true;

  const time = yearsFromQuestion(question);
  if (time.startYear !== null || time.endYear !== null) return true;

  if (/\b(?:national|nationwide|united states|u\.?s\.?|america)\b/i.test(question)) return true;

  const resolution = resolveGeoPlaces(question);
  return resolution.mentions.some((mention) => mention.candidates.length > 0);
}

function detectFollowup(question: string, routingMeta?: RoutingLogMeta | null): QueryContract["followup"] {
  if (isYAxisDomainOnlyRequest(question) || isChartTypeOnlyRequest(question)) {
    return { isFollowup: true, operation: "chart_only" };
  }
  if (routingMeta?.mode === "follow_up") {
    if (/\b(?:what|which|how many)\b[\s\S]{0,80}\b(?:included|shown|listed|returned|in this|in these)\b/i.test(question)) {
      return { isFollowup: true, operation: "metadata" };
    }
    if (/\b(?:instead|rather|just|only)\b/i.test(question)) return { isFollowup: true, operation: "replace" };
    return { isFollowup: true, operation: "refine" };
  }
  const deictic = /\b(?:this|these|that|those|it|same|previous|prior|last|above)\b/i.test(question);
  if (deictic && /\b(?:included|shown|listed|returned)\b/i.test(question)) return { isFollowup: true, operation: "metadata" };
  if (deictic && hasStandaloneQueryAnchor(question)) return { isFollowup: false, operation: null };
  if (deictic) return { isFollowup: true, operation: "refine" };
  return { isFollowup: false, operation: null };
}

function geographyFromCandidate(
  question: string,
  mention: ReturnType<typeof resolveGeoPlaces>["mentions"][number]
): QueryContractGeography | null {
  const candidate = mention.candidates[0];
  if (!candidate) return null;

  const suffix = question.slice(mention.end, Math.min(question.length, mention.end + 40));
  const agencySuffix = suffix.match(/^\s+((?:city\s+)?police\s+(?:department|dept\.?)|county\s+(?:sheriff(?:'?s)?(?:\s+office)?|police(?:\s+department)?)|sheriff(?:'?s)?(?:\s+office)?)/i);
  const countySuffix = suffix.match(/^\s+(county|parish|borough)\b/i);
  const state = candidate.state ?? null;
  const baseKind = candidate.kind === "agency_alias" ? "agency" : candidate.kind;
  const kind: QueryContractGeography["kind"] = agencySuffix
    ? "agency"
    : countySuffix
      ? "county"
      : baseKind;
  const suffixLabel = agencySuffix?.[1] ?? countySuffix?.[1] ?? "";
  const name = suffixLabel ? (candidate.name + " " + suffixLabel).replace(/\s+/g, " ").trim() : candidate.name;
  const canonicalName = kind === "agency"
    ? name
    : kind === "county"
      ? candidate.name + " " + (countySuffix?.[1] ?? "County")
      : candidate.canonicalQuery ?? candidate.name;

  return {
    kind,
    name,
    state,
    canonicalName,
    ...(state && STATE_CODE_ALIASES[state] ? { sourceCodes: STATE_CODE_ALIASES[state] } : {}),
    confidence: mention.requiresClarification ? "low" : candidate.confidence >= 0.9 ? "high" : "medium",
    needsClarification: mention.requiresClarification ? mention.candidates.map((item) => item.canonicalQuery ?? item.name) : [],
  };
}

function detectGeographies(question: string): QueryContractGeography[] {
  if (/\b(?:national|nationwide|united states|u\.?s\.?|america)\b/i.test(question)) {
    return [{ kind: "national", name: "United States", state: null, canonicalName: "United States", confidence: "high", needsClarification: [] }];
  }

  const resolution = resolveGeoPlaces(question);
  if (/\b(?:universit(?:y|ies)|college|campus|ucla|uc\s+berkeley|berkeley\s+campus)\b/i.test(question)) {
    const first = resolution.mentions[0];
    const candidate = first?.candidates[0];
    const state = candidate?.state ?? null;
    return [{
      kind: "campus",
      name: candidate?.name ?? null,
      state,
      canonicalName: candidate?.canonicalQuery ?? candidate?.name ?? null,
      ...(state && STATE_CODE_ALIASES[state] ? { sourceCodes: STATE_CODE_ALIASES[state] } : {}),
      confidence: first?.requiresClarification ? "low" : "medium",
      needsClarification: first?.requiresClarification ? first.candidates.map((item) => item.canonicalQuery ?? item.name) : [],
    }];
  }

  const geographies = resolution.mentions
    .map((mention) => geographyFromCandidate(question, mention))
    .filter((geography): geography is QueryContractGeography => geography !== null);

  const unique = new Map<string, QueryContractGeography>();
  for (const geography of geographies) {
    const key = [geography.kind, geography.name, geography.state].join(":").toLowerCase();
    if (!unique.has(key)) unique.set(key, geography);
  }
  if (unique.size > 0) return [...unique.values()];

  if (/\bagenc(?:y|ies)|police department|sheriff\b/i.test(question)) {
    return [{ kind: "agency", name: null, state: null, canonicalName: null, confidence: "low", needsClarification: [] }];
  }

  return [{ kind: "unknown", name: null, state: null, canonicalName: null, confidence: "low", needsClarification: [] }];
}

export function buildQueryContract(
  question: string,
  source: QueryContractSource,
  routingMeta?: RoutingLogMeta | null
): QueryContract | null {
  const text = question.trim();
  if (!text) return null;

  const metric = detectMetric(text);
  const time = yearsFromQuestion(text);
  const partialYear = isPartialYearQuestion(text);
  const continuousReporters = /\b(?:consistent|continuous)(?:ly)?\s+(?:reporting\s+)?(?:agenc(?:y|ies)|reporters?)\b|\breported\s+all\s+12\s+months\b/i.test(text);
  const warnings: string[] = [];
  if (metric.unsupportedReason) warnings.push(metric.unsupportedReason);
  if (continuousReporters) warnings.push("continuous_reporters_required");
  if (partialYear) warnings.push("partial_year_disclosure_required");

  const geographies = detectGeographies(text);

  return {
    source,
    geography: geographies[0],
    geographies,
    metric,
    time: {
      startYear: time.startYear,
      endYear: time.endYear,
      partialYear,
      returnedPeriodRequired: partialYear,
    },
    breakdowns: detectBreakdowns(text),
    comparability: {
      continuousReporters,
      partialYearDisclosure: partialYear,
      comparison: detectComparison(text, time),
    },
    followup: detectFollowup(text, routingMeta),
    warnings,
  };
}

export function serializeQueryContractLogMeta(
  question: string,
  source: QueryContractSource,
  routingMeta?: RoutingLogMeta | null
): string | null {
  const contract = buildQueryContract(question, source, routingMeta);
  return contract ? JSON.stringify(contract).slice(0, 4000) : null;
}
