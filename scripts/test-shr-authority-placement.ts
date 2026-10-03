/**
 * Where each SHR authority is applied, proved by reading the route source.
 *
 * A validator that exists but is not reached is decoration. These checks read
 * `app/api/shr-query/route.ts` and assert the wiring, so a future edit that routes model-authored
 * SQL to the deterministic path -- or adds a new execution helper that inherits neither authority --
 * fails here rather than in production.
 *
 * The distinction is deliberately carried by two functions returning two unassignable types. A
 * boolean would read identically at every call site and could be passed wrongly by any caller;
 * these checks would not be able to tell the difference.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${(error as Error).message}`); }
}

const ROUTE = path.join(__dirname, "..", "app", "api", "shr-query", "route.ts");
const source = readFileSync(ROUTE, "utf8");
const AUTHORITY = readFileSync(path.join(__dirname, "..", "lib", "shr-authority.ts"), "utf8");
const LICENCE = readFileSync(path.join(__dirname, "..", "lib", "shr-murder-licence.ts"), "utf8");

/** Every `X.prepare(<arg>)` in the route, with its position -- each is SQL reaching the database. */
function executionArguments(text: string): { arg: string; at: number }[] {
  const out: { arg: string; at: number }[] = [];
  for (const m of text.matchAll(/\b\w+\s*\.\s*prepare\s*\(([^)]*)\)/g)) {
    out.push({ arg: m[1].trim(), at: m.index ?? 0 });
  }
  return out;
}

/**
 * Does this execution run validated SQL?
 *
 * Provenance and ORDER, not spelling. `contract.sql` is obvious; a variable is acceptable only when
 * the assignment that most recently precedes the execution comes from a validation result. Matching
 * the name would let `const sql = rawModelSql` pass for being called `sql`, and requiring *every*
 * assignment to be validated would be wrong in the other direction -- this route legitimately
 * reassigns `sql` from a guardrail rewrite and then re-validates it before use.
 */
