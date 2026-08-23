/**
 * Does the proof system actually GOVERN the commands it was built to certify?
 *
 * `test-corpus-acquisition.js` proves a set can be acquired, verified and published. That is a
 * different claim from the one this file makes. Codex's finding was precisely that gap: the acquisition
 * layer was accepted, and the runner still gated Tier C on P1.1's permissive path search, so the proof
 * system existed beside the commands rather than in front of them.
 *
 * SO THE CLAIM HERE IS REACHABILITY, STATED NEGATIVELY. There must exist no route by which a Tier C
 * command obtains a database path without a passed verification against reviewed registry expectation.
 * Every test below is an attempt to find such a route -- bootstrap-pending, stale, hash-mismatched,
 * absent from the set, escaping the set directory, mixed between two sets -- and the assertion is that
 * each attempt yields NO environment, not a degraded one.
 *
 * WHY "NO ENVIRONMENT" IS THE ASSERTION AND NOT "A SKIP". A skip is a reporting outcome; an empty
 * environment is a structural one. If `verifyCorpusSet` returned the half of a set that verified, a
 * command declaring RTCI and SHR would run with one real database and one empty fixture, pass or fail
 * for reasons no one could attribute, and the run would still print a corpus verdict. So the test is
 * that `env` is empty whenever `ok` is false -- checked on every failure mode rather than once.
 *
 * AND ONE POSITIVE CONTROL, WHICH THE NEGATIVES DEPEND ON. A suite of "it refuses" tests passes
 * trivially if the code refuses everything. `EXEC-1` therefore builds a genuinely verifiable published
 * set -- a real registry with a reviewed fingerprint computed from a real database -- and proves a
 * child process reaches that exact file. Without it, every refusal below is unfalsifiable.
 *
 * FIXTURES ARE REAL SQLITE FILES, not stubs, because the thing under test is `verifyArtifact`, which
 * runs `PRAGMA integrity_check` and reads row counts. A stub would be rejected for being a stub and
 * would prove nothing about the check that matters.
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const Database = require("better-sqlite3");
const snapshot = require("./lib/corpus-snapshot.js");
const verification = require("./lib/corpus-verification.js");
const runner = require("./run-harness.js");

const REASON = snapshot.REASON;

const failures = [];
let passed = 0;

function check(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-"));
  try {
    body(dir);
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error && error.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ fixture builders

/**
 * A database that can satisfy a registry declaration: the named tables, enough rows to clear a floor,
 * and an application index so the fingerprint has index structure to lose.
 */
function buildCorpusDb(file, rows) {
  const db = new Database(file);
  db.exec("CREATE TABLE agencies (ori TEXT NOT NULL PRIMARY KEY, name TEXT, state TEXT DEFAULT 'LA')");
  db.exec("CREATE INDEX idx_agencies_state ON agencies (state)");
  const insert = db.prepare("INSERT INTO agencies (ori, name, state) VALUES (?, ?, ?)");
  const many = db.transaction((n) => {
    for (let i = 0; i < n; i++) insert.run(`ORI${i}`, `Agency ${i}`, "LA");
  });
  many(rows === undefined ? 12 : rows);
  db.close();
}

/** A second, structurally different corpus, so a mixed set has two distinguishable members. */
function buildSecondDb(file, rows) {
  const db = new Database(file);
  db.exec("CREATE TABLE incidents (id INTEGER PRIMARY KEY, year INTEGER NOT NULL)");
  const insert = db.prepare("INSERT INTO incidents (id, year) VALUES (?, ?)");
  const many = db.transaction((n) => {
    for (let i = 0; i < n; i++) insert.run(i + 1, 2020);
  });
  many(rows === undefined ? 8 : rows);
  db.close();
}

/**
 * A registry whose expectation is REVIEWED-BY-CONSTRUCTION for this test: the fingerprint is read from
 * a database built above and then written into the registry as declared expectation.
 *
 * THIS IS THE ONE PLACE THAT SHORTCUT IS LEGITIMATE, and it is worth being explicit about why, because
 * the production rule is the opposite. `corpus-registry.json` must never be filled in from an observed
 * database -- that manufactures expectation out of the thing being checked. Here the database is a
 * local fake built by this file three lines earlier, so "reviewed" is honest: the test author chose the
 * schema. Nothing here touches production or the committed registry.
 */
function reviewedRegistry(dir, corpora) {
  const registry = { corpora: corpora.map((c) => ({
    id: c.id,
    env: c.env,
    authoritative_remote: `/fake/${c.id}.db`,
    forbidden_remote: [],
    bootstrap_pending: c.bootstrapPending === true,
    expected_schema_fingerprint: c.bootstrapPending === true
      ? null
      : snapshot.schemaFingerprint(c.source).fingerprint,
    required_tables: c.tables,
    row_floors: c.floors,
    receipts: null,
  })) };
  const file = path.join(dir, "registry.json");
  fs.writeFileSync(file, JSON.stringify(registry, null, 2));
  return registry;
}

/**
 * Publish a set by the real mechanism, so the layout under test is the layout production would have.
 *
 * `overrides` mutate the manifest AFTER acquisition-shaped records are built -- that is how a stale
 * timestamp, a wrong hash or an escaping path get introduced without hand-writing a whole manifest and
 * accidentally testing a shape the publisher would never produce.
 */
