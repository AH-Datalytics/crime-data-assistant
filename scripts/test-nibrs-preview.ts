/**
 * The local private preview (lib/nibrs-shadow/preview.ts, app/preview, app/api/nibrs-shadow-query): one gate that is
 * off on a production build, the adapter from a shadow outcome to what the UI renders, and button paths. Offline: the
 * DuckDB step is a stub.
 */
import assert from "node:assert/strict";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { follow, parseRequest, previewEnabled, toPreview } from "../lib/nibrs-shadow/preview";

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
  // With the incidents beside the count (P66): a clearance breakdown, or cleared victims by sex.
  if (/cats AS/.test(sql) && /_incidents"/.test(sql)) {
    const [a, b] = /'cleared'/.test(sql) && !/sex/.test(sql) ? ["cleared", "none"] : ["F", "M"];
    return [[a, 14, "VALUE", 12, "VALUE", 0.6, "VALUE"], [b, 10, "VALUE", 9, "VALUE", 0.4, "VALUE"]];
  }
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
  assert.deepEqual(monthly.ordered, ["Month"], "P86: a time grouping keeps its order");
  assert.deepEqual(monthly.rows[0], { Month: "2024-01", "Shoplifting offenses": 7 });
  assert.deepEqual([monthly.chart?.type, monthly.chart?.xAxis, monthly.chart?.yAxis], ["line", "Month", ["Shoplifting offenses"]]);
  assert.match(monthly.text[monthly.text.length - 1], /^Source: /);
  // The answer-columns contract: only the table's columns, no status or notes.
  assert.ok(!monthly.columns.some((c) => /status|note/i.test(c)));
}
// The answer contract: with the place index (as the API route passes it), the response carries its presentation.
assert.equal(toPreview(shadowAnswer("Shoplifting in Memphis by month in 2024", deps)).presentation, undefined);
const withP = toPreview(shadowAnswer("Shoplifting in Memphis by month in 2024", deps), [], deps.places).presentation;
assert.ok(withP && "titleParts" in withP && withP.source === "nibrs" && withP.titleParts.groupings[0] === "month" && withP.chart.default === "line", JSON.stringify(withP));
// A breakdown with shares: no chart (category charts wait), rows keyed by headers.
const bySex = toPreview(shadowAnswer("Simple assault victims in Memphis by sex in 2024", deps));
assert.ok(bySex.kind === "answer" && bySex.chart === null && bySex.rows[0]["Victim sex"] === "Female");
// Exclusive categories (stacked and 100% charts only when honest): passed through; absent with no category grouping.
assert.ok(bySex.kind === "answer" && bySex.exclusive === true);
const byWeapon = toPreview(shadowAnswer("Robberies in Memphis in 2024 by weapon", deps));
assert.ok(byWeapon.kind === "answer" && byWeapon.exclusive === false);
assert.ok(monthly.kind === "answer" && !("exclusive" in monthly) && !("exclusiveByColumn" in monthly));
assert.ok(bySex.kind === "answer" && Object.values(bySex.exclusiveByColumn ?? {}).every((v) => v === true));
// Jeff's example: a clearance breakdown stacks, Incidents column included; cleared victims by sex stack only the count.
const carjack = toPreview(shadowAnswer("Carjacking offenses in Memphis by clearance status in 2024", deps));
assert.ok(carjack.kind === "answer" && carjack.exclusive === true && carjack.exclusiveByColumn?.Incidents === true, JSON.stringify(carjack).slice(0, 300));
const clearedSex = toPreview(shadowAnswer("Simple assault victims in Detroit by sex in 2023 that were cleared", deps));
assert.ok(clearedSex.kind === "answer" && clearedSex.exclusive === true && clearedSex.exclusiveByColumn?.Incidents === false, JSON.stringify(clearedSex).slice(0, 300));

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
// No button that can't run (coordinator 2026-11-02): with no Historical build, the crime-kind question is a plain decline.
const other = toPreview(shadowAnswer("How many crimes were there in Detroit in 2024?", deps));
assert.ok(other.kind === "decline" && other.buttons.every((b) => b.kind !== "other-source"), JSON.stringify(other));
// A button whose years this build does not hold is shown with the reason, never offered ("the last 10 complete
// years" is 2016-2025; the build starts in 2017). An entry asks for the whole question again (no follow-up turns).
// (All years by default, Jeff 2026-11-11: a trend for one agency now answers; the years are still asked where every
// year can't be answered, as for several agencies by month.)
const range = toPreview(shadowAnswer("Shoplifting in Memphis and Nashville by month", deps));
assert.ok(range.kind === "clarify");
if (range.kind === "clarify") {
  assert.deepEqual(range.buttons.map((b) => [b.label, b.kind]), [["The last 10 complete years", "not-built"], ["Every year available", "continuation"], ["Another range", "entry"]]);
  assert.match(range.buttons[0].note ?? "", /^Not in the data this preview uses: NIBRS figures here cover January 2017 through September 2026, so they don.t include 2016 to 2025.$/);
  assert.match(range.buttons[2].note ?? "", /ask the whole question again/);
}
const forecast = toPreview(shadowAnswer("Will shoplifting rise in Denver next year?", deps));
assert.ok(forecast.kind === "decline" && forecast.buttons.length === 1 && forecast.buttons[0].kind === "not-built");

// Requests: a question is never shortened; one over the limit, an empty one or a malformed path is refused before the engine.
assert.deepEqual(parseRequest({ question: "  Shoplifting in Memphis in 2024 " }), { question: "Shoplifting in Memphis in 2024", path: [] });
assert.ok("error" in parseRequest({ question: "x".repeat(501) }) && /longer than 500/.test((parseRequest({ question: "x".repeat(501) }) as { error: string }).error));
assert.deepEqual(parseRequest({ question: "x".repeat(500) }), { question: "x".repeat(500), path: [] });
for (const bad of [null, {}, { question: "  " }, { question: "q", path: "a" }, { question: "q", path: [1] }, { question: "q", path: Array(11).fill("a") }]) assert.ok("error" in parseRequest(bad), JSON.stringify(bad));

console.log("nibrs preview: gated off in production; outcomes adapted for the UI; buttons followed by path");
