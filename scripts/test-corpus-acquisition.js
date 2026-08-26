/**
 * Acceptance and mutation tests for Tier C corpus acquisition, against LOCAL FAKE SOURCES only.
 *
 * Each test builds throwaway SQLite databases that stand in for production, so the whole protocol runs
 * -- online-backup snapshot, artifact hashing, transfer, local hash comparison, integrity check,
 * reviewed-schema comparison, row floors, receipt cross-check, atomic publication, revalidation,
 * cleanup. Only the network is absent. No production contact.
 *
 * The three tests that matter most are the regressions for errors I made in earlier revisions of this
 * contract:
 *
 *   WAL-1  committed WAL content must appear in the snapshot          (revision 2 would have lost it)
 *   WAL-2  a matching MAIN-FILE hash must not be accepted as equal    (the false confidence)
 *   AGE-2  a fresh built_at must not rescue a stale acquisition       (proxy for the property)
 *
 * Every mutation asserts the thing it breaks actually changed, so a mutation that quietly no-ops cannot
 * be mistaken for evidence.
 */
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const snapshot = require("./lib/corpus-snapshot.js");
const { validateRegistry, forbiddenPaths, loadRegistry } = require("./lib/corpus-registry.js");
const Database = require("better-sqlite3");

let passed = 0;
const failures = [];

/**
 * Fixture connections stay OPEN for the duration of a test, and the harness closes them afterwards.
 *
 * This is not tidiness, it is correctness: closing the LAST connection to a WAL database checkpoints
 * the WAL into the main file and deletes it. A fixture that closed its handle would have no WAL-resident
 * data at all, so every WAL test would pass while testing nothing -- which is exactly what happened on
 * the first run. Keeping a connection open also matches production, where the application is attached.
 */
const openHandles = [];

