/**
 * P2.5 verification.
 *
 *   PART A  measures the real deployed tree and asserts the eligibility closure holds.
 *   PART B  the original six mutation fixtures (eight assertions).
 *   PART C  escape 1 — JavaScript route modules — proved closed.
 *   PART D  escape 2 — delegated factual behavior — proved closed, and proved closed WITHOUT
 *           reviving indiscriminate transitive reachability, which is a separate assertion.
 *   PART E  regressions: the write-only controls, and the cross-file phantom that tightening
 *           `returnsRows` was introduced to kill.
 *
 * A guard that has never been observed to fail is evidence that the guard runs, not that the
 * property holds. Every failure mode below is observed failing.
 *
 * PRODUCTION IS NEVER TOUCHED. Part A reads source files; the rest build throwaway directories.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkEligibility, measure, routeFiles, EXCLUSIONS, ROUTE_BASENAMES } = require("./lib/route-eligibility.js");

// Defaults to this repository, which is what the canonical harness runs. An explicit root is
// still accepted so the guard can be pointed at a detached worktree during review.
const ROOT = process.argv[2] || path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}\n          got      ${a}\n          expected ${e}`); }
}
function checkTrue(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "\n          " + detail : ""}`); }
}

// ---------------------------------------------------------------- PART A
console.log("PART A — the deployed tree");
const res = checkEligibility(ROOT);

check("A1  eligibility closure holds with no failures", res.failures, []);
check("A2  every route is accounted for",
  res.sealedRoutes.length + res.excludedRoutes.length, res.routes.length);
check("A3  exactly five routes seal outcomes", res.sealedRoutes.length, 5);
check("A4  the sealed set is the inventory's hard-coded scope", res.sealedRoutes.sort(), [
  "app/api/embed/route.ts", "app/api/hc-query/route.ts", "app/api/nibrs-query/route.ts",
  "app/api/query/route.ts", "app/api/shr-query/route.ts",
].sort());
check("A5  exactly seven routes are excluded with justification", res.excludedRoutes.length, 7);
checkTrue("A6  every exclusion carries a substantive written reason",
  EXCLUSIONS.every((e) => e.reason.trim().length >= 40));

const track = res.routes.find((r) => r.route === "app/api/track/route.ts");
const crr = res.routes.find((r) => r.route === "app/api/chart-render-receipt/route.ts");
check("A7  a WRITE handle alone is not counted as a crime-database read (track)",
  [track.readsCrimeDb, track.writesOnly], [false, true]);
check("A8  chart-render-receipt reaches no crime data even through its helper",
  [crr.readsCrimeDb, crr.returnsRows, crr.sealed], [false, false, false]);

const qlog = res.routes.find((r) => r.route === "app/api/query-log/route.ts");
check("A9  query-log is measured as genuinely returning crime rows",
  [qlog.readsCrimeDb, qlog.returnsRows, qlog.invokesModel], [true, true, false]);
checkTrue("A10 its exclusion names that it returns crime data",
  /returns crime-database content|raw rows/i.test(
    EXCLUSIONS.find((e) => e.route === "app/api/query-log/route.ts").reason));

const { buildInventory } = require(path.join(ROOT, "scripts", "lib", "exit-inventory.js"));
const inv = buildInventory(ROOT);
check("A11 P2.2 inventory reports zero unsealed interior sites", inv.unsealedSites.length, 0);
check("A12 P2.2 inventory reports zero unpaired decision sites", inv.unpairedDecisionSites.length, 0);
checkTrue("A13 the two analyses agree on the sealed file set",
  JSON.stringify(res.sealedRoutes.sort()) ===
  JSON.stringify([...inv.routes.map((r) => r.file), inv.embed.file].sort()));

// ---------------------------------------------------------------- fixtures
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p25-elig-"));
function tree(name, files) {
  const root = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}
const SEALED = `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST() { return emitFactualPayload(); }`;
const INERT = `export async function POST() { return Response.json({ ok: true }); }`;
const WRITEONLY = `import { getWriteDb } from "@/lib/rtci-db";
export async function POST() { getWriteDb().prepare("INSERT INTO visitor_log VALUES (1)").run(); return Response.json({ ok: true }); }`;
const CRED = `export async function GET() {
  if (!ok) return Response.json({ error: "Unauthorized" });
  return Response.json({ queriesPerDay: [] }); }`;
const QLOG = `import { getNibrsDb } from "@/lib/nibrs-db";
export async function POST() {
  if (!LOG_KEY) return Response.json({ error: "Unauthorized" });
  const rows = getNibrsDb().prepare("SELECT 1").all();
  return NextResponse.json({ rows }); }`;
const NEW_FACTUAL_UNSEALED = `import { getNibrsDb } from "@/lib/nibrs-db";
export async function POST() {
  const rows = getNibrsDb().prepare("SELECT 1").all();
  return Response.json({ rows }); }`;

/** A complete, passing twelve-route tree. Escapes must be shown against THIS, not a stub. */
const FULL = {
  "app/api/query/route.ts": SEALED, "app/api/nibrs-query/route.ts": SEALED,
  "app/api/shr-query/route.ts": SEALED, "app/api/hc-query/route.ts": SEALED,
  "app/api/embed/route.ts": SEALED,
  "app/api/auth/route.ts": INERT, "app/api/page-token/route.ts": INERT,
  "app/api/verify-captcha/route.ts": INERT, "app/api/track/route.ts": WRITEONLY,
  "app/api/chart-render-receipt/route.ts": INERT,
  "app/api/session-analytics/route.ts": CRED, "app/api/query-log/route.ts": QLOG,
};

