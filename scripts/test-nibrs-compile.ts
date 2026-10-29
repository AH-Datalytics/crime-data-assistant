/**
 * The plan -> DuckDB compiler v0 (lib/nibrs-plan/compile.ts) compiles the simplest forms and refuses the rest with a
 * reason. Offline: checks the SQL it emits, never runs it (scripts/nibrs-compile-gate.ts runs the correctness cases
 * against a local canonical build). No database, no model, no network.
 */
import assert from "node:assert/strict";
import { compilePlan } from "../lib/nibrs-plan/compile";
import * as X from "../lib/nibrs-plan/examples";

const t = { root: "/build/canonical", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] };
const year = (y: number) => ({ kind: "absolute" as const, from: `${y}-01`, to: `${y}-12` });

// H1: Memphis carjackings by month in 2025.
const h1 = compilePlan(X.H1, year(2025), t);
assert(h1.kind === "query");
assert.deepEqual(h1.query.columns, ["period", "value", "status"]);
assert.deepEqual(h1.query.scanYears, [2025, 2026], "a later year's file can hold the period's incidents");
for (const s of ["offense_code = '120'", "p.loss_type = '7'", "'03', '05', '24', '28', '37'", "u.ori = 'TNMPD0000'", "agency_month_status", "UNKNOWN_UNEVIDENCED_ZERO", "BETWEEN '202501' AND '202512'"]) assert.ok(h1.query.sql.includes(s), s);
assert.ok(!h1.query.sql.includes("data_year=2024"), "no year before the period is scanned");

// H2 (a total) and H3 (by year).
const h2 = compilePlan(X.H2, year(2025), t);
assert(h2.kind === "query");
assert.deepEqual(h2.query.columns, ["value", "status"]);
const h3 = compilePlan(X.H3, { kind: "absolute", from: "2020-01", to: "2025-12" }, t);
assert(h3.kind === "query");
assert.ok(h3.query.sql.includes("bool_and"), "a year is known only when every month is");

// N3: offenses by code.
const n3 = compilePlan(X.N3, { kind: "absolute", from: "2022-01", to: "2026-06" }, t);
assert(n3.kind === "query");
assert.ok(n3.query.sql.includes("o.offense_code IN ('240')"));

// A state is a reported sum, without status.
const tx = compilePlan({ ...X.H2, geography: { places: [{ kind: "state", code: "TX" }], combine: "separate" } }, year(2025), t);
assert(tx.kind === "query");
assert.ok(tx.query.sql.includes("substr(u.ori, 1, 2) = 'TX'") && !tx.query.sql.includes("agency_month_status"));
assert.equal(tx.query.notes.length, 1);

// Everything outside v0 is refused, with its reason.
const refuse = (p: Parameters<typeof compilePlan>[0], period: Parameters<typeof compilePlan>[1] = year(2025)) => { const r = compilePlan(p, period, t); assert.equal(r.kind, "unsupported"); return r.kind === "unsupported" ? r.reason : ""; };
assert.match(refuse(X.N1), /count statistic|one measure|month or by year/);
assert.match(refuse(X.N2), /filters/);
assert.match(refuse(X.SEPARATE_YEARS, { kind: "years", years: [2019, 2024] }), /absolute periods/);
assert.match(refuse(X.ROLLING), /transforms|month or by year|one place/);
assert.match(refuse(X.SAME_AGENCIES_CHANGE), /transforms|cohort/);
assert.match(refuse({ ...X.H2, measures: [{ id: "incidents.nope", unit: "incident", as: "x" }], statistics: [{ kind: "count", as: "c", measure: "x" }] }), /no executable definition/);
assert.match(refuse(X.H2, year(2027)), /no built data year/, "a period after every built year");

console.log("nibrs compile v0: simple forms compile; the rest refuse with a reason");
