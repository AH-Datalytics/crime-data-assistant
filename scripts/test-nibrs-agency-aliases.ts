// Tests for lib/nibrs-agency-aliases.ts and its use by the NIBRS place resolver.
//
// The registry exists so a NIBRS-only correction does not have to be expressed as
// a consolidation entry, because ConsolidatedAgency requires Historical fields
// that many Historical code paths dereference without checking. These tests hold
// that separation: NIBRS resolves the right agency, and Historical is untouched.
//
// Run: npx tsx scripts/test-nibrs-agency-aliases.ts
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { findNibrsAgencyAlias, NIBRS_AGENCY_ALIASES } from "../lib/nibrs-agency-aliases";
import { resolveNibrsPlaces } from "../lib/nibrs-place-resolver";
import {
  CONSOLIDATION_EXCLUSIONS,
  consolidatedDisplayName,
  findConsolidatedAgency,
  historicalAgencyTarget,
} from "../lib/agency-consolidations";

// --- the registry itself ---
assert.equal(findNibrsAgencyAlias("FL", "Jacksonville")?.nibrsOri, "FL0160000");
assert.equal(findNibrsAgencyAlias("fl", "  jacksonville  ")?.nibrsOri, "FL0160000", "lookup is case- and space-insensitive");
assert.equal(findNibrsAgencyAlias("GA", "Jacksonville"), undefined, "aliases are state-scoped");
assert.equal(findNibrsAgencyAlias("FL", "Miami"), undefined);
assert.equal(findNibrsAgencyAlias(null, "Jacksonville"), undefined);

for (const entry of NIBRS_AGENCY_ALIASES) {
  assert.match(entry.nibrsOri, /^[A-Z]{2}[0-9A-Z]{7}$/, `${entry.city}: ORI must be 9 characters`);
  assert.ok(entry.note.length > 80, `${entry.city}: every row needs its evidence trail`);
}

// --- NIBRS resolves the Sheriff's Office ---
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT, covered_flag TEXT, agency_indicator TEXT);
  CREATE INDEX idx_agencies_state_city_year ON agencies(state, city, year);
  INSERT INTO agencies VALUES
    ('FL0160000', 2025, 'FL', 'JACKSONVILLE', 'County', 1008920, '1B', 'N', 'E'),
    ('FL0162500', 2025, 'FL', 'JACKSONVILLE', 'City', 1382, '7', 'N', 'E'),
    ('ILCPD0000', 2025, 'IL', 'CHICAGO', 'City', 2660000, '1A', 'N', 'E');
`);

{
  const plan = resolveNibrsPlaces(db, "murder clearances in Jacksonville, FL in 2025");
  assert.ok(plan);
  const place = plan.places[0];
  assert.equal(place.status, "resolved");
  assert.equal(place.oriYears[0].ori, "FL0160000", "JSO, not the 1,382-population namesake");
  // The displayed place must still read as the user's own words
  assert.equal(place.label, "Jacksonville, FL");
}

{
  // A city with no alias is unaffected by the new branch
  const plan = resolveNibrsPlaces(db, "murder clearances in Chicago, IL in 2025");
  assert.equal(plan?.places[0].oriYears[0].ori, "ILCPD0000");
}

{
  // Multi-city: Jacksonville is no longer silently missing from the answer
  const plan = resolveNibrsPlaces(db, "murder clearances in Chicago, IL and Jacksonville, FL in 2025");
  assert.ok(plan);
  const resolved = plan.places.filter((p) => p.status === "resolved");
  assert.equal(resolved.length, 2, "both cities resolve");
  const oris = resolved.map((p) => p.oriYears[0]?.ori).sort();
  assert.deepEqual(oris, ["FL0160000", "ILCPD0000"]);
}

{
  // Outside the alias ORI's reporting years the resolver says so rather than
  // silently falling back to the wrong small agency
  const plan = resolveNibrsPlaces(db, "murder clearances in Jacksonville, FL in 1998");
  assert.equal(plan?.places[0].status, "covered");
  assert.equal(plan?.places[0].oriYears.length, 0);
}

db.close();

// --- Historical is untouched ---
assert.equal(findConsolidatedAgency("FL", "Jacksonville"), undefined, "no consolidation entry was added");
assert.ok(
  CONSOLIDATION_EXCLUSIONS.includes("Jacksonville, FL" as never),
  "Jacksonville stays excluded from the consolidation registry"
);
assert.deepEqual(
  historicalAgencyTarget("FL", "Jacksonville"),
  { agency: "Jacksonville", type: "city" },
  "Historical still queries its own agency name and type, with no ORI pin"
);
assert.equal(consolidatedDisplayName("FL", "Jacksonville"), "Jacksonville");

console.log("nibrs agency alias tests passed");