function check(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-test-"));
  return Promise.resolve()
    .then(() => body(dir))
    .then(() => { passed++; console.log(`  ok    ${name}`); })
    .catch((error) => {
      failures.push(`${name}: ${error.message}`);
      console.log(`  FAIL  ${name}`);
      console.log(`        ${error.message.split("\n")[0]}`);
    })
    .then(() => {
      while (openHandles.length) {
        try { openHandles.pop().close(); } catch { /* already closed */ }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

// ---------------------------------------------------------------------------------------------------
// Fake production databases
// ---------------------------------------------------------------------------------------------------

/**
 * A fake corpus in WAL mode. `walResident` rows are committed but deliberately NOT checkpointed, so
 * they exist only in the -wal -- which is the whole situation the protocol has to survive.
 */
function makeFakeCorpus(file, options) {
  const opts = options || {};
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE incidents (id INTEGER PRIMARY KEY, year INTEGER, note TEXT);
    CREATE TABLE agencies (ori TEXT PRIMARY KEY, name TEXT);
  `);
  if (opts.extraTable) db.exec(`CREATE TABLE ${opts.extraTable} (x INTEGER)`);
  if (opts.receipts) {
    db.exec(`CREATE TABLE source_build_receipts (
      component TEXT, status TEXT, table_counts_json TEXT, source_version TEXT, built_at TEXT)`);
  }

  const insertIncident = db.prepare("INSERT INTO incidents (year, note) VALUES (?, ?)");
  const checkpointed = opts.checkpointed === undefined ? 10 : opts.checkpointed;
  db.transaction(() => {
    for (let i = 0; i < checkpointed; i++) insertIncident.run(2020, `checkpointed ${i}`);
    db.prepare("INSERT INTO agencies (ori, name) VALUES (?, ?)").run("TX0010000", "AUSTIN");
  })();
  db.pragma("wal_checkpoint(TRUNCATE)");

  // Everything after this point stays in the WAL.
  db.pragma("wal_autocheckpoint = 0");
  const walResident = opts.walResident || 0;
  if (walResident) {
    db.transaction(() => {
      for (let i = 0; i < walResident; i++) insertIncident.run(2021, `wal-resident ${i}`);
    })();
  }
  if (opts.receipts) {
    const total = checkpointed + walResident;
    db.prepare(`INSERT INTO source_build_receipts
      (component, status, table_counts_json, source_version, built_at) VALUES (?, ?, ?, ?, ?)`)
      .run("fake_component", opts.receiptStatus || "ok",
        JSON.stringify(opts.receiptCounts || { incidents: total }),
        opts.sourceVersion || "2026-05", opts.builtAt || new Date().toISOString());
  }
  // Deliberately NOT closed. See openHandles: closing the last connection checkpoints the WAL away.
  openHandles.push(db);
  return { file, expectedRows: checkpointed + walResident, db };
}

function fakeRegistryEntry(overrides) {
  return Object.assign({
    id: "fake",
    env: "FAKE_DB_PATH",
    authoritative_remote: "/opt/nibrs/shared/fake.db",
    forbidden_remote: [],
    required_tables: ["incidents", "agencies"],
    row_floors: { incidents: 5 },
    receipts: null,
    bootstrap_pending: false,
    expected_schema_fingerprint: null,
  }, overrides);
}

/** A registry entry whose expectation is the fingerprint of THIS file -- legitimate for a fake. */
function entryForFile(file, overrides) {
  const { fingerprint } = snapshot.schemaFingerprint(file);
  return fakeRegistryEntry(Object.assign({ expected_schema_fingerprint: fingerprint }, overrides));
}

function countRows(file, table) {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// WAL: the invariant this correction exists for
// ---------------------------------------------------------------------------------------------------

const tests = [];

tests.push(["WAL-1  committed WAL content appears in the snapshot", async (dir) => {
  const live = path.join(dir, "live.db");
  const fake = makeFakeCorpus(live, { checkpointed: 10, walResident: 990 });
  assert.ok(fs.statSync(live + "-wal").size > 0, "the fixture did not leave rows in the WAL");

  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"));
  assert.equal(countRows(artifact.artifact_path, "incidents"), fake.expectedRows,
    "the snapshot is missing committed rows that were resident in the WAL");
  assert.equal(snapshot.inspectArtifact(artifact.artifact_path, []).integrity, "ok");
}]);

tests.push(["WAL-2  a matching main-file hash is NOT accepted as equivalence", async (dir) => {
  // The false-confidence case. Same main file, different WAL: hashing the live main file says
  // "identical", the artifact hash says "different". Only the second is the truth.
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { checkpointed: 10, walResident: 0 });

  const mainHashBefore = snapshot.sha256File(live);
  const first = await snapshot.createSnapshotArtifact(live, path.join(dir, "a1.db"));

  // Write through the STILL-OPEN fixture connection, so the commits stay in the WAL.
  const db = openHandles[openHandles.length - 1];
  db.transaction(() => {
    const ins = db.prepare("INSERT INTO incidents (year, note) VALUES (?, ?)");
    for (let i = 0; i < 500; i++) ins.run(2022, `added later ${i}`);
  })();

  const mainHashAfter = snapshot.sha256File(live);
  assert.equal(mainHashBefore, mainHashAfter,
    "the fixture checkpointed; this test needs the main file to stay byte-identical");

  const second = await snapshot.createSnapshotArtifact(live, path.join(dir, "a2.db"));
  assert.notEqual(second.sha256, first.sha256,
    "two snapshots taken across a 500-row commit hashed the same, so the artifact hash cannot " +
    "detect change and the whole protocol is unsound");

  // And revalidation reports it as changed rather than equal.
  const verdict = await snapshot.revalidate(live, first.sha256, dir);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, snapshot.REASON.CHANGED_SINCE_SNAPSHOT);
}]);

tests.push(["WAL-3  the backup does not modify the live database", async (dir) => {
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { checkpointed: 10, walResident: 200 });
  const before = snapshot.liveSourceState(live);
  const mainHash = snapshot.sha256File(live);

  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"));

  assert.equal(artifact.live_source_unmodified, true, "createSnapshotArtifact reported a mutation");
  assert.deepEqual(snapshot.liveSourceState(live), before, "live db/wal size or mtime changed");
  assert.equal(snapshot.sha256File(live), mainHash, "the live main file's bytes changed");
}]);

/**
 * Overwrite bytes in place and put the size and mtime back exactly as they were.
 *
 * This is the adversary the guard has to survive: a same-length in-place write with a restored
 * timestamp is invisible to both size and mtime, so only a content hash can see it.
 */
function overwriteInPlacePreservingStat(file, offset, replacement) {
  const stat = fs.statSync(file);
  const handle = fs.openSync(file, "r+");
  try {
    fs.writeSync(handle, replacement, 0, replacement.length, offset);
  } finally {
    fs.closeSync(handle);
  }
  // Restore mtime AND atime, and confirm size never moved.
  //
  // `fs.utimesSync` restores only to millisecond precision, so the sub-millisecond fraction of the
  // original mtime is lost -- 1787451197391.0269 comes back as 1787451197391. An adversary restoring a
  // timestamp faces the same limitation, but it is platform-dependent and must never be relied on: on a
  // filesystem with coarser timestamps there would be no residue at all. So the tests below ALSO force
  // mtime to match exactly, to prove the hash is what refuses the change rather than the leftover
  // fraction.
  fs.utimesSync(file, stat.atime, stat.mtime);
  const after = fs.statSync(file);
  assert.equal(after.size, stat.size, "the mutation changed the file size; it must not");
  // No assertion on how exactly mtime came back. Observed: restoration lands within about a
  // millisecond, sometimes rounding up rather than truncating. That imprecision is the whole reason the
  // tests do not depend on it -- each one forces mtime to match synthetically before making its
  // decisive assertion, so the hash is provably what refuses the change.
  assert.ok(Math.abs(after.mtimeMs - stat.mtimeMs) <= 2,
    `mtime moved by ${after.mtimeMs - stat.mtimeMs}ms, far more than restoration imprecision`);
  return stat;
}

/** Force one file's recorded mtime to match another state's, isolating content as the only difference. */
function withMatchedMtime(after, before, key) {
  const copy = JSON.parse(JSON.stringify(after));
  copy[key].mtimeMs = before[key].mtimeMs;
  return copy;
}

tests.push(["GUARD-1 main-file CONTENT change with size and mtime restored is REFUSED", async (dir) => {
  // The blocker this correction closes. Size identical, mtime identical, content different.
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { checkpointed: 60, walResident: 0 });

  const before = snapshot.liveSourceState(live);
  assert.ok(before.db.sha256, "liveSourceState must record a hash for the main database");

  // Rewrite a page deep in the file, then restore size and mtime.
  overwriteInPlacePreservingStat(live, 4096, Buffer.alloc(512, 0x7e));
  const after = snapshot.liveSourceState(live);

  assert.equal(after.db.bytes, before.db.bytes, "size must be unchanged for this test to mean anything");
  assert.notEqual(after.db.sha256, before.db.sha256, "the hash must be the thing that differs");

  // Refused as observed from the filesystem.
  assert.equal(snapshot.compareLiveState(before, after).unmodified, false);

  // DECISIVE: mtime forced to match exactly, so size and mtime are both identical and only the content
  // differs. This is the case the previous size+mtime implementation would have certified.
  const isolated = withMatchedMtime(after, before, "db");
  assert.equal(isolated.db.bytes, before.db.bytes);
  assert.equal(isolated.db.mtimeMs, before.db.mtimeMs);
  const comparison = snapshot.compareLiveState(before, isolated);
  assert.equal(comparison.unmodified, false,
    "a main-file content change with size AND mtime identical was accepted as unchanged");
  assert.deepEqual(comparison.problems.filter((p) => /size changed|mtime changed/.test(p)), [],
    "the refusal must come from the hash, not from size or mtime");
  assert.match(comparison.problems.join(" "), /main file CONTENT changed/);
}]);

tests.push(["GUARD-2 WAL CONTENT change at identical size and mtime is REFUSED", async (dir) => {
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { checkpointed: 10, walResident: 400 });
  const walPath = live + "-wal";
  assert.ok(fs.existsSync(walPath) && fs.statSync(walPath).size > 0,
    "this test needs a non-empty WAL");

  const before = snapshot.liveSourceState(live);
  assert.ok(before.wal.sha256, "liveSourceState must record a hash for a non-empty WAL");

  overwriteInPlacePreservingStat(walPath, 4096, Buffer.alloc(256, 0x3c));
  const after = snapshot.liveSourceState(live);

  assert.equal(after.wal.bytes, before.wal.bytes);
  assert.notEqual(after.wal.sha256, before.wal.sha256);

  assert.equal(snapshot.compareLiveState(before, after).unmodified, false);

  // DECISIVE: identical size, identical mtime, different content.
  const isolated = withMatchedMtime(after, before, "wal");
  const comparison = snapshot.compareLiveState(before, isolated);
  assert.equal(comparison.unmodified, false,
    "a WAL content change at identical size and mtime was accepted as unchanged");
  assert.match(comparison.problems.join(" "), /-wal CONTENT changed at the same size/);
  assert.deepEqual(comparison.problems.filter((p) => /main file/.test(p)), [],
    "the refusal must be attributed to the WAL, not to the main file");
}]);

tests.push(["GUARD-3 an empty WAL materialising is still benign, and carries no hash", async (dir) => {
  // The false-refusal side: the correction must not make quiescent databases unsnapshottable.
  const before = { db: { bytes: 100, mtimeMs: 5, sha256: "a" }, wal: null };
  const after = { db: { bytes: 100, mtimeMs: 5, sha256: "a" }, wal: { bytes: 0, mtimeMs: 9 } };
  const comparison = snapshot.compareLiveState(before, after);
  assert.equal(comparison.unmodified, true, comparison.problems.join("; "));
  assert.match(comparison.notes.join(" "), /materialised/);
}]);

tests.push(["GUARD-4 bounded-buffer hashing matches a whole-file hash, across chunk boundaries", async (dir) => {
  // sha256File no longer reads the file into one buffer. A chunking bug would be silent, so the two
  // implementations are compared on a file larger than the 4 MiB chunk.
  const file = path.join(dir, "big.bin");
  const chunk = 4 * 1024 * 1024;
  const bytes = Buffer.alloc(chunk + 12345);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  fs.writeFileSync(file, bytes);

  const streamed = snapshot.sha256File(file);
  const wholeFile = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(streamed, wholeFile, "bounded-buffer hashing disagrees with whole-file hashing");

  // And an empty file, the other boundary.
  const empty = path.join(dir, "empty.bin");
  fs.writeFileSync(empty, "");
  assert.equal(snapshot.sha256File(empty),
    crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"));
}]);

tests.push(["WAL-4  two snapshots of an UNCHANGED database are byte-identical", async (dir) => {
  // This reproducibility is what makes revalidation-by-hash viable. It is asserted, not assumed --
  // and if it ever stops holding, revalidate() fails closed rather than reporting equality.
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { checkpointed: 10, walResident: 300 });
  const a = await snapshot.createSnapshotArtifact(live, path.join(dir, "a.db"));
  const b = await snapshot.createSnapshotArtifact(live, path.join(dir, "b.db"));
  assert.equal(a.sha256, b.sha256);
  const verdict = await snapshot.revalidate(live, a.sha256, dir);
  assert.equal(verdict.ok, true, verdict.detail || "");
}]);

// ---------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------

tests.push(["VER-1  a verified artifact passes every check", async (dir) => {
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { checkpointed: 10, walResident: 100 });
  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"));
  const verdict = snapshot.verifyArtifact(entryForFile(artifact.artifact_path),
    artifact.artifact_path, { remote_snapshot_sha256: artifact.sha256 });
  assert.equal(verdict.ok, true, verdict.detail || "");
}]);

tests.push(["VER-2  a missing artifact is corpus_absent", async (dir) => {
  const verdict = snapshot.verifyArtifact(fakeRegistryEntry(), path.join(dir, "nope.db"), {});
  assert.equal(verdict.reason, snapshot.REASON.ABSENT);
}]);

tests.push(["VER-3  a zero-byte file is corpus_empty, never 'available'", async (dir) => {
  const stub = path.join(dir, "stub.db");
  fs.writeFileSync(stub, "");
  const verdict = snapshot.verifyArtifact(fakeRegistryEntry(), stub, {});
  assert.equal(verdict.reason, snapshot.REASON.EMPTY);
}]);

tests.push(["VER-4  one flipped byte is corpus_hash_mismatch", async (dir) => {
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { walResident: 50 });
  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"));

  const transferred = path.join(dir, "transferred.db");
  const bytes = fs.readFileSync(artifact.artifact_path);
  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;   // corrupt "in transit"
  fs.writeFileSync(transferred, bytes);

  const verdict = snapshot.verifyArtifact(entryForFile(artifact.artifact_path), transferred,
    { remote_snapshot_sha256: artifact.sha256 });
  assert.equal(verdict.reason, snapshot.REASON.HASH_MISMATCH);
}]);

tests.push(["VER-5  a corrupted page is corpus_integrity_failed", async (dir) => {
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { checkpointed: 400, walResident: 0 });
  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"));

  // Overwrite deep inside the file, past the header, to damage a page rather than the format.
  const handle = fs.openSync(artifact.artifact_path, "r+");
  const size = fs.statSync(artifact.artifact_path).size;
  fs.writeSync(handle, Buffer.alloc(2048, 0x5a), 0, 2048, Math.floor(size / 2));
  fs.closeSync(handle);

  const verdict = snapshot.verifyArtifact(
    fakeRegistryEntry({ expected_schema_fingerprint: "sha256:whatever" }),
    artifact.artifact_path, {});
  assert.equal(verdict.reason, snapshot.REASON.INTEGRITY_FAILED,
    `expected integrity failure, got ${verdict.reason}: ${verdict.detail}`);
}]);

tests.push(["VER-6  expected-vs-observed schema mismatch is corpus_unidentified", async (dir) => {
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { walResident: 50 });
  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"));

  const wrong = fakeRegistryEntry({
    expected_schema_fingerprint: "sha256:" + crypto.randomBytes(32).toString("hex"),
  });
  const verdict = snapshot.verifyArtifact(wrong, artifact.artifact_path,
    { remote_snapshot_sha256: artifact.sha256 });
  assert.equal(verdict.reason, snapshot.REASON.UNIDENTIFIED);
  assert.match(verdict.detail, /reviewed expectation/);
}]);

tests.push(["VER-7  a manifest-only fingerprint CANNOT reject a wrong schema", async (dir) => {
  // The circularity, demonstrated rather than argued. Comparing a database to the fingerprint observed
  // during its own acquisition always agrees, whatever the schema is -- so it verifies nothing. The
  // registry expectation catches the same case.
  const a = path.join(dir, "a.db");
  const b = path.join(dir, "b.db");
  makeFakeCorpus(a, { walResident: 10 });
  makeFakeCorpus(b, { walResident: 10, extraTable: "unexpected_extra" });

  const selfA = snapshot.schemaFingerprint(a).fingerprint;
  const selfB = snapshot.schemaFingerprint(b).fingerprint;
  assert.notEqual(selfA, selfB, "the two fake schemas must differ for this test to mean anything");

  // Self-comparison: both "pass", including the wrong-schema one.
  assert.equal(snapshot.schemaFingerprint(b).fingerprint, selfB,
    "self-observation is tautological, which is the point");

  // Registry comparison: the wrong schema is rejected.
  const artifactB = await snapshot.createSnapshotArtifact(b, path.join(dir, "artB.db"));
  const verdict = snapshot.verifyArtifact(fakeRegistryEntry({ expected_schema_fingerprint: selfA }),
    artifactB.artifact_path, { remote_snapshot_sha256: artifactB.sha256 });
  assert.equal(verdict.reason, snapshot.REASON.UNIDENTIFIED);
}]);

tests.push(["VER-8  a missing required table is corpus_unidentified", async (dir) => {
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { walResident: 20 });
  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"));
  const entry = entryForFile(artifact.artifact_path, {
    required_tables: ["incidents", "agencies", "table_that_is_not_there"],
    row_floors: { incidents: 5 },
  });
  const verdict = snapshot.verifyArtifact(entry, artifact.artifact_path,
    { remote_snapshot_sha256: artifact.sha256 });
  assert.equal(verdict.reason, snapshot.REASON.UNIDENTIFIED);
  assert.match(verdict.detail, /table_that_is_not_there/);
}]);

tests.push(["VER-9  a breached row floor is corpus_unidentified", async (dir) => {
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { checkpointed: 3, walResident: 0 });
  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"));
  const entry = entryForFile(artifact.artifact_path, { row_floors: { incidents: 1000 } });
  const verdict = snapshot.verifyArtifact(entry, artifact.artifact_path,
    { remote_snapshot_sha256: artifact.sha256 });
  assert.equal(verdict.reason, snapshot.REASON.UNIDENTIFIED);
  assert.match(verdict.detail, /row floor breached/);
}]);

tests.push(["VER-10 a receipt disagreeing with actual counts is corpus_unidentified", async (dir) => {
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, {
    checkpointed: 10, walResident: 0, receipts: true,
    receiptCounts: { incidents: 999999 },   // the file holds 10
  });
  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"));
  const entry = entryForFile(artifact.artifact_path, {
    row_floors: { incidents: 5 },
    receipts: { table: "source_build_receipts", require_status: "ok",
      counts_column: "table_counts_json", diagnostic_columns: ["source_version", "built_at"] },
  });
  const verdict = snapshot.verifyArtifact(entry, artifact.artifact_path,
    { remote_snapshot_sha256: artifact.sha256 });
  assert.equal(verdict.reason, snapshot.REASON.UNIDENTIFIED);
  assert.match(verdict.detail, /claims incidents=999999, file has 10/);
}]);

tests.push(["VER-11 bootstrap_pending yields corpus_unidentified and REPORTS the fingerprint", async (dir) => {
  // The instruction: do not auto-adopt the first observed fingerprint. It is reported for review.
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, { walResident: 20 });
  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"));
  const entry = fakeRegistryEntry({ bootstrap_pending: true, expected_schema_fingerprint: null });
  const verdict = snapshot.verifyArtifact(entry, artifact.artifact_path,
    { remote_snapshot_sha256: artifact.sha256 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, snapshot.REASON.UNIDENTIFIED);
  assert.match(verdict.detail, /NOT self-adopted/);
  assert.match(verdict.observed.schema_fingerprint, /^sha256:/,
    "the observed fingerprint must still be reported so it can be reviewed");
}]);

// ---------------------------------------------------------------------------------------------------
// Set age
// ---------------------------------------------------------------------------------------------------

function manifestWithTimes(times) {
  const corpora = {};
  Object.entries(times).forEach(([id, t]) => { corpora[id] = { remote_snapshot_created_at: t }; });
  return { corpora };
}

tests.push(["AGE-1  the anchor is the OLDEST member, not the newest", async () => {
  const manifest = manifestWithTimes({
    rtci: "2026-08-22T02:00:00.000Z",
    shr: "2026-08-22T20:00:00.000Z",
  });
  assert.equal(snapshot.setAgeAnchor(manifest), "2026-08-22T02:00:00.000Z");

  // 26h after the oldest, 8h after the newest: stale, because a set is as fresh as its stalest member.
  const verdict = snapshot.checkSetAge(manifest, "2026-08-23T04:00:00.000Z");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, snapshot.REASON.SNAPSHOT_STALE);
}]);

tests.push(["AGE-2  a fresh built_at does NOT rescue a stale acquisition", async (dir) => {
  // The direct regression for my own error. built_at says the build ran moments ago; the acquisition
  // is 30 hours old. Rebuilding stale input today produces exactly this combination.
  const live = path.join(dir, "live.db");
  makeFakeCorpus(live, {
    checkpointed: 10, receipts: true,
    builtAt: "2026-08-23T19:59:00.000Z", sourceVersion: "2026-05",
  });
  const artifact = await snapshot.createSnapshotArtifact(live, path.join(dir, "art.db"),
    { now: "2026-08-22T14:00:00.000Z" });

  const entry = entryForFile(artifact.artifact_path, {
    row_floors: { incidents: 5 },
    receipts: { table: "source_build_receipts", require_status: "ok",
      counts_column: "table_counts_json", diagnostic_columns: ["source_version", "built_at"] },
  });
  const artifactVerdict = snapshot.verifyArtifact(entry, artifact.artifact_path,
    { remote_snapshot_sha256: artifact.sha256 });
  assert.equal(artifactVerdict.ok, true, artifactVerdict.detail || "");
  assert.match(String(artifactVerdict.observed.receipt_diagnostics["fake_component.built_at"]),
    /2026-08-23/, "built_at should be recorded as a diagnostic");

  const manifest = manifestWithTimes({ fake: artifact.created_at_utc });
  const age = snapshot.checkSetAge(manifest, "2026-08-23T20:00:00.000Z");
  assert.equal(age.ok, false, "a 30-hour-old acquisition must be stale");
  assert.equal(age.reason, snapshot.REASON.SNAPSHOT_STALE);
}]);

tests.push(["AGE-3  a snapshot inside the window is fresh", async () => {
  const manifest = manifestWithTimes({ rtci: "2026-08-22T10:00:00.000Z" });
  assert.equal(snapshot.checkSetAge(manifest, "2026-08-22T22:00:00.000Z").ok, true);
}]);

// ---------------------------------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------------------------------

function stageSet(root, setId, files) {
  const staging = path.join(root, "sets", `${setId}.staging`);
  fs.mkdirSync(staging, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(staging, name), content);
  }
  return staging;
}

tests.push(["PUB-1  publication is atomic and the pointer is never absent", async (dir) => {
  stageSet(dir, "set-a", { "rtci.db": "a" });
  snapshot.publishSet(dir, "set-a", { snapshot_set_id: "set-a", corpora: {} });
  assert.ok(fs.existsSync(path.join(dir, "active.json")));
  assert.ok(fs.existsSync(path.join(dir, "sets", "set-a", "manifest.json")));
  assert.equal(snapshot.loadActiveSet(dir).snapshot_set_id, "set-a");

  // Replacing the pointer must succeed while it exists -- a delete-then-write would leave a window
  // with no pointer at all. Node's rename uses MoveFileEx replace semantics on Windows; asserted,
  // not assumed.
  stageSet(dir, "set-b", { "rtci.db": "b" });
  snapshot.publishSet(dir, "set-b", { snapshot_set_id: "set-b", corpora: {} });
  assert.equal(snapshot.loadActiveSet(dir).snapshot_set_id, "set-b");
  assert.ok(fs.existsSync(path.join(dir, "sets", "set-a")), "the previous set is retained");
}]);

tests.push(["PUB-2  the manifest is never visible beside a partial set", async (dir) => {
  const staging = stageSet(dir, "set-c", { "rtci.db": "c" });
  // Before publication there is no set directory and no pointer at all.
  assert.ok(!fs.existsSync(path.join(dir, "sets", "set-c")));
  assert.ok(!fs.existsSync(path.join(dir, "active.json")));
  assert.ok(fs.existsSync(staging));
  snapshot.publishSet(dir, "set-c", { snapshot_set_id: "set-c", corpora: {} });
  // After publication the manifest exists only inside the finished set.
  assert.ok(fs.existsSync(path.join(dir, "sets", "set-c", "manifest.json")));
  assert.ok(!fs.existsSync(staging), "staging should have been renamed away, not copied");
}]);

tests.push(["PUB-3  republishing an existing set id is refused", async (dir) => {
  stageSet(dir, "set-d", { "rtci.db": "d" });
  snapshot.publishSet(dir, "set-d", { snapshot_set_id: "set-d", corpora: {} });
  stageSet(dir, "set-d", { "rtci.db": "d2" });
  assert.throws(() => snapshot.publishSet(dir, "set-d", { snapshot_set_id: "set-d", corpora: {} }),
    /already published/);
}]);

// ---------------------------------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------------------------------

tests.push(["CLEAN-1 cleanup removes only the recorded run-owned paths", async (dir) => {
  const mine = path.join(dir, "run-owned.db");
  const sibling = path.join(dir, "someone-elses.db");
  fs.writeFileSync(mine, "mine");
  fs.writeFileSync(mine + "-wal", "mine-wal");
  fs.writeFileSync(sibling, "not mine");

  const removed = snapshot.cleanupTempPaths([mine]);
  assert.ok(!fs.existsSync(mine));
  assert.ok(!fs.existsSync(mine + "-wal"), "sidecars of a run-owned path are removed");
  assert.ok(fs.existsSync(sibling), "a sibling file in the same directory must survive");
  assert.equal(removed.length, 2);
}]);

tests.push(["CLEAN-2 cleanup never removes a directory", async (dir) => {
  const nested = path.join(dir, "a-directory");
  fs.mkdirSync(nested);
  snapshot.cleanupTempPaths([nested]);
  assert.ok(fs.existsSync(nested), "cleanup must not delete directories");
}]);

// ---------------------------------------------------------------------------------------------------
// The registry, and the stale-path regression
// ---------------------------------------------------------------------------------------------------

tests.push(["REG-1  the committed registry is valid and both corpora are bootstrap_pending", async () => {
  const registry = loadRegistry();
  assert.deepEqual(validateRegistry(registry), []);
  assert.deepEqual(registry.corpora.map((c) => c.id), ["rtci", "shr"]);
  for (const corpus of registry.corpora) {
    assert.equal(corpus.bootstrap_pending, true,
      `${corpus.id}: fingerprints must not be adopted before review`);
    assert.equal(corpus.expected_schema_fingerprint, null);
  }
}]);

tests.push(["REG-2  no NIBRS corpus is declared", async () => {
  const registry = loadRegistry();
  const ids = registry.corpora.map((c) => c.id);
  assert.ok(!ids.includes("nibrs"), "no measured Tier C command requires NIBRS (decision 5.5)");
}]);

tests.push(["REG-3  REGRESSION: the stale RTCI path can never be authoritative", async () => {
  const registry = loadRegistry();
  const rtci = registry.corpora.find((c) => c.id === "rtci");
  assert.equal(rtci.authoritative_remote, "/opt/nibrs/shared/crime_data.db");
  for (const stale of ["/opt/nibrs/app/crime_data.db", "/opt/nibrs/crime_data.db",
    "/opt/nibrs/current/crime_data.db"]) {
    assert.ok(rtci.forbidden_remote.includes(stale), `${stale} must be declared forbidden`);
    assert.notEqual(rtci.authoritative_remote, stale);
  }
  // And the validator rejects the contradiction outright.
  const contradiction = [fakeRegistryEntry({
    authoritative_remote: "/opt/nibrs/app/crime_data.db",
    forbidden_remote: ["/opt/nibrs/app/crime_data.db"],
  })];
  const problems = validateRegistry({ corpora: contradiction });
  assert.ok(problems.some((p) => /also listed as forbidden/.test(p)), JSON.stringify(problems));
  assert.ok(forbiddenPaths(registry).has("/opt/nibrs/app/crime_data.db"));
}]);

tests.push(["REG-4  a silent null fingerprint without bootstrap_pending is rejected", async () => {
  const problems = validateRegistry({
    corpora: [fakeRegistryEntry({ bootstrap_pending: false, expected_schema_fingerprint: null })],
  });
  assert.ok(problems.some((p) => /must either carry a reviewed expectation or admit it has none/.test(p)),
    JSON.stringify(problems));
}]);

// ---------------------------------------------------------------------------------------------------
// End to end, through the orchestrator: all-or-nothing publication
// ---------------------------------------------------------------------------------------------------

const { acquire } = require("./acquire-corpus-snapshots.js");

/** Two fake corpora named as the registry expects, in a fake "production" directory. */
function makeFakeProduction(dir, options) {
  const opts = options || {};
  const fakeDir = path.join(dir, "fake-production");
  fs.mkdirSync(fakeDir, { recursive: true });
  const made = {};
  made.rtci = makeFakeCorpus(path.join(fakeDir, "crime_data.db"), { checkpointed: 20, walResident: 80 });
  if (!opts.omitShr) {
    made.shr = makeFakeCorpus(path.join(fakeDir, "shr.db"), { checkpointed: 15, walResident: 60 });
  }
  return { fakeDir, made };
}

/** A registry whose expectations are the fingerprints of the fake sources' snapshots. */
async function registryForFakes(dir, fakeDir, present) {
  const corpora = [];
  for (const [id, filename] of [["rtci", "crime_data.db"], ["shr", "shr.db"]]) {
    if (!present.includes(id)) continue;
    const live = path.join(fakeDir, filename);
    const probe = await snapshot.createSnapshotArtifact(live, path.join(dir, `probe-${id}.db`));
    corpora.push(fakeRegistryEntry({
      id,
      env: id === "rtci" ? "RTCI_DB_PATH" : "SHR_DB_PATH",
      authoritative_remote: `/opt/nibrs/${id === "rtci" ? "shared/crime_data.db" : "shr.db"}`,
      forbidden_remote: id === "rtci" ? ["/opt/nibrs/app/crime_data.db"] : [],
      required_tables: ["incidents", "agencies"],
      row_floors: { incidents: 5 },
      expected_schema_fingerprint: snapshot.schemaFingerprint(probe.artifact_path).fingerprint,
    }));
    fs.rmSync(probe.artifact_path, { force: true });
  }
  return { corpora };
}

/**
 * REG-5: the committed registry's receipt expectation must be a value the REAL builder produces.
 *
 * WHAT WENT WRONG WITHOUT IT. The registry declared `require_status: "ok"` while
 * scripts/current_trends_build_receipt.py declares the column as
 * `status TEXT NOT NULL CHECK(status = 'complete')` -- so `"ok"` is not a value that column can ever
 * hold, and crossCheckReceipts() would report one problem per receipt, rejecting every receipt this
 * repository's builder can produce.
 *
 * WHEN IT WOULD HAVE BITTEN, precisely. Not on the first acquisition. verifyArtifact() gates in order
 * -- exists, bytes, artifact hash, integrity, SCHEMA FINGERPRINT, required tables, row floors, receipts
 * -- and while a corpus is `bootstrap_pending` it returns at the fingerprint gate, which is UPSTREAM of
 * the receipt check. So the mismatch is unreachable until a fingerprint has been reviewed and
 * committed, and would then reject every builder-produced receipt on the acquisition after that -- with
 * a full snapshot and transfer already paid for.
 *
 * This test reaches the receipt check directly, by calling crossCheckReceipts() against a
 * builder-written database. A --local-fake rehearsal does NOT exercise it: that run stops at the
 * bootstrap fingerprint gate and reports `receipt_diagnostics: null`.
 *
 * Nothing caught it because the tests above build their own receipt tables and assert against their own
 * `"ok"`: the test and the registry agreed with each other, and both disagreed with the builder.
 *
 * WHY THIS TEST SPAWNS PYTHON RATHER THAN RESTATING THE DDL. A JS copy of the CREATE TABLE, or a regex
 * over the builder's source for its CHECK clause, would be a SECOND COPY OF THE CONSTRAINT -- free to
 * drift with the thing it is supposed to pin, which is the defect being fixed, one level up. So the
 * receipt table is created and populated BY the builder, through its own `ensure_receipt_table()` and
 * its own INSERT, and the committed registry's own receipts block is then run against the result.
 */
tests.push(["REG-5  the committed registry accepts a receipt written by the REAL builder", async (dir) => {
  const built = path.join(dir, "built-by-builder.db");
  const scriptsDir = path.join(__dirname);
  // `current_trends_crosswalk` is the cheapest component: one required table, one row.
  const program = [
    "import sqlite3, sys",
    `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
    "from current_trends_build_receipt import write_complete_receipt",
    `conn = sqlite3.connect(${JSON.stringify(built)})`,
    "conn.execute('CREATE TABLE agency_county_crosswalk (ori TEXT NOT NULL)')",
    "conn.execute(\"INSERT INTO agency_county_crosswalk VALUES ('AL0010200')\")",
    "write_complete_receipt(conn, component='current_trends_crosswalk',",
    "                       source_version='drift-control', source_sha256='0' * 64,",
    "                       source_rows=1, expected_rows=1, actual_rows=1)",
    "conn.commit()",
    "conn.close()",
  ].join("\n");
  const python = process.env.PYTHON || "python";
  const run = spawnSync(python, ["-c", program], { encoding: "utf8" });
  assert.equal(run.status, 0,
    `the real builder could not write a receipt: ${(run.stderr || run.stdout || "").trim()}`);

  const rtci = loadRegistry().corpora.find((corpus) => corpus.id === "rtci");
  assert.ok(rtci && rtci.receipts, "the committed registry must declare RTCI receipt rules");

  // The positive direction: what the builder wrote satisfies what the registry demands.
  const accepted = snapshot.crossCheckReceipts(built, rtci.receipts);
  assert.equal(accepted.checked, true, "the receipts table must be readable");
  assert.deepEqual(accepted.problems, [],
    `the committed require_status ${JSON.stringify(rtci.receipts.require_status)} does not match what ` +
    `the builder writes: ${accepted.problems.join("; ")}`);

  // The teeth. Without this, the assertion above would also pass for a check that never compares
  // anything -- and a status rule that accepts every value is the same as no rule.
  const rejected = snapshot.crossCheckReceipts(built, { ...rtci.receipts, require_status: "ok" });
  assert.ok(rejected.problems.some((problem) => /status/.test(problem)),
    `a wrong require_status must be rejected, got: ${JSON.stringify(rejected.problems)}`);
}]);

tests.push(["E2E-1  a complete verified set publishes and becomes active", async (dir) => {
  const { fakeDir } = makeFakeProduction(dir);
  const registry = await registryForFakes(dir, fakeDir, ["rtci", "shr"]);
  const root = path.join(dir, "store");

  const result = await acquire({ localFake: fakeDir, root, setId: "set-1", registry,
    now: "2026-08-22T12:00:00.000Z" });

  assert.equal(result.published, true, JSON.stringify(result.problems));
  assert.equal(snapshot.loadActiveSet(root).snapshot_set_id, "set-1");
  for (const id of ["rtci", "shr"]) {
    assert.ok(fs.existsSync(path.join(root, "sets", "set-1", `${id}.db`)), `${id}.db missing`);
    assert.ok(!fs.existsSync(path.join(root, "sets", "set-1", `${id}.db.partial`)),
      `${id}.db.partial should have been promoted`);
  }
  const manifest = snapshot.loadActiveSet(root).manifest;
  assert.equal(manifest.set_age_anchor, "2026-08-22T12:00:00.000Z");
  assert.ok(manifest.corpora.rtci.resolved_source_path, "the resolved source path must be recorded");
  assert.ok(manifest.corpora.rtci.literal_source_path, "the literal source path must be recorded");
  assert.equal(manifest.corpora.rtci.live_source_unmodified, true);
}]);

tests.push(["E2E-2  CRITERION 15: a partial acquisition preserves the prior verified set", async (dir) => {
  // Publish a good set, then attempt one where the second database is missing. The previous set must
  // remain published, verifiable and active -- a broken acquisition degrades to "stale but verified",
  // never to "unverified".
  const { fakeDir } = makeFakeProduction(dir);
  const registry = await registryForFakes(dir, fakeDir, ["rtci", "shr"]);
  const root = path.join(dir, "store");

  const first = await acquire({ localFake: fakeDir, root, setId: "good", registry,
    now: "2026-08-22T12:00:00.000Z" });
  assert.equal(first.published, true, JSON.stringify(first.problems));
  const goodRtciHash = snapshot.sha256File(path.join(root, "sets", "good", "rtci.db"));

  // Remove the second source, so corpus 2 fails while corpus 1 succeeds.
  while (openHandles.length) { try { openHandles.pop().close(); } catch { /* ignore */ } }
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(path.join(fakeDir, "shr.db" + suffix), { force: true });
  }

  const second = await acquire({ localFake: fakeDir, root, setId: "partial", registry,
    now: "2026-08-22T13:00:00.000Z" });

  assert.equal(second.published, false, "a partial acquisition must not publish");
  assert.ok(second.problems.some((p) => /shr/.test(p)), JSON.stringify(second.problems));
  assert.equal(second.previousStillActive, "good");
  assert.equal(snapshot.loadActiveSet(root).snapshot_set_id, "good",
    "the active pointer must still name the last verified set");
  assert.equal(snapshot.sha256File(path.join(root, "sets", "good", "rtci.db")), goodRtciHash,
    "the previous set's files must be untouched");
  assert.ok(!fs.existsSync(path.join(root, "sets", "partial")),
    "the failed set must not be published");
  assert.ok(!fs.existsSync(path.join(root, "sets", "partial.staging")),
    "the failed staging directory must be cleaned up");
}]);

