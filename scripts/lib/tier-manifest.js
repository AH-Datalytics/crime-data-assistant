/**
 * The tier manifest: what each database-dependent harness command actually needs.
 *
 * WHY A MANIFEST AT ALL. Committed DDL proves a schema can be created. It does not prove enough rows
 * exist to make an assertion mean anything. The worked case is
 * `scripts/test-current-indexed-state-deterministic.ts`, whose only equality is guarded by
 * `if (base[column] !== null)` -- so a fixture holding a 2017 row with all-NULL indexed columns
 * satisfies "non-empty" and passes while asserting NOTHING. Sufficiency cannot be a global rule; it
 * is declared per test, and it must be able to demand non-null values, not merely rows.
 *
 * WHY THE TIERS ARE NOT SYMMETRIC.
 *
 *   Tier F (fixture-backed) is MANDATORY. It must pass in a clean clone with no production database.
 *   A missing fixture, an unmet precondition, or a skip is a FAILURE.
 *
 *   Tier C (corpus-dependent) may skip, and only for one declared reason: its canonical corpus is not
 *   present. Every skip carries a stable id, its tier, the corpus requirement, and the reason -- the
 *   metadata P1.2 needs to own Tier C execution without reclassifying anything here.
 *
 * A SKIP IS NOT A PASS. Whenever any Tier C command skips, the run is `corpus_not_certified`. It may
 * still be `fixture_passed`; it may never be called "passed". A green Tier F run that silently implies
 * data integrity is the exact failure this increment exists to remove.
 *
 * HOW `requires` IS CHECKED. Each clause is one SQL question against the built fixture, before the
 * test runs:
 *
 *   {database, table, min_rows}                     at least that many rows exist
 *   {database, table, where, min_rows}              at least that many rows match
 *   {database, table, where, non_null:[cols]}       at least one matching row has all cols non-null
 *
 * A violation is a FAILURE, not a skip: the fixture was declared sufficient and is not, which is a
 * defect in the declaration rather than an absent corpus.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { DATABASE_NAMES } = require("./fixture-db.js");
const { loadRegistry } = require("./corpus-registry.js");

const REPO = path.join(__dirname, "..", "..");
const MANIFEST_PATH = path.join(REPO, "scripts", "fixtures", "harness-tier-manifest.json");

const TIERS = ["F", "C"];

/**
 * Platforms an entry may declare. `win32` is the four Windows PowerShell 5.1 suites: the canonical
 * harness runs on Linux, where they are a declared skip, and the canonical workflow's Windows job runs
 * them (scripts/run-platform-suites.js). Adding a platform is a deliberate edit here and needs a job.
 */
const PLATFORMS = ["win32"];

function loadManifest(file) {
  const source = fs.readFileSync(file || MANIFEST_PATH, "utf8");
  const parsed = JSON.parse(source);
  const problems = validateManifest(parsed);
  if (problems.length) {
    throw new Error("tier manifest is invalid:\n  " + problems.join("\n  "));
  }
  return parsed;
}

/**
 * Validate the manifest.
 *
 * `options.knownCorpusIds` exists for tests, which build one-entry manifests and should not have to
 * stand up a registry to do it. Left unset, the REVIEWED registry is the authority -- and a broken
 * registry throws here rather than being caught and treated as "no known corpora", because the second
 * would turn every Tier C declaration into an unknown-id problem and bury the real cause.
 */
