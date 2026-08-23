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

const REPO = path.join(__dirname, "..", "..");
const MANIFEST_PATH = path.join(REPO, "scripts", "fixtures", "harness-tier-manifest.json");

const TIERS = ["F", "C"];

function loadManifest(file) {
  const source = fs.readFileSync(file || MANIFEST_PATH, "utf8");
  const parsed = JSON.parse(source);
  const problems = validateManifest(parsed);
  if (problems.length) {
    throw new Error("tier manifest is invalid:\n  " + problems.join("\n  "));
  }
  return parsed;
}

function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.entries)) {
    return ["manifest must be an object with an `entries` array"];
  }

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

    problems.push(...validateRequires(label, entry));

    // Tier C's whole licence to skip is its corpus declaration. Without it a skip has no stated
    // reason, and an unexplained skip is indistinguishable from a silently disabled test.
    if (entry.tier === "C") {
      if (!entry.corpus || typeof entry.corpus !== "object") {
        problems.push(`${label}: tier C requires a corpus declaration`);
      } else {
        if (!entry.corpus.description) problems.push(`${label}: corpus needs a description`);
        if (!Array.isArray(entry.corpus.detect) || entry.corpus.detect.length === 0) {
          problems.push(`${label}: corpus needs a non-empty detect list of candidate paths`);
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

/** Is a Tier C entry's canonical corpus present? Returns {available, found, reason}. */
function corpusAvailability(entry) {
  const detect = (entry.corpus && entry.corpus.detect) || [];
  for (const candidate of detect) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.join(REPO, candidate);
    if (!fs.existsSync(resolved)) continue;
    // A zero-byte stub resolves as a real database through `fs.existsSync` alone -- the recorded
    // cause of detector D6 silently never firing. Treat it as absent here rather than certifying
    // against it. This is the preflight's own judgement and changes no production behaviour.
    if (fs.statSync(resolved).size === 0) {
      return {
        available: false,
        found: resolved,
        reason: `canonical corpus candidate ${candidate} exists but is 0 bytes`,
      };
    }
    return { available: true, found: resolved, reason: null };
  }
  return {
    available: false,
    found: null,
    reason: `no canonical corpus present (looked for: ${detect.join(", ") || "nothing declared"})`,
  };
}

module.exports = {
  MANIFEST_PATH,
  TIERS,
  loadManifest,
  validateManifest,
  validateRequires,
  reconcile,
  corpusAvailability,
};
