import { resolveGeoPlaces } from "./geo-place-resolver";
import type { RoutingLogMeta } from "./routing-log-meta";
import { isChartTypeOnlyRequest, isYAxisDomainOnlyRequest } from "./chart-customization";

export type QueryContractSource = "current" | "historical" | "nibrs" | "shr" | "hate_crime";
export type ContractConfidence = "high" | "medium" | "low";

export type QueryContract = {
  source: QueryContractSource;
  geography: {
    kind: "city" | "county" | "state" | "agency" | "campus" | "national" | "unknown";
    name: string | null;
    state: string | null;
    canonicalName: string | null;
    sourceCodes?: Record<string, string | string[]>;
    confidence: ContractConfidence;
    needsClarification: string[];
  };
  metric: {
    topic: string;
    offenseCodes: string[];
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
  };
  followup: {
    isFollowup: boolean;
    operation: "replace" | "refine" | "metadata" | "chart_only" | null;
  };
  warnings: string[];
};

const STATE_CODE_ALIASES: Record<string, Record<QueryContractSource, string | string[]>> = {
  NE: { current: "NE", historical: "nb", nibrs: ["NE", "NB"], shr: "NE", hate_crime: "NE" },
  GU: { current: "GU", historical: "gm", nibrs: ["GU", "GM"], shr: "GU", hate_crime: "GU" },
};

