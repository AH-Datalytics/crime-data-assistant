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

function parseEnvelope(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    // A malformed envelope is itself a finding: the writer bounded the fields wrongly,
    // or a column was truncated. Counted rather than silently skipped.
    return { unparseable: true };
  }
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
     * manifest under the size limit, the serializer could not build one at all, or what
     * was stored is not a shape the serializer ever declares. All five are counted
     * separately below rather than folded in, because an envelope that
     * silently contributes zero check states is indistinguishable from a clean record --
     * the D6 failure shape one layer in, where "nothing flagged" really means "nothing
     * was looked at".
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
    delivered: {},
    wouldHave: {},
    checks: { passed: 0, failed: 0, unknown: 0, not_applicable: 0 },
    blockedByCheck: {},
  };
}

function tallyRow(tally, row) {
  tally.rows += 1;
  const envelope = parseEnvelope(row.proof_manifest);
  if (!row.proof_mode) return; // no proof record at all -- counted in rows, not withProof
  tally.withProof += 1;

  const delivered = row.delivery_action || "unrecorded";
  tally.delivered[delivered] = (tally.delivered[delivered] || 0) + 1;

  if (!envelope) {
    tally.envelopeMissing += 1;
    return;
  }
  if (envelope.unparseable) {
    tally.unparseable += 1;
    return;
  }

  const creditWouldHave = () => {
    const would = envelope.hypotheticalAction || "unrecorded";
    tally.wouldHave[would] = (tally.wouldHave[would] || 0) + 1;
  };

  // Checked BEFORE wouldHave is credited: this envelope carries only { v, envelopeError },
  // so there is no hypothetical action in it and crediting one would invent an
  // "unrecorded" bucket out of a serializer failure.
  if (envelope.envelopeError) {
    tally.envelopeError += 1;
    return;
  }

  // A reduced envelope has no manifest BY DESIGN but does still record what the contract
  // would have done, so it is credited and classified before the structural check below --
  // which would otherwise call the serializer's own deliberate fallback malformed.
  if (envelope.envelopeReduced) {
    creditWouldHave();
    tally.reduced += 1;
    return;
  }

  /**
   * STRUCTURAL VALIDATION, NOT JUST PARSEABILITY.
   *
   * Everything above recognizes a shape the serializer DECLARES. This catches everything
   * else: `{}`, `{v:1}`, `{manifest:null}` -- parseable, undeclared, and carrying nothing
   * to grade. Before this check they fell through to `evaluated`, which contradicted that
   * field's definition ("rows that carried a manifest with checks in it") and credited a
   * phantom "unrecorded" hypothetical action drawn from an empty record. A row the writer
   * mangled must read as a writer defect, never as a graded pass.
   */
  const manifest = envelope.manifest;
  const checks = manifest && typeof manifest === "object" ? manifest.checks : null;
  if (!checks || typeof checks !== "object") {
    tally.malformed += 1;
    return;
  }

  creditWouldHave();
  tally.evaluated += 1;
  for (const state of Object.values(checks)) {
    if (tally.checks[state] !== undefined) tally.checks[state] += 1;
  }
  for (const name of envelope.blockingChecks || []) {
    tally.blockedByCheck[name] = (tally.blockedByCheck[name] || 0) + 1;
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
  const notEvaluated = tally.envelopeMissing + tally.unparseable + tally.reduced + tally.envelopeError + tally.malformed;
  const detail = [];
  if (tally.envelopeMissing > 0) detail.push(`no envelope: ${tally.envelopeMissing}`);
  if (tally.unparseable > 0) detail.push(`unreadable: ${tally.unparseable}`);
  if (tally.reduced > 0) detail.push(`reduced, checks lost: ${tally.reduced}`);
  if (tally.envelopeError > 0) detail.push(`could not be built: ${tally.envelopeError}`);
  if (tally.malformed > 0) detail.push(`malformed: ${tally.malformed}`);
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
};