// ---------------------------------------------------------------- PART B
console.log("\nPART B — original mutations (six fixtures, eight assertions)");
{
  const root = tree("b1", { ...FULL, "app/api/brand-new-answers/route.ts": NEW_FACTUAL_UNSEALED });
  const r = checkEligibility(root);
  const f = r.failures.filter((x) => x.kind === "unsealed-unregistered");
  checkTrue("B1  a new unsealed factual route FAILS the closure", !r.ok && f.length === 1, JSON.stringify(r.failures));
  checkTrue("B1b it names the offending route", f[0] && f[0].route === "app/api/brand-new-answers/route.ts");
  checkTrue("B1c and reports the evidence that made it eligible", f[0] && /readsCrimeDb=true/.test(f[0].detail));
}
{
  const root = tree("b2", { ...FULL, "app/api/track/route.ts": NEW_FACTUAL_UNSEALED });
  const r = checkEligibility(root);
  checkTrue("B2  a false 'no crime-db read' justification FAILS",
    r.failures.some((x) => x.kind === "claim-mismatch" && /readsCrimeDb/.test(x.detail)));
}
{
  const root = tree("b3", { "app/api/query/route.ts": SEALED });
  checkTrue("B3  registry entries for deleted routes FAIL as stale",
    checkEligibility(root).failures.some((x) => x.kind === "stale-exclusion"));
}
{
  const root = tree("b4", { ...FULL, "app/api/track/route.ts": SEALED });
  checkTrue("B4  sealed AND excluded is reported as a contradiction",
    checkEligibility(root).failures.some((x) => x.kind === "sealed-and-excluded"));
}
{
  const root = tree("b5", { "app/api/track/route.ts": WRITEONLY });
  const m = measure(root, path.join(root, "app/api/track/route.ts"));
  check("B5  write-only telemetry measures as non-factual",
    [m.readsCrimeDb, m.writesOnly, m.sealed], [false, true, false]);
}
{
  checkTrue("B6  an empty tree does not pass vacuously", !checkEligibility(tree("b6", {})).ok);
}

// ---------------------------------------------------------------- PART C — escape 1
console.log("\nPART C — escape 1: JavaScript route modules");
{
  const control = checkEligibility(tree("c0", FULL));
  checkTrue("C0  control: the complete tree passes (so C1 is not vacuous)", control.ok,
    JSON.stringify(control.failures));

  const root = tree("c1", { ...FULL, "app/api/sneaky/route.js": NEW_FACTUAL_UNSEALED });
  const r = checkEligibility(root);
  check("C1  the .js route is now enumerated", routeFiles(root).length, 13);
  checkTrue("C2  a JavaScript route answering with crime data FAILS", !r.ok, JSON.stringify(r.failures));
  checkTrue("C3  and it is named", r.failures.some((f) => f.route === "app/api/sneaky/route.js"));

  check("C4  every Next.js route extension is enumerated", ROUTE_BASENAMES.sort(),
    ["route.cjs", "route.js", "route.jsx", "route.mjs", "route.ts", "route.tsx"]);
  const multi = tree("c5", { ...FULL,
    "app/api/a/route.jsx": NEW_FACTUAL_UNSEALED,
    "app/api/b/route.mjs": NEW_FACTUAL_UNSEALED,
    "app/api/c/route.cjs": NEW_FACTUAL_UNSEALED });
  const rm = checkEligibility(multi);
  check("C5  .jsx / .mjs / .cjs are all caught too",
    rm.failures.filter((f) => f.kind === "unsealed-unregistered").length, 3);
}

