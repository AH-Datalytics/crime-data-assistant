/**
 * Acceptance evidence for the session-analytics credential containment.
 *
 * WHY THIS IS MOSTLY BEHAVIOURAL. A source-text check proves a string is absent, not that the endpoint
 * refuses anything. So the authorization decision is IMPORTED AND CALLED with every rejection case, and
 * the tools are SPAWNED to see which host they actually resolve.
 *
 * WHAT THIS SUITE DOES NOT PROVE, AND WHERE THAT LIVES. Calling `authorizeAnalytics()` correctly proves
 * the DECISION is right; it says nothing about whether the route feeds it the right request facts. That
 * is `scripts/test-analytics-handler-boundary.ts`, which invokes the real exported `GET`, and which also
 * carries the behavioural CORS and preflight claims. The only claim left that needs a browser is the
 * page's use of a header; that one, and the route placement checks, are asserted over BOTH the index and
 * the working tree, and each has a mutation in the handoff in both staged and unstaged form.
 *
 * WHAT WAS WRONG BEFORE. `/api/session-analytics` is in `middleware.ts`'s always-allow list, so it never
 * saw the site password gate. It accepted a credential from `?pw=`, and accepted three values: the
 * dedicated key, an unrelated key (`QUERY_LOG_KEY`), and a literal committed to this repository. It also
 * emitted `Access-Control-Allow-Origin: *`. Anyone who could read the repo could read session detail --
 * session ids, timings, and the questions people asked -- from any origin.
 *
 * THE OBSOLETE LITERAL IS NOT WRITTEN IN THIS FILE. It is read from the one place that still needs to
 * know it -- the scan's own fixture below -- by construction from character codes, so this test can
 * assert its absence without reintroducing it as tracked text.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { authorizeAnalytics, URL_CREDENTIAL_PARAMS } from "../lib/analytics-auth";

const REPO = path.join(__dirname, "..");

let passed = 0;
const failures: string[] = [];
function check(name: string, body: () => void): void {
  try {
    body();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

/**
 * The obsolete literal, assembled from character codes.
 *
 * Writing it as a string literal here would make this very test the last tracked occurrence, so the
 * scan below would find itself and could never pass. Assembling it keeps the scan honest AND keeps the
 * value out of the tracked text.
 */
const OBSOLETE = String.fromCharCode(78, 73, 66, 82, 83, 65, 72, 68);

const GOOD_KEY = "test-analytics-key-not-a-real-secret";

// ─────────────────────────────────────────── authorization: rejections

check("no Authorization header is rejected", () => {
  const r = authorizeAnalytics({ authorization: null, hasUrlCredential: false, analyticsPassword: GOOD_KEY });
  assert.deepEqual(r, { ok: false, reason: "missing_header" });
});

check("a malformed header is rejected", () => {
  for (const header of ["", "Basic abc", "Bearer", "bearer", "Token " + GOOD_KEY, GOOD_KEY]) {
    const r = authorizeAnalytics({ authorization: header, hasUrlCredential: false, analyticsPassword: GOOD_KEY });
    assert.equal(r.ok, false, `header ${JSON.stringify(header)} was accepted`);
  }
});

check("the OBSOLETE LITERAL is rejected, in the header", () => {
  const r = authorizeAnalytics({
    authorization: `Bearer ${OBSOLETE}`, hasUrlCredential: false, analyticsPassword: GOOD_KEY,
  });
  assert.deepEqual(r, { ok: false, reason: "invalid_credential" });
});

check("a QUERY_LOG_KEY-style unrelated credential is rejected", () => {
  // The route no longer consults QUERY_LOG_KEY at all, so any value that is not the dedicated
  // analytics key fails -- which is the property, stated without needing that variable to exist.
  const r = authorizeAnalytics({
    authorization: "Bearer some-query-log-key-value", hasUrlCredential: false, analyticsPassword: GOOD_KEY,
  });
  assert.deepEqual(r, { ok: false, reason: "invalid_credential" });
});

check("ANY query-string credential is rejected -- even the CORRECT key", () => {
  /**
   * The case that matters most. Accepting a correct key from a URL would keep it flowing into access
   * logs and browser history, so it is refused before configuration and before the credential check.
   */
  for (const param of URL_CREDENTIAL_PARAMS) {
    const r = authorizeAnalytics({
      authorization: `Bearer ${GOOD_KEY}`, hasUrlCredential: true, analyticsPassword: GOOD_KEY,
    });
    assert.deepEqual(r, { ok: false, reason: "credential_in_url" }, `param ${param}`);
  }
  // …and with no header at all.
  assert.equal(
    authorizeAnalytics({ authorization: null, hasUrlCredential: true, analyticsPassword: GOOD_KEY }).ok,
    false,
  );
});

