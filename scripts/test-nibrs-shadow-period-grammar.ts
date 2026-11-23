/**
 * D1 period grammar (bad-declines plan, family D1): wording for a period the engine already reads ("the last three (3)
 * years", "as far as you can", "from oldest data", "2021 until 2025"). Offline: the shadow slice with a stub DuckDB step.
 * Each labeled question must get past the reader (a build-dependent route may still say "This isn't available here.").
 * No database, no model, no network.
 */
import assert from "node:assert/strict";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { readQuestion } from "../lib/nibrs-shadow/reading";

const deps: ShadowDeps = {
  places: loadPlaceIndex(),
  release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-10", asOf: "2026-11-23" } as never,
  target: { root: "/build", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] } as never,
  execute: () => [],
};
const CASES: [string, string][] = [
  ["hist-3da672601a", "What are the crime trends for Baltimore, Maryland over the last three (3) years?"],
  ["hist-5dab43df7a", "can you graph national violent crime rates back as far as you can."],
  ["hist-82abcdbbd2", "show me the violent crime stats for Seattle, WA, year by year, going back as far as records allow"],
  ["hist-c35064c719", "show new orleans murders from oldest data"],
];
let failed = 0;
for (const [id, q] of CASES) {
  try {
    const o = shadowAnswer(q, deps) as unknown as { explanation?: string };
    assert.ok(!/couldn't find|didn't understand|couldn't use|couldn't tell/i.test(String(o.explanation ?? "")), `${id}: ${String(o.explanation).slice(0, 120)}`);
    console.log(`  PASS  ${id}`);
  } catch (e) { console.log(`  FAIL  ${(e as Error).message}`); failed++; }
}
const read = (q: string) => readQuestion(q, 2026).text;
const checks: [string, () => void][] = [
  ["a number word with its digits repeated", () => assert.ok(/last three years/.test(read("murders in Denver over the last three (3) years")))],
  ["all-years wordings", () => { for (const w of ["back as far as you can", "from oldest data", "since the beginning"]) assert.ok(/murders in Denver by year/.test(read(`murders in Denver ${w}`)), w); }],
  ["until reads as to", () => assert.ok(/2021 to 2025/.test(read("murders in Denver 2021 until 2025")) && /from 2019 to 2024/.test(read("murders in Denver since 2019 until 2024")))],
  ["a qualified start is not an all-years wording", () => assert.ok(/since the beginning of 2024/.test(read("murders in Denver since the beginning of 2024")), read("murders in Denver since the beginning of 2024"))],
];
for (const [name, fn] of checks) { try { fn(); console.log(`  PASS  ${name}`); } catch (e) { console.log(`  FAIL  ${name}: ${(e as Error).message}`); failed++; } }
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("period grammar tests passed");
