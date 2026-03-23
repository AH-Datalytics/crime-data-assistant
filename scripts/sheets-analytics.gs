/**
 * Google Apps Script — Query Log Analytics
 *
 * Add this to your existing "Crime Data Assistant Log" Google Sheet.
 * Go to Extensions → Apps Script → paste this → Save.
 * Then run createAnalyticsDashboard() once, or set up a daily trigger.
 *
 * Creates/updates a "Summary" sheet with:
 *   - Total queries, error rate, avg response time
 *   - Queries per day (last 30 days)
 *   - Top 20 questions asked
 *   - Error breakdown
 *   - Queries per hour of day
 */

function createAnalyticsDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName("Sheet1") || ss.getSheets()[0];

  // Get or create Summary sheet
  let summary = ss.getSheetByName("Summary");
  if (summary) {
    summary.clear();
  } else {
    summary = ss.insertSheet("Summary");
  }

  const data = logSheet.getDataRange().getValues();
  if (data.length < 2) {
    summary.getRange("A1").setValue("No data yet");
    return;
  }

  const headers = data[0];
  const tsIdx = headers.indexOf("timestamp");
  const qIdx = headers.indexOf("question");
  const sqlIdx = headers.indexOf("sql");
  const rowsIdx = headers.indexOf("rows");
  const errIdx = headers.indexOf("error");
  const msIdx = headers.indexOf("ms");

  const rows = data.slice(1);
  const now = new Date();

  // --- Overall stats ---
  const totalQueries = rows.length;
  const errors = rows.filter((r) => r[errIdx] && r[errIdx] !== "empty_result");
  const errorRate = ((errors.length / totalQueries) * 100).toFixed(1);
  const avgMs =
    rows.reduce((sum, r) => sum + (Number(r[msIdx]) || 0), 0) / totalQueries;
  const emptyResults = rows.filter((r) => r[errIdx] === "empty_result").length;

  let row = 1;
  summary.getRange(row, 1, 1, 2).setValues([["OVERALL STATS", ""]]);
  summary.getRange(row, 1).setFontWeight("bold").setFontSize(12);
  row++;
  summary.getRange(row, 1, 5, 2).setValues([
    ["Total queries", totalQueries],
    ["Errors", errors.length + " (" + errorRate + "%)"],
    ["Empty results", emptyResults],
    [
      "Avg response time",
      (avgMs / 1000).toFixed(1) + "s (" + Math.round(avgMs) + "ms)",
    ],
    [
      "Date range",
      rows.length > 0
        ? rows[0][tsIdx] + " → " + rows[rows.length - 1][tsIdx]
        : "N/A",
    ],
  ]);
  row += 6;

  // --- Queries per day (last 30 days) ---
  summary.getRange(row, 1).setValue("QUERIES PER DAY (last 30 days)");
  summary.getRange(row, 1).setFontWeight("bold").setFontSize(12);
  row++;
  summary.getRange(row, 1, 1, 2).setValues([["Date", "Count"]]);
  summary.getRange(row, 1, 1, 2).setFontWeight("bold");
  row++;

  const dayCounts = {};
  rows.forEach((r) => {
    const ts = r[tsIdx];
    if (!ts) return;
    // Handle both ISO string and epoch timestamps
    let d;
    if (typeof ts === "number") {
      d = new Date(ts);
    } else {
      d = new Date(ts);
    }
    if (isNaN(d.getTime())) return;
    const key = d.toISOString().slice(0, 10);
    dayCounts[key] = (dayCounts[key] || 0) + 1;
  });

  const dayEntries = Object.entries(dayCounts)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 30);
  if (dayEntries.length > 0) {
    summary.getRange(row, 1, dayEntries.length, 2).setValues(dayEntries);
    row += dayEntries.length + 1;
  }

  // --- Top 20 questions ---
  summary.getRange(row, 1).setValue("TOP 20 QUESTIONS");
  summary.getRange(row, 1).setFontWeight("bold").setFontSize(12);
  row++;
  summary.getRange(row, 1, 1, 2).setValues([["Question", "Count"]]);
  summary.getRange(row, 1, 1, 2).setFontWeight("bold");
  row++;

  const qCounts = {};
  rows.forEach((r) => {
    const q = (r[qIdx] || "").toString().trim().toLowerCase();
    if (!q) return;
    qCounts[q] = (qCounts[q] || 0) + 1;
  });

  const topQs = Object.entries(qCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  if (topQs.length > 0) {
    summary.getRange(row, 1, topQs.length, 2).setValues(topQs);
    row += topQs.length + 1;
  }

  // --- Error breakdown ---
  summary.getRange(row, 1).setValue("ERROR BREAKDOWN");
  summary.getRange(row, 1).setFontWeight("bold").setFontSize(12);
  row++;
  summary.getRange(row, 1, 1, 3).setValues([["Error", "Count", "Example Question"]]);
  summary.getRange(row, 1, 1, 3).setFontWeight("bold");
  row++;

  const errCounts = {};
  const errExamples = {};
  errors.forEach((r) => {
    const e = (r[errIdx] || "").toString().slice(0, 80);
    errCounts[e] = (errCounts[e] || 0) + 1;
    if (!errExamples[e]) errExamples[e] = r[qIdx] || "";
  });

  const topErrs = Object.entries(errCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  if (topErrs.length > 0) {
    const errRows = topErrs.map(([err, count]) => [
      err,
      count,
      errExamples[err] || "",
    ]);
    summary.getRange(row, 1, errRows.length, 3).setValues(errRows);
    row += errRows.length + 1;
  }

  // --- Queries per hour ---
  summary.getRange(row, 1).setValue("QUERIES BY HOUR OF DAY (UTC)");
  summary.getRange(row, 1).setFontWeight("bold").setFontSize(12);
  row++;
  summary.getRange(row, 1, 1, 2).setValues([["Hour", "Count"]]);
  summary.getRange(row, 1, 1, 2).setFontWeight("bold");
  row++;

  const hourCounts = {};
  for (let h = 0; h < 24; h++) hourCounts[h] = 0;
  rows.forEach((r) => {
    const ts = r[tsIdx];
    if (!ts) return;
    let d;
    if (typeof ts === "number") {
      d = new Date(ts);
    } else {
      d = new Date(ts);
    }
    if (isNaN(d.getTime())) return;
    hourCounts[d.getUTCHours()] = (hourCounts[d.getUTCHours()] || 0) + 1;
  });

  const hourRows = Object.entries(hourCounts)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([h, c]) => [h + ":00", c]);
  summary.getRange(row, 1, hourRows.length, 2).setValues(hourRows);

  // Auto-resize columns
  summary.autoResizeColumns(1, 3);

  SpreadsheetApp.getUi().alert(
    "Analytics dashboard updated on the Summary sheet."
  );
}

/**
 * Optional: Set up a daily trigger to auto-refresh the Summary sheet.
 * Run this once manually.
 */
function setupDailyTrigger() {
  // Remove any existing triggers for this function
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach((t) => {
    if (t.getHandlerFunction() === "createAnalyticsDashboard") {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Create new daily trigger at 6 AM UTC
  ScriptApp.newTrigger("createAnalyticsDashboard")
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  SpreadsheetApp.getUi().alert(
    "Daily trigger set up. Summary will refresh at 6 AM UTC."
  );
}