// ─────────────────────────────────────────── authorization: fail closed

check("an ABSENT analytics key fails closed, even with a plausible header", () => {
  for (const configured of [undefined, ""]) {
    const r = authorizeAnalytics({
      authorization: `Bearer ${GOOD_KEY}`, hasUrlCredential: false, analyticsPassword: configured,
    });
    assert.deepEqual(r, { ok: false, reason: "not_configured" },
      `configured=${JSON.stringify(configured)} did not fail closed`);
  }
});

check("an absent key cannot be satisfied by an empty Bearer either", () => {
  const r = authorizeAnalytics({ authorization: "Bearer ", hasUrlCredential: false, analyticsPassword: "" });
  assert.equal(r.ok, false);
});

// ─────────────────────────────────────────── authorization: the one accept

check("the correct key is accepted ONLY through the Bearer header", () => {
  const ok = authorizeAnalytics({
    authorization: `Bearer ${GOOD_KEY}`, hasUrlCredential: false, analyticsPassword: GOOD_KEY,
  });
  assert.deepEqual(ok, { ok: true });

  // Same value, wrong channel -> refused. This pairing is what proves the channel is enforced rather
  // than the value merely checked.
  const viaUrl = authorizeAnalytics({
    authorization: null, hasUrlCredential: true, analyticsPassword: GOOD_KEY,
  });
  assert.equal(viaUrl.ok, false);
});

check("a near-miss key is rejected, and comparison is length-safe", () => {
  for (const wrong of [GOOD_KEY + "x", GOOD_KEY.slice(0, -1), GOOD_KEY.toUpperCase(), " " + GOOD_KEY]) {
    const r = authorizeAnalytics({
      authorization: `Bearer ${wrong}`, hasUrlCredential: false, analyticsPassword: GOOD_KEY,
    });
    assert.equal(r.ok, false, `accepted a near-miss: ${JSON.stringify(wrong)}`);
  }
});

// ─────────────────────────────────────────── the literal is gone from the tree

check("the obsolete literal occurs in ZERO tracked files", () => {
  /**
   * `git grep` over the tracked set, so untracked scratch files and node_modules cannot affect the
   * verdict. Exit code 1 means "no matches", which is the passing case; anything else is a real error.
   */
  const result = spawnSync("git", ["grep", "-lI", "--", OBSOLETE], {
    cwd: REPO, encoding: "utf8",
  });
  assert.notEqual(result.status, null, "git grep did not run");
  if (result.status === 0) {
    assert.fail(`the obsolete literal is still tracked in:\n  ${result.stdout.trim().split("\n").join("\n  ")}`);
  }
  assert.equal(result.status, 1, `unexpected git grep status ${result.status}: ${result.stderr}`);
});

check("the scan is not vacuous -- it finds the literal when present in a tracked file", () => {
  /**
   * Non-vacuity without writing to the repository: ask git grep for a string that IS tracked, through
   * the same code path. If this cannot find a known-present string, the scan above proves nothing.
   */
  const known = spawnSync("git", ["grep", "-lI", "--", "authorizeAnalytics"], {
    cwd: REPO, encoding: "utf8",
  });
  assert.equal(known.status, 0, "the scan mechanism found nothing for a known-present string");
  // `git grep` searches TRACKED paths, so a brand-new untracked file would not appear here even though
  // it contains the string. Assert on a tracked caller instead of the new module.
  assert.match(known.stdout, /session-analytics[/\\]route\.ts/,
    `expected a tracked file to match; got: ${JSON.stringify(known.stdout)}`);
});

// ─────────────────────────────────────────── tools: production is opt-in

/**
 * Each tool names its production target its own way, and the test must use the tool's real interface
 * rather than assume one. `smoke-test.py` and the canary take a POSITIONAL url; the two argparse tools
 * take `--base`; the node tool reads `TEST_URL`. Getting this wrong is how a "tool honours production"
 * check can pass while actually resolving the flag name as a URL.
 *
 * AMBIENT CONFIGURATION IS REMOVED FROM EVERY BARE CONTROL, and this is not cosmetic. The node tool's
 * target IS an environment variable, so a bare invocation inherited the parent's `TEST_URL`. On a
 * machine where `TEST_URL` names production -- an operator's shell, or a CI job that sets it -- the
 * supposedly bare control was no longer bare, and "the default is localhost" became a statement about
 * that machine's environment rather than about the tool. Every candidate target variable is deleted for
 * bare runs and set only in the explicit control. This is test determinism; the tools' explicit opt-in
 * behaviour is unchanged.
 */
