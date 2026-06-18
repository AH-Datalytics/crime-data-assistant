import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { resolveGeoPlaces, type GeoPlaceResolution } from "../lib/geo-place-resolver";
import { mapGeoCandidateToSources, type GeoSource, type GeoSourceMapStatus } from "../lib/geo-source-mapper";

type SourceExpectation = Partial<Record<GeoSource, GeoSourceMapStatus>>;

const rtci = new Database(":memory:");
const nibrs = new Database(":memory:");
const shr = new Database(":memory:");

const CROSSWALK_VALUES = `
    ('LAPD000', 'LAPD00000', 'Los Angeles Police Department', 'CA', '06037', 'Los Angeles County', 'LOS ANGELES', 'test'),
    ('LASD000', 'LASD00000', 'Los Angeles County Sheriff', 'CA', '06037', 'Los Angeles County', 'LOS ANGELES', 'test'),
    ('MDBALC0', 'MDBALC000', 'Baltimore Police Department', 'MD', '24510', 'Baltimore city', 'BALTIMORE', 'test'),
    ('MDBALCO', 'MDBALCO00', 'Baltimore County Police Department', 'MD', '24005', 'Baltimore County', 'BALTIMORE', 'test'),
    ('STLMPD0', 'STLMPD000', 'St. Louis Metropolitan Police Department', 'MO', '29510', 'St. Louis city', 'ST. LOUIS', 'test'),
    ('STLCOPD', 'STLCOPD00', 'St. Louis County Police Department', 'MO', '29189', 'St. Louis County', 'ST. LOUIS', 'test'),
    ('COOKGA0', 'COOKGA000', 'Cook County Sheriff', 'GA', '13075', 'Cook County', 'COOK', 'test'),
    ('COOKIL0', 'COOKIL000', 'Cook County Sheriff', 'IL', '17031', 'Cook County', 'COOK', 'test'),
    ('COOKMN0', 'COOKMN000', 'Cook County Sheriff', 'MN', '27031', 'Cook County', 'COOK', 'test')
`;

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
    ('DCPD000', 'Washington', 'DC', 'City'),
    ('ILCPD00', 'Chicago', 'IL', 'City'),
    ('KSCPD00', 'Kansas City', 'KS', 'City'),
    ('MOKCPD0', 'Kansas City', 'MO', 'City'),
    ('LAPD000', 'Los Angeles', 'CA', 'City'),
    ('MDBALC0', 'Baltimore city', 'MD', 'City'),
    ('NYNYPD0', 'New York City', 'NY', 'City'),
    ('STLMPD0', 'St. Louis city', 'MO', 'City');
  INSERT INTO agency_monthly
    SELECT ori, agency, state, type, 2026, 1, 'murder', 1 FROM agencies;

  INSERT INTO historical_agency VALUES
    ('DCPD000', 'Washington', 'DC', 'city'),
    ('ILCPD00', 'Chicago', 'IL', 'city'),
    ('KSCPD00', 'Kansas City', 'KS', 'city'),
    ('MOKCPD0', 'Kansas City', 'MO', 'city'),
    ('LAPD000', 'Los Angeles', 'CA', 'city'),
    ('MDBALC0', 'Baltimore city', 'MD', 'city'),
    ('MDBALC1', 'Baltimore', 'MD', 'city'),
    ('NYNYPD0', 'New York City', 'NY', 'city'),
    ('STLMPD0', 'St. Louis city', 'MO', 'city');

  INSERT INTO agency_county_crosswalk VALUES ${CROSSWALK_VALUES};
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
    ('DCPD00000', 2025, 'WASHINGTON', 'DC', 'City', 690000),
    ('ILCPD000', 2025, 'CHICAGO', 'IL', 'City', 2700000),
    ('KSCPD000', 2025, 'KANSAS CITY', 'KS', 'City', 150000),
    ('MOKCPD000', 2025, 'KANSAS CITY', 'MO', 'City', 510000),
    ('LAPD00000', 2025, 'LOS ANGELES', 'CA', 'City', 3800000),
    ('MDBALC000', 2025, 'BALTIMORE CITY', 'MD', 'City', 560000),
    ('NYNYPD000', 2025, 'NEW YORK CITY', 'NY', 'City', 8300000),
    ('STLMPD000', 2025, 'ST. LOUIS CITY', 'MO', 'City', 280000);
  INSERT INTO agency_county_crosswalk VALUES ${CROSSWALK_VALUES};
