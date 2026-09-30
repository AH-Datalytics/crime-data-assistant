/**
 * The controlled yearly offence-and-clearance path: what it answers, and what it refuses to answer.
 *
 * This family exists because a general checker could not establish, from generated SQL, that a
 * yearly figure was actually a year's figure. So the path owns the offence, the contributing rows,
 * the period and the arithmetic together. These checks hold it to that: every figure is computed
 * independently here, the fixture carries wrong-entity, wrong-offence and wrong-year decoys, and the
 * unsupportable cases are each given their own counterpart so a check cannot pass by refusing the
 * whole family.
 *
 * The fixture reproduces the values MEASURED on the restored NIBRS backup on 2026-09-12 for Houston
 * and `23F` across 2018-2026, including the three-way 2026 disagreement that made that year
 * unsupportable. Source evidence is recorded in the handoff; nothing here reads a source database.
 */
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { buildQueryContract } from "../lib/query-contract";
import {
  annualClearanceDelivery,
  asksAnnualClearanceFamily,
  buildNibrsAnnualClearanceQuery,
  partitionAnnualClearanceRows,
  type AnnualClearanceRow,
} from "../lib/nibrs-deterministic-queries";
import { planNibrsQuery } from "../lib/nibrs-query-planner";
import { ownsItsCalculation, decideDeterministicFailure } from "../lib/nibrs-recovery";
import { deterministicPlanRefusal } from "../lib/deterministic-plan-guard";
import { runOwnedAnnualClearance } from "../lib/nibrs-owned-family";
import { applyResultDisclosures, alignTitleYearRange } from "../lib/result-disclosure";
import { genericResultState } from "../lib/result-state-adapters";
import { validateQueryContractSql, queryContractFailureMessage } from "../lib/query-contract-validator";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); console.log(`  PASS  ${name}`); passed += 1; }
  catch (error) { console.log(`  FAIL  ${name}\n        ${(error as Error).message}`); failed += 1; }
}

const HOUSTON = "Houston vehicle burglaries by year and clearance status, 2018 to 2026";

function planFor(ori: string, label: string, years: number[]) {
  return {
    elapsedMs: 0,
    hasStateComparison: false,
    places: [{
      contractIndex: 0, kind: "city_police", status: "resolved", label,
      oriYears: years.map((year) => ({ ori, year, population: 2300000 })),
      population: 2300000,
    }],
  } as never;
}

// ── the fixture: measured source values, plus decoys ────────────────────────────────────────────
type AnnualFixture = [number, number, number, number, number, number, number, number];
const MEASURED_ANNUAL: AnnualFixture[] = [
  // year, total, cleared_by_arrest, A, B, C, D, E
  [2018, 17869, 193, 0, 23, 4, 17, 0],
  [2019, 33125, 380, 0, 39, 4, 19, 0],
  [2020, 27839, 396, 0, 20, 2, 23, 0],
  [2021, 23678, 278, 2, 14, 1, 12, 0],
  [2022, 26413, 276, 0, 12, 2, 4, 0],
  [2023, 28635, 310, 1, 12, 2, 7, 0],
  [2024, 26780, 290, 0, 9, 0, 7, 0],
  [2025, 23788, 272, 0, 5, 0, 4, 0],
  [2026, 2478, 24, 0, 0, 0, 0, 0],
];
/** year -> [months with data, monthly offence total, monthly clearance total] */
const MEASURED_MONTHLY: Record<number, [number, number, number]> = {
  2018: [7, 17869, 237], 2019: [12, 33125, 442], 2020: [12, 27839, 441], 2021: [12, 23678, 307],
  2022: [12, 26413, 294], 2023: [12, 28635, 332], 2024: [12, 26780, 306], 2025: [12, 23788, 281],
  2026: [6, 8967, 90],
};
const MEASURED_COMPLETENESS: Record<number, number> = {
  2018: 7, 2019: 12, 2020: 12, 2021: 12, 2022: 12, 2023: 12, 2024: 12, 2025: 12, 2026: 1,
};

