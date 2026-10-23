/**
 * Stage 3a (Current Trends): compile a supported question type (lib/current-question-types.ts) into application-built
 * statements and an answer (plan docs/superpowers/plans/2026-10-10-request-accounting-stage3a-current.md r1.2, and
 * 2026-10-11-request-accounting-stage3a-current-r2.md r2.1).
 *
 * Rules that bind every answer here:
 *   - ABSENCE IS NOT ZERO (§4.2). An agency-month with no row, or a missing offense row inside a reported month, is "no
 *     report": the cell is null and named, never 0. A period total is shown only when every month in it was reported.
 *   - THE SAMPLE IS NOT THE WHOLE (r1.1 F2). National and state values come from agency_monthly x sample_agencies, never
 *     from national_monthly or state_monthly; a category counts only agencies with EVERY offense of the category that
 *     month; each month states how many sample agencies reported; a total across months (a period total, or a rolling
 *     window: r2 F3a) is shown only when the same agencies reported in every month of it.
 *   - RATES (r1.1 F4) only for agencies (ruling 3): a month is count x 100,000 / that year's population (not annualized);
 *     a year or year-to-date span is its sum over that year's population; a rolling window is its sum over the
 *     months-weighted population of the same twelve months. No population on file: no rate, named.
 *   - ONE SNAPSHOT (r2 F2): the fixed comparison group's four statements run in one `runMany` call (one worker, one
 *     read transaction), and a period total is null unless every required cell of it has a group row.
 *   - WHAT WAS APPLIED is written only by the CurrentTypedQuery builder (per statement) and at the computing lines
 *     (tagged `// applied-site:`), never from the spec (2b L13). scripts/test-current-typed-applied-sites.ts pins this.
 *   - OPERANDS ARE CHECKED AGAINST EACH OTHER (r2 F4, r2.1): rates, peers, the fixed group, several places or measures,
 *     and every change pair, before an answer is composed, by the ORIs and months the statements actually used.
 */
import { placeIs, periodValuesOfMonths, type CurrentApplied, type PlaceSet } from "./current-legacy-binding";
import { OFFENSES_OF, ALL7, MEASURE_LABEL, STATE_NAME_BY_CODE, type CurrentSpec, type CPlace, type CPeriod, type SeriesSpec, type ChangeSpec, type PeerSpec } from "./current-question-types";
import { currentYoyGroupStatements } from "./current-yoy-comparison-deterministic";
import { recordWhyFacts } from "./why-scope";
import type { ChartConfig } from "./types";

export type Row = Record<string, string | number | null>;
export type CompiledAnswer =
  | { kind: "answer"; sql: string; columns: string[]; rows: Row[]; title: string; explanation: string; chartConfig: ChartConfig | null; applied: CurrentApplied; requestedEntities: string[]; returnedEntities: string[]; /** Stage 3b (r1.3 producer addition): the answer-level notes as data, for "why" facts. */ notes?: string[] }
  | { kind: "decline"; explanation: string };
/** `runMany` runs its statements in ONE read transaction (the route wires it to executeManyWithTimeoutSync). */
export type CompileContext = { run: (sql: string) => Record<string, unknown>[]; runMany: (sqls: string[]) => Record<string, unknown>[][] };

