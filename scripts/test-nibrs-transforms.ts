/**
 * Time transforms (lib/nibrs-plan/transforms.ts): period totals, two-period changes and rolling windows from monthly
 * cells, with D6/P51 statuses, D17 (no change from an unknown period) and P55 (no percent change from a zero base).
 * Offline, no database.
 */
import assert from "node:assert/strict";
import { combineMonths, compare, pct1, rankAgencies, rate, rolling, rollup, round1, windowMonths, type MonthCell } from "../lib/nibrs-plan/transforms";

const months = (year: number, values: (number | null | "Z" | "C")[]): MonthCell[] => values.map((v, i) => ({
  ym: `${year}-${String(i + 1).padStart(2, "0")}`,
  value: v === null || v === "C" ? null : v === "Z" ? 0 : v,
  status: v === null ? "UNKNOWN" : v === "Z" ? "REPORTED_ZERO" : v === "C" ? "EVIDENCE_CONFLICT" : "VALUE",
}));
const full = (year: number, v: number) => months(year, Array(12).fill(v));

// Totals: known only when every month is; REPORTED_ZERO only when every month is; a conflict wins.
assert.deepEqual(rollup(full(2024, 3)), { value: 36, status: "VALUE", missing: [] });
assert.deepEqual(rollup(months(2024, Array(12).fill("Z"))), { value: 0, status: "REPORTED_ZERO", missing: [] });
assert.deepEqual(rollup(months(2024, ["Z", 0, ...Array(10).fill("Z")])), { value: 0, status: "VALUE", missing: [] }, "P51: a VALUE 0 month makes the total VALUE");
assert.deepEqual(rollup(months(2025, [...Array(10).fill(5), null, null])), { value: null, status: "UNKNOWN", missing: ["2025-11", "2025-12"] });
assert.equal(rollup(months(2025, ["C", ...Array(11).fill(1)])).status, "EVIDENCE_CONFLICT");

// Changes: counts, change, percent change; none from an unknown period (D17); no percent from a zero base (P55).
const c = compare(full(2023, 10), full(2024, 12));
assert.deepEqual([c.earlier.value, c.later.value, c.change, c.pctChange, c.zeroBase], [120, 144, { value: 24, status: "VALUE" }, { value: 20, status: "VALUE" }, false]);
const z = compare(months(2022, Array(12).fill(0)), months(2023, [0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 0, 0]));
assert.deepEqual([z.earlier, z.change, z.pctChange, z.zeroBase], [{ value: 0, status: "VALUE", missing: [] }, { value: 6, status: "VALUE" }, { value: null, status: "UNAVAILABLE" }, true]);
const gap = compare(full(2024, 5), months(2025, [...Array(10).fill(5), null, null]));
assert.deepEqual([gap.change.status, gap.pctChange.status, gap.later.missing], ["UNKNOWN", "UNKNOWN", ["2025-11", "2025-12"]]);
assert.equal(compare(months(2024, ["C", ...Array(11).fill(1)]), full(2025, 1)).change.status, "EVIDENCE_CONFLICT");
// Rounding: one decimal, half away from zero, no float drift.
assert.deepEqual([pct1(1, 8), pct1(-1, 8), pct1(1, 3), pct1(-2, 3), pct1(0, 5)], [12.5, -12.5, 33.3, -66.7, 0]);
assert.equal(pct1(9, 400), 2.3, "2.25 rounds half away from zero");

