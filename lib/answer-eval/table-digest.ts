import { createHash } from "node:crypto";

/**
 * An answer's shown numbers, as one digest: its table's rows (keys and values). The query-log scorecard counts an
 * answer as correct only while its digest is the one verified (scripts/fixtures/answer-eval/qlog-verified.json), and
 * the verification request file carries the same digest, so a match becomes a verified entry without a rerun.
 */
export function tableDigest(rows: unknown): string {
  return createHash("sha256").update(JSON.stringify(rows ?? null)).digest("hex").slice(0, 16);
}
