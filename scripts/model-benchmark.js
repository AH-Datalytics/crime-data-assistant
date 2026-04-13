#!/usr/bin/env node
/**
 * Model Benchmark: Compare Haiku vs Sonnet on NIBRS queries
 *
 * Runs on the VPS where nibrs.db exists.
 * Usage: ANTHROPIC_API_KEY=sk-... node scripts/model-benchmark.js
 *
 * Calls the Anthropic API directly with both models, validates SQL
 * against the real DB, and outputs a comparison table.
 */

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.NIBRS_DB_PATH || "/opt/nibrs/nibrs.db";
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("Set ANTHROPIC_API_KEY env var");
  process.exit(1);
}

// ── Test queries covering key failure patterns ──
const QUERIES = [
  { id: 1, question: "Murder trend in the US since 2020", pattern: "national person crime" },
  { id: 2, question: "Vehicle burglary trend in New York City since 2020", pattern: "city property crime" },
  { id: 3, question: "Carjacking trend in Chicago", pattern: "carjacking (special table)" },
  { id: 4, question: "Top 10 states by aggravated assault in 2024", pattern: "state-level person crime ranking" },
  { id: 5, question: "Hate crimes by bias type nationally in 2024", pattern: "hate crime summary" },
  { id: 6, question: "Murder victims by weapon type in Texas 2024", pattern: "victim weapon demographics" },
  { id: 7, question: "Drug offenses by drug type in California", pattern: "drug summary table" },
  { id: 8, question: "Murder clearance rate by year nationally", pattern: "clearance rate" },
  { id: 9, question: "Domestic violence murders with firearms trend", pattern: "weapon+circumstance cross-dim" },
  { id: 10, question: "Robbery trend in Houston vs Dallas since 2020", pattern: "multi-city property comparison" },
];

const MODELS = [
  { id: "haiku", model: "claude-haiku-4-5-20251001" },
  { id: "sonnet", model: "claude-sonnet-4-20250514" },
];

