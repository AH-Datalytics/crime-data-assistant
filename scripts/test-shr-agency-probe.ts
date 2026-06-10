import assert from "node:assert/strict";
import {
  appendShrAgencyProbeCaveat,
  buildShrAgencyProbe,
  isZeroResult,
} from "../lib/shr-agency-probe";

{
  const probe = buildShrAgencyProbe(
    "SELECT COUNT(*) FROM incidents i WHERE i.agency = 'St. Louis County' AND i.state = 'MO' AND i.agency_type = 'County'"
  );
  assert.ok(probe);
  assert.equal(probe.agency, "St. Louis County");
  assert.equal(probe.state, "MO");
  assert.deepEqual(probe.params, ["%St%", "%Louis%", "MO"]);
  assert.match(probe.where, /agency LIKE \? AND agency LIKE \? AND state = \?/);
}

{
  assert.equal(isZeroResult([{ year: 2026, victims: 0 }], ["year", "victims"]), true);
  assert.equal(isZeroResult([{ year: 2026, victims: 1 }], ["year", "victims"]), false);
  assert.equal(isZeroResult([{ year: 2025, victims: 0 }, { year: 2026, victims: 0 }], ["year", "victims"]), false);
}

{
  const explanation = appendShrAgencyProbeCaveat("The query returned no results.", "St. Louis County");
  assert.match(explanation, /similar agency names for St\. Louis County/);
  assert.equal(appendShrAgencyProbeCaveat(explanation, "St. Louis County"), explanation);
}

console.log("SHR agency probe tests passed");
