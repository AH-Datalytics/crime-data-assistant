/**
 * Tier C corpus acquisition and verification.
 *
 * WHY A SNAPSHOT AND NOT A COPY. In WAL mode, committed rows live in the `-wal` until checkpointed, so
 * copying the main database file can omit committed data WHILE ITS HASH MATCHES PERFECTLY. Measured, on
 * a WAL database with autocheckpoint disabled: 1000 committed rows, a main-file-only copy contained 1,
 * and the main file's SHA-256 was identical before and after those 999 commits. A hash of the live file
 * is not weak evidence; it answers a different question entirely.
 *
 * So acquisition creates a CONSISTENT ARTIFACT with SQLite's online backup mechanism, which incorporates
 * committed WAL state, and every hash in this module is a hash of that artifact -- never of a live file.
 *
 * WHAT `corpus_certified` MEANS, since this module produces the evidence for it: every Tier C command
 * passed against byte-verified snapshots of the databases production WAS SERVING, the oldest created
 * within 24 hours. It does not claim upstream sources are current, does not claim the data is correct,
 * and does not claim production is unchanged now -- that last one needs revalidation (`revalidate()`).
 *
 * THE EXPECTED SCHEMA COMES FROM THE REGISTRY, NOT FROM THE DATABASE. Comparing a database against a
 * fingerprint recorded during its own acquisition is circular: it restates the file hash and cannot
 * reject a wrong schema. The registry holds reviewed expectation; the manifest holds observation.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Every way a corpus can fail to be certifiable. Reported PER CORPUS, never collapsed.
 *
 * One vocabulary in one place, deliberately: the runner prints these codes and the reachability tests
 * assert on them, so a second list defined elsewhere would drift and the drift would be invisible.
 *
 * The first seven are ARTIFACT-level -- something about the database itself. The six added by P1.2 are
 * RESOLUTION-level: the corpus may be perfectly good and still be unreachable because the run cannot
 * prove which set it came from. Keeping them distinct is the point of item 7 -- "RTCI verified, SHR
 * stale" and "RTCI verified, SHR absent from this set" are different problems and must not collapse.
 */
const REASON = {
  ABSENT: "corpus_absent",
  EMPTY: "corpus_empty",
  HASH_MISMATCH: "corpus_hash_mismatch",
  INTEGRITY_FAILED: "corpus_integrity_failed",
  UNIDENTIFIED: "corpus_unidentified",
  SNAPSHOT_STALE: "corpus_snapshot_stale",
  CHANGED_SINCE_SNAPSHOT: "corpus_changed_since_snapshot",
  // --- resolution-level, added by P1.2 ---
  DIR_UNSET: "corpus_dir_unset",
  SET_ABSENT: "corpus_set_absent",
  SET_UNIDENTIFIED: "corpus_set_unidentified",
  NOT_IN_SET: "corpus_not_in_set",
  PATH_OUTSIDE_SET: "corpus_path_outside_set",
  UNKNOWN_ID: "corpus_unknown_id",
};

/** Chunk size for bounded-buffer hashing. One buffer is reused for the whole file. */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * SHA-256 of a file, hashed through a fixed 4 MiB buffer rather than read into memory whole.
 *
 * The real corpora are roughly 497 MB and 347 MB, and each acquisition hashes the source before the
 * backup, after the backup, and then the artifact -- so a `readFileSync` implementation would allocate
 * a half-gigabyte buffer several times per run to answer a question that needs constant memory.
 *
 * Deliberately synchronous: every caller is inside a sequential verification step where the ordering
 * matters more than the concurrency, and `createSnapshotArtifact` depends on the before-hash being
 * complete before it opens the database.
 */
