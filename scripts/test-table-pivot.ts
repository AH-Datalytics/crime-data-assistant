/** Ruling 7: the table PRESENTATION pivot (a column per year); the answer's long shape is untouched. Offline. */
import assert from "node:assert/strict";
import { pivotYearTable } from "../lib/table-pivot";

// Family 7 shape: Year, one category, a count (Unknown stays its own row).
const long = [
  { period: "2023", offense: "Burglary", count: 10 }, { period: "2023", offense: "Unknown", count: 2 },
  { period: "2024", offense: "Burglary", count: 12 }, { period: "2024", offense: "Unknown", count: 3 },
];
const p = pivotYearTable(["period", "offense", "count"], long)!;
assert.deepEqual(p.columns, ["offense", "2023", "2024"]);
assert.deepEqual(p.rows, [{ offense: "Burglary", "2023": 10, "2024": 12 }, { offense: "Unknown", "2023": 2, "2024": 3 }]);
assert.equal(p.labels["2023"], "2023");
assert.equal(long.length, 4, "the input is not changed");

// 423179ca6d shape: a count and a share, one block per value column, first-appearance order kept (the ranking).
const two = [
  { period: "2017", state: "TX", n: 5, share_pct: 50 }, { period: "2017", state: "OK", n: 5, share_pct: 50 },
  { period: "2018", state: "TX", n: 6, share_pct: 60 }, { period: "2018", state: "OK", n: 4, share_pct: 40 },
];
const q = pivotYearTable(["period", "state", "n", "share_pct"], two, (c) => (c === "share_pct" ? "Share (%)" : "Count"))!;
assert.deepEqual(q.columns, ["state", "2017", "2018", "2017__share_pct", "2018__share_pct"]);
assert.equal(q.labels["2018__share_pct"], "2018 (Share (%))");
assert.equal(q.labels["2017"], "2017 (Count)");
assert.deepEqual(q.rows[0], { state: "TX", "2017": 5, "2018": 6, "2017__share_pct": 50, "2018__share_pct": 60 });

// A missing cell is blank, a partial year is said.
const gap = pivotYearTable(["year", "g", "v"], [{ year: 2023, g: "A", v: 1 }, { year: 2024, g: "A", v: 2 }, { year: 2024, g: "B", v: 3 }].map((r) => ({ ...r, year: String(r.year) })), (c) => c, new Set(["2024"]))!;
assert.equal(gap.rows[1]["2023"], null);
assert.equal(gap.labels["2024"], "2024 (Partial)");

// Not pivoted: one year, a month period, two category columns, a status column, no category, a repeated cell.
assert.equal(pivotYearTable(["period", "g", "v"], [{ period: "2024", g: "A", v: 1 }, { period: "2024", g: "B", v: 2 }]), null);
assert.equal(pivotYearTable(["period", "g", "v"], [{ period: "2024-01", g: "A", v: 1 }, { period: "2024-02", g: "A", v: 2 }]), null);
assert.equal(pivotYearTable(["period", "g", "h", "v"], [{ period: "2023", g: "A", h: "x", v: 1 }, { period: "2024", g: "A", h: "x", v: 2 }]), null);
assert.equal(pivotYearTable(["period", "g", "v", "status"], [{ period: "2023", g: "A", v: 1, status: "VALUE" }, { period: "2024", g: "A", v: 2, status: "VALUE" }]), null);
assert.equal(pivotYearTable(["period", "v"], [{ period: "2023", v: 1 }, { period: "2024", v: 2 }]), null);
assert.equal(pivotYearTable(["period", "g", "v"], [{ period: "2023", g: "A", v: 1 }, { period: "2023", g: "A", v: 2 }, { period: "2024", g: "A", v: 3 }]), null);
// One category value for every row (the place is in the title): stays long.
assert.equal(pivotYearTable(["period", "g", "v"], [{ period: "2023", g: "A", v: 1 }, { period: "2024", g: "A", v: 2 }]), null);
console.log("table-pivot: ok");
