/**
 * Ward false-refusal: BEHAVIORAL proof.
 *
 * WHY THIS FILE EXISTS SEPARATELY. The `2026-09-08-folded-correction-proposal-codex-ruling.md` §3C
 * requires the before-proof to fail on the RELEVANT BEHAVIOR. Restoring the historical
 * `test-subcity-geography.ts` wholesale would fail on a missing import (`asksSubCityGeography` is
 * gone from `capability-overrides`), and an import error is explicitly NOT reproduction of Ward's
 * false refusal. So this file imports only what the untouched candidate already exports, and
 * asserts the decision itself.
 *
 * WHAT IT ASSERTS. Three real places whose names collide with the sub-city vocabulary must NOT be
 * refused, and genuine sub-city requests must still BE refused. Both halves run before and after
 * the repair: the positives are the defect (fail before, pass after), the negatives are an existing
 * valid protection (must pass before AND after, never broken to manufacture a demonstration).
 *
 * PATHS EXERCISED. The pre-SQL front door that the query/shr/hc routes call directly, the NIBRS
 * wrapper that reaches the same decision by its own route, and the post-SQL capability rule across
 * all five sources. No database, no network, no model call.
 */
import * as fs from "fs";
import * as path from "path";
import { detectSubCityGeographyOverride } from "../lib/capability-overrides";
import { detectNibrsCapabilityOverride } from "../lib/nibrs-capability-overrides";
import { SOURCE_CAPABILITY_RULES } from "../lib/source-capabilities";
import type { QueryContractSource } from "../lib/query-contract";

const SOURCES: QueryContractSource[] = ["current", "historical", "nibrs", "shr", "hate_crime"];

/** Real places whose names collide with the vocabulary. Must reach the reader, not be refused. */
const MUST_ANSWER = [
  "How many murders were reported in Ward, AR in 2022?",
  "How many murders did the Ward police department report in 2022?",
  "What was the Ward murder rate in 2022?",
];

/** Genuine sub-city geography. Must stay refused. */
const MUST_REFUSE = [
  "crime by ward in DC",
  "crime in the ward",
  "How many murders were reported in the 5th ward of New Orleans, LA in 2022?",
  "How many murders were reported in ward 9 of New Orleans, LA in 2022?",
  "Give me a ward-by-ward breakdown of murders in New Orleans in 2022.",
];

/** Control: unrelated to the vocabulary, must be unaffected in both directions. */
const CONTROL = ["crime in Kansas City, Missouri"];

let failures = 0;
let checks = 0;

function check(cond: boolean, message: string) {
  checks++;
  if (!cond) {
    failures++;
    console.log(`  FAIL  ${message}`);
  }
}

/** Stage A — the front door the query/shr/hc routes call. */
function frontDoorRefuses(question: string): boolean {
  return detectSubCityGeographyOverride(question) !== null;
}

/** Stage A — the NIBRS wrapper reaching the same decision by its own path. */
function nibrsWrapperRefuses(question: string): boolean {
  const override = detectNibrsCapabilityOverride(question);
  return override !== null && override.guardrail === "sub-city-geography-unsupported";
}

/** Stage B — the post-SQL capability rule, per source. */
function capabilityRuleFires(question: string, source: QueryContractSource): boolean {
  return SOURCE_CAPABILITY_RULES.some(
    (rule) =>
      rule.id === "unsupported-sub-city-geography" &&
      rule.source === source &&
      rule.when({ question } as never)
  );
}

console.log("Ward false-refusal behavioral proof");
console.log("");

console.log("MUST ANSWER - real places that collide with the vocabulary");
for (const q of MUST_ANSWER) {
  check(!frontDoorRefuses(q), `front door must not refuse: ${q}`);
  check(!nibrsWrapperRefuses(q), `NIBRS wrapper must not refuse: ${q}`);
  for (const s of SOURCES) {
    check(!capabilityRuleFires(q, s), `capability rule (${s}) must not fire: ${q}`);
  }
}

console.log("MUST REFUSE - genuine sub-city geography");
for (const q of MUST_REFUSE) {
  check(frontDoorRefuses(q), `front door must refuse: ${q}`);
  check(nibrsWrapperRefuses(q), `NIBRS wrapper must refuse: ${q}`);
  for (const s of SOURCES) {
    check(capabilityRuleFires(q, s), `capability rule (${s}) must fire: ${q}`);
  }
}

console.log("CONTROL - unrelated question");
for (const q of CONTROL) {
  check(!frontDoorRefuses(q), `front door must not refuse: ${q}`);
  check(!nibrsWrapperRefuses(q), `NIBRS wrapper must not refuse: ${q}`);
}


/* ------------------------------------------------------------------ */
/*  Supplementary tripwires - restored from 28e5ba5, spliced verbatim. */
/*                                                                     */
/*  These are SOURCE scans, not behavior, and per the folded proposal   */
/*  they do not substitute for the behavioral checks above. They are    */
/*  here because they are the checks that would have caught this exact  */
/*  same-name private-copy regression, and they were deleted with the   */
/*  other 404 lines.                                                    */
/* ------------------------------------------------------------------ */
console.log("SUPPLEMENTARY - source tripwires");
const REPO_ROOT = path.resolve(__dirname, "..");

const CONSUMER_ENTRY_POINTS: Array<[string, string]> = [
  ["app/api/query/route.ts", "detectSubCityGeographyOverride("],
  ["app/api/shr-query/route.ts", "detectSubCityGeographyOverride("],
  ["app/api/hc-query/route.ts", "detectSubCityGeographyOverride("],
  ["lib/nibrs-capability-overrides.ts", "detectSubCityGeographyOverride("],
  ["app/api/nibrs-query/route.ts", "detectNibrsCapabilityOverride("],
  ["lib/source-capabilities.ts", "asksSubCityGeography("],
  ["lib/guardrails.ts", "asksSubCityGeography("],
];

for (const [file, needle] of CONSUMER_ENTRY_POINTS) {
  const src = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
  check(src.includes(needle), `${file} should reach the sub-city decision through ${needle}`);
}

// The old exported regex is gone, and no consumer carries its own copy of the token list.
const BYPASS_SCAN_FILES = [
  ...CONSUMER_ENTRY_POINTS.map(([file]) => file),
  "lib/query-contract-validator.ts",
  "lib/capability-decision.ts",
];
for (const file of BYPASS_SCAN_FILES) {
  const full = path.join(REPO_ROOT, file);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, "utf8");
  check(!src.includes("SUB_CITY_GEOGRAPHY_RE"), `${file} should not use a raw sub-city regex`);
  check(
    !/\\b\(?[^\n]*wards\?/.test(src),
    `${file} should not re-implement the sub-city token list`
  );
}
console.log("");
console.log(`checks: ${checks}   failures: ${failures}`);
if (failures > 0) {
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
