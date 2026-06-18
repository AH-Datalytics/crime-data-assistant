import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { resolveGeoPlaces } from "../lib/geo-place-resolver";
import { mapGeoCandidateToSources } from "../lib/geo-source-mapper";

const rtci = new Database(":memory:");
const nibrs = new Database(":memory:");
const shr = new Database(":memory:");

rtci.exec(`
  CREATE TABLE agencies (ori TEXT, agency TEXT, state TEXT, type TEXT);
  CREATE TABLE agency_monthly (ori TEXT, agency TEXT, state TEXT, type TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER);
  CREATE TABLE historical_agency (ori TEXT, agency TEXT, state TEXT, type TEXT);
  CREATE TABLE agency_county_crosswalk (
    ori TEXT,
    ori9 TEXT,
    agency_name TEXT,
    state TEXT,
    county_fips TEXT,
    county_name TEXT,
    county_key TEXT,
    source TEXT
  );

  INSERT INTO agencies VALUES
    ('TXHPD00', 'Houston', 'TX', 'City'),
    ('NCCMPD0', 'Charlotte', 'NC', 'City'),
    ('MOKCPD0', 'Kansas City', 'MO', 'City'),
    ('KSKCPD0', 'Kansas City', 'KS', 'City');
  INSERT INTO agency_monthly VALUES ('TXHPD00', 'Houston', 'TX', 'City', 2026, 1, 'murder', 1);

  INSERT INTO historical_agency VALUES
    ('TXHPD00', 'Houston', 'TX', 'city'),
    ('NCCMPD0', 'Charlotte-Mecklenburg', 'NC', 'city'),
    ('MOKCPD0', 'Kansas City', 'MO', 'city'),
    ('KSKCPD0', 'Kansas City', 'KS', 'city');

  INSERT INTO agency_county_crosswalk VALUES
    ('NCCMPD0', 'NCCMPD000', 'Charlotte-Mecklenburg Police Department', 'NC', '37119', 'Mecklenburg County', 'MECKLENBURG', 'test'),
    ('NCSHERF', 'NCSHERF00', 'Mecklenburg County Sheriff', 'NC', '37119', 'Mecklenburg County', 'MECKLENBURG', 'test');
`);

nibrs.exec(`
  CREATE TABLE agencies (ori TEXT, year INTEGER, city TEXT, state TEXT, agency_type TEXT, population INTEGER);
  CREATE TABLE agency_county_crosswalk (
    ori TEXT,
    ori9 TEXT,
    agency_name TEXT,
    state TEXT,
    county_fips TEXT,
    county_name TEXT,
    county_key TEXT,
    source TEXT
  );
  INSERT INTO agencies VALUES
    ('TXHPD0000', 2025, 'HOUSTON', 'TX', 'City', 2300000),
    ('NCCMPD000', 2025, 'CHARLOTTE', 'NC', 'City', 900000);
  INSERT INTO agency_county_crosswalk VALUES
    ('NCCMPD0', 'NCCMPD000', 'Charlotte-Mecklenburg Police Department', 'NC', '37119', 'Mecklenburg County', 'MECKLENBURG', 'test');
`);

shr.exec(`
  CREATE TABLE shr_agency_alias (
    alias TEXT,
    alias_key TEXT,
    ori TEXT,
    state TEXT,
    canonical_agency TEXT,
    agency_type TEXT,
    source TEXT
  );
  CREATE TABLE agency_county_crosswalk (
    ori TEXT,
    ori9 TEXT,
    agency_name TEXT,
    state TEXT,
    county_fips TEXT,
    county_name TEXT,
    county_key TEXT,
    source TEXT
  );
  INSERT INTO shr_agency_alias VALUES
    ('Houston', 'HOUSTON', 'TXHPD00', 'TX', 'Houston', 'City', 'test'),
    ('Charlotte-Mecklenburg', 'CHARLOTTE', 'NCCMPD0', 'NC', 'Charlotte-Mecklenburg', 'City', 'test');
  INSERT INTO agency_county_crosswalk VALUES
    ('NCCMPD0', 'NCCMPD000', 'Charlotte-Mecklenburg Police Department', 'NC', '37119', 'Mecklenburg County', 'MECKLENBURG', 'test');
`);

function candidate(input: string, id: string) {
  const result = resolveGeoPlaces(input);
  const found = result.mentions.flatMap((mention) => mention.candidates).find((item) => item.id === id);
  assert.ok(found, `${input} should resolve ${id}`);
  return found;
}

function mapping(input: string, id: string) {
  return mapGeoCandidateToSources(candidate(input, id), { currentHistorical: rtci, nibrs, shr });
}

let maps = mapping("violent crime in Houston", "city:TX:houston");
assert.equal(maps.find((m) => m.source === "current")?.status, "safe_exact");
assert.equal(maps.find((m) => m.source === "historical")?.status, "safe_exact");
assert.equal(maps.find((m) => m.source === "nibrs")?.status, "safe_exact");
assert.equal(maps.find((m) => m.source === "shr")?.status, "safe_exact");

maps = mapping("violent crime in Charlotte", "city:NC:charlotte");
assert.equal(maps.find((m) => m.source === "historical")?.status, "safe_exact");
assert.equal(maps.find((m) => m.source === "historical")?.matches[0]?.agency, "Charlotte-Mecklenburg");

const kc = resolveGeoPlaces("fatal shootings in Kansas City");
assert.equal(kc.requiresClarification, true);
const kcCandidates = kc.mentions[0].candidates.map((item) => item.id).sort();
assert.deepEqual(kcCandidates, ["city:KS:kansas-city", "city:MO:kansas-city"]);
for (const item of kc.mentions[0].candidates) {
  const itemMaps = mapGeoCandidateToSources(item, { currentHistorical: rtci, nibrs, shr });
  assert.ok(["safe_exact", "unsupported"].includes(itemMaps.find((m) => m.source === "current")?.status || ""));
}

maps = mapping("violent crime in Mecklenburg County, North Carolina", "county:NC:mecklenburg");
for (const source of ["current", "historical", "nibrs", "shr"] as const) {
  assert.equal(maps.find((m) => m.source === source)?.status, "safe_exact", `${source} should map Mecklenburg through crosswalk`);
  assert.ok((maps.find((m) => m.source === source)?.matches.length || 0) > 0);
}

const missingDbMaps = mapGeoCandidateToSources(candidate("violent crime in Houston", "city:TX:houston"), {});
assert.equal(missingDbMaps.find((m) => m.source === "nibrs")?.status, "unknown");
assert.equal(missingDbMaps.find((m) => m.source === "shr")?.status, "unknown");

rtci.close();
nibrs.close();
shr.close();

console.log("geo source mapper tests passed");
