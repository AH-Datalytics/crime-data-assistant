/**
 * Verification for the route-eligibility denominator guard.
 *
 *   A  the real deployed tree
 *   B  the original mutation fixtures
 *   C  escape 1 — JavaScript route modules
 *   D  escape 2 — delegated factual behavior, and the proof that closing it did not revive
 *      indiscriminate transitive reachability
 *   E  measurement regressions
 *   F  the pre-merge review matrix: multi-hop delegation, explicit-extension imports, barrel
 *      re-exports, dynamic loads, budget exhaustion, allowlist identity, and the documented
 *      behavior of the conservative model
 *
 * A guard that has never been observed to fail is evidence that the guard runs, not that the
 * property holds. Every failure mode below is observed failing.
 *
 * PRODUCTION IS NEVER TOUCHED. Part A reads source files; the rest build throwaway directories.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  checkEligibility, measure, routeFiles, resolveImport,
  assertRouteExtensionAssumption, validateAccessLayer,
  EXCLUSIONS, ROUTE_BASENAMES, ACCESS_LAYER, MAX_MODULES, HELPER_RESPONSE_ALLOWLIST,
} = require("./lib/route-eligibility.js");

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
checkTrue("A8b and it really does reach that helper, so A8 is not vacuous",
  crr.reachedModules.includes("lib/chart-audit.ts"), JSON.stringify(crr.reachedModules));

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
check("A14 no route's analysis was incomplete", res.routes.filter((r) => r.incomplete.length).length, 0);

// ---------------------------------------------------------------- fixtures
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p25-elig-"));
function tree(name, files) {
  const root = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  // proof-finalize is no longer an access-layer leaf, so SEALED fixtures must be able to resolve
  // it or every one of them reports unresolved-local-load.
  const pf = path.join(root, "lib/proof-finalize.ts");
  if (!fs.existsSync(pf)) {
    fs.mkdirSync(path.dirname(pf), { recursive: true });
    fs.writeFileSync(pf, "export function emitFactualPayload() { return null; }");
  }
  // The access-layer allowlist must validate, or every fixture fails on config-assumption.
  for (const rel of ACCESS_LAYER) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "export function getDb() { return null; }\nexport function getWriteDb() { return null; }\n");
    }
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
/** A helper that genuinely answers with crime data. */
const FACTUAL_HELPER = `import { getNibrsDb } from "@/lib/nibrs-db";
export function answerFromCrimeData() {
  const rows = getNibrsDb().prepare("SELECT 1").all();
  return Response.json({ rows }); }`;

const FULL = {
  "app/api/query/route.ts": SEALED, "app/api/nibrs-query/route.ts": SEALED,
  "app/api/shr-query/route.ts": SEALED, "app/api/hc-query/route.ts": SEALED,
  "app/api/embed/route.ts": SEALED,
  "app/api/auth/route.ts": INERT, "app/api/page-token/route.ts": INERT,
  "app/api/verify-captcha/route.ts": INERT, "app/api/track/route.ts": WRITEONLY,
  "app/api/chart-render-receipt/route.ts": INERT,
  "app/api/session-analytics/route.ts": CRED, "app/api/query-log/route.ts": QLOG,
};
const failsAuth = (r) => r.failures.some((f) => f.route === "app/api/auth/route.ts");

