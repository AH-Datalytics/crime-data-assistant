/**
 * Shadow-period proof reporting for the daily digest.
 *
 * Handoff §9.1 Stage 1: "Add digest-email reporting for pass/failure/unknown rates by
 * tab and plan family." §14.1: the daily mail carries "audit health, source/family
 * coverage, would-answer/would-narrow/would-clarify/would-decline counts".
 *
 * THREE RULES THIS MODULE EXISTS TO KEEP.
 *
 *   COVERAGE IS REPORTED BEFORE RATES. A pass rate computed over the rows that happen
 *   to carry a proof record says nothing if most rows carry none. Every table here
 *   leads with how many rows were eligible and how many were actually evaluated, and
 *   a run where nothing was evaluated says so instead of showing an empty clean table.
 *   This is the D6 lesson -- a detector reported "0 flagged" for weeks while its
 *   reference database was a 0-byte stub -- applied to the shadow numbers themselves.
 *
 *   WHAT WAS DELIVERED AND WHAT WAS PROVEN ARE SEPARATE COLUMNS. In shadow,
 *   delivery_action records what the user actually received, which is `answer` for
 *   essentially every row. hypotheticalAction records what the contract would have
 *   permitted. Collapsing them would make the shadow period look like a success.
 *
 *   PLAIN LANGUAGE. The reader is a human deciding whether a family is ready to
 *   enforce, not a machine. "would have declined" beats "hypothetical_action=
 *   decline_capability".
 *
 * Written as CommonJS because scripts/daily-query-analysis.js is a plain node script
 * with no build step, and adding one for a reporting section is not worth it.
 */

/** Columns this report needs, added to the digest's SELECT only when they exist. */
const PROOF_COLUMNS = [
  "delivery_action",
  "proof_manifest",
  "proof_mode",
  "plan_family",
];

/** The digest's own filter for real human traffic; mirrored so counts agree. */
function selectClause(existingColumns) {
  return PROOF_COLUMNS.map((column) =>
    existingColumns.has(column) ? column : `NULL AS ${column}`,
  ).join(", ");
}

/**
 * The v1 proof checks and states, restated from lib/proof-contract.ts.
 *
 * Restated rather than imported because this file is CommonJS loaded by
 * scripts/daily-query-analysis.js, a plain node script with no build step. The
 * duplication is made safe by a drift guard in scripts/test-proof-shadow-report.ts, which
 * CAN import the TypeScript and fails if these lists ever diverge -- so adding a proof
 * check cannot silently leave the reporter grading a stale map as complete.
 */
const DECLARED_CHECKS = [
  "semanticPlan",
  "canonicalGeographies",
  "entityCompleteness",
  "metric",
  "grain",
  "timeRange",
  "missingness",
  "reconciliation",
  "claims",
  "chartData",
];

const VALID_CHECK_STATES = new Set(["passed", "failed", "not_applicable", "unknown"]);

/** PROOF_MANIFEST_VERSION, restated here for the same reason and under the same guard. */
const MANIFEST_VERSION = 1;

/**
 * Whether this is a complete v1 check map, and therefore gradable.
 *
 * THE ARRAY CASE IS THE POINT. `typeof [] === "object"` in JavaScript, so a plain typeof
 * guard accepted `{"checks":[]}` and graded it -- zero check states, counted as evaluated,
 * indistinguishable from a clean answer. `{"checks":{}}` and any partial map did the same.
 * Requiring every declared check to be present with a recognized state means an incomplete
 * map is reported as a writer defect instead of contributing a silent clean row.
 *
 * Unrecognized EXTRA keys are tolerated deliberately: a future check added upstream should
 * degrade to being counted, not make every envelope malformed. The drift guard is what
 * surfaces that case as work to do.
 */
function isCompleteCheckMap(checks) {
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) return false;
  for (const name of DECLARED_CHECKS) {
    if (!VALID_CHECK_STATES.has(checks[name])) return false;
  }
  return true;
}

/**
 * The proof modes that are actually persisted, from lib/proof-modes' isObserving.
 *
 * `off` writes EMPTY_PROOF_LOG_FIELDS, so a row whose proof_mode is `off` -- or any
 * unrecognized string -- is not an observed row. Treating any truthy value as coverage let
 * `proof_mode: "garbage"` with no envelope report withProof === rows, and therefore
 * "complete observation", which is the worst possible thing this email can get wrong.
 */
