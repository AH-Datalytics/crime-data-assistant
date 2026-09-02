# P3.1a frozen cases v1 — Codex review

**Date:** 2026-09-01  
**Artifact:** `docs/superpowers/p3-1a/frozen-cases-v1.json`  
**Verified identity:** SHA-256 `2a2739cc9dcab7872537d6c22880d70ee5ec0e012362d2c6fb47f8346d69cc78`, 72,452 bytes  
**Verdict:** **REVISE BEFORE CANDIDATE IMPLEMENTATION OR STAGE EXECUTION**  
**Scope:** read-only artifact review. No predicate, candidate stage, model, corpus, or production execution.

## 1. What passes

The frozen artifact has:

- 63 unique case IDs;
- exactly 21 unique rule/source pairs;
- exactly one `positive`, `false_acceptance`, and `false_refusal` case for every pair;
- 21 positive/applicable and 42 negative/non-applicable expectations;
- 50 distinct question texts, with reuse represented by separate accountable case IDs;
- 21 explicit dual-purpose declarations rather than implicit double-counting;
- no populated observed-result field;
- the approved contract and BASE identity pinned correctly.

The Ward, Arkansas case is a strong boundary probe: it can reveal lexical over-match of `ward` without pretending that a city is a sub-city geography.

The artifact was frozen before candidate-stage execution, so the omissions below can still be corrected without post-result tuning. Preserve v1 unchanged and issue a separately hashed v2.

## 2. Blocker 1 — question family is absent

The contract's coverage unit includes question family, and actual-stage records must include source and family. None of the 63 cases carries a `question_family` or equivalent frozen value.

Add a closed, predeclared family vocabulary and one family value per case before implementation. The value must describe the independently adjudicated semantic family, not a label derived later from observer output. Validate that every family used by the 21-pair coverage map is declared and that no undeclared family can enter a result.

## 3. Blocker 2 — the expected typed reason is absent

Every positive case expects `decline_capability`, but no case declares the required typed reason code. The contract requires the stage to record decision and reason, and requires every decline case to carry its required reason class. Leaving the reason open until implementation would let the candidate choose whichever admissible catalog row is convenient.

For the nine rules' current production path, a block produced through `validateQueryContractSql` is finalized as:

`decline_capability / query_contract_failed`

Freeze the expected action/reason pair explicitly for each positive case. For negative controls, freeze that this rule produces **no action/reason pair**; represent that with an explicit nullable outcome object or an equally unambiguous closed form, not a new pseudo-reason outside `REASON_CODES`.

If P3.1a intends a different reason from `query_contract_failed`, that is a semantic design change and must be surfaced before implementation rather than encoded after the cases run.

## 4. Blocker 3 — contract-dependent expectations are prose-only

Five of the nine definitions depend on fields in the question-derived `QueryContract`. Their cases contain prose adjudication but no machine-readable expected contract subset. Running `buildQueryContract` later and treating its output as the expectation would make the parser its own oracle.

For every case belonging to a contract-dependent definition, add the minimal independently expected contract projection used by that rule, for example as applicable:

- metric topic;
- metric unit;
- unsupported reason;
- geography kind;
- required breakdowns or their absence;
- any other exact contract field read by the production predicate.

The candidate run must report expected-versus-observed contract parsing separately from expected-versus-observed rule applicability. A parser disagreement is not a predicate failure, and neither may be silently substituted for the other.

Pure-question rules should carry an explicit `expected_contract: null` or equivalent so omission cannot be mistaken for an unfinished case.

## 5. Blocker 4 — the Ward factual premise needs a pin

P31A-002 and its source-specific repetitions rely on the factual premise that Ward, Arkansas is an incorporated city. The adjudication states that premise but does not cite or pin independent evidence for it.

Add one authoritative, pinned identity reference for Ward's incorporated-place status and bind every reused Ward case to that same evidence ID. The durable case file need not reproduce a large source artifact; it must identify the authority, retrieval/version date, stable place identity, and evidence artifact hash or other reproducible pin.

This requirement is narrow. Other negative controls need not prove that their requested answer is available in that source; their frozen claim is only that **this particular rule** must not decline them. Any other rule or data limitation remains separately accountable.

## 6. Required v2 gates

Before freezing v2, add structural checks proving:

1. 21 pairs × 3 roles, with unique IDs and exact source applicability;
2. every case has a declared question family;
3. every positive carries an admissible expected action/reason pair;
4. every negative carries an explicit no-outcome expectation for this rule;
5. every contract-dependent case has the complete minimal expected contract projection;
6. every pure-question case explicitly declares no contract projection required;
7. every Ward reuse binds to the same independently pinned place evidence;
8. observed fields remain null/unset;
9. v1 remains byte-identical at its recorded hash;
10. v2 is frozen and hashed before candidate implementation resumes.

## 7. Disposition

Do not implement or execute the CANDIDATE yet. Preserve v1, author and independently adjudicate v2 with only the additions above, run structural checks that do not execute production predicates, freeze/hash v2, and report the new identity.

This is the contract's inadequate-case path, not a scope expansion or owner stop. No new owner decision is required. P3.2 remains unauthorized.
