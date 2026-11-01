/**
 * The shadow's DuckDB executor (lib/nibrs-shadow/duckdb.ts): one persistent Python process answering synchronously,
 * with results cached by SQL text, against the reference path (one process per query). Needs a Python with duckdb
 * (NIBRS_SHADOW_PYTHON, else "python"); skipped when there is none.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";

const python = process.env.NIBRS_SHADOW_PYTHON ?? "python";
if (spawnSync(python, ["-I", "-c", "import duckdb"]).status !== 0) {
  console.log("nibrs duckdb executor: skipped (no Python with duckdb)");
  process.exit(0);
}
const run = duckdbExecutor(python);
const ref = duckdbExecutor(python, { persistent: false });

// Rows as DuckDB gives them, the same on both paths.
const q = "SELECT 1 AS a, 'x' AS b, NULL::DOUBLE AS c UNION ALL SELECT 2, 'y', 3.5::DOUBLE ORDER BY a";
assert.deepEqual(run(q), [[1, "x", null], [2, "y", 3.5]]);
assert.deepEqual(run(q), ref(q));
// A large result arrives whole (many stdout chunks joined once its line ends).
const big = run("SELECT i, i * 2 FROM range(200000) t(i) ORDER BY i");
assert.equal(big.length, 200000);
assert.deepEqual(big[199999], [199999, 399998]);
// The same SQL is answered from the cache (the build is pinned and read-only): the same rows, not run again.
assert.equal(run(q), run(q));
// An error is thrown with DuckDB's message, and the process keeps answering afterwards.
assert.throws(() => run("SELECT * FROM no_such_table"), /duckdb failed: .*no_such_table/);
assert.deepEqual(run("SELECT 42"), [[42]]);
// Calls are answered in order, each with its own result.
for (let i = 0; i < 50; i++) assert.deepEqual(run(`SELECT ${i}`), [[i]]);

console.log("nibrs duckdb executor: one persistent process, synchronous answers, cached by SQL, same rows as the reference");
