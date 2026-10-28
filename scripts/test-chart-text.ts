/**
 * Chart labels measured, never cut (owner item 3.1; lib/chart-text.ts). These test the layout arithmetic with a fixed
 * measure; the rendered result is checked in a browser at 375, 768 and 1280 px before release (plan section 6).
 *   npx tsx scripts/test-chart-text.ts
 */
import assert from "node:assert/strict";
import { chartBoxMinHeight } from "../lib/chart-layout";
import { estimateWidth, sideLabelWidth, slantedAxisHeight, valueAxisWidth, widestLabel, wrapLabel, wrappedAxisHeight, type Measure } from "../lib/chart-text";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}

// A measure where "W" is twice as wide as other characters, to show widths are measured, not counted.
const m: Measure = (t) => [...t].reduce((s, ch) => s + (ch === "W" ? 14 : 7), 0);

check("wrap keeps every word, each line within the width", () => {
  const label = "Lee's Summit Police Department, Missouri";
  const lines = wrapLabel(label, 100, m);
  assert.equal(lines.join(" "), label);
  assert.ok(lines.every((l) => m(l) <= 100), lines.join(" | "));
});

check("wide glyphs wrap sooner than narrow ones of the same count", () => {
  assert.equal(wrapLabel("aaaaaa aaaaaa", 100, m).length, 1);
  assert.equal(wrapLabel("WWWWWW WWWWWW", 100, m).length, 2);
});

check("a single word wider than the line breaks between characters, no ellipsis", () => {
  const lines = wrapLabel("Supercalifragilistic", 49, m);
  assert.equal(lines.join(""), "Supercalifragilistic");
  assert.ok(lines.every((l) => m(l) <= 49 && !l.includes("…")));
});

check("no line limit: a long label takes as many lines as it needs", () => {
  const label = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
  const lines = wrapLabel(label, 50, m);
  assert.ok(lines.length > 4);
  assert.equal(lines.join(" "), label);
});

check("the wrapped axis grows with the most lines any label needs", () => {
  const short = wrappedAxisHeight(["Houston", "Dallas"], 120, m);
  const tall = wrappedAxisHeight(["Houston", "In custody of another jurisdiction (includes extradition denied)"], 120, m);
  assert.ok(tall > short + 30, `${short} -> ${tall}`);
});

check("slanted axis height follows the widest label, with no 240 px cap", () => {
  const h = slantedAxisHeight(["x".repeat(80)], m);
  assert.equal(h, Math.ceil(80 * 7 * Math.SQRT1_2 + 13 + 16));
  assert.ok(h > 240);
  assert.equal(slantedAxisHeight(["ab"], m), 60, "never below the old 60 px floor");
});

check("sideways label column: the widest label, at most half the box", () => {
  assert.equal(sideLabelWidth(["Austin", "Dallas"], 375, m), 60, "short labels: the 60 px floor");
  assert.equal(sideLabelWidth(["x".repeat(20)], 375, m), 20 * 7 + 14);
  assert.equal(sideLabelWidth(["x".repeat(60)], 375, m), Math.round(375 * 0.5), "capped at half the box; the rest wraps");
});

check("value axis width fits the widest formatted tick", () => {
  assert.equal(valueAxisWidth(["0", "500", "1,000"], m), 5 * 7 + 12);
  assert.equal(valueAxisWidth(["0"], m), 40);
});

check("the estimate is used where nothing can measure", () => {
  assert.equal(widestLabel(["abc", "abcdef"], estimateWidth), 6 * 7.2);
});

check("the chart box grows for long sideways labels, and not for short ones", () => {
  const cfg = { type: "bar", xAxis: "agency", yAxis: ["rate"] };
  const short = Array.from({ length: 14 }, (_, i) => ({ agency: `City ${i}`, rate: i }));
  const long = Array.from({ length: 14 }, (_, i) => ({ agency: `Metropolitan Police Department of a Long Place Name ${i}`, rate: i }));
  const base = chartBoxMinHeight(cfg, short);
  assert.equal(base, chartBoxMinHeight({ ...cfg, type: "line" }, short), "short labels: unchanged from the old reserve");
  assert.ok(chartBoxMinHeight(cfg, long) > base + 200, `long labels drawn sideways reserve their bands (${chartBoxMinHeight(cfg, long)})`);
});

console.log(`\nchart text: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
