/**
 * Questions about the data itself (lib/nibrs-shadow/coverage.ts): how many agencies reported, which states are not
 * represented, which years are covered, where the numbers come from, where a term is defined. Stub executor: no database.
 * Checks which questions are read as these (and which are not), the SQL that counts, the lines said, and that a figure with
 * its own reading ("how many agencies reported murders in Texas in 2024") is left alone.
 */
import assert from "node:assert/strict";
import { shadowAnswer, shadowFollowUp, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { DEFINITIONS_LINK, readCoverage } from "../lib/nibrs-shadow/coverage";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";

const sqls: string[] = [];
const execute = (sql: string): unknown[][] => {
  sqls.push(sql);
  // Agencies: [year, listed, reported any month, reported every month]
  if (/count\(r\.ori\), count\(\*\) FILTER/.test(sql)) {
    const y = /BETWEEN (\d{4}) AND (\d{4})/.exec(sql)!;
    const rows: Record<number, number[]> = { 2023: [22105, 14569, 12242], 2025: [22527, 15166, 12858], 2026: [22590, 14879, 7129] };
    return Object.entries(rows).filter(([yr]) => Number(yr) >= Number(y[1]) && Number(yr) <= Number(y[2])).map(([yr, v]) => [Number(yr), v[0], v[1], v[2]]);
  }
  // States with a reporting agency, by year: Nebraska is written NB in the FBI's agency list.
  if (/SELECT DISTINCT s\.data_year, s\.state_abbr FROM s JOIN r/.test(sql)) {
    const y = /BETWEEN (\d{4}) AND (\d{4})/.exec(sql)!;
    const all = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NB", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"];
    const rows: unknown[][] = [];
    for (let yr = Number(y[1]); yr <= Number(y[2]); yr++) for (const s of all) {
      // 2017: Alaska and Wyoming sent nothing; every other year every state sent something.
      if (yr === 2017 && (s === "AK" || s === "WY")) continue;
      rows.push([yr, s]);
    }
    return rows;
  }
  // Every state code the FBI list holds, by year (plus the territories).
  if (/SELECT DISTINCT data_year, state_abbr FROM/.test(sql)) {
    const y = /BETWEEN (\d{4}) AND (\d{4})/.exec(sql)!;
    const rows: unknown[][] = [];
    for (let yr = Number(y[1]); yr <= Number(y[2]); yr++) for (const s of ["AK", "WY", "NB", "NJ", "NC", "PR", "VI", "GM"]) rows.push([yr, s]);
    return rows;
  }
  return [];
};
const deps: ShadowDeps = {
  places: loadPlaceIndex(), release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
  target: { root: "/build", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] }, execute,
  historical: { root: "/ci", release: "ci", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 },
};
type Cov = Extract<ShadowOutcome, { kind: "coverage" }>;
const ask = (q: string): Cov => { const o = shadowAnswer(q, deps); assert.equal(o.kind, "coverage", `${q}: ${JSON.stringify(o).slice(0, 200)}`); return o as Cov; };

// Agencies reporting: any month, every month beside it (Jeff 2026-11-18).
const a23 = ask("How many agencies reported NIBRS data in 2023?");
assert.deepEqual(a23.delivered.text, ["2023 Agencies Reporting NIBRS Data, United States",
  "14,569 of the 22,105 agencies in the FBI's agency list reported at least one month in 2023.", "12,242 of them reported all 12 months.",
  "An agency reports a month when it sends crime counts or says it had none.", "Source: FBI NIBRS."]);
assert.deepEqual(a23.delivered.table.rows, [[14569, 12242, 22105]]);
assert.ok(sqls.some((s) => /status IN \('REPORTED_CRIMES', 'REPORTED_ZERO'\)/.test(s) && /agency_year/.test(s) && /agency_month_status/.test(s)), "reads the release's agency lists");
// The year that is not over says "every month so far"; a state is its own filter, Nebraska as NB too.
const a26 = ask("how many agencies reported in 2026?");
assert.ok(a26.delivered.text.includes("7,129 of them reported every month from January through September."), a26.delivered.text.join(" / "));
ask("how many agencies reported NIBRS data in Nebraska in 2025?");
assert.ok(sqls.some((s) => /state_abbr IN \('NE', 'NB'\)/.test(s)), "Nebraska is NE and NB");
assert.equal(ask("how many agencies reported NIBRS data in Texas in 2025?").delivered.text[0], "2025 Agencies Reporting NIBRS Data, Texas");
// No year named: every year, as a series.
const aAll = ask("how many agencies report in this data set?");
assert.match(aAll.delivered.text[0], /^2017 to 2026 Agencies Reporting NIBRS Data by Year, United States$/);
assert.deepEqual(aAll.delivered.table.rows.map((r) => r[0]), ["2023", "2025", "2026"]);
// A year the data do not hold is said.
assert.ok(ask("how many agencies reported NIBRS data in 2010?").delivered.text.includes("This data covers 2017 through 2026, so 2010 is not included."));

