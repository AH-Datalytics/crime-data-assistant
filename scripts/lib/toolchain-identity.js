/**
 * L6: the certified, build and runtime toolchains satisfy the declared alignment contract.
 *
 * TWO HALVES THAT COMPARE DIFFERENT THINGS, on purpose.
 *
 *   half A -- certified <-> build: VERSIONS ONLY. CI runs on windows-latest; production builds on
 *   Linux x86-64. Node 24.14.0 for Windows and Node 24.14.0 for Linux are different executables with
 *   different digests, necessarily and forever, so comparing their hashes would be a check that could
 *   only ever fail. No executable hash crosses the platform boundary.
 *
 *   half B -- build <-> workers: the EXACT Linux executable. Path, version and SHA-256 read through
 *   /proc/<pid>/exe, which is the running image even if the on-disk binary has since been replaced.
 *   `PATH` is never consulted: the question is not "what is on PATH now" but "which binary is this
 *   worker executing".
 *
 * WHY THE DIGEST IS LOAD-BEARING. PM2 cluster workers are forked by the PM2 daemon and inherit ITS
 * interpreter. The daemon had been up 27 days when this was measured, spanning several deploys.
 * Installing a new Node and reloading the app therefore does not change what the workers execute; the
 * daemon must be restarted too. A version check against PATH would report success while every worker
 * still ran the old binary. That is the false acceptance this closes.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const POLICY_DOC_FIELDS = ["_README", "policy_version", "node", "npm"];

class ToolchainError extends Error {}

function parseToolchainPolicy(text, label) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new ToolchainError(`${label}: not valid JSON: ${error.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ToolchainError(`${label}: must be a JSON object`);
  }
  for (const field of Object.keys(doc)) {
    if (!POLICY_DOC_FIELDS.includes(field)) {
      throw new ToolchainError(`${label}: unknown top-level field ${field} (allowed: ${POLICY_DOC_FIELDS.join(", ")})`);
    }
  }
  if (doc.policy_version !== 1) throw new ToolchainError(`${label}: unsupported policy_version`);
  for (const field of ["node", "npm"]) {
    if (typeof doc[field] !== "string" || !/^\d+\.\d+\.\d+$/.test(doc[field])) {
      throw new ToolchainError(`${label}: ${field} must be an exact x.y.z version`);
    }
  }
  return { policy_version: doc.policy_version, node: doc.node, npm: doc.npm };
}

function loadToolchainPolicy(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new ToolchainError(`${file}: not readable`);
  }
  const policy = parseToolchainPolicy(text, file);
  policy.digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return policy;
}

/**
 * The versions CI certifies on, read from the workflow AT THE RECEIPTED COMMIT.
 *
 * npm is deliberately reported as null rather than guessed: the workflow pins a Node version and npm
 * ships inside that distribution, so there is no pinned npm to compare against. Recording `null` and
 * declining to compare is honest; inventing a value would make half A assert something the workflow
 * never said.
 */
function readCiPins(workflowText) {
  const node = workflowText.match(/^\s*node-version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m);
  if (!node) throw new ToolchainError("the workflow does not pin an exact node-version");
  return { node: node[1], npm: null, npm_note: "not pinned by the workflow; ships with the Node distribution" };
}

/**
 * npm's version, resolved by running its CLI THROUGH the same node.
 *
 * Not by spawning `npm`: on Windows that is a .cmd, which modern Node refuses to execFile without a
 * shell, and adding a shell to read a version string is not worth the quoting surface. Running
 * npm-cli.js through the interpreter under test also answers the right question -- the npm that ships
 * beside THIS node -- rather than whatever a PATH lookup happens to find.
 */
function npmVersion(execPath) {
  const dir = path.dirname(execPath);
  const candidates = [
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),          // Windows layout
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js") // POSIX layout
  ];
  for (const cli of candidates) {
    if (!fs.existsSync(cli)) continue;
    try {
      return execFileSync(execPath, [cli, "--version"], { encoding: "utf8", timeout: 30000 }).trim();
    } catch {
      /* try the next layout */
    }
  }
  return null;
}

