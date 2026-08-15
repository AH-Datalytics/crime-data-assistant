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
function createStage2bPlainLanguage() {
  const UNSURE = "unsure";

  /** What each artifact is, in the words someone asking a question would use. */
  const ARTIFACTS = {
    crime_data: "recent crime trends and the long-running FBI series",
    nibrs: "detailed incident-level FBI data (NIBRS)",
    shr: "homicide records (the Supplementary Homicide Reports)",
    hate_crime: "hate crime records",
  };

  /**
   * The update processes a policy owner would recognise, per artifact.
   *
   * Labels, not filenames: "who keeps this fresh" is answered by naming a process, and a policy
   * owner knows the monthly update, not `update-rtci.py`. The candidate filenames stay visible as
   * evidence under technical details, where they are what they actually are -- a filename search.
   */
  const PROCESSES = {
    crime_data: [
      "The monthly crime-trends update",
      "The historical FBI series load",
      "The agency population refresh",
    ],
    nibrs: [
      "The annual NIBRS rebuild",
      "The NIBRS summary and rollup build",
    ],
    shr: ["The homicide (SHR) import"],
    hate_crime: ["The hate crime import"],
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

  /** The user-facing question this capability answers, in ordinary language. */
  function describeQuestion(cap) {
    const subject = cap.reads.map(tablePhrase).join(", ");
    const where = ARTIFACTS[cap.artifact] || cap.artifact;
    return "When someone asks about " + where + ", this is the lookup that answers using "
      + (subject || "no data") + ".";
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
        label: "Yes — the data records which year each record belongs to",
        consequence: "If someone asks about years this data does not cover, the answer can say so"
          + " instead of returning a confident number.",
        recommended: true,
        why: "Observed: this lookup reads a column named " + recommended.table + "." + recommended.yearColumn
          + ", which is named like a year. That it is named like a year is a fact about the name, not"
          + " a check that it holds years — which is why you are being asked.",
      });
    }
    options.push({
      value: "no-years",
      label: "No — this answer is not about a time period",
      consequence: "No year check will be run for this lookup, and nothing will claim one was.",
      recommended: !recommended,
      why: recommended
        ? "Choose this if the column named like a year is not what the answer is bounded by."
        : "Observed: no column this lookup reads is named like a year, so there may be nothing to bound.",
    });
    options.push({
      value: UNSURE,
      label: "I'm not sure",
      consequence: "Recorded as undecided. Nothing is assumed, and this lookup stays unauthorised.",
      recommended: false,
      why: "Leaving it open is a real answer; a guess recorded as a decision is not.",
    });
    return options;
  }

  /**
   * Integrity asked as a scenario, because "what integrity rule applies" is not a question anyone
   * can answer cold. Each choice becomes a sentence in the record; none becomes an executable check,
   * and the workbook never asks for one.
   */
  function integrityScenarios(cap) {
    const first = cap.reads[0] ? tablePhrase(cap.reads[0]) : "this data";
    const scenarios = [
      {
        value: "stale",
        label: "It quietly stops being updated, but still looks current",
        prose: "The " + first + " must not stop advancing while still appearing current: if the source has newer data, this must too.",
      },
      {
        value: "missing",
        label: "Some agencies or places are missing without saying so",
        prose: "Coverage of " + first + " must not silently lose agencies or places; a smaller answer must be explainable.",
      },
      {
        value: "double",
        label: "The same event is counted more than once",
        prose: "Records in " + first + " must not double-count the same event.",
      },
    ];
    if (cap.reads.length > 1) {
      scenarios.push({
        value: "disagree",
        label: "Two parts of this data disagree when they should match",
        prose: cap.reads.map(tablePhrase).join(" and ") + " must agree where they overlap.",
      });
    }
    return scenarios;
  }

  function availabilityOptions() {
    return [
      { value: "always", label: "Always — it should be there every time",
        consequence: "If it is ever missing, that is treated as a fault worth reporting." },
      { value: "sometimes", label: "Sometimes — there are situations where it is legitimately absent",
        consequence: "When it is absent for the reason you give, that is expected rather than a fault." },
      { value: UNSURE, label: "I'm not sure",
        consequence: "Recorded as undecided. Nothing is assumed about whether absence is a fault." },
    ];
  }

  function ownerOptions(cap) {
    const processes = PROCESSES[cap.artifact] || [];
    return processes.map((label) => ({ value: label, label: label }))
      .concat([{ value: "other", label: "Another process — name it" },
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
    proposeMapping: proposeMapping,
    mappingFingerprint: mappingFingerprint,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createStage2bPlainLanguage: createStage2bPlainLanguage };
}