// States not represented: every year to the latest full year; Nebraska (NB) is a state with agencies, not a missing one.
const st = ask("What states are not represented?");
assert.equal(st.delivered.text[0], "States With No NIBRS Data by Year, 2017 to 2025");
assert.deepEqual(st.delivered.table.rows[0], ["2017", "Alaska, Wyoming", "Guam, Puerto Rico, U.S. Virgin Islands"]);
assert.deepEqual(st.delivered.table.rows[1], ["2018", "None", "Guam, Puerto Rico, U.S. Virgin Islands"]);
assert.equal(st.delivered.table.rows.length, 9);
assert.ok(st.delivered.text.includes("In 2025 every state and the District of Columbia has reporting agencies."), st.delivered.text.join(" / "));
assert.ok(st.delivered.text.includes("Guam, Puerto Rico and the U.S. Virgin Islands have no reporting agencies in 2025."), st.delivered.text.join(" / "));
assert.equal(ask("which states aren't in the data in 2017?").delivered.text[0], "2017 States With No NIBRS Data");
for (const q of ["which states aren't in the data?", "why can't you tell me which states are not represented?"]) assert.equal(ask(q).shape, "states", q);

// Years covered.
const yrs = ask("what years does NIBRS cover?");
assert.deepEqual(yrs.delivered.text.slice(0, 3), ["Years Covered by the Data", "NIBRS data runs from January 2017 through September 2026.", "Crime Index counts for a place and year run from 1930 through 2025."]);
assert.equal(ask("how far back does the data go?").shape, "years");

// Sources and definitions: a pointer only; nothing is written out.
const src = ask("Where do these numbers come from?");
assert.deepEqual(src.delivered.text, ["Where the Numbers Come From", "Counts and rates for a place and year, 1930 to 2025, come from Crime Index.",
  "Victims, offenders, weapons, arrests and clearances by month, January 2017 to September 2026, come from the FBI's NIBRS.",
  "Homicide Reports come from the FBI's Supplementary Homicide Reports.", "Hate crimes come from FBI Hate Crime Statistics.", "Each answer ends with a Source line naming the one it used."]);
for (const q of ["Sources?", "where is this data taken from", "What is the source of this data?"]) assert.equal(ask(q).shape, "sources", q);
const def = ask("how is domestic violence defined?");
assert.ok(def.delivered.text.some((t) => t.includes(DEFINITIONS_LINK)) && DEFINITIONS_LINK === "https://cde.ucr.cjis.gov/");
assert.ok(def.delivered.text.every((t) => t.length < 120), "no written definition");
for (const q of ["what is the defanition of simple assault", "SRS definition please", "What counts as violent crime here?"]) assert.equal(ask(q).shape, "definitions", q);

// A question about how a definition changed is not a plain definition (QL-hist-9745b45647 and QL-hist-924349745b): it keeps its old reading.
for (const q of ["any legal change of the definition of robbery or clearance rate historically", "has the definition of violent crime changed over time?", "how has rape been defined historically"])
  assert.notEqual(shadowAnswer(q, deps).kind, "coverage", q);
assert.equal(ask("how is robbery defined?").shape, "definitions");

// A follow-up about the data is answered on its own, whatever came before.
const fu = shadowFollowUp("murders in Houston in 2024", "what states are not represented?", deps);
assert.equal(fu.kind, "coverage");

// What is not these: a figure with its own reading, a definition asked beside a figure, and plain questions.
const notCoverage = (q: string, p = false, m = false) => assert.equal(readCoverage(q, m, p), null, q);
notCoverage("how many agencies reported murders in Texas in 2024", false, true);
notCoverage("how many agencies reported in Houston", true, false);
notCoverage("What counts as violent crime here? Can you show this as a per capita rate", false, false);
notCoverage("How is domestic violence defined in Houston?", true, false);
notCoverage("murders in Texas in 2024");
notCoverage("which states have the most murders in 2024");
assert.notEqual(shadowAnswer("how many murders in Colorado in 2022", deps).kind, "coverage");
assert.notEqual(shadowAnswer("how many agencies reported murders in Texas in 2024", deps).kind, "coverage");

// Scope questions (G2): fixed statements, no query behind them.
const SHOOT = "We don't track non-fatal shootings. You can choose firearm murders or aggravated assault involving a firearm (NIBRS).";
for (const q of ["do you track shootings?", "do you have shootings data", "do we have any dataset that can do shootings"])
  assert.deepEqual(ask(q).delivered.text, ["Shootings Data", SHOOT, "Source: FBI NIBRS."], q);
assert.deepEqual(ask("which country do you cover").delivered.text, ["Where the Data Covers", "The data covers the United States.", "Source: FBI NIBRS."]);
for (const q of ["Do you have any data for NYC?", "is there data specific to new jersey?"])
  assert.equal(ask(q).delivered.text[0], "Data for a Place", q);
const nq = sqls.length; ask("do you have shootings data"); assert.equal(sqls.length, nq, "scope answers run no query");
notCoverage("do you have shootings data in Texas in 2024", true, true);
notCoverage("do you have murders data for Chicago", true, true);
notCoverage("do you have data for Chicago in 2023", true, false);
notCoverage("Do you have data on arrests?");
notCoverage("Do you have data on Marijuana arrests?");

console.log("nibrs coverage: agencies reporting, states with no data, years, sources and definitions come from the release's agency lists or are a plain pointer");
