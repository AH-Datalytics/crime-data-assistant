/**
 * The calculation that was checked is the calculation that runs.
 *
 * The NIBRS planner used to swap a requested monthly reporting count for the precomputed
 * `nibrs_agency_completeness` table, unconditionally and after contract validation. The swap is
 * removed; this suite is why.
 *
 * WHAT MAKES IT WRONG, stated as a figure rather than a principle. The substitution's pattern is not
 * anchored to a whole statement, so it also fires inside a CTE or a derived relation -- where the
 * reporting count is not the answer's measure but the filter deciding WHICH AGENCIES the answer
 * covers. On a fixture where the two sources disagree, "murders in 2024 by agencies reporting all 12
 * months" returns 12 from the requested statement and 78 from the substituted one. A different
 * population, silently, from a rewrite nobody asked for.
 *
 * Two things this suite must not be mistaken for:
 *   - It does NOT claim the two sources disagree in production. The disagreement is CONSTRUCTED,
 *     because that is the only way to test an assumed equality. The point is that no check on this
 *     path asserts the equality the substitution depended on.
 *   - It does NOT refuse reporting-filter questions. The contract validator accepts the witness
 *     question and must keep accepting it; the fix is to run what was asked, not to decline it.
 *
 * The mutation at the end restores the removed rewrite IN MEMORY -- a local function, never a write
 * to the shared source -- and the changed-figure assertions must fail against it. Without that, the
 * preservation assertions would pass just as happily against code that never had the bug.
 *
 * Section 5 covers a second obligation that came out of the same change. Removing the rewrite would
 * have cost a domestic-violence rate the sentence admitting its denominator is population served
 * rather than full population, because that sentence was keyed to the table the rewrite introduced.
 * Restoring it too loosely then let an UNADJUSTED rate claim an adjustment it never made. Both the
 * loss and the false claim are asserted there, with executed figures.
 *
 * Synthetic in-memory fixtures only. No real database, no source, no model, no server.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { optimizeNibrsSql } from "../lib/nibrs-sql-optimizer";
import { validateSqlSchema } from "../lib/schema-validation";
import { validateQueryContractSql, queryContractFailureMessage } from "../lib/query-contract-validator";
import { applyResultDisclosures } from "../lib/result-disclosure";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message.split("\n")[0]}`);
  }
}

/*
 * THE REMOVED REWRITE, reproduced verbatim so it can be mutated back in.
 *
 * This is the only copy of the old behaviour that should exist anywhere. If the product file ever
 * reacquires it, the last check in this file catches that too.
 */
function restoreRemovedSubstitution(sql: string): string {
  return sql.replace(
    /SELECT\s+ori\s*,\s*COUNT\s*\(\s*DISTINCT\s+month\s*\)\s+AS\s+months_reported\s+FROM\s+summary_city_monthly\s+WHERE\s+year\s*=\s*(\d{4})\s+GROUP\s+BY\s+ori/gi,
    "SELECT ori, months_reported FROM nibrs_agency_completeness WHERE year = $1"
  );
}

/** The old pipeline: substitute first, then everything the planner still does. */
const optimizeWithSubstitution = (sql: string, rollupAvailable = false): string =>
  optimizeNibrsSql(restoreRemovedSubstitution(sql), rollupAvailable);

type Fixture = {
  db: Database.Database;
  /** What the monthly rows actually say, computed here rather than by a statement under test. */
  monthsFromMonthlyRows: Record<string, number>;
  murdersByOri: Record<string, number>;
};

/**
 * `completeness` is what the precomputed table CLAIMS per agency. Passing a value that differs from
 * the agency's real month count is what makes a fixture a disagreeing one.
 */
