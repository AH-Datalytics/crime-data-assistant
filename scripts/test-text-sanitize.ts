/**
 * Layer 1 stress tests for text sanitization — no database required.
 *
 * Validates that P0/P1 regex fixes handle Sonnet-length model output
 * without catastrophic backtracking. The old regex patterns would hang for
 * minutes on these inputs.
 *
 * What is gated here is the OUTPUT of each sanitizer on the stress inputs. The
 * elapsed time of each call is printed for information only: a wall-clock
 * pass/fail bound measured the machine rather than the code and could fail on a
 * slow shared runner with no code change. A sanitizer that regressed into
 * catastrophic backtracking still fails this command -- it never finishes, and
 * the harness's per-command timeout records that as a failure -- it just no
 * longer fails on a runner that was merely slow.
 *
 * Run: npx tsx scripts/test-text-sanitize.ts
 */

import {
  removeCodeFences,
  extractCodeFenceCandidates,
  removeJsonWithSqlKey,
} from "../lib/text-sanitize";
import { sanitizeExplanation } from "../lib/explain";
import { extractJson } from "../lib/extract-json";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Runs `fn` and reports how long it took. Informational only: never a pass/fail condition. */
function timed<T>(name: string, fn: () => T): T {
  const start = Date.now();
  const result = fn();
  const elapsed = Date.now() - start;
  console.log(`  time  ${name} — ${elapsed}ms (informational, not gated)`);
  return result;
}

// ---------------------------------------------------------------------------
// removeCodeFences
// ---------------------------------------------------------------------------
console.log("\n--- removeCodeFences ---");

// Basic: matched fences removed
{
  const input = "before ```code here``` after";
  const result = timed("basic fence removal", () => removeCodeFences(input));
  assert(result === "before  after", "basic fence removal content");
}

// Multiple fences
{
  const input = "a ```one``` b ```two``` c";
  const result = timed("multiple fences", () => removeCodeFences(input));
  assert(result === "a  b  c", "multiple fences content");
}

// Unclosed fence: everything from ``` to end is dropped
{
  const input = "keep this ```drop this forever";
  const result = timed("unclosed fence", () => removeCodeFences(input));
  assert(result === "keep this ", "unclosed fence content");
}

// STRESS: 20k chars with opening ``` and no close
{
  const input = "preamble " + "```" + "x".repeat(20000);
  const result = timed("20k unclosed fence", () => removeCodeFences(input));
  assert(result === "preamble ", "20k unclosed fence content");
}

// STRESS: 20k chars with many opening fences but no closes
{
  const chunk = "text ``` more ";
  const input = chunk.repeat(1500); // ~21k chars
  const result = timed("many unclosed fences", () => removeCodeFences(input));
  assert(result.length < input.length, "many unclosed fences shortened");
  assert(!result.includes("```"), "many unclosed fences no backticks remain");
}

// STRESS: 20k chars with many matched fences
{
  const pair = "keep ```remove``` ";
  const input = pair.repeat(1200); // ~21.6k chars
  const result = timed("many matched fences", () => removeCodeFences(input));
  assert(!result.includes("```"), "many matched fences no backticks");
  assert(result.includes("keep"), "many matched fences keeps text");
  assert(!result.includes("remove"), "many matched fences removes content");
}

// No fences: text unchanged
{
  const input = "plain text with no fences at all";
  const result = removeCodeFences(input);
  assert(result === input, "no fences unchanged");
}

// Empty string
{
  assert(removeCodeFences("") === "", "empty string");
}

// ---------------------------------------------------------------------------
// extractCodeFenceCandidates
// ---------------------------------------------------------------------------
console.log("\n--- extractCodeFenceCandidates ---");

// Basic JSON fence
{
  const input = '```json\n{"sql": "SELECT 1"}\n```';
  const result = timed("basic json fence", () => extractCodeFenceCandidates(input));
  assert(result.length === 1, "basic json fence count");
  assert(result[0].includes('"sql"'), "basic json fence content");
}

// Multiple fences, only some are JSON
{
  const input = '```json\n{"a":1}\n``` text ```\nplain text\n``` more ```json\n{"b":2}\n```';
  const result = extractCodeFenceCandidates(input);
  assert(result.length === 3, "multi fence count");
}

