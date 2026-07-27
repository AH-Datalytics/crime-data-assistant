import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { resolveShrAgency } from "../lib/shr-place-resolver";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE shr_agency_alias (
    alias TEXT, alias_key TEXT, ori TEXT, state TEXT,
    canonical_agency TEXT, agency_type TEXT, source TEXT
  );
  CREATE TABLE shr_agency_identity (
    ori TEXT, state TEXT, canonical_agency TEXT, agency_type TEXT,
    search_key TEXT, source_agency_names TEXT, source_agency_types TEXT,
    nibrs_city TEXT, nibrs_agency_type TEXT, incident_count INTEGER,
    first_year INTEGER, last_year INTEGER, PRIMARY KEY (ori, state)
  );
  INSERT INTO shr_agency_alias VALUES
    ('Houston', 'HOUSTON', 'TXHOUSTON', 'TX', 'Houston', 'City', 'test'),
    ('Houston Police Department', 'HOUSTON POLICE DEPARTMENT', 'TXHOUSTON', 'TX', 'Houston', 'City', 'test'),
    ('Houston Police Department', 'HOUSTON', 'TXHOUSTON', 'TX', 'Houston', 'City', 'test'),
    ('Amarillo', 'AMARILLO', 'TXAMARILLO', 'TX', 'Amarillo', 'City', 'test');
    
  INSERT INTO shr_agency_identity VALUES
    ('TXHOUSTON', 'TX', 'Houston', 'City', 'HOUSTON', 'Houston', 'City', NULL, NULL, 10, 1990, 2025),
    ('TXAMARILLO', 'TX', 'Amarillo', 'City', 'AMARILLO', 'Amarillo', 'City', NULL, NULL, 5, 2020, 2026);
  INSERT INTO shr_agency_alias VALUES
    ('Metro', 'METRO', 'TXMETRO1', 'TX', 'Metro One', 'Other', 'test'),
    ('Metro', 'METRO', 'TXMETRO2', 'TX', 'Metro Two', 'Other', 'test'),
    ('Legacy', 'LEGACY', 'TXLEGACY1', 'TX', 'Legacy', 'City', 'test'),
    ('Legacy', 'LEGACY', 'TXLEGACY2', 'TX', 'Legacy', 'City', 'test');
  INSERT INTO shr_agency_identity VALUES
    ('TXMETRO1', 'TX', 'Metro One', 'Other', 'METRO ONE', 'Metro One', 'Other', NULL, NULL, 2, 2000, 2020),
    ('TXMETRO2', 'TX', 'Metro Two', 'Other', 'METRO TWO', 'Metro Two', 'Other', NULL, NULL, 2, 2000, 2020),
    ('TXLEGACY1', 'TX', 'Legacy', 'City', 'LEGACY', 'Legacy', 'City', NULL, NULL, 2, 2000, 2015),
    ('TXLEGACY2', 'TX', 'Legacy', 'City', 'LEGACY', 'Legacy', 'City', NULL, NULL, 2, 2010, 2020);
`);

const houston = resolveShrAgency(db, "Houston Police Department", "TX", { startYear: 2010, endYear: 2020 });
assert.equal(houston.status, "resolved");
assert.deepEqual(houston.oris, ["TXHOUSTON"]);
assert.deepEqual(houston.ranges, [{ ori: "TXHOUSTON", startYear: 2010, endYear: 2020 }]);

const outside = resolveShrAgency(db, "Houston", "TX", { startYear: 2026, endYear: 2026 });
assert.equal(outside.status, "not_in_source");

const missing = resolveShrAgency(db, "Amarillo", "TX", { startYear: 2019, endYear: 2021 });
assert.equal(missing.status, "resolved");
assert.equal(missing.ranges[0].startYear, 2020);

const absent = resolveShrAgency(db, "Austin", "TX");
assert.equal(absent.status, "not_in_source");

const ambiguousAgency = resolveShrAgency(db, "Metro", "TX", { kind: "agency" });
assert.equal(ambiguousAgency.status, "ambiguous");

const overlapping = resolveShrAgency(db, "Legacy", "TX", { startYear: 2010, endYear: 2015 });
assert.equal(overlapping.status, "ambiguous");

db.close();
console.log("SHR place resolver tests passed");
