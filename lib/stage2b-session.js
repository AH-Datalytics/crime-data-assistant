/**
 * The Stage 2B workbook's decision state, as one testable unit.
 *
 * Plain browser-compatible JavaScript on purpose. This file is inlined VERBATIM into the generated
 * workbook page and imported directly by the regression suite, so the logic under test is byte-for-
 * byte the logic that ships. It previously lived inside the HTML string, where the only thing a test
 * could do was match its text -- and sixteen text assertions passed over a page that threw a
 * SyntaxError on load and rendered nothing. Text matching cannot see behaviour; this can be called.
 *
 * It owns no DOM. The page is a thin binding over these functions: read fields, call update, render
 * what comes back. Nothing here can reach the repository, a database, or any flag.
 */
function createStage2bSession(DATA) {
  const clone = (value) => (value === null || value === undefined ? null : JSON.parse(JSON.stringify(value)));
  const FIELDS = ["coverage", "integrity", "availability", "receiptOwner"];

  function blank() {
    return { coverage: null, integrity: null, availability: null, receiptOwner: null, evidence: "" };
  }

  /** Field order and null-normalisation fixed here so two equal decisions always serialise equal. */
  function normalize(d) {
    return {
      coverage: d.coverage === undefined ? null : d.coverage,
      integrity: d.integrity === undefined ? null : d.integrity,
      availability: d.availability === undefined ? null : d.availability,
      receiptOwner: d.receiptOwner === undefined ? null : d.receiptOwner,
      evidence: d.evidence || "",
    };
  }
  const same = (a, b) => JSON.stringify(a === null ? null : normalize(a)) === JSON.stringify(b === null ? null : normalize(b));

  const decisions = {};
  /**
   * What the policy source held for each capability when this session began.
   *
   * Exported alongside the change set so the importer can tell "I am changing an entry that still
   * looks the way I found it" from "someone else has since changed it". Without it, importing an
   * older session silently overwrites newer policy, and there is no record that it happened.
   */
  const baseline = {};
  /**
   * What the REPOSITORY held, fixed for the life of the page and never written to.
   *
   * `baseline` is per-session and a load may legitimately adopt the one a file was authored
   * against. That made it stale-able across successive loads: loading a session authored against an
   * older policy moved `baseline`, and loading a second, empty session then reset the decisions but
   * left the moved baseline in place -- so the older value was restored, reported clean, and
   * exported nothing. Every load now resets BOTH from this, before applying the file.
   */
  const repositoryBaseline = {};
  const withdrawn = {};
  const capabilityById = {};
  for (const cap of DATA.capabilities) {
    capabilityById[cap.id] = cap;
    const prior = DATA.authored[cap.id] ? clone(DATA.authored[cap.id]) : null;
    repositoryBaseline[cap.id] = prior ? normalize(prior) : null;
    baseline[cap.id] = prior ? normalize(prior) : null;
    decisions[cap.id] = prior ? normalize(prior) : blank();
  }

  let dirty = false;

  const undecidedFields = (d) => FIELDS.filter((f) => d[f] === null || d[f] === undefined);

  /**
   * A coverage basis on a column whose NAME does not look year-bearing must say why.
   *
   * The naming heuristic never blocks the honest answer -- every readable column stays selectable,
   * because a year column the pattern failed to recognise would otherwise be unreachable. But
   * `agencies.national_sample` must not become a coverage basis through one casual click, so the
   * unmarked choice costs a sentence. The importer enforces the same rule independently; this is
   * where the person is told about it, not where it is guaranteed.
   */
  function coverageNeedsJustification(capId, coverage) {
    if (!coverage || coverage.kind !== "column") return false;
    const cap = capabilityById[capId];
    if (!cap) return false;
    const candidate = cap.coverageCandidates.find(
      (o) => o.table === coverage.table && o.yearColumn === coverage.yearColumn);
    return !!candidate && !candidate.yearBearing;
  }

  function coverageProblem(capId, coverage) {
    if (!coverage) return null;
    if (coverage.kind === "none") {
      return String(coverage.reason || "").trim() ? null : "state why this capability has no year dimension";
    }
    if (coverage.kind !== "column") return "coverage must name a column or state that there is no year dimension";
    if (coverageNeedsJustification(capId, coverage) && !String(coverage.justification || "").trim()) {
      return coverage.table + "." + coverage.yearColumn + " does not look year-bearing; say why it is the coverage basis";
    }
    return null;
  }

  /**
   * Everything wrong with what is currently authored, by the SAME rules the importer applies.
   *
   * "All fields non-null plus some evidence" was a weaker test than the boundary's, so the page
   * cheerfully reported a capability Complete while its coverage carried no reason and its
   * conditional availability carried no condition -- a count that told the author they were finished
   * with an entry the importer would refuse.
   */
  function problems(capId) {
    const d = decisions[capId];
    const found = [];
    const coverage = coverageProblem(capId, d.coverage);
    if (coverage) found.push(coverage);
    if (d.availability && d.availability.kind === "conditional" && !String(d.availability.condition || "").trim()) {
      found.push("a conditional availability must state its condition");
    }
    if (d.availability && d.availability.kind !== "conditional" && d.availability.kind !== "always") {
      found.push("availability must be always or conditional");
    }
    if (d.integrity !== null && (!Array.isArray(d.integrity) || d.integrity.length === 0)) {
      found.push("integrity must list at least one rule; an empty list states no rule");
    }
    if (d.evidence && String(d.evidence).trim().length <= 20 && undecidedFields(d).length === 0) {
      found.push("evidence must cite what the authored values rest on");
    }
    return found;
  }

  /** Every question answered, well formed, and cited. NOT the same as authorizing. */
  function isComplete(capId) {
    const d = decisions[capId];
    return undecidedFields(d).length === 0
      && String(d.evidence || "").trim().length > 20
      && problems(capId).length === 0;
  }

  /**
   * Integrity prose authorizes nothing, so the page must not imply otherwise.
   *
   * A rule bound to something runnable is written { rule, boundTo }; a bare sentence is a draft. The
   * workbook authors drafts today, which is why a completed capability is still not an authorizing
   * one, and saying so here keeps the count honest rather than leaving it to a footnote.
   */
  function integrityIsBound(integrity) {
    return Array.isArray(integrity) && integrity.length > 0 && integrity.every((rule) =>
      rule && typeof rule === "object" && !Array.isArray(rule)
      && String(rule.rule || "").trim() !== "" && String(rule.boundTo || "").trim() !== "");
  }

  /**
   * The rules a person can edit as text, and the bound ones they cannot.
   *
   * The page renders integrity into a textarea and re-parses it on EVERY field edit. With bound
   * rules in the list that round trip was destructive twice over: `join` rendered an object as
   * "[object Object]", and the next keystroke anywhere on the card -- an owner, a coverage answer,
   * a word of evidence -- parsed that string back as a draft rule and overwrote the binding. So the
   * textarea carries prose only, bound rules are shown separately and left alone, and re-authoring
   * the drafts cannot reach them.
   */
  const boundRules = (integrity) => (Array.isArray(integrity) ? integrity.filter((r) => r && typeof r === "object") : []);
  const draftRules = (integrity) => (Array.isArray(integrity) ? integrity.filter((r) => typeof r === "string") : []);

  /** Replace ONLY the prose rules, preserving every bound rule exactly where it was. */
  function setIntegrityDrafts(id, lines) {
    const kept = boundRules(decisions[id].integrity);
    const drafts = (lines || []).map((s) => String(s).trim()).filter(Boolean);
    const combined = kept.concat(drafts);
    return update(id, { integrity: combined.length ? combined : null });
  }

  /** Applies a patch, reporting whether anything actually changed. Rendering must not mark dirty. */
  function update(id, patch) {
    const d = decisions[id];
    if (!d) return false;
    const before = JSON.stringify(normalize(d));
    for (const key of Object.keys(patch)) d[key] = patch[key];
    const changed = JSON.stringify(normalize(d)) !== before;
    if (changed) { dirty = true; delete withdrawn[id]; }
    return changed;
  }

  /**
   * Withdrawing authored policy is a NAMED act, never inferred from empty fields.
   *
   * Clearing every field used to be read as deletion at the importer, while the page offered only
   * "Undecided" and no confirmation -- so the gesture that means "I have not decided this yet" and
   * the gesture that means "remove what was decided" were the same gesture, and the destructive
   * reading was the one that won.
   */
  function canWithdraw(id) { return baseline[id] !== null && baseline[id] !== undefined; }
  function withdraw(id) {
    if (!canWithdraw(id)) return false;
    withdrawn[id] = true;
    decisions[id] = blank();
    dirty = true;
    return true;
  }
  const isWithdrawn = (id) => withdrawn[id] === true;

  function counts() {
    const c = { coverage: 0, integrity: 0, availability: 0, receiptOwner: 0, complete: 0, problems: 0 };
    for (const cap of DATA.capabilities) {
      const d = decisions[cap.id];
      for (const f of FIELDS) if (d[f] === null) c[f] += 1;
      if (isComplete(cap.id)) c.complete += 1;
      if (problems(cap.id).length) c.problems += 1;
    }
    return c;
  }

  /**
   * Only what this session actually changed.
   *
   * A full snapshot was not merely verbose: the importer rebuilds the policy file from what it
   * receives, so an omitted entry is a DELETED entry and an old snapshot silently reverts newer
   * work. A change set plus a per-entry baseline can be merged, and a merge that would clobber
   * someone else's newer answer can be refused by name.
   */
  function changeSet() {
    const out = {};
    for (const id of Object.keys(decisions).sort()) {
      if (withdrawn[id]) { out[id] = { operation: "withdraw" }; continue; }
      const d = normalize(decisions[id]);
      const untouched = d.coverage === null && d.integrity === null && d.availability === null
        && d.receiptOwner === null && String(d.evidence).trim() === "";
      if (baseline[id] === null && untouched) continue;
      if (baseline[id] !== null && same(decisions[id], baseline[id])) continue;
      out[id] = d;
    }
    return out;
  }

  function serialize() {
    const changed = changeSet();
    const basedOn = {};
    for (const id of Object.keys(changed)) basedOn[id] = baseline[id] === null ? null : normalize(baseline[id]);
    return JSON.stringify({ v: DATA.v, fingerprint: DATA.fingerprint, decisions: changed, basedOn }, null, 2) + "\n";
  }

  /**
   * Loading REPLACES the session; it does not merge into whatever is on screen.
   *
   * Merging looked harmless and was not: unrelated edits made in this tab survived the load and were
   * then marked clean along with the file's, so an export afterwards carried work the author never
   * saw on screen and had no reason to believe was still there. Loading over unsaved work now
   * requires saying so.
   *
   * A session authored against a DIFFERENT registry structure applies nothing at all. Warning and
   * then copying the decisions anyway was worse than either alternative: the next export stamped
   * them with the CURRENT fingerprint, so answers to questions that no longer exist arrived at the
   * importer wearing a fingerprint that made them look freshly authored.
   */
  function loadSession(parsed, options) {
    const opts = options || {};
    if (!parsed || typeof parsed !== "object") return { ok: false, reason: "that file is not a workbook session" };
    if (parsed.v !== DATA.v) {
      return { ok: false, reason: "that session is version " + String(parsed.v) + "; this workbook writes version " + String(DATA.v) };
    }
    if (parsed.fingerprint !== DATA.fingerprint) {
      return {
        ok: false,
        stale: true,
        reason: "That session was authored against a different registry structure (" + String(parsed.fingerprint)
          + " vs " + DATA.fingerprint + "), so the questions themselves may have changed. Nothing was loaded."
          + " Re-answer against this workbook rather than carrying the old answers across.",
      };
    }
    if (dirty && !opts.discardUnsaved) {
      return {
        ok: false,
        needsConfirmation: true,
        reason: "This tab has unsaved changes. Loading a session replaces everything on screen with"
          + " the file's contents. Export first, or confirm to discard what is unsaved.",
      };
    }

    // Complete replacement: every capability returns to what the policy source held, then the file
    // is applied over it. Nothing from the previous session survives unseen.
    for (const id of Object.keys(decisions)) {
      baseline[id] = repositoryBaseline[id] === null ? null : clone(repositoryBaseline[id]);
      decisions[id] = baseline[id] ? normalize(baseline[id]) : blank();
      delete withdrawn[id];
    }
    const incoming = parsed.decisions || {};
    const unknown = [];
    let applied = 0;
    for (const id of Object.keys(incoming)) {
      if (!decisions[id]) { unknown.push(id); continue; }
      if (incoming[id] && incoming[id].operation === "withdraw") {
        withdrawn[id] = true;
        decisions[id] = blank();
      } else {
        decisions[id] = normalize(Object.assign(blank(), incoming[id]));
      }
      if (parsed.basedOn && Object.prototype.hasOwnProperty.call(parsed.basedOn, id)) {
        baseline[id] = parsed.basedOn[id] === null ? null : normalize(parsed.basedOn[id]);
      }
      applied += 1;
    }
    dirty = false;
    return { ok: true, applied: applied, unknown: unknown };
  }

  /** Which capabilities a cluster application would touch, and what it would cost them. */
  function clusterPlan(id) {
    const cap = capabilityById[id], d = decisions[id];
    const targets = cap.tableCluster.length ? cap.tableCluster.slice() : cap.artifactCluster.slice();
    const scope = cap.tableCluster.length ? "the same table set" : "the same artifact";
    const fields = FIELDS.filter((f) => d[f] !== null);
    const detail = targets.map((t) => {
      const target = capabilityById[t];
      const copyable = fields.filter((f) => f !== "coverage" || coverageFits(target, d.coverage));
      const overwrites = copyable.filter((f) => decisions[t][f] !== null && JSON.stringify(decisions[t][f]) !== JSON.stringify(d[f]));
      return {
        id: t,
        overwrites: overwrites,
        coverageDropped: fields.indexOf("coverage") >= 0 && !coverageFits(target, d.coverage),
        /**
         * Evidence describes the VALUES it was written for. Leaving a target's own evidence beside
         * fields that have just been replaced leaves a citation that describes values no longer
         * there -- which reads, later, as though someone checked.
         */
        evidenceReplaced: overwrites.length > 0 || copyable.some((f) => decisions[t][f] === null),
      };
    });
    return { targets: targets, fields: fields, scope: scope, detail: detail };
  }

  function coverageFits(target, coverage) {
    if (!coverage) return false;
    if (coverage.kind === "none") return true;
    return target.coverageCandidates.some((o) => o.table === coverage.table && o.yearColumn === coverage.yearColumn);
  }

  function applyCluster(id) {
    const plan = clusterPlan(id), source = decisions[id];
    const changed = [];
    for (const entry of plan.detail) {
      const target = decisions[entry.id];
      let touched = false;
      for (const f of plan.fields) {
        if (f === "coverage" && !coverageFits(capabilityById[entry.id], source.coverage)) continue;
        if (JSON.stringify(target[f]) !== JSON.stringify(source[f])) touched = true;
        target[f] = clone(source[f]);
      }
      if (touched) {
        target.evidence = source.evidence || "";
        delete withdrawn[entry.id];
        changed.push(entry.id);
        dirty = true;
      }
    }
    return { changed: changed };
  }

  return {
    FIELDS: FIELDS,
    decisions: decisions,
    capability: (id) => capabilityById[id],
    blank: blank,
    update: update,
    undecidedFields: undecidedFields,
    problems: problems,
    isComplete: isComplete,
    integrityIsBound: integrityIsBound,
    counts: counts,
    setIntegrityDrafts: setIntegrityDrafts,
    boundRules: (id) => boundRules(decisions[id].integrity),
    draftRules: (id) => draftRules(decisions[id].integrity),
    changeSet: changeSet,
    serialize: serialize,
    loadSession: loadSession,
    clusterPlan: clusterPlan,
    applyCluster: applyCluster,
    coverageNeedsJustification: coverageNeedsJustification,
    coverageProblem: coverageProblem,
    canWithdraw: canWithdraw,
    withdraw: withdraw,
    isWithdrawn: isWithdrawn,
    isDirty: () => dirty,
    markClean: () => { dirty = false; },
    baselineFor: (id) => baseline[id],
  };
}

if (typeof module !== "undefined" && module.exports) module.exports = { createStage2bSession: createStage2bSession };
