/**
 * P2.5 — eligibility closure for typed-outcome coverage.
 *
 * WHAT P2.2 ALREADY PROVED, AND WHAT IT DID NOT.
 * `scripts/lib/exit-inventory.js` proves that every terminal factual exit *inside five named
 * files* is sealed and that the row it writes carries the outcome. Measured on the deployed
 * commit 2c9e7cc8: 96 decision sites, 96 sealed, 0 unsealed, 0 unpaired. That is a complete
 * proof of an incomplete question, because the five files are a hard-coded constant. A new route
 * that answered questions without sealing would not appear in the inventory at all, and every
 * existing assertion would still pass. Coverage measured over a hand-picked denominator is not
 * coverage. This module closes the denominator.
 *
 * ── THE TWO ESCAPES THIS VERSION CLOSES ──────────────────────────────────────────────────────
 *
 * The first version of this guard was reviewed and found to leak in two ways. Both were
 * reproduced independently before being fixed; the mutations that prove they are closed are in
 * `test-eligibility.js` groups C and D.
 *
 *   ESCAPE 1 — JavaScript route modules. `routeFiles()` matched only `route.ts`/`route.tsx`.
 *   A complete twelve-route tree plus one `app/api/sneaky/route.js` reading NIBRS and returning
 *   rows still enumerated 12 routes and returned `ok` with zero failures. Next.js accepts JS
 *   route modules, and no repository rule forbade them. Closed by enumerating every route-module
 *   extension Next.js accepts.
 *
 *   ESCAPE 2 — factual behavior delegated through a helper. `measure()` read only the route
 *   file's own source, so a registered exclusion whose body was `return answerFromCrimeData(req)`
 *   measured readsCrimeDb=false / returnsRows=false and passed, while the helper read NIBRS and
 *   returned rows. Closed by the bounded call-graph walk below.
 *
 * ── WHY THE WALK IS A CALL GRAPH AND NOT THE IMPORT GRAPH ────────────────────────────────────
 *
 * An earlier draft measured transitive *import* reachability and produced four false positives:
 * `track` and `chart-render-receipt` were flagged factual because something forty modules away
 * touched a database. The review that caught escape 2 was explicit that closing it must not
 * revive indiscriminate reachability.
 *
 * So the walk starts at the EXPORTED HTTP HANDLERS and follows only symbols those handlers
 * actually reference, one module at a time, to a bounded depth. Importing a logging helper that
 * happens to import a database library does not pull the database library in; calling a helper
 * that reads a database does.
 *
 * THE DATABASE ACCESS LAYER IS A LEAF, and this is load-bearing rather than an optimisation.
 * `lib/rtci-db.ts` contains `export function getDb(...)`. Walking into it would match the
 * accessor-name criterion against a *definition* and report every route that touches the access
 * layer as a crime-data reader — `track`, which only ever writes, included. Calling an accessor
 * is already measured at the call site, so descending into the accessor module measures nothing
 * and destroys the write-only controls. The leaf rule is what keeps those controls intact.
 */
const fs = require("fs");
const path = require("path");

/** Every route-module extension Next.js accepts. Escape 1 was `.js` alone. */
const ROUTE_BASENAMES = ["route.ts", "route.tsx", "route.js", "route.jsx", "route.mjs", "route.cjs"];

/** Read accessors for the four crime databases. `getWriteDb` is deliberately NOT here: it is the
 *  write handle, and treating it as evidence of a factual read is what produced the original
 *  false positives on `track` and `chart-render-receipt`. */
const CRIME_DB_READERS = ["getNibrsDb", "getShrDb", "getHateCrimeDb", "getDb"];
const SEAL_PRIMITIVES = ["emitFactualPayload", "finalizeExit", "finalizeProof"];
const READ_OPS = [".all(", ".get(", ".iterate(", ".pluck("];
const WRITE_OPS = ["INSERT", "UPDATE", "DELETE", "REPLACE"];
const HTTP_HANDLERS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Modules the walk must not descend into. See the header: descending measures definitions. */
const WALK_LEAF = /(-db|sqlite-db|proof-finalize|proof-contract|proof-modes)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const MAX_DEPTH = 3;

function loadTs(root) {
  // Prefer the tree under analysis, but fall back to this process's own typescript so the
  // throwaway fixtures in the test suite need no node_modules of their own. Symlinking one per
  // fixture was not portable: a Windows junction is not creatable on the CI runner.
  try { return require(path.join(root, "node_modules", "typescript")); }
  catch { return require("typescript"); }
}

