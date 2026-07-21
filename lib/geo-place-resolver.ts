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
  population?: number;
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
  key: string;
  caseKey: string;
  tokenCount: number;
  requiresExactCase: boolean;
  entries: GeoPlaceCatalogEntry[];
};

type AliasIndex = {
  byLength: Map<number, Map<string, AliasGroup[]>>;
  maxTokenCount: number;
};

type InputToken = {
  key: string;
  start: number;
  end: number;
};

type RawMatch = {
  start: number;
  end: number;
  text: string;
  alias: string;
  entries: GeoPlaceCatalogEntry[];
};

const aliasIndexCache = new WeakMap<GeoPlaceCatalogEntry[], AliasIndex>();
const DOMINANT_CITY_MIN_POPULATION = 100_000;
const DOMINANT_CITY_MAX_SECONDARY_RATIO = 0.25;

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
  const index = buildAliasIndex(catalog);
  const tokens = tokenizeInput(input);
  const raw: RawMatch[] = [];
  if (tokens.length === 0) return raw;

  for (let start = 0; start < tokens.length; start += 1) {
    const maxLength = Math.min(index.maxTokenCount, tokens.length - start);
    const parts: string[] = [];
    for (let length = 1; length <= maxLength; length += 1) {
      parts.push(tokens[start + length - 1].key);
      const byKey = index.byLength.get(length);
      if (!byKey) continue;
      const groups = byKey.get(parts.join(" "));
      if (!groups) continue;

      const endToken = tokens[start + length - 1];
      const text = input.slice(tokens[start].start, endToken.end);
      const caseKey = aliasCaseKey(text);
      for (const group of groups) {
        if (group.requiresExactCase && group.caseKey !== caseKey) continue;
        raw.push({
          start: tokens[start].start,
          end: endToken.end,
          text,
          alias: group.alias,
          entries: group.entries,
        });
      }
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

function buildAliasIndex(catalog: GeoPlaceCatalogEntry[]): AliasIndex {
  const cached = aliasIndexCache.get(catalog);
  if (cached) return cached;

  const byAlias = new Map<string, {
    alias: string;
    key: string;
    caseKey: string;
    tokenCount: number;
    requiresExactCase: boolean;
    entries: Map<string, GeoPlaceCatalogEntry>;
  }>();

  for (const entry of catalog) {
    for (const alias of entry.aliases) {
      const key = aliasKey(alias);
      if (!key) continue;
      const tokenCount = key.split(" ").length;
      const requiresExactCase = hasAmbiguousStateCodeSuffix(alias);
      const groupKey = `${tokenCount}:${key}:${requiresExactCase ? aliasCaseKey(alias) : "*"}`;
      const group = byAlias.get(groupKey) ?? {
        alias,
        key,
        caseKey: aliasCaseKey(alias),
        tokenCount,
        requiresExactCase,
        entries: new Map<string, GeoPlaceCatalogEntry>(),
      };
      group.entries.set(entry.id, entry);
      byAlias.set(groupKey, group);
    }
  }

  const groups = [...byAlias.values()].map((group): AliasGroup => ({
    alias: group.alias,
    key: group.key,
    caseKey: group.caseKey,
    tokenCount: group.tokenCount,
    requiresExactCase: group.requiresExactCase,
    entries: [...group.entries.values()].sort(compareEntries),
  }));

  const byLength = new Map<number, Map<string, AliasGroup[]>>();
  let maxTokenCount = 0;
  for (const group of groups) {
    maxTokenCount = Math.max(maxTokenCount, group.tokenCount);
    const byKey = byLength.get(group.tokenCount) ?? new Map<string, AliasGroup[]>();
    const list = byKey.get(group.key) ?? [];
    list.push(group);
    byKey.set(group.key, list);
    byLength.set(group.tokenCount, byKey);
  }

  const index = { byLength, maxTokenCount };
  aliasIndexCache.set(catalog, index);
  return index;
}

function tokenizeInput(input: string): InputToken[] {
  const tokens: InputToken[] = [];
  const pattern = /(?:[A-Za-z]\.){2,}|[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const key = aliasKey(match[0]);
    if (!key) continue;
    tokens.push({ key, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function mentionFromMatch(match: RawMatch): GeoPlaceMention {
  const entries = applyBareCityDominance(match);
  const candidates = entries.map((entry) => candidateFromEntry(entry, match, entries.length));
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

function applyBareCityDominance(match: RawMatch): GeoPlaceCatalogEntry[] {
  if (match.entries.length <= 1 || !isBareGeneratedCityGroup(match)) return match.entries;

  const ranked = [...match.entries].sort(
    (a, b) => (b.dominancePopulation ?? 0) - (a.dominancePopulation ?? 0)
  );
  const top = ranked[0];
  if (!top.dominancePopulation || top.dominancePopulation < DOMINANT_CITY_MIN_POPULATION) {
    return match.entries;
  }
  if (ranked.some((entry) => !entry.dominancePopulation)) return match.entries;

  const threshold = top.dominancePopulation * DOMINANT_CITY_MAX_SECONDARY_RATIO;
  const hasPlausiblePeer = ranked.slice(1).some((entry) => (entry.dominancePopulation ?? 0) >= threshold);
  return hasPlausiblePeer ? match.entries : [top];
}

function isBareGeneratedCityGroup(match: RawMatch): boolean {
  return match.entries.every((entry) =>
    entry.kind === "city" &&
    entry.source === "generated-city" &&
    aliasKey(match.alias) === aliasKey(entry.name)
  );
}

function candidateFromEntry(entry: GeoPlaceCatalogEntry, match: RawMatch, candidateCount: number): GeoPlaceCandidate {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    state: entry.state,
    canonicalQuery: entry.canonicalQuery,
    confidence: candidateCount === 1 ? 0.95 : 0.55,
    reason: `Matched alias "${match.alias}" from ${entry.source}`,
    source: entry.source,
    population: entry.dominancePopulation,
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
  return value
    .replace(/\./g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function aliasCaseKey(value: string): string {
  return value
    .replace(/\./g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAmbiguousStateCodeSuffix(alias: string): boolean {
  return /(?:^|[\s,])(?:IN|OR)$/u.test(alias);
}
