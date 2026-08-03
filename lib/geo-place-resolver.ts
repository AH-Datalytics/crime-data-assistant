import { GEO_PLACE_CATALOG, type GeoPlaceCatalogEntry, type GeoPlaceKind } from "./geo-place-catalog";
import { fuzzyResolvePlace } from "./geo-fuzzy";

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
  let mentions = matches.map((match) => mentionFromMatch(match));

  // Typo fallback (Task 21): only when exact resolution found no place at all.
  // A confident single match resolves; an ambiguous one asks — never guesses.
  if (mentions.length === 0 && catalog === GEO_PLACE_CATALOG) {
    const fuzzy = fuzzyFallbackMention(text);
    if (fuzzy) mentions = [fuzzy];
  }

  return {
    input,
    mentions,
    requiresClarification: mentions.some((mention) => mention.requiresClarification),
  };
}

const GEO_PREPOSITIONS = new Set(["in", "for", "across", "near", "around", "within", "at", "of", "throughout"]);
const LEADING_SKIP = new Set([
  "show", "list", "give", "get", "what", "which", "how", "can", "could", "please", "tell",
  "find", "see", "display", "the", "a", "an", "me", "us", "i", "want", "whats", "wheres",
]);

type FuzzySpan = { start: number; end: number; text: string; strict: boolean };

/**
 * Preposition-anchored + place-at-start fuzzy fallback (Task 21). No broad
 * n-gram sweep: we only fuzzy-match the 1-3 words after a geo preposition and
 * the leading 1-3 words (after skipping command words). Place-at-start is the
 * higher false-positive risk, so it demands a tighter edit distance.
 */
function fuzzyFallbackMention(input: string): GeoPlaceMention | null {
  const tokens = tokenizeInput(input);
  if (tokens.length === 0) return null;
  const spans: FuzzySpan[] = [];
  const addSpan = (i: number, len: number, strict: boolean) => {
    const last = tokens[i + len - 1];
    if (!last) return;
    spans.push({ start: tokens[i].start, end: last.end, text: input.slice(tokens[i].start, last.end), strict });
  };

  for (let i = 0; i < tokens.length; i += 1) {
    if (!GEO_PREPOSITIONS.has(tokens[i].key)) continue;
    for (let len = 1; len <= 3 && i + len < tokens.length; len += 1) {
      const next = tokens[i + len];
      if (/^\d+$/.test(next.key) || GEO_PREPOSITIONS.has(next.key)) break;
      addSpan(i + 1, len, false);
    }
  }
  let startIdx = 0;
  while (startIdx < tokens.length && LEADING_SKIP.has(tokens[startIdx].key)) startIdx += 1;
  for (let len = 1; len <= 3 && startIdx + len <= tokens.length; len += 1) {
    const t = tokens[startIdx + len - 1];
    if (/^\d+$/.test(t.key) || GEO_PREPOSITIONS.has(t.key)) break;
    addSpan(startIdx, len, true);
  }

  // Rank: confident before ambiguous, then smaller edit distance, then LONGER
  // span (more specific). This stops a short sub-span ("san" -> "Man") from
  // beating the real place ("san antnio" -> "San Antonio").
  let best: { span: FuzzySpan; result: ReturnType<typeof fuzzyResolvePlace> } | null = null;
  let bestKey: [number, number, number] | null = null;
  for (const span of spans) {
    const trimmed = span.text.trim();
    if (/^\d+$/.test(trimmed)) continue;
    const result = fuzzyResolvePlace(span.text);
    if (!result.best) continue;
    const cap = span.strict ? 1 : 2; // place-at-start must be within one typo
    if (result.best.distance > cap) continue;
    // A short (<=4 char) ambiguous span is noise, not a place — skip it.
    if (!result.confident && trimmed.length <= 4) continue;
    const key: [number, number, number] = [result.confident ? 0 : 1, result.best.distance, -trimmed.length];
    const better = !bestKey || key[0] < bestKey[0] ||
      (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])));
    if (better) { best = { span, result }; bestKey = key; }
  }
  if (!best || !best.result.best) return null;

  const { span, result } = best;
  const toCandidate = (entry: GeoPlaceCatalogEntry, confidence: number, reason: string): GeoPlaceCandidate => ({
    id: entry.id, kind: entry.kind, name: entry.name, state: entry.state,
    canonicalQuery: entry.canonicalQuery, confidence, reason, source: entry.source, population: entry.dominancePopulation,
  });

  if (result.confident) {
    const e = result.best.entry;
    return {
      text: span.text, start: span.start, end: span.end,
      candidates: [toCandidate(e, 0.75, `Fuzzy match: "${span.text}" -> ${e.name}${e.state ? ", " + e.state : ""}`)],
      requiresClarification: false,
      reason: `Fuzzy-resolved "${span.text}" to ${e.name}`,
    };
  }
  if (result.needsConfirmation) {
    return {
      text: span.text, start: span.start, end: span.end,
      candidates: result.candidates.slice(0, 4).map((c) => toCandidate(c.entry, 0.5, `Possible match for "${span.text}"`)),
      requiresClarification: true,
      reason: `"${span.text}" is close to multiple places -- please confirm which you meant`,
    };
  }
  return null;
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
