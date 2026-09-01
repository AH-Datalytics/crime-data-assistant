/**
 * P3.1a — the inventory's delivery-helper binding, and the widening chain, end to end.
 *
 * WHAT ROUND 4 FOUND. The inventory recognised the delivery indirection by identifier text alone.
 * A route could declare its own `function capabilityFinalizationOutcome()`, or import that name
 * from a different module, and the inventory would hand it the canonical helper's derived reason —
 * turning an exact reviewed carrier into an allowlisted spelling, which is the class of escape
 * P2.5's source-identity work exists to close.
 *
 * It also found that R2l proved only half a chain: that the resolver returns two reasons when the
 * helper widens. It did not prove that two reasons actually make the four sites `parallel` and that
 * `parallel` actually fails the existing guard. Two individually tested halves becoming
 * disconnected is a failure this workstream has produced more than once.
 *
 * So this suite proves both, against the REAL inventory rather than a helper-specific unit
 * assertion:
 *
 *   B1-B5  a shadow, a wrong-module import, and an alias each stop the sites resolving, and the
 *          coverage criterion the real guard applies then reports `query_contract_failed` as
 *          vocabulary nobody produces. Run through `buildInventory()` on a throwaway tree.
 *   W1-W5  the canonical carrier type is widened IN THE REAL TREE, the existing T7b guard is run in
 *          a FRESH PROCESS and must fail, the source is restored and verified by sha256, and the
 *          guard must return to green.
 *
 * The widening mutation edits a production file and restores it. That is the established pattern in
 * this repo (`test-outcome-mutations.js`), and restoration is proved by hash, not by assumption.
 *
 * Deterministic. No database, no model, no network, no production service.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

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
const inventory = require("./lib/exit-inventory.js") as {
  buildInventory: (root: string) => {
    decisionSites: { file: string; line: number; outcome: any }[];
    embed: { sites: { outcome: any }[] };
  };
  ROUTE_FILES: { rel: string }[];
  EMBED_FILE: { rel: string };
  DELIVERY_HELPERS: Record<string, { rel: string; module: string; carrierType: string }>;
  deliveryHelperBinding: (sf: unknown, ts: unknown, name: string, spec: unknown) => string;
};
const HELPER = "capabilityFinalizationOutcome";
const SPEC = inventory.DELIVERY_HELPERS[HELPER];
const VALIDATOR = path.join(ROOT, SPEC.rel);
const sha256Of = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/**
 * A throwaway tree the real inventory can be pointed at: the files it reads, plus a shim so
 * `loadTypeScript(root)` resolves. A shim rather than a symlink because directory symlinks need
 * privileges on Windows that a test must not assume.
 */
function makeTree(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p31a-bind-"));
  const rels = [...inventory.ROUTE_FILES.map((r) => r.rel), inventory.EMBED_FILE.rel, SPEC.rel];
  for (const rel of rels) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
  const shim = path.join(tmp, "node_modules", "typescript");
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, "package.json"), JSON.stringify({ name: "typescript", main: "index.js" }));
  fs.writeFileSync(path.join(shim, "index.js"),
    `module.exports = require(${JSON.stringify(path.join(ROOT, "node_modules", "typescript"))});\n`);
  return tmp;
}

/** The four contract-failure sites, as the real inventory resolves them in a given tree. */
function deliveredSites(root: string) {
  return inventory.buildInventory(root).decisionSites.filter((s) =>
    String(s.outcome.via ?? "").includes(HELPER) || String(s.outcome.text ?? "").includes(HELPER));
}

/** Exactly the criterion `test-outcome-coverage` applies: which reasons anything can produce. */
function producibleReasons(root: string): Set<string> {
  const inv = inventory.buildInventory(root);
  const used = new Set<string>();
  for (const s of inv.decisionSites) {
    if (s.outcome.reason) used.add(s.outcome.reason);
    if (s.outcome.whenTrue) used.add(s.outcome.whenTrue);
    if (s.outcome.whenFalse) used.add(s.outcome.whenFalse);
  }
  for (const s of inv.embed.sites) {
    if (s.outcome.whenTrue) used.add(s.outcome.whenTrue);
    if (s.outcome.whenFalse) used.add(s.outcome.whenFalse);
  }
  return used;
}

function editRoutes(root: string, edit: (src: string) => string) {
  for (const r of inventory.ROUTE_FILES) {
    const f = path.join(root, r.rel);
    fs.writeFileSync(f, edit(fs.readFileSync(f, "utf8")));
  }
}

