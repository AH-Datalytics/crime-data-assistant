import { GEO_PLACE_CATALOG, type GeoPlaceCatalogEntry, type GeoPlaceKind } from "./geo-place-catalog";

export type GeoPlaceCandidate = {
  id: string;
  kind: GeoPlaceKind;
  name: string;
  state?: string;
  canonicalQuery?: string;
  confidence: number;
  reason: string;
  source: GeoPlaceCatalogEntry["source"];
};

export type GeoPlaceMention = {
  text: string;
  start: number;
  end: number;
  candidates: GeoPlaceCandidate[];
  requiresClarification: boolean;
  reason: string;
};

export type GeoPlaceResolution = {
  input: string;
  mentions: GeoPlaceMention[];
  requiresClarification: boolean;
};

type AliasGroup = {
  alias: string;
  pattern: RegExp;
  entries: GeoPlaceCatalogEntry[];
};

type RawMatch = {
  start: number;
  end: number;
  text: string;
  alias: string;
  entries: GeoPlaceCatalogEntry[];
};

const aliasGroupCache = new WeakMap<GeoPlaceCatalogEntry[], AliasGroup[]>();

export function resolveGeoPlaces(
  input: string,
  catalog: GeoPlaceCatalogEntry[] = GEO_PLACE_CATALOG
): GeoPlaceResolution {
  const text = input.trim();
  if (!text) return { input, mentions: [], requiresClarification: false };

  const matches = findMatches(text, catalog);
  const mentions = matches.map((match) => mentionFromMatch(match));

  return {
    input,
    mentions,
    requiresClarification: mentions.some((mention) => mention.requiresClarification),
  };
}

function findMatches(input: string, catalog: GeoPlaceCatalogEntry[]): RawMatch[] {
  const groups = buildAliasGroups(catalog);
  const raw: RawMatch[] = [];

  for (const group of groups) {
    group.pattern.lastIndex = 0;
    for (let found = group.pattern.exec(input); found; found = group.pattern.exec(input)) {
      raw.push({
        start: found.index,
        end: found.index + found[0].length,
        text: found[0],
        alias: group.alias,
        entries: group.entries,
      });
    }
  }

  raw.sort((a, b) => {
    const lengthDelta = (b.end - b.start) - (a.end - a.start);
    if (lengthDelta !== 0) return lengthDelta;
    const candidateDelta = b.entries.length - a.entries.length;
    if (candidateDelta !== 0) return candidateDelta;
    return a.start - b.start;
  });

  const accepted: RawMatch[] = [];
  for (const match of raw) {
    if (accepted.some((existing) => overlaps(existing, match))) continue;
    accepted.push(match);
  }

  return accepted.sort((a, b) => a.start - b.start);
}

function buildAliasGroups(catalog: GeoPlaceCatalogEntry[]): AliasGroup[] {
  const cached = aliasGroupCache.get(catalog);
  if (cached) return cached;

  const byAlias = new Map<string, { alias: string; entries: Map<string, GeoPlaceCatalogEntry> }>();

  for (const entry of catalog) {
    for (const alias of entry.aliases) {
      const key = aliasKey(alias);
      if (!key) continue;
      const group = byAlias.get(key) ?? { alias, entries: new Map<string, GeoPlaceCatalogEntry>() };
      group.entries.set(entry.id, entry);
      byAlias.set(key, group);
    }
  }

  const groups = [...byAlias.values()]
    .map((group) => ({
      alias: group.alias,
      pattern: aliasPattern(group.alias),
      entries: [...group.entries.values()].sort(compareEntries),
    }))
    .sort((a, b) => b.alias.length - a.alias.length);
  aliasGroupCache.set(catalog, groups);
  return groups;
}

function mentionFromMatch(match: RawMatch): GeoPlaceMention {
  const candidates = match.entries.map((entry) => candidateFromEntry(entry, match));
  const requiresClarification = candidates.length > 1;
  const reason = requiresClarification
    ? `${match.text} matched ${candidates.length} possible places`
    : `${match.text} matched ${candidates[0]?.canonicalQuery ?? candidates[0]?.name}`;

  return {
    text: match.text,
    start: match.start,
    end: match.end,
    candidates,
    requiresClarification,
    reason,
  };
}

function candidateFromEntry(entry: GeoPlaceCatalogEntry, match: RawMatch): GeoPlaceCandidate {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    state: entry.state,
    canonicalQuery: entry.canonicalQuery,
    confidence: match.entries.length === 1 ? 0.95 : 0.55,
    reason: `Matched alias "${match.alias}" from ${entry.source}`,
    source: entry.source,
  };
}

function compareEntries(a: GeoPlaceCatalogEntry, b: GeoPlaceCatalogEntry): number {
  const stateCompare = (a.state ?? "").localeCompare(b.state ?? "");
  if (stateCompare !== 0) return stateCompare;
  const kindCompare = a.kind.localeCompare(b.kind);
  if (kindCompare !== 0) return kindCompare;
  return a.name.localeCompare(b.name);
}

function overlaps(a: RawMatch, b: RawMatch): boolean {
  return a.start < b.end && b.start < a.end;
}

function aliasKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function aliasPattern(alias: string): RegExp {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi");
}