// STRESS: 20k chars, valid JSON fence near end
{
  const padding = "x".repeat(19900);
  const input = padding + '```json\n{"sql":"SELECT 1","explanation":"test"}\n```';
  const result = timed("20k + valid fence at end", () => extractCodeFenceCandidates(input));
  assert(result.length === 1, "20k + valid fence count");
  assert(result[0].includes('"sql"'), "20k + valid fence content");
}

// Unclosed fence: no candidates
{
  const input = "```json\n{broken";
  const result = extractCodeFenceCandidates(input);
  assert(result.length === 0, "unclosed fence no candidates");
}

// ---------------------------------------------------------------------------
// removeJsonWithSqlKey
// ---------------------------------------------------------------------------
console.log("\n--- removeJsonWithSqlKey ---");

// Basic: flat JSON with sql key
{
  const input = 'before {"sql":"SELECT 1","explanation":"test"} after';
  const result = removeJsonWithSqlKey(input);
  assert(result === "before  after", "basic json removal");
}

// No sql key: unchanged
{
  const input = 'text {"foo":"bar"} more';
  const result = removeJsonWithSqlKey(input);
  assert(result === input, "no sql key unchanged");
}

// STRESS: 20k chars with { but no "sql"
{
  const input = "{ " + "x".repeat(20000) + " }";
  const result = timed("20k no sql key", () => removeJsonWithSqlKey(input));
  assert(result === input, "20k no sql key unchanged");
}

// STRESS: 20k chars with "sql" but no closing }
{
  const input = '{"sql": "SELECT 1" ' + "x".repeat(20000);
  const result = timed("20k no closing brace", () => removeJsonWithSqlKey(input));
  assert(result === input, "20k no closing brace unchanged");
}

// STRESS: 20k of text with no braces at all
{
  const input = "x".repeat(20000);
  const result = timed("20k plain text", () => removeJsonWithSqlKey(input));
  assert(result === input, "20k plain text unchanged");
}

// STRESS: 20k unmatched opening braces (the case that broke the regex version at ~1774ms)
{
  const input = "{".repeat(20000) + "x".repeat(20000);
  const result = timed("20k unmatched opening braces", () => removeJsonWithSqlKey(input));
  assert(result === input, "20k unmatched braces unchanged");
}

// Nested JSON with sql key — only outer block removed
{
  const input = 'before {"outer":true,"sql":"SELECT 1","inner":{"a":1}} after';
  const result = removeJsonWithSqlKey(input);
  assert(result === "before  after", "nested json with sql removed");
}

// Multiple blocks, only one has sql
{
  const input = '{"foo":"bar"} middle {"sql":"SELECT 1"} end';
  const result = removeJsonWithSqlKey(input);
  assert(result.includes('"foo"'), "non-sql block kept");
  assert(!result.includes('"sql"'), "sql block removed");
  assert(result.includes("end"), "trailing text kept");
}

// ---------------------------------------------------------------------------
// sanitizeExplanation (integrated)
// ---------------------------------------------------------------------------
console.log("\n--- sanitizeExplanation ---");

// Normal explanation passes through
{
  const input = "This shows murder counts in Houston from 2020 to 2024.";
  const result = sanitizeExplanation(input);
  assert(result === input, "normal explanation unchanged");
}

// Explanation with code fence stripped
{
  const input = "Results below. ```SELECT * FROM victims``` Check the chart.";
  const result = timed("fence in explanation", () => sanitizeExplanation(input));
  assert(!result.includes("SELECT"), "fence in explanation no SQL");
  assert(result.includes("Results"), "fence in explanation keeps text");
}

// JSON response as explanation — extracts explanation field
{
  const input = '{"sql":"SELECT 1","explanation":"Murder data for Texas.","title":"Test"}';
  const result = sanitizeExplanation(input);
  assert(result === "Murder data for Texas.", "json extraction");
}

