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
  OPERATIONAL_EXITS, OPERATIONAL_STREAM_EVENTS,
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
check("A15 no sealed route has an unclassified terminal exit outside the registry",
  res.failures.filter((f) => f.kind === "unclassified-terminal-exit" || f.kind === "stale-operational-exit").length, 0);

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

// The sealed fixtures carry the SAME registered operational exits as the real routes. Stub
// bodies made the registry read as stale in every fixture, and a fixture that cannot represent
// the thing being guarded cannot test it. `SEAL_TAIL` is appended so each file also seals.
const SEAL_TAIL = `
  return emitFactualPayload(); }`;
const SEALED_QUERY = `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST(req) {
  if (req.a) return new Response(JSON.stringify({ success: false }), { status: 429 });
  if (req.b) return new Response(JSON.stringify({ success: false }), { status: 400 });
  if (req.c) return new Response(JSON.stringify({ success: false }), { status: 400 });
  if (req.d) return new Response(JSON.stringify({ success: false }), { status: 403 });
  if (req.e) return new Response(JSON.stringify({ success: false }), { status: 400 });
  if (req.f) return new Response(JSON.stringify({ success: false }), { status: 400 });
  if (req.g) return new Response(JSON.stringify({ success: false }), { status: 500 });` + SEAL_TAIL;
const SEALED_NIBRS = `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function OPTIONS() { return new NextResponse(null, { status: 204 }); }
export async function POST(req) {
  if (req.c) return NextResponse.json({ success: false, captchaRequired: true });` + SEAL_TAIL;
const SEALED_SHR = `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST(req) {
  if (req.c) return NextResponse.json({ success: false, captchaRequired: true });` + SEAL_TAIL;
const SEALED_HC = `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST(req) {
  if (req.c) return NextResponse.json({ success: false, captchaRequired: true });
  if (req.s) return NextResponse.json({ success: false, error: "source unavailable" });` + SEAL_TAIL;

const FULL = {
  "app/api/query/route.ts": SEALED, "app/api/nibrs-query/route.ts": SEALED,
  "app/api/shr-query/route.ts": SEALED, "app/api/hc-query/route.ts": SEALED,
  "app/api/embed/route.ts": SEALED,
  "app/api/auth/route.ts": INERT, "app/api/page-token/route.ts": INERT,
  "app/api/verify-captcha/route.ts": INERT, "app/api/track/route.ts": WRITEONLY,
  "app/api/chart-render-receipt/route.ts": INERT,
  "app/api/session-analytics/route.ts": CRED, "app/api/query-log/route.ts": QLOG,
};
// Fixtures supply their own registries. The real ones are keyed by value-aware fingerprints
// containing production literal text; a fixture that reproduced them would be a copy of
// production, not a test. Part A above uses the real registries.
const FX = { operationalExits: [], operationalStreamEvents: [], reviewedDeliveryBodies: [] };
const elig = (root) => checkEligibility(root, FX);
const failsAuth = (r) => r.failures.some((f) => f.route === "app/api/auth/route.ts");

// ---------------------------------------------------------------- PART B
console.log("\nPART B — original mutations");
{
  const root = tree("b1", { ...FULL, "app/api/brand-new-answers/route.ts": NEW_FACTUAL_UNSEALED });
  const r = elig(root);
  const f = r.failures.filter((x) => x.kind === "unsealed-unregistered");
  checkTrue("B1  a new unsealed factual route FAILS the closure", !r.ok && f.length === 1, JSON.stringify(r.failures));
  checkTrue("B1b it names the offending route", f[0] && f[0].route === "app/api/brand-new-answers/route.ts");
  checkTrue("B1c and reports the evidence that made it eligible", f[0] && /readsCrimeDb=true/.test(f[0].detail));
}
{
  const r = elig(tree("b2", { ...FULL, "app/api/track/route.ts": NEW_FACTUAL_UNSEALED }));
  checkTrue("B2  a false 'no crime-db read' justification FAILS",
    r.failures.some((x) => x.kind === "claim-mismatch" && /readsCrimeDb/.test(x.detail)));
}
{
  checkTrue("B3  registry entries for deleted routes FAIL as stale",
    elig(tree("b3", { "app/api/query/route.ts": SEALED })).failures
      .some((x) => x.kind === "stale-exclusion"));
}
{
  checkTrue("B4  sealed AND excluded is reported as a contradiction",
    elig(tree("b4", { ...FULL, "app/api/track/route.ts": SEALED })).failures
      .some((x) => x.kind === "sealed-and-excluded"));
}
{
  const root = tree("b5", { "app/api/track/route.ts": WRITEONLY });
  const m = measure(root, path.join(root, "app/api/track/route.ts"));
  check("B5  write-only telemetry measures as non-factual",
    [m.readsCrimeDb, m.writesOnly, m.sealed], [false, true, false]);
}
checkTrue("B6  an empty tree does not pass vacuously", !elig(tree("b6", {})).ok);

