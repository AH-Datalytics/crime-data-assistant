/**
 * H1 chatty openers (bad-declines plan, family H1): a greeting or request wrapper before a question the engine already reads.
 * Offline: the shadow slice with a stub DuckDB step. Each labeled question must get past the reader.
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
  ["ct-ad00be05cd", "Hi Jeff can you get me murder rates for denver since 1980"],
  ["hist-57f21eea47", "hi; any way to tell me about violent crime data in albuquerque new mexico"],
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
  ["greeting is dropped", () => assert.equal(read("Hello there, murders in Denver in 2024").trim(), "murders in Denver in 2024")],
  ["a word starting with hi is kept", () => assert.ok(/^high school/i.test(read("high school robberies in Denver in 2024").trim()))],
  ["a request wrapper is dropped", () => assert.ok(/^show me murders in Denver/.test(read("Could you please give me murders in Denver in 2024")), read("Could you please give me murders in Denver in 2024"))],
  ["HI in capitals is Hawaii (Codex 03d136e1)", () => assert.ok(/^HI murders in 2024/.test(read("HI murders in 2024").trim()), read("HI murders in 2024"))],
  ["The Dalles keeps its The (Codex 03d136e1)", () => assert.ok(/The Dalles murders/.test(read("Can you show me The Dalles murders in 2024")), read("Can you show me The Dalles murders in 2024"))],
  ["a comma after the greeting name (Codex 03d136e1)", () => assert.ok(/^show me murders in Texas/.test(read("Hi, Jeff, can you show me murders in Texas in 2024").trim()), read("Hi, Jeff, can you show me murders in Texas in 2024"))],
  ["a place starting with a greeting name is kept (Codex 464d5d03)", () => assert.ok(/^Jefferson City murders in 2024/.test(read("Hi Jefferson City murders in 2024").trim()), read("Hi Jefferson City murders in 2024"))],
  ["a wrapped change question still reads as a change (Codex 464d5d03)", () => assert.equal(read("Can you show me how murder in Denver has changed since 2020"), read("how murder in Denver has changed since 2020"))],
  ["a name that is part of a place is kept (Codex f394af1a)", () => { assert.ok(/^Jeff Davis County murders/.test(read("Hey Jeff Davis County murders in 2024").trim())); assert.ok(/^Claude, Texas murders/.test(read("Hey Claude, Texas murders in 2024").trim()), read("Hey Claude, Texas murders in 2024")); }],
  ["a wrapper before a comparison keeps the comparison reading (Codex f394af1a)", () => assert.equal(read("Hey Im interested in how does murder in Denver compare to Boston in 2024").trim(), read("How does murder in Denver compare to Boston in 2024").trim())],
  ["a greeting before tell me about is dropped too (Codex f394af1a)", () => assert.equal(read("Hi, tell me about murder rates in Denver in 2024").trim(), read("tell me about murder rates in Denver in 2024").trim())],
  ["tell me whats going on and one-space wrappers (Codex f394af1a)", () => { for (const q of ["tell me whats going on with murders in Denver in 2024", "I want murders in Denver in 2024", "I would like murders in Denver in 2024", "I'd like murders in Denver in 2024"]) assert.ok(/^show me murders in Denver/.test(read(q).trim()), `${q} -> ${read(q)}`); }],
  ["a wrapper before a place that starts with The keeps the place (Codex bfad2248)", () => assert.ok(/^The Dalles murders in 2024/.test(read("I'm looking for The Dalles murders in 2024").trim()), read("I'm looking for The Dalles murders in 2024"))],
];
for (const [name, fn] of checks) { try { fn(); console.log(`  PASS  ${name}`); } catch (e) { console.log(`  FAIL  ${name}: ${(e as Error).message}`); failed++; } }
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("chatty opener tests passed");
