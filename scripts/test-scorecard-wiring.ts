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

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const types = read("lib/types.ts");
const route = read("app/api/query/route.ts");

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); process.exitCode = 1; }
}

const FIELDS = ["scorecard", "agencyLabel", "population"];

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
check("route emits agencyLabel", () => assert.match(route, /agencyLabel:\s*agencyScorecard\.agencyLabel/));
check("route emits population", () => assert.match(route, /population:\s*agencyScorecard\.population/));
check("route emits year", () => assert.match(route, /year:\s*agencyScorecard\.year/));

const chat = read("components/WorkspaceChatV2.tsx");

console.log("\n4. WorkspaceChatV2 does not discard a zero-row scorecard");
check("response construction admits event.scorecard", () => {
  assert.match(chat, /event\.rows\.length > 0 \|\| event\.chartConfig \|\| event\.scorecard/);
});
check("the constructed object copies all four fields", () => {
  for (const field of ["scorecard", "agencyLabel", "population"]) {
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

console.log(`\n${process.exitCode ? "FAILURES present." : `All ${passed} scorecard wiring checks passed.`}`);
process.exit(process.exitCode ? 1 : 0);
