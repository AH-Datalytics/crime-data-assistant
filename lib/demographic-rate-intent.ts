import { resolveGeoPlaces } from "./geo-place-resolver";

const DEMOGRAPHIC_TOKEN_RE =
  /\b(?:race|racial|ethnicit\w+|hispanic|latino\w*|sex|gender|female|male|women|men|black|white|asian|native|american\s+indian|age|juvenile\w*|teen\w*|minor|demographic)\b/i;

export function demographicIntentText(question: string): string {
  const mentions = resolveGeoPlaces(question).mentions;
  let normalized = question;
  for (const mention of [...mentions].sort((a, b) => b.start - a.start)) {
    normalized = normalized.slice(0, mention.start) + " " + normalized.slice(mention.end);
  }
  return normalized.replace(/\bsex\s+(?:offenses?|crimes?)\b/gi, " ");
}

export function mentionsDemographicRateGroup(question: string): boolean {
  const normalized = demographicIntentText(question);
  if (!DEMOGRAPHIC_TOKEN_RE.test(normalized)) return false;

  return /\b(?:by|for|among)\s+(?:race|racial\s+group|sex|gender|ethnicity|ethnic\s+group|age(?:\s+group)?)\b/i.test(normalized) ||
    /\b(?:among|for|of)\s+(?:female|male|women|men|black|white|hispanic|latino|asian|native|american\s+indian|juvenile|teen|minor)(?:\s+(?:people|persons|residents|victims|offenders|arrestees))?\b/i.test(normalized) ||
    /\b(?:juvenile|female|male|women|men|black|white|hispanic|latino|asian|native)\s+(?:crime|offense|victim|offender|arrest|homicide|murder)\s+rates?\b/i.test(normalized);
}
