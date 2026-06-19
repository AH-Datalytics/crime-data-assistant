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
  "kansas-city": "kansas-city",
  baltimore: "baltimore",
  "st-louis": "st-louis",
  "new-york": "new-york",
  washington: "washington",
  portland: "portland",
};

const ACTION_OVERRIDES: Record<string, { label: string; replacement: string; rank: number }> = {
  "city:MO:kansas-city": { label: "Kansas City, Missouri", replacement: "Kansas City, Missouri", rank: 0 },
  "city:KS:kansas-city": { label: "Kansas City, Kansas", replacement: "Kansas City, Kansas", rank: 1 },
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
  "kansas-city": "Kansas City can mean Missouri or Kansas.",
  baltimore: "Use Baltimore city or Baltimore County, Maryland so the result does not mix jurisdictions.",
  "st-louis": "Use St. Louis city or St. Louis County, Missouri when asking for local results.",
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

export function getGeoResolutionIssues(input: string): GeoResolutionIssue[] {
  const text = input.trim();
  if (!text) return [];

  return resolveGeoPlaces(text).mentions
    .filter((mention) => mention.requiresClarification && mention.candidates.length > 1)
    .map(issueFromMention);
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

function displayMention(mention: GeoPlaceMention): string {
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
