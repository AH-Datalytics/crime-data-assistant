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
import { answerShr, answerShrRanking, shrRankingSql, filterWords, shrBuildAt, shrQuestionOf, shrSql, stateOfOri, type ShrQuestion } from "../lib/nibrs-shadow/shr";
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
assert.deepEqual(shrQuestionOf(plan({}), { from: "2027-01", to: "2027-12" }, build), { why: "after the latest month" });
// Murders are counted by victim even when the plan counts offenses.
assert.equal((shrQuestionOf(plan({ measures: [{ id: "offenses.murder", as: "murder" }] }), { from: "2024-01", to: "2024-12" }, build) as ShrQuestion).unit, "victims");
// Relationships: SHR names the side.
const spouse = shrQuestionOf(plan({ filters: [{ kind: "exists", scope: "victim", entity: "victim_offender", where: [{ kind: "attribute", dimension: "victim_offender.relationship", op: "in", values: ["SE", "XS"] }] }] }),
  { from: "2024-01", to: "2024-12" }, build) as ShrQuestion;
assert.deepEqual(spouse.filters, [{ dim: "relationship", codes: ["HU", "WI", "XH", "XW"], group: 0 }]);
// Codex SHR-A review 01.2: only translations that keep the meaning. A grandparent alone, NIBRS "Other", or a handgun
// without its automatic code is narrower than SHR's code: NIBRS keeps it.
const rel = (values: string[]) => shrQuestionOf(plan({ filters: [{ kind: "attribute", dimension: "victim_offender.relationship", op: "in", values }] }), { from: "2024-01", to: "2024-12" }, build);
assert.deepEqual(rel(["GP"]), { why: "a code Homicide Reports record differently" });
assert.deepEqual((rel(["OF", "GP", "GC", "SS"]) as ShrQuestion).filters[0].codes, ["OF"]);
const weap = (values: string[]) => shrQuestionOf(plan({ filters: [{ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values }] }), { from: "2024-01", to: "2024-12" }, build);
assert.deepEqual(weap(["12"]), { why: "a code Homicide Reports record differently" });
assert.deepEqual(weap(["90"]), { why: "a code Homicide Reports record differently" });
assert.deepEqual((weap(["12", "12A"]) as ShrQuestion).filters[0].codes, ["12"]);
// S4: a felon killed by police is a justifiable homicide, counted as asked.
const police = shrQuestionOf(plan({ filters: [{ kind: "attribute", dimension: "victim_circumstance.circumstance", op: "in", values: ["21"] }] }), { from: "2024-01", to: "2024-12" }, build) as ShrQuestion;
assert.equal(police.measure, "justifiable");
// What SHR doesn't record the same way stays on NIBRS's path.
assert.deepEqual(shrQuestionOf(plan({ filters: [{ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values: ["35"] }] }), { from: "2024-01", to: "2024-12" }, build), { why: "a code Homicide Reports record differently" });
assert.deepEqual(shrQuestionOf(plan({ filters: [{ kind: "attribute", dimension: "offense.location_type", op: "in", values: ["20"] }] }), { from: "2024-01", to: "2024-12" }, build), { why: "a detail Homicide Reports don't record" });
assert.deepEqual(shrQuestionOf(plan({ statistics: [{ kind: "rate", as: "r", measure: "murder" }] }), { from: "2024-01", to: "2024-12" }, build), { why: "a rate or another statistic" });
assert.deepEqual(shrQuestionOf(plan({ measures: [{ id: "victims.robbery", as: "robbery" }] }), { from: "2024-01", to: "2024-12" }, build), { why: "not a homicide count" });
assert.deepEqual(shrQuestionOf(plan({ geography: { places: [{ kind: "national" }, { kind: "state", code: "TX" }], combine: "separate" } }), { from: "2024-01", to: "2024-12" }, build), { why: "several places" });
// Job SA1: "handguns versus rifles" is two conditions on a record's one weapon, which no record meets together.
const vs = (w: string[]) => ({ kind: "exists", scope: "victim", entity: "offense_weapon", where: [{ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values: w }] });
assert.deepEqual(shrQuestionOf(plan({ filters: [vs(["12", "12A"]), vs(["13", "13A"])] }), { from: "2024-01", to: "2024-12" }, build), { why: "two values of one record detail compared" });
const att = (w: string[]) => ({ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values: w });
assert.deepEqual(shrQuestionOf(plan({ filters: [att(["12", "12A"]), att(["13", "13A"])] }), { from: "2024-01", to: "2024-12" }, build), { why: "two values of one record detail compared" }, "ungrouped too (02.2)");
// P29: a breakdown by an offender's detail counts offenders, never victims.
assert.deepEqual(shrQuestionOf(plan({ groupings: [{ dimension: "offender.sex" }] }), { from: "2024-01", to: "2024-12" }, build), { why: "a person's detail for the other unit" });

