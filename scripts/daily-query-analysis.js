#!/usr/bin/env node
/**
 * Daily Query Analysis for Crime Data Assistant
 * Scans the query_log for the past 24 hours and emails a digest of
 * common failures, issues, and usage patterns.
 *
 * Run via cron: 0 12 * * * cd /opt/nibrs/app && node scripts/daily-query-analysis.js
 */

const Database = require("better-sqlite3");
const {
  selectClause: proofSelectClause,
  buildProofShadowReport,
  renderProofShadowSection,
} = require("./lib/proof-shadow-report.js");
const { Resend } = require("resend");
const path = require("path");
const fs = require("fs");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = "jasher@ahdatalytics.com";
const FROM_EMAIL = "Crime Data Assistant <onboarding@resend.dev>";

if (!RESEND_API_KEY) {
  console.error("RESEND_API_KEY environment variable is required");
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

function resolveQueryLogPath() {
  const envPath = process.env.QUERY_LOG_DB_PATH;
  const candidates = [
    envPath,
    path.join(__dirname, "..", "query_log.db"),
    "/opt/nibrs/app/query_log.db",
  ].filter(Boolean);

  const seen = new Set();
  const existing = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fs.existsSync(resolved)) existing.push(resolved);
  }

  if (existing.length > 1) {
    console.warn(`Multiple query_log.db candidates exist: ${existing.join(", ")}`);
  }
  if (existing.length === 0) {
    throw new Error(`No query_log.db found. Checked: ${candidates.join(", ")}`);
  }
  return existing[0];
}

const QUERY_LOG_DB_PATH = resolveQueryLogPath();
console.log(`Using query_log.db: ${QUERY_LOG_DB_PATH}`);
const db = new Database(QUERY_LOG_DB_PATH, { readonly: true });

// Previous calendar day (midnight to midnight CT)
function getYesterdayRange() {
  // Build "yesterday" in Central Time
  const now = new Date();
  const ct = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  // Start of today CT
  const todayStart = new Date(ct.getFullYear(), ct.getMonth(), ct.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  // Convert back to UTC timestamps
  const offsetMs = now.getTime() - ct.getTime();
  return {
    start: yesterdayStart.getTime() + offsetMs,
    end: todayStart.getTime() + offsetMs,
  };
}

const { start: cutoff, end: cutoffEnd } = getYesterdayRange();

// Columns are listed rather than SELECT *ed so a diagnostic column can be added
// to query_log without silently entering an outbound email. model_response holds
// raw model text captured on no-SQL failures and must stay internal.
const DIGEST_QUERY_COLUMNS =
  "id, ts, question, sql, rows, error, ms, response, tab, guardrails, model, session_id, " +
  "routing_confidence, routing_mode, routing_reason, query_guidance, query_contract";

function getQueries() {
  const columns = new Set(db.prepare("PRAGMA table_info(query_log)").all().map((column) => column.name));
  const selected =
    DIGEST_QUERY_COLUMNS +
    (columns.has("chart_config") ? ", chart_config" : ", NULL AS chart_config") +
    // Same conditional shape: an unmigrated database yields NULLs and the shadow
    // section reports "not observing" rather than failing the whole digest.
    ", " + proofSelectClause(columns);
  return db
    .prepare(`SELECT ${selected} FROM query_log WHERE ts >= ? AND ts < ? ORDER BY ts ASC`)
    .all(cutoff, cutoffEnd);
}

function attachChartAuditResults(queries, chartHealth) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chart_audit_results'").get();
  const ids = queries.map((query) => query.id).filter((id) => id != null);
  const results = table && ids.length
    ? db.prepare(`SELECT query_log_id, status, summary FROM chart_audit_results WHERE query_log_id IN (${ids.map(() => "?").join(",")})`).all(...ids)
    : [];
  const byId = new Map(results.map((result) => [result.query_log_id, result]));

  // When there is no result for a chart, the honest sentence depends on WHY.
  // "verification is not available" was previously printed whether the auditor
  // had examined the chart and found nothing to say or had never run at all --
  // the same conflation of "checked and clean" with "never checked" that
  // getAuditorHealth() exists to prevent on the query side.
  const health = chartHealth || {};
  const missingSummary = health.available
    ? "A chart was returned. The rendered-chart auditor ran for this period but recorded no result for it."
    : `A chart was returned, but it was NOT checked: ${health.reason || "rendered-chart auditor health is unknown"}`;

  for (const query of queries) {
    if (!query.chart_config) query.chartAudit = { status: "not-applicable", summary: "No chart was produced." };
    else query.chartAudit = byId.get(query.id) || { status: "unverified", summary: missingSummary };
  }
}
const INTERNAL_SESSION =
  /(?:live-replay|codex|deploy-smoke|targeted-probe|layer3|canary|scoreboard|benchmark|eval)/i;

function isHumanQuery(query) {
  return !INTERNAL_SESSION.test(String(query.session_id || ""));
}

const CONTROLLED_OUTCOME_ERRORS = new Set(["nonfatal_shooting_refusal"]);

function isControlledOutcomeError(error) {
  return CONTROLLED_OUTCOME_ERRORS.has(String(error || ""));
}


/**
 * Provenance labels written to audit_findings.source. These must match the
 * constants in scripts/run-query-audit.ts; scripts/test-audit-provenance.js
 * asserts the detector list and labels stay in sync with lib/query-audit-detectors.ts.
 */
const DIGEST_FINDING_SOURCE = "daily-digest";
const DETECTOR_FINDING_SOURCE = "phase1-detector";

/**
 * Mirror of lib/query-audit-detectors.ts. Duplicated because this script runs
 * under plain `node` and cannot import the TypeScript module. Parity is enforced
 * by a test rather than by convention.
 */
const PHASE1_DETECTORS = [
  ["D1", "qualifier-drop"], ["D2", "place-mismatch"], ["D3", "grain-mismatch"], ["D4", "year-range-mismatch"],
  ["D5", "metric-aggregate-mismatch"], ["D6", "malformed-label"], ["D7", "refusal-on-answerable"], ["D8", "unresolved-contract-tag"],
];

/**
 * Defect classes that this digest's own rule-based checks and the deterministic
 * detectors both measure, by different means. When both fire on the same row the
 * finding is "detector-confirmed" and deserves attention first; a finding from
 * only one side is weaker evidence.
 *
 * Computed at READ time rather than stored, because the two writers run as
 * separate processes in either order, and a stored flag would go stale whenever
 * detectors are retuned.
 */
const SEMANTIC_FAMILIES = [
  { family: "unnecessary refusal", detector: "refusal-on-answerable", digest: "potential_refusal" },
  { family: "wrong place named", detector: "place-mismatch", digest: "entity_hallucination" },
  { family: "wrong years named", detector: "year-range-mismatch", digest: "year_hallucination" },
];

/**
 * Health of the most recent Phase 1 auditor run.
 *
 * This exists so that "0 flagged" can be distinguished from "the auditor never
 * ran". Reporting a silent zero as an all-clear is the failure mode this whole
 * workstream is meant to prevent.
 */
function getAuditorHealth() {
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_runs'").get();
    if (!exists) return { available: false, reason: "audit_runs table does not exist (migration not applied)" };
    const run = db.prepare(
      "SELECT id, status, started_ts, finished_ts, from_log_id, to_log_id, rows_audited, findings_written, detail FROM audit_runs WHERE source = ? ORDER BY id DESC LIMIT 1"
    ).get(DETECTOR_FINDING_SOURCE);
    if (!run) return { available: false, reason: "the auditor has never run" };

    // Did the last successful run actually cover yesterday's traffic? A run that
    // succeeded but stopped short leaves the digest reporting zeros for rows
    // nobody examined.
    const lastOk = db.prepare(
      "SELECT COALESCE(MAX(to_log_id), 0) AS n FROM audit_runs WHERE source = ? AND status = 'ok'"
    ).get(DETECTOR_FINDING_SOURCE).n;
    const maxYesterday = db.prepare(
      "SELECT COALESCE(MAX(id), 0) AS n FROM query_log WHERE ts >= ? AND ts < ?"
    ).get(cutoff, cutoffEnd).n;
    const covered = maxYesterday === 0 || lastOk >= maxYesterday;

    const inert = /inert detectors[^:]*:\s*([A-Z0-9,]+)/i.exec(run.detail || "");
    return {
      available: run.status === "ok",
      status: run.status,
      runId: run.id,
      rowsAudited: run.rows_audited,
      findingsWritten: run.findings_written,
      inert: inert ? inert[1].split(",").filter(Boolean) : [],
      covered,
      coverageGap: covered ? 0 : maxYesterday - lastOk,
      detail: run.detail || null,
      reason: run.status === "ok" ? null : `last run ended '${run.status}': ${run.detail || "no detail recorded"}`,
    };
  } catch (err) {
    return { available: false, reason: `auditor health unavailable: ${err.message}` };
  }
}

/**
 * Health of the most recent rendered-chart auditor run.
 *
 * Read from audit_runs rather than inferred from chart_audit_results, for the
 * reason this table exists: on 2026-08-11 production held 24 chart artifacts and
 * 15 render receipts with zero results, and every chart in the digest was
 * labelled "unverified" -- a phrase that reads as a property of the charts when
 * it was actually a property of an auditor that had never executed. An empty
 * results table and a healthy auditor with nothing to do are indistinguishable
 * without this record.
 *
 * Mirrors run-chart-audit.ts's CHART_AUDIT_SOURCE. That file is TypeScript and
 * this script runs under plain node, so the literal is duplicated here and the
 * pairing is asserted by scripts/test-chart-audit-pipeline.ts -- the same
 * arrangement already used for PHASE1_DETECTORS.
 */
const CHART_AUDIT_SOURCE = "chart-audit";

function getChartAuditorHealth() {
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_runs'").get();
    if (!exists) return { available: false, reason: "audit_runs table does not exist (migration not applied)" };
    const run = db.prepare(
      "SELECT id, status, started_ts, finished_ts, rows_audited, detail FROM audit_runs WHERE source = ? ORDER BY id DESC LIMIT 1"
    ).get(CHART_AUDIT_SOURCE);
    if (!run) {
      return {
        available: false,
        reason:
          "the rendered-chart auditor has never run. Charts below are reported as unverified because nothing " +
          "checked them, not because a check found a problem.",
      };
    }

    // COVERAGE REQUIRES COMPLETION PAST THE WINDOW'S END, not merely a start
    // inside it. A run that began at noon yesterday saw only the charts captured
    // before noon, so certifying the whole day on the strength of its start time
    // would vouch for artifacts it never looked at -- the same "ran, therefore
    // clean" conflation this function exists to prevent, one level up.
    //
    // finished_ts is the audited-through watermark: this suite reads every
    // artifact present when it runs, so everything captured before it finished
    // was in scope. A run still at 'running' has no watermark and covers
    // nothing, which is precisely how a killed run surfaces here.
    const finishedAt = run.finished_ts === null || run.finished_ts === undefined ? null : Number(run.finished_ts);
    const coversWindow = finishedAt !== null && finishedAt >= cutoffEnd;
    const stamp = (value) => (value ? new Date(Number(value)).toISOString() : "an unknown time");

    let reason = null;
    if (run.status === "running" || finishedAt === null) {
      reason =
        `the rendered-chart auditor started at ${stamp(run.started_ts)} and never recorded a finish. ` +
        "It was interrupted, so nothing it may have written can be treated as complete.";
    } else if (run.status !== "ok") {
      reason = `last chart-audit run ended '${run.status}': ${run.detail || "no detail recorded"}`;
    } else if (!coversWindow) {
      reason =
        `the rendered-chart auditor last finished at ${stamp(finishedAt)}, before the end of this review period ` +
        `(${new Date(cutoffEnd).toISOString()}). Charts captured after it ran were not checked.`;
    }

    return {
      available: run.status === "ok" && coversWindow,
      status: run.status,
      runId: run.id,
      rowsAudited: run.rows_audited,
      coversWindow,
      lastRunAt: run.started_ts ? new Date(Number(run.started_ts)).toISOString() : null,
      lastFinishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
      detail: run.detail || null,
      reason,
    };
  } catch (err) {
    return { available: false, reason: `chart auditor health unavailable: ${err.message}` };
  }
}

