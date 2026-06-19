import { resolveGeoPlaces } from "./geo-place-resolver";
import { getQueryGuidanceWarnings } from "./query-guidance";

export type QueryGuidanceLogMeta = {
  status: "clear" | "resolved_geo" | "advisory" | "blocked";
  warningIds: string[];
  blockingIds: string[];
  advisoryIds: string[];
  geo: {
    requiresClarification: boolean;
    mentions: {
      text: string;
      requiresClarification: boolean;
      candidateIds: string[];
      candidateLabels: string[];
    }[];
  };
};

export function getQueryGuidanceLogMeta(input: string): QueryGuidanceLogMeta | null {
  const text = input.trim();
  if (!text) return null;

  const warnings = getQueryGuidanceWarnings(text);
  const blockingIds = warnings.filter((warning) => warning.kind === "blocking").map((warning) => warning.id);
  const advisoryIds = warnings.filter((warning) => warning.kind === "advisory").map((warning) => warning.id);
  const geoResolution = resolveGeoPlaces(text);
  const geoMentions = geoResolution.mentions.map((mention) => ({
    text: mention.text,
    requiresClarification: mention.requiresClarification,
    candidateIds: mention.candidates.map((candidate) => candidate.id),
    candidateLabels: mention.candidates.map((candidate) => candidate.canonicalQuery ?? candidate.name),
  }));

  if (warnings.length === 0 && geoMentions.length === 0) return null;

  const status = blockingIds.length > 0
    ? "blocked"
    : advisoryIds.length > 0
      ? "advisory"
      : geoMentions.length > 0
        ? "resolved_geo"
        : "clear";

  return {
    status,
    warningIds: warnings.map((warning) => warning.id),
    blockingIds,
    advisoryIds,
    geo: {
      requiresClarification: geoResolution.requiresClarification,
      mentions: geoMentions,
    },
  };
}

export function serializeQueryGuidanceLogMeta(input: string): string | null {
  const meta = getQueryGuidanceLogMeta(input);
  return meta ? JSON.stringify(meta).slice(0, 4000) : null;
}
