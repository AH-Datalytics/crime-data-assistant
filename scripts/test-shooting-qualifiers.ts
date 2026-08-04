/**
 * Production 7881: "What is the trend of police fatal shootings over the last..."
 * returned ALL firearm homicides — 14,777 for 2023 against a correct 349, a 42x
 * overstatement — because the deterministic shooting path has no concept of
 * qualifiers. 7639 ("officer involved fatal shootings") hit the same path.
 */

import assert from "node:assert/strict";
import { classifyShootingQualifier, POLICE_SHOOTING_QUALIFIER } from "../lib/shooting-qualifiers";

// ---------------------------------------------------------- supported: police
const POLICE_PHRASINGS = [
  "What is the trend of police fatal shootings over the last 20 years",
  "How many officer involved fatal shootings happened since 2015",
  "police shootings by year",
  "how many people were shot by police in 2023",
  "trend of officer-involved shootings",
  "fatal law enforcement shootings since 2010",
  "how many people were killed by police in Texas",
];
for (const q of POLICE_PHRASINGS) {
  const result = classifyShootingQualifier(q);
  assert.equal(result.kind, "supported", `must classify as supported: ${JSON.stringify(q)}`);
  if (result.kind === "supported") {
    assert.equal(result.qualifier.id, "police", `must be the police qualifier: ${JSON.stringify(q)}`);
    assert.equal(result.qualifier.clause, "i.circumstance = 'Felon Killed by Police'");
    assert.match(result.qualifier.caveat ?? "", /Washington Post|Mapping Police Violence/);
  }
}

// The predicate must match the exact stored value; 'Felon Killed by Police' has
// 18,697 rows in shr.db and every one is homicide_type='Murder', so the
// route's existing Murder filter stays valid.
assert.equal(POLICE_SHOOTING_QUALIFIER.clause, "i.circumstance = 'Felon Killed by Police'");
assert.match(POLICE_SHOOTING_QUALIFIER.titleLabel, /Police/);
assert.match(POLICE_SHOOTING_QUALIFIER.narrativeLabel, /police/);

// ------------------------------------------------------------- plain: proceed
// These are the questions the deterministic path answers correctly today and
// must keep answering — a regression here silently disables a working feature.
const PLAIN = [
  "fatal shootings by year",
  "how many fatal shootings in Chicago since 2015",
  "firearm homicides in Baltimore by month",
  "gun violence trend nationally",
  "shootings in New Orleans 2020",
];
for (const q of PLAIN) {
  assert.equal(classifyShootingQualifier(q).kind, "none", `must proceed unqualified: ${JSON.stringify(q)}`);
}

// ------------------------------------------------- unsupported: must decline
const UNSUPPORTED: [string, string][] = [
  ["domestic violence shootings since 2015", "domestic"],
  ["gang related fatal shootings by year", "gang"],
  ["juvenile shooting victims since 2010", "juvenile"],
  ["fatal shootings by strangers", "stranger"],
  ["justifiable homicide shootings by private citizen", "self-defense"],
  ["mass shooting deaths since 2000", "mass"],
  ["drug related shootings by year", "drug"],
];
for (const [q, expectedId] of UNSUPPORTED) {
  const result = classifyShootingQualifier(q);
  assert.equal(result.kind, "unsupported", `must decline: ${JSON.stringify(q)}`);
  if (result.kind === "unsupported") {
    assert.ok(result.ids.includes(expectedId), `expected id ${expectedId}, got ${JSON.stringify(result.ids)}`);
  }
}

// Police takes precedence: an officer-involved question is answerable even when
// it also mentions an otherwise-unsupported term.
const mixed = classifyShootingQualifier("were juveniles killed by police in 2023");
assert.equal(mixed.kind, "supported", "police support wins over an unsupported co-mention");

console.log("shooting qualifier tests passed");
