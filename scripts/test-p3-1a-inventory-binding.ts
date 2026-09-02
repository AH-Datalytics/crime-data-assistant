/**
 * P3.1a — the inventory's delivery-helper binding, and the widening chain, end to end.
 *
 * WHAT ROUND 4 FOUND. The inventory recognised the delivery indirection by identifier text alone. A
 * route could declare its own `function capabilityFinalizationOutcome()`, or import that name from
 * a different module, and the inventory would hand it the canonical helper's derived reason —
 * turning an exact reviewed carrier into an allowlisted spelling, which is the class of escape
 * P2.5's source-identity work exists to close.
 *
 * WHAT ROUND 5 FOUND. Two things. A type-only import (`import type { x }` or `import { type x }`)
 * still satisfied the binding check although it creates no runtime value binding at all — the
 * inventory was implicitly relying on typechecking, a separate gate that a suppression comment can
 * silence. And the widening control rewrote the real `lib/query-contract-validator.ts` in the
 * SHARED checkout: hash-verified restoration only holds if the process reaches the restore, which
 * says nothing about a killed process, a concurrent reader, or two harness runs racing the path.
 *
 * So:
 *
 *   B1–B9  every non-canonical form — a local shadow, a wrong-module import, an alias, and both
 *          type-only spellings — stops the sites resolving, and the criterion the real coverage
 *          guard applies then reports `query_contract_failed` as vocabulary nobody produces. Run
 *          through `buildInventory()` on complete throwaway trees, never against the resolver
 *          in isolation.
 *   W1–W8  the widening chain, executed inside an INDEPENDENT CLONE: `git clone --no-hardlinks`
 *          into an OS temp directory, checked out detached at the exact commit this invocation is
 *          running from. The clone has its own refs, index, config and object store, so `status`
 *          and `diff --numstat` can measure the declared mutation without any shared namespace
 *          being involved. The carrier type is widened ONLY in that clone; the actual T7b guard
 *          runs against that isolated root in a fresh process; teardown deletes the temp directory
 *          and nothing else. The shared checkout's production file is hashed before and after
 *          purely to ASSERT it was never touched — never as a restore mechanism, because it is
 *          never written.
 *
 * WHAT ROUND 6 FOUND. An earlier version used `git worktree add`, which writes registration state
 * into the SOURCE repository's common `.git/worktrees`, and called a repository-wide
 * `git worktree prune` that could act on stale records this test does not own. A unique filesystem
 * path does not make the shared Git metadata unique. `git clone` only READS the source repository,
 * and the clone's metadata is its own — so an interrupted run leaves nothing but a temp directory,
 * and nothing this suite does can affect another checkout or another harness run. The only
 * `git worktree` verb that survives anywhere here is the read-only `list`, used as evidence in W6.
 *
 * NOT `git archive` PIPED TO `tar`. The `tar` on PATH in this environment is GNU tar, which reads a
 * `C:\...` argument as a remote host spec and fails with "Cannot connect to C: resolve failed". A
 * control whose result depends on which `tar` is installed fails for a reason unrelated to the
 * property it tests.
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
};
const HELPER = "capabilityFinalizationOutcome";
const SPEC = inventory.DELIVERY_HELPERS[HELPER];
const SHARED_VALIDATOR = path.join(ROOT, SPEC.rel);
const sha256Of = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/** The shared checkout's production file, hashed up front. Nothing here may change it. */
const SHARED_VALIDATOR_SHA_BEFORE = sha256Of(SHARED_VALIDATOR);

/**
 * Give a disposable root the modules it needs, as REAL re-export stubs. Never a link.
 *
 * `loadTypeScript(root)` resolves `<root>/node_modules/typescript` by explicit path, and the guard
 * reaches `scripts/migrate-query-log-proof.js`, which requires `better-sqlite3` — resolved by
 * Node walking up from the file, so a stub at the disposable root satisfies it.
 *
 * WHY NOT A JUNCTION TO THE REAL node_modules. That is what this suite did first, and it caused
 * real damage: the teardown's recursive delete followed the junction and removed `node_modules/.bin`
 * and 22 packages from the shared checkout. Sequencing the unlink before the delete would close
 * that particular window and leave another one open — a process killed between creating the link
 * and removing it. A tree that contains no link cannot be escaped from at all, so there is nothing
 * to sequence and nothing to get wrong.
 *
 * A missing module is not silently tolerated: the W2 baseline requires the unmutated guard to PASS
 * against the disposable root, so an unstubbed dependency shows up as a failing baseline rather
 * than as a widening control that "passed" for the wrong reason.
 */
const STUBBED_MODULES = ["typescript", "better-sqlite3"];

function installModuleStubs(root: string, names: string[] = STUBBED_MODULES) {
  for (const name of names) {
    const dir = path.join(root, "node_modules", ...name.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"),
      JSON.stringify({ name, version: "0.0.0-stub", main: "index.js" }));
    fs.writeFileSync(path.join(dir, "index.js"),
      `module.exports = require(${JSON.stringify(path.join(ROOT, "node_modules", name))});\n`);
  }
}

