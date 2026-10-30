/**
 * Route eligibility closure for typed-outcome coverage (P2.5).
 *
 * WHAT P2.2 PROVED, AND WHAT IT DID NOT.
 * `scripts/lib/exit-inventory.js` proves that every terminal factual exit *inside five named
 * files* is sealed and that the row it writes carries the outcome — 96 decision sites, 96 sealed,
 * 0 unsealed, 0 unpaired on the deployed tree. That is a complete proof of an incomplete
 * question: the five files are a hard-coded constant. A new route that answered questions without
 * sealing would not appear in the inventory at all, and every existing assertion would still
 * pass. Coverage measured over a hand-picked denominator is not coverage.
 *
 * This module closes the denominator: every route handler must be either SEALED or explicitly
 * EXCLUDED, and each exclusion's factual claims are verified against the source. A justification
 * that asserts something the code contradicts fails the build.
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────────────────────────
 *
 * The governing asymmetry: a false positive forces a human to look; a false negative silently
 * reopens the denominator. Everywhere the analysis cannot see, it must say so and FAIL, never
 * shrug and report success. Two earlier versions of this file violated that and were rejected in
 * review:
 *
 *   - a fixed traversal depth of 3 stopped walking and returned success, so a four-hop delegation
 *     was certified on incomplete evidence. The walk now runs to completion over a visited set,
 *     and an exhausted module budget is a FAILURE, not a truncation.
 *   - `resolveImport` guarded every candidate with `if (ext && ...)`, so the empty-extension
 *     candidate — the only one that resolves an explicit `./helper.js` — was skipped, and it
 *     probed `helper.js.ts` instead. Explicit-extension imports of factual helpers resolved to
 *     nothing and were read as absence.
 *   - barrel re-exports (`export ... from`) and literal dynamic loads were invisible entirely.
 *   - the access-layer skip was a regular expression over basenames, so a future factual helper
 *     named `crime-db.ts` would have been skipped because of what it was called.
 *
 * A second review found five more, all variations on one wrong idea -- that a SEALED route is
 * self-certifying. `sealed` means the file contains one of three primitive names. It says nothing
 * about a path the analysis never saw, or a delivery that never touched a seal:
 *
 *   - incompleteness was ignored on sealed routes, so a sealed route with a non-literal dynamic
 *     load was certified. Incompleteness now fails closed for EVERY route.
 *   - a sealed route could delegate terminal delivery to a helper outside the five inventoried
 *     files, where nothing proves sealing or pairing. Reached helpers may compute and return data;
 *     constructing a response is now a named `delegated-response-exit` failure.
 *   - a sealed route could keep every existing finalization -- leaving the pinned 96-site
 *     inventory unchanged -- and add one raw `Response.json({ rows })` branch beside them.
 *   - a bindless side-effect import could never be selected by a handler-reference test, so it was
 *     skipped rather than followed.
 *   - a selected local specifier that failed to resolve was read as absence.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Route-module extensions Next.js accepts. `pageExtensions` can widen this, so
 * `assertRouteExtensionAssumption()` fails if the repository ever customizes it, rather than
 * letting this list silently depend on a config the guard never reads.
 */
const ROUTE_BASENAMES = ["route.ts", "route.tsx", "route.js", "route.jsx", "route.mjs", "route.cjs"];
const CODE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Read accessors for the four crime databases. `getWriteDb` is deliberately NOT here: it is the
 *  write handle, and treating it as evidence of a factual read is what produced the original
 *  false positives on `track` and `chart-render-receipt`. */
const CRIME_DB_READERS = ["getNibrsDb", "getShrDb", "getHateCrimeDb", "getDb"];
const SEAL_PRIMITIVES = ["emitFactualPayload", "finalizeExit", "finalizeProof"];
const READ_OPS = [".all(", ".get(", ".iterate(", ".pluck("];
const WRITE_OPS = ["INSERT", "UPDATE", "DELETE", "REPLACE"];
const HTTP_HANDLERS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * The access layer, as an EXACT reviewed allowlist rather than a name pattern.
 *
 * These modules are not traversed because their accessor calls are already measured at the call
 * site. Descending into them would match the accessor criterion against an
 * `export function getDb(...)` DEFINITION and report every route that touches the access layer as
 * a crime-data reader — `track`, which only ever writes, included — destroying the write-only
 * controls this guard is required to retain.
 *
 * This was previously a regular expression matching any basename containing `-db`. That is a
 * naming convention, not an identity boundary: a future factual helper called `crime-db.ts` would
 * have been skipped silently. `validateAccessLayer()` fails on any entry that no longer exists,
 * so the list cannot rot, and nothing is skipped merely because of what it is named.
 */
const ACCESS_LAYER = [
  "lib/rtci-db.ts",
  "lib/nibrs-db.ts",
  "lib/shr-db.ts",
  "lib/hc-db.ts",
  "lib/sqlite-db.ts",
];

/**
 * Response constructors. A helper that builds one of these is making a terminal delivery, which
 * is the thing the typed-outcome inventory exists to cover.
 */
const RESPONSE_CTORS = /new NextResponse\b|NextResponse\.json\b|new Response\b|Response\.json\b/;

/**
 * Reached helpers permitted to construct a response, with machine-checked claims.
 *
 * EMPTY ON PURPOSE. Measured across the deployed tree: 115 distinct helper modules are reached
 * from the twelve routes and NONE constructs a response. Terminal delivery happens in the route
 * files, which is exactly the invariant that makes the five-file exit inventory meaningful. An
 * entry here would be a deliberate, reviewed hole, so the list starts empty and any new delegated
 * response exit fails until someone justifies it.
 */
const HELPER_RESPONSE_ALLOWLIST = [];

/** Module budget per route. Exhausting it FAILS CLOSED; it never truncates and reports success. */
const MAX_MODULES = 400;

function loadTs(root) {
  // Prefer the tree under analysis, but fall back to this process's own typescript so the
  // throwaway fixtures in the test suite need no node_modules of their own. Symlinking one per
  // fixture was not portable: a Windows junction is not creatable on the CI runner.
  try { return require(path.join(root, "node_modules", "typescript")); }
  catch { return require("typescript"); }
}

/** The route-extension list is only sound while `pageExtensions` is untouched. */
function assertRouteExtensionAssumption(root) {
  for (const name of ["next.config.ts", "next.config.js", "next.config.mjs"]) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    if (/pageExtensions/.test(fs.readFileSync(p, "utf8"))) {
      return { ok: false, detail: name + " customizes pageExtensions; ROUTE_BASENAMES may no longer be complete" };
    }
  }
  return { ok: true, detail: null };
}

/**
 * Validate the PROPERTY that justifies skipping each leaf, not merely that the path exists.
 *
 * Existence-only validation does not prove a leaf is still definition-only. The justification for
 * skipping is narrow: the module DEFINES the crime-database accessors, so walking into it would
 * match the accessor-call criterion against a definition. The checkable invariant is therefore:
 *
 *   a leaf must define at least one crime-database accessor, AND must construct no response.
 *
 * Note the invariant is deliberately NOT "performs no read operation". `lib/nibrs-db.ts` legitimately
 * reads inside the access layer; that is what an access layer does. Reading is not what makes
 * skipping safe — being the definition site of the accessors is.
 *
 * The three proof modules (`proof-finalize`, `proof-contract`, `proof-modes`) were previously on
 * this list and define no accessor at all, so they never satisfied the rationale. They are removed
 * and are now traversed like any other helper.
 */