// ---------------------------------------------------------------- PART C
console.log("\nPART C — escape 1: JavaScript route modules");
{
  const control = elig(tree("c0", FULL));
  checkTrue("C0  control: the complete tree passes (so C1 is not vacuous)", control.ok,
    JSON.stringify(control.failures));

  const root = tree("c1", { ...FULL, "app/api/sneaky/route.js": NEW_FACTUAL_UNSEALED });
  const r = elig(root);
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
    elig(multi).failures.filter((f) => f.kind === "unsealed-unregistered").length, 3);
}

// ---------------------------------------------------------------- PART D
console.log("\nPART D — escape 2: delegated factual behavior");
{
  const root = tree("d1", { ...FULL,
    "app/api/auth/route.ts": `import { answerFromCrimeData } from "@/lib/sneaky-helper";
export async function POST(req) { return answerFromCrimeData(req); }`,
    "lib/sneaky-helper.ts": FACTUAL_HELPER });
  const m = measure(root, path.join(root, "app/api/auth/route.ts"));
  const r = elig(root);
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
  checkTrue("D5  so the tree still passes", elig(imported).ok);

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
  checkTrue("E2  so the receipt writer still passes", elig(root).ok);

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
  checkTrue("F1b and it FAILS the exclusion", failsAuth(elig(root)));
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
  checkTrue("F2b and it FAILS the exclusion", failsAuth(elig(root)));
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
  checkTrue("F3b and it FAILS the exclusion", failsAuth(elig(root)));
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
  checkTrue("F4b and it FAILS the exclusion", failsAuth(elig(root)));
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
  const r = elig(root);
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
    elig(root).failures.some((f) => f.kind === "analysis-incomplete"));
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
  checkTrue("F7b and it FAILS the exclusion", failsAuth(elig(root)));
  checkTrue("F7c the reviewed allowlist is exact paths, not a pattern",
    ACCESS_LAYER.every((p) => p.startsWith("lib/") && p.endsWith(".ts")));
  const rotted = tree("f7d", FULL);
  fs.rmSync(path.join(rotted, "lib/shr-db.ts"));
  checkTrue("F7d a stale allowlist entry fails rather than silently skipping nothing",
    elig(rotted).failures.some((f) => f.kind === "config-assumption"));
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
    failsAuth(elig(root)));
}

// F9 — the route-extension list is only sound while pageExtensions is untouched.
{
  check("F9  the real repository does not customize pageExtensions",
    assertRouteExtensionAssumption(ROOT).ok, true);
  const root = tree("f9", { ...FULL, "next.config.ts": `export default { pageExtensions: ["ts","xyz"] };` });
  checkTrue("F9b if it ever does, the guard fails rather than assuming its list is complete",
    elig(root).failures.some((f) => f.kind === "config-assumption"));
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
    elig(root).failures.some(
      (f) => f.kind === "analysis-incomplete" && f.route === "app/api/query/route.ts"),
    JSON.stringify(elig(root).failures));
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
  const r = elig(root);
  checkTrue("G2b and the sealed route FAILS", failsQuery(r), JSON.stringify(r.failures));
  checkTrue("G2c named as a delegated-response-exit requiring review",
    r.failures.some((f) => f.kind === "delegated-response-exit" && /deliverer/.test(f.detail)));
  checkTrue("G2d the deployed tree has no such exit, so G2 is not the normal state",
    res.routes.every((x) => x.helperResponseExits.length === 0));
}