function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const handle = fs.openSync(file, "r");
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(handle, buffer, 0, HASH_CHUNK_BYTES, null)) > 0) {
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function openDatabase(file, options) {
  const Database = require("better-sqlite3");
  return new Database(file, options);
}

/**
 * Observable state of a live database and its sidecars, used as EVIDENCE that a backup did not modify
 * the source rather than as an assertion that it did not.
 *
 * SIZE AND MTIME ARE NOT SUFFICIENT, which is why the hash is here. A SQLite page can be rewritten in
 * place with no size change; a WAL frame can be overwritten at the same length; and mtime can be
 * unchanged either because the filesystem's timestamp resolution is coarser than the write interval or
 * because something restored it. An earlier version of this function recorded only size and mtime,
 * which would have let a source that changed during the backup be certified as unchanged.
 *
 * The hash is computed for the main database always, and for the WAL only when it is non-empty -- an
 * empty WAL has one possible content and hashing it adds nothing.
 *
 * `-shm` is excluded deliberately: it is volatile shared memory that SQLite rebuilds at will, so
 * including it would report change that means nothing.
 */
function liveSourceState(file) {
  const state = {};
  for (const [label, suffix] of [["db", ""], ["wal", "-wal"]]) {
    const target = file + suffix;
    if (!fs.existsSync(target)) {
      state[label] = null;
      continue;
    }
    const stat = fs.statSync(target);
    const entry = { bytes: stat.size, mtimeMs: stat.mtimeMs };
    if (label === "db" || stat.size > 0) entry.sha256 = sha256File(target);
    state[label] = entry;
  }
  return state;
}

/**
 * Did the backup modify the live source in a way that matters?
 *
 * The first version of this compared the whole state for equality and failed on every real run. The
 * cause is instructive: opening a WAL database READ-ONLY materialises a zero-byte `-wal` when none
 * exists. That is a sidecar appearing, not content changing, and rejecting it would forbid snapshotting
 * any quiescent database.
 *
 * So the invariant is stated per file rather than as blanket equality:
 *
 *   MAIN FILE   strictly unchanged in bytes and mtime. A checkpoint absorbs WAL content into the main
 *               file, so a checkpoint cannot hide from this.
 *   WAL         absent -> absent, or absent -> zero bytes, is benign materialisation.
 *               A non-empty WAL that SHRANK means a checkpoint or truncation -- forbidden.
 *               A WAL that GREW means the source changed during acquisition -- also refused, because
 *               the recorded evidence would describe a database that no longer exists.
 *
 * `-shm` is not compared at all: it is volatile shared memory SQLite rebuilds at will.
 */
function compareLiveState(before, after) {
  const problems = [];
  const notes = [];

  // MAIN FILE: size, mtime AND hash must all match. The hash is the one that actually closes the hole:
  // a page rewritten in place changes neither size nor mtime resolution-permitting, and a restored
  // mtime defeats the other two on its own.
  const mainBefore = before.db;
  const mainAfter = after.db;
  if (!mainBefore || !mainAfter) {
    problems.push("the main database file went missing across the backup");
  } else {
    if (mainBefore.bytes !== mainAfter.bytes) {
      problems.push(`main file size changed ${mainBefore.bytes} -> ${mainAfter.bytes}, which is what a `
        + "checkpoint looks like");
    }
    if (mainBefore.mtimeMs !== mainAfter.mtimeMs) {
      problems.push(`main file mtime changed ${mainBefore.mtimeMs} -> ${mainAfter.mtimeMs}`);
    }
    if (mainBefore.sha256 !== mainAfter.sha256) {
      problems.push(`main file CONTENT changed: ${String(mainBefore.sha256).slice(0, 16)}... -> ` +
        `${String(mainAfter.sha256).slice(0, 16)}...`);
    }
  }

  const walBefore = before.wal;
  const walAfter = after.wal;
  if (!walBefore && walAfter) {
    if (walAfter.bytes === 0) {
      notes.push("an empty -wal was materialised by opening the database; no content changed");
    } else {
      problems.push(`a non-empty -wal (${walAfter.bytes} bytes) appeared during the backup`);
    }
  } else if (walBefore && walAfter) {
    if (walAfter.bytes < walBefore.bytes) {
      problems.push(`-wal shrank ${walBefore.bytes} -> ${walAfter.bytes}: the backup checkpointed or `
        + "truncated the live WAL");
    } else if (walAfter.bytes > walBefore.bytes) {
      problems.push(`-wal grew ${walBefore.bytes} -> ${walAfter.bytes}: the source was written during `
        + "acquisition, so the recorded evidence would describe a database that no longer exists");
    } else if (walBefore.bytes > 0 && walBefore.sha256 !== walAfter.sha256) {
      // Same length, different content: a WAL frame overwritten in place. Invisible to size, and
      // invisible to mtime if the timestamp was restored or the resolution is too coarse.
      problems.push(`-wal CONTENT changed at the same size (${walAfter.bytes} bytes): ` +
        `${String(walBefore.sha256).slice(0, 16)}... -> ${String(walAfter.sha256).slice(0, 16)}...`);
    }
  } else if (walBefore && !walAfter) {
    problems.push("the -wal was removed during the backup, which is a checkpoint");
  }

  return { unmodified: problems.length === 0, problems, notes };
}

/**
 * A stable hash of the DECLARED schema: table structure plus application-defined indexes.
 *
 * WHY NAMES ALONE WERE NOT ENOUGH. The first version hashed table names and column names. That accepts
 * a database whose `year` column changed from INTEGER to TEXT, whose NOT NULL was dropped, whose
 * primary key moved, or whose covering index was deleted -- every one of which changes what a query
 * returns or how long it takes, while the fingerprint says "same schema". A fingerprint that cannot
 * reject those is not identifying the corpus, it is only counting it.
 *
 * WHAT IS INCLUDED NOW, per column: name, declared type, nullability, default, and primary-key
 * position. And per application-defined index: uniqueness, partiality, its indexed columns in order,
 * and its whitespace-normalised SQL.
 *
 * WHY THE INDEX SQL IS INCLUDED AS WELL AS THE PRAGMA STRUCTURE. `PRAGMA index_list` reports THAT an
 * index is partial, not what its predicate is -- so changing `WHERE year > 2000` to `WHERE year > 1990`
 * leaves every pragma field identical. The normalised SQL closes that. Normalising whitespace (rather
 * than hashing the raw text) keeps a reformatted migration from reading as a schema change.
 *
 * WHY ANALYZE STAYS INVISIBLE. `ANALYZE` writes `sqlite_stat1`, and `sqlite_%` is excluded for both
 * tables and indexes. It creates no application index, so nothing below moves. This is asserted by
 * test, not assumed.
 *
 * `sql IS NOT NULL` in the INDEX query is what excludes auto-indexes from the index section -- SQLite
 * synthesises those for UNIQUE and PRIMARY KEY constraints and names them `sqlite_autoindex_*`.
 *
 * TABLE-LEVEL CONSTRAINTS ARE COVERED SEPARATELY, and that is the gap this section closes. Excluding
 * auto-indexes from the index section is right -- their names are positional, so `UNIQUE (a)` and
 * `UNIQUE (b)` swap names when one is added ahead of the other -- but excluding them entirely meant
 * `UNIQUE (state, ori)` could be added, removed or re-columned with NO change to the fingerprint.
 * `PRAGMA table_info` does not report table-level constraints at all, so nothing else caught it.
 *
 * So each table also emits a CONSTRAINT line per auto-index, taken from `PRAGMA index_list` where
 * `origin` is not 'c' ('u' = a UNIQUE constraint, 'pk' = a PRIMARY KEY). The synthesised NAME is
 * deliberately omitted and the lines are SORTED by their content: that is what keeps the fingerprint
 * stable against SQLite's positional naming while still moving when the constraint set really changes.
 *
 * KEY COLUMNS COME FROM `index_xinfo`, NOT `index_info` -- see `indexKeyColumns`. `index_info` omits
 * collation and sort direction, which made `UNIQUE (a, b)` and `UNIQUE (a COLLATE NOCASE, b)` produce
 * the SAME fingerprint even though they collide on different rows. The index section uses the same
 * helper, so both sections agree on what a key column is.
 *
 * `ANALYZE` remains invisible: it writes `sqlite_stat1`, which the table query excludes by name, and it
 * creates no index of any origin. Asserted by test, not assumed.
 *
 * STILL NOT COVERED, stated rather than left to be discovered:
 *
 *   - CHECK constraints and FOREIGN KEY clauses. Neither creates an index, so neither appears in
 *     `index_list`; reaching them needs `PRAGMA foreign_key_list` plus CHECK parsing, or the table SQL.
 *   - The declared COLLATE of a column that is neither constrained nor indexed. `PRAGMA table_info` has
 *     no collation field, so `a TEXT` and `a TEXT COLLATE NOCASE` give identical TABLE lines. A column
 *     inside a UNIQUE/PK constraint or an index IS covered, because its collation reaches `index_xinfo`.
 *
 * Both are deliberately out of scope: the accepted corrections were the smallest structural fixes for
 * table-level UNIQUE and for constraint key semantics, not comprehensive constraint coverage.
 *
 * Column ORDER within a table is preserved (it is part of the schema); table, constraint and index
 * order are normalised by sorting, so the fingerprint does not depend on creation sequence.
 */
/**
 * The KEY columns of an index, with everything that decides what the index actually enforces.
 *
 * WHY `index_xinfo` AND NOT `index_info`. `index_info` returns only `seqno`, `cid` and `name`. It does
 * not carry collation or sort direction, so `UNIQUE (a, b)` and `UNIQUE (a COLLATE NOCASE, b)` were
 * INDISTINGUISHABLE -- measured, on SQLite 3.51.2: identical fingerprints. `NOCASE` changes which rows
 * collide, so that is a semantic change to the constraint reported as no change at all. Sort direction
 * was invisible the same way. `index_xinfo` adds `desc`, `coll` and `key`, which closes both.
 *
 * `key === 1` filters to real key columns. `index_xinfo` also returns the trailing rowid entry
 * (`key = 0`, `cid = -1`, `name = null`), which is an implementation detail identical for every
 * rowid-table index -- including it would add a constant to every line and distinguish nothing.
 *
 * `cid` is included alongside `name` so an expression column (`cid = -1`) is still positionally
 * identified; for a table-level constraint SQLite does not permit expressions, but `CREATE INDEX` does,
 * and the two share this helper.
 */
function indexKeyColumns(db, indexName) {
  return db.prepare(`PRAGMA index_xinfo("${indexName}")`).all()
    .filter((c) => c.key === 1)
    .map((c) => `${c.seqno}:cid=${c.cid}:${c.name === null ? "<expr>" : c.name}` +
      `:coll=${c.coll || "<none>"}:${c.desc ? "DESC" : "ASC"}`);
}

function schemaFingerprint(file) {
  const db = openDatabase(file, { readonly: true });
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((row) => row.name);

    const lines = [];
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => {
        // `dflt_value` is null both for "no default" and for `DEFAULT NULL`. They are distinguished
        // here by sentinel rather than collapsed, because the second is a declared default.
        const dflt = c.dflt_value === null ? "<nodefault>" : String(c.dflt_value);
        return `${c.name}:${c.type || "<untyped>"}:` +
          `${c.notnull ? "NOTNULL" : "NULLABLE"}:default=${dflt}:pk=${c.pk}`;
      });
      lines.push(`TABLE ${table}(${columns.join(", ")})`);

      // Table-level constraints, via the auto-indexes SQLite synthesises for them. Names are omitted
      // and the lines sorted, because `sqlite_autoindex_t_1` / `_2` are assigned positionally.
      const constraints = db.prepare(`PRAGMA index_list("${table}")`).all()
        .filter((row) => row.origin !== "c")
        .map((row) => {
          const columns = indexKeyColumns(db, row.name);
          const unique = row.unique ? "UNIQUE" : "NONUNIQUE";
          const partial = row.partial ? "PARTIAL" : "FULL";
          return `  CONSTRAINT origin=${row.origin} ${unique} ${partial} (${columns.join(", ")})`;
        })
        .sort();
      for (const constraint of constraints) lines.push(`${table}${constraint}`);
    }

    const indexes = db.prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL " +
      "AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name"
    ).all();
    for (const index of indexes) {
      const listed = db.prepare(`PRAGMA index_list("${index.tbl_name}")`).all()
        .find((row) => row.name === index.name);
      const columns = indexKeyColumns(db, index.name);
      const unique = listed && listed.unique ? "UNIQUE" : "NONUNIQUE";
      const partial = listed && listed.partial ? "PARTIAL" : "FULL";
      const sql = String(index.sql).replace(/\s+/g, " ").trim();
      lines.push(`INDEX ${index.name} ON ${index.tbl_name} ${unique} ${partial} ` +
        `(${columns.join(", ")}) sql=${sql}`);
    }

    const canonical = lines.join("\n");
    return {
      fingerprint: "sha256:" + crypto.createHash("sha256").update(canonical).digest("hex"),
      tables,
      indexes: indexes.map((i) => i.name),
      canonical,
    };
  } finally {
    db.close();
  }
}

