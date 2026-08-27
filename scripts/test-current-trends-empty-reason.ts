/**
 * Why a Current Trends request came back with no value.
 *
 * The empty-result path used to collapse five materially different situations into one
 * sentence. The distinctions below are the whole point of the helper: a place we do not
 * carry, a month nobody has yet, a place that filed nothing for a month, a place that
 * filed that month but supplied no figure for the offense asked about, and the case where
 * none of that can be established. The last one must never be dressed up as one of the
 * first four, and none of the first four may be stated unless the database can show it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { explainEmptyCurrentTrendsResult } from "../lib/current-trends-empty-reason";
import { detectAllNullData } from "../lib/all-null-detection";

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

const digest = createHash("sha256").update("fixture source").digest("hex");

function buildDb(options: { receipts?: boolean; drift?: boolean } = {}): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agencies (ori TEXT, agency TEXT, state TEXT, type TEXT);
    CREATE TABLE sample_agencies (ori TEXT, agency TEXT, state TEXT, type TEXT);
    CREATE TABLE national_monthly (year INTEGER, month INTEGER, offense TEXT, count INTEGER);
    CREATE TABLE state_monthly (state TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER);
    CREATE TABLE agency_monthly (
      ori TEXT, agency TEXT, state TEXT, type TEXT,
      year INTEGER, month INTEGER, offense TEXT, count INTEGER
    );
    INSERT INTO agencies VALUES
      ('MI8234900', 'Detroit', 'MI', 'City'),
      ('AL0010200', 'Birmingham', 'AL', 'City'),
      ('IL0810000', 'Springfield', 'IL', 'City'),
      ('MO0770000', 'Springfield', 'MO', 'City'),
      -- Pontiac's original ORI. Its replacement below is deliberately absent from
      -- this directory, mirroring the live database.
      ('MI631900X', 'Pontiac', 'MI', 'City');
    INSERT INTO sample_agencies VALUES ('MI8234900', 'Detroit', 'MI', 'City');
    INSERT INTO national_monthly VALUES (2026, 5, 'Murder', 900);
    INSERT INTO agency_monthly VALUES
      ('MI8234900', 'Detroit', 'MI', 'City', 2025, 1, 'Murder', 5),
      ('MI8234900', 'Detroit', 'MI', 'City', 2026, 5, 'Murder', 0),
      ('MI8234900', 'Detroit', 'MI', 'City', 2026, 5, 'Robbery', 12),
      ('AL0010200', 'Birmingham', 'AL', 'City', 2026, 4, 'Murder', 1),
      ('AL0010200', 'Birmingham', 'AL', 'City', 2026, 5, 'Murder', 3),
      -- Pontiac filed under its old ORI through April and its new one in May.
      ('MI631900X', 'Pontiac', 'MI', 'City', 2026, 4, 'Murder', 2),
      ('MI6367300', 'Pontiac', 'MI', 'City', 2026, 5, 'Murder', 1);
    CREATE TABLE source_build_receipts (
      component TEXT PRIMARY KEY, source_version TEXT, source_sha256 TEXT,
      source_rows INTEGER, expected_rows INTEGER, actual_rows INTEGER, excluded_rows INTEGER,
      table_counts_json TEXT, status TEXT
    );
  `);
  if (options.receipts !== false) {
    // Counted from the fixture rather than written by hand, so adding a row to the
    // fixture cannot silently turn every case into "the records do not reconcile".
    const counts = Object.fromEntries(
      ["agency_monthly", "agencies", "sample_agencies", "national_monthly", "state_monthly"].map((table) => [
        table,
        Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n),
      ]),
    );
    db.prepare("INSERT INTO source_build_receipts VALUES (?,?,?,?,?,?,?,?,?)").run(
      "current_trends_monthly", "2026-05", digest,
      counts.agency_monthly, counts.agency_monthly, counts.agency_monthly, 0,
      JSON.stringify(counts), "complete",
    );
  }
  if (options.drift) {
    db.exec("INSERT INTO agency_monthly VALUES ('AL0010200','Birmingham','AL','City',2026,3,'Murder',2)");
  }
  return db;
}

const db = buildDb();

const BANNED = /\b(dataset|source absence|readiness|receipt|capability|policy|verified|unverified)\b/i;

console.log("\nthe five situations are told apart");

check("a place we do not carry is named as such", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Nowhereville' AND state = 'MI' AND year = 2026 AND month = 5 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "place_not_covered");
  assert.equal(result.establishedFromData, true);
  assert.match(result.message, /does not include/i);
  assert.match(result.message, /Nowhereville/);
});

check("a state with no agencies is a place we do not carry", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE state = 'WY' AND year = 2026 AND month = 5 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "place_not_covered");
  assert.match(result.message, /WY/);
});

check("a month before anything we hold is reported as unavailable, with the span we do hold", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' AND year = 2016 AND month = 5 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "period_not_covered");
  assert.equal(result.establishedFromData, true);
  assert.match(result.message, /May 2016 is not available in Current Trends/i);
  assert.match(result.message, /January 2025 through May 2026/);
});

check("a month after anything we hold is reported as unavailable", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' AND year = 2026 AND month = 6 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "period_not_covered");
  assert.match(result.message, /June 2026 is not available in Current Trends/i);
});

check("a whole year we do not hold is reported as unavailable", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' AND year = 2020 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "period_not_covered");
  assert.match(result.message, /2020 is not available in Current Trends/i);
});

check("a carried place that filed nothing for a month we do hold is a missing report", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' AND year = 2026 AND month = 4 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "no_report_for_period");
  assert.equal(result.establishedFromData, true);
  assert.match(result.message, /Detroit, MI/);
  assert.match(result.message, /April 2026/);
  assert.match(result.message, /not the same as/i);
});

check("a filed month missing only the offense asked about says so, and does not say zero", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' AND year = 2026 AND month = 5 AND offense = 'Rape'",
  );
  assert.equal(result.reason, "offense_not_reported");
  assert.equal(result.establishedFromData, true);
  assert.match(result.message, /no rape value/i);
  assert.match(result.message, /Detroit, MI/);
  assert.match(result.message, /May 2026/);
  assert.match(result.message, /not the same as/i);
  assert.doesNotMatch(result.message, /\breported 0\b/);
});

console.log("\nnothing is claimed that cannot be shown");

check("an explicit reported zero is a value, not an empty result", () => {
  const row = db
    .prepare(
      "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' AND year = 2026 AND month = 5 AND offense = 'Murder'",
    )
    .get() as { count: number } | undefined;
  assert.equal(row?.count, 0, "the fixture's explicit zero must come back as a row");
  assert.equal(detectAllNullData(["year", "count"], [{ year: 2026, count: 0 }]).allNull, false);
});

check("missing build evidence cannot be turned into a statement about the data", () => {
  const bare = buildDb({ receipts: false });
  const result = explainEmptyCurrentTrendsResult(
    bare,
    "SELECT count FROM agency_monthly WHERE agency = 'Nowhereville' AND state = 'MI' AND year = 2026 AND month = 5 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "cannot_determine");
  assert.equal(result.establishedFromData, false);
  bare.close();
});

check("build evidence that no longer matches the tables cannot be turned into a statement", () => {
  const drifted = buildDb({ drift: true });
  const result = explainEmptyCurrentTrendsResult(
    drifted,
    "SELECT count FROM agency_monthly WHERE agency = 'Nowhereville' AND state = 'MI' AND year = 2026 AND month = 5 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "cannot_determine");
  drifted.close();
});

check("query shapes the helper cannot read safely fall back to not knowing", () => {
  const unreadable = [
    "SELECT SUM(am.count) FROM agency_monthly am JOIN agency_population p ON p.ori = am.ori WHERE am.agency = 'Detroit'",
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND year BETWEEN 2025 AND 2026",
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND year >= 2025 AND offense = 'Murder'",
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND offense IN ('Murder','Rape')",
    "SELECT count FROM agency_monthly WHERE agency LIKE 'Detr%' AND year = 2026",
    "SELECT count FROM agency_monthly WHERE (agency = 'Detroit' OR agency = 'Flint') AND year = 2026",
    "SELECT count FROM agency_monthly WHERE UPPER(agency) = 'DETROIT' AND year = 2026",
    "SELECT count FROM agency_monthly WHERE ori IN (SELECT ori FROM agencies WHERE state = 'MI')",
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND year = 2026 AND count > 0",
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND year = 2026 GROUP BY offense HAVING SUM(count) > 5",
    "SELECT count FROM national_monthly WHERE year = 2026 AND month = 6",
    "SELECT 1",
  ];
  for (const sql of unreadable) {
    const result = explainEmptyCurrentTrendsResult(db, sql);
    assert.equal(result.reason, "cannot_determine", `should not have been read: ${sql}`);
    assert.equal(result.establishedFromData, false, `should not be stated as fact: ${sql}`);
  }
});

check("an ambiguous place name is not resolved by guessing", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Springfield' AND year = 2026 AND month = 5 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "cannot_determine");
});

check("a place and period that do hold the requested offense are not explained away", () => {
  // Birmingham did supply a May 2026 murder figure, so an empty result here contradicts
  // what the tables show and no reason may be offered for it.
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Birmingham' AND state = 'AL' AND year = 2026 AND month = 5 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "cannot_determine");
});

check("one query returning nothing never becomes a claim that the place stopped reporting", () => {
  // Detroit filed for May 2026. A query naming only the place and month must not be read
  // as non-reporting, and the offense case must be checked against real rows.
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' AND year = 2026 AND month = 5",
  );
  assert.notEqual(result.reason, "no_report_for_period");
});

console.log("\nevery identifier in the query has to agree");

check("an ORI and a name that disagree are not silently reconciled", () => {
  // Review finding 1. The ORI used to win and the name was dropped, so a query that
  // could not match anything was explained as a fact about whichever place the ORI
  // named. The contradiction is the real reason, and it is not one we can report.
  // MI631900X filed nothing for May 2026, so letting the ORI win produced the false
  // sentence "Pontiac, MI filed no report for May 2026" for a query about Birmingham.
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE ori = 'MI631900X' AND agency = 'Birmingham' AND state = 'AL' AND year = 2026 AND month = 5 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "cannot_determine");
  assert.equal(result.establishedFromData, false);
  assert.doesNotMatch(result.message, /Pontiac|Birmingham/);
});

check("an ORI and a state that disagree are not silently reconciled", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE ori = 'MI631900X' AND state = 'AL' AND year = 2026 AND month = 5 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "cannot_determine");
  assert.doesNotMatch(result.message, /Pontiac/);
});

check("an ORI that matches nothing at all is still a place we do not carry", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE ori = 'ZZ9999999' AND year = 2026 AND month = 5 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "place_not_covered");
});

console.log("\nthe agency directory is not the only record of who is carried");

check("an ORI that only the monthly records carry is not called uncarried", () => {
  // Review finding 2. MI6367300 is Pontiac's replacement ORI: it files monthly rows
  // but has no directory entry, and the importer keeps such rows on purpose.
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE ori = 'MI6367300' AND year = 2026 AND month = 5 AND offense = 'Rape'",
  );
  assert.notEqual(result.reason, "place_not_covered");
  assert.equal(result.reason, "offense_not_reported");
  assert.match(result.message, /Pontiac, MI/);
});

check("a name carried under two ORIs is checked across both, not just the listed one", () => {
  // Pontiac filed May 2026 under its replacement ORI only. Reading the directory ORI
  // alone would report that Pontiac filed nothing that month, which is false.
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Pontiac' AND state = 'MI' AND year = 2026 AND month = 5 AND offense = 'Rape'",
  );
  assert.notEqual(result.reason, "no_report_for_period");
  assert.equal(result.reason, "offense_not_reported");
  assert.match(result.message, /no rape value/i);
});

check("that place really did file that month, under the replacement ORI", () => {
  // Guards the test above: if the fixture stopped exercising the two-ORI case, the
  // assertion would pass for the wrong reason.
  const filed = db
    .prepare("SELECT ori FROM agency_monthly WHERE agency = 'Pontiac' AND state = 'MI' AND year = 2026 AND month = 5")
    .all() as { ori: string }[];
  assert.deepEqual(filed.map((r) => r.ori), ["MI6367300"]);
});

check("a statement about a place covers the place, not one of its ORIs", () => {
  // Pontiac filed April 2026 under its old ORI. A query scoped to the replacement ORI
  // returns nothing for April, but "Pontiac filed no report for April" would be false:
  // anything said about a named place has to be true of every record of that place.
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE ori = 'MI6367300' AND year = 2026 AND month = 4 AND offense = 'Murder'",
  );
  assert.notEqual(result.reason, "no_report_for_period");
  assert.equal(result.reason, "cannot_determine");
});

check("a month the whole place missed is still reported as a missing report", () => {
  const result = explainEmptyCurrentTrendsResult(
    db,
    "SELECT count FROM agency_monthly WHERE agency = 'Pontiac' AND state = 'MI' AND year = 2025 AND month = 1 AND offense = 'Murder'",
  );
  assert.equal(result.reason, "no_report_for_period");
  assert.match(result.message, /Pontiac, MI/);
});

console.log("\nthe wording stays plain");

check("no internal vocabulary reaches any message", () => {
  const samples = [
    "SELECT count FROM agency_monthly WHERE agency = 'Nowhereville' AND state = 'MI' AND year = 2026 AND month = 5 AND offense = 'Murder'",
    "SELECT count FROM agency_monthly WHERE state = 'WY' AND year = 2026 AND month = 5 AND offense = 'Murder'",
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' AND year = 2016 AND month = 5 AND offense = 'Murder'",
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' AND year = 2026 AND month = 4 AND offense = 'Murder'",
    "SELECT count FROM agency_monthly WHERE agency = 'Detroit' AND state = 'MI' AND year = 2026 AND month = 5 AND offense = 'Rape'",
    "SELECT 1",
  ];
  for (const sql of samples) {
    const { message } = explainEmptyCurrentTrendsResult(db, sql);
    assert.doesNotMatch(message, BANNED, `internal vocabulary in: ${message}`);
    assert.doesNotMatch(message, /agency_monthly|national_monthly|sample_agencies/i, `table name in: ${message}`);
    assert.ok(message.trim().length > 0, "every situation needs a sentence");
  }
});

check("the message for not knowing does not blame the data", () => {
  const { message } = explainEmptyCurrentTrendsResult(db, "SELECT 1");
  assert.match(message, /can't determine/i);
  assert.doesNotMatch(message, /does not include|not available in Current Trends|has no report/i);
});

db.close();
console.log(`\ncurrent trends empty reason: ${passed} passed`);