function buildFixture(completeness: Record<string, number>): Fixture {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE summary_city_monthly(ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, offense_count INTEGER);
    CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year);
    CREATE TABLE nibrs_agency_completeness(ori TEXT, year INTEGER, months_reported INTEGER);
    CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);
    CREATE TABLE agencies(ori TEXT, year INTEGER, city TEXT, state TEXT, population INTEGER);
    CREATE TABLE summary_arrestee_demographics(ori TEXT, year INTEGER, ucr_arrest_offense TEXT, arrestee_count INTEGER);
  `);
  const insertMonth = db.prepare("INSERT INTO summary_city_monthly VALUES(?,?,?,?,?)");
  // Agency A reports 11 months and 66 murders; agency B reports all 12 and 12 murders.
  for (let m = 1; m <= 11; m += 1) insertMonth.run("NM0010100", 2024, m, "09A", m);
  for (let m = 1; m <= 12; m += 1) insertMonth.run("NM0020200", 2024, m, "09A", 1);
  const insertComplete = db.prepare("INSERT INTO nibrs_agency_completeness VALUES(?,?,?)");
  for (const [ori, months] of Object.entries(completeness)) insertComplete.run(ori, 2024, months);
  db.prepare("INSERT INTO agencies VALUES(?,?,?,?,?)").run("NM0010100", 2024, "ALBUQUERQUE", "NM", 560000);
  db.prepare("INSERT INTO agencies VALUES(?,?,?,?,?)").run("NM0020200", 2024, "LAS CRUCES", "NM", 110000);
  db.prepare("INSERT INTO summary_arrestee_demographics VALUES(?,?,?,?)").run("NM0010100", 2024, "35A", 42);

  const months: Record<string, number> = {};
  const murders: Record<string, number> = {};
  for (const row of db
    .prepare(
      "SELECT ori, COUNT(DISTINCT month) AS m, SUM(offense_count) AS c FROM summary_city_monthly " +
        "WHERE year = 2024 AND ucr_offense_code = '09A' GROUP BY ori"
    )
    .all() as Array<{ ori: string; m: number; c: number }>) {
    months[row.ori] = row.m;
    murders[row.ori] = row.c;
  }
  return { db, monthsFromMonthlyRows: months, murdersByOri: murders };
}

/*
 * Read the measure BY NAME, never by position. The first draft took column 0, which on a
 * `GROUP BY ori` shape is the ORI — so it coerced 'NM0010100' to NaN and failed a preservation
 * assertion that had nothing wrong with it. A positional read answers a question adjacent to the
 * one asked; an unknown column name fails here instead of quietly returning a number.
 */
const scalar = (db: Database.Database, sql: string, column: string): number | null => {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  if (!row) return null;
  assert.ok(column in row, `result has a '${column}' column; got ${Object.keys(row).join(", ")}`);
  const value = row[column];
  return value === null || value === undefined ? null : Number(value);
};

/* The requested reporting count, and the two shapes that embed it as a filter. */
const REPORTING_COUNT =
  "SELECT ori, COUNT(DISTINCT month) AS months_reported FROM summary_city_monthly WHERE year = 2024 GROUP BY ori";

const WITNESS_CTE =
  `WITH reporting AS (${REPORTING_COUNT}) ` +
  "SELECT SUM(s.offense_count) AS murders FROM summary_city_monthly s JOIN reporting r ON s.ori = r.ori " +
  "WHERE s.year = 2024 AND s.ucr_offense_code = '09A' AND r.months_reported = 12";

const WITNESS_DERIVED =
  "SELECT SUM(s.offense_count) AS murders FROM summary_city_monthly s " +
  `JOIN (${REPORTING_COUNT}) r ON s.ori = r.ori ` +
  "WHERE s.year = 2024 AND s.ucr_offense_code = '09A' AND r.months_reported = 12";

const ORDINARY_TOTAL =
  "SELECT SUM(offense_count) AS murders FROM summary_city_monthly WHERE year = 2024 AND ucr_offense_code = '09A'";

const WITNESS_QUESTION = "How many murders were reported in 2024 by agencies reporting all 12 months?";

/* ------------------------------------------------------------------ *
 * 1. The disagreeing fixture: the condition the substitution assumed away
 * ------------------------------------------------------------------ */

const disagreeing = buildFixture({ NM0010100: 12, NM0020200: 12 });

check("the fixture disagrees by construction: 11 real months recorded as 12", () => {
  assert.equal(disagreeing.monthsFromMonthlyRows.NM0010100, 11, "agency A reported 11 months");
  assert.equal(
    scalar(disagreeing.db, "SELECT months_reported FROM nibrs_agency_completeness WHERE ori = 'NM0010100' AND year = 2024", "months_reported"),
    12,
    "while the precomputed table claims 12 — this is the assumed equality, constructed false"
  );
  assert.equal(disagreeing.murdersByOri.NM0010100, 66);
  assert.equal(disagreeing.murdersByOri.NM0020200, 12);
});

check("the witness question is accepted, not refused — the fix is not a decline", () => {
  for (const [label, sql] of [["CTE", WITNESS_CTE], ["derived relation", WITNESS_DERIVED]] as const) {
    const verdict = validateQueryContractSql({ question: WITNESS_QUESTION, source: "nibrs", sql });
    assert.equal(
      queryContractFailureMessage(verdict),
      null,
      `the ${label} shape passes contract validation and must keep passing`
    );
  }
});

check("the bare reporting count is still refused as an answer's measure — unchanged", () => {
  // This refusal is pre-existing and is NOT the protection. It covers the count presented as the
  // measure; it never covered the same text used as a filter, which is what the witnesses do.
  const verdict = validateQueryContractSql({
    question: "how many months did each agency report in 2024",
    source: "nibrs",
    sql: REPORTING_COUNT,
  });
  assert.match(String(queryContractFailureMessage(verdict)), /.+/, "still refused");
  assert.ok(
    (verdict.enforced ?? []).includes("structural-row-count-not-a-measure"),
    "on the same rule as before"
  );
});

/* ------------------------------------------------------------------ *
 * 2. Preservation: the requested calculation reaches execution
 * ------------------------------------------------------------------ */

for (const [label, witness] of [["CTE", WITNESS_CTE], ["derived relation", WITNESS_DERIVED]] as const) {
  check(`${label} witness: the planner leaves the requested reporting count alone`, () => {
    const planned = optimizeNibrsSql(witness, false);
    assert.match(planned, /COUNT\s*\(\s*DISTINCT\s+month\s*\)\s+AS\s+months_reported/i, "the count survives");
    assert.doesNotMatch(planned, /nibrs_agency_completeness/i, "and no completeness table is introduced");
  });

  check(`${label} witness: the figure is 12, the requested population`, () => {
    const planned = optimizeNibrsSql(witness, false);
    const schema = validateSqlSchema(disagreeing.db, planned);
    assert.equal(schema.ok, true, "schema validation passes");
    const executedText = schema.corrected ? schema.sql : planned;
    const requested = scalar(disagreeing.db, witness, "murders");
    const executed = scalar(disagreeing.db, executedText, "murders");
    assert.equal(requested, 12, "the statement as written answers 12");
    assert.equal(executed, 12, "and the statement that would execute answers 12");
    assert.equal(executed, requested, "identical, because only agency B actually reported 12 months");
  });

  check(`${label} witness: MUTATION — restoring the substitution changes 12 to 78`, () => {
    const mutated = optimizeWithSubstitution(witness, false);
    const figure = scalar(disagreeing.db, mutated, "murders");
    assert.equal(figure, 78, "the removed rewrite silently widens the population to every agency");
    assert.notEqual(figure, scalar(disagreeing.db, witness, "murders"), "which is a different answer to the same question");
    // And it would not have been caught downstream: the substituted text validates cleanly too.
    assert.equal(
      queryContractFailureMessage(validateQueryContractSql({ question: WITNESS_QUESTION, source: "nibrs", sql: mutated })),
      null,
      "re-validating the executed text would NOT have caught this — it passes"
    );
  });
}

check("the ordinary all-agency total is untouched at 78", () => {
  const planned = optimizeNibrsSql(ORDINARY_TOTAL, false);
  assert.equal(scalar(disagreeing.db, planned, "murders"), 78, "every agency's murders, as asked");
  assert.equal(scalar(disagreeing.db, ORDINARY_TOTAL, "murders"), 78, "and the unplanned text agrees");
});

/* ------------------------------------------------------------------ *
 * 3. The equal-source counterpart: where the assumption held, nothing changes
 * ------------------------------------------------------------------ */

const agreeing = buildFixture({ NM0010100: 11, NM0020200: 12 });

check("equal-source counterpart: correction and old behaviour agree when the sources agree", () => {
  assert.equal(
    scalar(agreeing.db, "SELECT months_reported FROM nibrs_agency_completeness WHERE ori = 'NM0010100' AND year = 2024", "months_reported"),
    11,
    "the precomputed table now matches the 11 monthly rows"
  );
  for (const witness of [WITNESS_CTE, WITNESS_DERIVED]) {
    const corrected = scalar(agreeing.db, optimizeNibrsSql(witness, false), "murders");
    const old = scalar(agreeing.db, optimizeWithSubstitution(witness, false), "murders");
    assert.equal(corrected, 12, "the correction answers 12");
    assert.equal(old, 12, "and so did the substitution, here");
    assert.equal(corrected, old, "so the correction costs nothing where the equality actually holds");
  }
});

/* ------------------------------------------------------------------ *
 * 4. Preserved planner behaviour: index hints, and a producer's own use of the table
 * ------------------------------------------------------------------ */

check("supported index planning is retained, and preserves its figure", () => {
  const oriScoped =
    "SELECT ori, SUM(offense_count) AS offenses FROM summary_city_monthly " +
    "WHERE ori = 'NM0010100' AND year = 2024 AND ucr_offense_code = '09A' GROUP BY ori";
  const planned = optimizeNibrsSql(oriScoped, false);
  assert.match(planned, /summary_city_monthly INDEXED BY idx_scm_ori_year/i, "the hint is still added");
  assert.notEqual(planned, oriScoped, "so the planner is genuinely still doing its job");
  assert.equal(scalar(disagreeing.db, planned, "offenses"), 66, "and the hinted statement returns the same 66");
  assert.equal(scalar(disagreeing.db, oriScoped, "offenses"), 66);
});

check("a producer that asks for the completeness table still gets it verbatim", () => {
  // The correction removes an imposed swap, not access to the table. lib/nibrs-completeness.ts and
  // the deterministic queries read it directly, and the NIBRS prompt teaches it as the DV-rate
  // denominator; all of that keeps working.
  const asked =
    "SELECT SUM(a.population * rpt.months_reported / 12.0) AS adj_population FROM agencies a " +
    "JOIN (SELECT ori, months_reported FROM nibrs_agency_completeness WHERE year = 2024) rpt ON rpt.ori = a.ori " +
    "WHERE a.year = 2024";
  const planned = optimizeNibrsSql(asked, false);
  assert.match(planned, /FROM nibrs_agency_completeness WHERE year = 2024/i, "unchanged");
  assert.equal(scalar(disagreeing.db, planned, "adj_population"), scalar(disagreeing.db, asked, "adj_population"), "and returns the same figure");
});

check("schema correction still fires after planning", () => {
  const wrongColumn = "SELECT SUM(arrest_count) AS arrests FROM summary_arrestee_demographics WHERE ori = 'NM0010100' AND year = 2024";
  const schema = validateSqlSchema(disagreeing.db, optimizeNibrsSql(wrongColumn, false));
  assert.equal(schema.ok, true, "the corrector accepts it");
  assert.equal(schema.corrected, true, "by rewriting the column");
  assert.equal(scalar(disagreeing.db, schema.sql, "arrests"), 42, "and the corrected statement runs");
});

/* ------------------------------------------------------------------ *
 * 5. The explanation must match the calculation: adjusted versus unadjusted rates
 * ------------------------------------------------------------------ */

/*
 * Found by asking what else read the substituted text: the route computes result disclosures from
 * the POST-planner SQL, and the DV-rate denominator caveat required the string
 * `nibrs_agency_completeness`. A rate written in the monthly form only ever satisfied that because
 * the planner rewrote it first. Remove the rewrite and the answer keeps its adjusted denominator
 * while losing the sentence saying so -- a truthfulness regression caused by a correctness fix.
 *
 * The first repair went too far in the other direction, and the correction matters more than the
 * original catch. It accepted a month count plus a `rate_per_100k` alias as evidence of adjustment,
 * so an UNADJUSTED rate -- dividing by `SUM(a.population)` while merely reporting months alongside
 * -- was told it had been "adjusted for months reported". Below, that rate is 100 and the genuinely
 * adjusted one is 200, from the same rows: describing both the same way is a false explanation of a
 * real figure. A matching count somewhere in the statement says nothing about the denominator, so
 * the inline branch now requires the recognised adjustment factor itself. These rates are EXECUTED
 * against a fixture and their real rows are what the disclosure sees.
 */
const DENOMINATOR_CAVEAT = "Rate denominator: population served by NIBRS-reporting agencies";

/** One agency, 10,000 people, 10 DV victims, six reporting months. */
function buildDvFixture(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE summary_city_monthly(ori TEXT, year INTEGER, month INTEGER, ucr_offense_code TEXT, offense_count INTEGER);
    CREATE TABLE nibrs_agency_completeness(ori TEXT, year INTEGER, months_reported INTEGER);
    CREATE TABLE agencies(ori TEXT, year INTEGER, state TEXT, population INTEGER);
    CREATE TABLE summary_domestic_violence(ori TEXT, year INTEGER, victim_count INTEGER);
  `);
  const ins = db.prepare("INSERT INTO summary_city_monthly VALUES(?,?,?,?,?)");
  // Offense code is incidental to the rate, but the reviewer's witness filters on '09A', so the
  // monthly rows carry it -- otherwise that statement returns no rows and its assertions are free.
  for (let m = 1; m <= 6; m += 1) ins.run("LA0010100", 2024, m, "09A", 1);
  db.prepare("INSERT INTO nibrs_agency_completeness VALUES(?,?,?)").run("LA0010100", 2024, 6);
  db.prepare("INSERT INTO agencies VALUES(?,?,?,?)").run("LA0010100", 2024, "LA", 10000);
  db.prepare("INSERT INTO summary_domestic_violence VALUES(?,?,?)").run("LA0010100", 2024, 10);
  return db;
}