`);

shr.exec(`
  CREATE TABLE incidents (ori TEXT, state TEXT, agency TEXT, year INTEGER);
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
  INSERT INTO incidents VALUES
    ('DCPD000', 'DC', 'Washington', 2025),
    ('ILCPD00', 'IL', 'Chicago', 2025),
    ('KSCPD00', 'KS', 'Kansas City', 2025),
    ('MOKCPD0', 'MO', 'Kansas City', 2025),
    ('LAPD000', 'CA', 'Los Angeles', 2025),
    ('MDBALC0', 'MD', 'Baltimore city', 2025),
    ('NYNYPD0', 'NY', 'New York City', 2025),
    ('STLMPD0', 'MO', 'St. Louis city', 2025);
  INSERT INTO shr_agency_alias VALUES
    ('Washington', 'WASHINGTON', 'DCPD000', 'DC', 'Washington', 'City', 'test'),
    ('Chicago', 'CHICAGO', 'ILCPD00', 'IL', 'Chicago', 'City', 'test'),
    ('Kansas City', 'KANSAS CITY', 'KSCPD00', 'KS', 'Kansas City', 'City', 'test'),
    ('Kansas City', 'KANSAS CITY', 'MOKCPD0', 'MO', 'Kansas City', 'City', 'test'),
    ('Los Angeles', 'LOS ANGELES', 'LAPD000', 'CA', 'Los Angeles', 'City', 'test'),
    ('Baltimore city', 'BALTIMORE', 'MDBALC0', 'MD', 'Baltimore city', 'City', 'test'),
    ('New York City', 'NEW YORK CITY', 'NYNYPD0', 'NY', 'New York City', 'City', 'test'),
    ('New York', 'NEW YORK', 'NYNYPD0', 'NY', 'New York City', 'City', 'test'),
    ('St. Louis city', 'ST LOUIS', 'STLMPD0', 'MO', 'St. Louis city', 'City', 'test');
  INSERT INTO agency_county_crosswalk VALUES ${CROSSWALK_VALUES};
`);

function ids(result: GeoPlaceResolution): string[] {
  return result.mentions.flatMap((mention) => mention.candidates.map((candidate) => candidate.id)).sort();
}

function assertResolve(input: string, expectedIds: string[], clarifies: boolean): void {
  const result = resolveGeoPlaces(input);
  assert.deepEqual(ids(result), expectedIds.sort(), input);
  assert.equal(result.requiresClarification, clarifies, `${input} clarification`);
}

function assertSourceStatuses(input: string, id: string, expected: SourceExpectation): void {
  const result = resolveGeoPlaces(input);
  const candidate = result.mentions.flatMap((mention) => mention.candidates).find((item) => item.id === id);
  assert.ok(candidate, `${input} should include ${id}`);
  const mappings = mapGeoCandidateToSources(candidate, { currentHistorical: rtci, nibrs, shr });
  for (const [source, status] of Object.entries(expected) as [GeoSource, GeoSourceMapStatus][]) {
    assert.equal(mappings.find((mapping) => mapping.source === source)?.status, status, `${input} ${source}`);
  }
}

assertResolve("fatal shooting data for Kansas City", ["city:KS:kansas-city", "city:MO:kansas-city"], true);
assertResolve("fatal shooting data for KCMO", ["city:MO:kansas-city"], false);
assertResolve("fatal shooting data for KCK", ["city:KS:kansas-city"], false);
assertSourceStatuses("fatal shooting data for KCMO", "city:MO:kansas-city", {
  current: "safe_exact",
  historical: "safe_exact",
  nibrs: "safe_exact",
  shr: "safe_exact",
});

assertResolve("baltimore per capita murder trend", ["city:MD:baltimore-city", "county:MD:baltimore"], true);
assertResolve("baltimore city per capita murder trend", ["city:MD:baltimore-city"], false);
assertResolve("baltimore county murder trend", ["county:MD:baltimore"], false);
assertSourceStatuses("baltimore county murder trend", "county:MD:baltimore", {
  current: "safe_exact",
  historical: "safe_exact",
  nibrs: "safe_exact",
  shr: "safe_exact",
});

assertResolve("gun violence in New York", ["city:NY:new-york-city", "state:NY"], true);
assertResolve("gun violence in New York State", ["state:NY"], false);
assertResolve("gun violence in NYC", ["city:NY:new-york-city"], false);
assertSourceStatuses("gun violence in New York State", "state:NY", {
  current: "safe_exact",
  historical: "safe_exact",
  nibrs: "safe_exact",
  shr: "safe_exact",
});

assertResolve("murder rate in Washington since 2010", ["city:DC:washington", "state:WA"], true);
assertResolve("murder rate in Washington DC since 2010", ["city:DC:washington"], false);
assertResolve("murder rate in Washington State since 2010", ["state:WA"], false);

assertResolve("robbery clearance in Los Angeles", ["city:CA:los-angeles", "county:CA:los-angeles"], true);
assertResolve("robbery clearance in Los Angeles County, California", ["county:CA:los-angeles"], false);
assertSourceStatuses("robbery clearance in Los Angeles County, California", "county:CA:los-angeles", {
  current: "safe_exact",
  historical: "safe_exact",
  nibrs: "safe_exact",
  shr: "safe_exact",
});

assertResolve("St Louis murders per year", ["city:MO:st-louis-city", "county:MO:st-louis"], true);
assertResolve("St Louis County murders per year", ["county:MN:st-louis", "county:MO:st-louis"], true);
assertResolve("St Louis County, Missouri murders per year", ["county:MO:st-louis"], false);

assertResolve("gun violence in Cook County since 2015", [
  "county:GA:cook",
  "county:IL:cook",
  "county:MN:cook",
], true);
assertResolve("gun violence in Cook County, Illinois since 2015", ["county:IL:cook"], false);
assertSourceStatuses("gun violence in Cook County, Illinois since 2015", "county:IL:cook", {
  current: "safe_exact",
  historical: "safe_exact",
  nibrs: "safe_exact",
  shr: "safe_exact",
});

// Known Phase 2 gaps from the production report:
// - "Kings County, NY" currently still carries the California candidate.
// - "Miami-Dade County" currently tokenizes as Miami city plus Dade County candidates.
// Keep these out of the hard canary set until state-qualified county disambiguation is wired.

rtci.close();
nibrs.close();
shr.close();

console.log("geo source canaries passed");
