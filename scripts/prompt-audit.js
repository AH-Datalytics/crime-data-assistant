#!/usr/bin/env node
/**
 * Prompt audit — fires test queries at the live API and checks for known failure modes.
 * Usage: node scripts/prompt-audit.js [base_url]
 */

const BASE = process.argv[2] || "https://nibrsai.com";
const TIMEOUT_MS = 90000;
let _pageToken = null;

async function getPageToken() {
  try {
    const res = await fetch(`${BASE}/api/page-token`);
    const data = await res.json();
    // Token must be at least 1s old to pass validation — wait
    await new Promise(r => setTimeout(r, 1500));
    return data.token;
  } catch {
    return "";
  }
}

const tests = [
  // Current Trends
  { tab: "current", q: "Chicago murders per month", expect: { hasSQL: true, minRows: 50, offense: "Murder" } },
  { tab: "current", q: "detroit auto theft per month", expect: { hasSQL: true, minRows: 50, offense: "Motor Vehicle Theft" } },
  { tab: "current", q: "Show me theft in Omaha rolling over 12 months", expect: { hasSQL: true, minRows: 20 } },
  { tab: "current", q: "Motor vehicle thefts per month in the 5 cities with the most motor vehicle thefts in 2022", expect: { hasSQL: true, minRows: 20, noGuessedCities: true } },
  { tab: "current", q: "national murder per month", expect: { hasSQL: true, minRows: 50 } },
  { tab: "current", q: "LAPD vs NYPD murders per month", expect: { hasSQL: true, minRows: 20 } },
  { tab: "current", q: "philadelphia motor vehicle thefts per month", expect: { hasSQL: true, minRows: 50 } },
  { tab: "current", q: "How many murders last year?", expect: { hasSQL: true, minRows: 1 } },

  // Historical
  { tab: "historical", q: "Brighton, AL violent crime per year since 2000", expect: { hasSQL: true, minRows: 5, label: "Brighton must not refuse" } },
  { tab: "historical", q: "NYPD murders per year", expect: { hasSQL: true, minRows: 20 } },
  { tab: "historical", q: "NYPD staffing in the 1950s", expect: { hasSQL: true, minRows: 5 } },
  { tab: "historical", q: "LAPD vs NYPD murders since 1980", expect: { hasSQL: true, minRows: 20 } },
  { tab: "historical", q: "Show me the national murder trend from 2000 to 2020", expect: { hasSQL: true, minRows: 15 } },
  { tab: "historical", q: "Naperville, IL crime per year since 2015", expect: { hasSQL: true, minRows: 5 } },
  { tab: "historical", q: "top 10 cities by murder rate in 2020", expect: { hasSQL: true, minRows: 5, noGuessedCities: true } },

  // NIBRS
  { tab: "nibrs", q: "which big Texas cities had the highest rate of carjackings in 2025", expect: { hasSQL: true, minRows: 3 } },
  { tab: "nibrs", q: "Show me vehicle burglaries per month in Boston in 2023", expect: { hasSQL: true, minRows: 5 } },
  { tab: "nibrs", q: "What 10 cities with at least 30 murders in 2025 had the highest share of murders cleared by exception?", expect: { hasSQL: true, minRows: 3, noGuessedCities: true } },
  { tab: "nibrs", q: "Carjackings per month in Houston since 2019", expect: { hasSQL: true, minRows: 20 } },
  { tab: "nibrs", q: "What is the annual trend of violent crime in Tennessee?", expect: { hasSQL: true, minRows: 3 } },

  // SHR
  { tab: "shr", q: "Give me domestic homicide trends nationally since 2000", expect: { hasSQL: true, minRows: 15 } },
  { tab: "shr", q: "which 10 cities had the highest share of 2025 murders come via firearm (min 30 murders)", expect: { hasSQL: true, minRows: 5, noGuessedCities: true } },
  { tab: "shr", q: "North Carolina firearm homicides rolling over 12 months since 2018", expect: { hasSQL: true, minRows: 20 } },
  { tab: "shr", q: "csv of share of murders committed with a firearm and the total number of murders", expect: { hasSQL: true, minRows: 20 } },
];

