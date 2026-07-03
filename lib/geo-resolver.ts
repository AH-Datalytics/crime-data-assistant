import { resolveGeoPlaces, type GeoPlaceCandidate, type GeoPlaceMention } from "./geo-place-resolver";

export type GeoResolutionAction = {
  label: string;
  pattern?: string;
  replacement?: string;
  append?: string;
};

export type GeoResolutionIssue = {
  id: string;
  kind: "blocking" | "advisory";
  title: string;
  detail: string;
  actions?: GeoResolutionAction[];
};

const LEGACY_IDS: Record<string, string> = {
  kc: "kansas-city",
  "kansas-city": "kansas-city",
  la: "la",
  ny: "new-york",
  baltimore: "baltimore",
  batlimore: "baltimore",
  "st-louis": "st-louis",
  stl: "st-louis",
  "new-york": "new-york",
  washington: "washington",
  portland: "portland",
};

const ACTION_OVERRIDES: Record<string, { label: string; replacement: string; rank: number }> = {
  "city:MO:kansas-city": { label: "Kansas City, Missouri", replacement: "Kansas City, Missouri", rank: 0 },
  "city:KS:kansas-city": { label: "Kansas City, Kansas", replacement: "Kansas City, Kansas", rank: 1 },
  "city:CA:los-angeles": { label: "Los Angeles city", replacement: "Los Angeles, California", rank: 0 },
  "county:CA:los-angeles": { label: "Los Angeles County", replacement: "Los Angeles County, California", rank: 1 },
  "state:LA": { label: "Louisiana", replacement: "Louisiana", rank: 2 },
  "city:MD:baltimore-city": { label: "Baltimore city", replacement: "Baltimore city", rank: 0 },
  "county:MD:baltimore": { label: "Baltimore County", replacement: "Baltimore County, Maryland", rank: 1 },
  "city:MO:st-louis-city": { label: "St. Louis city", replacement: "St. Louis city", rank: 0 },
  "county:MO:st-louis": { label: "St. Louis County", replacement: "St. Louis County, Missouri", rank: 1 },
  "city:NY:new-york-city": { label: "New York City", replacement: "New York City", rank: 0 },
  "state:NY": { label: "New York State", replacement: "New York State", rank: 1 },
  "city:DC:washington": { label: "Washington, DC", replacement: "Washington, DC", rank: 0 },
  "state:WA": { label: "Washington State", replacement: "Washington State", rank: 1 },
  "city:OR:portland": { label: "Portland, Oregon", replacement: "Portland, Oregon", rank: 0 },
  "city:ME:portland": { label: "Portland, Maine", replacement: "Portland, Maine", rank: 1 },
};

const DETAIL_OVERRIDES: Record<string, string> = {
  kc: "KC can mean Kansas City, Missouri or Kansas City, Kansas.",
  la: "LA can mean Los Angeles city, Los Angeles County, or Louisiana.",
  ny: "NY can mean New York City or New York State.",
  "kansas-city": "Kansas City can mean Missouri or Kansas.",
  baltimore: "Use Baltimore city or Baltimore County, Maryland so the result does not mix jurisdictions.",
  batlimore: "Use Baltimore city or Baltimore County, Maryland so the result does not mix jurisdictions.",
  "st-louis": "Use St. Louis city or St. Louis County, Missouri when asking for local results.",
  stl: "STL can mean St. Louis city or St. Louis County.",
  "new-york": "Say New York City or New York State to avoid ambiguity.",
  washington: "Say Washington, DC or Washington State when asking for geography-specific results.",
  portland: "Portland usually needs Oregon or Maine to avoid the wrong city.",
};

const STATE_LABELS: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
  DC: "District of Columbia",
};

const STATE_ABBREVIATIONS = new Set(Object.keys(STATE_LABELS));

export function getGeoResolutionIssues(input: string): GeoResolutionIssue[] {
  const text = input.trim();
  if (!text) return [];

  const allMentions = resolveGeoPlaces(text).mentions;
  return allMentions
    .map((mention) => resolveCityByStateContext(text, mention, allMentions))
    .filter((mention) => mention.requiresClarification && mention.candidates.length > 1)
    .filter((mention) => !isStateAbbreviationComparison(text, mention))
    .filter((mention) => !isCampusAgencyNameWithStateContext(text, mention))
    .filter((mention) => !hasExplicitCityCountyKindContext(text, mention))
    .map(issueFromMention);
}

/**
 * "jackson police department ... mississippi capitol police" must not ask which
 * Jackson (query-audit-2026-07-03 F24). When the surrounding text names exactly
 * one state and the ambiguous city has exactly one candidate in that state,
 * resolve to it instead of clarifying. City-kind ambiguity only — city-vs-county
 * and city-vs-state splits (Baltimore, NY, Washington) keep their clarifiers.
 * Mention spans are stripped before scanning so "Kansas City" is not read as Kansas.
 */