// ── Build system prompt (simplified version with real DB stats) ──
function buildSystemPrompt(db) {
  // Get dynamic facts
  let minYear = 1991, maxYear = 2026;
  try {
    const r = db.prepare("SELECT MIN(year) as mn, MAX(year) as mx FROM incidents").get();
    if (r) { minYear = r.mn; maxYear = r.mx; }
  } catch {}

  // Read coverage data
  let coverageStr = "Coverage data unavailable.";
  try {
    const rows = db.prepare(
      "SELECT year, coverage_pct FROM nibrs_national_coverage WHERE year >= 2010 ORDER BY year"
    ).all();
    if (rows.length > 0) coverageStr = rows.map(r => `${r.year}: ${r.coverage_pct}%`).join(", ");
  } catch {}

  // Get row counts for key tables
  const rawCounts = {};
  const summaryCounts = {};
  for (const t of ["incidents", "offenses", "victims", "offenders", "arrestees", "property"]) {
    try { rawCounts[t] = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c; } catch { rawCounts[t] = "unknown"; }
  }
  for (const t of ["summary_victim_state_monthly", "summary_city_monthly", "summary_state_monthly",
    "summary_victim_city_monthly", "summary_drug_monthly", "summary_property_offense",
    "summary_victim_demographics", "summary_offender_demographics", "summary_arrestee_demographics"]) {
    try { summaryCounts[t] = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get().c; } catch { summaryCounts[t] = "unknown"; }
  }

  function fmt(n) {
    if (typeof n !== "number") return n;
    if (n >= 1e9) return `${(n/1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n/1e3).toFixed(0)}K`;
    return String(n);
  }

  // Read the actual system prompt from source — we'll load it from the built Next.js app
  // For the benchmark, we need the FULL prompt. Let's try requiring the compiled module.
  try {
    // The built app's server chunks should have the module
    const appDir = "/opt/nibrs/app";
    // Try loading from .next build output
    const nibrsClaudePath = path.join(appDir, ".next/server/chunks/ssr/lib_nibrs-claude_ts_*.js");
    const glob = require("glob");
    const files = glob.sync(nibrsClaudePath);
    if (files.length > 0) {
      console.log(`Found compiled module: ${files[0]}`);
    }
  } catch {}

  // Since loading the compiled module is fragile, let's extract the prompt from source
  // by reading the TS file and evaluating the template literal manually.
  // Actually, let's just use the fs module to read the source and do string replacements.
  const fs = require("fs");
  let promptSrc;
  try {
    const src = fs.readFileSync(path.join(__dirname, "../lib/nibrs-claude.ts"), "utf8");
    // Extract the template literal between SYSTEM_PROMPT = ` and the closing backtick
    const startMarker = "const SYSTEM_PROMPT = `";
    const startIdx = src.indexOf(startMarker);
    if (startIdx === -1) throw new Error("Could not find SYSTEM_PROMPT in nibrs-claude.ts");

    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx + startMarker.length; i < src.length; i++) {
      if (src[i] === '`' && src[i-1] !== '\\') {
        if (depth === 0) { endIdx = i; break; }
      }
      if (src[i] === '$' && src[i+1] === '{') depth++;
      if (depth > 0 && src[i] === '}') depth--;
    }
    if (endIdx === -1) throw new Error("Could not find end of SYSTEM_PROMPT template literal");

    promptSrc = src.substring(startIdx + startMarker.length, endIdx);

    // Replace template expressions with actual values
    promptSrc = promptSrc
      .replace(/\$\{NIBRS\.minYear\}/g, String(minYear))
      .replace(/\$\{NIBRS\.maxYear\}/g, String(maxYear))
      .replace(/\$\{NIBRS\.currentYear\}/g, String(maxYear))
      .replace(/\$\{NIBRS\.totalLabel\}/g, `${fmt(rawCounts.incidents || 0)} incidents`)
      .replace(/\$\{NIBRS\.rawRowCounts\["victims"\]\s*\|\|\s*"[^"]*"\}/g, fmt(rawCounts.victims))
      .replace(/\$\{NIBRS\.rawRowCounts\["offenders"\]\s*\|\|\s*"[^"]*"\}/g, fmt(rawCounts.offenders))
      .replace(/\$\{NIBRS\.rawRowCounts\["arrestees"\]\s*\|\|\s*"[^"]*"\}/g, fmt(rawCounts.arrestees))
      .replace(/\$\{NIBRS\.rawRowCounts\["offenses"\]\s*\|\|\s*"[^"]*"\}/g, fmt(rawCounts.offenses))
      .replace(/\$\{formatRowCount\(NIBRS\.summaryRowCounts\["([^"]+)"\]\s*\|\|\s*\d+\)\}/g, (_, table) => {
        return fmt(summaryCounts[table] || 0);
      })
      .replace(/\$\{COVERAGE_DATA\}/g, coverageStr)
      // Catch any remaining ${...} expressions
      .replace(/\$\{NIBRS\.currentYear\s*-\s*(\d+)\}/g, (_, n) => String(maxYear - parseInt(n)))
      .replace(/\$\{NIBRS\.\w+\}/g, "[dynamic]");

  } catch (e) {
    console.error("Failed to extract system prompt:", e.message);
    console.error("Make sure you're running from the project root directory.");
    process.exit(1);
  }

  return promptSrc;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Call Anthropic API (with retry on rate limit) ──
async function callModel(model, systemPrompt, question, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: question }],
      }),
    });

    const data = await resp.json();
    const ms = Date.now() - start;

    if (data.error) {
      if (data.error.type === "rate_limit_error" && attempt < maxRetries) {
        const waitSec = 65 * (attempt + 1);  // 65s, 130s, 195s
        process.stdout.write(`[rate limited, waiting ${waitSec}s]...`);
        await sleep(waitSec * 1000);
        continue;
      }
      return { sql: null, error: data.error.message, ms, tokens: 0 };
    }

  const text = data.content?.[0]?.text || "";
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;

  // Parse JSON response
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      sql: parsed.sql || null,
      explanation: (parsed.explanation || "").slice(0, 200),
      chartHint: parsed.chartHint || "none",
      ms,
      inputTokens,
      outputTokens,
      error: null,
    };
  } catch {
    // Try extracting JSON from within
    const braceMatch = cleaned.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        const parsed = JSON.parse(braceMatch[0]);
        return { sql: parsed.sql || null, explanation: (parsed.explanation || "").slice(0, 200), ms, inputTokens, outputTokens, error: null };
      } catch {}
    }
    return { sql: null, error: "Failed to parse JSON", ms, inputTokens, outputTokens, rawText: text.slice(0, 200) };
  }
  } // end for loop

  return { sql: null, error: "All retries exhausted", ms: 0, inputTokens: 0, outputTokens: 0 };
}

