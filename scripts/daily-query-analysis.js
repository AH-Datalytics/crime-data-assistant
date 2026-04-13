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

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TO_EMAIL = "jasher@ahdatalytics.com";
const FROM_EMAIL = "Crime Data Assistant <onboarding@resend.dev>";

if (!RESEND_API_KEY) {
  console.error("RESEND_API_KEY environment variable is required");
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);
const db = new Database(path.join(__dirname, "..", "query_log.db"), {
  readonly: true,
});

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
    sqlLeaks: 0,
    avgMs: 0,
    medianMs: 0,
    unknownAgencies: [],
    guardrailFires: {},  // { guardrailName: count }
    guardrailTotal: 0,   // queries where at least 1 guardrail fired
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
        if (name) stats.guardrailFires[name] = (stats.guardrailFires[name] || 0) + 1;
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

  return { stats, issues };
}

function buildEmail(stats, issues, visitors) {
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
</div>`;

  // Guardrails section
  const guardrailEntries = Object.entries(stats.guardrailFires).sort((a, b) => b[1] - a[1]);
  if (guardrailEntries.length > 0) {
    const pct = stats.total > 0 ? ((stats.guardrailTotal / stats.total) * 100).toFixed(1) : "0";
    html += `<h2>Guardrails</h2>
    <p style="font-size:13px;color:#666;margin-bottom:12px;">${stats.guardrailTotal} of ${stats.total} queries triggered a guardrail (${pct}%). Each guardrail fire means Claude's initial SQL was wrong and was caught server-side.</p>
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

  html += `
<div class="footer">
  Generated by Crime Data Assistant Query Analyzer<br>
  ${stats.total} queries analyzed from the past 24 hours
</div>
</body>
</html>`;

  return html;
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

  const { stats, issues } = analyze(queries);
  const visitors = getVisitors();
  console.log(
    `Stats: ${stats.total} queries, ${stats.errors} errors, ${issues.length} issues, ${visitors ? visitors.pageviews + " pageviews" : "no visitor data yet"}`
  );

  const html = buildEmail(stats, issues, visitors);

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

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
