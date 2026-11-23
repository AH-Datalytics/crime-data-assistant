/**
 * Open-ended asks and data-absent asks (bad-declines plan, Jeff 2026-11-23): eight open-ended questions clarify instead of
 * taking the P182 default, five asks about data the release does not hold get "That data is not available.", and neighbors
 * that name a crime and a period are not caught. Offline: the shadow slice with a stub DuckDB step. No database, model or network.
 */
import assert from "node:assert/strict";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";

const deps: ShadowDeps = {
  places: loadPlaceIndex(),
  release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-10", asOf: "2026-11-23" } as never,
  target: { root: "/build", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] } as never,
  execute: () => [],
};
const CLARIFY: [string, string][] = [
  ["ct-32f3dc9a09", "Tell me more about crime in Arlington, VA"],
  ["ct-d20e00174a", "What major crime trends are we seeing in Baltimore, Maryland?"],
  ["ct-20633e56af", "What are the top nationwide crime trends ?"],
  ["shr-cfb68f38b1", "tell me what's going on in allentown"],
  ["shr-73d854a567", "show me a time line of portland Oregon"],
  ["hist-d4e1c904e9", "Is Lauderhill\u2019s murder rate relative to its population considered high?"],
  ["ct-294637e19a", "What New Orleans Part 1 data do you have besides murder"],
  ["ct-f97f93a130", "How many crime incidents have happened in Chicago since 2025?"],
];
const ABSENT: [string, string][] = [
  ["nibrs-87d6948140", "Does NIBRS data have information on use of force?"],
  ["hist-365d88b7b5", "why does california data only go back to 1958?"],
  ["nibrs-24f9978d04", "How many agencies in PA are NIBRS compliant?"],
  ["nibrs-0ef7ca8744", "For NIBRS, are you using national estimates or unweighted data?"],
  ["hist-f8b8d0a58b", "does this data use the hierarchy rule"],
];
let failed = 0;
const run = (name: string, fn: () => void) => { try { fn(); console.log(`  PASS  ${name}`); } catch (e) { console.log(`  FAIL  ${name}: ${(e as Error).message}`); failed++; } };
for (const [id, q] of CLARIFY) run(id, () => assert.equal(shadowAnswer(q, deps).kind, "clarify"));
for (const [id, q] of ABSENT) run(id, () => { const o = shadowAnswer(q, deps) as unknown as { kind: string; explanation?: string }; assert.equal(o.kind, "decline"); assert.ok(/^That data is not available\./.test(String(o.explanation)), String(o.explanation)); });
run("a question with a year and a crime is not open-ended", () => assert.notEqual((shadowAnswer("murders in Denver in 2024", deps) as unknown as { about?: string }).about, "the whole question"));
run("major crime trends with a year is not caught", () => assert.notEqual((shadowAnswer("major crime trends in Denver in 2024", deps) as unknown as { about?: string }).about, "the whole question"));
run("a place that contains a time line word is not caught", () => assert.notEqual((shadowAnswer("robberies in Denver in 2024", deps) as unknown as { about?: string }).about, "the whole question"));
for (const q of ["What's going on in Denver with robberies in 2024?", "Show a time line of robberies in Denver from 2020 to 2024.", "Tell me more about the number of murders in Chicago in 2024.", "How many crime incidents involving robbery occurred in Denver since 2020?", "Show a time line of robberies in Denver in 2024 with a logarithmic scale."])
  run(`a named crime is not open-ended: ${q}`, () => assert.notEqual((shadowAnswer(q, deps) as unknown as { about?: string }).about, "which part to show"));
run("what is going on in a place clarifies (Codex 15661f03)", () => assert.equal(shadowAnswer("What is going on in Allentown?", deps).kind, "clarify"));
run("Part I in Roman numerals clarifies (Codex 15661f03)", () => assert.equal(shadowAnswer("What Part I data do you have for New Orleans besides murder?", deps).kind, "clarify"));
run("a time line of a named crime reads like the plain question (Codex 15661f03)", () => { const a = shadowAnswer("Show a time line of robberies in Denver from 2020 to 2024.", deps) as unknown as { kind: string; explanation?: string }; const b = shadowAnswer("Show robberies in Denver from 2020 to 2024.", deps) as unknown as { kind: string; explanation?: string }; assert.equal(a.kind, b.kind); assert.equal(a.explanation, b.explanation); });
if (failed) { console.log(`${failed} failed`); process.exit(1); }
