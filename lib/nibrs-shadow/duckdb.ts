/**
 * Runs the shadow slice's SQL in an in-memory DuckDB through a local Python with duckdb (as scripts/nibrs-compile-gate.ts
 * does). The SQL only reads the canonical parquet files named in it; nothing is written but a temp file. The progress
 * bar is off: on a slow query it would print into the rows read back.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function duckdbExecutor(python: string): (sql: string) => unknown[][] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-shadow-")).replace(/\\/g, "/");
  return (sql: string) => {
    const file = path.join(tmp, "q.sql");
    fs.writeFileSync(file, sql);
    const r = spawnSync(python, ["-I", "-c", `import duckdb, json, sys
con = duckdb.connect()
con.execute("SET temp_directory = ?", [sys.argv[2]])
con.execute("SET enable_progress_bar = false")
print(json.dumps(con.execute(open(sys.argv[1], encoding="utf-8").read()).fetchall(), default=str))`, file, tmp], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`duckdb failed: ${r.stderr.slice(-2000)}`);
    return JSON.parse(r.stdout);
  };
}
