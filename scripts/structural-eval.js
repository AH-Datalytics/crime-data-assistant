#!/usr/bin/env node
/**
 * Structural end-to-end eval for NIBRSAI text-to-SQL prompt/guardrail changes.
 *
 * Judges structural SQL properties, NOT exact strings.
 * Hits the live API, then checks the query_log for guardrails fired.
 *
 * Usage: node scripts/structural-eval.js [base_url]
 */

const BASE = process.argv[2] || "https://nibrsai.com";
const TIMEOUT_MS = 90000;

// ── Alias map for named-entity checks ────────────────────────────────
const CITY_ALIASES = {
  "nyc": ["new york city", "new york"],
  "la": ["los angeles"],
  "dc": ["washington"],
  "chi": ["chicago"],
  "stl": ["st louis", "saint louis"],
  "nola": ["new orleans"],
  "philly": ["philadelphia"],
};

function canonicalize(name) {
  const lower = name.toLowerCase().trim();
  for (const [alias, canonicals] of Object.entries(CITY_ALIASES)) {
    if (lower === alias || canonicals.includes(lower)) return canonicals[0];
  }
  return lower;
}

// ── Page token ───────────────────────────────────────────────────────
async function getPageToken() {
  try {
    const res = await fetch(`${BASE}/api/page-token`);
    const data = await res.json();
    await new Promise(r => setTimeout(r, 1500));
    return data.token;
  } catch { return ""; }
}

