/**
 * The decision card: what a person actually reads, as markup built from data.
 *
 * WHY THIS IS A MODULE. Every word on this card used to be concatenated inside the generator's HTML
 * template, where the only thing a test could do was search the finished page for a substring. That
 * is how sixteen assertions passed over a page that threw on load, and it is why "does the primary
 * surface avoid database language?" was unanswerable: the page text and the inlined source code sat
 * in one string, so any search hit the code. Here the card is a function. The suite calls it and
 * reads back exactly what a person would see, with none of the machinery in the way.
 *
 * IT OWNS NO WORDING. Every sentence comes from `lib/stage2b-plain-language.js` or the reviewed
 * catalog, both of which the decision contract's fingerprint covers. A string written here would be
 * wording no confirmation was ever checked against.
 *
 * THE SPLIT THAT MATTERS. `primary` is the deciding path and speaks only about crime data and what
 * the chatbot will do. `technical` is a collapsed disclosure that speaks about tables and columns,
 * is never required to answer anything, and is marked so the regression can hold the two apart.
 */
function createStage2bCard(plainLanguage) {
  const PL = plainLanguage;
  const Q = PL.questions();

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  }

  /** A question heading with the one-sentence statement of what is being decided under it. */
  function ask(heading, decision) {
    return '<h3>' + esc(heading) + '</h3>'
      + '<p class="decide"><b>' + esc(Q.card.decisionHeading) + '</b> ' + esc(decision) + '</p>';
  }

  /**
   * An option, with what it CAUSES under it.
   *
   * The consequence is not decoration. A label alone ("Yes — year matters") tells someone what they
   * are ticking, not what the chatbot will then do, and the whole point of the exercise is the
   * second thing.
   */
  function option(type, name, o, checked) {
    return '<label class="opt"><input type="' + type + '" name="' + name + '" value="' + esc(o.value) + '"'
      + (checked ? " checked" : "") + "/>" + esc(o.label)
      + '<span class="why">' + esc(o.consequence) + "</span></label>";
  }

  /**
   * The recommendation, in its own block and never on the option.
   *
   * Fusing them ("No — this question is not about a particular year  recommended") reads as one
   * label and makes the recommendation look like part of the choice rather than advice about it.
   * Kept apart, with its capability-specific reason, it can be disagreed with.
   */
  function recommendation(cap) {
    const r = PL.yearRecommendation(cap);
    if (!r) return "";
    return '<div class="rec"><b>' + esc(Q.card.recommendationLabel) + ": " + esc(r.answer) + ".</b> "
      + esc(r.why) + '<span class="recnote">' + esc(Q.card.recommendationNote) + "</span></div>";
  }

  /** What this question helps someone answer, and one realistic asking of it. */
  function header(cap, position) {
    return '<div class="head">'
      + '<p class="eyebrow">' + esc(Q.card.answersHeading) + "</p>"
      + "<h2>" + esc(PL.describeQuestion(cap)) + "</h2>"
      + '<p class="example"><span>' + esc(Q.card.exampleLabel) + "</span> “"
      + esc(PL.exampleAsking(cap)) + "”</p>"
      + (position ? '<span class="observed">' + esc(position) + "</span>" : "")
      + "</div>";
  }

  /** The deciding path. Nothing here requires knowing anything about how the data is stored. */
  function primary(cap, S, position) {
    const h = S.human(cap.id);
    const years = PL.yearOptions(cap).map((o) => option("radio", "cov", o, h.coverage === o.value)).join("");
    /**
     * ONE ROW PER PROBLEM, each carrying the four complete responses.
     *
     * A row rather than a grid: the responses are sentences about behaviour, and a dense table
     * would put the reader back in the position of decoding rather than deciding.
     */
    const actions = PL.trustActions();
    const problemRow = (row) =>
      '<div class="problem"><p class="problem-label">' + esc(row.label) + "</p>"
      + actions.map((a) =>
        '<label class="opt"><input type="radio" name="trust:' + esc(row.value) + '" value="' + esc(a.value) + '"'
        + (row.action === a.value ? " checked" : "") + "/>" + esc(a.label)
        + '<span class="why">' + esc(a.consequence) + "</span></label>").join("")
      + "</div>";
    const rows = PL.trustRows(cap, h);
    const scenarios = rows.filter((r) => !r.custom).map(problemRow).join("")
      + '<div class="bulk"><button type="button" id="trustAllNone">' + esc(Q.trust.bulk.none) + "</button>"
      + '<button type="button" id="trustAllUnsure">' + esc(Q.trust.bulk.unsure) + "</button>"
      + '<span class="why">' + esc(Q.trust.bulk.note) + "</span></div>"
      + '<div class="q"><h4>' + esc(Q.trust.otherHeading) + "</h4>"
      + '<p class="hint">' + esc(Q.trust.otherHint) + "</p>"
      + "<label>" + esc(Q.trust.otherLabel) + "</label>"
      + '<input type="text" id="trustOther" value="' + esc(h.trustOther || "") + '"/>'
      + (String(h.trustOther || "").trim()
        ? rows.filter((r) => r.custom).map(problemRow).join("")
        : "")
      + "</div>";
    const avail = PL.availabilityOptions().map((o) => option("radio", "avail", o, h.availability === o.value)).join("");
    const who = PL.responsibilityOptions(cap).map((o) =>
      '<label class="opt"><input type="radio" name="owner" value="' + esc(o.value) + '"'
      + (h.owner === o.value ? " checked" : "") + "/>" + esc(o.label) + "</label>").join("");

    return '<div class="card">'
      + header(cap, position)

      + '<div class="q">' + ask(Q.year.heading, Q.year.decision)
        + '<p class="choices">' + esc(Q.card.choicesHeading) + "</p>"
        + years + recommendation(cap)
      + "</div>"

      + '<div class="q">' + ask(Q.trust.heading, Q.trust.decision)
        + '<p class="hint">' + esc(Q.trust.note) + "</p>"
        + scenarios
      + "</div>"

      + '<div class="q">' + ask(Q.availability.heading, Q.availability.decision)
        + '<p class="choices">' + esc(Q.card.choicesHeading) + "</p>"
        + avail
        + (h.availability === "sometimes"
          ? "<label>" + esc(Q.availability.whenLabel) + "</label>"
            + '<p class="hint">' + esc(Q.availability.whenHint) + "</p>"
            + '<input type="text" id="availWhen" value="' + esc(h.availabilityWhen || "") + '"/>'
          : "")
      + "</div>"

      + '<div class="q">' + ask(Q.responsibility.heading, Q.responsibility.decision)
        + who
        + (h.owner === "other"
          ? "<label>" + esc(Q.responsibility.otherLabel) + '</label><input type="text" id="ownerOther" value="'
            + esc(h.ownerOther || "") + '"/>'
          : "")
      + "</div>"

      + '<div class="q"><h3>' + esc(Q.notes.heading) + "</h3>"
        + '<p class="hint">' + esc(Q.notes.hint) + "</p>"
        + '<textarea id="notes">' + esc(h.notes || "") + "</textarea></div>"

      + '<div id="summary"></div>'

      + (S.canWithdraw(cap.id)
        ? '<div class="q"><h3>' + esc(Q.withdraw.heading) + "</h3>"
          + '<p class="hint">' + esc(Q.withdraw.hint) + "</p>"
          + (S.isWithdrawn(cap.id)
            ? '<div class="alert">' + esc(Q.withdraw.marked) + "</div>"
            : '<button id="withdraw">' + esc(Q.withdraw.button) + "</button>")
          + "</div>"
        : "")

      + technical(cap, S)
      + "</div>";
  }

  /**
   * What your answers mean: the behaviour, before any confirmation.
   *
   * Repainted on its own as the person types, because it used to be rebuilt only when a radio
   * changed -- so typing the missing sentence cleared the problem while the confirm button stayed
   * greyed out, with nothing saying why.
   */
  function summaryPanel(cap, S) {
    const rows = S.summary(cap.id);
    const problems = S.problems(cap.id);
    const confirmed = S.isMappingConfirmed(cap.id);
    const answered = PL.isAnswered(S.human(cap.id));
    const p = S.proposal(cap.id);
    const outstanding = S.followUps(cap.id);

    /** A kept row already says it is kept, in `summary.keptDetail`. Marking it again just repeats. */
    const body = rows.map((row) =>
      "<dt>" + esc(row.label) + "</dt><dd"
      + (row.kept ? ' class="keptnote"' : "") + ">" + esc(row.text) + "</dd>").join("");

    return '<div class="q"><h3>' + esc(Q.summary.heading) + "</h3>"
      + '<p class="hint">' + esc(Q.summary.hint) + "</p>"
      + '<div class="means"><dl>' + body + "</dl></div>"
      /**
       * Every outstanding engineering item, each said in its own terms. There can be more than one
       * -- an unsettled year basis and a warning nobody can show yet are different problems -- and
       * neither is something the person answering left undone.
       */
      + outstanding.map((text) =>
        '<div class="followup"><b>' + esc(Q.card.followUpHeading) + "</b> " + esc(text) + "</div>").join("")
      + (problems.length
        ? '<div class="alert">' + esc(Q.summary.beforeConfirm) + " " + problems.map(esc).join("; ") + "</div>"
        : "")
      + (S.needsReconfirmation(cap.id) ? '<div class="warn">' + esc(Q.summary.reworded) + "</div>" : "")
      + (confirmed
        ? '<div class="good">' + esc(Q.summary.confirmedNote) + "</div>"
        : '<button class="primary" id="confirmMapping"' + (answered && !problems.length ? "" : " disabled") + ">"
          + esc(Q.summary.confirmLabel) + "</button>")
      + "</div>";
  }

  /**
   * The collapsed disclosure. The ONLY place database language is allowed.
   *
   * `class="technical"` is load-bearing: the regression strips exactly this element and then holds
   * the rest of the card to a vocabulary a non-technical reader can follow. Without a marked
   * boundary the two surfaces are one string and the rule cannot be checked at all.
   */
  function technical(cap, S) {
    const p = S.proposal(cap.id);
    const m = p.merged;
    const line = (label, value) => "<dt>" + esc(label) + "</dt><dd>" + value + "</dd>";
    const rows = [
      line("Coverage basis", m.coverage === null ? "<i>left open</i>"
        : m.coverage.kind === "none" ? "no year dimension &mdash; " + esc(m.coverage.reason)
        : "<code>" + esc(m.coverage.table + "." + m.coverage.yearColumn) + "</code>"),
      line("Integrity rules", m.integrity === null ? "<i>left open</i>"
        : '<ul style="margin:0;padding-left:16px">' + m.integrity.map((r) => "<li>" + esc(r) + "</li>").join("") + "</ul>"),
      line("Availability", m.availability === null ? "<i>left open</i>"
        : m.availability.kind === "always" ? "always expected"
        : "conditional &mdash; " + esc(m.availability.condition)),
      line("Receipt owner", m.receiptOwner === null ? "<i>left open</i>" : esc(m.receiptOwner)),
    ].join("");

    return '<details class="technical"><summary>' + esc(Q.card.technicalHeading) + "</summary>"
      + '<div class="body">'
      + "<p>" + esc(Q.card.technicalNote) + "</p>"
      + "Identifier <code>" + esc(cap.id) + "</code><br/>"
      + "Data source <code>" + esc(cap.artifact) + "</code><br/>"
      + "Reads " + cap.reads.map((t) => "<code>" + esc(t) + "</code>").join(" ")
      + "<br/>Columns: " + Object.keys(cap.columns).map((t) =>
        esc(t) + " (" + cap.columns[t].map(esc).join(", ") + ")").join(" &middot; ")
      + (cap.ownerCandidates.length
        ? "<br/>Scripts mentioning every one of these tables (a filename search, not an answer): "
          + cap.ownerCandidates.map((o) => "<code>" + esc(o) + "</code>").join(" ")
        : "")
      + (cap.conditionalHint ? '<p class="observed">Observed: ' + esc(cap.conditionalHint) + "</p>" : "")
      + '<p class="observed">Recorded mapping</p><dl class="mapping">' + rows + "</dl>"
      + "</div></details>";
  }

  return { primary: primary, summaryPanel: summaryPanel, technical: technical, esc: esc };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createStage2bCard: createStage2bCard };
}
