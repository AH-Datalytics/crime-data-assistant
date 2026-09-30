/**
 * Discovery of test-shaped files, and the partition that has to close over them.
 *
 * WHY THIS EXISTS AT ALL. `reconcile()` in ./tier-manifest.js answers two questions -- which commands
 * the harness runs without a manifest entry (`undeclared`), and which manifest entries name a command
 * the harness no longer runs (`stale`). Both are questions ABOUT THE PLAN. Neither can see a file that
 * nothing runs and nothing declares: it is absent from the plan, so it is not undeclared, and absent
 * from the manifest, so it is not stale. "Zero undeclared, zero stale" was therefore true at
 * `15e4801` while fifteen test-shaped files were invisible. This module supplies the third question,
 * which only the filesystem can answer.
 *
 * THE RULE, AND WHY IT IS SEGMENT-BASED RATHER THAN GLOB-BASED. A file is test-shaped when its
 * basename, minus extension, split on `-` and `_`, contains a segment exactly equal to `test`. The
 * revision-1 proposal was the four globs `test-*`, `test_*`, `*-test.*`, `*_test.*`;
 * `audit-test-routing-log.ts` matches none of them, because `test` is a MIDDLE segment. That file was
 * named in revision 1's own disposition matrix while its own discovery rule could not find it, so the
 * central invariant was false for one of the files it listed. Mutation 4 in the contract exists to keep
 * that specific hole closed: deleting that file's exclusion entry must report it unresolved.
 *
 * `.d.ts` is excluded because a declaration file is a type surface, not a test.
 *
 * WHAT THE RULE DOES NOT CLAIM. It is a NAME-based rule. A test named without a `test` segment is
 * outside it by construction. That is stated rather than hidden, and it is also what makes the
 * false-refusal side true: a helper whose basename has no `test` segment, or a file that merely lives
 * under a directory with `test` in its name, is not swept in.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..");

/** Discovery searches here, recursively. Widening this boundary needs its own measured contract. */
const DISCOVERY_ROOT = "scripts";

const EXTENSIONS = [".ts", ".js", ".py", ".ps1"];

/** Directories that hold no authored source. Descending into them is noise, not coverage. */
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git", ".next"]);

/** The segment that makes a basename test-shaped. */
const TEST_SEGMENT = "test";

/**
 * Is this path test-shaped?
 *
 * Takes a repo-relative or bare path and looks only at the basename, so directory names cannot
 * contribute a segment.
 */
function isTestShaped(filePath) {
  const posix = String(filePath).split(path.sep).join("/");
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  if (base.endsWith(".d.ts")) return false;
  const ext = EXTENSIONS.find((e) => base.endsWith(e));
  if (!ext) return false;
  const stem = base.slice(0, -ext.length);
  return stem.split(/[-_]/).includes(TEST_SEGMENT);
}

/** Every file beneath `dir`, repo-relative with `/` separators. */
function walk(dir, repo, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), repo, out);
    } else if (entry.isFile()) {
      out.push(path.relative(repo, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
  return out;
}

/** Every test-shaped file beneath the discovery root, sorted, recursively. */
function discoverTestShaped(repo) {
  const root = repo || REPO;
  const all = walk(path.join(root, DISCOVERY_ROOT), root, []);
  return all.filter(isTestShaped).sort();
}

/** Directories that actually hold test-shaped files -- evidence that recursion did something. */
function discoveryDirectories(discovered) {
  return [...new Set(discovered.map((f) => f.slice(0, f.lastIndexOf("/"))))].sort();
}

/**
 * The partition every discovered file must satisfy.
 *
 * The property is a DISJOINT UNION, derived at run time from three independent sources:
 *
 *     discovered  ==  registered  (+)  excluded
 *
 * `discovered` comes from the filesystem, `registered` from the derived harness plan, `excluded` from
 * the exclusion registry. NO EXPECTED TOTAL IS ASSERTED anywhere -- a hard-coded count would recreate
 * the defect the derived plan removed, and would fail a correctly registered new test merely because a
 * second number was not incremented. Non-vacuity comes from `discovered` being non-empty plus the
 * mutation that adds an unregistered, unexcluded file.
 *
 * `both` is reported separately from `unresolved` because they are opposite failures: a file in neither
 * home is invisible, while a file in both makes every individual check pass while the truth is
 * ambiguous.
 */
function partitionDiscovered(discovered, planScripts, exclusionPaths) {
  const inPlan = new Set(planScripts);
  const inRegistry = new Set(exclusionPaths);

  const registered = [];
  const excluded = [];
  const unresolved = [];
  const both = [];

  for (const file of discovered) {
    const r = inPlan.has(file);
    const e = inRegistry.has(file);
    if (r && e) both.push(file);
    else if (r) registered.push(file);
    else if (e) excluded.push(file);
    else unresolved.push(file);
  }

  return { registered, excluded, unresolved, both };
}

module.exports = {
  DISCOVERY_ROOT,
  EXTENSIONS,
  SKIP_DIRS,
  TEST_SEGMENT,
  isTestShaped,
  discoverTestShaped,
  discoveryDirectories,
  partitionDiscovered,
};
