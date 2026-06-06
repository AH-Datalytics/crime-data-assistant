#!/usr/bin/env npx tsx
/**
 * NIBRS Canary Eval — fixed query set for comparing Haiku vs Sonnet.
 *
 * Runs each query through both models, checks for known failure patterns,
 * and reports a side-by-side comparison. Uses translateToSql directly
 * (no DB execution needed — this tests model output quality only).
 *
 * Usage:
 *   npx tsx scripts/eval-nibrs-canary.ts                # run both models
 *   npx tsx scripts/eval-nibrs-canary.ts --haiku-only   # Haiku only
 *   npx tsx scripts/eval-nibrs-canary.ts --sonnet-only  # Sonnet only
 *
 * Requires ANTHROPIC_API_KEY in env.
 */

import { translateToSql } from "../lib/nibrs-claude.js";
import { findNibrsSqlIssues } from "../lib/sql-guardrails.js";
import { extractQueryContext } from "../lib/query-context.js";
import { runGuardrails } from "../lib/guardrails.js";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-5-20250929";

interface EvalQuery {
  id: string;
  question: string;
  category: string;
  /** Known issues this query has triggered in the past */
  knownIssues: string[];
  /** Patterns that should NOT appear in the SQL or explanation */
  rejectPatterns?: RegExp[];
  /** Patterns that MUST appear in the SQL for it to be correct */
  requirePatterns?: RegExp[];
  /** Conversation history for follow-up queries */
  history?: { role: "user" | "assistant"; content: string }[];
}

