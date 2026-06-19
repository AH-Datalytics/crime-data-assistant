#!/usr/bin/env npx tsx

import { detectNibrsCapabilityOverride } from "../lib/nibrs-capability-overrides.js";

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

console.log(`nibrs capability override tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