/** A throwaway copy of just the files the inventory reads. Used for the B-series edits. */
function makeTree(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p31a-bind-"));
  const rels = [...inventory.ROUTE_FILES.map((r) => r.rel), inventory.EMBED_FILE.rel, SPEC.rel];
  for (const rel of rels) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
  installModuleStubs(tmp, ["typescript"]);
  return tmp;
}

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

/** Drop the canonical name from the route's existing value import list. */
const dropFromValueImport = (src: string) =>
  src.replace(new RegExp(`^\\s*${HELPER},\\s*$`, "m"), "");

// ── B — binding: only the exact reviewed form is the reviewed carrier ───────────────────────
console.log("B — the inventory binds by declaration, not by spelling");
{
  const baseline = makeTree();
  try {
    check("B1  baseline - a plain value import resolves all four sites",
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
      edit: (src) => dropFromValueImport(src).replace(
        /^import /m, `import { ${HELPER} } from "@/lib/proof-contract";\nimport `),
      expect: /imported from/,
    },
    {
      name: "an ALIASED import of the canonical helper",
      edit: (src) => src.replace(
        new RegExp(`^(\\s*)${HELPER},\\s*$`, "m"), `$1somethingElse as ${HELPER},`),
      expect: /aliased import/,
    },
    {
      // Round 5: erased at emit, so there is no runtime value to call.
      name: "a whole-clause TYPE-ONLY import",
      edit: (src) => dropFromValueImport(src).replace(
        /^import /m,
        `import type { ${HELPER} } from "${SPEC.module}";\nimport `),
      expect: /type-only import/,
    },
    {
      name: "a per-specifier TYPE-ONLY import",
      edit: (src) => src.replace(
        new RegExp(`^(\\s*)${HELPER},\\s*$`, "m"), `$1type ${HELPER},`),
      expect: /type-only import/,
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

  // Localisation: breaking ONE route must break exactly that one.
  const one = makeTree();
  try {
    const target = path.join(one, inventory.ROUTE_FILES[0].rel);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(
      new RegExp(`^(\\s*)${HELPER},\\s*$`, "m"), `$1type ${HELPER},`));
    check("B8  a type-only import in one route breaks exactly that route",
      deliveredSites(one).map((s) => s.outcome.form).sort(),
      ["literal", "literal", "literal", "other"]);
  } finally { fs.rmSync(one, { recursive: true, force: true }); }

  check("B9  the allowlist is still exactly one reviewed indirection, fully pinned",
    [Object.keys(inventory.DELIVERY_HELPERS), SPEC.module, SPEC.rel, SPEC.carrierType],
    [[HELPER], "@/lib/query-contract-validator", "lib/query-contract-validator.ts",
     "CapabilityBlockOutcome"]);
}

// ── W — the widening chain, entirely inside an independent clone ────────────────────────────
console.log("\nW — widening fails the existing T7b guard, inside an independent clone");
{
  const git = (args: string[], cwd = ROOT) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  /** Run the ACTUAL guard against a given root, in a fresh process. */
  const runGuardAt = (root: string) => {
    const script = path.join(root, "scripts", "test-outcome-inventory.ts");
    try {
      const out = execFileSync("npx", ["tsx", script], {
        cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
      });
      return { code: 0, out };
    } catch (e: any) {
      return { code: typeof e.status === "number" ? e.status : -1,
               out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p31a-widen-"));
  const disposable = path.join(tmpRoot, "tree");

  // The source repository's worktree registry, captured to prove this test never alters it.
  const worktreesBefore = git(["worktree", "list"]);

  try {
    // An INDEPENDENT CLONE. `git clone` only reads the source repository - it writes no refs, no
    // config, and nothing under .git/worktrees - and the result carries its own metadata, so
    // `status` and `diff --numstat` can measure the declared mutation without any shared namespace
    // being involved. `--no-hardlinks` keeps the object stores separate on disk as well.
    //
    // Not `git archive` piped to tar: the tar on PATH here is GNU tar, which reads a `C:\...`
    // argument as a remote host spec and fails with "Cannot connect to C:". A control that depends
    // on which tar is installed is a control that will fail for a reason unrelated to the property.
    //
    // core.autocrlf=false so the checkout records the committed bytes rather than a re-encoding,
    // which would make every file look modified and hide the single change this is looking for.
    const headSha = git(["rev-parse", "HEAD"]);
    execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--no-hardlinks",
                         ROOT, disposable], { encoding: "utf8" });
    const tgit = (args: string[]) =>
      execFileSync("git", ["-c", "core.autocrlf=false", ...args],
        { cwd: disposable, encoding: "utf8" }).trim();
    tgit(["checkout", "--quiet", "--detach", headSha]);

    installModuleStubs(disposable);

    check("W1  the independent clone is at the exact candidate commit, with nothing modified",
      [tgit(["rev-parse", "HEAD"]), tgit(["status", "--porcelain"])], [headSha, ""]);
    check("W1b and its validator is byte-identical to the shared checkout's",
      sha256Of(path.join(disposable, SPEC.rel)), SHARED_VALIDATOR_SHA_BEFORE);

    const green = runGuardAt(disposable);
    check("W2  baseline - the actual T7b guard passes against the isolated root", green.code, 0);
    check("W2b and all four sites resolve to exactly one reason there",
      deliveredSites(disposable).map((s) => `${s.outcome.form}:${s.outcome.reason}`),
      Array(4).fill("literal:query_contract_failed"));

    // The one declared mutation: widen the carrier type. This is the half whose derivation was
    // silently reading nothing until round 3's control caught it.
    const target = path.join(disposable, SPEC.rel);
    const src = fs.readFileSync(target, "utf8");
    const decl = `export type ${SPEC.carrierType} = typeof OUTCOMES.query_contract_failed | null;`;
    if (!src.includes(decl)) throw new Error("carrier type declaration not found: " + decl);
    fs.writeFileSync(target, src.replace(decl,
      `export type ${SPEC.carrierType} = typeof OUTCOMES.query_contract_failed | ` +
      "typeof OUTCOMES.guardrail_block | null;"));

    // `git()` trims, so the porcelain status arrives without its leading unstaged-column space.
    check("W3  the tree now differs by exactly one file",
      tgit(["status", "--porcelain"]), `M ${SPEC.rel}`);
    const diff = tgit(["diff", "--numstat"]);
    check("W3b and by exactly one changed line", diff, `1\t1\t${SPEC.rel}`);

    check("W4  a widened carrier makes all four delivered sites parallel",
      deliveredSites(disposable).map((s) => s.outcome.form), Array(4).fill("parallel"));

    const widened = runGuardAt(disposable);
    checkTrue("W5  the actual T7b guard FAILS against the widened isolated root",
      widened.code !== 0, `exit ${widened.code}`);
    // T7b reports site FINGERPRINTS, not the helper's name. Assert on what it actually prints: its
    // own message, and all four contract-failure sites now carrying `::parallel`.
    // DISTINCT fingerprints: Node prints the actual array twice (once in the diff, once in the
    // `actual:` dump), so counting occurrences reads 8 for four sites.
    const fingerprints = [...new Set(
      (widened.out.match(/'[a-z-]+::POST[^']*::parallel'/g) || []).map((f) => f.slice(1, -1)))];
    checkTrue("W5b failing at T7b, naming all four contract-failure sites as parallel",
      /whole OUTCOMES constants/.test(widened.out) && fingerprints.length === 4 &&
      fingerprints.some((f) => f.includes("emitContractFailure")) &&
      fingerprints.filter((f) => f.includes("contractFailureResponse")).length === 3,
      `${fingerprints.length} distinct: ${fingerprints.join(" | ").slice(0, 300)}`);
  } finally {
    // Nothing here is a link, so a recursive delete cannot escape the temp directory. Asserted
    // rather than assumed, because an earlier version of this suite DID use a junction and its
    // teardown deleted node_modules/.bin and 22 packages out of the shared checkout.
    const nm = path.join(disposable, "node_modules");
    if (fs.existsSync(nm) && fs.lstatSync(nm).isSymbolicLink()) {
      fail++; console.log("  FAIL  teardown: the disposable tree contains a link; refusing to delete");
      fs.unlinkSync(nm);
    }
    // Deleting an independently rooted temp directory is the whole teardown. There is no
    // registration to remove and no repository-wide prune to run.
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // The teardown leaves nothing behind, on disk OR in the source repository's Git metadata.
  check("W6  the source repository's worktree registry is unchanged",
    git(["worktree", "list"]), worktreesBefore);
  check("W6b no p31a worktree was ever registered",
    git(["worktree", "list"]).split("\n").filter((l) => l.includes("p31a-")).length, 0);
  check("W6c the temp directory is gone", fs.existsSync(tmpRoot), false);
  check("W6d and the repository's real node_modules is untouched",
    [fs.existsSync(path.join(ROOT, "node_modules", "typescript")),
     fs.existsSync(path.join(ROOT, "node_modules", "better-sqlite3")),
     fs.existsSync(path.join(ROOT, "node_modules", ".bin"))],
    [true, true, true]);

  // The point of the whole restructuring: the shared checkout was never written, so there is
  // nothing to restore and nothing a killed process could have left behind.
  check("W7  the SHARED checkout's production file was never modified",
    sha256Of(SHARED_VALIDATOR), SHARED_VALIDATOR_SHA_BEFORE);
  check("W8  and the shared checkout still resolves all four sites",
    deliveredSites(ROOT).map((s) => `${s.outcome.form}:${s.outcome.reason}`),
    Array(4).fill("literal:query_contract_failed"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
