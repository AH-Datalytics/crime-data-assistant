/**
 * Registry-backed corpus verification: the gate between a declared Tier C requirement and permission
 * to execute against real data.
 *
 * WHAT THIS REPLACES, AND WHY. P1.1's `corpusAvailability()` walked a per-command list of candidate
 * paths and answered "does a non-empty file exist at any of them?". That is a detector, not a proof.
 * It could not tell a reviewed snapshot from yesterday's leftover, could not tell which snapshot two
 * corpora came from, and its answer was "available" for any file of non-zero length. A Tier C command
 * gated on it ran against whatever happened to be on that developer's disk -- which is the pre-P1.1
 * behaviour the tier system exists to remove, re-entering through the gate instead of the front door.
 *
 * THE INVERSION THAT MATTERS. Availability was permissive: absence caused a skip, presence caused
 * execution. Verification is restrictive: execution requires an affirmative proof, and everything else
 * -- including every kind of "nearly right" -- makes execution UNREACHABLE. There is no path through
 * this module that yields database paths without a passed `verifyArtifact` against reviewed registry
 * expectation.
 *
 * ONE SET, RESOLVED ONE WAY. The active set comes from `CDA_CORPUS_DIR/active.json` and nowhere else.
 * No filesystem search, no candidate list, no fallback. Every returned path is derived from that one
 * set's directory, which is what makes "RTCI and SHR from different sets" unrepresentable rather than
 * merely checked -- and it is checked anyway, because a manifest can name a path and paths can escape.
 *
 * WHY THE CACHE IS KEYED BY SET AND CORPUS, NOT BY COMMAND. Verification hashes and opens real
 * databases, so doing it per command would multiply the cost by the number of Tier C commands. But
 * every command's OWN declared corpus set is still evaluated on every call -- item 6 -- because
 * caching the verification and caching the decision are different things, and collapsing them would
 * let a command inherit a neighbour's permission.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const snapshot = require("./corpus-snapshot.js");
const { loadRegistry, corpusById } = require("./corpus-registry.js");

const REASON = snapshot.REASON;

/** The one environment variable that names the corpus root. Never a search path. */
const CORPUS_DIR_ENV = "CDA_CORPUS_DIR";

/**
 * Run-scoped memo. `sets` is keyed by root; `corpora` by the set id and corpus id joined with a NUL.
 *
 * NUL is the separator because it cannot occur in either id, so no pair of distinct keys can collide
 * by concatenation. It MUST be written as a unicode escape in the source and never as a raw byte: a
 * literal NUL makes Git classify the whole file as binary, which is what `check-control-characters.py`
 * exists to catch -- and did catch, twice, on this very function while it was being written. See the
 * key expression below for the form to copy.
 */
function createVerificationCache() {
  return { sets: new Map(), corpora: new Map() };
}

/**
 * Is `file` inside `dir`?
 *
 * `path.relative` rather than a string prefix test: a prefix test says `/a/b-evil` is inside `/a/b`,
 * and on Windows it also disagrees with itself about separators and case. An empty relative path means
 * the file IS the directory, which is not "inside" either.
 */
function isInside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve and structurally validate the single active snapshot set.
 *
 * Set-level failures are returned once and apply to every corpus in the request: a stale set does not
 * become fresh for one of its members.
 */
function resolveActiveSet(root, options) {
  const cache = options.cache;
  if (cache && cache.sets.has(root)) return cache.sets.get(root);

  let result;
  const active = snapshot.loadActiveSet(root);
  if (!active) {
    result = {
      ok: false,
      reason: REASON.SET_ABSENT,
      detail: `no active snapshot set: ${path.join(root, "active.json")} is missing, unreadable, or ` +
        `points at a set with no manifest.json`,
    };
  } else if (active.manifest.snapshot_set_id !== active.snapshot_set_id) {
    // The pointer and the manifest disagree about which set this is. Either the pointer was rewritten
    // or a set directory was moved on top of another; both make identity unprovable.
    result = {
      ok: false,
      reason: REASON.SET_UNIDENTIFIED,
      detail: `active.json points at ${active.snapshot_set_id} but that set's manifest declares ` +
        `${active.manifest.snapshot_set_id}`,
    };
  } else if (path.basename(active.dir) !== active.snapshot_set_id) {
    result = {
      ok: false,
      reason: REASON.SET_UNIDENTIFIED,
      detail: `set directory ${path.basename(active.dir)} does not match its id ${active.snapshot_set_id}`,
    };
  } else if (!active.manifest.corpora || typeof active.manifest.corpora !== "object") {
    result = {
      ok: false,
      reason: REASON.SET_UNIDENTIFIED,
      detail: `set ${active.snapshot_set_id} has no corpora record`,
    };
  } else {
    const age = snapshot.checkSetAge(active.manifest, options.now);
    result = age.ok
      ? { ok: true, id: active.snapshot_set_id, dir: active.dir, manifest: active.manifest, age }
      : { ok: false, reason: age.reason, detail: age.detail, id: active.snapshot_set_id };
  }

  if (cache) cache.sets.set(root, result);
  return result;
}