function carriesValidatedSql(arg: string, at: number, text: string): boolean {
  if (/\bcontract\b/i.test(arg)) return true;
  if (/^["'`]/.test(arg)) return true;                 // a literal statement is not model output
  const identifier = /^[A-Za-z_]\w*$/.exec(arg);
  if (!identifier) return false;
  const name = identifier[0];
  let last: string | null = null;
  for (const m of text.matchAll(new RegExp(`\\b(?:const|let|var)?\\s*${name}\\s*=\\s*([^;\\n]+)`, "g"))) {
    if ((m.index ?? 0) >= at) break;
    last = m[1].trim();
  }
  if (last === null) return false;
  return /Contract\b|\bcontract\./i.test(last);
}

check("every SQL execution in the route runs validated SQL, not raw model output", () => {
  const args = executionArguments(source);
  assert.ok(args.length > 0, "found no executions -- the reader is broken, not the route");
  const unvalidated = args.filter((e) => !carriesValidatedSql(e.arg, e.at, source)).map((e) => e.arg);
  assert.deepStrictEqual(unvalidated, [],
    `these executions do not run a validated statement: ${unvalidated.join(" | ")}`);
});

check("a statement rewritten after validation is re-proved before it runs", () => {
  // The schema check can rewrite the SQL. A licence proved about the pre-correction text says
  // nothing about the text that executes.
  const corrected = source.indexOf("schemaCheck.corrected");
  assert.ok(corrected >= 0, "the schema-correction branch has gone; this check is stale");
  const execution = source.indexOf(".prepare(sql)", corrected);
  const reprove = source.indexOf("runModelAuthoredValidation(sql)", corrected);
  assert.ok(reprove >= 0 && reprove < execution,
    "a schema-corrected statement executes without being re-proved");
});

check("model-authored SQL reaches the fact-based authority", () => {
  assert.match(source, /validateModelAuthoredShrSql/, "the route never calls the model-authored validator");
  assert.match(source, /const runModelAuthoredValidation\s*=/, "no model-authored wrapper");
  // The model-authored wrapper must be what the model path actually uses.
  const uses = [...source.matchAll(/runModelAuthoredValidation\(/g)].length;
  assert.ok(uses >= 6, `model-authored validation is invoked only ${uses} times; the model path has more sites`);
});

check("City/County membership in the route comes only from the agency/year classification (Codex combined ruling, 2026-10-02)", () => {
  // The name-match fallback used to add "(i.agency_type = 'City' OR i.agency_type IS NULL OR i.agency_type = '')":
  // blank meant City. No route statement may read a legacy type; the fallback joins the classification on all
  // three keys and filters its type, and every validator call carries the classification's availability.
  assert.doesNotMatch(source, /agency_type\s+IS\s+NULL|i\.agency_type\s*=/, "a legacy blank-as-City or incidents.agency_type filter is back in the route");
  assert.match(source, /JOIN \$\{SHR_YEAR_CLASS_TABLE\} cls ON cls\.ori = i\.ori AND cls\.state = i\.state AND cls\.year = i\.year/,
    "the fallback no longer joins the classification on ori, state and year");
  assert.match(source, /const CITY_CLASS_FILTER = "cls\.agency_type = 'City'";/, "the fallback's City filter is not the classification's type");
  assert.strictEqual([...source.matchAll(/yearClass: yearClassFor\(inputSql\)/g)].length, 2,
    "both the model-authored and the deterministic validation must receive the classification's availability");
});

check("the deterministic plans stay on their own bounded path", () => {
  assert.match(source, /const contract = runDeterministicPlanValidation\(murderPlan\.sql\)/,
    "the deterministic murder plan no longer uses the deterministic validator");
  // GC-064 adds the application-built city ranking: its victim join and any murder filter are literal
  // in the builder's template, which is what this path is for (lib/shr-authority.ts). Named, so an
  // unnamed extra caller still fails the count. It passes the ranking's assembled validation contract
  // (a stated nationwide scope; lib/city-ranking.ts rankingValidationContract), still on this validator.
  assert.match(source, /const validateRankingStatement = \(statement: string\): ValidatedStatement \| null => \{\s*const contract = runDeterministicPlanValidation\(statement, rankingContract\)/,
    "the SHR city ranking no longer uses the deterministic validator");
  const deterministic = [...source.matchAll(/runDeterministicPlanValidation\(/g)].length;
  assert.strictEqual(deterministic, 3,
    `expected exactly the murder, shooting and city-ranking plans on the legacy path, found ${deterministic}`);
});

check("the two authorities cannot be interchanged by accident", () => {
  // Separate branded types, not a boolean or a caller-supplied string.
  assert.match(AUTHORITY, /ModelAuthoredShrValidation/, "no model-authored result type");
  assert.match(AUTHORITY, /DeterministicShrPlanValidation/, "no deterministic result type");
  assert.match(AUTHORITY, /Symbol\(/, "the result types are not branded, so they are assignable");
  assert.doesNotMatch(AUTHORITY, /isDeterministic\s*[:?]\s*boolean/, "authority expressed as a boolean");
  assert.doesNotMatch(AUTHORITY, /planFamily\s*[:?]\s*string/, "authority expressed as a plan-family string");
});

check("an unproved fact verdict cannot fall through to the legacy prover", () => {
  // The model-authored path strips the legacy licence BEFORE applying the fact verdict, so a
  // legacy pass can never stand in for a fact proof.
  // Assert the CALL, not the declaration: a helper that exists but is never invoked strips nothing.
  assert.match(AUTHORITY, /const base = withoutLegacyLicence\(raw\);/,
    "the legacy licence verdict is not actually stripped before the fact verdict");
  assert.match(AUTHORITY, /LEGACY_LICENCE_RULES/, "the legacy licence rules are not named");
  assert.match(AUTHORITY, /blockReasons:\s*\[\.\.\.base\.blockReasons,\s*LICENCE_MESSAGE\]/,
    "an unproved licence does not block");
  // A refusal must be a block, not a retry: retrying an unproved count risks answering with it.
  assert.doesNotMatch(AUTHORITY, /retryIssues:\s*\[\.\.\.base\.retryIssues,\s*LICENCE_MESSAGE\]/,
    "an unproved licence is only a retry");
});

check("a parse failure is a refusal, never an exception or a silent pass", () => {
  assert.match(LICENCE, /if \(!facts\.parsed\) return \{ proved: false/,
    "unparseable SQL does not refuse");
  assert.doesNotMatch(LICENCE, /catch\s*\([^)]*\)\s*\{\s*return \{ proved: true/,
    "an error path proves the licence");
});

check("a new unclassified execution helper fails this test rather than inheriting authority", () => {
  // Guard the guard: if someone adds `db.prepare(rawSql)` the first check must catch it. Prove the
  // reader would see it, so a passing suite is not just a reader that matches nothing.
  const injected = source + "\n const rawModelSql = completion.text;\n const rows = someDb.prepare(rawModelSql).all();";
  const args = executionArguments(injected);
  assert.ok(args.some((e) => e.arg === "rawModelSql"), "the source reader would not see a new helper");
  const unvalidated = args.filter((e) => !carriesValidatedSql(e.arg, e.at, injected)).map((e) => e.arg);
  assert.deepStrictEqual(unvalidated, ["rawModelSql"],
    "an unvalidated execution would not be reported by the check above");
});

console.log(`\nSHR authority placement: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
