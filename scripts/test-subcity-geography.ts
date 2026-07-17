#!/usr/bin/env npx tsx

import assert from "node:assert/strict";
import {
  SUB_CITY_GEOGRAPHY_MESSAGE,
  detectSubCityGeographyOverride,
} from "../lib/capability-overrides";
import { detectNibrsCapabilityOverride } from "../lib/nibrs-capability-overrides";
import { buildQueryContract, type QueryContractSource } from "../lib/query-contract";
import { validateSourceCapabilities } from "../lib/source-capabilities";

const SOURCES: QueryContractSource[] = ["current", "historical", "nibrs", "shr", "hate_crime"];

const BLOCK_CASES = [
  "murders by ZIP code in Chicago",
  "crime by neighborhood in Houston",
  "fatal shootings by census tract in Chicago",
  "hate crimes by precinct in New York",
  "crime by ward in DC",
  "assaults by block group in Atlanta",
  "burglaries by police district in Baltimore",
  "robberies by community area in Chicago",
  "calls at Oakwood apartment complex in Dallas",
  "crime around Lakeside housing complex in Phoenix",
];

const ALLOW_CASES = [
  "which cities are in Santa Clara County",
  "crime in Kansas City, Missouri",
  "violent crime in Washington State",
  "violent crime in communities of 250k or more",
  "apartment burglaries in Dallas",
  "burglaries at apartments in Dallas",
  "community policing related crimes",
  "police departments in Cook County Illinois",
  "which agencies are included in Baltimore County Maryland",
  "crime in New York City by year",
];

function sourceCapabilityIds(question: string, source: QueryContractSource): string[] {
  const contract = buildQueryContract(question, source);
  assert(contract, `${source}: expected contract for "${question}"`);
  return validateSourceCapabilities({
    question,
    source,
    contract,
    sql: "SELECT 1",
  }).map((finding) => finding.ruleId);
}

for (const question of BLOCK_CASES) {
  const override = detectSubCityGeographyOverride(question);
  assert.equal(
    override?.guardrail,
    "sub-city-geography-unsupported",
    `front-door override should block: ${question}`
  );
  assert.equal(
    override?.explanation,
    SUB_CITY_GEOGRAPHY_MESSAGE,
    `front-door override should use shared message: ${question}`
  );
  assert(
    !/NIBRS|local police|open data|CompStat/i.test(override?.explanation || ""),
    `override should not suggest another source: ${question}`
  );

  const nibrsOverride = detectNibrsCapabilityOverride(question);
  assert.equal(
    nibrsOverride?.guardrail,
    "sub-city-geography-unsupported",
    `NIBRS front-door wrapper should block before other overrides: ${question}`
  );

  for (const source of SOURCES) {
    assert(
      sourceCapabilityIds(question, source).includes("unsupported-sub-city-geography"),
      `${source}: source-capability contract should block: ${question}`
    );
  }
}

for (const question of ALLOW_CASES) {
  const override = detectSubCityGeographyOverride(question);
  assert.equal(override, null, `front-door override should not block: ${question}`);

  const nibrsOverride = detectNibrsCapabilityOverride(question);
  assert.notEqual(
    nibrsOverride?.guardrail,
    "sub-city-geography-unsupported",
    `NIBRS wrapper should not use sub-city refusal: ${question}`
  );

  for (const source of SOURCES) {
    assert(
      !sourceCapabilityIds(question, source).includes("unsupported-sub-city-geography"),
      `${source}: source-capability contract should not block: ${question}`
    );
  }
}

console.log(`sub-city geography tests passed: ${BLOCK_CASES.length} blockers, ${ALLOW_CASES.length} negative controls, ${SOURCES.length} sources`);
