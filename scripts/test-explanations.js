#!/usr/bin/env node
/**
 * Explanation Quality Test Suite
 *
 * Runs representative queries across all 3 tabs against the live site,
 * collects the explanations, and grades them against the explain.ts rules.
 *
 * Usage: node scripts/test-explanations.js
 */

const BASE = process.env.TEST_URL || "https://nibrsai.com";
const PASSWORD = process.env.TEST_PASSWORD || "NIBRSAHD";

// ── Test queries ──────────────────────────────────────────────────────
const QUERIES = [
  // Current Trends tab
  { tab: "current", q: "Murder trend nationally 2020 to 2025" },
  { tab: "current", q: "Compare robbery in Chicago and Houston 2022-2024" },
  { tab: "current", q: "Motor vehicle theft in Los Angeles on a rolling 12 month basis" },
  { tab: "current", q: "Aggravated assault in New York City monthly since 2020" },
  { tab: "current", q: "National burglary trend by year" },

  // Historical tab
  { tab: "historical", q: "Murder rate per 100k in the United States 1960 to 2024" },
  { tab: "historical", q: "Compare murder counts in Chicago and Philadelphia 1985 to 2024" },
  { tab: "historical", q: "Robbery in California agencies since 2000" },

  // NIBRS tab
  { tab: "nibrs", q: "Annual murders in the US" },
  { tab: "nibrs", q: "Aggravated assault victims by weapon type in Texas 2022-2024" },
  { tab: "nibrs", q: "Vehicle burglary trend in New York City since 2020" },
  { tab: "nibrs", q: "Carjacking victims by state in 2024" },
  { tab: "nibrs", q: "Drug offenses involving methamphetamine nationally 2022-2024" },
];

