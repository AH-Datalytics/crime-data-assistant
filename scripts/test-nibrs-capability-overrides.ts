#!/usr/bin/env npx tsx

import { detectNibrsCapabilityOverride } from "../lib/nibrs-capability-overrides.js";
import { detectShrGroupRateOverride, detectSubCityGeographyOverride } from "../lib/capability-overrides.js";
import { removedDemographicPlaceToken } from "../lib/demographic-rate-intent.js";

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
  const r = detectSubCityGeographyOverride("murders by zip code in Chicago");
  assert("sub-city geography gets deterministic source-wide override",
    r?.guardrail === "sub-city-geography-unsupported",
    JSON.stringify(r));
  assert("sub-city explanation says FBI has no below-city/county geography",
    Boolean(r?.explanation.includes("The FBI does not report crime data below the city/county/agency level")),
    r?.explanation);
  assert("sub-city explanation does not suggest NIBRS or another site",
    Boolean(r && !/NIBRS|local police|open data|CompStat/i.test(r.explanation)),
    r?.explanation);
}

{
  const r = detectNibrsCapabilityOverride("crime by ZIP code in Chicago");
  assert("NIBRS uses shared sub-city override before model/SQL",
    r?.guardrail === "sub-city-geography-unsupported",
    JSON.stringify(r));
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
  const r = detectNibrsCapabilityOverride("Please show me the juvenile crime rate over time, 2020-2025, in Minneapolis, MN.");
  assert("juvenile population rate gets a deterministic NIBRS override",
    r?.guardrail === "demographic-rate-unsupported",
    JSON.stringify(r));
  assert("juvenile rate response offers counts, shares, and an overall rate",
    Boolean(r?.explanation.includes("raw demographic counts") && r.explanation.includes("share") && r.explanation.includes("overall crime rate")),
    r?.explanation);
}

{
  const r = detectNibrsCapabilityOverride("juvenile clearance rate for robbery in Minneapolis");
  assert("juvenile clearance rates remain queryable", r === null, JSON.stringify(r));
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

{
  const r = detectNibrsCapabilityOverride("show me violent crime offenders by age for Tarrant County, Texas");
  assert("countywide NIBRS offender demographics get deterministic refusal",
    r?.guardrail === "nibrs-countywide-demographics-unsupported",
    JSON.stringify(r));
  assert("countywide demographics refusal points to better choices",
    Boolean(r?.explanation.includes("specific city or agency") && r.explanation.includes("countywide offense count")),
    r?.explanation);
}

{
  const r = detectNibrsCapabilityOverride("violent crime in Tarrant County, Texas by year");
  assert("countywide offense counts without demographics remain queryable", r === null, JSON.stringify(r));
}

{
  const r = detectNibrsCapabilityOverride("offender age breakdown for robberies in Fort Worth");
  assert("city demographic breakdowns remain queryable", r === null, JSON.stringify(r));
}

{
  const r = detectNibrsCapabilityOverride("which agencies are mapped to Tarrant County, Texas?");
  assert("county agency metadata questions remain queryable", r === null, JSON.stringify(r));
}


{
  const r = detectNibrsCapabilityOverride("What is the aggravated assault rate in White Plains, NY?");
  assert("White Plains place name does not trigger a demographic-rate refusal", r === null, JSON.stringify(r));
}

{
  const r = detectNibrsCapabilityOverride("Sex offense rates in Denver since 2019");
  assert("sex-offense category does not trigger a demographic-rate refusal", r === null, JSON.stringify(r));
}

for (const question of [
  "Murder rate for teenagers in Chicago since 2019",
  "Murder rate for elderly residents in Chicago since 2019",
  "Crime rate for seniors in Chicago since 2019",
  "Crime rate for kids in Chicago since 2019",
  "Crime rate for children in Chicago since 2019",
  "Crime rate for minors in Chicago since 2019",
  "Women's robbery victimization rate in Chicago",
]) {
  const r = detectNibrsCapabilityOverride(question);
  assert("demographic age/sex rate is refused: " + question,
    r?.guardrail === "demographic-rate-unsupported",
    JSON.stringify(r));
}

assert("White Plains is the narrow demographic-place disambiguation case",
  removedDemographicPlaceToken("What is the aggravated assault rate in White Plains, NY?"));
assert("ordinary rate questions do not receive demographic-place model guidance",
  !removedDemographicPlaceToken("What is the robbery rate in Chicago?"));
assert("unresolved women's language is not mistaken for a place",
  !removedDemographicPlaceToken("Women's robbery victimization rate in Chicago"));

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