const OBSERVING_MODES = new Set(["shadow", "enforce"]);

/** DELIVERY_ACTIONS, restated for the same reason and under the same drift guard. */
const DECLARED_ACTIONS = new Set([
  "answer",
  "answer_limited_scope",
  "clarify",
  "decline_capability",
  "decline_data",
  "decline_source_health",
]);

/**
 * A unique array of declared check names, or null if this is not one.
 *
 * `for (const x of {})` THROWS, and daily-query-analysis.js renders this section inline, so
 * that throw aborted the entire digest -- a direct breach of invariant 15, which says the
 * existing digest continues independently of the proof pipeline. A string was worse than a
 * throw because it was silent: blockingChecks "metric" iterated per character and invented
 * six blockers named m, e, t, r, i and c.
 */
function decodeBlockingChecks(value) {
  if (!Array.isArray(value)) return null;
  const seen = [];
  for (const name of value) {
    if (typeof name !== "string" || !DECLARED_CHECKS.includes(name)) return null;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * Decode one query_log row into exactly one validated outcome.
 *
 * WHY A DECODER RATHER THAN CHECKS SCATTERED THROUGH THE TALLY. Four separate defects came
 * from tallying fields that had never been validated: a non-iterable blocker list threw, an
 * undeclared hypothetical action invented a bucket, an unrecognized proof mode counted as
 * coverage, and a reduced envelope's blockers were dropped. Validating once, up front, and
 * returning a closed set of kinds means the tally cannot encounter an unexpected shape at
 * all -- and this function is total: every input returns a kind, none throws.
 *
 * Returns `{ kind, delivered, ... }`. `delivered` is what the user actually received and is
 * recorded for every observed row regardless of the envelope's state.
 */
function decodeRow(row) {
  if (typeof row.proof_mode !== "string" || !OBSERVING_MODES.has(row.proof_mode)) {
    return { kind: "not_observed" };
  }
  // An unrecognized delivery action is reported as "not recorded" rather than passed
  // through, so a stray value cannot become a label in the email.
  const delivered = DECLARED_ACTIONS.has(row.delivery_action) ? row.delivery_action : "unrecorded";
  const base = { delivered };

  if (!row.proof_manifest) return { ...base, kind: "envelope_missing" };

  let envelope;
  try {
    envelope = JSON.parse(row.proof_manifest);
  } catch {
    // A malformed envelope is itself a finding: the writer bounded the fields wrongly, or
    // the column was truncated. Counted rather than silently skipped.
    return { ...base, kind: "unparseable" };
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ...base, kind: "malformed" };
  }

  // EXACT boolean discriminants. `envelopeReduced: "yes"` is not a reduced envelope, and a
  // record claiming to be both fallbacks at once is not either of them.
  const isError = envelope.envelopeError === true;
  const isReduced = envelope.envelopeReduced === true;
  if (isError && isReduced) return { ...base, kind: "malformed" };

  /**
   * VERSION BEFORE MEANING. Every declared shape records its schema version -- the two
   * fallbacks at the top level, a full envelope at manifest.v -- and it must be checked
   * before any shape is interpreted, because everything after this is v1 semantics.
   *
   * Missing and mismatched are different findings: no declared shape omits the version, so
   * an absent one is a writer defect, while a present-but-different one is ordinary skew
   * during a rolling deploy and gets its own category.
   */
  const manifest = envelope.manifest && typeof envelope.manifest === "object" && !Array.isArray(envelope.manifest)
    ? envelope.manifest
    : null;
  const version = isError || isReduced ? envelope.v : manifest ? manifest.v : undefined;
  if (version === undefined || version === null) return { ...base, kind: "malformed" };
  if (version !== MANIFEST_VERSION) return { ...base, kind: "incompatible_version" };

  if (isError) return { ...base, kind: "error" };

  const action = DECLARED_ACTIONS.has(envelope.hypotheticalAction) ? envelope.hypotheticalAction : null;
  const blockingChecks = decodeBlockingChecks(envelope.blockingChecks);

  if (isReduced) {
    // Reduced carries no manifest by design, but it does carry the action and the blockers,
    // and both must be valid before either is counted.
    if (action === null || blockingChecks === null) return { ...base, kind: "malformed" };
    return { ...base, kind: "reduced", action, blockingChecks };
  }

  if (!manifest || !isCompleteCheckMap(manifest.checks) || action === null || blockingChecks === null) {
    return { ...base, kind: "malformed" };
  }
  return { ...base, kind: "evaluated", action, checks: manifest.checks, blockingChecks };
}

/** Human-readable label for a terminal action. */
function actionLabel(action) {
  switch (action) {
    case "answer": return "answered";
    case "answer_limited_scope": return "answered, narrower scope";
    case "clarify": return "asked for clarification";
    case "decline_capability": return "declined — no supported path";
    case "decline_data": return "declined — source lacks the data";
    case "decline_source_health": return "declined — source health";
    default: return "not recorded";
  }
}

function emptyTally() {
  return {
    rows: 0,
    withProof: 0,
    /**
     * Rows that carried a manifest with checks in it -- the only correct denominator for
     * a check-state rate.
     *
     * withProof is NOT that denominator. A row can be observed and still arrive here
     * with nothing to grade: the envelope was never written, it was corrupted, it shed its
     * manifest under the size limit, the serializer could not build one at all, what was
     * stored is not a shape the serializer ever declares, or it was written under a
     * different schema version. All six are counted separately below rather than folded
     * in, because an envelope that silently contributes zero check states is
     * indistinguishable from a clean record -- the D6 failure shape one layer in, where
     * "nothing flagged" really means "nothing was looked at".
     */
    evaluated: 0,
    /** Observed, but no envelope was written at all. */
    envelopeMissing: 0,
    /** Envelope present but not parseable -- a defect in the writer, not the traffic. */
    unparseable: 0,
    /** Envelope shed its manifest to fit the column, so its checks are unrecoverable. */
    reduced: 0,
    /**
     * The serializer could not build an envelope at all and wrote { v, envelopeError }.
     *
     * Distinct from `reduced`: a reduced envelope still says what the contract would have
     * done, whereas this one carries nothing but a version. Neither is gradable.
     */
    envelopeError: 0,
    /**
     * Parseable, but not any shape the serializer declares -- `{}`, `{v:1}`,
     * `{manifest:null}`. A writer defect, and ungradable like the four above it.
     */
    malformed: 0,
    /**
     * Written under a different schema version, so it cannot be read with v1 semantics.
     *
     * Kept apart from `malformed` because this is expected during a rolling deploy -- a
     * newer writer's rows landing in an older reporter's window -- and reporting normal
     * skew as a defect would cry wolf on every release.
     */
    incompatibleVersion: 0,
    delivered: {},
    wouldHave: {},
    checks: { passed: 0, failed: 0, unknown: 0, not_applicable: 0 },
    blockedByCheck: {},
  };
}

function tallyRow(tally, row) {
  tally.rows += 1;
  const decoded = decodeRow(row);
  if (decoded.kind === "not_observed") return;

  tally.withProof += 1;
  tally.delivered[decoded.delivered] = (tally.delivered[decoded.delivered] || 0) + 1;

  // Every branch below works on VALIDATED data, so nothing here can throw on a hostile
  // value and no bucket can be invented from one.
  switch (decoded.kind) {
    case "envelope_missing":
      tally.envelopeMissing += 1;
      return;
    case "unparseable":
      tally.unparseable += 1;
      return;
    case "malformed":
      tally.malformed += 1;
      return;
    case "incompatible_version":
      tally.incompatibleVersion += 1;
      return;
    case "error":
      // Carries only { v, envelopeError }: no action to credit, no blockers to tally.
      tally.envelopeError += 1;
      return;
    case "reduced":
      tally.wouldHave[decoded.action] = (tally.wouldHave[decoded.action] || 0) + 1;
      // Blockers ARE tallied here. The serializer preserves blockingChecks in the reduced
      // rung precisely because they are its most diagnostic field, and returning early
      // undercounted every oversized record in "What blocked delivery most often".
      for (const name of decoded.blockingChecks) {
        tally.blockedByCheck[name] = (tally.blockedByCheck[name] || 0) + 1;
      }
      tally.reduced += 1;
      return;
    case "evaluated":
      tally.wouldHave[decoded.action] = (tally.wouldHave[decoded.action] || 0) + 1;
      tally.evaluated += 1;
      for (const state of Object.values(decoded.checks)) {
        if (tally.checks[state] !== undefined) tally.checks[state] += 1;
      }
      for (const name of decoded.blockingChecks) {
        tally.blockedByCheck[name] = (tally.blockedByCheck[name] || 0) + 1;
      }
      return;
    default:
      // Unreachable while decodeRow returns only the kinds above; counted rather than
      // thrown so a future kind cannot abort the digest.
      tally.malformed += 1;
      return;
  }
}

/**
 * Build the report from the window's rows.
 *
 * `isHuman` is the digest's own predicate, passed in rather than duplicated, so this
 * section counts exactly the traffic the rest of the email counts.
 */
function buildProofShadowReport(queries, isHuman) {
  const overall = emptyTally();
  const byTab = new Map();
  const byFamily = new Map();

  for (const row of queries) {
    if (!isHuman(row)) continue;
    tallyRow(overall, row);

    const tab = row.tab || "unknown";
    if (!byTab.has(tab)) byTab.set(tab, emptyTally());
    tallyRow(byTab.get(tab), row);

    // Only rows that actually recorded a family are grouped by one. A row with no
    // family is not "family: none" -- it is a row the proof system did not classify,
    // and lumping those together would invent a family-shaped bucket.
    if (row.plan_family) {
      if (!byFamily.has(row.plan_family)) byFamily.set(row.plan_family, emptyTally());
      tallyRow(byFamily.get(row.plan_family), row);
    }
  }

  return { overall, byTab, byFamily };
}

/**
 * Whether these numbers may be presented as a result at all.
 *
 * Mirrors lib/audit-health's cleanReportPermitted: zero evaluated rows is not a clean
 * shadow period, it is an absent one.
 */
function shadowHealth(report) {
  const { rows, withProof } = report.overall;
  if (rows === 0) {
    return { state: "no_traffic", note: "No human queries in this window, so there is nothing to report." };
  }
  if (withProof === 0) {
    return {
      state: "not_observing",
      note:
        `${rows} human quer${rows === 1 ? "y" : "ies"} in this window and none carries a proof record. ` +
        "The proof system is off, or the release carrying it is not deployed. " +
        "This is not a clean result — it is an absent one.",
    };
  }
  if (withProof < rows) {
    return {
      state: "partial",
      note:
        `${withProof} of ${rows} human queries carry a proof record. The rest ran on a ` +
        "release or configuration where the proof system was not observing; rates below " +
        "describe only the evaluated subset.",
    };
  }
  return { state: "complete", note: `All ${rows} human queries in this window carry a proof record.` };
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countsRow(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "<span class=\"quiet\">none</span>";
  return entries.map(([key, n]) => `${escapeHtml(actionLabel(key))}: <strong>${n}</strong>`).join(" &middot; ");
}

/**
 * Check states for one bucket, with the pass rate suppressed when nothing was graded.
 *
 * §9.1 Stage 1 asks for "pass/failure/unknown rates by tab and plan family". A rate over
 * zero graded checks is not 0% and not 100%; it is undefined, and printing either would
 * be the single most misleading number in this email. So the cell says what was actually
 * available instead.
 */
function checksCell(tally) {
  const notEvaluated = tally.envelopeMissing + tally.unparseable + tally.reduced + tally.envelopeError + tally.malformed + tally.incompatibleVersion;
  const detail = [];
  if (tally.envelopeMissing > 0) detail.push(`no envelope: ${tally.envelopeMissing}`);
  if (tally.unparseable > 0) detail.push(`unreadable: ${tally.unparseable}`);
  if (tally.reduced > 0) detail.push(`reduced, checks lost: ${tally.reduced}`);
  if (tally.envelopeError > 0) detail.push(`could not be built: ${tally.envelopeError}`);
  if (tally.malformed > 0) detail.push(`malformed: ${tally.malformed}`);
  if (tally.incompatibleVersion > 0) detail.push(`newer schema, not readable here: ${tally.incompatibleVersion}`);
  const suffix = detail.length > 0 ? ` <span class="quiet">(${detail.join(" &middot; ")})</span>` : "";

  if (tally.evaluated === 0) {
    const why = notEvaluated > 0
      ? "no gradable record"
      : "not observed";
    return `<span class="quiet">${why}</span>${suffix}`;
  }

  const { passed, failed, unknown } = tally.checks;
  const graded = passed + failed + unknown;
  const parts = [`passed ${passed}`, `failed ${failed}`, `could not tell ${unknown}`];
  // "not applicable" is deliberately excluded from the denominator: a check that did not
  // apply was not a question this answer had to survive.
  const rate = graded > 0 ? ` &mdash; ${Math.round((passed / graded) * 100)}% of graded checks passed` : "";
  return `${parts.join(" &middot; ")}${rate}${suffix}`;
}

function tallyTable(title, entries) {
  if (entries.length === 0) return "";
  let html = `<h3>${escapeHtml(title)}</h3><table><tr><th>${escapeHtml(title)}</th><th>Evaluated</th><th>Checks</th><th>Would have been delivered</th></tr>`;
  for (const [name, tally] of entries) {
    // Coverage leads, and now distinguishes "carried a proof record" from "could actually
    // be graded" -- the two diverge exactly when an envelope was lost or shed.
    const coverage = tally.withProof === tally.rows
      ? `${tally.withProof}`
      : `${tally.withProof} of ${tally.rows}`;
    const graded = tally.evaluated === tally.withProof
      ? coverage
      : `${coverage} <span class="quiet">(${tally.evaluated} gradable)</span>`;
    html += `<tr><td>${escapeHtml(name)}</td><td>${graded}</td><td>${checksCell(tally)}</td><td>${countsRow(tally.wouldHave)}</td></tr>`;
  }
  return html + "</table>";
}

/**
 * The email section. Returns "" when there is nothing to say, so an off-mode
 * deployment does not grow a permanently empty block in the digest.
 */
function renderProofShadowSection(report) {
  const health = shadowHealth(report);
  if (health.state === "no_traffic") return "";

  let html = `<h2>Verified-answer shadow observation</h2>`;
  html += `<p class="quiet">${escapeHtml(health.note)}</p>`;
  if (health.state === "not_observing") return html;

  const { overall } = report;
  html += `<p><strong>Actually delivered:</strong> ${countsRow(overall.delivered)}</p>`;
  html += `<p><strong>The contract would have:</strong> ${countsRow(overall.wouldHave)}</p>`;
  html += `<p class="quiet">These two lines differ on purpose. Shadow mode changes nothing a user sees, so the first line is what shipped; the second is what the proof contract would have permitted had it been enforcing.</p>`;

  const checks = overall.checks;
  const totalChecks = checks.passed + checks.failed + checks.unknown + checks.not_applicable;
  if (totalChecks > 0) {
    html += `<p><strong>Individual checks:</strong> passed <strong>${checks.passed}</strong> &middot; failed <strong>${checks.failed}</strong> &middot; could not tell <strong>${checks.unknown}</strong> &middot; not applicable <strong>${checks.not_applicable}</strong></p>`;
    html += `<p class="quiet">"Could not tell" is not a pass. It means the check had nothing to work with — most often because source health is not yet established, which is Stage 2 work.</p>`;
  }

  const blockers = Object.entries(overall.blockedByCheck).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (blockers.length > 0) {
    html += `<h3>What blocked delivery most often</h3><table><tr><th>Check</th><th>Answers blocked</th></tr>`;
    for (const [name, n] of blockers) html += `<tr><td>${escapeHtml(name)}</td><td>${n}</td></tr>`;
    html += `</table>`;
  }

  html += tallyTable("Tab", [...report.byTab.entries()].sort((a, b) => b[1].rows - a[1].rows));
  html += tallyTable("Plan family", [...report.byFamily.entries()].sort((a, b) => b[1].rows - a[1].rows).slice(0, 15));

  if (overall.unparseable > 0) {
    html += `<p><strong>${overall.unparseable}</strong> proof record${overall.unparseable === 1 ? "" : "s"} could not be read. That is a defect in how the record was written, not a property of the traffic — it should be zero.</p>`;
  }

  return html;
}

module.exports = {
  PROOF_COLUMNS,
  selectClause,
  buildProofShadowReport,
  shadowHealth,
  renderProofShadowSection,
  actionLabel,
  // Exported so the drift guard can compare them against lib/proof-contract.ts.
  DECLARED_CHECKS,
  VALID_CHECK_STATES,
  MANIFEST_VERSION,
  DECLARED_ACTIONS,
  OBSERVING_MODES,
  decodeRow,
};