// ── Grading rules ─────────────────────────────────────────────────────
const RULES = [
  {
    name: "no_specific_numbers",
    desc: "Must not cite specific data values (excludes '100,000' as metric label)",
    test: (exp) => {
      // Strip "per 100,000" / "per 100K" which is a metric label, not a data value
      const cleaned = exp.replace(/per\s+100[,.]?000/gi, "").replace(/per\s+100k/gi, "");
      return !/\b\d{2,},?\d{3}\b/.test(cleaned) && !/\b\d+\.\d+%/.test(cleaned);
    },
  },
  {
    name: "no_trend_language",
    desc: "Must not describe trends (higher, lower, peaked, declined, etc.)",
    test: (exp) =>
      !/\b(higher|lower|peaked|declined|increased|decreased|rose|fell|dropped|surged|spiked|consistently|ranging from)\b/i.test(exp),
  },
  {
    name: "no_comparisons",
    desc: "Must not compare values between entities",
    test: (exp) =>
      !/\b(compared to|more than|less than|outpaced|exceeded|surpassed|lagged)\b/i.test(exp),
  },
  {
    name: "no_causal_language",
    desc: "Must not speculate about causes",
    test: (exp) =>
      !/\b(may reflect|likely due to|could be attributed|suggests that|driven by|as a result of|because of)\b/i.test(exp),
  },
  {
    name: "no_sql_internals",
    desc: "Must not mention SQL, table names, or database internals",
    test: (exp) =>
      !/\b(SQL query|SELECT\s|FROM\s+\w+_|WHERE\s|JOIN\s|summary_\w+|agency_monthly|national_monthly|historical_\w+|nibrs_\w+|ucr_offense)\b/i.test(exp),
  },
  {
    name: "reasonable_length",
    desc: "Should be 1-3 sentences (under 500 chars before disclaimers)",
    test: (exp) => {
      // Strip Note:/disclaimer lines
      const core = exp.split(/\n\n/)[0].trim();
      return core.length <= 500;
    },
  },
  {
    name: "has_geography_or_scope",
    desc: "Should mention geography or scope (national, city, state)",
    test: (exp) =>
      /\b(national|United States|U\.S\.|state|city|county|[A-Z][a-z]+(?:,?\s+[A-Z]{2})?)\b/.test(exp),
  },
  {
    name: "current_tab_disclaimer",
    desc: "Current Trends national/state queries should mention sample/Crime Index (city queries exempt)",
    test: (exp, ctx) => {
      if (ctx.tab !== "current") return true; // skip for other tabs
      // City-level queries don't need the sample disclaimer
      if (ctx.scope === "city") return true;
      return /\b(sample|Crime Index|consistent report)\b/i.test(exp);
    },
  },
  {
    name: "nibrs_tab_has_standard_disclaimer",
    desc: "NIBRS tab should have the standard NIBRS disclaimer (appended server-side)",
    test: (exp, ctx) => {
      if (ctx.tab !== "nibrs") return true;
      return /FBI's NIBRS program/i.test(exp);
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────
let authCookie = "";

async function authenticate() {
  const res = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  // Extract Set-Cookie
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/nibrs_auth=([^;]+)/);
  if (match) authCookie = `nibrs_auth=${match[1]}`;
  else throw new Error("No auth cookie returned");
  console.log("Authenticated successfully\n");
}

async function queryCurrentOrHistorical(question, mode) {
  const res = await fetch(`${BASE}/api/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: authCookie,
    },
    body: JSON.stringify({ question, mode, history: [] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

  // Parse SSE stream
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter((e) => e.startsWith("data: "))
    .map((e) => {
      try { return JSON.parse(e.replace("data: ", "")); }
      catch { return null; }
    })
    .filter(Boolean);

  // Look for explanation event (post-query) or result event
  const explainEvent = events.find((e) => e.type === "explanation");
  const resultEvent = events.find((e) => e.type === "result");

  return {
    explanation: explainEvent?.text || resultEvent?.explanation || "",
    rowCount: resultEvent?.rowCount ?? 0,
    sql: resultEvent?.sql || "",
    error: events.find((e) => e.type === "error")?.text || null,
  };
}

async function queryNibrs(question) {
  const res = await fetch(`${BASE}/api/nibrs-query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: authCookie,
    },
    body: JSON.stringify({ question, history: [] }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    explanation: data.explanation || "",
    rowCount: data.rowCount ?? 0,
    sql: data.sql || "",
    error: data.error || null,
  };
}

function gradeExplanation(explanation, ctx) {
  const results = [];
  for (const rule of RULES) {
    const pass = rule.test(explanation, ctx);
    results.push({ name: rule.name, desc: rule.desc, pass });
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  await authenticate();

  const results = [];
  let totalPass = 0;
  let totalChecks = 0;

  for (let i = 0; i < QUERIES.length; i++) {
    const { tab, q } = QUERIES[i];
    const mode = tab === "historical" ? "historical" : tab === "current" ? "current" : "nibrs";

    console.log(`[${i + 1}/${QUERIES.length}] ${tab.toUpperCase()}: "${q}"`);

    try {
      let result;
      if (tab === "nibrs") {
        result = await queryNibrs(q);
      } else {
        result = await queryCurrentOrHistorical(q, mode);
      }

      if (result.error) {
        console.log(`  ERROR: ${result.error}\n`);
        results.push({ tab, question: q, error: result.error, grades: [] });
        continue;
      }

      if (result.rowCount === 0) {
        console.log(`  WARNING: 0 rows returned\n`);
      }

      // Determine scope for grading context: city if question mentions a specific city
      const looksLikeCity = /\bin\s+(?:New York|Los Angeles|Chicago|Houston|Dallas|Charlotte|Nashville|Memphis|Baltimore|Philadelphia|San Francisco|Las Vegas)/i.test(q) ||
        /\b(compare|vs)\b/i.test(q) && /\b[A-Z][a-z]+\b/.test(q);
      const scope = looksLikeCity ? "city" : "national";
      const grades = gradeExplanation(result.explanation, { tab, scope });
      const passed = grades.filter((g) => g.pass).length;
      const failed = grades.filter((g) => !g.pass);
      totalPass += passed;
      totalChecks += grades.length;

      console.log(`  Rows: ${result.rowCount} | Checks: ${passed}/${grades.length} passed`);

      if (failed.length > 0) {
        for (const f of failed) {
          console.log(`  FAIL: ${f.name} — ${f.desc}`);
        }
      }

      // Show first 200 chars of explanation
      const preview = result.explanation.replace(/\n/g, " ").slice(0, 200);
      console.log(`  Explanation: "${preview}${result.explanation.length > 200 ? "..." : ""}"`);
      console.log();

      results.push({
        tab,
        question: q,
        rowCount: result.rowCount,
        explanation: result.explanation,
        grades,
        sql: result.sql,
      });
    } catch (err) {
      console.log(`  EXCEPTION: ${err.message}\n`);
      results.push({ tab, question: q, error: err.message, grades: [] });
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("═".repeat(60));
  console.log("SUMMARY");
  console.log("═".repeat(60));

  const errors = results.filter((r) => r.error);
  const zeroRows = results.filter((r) => r.rowCount === 0 && !r.error);
  const allGrades = results.flatMap((r) => r.grades || []);
  const failedRules = allGrades.filter((g) => !g.pass);

  console.log(`Queries: ${QUERIES.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Zero-row results: ${zeroRows.length}`);
  console.log(`Rule checks: ${totalPass}/${totalChecks} passed (${((totalPass / totalChecks) * 100).toFixed(1)}%)`);

  if (failedRules.length > 0) {
    console.log(`\nFailed rules breakdown:`);
    const counts = {};
    for (const f of failedRules) {
      counts[f.name] = (counts[f.name] || 0) + 1;
    }
    for (const [name, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name}: ${count} failures`);
    }
  }

  if (zeroRows.length > 0) {
    console.log(`\nZero-row queries (potential bugs):`);
    for (const r of zeroRows) {
      console.log(`  [${r.tab}] "${r.question}"`);
    }
  }

  // Exit code based on results
  const hasFailures = errors.length > 0 || zeroRows.length > 0 || failedRules.length > 0;
  process.exit(hasFailures ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
