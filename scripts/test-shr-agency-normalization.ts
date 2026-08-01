import assert from "node:assert/strict";
import {
  agencySearchKey,
  buildShrAgencyAliases,
  buildShrAgencyIdentity,
  canonicalizeShrAgencyName,
  displayShrAgencyName,
  inferShrAgencyType,
  normalizeShrAgencyText,
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

{
  assert.equal(displayShrAgencyName("Washington, DC"), "Washington, DC");
  assert.equal(displayShrAgencyName("New York City, NY"), "New York City, NY");
  assert.equal(displayShrAgencyName("METROPOLITAN NASHVILLE P"), "Nashville");
  assert.equal(displayShrAgencyName("METROPOLITAN NASHVILLE POLICE DEPARTMENT"), "Nashville");
  assert.equal(displayShrAgencyName("CHARLOTTE-MECKLENBURG POLICE DEPARTMENT"), "Charlotte");
  assert.equal(displayShrAgencyName("Saint Louis Metropolitan Police Department"), "St. Louis");
  assert.equal(displayShrAgencyName("ST. LOUIS COUNTY POLICE DEPARTMENT"), "St. Louis County");
  assert.equal(displayShrAgencyName("LAS VEGAS METROPOLITAN POLICE DEPARTMENT"), "Las Vegas");
  assert.equal(displayShrAgencyName("LOUISVILLE METRO POLICE DEPARTMENT"), "Louisville");
  assert.equal(
    normalizeShrAgencyText("Fatal shootings for METROPOLITAN NASHVILLE P and CHARLOTTE-MECKLENBURG by year."),
    "Fatal shootings for Nashville and Charlotte by year."
  );
  assert.equal(normalizeShrAgencyText("Murders in Saint Louis by year."), "Murders in St. Louis by year.");
}

console.log("SHR agency normalization tests passed");
