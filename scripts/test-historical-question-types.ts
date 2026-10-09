/*
 * Request accounting, stage 2a (Historical), plan r1.1 tasks 3-4: the closed list of question types H1-H6
 * (lib/historical-question-types.ts) and their compiler (lib/historical-question-compiler.ts).
 *
 * An in-memory database over the saved Historical DDL holds SYNTHETIC rows built so that dropping any slot changes the
 * number. Expected values come from an INDEPENDENT oracle over the same rows in this file, never from the compiler.
 * A combination grid runs every place kind x statistic x period form x family the types accept, and every conflict,
 * raw-token, empty-period and reversed-range case declines by name.
 */
import "./offline-evidence-guard";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { accountHistoricalRequest } from "../lib/historical-request-accounting";
import { matchHistoricalType, consumedBy, exactCount, type HistoricalSpec, type TypeDecision } from "../lib/historical-question-types";
import { compileHistoricalSpec, historicalSourceBounds } from "../lib/historical-question-compiler";
import { historicalLegacyBound } from "../lib/historical-legacy-binding";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else if (!process.env.QUIET) console.log(`  PASS  ${label}`);
}

/* ---------------- synthetic fixture ---------------- */
const db = new Database(":memory:");
const ddl = readFileSync("scripts/fixtures/operation-taxonomy/crime_data.ddl.sql", "utf8").split(";").map((s) => s.trim()).filter((s) => /^CREATE\s+(TABLE|INDEX)/i.test(s) && /historical_|agency_county_crosswalk/.test(s));
for (const stmt of ddl) db.exec(stmt);
db.exec("CREATE TABLE national_clearance_rate (year INTEGER PRIMARY KEY, violent_rate REAL, property_rate REAL, murder_rate REAL, rape_rate REAL, robbery_rate REAL, assault_rate REAL, burglary_rate REAL, theft_rate REAL, auto_theft_rate REAL)");
const ins = (t: string, r: Record<string, unknown>) => { const k = Object.keys(r); db.prepare(`INSERT INTO ${t} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).run(...k.map((x) => r[x] as never)); };
const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const A = [
  { ori: "TXFTW0000", agency: "Fort Worth", state: "tx", type: "city" },
  { ori: "TXARL0000", agency: "Arlington", state: "tx", type: "city" },
  { ori: "TXMRF0000", agency: "Marfa", state: "tx", type: "city" },
  { ori: "TXPLA0000", agency: "Plano", state: "tx", type: "city" },
  { ori: "OHCOL0000", agency: "Columbus", state: "oh", type: "city" },
];
for (const a of A) ins("historical_agency", a);
type Crime = { ori: string; year: number; murder: number | null; robbery: number | null; violent: number | null; property: number | null };
const crime: Crime[] = [];
// Fort Worth 2018-2022, 2020 missing; 2021 robbery NULL (violent NULL); population missing 2021.
for (const [y, m, r] of [[2018, 10, 100], [2019, 11, 110], [2021, 13, null], [2022, 14, 140]] as [number, number, number | null][]) crime.push({ ori: "TXFTW0000", year: y, murder: m, robbery: r, violent: r === null ? null : m + r + 50, property: 1000 + y - 2018 });
for (const y of span(2018, 2022)) crime.push({ ori: "TXARL0000", year: y, murder: 20 + (y - 2018), robbery: 60, violent: 300, property: 2000 });
for (const y of span(2018, 2022)) crime.push({ ori: "TXMRF0000", year: y, murder: y === 2019 ? 0 : 2, robbery: 1, violent: 5, property: 9 });
for (const y of span(2018, 2022)) crime.push({ ori: "TXPLA0000", year: y, murder: 9, robbery: 30, violent: 120, property: 900 });
for (const y of span(2018, 2022)) crime.push({ ori: "OHCOL0000", year: y, murder: 100 + (y - 2018) * 5, robbery: 2000, violent: 6000, property: 41000 });
for (const c of crime) ins("historical_agency_crime", c);
const POP: Record<string, Record<number, number>> = { TXFTW0000: { 2018: 900000, 2019: 910000, 2022: 940000 }, TXARL0000: { 2018: 100000, 2019: 100000, 2020: 100000, 2021: 100000, 2022: 100000 }, TXMRF0000: Object.fromEntries(span(2018, 2022).map((y) => [y, 1800])), TXPLA0000: Object.fromEntries(span(2018, 2022).map((y) => [y, 150000])), OHCOL0000: Object.fromEntries(span(2018, 2022).map((y) => [y, 900000])) };
for (const [ori, ys] of Object.entries(POP)) for (const [y, p] of Object.entries(ys)) ins("historical_agency_population", { ori, year: Number(y), population: p });
for (const y of span(2018, 2022)) ins("historical_agency_clearance", { ori: "TXFTW0000", year: y, murder_clr: y === 2019 ? null : 50 + (y - 2018), violent_clr: 40 });
for (const y of span(2018, 2022)) ins("historical_staffing", { ori: "TXFTW0000", year: y, all_total: y === 2021 ? 0 : 2000, officer_total: y === 2019 ? null : 1500 + y - 2018, civilian_total: 400 });
const SN: Record<string, number> = { Texas: 1, Ohio: 3, "United States": 9 };
for (const [state, k] of Object.entries(SN)) for (const y of span(2018, 2022)) ins("historical_state_national", { state, year: y, population: 1000000 * k, murder: 100 * k + y - 2018, rape: 10 * k, robbery: y === 2019 && state === "Texas" ? null : 20 * k, aggravated_assault: 30 * k, burglary: 40 * k, theft: 50 * k, auto_theft: 60 * k, murder_rate: 3 + k + (y - 2018) / 10, rape_rate: 2, robbery_rate: y === 2019 && state === "Texas" ? null : 4, aggravated_assault_rate: 7, burglary_rate: 8, theft_rate: 9, auto_theft_rate: 10, total_offenses: 1, total_offenses_rate: 1 });
for (const y of span(2018, 2022)) ins("national_clearance_rate", { year: y, murder_rate: y === 2021 ? null : 60 + y - 2018, violent_rate: 45 });

/* ---------------- independent oracle ---------------- */
const NOW = new Date(Date.UTC(2023, 5, 1)); // last complete calendar year 2022
const crimeRow = (ori: string, y: number) => crime.find((c) => c.ori === ori && c.year === y);
const pop = (ori: string, y: number) => POP[ori]?.[y] ?? null;
const ORACLE = {
  agencyCount: (ori: string, y: number, m: "murder" | "robbery" | "violent") => { const r = crimeRow(ori, y); return !r ? { v: null, n: "no report" } : r[m] === null ? { v: null, n: "not reported" } : { v: r[m], n: null }; },
  agencyRate: (ori: string, y: number, m: "murder" | "robbery") => { const c = ORACLE.agencyCount(ori, y, m); if (c.v === null) return c; const p = pop(ori, y); return p === null ? { v: null, n: "no population" } : { v: Math.round(((c.v as number) * 100000 / p) * 10) / 10, n: null }; },
};

/* ---------------- helpers ---------------- */
const ctx = { bounds: (s: Parameters<typeof historicalSourceBounds>[1]) => historicalSourceBounds(db, s), now: NOW };
const decide = (q: string): TypeDecision => matchHistoricalType(accountHistoricalRequest(q), ctx);
const compile = (spec: HistoricalSpec) => compileHistoricalSpec(spec, { db, execute: (sql) => db.prepare(sql).all() as Record<string, unknown>[], now: NOW });
const answer = (q: string) => { const d = decide(q); if (d.kind !== "spec") return { d, c: null }; return { d, c: compile(d.spec) }; };
const cells = (rows: Record<string, unknown>[]) => rows.map((r) => [r.year ?? r.period, r.place, r.measure, r.statistic, r.value, r.note]);

/* ---------------- H1 grid: place x statistic x period ---------------- */
let grid = 0;
const periods: [string, number[]][] = [["in 2019", [2019]], ["from 2018 to 2020", [2018, 2019, 2020]], ["since 2021", [2021, 2022]], ["over the last 2 years", [2021, 2022]], ["between 2019 and 2021", [2019, 2020, 2021]]];
for (const [pw, ys] of periods) {
  for (const stat of ["count", "rate"] as const) {
    grid += 1;
    const q = `murder${stat === "rate" ? " rate" : "s"} in Fort Worth, Texas ${pw}`;
    const { c } = answer(q);
    const want = ys.map((y) => { const o = stat === "rate" ? ORACLE.agencyRate("TXFTW0000", y, "murder") : ORACLE.agencyCount("TXFTW0000", y, "murder"); return [y, "Fort Worth, TX", "murder", stat === "rate" ? "rate_per_100k" : "count", o.v, o.n]; });
    check(Boolean(c && c.kind === "answer" && JSON.stringify(cells(c.rows)) === JSON.stringify(want)), `H1 agency ${stat} ${pw}`);
    grid += 1;
    const sq = `murder${stat === "rate" ? " rate" : "s"} in Ohio ${pw}`;
    const s = answer(sq).c;
    const swant = ys.map((y) => [y, "Ohio", "murder", stat === "rate" ? "rate_per_100k" : "count", stat === "rate" ? Math.round((3 + 3 + (y - 2018) / 10) * 10) / 10 : 300 + y - 2018, null]);
    check(Boolean(s && s.kind === "answer" && JSON.stringify(cells(s.rows)) === JSON.stringify(swant)), `H1 state ${stat} ${pw}`);
  }
}
// Composite measures at state level are component sums; a missing component is no value (never total_offenses).
{
  const { c } = answer("violent crime in Texas from 2018 to 2020");
  check(Boolean(c && c.kind === "answer" && JSON.stringify(cells(c.rows)) === JSON.stringify([[2018, "Texas", "violent", "count", 100 + 10 + 20 + 30, null], [2019, "Texas", "violent", "count", null, "not reported"], [2020, "Texas", "violent", "count", 102 + 10 + 20 + 30, null]])), "H1 state violent = component sum; missing component = no value");
  const t = answer("total crime in Ohio in 2020").c;
  check(Boolean(t && t.kind === "answer" && t.rows[0].value === 302 + 30 + 60 + 90 + 120 + 150 + 180), "H1 total crime = 7-component sum, never total_offenses");
}
// Clearance and staffing.
{
  const c = answer("murder clearance rate in Fort Worth, Texas from 2018 to 2020").c;
  check(Boolean(c && c.kind === "answer" && JSON.stringify(c.rows.map((r) => [r.year, r.value, r.note])) === JSON.stringify([[2018, 50, null], [2019, null, "no clearance figures"], [2020, 52, null]])), "H1 agency clearance with a NULL year");
  const n = answer("national murder clearance rate from 2020 to 2022").c;
  check(Boolean(n && n.kind === "answer" && JSON.stringify(n.rows.map((r) => [r.year, r.value, r.note])) === JSON.stringify([[2020, 62, null], [2021, null, "no clearance figures"], [2022, 64, null]])), "H1 national clearance");
  const s = answer("sworn officers in Fort Worth, Texas from 2018 to 2021").c;
  check(Boolean(s && s.kind === "answer" && JSON.stringify(s.rows.map((r) => [r.year, r.value, r.note])) === JSON.stringify([[2018, 1500, null], [2019, null, "only total employees reported"], [2020, 1502, null], [2021, null, "no staffing reported"]])), "H1 officers: no Employees* substitution");
  const p = answer("officers per 1,000 residents in Fort Worth, Texas in 2018").c;
  check(Boolean(p && p.kind === "answer" && p.rows[0].value === Math.round(1500 * 1000 / 900000 * 10) / 10), "H1 officers per 1,000");
}
// Period totals: summed in code, missing years named; all missing gives no total.
{
  const c = answer("total murders in Fort Worth, Texas from 2018 to 2022 combined").c;
  check(Boolean(c && c.kind === "answer" && c.rows[0].value === 10 + 11 + 13 + 14 && c.rows[0].years_with_reports === 4 && /2020/.test(String(c.rows[0].note))), "H1 period total over reported years, 2020 named");
  const z = answer("total murders in Fort Worth, Texas from 2010 to 2012 combined");
  check(z.d.kind === "decline" || (z.c?.kind === "answer" && z.c.rows[0].value === null) || z.c?.kind === "decline", "H1 period total with no reports is never 0");
}
/* ---------------- H2 / H3 / H5 ---------------- */
{
  const c = answer("murder rate in Columbus, Ohio vs Ohio from 2021 to 2022").c;
  check(Boolean(c && c.kind === "answer" && c.rows.length === 4 && c.rows[0].place === "Columbus, OH" && c.rows[2].place === "Ohio"), "H2 mixed city and state, each its own source");
  const h3 = answer("murders and robberies in Columbus, Ohio in 2020").c;
  check(Boolean(h3 && h3.kind === "answer" && JSON.stringify(h3.rows.map((r) => [r.measure, r.value])) === JSON.stringify([["murder", 110], ["robbery", 2000]])), "H3 two measures, one place");
  const h5 = answer("murder rate by state and year from 2018 to 2019").c;
  check(Boolean(h5 && h5.kind === "answer" && h5.rows.length === 4 && !h5.rows.some((r) => r.place === "United States")), "H5 all states by year excludes the nation");
}
/* ---------------- H4 ---------------- */
{
  const top = answer("top 2 cities in Texas by murders in 2021").c;
  check(Boolean(top && top.kind === "answer" && JSON.stringify(top.rows.map((r) => [r.place, r.value])) === JSON.stringify([["Arlington, TX", 23], ["Fort Worth, TX", 13]])), "H4 top 2 by count");
  check(decide("top 2 cities in Texas by murder rate in 2021").kind === "clarify", "H4 rate ranking with no minimum asks for one");
  const atLeast = answer("top 3 cities in Texas by murder rate in 2021 with at least 100,000 people").c;
  check(Boolean(atLeast && atLeast.kind === "answer" && atLeast.rows.map((r) => r.place).join("|") === "Arlington, TX|Plano, TX"), "H4 at least 100,000 includes the exact boundary (Arlington), excludes a missing population (Fort Worth)");
  const over = answer("top 3 cities in Texas by murder rate in 2021 with over 100,000 people").c;
  check(Boolean(over && over.kind === "answer" && over.rows.map((r) => r.place).join("|") === "Plano, TX"), "H4 over 100,000 is strict");
  const k = answer("top 3 cities in Texas by murder rate in 2021 with at least 100k people").c;
  check(Boolean(k && atLeast && k.kind === "answer" && atLeast.kind === "answer" && JSON.stringify(k.rows) === JSON.stringify(atLeast.rows)), "H4 100k == 100,000");
  check(decide("which state had the highest murder rate in 2021").kind === "spec", "H4 state rate ranking needs no minimum (owner ruling)");
  const noYear = answer("top 2 cities in Texas by murders").c;
  check(Boolean(noYear && noYear.kind === "answer" && noYear.rows[0].year === 2022 && /2022 is the latest year/.test(noYear.explanation)), "H4 with no year uses the latest year, stated");
}
/* ---------------- r2: per-resident lists, coverage ---------------- */
{
  const list = answer("murder rate by city in Texas in 2021").c;
  check(Boolean(list && list.kind === "answer" && list.rows.map((r) => r.place).join("|") === "Arlington, TX|Marfa, TX|Plano, TX" && list.rows.every((r) => r.rank === null) && /alphabetically/.test(list.explanation) && /no population/.test(list.explanation)), "a per-resident LIST needs no minimum, is alphabetical and states the place with no population");
  const thr = answer("murders by city in Texas in 2021 with at least 100,000 people").c;
  check(Boolean(thr && thr.kind === "answer" && /population unknown/.test(thr.explanation) && /below the minimum/.test(thr.explanation)), "a thresholded count list separates unknown population from below the minimum");
}
/* ---------------- r3: fixed-path binding refuses "why" and vacuous ledgers ---------------- */
{
  const peer = { operations: ["peer"], places: (v: string) => v === "city:Philadelphia:PA" || v === "national", measures: ["murder"], change: ["increase", "decrease", "neutral"] as ("increase" | "decrease" | "neutral")[], versus: "any" as const };
  check(historicalLegacyBound(accountHistoricalRequest("How does Philadelphia homicide decline compare to the national average and peer cities?"), peer), "a fixed path owns the request whose parts it applies");
  check(!historicalLegacyBound(accountHistoricalRequest("Why did Philadelphia homicides decline compared to the national average and peer cities?"), peer), "a fixed path never owns a request carrying why");
  check(!historicalLegacyBound(accountHistoricalRequest("hello there"), { operations: ["coverage-lookup"] }), "a fixed path never owns an unrecognized request");
  // "thanks" is all context: no part is left for a path to apply, so only the r3 minimum (>= 1 applied part) refuses it.
  check(!historicalLegacyBound(accountHistoricalRequest("thanks"), { operations: ["coverage-lookup"] }), "no vacuous ownership of a ledger with no applicable part");
}
/* ---------------- H6 ---------------- */
{
  const ch = answer("change in murders in Fort Worth, Texas from 2018 to 2022").c;
  check(Boolean(ch && ch.kind === "answer" && ch.rows[0].change === 4 && ch.rows[0].percent_change === Math.round(4 / 10 * 1000) / 10), "H6 change and percent change (earlier year is the base)");
  const vs = answer("Fort Worth, Texas murders 2022 vs 2018").c;
  check(Boolean(vs && ch && vs.kind === "answer" && ch.kind === "answer" && JSON.stringify(vs.rows) === JSON.stringify(ch.rows)), "H6 \"2022 vs 2018\" equals \"from 2018 to 2022\"");
  const rate = decide("change in the murder rate in Fort Worth, Texas from 2018 to 2022");
  check(rate.kind === "spec" && rate.spec.type === "H6" && rate.spec.base === "rate_per_100k", "H6 keeps the base statistic (rate)");
  const zero = answer("percent change in murders in Marfa, Texas from 2019 to 2020").c;
  check(Boolean(zero && zero.kind === "answer" && zero.rows[0].percent_change === null && /base of 0/.test(String(zero.rows[0].note))), "H6 a base of 0 gives no percent change");
  const missing = answer("change in murders in Fort Worth, Texas from 2020 to 2022").c;
  check(Boolean(missing && missing.kind === "answer" && missing.rows[0].change === null && /2020/.test(String(missing.rows[0].note))), "H6 a missing endpoint is named, never moved");
  const since = answer("how much have murders changed in Columbus, Ohio since 2019").c;
  check(Boolean(since && since.kind === "answer" && since.rows[0].later_year === 2022), "H6 since: the later year is the data anchor");
}
/* ---------------- declines and clarifications (named) ---------------- */
const declines: [string, RegExp][] = [
  ["change in murders in Fort Worth, Texas from 2022 to 2018", /ends before it starts/],
  ["murders in Fort Worth, Texas from 2022 to 2018", /ends before it starts/],
  ["murders in Ohio after 2022", /2022/],
  ["top 60 cities in Texas by murders in 2021", /up to 50/],
  ["top 2 cities in Texas by murders in 2021, top 3", /two different numbers/],
  ["top 3 cities in Texas by murder rate in 2021 with at least 9007199254740993 people", /9007199254740993/],
  ["top 3 cities in Texas by murder rate in 2021 with at least 100,000 people and over 100,000 people", /more than one population limit/],
  ["top 3 cities in Texas by murder rate in 2021 with under 200,000 people", /not a maximum/],
  ["top 3 cities in Texas by murder clearance rate in 2021", /clearance/],
  ["top 3 cities in Texas by murders from 2019 to 2021", /one year/],
  ["murders and the robbery rate in Columbus, Ohio in 2020", /counts or rates/],
  ["murders per 10,000 residents in Fort Worth, Texas in 2020", /10,000/],
  ["murder clearance rate in Texas in 2020", /statewide murder clearance rate for Texas/],
  ["total police officers in Texas in 2020", /staffing/],
  ["total murders in Fort Worth, Texas and Columbus, Ohio together in 2020", /add places together/],
  ["change in murders in Fort Worth, Texas from 2018-2019 to 2021-2022", /single years/],
  ["change in the murder clearance rate in Fort Worth, Texas from 2018 to 2022", /clearance/],
  ["murders by city in 2021", /name a state|top N/],
];
for (const [q, re] of declines) {
  const d = decide(q);
  check((d.kind === "decline" || d.kind === "clarify") && re.test(d.explanation), `declined by name: ${q}`);
}
check(decide("crime clearance rates by county in Massachusetts").kind === "clarify", "clearance with no offense asks which offense");
check(decide("murders in Washington since 2010").kind === "clarify", "an ambiguous place asks");

/* ---------------- the gate is value-level ---------------- */
{
  const d = decide("top 3 cities in Texas by murder rate in 2021 with at least 100,000 people");
  if (d.kind === "spec") {
    const l = accountHistoricalRequest("top 3 cities in Texas by murder rate in 2021 with at least 100,000 people");
    const t = l.parts.find((p) => p.concept === "threshold")!;
    check(consumedBy(d.spec, t), "the threshold part is consumed by the spec carrying its value");
    check(!consumedBy({ ...d.spec, min: { op: ">", amount: 100000, token: "100000" } } as HistoricalSpec, t), "a spec with a different operator does not consume it");
    check(!consumedBy({ ...d.spec, rank: { dir: "top", n: 5, stated: true } } as HistoricalSpec, l.parts.find((p) => p.concept === "rank")!), "a spec with a different rank count does not consume it");
  } else check(false, "threshold spec issued");
  check(exactCount("9007199254740993") === null && exactCount("100000") === 100000, "exactCount keeps only lossless values");
}

console.log(`\n${checks - failures}/${checks} passed (H1 grid ${grid} questions)`);
if (failures > 0) process.exit(1);
