export type ShrAgencyType = "City" | "County" | "Other";

export interface ShrAgencyIdentityInput {
  ori: string;
  state: string;
  sourceNames: string[];
  sourceTypes: string[];
  nibrsCity?: string | null;
  nibrsAgencyType?: string | null;
  incidentCount: number;
  firstYear: number;
  lastYear: number;
}

export interface ShrAgencyIdentity {
  ori: string;
  state: string;
  canonicalAgency: string;
  agencyType: ShrAgencyType;
  searchKey: string;
  aliases: string[];
}

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bPOL\s+DEP\b/gi, "Police Department"],
  [/\bPOL\s+DEPT\b/gi, "Police Department"],
  [/\bPD\b/g, "Police Department"],
  [/\bSHERIFF'?S?\s+OFC\b/gi, "Sheriff's Office"],
  [/\bSHERIFF'?S?\s+OFF\b/gi, "Sheriff's Office"],
  [/\bSO\b/g, "Sheriff's Office"],
];

const LOWER_WORDS = new Set(["and", "of", "the"]);

function titleWord(word: string): string {
  if (!word) return word;
  if (/^[IVX]+$/i.test(word)) return word.toUpperCase();
  if (/^st$/i.test(word)) return "St.";
  if (/^mc[a-z]/i.test(word)) return `Mc${word.slice(2, 3).toUpperCase()}${word.slice(3).toLowerCase()}`;
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function titleCase(value: string): string {
  return value
    .split(/(\s+|-)/)
    .map((part, index) => {
      if (/^\s+$|^-$/u.test(part)) return part;
      const lower = part.toLowerCase();
      if (index > 0 && LOWER_WORDS.has(lower)) return lower;
      return titleWord(part);
    })
    .join("");
}

export function canonicalizeShrAgencyName(value: string): string {
  let out = (value || "").trim().replace(/\s+/g, " ");
  for (const [pattern, replacement] of ABBREVIATIONS) {
    out = out.replace(pattern, replacement);
  }
  out = out
    .replace(/\bPOLICE DEPARTMENT\b/gi, "Police Department")
    .replace(/\bPOLICE DEPT\.?\b/gi, "Police Department")
    .replace(/\bSHERIFF'?S OFFICE\b/gi, "Sheriff's Office")
    .replace(/\bSHERIFF OFFICE\b/gi, "Sheriff's Office")
    .replace(/\bCOUNTY POLICE DEPARTMENT\b/gi, "County Police Department")
    .replace(/\s+/g, " ")
    .trim();
  return titleCase(out).replace(/,\s*([A-Za-z]{2})$/, (_match, state: string) => `, ${state.toUpperCase()}`);
}

export function agencySearchKey(value: string): string {
  return canonicalizeShrAgencyName(value)
    .replace(/\bSaint\b/gi, "St")
    .replace(/\bSt\./gi, "St")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function agencyDisplayOverride(value: string): string | null {
  const key = agencySearchKey(value);
  if (/^CHARLOTTE(?:\s+MECKLENBURG)?(?:\s+POLICE\s+DEPARTMENT)?$/.test(key)) {
    return "Charlotte";
  }
  if (/^ST\s+LOUIS(?:\s+METROPOLITAN(?:\s+POLICE\s+DEPARTMENT)?)?$/.test(key)) {
    return "St. Louis";
  }
  if (/^ST\s+LOUIS\s+COUNTY(?:\s+POLICE\s+DEPARTMENT)?$/.test(key)) {
    return "St. Louis County";
  }
  if (/^(METROPOLITAN NASHVILLE|NASHVILLE METROPOLITAN)(?:\s+P|\s+POLICE\s+DEPARTMENT)?$/.test(key)) {
    return "Nashville";
  }
  if (/^LAS VEGAS METROPOLITAN(?:\s+POLICE\s+DEPARTMENT)?$/.test(key)) {
    return "Las Vegas";
  }
  if (/^LOUISVILLE(?:\s+JEFFERSON\s+COUNTY)?\s+METRO(?:\s+POLICE\s+DEPARTMENT)?$/.test(key)) {
    return "Louisville";
  }
  return null;
}

export function displayShrAgencyName(value: string): string {
  return agencyDisplayOverride(value) || canonicalizeShrAgencyName(value);
}

export function normalizeShrAgencyText(value: string): string {
  return (value || "")
    .replace(/\bCHARLOTTE[- ]MECKLENBURG(?: POLICE DEPARTMENT)?\b/gi, "Charlotte")
    .replace(/\bSAINT LOUIS\b/gi, "St. Louis")
    .replace(/\bST\.?\s+LOUIS\s+METROPOLITAN(?: POLICE DEPARTMENT)?\b/gi, "St. Louis")
    .replace(/\bST\.?\s+LOUIS\s+COUNTY(?: POLICE DEPARTMENT)?\b/gi, "St. Louis County")
    .replace(/\bMETROPOLITAN NASHVILLE P(?:OLICE DEPARTMENT)?\b/gi, "Nashville")
    .replace(/\bMETROPOLITAN NASHVILLE POLICE DEPARTMENT\b/gi, "Nashville")
    .replace(/\bNASHVILLE METROPOLITAN POLICE DEPARTMENT\b/gi, "Nashville")
    .replace(/\bLAS VEGAS METROPOLITAN POLICE DEPARTMENT\b/gi, "Las Vegas")
    .replace(/\bLOUISVILLE(?: JEFFERSON COUNTY)? METRO POLICE DEPARTMENT\b/gi, "Louisville");
}

function stripAgencyDescriptor(value: string): string {
  return canonicalizeShrAgencyName(value)
    .replace(/\bCounty Police Department\b/gi, "County")
    .replace(/\bPolice Department\b/gi, "")
    .replace(/\bSheriff'?s Office\b/gi, "")
    .replace(/\bDepartment\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stVariants(value: string): string[] {
  const variants = new Set<string>([value]);
  if (/\bSt\.?\b/i.test(value)) {
    variants.add(value.replace(/\bSt\.?\s+/gi, "Saint "));
  }
  if (/\bSaint\b/i.test(value)) {
    variants.add(value.replace(/\bSaint\b/gi, "St."));
  }
  return [...variants];
}

export function inferShrAgencyType(name: string, sourceTypes: string[] = [], nibrsAgencyType?: string | null): ShrAgencyType {
  const explicit = sourceTypes
    .map((t) => canonicalizeShrAgencyName(t || ""))
    .find((t) => t === "City" || t === "County");
  if (explicit === "City" || explicit === "County") return explicit;

  const nibrsType = canonicalizeShrAgencyName(nibrsAgencyType || "");
  if (nibrsType === "City" || nibrsType === "County") return nibrsType;

  const key = agencySearchKey(name);
  if (/\b(COUNTY|PARISH|SHERIFF|COUNTY POLICE)\b/.test(key)) return "County";
  if (/\b(UNIVERSITY|COLLEGE|AIRPORT|TRANSIT|PORT AUTHORITY|STATE POLICE|HIGHWAY PATROL|STATE PATROL|FEDERAL|TRIBAL)\b/.test(key)) return "Other";
  return "City";
}

export function buildShrAgencyAliases(canonicalAgency: string, sourceNames: string[] = []): string[] {
  const aliases = new Set<string>();
  for (const raw of [canonicalAgency, ...sourceNames]) {
    const canonical = canonicalizeShrAgencyName(raw || "");
    if (!canonical) continue;
    for (const variant of stVariants(canonical)) aliases.add(variant);

    const stripped = stripAgencyDescriptor(canonical);
    if (stripped && stripped !== canonical) {
      for (const variant of stVariants(stripped)) aliases.add(variant);
    }
  }
  return [...aliases].sort((a, b) => a.localeCompare(b));
}

export function buildShrAgencyIdentity(input: ShrAgencyIdentityInput): ShrAgencyIdentity {
  const sourceNames = input.sourceNames.map(canonicalizeShrAgencyName).filter(Boolean);
  const canonicalAgency = sourceNames[0] || canonicalizeShrAgencyName(input.nibrsCity || "") || input.ori;
  const agencyType = inferShrAgencyType(canonicalAgency, input.sourceTypes, input.nibrsAgencyType);
  return {
    ori: input.ori,
    state: input.state.toUpperCase(),
    canonicalAgency,
    agencyType,
    searchKey: agencySearchKey(canonicalAgency),
    aliases: buildShrAgencyAliases(canonicalAgency, sourceNames),
  };
}
