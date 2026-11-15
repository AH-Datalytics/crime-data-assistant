/**
 * The shared rolling-window helper (lib/nibrs-shadow/rolling.ts): window totals over monthly counts, blank when any month
 * of the window is not known, never 0; several series each on their own; agrees with transforms.rolling for NIBRS cells.
 */
import assert from "node:assert/strict";
import { firstNeeded, monthRange, rollingBySeries, rollingSums, unknownRuns, windowOf } from "../lib/nibrs-shadow/rolling";
import { rolling, type MonthCell } from "../lib/nibrs-plan/transforms";

assert.deepEqual(monthRange("2024-11", "2025-02"), ["2024-11", "2024-12", "2025-01", "2025-02"]);
assert.equal(firstNeeded("2025-03", 12), "2024-04");
assert.equal(firstNeeded("2025-12", 12), "2025-01");
assert.equal(firstNeeded("2025-01", 1), "2025-01");
assert.throws(() => firstNeeded("2025-01", 0));
assert.deepEqual(windowOf("2025-02", 3), ["2024-12", "2025-01", "2025-02"]);

// 14 months of 1, 2, 3, ...: the windows ending 2025-01 and 2025-02 need the 12 months back.
const months = monthRange("2024-01", "2025-02");
const cells = months.map((ym, i) => ({ ym, value: i + 1 }));
const r12 = rollingSums(cells, 12, "2024-12", "2025-02");
assert.deepEqual(r12.map((r) => [r.ym, r.value]), [["2024-12", 78], ["2025-01", 90], ["2025-02", 102]]);
// A window reaching before the data is blank and says which months it lacked.
const early = rollingSums(cells, 12, "2024-06", "2024-06");
assert.deepEqual(early, [{ ym: "2024-06", value: null, missing: ["2023-07", "2023-08", "2023-09", "2023-10", "2023-11", "2023-12"] }]);
// A month not known (null, or absent) blanks every window that reaches it; a real 0 does not.
const gap = cells.map((c) => (c.ym === "2024-05" ? { ...c, value: null } : c.ym === "2024-06" ? { ...c, value: 0 } : c)).filter((c) => c.ym !== "2024-09");
const g = rollingSums(gap, 3, "2024-05", "2024-12");
assert.deepEqual(g.map((r) => [r.ym, r.value]), [["2024-05", null], ["2024-06", null], ["2024-07", null], ["2024-08", 15], ["2024-09", null], ["2024-10", null], ["2024-11", null], ["2024-12", 33]], JSON.stringify(g));
assert.deepEqual(g[1].missing, ["2024-05"]);
assert.deepEqual(g[4].missing, ["2024-09"], "an absent month is unknown");
// Average: the total over the window's months, one decimal, only for known windows.
assert.deepEqual(rollingSums(cells, 12, "2024-12", "2024-12", { average: true }).map((r) => r.value), [6.5]);
assert.deepEqual(rollingSums(cells, 12, "2024-06", "2024-06", { average: true }).map((r) => r.value), [null]);
// Series each rolled on its own.
const by = rollingBySeries(new Map([["firearm", cells], ["knife", cells.map((c) => ({ ...c, value: 1 }))]]), 3, "2024-03", "2024-04");
assert.deepEqual([...by].map(([k, rows]) => [k, rows.map((r) => r.value)]), [["firearm", [6, 9]], ["knife", [3, 3]]]);
// Runs of unknown months, for a note.
assert.deepEqual(unknownRuns(g), [["2024-05", "2024-06", "2024-07"], ["2024-09", "2024-10", "2024-11"]], JSON.stringify(unknownRuns(g)));

// The same totals and blanks as transforms.rolling for NIBRS cells.
const nibrs: MonthCell[] = months.map((ym, i) => ({ ym, value: ym === "2024-03" ? null : i + 1, status: ym === "2024-03" ? "UNKNOWN" : "VALUE" }));
const t = rolling(nibrs, 4, ["2024-04", "2024-07", "2025-02"]);
const mine = rollingSums(nibrs.map((c) => ({ ym: c.ym, value: c.value })), 4, "2024-04", "2025-02");
for (const row of t) assert.equal(mine.find((m) => m.ym === row.ym)!.value, row.value, row.ym);

console.log("rolling windows: totals known only when every month is; several series each on their own");