// ---------------------------------------------------------------- PART D — escape 2
console.log("\nPART D — escape 2: delegated factual behavior");
{
  // A REGISTERED EXCLUSION whose body delegates. Its own source is clean.
  const root = tree("d1", { ...FULL,
    "app/api/auth/route.ts": `import { answerFromCrimeData } from "@/lib/sneaky-helper";
export async function POST(req) { return answerFromCrimeData(req); }`,
    "lib/sneaky-helper.ts": `import { getNibrsDb } from "@/lib/nibrs-db";
export function answerFromCrimeData() {
  const rows = getNibrsDb().prepare("SELECT 1").all();
  return Response.json({ rows }); }`,
  });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  const r = checkEligibility(root);
  check("D1  the delegated read is now measured", [m.readsCrimeDb, m.returnsRows], [true, true]);
  checkTrue("D2  the delegating exclusion FAILS its claims",
    r.failures.some((f) => f.route === "app/api/auth/route.ts" && f.kind === "claim-mismatch"),
    JSON.stringify(r.failures));
  checkTrue("D3  the failure names the delegated module",
    r.failures.some((f) => /sneaky-helper/.test(f.detail || "")));

  // THE COUNTERPART ASSERTION. Closing escape 2 must not revive reachability: a module that is
  // IMPORTED but never called from a handler must not be pulled in.
  const imported = tree("d4", { ...FULL,
    "app/api/auth/route.ts": `import { answerFromCrimeData } from "@/lib/sneaky-helper";
export async function POST() { return Response.json({ ok: true }); }`,
    "lib/sneaky-helper.ts": `import { getNibrsDb } from "@/lib/nibrs-db";
export function answerFromCrimeData() {
  const rows = getNibrsDb().prepare("SELECT 1").all();
  return Response.json({ rows }); }`,
  });
  const mi = measure(imported, path.join(imported, "app/api/auth/route.ts"));
  check("D4  an imported-but-uncalled helper is NOT pulled in (no reachability regression)",
    [mi.readsCrimeDb, mi.delegatedModules.length], [false, 0]);
  checkTrue("D5  so the tree still passes", checkEligibility(imported).ok);

  // The access layer must stay a leaf, or `track` becomes a "reader" via getDb's definition.
  const leaf = tree("d6", { ...FULL,
    "lib/rtci-db.ts": `export function getDb() { return null; }
export function getWriteDb() { return null; }` });
  const mt = measure(leaf, path.join(leaf, "app/api/track/route.ts"));
  check("D6  the db access layer is a walk leaf, so write-only stays write-only",
    [mt.readsCrimeDb, mt.writesOnly], [false, true]);
}

// ---------------------------------------------------------------- PART E — regressions
console.log("\nPART E — measurement regressions");
{
  // The phantom that per-unit measurement kills: `rows` in one module, a response in another.
  const root = tree("e1", { ...FULL,
    "app/api/chart-render-receipt/route.ts": `import { persist } from "@/lib/audit-helper";
export async function POST() { persist(); return Response.json({ success: true }); }`,
    "lib/audit-helper.ts": `export interface Receipt { rows: string[] }
export function persist() { db.prepare("INSERT INTO t VALUES (1)").run(); }`,
  });
  const m = measure(root, path.join(root, "app/api/chart-render-receipt/route.ts"));
  check("E1  a `rows` token in one file and a response in another is NOT a row return",
    m.returnsRows, false);
  checkTrue("E2  so the receipt writer still passes", checkEligibility(root).ok,
    JSON.stringify(checkEligibility(root).failures));

  // ...but a single file containing both still counts, or escape 2 would reopen.
  const real = tree("e3", { ...FULL,
    "app/api/auth/route.ts": `import { h } from "@/lib/h";
export async function POST() { return h(); }`,
    "lib/h.ts": `import { getShrDb } from "@/lib/shr-db";
export function h() { const rows = getShrDb().prepare("SELECT 1").all(); return Response.json({ rows }); }`,
  });
  const mr = measure(real, path.join(real, "app/api/auth/route.ts"));
  check("E3  one file holding both the row binding and the response still counts",
    [mr.readsCrimeDb, mr.returnsRows], [true, true]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
