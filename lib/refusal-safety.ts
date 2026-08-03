const UNSUPPORTED_AVAILABILITY_CLAIM = /\b(?:not in|not included in|not found in|doesn\'t appear in|isn\'t in)\s+(?:our|the|this)?\s*(?:dataset|data|sample|library)\b/i;

export function neutralizeUnverifiedAvailabilityClaim(explanation: string, source: string): string {
  if (!UNSUPPORTED_AVAILABILITY_CLAIM.test(explanation || "")) return explanation;
  return "I couldn\'t verify that the requested data is unavailable because no database query was generated. I wasn\'t able to produce a valid " + source + " query for this request. Please try again or specify the place, offense, and date range.";
}
