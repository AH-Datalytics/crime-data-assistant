/**
 * P3.1a — the shared typed outcome reaches route finalization.
 *
 * WHAT ROUND 2 ASKED FOR AND WHY. The 225-row BASE grid compares `validateQueryContractSql()`
 * outputs. That is not a route finalization outcome, and the round-1 response wrongly implied it
 * was. This suite closes that gap by following the actual chain end to end:
 *
 *     a question-only capability rule fires
 *       -> classifyCapabilityRule() returns { kind: "block", outcome }        (shared authority)
 *       -> the validator pushes a block reason and carries `capabilityOutcome`
 *       -> queryContractFailureMessage() returns a message, so the route takes its failure branch
 *       -> the route calls finalizeExit({ outcome: OUTCOMES.query_contract_failed, ... })
 *
 * The last hop is the one that cannot be checked by calling a function, because it lives inside a
 * route handler that needs a request, a model and a database. It is checked STRUCTURALLY instead,
 * with the TypeScript compiler API — never a regex over source text, which cannot tell a call from
 * a comment mentioning one, and which was the specific weakness that took seven rounds out of the
 * P2.5 guard.
 *
 * WHAT IT DOES NOT CLAIM. It does not execute a route, and it does not claim production currently
 * decides capability blocks before SQL exists. It claims exactly this: for every question-only
 * block rule, the outcome the shared classifier supplies is the same object every route finalizes
 * a contract failure with.
 *
 * Deterministic. No database, no model, no network, no production.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { validateQueryContractSql, queryContractFailureMessage } from "../lib/query-contract-validator";
import { BLOCK_CAPABILITY_RULES, classifyCapabilityRule } from "../lib/capability-decision";
import { SOURCE_CAPABILITY_RULES } from "../lib/source-capabilities";
import { OUTCOMES, isAdmissiblePair } from "../lib/proof-contract";
import type { QueryContractSource } from "../lib/query-contract";

let pass = 0, fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`); }
}
function checkTrue(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "\n          " + detail : ""}`); }
}

const ROOT = path.join(__dirname, "..");

// ── R1 — the runtime chain, for every question-only block rule ──────────────────────────────
//
// One triggering question per rule. These are NOT frozen-case questions: this suite must not
// consume the case set, and it is registered in the canonical harness where it runs on every change.
//
// The three contract-dependent rules needed phrasings found by probing `buildQueryContract`, not by
// guessing. Worth recording, because it is a production observation rather than a test detail:
// "rate per capita for <group> residents" sets `metric.unsupportedReason =
// demographic_rate_denominator_unavailable` and the block fires, while "rate per 100,000 <group>
// residents" does NOT set it and the block does not fire. That asymmetry is out of scope for
// P3.1a and is reported, not fixed, here.
const TRIGGERS: { ruleId: string; source: QueryContractSource; question: string }[] = [
  { ruleId: "unsupported-sub-city-geography", source: "current",
    question: "How many burglaries happened in the Uptown precinct of Denver, CO last year?" },
  { ruleId: "unsupported-court-policy-topic", source: "current",
    question: "How many people were incarcerated after conviction in Denver, CO last year?" },
  { ruleId: "demographic-rate-unsupported", source: "current",
    question: "What is the robbery rate per capita for white residents of Denver, CO in 2019?" },
  { ruleId: "nibrs-clearance-weapon-unsupported", source: "nibrs",
    question: "What was the clearance rate for aggravated assaults with a firearm in Denver, CO in 2019?" },
  { ruleId: "nibrs-countywide-demographics-unsupported", source: "nibrs",
    question: "Break down victims by race across all of Denver County, CO in 2019." },
  { ruleId: "nibrs-shooting-category-unsupported", source: "nibrs",
    question: "How many shootings occurred in Denver, CO in 2019?" },
  { ruleId: "shr-non-homicide-unsupported", source: "shr",
    question: "How many burglaries were reported in Denver, CO in 2019?" },
  { ruleId: "shr-clearance-unsupported", source: "shr",
    question: "What share of homicides in Denver, CO were solved in 2019?" },
  { ruleId: "shr-demographic-rate-unsupported", source: "shr",
    question: "Show the homicide rate per capita for Hispanic residents of Denver, CO in 2019." },
];

console.log("R1 — the runtime chain from a fired rule to a finalizable failure");
{
  check("R1  a trigger is declared for every question-only block rule",
    TRIGGERS.map((t) => t.ruleId).sort(), [...BLOCK_CAPABILITY_RULES].sort());

  const sql = "SELECT COUNT(*) FROM summary_state_monthly WHERE state='CO'";
  let reached = 0;
  const missed: string[] = [];
  for (const t of TRIGGERS) {
    const r = validateQueryContractSql({ question: t.question, source: t.source, sql });
    const firedThisRule = r.enforced.includes(t.ruleId);
    const finalizable = queryContractFailureMessage(r) !== null;
    const carriesOutcome = r.capabilityOutcome === OUTCOMES.query_contract_failed;
    if (firedThisRule && finalizable && carriesOutcome) reached++;
    else missed.push(`${t.ruleId}: fired=${firedThisRule} finalizable=${finalizable} outcome=${carriesOutcome}`);
  }
  checkTrue("R1b every block rule fires, is finalizable, and carries the shared typed outcome",
    reached === TRIGGERS.length, missed.slice(0, 4).join("\n          "));

  // The outcome the validator carries is the one the classifier supplies - same object, not equal.
  checkTrue("R1c the carried outcome is the classifier's object identity",
    TRIGGERS.every((t) => {
      const c = classifyCapabilityRule(t.ruleId);
      return c.kind === "block" && c.outcome === OUTCOMES.query_contract_failed;
    }));

  // And the pair is admissible for the store the routes log to.
  check("R1d the pair is admissible in query_log",
    isAdmissiblePair("query_log", OUTCOMES.query_contract_failed.action, OUTCOMES.query_contract_failed.reason),
    true);

  // A non-triggering question must NOT produce a capability outcome, or R1b would pass trivially.
  const clean = validateQueryContractSql({
    question: "How many murders were reported in Denver, CO in 2019?", source: "current", sql,
  });
  check("R1e a question that trips no block rule carries no capability outcome",
    clean.capabilityOutcome, null);
}

// ── R2 — the structural hop: what every route actually finalizes with ───────────────────────
console.log("\nR2 — every route finalizes a contract failure with that same outcome");
{
  const routeFiles = fs.readdirSync(path.join(ROOT, "app", "api"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(ROOT, "app", "api", d.name, "route.ts"))
    .filter((p) => fs.existsSync(p));

  checkTrue("R2  route files were found to analyse", routeFiles.length > 0);

  /**
   * Every `finalizeExit({ outcome: <expr>, ... })` in a file, with `<expr>` printed from the AST.
   * Reading the AST rather than the text means a mention inside a comment or a string cannot be
   * mistaken for a call, and a renamed local cannot hide one.
   */
  function finalizeOutcomes(file: string): string[] {
    const src = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "finalizeExit" &&
          node.arguments.length > 0 &&
          ts.isObjectLiteralExpression(node.arguments[0])) {
        for (const prop of node.arguments[0].properties) {
          if (ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "outcome") {
            found.push(prop.initializer.getText(sf).replace(/\s+/g, " "));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  const byFile = new Map<string, string[]>();
  for (const f of routeFiles) {
    const outs = finalizeOutcomes(f);
    if (outs.length) byFile.set(path.relative(ROOT, f).replace(/\\/g, "/"), outs);
  }

  const contractFailureRoutes = [...byFile.entries()]
    .filter(([, outs]) => outs.includes("OUTCOMES.query_contract_failed"))
    .map(([f]) => f).sort();

  check("R2b the routes finalizing a contract failure are the four expected ones",
    contractFailureRoutes,
    ["app/api/hc-query/route.ts", "app/api/nibrs-query/route.ts",
     "app/api/query/route.ts", "app/api/shr-query/route.ts"]);

  // Anti-vacuity: the analyser must actually be finding calls, and finding more than one kind of
  // outcome - otherwise "they all use query_contract_failed" would be true of an empty set.
  const allOutcomes = new Set([...byFile.values()].flat());
  checkTrue("R2c the AST analyser found finalizeExit calls carrying several distinct outcomes",
    allOutcomes.size > 1 && [...byFile.values()].flat().length >= 4,
    `outcomes seen: ${[...allOutcomes].sort().join(", ")}`);

  checkTrue("R2d every contract-failure finalization names the catalog member, never a literal",
    [...byFile.values()].flat()
      .filter((o) => /query_contract_failed/.test(o))
      .every((o) => o === "OUTCOMES.query_contract_failed"),
    [...byFile.values()].flat().filter((o) => /query_contract_failed/.test(o)).join(" | "));
}

// ── R3 — the classification has exactly one author ──────────────────────────────────────────
console.log("\nR3 — one author for the classification");
{
  /** Files in the request path that test block/retry MEMBERSHIP directly. */
  const offenders: string[] = [];
  const scan = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      const rel = path.relative(ROOT, p).replace(/\\/g, "/");
      if (rel === "lib/capability-decision.ts") continue;
      const src = fs.readFileSync(p, "utf8");
      const sf = ts.createSourceFile(p, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        // <BLOCK|RETRY>_CAPABILITY_RULES.has(...) anywhere outside the shared authority
        if (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "has" &&
            ts.isIdentifier(node.expression.expression) &&
            /^(BLOCK|RETRY)_CAPABILITY_RULES$/.test(node.expression.expression.text)) {
          offenders.push(`${rel}: ${node.getText(sf).replace(/\s+/g, " ").slice(0, 60)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  };
  scan(path.join(ROOT, "lib"));
  scan(path.join(ROOT, "app"));

  check("R3  no membership test survives in lib/ or app/ outside the shared authority",
    offenders, []);

  // Anti-vacuity: the same analyser must find the tests that DO exist inside the authority.
  const authority = path.join(ROOT, "lib", "capability-decision.ts");
  const asf = ts.createSourceFile(authority, fs.readFileSync(authority, "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let inAuthority = 0;
  const countVisit = (node: ts.Node) => {
    if (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "has" &&
        ts.isIdentifier(node.expression.expression) &&
        /^(BLOCK|RETRY)_CAPABILITY_RULES$/.test(node.expression.expression.text)) inAuthority++;
    ts.forEachChild(node, countVisit);
  };
  countVisit(asf);
  check("R3b the same analyser finds both membership tests inside the authority", inAuthority, 2);

  check("R3c the nine question-only rules are the block set",
    [...BLOCK_CAPABILITY_RULES].sort(),
    [...new Set(SOURCE_CAPABILITY_RULES
      .filter((r) => !("requiresAnyTables" in r) && !("forbidsTables" in r) && !("forbiddenSql" in r))
      .map((r) => r.id))].sort());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
