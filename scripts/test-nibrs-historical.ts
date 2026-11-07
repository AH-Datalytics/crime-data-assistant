/**
 * Historical in the new engine (P75-P79): agencies' Part I figures from the Crime Index build, read as published.
 * Offline: a stub executor stands in for DuckDB over the build (scripts/build-crimeindex.py), and its SQL is checked.
 */
import assert from "node:assert/strict";
import { answerBeside, answerHistorical, historicalRate, historicalUnitFits, type HistoricalBuild, type HistoricalQuestion } from "../lib/nibrs-shadow/historical";
import { SRS_SOURCE } from "../lib/nibrs-shadow/deliver";
import { shadowAnswer, shadowFollowUp, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
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
};
const NAMES: Record<string, string> = { TNMPD0000: "Memphis", TN9999900: "Example Town", TXDPD0000: "Dallas" };
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
  // 01.2: a population question with its own place, after a crime question, is a question of its own.
  const after = shadowFollowUp("Murders in Memphis in 2023", "Population of Tennessee in 2023", base);
  assert.ok(after.kind === "historical" && JSON.stringify(after.delivered.table.rows) === "[[7148304]]", JSON.stringify(after).slice(0, 300));
  // 11b: a state's agencies with their populations, largest first; one with none listed last, blank, never dropped.
  const tn = pop("List of Tennessee law enforcement agencies ordered by population in 2023");
  assert.deepEqual(tn.delivered.table.rows, [["Memphis, Tennessee", 616061], ["Example Town, Tennessee", null]]);
  assert.deepEqual(tn.question.list, { state: "TN", count: 2, top: [{ label: "Memphis, Tennessee", population: 616061 }] });
  assert.ok(tn.delivered.text.includes("1 agency has no population for 2023, listed last, blank."), JSON.stringify(tn.delivered.text));
  assert.equal(pop("which agencies are in Tennessee in 2023").delivered.table.rows.length, 2);
  assert.equal(shadowAnswer("List of Tennessee agencies", base).kind, "clarify", "no year: asked");
  for (const q of ["which agencies are in Cook County, Illinois in 2023", "agencies in Tennessee that report to NIBRS in 2023", "List all agencies in Texas with type County in 2023", "murders by agency in Tennessee in 2023"]) {
    const o = shadowAnswer(q, base);
    assert.ok(!(o.kind === "historical" && o.question.list), `${q}: ${JSON.stringify(o).slice(0, 200)}`);
  }
  for (const q of ["murders and population in Memphis in 2023", "murder rate in Memphis in 2023", "population of Memphis and Tennessee combined in 2023"])
    assert.ok(!(shadowAnswer(q, base).kind === "historical" && (shadowAnswer(q, base) as { question: { measure: string } }).question.measure === "population"), q);
}

console.log("nibrs historical: agencies' Part I figures from the Crime Index build, as published; blanks never zero");
