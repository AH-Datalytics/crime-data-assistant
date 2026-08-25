/**
 * The artifact manifest: a record per behaviour-bearing entry in a published release, and a single
 * digest over them.
 *
 * WHY A RECEIPT AND NOT A REBUILD. `.next` is not reproducible. Next 16.1.6 leaves `generateBuildId`
 * at its default, which returns null, and the fallback is `nanoid` -- measured across the five live
 * releases as five distinct random ids. `next build` also embeds the absolute release path in its
 * output (measured: exactly one file, `.next/required-server-files.json`). So two builds of the same
 * commit differ for two independent reasons, and any design that compared two builds would be
 * comparing noise. This module therefore records the bytes ONCE, at publish time, and every later
 * check proves the running bytes are still those bytes. That is a weaker property than
 * reproducibility and is described as such.
 *
 * THE POLICY IS NOT THE RECEIPT'S TO WRITE. Exclusions come from a committed policy whose blob is
 * proven equal to the deployed commit's tree (L2). A receipt that could name its own exclusions could
 * exempt `node_modules` and then verify itself.
 *
 * PLATFORM SPLIT, STATED RATHER THAN HIDDEN. The manifest is computed on Linux; this repository's
 * harness runs on Windows, where NTFS has no executable bit and creating a symlink needs a privilege
 * the runner may not have (measured: fs.symlinkSync returns EPERM). `buildRecord` is therefore a PURE
 * function over a stat-like object, exhaustively testable anywhere, and `walk` is the only
 * platform-dependent part. The behavioural symlink and exec-bit controls run in a Linux container.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// v2: one JSON tuple per record. v1 used unescaped tab/newline-delimited fields, which let a symlink
// target forge a record boundary and collide two different trees onto one digest. No receipt has ever
// been deployed, so the version moves with no migration cost -- and a v1 receipt is now refused rather
// than silently compared under different rules.
const MANIFEST_ALGORITHM = "sha256-over-sorted-json-records-v2";

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

const POLICY_DOC_FIELDS = ["_README", "policy_version", "exclusions"];
const POLICY_ENTRY_FIELDS = ["path", "scope", "reason", "detail"];
const POLICY_SCOPES = ["path", "tree"];
const POLICY_REASONS = ["runtime_cache", "build_profiling", "build_telemetry", "self_reference"];

class PolicyError extends Error {}

/**
 * Parse and validate a manifest policy. Closed at both levels: unknown document fields and unknown
 * entry fields are refused, as are unknown scopes and reasons.
 *
 * Never returns a default. An unreadable or invalid policy throws, and callers turn that into
 * `unverified` -- a verifier that falls back to built-in exclusions passes when its policy is missing.
 */