function getAuditDetectorStats(queries, health) {
  const ids = queries.map((query) => query.id).filter((id) => id !== null && id !== undefined);
  const idSet = new Set(ids);
  // When the auditor did not run (or did not reach these rows) the honest report
  // is "unavailable", not a zero that reads as a clean bill of health.
  const unavailable = (reason) =>
    PHASE1_DETECTORS.map(([id, category]) => ({ id, category, flagged: null, unflagged: null, examples: [], status: reason }));

  if (!health || !health.available) return unavailable(health && health.reason ? health.reason : "auditor did not run");
  if (!health.covered) return unavailable(`auditor has not yet audited these rows (${health.coverageGap} behind)`);

  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_findings'").get();
    if (!exists) return unavailable("audit_findings table does not exist");
    const findings = ids.length
      ? db.prepare(
          `SELECT query_log_id, category, finding FROM audit_findings
           WHERE source = ? AND query_log_id IN (${ids.map(() => "?").join(",")})`
        ).all(DETECTOR_FINDING_SOURCE, ...ids)
      : [];
    return PHASE1_DETECTORS.map(([id, category]) => {
      const matches = findings.filter((item) => item.category === category && idSet.has(item.query_log_id));
      const flaggedIds = new Set(matches.map((item) => item.query_log_id));
      const examples = [...new Set(matches.map((item) => queries.find((query) => query.id === item.query_log_id)?.question).filter(Boolean))].slice(0, 3);
      const status = health.inert.includes(id) ? "INERT - no reference data, zero is not an all-clear" : "calibrated";
      return { id, category, flagged: flaggedIds.size, unflagged: Math.max(0, queries.length - flaggedIds.size), examples, status };
    });
  } catch (err) {
    console.warn("Cross-artifact auditor stats unavailable:", err.message);
    return unavailable(`stats query failed: ${err.message}`);
  }
}

/**
 * Cross-reference detector findings against this digest's own findings on the
 * same row, so the email can separate corroborated defects from single-source
 * ones.
 */
function getDetectorConfirmed(queries) {
  const ids = queries.map((query) => query.id).filter((id) => id !== null && id !== undefined);
  if (ids.length === 0) return [];
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_findings'").get();
    if (!exists) return [];
    const columns = db.prepare("PRAGMA table_info(audit_findings)").all().map((column) => column.name);
    if (!columns.includes("source")) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT query_log_id, category, source FROM audit_findings WHERE query_log_id IN (${placeholders})`
    ).all(...ids);
    return SEMANTIC_FAMILIES.map(({ family, detector, digest }) => {
      const detectorRows = new Set(rows.filter((r) => r.source === DETECTOR_FINDING_SOURCE && r.category === detector).map((r) => r.query_log_id));
      const digestRows = new Set(rows.filter((r) => r.source === DIGEST_FINDING_SOURCE && r.category === digest).map((r) => r.query_log_id));
      const both = [...detectorRows].filter((id) => digestRows.has(id));
      return {
        family,
        confirmed: both.length,
        detectorOnly: detectorRows.size - both.length,
        digestOnly: digestRows.size - both.length,
        examples: both.slice(0, 3).map((id) => queries.find((query) => query.id === id)?.question).filter(Boolean),
      };
    }).filter((row) => row.confirmed + row.detectorOnly + row.digestOnly > 0);
  } catch (err) {
    console.warn("Detector-confirmed cross-reference unavailable:", err.message);
    return [];
  }
}

function getResolverWarningAudit() {
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='resolver_warning_classification'").get();
    if (!exists) return null;
    const byClassification = db.prepare(`
      SELECT classification, COUNT(*) AS shapes, SUM(occurrence_count) AS occurrences
      FROM resolver_warning_classification GROUP BY classification ORDER BY classification
    `).all();
    const totals = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN classification = 'unclassified' THEN 1 ELSE 0 END) AS unclassified,
             SUM(CASE WHEN classification IN ('false_positive','whitelisted_safe') THEN 1 ELSE 0 END) AS false_positives,
             SUM(CASE WHEN first_seen >= ? AND first_seen < ? THEN 1 ELSE 0 END) AS new_shapes,
             SUM(CASE WHEN last_seen >= ? AND last_seen < ? THEN occurrence_count ELSE 0 END) AS recently_seen_shape_occurrences
      FROM resolver_warning_classification
    `).get(cutoff, cutoffEnd, cutoff, cutoffEnd);
    const classified = totals.total - totals.unclassified;
    const falsePositiveRate = classified > 0 ? totals.false_positives / classified : null;
    return {
      byClassification, ...totals, classified, falsePositiveRate,
      ready: totals.total > 0 && totals.unclassified === 0 && falsePositiveRate !== null && falsePositiveRate < 0.05,
      rejectionEnabled: false,
    };
  } catch (err) {
    console.warn("Resolver warning audit read failed:", err.message);
    return null;
  }
}

function getShrCoverageAudit() {
  const candidates = [
    process.env.SHR_DB_PATH,
    "/opt/nibrs/shr.db",
    path.join(__dirname, "..", "shr.db"),
  ].filter(Boolean);
  const shrPath = candidates.find((candidate) => {
    try { return fs.existsSync(candidate) && fs.statSync(candidate).size > 0; } catch { return false; }
  });
  if (!shrPath) return null;
  let shrDb;
  try {
    shrDb = new Database(shrPath, { readonly: true });
    const exists = shrDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shr_return_a_comparison'").get();
    if (!exists) return null;
    const columns = new Set(shrDb.prepare("PRAGMA table_info(shr_return_a_comparison)").all().map((row) => row.name));
    if (!columns.has("display_status")) return { artifactPending: true, shrPath };
    const comparisonStatuses = shrDb.prepare(`
      SELECT comparison_status AS status, COUNT(*) AS rows, SUM(shr_victims) AS victims
      FROM shr_return_a_comparison GROUP BY comparison_status ORDER BY rows DESC
    `).all();
    const displayStatuses = shrDb.prepare(`
      SELECT display_status AS status, COUNT(*) AS rows, SUM(shr_victims) AS victims
      FROM shr_return_a_comparison GROUP BY display_status ORDER BY rows DESC
    `).all();
    const totals = shrDb.prepare(`
      SELECT COUNT(*) AS rows,
             SUM(CASE WHEN join_method IN ('ambiguous','unmatched') THEN 1 ELSE 0 END) AS unresolved_joins,
             SUM(comparison_conflict) AS comparison_conflicts,
             SUM(presentation_changed) AS presentation_changed,
             SUM(CASE WHEN classification_changed = 1 AND classification_build_ts >= ? AND classification_build_ts < ? THEN 1 ELSE 0 END) AS classifications_changed_today,
             SUM(CASE WHEN shr_victims > 0 AND display_value IS NULL THEN 1 ELSE 0 END) AS positive_counts_hidden,
             SUM(CASE WHEN display_value = 0 AND display_status != 'validated_zero' THEN 1 ELSE 0 END) AS invalid_zeroes
      FROM shr_return_a_comparison
    `).get(cutoff, cutoffEnd);
    return { artifactPending: false, shrPath, comparisonStatuses, displayStatuses, ...totals };
  } catch (err) {
    console.warn("SHR coverage audit read failed:", err.message);
    return null;
  } finally {
    if (shrDb) shrDb.close();
  }
}

function getVisitors() {
  try {
    // Check if visitor_log table exists
    const tableExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='visitor_log'"
      )
      .get();
    if (!tableExists) return null;

    const pageviews = db
      .prepare(
        "SELECT COUNT(*) as n FROM visitor_log WHERE ts >= ? AND ts < ? AND event = 'pageview'"
      )
      .get(cutoff, cutoffEnd);

    const uniqueSessions = db
      .prepare(
        "SELECT COUNT(DISTINCT session_id) as n FROM visitor_log WHERE ts >= ? AND ts < ? AND event = 'pageview'"
      )
      .get(cutoff, cutoffEnd);

    // Monthly totals by calendar month (up to 6 months)
    const monthlyTotals = db
      .prepare(
        `SELECT
           strftime('%Y-%m', ts / 1000, 'unixepoch') as month,
           COUNT(*) as pageviews,
           COUNT(DISTINCT session_id) as unique_visitors
         FROM visitor_log
         WHERE event = 'pageview'
         GROUP BY month
         ORDER BY month DESC
         LIMIT 6`
      )
      .all();

    // Top referrer domains
    const topDomains = db
      .prepare(
        `SELECT referrer_domain, COUNT(*) as visits
         FROM visitor_log
         WHERE ts >= ? AND ts < ? AND event = 'pageview' AND referrer_domain != '' AND referrer_domain != 'assistant.crimeindex.org' AND referrer_domain != 'nibrsai.com'
         GROUP BY referrer_domain ORDER BY visits DESC LIMIT 15`
      )
      .all(cutoff, cutoffEnd);

    // Top specific referrer URLs (the actual articles/pages)
    const topReferrers = db
      .prepare(
        `SELECT referrer, referrer_domain, COUNT(*) as visits
         FROM visitor_log
         WHERE ts >= ? AND ts < ? AND event = 'pageview' AND referrer != '' AND referrer_domain != 'assistant.crimeindex.org' AND referrer_domain != 'nibrsai.com'
         GROUP BY referrer ORDER BY visits DESC LIMIT 20`
      )
      .all(cutoff, cutoffEnd);

    // UTM campaign breakdown
    const utmCampaigns = db
      .prepare(
        `SELECT utm_source, utm_medium, utm_campaign, COUNT(*) as visits
         FROM visitor_log
         WHERE ts >= ? AND ts < ? AND event = 'pageview' AND utm_source != ''
         GROUP BY utm_source, utm_medium, utm_campaign ORDER BY visits DESC LIMIT 10`
      )
      .all(cutoff, cutoffEnd);

    // Tab breakdown from pageviews
    const tabViews = db
      .prepare(
        `SELECT tab, COUNT(*) as views
         FROM visitor_log
         WHERE ts >= ? AND ts < ? AND event IN ('pageview', 'tab_switch')
         GROUP BY tab ORDER BY views DESC`
      )
      .all(cutoff, cutoffEnd);

    // Direct vs referred
    const directCount = db
      .prepare(
        `SELECT COUNT(*) as n FROM visitor_log WHERE ts >= ? AND ts < ? AND event = 'pageview' AND (referrer = '' OR referrer IS NULL)`
      )
      .get(cutoff, cutoffEnd);

    return {
      pageviews: pageviews.n,
      uniqueSessions: uniqueSessions.n,
      topDomains,
      topReferrers,
      utmCampaigns,
      tabViews,
      monthlyTotals,
      directVisits: directCount.n,
      referredVisits: pageviews.n - directCount.n,
    };
  } catch (err) {
    console.error("Error reading visitor_log:", err.message);
    return null;
  }
}

const RELIABILITY_CATEGORIES = {
  "requested-monthly-returned-annual": { tag: "grain-mismatch", threshold: 3, count: 0, examples: [] },
  "year-range-starting-before-returned-data": { tag: "lower-bound-disclosed", threshold: 5, count: 0, examples: [] },
  "retry-after-invalid-column": { tags: ["schema-column-invalid", "schema-column-corrected"], threshold: 3, count: 0, examples: [] },
  "metadata-response-to-analytical-question": { tag: "metadata-coverage-answer", threshold: 3, count: 0, examples: [] },
  "completeness-question-answered": { tag: "completeness-deterministic", threshold: 5, count: 0, examples: [] },
  "typo-corrected-geography": { tag: "geo-typo-corrected", threshold: 5, count: 0, examples: [] },
  "implausible-population-denominator": { tag: "implausible-population-denominator", threshold: 1, count: 0, examples: [] },
};

function recordReliabilityTag(stats, name, question) {
  if (!name) return;
  stats.guardrailFires[name] = (stats.guardrailFires[name] || 0) + 1;
  const resolved = name.endsWith("-resolved-on-retry");
  const baseName = resolved ? name.slice(0, -"-resolved-on-retry".length) : name;
  if (Object.hasOwn(stats.resolverTags, name)) stats.resolverTags[name]++;
  for (const category of Object.values(stats.reliabilityCategories)) {
    const tags = category.tags || [category.tag];
    if (!tags.includes(baseName)) continue;
    if (resolved) {
      category.resolvedCount++;
      if (category.resolvedExamples.length < 3 && question) category.resolvedExamples.push(question);
    } else {
      category.count++;
      if (category.examples.length < 3 && question) category.examples.push(question);
    }
    break;
  }
}
function contractLooksAnswerable(query) {
  const contract = String(query.query_contract || "");
  let parsed = null;
  try { parsed = contract ? JSON.parse(contract) : null; } catch { /* capped contracts may be partial JSON */ }
  const hasPlace = parsed
    ? Boolean(parsed.geography && parsed.geography.kind && parsed.geography.kind !== "unknown")
    : /"kind":"(?:city|state|county|agency|campus)"/.test(contract);
  const hasMetric = parsed
    ? Boolean(parsed.metric && (parsed.metric.topic !== "unknown" || (parsed.metric.offenseCodes || []).length > 0))
    : /"topic":"(?!unknown)[^"]+"|"offenseCodes":\["/.test(contract) ||
      /\b(?:murder|homicide|rape|robbery|assault|burglary|theft|crime|clearance|arrest|victim|offender)\b/i.test(query.question || "");
  const hasTime = parsed
    ? Boolean(parsed.time && (parsed.time.startYear !== null || parsed.time.endYear !== null))
    : /\b(?:19|20)\d{2}\b/.test(query.question || "");
  return hasPlace && hasMetric && hasTime;
}

