import { GENERATED_AMBIGUOUS_COUNTIES } from "./generated/ambiguous-counties";

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

type KnownTrap = {
  mentioned: RegExp;
  qualified: RegExp;
  issue: GeoResolutionIssue;
};

const STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
  "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york",
  "north carolina", "north dakota", "ohio", "oklahoma", "oregon",
  "pennsylvania", "rhode island", "south carolina", "south dakota",
  "tennessee", "texas", "utah", "vermont", "virginia", "washington",
  "west virginia", "wisconsin", "wyoming", "district of columbia",
];

const STATE_ABBREVIATIONS = [
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id",
  "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
  "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
  "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
  "wi", "wy", "dc", "d.c.",
];

const STATE_NAME_PATTERN = STATE_NAMES
  .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
  .sort((a, b) => b.length - a.length)
  .join("|");

const STATE_ABBREVIATION_PATTERN = STATE_ABBREVIATIONS
  .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .sort((a, b) => b.length - a.length)
  .join("|");

const DIRECT_STATE_ABBREVIATION_PATTERN = STATE_ABBREVIATIONS
  .filter((value) => !["in", "or"].includes(value))
  .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .sort((a, b) => b.length - a.length)
  .join("|");

function literalPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}

type AmbiguousCountyTrap = {
  name: string;
  states: string[];
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

function stateLabel(code: string) {
  return STATE_LABELS[code.toUpperCase()] ?? code;
}

function countyTrap({ name: countyName, states }: AmbiguousCountyTrap): KnownTrap {
  const name = literalPattern(countyName);
  const countyPhrase = `${name}\\s+County`;
  const stateQualifier = [
    `\\s*,\\s*(?:${STATE_NAME_PATTERN}|${STATE_ABBREVIATION_PATTERN})`,
    `\\s+(?:in|of)\\s+(?:${STATE_NAME_PATTERN}|${STATE_ABBREVIATION_PATTERN})`,
    `\\s+(?:${STATE_NAME_PATTERN}|${DIRECT_STATE_ABBREVIATION_PATTERN})`,
  ].join("|");
  const qualified = new RegExp(`\\b${countyPhrase}\\b(?:${stateQualifier})\\b`, "i");
  const actionStates = states.length <= 6 ? states.map(stateLabel) : [];
  const actions = actionStates.length > 0
    ? actionStates.map((state) => ({
      label: `Use ${countyName} County, ${state}`,
      pattern: `\\b${countyName}\\s+County\\b`,
      replacement: `${countyName} County, ${state}`,
    }))
    : undefined;
  return {
    mentioned: new RegExp(`\\b${countyPhrase}\\b`, "i"),
    qualified,
    issue: {
      id: `county-${countyName.toLowerCase().replace(/\s+/g, "-")}`,
      kind: "blocking",
      title: `${countyName} County needs a state`,
      detail: `${countyName} County exists in multiple states. Add the state so countywide results use the right geography.`,
      actions,
    },
  };
}

const KNOWN_GEO_TRAPS: KnownTrap[] = [
  {
    mentioned: /\bkansas\s+city\b/i,
    qualified: /\b(kcmo|kck)\b|\bkansas\s+city\s*,?\s*(missouri|mo|kansas|ks)\b/i,
    issue: {
      id: "kansas-city",
      kind: "blocking",
      title: "Kansas City needs a state",
      detail: "Kansas City can mean Missouri or Kansas. Spell out the state when the geography matters.",
      actions: [
        { label: "Use Kansas City, Missouri", pattern: "\\bKansas\\s+City\\b", replacement: "Kansas City, Missouri" },
        { label: "Use Kansas City, Kansas", pattern: "\\bKansas\\s+City\\b", replacement: "Kansas City, Kansas" },
      ],
    },
  },
  {
    mentioned: /\bbaltimore\b/i,
    qualified: /\bbaltimore\s+(city|county)\b|\bbaltimore\s*,?\s*(md|maryland)\b/i,
    issue: {
      id: "baltimore",
      kind: "blocking",
      title: "Baltimore city and county are separate",
      detail: "Use Baltimore city or Baltimore County, Maryland so the result does not mix jurisdictions.",
      actions: [
        { label: "Use Baltimore city", pattern: "\\bBaltimore\\b", replacement: "Baltimore city" },
        { label: "Use Baltimore County", pattern: "\\bBaltimore\\b", replacement: "Baltimore County, Maryland" },
      ],
    },
  },
  {
    mentioned: /\bst\.?\s+louis\b/i,
    qualified: /\bst\.?\s+louis\s+(city|county)\b|\bst\.?\s+louis\s*,?\s*(mo|missouri)\b/i,
    issue: {
      id: "st-louis",
      kind: "blocking",
      title: "St. Louis city and county are separate",
      detail: "Use St. Louis city or St. Louis County, Missouri when asking for local results.",
      actions: [
        { label: "Use St. Louis city", pattern: "\\bSt\\.?\\s+Louis\\b", replacement: "St. Louis city" },
        { label: "Use St. Louis County", pattern: "\\bSt\\.?\\s+Louis\\b", replacement: "St. Louis County, Missouri" },
      ],
    },
  },
  {
    mentioned: /\bnew\s+york\b/i,
    qualified: /\b(new\s+york\s+city|nyc|nypd|new\s+york\s+state|state\s+of\s+new\s+york|ny\s+state|new\s+york\s+(?:county|parish|borough))\b/i,
    issue: {
      id: "new-york",
      kind: "blocking",
      title: "New York can mean city or state",
      detail: "Say New York City or New York State to avoid city/state collisions.",
      actions: [
        { label: "Use New York City", pattern: "\\bNew\\s+York\\b", replacement: "New York City" },
        { label: "Use New York State", pattern: "\\bNew\\s+York\\b", replacement: "New York State" },
      ],
    },
  },
  {
    mentioned: /\bwashington\b/i,
    qualified: /\b(washington\s*,?\s*d\.?c\.?|dc|district\s+of\s+columbia|washington\s+state|state\s+of\s+washington|washington\s+(?:county|parish|borough))\b/i,
    issue: {
      id: "washington",
      kind: "blocking",
      title: "Washington can mean DC or state",
      detail: "Say Washington, DC or Washington State when asking for geography-specific results.",
      actions: [
        { label: "Use Washington, DC", pattern: "\\bWashington\\b", replacement: "Washington, DC" },
        { label: "Use Washington State", pattern: "\\bWashington\\b", replacement: "Washington State" },
      ],
    },
  },
  {
    mentioned: /\bportland\b/i,
    qualified: /\bportland\s*,?\s*(or|oregon|me|maine)\b/i,
    issue: {
      id: "portland",
      kind: "blocking",
      title: "Portland needs a state",
      detail: "Portland usually needs Oregon or Maine to avoid the wrong city.",
      actions: [
        { label: "Use Portland, Oregon", pattern: "\\bPortland\\b", replacement: "Portland, Oregon" },
        { label: "Use Portland, Maine", pattern: "\\bPortland\\b", replacement: "Portland, Maine" },
      ],
    },
  },
  ...GENERATED_AMBIGUOUS_COUNTIES.map(countyTrap),
];

export function getGeoResolutionIssues(input: string): GeoResolutionIssue[] {
  const text = input.trim();
  if (!text) return [];

  return KNOWN_GEO_TRAPS
    .filter((trap) => trap.mentioned.test(text) && !trap.qualified.test(text))
    .map((trap) => trap.issue);
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
