#!/usr/bin/env npx tsx
/**
 * Tailwind source boundary — the release build must never read documentation as markup.
 *
 * WHY THIS EXISTS. On 2026-09-03 the production Linux build of `dev` failed inside Tailwind with
 * `app/globals.css:1:1 / Invalid code point 16720832`. The stylesheet was fine. Tailwind v4's
 * automatic source detection had scanned the whole project, found a committed handoff quoting a
 * scratchpad path, tokenised part of it as a CSS custom property with a six-hex-digit escape above
 * U+10FFFF, and `String.fromCodePoint` threw — proven by controlled ablation on native x64
 * (docs/superpowers/2026-09-03-p3-1a-ff23c0-ablation-result.md, ROW C1). The remedy is that
 * `app/globals.css` declares `source(none)` and exactly two roots, `../app` and `../components`.
 *
 * WHAT IS PROVED HERE, in-process, with Tailwind's own compiler and scanner:
 *   1. the stylesheet declares the boundary: automatic detection off, roots exactly app/ + components/;
 *   2. two-direction canary in an isolated temp project: a token placed only under docs/ is not
 *      scanned and not emitted, the same class of token under components/ is; and a docs file
 *      carrying a synthetic out-of-range escape does not reach the build — while scanning docs/
 *      explicitly reproduces the exact RangeError, so the hazard is real and the boundary is what
 *      prevents it;
 *   3. static accounting over the REAL app/ + components/: every candidate Tailwind can compile is
 *      emitted by a boundary-scoped build — every conditional and template branch included, because
 *      the scanner reads source text, not executed paths; unresolved candidates are reported;
 *   4. the dropped set: utilities that project-wide scanning would have harvested from non-runtime
 *      text, listed in full; the test fails if any of them has an app/ or components/ source.
 *
 * With `--emitted <dir>` (used by the Linux release-build gate after `next build`) it additionally
 * parses the emitted stylesheets and checks the same expectations against what shipped.
 *
 * Selectors are compared with postcss, never by regex over minified CSS.
 *
 * Tier F: no database, no network, no server. Deterministic. Runs in a few seconds.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postcss from "postcss";
import { Scanner } from "@tailwindcss/oxide";
import { compile, __unstable__loadDesignSystem } from "tailwindcss";

const REPO = path.resolve(__dirname, "..");
const APP = path.join(REPO, "app");
const COMPONENTS = path.join(REPO, "components");
const STYLESHEET = path.join(APP, "globals.css");
const TAILWIND_PKG = path.dirname(require.resolve("tailwindcss/package.json"));

const emittedArg = process.argv.indexOf("--emitted");
const EMITTED_DIR = emittedArg >= 0 ? path.resolve(process.argv[emittedArg + 1]) : null;

let checks = 0;
function check(cond: boolean, message: string) {
  assert(cond, message);
  checks++;
}
const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").toLowerCase();

/* ------------------------------------------------------------------ */
/*  Tailwind plumbing                                                  */
/* ------------------------------------------------------------------ */

