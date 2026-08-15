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
 * Descriptions are derived from names, so they are approximations of meaning and are labelled as
 * such. The exact tables and columns are always one disclosure away, because the derivation is a
 * convenience and the structure is the fact.
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

  /** What each artifact is, in the words someone asking a question would use. */
  const ARTIFACTS = {
    crime_data: "recent crime trends and the long-running FBI series",
    nibrs: "detailed incident-level FBI data (NIBRS)",
    shr: "homicide records (the Supplementary Homicide Reports)",
    hate_crime: "hate crime records",
  };

  /**
   * The wording every capability shares: the question headings, the hints under them, and the
   * labels on the recorded summary.
   *
   * It lives HERE rather than in the page template so it is part of the decision contract that the
   * workbook fingerprint covers. While it sat in the generator's HTML, a question could be reworded
   * -- changing what someone was actually asked -- without invalidating a single confirmation.
   */
  const QUESTIONS = {
    coverage: {
      heading: "1. Do we know the first and last year this data covers?",
      hint: "If someone asks about a year we do not have, should the system be able to say so?"
        + " It can only check the first and last year — it will not notice a year missing in between,"
        + " so please do not rely on it for that.",
      reasonLabel: "If this is not about a time period, or you picked a column that is not named like a year, say why",
    },
    integrity: {
      heading: "2. What would make you stop trusting these numbers?",
      hint: "Tick anything that would mean people should not rely on this. Your answers get written"
        + " down in plain words as a description of what \"gone wrong\" looks like here —"
        + " nothing here builds an automatic check.",
      otherLabel: "Something else (optional)",
      unsureLabel: "I’m not sure",
    },
    availability: {
      heading: "3. Should this data always be there?",
      hint: "Some data is legitimately missing sometimes. Saying so means we treat it as expected"
        + " instead of raising it as a problem every time.",
      whenLabel: "When is it fine for this to be missing?",
    },
    owner: {
      heading: "4. Who keeps this data up to date?",
      hint: "If this stopped being refreshed, whose job would it be. Pick the update you would expect"
        + " to have run.",
      otherLabel: "What is it called?",
    },
    evidence: {
      heading: "What are you basing this on?",
      hint: "A sentence is enough: who you asked, what you read, or what you already know."
        + " Someone reading this later will use it to judge whether the decision still holds.",
    },
    mapping: {
      heading: "Check what gets written down",
      hint: "This is exactly what your answers would record. Nothing is saved until you confirm it,"
        + " and changing any answer above cancels the confirmation so you get to read the new version.",
      confirmLabel: "I have read this — confirm it",
      labels: {
        coverage: "Years",
        integrity: "What \"gone wrong\" looks like",
        availability: "Always there?",
        receiptOwner: "Kept up to date by",
      },
    },
  };

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

  /** A readable phrase for a table name. An approximation of meaning, never a substitute for it. */
  function tablePhrase(table) {
    const bare = String(table).replace(/^rollup\./, "").replace(/^(summary|historical)_/, "");
    const words = bare.split("_").map((w) => WORDS[w] || w).filter(Boolean);
    return words.join(" ");
  }

  /**
   * The user-facing question this capability answers.
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

  /**
   * The coverage question, asked as a question about the ANSWER rather than about a column.
   *
   * The recommendation comes from an observation -- some column this capability reads is named like
   * a year -- and says so. Every column stays reachable under technical details, because a year
   * column whose name the pattern missed must not become unanswerable, and because the mark is a
   * hint and hints are wrong sometimes.
   */
  function recommendedYearColumn(cap) {
    const marked = cap.coverageCandidates.filter((o) => o.yearBearing);
    if (marked.length === 0) return null;
    // Prefer a column on the first emitted table, so the basis sits on what the answer is read from.
    const primary = marked.find((o) => o.table === cap.reads[0]);
    return primary || marked[0];
  }

  function coverageOptions(cap) {
    const recommended = recommendedYearColumn(cap);
    const options = [];
    if (recommended) {
      options.push({
        value: "years",
        label: "Yes — we know the first and last year it covers",
        /**
         * The narrower, TRUE consequence. The check this answer switches on compares the requested
         * years against MIN and MAX of the column and nothing else, so it catches a request outside
         * the range and cannot see a year missing inside it. The question said the system could
         * notice "years this data does not cover", which promised gap detection that does not
         * exist: with rows for 2020 and 2022 and none for 2021, a request for 2021 passes.
         */
        consequence: "If someone asks about a year before the first one or after the last one, the system"
          + " can say we do not have it, instead of answering as though we did. It will NOT notice a year"
          + " missing in between.",
        recommended: true,
        why: "We can see that this data has a column called " + recommended.table + "." + recommended.yearColumn
          + ". The name looks like a year — but a name is not a promise about what is in it, which is"
          + " why we are asking you rather than assuming.",
      });
    }
    options.push({
      value: "no-years",
      label: "No — this is not about a time period at all",
      consequence: "No year check will run here, and nothing will pretend one did.",
      recommended: !recommended,
      why: recommended
        ? "Choose this if the year-looking column is not really what this answer is limited by."
        : "None of the columns this uses looks like a year, so there may be nothing to check against.",
    });
    options.push({
      value: UNSURE,
      label: "I'm not sure",
      consequence: "Written down as undecided. Nothing is assumed, and this stays switched off.",
      recommended: false,
      why: "Leaving it open is a real answer. A guess written down as a decision is not.",
    });
    return options;
  }

  /**
   * Integrity asked as a scenario, because "what integrity rule applies" is not a question anyone
   * can answer cold. Each choice becomes a sentence in the record; none becomes an executable check,
   * and the workbook never asks for one.
   */
  /** The failures worth asking about for THIS data, from the catalog rather than a generic set. */
  function integrityScenarios(cap) {
    return CATALOG.scenarios(cap.id);
  }

  function availabilityOptions() {
    return [
      { value: "always", label: "Yes — it should be there every time",
        consequence: "If it ever goes missing, that gets treated as a problem worth flagging." },
      { value: "sometimes", label: "No — there are good reasons it might be missing",
        consequence: "When it is missing for the reason you give, that counts as expected rather than a problem." },
      { value: UNSURE, label: "I'm not sure",
        consequence: "Written down as undecided. Nothing is assumed either way." },
    ];
  }

  /**
   * Only the update processes that could plausibly own THIS capability.
   *
   * Offering every process for the data source meant a policy owner had to open the technical
   * details to work out which one applied, which defeated the whole human-facing layer.
   */
  function ownerOptions(cap) {
    const processes = CATALOG.processLabels(cap.id);
    return processes.map((label) => ({ value: label, label: label }))
      .concat([{ value: "other", label: "Something else — tell us what" },
        { value: UNSURE, label: "I'm not sure" }]);
  }

  function blankAnswer() {
    return {
      coverage: null, coverageColumn: null, coverageReason: "",
      integrity: [], integrityOther: "", integrityUnsure: false,
      availability: null, availabilityWhen: "",
      owner: null, ownerOther: "",
      evidence: "",
    };
  }

  const answered = (human) => !!human && (human.coverage !== null || human.availability !== null
    || human.owner !== null || (human.integrity || []).length > 0 || human.integrityUnsure
    || String(human.integrityOther || "").trim() !== "" || String(human.evidence || "").trim() !== "");

  /**
   * The technical policy a set of human answers WOULD produce.
   *
   * Returned for display and confirmation, never applied. "I'm not sure" produces null, which is the
   * fail-closed value: recorded as asked-and-open, authorising nothing.
   */
  function proposeMapping(cap, human) {
    const h = human || blankAnswer();
    const proposed = { coverage: null, integrity: null, availability: null, receiptOwner: null, evidence: h.evidence || "" };
    const unresolved = [];

    if (h.coverage === "years") {
      const chosen = h.coverageColumn
        ? cap.coverageCandidates.find((o) => o.table === h.coverageColumn.table && o.yearColumn === h.coverageColumn.yearColumn)
        : recommendedYearColumn(cap);
      if (chosen) {
        proposed.coverage = { kind: "column", table: chosen.table, yearColumn: chosen.yearColumn };
        // An unmarked column chosen deliberately still has to say why; the sentence is the person's.
        if (!chosen.yearBearing) {
          proposed.coverage.justification = String(h.coverageReason || "").trim();
        }
      } else unresolved.push("coverage");
    } else if (h.coverage === "no-years") {
      proposed.coverage = { kind: "none", reason: String(h.coverageReason || "").trim() };
    } else unresolved.push("coverage");

    const rules = [];
    const catalog = integrityScenarios(cap);
    for (const value of h.integrity || []) {
      const scenario = catalog.find((s) => s.value === value);
      if (scenario) rules.push(scenario.prose);
    }
    if (String(h.integrityOther || "").trim()) rules.push(String(h.integrityOther).trim());
    if (rules.length && !h.integrityUnsure) proposed.integrity = rules;
    else unresolved.push("integrity");

    if (h.availability === "always") proposed.availability = { kind: "always" };
    else if (h.availability === "sometimes") {
      proposed.availability = { kind: "conditional", condition: String(h.availabilityWhen || "").trim() };
    } else unresolved.push("availability");

    if (h.owner === "other") {
      const named = String(h.ownerOther || "").trim();
      if (named) proposed.receiptOwner = named; else unresolved.push("receiptOwner");
    } else if (h.owner && h.owner !== UNSURE) proposed.receiptOwner = h.owner;
    else unresolved.push("receiptOwner");

    return { proposed: proposed, unresolved: unresolved };
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
    recommendedYearColumn: recommendedYearColumn,
    coverageOptions: coverageOptions,
    integrityScenarios: integrityScenarios,
    availabilityOptions: availabilityOptions,
    ownerOptions: ownerOptions,
    blankAnswer: blankAnswer,
    isAnswered: answered,
    questions: () => QUESTIONS,
    /**
     * EVERYTHING a person would read for one capability, as data.
     *
     * The workbook fingerprint is taken over this for every capability, so any change to what is
     * asked or to the consequence attached to an answer invalidates confirmations. Covering only
     * the per-capability catalog left the shared headings, the option labels and the consequences
     * outside the identity -- all of them things a person reads before deciding.
     */
    contractFor: (cap) => ({
      id: cap.id,
      question: describeQuestion(cap),
      coverage: coverageOptions(cap).map((o) => [o.value, o.label, o.consequence, o.why, !!o.recommended]),
      integrity: integrityScenarios(cap).map((s) => [s.value, s.label, s.prose]),
      availability: availabilityOptions().map((o) => [o.value, o.label, o.consequence]),
      owner: ownerOptions(cap).map((o) => [o.value, o.label]),
    }),
    proposeMapping: proposeMapping,
    mergeWithExisting: mergeWithExisting,
    mappingFingerprint: mappingFingerprint,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createStage2bPlainLanguage: createStage2bPlainLanguage };
}
