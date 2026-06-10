import assert from "node:assert/strict";
import {
  agencySearchKey,
  buildShrAgencyAliases,
  buildShrAgencyIdentity,
  canonicalizeShrAgencyName,
  inferShrAgencyType,
} from "../lib/shr-agency-normalization";

{
  assert.equal(canonicalizeShrAgencyName("ST. LOUIS COUNTY POL DEP"), "St. Louis County Police Department");
  assert.equal(agencySearchKey("St. Louis County Police Department"), "ST LOUIS COUNTY POLICE DEPARTMENT");
}

{
  const aliases = buildShrAgencyAliases("St. Louis County Police Department", ["ST. LOUIS COUNTY POL DEP"]);
  assert(aliases.includes("St. Louis County Police Department"));
  assert(aliases.includes("St. Louis County"));
  assert(aliases.includes("Saint Louis County"));
}

{
  assert.equal(inferShrAgencyType("St. Louis County Police Department", [""]), "County");
  assert.equal(inferShrAgencyType("Houston", [""], "City"), "City");
  assert.equal(inferShrAgencyType("State Police", [""]), "Other");
}

{
  const identity = buildShrAgencyIdentity({
    ori: "MO0950000",
    state: "MO",
    sourceNames: ["ST. LOUIS COUNTY POL DEP", "St. Louis County"],
    sourceTypes: ["", "County"],
    incidentCount: 10,
    firstYear: 2020,
    lastYear: 2026,
  });
  assert.equal(identity.canonicalAgency, "St. Louis County Police Department");
  assert.equal(identity.agencyType, "County");
  assert(identity.aliases.includes("St. Louis County"));
}

console.log("SHR agency normalization tests passed");