/**
 * Create a consistent snapshot artifact from a live SQLite database.
 *
 * Uses the online backup API, which reads committed WAL content. The source is opened READ-ONLY so no
 * checkpoint can be triggered, and the live db/wal state is recorded before and after so "did not
 * modify the source" is evidence rather than a promise.
 *
 * `immutable=1` IS DELIBERATELY NOT USED. It looks like a safety measure and makes SQLite ignore the WAL
 * entirely, which would reintroduce the exact defect this whole module exists to prevent.
 */
async function createSnapshotArtifact(livePath, artifactPath, options) {
  const opts = options || {};
  if (!fs.existsSync(livePath)) {
    throw new Error(`source database does not exist: ${livePath}`);
  }
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(artifactPath + suffix, { force: true });

  // ORDERING IS PART OF THE GUARANTEE, so it is spelled out rather than left to read order.
  //
  // The before-state -- including its hashes -- must be COMPLETE before the database is opened.
  // `liveSourceState` is synchronous precisely so this is true by construction: it cannot interleave
  // with the backup, so it cannot hash bytes the backup has already touched.
  const before = liveSourceState(livePath);

  const db = openDatabase(livePath, { readonly: true });
  let closed = false;
  try {
    await db.backup(artifactPath);
  } finally {
    db.close();
    closed = true;
  }

  // The after-state must begin only once the source handle is closed. While a connection is open
  // SQLite may still materialise or touch sidecars, so hashing before the close would measure our own
  // connection rather than the source.
  if (!closed) throw new Error("refusing to read the after-state with the source handle still open");
  const after = liveSourceState(livePath);

  const comparison = compareLiveState(before, after);
  const result = {
    artifact_path: artifactPath,
    created_at_utc: opts.now || new Date().toISOString(),
    sha256: sha256File(artifactPath),
    bytes: fs.statSync(artifactPath).size,
    live_source_before: before,
    live_source_after: after,
    live_source_unmodified: comparison.unmodified,
    live_source_notes: comparison.notes,
  };
  if (!comparison.unmodified) {
    // Not a warning. If the backup moved the live database, the acquisition tool has side effects on
    // production and must be stopped, not reported around.
    throw new Error(`the backup MODIFIED the live source ${livePath}: ` +
      comparison.problems.join("; "));
  }
  return result;
}

