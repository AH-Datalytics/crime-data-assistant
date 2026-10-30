/**
 * The local private preview (lib/nibrs-shadow/preview.ts, app/preview, app/api/nibrs-shadow-query): one gate that is
 * off on a production build, the adapter from a shadow outcome to what the UI renders, and button paths. Offline: the
 * DuckDB step is a stub.
 */
import assert from "node:assert/strict";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { follow, previewEnabled, toPreview } from "../lib/nibrs-shadow/preview";

// The gate: off in production whatever else is set; off without a build; on only for local development with a build.
assert.equal(previewEnabled({ NODE_ENV: "production", NIBRS_SHADOW_ROOT: "/build" }), false);
assert.equal(previewEnabled({ NODE_ENV: "development" }), false);
assert.equal(previewEnabled({ NODE_ENV: "development", NIBRS_SHADOW_ROOT: "" }), false);
assert.equal(previewEnabled({ NODE_ENV: "development", NIBRS_SHADOW_ROOT: "/build" }), true);

// A stub executor: 7 per month (by month, by year or total).
function stub(sql: string): unknown[][] {
  const [, from, to] = /range\(DATE '(\d{4}-\d{2})-01', DATE '(\d{4}-\d{2})-01'/.exec(sql)!;
  const months: string[] = [];
  for (let y = +from.slice(0, 4), m = +from.slice(5); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
  if (/cats AS/.test(sql)) return [["F", 30, "VALUE", 0.6, "VALUE"], ["M", 20, "VALUE", 0.4, "VALUE"]];
  if (/AS period/.test(sql)) return months.map((m) => [m, 7, "VALUE"]);
  return [[7 * months.length, "VALUE"]];
}
const deps: ShadowDeps = { places: loadPlaceIndex(), release: { id: "test", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" }, target: { root: "/build", builtYears: [2023, 2024, 2025, 2026] }, execute: stub };

// An answer by month: the table's headers are the columns, rows keyed by them, the chart binds those headers, the text
// in order with the source last.
const monthly = toPreview(shadowAnswer("Shoplifting in Memphis by month in 2024", deps));
assert.equal(monthly.kind, "answer");
if (monthly.kind === "answer") {
  assert.deepEqual(monthly.columns, ["Month", "Shoplifting offenses"]);
  assert.deepEqual(monthly.rows[0], { Month: "2024-01", "Shoplifting offenses": 7 });
  assert.deepEqual([monthly.chart?.type, monthly.chart?.xAxis, monthly.chart?.yAxis], ["line", "Month", ["Shoplifting offenses"]]);
  assert.match(monthly.text[monthly.text.length - 1], /^Source: /);
  // The answer-columns contract: only the table's columns, no status or notes.
  assert.ok(!monthly.columns.some((c) => /status|note/i.test(c)));
}
// A breakdown with shares: no chart (category charts wait), rows keyed by headers.
const bySex = toPreview(shadowAnswer("Simple assault victims in Memphis by sex in 2024", deps));
assert.ok(bySex.kind === "answer" && bySex.chart === null && bySex.rows[0]["Victim sex"] === "Female");

// A clarification: one button per option, each a path; following a path gives that continuation's outcome.
const first = shadowAnswer("How many shoplifting offenses were there in Memphis?", deps);
const ask = toPreview(first);
assert.equal(ask.kind, "clarify");
if (ask.kind === "clarify") {
  assert.deepEqual(ask.buttons.map((b) => [b.label, b.kind]), [["The latest complete year (2025)", "continuation"], ["This year so far", "continuation"], ["Another year", "entry"]]);
  const next = follow(first, ask.buttons[0].path);
  assert.ok(next && next.kind === "answer" && next.period.from === "2025-01");
}
assert.equal(follow(first, ["No such button"]), null);
// A decline with its alternative: the alternative is a button, followed the same way.
const dec = shadowAnswer("Shoplifting in Memphis in 2027", deps);
const decP = toPreview(dec);
assert.ok(decP.kind === "decline" && decP.buttons.length === 1 && decP.buttons[0].kind === "continuation");
if (decP.kind === "decline") assert.equal(follow(dec, decP.buttons[0].path)?.kind, "answer");
// A button to another source is shown but not run.
const other = toPreview(shadowAnswer("How many crimes were there in Detroit in 2024?", deps));
assert.ok(other.kind === "clarify" && other.buttons.every((b) => b.kind === "other-source" && /does not run/.test(b.note ?? "")));

console.log("nibrs preview: gated off in production; outcomes adapted for the UI; buttons followed by path");
