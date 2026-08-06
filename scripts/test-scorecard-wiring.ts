/**
 * Source-level wiring tests.
 *
 * The likeliest failure here is a missing branch, which no unit test of a helper
 * can see: a correct ScorecardPanel renders nothing if the response is discarded
 * upstream. WorkspaceChatV2 builds its response object field-by-field rather than
 * spreading the event, so any field not explicitly copied is dropped silently and
 * the panel renders an empty header instead of erroring.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { expandedCaptureWidth } from "../components/ExportButtons";

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const types = read("lib/types.ts");
const route = read("app/api/query/route.ts");

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); process.exitCode = 1; }
}

// Every field the scorecard boundary carries. WorkspaceChatV2 rebuilds its response
// object field-by-field, so a field missing from any ONE of these three places --
// types, route emit, client reconstruction -- is dropped silently, and the panel
// falls back to defaults instead of erroring.
const FIELDS = [
  "scorecard", "agencyLabel", "year",
  "scope", "yearStatus", "statusText", "newerExcludedYear", "showClearance",
];

console.log("\n1. QueryResponse declares every boundary field");
for (const field of FIELDS) {
  check(`QueryResponse.${field}`, () => {
    const block = types.slice(types.indexOf("export interface QueryResponse"));
    const end = block.indexOf("\n}");
    assert.ok(new RegExp(`\\b${field}\\??:`).test(block.slice(0, end)), `${field} missing`);
  });
}

console.log("\n2. The StreamEvent result variant declares every boundary field");
for (const field of FIELDS) {
  check(`StreamEvent result.${field}`, () => {
    const start = types.indexOf('type: "result"');
    assert.ok(start > 0, "result variant not found");
    const block = types.slice(start, start + 1400);
    assert.ok(new RegExp(`\\b${field}\\??:`).test(block), `${field} missing`);
  });
}

console.log("\n3. The route emits the marker and the header fields");
check("route sets scorecard: true", () => assert.match(route, /scorecard:\s*true/));
for (const field of FIELDS.filter((f) => f !== "scorecard")) {
  check(`route emits ${field}`, () =>
    assert.match(route, new RegExp(`${field}:\\s*agencyScorecard\\.${field}`)));
}

const chat = read("components/WorkspaceChatV2.tsx");
const scorecard = read("components/ScorecardPanel.tsx");

console.log("\n4. WorkspaceChatV2 does not discard a zero-row scorecard");
check("response construction admits event.scorecard", () => {
  assert.match(chat, /event\.rows\.length > 0 \|\| event\.chartConfig \|\| event\.scorecard/);
});
check("the constructed object copies all four fields", () => {
  for (const field of FIELDS) {
    assert.ok(
      new RegExp(`${field}:\\s*event\\.${field}`).test(chat),
      `qr reconstruction does not copy ${field}`,
    );
  }
});
check("hasData admits response.scorecard", () => {
  assert.match(chat, /const hasData =[^;]*response\.scorecard/);
});

console.log("\n5. WorkspaceChatV2 renders one scorecard, not two views of it");
check("ScorecardPanel is imported", () => assert.match(chat, /import ScorecardPanel from "\.\/ScorecardPanel"/));
check("chart slot admits response.scorecard", () => assert.match(chat, /response\.chartConfig \|\| response\.scorecard/));
check("ScorecardPanel is rendered", () => assert.match(chat, /<ScorecardPanel/));
check("DataTable is suppressed for scorecards", () => assert.match(chat, /!response\.scorecard[^)]*&&[\s\S]{0,200}<DataTable/));

console.log("\n6. Scorecard image export captures the bounded card, not the full pane");
check("scorecard marks its bounded export target", () => {
  assert.match(scorecard, /data-scorecard-export/);
});
check("workspace selects the scorecard export target", () => {
  assert.match(chat, /captureSelector=\{response\.scorecard \? "\[data-scorecard-export\]" : undefined\}/);
});
check("scorecard export does not append a duplicate generic footer", () => {
  assert.match(chat, /addFooter=\{!response\.scorecard\}/);
});

console.log("\n7. Mobile export expands the card to the table's intrinsic width");
// Codex measured the failure at a 390px viewport: card 340, scroller 308, table 530 --
// the PNG captured only the visible 342 CSS px and clipped every scrolled-out column.
check("expanded width = table width + the card's padding and border", () => {
  assert.equal(expandedCaptureWidth(340, 308, 530), 562);
});
check("fractional layout widths round up, never clipping a pixel", () => {
  assert.equal(expandedCaptureWidth(340.4, 308.4, 530), 562);
});
check("a non-overflowing table keeps the card width unchanged", () => {
  // The DOM helper never fires in this case (scrollWidth <= clientWidth guard), so the
  // formula degenerating to the current card width is the consistent identity.
  assert.equal(expandedCaptureWidth(644, 612, 612), 644);
});
check("the panel exposes the scroll container to the exporter", () => {
  assert.match(scorecard, /data-scorecard-scroll/);
});
const exportButtons = read("components/ExportButtons.tsx");
check("expansion runs only on the bounded-capture (scorecard) path", () => {
  assert.match(exportButtons, /captureSelector \? expandScrollableCapture\(captureTarget\) : null/);
});
check("expansion is restored in a finally block", () => {
  assert.match(exportButtons, /finally \{\s*\/\/[^\n]*\n[^\n]*\n\s*restoreExpansion\?\.\(\);/);
});
check("scroll position is reset for capture and restored after", () => {
  assert.match(exportButtons, /scroller\.scrollLeft = 0/);
  assert.match(exportButtons, /scroller\.scrollLeft = saved\.scrollLeft/);
});

console.log(`\n${process.exitCode ? "FAILURES present." : `All ${passed} scorecard wiring checks passed.`}`);
process.exit(process.exitCode ? 1 : 0);
