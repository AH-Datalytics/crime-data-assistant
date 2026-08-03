import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { findVerifiedCurrentAgency } from "../lib/current-agency-availability";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE agencies (ori TEXT, agency TEXT, state TEXT, type TEXT);
  CREATE TABLE agency_monthly (ori TEXT, year INT, month INT, offense TEXT, count INT);
  INSERT INTO agencies VALUES ('IA001', 'Iowa City', 'IA', 'City');
  INSERT INTO agency_monthly VALUES ('IA001', 2024, 1, 'Murder', 0);
`);

const verified = findVerifiedCurrentAgency("violent crime in Iowa City, Iowa", db);
assert.equal(verified?.agency, "Iowa City");
assert.equal(verified?.state, "IA");
assert.equal(verified?.dataRows, 1);
assert.equal(findVerifiedCurrentAgency("violent crime in Ames, Iowa", db), null);
db.close();
console.log("current agency availability tests passed");