// ---------------------------------------------------------------- PART B
console.log("\nPART B — original mutations");
{
  const root = tree("b1", { ...FULL, "app/api/brand-new-answers/route.ts": NEW_FACTUAL_UNSEALED });
  const r = checkEligibility(root);
  const f = r.failures.filter((x) => x.kind === "unsealed-unregistered");
  checkTrue("B1  a new unsealed factual route FAILS the closure", !r.ok && f.length === 1, JSON.stringify(r.failures));
  checkTrue("B1b it names the offending route", f[0] && f[0].route === "app/api/brand-new-answers/route.ts");
  checkTrue("B1c and reports the evidence that made it eligible", f[0] && /readsCrimeDb=true/.test(f[0].detail));
}
{
  const r = checkEligibility(tree("b2", { ...FULL, "app/api/track/route.ts": NEW_FACTUAL_UNSEALED }));
  checkTrue("B2  a false 'no crime-db read' justification FAILS",
    r.failures.some((x) => x.kind === "claim-mismatch" && /readsCrimeDb/.test(x.detail)));
}
{
  checkTrue("B3  registry entries for deleted routes FAIL as stale",
    checkEligibility(tree("b3", { "app/api/query/route.ts": SEALED })).failures
      .some((x) => x.kind === "stale-exclusion"));
}
{
  checkTrue("B4  sealed AND excluded is reported as a contradiction",
    checkEligibility(tree("b4", { ...FULL, "app/api/track/route.ts": SEALED })).failures
      .some((x) => x.kind === "sealed-and-excluded"));
}
{
  const root = tree("b5", { "app/api/track/route.ts": WRITEONLY });
  const m = measure(root, path.join(root, "app/api/track/route.ts"));
  check("B5  write-only telemetry measures as non-factual",
    [m.readsCrimeDb, m.writesOnly, m.sealed], [false, true, false]);
}
checkTrue("B6  an empty tree does not pass vacuously", !checkEligibility(tree("b6", {})).ok);

// ---------------------------------------------------------------- PART C
console.log("\nPART C — escape 1: JavaScript route modules");
{
  const control = checkEligibility(tree("c0", FULL));
  checkTrue("C0  control: the complete tree passes (so C1 is not vacuous)", control.ok,
    JSON.stringify(control.failures));

  const root = tree("c1", { ...FULL, "app/api/sneaky/route.js": NEW_FACTUAL_UNSEALED });
  const r = checkEligibility(root);
  check("C1  the .js route is now enumerated", routeFiles(root).length, 13);
  checkTrue("C2  a JavaScript route answering with crime data FAILS", !r.ok);
  checkTrue("C3  and it is named", r.failures.some((f) => f.route === "app/api/sneaky/route.js"));
  check("C4  every Next.js route extension is enumerated", ROUTE_BASENAMES.slice().sort(),
    ["route.cjs", "route.js", "route.jsx", "route.mjs", "route.ts", "route.tsx"]);
  const multi = tree("c5", { ...FULL,
    "app/api/a/route.jsx": NEW_FACTUAL_UNSEALED,
    "app/api/b/route.mjs": NEW_FACTUAL_UNSEALED,
    "app/api/c/route.cjs": NEW_FACTUAL_UNSEALED });
  check("C5  .jsx / .mjs / .cjs are all caught too",
    checkEligibility(multi).failures.filter((f) => f.kind === "unsealed-unregistered").length, 3);
}

// ---------------------------------------------------------------- PART D
console.log("\nPART D — escape 2: delegated factual behavior");
{
  const root = tree("d1", { ...FULL,
    "app/api/auth/route.ts": `import { answerFromCrimeData } from "@/lib/sneaky-helper";
export async function POST(req) { return answerFromCrimeData(req); }`,
    "lib/sneaky-helper.ts": FACTUAL_HELPER });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  const r = checkEligibility(root);
  check("D1  the delegated read is now measured", [m.readsCrimeDb, m.returnsRows], [true, true]);
  checkTrue("D2  the delegating exclusion FAILS its claims", failsAuth(r), JSON.stringify(r.failures));
  checkTrue("D3  the failure names the reached module",
    r.failures.some((f) => /sneaky-helper/.test(f.detail || "")));

  // Closing escape 2 must not revive reachability: imported but never referenced by a handler.
  const imported = tree("d4", { ...FULL,
    "app/api/auth/route.ts": `import { answerFromCrimeData } from "@/lib/sneaky-helper";
export async function POST() { return Response.json({ ok: true }); }`,
    "lib/sneaky-helper.ts": FACTUAL_HELPER });
  const mi = measure(imported, path.join(imported, "app/api/auth/route.ts"));
  check("D4  an imported-but-uncalled helper is NOT pulled in at the route",
    [mi.readsCrimeDb, mi.reachedModules.length], [false, 0]);
  checkTrue("D5  so the tree still passes", checkEligibility(imported).ok);

  const leaf = tree("d6", FULL);
  const mt = measure(leaf, path.join(leaf, "app/api/track/route.ts"));
  check("D6  the access layer is a walk leaf, so write-only stays write-only",
    [mt.readsCrimeDb, mt.writesOnly], [false, true]);
}

