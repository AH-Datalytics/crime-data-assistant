/*
 * Request accounting, stage 3a (plan 2026-10-10-request-accounting-stage3a-current.md r1.2, lessons L12-L15): where a
 * typed Current answer's record of what it applied may be written, and the absence, sample and rate rules it computes.
 *
 *   1. STRUCTURE (L12): in lib/current-question-compiler.ts an operand record (`rec`) is written only inside the
 *      CurrentTypedQuery builder; an answer's `applied` is written only by appliedFrom/post on a line carrying an
 *      allowlisted `// applied-site: <tag>`; every statement executed is a builder's `.sql()`, a tagged lookup, or the
 *      shared fixed-group selection; the builder never restricts months or years with BETWEEN.
 *   2. RULES, on an in-memory database: absence is not zero (§4.2); a category counts only complete agency-month sets
 *      and a total is withheld when the reporting agencies change (r1.1 F2); the rolling rate's months-weighted population
 *      and a missing population (F4); the C6 population year and selection order (F3).
 */
import "./offline-evidence-guard";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { compileCurrentSpec, type CompiledAnswer } from "../lib/current-question-compiler";
import type { CurrentSpec } from "../lib/current-question-types";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else if (!process.env.QUIET) console.log(`  PASS  ${label}`);
}

