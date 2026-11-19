/**
 * Current Trends in the new engine (design note 2026-11-03; P90, P91; Jeff's decisions A-C): agency months, consistent
 * group sums, and cumulative totals that are never shown complete over unknown months. Offline: a stub executor stands
 * in for DuckDB over the build (scripts/build-crimeindex.py). With the build present (CURRENT_BUILD, default the local
 * crimeindex-20261101-ct), nibrs-model's V173 and the design note's examples are checked against it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { agencyMonths, agencyMonthPopulations, agencyPopulation, answerCurrent, answerCurrentSeveral, answerCurrentChange, change, groupRateBase, cumulative, currentBuildAt, currentRate, groupMonths, months, REGIONS, rollingMonths, ytdMonths, yearEarlier, type CurrentBuild } from "../lib/nibrs-shadow/current";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";

// Months and periods.
assert.deepEqual(months("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
assert.deepEqual(ytdMonths("2026-03"), ["2026-01", "2026-02", "2026-03"]);
assert.deepEqual(rollingMonths("2026-08"), months("2025-09", "2026-08"));
assert.deepEqual(rollingMonths("2025-12"), months("2025-01", "2025-12"));
assert.equal(yearEarlier("2026-08"), "2025-08");

// A cumulative total is blank when any month in it is unknown, and names those months (design note, section 3).
assert.deepEqual(cumulative([37, null, 16], ["2025-01", "2025-02", "2025-03"]), { value: null, missing: ["2025-02"] });
assert.deepEqual(cumulative([37, 0, 16], ["2025-01", "2025-02", "2025-03"]), { value: 53, missing: [] }, "a known zero is a month");
// Change: from two complete values; no change from an unknown side or a zero base (P55).
assert.equal(change(484, 524), 8.3);
assert.equal(change(null, 524), null);
assert.equal(change(0, 5), null);
// Decision B (P58, P59): never one month, never an unknown count or a missing or zero population.
assert.equal(currentRate(524, 100000, 8), 524);
assert.equal(currentRate(88, 100000, 1), 88, "P96 (Jeff 2026-11-06): one month has a rate too");
assert.equal(currentRate(88, 100000, 0), null);
// P96: a month's rate uses its own population: current_crime's row from Current Trends' first month, the same year's
// published population before it; never another month's or year's (Codex monthly-rates review 01.1).
{
  const fake = (sql: string): unknown[][] => (sql.includes("max(year)") ? [[2025]] : sql.includes("current_crime") ? [["2025-05", 2_000_000]] : [[2024, 1_900_000], [2025, 1_950_000]]);
  const pops = agencyMonthPopulations({ root: "/ci", release: "r", firstMonth: "2025-01", lastMonth: "2026-08", finalFirstMonth: "2017-01" }, "X", ["2023-06", "2024-03", "2025-05", "2025-06"], fake);
  assert.deepEqual([...pops.values()], [null, 1_900_000, 2_000_000, null]);
}
// The current year's months with no population of their own take the latest completed year's (Jeff 2026-11-14); a past
// month without one keeps no rate (P96); the year after the current one does not carry.
{
  const fake = (sql: string): unknown[][] => (sql.includes("max(year)") ? [[2025]] : sql.includes("current_crime") ? [["2025-05", 2_000_000]] : [[2024, 1_900_000], [2025, 1_950_000]]);
  const bld = { root: "/ci", release: "r", firstMonth: "2025-01", lastMonth: "2026-08", finalFirstMonth: "2017-01" };
  const pops = agencyMonthPopulations(bld, "X", ["2025-05", "2025-06", "2026-03", "2027-01"], fake);
  assert.deepEqual([...pops.values()], [2_000_000, null, 1_950_000, null]);
  // The boundary is the build's latest completed year, not the agency's own latest year: an agency whose last
  // population is 2024 does not get 2025 months (P96), nor 2026 ones (Codex population review 01.1).
  const old = (sql: string): unknown[][] => (sql.includes("max(year)") ? [[2025]] : sql.includes("current_crime") ? [] : [[2024, 100_000]]);
  assert.deepEqual([...agencyMonthPopulations(bld, "X", ["2025-06", "2026-03"], old).values()], [null, null]);
  // A total, year-to-date or rolling rate takes the same carried denominator as the months (Codex 01.2).
  const own = (sql: string): unknown[][] => (sql.includes("max(year)") ? [[2025]] : sql.includes("current_crime") ? [] : [[100_000]]);
  assert.equal(agencyPopulation(bld, "X", "2026-02", own), 100_000);
  assert.equal(agencyPopulation(bld, "X", "2027-02", own), null, "2027 does not carry");
  assert.equal(agencyPopulation(bld, "X", "2025-11", own), null, "a past month does not carry");
}
assert.equal(currentRate(null, 100000, 8), null);
assert.equal(currentRate(5, 0, 8), null);
assert.deepEqual(REGIONS.noe.states.length + REGIONS.mdw.states.length + REGIONS.sth.states.length + REGIONS.wst.states.length, 51, "the 50 states and DC");

// The reads, with a stub executor: an agency's months come from current_crime from its first month and from the Final
// panel before it (decision A); a month with no row stays unknown.
const b: CurrentBuild = { root: "/ci", release: "crimeindex-20261101", firstMonth: "2025-01", lastMonth: "2026-08", finalFirstMonth: "2017-01" };
const sqls: string[] = [];
const stub = (rows: unknown[][]) => (sql: string) => (sqls.push(sql), rows);
const a = agencyMonths(b, "TNMPD0000", "property_crime", "2024-11", "2025-02", stub([["2024-11", 900], ["2025-01", 950], ["2025-02", null]]));
assert.deepEqual([...a], [["2024-11", 900], ["2024-12", null], ["2025-01", 950], ["2025-02", null]]);
assert.ok(sqls[0].includes("current_crime.parquet") && sqls[0].includes("current_final.parquet") && sqls[0].includes("< '2025-01'"));
assert.ok(sqls[0].includes("burglary_total IS NULL OR theft_total IS NULL OR motor_total IS NULL"), "the Final panel's property is its parts, blank when any is");
// A group: the month's sample agencies only (P91), blanks counted.
const g = groupMonths(b, ["TN"], "rape", "2026-08", "2026-08", stub([["2026-08", 120, 18, 2500000, 1]]));
assert.deepEqual(g.get("2026-08"), { value: 120, agencies: 18, population: 2500000, blank: 1 });
assert.ok(sqls[1].includes("WHERE sample AND state IN ('TN')"));

// answerCurrent with a stub: a group before 2025 is the agencies with a figure in every month of the span (P155, Jeff 2026-11-19); none: declined;
// a rate before 2025 is declined; a cumulative total needs every month.
const nation = { kind: "group" as const, states: null, label: "The United States" };
const early = answerCurrent({ measure: "murder", place: nation, from: "2024-01", to: "2024-06", form: "months" }, b, stub([]));
assert.equal(early.kind, "current-decline");
assert.match((early as { explanation: string }).explanation, /^No agency has a figure in every month from January 2024 through June 2024, so there is no total to give\.$/);
const earlyRate = answerCurrent({ measure: "murder", place: nation, from: "2024-01", to: "2024-06", form: "months", statistic: "rate" }, b, stub([]));
assert.equal(earlyRate.kind, "current-decline");
assert.match((earlyRate as { explanation: string }).explanation, /^A rate for a state or the nation is given from January 2025, the first month of the published Consistent Reporting Agencies, not before it\.$/);
const ytdOut = answerCurrent({ measure: "murder", place: nation, from: "2024-12", to: "2025-02", form: "rolling" }, b, stub([]));
assert.equal(ytdOut.kind, "current-decline", "a rolling 12 reaching before the group's first month with no agency complete over it is never the part held");

// The same agencies left out every month is said once (redesign test, 2026-11-04).
{
  const g = answerCurrent({ measure: "rape", place: nation, from: "2026-01", to: "2026-03", form: "months" }, b,
    stub(["2026-01", "2026-02", "2026-03"].map((m) => [m, 3000, 547, 111272916, 5])));
  assert.ok(g.kind === "current" && g.delivered.text.includes("Agencies with no rape figure are left out of the total: 5 of 547 in every month."), JSON.stringify(g));
}

// Against the build, when it is here.
const root = process.env.CURRENT_BUILD ?? "C:/Users/jeffm/crimeindex-build/crimeindex-20261101-ct";
const python = process.env.NIBRS_SHADOW_PYTHON ?? "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe";
if (fs.existsSync(`${root}/current_crime.parquet`) && fs.existsSync(python)) {
  const execute = duckdbExecutor(python);
  const build = currentBuildAt(root, execute)!;
  assert.deepEqual([build.firstMonth, build.lastMonth, build.finalFirstMonth], ["2025-01", "2026-08", "2017-01"]);
  // nibrs-model V173 (the nation, 2026-08): 547 agencies, murder 501, rape 3,625 with 14 agencies blank.
  assert.deepEqual(groupMonths(build, null, "murder", "2026-08", "2026-08", execute).get("2026-08"), { value: 501, agencies: 547, population: 111272916, blank: 0 });
  assert.deepEqual(groupMonths(build, null, "rape", "2026-08", "2026-08", execute).get("2026-08")?.blank, 14);
  // V174 (the Northeast): 47 agencies, murder 65.
  const ne = groupMonths(build, REGIONS.noe.states, "murder", "2026-08", "2026-08", execute).get("2026-08")!;
  assert.deepEqual([ne.agencies, ne.value], [47, 65]);
  // The design note's MO0922400: January-March 2025 property 37, blank, 16; the published year to date says 53.
  const mo = agencyMonths(build, "MO0922400", "property_crime", "2025-01", "2025-03", execute);
  assert.deepEqual([...mo.values()], [37, null, 16]);
  assert.equal(cumulative([...mo.values()], [...mo.keys()]).value, null);
  // Decision A: Memphis's 2018 months come from the Final panel.
  assert.ok((agencyMonths(build, "TNMPD0000", "murder", "2018-01", "2018-03", execute).get("2018-01") ?? -1) > 0);
  // The nation's rape total names the agencies left out (V173: 14 of 547).
  const r = answerCurrent({ measure: "rape", place: nation, from: "2026-08", to: "2026-08", form: "months" }, build, execute);
  assert.equal(r.kind, "current");
  if (r.kind === "current") {
    assert.deepEqual(r.delivered.table.rows, [["2026-08", 3625]]);
    assert.ok(r.delivered.text.includes("Agencies with no rape figure are left out of the total: August 2026 (14 of 547)."));
    assert.equal(r.delivered.text.at(-1), "Source: Crime Index.");
  }
  // MO0922400's March 2025 year to date: February is unknown, so no total (the published 53 is never shown).
  const mo2 = answerCurrent({ measure: "property_crime", place: { kind: "agency", ori: "MO0922400", label: "MO0922400", name: "x", state: "MO" }, from: "2025-03", to: "2025-03", form: "ytd" }, build, execute);
  assert.equal(mo2.kind, "current-decline");
  assert.match((mo2 as { explanation: string }).explanation, /in February 2025, so there is no total for the year to date \(January 2025 through March 2025\)\.$/);
  // Memphis by month across the Final panel and current_crime.
  const mem = answerCurrent({ measure: "murder", place: { kind: "agency", ori: "TNMPD0000", label: "Memphis, Tennessee", name: "Memphis", state: "TN" }, from: "2024-11", to: "2025-02", form: "months" }, build, execute);
  assert.ok(mem.kind === "current" && mem.delivered.table.rows.length === 4 && mem.read.tables.join() === "current_final,current_crime");
  // Codex review 01.1: a group's rate counts only its agencies with every month known, over their own population.
  const rb = groupRateBase(build, null, "rape", "2026-01", "2026-08", execute)!;
  assert.deepEqual([rb.count, rb.population], [29434, 105035976]);
  const rr = answerCurrent({ measure: "rape", place: nation, from: "2026-01", to: "2026-08", form: "ytd", statistic: "rate" }, build, execute);
  assert.ok(rr.kind === "current" && rr.delivered.table.rows[0][0] === 28);
  // Codex review 01.4: two spans compared, each a complete total (Memphis murders, January-August: 146 against 99).
  const memphis = { kind: "agency" as const, ori: "TNMPD0000", label: "Memphis, Tennessee", name: "Memphis", state: "TN" };
  const ch = answerCurrentChange({ measure: "murder", place: memphis, from: "2026-01", to: "2026-08", form: "total" }, ["2025-01", "2025-08"], ["2026-01", "2026-08"], build, execute);
  assert.ok(ch.kind === "current" && JSON.stringify(ch.delivered.table.rows) === "[[146,99,-47,-32.2]]");
  console.log("nibrs current: checked against the build", build.release);
}
// Several named agencies by month (Jeff 2026-11-15): one table from Current Trends, a row for each agency and month; an
// agency with no figure for a month is blank there, never 0, with its own line; months outside the data are said.
{
  const two = (sql: string): unknown[][] => (sql.includes("'TXDPD0000'") ? [["2025-01", 7], ["2025-02", 8], ["2025-03", 9]] : sql.includes("'LANPD0000'") ? [["2025-01", null], ["2025-02", null], ["2025-03", null]] : []);
  const dallas = { kind: "agency" as const, ori: "TXDPD0000", label: "Dallas, Texas", name: "Dallas", state: "TX" };
  const nola = { kind: "agency" as const, ori: "LANPD0000", label: "New Orleans, Louisiana", name: "New Orleans", state: "LA" };
  const sev = answerCurrentSeveral({ measure: "motor_vehicle_theft", places: [dallas, nola], from: "2025-01", to: "2025-03" }, b, two);
  assert.ok(sev.kind === "current", JSON.stringify(sev));
  if (sev.kind === "current") {
    assert.deepEqual(sev.delivered.table.columns.map((c) => c.header), ["Place", "Month", "Motor vehicle thefts"]);
    assert.deepEqual(sev.delivered.table.rows, [["Dallas", "2025-01", 7], ["Dallas", "2025-02", 8], ["Dallas", "2025-03", 9], ["New Orleans", "2025-01", null], ["New Orleans", "2025-02", null], ["New Orleans", "2025-03", null]]);
    assert.equal(sev.delivered.text[0], "January 2025 to March 2025 Motor Vehicle Thefts by Month, Dallas, Texas and New Orleans, Louisiana");
    assert.ok(sev.delivered.text.includes("No figure is available for January 2025, February 2025, March 2025 for New Orleans, Louisiana: shown blank, not zero."), JSON.stringify(sev.delivered.text));
    assert.ok(!sev.delivered.text.some((t) => /Dallas, Texas: shown blank/.test(t)));
    assert.equal(sev.delivered.text[sev.delivered.text.length - 1], "Source: Crime Index.");
    assert.equal(sev.question.agencies?.length, 1, "the first is the place, the rest the agencies");
  }
  // Months past the data are outside it; the whole span past it declines.
  const out = answerCurrentSeveral({ measure: "murder", places: [dallas, nola], from: "2026-07", to: "2026-10" }, b, two);
  assert.ok(out.kind === "current" && out.delivered.text.some((t) => /September 2026 through October 2026 are outside them/.test(t)), JSON.stringify(out));
  assert.equal(answerCurrentSeveral({ measure: "murder", places: [dallas, nola], from: "2026-09", to: "2026-10" }, b, two).kind, "current-decline");
}
// Several named agencies by month as a rate (P144, Jeff 2026-11-18): a row for each place and month, no notes beyond the exceptions; a place
// with no population is left out with a sentence; no place with one declines; a sixth place asks to name fewer.
{
  const dallas = { kind: "agency" as const, ori: "TXDPD0000", label: "Dallas, Texas", name: "Dallas", state: "TX" };
  const nola = { kind: "agency" as const, ori: "LANPD0000", label: "New Orleans, Louisiana", name: "New Orleans", state: "LA" };
  const rows = (sql: string): unknown[][] => {
    const pop = /population/.test(sql) && /FROM read_parquet/.test(sql) && !/AS n\b/.test(sql) && /population > 0/.test(sql);
    if (pop) return sql.includes("'TXDPD0000'") ? (/current_crime/.test(sql) ? [["2025-01", 600000], ["2025-02", 600000], ["2025-03", 600000]] : [[2025, 600000], [2024, 600000]]) : [];
    return sql.includes("'TXDPD0000'") ? [["2025-01", 6], ["2025-02", 12], ["2025-03", 18]] : sql.includes("'LANPD0000'") ? [["2025-01", 3], ["2025-02", 3], ["2025-03", 3]] : [];
  };
  const both = answerCurrentSeveral({ measure: "murder", statistic: "rate", places: [dallas, nola], from: "2025-01", to: "2025-03" }, b, rows);
  assert.ok(both.kind === "current", JSON.stringify(both));
  if (both.kind === "current") {
    assert.deepEqual(both.delivered.table.columns.map((c) => c.header), ["Place", "Month", "Murder rate per 100,000"]);
    assert.deepEqual(both.delivered.table.rows, [["Dallas", "2025-01", 1], ["Dallas", "2025-02", 2], ["Dallas", "2025-03", 3]]);
    assert.deepEqual(both.delivered.text, ["January 2025 to March 2025 Murder Rate by Month, Dallas, Texas", "Crime Index has no population for New Orleans, Louisiana, so no rate is given for it.", "Source: Crime Index."]);
    assert.equal(both.question.statistic, "rate");
  }
  assert.equal(answerCurrentSeveral({ measure: "murder", statistic: "rate", places: [nola, nola], from: "2025-01", to: "2025-03" }, b, rows).kind, "current-decline", "no place has a population");
  const six = answerCurrentSeveral({ measure: "murder", statistic: "rate", places: [dallas, dallas, dallas, dallas, dallas, dallas], from: "2025-01", to: "2025-03" }, b, rows);
  assert.ok(six.kind === "current-decline" && /Name up to 5 places/.test(six.explanation), JSON.stringify(six));
}
console.log("nibrs current: agency months, consistent group sums, cumulative totals never complete over unknown months");