function publishFakeSet(root, setId, members, overrides) {
  const staging = path.join(root, "sets", `${setId}.staging`);
  fs.mkdirSync(staging, { recursive: true });
  const manifest = { snapshot_set_id: setId, tool_commit: "test", app_commit: "test", corpora: {} };
  for (const member of members) {
    const published = path.join(staging, `${member.id}.db`);
    fs.copyFileSync(member.source, published);
    manifest.corpora[member.id] = {
      literal_source_path: member.source,
      resolved_source_path: member.source,
      authoritative_remote: `/fake/${member.id}.db`,
      remote_snapshot_created_at: member.createdAt || new Date().toISOString(),
      remote_snapshot_sha256: snapshot.sha256File(published),
      remote_snapshot_bytes: fs.statSync(published).size,
      local_sha256: snapshot.sha256File(published),
      state: member.state || "verified",
    };
  }
  manifest.set_age_anchor = snapshot.setAgeAnchor(manifest);
  if (overrides) overrides(manifest, staging);
  return snapshot.publishSet(root, setId, manifest);
}

/** The standard single-corpus arrangement most tests start from. */
function standardSet(dir, options) {
  const opts = options || {};
  const source = path.join(dir, "source-rtci.db");
  buildCorpusDb(source);
  const registry = reviewedRegistry(dir, [{
    id: "rtci", env: "RTCI_DB_PATH", source, tables: ["agencies"], floors: { agencies: 5 },
    bootstrapPending: opts.bootstrapPending,
  }]);
  const root = path.join(dir, "corpora");
  publishFakeSet(root, opts.setId || "set-a", [{
    id: "rtci", source, createdAt: opts.createdAt, state: opts.state,
  }], opts.overrides);
  return { root, registry, source };
}

/** Every failure must yield NO environment. Asserted here so no test can forget it. */
function assertRefused(result, expectedReason) {
  assert.equal(result.ok, false, `expected refusal, got ok=true (${result.summary})`);
  assert.equal(result.reason, expectedReason,
    `expected reason ${expectedReason}, got ${result.reason} -- ${result.detail}`);
  assert.deepEqual(result.env, {},
    "a refused verification must return NO environment; returning the part that verified is how a " +
    "command ends up half-real");
}

// ================================================================== positive control

check("EXEC-1  a Tier C command reaches the verified published file, and only that file", (dir) => {
  const { root, registry } = standardSet(dir);
  const result = verification.verifyCorpusSet(["rtci"], { root, registry });

  assert.equal(result.ok, true, `expected verification to pass, got ${result.summary} ${result.detail}`);
  assert.equal(result.summary, "rtci=verified");
  const resolved = result.env.RTCI_DB_PATH;
  assert.ok(resolved, "a verified corpus must yield its env var");

  // Item 9, case 5: the path is inside the ACTIVE set, not merely somewhere plausible.
  assert.equal(path.resolve(resolved), path.resolve(root, "sets", "set-a", "rtci.db"));
  assert.ok(verification.isInside(result.set.dir, resolved));

  // A CHILD PROCESS actually opens it. Static path equality would not prove the command can execute
  // against the corpus -- that is the whole claim of item 5, so it is exercised, not asserted.
  const probe = path.join(dir, "probe.js");
  fs.writeFileSync(probe, [
    "const Database = require(" + JSON.stringify(require.resolve("better-sqlite3")) + ");",
    "const file = process.env.RTCI_DB_PATH;",
    "if (!file) { console.error('no RTCI_DB_PATH'); process.exit(3); }",
    "const db = new Database(file, { readonly: true });",
    "const n = db.prepare('SELECT COUNT(*) AS n FROM agencies').get().n;",
    "db.close();",
    "console.log('rows=' + n);",
    "console.log('file=' + file);",
    "process.exit(n === 12 ? 0 : 4);",
  ].join("\n"));

  const run = spawnSync(process.execPath, [probe], {
    encoding: "utf8",
    env: { ...process.env, ...result.env },
  });
  assert.equal(run.status, 0,
    `the child could not read the verified corpus: ${run.stdout} ${run.stderr}`);
  assert.match(run.stdout, /rows=12/);
  assert.ok(run.stdout.includes(path.resolve(resolved)) || run.stdout.includes(resolved),
    `the child read a different file: ${run.stdout}`);
});

