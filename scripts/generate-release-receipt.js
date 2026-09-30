/**
 * Write RELEASE_RECEIPT.json for a built, not-yet-published release.
 *
 * Run by scripts/deploy-zero-downtime.sh AFTER `npm run build` and BEFORE the symlink switch. The
 * ordering is forced: RELEASE_INFO is stamped before the build so an aborted build still leaves an
 * identifiable directory, which is exactly why it cannot carry a digest of the build output.
 *
 * EVERYTHING IT READS COMES FROM THE EXPORTED RELEASE, not from the operations checkout: the policies,
 * the schema, the workflow whose CI pins it records. The export has already been proven blob-equal to
 * the deployed commit, so those are that commit's rules by construction.
 *
 * WHAT IT READS FROM SHARED STATE, AND NOTHING ELSE. `next build` bakes NEXT_PUBLIC_* into the client
 * bundle, so the same commit can produce different artifacts; binding those values is what makes "same
 * commit" imply "same artifact". They are already public -- they ship to every browser. This generator
 * therefore parses the release's env files, selects ONLY assignments whose name begins NEXT_PUBLIC_,
 * and records nothing else: no other name and no other value reaches the receipt, a log, or an error
 * message. The VERIFIER never reads them at all.
 *
 * Usage:
 *   node scripts/generate-release-receipt.js --release <dir> --repo <dir> --sha <40hex>
 *        --branch <name> --built-at-start <iso> [--out <file>]
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const manifest = require("./lib/artifact-manifest.js");
const toolchain = require("./lib/toolchain-identity.js");

const RECEIPT_NAME = "RELEASE_RECEIPT.json";

// ---------------------------------------------------------------------------
// receipt validation, shared with the verifier
// ---------------------------------------------------------------------------

class ReceiptError extends Error {}

function loadSchema(releaseDir) {
  const file = path.join(releaseDir, "scripts", "fixtures", "receipt-schema.json");
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ReceiptError(`receipt schema not readable from the release: ${error.message}`);
  }
  if (doc.schema_version !== 1 || !doc.fields || typeof doc.fields !== "object") {
    throw new ReceiptError("receipt schema is malformed");
  }
  return doc;
}

function typeOk(value, spec) {
  switch (spec) {
    case "integer": return Number.isInteger(value);
    case "string": return typeof value === "string" && value.length > 0;
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "sha1": return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
    case "sha256": return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    case "sha256|null": return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
    default: return false;
  }
}

/** Closed: every schema field must be present and well typed, and no other field may appear. */
function validateReceipt(receipt, schema) {
  const problems = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return ["receipt must be a JSON object"];
  }
  const allowed = Object.keys(schema.fields);
  for (const field of Object.keys(receipt)) {
    if (!allowed.includes(field)) problems.push(`unknown field ${field}`);
  }
  for (const [field, spec] of Object.entries(schema.fields)) {
    if (!(field in receipt)) {
      problems.push(`missing field ${field}`);
    } else if (!typeOk(receipt[field], spec)) {
      problems.push(`field ${field} is not ${spec}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

function git(repo, args) {
  return execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  }).trim();
}

function sha256Of(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// The loader script, run in a CHILD process. Paths arrive as argv, never interpolated into the text.
//
// Two reasons it is a child rather than an in-process require. First, loadEnvConfig WRITES INTO
// process.env, so calling it twice in one process would make the drift recomputation compare against
// its own leakage rather than against the environment. Second, it must resolve @next/env from the
// RELEASE, so the semantics are the ones that release's own Next will apply.
const NEXT_ENV_LOADER = [
  'const { loadEnvConfig } = require(process.argv[1]);',
  'const silent = { info() {}, error() {}, warn() {} };',
  'const loaded = loadEnvConfig(process.argv[2], false, silent, true);',
  'const out = {};',
  'for (const [k, v] of Object.entries(loaded.combinedEnv || {})) {',
  '  if (k.startsWith("NEXT_PUBLIC_")) out[k] = v;',
  '}',
  'process.stdout.write(JSON.stringify({ public: out, files: (loaded.loadedEnvFiles || []).map((f) => f.path) }));'
].join("\n");

/**
 * The EFFECTIVE NEXT_PUBLIC_* set, resolved by NEXT'S OWN LOADER.
 *
 * A hand-written parser was wrong in two measured ways: Next also loads `.env.production.local` and
 * `.env.production` for a production build -- the real precedence is
 * `.env.production.local` > `.env.local` > `.env.production` > `.env`, with the inherited environment
 * above all of them -- and it supports `${VAR:-default}`, which the reimplementation resolved to the
 * empty string. Rather than chase dotenv-expand's grammar, this calls @next/env, which is already in
 * the release because Next is a dependency.
 *
 * Only the NEXT_PUBLIC_ subset crosses back: the child filters before serializing, so no other name
 * and no other value enters this process, the receipt, a log, or an error message.
 */
function resolveNextEnv(releaseDir) {
  try {
    return require.resolve("@next/env", { paths: [releaseDir] });
  } catch {
    throw new ReceiptError(
      "@next/env is not resolvable from the release, so the build inputs cannot be resolved the way " +
      "the build will resolve them. Dependencies must be installed before capture."
    );
  }
}

function effectiveBuildInputs(releaseDir, env) {
  const loaderMain = resolveNextEnv(releaseDir);
  const childEnv = env ? Object.assign({}, env) : Object.assign({}, process.env);
  // A hermetic child: nothing inherited unless the caller asked for it.
  const result = execFileSync(process.execPath, ["-e", NEXT_ENV_LOADER, loaderMain, releaseDir], {
    encoding: "utf8",
    env: childEnv,
    cwd: releaseDir,
    maxBuffer: 16 * 1024 * 1024
  });
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch (error) {
    throw new ReceiptError(`the environment loader returned unusable output: ${error.message}`);
  }
  const effective = new Map();
  for (const name of Object.keys(parsed.public).sort()) effective.set(name, parsed.public[name]);
  effective.loadedFiles = (parsed.files || []).map((f) => path.basename(f));
  return effective;
}

/**
 * Load Next's environment INTO THIS PROCESS, then run the build from it.
 *
 * This is the whole point: capture and build share one environment by construction, so there is no
 * transport between them to corrupt and no window between them to check. The previous shape captured
 * in one process, marshalled the values through a shell, exported them, built, and then "verified"
 * nothing had changed -- a check that read back its own exports.
 *
 * loadEnvConfig writes into process.env, which is exactly what is wanted here: the values it resolves
 * are the values the child build inherits, and Next gives an inherited value precedence over the file
 * it came from. Elsewhere that mutation is a hazard and the loader runs in a child; here it is the
 * mechanism.
 */
function runBuild(releaseDir, snapshotFile) {
  const loaderMain = resolveNextEnv(releaseDir);
  const { loadEnvConfig } = require(loaderMain);
  const silent = { info() {}, error() {}, warn() {} };
  const loaded = loadEnvConfig(releaseDir, false, silent, true);

  const publicNames = new Map();
  for (const name of Object.keys(loaded.combinedEnv || {}).sort()) {
    if (name.startsWith("NEXT_PUBLIC_")) publicNames.set(name, loaded.combinedEnv[name]);
  }
  const snapshot = closeBuildInputSet(releaseDir, publicNames);

  // Names only. A value is public but may be multiline, and a multiline value printed into the deploy
  // log can forge log lines.
  console.log(`build inputs bound before the build: ${Object.keys(snapshot.present).join(", ") || "(none)"}`);
  console.log(`  loaded env files: ${(loaded.loadedEnvFiles || []).map((f) => path.basename(f.path)).join(", ") || "(none)"}`);

  const result = spawnSync("npm", ["run", "build"], {
    cwd: releaseDir,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32"
  });

  snapshot.built = result.status === 0;
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2) + "\n");

  if (result.error) throw new ReceiptError(`could not start the build: ${result.error.message}`);
  return result.status === null ? 1 : result.status;
}

/**
 * The closed-set gate and the snapshot shape, defined ONCE.
 *
 * Two callers resolve the effective public inputs by different means -- runBuild loads Next's
 * environment into this process because the build must inherit it, while captureBuildInputs uses a
 * hermetic child because nothing should be inherited there. Only the resolution differs. Letting each
 * one also implement the refusal and the record shape would mean one of them could quietly stop
 * refusing, or record a differently-shaped snapshot, and every test would still pass.
 */
function closeBuildInputSet(releaseDir, effective) {
  const { policy, policyFile, allowed } = loadBuildInputPolicy(releaseDir);
  const undeclared = [...effective.keys()].filter((n) => !allowed.has(n)).sort();
  if (undeclared.length) {
    throw new ReceiptError(
      `build inputs are a closed set: ${undeclared.join(", ")} would be consumed by the build but are absent ` +
      `from scripts/fixtures/release-build-inputs.json. Declare it or remove it; a new build input must not ` +
      `appear silently.`
    );
  }
  const present = {};
  for (const name of [...effective.keys()].sort()) present[name] = effective.get(name);
  return {
    policy_digest: sha256Of(policyFile),
    declared: policy.allowed.map((e) => e.name).sort(),
    present
  };
}

function loadBuildInputPolicy(releaseDir) {
  const policyFile = path.join(releaseDir, "scripts", "fixtures", "release-build-inputs.json");
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  } catch (error) {
    throw new ReceiptError(`build-input policy not readable from the release: ${error.message}`);
  }
  if (policy.policy_version !== 1 || !Array.isArray(policy.allowed)) {
    throw new ReceiptError("build-input policy is malformed");
  }
  return { policy, policyFile, allowed: new Set(policy.allowed.map((e) => e.name)) };
}

/**
 * Resolve the effective public build inputs in a HERMETIC CHILD and close the set.
 *
 * Inspection only: it answers "what would this release's build inputs be?" without touching this
 * process's environment and without building. The deploy never uses it -- `--capture-build-inputs`
 * requires `--run-build`, so the shipped path always resolves inputs inside the process that builds.
 * Both paths share closeBuildInputSet, so the refusal and the snapshot shape cannot diverge.
 */
function captureBuildInputs(releaseDir, env) {
  return closeBuildInputSet(releaseDir, effectiveBuildInputs(releaseDir, env));
}

/**
 * Read the pre-build snapshot. There is deliberately NO post-build recomputation.
 *
 * An earlier version recomputed the effective set here and required it to be unchanged. That check was
 * SELF-FULFILLING in the real deploy path: the deploy exported the captured values before building and
 * then invoked this generator in the same shell, so the recomputation read those pinned values back out
 * of the environment and agreed with the snapshot no matter what the shared files now said. It detected
 * drift only in tests, which inject an environment explicitly.
 *
 * The build now runs INSIDE the capture process (see runBuild), so capture and build share one
 * environment by construction and there is no window between them to check. Keeping a vacuous
 * assertion would have been worse than removing it: it implied a guarantee that did not exist.
 *
 * WHAT REMAINS UNGUARDED, stated rather than implied: a NEW public name that appears in the shared
 * files after capture is still read by Next during the build, because Next reads those files itself and
 * our pinned environment cannot shadow a name we never captured. Such a name would be an undeclared
 * build input that no check sees. Closing that needs the env files to be immutable for the build's
 * duration -- a snapshot rather than a symlink into shared storage -- which is a change to how releases
 * are assembled and is recorded as its own candidate increment.
 */
function readBuildInputs(releaseDir, snapshotFile) {
  if (!snapshotFile) {
    throw new ReceiptError(
      "no build-input snapshot given: the receipt must be generated from the set captured before the " +
      "build, never by re-reading mutable env files afterwards"
    );
  }
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  } catch (error) {
    throw new ReceiptError(`build-input snapshot not readable: ${error.message}`);
  }
  if (!snapshot || typeof snapshot.present !== "object" || typeof snapshot.policy_digest !== "string") {
    throw new ReceiptError("build-input snapshot is malformed");
  }
  const { policyFile } = loadBuildInputPolicy(releaseDir);
  if (snapshot.policy_digest !== sha256Of(policyFile)) {
    throw new ReceiptError("the build-input policy changed between capture and receipt");
  }
  // The snapshot must have been produced by a run that actually built, or it does not describe this
  // artifact's inputs at all.
  if (snapshot.built !== true) {
    throw new ReceiptError(
      "the build-input snapshot was not produced by a build run: capture and build must happen in one " +
      "process (--run-build), so that the values recorded are the values Next compiled against"
    );
  }
  return snapshot;
}

function readExpectedInstances(releaseDir) {
  const file = path.join(releaseDir, "ecosystem.config.js");
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/^\s*instances:\s*(\d+)\s*,?\s*$/m);
  if (!m) throw new ReceiptError("ecosystem.config.js does not declare an integer instances count");
  return Number(m[1]);
}

function buildReceipt(options) {
  // No environment seam. Generation reads the snapshot the build wrote and consults no ambient
  // environment at all, so there is nothing here for a caller to substitute. The seam that existed
  // while generation recomputed the public inputs went away with the recomputation.
  const { releaseDir, repoDir, sha, branch, builtAtStart, buildInputsFile } = options;

  const policy = manifest.loadPolicy(path.join(releaseDir, "scripts", "fixtures", "artifact-manifest-policy.json"));
  const schema = loadSchema(releaseDir);

  // Source identity, recomputed rather than asserted.
  const tracked = git(repoDir, ["ls-tree", "-r", "--format=%(objectname)%x09%(path)", sha]).split("\n").filter(Boolean);
  let differ = 0;
  let missing = 0;
  for (const line of tracked) {
    const [oid, rel] = line.split("\t");
    const full = path.join(releaseDir, rel);
    if (!fs.existsSync(full)) {
      missing += 1;
      continue;
    }
    const got = execFileSync("git", ["hash-object", "--no-filters", "--", rel], {
      cwd: releaseDir,
      encoding: "utf8"
    }).trim();
    if (got !== oid) differ += 1;
  }
  const trackedSourceVerdict = missing ? "missing" : differ ? "differs" : "identical";

  const records = manifest.walkRelease(releaseDir, policy);

  const workflowFile = path.join(releaseDir, ".github", "workflows", "canonical-harness.yml");
  const certified = toolchain.readCiPins(fs.readFileSync(workflowFile, "utf8"));
  const built = toolchain.buildToolchain();

  const harnessLock = path.join(releaseDir, "requirements-harness.txt");

  const receipt = {
    schema_version: 1,
    release: path.basename(releaseDir),
    release_path: releaseDir,
    commit: sha,
    commit_tree: git(repoDir, ["rev-parse", `${sha}^{tree}`]),
    branch,
    ref_resolution: { mode: "explicit_sha", ancestor_of: `refs/remotes/origin/${branch}` },
    tracked_path_count: tracked.length,
    tracked_source_verdict: trackedSourceVerdict,
    package_lock_sha256: sha256Of(path.join(releaseDir, "package-lock.json")),
    harness_lock_sha256: fs.existsSync(harnessLock) ? sha256Of(harnessLock) : null,
    next_version: JSON.parse(fs.readFileSync(path.join(releaseDir, "package.json"), "utf8")).dependencies.next,
    build_id: fs.readFileSync(path.join(releaseDir, ".next", "BUILD_ID"), "utf8").trim(),
    build_node: built.node,
    build_npm: built.npm,
    certified_toolchain: certified,
    manifest_algorithm: manifest.MANIFEST_ALGORITHM,
    manifest_digest: manifest.digestRecords(records),
    manifest_record_count: records.length,
    manifest_exclusions: manifest.exclusionList(policy),
    manifest_policy_digest: policy.digest,
    // Read, not recomputed: `env` is deliberately NOT consulted here. Generation must report what the
    // build compiled against, and only the process that built can attest that.
    build_inputs: readBuildInputs(releaseDir, buildInputsFile),
    pm2_expected_instances: readExpectedInstances(releaseDir),
    built_at_start: builtAtStart,
    built_at_end: new Date().toISOString()
  };

  const problems = validateReceipt(receipt, schema);
  if (problems.length) throw new ReceiptError(`the generated receipt does not satisfy its own schema:\n  ${problems.join("\n  ")}`);
  return { receipt, records, policy };
}

// ---------------------------------------------------------------------------

/**
 * The generator's closed argument set. Every flag takes exactly one following value.
 *
 * Unknown flags are REFUSED, never dropped. Silently ignoring `--output` when the flag is `--out`
 * would write the receipt to the default path while the operator believed otherwise, and report
 * success -- an operator mistake turned into an apparently correct result.
 */
const GENERATE_FLAGS = ["release", "repo", "sha", "branch", "built-at-start", "out",
  "build-inputs", "capture-build-inputs", "run-build"];

function parseArgs(argv, known, program) {
  const out = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string" || !token.startsWith("--")) {
      throw new Error(`${program}: unexpected argument ${JSON.stringify(token)}; every argument must be a --flag with one value`);
    }
    if (token.includes("=")) {
      throw new Error(`${program}: ${token} uses --flag=value, which is not supported; write --flag value`);
    }
    const name = token.slice(2);
    if (!known.includes(name)) {
      throw new Error(`${program}: unknown flag ${token} (supported: ${known.map((k) => "--" + k).join(" ")})`);
    }
    if (seen.has(name)) {
      throw new Error(`${program}: ${token} given more than once`);
    }
    const value = argv[i + 1];
    if (value === undefined || (typeof value === "string" && value.startsWith("--"))) {
      throw new Error(`${program}: ${token} requires exactly one value`);
    }
    seen.add(name);
    out[name] = value;
    i += 1;
  }
  return out;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv, GENERATE_FLAGS, "generate-release-receipt");
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  // CAPTURE MODE, run BEFORE `npm run build`. It writes the effective public build-input set and
  // refuses any undeclared name, so the build is never started against inputs the repository has not
  // declared. This is the snapshot the receipt is later generated from.
  // CAPTURE-AND-BUILD, one process. Next's environment is loaded here, the public subset is validated
  // against the closed allowlist BEFORE anything is built, and the build then runs from this very
  // environment -- so the values recorded are the values Next compiled against, with no transport
  // between them and no window to check.
  if (args["capture-build-inputs"]) {
    if (!args.release) {
      console.error("generate-release-receipt: --release <dir> is required with --capture-build-inputs");
      return 2;
    }
    if (!args["run-build"]) {
      console.error(
        "generate-release-receipt: --capture-build-inputs requires --run-build. Capturing without " +
        "building leaves a window in which the shared env files can move, and the receipt would then " +
        "describe inputs the artifact was not compiled against."
      );
      return 2;
    }
    try {
      return runBuild(path.resolve(args.release), args["capture-build-inputs"]);
    } catch (error) {
      console.error(`generate-release-receipt: ${error.message}`);
      return 1;
    }
  }

  for (const need of ["release", "repo", "sha", "branch"]) {
    if (!args[need]) {
      console.error(`generate-release-receipt: --${need} is required`);
      return 2;
    }
  }
  const out = args.out || path.join(args.release, RECEIPT_NAME);
  try {
    const { receipt, records } = buildReceipt({
      releaseDir: path.resolve(args.release),
      repoDir: path.resolve(args.repo),
      sha: args.sha,
      branch: args.branch,
      builtAtStart: args["built-at-start"] || new Date().toISOString(),
      buildInputsFile: args["build-inputs"]
    });
    fs.writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n");
    console.log(`receipt written: ${out}`);
    console.log(`  commit            ${receipt.commit}`);
    console.log(`  source            ${receipt.tracked_source_verdict} (${receipt.tracked_path_count} tracked paths)`);
    console.log(`  manifest          ${records.length} records, digest ${receipt.manifest_digest}`);
    console.log(`  exclusions        ${receipt.manifest_exclusions.length} from policy ${receipt.manifest_policy_digest.slice(0, 16)}…`);
    console.log(`  build node        ${receipt.build_node.version} (${receipt.build_node.path})`);
    console.log(`  certified node    ${receipt.certified_toolchain.node}`);
    console.log(`  build inputs      ${Object.keys(receipt.build_inputs.present).join(", ") || "(none present)"}`);
    console.log(`  expected workers  ${receipt.pm2_expected_instances}`);
    return 0;
  } catch (error) {
    console.error(`generate-release-receipt: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { RECEIPT_NAME, ReceiptError, parseArgs, GENERATE_FLAGS, captureBuildInputs, effectiveBuildInputs, loadSchema, validateReceipt, buildReceipt, readBuildInputs, readExpectedInstances, main };