const dv = buildDvFixture();

const DV_FROM_JOIN =
  "FROM summary_domestic_violence dv JOIN agencies a ON a.ori = dv.ori " +
  "JOIN (SELECT ori, COUNT(DISTINCT month) AS months_reported FROM summary_city_monthly WHERE year = 2024 GROUP BY ori) rpt " +
  "ON rpt.ori = a.ori WHERE a.year = 2024 AND dv.year = 2024 GROUP BY a.state";

/** Adjusted: the months factor is in the denominator. 10 victims / (10,000 * 6/12) per 100k = 200. */
const DV_ADJUSTED =
  "SELECT a.state, SUM(dv.victim_count) * 100000.0 / SUM(a.population * rpt.months_reported / 12.0) AS rate_per_100k " +
  DV_FROM_JOIN;

/** Unadjusted: full population in the denominator, months merely reported. 10 / 10,000 per 100k = 100. */
const DV_UNADJUSTED =
  "SELECT a.state, SUM(dv.victim_count) * 100000.0 / SUM(a.population) AS rate_per_100k, " +
  "MAX(rpt.months_reported) AS months_reported " +
  DV_FROM_JOIN;

/** The completeness-table form, whose behaviour predates this work and is unchanged. */
const DV_COMPLETENESS_FORM =
  "SELECT a.state, SUM(dv.victim_count) * 100000.0 / SUM(a.population * rpt.months_reported / 12.0) AS rate_per_100k " +
  "FROM summary_domestic_violence dv JOIN agencies a ON a.ori = dv.ori " +
  "JOIN (SELECT ori, months_reported FROM nibrs_agency_completeness WHERE year = 2024) rpt " +
  "ON rpt.ori = a.ori WHERE a.year = 2024 AND dv.year = 2024 GROUP BY a.state";