// ── B — binding: a same-named thing is not the reviewed carrier ─────────────────────────────
console.log("B — the inventory binds by declaration, not by spelling");
{
  const baseline = makeTree();
  try {
    check("B1  baseline - all four sites resolve to the canonical reason in a copied tree",
      deliveredSites(baseline).map((s) => `${s.outcome.form}:${s.outcome.reason}`),
      Array(4).fill("literal:query_contract_failed"));
    checkTrue("B1b and the coverage criterion sees the reason as producible",
      producibleReasons(baseline).has("query_contract_failed"));
  } finally { fs.rmSync(baseline, { recursive: true, force: true }); }

  const scenarios: { name: string; edit: (src: string) => string; expect: RegExp }[] = [
    {
      name: "a same-named LOCAL function shadowing the import",
      edit: (src) => src.replace(
        /^import /m,
        `function ${HELPER}(_r: any) { return OUTCOMES.guardrail_block; }\nimport `),
      expect: /locally declared/,
    },
    {
      name: "a same-named import from ANOTHER module",
      edit: (src) => src
        .replace(new RegExp(`^\\s*${HELPER},\\s*$`, "m"), "")
        .replace(/^import /m, `import { ${HELPER} } from "@/lib/proof-contract";\nimport `),
      expect: /imported from/,
    },
    {
      name: "an ALIASED import of the canonical helper",
      edit: (src) => src.replace(
        new RegExp(`^(\\s*)${HELPER},\\s*$`, "m"),
        `$1somethingElse as ${HELPER},`),
      expect: /aliased import/,
    },
  ];

  for (const sc of scenarios) {
    const tree = makeTree();
    try {
      editRoutes(tree, sc.edit);
      const sites = deliveredSites(tree);
      check(`B  ${sc.name}: all four sites stop resolving`,
        sites.map((s) => s.outcome.form), Array(4).fill("other"));
      checkTrue(`B  ${sc.name}: and the inventory says why`,
        sites.every((s) => sc.expect.test(String(s.outcome.text ?? ""))),
        sites.map((s) => s.outcome.text).join(" | "));
      checkTrue(`B  ${sc.name}: the REAL guard criterion then reports the reason unproducible`,
        !producibleReasons(tree).has("query_contract_failed"));
    } finally { fs.rmSync(tree, { recursive: true, force: true }); }
  }

  // Localisation: shadowing ONE route must break exactly that one, not all four.
  const one = makeTree();
  try {
    const target = path.join(one, inventory.ROUTE_FILES[0].rel);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(
      /^import /m, `function ${HELPER}(_r: any) { return OUTCOMES.guardrail_block; }\nimport `));
    const forms = deliveredSites(one).map((s) => s.outcome.form).sort();
    check("B5  shadowing one route breaks exactly that route",
      forms, ["literal", "literal", "literal", "other"]);
  } finally { fs.rmSync(one, { recursive: true, force: true }); }

  check("B6  the allowlist is still exactly one reviewed indirection",
    Object.keys(inventory.DELIVERY_HELPERS), [HELPER]);
  check("B7  and it pins the module it must be imported from",
    [SPEC.module, SPEC.rel, SPEC.carrierType],
    ["@/lib/query-contract-validator", "lib/query-contract-validator.ts", "CapabilityBlockOutcome"]);
}

// ── W — the widening chain, end to end, in a fresh process ──────────────────────────────────
console.log("\nW — widening the carrier fails the existing T7b guard, and restoration returns it");
{
  const GUARD = "scripts/test-outcome-inventory.ts";
  const runGuard = () => {
    try {
      execFileSync("npx", ["tsx", GUARD], {
        cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
      });
      return { code: 0, out: "" };
    } catch (e: any) {
      return { code: typeof e.status === "number" ? e.status : -1,
               out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  const before = sha256Of(VALIDATOR);
  const original = fs.readFileSync(VALIDATOR);

  const green = runGuard();
  check("W1  baseline - the existing guard passes on the unmodified tree", green.code, 0);

  let widened = { code: -1, out: "" };
  let sitesUnderMutation: string[] = [];
  try {
    // Widen the CARRIER TYPE - the half whose derivation was silently reading nothing until round
    // 3's control caught it. Two reasons must make every delivered site `parallel`.
    const src = original.toString("utf8");
    const decl = `export type ${SPEC.carrierType} = typeof OUTCOMES.query_contract_failed | null;`;
    if (!src.includes(decl)) throw new Error("carrier type declaration not found: " + decl);
    fs.writeFileSync(VALIDATOR, src.replace(decl,
      `export type ${SPEC.carrierType} = typeof OUTCOMES.query_contract_failed | ` +
      "typeof OUTCOMES.guardrail_block | null;"));

    sitesUnderMutation = deliveredSites(ROOT).map((s) => s.outcome.form);
    widened = runGuard();
  } finally {
    fs.writeFileSync(VALIDATOR, original);
  }

  check("W2  a widened carrier makes all four delivered sites parallel",
    sitesUnderMutation, Array(4).fill("parallel"));
  checkTrue("W3  and the existing T7b guard FAILS in a fresh process", widened.code !== 0,
    `exit ${widened.code}`);
  checkTrue("W3b naming T7b as the assertion that caught it",
    /T7b|parallel/.test(widened.out), widened.out.slice(0, 200));

  check("W4  the production file is restored byte-for-byte", sha256Of(VALIDATOR), before);
  const restored = runGuard();
  check("W5  and the guard is green again", restored.code, 0);
  check("W5b with all four sites resolving as before",
    deliveredSites(ROOT).map((s) => `${s.outcome.form}:${s.outcome.reason}`),
    Array(4).fill("literal:query_contract_failed"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