// Rolling: windows reach before the displayed period; a window with any unknown month is unknown, never shorter.
assert.deepEqual(windowMonths("2023-01", 12), ["2022-02", "2022-03", "2022-04", "2022-05", "2022-06", "2022-07", "2022-08", "2022-09", "2022-10", "2022-11", "2022-12", "2023-01"]);
const series = [...full(2024, 1), ...months(2025, [...Array(10).fill(2), null, null]), ...months(2026, Array(9).fill(3))];
const r = rolling(series, 12, ["2025-01", "2025-10", "2025-11", "2026-09"]);
assert.deepEqual(r.map((x) => [x.ym, x.value, x.status]), [["2025-01", 13, "VALUE"], ["2025-10", 22, "VALUE"], ["2025-11", null, "UNKNOWN"], ["2026-09", null, "UNKNOWN"]]);
assert.deepEqual(r[2].missing, ["2025-11"]);
// Months the cells do not hold (before the build) are unknown, never zero.
assert.equal(rolling(full(2017, 1), 12, ["2017-06"])[0].status, "UNKNOWN");

// Increment 4. Several agencies as one: a month is known only when every agency's is; REPORTED_ZERO only when all are.
const tulsa = full(2024, 3), okc = full(2024, 4);
assert.deepEqual(rollup(combineMonths([tulsa, okc])), { value: 84, status: "VALUE", missing: [] });
const greensboro = months(2025, [...Array(10).fill(5), null, null]);
assert.deepEqual(rollup(combineMonths([greensboro, full(2025, 9)])).missing, ["2025-11", "2025-12"], "Raleigh's months never stand in for Greensboro's");
assert.equal(rollup(combineMonths([months(2024, Array(12).fill("Z")), months(2024, Array(12).fill("Z"))])).status, "REPORTED_ZERO");
assert.equal(rollup(combineMonths([months(2024, ["C", ...Array(11).fill(1)]), full(2024, 1)])).status, "EVIDENCE_CONFLICT");
// Rates (P58, P59): known only with the count; no rate from a missing or zero population (never 0 or infinite).
assert.deepEqual(rate({ value: 3404, status: "VALUE" }, 413_066), { value: 824.1, status: "VALUE" });
assert.deepEqual(rate({ value: 0, status: "VALUE" }, 50_000), { value: 0, status: "VALUE" });
assert.deepEqual(rate({ value: null, status: "UNKNOWN" }, 50_000), { value: null, status: "UNKNOWN" });
for (const pop of [null, undefined, 0, -1]) assert.deepEqual(rate({ value: 7, status: "VALUE" }, pop), { value: null, status: "UNAVAILABLE" }, String(pop));
assert.deepEqual([round1(824.05), round1(0.04), round1(12.25)], [824.1, 0, 12.3]);
// A combined rate is the sum of counts over the sum of populations, not an average of rates.
assert.deepEqual(rate({ value: 3404 + 4375, status: "VALUE" }, 413_066 + 702_767), { value: 697.1, status: "VALUE" });
// Rankings (P17, P60): only known values ranked; ties alphabetical; cut at the limit; the rest left out, never ranked.
const xs = [{ name: "Cee", value: 5, known: true }, { name: "Bee", value: 5, known: true }, { name: "Aye", value: 9, known: true }, { name: "Dee", value: null, known: false }, { name: "Eee", value: 1, known: true }];
assert.deepEqual(rankAgencies(xs, "top", 3).ranked.map((x) => x.name), ["Aye", "Bee", "Cee"]);
assert.deepEqual(rankAgencies(xs, "top", 2).ranked.map((x) => x.name), ["Aye", "Bee", "Cee"], "a tie at the cut shows every place tied (coordinator 2026-11-06)");
assert.deepEqual(rankAgencies(xs, "top", 2).tie, { position: 2, names: ["Bee", "Cee"], shown: 3 });
assert.equal(rankAgencies(xs, "top", 3).tie, null, "a cut that falls between different values has no tie");
assert.deepEqual(rankAgencies(xs, "bottom", null).ranked.map((x) => x.name), ["Eee", "Bee", "Cee", "Aye"]);
assert.deepEqual(rankAgencies(xs, "top", 10).leftOut.map((x) => x.name), ["Dee"]);

console.log("nibrs transforms: totals, changes and rolling windows follow D6, P51, D17 and P55");
