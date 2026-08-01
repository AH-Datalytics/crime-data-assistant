import { getWriteDb } from "../lib/rtci-db";
import {
  RESOLVER_WARNING_REJECTION_ENABLED,
  resolverWarningGate,
  type ResolverWarningReview,
} from "../lib/resolver-warning-classification";

const db = getWriteDb();
if (!db) throw new Error("query_log.db is unavailable");

const allowed = new Set<ResolverWarningReview>([
  "unclassified", "true_positive", "false_positive", "whitelisted_safe",
]);
const setIndex = process.argv.indexOf("--set");
if (setIndex >= 0) {
  const fingerprint = process.argv[setIndex + 1] || "";
  const classification = process.argv[setIndex + 2] as ResolverWarningReview;
  const notesIndex = process.argv.indexOf("--notes");
  const notes = notesIndex >= 0 ? process.argv.slice(notesIndex + 1).join(" ") : null;
  if (!/^[a-f0-9]{24}$/.test(fingerprint)) throw new Error("--set requires a 24-character warning fingerprint");
  if (!allowed.has(classification)) throw new Error(`Invalid classification: ${classification}`);
  const result = db.prepare(`
    UPDATE resolver_warning_classification
    SET classification = ?, review_notes = ?, reviewed_at = ?
    WHERE fingerprint = ?
  `).run(classification, notes, Date.now(), fingerprint);
  if (result.changes !== 1) throw new Error(`Warning fingerprint not found: ${fingerprint}`);
}

const rows = db.prepare(`
  SELECT fingerprint, source, warning_code, classification, whitelist_rule,
         occurrence_count, first_seen, last_seen, warning_text,
         sample_question, sample_sql, review_notes
  FROM resolver_warning_classification
  ORDER BY CASE classification WHEN 'unclassified' THEN 0 ELSE 1 END,
           last_seen DESC
`).all() as Array<Record<string, unknown> & { classification: ResolverWarningReview }>;
const gate = resolverWarningGate(rows);

console.log(JSON.stringify({
  rejectionEnabled: RESOLVER_WARNING_REJECTION_ENABLED,
  gate,
  warnings: rows,
}, null, 2));
