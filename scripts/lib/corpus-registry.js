/**
 * The corpus registry: reviewed, declared truth about the Tier C canonical corpora.
 *
 * WHY THE EXPECTED FINGERPRINT LIVES HERE and not in a snapshot manifest: comparing a database against
 * a fingerprint recorded during its own acquisition is circular. It restates the file hash and cannot
 * reject a wrong schema. Expectation must be reviewed material, observation must be separate, and
 * verification compares the two.
 *
 * WHY `forbidden_remote` IS DECLARED rather than simply omitted: five variants of the RTCI path exist on
 * the production host, and `/opt/nibrs/app/crime_data.db` is recorded in this repository as the stale
 * one that caused a real divergence. Declaring the forbidden paths makes their reappearance a test
 * failure instead of a code review someone might miss.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REGISTRY_PATH = path.join(__dirname, "..", "fixtures", "corpus-registry.json");

function loadRegistry(file) {
  const parsed = JSON.parse(fs.readFileSync(file || REGISTRY_PATH, "utf8"));
  const problems = validateRegistry(parsed);
  if (problems.length) {
    throw new Error("corpus registry is invalid:\n  " + problems.join("\n  "));
  }
  return parsed;
}

function validateRegistry(registry) {
  const problems = [];
  if (!registry || !Array.isArray(registry.corpora)) {
    return ["registry must be an object with a `corpora` array"];
  }

  const seen = new Set();
  for (const corpus of registry.corpora) {
    const label = corpus && corpus.id ? corpus.id : JSON.stringify(corpus);
    if (!corpus.id || typeof corpus.id !== "string") problems.push(`${label}: missing a string id`);
    else if (seen.has(corpus.id)) problems.push(`${corpus.id}: duplicate id`);
    else seen.add(corpus.id);

    if (!corpus.env) problems.push(`${label}: missing the env var that redirects it`);

    if (!corpus.authoritative_remote) {
      problems.push(`${label}: missing authoritative_remote`);
    }
    if (!Array.isArray(corpus.forbidden_remote)) {
      problems.push(`${label}: forbidden_remote must be an array (empty is allowed)`);
    } else if (corpus.forbidden_remote.includes(corpus.authoritative_remote)) {
      // The contradiction that would silently disable a corpus, so it is rejected outright.
      problems.push(`${label}: authoritative_remote is also listed as forbidden`);
    }

    if (!Array.isArray(corpus.required_tables) || corpus.required_tables.length === 0) {
      problems.push(`${label}: required_tables must be a non-empty array`);
    }
    for (const [table, floor] of Object.entries(corpus.row_floors || {})) {
      if (!Number.isInteger(floor) || floor <= 0) {
        problems.push(`${label}: row floor for ${table} must be a positive integer`);
      }
      if (Array.isArray(corpus.required_tables) && !corpus.required_tables.includes(table)) {
        problems.push(`${label}: row floor for ${table}, which is not a required table`);
      }
    }

    // Either a reviewed fingerprint, or an explicit admission that there is not one yet. Silence is
    // the one thing not allowed, because a null fingerprint with no flag reads like "no constraint".
    const hasFingerprint = typeof corpus.expected_schema_fingerprint === "string"
      && corpus.expected_schema_fingerprint.startsWith("sha256:");
    if (!hasFingerprint && corpus.bootstrap_pending !== true) {
      problems.push(`${label}: no reviewed expected_schema_fingerprint and bootstrap_pending is not ` +
        `true -- a corpus must either carry a reviewed expectation or admit it has none`);
    }
    if (hasFingerprint && corpus.bootstrap_pending === true) {
      problems.push(`${label}: has a reviewed fingerprint but is still marked bootstrap_pending`);
    }
  }
  return problems;
}

function corpusById(registry, id) {
  const corpus = registry.corpora.find((c) => c.id === id);
  if (!corpus) throw new Error(`unknown corpus: ${id}`);
  return corpus;
}

/** Paths a corpus declaration must never name. Used by the contract regression. */
function forbiddenPaths(registry) {
  const all = new Map();
  for (const corpus of registry.corpora) {
    for (const forbidden of corpus.forbidden_remote || []) all.set(forbidden, corpus.id);
  }
  return all;
}

module.exports = { REGISTRY_PATH, loadRegistry, validateRegistry, corpusById, forbiddenPaths };
