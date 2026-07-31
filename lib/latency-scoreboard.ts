export type LatencyRow = {
  tab: string | null;
  question: string | null;
  ms: number | null;
  session_id: string | null;
};

export type LatencyStats = {
  total: number;
  slow: number;
  slowRate: number;
  p50: number;
  p95: number;
  max: number;
};

const INTERNAL_SESSION = /(?:live-replay|codex|deploy-smoke|targeted-probe|layer3|canary|scoreboard|benchmark|eval)/i;

export function isProductionTraffic(row: LatencyRow): boolean {
  return !row.session_id || !INTERNAL_SESSION.test(row.session_id);
}

export function latencyFamily(question: string | null): string {
  const text = question ?? "";
  if (/\b(?:consistent|continuous)(?:ly)?\s+(?:reporting\s+)?(?:agenc(?:y|ies)|reporters?)\b|reported all 12 months/i.test(text)) return "continuous-reporters";
  if (/\bcountywide\b/i.test(text)) return "countywide";
  if (/\barrests?\b/i.test(text) && /\b(?:trend|by offense|offense type|how many)\b/i.test(text)) return "nibrs-arrests";
  if ((text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:A[LKSZRCOTDEFLGAHIDNMOPSTXUVYWV]|C[AOT]|D[CE]|F[LM]|G[AU]|I[ADLN]|K[SY]|M[ADEHINOPST]|N[CDEHJMVY]|O[HKR]|P[A R]|R[HI]|S[CD]|T[NX]|U[T]|V[AIT]|W[AIVY])\b/g) ?? []).length >= 2) return "multi-city";
  if (/^\s*(?:19|20)\d{2}\s+(?:is|works|will do|please|okay|ok|yes)\b/i.test(text) || text.trim().split(/\s+/).length <= 4) return "followup-fragment";
  return "other";
}

export function latencyStats(rows: LatencyRow[], thresholdMs = 10_000): LatencyStats {
  const values = rows.map((row) => Number(row.ms)).filter((ms) => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
  const percentile = (p: number) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : 0;
  const slow = values.filter((ms) => ms >= thresholdMs).length;
  return {
    total: values.length,
    slow,
    slowRate: values.length ? slow / values.length : 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: values.length ? values[values.length - 1] : 0,
  };
}
