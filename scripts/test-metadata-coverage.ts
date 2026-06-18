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
    CREATE TABLE agency_county_crosswalk (
      ori TEXT PRIMARY KEY,
      ori9 TEXT,
      agency_name TEXT,
      state TEXT,
      county_fips TEXT,
      county_name TEXT,
      county_key TEXT
    );
  `);

  db.exec(`
    INSERT INTO agencies VALUES
      ('A1', 'Birmingham', 'AL', 'City', 'BIRMINGHAM', 1),
      ('L1', 'New Orleans', 'LA', 'City', 'NEW ORLEANS', 1),
      ('X1', 'Houston', 'TX', 'City', 'HOUSTON', 0),
      ('P1', 'Philadelphia', 'PA', 'City', 'PHILADELPHIA', 1),
      ('N1', 'Omaha', 'NB', 'City', 'OMAHA', NULL),
      ('IL0010000', 'Chicago', 'IL', 'City', 'CHICAGO', 1),
      ('GA0750000', 'Adel', 'GA', 'City', 'ADEL', 1),
      ('IN0494900', 'Indianapolis', 'IN', 'City', 'INDIANAPOLIS', 0),
      ('IN0490100', 'Beech Grove', 'IN', 'City', 'BEECH GROVE', 0),
      ('CA0431300', 'San Jose', 'CA', 'City', 'San Jose', 0),
      ('CA0431600', 'Sunnyvale', 'CA', 'City', 'Sunnyvale', 0);
    INSERT INTO agency_monthly VALUES (2023), (2024), (2025);
    INSERT INTO historical_state_national VALUES
      ('Alabama', 1960),
      ('Alabama', 2024),
      ('United States', 1930),
      ('United States', 2024);
    INSERT INTO historical_agency_crime VALUES (1930), (2025);
    INSERT INTO historical_agency VALUES
      ('HA1', 'Birmingham', 'al', 'city'),
      ('HPA1', 'Philadelphia', 'pa', 'city'),
      ('HA2', 'Jefferson County', 'al', 'county');
    INSERT INTO incidents VALUES
      ('S1', 'Birmingham', 'AL', 'City', 1976),
      ('S1', 'Birmingham', 'AL', 'City', 2024),
      ('SPA1', 'Philadelphia', 'PA', 'City', 2024),
      ('S2', 'New Orleans', 'LA', 'City', 2023);
    INSERT INTO hate_crime_participation VALUES
      ('AL', 1991, 12),
      ('LA', 2024, 45),
      ('TX', 2024, 0);
    INSERT INTO hate_crime_incidents VALUES
      ('H1', 'Birmingham Police Department', 'AL', 2024),
      ('H2', 'New Orleans Police Department', 'LA', 2024);
    INSERT INTO agency_county_crosswalk VALUES
      ('P1LEG', 'P1', 'Philadelphia', 'PA', '42101', 'Philadelphia', 'PHILADELPHIA'),
      ('CA04313', 'CA0431300', 'San Jose', 'CA', '06085', 'Santa Clara', 'SANTA CLARA'),
      ('CA04316', 'CA0431600', 'Sunnyvale', 'CA', '06085', 'Santa Clara', 'SANTA CLARA'),
      ('INIPD00', 'IN0494900', 'Indianapolis', 'IN', '18097', 'Marion', 'MARION'),
      ('IN04901', 'IN0490100', 'Beech Grove', 'IN', '18097', 'Marion', 'MARION'),
      ('IL00100', 'IL0010000', 'Chicago', 'IL', '17031', 'Cook', 'COOK'),
      ('GA07500', 'GA0750000', 'Adel', 'GA', '13075', 'Cook', 'COOK'),
      ('OR00101', 'OR0010100', 'Albany', 'OR', '41043', 'Linn', 'LINN'),
      ('IA00101', 'IA0010100', 'Algona', 'IA', '19109', 'Linn', 'LINN');
  `);

  return db;
}

const db = makeDb();

{
  const result = answerMetadataQuestion("current", "which states do you have data for?", db);
  assert(result);
  assert.deepEqual(result.rows.map((r) => r.state), ["AL", "GA", "IL", "LA", "PA"]);
  assert.match(result.explanation, /5 states\/DC represented/i);
}

{
  const result = answerMetadataQuestion("current", "how many states is that?", db);
  assert(result);
  assert.equal(result.rows[0].state_count, 5);
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
  const result = answerMetadataQuestion("historical", "How many homicides have there been in the City of Los Angeles so far this year?", db);
  assert.equal(result, null);
}

{
  const result = answerMetadataQuestion("nibrs", "How many agencies and population?", db);
  assert.equal(result, null);
}

{
  const result = answerMetadataQuestion("historical", "Using 2023 data, which cities in Louisiana had the highest violent crime rate", db);
  assert.equal(result, null);
}

{
  const result = answerMetadataQuestion("nibrs", "only include agencies that reported every year from 2018 through 2025", db);
  assert.equal(result, null);
}

{
  const result = answerMetadataQuestion("nibrs", "for continuously reporting agencies only, show me murders by year", db);
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
  assert.equal(result.rows[0].agency_count, 5);
}

{
  const result = answerMetadataQuestion("current", "which cities are represented?", db);
  assert(result);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows.map((r) => r.city), ["Birmingham", "Adel", "Chicago", "New Orleans", "Philadelphia"]);
}

{
  const result = answerMetadataQuestion("current", "which cities are represented in Pennsylvania?", db);
  assert(result);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows.map((r) => r.city), ["Philadelphia"]);
  assert.match(result.sql, /state = 'PA'/);
}

{
  const result = answerMetadataQuestion("historical", "which cities are represented in Pennsylvania?", db);
  assert(result);
  assert.deepEqual(result.rows.map((r) => r.city), ["Philadelphia"]);
  assert.match(result.sql, /UPPER\(state\) = 'PA'/);
}

{
  const result = answerMetadataQuestion("nibrs", "which cities are in Santa Clara County?", db);
  assert(result);
  assert.deepEqual(result.rows.map((r) => r.city), ["San Jose", "Sunnyvale"]);
  assert.match(result.sql, /agency_county_crosswalk/);
  assert.match(result.explanation, /Santa Clara County/);
}

{
  const result = answerMetadataQuestion("nibrs", "which cities are in Marion County Indiana?", db);
  assert(result);
  assert.deepEqual(result.rows.map((r) => r.city), ["BEECH GROVE", "INDIANAPOLIS"]);
  assert.match(result.sql, /a\.ori = x\.ori9/);
}

{
  const result = answerMetadataQuestion("current", "which agencies are in Cook County, Illinois?", db);
  assert(result);
  assert.deepEqual(result.rows.map((r) => r.agency), ["Chicago"]);
  assert.match(result.sql, /state = 'IL'/);
  assert.doesNotMatch(result.explanation, /matches multiple states/i);
}

{
  const result = answerMetadataQuestion("current", "which agencies are in Cook County IL?", db);
  assert(result);
  assert.deepEqual(result.rows.map((r) => r.agency), ["Chicago"]);
  assert.match(result.sql, /state = 'IL'/);
}

{
  const result = answerMetadataQuestion("current", "which agencies are in Cook County?", db);
  assert(result);
  assert.deepEqual(result.columns, ["answer"]);
  assert.match(result.explanation, /matches multiple states/i);
}

{
  const result = answerMetadataQuestion("current", "which agencies are in Linn County?", db);
  assert(result);
  assert.deepEqual(result.columns, ["answer"]);
  assert.match(result.explanation, /matches multiple states/i);
}

{
  const result = answerMetadataQuestion("historical", "how many cities do you have data for?", db);
  assert(result);
  assert.equal(result.rows[0].city_count, 2);
}

{
  const result = answerMetadataQuestion("hate_crime", "which agencies are represented?", db);
  assert(result);
  assert.deepEqual(result.rows.map((r) => r.agency), ["Birmingham Police Department", "New Orleans Police Department"]);
}

{
  const result = answerMetadataQuestion("shr", "fatal shooting data for Kansas City", db);
  assert.equal(result, null);
}

db.close();
console.log("metadata coverage tests passed");