check("EXEC-2  childEnv applies the verified corpus AFTER fixtures, so it is not overwritten", (dir) => {
  // The ordering inside `childEnv` is a safety property: if `fixtureEnv` came last, a Tier C command
  // would silently run against an empty fixture while the run reported the corpus verified.
  const fixtureDir = path.join(dir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const corpusPath = path.join(dir, "verified-rtci.db");
  fs.writeFileSync(corpusPath, "x");

  const env = runner.childEnv(fixtureDir, { RTCI_DB_PATH: corpusPath });
  assert.equal(env.RTCI_DB_PATH, corpusPath, "the verified corpus path must win over the fixture");
  // Everything NOT declared still points at this command's fixture.
  assert.ok(env.SHR_DB_PATH.startsWith(fixtureDir),
    `undeclared databases must stay on fixtures, got ${env.SHR_DB_PATH}`);
  assert.equal(env.CI, "1");

  // And with no corpus at all, nothing escapes to a real path.
  const plain = runner.childEnv(fixtureDir, {});
  assert.ok(plain.RTCI_DB_PATH.startsWith(fixtureDir));
});

// ================================================================== refusals

check("REFUSE-1  bootstrap-pending cannot execute, and reports corpus_unidentified", (dir) => {
  const { root, registry } = standardSet(dir, { bootstrapPending: true });
  const result = verification.verifyCorpusSet(["rtci"], { root, registry });
  assertRefused(result, REASON.UNIDENTIFIED);
  assert.match(result.detail, /no reviewed expected_schema_fingerprint/);
});

check("REFUSE-2  a stale set cannot execute, anchored on its OLDEST member", (dir) => {
  const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
  const { root, registry } = standardSet(dir, { createdAt: old });
  const result = verification.verifyCorpusSet(["rtci"], { root, registry });
  assertRefused(result, REASON.SNAPSHOT_STALE);
});

check("REFUSE-3  a hash mismatch cannot execute", (dir) => {
  // The published file is edited after the manifest recorded its hash: the on-disk corpus no longer is
  // what was verified at acquisition.
  const { root, registry } = standardSet(dir);
  const published = path.join(root, "sets", "set-a", "rtci.db");
  const db = new Database(published);
  db.prepare("INSERT INTO agencies (ori, name, state) VALUES (?, ?, ?)").run("EXTRA", "Extra", "LA");
  db.close();
  snapshot.removeSidecars(published);

  const result = verification.verifyCorpusSet(["rtci"], { root, registry });
  assertRefused(result, REASON.HASH_MISMATCH);
});

check("REFUSE-4  a corpus absent from the active set cannot execute", (dir) => {
  const { root, registry } = standardSet(dir);
  // SHR is declared by the command and known to the registry, but this set never contained it.
  registry.corpora.push({
    id: "shr", env: "SHR_DB_PATH", authoritative_remote: "/fake/shr.db", forbidden_remote: [],
    bootstrap_pending: false, expected_schema_fingerprint: "sha256:whatever",
    required_tables: ["incidents"], row_floors: { incidents: 1 }, receipts: null,
  });
  const result = verification.verifyCorpusSet(["rtci", "shr"], { root, registry });
  assertRefused(result, REASON.NOT_IN_SET);
  // Item 7: RTCI verified, SHR not in the set -- and both are visible.
  assert.equal(result.summary, "rtci=verified shr=corpus_not_in_set");
});

check("REFUSE-5  an unknown corpus id cannot execute", (dir) => {
  const { root, registry } = standardSet(dir);
  const result = verification.verifyCorpusSet(["rtci", "not_a_corpus"], { root, registry });
  assertRefused(result, REASON.UNKNOWN_ID);
});

check("REFUSE-6  a manifest path escaping the active set cannot execute", (dir) => {
  // The decisive mixed-set mechanism: a manifest that names its own file can try to point outside.
  const { registry } = standardSet(dir, { setId: "set-a" });
  const root = path.join(dir, "corpora");
  const source = path.join(dir, "source-rtci.db");
  publishFakeSet(root, "set-b", [{ id: "rtci", source }], (manifest) => {
    manifest.corpora.rtci.published_file = path.join("..", "set-a", "rtci.db");
  });
  fs.writeFileSync(path.join(root, "active.json"),
    JSON.stringify({ snapshot_set_id: "set-b" }, null, 2));

  const result = verification.verifyCorpusSet(["rtci"], { root, registry });
  assertRefused(result, REASON.PATH_OUTSIDE_SET);
  assert.match(result.detail, /outside the active set/);
});

check("REFUSE-7  RTCI and SHR cannot be combined from DIFFERENT sets", (dir) => {
  const rtciSource = path.join(dir, "source-rtci.db");
  const shrSource = path.join(dir, "source-shr.db");
  buildCorpusDb(rtciSource);
  buildSecondDb(shrSource);
  const registry = reviewedRegistry(dir, [
    { id: "rtci", env: "RTCI_DB_PATH", source: rtciSource, tables: ["agencies"],
      floors: { agencies: 5 } },
    { id: "shr", env: "SHR_DB_PATH", source: shrSource, tables: ["incidents"],
      floors: { incidents: 4 } },
  ]);
  const root = path.join(dir, "corpora");

  // Two complete, individually valid sets: one holds RTCI, the other holds SHR.
  publishFakeSet(root, "set-rtci", [{ id: "rtci", source: rtciSource }]);
  publishFakeSet(root, "set-shr", [{ id: "shr", source: shrSource }]);

  // Whichever one is active, the command declaring BOTH is refused. There is no union across sets,
  // because resolution goes through a single active pointer -- so the combination is unrepresentable
  // rather than merely rejected. Both directions are checked so the refusal is not an artefact of
  // which set happened to be active.
  for (const active of ["set-rtci", "set-shr"]) {
    fs.writeFileSync(path.join(root, "active.json"),
      JSON.stringify({ snapshot_set_id: active }, null, 2));
    const result = verification.verifyCorpusSet(["rtci", "shr"], { root, registry });
    assertRefused(result, REASON.NOT_IN_SET);
    const missing = active === "set-rtci" ? "shr" : "rtci";
    assert.match(result.summary, new RegExp(`${missing}=corpus_not_in_set`));
    // The set that IS present still verified, which is what makes this a genuine mixed-set refusal
    // rather than a general failure to verify anything.
    const present = active === "set-rtci" ? "rtci" : "shr";
    assert.match(result.summary, new RegExp(`${present}=verified`));
  }
});

check("REFUSE-8  no active pointer, and an unset corpus dir, both refuse", (dir) => {
  const { registry } = standardSet(dir);
  const empty = path.join(dir, "empty-root");
  fs.mkdirSync(empty, { recursive: true });
  assertRefused(verification.verifyCorpusSet(["rtci"], { root: empty, registry }),
    REASON.SET_ABSENT);
  assertRefused(verification.verifyCorpusSet(["rtci"], { root: "", registry }),
    REASON.DIR_UNSET);
  assertRefused(verification.verifyCorpusSet(["rtci"], { root: undefined, registry,
    // Explicitly simulating the variable being unset, rather than depending on the ambient env.
  }), process.env[verification.CORPUS_DIR_ENV] ? REASON.SET_ABSENT : REASON.DIR_UNSET);
});

check("REFUSE-9  a pointer and manifest disagreeing about set identity refuse", (dir) => {
  const { registry } = standardSet(dir);
  const root = path.join(dir, "corpora");
  // The manifest inside set-a is rewritten to claim it is a different set.
  const manifestPath = path.join(root, "sets", "set-a", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.snapshot_set_id = "some-other-set";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const result = verification.verifyCorpusSet(["rtci"], { root, registry });
  assertRefused(result, REASON.SET_UNIDENTIFIED);
});

check("REFUSE-10  a corpus not verified at acquisition stays refused afterwards", (dir) => {
  const { root, registry } = standardSet(dir, { state: REASON.INTEGRITY_FAILED });
  const result = verification.verifyCorpusSet(["rtci"], { root, registry });
  assertRefused(result, REASON.INTEGRITY_FAILED);
});

check("REFUSE-11  an empty corpus_ids declaration cannot execute", (dir) => {
  const { root, registry } = standardSet(dir);
  const result = verification.verifyCorpusSet([], { root, registry });
  assert.equal(result.ok, false);
  assert.deepEqual(result.env, {});
});

// ================================================================== caching

check("CACHE-1  verification is cached per corpus, but every command's set is evaluated", (dir) => {
  const { root, registry } = standardSet(dir);
  const cache = verification.createVerificationCache();

  const first = verification.verifyCorpusSet(["rtci"], { root, registry, cache });
  assert.equal(first.ok, true);

  // Delete the published file. A cached VERIFICATION legitimately survives this -- the run already
  // proved the corpus -- which is what makes the cache worth having for ten Tier C commands.
  fs.rmSync(path.join(root, "sets", "set-a", "rtci.db"));
  const second = verification.verifyCorpusSet(["rtci"], { root, registry, cache });
  assert.equal(second.ok, true, "the per-corpus verification should be memoised within a run");

  // But a command declaring a DIFFERENT set is still evaluated rather than inheriting that answer.
  const third = verification.verifyCorpusSet(["rtci", "not_a_corpus"], { root, registry, cache });
  assertRefused(third, REASON.UNKNOWN_ID);

  // And with no cache, the same call now sees the truth.
  const fresh = verification.verifyCorpusSet(["rtci"], { root, registry });
  assertRefused(fresh, REASON.ABSENT);
});

// ================================================================== verdict wiring

check("VERDICT-1  a Tier C failure against VERIFIED corpora is tier_c_failed and exits non-zero", () => {
  const results = [
    { id: "tf", tier: "F", state: runner.PASSED, command: "a", entry: "test" },
    { id: "tc", tier: "C", state: runner.FAILED, command: "b", entry: "test",
      corpus_verified: true, corpus_set_id: "set-a", corpus_ids: ["rtci"], reason: "assertion failed" },
  ];
  const plan = { commands: [{}, {}], topLevel: 2, cycles: [], missing: [] };
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  let value;
  try {
    value = runner.report(results, plan, { probe: false, only: null }, []);
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");
  assert.match(output, /verdict {2}corpus: {2}tier_c_failed/);
  assert.match(output, /FAILED against verified corpora/);
  assert.doesNotMatch(output, /corpus_not_certified/);
  // The distinction that matters: this is NOT a skip and NOT an absent corpus.
  assert.doesNotMatch(output, /skipped \(Tier C/);
  assert.equal(value, 1, "tier_c_failed must exit non-zero");
});

check("VERDICT-2  a skip is still corpus_not_certified, and still exits zero", () => {
  const results = [
    { id: "tf", tier: "F", state: runner.PASSED, command: "a", entry: "test" },
    { id: "tc", tier: "C", state: runner.SKIPPED, command: "b", entry: "test",
      corpus_requirement: "canonical RTCI", reason: "rtci=corpus_unidentified",
      corpus_ids: ["rtci"], corpus_set_id: null,
      corpus_reasons: [{ id: "rtci", ok: false, reason: "corpus_unidentified", detail: "no review" }] },
  ];
  const plan = { commands: [{}, {}], topLevel: 2, cycles: [], missing: [] };
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  let value;
  try {
    value = runner.report(results, plan, { probe: false, only: null }, []);
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");
  assert.match(output, /verdict {2}corpus: {2}corpus_not_certified/);
  assert.doesNotMatch(output, /tier_c_failed/);
  // Item 7 in the report itself: the per-corpus code is printed, not just a collapsed summary.
  assert.match(output, /rtci\s+corpus_unidentified/);
  assert.equal(value, 0);
});

// ================================================================== schema fingerprint

check("FP-1  ANALYZE does not change the fingerprint", (dir) => {
  const file = path.join(dir, "fp.db");
  buildCorpusDb(file);
  const before = snapshot.schemaFingerprint(file).fingerprint;

  const db = new Database(file);
  db.exec("ANALYZE");
  db.close();
  snapshot.removeSidecars(file);

  // Proof the operation actually did something, so the equality below is not vacuous.
  const check = new Database(file, { readonly: true });
  const stat = check.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get().n;
  check.close();
  snapshot.removeSidecars(file);
  assert.equal(stat, 1, "ANALYZE should have created sqlite_stat1");

  assert.equal(snapshot.schemaFingerprint(file).fingerprint, before,
    "routine ANALYZE must not change the fingerprint");
});

check("FP-2  dropping an application index CHANGES the fingerprint", (dir) => {
  const file = path.join(dir, "fp.db");
  buildCorpusDb(file);
  const before = snapshot.schemaFingerprint(file);
  assert.deepEqual(before.indexes, ["idx_agencies_state"]);

  const db = new Database(file);
  db.exec("DROP INDEX idx_agencies_state");
  db.close();
  snapshot.removeSidecars(file);

  const after = snapshot.schemaFingerprint(file);
  assert.notEqual(after.fingerprint, before.fingerprint,
    "dropping an index must change the fingerprint");
  assert.deepEqual(after.indexes, []);
});

check("FP-3  changing an index's uniqueness or predicate CHANGES the fingerprint", (dir) => {
  const base = path.join(dir, "base.db");
  buildCorpusDb(base);
  const baseline = snapshot.schemaFingerprint(base).fingerprint;

  // Same name, same column, now UNIQUE-shaped by rebuild on a distinct column set.
  const uniqueDb = path.join(dir, "unique.db");
  buildCorpusDb(uniqueDb);
  let db = new Database(uniqueDb);
  db.exec("DROP INDEX idx_agencies_state");
  db.exec("CREATE UNIQUE INDEX idx_agencies_state ON agencies (state, ori)");
  db.close();
  snapshot.removeSidecars(uniqueDb);
  assert.notEqual(snapshot.schemaFingerprint(uniqueDb).fingerprint, baseline,
    "uniqueness and indexed columns are part of the fingerprint");

  // A PARTIAL index whose predicate differs only in a literal. Every `PRAGMA index_list` field is
  // identical between these two, which is why the normalised SQL is included.
  const partialA = path.join(dir, "partial-a.db");
  const partialB = path.join(dir, "partial-b.db");
  for (const [file, year] of [[partialA, 2000], [partialB, 1990]]) {
    buildCorpusDb(file);
    db = new Database(file);
    db.exec("DROP INDEX idx_agencies_state");
    db.exec(`CREATE INDEX idx_agencies_state ON agencies (state) WHERE ori > 'ORI${year}'`);
    db.close();
    snapshot.removeSidecars(file);
  }
  assert.notEqual(
    snapshot.schemaFingerprint(partialA).fingerprint,
    snapshot.schemaFingerprint(partialB).fingerprint,
    "a partial index predicate change must change the fingerprint");
});

check("FP-4  reformatting an index definition does NOT change the fingerprint", (dir) => {
  // The other half of FP-3: whitespace normalisation is what keeps a reformatted migration from
  // reading as a schema change. Without this, the SQL inclusion would make the fingerprint brittle.
  const tight = path.join(dir, "tight.db");
  const loose = path.join(dir, "loose.db");
  buildCorpusDb(tight);
  buildCorpusDb(loose);
  for (const [file, sql] of [
    [tight, "CREATE INDEX idx_x ON agencies (state)"],
    [loose, "CREATE INDEX   idx_x\n  ON agencies\n  (state)"],
  ]) {
    const db = new Database(file);
    db.exec(sql);
    db.close();
    snapshot.removeSidecars(file);
  }
  assert.equal(
    snapshot.schemaFingerprint(tight).fingerprint,
    snapshot.schemaFingerprint(loose).fingerprint,
    "formatting-only differences must not change the fingerprint");
});

check("FP-5  column type, nullability, default and PK each CHANGE the fingerprint", (dir) => {
  const variants = {
    baseline: "CREATE TABLE t (a TEXT NOT NULL PRIMARY KEY, b INTEGER DEFAULT 7)",
    type: "CREATE TABLE t (a TEXT NOT NULL PRIMARY KEY, b TEXT DEFAULT 7)",
    nullability: "CREATE TABLE t (a TEXT PRIMARY KEY, b INTEGER DEFAULT 7)",
    dflt: "CREATE TABLE t (a TEXT NOT NULL PRIMARY KEY, b INTEGER DEFAULT 8)",
    noDefault: "CREATE TABLE t (a TEXT NOT NULL PRIMARY KEY, b INTEGER)",
    pk: "CREATE TABLE t (a TEXT NOT NULL, b INTEGER DEFAULT 7 PRIMARY KEY)",
  };
  const prints = {};
  for (const [name, ddl] of Object.entries(variants)) {
    const file = path.join(dir, `${name}.db`);
    const db = new Database(file);
    db.exec(ddl);
    db.close();
    snapshot.removeSidecars(file);
    prints[name] = snapshot.schemaFingerprint(file).fingerprint;
  }
  for (const name of Object.keys(variants)) {
    if (name === "baseline") continue;
    assert.notEqual(prints[name], prints.baseline,
      `${name} must change the fingerprint -- names alone are not identity`);
  }
  // All six distinct: no two mutations collide onto the same hash.
  assert.equal(new Set(Object.values(prints)).size, Object.keys(variants).length,
    "each structural mutation must produce a distinct fingerprint");
});

check("FP-6  the old name-only fingerprint would have MISSED these, which is why it changed", (dir) => {
  // The regression this strengthening exists for, stated as a test rather than a claim: reproduce the
  // superseded algorithm and show it accepts a database the new one rejects.
  function nameOnlyFingerprint(file) {
    const db = new Database(file, { readonly: true });
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all().map((r) => r.name);
      const lines = tables.map((t) =>
        `${t}(${db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name).join(",")})`);
      return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
    } finally {
      db.close();
    }
  }

  const strict = path.join(dir, "strict.db");
  const loose = path.join(dir, "loose.db");
  const strictDb = new Database(strict);
  strictDb.exec("CREATE TABLE t (year INTEGER NOT NULL, v TEXT)");
  strictDb.exec("CREATE INDEX idx_year ON t (year)");
  strictDb.close();
  const looseDb = new Database(loose);
  looseDb.exec("CREATE TABLE t (year TEXT, v TEXT)");
  looseDb.close();
  snapshot.removeSidecars(strict);
  snapshot.removeSidecars(loose);

  assert.equal(nameOnlyFingerprint(strict), nameOnlyFingerprint(loose),
    "the superseded algorithm should be blind to this difference -- if it is not, this test no " +
    "longer demonstrates the gap it was written for");
  assert.notEqual(
    snapshot.schemaFingerprint(strict).fingerprint,
    snapshot.schemaFingerprint(loose).fingerprint,
    "the strengthened fingerprint must reject a retyped, un-constrained, de-indexed twin");
});

check("FP-7  a TABLE-LEVEL UNIQUE constraint is part of the fingerprint", (dir) => {
  // The gap Codex found. SQLite implements a table-level UNIQUE with an auto-index named
  // `sqlite_autoindex_*`, which the index section excludes by design -- so before the constraint
  // section existed, adding, dropping or re-columning a UNIQUE moved nothing. `PRAGMA table_info`
  // never sees table-level constraints at all, so nothing else covered it.
  const variants = {
    none: "CREATE TABLE t (a TEXT, b TEXT)",
    uniqueAB: "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a, b))",
    uniqueBA: "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (b, a))",
    uniqueA: "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a))",
    twoUnique: "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a), UNIQUE (b))",
  };
  const prints = {};
  for (const [name, ddl] of Object.entries(variants)) {
    const file = path.join(dir, `${name}.db`);
    const db = new Database(file);
    db.exec(ddl);
    db.close();
    snapshot.removeSidecars(file);
    prints[name] = snapshot.schemaFingerprint(file).fingerprint;
  }

  // ADDING one changes it; REMOVING it is the same comparison read the other way.
  assert.notEqual(prints.uniqueAB, prints.none,
    "adding a table-level UNIQUE must change the fingerprint");
  // CHANGING it: a different column list, and the SAME columns in a different order.
  assert.notEqual(prints.uniqueA, prints.uniqueAB,
    "changing a UNIQUE's column list must change the fingerprint");
  assert.notEqual(prints.uniqueBA, prints.uniqueAB,
    "reordering a UNIQUE's columns must change the fingerprint -- order decides which prefix scans");
  assert.notEqual(prints.twoUnique, prints.uniqueA,
    "adding a second UNIQUE must change the fingerprint");
  assert.equal(new Set(Object.values(prints)).size, Object.keys(variants).length,
    "each UNIQUE mutation must produce a distinct fingerprint");

  // The invariant that constrains HOW this may be implemented: ANALYZE writes sqlite_stat1 and
  // creates no index of any origin, so a constraint section keyed on index_list must stay blind to it.
  const analysed = path.join(dir, "uniqueAB.db");
  const before = snapshot.schemaFingerprint(analysed).fingerprint;
  const db = new Database(analysed);
  db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run("x", "y");
  db.exec("ANALYZE");
  db.close();
  snapshot.removeSidecars(analysed);
  const stat = new Database(analysed, { readonly: true });
  const hasStat = stat.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get().n;
  stat.close();
  snapshot.removeSidecars(analysed);
  assert.equal(hasStat, 1, "ANALYZE should have created sqlite_stat1");
  assert.equal(snapshot.schemaFingerprint(analysed).fingerprint, before,
    "ANALYZE must remain invisible even now that auto-indexes are inspected");

  // An APPLICATION unique index is origin 'c'. It must appear once, in the index section, and must not
  // be double-counted as a constraint -- otherwise the two sections would drift.
  const appIndex = path.join(dir, "appindex.db");
  const appDb = new Database(appIndex);
  appDb.exec("CREATE TABLE t (a TEXT, b TEXT)");
  appDb.exec("CREATE UNIQUE INDEX idx_a ON t (a)");
  appDb.close();
  snapshot.removeSidecars(appIndex);
  const canonical = snapshot.schemaFingerprint(appIndex).canonical;
  // Line-anchored on purpose: the index line embeds its own normalised SQL, so a naive substring count
  // of "INDEX idx_a" finds the section prefix AND the `sql=CREATE UNIQUE INDEX idx_a ...` inside it.
  const indexLines = canonical.split("\n").filter((line) => line.startsWith("INDEX idx_a "));
  assert.equal(indexLines.length, 1,
    `an application unique index belongs in the index section exactly once, got ${indexLines.length}`);
  assert.doesNotMatch(canonical, /CONSTRAINT/,
    "an application index (origin 'c') must not also be reported as a table-level constraint");
});

check("FP-8  constraint key COLLATION and SORT DIRECTION are part of the fingerprint", (dir) => {
  // The second gap Codex found. `PRAGMA index_info` returns only seqno/cid/name, so the constraint
  // representation carried WHICH columns but not how they compare. Measured on SQLite 3.51.2 before the
  // fix: `UNIQUE (a, b)` and `UNIQUE (a COLLATE NOCASE, b)` produced the SAME fingerprint -- and NOCASE
  // changes which rows collide, so a real change to what the constraint enforces read as no change.
  // `PRAGMA index_xinfo` adds `desc`, `coll` and `key`, which is what closes it.
  const variants = {
    plain: "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a, b))",
    nocaseA: "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a COLLATE NOCASE, b))",
    nocaseB: "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a, b COLLATE NOCASE))",
    rtrimA: "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a COLLATE RTRIM, b))",
    descA: "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a DESC, b))",
    descBoth: "CREATE TABLE t (a TEXT, b TEXT, UNIQUE (a DESC, b DESC))",
  };
  const files = {};
  const prints = {};
  for (const [name, ddl] of Object.entries(variants)) {
    const file = path.join(dir, `${name}.db`);
    const db = new Database(file);
    db.exec(ddl);
    db.close();
    snapshot.removeSidecars(file);
    files[name] = file;
    prints[name] = snapshot.schemaFingerprint(file).fingerprint;
  }

  // COLLATION: the case Codex named, plus position-sensitivity and a third collation. A representation
  // that recorded "some collation differs" without recording WHICH column or WHICH collation would pass
  // the first and fail these.
  assert.notEqual(prints.nocaseA, prints.plain,
    "UNIQUE (a COLLATE NOCASE, b) must differ from UNIQUE (a, b)");
  assert.notEqual(prints.nocaseB, prints.nocaseA,
    "collation on b must differ from the same collation on a -- position matters");
  assert.notEqual(prints.rtrimA, prints.nocaseA,
    "RTRIM must differ from NOCASE, not merely from BINARY");

  // SORT DIRECTION, asserted against what this build actually preserves rather than assumed. SQLite is
  // permitted to ignore ASC/DESC on a table-level constraint; if it does, `desc` comes back 0 and there
  // is nothing for the fingerprint to carry. Both branches are asserted, so this can never pass by
  // silently skipping.
  const probe = new Database(files.descA, { readonly: true });
  const autoIndex = probe.prepare('PRAGMA index_list("t")').all()
    .filter((row) => row.origin !== "c")[0];
  const preservesDesc = probe.prepare(`PRAGMA index_xinfo("${autoIndex.name}")`).all()
    .some((c) => c.key === 1 && c.desc === 1);
  probe.close();
  snapshot.removeSidecars(files.descA);

  if (preservesDesc) {
    assert.notEqual(prints.descA, prints.plain,
      "this build preserves DESC on a constraint, so it must change the fingerprint");
    assert.notEqual(prints.descBoth, prints.descA,
      "DESC on both columns must differ from DESC on one");
    assert.equal(new Set(Object.values(prints)).size, Object.keys(variants).length,
      "each collation/direction variant must produce a distinct fingerprint");
  } else {
    // Recorded, not skipped: on such a build the DDL difference does not survive into the schema, so
    // equality is the correct answer and the claim is about SQLite, not about this function.
    assert.equal(prints.descA, prints.plain,
      "this build does NOT preserve DESC on a table-level constraint (index_xinfo reports desc=0), " +
      "so the fingerprints must be equal -- if they differ, something else is leaking in");
  }

  // ANALYZE invariance must survive the switch to index_xinfo, which is the constraint on HOW this may
  // be implemented. Re-asserted here against a table that HAS a collated constraint.
  const before = snapshot.schemaFingerprint(files.nocaseA).fingerprint;
  const db = new Database(files.nocaseA);
  db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run("X", "y");
  db.exec("ANALYZE");
  db.close();
  snapshot.removeSidecars(files.nocaseA);
  assert.equal(snapshot.schemaFingerprint(files.nocaseA).fingerprint, before,
    "ANALYZE must remain invisible with index_xinfo in use");

  // The same helper serves the application-index section, so collation is covered there too. This is
  // the one place the two sections could have drifted.
  const appPlain = path.join(dir, "app-plain.db");
  const appNocase = path.join(dir, "app-nocase.db");
  for (const [file, ddl] of [
    [appPlain, "CREATE INDEX idx_a ON t (a)"],
    [appNocase, "CREATE INDEX idx_a ON t (a COLLATE NOCASE)"],
  ]) {
    const appDb = new Database(file);
    appDb.exec("CREATE TABLE t (a TEXT, b TEXT)");
    appDb.exec(ddl);
    appDb.close();
    snapshot.removeSidecars(file);
  }
  assert.notEqual(
    snapshot.schemaFingerprint(appNocase).fingerprint,
    snapshot.schemaFingerprint(appPlain).fingerprint,
    "an application index's collation must also change the fingerprint");
});

// ================================================================== mutation certification

/**
 * Mutation, not just regression.
 *
 * FP-7 and FP-8 assert the properties. These prove those tests are DECISIVE: remove exactly one
 * expression that implements each property and the named test must fail, for that reason. Without this,
 * a test could be passing for some incidental reason and the gap could still be open.
 *
 * EACH MUTATION IS NARROW ON PURPOSE. A blunt mutation -- swapping `index_xinfo` back to `index_info`,
 * say -- also empties the key-column filter and breaks everything, which proves nothing about WHICH
 * property the test protects. So collation and sort direction are killed separately, and each mutation
 * declares the test that must fail AND a test that must still pass.
 *
 * The child runs the REAL committed suite rather than a throwaway probe, so what catches the mutation is
 * the test that ships. `CDA_REACHABILITY_CHILD` stops the child from recursing into this section.
 *
 * The source is restored in `finally` and the restore is verified byte-for-byte, loudly, because a
 * failed restore leaves the working tree modified.
 */
const SNAPSHOT_LIB = path.join(__dirname, "lib", "corpus-snapshot.js");

const MUTATIONS = [
  {
    id: "MUTATE-1",
    what: "the origin filter that collects table-level constraints from PRAGMA index_list",
    removes: "table-level UNIQUE / PRIMARY KEY constraints from the fingerprint entirely",
    from: '.filter((row) => row.origin !== "c")',
    to: ".filter(() => false)",
    mustFail: "FP-7",
    mustStillPass: "FP-1",
  },
  {
    id: "MUTATE-2",
    what: "the collation term in the constraint key representation",
    removes: "collation, so UNIQUE (a COLLATE NOCASE, b) collides with UNIQUE (a, b) again",
    from: 'coll=${c.coll || "<none>"}',
    to: "coll=<none>",
    mustFail: "FP-8",
    // FP-7 varies only column LISTS, so it must survive: that is what makes FP-8's failure
    // attributable to collation specifically rather than to constraints breaking in general.
    mustStillPass: "FP-7",
  },
  {
    id: "MUTATE-3",
    what: "the sort-direction term in the constraint key representation",
    removes: "ASC/DESC, so UNIQUE (a DESC, b) collides with UNIQUE (a, b) again",
    from: '${c.desc ? "DESC" : "ASC"}',
    to: "ASC",
    mustFail: "FP-8",
    mustStillPass: "FP-7",
  },
];

function runSuiteChild() {
  const result = spawnSync(process.execPath, [__filename], {
    encoding: "utf8",
    env: { ...process.env, CDA_REACHABILITY_CHILD: "1" },
  });
  return { code: result.status, out: `${result.stdout || ""}${result.stderr || ""}` };
}

/**
 * The unmutated baseline, run ONCE and reused by every mutation.
 *
 * It is the same source producing the same result each time, so re-running it per mutation tripled the
 * cost of this file for no additional evidence -- enough to push the canonical harness past its budget.
 * Memoised, not dropped: the "does the unmutated suite already fail?" guard is what stops a mutation
 * from proving nothing, so every mutation still checks it.
 */
let cleanBaseline = null;
function cleanSuiteBaseline() {
  if (cleanBaseline === null) cleanBaseline = runSuiteChild();
  return cleanBaseline;
}

if (process.env.CDA_REACHABILITY_CHILD !== "1") {
  for (const mutation of MUTATIONS) {
    check(`${mutation.id}  removing ${mutation.what} makes ${mutation.mustFail} fail`, () => {
      const original = fs.readFileSync(SNAPSHOT_LIB);
      try {
        const clean = cleanSuiteBaseline();
        assert.equal(clean.code, 0,
          `the UNMUTATED suite already fails, so a mutation would prove nothing:\n${clean.out}`);
        assert.match(clean.out, new RegExp(`ok {4}${mutation.mustFail}`),
          `${mutation.mustFail} must pass before it is trusted to catch anything`);

        const source = original.toString("utf8");
        const occurrences = source.split(mutation.from).length - 1;
        assert.equal(occurrences, 1,
          `expected exactly 1 mutation site for ${JSON.stringify(mutation.from)}, found ` +
          `${occurrences} -- the mutation would not have landed where intended`);
        fs.writeFileSync(SNAPSHOT_LIB,
          Buffer.from(source.replace(mutation.from, mutation.to), "utf8"));

        const mutated = runSuiteChild();
        assert.notEqual(mutated.code, 0,
          `the mutated suite still exited 0, so this gap could reopen unnoticed. Mutation removes ` +
          `${mutation.removes}\n${mutated.out}`);
        // BY NAME: a mutation that broke something else would also exit non-zero and would be
        // worthless as evidence about this property.
        assert.match(mutated.out, new RegExp(`FAIL {2}${mutation.mustFail}`),
          `the mutated suite failed, but not at ${mutation.mustFail}:\n${mutated.out}`);
        assert.match(mutated.out, new RegExp(`ok {4}${mutation.mustStillPass}`),
          `${mutation.mustStillPass} must still pass under this mutation -- otherwise the mutation ` +
          `removed more than intended and ${mutation.mustFail}'s failure is not attributable`);
      } finally {
        fs.writeFileSync(SNAPSHOT_LIB, original);
        const restored = fs.readFileSync(SNAPSHOT_LIB);
        if (!restored.equals(original)) {
          console.log(`  !!!!  RESTORE FAILED -- ${SNAPSHOT_LIB} is left mutated`);
          failures.push({ name: `${mutation.id} restore`, error: new Error("restore failed") });
        }
      }
    });
  }
}

// ==================================================================

console.log("");
console.log(`corpus reachability: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) {
    console.log(`\n${failure.name}`);
    console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error));
  }
  process.exitCode = 1;
}
