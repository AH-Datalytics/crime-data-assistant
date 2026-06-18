export type GuidanceAction = {
  label: string;
  pattern?: string;
  replacement?: string;
  append?: string;
};

export type GuidanceWarning = {
  id: string;
  kind: "blocking" | "advisory";
  title: string;
  detail: string;
  actions?: GuidanceAction[];
};

export type HowToAskExample = {
  category: string;
  question: string;
};

export const HOW_TO_ASK_EXAMPLES: HowToAskExample[] = [
  { category: "Trends", question: "murder trend from 2019 to 2025" },
  { category: "Rates", question: "violent crime rate in Texas cities of 250k or more in 2023" },
  { category: "Places", question: "fatal shootings in Kansas City, Missouri per month from 2020 to 2024" },
  { category: "Comparability", question: "New York City vs Chicago officers per year since 1930" },
  { category: "Demographics", question: "offender age breakdown for robberies since 2020" },
];

function has(pattern: RegExp, text: string) {
  return pattern.test(text);
}

function ambiguousPlace(
  text: string,
  mentioned: RegExp,
  qualified: RegExp,
  warning: GuidanceWarning
): GuidanceWarning | null {
  if (!has(mentioned, text) || has(qualified, text)) return null;
  return warning;
}

export function getQueryGuidanceWarnings(input: string): GuidanceWarning[] {
  const text = input.trim();
  if (!text) return [];

  const warnings: GuidanceWarning[] = [];

  const placeWarnings: (GuidanceWarning | null)[] = [
    ambiguousPlace(text, /\bkansas\s+city\b/i, /\b(kcmo|kck)\b|\bkansas\s+city\s*,?\s*(missouri|mo|kansas|ks)\b/i, {
      id: "kansas-city",
      kind: "blocking",
      title: "Kansas City needs a state",
      detail: "Kansas City can mean Missouri or Kansas. Spell out the state when the geography matters.",
      actions: [
        { label: "Use Kansas City, Missouri", pattern: "\\bKansas\\s+City\\b", replacement: "Kansas City, Missouri" },
        { label: "Use Kansas City, Kansas", pattern: "\\bKansas\\s+City\\b", replacement: "Kansas City, Kansas" },
      ],
    }),
    ambiguousPlace(text, /\bbaltimore\b/i, /\bbaltimore\s+(city|county)\b|\bbaltimore\s*,?\s*(md|maryland)\b/i, {
      id: "baltimore",
      kind: "blocking",
      title: "Baltimore city and county are separate",
      detail: "Use Baltimore city or Baltimore County, Maryland so the result does not mix jurisdictions.",
      actions: [
        { label: "Use Baltimore city", pattern: "\\bBaltimore\\b", replacement: "Baltimore city" },
        { label: "Use Baltimore County", pattern: "\\bBaltimore\\b", replacement: "Baltimore County, Maryland" },
      ],
    }),
    ambiguousPlace(text, /\bst\.?\s+louis\b/i, /\bst\.?\s+louis\s+(city|county)\b|\bst\.?\s+louis\s*,?\s*(mo|missouri)\b/i, {
      id: "st-louis",
      kind: "blocking",
      title: "St. Louis city and county are separate",
      detail: "Use St. Louis city or St. Louis County, Missouri when asking for local results.",
      actions: [
        { label: "Use St. Louis city", pattern: "\\bSt\\.?\\s+Louis\\b", replacement: "St. Louis city" },
        { label: "Use St. Louis County", pattern: "\\bSt\\.?\\s+Louis\\b", replacement: "St. Louis County, Missouri" },
      ],
    }),
    ambiguousPlace(text, /\bnew\s+york\b/i, /\b(new\s+york\s+city|nyc|nypd|new\s+york\s+state|state\s+of\s+new\s+york|ny\s+state)\b/i, {
      id: "new-york",
      kind: "blocking",
      title: "New York can mean city or state",
      detail: "Say New York City or New York State to avoid city/state collisions.",
      actions: [
        { label: "Use New York City", pattern: "\\bNew\\s+York\\b", replacement: "New York City" },
        { label: "Use New York State", pattern: "\\bNew\\s+York\\b", replacement: "New York State" },
      ],
    }),
    ambiguousPlace(text, /\bwashington\b/i, /\b(washington\s*,?\s*d\.?c\.?|dc|district\s+of\s+columbia|washington\s+state|state\s+of\s+washington)\b/i, {
      id: "washington",
      kind: "blocking",
      title: "Washington can mean DC or state",
      detail: "Say Washington, DC or Washington State when asking for geography-specific results.",
      actions: [
        { label: "Use Washington, DC", pattern: "\\bWashington\\b", replacement: "Washington, DC" },
        { label: "Use Washington State", pattern: "\\bWashington\\b", replacement: "Washington State" },
      ],
    }),
    ambiguousPlace(text, /\bportland\b/i, /\bportland\s*,?\s*(or|oregon|me|maine)\b/i, {
      id: "portland",
      kind: "blocking",
      title: "Portland needs a state",
      detail: "Portland usually needs Oregon or Maine to avoid the wrong city.",
      actions: [
        { label: "Use Portland, Oregon", pattern: "\\bPortland\\b", replacement: "Portland, Oregon" },
        { label: "Use Portland, Maine", pattern: "\\bPortland\\b", replacement: "Portland, Maine" },
      ],
    }),
  ];

  warnings.push(...placeWarnings.filter((w): w is GuidanceWarning => Boolean(w)));

  if (has(/\bgun\s+violence\b/i, text) && !has(/\b(fatal|nonfatal|firearm\s+(homicides?|assaults?|injur(?:y|ies)))\b/i, text)) {
    warnings.push({
      id: "gun-violence",
      kind: "advisory",
      title: "The FBI does not systemically track all shootings",
      detail: "Fatal shootings can be answered directly. Broader firearm violence measures are proxies and should be named that way.",
      actions: [
        { label: "Use fatal shootings", pattern: "\\bgun\\s+violence\\b", replacement: "fatal shootings" },
        { label: "Use firearm-involved assaults proxy", pattern: "\\bgun\\s+violence\\b", replacement: "firearm-involved assaults proxy" },
      ],
    });
  }

  if (has(/\bshootings?\b/i, text) && !has(/\b(fatal|nonfatal|firearm\s+(homicides?|assaults?|injur(?:y|ies)))\b/i, text)) {
    warnings.push({
      id: "shooting-scope",
      kind: "advisory",
      title: "The FBI does not systemically track all shootings",
      detail: "Fatal shootings can be answered directly. Broader shooting measures are proxies and should be named that way.",
      actions: [
        { label: "Use fatal shootings", pattern: "\\bshootings?\\b", replacement: "fatal shootings" },
        { label: "Use firearm-involved assaults proxy", pattern: "\\bshootings?\\b", replacement: "firearm-involved assaults proxy" },
      ],
    });
  }

  if (has(/\bassaults?\b/i, text) && !has(/\b(aggravated|simple|intimidation|sexual|domestic|dv|firearm|gun|knife|weapon)\s+assaults?\b|\bassaults?\s+(with|involving|by)\b/i, text)) {
    warnings.push({
      id: "assault-type",
      kind: "advisory",
      title: "Assault needs a type",
      detail: "NIBRS separates aggravated assault, simple assault, and intimidation. Pick one or ask for all assault categories.",
      actions: [
        { label: "All assault categories", pattern: "\\bassaults?\\b", replacement: "all assault categories" },
        { label: "Aggravated assault", pattern: "\\bassaults?\\b", replacement: "aggravated assault" },
        { label: "Simple assault", pattern: "\\bassaults?\\b", replacement: "simple assault" },
      ],
    });
  }

  if (has(/\b(consistent|continuous)\s+report(?:er|ers|ing)|\breported\s+all\s+12\s+months\b/i, text)) {
    warnings.push({
      id: "consistent-reporters",
      kind: "advisory",
      title: "Consistent reporting means 12 months",
      detail: "An agency counts as consistent for a year only if it reported all 12 months in that year.",
    });
  }

  return warnings;
}

export function hasBlockingQueryGuidanceWarnings(input: string): boolean {
  return getQueryGuidanceWarnings(input).some((warning) => warning.kind === "blocking");
}

export function applyGuidanceAction(input: string, action: GuidanceAction): string {
  const trimmed = input.trim();
  if (!trimmed) return action.replacement ?? action.append ?? input;

  let next = input;
  if (action.pattern && action.replacement) {
    const pattern = new RegExp(action.pattern, "i");
    next = input.replace(pattern, action.replacement);
  }

  if (next === input && action.append) {
    next = `${trimmed} ${action.append}`;
  }

  return next;
}
