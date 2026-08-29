/**
 * AST-backed terminal-exit inventory for the four question routes and the embed read.
 *
 * WHY THIS IS NOT GREP. Round 1 of the P2.1 review measured this inventory with `grep` and got
 * three numbers wrong, including missing an exit entirely: `app/api/query/route.ts` hoists one
 * action into a local `const` and passes it as a shorthand property, so no literal appears at the
 * call site. The compiler API sees it; a regular expression never will.
 *
 * WHY SITES ARE NOT ADDRESSED BY LINE NUMBER. P2.2 adds arguments and branches to these files, so
 * any tracked assertion keyed to a committed line fails on its own first commit. Every site here
 * carries a structural fingerprint — the enclosing function/closure chain, the containing
 * statement kind, and the finalization's own planFamily or guardrail label — which survives
 * reformatting and insertion above it.
 *
 * TWO LOAD-BEARING PROPERTIES OF THE TERMINATION ANALYSIS, both established by running it rather
 * than by assuming:
 *
 *   1. Termination is NOT "an unconditional `return` follows". On the SSE route a response ends
 *      when the stream closes: the outer catch enqueues an error event and closes in `finally`.
 *      A predicate that demanded a `return` reports that site as non-terminating.
 *   2. A logging SITE and a terminal PATH are different objects. One `nibrs-query` site always
 *      writes its operational row but returns only on the timeout branch; on the other branch it
 *      warns and continues to a later decision exit. So one request can write two rows, and any
 *      rule that inferred eligibility from a NULL outcome would mislabel it.
 *
 * WHY PAIRING IS MEASURED, NOT ASSUMED. Counting finalizers and seals proves an exit COMPUTED an
 * outcome. It does not prove the row that exit writes PERSISTS it. Two source-switch exits called
 * `logQuery` directly, passing `proofLogFields(...)` and nothing else, so their decision rows would
 * have been written with a NULL record_kind after activation while every route-level assertion
 * still passed. This module therefore resolves, per decision site, the logger call that carries its
 * finalization, and classifies how that call projects it.
 */
const fs = require("fs");
const path = require("path");

function loadTypeScript(repoRoot) {
  return require(path.join(repoRoot, "node_modules", "typescript"));
}

const ROUTE_FILES = [
  { route: "query", rel: "app/api/query/route.ts", logger: "writeLog" },
  { route: "nibrs-query", rel: "app/api/nibrs-query/route.ts", logger: "writeNibrsLog" },
  { route: "shr-query", rel: "app/api/shr-query/route.ts", logger: "writeLog" },
  { route: "hc-query", rel: "app/api/hc-query/route.ts", logger: "writeLog" },
];
const EMBED_FILE = { route: "embed", rel: "app/api/embed/route.ts", logger: null };

const FINALIZERS = new Set(["finalizeExit", "finalizeProof"]);
const LOGGERS = new Set(["writeLog", "writeNibrsLog", "logQuery", "logNibrsQuery"]);
const SEAL = "emitFactualPayload";
const OPERATIONAL_MARKER = "OPERATIONAL_RECORD";

function walk(node, visit, ts) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit, ts));
}

function calleeName(node, ts) {
  if (!ts.isCallExpression(node)) return null;
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** The enclosing named function / closure chain. Part of the fingerprint. */
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

/** The kind of statement the call sits in — `return`, `if`, an expression statement, and so on. */
function containingStatementKind(node, sf, ts) {
  let n = node.parent;
  while (n && !ts.isStatement(n)) n = n.parent;
  return n ? ts.SyntaxKind[n.kind] : "<none>";
}

function stringProp(objectLiteral, name, sf, ts) {
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) return null;
  const p = objectLiteral.properties.find((x) => x.name && x.name.getText(sf) === name);
  if (!p || !ts.isPropertyAssignment(p)) return null;
  if (ts.isStringLiteral(p.initializer)) return p.initializer.text;
  if (ts.isArrayLiteralExpression(p.initializer)) {
    return p.initializer.elements
      .map((el) => (ts.isStringLiteral(el) ? el.text : "<expr>"))
      .join("|");
  }
  return "<expr>";
}