function validateManifest(manifest, options) {
  const opts = options || {};
  const problems = [];
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.entries)) {
    return ["manifest must be an object with an `entries` array"];
  }

  const knownCorpusIds = opts.knownCorpusIds
    ? new Set(opts.knownCorpusIds)
    : new Set(loadRegistry(opts.registryPath).corpora.map((c) => c.id));

  const seenIds = new Set();
  const seenScripts = new Set();
  for (const entry of manifest.entries) {
    const label = entry && entry.id ? entry.id : JSON.stringify(entry);
    if (!entry.id || typeof entry.id !== "string") {
      problems.push(`${label}: missing a stable string id`);
    } else if (seenIds.has(entry.id)) {
      problems.push(`${entry.id}: duplicate id`);
    } else {
      seenIds.add(entry.id);
    }

    if (!TIERS.includes(entry.tier)) {
      problems.push(`${label}: tier must be one of ${TIERS.join(", ")}, got ${JSON.stringify(entry.tier)}`);
    }
    if (!entry.script || typeof entry.script !== "string") {
      problems.push(`${label}: missing the script path it applies to`);
    } else if (seenScripts.has(entry.script)) {
      problems.push(`${label}: a second entry claims ${entry.script}`);
    } else {
      seenScripts.add(entry.script);
      if (!fs.existsSync(path.join(REPO, entry.script))) {
        problems.push(`${label}: ${entry.script} does not exist`);
      }
    }

    if (!Array.isArray(entry.databases)) {
      problems.push(`${label}: databases must be an array (empty is allowed and means "none")`);
    } else {
      for (const name of entry.databases) {
        if (!DATABASE_NAMES.includes(name)) {
          problems.push(`${label}: unknown database ${JSON.stringify(name)}`);
        }
      }
    }

    if (typeof entry.seed_profile !== "string" || !entry.seed_profile) {
      problems.push(`${label}: seed_profile must be a named profile, or "empty"`);
    }

    // The second declared exception to "commands are independent": a generator whose output a later
    // command consumes blocks its declared dependents, and only those. Declared, never inferred --
    // and validated here, because a `blocks` list naming an id that does not exist would silently
    // block nothing at all.
    if (entry.blocks !== undefined) {
      if (!Array.isArray(entry.blocks) || entry.blocks.length === 0) {
        problems.push(`${label}: blocks must be a non-empty array of entry ids, or be absent`);
      }
    }

    // A declared platform: the ONLY licence a Tier F command has to be skipped (run-harness.js), so the
    // set is closed and Tier C, whose licence is its corpus, may not borrow it.
    if (entry.platform !== undefined) {
      if (!PLATFORMS.includes(entry.platform)) {
        problems.push(`${label}: platform must be one of ${PLATFORMS.join(", ")}, got ` +
          `${JSON.stringify(entry.platform)}`);
      }
      if (entry.tier !== "F") problems.push(`${label}: only tier F may declare a platform`);
    }

    problems.push(...validateRequires(label, entry));

    // Tier C's whole licence to skip is its corpus declaration. Without it a skip has no stated
    // reason, and an unexplained skip is indistinguishable from a silently disabled test.
    //
    // P1.2 CHANGED WHAT A DECLARATION IS. It used to be `detect`: a list of candidate paths the runner
    // searched. That is rejected outright now rather than merely ignored -- a lingering `detect` would
    // otherwise read like a working declaration to anyone editing this file, and a path list is exactly
    // the thing that let a command run against an unidentified database. The declaration is now
    // `corpus_ids`: named entries in the reviewed registry, resolved through one active snapshot set.
    if (entry.tier === "C") {
      if (!entry.corpus || typeof entry.corpus !== "object") {
        problems.push(`${label}: tier C requires a corpus declaration`);
      } else {
        if (!entry.corpus.description) problems.push(`${label}: corpus needs a description`);
        if (entry.corpus.detect !== undefined) {
          problems.push(`${label}: corpus.detect is the legacy path-search form and is no longer ` +
            `honoured; declare corpus_ids naming registry entries instead`);
        }
        if (!Array.isArray(entry.corpus.corpus_ids) || entry.corpus.corpus_ids.length === 0) {
          problems.push(`${label}: corpus needs a non-empty corpus_ids array naming registry entries`);
        } else {
          const seenCorpora = new Set();
          for (const id of entry.corpus.corpus_ids) {
            if (typeof id !== "string" || !id) {
              problems.push(`${label}: corpus_ids entries must be non-empty strings`);
            } else if (seenCorpora.has(id)) {
              problems.push(`${label}: corpus_ids names ${id} twice`);
            } else {
              seenCorpora.add(id);
              if (!knownCorpusIds.has(id)) {
                problems.push(`${label}: corpus_ids names ${JSON.stringify(id)}, which is not in the ` +
                  `corpus registry (known: ${[...knownCorpusIds].join(", ") || "none"})`);
              }
            }
          }
        }
      }
    } else if (entry.corpus) {
      problems.push(`${label}: only tier C may declare a corpus`);
    }
  }

  // Cross-entry check, only possible once every id is known: a `blocks` list must name real entries.
  for (const entry of manifest.entries) {
    for (const id of entry.blocks || []) {
      if (!seenIds.has(id)) {
        problems.push(`${entry.id}: blocks unknown entry id ${JSON.stringify(id)}`);
      } else if (id === entry.id) {
        problems.push(`${entry.id}: blocks itself`);
      }
    }
  }

  return problems;
}

