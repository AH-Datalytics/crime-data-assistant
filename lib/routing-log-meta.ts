export interface RoutingLogMeta {
  confidence: string | null;
  mode: string | null;
  reason: string | null;
}

const VALID_CONFIDENCE = new Set(["high", "medium", "low"]);
const VALID_MODE = new Set(["auto", "picker", "manual", "follow_up", "rerun"]);

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

export function parseRoutingLogMeta(body: unknown): RoutingLogMeta {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const confidence = cleanString(record.routingConfidence, 32);
  const mode = cleanString(record.routingMode, 32);
  return {
    confidence: confidence && VALID_CONFIDENCE.has(confidence) ? confidence : null,
    mode: mode && VALID_MODE.has(mode) ? mode : null,
    reason: cleanString(record.routingReason, 500),
  };
}
