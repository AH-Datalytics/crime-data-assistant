/*
 * Request accounting, stage 2b r3 (plan 2026-10-10 r3 §3, r3.1, r3.2): where a typed answer's record of what it applied
 * may be written.
 *
 *   1. STRUCTURE (L13): in lib/nibrs-question-compiler.ts an operand record (`rec`) is written only inside the TypedQuery
 *      builder; an answer's `applied` is written only by appliedFrom/post or on a line carrying an allowlisted
 *      `// applied-site: <tag>`; every typed statement executed is a builder's `.sql()`.
 *   2. RATE OPERANDS AND PRESENCE (r3.1 F3, r3.2), on an in-memory database: an agency that reported without a population
 *      counts for presence and plain counts, and is left out of BOTH sides of a rate; a place whose reporting agencies all
 *      lack a population gets no rate; a place with no reporting agency gets no count.
 */
import "./offline-evidence-guard";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { compileNibrsSpec, type CompiledAnswer } from "../lib/nibrs-question-compiler";
import type { SeriesSpec } from "../lib/nibrs-question-types";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else if (!process.env.QUIET) console.log(`  PASS  ${label}`);
}

// ---------------------------------------------------------------- 1. structure
const ALLOWED_SITES = new Set([
  "alphabetical-list", "breakdown-shares-computed", "change-computed", "change-endpoints", "clearance-conditions-from-operand-columns",
  "month-selection", "monthly-rows", "per-year-rows", "per-year-sets", "period-total",
  "places-side-by-side", "rank-population-threshold", "rank-sort-and-slice", "relative-period-resolved-by-years-of",
  "rolling-endpoint-months", "rolling-endpoint-years", "rolling-monthly-endpoints", "rolling-window-sum", "share-computed",
  "share-per-state", "share-withheld-with-reason", "state-grouping-is-the-ranking-not-a-breakdown", "statistic-computed",
]);
const src = fs.readFileSync(path.join(__dirname, "..", "lib", "nibrs-question-compiler.ts"), "utf8").split("\n");
const start = src.findIndex((l) => /^class TypedQuery \{/.test(l));
const end = src.findIndex((l) => /^\} \/\/ end TypedQuery/.test(l));
check(start >= 0 && end > start, "the TypedQuery builder is delimited");
const region = (name: RegExp) => { const s = src.findIndex((l) => name.test(l)); let e = s; while (e < src.length && !/^}/.test(src[e])) e += 1; return [s, e] as const; };
const [afStart, afEnd] = region(/^function appliedFrom\(/);
const [postStart, postEnd] = region(/^function post\(/);
const inside = (i: number, [s, e]: readonly [number, number]) => i >= s && i <= e;
const recWrites = src.map((l, i) => [l, i] as const).filter(([l]) => /\brec\.\w+\s*(?:=[^=]|\.push\()/.test(l));
check(recWrites.length > 0 && recWrites.every(([, i]) => i > start && i < end), `operand records are written only inside TypedQuery (${recWrites.filter(([, i]) => !(i > start && i < end)).map(([, i]) => i + 1).join(", ") || "ok"})`);
const appliedWrites = src.map((l, i) => [l, i] as const).filter(([l, i]) => !inside(i, [afStart, afEnd]) && !inside(i, [postStart, postEnd]) && (/\bpost\(\w+\)\.(?:set|push)\(/.test(l) || /\bapplied\.\w+\s*=[^=]/.test(l)));
const untagged = appliedWrites.filter(([l]) => !/\/\/ applied-site: [a-z-]+/.test(l));
check(appliedWrites.length > 0 && untagged.length === 0, `every write to an answer's applied record is a tagged site (${untagged.map(([, i]) => i + 1).join(", ") || "ok"})`);
const used = new Set(appliedWrites.flatMap(([l]) => [...l.matchAll(/\/\/ applied-site: ([a-z-]+)/g)].map((m) => m[1])));
check([...used].every((t) => ALLOWED_SITES.has(t)), `every applied-site tag is allowlisted (${[...used].filter((t) => !ALLOWED_SITES.has(t)).join(", ") || "ok"})`);
check([...ALLOWED_SITES].every((t) => used.has(t)), `no stale allowlist entry (${[...ALLOWED_SITES].filter((t) => !used.has(t)).join(", ") || "ok"})`);
const runs = src.filter((l) => /\bawait run\(/.test(l));
const builderRuns = src.filter((l) => /\bawait run\([\w.]+\.sql\(\)\)/.test(l));
check(runs.length > 0 && runs.length === builderRuns.length, `every typed statement executed is a builder's .sql() (${runs.length} runs, ${builderRuns.length} from builders)`);
check(!/\bBETWEEN\b/.test(src.slice(start, end).join("\n")), "the builder's year restriction is an explicit list, never BETWEEN");

// ---------------------------------------------------------------- 2. rate operands and presence (in-memory)
const db = new Database(":memory:");
db.exec(`
CREATE TABLE agencies (ori TEXT, year INT, state TEXT, city TEXT, agency_type TEXT, population INT);
CREATE TABLE nibrs_agency_completeness (ori TEXT, year INT, months_reported INT, total_offenses INT);
CREATE TABLE summary_city_monthly (ori TEXT, year INT, month INT, state TEXT, ucr_offense_code TEXT, offense_count INT, cleared_count INT);
CREATE TABLE summary_state_monthly (state TEXT, year INT, month INT, ucr_offense_code TEXT, offense_count INT, cleared_count INT);
`);
const ins = (t: string, r: Record<string, unknown>) => db.prepare(`INSERT INTO ${t} (${Object.keys(r).join(",")}) VALUES (${Object.keys(r).map(() => "?").join(",")})`).run(...Object.values(r));
// State AA: one agency with a population (A1, 100 robberies), one reporting without one (A2, 50 robberies).
// State BB: one agency reporting without a population (B1, 30 robberies). State CC: no reporting agency.
for (const [ori, st, pop, n] of [["AA001", "AA", 100000, 100], ["AA002", "AA", 0, 50], ["BB001", "BB", 0, 30]] as const) {
  ins("agencies", { ori, year: 2025, state: st, city: ori, agency_type: "City", population: pop });
  ins("nibrs_agency_completeness", { ori, year: 2025, months_reported: 12, total_offenses: n });
  for (let m = 1; m <= 12; m += 1) ins("summary_city_monthly", { ori, year: 2025, month: m, state: st, ucr_offense_code: "120", offense_count: m === 1 ? n : 0, cleared_count: 0 });
}
for (const st of ["AA", "BB"]) {
  const total = st === "AA" ? 150 : 30;
  for (let m = 1; m <= 12; m += 1) ins("summary_state_monthly", { state: st, year: 2025, month: m, ucr_offense_code: "120", offense_count: m === 1 ? total : 0, cleared_count: 0 });
}
ins("agencies", { ori: "CC001", year: 2025, state: "CC", city: "CC001", agency_type: "City", population: 5000 });
const ctx = { db, now: new Date(Date.UTC(2026, 9, 10)), cutoff: { year: 2025, month: 12 }, run: async (sql: string) => db.prepare(sql).all() as Record<string, unknown>[] };
const stateSpec = (code: string, name: string, statistic: "count" | "rate"): SeriesSpec => ({ type: "series", measures: ["robbery"], unit: null, statistic, filters: [], places: [{ kind: "state", name, code, label: name }], period: { form: "year", year: 2025 }, grain: "total" });
const value = (a: CompiledAnswer) => (a.kind === "answer" ? a.rows[0]?.value ?? null : `decline: ${a.explanation}`);
const note = (a: CompiledAnswer) => (a.kind === "answer" ? String(a.rows[0]?.note ?? "") : "");
// Names are not in STATE_CODE; the compiler reads the code it is given.
void (async () => {
  const aaCount = await compileNibrsSpec(stateSpec("AA", "Aland", "count"), ctx);
  check(value(aaCount) === 150, `presence and counts include an agency without a population (count ${value(aaCount)}, want 150)`);
  const aaRate = await compileNibrsSpec(stateSpec("AA", "Aland", "rate"), ctx);
  check(value(aaRate) === 100, `a rate leaves that agency out of BOTH sides (rate ${value(aaRate)}, want 100 per 100,000 = 100 / 100,000)`);
  check(aaRate.kind === "answer" && /1 with no population on file, left out of rates/.test(aaRate.explanation), "the rate's cohort names the agency left out of rates");
  const bbRate = await compileNibrsSpec(stateSpec("BB", "Bland", "rate"), ctx);
  check(value(bbRate) === null && /population on file/.test(note(bbRate)), `no rate when every reporting agency lacks a population (${value(bbRate)} / ${note(bbRate)})`);
  const bbCount = await compileNibrsSpec(stateSpec("BB", "Bland", "count"), ctx);
  check(value(bbCount) === 30, `but its count is given (count ${value(bbCount)}, want 30)`);
  const ccCount = await compileNibrsSpec(stateSpec("CC", "Cland", "count"), ctx);
  check(value(ccCount) === null && /no agencies in Cland reported to NIBRS in 2025/.test(note(ccCount)), `a place with no reporting agency has no count (${value(ccCount)} / ${note(ccCount)})`);

  console.log(`\n${checks - failures}/${checks} passed`);
  if (failures > 0) process.exit(1);
})();
