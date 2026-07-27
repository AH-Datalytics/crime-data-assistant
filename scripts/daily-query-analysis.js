#!/usr/bin/env node
/**
 * Daily Query Analysis for Crime Data Assistant
 * Scans the query_log for the past 24 hours and emails a digest of
 * common failures, issues, and usage patterns.
 *
 * Run via cron: 0 12 * * * cd /opt/nibrs/app && node scripts/daily-query-analysis.js
 */

const Database = require("better-sqlite3");
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

function getQueries() {
  return db
    .prepare("SELECT * FROM query_log WHERE ts >= ? AND ts < ? ORDER BY ts ASC")
    .all(cutoff, cutoffEnd);
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
    resolverTags: {
      "nibrs-place-resolved": 0,
      "nibrs-place-resolution-block": 0,
      "nibrs-resolved-ori-warn-only": 0,
      "shr-place-resolution-block": 0,
      "shr-ori-not-in-source": 0,
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
    if (q.error) {
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
    if (!q.sql && q.response && q.rows === 0) {
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
        const name = g.trim();
        if (name) {
          stats.guardrailFires[name] = (stats.guardrailFires[name] || 0) + 1;
          if (Object.hasOwn(stats.resolverTags, name)) stats.resolverTags[name]++;
        }
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

  // --- Pattern detection: cluster issues into actionable suggestions ---
  const suggestions = [];

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
    if (!q.sql && q.response && q.rows === 0) {
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

function buildEmail(stats, issues, visitors, suggestions, weeklyTrends) {
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
    html += `<h2>Resolver Outcomes</h2>
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-num">${resolved}</div><div class="stat-label">Resolved Queries</div></div>
      <div class="stat-box"><div class="stat-num">${blocked}</div><div class="stat-label">Unsafe Resolutions Blocked</div></div>
      <div class="stat-box"><div class="stat-num" style="color:${warned > 0 ? "#f57c00" : "#4caf50"}">${warned}</div><div class="stat-label">Model ORI Warnings</div></div>
      <div class="stat-box"><div class="stat-num">${shrBlocked}</div><div class="stat-label">SHR Resolution Blocks</div></div>
      <div class="stat-box"><div class="stat-num">${shrMissing}</div><div class="stat-label">SHR ORIs Not Found</div></div>
    </div>`;
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
    writeDb.exec(`
      CREATE TABLE IF NOT EXISTS audit_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_log_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        finding TEXT NOT NULL,
        proposed_fix TEXT,
        status TEXT DEFAULT 'open'
      )
    `);
    // Create unique index to prevent duplicate findings on rerun
    writeDb.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_findings_unique
      ON audit_findings (query_log_id, category)
    `);
    const insert = writeDb.prepare(
      "INSERT OR IGNORE INTO audit_findings (query_log_id, ts, severity, category, finding) VALUES (?, ?, ?, ?, ?)"
    );
    const now = Date.now();
    let count = 0;
    for (const issue of issues) {
      insert.run(issue.id, now, issue.severity, issue.type, issue.detail);
      count++;
    }
    writeDb.close();
    console.log(`Persisted ${count} findings to audit_findings`);
  } catch (err) {
    console.warn("Failed to persist findings:", err.message);
  }
}

async function main() {
  console.log(
    `Analyzing queries since ${new Date(cutoff).toISOString()}...`
  );
  const queries = getQueries();
  console.log(`Found ${queries.length} queries`);

  if (queries.length === 0) {
    console.log("No queries in the past 24 hours, skipping email");
    return;
  }

  const { stats, issues, suggestions } = analyze(queries);
  const visitors = getVisitors();
  const weeklyTrends = getWeeklyTrends();
  console.log(
    `Stats: ${stats.total} queries, ${stats.errors} errors, ${issues.length} issues, ${suggestions.length} suggestions, ${visitors ? visitors.pageviews + " pageviews" : "no visitor data yet"}`
  );

  // Persist findings to audit_findings table
  persistFindings(issues);

  const html = buildEmail(stats, issues, visitors, suggestions, weeklyTrends);

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
      subject: `Crime Data Assistant Daily Analysis - ${today}`,
      html,
    });
    console.log("Email sent:", result);
  } catch (err) {
    console.error("Failed to send email:", err);
    process.exit(1);
  }
}

main();