const AMBIENT_TARGET_VARS = [
  "TEST_URL", "TEST_PASSWORD", "BASE", "BASE_URL", "NIBRS_BASE_URL", "SITE_URL", "NEXT_PUBLIC_BASE_URL",
] as const;

/** The parent environment with every candidate target variable removed. */
function scrubbedEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of AMBIENT_TARGET_VARS) delete env[name];
  return { ...env, ...overrides };
}

/** Every candidate target variable set to production, to prove a tool that ignores them really does. */
const POISONED: Record<string, string> = Object.fromEntries(
  AMBIENT_TARGET_VARS.map((name) => [name, "https://nibrsai.com"]),
);

type Tool = {
  file: string;
  /** The tool's documented environment target, if it has one. `null` means arguments only. */
  envTarget: string | null;
  run: (args: string[], env: NodeJS.ProcessEnv) => string;
  bareArgs: string[];
  explicit: (url: string) => { args: string[]; env: NodeJS.ProcessEnv };
};

const runner = (bin: string) => (args: string[], env: NodeJS.ProcessEnv) =>
  execFileSync(bin, args, { cwd: REPO, encoding: "utf8", env });

const py = runner("python");
const node = runner("node");

const TOOLS: Tool[] = [
  {
    file: "scripts/smoke-test.py",                       // positional url
    envTarget: null,
    run: py,
    bareArgs: ["scripts/smoke-test.py", "--print-target"],
    explicit: (u) => ({ args: ["scripts/smoke-test.py", u, "--print-target"], env: scrubbedEnv() }),
  },
  {
    file: "scripts/canary-reliability-disclosures.py",   // positional url
    envTarget: null,
    run: py,
    bareArgs: ["scripts/canary-reliability-disclosures.py", "--print-target"],
    explicit: (u) => ({
      args: ["scripts/canary-reliability-disclosures.py", u, "--print-target"], env: scrubbedEnv(),
    }),
  },
  {
    file: "scripts/eval/stress-test.py",                 // --base
    envTarget: null,
    run: py,
    bareArgs: ["scripts/eval/stress-test.py", "--print-target"],
    explicit: (u) => ({
      args: ["scripts/eval/stress-test.py", "--base", u, "--print-target"], env: scrubbedEnv(),
    }),
  },
  {
    file: "scripts/eval/run-eval.py",                    // --base
    envTarget: null,
    run: py,
    bareArgs: ["scripts/eval/run-eval.py", "--print-target"],
    explicit: (u) => ({
      args: ["scripts/eval/run-eval.py", "--base", u, "--print-target"], env: scrubbedEnv(),
    }),
  },
  {
    file: "scripts/test-explanations.js",                // TEST_URL
    envTarget: "TEST_URL",
    run: node,
    bareArgs: ["scripts/test-explanations.js", "--print-target"],
    explicit: (u) => ({
      args: ["scripts/test-explanations.js", "--print-target"], env: scrubbedEnv({ TEST_URL: u }),
    }),
  },
];

check("a BARE invocation of every tool resolves to localhost, never production", () => {
  for (const tool of TOOLS) {
    // Bare means bare: no inherited target variable can reach the child.
    const target = tool.run(tool.bareArgs, scrubbedEnv()).trim();
    assert.match(target, /^http:\/\/localhost:\d+$/, `${tool.file} bare target was ${target}`);
    assert.doesNotMatch(target, /nibrsai\.com/, `${tool.file} bare invocation targets production`);
  }
});

check("no tool picks up a production target from the AMBIENT environment", () => {
  /**
   * Scrubbing alone would hide a real defect: a tool that silently reads some environment variable
   * looks fine once that variable is gone. So the four argument-driven tools are also run with EVERY
   * candidate variable set to production and must still resolve localhost. That is the measured answer
   * to "does any Python tool accept an environment target" -- none does.
   *
   * `test-explanations.js` is excluded by name, not by omission: `TEST_URL` IS its documented explicit
   * production channel, so honouring it is the behaviour the next check asserts. It is still held to the
   * narrower claim that no OTHER variable moves it.
   */
  for (const tool of TOOLS.filter((t) => t.envTarget === null)) {
    const target = tool.run(tool.bareArgs, scrubbedEnv(POISONED)).trim();
    assert.match(target, /^http:\/\/localhost:\d+$/,
      `${tool.file} resolved ${target} from the ambient environment; its target must come from arguments`);
  }
  const nodeTool = TOOLS.find((t) => t.envTarget === "TEST_URL")!;
  const otherVarsOnly = Object.fromEntries(
    Object.entries(POISONED).filter(([name]) => name !== nodeTool.envTarget),
  ) as Record<string, string>;
  const viaOtherVars = nodeTool.run(nodeTool.bareArgs, scrubbedEnv(otherVarsOnly)).trim();
  assert.match(viaOtherVars, /^http:\/\/localhost:\d+$/,
    `${nodeTool.file} resolved ${viaOtherVars} from a variable other than ${nodeTool.envTarget}`);
});