/** Verify ONE corpus within an already-resolved set. Cached per (set, corpus). */
function verifyOneCorpus(set, corpusId, registry, options) {
  const cache = options.cache;
  const key = `${set.id}\u0000${corpusId}`;
  if (cache && cache.corpora.has(key)) return cache.corpora.get(key);

  const result = (() => {
    let corpus;
    try {
      corpus = corpusById(registry, corpusId);
    } catch {
      // A manifest declaring a corpus the reviewed registry does not know cannot be verified against
      // anything, so it must not resolve to a path.
      return { ok: false, reason: REASON.UNKNOWN_ID, detail: `${corpusId} is not in the registry` };
    }

    const record = set.manifest.corpora[corpusId];
    if (!record) {
      return {
        ok: false,
        reason: REASON.NOT_IN_SET,
        detail: `set ${set.id} does not contain ${corpusId}`,
        env: corpus.env,
      };
    }

    // The published filename is derived from the set directory. A manifest MAY name its own file, and
    // if it does the path is still required to stay inside this set -- a relative escape or an
    // absolute path elsewhere is exactly how two sets would get mixed.
    const declared = record.published_file || `${corpusId}.db`;
    const file = path.resolve(set.dir, declared);
    if (!isInside(set.dir, file)) {
      return {
        ok: false,
        reason: REASON.PATH_OUTSIDE_SET,
        detail: `${corpusId} resolves to ${file}, which is outside the active set ${set.dir}`,
        env: corpus.env,
      };
    }

    // The state recorded at acquisition is carried forward verbatim rather than re-derived, so a
    // corpus that was `bootstrap_pending` when acquired keeps saying so instead of being re-judged
    // by a later, possibly different, registry.
    if (record.state !== "verified") {
      return {
        ok: false,
        reason: record.state || REASON.UNIDENTIFIED,
        detail: record.detail || `${corpusId} was not verified at acquisition`,
        env: corpus.env,
        path: file,
      };
    }

    // The full artifact check, against REVIEWED registry expectation: hash against the recorded remote
    // artifact hash, integrity_check, schema fingerprint, required tables, row floors, receipts.
    const verdict = snapshot.verifyArtifact(corpus, file, {
      remote_snapshot_sha256: record.remote_snapshot_sha256,
    });
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason, detail: verdict.detail, env: corpus.env, path: file,
        observed: verdict.observed };
    }
    return { ok: true, reason: null, detail: null, env: corpus.env, path: file,
      observed: verdict.observed };
  })();

  const stamped = { id: corpusId, ...result };
  if (cache) cache.corpora.set(key, stamped);
  return stamped;
}

/**
 * Verify every corpus a command declares, and return the environment that lets it run -- or the
 * per-corpus reasons it may not.
 *
 * `ok` is true only when EVERY declared corpus verified. `env` is populated only then: a partially
 * verified set must not hand back the half that worked, because a command declaring both would then
 * run with one real database and one fixture and its failure would be attributed to the code.
 */
function verifyCorpusSet(corpusIds, options) {
  const opts = options || {};
  const ids = Array.isArray(corpusIds) ? corpusIds : [];
  const registry = opts.registry || loadRegistry(opts.registryPath);
  const root = opts.root !== undefined ? opts.root : process.env[CORPUS_DIR_ENV];

  if (!ids.length) {
    return {
      ok: false,
      root: root || null,
      set: null,
      corpora: [],
      env: {},
      reason: REASON.UNKNOWN_ID,
      detail: "no corpus_ids declared, so nothing can be verified",
      summary: "no corpora declared",
    };
  }

  if (!root) {
    const corpora = ids.map((id) => ({
      id,
      ok: false,
      reason: REASON.DIR_UNSET,
      detail: `${CORPUS_DIR_ENV} is not set, so no active snapshot set can be resolved`,
    }));
    return { ok: false, root: null, set: null, corpora, env: {},
      reason: REASON.DIR_UNSET, detail: corpora[0].detail, summary: summarise(corpora) };
  }

  const set = resolveActiveSet(root, { cache: opts.cache, now: opts.now });
  if (!set.ok) {
    const corpora = ids.map((id) => ({ id, ok: false, reason: set.reason, detail: set.detail }));
    return { ok: false, root, set: set.id ? { id: set.id } : null, corpora, env: {},
      reason: set.reason, detail: set.detail, summary: summarise(corpora) };
  }

  const corpora = ids.map((id) => verifyOneCorpus(set, id, registry, {
    cache: opts.cache,
    now: opts.now,
  }));
  const ok = corpora.every((c) => c.ok);

  const env = {};
  if (ok) {
    for (const corpus of corpora) env[corpus.env] = corpus.path;
  }

  const firstProblem = corpora.find((c) => !c.ok);
  return {
    ok,
    root,
    set: { id: set.id, dir: set.dir, age_ms: set.age ? set.age.ageMs : null },
    corpora,
    env,
    reason: ok ? null : firstProblem.reason,
    detail: ok ? null : firstProblem.detail,
    summary: summarise(corpora),
  };
}

/**
 * One line naming every corpus and its outcome.
 *
 * Item 7's requirement in its smallest form: "rtci=verified shr=corpus_snapshot_stale" stays legible
 * and stays distinguishable, where a single collapsed reason would report only the first failure and
 * imply the rest were fine.
 */
function summarise(corpora) {
  if (!corpora.length) return "no corpora declared";
  return corpora.map((c) => `${c.id}=${c.ok ? "verified" : c.reason}`).join(" ");
}

module.exports = {
  CORPUS_DIR_ENV,
  REASON,
  createVerificationCache,
  isInside,
  resolveActiveSet,
  verifyCorpusSet,
  summarise,
};
