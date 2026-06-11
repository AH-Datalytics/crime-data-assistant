import { STATE_NAME_TO_ABBR } from "./state-population";

export interface ExplicitStateIntent {
  state: string;
  stateName: string;
}

const ABBR_TO_STATE_NAME = new Map(
  Object.entries(STATE_NAME_TO_ABBR).map(([name, abbr]) => [abbr, name])
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isStateAgencyRequest(question: string): boolean {
  return /\bstate\s+(?:police|patrol|troopers?|highway patrol|bureau|agency|agencies)\b/i.test(question);
}

export function explicitStateIntent(question: string): ExplicitStateIntent | null {
  if (isStateAgencyRequest(question)) return null;

  for (const [stateName, abbr] of Object.entries(STATE_NAME_TO_ABBR)) {
    if (abbr === "US") continue;
    const name = escapeRegExp(stateName);
    const abbrRe = escapeRegExp(abbr);
    const patterns = [
      new RegExp(`\\b${name}\\s+State\\b`, "i"),
      new RegExp(`\\bState\\s+of\\s+${name}\\b`, "i"),
      new RegExp(`\\b${name}\\s+statewide\\b`, "i"),
      new RegExp(`\\bstatewide\\s+(?:in|for|across)\\s+${name}\\b`, "i"),
      new RegExp(`\\b${abbrRe}\\s+State\\b`),
      new RegExp(`\\bstatewide\\s+(?:in|for|across)\\s+${abbrRe}\\b`),
    ];
    if (patterns.some((pattern) => pattern.test(question))) {
      return { state: abbr, stateName };
    }
  }

  return null;
}

export function asksForSubstateEntities(question: string): boolean {
  if (isStateAgencyRequest(question)) return true;
  return /\b(?:top|rank(?:ing)?|highest|lowest|most|least|which|what)\s+(?:\d+\s+)?(?:cities|city|agencies|agency|departments|counties|county|sheriffs?|police departments?)\b/i.test(question) ||
    /\bby\s+(?:city|agency|department|county|sheriff)\b/i.test(question) ||
    /\b(?:city|agency|department|county|sheriff)[-\s]?level\b/i.test(question) ||
    /\b(?:New York City|NYC|Washington,\s*D\.?C\.?|Washington DC|D\.?C\.|Los Angeles|Chicago)\b/i.test(question);
}

export function sqlNarrowsToSubstateEntity(sql: string): boolean {
  return /\b(?:\w+\.)?(?:agency|city|agency_name)\s*(?:=|LIKE|IN\s*\()/i.test(sql) ||
    /\b(?:\w+\.)?ori\s*(?:=|IN\s*\()/i.test(sql) ||
    /\b(?:\w+\.)?type\s*=\s*'(?:City|County)'/i.test(sql) ||
    /\b(?:\w+\.)?agency_type\s*=\s*'(?:City|County)'/i.test(sql);
}

export function explicitStateSubstateMismatch(question: string, sql: string): ExplicitStateIntent | null {
  const intent = explicitStateIntent(question);
  if (!intent || asksForSubstateEntities(question)) return null;
  return sqlNarrowsToSubstateEntity(sql) ? intent : null;
}

export function filteredEntityLabel(sql: string): string | null {
  const match = sql.match(/\b(?:\w+\.)?(agency|city|agency_name)\s*=\s*'([^']+)'/i);
  if (!match) return null;
  const kind = match[1].replace("_name", "");
  return `${kind} ${match[2]}`;
}

export function stateNameForAbbr(abbr: string): string | null {
  return ABBR_TO_STATE_NAME.get(abbr.toUpperCase()) || null;
}
