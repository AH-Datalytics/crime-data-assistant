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
 */
const fs = require("fs");
const path = require("path");

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
  "lib/proof-finalize.ts",
  "lib/proof-contract.ts",
  "lib/proof-modes.ts",
];

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

/** Every allowlisted access-layer module must exist, or the allowlist has rotted. */
function validateAccessLayer(root) {
  const missing = ACCESS_LAYER.filter((rel) => !fs.existsSync(path.join(root, rel)));
  return { ok: missing.length === 0, missing };
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
      // At the route, follow only what the handlers reference. Inside a helper, follow everything.
      if (!atRoute || [...names].some((n) => handlerIds.has(n))) specs.push(spec);
    }
    specs.push(...loads.reexports, ...loads.dynamic);

    for (const spec of specs) {
      const resolved = resolveImport(root, file, spec);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      if (access.has(resolved)) continue;   // reviewed access layer: already measured at the caller
      const text = fs.readFileSync(resolved, "utf8");
      out.push({ file: rel(resolved), text });
      queue.push({ file: resolved, sf: ts.createSourceFile(resolved, text, ts.ScriptTarget.Latest, true), atRoute: false });
    }
  }
  return { modules: out, incomplete };
}

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
function checkEligibility(root) {
  const ts = loadTs(root);
  const failures = [];

  const ext = assertRouteExtensionAssumption(root);
  if (!ext.ok) failures.push({ kind: "config-assumption", route: "(repository)", detail: ext.detail });

  const acc = validateAccessLayer(root);
  if (!acc.ok) {
    failures.push({
      kind: "config-assumption", route: "(access-layer)",
      detail: "allowlisted access-layer modules missing: " + acc.missing.join(", "),
    });
  }

  const measured = routeFiles(root).map((f) => measure(root, f, ts));
  const byRoute = new Map(measured.map((m) => [m.route, m]));

  for (const m of measured) {
    const ex = EXCLUSIONS.find((e) => e.route === m.route);

    // Fail closed. A sealed route is covered by its seal, so incomplete analysis cannot hide a
    // hole there; for anything else, an unseeable path is a refusal to certify, not a pass.
    if (!m.sealed && m.incomplete.length) {
      for (const inc of m.incomplete) {
        failures.push({
          kind: "analysis-incomplete", route: m.route,
          detail: inc.reason + ": " + inc.detail + " — refusing to certify this route",
        });
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
  EXCLUSIONS, CRIME_DB_READERS, SEAL_PRIMITIVES, ROUTE_BASENAMES, ACCESS_LAYER, MAX_MODULES,
};