async function loadStylesheet(id: string, base: string) {
  // Only the tailwindcss package stylesheets are imported by app/globals.css.
  if (id === "tailwindcss" || id.startsWith("tailwindcss/")) {
    const file = id === "tailwindcss" ? "index.css" : id.replace(/^tailwindcss\//, "");
    const full = path.join(TAILWIND_PKG, file);
    return { path: full, base: TAILWIND_PKG, content: fs.readFileSync(full, "utf8") };
  }
  const full = path.resolve(base, id);
  return { path: full, base: path.dirname(full), content: fs.readFileSync(full, "utf8") };
}
const loadModule = async () => {
  throw new Error("app/globals.css must not load JS modules");
};

type Source = { base: string; pattern: string; negated: boolean };

async function compileStylesheet(cssPath: string) {
  const css = fs.readFileSync(cssPath, "utf8");
  const compiler = await compile(css, { base: path.dirname(cssPath), loadStylesheet, loadModule });
  return { css, compiler };
}

function scan(sources: Source[]): string[] {
  return new Scanner({ sources }).scan();
}

/**
 * NORMALISATION, declared. Tailwind emits utilities as NESTED rules —
 * `.group-hover\:gap-2 { &:is(:where(.group):hover *) {…} }`, `.space-y-2 { :where(& > :not(:last-child)) {…} }`
 * — while the shipped build has been flattened by Lightning CSS to
 * `.group-hover\:gap-2:is(:where(.group):hover *)` and `:where(.space-y-2>:not(:last-child))`, and
 * `hover:` utilities move under `@media (hover: hover)`. Whole-selector comparison therefore
 * disagrees on every variant, and in the `space-*` family the class does not even lead the
 * selector any more. What both forms share is the ESCAPED CLASS TOKENS they contain. So both sides
 * are reduced to the set of every class token appearing anywhere in a selector: an unescaped `.`
 * starts a token, `\x` escape pairs are consumed as part of the name, and any unescaped
 * whitespace, `:`, `.`, `[`, `]`, `(`, `)`, `>`, `+`, `~`, `,` or `*` ends it. Applied identically
 * to Tailwind's own output and to the emitted stylesheet, so marker classes such as `.group` appear
 * on both sides and cancel. Parsing is postcss; the walk is over its already-split `rule.selectors`.
 */
function classTokens(selector: string): string[] {
  const out: string[] = [];
  const s = selector;
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\\") { i += 2; continue; }               // an escape outside a token: skip the pair
    if (s[i] !== ".") { i++; continue; }
    let tok = ".";
    i++;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") { tok += s.slice(i, i + 2); i += 2; continue; }
      if (/[\s:.\[\]()>+~,*]/.test(ch)) break;
      tok += ch; i++;
    }
    if (tok.length > 1) out.push(tok);
  }
  return out;
}

/** The set of class tokens in a stylesheet, via postcss. */
function classSelectors(css: string): Set<string> {
  const out = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    for (const sel of rule.selectors) for (const c of classTokens(sel)) out.add(c);
  });
  return out;
}

/** For each candidate Tailwind can compile, the class selectors Tailwind itself emits for it. */
function expectedSelectors(
  ds: { candidatesToCss(c: string[]): (string | null)[] },
  candidates: string[],
): { valid: string[]; selectors: Map<string, Set<string>>; invalid: number } {
  const css = ds.candidatesToCss(candidates);
  const valid: string[] = [];
  const selectors = new Map<string, Set<string>>();
  let invalid = 0;
  candidates.forEach((cand, i) => {
    const c = css[i];
    if (c === null) { invalid++; return; }
    valid.push(cand);
    selectors.set(cand, classSelectors(c));
  });
  return { valid, selectors, invalid };
}

/* ------------------------------------------------------------------ */
/*  1. The stylesheet declares the boundary                            */
/* ------------------------------------------------------------------ */