// ---------------------------------------------------------------- 1. structure
const ALLOWED_SITES = new Set([
  "change-computed", "change-endpoints", "monthly-rows", "peer-group",
  "per-year-rows", "period-total", "places-side-by-side", "relative-period-resolved", "rolling-endpoint-months", "rolling-window-sum",
  "series-over-time", "sort-most-common", "statistic-computed", "unstable-total-split",
]);
// Round 1 Q1 adds "county-agencies": names in-county Current Trends agencies inside a refusal; it never produces a number.
const ALLOWED_LOOKUPS = new Set(["source-bounds", "agency-resolution", "sample-size", "first-reported-month", "county-agencies"]);
const src = fs.readFileSync(path.join(__dirname, "..", "lib", "current-question-compiler.ts"), "utf8").split("\n");
const start = src.findIndex((l) => /^class CurrentTypedQuery \{/.test(l));
const end = src.findIndex((l) => /^\} \/\/ end CurrentTypedQuery/.test(l));
check(start >= 0 && end > start, "the CurrentTypedQuery builder is delimited");
const region = (name: RegExp) => { const s = src.findIndex((l) => name.test(l)); let e = s; while (e < src.length && !/^}/.test(src[e])) e += 1; return [s, e] as const; };
const [afStart, afEnd] = region(/^function appliedFrom\(/);
const [postStart, postEnd] = region(/^function post\(/);
const inside = (i: number, [s, e]: readonly [number, number]) => i >= s && i <= e;
const recWrites = src.map((l, i) => [l, i] as const).filter(([l]) => /\brec\.\w+\s*(?:=[^=]|\.push\()/.test(l));
check(recWrites.length > 0 && recWrites.every(([, i]) => i > start && i < end), `operand records are written only inside CurrentTypedQuery (${recWrites.filter(([, i]) => !(i > start && i < end)).map(([, i]) => i + 1).join(", ") || "ok"})`);
const appliedWrites = src.map((l, i) => [l, i] as const).filter(([l, i]) => !inside(i, [afStart, afEnd]) && !inside(i, [postStart, postEnd]) && (/\bpost\(\w+\)\.(?:set|push)\(/.test(l) || /(?:^|;)\s*(?:a|applied)\.\w+\s*=[^=]/.test(l) || /Object\.assign\(a,/.test(l)));
const untagged = appliedWrites.filter(([l]) => !/\/\/ applied-site: [a-z-]+/.test(l) && !/Object\.assign\(a, \{ places: fromOps\.places/.test(l));
check(appliedWrites.length > 0 && untagged.length === 0, `every write to an answer's applied record is a tagged site or a copy from its operands (${untagged.map(([, i]) => i + 1).join(", ") || "ok"})`);
const used = new Set(appliedWrites.flatMap(([l]) => [...l.matchAll(/\/\/ applied-site: ([a-z-]+)/g)].map((m) => m[1])));
check([...used].every((t) => ALLOWED_SITES.has(t)), `every applied-site tag is allowlisted (${[...used].filter((t) => !ALLOWED_SITES.has(t)).join(", ") || "ok"})`);
check([...ALLOWED_SITES].every((t) => used.has(t)), `no stale allowlist entry (${[...ALLOWED_SITES].filter((t) => !used.has(t)).join(", ") || "ok"})`);
const runs = src.map((l, i) => [l, i] as const).filter(([l]) => /\bctx\.run\(/.test(l));
const builderVars = new Set(src.flatMap((l) => [...l.matchAll(/const (\w+) = \w+\.sql\(\);/g)].map((m) => m[1])));
const fromBuilder = ([l]: readonly [string, number]) => [...l.matchAll(/ctx\.run\((\w+)\)/g)].every((m) => builderVars.has(m[1])) && /ctx\.run\(\w+\)/.test(l);
const lookup = ([l]: readonly [string, number]) => { const m = /\/\/ lookup: ([a-z-]+)/.exec(l); return Boolean(m && ALLOWED_LOOKUPS.has(m[1])); };
const group = ([l]: readonly [string, number]) => /currentYoyGroupStatements|g\.periodSql/.test(l) && /\/\/ applied-site: fixed-group-selection/.test(l);
const strays = runs.filter((r) => !fromBuilder(r) && !lookup(r) && !group(r));
check(runs.length > 0 && strays.length === 0, `every statement executed is a builder's .sql(), a tagged lookup or the shared fixed-group selection (${strays.map(([, i]) => i + 1).join(", ") || "ok"})`);
check(!/\bBETWEEN\b/.test(src.slice(start, end).join("\n")), "the builder restricts months and years by explicit lists, never BETWEEN");

// ---------------------------------------------------------------- 2. rules (in-memory)
const db = new Database(":memory:");
db.exec(`
CREATE TABLE agency_monthly (ori TEXT, agency TEXT, state TEXT, type TEXT, year INT, month INT, offense TEXT, count INT);
CREATE TABLE agency_population (ori TEXT, year INT, population INT);
CREATE TABLE sample_agencies (ori TEXT, agency TEXT, state TEXT, type TEXT);
`);
const ins = (t: string, r: Record<string, unknown>) => db.prepare(`INSERT INTO ${t} (${Object.keys(r).join(",")}) VALUES (${Object.keys(r).map(() => "?").join(",")})`).run(...Object.values(r));
const OFF = ["Murder", "Rape", "Robbery", "Aggravated Assault", "Burglary", "Theft", "Motor Vehicle Theft"];
// A1 (AA): every month of 2024-2025, 10 of every offense; population 100,000 (2024) and 200,000 (2025).
// A2 (AA): no rows at all for 2025-03; no Rape row for 2025-06; 0 murders always (recorded zeros); no 2025 population.
// B1 (BB): a city of 600,000 in 2025 (only it and A1-sized peers below); B2 600,000 too but missing 2025-02.
const city = (ori: string, name: string, st: string, skip: (y: number, m: number, o: string) => boolean, n: (o: string) => number) => {
  for (const y of [2024, 2025]) for (let m = 1; m <= 12; m += 1) for (const o of OFF) if (!skip(y, m, o)) ins("agency_monthly", { ori, agency: name, state: st, type: "City", year: y, month: m, offense: o, count: n(o) });
  ins("sample_agencies", { ori, agency: name, state: st, type: "City" });
};
city("A1", "Alpha", "AA", () => false, () => 10);
city("A2", "Beta", "AA", (y, m, o) => (y === 2025 && m === 3) || (y === 2025 && m === 6 && o === "Rape"), (o) => (o === "Murder" ? 0 : 5));
city("B1", "Gamma", "BB", () => false, () => 1);
city("B2", "Delta", "BB", (y, m) => y === 2025 && m === 2, () => 2);
// B3 (BB): 300,000 in 2024 only -- in Gamma's 2024 group (250,000-499,999), not its 2025 one.
city("B3", "Epsilon", "BB", () => false, () => 3);
for (const [ori, y, p] of [["A1", 2024, 100000], ["A1", 2025, 200000], ["A2", 2024, 50000], ["B1", 2024, 400000], ["B1", 2025, 600000], ["B2", 2025, 610000], ["B3", 2024, 300000]] as const) ins("agency_population", { ori, year: y, population: p });
const ctx = { run: (sql: string) => db.prepare(sql).all() as Record<string, unknown>[], runMany: (sqls: string[]) => db.transaction(() => sqls.map((s) => db.prepare(s).all() as Record<string, unknown>[]))() };
const agencyPlace = (name: string, st: string) => ({ kind: "agency" as const, agencyKind: "city" as const, name, state: st, text: `${name}, ${st}` });
const series = (over: Partial<Extract<CurrentSpec, { type: "series" }>>): CurrentSpec => ({ type: "series", measures: ["robbery"], statistic: "count", places: [agencyPlace("Alpha", "AA")], period: { form: "year", year: 2025 }, grain: "total", sort: false, overview: false, uiNotes: [], ...over });
const answer = (a: CompiledAnswer) => (a.kind === "answer" ? a : null);
const vals = (a: CompiledAnswer) => answer(a)?.rows.map((r) => r.value) ?? [`decline: ${(a as { explanation: string }).explanation}`];

// absence
check(JSON.stringify(vals(compileCurrentSpec(series({ places: [agencyPlace("Beta", "AA")] }), ctx))) === "[null]", "a year with a missing month has no total (absence is not zero)");
check(JSON.stringify(vals(compileCurrentSpec(series({ places: [agencyPlace("Beta", "AA")], measures: ["murder"], period: { form: "year", year: 2024 } }), ctx))) === "[0]", "a recorded zero is 0");
check(JSON.stringify(vals(compileCurrentSpec(series({ places: [agencyPlace("Beta", "AA")], measures: ["violent_crime"], period: { form: "month", year: 2025, month: 6 } }), ctx))) === "[null]", "a category with a missing offense row that month has no value");
const monthly = answer(compileCurrentSpec(series({ places: [agencyPlace("Beta", "AA")], grain: "month" }), ctx));
check(Boolean(monthly && monthly.rows[2].value === null && monthly.rows[3].value === 5 && /March 2025/.test(monthly.explanation)), "a monthly series shows the missing month as no report and names it");
// sample: complete category sets, per-month contributors, totals only for an identical set
const aa = { kind: "state" as const, name: "Aland", code: "AA" };
const jun = answer(compileCurrentSpec(series({ places: [aa], measures: ["violent_crime"], period: { form: "month", year: 2025, month: 6 } }), ctx));
check(Boolean(jun && jun.rows[0].value === 40 && /1 of 2 sample agencies/.test(String(jun.rows[0].note))), "a state's category counts only agencies with every offense that month, and says how many reported");
const year25 = answer(compileCurrentSpec(series({ places: [aa] }), ctx));
check(Boolean(year25 && year25.rows.length === 12 && /changed from month to month/.test(year25.explanation)), "a total is withheld when the reporting agencies change; the months are shown instead");
const year24 = answer(compileCurrentSpec(series({ places: [aa], period: { form: "year", year: 2024 } }), ctx));
check(Boolean(year24 && year24.rows.length === 1 && year24.rows[0].value === 12 * 15), "a total is given when the same agencies reported every month");
check(compileCurrentSpec(series({ places: [aa], statistic: "rate" }), ctx).kind === "decline", "no state rate (ruling 3)");
// rates
const rate24 = answer(compileCurrentSpec(series({ statistic: "rate", period: { form: "year", year: 2024 } }), ctx));
check(Boolean(rate24 && rate24.rows[0].value === 120), "a yearly rate is the year's sum over that year's population (120 x 100,000 / 100,000)");
const rateMonth = answer(compileCurrentSpec(series({ statistic: "rate", period: { form: "month", year: 2025, month: 1 } }), ctx));
check(Boolean(rateMonth && rateMonth.rows[0].value === 5 && /in that month/.test(rateMonth.explanation)), "a monthly rate is not annualized (10 x 100,000 / 200,000)");
const rolling = answer(compileCurrentSpec(series({ statistic: "rate", grain: "rolling", period: { form: "month", year: 2025, month: 3 } }), ctx));
// window Apr 2024-Mar 2025: 120 robberies; population (9 x 100,000 + 3 x 200,000) / 12 = 125,000 -> 96
check(Boolean(rolling && rolling.rows[0].value === 96), `the rolling rate uses the months-weighted population of the same twelve months (${rolling?.rows[0].value}, want 96)`);
// Round 1 Q5: with no period named, a rolling series starts at the first full 12-month window (data from January 2024 ->
// first total December 2024) and says so; a named period keeps its own start, with its partial windows empty, never summed.
{
  const unnamed = answer(compileCurrentSpec(series({ grain: "rolling", period: { form: "none" } }), ctx));
  check(Boolean(unnamed && String(unnamed.rows[0].period) === "2024-12" && unnamed.rows.length === 13 && unnamed.rows.every((r) => r.value === 120)), `Q5 unnamed rolling starts at the first full window (${unnamed?.rows[0]?.period}, ${unnamed?.rows.length} rows)`);
  check(Boolean(unnamed && /starts with the 12 months ending December 2024, the earliest possible window/.test(unnamed.explanation)), "Q5 the start is described as the earliest possible window");
  const named = answer(compileCurrentSpec(series({ grain: "rolling", period: { form: "since", from: 2024 } }), ctx));
  check(Boolean(named && String(named.rows[0].period) === "2024-01" && named.rows[0].value === null && named.rows.find((r) => String(r.period) === "2024-12")?.value === 120), "Q5 a named start is kept; its partial windows are empty, never summed");
  check(Boolean(named && /start before the data begins \(January 2024\)/.test(String(named.rows[0].note)) && !/no report/.test(String(named.rows[0].note))), `Codex Q5: a window reaching before the source says so, not "no report" (${named?.rows[0]?.note})`);
  // Codex Q5: with a missing month inside coverage (Beta has no 2025-03), the earliest window stays empty and is not called a total.
  const beta = answer(compileCurrentSpec(series({ places: [agencyPlace("Beta", "AA")], grain: "rolling", period: { form: "none" } }), ctx));
  check(Boolean(beta && beta.rows.find((r) => String(r.period) === "2025-03")?.value === null && /no report for/.test(String(beta.rows.find((r) => String(r.period) === "2025-03")?.note)) && !/first total/.test(beta.explanation)), "Codex Q5: a missing report inside coverage stays empty, named as missing, and nothing claims it holds a total");
}
// Round 1 Q1: a county agency stored under its bare name ("Zeta", type County; not in the sample) resolves for "Zeta County"
// and reads "Zeta County, AA"; a city of the same bare name is not taken for it.
{
  for (let m = 1; m <= 12; m += 1) for (const o of OFF) ins("agency_monthly", { ori: "C1", agency: "Zeta", state: "AA", type: "County", year: 2025, month: m, offense: o, count: 4 });
  const county = { kind: "agency" as const, agencyKind: "county" as const, name: "Zeta", state: "AA", text: "Zeta County, AA" };
  const z = answer(compileCurrentSpec(series({ places: [county] }), ctx));
  check(Boolean(z && z.rows[0].value === 48 && String(z.rows[0].place) === "Zeta County, AA"), `Q1 county agency under its bare name resolves and is labeled as a county (${z?.rows[0]?.place}, ${z?.rows[0]?.value})`);
  check(Boolean(z && /county agency's own Current Trends record/.test(z.explanation)), "Q1 the county-agency caveat is stated");
  db.exec("CREATE TABLE IF NOT EXISTS agency_county_crosswalk (ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_key TEXT)");
  for (const ori of ["A1", "A2", "B1"]) ins("agency_county_crosswalk", { ori, ori9: ori, agency_name: ori, state: ori === "B1" ? "BB" : "AA", county_key: "OMEGA" });
  const absent = compileCurrentSpec(series({ places: [{ ...county, name: "Omega", text: "Omega County, AA" }] }), ctx);
  check(absent.kind === "decline" && /isn't one of the agencies in Current Trends/.test(absent.explanation) && /does have Alpha, AA and Beta, AA in Omega County/.test(absent.explanation),
    `Q1 (owner decision B) a county with no agency record names its most populous Current Trends agencies, same state only (${absent.kind === "decline" ? absent.explanation : ""})`);
  const none = compileCurrentSpec(series({ places: [{ ...county, name: "Psi", text: "Psi County, AA" }] }), ctx);
  check(none.kind === "decline" && /has no agencies in Psi County/.test(none.explanation), "Q1 a county with no Current Trends agencies says so");
  const cityNotCounty = compileCurrentSpec(series({ places: [{ ...county, name: "Alpha", text: "Alpha County, AA" }] }), ctx);
  check(cityNotCounty.kind === "decline", "Q1 a city of the same bare name is not taken for the county");
}
const noPop = answer(compileCurrentSpec(series({ places: [agencyPlace("Beta", "AA")], statistic: "rate", period: { form: "month", year: 2025, month: 1 } }), ctx));
check(Boolean(noPop && noPop.rows[0].value === null && /no population on file for Beta, AA in 2025/.test(String(noPop.rows[0].note))), "no population on file: no rate, named");
// C6: population year = the last month's year; membership, then coverage, then size
const peers = (period: CurrentSpec extends never ? never : Extract<CurrentSpec, { type: "peers" }>["period"]): CurrentSpec => ({ type: "peers", target: agencyPlace("Gamma", "BB"), n: null, measure: "robbery", statistic: "count", period, grain: "total", uiNotes: [] });
const p25 = compileCurrentSpec(peers({ form: "year", year: 2025 }), ctx);
const pJan = answer(compileCurrentSpec(peers({ form: "month", year: 2025, month: 1 }), ctx));
check(p25.kind === "decline" && /reported every month/.test(p25.explanation), "a member missing a month of the period is left out before the closest are chosen (2025: the only member missed February, so none is left)");
check(Boolean(pJan && pJan.rows.map((r) => r.place).join("|") === "Gamma, BB|Delta, BB" && /500,000 to 999,999/.test(pJan.explanation)), "for January 2025 the same member reported, so it is matched in the 500,000-999,999 group");
const across = answer(compileCurrentSpec(peers({ form: "monthrange", from: [2024, 12], to: [2025, 1] }), ctx));
check(Boolean(across && across.rows.map((r) => r.place).join("|") === "Gamma, BB|Delta, BB"), `a span across two years takes the group from its LAST month's year (2025: Delta), not its first (2024 would give Epsilon) (${across?.rows.map((r) => r.place).join("|")})`);
const noTargetPop = compileCurrentSpec({ type: "peers", target: agencyPlace("Delta", "BB"), n: null, measure: "robbery", statistic: "count", period: { form: "year", year: 2024 }, grain: "total", uiNotes: [] }, ctx);
check(noTargetPop.kind === "decline" && /no population on file for Delta, BB in 2024/.test(noTargetPop.explanation), "no population on file for the target in the period's last year: declined, named");

// ---------------------------------------------------------------- 3. round 2 (plan r2 + r2.1)
// F2 structure: one record outside the builder (the shared fixed group, tagged at its call site); ONE runMany call, which the
// route wires to the bounded single-transaction executor.
const literalRecs = src.map((l, i) => [l, i] as const).filter(([l]) => /:\s*OperandRecord\s*=\s*\{/.test(l));
check(literalRecs.length === 1 && /\/\/ applied-site: fixed-group-selection/.test(literalRecs[0][0]), `the only operand record written outside the builder is the fixed group's, at its call site (${literalRecs.map(([, i]) => i + 1).join(", ")})`);
const runManyCalls = src.filter((l) => /\bctx\.runMany\(/.test(l));
check(runManyCalls.length === 1 && /ctx\.runMany\(groupSqls\)/.test(runManyCalls[0]), "the fixed group's four statements are executed by ONE runMany call");
const routeSrc = fs.readFileSync(path.join(__dirname, "..", "app", "api", "query", "route.ts"), "utf8");
check(/runMany: \(typedStatements\) => \{[\s\S]{0,400}?return executeManyWithTimeoutSync<Record<string, unknown>>\(typeDb, typedStatements, 30000\);/.test(routeSrc), "the route's runMany is the bounded single-transaction executor (executeManyWithTimeoutSync)");
// F1: the latest month is the cutoff month, the latest year the latest full year.
const latestMonth = answer(compileCurrentSpec(series({ period: { form: "latestmonth" } }), ctx));
check(Boolean(latestMonth && latestMonth.rows.length === 1 && latestMonth.rows[0].period === "2025-12" && latestMonth.applied.periodValues?.includes("latestmonth")), "\"the latest month\" reads only the cutoff month, and records it");
const latestYear = answer(compileCurrentSpec(series({ period: { form: "latest" } }), ctx));
check(Boolean(latestYear && latestYear.rows[0].period === 2025 && !latestYear.applied.periodValues?.includes("latestmonth")), "\"the latest year\" is the latest full year, never the latest month");
// F2: a period total is null unless every required cell has a group row.
const groupCtx = { ...ctx, runMany: (sqls: string[]) => { const out = ctx.runMany(sqls); out[3] = out[3].filter((r) => !(Number(r.year) === 2025 && Number(r.month) === 3)); return out; } };
const gapped = answer(compileCurrentSpec({ type: "change", measure: "robbery", statistic: "count", places: [{ kind: "state", name: "Aland", code: "AA" }], periods: [{ form: "year", year: 2024 }, { form: "year", year: 2025 }], uiNotes: [] }, groupCtx));
check(Boolean(gapped && gapped.rows.find((r) => r.period === 2025)!.value === null && !gapped.rows.some((r) => r.statistic === "change")), "a group total with a required cell missing is null (never a sum defaulting to 0), and its change is withheld");
// F4: the operand checks, each with a mismatched record.
import { checkRateOperands, checkPeerOperands, checkGroupOperands, checkEndpointPair, checkSameShape, type OperandRecord } from "../lib/current-question-compiler";
const rec = (over: Partial<OperandRecord>): OperandRecord => ({ role: "value", table: "t", offenses: ["Robbery"], months: ["2025-01"], years: [], oris: ["A1"], place: null, entities: [], scope: null, ...over });
check(checkRateOperands(rec({}), rec({ role: "denominator", years: [2025] }), [2025]) === null && checkRateOperands(rec({}), rec({ role: "denominator", years: [2024] }), [2025]) !== null && checkRateOperands(rec({}), rec({ role: "denominator", oris: ["A2"], years: [2025] }), [2025]) !== null, "rate: the denominator must be the same ORI and cover every year");
check(checkSameShape([rec({}), rec({ oris: ["A2"] })], "place") === null && checkSameShape([rec({}), rec({ months: ["2025-02"] })], "place") !== null && checkSameShape([rec({}), rec({ offenses: ["Burglary"] })], "place") !== null, "several places: same months and offenses");
const peerArgs = { membership: rec({ role: "membership", oris: ["T"], years: [2025] }), candidates: rec({ role: "candidates", years: [2025], oris: [] }), coverage: rec({ role: "coverage", oris: ["P1", "P2"], months: ["2025-01"] }), values: [rec({ oris: ["T"] }), rec({ oris: ["P1"] })], popYear: 2025, months: [[2025, 1]] as [number, number][], offenses: ["Robbery"], target: "T", selected: ["P1"] };
check(checkPeerOperands(peerArgs) === null, "peers: a consistent set of operands passes");
check(checkPeerOperands({ ...peerArgs, values: [rec({ oris: ["T"] }), rec({ oris: ["P2"] })] }) !== null, "peers: a series for a city outside the selection is caught");
check(checkPeerOperands({ ...peerArgs, coverage: rec({ role: "coverage", oris: ["P1", "P2"], months: ["2025-02"] }) }) !== null, "peers: coverage over different months is caught");
check(checkPeerOperands({ ...peerArgs, membership: rec({ role: "membership", oris: ["T"], years: [2024] }) }) !== null, "peers: the membership population from another year is caught");
check(checkGroupOperands(rec({ role: "group", months: ["2025-01", "2025-02"], scope: "TX" }), [[2025, 1], [2025, 2]], ["Robbery"], "TX") === null && checkGroupOperands(rec({ role: "group", months: ["2025-01"], scope: "TX" }), [[2025, 1], [2025, 2]], ["Robbery"], "TX") !== null, "fixed group: exactly every requested month");
// r3: change endpoints are the computations' own records; the pair check takes them, not metadata.
type EP = Parameters<typeof checkEndpointPair>[0];
const Y = (y: number): [number, number][] => Array.from({ length: 12 }, (_, i) => [y, i + 1] as [number, number]);
const ep = (over: Partial<EP>): EP => ({ value: 10, identity: "A1", offenses: ["Robbery"], statistic: "count", months: Y(2024), denominatorYear: null, notes: [], ...over });
check(checkEndpointPair(ep({}), ep({ months: Y(2025) }), Y(2024), Y(2025), "A1", ["Robbery"], "count") === null, "endpoints: a correct pair passes");
check(/computed values/.test(checkEndpointPair(ep({ months: Y(2025) }), ep({ months: Y(2024) }), Y(2024), Y(2025), "A1", ["Robbery"], "count") ?? ""), "endpoints: values computed over each other's months (a swap) are caught");
check(/computed values/.test(checkEndpointPair(ep({}), ep({}), Y(2024), Y(2025), "A1", ["Robbery"], "count") ?? ""), "endpoints: one computation reused for both sides is caught");
check(/another place/.test(checkEndpointPair(ep({}), ep({ months: Y(2025), identity: "A2" }), Y(2024), Y(2025), "A1", ["Robbery"], "count") ?? ""), "endpoints: a value computed for another place is caught");
check(checkEndpointPair(ep({ statistic: "rate", denominatorYear: 2024 }), ep({ statistic: "rate", months: Y(2025), denominatorYear: 2025 }), Y(2024), Y(2025), "A1", ["Robbery"], "rate") === null
  && /population year/.test(checkEndpointPair(ep({ statistic: "rate", denominatorYear: 2024 }), ep({ statistic: "rate", months: Y(2025), denominatorYear: 2024 }), Y(2024), Y(2025), "A1", ["Robbery"], "rate") ?? ""), "endpoints: each rate uses its own period's population year");
const agencyChange = answer(compileCurrentSpec({ type: "change", measure: "robbery", statistic: "count", places: [agencyPlace("Alpha", "AA")], periods: [{ form: "year", year: 2024 }, { form: "year", year: 2025 }], uiNotes: [] }, ctx));
check(Boolean(agencyChange && agencyChange.rows.find((r) => r.statistic === "change")?.value === 0 && agencyChange.applied.periodValues?.includes("year:2024") && agencyChange.applied.periodValues?.includes("year:2025")), "endpoints through the compiler: the correct pair is delivered and the endpoints' months are the applied periods");
const rateChange = answer(compileCurrentSpec({ type: "change", measure: "robbery", statistic: "rate", places: [agencyPlace("Alpha", "AA")], periods: [{ form: "year", year: 2024 }, { form: "year", year: 2025 }], uiNotes: [] }, ctx));
check(Boolean(rateChange && rateChange.rows[0].value === 120 && rateChange.rows[1].value === 60), `endpoints through the compiler: each rate divides by its own year's population (${rateChange?.rows.slice(0, 2).map((r) => r.value).join(", ")}, want 120, 60)`);
const middle = answer(compileCurrentSpec({ type: "change", measure: "robbery", statistic: "count", places: [agencyPlace("Beta", "AA")], periods: [{ form: "year", year: 2024 }, { form: "year", year: 2025 }], uiNotes: [] }, ctx));
check(Boolean(middle && middle.rows.find((r) => r.period === 2025)!.value === null && !middle.rows.some((r) => r.statistic === "change")), "endpoints through the compiler: a period with a missing month withholds its change");

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