function validateAccessLayer(root) {
  const missing = [];
  const violations = [];
  for (const rel of ACCESS_LAYER) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) { missing.push(rel); continue; }
    const src = fs.readFileSync(p, "utf8");
    if (!/export\s+(async\s+)?function\s+get\w*Db\b/.test(src)) {
      violations.push(rel + ": defines no crime-database accessor, so leaf status is unjustified");
    }
    if (RESPONSE_CTORS.test(src)) {
      violations.push(rel + ": constructs an HTTP response, so it is a delivery site, not a leaf");
    }
  }
  return { ok: missing.length === 0 && violations.length === 0, missing, violations };
}

/**
 * Resolve a local import. The EXACT path is tried FIRST — that is the fix for explicit-extension
 * imports such as `./helper.js`, which the previous version could never resolve.
 */
function resolveImport(root, fromFile, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return null;
  // ALWAYS absolute. The access-layer allowlist is compared by resolved path, and when the guard
  // is invoked with a relative root ("." is what the harness uses) a relative return value never
  // matched the absolute allowlist entries — so lib/rtci-db.ts was walked into after all, and
  // every route touching the access layer measured as a crime-data reader.
  const base = spec.startsWith("@/")
    ? path.resolve(root, spec.slice(2))
    : path.resolve(path.dirname(path.resolve(fromFile)), spec);
  const hit = (c) => fs.existsSync(c) && fs.statSync(c).isFile();
  if (hit(base)) return base;
  for (const ext of CODE_EXT) if (hit(base + ext)) return base + ext;
  for (const ext of CODE_EXT) {
    const c = path.join(base, "index" + ext);
    if (hit(c)) return c;
  }
  return null;
}

/**
 * Every local module-loading form in one file.
 *
 *   named     - specifier to the local names it binds (static imports)
 *   reexports - `export ... from "x"` targets. A barrel re-exporting a factual helper used to
 *               stop the walk dead at the barrel.
 *   dynamic   - literal `import("x")` / `require("x")`
 *   opaque    - non-literal dynamic loads. Reported as analysis-incomplete rather than silently
 *               treated as absence.
 */
function moduleLoads(sf, ts) {
  const named = new Map();
  const reexports = [];
  const dynamic = [];
  const opaque = [];
  const add = (spec, name) => {
    if (!named.has(spec)) named.set(spec, new Set());
    if (name) named.get(spec).add(name);
  };
  const walk = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      add(spec, null);
      const c = n.importClause;
      if (c) {
        if (c.name) add(spec, c.name.text);
        if (c.namedBindings) {
          if (ts.isNamedImports(c.namedBindings)) {
            for (const e of c.namedBindings.elements) add(spec, e.name.text);
          } else if (ts.isNamespaceImport(c.namedBindings)) {
            add(spec, c.namedBindings.name.text);
          }
        }
      }
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      reexports.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n)) {
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      const isDynamic = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamic) {
        const a = n.arguments[0];
        if (a && ts.isStringLiteral(a)) dynamic.push(a.text);
        else if (a) opaque.push(a.getText(sf).slice(0, 60));
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return { named, reexports, dynamic, opaque };
}

/** Identifiers referenced inside the exported HTTP handlers only. */
function identifiersInHandlers(sf, ts) {
  const ids = new Set();
  const collect = (n) => { if (ts.isIdentifier(n)) ids.add(n.text); ts.forEachChild(n, collect); };
  const walk = (n) => {
    const exported = n.modifiers && n.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isFunctionDeclaration(n) && n.name && HTTP_HANDLERS.has(n.name.text) && n.body) {
      collect(n.body);
    }
    if (exported && ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && HTTP_HANDLERS.has(d.name.text) && d.initializer) collect(d.initializer);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return ids;
}

/**
 * Modules reachable from a route's exported handlers.
 *
 * THIS IS A CONSERVATIVE REACHABLE-MODULE OVER-APPROXIMATION, NOT A CALL GRAPH. An earlier
 * version of this file called it a call graph; that claim is withdrawn.
 *
 * At the ROUTE the walk is precise: only modules whose imported names the handlers actually
 * reference are entered. That precision is what keeps `track` and `chart-render-receipt` from
 * being flagged factual because something forty modules away touches a database, which is what
 * indiscriminate transitive reachability did.
 *
 * Once a helper is ENTERED, every local module it loads is followed — static, re-exported, or
 * dynamically loaded by literal — whether or not the specific symbol is used. That is an
 * over-approximation, and it is the safe direction.
 *
 * The walk runs to completion over a visited set. It never stops early and reports success.
 * An exhausted budget or a non-literal dynamic load yields `incomplete`, and the caller FAILS.
 */
