import { explicitStateIntent } from "./explicit-state-intent";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { STATE_NAME_TO_ABBR } from "./state-population";

export type ShootingCityIntent = {
  agency: string;
  display: string;
  state?: string;
  agencyLike?: string;
};

export function displayPlace(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => /^(of|and|the)$/i.test(part) ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function stateMention(question: string): string | null {
  const explicit = explicitStateIntent(question);
  if (explicit) return explicit.state;

  const abbr = question.match(/\b([A-Z]{2})\b/);
  if (abbr) return abbr[1];

  for (const [name, state] of Object.entries(STATE_NAME_TO_ABBR)) {
    if (state === "US") continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(question)) return state;
  }
  return null;
}

export function shootingCityIntents(question: string): ShootingCityIntent[] {
  const aliases: (ShootingCityIntent & { pattern: RegExp; state: string })[] = [
    { pattern: /\b(?:KCMO|Kansas City,\s*MO|Kansas City,?\s+Missouri)\b/i, agency: "Kansas City", display: "Kansas City, MO", state: "MO" },
    { pattern: /\b(?:KCK|Kansas City,\s*KS|Kansas City,?\s+Kansas)\b/i, agency: "Kansas City", display: "Kansas City, KS", state: "KS" },
    { pattern: /\b(?:NYC|NYPD|New York City)\b/i, agency: "New York", display: "New York City", state: "NY" },
    { pattern: /\b(?:LAPD|Los Angeles)\b/i, agency: "Los Angeles", display: "Los Angeles", state: "CA" },
    { pattern: /\b(?:CPD|Chicago)\b/i, agency: "Chicago", display: "Chicago", state: "IL" },
    { pattern: /\b(?:Charlotte|Charlotte-Mecklenburg|CMPD)(?:,?\s+(?:NC|North Carolina))?\b/i, agency: "Charlotte-Mecklenburg", agencyLike: "CHARLOTTE%MECKLENBURG%", display: "Charlotte", state: "NC" },
    { pattern: /\b(?:St\.?\s*Louis|Saint Louis|STL)\s+city\b|\b(?:St\.?\s*Louis|Saint Louis),?\s+(?:MO|Missouri)\b/i, agency: "St. Louis", agencyLike: "ST%LOUIS%", display: "St. Louis city", state: "MO" },
    { pattern: /\bNashville(?:,?\s+(?:TN|Tennessee))?\b/i, agency: "Metropolitan Nashville", agencyLike: "METROPOLITAN NASHVILLE%", display: "Nashville", state: "TN" },
    { pattern: /\bLas Vegas(?:,?\s+(?:NV|Nevada))?\b/i, agency: "Las Vegas Metropolitan", agencyLike: "LAS VEGAS METROPOLITAN%", display: "Las Vegas", state: "NV" },
    { pattern: /\bLouisville(?:,?\s+(?:KY|Kentucky))?\b/i, agency: "Louisville Metro", agencyLike: "LOUISVILLE%METRO%", display: "Louisville", state: "KY" },
  ];
  const hits: ShootingCityIntent[] = [];
  for (const alias of aliases) {
    if (alias.pattern.test(question)) {
      hits.push({ agency: alias.agency, agencyLike: alias.agencyLike, display: alias.display, state: alias.state });
    }
  }
  if (hits.length > 0) {
    return hits.filter((hit, index, all) =>
      all.findIndex((other) => other.agency === hit.agency && other.state === hit.state) === index
    );
  }

  const resolution = resolveGeoPlaces(question);
  if (!resolution.requiresClarification) {
    const cityIntents = resolution.mentions
      .map((mention) => mention.candidates[0])
      .filter((candidate) => candidate?.kind === "city" && candidate.state)
      .map((candidate) => ({ agency: candidate.name, display: displayPlace(candidate.name), state: candidate.state }));
    if (cityIntents.length > 0) {
      return cityIntents.filter((hit, index, all) =>
        all.findIndex((other) => other.agency === hit.agency && other.state === hit.state) === index
      );
    }
  }

  const match = question.match(/\b(?:in|for|from|within|across)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3})(?:,\s*([A-Z]{2}))?\b/);
  if (!match) return [];
  const raw = match[1].trim();
  if (/^(County|Parish|Borough|State|January|February|March|April|May|June|July|August|September|October|November|December)$/i.test(raw)) {
    return [];
  }
  if (stateMention(raw) || explicitStateIntent(`${raw} State`)) return [];
  const state = match[2] || stateMention(question) || undefined;
  return [{ agency: raw, display: displayPlace(raw), state }];
}

export function shootingYearIntent(question: string): { clause: string; label: string; explanation: string } {
  const between = question.match(/\b(?:between|from)\s+((?:19|20)\d{2})\s+(?:and|to|through|-)\s+((?:19|20)\d{2})\b/i) ||
    question.match(/\b((?:19|20)\d{2})\s*(?:-|to|through)\s*((?:19|20)\d{2})\b/i);
  if (between) {
    const start = Math.min(Number(between[1]), Number(between[2]));
    const end = Math.max(Number(between[1]), Number(between[2]));
    return {
      clause: `i.year BETWEEN ${start} AND ${end}`,
      label: `${start}-${end}`,
      explanation: `from ${start} to ${end}`,
    };
  }

  const since = question.match(/\b(?:since|starting(?:\s+in)?|beginning(?:\s+in)?|from)\s+((?:19|20)\d{2})\b/i);
  if (since) {
    const start = Number(since[1]);
    return {
      clause: `i.year >= ${start}`,
      label: `${start}-Present`,
      explanation: `since ${start}`,
    };
  }

  const exact = question.match(/\b(?:in|during|for)\s+((?:19|20)\d{2})\b/i) || question.match(/\b((?:19|20)\d{2})\b/);
  if (exact) {
    const year = Number(exact[1]);
    return {
      clause: `i.year = ${year}`,
      label: String(year),
      explanation: `in ${year}`,
    };
  }

  return {
    clause: "i.year >= 2000",
    label: "2000-Present",
    explanation: "since 2000",
  };
}