const EVAL_SET: EvalQuery[] = [
  // --- SQL structure issues ---
  {
    id: "undeclared-alias",
    question: "show me violent crimes by age group in continuously reporting agencies since 2015",
    category: "SQL structure",
    knownIssues: ["undeclared alias s.year", "duplicate GROUP BY"],
    rejectPatterns: [/\bs\.\w+/], // should not use undeclared 's' alias
    requirePatterns: [/summary_offender_demographics|summary_victim_demographics/i],
  },
  {
    id: "duplicate-group-by",
    question: "murder, rape, sexual assault, robbery, and aggravated assault",
    category: "SQL structure",
    knownIssues: ["duplicate GROUP BY", "missing robbery code 120"],
    rejectPatterns: [/GROUP\s+BY[^;]*GROUP\s+BY/i],
    requirePatterns: [/120/], // robbery code must be present
    history: [
      { role: "user", content: "show me violent crimes by age group in continuously reporting agencies since 2015" },
      { role: "assistant", content: JSON.stringify({ sql: null, explanation: "Which violent crimes? Murder, rape, robbery, aggravated assault, or all?" }) },
    ],
  },
  {
    id: "order-before-union",
    question: "compare Houston and Dallas murder counts from 2020 to 2024, showing each year",
    category: "SQL structure",
    knownIssues: ["ORDER BY before UNION ALL"],
    rejectPatterns: [/ORDER\s+BY[^)]*UNION\s+ALL/i],
  },

  // --- Consistent reporter / CTE ---
  {
    id: "consistent-reporter",
    question: "show nationwide total of robberies by age of offender from 2015 to 2025 for agencies that reported in all of those years",
    category: "consistent reporter",
    knownIssues: ["self-join CTE crash", "timeout"],
    requirePatterns: [/nibrs_agency_completeness|HAVING\s+COUNT/i],
  },

  // --- Offense code labeling ---
  {
    id: "robbery-label",
    question: "now add murders and aggravated assaults",
    category: "offense labeling",
    knownIssues: ["120 mislabeled as aggravated assault", "13A mislabeled as simple assault"],
    rejectPatterns: [
      /120.*aggravated/i,
      /13A.*simple/i,
    ],
    history: [
      { role: "user", content: "show nationwide total of robberies by age of offender from 2015 to 2025 for agencies that reported in all of those years" },
      { role: "assistant", content: JSON.stringify({ sql: "SELECT d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ucr_offense_code = '120' AND d.year BETWEEN 2015 AND 2025 GROUP BY d.age_group ORDER BY offenders DESC", explanation: "Robbery offender counts by age group." }) },
      { role: "user", content: "break this down by year" },
      { role: "assistant", content: JSON.stringify({ sql: "SELECT d.year, d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ucr_offense_code = '120' AND d.year BETWEEN 2015 AND 2025 GROUP BY d.year, d.age_group ORDER BY d.year", explanation: "Offender counts by age and year." }) },
    ],
  },

  // --- Prompt/scaffold leak ---
  {
    id: "scaffold-leak",
    question: "show me the total population served by law enforcement agencies that reported every year from 2015 through 2025",
    category: "scaffold leak",
    knownIssues: ["prompt leak: 'Entities in results'"],
    rejectPatterns: [/Entities in results/i, /\bscaffold\b/i],
  },

  // --- False refusal ---
  {
    id: "false-refusal-offender",
    question: "show nationwide total of robberies, murders, and aggravated assaults by age of offender from 2015 to 2025 for agencies that reported in all of those years",
    category: "false refusal",
    knownIssues: ["falsely claimed it couldn't combine offense types"],
    requirePatterns: [/SELECT/i], // must produce SQL, not refuse
  },
  {
    id: "false-refusal-ori",
    question: "include only agencies that reported in all years from 2015 through 2025",
    category: "false refusal",
    knownIssues: ["falsely claimed summary_offender_demographics has no ORI column"],
    requirePatterns: [/SELECT/i, /ori/i], // must produce SQL using ori
    history: [
      { role: "user", content: "show nationwide total of robberies, murders, and aggravated assaults by age of offender from 2015 to 2025" },
      { role: "assistant", content: JSON.stringify({ sql: "SELECT d.year, CASE d.ucr_offense_code WHEN '09A' THEN 'Murder' WHEN '120' THEN 'Robbery' WHEN '13A' THEN 'Aggravated Assault' END AS offense, d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ucr_offense_code IN ('09A','13A','120') AND d.year BETWEEN 2015 AND 2025 GROUP BY d.year, d.ucr_offense_code, d.age_group ORDER BY d.year", explanation: "Offender counts by offense, age, and year." }) },
    ],
  },

  // --- Geography preservation ---
  {
    id: "everett-wa-state",
    question: "Show me a rolling 12 month rate of motor vehicle theft in Everett, WA from the past 5 years compared to the statewide rate",
    category: "geography",
    knownIssues: ["said Everett, MA instead of WA"],
    rejectPatterns: [/Everett.*\bMA\b/i],
    requirePatterns: [/WA/],
  },

  // --- City multi-ORI aggregation ---
  {
    id: "city-multi-ori",
    question: "how many murders in Charlotte NC from 2020 to 2024",
    category: "city aggregation",
    knownIssues: ["only uses one ORI instead of aggregating all Charlotte ORIs"],
    requirePatterns: [/Charlotte/i, /09A/i],
  },

  // --- Simple known-good queries ---
  {
    id: "simple-trend",
    question: "murder trend in Houston from 2015 to 2024",
    category: "known-good",
    knownIssues: [],
    requirePatterns: [/SELECT/i, /Houston/i, /09A/i],
  },
  {
    id: "simple-count",
    question: "how many robberies in Chicago in 2023",
    category: "known-good",
    knownIssues: [],
    requirePatterns: [/SELECT/i, /Chicago/i, /120/i],
  },
  {
    id: "simple-ranking",
    question: "top 10 cities by murder count in 2024",
    category: "known-good",
    knownIssues: [],
    requirePatterns: [/SELECT/i, /LIMIT\s+10/i, /09A/i],
  },
  {
    id: "state-trend",
    question: "Texas statewide robbery trend from 2019 to 2024",
    category: "known-good",
    knownIssues: [],
    requirePatterns: [/SELECT/i, /TX/i, /120/i],
  },
  {
    id: "demographic-breakdown",
    question: "murder victims by race in New York City from 2020 to 2024",
    category: "known-good",
    knownIssues: [],
    requirePatterns: [/SELECT/i, /race/i, /09A/i],
  },
];

interface EvalResult {
  queryId: string;
  model: string;
  hasSql: boolean;
  issues: string[];
  sqlPreview: string;
  explanationPreview: string;
  latencyMs: number;
}