/** `PRAGMA integrity_check`, plus the row counts and fingerprint the verifier needs. */
function inspectArtifact(artifactPath, requiredTables) {
  const db = openDatabase(artifactPath, { readonly: true });
  try {
    const integrity = db.pragma("integrity_check")[0].integrity_check;
    const present = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map((r) => r.name));
    const counts = {};
    for (const table of requiredTables || []) {
      counts[table] = present.has(table)
        ? db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n
        : null;
    }
    return { integrity, present: [...present].sort(), counts };
  } finally {
    db.close();
  }
}

/** RTCI receipt cross-check: consistency between the file and its own build record. NOT currency. */
function crossCheckReceipts(artifactPath, receipts) {
  if (!receipts) return { checked: false, problems: [], diagnostics: {} };
  const db = openDatabase(artifactPath, { readonly: true });
  const problems = [];
  const diagnostics = {};
  try {
    let rows;
    try {
      rows = db.prepare(`SELECT * FROM "${receipts.table}"`).all();
    } catch (error) {
      return { checked: false, problems: [`receipts table unreadable: ${error.message}`], diagnostics };
    }
    if (rows.length === 0) problems.push(`${receipts.table} is empty`);

    for (const row of rows) {
      if (receipts.require_status && row.status !== receipts.require_status) {
        problems.push(`receipt ${row.component}: status ${JSON.stringify(row.status)} != ` +
          `${JSON.stringify(receipts.require_status)}`);
      }
      // Diagnostics only. built_at cannot prove data freshness: rebuilding stale input today yields a
      // fresh timestamp and stale data. Recorded, never gating.
      for (const column of receipts.diagnostic_columns || []) {
        diagnostics[`${row.component}.${column}`] = row[column];
      }
      // The consistency check that matters: does the receipt's own count claim match the file?
      const raw = receipts.counts_column ? row[receipts.counts_column] : null;
      if (!raw) continue;
      let claimed;
      try {
        claimed = JSON.parse(raw);
      } catch {
        problems.push(`receipt ${row.component}: ${receipts.counts_column} is not valid JSON`);
        continue;
      }
      for (const [table, expected] of Object.entries(claimed)) {
        let actual;
        try {
          actual = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
        } catch {
          problems.push(`receipt ${row.component}: claims table ${table}, which is absent`);
          continue;
        }
        if (actual !== expected) {
          problems.push(`receipt ${row.component}: claims ${table}=${expected}, file has ${actual}`);
        }
      }
    }
  } finally {
    db.close();
  }
  return { checked: true, problems, diagnostics };
}