tests.push(["E2E-3  CRITERION 14: files from two acquisitions are never mixed", async (dir) => {
  // Publication is per set. Even though the failed run produced a perfectly good rtci snapshot, it is
  // discarded rather than merged into the active set.
  const { fakeDir } = makeFakeProduction(dir);
  const registry = await registryForFakes(dir, fakeDir, ["rtci", "shr"]);
  const root = path.join(dir, "store");

  await acquire({ localFake: fakeDir, root, setId: "s1", registry, now: "2026-08-22T12:00:00.000Z" });
  const s1Manifest = JSON.parse(
    fs.readFileSync(path.join(root, "sets", "s1", "manifest.json"), "utf8"));

  while (openHandles.length) { try { openHandles.pop().close(); } catch { /* ignore */ } }
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(path.join(fakeDir, "shr.db" + suffix), { force: true });
  }
  await acquire({ localFake: fakeDir, root, setId: "s2", registry, now: "2026-08-22T13:00:00.000Z" });

  // Every file in the active set carries the same snapshot_set_id, and it is s1's.
  const active = snapshot.loadActiveSet(root);
  assert.equal(active.snapshot_set_id, "s1");
  assert.equal(active.manifest.snapshot_set_id, "s1");
  for (const id of Object.keys(active.manifest.corpora)) {
    assert.equal(active.manifest.corpora[id].remote_snapshot_created_at,
      s1Manifest.corpora[id].remote_snapshot_created_at,
      `${id}'s recorded snapshot time changed, so files from two runs were mixed`);
  }
  // A published set's contents are EXACTLY the two databases and the manifest. No `.partial`, and no
  // orphaned `-wal`/`-shm` sidecars from verification -- an earlier version published those, which made
  // set contents non-deterministic and left a stale WAL beside a database.
  const files = fs.readdirSync(path.join(root, "sets", "s1")).sort();
  assert.deepEqual(files, ["manifest.json", "rtci.db", "shr.db"]);
}]);