function reachableModules(root, routeFile, ts) {
  const out = [];
  const incomplete = [];
  const access = new Set(ACCESS_LAYER.map((rel) => path.resolve(root, rel)));
  const seen = new Set([path.resolve(routeFile)]);
  const rel = (f) => path.relative(path.resolve(root), path.resolve(f)).split(path.sep).join("/");

  const start = ts.createSourceFile(routeFile, fs.readFileSync(routeFile, "utf8"), ts.ScriptTarget.Latest, true);
  const handlerIds = identifiersInHandlers(start, ts);

  const queue = [{ file: routeFile, sf: start, atRoute: true }];
  while (queue.length) {
    if (out.length > MAX_MODULES) {
      incomplete.push({ reason: "module-budget-exceeded", detail: "more than " + MAX_MODULES + " modules reachable" });
      break;
    }
    const { file, sf, atRoute } = queue.shift();
    const loads = moduleLoads(sf, ts);

    for (const o of loads.opaque) {
      incomplete.push({ reason: "non-literal-dynamic-load", detail: rel(file) + ": " + o });
    }

    const specs = [];
    for (const [spec, names] of loads.named) {
      // A SIDE-EFFECT import (`import "@/lib/x"`) binds no name, so a handler-reference test can
      // never select it — it was skipped rather than followed or refused, while the handler could
      // still consume state the module established. Bindless imports are now always followed.
      if (names.size === 0) { specs.push(spec); continue; }
      // At the route, follow only what the handlers reference. Inside a helper, follow everything.
      if (!atRoute || [...names].some((n) => handlerIds.has(n))) specs.push(spec);
    }
    specs.push(...loads.reexports, ...loads.dynamic);

    for (const spec of specs) {
      const resolved = resolveImport(root, file, spec);
      if (!resolved) {
        // A SELECTED local specifier that will not resolve is not absence — it is a path the
        // analysis cannot see. Treating it as absence is what made the explicit-extension defect
        // silent, and any future alias or extension convention would recreate it.
        if (spec.startsWith(".") || spec.startsWith("@/")) {
          incomplete.push({ reason: "unresolved-local-load", detail: rel(file) + " -> " + spec });
        }
        continue;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (access.has(resolved)) continue;   // reviewed access layer: already measured at the caller
      const text = fs.readFileSync(resolved, "utf8");
      out.push({ file: rel(resolved), text, constructsResponse: RESPONSE_CTORS.test(text) });
      queue.push({ file: resolved, sf: ts.createSourceFile(resolved, text, ts.ScriptTarget.Latest, true), atRoute: false });
    }
  }
  return { modules: out, incomplete };
}

/**
 * STRUCTURAL TERMINAL-EGRESS INVENTORY, with carrier identity.
 *
 * Round 3 replaced payload-token tainting with exit classification, which was the right move but
 * an incomplete one: the classifications were not attached to the value actually delivered.
 * Review found three concrete false acceptances, all the same defect —
 *
 *   1. a function was marked a chokepoint because SOME parameter was typed `SealedPayload`, and
 *      then EVERY response inside it was called sealed. `jsonResp(_sealed: SealedPayload<object>,
 *      raw: object) { return NextResponse.json(raw); }` passed while delivering `raw`.
 *   2. `sse-envelope` proved the transport framing and nothing about what the stream enqueued. A
 *      raw `controller.enqueue(JSON.stringify({ rows }))` beside all 96 existing finalizations
 *      passed, and P2.2's counts were unchanged because a raw enqueue is not a finalization site.
 *      The envelope test was also an OR, so a non-stream body with an event-stream header passed.
 *   3. operational fingerprints used sorted KEY NAMES only, so a reviewed refusal could be
 *      changed to a factual delivery without changing its fingerprint:
 *      `{ success: false, error: JSON.stringify(rows) }` still keyed as `obj{error,success}`.
 *
 * P2.2 hit this defect class already: proving that the right wrapper exists and that a carrier
 * exists is not proof that the wrapper RECEIVED that carrier. The fix is carrier identity at the
 * three narrow egress mechanisms — not a return to crime-data tainting.
 */

const RESPONSE_CTOR_NAMES = new Set(["Response", "NextResponse"]);
const SEAL_CALL = /\b(emitFactualPayload|finalizeExit|finalizeProof)\s*\(/;
const NORM_DEPTH = 4;

/**
 * Normalized structural fingerprint of an expression: KEYS AND VALUES, recursively.
 *
 * Key-only fingerprints let a reviewed refusal become a factual delivery in place. Recursing into
 * values means `obj{error:str:...,success:false}` and `obj{error:call:JSON.stringify(...),
 * success:false}` are different keys, so replacing an inline value fails even though the key set
 * and the exit count are unchanged.
 */
function normalizeExpr(n, sf, ts, depth) {
  depth = depth || 0;
  // A collapsed tail is not an identity: two different payloads would share a fingerprint.
  if (!n) return "none";
  if (depth > NORM_DEPTH) return "TRUNCATED";
  if (ts.isObjectLiteralExpression(n)) {
    return "obj{" + n.properties.map((p) => {
      const k = p.name && ts.isIdentifier(p.name) ? p.name.text
              : p.name && ts.isStringLiteral(p.name) ? p.name.text : "?";
      const v = p.initializer ? normalizeExpr(p.initializer, sf, ts, depth + 1)
              : (ts.isShorthandPropertyAssignment(p) ? "id:" + k : "shorthand");
      return k + ":" + v;
    }).sort().join(",") + "}";
  }
  if (ts.isCallExpression(n)) {
    return "call:" + n.expression.getText(sf) +
      "(" + n.arguments.map((a) => normalizeExpr(a, sf, ts, depth + 1)).join(",") + ")";
  }
  if (ts.isIdentifier(n)) return "id:" + n.text;
  if (n.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (n.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (n.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isStringLiteral(n)) return "str:" + n.text.slice(0, 24);
  if (ts.isNumericLiteral(n)) return "num";
  if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) return "tpl";
  if (ts.isArrayLiteralExpression(n)) return "arr";
  if (ts.isPropertyAccessExpression(n)) return "prop:" + n.getText(sf).slice(0, 30);
  if (ts.isAwaitExpression(n)) return "await:" + normalizeExpr(n.expression, sf, ts, depth + 1);
  if (ts.isConditionalExpression(n)) return "cond";
  if (ts.isBinaryExpression(n)) return "binop";
  return "expr";
}

/**
 * Chokepoint functions AND the sealed carrier parameter each one must deliver.
 * Returns Map<functionName, carrierParamName>.
 */
function chokepointCarriers(sf, ts) {
  const out = new Map();
  const record = (name, params) => {
    if (!name || !params) return;
    const carrier = params.find((p) => p.type && /SealedPayload/.test(p.type.getText(sf)));
    if (carrier && ts.isIdentifier(carrier.name)) out.set(name, carrier.name.text);
  };
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) record(n.name.text, n.parameters);
    else if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
             n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
      record(n.parent.name.text, n.parameters);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * A POSITIONAL carrier rule was implemented here and then REMOVED, deliberately.
 *
 * It required the delivered payload to be exactly the carrier identifier, which is the natural
 * answer to "the carrier is only mentioned, not delivered". It rejected all three PRODUCTION
 * helpers: the real `jsonResp` spreads the carrier, sanitizes narrative text, normalizes rows and
 * attaches chart audit before delivering. A rule that fails on correct code is not a control.
 *
 * The control for a JSON chokepoint is therefore its REVIEWED BODY IDENTITY (see
 * `deliveryBodies`): the transformation is accepted because a human reviewed it, and any edit
 * fails until re-reviewed. The SSE side keeps a positional rule below, because there the seal
 * genuinely is the direct payload in all 29 production sites.
 */

/**
 * A sealed SSE delivery must have the seal call as the DIRECT argument of the event formatter:
 * `encoder.encode(sseEvent(emitFactualPayload(...)))`. All 29 sealed enqueues in the deployed
 * tree have exactly this shape. `sseEvent({ ...rows, _p: emitFactualPayload(x) })` does not, and
 * a containment test would have accepted it for the same reason the carrier test did.
 */
function sealIsDirectPayload(arg, ts, sf) {
  if (!arg || !ts.isCallExpression(arg)) return false;          // encoder.encode(...)
  const inner = arg.arguments[0];
  if (!inner || !ts.isCallExpression(inner)) return false;      // sseEvent(...)
  const sealed = inner.arguments[0];
  if (!sealed || !ts.isCallExpression(sealed)) return false;    // emitFactualPayload(...)
  const callee = sealed.expression.getText(sf);
  return SEAL_PRIMITIVES.includes(callee) && inner.arguments.length === 1;
}

/**
 * REVIEWED-BODY IDENTITY — a change-control invariant, and deliberately not a claim of data-flow
 * proof.
 *
 * The positional rules above are strict but narrow: they constrain the delivery EXPRESSION. They
 * say nothing about the rest of a delivery helper's body. This records a complete normalized
 * identity of each chokepoint body so that ANY edit to a delivery helper fails until it is
 * deliberately reviewed and re-registered.
 *
 * What this is: change control. A human must look at every change to the code that performs
 * factual delivery. What this is NOT: a proof that a registered body is correct. A wrong body,
 * once registered, stays registered — the registry records that someone reviewed it, nothing more.
 * Five review rounds established that syntactic recognizers close one spelling and leave the next
 * one open; this stops trying to out-guess the spellings and requires review instead.
 *
 * Normalization is whitespace-collapsed complete source text. There is no depth fallback, because
 * a truncated identity is not an identity — two different bodies would share a fingerprint.
 */
function deliveryBodies(file, src, ts) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const carriers = chokepointCarriers(sf, ts);
  const out = [];
  const walk = (n) => {
    let name = null;
    if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text;
    else if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
             n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
      name = n.parent.name.text;
    }
    if (name && carriers.has(name) && n.body) {
      // The COMPLETE declaration: name, parameter list, parameter TYPES, return type and body.
      // Hashing the body alone missed the safety-critical half. `jsonResp` is safe because its
      // callers must supply a branded SealedPayload; widening the parameter to
      // `SealedPayload<object> | object` leaves the body byte-identical, keeps the text
      // "SealedPayload" that marks it a chokepoint, and lets an arbitrary raw object typecheck at
      // every call site. Change control that cannot see that change is not change control.
      const exact = n.getText(sf);
      out.push({
        name,
        sha256: crypto.createHash("sha256").update(exact).digest("hex"),
        bytes: exact.length,
      });
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

function responseCtorOf(e, sf, ts) {
  if (!e) return null;
  if (ts.isNewExpression(e) && RESPONSE_CTOR_NAMES.has(e.expression.getText(sf))) {
    return "new " + e.expression.getText(sf);
  }
  if (ts.isCallExpression(e)) {
    const t = e.expression.getText(sf);
    if (t === "Response.json" || t === "NextResponse.json") return t;
  }
  return null;
}

function enclosingChain(node, sf, ts) {
  const names = [];
  let n = node.parent;
  while (n) {
    if (ts.isFunctionDeclaration(n) && n.name) names.push(n.name.text);
    else if (ts.isMethodDeclaration(n) && n.name) names.push(n.name.getText(sf));
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) names.push(n.name.text);
    n = n.parent;
  }
  return names.reverse().join(">") || "<module>";
}

function localBindings(sf, ts) {
  const binding = new Map();
  const collect = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      binding.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  return binding;
}

/**
 * Every SSE delivery operation, classified. The outer envelope is transport; THIS is where facts
 * actually leave the process, so it is inventoried in its own right.
 */
function streamEvents(sf, ts) {
  const bindings = localBindings(sf, ts);
  const events = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "enqueue") {
      const arg = n.arguments[0];
      let resolved = arg, hops = 0;
      while (resolved && ts.isIdentifier(resolved) && bindings.has(resolved.text) && hops < 6) {
        resolved = bindings.get(resolved.text); hops++;
      }
      const text = resolved ? resolved.getText(sf) : "";
      // A seal ANYWHERE in the expression is presence, not delivery. It must be the direct
      // payload of the event formatter, or the seal is decorative.
      const mentionsSeal = SEAL_CALL.test(text);
      const direct = sealIsDirectPayload(resolved, ts, sf);
      const exact = resolved ? resolved.getText(sf) : "";
      events.push({
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        kind: direct ? "sealed" : (mentionsSeal ? "decorative-seal" : "unclassified"),
        sha256: crypto.createHash("sha256").update(exact).digest("hex"),
        bytes: exact.length,
        shape: normalizeExpr(resolved, sf, ts, 0),
      });
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return events;
}

/** Enumerate and classify every terminal HTTP egress in one route file. */
function terminalEgress(file, src, ts) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const carriers = chokepointCarriers(sf, ts);
  const bindings = localBindings(sf, ts);
  const deref = (e) => {
    let cur = e, hops = 0;
    while (cur && ts.isIdentifier(cur) && bindings.has(cur.text) && hops < 6) {
      cur = bindings.get(cur.text); hops++;
    }
    return cur;
  };

  const exits = [];
  const walk = (n) => {
    if (ts.isReturnStatement(n) && n.expression) {
      const resolved = deref(n.expression);
      const ctor = responseCtorOf(resolved, sf, ts);
      if (ctor) {
        const chain = enclosingChain(n, sf, ts);
        const fnName = chain.split(">").pop();
        const args = resolved.arguments || [];
        const first = args[0];
        const firstResolved = deref(first);
        const whole = resolved.getText(sf);
        const firstText = firstResolved ? firstResolved.getText(sf) : "";

        // The envelope requires BOTH an actual stream body AND the event-stream content type.
        // An OR let a raw body with an event-stream header pass as transport framing.
        const hasStreamBody = /ReadableStream/.test(firstText) ||
          (first && ts.isIdentifier(first) && /Stream/.test(firstText));
        const hasEventStream = /text\/event-stream/.test(whole);

        let kind;
        if (carriers.has(fnName)) {
          // A typed parameter is not proof. The response must actually deliver that carrier.
          // The response inside a chokepoint is NOT checked positionally, because the real
          // helpers legitimately transform the carrier: jsonResp spreads it, sanitizes narrative
          // text, normalizes rows and attaches chart audit before delivering. Requiring the
          // payload to BE the carrier identifier rejected all three production helpers.
          //
          // The control on a chokepoint is therefore its REVIEWED BODY IDENTITY, checked in
          // checkEligibility. A decorative carrier -- `NextResponse.json({ ...raw, _proof:
          // sealed })` -- changes the body hash and fails there. That is change control, not a
          // proof that the carrier flows through, and it is not claimed to be one.
          kind = "chokepoint";
        } else if (hasStreamBody && hasEventStream) kind = "sse-envelope";
        else if (SEAL_CALL.test(whole) || SEAL_CALL.test(firstText)) kind = "sealed";
        else kind = "unclassified";

        // EXACT SOURCE IDENTITY. normalizeExpr summarized: every template became `tpl`, every
        // array `arr`, every number `num`, strings and property accesses truncated. The
        // production registry already holds an entry whose error value is a template, so
        // `Please retry in ${n} seconds` and `Please retry: ${JSON.stringify(rows)}` shared a
        // fingerprint. A summary is not an identity. `shape` is retained for human-readable
        // failure messages only and is never matched against.
        const exact = resolved.getText(sf);
        exits.push({
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          ctor, kind, chain,
          sha256: crypto.createHash("sha256").update(exact).digest("hex"),
          bytes: exact.length,
          shape: normalizeExpr(first, sf, ts, 0),
        });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return exits;
}

const REVIEWED_DELIVERY_BODIES = [
  {
    fp: "app/api/query/route.ts::sseEvent",
    sha256: "7f260b7c0ea33262df338e36430fff5c270c3089489ed698973bfc584686e48d",
    bytes: 2503,
    reason: "SSE delivery helper: formats one event from a sealed payload. Identity covers the full declaration, so widening a parameter type invalidates it. Option 3 batch 1 (2026-10-21) re-registration: the body now prefixes the stated reading of a corrected misspelling (lib/spelling-corrections.ts withSpellingNote) to the delivered text; the parameter type is unchanged. Round 1 D3 (2026-10-23, Codex step B build review ACCEPT): the body adds chart partial-period metadata (lib/partial-periods.ts withPartialPeriodFallback); payload types and result values are unchanged.",
  },
  {
    fp: "app/api/nibrs-query/route.ts::jsonResp",
    sha256: "daf297fc2ddd03e9fd3b8ee8643ae0b69d516040cb0f63a97863b840fb590782",
    bytes: 1841,
    reason: "JSON delivery chokepoint: accepts a branded SealedPayload or the typed error and returns it. Identity covers the full declaration, so widening the parameter type to `| object` or `| any` invalidates it. Option 3 batch 1 (2026-10-21) re-registration: the body now prefixes the stated reading of a corrected misspelling (lib/spelling-corrections.ts withSpellingNote) to the delivered text; the parameter type is unchanged. Round 1 D3 (2026-10-23, Codex step B build review ACCEPT): the body adds chart partial-period metadata (lib/partial-periods.ts withPartialPeriodFallback); payload types and result values are unchanged.",
  },
  {
    fp: "app/api/shr-query/route.ts::jsonResp",
    sha256: "e27d74819a941ee251a9647680f7ad2c34b61a243da4825d88e53aad0d443492",
    bytes: 1819,
    reason: "JSON delivery chokepoint: accepts a branded SealedPayload or the typed error and returns it. Identity covers the full declaration, so widening the parameter type to `| object` or `| any` invalidates it. Option 3 batch 1 (2026-10-21) re-registration: the body now prefixes the stated reading of a corrected misspelling (lib/spelling-corrections.ts withSpellingNote) to the delivered text; the parameter type is unchanged. Round 1 D3 (2026-10-23, Codex step B build review ACCEPT): the body adds chart partial-period metadata (lib/partial-periods.ts withPartialPeriodFallback); payload types and result values are unchanged.",
  },
  {
    fp: "app/api/hc-query/route.ts::jsonResp",
    sha256: "97d4d814155acadb46eee2553f1bef9e9ecf8f32eaca2befdec31a0a046d6770",
    bytes: 1114,
    reason: "JSON delivery chokepoint: accepts a branded SealedPayload or the typed error and returns it. Identity covers the full declaration, so widening the parameter type to `| object` or `| any` invalidates it. Round 1 D3 (2026-10-23, Codex step B build review ACCEPT): the body adds chart partial-period metadata (lib/partial-periods.ts withPartialPeriodFallback); payload types and result values are unchanged.",
  },
  {
    fp: "app/api/embed/route.ts::embedResp",
    sha256: "f7b2e2960ee1f00071893a6814a2c182a3b1ef433bf50c589f78a7d6d6d3fbbf",
    bytes: 124,
    reason: "Embed delivery chokepoint: accepts a branded SealedPayload or the typed error. Identity covers the full declaration.",
  },
];

const OPERATIONAL_EXITS = [
  {
    fp: "app/api/query/route.ts::9e725b62f8d1f7dd5d3520ce5c5270850da9ce961ccfead98613064a0cb21d7d",
    sha256: "9e725b62f8d1f7dd5d3520ce5c5270850da9ce961ccfead98613064a0cb21d7d",
    bytes: 320,
    count: 1,
    where: "POST",
    reason: "Reviewed operational exit: asserts no fact.",
  },
  {
    fp: "app/api/query/route.ts::354f2909d6a8656f85b07c6628338e19b68a11ebfad8e5eabebbc4149ea459f5",
    sha256: "354f2909d6a8656f85b07c6628338e19b68a11ebfad8e5eabebbc4149ea459f5",
    bytes: 187,
    count: 1,
    where: "POST",
    reason: "Stale page token; the caller is asked to refresh. No query runs.",
  },
  {
    fp: "app/api/query/route.ts::bd2b7ed3149abb7f93244ed6f2a80a1d48fa7dac329a0f3e6421190bba238a3a",
    sha256: "bd2b7ed3149abb7f93244ed6f2a80a1d48fa7dac329a0f3e6421190bba238a3a",
    bytes: 219,
    count: 1,
    where: "POST",
    reason: "Daily quota exhausted. A refusal issued before any query runs.",
  },
  {
    fp: "app/api/query/route.ts::9e8209fe4cc3e862d61eeabe73cba2ed16e8a04596cde9cf17e831ab3c170316",
    sha256: "9e8209fe4cc3e862d61eeabe73cba2ed16e8a04596cde9cf17e831ab3c170316",
    bytes: 161,
    count: 1,
    where: "POST",
    reason: "Captcha challenge issued before any query runs.",
  },
  {
    fp: "app/api/query/route.ts::1cd731fe204cf0ba4d5eabd83b0a118026ab2ebd65dd02e63d5149b9285bb8cf",
    sha256: "1cd731fe204cf0ba4d5eabd83b0a118026ab2ebd65dd02e63d5149b9285bb8cf",
    bytes: 158,
    count: 1,
    where: "POST",
    reason: "Malformed request body rejected before any query runs.",
  },
  {
    fp: "app/api/query/route.ts::d32f44459a3cc4b9b41c818205b295b094c233905018a9fad45d6ba4bebc1ce8",
    sha256: "d32f44459a3cc4b9b41c818205b295b094c233905018a9fad45d6ba4bebc1ce8",
    bytes: 168,
    count: 1,
    where: "POST",
    reason: "Reviewed operational exit: asserts no fact.",
  },
  {
    fp: "app/api/query/route.ts::58ee771eb2f074cdbc8ccba29f98bfff3a6f2e4ba16bb85bea1e9195937df645",
    sha256: "58ee771eb2f074cdbc8ccba29f98bfff3a6f2e4ba16bb85bea1e9195937df645",
    bytes: 206,
    count: 1,
    where: "POST",
    reason: "Over-length question rejected before any query runs.",
  },
  {
    fp: "app/api/nibrs-query/route.ts::c33c18792addc8c8d6764d0129d0fa5bc69f8c2769b98d377b9eca7868a58205",
    sha256: "c33c18792addc8c8d6764d0129d0fa5bc69f8c2769b98d377b9eca7868a58205",
    bytes: 62,
    count: 1,
    where: "OPTIONS",
    reason: "Reviewed operational exit: asserts no fact.",
  },
  {
    fp: "app/api/nibrs-query/route.ts::953e2ad9cc732e20eca6fda6352d7a1b74e6d08c363fbe2cc4c762b85c125dca",
    sha256: "953e2ad9cc732e20eca6fda6352d7a1b74e6d08c363fbe2cc4c762b85c125dca",
    bytes: 77,
    count: 1,
    where: "POST",
    reason: "Captcha challenge issued before any query runs.",
  },
  {
    fp: "app/api/shr-query/route.ts::953e2ad9cc732e20eca6fda6352d7a1b74e6d08c363fbe2cc4c762b85c125dca",
    sha256: "953e2ad9cc732e20eca6fda6352d7a1b74e6d08c363fbe2cc4c762b85c125dca",
    bytes: 77,
    count: 1,
    where: "POST",
    reason: "Captcha challenge issued before any query runs.",
  },
  {
    fp: "app/api/hc-query/route.ts::0491c2769bbee52de3aa3a04d4bbc5d4311b9f9063e4b9d84020f9cad8e8e3a0",
    sha256: "0491c2769bbee52de3aa3a04d4bbc5d4311b9f9063e4b9d84020f9cad8e8e3a0",
    bytes: 119,
    count: 1,
    where: "POST",
    reason: "The hate-crime source is unavailable in this deployment. A refusal.",
  },
  {
    fp: "app/api/hc-query/route.ts::953e2ad9cc732e20eca6fda6352d7a1b74e6d08c363fbe2cc4c762b85c125dca",
    sha256: "953e2ad9cc732e20eca6fda6352d7a1b74e6d08c363fbe2cc4c762b85c125dca",
    bytes: 77,
    count: 1,
    where: "POST",
    reason: "Captcha challenge issued before any query runs.",
  },
];

/**
 * Reviewed operational SSE events. The outer envelope is transport; these are the actual
 * delivery operations, so they are inventoried in their own right. Every other enqueue must
 * carry a sealed payload.
 */
const OPERATIONAL_STREAM_EVENTS = [
  {
    fp: "app/api/query/route.ts::aee37eeb2a17a0637c752d1a6afa1dd965ebfc7b77c0c710f419ee9f95b7f8f8",
    sha256: "aee37eeb2a17a0637c752d1a6afa1dd965ebfc7b77c0c710f419ee9f95b7f8f8",
    bytes: 104,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    fp: "app/api/query/route.ts::f74c18d78e5e11b6633423220c6459dde720c97c765a2feadd352112191eb116",
    sha256: "f74c18d78e5e11b6633423220c6459dde720c97c765a2feadd352112191eb116",
    bytes: 99,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    fp: "app/api/query/route.ts::4cba0b57b470080d711f745a3b30fa997bc3477bf29c9f90a6693e8d8432e971",
    sha256: "4cba0b57b470080d711f745a3b30fa997bc3477bf29c9f90a6693e8d8432e971",
    bytes: 94,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    fp: "app/api/query/route.ts::f952bcf035126b4241fb5c9907af87c4a9475b19465ad4c8f3cc01e7001314c2",
    sha256: "f952bcf035126b4241fb5c9907af87c4a9475b19465ad4c8f3cc01e7001314c2",
    bytes: 237,
    count: 1,
    reason: "SQL-generation failure notice; reports the attempted SQL, not results.",
  },
  {
    fp: "app/api/query/route.ts::44a8749ff9931dd0e5355c3ef04183462ef5ae862823833a1a14cad3e01acb02",
    sha256: "44a8749ff9931dd0e5355c3ef04183462ef5ae862823833a1a14cad3e01acb02",
    bytes: 122,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    fp: "app/api/query/route.ts::e68c26297af67e1a9f671b8a5da0ea213871da9eeef73b5f8a9251308ff7f57f",
    sha256: "e68c26297af67e1a9f671b8a5da0ea213871da9eeef73b5f8a9251308ff7f57f",
    bytes: 109,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    fp: "app/api/query/route.ts::186a0968fb29d584af7213e55f8f5dda5845b824586fbf4e7597c0e8fbae72fd",
    sha256: "186a0968fb29d584af7213e55f8f5dda5845b824586fbf4e7597c0e8fbae72fd",
    bytes: 114,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    fp: "app/api/query/route.ts::0559eb567fc647c7b70ada4579a94c67d551c3bc3d5fe0208ce8b9fad268c2f2",
    sha256: "0559eb567fc647c7b70ada4579a94c67d551c3bc3d5fe0208ce8b9fad268c2f2",
    bytes: 255,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    fp: "app/api/query/route.ts::d79ac1eda93271518b9a6c2257d3a185e1b196a6a53cdd0ce151acc86b76b0ed",
    sha256: "d79ac1eda93271518b9a6c2257d3a185e1b196a6a53cdd0ce151acc86b76b0ed",
    bytes: 245,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    fp: "app/api/query/route.ts::e7446becddf6949acfd60e7690e02788177223014902a853f450c2c153c2e1b2",
    sha256: "e7446becddf6949acfd60e7690e02788177223014902a853f450c2c153c2e1b2",
    bytes: 235,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    fp: "app/api/query/route.ts::02248a70be266819efb0095be8edfcbbfb097e50ea495d30e12ce5fdb8c639ad",
    sha256: "02248a70be266819efb0095be8edfcbbfb097e50ea495d30e12ce5fdb8c639ad",
    bytes: 127,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    fp: "app/api/query/route.ts::bab8fb3cbbc170d16980b774998173874689bd72419c56096c35d516080fe46e",
    sha256: "bab8fb3cbbc170d16980b774998173874689bd72419c56096c35d516080fe46e",
    bytes: 182,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
  {
    // Integration 2026-09-30: the accepted Phase 3 candidate's current-YoY internal-failure exit.
    // `message` is a const string literal declared two lines above the enqueue ("I could not read the
    // reporting coverage needed to compare those years ..."); it carries no figure, and the turn is
    // logged as an error with a null proof.
    fp: "app/api/query/route.ts::012cf17c019d7d876650b2bda907c478e66c4c0446bb0d332af18cd3b31f6d57",
    sha256: "012cf17c019d7d876650b2bda907c478e66c4c0446bb0d332af18cd3b31f6d57",
    bytes: 58,
    count: 1,
    reason: "Error notice with literal text. Reports a failure, not an answer.",
  },
];

const EXCLUSIONS = [
  {
    route: "app/api/auth/route.ts",
    reason:
      "Authentication handshake. Validates a password and sets the session cookie. It never " +
      "opens a crime database and returns no data, so there is no factual delivery to type.",
    claims: { readsCrimeDb: false, returnsRows: false, invokesModel: false },
  },
  {
    route: "app/api/page-token/route.ts",
    reason:
      "Issues the short-lived page token the question routes require. No database, no content. " +
      "This is the token the P2.4 controlled request itself acquired before issuing its query.",
    claims: { readsCrimeDb: false, returnsRows: false, invokesModel: false },
  },
  {
    route: "app/api/verify-captcha/route.ts",
    reason: "Captcha verification. No database access and no content in the response body.",
    claims: { readsCrimeDb: false, returnsRows: false, invokesModel: false },
  },
  {
    route: "app/api/track/route.ts",
    reason:
      "Write-only visitor telemetry. Obtains the rtci WRITE handle solely to INSERT into " +
      "visitor_log, and every exit returns {ok:true}. It performs no read and delivers no " +
      "crime data, so there is no answer to type.",
    claims: { readsCrimeDb: false, returnsRows: false, invokesModel: false, writesOnly: true },
  },
  {
    route: "app/api/chart-render-receipt/route.ts",
    reason:
      "Receipt persistence, delegated. The route passes the WRITE handle to " +
      "persistChartRenderReceipt in lib/chart-audit.ts and returns {success:boolean}. The " +
      "delegated helper is measured too, and it still reaches no crime-database reader and " +
      "returns no rows: it writes audit rows and checks its own tables. (An earlier entry " +
      "claimed writesOnly=true; the claim check rejected it, because the INSERT is in the lib.)",
    claims: { readsCrimeDb: false, returnsRows: false, invokesModel: false },
  },
  {
    route: "app/api/session-analytics/route.ts",
    reason:
      "Meta-analytics ABOUT the application, not an answer FROM it. Every SELECT targets " +
      "query_log — queries per day, tab breakdown, session distribution, error rate, referrers. " +
      "It reads no crime database, answers no user question, and is credential-gated. It " +
      "aggregates the same table the typed outcome rows live in, which makes it a consumer of " +
      "the outcome model, never a producer of a typed outcome. It returns named aggregates " +
      "(queriesPerDay, tabBreakdown, errorRate, ...), not a row set.",
    claims: { readsCrimeDb: false, returnsRows: false, invokesModel: false, requiresCredential: true },
  },
  {
    route: "app/api/query-log/route.ts",
    reason:
      "THE ARGUABLE ONE, excluded deliberately and named here so it is never excluded silently. " +
      "Its POST re-runs an operator-supplied SQL statement against nibrs / shr / hate_crime / " +
      "rtci and returns up to 500 raw rows, so it genuinely does return crime-database content. " +
      "It is still not a terminal factual-answer exit: there is no user question, no " +
      "model-composed answer, and therefore no delivery DECISION to classify — the caller " +
      "already knows what they asked for. It is a log-viewer tool gated on LOG_KEY, not the " +
      "public question flow. Its caller-supplied-SQL design is a separately scoped security " +
      "concern deferred by owner decision on 2026-08-31; that does not make it a missing " +
      "typed-outcome route. If it ever gains a question-shaped entry point or composes an " +
      "answer, this exclusion must be revisited and the route sealed.",
    claims: { readsCrimeDb: true, returnsRows: true, invokesModel: false, requiresCredential: true },
  },
  {
    route: "app/api/nibrs-shadow-query/route.ts",
    reason:
      "The owner-only LOCAL preview of the NIBRS shadow engine (coordinator, 2026-10-29), excluded " +
      "deliberately. On a production build it is unreachable: every handler returns 404 unless " +
      "previewEnabled() (NODE_ENV not production AND NIBRS_SHADOW_ROOT set), the same gate as the " +
      "/preview page, proven by scripts/test-nibrs-preview-production.sh. On a developer's machine " +
      "it does return crime counts, read from nibrs-model's canonical parquet through a local " +
      "DuckDB subprocess, never through the app's crime databases, and it invokes no model. It is " +
      "not part of the public question flow. If it is ever enabled in production or wired into a " +
      "user-facing page, this exclusion must be revisited and the route sealed.",
    claims: { readsCrimeDb: false, returnsRows: false, invokesModel: false },
  },
];

function routeFiles(root) {
  const out = [];
  (function find(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) find(p);
      else if (ROUTE_BASENAMES.includes(e.name)) out.push(p);
    }
  })(path.join(root, "app"));
  return out.sort();
}

/**
 * Measures a route over its own source plus every module reachable from its handlers.
 *
 * `returnsRows` is evaluated PER SOURCE UNIT, never over the concatenation. Measuring it over the
 * union invented a pairing present in no file: `chart-audit.ts` uses `rows` as a type field name
 * while the route separately calls `Response.json`, which reported a receipt writer as returning
 * rows. Requiring one file to hold both the row binding and the response still catches a
 * delegating helper, whose body is `const rows = ...; return Response.json({ rows })`.
 *
 * `readsCrimeDb` is deliberately union-wide: accessor names are distinctive, and a genuine
 * delegation can obtain the handle in the route and perform the read in the helper.
 *
 * `writesOnly` stays anchored to the route's own source — "this route only writes" is a statement
 * about the route.
 */
function measure(root, file, ts) {
  ts = ts || loadTs(root);
  const own = fs.readFileSync(file, "utf8");
  const { modules, incomplete } = reachableModules(root, file, ts);
  const units = [own, ...modules.map((m) => m.text)];
  const union = units.join("\n");

  const readerIn = (src) => CRIME_DB_READERS.filter((a) => new RegExp("\\b" + a + "\\s*\\(").test(src));
  const readOpIn = (src) => READ_OPS.some((op) => src.includes(op));
  const writeOpIn = (src) => WRITE_OPS.some((op) => new RegExp("\\b" + op + "\\b").test(src));
  const rowsIn = (src) => /\brows\b/.test(src) && /NextResponse\.json|new Response|Response\.json/.test(src);

  return {
    route: path.relative(root, file).split(path.sep).join("/"),
    sealed: SEAL_PRIMITIVES.some((p) => own.includes(p)),
    readsCrimeDb: readerIn(union).length > 0 && readOpIn(union),
    readersUsed: readerIn(union),
    returnsRows: units.some((u) => rowsIn(u)),
    invokesModel: /anthropic|messages\.create/i.test(union),
    requiresCredential: /LOG_KEY|authorizeAnalytics|Unauthorized/.test(union),
    writesOnly: writeOpIn(own) && !readOpIn(own),
    reachedModules: modules.map((m) => m.file),
    // B2: a reached helper that constructs a response is making a terminal delivery outside the
    // five inventoried route files, where nothing proves sealing or pairing.
    helperResponseExits: modules
      .filter((m) => m.constructsResponse && !HELPER_RESPONSE_ALLOWLIST.includes(m.file))
      .map((m) => m.file),
    // B2, same file: STRUCTURAL. Every terminal HTTP egress in this file, classified. Payload
    // contents are never inspected - see the terminalEgress header for why that question was
    // the wrong one.
    terminalExits: terminalEgress(file, own, ts),
    // The envelope is transport. These are the operations that actually deliver facts.
    streamEvents: streamEvents(ts.createSourceFile(file, own, ts.ScriptTarget.Latest, true), ts),
    deliveryBodies: deliveryBodies(file, own, ts),
    incomplete,
  };
}

/**
 * Returns { ok, routes, failures }. Failure kinds:
 *   unsealed-unregistered — a route is neither sealed nor excluded
 *   claim-mismatch        — a registered exclusion states something the source contradicts
 *   stale-exclusion       — a registry entry names a route that no longer exists
 *   sealed-and-excluded   — a route is both sealed and registered as excluded
 *   analysis-incomplete   — the walk could not see everything, so nothing is certified
 *   config-assumption     — pageExtensions customized, or the access-layer allowlist has rotted
 */
/**
 * `opts.operationalExits` / `opts.operationalStreamEvents` override the reviewed registries. The
 * real ones are the default and are what guards this repository; fixtures supply their own,
 * because the registries are keyed by value-aware fingerprints containing real literal text and a
 * fixture cannot reproduce those without becoming a copy of production.
 */
/** The key is a digest, so failures still name where to look. */
function x0(m, fp) {
  const hit = m.terminalExits.find((x) => fp.endsWith(x.sha256));
  return hit ? hit.chain + " line " + hit.line + " (" + hit.shape.slice(0, 40) + ")" : "this route";
}

function checkEligibility(root, opts) {
  opts = opts || {};
  const OP_EXITS = opts.operationalExits || OPERATIONAL_EXITS;
  const OP_EVENTS = opts.operationalStreamEvents || OPERATIONAL_STREAM_EVENTS;
  const ts = loadTs(root);
  const failures = [];

  const ext = assertRouteExtensionAssumption(root);
  if (!ext.ok) failures.push({ kind: "config-assumption", route: "(repository)", detail: ext.detail });

  const acc = validateAccessLayer(root);
  if (!acc.ok) {
    failures.push({
      kind: "config-assumption", route: "(access-layer)",
      detail: [acc.missing.length ? "missing: " + acc.missing.join(", ") : "",
               acc.violations.length ? "leaf invariant violated -> " + acc.violations.join("; ") : ""]
              .filter(Boolean).join(" | "),
    });
  }

  const measured = routeFiles(root).map((f) => measure(root, f, ts));
  const byRoute = new Map(measured.map((m) => [m.route, m]));

  for (const m of measured) {
    const ex = EXCLUSIONS.find((e) => e.route === m.route);

    // Fail closed for EVERY route, sealed included. An earlier version exempted sealed routes on
    // the reasoning that the seal already covers them. That was unsound: `sealed` means the file
    // contains one of three primitive names, which says nothing about whether an unseen
    // dynamically-loaded or delegated path passes through one.
    if (m.incomplete.length) {
      for (const inc of m.incomplete) {
        failures.push({
          kind: "analysis-incomplete", route: m.route,
          detail: inc.reason + ": " + inc.detail + " — refusing to certify this route",
        });
      }
    }

    // B2: delegated terminal delivery. Applies to sealed routes too - that is the point.
    for (const h of m.helperResponseExits) {
      failures.push({
        kind: "delegated-response-exit", route: m.route,
        detail: "reached helper " + h + " constructs an HTTP response outside the terminal-exit " +
                "inventory, so nothing proves that delivery is sealed or paired - review required",
      });
    }
    // Only meaningful for SEALED routes: those are the files the exit inventory covers. A
    // registered exclusion delivering rows is governed by its own written claims, and an
    // unregistered route is already caught as unsealed-unregistered.
    if (m.sealed) {
      const registry = new Map(OP_EXITS.map((e) => [e.fp, e]));
      const seen = new Map();
      for (const x of m.terminalExits) {
        if (x.kind !== "unclassified") continue;
        const fp = m.route + "::" + x.sha256;
        seen.set(fp, (seen.get(fp) || 0) + 1);
      }
      for (const [fp, n] of seen) {
        const entry = registry.get(fp);
        if (!entry) {
          failures.push({
            kind: "unclassified-terminal-exit", route: m.route,
            detail: n + " terminal exit(s) in " + x0(m, fp) + " are neither a chokepoint, an SSE " +
                    "envelope, nor a reviewed operational exit - classify or seal them (" + fp + ")",
          });
        } else if (entry.count !== n) {
          failures.push({
            kind: "unclassified-terminal-exit", route: m.route,
            detail: "operational exit " + fp + " is registered " + entry.count + " time(s) but " +
                    "found " + n + " - the registry must be updated deliberately",
          });
        }
      }
      // A registry entry that matches nothing is rot, and rot hides the next real change.
      for (const e of OP_EXITS) {
        if (!e.fp.startsWith(m.route + "::")) continue;
        if (!seen.has(e.fp)) {
          failures.push({
            kind: "stale-operational-exit", route: m.route,
            detail: "registered operational exit no longer exists: " + e.fp,
          });
        }
      }

      // Reviewed-body identity: any edit to a delivery helper fails until re-reviewed.
      const bodyReg = new Map((opts.reviewedDeliveryBodies || REVIEWED_DELIVERY_BODIES)
        .map((e) => [e.fp, e]));
      const bodySeen = new Set();
      for (const b of m.deliveryBodies) {
        const fp = m.route + "::" + b.name;
        bodySeen.add(fp);
        const entry = bodyReg.get(fp);
        if (!entry) {
          failures.push({
            kind: "unreviewed-delivery-body", route: m.route,
            detail: "delivery helper " + b.name + " has no reviewed body identity - register it",
          });
        } else if (entry.sha256 !== b.sha256) {
          failures.push({
            kind: "unreviewed-delivery-body", route: m.route,
            detail: "delivery helper " + b.name + " changed (" + entry.sha256.slice(0, 12) +
                    " -> " + b.sha256.slice(0, 12) + "); review the change and re-register it",
          });
        }
      }
      for (const e of (opts.reviewedDeliveryBodies || REVIEWED_DELIVERY_BODIES)) {
        if (!e.fp.startsWith(m.route + "::")) continue;
        if (!bodySeen.has(e.fp)) {
          failures.push({
            kind: "stale-operational-exit", route: m.route,
            detail: "reviewed delivery body no longer exists: " + e.fp,
          });
        }
      }

      // A seal present but not delivered is decorative.
      for (const ev of m.streamEvents) {
        if (ev.kind !== "decorative-seal") continue;
        failures.push({
          kind: "decorative-seal", route: m.route,
          detail: "line " + ev.line + " enqueues an expression that MENTIONS a seal but does not " +
                  "deliver it as the event payload",
        });
      }

      // A truncated fingerprint is not an identity; two payloads could share it.
      for (const x of m.terminalExits) {
        if (!/TRUNCATED/.test(x.shape)) continue;
        failures.push({
          kind: "analysis-incomplete", route: m.route,
          detail: "the payload at line " + x.line + " exceeds the normalizer depth, so its " +
                  "fingerprint is not a unique identity - refusing to certify",
        });
      }

      // A typed parameter is not proof of delivery. If a chokepoint responds from anything other
      // than its sealed carrier, the seal is decorative.
      for (const x of m.terminalExits) {
        if (x.kind !== "detached-carrier") continue;
        failures.push({
          kind: "detached-carrier", route: m.route,
          detail: "the exit in " + x.chain + " sits in a function with a SealedPayload parameter " +
                  "but responds from " + x.shape + ", which does not derive from that carrier",
        });
      }

      // SSE: the envelope is transport. Every delivery operation must carry a sealed payload or
      // be a reviewed operational event. A raw enqueue leaves the P2.2 counts untouched, which is
      // precisely why it needs an inventory of its own.
      const evRegistry = new Map(OP_EVENTS.map((e) => [e.fp, e]));
      const evSeen = new Map();
      for (const ev of m.streamEvents) {
        if (ev.kind !== "unclassified") continue;
        const fp = m.route + "::" + ev.sha256;
        evSeen.set(fp, (evSeen.get(fp) || 0) + 1);
      }
      for (const [fp, n] of evSeen) {
        const entry = evRegistry.get(fp);
        if (!entry) {
          failures.push({
            kind: "unclassified-stream-event", route: m.route,
            detail: n + " SSE delivery operation(s) carry no sealed payload and are not a " +
                    "reviewed operational event - seal or classify them (" + fp + ")",
          });
        } else if (entry.count !== n) {
          failures.push({
            kind: "unclassified-stream-event", route: m.route,
            detail: "operational stream event " + fp + " is registered " + entry.count +
                    " time(s) but found " + n + " - the registry must be updated deliberately",
          });
        }
      }
      for (const e of OP_EVENTS) {
        if (!e.fp.startsWith(m.route + "::")) continue;
        if (!evSeen.has(e.fp)) {
          failures.push({
            kind: "stale-operational-exit", route: m.route,
            detail: "registered operational stream event no longer exists: " + e.fp,
          });
        }
      }
    }

    if (!m.sealed && !ex) {
      failures.push({
        kind: "unsealed-unregistered", route: m.route,
        detail: "not sealed and not in the exclusion registry (readsCrimeDb=" + m.readsCrimeDb +
                ", returnsRows=" + m.returnsRows + ", invokesModel=" + m.invokesModel +
                (m.reachedModules.length ? ", via " + m.reachedModules.join(",") : "") + ")",
      });
    }
    if (m.sealed && ex) {
      failures.push({
        kind: "sealed-and-excluded", route: m.route,
        detail: "route seals outcomes but is also registered as excluded",
      });
    }
  }

  for (const e of EXCLUSIONS) {
    const m = byRoute.get(e.route);
    if (!m) {
      failures.push({
        kind: "stale-exclusion", route: e.route,
        detail: "registry names a route that does not exist in the tree",
      });
      continue;
    }
    for (const [k, want] of Object.entries(e.claims)) {
      if (m[k] !== want) {
        failures.push({
          kind: "claim-mismatch", route: e.route,
          detail: "exclusion claims " + k + "=" + want + ", source measures " + k + "=" + m[k] +
                  (m.reachedModules.length ? " (incl. reached " + m.reachedModules.join(",") + ")" : ""),
        });
      }
    }
    if (!e.reason || e.reason.trim().length < 40) {
      failures.push({
        kind: "claim-mismatch", route: e.route,
        detail: "exclusion reason is missing or too short to be a justification",
      });
    }
  }

  return {
    ok: failures.length === 0,
    routes: measured,
    sealedRoutes: measured.filter((m) => m.sealed).map((m) => m.route),
    excludedRoutes: EXCLUSIONS.map((e) => e.route),
    failures,
  };
}

module.exports = {
  checkEligibility, measure, routeFiles, reachableModules, resolveImport,
  assertRouteExtensionAssumption, validateAccessLayer,
  terminalEgress, streamEvents, chokepointCarriers, sealIsDirectPayload, normalizeExpr, deliveryBodies, REVIEWED_DELIVERY_BODIES,
  OPERATIONAL_EXITS, OPERATIONAL_STREAM_EVENTS,
  EXCLUSIONS, CRIME_DB_READERS, SEAL_PRIMITIVES, ROUTE_BASENAMES, ACCESS_LAYER,
  MAX_MODULES, RESPONSE_CTORS, HELPER_RESPONSE_ALLOWLIST,
};