function parsePolicy(text, label) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new PolicyError(`${label}: not valid JSON: ${error.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new PolicyError(`${label}: must be a JSON object`);
  }
  for (const field of Object.keys(doc)) {
    if (!POLICY_DOC_FIELDS.includes(field)) {
      throw new PolicyError(`${label}: unknown top-level field ${field} (allowed: ${POLICY_DOC_FIELDS.join(", ")})`);
    }
  }
  if (doc.policy_version !== 1) {
    throw new PolicyError(`${label}: unsupported policy_version ${JSON.stringify(doc.policy_version)}`);
  }
  if (!Array.isArray(doc.exclusions) || doc.exclusions.length === 0) {
    throw new PolicyError(`${label}: exclusions must be a non-empty array`);
  }
  const seen = new Set();
  for (const entry of doc.exclusions) {
    const shown = entry && typeof entry.path === "string" ? entry.path : JSON.stringify(entry);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PolicyError(`${label}: ${shown}: each exclusion must be an object`);
    }
    for (const field of Object.keys(entry)) {
      if (!POLICY_ENTRY_FIELDS.includes(field)) {
        throw new PolicyError(`${label}: ${shown}: unknown field ${field} (allowed: ${POLICY_ENTRY_FIELDS.join(", ")})`);
      }
    }
    for (const field of POLICY_ENTRY_FIELDS) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new PolicyError(`${label}: ${shown}: missing or empty required field ${field}`);
      }
    }
    if (!POLICY_SCOPES.includes(entry.scope)) {
      throw new PolicyError(`${label}: ${shown}: unknown scope ${entry.scope}`);
    }
    if (!POLICY_REASONS.includes(entry.reason)) {
      throw new PolicyError(`${label}: ${shown}: unknown reason ${entry.reason}`);
    }
    const parts = entry.path.split("/");
    if (entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.endsWith("/") ||
        parts.includes("..") || parts.includes(".") || parts.includes("")) {
      throw new PolicyError(`${label}: ${shown}: path must be a relative POSIX path inside the release`);
    }
    if (seen.has(entry.path)) throw new PolicyError(`${label}: duplicate exclusion ${entry.path}`);
    seen.add(entry.path);
  }
  return { policy_version: doc.policy_version, exclusions: doc.exclusions.map((e) => ({ ...e })) };
}

function loadPolicy(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new PolicyError(`${file}: not readable`);
  }
  const policy = parsePolicy(text, file);
  policy.digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return policy;
}

/** The exclusion list as the receipt records it: scope and path only, sorted, no prose. */
function exclusionList(policy) {
  return policy.exclusions
    .map((e) => `${e.scope} ${e.path}`)
    .sort((a, b) => (Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))));
}

function isExcluded(relPath, policy) {
  for (const entry of policy.exclusions) {
    if (entry.scope === "path" && relPath === entry.path) return true;
    if (entry.scope === "tree" && (relPath === entry.path || relPath.startsWith(entry.path + "/"))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/**
 * Build one manifest record. PURE: takes a stat-like object rather than touching the filesystem, so
 * every field can be exercised on a platform that cannot create the object being described.
 *
 * `statLike` needs `isSymbolicLink()`, `isDirectory()`, `isFile()`, `mode`, `size`.
 * `content` is the sha256 hex for files, and must be absent for links and directories.
 * `target` is the raw link text for symlinks -- NEVER a resolved path.
 *
 * No mtime: it is not behaviour-bearing, it varies with the copy mechanism, and including it would
 * make the manifest depend on how the release was assembled rather than on what it contains.
 */
function buildRecord(statLike, relPath, options) {
  const opts = options || {};
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("buildRecord: relPath must be a non-empty string");
  }
  if (relPath.startsWith("/") || relPath.includes("\\") || relPath.startsWith("./")) {
    throw new Error(`buildRecord: relPath must be normalized POSIX-relative: ${relPath}`);
  }

  if (statLike.isSymbolicLink()) {
    if (typeof opts.target !== "string") {
      throw new Error(`buildRecord: ${relPath} is a symlink and needs its target text`);
    }
    // No exec, no size, no sha256: a link is identified by where it points, and the target is never
    // followed. This is how shared state -- .env and the databases -- stays unread.
    return { path: relPath, type: "symlink", target: opts.target };
  }

  if (statLike.isDirectory()) {
    // Directories appear only when EMPTY. A directory with contents is implied by those contents;
    // an empty one is otherwise unrepresentable, and `.next/node_modules` is empty in the live release.
    return { path: relPath, type: "dir" };
  }

  if (!statLike.isFile()) {
    throw new Error(`buildRecord: ${relPath} is neither a file, a directory nor a symlink`);
  }
  if (typeof opts.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(opts.sha256)) {
    throw new Error(`buildRecord: ${relPath} is a file and needs a sha256`);
  }
  // The executable BIT only, not the full mode: umask noise must not move the digest.
  const exec = (statLike.mode & 0o111) !== 0;
  return { path: relPath, type: "file", exec, size: statLike.size, sha256: opts.sha256 };
}

/**
 * Deterministic serialization: sorted by path as a RAW BYTE SEQUENCE, never locale collation, with
 * one JSON tuple per record.
 *
 * THE ENCODING MUST BE UNAMBIGUOUS, and the first one was not. Tab-separated fields joined by
 * newlines, with no escaping, let a symlink target forge a record boundary -- so these two different
 * release trees produced byte-identical manifests and therefore the same digest:
 *
 *   one symlink   a -> "x\nsymlink\tb\ty"
 *   two symlinks  a -> "x"  and  b -> "y"
 *
 * That is reachable, not theoretical: a path or a link target may contain a newline or a tab on Linux
 * -- which is exactly why /proc/<pid>/maps escapes them. JSON.stringify escapes both, so a value can
 * no longer impersonate structure.
 */
function serialize(records) {
  const sorted = [...records].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"))
  );
  const lines = sorted.map((r) => {
    if (r.type === "symlink") return JSON.stringify(["symlink", r.path, r.target]);
    if (r.type === "dir") return JSON.stringify(["dir", r.path]);
    return JSON.stringify(["file", r.path, r.exec, r.size, r.sha256]);
  });
  return Buffer.from(lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
}

function digestRecords(records) {
  return crypto.createHash("sha256").update(serialize(records)).digest("hex");
}

// ---------------------------------------------------------------------------
// walking a release
// ---------------------------------------------------------------------------

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Walk a release directory into manifest records.
 *
 * `lstat` throughout, so a symlink is never followed -- not to classify it, not to size it, not to
 * hash it. That is the property that keeps shared state out of the manifest.
 */
function walkRelease(root, policy) {
  const records = [];
  const stack = [""];
  while (stack.length) {
    const prefix = stack.pop();
    const dir = prefix ? path.join(root, prefix) : root;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8"))
    );
    if (entries.length === 0 && prefix) {
      records.push(buildRecord(fs.lstatSync(dir), prefix));
      continue;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isExcluded(rel, policy)) continue;
      const full = path.join(root, rel);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        records.push(buildRecord(st, rel, { target: fs.readlinkSync(full) }));
      } else if (st.isDirectory()) {
        stack.push(rel);
      } else if (st.isFile()) {
        records.push(buildRecord(st, rel, { sha256: sha256File(full) }));
      } else {
        throw new Error(`walkRelease: ${rel} is neither a file, a directory nor a symlink`);
      }
    }
  }
  return records;
}

/** Compare two record sets, reporting the first differences by path. */
function compareRecords(expected, actual) {
  const key = (r) => r.path;
  const a = new Map(expected.map((r) => [key(r), r]));
  const b = new Map(actual.map((r) => [key(r), r]));
  const missing = [];
  const added = [];
  const changed = [];
  for (const [p, rec] of a) {
    if (!b.has(p)) {
      missing.push(p);
      continue;
    }
    const other = b.get(p);
    const one = serialize([rec]).toString("utf8");
    const two = serialize([other]).toString("utf8");
    if (one !== two) changed.push({ path: p, expected: one.trim(), actual: two.trim() });
  }
  for (const p of b.keys()) if (!a.has(p)) added.push(p);
  return { missing, added, changed, equal: !missing.length && !added.length && !changed.length };
}

module.exports = {
  MANIFEST_ALGORITHM,
  PolicyError,
  parsePolicy,
  loadPolicy,
  exclusionList,
  isExcluded,
  buildRecord,
  serialize,
  digestRecords,
  walkRelease,
  compareRecords,
  sha256File,
  POLICY_DOC_FIELDS,
  POLICY_ENTRY_FIELDS,
  POLICY_SCOPES,
  POLICY_REASONS
};
