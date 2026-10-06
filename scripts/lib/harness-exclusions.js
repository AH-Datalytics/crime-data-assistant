/**
 * The single source of truth for test-shaped files that are DELIBERATELY not in the correctness chain.
 *
 * WHY A REGISTRY AND NOT A COMMENT. A test-shaped file that nothing runs is invisible to the harness:
 * not `undeclared`, not `stale`, just absent. The fix is not to run everything -- some of these files
 * contact a deployment, some produce grades rather than a verdict, one is red for a reason that needs a
 * product decision. The fix is that every one of them is named, classified, and owned, in a place a
 * reviewer can read, so "not run" is a declaration rather than an oversight.
 *
 * WHY STRUCTURE RATHER THAN PROSE. Revision 1 required each exclusion's reason to be unique prose. That
 * was a proxy for review quality, not a property: two network checks may legitimately share a reason,
 * and adding a comma makes copied boilerplate "unique". So the guarantee is carried by a closed `kind`
 * set, a closed `reason_code` set that must be VALID FOR THAT KIND, and a required non-empty
 * `follow_up` on anything quarantined -- which is what stops a quarantine becoming permanent by
 * neglect.
 *
 * THE BOTH-PLACES RULE lives in the discovery check rather than here, because it needs the manifest and
 * the derived plan; this module only refuses an entry whose path is already in the tier manifest.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..");
const EXCLUSIONS_PATH = path.join(REPO, "scripts", "fixtures", "harness-exclusions.json");

/**
 * The closed sets.
 *
 * The contract named the `kind` set exactly, and gave reason codes for `diagnostic`,
 * `network-optional` and `quarantined` as examples. The codes for `benchmark`, `helper` and `obsolete`
 * are supplied here so the set is genuinely closed rather than closed-for-three-kinds -- an
 * "e.g." list would have let any string through for the other three. Adding a code is a deliberate
 * edit to this table, which is the point.
 *
 * `platform-specific` is the one kind whose files ARE required tests. They are outside this chain only
 * because the chain runs on Windows and they need Linux (flock, /proc, process groups); the required
 * `linux release build` workflow (.github/workflows/linux-release-build.yml) runs them instead, which
 * test-harness-discovery.js checks by name. The Windows tally never claims to have executed them.
 */
const REASON_CODES = {
  diagnostic: ["no_success_criterion", "external_unversioned_input", "writes_report"],
  "network-optional": ["contacts_deployment", "model_nondeterministic", "wallclock_threshold"],
  benchmark: ["measures_performance", "wallclock_threshold"],
  helper: ["not_a_test", "shared_fixture_only"],
  obsolete: ["superseded", "dead_code"],
  quarantined: ["currently_failing", "stale_expectation", "pending_product_decision"],
  "platform-specific": ["linux_required_ci"],
};

const KINDS = Object.keys(REASON_CODES);

/** Exactly these fields. Anything else is refused -- see `corpus_ids` below. */
const ALLOWED_FIELDS = ["path", "kind", "reason_code", "detail", "owner", "follow_up"];

/** Kinds that must never appear in the tier manifest, whatever else is true of them. */
const NEVER_IN_MANIFEST = ["network-optional", "quarantined"];

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate the registry.
 *
 * `options.discovered` and `options.manifestScripts` are injectable so a unit test can validate a
 * one-entry registry without standing up the whole tree; left unset, the real discovery walk and the
 * real tier manifest are the authority.
 */