function validateRequires(label, entry) {
  const problems = [];
  if (entry.requires === undefined) return [`${label}: requires must be present (use [] for none)`];
  if (!Array.isArray(entry.requires)) return [`${label}: requires must be an array`];

  for (const clause of entry.requires) {
    const where = clause && clause.table ? `${label}/${clause.table}` : label;
    if (!DATABASE_NAMES.includes(clause.database)) {
      problems.push(`${where}: unknown database ${JSON.stringify(clause.database)}`);
    } else if (Array.isArray(entry.databases) && !entry.databases.includes(clause.database)) {
      problems.push(`${where}: requires ${clause.database} but does not declare it in databases`);
    }
    if (!clause.table || typeof clause.table !== "string") {
      problems.push(`${where}: a requires clause needs a table`);
    }
    const hasRowFloor = Number.isInteger(clause.min_rows) && clause.min_rows > 0;
    const hasNonNull = Array.isArray(clause.non_null) && clause.non_null.length > 0;
    if (!hasRowFloor && !hasNonNull) {
      problems.push(`${where}: a requires clause must demand min_rows > 0 or non_null columns, ` +
        `otherwise it asserts nothing`);
    }
    if (clause.where !== undefined && typeof clause.where !== "string") {
      problems.push(`${where}: where must be a SQL fragment string`);
    }
  }
  return problems;
}

/**
 * Join the manifest to the DERIVED harness plan.
 *
 * Both directions are reported, because both are defects:
 *   `undeclared` -- a command the manifest does not cover. It would run with whatever databases
 *                   happen to be on disk, which is the pre-P1.1 behaviour.
 *   `stale`      -- a manifest entry for a command the harness no longer runs. Left alone it becomes
 *                   a declaration nobody checks.
 */
function reconcile(manifest, commands) {
  const byScript = new Map();
  for (const entry of manifest.entries) byScript.set(entry.script, entry);

  const matched = [];
  const undeclared = [];
  const usedScripts = new Set();

  for (const command of commands) {
    const entry = command.script ? byScript.get(command.script) : undefined;
    if (entry) {
      usedScripts.add(command.script);
      matched.push({ command, entry });
    } else {
      undeclared.push(command);
    }
  }

  const stale = manifest.entries
    .filter((entry) => !usedScripts.has(entry.script))
    .map((entry) => entry.id);

  return { matched, undeclared, stale };
}

/**
 * `corpusAvailability()` USED TO LIVE HERE and was deleted by P1.2, deliberately rather than left
 * unused. It answered "does a non-empty file exist at one of these candidate paths?" -- a detector that
 * could not distinguish a reviewed snapshot from a leftover, and whose "available" verdict was enough
 * to run a Tier C command against it.
 *
 * Its replacement is `verifyCorpusSet()` in `./corpus-verification.js`, which resolves ONE active set
 * through `CDA_CORPUS_DIR/active.json` and returns database paths only after a passed verification
 * against reviewed registry expectation.
 *
 * It is deleted rather than deprecated because a permissive fallback that still exports cleanly is a
 * fallback something will eventually call. The zero-byte lesson it encoded -- a 0-byte file resolves as
 * a real database through `fs.existsSync` alone, which is why detector D6 silently never fired -- is
 * preserved as `REASON.EMPTY` in `verifyArtifact`, where it now rejects rather than merely reports.
 */

module.exports = {
  MANIFEST_PATH,
  TIERS,
  PLATFORMS,
  loadManifest,
  validateManifest,
  validateRequires,
  reconcile,
};