(async () => {
  const { compiler } = await compileStylesheet(STYLESHEET);

  check(compiler.root === "none", `app/globals.css must declare source(none); got root=${JSON.stringify(compiler.root)}`);
  // Tailwind keeps `@source "../x"` as { base: <stylesheet dir>, pattern: "../x" } and lets the
  // scanner resolve the pattern against the base, so the ROOT a source names is resolve(base, pattern).
  const resolvedRoot = (s: Source) => path.resolve(s.base, s.pattern);
  const roots = compiler.sources.map((s: Source) => norm(resolvedRoot(s))).sort();
  check(
    JSON.stringify(roots) === JSON.stringify([norm(APP), norm(COMPONENTS)].sort()),
    `@source roots must be exactly app/ and components/; got ${JSON.stringify(compiler.sources.map((s: Source) => path.relative(REPO, resolvedRoot(s))))}`,
  );
  check(compiler.sources.every((s: Source) => !s.negated), "no negated @source: the boundary is an allowlist, not a blocklist");
  for (const s of compiler.sources) {
    const r = resolvedRoot(s);
    check(fs.existsSync(r) && fs.statSync(r).isDirectory(), `@source root is not a directory on disk: ${r} — a typo here would silently drop all of that root's CSS`);
  }
  console.log(`boundary: root=none, sources=[${compiler.sources.map((s: Source) => path.relative(REPO, resolvedRoot(s))).join(", ")}]`);

  /* ---------------------------------------------------------------- */
  /*  2. Two-direction canary, isolated temp project                    */
  /* ---------------------------------------------------------------- */

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tw-boundary-"));
  try {
    fs.mkdirSync(path.join(tmp, "app"));
    fs.mkdirSync(path.join(tmp, "components"));
    fs.mkdirSync(path.join(tmp, "docs"));
    fs.copyFileSync(STYLESHEET, path.join(tmp, "app", "globals.css"));
    // Tokens no runtime file uses (asserted at cec0cbc): one per direction, plus a synthetic
    // out-of-range escape of the same shape that crashed production, built here so the raw
    // sequence never appears in a committed file.
    const poison = "--canary" + String.fromCharCode(92) + "ff23c0" + "-not-a-real-path";
    fs.writeFileSync(path.join(tmp, "docs", "canary.md"), `Documentation mentioning mt-[997px] and ${poison} in prose.\n`);
    fs.writeFileSync(path.join(tmp, "components", "Canary.tsx"), `export function Canary() { return <div className="mt-[998px]" />; }\n`);

    const { compiler: c2 } = await compileStylesheet(path.join(tmp, "app", "globals.css"));
    check(c2.root === "none", "temp project: source(none) carried over");
    const boundaryCands = scan(c2.sources);
    check(!boundaryCands.includes("mt-[997px]"), "docs canary must NOT be scanned under the boundary");
    check(boundaryCands.includes("mt-[998px]"), "components canary MUST be scanned under the boundary");
    check(!boundaryCands.some((c) => c.includes("ff23c0")), "the synthetic out-of-range escape must NOT reach the candidate list");

    const emitted = c2.build(boundaryCands);            // must not throw
    const emittedSel = classSelectors(emitted);
    check(emittedSel.has(".mt-\\[998px\\]"), "components canary must be EMITTED");
    check(!emittedSel.has(".mt-\\[997px\\]"), "docs canary must NOT be emitted");

    // The hazard is real: scan docs/ explicitly, as automatic detection would have, and build.
    const docsCands = scan([{ base: path.join(tmp, "docs"), pattern: "**/*", negated: false }]);
    check(docsCands.some((c) => c.includes("ff23c0")), "control: the scanner does extract the escape-bearing token from docs/");
    let threw: unknown = null;
    try { c2.build([...boundaryCands, ...docsCands]); } catch (e) { threw = e; }
    check(
      threw instanceof RangeError && /Invalid code point 16720832/.test(String(threw)),
      `control: building with docs/ scanned must reproduce the production RangeError; got ${threw ? String(threw).slice(0, 80) : "no error"}`,
    );
    console.log("canary: docs token excluded, components token included, synthetic escape blocked; scanning docs/ reproduces RangeError 16720832");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  check(!fs.existsSync(tmp), "temp canary project removed");
  // Nothing about the canary may have touched the repository.
  check(!fs.existsSync(path.join(COMPONENTS, "Canary.tsx")) && !fs.existsSync(path.join(REPO, "docs", "canary.md")), "canary files never enter the repository");

  /* ---------------------------------------------------------------- */
  /*  3. Static accounting over the real roots                          */
  /* ---------------------------------------------------------------- */

  const css = fs.readFileSync(STYLESHEET, "utf8");
  const ds = await __unstable__loadDesignSystem(css, { base: APP, loadStylesheet, loadModule });

  const rootCands = scan(compiler.sources);
  const root = expectedSelectors(ds, rootCands);
  check(root.valid.length > 0, "static accounting found no compilable utilities in app/ + components/ — the scan is not reaching the roots");

  const built = compiler.build(rootCands);                 // the boundary-scoped emission; must not throw
  const builtSel = classSelectors(built);
  const unresolved: string[] = [];
  for (const cand of root.valid) {
    for (const sel of root.selectors.get(cand) ?? []) {
      if (!builtSel.has(sel)) unresolved.push(`${cand} -> ${sel}`);
    }
  }
  console.log(`static accounting: ${rootCands.length} candidates scanned in app/ + components/, ${root.valid.length} compile to CSS, ${root.invalid} are not utilities; ${unresolved.length} unresolved`);
  if (unresolved.length) console.log("  unresolved:\n    " + unresolved.slice(0, 20).join("\n    "));
  check(unresolved.length === 0, `${unresolved.length} runtime utilities compile individually but are missing from the boundary-scoped build`);

  /* ---------------------------------------------------------------- */
  /*  4. The dropped set: what project-wide scanning would have added   */
  /* ---------------------------------------------------------------- */

  const wholeCands = scan([{ base: REPO, pattern: "**/*", negated: false }]);
  const whole = expectedSelectors(ds, wholeCands);         // candidatesToCss does not throw on the escape; build() does
  const rootValid = new Set(root.valid);
  const dropped = whole.valid.filter((c) => !rootValid.has(c)).sort();
  console.log(`dropped: ${dropped.length} utilities that project-wide scanning harvested outside app/ + components/ and the boundary no longer emits:`);
  console.log(dropped.length ? "    " + dropped.join("  ") : "    (none)");

  // Every dropped candidate must be absent from runtime source; a hit means the inventory is wrong.
  const runtimeFiles: string[] = [];
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else runtimeFiles.push(p);
    }
  })(APP);
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else runtimeFiles.push(p);
    }
  })(COMPONENTS);
  // Two independent readings of "has a runtime source". (a) The scanner's own: by construction a
  // dropped candidate is absent from the root scan, so this guards scanner consistency. (b) A
  // token-exact text search over runtime files as a second opinion: split on the delimiters that
  // bound a class token in JSX, TS and strings, then require EXACT equality — a substring test
  // would call "ring" present because "string" is, and "grow" because "flex-grow" is.
  // Stylesheets are excluded from the text search: their tokens are CSS syntax (`border-collapse:
  // collapse;`), not class names, and the scanner does not treat them as markup either.
  const rootCandSet = new Set(rootCands);
  const runtimeTokens = new Set<string>();
  for (const f of runtimeFiles.filter((p) => !p.endsWith(".css"))) {
    for (const tok of fs.readFileSync(f, "utf8").split(/[\s"'`{}()<>;,=]+/)) if (tok) runtimeTokens.add(tok);
  }
  const leaked = dropped.filter((c) => rootCandSet.has(c) || runtimeTokens.has(c));
  check(leaked.length === 0, `dropped utilities that DO appear as a token in app/ or components/ source (inventory gap): ${leaked.join(", ")}`);

  /* ---------------------------------------------------------------- */
  /*  Gate mode: compare against the emitted stylesheets of a real build */
  /* ---------------------------------------------------------------- */

  if (EMITTED_DIR) {
    check(fs.existsSync(EMITTED_DIR), `--emitted directory not found: ${EMITTED_DIR}`);
    const cssFiles: string[] = [];
    (function walk(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (p.endsWith(".css")) cssFiles.push(p);
      }
    })(EMITTED_DIR);
    check(cssFiles.length > 0, `no .css files under ${EMITTED_DIR}`);
    const shipped = new Set<string>();
    for (const f of cssFiles) for (const s of classSelectors(fs.readFileSync(f, "utf8"))) shipped.add(s);

    const missing: string[] = [];
    for (const cand of root.valid) {
      for (const sel of root.selectors.get(cand) ?? []) if (!shipped.has(sel)) missing.push(`${cand} -> ${sel}`);
    }
    const ownRules = classSelectors(css);                 // globals.css's hand-written classes
    const expectedAll = new Set<string>([...builtSel, ...ownRules]);
    const extra = [...shipped].filter((s) => !expectedAll.has(s)).sort();
    console.log(`emitted: ${cssFiles.length} stylesheet(s), ${shipped.size} class selectors; ${missing.length} expected runtime selectors missing; ${extra.length} selectors from outside app/, components/ and globals.css`);
    if (extra.length) console.log("  extra:\n    " + extra.slice(0, 40).join("\n    "));
    check(missing.length === 0, `runtime utilities missing from the emitted CSS:\n    ${missing.slice(0, 20).join("\n    ")}`);
    check(extra.length === 0, `emitted CSS contains selectors that no runtime root or globals.css produced — something outside the boundary is being scanned`);
  }

  console.log(`\ntailwind source boundary tests passed: ${checks} assertions${EMITTED_DIR ? " (including emitted-CSS comparison)" : ""}`);
})().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
