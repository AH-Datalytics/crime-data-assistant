/**
 * Historical in the new engine (P75-P79): agencies' Part I figures from the Crime Index build, read as published.
 * Offline: a stub executor stands in for DuckDB over the build (scripts/build-crimeindex.py), and its SQL is checked.
 */
import assert from "node:assert/strict";
import { answerHistorical, type HistoricalBuild, type HistoricalQuestion } from "../lib/nibrs-shadow/historical";
import { SRS_SOURCE } from "../lib/nibrs-shadow/deliver";

const build: HistoricalBuild = { root: "/ci", release: "crimeindex-20261101", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 };
// Memphis 2022-2023 as published (crimeindex.org page API, 2026-11-01: 2023 violent 16,091, population 616,061, rate 2,611.9);
// 2021's murder count is blank in this stub (not available, not zero); Dallas has 2023 only.
const CRIME: Record<string, Record<number, [number | null, number | null, number | null]>> = {
  TNMPD0000: { 2021: [null, null, 628127], 2022: [252, 40.3, 624944], 2023: [351, 57.0, 616061] },
  TXDPD0000: { 2023: [246, 18.7, 1302868] },
};
const sqls: string[] = [];
function stub(sql: string): unknown[][] {
  sqls.push(sql);
  const oris = [...sql.matchAll(/'([A-Z]{2}[A-Z0-9]{7})'/g)].map((m) => m[1]);
  if (/agency_clearances/.test(sql)) return /TNMPD0000/.test(sql) && /year = 2023/.test(sql) ? [[15.1, 53, 351]] : [];
  const between = /year BETWEEN (\d{4}) AND (\d{4})/.exec(sql), years = /year IN \((\d{4}), (\d{4})\)/.exec(sql);
  const out: unknown[][] = [];
  for (const o of oris) for (const [y, [t, c, p]] of Object.entries(CRIME[o] ?? {})) {
    const yr = Number(y);
    if (between && (yr < Number(between[1]) || yr > Number(between[2]))) continue;
    if (years && yr !== Number(years[1]) && yr !== Number(years[2])) continue;
    out.push(years ? [yr, t] : [o, yr, t, c, p]);
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
assert.match(one.delivered.text.join(" "), /as published by Crime Index; a blank means the figure is not available in this data, not zero/);
assert.ok(sqls.every((s) => s.includes("/ci/agency_")), "reads the build only");
assert.deepEqual(one.meaning.places, [{ kind: "agency", name: "Memphis", state: "TN" }]);
assert.equal(one.meaning.source, "historical");

// P75: the published rate (one decimal), never one calculated; no rate published: blank, said, not computed.
const rate = ok({ statistic: "rate" });
assert.deepEqual(rate.delivered.table.rows, [[57]]);
assert.equal(rate.delivered.text[0], "Memphis, Tennessee: 57.0 murders per 100,000 residents in 2023.");
assert.equal(rate.read.column, "murder_capita");
assert.match(no({ statistic: "rate", from: 2021, to: 2021 }), /^Crime Index has no murder rate for Memphis, Tennessee in 2021: not available in this data\.$/);

// A blank is not available, never zero: a single year declines, a series shows it blank and names it.
assert.match(no({ from: 2021, to: 2021 }), /not available in this data/);
const series = ok({ from: 2021, to: 2023, byYear: true });
assert.deepEqual(series.delivered.table.rows, [["2021", null], ["2022", 252], ["2023", 351]]);
assert.ok(series.delivered.text.includes("Not available in this data: 2021."));

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
assert.equal(clr.delivered.text[0], "Memphis, Tennessee: 15.1% of murders were cleared in 2023 (53 of 351).");
assert.equal(clr.read.column, "murder_cleared_rate");
assert.match(no({ statistic: "clearance_rate", from: 1950, to: 1950 }), /clearance figures in the data cover 1960 through 2025/);
assert.match(no({ statistic: "clearance_rate", from: 2022, to: 2022 }), /no murder clearance rate for Memphis, Tennessee in 2022/);

// Several agencies: side by side, never combined; one year a row each, a span a column each; blanks named per agency.
const pair = ok({ agencies: [memphis, dallas] });
assert.deepEqual(pair.delivered.table.rows, [["Memphis, Tennessee", 351], ["Dallas, Texas", 246]]);
assert.deepEqual(pair.meaning.groupings, ["agency"]);
const pairs = ok({ agencies: [memphis, dallas], from: 2022, to: 2023, byYear: true });
assert.deepEqual(pairs.delivered.table.rows, [["2022", 252, null], ["2023", 351, 246]]);
assert.ok(pairs.delivered.text.includes("Not available in this data: Dallas, Texas 2022."));
assert.ok(!pairs.delivered.text.some((t) => /combined|total of/i.test(t)));

// The agencies named by their FBI names, second, and never "reported by" (the file is what Crime Index published).
const named = ok({ agencyLine: "Figures for the Memphis Police Department." });
assert.equal(named.delivered.text[1], "Figures for the Memphis Police Department.");
assert.ok(!named.delivered.text.some((t) => /reported by/i.test(t)));

// Not a Historical measure: declined, never guessed.
assert.match((answerHistorical({ measure: "shoplifting", agencies: [memphis], from: 2023, to: 2023, byYear: false, statistic: "count", comparison: null }, build, stub) as { explanation: string }).explanation, /seven Part I offenses only/);

console.log("nibrs historical: agencies' Part I figures from the Crime Index build, as published; blanks never zero");
