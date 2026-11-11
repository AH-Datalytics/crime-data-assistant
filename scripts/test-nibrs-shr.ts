/**
 * Homicide Reports in the new engine (shr.ts; Jeff's decisions S1-S5 and J1, 2026-11-11): the release's manifest key,
 * NIBRS plan -> SHR question, the SQL's counting rules, blanks vs proper zeros, coverage, and the words. Offline: a stub
 * executor stands in for DuckDB over the canonical SHR release.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NibrsPlan } from "../lib/nibrs-plan/plan";
import { answerShr, filterWords, shrBuildAt, shrQuestionOf, shrSql, stateOfOri, type ShrQuestion } from "../lib/nibrs-shadow/shr";
import type { HistoricalBuild } from "../lib/nibrs-shadow/historical";

// The manifest's "shr" key, checked strictly; no manifest, no build.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shr-"));
assert.equal(shrBuildAt(undefined), undefined);
assert.equal(shrBuildAt(dir), undefined);
const key = { release_id: "shr-20261111-1", latest_month: "2026-09", cde_update_date: "2026-10-15", crosswalk_release: "cw-20261102-2", source_count: 53 };
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ shr: key }));
const build = shrBuildAt(dir)!;
assert.deepEqual({ release: build.release, latestMonth: build.latestMonth, crosswalk: build.crosswalk }, { release: "shr-20261111-1", latestMonth: "2026-09", crosswalk: "cw-20261102-2" });
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ shr: { ...key, source_count: 52 } }));
assert.throws(() => shrBuildAt(dir), /source_count 53/);
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ other: 1 }));
assert.throws(() => shrBuildAt(dir), /"shr" key/);
assert.equal(stateOfOri("NB0280000"), "NE");
assert.equal(stateOfOri("TXHPD0000"), "TX");

// NIBRS plan -> SHR question.
const plan = (over: Partial<Record<string, unknown>>): NibrsPlan => ({
  measures: [{ id: "victims.murder", as: "murder" }], statistics: [{ kind: "count", as: "murder_count", measure: "murder" }], transforms: [],
  geography: { places: [{ kind: "agency", ori: "TXHPD0000", label: "Houston, Texas" }], combine: "separate" }, groupings: [], filters: [], ...over,
} as unknown as NibrsPlan);
const firearm = { kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values: ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"] };
const sq = shrQuestionOf(plan({ filters: [firearm], groupings: [{ dimension: "time.year" }] }), { from: "2015-01", to: "2026-12" }, build) as ShrQuestion;
assert.ok(!("why" in sq), JSON.stringify(sq));
assert.deepEqual(sq.filters, [{ dim: "weapon", codes: ["11", "12", "13", "14", "15"] }], "NIBRS's automatic-firearm codes are SHR's firearm codes");
assert.equal(sq.to, "2026-09", "cut to the release's latest month");
assert.equal(sq.grain, "year");
assert.equal(sq.askedFrom, undefined);
// J1, option A: a span starting before 1985 is answered from 1985 and remembers what was asked.
const early = shrQuestionOf(plan({ filters: [firearm] }), { from: "1976-01", to: "2000-12" }, build) as ShrQuestion;
assert.equal(early.from, "1985-01");
assert.equal(early.askedFrom, "1976");
assert.deepEqual(shrQuestionOf(plan({}), { from: "1970-01", to: "1984-12" }, build), { why: "before 1985" });
// Murders are counted by victim even when the plan counts offenses.
assert.equal((shrQuestionOf(plan({ measures: [{ id: "offenses.murder", as: "murder" }] }), { from: "2024-01", to: "2024-12" }, build) as ShrQuestion).unit, "victims");
// Relationships: SHR names the side.
const spouse = shrQuestionOf(plan({ filters: [{ kind: "exists", scope: "victim", entity: "victim_offender", where: [{ kind: "attribute", dimension: "victim_offender.relationship", op: "in", values: ["SE", "XS"] }] }] }),
  { from: "2024-01", to: "2024-12" }, build) as ShrQuestion;
assert.deepEqual(spouse.filters, [{ dim: "relationship", codes: ["HU", "WI", "XH", "XW"] }]);
// S4: a felon killed by police is a justifiable homicide, counted as asked.
const police = shrQuestionOf(plan({ filters: [{ kind: "attribute", dimension: "victim_circumstance.circumstance", op: "in", values: ["21"] }] }), { from: "2024-01", to: "2024-12" }, build) as ShrQuestion;
assert.equal(police.measure, "justifiable");
// What SHR doesn't record the same way stays on NIBRS's path.
assert.deepEqual(shrQuestionOf(plan({ filters: [{ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values: ["35"] }] }), { from: "2024-01", to: "2024-12" }, build), { why: "a code SHR records differently" });
assert.deepEqual(shrQuestionOf(plan({ filters: [{ kind: "attribute", dimension: "offense.location_type", op: "in", values: ["20"] }] }), { from: "2024-01", to: "2024-12" }, build), { why: "a detail SHR doesn't record" });
assert.deepEqual(shrQuestionOf(plan({ statistics: [{ kind: "rate", as: "r", measure: "murder" }] }), { from: "2024-01", to: "2024-12" }, build), { why: "a rate or another statistic" });
assert.deepEqual(shrQuestionOf(plan({ measures: [{ id: "victims.robbery", as: "robbery" }] }), { from: "2024-01", to: "2024-12" }, build), { why: "not a homicide count" });
assert.deepEqual(shrQuestionOf(plan({ geography: { places: [{ kind: "national" }, { kind: "state", code: "TX" }], combine: "separate" } }), { from: "2024-01", to: "2024-12" }, build), { why: "several places" });
// P29: a breakdown by an offender's detail counts offenders, never victims.
assert.deepEqual(shrQuestionOf(plan({ groupings: [{ dimension: "offender.sex" }] }), { from: "2024-01", to: "2024-12" }, build), { why: "a person's detail for the other unit" });

// The SQL: counted records only, type A without justifiable (S4), the agency's key, the record's weapon (S5); a detail of
// the other person through EXISTS.
const sql = shrSql({ ...sq, filters: [...sq.filters, { dim: "offender.sex", codes: ["F"] }] }, build);
assert.match(sql, /WHERE r\.counted AND r\.homicide_type IN \('A'\) AND r\.circumstance NOT IN \('80', '81'\) AND r\.agency_key = 'ori9:TXHPD0000'/);
assert.match(sql, /r\.weapon IN \('11', '12', '13', '14', '15'\)/);
assert.match(sql, /EXISTS \(SELECT 1 FROM read_parquet\('[^']*shr_offender[^']*'.*o\.sex IN \('F'\)\)/);
assert.match(sql, /GROUP BY k0/);
assert.match(shrSql({ ...sq, measure: "homicide" }, build), /homicide_type IN \('A', 'B'\)/, "homicides add negligent manslaughter (S4)");
assert.match(shrSql(police, build), /r\.homicide_type = 'A' AND r\.circumstance IN \('80', '81'\)/);

// S3: an agency by year. Filed 2016 and 2018; Crime Index has 0 murders in 2017 (a proper 0); 2019 no filing (blank).
const hist = { root: "/ci", release: "crimeindex-test", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1964 } as HistoricalBuild;
const seen: string[] = [];
const stub = (rows: (s: string) => unknown[][]) => (s: string) => { seen.push(s); return rows(s); };
const byYear: ShrQuestion = { ...sq, from: "2016-01", to: "2019-12", filters: [] };
const a = answerShr(byYear, build, stub((s) => (/shr_agency_year/.test(s) ? [[2016, 1, ["ori9:TXHPD0000"]], [2018, 1, ["ori9:TXHPD0000"]]]
  : /agency_crime/.test(s) ? [[2017]] : [[2016, 5], [2018, 3]])), hist);
assert.ok(a.kind === "shr", JSON.stringify(a));
if (a.kind === "shr") {
  assert.deepEqual(a.delivered.table.rows, [["2016", 5], ["2017", 0], ["2018", 3], ["2019", null]]);
  assert.ok(a.delivered.text.includes("A blank year is one in which Houston, Texas filed no Homicide Reports."), JSON.stringify(a.delivered.text));
  assert.ok(a.delivered.text.some((t) => /justifiable homicides .* are left out/.test(t)));
  assert.ok(!a.delivered.text.some((t) => /first offender's/.test(t)), "no weapon, relationship or circumstance asked");
  assert.equal(a.delivered.text[a.delivered.text.length - 1], "Source: FBI Supplementary Homicide Reports.");
}
assert.ok(seen.some((s) => /agency_crime\.parquet'\) WHERE ori = 'TXHPD0000' AND murder_total = 0 AND year IN \(2017, 2019\)/.test(s)));
// A total over a gap is blank.
const total = answerShr({ ...byYear, grain: "total" }, build, (s) => (/shr_agency_year/.test(s) ? [[2016, 1, []]] : /agency_crime/.test(s) ? [] : [[8]]), hist);
assert.ok(total.kind === "shr" && total.delivered.table.rows[0][0] === null);
// No filing at all: said, not a table of blanks.
const none = answerShr(byYear, build, () => [], hist);
assert.ok(none.kind === "shr-decline" && /filed no Homicide Reports/.test(none.explanation));

// A national breakdown by weapon with shares (S2, S5): SHR's codes in its order; blank and codes outside its lists are
// Unknown; each year's filing agencies and covered share.
const nat: ShrQuestion = { measure: "murder", unit: "victims", place: { kind: "national" }, from: "2024-01", to: "2024-12", grain: "total", filters: [], breakdown: { dim: "weapon" }, share: true };
const n = answerShr(nat, build, (s) => (/shr_agency_year/.test(s) ? [[2024, 15000, ["ori9:A", "ori9:B"]]]
  : /nation_crime/.test(s) ? [[2024, 1000]] : /sum\(population\)/.test(s) ? [[875]] : [["12", 60], ["20", 30], [null, 6], ["35", 4]]), hist);
assert.ok(n.kind === "shr", JSON.stringify(n));
if (n.kind === "shr") {
  assert.deepEqual(n.delivered.table.rows, [["Handgun", 60, 60], ["Knife or cutting instrument", 30, 30], ["Unknown", 10, 10]]);
  assert.ok(n.delivered.text.includes("2024: 15,000 agencies filed, covering 87.5% of the population Crime Index lists for the United States."), JSON.stringify(n.delivered.text));
  assert.ok(n.delivered.text.some((t) => /nothing is estimated/.test(t)));
  assert.ok(n.delivered.text.some((t) => /first offender's, counted for each of the incident's victims/.test(t)));
}
// J1, option A, in words.
const e = answerShr({ ...nat, breakdown: null, share: false, from: "1985-01", to: "1990-12", askedFrom: "1976" }, build, (s) => (/shr_agency_year/.test(s) ? [1985, 1986, 1987, 1988, 1989, 1990].map((y) => [y, 10, []]) : [[100]]));
assert.ok(e.kind === "shr" && e.delivered.text.includes("Homicide Reports here start in 1985, so 1976 through 1984 aren't included."));
// Filters in words.
assert.equal(filterWords({ dim: "weapon", codes: ["11", "12", "13", "14", "15"] }), "with a firearm");
assert.equal(filterWords({ dim: "victim.sex", codes: ["F"] }), "where the victim's sex was female");

fs.rmSync(dir, { recursive: true, force: true });
console.log("nibrs shr: Homicide Reports from the canonical release; S1-S5 and J1; blanks only where no agency filed");
