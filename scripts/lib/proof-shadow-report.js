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
    delivered: {},
    wouldHave: {},
    checks: { passed: 0, failed: 0, unknown: 0, not_applicable: 0 },
    blockedByCheck: {},
    unparseable: 0,
  };
}

function tallyRow(tally, row) {
  tally.rows += 1;
  const envelope = parseEnvelope(row.proof_manifest);
  if (!row.proof_mode) return; // no proof record at all -- counted in rows, not withProof
  tally.withProof += 1;

  const delivered = row.delivery_action || "unrecorded";
  tally.delivered[delivered] = (tally.delivered[delivered] || 0) + 1;

  if (!envelope) return;
  if (envelope.unparseable) {
    tally.unparseable += 1;
    return;
  }

  const would = envelope.hypotheticalAction || "unrecorded";
  tally.wouldHave[would] = (tally.wouldHave[would] || 0) + 1;

  const checks = (envelope.manifest && envelope.manifest.checks) || {};
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

function tallyTable(title, entries) {
  if (entries.length === 0) return "";
  let html = `<h3>${escapeHtml(title)}</h3><table><tr><th>${escapeHtml(title)}</th><th>Evaluated</th><th>Would have been delivered</th></tr>`;
  for (const [name, tally] of entries) {
    const coverage = tally.withProof === tally.rows
      ? `${tally.withProof}`
      : `${tally.withProof} of ${tally.rows}`;
    html += `<tr><td>${escapeHtml(name)}</td><td>${coverage}</td><td>${countsRow(tally.wouldHave)}</td></tr>`;
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