/**
 * How the site supplies its outcome.
 *   literal   — `outcome: OUTCOMES.<reason>`
 *   computed  — `outcome: <pred> ? OUTCOMES.<a> : OUTCOMES.<b>`, both arms whole constants
 *   hoisted   — the same, via a local `const outcome = …` referenced by a shorthand property
 *   absent    — no `outcome` property at all
 *   parallel  — a conditional whose arms are NOT whole outcome constants (the shape T7b forbids)
 */
function outcomeShape(call, sf, ts) {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return { form: "absent" };
  const prop = arg.properties.find((p) => p.name && p.name.getText(sf) === "outcome");
  if (!prop) return { form: "absent" };

  const constantReason = (expr) => {
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) &&
        expr.expression.text === "OUTCOMES") return expr.name.text;
    return null;
  };

  const classify = (expr, via) => {
    const direct = constantReason(expr);
    if (direct) return { form: "literal", reason: direct, via };
    if (ts.isConditionalExpression(expr)) {
      const t = constantReason(expr.whenTrue);
      const f = constantReason(expr.whenFalse);
      if (t && f) {
        return { form: via ? "hoisted" : "computed", whenTrue: t, whenFalse: f, via,
                 predicate: expr.condition.getText(sf) };
      }
      return { form: "parallel", predicate: expr.condition.getText(sf), via };
    }
    return null;
  };

  if (ts.isPropertyAssignment(prop)) {
    const direct = classify(prop.initializer, null);
    if (direct) return direct;
    if (ts.isIdentifier(prop.initializer)) return resolveLocal(prop.initializer.text, sf, ts, classify);
    return { form: "other", text: prop.initializer.getText(sf).slice(0, 80) };
  }
  if (ts.isShorthandPropertyAssignment(prop)) return resolveLocal(prop.name.text, sf, ts, classify);
  return { form: "other" };
}

function resolveLocal(ident, sf, ts, classify) {
  let found = { form: "unresolved", via: ident };
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === ident && n.initializer) {
      const c = classify(n.initializer, ident);
      if (c) found = c;
    }
  }, ts);
  return found;
}

/**
 * Whether the path leaving this statement terminates the response.
 *
 * Three ways a path can end, and the SSE one is why this cannot be a `return` check:
 *   - an unconditional `return` or `throw` later in the same block;
 *   - a `close()` call, which ends an SSE response by closing the stream;
 *   - `controller.close()` reached through a `finally`.
 *
 * Returns { terminal, conditional, how }. `conditional: true` means the statement is inside an
 * `if` whose other branch continues — the mid-flight case.
 */
function terminationOf(node, sf, ts) {
  let stmt = node.parent;
  while (stmt && !ts.isStatement(stmt)) stmt = stmt.parent;
  if (!stmt) return { terminal: false, conditional: false, how: "no-statement" };

  const block = stmt.parent;
  let how = null;
  if (block && ts.isBlock(block)) {
    const stmts = block.statements;
    const idx = stmts.indexOf(stmt);
    for (let i = idx; i < stmts.length; i++) {
      const s = stmts[i];
      if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) { how = "return"; break; }
      let closes = false;
      walk(s, (n) => {
        const name = calleeName(n, ts);
        if (name === "close") closes = true;
        if (name === "close" && ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === "close") closes = true;
      }, ts);
      if (closes) { how = "stream-close"; break; }
    }
  }

  // The SSE outer catch closes the stream in the enclosing try's `finally`, not in its own block.
  // Without this the predicate reports that site as non-terminating, which is exactly the failure
  // P2.1 §0.11 found by running the check instead of assuming it.
  if (!how) {
    let t = stmt.parent;
    while (t && !ts.isFunctionLike(t)) {
      if (ts.isTryStatement(t) && t.finallyBlock) {
        let closes = false;
        walk(t.finallyBlock, (n) => { if (calleeName(n, ts) === "close") closes = true; }, ts);
        if (closes) { how = "stream-close-finally"; break; }
      }
      t = t.parent;
    }
  }

  // Inside an `if` whose consequent returns but whose alternate continues?
  let conditional = false;
  let p = stmt.parent;
  while (p && !ts.isFunctionLike(p)) {
    if (ts.isIfStatement(p)) { conditional = true; break; }
    p = p.parent;
  }
  return { terminal: Boolean(how), conditional, how: how || "falls-through" };
}

