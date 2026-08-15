/**
 * The Stage 2B workbook's decision state, as one testable unit.
 *
 * Plain browser-compatible JavaScript on purpose. This file is inlined VERBATIM into the generated
 * workbook page and imported directly by the regression suite, so the logic under test is byte-for-
 * byte the logic that ships. It previously lived inside the HTML string, where the only thing a test
 * could do was match its text -- and sixteen text assertions passed over a page that threw a
 * SyntaxError on load and rendered nothing. Text matching cannot see behaviour; this can be called.
 *
 * WHAT IS STORED IS THE HUMAN ANSWER. The technical policy is DERIVED from it, shown, and applied
 * only after the person confirms that exact derivation. Storing the technical form instead would
 * make the translation invisible: the record would show a coverage basis nobody chose in those
 * terms, and no later reader could tell what question had actually been answered.
 *
 * It owns no DOM. Nothing here can reach the repository, a database, or any flag.
 */
function createStage2bSession(DATA, plainLanguage) {
  const PL = plainLanguage || createStage2bPlainLanguage();
  const clone = (value) => (value === null || value === undefined ? null : JSON.parse(JSON.stringify(value)));
  const POLICY_FIELDS = ["coverage", "integrity", "availability", "receiptOwner"];

  const human = {};
  const confirmed = {};
  const withdrawn = {};
  const capabilityById = {};
  /**
   * What the policy source held when this session began, and an immutable copy of it.
   *
   * `baseline` may legitimately be replaced by the one a loaded file was authored against, which
   * made it stale-able: loading an older session moved it, and a second, empty load then restored
   * the moved value instead of the repository's. Every load resets both from `repositoryBaseline`.
   */
  const baseline = {};
  const repositoryBaseline = {};
  /**
   * What the checked-in answer record held when this session began, and never written to.
   *
   * Seeding from it is the resume feature: reopening the workbook shows what was answered and why,
   * instead of a blank card over existing policy. A capability nobody has answered still opens
   * blank -- seeding must never invent an answer, only restore one.
   */
  const repositoryAnswers = {};
  /**
   * Capabilities whose question has been RE-WORDED since the answer was recorded.
   *
   * The answer is restored -- it is still what the person said -- but its confirmation is not, and
   * the page says why. A confirmation approves a specific translation of a specific question; once
   * the question changes it approves something nobody read.
   */
  const rewordedSince = {};
  const recorded = DATA.answers || {};
  for (const cap of DATA.capabilities) {
    capabilityById[cap.id] = cap;
    const prior = DATA.authored[cap.id] ? clone(DATA.authored[cap.id]) : null;
    repositoryBaseline[cap.id] = prior;
    baseline[cap.id] = clone(prior);
    const priorAnswer = recorded[cap.id] || null;
    const sameWording = !!priorAnswer && priorAnswer.catalogFingerprint === DATA.catalogFingerprint;
    if (priorAnswer && !sameWording) rewordedSince[cap.id] = true;
    repositoryAnswers[cap.id] = priorAnswer ? clone(priorAnswer) : null;
    human[cap.id] = priorAnswer ? Object.assign(PL.blankAnswer(), priorAnswer.human || {}) : PL.blankAnswer();
    confirmed[cap.id] = sameWording ? (priorAnswer.mappingConfirmed || null) : null;
  }

  let dirty = false;

  /**
   * What would actually be RECORDED for this capability. Never applied by anything here.
   *
   * `merged` is what the importer will write: the answers, over whatever the policy source already
   * holds. An unresolved answer keeps the existing value rather than nulling it, so "I'm not sure"
   * cannot quietly undo a decision someone made -- and `preserved` names the fields that are being
   * kept rather than set, because a mapping panel that showed them as blank would be describing a
   * different outcome than the one about to happen.
   */
  function proposal(id) {
    const p = PL.proposeMapping(capabilityById[id], human[id]);
    const m = PL.mergeWithExisting(p.proposed, baseline[id]);
    return { proposed: p.proposed, unresolved: p.unresolved, merged: m.merged, preserved: m.preserved };
  }
  /** Over the MERGED result, so the person confirms what will be written, not an intermediate. */
  function fingerprintOf(id) { return PL.mappingFingerprint(proposal(id).merged); }

  /**
   * A confirmation is tied to the EXACT proposal confirmed, so it expires by itself.
   *
   * Storing a boolean would have let an answer change after the mapping was approved and carried
   * the approval along with it -- the person would have confirmed one translation and exported
   * another. Comparing fingerprints means any edit that changes the proposal silently un-confirms
   * it, and the page says so.
   */
  function isMappingConfirmed(id) { return confirmed[id] !== null && confirmed[id] === fingerprintOf(id); }
  function confirmMapping(id) {
    if (!PL.isAnswered(human[id])) return false;
    confirmed[id] = fingerprintOf(id);
    dirty = true;
    return true;
  }

  /** Answers that cannot yet be turned into a coherent mapping. Same rules the importer applies. */
  function problems(id) {
    const cap = capabilityById[id], h = human[id], found = [];
    if (h.coverage === "no-years" && !String(h.coverageReason || "").trim()) {
      found.push("say why this answer is not about a time period");
    }
    if (h.coverage === "years" && h.coverageColumn) {
      const chosen = cap.coverageCandidates.find(
        (o) => o.table === h.coverageColumn.table && o.yearColumn === h.coverageColumn.yearColumn);
      if (chosen && !chosen.yearBearing && !String(h.coverageReason || "").trim()) {
        found.push("that column is not named like a year, so say why it is the right basis");
      }
    }
    if (h.availability === "sometimes" && !String(h.availabilityWhen || "").trim()) {
      found.push("say when it is legitimately absent");
    }
    if (h.owner === "other" && !String(h.ownerOther || "").trim()) found.push("name the process");
    if (PL.isAnswered(h) && String(h.evidence || "").trim().length <= 20) {
      found.push("say what these answers rest on");
    }
    return found;
  }

  /** Answered throughout, coherent, cited, and with the technical mapping confirmed. */
  function isComplete(id) {
    const p = proposal(id);
    return p.unresolved.length === 0 && problems(id).length === 0 && isMappingConfirmed(id);
  }

  function update(id, patch) {
    const before = JSON.stringify(human[id]);
    for (const key of Object.keys(patch)) human[id][key] = patch[key];
    const changed = JSON.stringify(human[id]) !== before;
    if (changed) { dirty = true; delete withdrawn[id]; }
    return changed;
  }

  function counts() {
    const c = { coverage: 0, integrity: 0, availability: 0, receiptOwner: 0, complete: 0, problems: 0, unconfirmed: 0 };
    for (const cap of DATA.capabilities) {
      const p = proposal(cap.id);
      for (const f of POLICY_FIELDS) if (p.unresolved.indexOf(f) >= 0) c[f] += 1;
      if (isComplete(cap.id)) c.complete += 1;
      if (problems(cap.id).length) c.problems += 1;
      if (PL.isAnswered(human[cap.id]) && !isMappingConfirmed(cap.id)) c.unconfirmed += 1;
    }
    return c;
  }

  /**
   * Withdrawing authored policy is a NAMED act, never inferred from empty fields.
   *
   * Clearing every answer used to be read as deletion at the importer, while the page offered only
   * "not sure" and no confirmation -- so "I have not decided this" and "remove what was decided"
   * were the same gesture, and the destructive reading won.
   */
  function canWithdraw(id) { return baseline[id] !== null && baseline[id] !== undefined; }
  function withdraw(id) {
    if (!canWithdraw(id)) return false;
    withdrawn[id] = true;
    human[id] = PL.blankAnswer();
    confirmed[id] = null;
    dirty = true;
    return true;
  }
  const isWithdrawn = (id) => withdrawn[id] === true;

  /**
   * Only what this session changed, carrying the human answer AND the mapping it proposes.
   *
   * Both, always. The human answer is the decision and the record of what was actually asked; the
   * proposal is what the importer will write. Exporting only one of them would either hide the
   * translation or lose the question it answered.
   */
  function changeSet() {
    const out = {};
    for (const id of Object.keys(human).sort()) {
      if (withdrawn[id]) { out[id] = { operation: "withdraw" }; continue; }
      if (!PL.isAnswered(human[id])) continue;
      /**
       * An answer restored from the record and left alone is not a change.
       *
       * Without this every seeded capability would reappear in the change set on every export, so a
       * diff of two sessions would show fifty untouched entries and hide the one that moved.
       */
      const seeded = rewordedSince[id] ? null : repositoryAnswers[id];
      if (seeded && JSON.stringify(seeded.human || {}) === JSON.stringify(human[id])
          && (seeded.mappingConfirmed || null) === (isMappingConfirmed(id) ? confirmed[id] : null)) continue;
      const p = proposal(id);
      out[id] = {
        human: clone(human[id]),
        /** What will be RECORDED, which is what was shown and confirmed. */
        proposed: p.merged,
        unresolved: p.unresolved.slice(),
        preserved: p.preserved.slice(),
        mappingConfirmed: isMappingConfirmed(id) ? confirmed[id] : null,
      };
    }
    return out;
  }

  function serialize() {
    const changed = changeSet();
    const basedOn = {};
    for (const id of Object.keys(changed)) basedOn[id] = baseline[id] === null ? null : clone(baseline[id]);
    return JSON.stringify({ v: DATA.v, fingerprint: DATA.fingerprint, decisions: changed, basedOn }, null, 2) + "\n";
  }

  /**
   * Loading REPLACES the session; it does not merge into whatever is on screen.
   *
   * Merging looked harmless and was not: unrelated edits made in this tab survived the load and were
   * then marked clean along with the file's, so an export afterwards carried work the author never
   * saw on screen. A session authored against a DIFFERENT registry structure applies nothing at all
   * -- warning and copying anyway meant the next export stamped those answers with the CURRENT
   * fingerprint, and the check that refused the file accepted its laundered copy.
   */
  function loadSession(parsed, options) {
    const opts = options || {};
    if (!parsed || typeof parsed !== "object") return { ok: false, reason: "that file is not a workbook session" };
    if (parsed.v !== DATA.v) {
      return { ok: false, reason: "that session is version " + String(parsed.v) + "; this workbook writes version " + String(DATA.v) };
    }
    if (parsed.fingerprint !== DATA.fingerprint) {
      return {
        ok: false, stale: true,
        reason: "That session was authored against a different registry structure (" + String(parsed.fingerprint)
          + " vs " + DATA.fingerprint + "), so the questions themselves may have changed. Nothing was loaded."
          + " Re-answer against this workbook rather than carrying the old answers across.",
      };
    }
    if (dirty && !opts.discardUnsaved) {
      return {
        ok: false, needsConfirmation: true,
        reason: "This tab has unsaved changes. Loading a session replaces everything on screen with"
          + " the file's contents. Export first, or confirm to discard what is unsaved.",
      };
    }

    for (const id of Object.keys(human)) {
      baseline[id] = clone(repositoryBaseline[id]);
      const seeded = repositoryAnswers[id];
      human[id] = seeded ? Object.assign(PL.blankAnswer(), seeded.human || {}) : PL.blankAnswer();
      confirmed[id] = seeded && !rewordedSince[id] ? (seeded.mappingConfirmed || null) : null;
      delete withdrawn[id];
    }
    const incoming = parsed.decisions || {};
    const unknown = [];
    let applied = 0;
    for (const id of Object.keys(incoming)) {
      if (!human[id]) { unknown.push(id); continue; }
      const entry = incoming[id] || {};
      if (entry.operation === "withdraw") { withdrawn[id] = true; }
      else {
        human[id] = Object.assign(PL.blankAnswer(), entry.human || {});
        // A confirmation only survives if it still matches what these answers propose NOW.
        confirmed[id] = entry.mappingConfirmed || null;
      }
      if (parsed.basedOn && Object.prototype.hasOwnProperty.call(parsed.basedOn, id)) {
        baseline[id] = parsed.basedOn[id] === null ? null : clone(parsed.basedOn[id]);
      }
      applied += 1;
    }
    dirty = false;
    return { ok: true, applied: applied, unknown: unknown };
  }

  /** Which capabilities a cluster application would touch, and what it would cost them. */
  function clusterPlan(id) {
    const cap = capabilityById[id];
    const targets = cap.tableCluster.length ? cap.tableCluster.slice() : cap.artifactCluster.slice();
    const scope = cap.tableCluster.length ? "the same tables" : "the same data source";
    const detail = targets.map((t) => ({
      id: t,
      overwrites: PL.isAnswered(human[t]),
      /**
       * A copied answer proposes a DIFFERENT mapping for a different capability, so the target's
       * confirmation cannot survive: it approved a translation that no longer applies.
       */
      confirmationCleared: confirmed[t] !== null,
    }));
    return { targets: targets, scope: scope, detail: detail, answered: PL.isAnswered(human[id]) };
  }

  function applyCluster(id) {
    const plan = clusterPlan(id);
    const changed = [];
    if (!plan.answered) return { changed: changed };
    for (const entry of plan.detail) {
      const copy = clone(human[id]);
      /* Coverage is a column on a specific table: only carry it where the target reads that pair. */
      if (copy.coverageColumn) {
        const target = capabilityById[entry.id];
        const fits = target.coverageCandidates.some(
          (o) => o.table === copy.coverageColumn.table && o.yearColumn === copy.coverageColumn.yearColumn);
        if (!fits) copy.coverageColumn = null;
      }
      human[entry.id] = copy;
      confirmed[entry.id] = null;      // the mapping differs; it must be looked at again
      delete withdrawn[entry.id];
      changed.push(entry.id);
      dirty = true;
    }
    return { changed: changed };
  }

  return {
    POLICY_FIELDS: POLICY_FIELDS,
    capability: (id) => capabilityById[id],
    human: (id) => human[id],
    update: update,
    proposal: proposal,
    mappingFingerprint: fingerprintOf,
    isMappingConfirmed: isMappingConfirmed,
    /** True when the answer was restored but the question has been re-worded since. */
    needsReconfirmation: (id) => rewordedSince[id] === true && PL.isAnswered(human[id]),
    confirmMapping: confirmMapping,
    problems: problems,
    isComplete: isComplete,
    counts: counts,
    changeSet: changeSet,
    serialize: serialize,
    loadSession: loadSession,
    clusterPlan: clusterPlan,
    applyCluster: applyCluster,
    canWithdraw: canWithdraw,
    withdraw: withdraw,
    isWithdrawn: isWithdrawn,
    isDirty: () => dirty,
    markClean: () => { dirty = false; },
    baselineFor: (id) => baseline[id],
  };
}

if (typeof module !== "undefined" && module.exports) module.exports = { createStage2bSession: createStage2bSession };
