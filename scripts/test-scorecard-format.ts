import assert from "node:assert/strict";
import {
  formatCount, formatRate, formatClearance, formatChange,
  changeDirection, changeHeaderLabel, SCORECARD_DISPLAY_COLUMNS,
} from "../lib/scorecard-format";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); process.exitCode = 1; }
}

console.log("\n1. Counts use thousands separators; null renders blank");
check("thousands separator", () => assert.equal(formatCount(14138), "14,138"));
check("small number unchanged", () => assert.equal(formatCount(26), "26"));
check("null is blank, not zero", () => assert.equal(formatCount(null), ""));
check("zero is a real value", () => assert.equal(formatCount(0), "0"));

console.log("\n2. Rates keep one decimal and separate thousands");
check("one decimal", () => assert.equal(formatRate(829.5), "829.5"));
check("thousands separator with decimal", () => assert.equal(formatRate(3451.2), "3,451.2"));
check("integer gains a decimal", () => assert.equal(formatRate(115), "115.0"));
check("null is blank", () => assert.equal(formatRate(null), ""));

console.log("\n3. Clearance keeps one decimal and is never clamped");
check("over 100 preserved", () => assert.equal(formatClearance(162.5), "162.5%"));
check("normal value", () => assert.equal(formatClearance(38.3), "38.3%"));
check("null is blank", () => assert.equal(formatClearance(null), ""));

console.log("\n4. Change uses a real minus sign and never shows a fake zero");
check("negative uses an ASCII hyphen, not U+2212", () => assert.equal(formatChange(-12.3), "-12.3%"));
check("positive has no plus sign", () => assert.equal(formatChange(8.3), "8.3%"));
check("exact zero renders as 0.0", () => assert.equal(formatChange(0), "0.0%"));
check("null is BLANK not 0.0", () => assert.equal(formatChange(null), ""));

console.log("\n5. Direction drives colour; polarity is inverted (down is good)");
check("negative is improved", () => assert.equal(changeDirection(-12.3), "improved"));
check("positive is worsened", () => assert.equal(changeDirection(8.3), "worsened"));
check("tiny positive still worsened (no dead-band)", () => assert.equal(changeDirection(0.4), "worsened"));
check("zero is neutral", () => assert.equal(changeDirection(0), "none"));
check("null is neutral", () => assert.equal(changeDirection(null), "none"));

console.log("\n6. Header names the actual prior year");
check("2025 yields 2024", () => assert.equal(changeHeaderLabel(2025), "Change from 2024"));
check("null year degrades gracefully", () => assert.equal(changeHeaderLabel(null), "Change"));

console.log("\n7. Display column order matches the reference mock");
check("change is third", () => assert.deepEqual([...SCORECARD_DISPLAY_COLUMNS],
  ["Type", "Offenses", "Change", "Offense Rate Per 100k", "Clearance Rate"]));

console.log(`\n${process.exitCode ? "FAILURES present." : `All ${passed} scorecard format checks passed.`}`);
process.exit(process.exitCode ? 1 : 0);