// The SQL: counted records only, type A without justifiable (S4), the agency's key, the record's weapon (S5); a detail of
// the other person through EXISTS.
const sql = shrSql({ ...sq, filters: [...sq.filters, { dim: "offender.sex", codes: ["F"] }] }, build);
assert.match(sql, /WHERE r\.counted AND r\.homicide_type IN \('A'\) AND r\.circumstance NOT IN \('80', '81'\) AND r\.agency_key = 'ori9:TXHPD0000'/);
assert.match(sql, /r\.weapon IN \('11', '12', '13', '14', '15'\)/);
assert.match(sql, /EXISTS \(SELECT 1 FROM read_parquet\('[^']*shr_offender[^']*'.*o\.sex IN \('F'\)\)/);
assert.match(sql, /GROUP BY k0/);
// 01.3: one exists group's conditions are one offender's ("killed by female offenders under 18").
const both = shrSql({ ...sq, filters: [{ dim: "offender.sex", codes: ["F"], group: 0 }, { dim: "offender.age", ages: [0, 17], group: 0 }] }, build);
assert.equal((both.match(/EXISTS/g) ?? []).length, 1, both);
assert.match(both, /o\.sex IN \('F'\) AND o\.age BETWEEN 0 AND 17\)/);
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
// Jeff 2026-11-11: a filing year under 90% of the murders reported to the FBI is said, never adjusted, never as
// "Crime Index"; years at 90% or more, or above, say nothing.
const chi = { ...byYear, place: { kind: "agency" as const, ori: "ILCPD0000", label: "Chicago, Illinois", state: "IL" } };
const chiStub = (s2: string) => (/shr_agency_year/.test(s2) ? [2017, 2018, 2019, 2020, 2021].map((y) => [y, 1, ["ori9:ILCPD0000"]])
  : /murder_total IS NOT NULL/.test(s2) ? [[2017, 653], [2018, 567], [2019, 492], [2020, 700], [2021, 804]]
  : /agency_crime/.test(s2) ? [] : [[2017, 519], [2018, 566], [2019, 495], [2020, 640], [2021, 370]]);
const many = answerShr({ ...chi, from: "2017-01", to: "2021-12" }, build, chiStub, hist);
assert.ok(many.kind === "shr" && many.delivered.text.includes("Chicago's Homicide Reports cover less than 90% of the murders reported to the FBI in 2017 (79%) and 2021 (46%)."), JSON.stringify(many));
const one = answerShr({ ...chi, from: "2021-01", to: "2021-12", grain: "total" }, build, chiStub, hist);
assert.ok(one.kind === "shr" && one.delivered.text.includes("Chicago's Homicide Reports for 2021 cover 370 of the 804 murders reported to the FBI."), JSON.stringify(one));
const half = answerShr({ ...chi, from: "2021-01", to: "2021-06", grain: "total" }, build, chiStub, hist);
assert.ok(half.kind === "shr" && half.delivered.text.includes("Chicago's Homicide Reports for 2021 cover 370 of the 804 murders reported to the FBI."), "part of a short year (03.1)");
const fine = answerShr({ ...chi, from: "2018-01", to: "2019-12" }, build, chiStub, hist);
assert.ok(fine.kind === "shr" && !fine.delivered.text.some((t) => /Homicide Reports (?:for d{4} )?cover/.test(t)) && !fine.delivered.text.some((t) => /Crime Index/.test(t)));
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
// 01.1: by month, January is January's cells only (2024|1 is not 2024|10, 11 or 12).
const months = answerShr({ ...nat, breakdown: null, share: false, grain: "month" }, build, (sq2) => (/shr_agency_year/.test(sq2) ? [[2024, 10, []]]
  : /nation_crime|sum\(population\)/.test(sq2) ? [] : [[2024, 1, 2], [2024, 10, 3], [2024, 11, 4], [2024, 12, 5]]));