// ── Validate SQL against real DB ──
function validateSql(db, sql) {
  if (!sql) return { valid: false, rows: 0, error: "no SQL generated" };

  // Basic safety check
  const lower = sql.toLowerCase().trim();
  if (!lower.startsWith("select") && !lower.startsWith("with")) return { valid: false, rows: 0, error: "not a SELECT" };
  if (/\b(insert|update|delete|drop|alter|create)\b/i.test(sql)) {
    return { valid: false, rows: 0, error: "write operation" };
  }

  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all();
    return { valid: true, rows: rows.length, error: null };
  } catch (e) {
    return { valid: false, rows: 0, error: e.message.slice(0, 150) };
  }
}

// ── Known-bad patterns (guardrails) ──
function checkGuardrails(sql, question) {
  if (!sql) return [];
  const issues = [];
  const lower = sql.toLowerCase();
  const qLower = question.toLowerCase();

  // Property crime on victim table
  const propertyCodes = ["23A","23B","23C","23D","23E","23F","23G","23H","220","240","250","26A","26B","26C","26D","26E","270","280","290"];
  if (/summary_victim/i.test(sql)) {
    for (const code of propertyCodes) {
      if (sql.includes(`'${code}'`)) {
        issues.push("property-crime-on-victim-table");
        break;
      }
    }
  }

  // National as state='US'
  if (/state\s*=\s*'(US|USA)'/i.test(sql) && !/summary_property_value_state/i.test(sql)) {
    issues.push("national-as-state-US");
  }

  // Carjacking without carjacking table
  if (qLower.includes("carjacking") && !/summary_carjacking_monthly/i.test(sql)) {
    issues.push("carjacking-wrong-table");
  }

  // Raw table for aggregates
  const rawTables = ["offenses", "property", "arrestees", "offenders", "victims"];
  if (/\b(COUNT|SUM|GROUP\s+BY)\b/i.test(sql)) {
    for (const t of rawTables) {
      // Check for raw table usage (not summary_ prefixed)
      const re = new RegExp(`\\bFROM\\s+${t}\\b|\\bJOIN\\s+${t}\\b`, "i");
      if (re.test(sql) && !new RegExp(`summary_.*${t}`, "i").test(sql)) {
        issues.push(`raw-table-${t}`);
      }
    }
  }

  // City name not uppercase
  if (/city\s*=\s*'[A-Z][a-z]/.test(sql)) {
    issues.push("city-not-uppercase");
  }

  return issues;
}