const OFFENSE_PATTERNS: { topic: string; codes: string[]; pattern: RegExp }[] = [
  { topic: "murder", codes: ["09A"], pattern: /\b(murders?|homicides?|killings?|fatal\s+shootings?)\b/i },
  { topic: "hate_crime", codes: [], pattern: /\bhate\s+crimes?\b|\bbias[-\s]+motivated\b/i },
  { topic: "rape", codes: ["11A", "11B", "11C"], pattern: /\brapes?\b/i },
  { topic: "robbery", codes: ["120"], pattern: /\brobber(?:y|ies)\b/i },
  { topic: "aggravated_assault", codes: ["13A"], pattern: /\baggravated\s+assaults?\b/i },
  { topic: "burglary", codes: ["220"], pattern: /\bburglar(?:y|ies)\b/i },
  { topic: "theft", codes: ["23A-23H"], pattern: /\b(?:theft|larceny|larcenies)\b/i },
  { topic: "motor_vehicle_theft", codes: ["240"], pattern: /\b(?:motor\s+vehicle|auto)\s+theft\b/i },
  { topic: "carjacking", codes: ["64A", "64B"], pattern: /\bcarjack(?:ing|ings)?\b/i },
  { topic: "domestic_violence", codes: [], pattern: /\bdomestic\s+violence\b|\bintimate\s+partner\s+violence\b|\b(?<![a-z])dv(?![a-z])\b/i },
  { topic: "violent_crime", codes: ["09A", "11A", "11B", "11C", "120", "13A"], pattern: /\bviolent\s+crime\b/i },
  { topic: "property_crime", codes: ["200", "220", "23A-23H", "240"], pattern: /\bproperty\s+crime\b/i },
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

function isPartialYearQuestion(question: string): boolean {
  const currentYear = new Date().getFullYear();
  return new RegExp(`\\b${currentYear}\\b`).test(question) ||
    /\b(ytd|year[-\s]?to[-\s]?date|this year|so far|to date)\b/i.test(question);
}

function detectBreakdowns(question: string): string[] {
  const breakdowns: string[] = [];
  const checks: [string, RegExp][] = [
    ["year", /\b(?:by|per|each)\s+year\b|\btrends?\b/i],
    ["month", /\b(?:by|per|each)\s+month\b|\bmonthly\b/i],
    ["state", /\bby\s+state\b|\bstates?\s+breakdown\b/i],
    ["city", /\bby\s+cit(?:y|ies)\b|\bcit(?:y|ies)\s+breakdown\b/i],
    ["agency", /\bby\s+agenc(?:y|ies)\b|\bagenc(?:y|ies)\s+breakdown\b/i],
    ["age_group", /\bage\b|\bage\s+group\b/i],
    ["race", /\brace|racial\b/i],
    ["sex", /\bsex|gender|male|female|men|women\b/i],
    ["offense_code", /\bby\s+offense\b|\boffense\s+(?:code|type|breakdown)\b/i],
  ];
  for (const [name, pattern] of checks) {
    if (pattern.test(question)) breakdowns.push(name);
  }
  return [...new Set(breakdowns)];
}

function detectMetric(question: string): QueryContract["metric"] {
  const topicMatch = OFFENSE_PATTERNS.find((entry) => entry.pattern.test(question));
  const topic = topicMatch?.topic ?? (/\bcrimes?\b/i.test(question) ? "crime" : "unknown");
  const asksRate = /\b(?:rates?|per\s*(?:capita|100k|100,?000|10k|10,?000|1k|1,?000|million|1m)|relative\s+to\s+population|population[-\s]+adjusted)\b/i.test(question);
  const asksClearance = /\b(?:clearance|clearances?|cleared|solve[ds]?|unsolved|exceptional(?:ly)?|cleared\s+by\s+arrest)\b/i.test(question);
  const asksRatio = /\b(?:ratio|share|percent|percentage)\b/i.test(question);
  const asksDemographic = /\b(?:race|racial|ethnicit\w+|hispanic|latino\w*|sex|gender|male|female|men|women|age|juvenile\w*|teen\w*|demographic)\b/i.test(question);

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
    offenseCodes: topicMatch?.codes ?? [],
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

function detectGeography(question: string, source: QueryContractSource): QueryContract["geography"] {
  if (/\b(?:national|nationwide|united states|u\.?s\.?|america)\b/i.test(question)) {
    return { kind: "national", name: "United States", state: null, canonicalName: "United States", confidence: "high", needsClarification: [] };
  }

  const resolution = resolveGeoPlaces(question);

  if (/\b(?:universit(?:y|ies)|college|campus|ucla|uc\s+berkeley|berkeley\s+campus)\b/i.test(question)) {
    const first = resolution.mentions[0];
    const candidate = first?.candidates[0];
    const state = candidate?.state ?? null;
    return {
      kind: "campus",
      name: candidate?.name ?? null,
      state,
      canonicalName: candidate?.canonicalQuery ?? candidate?.name ?? null,
      ...(state && STATE_CODE_ALIASES[state] ? { sourceCodes: STATE_CODE_ALIASES[state] } : {}),
      confidence: first?.requiresClarification ? "low" : candidate ? "medium" : "medium",
      needsClarification: first?.requiresClarification ? first.candidates.map((c) => c.canonicalQuery ?? c.name) : [],
    };
  }

  const first = resolution.mentions[0];
  if (first?.candidates.length) {
    const candidate = first.candidates[0];
    const state = candidate.state ?? null;
    const kind = candidate.kind === "agency_alias" ? "agency" : candidate.kind;
    return {
      kind,
      name: candidate.name,
      state,
      canonicalName: candidate.canonicalQuery ?? candidate.name,
      ...(state && STATE_CODE_ALIASES[state] ? { sourceCodes: STATE_CODE_ALIASES[state] } : {}),
      confidence: first.requiresClarification ? "low" : candidate.confidence >= 0.9 ? "high" : "medium",
      needsClarification: first.requiresClarification ? first.candidates.map((c) => c.canonicalQuery ?? c.name) : [],
    };
  }

  if (/\bagenc(?:y|ies)|police department|sheriff\b/i.test(question)) {
    return { kind: "agency", name: null, state: null, canonicalName: null, confidence: "low", needsClarification: [] };
  }

  return { kind: "unknown", name: null, state: null, canonicalName: null, confidence: "low", needsClarification: [] };
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

  return {
    source,
    geography: detectGeography(text, source),
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
