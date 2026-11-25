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
  // Agencies whose primary county (FIPS, ordinal 1) is the county agency's: Dallas Police carries TXDPD0000, not a TX057 code.
  // TX0571600 has no name in agency-names.json: it is listed by its ORI, not dropped.
  if (/agency_fips_county/.test(sql)) return [["TX0570000"], ["TXDPD0000"], ["TX0570100"], ["TX0571600"]];
  // The agency table's city field (Jeff 2026-11-25, "by city"): the Nashville ORIs, one of them with no name on file.
  if (/upper\(city\) = 'NASHVILLE'/.test(sql)) return [["TN0190100"], ["TN0190000"], ["TN0199999"]];
  // Crime Index agencies of a state, from the build's agency_crime table: all, and the cities among them.
  if (/count\(DISTINCT ori\), count\(DISTINCT CASE WHEN type = 'city'/.test(sql)) return [[1391, 1323]];
  if (/SELECT DISTINCT ori FROM read_parquet\('\/ci\/agency_crime.parquet'\)/.test(sql)) return [["TXDPD0000"]];
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
assert.deepEqual(st.delivered.table.rows[0], ["2017", "Alaska, Wyoming"]);
assert.deepEqual(st.delivered.table.rows[1], ["2018", "None"]);
assert.equal(st.delivered.table.rows.length, 9);
// Jeff 2026-11-25: DC, Puerto Rico and the territories are not states; no line for them.
assert.ok(st.delivered.text.includes("In 2025 every one of the 50 states has reporting agencies."), st.delivered.text.join(" / "));
assert.ok(!/District|Puerto|Guam|Virgin/.test(st.delivered.text.join(" ")), st.delivered.text.join(" / "));
assert.equal(ask("which states aren't in the data in 2017?").delivered.text[0], "2017 States With No NIBRS Data");
for (const q of ["which states aren't in the data?", "why can't you tell me which states are not represented?"]) assert.equal(ask(q).shape, "states", q);

// Years covered.
const yrs = ask("what years does NIBRS cover?");
assert.deepEqual(yrs.delivered.text.slice(0, 3), ["Years Covered by the Data", "NIBRS data runs from January 2017 through September 2026.", "Crime Index counts for a place and year run from 1930 through 2025."]);
assert.equal(ask("how far back does the data go?").shape, "years");

// Sources and definitions: a pointer only; nothing is written out.
const src = ask("Where do these numbers come from?");
const SENT = "The data comes from the FBI's Uniform Crime Report NIBRS, SHR and SRS programs as well as the Crime Index";
assert.deepEqual(src.delivered.text, [SENT]);
assert.deepEqual(ask("Where does this data come from?  Is this UCR data?").delivered.text, [`Yes. ${SENT}`]);
for (const q of ["Sources?", "where is this data taken from", "What is the source of this data?"]) { assert.equal(ask(q).shape, "sources", q); assert.deepEqual(ask(q).delivered.text, [SENT], q); }
// A term with no definition on hand keeps the link to the FBI's definitions.
const def = ask("how is hate crime defined?");
assert.ok(def.delivered.text.some((t) => t.includes(DEFINITIONS_LINK)) && DEFINITIONS_LINK === "https://cde.ucr.cjis.gov/");
assert.ok(def.delivered.text.every((t) => t.length < 120), "no written definition");
for (const q of ["what is the defanition of simple assault", "SRS definition please", "What counts as violent crime here?"]) assert.equal(ask(q).shape, "definitions", q);
// FBI definitions on hand are as Jeff gave them.
assert.match(ask("what is the defanition of simple assault").delivered.text[1], /^Simple Assault: An unlawful physical attack by one person upon another/);
assert.match(ask("What is defined as violent crime").delivered.text[1], /murder and nonnegligent manslaughter, rape, robbery and aggravated assault\.$/);
{
  const txt = (q: string) => ask(q).delivered.text.join("\n");
  assert.match(ask("SRS definition please").delivered.text[1], /^SRS is the Summary Reporting System, the FBI's older summary reporting program\. It is a program, not an offense\.$/);
  for (const q of ["how is domestic violence defined in NIBRS?", "What constitutes domestic violence in nibrs?", "how is domestic violence defined?"])
    assert.match(ask(q).delivered.text[1], /^NIBRS has no domestic violence offense\..*relationship codes.*circumstance code 06, Domestic Violence\. It is not the same as Family Offenses, Nonviolent \(90F\)\.$/, q);
  assert.match(ask('what counts as "personal weapons" in weapon type').delivered.text[1], /weapon code 40: hands, fists, feet and teeth/);
  // Violent crime: no program named gives both, each labeled; SRS or Crime Index gives SRS; NIBRS gives the codes.
  assert.ok(/SRS/.test(txt("What is defined as violent crime")) && /09A/.test(txt("What is defined as violent crime")));
  assert.ok(!/09A/.test(txt("how is violent crime defined in SRS?")) && /robbery and aggravated assault/.test(txt("how is violent crime defined in SRS?")));
  assert.ok(/09A.*11A, 11B and 11C.*120.*13A/.test(txt("how is violent crime defined in NIBRS?")) && !/Summary Reporting/.test(txt("how is violent crime defined in NIBRS?")));
}
// Scope lookups come from the agency lists: Nashville, Dallas County, Pennsylvania.
const nash = ask("What is the exact agency name for Nashville in the dataset? Show me the agencies table entry.");
assert.ok(nash.delivered.table.rows.some((r) => r[0] === "TN0190100"), JSON.stringify(nash.delivered.table.rows));
assert.ok(sqls.some((s) => /upper\(city\) = 'NASHVILLE'/.test(s) && /state_abbr IN \('TN', 'TN'\)/.test(s)), "Nashville is listed by the agency table's city field, in Tennessee");
assert.equal(nash.delivered.table.rows.length, 3);
assert.deepEqual(nash.delivered.table.rows.find((r) => r[0] === "TN0199999")!.slice(0, 2), ["TN0199999", ""], "an unnamed ORI is listed by its ORI");
assert.ok(nash.delivered.text.some((t) => t.startsWith("TN0199999: no agency name")), nash.delivered.text.join(" / "));
assert.ok(nash.delivered.text[0] === "Agencies in Nashville, Tennessee" && nash.delivered.text.length === 6, nash.delivered.text.join(" / "));
// A name two cities share asks which one, as the other place questions do (Richmond, Baltimore, Kansas City); a named state does not ask.
for (const [nm, labels] of [["Richmond", ["Richmond, Virginia", "Richmond, California"]], ["Kansas City", ["Kansas City, Missouri", "Kansas City, Kansas"]]] as const) {
  const o: any = shadowAnswer(`What is the exact agency name for ${nm} in the dataset? Show me the agencies table entry.`, deps);
  assert.equal(o.kind, "clarify", nm);
  assert.deepEqual(o.options.map((x: any) => x.label), labels, nm);
  assert.equal(o.options[0].continuation.kind, "coverage", `${nm}: each button lists that state's agencies`);
}
const dal = ask("What agencies match Dallas County in Texas? Show me the agencies table entries.");
assert.ok(dal.delivered.table.rows.some((r) => r[0] === "TX0570000") && dal.delivered.table.rows.some((r) => r[0] === "TXDPD0000"), JSON.stringify(dal.delivered.table.rows).slice(0, 300));
assert.ok(dal.delivered.table.rows.some((r) => r[0] === "TX0571600" && r[1] === ""), "an unnamed ORI of the county is listed, not dropped");
assert.ok(sqls.some((s) => /agency_fips_county/.test(s)), "county membership comes from the NIBRS batch header's primary county, not only the ORI prefix");
assert.equal(dal.delivered.table.rows.find((r) => r[0] === "TXDPD0000")![4], "FBI NIBRS and Crime Index", "the Crime Index label comes from agency_crime");
const pa = ask("which cities are represented in Pennsylvania?");
assert.match(pa.delivered.text[1], /^Pennsylvania has [\d,]+ agencies in the FBI's NIBRS agency list and 1,391 with Crime Index counts; 1,323 of the agencies in the index are cities\.$/);
assert.ok(sqls.some((s) => /\/ci\/agency_crime\.parquet/.test(s) && /state IN \('PA', 'PA'\)/.test(s)), "the Crime Index count is read from the build's agency_crime table, not the fixture");

// A question about how a definition changed is not a plain definition (QL-hist-9745b45647 and QL-hist-924349745b): it keeps its old reading.
for (const q of ["any legal change of the definition of robbery or clearance rate historically", "has the definition of violent crime changed over time?", "how has rape been defined historically"])
  assert.notEqual(shadowAnswer(q, deps).kind, "coverage", q);
assert.equal(ask("how is robbery defined?").shape, "definitions");

// A follow-up about the data is answered on its own, whatever came before.
const fu = shadowFollowUp("murders in Houston in 2024", "what states are not represented?", deps);
assert.equal(fu.kind, "coverage");
// The follow-up's own question and the word "new" are labels on the turn (rewrite, rewriteKind), never part of the answer's text or table (QL-ct-4a77c4a77c, 4a77ca6569, 6fee44a77c).
for (const [fq, prev] of [["what states are not represented?", "what states are not represented?"], ["which states aren't in the data?", "what states are not represented?"], ["what states are not represented?", "which states do you have data for?"]]) {
  const r: any = shadowFollowUp(prev, fq, deps);
  assert.equal(r.kind, "coverage", fq);
  const body = JSON.stringify([r.delivered.text, r.delivered.table]).toLowerCase();
  assert.ok(!body.includes(fq.toLowerCase()) && !/\bnew\b/.test(body), `${fq}: question text or "new" in the answer`);
}

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

console.log("nibrs coverage: agencies reporting, states with no data, years, sources and definitions come from the release's agency lists or are a plain pointer");