// ---------------------------------------------------------------- PART E
console.log("\nPART E — measurement regressions");
{
  const root = tree("e1", { ...FULL,
    "app/api/chart-render-receipt/route.ts": `import { persist } from "@/lib/audit-helper";
export async function POST() { persist(); return Response.json({ success: true }); }`,
    "lib/audit-helper.ts": `export interface Receipt { rows: string[] }
export function persist() { db.prepare("INSERT INTO t VALUES (1)").run(); }` });
  const m = measure(root, path.join(root, "app/api/chart-render-receipt/route.ts"));
  check("E1  a `rows` token in one file and a response in another is NOT a row return", m.returnsRows, false);
  checkTrue("E2  so the receipt writer still passes", checkEligibility(root).ok);

  const real = tree("e3", { ...FULL,
    "app/api/auth/route.ts": `import { h } from "@/lib/h";
export async function POST() { return h(); }`,
    "lib/h.ts": `import { getShrDb } from "@/lib/shr-db";
export function h() { const rows = getShrDb().prepare("SELECT 1").all(); return Response.json({ rows }); }` });
  const mr = measure(real, path.join(real, "app/api/auth/route.ts"));
  check("E3  one file holding both the row binding and the response still counts",
    [mr.readsCrimeDb, mr.returnsRows], [true, true]);
}

// ---------------------------------------------------------------- PART F — review matrix
console.log("\nPART F — pre-merge review matrix");

// F1 — multi-hop delegation. The previous fixed depth of 3 certified this on partial evidence.
{
  const root = tree("f1", { ...FULL,
    "app/api/auth/route.ts": `import { a } from "@/lib/a";
export async function POST() { return a(); }`,
    "lib/a.ts": `import { b } from "@/lib/b";\nexport function a() { return b(); }`,
    "lib/b.ts": `import { c } from "@/lib/c";\nexport function b() { return c(); }`,
    "lib/c.ts": `import { d } from "@/lib/d";\nexport function c() { return d(); }`,
    "lib/d.ts": `import { answerFromCrimeData } from "@/lib/e";\nexport function d() { return answerFromCrimeData(); }`,
    "lib/e.ts": FACTUAL_HELPER });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  check("F1  a five-hop factual delegation is reached", [m.readsCrimeDb, m.returnsRows], [true, true]);
  checkTrue("F1b and it FAILS the exclusion", failsAuth(checkEligibility(root)));
}

// F2 — explicit-extension import. `if (ext && ...)` skipped the only candidate that resolves it.
{
  const root = tree("f2", { ...FULL,
    "app/api/auth/route.ts": `import { answerFromCrimeData } from "./helper.js";
export async function POST() { return answerFromCrimeData(); }`,
    "app/api/auth/helper.js": FACTUAL_HELPER });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  check("F2  an explicit ./helper.js import resolves and is measured",
    [m.readsCrimeDb, m.returnsRows], [true, true]);
  checkTrue("F2b and it FAILS the exclusion", failsAuth(checkEligibility(root)));
  const r = resolveImport(root, path.join(root, "app/api/auth/route.ts"), "./helper.js");
  checkTrue("F2c resolveImport returns the exact path, not a probed one",
    r && r.endsWith("helper.js"), String(r));
}

// F3 — barrel re-export. The walk used to stop dead at the barrel.
{
  const root = tree("f3", { ...FULL,
    "app/api/auth/route.ts": `import { answerFromCrimeData } from "@/lib/barrel";
export async function POST() { return answerFromCrimeData(); }`,
    "lib/barrel/index.ts": `export { answerFromCrimeData } from "../real-helper";`,
    "lib/real-helper.ts": FACTUAL_HELPER });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  check("F3  a barrel re-export is followed to the real helper",
    [m.readsCrimeDb, m.returnsRows], [true, true]);
  checkTrue("F3b and it FAILS the exclusion", failsAuth(checkEligibility(root)));
}

