#!/usr/bin/env npx tsx
/**
 * Replays today's error queries through the current model (Sonnet 4.5)
 * to compare SQL quality and explanations vs the Haiku originals.
 *
 * Usage: npx tsx scripts/replay-error-queries.ts
 */

import { translateToSql } from "../lib/nibrs-claude.js";

interface ErrorQuery {
  id: number;
  question: string;
  originalSql: string | null;
  originalError: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

const errorQueries: ErrorQuery[] = [
  {
    id: 3704,
    question: "show me violent crimes by age group in continuously reporting agencies since 2015",
    originalSql: "...GROUP BY s.year, d.age_group...",
    originalError: "Wrong alias s.year (should be d.year) + timeout",
  },
  {
    id: 3711,
    question: "murder, rape, sexual assault, robbery, and aggravated assault",
    originalSql: "...GROUP BY d.age_group GROUP BY year...",
    originalError: "Duplicate GROUP BY + missing robbery code 120",
    history: [
      { role: "user", content: "show me violent crimes by age group in continuously reporting agencies since 2015" },
      { role: "assistant", content: JSON.stringify({ sql: null, explanation: "I can provide offender age breakdowns for violent crimes, but I need clarification on which violent crime(s) you'd like to see." }) },
    ],
  },
  {
    id: 3712,
    question: "include only offenses 09A, 120, and 13A",
    originalSql: "WHERE year = 2025 ... HAVING COUNT(DISTINCT year) = 11",
    originalError: "Logical impossibility — always returns empty",
    history: [
      { role: "user", content: "show me violent crimes by age group in continuously reporting agencies since 2015" },
      { role: "assistant", content: JSON.stringify({ sql: null, explanation: "Which violent crimes would you like? Murder, rape, robbery, aggravated assault, or all?" }) },
      { role: "user", content: "murder, rape, sexual assault, robbery, and aggravated assault" },
      { role: "assistant", content: JSON.stringify({ sql: null, explanation: "That query timed out. Try with fewer offense codes." }) },
    ],
  },
  {
    id: 3716,
    question: "now add murders and aggravated assaults",
    originalSql: "...ucr_offense_code IN ('09A','120','13A')...",
    originalError: "Mislabeled: 120 as 'aggravated assaults', 13A as 'simple assaults'",
    history: [
      { role: "user", content: "show nationwide total of robberies by age of offender from 2015 to 2025 for agencies that reported in all of those years" },
      { role: "assistant", content: JSON.stringify({ sql: "SELECT d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ucr_offense_code = '120' AND d.year BETWEEN 2015 AND 2025 AND d.ori IN (SELECT ori FROM nibrs_agency_completeness WHERE year BETWEEN 2015 AND 2025 GROUP BY ori HAVING COUNT(*) = 11) GROUP BY d.age_group ORDER BY offenders DESC", explanation: "Robbery offender counts by age group." }) },
      { role: "user", content: "break this down by year" },
      { role: "assistant", content: JSON.stringify({ sql: "SELECT s.year, s.age_group, SUM(s.offender_count) AS offenders FROM summary_offender_demographics s WHERE s.ucr_offense_code = '120' AND s.year BETWEEN 2015 AND 2025 GROUP BY s.year, s.age_group ORDER BY s.year, s.age_group", explanation: "Offender counts by age group and year." }) },
    ],
  },
  {
    id: 3719,
    question: "show me the total population served by law enforcement agencies that reported every year from 2015 through 2025",
    originalSql: "SELECT SUM(a.population) AS total_population_served FROM agencies a WHERE ...",
    originalError: "Prompt leak: 'I need the Entities in results list'",
  },
  {
    id: 3722,
    question: "show nationwide total of robberies, murders, and aggravated assaults by age of offender from 2015 to 2025 for agencies that reported in all of those years",
    originalSql: null,
    originalError: "False refusal — claimed it couldn't combine offense types (but did so in earlier queries)",
  },
  {
    id: 3725,
    question: "include only agencies that reported in all years from 2015 through 2025",
    originalSql: null,
    originalError: "False claim: summary_offender_demographics has no ORI column",
    history: [
      { role: "user", content: "show nationwide total of robberies, murders, and aggravated assaults by age of offender from 2015 to 2025" },
      { role: "assistant", content: JSON.stringify({ sql: "SELECT d.year, CASE d.ucr_offense_code WHEN '09A' THEN 'Murder' WHEN '120' THEN 'Robbery' WHEN '13A' THEN 'Aggravated Assault' END AS offense, d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.ucr_offense_code IN ('09A','13A','120') AND d.year BETWEEN 2015 AND 2025 GROUP BY d.year, d.ucr_offense_code, d.age_group ORDER BY d.year", explanation: "Offender counts by offense type, age group, and year." }) },
    ],
  },
  {
    id: 3736,
    question: "Show me a rolling 12 month rate of motor vehicle theft in everett, WA from the past 5 years compared to the statewide rate",
    originalSql: "...WHERE am.agency = 'Everett' AND am.state = 'WA'...",
    originalError: "Response said 'Everett, MA' instead of 'Everett, WA'",
  },
];

async function main() {
  console.log("Replaying error queries through Sonnet 4.5...\n");
  console.log("=".repeat(80));

  for (const eq of errorQueries) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Query #${eq.id}: ${eq.question}`);
    console.log(`Original error: ${eq.originalError}`);
    console.log("-".repeat(80));

    try {
      const result = await translateToSql(eq.question, eq.history);
      console.log(`SQL: ${result.sql ? result.sql.slice(0, 300) : "(no SQL)"}`);
      console.log(`Explanation: ${result.explanation?.slice(0, 300)}`);
      console.log(`Title: ${result.title}`);

      // Check for known issues
      const issues: string[] = [];
      if (result.sql) {
        if (/GROUP\s+BY[^;]*GROUP\s+BY/i.test(result.sql)) issues.push("DUPLICATE GROUP BY");
        if (/\bs\.\w+/.test(result.sql) && !/\b\w+\s+s\b/.test(result.sql) && !/\bAS\s+s\b/i.test(result.sql)) issues.push("POSSIBLE UNDECLARED ALIAS 's'");
        if (/WHERE\s+year\s*=\s*\d+[\s\S]*HAVING\s+COUNT[\s\S]*=\s*\d{2}/i.test(result.sql)) issues.push("IMPOSSIBLE HAVING CLAUSE");
      }
      if (result.explanation) {
        if (/Entities in results/i.test(result.explanation)) issues.push("PROMPT LEAK");
        if (/Everett.*\bMA\b/i.test(result.explanation)) issues.push("WRONG STATE (MA vs WA)");
        if (/120.*aggravated/i.test(result.explanation)) issues.push("120 MISLABELED AS AGG ASSAULT");
        if (/13A.*simple/i.test(result.explanation)) issues.push("13A MISLABELED AS SIMPLE ASSAULT");
      }
      if (!result.sql && eq.id !== 3736) {
        // Check if this was a false refusal
        if (/cannot|can't|unable/i.test(result.explanation || "")) issues.push("POSSIBLE FALSE REFUSAL");
      }

      if (issues.length > 0) {
        console.log(`\n⚠ ISSUES DETECTED: ${issues.join(", ")}`);
      } else {
        console.log(`\n✓ No known issues detected`);
      }
    } catch (err) {
      console.log(`ERROR: ${err}`);
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log("Replay complete.");
}

main();
