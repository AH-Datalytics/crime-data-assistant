/**
 * Acquire a Tier C corpus snapshot set.
 *
 * ONE SET, ALL OR NOTHING. Both databases are snapshotted, transferred and verified before anything is
 * published. A failure anywhere leaves the previous verified set exactly as it was, so a broken
 * acquisition degrades to "stale but verified" and never to "unverified" -- and files from two different
 * acquisitions can never end up in the same published set.
 *
 * SOURCE MODES.
 *
 *   --local-fake <dir>   Sources are local SQLite files standing in for production. Every step runs:
 *                        online-backup snapshot, artifact hashing, "transfer" (a local copy), local
 *                        hash comparison, integrity check, reviewed-schema comparison, row floors,
 *                        receipt cross-check, atomic publication. Only the network is absent.
 *
 *   production           NOT IMPLEMENTED HERE, DELIBERATELY. Remote snapshot creation, hashing,
 *                        transfer, revalidation and cleanup are separately authorized production
 *                        operations. The stub throws rather than being left as a code path someone
 *                        could enable by accident.
 *
 * Nothing here writes to a source database. The snapshot step opens sources read-only and asserts the
 * live file and its WAL are byte-identical before and after.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const snapshot = require("./lib/corpus-snapshot.js");
const { loadRegistry } = require("./lib/corpus-registry.js");

const REPO = path.join(__dirname, "..");

function parseArgs(argv) {
  const options = { localFake: null, root: null, setId: null, now: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local-fake") options.localFake = argv[++i];
    else if (arg === "--root") options.root = argv[++i];
    else if (arg === "--set-id") options.setId = argv[++i];
    else if (arg === "--now") options.now = argv[++i];
    else if (arg === "--json") options.json = argv[++i];
    else if (arg === "--production") {
      throw new Error(
        "production acquisition is not implemented in this tool. Remote snapshot creation, hashing, " +
        "transfer, revalidation and cleanup are separately authorized production operations."
      );
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.localFake) {
    throw new Error("--local-fake <dir> is required; production acquisition is separately gated");
  }
  if (!options.root) throw new Error("--root <dir> is required (the snapshot store)");
  return options;
}

/**
 * Where a corpus's live source is, in fake mode.
 *
 * Records BOTH the literal configured path and the resolved path. `/opt/nibrs/nibrs.db` is a symlink in
 * production, and assuming the configured path is the real file is a close relative of the stale-path
 * defect this registry exists to prevent -- so which file was actually read is recorded, not inferred.
 */
function resolveFakeSource(corpus, fakeDir) {
  const literal = path.join(fakeDir, path.basename(corpus.authoritative_remote));
  if (!fs.existsSync(literal)) {
    return { literal, resolved: null, error: `no fake source at ${literal}` };
  }
  return { literal, resolved: fs.realpathSync.native(literal), error: null };
}