/** Run the statement, then hand its REAL rows to the delivery function. */
const discloseExecuted = (sql: string): string => {
  const rows = dv.prepare(sql).all() as Record<string, unknown>[];
  return applyResultDisclosures({
    explanation: "Louisiana had a domestic violence rate of " + rows[0].rate_per_100k + " per 100,000 in 2024.",
    question: "what is the domestic violence rate per 100k by state in 2024",
    sql,
    rows,
    tab: "nibrs",
    resultState: { kind: "rows" } as never,
  });
};

/** The over-broad grant, restored in memory: a month count plus a rate alias was enough. */
const broadGrantWouldClaimAdjustment = (sql: string): boolean =>
  /\bsummary_domestic_violence\b/i.test(sql) &&
  /\bagencies\b/i.test(sql) &&
  (/\bnibrs_agency_completeness\b/i.test(sql) || /\bCOUNT\s*\(\s*DISTINCT\s+month\s*\)\s+AS\s+months_reported\b/i.test(sql)) &&
  (/\breporting_population\b/i.test(sql) || /\brate_per_100k\b/i.test(sql) ||
    /\bSUM\s*\(\s*\w+\.population\s*\*\s*\w+\.months_reported\s*\/\s*12\.0\s*\)/i.test(sql));

check("the two rates really are different figures from the same rows", () => {
  const adjusted = dv.prepare(DV_ADJUSTED).get() as { rate_per_100k: number };
  const unadjusted = dv.prepare(DV_UNADJUSTED).get() as { rate_per_100k: number };
  assert.equal(unadjusted.rate_per_100k, 100, "full population in the denominator");
  assert.equal(adjusted.rate_per_100k, 200, "population served, halved by six months of twelve");
});

