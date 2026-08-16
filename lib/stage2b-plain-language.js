/**
 * Turns a capability's OBSERVED structure into questions a policy owner can answer.
 *
 * Plain browser-compatible JavaScript, inlined verbatim into the workbook and imported by the
 * importer and the regression suite, so the page's proposal and the boundary's expectation are
 * computed by the same code and cannot drift.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a human answer is never silently translated into technical
 * policy. Everything here PROPOSES; the proposal is shown, and it becomes policy only when the
 * person confirms that specific proposal. Nothing here decides, and nothing here is pre-selected --
 * a recommendation that arrived already chosen would be an inference wearing a human's signature.
 *
 * WHAT THE PERSON IS ASKED ABOUT IS THE SUBJECT MATTER, NEVER THE DATABASE. An earlier version of
 * this asked which column bounded an answer's years, and made a person justify picking one whose
 * name did not look like a year. That is not a judgment anybody outside engineering can make, and
 * putting it in front of the one person whose judgment was actually needed was the defect: it
 * turned a decision about crime data into a quiz about schemas. Choosing what to read is done
 * automatically here, and where it cannot be, that is recorded as engineering's follow-up and said
 * so plainly -- never handed back as a question.
 *
 * Every string a person reads lives in this file or in the catalog, so the decision contract's
 * fingerprint covers it. A sentence rendered from the page template would be wording nobody's
 * confirmation was ever checked against.
 */
