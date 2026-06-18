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