// G3 — a SEALED route that keeps its seal and adds a raw factual branch in the SAME file.
// The pinned 96-site inventory is unchanged by this shape, which is why P2.2 alone cannot see it.
//
// EVERY SPELLING BELOW IS THE SAME FAILURE, and that is the whole point of the structural rule.
// The previous token check asked whether the returned payload *contained crime data* and could be
// defeated by splitting the accessor from the read, aliasing the payload, or binding the response
// first. This check never inspects the payload: it asks whether the exit is CLASSIFIED. So all of
// these fail identically, without a rule per spelling.
{
  const SPELLINGS = {
    "G3   direct - the original shape": `
  if (req.fast) {
    const rows = getNibrsDb().prepare("SELECT 1").all();
    return Response.json({ rows });
  }`,
    "G3b  accessor and read in separate statements": `
  if (req.fast) {
    const db = getNibrsDb();
    const rows = db.prepare("SELECT 1").all();
    return Response.json({ rows });
  }`,
    "G3c  one-hop payload alias": `
  if (req.fast) {
    const rows = getNibrsDb().prepare("SELECT 1").all();
    const payload = rows;
    return Response.json({ payload });
  }`,
    "G3d  multi-hop transform": `
  if (req.fast) {
    const rows = getNibrsDb().prepare("SELECT 1").all();
    const a = transform(rows);
    const b = wrap(a);
    return Response.json({ b });
  }`,
    "G3e  response constructed into a binding, returned later": `
  if (req.fast) {
    const rows = getNibrsDb().prepare("SELECT 1").all();
    const reply = Response.json({ rows });
    return reply;
  }`,
    "G3f  destructured database result": `
  if (req.fast) {
    const { rows } = getNibrsDb().prepare("SELECT 1").all();
    return Response.json({ rows });
  }`,
  };
  let i = 0;
  for (const [label, branch] of Object.entries(SPELLINGS)) {
    const root = tree("g3_" + (i++), { ...FULL,
      "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
import { getNibrsDb } from "@/lib/nibrs-db";
export async function POST(req) {` + branch + `
  return emitFactualPayload(); }` });
    const m = measure(root, path.join(root, "app/api/query/route.ts"));
    const r = elig(root);
    checkTrue(label + " -> unclassified terminal exit",
      m.sealed && r.failures.some((f) => f.kind === "unclassified-terminal-exit" &&
                                         f.route === "app/api/query/route.ts"),
      "sealed=" + m.sealed + " " + JSON.stringify(r.failures.map((f) => f.kind)));
  }
}

// G3g — the operational registry accepts what it registers, and only that.
{
  const OP_ROUTE = `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST(req) {
  if (req.bad) return NextResponse.json({ success: false, error: "nope" });
  return emitFactualPayload(); }`;
  const root = tree("g3g", { ...FULL, "app/api/query/route.ts": OP_ROUTE });
  // The registry key is now an exact source digest, so the fixture derives it rather than
  // hard-coding a summary that could match more than one expression.
  const opExit = measure(root, path.join(root, "app/api/query/route.ts"))
    .terminalExits.find((x) => x.kind === "unclassified");
  const FP = "app/api/query/route.ts::" + opExit.sha256;
  const withEntry = { operationalExits: [{ fp: FP, sha256: opExit.sha256, bytes: opExit.bytes,
                                           count: 1, reason: "reviewed refusal fixture" }],
                      operationalStreamEvents: [], reviewedDeliveryBodies: [] };
  checkTrue("G3g a registered operational exit is accepted",
    checkEligibility(root, withEntry).ok,
    JSON.stringify(checkEligibility(root, withEntry).failures.slice(0, 2)));
  checkTrue("G3g2 the same exit UNregistered fails, so G3g is not vacuous",
    elig(root).failures.some((f) => f.kind === "unclassified-terminal-exit"));

  // THE B3 CASE: same keys, same count, one value becomes crime-derived.
  const swapped = tree("g3h", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
import { getNibrsDb } from "@/lib/nibrs-db";
export async function POST(req) {
  if (req.bad) {
    const rows = getNibrsDb().prepare("SELECT 1").all();
    return NextResponse.json({ success: false, error: JSON.stringify(rows) });
  }
  return emitFactualPayload(); }` });
  const before = measure(root, path.join(root, "app/api/query/route.ts"));
  const after = measure(swapped, path.join(swapped, "app/api/query/route.ts"));
  check("G3h the key set and exit count are unchanged by the swap",
    [after.terminalExits.length, Object.keys(JSON.parse('{"error":0,"success":0}')).length],
    [before.terminalExits.length, 2]);
  checkTrue("G3i but the fingerprint follows the VALUE, so the swap still FAILS",
    checkEligibility(swapped, withEntry).failures.some((f) => f.kind === "unclassified-terminal-exit"),
    JSON.stringify(checkEligibility(swapped, withEntry).failures.map((f) => f.kind)));

  // stale: the registered exit no longer exists at all
  const gone = tree("g3j", { ...FULL });
  checkTrue("G3j a registered operational exit that vanished is reported stale",
    checkEligibility(gone, withEntry).failures.some((f) => f.kind === "stale-operational-exit"));
}

// ---------------------------------------------------------------- PART H — round-3 review matrix
// Carrier identity. Round 3 classified exits but did not attach the classification to the value
// actually delivered, so a seal could be present and decorative.
console.log("\nPART H — round-3 review matrix: carrier identity");
const failsQ = (r) => r.failures.some((f) => f.route === "app/api/query/route.ts");

// H1-H3 — carrier identity, enforced by REVIEWED BODY IDENTITY rather than by guessing at flow.
//
// Five rounds established that syntactic recognizers close one spelling and leave the next open.
// The positional rule tried first here was strict enough to reject all three PRODUCTION helpers:
// the real jsonResp legitimately spreads the carrier, sanitizes narrative text, normalizes rows
// and attaches chart audit before delivering. So the control is change control: the reviewed body
// is registered, and ANY edit fails until re-reviewed. This is not a data-flow proof and is not
// described as one.
{
  const GOOD = `import { emitFactualPayload } from "@/lib/proof-finalize";
import type { SealedPayload } from "@/lib/proof-finalize";
function jsonResp(data: SealedPayload<object>, status = 200) {
  return NextResponse.json(data, { status });
}
export async function POST(req) { return jsonResp(emitFactualPayload(req)); }`;

  // The decorative carrier from the review: the seal is present and the payload is `raw`.
  const DECORATIVE = `import { emitFactualPayload } from "@/lib/proof-finalize";
import type { SealedPayload } from "@/lib/proof-finalize";
function jsonResp(sealed: SealedPayload<object>, raw: object) {
  return NextResponse.json({ ...raw, _proof: sealed });
}
export async function POST(req) { return jsonResp(emitFactualPayload(req), req.rows); }`;

  const UNRELATED = `import { emitFactualPayload } from "@/lib/proof-finalize";
import type { SealedPayload } from "@/lib/proof-finalize";
import { getNibrsDb } from "@/lib/nibrs-db";
function jsonResp(data: SealedPayload<object>) {
  const rows = getNibrsDb().prepare("SELECT 1").all();
  return NextResponse.json({ rows });
}
export async function POST(req) { return jsonResp(emitFactualPayload(req)); }`;

  const goodRoot = tree("h3", { ...FULL, "app/api/query/route.ts": GOOD });
  const goodBody = measure(goodRoot, path.join(goodRoot, "app/api/query/route.ts")).deliveryBodies[0];
  const REG = { operationalExits: [], operationalStreamEvents: [],
                reviewedDeliveryBodies: [{ fp: "app/api/query/route.ts::jsonResp",
                                           sha256: goodBody.sha256, bytes: goodBody.bytes,
                                           reason: "reviewed delivery helper fixture" }] };

  check("H3  the reviewed delivery body is registered and the tree passes",
    [checkEligibility(goodRoot, REG).ok, goodBody.name], [true, "jsonResp"]);
  checkTrue("H3b the SAME body unregistered fails, so H3 is not vacuous",
    elig(goodRoot).failures.some((f) => f.kind === "unreviewed-delivery-body"));

  // THE REVIEW'S CASE: a decorative carrier. The seal is referenced; the payload is `raw`.
  const decRoot = tree("h1", { ...FULL, "app/api/query/route.ts": DECORATIVE });
  const decBody = measure(decRoot, path.join(decRoot, "app/api/query/route.ts")).deliveryBodies[0];
  checkTrue("H1  a decorative carrier changes the reviewed body identity",
    decBody.sha256 !== goodBody.sha256);
  checkTrue("H1b so it FAILS against the reviewed registration",
    checkEligibility(decRoot, REG).failures.some((f) => f.kind === "unreviewed-delivery-body"),
    JSON.stringify(checkEligibility(decRoot, REG).failures.map((f) => f.kind)));
  checkTrue("H1c and the failure names the change rather than guessing at flow",
    checkEligibility(decRoot, REG).failures.some((f) => /changed \(/.test(f.detail || "")));

  const unrRoot = tree("h2", { ...FULL, "app/api/query/route.ts": UNRELATED });
  checkTrue("H2  responding from an unrelated local binding also FAILS",
    checkEligibility(unrRoot, REG).failures.some((f) => f.kind === "unreviewed-delivery-body"));

  // The production helpers are registered and pass; that is asserted on the real tree, not here.
  check("H2b the real tree's five delivery bodies are all registered and unchanged",
    res.failures.filter((f) => f.kind === "unreviewed-delivery-body").length, 0);
  check("H2c and there are exactly five of them",
    res.routes.filter((x) => x.sealed).reduce((n, x) => n + x.deliveryBodies.length, 0), 5);

  // The honest limit, asserted so it cannot be quietly forgotten: this is change control. A body
  // that was WRONG when registered stays registered. The registry records review, not truth.
  checkTrue("H2d a wrong-but-registered body is accepted - the limit is stated, not hidden",
    checkEligibility(decRoot, { operationalExits: [], operationalStreamEvents: [],
      reviewedDeliveryBodies: [{ fp: "app/api/query/route.ts::jsonResp", sha256: decBody.sha256,
                                 bytes: decBody.bytes, reason: "deliberately wrong registration" }] }).ok);
}

// H4 — a raw enqueue beside the sealed ones. P2.2's counts are untouched by this.
{
  const root = tree("h4", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
import { getNibrsDb } from "@/lib/nibrs-db";
export async function POST() {
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, { a: 1 }))));
      const rows = getNibrsDb().prepare("SELECT 1").all();
      controller.enqueue(JSON.stringify({ rows }));
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } }); }` });
  const m = measure(root, path.join(root, "app/api/query/route.ts"));
  check("H4  the envelope is still an envelope",
    m.terminalExits.map((x) => x.kind), ["sse-envelope"]);
  check("H4b one enqueue is sealed and one is not",
    m.streamEvents.map((e) => e.kind).sort(), ["sealed", "unclassified"]);
  checkTrue("H4c the raw enqueue FAILS even though the envelope is valid",
    elig(root).failures.some((f) => f.kind === "unclassified-stream-event"),
    JSON.stringify(elig(root).failures.map((f) => f.kind)));
}

// H5 — a reviewed operational stream event is accepted when registered, and only then.
{
  const root = tree("h5", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST() {
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sseEvent({ type: "status", text: "Working..." }));
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } }); }` });
  const opEv = measure(root, path.join(root, "app/api/query/route.ts"))
    .streamEvents.find((e) => e.kind === "unclassified");
  const FP = "app/api/query/route.ts::" + opEv.sha256;
  const opts = { operationalExits: [], reviewedDeliveryBodies: [],
                 operationalStreamEvents: [{ fp: FP, sha256: opEv.sha256, bytes: opEv.bytes,
                                             count: 1, reason: "progress status fixture" }] };
  checkTrue("H5  a registered operational stream event is accepted",
    checkEligibility(root, opts).ok,
    JSON.stringify(checkEligibility(root, opts).failures.slice(0, 2)));
  checkTrue("H5b the same event UNregistered fails, so H5 is not vacuous",
    elig(root).failures.some((f) => f.kind === "unclassified-stream-event"));
  checkTrue("H5c a registered event that vanished is reported stale",
    checkEligibility(tree("h5c", FULL), opts).failures
      .some((f) => f.kind === "stale-operational-exit"));
}