/**
 * Verify one artifact against REVIEWED registry expectation.
 *
 * Returns `{ok, reason, detail, observed}`. The order matters: cheap structural failures are reported
 * before expensive ones so the reason names the first real problem.
 */
function verifyArtifact(corpus, artifactPath, expectations) {
  const observed = {};
  if (!fs.existsSync(artifactPath)) {
    return { ok: false, reason: REASON.ABSENT, detail: `no artifact at ${artifactPath}`, observed };
  }
  observed.bytes = fs.statSync(artifactPath).size;
  if (observed.bytes === 0) {
    return { ok: false, reason: REASON.EMPTY, detail: `${artifactPath} is zero bytes`, observed };
  }

  observed.local_sha256 = sha256File(artifactPath);
  if (expectations.remote_snapshot_sha256 &&
      observed.local_sha256 !== expectations.remote_snapshot_sha256) {
    return {
      ok: false,
      reason: REASON.HASH_MISMATCH,
      detail: `local ${observed.local_sha256.slice(0, 16)}... != remote artifact ` +
        `${expectations.remote_snapshot_sha256.slice(0, 16)}...`,
      observed,
    };
  }

  const inspection = inspectArtifact(artifactPath, corpus.required_tables);
  observed.integrity = inspection.integrity;
  observed.counts = inspection.counts;
  if (inspection.integrity !== "ok") {
    return { ok: false, reason: REASON.INTEGRITY_FAILED, detail: inspection.integrity, observed };
  }

  const schema = schemaFingerprint(artifactPath);
  observed.schema_fingerprint = schema.fingerprint;

  // The bootstrap state, made explicit rather than permissive: with no reviewed expectation there is
  // nothing to verify against, and pretending otherwise would mean adopting whatever we were handed.
  if (corpus.bootstrap_pending || !corpus.expected_schema_fingerprint) {
    return {
      ok: false,
      reason: REASON.UNIDENTIFIED,
      detail: `no reviewed expected_schema_fingerprint for ${corpus.id}; observed ` +
        `${schema.fingerprint} is reported for review and is NOT self-adopted`,
      observed,
    };
  }
  if (schema.fingerprint !== corpus.expected_schema_fingerprint) {
    return {
      ok: false,
      reason: REASON.UNIDENTIFIED,
      detail: `schema fingerprint ${schema.fingerprint} != reviewed expectation ` +
        `${corpus.expected_schema_fingerprint}`,
      observed,
    };
  }

  const missing = (corpus.required_tables || []).filter((t) => !inspection.present.includes(t));
  if (missing.length) {
    return {
      ok: false,
      reason: REASON.UNIDENTIFIED,
      detail: `missing required table(s): ${missing.join(", ")}`,
      observed,
    };
  }

  const breached = [];
  for (const [table, floor] of Object.entries(corpus.row_floors || {})) {
    const actual = inspection.counts[table];
    if (actual === null || actual === undefined || actual < floor) {
      breached.push(`${table}=${actual} < ${floor}`);
    }
  }
  if (breached.length) {
    return {
      ok: false,
      reason: REASON.UNIDENTIFIED,
      detail: `row floor breached: ${breached.join(", ")}`,
      observed,
    };
  }

  const receipts = crossCheckReceipts(artifactPath, corpus.receipts);
  observed.receipt_diagnostics = receipts.diagnostics;
  if (receipts.problems.length) {
    return {
      ok: false,
      reason: REASON.UNIDENTIFIED,
      detail: `receipt cross-check: ${receipts.problems.join("; ")}`,
      observed,
    };
  }

  return { ok: true, reason: null, detail: null, observed };
}

