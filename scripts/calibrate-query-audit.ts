import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
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

/**
 * D6 compares narrative labels against canonical source values. If that list is
 * empty the detector cannot fire at all, and it silently reports a MISS that
 * looks like a detector bug.
 *
 * That is what happened here: the local shr.db is a 0-byte stub with no tables,
 * so loadCanonicalValues() returned [] and D6 reported 0/1 on 7780 while its
 * logic was in fact correct. A detector whose reference data is absent is
 * UNVALIDATABLE, not failing — so this fails loudly instead, the same way the
 * missing-corpus check does.
 *
 * Order: an explicit --canonical-values file, then a real source database, then
 * the committed fixture captured from production.
 */
function resolveCanonicalValues(): { values: string[]; origin: string } {
  const flagIndex = process.argv.indexOf("--canonical-values");
  const explicit = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  if (explicit) {
    const parsed = JSON.parse(fs.readFileSync(explicit, "utf8"));
    const values: string[] = Array.isArray(parsed) ? parsed : parsed.values;
    return { values, origin: `--canonical-values ${explicit}` };
  }
  const fromSource = loadCanonicalValues();
  if (fromSource.length > 0) return { values: fromSource, origin: "source database" };
  const fixturePath = path.join(__dirname, "fixtures", "shr-canonical-values.json");
  if (fs.existsSync(fixturePath)) {
    const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    return { values: parsed.values as string[], origin: `fixture ${fixturePath}` };
  }
  return { values: [], origin: "none" };
}

const canonical = resolveCanonicalValues();
if (canonical.values.length === 0) {
  throw new Error(
    "No canonical source values available, so label detectors (D6) cannot be calibrated. " +
      "Pass --canonical-values <file>, point SHR_DB_PATH at a real shr.db, or restore " +
      "scripts/fixtures/shr-canonical-values.json."
  );
}
console.log(`Canonical values: ${canonical.values.length} (${canonical.origin})`);
const canonicalValues = canonical.values;
const actual = new Map(rows.map((row) => [row.id!, detectQueryAuditFindings({ ...row, canonicalValues })]));
const results = QUERY_AUDIT_DETECTORS.map((detector) => {
  const expected = Object.entries(AUDIT_MUST_FLAG).filter(([, detectors]) => detectors.includes(detector.id)).map(([id]) => Number(id));
  const hits = expected.filter((id) => actual.get(id)?.some((finding) => finding.detectorId === detector.id));
  const misses = expected.filter((id) => !hits.includes(id));
  const falsePositives = AUDIT_MUST_NOT_FLAG.filter((id) => actual.get(id)?.some((finding) => finding.detectorId === detector.id));
  return { detector: detector.id, expected: expected.length, hits: hits.length, misses: misses.join(",") || "—", falsePositives: falsePositives.join(",") || "—", status: expected.length ? "calibration-ready" : "unvalidated" };
});
console.table(results);

/**
 * Per-row attribution matrix.
 *
 * The per-detector table above cannot show a MISATTRIBUTION: a must-flag row
 * claimed by the wrong detector counts as a miss for the intended detector and
 * as nothing at all for the one that fired, because falsePositives only counts
 * must-not-flag rows. Production 2305 hid exactly that way — D3 missed it while
 * D5 wrongly claimed it, and the summary table looked merely incomplete rather
 * than wrong.
 */
const attribution = [
  ...Object.entries(AUDIT_MUST_FLAG).map(([rawId, expectedDetectors]) => {
    const id = Number(rawId);
    const fired = (actual.get(id) ?? []).map((finding) => finding.detectorId);
    const expected = expectedDetectors.join(",");
    const hit = expectedDetectors.some((detectorId) => fired.includes(detectorId));
    const extra = fired.filter((detectorId) => !expectedDetectors.includes(detectorId));
    let verdict: string;
    if (hit && extra.length === 0) verdict = "hit";
    else if (hit) verdict = `hit + extra(${extra.join(",")})`;
    else if (fired.length > 0) verdict = `MISATTRIBUTED -> ${fired.join(",")}`;
    else verdict = "MISS (nothing fired)";
    return { row: id, kind: "must-flag", expected, actual: fired.join(",") || "—", verdict };
  }),
  ...AUDIT_MUST_NOT_FLAG.map((id) => {
    const fired = (actual.get(id) ?? []).map((finding) => finding.detectorId);
    return {
      row: id,
      kind: "must-not-flag",
      expected: "none",
      actual: fired.join(",") || "—",
      verdict: fired.length ? `FALSE POSITIVE -> ${fired.join(",")}` : "clean",
    };
  }),
].sort((a, b) => a.row - b.row);

console.log("\nPer-row attribution matrix:");
console.table(attribution);

const problems = attribution.filter((entry) => !/^(hit|clean)$/.test(entry.verdict));
console.log(
  `Calibrated ${rows.length} production query_log rows ` +
    `(${Object.keys(AUDIT_MUST_FLAG).length} listed must-flag cases, ${AUDIT_MUST_NOT_FLAG.length} must-not cases). ` +
    `${attribution.length - problems.length}/${attribution.length} rows clean; ${problems.length} need attention.`
);
if (problems.length) {
  console.log("Rows needing attention: " + problems.map((entry) => `${entry.row} (${entry.verdict})`).join("; "));
}