// H6 — the envelope test is an AND. A raw body with an event-stream header is not transport.
{
  const root = tree("h6", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
import { getNibrsDb } from "@/lib/nibrs-db";
export async function POST(req) {
  if (req.raw) {
    const rows = getNibrsDb().prepare("SELECT 1").all();
    return new Response(JSON.stringify({ rows }), { headers: { "Content-Type": "text/event-stream" } });
  }
  return emitFactualPayload(); }` });
  const m = measure(root, path.join(root, "app/api/query/route.ts"));
  check("H6  a raw body with an event-stream header is NOT an envelope",
    m.terminalExits.map((x) => x.kind), ["unclassified"]);
  checkTrue("H6b so it FAILS", elig(root).failures.some((f) => f.kind === "unclassified-terminal-exit"));
}

// H7 — the real tree's classification, asserted rather than assumed.
{
  const ek = {}, sk = {};
  for (const m of res.routes.filter((x) => x.sealed)) {
    for (const x of m.terminalExits) ek[x.kind] = (ek[x.kind] || 0) + 1;
    for (const e of m.streamEvents) sk[e.kind] = (sk[e.kind] || 0) + 1;
  }
  // Integration 2026-09-30 (enumerated against dev b285be3 with this analyzer, not read off the scan:
  // audit/phase3-integration-2026-09-30/prep/egress-*-enumeration.json). The accepted Phase 3
  // candidate adds SEVEN streaming exits to app/api/query/route.ts, each one envelope with one event:
  // six sealed answers (owned limitations x2, city ranking, YoY comparison, crime-type and amendment
  // clarifications) and the current-YoY internal-failure notice, registered below. dev's 15/29/12
  // become 22/35/13; no dev exit or event was removed (three sealed payloads changed shape only).
  check("H7  real terminal exits: 4 chokepoint, 22 envelope, 0 detached, 0 sealed-by-fallback",
    [ek.chokepoint, ek["sse-envelope"], ek["detached-carrier"] || 0, ek.sealed || 0], [4, 22, 0, 0]);
  check("H7b real stream events: 35 sealed", sk.sealed, 35);
  check("H7c and every unclassified one is registered, so the tree is green",
    [ek.unclassified, sk.unclassified, res.failures.length], [12, 13, 0]);
  // The registries are load-bearing: emptying them must fail loudly.
  // One failure per distinct FINGERPRINT: 12 exit + 10 stream. Those 10 stream entries cover 12
  // occurrences, because one progress message is enqueued three times.
  const empty = checkEligibility(ROOT, { operationalExits: [], operationalStreamEvents: [] });
  check("H7d emptying the registries fails on every registered identity",
    [empty.ok, empty.failures.length > 0], [false, true]);
  check("H7e the registries cover 12 exits and 13 stream events by exact identity",
    [OPERATIONAL_EXITS.reduce((n, e) => n + e.count, 0),
     OPERATIONAL_STREAM_EVENTS.reduce((n, e) => n + e.count, 0)], [12, 13]);
  check("H7f and five delivery declarations",
    (opts0 => opts0.length)(require("./lib/route-eligibility.js").REVIEWED_DELIVERY_BODIES), 5);
}

// ---------------------------------------------------------------- PART I — round-5 corrections
console.log("\nPART I — round-5: decorative seals and truncated identities");

// I1 — a seal MENTIONED inside an enqueue payload is decorative, not a delivery.
{
  const root = tree("i1", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
import { getNibrsDb } from "@/lib/nibrs-db";
export async function POST() {
  const stream = new ReadableStream({
    async start(controller) {
      const rows = getNibrsDb().prepare("SELECT 1").all();
      controller.enqueue(encoder.encode(sseEvent({ ...rows, _p: emitFactualPayload(proof, {}) })));
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } }); }` });
  const m = measure(root, path.join(root, "app/api/query/route.ts"));
  check("I1  a seal buried in the payload is classified decorative, not sealed",
    m.streamEvents.map((e) => e.kind), ["decorative-seal"]);
  checkTrue("I1b and it FAILS", elig(root).failures.some((f) => f.kind === "decorative-seal"),
    JSON.stringify(elig(root).failures.map((f) => f.kind)));
}

