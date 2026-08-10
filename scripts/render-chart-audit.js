#!/usr/bin/env node
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [dbArgument, requestId, baseUrl = "http://127.0.0.1:3000"] = process.argv.slice(2);
  if (!dbArgument || !requestId) throw new Error("Usage: node scripts/render-chart-audit.js <query_log.db> <request-id> [base-url]");
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch { throw new Error("Playwright is required for offline chart rendering. Install it in the audit environment before running this command."); }
  const db = new Database(path.resolve(dbArgument), { readonly: true });
  const row = db.prepare("SELECT * FROM chart_audit_artifacts WHERE request_id = ?").get(requestId);
  db.close();
  if (!row) throw new Error(`No chart artifact found for request ${requestId}`);
  const artifact = {
    requestId: row.request_id, source: row.source, createdAt: row.created_at,
    chartConfig: JSON.parse(row.chart_config), columns: JSON.parse(row.columns_json), rows: JSON.parse(row.data_json),
    rowCount: row.row_count, columnCount: row.column_count, capturedRowCount: row.captured_row_count,
    capturedColumnCount: row.captured_column_count, dataHash: row.data_hash,
    truncated: Boolean(row.truncated), truncationReason: row.truncation_reason,
  };
  if (artifact.truncated) throw new Error("Offline exact rendering is unavailable because the saved artifact is truncated.");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
  await page.addInitScript((value) => sessionStorage.setItem("chart-audit-artifact", JSON.stringify(value)), artifact);
  await page.goto(`${baseUrl.replace(/\/$/, "")}/chart-audit-preview`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-chart-audit-ready='true'] svg", { timeout: 30000 });
  const structure = await page.locator("[data-chart-audit-ready='true']").evaluate((root) => {
    const svgText = [...root.querySelectorAll("svg text")].map((node) => node.textContent).filter(Boolean);
    const selectedX = [...root.querySelectorAll(".recharts-xAxis text, .xAxis text")].map((node) => node.textContent).filter(Boolean);
    const selectedY = [...root.querySelectorAll(".recharts-yAxis text, .yAxis text")].map((node) => node.textContent).filter(Boolean);
    return ({
    lines: root.querySelectorAll(".recharts-line-curve").length,
    bars: root.querySelectorAll(".recharts-bar-rectangle path, path.recharts-rectangle").length,
    points: root.querySelectorAll(".recharts-scatter-symbol, .recharts-line-dot").length,
    sectors: root.querySelectorAll(".recharts-pie-sector").length,
    xTicks: selectedX.length ? selectedX : svgText,
    yTicks: selectedY.length ? selectedY : svgText,
    text: root.textContent || "",
    width: root.querySelector("svg")?.getBoundingClientRect().width || 0,
    height: root.querySelector("svg")?.getBoundingClientRect().height || 0,
    });
  });
  const issues = [];
  if (!structure.width || !structure.height) issues.push("zero-size SVG");
  if (/(?:NaN|undefined)/i.test(structure.text)) issues.push("invalid rendered text");
  if (artifact.chartConfig.type !== "pie" && (!structure.xTicks.length || !structure.yTicks.length)) issues.push("missing axis tick labels");
  const markSelector = ".recharts-bar-rectangle path, path.recharts-rectangle, .recharts-scatter-symbol, .recharts-pie-sector, .recharts-line-curve";
  const firstMark = page.locator(markSelector).first();
  let tooltip = "";
  if (await firstMark.count()) {
    await firstMark.hover({ force: true });
    tooltip = (await page.locator(".recharts-tooltip-wrapper").textContent().catch(() => "")) || "";
  } else issues.push("no visible chart marks");
  const numericValues = artifact.rows.flatMap((item) => artifact.chartConfig.yAxis.map((key) => item[key])).filter((value) => typeof value === "number");
  if (numericValues.length && tooltip && !numericValues.some((value) => tooltip.replace(/,/g, "").includes(String(value)))) issues.push("tooltip value does not match saved chart data");

  let screenshot = null;
  if (issues.length) {
    const directory = path.resolve(process.env.CHART_AUDIT_SCREENSHOT_DIR || path.join(process.cwd(), "audit", "chart-findings"));
    fs.mkdirSync(directory, { recursive: true });
    screenshot = path.join(directory, `${requestId}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });
  }
  await browser.close();
  console.log(JSON.stringify({ requestId, issues, tooltipChecked: Boolean(tooltip), screenshot, structure }, null, 2));
  if (issues.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
