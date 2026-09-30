/*
 * P4.1 final-statement binding for the NIBRS model initial and retry paths.
 *
 * Held here:
 *   1. the final checks run on the statement that will execute, and a check that rewrites it (the
 *      sanitizer's LIMIT, a schema correction, a contract rewrite) makes the rewritten form pass
 *      unchanged in a second round -- never a loop;
 *   2. only a passing final check issues an execution authority; a refusal issues none;
 *   3. only an ISSUED, unaltered authority is accepted: a copy, a caller-made object with the right
 *      hash, or an in-place change is refused, and executeBoundNibrsStatement rejects it before any
 *      database is touched;
 *   4. the real worker verifies the statement identity before prepare (run directly, windowless, on a
 *      disposable database): the right identity runs, a wrong one is refused, no identity is the legacy
 *      mode;
 *   5. placement: the two covered model callers use the bound executor, and the excluded callers
 *      (owned/deterministic builders, the application fallback) are named and keep the legacy one.
 * Delivered answers through the real route and worker: audit/p4-final-statement-binding-2026-09-28/binding-witness.cjs.
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { finalizeNibrsStatement, nibrsExecutionAuthorityIssue, nibrsSqlSha256, type NibrsExecutionAuthority } from "../lib/nibrs-execution-binding";
import { executeBoundNibrsStatement } from "../lib/nibrs-db";
import type { QueryContractSqlValidation } from "../lib/query-contract-validator";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const contractOf = (sql: string, extra: Partial<QueryContractSqlValidation> = {}): QueryContractSqlValidation =>
  ({ sql, fired: [], warnings: [], capabilityFindings: [], retryIssues: [], blockReasons: [], enforced: [], ...extra });
const passContract = (sql: string) => contractOf(sql);
const passSchema = (sql: string) => ({ ok: true, sql, corrected: false });
const SQL = "SELECT SUM(victim_count) AS v FROM summary_victim_city_monthly WHERE ori = 'X' LIMIT 1000";

console.log("\n1 - the final checks run on the statement that will execute");
{
  const r = finalizeNibrsStatement({ sql: SQL, path: "model-initial", schema: passSchema, contract: passContract });
  check(r.ok && r.authority.sql === SQL && r.authority.rounds === 1 && r.authority.sha256 === nibrsSqlSha256(SQL), "an unchanged passing statement is issued in one round, with its identity");
  const noLimit = SQL.replace(" LIMIT 1000", "");
  const s = finalizeNibrsStatement({ sql: noLimit, path: "model-initial", schema: passSchema, contract: passContract });
  check(s.ok && s.authority.sql === SQL && s.authority.rounds === 2, "the sanitizer's LIMIT is a rewrite: the rewritten form passes unchanged in a second round");
  const seen: string[] = [];
  const corrected = finalizeNibrsStatement({
    sql: "SELECT SUM(arrest_count) FROM t LIMIT 1000", path: "model-retry",
    schema: (x) => (/arrest_count/.test(x) ? { ok: true, sql: x.replace("arrest_count", "arrestee_count"), corrected: true } : { ok: true, sql: x, corrected: false }),
    contract: (x) => { seen.push(x); return passContract(x); },
  });
  check(corrected.ok && corrected.authority.sql === "SELECT SUM(arrestee_count) FROM t LIMIT 1000" && seen.every((x) => /arrestee_count/.test(x)),
    "a schema correction: the CORRECTED statement is what the contract checks and what is issued");
  const rewrite = finalizeNibrsStatement({ sql: SQL, path: "model-initial", schema: passSchema,
    contract: (x) => passContract(x.replace("ori = 'X'", "ori = 'Y'")) });
  check(rewrite.ok && /ori = 'Y'/.test(rewrite.authority.sql) && rewrite.authority.rounds === 2, "a contract rewrite is re-checked once and issued only when it settles");
  let n = 0;
  const churn = finalizeNibrsStatement({ sql: SQL, path: "model-initial", schema: passSchema, contract: (x) => passContract(`${x} /*${++n}*/`) });
  check(!churn.ok && churn.stage === "unsettled", "a statement the checks keep rewriting is refused (two rounds, no loop)");
}

console.log("\n2 - only a passing final check issues authority");
{
  const blocked = finalizeNibrsStatement({ sql: SQL, path: "model-initial", schema: passSchema, contract: (x) => contractOf(x, { blockReasons: ["blocked"] }) });
  check(!blocked.ok && blocked.stage === "contract", "a contract failure issues no authority");
  const retryIssue = finalizeNibrsStatement({ sql: SQL, path: "model-initial", schema: passSchema, contract: (x) => contractOf(x, { retryIssues: ["[SYSTEM: Query contract violation (x).]"] }) });
  check(!retryIssue.ok && retryIssue.stage === "contract", "a contract retry issue is a failure too: no authority");
  const unsafe = finalizeNibrsStatement({ sql: "DELETE FROM t", path: "model-initial", schema: passSchema, contract: passContract });
  check(!unsafe.ok && unsafe.stage === "safety", "an unsafe statement issues no authority");
  const badSchema = finalizeNibrsStatement({ sql: SQL, path: "model-initial", schema: () => ({ ok: false, error: "no such column" }), contract: passContract });
  check(!badSchema.ok && badSchema.stage === "schema", "a schema failure issues no authority");
}

console.log("\n3 - only an issued, unaltered authority is accepted");
const issued = finalizeNibrsStatement({ sql: SQL, path: "model-initial", schema: passSchema, contract: passContract });
if (!issued.ok) throw new Error("fixture authority not issued");
{
  const a = issued.authority;
  check(nibrsExecutionAuthorityIssue(a) === null, "the issued authority is accepted");
  const copy = { ...a, sql: a.sql.replace("'X'", "'Z'") } as NibrsExecutionAuthority;
  check(/not issued/.test(nibrsExecutionAuthorityIssue(copy) ?? ""), "an altered copy is not authority");
  const forged = Object.freeze({ sql: a.sql, sha256: a.sha256, path: a.path, rounds: 1 }) as NibrsExecutionAuthority;
  check(/not issued/.test(nibrsExecutionAuthorityIssue(forged) ?? ""), "a caller-made, frozen object with the correct hash is not authority");
  let changed = false;
  try { (a as { sql: string }).sql = "SELECT 1"; changed = a.sql === "SELECT 1"; } catch { changed = false; }
  check(!changed && nibrsExecutionAuthorityIssue(a) === null, "the authority cannot be changed in place");
}

async function rejects(p: Promise<unknown>): Promise<string | null> { try { await p; return null; } catch (e) { return (e as Error).message; } }

async function main() {
  const forged = Object.freeze({ ...issued.ok ? issued.authority : ({} as NibrsExecutionAuthority) }) as NibrsExecutionAuthority;
  const before = deniedDatabaseOpens().length;
  const msg = await rejects(executeBoundNibrsStatement(forged));
  check(/NIBRS execution refused: the statement was not issued/.test(msg ?? "") && deniedDatabaseOpens().length === before,
    "executeBoundNibrsStatement refuses an unissued authority before touching any database");

  console.log("\n4 - the real worker verifies the statement identity before prepare");
  const dir = mkdtempSync(join(tmpdir(), "nibrs-binding-"));
  try {
    const dbPath = join(dir, "w.db");
    const Database = require("better-sqlite3");
    // A disposable database written by a child process, so no in-process database is opened here.
    const make = spawnSync(process.execPath, ["-e",
      `const D=require(${JSON.stringify(require.resolve("better-sqlite3"))});const d=new D(${JSON.stringify(dbPath)});d.pragma("journal_mode = WAL");d.exec("CREATE TABLE t(v INTEGER); INSERT INTO t VALUES (2),(3);");d.close();`],
      { encoding: "utf8", windowsHide: true });
    void Database;
    check(make.status === 0, "a disposable worker database is built (in a child process)");
    const worker = join(process.cwd(), "lib", "nibrs-query-worker.js");
    const run = (sql: string, sha?: string) => {
      const r = spawnSync(process.execPath, [worker, dbPath, "", sql, ...(sha ? [sha] : [])], { encoding: "utf8", windowsHide: true });
      return JSON.parse(r.stdout || "{}");
    };
    const stmt = "SELECT SUM(v) AS total FROM t";
    const sha = createHash("sha256").update(stmt, "utf8").digest("hex");
    const ok = run(stmt, sha);
    check(ok.rows && ok.rows[0].total === 5, "the right identity: the worker prepares and runs it (5)");
    const altered = run("SELECT SUM(v) * 2 AS total FROM t", sha);
    check(/NIBRS execution refused/.test(altered.error ?? "") && !altered.rows, "an altered statement with the original identity is refused before prepare");
    const legacy = run(stmt);
    check(legacy.rows && legacy.rows[0].total === 5, "no identity: the legacy mode still runs (excluded callers)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("\n5 - placement: covered callers are bound, excluded callers are named");
  const route = readFileSync("app/api/nibrs-query/route.ts", "utf8");
  check((route.match(/executeBoundNibrsStatement\(/g) ?? []).length === 2
    && route.includes("await executeBoundNibrsStatement(finalCheck.authority)") && route.includes("await executeBoundNibrsStatement(retryFinalCheck.authority)"),
    "the model initial and retry paths execute through the bound executor, from their final checks");
  const legacyCalls = [...route.matchAll(/await executeWithTimeout\(([^)]*)\)/g)].map((m) => m[1]);
  // The owned-statement executor (GC-065's comparison, the NIBRS city ranking's S1 candidates read) is
  // application-built like the owned and deterministic plans, and re-proves each statement immediately
  // before this executor runs it.
  check(JSON.stringify(legacyCalls) === JSON.stringify(["ownedStatement.sql", "ownedQuery.sql", "deterministicQuery.sql", "fallbackSql"]),
    `the excluded callers keep the legacy executor: owned statements, owned, deterministic and the application fallback (${legacyCalls.join(", ")})`);
  const initialFinal = route.indexOf('path: "model-initial"');
  check(initialFinal > route.indexOf("const schemaCheck = validateSqlSchema(validationDb, sql);") && initialFinal < route.indexOf("await executeBoundNibrsStatement(finalCheck.authority)"),
    "on the initial path the final check follows planning and schema correction, and precedes execution");
  const retryFinal = route.indexOf('path: "model-retry"');
  check(retryFinal > route.indexOf("const retrySchemaCheck = validateSqlSchema(retryValidationDb, retrySql);") && retryFinal < route.indexOf("await executeBoundNibrsStatement(retryFinalCheck.authority)"),
    "on the retry path the final check follows planning and schema correction, and precedes execution");

  console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
  if (failures > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