// F4 — literal dynamic load.
{
  const root = tree("f4", { ...FULL,
    "app/api/auth/route.ts": `export async function POST() {
  const mod = await import("@/lib/dyn-helper");
  return mod.answerFromCrimeData(); }`,
    "lib/dyn-helper.ts": FACTUAL_HELPER });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  check("F4  a literal dynamic import is followed", [m.readsCrimeDb, m.returnsRows], [true, true]);
  checkTrue("F4b and it FAILS the exclusion", failsAuth(checkEligibility(root)));
}

// F5 — non-literal dynamic load must be REFUSED as incomplete, never read as absence.
{
  const root = tree("f5", { ...FULL,
    "app/api/auth/route.ts": `export async function POST(req) {
  const name = req.headers.get("x-mod");
  const mod = await import(name);
  return mod.answer(); }` });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  checkTrue("F5  a non-literal dynamic load is recorded as incomplete",
    m.incomplete.some((i) => i.reason === "non-literal-dynamic-load"), JSON.stringify(m.incomplete));
  const r = checkEligibility(root);
  checkTrue("F5b and the route FAILS closed rather than being certified",
    r.failures.some((f) => f.kind === "analysis-incomplete" && f.route === "app/api/auth/route.ts"),
    JSON.stringify(r.failures));
}

// F6 — budget exhaustion fails closed instead of truncating and passing.
{
  const files = { ...FULL,
    "app/api/auth/route.ts": `import { m0 } from "@/lib/m0";
export async function POST() { return m0(); }` };
  const n = MAX_MODULES + 5;
  for (let i = 0; i < n; i++) {
    files[`lib/m${i}.ts`] = i < n - 1
      ? `import { m${i + 1} } from "@/lib/m${i + 1}";\nexport function m${i}() { return m${i + 1}(); }`
      : `export function m${i}() { return null; }`;
  }
  const root = tree("f6", files);
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  checkTrue("F6  exhausting the module budget is recorded as incomplete",
    m.incomplete.some((i) => i.reason === "module-budget-exceeded"), JSON.stringify(m.incomplete.slice(0, 2)));
  checkTrue("F6b and the route FAILS closed rather than being certified",
    checkEligibility(root).failures.some((f) => f.kind === "analysis-incomplete"));
}

// F7 — the allowlist is an identity, not a naming convention.
{
  const root = tree("f7", { ...FULL,
    "app/api/auth/route.ts": `import { answerFromCrimeData } from "@/lib/crime-db";
export async function POST() { return answerFromCrimeData(); }`,
    "lib/crime-db.ts": FACTUAL_HELPER });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  check("F7  an unrelated module whose name ends in -db is NOT skipped",
    [m.readsCrimeDb, m.returnsRows], [true, true]);
  checkTrue("F7b and it FAILS the exclusion", failsAuth(checkEligibility(root)));
  checkTrue("F7c the reviewed allowlist is exact paths, not a pattern",
    ACCESS_LAYER.every((p) => p.startsWith("lib/") && p.endsWith(".ts")));
  const rotted = tree("f7d", FULL);
  fs.rmSync(path.join(rotted, "lib/shr-db.ts"));
  checkTrue("F7d a stale allowlist entry fails rather than silently skipping nothing",
    checkEligibility(rotted).failures.some((f) => f.kind === "config-assumption"));
}

// F8 — the documented behavior of the conservative model: inside a reached helper, an unused
// import IS followed. This is an over-approximation, and it is asserted so it stays deliberate.
{
  const root = tree("f8", { ...FULL,
    "app/api/auth/route.ts": `import { outer } from "@/lib/outer";
export async function POST() { return outer(); }`,
    "lib/outer.ts": `import { answerFromCrimeData } from "@/lib/inner";
export function outer() { return Response.json({ ok: true }); }`,
    "lib/inner.ts": FACTUAL_HELPER });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  check("F8  a nested UNUSED import inside a reached helper is still followed (conservative)",
    [m.readsCrimeDb, m.reachedModules.includes("lib/inner.ts")], [true, true]);
  checkTrue("F8b which is the fail-closed direction: it fails rather than certifies",
    failsAuth(checkEligibility(root)));
}

