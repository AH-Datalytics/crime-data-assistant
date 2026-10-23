/**
 * NIBRS typed-chart hotfix (owner report 2026-10-22: "carjacking per month in Memphis ... only a table, no graph").
 * The real NIBRS POST handler on a fixture database, the model stubbed and counted (never needed here), the network
 * refused: a typed answer over periods now carries a line chart, one period across places a bar chart, a single value no
 * chart. Plus the chart-layout safeguards the chart relies on: a varying row note never becomes a series, and a ranking
 * whose labels collide is not split by state.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); failed++; process.exitCode = 1; }
}
let modelCalls = 0;
const network: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
  if (url.includes("api.anthropic.com")) modelCalls += 1;
  network.push(url);
  throw new Error(`network refused: ${url}`);
}) as typeof globalThis.fetch;

const DDL = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-typed-chart-"));
const open = (name: string, ddl: string) => { const db = new Database(path.join(DIR, name)); db.pragma("journal_mode = WAL"); db.exec(fs.readFileSync(path.join(DDL, ddl), "utf8")); return db; };
{
  const db = open("nibrs.db", "nibrs.ddl.sql");
  const ag = db.prepare("INSERT INTO agencies (ori, year, state_code, state, city, population, agency_type) VALUES (?,?,?,?,?,?,?)");
  const comp = db.prepare("INSERT INTO nibrs_agency_completeness (ori, year, months_reported, total_offenses) VALUES (?,?,?,?)");
  db.exec("CREATE TABLE IF NOT EXISTS summary_carjacking_monthly (year INT, month INT, state TEXT, ori TEXT, offense_count INT)");
  const cj = db.prepare("INSERT INTO summary_carjacking_monthly (year, month, state, ori, offense_count) VALUES (?,?,?,?,?)");
  // reporting evidence: the agency reported offenses every month (months reported are inferred from these rows)
  const cm = db.prepare("INSERT INTO summary_city_monthly (year, month, state, ori, ucr_offense_code, offense_count, cleared_count) VALUES (?,?,?,?,?,?,?)");
  for (const y of [2024, 2025]) {
    ag.run("TNMPD0000", y, "TN", "TN", "MEMPHIS", 610000, "City"); // the source files city names in upper case
    ag.run("TNKPD0000", y, "TN", "TN", "KNOXVILLE", 700000, "City");
    comp.run("TNMPD0000", y, 12, 1000);
    comp.run("TNKPD0000", y, 12, 1000);
    for (let m = 1; m <= 12; m += 1) { cj.run(y, m, "TN", "TNMPD0000", 20 + m); cj.run(y, m, "TN", "TNKPD0000", 5 + m); cm.run(y, m, "TN", "TNMPD0000", "120", 300, 30); cm.run(y, m, "TN", "TNKPD0000", "120", 200, 20); }
  }
  db.close();
}
for (const [name, ddl] of [["crime_data.db", "crime_data.ddl.sql"], ["query_log.db", "query_log.ddl.sql"], ["nibrs_rollups.db", "rollup.ddl.sql"], ["shr.db", "shr.ddl.sql"], ["hate_crime.db", "hc.ddl.sql"]]) open(name, ddl).close();
process.env.RTCI_DB_PATH = path.join(DIR, "crime_data.db");
process.env.QUERY_LOG_DB_PATH = path.join(DIR, "query_log.db");
process.env.NIBRS_DB_PATH = path.join(DIR, "nibrs.db");
process.env.NIBRS_ROLLUP_DB_PATH = path.join(DIR, "nibrs_rollups.db");
process.env.SHR_DB_PATH = path.join(DIR, "shr.db");
process.env.HATE_CRIME_DB_PATH = path.join(DIR, "hate_crime.db");
process.env.ANTHROPIC_API_KEY = "sk-ant-test-stub";
delete process.env.PROOF_MODE;
const token = () => { const ts = String(Date.now() - 5000); const sec = process.env.AUTH_PASSWORD || "nibrs-page-token-secret"; return Buffer.from(`${ts}:${createHmac("sha256", sec).update(ts).digest("hex").slice(0, 16)}`).toString("base64"); };

async function main() {
  const { NextRequest } = await import("next/server");
  const route = (await import("../app/api/nibrs-query/route")) as unknown as { POST: (r: unknown) => Promise<Response> };
  const { typedChartConfig, SERIES, CHANGE, BREAKDOWN, RANK, SHARE } = await import("../lib/nibrs-question-compiler");
  const { detectAndPivotChartData } = await import("../lib/chart-layout");
  let ip = 0;
  const ask = async (question: string) => {
    ip += 1;
    const res = await route.POST(new NextRequest("http://localhost/api/nibrs-query", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.5.${ip}.1` }, body: JSON.stringify({ question, history: [], sessionId: `chart-${ip}`, pageToken: token() }) }));
    return { status: res.status, body: JSON.parse(await res.text()) as { sql: string | null; rows: Record<string, unknown>[]; chartConfig: Record<string, unknown> | null; explanation: string } };
  };
  const show = (b: { rows: unknown[]; chartConfig: unknown; explanation: string; title?: string; sql?: string | null }) => `rows=${b.rows.length} chart=${JSON.stringify(b.chartConfig)} title=${b.title} cols=${JSON.stringify((b as {columns?: unknown}).columns)} row0=${JSON.stringify(b.rows[0])} sql=${String(b.sql).slice(0, 200)} | ${String(b.explanation).slice(0, 120)}`;

  console.log("\nthe owner's question, through the real handler");
  await check("carjacking per month in Memphis: monthly rows with a line chart over the period", async () => {
    const { status, body } = await ask("carjacking per month in Memphis in 2025");
    assert.equal(status, 200);
    assert.match(String(body.sql), /summary_carjacking_monthly/, show(body));
    assert.equal(body.rows.length, 12, show(body));
    assert.deepEqual(body.chartConfig && { type: body.chartConfig.type, xAxis: body.chartConfig.xAxis, yAxis: body.chartConfig.yAxis }, { type: "line", xAxis: "period", yAxis: ["value"] }, show(body));
    assert.deepEqual(body.rows.map((r) => Number(r.value)), Array.from({ length: 12 }, (_, i) => 21 + i), "January-December 2025 values");
    assert.equal((body as { title?: string }).title, "Memphis, TN Carjackings Per Month, 2025", "owner title format");
    assert.equal(body.chartConfig?.title, "Memphis, TN Carjackings Per Month, 2025");
  });
  await check("one value (a single year total) has no chart; its title is 'Memphis, TN Carjackings, 2025'", async () => {
    const { body } = await ask("carjackings in Memphis in 2025");
    assert.equal(body.rows.length, 1, show(body));
    assert.equal(body.chartConfig, null, show(body));
    assert.equal((body as { title?: string }).title, "Memphis, TN Carjackings, 2025");
  });
  await check("two places in one year: exactly two rows, bars by place; both places in the title", async () => {
    const { body } = await ask("carjackings in Memphis and Knoxville in 2025");
    assert.equal((body as { title?: string }).title, "Memphis, TN and Knoxville, TN Carjackings, 2025");
    assert.deepEqual(body.rows.map((r) => [r.place, Number(r.value)]), [["Memphis, TN", 318], ["Knoxville, TN", 138]], show(body));
    assert.deepEqual(body.chartConfig && { type: body.chartConfig.type, xAxis: body.chartConfig.xAxis, yAxis: body.chartConfig.yAxis }, { type: "bar", xAxis: "place", yAxis: ["value"] }, show(body));
  });

  console.log("\nchart choice by delivered shape (Codex build ruling: only faithful shapes; everything else keeps its table)");
  const row = (period: string | number, place: string, value: number | null, extra: Record<string, unknown> = {}) => ({ period, place, measure: "carjacking", unit: "offenses", filter: null, statistic: "count", value, note: null, ...extra });
  const series = (periods: (string | number)[], places: string[]) => places.flatMap((p) => periods.map((x) => row(x, p, 1)));
  await check("series: a complete period grid → line; one period across places → bars; one row → none", () => {
    assert.equal(typedChartConfig(SERIES, series(["2025-01", "2025-02", "2025-03"], ["Memphis, TN"]), "t")?.type, "line");
    assert.equal(typedChartConfig(SERIES, series([2024, 2025], ["Memphis, TN", "Nashville, TN"]), "t")?.type, "line");
    assert.equal(typedChartConfig(SERIES, series([2025], ["Memphis, TN", "Nashville, TN"]), "t")?.xAxis, "place");
    assert.equal(typedChartConfig(SERIES, series([2025], ["Memphis, TN"]), "t"), null);
  });
  await check("several places AND several measures: table only (the pivot would drop a measure)", () => {
    const rows = [2024, 2025].flatMap((y) => ["Memphis, TN", "Nashville, TN"].flatMap((p) => ["carjacking", "robbery"].map((m) => row(y, p, 1, { measure: m }))));
    assert.equal(typedChartConfig(SERIES, rows, "t"), null);
  });
  await check("mixed units (victims beside offenses): table only", () => {
    const rows = [row(2025, "Memphis, TN", 10, { measure: "murder", unit: "victims" }), row(2025, "Memphis, TN", 20, { measure: "robbery", unit: "offenses" })];
    assert.equal(typedChartConfig(SERIES, rows, "t"), null);
  });
  await check("a partial-period row: table only until partial markers ship", () => {
    const rows = [row(2024, "Memphis, TN", 300), row(2025, "Memphis, TN", 280), row(2026, "Memphis, TN", 150, { note: "partial year (January-June)" })];
    assert.equal(typedChartConfig(SERIES, rows, "t"), null);
  });
  await check("a lone value between gaps, or an incomplete grid: table only (nothing visible would be drawn)", () => {
    assert.equal(typedChartConfig(SERIES, [row(2023, "Memphis, TN", null), row(2024, "Memphis, TN", 5), row(2025, "Memphis, TN", null)], "t"), null);
    assert.equal(typedChartConfig(SERIES, [row(2024, "Memphis, TN", 5), row(2025, "Memphis, TN", 6), row(2025, "Nashville, TN", 7)], "t"), null);
  });
  await check("breakdown: one period → bars by category; complete grid over periods → lines; sparse grid → table", () => {
    const b = (period: number, category: string, count: number) => ({ period, place: "Memphis, TN", measure: "carjacking", unit: "offenses", filter: null, dimension: "location", category, count, share: null, note: null });
    assert.deepEqual(typedChartConfig(BREAKDOWN, [b(2025, "street", 5), b(2025, "parking lot", 3)], "t"), { type: "bar", xAxis: "category", yAxis: ["count"], title: "t" });
    assert.equal(typedChartConfig(BREAKDOWN, [b(2024, "street", 5), b(2024, "lot", 3), b(2025, "street", 6), b(2025, "lot", 2)], "t")?.type, "line");
    assert.equal(typedChartConfig(BREAKDOWN, [b(2024, "street", 5), b(2025, "street", 6), b(2025, "lot", 2)], "t"), null);
  });
  await check("ranking → bars; share and change → no chart; no values → no chart", () => {
    const rk = (place: string, value: number) => ({ rank: 1, place, year: 2025, measure: "carjacking", unit: "offenses", statistic: "count", value, population: null });
    assert.equal(typedChartConfig(RANK, [rk("A", 3), rk("B", 2)], "t")?.type, "bar");
    assert.equal(typedChartConfig(SHARE, [{ period: 2025 }, { period: 2024 }], "t"), null);
    assert.equal(typedChartConfig(CHANGE, [{ place: "x" }, { place: "y" }], "t"), null);
    assert.equal(typedChartConfig(SERIES, series([2024, 2025], ["Memphis, TN"]).map((r) => ({ ...r, value: null })), "t"), null);
  });

  console.log("\nchart-layout safeguards");
  await check("a varying row note never splits one series", () => {
    const rows = series([2024, 2025, 2026], ["Memphis, TN"]).map((r) => ({ ...r, note: r.period === 2026 ? "partial year" : null }));
    assert.deepEqual(detectAndPivotChartData(rows, "period", ["value"]).effectiveYKeys, ["value"]);
  });
  await check("several places over periods still pivot by place", () => {
    assert.deepEqual(detectAndPivotChartData(series([2024, 2025], ["Memphis, TN", "Nashville, TN"]), "period", ["value"]).effectiveYKeys, ["Memphis, TN", "Nashville, TN"]);
  });
  await check("sparse series still pivot into separate series (Codex's regression case: A 2021-2023, B 2023-2024)", () => {
    const rows = [{ year: 2021, s: "A", v: 1 }, { year: 2022, s: "A", v: 2 }, { year: 2023, s: "A", v: 3 }, { year: 2023, s: "B", v: 4 }, { year: 2024, s: "B", v: 5 }];
    assert.deepEqual(detectAndPivotChartData(rows, "year", ["v"]).effectiveYKeys, ["A", "B"]);
  });
  console.log("\ntable display (owner screenshot 2026-10-22: six of eight columns repeated or empty on 106 rows; Codex r3 corrections)");
  const { tableDisplay, monthLabel } = await import("../lib/table-display");
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const DataTable = (await import("../components/DataTable")).default;
  const html = (columns: string[], rows: Record<string, unknown>[]) => renderToStaticMarkup(React.createElement(DataTable, { columns, rows }));
  await check("the owner's monthly carjacking table shows only Month and Carjackings (owner: 'only show month and carjackings')", () => {
    const rows = ["2018-12", "2019-01", "2019-02"].map((p, i) => ({ period: p, place: "Memphis, TN", measure: "carjacking", unit: "offenses", filter: null, statistic: "count", value: [42, 34, 22][i], note: null }));
    const d = tableDisplay(SERIES, rows, "carjacking — Memphis, TN");
    assert.deepEqual(d.shown, ["period", "value"]);
    assert.deepEqual(d.labels, { period: "Month", value: "Carjackings" });
    assert.deepEqual(d.constants, [], "the title states the place; the value column's name carries the offense, unit and count");
    const out = renderToStaticMarkup(React.createElement(DataTable, { columns: SERIES, rows, title: "carjacking — Memphis, TN" }));
    const headers = [...out.matchAll(/<th[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(headers, ["Month", "Carjackings"], out.slice(0, 500));
    assert.doesNotMatch(out, /data-table-constants/, "nothing is restated above the table");
  });
  await check("without a title stating it, the place is stated once with its name; yearly periods are named Year; victims and rates get plain names", () => {
    const rows = [2024, 2025].map((y) => ({ period: y, place: "Memphis, TN", measure: "murder", unit: "victims", filter: null, statistic: "count", value: 10, note: null }));
    const d = tableDisplay(SERIES, rows);
    assert.deepEqual(d.labels, { period: "Year", value: "Murder victims" });
    assert.deepEqual(d.constants, [{ column: "place", value: "Memphis, TN" }]);
    const r = tableDisplay(SERIES, rows.map((x) => ({ ...x, measure: "robbery", unit: "offenses", statistic: "rate_per_100k" })), "robbery — Memphis, TN");
    assert.equal(r.labels.value, "Robbery rate per 100k");
  });
  await check("rendered constants keep their column names, so two constant dimensions stay distinguishable (Codex r3 case)", () => {
    const rows = [{ year: 2024, victim_race: "White", offender_race: "Black", count: 3 }, { year: 2025, victim_race: "White", offender_race: "Black", count: 5 }];
    const out = html(["year", "victim_race", "offender_race", "count"], rows);
    assert.match(out, /Victim Race: White · Offender Race: Black/, out.slice(0, 400));
  });
  await check("a result column empty on every row stays visible (a change that could not be calculated, Codex r3 case)", () => {
    const cols = ["place", "measure", "unit", "statistic", "earlier_year", "earlier_value", "later_year", "later_value", "change", "percent_change", "note"];
    const rows = [
      { place: "A", measure: "murder", unit: "offenses", statistic: "count", earlier_year: 2020, earlier_value: null, later_year: 2024, later_value: 10, change: null, percent_change: null, note: null },
      { place: "B", measure: "murder", unit: "offenses", statistic: "count", earlier_year: 2020, earlier_value: null, later_year: 2024, later_value: 12, change: null, percent_change: null, note: null },
    ];
    const shown = tableDisplay(cols, rows).shown;
    for (const c of ["earlier_value", "change", "percent_change", "later_value"]) assert.ok(shown.includes(c), `${c} kept: ${shown.join(",")}`);
    assert.ok(!shown.includes("note"), "an empty note is still hidden");
  });
  await check("a varying column is kept; a numeric column is kept even when constant", () => {
    const rows = [{ period: 2024, place: "Memphis, TN", value: 5, population: 600000 }, { period: 2024, place: "Knoxville, TN", value: 3, population: 600000 }];
    assert.deepEqual(tableDisplay(["period", "place", "value", "population"], rows).shown, ["period", "place", "value", "population"]);
  });
  await check("a one-row answer folds only the known descriptive columns (owner: a single value showed all eight columns); a two-column table is unchanged", () => {
    const one = tableDisplay(SERIES, [{ period: 2025, place: "Memphis, TN", measure: "carjacking", unit: "offenses", filter: null, statistic: "count", value: 190, note: null }], "Memphis, TN Carjackings, 2025");
    assert.deepEqual(one.shown, ["period", "value"]);
    assert.deepEqual(one.labels, { period: "Year", value: "Carjackings" });
    assert.deepEqual(one.constants, []);
    const other = tableDisplay(["period", "category", "count"], [{ period: 2025, category: "street", count: 3 }]);
    assert.deepEqual(other.shown, ["period", "category", "count"], "a one-row non-descriptive text column stays");
    assert.deepEqual(tableDisplay(["year", "value"], [{ year: 2024, value: 1 }, { year: 2025, value: 1 }]).shown, ["year", "value"]);
  });
  await check("a table that would be reduced to its label column alone is shown unchanged (three-column fallback)", () => {
    const rows = [{ period: "2025-01", place: "Memphis, TN", measure: "carjacking" }, { period: "2025-02", place: "Memphis, TN", measure: "carjacking" }];
    assert.deepEqual(tableDisplay(["period", "place", "measure"], rows), { shown: ["period", "place", "measure"], constants: [], labels: {}, months: ["period"] });
  });
  await check("a Note column is never shown (owner 2026-10-23: 'shouldn't be a Note column EVER'), filled or empty, in any fallback", () => {
    const base = (note: string | null) => ({ period: 2024, place: "Memphis, TN", value: 1, note });
    assert.ok(!tableDisplay(["period", "place", "value", "note"], [base(null), { ...base("partial year"), period: 2025 }]).shown.includes("note"));
    assert.ok(!tableDisplay(["period", "place", "value", "note"], [base(null), { ...base(null), period: 2025 }]).shown.includes("note"));
    assert.deepEqual(tableDisplay(["period", "value", "note"], [{ period: 2024, value: 1, note: "partial year" }]).shown, ["period", "value"], "the short-table fallback drops it too");
    assert.deepEqual(tableDisplay(["year", "notes"], [{ year: 2024, notes: "x" }, { year: 2025, notes: "y" }]).shown, ["year"]);
    const houston = Array.from({ length: 4 }, (_, i) => ({ period: `2019-0${i + 1}`, place: "Houston, TX", measure: "carjacking", unit: "offenses", filter: null, statistic: "count", value: 60 + i, note: i === 3 ? "partial year (January-June)" : null }));
    const out = renderToStaticMarkup(React.createElement(DataTable, { columns: SERIES, rows: houston, title: "Houston, TX Carjackings Per Month, 2019" }));
    assert.deepEqual([...out.matchAll(/<th[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) => m[1]), ["Month", "Carjackings"], "rendered: no Note header");
    assert.ok(!/partial year/.test(out), "rendered: no note text in the grid");
  });
  await check("SHR share table (owner 2026-10-23): plain headers from the answer, no 'Shr Records: recorded', place in the title", () => {
    const cols = ["place", "year", "numerator_victims", "denominator_victims", "share_pct", "unknown_value_victims", "shr_records"];
    const rows = [1976, 1977].map((year, i) => ({ place: "United States", year, numerator_victims: 2079 + i, denominator_victims: 4080 + i, share_pct: 51 + i, unknown_value_victims: 12, shr_records: "recorded" }));
    const columnLabels = { numerator_victims: "Killed With A Firearm", denominator_victims: "All Female Homicide Victims", share_pct: "Share (%)", unknown_value_victims: "Weapon Unknown" };
    const out = renderToStaticMarkup(React.createElement(DataTable, { columns: cols, rows, title: "Share Of Female Homicide Victims Killed With A Firearm, United States, 1976 to 2026 (2026 Through October)", columnLabels }));
    assert.deepEqual([...out.matchAll(/<th[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) => m[1]), ["Year", "Killed With A Firearm", "All Female Homicide Victims", "Share (%)", "Weapon Unknown"]);
    assert.ok(!/data-table-constants/.test(out), "nothing stated above the table");
    const odd = tableDisplay(cols, rows.map((r, i) => ({ ...r, shr_records: i ? "no SHR records (unknown)" : "recorded" })), "", columnLabels);
    assert.ok(odd.shown.includes("shr_records"), "a status that is not 'recorded' everywhere stays");
    assert.equal(tableDisplay(cols, rows, "", { year: "Weapon Unknown", Month: "x", period: "y" }).labels.year, undefined, "a supplied label never renames a time column");
  });
  await check("round 1 Q3: an unrequested unknown count is not shown in the grid; the denominator stays", () => {
    const cols = ["place", "year", "numerator_victims", "denominator_victims", "share_pct", "unknown_value_victims", "shr_records"];
    const rows = [1976, 1977].map((year, i) => ({ place: "United States", year, numerator_victims: 2079 + i, denominator_victims: 4080 + i, share_pct: 51 + i, unknown_value_victims: 12, shr_records: "recorded" }));
    const columnLabels = { numerator_victims: "Killed With A Firearm", denominator_victims: "All Female Homicide Victims", share_pct: "Share (%)", unknown_value_victims: "" };
    const out = renderToStaticMarkup(React.createElement(DataTable, { columns: cols, rows, title: "Share Of Female Homicide Victims Killed With A Firearm, United States, 1976 to 2026", columnLabels }));
    assert.deepEqual([...out.matchAll(/<th[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) => m[1]), ["Year", "Killed With A Firearm", "All Female Homicide Victims", "Share (%)"]);
    assert.ok(!tableDisplay(cols, rows, "", columnLabels).shown.includes("unknown_value_victims"));
  });
  await check("round 1 Q8: the pooled SHR status column is hidden only when every cell is empty", () => {
    const cols = ["place", "victims", "periods_without_records"];
    const empty = [{ place: "Texas", victims: 1200, periods_without_records: null }, { place: "Ohio", victims: 700, periods_without_records: null }];
    assert.ok(!tableDisplay(cols, empty).shown.includes("periods_without_records"), "all empty: hidden");
    const some = [{ place: "Texas", victims: 1200, periods_without_records: null }, { place: "Ohio", victims: 700, periods_without_records: "2021" }];
    assert.ok(tableDisplay(cols, some).shown.includes("periods_without_records"), "a substantive status stays");
  });
  await check("monthly periods read 'MMM YY' in the grid (owner 2026-10-23); years and the raw values are unchanged", () => {
    assert.equal(monthLabel("2019-01"), "Jan 19");
    assert.equal(monthLabel("2025-12"), "Dec 25");
    assert.equal(monthLabel("2025"), "2025");
    assert.equal(monthLabel("2025-13"), "2025-13");
    const rows = ["2019-01", "2019-02"].map((p, i) => ({ period: p, place: "Houston, TX", measure: "carjacking", unit: "offenses", filter: null, statistic: "count", value: 108 - i * 49, note: null }));
    const out = renderToStaticMarkup(React.createElement(DataTable, { columns: SERIES, rows }));
    assert.deepEqual([...out.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]), ["Jan 19", "108", "Feb 19", "59"]);
    const years = renderToStaticMarkup(React.createElement(DataTable, { columns: ["period", "value"], rows: [{ period: 2024, value: 1 }, { period: 2025, value: 2 }] }));
    assert.match(years, /<td[^>]*>2024<\/td>/);
    assert.deepEqual(tableDisplay(SERIES, rows).months, ["period"]);
  });
  console.log("\ntable display safeguards (Codex r5)");
  const rob = (extra: Record<string, unknown>) => [2024, 2025].map((y, i) => ({ period: y, place: "Memphis, TN", measure: "robbery", unit: "offenses", filter: null, statistic: "count", value: 10 + i, note: null, ...extra }));
  await check("a varying statistic or unit: no value name, the plain header stays", () => {
    const stat = rob({}).map((r, i) => ({ ...r, statistic: i ? "rate_per_100k" : "count" }));
    assert.equal(tableDisplay(SERIES, stat, "robbery — Memphis, TN").labels.value, undefined);
    const unit = rob({}).map((r, i) => ({ ...r, unit: i ? "victims" : "offenses" }));
    assert.equal(tableDisplay(SERIES, unit, "robbery — Memphis, TN").labels.value, undefined);
  });
  await check("an unsupported constant unit (arrests): no value name, and the unit stays stated", () => {
    const d = tableDisplay(SERIES, rob({ unit: "arrests" }), "robbery — Memphis, TN");
    assert.equal(d.labels.value, undefined);
    assert.ok(d.constants.some((c) => c.column === "unit" && c.value === "arrests"), JSON.stringify(d.constants));
    assert.ok(d.constants.some((c) => c.column === "measure"), "the measure stays stated when the value column is not named for it");
  });
  await check("only the place is dropped for a title, and only on its whole label: 'IN' and race roles stay", () => {
    const st = [{ city: "A", state: "IN", value: 1, n: 1 }, { city: "B", state: "IN", value: 2, n: 2 }];
    assert.ok(tableDisplay(["city", "state", "value", "n"], st, "Cities in Indiana").constants.some((c) => c.column === "state"));
    const pairs = [{ year: 2024, victim_race: "White", offender_race: "Black", count: 3 }, { year: 2025, victim_race: "White", offender_race: "Black", count: 5 }];
    assert.deepEqual(tableDisplay(["year", "victim_race", "offender_race", "count"], pairs, "White and Black homicide pairs").constants.map((c) => c.column), ["victim_race", "offender_race"]);
    assert.ok(tableDisplay(SERIES, rob({}), "robbery — Memphis").constants.some((c) => c.column === "place"), "a partial place label in the title does not drop it");
  });
  await check("no displayed title (the embed page, a hidden chart): the place is stated with its name", () => {
    const out = renderToStaticMarkup(React.createElement(DataTable, { columns: SERIES, rows: rob({}) }));
    assert.match(out, /Place: Memphis, TN/, out.slice(0, 300));
    assert.deepEqual([...out.matchAll(/<th[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) => m[1]), ["Year", "Robberies"]);
  });
  console.log("\nseries titles (owner 2026-10-22)");
  const { seriesTitle } = await import("../lib/nibrs-question-compiler");
  const r = (period: string | number, extra: Record<string, unknown> = {}) => ({ period, place: "Memphis, TN", measure: "carjacking", unit: "offenses", statistic: "count", value: 1, note: null, ...extra });
  const FB = "previous title";
  await check("titles from the requested grain: per month, per year (also with one result), a total year or month", () => {
    assert.equal(seriesTitle(["2025-01", "2025-02"].map((p) => r(p)), ["carjacking"], "month", FB), "Memphis, TN Carjackings Per Month, 2025");
    assert.equal(seriesTitle(["2024-12", "2025-01"].map((p) => r(p)), ["carjacking"], "month", FB), "Memphis, TN Carjackings Per Month, 2024 to 2025");
    assert.equal(seriesTitle([2018, 2019, 2025].map((p) => r(p)), ["carjacking"], "year", FB), "Memphis, TN Carjackings Per Year, 2018 to 2025");
    assert.equal(seriesTitle([r(2025)], ["carjacking"], "year", FB), "Memphis, TN Carjackings Per Year, 2025", "an annual request with one result keeps Per Year");
    assert.equal(seriesTitle([r(2025)], ["carjacking"], "total", FB), "Memphis, TN Carjackings, 2025");
    assert.equal(seriesTitle([r("2025-03")], ["carjacking"], "total", FB), "Memphis, TN Carjackings, March 2025", "single-month coverage");
    assert.equal(seriesTitle([r("2025-03")], ["carjacking"], "month", FB), "Memphis, TN Carjackings Per Month, March 2025");
  });
  await check("titles name each measure from its own rows: victims, victim rates, offense rates, mixed units", () => {
    assert.equal(seriesTitle([2024, 2025].map((p) => r(p, { measure: "murder", unit: "victims" })), ["murder"], "year", FB), "Memphis, TN Murder Victims Per Year, 2024 to 2025");
    assert.equal(seriesTitle([2024, 2025].map((p) => r(p, { measure: "murder", unit: "victims", statistic: "rate_per_100k" })), ["murder"], "year", FB), "Memphis, TN Murder Victim Rate Per 100k Per Year, 2024 to 2025");
    assert.equal(seriesTitle([2024, 2025].map((p) => r(p, { measure: "robbery", statistic: "rate_per_100k" })), ["robbery"], "year", FB), "Memphis, TN Robbery Rate Per 100k Per Year, 2024 to 2025");
    const mixed = [...[2024, 2025].map((p) => r(p)), ...[2024, 2025].map((p) => r(p, { measure: "murder", unit: "victims" }))];
    assert.equal(seriesTitle(mixed, ["carjacking", "murder"], "year", FB), "Memphis, TN Carjackings and Murder Victims Per Year, 2024 to 2025", "the second measure is not named from the first measure's unit");
  });
  await check("pooled totals read 'YYYY to YYYY' with no Per; compiler partial-year notes add their coverage", () => {
    assert.equal(seriesTitle([r("2018-2025")], ["carjacking"], "total", FB), "Memphis, TN Carjackings, 2018 to 2025");
    assert.equal(seriesTitle([r("2018-2026", { note: "partial year 2026 (January-June)" })], ["carjacking"], "total", FB), "Memphis, TN Carjackings, 2018 to 2026 (2026 Through June)");
    assert.equal(seriesTitle([r(2025), r(2026, { note: "partial year (January-June)" })], ["carjacking"], "year", FB), "Memphis, TN Carjackings Per Year, 2025 to 2026 (2026 Through June)");
    assert.equal(seriesTitle([r(2026, { note: "partial year (January-September)" })], ["carjacking"], "total", FB), "Memphis, TN Carjackings, 2026 (2026 Through September)");
  });
  await check("anything uncertain keeps the previous title: clearance, rolling, dollars, filters, unreadable partial notes, odd pooled spans, mixed statistics, grain mismatch", () => {
    const cases: [string, Record<string, unknown>[], string[], string][] = [
      ["clearance percentage", [2024, 2025].map((p) => r(p, { unit: "offenses", statistic: "clearance_rate" })), ["carjacking"], "year"],
      ["rolling grain", ["2025-01", "2025-02"].map((p) => r(p)), ["carjacking"], "rolling"],
      ["rolling statistic", ["2025-01", "2025-02"].map((p) => r(p, { statistic: "rolling_12_month_count" })), ["carjacking"], "month"],
      ["rolling rate", ["2025-01", "2025-02"].map((p) => r(p, { statistic: "rolling_12_month_rate_per_100k" })), ["carjacking"], "month"],
      ["total property value", [r(2025, { measure: "theft", unit: "dollars", statistic: "total" })], ["theft"], "total"],
      ["average property value", [r(2025, { measure: "theft", unit: "dollars", statistic: "average" })], ["theft"], "total"],
      ["dollars as a count", [r(2025, { measure: "theft", unit: "dollars" })], ["theft"], "total"],
      ["a filtered series (female victims)", [2024, 2025].map((p) => r(p, { measure: "murder", unit: "victims", filter: "victim sex: female" })), ["murder"], "year"],
      ["an unreadable partial note", [r(2025), r(2026, { note: "partial year: January-June" })], ["carjacking"], "year"],
      ["a backward pooled span", [r("2025-2018")], ["carjacking"], "total"],
      ["a pooled span under a year grain", [r("2018-2025")], ["carjacking"], "year"],
      ["mixed statistics", [r(2025), r(2025, { measure: "robbery", statistic: "rate_per_100k" })], ["carjacking", "robbery"], "year"],
      ["a total over several periods", [r(2024), r(2025)], ["carjacking"], "total"],
      ["month grain over years", [r(2024), r(2025)], ["carjacking"], "month"],
      ["a measure with no rows", [r(2025)], ["carjacking", "murder"], "year"],
    ];
    for (const [name, rows, measures, grain] of cases) assert.equal(seriesTitle(rows, measures, grain, FB), FB, name);
  });
  await check("H2 rendered: a one-row answer with no displayed title shows 'Place: Memphis, TN' above 'Year | Carjackings'", () => {
    const one = [{ period: 2025, place: "Memphis, TN", measure: "carjacking", unit: "offenses", filter: null, statistic: "count", value: 318, note: null }];
    const out = renderToStaticMarkup(React.createElement(DataTable, { columns: SERIES, rows: one }));
    assert.match(out, /Place: Memphis, TN/, out.slice(0, 400));
    assert.deepEqual([...out.matchAll(/<th[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) => m[1]), ["Year", "Carjackings"]);
    assert.ok(out.indexOf("Place: Memphis, TN") < out.indexOf("<th"), "the place line is above the table");
  });
  await check("no model call was made", () => assert.equal(modelCalls, 0));
  await check("offline: no network call of any kind, model included", () => assert.deepEqual(network, []));
  console.log(`\nnibrs typed chart: ${passed} passed, ${failed} failed (model calls ${modelCalls})`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