check("the caveat survives on BOTH adjusted forms", () => {
  assert.ok(
    discloseExecuted(DV_COMPLETENESS_FORM).includes(DENOMINATOR_CAVEAT),
    "the completeness form keeps it, as it always did"
  );
  assert.ok(
    discloseExecuted(optimizeNibrsSql(DV_ADJUSTED, false)).includes(DENOMINATOR_CAVEAT),
    "and the inline monthly form carries it without needing the removed rewrite"
  );
});

check("an UNADJUSTED rate is not told it was adjusted", () => {
  const delivered = discloseExecuted(DV_UNADJUSTED);
  assert.ok(
    !delivered.includes(DENOMINATOR_CAVEAT),
    "a rate over full population gets no months-adjustment claim, however many months it reports"
  );
  assert.ok(!/adjusted for months reported/i.test(delivered), "and no adjustment wording by any other route");
  // MUTATION: the over-broad grant would have claimed it, which is why this assertion exists.
  assert.equal(
    broadGrantWouldClaimAdjustment(DV_UNADJUSTED),
    true,
    "the restored broad grant does claim adjustment here, so the assertion above discriminates"
  );
});

/*
 * The reviewer's witness shape, kept verbatim rather than paraphrased: a CTE (not a derived
 * relation), an extra offense predicate in the reporting count, and the outer month column aliased
 * to something else entirely. My own pair above could have passed while this failed, so it is here
 * in the form it was reported.
 */