function contractCityCount(query) {
  const contract = String(query.query_contract || "");
  try {
    const parsed = JSON.parse(contract);
    return Array.isArray(parsed.geographies)
      ? parsed.geographies.filter((place) => place && place.kind === "city").length
      : 0;
  } catch {
    return (contract.match(/"kind":"city"/g) || []).length;
  }
}


function analyze(queries) {
  const issues = [];
  const stats = {
    total: queries.length,
    byTab: {},
    errors: 0,
    zeroRows: 0,
    slowQueries: 0,
    jsonParseFailures: 0,
    yearHallucinations: 0,
    entityHallucinations: 0,
    unnecessaryRefusals: 0,
    sqlLeaks: 0,
    avgMs: 0,
    medianMs: 0,
    unknownAgencies: [],
    guardrailFires: {},  // { guardrailName: count }
    guardrailTotal: 0,   // queries where at least 1 guardrail fired
    reliabilityCategories: Object.fromEntries(Object.entries(RELIABILITY_CATEGORIES).map(([name, value]) => [name, { ...value, resolvedCount: 0, resolvedExamples: [], examples: [] }])),
    auditDetectorStats: [],
    auditorHealth: null,
    detectorConfirmed: [],
    resolverTags: {
      "nibrs-place-resolved": 0,
      "nibrs-place-resolution-block": 0,
      "nibrs-resolved-ori-warn-only": 0,
      "shr-place-resolution-block": 0,
      "shr-ori-not-in-source": 0,
      "shr-resolved-ori-rewritten": 0,
      "shr-resolved-ori-warn-only": 0,
      "shr-coverage-count": 0,
      "shr-coverage-validated-zero": 0,
      "shr-coverage-gap": 0,
      "shr-coverage-coverage-unknown": 0,
      "shr-coverage-presentation-changed": 0,
    },
  };

  const msTimes = [];

  for (const q of queries) {
    // Tab counts
    const tab = q.tab || "unknown";
    stats.byTab[tab] = (stats.byTab[tab] || 0) + 1;

    // Response time
    if (q.ms) msTimes.push(q.ms);

    // Errors
    if (q.error && !isControlledOutcomeError(q.error)) {
      stats.errors++;
      issues.push({
        type: "error",
        severity: "high",
        question: q.question,
        detail: q.error.substring(0, 200),
        tab,
        id: q.id,
      });
    }
    // A structured request that reaches the server-authored no-answer fallback
    // is a confirmed user-visible failure, even though no database error exists.
    if (
      !q.sql && q.rows === 0 &&
      String(q.guardrails || "").split(",").includes("no-sql-server-template") &&
      contractLooksAnswerable(q)
    ) {
      issues.push({
        type: "answerable_no_sql",
        severity: "high",
        question: q.question,
        detail: "The request had a specific place, measure, and year, but no answer was produced.",
        tab,
        id: q.id,
      });
    }

    // When Historical cannot answer a clearance question, failing to mention
    // the available NIBRS path leaves a person at a dead end.
    if (
      String(q.guardrails || "").split(",").includes("historical-year-unavailable") &&
      /clearance|cleared/i.test(q.question || "") &&
      !/\bNIBRS\b/i.test(q.response || "")
    ) {
      issues.push({
        type: "missing_source_alternative",
        severity: "medium",
        question: q.question,
        detail: "The answer said Historical data were unavailable but did not point the user to NIBRS clearance data.",
        tab,
        id: q.id,
      });
    }


    // Zero rows (has SQL but returned nothing)
    if (q.sql && q.rows === 0 && !q.error) {
      stats.zeroRows++;
      issues.push({
        type: "zero_rows",
        severity: "medium",
        question: q.question,
        detail: "Query returned 0 rows",
        tab,
        id: q.id,
      });
    }

    // Slow queries (>10s)
    if (q.ms > 10000) {
      stats.slowQueries++;
      issues.push({
        type: "slow",
        severity: "medium",
        question: q.question,
        detail: `${(q.ms / 1000).toFixed(1)}s response time`,
        tab,
        id: q.id,
      });
    }

    // JSON parse failure — response contains SQL/JSON code
    if (
      q.response &&
      (q.response.includes("```json") ||
        q.response.includes('"sql"') ||
        q.response.includes("SELECT "))
    ) {
      stats.jsonParseFailures++;
      issues.push({
        type: "json_parse_failure",
        severity: "high",
        question: q.question,
        detail: "Response contains raw SQL/JSON — user saw code",
        tab,
        id: q.id,
      });
    }

    // SQL leak in explanation (response contains SQL keywords but not the above)
    if (
      q.response &&
      !q.response.includes("```") &&
      /\b(SELECT|FROM|WHERE|JOIN|GROUP BY|ORDER BY)\b/.test(q.response)
    ) {
      stats.sqlLeaks++;
      issues.push({
        type: "sql_leak",
        severity: "medium",
        question: q.question,
        detail:
          "Explanation contains SQL keywords: " +
          q.response.substring(0, 150),
        tab,
        id: q.id,
      });
    }

    // Year hallucination — response mentions specific years outside the tab's data range
    if (q.response && q.question) {
      const responseYears = q.response.match(/\b(19|20)\d{2}\b/g) || [];
      const questionYears = q.question.match(/\b(19|20)\d{2}\b/g) || [];
      const questionYearSet = new Set(questionYears);

      // Each tab has an expected data range — years within range are not hallucinations
      const dataRanges = {
        current: [2017, 2026],
        historical: [1930, 2024],
        nibrs: [2020, 2026],
      };
      const [rangeStart, rangeEnd] = dataRanges[tab] || [1900, 2030];

      const hallucinatedYears = responseYears.filter((y) => {
        const yr = parseInt(y, 10);
        // Skip years the user mentioned or years within the tab's data range
        return !questionYearSet.has(y) && (yr < rangeStart || yr > rangeEnd);
      });

      // Flag if response introduces 2+ years outside the data range
      if (hallucinatedYears.length >= 2 && questionYears.length === 0) {
        stats.yearHallucinations++;
        issues.push({
          type: "year_hallucination",
          severity: "low",
          question: q.question,
          detail: `Response mentions years [${[...new Set(hallucinatedYears)].join(", ")}] outside ${tab} range ${rangeStart}–${rangeEnd}`,
          tab,
          id: q.id,
        });
      }
    }

    // Entity hallucination — response mentions a city not in the SQL
    // Only flag when SQL targets specific entities (agency=/city= filters).
    // Ranking queries (ORDER BY ... LIMIT, no agency filter) legitimately
    // return city names not present in the SQL text.
    if (q.response && q.sql) {
      const sqlLower = q.sql.toLowerCase();
      const targetsSpecificEntity = /agency\s*=\s*'/i.test(q.sql) || /city\s*=\s*'/i.test(q.sql);
      if (targetsSpecificEntity) {
        const MAJOR_CITIES = [
          "Los Angeles", "New York", "Chicago", "Houston", "Phoenix", "Philadelphia",
          "San Antonio", "San Diego", "Dallas", "Austin", "Jacksonville", "Fort Worth",
          "Columbus", "Charlotte", "Indianapolis", "San Francisco", "Seattle", "Denver",
          "Washington", "Nashville", "Oklahoma City", "El Paso", "Boston", "Portland",
          "Las Vegas", "Memphis", "Louisville", "Baltimore", "Milwaukee", "Albuquerque",
          "Tucson", "Fresno", "Sacramento", "Atlanta", "Kansas City", "Omaha",
          "Raleigh", "Miami", "Oakland", "Minneapolis", "Tampa", "Detroit",
          "St Louis", "St. Louis", "New Orleans", "Cleveland", "Pittsburgh",
        ];
        for (const city of MAJOR_CITIES) {
          const cityRegex = new RegExp("\\b" + city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
          if (cityRegex.test(q.response) && !sqlLower.includes(city.toLowerCase())) {
            stats.entityHallucinations++;
            issues.push({
              type: "entity_hallucination",
              severity: "high",
              question: q.question,
              detail: `Response mentions "${city}" but SQL targets a different entity`,
              tab,
              id: q.id,
            });
            break; // One flag per query is enough
          }
        }
      }
    }

    // Unnecessary refusal — sql is null but question looks like a valid data query
    if (!q.sql && q.response && q.rows === 0 && !isControlledOutcomeError(q.error)) {
      const looksLikeDataQuery = /\b(top|rank|highest|lowest|most|least|cities|states|murder|crime|robbery|assault|theft|burglary|rape|violent|property)\b/i.test(q.question);
      const looksLikeFollowUp = /^\d+$|^option\s*\d|please/i.test(q.question.trim());
      const isRefusal = /can't|cannot|unable|not available|don't have|doesn't|doesn't appear/i.test(q.response);
      if (looksLikeDataQuery && isRefusal && !looksLikeFollowUp) {
        stats.unnecessaryRefusals++;
        issues.push({
          type: "potential_refusal",
          severity: "medium",
          question: q.question,
          detail: "Model refused a data query — may be answerable. Response: " + q.response.substring(0, 150),
          tab,
          id: q.id,
        });
      }
    }

    // Unknown agency detection — response says "not found" or "isn't in"
    if (
      q.response &&
      (/wasn.t found|not in our dataset|doesn.t appear/i.test(q.response))
    ) {
      const agencyMatch = q.question.match(
        /(?:in |for |about )([A-Z][a-zA-Z\s.'-]+?)(?:\s+(?:since|from|over|in|,|\?))/
      );
      if (agencyMatch) {
        stats.unknownAgencies.push(agencyMatch[1].trim());
      }
    }

    // Guardrail fires
    if (q.guardrails) {
      stats.guardrailTotal++;
      for (const g of q.guardrails.split(",")) {
        recordReliabilityTag(stats, g.trim(), q.question);
      }
    }
  }

  // Compute avg/median ms
  if (msTimes.length > 0) {
    stats.avgMs = Math.round(
      msTimes.reduce((a, b) => a + b, 0) / msTimes.length
    );
    msTimes.sort((a, b) => a - b);
    stats.medianMs = msTimes[Math.floor(msTimes.length / 2)];
  }

  stats.auditorHealth = getAuditorHealth();
  stats.auditDetectorStats = getAuditDetectorStats(queries, stats.auditorHealth);
  stats.detectorConfirmed = getDetectorConfirmed(queries);

  // --- Pattern detection: cluster issues into actionable suggestions ---
  // Reliability signals are informational until they exceed their documented threshold.
  for (const [category, signal] of Object.entries(stats.reliabilityCategories)) {
    if (signal.count > signal.threshold) {
      issues.push({
        type: "reliability_" + category,
        severity: "medium",
        question: signal.examples[0] || "",
        detail: category + " fired " + signal.count + " times (threshold " + signal.threshold + "). Examples: " + signal.examples.join(" | "),
        tab: "mixed",
        id: null,
      });
    }
  }

  const suggestions = [];
  // A short follow-up can inherit a large place list from an earlier turn. If a
  // one-year, one-row-per-place request returns far more rows than the prior
  // contract contains cities, surface likely mailing-city overmatching.
  const sessionQueries = new Map();
  for (const query of queries) {
    if (!query.session_id) continue;
    const entries = sessionQueries.get(query.session_id) || [];
    entries.push(query);
    sessionQueries.set(query.session_id, entries);
  }
  const existingIssueIds = new Set(issues.map((issue) => `${issue.id}:${issue.type}`));
  for (const entries of sessionQueries.values()) {
    for (let index = 1; index < entries.length; index++) {
      const query = entries[index];
      if (!query.sql || Number(query.rows) <= 0 || String(query.question || "").length > 100) continue;
      if (!/clearance|cleared/i.test(`${query.question || ""} ${query.sql || ""}`)) continue;
      const prior = [...entries.slice(0, index)].reverse().find((candidate) => contractCityCount(candidate) >= 2);
      if (!prior) continue;
      const expectedCities = contractCityCount(prior);
      if (expectedCities < 2 || Number(query.rows) <= expectedCities * 1.5) continue;
      const key = `${query.id}:place_multiplicity`;
      if (existingIssueIds.has(key)) continue;
      issues.push({
        type: "place_multiplicity",
        severity: "high",
        question: query.question,
        detail: `The follow-up inherited ${expectedCities} requested cities but returned ${query.rows} rows, suggesting that some cities matched multiple agencies.`,
        tab: query.tab || "unknown",
        id: query.id,
      });
      existingIssueIds.add(key);
    }
  }


  // 1. Repeated "no such column" errors → missing feature / schema gap
  const columnErrors = {};
  for (const q of queries) {
    if (q.error) {
      const colMatch = q.error.match(/no such column:\s*(\S+)/i);
      if (colMatch) {
        const col = colMatch[1].replace(/^[a-z]\./, ""); // strip table alias
        if (!columnErrors[col]) columnErrors[col] = [];
        columnErrors[col].push(q);
      }
    }
  }
  for (const [col, qs] of Object.entries(columnErrors)) {
    if (qs.length >= 2) {
      suggestions.push({
        type: "missing_column",
        priority: "high",
        summary: `"${col}" column requested ${qs.length}× but doesn't exist in summary tables`,
        detail: `Users asked: ${qs.map(q => `"${q.question}"`).slice(0, 3).join(", ")}${qs.length > 3 ? ` (+${qs.length - 3} more)` : ""}`,
        action: `Consider adding "${col}" to the relevant summary tables, or add a prompt rule explaining it's unavailable.`,
        ids: qs.map(q => q.id),
      });
    }
  }

  // 2. Repeated DB timeouts → query pattern needs guardrail or summary table
  const timeouts = queries.filter(q => q.error && /timed? ?out/i.test(q.error));
  if (timeouts.length >= 2) {
    // Group by tab
    const byTab = {};
    for (const q of timeouts) { byTab[q.tab] = (byTab[q.tab] || 0) + 1; }
    const tabSummary = Object.entries(byTab).map(([t, n]) => `${t}: ${n}`).join(", ");
    suggestions.push({
      type: "repeated_timeouts",
      priority: "high",
      summary: `${timeouts.length} queries timed out (${tabSummary})`,
      detail: timeouts.map(q => `"${q.question}"`).slice(0, 3).join(", "),
      action: "Check if raw tables are being hit instead of summary tables. May need a new guardrail or summary table.",
      ids: timeouts.map(q => q.id),
    });
  }

  // 3. Same user hitting same wall repeatedly (same session, 3+ errors/refusals in a row)
  const bySession = {};
  for (const q of queries) {
    if (q.session_id) {
      if (!bySession[q.session_id]) bySession[q.session_id] = [];
      bySession[q.session_id].push(q);
    }
  }
  for (const [sid, sessionQueries] of Object.entries(bySession)) {
    let consecutiveFailures = 0;
    let failStreak = [];
    for (const q of sessionQueries) {
      if (q.error || (q.rows === 0 && q.sql)) {
        consecutiveFailures++;
        failStreak.push(q);
      } else {
        if (consecutiveFailures >= 3) {
          suggestions.push({
            type: "user_stuck",
            priority: "medium",
            summary: `User hit ${consecutiveFailures} consecutive failures in one session`,
            detail: failStreak.map(q => `"${q.question}" → ${q.error || "0 rows"}`).slice(0, 4).join("; "),
            action: "Review session — user may have been trying to get data the system can't provide. Consider adding better guidance or redirects.",
            ids: failStreak.map(q => q.id),
          });
        }
        consecutiveFailures = 0;
        failStreak = [];
      }
    }
    // Check trailing streak
    if (consecutiveFailures >= 3) {
      suggestions.push({
        type: "user_stuck",
        priority: "medium",
        summary: `User hit ${consecutiveFailures} consecutive failures in one session`,
        detail: failStreak.map(q => `"${q.question}" → ${q.error || "0 rows"}`).slice(0, 4).join("; "),
        action: "Review session — user may have been trying to get data the system can't provide.",
        ids: failStreak.map(q => q.id),
      });
    }
  }

  // 4. All-null results (new error type from today's fix)
  const allNullQueries = queries.filter(q => q.error === "all_null_columns");
  if (allNullQueries.length > 0) {
    suggestions.push({
      type: "all_null_results",
      priority: "medium",
      summary: `${allNullQueries.length} queries returned rows with all NULL data columns`,
      detail: allNullQueries.map(q => `"${q.question}"`).slice(0, 3).join(", "),
      action: "LLM generated SQL that computed NULL values (e.g., division by zero). Review the SQL patterns for prompt improvements.",
      ids: allNullQueries.map(q => q.id),
    });
  }

  // 5. Frequently requested topics that get refusals → feature gap
  const refusalKeywords = {};
  for (const q of queries) {
    if (!q.sql && q.response && q.rows === 0 && !isControlledOutcomeError(q.error)) {
      // Extract key topic words from questions that got refusals
      const words = q.question.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
      for (const w of words) {
        if (["what", "show", "give", "tell", "please", "about", "from", "this", "that", "have", "does", "with", "more", "also", "than", "just", "like", "would", "could", "into", "over", "last", "year", "years", "data", "crime", "trend", "rate"].includes(w)) continue;
        refusalKeywords[w] = (refusalKeywords[w] || 0) + 1;
      }
    }
  }
  const hotTopics = Object.entries(refusalKeywords)
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (hotTopics.length > 0) {
    suggestions.push({
      type: "feature_gap",
      priority: "medium",
      summary: `Frequently refused topics: ${hotTopics.map(([w, n]) => `"${w}" (${n}×)`).join(", ")}`,
      detail: "These keywords appear in 3+ questions that got refusals. May indicate data users expect but the system can't provide.",
      action: "Review whether these topics can be addressed with existing data or need new data sources.",
      ids: [],
    });
  }

  return { stats, issues, suggestions };
}

const HUMAN_INCIDENT_TYPES = new Set([
  "error", "answerable_no_sql", "missing_source_alternative", "place_multiplicity",
  "json_parse_failure", "sql_leak", "entity_hallucination", "potential_refusal",
]);

function buildHumanIncidents(queries, issues) {
  const queryById = new Map(queries.map((query) => [query.id, query]));
  const groups = new Map();
  for (const issue of issues) {
    if (!HUMAN_INCIDENT_TYPES.has(issue.type) || issue.id === null || issue.id === undefined) continue;
    const query = queryById.get(issue.id);
    if (!query) continue;
    const key = query.session_id ? `session:${query.session_id}` : `query:${query.id}`;
    const group = groups.get(key) || { queries: new Map(), issues: [] };
    group.queries.set(query.id, query);
    group.issues.push(issue);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const sessionId = group.queries.values().next().value?.session_id;
    if (sessionId) {
      for (const query of queries) {
        if (query.session_id === sessionId) group.queries.set(query.id, query);
      }
    }
    const sessionQueries = [...group.queries.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0) || Number(a.id) - Number(b.id));
    const types = new Set(group.issues.map((issue) => issue.type));
    const ids = [...new Set(group.issues.map((issue) => issue.id))].sort((a, b) => a - b);
    const bestQuestion = [...sessionQueries]
      .filter((query) => ids.includes(query.id))
      .sort((a, b) => String(b.question || "").length - String(a.question || "").length)[0]?.question || "User request";

    const clearanceJourney = sessionQueries.some((query) => /clearance|cleared/i.test(query.question || "")) &&
      (types.has("answerable_no_sql") || types.has("place_multiplicity"));
    const comparisonFailure = types.has("error") && sessionQueries.some((query) => /\bcompare\b/i.test(query.question || ""));

    let title = "User request needs attention";
    if (clearanceJourney) title = "Multi-city clearance request failed repeatedly";
    else if (comparisonFailure) title = "Historical city comparison failed";
    else if (types.has("answerable_no_sql")) title = "Answerable request produced no answer";
    else if (types.has("place_multiplicity")) title = "Location results may include extra agencies";
    else if (types.has("missing_source_alternative")) title = "User was not directed to an available data source";
    else if (types.has("json_parse_failure") || types.has("sql_leak")) title = "Technical text was shown to the user";

    const happened = [];
    if (types.has("missing_source_alternative")) happened.push("The first answer said the selected source could not answer, but did not direct the user to the source that could.");
    if (types.has("answerable_no_sql")) happened.push("A later, specific request had enough information to answer, but the system returned no results.");
    if (types.has("place_multiplicity")) happened.push("The follow-up appears to have matched several agencies for some cities, so the returned table may not be trustworthy.");
    if (types.has("error")) happened.push("The system could not complete the request and delivered an error instead of an answer.");
    if (types.has("entity_hallucination")) happened.push("The written answer named a place that did not match the data request.");
    if (types.has("json_parse_failure") || types.has("sql_leak")) happened.push("Internal technical text appeared in the user-facing answer.");
    if (types.has("potential_refusal") && !types.has("answerable_no_sql")) happened.push("The system may have declined a request that the available data could answer.");

    const actions = [];
    if (types.has("answerable_no_sql")) actions.push("retry incomplete generated answers automatically");
    if (types.has("missing_source_alternative")) actions.push("recommend the appropriate data source when the selected source cannot answer");
    if (types.has("place_multiplicity")) actions.push("require verified agency matches for multi-city requests");
    if (types.has("error")) actions.push("route eligible comparisons through the reliable built-in comparison path");
    if (types.has("entity_hallucination")) actions.push("compare places named in the answer with the requested places");
    if (types.has("json_parse_failure") || types.has("sql_leak")) actions.push("strengthen the user-facing response filter");

    const confirmed = types.has("error") || types.has("answerable_no_sql") || types.has("json_parse_failure");
    return {
      severity: confirmed ? "confirmed" : types.has("place_multiplicity") || types.has("entity_hallucination") ? "likely" : "review",
      title,
      question: bestQuestion,
      whatHappened: happened.join(" "),
      impact: confirmed
        ? "High - the user did not receive a usable answer."
        : types.has("place_multiplicity") || types.has("entity_hallucination")
          ? "High - an answer was delivered, but its results may be unreliable."
          : "Moderate - the user reached a dead end or received incomplete guidance.",
      action: actions.length ? `Recommended fix: ${actions.join("; ")}.` : "Review the session and determine the appropriate product fix.",
      ids,
    };
  }).sort((a, b) => {
    const order = { confirmed: 0, likely: 1, review: 2 };
    return order[a.severity] - order[b.severity] || a.ids[0] - b.ids[0];
  });
}

function evidenceExcerpt(value, limit = 320) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "None recorded";
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function alignmentAssessment(query, incidents) {
  if (isControlledOutcomeError(query.error)) return { tone: "good", label: "Supported data limitation explained correctly" };
  if (query.error) return { tone: "bad", label: "Failed before alignment could be established" };
  if (!query.sql) return { tone: "review", label: "No SQL was produced, so the chain is incomplete" };
  if (!query.response) return { tone: "review", label: "SQL ran, but no written answer was recorded" };
  const incident = incidents.find((item) => item.ids.includes(query.id));
  if (incident) {
    return {
      tone: incident.severity === "confirmed" ? "bad" : "review",
      label: incident.severity === "confirmed"
        ? "A failure or mismatch was detected"
        : "A possible mismatch needs review",
    };
  }
  return { tone: "good", label: "No mismatch detected by current checks" };
}
function buildHumanEmail(stats, incidents, queries, visitors) {

  const date = new Date(cutoff).toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago",
  });
  const confirmed = incidents.filter((incident) => incident.severity === "confirmed").length;
  const likely = incidents.filter((incident) => incident.severity === "likely").length;
  const review = incidents.filter((incident) => incident.severity === "review").length;
  const affectedIds = new Set(incidents.flatMap((incident) => incident.ids));
  const noDetectedIssue = Math.max(0, queries.length - affectedIds.size);
  const statusColor = confirmed > 0 ? "#b42318" : likely > 0 ? "#b54708" : "#067647";

  let html = `<!DOCTYPE html><html><head><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#252525;max-width:700px;margin:0 auto;padding:20px;line-height:1.45}
h1{font-size:23px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 12px}.sub{color:#667085;font-size:14px}.summary{background:#f8f9fb;border-radius:10px;padding:16px;margin:20px 0}.summary strong{font-size:28px;color:${statusColor}}
.incident{border:1px solid #e4e7ec;border-left:5px solid #b42318;border-radius:8px;padding:15px;margin:12px 0}.incident.likely{border-left-color:#b54708}.incident.review{border-left-color:#667085}.label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;color:#667085}.title{font-size:16px;font-weight:700;margin:3px 0 10px}.question{background:#f8f9fb;border-radius:6px;padding:9px 11px;margin:7px 0 11px;font-size:13px}.row{margin:7px 0;font-size:13px}.quiet{color:#667085;font-size:12px}.healthy{background:#ecfdf3;border-radius:8px;padding:13px 15px}.uncertain{background:#fffaeb;border-radius:8px;padding:13px 15px}.alignment{border:1px solid #e4e7ec;border-radius:8px;padding:13px;margin:10px 0}.alignment.good{border-left:5px solid #067647}.alignment.review{border-left:5px solid #b54708}.alignment.bad{border-left:5px solid #b42318}.evidence{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;background:#f8f9fb;padding:8px;border-radius:5px;margin:4px 0 9px;overflow-wrap:anywhere}.footer{border-top:1px solid #e4e7ec;margin-top:28px;padding-top:12px;color:#98a2b3;font-size:11px}
</style></head><body><h1>Crime Data Assistant - Daily Answer Review</h1><div class="sub">${escapeHtml(date)}</div>
<div class="summary"><strong>${stats.total}</strong> questions reviewed<br><span>${confirmed} confirmed failure${confirmed === 1 ? "" : "s"} | ${likely} likely incorrect answer${likely === 1 ? "" : "s"} | ${review} item${review === 1 ? "" : "s"} to review | ${noDetectedIssue} with no problem detected</span></div>
<p class="quiet">"No problem detected" means the automated review found nothing suspicious. It is not a guarantee that every answer was correct.</p>`;

  if (incidents.length) {
    html += `<h2>Needs attention</h2>`;
    for (const incident of incidents.slice(0, 8)) {
      const status = incident.severity === "confirmed" ? "Confirmed failure" : incident.severity === "likely" ? "Likely incorrect" : "Needs review";
      html += `<div class="incident ${incident.severity}"><div class="label">${status}</div><div class="title">${escapeHtml(incident.title)}</div><div class="label">What the user wanted</div><div class="question">${escapeHtml(incident.question)}</div><div class="row"><strong>What happened:</strong> ${escapeHtml(incident.whatHappened)}</div><div class="row"><strong>User impact:</strong> ${escapeHtml(incident.impact)}</div><div class="row"><strong>Next step:</strong> ${escapeHtml(incident.action)}</div><div class="quiet">Queries: ${incident.ids.join(", ")}</div></div>`;
    }
    if (incidents.length > 8) html += `<p class="quiet">${incidents.length - 8} additional lower-priority incident${incidents.length - 8 === 1 ? "" : "s"} recorded in the audit database.</p>`;
  } else {
    html += `<h2>Needs attention</h2><div class="healthy"><strong>No user-visible failures were detected.</strong></div>`;
  }

  html += renderProofShadowSection(buildProofShadowReport(queries, isHumanQuery));

  html += `<h2>Question - SQL - answer alignment</h2><p class="quiet">This shows the evidence for each real user query. "No mismatch detected" means the current semantic checks found the request, SQL, and written answer consistent; it does not independently verify every returned number because result rows are not stored in the query log.</p>`;
  for (const query of queries.slice(-12).reverse()) {
    const assessment = alignmentAssessment(query, incidents);
    const rowSummary = isControlledOutcomeError(query.error)
      ? "No database query needed; the requested measure is outside this source"
      : query.error ? `Error: ${evidenceExcerpt(query.error, 180)}` : `${Number(query.rows) || 0} database row${Number(query.rows) === 1 ? "" : "s"} returned`;
    const chartAudit = query.chartAudit || { status: "not-applicable", summary: "No chart was produced." };
    const chartLabel = chartAudit.status === "incorrect" ? "Chart problem"
      : chartAudit.status === "needs-review" ? "Chart needs review" : "Chart";
    html += `<div class="alignment ${assessment.tone}"><div class="label">Query ${query.id} | ${escapeHtml(query.tab || "unknown")}</div><div class="title">${escapeHtml(assessment.label)}</div><div class="label">User question</div><div class="question">${escapeHtml(query.question || "")}</div><div class="label">SQL sent to the database</div><div class="evidence">${escapeHtml(evidenceExcerpt(query.sql))}</div><div class="row"><strong>Database result:</strong> ${escapeHtml(rowSummary)}</div><div class="row"><strong>${chartLabel}:</strong> ${escapeHtml(chartAudit.summary)}</div><div class="label">Written answer</div><div class="question">${escapeHtml(evidenceExcerpt(query.response, 420))}</div></div>`;
  }
  if (queries.length > 12) html += `<p class="quiet">${queries.length - 12} earlier real-user quer${queries.length - 12 === 1 ? "y was" : "ies were"} omitted from this compact view.</p>`;

  const healthy = [];
  if (stats.jsonParseFailures === 0 && stats.sqlLeaks === 0) healthy.push("No internal technical text was shown to users.");
  if (stats.errors === 0) healthy.push("No requests ended in a recorded system error.");
  if (stats.slowQueries === 0) healthy.push("No unusually slow requests were detected.");
  if (healthy.length) html += `<h2>What looked healthy</h2><div class="healthy">${healthy.map((item) => `&bull; ${escapeHtml(item)}`).join("<br>")}</div>`;

  html += `<h2>What remains uncertain</h2><div class="uncertain">The review can detect known failure patterns, but it still cannot fully verify every number or every location in a returned table. A clean result means "nothing suspicious found," not "independently proven correct."`;
  // Say plainly when the chart auditor did not run. Without this the charts
  // above read as "unverified" and a reader reasonably concludes the checker
  // looked and was unsure, rather than that nothing looked at all.
  const chartHealth = stats.chartAuditorHealth || {};
  if (!chartHealth.available) {
    html += `<br><br><strong>Charts were not independently checked in this period.</strong> ${escapeHtml(chartHealth.reason || "Rendered-chart auditor health is unknown.")}`;
  }
  html += `</div>`;
  if (visitors) html += `<p class="quiet" style="margin-top:18px">Usage context: ${visitors.pageviews} page view${visitors.pageviews === 1 ? "" : "s"} from ${visitors.uniqueSessions} visitor session${visitors.uniqueSessions === 1 ? "" : "s"}.</p>`;
  html += `<div class="footer">Technical detector details remain in the audit database and are intentionally omitted from this human-facing email.</div></body></html>`;
  return html;
}