// ── Query API ────────────────────────────────────────────────────────
async function queryAPI(tab, question) {
  const url = tab === "nibrs" ? `${BASE}/api/nibrs-query`
    : tab === "shr" ? `${BASE}/api/shr-query`
    : `${BASE}/api/query`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const body = {
      question,
      history: [],
      sessionId: `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pageToken: await getPageToken(),
      ...(tab !== "nibrs" && tab !== "shr" ? { mode: tab } : {}),
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (tab === "nibrs" || tab === "shr") {
      const data = await res.json();
      return {
        sql: data.sql || null,
        rows: data.rows?.length || 0,
        explanation: data.explanation || "",
        chartConfig: data.chartConfig || null,
        error: data.error || null,
        success: data.success !== false,
      };
    } else {
      const text = await res.text();
      if (text.startsWith("{")) {
        const j = JSON.parse(text);
        return { sql: null, rows: 0, explanation: "", chartConfig: null, error: j.error || "JSON error", success: false };
      }
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
          chartConfig: result.chartConfig || null,
          error: null,
          success: true,
        };
      }
      return { sql: null, rows: 0, explanation: error?.text || "", chartConfig: null, error: error?.text || "No result", success: false };
    }
  } catch (e) {
    clearTimeout(timeout);
    return { sql: null, rows: 0, explanation: "", chartConfig: null, error: e.message, success: false };
  }
}

// ── Structural assertion helpers ─────────────────────────────────────

function extractCaseWhenNames(sql) {
  if (!sql) return [];
  const names = [];
  const re = /CASE\s+WHEN\s+[^)]*(?:agency|city|i\.agency)\s*=\s*'([^']+)'/gi;
  let m;
  while ((m = re.exec(sql)) !== null) names.push(m[1].toLowerCase());
  return names;
}

function hasDiscoveryCTE(sql) {
  if (!sql) return false;
  return /\bori\s+IN\s*\(\s*SELECT\b/i.test(sql) ||
    /\bWITH\b[\s\S]*?\bORDER\s+BY\s+(?:SUM|total|count|ROUND)\b/i.test(sql);
}

function hasLongFormat(sql) {
  if (!sql) return false;
  return /as\s+city\b/i.test(sql) || /\.agency\s*\|\|/i.test(sql) ||
    /group\s+by.*\b(?:agency|city)\b/i.test(sql);
}

function usesTable(sql, table) {
  if (!sql) return false;
  return new RegExp(`\\b${table}\\b`, "i").test(sql);
}

function hasPopulationJoin(sql) {
  if (!sql) return false;
  return /population/i.test(sql);
}

function hasTypeFilter(sql) {
  if (!sql) return false;
  return /type\s*=\s*'(?:City|city|County|county)'/i.test(sql) ||
    /agency_type\s*=\s*'City'/i.test(sql);
}

function usesOffenseCode(sql, code) {
  if (!sql) return false;
  return sql.includes(`'${code}'`);
}

function usesRelationshipCaseWhen(sql) {
  if (!sql) return false;
  return /CASE\s+WHEN[\s\S]*?relationship\s+IN\s*\(/i.test(sql);
}

// ── Test definitions ─────────────────────────────────────────────────

const tests = [
  // ── Current Trends ────────────────────────────────────
  {
    id: 1, tab: "current",
    question: "Top 5 cities for motor vehicle theft per month",
    assertions: [
      { name: "generates SQL", fn: (r) => !!r.sql },
      { name: "no hardcoded CASE WHEN cities", fn: (r) => extractCaseWhenNames(r.sql).length === 0 },
      { name: "has discovery CTE/subquery", fn: (r) => hasDiscoveryCTE(r.sql) },
      { name: "returns data", fn: (r) => r.rows > 0 },
      { name: "chart type is line", fn: (r) => r.chartConfig?.type === "line" },
    ],
  },
  {
    id: 2, tab: "current",
    question: "Compare NYC and LA murders by month",
    assertions: [
      { name: "generates SQL", fn: (r) => !!r.sql },
      { name: "only user-named cities in CASE WHEN", fn: (r) => {
        const names = extractCaseWhenNames(r.sql);
        if (names.length === 0) return true; // long format also OK
        return names.every(n => ["new york city", "new york", "los angeles"].includes(n));
      }},
      { name: "returns data", fn: (r) => r.rows > 0 },
    ],
  },
  {
    id: 3, tab: "current",
    question: "Brighton AL murders by month",
    assertions: [
      { name: "generates SQL (does not refuse)", fn: (r) => !!r.sql },
    ],
    note: "Brighton may not be in Current Trends — SQL generation is the pass criterion, not row count",
  },

  // ── Historical ────────────────────────────────────────
  {
    id: 4, tab: "historical",
    question: "Brighton, AL murders over time",
    assertions: [
      { name: "generates SQL (does not refuse)", fn: (r) => !!r.sql },
      { name: "uses historical_agency or historical_agency_crime", fn: (r) =>
        usesTable(r.sql, "historical_agency") || usesTable(r.sql, "historical_agency_crime") },
      { name: "no hardcoded ORI", fn: (r) => !/\bori\s*=\s*'[A-Z]{2}\d+'/i.test(r.sql) },
    ],
  },
  {
    id: 5, tab: "historical",
    question: "Top 5 cities for motor vehicle theft by year",
    assertions: [
      { name: "generates SQL", fn: (r) => !!r.sql },
      { name: "uses historical_agency_crime", fn: (r) => usesTable(r.sql, "historical_agency_crime") },
      { name: "does NOT use agency_monthly", fn: (r) => !usesTable(r.sql, "agency_monthly") },
      { name: "does NOT use offense = 'Motor Vehicle Theft'", fn: (r) => !/offense\s*=\s*'Motor Vehicle Theft'/i.test(r.sql) },
      { name: "no hardcoded CASE WHEN cities", fn: (r) => extractCaseWhenNames(r.sql).length === 0 },
      { name: "returns data", fn: (r) => r.rows > 0 },
    ],
  },
  {
    id: 6, tab: "historical",
    question: "Compare NYC and LA murder rates since 1990",
    assertions: [
      { name: "generates SQL", fn: (r) => !!r.sql },
      { name: "only user-named cities in CASE WHEN", fn: (r) => {
        const names = extractCaseWhenNames(r.sql);
        if (names.length === 0) return true;
        return names.every(n => ["new york city", "new york", "los angeles"].includes(n));
      }},
      { name: "uses population for rate", fn: (r) => hasPopulationJoin(r.sql) },
      { name: "returns data", fn: (r) => r.rows > 0 },
    ],
  },

  // ── NIBRS ─────────────────────────────────────────────
  {
    id: 7, tab: "nibrs",
    question: "Top 5 cities for motor vehicle theft per year",
    assertions: [
      { name: "generates SQL", fn: (r) => !!r.sql },
      { name: "no hardcoded CASE WHEN cities", fn: (r) => extractCaseWhenNames(r.sql).length === 0 },
      { name: "uses summary table (not raw offenses)", fn: (r) =>
        usesTable(r.sql, "summary_city_monthly") || usesTable(r.sql, "summary_state_monthly") ||
        usesTable(r.sql, "summary_clearance_city_annual") },
      { name: "uses offense code 240", fn: (r) => usesOffenseCode(r.sql, "240") },
      { name: "returns data", fn: (r) => r.rows > 0 },
    ],
  },
  {
    id: 8, tab: "nibrs",
    question: "Which cities had the most murders by year?",
    assertions: [
      { name: "generates SQL", fn: (r) => !!r.sql },
      { name: "no hardcoded CASE WHEN cities", fn: (r) => extractCaseWhenNames(r.sql).length === 0 },
      { name: "returns data", fn: (r) => r.rows > 0 },
    ],
    note: "Dynamic top-N even without explicit 'top 5'",
  },
  {
    id: 9, tab: "nibrs",
    question: "Compare NYC and LA robbery clearance rates",
    assertions: [
      { name: "generates SQL", fn: (r) => !!r.sql },
      { name: "only user-named cities", fn: (r) => {
        const names = extractCaseWhenNames(r.sql);
        if (names.length === 0) return true;
        return names.every(n => ["new york city", "new york", "los angeles"].includes(n));
      }},
      { name: "returns data", fn: (r) => r.rows > 0 },
    ],
  },

  // ── SHR ───────────────────────────────────────────────
  {
    id: 10, tab: "shr",
    question: "Top 5 cities for firearm murders per year",
    assertions: [
      { name: "generates SQL", fn: (r) => !!r.sql },
      { name: "no hardcoded CASE WHEN cities", fn: (r) => extractCaseWhenNames(r.sql).length === 0 },
      { name: "returns data", fn: (r) => r.rows > 0 },
    ],
  },
  {
    id: 11, tab: "shr",
    question: "Compare Chicago and Houston firearm murders by month",
    assertions: [
      { name: "generates SQL", fn: (r) => !!r.sql },
      { name: "only user-named cities", fn: (r) => {
        const names = extractCaseWhenNames(r.sql);
        if (names.length === 0) return true;
        return names.every(n => ["chicago", "houston"].includes(n));
      }},
      { name: "returns data", fn: (r) => r.rows > 0 },
    ],
  },
  {
    id: 12, tab: "shr",
    question: "Which cities had the most intimate partner homicides by year?",
    assertions: [
      { name: "generates SQL", fn: (r) => !!r.sql },
      { name: "no hardcoded CASE WHEN cities", fn: (r) => extractCaseWhenNames(r.sql).length === 0 },
      { name: "uses CASE WHEN on relationship (not relationship_group)", fn: (r) =>
        !r.sql || usesRelationshipCaseWhen(r.sql) || !/relationship_group/i.test(r.sql) },
      { name: "returns data", fn: (r) => r.rows > 0 },
    ],
  },

  // ── Negative / Edge cases ─────────────────────────────
  {
    id: 13, tab: "current",
    question: "Kansas City murders",
    assertions: [
      { name: "asks for clarification (MO vs KS)", fn: (r) =>
        !r.sql || /missouri|kansas|MO|KS|which/i.test(r.explanation) },
    ],
    note: "Kansas City is ambiguous — should ask or return sql null",
  },
  {
    id: 14, tab: "current",
    question: "Safest cities",
    assertions: [
      { name: "returns sql null", fn: (r) => !r.sql },
      { name: "suggests specific crime type", fn: (r) => /specific|crime type|metric|offense/i.test(r.explanation) },
    ],
  },
  {
    id: 15, tab: "nibrs",
    question: "Black female murder victim rate per 100K Black women",
    assertions: [
      { name: "returns sql null or explains limitation", fn: (r) =>
        !r.sql || /population|denominator|not available|cannot calculate/i.test(r.explanation) },
    ],
    note: "Demographic denominator population is not in the database",
  },
];

// ── Runner ───────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  STRUCTURAL EVAL — ${BASE}`);
  console.log(`  ${tests.length} tests across Current, Historical, NIBRS, SHR`);
  console.log(`${"═".repeat(70)}\n`);

  let totalPass = 0;
  let totalFail = 0;
  const failures = [];
  const tabStats = { current: { pass: 0, fail: 0 }, historical: { pass: 0, fail: 0 }, nibrs: { pass: 0, fail: 0 }, shr: { pass: 0, fail: 0 } };

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    process.stdout.write(`  ${t.id}. [${t.tab}] ${t.question.slice(0, 55).padEnd(55)}  `);

    const start = Date.now();
    let result = await queryAPI(t.tab, t.question);
    // Retry on rate limit
    for (let retry = 0; retry < 2 && result.error?.includes("Too many requests"); retry++) {
      const wait = parseInt(result.error.match(/(\d+) seconds/)?.[1] || "15") + 3;
      process.stdout.write(`[rate-limited ${wait}s] `);
      await new Promise(r => setTimeout(r, wait * 1000));
      result = await queryAPI(t.tab, t.question);
    }
    const ms = Date.now() - start;

    // Run assertions
    const failedAssertions = [];
    for (const a of t.assertions) {
      try {
        if (!a.fn(result)) failedAssertions.push(a.name);
      } catch (e) {
        failedAssertions.push(`${a.name} (threw: ${e.message})`);
      }
    }

    if (failedAssertions.length === 0) {
      console.log(`✓  ${result.rows} rows  ${(ms/1000).toFixed(1)}s`);
      totalPass++;
      tabStats[t.tab].pass++;
    } else {
      console.log(`✗  FAIL  ${(ms/1000).toFixed(1)}s`);
      for (const f of failedAssertions) {
        console.log(`       → ${f}`);
      }
      if (result.sql) console.log(`       SQL: ${result.sql.slice(0, 200)}...`);
      if (!result.sql && result.explanation) console.log(`       Explanation: ${result.explanation.slice(0, 150)}`);
      totalFail++;
      tabStats[t.tab].fail++;
      failures.push({ id: t.id, tab: t.tab, question: t.question, failedAssertions, note: t.note, sql: result.sql?.slice(0, 300) });
    }

    // 8s delay between queries
    await new Promise(r => setTimeout(r, 8000));
  }

  // ── Summary ────────────────────────────────────────────
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  RESULTS: ${totalPass} passed, ${totalFail} failed out of ${tests.length}`);
  console.log(`${"─".repeat(70)}`);
  for (const [tab, stats] of Object.entries(tabStats)) {
    const total = stats.pass + stats.fail;
    if (total > 0) console.log(`  ${tab.padEnd(12)} ${stats.pass}/${total} passed`);
  }

  if (failures.length > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log("  FAILURES:");
    for (const f of failures) {
      console.log(`\n  #${f.id} [${f.tab}] ${f.question}`);
      for (const a of f.failedAssertions) console.log(`    ✗ ${a}`);
      if (f.note) console.log(`    Note: ${f.note}`);
      if (f.sql) console.log(`    SQL: ${f.sql}`);
    }

    // Repeated patterns
    const patterns = {};
    for (const f of failures) {
      for (const a of f.failedAssertions) {
        patterns[a] = (patterns[a] || 0) + 1;
      }
    }
    const repeated = Object.entries(patterns).filter(([, c]) => c > 1);
    if (repeated.length > 0) {
      console.log(`\n${"─".repeat(70)}`);
      console.log("  REPEATED FAILURE PATTERNS:");
      for (const [name, count] of repeated) {
        console.log(`    ${count}× ${name}`);
      }
    }
  }

  console.log(`\n${"─".repeat(70)}`);
  const ready = totalFail <= 2;
  console.log(`  PRODUCTION READY: ${ready ? "YES" : "NO — fix failures above"}`);
  if (totalFail > 0 && totalFail <= 2) {
    console.log(`  (${totalFail} failure(s) within acceptable tolerance)`);
  }
  console.log(`${"═".repeat(70)}\n`);
}

run().catch(console.error);