const CODEX_REPORTING =
  "SELECT ori, COUNT(DISTINCT month) AS months_reported FROM summary_city_monthly " +
  "WHERE year = 2024 AND ucr_offense_code = '09A' GROUP BY ori";
const codexWitness = (adjusted: boolean): string =>
  `WITH rpt AS (${CODEX_REPORTING}) SELECT a.state, MAX(rpt.months_reported) AS months_in_offense_records, ` +
  "SUM(dv.victim_count)*100000.0/SUM(a.population" +
  (adjusted ? " * rpt.months_reported / 12.0" : "") +
  ") AS rate_per_100k FROM summary_domestic_violence dv JOIN agencies a ON a.ori=dv.ori AND a.year=dv.year " +
  "JOIN rpt ON rpt.ori=a.ori WHERE dv.year=2024 GROUP BY a.state";

check("the reviewer's reported witness: 100 unadjusted claims nothing, 200 adjusted claims it", () => {
  const unadjusted = dv.prepare(codexWitness(false)).get() as { rate_per_100k: number };
  const adjusted = dv.prepare(codexWitness(true)).get() as { rate_per_100k: number };
  assert.equal(unadjusted.rate_per_100k, 100);
  assert.equal(adjusted.rate_per_100k, 200);
  assert.ok(
    !discloseExecuted(codexWitness(false)).includes(DENOMINATOR_CAVEAT),
    "the unadjusted rate gets no adjustment claim"
  );
  assert.ok(
    discloseExecuted(codexWitness(true)).includes(DENOMINATOR_CAVEAT),
    "the adjusted rate keeps it"
  );
  assert.equal(
    broadGrantWouldClaimAdjustment(codexWitness(false)),
    true,
    "and the restored broad grant claims it on the unadjusted one, so this discriminates"
  );
});