assert.ok(months.kind === "shr" && JSON.stringify(months.delivered.table.rows.slice(0, 2)) === '[["2024-01",2],["2024-02",0]]' && months.delivered.table.rows[9][1] === 3, JSON.stringify(months));
// 01.11: U and blank or unlisted codes are one Unknown row.
const sex = answerShr({ ...nat, breakdown: { dim: "victim.sex" } }, build, (sq2) => (/shr_agency_year/.test(sq2) ? [[2024, 10, []]] : /nation_crime|sum\(population\)/.test(sq2) ? [] : [["U", 2], [null, 3]]));
assert.ok(sex.kind === "shr" && JSON.stringify(sex.delivered.table.rows) === '[["Unknown",5,100]]', JSON.stringify(sex));
// 01.10: a filing year with no rows shows every category as 0, not an empty table.
const empty = answerShr({ ...nat, breakdown: { dim: "victim.sex" } }, build, (sq2) => (/shr_agency_year/.test(sq2) ? [[2024, 10, []]] : []));
assert.ok(empty.kind === "shr" && JSON.stringify(empty.delivered.table.rows) === '[["Male",0,null],["Female",0,null],["Unknown",0,null]]', JSON.stringify(empty));
// J1, option A, in words.
const e = answerShr({ ...nat, breakdown: null, share: false, from: "1985-01", to: "1990-12", askedFrom: "1976" }, build, (s) => (/shr_agency_year/.test(s) ? [1985, 1986, 1987, 1988, 1989, 1990].map((y) => [y, 10, []]) : [[100]]));
assert.ok(e.kind === "shr" && e.delivered.text.includes("Homicide Reports here start in 1985, so 1976 through 1984 aren't included."));
// SHR-B: the nation's cities ranked by a murder detail, from Homicide Reports. Only cities that filed in every year are
// ranked; a share needs a murder victim; a count of 0 is a real 0.
// Crime Index writes Nebraska as NB: shown as NE (the ORI table's own).
const rankRows = [["NBOPD0000", "OMAHA", "NB", 500000, true, 10, 9], ["TXHPD0000", "HOUSTON", "TX", 2300000, true, 300, 240], ["TXDPD0000", "DALLAS", "TX", 1300000, true, 100, 90], ["ILCPD0000", "CHICAGO", "IL", 2700000, false, 0, 0],
  ["NYNPD0000", "NEW YORK", "NY", 8000000, true, 50, 20], ["PAPEP0000", "PHILADELPHIA", "PA", 1500000, true, 0, 0]];