// STRESS: 20k Sonnet-style explanation with unclosed fence
{
  const input = "This shows crime data for Houston. ```sql\nSELECT " + "col, ".repeat(4000) + "FROM big_table";
  const result = timed("20k sonnet with unclosed fence", () => sanitizeExplanation(input));
  assert(result.includes("Houston"), "20k sonnet keeps explanation");
  assert(!result.includes("SELECT"), "20k sonnet removes SQL");
}

// STRESS: 20k with embedded JSON that has "sql"
{
  const preamble = "Here is the data. ";
  const jsonBlock = '{"sql":"SELECT x FROM y","explanation":"test"}';
  const filler = " Additional context. ".repeat(950);
  const input = preamble + jsonBlock + filler;
  const result = timed("20k with embedded json", () => sanitizeExplanation(input));
  assert(!result.includes('"sql"'), "20k embedded json removed");
}

// STRESS: 20k of pure text, no fences or JSON
{
  const input = "This is a perfectly normal explanation. ".repeat(530);
  const result = timed("20k pure text", () => sanitizeExplanation(input));
  assert(result.length > 100, "20k pure text preserved");
}

// Short text fallback
{
  const input = '```SELECT 1```';
  const result = sanitizeExplanation(input);
  assert(result.includes("wasn't able to generate"), "short text fallback");
}

// ---------------------------------------------------------------------------
// extractJson (integrated — uses extractCodeFenceCandidates now)
// ---------------------------------------------------------------------------
console.log("\n--- extractJson ---");

// Bare JSON object
{
  const input = '{"sql":"SELECT 1","explanation":"test","title":"T","chartHint":"none","xAxis":"","yAxis":""}';
  const result = extractJson(input) as Record<string, unknown>;
  assert(result !== null && result.sql === "SELECT 1", "bare json parsed");
}

// JSON in code fence
{
  const input = 'Here is the query:\n```json\n{"sql":"SELECT 1","explanation":"test"}\n```\n';
  const result = extractJson(input) as Record<string, unknown>;
  assert(result !== null && result.sql === "SELECT 1", "fenced json parsed");
}

// Multiple JSON blocks — last wins
{
  const input = '```json\n{"sql":"SELECT 1"}\n```\nActually revised:\n```json\n{"sql":"SELECT 2"}\n```';
  const result = extractJson(input) as Record<string, unknown>;
  assert(result !== null && result.sql === "SELECT 2", "last json wins");
}

// STRESS: 20k padding then valid JSON fence
{
  const padding = "Here is a long explanation. ".repeat(800);
  const json = '{"sql":"SELECT count(*) FROM summary_state_monthly","explanation":"test"}';
  const input = padding + "```json\n" + json + "\n```";
  const result = timed("20k + json fence", () => extractJson(input)) as Record<string, unknown>;
  assert(result !== null && (result.sql as string).includes("summary_state"), "20k json fence parsed");
}

// STRESS: 20k with unclosed fence + valid bare JSON
{
  const input = "```broken fence\n" + "x".repeat(19000) + '\n{"sql":"SELECT 1","explanation":"ok"}';
  const result = timed("20k unclosed + bare json", () => extractJson(input)) as Record<string, unknown>;
  assert(result !== null && result.sql === "SELECT 1", "unclosed fence + bare json");
}

// No valid JSON
{
  const input = "This is just text with no JSON at all.";
  const result = extractJson(input);
  assert(result === null, "no json returns null");
}

// ---------------------------------------------------------------------------
// Long SQL through sanitizeExplanation (not a separate stress case, but
// confirms the SELECT...FROM regex doesn't backtrack either)
// ---------------------------------------------------------------------------
console.log("\n--- SQL pattern in sanitizeExplanation ---");

{
  // Long SQL without semicolon or double-newline (worst case for the SELECT...FROM regex)
  const longSql = "SELECT " + Array.from({ length: 500 }, (_, i) => `col_${i}`).join(", ") + " FROM big_table WHERE x = 1";
  const input = "Explanation text. " + longSql + " More text after.";
  const result = timed("long SQL removal", () => sanitizeExplanation(input));
  assert(!result.includes("SELECT"), "long SQL removed");
  assert(result.includes("Explanation"), "surrounding text kept");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed.");
}