function resolveCityByStateContext(
  input: string,
  mention: GeoPlaceMention,
  allMentions: GeoPlaceMention[]
): GeoPlaceMention {
  if (!mention.requiresClarification || mention.candidates.length < 2) return mention;
  if (classifyCandidates(mention.candidates) !== "city") return mention;

  // Strip only ambiguous mention spans: "Kansas City" must not read as Kansas,
  // but an unambiguous "mississippi" mention is exactly the state context we want.
  const ambiguousSpans = allMentions
    .filter((m) => m.candidates.length > 1)
    .sort((a, b) => a.start - b.start);
  let remainder = "";
  let cursor = 0;
  for (const m of ambiguousSpans) {
    remainder += input.slice(cursor, m.start) + " ";
    cursor = Math.max(cursor, m.end);
  }
  remainder += input.slice(cursor);

  const states = statesMentionedIn(remainder);
  if (states.size !== 1) return mention;
  const [state] = [...states];
  const inState = mention.candidates.filter((candidate) => candidate.state === state);
  if (inState.length !== 1) return mention;

  return {
    ...mention,
    candidates: inState,
    requiresClarification: false,
    reason: `${mention.text} resolved to ${state} from state context`,
  };
}

function statesMentionedIn(input: string): Set<string> {
  const found = new Set<string>();
  for (const [abbr, label] of Object.entries(STATE_LABELS)) {
    const pattern = new RegExp(
      `\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`,
      "i"
    );
    if (pattern.test(input)) found.add(abbr);
  }
  for (const token of uppercaseStateAbbreviations(input)) found.add(token);
  return found;
}

export function hasBlockingGeoResolutionIssue(input: string): boolean {
  return getGeoResolutionIssues(input).some((issue) => issue.kind === "blocking");
}

export function geoClarificationText(issue: GeoResolutionIssue): string {
  const choices = issue.actions?.map((action) => action.label.replace(/^Use\s+/i, "")) ?? [];
  if (choices.length === 0) return issue.detail;
  return `${issue.detail} Choose: ${choices.join(" or ")}.`;
}

export function getBlockingGeoClarification(input: string): { issue: GeoResolutionIssue; explanation: string } | null {
  const issue = getGeoResolutionIssues(input).find((candidate) => candidate.kind === "blocking");
  if (!issue) return null;
  return { issue, explanation: geoClarificationText(issue) };
}

function issueFromMention(mention: GeoPlaceMention): GeoResolutionIssue {
  const candidates = mention.candidates;
  const issueKind = classifyCandidates(candidates);
  const label = displayMention(mention);
  const pattern = literalPattern(mention.text);
  return {
    id: issueId(mention, issueKind),
    kind: "blocking",
    title: titleFor(label, issueKind),
    detail: detailFor(label, candidates, issueKind),
    actions: guidanceActionCandidates(candidates, issueKind).map((candidate) => ({
      label: `Use ${actionLabel(candidate)}`,
      pattern,
      replacement: actionReplacement(candidate),
    })),
  };
}

function classifyCandidates(candidates: GeoPlaceCandidate[]): "county" | "city-county" | "city-state" | "city" | "place" {
  const kinds = new Set(candidates.map((candidate) => candidate.kind));
  if (kinds.size === 1 && kinds.has("county")) return "county";
  if (kinds.has("city") && kinds.has("county")) return "city-county";
  if (kinds.has("city") && kinds.has("state")) return "city-state";
  if (kinds.size === 1 && kinds.has("city")) return "city";
  return "place";
}

function issueId(mention: GeoPlaceMention, issueKind: ReturnType<typeof classifyCandidates>): string {
  const base = slug(displayMention(mention));
  if (issueKind === "county") return `county-${base.replace(/-county$/, "")}`;
  if (issueKind === "city-county" && LEGACY_IDS[base]) return LEGACY_IDS[base];
  if (issueKind === "city-county") return `city-county-${base}`;
  if (LEGACY_IDS[base]) return LEGACY_IDS[base];
  return base;
}

function titleFor(label: string, issueKind: ReturnType<typeof classifyCandidates>): string {
  if (slug(label) === "kc") return "KC needs a state";
  if (slug(label) === "la") return "LA is ambiguous";
  if (slug(label) === "ny") return "NY is ambiguous";
  if (slug(label) === "batlimore") return "Baltimore city and county are separate";
  if (slug(label) === "stl") return "STL city and county are separate";
  if (issueKind === "county") return `${label.replace(/\s+County$/i, "")} County needs a state`;
  if (issueKind === "city-county") return `${label} city and county are separate`;
  if (issueKind === "city-state") return `${label} is ambiguous`;
  if (issueKind === "city") return `${label} needs a state`;
  return `${label} needs clarification`;
}

function detailFor(label: string, candidates: GeoPlaceCandidate[], issueKind: ReturnType<typeof classifyCandidates>): string {
  const override = DETAIL_OVERRIDES[slug(label)];
  if (override) return override;
  const choices = actionCandidates(candidates).map(actionLabel);
  if (issueKind === "county") {
    return `${label.replace(/\s+County$/i, "")} County exists in multiple states. Add the state so countywide results use the right geography.`;
  }
  if (issueKind === "city-county") {
    return `${label} can mean the city or the county. Choose one so results use the right jurisdiction.`;
  }
  if (issueKind === "city-state") {
    return `Say ${choices.join(" or ")} to avoid ambiguity.`;
  }
  if (issueKind === "city") {
    return `${label} exists in multiple states. Add the state so results use the right city.`;
  }
  return `${label} matched multiple places. Choose the intended geography.`;
}

