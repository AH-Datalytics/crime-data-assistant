import { GENERATED_AMBIGUOUS_COUNTIES } from "./generated/ambiguous-counties";
import type { GeoResolutionIssue } from "./geo-resolver";

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
  .map((value) => escapePattern(value).replace(/\s+/g, "\\s+"))
  .sort((a, b) => b.length - a.length)
  .join("|");

const STATE_ABBREVIATION_PATTERN = STATE_ABBREVIATIONS
  .map(escapePattern)
  .sort((a, b) => b.length - a.length)
  .join("|");

const DIRECT_STATE_ABBREVIATION_PATTERN = STATE_ABBREVIATIONS
  .filter((value) => !["in", "or"].includes(value))
  .map(escapePattern)
  .sort((a, b) => b.length - a.length)
  .join("|");

const STATE_LABELS: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

const KNOWN_GEO_TRAPS: KnownTrap[] = [
  trap("kansas-city", /\bkansas\s+city\b/i, /\b(kcmo|kck)\b|\bkansas\s+city\s*,?\s*(missouri|mo|kansas|ks)\b/i, "Kansas City needs a state", "Kansas City can mean Missouri or Kansas.", [
    ["Use Kansas City, Missouri", "\\bKansas\\s+City\\b", "Kansas City, Missouri"],
    ["Use Kansas City, Kansas", "\\bKansas\\s+City\\b", "Kansas City, Kansas"],
  ]),
  trap("baltimore", /\bbaltimore\b/i, /\bbaltimore\s+(city|county)\b|\bbaltimore\s*,?\s*(md|maryland)\b/i, "Baltimore city and county are separate", "Use Baltimore city or Baltimore County, Maryland so the result does not mix jurisdictions.", [
    ["Use Baltimore city", "\\bBaltimore\\b", "Baltimore city"],
    ["Use Baltimore County", "\\bBaltimore\\b", "Baltimore County, Maryland"],
  ]),
  trap("st-louis", /\bst\.?\s+louis\b/i, /\bst\.?\s+louis\s+(city|county)\b|\bst\.?\s+louis\s*,?\s*(mo|missouri)\b/i, "St. Louis city and county are separate", "Use St. Louis city or St. Louis County, Missouri when asking for local results.", [
    ["Use St. Louis city", "\\bSt\\.?\\s+Louis\\b", "St. Louis city"],
    ["Use St. Louis County", "\\bSt\\.?\\s+Louis\\b", "St. Louis County, Missouri"],
  ]),
  trap("new-york", /\bnew\s+york\b/i, /\b(new\s+york\s+city|nyc|nypd|new\s+york\s+state|state\s+of\s+new\s+york|ny\s+state|new\s+york\s+(?:county|parish|borough))\b/i, "New York is ambiguous", "Say New York City or New York State to avoid ambiguity.", [
    ["Use New York City", "\\bNew\\s+York\\b", "New York City"],
    ["Use New York State", "\\bNew\\s+York\\b", "New York State"],
  ]),
  trap("washington", /\bwashington\b/i, /\b(washington\s*,?\s*d\.?c\.?|dc|district\s+of\s+columbia|washington\s+state|state\s+of\s+washington|washington\s+(?:county|parish|borough))\b/i, "Washington is ambiguous", "Say Washington, DC or Washington State when asking for geography-specific results.", [
    ["Use Washington, DC", "\\bWashington\\b", "Washington, DC"],
    ["Use Washington State", "\\bWashington\\b", "Washington State"],
  ]),
  trap("portland", /\bportland\b/i, /\bportland\s*,?\s*(or|oregon|me|maine)\b/i, "Portland needs a state", "Portland usually needs Oregon or Maine to avoid the wrong city.", [
    ["Use Portland, Oregon", "\\bPortland\\b", "Portland, Oregon"],
    ["Use Portland, Maine", "\\bPortland\\b", "Portland, Maine"],
  ]),
  cityCountyTrap("Alameda", "Alameda, California", "Alameda County, California"),
  cityCountyTrap("Albany", "Albany, New York", "Albany County, New York"),
  cityCountyTrap("Boise", "Boise, Idaho", "Boise County, Idaho"),
  cityCountyTrap("Fairfax", "Fairfax, Virginia", "Fairfax County, Virginia"),
  cityCountyTrap("Los Angeles", "Los Angeles, California", "Los Angeles County, California"),
  cityCountyTrap("Sacramento", "Sacramento, California", "Sacramento County, California"),
  cityCountyTrap("San Diego", "San Diego, California", "San Diego County, California"),
  cityCountyTrap("El Paso", "El Paso, Texas", "El Paso County, Texas"),
  ...GENERATED_AMBIGUOUS_COUNTIES.map(countyTrap),
];