async function evalQuery(query: EvalQuery, modelId: string): Promise<EvalResult> {
  const start = Date.now();
  const result = await translateToSql(query.question, query.history, modelId);
  const latencyMs = Date.now() - start;

  const issues: string[] = [];

  // Check for SQL
  if (!result.sql) {
    if (query.requirePatterns && query.requirePatterns.length > 0) {
      issues.push("NO SQL (expected SQL output)");
    }
    // Check for false refusal
    if (/cannot|can't|unable|not available|doesn't appear/i.test(result.explanation || "")) {
      issues.push("POSSIBLE FALSE REFUSAL");
    }
  } else {
    // Run SQL guardrails
    const sqlIssues = findNibrsSqlIssues(result.sql);
    for (const issue of sqlIssues.fired) {
      issues.push(`SQL_GUARDRAIL: ${issue}`);
    }

    // Run shared guardrails
    const ctx = extractQueryContext(result.sql, query.question, "nibrs");
    const guardrailResult = runGuardrails(ctx);
    for (const fired of guardrailResult.fired) {
      issues.push(`GUARDRAIL: ${fired}`);
    }

    // Check reject patterns
    if (query.rejectPatterns) {
      for (const pattern of query.rejectPatterns) {
        if (pattern.test(result.sql)) {
          issues.push(`REJECT_SQL: ${pattern.source}`);
        }
        if (result.explanation && pattern.test(result.explanation)) {
          issues.push(`REJECT_EXPLAIN: ${pattern.source}`);
        }
      }
    }

    // Check require patterns
    if (query.requirePatterns) {
      for (const pattern of query.requirePatterns) {
        if (!pattern.test(result.sql)) {
          issues.push(`MISSING: ${pattern.source}`);
        }
      }
    }
  }

  // Check explanation for scaffold leaks
  if (result.explanation) {
    if (/Entities in results/i.test(result.explanation)) issues.push("SCAFFOLD_LEAK");
    if (/\{[^}]*"sql"/i.test(result.explanation)) issues.push("JSON_LEAK");
  }

  return {
    queryId: query.id,
    model: modelId.includes("sonnet") ? "sonnet" : "haiku",
    hasSql: !!result.sql,
    issues,
    sqlPreview: (result.sql || "(no SQL)").slice(0, 200),
    explanationPreview: (result.explanation || "").slice(0, 150),
    latencyMs,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const haikuOnly = args.includes("--haiku-only");
  const sonnetOnly = args.includes("--sonnet-only");

  const models: string[] = [];
  if (!sonnetOnly) models.push(HAIKU);
  if (!haikuOnly) models.push(SONNET);

  console.log(`NIBRS Canary Eval — ${EVAL_SET.length} queries x ${models.length} model(s)\n`);
  console.log("=".repeat(90));

  const allResults: EvalResult[] = [];

  for (const query of EVAL_SET) {
    console.log(`\n${"─".repeat(90)}`);
    console.log(`[${query.id}] ${query.question.slice(0, 80)}`);
    console.log(`  Category: ${query.category} | Known issues: ${query.knownIssues.join(", ") || "none"}`);

    for (const modelId of models) {
      const label = modelId.includes("sonnet") ? "SONNET" : "HAIKU";
      try {
        const result = await evalQuery(query, modelId);
        allResults.push(result);

        const status = result.issues.length === 0 ? "PASS" : "FAIL";
        const icon = status === "PASS" ? "+" : "X";
        console.log(`  [${icon}] ${label} (${result.latencyMs}ms): ${status}`);
        if (result.issues.length > 0) {
          for (const issue of result.issues) {
            console.log(`      - ${issue}`);
          }
        }
        console.log(`      SQL: ${result.sqlPreview.slice(0, 120)}`);
      } catch (err) {
        console.log(`  [!] ${label}: ERROR — ${err}`);
        allResults.push({
          queryId: query.id,
          model: label.toLowerCase(),
          hasSql: false,
          issues: [`ERROR: ${err}`],
          sqlPreview: "",
          explanationPreview: "",
          latencyMs: 0,
        });
      }
    }
  }

  // Summary
  console.log(`\n${"=".repeat(90)}`);
  console.log("SUMMARY\n");

  for (const modelId of models) {
    const label = modelId.includes("sonnet") ? "sonnet" : "haiku";
    const modelResults = allResults.filter(r => r.model === label);
    const passed = modelResults.filter(r => r.issues.length === 0).length;
    const failed = modelResults.filter(r => r.issues.length > 0).length;
    const avgLatency = Math.round(modelResults.reduce((s, r) => s + r.latencyMs, 0) / modelResults.length);

    console.log(`  ${label.toUpperCase()}: ${passed}/${modelResults.length} passed, ${failed} failed, avg ${avgLatency}ms`);

    if (failed > 0) {
      console.log(`    Failures:`);
      for (const r of modelResults.filter(r => r.issues.length > 0)) {
        console.log(`      ${r.queryId}: ${r.issues.join(", ")}`);
      }
    }
  }

  // Exit code
  const sonnetResults = allResults.filter(r => r.model === "sonnet");
  const sonnetFails = sonnetResults.filter(r => r.issues.length > 0).length;
  if (sonnetFails > 0 && !haikuOnly) {
    console.log(`\nSonnet has ${sonnetFails} failure(s) — NOT ready for default promotion.`);
    process.exit(1);
  } else if (sonnetResults.length > 0) {
    console.log(`\nSonnet passed all ${sonnetResults.length} queries.`);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
