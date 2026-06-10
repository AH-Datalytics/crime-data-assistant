import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { answerMetadataQuestion } from "../lib/metadata-coverage";

function makeDb() {
  const db = new Database(":memory:");

  db.exec(`
    CREATE TABLE agencies (
      ori TEXT,
      agency TEXT,
      state TEXT,
      type TEXT,
      city TEXT,
      national_sample INTEGER
    );
    CREATE TABLE agency_monthly (
      year INTEGER
    );
    CREATE TABLE historical_state_national (
      state TEXT,
      year INTEGER
    );
    CREATE TABLE historical_agency_crime (
      year INTEGER
    );
    CREATE TABLE historical_agency (
      ori TEXT,
      agency TEXT,
      state TEXT,
      type TEXT
    );
    CREATE TABLE incidents (
      ori TEXT,
      agency TEXT,
      state TEXT,
      agency_type TEXT,
      year INTEGER
    );
    CREATE TABLE hate_crime_participation (
      state TEXT,
      year INTEGER,
      reporting_agencies INTEGER
    );
    CREATE TABLE hate_crime_incidents (
      ori TEXT,
      agency_name TEXT,
      state TEXT,
      year INTEGER
    );
  `);

  db.exec(`
    INSERT INTO agencies VALUES
      ('A1', 'Birmingham', 'AL', 'City', 'BIRMINGHAM', 1),
      ('L1', 'New Orleans', 'LA', 'City', 'NEW ORLEANS', 1),
      ('X1', 'Houston', 'TX', 'City', 'HOUSTON', 0),
      ('N1', 'Omaha', 'NB', 'City', 'OMAHA', NULL);
    INSERT INTO agency_monthly VALUES (2023), (2024), (2025);
    INSERT INTO historical_state_national VALUES
      ('Alabama', 1960),
      ('Alabama', 2024),
      ('United States', 1930),
      ('United States', 2024);
    INSERT INTO historical_agency_crime VALUES (1930), (2025);
    INSERT INTO historical_agency VALUES
      ('HA1', 'Birmingham', 'al', 'city'),
      ('HA2', 'Jefferson County', 'al', 'county');
    INSERT INTO incidents VALUES
      ('S1', 'Birmingham', 'AL', 'City', 1976),
      ('S1', 'Birmingham', 'AL', 'City', 2024),
      ('S2', 'New Orleans', 'LA', 'City', 2023);
    INSERT INTO hate_crime_participation VALUES
      ('AL', 1991, 12),
      ('LA', 2024, 45),
      ('TX', 2024, 0);
    INSERT INTO hate_crime_incidents VALUES
      ('H1', 'Birmingham Police Department', 'AL', 2024),
      ('H2', 'New Orleans Police Department', 'LA', 2024);
  `);

  return db;
}

const db = makeDb();

{
  const result = answerMetadataQuestion("current", "which states do you have data for?", db);
  assert(result);
  assert.deepEqual(result.rows.map((r) => r.state), ["AL", "LA"]);
  assert.match(result.explanation, /2 states\/DC represented/i);
}

{
  const result = answerMetadataQuestion("current", "how many states is that?", db);
  assert(result);
  assert.equal(result.rows[0].state_count, 2);
}

{
  const result = answerMetadataQuestion("current", "what states are not represented?", db);
  assert(result);
  assert(result.rows.some((r) => r.state === "AK"));
  assert(result.rows.some((r) => r.state === "TX"));
  assert(!result.rows.some((r) => r.state === "AL"));
  assert.match(result.explanation, /missing/i);
}

{
  const result = answerMetadataQuestion("current", "why can't you tell me which states are not represented?", db);
  assert(result);
  assert(result.rows.some((r) => r.state === "AK"));
}

{
  const result = answerMetadataQuestion("current", "which states aren't in the data?", db);
  assert(result);
  assert(result.rows.some((r) => r.state === "AK"));
  assert(result.rows.some((r) => r.state === "TX"));
}

{
  const result = answerMetadataQuestion("current", "which states are not included?", db);
  assert(result);
  assert(result.rows.some((r) => r.state === "AK"));
}

{
  const result = answerMetadataQuestion("nibrs", "which states are available?", db);
  assert(result);
  assert(result.rows.some((r) => r.state === "NE"));
}

{
  const result = answerMetadataQuestion("nibrs", "what states are missing?", db);
  assert(result);
  assert(!result.rows.some((r) => r.state === "NE"));
}

{
  const result = answerMetadataQuestion("historical", "what years are available?", db);
  assert(result);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], { source: "agency crime", first_year: 1930, latest_year: 2025 });
}

{
  const result = answerMetadataQuestion("shr", "what year range do you have?", db);
  assert(result);
  assert.deepEqual(result.rows[0], { source: "SHR incidents", first_year: 1976, latest_year: 2024 });
}

{
  const result = answerMetadataQuestion("hate_crime", "which states are represented?", db);
  assert(result);
  assert.deepEqual(result.rows.map((r) => r.state), ["AL", "LA"]);
}

{
  const result = answerMetadataQuestion("current", "show murder rates in new orleans", db);
  assert.equal(result, null);
}

{
  const result = answerMetadataQuestion("current", "can I download this?", null);
  assert(result);
  assert.equal(result.columns[0], "answer");
  assert.match(result.explanation, /Download CSV button/);
}

{
  const result = answerMetadataQuestion("current", "how many agencies are covered?", db);
  assert(result);
  assert.equal(result.rows[0].agency_count, 2);
}

{
  const result = answerMetadataQuestion("current", "which cities are represented?", db);
  assert(result);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows.map((r) => r.city), ["Birmingham", "New Orleans"]);
}

{
  const result = answerMetadataQuestion("historical", "how many cities do you have data for?", db);
  assert(result);
  assert.equal(result.rows[0].city_count, 1);
}

{
  const result = answerMetadataQuestion("hate_crime", "which agencies are represented?", db);
  assert(result);
  assert.deepEqual(result.rows.map((r) => r.agency), ["Birmingham Police Department", "New Orleans Police Department"]);
}

db.close();
console.log("metadata coverage tests passed");
