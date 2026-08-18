/**
 * Where the authoritative label is applied, not just that it exists.
 *
 * The first version of this correction called `enforceAuthoritativeAgencyLabel` in exactly one
 * place: inside `if (!claude.sql)`. The Baltimore regression is a *successful* SQL answer, so it
 * never went near that branch — the fix could not fix the bug it was written for, and the helper
 * tests passed anyway because they exercised the helper rather than the route.
 *
 * So this reads the route itself and asserts placement. It is a structural test, and structural
 * tests are blunt; it exists because a unit test of a pure function cannot see the one property
 * that failed, which is *reachability from the answering path*.
 */
import fs from "node:fs";
import path from "node:path";

const ROUTE = path.join(process.cwd(), "app", "api", "query", "route.ts");
const source = fs.readFileSync(ROUTE, "utf8");
const lines = source.split(/\r?\n/);

let failures = 0;
let checks = 0;

function assert(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${message}`);
  }
}

function lineOf(needle: string, from = 0): number {
  for (let i = from; i < lines.length; i += 1) if (lines[i].includes(needle)) return i;
  return -1;
}

function allLinesOf(needle: string): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => { if (line.includes(needle)) out.push(i); });
  return out;
}

console.log("the correction is a single shared helper");
const helperDef = lineOf("const authoritativeNarrative =");
assert(helperDef !== -1, "a request-scoped authoritativeNarrative helper exists");
// The raw function should be reached through the helper, not copied into branches.
const rawCalls = allLinesOf("enforceAuthoritativeAgencyLabel(").filter((i) => !lines[i].includes("import"));
assert(rawCalls.length === 1,
  `the raw enforcement is called once, inside the helper (found ${rawCalls.length})`);
assert(rawCalls.length === 1 && rawCalls[0] > helperDef && rawCalls[0] < helperDef + 12,
  "that one call is inside the helper");

console.log("\nit is applied on the answering path, not only where no SQL was produced");
const applications = allLinesOf("authoritativeNarrative(").filter((i) => i !== helperDef);
assert(applications.length >= 5,
  `the helper is applied at several boundaries (found ${applications.length})`);

// The no-SQL branch. Everything at or before it would have satisfied the old, broken placement.
const noSqlBranch = lineOf("if (!claude.sql) {");
assert(noSqlBranch !== -1, "the no-SQL branch is present to compare against");
const afterNoSql = applications.filter((i) => i > noSqlBranch + 40);
assert(afterNoSql.length >= 3,
  `the helper is applied well beyond the no-SQL branch (found ${afterNoSql.length} such sites)`);

console.log("\nevery model-authored narrative is corrected before its finalization");
// The answering path: corrected before the empty-result, all-null and initial-result emissions.
const totalMs = lineOf("const totalMs = Date.now() - totalStart;");
const firstFactualEmit = lineOf("emitFactualPayload(emptyProof", totalMs);
assert(totalMs !== -1 && firstFactualEmit !== -1, "the answering path landmarks are present");
assert(applications.some((i) => i > totalMs && i < firstFactualEmit),
  "claude's narrative is corrected after execution and before the first factual emission");

for (const [label, variable, finalization] of [
  ["the refined explanation", "postExplanation = authoritativeNarrative(postExplanation);", "const postFinalization = finalizeExit("],
  ["the retry explanation", "retryExplanation = authoritativeNarrative(retryExplanation);", "const retryFinalization = finalizeExit("],
] as const) {
  const corrected = lineOf(variable);
  const sealed = lineOf(finalization);
  assert(corrected !== -1, `${label} is corrected`);
  assert(corrected !== -1 && sealed !== -1 && corrected < sealed,
    `${label} is corrected before it is finalized (correct=${corrected + 1}, finalize=${sealed + 1})`);
}

// The title travels with every one of those payloads.
assert(applications.some((i) => lines[i].includes("claude.title = authoritativeNarrative(claude.title)")),
  "the title is corrected too, not only the explanation");

console.log(`\n${checks - failures}/${checks} route placement checks passed`);
if (failures > 0) {
  console.error(`${failures} route placement check(s) failed`);
  process.exit(1);
}
console.log("authoritative label route placement tests passed");
