/**
 * The harness's third-party Python environment is declared in the repository, locked, and cannot drift.
 *
 * WHY THIS EXISTS. The first hosted CI run (32752370139) went red on `ModuleNotFoundError` for
 * `requests` and `pandas`. The suite had been green locally for exactly one reason: the developer's
 * global interpreter carried those packages. Nothing in the repository declared them, and an earlier
 * measurement had concluded -- wrongly -- that the harness needed no third-party Python packages at all.
 *
 * THAT MEASUREMENT FAILED THREE WAYS, and this checker is built so each is structurally impossible:
 *
 *   1. it walks local-module imports TRANSITIVELY instead of treating a `scripts/*.py` sibling as a
 *      leaf -- `pandas` hides two hops down, behind `historical_core` and `import_historical`;
 *   2. it reads FUNCTION-LEVEL imports through a full AST walk, not just module-level ones -- the
 *      `import_historical` import sits inside a test method;
 *   3. it includes Python scripts that plan commands SPAWN, DISCOVERED DYNAMICALLY from command source.
 *      The four tools carrying `import requests` are `network-optional` EXCLUSIONS, so nothing that
 *      reasons about the plan's own command list can see them -- yet a REGISTERED test executes them.
 *      A hard-coded list of today's spawn edges would pass while being blind to tomorrow's, so no such
 *      list exists here: adding a new spawned script with an undeclared import must fail this suite.
 *
 * FORWARD containment is checked here: everything the closure needs is declared or reasonably
 * excluded.
 *
 * REVERSE containment is NOT authoritative here, and this file must not claim otherwise. What it can
 * check is the lock's own `# via` COMMENTS -- and a comment can lie: a package added with a forged
 * `# via requests` closes that graph perfectly. That check is kept as a cheap early one, catching an
 * entry with no parent at all. The AUTHORITATIVE reverse-containment check is
 * scripts/verify_python_environment.py, which traverses the INSTALLED distributions' real metadata
 * with markers evaluated for the running environment; it needs an interpreter carrying the lock, so
 * it runs in the workflow, and this suite requires the workflow to run it.
 *
 * WHAT THIS SUITE DOES NOT DO. It never installs anything, never contacts an index, and never imports a
 * third-party package. It reads source, the declaration, the lock, and the workflow.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const IN_FILE = "requirements-harness.in";
const LOCK_FILE = "requirements-harness.txt";
const WORKFLOW = ".github/workflows/canonical-harness.yml";

let passed = 0;
const failures = [];
function check(name, body) {
  try {
    body();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

/**
 * Effective content: whole-line comments removed.
 *
 * A "this must appear" or "this must not appear" claim has to be about what a file DOES. Asserting
 * against raw text reads explanatory prose as executable content -- which bit twice while writing
 * this suite: a comment mentioning `pip freeze` kept an assertion green after the command itself was
 * deleted, and a comment naming a package tripped the no-package-name rule.
 */
const effective = (text) => text
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/* ------------------------------------------------------------------ the declaration and the lock */

/** Package names declared in the input file, comments stripped. */
function parseDeclaration(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/[<>=!;\[ ]/)[0].toLowerCase());
}

/**
 * The lock, as {name: {version, hashes, via[]}}.
 *
 * `# via` comes in two shapes -- inline (`# via requests`) and a block continued on `#   name` lines --
 * and both have to be understood or the reverse-containment graph is silently incomplete.
 */