/** The interpreter that is running this process, plus the npm beside it. */
function buildToolchain(options) {
  const opts = options || {};
  const execPath = opts.execPath || process.execPath;
  const record = {
    path: execPath,
    version: (opts.nodeVersion || process.version).replace(/^v/, ""),
    sha256: null
  };
  try {
    record.sha256 = crypto.createHash("sha256").update(fs.readFileSync(execPath)).digest("hex");
  } catch (error) {
    record.sha256 = null;
    record.sha256_note = `unreadable: ${error.code || error.message}`;
  }
  return { node: record, npm: { version: opts.npmVersion || npmVersion(execPath) } };
}

/**
 * Half A. Compares declared, certified and built VERSIONS. Never digests.
 */
function compareVersions(policy, ci, build) {
  const findings = [];
  if (policy.node !== ci.node) {
    findings.push(`declared node ${policy.node} != CI-pinned node ${ci.node}`);
  }
  if (!build.node.version) {
    findings.push("the build recorded no node version");
  } else if (policy.node !== build.node.version) {
    findings.push(`declared node ${policy.node} != build node ${build.node.version}`);
  }
  if (!build.npm.version) {
    findings.push("the build recorded no npm version");
  } else if (policy.npm !== build.npm.version) {
    findings.push(`declared npm ${policy.npm} != build npm ${build.npm.version}`);
  }
  // ci.npm is intentionally not compared -- see readCiPins.
  return { state: findings.length ? "fail" : "pass", findings };
}

/**
 * Half B. Compares the exact Linux executable of every live worker against the receipt.
 *
 * `workers` is an array of {pid, exePath, version, sha256, deleted}. Reading /proc is the caller's
 * job so this stays testable off Linux.
 */
function compareExecutables(buildNode, workers) {
  const findings = [];
  if (!Array.isArray(workers) || workers.length === 0) {
    return { state: "unverified", findings: ["no worker interpreters were readable"] };
  }
  if (!buildNode || !buildNode.sha256) {
    return { state: "unverified", findings: ["the receipt records no build interpreter digest to compare against"] };
  }
  for (const w of workers) {
    if (w.deleted) {
      findings.push(`pid ${w.pid}: /proc/${w.pid}/exe names a DELETED file (${w.exePath}); the running image no longer exists on disk`);
    }
    if (w.exePath !== buildNode.path) {
      findings.push(`pid ${w.pid}: executing ${w.exePath}, receipt records ${buildNode.path}`);
    }
    if (w.version && buildNode.version && w.version !== buildNode.version) {
      findings.push(`pid ${w.pid}: node ${w.version}, receipt records ${buildNode.version}`);
    }
    if (!w.sha256) {
      findings.push(`pid ${w.pid}: the running image could not be hashed`);
    } else if (w.sha256 !== buildNode.sha256) {
      findings.push(`pid ${w.pid}: executable digest ${w.sha256.slice(0, 16)}… != receipt ${buildNode.sha256.slice(0, 16)}…`);
    }
  }
  return { state: findings.length ? "fail" : "pass", findings };
}

/**
 * Read one worker's interpreter through /proc. Linux only; returns null elsewhere.
 * Hashes THROUGH /proc/<pid>/exe so the bytes are the running image, not whatever now sits at the path.
 */
function readWorkerToolchain(pid) {
  if (process.platform !== "linux") return null;
  const link = `/proc/${pid}/exe`;
  let exePath = null;
  let deleted = false;
  try {
    exePath = fs.readlinkSync(link);
    if (exePath.endsWith(" (deleted)")) {
      deleted = true;
      exePath = exePath.slice(0, -" (deleted)".length);
    }
  } catch (error) {
    return { pid, exePath: null, version: null, sha256: null, deleted: false, error: error.code || String(error) };
  }
  let sha256 = null;
  try {
    sha256 = crypto.createHash("sha256").update(fs.readFileSync(link)).digest("hex");
  } catch {
    sha256 = null;
  }
  let version = null;
  try {
    version = execFileSync(link, ["--version"], { encoding: "utf8" }).trim().replace(/^v/, "");
  } catch {
    version = null;
  }
  return { pid, exePath, version, sha256, deleted };
}

module.exports = {
  ToolchainError,
  POLICY_DOC_FIELDS,
  parseToolchainPolicy,
  loadToolchainPolicy,
  readCiPins,
  buildToolchain,
  compareVersions,
  compareExecutables,
  readWorkerToolchain
};