function getScoreboard() {
  try {
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scoreboard_runs'")
      .get();
    if (!tableExists) return null;
    const rows = db.prepare("SELECT * FROM scoreboard_runs ORDER BY id DESC LIMIT 2").all();
    if (rows.length === 0) return null;
    return { latest: rows[0], prev: rows[1] || null };
  } catch (err) {
    console.error("Scoreboard read failed:", err.message);
    return null;
  }
}

function buildEmail(stats, issues, visitors, suggestions, weeklyTrends, resolverWarningAudit, shrCoverageAudit) {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const highIssues = issues.filter((i) => i.severity === "high");
  const mediumIssues = issues.filter((i) => i.severity === "medium");
  const lowIssues = issues.filter((i) => i.severity === "low");

  // Deduplicate unknown agencies
  const uniqueAgencies = [...new Set(stats.unknownAgencies)];

  let html = `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #333; max-width: 700px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 22px; margin-bottom: 5px; }
  h2 { font-size: 17px; color: #555; margin-top: 28px; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
  .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 16px 0; }
  .stat-box { background: #f8f8f8; border-radius: 8px; padding: 14px; text-align: center; }
  .stat-num { font-size: 28px; font-weight: 700; }
  .stat-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  .tab-row { display: flex; gap: 8px; margin: 12px 0; }
  .tab-pill { padding: 4px 12px; border-radius: 12px; font-size: 13px; font-weight: 600; color: white; }
  .issue-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px 14px; margin: 8px 0; }
  .issue-card.high { border-left: 4px solid #d32f2f; }
  .issue-card.medium { border-left: 4px solid #f57c00; }
  .issue-card.low { border-left: 4px solid #fbc02d; }
  .issue-type { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .issue-type.high { color: #d32f2f; }
  .issue-type.medium { color: #f57c00; }
  .issue-type.low { color: #9e9e00; }
  .issue-question { font-size: 14px; font-weight: 600; margin-bottom: 3px; }
  .issue-detail { font-size: 12px; color: #666; }
  .issue-meta { font-size: 11px; color: #aaa; margin-top: 4px; }
  .no-issues { color: #4caf50; font-weight: 600; font-size: 15px; padding: 20px; text-align: center; background: #f1f8e9; border-radius: 8px; }
  .agency-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .agency-chip { background: #e3f2fd; color: #1565c0; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 500; }
  .footer { margin-top: 30px; padding-top: 16px; border-top: 1px solid #eee; font-size: 11px; color: #aaa; }
</style>
</head>
<body>
<h1>Crime Data Assistant</h1>
<div class="subtitle">${date}</div>`;

  // Nightly scoreboard (top of email — the single accuracy number)
  const scoreboard = getScoreboard();
  if (scoreboard) {
    const { latest, prev } = scoreboard;
    const scored = latest.passed + latest.failed;
    const pct = scored > 0 ? ((100 * latest.passed) / scored).toFixed(1) : "0.0";
    let deltaStr = "";
    if (prev) {
      const delta = 100 * (latest.accuracy - prev.accuracy);
      const sign = delta >= 0 ? "+" : "";
      const color = delta >= 0 ? "#2e7d32" : "#c62828";
      deltaStr = ` <span style="color:${color}; font-size: 13px;">(${sign}${delta.toFixed(1)} pts vs prior run)</span>`;
    }
    const failedIds = JSON.parse(latest.failed_ids || "[]");
    const flakyIds = JSON.parse(latest.flaky_ids || "[]");
    const flakyStr = flakyIds.length > 0 ? ` <span style="color:#f57c00; font-size: 13px;">(${flakyIds.length} flaky — passed on retry)</span>` : "";
    html += `<h2>Nightly Scoreboard</h2>
    <p style="font-size: 18px; margin: 8px 0;"><strong>${latest.passed}/${scored} passed (${pct}%)</strong>${deltaStr}${flakyStr}</p>
    <p style="font-size: 12px; color: #888; margin: 4px 0;">Run ${latest.run_ts} against ${latest.host} — ${latest.inconclusive} inconclusive (excluded from score)</p>`;
    if (failedIds.length > 0) {
      html += `<p style="font-size: 13px;"><strong>Failing cases:</strong> ${failedIds.join(", ")}<br>
      <span style="color: #888;">Rerun: <code>npx tsx scripts/live-replay.ts --rerun ${failedIds.join(",")}</code></span></p>`;
    }
    if (flakyIds.length > 0) {
      html += `<p style="font-size: 13px;"><strong>Flaky cases (failed once, passed on retry):</strong> ${flakyIds.join(", ")}</p>`;
    }
  }

  const resolverTotal = Object.values(stats.resolverTags).reduce((sum, count) => sum + count, 0);
  if (resolverTotal > 0) {
    const resolved = stats.resolverTags["nibrs-place-resolved"];
    const blocked = stats.resolverTags["nibrs-place-resolution-block"];
    const warned = stats.resolverTags["nibrs-resolved-ori-warn-only"];
    const shrBlocked = stats.resolverTags["shr-place-resolution-block"];
    const shrMissing = stats.resolverTags["shr-ori-not-in-source"];
    const shrRewritten = stats.resolverTags["shr-resolved-ori-rewritten"];
    const shrWarned = stats.resolverTags["shr-resolved-ori-warn-only"];
    const shrCoverageCount = stats.resolverTags["shr-coverage-count"];
    const shrCoverageZero = stats.resolverTags["shr-coverage-validated-zero"];
    const shrCoverageGap = stats.resolverTags["shr-coverage-gap"];
    const shrCoverageUnknown = stats.resolverTags["shr-coverage-coverage-unknown"];
    const shrPresentationChanged = stats.resolverTags["shr-coverage-presentation-changed"];
    html += `<h2>Resolver Outcomes</h2>
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-num">${resolved}</div><div class="stat-label">Resolved Queries</div></div>
      <div class="stat-box"><div class="stat-num">${blocked}</div><div class="stat-label">Unsafe Resolutions Blocked</div></div>
      <div class="stat-box"><div class="stat-num" style="color:${warned > 0 ? "#f57c00" : "#4caf50"}">${warned}</div><div class="stat-label">Model ORI Warnings</div></div>
      <div class="stat-box"><div class="stat-num">${shrBlocked}</div><div class="stat-label">SHR Resolution Blocks</div></div>
      <div class="stat-box"><div class="stat-num">${shrMissing}</div><div class="stat-label">SHR ORIs Not Found</div></div>
      <div class="stat-box"><div class="stat-num">${shrRewritten}</div><div class="stat-label">SHR ORI Rewrites</div></div>
      <div class="stat-box"><div class="stat-num" style="color:${shrWarned > 0 ? "#f57c00" : "#4caf50"}">${shrWarned}</div><div class="stat-label">SHR ORI Warnings</div></div>
      <div class="stat-box"><div class="stat-num">${shrCoverageCount}</div><div class="stat-label">SHR Counts Shown</div></div>
      <div class="stat-box"><div class="stat-num">${shrCoverageZero}</div><div class="stat-label">Validated Zeroes</div></div>
      <div class="stat-box"><div class="stat-num">${shrCoverageGap}</div><div class="stat-label">SHR Gaps</div></div>
      <div class="stat-box"><div class="stat-num">${shrCoverageUnknown}</div><div class="stat-label">Coverage Unknown</div></div>
      <div class="stat-box"><div class="stat-num" style="color:${shrPresentationChanged > 0 ? "#f57c00" : "#4caf50"}">${shrPresentationChanged}</div><div class="stat-label">Presentation Changed</div></div>
    </div>`;
  }

  if (resolverWarningAudit) {
    const rate = resolverWarningAudit.falsePositiveRate == null
      ? "unavailable"
      : `${(resolverWarningAudit.falsePositiveRate * 100).toFixed(1)}%`;
    html += `<h2>Resolver Warning Classification Gate</h2>
    <p style="font-size:13px;color:#666;">Rejection remains <strong>OFF</strong>. The gate requires every warning shape classified and a false-positive rate below 5%.</p>
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-num">${resolverWarningAudit.total}</div><div class="stat-label">Warning Shapes</div></div>
      <div class="stat-box"><div class="stat-num" style="color:${resolverWarningAudit.unclassified > 0 ? "#f57c00" : "#4caf50"}">${resolverWarningAudit.unclassified}</div><div class="stat-label">Unclassified</div></div>
      <div class="stat-box"><div class="stat-num">${resolverWarningAudit.new_shapes}</div><div class="stat-label">New Shapes Today</div></div>
      <div class="stat-box"><div class="stat-num">${rate}</div><div class="stat-label">False-Positive Rate</div></div>
      <div class="stat-box"><div class="stat-num" style="color:${resolverWarningAudit.ready ? "#4caf50" : "#f57c00"}">${resolverWarningAudit.ready ? "READY" : "NOT READY"}</div><div class="stat-label">Classification Gate</div></div>
    </div>`;
  }

  if (shrCoverageAudit) {
    html += `<h2>SHR Annual Coverage Classification</h2>`;
    if (shrCoverageAudit.artifactPending) {
      html += `<p style="font-size:13px;color:#f57c00;">The deployed comparison table has not yet been upgraded with annual display fields.</p>`;
    } else {
      html += `<div class="stat-grid">
        <div class="stat-box"><div class="stat-num">${shrCoverageAudit.unresolved_joins}</div><div class="stat-label">Unresolved Joins</div></div>
        <div class="stat-box"><div class="stat-num">${shrCoverageAudit.comparison_conflicts}</div><div class="stat-label">SHR/Return-A Conflicts</div></div>
        <div class="stat-box"><div class="stat-num">${shrCoverageAudit.classifications_changed_today}</div><div class="stat-label">Classifications Changed Today</div></div>
        <div class="stat-box"><div class="stat-num">${shrCoverageAudit.presentation_changed}</div><div class="stat-label">Rows Displayed Differently</div></div>
        <div class="stat-box"><div class="stat-num" style="color:${shrCoverageAudit.positive_counts_hidden > 0 ? "#d32f2f" : "#4caf50"}">${shrCoverageAudit.positive_counts_hidden}</div><div class="stat-label">Positive Counts Hidden</div></div>
        <div class="stat-box"><div class="stat-num" style="color:${shrCoverageAudit.invalid_zeroes > 0 ? "#d32f2f" : "#4caf50"}">${shrCoverageAudit.invalid_zeroes}</div><div class="stat-label">Invalid Zeroes</div></div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;">
        <thead><tr style="border-bottom:2px solid #ddd;"><th style="text-align:left;padding:6px;">Display Status</th><th style="text-align:right;padding:6px;">Rows</th><th style="text-align:right;padding:6px;">SHR Victims</th></tr></thead>
        <tbody>${shrCoverageAudit.displayStatuses.map((row) => `<tr style="border-bottom:1px solid #eee;"><td style="padding:6px;">${escapeHtml(row.status)}</td><td style="padding:6px;text-align:right;">${row.rows}</td><td style="padding:6px;text-align:right;">${row.victims || 0}</td></tr>`).join("")}</tbody>
      </table>`;
    }
  }

  // Traffic sources section (top of email)
  if (visitors) {
    const yesterdayLabel = new Date(cutoff).toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago",
    });
    html += `<h2>Traffic — ${yesterdayLabel}</h2>
    <div class="stat-grid">
      <div class="stat-box">
        <div class="stat-num">${visitors.pageviews}</div>
        <div class="stat-label">Page Views</div>
      </div>
      <div class="stat-box">
        <div class="stat-num">${visitors.uniqueSessions}</div>
        <div class="stat-label">Unique Visitors</div>
      </div>
      <div class="stat-box">
        <div class="stat-num">${visitors.directVisits} / ${visitors.referredVisits}</div>
        <div class="stat-label">Direct / Referred</div>
      </div>
    </div>`;

    if (visitors.monthlyTotals.length > 0) {
      html += `<h2>Monthly Totals</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;">
        <thead>
          <tr style="border-bottom:2px solid #ddd;">
            <th style="text-align:left;padding:8px 6px;font-weight:600;color:#555;">Month</th>
            <th style="text-align:right;padding:8px 6px;font-weight:600;color:#555;">Page Views</th>
            <th style="text-align:right;padding:8px 6px;font-weight:600;color:#555;">Unique Visitors</th>
            <th style="text-align:right;padding:8px 6px;font-weight:600;color:#555;">Pages / Visitor</th>
          </tr>
        </thead>
        <tbody>`;
      for (const m of visitors.monthlyTotals) {
        const ppv = m.unique_visitors > 0 ? (m.pageviews / m.unique_visitors).toFixed(1) : "—";
        html += `<tr style="border-bottom:1px solid #eee;">
          <td style="padding:6px;font-weight:600;">${m.month}</td>
          <td style="padding:6px;text-align:right;">${m.pageviews}</td>
          <td style="padding:6px;text-align:right;">${m.unique_visitors}</td>
          <td style="padding:6px;text-align:right;">${ppv}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }

    if (visitors.topDomains.length > 0) {
      html += `<h2>Top Referrer Domains</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;">
        <thead>
          <tr style="border-bottom:2px solid #ddd;">
            <th style="text-align:left;padding:8px 6px;font-weight:600;color:#555;">Domain</th>
            <th style="text-align:right;padding:8px 6px;font-weight:600;color:#555;">Visits</th>
          </tr>
        </thead>
        <tbody>`;
      for (const d of visitors.topDomains) {
        html += `<tr style="border-bottom:1px solid #eee;">
          <td style="padding:6px;">${escapeHtml(d.referrer_domain)}</td>
          <td style="padding:6px;text-align:right;font-weight:600;">${d.visits}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }

    if (visitors.topReferrers.length > 0) {
      html += `<h2>Top Referring Pages</h2>
      <p style="font-size:12px;color:#888;margin-bottom:8px;">Specific URLs that sent visitors to the site.</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0;">
        <thead>
          <tr style="border-bottom:2px solid #ddd;">
            <th style="text-align:left;padding:8px 6px;font-weight:600;color:#555;">Page</th>
            <th style="text-align:right;padding:8px 6px;font-weight:600;color:#555;">Visits</th>
          </tr>
        </thead>
        <tbody>`;
      for (const r of visitors.topReferrers) {
        const displayUrl = r.referrer.length > 80 ? r.referrer.substring(0, 80) + "..." : r.referrer;
        html += `<tr style="border-bottom:1px solid #eee;">
          <td style="padding:6px;word-break:break-all;">
            <a href="${escapeHtml(r.referrer)}" style="color:#475EC7;text-decoration:none;">${escapeHtml(displayUrl)}</a>
          </td>
          <td style="padding:6px;text-align:right;font-weight:600;">${r.visits}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }

    if (visitors.utmCampaigns.length > 0) {
      html += `<h2>UTM Campaigns</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;">
        <thead>
          <tr style="border-bottom:2px solid #ddd;">
            <th style="text-align:left;padding:8px 6px;font-weight:600;color:#555;">Source</th>
            <th style="text-align:left;padding:8px 6px;font-weight:600;color:#555;">Medium</th>
            <th style="text-align:left;padding:8px 6px;font-weight:600;color:#555;">Campaign</th>
            <th style="text-align:right;padding:8px 6px;font-weight:600;color:#555;">Visits</th>
          </tr>
        </thead>
        <tbody>`;
      for (const u of visitors.utmCampaigns) {
        html += `<tr style="border-bottom:1px solid #eee;">
          <td style="padding:6px;">${escapeHtml(u.utm_source)}</td>
          <td style="padding:6px;">${escapeHtml(u.utm_medium || "—")}</td>
          <td style="padding:6px;">${escapeHtml(u.utm_campaign || "—")}</td>
          <td style="padding:6px;text-align:right;font-weight:600;">${u.visits}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }
  }

  html += `
<h2>Overview</h2>
<div class="stat-grid">
  <div class="stat-box">
    <div class="stat-num">${stats.total}</div>
    <div class="stat-label">Total Queries</div>
  </div>
  <div class="stat-box">
    <div class="stat-num">${stats.avgMs ? (stats.avgMs / 1000).toFixed(1) + "s" : "—"}</div>
    <div class="stat-label">Avg Response</div>
  </div>
  <div class="stat-box">
    <div class="stat-num">${stats.medianMs ? (stats.medianMs / 1000).toFixed(1) + "s" : "—"}</div>
    <div class="stat-label">Median Response</div>
  </div>
</div>

<div class="tab-row">`;

  const tabColors = {
    current: "#475EC7",
    historical: "#8B5E3C",
    nibrs: "#2d8659",
  };

  for (const [tab, count] of Object.entries(stats.byTab).sort(
    (a, b) => b[1] - a[1]
  )) {
    const color = tabColors[tab] || "#666";
    html += `<span class="tab-pill" style="background:${color}">${tab}: ${count}</span>`;
  }

  html += `</div>

<div class="stat-grid">
  <div class="stat-box">
    <div class="stat-num" style="color:${stats.errors > 0 ? "#d32f2f" : "#4caf50"}">${stats.errors}</div>
    <div class="stat-label">Errors</div>
  </div>
  <div class="stat-box">
    <div class="stat-num" style="color:${stats.zeroRows > 0 ? "#f57c00" : "#4caf50"}">${stats.zeroRows}</div>
    <div class="stat-label">Zero-Row Results</div>
  </div>
  <div class="stat-box">
    <div class="stat-num" style="color:${stats.slowQueries > 0 ? "#f57c00" : "#4caf50"}">${stats.slowQueries}</div>
    <div class="stat-label">Slow (&gt;10s)</div>
  </div>
</div>

<div class="stat-grid">
  <div class="stat-box">
    <div class="stat-num" style="color:${stats.jsonParseFailures > 0 ? "#d32f2f" : "#4caf50"}">${stats.jsonParseFailures}</div>
    <div class="stat-label">JSON Parse Failures</div>
  </div>
  <div class="stat-box">
    <div class="stat-num" style="color:${stats.yearHallucinations > 0 ? "#f57c00" : "#4caf50"}">${stats.yearHallucinations}</div>
    <div class="stat-label">Year Hallucinations</div>
  </div>
  <div class="stat-box">
    <div class="stat-num" style="color:${stats.sqlLeaks > 0 ? "#d32f2f" : "#4caf50"}">${stats.sqlLeaks}</div>
    <div class="stat-label">SQL Leaks</div>
  </div>
</div>

<div class="stat-grid">
  <div class="stat-box">
    <div class="stat-num" style="color:${stats.entityHallucinations > 0 ? "#d32f2f" : "#4caf50"}">${stats.entityHallucinations}</div>
    <div class="stat-label">Entity Hallucinations</div>
  </div>
  <div class="stat-box">
    <div class="stat-num" style="color:${stats.unnecessaryRefusals > 0 ? "#f57c00" : "#4caf50"}">${stats.unnecessaryRefusals}</div>
    <div class="stat-label">Potential Refusals</div>
  </div>
  <div class="stat-box">
    <div class="stat-num" style="color:#4caf50">&nbsp;</div>
    <div class="stat-label">&nbsp;</div>
  </div>
</div>`;

  // Guardrails section
  const guardrailEntries = Object.entries(stats.guardrailFires).sort((a, b) => b[1] - a[1]);
  if (guardrailEntries.length > 0) {
    const pct = stats.total > 0 ? ((stats.guardrailTotal / stats.total) * 100).toFixed(1) : "0";
    html += `<h2>Guardrails</h2>
    <p style="font-size:13px;color:#666;margin-bottom:12px;">${stats.guardrailTotal} of ${stats.total} queries triggered a routing or validation safeguard (${pct}%). Some entries are informational resolver outcomes; retry and override tags indicate corrected model behavior.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;">
      <thead>
        <tr style="border-bottom:2px solid #ddd;">
          <th style="text-align:left;padding:8px 6px;font-weight:600;color:#555;">Guardrail</th>
          <th style="text-align:right;padding:8px 6px;font-weight:600;color:#555;">Fires</th>
          <th style="text-align:right;padding:8px 6px;font-weight:600;color:#555;">% of Queries</th>
        </tr>
      </thead>
      <tbody>`;
    for (const [name, count] of guardrailEntries) {
      const firePct = stats.total > 0 ? ((count / stats.total) * 100).toFixed(1) : "0";
      const color = count >= 5 ? "#d32f2f" : count >= 2 ? "#f57c00" : "#333";
      html += `<tr style="border-bottom:1px solid #eee;">
        <td style="padding:6px;font-family:monospace;font-size:12px;">${escapeHtml(name)}</td>
        <td style="padding:6px;text-align:right;font-weight:600;color:${color};">${count}</td>
        <td style="padding:6px;text-align:right;color:#888;">${firePct}%</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  } else {
    html += `<h2>Guardrails</h2><p style="font-size:13px;color:#4caf50;">No guardrails fired in the past 24 hours.</p>`;
  }

  // Reliability categories: always show counts and examples; only counts above
  // each inline threshold also become medium-priority action items above.
  const reliabilityEntries = Object.entries(stats.reliabilityCategories).filter(([, signal]) => signal.count > 0 || signal.resolvedCount > 0);
  if (reliabilityEntries.length > 0) {
    html += "<h2>Reliability Signals</h2><p style=\"font-size:13px;color:#666;\">These are informational counts from deterministic guardrail tags. Unresolved counts are thresholded for attention; resolved retries are reported separately as a prompt-quality signal.</p><table style=\"width:100%;border-collapse:collapse;font-size:13px;\"><thead><tr style=\"border-bottom:2px solid #ddd;\"><th style=\"text-align:left;padding:8px 6px;\">Category</th><th style=\"text-align:right;padding:8px 6px;\">Unresolved</th><th style=\"text-align:right;padding:8px 6px;\">Resolved retries</th><th style=\"text-align:left;padding:8px 6px;\">Examples</th></tr></thead><tbody>";
    for (const [category, signal] of reliabilityEntries) {
      html += "<tr style=\"border-bottom:1px solid #eee;\"><td style=\"padding:6px;font-family:monospace;font-size:12px;\">" + escapeHtml(category) + "</td><td style=\"padding:6px;text-align:right;font-weight:600;\">" + signal.count + "</td><td style=\"padding:6px;text-align:right;\">" + signal.resolvedCount + "</td><td style=\"padding:6px;color:#666;\">" + escapeHtml(signal.examples.join(" | ") + (signal.resolvedExamples.length ? "; resolved: " + signal.resolvedExamples.join(" | ") : "")) + "</td></tr>";
    }
    html += "</tbody></table>";
  }
  // Cross-artifact auditor is internal-only: it never changes a user response.
  if (stats.auditDetectorStats && stats.auditDetectorStats.length > 0) {
    const health = stats.auditorHealth || {};
    // A named line, so "the auditor is broken" can never be mistaken for
    // "the auditor found nothing".
    let healthLine;
    if (!health.available) {
      healthLine = "<strong style=\"color:#b00;\">Auditor run: UNAVAILABLE</strong> &mdash; " + escapeHtml(health.reason || "unknown reason") + ". The counts below are not a clean bill of health.";
    } else if (!health.covered) {
      healthLine = "<strong style=\"color:#b00;\">Auditor run: BEHIND</strong> &mdash; " + health.coverageGap + " of yesterday&rsquo;s rows were never audited.";
    } else {
      healthLine = "Auditor run " + health.runId + ": " + health.rowsAudited + " rows audited, " + health.findingsWritten + " findings written."
        + (health.inert && health.inert.length ? " <strong style=\"color:#b00;\">Inert detectors: " + escapeHtml(health.inert.join(", ")) + "</strong> (missing reference data &mdash; their zeros mean nothing)." : "");
    }
    html += "<h2>Cross-artifact Auditor</h2><p style=\"font-size:13px;color:#666;\">Internal, non-gating checks compare each question, SQL, and narrative. Users never see these findings.</p><p style=\"font-size:13px;\">" + healthLine + "</p>";

    if (stats.detectorConfirmed && stats.detectorConfirmed.length > 0) {
      html += "<table style=\"width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px;\"><thead><tr style=\"border-bottom:2px solid #ddd;\"><th style=\"text-align:left;padding:8px 6px;\">Defect class</th><th style=\"text-align:right;padding:8px 6px;\">Confirmed by both</th><th style=\"text-align:right;padding:8px 6px;\">Detector only</th><th style=\"text-align:right;padding:8px 6px;\">Digest only</th></tr></thead><tbody>";
      for (const family of stats.detectorConfirmed) {
        html += "<tr style=\"border-bottom:1px solid #eee;\"><td style=\"padding:6px;\">" + escapeHtml(family.family) + (family.examples.length ? "<div style=\"color:#666;font-size:12px;\">" + escapeHtml(family.examples.join(" | ")) + "</div>" : "") + "</td><td style=\"padding:6px;text-align:right;font-weight:600;\">" + family.confirmed + "</td><td style=\"padding:6px;text-align:right;\">" + family.detectorOnly + "</td><td style=\"padding:6px;text-align:right;\">" + family.digestOnly + "</td></tr>";
      }
      html += "</tbody></table>";
    }

    html += "<table style=\"width:100%;border-collapse:collapse;font-size:13px;\"><thead><tr style=\"border-bottom:2px solid #ddd;\"><th style=\"text-align:left;padding:8px 6px;\">Detector</th><th style=\"text-align:right;padding:8px 6px;\">Flagged</th><th style=\"text-align:right;padding:8px 6px;\">Unflagged</th><th style=\"text-align:left;padding:8px 6px;\">Status / examples</th></tr></thead><tbody>";
    for (const detector of stats.auditDetectorStats) {
      const flagged = detector.flagged === null ? "&mdash;" : detector.flagged;
      const unflagged = detector.unflagged === null ? "&mdash;" : detector.unflagged;
      html += "<tr style=\"border-bottom:1px solid #eee;\"><td style=\"padding:6px;font-family:monospace;font-size:12px;\">" + escapeHtml(detector.id + " " + detector.category) + "</td><td style=\"padding:6px;text-align:right;font-weight:600;\">" + flagged + "</td><td style=\"padding:6px;text-align:right;\">" + unflagged + "</td><td style=\"padding:6px;color:#666;\">" + escapeHtml(detector.status + (detector.examples.length ? ": " + detector.examples.join(" | ") : "")) + "</td></tr>";
    }
    html += "</tbody></table>";
  }
  // Issues section
  if (highIssues.length > 0 || mediumIssues.length > 0) {
    html += `<h2>Issues Requiring Attention</h2>`;

    for (const issue of [...highIssues, ...mediumIssues].slice(0, 20)) {
      const typeLabels = {
        error: "Error",
        zero_rows: "No Results",
        slow: "Slow Query",
        json_parse_failure: "Code Leaked to User",
        sql_leak: "SQL in Explanation",
        year_hallucination: "Year Hallucination",
        entity_hallucination: "Entity Hallucination",
        potential_refusal: "Potential Unnecessary Refusal",
      };
      html += `
      <div class="issue-card ${issue.severity}">
        <div class="issue-type ${issue.severity}">${typeLabels[issue.type] || issue.type}</div>
        <div class="issue-question">&ldquo;${escapeHtml(issue.question)}&rdquo;</div>
        <div class="issue-detail">${escapeHtml(issue.detail)}</div>
        <div class="issue-meta">ID: ${issue.id} &middot; Tab: ${issue.tab}</div>
      </div>`;
    }
  }

  if (lowIssues.length > 0) {
    html += `<h2>Minor Issues (${lowIssues.length})</h2>`;
    for (const issue of lowIssues.slice(0, 10)) {
      html += `
      <div class="issue-card ${issue.severity}">
        <div class="issue-type ${issue.severity}">Year Hallucination</div>
        <div class="issue-question">&ldquo;${escapeHtml(issue.question)}&rdquo;</div>
        <div class="issue-detail">${escapeHtml(issue.detail)}</div>
        <div class="issue-meta">ID: ${issue.id} &middot; Tab: ${issue.tab}</div>
      </div>`;
    }
  }

  if (issues.length === 0) {
    html += `<h2>Issues</h2><div class="no-issues">No issues detected in the past 24 hours.</div>`;
  }

  // Unknown agencies
  if (uniqueAgencies.length > 0) {
    html += `<h2>Agencies Users Asked About (Not in Dataset)</h2>
    <p style="font-size:13px;color:#666;">These agencies were requested but not found. Consider adding them if they appear frequently.</p>
    <div class="agency-list">`;
    for (const a of uniqueAgencies) {
      html += `<span class="agency-chip">${escapeHtml(a)}</span>`;
    }
    html += `</div>`;
  }

  // Suggestions section
  if (suggestions && suggestions.length > 0) {
    html += `<h2>Suggestions</h2>
    <p style="font-size:13px;color:#666;margin-bottom:12px;">Patterns detected across today's queries that may warrant action.</p>`;
    for (const s of suggestions) {
      const priorityColor = s.priority === "high" ? "#d32f2f" : s.priority === "medium" ? "#f57c00" : "#888";
      html += `
      <div style="background:#fff;border:1px solid #e0e0e0;border-left:4px solid ${priorityColor};border-radius:8px;padding:12px 14px;margin:8px 0;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:${priorityColor};margin-bottom:4px;">${escapeHtml(s.type.replace(/_/g, " "))}</div>
        <div style="font-size:14px;font-weight:600;margin-bottom:4px;">${escapeHtml(s.summary)}</div>
        <div style="font-size:12px;color:#666;margin-bottom:4px;">${escapeHtml(s.detail)}</div>
        <div style="font-size:12px;color:#1565c0;font-weight:500;">→ ${escapeHtml(s.action)}</div>
        ${s.ids.length > 0 ? `<div style="font-size:11px;color:#aaa;margin-top:4px;">Query IDs: ${s.ids.join(", ")}</div>` : ""}
      </div>`;
    }
  }

  // Weekly trends section
  if (weeklyTrends) {
    html += `<h2>7-Day Trends</h2>`;

    // Daily volume bar
    if (weeklyTrends.dailyVolume) {
      const maxQ = Math.max(...weeklyTrends.dailyVolume.map(d => d.queries));
      html += `<table style="width:100%;border-collapse:collapse;font-size:12px;margin:12px 0;">
        <thead><tr style="border-bottom:2px solid #ddd;">
          <th style="text-align:left;padding:6px;font-weight:600;color:#555;">Day</th>
          <th style="text-align:right;padding:6px;font-weight:600;color:#555;">Queries</th>
          <th style="text-align:right;padding:6px;font-weight:600;color:#555;">Errors</th>
          <th style="text-align:left;padding:6px;font-weight:600;color:#555;width:40%;">Volume</th>
        </tr></thead><tbody>`;
      for (const d of weeklyTrends.dailyVolume) {
        const pct = maxQ > 0 ? Math.round((d.queries / maxQ) * 100) : 0;
        const dayLabel = d.day.slice(5); // MM-DD
        html += `<tr style="border-bottom:1px solid #eee;">
          <td style="padding:4px 6px;font-family:monospace;">${dayLabel}</td>
          <td style="padding:4px 6px;text-align:right;font-weight:600;">${d.queries}</td>
          <td style="padding:4px 6px;text-align:right;color:${d.errors > 0 ? "#d32f2f" : "#4caf50"};">${d.errors}</td>
          <td style="padding:4px 6px;"><div style="background:#475EC7;height:14px;width:${pct}%;border-radius:3px;"></div></td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }

    // Repeated column errors across the week
    if (weeklyTrends.repeatedColumnErrors) {
      html += `<h3 style="font-size:14px;color:#555;margin-top:20px;">Repeated Missing Columns (7 days)</h3>`;
      for (const r of weeklyTrends.repeatedColumnErrors) {
        html += `<div style="background:#fff3e0;border-radius:6px;padding:10px 12px;margin:6px 0;font-size:13px;">
          <strong style="color:#e65100;">"${escapeHtml(r.column)}"</strong> — requested ${r.count}× this week
          <div style="font-size:11px;color:#888;margin-top:3px;">e.g., ${r.questions.map(q => `"${escapeHtml(q.substring(0, 60))}"`).join(", ")}</div>
        </div>`;
      }
    }

    // Weekly timeouts
    if (weeklyTrends.weeklyTimeouts) {
      const t = weeklyTrends.weeklyTimeouts;
      html += `<div style="background:#ffebee;border-radius:6px;padding:10px 12px;margin:6px 0;font-size:13px;">
        <strong style="color:#c62828;">${t.total} timeouts this week</strong>
        (${t.byTab.map(b => `${b.tab}: ${b.cnt}`).join(", ")})
      </div>`;
    }

    // Top recurring errors
    if (weeklyTrends.topErrors) {
      html += `<h3 style="font-size:14px;color:#555;margin-top:20px;">Top Recurring Errors (7 days)</h3>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin:8px 0;">
        <tbody>`;
      for (const e of weeklyTrends.topErrors) {
        html += `<tr style="border-bottom:1px solid #eee;">
          <td style="padding:4px 6px;font-weight:600;color:#d32f2f;width:40px;">${e.cnt}×</td>
          <td style="padding:4px 6px;">${escapeHtml(e.error.substring(0, 120))}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }

    // Refusal hot keywords
    if (weeklyTrends.refusalHotKeywords) {
      html += `<h3 style="font-size:14px;color:#555;margin-top:20px;">Most Refused Topics (7 days)</h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;">`;
      for (const [kw, n] of weeklyTrends.refusalHotKeywords) {
        html += `<span style="background:#e3f2fd;color:#1565c0;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:500;">${escapeHtml(kw)} (${n}×)</span>`;
      }
      html += `</div>`;
    }

    // Weekly guardrail trends
    if (weeklyTrends.weeklyGuardrails) {
      html += `<h3 style="font-size:14px;color:#555;margin-top:20px;">Top Guardrails (7 days)</h3>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin:8px 0;">
        <tbody>`;
      for (const [name, cnt] of weeklyTrends.weeklyGuardrails) {
        html += `<tr style="border-bottom:1px solid #eee;">
          <td style="padding:4px 6px;font-family:monospace;">${escapeHtml(name)}</td>
          <td style="padding:4px 6px;text-align:right;font-weight:600;">${cnt}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }
  }

  html += `
<div class="footer">
  Generated by Crime Data Assistant Query Analyzer<br>
  ${stats.total} queries analyzed from the past 24 hours
</div>
</body>
</html>`;

  return html;
}

function getWeeklyTrends() {
  const trends = {};
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  try {
    // 1. Repeated column errors across the week
    const colErrors = db
      .prepare(
        `SELECT error, COUNT(*) as cnt, GROUP_CONCAT(DISTINCT question) as questions
         FROM query_log
         WHERE ts >= ? AND error LIKE '%no such column%'
         GROUP BY error
         HAVING cnt >= 3
         ORDER BY cnt DESC
         LIMIT 10`
      )
      .all(sevenDaysAgo);

    if (colErrors.length > 0) {
      trends.repeatedColumnErrors = colErrors.map((r) => {
        const col = (r.error.match(/no such column:\s*(\S+)/i) || [])[1] || r.error;
        const sampleQuestions = r.questions.split(",").slice(0, 3);
        return { column: col.replace(/^[a-z]\./, ""), count: r.cnt, questions: sampleQuestions };
      });
    }

    // 2. Repeated timeout patterns
    const timeoutCount = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM query_log WHERE ts >= ? AND error LIKE '%timed out%'`
      )
      .get(sevenDaysAgo);
    if (timeoutCount.cnt >= 3) {
      const timeoutsByTab = db
        .prepare(
          `SELECT tab, COUNT(*) as cnt FROM query_log WHERE ts >= ? AND error LIKE '%timed out%' GROUP BY tab ORDER BY cnt DESC`
        )
        .all(sevenDaysAgo);
      trends.weeklyTimeouts = { total: timeoutCount.cnt, byTab: timeoutsByTab };
    }

    // 3. Most common error messages this week
    const topErrors = db
      .prepare(
        `SELECT error, COUNT(*) as cnt
         FROM query_log
         WHERE ts >= ? AND error IS NOT NULL AND error != ''
           AND error != 'empty_result' AND error != 'all_null_columns'
         GROUP BY error
         HAVING cnt >= 3
         ORDER BY cnt DESC
         LIMIT 5`
      )
      .all(sevenDaysAgo);
    if (topErrors.length > 0) {
      trends.topErrors = topErrors;
    }

    // 4. Frequently requested but unavailable — questions with refusals (sql IS NULL) that share keywords
    const refusals = db
      .prepare(
        `SELECT question FROM query_log WHERE ts >= ? AND sql IS NULL AND rows = 0`
      )
      .all(sevenDaysAgo);
    if (refusals.length >= 5) {
      const kwCounts = {};
      for (const r of refusals) {
        const words = r.question.toLowerCase().match(/\b[a-z]{5,}\b/g) || [];
        const seen = new Set();
        for (const w of words) {
          if (seen.has(w)) continue;
          seen.add(w);
          if (["about", "their", "there", "these", "those", "which", "would", "could", "should", "where", "since", "years", "trend", "crime", "other", "current", "historical", "please", "provide", "cities", "states"].includes(w)) continue;
          kwCounts[w] = (kwCounts[w] || 0) + 1;
        }
      }
      const hotKeywords = Object.entries(kwCounts)
        .filter(([, n]) => n >= 3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      if (hotKeywords.length > 0) {
        trends.refusalHotKeywords = hotKeywords;
      }
    }

    // 5. Daily query volume for the week (for sparkline context)
    const dailyVolume = db
      .prepare(
        `SELECT
           strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') as day,
           COUNT(*) as queries,
           SUM(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END) as errors
         FROM query_log
         WHERE ts >= ?
         GROUP BY day
         ORDER BY day`
      )
      .all(sevenDaysAgo);
    if (dailyVolume.length > 0) {
      trends.dailyVolume = dailyVolume;
    }

    // 6. Guardrails trending — which guardrails fired most this week
    const weeklyGuardrails = db
      .prepare(
        `SELECT guardrails FROM query_log WHERE ts >= ? AND guardrails IS NOT NULL AND guardrails != ''`
      )
      .all(sevenDaysAgo);
    if (weeklyGuardrails.length > 0) {
      const gCounts = {};
      for (const r of weeklyGuardrails) {
        for (const g of r.guardrails.split(",")) {
          const name = g.trim();
          if (name) gCounts[name] = (gCounts[name] || 0) + 1;
        }
      }
      const topGuardrails = Object.entries(gCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      if (topGuardrails.length > 0) {
        trends.weeklyGuardrails = topGuardrails;
      }
    }

  } catch (err) {
    console.warn("Error computing weekly trends:", err.message);
  }

  return Object.keys(trends).length > 0 ? trends : null;
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function persistFindings(issues) {
  if (issues.length === 0) return;
  try {
    const writeDb = new Database(QUERY_LOG_DB_PATH);
    writeDb.pragma("busy_timeout = 10000");
    writeDb.exec(`
      CREATE TABLE IF NOT EXISTS audit_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_log_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        finding TEXT NOT NULL,
        proposed_fix TEXT,
        status TEXT DEFAULT 'open',
        source TEXT NOT NULL DEFAULT 'legacy'
      )
    `);

    // Provenance matters because a second writer (the Phase 1 detector runner)
    // shares this table. Without a `source` column the two are indistinguishable
    // and their conflict policies fight over (query_log_id, category).
    //
    // Deliberately NOT recreating the old 2-column unique index here: on a
    // migrated database that index has been replaced by the 3-column version,
    // and recreating it would re-impose a constraint the detector writer breaks.
    const hasSource = writeDb
      .prepare("PRAGMA table_info(audit_findings)")
      .all()
      .some((column) => column.name === "source");

    let insert;
    if (hasSource) {
      writeDb.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_findings_unique_v2
        ON audit_findings (query_log_id, category, source)
      `);
      insert = writeDb.prepare(
        "INSERT OR IGNORE INTO audit_findings (query_log_id, ts, severity, category, finding, source) VALUES (?, ?, ?, ?, ?, ?)"
      );
    } else {
      // Unmigrated database: keep working rather than dropping the digest email.
      console.warn("audit_findings has no `source` column; run scripts/migrate-audit-findings-source.js. Writing without provenance.");
      writeDb.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_findings_unique
        ON audit_findings (query_log_id, category)
      `);
      insert = writeDb.prepare(
        "INSERT OR IGNORE INTO audit_findings (query_log_id, ts, severity, category, finding) VALUES (?, ?, ?, ?, ?)"
      );
    }

    const now = Date.now();
    // Count what was actually written. `INSERT OR IGNORE` silently skips rows
    // that already exist, so incrementing per iteration over-reported the total
    // on every rerun.
    let inserted = 0;
    let skipped = 0;
    for (const issue of issues) {
      const args = [issue.id, now, issue.severity, issue.type, issue.detail];
      if (hasSource) args.push(DIGEST_FINDING_SOURCE);
      const result = insert.run(...args);
      if (result.changes > 0) inserted++;
      else skipped++;
    }
    writeDb.close();
    console.log(`Persisted ${inserted} new findings to audit_findings (${skipped} already present, unchanged)`);
  } catch (err) {
    console.warn("Failed to persist findings:", err.message);
  }
}

async function main() {
  const isTestEmail = process.argv.includes("--test-email");
  console.log(
    `Analyzing queries since ${new Date(cutoff).toISOString()}...`
  );
  const allQueries = getQueries();
  const queries = allQueries.filter(isHumanQuery);
  const chartAuditorHealth = getChartAuditorHealth();
  if (!chartAuditorHealth.available) {
    console.warn(`[chart-audit] NOT healthy for this window: ${chartAuditorHealth.reason}`);
  }
  attachChartAuditResults(queries, chartAuditorHealth);
  const excluded = allQueries.length - queries.length;
  console.log(`Found ${queries.length} user queries (${excluded} automated/test queries excluded)`);

  const { stats, issues, suggestions } = analyze(queries);
  stats.chartAuditorHealth = chartAuditorHealth;
  const visitors = getVisitors();
  console.log(
    `Stats: ${stats.total} queries, ${stats.errors} errors, ${issues.length} issues, ${suggestions.length} suggestions, ${visitors ? visitors.pageviews + " pageviews" : "no visitor data yet"}`
  );

  // A test send previews real coverage without altering the audit record.
  if (!isTestEmail) persistFindings(issues);

  const incidents = buildHumanIncidents(queries, issues);
  const html = buildHumanEmail(stats, incidents, queries, visitors);

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  if (process.argv.includes("--dry-run")) {
    fs.mkdirSync("audit", { recursive: true });
    fs.writeFileSync("audit/daily-email-preview.html", html);
    console.log("Dry run — email written to audit/daily-email-preview.html, not sent");
    return;
  }

  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: TO_EMAIL,
      subject: `${isTestEmail ? "[TEST] " : ""}Crime Data Assistant Daily Answer Review - ${today}`,
      html,
    });
    console.log("Email sent:", result);
  } catch (err) {
    console.error("Failed to send email:", err);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { analyze, buildHumanIncidents, buildHumanEmail, contractLooksAnswerable, contractCityCount, isHumanQuery, recordReliabilityTag };