/**
 * Age of a snapshot SET, anchored on its OLDEST member.
 *
 * A set is only as fresh as its stalest database, and the manifest's write time can lag acquisition
 * arbitrarily -- so neither the newest member nor the manifest timestamp is the right anchor.
 */
function setAgeAnchor(manifest) {
  const times = Object.values(manifest.corpora)
    .map((c) => c.remote_snapshot_created_at)
    .filter(Boolean)
    .sort();
  return times.length ? times[0] : null;
}

function checkSetAge(manifest, now) {
  const anchor = setAgeAnchor(manifest);
  if (!anchor) return { ok: false, reason: REASON.SNAPSHOT_STALE, detail: "no creation time recorded" };
  const ageMs = (now ? new Date(now) : new Date()).getTime() - new Date(anchor).getTime();
  if (ageMs > MAX_SNAPSHOT_AGE_MS) {
    return {
      ok: false,
      reason: REASON.SNAPSHOT_STALE,
      detail: `oldest snapshot in the set was created ${(ageMs / 3600000).toFixed(1)}h ago, ` +
        `limit ${MAX_SNAPSHOT_AGE_MS / 3600000}h`,
      anchor,
    };
  }
  return { ok: true, anchor, ageMs };
}

/**
 * Publish a staged set atomically.
 *
 * The manifest is written INSIDE the staging directory before the rename, so it can never be visible
 * alongside a partial set. Then the directory is renamed on the same volume, and the active pointer is
 * replaced by a rename -- not by delete-then-write, which would leave a window with no pointer at all.
 */