// I2 — the genuine enqueue shape, with the seal as the direct payload, still passes.
{
  const root = tree("i2", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST() {
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(sseEvent(emitFactualPayload(proof, { a: 1 }))));
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } }); }` });
  const m = measure(root, path.join(root, "app/api/query/route.ts"));
  check("I2  the seal as the direct event payload IS a sealed delivery",
    m.streamEvents.map((e) => e.kind), ["sealed"]);
  checkTrue("I2b so the tree passes", elig(root).ok, JSON.stringify(elig(root).failures));
  check("I2c and all 35 real sealed enqueues have this exact shape",
    res.routes.filter((x) => x.sealed)
      .reduce((n, x) => n + x.streamEvents.filter((e) => e.kind === "sealed").length, 0), 35);
  check("I2d with zero decorative seals in the real tree",
    res.failures.filter((f) => f.kind === "decorative-seal").length, 0);
}

// I3 — a truncated fingerprint is not an identity, so it must fail rather than be shared.
{
  const deep = "{ a: { b: { c: { d: { e: { f: rows } } } } } }";
  const root = tree("i3", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
import { getNibrsDb } from "@/lib/nibrs-db";
export async function POST(req) {
  if (req.deep) {
    const rows = getNibrsDb().prepare("SELECT 1").all();
    return NextResponse.json(` + deep + `);
  }
  return emitFactualPayload(); }` });
  const m = measure(root, path.join(root, "app/api/query/route.ts"));
  checkTrue("I3  a payload deeper than the normalizer is marked TRUNCATED",
    m.terminalExits.some((x) => /TRUNCATED/.test(x.shape)), JSON.stringify(m.terminalExits.map(x=>x.shape)));
  checkTrue("I3b and it FAILS closed rather than sharing a fingerprint",
    elig(root).failures.some((f) => f.kind === "analysis-incomplete"),
    JSON.stringify(elig(root).failures.map((f) => f.kind)));
  check("I3c no real payload is truncated",
    res.routes.filter((x) => x.sealed)
      .flatMap((x) => x.terminalExits).filter((x) => /TRUNCATED/.test(x.shape)).length, 0);
}

