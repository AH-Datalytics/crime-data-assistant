import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { answerMetadataQuestion } from "../lib/metadata-coverage";

function makeDb() {
  const db = new Database(":memory:");

  db.exec(`
    CREATE TABLE agencies (
      ori TEXT,
      state TEXT,
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
    CREATE TABLE incidents (
      state TEXT,
      year INTEGER
    );
    CREATE TABLE hate_crime_participation (
      state TEXT,
      year INTEGER,
      reporting_agencies INTEGER
    );
  `);

  db.exec(`
    INSERT INTO agencies VALUES
      ('A1', 'AL', 1),
      ('L1', 'LA', 1),
      ('X1', 'TX', 0),
      ('N1', 'NB', NULL);
    INSERT INTO agency_monthly VALUES (2023), (2024), (2025);
    INSERT INTO historical_state_national VALUES
      ('Alabama', 1960),
      ('Alabama', 2024),
      ('United States', 1930),
      ('United States', 2024);
    INSERT INTO historical_agency_crime VALUES (1930), (2025);
    INSERT INTO incidents VALUES ('AL', 1976), ('AL', 2024), ('LA', 2023);
    INSERT INTO hate_crime_participation VALUES
      ('AL', 1991, 12),
      ('LA', 2024, 45),
      ('TX', 2024, 0);
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

db.close();
console.log("metadata coverage tests passed");