async function acquire(options) {
  // The registry can be injected so acceptance tests can declare reviewed fingerprints for FAKE
  // sources. The committed registry is bootstrap_pending for both corpora by design, so a test that
  // used it could never reach a published set and would prove nothing about publication.
  const registry = options.registry || loadRegistry(options.registryPath);
  const setId = options.setId || `set-${(options.now || new Date().toISOString()).replace(/[:.]/g, "-")}`;
  const staging = path.join(options.root, "sets", `${setId}.staging`);
  fs.mkdirSync(staging, { recursive: true });

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-remote-"));
  const manifest = {
    snapshot_set_id: setId,
    tool_commit: currentCommit(),
    app_commit: currentCommit(),
    corpora: {},
  };
  const tempPaths = [];
  const problems = [];

  try {
    for (const corpus of registry.corpora) {
      const source = resolveFakeSource(corpus, options.localFake);
      const record = {
        literal_source_path: source.literal,
        resolved_source_path: source.resolved,
        authoritative_remote: corpus.authoritative_remote,
      };
      manifest.corpora[corpus.id] = record;

      if (source.error) {
        record.state = snapshot.REASON.ABSENT;
        record.detail = source.error;
        problems.push(`${corpus.id}: ${source.error}`);
        continue;
      }

      // --- remote side: create the immutable artifact and hash THAT, never the live file
      const remoteArtifact = path.join(scratch, `${corpus.id}.snapshot.db`);
      tempPaths.push(remoteArtifact);
      const created = await snapshot.createSnapshotArtifact(source.resolved, remoteArtifact,
        { now: options.now });
      record.remote_snapshot_created_at = created.created_at_utc;
      record.remote_snapshot_sha256 = created.sha256;
      record.remote_snapshot_bytes = created.bytes;
      record.live_source_before = created.live_source_before;
      record.live_source_after = created.live_source_after;
      record.live_source_unmodified = created.live_source_unmodified;
      record.remote_temp_paths = [remoteArtifact];

      // --- transfer to a .partial, then promote within staging only after it verifies
      const partial = path.join(staging, `${corpus.id}.db.partial`);
      fs.copyFileSync(remoteArtifact, partial);
      record.local_sha256 = snapshot.sha256File(partial);
      record.local_bytes = fs.statSync(partial).size;

      const verdict = snapshot.verifyArtifact(corpus, partial, {
        remote_snapshot_sha256: record.remote_snapshot_sha256,
      });
      record.state = verdict.ok ? "verified" : verdict.reason;
      record.detail = verdict.detail;
      record.observed_schema_fingerprint = verdict.observed.schema_fingerprint || null;
      record.observed_counts = verdict.observed.counts || null;
      record.integrity = verdict.observed.integrity || null;
      record.receipt_diagnostics = verdict.observed.receipt_diagnostics || null;

      // Verification opened the .partial read-only, which materialises `-wal`/`-shm` named after it.
      // Renaming only the main file would publish a set containing orphaned sidecars for a filename
      // that no longer exists, so they are removed before promotion either way.
      snapshot.removeSidecars(partial);

      if (!verdict.ok) {
        problems.push(`${corpus.id}: ${verdict.reason} -- ${verdict.detail}`);
        continue;
      }
      fs.renameSync(partial, path.join(staging, `${corpus.id}.db`));
    }

    manifest.set_age_anchor = snapshot.setAgeAnchor(manifest);

    if (problems.length) {
      // The whole point of all-or-nothing: the previous set is untouched and still active.
      const previous = snapshot.loadActiveSet(options.root);
      fs.rmSync(staging, { recursive: true, force: true });
      return {
        published: false,
        setId,
        manifest,
        problems,
        previousStillActive: previous ? previous.snapshot_set_id : null,
      };
    }

    const dir = snapshot.publishSet(options.root, setId, manifest);
    return { published: true, setId, dir, manifest, problems: [] };
  } finally {
    // Delete exactly what this run created, and nothing adjacent to it.
    snapshot.cleanupTempPaths(tempPaths);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function currentCommit() {
  try {
    return require("node:child_process")
      .execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const result = await acquire(options);

  console.log(`snapshot set ${result.setId}`);
  for (const [id, record] of Object.entries(result.manifest.corpora)) {
    console.log(`  ${id.padEnd(6)} ${String(record.state).padEnd(24)} ${record.detail || ""}`);
    if (record.observed_schema_fingerprint) {
      console.log(`         observed fingerprint: ${record.observed_schema_fingerprint}`);
    }
    if (record.live_source_unmodified === false) {
      console.log("         WARNING: the live source changed across the backup");
    }
  }
  console.log(`  set_age_anchor: ${result.manifest.set_age_anchor || "(none)"}`);

  if (result.published) {
    console.log(`PUBLISHED -> ${result.dir}`);
  } else {
    console.log(`NOT PUBLISHED. ${result.problems.length} problem(s):`);
    for (const problem of result.problems) console.log(`    ${problem}`);
    console.log(`  previous verified set still active: ${result.previousStillActive || "(none)"}`);
  }

  if (options.json) {
    fs.writeFileSync(options.json, JSON.stringify(result, null, 2) + "\n");
  }
  return result.published ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}

module.exports = { acquire, parseArgs, resolveFakeSource };