function resolveImport(root, fromFile, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return null;
  const base = spec.startsWith("@/")
    ? path.join(root, spec.slice(2))
    : path.resolve(path.dirname(fromFile), spec);
  for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
    const c = base + ext;
    if (ext && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  for (const idx of ["index.ts", "index.tsx", "index.js"]) {
    const c = path.join(base, idx);
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** local imported name -> module specifier */
function importMap(sf, ts) {
  const map = new Map();
  const walk = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause) {
      const spec = n.moduleSpecifier.text;
      const c = n.importClause;
      if (c.name) map.set(c.name.text, spec);
      if (c.namedBindings) {
        if (ts.isNamedImports(c.namedBindings)) {
          for (const e of c.namedBindings.elements) map.set(e.name.text, spec);
        } else if (ts.isNamespaceImport(c.namedBindings)) {
          map.set(c.namedBindings.name.text, spec);
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return map;
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

/** All identifiers in a module (used once we have entered a helper). */
function allIdentifiers(sf, ts) {
  const ids = new Set();
  const walk = (n) => { if (ts.isIdentifier(n)) ids.add(n.text); ts.forEachChild(n, walk); };
  walk(sf);
  return ids;
}

/**
 * Bounded call-graph walk from a route's exported handlers. Returns the source text of every
 * helper module the handlers actually reach, excluding leaf modules. This is the escape-2 fix.
 */
function delegatedSources(root, routeFile, ts) {
  const out = [];
  const seen = new Set([routeFile]);
  const start = ts.createSourceFile(routeFile, fs.readFileSync(routeFile, "utf8"),
    ts.ScriptTarget.Latest, true);

  let frontier = [{ sf: start, file: routeFile, ids: identifiersInHandlers(start, ts), depth: 0 }];
  while (frontier.length) {
    const next = [];
    for (const { sf, file, ids, depth } of frontier) {
      if (depth >= MAX_DEPTH) continue;
      const imports = importMap(sf, ts);
      for (const [name, spec] of imports) {
        if (!ids.has(name)) continue;                     // not referenced by what we entered
        const resolved = resolveImport(root, file, spec);
        if (!resolved || seen.has(resolved)) continue;
        if (WALK_LEAF.test(path.basename(resolved))) continue;   // access layer is a leaf
        seen.add(resolved);
        const text = fs.readFileSync(resolved, "utf8");
        out.push({ file: path.relative(root, resolved).replace(/\\/g, "/"), text });
        const childSf = ts.createSourceFile(resolved, text, ts.ScriptTarget.Latest, true);
        next.push({ sf: childSf, file: resolved, ids: allIdentifiers(childSf, ts), depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return out;
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
      "delegated helper is now measured too (escape 2), and it still reaches no crime-database " +
      "reader and returns no rows: it writes audit rows and checks its own tables. " +
      "(An earlier entry claimed writesOnly=true; the claim check rejected it, because the " +
      "INSERT is in the lib, not in the route.)",
    claims: { readsCrimeDb: false, returnsRows: false, invokesModel: false },
  },
  {
    route: "app/api/session-analytics/route.ts",
    reason:
      "Meta-analytics ABOUT the application, not an answer FROM it. Every SELECT targets " +
      "query_log — queries per day, tab breakdown, session distribution, error rate, referrers. " +
      "It reads no crime database, answers no user question, and is credential-gated. It " +
      "aggregates the same table P2.4's outcome rows live in, which makes it a consumer of the " +
      "outcome model, never a producer of a typed outcome. It returns named aggregates " +
      "(queriesPerDay, tabBreakdown, errorRate, ...), not a row set, which is why returnsRows " +
      "is measured false here and true for query-log below.",
    claims: { readsCrimeDb: false, returnsRows: false, invokesModel: false, requiresCredential: true },
  },
  {
    route: "app/api/query-log/route.ts",
    reason:
      "THE ARGUABLE ONE, excluded deliberately and named here so it is never excluded silently. " +
      "Its POST re-runs an operator-supplied SQL statement against nibrs / shr / hate_crime / " +
      "rtci and returns up to 500 raw rows, so it genuinely does return crime-database content. " +
      "It is still not a terminal factual-answer exit under the P2.1 definition: there is no " +
      "user question, no model-composed answer, and therefore no delivery DECISION to classify " +
      "— the caller already knows what they asked for. It is a log-viewer tool gated on LOG_KEY, " +
      "not the public question flow. Its caller-supplied-SQL design is a separately scoped " +
      "security concern, deferred by owner decision on 2026-08-31; that concern does not make it " +
      "a missing typed-outcome route. If it ever gains a question-shaped entry point or composes " +
      "an answer, this exclusion must be revisited and the route sealed.",
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
 * Measures a route over its own source PLUS the helper modules its exported handlers actually
 * reach. `ownOnly` fields are retained so the write-only controls stay anchored to the route
 * file, which is where that property is meaningful.
 */
function measure(root, file, ts) {
  ts = ts || loadTs(root);
  const own = fs.readFileSync(file, "utf8");
  const delegated = delegatedSources(root, file, ts);
  const union = [own, ...delegated.map((d) => d.text)].join("\n");
  const rel = path.relative(root, file).replace(/\\/g, "/");

  const readerIn = (src) => CRIME_DB_READERS.filter((a) => new RegExp(`\\b${a}\\s*\\(`).test(src));
  const readOpIn = (src) => READ_OPS.some((op) => src.includes(op));
  const writeOpIn = (src) => WRITE_OPS.some((op) => new RegExp(`\\b${op}\\b`).test(src));
  const rowsIn = (src) => /\brows\b/.test(src) && /NextResponse\.json|new Response|Response\.json/.test(src);

  // `returnsRows` is measured PER SOURCE UNIT, never over the concatenation. Measuring it over
  // the union invented a pairing that exists in no file: `chart-audit.ts` uses `rows` as a type
  // field name and the route separately calls `Response.json`, so the union matched both tokens
  // and reported a receipt-writer as returning rows. Requiring one file to contain the row
  // binding AND the response still catches the escape-2 helper, whose body is
  // `const rows = ...; return Response.json({ rows })`.
  const units = [own, ...delegated.map((d) => d.text)];

  return {
    route: rel,
    sealed: SEAL_PRIMITIVES.some((p) => own.includes(p)),
    // Union measurement is correct HERE: accessor names are distinctive, and a genuine
    // delegation can obtain the handle in the route and perform the read in the helper.
    readsCrimeDb: readerIn(union).length > 0 && readOpIn(union),
    readersUsed: readerIn(union),
    returnsRows: units.some((u) => rowsIn(u)),
    invokesModel: /anthropic|messages\.create/i.test(union),
    requiresCredential: /LOG_KEY|authorizeAnalytics|Unauthorized/.test(union),
    // Anchored to the route's own source: "this route only writes" is a statement about it.
    writesOnly: writeOpIn(own) && !readOpIn(own),
    delegatedModules: delegated.map((d) => d.file),
  };
}

/**
 * Returns { ok, routes, failures }. Failure kinds:
 *   unsealed-unregistered — a route is neither sealed nor excluded
 *   claim-mismatch        — a registered exclusion states something the source contradicts
 *   stale-exclusion       — a registry entry names a route that no longer exists
 *   sealed-and-excluded   — a route is both sealed and registered as excluded
 */
function checkEligibility(root) {
  const ts = loadTs(root);
  const measured = routeFiles(root).map((f) => measure(root, f, ts));
  const byRoute = new Map(measured.map((m) => [m.route, m]));
  const failures = [];

  for (const m of measured) {
    const ex = EXCLUSIONS.find((e) => e.route === m.route);
    if (!m.sealed && !ex) {
      failures.push({
        kind: "unsealed-unregistered", route: m.route,
        detail: `not sealed and not in the exclusion registry (readsCrimeDb=${m.readsCrimeDb}, ` +
                `returnsRows=${m.returnsRows}, invokesModel=${m.invokesModel}` +
                (m.delegatedModules.length ? `, via ${m.delegatedModules.join(",")}` : "") + ")",
      });
    }
    if (m.sealed && ex) {
      failures.push({ kind: "sealed-and-excluded", route: m.route,
        detail: "route seals outcomes but is also registered as excluded" });
    }
  }

  for (const e of EXCLUSIONS) {
    const m = byRoute.get(e.route);
    if (!m) {
      failures.push({ kind: "stale-exclusion", route: e.route,
        detail: "registry names a route that does not exist in the tree" });
      continue;
    }
    for (const [k, want] of Object.entries(e.claims)) {
      if (m[k] !== want) {
        failures.push({ kind: "claim-mismatch", route: e.route,
          detail: `exclusion claims ${k}=${want}, source measures ${k}=${m[k]}` +
                  (m.delegatedModules.length ? ` (incl. delegated ${m.delegatedModules.join(",")})` : "") });
      }
    }
    if (!e.reason || e.reason.trim().length < 40) {
      failures.push({ kind: "claim-mismatch", route: e.route,
        detail: "exclusion reason is missing or too short to be a justification" });
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
  checkEligibility, measure, routeFiles, delegatedSources,
  EXCLUSIONS, CRIME_DB_READERS, SEAL_PRIMITIVES, ROUTE_BASENAMES, WALK_LEAF, MAX_DEPTH,
};