/**
 * Does this route-local closure body project BOTH projectors from its carrier parameter?
 *
 * The closure is the indirection every ordinary exit goes through, so proving it once and then
 * proving each exit reaches it is what makes the per-site claim true.
 */
/**
 * The closure's carrier parameter: the one declared to accept either a finalization or an
 * operational record. Identified from its type annotation rather than its name, so renaming the
 * parameter does not silently disable this analysis.
 */
function closureCarrierParam(closureNode, sf, ts) {
  for (const param of closureNode.parameters) {
    if (!ts.isIdentifier(param.name) || !param.type) continue;
    const annotation = param.type.getText(sf);
    if (annotation.includes("ProofFinalization") && annotation.includes("OutcomeLogRecord")) {
      return param.name.text;
    }
  }
  return null;
}

/** Names that alias the carrier WITHIN the closure's own lexical scope. */
function carrierAliasesInClosure(closureNode, carrier, sf, ts) {
  const names = new Set([carrier]);
  let grew = true;
  while (grew) {
    grew = false;
    walk(closureNode, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
          ts.isIdentifier(n.initializer) && names.has(n.initializer.text) &&
          !names.has(n.name.text)) { names.add(n.name.text); grew = true; }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left) && ts.isIdentifier(n.right) && names.has(n.right.text) &&
          !names.has(n.left.text)) { names.add(n.left.text); grew = true; }
    }, ts);
  }
  return names;
}

/**
 * Whether this closure projects BOTH column families FROM THE SAME CARRIER.
 *
 * TWO BOOLEANS ARE NOT ENOUGH, and that was the round-2 finding. An earlier version set one flag
 * on seeing any `proofLogFields(decisionFinalization(…))` and another on seeing any
 * `outcomeLogFields(asOutcomeRecord(…))`, without checking what those wrappers received. So this
 * would have been accepted:
 *
 *     proofLogFields(decisionFinalization(proof)),
 *     outcomeLogFields(asOutcomeRecord(null))     // <- projects nothing, from nothing
 *
 * The route would have written a real proof projection beside an all-NULL outcome projection while
 * every exit using the closure stayed classified as correctly paired -- the same false acceptance
 * as round one, one indirection deeper.
 *
 * The check is deliberately lexical and closure-local: both wrapper chains must terminate in the
 * closure's own carrier parameter, or in a name that aliases it inside the closure. That is all the
 * current tree needs; it is not a symbol-resolution pass.
 *
 * Returns { ok, carrier, proofCarrier, outcomeCarrier, reason }.
 */
