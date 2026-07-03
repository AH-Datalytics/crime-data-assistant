#!/usr/bin/env npx tsx

import { detectNibrsCapabilityOverride } from "../lib/nibrs-capability-overrides.js";
import { detectShrGroupRateOverride } from "../lib/capability-overrides.js";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

{
  const r = detectNibrsCapabilityOverride("Does NIBRS data have information on use of force?");
  assert("#4221 use-of-force availability gets deterministic override",
    r?.guardrail === "nibrs-use-of-force-unsupported",
    JSON.stringify(r));
  assert("#4221 answer says no",
    Boolean(r?.explanation.includes("No.") && r.explanation.includes("does not contain")),
    r?.explanation);
}

{
  const r = detectNibrsCapabilityOverride("homicide rates for gender and race");
  assert("#4442 demographic homicide rates get deterministic override",
    r?.guardrail === "demographic-homicide-rate-denominator-unavailable",
    JSON.stringify(r));
  assert("#4442 answer says no demographic denominators",
    Boolean(r?.explanation.includes("population denominators") && r.explanation.includes("counts")),
    r?.explanation);
}

{
  const r = detectNibrsCapabilityOverride("show robberies involving firearms in Texas");
  assert("ordinary NIBRS weapon query does not trigger override", r === null, JSON.stringify(r));
}

{
  const r = detectNibrsCapabilityOverride("homicide counts by gender and race");
  assert("ordinary demographic homicide counts remain queryable", r === null, JSON.stringify(r));
}

{
  const r = detectNibrsCapabilityOverride("justifiable homicides where criminals were killed by police");
  assert("narrow killed-by-police justifiable homicide remains queryable", r === null, JSON.stringify(r));
}

// --- SHR-tab group-rate override: follow-up-safe (no homicide word required) ---
// query-audit-2026-07-03 F27: front door was blind to follow-ups that drop "murder"
{
  const r = detectShrGroupRateOverride("i want ir in per capita seperated by race and sex");
  assert("#4704 follow-up per-capita by race+sex fires without homicide word",
    r?.guardrail === "demographic-homicide-rate-denominator-unavailable",
    JSON.stringify(r));
}

{
  const r = detectShrGroupRateOverride("Population by race and sex and rate per 100000");
  assert("#4705 rate-per-100k by race+sex fires without homicide word",
    r?.guardrail === "demographic-homicide-rate-denominator-unavailable",
    JSON.stringify(r));
}

{
  const r = detectShrGroupRateOverride("murder rate by age group nationally");
  assert("rate by age group fires (age has no denominator either)",
    r?.guardrail === "demographic-homicide-rate-denominator-unavailable",
    JSON.stringify(r));
}

{
  const r = detectShrGroupRateOverride("murder rate per capita by state in 2024");
  assert("overall per-capita rate by state does NOT fire", r === null, JSON.stringify(r));
}

{
  const r = detectShrGroupRateOverride("i want to know the counts of murder comited by blacks asians hispanics and white prople also seperated by sex");
  assert("#4702 counts by race+sex (no rate word) does NOT fire", r === null, JSON.stringify(r));
}

{
  const r = detectShrGroupRateOverride("what share of murders were committed by men");
  assert("share question (no rate word) does NOT fire", r === null, JSON.stringify(r));
}

{
  // Clearance questions must fall through to shr-clearance-override's redirect,
  // not get a misleading population-denominator refusal
  const r = detectShrGroupRateOverride("clearance rate for murders by victim race");
  assert("clearance rate by race does NOT fire (clearance override handles it)", r === null, JSON.stringify(r));
}

// --- CODEX_REVIEW_9577edc finding 1: broader rate-intent phrasings ---
{
  const r = detectShrGroupRateOverride("murders per 10,000 Black residents");
  assert("per 10,000 phrasing fires", r !== null, JSON.stringify(r));
}
{
  const r = detectShrGroupRateOverride("murder risk by race");
  assert("'risk by race' fires", r !== null, JSON.stringify(r));
}
{
  const r = detectShrGroupRateOverride("murders relative to population by ethnicity");
  assert("'relative to population' fires", r !== null, JSON.stringify(r));
}
{
  const r = detectShrGroupRateOverride("murders per million men");
  assert("'per million' fires", r !== null, JSON.stringify(r));
}

// --- CODEX_REVIEW_9577edc finding 2: non-SHR concepts get the accurate refusal ---
{
  const r = detectShrGroupRateOverride("arrest rate by race for robbery in Chicago");
  assert("non-homicide concept (robbery arrests) does NOT fire the denominator refusal",
    r === null, JSON.stringify(r));
}
{
  const r = detectShrGroupRateOverride("drug arrest rates by sex");
  assert("drug arrests do NOT fire the denominator refusal", r === null, JSON.stringify(r));
}

console.log(`nibrs capability override tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