export const COLUMNS = ["period", "place", "measure", "statistic", "value", "note"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const pad = (n: number) => String(n).padStart(2, "0");
const ymKey = (y: number, m: number) => `${y}-${pad(m)}`;
const monthName = ([y, m]: [number, number]) => `${MONTH_NAMES[m - 1]} ${y}`;
const r1 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const fmt = (n: number) => n.toLocaleString("en-US");
type YM = [number, number];

/* ================================================================== the typed query builder ===================== */

/**
 * The ONLY writer of what a typed statement applied. Each method emits one SQL fragment and records exactly what that
 * fragment restricts, in the same call -- including the ORIs it actually restricts to (r2.1). `fixed()` and `join()` emit
 * table semantics that are not request parts and record nothing. scripts/test-current-typed-applied-sites.ts pins this.
 */
type OperandRole = "value" | "denominator" | "window" | "candidates" | "coverage" | "membership" | "group";
export type OperandRecord = { role: OperandRole; table: string; offenses: string[]; months: string[]; years: number[]; oris: string[]; place: PlaceSet | null; entities: string[]; scope: string | null };
class CurrentTypedQuery {
  readonly rec: OperandRecord;
  private readonly conds: string[] = [];
  private readonly joins: string[] = [];
  private readonly keys: string[] = [];
  private readonly cols: string[] = [];
  constructor(role: OperandRole, private readonly from: string) {
    this.rec = { role, table: from, offenses: [], months: [], years: [], oris: [], place: null, entities: [], scope: null };
  }
  offenses(col: string, list: string[]): this { this.conds.push(`${col} IN (${list.map(q).join(", ")})`); this.rec.offenses = [...list]; return this; }
  months(yearCol: string, monthCol: string, list: YM[]): this {
    const keys = [...new Set(list.map(([y, m]) => y * 100 + m))].sort((a, b) => a - b);
    this.conds.push(`(${yearCol} * 100 + ${monthCol}) IN (${keys.join(", ")})`);
    this.rec.months = keys.map((k) => ymKey(Math.floor(k / 100), k % 100));
    return this;
  }
  years(col: string, list: number[]): this { const ys = [...new Set(list)].sort((a, b) => a - b); this.conds.push(`${col} IN (${ys.join(", ")})`); this.rec.years = ys; return this; }
  agency(oriCol: string, ori: string, place: Extract<CPlace, { kind: "agency" }>): this {
    this.conds.push(`${oriCol} = ${q(ori)}`);
    this.rec.oris = [ori]; this.rec.place = placeIs.agency(place.name, place.state); this.rec.entities.push("agency", place.agencyKind); return this;
  }
  agencies(oriCol: string, oris: string[]): this { this.conds.push(`${oriCol} IN (${oris.map(q).join(", ")})`); this.rec.oris = [...oris]; this.rec.entities.push("city"); return this; }
  excludeAgency(oriCol: string, ori: string): this { this.conds.push(`${oriCol} <> ${q(ori)}`); return this; }
  sample(stateCol: string, place: Extract<CPlace, { kind: "national" | "state" }>): this {
    if (place.kind === "state") { this.conds.push(`${stateCol} = ${q(place.code)}`); this.rec.place = placeIs.state(place.name); this.rec.scope = place.code; }
    else { this.rec.place = placeIs.national; this.rec.scope = "US"; }
    return this;
  }
  fixed(cond: string): this { this.conds.push(cond); return this; }
  join(clause: string): this { this.joins.push(clause); return this; }
  group(expr: string, alias: string): this { this.cols.push(`${expr} AS ${alias}`); this.keys.push(alias); return this; }
  value(expr: string, alias: string): this { this.cols.push(`${expr} AS ${alias}`); return this; }
  sql(): string {
    const where = this.conds.length ? ` WHERE ${this.conds.join(" AND ")}` : "";
    const group = this.keys.length ? ` GROUP BY ${this.keys.join(", ")} ORDER BY ${this.keys.join(", ")}` : "";
    return `SELECT ${this.cols.join(", ")} FROM ${this.from}${this.joins.length ? ` ${this.joins.join(" ")}` : ""}${where}${group}`;
  }
} // end CurrentTypedQuery

/* ================================================================== operands -> applied ========================== */

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
function measureOfOffenses(offenses: string[]): string | null {
  for (const [id, offs] of Object.entries(OFFENSES_OF)) if (sameSet(offs, offenses)) return id;
  return null;
}

/**
 * What the answer applied, from its statements' records only: places, the measure of each value operand's offense set,
 * and the period values its value months correspond to. Post-query operations are added by `post` at their lines.
 */
function appliedFrom(ops: OperandRecord[], cutoff: { year: number; month: number }): CurrentApplied {
  const a: CurrentApplied = { measures: [], periodValues: [], grains: [], change: [], entities: [] };
  // Value, rolling-window and fixed-group statements carry the place and the offenses; only value statements' months are
  // the periods the answer reports (a window's months are inputs; rolling endpoints and change periods are recorded where
  // they are computed).
  const reading = ops.filter((o) => o.role === "value" || o.role === "window" || o.role === "group");
  const places: PlaceSet[] = [];
  for (const o of reading) {
    if (o.place) places.push(o.place);
    const m = measureOfOffenses(o.offenses);
    if (m && !a.measures!.includes(m)) a.measures!.push(m);
    for (const e of o.entities) if (!a.entities!.includes(e)) a.entities!.push(e);
    if (o.role !== "value") continue;
    const months = o.months.map((k) => k.split("-").map(Number) as YM);
    for (const v of periodValuesOfMonths(months, cutoff)) if (!a.periodValues!.includes(v)) a.periodValues!.push(v);
  }
  if (ALL7.every((m) => a.measures!.includes(m))) a.measures!.push("all7");
  a.places = placeIs.any(...places);
  return a;
}
/** Post-query operations, recorded at the line that performs them (each call is an allowlisted applied-site). */
function post(a: CurrentApplied): { set<K extends keyof CurrentApplied>(k: K, v: CurrentApplied[K]): void; push(k: "grains" | "periodValues" | "change" | "entities" | "measures", v: string): void } {
  return {
    set: (k, v) => { a[k] = v; },
    push: (k, v) => { const arr = (a[k] ?? (a[k] = [] as never)) as string[]; if (!arr.includes(v)) arr.push(v); },
  };
}

/* ================================================================== operand checks (r2 F4, r2.1) ================ */

const keysOf = (ms: YM[]) => ms.map(([y, m]) => ymKey(y, m)).sort();
const sameKeys = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
export const operandFailure = (what: string) => `I couldn't confirm that every part of this answer used ${what}, so I haven't answered with a number that may not match the question.`;

/** A rate: the denominator read the SAME agency (by ORI) and every year the value's months fall in. */
export function checkRateOperands(value: OperandRecord, denominator: OperandRecord, yearsNeeded: number[]): string | null {
  if (!sameSet(value.oris, denominator.oris) || value.oris.length !== 1) return "the same agency for the count and the population";
  if (!yearsNeeded.every((y) => denominator.years.includes(y))) return "the population of every year the figures cover";
  return null;
}
/** Several value statements of one answer: identical except in the one thing that differs between them. */
export function checkSameShape(values: OperandRecord[], varies: "place" | "offenses"): string | null {
  for (const o of values.slice(1)) {
    if (!sameKeys(o.months, values[0].months)) return "the same months for every series";
    if (varies === "place" && !sameSet(o.offenses, values[0].offenses)) return "the same offenses for every place";
    if (varies === "offenses" && !sameSet(o.oris, values[0].oris)) return "the same place for every offense";
  }
  return null;
}
/** C6: candidates from the population year, coverage over the period and offenses, series only for the selection. */
export function checkPeerOperands(o: { membership: OperandRecord; candidates: OperandRecord; coverage: OperandRecord; values: OperandRecord[]; popYear: number; months: YM[]; offenses: string[]; target: string; selected: string[] }): string | null {
  if (!sameSet(o.membership.oris, [o.target]) || !sameSet(o.membership.years.map(String), [String(o.popYear)])) return "the city's own population in the period's last year to set its group";
  if (!sameSet(o.candidates.years.map(String), [String(o.popYear)])) return "the same population year for every city in the group";
  if (!sameKeys(o.coverage.months, keysOf(o.months)) || !sameSet(o.coverage.offenses, o.offenses)) return "the requested months and offenses to check which cities reported";
  if (!o.selected.every((ori) => o.coverage.oris.includes(ori))) return "a coverage check for every city shown";
  for (const v of o.values) {
    if (v.oris.length !== 1 || ![o.target, ...o.selected].includes(v.oris[0])) return "only the city asked about and the cities selected";
    if (!sameKeys(v.months, keysOf(o.months)) || !sameSet(v.offenses, o.offenses)) return "the same months and offenses for every city";
  }
  return null;
}
/** The fixed comparison group: exactly the periods' months, the measure's offenses, the place's scope. */
export function checkGroupOperands(g: OperandRecord, months: YM[], offenses: string[], scope: string): string | null {
  if (!sameKeys(g.months, keysOf(months))) return "every month of every period being compared";
  if (!sameSet(g.offenses, offenses)) return "the requested offenses for the comparison group";
  if (g.scope !== scope) return "the requested place for the comparison group";
  return null;
}
/**
 * r3: a change endpoint is a record produced WHERE ITS VALUE IS COMPUTED -- the identity of the operand that supplied the
 * cells (an agency's ORI, or the fixed group's scope), the offenses and the months actually summed, the statistic and, for
 * a rate, the denominator year actually divided by. A null value still carries the months it tried.
 */
export type Endpoint = { value: number | null; identity: string; offenses: string[]; statistic: "count" | "rate"; months: YM[]; denominatorYear: number | null; notes: string[] };
/**
 * r3: one change pair, checked on its computed endpoints before any change is computed from them: the same identity on
 * both sides and equal to the place's resolved identity; the requested offenses and statistic; each endpoint's months
 * exactly its reported period's; A strictly before B; a rate's denominator year its own period's year.
 */
export function checkEndpointPair(a: Endpoint, b: Endpoint, periodA: YM[], periodB: YM[], identity: string, offenses: string[], statistic: "count" | "rate"): string | null {
  const what = "the computed values for each period of the change";
  for (const [e, period] of [[a, periodA], [b, periodB]] as const) {
    if (e.identity !== identity) return `${what} (one was computed for another place)`;
    if (!sameSet(e.offenses, offenses) || e.statistic !== statistic) return `${what} (offense or statistic)`;
    if (!sameKeys(keysOf(e.months), keysOf(period))) return `${what} (a value was computed over other months than its period)`;
    if (statistic === "rate" && e.value !== null) {
      const years = [...new Set(period.map(([y]) => y))];
      if (years.length !== 1 || e.denominatorYear !== years[0]) return `${what} (a rate's population year)`;
    }
  }
  const lastA = a.months[a.months.length - 1]; const firstB = b.months[0];
  if (!lastA || !firstB || !(lastA[0] * 100 + lastA[1] < firstB[0] * 100 + firstB[1])) return `${what} (the earlier period must come first)`;
  return null;
}

/* ================================================================== source facts ================================ */

type Bounds = { lo: YM; hi: YM };
function bounds(ctx: CompileContext): Bounds | null {
  const row = ctx.run("SELECT MIN(year * 100 + month) AS lo, MAX(year * 100 + month) AS hi FROM agency_monthly")[0]; // lookup: source-bounds
  const lo = Number(row?.lo); const hi = Number(row?.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) return null;
  return { lo: [Math.floor(lo / 100), lo % 100], hi: [Math.floor(hi / 100), hi % 100] };
}
type Agency = { ori: string; label: string; type: string };
/**
 * Option 3 batch 1 (codex build ruling item 4): a county name resolves to the county agency's own record (the adopted
 * single-agency default, lib/county-clarifier.ts), so the answer says so: the rate is that agency's, not countywide.
 */
const countyAgencyNote = (a: Agency): string | null =>
  a.type === "County" ? `${a.label} here is the county agency's own Current Trends record and its reported population, not a total for every agency in the county.` : null;
function resolveAgency(ctx: CompileContext, p: Extract<CPlace, { kind: "agency" }>): Agency | { decline: string } {
  const name = p.agencyKind === "county" && !/county$/i.test(p.name) ? `${p.name} County` : p.name;
  const stateCond = p.state ? ` AND state = ${q(p.state)}` : "";
  // Round 1 Q1 ("Montgomery County, MD" was "not one of the agencies"): Current Trends stores a county agency under the bare
  // county name with type County ("Montgomery"), so a county question also matches that bare name, for County rows only.
  const bare = p.agencyKind === "county" ? name.replace(/\s+county$/i, "") : null;
  const countyBare = bare && bare.toUpperCase() !== name.toUpperCase() ? ` OR (UPPER(agency) = UPPER(${q(bare)}) AND type = 'County')` : "";
  const rows = ctx.run(`SELECT DISTINCT ori, agency, state, type FROM agency_monthly WHERE (UPPER(agency) = UPPER(${q(name)})${countyBare})${stateCond}`); // lookup: agency-resolution
  const want = p.agencyKind === "county" ? "County" : "City";
  const typed = rows.filter((r) => String(r.type) === want);
  const pick = typed.length ? typed : rows;
  if (pick.length === 0) {
    const base = `"${p.text.trim()}" isn't one of the agencies in Current Trends, so I can't answer for it.`;
    // Round 1 Q1 (owner decision B, 2026-10-23): a county with no county agency of its own names the one or two most
    // populous Current Trends agencies inside it (county crosswalk + latest population on file), so the reader can ask
    // about those. Never a county total.
    if (p.agencyKind === "county" && p.state && bare) {
      const inCounty = ctx.run(`SELECT am.agency AS agency, am.state AS state, am.type AS type, (SELECT population FROM agency_population ap WHERE ap.ori = am.ori ORDER BY year DESC LIMIT 1) AS pop FROM (SELECT DISTINCT ori, agency, state, type FROM agency_monthly WHERE state = ${q(p.state)}) am JOIN agency_county_crosswalk x ON x.ori9 = am.ori WHERE x.state = ${q(p.state)} AND x.county_key = UPPER(${q(bare)}) ORDER BY pop DESC LIMIT 2`); // lookup: county-agencies
      const names = inCounty.map((r) => `${String(r.type) === "County" && !/county$/i.test(String(r.agency)) ? `${r.agency} County` : r.agency}, ${r.state}`);
      if (names.length) return { decline: `${base} Current Trends does have ${names.length === 1 ? names[0] : `${names[0]} and ${names[1]}`} in ${bare} County; you can ask about ${names.length === 1 ? "it" : "either"}.` };
      return { decline: `${base} Current Trends has no agencies in ${bare} County.` };
    }
    return { decline: `${base} I haven't answered with a number that leaves it out.` };
  }
  if (pick.length > 1) return { decline: `"${p.text.trim()}" matches more than one Current Trends agency; please add the state.` };
  // Round 1 Q1: a county agency stored under its bare name reads "Montgomery County, MD", never like the city.
  const agencyName = String(pick[0].type) === "County" && !/county$/i.test(String(pick[0].agency)) ? `${pick[0].agency} County` : String(pick[0].agency);
  return { ori: String(pick[0].ori), label: `${agencyName}, ${pick[0].state}`, type: String(pick[0].type) };
}
const between = (a: YM, b: YM): YM[] => { const out: YM[] = []; let [y, m] = a; while (y * 100 + m <= b[0] * 100 + b[1]) { out.push([y, m]); m += 1; if (m > 12) { m = 1; y += 1; } } return out; };
const shift = ([y, m]: YM, d: number): YM => { const t = y * 12 + (m - 1) + d; return [Math.floor(t / 12), (t % 12) + 1]; };
const cmp = (a: YM, b: YM) => a[0] * 100 + a[1] - (b[0] * 100 + b[1]);
const inBounds = (b: Bounds, x: YM) => cmp(x, b.lo) >= 0 && cmp(x, b.hi) <= 0;
const spanLabel = (ms: YM[]) => (ms.length === 1 ? ymKey(...ms[0]) : `${ymKey(...ms[0])} to ${ymKey(...ms[ms.length - 1])}`);
const describeSpan = (ms: YM[]) => (ms.length === 1 ? monthName(ms[0]) : `${monthName(ms[0])} through ${monthName(ms[ms.length - 1])}`);
const fullYear = (ms: YM[]) => ms.length === 12 && ms[0][1] === 1 && ms.every(([y]) => y === ms[0][0]);
const periodLabel = (ms: YM[]): string | number => (fullYear(ms) ? ms[0][0] : spanLabel(ms));
const windowOf = (end: YM): YM[] => between(shift(end, -11), end);
const unionWindows = (ends: YM[]): YM[] => [...new Map(ends.flatMap(windowOf).map((x) => [ymKey(...x), x] as const)).values()].sort(cmp);

type Resolved = { months: YM[]; notes: string[] };
/** The months a period names, against the source's measured bounds. Explicit forms are never moved; gaps are named. */
function monthsOf(p: CPeriod, b: Bounds, first: YM | null): Resolved | { decline: string } {
  const range = `Current Trends covers ${monthName(b.lo)} through ${monthName(b.hi)}`;
  const latestFull = b.hi[1] === 12 ? b.hi[0] : b.hi[0] - 1;
  const clip = (want: YM[], what: string): Resolved | { decline: string } => {
    const inside = want.filter((x) => inBounds(b, x));
    if (!inside.length) return { decline: `There's no Current Trends data for ${what}; ${range}. I haven't answered with a number that leaves it out.` };
    const notes: string[] = [];
    const before = want.filter((x) => cmp(x, b.lo) < 0);
    const after = want.filter((x) => cmp(x, b.hi) > 0);
    if (before.length) notes.push(`There's no data in this source before ${monthName(b.lo)}, so ${describeSpan(before)} isn't included.`);
    if (after.length) notes.push(`${range}, so ${describeSpan(after)} isn't included.`);
    return { months: inside, notes };
  };
  switch (p.form) {
    case "year": return clip(between([p.year, 1], [p.year, 12]), String(p.year));
    case "month": return inBounds(b, [p.year, p.month]) ? { months: [[p.year, p.month]], notes: [] } : { decline: `There's no Current Trends data for ${monthName([p.year, p.month])}; ${range}. I haven't answered with a number that leaves it out.` };
    case "monthrange": {
      if (!inBounds(b, p.from) || !inBounds(b, p.to) || cmp(p.from, p.to) > 0) return { decline: `There's no Current Trends data for all of ${monthName(p.from)} through ${monthName(p.to)}; ${range}. I haven't answered with a number that leaves it out.` };
      return { months: between(p.from, p.to), notes: [] };
    }
    case "range": return clip(between([p.from, 1], [p.to, 12]), `${p.from}-${p.to}`);
    case "since": return clip(between([p.from, 1], b.hi), `since ${p.from}`);
    case "last": return clip(between([latestFull - p.n + 1, 1], [latestFull, 12]), `the last ${p.n} years`);
    case "lastyear": case "latest": return clip(between([latestFull, 1], [latestFull, 12]), String(latestFull));
    case "latestmonth": return { months: [b.hi], notes: [`The latest month in Current Trends is ${monthName(b.hi)}.`] };
    case "ytd": return { months: between([b.hi[0], 1], b.hi), notes: [] };
    case "none": return { months: between(first ?? b.lo, b.hi), notes: [`No period was named, so this covers ${monthName(first ?? b.lo)} through ${monthName(b.hi)}.`] };
  }
}
/** A relative period form resolved to exactly the months read (r2 F1): recorded only when they match. */
function relativeValue(p: CPeriod, months: YM[], b: Bounds): string | null {
  const latestFull = b.hi[1] === 12 ? b.hi[0] : b.hi[0] - 1;
  const same = (want: YM[]) => want.length === months.length && want.every((x, i) => cmp(x, months[i]) === 0);
  if (p.form === "last" && same(between([latestFull - p.n + 1, 1], [latestFull, 12]))) return `last:${p.n}`;
  if ((p.form === "lastyear" || p.form === "latest") && same(between([latestFull, 1], [latestFull, 12]))) return p.form;
  if (p.form === "latestmonth" && same([b.hi])) return "latestmonth";
  if (p.form === "ytd" && same(between([b.hi[0], 1], b.hi))) return "ytd";
  return null;
}

/**
 * Buckets for a grain: one total, one per month, or one per year. A total over a partial span is labeled as its span.
 * A per-year bucket keeps its numeric year even when partial (round 1 D3: a string label in a numeric year column was
 * dropped from the chart and broke year formatting, baseline P188/W02); `partial` names the months it covers.
 */
type Bucket = { label: string | number; months: YM[]; partial?: string };
const partialSpan = (ms: YM[]) => `${MONTH_NAMES[ms[0][1] - 1]}–${MONTH_NAMES[ms[ms.length - 1][1] - 1]}`;
function buckets(months: YM[], grain: "total" | "month" | "year"): Bucket[] {
  if (grain === "month") return months.map((x) => ({ label: ymKey(...x), months: [x] }));
  if (grain === "total") return [{ label: periodLabel(months), months }];
  const byYear = new Map<number, YM[]>();
  for (const x of months) { if (!byYear.has(x[0])) byYear.set(x[0], []); byYear.get(x[0])!.push(x); }
  return [...byYear.values()].map((ms) => (fullYear(ms) ? { label: ms[0][0], months: ms } : { label: ms[0][0], months: ms, partial: ms.length === 1 ? MONTH_NAMES[ms[0][1] - 1] : partialSpan(ms) }));
}
/** The row note for a partial per-year bucket, and the chart's partial-period markers (round 1 D3). */
const partialNoteOf = (bk: Bucket) => (bk.partial ? `${bk.partial} only` : null);
const partialPeriodsOf = (bks: Bucket[]) => bks.filter((bk) => bk.partial).map((bk) => ({ x: bk.label, label: bk.partial!.split("–").map((m) => m.slice(0, 3)).join("–") }));

/* ================================================================== agency cells ================================ */

type AgencyCells = { cell: (x: YM, offs: string[]) => number | null; missing: (xs: YM[], offs: string[]) => string[] };
function agencyCells(rows: Record<string, unknown>[]): AgencyCells {
  const map = new Map<string, number>();
  for (const r of rows) map.set(`${Number(r.y)}-${Number(r.m)}|${String(r.o)}`, Number(r.v));
  const cell = (x: YM, offs: string[]) => { let s = 0; for (const o of offs) { const v = map.get(`${x[0]}-${x[1]}|${o}`); if (v === undefined || !Number.isFinite(v)) return null; s += v; } return s; };
  const missing = (xs: YM[], offs: string[]) => xs.flatMap((x) => {
    const absent = offs.filter((o) => !map.has(`${x[0]}-${x[1]}|${o}`));
    if (!absent.length) return [];
    return [absent.length === offs.length ? monthName(x) : `${absent.map((o) => o.toLowerCase()).join(", ")} in ${monthName(x)}`];
  });
  return { cell, missing };
}
const sumCells = (c: AgencyCells, xs: YM[], offs: string[]) => { let s = 0; for (const x of xs) { const v = c.cell(x, offs); if (v === null) return null; s += v; } return s; };

/* ================================================================== compile ===================================== */

export function compileCurrentSpec(spec: CurrentSpec, ctx: CompileContext): CompiledAnswer {
  const b = bounds(ctx);
  if (!b) return { kind: "decline", explanation: "I couldn't read which months Current Trends covers, so I haven't answered." };
  const answer = spec.type === "series" ? compileSeries(spec, ctx, b) : spec.type === "change" ? compileChange(spec, ctx, b) : compilePeers(spec, ctx, b);
  // Stage 3b r2 (R2.4'): the rate method these rows were computed by (agencyBucket: the bucket's own year population, a
  // month not annualized; rollingValue: the 12-month average population), recorded with the places the rows name.
  if (answer.kind === "answer") {
    const rated = answer.rows.filter((r) => typeof r.statistic === "string" && /rate_per_100k$/.test(String(r.statistic)));
    const places = [...new Set(rated.map((r) => String(r.place)))];
    if (rated.some((r) => String(r.statistic).startsWith("rolling_"))) recordWhyFacts({ kind: "rate", method: "current-rolling", per: 100000, places });
    else if (rated.length) recordWhyFacts({ kind: "rate", method: "current-period", per: 100000, places });
  }
  return answer;
}

const cutoffOf = (b: Bounds) => ({ year: b.hi[0], month: b.hi[1] });
const partialNote = (b: Bounds, months: YM[]) => (months.some(([y]) => y === b.hi[0]) && b.hi[1] < 12 ? `${b.hi[0]} runs through ${MONTH_NAMES[b.hi[1] - 1]} in this source, so ${b.hi[0]} figures cover January through ${MONTH_NAMES[b.hi[1] - 1]} only.` : null);
const sampleSize = (ctx: CompileContext, place: Extract<CPlace, { kind: "national" | "state" }>) =>
  Number(ctx.run(`SELECT COUNT(*) AS n FROM sample_agencies${place.kind === "state" ? ` WHERE state = ${q(place.code)}` : ""}`)[0]?.n ?? 0); // lookup: sample-size
const samplePlaceLabel = (p: Extract<CPlace, { kind: "national" | "state" }>) => (p.kind === "national" ? "United States (sample)" : `${p.name} (sample)`);
const stateSentence = (p: Extract<CPlace, { kind: "state" }>, n: number) => `These figures represent only the ${fmt(n)} sample agencies in ${p.name} with complete monthly reporting, not the whole state; the Historical tab has FBI figures for the whole state.`;
const NO_SAMPLE_RATE = "Current Trends uses a sample of agencies, so it has no national or state rate; the Historical tab has FBI rates for the U.S. and every state. I haven't answered with a number that leaves it out.";

type AgencyFetch = { agency: Agency; place: Extract<CPlace, { kind: "agency" }>; cells: AgencyCells; pop: Map<number, number>; valueRec: OperandRecord; popRec: OperandRecord | null };
function fetchAgency(ctx: CompileContext, ops: OperandRecord[], sqls: string[], place: Extract<CPlace, { kind: "agency" }>, agency: Agency, offenses: string[], months: YM[], role: OperandRole, withPop: boolean): AgencyFetch {
  const x = new CurrentTypedQuery(role, "agency_monthly").agency("ori", agency.ori, place).offenses("offense", offenses).months("year", "month", months)
    .group("year", "y").group("month", "m").group("offense", "o").value("SUM(count)", "v");
  const sql = x.sql(); sqls.push(sql); ops.push(x.rec);
  const cells = agencyCells(ctx.run(sql));
  const pop = new Map<number, number>();
  let popRec: OperandRecord | null = null;
  if (withPop) {
    const p = new CurrentTypedQuery("denominator", "agency_population").agency("ori", agency.ori, place).years("year", [...new Set(months.map(([y]) => y))])
      .group("year", "y").value("MAX(population)", "p");
    const psql = p.sql(); sqls.push(psql); ops.push(p.rec); popRec = p.rec;
    for (const r of ctx.run(psql)) if (Number(r.p) > 0) pop.set(Number(r.y), Number(r.p));
  }
  return { agency, place, cells, pop, valueRec: x.rec, popRec };
}
/** r2 F4: a rate's denominator checked against its value statement before any rate is shown. */
const rateCheck = (f: AgencyFetch, months: YM[]): string | null => (f.popRec ? checkRateOperands(f.valueRec, f.popRec, [...new Set(months.map(([y]) => y))]) : "the population for the rate");

/** One bucket's value for an agency, by the F4 contract. */
function agencyBucket(f: AgencyFetch, bk: Bucket, offs: string[], statistic: "count" | "rate", notes: string[]): number | null {
  const sum = sumCells(f.cells, bk.months, offs);
  if (sum === null) { notes.push(`no report for ${f.cells.missing(bk.months, offs).join("; ")}`); return null; }
  if (statistic === "count") return sum;
  const years = [...new Set(bk.months.map(([y]) => y))];
  if (years.length !== 1) { notes.push("one rate per year"); return null; }
  const pop = f.pop.get(years[0]);
  if (pop === undefined) { notes.push(`no population on file for ${f.agency.label} in ${years[0]}`); return null; }
  return (sum * 100000) / pop; // the bucket's own year population (a month is not annualized)
}

function rollingValue(f: AgencyFetch, end: YM, offs: string[], statistic: "count" | "rate", notes: string[], sourceStart?: YM): number | null {
  const window = windowOf(end);
  const sum = sumCells(f.cells, window, offs);
  if (sum === null) {
    // Codex build review (Q5): months before the source begins are not "missing reports".
    const before = sourceStart ? window.filter((x) => cmp(x, sourceStart) < 0) : [];
    if (before.length) { notes.push(`the 12 months ending ${monthName(end)} start before the data begins (${monthName(sourceStart!)})`); return null; }
    notes.push(`no report for ${f.cells.missing(window, offs).join("; ")} in the 12 months ending ${monthName(end)}`); return null;
  }
  if (statistic === "count") return sum;
  const pops = window.map(([y]) => f.pop.get(y));
  const missingYear = window.find(([y]) => f.pop.get(y) === undefined);
  if (missingYear) { notes.push(`no population on file for ${f.agency.label} in ${missingYear[0]}`); return null; }
  return (sum * 100000) / ((pops as number[]).reduce((s, p) => s + p, 0) / 12);
}

type SampleMonth = { contributors: Set<string>; value: number };
function fetchSample(ctx: CompileContext, ops: OperandRecord[], sqls: string[], place: Extract<CPlace, { kind: "national" | "state" }>, offenses: string[], months: YM[], role: OperandRole): { byMonth: Map<string, SampleMonth>; rec: OperandRecord } {
  const x = new CurrentTypedQuery(role, "agency_monthly am").join("JOIN sample_agencies sa ON sa.ori = am.ori").sample("sa.state", place)
    .offenses("am.offense", offenses).months("am.year", "am.month", months)
    .group("am.ori", "agency_ori").group("am.year", "y").group("am.month", "m").value("COUNT(*)", "n").value("SUM(am.count)", "v");
  const sql = x.sql(); sqls.push(sql); ops.push(x.rec);
  const out = new Map<string, SampleMonth>();
  for (const r of ctx.run(sql)) {
    if (Number(r.n) !== offenses.length) continue; // a category counts only agencies with every offense that month
    const key = `${Number(r.y)}-${Number(r.m)}`;
    if (!out.has(key)) out.set(key, { contributors: new Set(), value: 0 });
    const e = out.get(key)!;
    e.contributors.add(String(r.agency_ori)); e.value += Number(r.v);
  }
  return { byMonth: out, rec: x.rec };
}
const contributorKey = (byMonth: Map<string, SampleMonth>, x: YM) => [...(byMonth.get(`${x[0]}-${x[1]}`)?.contributors ?? [])].sort().join(",");

function compileSeries(spec: SeriesSpec, ctx: CompileContext, b: Bounds): CompiledAnswer {
  const ops: OperandRecord[] = [];
  const sqls: string[] = [];
  const rows: Row[] = [];
  const notesOut: string[] = [...spec.uiNotes];
  const missingNamed: string[] = [];
  const statistic = spec.statistic;
  const agencies = new Map<CPlace, Agency>();
  for (const p of spec.places) {
    if (p.kind !== "agency") continue;
    const a = resolveAgency(ctx, p);
    if ("decline" in a) return { kind: "decline", explanation: a.decline };
    agencies.set(p, a);
  }
  const firstAgency = [...agencies.values()][0];
  const first = firstAgency && spec.period.form === "none"
    ? ((): YM | null => { const r = ctx.run(`SELECT MIN(year * 100 + month) AS f FROM agency_monthly WHERE ori = ${q(firstAgency.ori)}`)[0]; const f = Number(r?.f); return Number.isFinite(f) && f > 0 ? [Math.floor(f / 100), f % 100] : null; })() // lookup: first-reported-month
    : null;
  const resolved = monthsOf(spec.period, b, first);
  if ("decline" in resolved) return { kind: "decline", explanation: resolved.decline };
  // Round 1 Q5 (owner: "NOLA murders rolling over 12 months starts at 2017"): with no period named, a rolling series starts
  // at the first month that can close a full 12-month window (data from January 2017 -> first total December 2017), and
  // says why. A named period is never moved; its endpoints without 12 months of data keep an empty value and a note.
  let months = resolved.months;
  if (spec.grain === "rolling" && spec.period.form === "none") {
    const start = first ?? b.lo;
    const firstEnd = shift(start, 11);
    months = months.filter((x) => cmp(x, firstEnd) >= 0);
    if (!months.length) return { kind: "decline", explanation: `A 12-month total needs 12 months of data; this source has fewer than that (${monthName(start)} through ${monthName(b.hi)}). I haven't answered with a partial total.` };
    // Codex build review (Q5): the endpoint is the earliest POSSIBLE window; whether it has a total depends on its months.
    notesOut.push(`No period was named. A 12-month total needs 12 months of data, and the data begins in ${monthName(start)}, so the series starts with the 12 months ending ${monthName(firstEnd)}, the earliest possible window.`);
  } else {
    notesOut.push(...resolved.notes);
  }
  const a = appliedFrom([], cutoffOf(b));
  const valueRecs: OperandRecord[] = [];
  for (const place of spec.places) {
    const placeRows: Row[] = [];
    for (const mid of spec.measures) {
      const offs = OFFENSES_OF[mid];
      if (place.kind === "agency") {
        const agency = agencies.get(place)!;
        if (spec.grain === "rolling") {
          // Input months: the union of every endpoint's twelve-month window (2b r3.1 F2), checked as such (r2.1).
          const inputs = unionWindows(months);
          const f = fetchAgency(ctx, ops, sqls, place, agency, offs, inputs, "window", statistic === "rate");
          if (!sameKeys(f.valueRec.months, keysOf(inputs))) return { kind: "decline", explanation: operandFailure("every month of every twelve-month window") };
          if (statistic === "rate") { const bad = rateCheck(f, inputs); if (bad) return { kind: "decline", explanation: operandFailure(bad) }; }
          valueRecs.push(f.valueRec);
          for (const end of months) {
            const n: string[] = [];
            const v = rollingValue(f, end, offs, statistic, n, b.lo);
            if (n.length) missingNamed.push(...n);
            placeRows.push({ period: ymKey(...end), place: agency.label, measure: mid, statistic: statistic === "rate" ? "rolling_12_month_rate_per_100k" : "rolling_12_month_count", value: r1(v), note: n.join("; ") || null });
          }
          post(a).set("rolling", 12); // applied-site: rolling-window-sum
          for (const v of periodValuesOfMonths(months, cutoffOf(b))) post(a).push("periodValues", v); // applied-site: rolling-endpoint-months
        } else {
          const f = fetchAgency(ctx, ops, sqls, place, agency, offs, months, "value", statistic === "rate");
          if (statistic === "rate") { const bad = rateCheck(f, months); if (bad) return { kind: "decline", explanation: operandFailure(bad) }; }
          valueRecs.push(f.valueRec);
          for (const bk of buckets(months, spec.grain)) {
            const n: string[] = [];
            const v = agencyBucket(f, bk, offs, statistic, n);
            if (n.length) missingNamed.push(...n.map((t) => `${agency.label}: ${t}`));
            placeRows.push({ period: bk.label, place: agency.label, measure: mid, statistic: statistic === "rate" ? "rate_per_100k" : "count", value: r1(v), note: [partialNoteOf(bk), ...n].filter(Boolean).join("; ") || null });
          }
        }
      } else {
        if (statistic === "rate") return { kind: "decline", explanation: NO_SAMPLE_RATE };
        const size = sampleSize(ctx, place);
        const sampleLabel = place.kind === "state" ? place.name : "national";
        if (spec.grain === "rolling") {
          // r2 F3a: a window's total only when the SAME agencies reported every requested offense in all twelve months.
          const inputs = unionWindows(months);
          const { byMonth, rec } = fetchSample(ctx, ops, sqls, place, offs, inputs, "window");
          if (!sameKeys(rec.months, keysOf(inputs))) return { kind: "decline", explanation: operandFailure("every month of every twelve-month window") };
          for (const end of months) {
            const window = windowOf(end);
            const sets = window.map((x) => contributorKey(byMonth, x));
            const stable = sets[0] !== "" && sets.every((s) => s === sets[0]);
            const changed = window.filter((x, i) => i > 0 && sets[i] !== sets[i - 1]);
            const value = stable ? window.reduce((s, x) => s + byMonth.get(`${x[0]}-${x[1]}`)!.value, 0) : null;
            const note = stable ? `the same ${fmt(byMonth.get(`${end[0]}-${end[1]}`)!.contributors.size)} of ${fmt(size)} sample agencies reported every month of the window`
              : sets[0] === "" ? `no ${sampleLabel} sample agency reported in ${monthName(window[0])}` : `the reporting agencies changed in ${changed.map(monthName).join(", ") || monthName(window[0])}, so no 12-month total is given`;
            if (!stable) missingNamed.push(`${samplePlaceLabel(place)} ${ymKey(...end)}: ${note}`);
            placeRows.push({ period: ymKey(...end), place: samplePlaceLabel(place), measure: mid, statistic: "rolling_12_month_count", value, note });
          }
          post(a).set("rolling", 12); // applied-site: rolling-window-sum
          for (const v of periodValuesOfMonths(months, cutoffOf(b))) post(a).push("periodValues", v); // applied-site: rolling-endpoint-months
        } else {
          const { byMonth, rec } = fetchSample(ctx, ops, sqls, place, offs, months, "value");
          valueRecs.push(rec);
          let bks = buckets(months, spec.grain);
          // A period total only for the same agencies in every month of it; otherwise the monthly values (r1.1 F2).
          const unstable = (bk: Bucket) => bk.months.length > 1 && new Set(bk.months.map((x) => contributorKey(byMonth, x))).size > 1;
          if (bks.some(unstable)) {
            bks = bks.flatMap((bk) => (unstable(bk) ? bk.months.map((x) => ({ label: ymKey(...x), months: [x] })) : [bk]));
            notesOut.push("The sample agencies that reported changed from month to month, so no total across months is given; each month is shown with the agencies that reported it.");
            post(a).push("grains", "month"); // applied-site: unstable-total-split
          }
          for (const bk of bks) {
            const cells = bk.months.map((x) => byMonth.get(`${x[0]}-${x[1]}`));
            const none = bk.months.filter((x, i) => !cells[i] || cells[i]!.contributors.size === 0);
            const value = none.length ? null : cells.reduce((s, c) => s + c!.value, 0);
            const counts = [...new Set(cells.map((c) => c?.contributors.size ?? 0))];
            const note = none.length ? `no agencies in the ${sampleLabel} sample reported in ${none.map(monthName).join(", ")}` : `${counts.map(fmt).join("-")} of ${fmt(size)} sample agencies reported`;
            placeRows.push({ period: bk.label, place: samplePlaceLabel(place), measure: mid, statistic: "count", value, note: [partialNoteOf(bk), note].filter(Boolean).join("; ") });
          }
        }
        notesOut.push(place.kind === "state" ? stateSentence(place, size) : `National figures are sums over the sample agencies in the Current Trends national sample (${fmt(size)} agencies) that reported every requested offense that month, and each row says how many of them reported; they are not national estimates.`);
      }
    }
    if (spec.sort) {
      placeRows.sort((x, y) => (Number(y.value ?? -1) - Number(x.value ?? -1)) || String(x.measure).localeCompare(String(y.measure)));
      post(a).set("sort", "most-common"); // applied-site: sort-most-common
    }
    rows.push(...placeRows);
  }
  // r2 F4: several places (C2) or several measures (C3) -- the same months throughout, differing only where they should.
  if (valueRecs.length > 1) {
    const bad = checkSameShape(valueRecs, spec.places.length > 1 ? "place" : "offenses");
    if (bad) return { kind: "decline", explanation: operandFailure(bad) };
  }
  const fromOps = appliedFrom(ops, cutoffOf(b));
  Object.assign(a, { places: fromOps.places, measures: fromOps.measures, entities: fromOps.entities, periodValues: [...new Set([...(a.periodValues ?? []), ...fromOps.periodValues!])] });
  if (spec.grain === "month" || spec.grain === "rolling") post(a).push("grains", "month"); // applied-site: monthly-rows
  if (spec.grain === "year") post(a).push("grains", "year"); // applied-site: per-year-rows
  if (new Set(rows.map((r) => r.period)).size > 1) post(a).push("grains", "trend"); // applied-site: series-over-time
  if (spec.grain === "total" && months.length > 1) post(a).set("combine", true); // applied-site: period-total
  post(a).set("statistic", statistic); // applied-site: statistic-computed
  if (spec.places.length > 1) post(a).set("versus", "places"); // applied-site: places-side-by-side
  const resolvedRelative = relativeValue(spec.period, months, b);
  if (resolvedRelative) post(a).push("periodValues", resolvedRelative); // applied-site: relative-period-resolved
  if (statistic === "rate" && (spec.grain === "month" || (spec.grain === "total" && months.length === 1))) notesOut.push("A monthly rate is per 100,000 residents in that month, not annualized.");
  const partial = partialNote(b, months);
  if (partial) notesOut.push(partial);
  if (missingNamed.length) notesOut.push(`Not shown as a number (no report, never counted as zero): ${[...new Set(missingNamed)].join("; ")}.`);
  const placeNames = spec.places.map((p) => (p.kind === "agency" ? agencies.get(p)!.label : samplePlaceLabel(p)));
  const what = spec.measures.length > 2 ? "reported offenses" : spec.measures.map((m) => MEASURE_LABEL[m]).join(" and ");
  const statText = statistic === "rate" ? "rate per 100,000 residents" : spec.grain === "rolling" ? "12-month rolling total" : "reported count";
  const title = `${what[0].toUpperCase()}${what.slice(1)} ${statistic === "rate" ? "Rate" : "Count"}${spec.grain === "rolling" ? " (Rolling 12 Months)" : ""}, ${placeNames.join(", ")}, ${describeSpan(months)}`;
  const countyNotes = [...agencies.values()].map(countyAgencyNote).filter((n): n is string => Boolean(n));
  const explanation = [`Current Trends ${what} ${statText}${spec.grain === "month" ? " by month" : spec.grain === "year" ? " by year" : ""} for ${placeNames.join(", ")}, ${describeSpan(months)}.`, ...countyNotes, ...notesOut].join(" ");
  const multiPeriod = new Set(rows.map((r) => r.period)).size > 1;
  return {
    kind: "answer", sql: sqls.join(";\n"), columns: COLUMNS, rows, title, explanation,
    chartConfig: rows.length > 1 ? { type: multiPeriod ? "line" : "bar", xAxis: multiPeriod ? "period" : spec.measures.length > 1 ? "measure" : "place", yAxis: ["value"], title, ...(spec.grain === "year" && partialPeriodsOf(buckets(months, "year")).length ? { partialPeriods: partialPeriodsOf(buckets(months, "year")) } : {}) } as ChartConfig : null,
    applied: a, requestedEntities: placeNames, returnedEntities: [...new Set(rows.map((r) => String(r.place)))],
  };
}

/* ================================================================== C5: change ================================== */

function compileChange(spec: ChangeSpec, ctx: CompileContext, b: Bounds): CompiledAnswer {
  const offs = OFFENSES_OF[spec.measure];
  const periods: YM[][] = [];
  for (const p of spec.periods) { const r = monthsOf(p, b, null); if ("decline" in r) return { kind: "decline", explanation: r.decline }; periods.push(r.months); }
  const labels = periods.map(periodLabel);
  const all = periods.flat();
  const ops: OperandRecord[] = []; const sqls: string[] = [];
  const notes: string[] = [];
  const rows: Row[] = [];
  const a = appliedFrom([], cutoffOf(b));
  const st = spec.statistic === "rate" ? "rate_per_100k" : "count";
  // Comparable: two full years, or the same months of the year in both periods.
  const monthsOfYear = (ms: YM[]) => ms.map(([, m]) => m).join(",");
  const comparable = (x: YM[], y: YM[]) => (fullYear(x) && fullYear(y)) || (x.length === y.length && monthsOfYear(x) === monthsOfYear(y));
  const placeNames: string[] = [];
  const computedMonths: YM[][] = [];
  for (const place of spec.places) {
    let label: string; let identity: string;
    /** Computes one period's endpoint from this place's operand; the record is the computation's own. */
    let endpointOf: (months: YM[]) => Endpoint;
    if (place.kind === "agency") {
      const agency = resolveAgency(ctx, place); if ("decline" in agency) return { kind: "decline", explanation: agency.decline };
      const f = fetchAgency(ctx, ops, sqls, place, agency, offs, all, "value", spec.statistic === "rate");
      if (spec.statistic === "rate") { const bad = rateCheck(f, all); if (bad) return { kind: "decline", explanation: operandFailure(bad) }; }
      label = agency.label; identity = agency.ori;
      { const cn = countyAgencyNote(agency); if (cn) notes.push(cn); }
      endpointOf = (months) => {
        const n: string[] = [];
        const value = agencyBucket(f, { label: periodLabel(months), months }, offs, spec.statistic, n);
        const years = [...new Set(months.map(([y]) => y))];
        return { value, identity: f.valueRec.oris[0], offenses: [...f.valueRec.offenses], statistic: spec.statistic, months: [...months], denominatorYear: spec.statistic === "rate" && years.length === 1 && f.pop.has(years[0]) ? years[0] : null, notes: n.map((t) => `${agency.label}: ${t}.`) };
      };
    } else {
      if (spec.statistic === "rate") return { kind: "decline", explanation: NO_SAMPLE_RATE };
      // The accepted fixed comparison group (r1.2), its four statements in ONE snapshot (r2 F2): one group with every
      // required cell across ALL the requested months.
      const scope = place.kind === "state" ? place.code : null;
      const g = currentYoyGroupStatements({ months: all }, offs, scope);
      const groupRec: OperandRecord = { role: "group", table: "agency_monthly x sample_agencies (fixed group)", offenses: [...offs], months: keysOf(all), years: [], oris: [], place: place.kind === "state" ? placeIs.state(place.name) : placeIs.national, entities: [], scope: scope ?? "US" }; // applied-site: fixed-group-selection
      ops.push(groupRec);
      const groupSqls = [g.periodSql, g.sampleSql, g.membershipSql, g.sql];
      sqls.push(...groupSqls);
      const [periodRows, sampleRows, memberRows, answerRows] = ctx.runMany(groupSqls); // applied-site: fixed-group-selection
      const bad = checkGroupOperands(groupRec, all, offs, scope ?? "US");
      if (bad) return { kind: "decline", explanation: operandFailure(bad) };
      const required = new Set(periodRows.map((r) => `${Number(r.year)}-${Number(r.month)}`));
      const missingMonths = all.filter(([y, m]) => !required.has(`${y}-${m}`));
      const size = Number(sampleRows[0]?.sample_size ?? 0);
      const members = memberRows.length;
      // A period total is null unless every required cell of it has a group row (never a sum defaulting to 0).
      const cellOf = new Map<string, number>();
      for (const r of answerRows) cellOf.set(`${Number(r.year)}-${Number(r.month)}|${String(r.offense)}`, Number(r.offense_count));
      const total = (ms: YM[]): number | null => {
        let s = 0;
        for (const [y, m] of ms) for (const o of offs) { const v = cellOf.get(`${y}-${m}|${o}`); if (v === undefined || !Number.isFinite(v)) return null; s += v; }
        return s;
      };
      label = samplePlaceLabel(place); identity = groupRec.scope!;
      recordWhyFacts({ kind: "group", place: label, members, sample: size }); // Stage 3b r2 (R2.4'): the fixed group as formed here
      endpointOf = (months) => ({ value: members && !missingMonths.length ? total(months) : null, identity: groupRec.scope!, offenses: [...groupRec.offenses], statistic: "count", months: [...months], denominatorYear: null, notes: [] });
      notes.push(members
        ? `${label}: totals for a fixed comparison group of ${fmt(members)} agencies that reported every requested offense in every month of every period compared, from a starting sample of ${fmt(size)} agencies (${fmt(size - members)} excluded because their records did not include every one of those months).`
        : `${label}: no sample agency reported every requested offense in every month of every period compared, so no comparison group could be formed.`);
      if (missingMonths.length) notes.push(`${label}: no sample agency reported in ${missingMonths.map(monthName).join(", ")}.`);
      if (place.kind === "state") notes.push(stateSentence(place, size));
    }
    placeNames.push(label);
    // r3: each period's endpoint computed from its own months, then every adjacent pair checked on the endpoints.
    const endpoints = periods.map((ms) => endpointOf(ms));
    for (const e of endpoints) { notes.push(...e.notes); computedMonths.push(e.months); }
    for (let i = 1; i < endpoints.length; i += 1) {
      const bad = checkEndpointPair(endpoints[i - 1], endpoints[i], periods[i - 1], periods[i], identity, offs, spec.statistic);
      if (bad) return { kind: "decline", explanation: operandFailure(bad) };
    }
    endpoints.forEach((e, i) => rows.push({ period: labels[i], place: label, measure: spec.measure, statistic: st, value: r1(e.value), note: null }));
    const assessed: boolean[] = [];
    let fell = 0;
    for (let i = 1; i < endpoints.length; i += 1) {
      const ea = endpoints[i - 1]; const eb = endpoints[i];
      const pl = `${labels[i - 1]} vs ${labels[i]}`;
      if (!comparable(ea.months, eb.months)) { notes.push(`${label}: ${describeSpan(ea.months)} and ${describeSpan(eb.months)} don't cover the same months, so no change is given for ${pl}.`); assessed.push(false); continue; }
      if (ea.value === null || eb.value === null) { notes.push(`${label}: a change needs both values, so none is given for ${pl}.`); assessed.push(false); continue; }
      assessed.push(true);
      if (eb.value < ea.value) fell += 1;
      rows.push({ period: pl, place: label, measure: spec.measure, statistic: "change", value: r1(eb.value - ea.value), note: null });
      rows.push({ period: pl, place: label, measure: spec.measure, statistic: "percent_change", value: r1(ea.value === 0 ? null : ((eb.value - ea.value) * 100) / ea.value), note: ea.value === 0 ? "the earlier value is 0, so no percent change" : null });
    }
    if (endpoints.length > 2) {
      const n = assessed.filter(Boolean).length;
      notes.push(`${label}: of ${n} year-to-year change${n === 1 ? "" : "s"} that can be compared, ${fell} ${fell === 1 ? "was a decrease" : "were decreases"}${n < assessed.length ? `; ${assessed.length - n} can't be compared` : ""}.`);
    }
  }
  const fromOps = appliedFrom(ops, cutoffOf(b));
  Object.assign(a, { places: fromOps.places, measures: fromOps.measures, entities: fromOps.entities });
  // r3: the periods applied are the months the endpoints were computed over (each, and their union).
  for (const ms of computedMonths) for (const v of periodValuesOfMonths(ms, cutoffOf(b))) post(a).push("periodValues", v); // applied-site: change-endpoints
  for (const v of periodValuesOfMonths([...new Map(computedMonths.flat().map((x) => [ymKey(...x), x] as const)).values()].sort(cmp), cutoffOf(b))) post(a).push("periodValues", v); // applied-site: change-endpoints
  post(a).set("change", ["increase", "decrease", "neutral"]); // applied-site: change-computed
  post(a).set("statistic", spec.statistic); // applied-site: statistic-computed
  post(a).set("versus", spec.places.length > 1 ? "any" : "periods"); // applied-site: change-endpoints
  post(a).push("grains", "year"); // applied-site: change-endpoints
  post(a).push("grains", "trend"); // applied-site: change-endpoints
  const partial = partialNote(b, all);
  if (partial) notes.push(partial);
  const what = MEASURE_LABEL[spec.measure];
  const title = `${what[0].toUpperCase()}${what.slice(1)} ${spec.statistic === "rate" ? "Rate" : "Count"}, ${placeNames.join(", ")}: ${labels.join(" vs ")}`;
  const explanation = [`Current Trends ${what} ${spec.statistic === "rate" ? "rate per 100,000 residents" : "reported count"} for ${placeNames.join(", ")}: ${periods.map(describeSpan).join(" compared with ")}.`, ...spec.uiNotes, ...notes].join(" ");
  return { kind: "answer", sql: sqls.join(";\n"), columns: COLUMNS, rows, title, explanation, chartConfig: null, applied: a, requestedEntities: placeNames, returnedEntities: placeNames, notes: [...notes] };
}

/* ================================================================== C6: similar-sized cities ==================== */

/** FBI population groups for cities (task0/coverage-and-population.md): Group I is split into its three subgroups. */
export const FBI_CITY_GROUPS: { lo: number; hi: number; label: string }[] = [
  { lo: 1000000, hi: Number.MAX_SAFE_INTEGER, label: "1,000,000 and over" },
  { lo: 500000, hi: 999999, label: "500,000 to 999,999" },
  { lo: 250000, hi: 499999, label: "250,000 to 499,999" },
  { lo: 100000, hi: 249999, label: "100,000 to 249,999" },
  { lo: 50000, hi: 99999, label: "50,000 to 99,999" },
  { lo: 25000, hi: 49999, label: "25,000 to 49,999" },
  { lo: 10000, hi: 24999, label: "10,000 to 24,999" },
  { lo: 0, hi: 9999, label: "under 10,000" },
];

function compilePeers(spec: PeerSpec, ctx: CompileContext, b: Bounds): CompiledAnswer {
  const offs = OFFENSES_OF[spec.measure];
  const target = resolveAgency(ctx, spec.target); if ("decline" in target) return { kind: "decline", explanation: target.decline };
  if (target.type !== "City") return { kind: "decline", explanation: "The FBI groups counties by metropolitan status, not size, so there is no population group to match a county with. I haven't answered with a number that leaves it out." };
  const resolved = monthsOf(spec.period, b, null); if ("decline" in resolved) return { kind: "decline", explanation: resolved.decline };
  const months = resolved.months;
  const popYear = months[months.length - 1][0];
  const ops: OperandRecord[] = []; const sqls: string[] = [];
  // The target's membership population (the final period year) -- a separate record from any rate denominator (r2.1).
  const tp = new CurrentTypedQuery("membership", "agency_population").agency("ori", target.ori, spec.target).years("year", [popYear]).value("MAX(population)", "p");
  const tpSql = tp.sql(); sqls.push(tpSql); ops.push(tp.rec);
  const tpop = Number(ctx.run(tpSql)[0]?.p);
  if (!Number.isFinite(tpop) || tpop <= 0) return { kind: "decline", explanation: `There's no population on file for ${target.label} in ${popYear}, so its population group can't be set. I haven't answered with a number that leaves it out.` };
  const group = FBI_CITY_GROUPS.find((g) => tpop >= g.lo && tpop <= g.hi)!;
  const cand = new CurrentTypedQuery("candidates", "agency_population ap").join("JOIN (SELECT DISTINCT ori, agency, state, type FROM agency_monthly) a ON a.ori = ap.ori")
    .years("ap.year", [popYear]).fixed("a.type = 'City'").excludeAgency("ap.ori", target.ori).fixed(`ap.population >= ${group.lo}`).fixed(`ap.population <= ${group.hi}`)
    .value("ap.ori", "ori").value("a.agency", "agency").value("a.state", "state").value("ap.population", "population");
  const candSql = cand.sql(); sqls.push(candSql); ops.push(cand.rec);
  const candidates = ctx.run(candSql).map((r) => ({ ori: String(r.ori), label: `${r.agency}, ${r.state}`, pop: Number(r.population) }));
  if (!candidates.length) return { kind: "decline", explanation: `There are no other cities in Current Trends in ${target.label}'s FBI population group (${group.label}, ${popYear} populations), so there's nothing to compare it with. I haven't answered with a number that leaves it out.` };
  const cov = new CurrentTypedQuery("coverage", "agency_monthly").agencies("ori", candidates.map((c) => c.ori)).offenses("offense", offs).months("year", "month", months)
    .group("ori", "ori").group("year", "y").group("month", "m").value("COUNT(*)", "n");
  const covSql = cov.sql(); sqls.push(covSql); ops.push(cov.rec);
  const complete = new Map<string, Set<string>>();
  for (const r of ctx.run(covSql)) if (Number(r.n) === offs.length) { const k = String(r.ori); if (!complete.has(k)) complete.set(k, new Set()); complete.get(k)!.add(`${Number(r.y)}-${Number(r.m)}`); }
  const missingFor = (ori: string) => months.filter(([y, m]) => !complete.get(ori)?.has(`${y}-${m}`));
  const covered = candidates.filter((c) => missingFor(c.ori).length === 0);
  const leftOut = candidates.filter((c) => missingFor(c.ori).length > 0);
  if (!covered.length) return { kind: "decline", explanation: `There are no other cities in ${target.label}'s FBI population group (${group.label}) that reported every month of ${describeSpan(months)}, so there's nothing to compare it with. I haven't answered with a number that leaves it out.` };
  covered.sort((x, y) => Math.abs(x.pop - tpop) - Math.abs(y.pop - tpop) || x.label.localeCompare(y.label));
  const n = spec.n ?? 9;
  const chosen = covered.slice(0, n);
  const a = appliedFrom([], cutoffOf(b));
  post(a).set("peer", { n: spec.n }); // applied-site: peer-group
  post(a).push("entities", "city"); // applied-site: peer-group
  const rows: Row[] = [];
  const notes: string[] = [];
  const st = spec.statistic === "rate" ? "rate_per_100k" : "count";
  const bks = buckets(months, spec.grain);
  const valueRecs: OperandRecord[] = [];
  for (const [i, c] of [{ ori: target.ori, label: target.label, pop: tpop }, ...chosen].entries()) {
    const place = { kind: "agency" as const, agencyKind: "city" as const, name: c.label.split(", ")[0], state: c.label.split(", ")[1], text: c.label };
    const f = fetchAgency(ctx, ops, sqls, place, { ori: c.ori, label: c.label, type: "City" }, offs, months, "value", spec.statistic === "rate");
    if (spec.statistic === "rate") { const bad = rateCheck(f, months); if (bad) return { kind: "decline", explanation: operandFailure(bad) }; }
    valueRecs.push(f.valueRec);
    for (const bk of bks) {
      const nn: string[] = [];
      const v = agencyBucket(f, bk, offs, spec.statistic, nn);
      rows.push({ period: bk.label, place: c.label, measure: spec.measure, statistic: st, value: r1(v), note: [partialNoteOf(bk), i === 0 ? `the city asked about; population ${fmt(c.pop)} (${popYear})` : `population ${fmt(c.pop)} (${popYear})`, ...nn].filter(Boolean).join("; ") });
    }
  }
  const badPeers = checkPeerOperands({ membership: tp.rec, candidates: cand.rec, coverage: cov.rec, values: valueRecs, popYear, months, offenses: offs, target: target.ori, selected: chosen.map((c) => c.ori) });
  if (badPeers) return { kind: "decline", explanation: operandFailure(badPeers) };
  const fromOps = appliedFrom(ops, cutoffOf(b));
  Object.assign(a, { places: fromOps.places, measures: fromOps.measures, periodValues: fromOps.periodValues });
  post(a).set("statistic", spec.statistic); // applied-site: statistic-computed
  post(a).set("versus", "places"); // applied-site: places-side-by-side
  if (spec.grain === "total" && months.length > 1) post(a).set("combine", true); // applied-site: period-total
  if (spec.grain === "month") post(a).push("grains", "month"); // applied-site: monthly-rows
  if (spec.grain === "year") post(a).push("grains", "year"); // applied-site: per-year-rows
  if (bks.length > 1) post(a).push("grains", "trend"); // applied-site: series-over-time
  notes.push(`Similar-sized cities are the other Current Trends cities in ${target.label}'s FBI population group, ${group.label} residents (${popYear} populations).`);
  notes.push(spec.n === null
    ? `Shown: the ${chosen.length} closest in population, of ${covered.length} cities in the group that reported every month of the period.`
    : `Shown: the ${chosen.length} closest in population, as asked${chosen.length < n ? ` (only ${chosen.length} cities in the group reported every month of the period)` : ""}, of ${covered.length} cities in the group that reported every month of the period.`);
  if (leftOut.length) notes.push(`Left out because they did not report every month: ${leftOut.map((c) => `${c.label} (no report for ${missingFor(c.ori).map(monthName).join(", ")})`).join("; ")}.`);
  if (popYear === b.hi[0]) notes.push(`${popYear} populations repeat the latest estimate on file where no newer one exists.`);
  const partial = partialNote(b, months); if (partial) notes.push(partial);
  const what = MEASURE_LABEL[spec.measure];
  const title = `${what[0].toUpperCase()}${what.slice(1)} ${spec.statistic === "rate" ? "Rate" : "Count"}: ${target.label} and Similar-Sized Cities, ${describeSpan(months)}`;
  const explanation = [`Current Trends ${what} ${spec.statistic === "rate" ? "rate per 100,000 residents" : "reported count"}${spec.grain === "month" ? " by month" : spec.grain === "year" ? " by year" : ""} for ${target.label} and similar-sized cities, ${describeSpan(months)}.`, ...spec.uiNotes, ...notes].join(" ");
  const multi = bks.length > 1;
  return { kind: "answer", sql: sqls.join(";\n"), columns: COLUMNS, rows, title, explanation, chartConfig: { type: multi ? "line" : "bar", xAxis: multi ? "period" : "place", yAxis: ["value"], title, ...(partialPeriodsOf(bks).length ? { partialPeriods: partialPeriodsOf(bks) } : {}) } as ChartConfig, applied: a, requestedEntities: [target.label], returnedEntities: [...new Set(rows.map((r) => String(r.place)))] };
}

export { STATE_NAME_BY_CODE };