function closureProjectsBoth(closureNode, sf, ts) {
  const carrier = closureCarrierParam(closureNode, sf, ts);
  if (!carrier) {
    return { ok: false, carrier: null, reason: "no parameter accepts ProofFinalization | OutcomeLogRecord" };
  }
  const carriers = carrierAliasesInClosure(closureNode, carrier, sf, ts);

  // What each wrapper chain actually receives. `null` means the wrapper was called with something
  // that is not the carrier -- a literal, a different binding, anything.
  const received = (call, wrapper) => {
    const arg = call.arguments[0];
    if (!arg || calleeName(arg, ts) !== wrapper) return { present: false };
    const inner = arg.arguments[0];
    if (!inner) return { present: true, name: null };
    return { present: true, name: ts.isIdentifier(inner) ? inner.text : null };
  };

  const proofChains = [];
  const outcomeChains = [];
  walk(closureNode, (n) => {
    const name = calleeName(n, ts);
    if (name === "proofLogFields") proofChains.push(received(n, "decisionFinalization"));
    if (name === "outcomeLogFields") outcomeChains.push(received(n, "asOutcomeRecord"));
  }, ts);

  if (proofChains.length === 0) return { ok: false, carrier, reason: "no proofLogFields projection" };
  if (outcomeChains.length === 0) return { ok: false, carrier, reason: "no outcomeLogFields projection" };

  // EVERY projection must be well formed, not merely one of them: a closure that projects
  // correctly once and incorrectly elsewhere is still writing an unclassified row somewhere.
  const bad = (chains, wrapper) => chains.find(
    (c) => !c.present || c.name === null || !carriers.has(c.name));
  const badProof = bad(proofChains, "decisionFinalization");
  if (badProof) {
    return { ok: false, carrier, reason:
      `proofLogFields does not receive decisionFinalization(${carrier}); it receives ` +
      `${badProof.present ? String(badProof.name) : "no decisionFinalization wrapper"}` };
  }
  const badOutcome = bad(outcomeChains, "asOutcomeRecord");
  if (badOutcome) {
    return { ok: false, carrier, reason:
      `outcomeLogFields does not receive asOutcomeRecord(${carrier}); it receives ` +
      `${badOutcome.present ? String(badOutcome.name) : "no asOutcomeRecord wrapper"}` };
  }

  const proofCarrier = proofChains[0].name;
  const outcomeCarrier = outcomeChains[0].name;
  if (proofCarrier !== outcomeCarrier && !(carriers.has(proofCarrier) && carriers.has(outcomeCarrier))) {
    return { ok: false, carrier, proofCarrier, outcomeCarrier,
             reason: "the two projections do not share a carrier" };
  }
  return { ok: true, carrier, proofCarrier, outcomeCarrier, reason: null };
}

/**
 * Names that carry a finalization binding, following assignment aliases.
 *
 * `let delivered = finalization; ... delivered = postFinalization; writeLog(..., delivered)` is a
 * real and correct pattern: the exit re-finalizes against refined narrative and logs whichever
 * finalization was actually delivered. A pairing check that only looked for the original binding
 * name reported both such sites as unpaired, which is a false POSITIVE -- the mirror image of the
 * false negative that let the direct-call bypasses through. Both directions have to be right, so
 * aliases are resolved transitively.
 */
function aliasesOf(binding, sf, ts) {
  const names = new Set([binding]);
  let grew = true;
  while (grew) {
    grew = false;
    walk(sf, (n) => {
      // const/let x = <carrier>
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
          ts.isIdentifier(n.initializer) && names.has(n.initializer.text) && !names.has(n.name.text)) {
        names.add(n.name.text); grew = true;
      }
      // x = <carrier>
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left) && ts.isIdentifier(n.right) && names.has(n.right.text) &&
          !names.has(n.left.text)) {
        names.add(n.left.text); grew = true;
      }
    }, ts);
  }
  return names;
}

/** Every identifier appearing anywhere inside a node. */
function identifiersIn(node, sf, ts) {
  const names = new Set();
  walk(node, (n) => { if (ts.isIdentifier(n)) names.add(n.text); }, ts);
  return names;
}

/**
 * Classify how a logger call persists a given finalization binding.
 *
 *   "closure"        the call target is a route-local closure that projects both, and the binding
 *                    is among its arguments;
 *   "direct-both"    a module logger call projects proofLogFields(...binding...) AND
 *                    outcomeLogFields(...binding...);
 *   "direct-partial" a module logger call projects one but not the other -- the bypass;
 *   null             this call does not carry the binding.
 */
function pairingKind(callNode, carriers, closureNames, sf, ts) {
  const name = calleeName(callNode, ts);
  if (!name || !LOGGERS.has(name)) return null;
  const holds = (node) => {
    const ids = identifiersIn(node, sf, ts);
    for (const c of carriers) if (ids.has(c)) return true;
    return false;
  };
  if (!callNode.arguments.some(holds)) return null;
  if (closureNames.has(name)) return "closure";
  let proof = false;
  let outcome = false;
  for (const a of callNode.arguments) {
    const inner = calleeName(a, ts);
    if (inner === "proofLogFields" && holds(a)) proof = true;
    if (inner === "outcomeLogFields" && holds(a)) outcome = true;
  }
  return proof && outcome ? "direct-both" : "direct-partial";
}

