/**
 * The deterministic input grid for the P3.1a flags-off regression.
 *
 * Extracted as a module so that the frozen BASE baseline and the live comparison are produced by
 * the SAME grid. If the test carried its own copy of the questions, a baseline could stop matching
 * the grid it was generated from and the regression would quietly narrow.
 *
 * The grid is 5 sources x 15 questions x 3 SQL inputs = 225 rows, chosen to reach block rules,
 * retry rules and neither. Its adequacy is asserted in the test rather than assumed: a grid that
 * fired nothing would make a passing comparison meaningless.
 */
import { validateQueryContractSql } from "../lib/query-contract-validator";
import type { QueryContractSource } from "../lib/query-contract";

export const GRID_SOURCES: QueryContractSource[] =
  ["current", "historical", "nibrs", "shr", "hate_crime"];

export const GRID_QUESTIONS = [
  "How many murders were reported in the Englewood neighborhood of Chicago, IL in June 2026?",
  "How many murders were reported in ZIP code 60621 in 2024?",
  "What was the murder rate per 100,000 Black residents in Chicago in 2023?",
  "How many people were sentenced for homicide in Cook County in 2023?",
  "How many robberies were reported in Los Angeles, CA in 2021?",
  "How many homicides were reported in Los Angeles, CA in 2021?",
  "What share of murders in Phoenix, AZ were cleared with a firearm in 2022?",
  "How many shootings were there in Phoenix, AZ in 2022?",
  "What were the demographics of victims in Jefferson Parish, LA in 2022?",
  "How many murders were cleared in Louisiana in 2019?",
  "How many murders were reported in Chicago, IL in 2023?",
  "How many aggravated assaults were reported in Baton Rouge, LA in 2022?",
  "What was the violent crime rate in New Orleans, LA in 2020?",
  "How many hate crimes were reported in Texas in 2021?",
  "Compare murders in Chicago and Houston in 2023.",
];

export const GRID_SQLS = [
  "SELECT COUNT(*) FROM summary_state_monthly WHERE state='IL'",
  "WITH x AS (SELECT 1) SELECT murders FROM historical_agency_clearance JOIN x",
  "SELECT year, murders FROM national_monthly ORDER BY year",
];

export type GridRow = {
  source: string;
  question: string;
  sql: string;
  result: Record<string, unknown>;
};

/**
 * Run the grid through the real post-SQL validator.
 *
 * Every key the result carries is serialized in sorted order, so a NEW field cannot slip through
 * unnoticed and an existing one cannot be silently dropped. That is what makes this a regression
 * over findings, retry issues, block reasons, enforced ids and finalization-bearing fields, rather
 * than over a hand-picked subset someone chose in advance.
 */
export function runPostSqlGrid(): GridRow[] {
  const rows: GridRow[] = [];
  for (const source of GRID_SOURCES) {
    for (const question of GRID_QUESTIONS) {
      for (const sql of GRID_SQLS) {
        let out: Record<string, unknown>;
        try {
          const r = validateQueryContractSql({ question, source, sql }) as unknown as Record<string, unknown>;
          out = {};
          for (const k of Object.keys(r).sort()) out[k] = r[k];
        } catch (err) {
          out = { threw: err instanceof Error ? err.message : String(err) };
        }
        rows.push({ source, question, sql, result: out });
      }
    }
  }
  return rows;
}