function publishSet(root, snapshotSetId, manifest) {
  const staging = path.join(root, "sets", `${snapshotSetId}.staging`);
  const final = path.join(root, "sets", snapshotSetId);
  if (!fs.existsSync(staging)) throw new Error(`no staging directory at ${staging}`);

  fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (fs.existsSync(final)) throw new Error(`set ${snapshotSetId} is already published`);
  fs.renameSync(staging, final);

  const pointer = path.join(root, "active.json");
  const temp = pointer + ".tmp";
  fs.writeFileSync(temp, JSON.stringify({ snapshot_set_id: snapshotSetId }, null, 2) + "\n");
  fs.renameSync(temp, pointer);   // same volume; replaces atomically
  return final;
}

function loadActiveSet(root) {
  const pointer = path.join(root, "active.json");
  if (!fs.existsSync(pointer)) return null;
  const { snapshot_set_id } = JSON.parse(fs.readFileSync(pointer, "utf8"));
  const dir = path.join(root, "sets", snapshot_set_id);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return { snapshot_set_id, dir, manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")) };
}

/**
 * Does production still match what we snapshotted?
 *
 * Re-creates the artifact from the live source and compares its hash with the recorded one. This works
 * because two online backups of an UNCHANGED database are byte-identical -- measured, not assumed. If
 * that reproducibility ever fails, the result is `corpus_changed_since_snapshot`: failing closed,
 * because an unexplained difference cannot be distinguished from a real change.
 *
 * Against real production this contacts production and is separately authorized.
 */
async function revalidate(livePath, recordedSha256, scratchDir) {
  const probe = path.join(scratchDir, `revalidate-${path.basename(livePath)}`);
  const artifact = await createSnapshotArtifact(livePath, probe);
  const same = artifact.sha256 === recordedSha256;
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(probe + suffix, { force: true });
  return same
    ? { ok: true, reason: null, detail: null }
    : {
      ok: false,
      reason: REASON.CHANGED_SINCE_SNAPSHOT,
      detail: `live snapshot ${artifact.sha256.slice(0, 16)}... != recorded ` +
        `${recordedSha256.slice(0, 16)}...`,
    };
}

/**
 * Remove a database file's `-wal` and `-shm` sidecars.
 *
 * Needed because merely OPENING a database read-only materialises them, so verifying a `.partial`
 * leaves `x.db.partial-wal` and `x.db.partial-shm` beside it. Renaming only the main file to `x.db`
 * then publishes a set containing orphaned sidecars named after a file that no longer exists -- dead
 * weight, non-deterministic set contents, and a stale WAL sitting next to a database, which is the kind
 * of thing that is harmless right up until something renames it.
 *
 * Only ever called on run-owned artifacts, never on a live source.
 */
function removeSidecars(file) {
  const removed = [];
  for (const suffix of ["-wal", "-shm"]) {
    const target = file + suffix;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      removed.push(target);
    }
  }
  return removed;
}

/** Delete exactly the recorded run-owned temporary paths. Never a glob, never a directory sweep. */
function cleanupTempPaths(paths) {
  const removed = [];
  for (const target of paths || []) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = target + suffix;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        fs.rmSync(file);
        removed.push(file);
      }
    }
  }
  return removed;
}

module.exports = {
  MAX_SNAPSHOT_AGE_MS,
  REASON,
  sha256File,
  liveSourceState,
  compareLiveState,
  removeSidecars,
  schemaFingerprint,
  createSnapshotArtifact,
  inspectArtifact,
  crossCheckReceipts,
  verifyArtifact,
  setAgeAnchor,
  checkSetAge,
  publishSet,
  loadActiveSet,
  revalidate,
  cleanupTempPaths,
};
