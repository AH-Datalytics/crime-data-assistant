/**
 * Historical in the new engine (P75-P79): agencies' Part I figures from the Crime Index build, read as published.
 * Offline: a stub executor stands in for DuckDB over the build (scripts/build-crimeindex.py), and its SQL is checked.
 */
import assert from "node:assert/strict";
import { answerBeside, answerHistorical, answerHistoricalRanking, answerHistoricalSet, historicalRate, historicalUnitFits, type HistoricalBuild, type HistoricalQuestion } from "../lib/nibrs-shadow/historical";
import { readQuestion } from "../lib/nibrs-shadow/reading";
import { SRS_SOURCE } from "../lib/nibrs-shadow/deliver";
import { shadowAnswer, shadowFollowUp, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { standsAlone } from "../lib/nibrs-shadow/follow-up";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";

const build: HistoricalBuild = { root: "/ci", release: "crimeindex-20261101", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 };
// Memphis 2022-2023 as published (crimeindex.org page API, 2026-11-01: 2023 violent 16,091, population 616,061, rate 2,611.9);
// 2021's murder count is blank in this stub (not available, not zero); Dallas has 2023 only.
const CRIME: Record<string, Record<number, [number | null, number | null, number | null]>> = {
  TNMPD0000: { 2021: [null, null, 628127], 2022: [252, 40.3, 624944], 2023: [351, 57.0, 616061] },
  TXDPD0000: { 2023: [246, 18.7, 1302868] },
  TX0200000: { 1960: [10, null, 41843] },
  // A Tennessee agency with no 2023 population (item 11b: listed last, blank).
  TN9999900: { 2023: [5, null, null] },
  // Nebraska's ORIs start "NB" (Codex population review 02.1); IL0740400 has no name in the place index (02.2).
  NB9999900: { 2023: [1, null, 900] },
  IL0740400: { 2023: [0, null, 950] },
};
const NAMES: Record<string, string> = { TNMPD0000: "Memphis", TN9999900: "Example Town", TXDPD0000: "Dallas", NB9999900: "Example Village", IL0740400: "Mansfield" };
const sqls: string[] = [];
function stub(sql: string): unknown[][] {
  sqls.push(sql);
  const oris = [...sql.matchAll(/'([A-Z]{2}[A-Z0-9]{7})'/g)].map((m) => m[1]);
  // Item 7: clearance rates over years and agencies (Memphis 2021 blank, 2022 and 2023 published; Dallas 2023 only).
  const CLR: Record<string, Record<number, number>> = { TNMPD0000: { 2022: 12.3, 2023: 15.1 }, TXDPD0000: { 2023: 40.2 } };
  const clrSpan = /SELECT ori, year, \w+_cleared_rate FROM .*year BETWEEN (\d{4}) AND (\d{4})/.exec(sql);
  if (clrSpan) return oris.flatMap((o) => Object.entries(CLR[o] ?? {}).filter(([y]) => Number(y) >= Number(clrSpan[1]) && Number(y) <= Number(clrSpan[2])).map(([y, v]) => [o, Number(y), v]));
  // Item 11b: a state's agencies for a year.
  const list = /SELECT ori, name, population FROM .* WHERE state = '([A-Z]{2})' AND year = (\d{4})/.exec(sql);
  if (list) return Object.entries(CRIME).flatMap(([o, ys]) => (o.startsWith(list[1]) && ys[Number(list[2])] ? [[o, NAMES[o] ?? o, ys[Number(list[2])][2]]] : []));
  // Item 1: staffing, [ori, year, total, capita, population] for the kind asked (officer / civilian / all).
  const staff = /SELECT ori, year, (officer|civilian|all)_total, \w+_capita, population FROM read_parquet\('\/ci\/agency_staffing\.parquet'\) WHERE ori IN \(.*\) AND year BETWEEN (\d{4}) AND (\d{4})/.exec(sql);
  if (staff) {
    const STAFF: Record<string, Record<number, Record<string, [number | null, number | null]>>> = {
      TNMPD0000: { 2022: { officer: [1950, 312.0], civilian: [600, 96.0], all: [2550, 408.0] }, 2023: { officer: [1900, 308.4], civilian: [610, null], all: [2510, 407.4] } },
      TXDPD0000: { 2023: { officer: [3100, 237.9], civilian: [700, 53.7], all: [3800, 291.7] } },
    };
    const POP: Record<string, Record<number, number>> = { TNMPD0000: { 2022: 624944, 2023: 616061 }, TXDPD0000: { 2023: 1302868 } };
    return oris.flatMap((o) => Object.entries(STAFF[o] ?? {}).filter(([y]) => Number(y) >= Number(staff[2]) && Number(y) <= Number(staff[3]))
      .map(([y, k]) => [o, Number(y), k[staff[1]][0], k[staff[1]][1], POP[o][Number(y)]]));
  }
  if (/agency_clearances/.test(sql)) return /TNMPD0000/.test(sql) && /year = 2023/.test(sql) ? [[15.1, 53, 351]] : [];
  const between = /year BETWEEN (\d{4}) AND (\d{4})/.exec(sql), years = /year IN \((\d{4}), (\d{4})\)/.exec(sql);
  const out: unknown[][] = [];
  for (const o of oris) for (const [y, [t, c, p]] of Object.entries(CRIME[o] ?? {})) {
    const yr = Number(y);
    if (between && (yr < Number(between[1]) || yr > Number(between[2]))) continue;
    if (years && yr !== Number(years[1]) && yr !== Number(years[2])) continue;
    out.push(years ? [yr, t] : /SELECT ori, year, population /.test(sql) ? [o, yr, p] : [o, yr, t, c, p]);
  }
  return out;
}
const memphis = { ori: "TNMPD0000", label: "Memphis, Tennessee", name: "Memphis", state: "TN" }, dallas = { ori: "TXDPD0000", label: "Dallas, Texas", name: "Dallas", state: "TX" };
const ask = (q: Partial<HistoricalQuestion>) => answerHistorical({ measure: "murder", agencies: [memphis], from: 2023, to: 2023, byYear: false, statistic: "count", comparison: null, ...q }, build, stub);
const ok = (q: Partial<HistoricalQuestion>) => { const r = ask(q); assert.equal(r.kind, "historical", JSON.stringify(r)); return r as Extract<ReturnType<typeof ask>, { kind: "historical" }>; };
const no = (q: Partial<HistoricalQuestion>) => { const r = ask(q); assert.equal(r.kind, "historical-decline", JSON.stringify(r)); return (r as { explanation: string }).explanation; };

// A count as published, the plain availability line and P77's source line last; the build is read, never live tables.
const one = ok({});
assert.deepEqual(one.delivered.table.rows, [[351]]);
assert.equal(one.delivered.text[0], "Memphis, Tennessee: 351 murders in 2023.");
assert.equal(one.delivered.text[one.delivered.text.length - 1], SRS_SOURCE);
assert.equal(SRS_SOURCE, "Source: Crime Index.");
assert.doesNotMatch(one.delivered.text.join(" "), /as published by Crime Index; a blank means/, "P86: no generic availability note");
assert.ok(sqls.every((s) => s.includes("/ci/agency_")), "reads the build only");
assert.deepEqual(one.meaning.places, [{ kind: "agency", name: "Memphis", state: "TN" }]);
assert.equal(one.meaning.source, "historical");

// P75: the published rate (one decimal), never one calculated; no rate published: blank, said, not computed.
const rate = ok({ statistic: "rate" });
assert.deepEqual(rate.delivered.table.rows, [[57]]);
assert.equal(rate.delivered.text[0], "Memphis, Tennessee: 57.0 murders per 100,000 in 2023.");
assert.equal(rate.read.column, "murder_capita");
assert.match(no({ statistic: "rate", from: 2021, to: 2021 }), /^Crime Index has no murder rate for Memphis, Tennessee in 2021: not available in this data\.$/);
assert.ok(!rate.delivered.text.some((t) => /as crimeindex\.org shows it/.test(t)), "a published rate needs no note");
// P75 amended (Jeff 2026-11-01): no published rate but a count and a population: the page's count per 100,000, one
// decimal, said in the answer (TX0200000 1960: 10 / 41,843 -> 23.9).
assert.deepEqual(historicalRate(null, 10, 41843), { rate: 23.9, computed: true });
assert.deepEqual(historicalRate(57.0, 351, 616061), { rate: 57, computed: false });
assert.deepEqual(historicalRate(null, null, 41843), { rate: null, computed: false });
assert.deepEqual(historicalRate(null, 10, null), { rate: null, computed: false });
const pageRate = ok({ agencies: [{ ori: "TX0200000", label: "Brazoria County, Texas", name: "Brazoria County", state: "TX" }], statistic: "rate", from: 1960, to: 1960 });
assert.deepEqual(pageRate.delivered.table.rows, [[23.9]]);
assert.ok(!pageRate.delivered.text.some((t) => /as crimeindex\.org shows it/.test(t)), "P86: the computed rate needs no note");

// A blank is not available, never zero: a single year declines. A series starts at its first year with a figure
// (coordinator 2026-11-02): a leading blank year is left out, the first year named and the period starting there.
assert.match(no({ from: 2021, to: 2021 }), /not available in this data/);
const series = ok({ from: 2021, to: 2023, byYear: true });
assert.deepEqual(series.delivered.table.rows, [["2022", 252], ["2023", 351]]);
assert.ok(series.delivered.text.includes("Crime Index has no murder figure for Memphis, Tennessee in 2021, so the chart and table start in 2022."), series.delivered.text.join(" / "));
assert.deepEqual(series.period, { from: "2022-01", to: "2023-12" });

// P76: the build's years; outside them named, never "doesn't exist"; part of a span outside: the rest answered.
assert.match(no({ from: 1925, to: 1925 }), /cover 1930 through 2025, so 1925 is outside them/);
const partly = ok({ from: 2023, to: 2027, byYear: true });
assert.ok(partly.delivered.text.some((t) => /2026 through 2027 are outside them/.test(t)));

// A change (P54, P55): both counts, the change and the percent; a missing base gives none.
const ch = ok({ from: 2022, to: 2023, comparison: { earlier: 2022, later: 2023 } });
assert.deepEqual(ch.delivered.table.rows, [[252, 351, 99, 39.3]]);
assert.equal(ch.delivered.text[1], "252 in 2022 and 351 in 2023: a change of +99 (+39.3%).");
assert.match(no({ from: 2021, to: 2023, comparison: { earlier: 2021, later: 2023 } }), /no murders for Memphis, Tennessee in 2021: not available in this data, so there is no change/);

// Clearance: the published percentage with its counts; from 1960 only; one agency and one year.
const clr = ok({ statistic: "clearance_rate" });
assert.equal(clr.delivered.text[0], "Memphis, Tennessee: 15.1% of murders were cleared in 2023. That is 53 of 351 murders.");
assert.equal(clr.read.column, "murder_cleared_rate");
assert.match(no({ statistic: "clearance_rate", from: 1950, to: 1950 }), /clearance figures in the data cover 1960 through 2025/);
assert.match(no({ statistic: "clearance_rate", from: 2022, to: 2022 }), /no murder clearance rate for Memphis, Tennessee in 2022/);
assert.match(no({ statistic: "clearance_rate", from: 1959, to: 1960 }), /no murder clearance rate for Memphis, Tennessee in 1960: not available/);
// Item 7: clearance rates by year and across agencies, each as published, side by side, never combined; a year with
// none blank and named; the leading years with none for any agency left out and named.
const clrYears = ok({ statistic: "clearance_rate", from: 2021, to: 2023, byYear: true });
assert.deepEqual(clrYears.delivered.table.rows, [["2022", 12.3], ["2023", 15.1]]);
assert.deepEqual(clrYears.delivered.text, ["Memphis, Tennessee: the percentage of murders cleared by year, 2022 through 2023.",
  "Crime Index has no murder clearance rate for Memphis, Tennessee in 2021, so the chart and table start in 2022.", SRS_SOURCE]);
const clrPair = ok({ statistic: "clearance_rate", agencies: [memphis, dallas], from: 2022, to: 2023, byYear: true });
assert.deepEqual(clrPair.delivered.table.rows, [["2022", 12.3, null], ["2023", 15.1, 40.2]]);
assert.deepEqual(clrPair.delivered.table.columns.map((c) => c.header), ["Year", "Memphis, Tennessee: murders cleared (%)", "Dallas, Texas: murders cleared (%)"]);
assert.ok(clrPair.delivered.text.includes("Crime Index has no murder clearance rate for Dallas, Texas in 2022, shown blank."), JSON.stringify(clrPair.delivered.text));
const clrOneYear = ok({ statistic: "clearance_rate", agencies: [memphis, dallas], from: 2023, to: 2023 });
assert.deepEqual(clrOneYear.delivered.table.rows, [["Memphis, Tennessee", 15.1], ["Dallas, Texas", 40.2]]);
assert.equal(clrOneYear.meaning.statistic, "rate");
// Codex clearance review 01: a change in a clearance rate is declined, never the rates by year; years outside the
// data before and after are named apart.
assert.match(no({ statistic: "clearance_rate", from: 2022, to: 2023, comparison: { earlier: 2022, later: 2023 } }), /a change in a clearance rate/);
const wide = ok({ statistic: "clearance_rate", from: 1959, to: 2026, byYear: true });
assert.ok(wide.delivered.text.some((t) => /; 1959 and 2026 are outside them\.$/.test(t)), JSON.stringify(wide.delivered.text));

// Several agencies: side by side, never combined; one year a row each, a span a column each; blanks named per agency.
const pair = ok({ agencies: [memphis, dallas] });
assert.deepEqual(pair.delivered.table.rows, [["Memphis, Tennessee", 351], ["Dallas, Texas", 246]]);
assert.deepEqual(pair.meaning.groupings, ["agency"]);
const pairs = ok({ agencies: [memphis, dallas], from: 2022, to: 2023, byYear: true });
assert.deepEqual(pairs.delivered.table.rows, [["2022", 252, null], ["2023", 351, 246]]);
assert.ok(pairs.delivered.text.includes("Crime Index has no murder figure for Dallas, Texas in 2022, shown blank."), JSON.stringify(pairs.delivered.text));
assert.ok(!pairs.delivered.text.some((t) => /combined|total of/i.test(t)));

// The agencies named by their FBI names, second, and never "reported by" (the file is what Crime Index published).
const named = ok({ agencyLine: "Figures for the Memphis Police Department." });
assert.equal(named.delivered.text[1], "Figures for the Memphis Police Department.");
assert.ok(!named.delivered.text.some((t) => /reported by/i.test(t)));

// Item 3 (coordinator 2026-11-07): an agency beside its state or the nation, each place's own Crime Index figures side
// by side in the order asked (the agency's from the build, Tennessee's and the nation's from the historical file).
{
  const beside = (q: Partial<HistoricalQuestion>, places: Parameters<typeof answerBeside>[1]) =>
    answerBeside({ measure: "murder", agencies: [], from: 2023, to: 2023, byYear: false, statistic: "count", comparison: null, ...q }, places, build, stub);
  const tn = { geo: { kind: "state" as const, code: "TN" } }, us = { geo: { kind: "national" as const } };
  const year = beside({ statistic: "rate", agencyLine: "Figures for the Memphis Police Department." }, [{ agency: memphis }, tn]);
  assert.equal(year.kind, "historical", JSON.stringify(year));
  if (year.kind === "historical") {
    assert.deepEqual(year.delivered.table.rows, [["Memphis, Tennessee", 57], ["Tennessee", 10]]);
    assert.deepEqual(year.delivered.text, ["Memphis, Tennessee and Tennessee: murders per 100,000 in 2023.", "Figures for the Memphis Police Department.",
      "Each rate is per 100,000 of that place's own population.", SRS_SOURCE]);
    assert.deepEqual(year.meaning.places, [{ kind: "agency", name: "Memphis", state: "TN" }, { kind: "state", name: "Tennessee", state: "TN" }]);
    assert.deepEqual([year.question.shown, year.question.beside], [["Memphis, Tennessee", "Tennessee"], [{ kind: "state", code: "TN" }]]);
  }
  // By year, in the order asked: the nation first is said "The United States", its column "United States".
  const years = beside({ from: 2022, to: 2023, byYear: true }, [us, { agency: memphis }]);
  assert.ok(years.kind === "historical", JSON.stringify(years));
  if (years.kind === "historical") {
    assert.deepEqual(years.delivered.table.rows, [["2022", 21923, 252], ["2023", 19935, 351]]);
    assert.deepEqual(years.delivered.table.columns.map((c) => c.header), ["Year", "United States: murders", "Memphis, Tennessee: murders"]);
    assert.equal(years.delivered.text[0], "The United States and Memphis, Tennessee: murders by year, 2022 to 2023.");
  }
  // A year with no agency figure that the state has starts the series, the agency blank (not "starts in 2022").
  const blank = beside({ from: 2021, to: 2022, byYear: true }, [{ agency: memphis }, tn]);
  assert.ok(blank.kind === "historical" && JSON.stringify(blank.delivered.table.rows) === JSON.stringify([["2021", null, 709], ["2022", 252, 647]]) && blank.delivered.text.includes("Crime Index has no murder figure for Memphis, Tennessee in 2021, shown blank.") && !blank.delivered.text.some((t) => /start in/.test(t)), JSON.stringify(blank));
  // A change or a clearance rate is one place at a time, as for several states.
  for (const q of [{ comparison: { earlier: 2022, later: 2023 } }, { statistic: "clearance_rate" as const }]) {
    const r = beside(q, [{ agency: memphis }, us]);
    assert.ok(r.kind === "historical-decline" && /beside a state or the nation\. Ask for one place\./.test(r.explanation), JSON.stringify(r));
  }
}

// Codex 01.1: the unit each offense is counted in; another unit is not this file's figure.
assert.equal(historicalUnitFits("robbery", "victims"), false);
assert.equal(historicalUnitFits("robbery", "offenses"), true);
assert.equal(historicalUnitFits("murder", "victims"), true);
assert.equal(historicalUnitFits("murder", "offenses"), false);
assert.equal(historicalUnitFits("violent_crime", "victims"), false);
assert.equal(historicalUnitFits("violent_crime", null), true);

// Not a Historical measure: declined, never guessed.
assert.match((answerHistorical({ measure: "shoplifting", agencies: [memphis], from: 2023, to: 2023, byYear: false, statistic: "count", comparison: null }, build, stub) as { explanation: string }).explanation, /seven Part I offenses only/);

// Through the shadow (Codex review 01): routed only with the build, restrictions kept, combined declined.
{
  const places = loadPlaceIndex();
  const base = { places, release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" }, target: { root: "/b", builtYears: [2023] }, execute: stub };
  const withBuild = (q: string) => shadowAnswer(q, { ...base, historical: build });
  assert.equal(withBuild("Murders in Memphis in 2023").kind, "historical");
  assert.notEqual(shadowAnswer("Murders in Memphis in 2023", base).kind, "historical", "no build: not Historical's answer");
  const victims = withBuild("How many robbery victims were there in Memphis in 2023?");
  assert.ok(victims.kind === "decline" && /counts robberies as offenses, not victims/.test(victims.explanation), JSON.stringify(victims).slice(0, 300));
  const combined = withBuild("Murders in Memphis and Dallas combined in 2023");
  assert.ok(combined.kind === "decline" && /can't be combined across agencies/.test(combined.explanation) && combined.alternative?.question === "Murders in Memphis and Dallas in 2023", JSON.stringify(combined).slice(0, 300));
  assert.notEqual(withBuild("Robberies in Memphis in 2023 according to NIBRS").kind, "historical");
  // Item 3: an agency beside its state or the nation answers; combined, a count beside a rate, a clearance rate and
  // a month keep their declines; no period asks which.
  for (const q of ["Murder rate in Memphis and Tennessee in 2023", "Memphis vs national murders in 2023", "Murders in Memphis compared to Tennessee and the US in 2023"]) {
    const o = withBuild(q);
    assert.ok(o.kind === "historical" && o.question.beside?.length, `${q}: ${JSON.stringify(o).slice(0, 300)}`);
  }
  for (const q of ["Murders in Memphis and Tennessee combined in 2023", "Murder count in Memphis and the murder rate in Tennessee in 2023", "Murder clearance rate in Memphis and the US in 2023", "Murders in Memphis and Tennessee in March 2023"])
    assert.notEqual(withBuild(q).kind, "historical", q);
  // Codex beside review 01.1: a statistic said of some places only is never applied to all (351 victims, not 57).
  for (const q of ["Murder victims in Memphis and murder rate in Tennessee in 2023", "Murder rate in Tennessee and murder victims in Memphis in 2023", "Murders in Memphis and the rate in Tennessee in 2023",
    "Murders in Memphis and Tennessee's rate in 2023", "Memphis murders and Tennessee's murder rate in 2023", "Murders in Memphis and Tennessee's rate, the rate in 2023"]) {
    const o = withBuild(q);
    assert.ok(o.kind === "decline" && /same figure for every place/.test(o.explanation), `${q}: ${JSON.stringify(o).slice(0, 300)}`);
  }
  // Codex beside review 02.2: one statistic for every place, however it is said, still answers.
  for (const q of ["Memphis murder rate vs Tennessee murder rate in 2023", "Memphis murder rate compared with Tennessee in 2023", "Murders per 100,000 in Memphis and Tennessee in 2023",
    "Rate of murders in Memphis and Tennessee in 2023", "Murder victim rate in Memphis and Tennessee in 2023", "the murder rate in Memphis compared to the Tennessee rate in 2023",
    "Memphis murder rate vs Tennessee murders per 100,000 in 2023", "Memphis and Tennessee murder rate per 100,000 in 2023", "per capita murders in Memphis and Tennessee in 2023"]) {
    const o = withBuild(q);
    assert.ok(o.kind === "historical" && JSON.stringify(o.delivered.table.rows) === JSON.stringify([["Memphis, Tennessee", 57], ["Tennessee", 10]]), `${q}: ${JSON.stringify(o).slice(0, 300)}`);
  }
  // PR #129 scorecard (QL-nibrs-6900e4157e): a state written right after its own agency is that agency's state.
  for (const q of ["Murder rate for Fairfax County Police Department in Virginia from 2021 to 2025", "Murders in Memphis Police Department in Tennessee in 2023"]) {
    const o = withBuild(q);
    assert.ok(!(o.kind === "historical" && o.question.beside?.length), `${q}: ${JSON.stringify(o).slice(0, 300)}`);
  }
  const twice = withBuild("Murders in Memphis and murders in Tennessee in 2023");
  assert.ok(twice.kind === "historical" && twice.delivered.table.rows[0][1] === 351, JSON.stringify(twice).slice(0, 300));
  // Codex beside review 01.2: the order asked, the nation first too.
  for (const [q, order] of [["US vs Memphis murder rate in 2023", ["United States", "Memphis, Tennessee"]], ["Tennessee, Memphis and the US murders in 2023", ["Tennessee", "Memphis, Tennessee", "United States"]],
    ["Memphis vs the US murders since 2022", ["Memphis, Tennessee", "United States"]]] as const) {
    const o = withBuild(q);
    assert.ok(o.kind === "historical" && JSON.stringify(o.question.shown) === JSON.stringify(order), `${q}: ${JSON.stringify(o).slice(0, 400)}`);
  }
  assert.equal(withBuild("Murders in Memphis and Tennessee").kind, "clarify");
  assert.notEqual(withBuild("Robberies in Memphis in 2023 by weapon").kind, "historical");
  // Arrests and offenders are NIBRS's own counts: never Historical's, never its unit decline (scored-run regression).
  for (const q of ["Robbery arrests in Memphis in 2023", "Aggravated assault offenders in Detroit in 2023"]) {
    const o = withBuild(q);
    assert.ok(o.kind !== "historical" && !(o.kind === "decline" && /Historical counts/.test(o.explanation)), `${q}: ${JSON.stringify(o).slice(0, 200)}`);
  }
  // Coordinator 2026-11-02 (the redesign's preview of Jeff's own question): months route by the sources' grain, and
  // every button runs now. A button is runnable when it carries a question, or a continuation that is not a decline
  // and whose own buttons are runnable.
  const runnable = (o: ShadowOutcome): boolean => o.kind === "clarify" ? o.options.length > 0 && o.options.every((x) => !x.otherSource && (!!x.question || !!x.entry || (!!x.continuation && x.continuation.kind !== "decline" && runnable(x.continuation))))
    : o.kind === "decline" ? !o.alternative || (!o.alternative.otherSource && (!!o.alternative.question || (!!o.alternative.continuation && o.alternative.continuation.kind !== "decline" && runnable(o.alternative.continuation))))
    : true;
  // "Memphis crime per month in 2023" and its rewrites ("show me 2022", "the year before"): violent and property totals
  // are annual (no NIBRS total yet), so a plain decline with the whole-year question, which asks the kind and answers.
  for (const q of ["Memphis crime per month in 2023", "Memphis crime per month in 2022", "Memphis crime by month in 2023"]) {
    const o = withBuild(q);
    assert.ok(o.kind === "decline" && /whole years only/.test(o.explanation) && runnable(o), `${q}: ${JSON.stringify(o).slice(0, 300)}`);
    const by = o.kind === "decline" ? o.alternative?.continuation : undefined;
    assert.ok(by?.kind === "clarify" && by.options.every((x) => x.continuation?.kind === "historical"), JSON.stringify(by).slice(0, 300));
  }
  // Codex routing review 01: rolling windows never recurse; a route to Current Trends (not loaded) is not a button.
  assert.ok(runnable(withBuild("violent crime in Memphis rolling 12 months in 2023")));
  const now = withBuild("crime in Memphis in 2026");
  assert.ok(runnable(now) && !(now.kind === "clarify" && now.options.some((x) => x.continuation?.kind === "route")), JSON.stringify(now).slice(0, 300));
  const kinds = withBuild("Memphis crime in 2023");
  assert.ok(kinds.kind === "clarify" && runnable(kinds) && kinds.options.map((x) => x.label).join() === "Violent crime,Property crime", JSON.stringify(kinds).slice(0, 300));
  // A Part I crime by month goes to NIBRS (monthly), never Historical's whole-years decline or P01's.
  for (const q of ["Memphis robberies per month in 2023", "Memphis burglaries by quarter in 2023"]) {
    const o = withBuild(q);
    assert.ok(o.kind !== "historical" && !(o.kind === "decline" && /whole years|Crime Index's Historical/.test(o.explanation)), `${q}: ${JSON.stringify(o).slice(0, 300)}`);
  }
}

// Item 11: population on its own, as Crime Index publishes it (the agency's from the build, Tennessee's and the
// nation's from the historical file); the period asked when none; a crime or a column beside it goes on as before.
{
  const places = loadPlaceIndex();
  const base = { places, release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" }, target: { root: "/b", builtYears: [2023] }, execute: stub, historical: build };
  const pop = (q: string) => { const o = shadowAnswer(q, base); assert.equal(o.kind, "historical", `${q}: ${JSON.stringify(o).slice(0, 300)}`); return o as Extract<ShadowOutcome, { kind: "historical" }>; };
  const one = pop("Population of Memphis in 2023");
  assert.deepEqual(one.delivered.table.rows, [[616061]]);
  assert.deepEqual(one.delivered.text, ["Memphis, Tennessee: population 616,061 in 2023.", "Figures for the Memphis Police Department.",
    "An agency's population is the population it covers, as Crime Index publishes it.", SRS_SOURCE]);
  assert.ok(sqls[sqls.length - 1].includes("SELECT ori, year, population FROM read_parquet('/ci/agency_crime.parquet')"), sqls[sqls.length - 1]);
  assert.deepEqual(pop("population of Memphis and Tennessee in 2023").delivered.table.rows, [["Memphis, Tennessee", 616061], ["Tennessee", 7148304]]);
  assert.deepEqual(pop("US population per year from 2022 to 2023").delivered.table.rows, [["2022", 333287550], ["2023", 334914880]]);
  assert.deepEqual(pop("What is the current population of the United States?").delivered.table.rows, [[pop("US population in 2025").delivered.table.rows[0][0]]], "current: the latest year");
  // A blank year is blank and named (2021 has a population in the stub; Dallas has 2023 only).
  const dal = pop("Population of Dallas by year from 2022 to 2023");
  assert.ok(JSON.stringify(dal.delivered.table.rows) === JSON.stringify([["2023", 1302868]]) && dal.delivered.text.some((t) => /no population for Dallas, Texas in 2022, so the table starts in 2023/.test(t)), JSON.stringify(dal.delivered));
  const none = shadowAnswer("Population of Memphis", base);
  assert.ok(none.kind === "clarify" && none.about === "which period", JSON.stringify(none).slice(0, 200));
  const later = shadowAnswer("Texas population in 2026", base);
  assert.ok(later.kind === "decline" && later.reason === "outside_release_coverage", JSON.stringify(later).slice(0, 200));
  // Codex population review 01.1: a qualifier the reader kept aside is never dropped (a region read as the nation, a
  // change, NIBRS asked by name).
  for (const q of ["Population in the Northeast in 2023", "Percent change in US population from 2022 to 2023", "Population of Memphis in 2023 according to NIBRS"]) {
    const o = shadowAnswer(q, base);
    assert.ok(!(o.kind === "historical" && o.question.measure === "population"), `${q}: ${JSON.stringify(o).slice(0, 200)}`);
  }
  // PR #130's scorecard: only population on its own or "agencies" stand alone; one Police Department, "... and
  // population" or a turn pointing back stays a follow-up.
  for (const [q, alone] of [["just anne arundel county police department", false], ["Durham, North Carolina and population", false],
    ["Annual from 2000-2020, sum of agencies within NY state that meet that reporting criteria", false], ["give me Kansas City, MO's population per year", true],
    ["List of Tennessee law enforcement agencies ordered by population in 2023", true]] as const) assert.equal(standsAlone(q), alone, q);
  // 01.2: a population question with its own place, after a crime question, is a question of its own.
  const after = shadowFollowUp("Murders in Memphis in 2023", "Population of Tennessee in 2023", base);
  assert.ok(after.kind === "historical" && JSON.stringify(after.delivered.table.rows) === "[[7148304]]", JSON.stringify(after).slice(0, 300));
  // 11b: a state's agencies with their populations, largest first; one with none listed last, blank, never dropped.
  const tn = pop("List of Tennessee law enforcement agencies ordered by population in 2023");
  assert.deepEqual(tn.delivered.table.rows, [["Memphis, Tennessee", 616061], ["Example Town, Tennessee", null]]);
  assert.deepEqual(tn.question.list, { state: "TN", count: 2, top: [{ label: "Memphis, Tennessee", population: 616061 }] });
  assert.ok(tn.delivered.text.includes("1 agency has no population for 2023, listed last, blank."), JSON.stringify(tn.delivered.text));
  assert.equal(pop("which agencies are in Tennessee in 2023").delivered.table.rows.length, 2);
  // No year: asked with buttons that run (02.3).
  const noYear = shadowAnswer("List of Tennessee agencies", base);
  assert.ok(noYear.kind === "clarify" && noYear.about === "which year" && noYear.options[0].label === "The latest year (2025)" && /agencies for Tennessee in 2025/.test(JSON.stringify(noYear.options[0].continuation)) && !noYear.options.some((o) => /Every year/.test(o.label)), JSON.stringify(noYear).slice(0, 300));
  assert.deepEqual(pop("List of Nebraska agencies in 2023").delivered.table.rows, [["Example Village, Nebraska", 900]]);
  assert.deepEqual(pop("List of Illinois agencies in 2023").delivered.table.rows, [["Mansfield, Illinois", 950]]);
  for (const q of ["which agencies are in Cook County, Illinois in 2023", "agencies in Tennessee that report to NIBRS in 2023", "List all agencies in Texas with type County in 2023", "murders by agency in Tennessee in 2023"]) {
    const o = shadowAnswer(q, base);
    assert.ok(!(o.kind === "historical" && o.question.list), `${q}: ${JSON.stringify(o).slice(0, 200)}`);
  }
  for (const q of ["murders and population in Memphis in 2023", "murder rate in Memphis in 2023", "population of Memphis and Tennessee combined in 2023"])
    assert.ok(!(shadowAnswer(q, base).kind === "historical" && (shadowAnswer(q, base) as { question: { measure: string } }).question.measure === "population"), q);
}

// Item 1: police staffing for agencies, as published by Crime Index; per 100,000 only (another scale said, never
// converted); a rate Crime Index leaves blank is the count per 100,000 of its population, said; states and the nation
// have none; officers and civilians together are asked which.
{
  const places = loadPlaceIndex();
  const base = { places, release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" }, target: { root: "/b", builtYears: [2023] }, execute: stub, historical: build };
  const hist = (q: string) => { const o = shadowAnswer(q, base); assert.equal(o.kind, "historical", `${q}: ${JSON.stringify(o).slice(0, 300)}`); return o as Extract<ShadowOutcome, { kind: "historical" }>; };
  const officers = hist("Show me the number of police officers in Memphis in 2023");
  assert.deepEqual(officers.delivered.table.rows, [[1900]]);
  assert.deepEqual(officers.delivered.text, ["Memphis, Tennessee: 1,900 sworn officers in 2023.", "Figures for the Memphis Police Department.", SRS_SOURCE]);
  const per1000 = hist("officers per 1,000 population in Memphis in 2023");
  // P97 (Jeff 2026-11-07: "Convert to per 1,000"): the published per-100,000 rate at the asked base, labeled, said once.
  assert.deepEqual(per1000.delivered.table.rows, [[3.084]]);
  assert.deepEqual(per1000.delivered.table.columns.map((c) => c.header), ["Sworn officers per 1,000"]);
  assert.deepEqual(per1000.delivered.text, ["Memphis, Tennessee: 3.084 sworn officers per 1,000 people in 2023.", "Figures for the Memphis Police Department.",
    "Rates per 1,000 are Crime Index's published rates per 100,000, divided by 100.", SRS_SOURCE]);
  const per10k = hist("officers per 10,000 residents in Memphis by year from 2022 to 2023");
  assert.deepEqual(per10k.delivered.table.rows, [["2022", 31.2], ["2023", 30.84]]);
  assert.ok(per10k.delivered.text.includes("Rates per 10,000 are Crime Index's published rates per 100,000, divided by 10."), JSON.stringify(per10k.delivered.text));
  const civ1000 = hist("civilian employees per 1,000 in Memphis in 2023");
  assert.deepEqual(civ1000.delivered.table.rows, [[0.99]], "a computed rate converts too: 99.0 per 100,000");
  // Codex staffing review 04: with a computed rate, neither line calls it published or per 100,000.
  assert.ok(civ1000.delivered.text.includes("Rates per 1,000 are rates per 100,000, divided by 100.") && civ1000.delivered.text.some((t) => /that year's rate is the count per 1,000 of the published population/.test(t))
    && !civ1000.delivered.text.some((t) => /Crime Index's published rates/.test(t)), JSON.stringify(civ1000.delivered.text));
  assert.deepEqual(hist("officers per 100,000 people in Memphis in 2023").delivered.table.rows, [[308.4]], "per 100,000: as published, no note");
  assert.ok(!hist("officers per 100,000 people in Memphis in 2023").delivered.text.some((t) => /divided by/.test(t)));
  const civ = hist("civilian employees per capita in Memphis in 2023");
  assert.deepEqual(civ.delivered.table.rows, [[99]], "no published rate: 610 per 100,000 of 616,061");
  assert.ok(civ.delivered.text.some((t) => /publishes no civilian employee rate for Memphis, Tennessee in 2023; that year's rate is the count per 100,000/.test(t)), JSON.stringify(civ.delivered.text));
  assert.deepEqual(hist("civilian employees in Memphis and Dallas in 2023").delivered.table.rows, [["Memphis, Tennessee", 610], ["Dallas, Texas", 700]]);
  const series = hist("police staffing in Memphis by year from 2022 to 2023");
  assert.deepEqual(series.delivered.table.rows, [["2022", 2550], ["2023", 2510]]);
  assert.equal(series.question.measure, "staffing:employees");
  for (const [q, re] of [["police officers in Tennessee in 2023", /agencies only, not for states or the nation/], ["officers and civilian employees in Memphis in 2023", /Ask for one: sworn officers, civilian employees or all employees/],
    ["number of officers per capita in Memphis in 2023", /same figure throughout/],
    // Codex staffing review 01: never one kind answered for two, a staff ratio as a count, or a rate for a count too.
    ["Police officers and police employees in Memphis in 2023", /Ask for one: sworn officers/], ["civilian employees and police employees in Memphis in 2023", /Ask for one/],
    ["Police employees per officer in Memphis in 2023", /a ratio between kinds of staff/],
    ["What is the count of police officers and the rate per capita in Memphis in 2023?", /same figure throughout/]] as const) {
    const o = shadowAnswer(q, base);
    assert.ok(o.kind === "decline" && re.test(o.explanation), `${q}: ${JSON.stringify(o).slice(0, 300)}`);
  }
  assert.equal(shadowAnswer("police officers in Memphis", base).kind, "clarify", "no period: asked");
  assert.deepEqual(hist("How many officers per capita does Memphis have in 2023?").delivered.table.rows, [[308.4]], "how many ... per capita is the rate");
  assert.deepEqual(hist("police staffing per-capita in Memphis in 2023").delivered.table.rows, [[407.4]], "per-capita, hyphenated, is the rate (Codex staffing review 02)");
  assert.deepEqual(hist("police staffing per year in Memphis from 2022 to 2023").delivered.table.rows, [["2022", 2550], ["2023", 2510]], "per year is the grain");
  for (const q of ["officers killed in Memphis in 2023", "assaults on police officers in Memphis in 2023", "murders in Memphis per officer in 2023"]) {
    const o = shadowAnswer(q, base);
    assert.ok(!(o.kind === "historical" && o.question.measure.startsWith("staffing:")), `${q}: ${JSON.stringify(o).slice(0, 200)}`);
  }
}

// A state's city agencies ranked from Crime Index for one year (Jeff 2026-11-10, option A): ties at the cut all shown,
// agencies with no figure left out and named, the computed rate said, P08's floor in the SQL, the pre-1960 caveat.
{
  const rsql: string[] = [];
  // ori, name, population, total, capita
  const TX1950: unknown[][] = [["TXHPD0000", "Houston", 596163, 91, 15.3], ["TXDPD0000", "Dallas", 434462, 59, 13.6], ["TX2201200", "Fort Worth", 278778, 48, 17.2],
    ["TX0000001", "Abilene", 45570, 48, null], ["TX0000002", "Tyler", 38968, null, null], ["TX0000003", "Laredo", 51910, null, null]];
  const rexec = (sql: string) => { rsql.push(sql); return /type = 'city'/.test(sql) && /year = 1950/.test(sql) ? TX1950 : []; };
  const r = answerHistoricalRanking({ measure: "murder", state: "TX", year: 1950, statistic: "count", direction: "top", limit: 3, minPopulation: null }, build, rexec);
  assert.ok(r.kind === "historical", JSON.stringify(r));
  if (r.kind === "historical") {
    assert.deepEqual(r.delivered.table.rows, [["Houston", 91], ["Dallas", 59], ["Abilene", 48], ["Fort Worth", 48]]);
    assert.equal(r.delivered.text[0], "Texas city agencies: the 4 with the most murders, 1950.");
    assert.ok(r.delivered.text.includes("Abilene and Fort Worth tie for 3rd, so 4 agencies are shown."), JSON.stringify(r.delivered.text));
    assert.ok(r.delivered.text.includes("Not ranked because Crime Index has no murder figure for them in 1950: Laredo and Tyler."), JSON.stringify(r.delivered.text));
    assert.ok(r.delivered.text.some((t) => /^Data before 1960 may reflect incomplete or limited reporting/.test(t)));
    assert.equal(r.delivered.text[r.delivered.text.length - 1], SRS_SOURCE);
    assert.equal(r.meaning.statistic, "rank");
    assert.match(rsql[0], /FROM read_parquet\('\/ci\/agency_crime\.parquet'\) WHERE state = 'TX' AND type = 'city' AND year = 1950/);
  }
  // A rate: the published one, else the count per 100,000 of the published population (P75), said.
  const rr = answerHistoricalRanking({ measure: "murder", state: "TX", year: 1950, statistic: "rate", direction: "top", limit: 2, minPopulation: null }, build, rexec);
  assert.ok(rr.kind === "historical");
  if (rr.kind === "historical") {
    assert.deepEqual(rr.delivered.table.rows, [["Abilene", 105.3], ["Fort Worth", 17.2]]);
    const all = answerHistoricalRanking({ measure: "murder", state: "TX", year: 1950, statistic: "rate", direction: "bottom", limit: 10, minPopulation: null }, build, rexec);
    assert.ok(all.kind === "historical" && all.delivered.text.some((t) => /publishes no murder rate for Abilene in 1950; its rate is the count per 100,000/.test(t)), JSON.stringify(all));
    assert.ok(all.kind === "historical" && all.delivered.table.rows[0][0] === "Dallas");
  }
  // P08's floor is in the query; a year outside the build is declined with the span.
  rsql.length = 0;
  answerHistoricalRanking({ measure: "robbery", state: "CA", year: 1985, statistic: "count", direction: "bottom", limit: 20, minPopulation: 250000 }, build, rexec);
  assert.match(rsql[0], /AND population >= 250000/);
  const out = answerHistoricalRanking({ measure: "murder", state: "TX", year: 1925, statistic: "count", direction: "top", limit: 20, minPopulation: null }, build, rexec);
  assert.ok(out.kind === "historical-decline" && /cover 1930 through 2025, so 1925 is outside them/.test(out.explanation));
  // No 1960 caveat from 1960 on.
  const later = answerHistoricalRanking({ measure: "murder", state: "TX", year: 1950, statistic: "count", direction: "top", limit: 20, minPopulation: null }, { ...build, firstYear: 1930 }, rexec);
  assert.ok(later.kind === "historical");
  // The shadow: a ranking of a state's cities in a year before NIBRS's is Crime Index's; a NIBRS year never is.
  const places = loadPlaceIndex();
  const base = { places, release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" }, target: { root: "/b", builtYears: [2023] }, execute: rexec, historical: build };
  const viaShadow = shadowAnswer("Which Texas cities had the most murders in 1950?", base as never) as ShadowOutcome & { question?: { ranking?: unknown } };
  assert.ok(viaShadow.kind === "historical" && !!viaShadow.question?.ranking, JSON.stringify(viaShadow).slice(0, 300));
  // One city asked for, however the state is said (Codex ranking review 1): one row.
  for (const q of ["Which city in Texas had the most murders in 1950?", "Which city had the most murders in Texas in 1950?"]) {
    const one = shadowAnswer(q, base as never);
    assert.ok(one.kind === "historical" && one.delivered.table.rows.length === 1 && one.delivered.table.rows[0][0] === "Houston", `${q}: ${JSON.stringify(one).slice(0, 300)}`);
  }
  // Jeff 2026-11-10, ranking decision 3: Part I city rankings in NIBRS years are Crime Index's too.
  rsql.length = 0;
  shadowAnswer("Which Texas cities had the most murders in 2024?", base as never);
  assert.ok(rsql.some((s) => /agency_crime\.parquet'\) WHERE state = 'TX' AND type = 'city' AND year = 2024/.test(s)), rsql.join("\n"));
}
// The nation's cities, every agency, and the states (Jeff 2026-11-10, ranking decisions 1-5).
{
  const rsql: string[] = [];
  const US: unknown[][] = [["ILCPD0000", "Chicago", 2_700_000, 461, 17.1, "IL"], ["NY0303000", "New York City", 8_300_000, 356, 4.3, "NY"],
    ["TXHPD0000", "Houston", 2_300_000, 334, 14.5, "TX"], ["OHCOP0000", "Columbus", 900_000, 120, 13.3, "OH"], ["GACPD0000", "Columbus", 200_000, 40, 20, "GA"]];
  const ST: unknown[][] = [["LA", "Louisiana", 4_600_000, 760, 16.5, "LA"], ["MS", "Mississippi", 2_900_000, 420, 14.4, "MS"], ["AL", "Alabama", 5_000_000, 600, 12, "AL"]];
  const rexec = (sql: string) => { rsql.push(sql); return /state_crime/.test(sql) ? ST : /agency_crime/.test(sql) ? US : []; };
  // The nation's cities: named with their state, so two Columbuses stay apart; no state in the query.
  const us = answerHistoricalRanking({ measure: "murder", state: "US", year: 2024, statistic: "count", direction: "top", limit: 3, minPopulation: 250000 }, build, rexec);
  assert.ok(us.kind === "historical", JSON.stringify(us));
  if (us.kind === "historical") {
    assert.deepEqual(us.delivered.table.rows, [["Chicago, IL", 461], ["New York City, NY", 356], ["Houston, TX", 334]]);
    assert.equal(us.delivered.text[0], "United States city agencies with a population of 250,000 or more: the 3 with the most murders, 2024.");
    assert.match(rsql[0], /agency_crime\.parquet'\) WHERE type = 'city' AND year = 2024 AND population >= 250000/);
  }
  // Every agency, city and county: no type in the query.
  rsql.length = 0;
  answerHistoricalRanking({ measure: "murder", state: "CA", year: 2020, statistic: "count", direction: "top", limit: 10, minPopulation: null, entity: "agency" }, build, rexec);
  assert.match(rsql[0], /WHERE state = 'CA' AND year = 2020 ORDER BY ori/);
  // The states: 1960 on, without DC.
  rsql.length = 0;
  const st = answerHistoricalRanking({ measure: "murder", state: "US", year: 2022, statistic: "rate", direction: "top", limit: 1, minPopulation: null, entity: "state" }, build, rexec);
  assert.ok(st.kind === "historical" && JSON.stringify(st.delivered.table.rows) === '[["Louisiana",16.5]]', JSON.stringify(st));
  assert.match(rsql[0], /state_crime\.parquet'\) WHERE year = 2022 AND state <> 'DC'/);
  if (st.kind === "historical") assert.ok(st.delivered.text.some((t) => /the District of Columbia is not a state/.test(t)));
  const early = answerHistoricalRanking({ measure: "murder", state: "US", year: 1958, statistic: "rate", direction: "top", limit: 1, minPopulation: null, entity: "state" }, build, rexec);
  assert.ok(early.kind === "historical-decline" && /cover 1960 through/.test(early.explanation));
  // Through the shadow: states ranked need no place; "big cities" with none are the nation's of 250,000 or more.
  const places = loadPlaceIndex();
  const base = { places, release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" }, target: { root: "/b", builtYears: [2023] }, execute: rexec, historical: build };
  const s1 = shadowAnswer("Which state had the highest murder rate in 2022", base as never);
  assert.ok(s1.kind === "historical" && s1.delivered.table.rows[0][0] === "Louisiana", JSON.stringify(s1).slice(0, 300));
  rsql.length = 0;
  const big = shadowAnswer("Which big cities had the most murders in 2024?", base as never);
  assert.ok(big.kind === "historical" && rsql.some((s) => /type = 'city' AND year = 2024 AND population >= 250000/.test(s)), JSON.stringify(big).slice(0, 300));
  rsql.length = 0;
  shadowAnswer("Big cities with most murder victims in 2024", base as never);
  assert.ok(rsql.some((s) => /population >= 250000/.test(s)), "murder victims are the murders a ranking counts");
}
// "The N largest cities" (Jeff 2026-11-10, ranking decisions 1-2): the N city agencies by the population published for
// the last year asked, largest first, and their figure each year; never a national or state total in their place.
{
  const ssql: string[] = [];
  const SET: unknown[][] = [["NY0303000", "New York City", "NY", 8_300_000], ["CA0194200", "Los Angeles", "CA", 3_800_000]];
  const VALS: unknown[][] = [["NY0303000", 2023, 391, 4.7, 8_300_000], ["NY0303000", 2024, 356, null, 8_300_000], ["CA0194200", 2024, 268, 7, 3_800_000]];
  const sexec = (sql: string) => { ssql.push(sql); return /ORDER BY population DESC/.test(sql) ? SET : /ori IN/.test(sql) ? VALS : []; };
  const one = answerHistoricalSet({ measure: "murder", state: "US", from: 2024, to: 2024, statistic: "count", n: 2 }, build, sexec);
  assert.ok(one.kind === "historical", JSON.stringify(one));
  if (one.kind === "historical") {
    assert.deepEqual(one.delivered.table.rows, [["New York City, NY", 356], ["Los Angeles, CA", 268]]);
    assert.equal(one.delivered.text[0], "The 2 largest cities in the United States by population (2024): murders, 2024.");
    assert.match(ssql[0], /WHERE type = 'city' AND year = 2024 AND population IS NOT NULL ORDER BY population DESC, name LIMIT 2/);
  }
  // Several years: one row a city a year; a year with no figure is blank and said; the rate is computed where none is published.
  const two = answerHistoricalSet({ measure: "murder", state: "US", from: 2023, to: 2024, statistic: "rate", n: 2 }, build, sexec);
  assert.ok(two.kind === "historical");
  if (two.kind === "historical") {
    assert.deepEqual(two.delivered.table.rows, [["New York City, NY", "2023", 4.7], ["New York City, NY", "2024", 4.3], ["Los Angeles, CA", "2023", null], ["Los Angeles, CA", "2024", 7]]);
    assert.ok(two.delivered.text.some((t) => /A blank means Crime Index has no murder rate/.test(t)));
    assert.ok(two.delivered.text.some((t) => /the rate is the count per 100,000/.test(t)));
  }
  // A state's: the state in the query.
  ssql.length = 0;
  answerHistoricalSet({ measure: "robbery", state: "TX", from: 2023, to: 2023, statistic: "count", n: 5 }, build, sexec);
  assert.match(ssql[0], /WHERE state = 'TX' AND type = 'city' AND year = 2023/);
  assert.ok(answerHistoricalSet({ measure: "murder", state: "US", from: 2026, to: 2026, statistic: "count", n: 5 }, build, sexec).kind === "historical-decline");
  // Through the shadow: the set is read, the place is the nation or the state named, and nothing else answers in its place.
  const places = loadPlaceIndex();
  const base = { places, release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" }, target: { root: "/b", builtYears: [2023] }, execute: sexec, historical: build };
  for (const [q, n] of [["murder rate for the 10 largest cities in 2024", 10], ["Murder counts for the four largest U.S. cities, 2010-2024", 4], ["the 20 most populous cities ranked by their 2024 murder rate", 20]] as const) {
    assert.equal(readQuestion(q, 2026, "2026-09").largestSet, n, q);
  }
  ssql.length = 0;
  const viaShadow = shadowAnswer("murder rate for the 2 largest cities in 2024", base as never);
  assert.ok(viaShadow.kind === "historical" && ssql.some((x) => /LIMIT 2/.test(x)), JSON.stringify(viaShadow).slice(0, 300));
  const tx = shadowAnswer("murders for the 5 largest Texas cities in 2023", base as never);
  assert.ok(ssql.some((x) => /state = 'TX' AND type = 'city' AND year = 2023/.test(x)), JSON.stringify(tx).slice(0, 300));
  const ask = shadowAnswer("Compare violent crime rates in the 5 biggest Texas cities", base as never);
  assert.ok(ask.kind === "clarify" && ask.about === "which period", JSON.stringify(ask).slice(0, 300));
  for (const q of ["Show me the homicide rate for the 100 largest US cities in 2026", "drug arrests in the 10 largest cities in 2024"]) {
    const o = shadowAnswer(q, base as never);
    assert.equal(o.kind, "decline", `${q}: never a total in the set's place: ${JSON.stringify(o).slice(0, 200)}`);
  }
}
console.log("nibrs historical: agencies' Part I figures from the Crime Index build, as published; blanks never zero");
