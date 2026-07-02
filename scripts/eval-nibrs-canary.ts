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
const SONNET = "claude-sonnet-5";

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
    rejectPatterns: [/GROUP\s+BY\s+d\.age_group\s+GROUP\s+BY/i, /GROUP\s+BY\s+age_group\s+GROUP\s+BY/i],
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
    requirePatterns: [/nibrs_consistent_reporters|nibrs_agency_completeness|HAVING\s+COUNT/i],
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
  {
    id: "false-refusal-juvenile-firearm-deaths",
    question: "firearm related juvenile deaths in New Haven, CT over the last 10 years",
    category: "false refusal",
    knownIssues: ["falsely claimed age filtering required raw victims table"],
    rejectPatterns: [/\bFROM\s+victims\b/i, /\bJOIN\s+victims\b/i],
    requirePatterns: [/summary_victim_demographics/i, /Under 18/i, /Firearm/i, /09A/i],
  },
  {
    id: "false-refusal-clearance-min-followup",
    question: "Min 200 off",
    category: "false refusal",
    knownIssues: ["cross-joined victim counts to clearance summary instead of using summary_clearance_city_annual alone"],
    rejectPatterns: [/summary_victim_city_monthly/i, /summary_victim_state_monthly/i, /JOIN\s+summary_/i],
    requirePatterns: [/summary_clearance_city_annual/i, /HAVING/i, /total_offenses/i, /200/],
    history: [
      { role: "user", content: "what cities had the highest rape clearance rates in 2025?" },
      { role: "assistant", content: JSON.stringify({ sql: "SELECT city, state, SUM(total_offenses) AS rape_offenses, SUM(total_cleared) AS cleared, ROUND(100.0 * SUM(total_cleared) / SUM(total_offenses), 1) AS clearance_rate FROM summary_clearance_city_annual WHERE ucr_offense_code IN ('11A','11B','11C') AND year = 2025 GROUP BY city, state ORDER BY clearance_rate DESC LIMIT 25", explanation: "Rape clearance rates by city." }) },
    ],
  },
  {
    id: "false-refusal-circumstance-clearance-demo",
    question: "female DV murder victims cleared by arrest in Texas by year",
    category: "false refusal",
    knownIssues: ["failed to use combined circumstance + clearance + demographics summary"],
    rejectPatterns: [/summary_victim_circumstance\s/i, /summary_clearance_type/i, /\bJOIN\s+summary_/i],
    requirePatterns: [/summary_victim_circumstance_clearance_demo/i, /clearance_status/i, /arrest/i, /06/, /sex/i],
  },
  {
    id: "false-refusal-weapon-circumstance-demo",
    question: "juvenile firearm DV murders in Texas by year",
    category: "false refusal",
    knownIssues: ["failed to use combined weapon + circumstance + demographics summary"],
    rejectPatterns: [/summary_victim_weapon_circumstance\s/i, /summary_victim_demographics/i, /\bJOIN\s+summary_/i],
    requirePatterns: [/summary_victim_weapon_circumstance_demo/i, /Under 18/i, /weapon_type/i, /06/],
  },
  {
    id: "table-selection-vehicle-burglary",
    question: "How many vehicle burglaries per month in Boston in 2023?",
    category: "table selection",
    knownIssues: ["used victim summary for vehicle burglary even though 23F is a property offense"],
    rejectPatterns: [/summary_victim_city_monthly/i, /summary_victim_state_monthly/i, /\bFROM\s+victims\b/i],
    requirePatterns: [/summary_city_monthly/i, /23F/i, /month/i],
  },
  {
    id: "table-selection-drug-state-no-agency-join",
    question: "Drug violations by state in 2022, top 10",
    category: "table selection",
    knownIssues: ["joined agencies for a state-level drug query even though summary_drug_monthly has state"],
    rejectPatterns: [/\bJOIN\s+agencies\b/i],
    requirePatterns: [/summary_drug_monthly/i, /\bstate\b/i, /GROUP\s+BY\s+(?:\w+\.)?state/i],
  },
  {
    id: "table-selection-carjacking-victims",
    question: "Carjacking victims by state in 2024",
    category: "table selection",
    knownIssues: ["used carjacking offense counts when the user asked for carjacking victims"],
    rejectPatterns: [/summary_carjacking_monthly/i],
    requirePatterns: [/summary_carjacking_victim_demographics/i, /victim_count/i, /GROUP\s+BY\s+(?:\w+\.)?state/i],
  },
  {
    id: "table-selection-property-value-shoplifting-summary",
    question: "what is the typical dollar value of shoplifting offenses in California",
    category: "table selection",
    knownIssues: ["used raw property+offenses instead of state property-value summary"],
    rejectPatterns: [/\bFROM\s+property\b/i, /\bJOIN\s+property\b/i, /\bJOIN\s+offenses\b/i],
    requirePatterns: [/summary_property_value_state/i, /23C/i, /type_property_loss/i, /total_value/i, /record_count/i],
  },
  {
    id: "table-selection-property-value-business-location",
    question: "typical dollar value of theft offenses with the location type is a type of business in California",
    category: "table selection",
    knownIssues: ["either refused or tried to use a value summary that cannot filter by location_type"],
    rejectPatterns: [/summary_property_value_state/i, /summary_property_offense/i, /summary_offense_location/i],
    requirePatterns: [/\bFROM\s+offenses\b/i, /\bJOIN\s+property\b/i, /location_type/i, /\bvalue\s*>\s*0/i, /\bvalue\s*<\s*1000000/i],
  },
  {
    id: "sql-shape-houston-murder-weapon",
    question: "Murders by weapon in Houston in 2025",
    category: "SQL structure",
    knownIssues: ["duplicate GROUP BY after weapon alias grouping"],
    rejectPatterns: [/GROUP\s+BY\s+d\.age_group\s+GROUP\s+BY/i, /GROUP\s+BY\s+age_group\s+GROUP\s+BY/i],
    requirePatterns: [/summary_victim_weapon/i, /09A/i, /HOUSTON/i, /GROUP\s+BY\s+weapon/i],
  },
  {
    id: "sql-shape-violent-age-consistent-exact",
    question: "show me violent crimes by age group for agencies that reported every year from 2015 to 2025",
    category: "SQL structure",
    knownIssues: ["duplicate GROUP BY when combining age group with completeness filter"],
    rejectPatterns: [/GROUP\s+BY\s+d\.age_group\s+GROUP\s+BY/i, /GROUP\s+BY\s+age_group\s+GROUP\s+BY/i],
    requirePatterns: [/summary_victim_demographics/i, /nibrs_consistent_reporters|nibrs_agency_completeness/i, /age_group/i],
  },
  {
    id: "table-selection-dv-city-no-victim-count",
    question: "domestic violence by city in the state of Washington",
    category: "table selection",
    knownIssues: ["invented summary_domestic_violence.victim_count instead of counting distinct incidents"],
    rejectPatterns: [/victim_count/i, /SUM\s*\(/i],
    requirePatterns: [/summary_domestic_violence/i, /\bJOIN\s+agencies\b/i, /COUNT\s*\(\s*DISTINCT/i, /WA/i],
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