const fire = { dim: "weapon" as const, codes: ["11", "12", "13", "14", "15"] };
const rk = { measure: "murder" as const, filters: [fire], share: true, from: "2024-01", to: "2024-12", direction: "top" as const, limit: 20, minPopulation: 250000 };
const sqlSeen: string[] = [];
const ranked = answerShrRanking(rk, build, hist, (s) => { sqlSeen.push(s); return rankRows; });
assert.ok(ranked.kind === "shr", JSON.stringify(ranked));
if (ranked.kind === "shr") {
  assert.deepEqual(ranked.delivered.table.rows, [["DALLAS, TX", 90], ["OMAHA, NE", 90], ["HOUSTON, TX", 80], ["NEW YORK, NY", 40]], "Chicago filed nothing and Philadelphia has no victim: neither is ranked");
  assert.equal(ranked.delivered.text[0], "Cities of 250,000 or more with the highest share of murder victims killed with a firearm, 2024.");
  assert.equal(ranked.delivered.text[1], "Ranked: city agencies that filed Homicide Reports in 2024 and had at least one murder victim. Ties are ordered by agency name.");
  assert.ok(ranked.delivered.text.includes("Share = the city's victims with this detail out of all its murder victims in the period."));
  assert.ok(!ranked.delivered.text.some((t) => /CHICAGO|Not ranked/.test(t)), "no left-out city is named");
  assert.ok(ranked.delivered.text.some((t) => t === "Not every city reports Homicide Reports data. Cities that did not report in this period are not ranked."), JSON.stringify(ranked.delivered.text));
  assert.equal(ranked.meaning.statistic, "rank");
  assert.deepEqual(ranked.question.ranking, { direction: "top", limit: 20, minPopulation: 250000 });
}
const sqlR = shrRankingSql(rk, build, hist);
assert.match(sqlR, /year = 2024 AND \(type = 'city'/, "the floor year is the last year of the period");
assert.match(sqlR, /population >= 250000/);
assert.match(sqlR, /HAVING count\(DISTINCT data_year\) = 1/, "filed in every year");
assert.match(sqlR, /FILTER \(WHERE p\.weapon IN \('11', '12', '13', '14', '15'\)\)/, "the record's weapon is read off the joined row");
assert.match(shrRankingSql({ ...rk, from: "2020-01", to: "2024-12" }, build, hist), /HAVING count\(DISTINCT data_year\) = 5/);
assert.match(shrRankingSql({ ...rk, from: "2026-01", to: "2026-09" }, build, hist), /year = 2025 AND/, "a year past Crime Index's last takes its last year's population");
// A count: the 0 of Philadelphia is a real 0 and ranks at the bottom; the lowest first.
const counts = answerShrRanking({ ...rk, share: false, direction: "bottom", limit: 2 }, build, hist, () => rankRows);
assert.ok(counts.kind === "shr" && JSON.stringify(counts.delivered.table.rows) === '[["PHILADELPHIA, PA",0],["OMAHA, NE",9]]', JSON.stringify(counts));
// A victim's own age, by its range; offenders' details are not a city ranking's.
const teen = answerShrRanking({ ...rk, filters: [{ dim: "victim.age", ages: [13, 19] }] }, build, hist, (s) => (sqlSeen.push(s), rankRows));
assert.ok(teen.kind === "shr" && teen.delivered.text[0].includes("share of murder victims aged 13 to 19"), JSON.stringify(teen));
assert.match(sqlSeen[sqlSeen.length - 1], /FILTER \(WHERE p\.age BETWEEN 13 AND 19\)/);
assert.equal(answerShrRanking({ ...rk, filters: [{ dim: "offender.sex", codes: ["M"] }] }, build, hist, () => rankRows).kind, "shr-decline");
// Nothing filed, or no city of that size: said.
assert.equal(answerShrRanking(rk, build, hist, () => rankRows.map((r) => [...r.slice(0, 4), false, 0, 0])).kind, "shr-decline");
assert.equal(answerShrRanking(rk, build, hist, () => []).kind, "shr-decline");

// Item 2 (Jeff 2026-11-15 order): two weapons compared are two categories of one breakdown, only when the question compares.
const gunKnife = plan({ filters: [
  { kind: "exists", scope: "victim", entity: "offense_weapon", where: [{ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values: ["20"] }] },
  { kind: "exists", scope: "victim", entity: "offense_weapon", where: [{ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values: ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"] }] }],
  geography: { places: [{ kind: "national" }], combine: "separate" } });
assert.deepEqual(shrQuestionOf(gunKnife, { from: "2024-01", to: "2024-12" }, build), { why: "two values of one record detail compared" }, "no compare word: left alone");
const cmp = shrQuestionOf(gunKnife, { from: "2024-01", to: "2024-12" }, build, { compare: true }) as ShrQuestion;
assert.ok(!("why" in cmp), JSON.stringify(cmp));
assert.deepEqual(cmp.breakdown, { dim: "weapon", groups: [{ label: "Knife or cutting instrument", codes: ["20"] }, { label: "Firearm", codes: ["11", "12", "13", "14", "15"] }] });
assert.deepEqual(cmp.filters, []);
const sqlC = shrSql(cmp, build);
assert.match(sqlC, /r\.weapon IN \('20', '11', '12', '13', '14', '15'\)/, "only the compared weapons");
assert.match(sqlC, /CASE WHEN r\.weapon IN \('20'\) THEN '0' WHEN r\.weapon IN \('11', '12', '13', '14', '15'\) THEN '1' END/);
const cmpAns = answerShr(cmp, build, (s2) => (/shr_agency_year/.test(s2) ? [[2024, 10, []]] : /nation_crime|sum\(population\)/.test(s2) ? [] : [["0", 7], ["1", 9]]));
assert.ok(cmpAns.kind === "shr" && JSON.stringify(cmpAns.delivered.table.rows) === '[["Knife or cutting instrument",7],["Firearm",9]]', JSON.stringify(cmpAns));
// Two weapons that overlap, or a code Homicide Reports can't hold, stay as they were.
assert.ok("why" in (shrQuestionOf(plan({ ...gunKnife, filters: [gunKnife.filters[0], gunKnife.filters[0]] }), { from: "2024-01", to: "2024-12" }, build, { compare: true })));
// Intimate partner: spouse, common-law spouse, boyfriend or girlfriend, ex-spouse, same-sex partner; the ex-boyfriend and
// ex-girlfriend code has no Homicide Reports equal and Jeff's one sentence says so.
const partner = shrQuestionOf(plan({ geography: { places: [{ kind: "national" }], combine: "separate" }, filters: [{ kind: "exists", scope: "victim", entity: "victim_offender",
  where: [{ kind: "attribute", dimension: "victim_offender.relationship", op: "in", values: ["SE", "CS", "BG", "XS", "XR", "HR"] }] }] }), { from: "2024-01", to: "2024-12" }, build) as ShrQuestion;
assert.ok(!("why" in partner), JSON.stringify(partner));
assert.deepEqual(partner.filters[0].codes, ["HU", "WI", "CH", "CW", "BF", "GF", "XH", "XW", "HO"]);
assert.deepEqual(partner.notes, ["This data source does not record ex-boyfriend and ex-girlfriend relationships."]);
const pAns = answerShr(partner, build, (s2) => (/shr_agency_year/.test(s2) ? [[2024, 10, []]] : /nation_crime|sum\(population\)/.test(s2) ? [] : [[5]]));
assert.ok(pAns.kind === "shr" && pAns.delivered.text.includes("This data source does not record ex-boyfriend and ex-girlfriend relationships."), JSON.stringify(pAns));
// The ex-relationship code alone has nothing to count.
assert.ok("why" in shrQuestionOf(plan({ geography: { places: [{ kind: "national" }], combine: "separate" }, filters: [{ kind: "attribute", dimension: "victim_offender.relationship", op: "in", values: ["XR"] }] }), { from: "2024-01", to: "2024-12" }, build));
// No note when the question asks a spouse only.
assert.equal((shrQuestionOf(plan({ geography: { places: [{ kind: "national" }], combine: "separate" }, filters: [{ kind: "attribute", dimension: "victim_offender.relationship", op: "in", values: ["SE"] }] }), { from: "2024-01", to: "2024-12" }, build) as ShrQuestion).notes, undefined);

// Filters in words.
assert.equal(filterWords({ dim: "weapon", codes: ["11", "12", "13", "14", "15"] }), "with a firearm");
assert.equal(filterWords({ dim: "victim.sex", codes: ["F"] }), "where the victim's sex was female");

fs.rmSync(dir, { recursive: true, force: true });
console.log("nibrs shr: Homicide Reports from the canonical release; S1-S5 and J1; blanks only where no agency filed");
