import Database from "better-sqlite3";
import fs from "node:fs";
import { detectQueryAuditFindings, QUERY_AUDIT_DETECTORS, type QueryAuditRow } from "../lib/query-audit-detectors";
import { AUDIT_CORPUS_IDS, AUDIT_MUST_FLAG, AUDIT_MUST_NOT_FLAG } from "../lib/query-audit-corpus";
import { loadCanonicalValues } from "./run-query-audit";

function databasePath(): string {
  const argumentIndex = process.argv.indexOf("--db");
  const argument = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
  const selected = argument || process.env.QUERY_LOG_DB_PATH;
  if (!selected || !fs.existsSync(selected)) throw new Error("Production calibration requires --db PATH (a synced query_log.db); no local fallback is allowed.");
  return selected;
}

const db = new Database(databasePath(), { readonly: true });
const placeholders = AUDIT_CORPUS_IDS.map(() => "?").join(",");
const rows = db.prepare(`SELECT id, ts, question, sql, response, rows, guardrails, NULL AS query_contract, tab FROM query_log WHERE id IN (${placeholders})`).all(...AUDIT_CORPUS_IDS) as QueryAuditRow[];
db.close();
const present = new Set(rows.map((row) => row.id));
const missing = AUDIT_CORPUS_IDS.filter((id) => !present.has(id));
if (missing.length) throw new Error(`Calibration database is missing ${missing.length} corpus rows: ${missing.join(", ")}. Sync the production query_log.db before calibrating.`);

const canonicalValues = loadCanonicalValues();
const actual = new Map(rows.map((row) => [row.id!, detectQueryAuditFindings({ ...row, canonicalValues })]));
const results = QUERY_AUDIT_DETECTORS.map((detector) => {
  const expected = Object.entries(AUDIT_MUST_FLAG).filter(([, detectors]) => detectors.includes(detector.id)).map(([id]) => Number(id));
  const hits = expected.filter((id) => actual.get(id)?.some((finding) => finding.detectorId === detector.id));
  const misses = expected.filter((id) => !hits.includes(id));
  const falsePositives = AUDIT_MUST_NOT_FLAG.filter((id) => actual.get(id)?.some((finding) => finding.detectorId === detector.id));
  return { detector: detector.id, expected: expected.length, hits: hits.length, misses: misses.join(",") || "—", falsePositives: falsePositives.join(",") || "—", status: expected.length ? "calibration-ready" : "unvalidated" };
});
console.table(results);
console.log(`Calibrated ${rows.length} production query_log rows (${Object.keys(AUDIT_MUST_FLAG).length} listed must-flag cases, ${AUDIT_MUST_NOT_FLAG.length} must-not cases).`);