function actionCandidates(candidates: GeoPlaceCandidate[]): GeoPlaceCandidate[] {
  return candidates
    .slice()
    .sort((a, b) => {
      const actionDelta = actionRank(a) - actionRank(b);
      if (actionDelta !== 0) return actionDelta;
      const kindDelta = kindRank(a.kind) - kindRank(b.kind);
      if (kindDelta !== 0) return kindDelta;
      // Largest places first — alphabetical order let the 8-option cap drop
      // Jackson, MS (the most likely referent) while keeping 8 smaller Jacksons
      // (query-audit-2026-07-03 F24)
      const populationDelta = (b.population ?? 0) - (a.population ?? 0);
      if (populationDelta !== 0) return populationDelta;
      return actionReplacement(a).localeCompare(actionReplacement(b));
    })
    .slice(0, 8);
}

function guidanceActionCandidates(
  candidates: GeoPlaceCandidate[],
  issueKind: ReturnType<typeof classifyCandidates>
): GeoPlaceCandidate[] {
  if (issueKind === "county" && candidates.length > 6) return [];
  return actionCandidates(candidates);
}

function actionLabel(candidate: GeoPlaceCandidate): string {
  return ACTION_OVERRIDES[candidate.id]?.label ?? friendlyCountyName(candidate) ?? candidate.canonicalQuery ?? candidate.name;
}

function actionReplacement(candidate: GeoPlaceCandidate): string {
  return ACTION_OVERRIDES[candidate.id]?.replacement ?? friendlyCountyName(candidate) ?? candidate.canonicalQuery ?? candidate.name;
}

function actionRank(candidate: GeoPlaceCandidate): number {
  return ACTION_OVERRIDES[candidate.id]?.rank ?? 100;
}

function friendlyCountyName(candidate: GeoPlaceCandidate): string | null {
  if (candidate.kind !== "county" || !candidate.state) return null;
  const countyName = candidate.name.replace(/\s+County$/i, "");
  return `${countyName} County, ${STATE_LABELS[candidate.state] ?? candidate.state}`;
}

function kindRank(kind: GeoPlaceCandidate["kind"]): number {
  if (kind === "city") return 0;
  if (kind === "county") return 1;
  if (kind === "state") return 2;
  return 3;
}

function isStateAbbreviationComparison(input: string, mention: GeoPlaceMention): boolean {
  const token = mention.text.replace(/\./g, "").trim().toUpperCase();
  if (!STATE_ABBREVIATIONS.has(token)) return false;

  const stateTokens = uppercaseStateAbbreviations(input);
  if (stateTokens.length < 2) return false;

  const hasComparisonCue = /\b(?:vs\.?|versus|compare|compared|comparison|between)\b|[,/;]/i.test(input);
  if (!hasComparisonCue) return false;

  if (token === "LA") return stateTokens.length >= 3;
  return true;
}

function isCampusAgencyNameWithStateContext(input: string, mention: GeoPlaceMention): boolean {
  if (!/\b(?:university|universities|univefrsity|univefrsities|college|campus)\s+(?:of|police|pd|department|agency)\b/i.test(input)) {
    return false;
  }
  if (!hasExplicitStateContext(input)) return false;

  const issueKind = classifyCandidates(mention.candidates);
  return issueKind === "city" || issueKind === "city-county" || issueKind === "city-state";
}

function hasExplicitCityCountyKindContext(input: string, mention: GeoPlaceMention): boolean {
  if (classifyCandidates(mention.candidates) !== "city-county") return false;

  const mentionPattern = mention.text
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");

  return new RegExp(`\\b${mentionPattern}\\s+(?:city|county)\\b`, "i").test(input) ||
    new RegExp(`\\b(?:city|county)\\s+of\\s+${mentionPattern}\\b`, "i").test(input);
}

function hasExplicitStateContext(input: string): boolean {
  for (const label of Object.values(STATE_LABELS)) {
    const pattern = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "i");
    if (pattern.test(input)) return true;
  }
  return /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/.test(input);
}

function uppercaseStateAbbreviations(input: string): string[] {
  const matches = input.match(/\b[A-Z]{2}\b/g) ?? [];
  return [...new Set(matches.filter((token) => STATE_ABBREVIATIONS.has(token)))];
}

function displayMention(mention: GeoPlaceMention): string {
  if (slug(mention.text) === "kc") return "KC";
  const candidateNames = new Set(mention.candidates.map((candidate) => candidate.name.replace(/\s+County$/i, "")));
  if (candidateNames.size === 1) return [...candidateNames][0];
  return mention.text.replace(/\s+/g, " ").trim();
}

function literalPattern(value: string): string {
  return `\\b${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bst\.?\b/g, "st")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