// F9 — the route-extension list is only sound while pageExtensions is untouched.
{
  check("F9  the real repository does not customize pageExtensions",
    assertRouteExtensionAssumption(ROOT).ok, true);
  const root = tree("f9", { ...FULL, "next.config.ts": `export default { pageExtensions: ["ts","xyz"] };` });
  checkTrue("F9b if it ever does, the guard fails rather than assuming its list is complete",
    checkEligibility(root).failures.some((f) => f.kind === "config-assumption"));
  check("F9c the access-layer allowlist validates against the real tree",
    validateAccessLayer(ROOT), { ok: true, missing: [], violations: [] });
}

// F10 — harness accounting: this guard is declared, and its declaration matches its script path.
{
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, "scripts", "fixtures", "harness-tier-manifest.json"), "utf8"));
  const entry = manifest.entries.find((e) => e.id === "test-route-eligibility");
  checkTrue("F10 the guard is declared in the canonical tier manifest", !!entry);
  check("F10b declared Tier F with no database dependency",
    entry && [entry.tier, entry.databases.length], ["F", 0]);
  check("F10c the declared script path is this file",
    entry && entry.script, "scripts/test-route-eligibility.js");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  checkTrue("F10d and the canonical chain actually runs it",
    /node scripts\/test-route-eligibility\.js/.test(pkg.scripts["harness:test"]));
}

// ---------------------------------------------------------------- PART G — round-2 review matrix
// Every case here escaped or was ignored under 721a6fd. The shared theme: a SEALED route is not
// self-certifying. `sealed` means the file contains one of three primitive names; it proves
// nothing about a path the analysis never saw, or a delivery that never touched a seal.
console.log("\nPART G — round-2 review matrix");
const failsQuery = (r) => r.failures.some((f) => f.route === "app/api/query/route.ts");

// G1 — a SEALED route with a non-literal dynamic load. Previously exempted from incompleteness.
{
  const root = tree("g1", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST(req) {
  const name = req.headers.get("x-mod");
  const mod = await import(name);
  if (mod) return mod.answer();
  return emitFactualPayload(); }` });
  const m = measure(root, path.join(root, "app/api/query/route.ts"));
  check("G1  a sealed route is still measured as sealed", m.sealed, true);
  checkTrue("G1b but its unseen dynamic path is recorded incomplete",
    m.incomplete.some((i) => i.reason === "non-literal-dynamic-load"));
  checkTrue("G1c and it FAILS closed rather than riding on its seal",
    checkEligibility(root).failures.some(
      (f) => f.kind === "analysis-incomplete" && f.route === "app/api/query/route.ts"),
    JSON.stringify(checkEligibility(root).failures));
}

// G2 — a SEALED route delegating terminal delivery to a helper outside the exit inventory.
{
  const root = tree("g2", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
import { helperThatReturns } from "@/lib/deliverer";
export async function POST(req) {
  if (req) return helperThatReturns();
  return emitFactualPayload(); }`,
    "lib/deliverer.ts": FACTUAL_HELPER.replace("answerFromCrimeData", "helperThatReturns") });
  const m = measure(root, path.join(root, "app/api/query/route.ts"));
  check("G2  the delegated response exit is detected", m.helperResponseExits, ["lib/deliverer.ts"]);
  const r = checkEligibility(root);
  checkTrue("G2b and the sealed route FAILS", failsQuery(r), JSON.stringify(r.failures));
  checkTrue("G2c named as a delegated-response-exit requiring review",
    r.failures.some((f) => f.kind === "delegated-response-exit" && /deliverer/.test(f.detail)));
  checkTrue("G2d the deployed tree has no such exit, so G2 is not the normal state",
    res.routes.every((x) => x.helperResponseExits.length === 0));
}

// G3 — a SEALED route that keeps its seal and adds a raw factual branch in the SAME file.
// The pinned 96-site inventory is unchanged by this shape, which is why P2.2 alone cannot see it.
{
  const root = tree("g3", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
import { getNibrsDb } from "@/lib/nibrs-db";
export async function POST(req) {
  if (req.fast) {
    const rows = getNibrsDb().prepare("SELECT 1").all();
    return Response.json({ rows });
  }
  return emitFactualPayload(); }` });
  const m = measure(root, path.join(root, "app/api/query/route.ts"));
  check("G3  the route still contains a seal", m.sealed, true);
  check("G3b the raw factual branch is found", m.unsealedFactualResponses.length, 1);
  checkTrue("G3c and it FAILS as an unsealed factual response",
    checkEligibility(root).failures.some((f) => f.kind === "unsealed-factual-response"));
  check("G3d an operational raw response is NOT flagged",
    measure(tree("g3d", { ...FULL,
      "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST(req) {
  if (!req.ok) return Response.json({ error: "bad request" });
  return emitFactualPayload(); }` }),
      path.join(tmp, "g3d", "app/api/query/route.ts")).unsealedFactualResponses.length, 0);
}