check("every tool still reaches an EXPLICITLY supplied production URL", () => {
  // Resolution only. `--print-target` exits before any request, so nothing is contacted.
  const prod = "https://nibrsai.com";
  for (const tool of TOOLS) {
    const { args, env } = tool.explicit(prod);
    const target = tool.run(args, env).trim();
    assert.equal(target, prod, `${tool.file} did not honour an explicit production target`);
  }
});

// ─────────────────────────────────────────── the unavoidable source assertions, in BOTH views

/**
 * DUAL VIEW, and why a source assertion needs both.
 *
 * Reading only the working tree leaves a blind spot in one direction and reading only the index leaves
 * one in the other. A relaxation that is staged but reverted on disk is invisible to a worktree-only
 * check -- that is what ships. A relaxation that is edited on disk but not staged is invisible to an
 * index-only check -- that is what a developer runs the suite against. The P1.1-R review established
 * this the hard way: a mutation edited the working tree, a check read unchanged staged bytes, and it
 * reported a false pass.
 *
 * So both views are inspected and the failure message NAMES the view that failed. This is the same
 * discipline `scripts/test-checkout-determinism.js` already applies to governed source shapes, and the
 * same two-verdict structure as the control-byte gate.
 *
 * CONSEQUENCE, STATED RATHER THAN HIDDEN: an edit to either governed file must be staged before this
 * suite passes. That is the intended cost of closing the staged-mutation hole.
 *
 * WHAT PROVES THE INDEX HALF IS LIVE. Two things, neither of them a self-comparison. The positive
 * `match` assertions below fail on an empty or wrong read, so a silently-empty index view cannot make
 * the `doesNotMatch` assertions pass vacuously; and the handoff records each governed mutation applied
 * to the INDEX ONLY, with the working tree left correct, and shows the `[index]` message failing.
 */
function sourceViews(file: string): { view: string; text: string }[] {
  return [
    {
      view: "index",
      text: execFileSync("git", ["cat-file", "blob", `:${file}`],
        { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 }),
    },
    { view: "worktree", text: readFileSync(path.join(REPO, file), "utf8") },
  ];
}

const PAGE = "app/analytics/page.tsx";
const ROUTE = "app/api/session-analytics/route.ts";

check("the analytics page sends the credential in a header and never in a URL, in BOTH views", () => {
  /**
   * Not behaviourally invocable without a browser and a server. Mutation-backed in the handoff, in both
   * the unstaged and the staged form: moving the credential back into the query string must fail here
   * whichever view carries the change.
   */
  for (const { view, text } of sourceViews(PAGE)) {
    assert.match(text, /headers:\s*\{\s*Authorization:\s*`Bearer \$\{password\}`/,
      `[${view}] ${PAGE} does not send Authorization: Bearer`);
    assert.doesNotMatch(text, /session-analytics\?[^`"']*pw=/,
      `[${view}] ${PAGE} still puts a credential in the URL`);
  }
});

check("the route enforces authorization and emits no wildcard CORS, in BOTH views", () => {
  /**
   * The behavioural versions of the CORS and preflight claims now live in
   * scripts/test-analytics-handler-boundary.ts, which invokes the real `GET` and reads the response
   * headers and the module's exports. These source assertions are kept as the placement half of the
   * pair -- they catch a reintroduced constant or handler that no single request would necessarily
   * exercise -- and each one has a mutation in the handoff, in both staged and unstaged form.
   */
  for (const { view, text } of sourceViews(ROUTE)) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /Access-Control-Allow-Origin/, `[${view}] wildcard CORS is back`);
    assert.doesNotMatch(code, /export\s+function\s+OPTIONS/, `[${view}] a public preflight handler is back`);
    assert.doesNotMatch(code, /QUERY_LOG_KEY/, `[${view}] the route consults QUERY_LOG_KEY again`);
    assert.match(code, /authorizeAnalytics\(/,
      `[${view}] the route no longer calls the authorization function`);
    /**
     * Calling the decision is not enough -- the route must ACT on it. Without this, deleting only the
     * guard while leaving the call in place would pass every other assertion here while opening the
     * endpoint completely. That exact mutation is in the handoff, and the handler suite catches it
     * behaviourally as well.
     */
    assert.match(code, /if\s*\(\s*!auth\.ok\s*\)\s*return\s+unauthorized\(\)\s*;/,
      `[${view}] the route computes an authorization result but no longer enforces it`);
  }
});


// ───────────────────────────────────────────

console.log("");
console.log(`analytics credential containment: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
