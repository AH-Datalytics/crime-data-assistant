const UNSUPPORTED_AVAILABILITY_CLAIM = /\b(?:not in|not included in|not found in|doesn\'t appear in|isn\'t in)\s+(?:our|the|this)?\s*(?:dataset|data|sample|library)\b/i;

export function neutralizeUnverifiedAvailabilityClaim(explanation: string, source: string): string {
  if (!UNSUPPORTED_AVAILABILITY_CLAIM.test(explanation || "")) return explanation;
  return "I couldn\'t verify that the requested data is unavailable because no database query was generated. I wasn\'t able to produce a valid " + source + " query for this request. Please try again or specify the place, offense, and date range.";
}

export function buildNoSqlFallbackMessage(source: string): string {
  const label = source === "hate_crime" ? "hate-crime" : source === "shr" ? "homicide" : source === "nibrs" ? "NIBRS" : source === "current" ? "Current Trends" : "Historical Library";
  return "I could not generate a database query for that request in the " + label + " source. Please restate it with the place, offense, and date range you want.";
}