export function getGeoGuidanceIssues(input: string): GeoResolutionIssue[] {
  const text = input.trim();
  if (!text) return [];
  return KNOWN_GEO_TRAPS
    .filter((candidate) => candidate.mentioned.test(text) && !candidate.qualified.test(text))
    .map((candidate) => candidate.issue);
}

function trap(
  id: string,
  mentioned: RegExp,
  qualified: RegExp,
  title: string,
  detail: string,
  actions: [label: string, pattern: string, replacement: string][]
): KnownTrap {
  return {
    mentioned,
    qualified,
    issue: {
      id,
      kind: "blocking",
      title,
      detail,
      actions: actions.map(([label, pattern, replacement]) => ({ label, pattern, replacement })),
    },
  };
}

function countyTrap({ name: countyName, states }: { name: string; states: string[] }): KnownTrap {
  const name = escapePattern(countyName).replace(/\s+/g, "\\s+");
  const countyPhrase = `${name}\\s+County`;
  const stateQualifier = [
    `\\s*,\\s*(?:${STATE_NAME_PATTERN}|${STATE_ABBREVIATION_PATTERN})`,
    `\\s+(?:in|of)\\s+(?:${STATE_NAME_PATTERN}|${STATE_ABBREVIATION_PATTERN})`,
    `\\s+(?:${STATE_NAME_PATTERN}|${DIRECT_STATE_ABBREVIATION_PATTERN})`,
  ].join("|");
  const actionStates = states.length <= 6 ? states.map((state) => STATE_LABELS[state.toUpperCase()] ?? state) : [];
  return {
    mentioned: new RegExp(`\\b${countyPhrase}\\b`, "i"),
    qualified: new RegExp(`\\b${countyPhrase}\\b(?:${stateQualifier})\\b`, "i"),
    issue: {
      id: `county-${countyName.toLowerCase().replace(/\s+/g, "-")}`,
      kind: "blocking",
      title: `${countyName} County needs a state`,
      detail: `${countyName} County exists in multiple states. Add the state so countywide results use the right geography.`,
      actions: actionStates.map((state) => ({
        label: `Use ${countyName} County, ${state}`,
        pattern: `\\b${countyName}\\s+County\\b`,
        replacement: `${countyName} County, ${state}`,
      })),
    },
  };
}

function cityCountyTrap(key: string, cityReplacement: string, countyReplacement: string): KnownTrap {
  const name = escapePattern(key).replace(/\s+/g, "\\s+");
  const stateQualifier = [
    `\\s*,\\s*(?:${STATE_NAME_PATTERN}|${STATE_ABBREVIATION_PATTERN})`,
    `\\s+in\\s+(?:${STATE_NAME_PATTERN}|${STATE_ABBREVIATION_PATTERN})`,
    `\\s+(?:${STATE_NAME_PATTERN}|${DIRECT_STATE_ABBREVIATION_PATTERN})`,
  ].join("|");
  return {
    mentioned: new RegExp(`\\b${name}\\b`, "i"),
    qualified: new RegExp(`\\b${name}\\b(?:\\s+(?:city|county)\\b|${stateQualifier})\\b`, "i"),
    issue: {
      id: `city-county-${key.toLowerCase().replace(/\s+/g, "-")}`,
      kind: "blocking",
      title: `${key} city and county are separate`,
      detail: `${key} can mean the city or the county. Choose one so results use the right jurisdiction.`,
      actions: [
        { label: `Use ${cityReplacement}`, pattern: `\\b${key}\\b`, replacement: cityReplacement },
        { label: `Use ${countyReplacement}`, pattern: `\\b${key}\\b`, replacement: countyReplacement },
      ],
    },
  };
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