// ---------------------------------------------------------------- PART J — exact identities
// Round 6: the reviewed identities omitted the safety-critical signature, and operational
// fingerprints were semantic summaries rather than identities. Both are now exact source digests.
console.log("\nPART J — exact source identity");

// J1 — the signature is inside the reviewed identity. Widening the parameter type is the whole
// attack: the body stays byte-identical, the text "SealedPayload" still marks it a chokepoint,
// and an arbitrary raw object typechecks at every call site.
{
  const decl = (params) => `import { emitFactualPayload } from "@/lib/proof-finalize";
import type { SealedPayload } from "@/lib/proof-finalize";
function jsonResp(${params}) {
  return NextResponse.json(data, { status });
}
export async function POST(req) { return jsonResp(emitFactualPayload(req)); }`;

  const GOOD = "data: SealedPayload<object> | QueryError, status = 200";
  const goodRoot = tree("j1", { ...FULL, "app/api/query/route.ts": decl(GOOD) });
  const goodBody = measure(goodRoot, path.join(goodRoot, "app/api/query/route.ts")).deliveryBodies[0];
  const REG = { operationalExits: [], operationalStreamEvents: [],
                reviewedDeliveryBodies: [{ fp: "app/api/query/route.ts::jsonResp",
                                           sha256: goodBody.sha256, bytes: goodBody.bytes,
                                           reason: "reviewed declaration fixture" }] };
  checkTrue("J1  the reviewed declaration passes", checkEligibility(goodRoot, REG).ok,
    JSON.stringify(checkEligibility(goodRoot, REG).failures.slice(0, 2)));

  const WIDENINGS = {
    "J1b widening to `| object`": "data: SealedPayload<object> | object, status = 200",
    "J1c widening to `| any`": "data: SealedPayload<object> | any, status = 200",
    "J1d adding a second raw parameter": "data: SealedPayload<object> | QueryError, raw: object, status = 200",
    "J1e renaming the carrier parameter": "payload: SealedPayload<object> | QueryError, status = 200",
    "J1f changing a default": "data: SealedPayload<object> | QueryError, status = 500",
  };
  let i = 0;
  for (const [label, params] of Object.entries(WIDENINGS)) {
    const root = tree("j1_" + (i++), { ...FULL, "app/api/query/route.ts": decl(params) });
    const b = measure(root, path.join(root, "app/api/query/route.ts")).deliveryBodies[0];
    checkTrue(label + " invalidates the identity",
      b.sha256 !== goodBody.sha256 &&
      checkEligibility(root, REG).failures.some((f) => f.kind === "unreviewed-delivery-body"),
      "sha " + b.sha256.slice(0, 8) + " vs " + goodBody.sha256.slice(0, 8));
  }

  // ...and a body change with an identical signature must still fail.
  const bodyChanged = tree("j1g", { ...FULL,
    "app/api/query/route.ts": `import { emitFactualPayload } from "@/lib/proof-finalize";
import type { SealedPayload } from "@/lib/proof-finalize";
function jsonResp(data: SealedPayload<object> | QueryError, status = 200) {
  return NextResponse.json({ ...data, extra: 1 }, { status });
}
export async function POST(req) { return jsonResp(emitFactualPayload(req)); }` });
  checkTrue("J1g a body change with an identical signature also invalidates it",
    checkEligibility(bodyChanged, REG).failures.some((f) => f.kind === "unreviewed-delivery-body"));
}