const dbPath = path.join(os.tmpdir(), "annual-clearance-" + process.pid + ".db");
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
{
  const writer = new Database(dbPath);
  writer.exec(
    "CREATE TABLE summary_clearance_detail (year INT, state TEXT, ori TEXT, ucr_offense_code TEXT," +
    " cleared_by_arrest INT, cleared_A INT, cleared_B INT, cleared_C INT, cleared_D INT, cleared_E INT, total_offenses INT);" +
    "CREATE INDEX idx_scd_ori_year ON summary_clearance_detail(ori, year);" +
    "CREATE TABLE summary_city_monthly (year INT, month INT, state TEXT, ori TEXT, ucr_offense_code TEXT, offense_count INT, cleared_count INT);" +
    "CREATE INDEX idx_scm_ori_year ON summary_city_monthly(ori, year);" +
    "CREATE TABLE nibrs_agency_completeness (ori TEXT, year INT, months_reported INT);" +
    "CREATE INDEX idx_nac_ori_year ON nibrs_agency_completeness(ori, year);");

  const annual = writer.prepare("INSERT INTO summary_clearance_detail VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const monthly = writer.prepare("INSERT INTO summary_city_monthly VALUES (?,?,?,?,?,?,?)");
  const complete = writer.prepare("INSERT INTO nibrs_agency_completeness VALUES (?,?,?)");

  for (const [year, total, arrest, a, b, c, d, e] of MEASURED_ANNUAL) {
    annual.run(year, "TX", "TXHPD0000", "23F", arrest, a, b, c, d, e, total);
    // DECOYS: another agency and another offence, both with figures nothing should ever return.
    annual.run(year, "TX", "TXAPD0000", "23F", 1, 1, 1, 1, 1, 1, 999999);
    annual.run(year, "TX", "TXHPD0000", "220", 5, 5, 5, 5, 5, 5, 888888);

    const [months, offenses, cleared] = MEASURED_MONTHLY[year];
    // Distinct per-month values that sum to the measured total, so a single month can never
    // impersonate the year.
    for (let i = 1; i <= months; i += 1) {
      const month = year === 2018 ? 5 + i : i;
      const share = Math.floor(offenses / months);
      const clearedShare = Math.floor(cleared / months);
      monthly.run(year, month, "TX", "TXHPD0000", "23F",
        i === 1 ? offenses - share * (months - 1) : share,
        i === 1 ? cleared - clearedShare * (months - 1) : clearedShare);
      monthly.run(year, month, "TX", "TXAPD0000", "23F", 7777, 77);
      monthly.run(year, month, "TX", "TXHPD0000", "220", 8888, 88);
    }
    complete.run("TXHPD0000", year, MEASURED_COMPLETENESS[year]);
    complete.run("TXAPD0000", year, 12);
  }
  writer.close();
}
// A second agency and offence, so a positive is EXECUTED for something other than the saved case.
{
  const writer2 = new Database(dbPath);
  const annual2 = writer2.prepare("INSERT INTO summary_clearance_detail VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const monthly2 = writer2.prepare("INSERT INTO summary_city_monthly VALUES (?,?,?,?,?,?,?)");
  const complete2 = writer2.prepare("INSERT INTO nibrs_agency_completeness VALUES (?,?,?)");
  for (const [year, total, cleared] of [[2019, 500, 50], [2020, 600, 60]] as const) {
    annual2.run(year, "TX", "TX0570000", "120", cleared, 0, 0, 0, 0, 0, total);
    for (let month = 1; month <= 12; month += 1) {
      monthly2.run(year, month, "TX", "TX0570000", "120",
        month === 1 ? total - Math.floor(total / 12) * 11 : Math.floor(total / 12),
        month === 1 ? cleared - Math.floor(cleared / 12) * 11 : Math.floor(cleared / 12));
    }
    complete2.run("TX0570000", year, 12);
  }
  writer2.close();
}
const db = new Database(dbPath, { readonly: true });

// ── A. family recognition, decided on the contract ──────────────────────────────────────────────
console.log("\nA. what this path owns");

check("the yearly clearance question is owned", () => {
  assert.ok(asksAnnualClearanceFamily(HOUSTON));
});

check("a different agency, offence and span is owned on the same terms", () => {
  assert.ok(asksAnnualClearanceFamily("Dallas robbery clearance rate by year 2020 to 2023"));
});

check("a plain count question is not owned", () => {
  assert.equal(asksAnnualClearanceFamily("Houston vehicle burglaries by year 2018 to 2026"), false);
});

check("a clearance-type breakdown keeps its own builder", () => {
  assert.equal(
    asksAnnualClearanceFamily("Houston murder clearances by clearance type 2020 to 2023"), false);
});

check("a person crime is not answered from an offence-count source", () => {
  // Murders are counted per victim in this product; the clearance tables count offences.
  assert.equal(asksAnnualClearanceFamily("Houston murder clearance rate by year 2018 to 2024"), false);
});

check("two places are not this family", () => {
  assert.equal(
    asksAnnualClearanceFamily("Houston and Dallas vehicle burglary clearance rates by year 2020 to 2023"),
    false);
});

check("an open-ended period is not this family", () => {
  assert.equal(asksAnnualClearanceFamily("Houston vehicle burglary clearance rate by year"), false);
});

// ── B. the offence the question actually names ──────────────────────────────────────────────────
console.log("\nB. the offence, before any arithmetic");

check("\"vehicle burglaries\" resolves to theft from a motor vehicle", () => {
  const contract = buildQueryContract(HOUSTON, "nibrs");
  assert.deepEqual(contract?.metric.offenseCodes, ["23F"]);
  assert.equal(contract?.metric.topic, "vehicle_burglary");
});

check("plain burglary is untouched", () => {
  assert.deepEqual(buildQueryContract("Houston burglaries in 2024", "nibrs")?.metric.offenseCodes, ["220"]);
});

check("vehicle theft and its parts are untouched", () => {
  assert.deepEqual(
    buildQueryContract("motor vehicle thefts in Houston 2024", "nibrs")?.metric.offenseCodes, ["240"]);
});

check("a sentence merely containing both words is not reassigned", () => {
  assert.deepEqual(
    buildQueryContract("were burglaries higher where there is more vehicle traffic", "nibrs")
      ?.metric.offenseCodes, ["220"]);
});

check("sources without that offence say so rather than answering with burglary", () => {
  for (const source of ["current", "historical"]) {
    const result = validateQueryContractSql({
      question: "Houston vehicle burglaries in 2024", source: source as never,
      sql: "SELECT year, SUM(count) AS n FROM agency_monthly WHERE offense='Burglary' AND state='TX' AND year=2024 GROUP BY year",
    });
    assert.ok(result.enforced.includes("vehicle-burglary-unsupported"), source);
    assert.match(String(queryContractFailureMessage(result)), /thefts from vehicles/i);
  }
});

// ── C. the answer, executed ─────────────────────────────────────────────────────────────────────
console.log("\nC. the delivered figures");

const built = buildNibrsAnnualClearanceQuery(HOUSTON, planFor("TXHPD0000", "Houston, TX", [2018, 2026]));
assert.ok(built, "the plan must build for the owned question");

check("the builder's own output passes the route's structural guard", () => {
  assert.equal(deterministicPlanRefusal({ question: HOUSTON, source: "nibrs", sql: built!.sql }), null);
});

check("the builder's own output draws no contract failure", () => {
  const result = validateQueryContractSql({ question: HOUSTON, source: "nibrs", sql: built!.sql });
  assert.equal(queryContractFailureMessage(result), null,
    [...result.enforced, ...result.retryIssues].join("; "));
});

const executed = db.prepare(built!.sql).all() as AnnualClearanceRow[];

check("every requested year comes back, supportable or not", () => {
  assert.deepEqual(executed.map((row) => row.year),
    [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
});

check("each year's figures are the measured ones, with decoys excluded", () => {
  for (const [year, total, arrest, a, b, c, d, e] of MEASURED_ANNUAL) {
    const row = executed.find((candidate) => candidate.year === year)!;
    const cleared = arrest + a + b + c + d + e;
    assert.equal(row.total_offenses, total, `${year} offences`);
    assert.equal(row.cleared, cleared, `${year} clearances`);
    assert.equal(row.not_cleared, total - cleared, `${year} not cleared`);
    assert.equal(row.clearance_rate, Math.round(1000 * cleared / total) / 10, `${year} rate`);
  }
});

const delivery = annualClearanceDelivery(HOUSTON, "Houston, TX", executed);
assert.ok(!("decline" in delivery), "the measured source supports an answer");
const answer = delivery as Exclude<typeof delivery, { decline: string }>;

check("only complete reporting years are delivered", () => {
  assert.deepEqual(answer.rows.map((row) => row.year), [2019, 2020, 2021, 2022, 2023, 2024, 2025]);
});

check("the title states the years delivered, not the years requested", () => {
  assert.equal(answer.title, "Thefts from vehicles and clearances, Houston, TX, 2019-2025");
});

check("the explanation says what the offence is and what clearance means", () => {
  assert.match(answer.explanation, /Theft from a motor vehicle \(NIBRS offense 23F\)/);
  assert.match(answer.explanation, /not burglary of a building/i);
  assert.match(answer.explanation, /not the same as a conviction/i);
  assert.match(answer.explanation, /Complete 12-month reporting years: 2019, 2020, 2021, 2022, 2023, 2024, 2025/);
});

check("the withheld years are named with their own reasons", () => {
  assert.match(answer.withheldNote, /No figure is given for 2018: only part of that year was reported/);
  assert.match(answer.withheldNote, /does not record which months/);
  assert.match(answer.withheldNote, /No figure is given for 2026: the yearly and monthly records disagree/);
});

check("no unsupportable figure and no counterfactual claim reaches the reader", () => {
  const whole = answer.explanation + answer.withheldNote;
  assert.doesNotMatch(whole, /\b2478\b|\b8967\b|\b17869\b/, "withheld figures must not appear");
  assert.doesNotMatch(whole, /lower than a full year/i,
    "unknown missing months do not establish what a full year would have held");
  assert.doesNotMatch(whole, /\bJune\b|\bJuly\b/,
    "which months were reported is not established by this source");
});

check("the reader is not shown the reconciliation working", () => {
  assert.deepEqual(answer.columns,
    ["year", "total_offenses", "cleared", "not_cleared", "clearance_rate", "months_reported"]);
});

// ── D. every delivered figure has passed every check ─────────────────────────────────────────────
console.log("\nD. what is withheld, and what still gets through");

const baseRow = (year: number, over: Partial<AnnualClearanceRow> = {}): AnnualClearanceRow => ({
  year, total_offenses: 100, cleared: 10, not_cleared: 90, clearance_rate: 10,
  min_component: 0, months_reported: 12, months_with_data: 12,
  monthly_offenses: 100, monthly_cleared: 10, ...over,
});

const withheldReason = (row: AnnualClearanceRow) =>
  partitionAnnualClearanceRows([row]).withheld[0]?.reason ?? null;

check("a year absent from the source is withheld, and a present one is not", () => {
  assert.match(String(withheldReason(baseRow(2019, { total_offenses: null, cleared: null }))),
    /no record for that year/);
  assert.equal(withheldReason(baseRow(2019)), null);
});

check("an annual row with a missing component is incomplete, not absent", () => {
  const reason = String(withheldReason(baseRow(2019, { cleared: null, min_component: null })));
  assert.match(reason, /clearance figures for that year are incomplete/);
  assert.doesNotMatch(reason, /no record for that year/,
    "a row that exists but cannot be added up is a different problem from a missing one");
});

check("a negative component is caught even when the sum looks clean", () => {
  // 20 + (-10) = 10, which is exactly the figure that would have been published.
  assert.match(String(withheldReason(baseRow(2019, { cleared: 10, min_component: -10 }))),
    /include a negative value/);
  assert.equal(withheldReason(baseRow(2019, { cleared: 10, min_component: 0 })), null);
});

check("sources disagreeing about the offence total withholds the year", () => {
  assert.match(String(withheldReason(baseRow(2026, { monthly_offenses: 400 }))),
    /disagree about how many offenses there were/);
  assert.equal(withheldReason(baseRow(2026, { monthly_offenses: 100 })), null);
});

check("sources disagreeing about the CLEARANCES withholds the year too", () => {
  assert.match(String(withheldReason(baseRow(2026, { monthly_cleared: 90 }))),
    /disagree about how many offenses were cleared/);
  assert.match(String(withheldReason(baseRow(2026, { monthly_cleared: null }))),
    /disagree about how many offenses were cleared/);
  assert.equal(withheldReason(baseRow(2026, { monthly_cleared: 10 })), null);
});

check("an unestablished reporting basis withholds the year", () => {
  assert.match(String(withheldReason(baseRow(2026, { months_reported: 1, months_with_data: 6 }))),
    /how much of the year was reported/);
  assert.match(String(withheldReason(baseRow(2026, { months_reported: null }))),
    /how much of the year was reported/);
});

check("a partial year is withheld even when its counts agree", () => {
  // Seven offence months and seven reported months do not establish WHICH months were reported.
  assert.match(String(withheldReason(baseRow(2018, { months_reported: 7, months_with_data: 7 }))),
    /only part of that year was reported, and this source does not record which months/);
  assert.equal(withheldReason(baseRow(2018, { months_reported: 12, months_with_data: 12 })), null);
});

check("more clearances than offences withholds the year rather than being clamped", () => {
  assert.match(String(withheldReason(baseRow(2021, { cleared: 500, monthly_cleared: 500 }))),
    /more clearances are recorded than offenses/);
  assert.equal(withheldReason(baseRow(2021, { cleared: 100, monthly_cleared: 100 })), null,
    "equal is not a contradiction");
});

check("a zero gets no shortcut past the evidence checks", () => {
  // An annual zero beside a monthly 100 and no reporting record is not a supported zero.
  assert.match(String(withheldReason(baseRow(2022, {
    total_offenses: 0, cleared: 0, not_cleared: 0, clearance_rate: null,
    monthly_offenses: 100, monthly_cleared: 0, months_reported: null,
  }))), /disagree about how many offenses there were/);

  // A genuinely supported zero is delivered, with no rate rather than a rate of zero.
  const supported = partitionAnnualClearanceRows([baseRow(2022, {
    total_offenses: 0, cleared: 0, not_cleared: 0, clearance_rate: null,
    monthly_offenses: 0, monthly_cleared: 0,
  })]);
  assert.equal(supported.withheld.length, 0);
  assert.equal(supported.delivered[0].total_offenses, 0);
  assert.equal(supported.delivered[0].clearance_rate, null);
});

check("when no year is supportable the reasons are the answer", () => {
  const none = annualClearanceDelivery(HOUSTON, "Houston, TX",
    [baseRow(2018, { total_offenses: null, cleared: null }), baseRow(2019, { monthly_offenses: 1 })]);
  assert.ok("decline" in none, "there is nothing to deliver");
  const text = (none as { decline: string }).decline;
  assert.match(text, /No year in the requested range can be reported/);
  assert.match(text, /No figure is given for 2018/);
  assert.match(text, /No figure is given for 2019/);
});

// ── E. ownership, on every exit the route can reach ──────────────────────────────────────────────
console.log("\nE. ownership, proved by running the shipped flow");

check("the planner routes the owned question to the controlled path", () => {
  const plan = planNibrsQuery(HOUSTON, planFor("TXHPD0000", "Houston, TX", [2018, 2026]));
  assert.equal(plan.kind, "deterministic");
  assert.equal((plan as { query: { guardrail: string } }).query.guardrail, "nibrs-annual-clearance");
});

check("an owned question the path cannot build is declined, never handed to the model", () => {
  const plan = planNibrsQuery(HOUSTON, null);
  assert.equal(plan.kind, "unavailable",
    `an owned request must not reach the model path (got ${plan.kind})`);
  assert.match((plan as { explanation: string }).explanation, /single reporting agency/i);
});

check("an owned FOLLOW-UP is declined too, rather than regaining generated calculation", () => {
  // `allowDeterministic: false` is the real route option for an authoritative query-bearing
  // follow-up. It used to return `model` before ownership was ever considered.
  for (const question of [HOUSTON, "Houston robbery clearance rate by year 2018 to 2025"]) {
    const plan = planNibrsQuery(question, planFor("TXHPD0000", "Houston, TX", [2018, 2025]),
      { allowDeterministic: false });
    assert.equal(plan.kind, "unavailable", question);
  }
});

check("an unowned follow-up still takes the ordinary follow-up route", () => {
  const plan = planNibrsQuery("how many murders in Houston in 2024", null, { allowDeterministic: false });
  assert.equal(plan.kind, "model");
  assert.equal((plan as { reason: string }).reason, "followup");
});

check("a month-restricted request is declined, not answered as a whole year", () => {
  const restricted = "Houston vehicle burglaries by year and clearance status, 2018 to 2026, January through July only";
  assert.ok(asksAnnualClearanceFamily(restricted), "it is still this family's shape");
  assert.equal(buildNibrsAnnualClearanceQuery(restricted, planFor("TXHPD0000", "Houston, TX", [2018, 2026])), null);
  const plan = planNibrsQuery(restricted, planFor("TXHPD0000", "Houston, TX", [2018, 2026]));
  assert.equal(plan.kind, "unavailable");
  assert.match((plan as { explanation: string }).explanation, /not a figure limited to particular months/i);
});

check("an unowned question still reaches its existing route", () => {
  const plan = planNibrsQuery("how many murders in Houston in 2024", null);
  assert.notEqual(plan.kind, "unavailable");
});

check("the family is the one marked as owning its calculation", () => {
  assert.ok(ownsItsCalculation("nibrs-annual-clearance"));
  assert.equal(ownsItsCalculation("deterministic-nibrs-local-city-offense-count"), false);
  assert.equal(ownsItsCalculation(null), false);
});

check("an execution failure stops rather than recovering through the model", () => {
  const decision = decideDeterministicFailure(
    { sql: built!.sql, guardrail: "nibrs-annual-clearance" },
    "SQLITE_ERROR: no such column: cleared_F", null);
  assert.equal(decision.outcome, "stop");
  // The narrative governor owns the wording for a product error, and its wording is the honest one:
  // a failure on our side, never an absence of data. What this family adds is the STOP.
  assert.match(decision.error ?? "", /failure on our side/i);
  assert.doesNotMatch(decision.error ?? "", /no (?:data|figures|records)/i);
});

check("an ordinary family still recovers, so this is a boundary and not a blanket stop", () => {
  const decision = decideDeterministicFailure(
    { sql: "SELECT 1", guardrail: "deterministic-nibrs-local-city-offense-count" },
    "SQLITE_ERROR: no such column: x", null);
  assert.notEqual(decision.outcome, "stop");
});

// ── F. the shipped terminal flow, executed with counters ─────────────────────────────────────────
console.log("\nF. the route's own flow, run here");

/** The real executor's shape, counting calls so "nothing ran" can be asserted rather than assumed. */
function countingExecutor(behaviour: "ok" | "throw") {
  const state = { calls: 0 };
  return {
    state,
    execute: async (sql: string) => {
      state.calls += 1;
      if (behaviour === "throw") throw new Error("SQLITE_ERROR: no such table: summary_clearance_detail");
      return { rows: db.prepare(sql).all() as unknown[], columns: [] as string[] };
    },
  };
}

async function ownedFlowChecks() {
  const refused = countingExecutor("ok");
  const outcome = await runOwnedAnnualClearance({
    question: HOUSTON, place: "Houston, TX", query: built!,
    refusal: { ruleIds: ["structural-returned-series-unresolved"] },
    execute: refused.execute,
  });
  check("a refused plan executes nothing and returns no SQL, title or figure", () => {
    assert.equal(refused.state.calls, 0, "nothing may run after a refusal");
    assert.equal(outcome.kind, "decline");
    assert.equal((outcome as { sql: string | null }).sql, null);
    assert.equal((outcome as { title: string }).title, "");
    assert.match((outcome as { explanation: string }).explanation, /not going to substitute/i);
  });

  const failing = countingExecutor("throw");
  const failed = await runOwnedAnnualClearance({
    question: HOUSTON, place: "Houston, TX", query: built!, refusal: null, execute: failing.execute,
  });
  check("an execution failure declines once and does not retry through anything", () => {
    assert.equal(failing.state.calls, 1, "exactly one attempt, no retry");
    assert.equal(failed.kind, "decline");
    assert.equal((failed as { reason: string }).reason, "execution-failed");
    assert.equal((failed as { title: string }).title, "");
    assert.match((failed as { explanation: string }).explanation, /failure on our side/i);
  });

  const good = countingExecutor("ok");
  const answered = await runOwnedAnnualClearance({
    question: HOUSTON, place: "Houston, TX", query: built!, refusal: null, execute: good.execute,
  });
  check("the useful answer comes back with its figures, period, reasons and title", () => {
    assert.equal(good.state.calls, 1);
    assert.equal(answered.kind, "answer");
    const result = answered as Extract<typeof answered, { kind: "answer" }>;
    assert.deepEqual(result.rows.map((row) => row.year), [2019, 2020, 2021, 2022, 2023, 2024, 2025]);
    const y2020 = result.rows.find((row) => row.year === 2020)!;
    assert.equal(y2020.total_offenses, 27839);
    assert.equal(y2020.cleared, 441);
    assert.equal(y2020.not_cleared, 27839 - 441);
    assert.equal(y2020.clearance_rate, 1.6);
    assert.match(result.title, /Thefts from vehicles and clearances, Houston, TX, 2019-2025/);
    assert.match(result.withheldNote, /No figure is given for 2026/);
  });

  check("the withholding reason survives the route's own disclosure step", () => {
    // THE DELIVERY FAULT THIS REPLACES: the figures' wording goes through `applyResultDisclosures`,
    // which could not see what established a statement about years not in the returned rows and
    // replaced it with a generic omission notice. The route now appends the reasons after it.
    const result = answered as Extract<typeof answered, { kind: "answer" }>;
    const disclosed = applyResultDisclosures({
      explanation: result.explanation, question: HOUSTON, sql: result.sql, rows: result.rows,
      tab: "nibrs", resultState: genericResultState({ sql: result.sql, rows: result.rows }),
    });
    const delivered = [disclosed, result.withheldNote].filter(Boolean).join("\n\n");
    assert.match(delivered, /No figure is given for 2026: the yearly and monthly records disagree/);
    assert.match(delivered, /No figure is given for 2018/);
    assert.match(delivered, /Theft from a motor vehicle/);
    const title = alignTitleYearRange(result.title, result.rows);
    assert.match(title, /2019-2025/, "the title still states the delivered years after alignment");
  });

  check("the route wires this flow rather than repeating it", () => {
    // A tripwire, not the proof: the behaviour above ran the shipped function directly.
    const source = fs.readFileSync("app/api/nibrs-query/route.ts", "utf8");
    assert.match(source, /await runOwnedAnnualClearance\(\{/);
    assert.match(source, /execute: async \(plannedSql\) => \{/);
    assert.match(source, /outcome\.withheldNote,/);
  });

  // A different agency and offence, executed rather than merely recognised.
  const other = "Dallas robbery clearance rate by year 2019 to 2020";
  const otherBuilt = buildNibrsAnnualClearanceQuery(other, planFor("TX0570000", "Dallas, TX", [2019, 2020]));
  assert.ok(otherBuilt, "a different agency and offence must build");
  const otherExec = countingExecutor("ok");
  const otherOutcome = await runOwnedAnnualClearance({
    question: other, place: "Dallas, TX", query: otherBuilt!, refusal: null, execute: otherExec.execute,
  });
  check("a different agency and offence is executed and delivered, not just recognised", () => {
    assert.equal(otherOutcome.kind, "answer");
    const result = otherOutcome as Extract<typeof otherOutcome, { kind: "answer" }>;
    assert.deepEqual(result.rows.map((row) => row.year), [2019, 2020]);
    assert.equal(result.rows.find((row) => row.year === 2019)!.total_offenses, 500);
    assert.equal(result.rows.find((row) => row.year === 2019)!.cleared, 50);
    assert.match(result.title, /Robberies and clearances, Dallas, TX, 2019-2020/);
    assert.match(result.explanation, /NIBRS offense 120/);
  });

  const nothing = countingExecutor("ok");
  const emptyQuery = buildNibrsAnnualClearanceQuery(
    "Austin robbery clearance rate by year 2019 to 2020",
    planFor("TX2270000", "Austin, TX", [2019, 2020]))!;
  const noYears = await runOwnedAnnualClearance({
    question: "Austin robbery clearance rate by year 2019 to 2020", place: "Austin, TX",
    query: emptyQuery, refusal: null, execute: nothing.execute,
  });
  check("no supportable year declines with reasons, retains its executed SQL, and returns nothing else", () => {
    assert.equal(nothing.state.calls, 1, "this branch DID run a query");
    assert.equal(noYears.kind, "decline");
    const result = noYears as Extract<typeof noYears, { kind: "decline" }>;
    assert.equal(result.reason, "no-supportable-year");
    assert.equal(result.sql, emptyQuery.sql, "the executed statement is retained honestly");
    assert.equal(result.title, "", "no confident title over nothing");
    assert.match(result.explanation, /No year in the requested range can be reported/);
    assert.match(result.explanation, /No figure is given for 2019: this source has no record/);
  });

  // Integration (Codex Gate A vocabulary ruling): an IN-RANGE withholding -- 2018 lacks its figures and 2019's
  // monthly and yearly records disagree, the fixture of "when no year is supportable" above -- declines through the
  // owned flow as `no-supportable-year`, and the route records that reason as `annual_result_not_supported`,
  // never `outside_source_years`: the years are inside the source, they just cannot be reported.
  const inRangeRows = [baseRow(2018, { total_offenses: null, cleared: null }), baseRow(2019, { monthly_offenses: 1 })];
  const inRange = await runOwnedAnnualClearance({
    question: HOUSTON, place: "Houston, TX", query: buildNibrsAnnualClearanceQuery(HOUSTON, planFor("TXHPD0000", "Houston, TX", [2018, 2019]))!,
    refusal: null, execute: async () => ({ rows: inRangeRows as unknown[], columns: [] as string[] }),
  });
  check("an in-range withholding declines as no-supportable-year, recorded as annual_result_not_supported (not outside_source_years)", () => {
    assert.equal(inRange.kind, "decline");
    assert.equal((inRange as Extract<typeof inRange, { kind: "decline" }>).reason, "no-supportable-year");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildInventory } = require("./lib/exit-inventory.js") as { buildInventory: (root: string) => { decisionSites: { route: string; outcome: { form: string; whenTrue?: string; whenFalse?: string; predicate?: string } }[] } };
    const sites = buildInventory(path.resolve(__dirname, "..")).decisionSites
      .filter((s) => s.route === "nibrs-query" && (s.outcome.predicate ?? "").includes("no-supportable-year"));
    assert.equal(sites.length, 1, "exactly one route exit records the annual family's decline");
    assert.equal(sites[0].outcome.whenTrue, "annual_result_not_supported");
    assert.notEqual(sites[0].outcome.whenTrue, "outside_source_years");
  });
}

ownedFlowChecks().then(() => {
  db.close();
  fs.unlinkSync(dbPath);
  console.log(`\nnibrs annual clearance: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