// ── Main ──
async function main() {
  console.log("NIBRS Model Benchmark: Haiku vs Sonnet");
  console.log("=".repeat(70));

  // Open DB
  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
  } catch (e) {
    console.error(`Cannot open DB at ${DB_PATH}: ${e.message}`);
    process.exit(1);
  }

  // Build system prompt
  console.log("Building system prompt from source + DB stats...");
  const systemPrompt = buildSystemPrompt(db);
  console.log(`System prompt: ${systemPrompt.length} chars`);
  console.log();

  // Run benchmark — one model at a time to maximize prompt cache hits
  const results = [];

  for (const m of MODELS) {
    console.log(`\n── ${m.id.toUpperCase()} (${m.model}) ──`);

    for (const q of QUERIES) {
      process.stdout.write(`  [${q.id}] ${q.question.slice(0, 50).padEnd(50)}: `);

      const result = await callModel(m.model, systemPrompt, q.question);
      const validation = validateSql(db, result.sql);
      const guardrails = checkGuardrails(result.sql, q.question);

      const status = !result.sql ? "NO SQL" :
        !validation.valid ? `ERROR: ${validation.error.slice(0, 60)}` :
        validation.rows === 0 ? "0 ROWS" :
        `${validation.rows} rows`;

      const guardrailStr = guardrails.length > 0 ? ` [GR: ${guardrails.join(", ")}]` : "";

      console.log(`${status} (${result.ms}ms, ${result.outputTokens} out)${guardrailStr}`);

      results.push({
        queryId: q.id,
        question: q.question,
        pattern: q.pattern,
        model: m.id,
        sql: result.sql,
        ms: result.ms,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        rows: validation.rows,
        valid: validation.valid,
        dbError: validation.error,
        guardrails,
        apiError: result.error,
      });

      // Small delay to avoid rate limits (prompt caching helps but tokens still count)
      await sleep(3000);
    }

    // Longer delay between models to let rate limit windows reset
    if (m.id === "haiku") {
      console.log("\n  Waiting 90s for rate limit window to reset...");
      await sleep(90000);
    }
  }

  db.close();

  // ── Summary table ──
  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));

  const header = [
    "#".padStart(2),
    "Pattern".padEnd(30),
    "Haiku".padEnd(16),
    "Sonnet".padEnd(16),
    "Winner",
  ].join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));

  let haikuWins = 0, sonnetWins = 0, ties = 0;
  let haikuTotalMs = 0, sonnetTotalMs = 0;
  let haikuTotalTokens = 0, sonnetTotalTokens = 0;
  let haikuGuardrails = 0, sonnetGuardrails = 0;

  for (const q of QUERIES) {
    const h = results.find(r => r.queryId === q.id && r.model === "haiku");
    const s = results.find(r => r.queryId === q.id && r.model === "sonnet");

    function grade(r) {
      if (!r.sql) return { score: 0, label: "NO SQL" };
      if (!r.valid) return { score: 1, label: "DB ERR" };
      if (r.guardrails.length > 0) return { score: 2, label: `${r.rows}r +GR` };
      if (r.rows === 0) return { score: 3, label: "0 rows" };
      return { score: 4, label: `${r.rows}r OK` };
    }

    const hg = grade(h);
    const sg = grade(s);

    let winner;
    if (hg.score > sg.score) { winner = "HAIKU"; haikuWins++; }
    else if (sg.score > hg.score) { winner = "SONNET"; sonnetWins++; }
    else { winner = "TIE"; ties++; }

    haikuTotalMs += h.ms;
    sonnetTotalMs += s.ms;
    haikuTotalTokens += (h.inputTokens + h.outputTokens);
    sonnetTotalTokens += (s.inputTokens + s.outputTokens);
    haikuGuardrails += h.guardrails.length;
    sonnetGuardrails += s.guardrails.length;

    console.log([
      String(q.id).padStart(2),
      q.pattern.slice(0, 30).padEnd(30),
      `${hg.label} ${h.ms}ms`.padEnd(16),
      `${sg.label} ${s.ms}ms`.padEnd(16),
      winner,
    ].join(" | "));
  }

  console.log("-".repeat(header.length));
  console.log(`\nWins: Haiku ${haikuWins}, Sonnet ${sonnetWins}, Tie ${ties}`);
  console.log(`Avg latency: Haiku ${Math.round(haikuTotalMs / 10)}ms, Sonnet ${Math.round(sonnetTotalMs / 10)}ms`);
  console.log(`Total tokens: Haiku ${haikuTotalTokens}, Sonnet ${sonnetTotalTokens}`);
  console.log(`Guardrail fires: Haiku ${haikuGuardrails}, Sonnet ${sonnetGuardrails}`);

  // Haiku pricing: $0.80/MTok in, $4/MTok out
  // Sonnet pricing: $3/MTok in, $15/MTok out
  const haikuInputTokens = results.filter(r => r.model === "haiku").reduce((s, r) => s + r.inputTokens, 0);
  const haikuOutputTokens = results.filter(r => r.model === "haiku").reduce((s, r) => s + r.outputTokens, 0);
  const sonnetInputTokens = results.filter(r => r.model === "sonnet").reduce((s, r) => s + r.inputTokens, 0);
  const sonnetOutputTokens = results.filter(r => r.model === "sonnet").reduce((s, r) => s + r.outputTokens, 0);

  const haikuCost = (haikuInputTokens * 0.80 + haikuOutputTokens * 4.0) / 1e6;
  const sonnetCost = (sonnetInputTokens * 3.0 + sonnetOutputTokens * 15.0) / 1e6;
  console.log(`Est. cost (this run): Haiku $${haikuCost.toFixed(4)}, Sonnet $${sonnetCost.toFixed(4)} (${(sonnetCost/haikuCost).toFixed(1)}x)`);

  // Save full results to JSON
  const fs = require("fs");
  const outPath = path.join(__dirname, "benchmark-results.json");
  fs.writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`\nFull results saved to: ${outPath}`);
}

main().catch(e => {
  console.error("Benchmark failed:", e);
  process.exit(1);
});