tests.push(["E2E-4  CRITERION 18: remote temp artifacts are cleaned up, recorded first", async (dir) => {
  const { fakeDir } = makeFakeProduction(dir);
  const registry = await registryForFakes(dir, fakeDir, ["rtci", "shr"]);
  const root = path.join(dir, "store");
  const result = await acquire({ localFake: fakeDir, root, setId: "set-x", registry,
    now: "2026-08-22T12:00:00.000Z" });

  for (const [id, record] of Object.entries(result.manifest.corpora)) {
    assert.ok(Array.isArray(record.remote_temp_paths) && record.remote_temp_paths.length,
      `${id}: remote_temp_paths must be recorded so cleanup can be precise`);
    for (const temp of record.remote_temp_paths) {
      assert.ok(!fs.existsSync(temp), `${id}: temp artifact ${temp} was not cleaned up`);
    }
  }
  // The fake production sources are untouched by acquisition.
  assert.ok(fs.existsSync(path.join(fakeDir, "crime_data.db")));
  assert.ok(fs.existsSync(path.join(fakeDir, "shr.db")));
}]);

tests.push(["E2E-5  the committed registry cannot publish, because both corpora await review", async (dir) => {
  // The bootstrap state end to end: with the real registry nothing publishes, and the reason names the
  // missing reviewed expectation rather than pretending the corpus is unavailable.
  const { fakeDir } = makeFakeProduction(dir);
  const root = path.join(dir, "store");
  const result = await acquire({ localFake: fakeDir, root, setId: "set-boot",
    now: "2026-08-22T12:00:00.000Z" });

  assert.equal(result.published, false);
  assert.ok(result.problems.some((p) => /corpus_unidentified/.test(p)), JSON.stringify(result.problems));
  for (const record of Object.values(result.manifest.corpora)) {
    assert.equal(record.state, snapshot.REASON.UNIDENTIFIED);
    assert.match(record.observed_schema_fingerprint || "", /^sha256:/,
      "the observed fingerprint must be reported for review");
  }
}]);

tests.push(["E2E-6  production mode is refused, not silently available", async () => {
  const { parseArgs } = require("./acquire-corpus-snapshots.js");
  assert.throws(() => parseArgs(["--production"]), /separately authorized/);
  assert.throws(() => parseArgs([]), /--local-fake/);
}]);

// ---------------------------------------------------------------------------------------------------

(async () => {
  console.log("corpus acquisition tests (local fake sources only, no production contact)");
  for (const [name, body] of tests) await check(name, body);
  console.log(`\ncorpus acquisition: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.log("  " + failure);
    process.exitCode = 1;
  }
})();