/** Build the inventory for one file. */
function inventoryFile(repoRoot, spec, ts) {
  const abs = path.join(repoRoot, spec.rel);
  const text = fs.readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ES2022, true);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const closures = [];
  const loggerClosures = new Map();   // name -> { node, projectsBoth }
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) &&
        (FINALIZERS.has(n.name.text) || LOGGERS.has(n.name.text)) && n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      closures.push(n.initializer);
      if (LOGGERS.has(n.name.text)) {
        const analysis = closureProjectsBoth(n.initializer, sf, ts);
        loggerClosures.set(n.name.text,
          { node: n.initializer, projectsBoth: analysis.ok, analysis });
      }
    }
  }, ts);
  const bothProjectingClosures = new Set(
    [...loggerClosures.entries()].filter(([, v]) => v.projectsBoth).map(([k]) => k));
  const inClosure = (n) =>
    closures.some((c) => n.getStart() >= c.getStart() && n.getEnd() <= c.getEnd());

  const sealedBindings = new Set();
  walk(sf, (n) => {
    if (calleeName(n, ts) === SEAL) {
      const a = n.arguments[0];
      if (a && ts.isIdentifier(a)) sealedBindings.add(a.text);
    }
  }, ts);

  const sealSites = [];
  const finalizations = [];
  const loggerCalls = [];
  walk(sf, (n) => {
    const name = calleeName(n, ts);
    if (name === SEAL) sealSites.push(lineOf(n));
    if (name && FINALIZERS.has(name) && !inClosure(n)) finalizations.push(n);
    if (name && LOGGERS.has(name)) loggerCalls.push({ node: n, inClosure: inClosure(n), line: lineOf(n) });
  }, ts);

  const fingerprintSeen = new Map();
  const sites = finalizations.map((call) => {
    const arg = call.arguments[0];
    let binding = null;
    let p = call.parent;
    while (p && !ts.isVariableDeclaration(p) && !ts.isSourceFile(p)) p = p.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) binding = p.name.text;
    let inlineSealed = false;
    let q = call.parent;
    while (q && !ts.isCallExpression(q)) q = q.parent;
    if (q && calleeName(q, ts) === SEAL) inlineSealed = true;

    const shape = outcomeShape(call, sf, ts);
    const planFamily = stringProp(arg, "planFamily", sf, ts);
    const guardrails = stringProp(arg, "guardrails", sf, ts);
    return {
      route: spec.route,
      file: spec.rel,
      line: lineOf(call),
      fingerprint: (() => {
        const stem = [spec.route, enclosingChain(call, sf, ts), containingStatementKind(call, sf, ts),
                      planFamily || "-", guardrails || "-",
                      shape.form === "literal" ? shape.reason
                        : shape.form === "computed" || shape.form === "hoisted"
                          ? `${shape.whenTrue}|${shape.whenFalse}` : shape.form].join("::");
        // Two sites can share every structural feature above — a guardrail pair that finalizes
        // identically in both arms of a retry, for instance. An ordinal keeps the fingerprint
        // unique without reintroducing a line number: it shifts only if a sibling is added or
        // removed, which is a real inventory change and should fail.
        const n = (fingerprintSeen.get(stem) || 0) + 1;
        fingerprintSeen.set(stem, n);
        return n === 1 ? stem : `${stem}#${n}`;
      })(),
      sealed: inlineSealed || (binding !== null && sealedBindings.has(binding)),
      outcome: shape,
      planFamily,
      guardrails,
      termination: terminationOf(call, sf, ts),
      // How the row this exit writes actually persists the outcome. `binding` is the local the
      // finalization was assigned to; an inline-sealed exit has none and is reported as such.
      pairing: (() => {
        if (!binding || binding === "<inline-sealed>") {
          return { kind: "no-binding", loggerLines: [] };
        }
        const carriers = aliasesOf(binding, sf, ts);
        const matches = [];
        // Only logger calls at EXIT sites are candidates. The route-local closure's own body
        // contains a module-logger call whose arguments name the closure parameter, and that
        // parameter is often spelled the same as an exit's binding -- matching it would report
        // every ordinary exit as a direct call and hide the real bypasses.
        for (const { node, inClosure: loggerInClosure } of loggerCalls) {
          if (loggerInClosure) continue;
          const kind = pairingKind(node, carriers, bothProjectingClosures, sf, ts);
          if (kind) matches.push({ kind, line: lineOf(node) });
        }
        if (matches.length === 0) return { kind: "unpaired", loggerLines: [] };
        // Worst case governs: one partial projection is a defect even beside a good one.
        const order = { "direct-partial": 0, unpaired: 1, closure: 2, "direct-both": 2 };
        matches.sort((a, b) => order[a.kind] - order[b.kind]);
        return { kind: matches[0].kind, loggerLines: matches.map((m) => m.line) };
      })(),
    };
  });

  // Operational rows: a logger call whose outcome argument is the operational marker.
  // A local `const x = OPERATIONAL_RECORD` counts: several sites bind the marker before logging
  // it, and a detector that only matched the bare identifier at the call silently under-counted.
  const markerAliases = new Set([OPERATIONAL_MARKER]);
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        ts.isIdentifier(n.initializer) && n.initializer.text === OPERATIONAL_MARKER) {
      markerAliases.add(n.name.text);
    }
  }, ts);

  const operational = [];
  for (const { node, inClosure: inC } of loggerCalls) {
    let marked = false;
    for (const a of node.arguments) {
      if (ts.isIdentifier(a) && markerAliases.has(a.text)) marked = true;
      if (calleeName(a, ts) === "outcomeLogFields" && a.arguments[0] &&
          ts.isIdentifier(a.arguments[0]) && markerAliases.has(a.arguments[0].text)) marked = true;
    }
    if (!marked) continue;
    operational.push({
      route: spec.route,
      file: spec.rel,
      line: lineOf(node),
      inClosure: inC,
      fingerprint: [spec.route, enclosingChain(node, sf, ts),
                    containingStatementKind(node, sf, ts), "operational"].join("::"),
      termination: terminationOf(node, sf, ts),
    });
  }

  return {
    route: spec.route,
    file: spec.rel,
    loggerClosures: [...loggerClosures.entries()].map(([name, v]) => ({
      name, projectsBoth: v.projectsBoth, carrier: v.analysis.carrier,
      proofCarrier: v.analysis.proofCarrier ?? null, outcomeCarrier: v.analysis.outcomeCarrier ?? null,
      reason: v.analysis.reason })),
    sealSiteCount: sealSites.length,
    finalizationCount: finalizations.length,
    loggerCallCount: loggerCalls.length,
    loggerExitCallCount: loggerCalls.filter((l) => !l.inClosure).length,
    sites,
    operational,
    source: text,
  };
}

function buildInventory(repoRoot) {
  const ts = loadTypeScript(repoRoot);
  const routes = ROUTE_FILES.map((spec) => inventoryFile(repoRoot, spec, ts));
  const embed = inventoryFile(repoRoot, EMBED_FILE, ts);
  const allSites = routes.flatMap((r) => r.sites);
  return {
    routes,
    embed,
    decisionSites: allSites.filter((s) => s.sealed),
    operationalRows: routes.flatMap((r) => r.operational),
    unsealedSites: allSites.filter((s) => !s.sealed),
    sealSiteTotal: routes.reduce((n, r) => n + r.sealSiteCount, 0),
    // Decision sites whose row would NOT carry the outcome: an unpaired exit, or a direct logger
    // call that projects proof without outcome.
    unpairedDecisionSites: allSites.filter(
      (s) => s.sealed && (s.pairing.kind === "unpaired" || s.pairing.kind === "direct-partial" ||
                          s.pairing.kind === "no-binding")),
  };
}

module.exports = { buildInventory, inventoryFile, ROUTE_FILES, EMBED_FILE, loadTypeScript };