function parseLock(text) {
  const lines = text.split(/\r?\n/);
  const packages = {};
  let current = null;
  let inVia = false;
  for (const raw of lines) {
    const pinned = raw.match(/^([A-Za-z0-9._-]+)==([^\s\\]+)/);
    if (pinned) {
      current = pinned[1].toLowerCase();
      packages[current] = { version: pinned[2], hashes: 0, via: [] };
      inVia = false;
      continue;
    }
    if (!current) continue;
    if (/--hash=sha256:/.test(raw)) { packages[current].hashes += 1; continue; }
    const inlineVia = raw.match(/^\s*#\s*via\s+(.+)$/);
    if (inlineVia) { packages[current].via.push(inlineVia[1].trim()); inVia = false; continue; }
    if (/^\s*#\s*via\s*$/.test(raw)) { inVia = true; continue; }
    if (inVia) {
      const cont = raw.match(/^\s*#\s{2,}(.+)$/);
      if (cont) { packages[current].via.push(cont[1].trim()); continue; }
      inVia = false;
    }
  }
  return packages;
}

const declaration = parseDeclaration(read(IN_FILE));
const lock = parseLock(read(LOCK_FILE));
const workflow = read(WORKFLOW);

/* ------------------------------------------------------------------ the measured closure */

const PY_RUNNER = "python";

function planCommands() {
  const { planHarness, ENTRY_POINTS } = require("./lib/harness-plan.js");
  const scripts = require(path.join(REPO, "package.json")).scripts;
  return planHarness(scripts, ENTRY_POINTS).commands;
}

/**
 * Python scripts a command SPAWNS, found by literal path in the command's own source.
 *
 * Dynamic on purpose. There is no list of today's spawn edges anywhere in this file.
 */
const SPAWN_RE = /["'`]((?:\.\.\/)?scripts\/[A-Za-z0-9_./-]+\.py)["'`]/g;
function spawnedFrom(scriptRel) {
  let text;
  try { text = read(scriptRel); } catch { return []; }
  const found = new Set();
  for (const m of text.matchAll(SPAWN_RE)) {
    const rel = m[1].replace(/^\.\.\//, "");
    if (rel !== scriptRel && fs.existsSync(path.join(REPO, rel))) found.add(rel);
  }
  return [...found];
}

/** Ask Python itself for the closure: it owns the AST and the stdlib list. */
function measureClosure(roots) {
  const script = `
import ast, json, pathlib, sys
repo = pathlib.Path(sys.argv[1])
roots = json.loads(sys.argv[2])
stdlib = set(sys.stdlib_module_names)
local = {}
for p in (repo / "scripts").rglob("*.py"):
    local.setdefault(p.stem, p)
third, seen = {}, set()
def walk(path, chain):
    if path in seen: return
    seen.add(path)
    try: tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except Exception: return
    for node in ast.walk(tree):
        mods = []
        if isinstance(node, ast.Import):
            mods = [(a.name.split(".")[0], node.lineno) for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            mods = [(node.module.split(".")[0], node.lineno)]
        for mod, lineno in mods:
            if mod in stdlib: continue
            if mod in local:
                walk(local[mod], chain + [path.name + ":" + str(lineno)]); continue
            rel = path.relative_to(repo).as_posix()
            third.setdefault(mod, []).append(rel + ":" + str(lineno) + ("  via " + " -> ".join(chain) if chain else ""))
for r in roots:
    walk(repo / r, [])
print(json.dumps(third))
`;
  const out = execFileSync(PY_RUNNER, ["-c", script, REPO, JSON.stringify(roots)],
    { encoding: "utf8", cwd: REPO, maxBuffer: 1 << 24 });
  return JSON.parse(out);
}

const commands = planCommands();
const pyRoots = commands.filter((c) => c.runner === PY_RUNNER && c.script).map((c) => c.script);

/** Spawn edges: {spawnedScript: [commands that spawn it]}, discovered, not declared. */
const spawnEdges = {};
for (const c of commands) {
  if (!c.script) continue;
  for (const target of spawnedFrom(c.script)) {
    (spawnEdges[target] = spawnEdges[target] || []).push(c.script);
  }
}

const roots = [...new Set([...pyRoots, ...Object.keys(spawnEdges)])];
const closure = measureClosure(roots);

/* ------------------------------------------------------------------ the reasoned exclusions */

/**
 * A package may be left out of the declaration only with a reason this suite can re-check.
 *
 * `anthropic` is excluded because it is imported inside functions the `--print-target` path never
 * reaches. That is a claim about the CALL PATH, not about the file -- so it is only valid while every
 * harness-reachable invocation of those tools passes `--print-target`, which is verified below rather
 * than trusted.
 */
const CALL_PATH_EXCLUSIONS = {
  anthropic: { requiredArg: "--print-target" },
};

/**
 * Packages the ENVIRONMENT supplies rather than the lock.
 *
 * `pip` is imported by scripts/verify_python_environment.py, which uses pip's VENDORED packaging to
 * parse requirement markers -- adding a `packaging` distribution to the lock in order to check the lock
 * would be circular. `python -m venv` seeds pip via ensurepip, so it is not a dependency to lock; but it
 * IS a private-module-path coupling, so the exclusion is only valid while the exact pip version is
 * recorded in the declaration and asserted at run time.
 */
const ENVIRONMENT_PROVIDED = {
  pip: { declarationPin: /^#\s*harness-env:\s*pip==([0-9][0-9A-Za-z.\-]*)\s*$/m },
};

/**
 * Packages a DECLARED library loads at call time, so no import statement names them.
 *
 * `openpyxl` is the engine pandas loads inside `read_excel` for .xlsx files. scripts/import_historical.py reads
 * the state/national workbook that way, and scripts/test_historical_national_rape.py (P4) exercises it; the first
 * hosted run of PR #32 (39146113446) failed there with ModuleNotFoundError. The declaration is valid only while a
 * measured file that imports the loader also makes the call, which is checked below rather than trusted.
 */
const LOADER_REQUIRED = {
  openpyxl: { loader: "pandas", call: /\.read_excel\(/ },
};

/** Every bracketed array literal in `text` that contains `needle`. */
function arrayLiteralsContaining(text, needle) {
  const out = [];
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    let open = -1, depth = 0;
    for (let i = idx; i >= 0; i -= 1) {
      const ch = text[i];
      if (ch === "]") depth += 1;
      else if (ch === "[") { if (depth === 0) { open = i; break; } depth -= 1; }
    }
    let close = -1;
    if (open !== -1) {
      depth = 0;
      for (let i = open + 1; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "[") depth += 1;
        else if (ch === "]") { if (depth === 0) { close = i; break; } depth -= 1; }
      }
    }
    out.push(open !== -1 && close !== -1 ? text.slice(open, close + 1) : null);
    idx += needle.length;
  }
  return out;
}

/* ------------------------------------------------------------------ checks */

check("the closure measurement is non-vacuous", () => {
  assert.ok(roots.length > 0, "no python roots were measured");
  assert.ok(Object.keys(spawnEdges).length > 0,
    "no spawn edges were discovered, so the spawned-script half of the closure proves nothing");
  assert.ok(Object.keys(closure).length > 0,
    "the closure is empty; the measurement is not finding third-party imports at all");
  console.log(`        roots=${roots.length} spawn-edges=${Object.keys(spawnEdges).length} `
    + `third-party=${Object.keys(closure).sort().join(",")}`);
});

check("spawn discovery is DYNAMIC -- every edge traces to a command's own source", () => {
  for (const [target, by] of Object.entries(spawnEdges)) {
    for (const spawner of by) {
      const text = read(spawner);
      assert.ok(text.includes(target.replace(/^scripts\//, "scripts/")) || text.includes(target),
        `${target} is claimed to be spawned by ${spawner}, but that file does not name it`);
    }
  }
  // A spawned script must itself be measured, or its imports are invisible.
  for (const target of Object.keys(spawnEdges)) {
    assert.ok(roots.includes(target), `${target} is a spawn target but was not measured`);
  }
});

check("FORWARD containment: every third-party import is declared or reasonably excluded", () => {
  const undeclared = [];
  for (const pkg of Object.keys(closure)) {
    if (declaration.includes(pkg)) continue;
    if (Object.prototype.hasOwnProperty.call(CALL_PATH_EXCLUSIONS, pkg)) continue;
    if (Object.prototype.hasOwnProperty.call(ENVIRONMENT_PROVIDED, pkg)) continue;
    undeclared.push(`${pkg}  (${closure[pkg][0]})`);
  }
  assert.deepEqual(undeclared, [],
    `these third-party packages are imported but neither declared in ${IN_FILE} nor excluded:\n`
    + `        ${undeclared.join("\n        ")}`);
});

check("every declared package is actually imported -- no dead declarations", () => {
  const unused = declaration.filter((p) => !Object.prototype.hasOwnProperty.call(closure, p)
    && !Object.prototype.hasOwnProperty.call(LOADER_REQUIRED, p));
  assert.deepEqual(unused, [], `declared but never imported: ${unused.join(", ")}`);
});

check("every loader-required package is declared and its call site still exists", () => {
  for (const [pkg, rule] of Object.entries(LOADER_REQUIRED)) {
    assert.ok(declaration.includes(pkg), `${pkg} is loader-required but not declared in ${IN_FILE}`);
    const importers = closure[rule.loader] || [];
    assert.ok(importers.length > 0, `${pkg} needs ${rule.loader}, which no measured file imports`);
    // closure entries read "<file>:<line>  via <importer>:<line>"; the file is the text before the first colon.
    const files = [...new Set(importers.map((e) => String(e).split(":")[0]))];
    const callers = files.filter((f) => rule.call.test(read(f)));
    assert.ok(callers.length > 0,
      `no measured file that imports ${rule.loader} calls ${rule.call}; the ${pkg} declaration is now dead`);
    console.log(`        ${pkg}: loaded by ${rule.loader} at ${callers.join(", ")}`);
  }
});

check("the anthropic exclusion is CALL-PATH specific and still holds", () => {
  for (const [pkg, rule] of Object.entries(CALL_PATH_EXCLUSIONS)) {
    if (!Object.prototype.hasOwnProperty.call(closure, pkg)) continue;
    // Which spawned tools import it, and who invokes them.
    const importers = new Set(closure[pkg].map((o) => o.split(":")[0]));
    let invocations = 0;
    for (const tool of importers) {
      const spawners = spawnEdges[tool];
      assert.ok(spawners && spawners.length,
        `${pkg} is imported by ${tool}, which no command spawns -- the exclusion cannot be call-path checked`);
      for (const spawner of spawners) {
        const text = read(spawner);
        const arrays = arrayLiteralsContaining(text, tool);
        assert.ok(arrays.length > 0, `${spawner} names ${tool} but not inside an argument list`);
        for (const arr of arrays) {
          assert.ok(arr !== null,
            `${spawner} names ${tool} outside any argument array; the call path cannot be proven`);
          assert.ok(arr.includes(rule.requiredArg),
            `${spawner} invokes ${tool} WITHOUT ${rule.requiredArg}; the ${pkg} exclusion is no longer `
            + `valid and ${pkg} must be declared`);
          invocations += 1;
        }
      }
    }
    assert.ok(invocations > 0, `no invocation of the ${pkg}-importing tools was found; exclusion unproven`);
    console.log(`        ${pkg}: ${invocations} reachable invocation(s), all passing ${rule.requiredArg}`);
  }
});

check("the lock is fully pinned and every entry is hashed", () => {
  const names = Object.keys(lock);
  assert.ok(names.length > 0, "the lock parsed to zero packages");
  for (const [name, info] of Object.entries(lock)) {
    assert.match(info.version, /^\d/, `${name} is not pinned to a concrete version`);
    assert.ok(info.hashes > 0, `${name} has no --hash= entry`);
  }
  const unpinned = read(LOCK_FILE)
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z0-9._-]+\s*$/.test(l) || /^[A-Za-z0-9._-]+[<>~!]/.test(l));
  assert.deepEqual(unpinned, [], `unpinned requirement lines in the lock: ${unpinned.join(", ")}`);
});

check("DECLARATION is a subset of the lock", () => {
  const missing = declaration.filter((p) => !Object.prototype.hasOwnProperty.call(lock, p));
  assert.deepEqual(missing, [], `declared but absent from the lock: ${missing.join(", ")}`);
});

check("EARLY consistency: the lock's own `# via` graph closes on the declaration", () => {
  /**
   * NOT authoritative reachability, and it must not be described as such. This reads the lock's own
   * `# via` COMMENTS, and a comment can lie: a package added with a forged `# via requests` closes this
   * graph perfectly. It is kept as a cheap early check that catches the common case -- an entry with no
   * parent at all -- and gives a clear message before the real check runs.
   *
   * The authoritative check is scripts/verify_python_environment.py, which traverses the INSTALLED
   * distributions' metadata with markers evaluated. It needs an interpreter that has the lock
   * installed, so it runs in the workflow; this suite requires the workflow to run it.
   */
  const rooted = new Set();
  const frontier = [];
  for (const [name, info] of Object.entries(lock)) {
    if (info.via.some((v) => v.includes(IN_FILE))) { rooted.add(name); frontier.push(name); }
  }
  assert.ok(frontier.length > 0, "no locked package is attributed to the declaration at all");
  while (frontier.length) {
    const parent = frontier.pop();
    for (const [name, info] of Object.entries(lock)) {
      if (rooted.has(name)) continue;
      if (info.via.some((v) => v.split(/[\s,]+/).includes(parent))) { rooted.add(name); frontier.push(name); }
    }
  }
  const orphans = Object.keys(lock).filter((n) => !rooted.has(n));
  assert.deepEqual(orphans, [],
    `locked but not reachable from ${IN_FILE}: ${orphans.join(", ")} -- nothing declares or requires them`);
  console.log(`        ${rooted.size} locked package(s), all reachable from the declaration`);
});

check("the lock records the declaration it was generated from", () => {
  const text = read(LOCK_FILE);
  assert.match(text, /autogenerated by pip-compile/, "the lock has no generated-by header");
  assert.ok(text.includes(IN_FILE), `the lock header does not name ${IN_FILE}`);
  assert.match(read(IN_FILE), /pip-tools \d+\.\d+/, "the declaration does not record the pip-tools version");
  assert.match(read(IN_FILE), /CPython 3\.14\.3/, "the declaration does not record the generating interpreter");
});

/* ------------------------------------------------------------------ the workflow install path */

check("the workflow builds an ISOLATED venv and proves it, before installing", () => {
  assert.match(workflow, /python -m venv/, "the workflow does not create a virtual environment");
  assert.match(workflow, /include-system-site-packages\s*=\s*false/,
    "the workflow does not prove the venv excludes system site-packages");
  assert.match(workflow, /sys\.prefix\s*!=\s*sys\.base_prefix/,
    "the workflow does not prove the interpreter is a venv rather than the tool-cache python");
  assert.match(workflow, /3\.14\.3/, "the workflow does not assert the venv's interpreter version");
});

check("the workflow proves the direct packages are ABSENT before installing", () => {
  // Otherwise a hosted image that happened to ship them would recreate the defect being fixed.
  for (const pkg of declaration) {
    assert.ok(new RegExp(`\\b${pkg}\\b`).test(workflow) === false || /absent/.test(workflow),
      `the workflow does not prove ${pkg} is absent before install`);
  }
  assert.match(workflow, /must be ABSENT|absent before/i, "no pre-install absence proof is present");
});

check("the workflow installs EXCLUSIVELY from the lock, then runs pip check", () => {
  const installs = workflow.match(/python -m pip install[^\n]*/g) || [];
  assert.equal(installs.length, 1, `expected exactly one pip install, found ${installs.length}`);
  assert.match(installs[0], /--require-hashes/, "the install does not require hashes");
  assert.match(installs[0], new RegExp(`-r ${LOCK_FILE.replace(/\./g, "\\.")}`),
    `the install does not read ${LOCK_FILE}`);
  assert.match(workflow, /python -m pip check/, "pip check does not run");
  const installIdx = workflow.indexOf(installs[0]);
  const checkIdx = workflow.indexOf("python -m pip check");
  const testIdx = workflow.indexOf("npm test");
  assert.ok(installIdx < checkIdx, "pip check runs before the install");
  assert.ok(checkIdx < testIdx, "pip check runs after the harness");
});

check("NO package name or version from the lock appears in the workflow", () => {
  /**
   * The whole point of the declaration owning this: a workflow that names a package can drift from the
   * lock, and an ad-hoc `pip install <name>` is exactly how the missing declaration would get papered
   * over instead of fixed.
   */
  const offenders = [];
  for (const [name, info] of Object.entries(lock)) {
    if (new RegExp(`(^|[^A-Za-z0-9._-])${name}([^A-Za-z0-9._-]|$)`, "m").test(workflow)) {
      offenders.push(name);
    }
    if (workflow.includes(`${name}==`)) offenders.push(`${name}==`);
    if (info.version && workflow.includes(`==${info.version}`)) offenders.push(`==${info.version}`);
  }
  assert.deepEqual(offenders, [],
    `the workflow names locked package(s)/version(s): ${[...new Set(offenders)].join(", ")}`);
  assert.doesNotMatch(workflow, /pip install (?!--require-hashes)/,
    "a pip install that is not the lock install appears in the workflow");
});

check("the harness runs under the venv interpreter, proven in the workflow", () => {
  assert.match(workflow, /GITHUB_PATH/, "the venv is never put on PATH for later steps");
  // The canonical job runs on Linux (ubuntu-24.04), where a venv's interpreter lives in bin/. The
  // Windows form (Scripts/ via cygpath -w) belonged to the windows-latest job this replaced.
  assert.match(workflow, /echo "\$PWD\/\.ci-venv\/bin" >> "\$GITHUB_PATH"/,
    "the venv's bin directory is not put on PATH, so the harness's `python` would not be the venv");
  assert.match(workflow, /VENV_PY="\.ci-venv\/bin\/python"/,
    "the isolation proof does not use the venv's own interpreter");
  // The decisive assertion: before running the suite, `python` must BE the venv.
  assert.match(workflow, /the harness interpreter is the venv|resolves to the venv/i,
    "the workflow does not assert that the harness's `python` is the venv interpreter");
});

check("the workflow keeps the cheap installed-versus-locked check", () => {
  /**
   * Kept, but NOT as reachability. `pip freeze` proves only that everything in the lock was installed;
   * a forged `# via` entry is installed too and passes. It stays because it is cheap and its message is
   * clearer than the authoritative check's when an install simply went wrong.
   */
  assert.match(effective(workflow), /python -m pip freeze/,
    "the workflow does not actually run pip freeze; a comment mentioning it is not the command");
  assert.match(workflow, /early consistency check/i,
    "the freeze comparison is not labelled as an early check, so it reads as authoritative");
});

check("the workflow runs the AUTHORITATIVE metadata reverse-containment verifier", () => {
  /**
   * The check that a forged `# via` cannot survive: real `importlib.metadata` traversal with markers
   * evaluated. It needs an interpreter carrying the lock, so it lives in the workflow -- and this
   * assertion is what stops the workflow from quietly dropping it.
   */
  const verifier = "scripts/verify_python_environment.py";
  assert.ok(fs.existsSync(path.join(REPO, verifier)), `${verifier} does not exist`);
  assert.ok(workflow.includes(verifier), `the workflow never runs ${verifier}`);

  const verifyIdx = workflow.indexOf(verifier);
  const installIdx = workflow.search(/python -m pip install/);
  const testIdx = workflow.indexOf("npm test");
  assert.ok(installIdx < verifyIdx, "the verifier runs before the install, so there is nothing to verify");
  assert.ok(verifyIdx < testIdx, "the verifier runs after the harness rather than gating it");

  // It must actually do metadata traversal with marker evaluation, not merely exist.
  const src = read(verifier);
  assert.match(src, /importlib\.metadata/, "the verifier does not read installed metadata");
  assert.match(src, /marker\.evaluate\(/, "the verifier does not evaluate requirement markers");
  assert.match(src, /canonicalize_name/, "the verifier does not canonicalize distribution names");
  assert.match(src, /locked - reachable|locked \- reachable/,
    "the verifier does not require every locked package to be metadata-reachable");
});

check("the vendored-parser coupling is pinned in the declaration and asserted", () => {
  /**
   * The verifier parses markers with pip's VENDORED packaging, because locking a `packaging`
   * distribution in order to check the lock would be circular. That is a private module path, so the
   * coupling is only acceptable while the exact pip version is recorded and re-checked at run time.
   */
  for (const [pkg, rule] of Object.entries(ENVIRONMENT_PROVIDED)) {
    const m = read(IN_FILE).match(rule.declarationPin);
    assert.ok(m, `${IN_FILE} does not pin the ${pkg} version the verifier is coupled to`);
    const src = read("scripts/verify_python_environment.py");
    assert.match(src, /harness-env:\s*\\s\*pip==|harness-env/,
      "the verifier does not read the pinned version from the declaration");
    assert.match(src, /pip\.__version__ != pinned_pip|pip\.__version__/,
      "the verifier does not assert the running pip against the pin");
    assert.doesNotMatch(workflow, new RegExp(`==${m[1].replace(/\./g, "\\.")}`),
      "the pinned version is written into the workflow instead of the declaration");
    console.log(`        ${pkg} pinned at ${m[1]}, asserted by the verifier, absent from the workflow`);
  }
});

/* ------------------------------------------------------------------ */

console.log("");
console.log(`python dependency closure: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