function createStage2bPlainLanguage(capabilityCatalog) {
  const UNSURE = "unsure";
  /**
   * What each capability answers, who plausibly maintains it, and which failures are worth asking
   * about -- hand-authored per capability in `lib/stage2b-capability-catalog.js`.
   *
   * Required, not optional. Paraphrasing table names gave three different NIBRS capabilities the
   * same description, and offered every crime_data capability all three update processes, so the
   * only way to tell them apart was the technical detail this layer exists to spare people.
   */
  const CATALOG = capabilityCatalog || stage2bCapabilityCatalog();

  /**
   * EVERY WORD THE PERSON READS ON THE DECIDING PATH.
   *
   * It lives here rather than in the page template so it is part of the decision contract that the
   * workbook fingerprint covers. While headings sat in the generator's HTML, a question could be
   * reworded -- changing what someone was actually asked -- without invalidating a confirmation.
   */
  const QUESTIONS = {
    card: {
      answersHeading: "What question will this help answer?",
      exampleLabel: "Someone might ask:",
      decisionHeading: "What decision are you making?",
      choicesHeading: "What happens with each choice?",
      recommendationLabel: "Our recommendation",
      recommendationNote: "A recommendation, not a selection. Nothing is chosen until you choose it.",
      technicalHeading: "Technical details",
      technicalNote: "Nothing in here is yours to decide. It is what the code already does, kept"
        + " visible so the answers above can be checked against it.",
      followUpHeading: "Left with engineering",
      unfinishedNote: "Saved as unfinished. Nothing is switched on.",
    },
    year: {
      heading: "1. Can someone reasonably ask this question for a particular year?",
      decision: "You are deciding whether the chatbot should turn down a request for a year this"
        + " data does not go back to, or answer without looking at the year at all.",
      options: {
        years: {
          label: "Yes — year matters for this answer.",
          consequence: "The chatbot should refuse years earlier than the first available year or"
            + " later than the last available year. This protection does not detect a missing year"
            + " inside that range.",
        },
        "no-years": {
          label: "No — this question is not about a particular year.",
          consequence: "No year-range protection will be applied. Choose this for directories and"
            + " lists such as “Which agencies exist?”",
        },
        unsure: {
          label: "I’m not sure.",
          consequence: "Your answer is saved as unfinished and nothing is enabled.",
        },
      },
      /**
       * Recorded when the person says a year matters and the technical basis is not settled.
       *
       * Two different situations, said differently, because "there is nothing to read" and "there
       * are several and nobody has said which" are not the same fact and a reader who is told the
       * wrong one cannot tell what is actually outstanding.
       */
      followUp: {
        none: "You said a year matters here, and this answer does not currently read a date."
          + " Working out what it should read is an engineering job, not yours. It has been written"
          + " down as one, and no year check will run until it is done.",
        ambiguous: "You said a year matters here. This answer reads more than one date, and which"
          + " of them it should be bounded by has not been reviewed. Settling that is an engineering"
          + " job, not yours. It has been written down as one, and no year check will run until it"
          + " is done — nothing will be guessed in the meantime.",
      },
      /** The reason recorded when someone says the question is not about a year. */
      noneReason: "Answered in the workbook: this question is not asked about a particular year.",
    },
    trust: {
      heading: "2. What should the chatbot do if one of these problems is detected?",
      decision: "For each possible problem, choose the response the chatbot should take. You are"
        + " setting the policy; this is not a test with a predetermined correct answer.",
      note: "These checks have not been implemented yet, so this records a requirement and does not"
        + " activate anything.",
      /**
       * FOUR COMPLETE RESPONSES, one required per problem.
       *
       * This was a row of checkboxes asking which problems "would make you unwilling to show this
       * answer without warning". A tick conflated the problem with the response to it, and -- worse
       * -- an untidied box was read as a decision that the problem did not matter. It could not
       * express "warn but still answer", it could not express "this genuinely needs no special
       * handling", and it could not tell either of those from "nobody has looked at this yet".
       */
      actions: {
        refuse: {
          label: "Do not answer.",
          consequence: "The chatbot should refuse to provide the result when this problem is detected.",
        },
        warn: {
          label: "Answer with a clear warning.",
          consequence: "The chatbot may provide the result, but must prominently explain this problem.",
        },
        none: {
          label: "No special handling.",
          consequence: "This problem should not, by itself, change the answer.",
        },
        unsure: {
          label: "I’m not sure.",
          consequence: "Save this part as unfinished and enable nothing that depends on it.",
        },
      },
      bulk: {
        none: "Mark all as “No special handling”",
        unsure: "Mark all as “I’m not sure”",
        note: "A shortcut, not a default. Nothing is chosen until you press one.",
      },
      otherHeading: "Another problem not listed",
      otherLabel: "Describe the problem",
      otherHint: "Leave this empty if there is nothing to add. If you describe one, choose what the"
        + " chatbot should do about it.",
      /** Recorded when a chosen response is not something the system can carry out yet. */
      followUp: "Some of what you chose describes behaviour the system cannot carry out yet —"
        + " showing a warning, or deliberately leaving a problem alone. Your choices are recorded"
        + " exactly as you made them and written down as an engineering job. Nothing here changes"
        + " what the chatbot does until that is built.",
    },
    availability: {
      heading: "3. If this data is missing, does that mean something is broken?",
      decision: "You are deciding how the chatbot should react when this data is not there at all.",
      options: {
        always: {
          label: "Yes — it should normally be available.",
          consequence: "Missing data should be treated as a problem that needs attention.",
        },
        sometimes: {
          label: "No — it can legitimately be unavailable sometimes.",
          consequence: "The chatbot should say the answer is unavailable, rather than reporting a"
            + " system failure.",
        },
        unsure: {
          label: "I’m not sure.",
          consequence: "Your answer is saved as unfinished and nothing is enabled.",
        },
      },
      whenLabel: "When is it fine for this to be unavailable?",
      whenHint: "In ordinary words — for example, “only some states send this, so it is"
        + " missing for the rest”.",
    },
    responsibility: {
      heading: "4. Who should be contacted if this data is missing or out of date?",
      decision: "You are recording who to go to. This is an accountability fact, not a technical"
        + " ownership setting, and naming someone switches nothing on.",
      otherLabel: "Someone else — who?",
      otherOption: "Someone else",
      /**
       * "Nobody here" is a REAL ANSWER, and there was no way to give it.
       *
       * Asked for the first county question in the pilot, the honest response was "the agencies are
       * responsible for submitting their data, not us" -- which had to be typed into "Something
       * else", where it was stored as though it named a contact to chase. It is a common position
       * for anything sourced from outside, and it deserves stating positively rather than as an
       * escape-hatch sentence that the record then misreads.
       */
      notOursOption: "Nobody here — whoever reports this data is responsible for it, not us.",
      notOursOwner: "No internal owner: the organisations that report this data are responsible for"
        + " submitting it.",
      unsureLabel: "I’m not sure.",
    },
    /**
     * NOT "how do you know these answers are right?".
     *
     * That asked the policy owner to prove their own judgment, to an authority that does not exist:
     * these are governance decisions, and the person answering IS the authority. It also blocked a
     * perfectly good decision from being recorded until someone wrote a sentence about it. Notes
     * are for a future reader, they are optional, and leaving them empty blocks nothing.
     */
    notes: {
      heading: "Optional notes for future reviewers",
      hint: "Add context only if it would help someone understand your decision later.",
    },
    summary: {
      heading: "What your answers mean",
      hint: "In ordinary words, this is what your answers would record. Nothing is saved until you"
        + " confirm it, and changing an answer above cancels the confirmation so you get to read the"
        + " new version.",
      confirmLabel: "I understand what these choices will make the chatbot do, and I am recording"
        + " them as the policy owner",
      confirmedNote: "Confirmed. This is what your export will carry.",
      beforeConfirm: "Before this can be confirmed:",
      reworded: "You confirmed this before, but the wording has changed since. Your answer is still"
        + " here — please read it again and confirm it.",
      labels: {
        year: "Years",
        trust: "When not to trust it",
        availability: "If it is missing",
        responsibility: "Who to go to",
      },
      unanswered: "Not decided yet. Nothing will change, and this stays switched off.",
      /**
       * What a KEPT value says, instead of the value itself.
       *
       * Anything already recorded was written by someone else, possibly long before this workbook
       * existed, in whatever words they used. One of them reads "this capability is unavailable in
       * production ... the builder decides at runtime", and pasting it into the plain-language
       * summary put exactly the vocabulary this page exists to remove back on the deciding path.
       * Hiding it would be worse, so it is not hidden -- it is one disclosure away, and what the
       * reader is told here is the thing that actually concerns them: their answer changes nothing.
       */
      keptDetail: "Something was recorded here before, and your answer leaves it exactly as it was."
        + " You can read the wording that was used under Technical details.",
      year: {
        years: "If someone asks about a year outside what this data covers, the chatbot will say so"
          + " instead of answering. It will not notice a year missing inside the range.",
        "no-years": "The chatbot will not check the year before answering.",
      },
      /**
       * One sentence per problem, saying what the chatbot would DO. A list of rule prose describes
       * the record; this describes the behaviour, which is the thing being decided.
       */
      trustAction: {
        refuse: "Refuse to answer if %s.",
        warn: "Show a clear warning if %s.",
        none: "No special handling is required when %s.",
        unsure: "Not decided yet: %s.",
      },
      trustNote: "Nothing checks any of these yet. They are recorded as requirements.",
      trustFollowUp: "Engineering follow-up: %s recorded but not implemented.",
      trustFollowUpWarn: "warning behaviour",
      trustFollowUpNone: "deliberate no-special-handling",
      availability: {
        always: "If this data goes missing, that is treated as a problem worth raising.",
        sometimes: "When this is missing because %s, the chatbot should say the answer is"
          + " unavailable rather than report a fault.",
      },
      /** A process cannot be contacted; it can be investigated. The label reads inside the sentence. */
      responsibility: "If this goes missing or becomes outdated, investigate %s.",
      responsibilityNotOurs: "Nobody here is responsible for chasing this — whoever reports the data"
        + " is. If it goes missing or becomes outdated, that is theirs to put right, not ours.",
    },
    withdraw: {
      heading: "Remove what was recorded for this question",
      hint: "Something was already recorded here. Removing it is a separate, named action —"
        + " leaving the questions above unanswered does NOT delete it.",
      button: "Remove what was recorded…",
      marked: "Marked for removal. Exporting and importing will remove what was recorded.",
      confirm: "Remove what was recorded for this question?",
      confirmDetail: "Exporting and importing will REMOVE it. This is not the same as leaving the"
        + " questions unanswered.",
    },
    page: {
      unsavedWarning: "Your answers live only in this tab until you press Export answers. Nothing"
        + " here changes any system, switches anything on, or reaches the internet. Export every few"
        + " answers — a closed tab or a browser crash takes unexported work with it.",
      filters: {
        all: "All questions",
        unanswered: "Not yet answered",
        unconfirmed: "Answered, not yet confirmed",
        problems: "Needs something added",
        followUp: "Waiting on engineering",
      },
      counts: { finished: "Finished", awaiting: "Awaiting confirmation", needsFixing: "Needs something added" },
      buttons: {
        load: "Load a saved session", exportAnswers: "Export answers",
        prev: "Previous", next: "Next", nextUnanswered: "Next unanswered",
        cluster: "Copy these answers to similar questions…",
      },
      dirty: { unsaved: "Unsaved — export to keep your answers", nothing: "Nothing to save yet", saved: "Saved: %s exported" },
      cluster: {
        heading: "Copy to similar questions",
        note: "Every question that would change is named below. Each one keeps its own summary,"
          + " which you will need to read and confirm separately. Nothing is copied until you confirm.",
        none: "There are no answers here to copy yet.",
        intro: "Copy your answers to %n other question(s) answered from %s.",
        scope: {
          sameRecords: "the same underlying records",
          sameSource: "the same data source",
        },
        cancel: "Cancel", apply: "Copy to these",
        overwrites: "replaces answers already given there",
        cleared: "its confirmation will be cancelled, so you must read and confirm it again",
      },
      allAnswered: "Every question in this view has been answered.",
    },
  };

  /** A readable phrase for a table name. An approximation of meaning, never a substitute for it. */
  const WORDS = {
    agency: "agency", agencies: "agencies", monthly: "monthly", victim: "victim", victims: "victim",
    state: "state", city: "city", national: "national", population: "population",
    clearance: "case-clearance", arrestee: "arrestee", offender: "offender",
    demographics: "demographics", incidents: "incidents", incident: "incident",
    circumstance: "circumstance", juvenile: "juvenile", crosswalk: "county lookup",
    completeness: "reporting completeness", consistent: "consistent-reporter", reporters: "list",
    sample: "sample", staffing: "police staffing", crime: "crime", participation: "participation",
    detail: "detail", type: "type", summary: "counts", carjacking: "carjacking",
  };
  /** "It quietly stops being updated" -> "it quietly stops being updated", for "Refuse to answer if …". */
  function lowerFirst(text) {
    const s = String(text || "");
    return s.charAt(0).toLowerCase() + s.slice(1);
  }

  function tablePhrase(table) {
    const bare = String(table).replace(/^rollup\./, "").replace(/^(summary|historical)_/, "");
    const words = bare.split("_").map((w) => WORDS[w] || w).filter(Boolean);
    return words.join(" ");
  }

  /**
   * The user-facing question this capability answers, and one realistic asking of it.
   *
   * Read from the catalog, never paraphrased from table names. A capability with no catalog entry
   * gets no description at all rather than a generic one, and generation refuses to produce a
   * workbook in that state -- a description that fits three capabilities equally is worse than an
   * obviously missing one, because it looks like an answer.
   */
  function describeQuestion(cap) {
    const question = CATALOG.question(cap.id);
    if (question) return question;
    return "NO DESCRIPTION: this capability is missing from the reviewed catalog.";
  }
  function exampleAsking(cap) {
    return CATALOG.example(cap.id) || "";
  }

  /**
   * Which dated thing this answer would be bounded by -- chosen automatically ONLY when there is
   * nothing to choose between.
   *
   * THIS IS WHERE A GUESS HID. It used to prefer whatever was read first and otherwise take the
   * first of the list, which is a choice dressed as a lookup. Twenty-three of the fifty-two
   * questions read more than one dated field, and for a consistent-reporter question that silently
   * bounded the answer by `nibrs_consistent_reporters.end_year` -- the end of the span a department
   * reported over -- instead of the year the counts belong to. The person would have confirmed a
   * confident-looking decision derived from the wrong data, and nothing on the page or in the
   * record would have said which field it came from.
   *
   * So: one candidate, use it. More than one, use only a basis someone has actually reviewed and
   * written down. Otherwise none, and the answer becomes an engineering follow-up. Fail-closed, and
   * never a question for the person answering -- picking between two dated fields is not a judgment
   * about crime data.
   */
  function yearBasisStatus(cap) {
    const marked = cap.coverageCandidates.filter((o) => o.yearBearing);
    if (marked.length === 0) return { basis: null, status: "none" };
    if (marked.length === 1) return { basis: marked[0], status: "unambiguous" };
    /**
     * A reviewed basis, from the catalog. Nothing declares one today: no engineer has reviewed
     * which dated field bounds these answers, so nothing is chosen for them.
     */
    const reviewed = CATALOG.yearBasis(cap.id);
    const match = reviewed && marked.find(
      (o) => o.table === reviewed.table && o.yearColumn === reviewed.yearColumn);
    return match ? { basis: match, status: "reviewed" } : { basis: null, status: "ambiguous" };
  }
  /** The basis itself, or null when there is not exactly one and none has been reviewed. */
  function automaticYearBasis(cap) { return yearBasisStatus(cap).basis; }

  /**
   * The recommendation for the year question: capability-specific, reasoned, never selected.
   *
   * It comes from the catalog -- from what the question is ABOUT -- and not from whether a dated
   * column happens to exist. Letting the data's shape drive it would dress a technical gap up as a
   * human judgment, and the person would have no way to tell the two apart.
   */
  function yearRecommendation(cap) {
    const advice = CATALOG.yearAdvice(cap.id);
    if (!advice) return null;
    const option = QUESTIONS.year.options[advice.recommend === "yes" ? "years" : "no-years"];
    return { value: advice.recommend === "yes" ? "years" : "no-years", answer: advice.recommend === "yes" ? "Yes" : "No",
      label: option.label, why: advice.why };
  }

  function yearOptions(cap) {
    const recommended = yearRecommendation(cap);
    return ["years", "no-years", UNSURE].map((value) => ({
      value: value,
      label: QUESTIONS.year.options[value].label,
      consequence: QUESTIONS.year.options[value].consequence,
      recommended: !!recommended && recommended.value === value,
    }));
  }

  /** The failures worth asking about for THIS data, from the catalog rather than a generic set. */
  function trustScenarios(cap) {
    return CATALOG.scenarios(cap.id);
  }

  function availabilityOptions() {
    return ["always", "sometimes", UNSURE].map((value) => ({
      value: value,
      label: QUESTIONS.availability.options[value].label,
      consequence: QUESTIONS.availability.options[value].consequence,
    }));
  }

  /**
   * Only the update processes that could plausibly be contacted about THIS answer.
   *
   * Offering every process for the data source meant a policy owner had to open the technical
   * details to work out which one applied, which defeated the whole human-facing layer.
   */
  function responsibilityOptions(cap) {
    const processes = CATALOG.processLabels(cap.id);
    return processes.map((label) => ({ value: label, label: label }))
      .concat([{ value: "not-ours", label: QUESTIONS.responsibility.notOursOption },
        { value: "other", label: QUESTIONS.responsibility.otherOption },
        { value: UNSURE, label: QUESTIONS.responsibility.unsureLabel }]);
  }

  function blankAnswer() {
    return {
      coverage: null,
      /** problem -> one of refuse / warn / none / unsure. An ABSENT key is not a decision. */
      trust: {}, trustOther: "", trustOtherAction: null,
      availability: null, availabilityWhen: "",
      owner: null, ownerOther: "",
      notes: "",
    };
  }

  const ACTIONS = ["refuse", "warn", "none", "unsure"];
  /** Actions the technical policy can express today. Everything else is engineering's to build. */
  const REPRESENTABLE = ["refuse"];

  const answered = (human) => !!human && (human.coverage !== null || human.availability !== null
    || human.owner !== null || Object.keys(human.trust || {}).length > 0
    || String(human.trustOther || "").trim() !== "" || human.trustOtherAction !== null
    || String(human.notes || "").trim() !== "");

  /**
   * What the person has said about each problem, as a list -- including the one they wrote.
   *
   * `action: null` means UNANSWERED. It is deliberately not the same value as "none", because an
   * unticked box being read as "this does not matter" is the defect this replaced.
   */
  function trustRows(cap, human) {
    const h = human || blankAnswer();
    const chosen = h.trust || {};
    const rows = trustScenarios(cap).map((s) => ({
      value: s.value, label: s.label, prose: s.prose,
      action: ACTIONS.indexOf(chosen[s.value]) >= 0 ? chosen[s.value] : null,
      custom: false,
    }));
    const described = String(h.trustOther || "").trim();
    if (described) {
      rows.push({ value: "__other", label: described, prose: described,
        action: ACTIONS.indexOf(h.trustOtherAction) >= 0 ? h.trustOtherAction : null, custom: true });
    }
    return rows;
  }

  /**
   * The technical policy a set of human answers WOULD produce.
   *
   * Returned for display and confirmation, never applied. "I'm not sure" produces null, which is the
   * fail-closed value: recorded as asked-and-open, authorising nothing.
   *
   * `followUps` names what is unresolved through no fault of the person answering. A year answer
   * with nothing dated to read is engineering's to close, and it still produces no policy -- open
   * either way, but the page must not tell someone they left a question open when they did not.
   */
  function proposeMapping(cap, human) {
    const h = human || blankAnswer();
    /**
     * `evidence` carries the person's optional notes and NOTHING ELSE.
     *
     * Empty is a legitimate, complete answer. Nothing is synthesised into it -- no "verified", no
     * "confirmed with", no restatement of their choices dressed up as a citation. A record that
     * claims a decision was corroborated when nobody said so is worse than one that says nothing.
     */
    const proposed = { coverage: null, integrity: null, availability: null, receiptOwner: null,
      evidence: String(h.notes || "") };
    const unresolved = [];
    const followUps = [];
    /** What the PERSON has not decided, as opposed to what the system cannot yet express. */
    const unanswered = [];

    let followUpReason = null;
    if (h.coverage === "years") {
      const chosen = yearBasisStatus(cap);
      if (chosen.basis) {
        proposed.coverage = { kind: "column", table: chosen.basis.table, yearColumn: chosen.basis.yearColumn };
      } else {
        unresolved.push("coverage");
        followUps.push("coverage");
        followUpReason = chosen.status;
      }
    } else if (h.coverage === "no-years") {
      proposed.coverage = { kind: "none", reason: QUESTIONS.year.noneReason };
    } else { unresolved.push("coverage"); unanswered.push("coverage"); }

    /**
     * EVERY listed problem needs an explicit response, and only "do not answer" can be expressed.
     *
     * A missing response is unanswered, never "no special handling" -- reading an untouched control
     * as a decision is exactly what the checkboxes did. "I'm not sure" is unanswered too: it is
     * human uncertainty, not work for engineering. "Warn" and a deliberate "no special handling"
     * ARE decisions, and they are recorded as made; the technical policy simply cannot carry them
     * out yet, which is engineering's problem and is named as one rather than quietly rewritten
     * into a rule that means something else.
     */
    const rows = trustRows(cap, h);
    const undecided = rows.filter((r) => r.action === null || r.action === UNSURE);
    if (undecided.length) { unresolved.push("integrity"); unanswered.push("integrity"); }
    else {
      const rules = rows.filter((r) => r.action === "refuse").map((r) => r.prose);
      if (rules.length) proposed.integrity = rules;
      else unresolved.push("integrity");
      if (rows.some((r) => REPRESENTABLE.indexOf(r.action) < 0)) followUps.push("integrity");
    }

    if (h.availability === "always") proposed.availability = { kind: "always" };
    else if (h.availability === "sometimes") {
      proposed.availability = { kind: "conditional", condition: String(h.availabilityWhen || "").trim() };
    } else { unresolved.push("availability"); unanswered.push("availability"); }

    if (h.owner === "other") {
      const named = String(h.ownerOther || "").trim();
      if (named) proposed.receiptOwner = named;
      else { unresolved.push("receiptOwner"); unanswered.push("receiptOwner"); }
    } else if (h.owner === "not-ours") {
      /** A decision, recorded as one. Not an absence, and not a sentence typed into "Something else". */
      proposed.receiptOwner = QUESTIONS.responsibility.notOursOwner;
    } else if (h.owner && h.owner !== UNSURE) proposed.receiptOwner = h.owner;
    else { unresolved.push("receiptOwner"); unanswered.push("receiptOwner"); }

    return { proposed: proposed, unresolved: unresolved, unanswered: unanswered,
      followUps: followUps, followUpReason: followUpReason };
  }

  /**
   * What would actually be RECORDED: the new answers, over whatever is already there.
   *
   * An unresolved answer must not destroy an existing decision. The human controls start blank even
   * where policy already exists, so answering "I'm not sure" and citing evidence produced four
   * nulls -- and the importer wrote them over a complete existing entry and reported success. A
   * capability that had been decided became undecided, with no withdrawal and nothing named.
   *
   * So an unresolved field KEEPS what is there, and the page shows which fields are being kept
   * rather than set. Removing a decision stays a separate, named act: withdrawal, which names the
   * capability and asks for confirmation.
   */
  function mergeWithExisting(proposed, existing) {
    const prior = existing || null;
    const merged = {
      coverage: proposed.coverage, integrity: proposed.integrity,
      availability: proposed.availability, receiptOwner: proposed.receiptOwner,
      evidence: proposed.evidence || "",
    };
    const preserved = [];
    if (prior) {
      for (const field of ["coverage", "integrity", "availability", "receiptOwner"]) {
        if (merged[field] === null && prior[field] !== null && prior[field] !== undefined) {
          merged[field] = prior[field];
          preserved.push(field);
        }
      }
    }
    return { merged: merged, preserved: preserved };
  }

  /**
   * What the answers MEAN, in the words someone would use to describe the behaviour.
   *
   * The technical mapping says `{ kind: "column", table, yearColumn }`; this says the chatbot will
   * turn down a year it does not have. A person confirming the first is confirming a shape, not an
   * outcome -- so the outcome is what is put in front of them, and the shape stays one disclosure
   * away for whoever wants to check it.
   */
  function plainSummary(cap, human, merged, preserved, followUps, followUpReason) {
    const h = human || blankAnswer();
    const kept = preserved || [];
    const S = QUESTIONS.summary;
    const followed = (followUps || []).indexOf("coverage") >= 0;
    const rows = [];

    /**
     * A kept value is described, never quoted. See `summary.keptDetail`: what is already recorded
     * was written by someone else in their words, and pasting those words here is how database
     * language got back onto the deciding path.
     */
    const row = (field, label, text) => {
      const isKept = kept.indexOf(field) >= 0;
      rows.push({ field: field, label: label, text: isKept ? S.keptDetail : text,
        kept: isKept, followUp: false });
    };

    const yearText = followed ? QUESTIONS.year.followUp[followUpReason || "none"]
      : h.coverage === "years" && merged.coverage ? S.year.years
      : h.coverage === "no-years" ? S.year["no-years"]
      : merged.coverage ? S.year[merged.coverage.kind === "none" ? "no-years" : "years"]
      : S.unanswered;
    if (kept.indexOf("coverage") >= 0) row("coverage", S.labels.year, yearText);
    else rows.push({ field: "coverage", label: S.labels.year, text: yearText, kept: false, followUp: followed });

    /**
     * One sentence per problem, in the order they were asked, saying what the chatbot would DO.
     *
     * Built from the person's own answer rather than from the derived rules, because the derived
     * rules only contain the refusals -- a summary built from those would silently drop every
     * "warn" and every deliberate "no special handling", which is precisely the intent this is
     * supposed to preserve.
     */
    const rows2 = trustRows(cap, h);
    const decided = rows2.filter((r) => r.action !== null);
    const trustText = !decided.length ? S.unanswered
      : decided.map((r) => S.trustAction[r.action].replace("%s", lowerFirst(r.label))).join(" ")
        + " " + S.trustNote
        + (rows2.some((r) => r.action === "warn")
          ? " " + S.trustFollowUp.replace("%s", S.trustFollowUpWarn) : "")
        + (rows2.some((r) => r.action === "none")
          ? " " + S.trustFollowUp.replace("%s", S.trustFollowUpNone) : "");
    row("integrity", S.labels.trust, trustText);

    row("availability", S.labels.availability, !merged.availability ? S.unanswered
      : merged.availability.kind === "always" ? S.availability.always
      : S.availability.sometimes.replace("%s", merged.availability.condition || "—"));

    row("receiptOwner", S.labels.responsibility,
      h.owner === "not-ours" ? S.responsibilityNotOurs
        : merged.receiptOwner ? S.responsibility.replace("%s", merged.receiptOwner)
        : S.unanswered);

    return rows;
  }

  /**
   * Everything currently sitting with engineering, in the person's terms.
   *
   * Kept apart from what the person has not decided. Mixing them would tell someone they had left
   * work undone when the outstanding thing is a system that cannot yet do what they asked for.
   */
  function followUpMessages(followUps, followUpReason) {
    const list = followUps || [];
    const out = [];
    if (list.indexOf("coverage") >= 0) out.push(QUESTIONS.year.followUp[followUpReason || "none"]);
    if (list.indexOf("integrity") >= 0) out.push(QUESTIONS.trust.followUp);
    return out;
  }

  /**
   * A stable digest of a proposal, so a confirmation can be tied to the EXACT mapping confirmed.
   *
   * FNV-1a over canonical JSON: deterministic, dependency-free, and identical in the page and at
   * the boundary. It detects a changed proposal, which is all it is asked to do -- if the human
   * answer moves after the mapping was confirmed, the confirmation no longer matches and the
   * importer refuses it as stale rather than importing a mapping nobody looked at.
   */
  function canonical(proposed) {
    const p = proposed || {};
    return JSON.stringify([p.coverage ?? null, p.integrity ?? null, p.availability ?? null,
      p.receiptOwner ?? null, p.evidence || ""]);
  }
  function mappingFingerprint(proposed) {
    const text = canonical(proposed);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return ("0000000" + hash.toString(16)).slice(-8);
  }

  return {
    UNSURE: UNSURE,
    tablePhrase: tablePhrase,
    describeQuestion: describeQuestion,
    exampleAsking: exampleAsking,
    automaticYearBasis: automaticYearBasis,
    yearBasisStatus: yearBasisStatus,
    yearRecommendation: yearRecommendation,
    yearOptions: yearOptions,
    trustScenarios: trustScenarios,
    trustRows: trustRows,
    trustActions: () => ACTIONS.map((value) => ({
      value: value,
      label: QUESTIONS.trust.actions[value].label,
      consequence: QUESTIONS.trust.actions[value].consequence,
    })),
    followUpMessages: followUpMessages,
    availabilityOptions: availabilityOptions,
    responsibilityOptions: responsibilityOptions,
    blankAnswer: blankAnswer,
    isAnswered: answered,
    questions: () => QUESTIONS,
    plainSummary: plainSummary,
    /**
     * EVERYTHING a person would read for one capability, as data.
     *
     * The workbook fingerprint is taken over this for every capability, so any change to what is
     * asked, to the consequence attached to an answer, to the example, or to the recommendation and
     * its reason invalidates confirmations. All of them are read before deciding.
     */
    contractFor: (cap) => ({
      id: cap.id,
      question: describeQuestion(cap),
      example: exampleAsking(cap),
      recommendation: (() => { const r = yearRecommendation(cap); return r ? [r.value, r.answer, r.why] : null; })(),
      year: yearOptions(cap).map((o) => [o.value, o.label, o.consequence, !!o.recommended]),
      trust: trustScenarios(cap).map((s) => [s.value, s.label, s.prose]),
      trustActions: ACTIONS.map((a) => [a, QUESTIONS.trust.actions[a].label, QUESTIONS.trust.actions[a].consequence]),
      availability: availabilityOptions().map((o) => [o.value, o.label, o.consequence]),
      responsibility: responsibilityOptions(cap).map((o) => [o.value, o.label]),
    }),
    proposeMapping: proposeMapping,
    mergeWithExisting: mergeWithExisting,
    mappingFingerprint: mappingFingerprint,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createStage2bPlainLanguage: createStage2bPlainLanguage };
}