// G4 — a route-level side-effect import binds no name, so a handler-reference test cannot select it.
{
  const root = tree("g4", { ...FULL,
    "app/api/auth/route.ts": `import "@/lib/side-effect";
export async function POST() { return Response.json({ ok: true }); }`,
    "lib/side-effect.ts": FACTUAL_HELPER });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  checkTrue("G4  a bindless side-effect import is followed, not skipped",
    m.reachedModules.includes("lib/side-effect.ts"), JSON.stringify(m.reachedModules));
  checkTrue("G4b so its factual behavior FAILS the exclusion", failsAuth(checkEligibility(root)));
}

// G5 — a selected local specifier that will not resolve is a blind spot, not an absence.
{
  const root = tree("g5", { ...FULL,
    "app/api/auth/route.ts": `import { gone } from "@/lib/does-not-exist";
export async function POST() { return gone(); }` });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  checkTrue("G5  an unresolved local import is recorded incomplete",
    m.incomplete.some((i) => i.reason === "unresolved-local-load"), JSON.stringify(m.incomplete));
  checkTrue("G5b and the route FAILS closed",
    checkEligibility(root).failures.some((f) => f.kind === "analysis-incomplete"));
  checkTrue("G5c a bare package import is NOT treated as unresolved",
    measure(tree("g5c", { ...FULL,
      "app/api/auth/route.ts": `import { z } from "zod";
export async function POST() { return Response.json({ ok: !!z }); }` }),
      path.join(tmp, "g5c", "app/api/auth/route.ts")).incomplete.length === 0);
}

// G6 — the proof modules were never access-layer leaves: they define no accessor.
{
  const root = tree("g6", { ...FULL,
    "app/api/auth/route.ts": `import { answerFromCrimeData } from "@/lib/proof-contract";
export async function POST() { return answerFromCrimeData(); }`,
    "lib/proof-contract.ts": FACTUAL_HELPER });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  checkTrue("G6  a proof module is traversed, not skipped",
    m.reachedModules.includes("lib/proof-contract.ts"), JSON.stringify(m.reachedModules));
  checkTrue("G6b so factual behavior placed there FAILS", failsAuth(checkEligibility(root)));
  check("G6c the leaf list is the database accessors only", ACCESS_LAYER.slice().sort(),
    ["lib/hc-db.ts", "lib/nibrs-db.ts", "lib/rtci-db.ts", "lib/shr-db.ts", "lib/sqlite-db.ts"]);
}

// G7 — leaf status is validated by the property that justifies it, not by existence.
{
  const noAccessor = tree("g7a", FULL);
  fs.writeFileSync(path.join(noAccessor, "lib/shr-db.ts"), "export const x = 1;");
  checkTrue("G7  a leaf that stops defining an accessor FAILS configuration",
    checkEligibility(noAccessor).failures.some(
      (f) => f.kind === "config-assumption" && /defines no crime-database accessor/.test(f.detail)));

  const delivers = tree("g7b", FULL);
  fs.writeFileSync(path.join(delivers, "lib/shr-db.ts"),
    "export function getShrDb() { return null; }\nexport function send() { return Response.json({ rows: [] }); }");
  checkTrue("G7b a leaf that starts constructing a response FAILS configuration",
    checkEligibility(delivers).failures.some(
      (f) => f.kind === "config-assumption" && /constructs an HTTP response/.test(f.detail)));

  check("G7c reading inside a leaf is NOT a violation - that is what an access layer does",
    validateAccessLayer(ROOT).violations, []);
  check("G7d the helper-response allowlist is empty, so no delegated exit is pre-approved",
    HELPER_RESPONSE_ALLOWLIST, []);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