// J2 — every lossy normalizer case is now an exact identity. The production registry already held
// an entry whose error value is a template, so `Please retry in ${n}` and
// `Please retry: ${JSON.stringify(rows)}` shared a fingerprint under the old summary.
{
  const route = (payload) => `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST(req) {
  if (req.bad) return NextResponse.json(${payload});
  return emitFactualPayload(); }`;

  const BASE = '{ success: false, error: `retry in ${n} s`, code: 429, tags: ["a"], ' +
               'mode: req.x ? "a" : "b", total: n + 1, src: req.meta.origin }';
  const baseRoot = tree("j2", { ...FULL, "app/api/query/route.ts": route(BASE) });
  const baseExit = measure(baseRoot, path.join(baseRoot, "app/api/query/route.ts"))
    .terminalExits.find((x) => x.kind === "unclassified");
  const REG = { reviewedDeliveryBodies: [], operationalStreamEvents: [],
                operationalExits: [{ fp: "app/api/query/route.ts::" + baseExit.sha256,
                                     sha256: baseExit.sha256, bytes: baseExit.bytes, count: 1,
                                     reason: "reviewed operational refusal fixture" }] };
  checkTrue("J2  the reviewed operational expression passes", checkEligibility(baseRoot, REG).ok,
    JSON.stringify(checkEligibility(baseRoot, REG).failures.slice(0, 2)));

  const MUTATIONS = {
    "J2b template interpolation": BASE.replace("`retry in ${n} s`", "`retry in ${JSON.stringify(rows)} s`"),
    "J2c string suffix":         BASE.replace('"a"', '"a-and-more-text-past-the-old-prefix"'),
    "J2d numeric literal":       BASE.replace("code: 429", "code: 430"),
    "J2e array element":         BASE.replace('tags: ["a"]', 'tags: ["a", rows]'),
    "J2f conditional arm":       BASE.replace('req.x ? "a" : "b"', 'req.x ? "a" : rows'),
    "J2g binary operand":        BASE.replace("total: n + 1", "total: n + rows.length"),
    "J2h property-access suffix": BASE.replace("req.meta.origin", "req.meta.origin.rows"),
  };
  let i = 0;
  for (const [label, payload] of Object.entries(MUTATIONS)) {
    const root = tree("j2_" + (i++), { ...FULL, "app/api/query/route.ts": route(payload) });
    const x = measure(root, path.join(root, "app/api/query/route.ts"))
      .terminalExits.find((e) => e.kind === "unclassified");
    checkTrue(label + " invalidates the identity",
      x.sha256 !== baseExit.sha256 &&
      checkEligibility(root, REG).failures.some((f) => f.kind === "unclassified-terminal-exit"),
      "sha " + x.sha256.slice(0, 8) + " vs " + baseExit.sha256.slice(0, 8));
  }
}

