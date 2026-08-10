import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { auditChartArtifact, buildChartAuditArtifact, persistChartAuditArtifact, persistChartRenderReceipt, type ChartRenderReceipt } from "../lib/chart-audit";

const badRows = [
  { clearance_outcome: "Cleared by Arrest", total_offenses: 82, cleared_by_arrest: 62, death_of_offender: 11, other_exceptional: 0 },
  { clearance_outcome: "Not Cleared", total_offenses: 0, cleared_by_arrest: 0, death_of_offender: 0, other_exceptional: 0 },
];
const bad = buildChartAuditArtifact({
  requestId: "8388-bad",
  source: "nibrs",
  chartConfig: { type: "bar", xAxis: "clearance_outcome", yAxis: ["cleared_by_arrest"], title: "Las Vegas murder clearances, 2025" },
  columns: Object.keys(badRows[0]),
  rows: badRows,
});
const badResult = auditChartArtifact("Show murder clearances by type in Las Vegas in 2025", bad);
assert.equal(badResult.status, "incorrect");
assert.match(badResult.summary, /Not cleared \(9\)/);

const correctedRows = [
  { clearance_outcome: "Cleared by arrest", count: 62 },
  { clearance_outcome: "Death of offender", count: 11 },
  { clearance_outcome: "Not cleared", count: 9 },
];
const corrected = buildChartAuditArtifact({
  requestId: "8388-good",
  source: "nibrs",
  chartConfig: { type: "bar", xAxis: "clearance_outcome", yAxis: ["count"], title: "Las Vegas murder clearances by type, 2025" },
  columns: ["clearance_outcome", "count"],
  rows: correctedRows,
});
assert.equal(auditChartArtifact("Show murder clearances by type in Las Vegas in 2025", corrected).status, "unverified");

const receipt: ChartRenderReceipt = {
  requestId: "8388-good", component: "NibrsChartPanel", chartType: "bar",
  effectiveXKey: "clearance_outcome", effectiveYKeys: ["count"], lineCount: 0,
  barCount: 3, pointCount: 0, areaCount: 0, legendLabels: [],
  xTickLabels: correctedRows.map((row) => row.clearance_outcome), yTickLabels: ["0", "20", "40", "60"],
  svgWidth: 800, svgHeight: 400, overflow: false, zeroSize: false,
  invalidText: false, renderError: false, viewportClass: "desktop", renderedAt: Date.now(),
};
const verified = auditChartArtifact("Show murder clearances by type in Las Vegas in 2025", corrected, receipt);
assert.equal(verified.status, "verified-rendered");
assert.match(verified.summary, /Bar chart rendered/);

const missingBar = auditChartArtifact("Show murder clearances by type in Las Vegas in 2025", corrected, { ...receipt, barCount: 2 });
assert.equal(missingBar.status, "incorrect");
assert.match(missingBar.summary, /fewer visible chart marks/);

const wrongSeries = auditChartArtifact("Show murder clearances by type in Las Vegas in 2025", corrected, { ...receipt, effectiveYKeys: ["total"] });
assert.equal(wrongSeries.status, "incorrect");

const missingAxis = buildChartAuditArtifact({
  source: "current",
  chartConfig: { type: "line", xAxis: "year", yAxis: ["rate"], title: "Trend" },
  columns: ["period", "count"],
  rows: [{ period: 2025, count: 4 }],
});
assert.equal(auditChartArtifact("Show the trend", missingAxis, null).status, "incorrect");

const oversized = buildChartAuditArtifact({
  source: "current",
  chartConfig: { type: "line", xAxis: "year", yAxis: ["count"], title: "Trend" },
  columns: ["year", "count"],
  rows: Array.from({ length: 201 }, (_, i) => ({ year: 1800 + i, count: i })),
});
assert.equal(oversized.truncated, true);
assert.equal(oversized.capturedRowCount, 200);
assert.equal(auditChartArtifact("Show the trend", oversized, receipt).status, "unverified");

const db = new Database(":memory:");
db.exec(`CREATE TABLE chart_audit_artifacts (
  request_id TEXT PRIMARY KEY, query_log_id INTEGER, source TEXT, created_at INTEGER,
  chart_config TEXT, columns_json TEXT, data_json TEXT, row_count INTEGER, column_count INTEGER,
  captured_row_count INTEGER, captured_column_count INTEGER, data_hash TEXT, truncated INTEGER,
  truncation_reason TEXT); CREATE TABLE chart_render_receipts (
  request_id TEXT PRIMARY KEY, received_at INTEGER, receipt_json TEXT)`);
assert.equal(persistChartAuditArtifact(db, corrected, null), true);
assert.equal(persistChartRenderReceipt(db, receipt), true);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chart_render_receipts").get() as { n: number }).n, 1);
db.close();

console.log("chart audit tests passed");