function validateExclusions(registry, options) {
  const opts = options || {};
  const problems = [];

  if (!registry || typeof registry !== "object" || !Array.isArray(registry.entries)) {
    return ["exclusion registry must be an object with an `entries` array"];
  }

  const repo = opts.repo || REPO;
  const discovered = opts.discovered
    ? new Set(opts.discovered)
    : new Set(require("./orphan-discovery.js").discoverTestShaped(repo));
  const manifestScripts = opts.manifestScripts
    ? new Set(opts.manifestScripts)
    : new Set(require("./tier-manifest.js").loadManifest().entries.map((e) => e.script));

  const seenPaths = new Set();
  for (const entry of registry.entries) {
    const label = entry && entry.path ? entry.path : JSON.stringify(entry);

    if (!entry || typeof entry !== "object") {
      problems.push(`${label}: entry must be an object`);
      continue;
    }

    // Unknown fields are refused rather than ignored. `corpus_ids` is the case the contract calls out:
    // Tier C means "declares registry corpora", so a corpus declaration on an EXCLUDED file would be
    // Tier C leaking into a place that never runs -- and silently ignoring it would let the confusion
    // sit in the file looking meaningful.
    for (const field of Object.keys(entry)) {
      if (!ALLOWED_FIELDS.includes(field)) {
        problems.push(`${label}: unknown field ${JSON.stringify(field)} `
          + `(allowed: ${ALLOWED_FIELDS.join(", ")})`);
      }
    }

    if (!nonEmptyString(entry.path)) {
      problems.push(`${label}: path must be a non-empty string`);
    } else {
      if (seenPaths.has(entry.path)) {
        problems.push(`${entry.path}: a second entry claims this path`);
      }
      seenPaths.add(entry.path);

      if (!fs.existsSync(path.join(repo, entry.path))) {
        problems.push(`${entry.path}: does not exist on disk`);
      }
      if (!discovered.has(entry.path)) {
        problems.push(`${entry.path}: is not discovered by the test-shaped rule, so excluding it `
          + `from the chain declares nothing`);
      }
      if (manifestScripts.has(entry.path)) {
        problems.push(`${entry.path}: is also declared in the tier manifest -- a file cannot be both `
          + `registered and excluded`);
      }
    }

    if (!KINDS.includes(entry.kind)) {
      problems.push(`${label}: kind must be one of ${KINDS.join(", ")}, `
        + `got ${JSON.stringify(entry.kind)}`);
    } else {
      const valid = REASON_CODES[entry.kind];
      if (!nonEmptyString(entry.reason_code)) {
        problems.push(`${label}: reason_code must be a non-empty string`);
      } else if (!valid.includes(entry.reason_code)) {
        problems.push(`${label}: reason_code ${JSON.stringify(entry.reason_code)} is not valid for `
          + `kind ${entry.kind} (valid: ${valid.join(", ")})`);
      }
    }

    if (!nonEmptyString(entry.detail)) {
      problems.push(`${label}: detail must be a non-empty human explanation`);
    }
    if (!nonEmptyString(entry.owner)) {
      problems.push(`${label}: owner must be non-empty`);
    }

    // The anti-neglect rule. A quarantine with no named way out is a permanent exclusion wearing a
    // temporary label.
    if (entry.kind === "quarantined") {
      if (!nonEmptyString(entry.follow_up)) {
        problems.push(`${label}: a quarantined entry requires a non-empty follow_up naming the `
          + `bounded increment that removes the quarantine`);
      }
    } else if (entry.follow_up !== undefined && !nonEmptyString(entry.follow_up)) {
      problems.push(`${label}: follow_up, when present, must be non-empty`);
    }
  }

  return problems;
}

function loadExclusions(file, options) {
  const target = file || EXCLUSIONS_PATH;
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  const problems = validateExclusions(parsed, options);
  if (problems.length) {
    throw new Error("exclusion registry is invalid:\n  " + problems.join("\n  "));
  }
  return parsed;
}

/** Paths only, for the partition. */
function exclusionPaths(registry) {
  return registry.entries.map((e) => e.path);
}

module.exports = {
  EXCLUSIONS_PATH,
  KINDS,
  REASON_CODES,
  ALLOWED_FIELDS,
  NEVER_IN_MANIFEST,
  validateExclusions,
  loadExclusions,
  exclusionPaths,
};
