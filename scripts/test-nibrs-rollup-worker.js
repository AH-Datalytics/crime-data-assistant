const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-rollup-worker-"));
const mainPath = path.join(dir, "nibrs.db");
const rollupPath = path.join(dir, "rollups.db");
try {
  const main = new Database(mainPath);
  main.pragma("journal_mode = WAL");
  main.exec("CREATE TABLE summary_arrestee_demographics (arrestee_count INTEGER)");
  main.close();
  const rollup = new Database(rollupPath);
  rollup.exec("CREATE TABLE national_summary_arrestee_demographics (arrestee_count INTEGER); INSERT INTO national_summary_arrestee_demographics VALUES (38)");
  rollup.close();

  const output = execFileSync(process.execPath, [
    path.join(__dirname, "..", "lib", "nibrs-query-worker.js"),
    mainPath, rollupPath,
    "SELECT SUM(arrestee_count) AS arrests FROM rollup.national_summary_arrestee_demographics",
  ], { encoding: "utf8" });
  const payload = JSON.parse(output);
  assert.deepEqual(payload.rows, [{ arrests: 38 }], JSON.stringify(payload));
  console.log("nibrs rollup worker tests passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