check("the caveat is not handed out indiscriminately", () => {
  const unrelated =
    "SELECT state, SUM(victim_count) AS victims FROM summary_victim_state_monthly WHERE year = 2024 GROUP BY state";
  assert.ok(
    !applyResultDisclosures({
      explanation: "Louisiana recorded 10 victims in 2024.",
      question: "domestic violence victims by state in 2024",
      sql: unrelated,
      rows: [{ state: "LA", victims: 10 }],
      tab: "nibrs",
      resultState: { kind: "rows" } as never,
    }).includes(DENOMINATOR_CAVEAT),
    "a plain count gets no denominator caveat"
  );
  const noRate =
    "SELECT a.state, SUM(dv.victim_count) AS victims FROM summary_domestic_violence dv " +
    "JOIN agencies a ON a.ori = dv.ori WHERE dv.year = 2024 GROUP BY a.state";
  assert.ok(
    !applyResultDisclosures({
      explanation: "Louisiana recorded 10 victims in 2024.",
      question: "domestic violence victims by state in 2024",
      sql: noRate,
      rows: [{ state: "LA", victims: 10 }],
      tab: "nibrs",
      resultState: { kind: "rows" } as never,
    }).includes(DENOMINATOR_CAVEAT),
    "nor does a DV count with no rate denominator"
  );
});

/* ------------------------------------------------------------------ *
 * 6. The removal itself, pinned in the source
 * ------------------------------------------------------------------ */

check("the planner source no longer names the completeness table", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "lib", "nibrs-sql-optimizer.ts"), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /nibrs_agency_completeness/i, "outside comments, the substitution is gone");
  assert.doesNotMatch(code, /COUNT\s*\(\s*DISTINCT\s+month/i, "and so is its trigger pattern");
  assert.match(source, /REMOVED: a reporting-table substitution/, "with the reason recorded where the code was");
});

disagreeing.db.close();
agreeing.db.close();
dv.close();

console.log(`\noptimizer calculation preservation: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