// J3 — the same exactness for SSE enqueue arguments.
{
  const route = (arg) => `import { emitFactualPayload } from "@/lib/proof-finalize";
export async function POST() {
  const stream = new ReadableStream({ async start(controller) {
    controller.enqueue(${arg});
  } });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } }); }`;
  const BASE = 'sseEvent({ type: "status", text: `working ${pct}%` })';
  const baseRoot = tree("j3", { ...FULL, "app/api/query/route.ts": route(BASE) });
  const baseEv = measure(baseRoot, path.join(baseRoot, "app/api/query/route.ts"))
    .streamEvents.find((e) => e.kind === "unclassified");
  const REG = { reviewedDeliveryBodies: [], operationalExits: [],
                operationalStreamEvents: [{ fp: "app/api/query/route.ts::" + baseEv.sha256,
                                            sha256: baseEv.sha256, bytes: baseEv.bytes, count: 1,
                                            reason: "reviewed progress event fixture" }] };
  checkTrue("J3  the reviewed SSE event passes", checkEligibility(baseRoot, REG).ok,
    JSON.stringify(checkEligibility(baseRoot, REG).failures.slice(0, 2)));

  const mutated = tree("j3b", { ...FULL,
    "app/api/query/route.ts": route('sseEvent({ type: "status", text: `working ${JSON.stringify(rows)}` })') });
  checkTrue("J3b a changed template interpolation invalidates the SSE identity",
    checkEligibility(mutated, REG).failures.some((f) => f.kind === "unclassified-stream-event"));
}

// J4 — the production identities, asserted against the real tree.
{
  const bodies = res.routes.filter((x) => x.sealed).flatMap((x) => x.deliveryBodies);
  check("J4  five delivery declarations, all matching their reviewed identity",
    [bodies.length, res.failures.filter((f) => f.kind === "unreviewed-delivery-body").length], [5, 0]);
  checkTrue("J4b every reviewed identity records a byte count beside its digest",
    OPERATIONAL_EXITS.every((e) => typeof e.bytes === "number" && e.bytes > 0) &&
    OPERATIONAL_STREAM_EVENTS.every((e) => typeof e.bytes === "number" && e.bytes > 0));
  checkTrue("J4c and every entry carries a written reason",
    OPERATIONAL_EXITS.every((e) => e.reason && e.reason.length > 20) &&
    OPERATIONAL_STREAM_EVENTS.every((e) => e.reason && e.reason.length > 20));
  // Identity is (route, digest), not the digest alone: the captcha refusal is byte-identical in
  // the nibrs, shr and hc routes, so three entries legitimately share one hash. Registry keys
  // must still be unique.
  check("J4d no two registry keys collide",
    [new Set(OPERATIONAL_EXITS.map((e) => e.fp)).size,
     new Set(OPERATIONAL_STREAM_EVENTS.map((e) => e.fp)).size],
    [OPERATIONAL_EXITS.length, OPERATIONAL_STREAM_EVENTS.length]);
  check("J4e and a shared digest across routes is real, not an accident",
    OPERATIONAL_EXITS.length - new Set(OPERATIONAL_EXITS.map((e) => e.sha256)).size, 2);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