async function queryAPI(tab, question) {
  const url = tab === "nibrs"
    ? `${BASE}/api/nibrs-query`
    : tab === "shr"
    ? `${BASE}/api/shr-query`
    : `${BASE}/api/query`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    if (tab === "nibrs" || tab === "shr") {
      // JSON API
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: [], sessionId: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, pageToken: await getPageToken() }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await res.json();
      return {
        sql: data.sql || null,
        rows: data.rows?.length || 0,
        explanation: data.explanation || "",
        error: data.error || null,
        success: data.success !== false,
      };
    } else {
      // SSE API (current/historical)
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, mode: tab, history: [], sessionId: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, pageToken: await getPageToken() }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      // Check if it's a JSON error (rate limit, auth)
      if (text.startsWith("{")) {
        try {
          const j = JSON.parse(text);
          return { sql: null, rows: 0, explanation: "", error: j.error || `JSON error: ${JSON.stringify(j).slice(0, 100)}`, success: false };
        } catch {}
      }
      // Parse SSE events
      const events = text.split("\n").filter(l => l.startsWith("data: ")).map(l => {
        try { return JSON.parse(l.slice(6)); } catch { return null; }
      }).filter(Boolean);
      const result = events.find(e => e.type === "result");
      const error = events.find(e => e.type === "error");
      if (result) {
        return {
          sql: result.sql || null,
          rows: result.rows?.length || 0,
          explanation: result.explanation || "",
          error: null,
          success: true,
        };
      }
      return {
        sql: null,
        rows: 0,
        explanation: error?.text || events.map(e => e.text || "").join(" "),
        error: error?.text || "No result event",
        success: false,
      };
    }
  } catch (e) {
    clearTimeout(timeout);
    return { sql: null, rows: 0, explanation: "", error: e.message, success: false };
  }
}

function checkGuessedCities(sql, question) {
  if (!sql) return [];
  const qLower = question.toLowerCase();
  const caseNames = [];
  const re = /CASE\s+WHEN\s+[^)]*(?:agency|city)\s*=\s*'([^']+)'/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].toLowerCase();
    if (!qLower.includes(name)) caseNames.push(m[1]);
  }
  return caseNames;
}

async function run() {
  console.log(`\nPrompt Audit — ${BASE}`);
  console.log(`Testing ${tests.length} queries...\n`);

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    const label = `[${t.tab}] ${t.q.slice(0, 60)}`;
    process.stdout.write(`  ${i + 1}/${tests.length} ${label}...`);

    const start = Date.now();
    let result = await queryAPI(t.tab, t.q);
    // Retry up to 2 times on rate limit
    for (let retry = 0; retry < 2 && result.error && result.error.includes("Too many requests"); retry++) {
      const wait = parseInt(result.error.match(/(\d+) seconds/)?.[1] || "15") + 3;
      process.stdout.write(` rate limited, waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      result = await queryAPI(t.tab, t.q);
    }
    const ms = Date.now() - start;

    const issues = [];

    if (t.expect.hasSQL && !result.sql) {
      issues.push(`NO SQL generated (refused). Explanation: "${result.explanation?.slice(0, 100)}"`);
    }
    if (t.expect.minRows && result.rows < t.expect.minRows) {
      issues.push(`Only ${result.rows} rows (expected >= ${t.expect.minRows})`);
    }
    if (t.expect.offense && result.sql && !result.sql.toLowerCase().includes(t.expect.offense.toLowerCase())) {
      issues.push(`Missing offense filter: ${t.expect.offense}`);
    }
    if (t.expect.noGuessedCities && result.sql) {
      const guessed = checkGuessedCities(result.sql, t.q);
      if (guessed.length > 0) {
        issues.push(`GUESSED city names in CASE WHEN: ${guessed.join(", ")}`);
      }
    }
    if (result.error && !result.sql) {
      issues.push(`Error: ${result.error.slice(0, 100)}`);
    }
    if (ms > 60000) {
      issues.push(`SLOW: ${(ms / 1000).toFixed(1)}s`);
    }

    if (issues.length === 0) {
      console.log(` ✓ ${result.rows} rows, ${(ms / 1000).toFixed(1)}s`);
      passed++;
    } else {
      console.log(` ✗ FAIL`);
      for (const issue of issues) {
        console.log(`      → ${issue}`);
      }
      failed++;
      failures.push({ label, issues, sql: result.sql?.slice(0, 200) });
    }

    // Delay to avoid rate limiting (8s between queries)
    await new Promise(r => setTimeout(r, 8000));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  ${f.label}`);
      for (const issue of f.issues) console.log(`    → ${issue}`);
    }
  }
  console.log();
}

run().catch(console.error);
